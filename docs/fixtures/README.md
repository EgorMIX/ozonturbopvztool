# Образцы страниц Ozon (фикстуры)

Нужны, чтобы менять селекторы и парсинг **не вслепую**: Ozon выкатывает релизы, и хэшированные
CSS-классы (`_timer_hamc7_24`, `ozi__input__root__L1Lw-`) меняются. Когда плагин «перестал находить»
таймер или пакеты, первым делом сравни свежий HTML со старой фикстурой.

| Файл | Страница | Чем пользуется код |
|---|---|---|
| `receiving-timer.html` | `https://turbo-pvz.ozon.ru/receiving-v2/main` | `content.js`: `findTimerElement()`, `parseTimeFromText()` |
| `issue-bags-block.html` | `https://turbo-pvz.ozon.ru/orders/session-new/<id>` (экран выдачи, блок «Пакет M/L • доступно N») | `bags-content.js`: `findPackageBlocks()` |
| `carriages-widget.html` | `https://turbo-pvz.ozon.ru/receiving-v2/main`, виджет «Перевозки» (номер, откуда, статус, «Отправления N из M»; номер и хаб заменены) | `content.js`: `findCarriages()` |

Что важно в `issue-bags-block.html`:
- подпись — `div` с классом, содержащим `paragraph-large`, текст `Пакет M • доступно 2` (разделитель — `•`);
- её **родитель** (`el.parentElement`) содержит и поле `input[inputmode="decimal"]`, и кнопку `+`
  (`[class*="increment"]`; рядом `[class*="decrement"]`, она `disabled` при нуле).
  Подниматься через `closest()` нельзя — захватит соседний блок (так была сломана версия v1.0).

## Как обновлять фикстуру
1. На нужной странице Ozon: DevTools → Elements → правый клик по нужному блоку → Copy → Copy outerHTML.
2. **Перед сохранением вырежь всё личное**: имена и телефоны клиентов, номера заказов, токены.
   В HTML-фрагментах их обычно нет, а вот в логах консоли попадаются адреса WebSocket с параметром
   `access_token` (JWT сессии Ozon) — такие строки в репозиторий не класть. `npm run check` ищет типичные
   паттерны токенов, но не заменяет внимательности.
3. Положи файл сюда, добавь строку в таблицу выше.
