// 测试先写（v1.1）：对账查询——新接口 GET withdrawals/list/，GET deposits/、GET ledger/ 加时间段（deposits 再加 txid）。
// 依据：v1.1 开放 API 补接口需求的"对账查询"一节（已定：只做开放 API，商户后台不变）。
//
// 给研发的接口约定（需求没写死的地方由测试定，照着做）：
//   - GET withdrawals/list/：查询参数 status（对外状态，同 Withdrawal.status：pending、approved、broadcast、completed、rejected、cancelled、failed）、
//     chain（eth / bsc / tron）、from、to、cursor、limit（1–100，默认 50）；返回 { items: Withdrawal[], next_cursor }，items 和 GET withdrawals/ 同一个对象。
//     按 created_at 从早到晚排（相同时间按记录号），不论带不带 from / to。
//   - GET deposits/、GET ledger/：加 from、to；deposits/ 再加 txid（精确匹配，可以和别的条件一起用）。
//     带了 from 或 to（任一个）就从早到晚排（相同时间按记录号）；**from、to 都不带的旧调用顺序不变（从新到旧）**，翻页参数照旧。
//   - 时间段按哪个字段（产品 11/17 补充说明第 4 条）：提现 created_at；到账按 TopUP 入账时间 deposits.created_at（不是链上时间 time），
//     到账对象新增字段 credited_at（= deposits.created_at，ISO 8601），链上时间 time 照旧；账本 created_at。
//     区间是 [from, to)：含 from、不含 to，相邻两段首尾相接时不重不漏。
//   - 缺省（补充说明第 2 条）：to 不传 = 现在；from 不传 = to − 31 天。withdrawals/list 什么都不传就是最近 31 天；
//     deposits、ledger 只带了 from 或 to 其中一个时，缺的那个按同样规则补。
//   - from、to 是带时区的 ISO 8601（2026-11-15T00:00:00+08:00、2026-11-14T16:00:00Z、带毫秒也行）；没带时区、格式错、不存在的日期 →
//     422 invalid_param（error.field = 'from' 或 'to'）；from 晚于 to → 422 invalid_param（field = 'from'）；
//     to − from 超过 31 天 → 422 invalid_param（field = 'to'）；正好 31 天可以。
//   - cursor 是不透明字符串（只能用上一页的 next_cursor）；翻页过程中新进的记录不改变已翻过的页、也不让后面的页重复或漏掉已存在的记录。
//   - 只返回自己商户的记录。低于 1 USDT 的到账照旧不给商户看。
//   - 开发者文档：补 GET withdrawals/list/ 和三个参数（from、to、txid），写明区间 [from, to)、最多 31 天、带 from / to 时从早到晚、
//     到账按入账时间筛；Deposit 对象加 credited_at。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, U, TO, ETH_TO, HOUR, DAY } from './qa-v11-helpers.js';
import * as core from '../server/pay/core.js';
import { dayStart } from '../server/pay/payout.js';
import { ENDPOINTS, OBJECTS } from '../site/src/docs/api-reference.mjs';

const enc = encodeURIComponent;
/** 东八区写法：2026-11-15T00:00:00+08:00 */
const cst = (ms) => new Date(ms + 8 * HOUR).toISOString().replace(/\.\d{3}Z$/, '+08:00');
const z = (ms) => new Date(ms).toISOString();

/**
 * 造数据：D0 = 两天前的东八区 0 点。提现、到账各 9 笔，跨三天、正好压在东八区 0 点前后；账本另插 9 条。
 * 商户 mb 也造同样时间的记录（隔离用）。
 */
async function seeded() {
  const w = await world({ fund: 100_000 });
  const D0 = dayStart(Date.now()) - 2 * DAY;
  const times = [D0 - 3 * HOUR, D0 - 1000, D0, D0 + 1000, D0 + 5 * HOUR, D0 + DAY - 1, D0 + DAY, D0 + DAY + 3 * HOUR, D0 + 2 * DAY - 2 * HOUR];
  const wds = { ma: [], mb: [] }, deps = { ma: [], mb: [] };
  for (const who of [w.a, w.b]) {
    const addr = await w.customer(who.id, `cust_${who.id}`);
    for (const [i, t] of times.entries()) {
      const r = await w.api(who, 'POST', 'withdrawals/', { kind: 'payout', chain: i % 3 === 0 ? 'eth' : 'tron', to: i % 3 === 0 ? ETH_TO : TO, amount: String(1 + i), merchant_ref: `${who.id}-R${i}` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await w.db.query('update withdrawals set created_at = $2 where id = $1', [r.body.withdrawal_no, new Date(t)]);
      wds[who.id].push(r.body.withdrawal_no);
      const tx = w.txid();
      // 链上时间比入账时间早 3 分钟：0 点前上链、0 点后入账的那笔按入账时间算进后一天
      const d = await core.recordDeposit(w.db, { txid: tx, logIndex: 0, block: 100 + i, to: addr, amount: (10 + i) * U, time: new Date(t - 3 * 60_000) });
      assert.equal(d.status, 'credited');
      await w.db.query('update deposits set created_at = $2 where id = $1', [d.deposit.id, new Date(t)]);
      deps[who.id].push({ id: String(d.deposit.id), txid: tx, time: t });
      await w.db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref, created_at) values ($1, 'deposit', 1, 0, 0, $2, $3)`, [who.id, `seed${i}`, new Date(t)]);
    }
  }
  // 两笔驳回 / 取消（状态筛选用）
  await core.rejectWithdrawal(w.db, wds.ma[1], '测试驳回', 'admin');
  await core.cancelWithdrawal(w.db, 'ma', wds.ma[2]);
  // 一笔低于 1 USDT 的到账（商户看不到）
  await core.recordDeposit(w.db, { txid: w.txid(), logIndex: 0, block: 999, to: await w.customer('ma', 'cust_ma'), amount: U / 2, time: new Date(D0 + HOUR) });
  return { w, D0, times, wds, deps };
}

/** 一直翻到最后一页，返回所有 items 和每页 */
async function all(w, who, path, limit = 2) {
  const pages = [];
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const r = await w.api(who, 'GET', `${path}${path.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${enc(cursor)}` : ''}`);
    assert.equal(r.status, 200, `${path}：${JSON.stringify(r.body)}`);
    pages.push(r.body.items);
    cursor = r.body.next_cursor;
    if (!cursor) break;
  }
  return { items: pages.flat(), pages };
}
const dbWithdrawals = async (db, mid, from, to) => (await db.query('select id from withdrawals where merchant_id = $1 and created_at >= $2 and created_at < $3 order by created_at, id', [mid, new Date(from), new Date(to)])).map((r) => r.id);
const dbDeposits = async (db, mid, from, to) => (await db.query(`select id from deposits where merchant_id = $1 and result = 'credited' and created_at >= $2 and created_at < $3 order by created_at, id`, [mid, new Date(from), new Date(to)])).map((r) => String(r.id));
const dbLedger = async (db, mid, from, to) => (await db.query('select id from ledger where merchant_id = $1 and created_at >= $2 and created_at < $3 order by created_at, id', [mid, new Date(from), new Date(to)])).map((r) => String(r.id));
const noDup = (ids, where) => assert.equal(new Set(ids).size, ids.length, `${where} 有重复：${ids}`);
const ascending = (items, key, where) => { for (let i = 1; i < items.length; i++) assert.ok(Date.parse(items[i - 1][key]) <= Date.parse(items[i][key]), `${where} 不是从早到晚：${items[i - 1][key]} > ${items[i][key]}`); };

test('TG-2 ① 提现列表 withdrawals/list：任一时间段（东八区、UTC 两种写法）条数和数据库一致、不重不漏、从早到晚；相邻两段首尾相接不重不漏', async () => {
  const { w, D0, times } = await seeded();
  const windows = [
    [D0 - DAY, D0 + 2 * DAY], // 全部
    [D0, D0 + DAY],           // 东八区一个自然日
    [D0 - 1000, D0 + 1000],   // 压在 0 点前后
    [times[4], times[7]],
  ];
  for (const [from, to] of windows) {
    for (const fmt of [cst, z]) {
      const { items } = await all(w, w.a, `withdrawals/list/?from=${enc(fmt(from))}&to=${enc(fmt(to))}`);
      const ids = items.map((x) => x.withdrawal_no);
      noDup(ids, 'withdrawals/list');
      assert.deepEqual(ids, await dbWithdrawals(w.db, 'ma', from, to), `[${fmt(from)}, ${fmt(to)}) 和数据库不一致`);
      ascending(items, 'created_at', 'withdrawals/list');
    }
  }
  const a = (await all(w, w.a, `withdrawals/list/?from=${enc(cst(D0 - DAY))}&to=${enc(cst(D0))}`)).items.map((x) => x.withdrawal_no);
  const b = (await all(w, w.a, `withdrawals/list/?from=${enc(cst(D0))}&to=${enc(cst(D0 + 2 * DAY))}`)).items.map((x) => x.withdrawal_no);
  assert.equal(a.filter((x) => b.includes(x)).length, 0, '相邻两段不能有重叠（区间 [from, to)）');
  assert.deepEqual([...a, ...b], await dbWithdrawals(w.db, 'ma', D0 - DAY, D0 + 2 * DAY), '相邻两段合起来不漏');
  await w.db.end();
});

test('TG-2 ① 提现列表：状态、链筛选；items 和 GET withdrawals/ 同一个对象；不带 from 也是从早到晚', async () => {
  const { w, D0, wds } = await seeded();
  const range = `from=${enc(cst(D0 - DAY))}&to=${enc(cst(D0 + 2 * DAY))}`;
  const rej = (await all(w, w.a, `withdrawals/list/?status=rejected&${range}`)).items;
  assert.deepEqual(rej.map((x) => x.withdrawal_no), [wds.ma[1]]);
  const can = (await all(w, w.a, `withdrawals/list/?status=cancelled&${range}`)).items;
  assert.deepEqual(can.map((x) => x.withdrawal_no), [wds.ma[2]]);
  const eth = (await all(w, w.a, `withdrawals/list/?chain=eth&${range}`)).items;
  assert.deepEqual(eth.map((x) => x.withdrawal_no), [wds.ma[0], wds.ma[3], wds.ma[6]]);
  assert.ok(eth.every((x) => x.chain === 'eth'));
  const pend = (await all(w, w.a, `withdrawals/list/?status=pending&chain=tron&${range}`)).items;
  assert.ok(pend.length > 0 && pend.every((x) => x.status === 'pending' && x.chain === 'tron'));
  const one = await w.api(w.a, 'GET', `withdrawals/?withdrawal_no=${wds.ma[4]}`);
  const inList = (await all(w, w.a, `withdrawals/list/?${range}`)).items.find((x) => x.withdrawal_no === wds.ma[4]);
  assert.deepEqual(inList, one.body, '列表里的对象和按号查的一样');
  const nofrom = (await all(w, w.a, 'withdrawals/list/')).items;
  ascending(nofrom, 'created_at', 'withdrawals/list（不带 from）');
  await w.db.end();
});

test('TG-2 到账按入账时间筛（不是链上时间）：0 点前上链、0 点后入账的算后一天', async () => {
  const { w, D0, deps } = await seeded();
  // times[3] = D0 + 1 秒入账，链上时间 D0 − 2 分 59 秒
  const day = (await all(w, w.a, `deposits/?from=${enc(cst(D0))}&to=${enc(cst(D0 + DAY))}`)).items.map((x) => x.id);
  assert.ok(day.includes(deps.ma[3].id), '入账在当天的要算进当天');
  assert.ok(day.includes(deps.ma[2].id), '正好 0 点入账的算进当天（含 from）');
  const prev = (await all(w, w.a, `deposits/?from=${enc(cst(D0 - DAY))}&to=${enc(cst(D0))}`)).items.map((x) => x.id);
  assert.ok(!prev.includes(deps.ma[3].id) && !prev.includes(deps.ma[2].id), '链上时间在前一天、入账在当天的不能算进前一天');
  assert.ok(prev.includes(deps.ma[1].id));
  await w.db.end();
});

test('TG-2 缺省：withdrawals/list 不带 from = 最近 31 天；deposits、ledger 只带 to 时 from = to − 31 天，只带 from 时 to = 现在，都是从早到晚', async () => {
  const { w, D0 } = await seeded();
  const old = await w.api(w.a, 'POST', 'withdrawals/', { kind: 'payout', chain: 'tron', to: TO, amount: '1', merchant_ref: 'OLD-40D' });
  await w.db.query('update withdrawals set created_at = $2 where id = $1', [old.body.withdrawal_no, new Date(Date.now() - 40 * DAY)]);
  const mid = await w.api(w.a, 'POST', 'withdrawals/', { kind: 'payout', chain: 'tron', to: TO, amount: '1', merchant_ref: 'MID-20D' });
  await w.db.query('update withdrawals set created_at = $2 where id = $1', [mid.body.withdrawal_no, new Date(Date.now() - 20 * DAY)]);
  const nofrom = (await all(w, w.a, 'withdrawals/list/', 5)).items.map((x) => x.withdrawal_no);
  assert.ok(nofrom.includes(mid.body.withdrawal_no), '20 天前的在最近 31 天里');
  assert.ok(!nofrom.includes(old.body.withdrawal_no), '40 天前的不在');
  assert.deepEqual(nofrom, await dbWithdrawals(w.db, 'ma', Date.now() - 31 * DAY, Date.now() + 1000));
  // 只带 to：from = to − 31 天
  const to = D0 + DAY;
  const onlyTo = (await all(w, w.a, `withdrawals/list/?to=${enc(cst(to))}`)).items.map((x) => x.withdrawal_no);
  assert.deepEqual(onlyTo, await dbWithdrawals(w.db, 'ma', to - 31 * DAY, to));
  assert.ok(onlyTo.includes(mid.body.withdrawal_no) && !onlyTo.includes(old.body.withdrawal_no));
  const depTo = (await all(w, w.a, `deposits/?to=${enc(cst(to))}`)).items;
  assert.deepEqual(depTo.map((x) => x.id), await dbDeposits(w.db, 'ma', to - 31 * DAY, to), 'deposits 只带 to：从早到晚、from = to − 31 天');
  const ledTo = (await all(w, w.a, `ledger/?to=${enc(cst(to))}`)).items;
  assert.deepEqual(ledTo.map((x) => x.id), await dbLedger(w.db, 'ma', to - 31 * DAY, to), 'ledger 只带 to：从早到晚');
  const ledFrom = (await all(w, w.a, `ledger/?from=${enc(cst(D0))}`)).items;
  assert.deepEqual(ledFrom.map((x) => x.id), await dbLedger(w.db, 'ma', D0, Date.now() + 1000), 'ledger 只带 from：到现在、从早到晚');
  await w.db.end();
});

test('TG-2 ① 到账 deposits 和账本 ledger 带 from / to：条数和数据库一致、不重不漏、从早到晚；低于 1 USDT 的照旧看不到', async () => {
  const { w, D0, times } = await seeded();
  for (const [from, to] of [[D0 - DAY, D0 + 2 * DAY], [D0, D0 + DAY], [D0 - 1000, D0 + 1000], [times[4], times[7]]]) {
    const deps = (await all(w, w.a, `deposits/?from=${enc(cst(from))}&to=${enc(cst(to))}`)).items;
    noDup(deps.map((x) => x.id), 'deposits');
    assert.deepEqual(deps.map((x) => x.id), await dbDeposits(w.db, 'ma', from, to), `deposits [${cst(from)}, ${cst(to)})`);
    ascending(deps, 'credited_at', 'deposits');
    for (const x of deps) assert.ok(x.time && x.credited_at && x.time !== x.credited_at, '到账返回链上时间 time 和入账时间 credited_at 两个时间');
    assert.ok(deps.every((x) => x.result !== 'below_min'));
    const led = (await all(w, w.a, `ledger/?from=${enc(z(from))}&to=${enc(z(to))}`)).items;
    noDup(led.map((x) => x.id), 'ledger');
    assert.deepEqual(led.map((x) => x.id), await dbLedger(w.db, 'ma', from, to), `ledger [${z(from)}, ${z(to)})`);
    ascending(led, 'created_at', 'ledger');
  }
  // to 不传 = 现在：账本里 recordDeposit 刚记的（现在的时间）也在
  const tail = (await all(w, w.a, `ledger/?from=${enc(cst(Date.now() - 10 * DAY))}`)).items;
  assert.deepEqual(tail.map((x) => x.id), await dbLedger(w.db, 'ma', Date.now() - 10 * DAY, Date.now() + 1000));
  await w.db.end();
});

test('TG-2 deposits 按 txid 查：精确找到那一笔；别的商户的交易哈希查不到', async () => {
  const { w, deps } = await seeded();
  const r = await w.api(w.a, 'GET', `deposits/?txid=${deps.ma[3].txid}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((x) => x.id), [deps.ma[3].id]);
  assert.equal(r.body.items[0].txid, deps.ma[3].txid);
  const cross = await w.api(w.a, 'GET', `deposits/?txid=${deps.mb[3].txid}`);
  assert.equal(cross.status, 200);
  assert.equal(cross.body.items.length, 0, '查不到别的商户的到账');
  await w.db.end();
});

test('TG-2 ② 翻页途中新进记录：已翻过的页结果不变，后面的页不重复、不漏，新记录排在最后', async () => {
  const { w, D0 } = await seeded();
  const from = enc(cst(D0 - DAY));
  for (const kind of ['withdrawals', 'deposits', 'ledger']) {
    const path = { withdrawals: `withdrawals/list/?from=${from}`, deposits: `deposits/?from=${from}`, ledger: `ledger/?from=${from}` }[kind];
    const idOf = (x) => x.withdrawal_no || x.id;
    const p1 = await w.api(w.a, 'GET', `${path}&limit=3`);
    assert.equal(p1.status, 200, `${kind}：${JSON.stringify(p1.body)}`);
    assert.ok(p1.body.next_cursor);
    // 翻页途中：新进一笔提现、一笔到账（各自带出账本记录）
    const nw = await w.api(w.a, 'POST', 'withdrawals/', { kind: 'payout', chain: 'tron', to: TO, amount: '1', merchant_ref: `NEW-${kind}` });
    assert.equal(nw.status, 200);
    const nd = await core.recordDeposit(w.db, { txid: w.txid(), logIndex: 0, block: 5000, to: await w.customer('ma', 'cust_ma'), amount: 3 * U, time: new Date() });
    assert.equal(nd.status, 'credited');
    const again = await w.api(w.a, 'GET', `${path}&limit=3`);
    assert.deepEqual(again.body.items, p1.body.items, `${kind}：已翻过的第一页变了`);
    let cursor = p1.body.next_cursor;
    const seen = p1.body.items.map(idOf);
    while (cursor) {
      const r = await w.api(w.a, 'GET', `${path}&limit=3&cursor=${enc(cursor)}`);
      assert.equal(r.status, 200);
      seen.push(...r.body.items.map(idOf));
      cursor = r.body.next_cursor;
    }
    noDup(seen, kind);
    const expect = kind === 'withdrawals' ? await dbWithdrawals(w.db, 'ma', D0 - DAY, Date.now() + 1000)
      : kind === 'deposits' ? await dbDeposits(w.db, 'ma', D0 - DAY, Date.now() + 1000) : await dbLedger(w.db, 'ma', D0 - DAY, Date.now() + 1000);
    assert.deepEqual(seen, expect, `${kind}：翻完的结果要和数据库一致（含新进的）`);
    if (kind === 'withdrawals') assert.equal(seen.at(-1), nw.body.withdrawal_no, '新进的提现排在最后');
  }
  await w.db.end();
});

test('TG-2 ③ 超 31 天、from 晚于 to、时间格式错、没带时区：三个接口都返回 422 invalid_param；正好 31 天可以', async () => {
  const { w, D0 } = await seeded();
  const bad = [
    [`from=${enc(cst(D0 - 32 * DAY))}&to=${enc(cst(D0))}`, 'to'],
    [`from=${enc(cst(D0))}&to=${enc(cst(D0 - HOUR))}`, 'from'],
    [`from=yesterday&to=${enc(cst(D0))}`, 'from'],
    [`from=${enc(cst(D0 - DAY))}&to=2026-13-01T00:00:00Z`, 'to'],
    [`from=${enc('2026-11-15T00:00:00')}&to=${enc(cst(D0))}`, 'from'], // 没带时区
    [`from=${enc(cst(D0 - 40 * DAY))}`, 'to'], // to 不传 = 现在，也超 31 天
  ];
  for (const base of ['withdrawals/list/', 'deposits/', 'ledger/']) {
    for (const [qs, field] of bad) {
      const r = await w.api(w.a, 'GET', `${base}?${qs}`);
      assert.equal(r.status, 422, `${base}?${qs} 应该 422，实际 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(r.body.error.code, 'invalid_param');
      assert.equal(r.body.error.field, field, `${base}?${qs}`);
    }
    const ok = await w.api(w.a, 'GET', `${base}?from=${enc(cst(D0 - 31 * DAY))}&to=${enc(cst(D0))}`);
    assert.equal(ok.status, 200, `${base} 正好 31 天要可以：${JSON.stringify(ok.body).slice(0, 200)}`);
  }
  await w.db.end();
});

test('TG-2 ③ from、to 都不带的旧调用：deposits、ledger 返回顺序和改前一致（按 id 从新到旧），旧的 cursor 翻页照旧', async () => {
  const { w } = await seeded();
  for (const [path, table, extra] of [['deposits/', 'deposits', `and result = 'credited'`], ['ledger/', 'ledger', '']]) {
    const { items } = await all(w, w.a, path, 4);
    const expect = (await w.db.query(`select id from ${table} where merchant_id = 'ma' ${extra} order by id desc`)).map((r) => String(r.id));
    assert.deepEqual(items.map((x) => x.id), expect, `${path} 不带 from 时顺序要和以前一样（从新到旧）`);
  }
  // 带客户、是否匹配的旧筛选照旧
  const m = await w.api(w.a, 'GET', 'deposits/?customer_id=cust_ma&matched=false');
  assert.equal(m.status, 200);
  assert.ok(m.body.items.length > 0 && m.body.items.every((x) => x.customer_id === 'cust_ma' && x.order_no === null));
  await w.db.end();
});

test('TG-2 ④ 查不到别的商户的记录（提现列表、到账、账本）', async () => {
  const { w, D0, wds, deps } = await seeded();
  const range = `from=${enc(cst(D0 - DAY))}&to=${enc(cst(D0 + 2 * DAY))}`;
  const wl = (await all(w, w.a, `withdrawals/list/?${range}`)).items.map((x) => x.withdrawal_no);
  assert.ok(wl.length > 0);
  assert.ok(!wl.some((x) => wds.mb.includes(x)), '提现列表混进了别的商户的单');
  const dl = (await all(w, w.a, `deposits/?${range}`)).items;
  assert.ok(!dl.some((x) => deps.mb.some((d) => d.id === x.id)), '到账混进了别的商户的');
  const ll = (await all(w, w.a, `ledger/?${range}`)).items.map((x) => x.id);
  const mbLedger = (await w.db.query(`select id from ledger where merchant_id = 'mb'`)).map((r) => String(r.id));
  assert.ok(!ll.some((x) => mbLedger.includes(x)), '账本混进了别的商户的');
  await w.db.end();
});

test('TG-2 ⑤ 开发者文档：GET withdrawals/list/ 和 from、to、txid 参数都写了，写明区间、31 天、从早到晚', () => {
  const list = ENDPOINTS.find((e) => e.method === 'GET' && e.path === 'withdrawals/list/');
  assert.ok(list, '文档要有 GET withdrawals/list/');
  assert.ok(list.list, 'withdrawals/list/ 是列表接口（{ items, next_cursor }）');
  assert.deepEqual(list.returns, ['Withdrawal']);
  const names = (e) => (e.query || []).map((q) => q[0]);
  for (const p of ['status', 'chain', 'from', 'to', 'cursor', 'limit']) assert.ok(names(list).includes(p), `withdrawals/list/ 缺参数 ${p}`);
  const deps = ENDPOINTS.find((e) => e.method === 'GET' && e.path === 'deposits/');
  for (const p of ['from', 'to', 'txid']) assert.ok(names(deps).includes(p), `deposits/ 缺参数 ${p}`);
  assert.match(JSON.stringify(deps.query.find((q) => q[0] === 'from')[3]), /入账时间/, 'deposits/ 的 from 要写按入账时间筛');
  const ca = OBJECTS.Deposit.find((f) => f[0] === 'credited_at');
  assert.ok(ca, 'Deposit 对象要有 credited_at（入账时间）');
  assert.equal(ca[1], 'time');
  const led = ENDPOINTS.find((e) => e.method === 'GET' && e.path === 'ledger/');
  for (const p of ['from', 'to']) assert.ok(names(led).includes(p), `ledger/ 缺参数 ${p}`);
  for (const e of [list, deps, led]) {
    const from = e.query.find((q) => q[0] === 'from');
    assert.equal(from[1], 'time');
    const text = JSON.stringify([e.query, e.note || []]);
    assert.match(text, /31/, `${e.path} 要写一次最多 31 天`);
    assert.match(text, /oldest first|从早到晚/, `${e.path} 要写带 from 时从早到晚`);
    assert.ok((e.errors || []).includes('invalid_param'), `${e.path} 的错误码要有 invalid_param`);
  }
});
