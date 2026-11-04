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

// Сессия приёмки определяется абсолютным временем окончания endsAt (мс).
// seconds/updatedAt оставлены для popup: seconds — остаток на момент updatedAt.
let timerState = {
  seconds:       null,
  updatedAt:     null,
  endsAt:        null,
  lostAt:        null,  // когда таймер пропал со страницы (null — виден)
  url:           '',
  title:         '',
  firedFor:      [],
  isManual:      false,
  startNotified: false,
};

const LOST_GRACE_ALARM     = 'timer_lost_grace';
const LOST_GRACE_MIN       = 2;          // сколько минут таймер может не быть виден, прежде чем приёмка считается оконченной
const SESSION_TOLERANCE_MS = 90 * 1000;  // расхождение endsAt в пределах одной приёмки

function sessionEndsAt() {
  if (timerState.endsAt != null) return timerState.endsAt;
  // состояние, сохранённое до появления endsAt
  if (timerState.seconds != null && timerState.updatedAt != null) return timerState.updatedAt + timerState.seconds * 1000;
  return null;
}

// Остаток текущей приёмки в секундах или null, если приёмки нет
function remainingSeconds() {
  if (timerState.seconds == null) return null;
  const endsAt = sessionEndsAt();
  if (endsAt == null) return null;
  return Math.max(Math.round((endsAt - Date.now()) / 1000), 0);
}

function clearThresholdAlarms() {
  return chrome.alarms.getAll().then(alarms =>
    Promise.all(alarms.filter(a => a.name.startsWith('threshold_')).map(a => chrome.alarms.clear(a.name)))
  );
}

function endSession(reason) {
  timerState = { ...timerState, seconds: null, updatedAt: null, endsAt: null, lostAt: null, firedFor: [], startNotified: false };
  chrome.storage.local.set({ timerState });
  chrome.alarms.clear(LOST_GRACE_ALARM);
  clearThresholdAlarms();
  if (getMode() !== 'disabled') updateBadge(null);
  bgLog(`Приёмка завершена: ${reason}`, 'info');
}

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
    clearThresholdAlarms();
    bgLog('Плагин отключён', 'warn');
  } else if (mode === 'active') {
    bgLog('Мониторинг активен', 'ok');
    const current = remainingSeconds();
    if (current != null) {
      updateBadge(current);
      // firedFor не сбрасываем: уже отправленные пороги не повторяются
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

// Через прокси идут только эти хосты (PAC-скрипт), всё остальное — DIRECT.
// Ограничение Chrome: пока прокси расширения включён, системный прокси / VPN-расширение для остальных сайтов
// не действуют (настройка прокси в браузере одна, PAC не умеет «вернуть системный»).
const PROXY_HOSTS = ['api.telegram.org'];

// Проверка полей до того, как они попадут в текст PAC-скрипта
function validateProxy(px) {
  const host = String(px?.host || '').trim();
  const port = Number(px?.port);
  if (!host || !px?.port) return { ok: false, reason: 'укажите хост и порт' };
  if (!/^[A-Za-z0-9.-]+$/.test(host) && !/^\[[0-9A-Fa-f:.]+\]$/.test(host)) return { ok: false, reason: `некорректный хост «${host}»` };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: `некорректный порт «${px.port}»` };
  if (px.type !== 'http' && px.username) {
    return { ok: false, reason: 'Chrome не поддерживает SOCKS5 с логином/паролем — выберите HTTP-прокси или очистите логин' };
  }
  return { ok: true, host, port };
}

function buildPacScript(px, host, port) {
  const target = `${px.type === 'http' ? 'PROXY' : 'SOCKS5'} ${host}:${port}`;
  return `function FindProxyForURL(url, host) {
  var hosts = ${JSON.stringify(PROXY_HOSTS)};
  for (var i = 0; i < hosts.length; i++) { if (host === hosts[i]) return ${JSON.stringify(target)}; }
  return "DIRECT";
}`;
}

// На время «Тест прокси» — проверяемые поля из popup; рабочие settings.proxy не меняются,
// поэтому «Сохранить» во время теста не откатывается его окончанием.
let proxyTestOverride = null;
const activeProxy = () => proxyTestOverride || settings.proxy;

// Возвращает { ok, reason? }
async function applyProxy() {
  const px = activeProxy();
  if (!px?.enabled) { await clearProxy(); return { ok: true }; }
  const v = validateProxy(px);
  if (!v.ok) { bgLog(`Прокси не применён: ${v.reason}`, 'err'); await clearProxy(); return v; }
  try {
    const cur = await chrome.proxy.settings.get({ incognito: false });
    if (cur.levelOfControl === 'controlled_by_other_extensions') {
      const reason = 'прокси браузера уже занят другим расширением (VPN и т. п.) — отключите его или наш прокси';
      bgLog(`Прокси не применён: ${reason}`, 'err');
      return { ok: false, reason };
    }
    if (cur.levelOfControl === 'not_controllable') {
      const reason = 'прокси браузера управляется политикой — расширение не может его менять';
      bgLog(`Прокси не применён: ${reason}`, 'err');
      return { ok: false, reason };
    }
    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: buildPacScript(px, v.host, v.port) } },
      scope: 'regular',
    });
    bgLog(`Прокси для ${PROXY_HOSTS.join(', ')}: ${px.type === 'http' ? 'http' : 'socks5'}://${v.host}:${v.port}${px.username ? ' (с логином)' : ''}`, 'ok');
    return { ok: true };
  } catch (e) {
    bgLog(`Прокси error: ${e.message}`, 'err');
    return { ok: false, reason: e.message };
  }
}

// Логин/пароль HTTP-прокси. Слушатель регистрируется синхронно при старте SW, чтобы ловить запросы после пробуждения.
const proxyAuthTried = new Set(); // requestId, на которые уже отдали логин — второй запрос = неверный логин/пароль
function handleProxyAuth(details, callback) {
  if (!details.isProxy) { callback({}); return; }
  ready.then(() => {
    const px = activeProxy();
    const ch = details.challenger || {};
    const ours = px?.enabled && px.type === 'http' && px.username &&
      String(ch.host || '').toLowerCase() === String(px.host || '').trim().toLowerCase() && Number(ch.port) === Number(px.port);
    if (!ours) { callback({}); return; }
    if (proxyAuthTried.has(details.requestId)) {
      bgLog('Прокси отклонил логин/пароль', 'err');
      callback({ cancel: true });
      return;
    }
    if (proxyAuthTried.size > 100) proxyAuthTried.clear();
    proxyAuthTried.add(details.requestId);
    callback({ authCredentials: { username: px.username, password: px.password || '' } });
  });
}
if (chrome.webRequest?.onAuthRequired) {
  chrome.webRequest.onAuthRequired.addListener(handleProxyAuth, { urls: PROXY_HOSTS.map(h => `*://${h}/*`) }, ['asyncBlocking']);
}

// Снимаем только СВОЮ настройку прокси. Раньше здесь ставился mode: 'direct', и это перетирало
// системный прокси / VPN-расширения пользователя; clear() возвращает их, если 'direct' остался от старой версии.
async function clearProxy() {
  try {
    const cur = await chrome.proxy.settings.get({ incognito: false });
    if (cur.levelOfControl !== 'controlled_by_this_extension') return;
    await chrome.proxy.settings.clear({ scope: 'regular' });
    bgLog('Прокси расширения снят', 'info');
  } catch (e) { bgLog(`Прокси clear error: ${e.message}`, 'err'); }
}

// ─── Telegram ─────────────────────────────────────────────────────────────

// tgCfg — данные для теста из popup; рабочие settings при этом не меняются.
// Без parse_mode: текст порога редактирует пользователь, и `_ * [ \`` в Markdown дали бы 400 и потерю уведомления.
async function sendTelegram(text, isTest = false, tgCfg = null) {
  const tg = tgCfg || settings.telegram;
  if (!tg?.enabled && !isTest) return { ok: false, reason: 'disabled' };
  if (!tg?.botToken || !tg?.chatId) return { ok: false, reason: 'no_credentials' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text: `📦 Ozon Turbo-PVZ\n${text}` }),
    });
    const data = await resp.json();
    if (data.ok) { bgLog(`Telegram: отправлено${isTest ? ' (тест)' : ''}`, isTest ? 'info' : 'warn'); return { ok: true }; }
    bgLog(`Telegram ошибка: ${data.description}`, 'err');
    return { ok: false, reason: data.description };
  } catch (e) { bgLog(`Telegram error: ${e.message}`, 'err'); return { ok: false, reason: e.message }; }
}

// ─── ntfy.sh ──────────────────────────────────────────────────────────────

// Адрес сервера ntfy: только https (иначе токен уйдёт открытым текстом). Возвращает { ok, url?, reason? }
function checkNtfyServer(raw) {
  const s = String(raw || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(s); } catch (_) { return { ok: false, reason: `некорректный адрес сервера «${s}» — нужен вид https://ntfy.example.com` }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'сервер ntfy должен быть https:// — по http токен и текст уйдут открытым текстом' };
  return { ok: true, url: s };
}

// nCfg — данные для теста из popup; рабочие settings при этом не меняются
async function sendNtfy(text, title = 'Ozon Turbo-PVZ', isTest = false, nCfg = null) {
  const n = nCfg || settings.ntfy;
  if (!n?.enabled && !isTest) return { ok: false, reason: 'disabled' };
  if (!n?.topic) return { ok: false, reason: 'no_topic' };

  const PRIO = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
  const srv  = checkNtfyServer(n.server);
  if (!srv.ok) { bgLog(`ntfy: ${srv.reason}`, 'err'); return { ok: false, reason: srv.reason }; }
  const server = srv.url;

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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === PAUSE_ALARM) { bgLog('Пауза завершена', 'ok'); setMode('active'); return; }
  if (alarm.name === LOST_GRACE_ALARM) {
    if (timerState.lostAt != null) endSession(`таймер не виден на странице ${LOST_GRACE_MIN} мин`);
    return;
  }
  if (alarm.name === BADGE_ALARM) {
    if (getMode() === 'disabled') return;
    const current = remainingSeconds();
    if (current != null) {
      updateBadge(current);
      checkThresholds(current); // в паузе fireThreshold только помечает порог отработанным
    } else {
      if (getMode() !== 'disabled') updateBadge(null);
    }
    return;
  }
  if (alarm.name.startsWith('threshold_')) {
    const mins = parseInt(alarm.name.split('_')[1]);
    bgLog(`Аларм порога ${mins} мин`, 'warn');
    const current = remainingSeconds();
    if (current != null) fireThreshold(mins, current);
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
  const threshold = settings.thresholds.find(t => t.minutes === minutes);
  if (!threshold?.enabled) return;
  if (timerState.firedFor.includes(minutes)) return;
  if (getMode() !== 'active') {
    // Пропущенный в паузе порог помечаем отработанным — после снятия паузы устаревшее оповещение не придёт
    timerState.firedFor.push(minutes);
    chrome.storage.local.set({ timerState });
    bgLog(`Порог ${minutes} мин пропущен (${modeState.mode})`, 'info');
    return;
  }

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
  const tabs = await chrome.tabs.query({ url: ['*://turbo-pvz.ozon.ru/*'] }); // работает по host_permissions, без права «tabs»
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
  if (settings.telegram?.enabled) sendTelegram(`✅ Приёмка начата\n${message}\n(${source})`);
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

// Открываем только страницы Turbo-PVZ (url приходит из content-скрипта и лежит в storage)
const OZON_PAGE_RE = /^https:\/\/turbo-pvz\.ozon\.ru\//;
function openTimerPage() {
  chrome.tabs.create({ url: OZON_PAGE_RE.test(timerState.url || '') ? timerState.url : 'https://turbo-pvz.ozon.ru/' });
}

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (!notifId.startsWith(NOTIFY_ID)) return;
  await ready; // нужен timerState.url из storage
  if (btnIdx === 0) openTimerPage();
  chrome.notifications.clear(notifId);
});

// Клик по самому уведомлению (не по кнопке) — тоже открыть страницу приёмки
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith(NOTIFY_ID) && notifId !== 'ozon_pvz_start') return;
  await ready;
  openTimerPage();
  chrome.notifications.clear(notifId);
});

// ─── Сообщения ────────────────────────────────────────────────────────────

// Сначала дожидаемся загрузки состояния, потом обрабатываем. Ответ из-за этого всегда асинхронный,
// поэтому слушатель всегда возвращает true (канал открыт до sendResponse).
// Кто что может слать: content-скрипты (вкладка Ozon) — только данные таймера; всё остальное — только
// страницы самого расширения (popup). Страница Ozon до runtime не дотянется (нет externally_connectable),
// это защита на случай ошибки в content-скрипте.
const CONTENT_MSG_TYPES = new Set(['TIMER_FOUND', 'TIMER_LOST']);
function isAllowedSender(msg, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  // Страница расширения (popup — и всплывающим окном, и открытая во вкладке) — по адресу, а не по sender.tab
  if (String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return true;
  return Boolean(sender.tab) && CONTENT_MSG_TYPES.has(msg?.type) && OZON_PAGE_RE.test(sender.url || '');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isAllowedSender(msg, sender)) {
    bgLog(`Отклонено сообщение ${String(msg?.type).slice(0, 40)} от ${sender.tab ? 'вкладки' : 'неизвестного отправителя'}`, 'err');
    sendResponse({ ok: false, reason: 'forbidden' });
    return false;
  }
  ready.then(() => handleMessage(msg, sender, sendResponse));
  return true;
});

function handleMessage(msg, _sender, sendResponse) {

  if (msg.type === 'TIMER_FOUND') {
    if (getMode() === 'disabled') { sendResponse({ ok: true }); return true; }
    if (!Number.isFinite(msg.seconds) || msg.seconds < 0 || msg.seconds > 86400) { sendResponse({ ok: false, reason: 'bad_seconds' }); return true; }
    const now        = Date.now();
    const endsAt     = now + msg.seconds * 1000;
    const prevEndsAt = timerState.seconds != null ? sessionEndsAt() : null;
    // Та же приёмка, если время окончания совпадает с точностью до SESSION_TOLERANCE_MS
    // (в том числе после кратковременного исчезновения таймера при ререндере страницы)
    const sameSession = prevEndsAt != null && Math.abs(endsAt - prevEndsAt) <= SESSION_TOLERANCE_MS;

    if (sameSession) {
      if (timerState.lostAt != null) {
        chrome.alarms.clear(LOST_GRACE_ALARM);
        bgLog('Таймер снова виден — та же приёмка', 'info');
      }
      timerState = { ...timerState, seconds: msg.seconds, updatedAt: now, endsAt, lostAt: null, url: msg.url, title: msg.title, isManual: false };
    } else {
      chrome.alarms.clear(LOST_GRACE_ALARM);
      timerState = { seconds: msg.seconds, updatedAt: now, endsAt, lostAt: null, url: msg.url, title: msg.title, firedFor: [], isManual: false, startNotified: false };
      bgLog(`Таймер ${prevEndsAt != null ? 'новой приёмки' : 'обнаружен'}: ${fmt(msg.seconds)}${msg.debugInfo ? ` | ${msg.debugInfo}` : ''}`, 'ok');
      scheduleThresholdAlarms(msg.seconds);
    }
    chrome.storage.local.set({ timerState });
    updateBadge(msg.seconds);
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
    chrome.alarms.clear(LOST_GRACE_ALARM);
    timerState = { seconds: msg.seconds, updatedAt: Date.now(), endsAt: Date.now() + msg.seconds * 1000, lostAt: null, url: timerState.url, title: 'Ручной', firedFor: [], isManual: true, startNotified: false };
    chrome.storage.local.set({ timerState });
    updateBadge(msg.seconds);
    scheduleThresholdAlarms(msg.seconds);
    notifyTimerStarted(msg.seconds, true);
    sendResponse({ ok: true });
  }

  else if (msg.type === 'TIMER_LOST') {
    // Не стираем приёмку сразу: таймер мог пропасть на секунду при ререндере страницы.
    // Если за LOST_GRACE_MIN он не появится с тем же endsAt — аларм LOST_GRACE_ALARM завершит сессию.
    const current = remainingSeconds();
    if (current === 0) {
      endSession('время вышло');
    } else if (current != null && timerState.lostAt == null) {
      timerState.lostAt = Date.now();
      chrome.storage.local.set({ timerState });
      chrome.alarms.create(LOST_GRACE_ALARM, { delayInMinutes: LOST_GRACE_MIN });
      bgLog(`Таймер пропал со страницы — ждём ${LOST_GRACE_MIN} мин, пороги пока активны`, 'info');
    }
    sendResponse({ ok: true });
  }

  else if (msg.type === 'TIMER_CLEAR') {
    // Кнопка «Сбросить» в popup — завершить приёмку сразу, без ожидания LOST_GRACE_MIN
    if (timerState.seconds != null) endSession('сброшено вручную');
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
    // firedFor не сбрасываем: пересоздаём алармы только для ещё не сработавших порогов
    const current = remainingSeconds();
    if (current != null) scheduleThresholdAlarms(current);
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

  // Тесты не трогают рабочие settings: данные из полей popup передаются параметром
  else if (msg.type === 'DEBUG_TEST_TELEGRAM') {
    const tgCfg = msg.botToken && msg.chatId ? { enabled: true, botToken: msg.botToken, chatId: msg.chatId } : null;
    sendTelegram(msg.text || '🧪 Тест-сообщение от Ozon Turbo-PVZ.', true, tgCfg).then(sendResponse);
    return true;
  }

  else if (msg.type === 'DEBUG_TEST_NTFY') {
    const nCfg = msg.ntfy ? { ...settings.ntfy, ...msg.ntfy, enabled: true } : null;
    sendNtfy(msg.text || '🧪 Тест ntfy от Ozon Turbo-PVZ. Всё работает!', 'Ozon Turbo-PVZ — Тест', true, nCfg)
      .then(sendResponse);
    return true;
  }

  else if (msg.type === 'DEBUG_TEST_PROXY') {
    if (proxyTestOverride) { sendResponse({ ok: false, reason: 'тест прокси уже идёт — дождитесь результата' }); return true; }
    proxyTestOverride = { ...msg.proxy, enabled: true };
    (async () => {
      try {
        const applied = await applyProxy();
        if (!applied.ok) { sendResponse(applied); return; }
        const resp = await fetch(`https://api.telegram.org/bot${msg.botToken}/getMe`, { signal: AbortSignal.timeout(15000) });
        if (resp.status === 407) { sendResponse({ ok: false, reason: 'прокси требует логин/пароль или отклонил их (HTTP 407)' }); return; }
        const data = await resp.json();
        if (data.ok) {
          bgLog(`Прокси тест OK: @${data.result.username}`, 'ok');
          sendResponse({ ok: true, botName: data.result.username });
        } else {
          sendResponse({ ok: false, reason: data.description });
        }
      } catch (e) {
        const reason = e?.name === 'TimeoutError'
          ? 'нет ответа за 15 с — прокси недоступен или не пропускает Telegram'
          : `${e.message} — прокси недоступен, неверный тип/порт или логин`;
        bgLog(`Прокси тест: ${reason}`, 'err');
        sendResponse({ ok: false, reason });
      } finally {
        proxyTestOverride = null;
        await applyProxy();
      }
    })();
    return true;
  }

  else if (msg.type === 'DEBUG_SIM_TIMER') {
    const maxMins = Math.max(...settings.thresholds.filter(t => t.enabled).map(t => t.minutes), 30);
    const sec     = msg.seconds || maxMins * 60 + 70;
    chrome.alarms.clear(LOST_GRACE_ALARM);
    timerState = { seconds: sec, updatedAt: Date.now(), endsAt: Date.now() + sec * 1000, lostAt: null, url: timerState.url || 'https://turbo-pvz.ozon.ru', title: 'Debug', firedFor: [], isManual: false, startNotified: false };
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
    timerState = { seconds: null, updatedAt: null, endsAt: null, lostAt: null, url: '', title: '', firedFor: [], isManual: false, startNotified: false };
    settings   = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    modeState  = { mode: 'active', pauseUntil: null };
    chrome.storage.local.set({ modeState });
    clearProxy();
    updateBadge(null);
    bgLog('[DEBUG] Полный сброс', 'warn');
    sendResponse({ ok: true });
  }
}

// ─── Старт ────────────────────────────────────────────────────────────────

// SW эфемерный: при каждом пробуждении (аларм, сообщение) переменные выше — дефолтные.
// Все обработчики событий сначала делают `await ready`, чтобы работать с состоянием из storage,
// а не с дефолтами (иначе аларм порога видит seconds === null и уведомление теряется).
// Промис никогда не отклоняется: при ошибке чтения работаем с дефолтами.
const ready = chrome.storage.local.get(['timerState', 'pvzSettings', 'modeState'])
  .then(applyLoadedState)
  .catch((e) => bgLog(`Ошибка загрузки состояния: ${e?.message || e}`, 'err'));

function applyLoadedState(data) {
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
    updateBadge(remainingSeconds());
  }
}
