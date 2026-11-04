// background.js — Service Worker
'use strict';

const NOTIFY_ID   = 'ozon_pvz_notify';
const BADGE_ALARM = 'badge_tick';
const PAUSE_ALARM = 'pause_end';

// ─── Дефолтные настройки ──────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = [
  { minutes: 30, text: 'Внимание! До конца приёмки осталось 30 минут.',      volume: 0.7, enabled: true },
  { minutes: 15, text: 'Внимание! До конца приёмки осталось 15 минут!',      volume: 1.0, enabled: true },
  { minutes: 5,  text: 'Срочно! До конца приёмки осталось всего 5 минут!!!', volume: 1.0, enabled: true },
];

const DEFAULT_SETTINGS = {
  thresholds:    JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
  speechEnabled: true,
  notifEnabled:  true,
  notifType:     'both',
  theme:         'dark',
  telegram: { enabled: false, botToken: '', chatId: '' },
  ntfy:     { enabled: false, topic: '', server: 'https://ntfy.sh', token: '', priority: 'default' },
  proxy:    { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '' },
};

let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

// ─── Лог ──────────────────────────────────────────────────────────────────

const eventLog = [];
function bgLog(text, type = 'info') {
  const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  eventLog.push({ text: `[${t}] ${text}`, type });
  if (eventLog.length > 120) eventLog.shift();
  console.log(`[PVZ][${type}] ${text}`);
}

// ─── Состояние таймера ────────────────────────────────────────────────────

let timerState = {
  seconds:       null,
  updatedAt:     null,
  url:           '',
  title:         '',
  firedFor:      [],
  isManual:      false,
  startNotified: false,
};

// ─── Режим работы ─────────────────────────────────────────────────────────

let modeState = { mode: 'active', pauseUntil: null };

function getMode() {
  if (modeState.mode === 'paused' && modeState.pauseUntil && Date.now() >= modeState.pauseUntil) {
    setMode('active');
  }
  return modeState.mode;
}

function setMode(mode, pauseMinutes = 0) {
  modeState.mode       = mode;
  modeState.pauseUntil = null;
  chrome.alarms.clear(PAUSE_ALARM);

  if (mode === 'paused' && pauseMinutes > 0) {
    modeState.pauseUntil = Date.now() + pauseMinutes * 60 * 1000;
    chrome.alarms.create(PAUSE_ALARM, { delayInMinutes: pauseMinutes });
    bgLog(`Пауза на ${pauseMinutes} мин (до ${new Date(modeState.pauseUntil).toLocaleTimeString('ru-RU')})`, 'warn');
  } else if (mode === 'disabled') {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#555' });
    chrome.alarms.getAll().then(alarms =>
      alarms.filter(a => a.name.startsWith('threshold_')).forEach(a => chrome.alarms.clear(a.name))
    );
    bgLog('Плагин отключён', 'warn');
  } else if (mode === 'active') {
    bgLog('Мониторинг активен', 'ok');
    if (timerState.seconds != null && timerState.updatedAt != null) {
      const elapsed = (Date.now() - timerState.updatedAt) / 1000;
      const current = Math.max(Math.round(timerState.seconds - elapsed), 0);
      updateBadge(current);
      timerState.firedFor = [];
      scheduleThresholdAlarms(current);
    }
  }
  chrome.storage.local.set({ modeState });
}

// ─── Форматирование ───────────────────────────────────────────────────────

function fmt(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин ${sec} сек`;
  return `${sec} сек`;
}

function fmtBadge(s) {
  if (s == null || s < 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}ч${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(sec).padStart(2, '0')}`;
  return `${sec}с`;
}

// ─── Бейдж ────────────────────────────────────────────────────────────────

function updateBadge(seconds) {
  if (seconds == null || seconds <= 0) { chrome.action.setBadgeText({ text: '' }); return; }
  let color = '#388e3c';
  if (seconds <= 5 * 60)       color = '#d32f2f';
  else if (seconds <= 30 * 60) color = '#f57c00';
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text: fmtBadge(seconds) });
}

// ─── Прокси ───────────────────────────────────────────────────────────────

async function applyProxy() {
  const px = settings.proxy;
  if (!px?.enabled || !px.host || !px.port) {
    try { await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); } catch (_) {}
    return;
  }
  const scheme = px.type === 'http' ? 'http' : 'socks5';
  try {
    await chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: { proxyForHttps: { scheme, host: px.host, port: parseInt(px.port) }, bypassList: ['<local>'] },
      },
      scope: 'regular',
    });
    bgLog(`Прокси: ${scheme}://${px.host}:${px.port}`, 'ok');
  } catch (e) { bgLog(`Прокси error: ${e.message}`, 'err'); }
}

async function clearProxy() {
  try { await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); } catch (_) {}
}

// ─── Telegram ─────────────────────────────────────────────────────────────

async function sendTelegram(text, isTest = false) {
  const tg = settings.telegram;
  if (!tg.enabled && !isTest) return { ok: false, reason: 'disabled' };
  if (!tg.botToken || !tg.chatId) return { ok: false, reason: 'no_credentials' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text: `📦 *Ozon Turbo-PVZ*\n${text}`, parse_mode: 'Markdown' }),
    });
    const data = await resp.json();
    if (data.ok) { bgLog(`Telegram: отправлено${isTest ? ' (тест)' : ''}`, isTest ? 'info' : 'warn'); return { ok: true }; }
    bgLog(`Telegram ошибка: ${data.description}`, 'err');
    return { ok: false, reason: data.description };
  } catch (e) { bgLog(`Telegram error: ${e.message}`, 'err'); return { ok: false, reason: e.message }; }
}

// ─── ntfy.sh ──────────────────────────────────────────────────────────────

async function sendNtfy(text, title = 'Ozon Turbo-PVZ', isTest = false) {
  const n = settings.ntfy;
  if (!n?.enabled && !isTest) return { ok: false, reason: 'disabled' };
  if (!n?.topic) return { ok: false, reason: 'no_topic' };

  const PRIO = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
  const server  = (n.server || 'https://ntfy.sh').replace(/\/$/, '');

  // Используем JSON API ntfy — поддерживает UTF-8 в title без кодирования
  const headers = { 'Content-Type': 'application/json' };
  if (n.token) headers['Authorization'] = `Bearer ${n.token}`;

  const body = JSON.stringify({
    topic:    n.topic,
    message:  text,
    title:    title,
    priority: PRIO[n.priority] ?? 3,
    tags:     [isTest ? 'test_tube' : 'package'],
  });

  try {
    const resp = await fetch(`${server}`, { method: 'POST', headers, body });
    if (resp.ok) { bgLog(`ntfy: отправлено${isTest ? ' (тест)' : ''}`, isTest ? 'info' : 'warn'); return { ok: true }; }
    const err = await resp.text().catch(() => String(resp.status));
    bgLog(`ntfy ошибка ${resp.status}: ${err}`, 'err');
    return { ok: false, reason: `HTTP ${resp.status}: ${err}` };
  } catch (e) { bgLog(`ntfy error: ${e.message}`, 'err'); return { ok: false, reason: e.message }; }
}

// ─── Алармы ───────────────────────────────────────────────────────────────

chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 10 / 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PAUSE_ALARM) { bgLog('Пауза завершена', 'ok'); setMode('active'); return; }
  if (alarm.name === BADGE_ALARM) {
    if (getMode() === 'disabled') return;
    if (timerState.seconds != null && timerState.updatedAt != null) {
      const elapsed = (Date.now() - timerState.updatedAt) / 1000;
      const current = Math.max(Math.round(timerState.seconds - elapsed), 0);
      updateBadge(current);
      if (getMode() === 'active') checkThresholds(current);
    } else {
      if (getMode() !== 'disabled') updateBadge(null);
    }
    return;
  }
  if (alarm.name.startsWith('threshold_')) {
    const mins = parseInt(alarm.name.split('_')[1]);
    bgLog(`Аларм порога ${mins} мин`, 'warn');
    if (timerState.seconds != null && timerState.updatedAt != null) {
      const elapsed = (Date.now() - timerState.updatedAt) / 1000;
      const current = Math.max(Math.round(timerState.seconds - elapsed), 0);
      fireThreshold(mins, current);
    }
  }
});

// ─── Пороги ───────────────────────────────────────────────────────────────

async function scheduleThresholdAlarms(remainingSeconds) {
  const all = await chrome.alarms.getAll();
  for (const a of all) if (a.name.startsWith('threshold_')) await chrome.alarms.clear(a.name);
  const enabled = settings.thresholds.filter(t => t.enabled);
  for (let idx = 0; idx < enabled.length; idx++) {
    const t = enabled[idx];
    const fireInSec = remainingSeconds - t.minutes * 60;
    if (fireInSec > 0) {
      await chrome.alarms.create(`threshold_${t.minutes}_${idx}`, { delayInMinutes: fireInSec / 60 });
      bgLog(`Аларм ${t.minutes} мин: через ${Math.round(fireInSec / 60)} мин`, 'ok');
    } else if (remainingSeconds > 0 && remainingSeconds <= t.minutes * 60) {
      if (!timerState.firedFor.includes(t.minutes)) fireThreshold(t.minutes, remainingSeconds);
    }
  }
}

function checkThresholds(currentSeconds) {
  for (const t of settings.thresholds.filter(t => t.enabled)) {
    if (currentSeconds <= t.minutes * 60 && currentSeconds > 0 && !timerState.firedFor.includes(t.minutes)) {
      fireThreshold(t.minutes, currentSeconds);
    }
  }
}

function fireThreshold(minutes, currentSeconds) {
  if (getMode() !== 'active') { bgLog(`Порог ${minutes} мин пропущен (${modeState.mode})`, 'info'); return; }
  const threshold = settings.thresholds.find(t => t.minutes === minutes);
  if (!threshold?.enabled) return;
  if (timerState.firedFor.includes(minutes)) return;

  timerState.firedFor.push(minutes);
  chrome.storage.local.set({ timerState });
  bgLog(`🔔 Порог ${minutes} мин! Осталось: ${fmt(currentSeconds)} | push=${settings.notifEnabled} voice=${settings.speechEnabled}`, 'warn');

  const text = threshold.text || `До конца приёмки осталось ${minutes} минут!`;
  if (settings.notifEnabled) {
    chrome.notifications.create(`${NOTIFY_ID}_${minutes}`, {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: '⏰ Ozon Turbo-PVZ', message: text,
      priority: 2, requireInteraction: minutes <= 5,
      buttons: [{ title: 'Перейти на страницу' }],
    });
  }
  if (settings.speechEnabled)     speakInTab(text, false, threshold.volume ?? 1.0);
  if (settings.telegram?.enabled) sendTelegram(text);
  if (settings.ntfy?.enabled)     sendNtfy(text, `⏰ Порог ${minutes} мин`);
}

// ─── Голос ────────────────────────────────────────────────────────────────

async function speakInTab(text, isTest = false, volume = 1.0) {
  if (!settings.speechEnabled && !isTest) return false;
  const tabs = await chrome.tabs.query({ url: ['*://*.ozon.ru/*', '*://turbo-pvz.ozon.ru/*'] });
  if (!tabs.length) { bgLog('Нет табов Ozon для голоса', 'warn'); return false; }
  const tab = tabs[0];
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'SPEAK', text, volume });
    bgLog(`Голос vol=${volume}`, isTest ? 'info' : 'warn');
    return true;
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (t, v) => {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(t);
        u.lang = 'ru-RU'; u.rate = 0.95; u.pitch = 1.0;
        u.volume = Math.min(Math.max(v, 0), 1);
        const rv = window.speechSynthesis.getVoices().find(x => x.lang.startsWith('ru'));
        if (rv) u.voice = rv;
        window.speechSynthesis.speak(u);
      },
      args: [text, volume],
    });
    bgLog(`Голос (inject) vol=${volume}`, isTest ? 'info' : 'warn');
    return true;
  } catch (e) { bgLog(`Ошибка голоса: ${e.message}`, 'err'); return false; }
}

// ─── Уведомление о старте приёмки ────────────────────────────────────────

function notifyTimerStarted(seconds, isManual = false) {
  if (getMode() !== 'active') return;
  const timeStr = fmt(seconds);
  const source  = isManual ? 'Ручной запуск' : 'Авто-обнаружение';
  const message = `Отсчёт запущен: ${timeStr} до конца приёмки.`;
  bgLog(`🟢 Старт приёмки (${source}): ${timeStr}`, 'ok');
  if (settings.notifEnabled) {
    chrome.notifications.create('ozon_pvz_start', {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: '✅ Ozon Turbo-PVZ — Приёмка начата',
      message: `${message} ${source}.`, priority: 1,
    });
  }
  if (settings.speechEnabled)     speakInTab(`Приёмка обнаружена. До конца ${timeStr}.`, false, 0.6);
  if (settings.telegram?.enabled) sendTelegram(`✅ Приёмка начата\n${message}\n_(${source})_`);
  if (settings.ntfy?.enabled)     sendNtfy(`✅ Приёмка начата. ${message}`, 'Ozon Turbo-PVZ — Старт');
}

// ─── Тест push ────────────────────────────────────────────────────────────

function sendTestNotification(thresholdMinutes) {
  const t = settings.thresholds.find(th => th.minutes === thresholdMinutes)
    || { text: `Тест порога ${thresholdMinutes} мин`, minutes: thresholdMinutes };
  chrome.notifications.create(NOTIFY_ID, {
    type: 'basic', iconUrl: 'icons/icon128.png',
    title: `🧪 Тест — порог ${t.minutes} мин`, message: t.text, priority: 2,
  });
  bgLog(`[DEBUG] Тест push порога ${t.minutes} мин`, 'info');
}

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (!notifId.startsWith(NOTIFY_ID)) return;
  if (btnIdx === 0 && timerState.url) chrome.tabs.create({ url: timerState.url });
  chrome.notifications.clear(notifId);
});

// ─── Сообщения ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'TIMER_FOUND') {
    if (getMode() === 'disabled') { sendResponse({ ok: true }); return true; }
    const prev         = timerState.seconds;
    const isReallyNew  = prev === null;
    const isNewSession = prev !== null && (msg.seconds - prev) > 60;
    const isNew        = isReallyNew || isNewSession;
    const firedFor     = isNew ? [] : timerState.firedFor;
    const startNotified = isNewSession ? false : timerState.startNotified;

    timerState = { seconds: msg.seconds, updatedAt: Date.now(), url: msg.url, title: msg.title, firedFor, isManual: false, startNotified };
    chrome.storage.local.set({ timerState });
    updateBadge(msg.seconds);

    if (isNew) {
      bgLog(`Таймер ${isNewSession ? 'перезапущен' : 'обнаружен'}: ${fmt(msg.seconds)}${msg.debugInfo ? ` | ${msg.debugInfo}` : ''}`, 'ok');
      scheduleThresholdAlarms(msg.seconds);
    }
    if (!timerState.startNotified) {
      timerState.startNotified = true;
      chrome.storage.local.set({ timerState });
      notifyTimerStarted(msg.seconds);
    }
    checkThresholds(msg.seconds);
    sendResponse({ ok: true });
  }

  else if (msg.type === 'TIMER_MANUAL') {
    bgLog(`Ручной таймер: ${fmt(msg.seconds)}`, 'ok');
    timerState = { seconds: msg.seconds, updatedAt: Date.now(), url: timerState.url, title: 'Ручной', firedFor: [], isManual: true, startNotified: false };
    chrome.storage.local.set({ timerState });
    updateBadge(msg.seconds);
    scheduleThresholdAlarms(msg.seconds);
    notifyTimerStarted(msg.seconds, true);
    sendResponse({ ok: true });
  }

  else if (msg.type === 'TIMER_LOST') {
    timerState.seconds  = null;
    timerState.firedFor = [];
    chrome.storage.local.set({ timerState });
    updateBadge(null);
    chrome.alarms.getAll().then(alarms =>
      alarms.filter(a => a.name.startsWith('threshold_')).forEach(a => chrome.alarms.clear(a.name))
    );
    bgLog('Таймер сброшен', 'info');
    sendResponse({ ok: true });
  }

  else if (msg.type === 'GET_STATE') { sendResponse({ timerState, settings, modeState }); }
  else if (msg.type === 'GET_LOG')   { sendResponse({ log: [...eventLog] }); }

  else if (msg.type === 'SET_MODE') {
    setMode(msg.mode, msg.pauseMinutes || 0);
    sendResponse({ ok: true, modeState });
  }

  else if (msg.type === 'SETTINGS_UPDATED') {
    settings = {
      ...settings,
      ...msg.settings,
      telegram: { ...settings.telegram, ...(msg.settings.telegram || {}) },
      ntfy:     { ...settings.ntfy,     ...(msg.settings.ntfy     || {}) },
      proxy:    { ...settings.proxy,    ...(msg.settings.proxy     || {}) },
    };
    if (msg.settings.notifType) {
      settings.speechEnabled = msg.settings.notifType !== 'push';
      settings.notifEnabled  = msg.settings.notifType !== 'voice';
    }
    if (msg.settings.proxy !== undefined) applyProxy();
    bgLog('Настройки обновлены', 'info');
    if (timerState.seconds != null) {
      const elapsed = (Date.now() - timerState.updatedAt) / 1000;
      const current = Math.max(Math.round(timerState.seconds - elapsed), 0);
      timerState.firedFor = [];
      scheduleThresholdAlarms(current);
    }
    sendResponse({ ok: true });
  }

  else if (msg.type === 'DEBUG_TEST_NOTIF') {
    sendTestNotification(msg.minutes ?? settings.thresholds[1]?.minutes ?? 15);
    sendResponse({ ok: true });
  }

  else if (msg.type === 'DEBUG_TEST_SPEECH') {
    const mins = msg.minutes ?? settings.thresholds[1]?.minutes ?? 15;
    const t    = settings.thresholds.find(th => th.minutes === mins);
    speakInTab(t?.text ?? `Тест. Осталось ${mins} минут.`, true, t?.volume ?? 1.0)
      .then(ok => sendResponse({ ok }));
    return true;
  }

  else if (msg.type === 'DEBUG_TEST_TELEGRAM') {
    const savedTg = settings.telegram;
    if (msg.botToken && msg.chatId) settings.telegram = { enabled: true, botToken: msg.botToken, chatId: msg.chatId };
    sendTelegram(msg.text || '🧪 Тест-сообщение от Ozon Turbo-PVZ.', true)
      .then(result => {
        if (msg.botToken && msg.chatId) settings.telegram = { ...savedTg, botToken: msg.botToken, chatId: msg.chatId };
        sendResponse(result);
      });
    return true;
  }

  else if (msg.type === 'DEBUG_TEST_NTFY') {
    const saved = settings.ntfy;
    if (msg.ntfy) settings.ntfy = { ...settings.ntfy, ...msg.ntfy, enabled: true };
    sendNtfy(msg.text || '🧪 Тест ntfy от Ozon Turbo-PVZ. Всё работает!', 'Ozon Turbo-PVZ — Тест', true)
      .then(result => { settings.ntfy = saved; sendResponse(result); });
    return true;
  }

  else if (msg.type === 'DEBUG_TEST_PROXY') {
    const savedProxy = settings.proxy;
    settings.proxy = { ...msg.proxy, enabled: true };
    (async () => {
      await applyProxy();
      try {
        const resp = await fetch(`https://api.telegram.org/bot${msg.botToken}/getMe`);
        const data = await resp.json();
        if (data.ok) {
          bgLog(`Прокси тест OK: @${data.result.username}`, 'ok');
          sendResponse({ ok: true, botName: data.result.username });
        } else {
          sendResponse({ ok: false, reason: data.description });
        }
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      } finally {
        settings.proxy = savedProxy;
        await applyProxy();
      }
    })();
    return true;
  }

  else if (msg.type === 'DEBUG_SIM_TIMER') {
    const maxMins = Math.max(...settings.thresholds.filter(t => t.enabled).map(t => t.minutes), 30);
    const sec     = msg.seconds || maxMins * 60 + 70;
    timerState = { seconds: sec, updatedAt: Date.now(), url: timerState.url || 'https://turbo-pvz.ozon.ru', title: 'Debug', firedFor: [], isManual: false, startNotified: false };
    chrome.storage.local.set({ timerState });
    updateBadge(sec);
    scheduleThresholdAlarms(sec);
    notifyTimerStarted(sec, false);
    bgLog(`[DEBUG] Симуляция: ${fmt(sec)}`, 'info');
    sendResponse({ ok: true });
  }

  else if (msg.type === 'DEBUG_CLEAR_ALARMS') {
    chrome.alarms.getAll().then(async alarms => {
      for (const a of alarms) if (a.name !== BADGE_ALARM) await chrome.alarms.clear(a.name);
      bgLog('[DEBUG] Алармы очищены', 'warn');
      sendResponse({ ok: true });
    });
    return true;
  }

  else if (msg.type === 'DEBUG_RESET') {
    chrome.alarms.getAll().then(async alarms => {
      for (const a of alarms) if (a.name !== BADGE_ALARM) await chrome.alarms.clear(a.name);
    });
    timerState = { seconds: null, updatedAt: null, url: '', title: '', firedFor: [], isManual: false, startNotified: false };
    settings   = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    modeState  = { mode: 'active', pauseUntil: null };
    chrome.storage.local.set({ modeState });
    clearProxy();
    updateBadge(null);
    bgLog('[DEBUG] Полный сброс', 'warn');
    sendResponse({ ok: true });
  }

  return true;
});

// ─── Старт ────────────────────────────────────────────────────────────────

chrome.storage.local.get(['timerState', 'pvzSettings', 'modeState'], (data) => {
  if (data.pvzSettings) {
    settings = {
      ...DEFAULT_SETTINGS,
      ...data.pvzSettings,
      telegram: { ...DEFAULT_SETTINGS.telegram, ...(data.pvzSettings.telegram || {}) },
      ntfy:     { ...DEFAULT_SETTINGS.ntfy,     ...(data.pvzSettings.ntfy     || {}) },
      proxy:    { ...DEFAULT_SETTINGS.proxy,     ...(data.pvzSettings.proxy    || {}) },
    };
    if (settings.notifType) {
      settings.speechEnabled = settings.notifType !== 'push';
      settings.notifEnabled  = settings.notifType !== 'voice';
    }
  }
  if (data.timerState) timerState = data.timerState;
  if (data.modeState)  modeState  = data.modeState;

  applyProxy();
  bgLog(`SW запущен | push=${settings.notifEnabled} voice=${settings.speechEnabled} type=${settings.notifType || '?'} mode=${modeState.mode}`, 'ok');

  if (getMode() === 'disabled') {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#555' });
  } else if (timerState.seconds != null) {
    const elapsed = (Date.now() - (timerState.updatedAt || Date.now())) / 1000;
    updateBadge(Math.max(timerState.seconds - elapsed, 0));
  }
});
