# Архитектура

## Компоненты

```
 Вкладка https://turbo-pvz.ozon.ru/*                          Service worker (background.js)
 ┌───────────────────────────────────────┐   TIMER_FOUND / TIMER_LOST    ┌───────────────────────────────┐
 │ content.js  — ищет таймер, шлёт секунды├──────────────────────────────▶│ timerState, modeState, settings│
 │ speech.js   — озвучка (SPEAK)          │◀───────── SPEAK ──────────────┤ chrome.alarms  (пороги, бейдж) │
 │ bags-content.js — жмёт «+» у пакетов   │                               │ chrome.notifications (push)    │
 └──────────────┬────────────────────────┘                               │ fetch → Telegram / ntfy        │
                │ читает pvzSettings, пишет bagsSessionStats             └───────────────▲───────────────┘
                ▼                                                                         │ GET_STATE, SET_MODE,
         chrome.storage.local  ◀─────────────────────────────────────────────────────────┤ SETTINGS_UPDATED,
                ▲                                                                         │ TIMER_MANUAL, DEBUG_*
                └───────────────────────────  popup.html / popup.js  ─────────────────────┘
```

| Файл | Роль |
|---|---|
| `manifest.json` | MV3, 1.6.0, Chrome ≥ 108. Content-скрипты (`content.js`+`speech.js`, отдельно `bags-content.js`) — только на `*://turbo-pvz.ozon.ru/*`, `document_idle`. `host_permissions`: `turbo-pvz.ozon.ru`, `api.telegram.org`, `ntfy.sh`. Открытых ресурсов (`web_accessible_resources`) нет. |
| `background.js` | Service worker: состояние таймера, алармы порогов, бейдж, push, голос (через вкладку), Telegram, ntfy, прокси (PAC только для `api.telegram.org`, логин HTTP-прокси через `webRequest.onAuthRequired`), режимы (active / paused / disabled), журнал событий (в памяти, ≤120 записей). |
| `content.js` | Находит таймер на странице приёмки (`/receiving…`), раз в 10 с шлёт секунды в SW. Следит за SPA-навигацией. |
| `speech.js` | Слушает `SPEAK`, говорит через `speechSynthesis` (ru-RU, rate 0.95). Если скрипта во вкладке нет — SW подставляет ту же функцию через `scripting.executeScript`. |
| `bags-content.js` | Модуль «Авто-пакеты» (v2.1): на странице выдачи сам нажимает «+» у пакетов M/L; фильтр размера, лимиты, накопительная статистика. |
| `popup.html` / `popup.js` | Интерфейс: вкладки «Таймер» и «Пакеты», настройки, тесты каналов, отладка, журнал. Футер с подписью «Создано с помощью Claude AI · Идея: EgorMIX» — оставлять. |

## Поток таймера
1. `content.js` через 2 с после загрузки и затем каждые 10 с вызывает `scan()`: если URL подходит под
   `URL_WHITELIST` (сейчас фактически `turbo-pvz.ozon.ru/receiving…`), ищет элемент таймера и парсит секунды
   (`HH:MM:SS`, строго `MM:SS`, «X ч Y мин Z сек»; максимум 24 ч).
2. Если значение отличается от последнего отправленного больше чем на 5 с — `TIMER_FOUND {seconds, url, title, debugInfo}`.
   Элемент пропал → `TIMER_LOST` (SW не стирает приёмку сразу — см. п. 3). При SPA-навигации интервал пересоздаётся, `TIMER_LOST` при этом **не** шлётся
   (таймер в SW продолжает идти по экстраполяции).
3. `background.js` кладёт `timerState = {seconds, updatedAt, endsAt, …}`. **Сессия приёмки** = абсолютное время
   окончания `endsAt = now + seconds·1000`: новое чтение с `endsAt` в пределах ±90 с — та же приёмка (пороги и «Приёмка
   начата» не повторяются), иначе новая (сброс `firedFor`/`startNotified`). Остаток — `remainingSeconds()` =
   `(endsAt − now)/1000`. `TIMER_LOST` только ставит `lostAt` и аларм `timer_lost_grace` (2 мин); если за это время
   таймер не вернулся — `endSession()` снимает алармы порогов и бейдж.
   **Крайний срок** = `endsAt − finishMarginMin` (по умолчанию 1 мин): штрафа нет, если приёмку программно завершили
   до него, дальше принимают излишками. Все пороги считаются **до крайнего срока** (`deadlineSeconds()`): аларм
   `threshold_<мин>_<idx>` на момент «до крайнего срока − порог», пройденный — срабатывает сразу; в сам крайний срок —
   аларм `deadline_reached` → `fireDeadline()` (один раз, флаг `deadlineNotified`). Бейдж и popup показывают время до
   крайнего срока, после него — «!» / «СЕЙЧАС».
4. `fireThreshold()` (один раз на порог за сессию, см. `firedFor`) → push (`requireInteraction` при ≤5 мин),
   голос, Telegram, ntfy — в зависимости от `notifType` и включённых каналов.
5. Отдельно, один раз на «сессию», — уведомление «Приёмка начата» (`notifyTimerStarted`) с временем «завершить до».
   Оповещения не отправляются в паузе и вне рабочих часов (`quietReason()`, `isWorkTime()`): порог при этом
   помечается отработанным, чтобы потом не прийти устаревшим.
7. **История:** `startSession()` заводит запись в `acceptanceHistory`, `endSession()` / новая сессия закрывают её
   (`historyFinish()`). Итог по `lostAt` (момент, когда таймер пропал со страницы приёмки = приёмку завершили):
   `onTime` ≤ крайнего срока, `late` — позже, но до конца таймера, `expired` — таймер дошёл до нуля на открытой вкладке,
   `cleared` — кнопка «Сбросить», `unknown` — вкладка была закрыта/заморожена или ручной таймер.
6. Каждые ~10 с `badge_tick` обновляет бейдж: зелёный (>30 мин), оранжевый (≤30), красный (≤5), «OFF» в режиме disabled.

Режимы: `active` — всё работает; `paused` — уведомления подавляются до `pauseUntil` (аларм `pause_end`);
`disabled` — бейдж «OFF», алармы порогов снимаются.

## Поток «Авто-пакеты»
- Работает на `/orders/session/<id>/…` и `/orders/session-new/<id>` (новый единый экран выдачи).
- Находит подписи вида «Пакет M • доступно 2» (`[class*="paragraph-large"]`, regex
  `(?:Пакет\s+)?([ML])\s*[•·]\s*доступно\s+(\d+)`), берёт **родителя** подписи и в нём `input[inputmode="decimal"]`
  и `[class*="increment"]`, кликает «+» с шагом 150 мс до `доступно`, но не больше остатка лимита. Одна серия за раз (`inFlight`); перед каждым
  кликом проверяются input и лимит; статистика пишется в storage один раз в конце серии («прочитать → прибавить → записать»).
- Настройки: `pvzSettings.bagsEnabled`, `bagsSizes` (`M`/`L`/`both`), `bagsQuota {M, L}` (0 = без лимита).
  Счётчик выданных — `bagsSessionStats {M, L, updatedAt}`; когда лимиты по всем выбранным размерам выполнены,
  наблюдатель останавливается; сброс статистики (кнопка в popup) или изменение лимита запускает его снова
  (`storage.onChanged`). Сохранение на вкладке «Пакеты» **не** шлёт `SETTINGS_UPDATED`.
- Навигация (SPA) отслеживается опросом `location.href` раз в 300 мс + `MutationObserver` с дебаунсом 200 мс.

## Сообщения (`chrome.runtime.sendMessage` / `tabs.sendMessage`)

| type | откуда → куда | payload | ответ |
|---|---|---|---|
| `TIMER_FOUND` | content → bg | `{seconds, url, title, debugInfo}` | `{ok}` |
| `TIMER_LOST` | content → bg | — (таймер пропал; приёмка завершится через 2 мин) | `{ok}` |
| `TIMER_CLEAR` | popup → bg | — (кнопка «Сбросить»: завершить приёмку сразу) | `{ok}` |
| `CARRIAGES_UPDATE` | content → bg | `{items: [{number, source, status, accepted, total}]}` — виджет «Перевозки» на странице приёмки, при изменении | `{ok}` |
| `CHECK_UPDATE` | popup → bg | — (кнопка «Проверить сейчас») | `{ok, current, latest?, newer?, url?, reason?}` |
| `TIMER_MANUAL` | popup → bg | `{seconds}` | `{ok}` |
| `GET_STATE` | popup → bg | — | `{timerState, settings, modeState}` |
| `GET_LOG` | popup → bg | — | `{log: [{text, type}]}` |
| `SET_MODE` | popup → bg | `{mode, pauseMinutes}` | `{ok, modeState}` |
| `SETTINGS_UPDATED` | popup → bg | `{settings}` (весь объект) | `{ok}` |
| `DEBUG_TEST_NOTIF` / `DEBUG_TEST_SPEECH` | popup → bg | `{minutes}` | `{ok}` |
| `DEBUG_TEST_TELEGRAM` | popup → bg | `{botToken, chatId, text?}` | `{ok, reason?}` |
| `DEBUG_TEST_NTFY` | popup → bg | `{ntfy: {...}, text?}` | `{ok, reason?}` |
| `DEBUG_TEST_PROXY` | popup → bg | `{proxy, botToken}` | `{ok, botName?, reason?}` |
| `DEBUG_SIM_TIMER` / `DEBUG_CLEAR_ALARMS` / `DEBUG_RESET` | popup → bg | `{seconds?}` / — / — | `{ok}` |
| `SPEAK` | bg → вкладка (speech.js) | `{text, volume}` | — |
| `GET_PAGE_INFO` | popup → вкладка (content.js) | — | `{url, allowed, title, timerFound, seconds}` |

Новое сообщение = ветка в `background.js` (`chrome.runtime.onMessage`, цепочка `if / else if`) **и** отправитель.
Отправителя проверяет `isAllowedSender()`: страницы расширения (popup — и окном, и во вкладке) определяются по адресу
`chrome-extension://<id>/…` и могут всё; от вкладок `https://turbo-pvz.ozon.ru/` принимаются только `CONTENT_MSG_TYPES`
(`TIMER_FOUND`, `TIMER_LOST`). Новое сообщение от content-скрипта
нужно добавить в `CONTENT_MSG_TYPES`, иначе оно получит `{ok:false, reason:'forbidden'}`.
`npm run check` ругается, если тип отправляется, но не обрабатывается, или обрабатывается в двух ветках.

## `chrome.storage.local`

| Ключ | Кто пишет | Содержимое |
|---|---|---|
| `pvzSettings` | popup | `thresholds [{minutes, text, volume, enabled}]` (по умолчанию 30/15/5), `notifType` (`both`/`push`/`voice`; из него SW выводит `speechEnabled`/`notifEnabled`), `theme`, `telegram {enabled, botToken, chatId}`, `ntfy {enabled, topic, server, token, priority}`, `proxy {enabled, type, host, port, username, password}`, `bagsEnabled`, `bagsSizes`, `bagsQuota {M, L}`, `finishMarginMin` (запас до конца таймера, мин), `workHours {enabled, from, to, days}`, `updateCheck` |
| `timerState` | bg | `{seconds, updatedAt, endsAt, lostAt, url, title, firedFor [минуты], isManual, startNotified, sessionId, source, deadlineNotified}` |
| `modeState` | bg | `{mode, pauseUntil}` |
| `bagsSessionStats` | bags-content, popup (сброс) | `{M, L, updatedAt}` |
| `acceptanceHistory` | bg (popup — показ, CSV, очистка) | `[{id, startedAt, endsAt, deadlineAt, marginMin, source: auto/manual/debug, finishedAt, result, firedFor}]`, не больше 300 |
| `carriagesState` | bg | `{items, seenAt}` — последнее, что прислал виджет «Перевозки» (для привязки к приёмке, начатой позже) |
| `updateInfo` | bg | `{checkedAt, latest, url, current, newer, notifiedFor}` — последняя проверка релиза на GitHub |

Значения по умолчанию заведены **в двух местах** (`background.js` `DEFAULT_SETTINGS` и `popup.js` `settings`) — при
добавлении настройки правь оба. Секреты (токен бота, токен/топик ntfy, логин прокси) лежат только здесь.

## Алармы (`chrome.alarms`)
`badge_tick` (периодический), `pause_end` (разовый), `threshold_<мин>_<idx>` (разовые, пересоздаются при каждом
новом/изменённом таймере), `deadline_reached` (разовый: крайний срок завершения), `timer_lost_grace` (разовый: таймер
пропал со страницы — через 2 мин завершить приёмку), `update_check` (раз в сутки: новый релиз на GitHub через
`api.github.com` — CORS открыт, права на хост не нужны; пока репозиторий приватный, ответ 404 и проверка молчит).

## Страницы и DOM Ozon
- Приёмка: `https://turbo-pvz.ozon.ru/receiving-v2/main`, таймер — `div` с классом `_timer_<хэш> ozi-heading-300`,
  текст `04:50:44` (`docs/fixtures/receiving-timer.html`).
- Выдача: `https://turbo-pvz.ozon.ru/orders/session-new/<id>` (раньше `/orders/session/<id>/…`); блок пакетов —
  `docs/fixtures/issue-bags-block.html`.
- Фронтенд Ozon — SPA (Nuxt/Vue), классы хэшированы и меняются при релизах: опираться на стабильные фрагменты
  (`_timer_`, `paragraph-large`, `increment`, `inputmode="decimal"`) и на текст.
- Вкладки Ozon в фоне замораживаются Chrome / уходят в bfcache — таймеры страницы не тикают.

## Подводные камни платформы (выучено на практике)
- **Service worker эфемерный** (~30 с простоя): переменные теряются, state надо грузить из storage и
  дожидаться до обработки событий. В `background.js` это промис `ready`: `onAlarm` и `onButtonClicked` начинаются
  с `await ready`, `onMessage` вызывает `handleMessage` через `ready.then(...)` и всегда возвращает `true`.
- **Content-скрипт «осиротевает»** после перезагрузки расширения: вкладка держит старую копию →
  `Extension context invalidated`. Везде, где content-скрипт зовёт `chrome.*`, проверяем `chrome.runtime?.id`.
  Разработчику: после ⟳ расширения всегда обновлять и вкладку Ozon.
- **Заголовки HTTP — только ISO-8859-1.** Кириллица/эмодзи в заголовке (например, `Title` у ntfy) → ошибка
  `non ISO-8859-1 code point`, а `encodeURIComponent` приходит на телефон «%D0…». Поэтому ntfy шлётся
  JSON-API: `POST <server>` с телом `{topic, message, title, priority, tags}`.
- **Telegram** слать с `parse_mode: 'Markdown'` рискованно (спецсимволы в тексте порога); API Telegram в части сетей
  недоступен или тормозит — отсюда идея прокси и серверного таймера.
- **`return true` из `onMessage`** нужен только для асинхронного `sendResponse`.
