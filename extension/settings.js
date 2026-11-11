// Общая схема настроек для popup и service worker. Внешние данные проверяются до сохранения.
'use strict';
globalThis.PVZSettings = (() => {
  const defaults = () => ({
    thresholds: [
      { minutes: 30, text: 'Внимание! Через 30 минут крайний срок завершения приёмки.', volume: 0.7, enabled: true },
      { minutes: 15, text: 'Внимание! Через 15 минут крайний срок завершения приёмки!', volume: 1, enabled: true },
      { minutes: 5, text: 'Срочно! Через 5 минут крайний срок завершения приёмки!!!', volume: 1, enabled: true },
    ],
    notifType: 'both', speechEnabled: true, notifEnabled: true, theme: 'dark',
    telegram: { enabled: false, botToken: '', chatId: '' },
    ntfy: { enabled: false, topic: '', server: 'https://ntfy.sh', token: '', priority: 'default' },
    proxy: { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '' },
    bagsEnabled: true, bagsSizes: 'both', bagsQuota: { M: 0, L: 0 }, finishMarginMin: 1,
    workHours: { enabled: false, from: '08:00', to: '22:00', days: [0, 1, 2, 3, 4, 5, 6] }, updateCheck: true,
  });
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  function normalize(raw, base = defaults(), strict = false) {
    if (!object(raw)) throw new Error('Настройки должны быть объектом');
    const out = JSON.parse(JSON.stringify(base));
    const bad = key => { if (strict) throw new Error(`Некорректная настройка: ${key}`); };
    const number = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    for (const key of Object.keys(out)) {
      if (!(key in raw) || key === 'speechEnabled' || key === 'notifEnabled') continue;
      const value = raw[key];
      if (key === 'thresholds') {
        if (!Array.isArray(value) || value.length > 30 || value.some(t => !object(t) ||
            !Number.isInteger(t.minutes) || !number(t.minutes, 1, 240) || typeof t.text !== 'string' ||
            t.text.length > 140 || (t.volume !== undefined && !number(t.volume, 0, 1)) ||
            (t.enabled !== undefined && typeof t.enabled !== 'boolean')) ||
            new Set(value.map(t => t.minutes)).size !== value.length) { bad(key); continue; }
        out[key] = value.map(t => ({ minutes: t.minutes, text: t.text, volume: t.volume ?? 1, enabled: t.enabled !== false }));
      } else if (key === 'finishMarginMin') {
        if (!number(value, 0, 10)) { bad(key); continue; } out[key] = value;
      } else if (key === 'bagsQuota') {
        if (!object(value) || Object.keys(value).some(k => !['M', 'L'].includes(k) || !Number.isInteger(value[k]) || !number(value[k], 0, 999))) { bad(key); continue; }
        out[key] = { ...out[key], ...value };
      } else if (key === 'workHours') {
        if (!object(value) || Object.keys(value).some(k => !['enabled', 'from', 'to', 'days'].includes(k)) ||
            (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
            ['from', 'to'].some(k => value[k] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value[k])) ||
            (value.days !== undefined && (!Array.isArray(value.days) || value.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)))) { bad(key); continue; }
        out[key] = { ...out[key], ...value };
      } else if (object(out[key])) {
        if (!object(value)) { bad(key); continue; }
        for (const field of Object.keys(out[key])) {
          if (!(field in value)) continue;
          if (typeof value[field] !== typeof out[key][field] || (typeof value[field] === 'string' && value[field].length > 4096)) { bad(`${key}.${field}`); continue; }
          out[key][field] = value[field];
        }
      } else if (typeof value === typeof out[key]) out[key] = value;
      else bad(key);
    }
    for (const [key, choices] of Object.entries({ notifType: ['both', 'push', 'voice'], theme: ['dark', 'light'], bagsSizes: ['M', 'L', 'both'] })) {
      if (!choices.includes(out[key])) { bad(key); out[key] = base[key]; }
    }
    if (!['http', 'socks5'].includes(out.proxy.type)) { bad('proxy.type'); out.proxy.type = base.proxy.type; }
    if (!['min', 'low', 'default', 'high', 'urgent'].includes(out.ntfy.priority)) { bad('ntfy.priority'); out.ntfy.priority = base.ntfy.priority; }
    try {
      const u = new URL(out.ntfy.server);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error();
      out.ntfy.server = u.href.replace(/\/+$/, '');
    } catch (_) { bad('ntfy.server'); out.ntfy.server = base.ntfy.server; }
    out.speechEnabled = out.notifType !== 'push'; out.notifEnabled = out.notifType !== 'voice';
    return out;
  }
  return { defaults, normalize };
})();
