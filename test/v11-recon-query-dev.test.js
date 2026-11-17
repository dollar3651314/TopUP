// v1.1 对账查询（研发补测）：时间边界和游标到微秒都准（真实 Postgres 下驱动不截成毫秒）、被改过的游标 422、
// 时区换算后才判断早于 1970 年
import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './qa-v11-helpers.js';

const enc = encodeURIComponent;
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');

/** 给商户 ma 插几条指定时间（到微秒）的账本记录，返回按时间排好的编号 */
async function ledgerAt(w, times) {
  const ids = [];
  for (const t of times) {
    const [r] = await w.db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref, created_at) values ('ma', 'deposit', 1, 1, 0, 'dev-test', $1::text::timestamptz) returning id`, [t]);
    ids.push(String(r.id));
  }
  return ids;
}

test('对账查询：from、to 精确到微秒（同一毫秒里的记录按微秒分到两边）', async () => {
  const w = await world();
  const [a, b, c] = await ledgerAt(w, ['2026-11-10T00:00:00.000200Z', '2026-11-10T00:00:00.000500Z', '2026-11-10T00:00:00.000900Z']);
  const q = async (qs) => {
    const r = await w.api(w.a, 'GET', `ledger/?${qs}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.items.map((x) => x.id);
  };
  assert.deepEqual(await q(`from=${enc('2026-11-10T00:00:00.000500Z')}&to=${enc('2026-11-10T00:01:00Z')}`), [b, c], 'from 含当时那一微秒');
  assert.deepEqual(await q(`from=${enc('2026-11-10T00:00:00.000501Z')}&to=${enc('2026-11-10T00:01:00Z')}`), [c]);
  assert.deepEqual(await q(`from=${enc('2026-11-09T00:00:00Z')}&to=${enc('2026-11-10T00:00:00.000500Z')}`), [a], 'to 不含当时那一微秒');
  assert.deepEqual(await q(`from=${enc('2026-11-09T00:00:00Z')}&to=${enc('2026-11-10T08:00:00.0009+08:00')}`), [a, b]);
  // 一条一页翻完：不重不漏
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const r = await w.api(w.a, 'GET', `ledger/?from=${enc('2026-11-09T00:00:00Z')}&to=${enc('2026-11-11T00:00:00Z')}&limit=1${cursor ? `&cursor=${enc(cursor)}` : ''}`);
    assert.equal(r.status, 200);
    seen.push(...r.body.items.map((x) => x.id));
    cursor = r.body.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, [a, b, c]);
  // 游标里的编号查不到时用游标里的时间（到微秒）：从 0.000500 之后接着翻
  const r = await w.api(w.a, 'GET', `ledger/?from=${enc('2026-11-09T00:00:00Z')}&to=${enc('2026-11-11T00:00:00Z')}&cursor=${b64(['2026-11-10T00:00:00.000500Z', '999999999'])}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((x) => x.id), [c]);
  await w.db.end();
});

test('对账查询：被改过的游标、旧接口的非数字游标 → 422 invalid_param（field cursor），不是 500', async () => {
  const w = await world();
  const R = `from=${enc('2026-11-01T00:00:00Z')}&to=${enc('2026-11-20T00:00:00Z')}`;
  const bad = [
    'not-base64-json!!',
    b64(['2026-11-10T00:00:00.000000Z']),
    b64(['2026-11-10T00:00:00.000000Z', 'abc']),
    b64(['2026-11-10T00:00:00.000000Z', '1e5']),
    b64(['2026-11-10T00:00:00.000000Z', '1234567890123456789']), // 19 位，超出 bigint 也不让进库
    b64(['2026-02-30T00:00:00.000000Z', '1']), // 不存在的日期
    b64(['2026-11-10T25:00:00.000000Z', '1']),
    b64(['2026-11-10', '1']),
  ];
  for (const path of ['ledger/', 'deposits/']) {
    for (const c of bad) {
      const r = await w.api(w.a, 'GET', `${path}?${R}&cursor=${enc(c)}`);
      assert.equal(r.status, 422, `${path} ${c}：${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'invalid_param');
      assert.equal(r.body.error.field, 'cursor');
    }
  }
  for (const c of ['not-base64-json!!', b64(['2026-11-10T00:00:00.000000Z', "WD-1' or '1'='1"]), b64(['2026-02-30T00:00:00.000000Z', 'WD-20261110-abcd'])]) {
    const r = await w.api(w.a, 'GET', `withdrawals/list/?cursor=${enc(c)}`);
    assert.equal(r.status, 422, `withdrawals/list ${c}：${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.field, 'cursor');
  }
  // 不带时间段的旧调用：游标必须是数字
  for (const path of ['ledger/', 'deposits/', 'orders/list/', 'customers/list/']) {
    for (const c of ['abc', '12abc', '-1', '1.5', '9'.repeat(25)]) {
      const r = await w.api(w.a, 'GET', `${path}?cursor=${enc(c)}`);
      assert.equal(r.status, 422, `${path} ${c}：${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.field, 'cursor');
    }
    const ok = await w.api(w.a, 'GET', `${path}?cursor=${Date.now()}`);
    assert.equal(ok.status, 200, `${path} 数字游标照旧能用：${JSON.stringify(ok.body)}`);
  }
  await w.db.end();
});

test('对账查询：早于 1970 年按换成 UTC 之后判断', async () => {
  const w = await world();
  const ok = await w.api(w.a, 'GET', `ledger/?from=${enc('1969-12-31T20:00:00-05:00')}&to=${enc('1970-01-02T00:00:00Z')}`);
  assert.equal(ok.status, 200, `1969-12-31T20:00-05:00 就是 1970-01-01T01:00Z：${JSON.stringify(ok.body)}`);
  const bad = await w.api(w.a, 'GET', `ledger/?from=${enc('1970-01-01T07:00:00+08:00')}&to=${enc('1970-01-02T00:00:00Z')}`);
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.field, 'from');
  await w.db.end();
});
