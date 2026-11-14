// 测试先写（第 3 批）：以太坊、BSC 批量打款的服务器一侧（替身节点）——按链凑批（三者取最小，读链上热钱包余额和授权额度）→ 出交易原文 →
// 只收签名、签名人必须是该链热钱包 → 广播的就是页面核对过的那份 → 按回执整批确认或整批回滚；改授权额度（以太坊先归零再设、两笔；BSC 一笔；TRON 不用）。
// 依据：技术方案 05 页第 1、2 节（BatchPayout 只花调用者自己的额度、热钱包浏览器签、服务器只收签名；以太坊 USDT 改额度先 approve(0) 再 approve(新值)）、
//   Q-B1、Q15、原型偏离第 5 条（改授权额度要原因 + 动态码，记审计）。
//
// 期望的新模块 server/wallet/payout.js：
//   createPayoutService({ db, chains, verifyCode, now }) ；chains.<eth|bsc> = { adapter（adapters/evm.js 的适配器）, chainId, token, contract（BatchPayout）, hot（该链热钱包）, decimals }
//     .status(chain) → { hot_balance, allowance, cap, by }：金额是 0.000001 USDT 单位（BSC 18 位要换算），读链上 balanceOf(hot)、allowance(hot, contract)
//     .plan(chain, { actor }) → { batches: [{ id, rawHex, expect, total, items }], held }
//        拿这条链所有 approved 的单，按 planPayoutBatches 凑批（上限用 getPayoutLimits），每批一笔 pay 交易（未签名 EIP-155 旧式交易，from = hot、nonce 依次递增）；
//        expect 正好是 checkPayoutTx 要的 { chainId, contract, token, batchId, items: [{ to, amount }]（链上原始单位，BSC × 10¹²）, maxFeeWei }；
//        批次号 batchId 是 0x + 64 位十六进制，先落库再给页面；单状态 approved → signing
//     .submit(id, { sigHex, actor }) → 套上签名（attachSignature），签名人不是该链 hot 就 wrong_signer（不广播、状态不变）；
//        对了就广播服务器自己存的那份原文 + 签名（eth_sendRawTransaction 收到的必须等于 attachSignature 的 raw），批次 broadcast、记 tx_hash
//     .confirm() → 回执成功：settlePayoutBatch 成功；回执失败（回滚）：整批回到 approved
//     .allowancePlan(chain, { amount, reason, code, actor }) → { steps: [{ rawHex, expect }] }：要原因（reason_required）和动态码（bad_code），审计 payout.allowance；
//        以太坊当前额度不是 0 时两步：approve(contract, 0) → approve(contract, 新值)；当前是 0 时一步；BSC 一步；TRON not_applicable
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { setupDb, fakeEvm } from './wallet-helpers.js';
import * as core from '../server/pay/core.js';
import { createEvmAdapter } from '../server/wallet/adapters/evm.js';
import { toChecksumAddress } from '../server/wallet/create2.js';

const U = 1_000_000;
const hex = (b) => Buffer.from(b).toString('hex');
const rnd = () => toChecksumAddress('0x' + hex(randomBytes(20)));
const keyAddr = (k) => toChecksumAddress('0x' + hex(keccak_256(secp256k1.getPublicKey(k, false).slice(1))).slice(24));
const sign = (rawHex, key) => {
  const s = secp256k1.sign(keccak_256(Buffer.from(rawHex.slice(2), 'hex')), key, { lowS: true });
  return '0x' + s.r.toString(16).padStart(64, '0') + s.s.toString(16).padStart(64, '0') + s.recovery.toString(16).padStart(2, '0');
};
const ALLOWANCE = 'dd62ed3e';

/** 替身节点 + allowance(owner, spender) */
function node({ decimals, hotBalance, allowance }) {
  const f = fakeEvm();
  const s = { allowance: BigInt(allowance) };
  const inner = f.fetchImpl;
  f.fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const one = (x) => (x.method === 'eth_call' && String(x.params?.[0]?.data || '').startsWith('0x' + ALLOWANCE) ? { jsonrpc: '2.0', id: x.id, result: '0x' + s.allowance.toString(16).padStart(64, '0') } : null);
    const all = [].concat(body);
    if (all.every(one)) { const out = all.map(one); return new Response(JSON.stringify(Array.isArray(body) ? out : out[0])); }
    return inner(url, init);
  };
  f.allowance = s;
  f.setHot = (hot) => { f.state.balances[hot.toLowerCase()] = BigInt(hotBalance) * 10n ** BigInt(decimals) / 1_000_000n; };
  return f;
}

async function setup({ chain = 'eth', hotUsdt = 10_000 * U, allowance = 10_000 * U } = {}) {
  const decimals = chain === 'bsc' ? 18 : 6;
  const scale = 10n ** BigInt(decimals - 6);
  const f = node({ decimals, hotBalance: hotUsdt, allowance: BigInt(allowance) * scale });
  const hotKey = randomBytes(32), hot = keyAddr(hotKey);
  f.setHot(hot);
  const token = rnd(), contract = rnd();
  const adapter = createEvmAdapter({ chain, rpcUrl: f.rpcUrl, fetchImpl: f.fetchImpl, usdt: token, decimals, confirmations: 0 });
  const db = await setupDb({ customers: [] });
  await db.query('update balances set available = available + $1', [100_000 * U]);
  await db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ('m1', 'deposit', $1, $1, 0, 'seed')`, [100_000 * U]);
  const { createPayoutService } = await import(new URL('../server/wallet/payout.js', import.meta.url).href);
  const codes = new Set(['123456']);
  const svc = createPayoutService({ db, chains: { [chain]: { adapter, chainId: 31337, token, contract, hot, decimals } }, verifyCode: async (c) => codes.has(c) });
  const m1 = await core.getMerchant(db, 'm1');
  const approve = async (...usdt) => {
    const { approvePayouts } = await import(new URL('../server/pay/payout.js', import.meta.url).href);
    const ids = [];
    for (const a of usdt) ids.push((await core.requestWithdrawal(db, m1, { kind: 'payout', chain, to: rnd(), amount: a * U, source: 'web' })).withdrawal_no);
    await approvePayouts(db, { ids, actor: 'admin' });
    return ids;
  };
  return { db, f, svc, hot, hotKey, token, contract, approve, scale };
}
const codec = () => import(new URL('../server/wallet/evm-payout-codec.js', import.meta.url).href);
const statusOf = async (db, id) => (await db.query('select status from withdrawals where id = $1', [id]))[0].status;

test('status：读链上热钱包余额和授权额度，三者取最小（BSC 18 位换算回 0.000001 单位）', async () => {
  const { svc } = await setup({ chain: 'bsc', hotUsdt: 7_000 * U, allowance: 9_000 * U });
  const s = await svc.status('bsc');
  assert.equal(String(s.hot_balance), String(7_000 * U));
  assert.equal(String(s.allowance), String(9_000 * U));
  assert.deepEqual([String(s.cap), s.by], [String(7_000 * U), 'hot_balance']);
});

test('凑批出交易：原文能被页面的 checkPayoutTx 核对通过；额度挡住的留下来；单变 signing', async () => {
  const { db, svc, approve, token, contract } = await setup({ chain: 'eth', hotUsdt: 10_000 * U, allowance: 3_000 * U });
  const ids = await approve(1_000, 1_500, 2_000);
  const plan = await svc.plan('eth', { actor: 'admin' });
  assert.equal(plan.batches.length, 1);
  const b = plan.batches[0];
  assert.match(b.expect.batchId, /^0x[0-9a-f]{64}$/);
  assert.equal(b.expect.contract.toLowerCase(), contract.toLowerCase());
  assert.equal(b.expect.token.toLowerCase(), token.toLowerCase());
  assert.equal(String(b.expect.chainId), '31337');
  assert.deepEqual(b.expect.items.map((i) => String(i.amount)), [String(1_000 * U), String(1_500 * U)]);
  const { checkPayoutTx } = await codec();
  assert.doesNotThrow(() => checkPayoutTx(b.rawHex, b.expect));
  assert.deepEqual(plan.held.map((h) => [h.id, h.reason]), [[ids[2], 'exceeds_allowance']]);
  assert.deepEqual([await statusOf(db, ids[0]), await statusOf(db, ids[1]), await statusOf(db, ids[2])], ['signing', 'signing', 'approved']);
});

test('BSC：交易里的金额是链上 18 位原始数（× 10¹²）', async () => {
  const { svc, approve, scale } = await setup({ chain: 'bsc' });
  await approve(12.5);
  const b = (await svc.plan('bsc', { actor: 'admin' })).batches[0];
  assert.equal(String(b.expect.items[0].amount), String(12_500_000n * scale));
  const { decodePayCall, decodeUnsignedLegacyTx } = await codec();
  assert.equal(String(decodePayCall(decodeUnsignedLegacyTx(b.rawHex).data).items[0].amount), String(12_500_000n * scale));
});

test('只收签名：签名人不是热钱包 wrong_signer、不广播；对了广播的正是服务器存的原文 + 签名；回执成功逐笔完成', async () => {
  const { db, f, svc, hotKey, approve } = await setup();
  const ids = await approve(10, 20);
  const b = (await svc.plan('eth', { actor: 'admin' })).batches[0];
  await assert.rejects(svc.submit(b.id, { sigHex: sign(b.rawHex, randomBytes(32)), actor: 'admin' }), (e) => e.code === 'wrong_signer');
  assert.equal(f.state.sent.length, 0);
  assert.equal(await statusOf(db, ids[0]), 'signing');
  const sig = sign(b.rawHex, hotKey);
  const out = await svc.submit(b.id, { sigHex: sig, actor: 'admin' });
  const { attachSignature } = await codec();
  assert.deepEqual(f.state.sent, [attachSignature(b.rawHex, sig).raw], '广播的就是核对过的原文');
  assert.match(out.tx_hash, /^0x[0-9a-f]{64}$/);
  await assert.rejects(svc.submit(b.id, { sigHex: sig, actor: 'admin' }), (e) => e.code === 'invalid_state', '同一批不能交第二次');
  f.state.receipts[out.tx_hash] = { status: '0x1', blockNumber: 99 };
  await svc.confirm();
  assert.deepEqual([await statusOf(db, ids[0]), await statusOf(db, ids[1])], ['completed', 'completed']);
});

test('Q15 回执失败（整笔交易回滚）：整批回到 approved，可以重新凑批', async () => {
  const { db, f, svc, hotKey, approve } = await setup();
  const ids = await approve(10, 20);
  const b = (await svc.plan('eth', { actor: 'admin' })).batches[0];
  const out = await svc.submit(b.id, { sigHex: sign(b.rawHex, hotKey), actor: 'admin' });
  f.state.receipts[out.tx_hash] = { status: '0x0', blockNumber: 99 };
  await svc.confirm();
  assert.deepEqual([await statusOf(db, ids[0]), await statusOf(db, ids[1])], ['approved', 'approved']);
  const again = await svc.plan('eth', { actor: 'admin' });
  assert.equal(again.batches.length, 1);
  assert.notEqual(again.batches[0].expect.batchId, b.expect.batchId, '重凑用新的批次号');
});

test('改授权额度：原因 + 动态码 + 审计；以太坊当前不是 0 时先 approve(0) 再 approve(新值) 两笔；BSC 一笔；TRON 不用', async () => {
  const eth = await setup({ chain: 'eth', allowance: 5_000 * U });
  await assert.rejects(eth.svc.allowancePlan('eth', { amount: 10_000 * U, reason: '', code: '123456', actor: 'admin' }), (e) => e.code === 'reason_required');
  await assert.rejects(eth.svc.allowancePlan('eth', { amount: 10_000 * U, reason: '补到上限', code: '000000', actor: 'admin' }), (e) => e.code === 'bad_code');
  const p = await eth.svc.allowancePlan('eth', { amount: 10_000 * U, reason: '补到上限', code: '123456', actor: 'admin' });
  const { checkApproveTx, decodeApproveCall, decodeUnsignedLegacyTx } = await codec();
  assert.equal(p.steps.length, 2);
  assert.deepEqual(p.steps.map((s) => String(decodeApproveCall(decodeUnsignedLegacyTx(s.rawHex).data).amount)), ['0', String(10_000 * U)]);
  for (const s of p.steps) assert.doesNotThrow(() => checkApproveTx(s.rawHex, s.expect));
  const nonces = p.steps.map((s) => decodeUnsignedLegacyTx(s.rawHex).nonce);
  assert.equal(nonces[1], nonces[0] + 1n, '两笔按顺序');
  const [a] = await eth.db.query(`select actor, detail from pay_audit where action = 'payout.allowance'`);
  assert.equal(a.actor, 'admin');
  assert.equal(a.detail.reason, '补到上限');
  assert.equal(a.detail.chain, 'eth');
  // 以太坊当前额度已经是 0：一笔
  eth.f.allowance.allowance = 0n;
  assert.equal((await eth.svc.allowancePlan('eth', { amount: 10_000 * U, reason: '补', code: '123456', actor: 'admin' })).steps.length, 1);
  const bsc = await setup({ chain: 'bsc', allowance: 5_000 * U });
  const pb = await bsc.svc.allowancePlan('bsc', { amount: 10_000 * U, reason: '补到上限', code: '123456', actor: 'admin' });
  assert.equal(pb.steps.length, 1);
  assert.equal(String(decodeApproveCall(decodeUnsignedLegacyTx(pb.steps[0].rawHex).data).amount), String(10_000n * BigInt(U) * bsc.scale));
  await assert.rejects(bsc.svc.allowancePlan('tron', { amount: 1, reason: 'x', code: '123456', actor: 'admin' }), (e) => e.code === 'not_applicable' || e.code === 'chain_not_enabled');
});
