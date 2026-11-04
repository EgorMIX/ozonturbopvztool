// popup.js
'use strict';

// ─── Дефолты ──────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = [
  { minutes: 30, text: 'Внимание! До конца приёмки осталось 30 минут.',      volume: 0.7, enabled: true },
  { minutes: 15, text: 'Внимание! До конца приёмки осталось 15 минут!',      volume: 1.0, enabled: true },
  { minutes: 5,  text: 'Срочно! До конца приёмки осталось всего 5 минут!!!', volume: 1.0, enabled: true },
];

let settings = {
  thresholds:    JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
  notifType:     'both',
  theme:         'dark',
  telegram:      { enabled: false, botToken: '', chatId: '' },
  ntfy:          { enabled: false, topic: '', server: 'https://ntfy.sh', token: '', priority: 'default' },
  bagsEnabled:   true,
  bagsSizes:     'both',  // 'M' | 'L' | 'both'
  bagsQuota:     { M: 0, L: 0 }, // 0 = без ограничения
  proxy:         { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '' },
};

// ─── Тип уведомления ──────────────────────────────────────────────────────

const NOTIF_TYPE_DESCS = {
  voice: 'Только голосовое оповещение (синтез речи ru-RU). Push-уведомления не отправляются.',
  push:  'Только всплывающее push-уведомление Chrome. Работает даже если браузер свёрнут.',
  both:  'Голос и push-уведомление — максимальная надёжность оповещения.',
};

function applyNotifType(type) {
  settings.notifType = type;
  document.querySelectorAll('.notif-type-btn').forEach(btn =>
    btn.classList.toggle('selected', btn.dataset.type === type)
  );
  document.getElementById('notifTypeDesc').textContent = NOTIF_TYPE_DESCS[type] || '';
  document.getElementById('speechEnabled').checked = (type === 'voice' || type === 'both');
  document.getElementById('notifEnabled').checked  = (type === 'push'  || type === 'both');
  updateVolColVisibility(type);
}

function updateVolColVisibility(type) {
  const hasVoice = (type === 'voice' || type === 'both');
  document.querySelectorAll('.vol-wrap').forEach(el => {
    el.style.opacity       = hasVoice ? '1' : '0.25';
    el.style.pointerEvents = hasVoice ? 'auto' : 'none';
  });
  document.querySelectorAll('.threshold-header span:nth-child(3)').forEach(el => {
    el.style.opacity = hasVoice ? '1' : '0.3';
  });
}

document.querySelectorAll('.notif-type-btn').forEach(btn =>
  btn.addEventListener('click', () => applyNotifType(btn.dataset.type))
);

// ─── Тема ─────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
}
document.getElementById('themeBtn').addEventListener('click', () => {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme(settings.theme);
  chrome.storage.local.set({ pvzSettings: settings });
});

// ─── Утилиты ──────────────────────────────────────────────────────────────

function formatTime(s) {
  if (s == null || s < 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function parseManualInput(val) {
  val = val.trim().replace(/[^0-9:]/g, '');
  const parts = val.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1 && parts[0] > 0) return parts[0] * 60;
  return null;
}

function nowStr() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Лог ──────────────────────────────────────────────────────────────────

const logBox = document.getElementById('logBox');

function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className   = `log-${type}`;
  div.textContent = `[${nowStr()}] ${msg}`;
  logBox.appendChild(div);
  while (logBox.children.length > 60) logBox.removeChild(logBox.firstChild);
  logBox.scrollTop = logBox.scrollHeight;
}

let lastLogLength = 0;

function syncLog(force = false) {
  if (!debugOpen && !force) return;
  chrome.runtime.sendMessage({ type: 'GET_LOG' }, (resp) => {
    if (!resp?.log) return;
    if (resp.log.length === lastLogLength && !force) return;
    if (force || resp.log.length < lastLogLength) {
      logBox.innerHTML = '';
      lastLogLength    = 0;
    }
    resp.log.slice(lastLogLength).forEach(e => {
      const div = document.createElement('div');
      div.className   = `log-${e.type || 'info'}`;
      div.textContent = e.text;
      logBox.appendChild(div);
    });
    lastLogLength    = resp.log.length;
    logBox.scrollTop = logBox.scrollHeight;
  });
}

// ─── Режим работы ─────────────────────────────────────────────────────────

let currentMode = 'active';

function renderModePanel(modeState) {
  if (!modeState) return;
  currentMode = modeState.mode;
  const btnActive   = document.getElementById('btnModeActive');
  const btnPause    = document.getElementById('btnModePause');
  const btnDisabled = document.getElementById('btnModeDisabled');
  const statusEl    = document.getElementById('modeStatus');
  [btnActive, btnPause, btnDisabled].forEach(b =>
    b.classList.remove('active-state', 'paused-state', 'disabled-state')
  );
  if (currentMode === 'active') {
    btnActive.classList.add('active-state');
    statusEl.textContent = '▶ Мониторинг активен — все оповещения включены';
    statusEl.className   = 'mode-status ok';
  } else if (currentMode === 'paused') {
    btnPause.classList.add('paused-state');
    const rem = modeState.pauseUntil ? Math.max(0, Math.round((modeState.pauseUntil - Date.now()) / 60000)) : 0;
    statusEl.textContent = `⏸ Пауза — оповещения заглушены ещё ~${rem} мин`;
    statusEl.className   = 'mode-status warn';
  } else if (currentMode === 'disabled') {
    btnDisabled.classList.add('disabled-state');
    statusEl.textContent = '🚫 Плагин отключён — мониторинг остановлен';
    statusEl.className   = 'mode-status danger';
  }
}

function sendSetMode(mode, pauseMinutes = 0) {
  chrome.runtime.sendMessage({ type: 'SET_MODE', mode, pauseMinutes }, (resp) => {
    if (resp?.modeState) renderModePanel(resp.modeState);
    log(`Режим: ${mode}${pauseMinutes ? ` (${pauseMinutes} мин)` : ''}`, mode === 'active' ? 'ok' : 'warn');
  });
}

document.getElementById('btnModeActive').addEventListener('click',   () => sendSetMode('active'));
document.getElementById('btnModePause').addEventListener('click',    () => {
  const mins = parseInt(document.getElementById('pauseDuration').value, 10);
  sendSetMode('paused', mins);
});
document.getElementById('btnModeDisabled').addEventListener('click', () => sendSetMode('disabled'));

// ─── Рендер таймера ───────────────────────────────────────────────────────

function render(timerState) {
  const display = document.getElementById('timerDisplay');
  const sub     = document.getElementById('subText');
  const badge   = document.getElementById('notifyBadge');
  const manInd  = document.getElementById('manualIndicator');

  if (!timerState || timerState.seconds == null) {
    display.className  = 'timer-display none'; display.textContent = '—';
    sub.textContent    = 'Таймер не обнаружен на странице';
    badge.textContent  = '🔔 Ожидание'; badge.className = 'badge';
    manInd.textContent = '';
    return;
  }

  const elapsed = timerState.updatedAt ? (Date.now() - timerState.updatedAt) / 1000 : 0;
  const current = Math.max(Math.round(timerState.seconds - elapsed), 0);

  display.textContent = formatTime(current);
  sub.textContent     = current === 0 ? 'Время истекло!' : 'до конца приёмки';
  manInd.textContent  = timerState.isManual ? '✏️ Ручной режим' : '';

  const thresholds = settings.thresholds.filter(t => t.enabled).sort((a, b) => b.minutes - a.minutes);
  const active     = thresholds.find(t => current <= t.minutes * 60);

  if (current === 0) {
    display.className = 'timer-display danger';
    badge.textContent = '🚨 Время вышло!'; badge.className = 'badge';
  } else if (active) {
    display.className = 'timer-display warning';
    badge.textContent = `⚠️ Порог ${active.minutes} мин!`; badge.className = 'badge';
  } else {
    display.className = 'timer-display ok';
    const next = [...thresholds].reverse().find(t => current > t.minutes * 60);
    badge.textContent = next ? `✅ Следующий: ${next.minutes} мин` : '✅ Мониторинг активен';
    badge.className   = 'badge active';
  }
}

// ─── Ручной таймер ────────────────────────────────────────────────────────

const manualInput = document.getElementById('manualInput');
manualInput.addEventListener('input', () => {
  document.getElementById('manualErr').style.display = 'none';
  let v = manualInput.value.replace(/[^0-9]/g, '');
  if (v.length > 6) v = v.slice(0, 6);
  if (v.length > 4)      v = v.slice(0,2) + ':' + v.slice(2,4) + ':' + v.slice(4);
  else if (v.length > 2) v = v.slice(0,2) + ':' + v.slice(2);
  manualInput.value = v;
});

document.getElementById('btnSetManual').addEventListener('click', () => {
  const seconds = parseManualInput(manualInput.value);
  if (!seconds || seconds <= 0) { document.getElementById('manualErr').style.display = 'block'; return; }
  chrome.runtime.sendMessage({ type: 'TIMER_MANUAL', seconds }, (r) => {
    if (r?.ok) { log(`Ручной таймер: ${formatTime(seconds)}`, 'ok'); manualInput.value = ''; }
  });
});

document.getElementById('btnClearManual').addEventListener('click', () => {
  // TIMER_CLEAR завершает приёмку сразу (TIMER_LOST от страницы ждёт LOST_GRACE_MIN)
  chrome.runtime.sendMessage({ type: 'TIMER_CLEAR' }, () => { log('Таймер сброшен', 'warn'); render(null); });
  manualInput.value = '';
});

// ─── Пороги ───────────────────────────────────────────────────────────────

const thresholdList = document.getElementById('thresholdList');

function renderThresholds() {
  thresholdList.innerHTML = '';
  settings.thresholds.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'threshold-row';

    const minsWrap  = document.createElement('div'); minsWrap.className = 'mins-wrap';
    const minsInput = document.createElement('input');
    minsInput.type = 'number'; minsInput.min = '1'; minsInput.max = '240'; minsInput.value = t.minutes;
    minsInput.addEventListener('change', () => { const v = parseInt(minsInput.value); if (v > 0) settings.thresholds[i].minutes = v; });
    minsWrap.appendChild(minsInput);

    const textInput = document.createElement('input');
    textInput.type = 'text'; textInput.value = t.text; textInput.maxLength = 140;
    textInput.addEventListener('input', () => { settings.thresholds[i].text = textInput.value; });

    const volWrap  = document.createElement('div'); volWrap.className = 'vol-wrap';
    volWrap.setAttribute('data-val', Math.round(t.volume * 100) + '%');
    const volRange = document.createElement('input');
    volRange.type = 'range'; volRange.min = '0'; volRange.max = '1'; volRange.step = '0.1'; volRange.value = t.volume;
    volRange.addEventListener('input', () => {
      settings.thresholds[i].volume = parseFloat(volRange.value);
      volWrap.setAttribute('data-val', Math.round(volRange.value * 100) + '%');
    });
    volWrap.appendChild(volRange);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-del'; delBtn.textContent = '✕'; delBtn.title = 'Удалить этот порог';
    delBtn.addEventListener('click', () => { settings.thresholds.splice(i, 1); renderThresholds(); });

    row.append(minsWrap, textInput, volWrap, delBtn);
    thresholdList.appendChild(row);
  });
  updateVolColVisibility(settings.notifType);
}

document.getElementById('btnAddThreshold').addEventListener('click', () => {
  settings.thresholds.push({ minutes: 10, text: 'До конца приёмки осталось 10 минут!', volume: 1.0, enabled: true });
  renderThresholds();
});

// ─── Сохранение ───────────────────────────────────────────────────────────

document.getElementById('saveBtn').addEventListener('click', () => {
  const btn = document.getElementById('saveBtn');
  const showBtnError = (text) => {
    btn.textContent = text;
    setTimeout(() => { btn.textContent = '💾 Сохранить настройки'; }, 3000);
  };
  // Порог идентифицируется минутами — два порога с одинаковыми минутами мешали бы друг другу
  const mins = settings.thresholds.map(t => t.minutes);
  const dup  = mins.find((m, i) => mins.indexOf(m) !== i);
  if (dup !== undefined) { log(`Два порога на ${dup} мин — измените один`, 'err'); showBtnError(`⚠️ Два порога на ${dup} мин`); return; }
  const ntfyFields = readNtfyFields();
  if (ntfyFields.enabled && !/^https:\/\/[^\s/]+/i.test(ntfyFields.server)) {
    log('Сервер ntfy должен начинаться с https://', 'err'); showBtnError('⚠️ ntfy: нужен https://'); return;
  }
  settings.thresholds    = settings.thresholds.map(t => ({ ...t, enabled: true }));
  settings.telegram      = {
    enabled:  document.getElementById('tgEnabled').checked,
    botToken: document.getElementById('tgBotToken').value.trim(),
    chatId:   document.getElementById('tgChatId').value.trim(),
  };
  settings.bagsSizes     = document.querySelector('.bags-size-btn.selected')?.dataset.size || 'both';
  settings.bagsQuota     = readBagsQuota();
  settings.ntfy          = readNtfyFields();
  settings.proxy         = readProxyFields();
  settings.speechEnabled = (settings.notifType === 'voice' || settings.notifType === 'both');
  settings.notifEnabled  = (settings.notifType === 'push'  || settings.notifType === 'both');

  chrome.storage.local.set({ pvzSettings: settings }, () => {
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings });
    log('Настройки сохранены', 'ok');
    btn.textContent = '✅ Сохранено!'; btn.classList.add('saved');
    setTimeout(() => { btn.textContent = '💾 Сохранить настройки'; btn.classList.remove('saved'); }, 1500);
  });
});

// ─── Загрузка настроек ────────────────────────────────────────────────────

function loadSettings(cb) {
  chrome.storage.local.get('pvzSettings', (data) => {
    if (data.pvzSettings) {
      settings = {
        thresholds:    data.pvzSettings.thresholds    ?? JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
        notifType:     data.pvzSettings.notifType     ?? 'both',
        theme:         data.pvzSettings.theme         ?? 'dark',
        speechEnabled: data.pvzSettings.speechEnabled ?? true,
        notifEnabled:  data.pvzSettings.notifEnabled  ?? true,
        telegram:      { enabled: false, botToken: '', chatId: '',                                              ...(data.pvzSettings.telegram || {}) },
        ntfy:          { enabled: false, topic: '', server: 'https://ntfy.sh', token: '', priority: 'default', ...(data.pvzSettings.ntfy     || {}) },
        bagsEnabled:   data.pvzSettings.bagsEnabled !== false,
        bagsSizes:     data.pvzSettings.bagsSizes     ?? 'both',
        bagsQuota:     { M: data.pvzSettings.bagsQuota?.M ?? 0, L: data.pvzSettings.bagsQuota?.L ?? 0 },
        proxy:         { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '',        ...(data.pvzSettings.proxy    || {}) },
      };
    }
    applyTheme(settings.theme);
    applyNotifType(settings.notifType);
    document.getElementById('tgEnabled').checked  = settings.telegram.enabled;
    document.getElementById('tgBotToken').value   = settings.telegram.botToken;
    document.getElementById('tgChatId').value     = settings.telegram.chatId;
    updateTgVisibility();
    loadNtfyFields(settings.ntfy);
    loadProxyFields(settings.proxy);
    document.getElementById('bagsEnabled').checked = settings.bagsEnabled !== false;
    applyBagsSize(settings.bagsSizes || 'both');
    loadBagsQuota(settings.bagsQuota);
    renderThresholds();
    if (cb) cb();
  });
}

// ─── Telegram UI ──────────────────────────────────────────────────────────

function updateTgVisibility() {
  document.getElementById('tgFields').classList.toggle('visible', document.getElementById('tgEnabled').checked);
}
document.getElementById('tgEnabled').addEventListener('change', updateTgVisibility);

document.getElementById('tgBotFather').addEventListener('click', (e) => {
  e.preventDefault(); chrome.tabs.create({ url: 'https://t.me/BotFather' });
});
// Chat ID ищем запросом getUpdates прямо из popup, а не вкладкой: иначе токен бота остаётся в истории браузера
document.getElementById('tgGetUpdates').addEventListener('click', async (e) => {
  e.preventDefault();
  const status = document.getElementById('tgStatus');
  const token  = document.getElementById('tgBotToken').value.trim();
  const show = (text, cls) => { status.textContent = text; status.className = `tg-status ${cls}`; setTimeout(() => { status.textContent = ''; }, 7000); };
  if (!token) { show('❌ Сначала введите Bot Token', 'err'); return; }
  status.textContent = '⏳ Ищем чаты…'; status.className = 'tg-status';
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15000) });
    const data = await resp.json();
    if (!data.ok) { show(`❌ ${data.description || 'ошибка Telegram'}`, 'err'); return; }
    const chats = new Map();
    for (const u of data.result || []) {
      const c = (u.message || u.channel_post || u.my_chat_member || u.edited_message)?.chat;
      if (c?.id != null) chats.set(String(c.id), c.title || c.username || c.first_name || '');
    }
    if (!chats.size) { show('❌ Сообщений нет — напишите боту любое сообщение и нажмите ещё раз', 'err'); return; }
    const [firstId] = chats.keys();
    document.getElementById('tgChatId').value = firstId;
    show(chats.size === 1
      ? `✅ Chat ID подставлен: ${firstId} (${chats.get(firstId)})`
      : `✅ Подставлен ${firstId}; ещё чаты: ${[...chats.keys()].slice(1).join(', ')}`, 'ok');
  } catch (err) {
    show(`❌ ${err?.name === 'TimeoutError' ? 'Telegram не ответил за 15 с' : err.message}`, 'err');
  }
});

document.getElementById('btnTestTg').addEventListener('click', () => {
  const status = document.getElementById('tgStatus');
  status.textContent = '⏳ Отправка…'; status.className = 'tg-status';
  chrome.runtime.sendMessage(
    {
      type:     'DEBUG_TEST_TELEGRAM',
      text:     '🧪 Тест-сообщение от Ozon Turbo-PVZ. Всё работает!',
      botToken: document.getElementById('tgBotToken').value.trim(),
      chatId:   document.getElementById('tgChatId').value.trim(),
    },
    (r) => {
      if (r?.ok) { status.textContent = '✅ Сообщение доставлено!'; status.className = 'tg-status ok'; }
      else { status.textContent = `❌ Ошибка: ${r?.reason || 'неизвестно'}`; status.className = 'tg-status err'; }
      setTimeout(() => { status.textContent = ''; }, 5000);
    }
  );
});

// ─── ntfy UI ──────────────────────────────────────────────────────────────

function updateNtfyVisibility() {
  document.getElementById('ntfyFields').classList.toggle('visible', document.getElementById('ntfyEnabled').checked);
}
document.getElementById('ntfyEnabled').addEventListener('change', updateNtfyVisibility);

function loadNtfyFields(ntfy) {
  if (!ntfy) return;
  document.getElementById('ntfyEnabled').checked  = ntfy.enabled  || false;
  document.getElementById('ntfyTopic').value      = ntfy.topic    || '';
  document.getElementById('ntfyServer').value     = ntfy.server   || 'https://ntfy.sh';
  document.getElementById('ntfyToken').value      = ntfy.token    || '';
  document.getElementById('ntfyPriority').value   = ntfy.priority || 'default';
  updateNtfyVisibility();
}

function readNtfyFields() {
  return {
    enabled:  document.getElementById('ntfyEnabled').checked,
    topic:    document.getElementById('ntfyTopic').value.trim(),
    server:   document.getElementById('ntfyServer').value.trim() || 'https://ntfy.sh',
    token:    document.getElementById('ntfyToken').value.trim(),
    priority: document.getElementById('ntfyPriority').value,
  };
}

document.getElementById('btnTestNtfy').addEventListener('click', () => {
  const status = document.getElementById('ntfyStatus');
  const ntfy   = readNtfyFields();
  if (!ntfy.topic) {
    status.textContent = '❌ Укажите топик'; status.className = 'tg-status err';
    setTimeout(() => { status.textContent = ''; }, 4000);
    return;
  }
  status.textContent = '⏳ Отправка…'; status.className = 'tg-status';
  chrome.runtime.sendMessage(
    { type: 'DEBUG_TEST_NTFY', ntfy, text: '🧪 Тест ntfy от Ozon Turbo-PVZ. Всё работает!' },
    (r) => {
      if (r?.ok) { status.textContent = '✅ Уведомление отправлено!'; status.className = 'tg-status ok'; }
      else { status.textContent = `❌ Ошибка: ${r?.reason || 'нет ответа'}`; status.className = 'tg-status err'; }
      setTimeout(() => { status.textContent = ''; }, 5000);
    }
  );
});

// ─── Прокси UI ────────────────────────────────────────────────────────────

function updateProxyVisibility() {
  document.getElementById('proxyFields').classList.toggle('visible', document.getElementById('proxyEnabled').checked);
}
document.getElementById('proxyEnabled').addEventListener('change', updateProxyVisibility);

function loadProxyFields(proxy) {
  if (!proxy) return;
  document.getElementById('proxyEnabled').checked  = proxy.enabled  || false;
  document.getElementById('proxyType').value       = proxy.type     || 'socks5';
  document.getElementById('proxyHost').value       = proxy.host     || '';
  document.getElementById('proxyPort').value       = proxy.port     || '';
  document.getElementById('proxyUsername').value   = proxy.username || '';
  document.getElementById('proxyPassword').value   = proxy.password || '';
  updateProxyVisibility();
}

function readProxyFields() {
  return {
    enabled:  document.getElementById('proxyEnabled').checked,
    type:     document.getElementById('proxyType').value,
    host:     document.getElementById('proxyHost').value.trim(),
    port:     document.getElementById('proxyPort').value.trim(),
    username: document.getElementById('proxyUsername').value.trim(),
    password: document.getElementById('proxyPassword').value,
  };
}

document.getElementById('btnTestProxy').addEventListener('click', () => {
  const status   = document.getElementById('proxyStatus');
  const proxy    = readProxyFields();
  const botToken = document.getElementById('tgBotToken').value.trim();

  if (!proxy.host || !proxy.port) {
    status.textContent = '❌ Укажите хост и порт'; status.className = 'tg-status err';
    setTimeout(() => { status.textContent = ''; }, 4000);
    return;
  }
  if (!botToken) {
    status.textContent = '❌ Для теста нужен Bot Token в разделе Telegram'; status.className = 'tg-status err';
    setTimeout(() => { status.textContent = ''; }, 5000);
    return;
  }
  status.textContent = '⏳ Проверяем…'; status.className = 'tg-status';
  chrome.runtime.sendMessage(
    { type: 'DEBUG_TEST_PROXY', proxy, botToken, chatId: document.getElementById('tgChatId').value.trim() },
    (r) => {
      if (r?.ok) { status.textContent = `✅ Прокси работает! (${proxy.type}://${proxy.host}:${proxy.port})`; status.className = 'tg-status ok'; }
      else { status.textContent = `❌ Ошибка: ${r?.reason || 'нет ответа'}`; status.className = 'tg-status err'; }
      setTimeout(() => { status.textContent = ''; }, 6000);
    }
  );
});

// ─── Авто-пакеты UI ──────────────────────────────────────────────────────

// ─── Вкладки ──────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');
    if (tab === 'bags') updateBagsStats();
    if (tab === 'timer') render(null); // обновим таймер
  });
});

// ─── Авто-пакеты UI ───────────────────────────────────────────────────────

function applyBagsSize(size) {
  document.querySelectorAll('.bags-size-btn').forEach(btn =>
    btn.classList.toggle('selected', btn.dataset.size === size)
  );
}

document.querySelectorAll('.bags-size-btn').forEach(btn =>
  btn.addEventListener('click', () => applyBagsSize(btn.dataset.size))
);

document.getElementById('bagsEnabled').addEventListener('change', () => {
  settings.bagsEnabled = document.getElementById('bagsEnabled').checked;
});

document.getElementById('saveBagsBtn').addEventListener('click', () => {
  settings.bagsEnabled = document.getElementById('bagsEnabled').checked;
  settings.bagsSizes   = document.querySelector('.bags-size-btn.selected')?.dataset.size || 'both';
  // SETTINGS_UPDATED не шлём: таймеру эти настройки не нужны, bags-content.js сам ловит storage.onChanged
  chrome.storage.local.set({ pvzSettings: settings }, () => {
    const btn = document.getElementById('saveBagsBtn');
    btn.textContent = '✅ Сохранено!'; btn.classList.add('saved');
    setTimeout(() => { btn.textContent = '💾 Сохранить'; btn.classList.remove('saved'); }, 1500);
  });
});

// ─── Лимит пакетов UI ────────────────────────────────────────────────────

function readBagsQuota() {
  return {
    M: Math.max(0, parseInt(document.getElementById('bagsLimitM').value, 10) || 0),
    L: Math.max(0, parseInt(document.getElementById('bagsLimitL').value, 10) || 0),
  };
}

function loadBagsQuota(quota) {
  if (!quota) return;
  document.getElementById('bagsLimitM').value = quota.M || 0;
  document.getElementById('bagsLimitL').value = quota.L || 0;
  updateLimitHints();
}

function updateLimitHints() {
  const m = parseInt(document.getElementById('bagsLimitM').value, 10) || 0;
  const l = parseInt(document.getElementById('bagsLimitL').value, 10) || 0;
  document.getElementById('bagsLimitMHint').textContent = m > 0 ? `остановить после ${m} шт` : 'без ограничения';
  document.getElementById('bagsLimitLHint').textContent = l > 0 ? `остановить после ${l} шт` : 'без ограничения';
}

document.getElementById('bagsLimitM').addEventListener('input', updateLimitHints);
document.getElementById('bagsLimitL').addEventListener('input', updateLimitHints);

document.getElementById('saveBagsLimitBtn').addEventListener('click', () => {
  settings.bagsQuota = readBagsQuota();
  // SETTINGS_UPDATED не шлём — см. saveBagsBtn
  chrome.storage.local.set({ pvzSettings: settings }, () => {
    const status = document.getElementById('bagsLimitStatus');
    const m = settings.bagsQuota.M, l = settings.bagsQuota.L;
    status.textContent = m === 0 && l === 0
      ? '✅ Без ограничений'
      : `✅ Лимит: M=${m || '∞'}, L=${l || '∞'}`;
    status.style.color = 'var(--ok)';
    setTimeout(() => { status.textContent = ''; }, 3000);
  });
});

// Статистика пакетов — читаем из storage, пишет bags-content.js
function updateBagsStats() {
  chrome.storage.local.get('bagsSessionStats', (data) => {
    const s  = data.bagsSessionStats || { M: 0, L: 0 };
    const qM = settings.bagsQuota?.M || 0;
    const qL = settings.bagsQuota?.L || 0;
    const cM = s.M ?? 0, cL = s.L ?? 0;

    // Значения: "7 / 10" если лимит задан, иначе просто "7"
    document.getElementById('bagsCountM').textContent     = qM > 0 ? `${cM} / ${qM}` : cM;
    document.getElementById('bagsCountL').textContent     = qL > 0 ? `${cL} / ${qL}` : cL;
    document.getElementById('bagsCountTotal').textContent = cM + cL;

    // Метки: показываем статус лимита
    const lblM = document.getElementById('bagsLabelM');
    const lblL = document.getElementById('bagsLabelL');
    if (lblM) {
      const doneM = qM > 0 && cM >= qM;
      lblM.textContent = doneM ? '✅ M — лимит!' : 'Пакет M';
      lblM.style.color = doneM ? 'var(--ok)' : '';
    }
    if (lblL) {
      const doneL = qL > 0 && cL >= qL;
      lblL.textContent = doneL ? '✅ L — лимит!' : 'Пакет L';
      lblL.style.color = doneL ? 'var(--ok)' : '';
    }

    const upd = document.getElementById('bagsUpdatedAt');
    if (upd && s.updatedAt) {
      upd.textContent = 'Обновлено: ' + new Date(s.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  });
}

// Сброс счётчика
document.getElementById('btnResetBagsStats').addEventListener('click', () => {
  chrome.storage.local.set({ bagsSessionStats: { M: 0, L: 0, updatedAt: Date.now() } }, () => {
    updateBagsStats();
  });
});

// Автообновление статистики каждые 3 сек (когда вкладка bags открыта)
setInterval(() => {
  const bagsTabActive = document.getElementById('tab-bags')?.classList.contains('active');
  if (bagsTabActive) updateBagsStats();
}, 3000);

// ─── Дебаг-панель ─────────────────────────────────────────────────────────

const debugPanel  = document.getElementById('debugPanel');
const debugToggle = document.getElementById('debugToggle');
let debugOpen = false;

debugToggle.addEventListener('click', () => {
  debugOpen = !debugOpen;
  debugPanel.style.display = debugOpen ? 'block' : 'none';
  debugToggle.textContent  = debugOpen ? '🐛 Отладка / Тестирование ▴' : '🐛 Отладка / Тестирование ▾';
  if (debugOpen) syncLog(true);
});

document.getElementById('btnTestNotif').addEventListener('click', () => {
  const mins = settings.thresholds[1]?.minutes ?? 15;
  log(`Тест push (порог ${mins} мин)…`, 'info');
  chrome.runtime.sendMessage({ type: 'DEBUG_TEST_NOTIF', minutes: mins }, (r) => {
    log(r?.ok ? 'Push отправлен ✓' : 'Ошибка push', r?.ok ? 'ok' : 'err');
  });
});

document.getElementById('btnTestSpeech').addEventListener('click', () => {
  const mins = settings.thresholds[1]?.minutes ?? 15;
  log('Тест голоса…', 'info');
  chrome.runtime.sendMessage({ type: 'DEBUG_TEST_SPEECH', minutes: mins }, (r) => {
    log(r?.ok ? 'Голос отправлен ✓' : `Голос: ${r?.reason || 'нет ответа'}`, r?.ok ? 'ok' : 'warn');
  });
});

document.getElementById('btnTestTgDebug').addEventListener('click', () => {
  log('Тест Telegram…', 'info');
  chrome.runtime.sendMessage(
    {
      type:     'DEBUG_TEST_TELEGRAM',
      text:     '🧪 Тест от Ozon Turbo-PVZ (дебаг-панель)',
      botToken: document.getElementById('tgBotToken').value.trim(),
      chatId:   document.getElementById('tgChatId').value.trim(),
    },
    (r) => { log(r?.ok ? 'Telegram ✓' : `Telegram: ${r?.reason}`, r?.ok ? 'ok' : 'err'); }
  );
});

document.getElementById('btnTestAll').addEventListener('click', () => {
  const mins = settings.thresholds[1]?.minutes ?? 15;
  log('Тест всех каналов…', 'info');
  chrome.runtime.sendMessage({ type: 'DEBUG_TEST_NOTIF',  minutes: mins });
  chrome.runtime.sendMessage({ type: 'DEBUG_TEST_SPEECH', minutes: mins });
  chrome.runtime.sendMessage(
    {
      type:     'DEBUG_TEST_TELEGRAM',
      text:     '🧪 Комплексный тест всех каналов.',
      botToken: document.getElementById('tgBotToken').value.trim(),
      chatId:   document.getElementById('tgChatId').value.trim(),
    },
    (r) => { log(r?.ok ? 'Все каналы ✓' : `Telegram: ${r?.reason || 'ошибка'}`, r?.ok ? 'ok' : 'warn'); }
  );
  chrome.runtime.sendMessage(
    { type: 'DEBUG_TEST_NTFY', ntfy: readNtfyFields(), text: '🧪 Комплексный тест всех каналов.' },
    (r) => { log(r?.ok ? 'ntfy ✓' : `ntfy: ${r?.reason || 'ошибка'}`, r?.ok ? 'ok' : 'warn'); }
  );
});

document.getElementById('btnSimTimer').addEventListener('click', () => {
  const maxMins = Math.max(...settings.thresholds.filter(t => t.enabled).map(t => t.minutes), 30);
  const sec = maxMins * 60 + 70;
  log(`Симуляция: ${formatTime(sec)} (~1 мин до первого порога)`, 'warn');
  chrome.runtime.sendMessage({ type: 'DEBUG_SIM_TIMER', seconds: sec }, (r) => {
    log(r?.ok ? 'Симуляция запущена ✓' : 'Ошибка', r?.ok ? 'ok' : 'err');
  });
});

document.getElementById('btnDebugMode').addEventListener('click', () => {
  sendSetMode('active');
  log('Режим сброшен → активен', 'ok');
});

document.getElementById('btnPageInfo').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) { log('Нет активного таба', 'err'); return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_INFO' }, (resp) => {
      if (chrome.runtime.lastError || !resp) { log('Нет ответа от таба (не страница Ozon?)', 'warn'); return; }
      log(`URL: ${resp.url}`, 'info');
      log(`Страница разрешена: ${resp.allowed ? '✅ да' : '❌ нет'}`, resp.allowed ? 'ok' : 'err');
      if (resp.allowed) log(resp.timerFound ? `Таймер: ✅ ${resp.seconds} сек` : 'Таймер: ❌ не найден', resp.timerFound ? 'ok' : 'warn');
    });
  });
});

document.getElementById('btnClearAlarms').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DEBUG_CLEAR_ALARMS' }, (r) => {
    log(r?.ok ? 'Алармы очищены ✓' : 'Ошибка', r?.ok ? 'ok' : 'err');
  });
});

document.getElementById('btnReset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DEBUG_RESET' }, () => {
    chrome.storage.local.clear(() => {
      settings = {
        thresholds: JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
        notifType: 'both', theme: 'dark',
        telegram:  { enabled: false, botToken: '', chatId: '' },
        ntfy:      { enabled: false, topic: '', server: 'https://ntfy.sh', token: '', priority: 'default' },
        proxy:     { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '' },
        bagsEnabled: true,
        bagsSizes:   'both',
        bagsQuota:   { M: 0, L: 0 },
      };
      loadSettings();
      render(null);
      log('Полный сброс ✓', 'warn');
    });
  });
});

// ─── Инициализация ────────────────────────────────────────────────────────

loadSettings(() => {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
    if (resp?.timerState) render(resp.timerState);
    if (resp?.modeState)  renderModePanel(resp.modeState);
  });
});

setInterval(() => {
  chrome.storage.local.get(['timerState', 'modeState'], (data) => {
    render(data.timerState || null);
    if (data.modeState) renderModePanel(data.modeState);
  });
}, 1000);

setInterval(() => { if (debugOpen) syncLog(true); }, 2000);
