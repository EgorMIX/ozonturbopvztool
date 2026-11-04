#!/usr/bin/env node
// scripts/pack.mjs — собирает dist/ozon-turbo-pvz-<версия>.zip из extension/.
// Без зависимостей и без внешней утилиты zip (работает и на Windows), Node >= 18.
//
//   node scripts/pack.mjs [--no-check]
//
// Перед сборкой запускается scripts/check.mjs; при новых ошибках сборка отменяется.
// manifest.json лежит в корне архива — в таком виде его принимает и Chrome Web Store,
// и «Загрузить распакованное» после распаковки.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const extDir = join(root, 'extension');
const distDir = join(root, 'dist');

if (!process.argv.includes('--no-check')) {
  const r = spawnSync(process.execPath, [join(here, 'check.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\nСборка отменена: проверка не пройдена (--no-check отключает проверку).');
    process.exit(1);
  }
  console.log();
}

const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
const outName = `ozon-turbo-pvz-${manifest.version}.zip`;

// ─── Файлы ──────────────────────────────────────────────────────────────────

const IGNORE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const IGNORE_DIRS = new Set(['.git', 'node_modules']);

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_NAMES.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { if (!IGNORE_DIRS.has(ent.name)) out.push(...walk(p)); }
    else out.push(p);
  }
  return out;
}

const entries = walk(extDir)
  .map((abs) => ({ abs, name: relative(extDir, abs).split(sep).join('/') }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// ─── Минимальный ZIP-писатель ───────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const chunks = [];
const central = [];
let offset = 0;

for (const f of entries) {
  const data = readFileSync(f.abs);
  const nameBuf = Buffer.from(f.name, 'utf8');
  const crc = crc32(data);
  let method = 8;
  let body = deflateRawSync(data, { level: 9 });
  if (body.length >= data.length) { method = 0; body = data; } // не сжимается — кладём как есть
  const { time, date } = dosDateTime(statSync(f.abs).mtime);

  const lh = Buffer.alloc(30); // local file header
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);        // version needed
  lh.writeUInt16LE(0x0800, 6);    // flags: имена в UTF-8
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(time, 10);
  lh.writeUInt16LE(date, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);        // extra length
  chunks.push(lh, nameBuf, body);

  const ch = Buffer.alloc(46); // central directory header
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);        // version made by
  ch.writeUInt16LE(20, 6);        // version needed
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(time, 12);
  ch.writeUInt16LE(date, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);        // extra length
  ch.writeUInt16LE(0, 32);        // comment length
  ch.writeUInt16LE(0, 34);        // disk number
  ch.writeUInt16LE(0, 36);        // internal attrs
  ch.writeUInt32LE(0, 38);        // external attrs
  ch.writeUInt32LE(offset, 42);   // offset of local header
  central.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22); // end of central directory
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

mkdirSync(distDir, { recursive: true });
const zip = Buffer.concat([...chunks, centralBuf, eocd]);
writeFileSync(join(distDir, outName), zip);
console.log(`Готово: dist/${outName} — ${entries.length} файлов, ${(zip.length / 1024).toFixed(1)} КБ`);
