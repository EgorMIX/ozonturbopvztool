// content.js — Ozon Turbo-PVZ Timer Monitor
(function () {
  'use strict';

  // ─── Whitelist URL-паттернов: только страницы приёмки ─────────────────────
  // Плагин работает ТОЛЬКО если текущий URL соответствует одному из паттернов.
  // Если нужно добавить URL — допишите в массив.
  const URL_WHITELIST = [
    // Основная страница приёмки Turbo-PVZ
    /turbo-pvz\.ozon\.ru\/receiving/,
    // Запасной вариант — seller с приёмкой (на случай редиректов)
    /seller\.ozon\.ru.*receiving/i,
    /seller\.ozon\.ru.*acceptance/i,
  ];

  function isAllowedPage() {
    const url = location.href;
    return URL_WHITELIST.some(rx => rx.test(url));
  }

  // ─── Состояние ────────────────────────────────────────────────────────────

  let lastFoundTimer  = null;
  let lastFoundEl     = null;   // для дебаг-подсветки
  let scanInterval    = null;
  let debugMode       = false;

  // ─── Парсинг времени ──────────────────────────────────────────────────────

  function parseTimeFromText(text) {
    if (!text) return null;
    text = text.trim();

    // HH:MM:SS — только если реалистичное время (не больше 24 ч)
    let m = text.match(/\b(\d{1,2}):(\d{2}):(\d{2})\b/);
    if (m) {
      const h = parseInt(m[1]), min = parseInt(m[2]), sec = parseInt(m[3]);
      if (h <= 23 && min <= 59 && sec <= 59) {
        const total = h * 3600 + min * 60 + sec;
        if (total > 0 && total <= 86400) return total;
      }
    }

    // MM:SS — только точное совпадение всей строки или изолированное число
    m = text.match(/^(\d{1,3}):(\d{2})$/);
    if (m) {
      const min = parseInt(m[1]), sec = parseInt(m[2]);
      if (min <= 999 && sec <= 59) {
        const total = min * 60 + sec;
        if (total > 0 && total <= 86400) return total;
      }
    }

    // "X ч Y мин Z сек" — только если есть хотя бы два компонента (защита от случайных чисел)
    const hasH   = /(\d+)\s*ч/.test(text);
    const hasMin = /(\d+)\s*мин/.test(text);
    const hasSec = /(\d+)\s*сек/.test(text);
    if ((hasH && hasMin) || (hasH && hasSec) || (hasMin && hasSec)) {
      let total = 0;
      const rH   = text.match(/(\d+)\s*ч/);
      const rMin = text.match(/(\d+)\s*мин/);
      const rSec = text.match(/(\d+)\s*сек/);
      if (rH)   total += parseInt(rH[1])   * 3600;
      if (rMin) total += parseInt(rMin[1]) * 60;
      if (rSec) total += parseInt(rSec[1]);
      if (total > 0 && total <= 86400) return total;
    }

    return null;
  }

  // ─── Приоритетные селекторы ───────────────────────────────────────────────
  // Расположены от самых специфичных к общим.
  // Как только найден один — остальные не проверяем.

  const PRIORITY_SELECTORS = [
    // Точный класс таймера Turbo-PVZ (подтверждён из реальной страницы)
    '[class*="_timer_"]',
    // data-testid с явным упоминанием таймера/приёмки
    '[data-testid*="timer"]',
    '[data-testid*="Timer"]',
    '[data-testid*="countdown"]',
    '[data-testid*="acceptance"]',
    '[data-testid*="receiving"]',
    // классы с явным "timer"/"countdown"
    '[class*="countdown"]',
    '[class*="Countdown"]',
    '[class*="timer"]',
    '[class*="Timer"]',
  ];

  // Ключевые слова в тексте рядом с таймером (в родителях до 3 уровней вверх)
  const CONTEXT_KEYWORDS = [
    /приём/i, /прием/i, /приёмк/i,
    /acceptance/i, /receiving/i, /reception/i,
    /turbo.?pvz/i, /pvz/i,
    /поставк/i, /supply/i,
    /отгрузк/i, /shipment/i,
    /таймер/i, /timer/i, /countdown/i,
    /осталось/i, /remaining/i,
    /до конца/i, /time left/i,
  ];

  function hasRelevantContext(el) {
    // Проверяем сам элемент и 4 уровня вверх
    let node = el;
    for (let i = 0; i < 4; i++) {
      if (!node) break;
      const text = (node.textContent || '').slice(0, 300);
      const cls  = (node.className || '').toString();
      const tid  = node.getAttribute?.('data-testid') || '';
      const combined = `${text} ${cls} ${tid}`;
      if (CONTEXT_KEYWORDS.some(rx => rx.test(combined))) return true;
      node = node.parentElement;
    }
    return false;
  }

  // ─── Поиск таймера ────────────────────────────────────────────────────────

  function findTimerElement() {
    // Шаг 1: приоритетные селекторы
    // На разрешённой странице (turbo-pvz.ozon.ru/receiving-v2) таймер _timer_ не требует
    // проверки контекста — мы уже знаем что это страница приёмки
    const timerOnlySelectors = ['[class*="_timer_"]'];
    for (const sel of timerOnlySelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const txt     = (el.innerText || el.textContent || '').trim();
        const seconds = parseTimeFromText(txt);
        if (seconds !== null) {
          return { element: el, seconds, matchedBy: `exact: ${sel}`, text: txt };
        }
      }
    }

    // Шаг 2: остальные селекторы с проверкой контекста
    for (const sel of PRIORITY_SELECTORS) {
      if (timerOnlySelectors.includes(sel)) continue;
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const txt     = (el.innerText || el.textContent || '').trim();
        const seconds = parseTimeFromText(txt);
        if (seconds !== null && hasRelevantContext(el)) {
          return { element: el, seconds, matchedBy: `selector: ${sel}`, text: txt };
        }
      }
    }

    // Шаг 2: ищем любой маленький элемент с текстом-таймером + релевантным контекстом
    const candidates = document.querySelectorAll('span, b, strong, div, p, time');
    for (const el of candidates) {
      // Пропускаем скрытые элементы
      // Примечание: offsetParent=null у fixed/sticky элементов — добавляем проверку через getBoundingClientRect
      if (!el.offsetParent) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;  // реально скрыт
      }
      const txt = (el.innerText || el.textContent || '').trim();
      // Текст должен быть коротким — только сам таймер, без лишнего
      if (txt.length > 40) continue;
      const seconds = parseTimeFromText(txt);
      if (seconds === null) continue;
      if (!hasRelevantContext(el)) continue;
      return { element: el, seconds, matchedBy: 'context search', text: txt };
    }

    return null;
  }

  // ─── Дебаг-подсветка ──────────────────────────────────────────────────────

  function highlightElement(el) {
    if (!debugMode) return;
    // Снимаем предыдущую подсветку
    if (lastFoundEl && lastFoundEl !== el) {
      lastFoundEl.style.removeProperty('outline');
      lastFoundEl.style.removeProperty('background');
    }
    if (el) {
      el.style.outline   = '2px solid #ff5722';
      el.style.background = 'rgba(255,87,34,0.15)';
      lastFoundEl = el;
    }
  }

  function removeHighlight() {
    if (lastFoundEl) {
      lastFoundEl.style.removeProperty('outline');
      lastFoundEl.style.removeProperty('background');
      lastFoundEl = null;
    }
  }

  // ─── Отправка в background ────────────────────────────────────────────────

  function sendTimerToBackground(seconds, debugInfo) {
    // Проверяем что контекст расширения ещё валиден
    // (становится невалидным при обновлении расширения без перезагрузки страницы)
    if (!chrome.runtime?.id) {
      // Контекст инвалидирован — останавливаем сканирование
      if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
      return;
    }
    chrome.runtime.sendMessage({
      type:     'TIMER_FOUND',
      seconds,
      url:      location.href,
      title:    document.title,
      debugInfo,
    }).catch((e) => {
      // Extension context invalidated — расширение обновилось, останавливаем интервал
      if (e?.message?.includes('Extension context invalidated') || !chrome.runtime?.id) {
        if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
      }
    });
  }

  // ─── Сканирование ─────────────────────────────────────────────────────────

  function scan() {
    if (!isAllowedPage()) {
      // Страница не в whitelist — молча игнорируем
      if (lastFoundTimer !== null) {
        lastFoundTimer = null;
        removeHighlight();
        if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'TIMER_LOST' }).catch(() => {});
      }
      return;
    }

    const result = findTimerElement();

    if (result) {
      const { seconds, element, matchedBy, text } = result;
      highlightElement(element);

      if (lastFoundTimer === null || Math.abs(lastFoundTimer - seconds) > 5) {
        lastFoundTimer = seconds;
        const info = `«${text}» [${matchedBy}] xpath: ${getSimplePath(element)}`;
        sendTimerToBackground(seconds, info);
      }
    } else {
      removeHighlight();
      if (lastFoundTimer !== null) {
        lastFoundTimer = null;
        if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'TIMER_LOST' }).catch(() => {});
      }
    }
  }

  // Упрощённый путь к элементу для дебага
  function getSimplePath(el) {
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node && node !== document.body; i++) {
      const tag = node.tagName?.toLowerCase() || '?';
      const cls = node.className ? `.${String(node.className).trim().split(/\s+/).slice(0,2).join('.')}` : '';
      const tid = node.getAttribute?.('data-testid') ? `[data-testid="${node.getAttribute('data-testid')}"]` : '';
      parts.unshift(`${tag}${cls}${tid}`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // ─── Запуск ───────────────────────────────────────────────────────────────

  setTimeout(() => {
    scan();
    scanInterval = setInterval(scan, 10_000);
  }, 2000);

  // SPA-навигация
  let lastHref = location.href;
  new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastFoundTimer = null;
      removeHighlight();
      // Сбрасываем старый интервал чтобы не накапливать при каждом переходе
      if (scanInterval) {
        clearInterval(scanInterval);
        scanInterval = null;
      }
      setTimeout(() => {
        scan();
        scanInterval = setInterval(scan, 10_000);
      }, 2000);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Сообщения от popup/background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TIMER_STATUS') {
      if (!isAllowedPage()) { sendResponse({ seconds: null, reason: 'page_not_whitelisted', url: location.href }); return; }
      const result = findTimerElement();
      sendResponse(result
        ? { seconds: result.seconds, text: result.text, matchedBy: result.matchedBy }
        : { seconds: null }
      );
    }
    if (msg.type === 'SET_DEBUG_MODE') {
      debugMode = msg.enabled;
      if (!debugMode) removeHighlight();
      sendResponse({ ok: true });
    }
    if (msg.type === 'GET_PAGE_INFO') {
      sendResponse({
        url:         location.href,
        allowed:     isAllowedPage(),
        title:       document.title,
        timerFound:  lastFoundTimer !== null,
        seconds:     lastFoundTimer,
      });
    }
  });
})();
