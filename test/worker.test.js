// worker 进程：租约（同一时间只有一个 worker 在跑）、每日任务的时间点、一轮里各任务互不影响
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { takeLease, releaseLease, dailyDue, runOnce, LEASE_MS } from '../server/worker.js';

const quiet = { error: () => {}, log: () => {} };

test('租约：别人的租约没过期抢不到，过期或释放后能抢到；自己的租约可以续期', async () => {
  const db = await createTestDb();
  await migrate(db);
  const t0 = Date.parse('2026-11-13T00:00:00Z');
  assert.equal(await takeLease(db, 'a', { now: t0 }), true);
  assert.equal(await takeLease(db, 'b', { now: t0 + 1000 }), false);
  assert.equal(await takeLease(db, 'a', { now: t0 + 1000 }), true); // 续期
  assert.equal(await takeLease(db, 'b', { now: t0 + 1000 + LEASE_MS + 1 }), true); // a 的租约过期
  await releaseLease(db, 'b');
  const [r] = await db.query(`select value from pay_meta where key = 'worker_lease'`);
  assert.equal(r.value.until, '1970-01-01T00:00:00Z');
  assert.equal(await takeLease(db, 'a', { now: t0 + 2000 }), true); // 释放后马上能抢到
  await db.end?.();
});

test('每日任务：当天到了设定时间（UTC）才执行，同一天只执行一次', () => {
  const at = '19:15';
  assert.equal(dailyDue(Date.parse('2026-11-13T19:14:59Z'), at, null), null);
  assert.equal(dailyDue(Date.parse('2026-11-13T19:15:00Z'), at, null), '2026-11-13');
  assert.equal(dailyDue(Date.parse('2026-11-13T23:00:00Z'), at, '2026-11-13'), null);
  assert.equal(dailyDue(Date.parse('2026-11-14T19:20:00Z'), at, '2026-11-13'), '2026-11-14');
});

test('一轮：抢到租约才执行；扫链出错不影响每日任务；每日任务执行后记在数据库里，重启也不会重复', async () => {
  const db = await createTestDb();
  await migrate(db);
  const calls = [];
  const deps = {
    db, owner: 'w1', atUtc: '19:15', log: quiet,
    tick: async () => { calls.push('tick'); throw new Error('rpc down'); },
    cleanup: async () => { calls.push('cleanup'); return { deleted: 0 }; },
    daily: async () => { calls.push('daily'); return { ok: true }; },
  };
  const t = Date.parse('2026-11-13T19:30:00Z');
  const r1 = await runOnce({ ...deps, now: t });
  assert.deepEqual(calls, ['tick', 'cleanup', 'daily']);
  assert.deepEqual(r1.tick, { error: 'failed' });
  calls.length = 0;
  await runOnce({ ...deps, now: t + 15_000 }); // 同一天：只扫链
  assert.deepEqual(calls, ['tick']);
  calls.length = 0;
  const r3 = await runOnce({ ...deps, owner: 'w2', now: t + 20_000 }); // 另一个 worker：租约还在 w1 手里
  assert.deepEqual(r3, { skipped: 'lease' });
  assert.deepEqual(calls, []);
  await db.end?.();
});
