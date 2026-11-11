// Изолированный Chrome API: часы, storage, сообщения и алармы без сети и браузера.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const ext = new URL('../extension/', import.meta.url);
const copy = v => v === undefined ? undefined : structuredClone(v);
export async function makeWorker(initial = {}) {
  const db = copy(initial), alarms = new Map(), notifications = [], changes = [], events = {}, tabs = new Set([1, 2]);
  let now = 1800000000000;
  class Clock extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const event = name => ({ addListener: fn => { events[name] = fn; } });
  const chrome = {
    runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ version: '1.8.0' }), onMessage: event('message') },
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in db).map(k => [k, copy(db[k])])),
      set: async data => { const delta = {}; for (const [k, v] of Object.entries(data)) { delta[k] = { oldValue: copy(db[k]), newValue: copy(v) }; db[k] = copy(v); } changes.forEach(fn => fn(delta, 'local')); },
      remove: async key => { delete db[key]; }, clear: async () => { for (const k of Object.keys(db)) delete db[k]; },
    } },
    alarms: { create: async (name, data) => { alarms.set(name, copy(data)); }, clear: async name => alarms.delete(name), get: async name => copy(alarms.get(name)), getAll: async () => [...alarms].map(([name, data]) => ({ name, ...data })), onAlarm: event('alarm') },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    notifications: { create: async (id, data) => { notifications.push({ id, ...copy(data) }); }, clear: async () => {}, onClicked: event('click'), onButtonClicked: event('button') },
    tabs: { query: async () => [], get: async id => { if (!tabs.has(id)) throw new Error('closed'); return { id }; }, create: () => {} },
    permissions: { contains: async () => true },
    proxy: { settings: { get: async () => ({ levelOfControl: 'controllable_by_this_extension' }), set: async () => {}, clear: async () => {} } },
    webRequest: { onAuthRequired: event('auth') },
  };
  const ctx = vm.createContext({ chrome, Date: Clock, crypto: webcrypto, structuredClone, URL, AbortSignal,
    console: { log: () => {} }, fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }) });
  ctx.importScripts = file => vm.runInContext(readFileSync(new URL(file, ext), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('background.js', ext), 'utf8'), ctx);
  await vm.runInContext('ready', ctx);
  const drain = async () => { await vm.runInContext('messageQueue', ctx); await vm.runInContext('historyQueue', ctx); await vm.runInContext('alarmQueue', ctx); };
  await drain();
  const msg = async (type, data = {}, tabId = null, url = 'https://turbo-pvz.ozon.ru/receiving-v2/main') => {
    const sender = tabId == null ? { id: 'test', url: 'chrome-extension://test/popup.html' } : { id: 'test', url, tab: { id: tabId } };
    const result = await new Promise(resolve => events.message({ type, ...copy(data) }, sender, resolve));
    await drain(); return copy(result);
  };
  return { db, alarms, notifications, changes, tabs, msg, drain, now: () => now, tick: ms => { now += ms; },
    alarm: async name => { await events.alarm({ name }); await drain(); }, eval: code => vm.runInContext(code, ctx) };
}
