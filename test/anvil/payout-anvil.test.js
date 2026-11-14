// 测试先写（第 3 批）：anvil 本地链端到端——批量打款（以太坊、BSC）。
//   改授权额度（以太坊 USDT：先归零再设、两笔）→ 商户申请 → 逐笔审核 → 按链凑批 → 页面核对（checkPayoutTx）→ 热钱包签名 → 服务器只收签名、广播
//   → 链上确认逐笔完成；一批里一个收款人被代币拉黑 → 整笔交易回滚 → 整批回到已审核、热钱包和账本都不动；BSC 18 位。
// 不需要任何真实私钥：部署账户用 anvil 自带的已解锁账户；热钱包私钥由测试随机生成（只活在这次测试里，模拟浏览器里签名）。
// 怎么跑（CI contracts 一节）：
//   cd contracts && forge build && FOUNDRY_PROFILE=payout forge build && cd ..
//   anvil --port 18545 --silent &
//   TOPUP_ANVIL_RPC=http://127.0.0.1:18545 node --test test/anvil/*.test.js
// BatchPayout 读 contracts/out（默认 profile 编 src/），测试代币读 contracts/out-payout（test-payout/PayoutMocks.sol）。没设 TOPUP_ANVIL_RPC：本地跳过，CI 里直接失败。
// 期望的后端接口见 test/payout-service.test.js 开头（createPayoutService），另加：
//   .allowanceSubmit(chain, { rawHex, sigHex, actor }) → { tx_hash }：rawHex 必须是 allowancePlan 刚给出的（不是就 invalid_state），签名人必须是热钱包（wrong_signer）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { setupDb, moneySnapshot } from '../wallet-helpers.js';

const RPC = process.env.TOPUP_ANVIL_RPC || '';
const OUT = process.env.TOPUP_CONTRACTS_OUT || new URL('../../contracts/out/', import.meta.url).pathname;
const OUT_P = process.env.TOPUP_PAYOUT_OUT || new URL('../../contracts/out-payout/', import.meta.url).pathname;
const U = 1_000_000;
const hex = (b) => Buffer.from(b).toString('hex');
const sel = (sig) => hex(keccak_256(Buffer.from(sig))).slice(0, 8);
const word = (v) => (typeof v === 'string' && v.startsWith('0x') ? v.slice(2).toLowerCase() : BigInt(v).toString(16)).padStart(64, '0');
const call = (sig, ...args) => '0x' + sel(sig) + args.map(word).join('');
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
function artifact(dir, file, name) {
  const p = `${dir.replace(/\/$/, '')}/${file}/${name}.json`;
  assert.ok(existsSync(p), `找不到合约编译产物 ${p}：先 cd contracts && forge build && FOUNDRY_PROFILE=payout forge build`);
  return JSON.parse(readFileSync(p, 'utf8'));
}
async function waitReceipt(h) {
  for (let i = 0; i < 100; i++) {
    const r = await rpc('eth_getTransactionReceipt', [h]);
    if (r) return r;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`等不到回执 ${h}`);
}
async function send(from, to, data) {
  const h = await rpc('eth_sendTransaction', [{ from, ...(to ? { to } : {}), data, gas: '0x' + (8_000_000).toString(16) }]);
  const r = await waitReceipt(h);
  assert.equal(r.status, '0x1', `交易失败 ${h}`);
  return r;
}
async function deploy(from, json, ...ctor) {
  const r = await send(from, null, '0x' + json.bytecode.object.replace(/^0x/, '') + ctor.map(word).join(''));
  return r.contractAddress;
}
const balanceOf = async (token, who) => BigInt(await rpc('eth_call', [{ to: token, data: call('balanceOf(address)', who) }, 'latest']));
const allowance = async (token, owner, spender) => BigInt(await rpc('eth_call', [{ to: token, data: call('allowance(address,address)', owner, spender) }, 'latest']));
const sign = (rawHex, key) => {
  const s = secp256k1.sign(keccak_256(Buffer.from(rawHex.slice(2), 'hex')), key, { lowS: true });
  return '0x' + s.r.toString(16).padStart(64, '0') + s.s.toString(16).padStart(64, '0') + s.recovery.toString(16).padStart(2, '0');
};
const skip = !RPC && !process.env.CI ? '没有设置 TOPUP_ANVIL_RPC（本地跳过；CI 里必须跑）' : false;

test('BatchPayout 的外部函数就这几个（没有能把钱转走的函数、没有 receive / fallback）', { skip: !existsSync(OUT) && !process.env.CI ? '没有 contracts/out' : false }, () => {
  const j = artifact(OUT, 'BatchPayout.sol', 'BatchPayout');
  const fns = Object.keys(j.methodIdentifiers).sort();
  assert.deepEqual(fns, [
    'MAX_ITEMS()', 'acceptOwnership()', 'isPayer(address)', 'owner()', 'pay(address,bytes32,address[],uint256[])',
    'pendingOwner()', 'renounceOwnership()', 'setPayer(address,bool)', 'transferOwnership(address)',
  ]);
  assert.ok(!j.abi.some((x) => x.type === 'receive' || x.type === 'fallback'), '没有 receive / fallback');
  assert.ok(!j.abi.some((x) => x.stateMutability === 'payable'), '没有 payable');
});

test('anvil 端到端：改授权额度（以太坊两笔）→ 审核 → 凑批 → 页面核对 → 热钱包签名 → 链上确认；一个收款人被拉黑整批回滚；BSC 18 位', { skip, timeout: 180_000 }, async () => {
  assert.ok(RPC, 'CI 里必须设置 TOPUP_ANVIL_RPC 并启动 anvil（见本文件开头）');
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { createPayoutService } = await import('../../server/wallet/payout.js');
  const { checkPayoutTx, checkApproveTx } = await import('../../server/wallet/evm-payout-codec.js');
  const { approvePayouts } = await import('../../server/pay/payout.js');
  const core = await import('../../server/pay/core.js');

  const [deployer] = await rpc('eth_accounts');
  const hotKey = randomBytes(32);
  const hot = '0x' + hex(keccak_256(secp256k1.getPublicKey(hotKey, false).slice(1))).slice(24);
  await rpc('anvil_setBalance', [hot, '0x' + (10n ** 19n).toString(16)]);
  const payout = await deploy(deployer, artifact(OUT, 'BatchPayout.sol', 'BatchPayout'), hot);
  const usdt6 = await deploy(deployer, artifact(OUT_P, 'PayoutMocks.sol', 'MockUsdtTF')); // 像以太坊 USDT：不返回 bool、改额度先归零、可拉黑
  const usdt18 = await deploy(deployer, artifact(OUT_P, 'PayoutMocks.sol', 'MockErc20TF'), 18); // 像 BSC USDT
  await send(deployer, usdt6, call('mint(address,uint256)', hot, 50_000n * BigInt(U)));
  await send(deployer, usdt18, call('mint(address,uint256)', hot, 50_000n * 10n ** 18n));
  const chainId = Number(BigInt(await rpc('eth_chainId')));

  const db = await setupDb({ customers: [] });
  await db.query('update balances set available = available + $1', [100_000 * U]);
  await db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ('m1', 'deposit', $1, $1, 0, 'seed')`, [100_000 * U]);
  const adapter = (chain) => createEvmAdapter({ chain, rpcUrl: RPC, usdt: chain === 'bsc' ? usdt18 : usdt6, decimals: chain === 'bsc' ? 18 : 6, confirmations: 0 });
  const svc = createPayoutService({
    db, verifyCode: async (c) => c === '246810',
    chains: {
      eth: { adapter: adapter('eth'), chainId, token: usdt6, contract: payout, hot, decimals: 6 },
      bsc: { adapter: adapter('bsc'), chainId, token: usdt18, contract: payout, hot, decimals: 18 },
    },
  });
  const signAll = async (chain, steps) => {
    for (const s of steps) {
      checkApproveTx(s.rawHex, s.expect); // 页面先核对
      const out = await svc.allowanceSubmit(chain, { rawHex: s.rawHex, sigHex: sign(s.rawHex, hotKey), actor: 'admin' });
      assert.equal((await waitReceipt(out.tx_hash)).status, '0x1');
    }
  };

  // ① 授权额度：以太坊从 0 设到 3,000（一笔）；再改到 10,000（非 0 改非 0：先归零再设，两笔）；读回链上
  const p1 = await svc.allowancePlan('eth', { amount: 3_000 * U, reason: '首次授权', code: '246810', actor: 'admin' });
  assert.equal(p1.steps.length, 1);
  await signAll('eth', p1.steps);
  assert.equal(await allowance(usdt6, hot, payout), 3_000n * BigInt(U));
  const p2 = await svc.allowancePlan('eth', { amount: 10_000 * U, reason: '补到上限', code: '246810', actor: 'admin' });
  assert.equal(p2.steps.length, 2);
  // 签名人不对：拒，不广播
  const n0 = await rpc('eth_getTransactionCount', [hot, 'latest']);
  await assert.rejects(svc.allowanceSubmit('eth', { rawHex: p2.steps[0].rawHex, sigHex: sign(p2.steps[0].rawHex, randomBytes(32)), actor: 'admin' }), (e) => e.code === 'wrong_signer');
  assert.equal(await rpc('eth_getTransactionCount', [hot, 'latest']), n0);
  await signAll('eth', p2.steps);
  assert.equal(await allowance(usdt6, hot, payout), 10_000n * BigInt(U));
  await signAll('bsc', (await svc.allowancePlan('bsc', { amount: 10_000 * U, reason: '首次授权', code: '246810', actor: 'admin' })).steps);
  assert.equal(await allowance(usdt18, hot, payout), 10_000n * 10n ** 18n);

  // ② 正常一批：3 笔以太坊打款
  const m1 = await core.getMerchant(db, 'm1');
  const payees = [0, 1, 2].map(() => '0x' + hex(randomBytes(20)));
  const { toChecksumAddress } = await import('../../server/wallet/create2.js');
  const ids = [];
  for (const [i, to] of payees.entries()) ids.push((await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'eth', to: toChecksumAddress(to), amount: (i + 1) * 100 * U, source: 'api' })).withdrawal_no);
  await approvePayouts(db, { ids, actor: 'admin' });
  const plan = await svc.plan('eth', { actor: 'admin' });
  assert.equal(plan.batches.length, 1);
  const b = plan.batches[0];
  checkPayoutTx(b.rawHex, b.expect);
  const hotBefore = await balanceOf(usdt6, hot);
  const sent = await svc.submit(b.id, { sigHex: sign(b.rawHex, hotKey), actor: 'admin' });
  const rc = await waitReceipt(sent.tx_hash);
  assert.equal(rc.status, '0x1');
  assert.equal(rc.to.toLowerCase(), payout.toLowerCase(), '热钱包只调用 BatchPayout');
  await svc.confirm();
  for (const [i, to] of payees.entries()) assert.equal(await balanceOf(usdt6, to), BigInt((i + 1) * 100 * U));
  assert.equal(hotBefore - (await balanceOf(usdt6, hot)), 600n * BigInt(U));
  assert.equal(await balanceOf(usdt6, payout), 0n, '合约不持有钱');
  for (const i of ids) assert.equal((await core.withdrawalView(db, i)).status, 'completed');

  // ③ 整批回滚：第 2 个收款人被代币拉黑
  const bad = ['0x' + hex(randomBytes(20)), '0x' + hex(randomBytes(20)), '0x' + hex(randomBytes(20))].map(toChecksumAddress);
  const ids2 = [];
  for (const to of bad) ids2.push((await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'eth', to, amount: 50 * U, source: 'web' })).withdrawal_no);
  await approvePayouts(db, { ids: ids2, actor: 'admin' });
  const money = await moneySnapshot(db);
  const b2 = (await svc.plan('eth', { actor: 'admin' })).batches[0];
  checkPayoutTx(b2.rawHex, b2.expect);
  // 凑批、核对之后，签名之前：第 2 个收款人被代币拉黑（凑批时估 gas 还是好的）
  await send(deployer, usdt6, call('block_(address,bool)', bad[1], 1));
  const hot2 = await balanceOf(usdt6, hot);
  const sent2 = await svc.submit(b2.id, { sigHex: sign(b2.rawHex, hotKey), actor: 'admin' }).catch((e) => e);
  // 节点可能在估 gas 时就拒（eth_estimateGas 回滚），也可能上链后回执失败：两种都要落到"整批回到已审核"
  if (sent2?.tx_hash) assert.equal((await waitReceipt(sent2.tx_hash)).status, '0x0');
  await svc.confirm();
  for (const i of ids2) assert.equal((await db.query('select status from withdrawals where id = $1', [i]))[0].status, 'approved', '整批回到已审核');
  assert.equal(await balanceOf(usdt6, hot), hot2, '热钱包一分没动');
  for (const to of bad) assert.equal(await balanceOf(usdt6, to), 0n);
  assert.equal(await moneySnapshot(db), money, '账本、余额都不动');

  // ④ BSC 18 位
  const bscTo = toChecksumAddress('0x' + hex(randomBytes(20)));
  const idB = (await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'bsc', to: bscTo, amount: 12_500_000, source: 'web' })).withdrawal_no;
  await approvePayouts(db, { ids: [idB], actor: 'admin' });
  const bb = (await svc.plan('bsc', { actor: 'admin' })).batches[0];
  checkPayoutTx(bb.rawHex, bb.expect);
  const sb = await svc.submit(bb.id, { sigHex: sign(bb.rawHex, hotKey), actor: 'admin' });
  assert.equal((await waitReceipt(sb.tx_hash)).status, '0x1');
  await svc.confirm();
  assert.equal(await balanceOf(usdt18, bscTo), 12_500_000n * 10n ** 12n);
  assert.equal((await core.withdrawalView(db, idB)).status, 'completed');
});
