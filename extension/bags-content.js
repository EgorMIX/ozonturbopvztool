// bags-content.js — Модуль «Авто-пакеты» v2.2
(function () {
  'use strict';

  const VERSION = '2.2';

  const TARGET_PATTERNS = [
    /\/orders\/session\/\d+\//,
    /\/orders\/session-new\/\d+/,
  ];

  let enabled   = true;
  let bagsSizes = 'both'; // 'M' | 'L' | 'both'
  let bagsQuota = { M: 0, L: 0 }; // 0 = без ограничения
  let mode = 'active';
  let observer  = null;
  let fillTimer = null;

  // Запоминаем сколько уже кликнули для каждого типа пакета
  // { 'M': 2, 'L': 1 } — чтобы не кликать повторно если available не изменился
  const filled = {};
  // Копия bagsSessionStats из storage (обновляется через onChanged — сброс в popup, другие вкладки)
  let sessionStats = { M: 0, L: 0 };
  let inFlight     = false; // идёт серия кликов — второй tryFill не запускаем
  let rerun        = false; // DOM менялся во время серии — после неё прогнать ещё раз

  // ─── Загрузка настройки ───────────────────────────────────────────────────

  // Читаем и настройки, и накопленную статистику из storage одним запросом
  chrome.storage.local.get(['pvzSettings', 'bagsSessionStats', 'modeState'], (data) => {
    mode = data.modeState?.mode || 'active';
    enabled      = data.pvzSettings?.bagsEnabled !== false;
    bagsSizes    = data.pvzSettings?.bagsSizes   || 'both';
    bagsQuota    = { M: data.pvzSettings?.bagsQuota?.M || 0, L: data.pvzSettings?.bagsQuota?.L || 0 };
    sessionStats = { M: data.bagsSessionStats?.M || 0, L: data.bagsSessionStats?.L || 0 };
    console.log(`[PVZ-Bags v${VERSION}] enabled=${enabled} sizes=${bagsSizes} quota=M:${bagsQuota.M} L:${bagsQuota.L} stats=M:${sessionStats.M} L:${sessionStats.L}`);
    init();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!chrome.runtime?.id) { stopObserving(); return; }
    if (changes.modeState) {
      mode = changes.modeState.newValue?.mode || 'active';
      mode === 'disabled' ? stopObserving() : init();
    }
    if (changes.bagsSessionStats) {
      const s = changes.bagsSessionStats.newValue || {};
      const wasLower = (s.M || 0) < sessionStats.M || (s.L || 0) < sessionStats.L;
      sessionStats = { M: s.M || 0, L: s.L || 0 };
      // Сброс статистики освобождает лимит — снова начинаем наблюдать
      if (wasLower && enabled) {
        console.log(`[PVZ-Bags v${VERSION}] статистика сброшена → M:${sessionStats.M} L:${sessionStats.L}`);
        init();
      }
    }
    if (changes.pvzSettings?.newValue) {
      const newVal     = changes.pvzSettings.newValue;
      const next       = newVal.bagsEnabled !== false;
      const nextSizes  = newVal.bagsSizes || 'both';
      const nextQuotaM = newVal.bagsQuota?.M || 0;
      const nextQuotaL = newVal.bagsQuota?.L || 0;
      const quotaChanged = nextQuotaM !== bagsQuota.M || nextQuotaL !== bagsQuota.L;
      bagsQuota = { M: nextQuotaM, L: nextQuotaL };
      if (next !== enabled || nextSizes !== bagsSizes) {
        enabled   = next;
        bagsSizes = nextSizes;
        console.log(`[PVZ-Bags v${VERSION}] авто-пакеты → ${enabled ? 'вкл' : 'выкл'} sizes=${bagsSizes} quota=M:${bagsQuota.M} L:${bagsQuota.L}`);
        Object.keys(filled).forEach(k => delete filled[k]);
        enabled ? init() : stopObserving();
      } else if (quotaChanged && enabled) {
        // Лимит изменён — наблюдатель мог быть остановлен по достижении старого лимита
        console.log(`[PVZ-Bags v${VERSION}] лимит → M:${bagsQuota.M} L:${bagsQuota.L}`);
        init();
      }
    }
  });

  // ─── Инициализация ────────────────────────────────────────────────────────

  function isTargetPage() {
    return TARGET_PATTERNS.some(p => p.test(location.pathname));
  }

  function init() {
    if (!enabled || mode === 'disabled' || !chrome.runtime?.id || !isTargetPage()) return;
    stopObserving();
    startObserving();
    scheduleFill(400); // первый прогон — чуть позже чтобы DOM успел
  }

  // ─── SPA-навигация ────────────────────────────────────────────────────────

  let lastUrl = location.href;
  setInterval(() => {
    if (!chrome.runtime?.id) { stopObserving(); return; }
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    Object.keys(filled).forEach(k => delete filled[k]);
    console.log(`[PVZ-Bags v${VERSION}] навигация → ${location.pathname}`);
    isTargetPage() ? init() : stopObserving();
  }, 300);

  // ─── Observer ─────────────────────────────────────────────────────────────

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(() => scheduleFill(200));
    observer.observe(document.body, { childList: true, subtree: true });
    console.log(`[PVZ-Bags v${VERSION}] observer запущен`);
  }

  function stopObserving() {
    if (observer) { observer.disconnect(); observer = null; }
    clearTimeout(fillTimer);
  }

  function scheduleFill(delay = 200) {
    clearTimeout(fillTimer);
    fillTimer = setTimeout(tryFill, delay);
  }

  // ─── Поиск блоков пакетов ────────────────────────────────────────────────

  function findPackageBlocks() {
    const blocks = [];

    // Ищем все текстовые элементы с упоминанием пакетов
    const allEls = document.querySelectorAll(
      '[class*="paragraph-large"], [class*="paragraph_large"]'
    );

    for (const el of allEls) {
      const text  = el.textContent?.trim() || '';

      // Поддерживаем форматы:
      // "Пакет M • доступно 2"  (новый)
      // "M • доступно 2"        (старый)
      const match = text.match(/(?:Пакет\s+)?([ML])\s*[•·•]\s*доступно\s+(\d+)/i);
      if (!match) continue;

      const label     = match[1].toUpperCase();
      const available = parseInt(match[2], 10);
      if (!available || available <= 0) continue;

      // Ключевой фикс: ищем кнопку и input в прямом родителе элемента с текстом,
      // а не через closest() который поднимается слишком высоко
      // Структура HTML:
      //   <div>                          ← el.parentElement (container)
      //     <div class="paragraph-large">Пакет M • доступно 2</div>  ← el
      //     <div class="ozi__input__root__...">
      //       <input inputmode="decimal">
      //       <button class="...increment...">+</button>
      //     </div>
      //   </div>

      const container = el.parentElement;
      if (!container) continue;

      const plusBtn = container.querySelector('[class*="increment"]');
      const input   = container.querySelector('input[inputmode="decimal"]');

      if (!plusBtn || !input) {
        console.log(`[PVZ-Bags v${VERSION}] ${label}: нет input/plusBtn в`, container);
        continue;
      }

      blocks.push({ label, available, plusBtn, input });
      console.log(`[PVZ-Bags v${VERSION}] найден блок: ${label}, available=${available}, current=${input.value}`);
    }

    return blocks;
  }

  // ─── Заполнение ───────────────────────────────────────────────────────────

  function shouldFill(label) {
    // Проверяем фильтр по размеру
    if (bagsSizes === 'M' && label !== 'M') return false;
    if (bagsSizes === 'L' && label !== 'L') return false;

    // Проверяем квоту — если лимит задан и достигнут, не заполняем
    const quota = bagsQuota[label] || 0;
    if (quota > 0 && sessionStats[label] >= quota) {
      console.log(`[PVZ-Bags v${VERSION}] ${label}: лимит достигнут (${sessionStats[label]}/${quota})`);
      return false;
    }

    return true;
  }

  // Проверяем достигнуты ли все активные лимиты
  function checkAllLimitsDone() {
    const sizesToCheck = bagsSizes === 'both' ? ['M', 'L']
                       : bagsSizes === 'M'    ? ['M']
                       :                        ['L'];
    return sizesToCheck.every(label => {
      const quota = bagsQuota[label] || 0;
      return quota > 0 && sessionStats[label] >= quota;
    });
  }

  async function sendBag(message) {
    if (!chrome.runtime?.id) return { ok: false };
    try { return await chrome.runtime.sendMessage(message) || { ok: false }; }
    catch (_) { stopObserving(); return { ok: false }; }
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function tryFill() {
    if (inFlight) { rerun = true; return; }
    if (!enabled || mode === 'disabled' || !chrome.runtime?.id || !isTargetPage()) return;
    const startedUrl = location.href;

    const blocks = findPackageBlocks();
    if (blocks.length === 0) return;

    inFlight = true;
    rerun    = false;
    try {
      for (const { label, available, plusBtn, input } of blocks) {
        // Пропускаем размер который не нужно заполнять
        if (!shouldFill(label)) {
          console.log(`[PVZ-Bags v${VERSION}] ${label}: пропущен (sizes=${bagsSizes})`);
          continue;
        }

        const current = parseInt(input.value, 10) || 0;

        // Уже заполнено до этого уровня — пропускаем
        if (filled[label] >= available && current >= available) continue;

        const clicks = available - current;
        if (clicks <= 0) { filled[label] = available; continue; }

        console.log(`[PVZ-Bags v${VERSION}] ${label}: заполняем ${current} → ${current + clicks} из ${available} (+${clicks} кликов)`);
        filled[label] = available;

        for (let i = 0; i < clicks; i++) {
          if (i > 0) await sleep(150);
          // Перед каждым кликом — актуальное состояние: страница, input, лимит
          if (!enabled || mode === 'disabled' || location.href !== startedUrl || !plusBtn.isConnected || plusBtn.disabled || !shouldFill(label)) break;
          if ((parseInt(input.value, 10) || 0) >= available) break;
          const reserve = await sendBag({ type: 'BAGS_RESERVE', label });
          if (!reserve.ok) break;
          let added = false;
          try {
            if (!enabled || mode === 'disabled' || location.href !== startedUrl || !plusBtn.isConnected || plusBtn.disabled || !shouldFill(label)) break;
            const before = parseInt(input.value, 10) || 0;
            if (before >= available) break;
            plusBtn.click();
            // Считаем подтверждённое изменение поля, а не попытку нажатия.
            for (let wait = 0; wait < 20; wait++) {
              if ((parseInt(input.value, 10) || 0) > before) { added = true; break; }
              if (!input.isConnected || location.href !== startedUrl) break;
              await sleep(50);
            }
          } finally {
            await sendBag({ type: 'BAGS_COMMIT', token: reserve.token, added });
          }
          if (!added) break;
        }
      }
    } finally {
      inFlight = false;
    }

    if (checkAllLimitsDone()) {
      console.log(`[PVZ-Bags v${VERSION}] Все лимиты достигнуты — авто-пакеты остановлены`);
      stopObserving();
    } else if (rerun) {
      scheduleFill(200);
    }
  }

})();
