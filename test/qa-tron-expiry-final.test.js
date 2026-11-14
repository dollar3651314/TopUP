// 测试先写（第 3 批安全终审）：TRON 打款"过期退回"的余量太小（PoC T1）。
// 场景：签名在快过期时才交（原文出来后 28 分 50 秒），交易在过期前上了链；查交易的后端落后（txInfo 查不到），
//   某一轮看到的已固化区块时间刚过过期时间 61 秒 → 单回到已审核 → 再签一次 → 付两次。
// 口径（研发定的规则）：
//   - 交签名的截止：原文出来后 25 分钟（离过期不到 5 分钟）→ 409 plan_expired，不广播；
//   - 退回已审核要同时满足：链上时间 > 原文过期时间 + 5 分钟、txInfo 查不到，而且隔至少 5 分钟的两轮都这样；
//     第一轮只记下 withdrawals.gone_suspect_at，不退回。
// 每个 T1 变体最后都只能有 1 笔链上转账。
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
import { confirmWithdrawals } from '../server/pay/tick.js';
import { decodeRaw } from '../server/pay/txcodec.js';

const U = 1_000_000;
const MIN = 60_000;
const HOT_KEY = hex.decode('11'.repeat(32)); // 公开的测试私钥（和 test/pay-wallet.test.js 同一个）
const HOT = addressOfPrivateKey(HOT_KEY);
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const PAYEE = 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q';

async function setup() {
  const db = await createTestDb(); await migrate(db);
  const tron = createFakeTron();
  await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  await db.query('update balances set available = available + $1', [1000 * U]);
  const clock = { t: Date.now() };
  const api = createWalletApi({ db, tron, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => true, now: () => clock.t });
  const call = async (a, body) => {
    const res = await api(new Request(`https://x/api/wallet/?a=${a}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } }));
    return { status: res.status, body: await res.json() };
  };
  tron.accounts.set(HOT, { activated: true, trx: 100 * U, trc20: { [tron.contract]: 1000 * U } });
  const w = await core.requestWithdrawal(db, await core.getMerchant(db, 'm1'), { kind: 'payout', chain: 'tron', to: PAYEE, amount: 100 * U, source: 'web' });
  const wid = w.withdrawal_no;
  assert.deepEqual((await approvePayouts(db, { ids: [wid], actor: 'admin', now: clock.t })).approved, [wid]);
  /** 凑批 → 等 waitMs → 动态码 → 交签名 */
  const signAfter = async (waitMs) => {
    const pr = await call('withdraw-plan', { ids: [wid] });
    if (pr.status !== 200) return { plan: null, r: pr };
    const plan = pr.body;
    clock.t += waitMs;
    const sigs = Object.fromEntries(plan.steps.map((s) => [s.txID, signTxId(s.txID, HOT_KEY)]));
    assert.equal((await call('sign-verify', { batch_id: plan.batch_id, code: '123456' })).status, 200);
    return { plan, exp: decodeRaw(plan.steps[0].rawHex).expiration, r: await call('sign-submit', { batch_id: plan.batch_id, signatures: sigs }) };
  };
  const row = async () => (await db.query('select * from withdrawals where id = $1', [wid]))[0];
  /** 链上转给收款人的不同交易（按交易号去重） */
  const transfers = () => new Set(tron.broadcasts.filter((d) => d.contracts[0].to === PAYEE).map((d) => d.txId));
  return { db, tron, call, clock, wid, signAfter, row, transfers };
}
/** 一轮确认：lag 时查交易的后端落后（txInfo 查不到），链上时间按 chainTime */
const round = (t, { lag, chainTime }) => confirmWithdrawals(t.db, { ...t.tron, txInfo: async (id) => (lag ? null : t.tron.txInfo(id)), solidBlock: async () => ({ number: 1, time: chainTime }) }, { now: t.clock.t });

test('TRON 交签名截止提前：原文出来后 25 分钟起（离过期不到 5 分钟）交签名 409 plan_expired、不广播；24 分钟时还能交', async () => {
  const late = await setup();
  const r1 = await late.signAfter(25 * MIN + 1000);
  assert.equal(r1.r.status, 409, `原文出来后 25 分钟交签名应该 409，实际 ${r1.r.status} ${JSON.stringify(r1.r.body)}`);
  assert.equal(r1.r.body.error.code, 'plan_expired');
  assert.equal(late.tron.broadcasts.length, 0, '不广播');
  assert.notEqual((await late.row()).status, 'broadcast');
  // PoC 里的时间点：28 分 50 秒
  const poc = await setup();
  const r2 = await poc.signAfter(28 * MIN + 50_000);
  assert.equal(r2.r.status, 409, `28 分 50 秒交签名应该 409，实际 ${r2.r.status}`);
  assert.equal(poc.tron.broadcasts.length, 0);
  // 对照：24 分钟时照常能交
  const ok = await setup();
  const r3 = await ok.signAfter(24 * MIN);
  assert.equal(r3.r.status, 200, JSON.stringify(r3.r.body));
  assert.equal(ok.transfers().size, 1);
});

test('TRON 过期退回要两轮（隔至少 5 分钟）、链上时间过了过期时间 5 分钟以上：第一轮只记 gone_suspect_at，不退回', async () => {
  const t = await setup();
  const { exp, r } = await t.signAfter(1 * MIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 交易一直没确认（替身里没有 confirm）：链上一直查不到
  // 链上时间只过了过期时间 4 分 59 秒：不算过期，不记嫌疑
  t.clock.t = exp + 5 * MIN;
  await round(t, { lag: false, chainTime: exp + 5 * MIN - 1000 });
  assert.equal((await t.row()).status, 'broadcast', '链上时间没过过期时间 5 分钟，不退回');
  assert.equal((await t.row()).gone_suspect_at, null, '没过余量不记嫌疑');
  // 第一轮：链上时间过了过期时间 5 分钟以上、查不到 → 只记下时间
  t.clock.t = exp + 6 * MIN;
  await round(t, { lag: false, chainTime: exp + 5 * MIN + 1000 });
  let w = await t.row();
  assert.equal(w.status, 'broadcast', '第一轮不退回');
  assert.ok(w.gone_suspect_at, '第一轮记下 gone_suspect_at');
  // 不到 5 分钟的第二轮：还不退回
  t.clock.t = exp + 10 * MIN;
  await round(t, { lag: false, chainTime: exp + 9 * MIN });
  assert.equal((await t.row()).status, 'broadcast', '两轮隔不到 5 分钟，不退回');
  // 隔 5 分钟以上的第二轮仍是这样 → 回到已审核
  t.clock.t = exp + 11 * MIN + 1000;
  await round(t, { lag: false, chainTime: exp + 11 * MIN + 1000 });
  w = await t.row();
  assert.equal(w.status, 'approved', '隔 5 分钟以上两轮都查不到：回到已审核');
});

test('TRON PoC T1 各变体：快过期才交签名、交易其实已上链、某一轮查交易的后端落后 → 不退回，最后只有 1 笔链上转账', async () => {
  // 变体：签名交得最晚（截止前 1 秒，即原文出来后 24 分 59 秒）；落后那一轮看到的固化区块时间 = 过期 + margin
  for (const margin of [59_000, 61_000, 5 * MIN, 5 * MIN + 1000, 10 * MIN]) {
    const t = await setup();
    const { plan, exp, r } = await t.signAfter(24 * MIN + 59_000);
    assert.equal(r.status, 200, `margin ${margin / 1000}s：截止前交签名应该能交（${JSON.stringify(r.body)}）`);
    t.tron.confirm([...t.transfers()][0], true); // 已上链（过期前）
    // 落后的一轮
    t.clock.t = exp + margin;
    await round(t, { lag: true, chainTime: exp + margin });
    // 运营看到"已审核"就会再签一次
    if ((await t.row()).status === 'approved') {
      // 再签一次是在真实时间里发生的（凑批时间按数据库时间记）：服务器时钟先拨回现在，签完再拨回去
      const keep = t.clock.t;
      t.clock.t = Date.now();
      const again = await t.signAfter(1000);
      t.clock.t = keep;
      if (again.plan) for (const s of again.plan.steps) if (!t.tron.txs.get(s.txID)) t.tron.confirm(s.txID, true);
    }
    // 隔 6 分钟、正常后端的一轮
    t.clock.t = exp + margin + 6 * MIN;
    await round(t, { lag: false, chainTime: exp + margin + 6 * MIN });
    assert.equal(t.transfers().size, 1, `margin ${margin / 1000}s：链上有 ${t.transfers().size} 笔不同的转账（付了两次）`);
    assert.equal((await t.row()).status, 'completed', `margin ${margin / 1000}s：最后应该是已完成`);
    assert.equal((await t.row()).txid, plan.steps[0].txID);
    const led = await t.db.query(`select count(*)::int n from ledger where ref = $1 and type = 'withdraw'`, [t.wid]);
    assert.equal(led[0].n, 1, `margin ${margin / 1000}s：账本只扣一次`);
  }
  // PoC 原样的时间点（28 分 50 秒交签名）：现在交不上，自然没有第二笔
  const p = await setup();
  const { r } = await p.signAfter(28 * MIN + 50_000);
  assert.equal(r.status, 409);
  assert.equal(p.transfers().size, 0);
});
