// 数据库层：jsonb 读写。设置 TEST_DATABASE_URL 时在真实 Postgres（线上的驱动 postgres.js）上运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../server/pay/db.js';
import { migrate, repairDoubleEncoded } from '../server/pay/schema.js';
import { getMeta, setMeta } from '../server/pay/core.js';

test('jsonb：对象、数字、字符串存进去再读出来，类型不变', async () => {
  const db = await createTestDb(); await migrate(db);
  await setMeta(db, 'o', { at: '2026-01-01T00:00:00.000Z', n: 1 });
  await setMeta(db, 'n', 123);
  await setMeta(db, 's', 'xpub6abc');
  assert.deepEqual(await getMeta(db, 'o'), { at: '2026-01-01T00:00:00.000Z', n: 1 });
  assert.equal(await getMeta(db, 'n'), 123);
  assert.equal(await getMeta(db, 's'), 'xpub6abc');
  const rows = await db.query(`select key, jsonb_typeof(value) t from pay_meta where key in ('o', 'n', 's') order by key`);
  assert.deepEqual(rows.map((r) => `${r.key}:${r.t}`), ['n:number', 'o:object', 's:string']);
  await db.end();
});

test('jsonb：修复之前多编码了一层的值；正常的字符串不动；只执行一次', async () => {
  const db = await createTestDb(); await migrate(db);
  await db.query(`delete from pay_meta where key = 'repair_p5'`);
  await db.query(`insert into pay_meta (key, value) values
    ('a', to_jsonb('{"at":"x"}'::text)), ('b', to_jsonb('123'::text)), ('c', to_jsonb('"xpub6abc"'::text)), ('d', to_jsonb('xpub6abc'::text))`);
  await repairDoubleEncoded(db);
  assert.deepEqual(await getMeta(db, 'a'), { at: 'x' });
  assert.equal(await getMeta(db, 'b'), 123);
  assert.equal(await getMeta(db, 'c'), 'xpub6abc');
  assert.equal(await getMeta(db, 'd'), 'xpub6abc');
  // 标记已写入：再出现类似的值也不会被改
  await db.query(`update pay_meta set value = to_jsonb('456'::text) where key = 'b'`);
  await repairDoubleEncoded(db);
  assert.equal(await getMeta(db, 'b'), '456');
  await db.end();
});

test('数据库：同时发出很多查询时，最多 3 个同时进行，其余排队，全部都能返回', async () => {
  const { gate } = await import('../server/pay/db.js');
  const run = gate(3);
  let active = 0, peak = 0;
  const job = (i) => run(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return i; });
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => job(i)));
  assert.deepEqual(out, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(peak, 3);
  // 出错的任务不会卡住后面的
  const r = await Promise.allSettled([run(async () => { throw new Error('x'); }), run(async () => 'ok')]);
  assert.deepEqual(r.map((x) => x.status), ['rejected', 'fulfilled']);
  // 真实数据库上同时发 30 个查询
  const db = await createTestDb(); await migrate(db);
  const rows = await Promise.all(Array.from({ length: 30 }, (_, i) => db.query('select $1::int v', [i])));
  assert.deepEqual(rows.map((x) => x[0].v), Array.from({ length: 30 }, (_, i) => i));
  await db.end();
});
