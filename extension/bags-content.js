// bags-content.js — Модуль «Авто-пакеты» v2.1
(function () {
  'use strict';

  const VERSION = '2.1';

  const TARGET_PATTERNS = [
    /\/orders\/session\/\d+\//,
    /\/orders\/session-new\/\d+/,
  ];

  let enabled   = true;
  let bagsSizes = 'both'; // 'M' | 'L' | 'both'
  let bagsQuota = { M: 0, L: 0 }; // 0 = без ограничения
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
  chrome.storage.local.get(['pvzSettings', 'bagsSessionStats'], (data) => {
    enabled      = data.pvzSettings?.bagsEnabled !== false;
    bagsSizes    = data.pvzSettings?.bagsSizes   || 'both';
    bagsQuota    = { M: data.pvzSettings?.bagsQuota?.M || 0, L: data.pvzSettings?.bagsQuota?.L || 0 };
    sessionStats = { M: data.bagsSessionStats?.M || 0, L: data.bagsSessionStats?.L || 0 };
    console.log(`[PVZ-Bags v${VERSION}] enabled=${enabled} sizes=${bagsSizes} quota=M:${bagsQuota.M} L:${bagsQuota.L} stats=M:${sessionStats.M} L:${sessionStats.L}`);
    init();
  });

  chrome.storage.onChanged.addListener((changes) => {
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
    if (!enabled || !isTargetPage()) return;
    stopObserving();
    startObserving();
    scheduleFill(400); // первый прогон — чуть позже чтобы DOM успел
  }

  // ─── SPA-навигация ────────────────────────────────────────────────────────

  let lastUrl = location.href;
  setInterval(() => {
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

  // Сколько ещё можно кликнуть по лимиту (pending — клики текущей серии, ещё не записанные в storage)
  function quotaLeft(label, pending) {
    const quota = bagsQuota[label] || 0;
    if (quota <= 0) return Infinity;
    return Math.max(quota - (sessionStats[label] || 0) - (pending[label] || 0), 0);
  }

  // Прибавляем клики серии к статистике: «прочитать → прибавить → записать» один раз в конце серии,
  // чтобы не затереть сброс из popup и клики из другой вкладки Ozon.
  async function addStats(pending) {
    if (!chrome.runtime?.id) return;
    const data = await chrome.storage.local.get('bagsSessionStats');
    const s = data.bagsSessionStats || {};
    sessionStats = { M: (s.M || 0) + (pending.M || 0), L: (s.L || 0) + (pending.L || 0) };
    await chrome.storage.local.set({ bagsSessionStats: { ...sessionStats, updatedAt: Date.now() } });
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function tryFill() {
    if (inFlight) { rerun = true; return; }
    if (!enabled || !isTargetPage()) return;

    const blocks = findPackageBlocks();
    if (blocks.length === 0) return;

    inFlight = true;
    rerun    = false;
    const pending = { M: 0, L: 0 };
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

        const clicks = Math.min(available - current, quotaLeft(label, pending));
        if (clicks <= 0) { filled[label] = available; continue; }

        console.log(`[PVZ-Bags v${VERSION}] ${label}: заполняем ${current} → ${current + clicks} из ${available} (+${clicks} кликов)`);
        filled[label] = available;

        for (let i = 0; i < clicks; i++) {
          if (i > 0) await sleep(150);
          // Перед каждым кликом — актуальное состояние: страница, input, лимит
          if (!enabled || !plusBtn.isConnected || plusBtn.disabled) break;
          if ((parseInt(input.value, 10) || 0) >= available) break;
          if (quotaLeft(label, pending) <= 0) break;
          plusBtn.click();
          pending[label]++;
        }
      }
    } finally {
      if (pending.M || pending.L) {
        try { await addStats(pending); }
        catch (e) { console.log(`[PVZ-Bags v${VERSION}] не удалось сохранить статистику: ${e?.message || e}`); }
      }
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
