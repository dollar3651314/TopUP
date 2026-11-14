// 测试先写（第 3 批修复轮）：TRON 打款自动拆批（withdraw-plan、凑批卡片 payout-plans）。
// 口径（研发修复说明）：和以太坊 / BSC 一样，这一批取 min(每批上限, 热钱包余额)、最多 20 笔，按审核先后装，装不下的留到下一轮；
//   接口多返回 count（这一批几笔）、left（剩几笔留到下一轮）；一笔都装不下才 409。
// 场景：热钱包 10,000 + 3 笔各 4,000 → 这一批 2 笔、剩 1 笔；热钱包 50,000 + 5 笔各 4,500 → 受每批 20,000 限制（4 笔、剩 1 笔）；
//   超过 20 笔按 20 笔拆；同一笔不会同时进两个批次（重凑、并发凑批、签了一批再凑）；签完一批后剩下的下一轮能继续签。
// 上限用默认值：单笔 5,000、每批 20,000、每天 30,000（server/pay/payout.js PAYOUT_DEFAULTS）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '@scure/base';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { approvePayouts } from '../server/pay/payout.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { signTxId, addressOfPrivateKey } from '../server/pay/signing.js';
import { runTick } from '../server/pay/tick.js';

const U = 1_000_000;
const HOT_KEY = hex.decode('11'.repeat(32)); // 公开的测试私钥（和 test/pay-wallet.test.js 同一个）
const HOT = addressOfPrivateKey(HOT_KEY);
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
// 每笔一个不同的收款地址：替身节点出交易时时间戳只到毫秒，同一毫秒里给同一地址、同一金额出的两笔交易原文完全一样（交易号相同），
// 那就成了"一笔交易记两笔打款"，和这里要测的拆批无关（真实节点两次请求不会落在同一毫秒）
const payee = (i) => addressOfPrivateKey(hex.decode((i + 0x100).toString(16).padStart(64, '0')));

async function setup({ now } = {}) {
  const db = await createTestDb(); await migrate(db);
  const tron = createFakeTron();
  await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  await db.query('update balances set available = available + $1', [100_000 * U]);
  const m1 = await core.getMerchant(db, 'm1');
  const api = createWalletApi({ db, tron, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => true, ...(now ? { now } : {}) });
  const call = async (a, body) => {
    const res = await api(new Request(`https://x/api/wallet/?a=${a}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } }));
    return { status: res.status, body: await res.json() };
  };
  const setHot = (usdt) => tron.accounts.set(HOT, { activated: true, trx: 1_000 * U, trc20: { [tron.contract]: usdt * U } });
  /** 建 n 笔 TRON 打款（各 amount USDT）；approveOrder 给出审核先后（下标），每笔审核时间相差 1 秒（不靠同一毫秒碰运气） */
  const make = async (n, amount, approveOrder = null) => {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'tron', to: payee(i), amount: amount * U, source: 'web' })).withdrawal_no);
    const order = approveOrder || ids.map((_, i) => i);
    const t0 = Date.now() - 3_600_000;
    for (const [k, i] of order.entries()) {
      const r = await approvePayouts(db, { ids: [ids[i]], actor: 'admin', now: t0 + k * 1000 });
      assert.deepEqual(r.approved, [ids[i]], `前提：第 ${i} 笔审核通过（${JSON.stringify(r.refused)}）`);
    }
    return { ids, approvedOrder: order.map((i) => ids[i]) };
  };
  const plan = (ids) => call('withdraw-plan', { ids });
  /** 签名 + 动态码 + 交签名 */
  const sign = async (p) => {
    const sigs = Object.fromEntries(p.steps.map((s) => [s.txID, signTxId(s.txID, HOT_KEY)]));
    assert.equal((await call('sign-verify', { batch_id: p.batch_id, code: '123456' })).status, 200);
    const r = await call('sign-submit', { batch_id: p.batch_id, signatures: sigs });
    assert.equal(r.status, 200, `交签名失败：${JSON.stringify(r.body)}`);
    return r.body;
  };
  /** 已广播的都确认、跑一次定时任务 */
  const settle = async () => {
    for (const d of tron.broadcasts) if (!tron.txs.get(d.txId)) tron.confirm(d.txId, true);
    await runTick({ db, tron, getTarget: async () => null });
  };
  const statusOf = async (id) => (await db.query('select status, batch_id from withdrawals where id = $1', [id]))[0];
  const tronCard = async () => (await call('payout-plans')).body.cards.find((c) => c.chain === 'tron');
  /** 不变量：没作废的 TRON 批次之间没有重复的单；每笔单的 batch_id 指向的批次里确实有它 */
  const assertNoOverlap = async () => {
    const bs = await db.query(`select id, status, item_ids from payout_tx_batches where chain = 'tron' and status not in ('expired', 'failed')`);
    const seen = new Map();
    for (const b of bs) for (const x of b.item_ids) {
      assert.ok(!seen.has(x), `${x} 同时在两个批次里：${seen.get(x)} 和 ${b.id}`);
      seen.set(x, b.id);
    }
    const ws = await db.query(`select id, batch_id from withdrawals where chain = 'tron' and batch_id is not null`);
    for (const w of ws) assert.equal(seen.get(w.id), w.batch_id, `${w.id} 的 batch_id 是 ${w.batch_id}，但没作废的批次里它在 ${seen.get(w.id)}`);
    const planned = bs.filter((b) => b.status === 'planned');
    assert.ok(planned.length <= 1, `同时有 ${planned.length} 个没签名的 TRON 批次：${planned.map((b) => b.id).join('、')}`);
  };
  return { db, tron, call, setHot, make, plan, sign, settle, statusOf, tronCard, assertNoOverlap };
}

test('TRON 自动拆批：热钱包 10,000、已审核 3 笔各 4,000 → 这一批 2 笔（按审核先后）、剩 1 笔；凑批卡片也写 2 笔、剩 1 笔', async () => {
  const t = await setup();
  t.setHot(10_000);
  // 建单顺序 0、1、2，审核顺序 2、0、1：这一批应该装审核最早的 2、0
  const { ids, approvedOrder } = await t.make(3, 4_000, [2, 0, 1]);
  const card = await t.tronCard();
  assert.equal(card.approved_count, 3, '前提：凑批卡片看到 3 笔已审核');
  assert.equal(card.blocked, null, `能签一部分就不该挡住：${card.blocked}`);
  assert.deepEqual([card.batch_count, card.left_count], [2, 1], '凑批卡片：这一批 2 笔、剩 1 笔下一轮');
  assert.equal(card.batch_total, '8000.00');
  const r = await t.plan(ids);
  assert.equal(r.status, 200, `部分装得下就不该 409：${JSON.stringify(r.body)}`);
  assert.deepEqual([r.body.count, r.body.left], [2, 1]);
  assert.deepEqual(r.body.steps.map((s) => s.withdrawal_id).sort(), approvedOrder.slice(0, 2).sort(), '按审核先后装：审核最早的两笔');
  assert.equal(r.body.steps.length, 2);
  for (const s of r.body.steps) assert.equal(Number(String(s.expect.amount).replace(/,/g, '')), 4_000, '接口里的金额是 USDT');
  assert.equal((await t.statusOf(approvedOrder[2])).status, 'approved', '装不下的一笔留在已审核');
  assert.equal((await t.statusOf(approvedOrder[2])).batch_id, null);
  await t.assertNoOverlap();
});

test('TRON 自动拆批：热钱包 50,000、已审核 5 笔各 4,500 → 受每批 20,000 限制，这一批 4 笔（18,000）、剩 1 笔；卡片写明是每批上限', async () => {
  const t = await setup();
  t.setHot(50_000);
  const { ids, approvedOrder } = await t.make(5, 4_500);
  const card = await t.tronCard();
  assert.equal(card.by, 'per_batch', `这一批的上限应该是每批上限，实际 ${card.by}`);
  assert.equal(card.cap, '20000.00');
  assert.deepEqual([card.batch_count, card.left_count, card.batch_total], [4, 1, '18000.00']);
  const r = await t.plan(ids);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.count, r.body.left], [4, 1]);
  assert.deepEqual(r.body.steps.map((s) => s.withdrawal_id).sort(), approvedOrder.slice(0, 4).sort());
  const sum = r.body.steps.reduce((s, x) => s + Number(String(x.expect.amount).replace(/,/g, '')), 0);
  assert.equal(sum, 18_000, `这一批合计 ${sum} USDT，应该是 4 × 4,500 = 18,000（不超过每批上限 20,000）`);
  await t.assertNoOverlap();
});

test('TRON 自动拆批：超过 20 笔按 20 笔拆（25 笔 → 这一批 20 笔、剩 5 笔），剩下的下一轮装', async () => {
  const t = await setup();
  t.setHot(10_000);
  const { ids, approvedOrder } = await t.make(25, 10);
  const card = await t.tronCard();
  assert.deepEqual([card.batch_count, card.left_count], [20, 5]);
  const r = await t.plan(ids);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.count, r.body.left, r.body.steps.length], [20, 5, 20]);
  assert.deepEqual(r.body.steps.map((s) => s.withdrawal_id).sort(), approvedOrder.slice(0, 20).sort(), '按审核先后装前 20 笔');
  await t.sign(r.body);
  await t.settle();
  const rest = approvedOrder.slice(20);
  const r2 = await t.plan(rest);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual([r2.body.count, r2.body.left], [5, 0]);
  assert.deepEqual(r2.body.steps.map((s) => s.withdrawal_id).sort(), [...rest].sort());
  await t.assertNoOverlap();
});

test('TRON 自动拆批：一笔都装不下才 409（热钱包 3,000、每笔 4,000 → hot_wallet_insufficient，单都留在已审核）', async () => {
  const t = await setup();
  t.setHot(3_000);
  const { ids } = await t.make(2, 4_000);
  const r = await t.plan(ids);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'hot_wallet_insufficient');
  for (const id of ids) assert.deepEqual(await t.statusOf(id), { status: 'approved', batch_id: null });
  assert.equal((await t.tronCard()).blocked, 'hot_balance');
  assert.equal((await t.db.query(`select count(*)::int n from payout_tx_batches where chain = 'tron' and status = 'planned'`))[0].n, 0, '一笔都装不下不该留下批次');
});

test('TRON 自动拆批：同一笔不会同时进两个批次（没签又凑、两次凑批同时进来、签了一批后把全部单再交一次）', async () => {
  const t = await setup();
  t.setHot(10_000);
  const { ids, approvedOrder } = await t.make(3, 4_000);
  // ① 凑了没签（页面关了）：这 2 笔已经在没签名的批次里，再把全部 3 笔交一次 → 409（不会顺带进第二个批次），什么都不变
  const p1 = (await t.plan(ids)).body;
  const re = await t.plan(ids);
  assert.equal(re.status, 409, '还在没签名批次里的单不能再凑进别的批次');
  assert.equal((await t.db.query('select status from payout_tx_batches where id = $1', [p1.payout_batch]))[0].status, 'planned');
  await t.assertNoOverlap();
  // 页面只交"已审核、不在批次里"的那 1 笔：上一批没签名的作废（2 笔回到已审核），新一批只有这 1 笔
  const solo = await t.plan([approvedOrder[2]]);
  assert.equal(solo.status, 200, JSON.stringify(solo.body));
  assert.deepEqual(solo.body.steps.map((s) => s.withdrawal_id), [approvedOrder[2]]);
  assert.equal((await t.db.query('select status from payout_tx_batches where id = $1', [p1.payout_batch]))[0].status, 'expired', '上一批没签名的作废');
  await t.assertNoOverlap();
  // 作废重凑（页面的"作废重凑"）：3 笔都回到已审核
  assert.equal((await t.call('payout-void', { id: solo.body.payout_batch })).status, 200);
  for (const id of ids) assert.deepEqual(await t.statusOf(id), { status: 'approved', batch_id: null });
  // ② 两次凑批同时进来（双击、两个窗口）：最多一次成功，不能有同一笔进两个批次
  const both = await Promise.all([t.plan(ids), t.plan(ids)]);
  assert.ok(both.some((r) => r.status === 200), `两次同时凑批至少一次成功：${JSON.stringify(both.map((r) => [r.status, r.body?.error?.code]))}`);
  await t.assertNoOverlap();
  // 拿最后还有效的那一批去签
  const [live] = await t.db.query(`select id from payout_tx_batches where chain = 'tron' and status = 'planned'`);
  const p3 = both.find((r) => r.status === 200 && r.body.payout_batch === live.id).body;
  await t.sign(p3);
  await t.assertNoOverlap();
  // ③ 签了一批（已广播）后，把全部 3 笔再交一次：已经在批次里的不能再进新批次
  const again = await t.plan(ids);
  assert.equal(again.status, 409, '已广播的单不能再凑批');
  const inFlight = p3.steps.map((s) => s.withdrawal_id);
  for (const id of inFlight) assert.equal((await t.statusOf(id)).batch_id, live.id, `${id} 应该还在已签名的那一批里`);
  // 只交剩下的那一笔：新的一批只有它
  const left = approvedOrder.filter((x) => !inFlight.includes(x));
  assert.equal(left.length, 1);
  t.setHot(10_000); // 已广播的还没确认，按链上余额：补足热钱包
  const p4 = await t.plan(left);
  assert.equal(p4.status, 200, JSON.stringify(p4.body));
  assert.deepEqual(p4.body.steps.map((s) => s.withdrawal_id), left);
  await t.assertNoOverlap();
});

test('TRON 自动拆批：签完一批后，剩下的下一轮能继续签；全部完成，每笔只付一次、账本只扣一次', async () => {
  const t = await setup();
  t.setHot(10_000);
  const { ids, approvedOrder } = await t.make(3, 4_000);
  const p1 = (await t.plan(ids)).body;
  assert.deepEqual([p1.count, p1.left], [2, 1]);
  await t.sign(p1);
  await t.settle();
  for (const id of approvedOrder.slice(0, 2)) assert.equal((await t.statusOf(id)).status, 'completed');
  // 第一批付掉 8,000，热钱包剩 2,000：剩下的 4,000 这一轮装不下（一笔都装不下 → 409），卡片说热钱包不够
  t.setHot(2_000);
  const left = approvedOrder.slice(2);
  const blocked = await t.plan(left);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'hot_wallet_insufficient');
  const c1 = await t.tronCard();
  assert.deepEqual([c1.approved_count, c1.batch_count, c1.blocked], [1, 0, 'hot_balance']);
  // 补了热钱包之后的下一轮：剩下的一笔能凑、能签、能完成
  t.setHot(10_000);
  const c2 = await t.tronCard();
  assert.deepEqual([c2.batch_count, c2.left_count, c2.blocked], [1, 0, null]);
  const p2 = await t.plan(left);
  assert.equal(p2.status, 200, JSON.stringify(p2.body));
  assert.deepEqual([p2.body.count, p2.body.left], [1, 0]);
  await t.sign(p2.body);
  await t.settle();
  for (const id of ids) assert.equal((await t.statusOf(id)).status, 'completed');
  // 每笔只有一笔链上转账（按交易号去重：同一份已签名交易重发不算第二笔）、账本只扣一次
  const txOf = new Map();
  for (const d of t.tron.broadcasts) {
    const step = [...p1.steps, ...p2.body.steps].find((s) => s.txID === d.txId);
    if (step) txOf.set(step.withdrawal_id, new Set([...(txOf.get(step.withdrawal_id) || []), d.txId]));
  }
  for (const id of ids) assert.equal(txOf.get(id)?.size, 1, `${id} 有 ${txOf.get(id)?.size || 0} 笔不同的链上转账`);
  for (const id of ids) assert.equal((await t.db.query(`select count(*)::int n from ledger where ref = $1 and type = 'withdraw'`, [id]))[0].n, 1);
  const [b] = await t.db.query(`select frozen::bigint f from balances where merchant_id = 'm1'`);
  assert.equal(Number(b.f), 0, '冻结清零');
  await t.assertNoOverlap();
});

test('TRON 同一批里两笔收款地址、金额都相同：出的是 2 笔不同的交易（交易号不同），链上 2 笔转账，每笔打款各对应自己那一笔', { timeout: 60_000 }, async () => {
  // 服务器时钟：凑批这一次请求里停在同一毫秒（循环里连着出交易，同一毫秒里出好几笔是常态）；其余时候是真实时间
  const clock = { frozen: null };
  const t = await setup({ now: () => clock.frozen ?? Date.now() });
  t.setHot(10_000);
  const db = t.db;
  const m1 = await core.getMerchant(db, 'm1');
  const to = payee(7);
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'tron', to, amount: 100 * U, source: 'web' })).withdrawal_no);
  const t0 = Date.now() - 3_600_000;
  for (const [k, id] of ids.entries()) assert.deepEqual((await approvePayouts(db, { ids: [id], actor: 'admin', now: t0 + k * 1000 })).approved, [id]);
  // 节点替身：前两次出交易落在同一毫秒（服务器循环里连着出 20 笔，真实节点上也会碰到），之后的请求时间往后走
  const orig = t.tron.buildUsdtTransfer.bind(t.tron);
  const T = Date.now();
  let calls = 0;
  t.tron.buildUsdtTransfer = async (p) => {
    const at = T + Math.max(0, calls++ - 1);
    const real = Date.now;
    Date.now = () => at;
    try { return await orig(p); } finally { Date.now = real; }
  };
  clock.frozen = Date.now();
  const r = await t.plan(ids);
  clock.frozen = null;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.steps.length, 2, '两笔都在这一批');
  const txids = r.body.steps.map((s) => s.txID);
  assert.equal(new Set(txids).size, 2, `同一批里出了两份一样的交易（交易号 ${txids.join('、')}）：只会上链一笔，两笔打款却都会记完成`);
  await t.sign(r.body);
  const onchain = new Set(t.tron.broadcasts.filter((d) => d.contracts[0].to === to).map((d) => d.txId));
  assert.equal(onchain.size, 2, `链上应该有 2 笔转账，实际 ${onchain.size} 笔`);
  const rows = await db.query('select id, txid from withdrawals where id = any($1::text[])', [ids]);
  assert.equal(new Set(rows.map((x) => x.txid)).size, 2, `两笔打款记的交易号应该不同：${JSON.stringify(rows)}`);
});
