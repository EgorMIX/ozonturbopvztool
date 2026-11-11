import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorker } from './worker-harness.mjs';
const items = [
  { number: '100000001', source: 'ТЕСТ_ХАБ', status: 'Приёмка', accepted: 132, total: 321 },
  { number: '100000002', source: 'ТЕСТ_ХАБ', status: 'Приёмка', accepted: 46, total: 220 },
];
const found = w => w.msg('TIMER_FOUND', { seconds: 10087, url: 'https://turbo-pvz.ozon.ru/receiving-v2/main' }, 1);
test('Две перевозки обновляют активную историю и сохраняют финальный статус', async () => {
  const w = await makeWorker(); await found(w);
  await w.msg('CARRIAGES_UPDATE', { items }, 1);
  assert.equal(w.db.acceptanceHistory[0].carriages.reduce((s, c) => s + c.accepted, 0), 178);
  const finished = items.map(c => ({ ...c, status: 'Завершена', accepted: c.total }));
  await w.msg('CARRIAGES_UPDATE', { items: finished }, 1);
  await w.msg('TIMER_LOST', {}, 1); await w.alarm('timer_lost_grace');
  assert.equal(w.db.acceptanceHistory[0].carriages.reduce((s, c) => s + c.accepted, 0), 541);
  assert.equal(w.db.acceptanceHistory[0].result, 'onTime');
});
test('Финальные числа дописываются после исчезновения таймера', async () => {
  const w = await makeWorker(); await found(w); await w.msg('CARRIAGES_UPDATE', { items }, 1);
  await w.msg('TIMER_LOST', {}, 1); await w.alarm('timer_lost_grace');
  await w.msg('CARRIAGES_UPDATE', { items: items.map(c => ({ ...c, status: 'Завершена', accepted: c.total })) }, 1);
  assert.equal(w.db.acceptanceHistory[0].carriages[0].accepted, 321);
});
test('Очистка истории сохраняет текущую приёмку', async () => {
  const w = await makeWorker(); await found(w); await w.msg('HISTORY_CLEAR');
  assert.equal(w.db.acceptanceHistory.length, 1);
  await w.msg('TIMER_CLEAR'); assert.equal(w.db.acceptanceHistory[0].result, 'cleared');
});
test('Старое состояние получает запись истории; расписание восстанавливается', async () => {
  const w = await makeWorker({ timerState: { seconds: 3600, updatedAt: 1800000000000, firedFor: [], startNotified: true } });
  assert.ok(w.db.timerState.sessionId); assert.equal(w.db.acceptanceHistory.length, 1);
  assert.ok(w.alarms.has('threshold_30_0')); assert.ok(w.alarms.has('deadline_reached'));
  await w.msg('TIMER_CLEAR'); assert.equal(w.db.acceptanceHistory[0].result, 'cleared');
});
test('Коррекция конца приёмки переносит алармы и не шлёт ранний сигнал', async () => {
  const w = await makeWorker(); await w.msg('TIMER_FOUND', { seconds: 3600 }, 1);
  const before = w.alarms.get('deadline_reached').when;
  w.tick(10000); await w.msg('TIMER_FOUND', { seconds: 3670 }, 1);
  assert.equal(w.alarms.get('deadline_reached').when, before + 80000);
  w.tick(3530000); await w.alarm('deadline_reached');
  assert.equal(w.notifications.filter(n => n.id.endsWith('_deadline')).length, 0);
});
test('Нулевой запас даёт одно оповещение при нуле', async () => {
  const w = await makeWorker({ pvzSettings: { finishMarginMin: 0 } });
  await w.msg('TIMER_FOUND', { seconds: 3600 }, 1); w.tick(3600000);
  await w.alarm('deadline_reached'); await w.alarm('badge_tick');
  assert.equal(w.notifications.filter(n => n.id.endsWith('_deadline')).length, 1);
});
test('Сохранение и рестарт не повторяют уже отправленные пороги', async () => {
  const w = await makeWorker(); await w.msg('TIMER_FOUND', { seconds: 400 }, 1);
  const before = w.notifications.length;
  await w.msg('SETTINGS_UPDATED', { settings: { theme: 'light' } }); assert.equal(w.notifications.length, before);
  const fresh = await makeWorker(w.db); assert.equal(fresh.notifications.length, 0);
});
test('Вторая вкладка не сбрасывает активный таймер', async () => {
  const w = await makeWorker(); await found(w); await w.msg('TIMER_LOST', {}, 2);
  await w.alarm('timer_lost_grace'); assert.notEqual(w.db.timerState.seconds, null);
  await w.msg('TIMER_FOUND', { seconds: 20000 }, 2); assert.equal(w.db.timerState.tabId, 1);
});
test('Навигация не подделывает завершение приёмки', async () => {
  const w = await makeWorker(); await found(w); await w.msg('TIMER_LOST', { reason: 'navigation' }, 1);
  assert.equal(w.db.timerState.lostAt, null); assert.equal(w.db.acceptanceHistory[0].result, 'active');
});
test('Изменение запаса согласует результат и показанный срок', async () => {
  const w = await makeWorker(); await w.msg('TIMER_FOUND', { seconds: 3600 }, 1);
  await w.msg('SETTINGS_UPDATED', { settings: { finishMarginMin: 10 } }); w.tick(3300000);
  await w.msg('TIMER_LOST', {}, 1); await w.alarm('timer_lost_grace');
  const e = w.db.acceptanceHistory[0]; assert.equal(e.result, 'late'); assert.ok(e.finishedAt > e.deadlineAt);
});
const bagUrl = 'https://turbo-pvz.ozon.ru/orders/session-new/123';
test('Две вкладки делят одну квоту; повторный commit не дублируется', async () => {
  const w = await makeWorker({ pvzSettings: { bagsQuota: { M: 1, L: 0 } } });
  const [a, b] = await Promise.all([w.msg('BAGS_RESERVE', { label: 'M' }, 1, bagUrl), w.msg('BAGS_RESERVE', { label: 'M' }, 2, bagUrl)]);
  assert.equal([a, b].filter(r => r.ok).length, 1);
  const r = a.ok ? a : b, tab = a.ok ? 1 : 2;
  await w.msg('BAGS_COMMIT', { token: r.token, added: true }, tab, bagUrl);
  await w.msg('BAGS_COMMIT', { token: r.token, added: true }, tab, bagUrl);
  assert.equal(w.db.bagsSessionStats.M, 1);
});
test('Отказанный клик освобождает квоту без увеличения статистики', async () => {
  const w = await makeWorker({ pvzSettings: { bagsQuota: { M: 1, L: 0 } } });
  const r = await w.msg('BAGS_RESERVE', { label: 'M' }, 1, bagUrl);
  await w.msg('BAGS_COMMIT', { token: r.token, added: false }, 1, bagUrl);
  assert.equal(w.db.bagsSessionStats.M, 0); assert.ok((await w.msg('BAGS_RESERVE', { label: 'M' }, 2, bagUrl)).ok);
});
test('Резерв переживает перезапуск worker; истёкший резерв освобождается', async () => {
  const w = await makeWorker({ pvzSettings: { bagsQuota: { M: 1, L: 0 } } });
  await w.msg('BAGS_RESERVE', { label: 'M' }, 1, bagUrl);
  const fresh = await makeWorker(w.db); assert.equal((await fresh.msg('BAGS_RESERVE', { label: 'M' }, 2, bagUrl)).ok, false);
  fresh.tick(120001); assert.ok((await fresh.msg('BAGS_RESERVE', { label: 'M' }, 2, bagUrl)).ok);
});
test('Отключение запрещает пакеты и не создаёт пороговые алармы при сохранении', async () => {
  const w = await makeWorker(); await found(w); await w.msg('SET_MODE', { mode: 'disabled' });
  await w.msg('SETTINGS_UPDATED', { settings: { finishMarginMin: 2 } });
  assert.equal((await w.msg('BAGS_RESERVE', { label: 'M' }, 1, bagUrl)).ok, false);
  assert.equal([...w.alarms.keys()].some(k => k.startsWith('threshold_') || k === 'deadline_reached'), false);
});
test('Неверные настройки отклоняются целиком, секреты не теряются при частичном сохранении', async () => {
  const w = await makeWorker({ pvzSettings: { telegram: { chatId: 'test-chat' } } });
  for (const settings of [{ workHours: { days: null } }, { thresholds: [null] }, { finishMarginMin: -1 }, { ntfy: { server: 'http://example.com' } }]) {
    assert.equal((await w.msg('SETTINGS_UPDATED', { settings })).ok, false);
  }
  assert.ok((await w.msg('SETTINGS_UPDATED', { settings: { bagsSizes: 'M' } })).ok);
  assert.equal(w.db.pvzSettings.telegram.chatId, 'test-chat'); assert.equal(w.db.pvzSettings.thresholds[0].minutes, 30);
});
test('Полный сброс удаляет историю, таймер, резервы и возвращает рабочие настройки', async () => {
  const w = await makeWorker(); await found(w); await w.msg('DEBUG_RESET');
  assert.equal(w.db.timerState, undefined); assert.equal(w.db.acceptanceHistory, undefined);
  assert.equal(w.db.pvzSettings.finishMarginMin, 1); assert.ok(w.alarms.has('update_check'));
});
