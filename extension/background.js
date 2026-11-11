// background.js — Service Worker
'use strict';
importScripts('settings.js');

const NOTIFY_ID   = 'ozon_pvz_notify';
const BADGE_ALARM = 'badge_tick';
const PAUSE_ALARM = 'pause_end';

// ─── Дефолтные настройки ──────────────────────────────────────────────────

// Пороги считаются до КРАЙНЕГО СРОКА завершения приёмки (конец таймера минус finishMarginMin):
// чтобы не получить штраф, приёмку надо программно завершить хотя бы за 1 минуту до конца таймера.
const DEFAULT_SETTINGS = PVZSettings.defaults();

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
// Функция, а не объект-шаблон: `{ ...шаблон }` делит массив firedFor между приёмками
const emptyTimerState = () => ({
  seconds:          null,
  updatedAt:        null,
  endsAt:           null,
  lostAt:           null,  // когда таймер пропал со страницы (null — виден)
  url:              '',
  title:            '',
  firedFor:         [],
  isManual:         false,
  startNotified:    false,
  sessionId:        null,  // id записи в истории приёмок
  source:           null,  // 'auto' | 'manual' | 'debug'
  deadlineNotified: false, // оповещение «крайний срок» уже отправлено
  carriages:        [],    // перевозки в статусе «Приёмка»: [{number, source, accepted, total, totalFirst}]
  tabId:            null,  // только вкладка-источник может завершить эту приёмку
  marginMin:        null,
});
let timerState = emptyTimerState();

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

// ─── Крайний срок завершения ─────────────────────────────────────────────
// Штрафа нет, если приёмку программно завершили хотя бы за finishMarginMin до конца таймера;
// после этого товар принимают уже вне приёмки, «излишками».

const DEADLINE_ALARM = 'deadline_reached';

function marginSec() {
  const m = Number(settings.finishMarginMin);
  return Number.isFinite(m) && m >= 0 && m <= 30 ? Math.round(m * 60) : 60;
}

function sessionDeadlineAt() {
  const endsAt = sessionEndsAt();
  return endsAt == null ? null : endsAt - marginSec() * 1000;
}

// Секунд до крайнего срока (0 — срок наступил) или null, если приёмки нет
function deadlineSeconds() {
  const rem = remainingSeconds();
  return rem == null ? null : Math.max(rem - marginSec(), 0);
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// ─── Рабочие часы ─────────────────────────────────────────────────────────

function parseHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
  return m ? Math.min(+m[1], 23) * 60 + Math.min(+m[2], 59) : null;
}

// true — сейчас рабочее время (или ограничение выключено)
function isWorkTime(now = new Date()) {
  const wh = settings.workHours;
  if (!wh?.enabled) return true;
  const from = parseHM(wh.from), to = parseHM(wh.to);
  if (from == null || to == null || from === to) return true;
  const days = Array.isArray(wh.days) && wh.days.length ? wh.days : [0, 1, 2, 3, 4, 5, 6]; // ни одного дня = все дни
  const t = now.getHours() * 60 + now.getMinutes();
  if (from < to) return days.includes(now.getDay()) && t >= from && t < to;
  // смена через полночь: «хвост» после полуночи относится к смене предыдущего дня
  if (t >= from) return days.includes(now.getDay());
  if (t < to)    return days.includes((now.getDay() + 6) % 7);
  return false;
}

// Почему оповещение сейчас не отправляется (null — отправляется)
function quietReason() {
  const mode = getMode();
  if (mode !== 'active') return mode;
  if (!isWorkTime()) return 'вне рабочих часов';
  return null;
}

function clearThresholdAlarms() {
  return chrome.alarms.getAll().then(alarms =>
    Promise.all(alarms.filter(a => a.name.startsWith('threshold_') || a.name === DEADLINE_ALARM).map(a => chrome.alarms.clear(a.name)))
  );
}

// ─── Перевозки (виджет «Перевозки» на странице Turbo-PVZ) ─────────────────
// content.js шлёт CARRIAGES_UPDATE с номером, откуда, статусом и «Отправления: принято из всего».
// Пока у перевозки статус «Приёмка», «всего» может расти и уменьшаться; после завершения не меняется —
// поэтому данные берём только у перевозок в статусе «Приёмка», а последнее такое значение и есть итог.

const ACCEPTANCE_STATUS_RE = /при[её]мк/i;
const CARRIAGE_FRESH_MS    = 15 * 60 * 1000;  // перевозку, увиденную до старта таймера, привязываем, если не старше
let lastCarriages = { items: [], seenAt: 0 };  // последнее, что прислал content.js (копия в storage: carriagesState)

function sanitizeCarriages(raw) {
  if (!Array.isArray(raw)) return [];
  const int = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : null);
  return raw.slice(0, 20).map(c => ({
    number:   String(c?.number || '').replace(/\D/g, '').slice(0, 20),
    source:   String(c?.source || '').slice(0, 60),
    status:   String(c?.status || '').slice(0, 40),
    accepted: int(c?.accepted),
    total:    int(c?.total),
  })).filter(c => c.number);
}

// Обновить список перевозок приёмки свежими значениями (totalFirst — каким «всего» было, когда увидели впервые)
function mergeCarriages(prev, fresh) {
  const byNum = new Map((prev || []).map(c => [c.number, { ...c }]));
  for (const c of fresh) {
    if (c.total == null) continue;
    const old = byNum.get(c.number);
    byNum.set(c.number, {
      number: c.number, source: c.source || old?.source || '',
      accepted: c.accepted, total: c.total, totalFirst: old?.totalFirst ?? c.total,
    });
  }
  return [...byNum.values()];
}

function acceptanceCarriages(items) {
  return items.filter(c => ACCEPTANCE_STATUS_RE.test(c.status) && c.total != null);
}

function onCarriagesUpdate(items, tabId) {
  const now = Date.now();
  lastCarriages = { items, seenAt: now, tabId };
  chrome.storage.local.set({ carriagesState: lastCarriages });
  if (timerState.seconds != null && (timerState.tabId == null || timerState.tabId === tabId)) {
    // Финальный статус тоже содержит итоговые числа. Чужую завершённую перевозку не привязываем.
    const known = new Set(timerState.carriages.map(c => c.number));
    const relevant = items.filter(c => known.has(c.number) || ACCEPTANCE_STATUS_RE.test(c.status));
    timerState.carriages = mergeCarriages(timerState.carriages, relevant);
    chrome.storage.local.set({ timerState });
    syncActiveHistory();
  }
  // Дописываем финальные числа после исчезновения таймера только в последнюю связанную запись.
  const activeId = timerState.sessionId;
  historyUpdate(list => {
    for (const c of items) {
      const e = [...list].reverse().find(entry => entry.carriages?.some(x => x.number === c.number));
      if (!e || e.id === activeId || (e.tabId != null && e.tabId !== tabId)) continue;
      if (now - (e.finishedAt ?? e.startedAt) > 2 * 3600 * 1000) continue;
      e.carriages = mergeCarriages(e.carriages, [c]);
    }
  });
}

// ─── История приёмок ──────────────────────────────────────────────────────
// chrome.storage.local.acceptanceHistory — массив записей, старые сверху, не больше HISTORY_MAX.
// Запись: { id, startedAt, endsAt, deadlineAt, marginMin, source, finishedAt, result, firedFor }.
// result: active | onTime (завершена до крайнего срока) | late (после крайнего срока, до конца таймера) |
//         expired (таймер дошёл до нуля) | cleared (сброшено вручную) | unknown (вкладка закрыта/заморожена).

const HISTORY_KEY = 'acceptanceHistory';
const HISTORY_MAX = 300;
let historyQueue = Promise.resolve(); // записи по очереди, чтобы не потерять обновление

function historyUpdate(fn) {
  historyQueue = historyQueue.then(async () => {
    const data = await chrome.storage.local.get(HISTORY_KEY);
    const list = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
    fn(list);
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
    await chrome.storage.local.set({ [HISTORY_KEY]: list });
  }).catch(e => bgLog(`История: ${e?.message || e}`, 'err'));
  return historyQueue;
}

function historyStart(st) {
  const entry = {
    id: st.sessionId, startedAt: st.startedAt ?? st.updatedAt, endsAt: st.endsAt, deadlineAt: st.endsAt - (st.marginMin ?? marginSec() / 60) * 60000,
    marginMin: st.marginMin ?? marginSec() / 60, source: st.source, tabId: st.tabId, finishedAt: null, result: 'active', firedFor: [...st.firedFor],
    carriages: (st.carriages || []).map(c => ({ ...c })),
  };
  historyUpdate(list => { if (!list.some(e => e.id === entry.id)) list.push(entry); });
}

function syncActiveHistory() {
  if (!timerState.sessionId) return;
  const st = structuredClone(timerState);
  historyStart(st); // восстанавливает запись после очистки истории или обновления расширения
  historyUpdate(list => {
    const e = list.find(x => x.id === st.sessionId);
    Object.assign(e, { endsAt: st.endsAt, deadlineAt: st.endsAt - st.marginMin * 60000,
      marginMin: st.marginMin, carriages: st.carriages, firedFor: st.firedFor, source: st.source });
  });
}

// Итог приёмки по моменту, когда таймер пропал со страницы (это и есть «завершили приёмку»)
function sessionResult(st, reasonCode, now) {
  if (reasonCode === 'cleared') return { result: 'cleared', finishedAt: now };
  const endsAt     = st.endsAt ?? (st.updatedAt + st.seconds * 1000);
  const deadlineAt = endsAt - (st.marginMin ?? marginSec() / 60) * 60000;
  if (st.lostAt != null) {
    return { result: st.lostAt <= deadlineAt ? 'onTime' : (st.lostAt < endsAt ? 'late' : 'expired'), finishedAt: st.lostAt };
  }
  // Таймер не пропадал. Если вкладка присылала его в последнюю минуту — он правда дошёл до нуля,
  // иначе (вкладка закрыта/заморожена, ручной таймер) — итог неизвестен.
  if (now >= endsAt && st.source === 'auto' && st.updatedAt != null && endsAt - st.updatedAt <= 60 * 1000) {
    return { result: 'expired', finishedAt: endsAt };
  }
  return { result: 'unknown', finishedAt: null };
}

function historyFinish(st, reasonCode) {
  if (!st.sessionId) return;
  st = structuredClone(st);
  historyStart(st);
  const { result, finishedAt } = sessionResult(st, reasonCode, Date.now());
  historyUpdate(list => {
    const e = list.find(x => x.id === st.sessionId);
    if (!e) return;
    Object.assign(e, { endsAt: st.endsAt ?? e.endsAt, finishedAt, result, firedFor: [...(st.firedFor || [])] });
    if (st.carriages?.length) e.carriages = mergeCarriages(e.carriages, st.carriages);
    e.deadlineAt = e.endsAt - (e.marginMin ?? 1) * 60 * 1000;
  });
}

// reasonCode: 'cleared' — сброс кнопкой; иначе итог считается по lostAt (см. sessionResult)
function endSession(reason, reasonCode = '') {
  historyFinish(timerState, reasonCode);
  timerState = { ...emptyTimerState(), url: timerState.url };
  chrome.storage.local.set({ timerState });
  chrome.alarms.clear(LOST_GRACE_ALARM);
  cancelThresholdAlarms();
  if (getMode() !== 'disabled') updateBadge(null);
  bgLog(`Приёмка завершена: ${reason}`, 'info');
}

// Новая приёмка: закрыть предыдущую в истории, завести запись, поставить алармы
function startSession(seconds, { url, title, source, tabId = null }) {
  if (timerState.seconds != null) historyFinish(timerState, '');
  chrome.alarms.clear(LOST_GRACE_ALARM);
  const now = Date.now();
  timerState = {
    ...emptyTimerState(), seconds, startedAt: now, updatedAt: now, endsAt: now + seconds * 1000, url, title,
    isManual: source === 'manual', source, sessionId: `s${now}-${crypto.randomUUID()}`, tabId, marginMin: marginSec() / 60,
    // перевозка могла попасть в виджет «Приёмка» раньше, чем на странице появился таймер
    carriages: now - lastCarriages.seenAt <= CARRIAGE_FRESH_MS && (lastCarriages.tabId == null || lastCarriages.tabId === tabId)
      ? mergeCarriages([], acceptanceCarriages(lastCarriages.items)) : [],
  };
  chrome.storage.local.set({ timerState });
  historyStart(timerState);
  updateBadge(seconds);
  scheduleThresholdAlarms(seconds);
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
    cancelThresholdAlarms();
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

// seconds — остаток таймера Ozon; бейдж показывает время до КРАЙНЕГО СРОКА, после него — «!»
function updateBadge(seconds) {
  if (seconds == null || seconds <= 0) { chrome.action.setBadgeText({ text: '' }); return; }
  const toDeadline = Math.max(seconds - marginSec(), 0);
  let color = '#388e3c';
  if (toDeadline <= 5 * 60)       color = '#d32f2f';
  else if (toDeadline <= 30 * 60) color = '#f57c00';
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text: toDeadline > 0 ? fmtBadge(toDeadline) : '!' });
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
      signal: AbortSignal.timeout(15000),
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
    const origin = `${new URL(server).origin}/*`;
    if (origin !== 'https://ntfy.sh/*' && !(await chrome.permissions.contains({ origins: [origin] }))) {
      return { ok: false, reason: 'Нет доступа к серверу ntfy — сохраните настройки и разрешите доступ' };
    }
    const resp = await fetch(`${server}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    if (resp.ok) { bgLog(`ntfy: отправлено${isTest ? ' (тест)' : ''}`, isTest ? 'info' : 'warn'); return { ok: true }; }
    const err = await resp.text().catch(() => String(resp.status));
    bgLog(`ntfy ошибка ${resp.status}: ${err}`, 'err');
    return { ok: false, reason: `HTTP ${resp.status}: ${err}` };
  } catch (e) { bgLog(`ntfy error: ${e.message}`, 'err'); return { ok: false, reason: e.message }; }
}

// ─── Алармы ───────────────────────────────────────────────────────────────

chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => enqueueState(async () => {
  await ready;
  if (alarm.name === PAUSE_ALARM) { bgLog('Пауза завершена', 'ok'); setMode('active'); return; }
  if (alarm.name === LOST_GRACE_ALARM) {
    if (timerState.lostAt != null) endSession(`таймер не виден на странице ${LOST_GRACE_MIN} мин`);
    return;
  }
  if (alarm.name === UPDATE_ALARM) { checkForUpdate(false); return; }
  if (alarm.name === BADGE_ALARM) {
    if (getMode() === 'disabled') return;
    const current = remainingSeconds();
    if (current === 0) {
      fireDeadline(current);
      endSession('время таймера вышло');
    } else if (current != null) {
      updateBadge(current);
      checkThresholds(current); // в паузе / вне рабочих часов fireThreshold только помечает порог отработанным
    } else {
      updateBadge(null);
    }
    return;
  }
  if (alarm.name === DEADLINE_ALARM) {
    const current = remainingSeconds();
    if (current != null && deadlineSeconds() === 0) fireDeadline(current);
    return;
  }
  if (alarm.name.startsWith('threshold_')) {
    const mins = parseInt(alarm.name.split('_')[1]);
    bgLog(`Аларм порога ${mins} мин`, 'warn');
    const toDeadline = deadlineSeconds();
    if (toDeadline != null && toDeadline > 0 && toDeadline <= mins * 60) fireThreshold(mins, toDeadline);
  }
}));

// ─── Пороги ───────────────────────────────────────────────────────────────

// remainingSeconds — остаток таймера Ozon. Пороги считаются до крайнего срока (остаток − запас),
// в сам крайний срок — отдельный аларм DEADLINE_ALARM.
let alarmQueue = Promise.resolve();
let alarmGeneration = 0;
function cancelThresholdAlarms() {
  alarmGeneration++;
  alarmQueue = alarmQueue.then(clearThresholdAlarms).catch(e => bgLog(`Алармы: ${e.message}`, 'err'));
  return alarmQueue;
}

function scheduleThresholdAlarms(_remainingSeconds) {
  const generation = ++alarmGeneration;
  alarmQueue = alarmQueue.then(async () => {
    await clearThresholdAlarms();
    if (generation !== alarmGeneration || timerState.seconds == null || getMode() === 'disabled') return;
    const remaining = remainingSeconds();
    const toDeadline = Math.max(remaining - marginSec(), 0);
    const enabled = settings.thresholds.filter(t => t.enabled);
    for (let idx = 0; idx < enabled.length; idx++) {
      if (generation !== alarmGeneration) return;
      const t = enabled[idx];
      if (timerState.firedFor.includes(t.minutes)) continue;
      const fireInSec = toDeadline - t.minutes * 60;
      if (fireInSec > 0) {
        await chrome.alarms.create(`threshold_${t.minutes}_${idx}`, { when: sessionDeadlineAt() - t.minutes * 60000 });
        bgLog(`Аларм ${t.minutes} мин до крайнего срока: через ${Math.round(fireInSec / 60)} мин`, 'ok');
      } else if (toDeadline > 0) {
        fireThreshold(t.minutes, toDeadline);
      }
    }
    if (generation !== alarmGeneration) return;
    if (toDeadline > 0) {
      await chrome.alarms.create(DEADLINE_ALARM, { when: sessionDeadlineAt() });
    } else {
      fireDeadline(remaining);
    }
  }).catch(e => bgLog(`Алармы: ${e.message}`, 'err'));
  return alarmQueue;
}

function checkThresholds(remainingSeconds) {
  const toDeadline = Math.max(remainingSeconds - marginSec(), 0);
  for (const t of settings.thresholds.filter(t => t.enabled)) {
    if (toDeadline <= t.minutes * 60 && toDeadline > 0 && !timerState.firedFor.includes(t.minutes)) {
      fireThreshold(t.minutes, toDeadline);
    }
  }
  if (toDeadline === 0) fireDeadline(remainingSeconds);
}

// toDeadline — секунд до крайнего срока
function fireThreshold(minutes, toDeadline) {
  const threshold = settings.thresholds.find(t => t.minutes === minutes);
  if (!threshold?.enabled) return;
  if (timerState.firedFor.includes(minutes)) return;
  const quiet = quietReason();
  if (quiet) {
    // Пропущенный в паузе / вне рабочих часов порог помечаем отработанным — потом устаревшее оповещение не придёт
    timerState.firedFor.push(minutes);
    chrome.storage.local.set({ timerState });
    bgLog(`Порог ${minutes} мин пропущен (${quiet})`, 'info');
    return;
  }

  timerState.firedFor.push(minutes);
  chrome.storage.local.set({ timerState });
  bgLog(`🔔 Порог ${minutes} мин! До крайнего срока: ${fmt(toDeadline)} | push=${settings.notifEnabled} voice=${settings.speechEnabled}`, 'warn');

  const text = threshold.text || `Через ${minutes} минут крайний срок завершения приёмки!`;
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

// Крайний срок наступил: до конца таймера осталось finishMarginMin — завершать приёмку немедленно
function fireDeadline(remainingSeconds) {
  if (timerState.deadlineNotified) return;
  timerState.deadlineNotified = true;
  chrome.storage.local.set({ timerState });
  const quiet = quietReason();
  if (quiet) { bgLog(`Крайний срок — оповещение пропущено (${quiet})`, 'info'); return; }

  const text = `Крайний срок! Завершите приёмку прямо сейчас — до конца таймера ${fmt(remainingSeconds)}. ` +
    'Не успеваете — остальное принимайте излишками.';
  bgLog(`🚨 ${text}`, 'warn');
  if (settings.notifEnabled) {
    chrome.notifications.create(`${NOTIFY_ID}_deadline`, {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: '🚨 Ozon Turbo-PVZ — завершите приёмку', message: text,
      priority: 2, requireInteraction: true,
      buttons: [{ title: 'Перейти на страницу' }],
    });
  }
  if (settings.speechEnabled)     speakInTab('Крайний срок! Завершите приёмку прямо сейчас!', false, 1.0);
  if (settings.telegram?.enabled) sendTelegram(`🚨 ${text}`);
  if (settings.ntfy?.enabled)     sendNtfy(text, '🚨 Завершите приёмку');
}

// ─── Голос ────────────────────────────────────────────────────────────────

// Озвучка на вкладке Turbo-PVZ. Возвращает { ok, reason? }.
// Пробуем все вкладки (сначала активную, затем недавние): одна может быть открыта до установки/обновления
// расширения (content-скрипта нет), заморожена Chrome или показывать страницу ошибки.
async function speakInTab(text, isTest = false, volume = 1.0) {
  if (!settings.speechEnabled && !isTest) return { ok: false, reason: 'голос выключен' };
  const tabs = (await chrome.tabs.query({ url: ['*://turbo-pvz.ozon.ru/*'] })) // по host_permissions, без права «tabs»
    .filter(t => !t.discarded)
    .sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  if (!tabs.length) {
    const reason = 'нет открытой вкладки turbo-pvz.ozon.ru';
    bgLog(`Голос: ${reason}`, 'warn');
    return { ok: false, reason };
  }
  let lastError = '';
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SPEAK', text, volume });
      bgLog(`Голос vol=${volume}`, isTest ? 'info' : 'warn');
      return { ok: true };
    } catch (_) { /* content-скрипта во вкладке нет — пробуем внедрить */ }
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
      return { ok: true };
    } catch (e) { lastError = e?.message || String(e); }
  }
  const reason = await explainSpeechError(lastError);
  bgLog(`Ошибка голоса: ${reason} [${lastError}]`, 'err');
  return { ok: false, reason };
}

// Понятная причина и что сделать, по тексту ошибки Chrome
async function explainSpeechError(msg) {
  let hasAccess = true;
  try { hasAccess = await chrome.permissions.contains({ origins: ['*://turbo-pvz.ozon.ru/*'] }); } catch (_) {}
  if (!hasAccess || /must request permission|Cannot access contents/i.test(msg)) {
    return 'нет доступа к вкладке turbo-pvz.ozon.ru — обновите её (F5); если не поможет: chrome://extensions → ' +
      'Ozon Turbo-PVZ Timer → «Сведения» → «Доступ к сайтам» → «На всех сайтах» или «На определённых сайтах» с turbo-pvz.ozon.ru';
  }
  if (/error page/i.test(msg)) return 'на вкладке Turbo-PVZ страница ошибки (нет сети?) — обновите её';
  return 'вкладка Turbo-PVZ не ответила — обновите её (F5)';
}

// ─── Уведомление о старте приёмки ────────────────────────────────────────

function notifyTimerStarted(seconds, isManual = false) {
  const quiet = quietReason();
  if (quiet) { bgLog(`Старт приёмки — оповещение пропущено (${quiet})`, 'info'); return; }
  const timeStr  = fmt(seconds);
  const source   = isManual ? 'Ручной запуск' : 'Авто-обнаружение';
  const deadline = fmtClock(Date.now() + (seconds - marginSec()) * 1000);
  const message  = `Таймер: ${timeStr}. Завершите приёмку до ${deadline} (за ${fmt(marginSec())} до конца таймера).`;
  bgLog(`🟢 Старт приёмки (${source}): ${timeStr}, крайний срок ${deadline}`, 'ok');
  if (settings.notifEnabled) {
    chrome.notifications.create('ozon_pvz_start', {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: '✅ Ozon Turbo-PVZ — Приёмка начата',
      message: `${message} ${source}.`, priority: 1,
    });
  }
  if (settings.speechEnabled)     speakInTab(`Приёмка обнаружена. Завершить до ${deadline}.`, false, 0.6);
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
  if (notifId === UPDATE_NOTIF) { openUpdatePage(); chrome.notifications.clear(notifId); return; }
  if (!notifId.startsWith(NOTIFY_ID)) return;
  await ready; // нужен timerState.url из storage
  if (btnIdx === 0) openTimerPage();
  chrome.notifications.clear(notifId);
});

// Клик по самому уведомлению (не по кнопке) — тоже открыть страницу приёмки
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (notifId === UPDATE_NOTIF) { openUpdatePage(); chrome.notifications.clear(notifId); return; }
  if (!notifId.startsWith(NOTIFY_ID) && notifId !== 'ozon_pvz_start') return;
  await ready;
  openTimerPage();
  chrome.notifications.clear(notifId);
});

// ─── Проверка обновлений ─────────────────────────────────────────────────
// Расширение ставится из zip и само не обновляется: раз в день смотрим последний релиз на GitHub.
// api.github.com отдаёт CORS-заголовки, поэтому права на этот хост не нужны. Пока репозиторий приватный,
// API отвечает 404 — проверка молча ничего не находит.

const UPDATE_ALARM   = 'update_check';
const UPDATE_NOTIF   = 'ozon_pvz_update';
const RELEASES_API   = 'https://api.github.com/repos/EgorMIX/ozonturbopvztool/releases/latest';
const RELEASES_PAGE  = 'https://github.com/EgorMIX/ozonturbopvztool/releases/latest';
const RELEASE_URL_RE = /^https:\/\/github\.com\/EgorMIX\/ozonturbopvztool\/releases\//;

async function ensureUpdateAlarm() {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  }
}

// 1 — a новее b, -1 — старее, 0 — равны (версии вида 1.5.1, с «v» или без)
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// manual — нажата кнопка «Проверить» в popup: проверяем даже при выключенной настройке и отвечаем статусом
async function checkForUpdate(manual) {
  if (!settings.updateCheck && !manual) return { ok: true, skipped: true };
  const current = chrome.runtime.getManifest().version;
  try {
    const resp = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      const reason = resp.status === 404 ? 'релизы недоступны (репозиторий приватный?)' : `GitHub ответил ${resp.status}`;
      if (manual) bgLog(`Обновления: ${reason}`, 'warn');
      return { ok: false, reason, current };
    }
    const rel    = await resp.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const url    = RELEASE_URL_RE.test(rel.html_url || '') ? rel.html_url : RELEASES_PAGE;
    const stored = (await chrome.storage.local.get('updateInfo')).updateInfo || {};
    const newer  = latest && compareVersions(latest, current) > 0;
    const info   = { checkedAt: Date.now(), latest, url, current, newer, notifiedFor: stored.notifiedFor || null };
    if (newer && info.notifiedFor !== latest) {
      chrome.notifications.create(UPDATE_NOTIF, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: `Ozon Turbo-PVZ Timer ${latest}`,
        message: `Доступна новая версия (у вас ${current}). Нажмите, чтобы открыть страницу загрузки.`,
        priority: 0, buttons: [{ title: 'Открыть страницу релиза' }],
      });
      info.notifiedFor = latest;
    }
    await chrome.storage.local.set({ updateInfo: info });
    bgLog(`Обновления: последняя ${latest || '?'}, у вас ${current}${newer ? ' — есть новая' : ''}`, newer ? 'warn' : 'info');
    return { ok: true, current, latest, newer, url };
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? 'GitHub не ответил за 15 с' : e.message;
    if (manual) bgLog(`Обновления: ${reason}`, 'warn');
    return { ok: false, reason, current };
  }
}

async function openUpdatePage() {
  const info = (await chrome.storage.local.get('updateInfo')).updateInfo || {};
  chrome.tabs.create({ url: RELEASE_URL_RE.test(info.url || '') ? info.url : RELEASES_PAGE });
}

// ─── Сообщения ────────────────────────────────────────────────────────────

// Сначала дожидаемся загрузки состояния, потом обрабатываем. Ответ из-за этого всегда асинхронный,
// поэтому слушатель всегда возвращает true (канал открыт до sendResponse).
// Кто что может слать: content-скрипты (вкладка Ozon) — только данные таймера; всё остальное — только
// страницы самого расширения (popup). Страница Ozon до runtime не дотянется (нет externally_connectable),
// это защита на случай ошибки в content-скрипте.
const CONTENT_MSG_TYPES = new Set(['TIMER_FOUND', 'TIMER_LOST', 'CARRIAGES_UPDATE', 'BAGS_RESERVE', 'BAGS_COMMIT']);
function isAllowedSender(msg, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  // Страница расширения (popup — и всплывающим окном, и открытая во вкладке) — по адресу, а не по sender.tab
  if (String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return true;
  return Boolean(sender.tab) && CONTENT_MSG_TYPES.has(msg?.type) && OZON_PAGE_RE.test(sender.url || '');
}

let messageQueue = Promise.resolve();
function enqueueState(task) {
  messageQueue = messageQueue.then(async () => { await ready; await task(); await Promise.all([historyQueue, alarmQueue]); })
    .catch(e => bgLog(`Состояние: ${e.message}`, 'err'));
  return messageQueue;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isAllowedSender(msg, sender)) {
    bgLog(`Отклонено сообщение ${String(msg?.type).slice(0, 40)} от ${sender.tab ? 'вкладки' : 'неизвестного отправителя'}`, 'err');
    sendResponse({ ok: false, reason: 'forbidden' });
    return false;
  }
  messageQueue = messageQueue.then(async () => {
    await ready;
    await new Promise(resolve => {
      const reply = result => {
        Promise.all([historyQueue, alarmQueue]).then(() => { sendResponse(result); resolve(); });
      };
      try { Promise.resolve(handleMessage(msg, sender, reply)).catch(e => reply({ ok: false, reason: e.message })); }
      catch (e) { reply({ ok: false, reason: e.message }); }
    });
  }).catch(e => { bgLog(`Сообщение: ${e.message}`, 'err'); sendResponse({ ok: false, reason: 'internal_error' }); });
  return true;
});

async function handleMessage(msg, sender, sendResponse) {

  if (msg.type === 'TIMER_FOUND') {
    if (getMode() === 'disabled') { sendResponse({ ok: true }); return true; }
    if (!Number.isFinite(msg.seconds) || msg.seconds < 0 || msg.seconds > 86400) { sendResponse({ ok: false, reason: 'bad_seconds' }); return true; }
    const now        = Date.now();
    const endsAt     = now + msg.seconds * 1000;
    const prevEndsAt = timerState.seconds != null ? sessionEndsAt() : null;
    // Та же приёмка, если время окончания совпадает с точностью до SESSION_TOLERANCE_MS
    // (в том числе после кратковременного исчезновения таймера при ререндере страницы)
    const sameSession = prevEndsAt != null && Math.abs(endsAt - prevEndsAt) <= SESSION_TOLERANCE_MS;
    // Другая открытая вкладка не подменяет активный таймер. Источник можно подхватить после его закрытия.
    if (timerState.tabId != null && timerState.tabId !== sender.tab.id && prevEndsAt > now) {
      try {
        const tab = await chrome.tabs.get(timerState.tabId);
        if (!tab.url || /^https:\/\/turbo-pvz\.ozon\.ru\/receiving/.test(tab.url)) { sendResponse({ ok: true, ignored: true }); return; }
        timerState.tabId = sender.tab.id;
      }
      catch (_) { timerState.tabId = sender.tab.id; }
    }

    if (sameSession) {
      if (timerState.lostAt != null) {
        chrome.alarms.clear(LOST_GRACE_ALARM);
        bgLog('Таймер снова виден — та же приёмка', 'info');
      }
      timerState = {
        ...timerState, seconds: msg.seconds, updatedAt: now, endsAt, lostAt: null, url: msg.url, title: msg.title,
        isManual: false, source: timerState.source === 'debug' ? 'debug' : 'auto', tabId: sender.tab.id,
      };
      chrome.storage.local.set({ timerState });
      updateBadge(msg.seconds);
      syncActiveHistory();
      if (Math.abs(endsAt - prevEndsAt) > 1000) scheduleThresholdAlarms(msg.seconds);
    } else {
      bgLog(`Таймер ${prevEndsAt != null ? 'новой приёмки' : 'обнаружен'}: ${fmt(msg.seconds)}${msg.debugInfo ? ` | ${msg.debugInfo}` : ''}`, 'ok');
      startSession(msg.seconds, { url: msg.url, title: msg.title, source: 'auto', tabId: sender.tab.id });
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
    if (!Number.isFinite(msg.seconds) || msg.seconds <= 0 || msg.seconds > 86400) { sendResponse({ ok: false, reason: 'bad_seconds' }); return; }
    bgLog(`Ручной таймер: ${fmt(msg.seconds)}`, 'ok');
    startSession(msg.seconds, { url: timerState.url, title: 'Ручной', source: 'manual' });
    timerState.startNotified = true;
    chrome.storage.local.set({ timerState });
    notifyTimerStarted(msg.seconds, true);
    sendResponse({ ok: true });
  }

  else if (msg.type === 'TIMER_LOST') {
    if (timerState.tabId != null && timerState.tabId !== sender.tab.id) { sendResponse({ ok: true, ignored: true }); return; }
    // Навигация не доказывает завершение приёмки: продолжаем отсчёт, не ставим ложное «вовремя».
    if (msg.reason === 'navigation') { sendResponse({ ok: true }); return; }
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

  else if (msg.type === 'CARRIAGES_UPDATE') {
    onCarriagesUpdate(sanitizeCarriages(msg.items), sender.tab.id);
    sendResponse({ ok: true });
  }

  else if (msg.type === 'TIMER_CLEAR') {
    // Кнопка «Сбросить» в popup — завершить приёмку сразу, без ожидания LOST_GRACE_MIN
    if (timerState.seconds != null) endSession('сброшено вручную', 'cleared');
    sendResponse({ ok: true });
  }

  else if (msg.type === 'CHECK_UPDATE') {
    checkForUpdate(true).then(sendResponse);
    return true;
  }

  else if (msg.type === 'GET_STATE') { sendResponse({ timerState, settings, modeState }); }
  else if (msg.type === 'GET_LOG')   { sendResponse({ log: [...eventLog] }); }

  else if (msg.type === 'SET_MODE') {
    setMode(msg.mode, msg.pauseMinutes || 0);
    sendResponse({ ok: true, modeState });
  }

  else if (msg.type === 'SETTINGS_UPDATED') {
    settings = PVZSettings.normalize(msg.settings, settings, true);
    await chrome.storage.local.set({ pvzSettings: settings });
    const timerChanged = ['thresholds', 'finishMarginMin', 'workHours', 'notifType'].some(k => k in msg.settings);
    if (timerState.seconds != null && timerChanged) {
      timerState.marginMin = marginSec() / 60;
      await chrome.storage.local.set({ timerState });
      syncActiveHistory();
    }
    if (msg.settings.proxy !== undefined) applyProxy();
    bgLog('Настройки обновлены', 'info');
    // firedFor не сбрасываем: пересоздаём алармы только для ещё не сработавших порогов
    const current = remainingSeconds();
    if (current != null && timerChanged) scheduleThresholdAlarms(current);
    sendResponse({ ok: true, settings });
  }

  else if (msg.type === 'BAGS_RESERVE') {
    const label = msg.label;
    if (!['M', 'L'].includes(label) || !/\/orders\/session(?:-new)?\/\d+(?:\/|$)/.test(new URL(sender.url).pathname)) {
      sendResponse({ ok: false, reason: 'bad_bag_request' }); return;
    }
    const data = await chrome.storage.local.get(['bagsSessionStats', 'bagsReservations']);
    const stats = data.bagsSessionStats || { M: 0, L: 0 };
    const reservations = (data.bagsReservations || []).filter(r => r.expiresAt > Date.now());
    const used = (stats[label] || 0) + reservations.filter(r => r.label === label).length;
    const quota = settings.bagsQuota[label];
    if (getMode() === 'disabled' || !settings.bagsEnabled || (settings.bagsSizes !== 'both' && settings.bagsSizes !== label) || (quota > 0 && used >= quota)) {
      sendResponse({ ok: false, reason: 'bags_limit_or_disabled' }); return;
    }
    const token = crypto.randomUUID();
    reservations.push({ token, label, tabId: sender.tab.id, expiresAt: Date.now() + 120000 });
    await chrome.storage.local.set({ bagsReservations: reservations });
    sendResponse({ ok: true, token });
  }

  else if (msg.type === 'BAGS_COMMIT') {
    const data = await chrome.storage.local.get(['bagsSessionStats', 'bagsReservations']);
    const reservations = data.bagsReservations || [];
    const r = reservations.find(entry => entry.token === msg.token && entry.tabId === sender.tab.id);
    if (!r) { sendResponse({ ok: false, reason: 'unknown_reservation' }); return; }
    const stats = data.bagsSessionStats || { M: 0, L: 0 };
    if (msg.added === true) stats[r.label] = (stats[r.label] || 0) + 1;
    await chrome.storage.local.set({ bagsSessionStats: { ...stats, updatedAt: Date.now() },
      bagsReservations: reservations.filter(entry => entry.token !== r.token) });
    sendResponse({ ok: true });
  }

  else if (msg.type === 'BAGS_RESET') {
    await chrome.storage.local.set({ bagsSessionStats: { M: 0, L: 0, updatedAt: Date.now() }, bagsReservations: [] });
    sendResponse({ ok: true });
  }

  else if (msg.type === 'HISTORY_CLEAR') {
    await historyQueue;
    await chrome.storage.local.remove(HISTORY_KEY);
    syncActiveHistory();
    sendResponse({ ok: true });
  }

  else if (msg.type === 'DEBUG_TEST_NOTIF') {
    sendTestNotification(msg.minutes ?? settings.thresholds[1]?.minutes ?? 15);
    sendResponse({ ok: true });
  }

  else if (msg.type === 'DEBUG_TEST_SPEECH') {
    const mins = msg.minutes ?? settings.thresholds[1]?.minutes ?? 15;
    const t    = settings.thresholds.find(th => th.minutes === mins);
    sendResponse(await speakInTab(t?.text ?? `Тест. Осталось ${mins} минут.`, true, t?.volume ?? 1.0));
    return true;
  }

  // Тесты не трогают рабочие settings: данные из полей popup передаются параметром
  else if (msg.type === 'DEBUG_TEST_TELEGRAM') {
    const tgCfg = msg.botToken && msg.chatId ? { enabled: true, botToken: msg.botToken, chatId: msg.chatId } : null;
    sendResponse(await sendTelegram(msg.text || '🧪 Тест-сообщение от Ozon Turbo-PVZ.', true, tgCfg));
    return true;
  }

  else if (msg.type === 'DEBUG_TEST_NTFY') {
    const nCfg = msg.ntfy ? { ...settings.ntfy, ...msg.ntfy, enabled: true } : null;
    sendResponse(await sendNtfy(msg.text || '🧪 Тест ntfy от Ozon Turbo-PVZ. Всё работает!', 'Ozon Turbo-PVZ — Тест', true, nCfg));
    return true;
  }

  else if (msg.type === 'DEBUG_TEST_PROXY') {
    if (proxyTestOverride) { sendResponse({ ok: false, reason: 'тест прокси уже идёт — дождитесь результата' }); return true; }
    proxyTestOverride = { ...msg.proxy, enabled: true };
    const result = await (async () => {
      try {
        const applied = await applyProxy();
        if (!applied.ok) return applied;
        const resp = await fetch(`https://api.telegram.org/bot${msg.botToken}/getMe`, { signal: AbortSignal.timeout(15000) });
        if (resp.status === 407) return { ok: false, reason: 'прокси требует логин/пароль или отклонил их (HTTP 407)' };
        const data = await resp.json();
        if (data.ok) {
          bgLog(`Прокси тест OK: @${data.result.username}`, 'ok');
          return { ok: true, botName: data.result.username };
        } else {
          return { ok: false, reason: data.description };
        }
      } catch (e) {
        const reason = e?.name === 'TimeoutError'
          ? 'нет ответа за 15 с — прокси недоступен или не пропускает Telegram'
          : `${e.message} — прокси недоступен, неверный тип/порт или логин`;
        bgLog(`Прокси тест: ${reason}`, 'err');
        return { ok: false, reason };
      } finally {
        proxyTestOverride = null;
        await applyProxy();
      }
    })();
    sendResponse(result);
    return true;
  }

  else if (msg.type === 'DEBUG_SIM_TIMER') {
    const maxMins = Math.max(...settings.thresholds.filter(t => t.enabled).map(t => t.minutes), 30);
    const sec     = msg.seconds || maxMins * 60 + marginSec() + 70;
    startSession(sec, { url: timerState.url || 'https://turbo-pvz.ozon.ru', title: 'Debug', source: 'debug' });
    timerState.startNotified = true;
    chrome.storage.local.set({ timerState });
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
    await historyQueue;
    await cancelThresholdAlarms();
    for (const a of await chrome.alarms.getAll()) if (a.name !== BADGE_ALARM) await chrome.alarms.clear(a.name);
    timerState = emptyTimerState();
    settings   = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    modeState  = { mode: 'active', pauseUntil: null };
    await clearProxy();
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ modeState, pvzSettings: settings });
    lastCarriages = { items: [], seenAt: 0 };
    await ensureUpdateAlarm();
    updateBadge(null);
    bgLog('[DEBUG] Полный сброс', 'warn');
    sendResponse({ ok: true });
  }
  else sendResponse({ ok: false, reason: 'unknown_message' });
}

// ─── Старт ────────────────────────────────────────────────────────────────

// SW эфемерный: при каждом пробуждении (аларм, сообщение) переменные выше — дефолтные.
// Все обработчики событий сначала делают `await ready`, чтобы работать с состоянием из storage,
// а не с дефолтами (иначе аларм порога видит seconds === null и уведомление теряется).
// Промис никогда не отклоняется: при ошибке чтения работаем с дефолтами.
const ready = chrome.storage.local.get(['timerState', 'pvzSettings', 'modeState', 'carriagesState'])
  .then(applyLoadedState)
  .catch((e) => bgLog(`Ошибка загрузки состояния: ${e?.message || e}`, 'err'));

async function applyLoadedState(data) {
  if (data.pvzSettings) {
    settings = PVZSettings.normalize(data.pvzSettings);
    if (settings.notifType) {
      settings.speechEnabled = settings.notifType !== 'push';
      settings.notifEnabled  = settings.notifType !== 'voice';
    }
  }
  if (data.timerState) timerState = data.timerState;
  timerState = { ...emptyTimerState(), ...timerState };
  if (data.modeState)  modeState  = data.modeState;
  if (modeState.mode === 'paused' && modeState.pauseUntil > Date.now()) chrome.alarms.create(PAUSE_ALARM, { when: modeState.pauseUntil });
  if (data.carriagesState?.items) lastCarriages = data.carriagesState;
  if (!Array.isArray(timerState.carriages)) timerState.carriages = [];
  if (!Array.isArray(timerState.firedFor)) timerState.firedFor = [];
  if (timerState.seconds != null) {
    timerState.endsAt = sessionEndsAt();
    timerState.sessionId ||= `s${timerState.updatedAt || Date.now()}-${crypto.randomUUID()}`;
    timerState.source ||= timerState.isManual ? 'manual' : 'auto';
    timerState.marginMin = marginSec() / 60;
    await chrome.storage.local.set({ timerState });
    syncActiveHistory();
    if (timerState.lostAt != null) chrome.alarms.create(LOST_GRACE_ALARM, { when: Math.max(Date.now() + 1, timerState.lostAt + LOST_GRACE_MIN * 60000) });
  }

  applyProxy();
  ensureUpdateAlarm();
  bgLog(`SW запущен | push=${settings.notifEnabled} voice=${settings.speechEnabled} type=${settings.notifType || '?'} mode=${modeState.mode}`, 'ok');

  if (getMode() === 'disabled') {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#555' });
  } else if (timerState.seconds != null) {
    updateBadge(remainingSeconds());
    scheduleThresholdAlarms(remainingSeconds());
  }
}
