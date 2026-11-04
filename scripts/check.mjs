#!/usr/bin/env node
// scripts/check.mjs — статическая проверка расширения. Без зависимостей, Node >= 18.
//
//   node scripts/check.mjs [папка-расширения] [--strict]
//
// По умолчанию проверяет ../extension. Код возврата 1 — если есть НОВЫЕ ошибки.
// «Известные» проблемы перечислены в scripts/known-issues.json (описаны в docs/known-issues.md):
// они печатаются, но не валят проверку. Флаг --strict этот список игнорирует.
// Исправил проблему — удали её ключ из known-issues.json (скрипт подскажет, какие ключи устарели).
//
// Зачем это всё: раньше при правках «вслепую» размножались блоки кода (4 копии секции ntfy в popup.html,
// дубли sendNtfy и обработчиков сообщений). Эти проверки ловят такие вещи сразу, без запуска Chrome.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Использование: node scripts/check.mjs [папка-расширения] [--strict]');
  process.exit(0);
}
const strict = args.includes('--strict');
const explicitDir = args.find((a) => !a.startsWith('--'));
const extDir = resolve(explicitDir ?? join(here, '..', 'extension'));
const baselinePath = join(here, 'known-issues.json');

if (!existsSync(extDir) || !statSync(extDir).isDirectory()) {
  console.error(`Нет такой папки: ${extDir}`);
  process.exit(2);
}

// ─── Утилиты ────────────────────────────────────────────────────────────────

const findings = []; // { level: 'error' | 'warn', key, msg }
const add = (level, key, msg) => {
  if (!findings.some((f) => f.key === key)) findings.push({ level, key, msg });
};

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const relExt = (p) => relative(extDir, p).split(sep).join('/');
const readIf = (name) => {
  const p = join(extDir, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const lineOf = (text, idx) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};
const shortHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const countBy = (items) => {
  const m = new Map();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
};

// Повторяющиеся большие блоки (следы «дописывания в конец»): окно из 10 подряд идущих строк
// (не меньше 250 значимых символов), которое встречается в файле дважды без пересечения.
function checkDupBlocks(name, src) {
  const t = src.split('\n').map((l) => l.trim());
  const N = 10;
  const firstSeen = new Map();
  const runs = [];
  let run = null;
  for (let i = 0; i + N <= t.length; i++) {
    const win = t.slice(i, i + N);
    const key = win.join('\n');
    let dupOf = -1;
    if (win.join('').length >= 250) {
      if (firstSeen.has(key)) dupOf = firstSeen.get(key);
      else firstSeen.set(key, i);
    }
    if (dupOf >= 0 && dupOf + N <= i) {
      const step = run ? run.len - N + 1 : 0;
      if (run && dupOf === run.a + step && i === run.b + step) run.len++;
      else { run = { sig: shortHash(key), a: dupOf, b: i, len: N }; runs.push(run); }
    } else {
      run = null;
    }
  }
  for (const r of runs) {
    add('error', `DUP_BLOCK:${name}:${r.sig}`, `${name}: блок из ${r.len} строк повторяется — строки ${r.a + 1}–${r.a + r.len} и ${r.b + 1}–${r.b + r.len}`);
  }
}

// ─── 1. manifest.json ───────────────────────────────────────────────────────

let manifest = null;
const manifestSrc = readIf('manifest.json');
if (manifestSrc == null) {
  add('error', 'MANIFEST_MISSING', 'нет manifest.json');
} else {
  try {
    manifest = JSON.parse(manifestSrc);
  } catch (e) {
    add('error', 'MANIFEST_JSON', `manifest.json не парсится: ${e.message}`);
  }
}

const refs = new Set(); // файлы, на которые ссылается manifest
if (manifest) {
  if (manifest.manifest_version !== 3) add('warn', 'MANIFEST_VERSION', 'manifest_version не 3');
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version ?? ''))) {
    add('error', 'MANIFEST_VERSION_FORMAT', `version «${manifest.version}» — ожидается вид 1.2.3`);
  }
  if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
  for (const cs of manifest.content_scripts ?? []) {
    (cs.js ?? []).forEach((f) => refs.add(f));
    (cs.css ?? []).forEach((f) => refs.add(f));
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    (war.resources ?? []).forEach((f) => { if (!f.includes('*')) refs.add(f); });
  }
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
  for (const icons of [manifest.icons, manifest.action?.default_icon]) {
    if (icons && typeof icons === 'object') Object.values(icons).forEach((f) => refs.add(f));
  }
  for (const f of refs) {
    if (!existsSync(join(extDir, f))) add('error', `MANIFEST_FILE_MISSING:${f}`, `manifest.json ссылается на «${f}», но файла нет`);
  }
}

// ─── 2. JS-файлы ────────────────────────────────────────────────────────────

const jsFiles = walk(extDir).filter((p) => extname(p) === '.js').map((p) => ({ name: relExt(p), src: readFileSync(p, 'utf8') }));
const moduleSw = manifest?.background?.type === 'module' ? manifest.background.service_worker : null;

for (const { name, src } of jsFiles) {
  // 2.1 синтаксис (компилируем как обычный скрипт, не выполняя)
  if (name === moduleSw) {
    add('warn', `SYNTAX_SKIPPED:${name}`, `${name}: service worker подключён как module — проверка синтаксиса пропущена`);
  } else {
    try {
      new vm.Script(src, { filename: name });
    } catch (e) {
      const where = String(e.stack ?? '').split('\n')[0];
      add('error', `SYNTAX:${name}`, `${where} — ${e.name}: ${e.message}`);
    }
  }

  // 2.2 функции, объявленные дважды на одном уровне вложенности
  const fnLines = new Map();
  for (const m of src.matchAll(/^([ \t]*)(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const k = `${m[1].length}\u0000${m[2]}`;
    if (!fnLines.has(k)) fnLines.set(k, []);
    fnLines.get(k).push(lineOf(src, m.index));
  }
  for (const [k, lines] of fnLines) {
    if (lines.length < 2) continue;
    const fn = k.split('\u0000')[1];
    add('error', `DUP_FUNC:${name}:${fn}`, `${name}: функция «${fn}» объявлена ${lines.length} раза (строки ${lines.join(', ')})`);
  }

  // 2.3 ветки обработки одного и того же типа сообщения
  const branchTypes = [...src.matchAll(/\.type\s*===\s*'([A-Z][A-Z_]+)'/g)].map((m) => m[1]);
  for (const [t, n] of countBy(branchTypes)) {
    if (n > 1) add('error', `DUP_MSG:${name}:${t}`, `${name}: сообщение ${t} обрабатывается в ${n} ветках (вторая — мёртвый код)`);
  }

  // 2.4 повторяющиеся большие блоки
  checkDupBlocks(name, src);
}

// 2.5 «одиночные» регистрации в background.js
const bg = jsFiles.find((f) => f.name === (manifest?.background?.service_worker ?? 'background.js'));
if (bg) {
  for (const s of ['chrome.runtime.onMessage.addListener', 'chrome.alarms.onAlarm.addListener', 'chrome.notifications.onButtonClicked.addListener']) {
    const n = bg.src.split(s).length - 1;
    if (n > 1) add('error', `DUP_BG_LISTENER:${s}`, `${bg.name}: ${s} вызывается ${n} раза`);
  }
}

// 2.6 сообщения: отправленные, но нигде не обработанные
const sentTypes = new Set();
const handledTypes = new Set();
for (const { src } of jsFiles) {
  for (const m of src.matchAll(/\btype\s*:\s*'([A-Z][A-Z_]+)'/g)) sentTypes.add(m[1]);
  for (const m of src.matchAll(/\.type\s*(?:===|!==)\s*'([A-Z][A-Z_]+)'/g)) handledTypes.add(m[1]);
}
for (const t of sentTypes) if (!handledTypes.has(t)) add('error', `MSG_UNHANDLED:${t}`, `сообщение ${t} отправляется, но нигде не обрабатывается`);
for (const t of handledTypes) if (!sentTypes.has(t)) add('warn', `MSG_NEVER_SENT:${t}`, `сообщение ${t} обрабатывается, но нигде в коде не отправляется`);

// ─── 3. Права и хосты ───────────────────────────────────────────────────────

if (manifest) {
  const declared = new Set(manifest.permissions ?? []);
  for (const perm of ['alarms', 'notifications', 'storage', 'scripting', 'proxy']) {
    const re = new RegExp(`chrome\\.${perm}\\.`);
    const used = jsFiles.some((f) => re.test(f.src));
    if (used && !declared.has(perm)) add('error', `PERM_MISSING:${perm}`, `код использует chrome.${perm}.*, но разрешения «${perm}» нет в manifest.json`);
    if (!used && declared.has(perm)) add('warn', `PERM_UNUSED:${perm}`, `разрешение «${perm}» объявлено, но chrome.${perm}.* в коде нет`);
  }

  const hostAllowed = (host) => (manifest.host_permissions ?? []).some((p) => {
    if (p === '<all_urls>') return true;
    const m = p.match(/^(?:\*|https?):\/\/([^/]+)\//);
    if (!m) return false;
    const h = m[1];
    if (h === '*') return true;
    if (h.startsWith('*.')) return host === h.slice(2) || host.endsWith(h.slice(1));
    return host === h;
  });
  for (const { name, src } of jsFiles) {
    for (const m of src.matchAll(/fetch\(\s*[`'"]https?:\/\/([^/`'"$\s]+)/g)) {
      if (!hostAllowed(m[1])) add('warn', `HOST_NOT_PERMITTED:${name}:${m[1]}`, `${name}: fetch на ${m[1]}, которого нет в host_permissions (сработает только если сервер отдаёт CORS)`);
    }
  }
}

// ─── 4. popup.html ↔ popup.js ───────────────────────────────────────────────

const html = readIf('popup.html');
const popupJs = jsFiles.find((f) => f.name === 'popup.js');
if (html != null) {
  checkDupBlocks('popup.html', html);
  const ids = [...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  for (const [id, n] of countBy(ids)) if (n > 1) add('error', `DUP_ID:popup.html:${id}`, `popup.html: id="${id}" встречается ${n} раза`);

  const localRefs = [...html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u));
  for (const u of localRefs) {
    if (!existsSync(join(extDir, u.split(/[?#]/)[0]))) add('error', `HTML_REF_MISSING:${u}`, `popup.html ссылается на «${u}», файла нет`);
    refs.add(u.split(/[?#]/)[0]);
  }

  if (popupJs) {
    const known = new Set(ids);
    for (const m of popupJs.src.matchAll(/\bid\s*=\s*\\?["']([A-Za-z0-9_-]+)\\?["']/g)) known.add(m[1]); // id, созданные из JS
    for (const m of popupJs.src.matchAll(/\.id\s*=\s*['"]([A-Za-z0-9_-]+)['"]/g)) known.add(m[1]);
    const used = new Set([...popupJs.src.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]));
    for (const id of used) {
      if (!known.has(id)) add('error', `MISSING_ID:popup.js:${id}`, `popup.js: getElementById('${id}'), но такого id в popup.html нет (будет TypeError)`);
    }

    const listeners = [...popupJs.src.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)\s*\.addEventListener\(\s*['"]([a-zA-Z]+)['"]/g)].map((m) => `${m[1]}|${m[2]}`);
    for (const [k, n] of countBy(listeners)) {
      if (n > 1) add('error', `DUP_LISTENER:popup.js:${k}`, `popup.js: на #${k.split('|')[0]} ${n} обработчика «${k.split('|')[1]}» подряд (дубль)`);
    }
  }
} else {
  add('warn', 'NO_POPUP_HTML', 'popup.html не найден — проверки popup пропущены');
}

// 4.1 JS-файлы, которые никто не подключает
for (const { name } of jsFiles) {
  if (!refs.has(name)) add('warn', `UNREFERENCED:${name}`, `${name}: не подключён ни из manifest.json, ни из popup.html`);
}

// ─── 5. Секреты (защита от случайной утечки в репозиторий) ──────────────────

const SECRET_PATTERNS = [
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/],
  ['TELEGRAM_BOT_TOKEN', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['NTFY_TOKEN', /\btk_[a-z0-9]{29}\b/],
  ['ACCESS_TOKEN_IN_URL', /[?&]access_token=[A-Za-z0-9._-]{20,}/],
  ['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.htm', '.txt', '.css', '.yml', '.yaml', '.sh', '.env']);
const scanRoot = explicitDir ? extDir : resolve(extDir, '..');
for (const p of walk(scanRoot)) {
  if (!TEXT_EXT.has(extname(p).toLowerCase()) && !p.endsWith('.env')) continue;
  if (statSync(p).size > 2_000_000) continue;
  const text = readFileSync(p, 'utf8');
  const relPath = relative(scanRoot, p).split(sep).join('/');
  for (const [kind, re] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) add('error', `SECRET:${relPath}:${kind}`, `${relPath}:${lineOf(text, m.index)}: похоже на ${kind} — значение не выводится; убери его из репозитория`);
  }
}

// ─── Итог ───────────────────────────────────────────────────────────────────

let baseline = [];
if (existsSync(baselinePath) && !strict) {
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).known ?? []; }
  catch (e) { add('error', 'BASELINE_JSON', `scripts/known-issues.json не парсится: ${e.message}`); }
}
const isKnown = (f) => f.level === 'error' && !f.key.startsWith('SECRET:') && baseline.includes(f.key);

const color = process.stdout.isTTY ? (c, s) => `\x1b[${c}m${s}\x1b[0m` : (_c, s) => s;
const errors = findings.filter((f) => f.level === 'error' && !isKnown(f));
const known = findings.filter(isKnown);
const warns = findings.filter((f) => f.level === 'warn');
const stale = baseline.filter((k) => !findings.some((f) => f.key === k));

console.log(`Проверка расширения: ${extDir}`);
console.log(`  JS-файлов: ${jsFiles.length}, manifest ${manifest ? `v${manifest.version}` : 'не прочитан'}${strict ? ', режим --strict' : ''}`);
for (const f of errors) console.log(color(31, `  ✖ ${f.msg}`) + `\n      [${f.key}]`);
for (const f of known) console.log(color(33, `  ⚠ известная проблема: ${f.msg}`) + `\n      [${f.key}] — см. docs/known-issues.md`);
for (const f of warns) console.log(color(33, `  ⚠ ${f.msg}`));
for (const k of stale) console.log(color(36, `  ℹ в known-issues.json устарела строка «${k}» — проблема исправлена, удали её`));
console.log(`Итого: новых ошибок ${errors.length}, известных ${known.length}, предупреждений ${warns.length}`);
console.log(errors.length ? color(31, 'ПРОВЕРКА НЕ ПРОЙДЕНА') : color(32, 'Проверка пройдена'));
process.exit(errors.length ? 1 : 0);
