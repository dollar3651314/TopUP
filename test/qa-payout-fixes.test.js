// 测试复核（第 3 批修复轮）：TRON 打款批次的作废 / 过期、广播超时的退回时机、已审核的单驳回。
// 1. 没签名的批次可以作废（单回到已审核）；作废后再交这一批的签名 409；已经交了签名的批次不能作废（409）。
// 2. 交易原文快过期（出原文后 29 分钟起）再交签名：409 plan_expired，不广播。
// 3. 广播超时（结果不明）：交易过期前（SIGN_TTL 30 分钟 + 5 分钟余量）一直是已广播、不退回；过期后链上仍查不到才回到已审核，冻结不动。
//    过期按链上区块时间判断（tron.solidBlock().time 过了原文里的过期时间 5 分钟以上、txInfo 仍查不到，隔至少 5 分钟两轮都这样，第一轮记 gone_suspect_at）；服务器时钟走快了、链上时间还没过期时不退回。
// 4. 已审核、还没凑进批次的单可以驳回：原因必填；退冻结、发回调；已凑进批次的不能驳回（409）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '@scure/base';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { signTxId, addressOfPrivateKey } from '../server/pay/signing.js';
import { runTick } from '../server/pay/tick.js';

const U = 1_000_000;
const MIN = 60_000;
const HOT_KEY = hex.decode('11'.repeat(32)); // 公开的测试私钥（config/wallets.json local.hot 同一个）
const HOT = addressOfPrivateKey(HOT_KEY);
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const PAYEE = 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q';

async function setup() {
  const db = await createTestDb(); await migrate(db);
  const tron = createFakeTron();
  let clock = Date.now();
  await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 1 * U, min: 0 } });
  await db.query('update balances set available = available + $1', [1000 * U]);
  const api = createWalletApi({ db, tron, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => true, now: () => clock });
  const call = async (a, body) => {
    const res = await api(new Request(`https://x/api/wallet/?a=${a}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } }));
    return { status: res.status, body: await res.json() };
  };
  tron.accounts.set(HOT, { activated: true, trx: 100 * U, trc20: { [tron.contract]: 1000 * U } });
  const newPayout = async (amount = 100) => {
    const w = await core.requestWithdrawal(db, await core.getMerchant(db, 'm1'), { kind: 'payout', chain: 'tron', to: PAYEE, amount: amount * U, source: 'web' });
    return w.withdrawal_no;
  };
  const approve = async (id) => assert.equal((await call('payout-approve', { ids: [id] })).status, 200);
  const plan = async (id) => {
    const r = await call('withdraw-plan', { ids: [id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sigs = Object.fromEntries(r.body.steps.map((s) => [s.txID, signTxId(s.txID, HOT_KEY)]));
    assert.equal((await call('sign-verify', { batch_id: r.body.batch_id, code: '123456' })).status, 200);
    return { ...r.body, sigs };
  };
  const row = async (id) => (await db.query('select status, batch_id, txid from withdrawals where id = $1', [id]))[0];
  const money = async () => (await db.query(`select available::bigint a, frozen::bigint f from balances where merchant_id = 'm1'`))[0];
  return { db, tron, call, newPayout, approve, plan, row, money, advance: (ms) => (clock += ms), now: () => clock };
}

test('TRON 打款批次：没签名的可以作废（单回到已审核），作废后再交签名 409；已交签名的不能作废', async () => {
  const t = await setup();
  const id = await t.newPayout();
  await t.approve(id);
  const p = await t.plan(id);
  assert.ok(p.payout_batch, '凑批返回打款批次号');
  assert.equal((await t.row(id)).status, 'signing');
  const v = await t.call('payout-void', { id: p.payout_batch });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const r = await t.row(id);
  assert.equal(r.status, 'approved', '作废后这一笔回到已审核');
  assert.equal(r.batch_id, null);
  const late = await t.call('sign-submit', { batch_id: p.batch_id, signatures: p.sigs });
  assert.equal(late.status, 409, `作废后再交签名应该 409，实际 ${JSON.stringify(late.body)}`);
  assert.equal(t.tron.broadcasts.length, 0, '作废的批次不能广播');
  // 重新凑批、交签名；之后这一批不能再作废
  const p2 = await t.plan(id);
  assert.equal((await t.call('sign-submit', { batch_id: p2.batch_id, signatures: p2.sigs })).status, 200);
  const v2 = await t.call('payout-void', { id: p2.payout_batch });
  assert.equal(v2.status, 409, `已交签名的批次不能作废，实际 ${JSON.stringify(v2.body)}`);
  assert.equal((await t.row(id)).status, 'broadcast');
});

test('TRON 打款：交易原文快过期（出原文后 29 分钟起）再交签名 409 plan_expired，不广播', async () => {
  const t = await setup();
  const id = await t.newPayout();
  await t.approve(id);
  const p = await t.plan(id);
  t.advance(29 * MIN + 1000);
  await t.call('sign-verify', { batch_id: p.batch_id, code: '123456' }); // 动态码核对本身不过期也可以
  const r = await t.call('sign-submit', { batch_id: p.batch_id, signatures: p.sigs });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'plan_expired');
  assert.equal(t.tron.broadcasts.length, 0);
  assert.notEqual((await t.row(id)).status, 'broadcast');
});

test('TRON 打款：广播超时（结果不明）时，交易过期前一直不退回；过期后链上仍查不到才回到已审核，冻结不动', async () => {
  const t = await setup();
  const id = await t.newPayout();
  await t.approve(id);
  const p = await t.plan(id);
  const orig = t.tron.broadcastHex.bind(t.tron);
  t.tron.broadcastHex = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }; // 没到节点，但调用方不知道
  assert.equal((await t.call('sign-submit', { batch_id: p.batch_id, signatures: p.sigs })).status, 200);
  t.tron.broadcastHex = orig;
  const frozen = (await t.money()).f;
  // 过期按链上区块时间判断：替身节点的链上时间跟着测试时钟走（替身默认用真实时间，测试时钟往前拨时链上时间不动）
  const solid = t.tron.solidBlock.bind(t.tron);
  t.tron.solidBlock = async () => ({ ...(await solid()), time: t.now() + 60_000 });
  const tick = () => runTick({ db: t.db, tron: t.tron, getTarget: async () => null, now: t.now });
  assert.equal((await t.row(id)).status, 'broadcast', '广播出错先按已广播等着');
  t.advance(30 * MIN);
  await tick();
  assert.equal((await t.row(id)).status, 'broadcast', '交易过期前（30 分钟 + 5 分钟余量内）不退回');
  assert.equal((await t.call('withdraw-plan', { ids: [id] })).status, 409, '过期前不能再凑批');
  // 过期 5 分钟以上（链上时间）、链上仍查不到：第一轮只记下嫌疑，不退回
  t.advance(6 * MIN);
  await tick();
  const r1 = (await t.db.query('select status, gone_suspect_at from withdrawals where id = $1', [id]))[0];
  assert.equal(r1.status, 'broadcast', '第一轮看到"过期、查不到"不退回（要隔 5 分钟再查一轮）');
  assert.ok(r1.gone_suspect_at, '第一轮记下 gone_suspect_at');
  // 隔 5 分钟以上的第二轮仍查不到：回到已审核
  t.advance(5 * MIN + 1000);
  await tick();
  const r = await t.row(id);
  assert.equal(r.status, 'approved', '过期后链上仍查不到（两轮）：回到已审核');
  assert.equal((await t.money()).f, frozen, '冻结不动');
});

test('TRON 打款：服务器时钟走快了（已过期）但链上区块时间还没过交易原文的过期时间 → 不退回；链上时间过了过期时间 5 分钟以上、隔 5 分钟两轮都查不到才回到已审核', async () => {
  const t = await setup();
  const id = await t.newPayout();
  await t.approve(id);
  const p = await t.plan(id);
  const orig = t.tron.broadcastHex.bind(t.tron);
  t.tron.broadcastHex = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }; // 结果不明
  assert.equal((await t.call('sign-submit', { batch_id: p.batch_id, signatures: p.sigs })).status, 200);
  t.tron.broadcastHex = orig;
  const frozen = (await t.money()).f;
  // 链上时间单独控制：先停在出原文的时候（离过期还有约 30 分钟）
  const solid = t.tron.solidBlock.bind(t.tron);
  let chainTime = t.now();
  t.tron.solidBlock = async () => ({ ...(await solid()), time: chainTime });
  const tick = () => runTick({ db: t.db, tron: t.tron, getTarget: async () => null, now: t.now });
  assert.equal((await t.row(id)).status, 'broadcast', '前提：广播出错先按已广播等着');
  // 服务器时钟快了 40 分钟（按服务器时间早就过期了），链上时间还没到过期时间：交易随时可能上链，不能退回
  t.advance(40 * MIN);
  await tick();
  assert.equal((await t.row(id)).status, 'broadcast', '服务器时钟过了期、链上时间还没过：不能退回已审核（原交易还可能上链，再签就付两次）');
  assert.equal((await t.call('withdraw-plan', { ids: [id] })).status, 409, '链上时间还没过期时不能再凑批');
  // 链上时间也过了过期时间 5 分钟以上、链上仍查不到：第一轮只记嫌疑，不退回
  t.tron.solidBlock = async () => ({ ...(await solid()), time: t.now() + 60_000 }); // 链上时间追上来，之后跟着测试时钟走
  await tick();
  assert.equal((await t.row(id)).status, 'broadcast', '第一轮不退回');
  // 隔 5 分钟以上（服务器时钟、链上时间都往后走）的第二轮仍查不到 → 回到已审核，冻结不动
  t.advance(6 * MIN);
  await tick();
  assert.equal((await t.row(id)).status, 'approved', '链上时间过了过期时间、两轮都查不到：回到已审核');
  assert.equal((await t.money()).f, frozen, '冻结不动');
});

test('已审核、还没凑进批次的单可以驳回：原因必填，退冻结、发回调；已凑进批次的不能驳回', async () => {
  const t = await setup();
  const id = await t.newPayout(50);
  await t.approve(id);
  const before = await t.money();
  const noReason = await t.call('payout-reject-approved', { id, reason: '' });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.body.error.code, 'reason_required');
  const r = await t.call('payout-reject-approved', { id, reason: '收款地址转不了' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await t.row(id)).status, 'rejected');
  const after = await t.money();
  assert.equal(Number(after.f), Number(before.f) - 51 * U, '冻结退回（金额 + 手续费）');
  assert.equal(Number(after.a), Number(before.a) + 51 * U);
  const cbs = await t.db.query(`select payload from callbacks where event = 'withdrawal.updated' order by created_at`);
  const last = cbs.map((x) => x.payload.data).filter((d) => d.withdrawal_no === id).pop();
  assert.equal(last?.status, 'rejected', '发了"已驳回"的回调');
  assert.equal(last?.reason, '收款地址转不了');
  // 已凑进批次（signing）的不能驳回
  const id2 = await t.newPayout(20);
  await t.approve(id2);
  await t.plan(id2);
  const r2 = await t.call('payout-reject-approved', { id: id2, reason: 'x' });
  assert.equal(r2.status, 409);
  assert.equal((await t.row(id2)).status, 'signing');
});
