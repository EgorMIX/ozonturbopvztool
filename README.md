# Ozon Turbo-PVZ Timer

Расширение Chrome (MV3) для `turbo-pvz.ozon.ru`:
- **Таймер приёмки** — оповещения на 30/15/5 минут до конца: голос, push, Telegram, ntfy.
- **Авто-пакеты** — на экране выдачи само заполняет количество пакетов M/L (фильтр размера, лимиты, статистика).

Создано с помощью Claude AI · Идея: EgorMIX.

## Установка
1. Открой `chrome://extensions`, включи «Режим разработчика».
2. «Загрузить распакованное» → выбери папку **`extension/`** (не корень репозитория).
3. После любых правок кода: кнопка ⟳ у расширения **и** обновить вкладку Ozon.

## Разработка в Claude Code
**В терминале** (на своём компьютере):
```bash
git clone https://github.com/EgorMIX/ozonturbopvztool.git
cd ozonturbopvztool
claude                     # Claude Code прочитает CLAUDE.md сам
```
**В браузере** (Claude Code on the web): открой <https://claude.ai/code>, выбери репозиторий
`EgorMIX/ozonturbopvztool` и опиши задачу. Claude работает в облаке на отдельной ветке; правки смотри в
изменениях сессии и оформляй Pull Request. Для приватного репозитория нужно приложение Claude в GitHub.

Проверить расширение в Chrome Claude не может — после его правок забери ветку к себе
(`git fetch && git checkout <ветка>`), нажми ⟳ у расширения на `chrome://extensions` и обнови вкладку Ozon.

Для начала можно дать, например:
- «Прочитай CLAUDE.md и docs/known-issues.md. Исправь п. 1 (service worker не ждёт загрузки состояния), и скажи, как мне это проверить в Chrome.»
- «Исправь п. 6: дубль обработчика `#bagsEnabled` и обращение к удалённому `#bagsStatus`; убери ключи из `scripts/known-issues.json`.»
- «Исправь перебор лимита пакетов (п. 5a).»

Команды (Node >= 18, зависимостей нет):
```bash
npm run check    # статическая проверка кода — после каждой правки
npm run pack     # проверка + dist/ozon-turbo-pvz-<версия>.zip
```

## Документы
- [`CLAUDE.md`](CLAUDE.md) — правила и контекст для Claude Code
- [`docs/architecture.md`](docs/architecture.md) — как всё устроено
- [`docs/known-issues.md`](docs/known-issues.md) — известные проблемы и план исправления
- [`docs/backend-idea.md`](docs/backend-idea.md) — идея серверного таймера (решение пока не принято)
- [`docs/fixtures/`](docs/fixtures/) — HTML-образцы страниц Ozon

## Секреты
Токен Telegram-бота, токен/топик ntfy и данные прокси хранятся только в `chrome.storage.local` (в интерфейсе
расширения) и в репозиторий не попадают.
