// 测试先写（第 3 批，安全审查发现的双付）：以太坊 / BSC 批量打款"广播后节点查不到"的处理。
// 场景：A 已签名、已广播，但我们连的节点把它挤出了交易池（anvil_dropTransaction）；30 分钟后 worker 查不到它。
// 这时热钱包的 nonce N 还没被用掉，A 的已签名原文已经公开（进过内存池），任何人都能重新广播并上链。
// 要求：nonce N 被用掉之前，这一笔不能回到"已审核"（否则重新凑批出 B，A、B 都上链 = 付两次）；
// 全过程收款人链上只收到 100、账本只按这笔扣一次 100、冻结清零、最后是已完成。
// 另两条（修复轮补测）：nonce N 已被别的交易用掉、A 没有回执 → 整批回到已审核，重凑后只付一次；
// 一批里有一个收款人转不了（试算回滚 TransferFailed(i)）→ 只挂起那一笔、其余照常凑批付出，挂起的不再进批，驳回后退冻结。
// 怎么跑：和 test/anvil/payout-anvil.test.js 相同（CI contracts 一节，一个文件一个文件跑）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { setupDb } from '../wallet-helpers.js';

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
const deploy = async (from, json, ...ctor) => (await send(from, null, '0x' + json.bytecode.object.replace(/^0x/, '') + ctor.map(word).join(''))).contractAddress;
const balanceOf = async (token, who) => BigInt(await rpc('eth_call', [{ to: token, data: call('balanceOf(address)', who) }, 'latest']));
const sign = (rawHex, key) => {
  const s = secp256k1.sign(keccak_256(Buffer.from(rawHex.slice(2), 'hex')), key, { lowS: true });
  return '0x' + s.r.toString(16).padStart(64, '0') + s.s.toString(16).padStart(64, '0') + s.recovery.toString(16).padStart(2, '0');
};
const skip = !RPC && !process.env.CI ? '没有设置 TOPUP_ANVIL_RPC（本地跳过；CI 里必须跑）' : false;

test('以太坊打款：广播后节点查不到（30 分钟）但 nonce 还没用掉时不回到已审核；旧交易被重新广播上链后只付一次', { skip, timeout: 180_000 }, async () => {
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { createPayoutService } = await import('../../server/wallet/payout.js');
  const { attachSignature } = await import('../../server/wallet/evm-payout-codec.js');
  const { approvePayouts } = await import('../../server/pay/payout.js');
  const core = await import('../../server/pay/core.js');
  const { toChecksumAddress } = await import('../../server/wallet/create2.js');
  await rpc('evm_setAutomine', [true]);
  try {
    const [deployer] = await rpc('eth_accounts');
    const hotKey = randomBytes(32); // 本测试随机生成的热钱包私钥，只活在这次测试里
    const hot = '0x' + hex(keccak_256(secp256k1.getPublicKey(hotKey, false).slice(1))).slice(24);
    await rpc('anvil_setBalance', [hot, '0x' + (10n ** 19n).toString(16)]);
    const payout = await deploy(deployer, artifact(OUT, 'BatchPayout.sol', 'BatchPayout'), hot);
    const usdt = await deploy(deployer, artifact(OUT_P, 'PayoutMocks.sol', 'MockUsdtTF'));
    await send(deployer, usdt, call('mint(address,uint256)', hot, 5_000n * BigInt(U)));
    const chainId = Number(BigInt(await rpc('eth_chainId')));
    const db = await setupDb({ customers: [] });
    await db.query('update balances set available = available + $1', [10_000 * U]);
    let skew = 0;
    const svc = createPayoutService({ db, verifyCode: async () => true, now: () => Date.now() + skew,
      chains: { eth: { adapter: createEvmAdapter({ chain: 'eth', rpcUrl: RPC, usdt, decimals: 6, confirmations: 0 }), chainId, token: usdt, contract: payout, hot, decimals: 6 } } });
    for (const s of (await svc.allowancePlan('eth', { amount: 5_000 * U, reason: 'qa', code: '000000' })).steps) {
      const o = await svc.allowanceSubmit('eth', { rawHex: s.rawHex, sigHex: sign(s.rawHex, hotKey) });
      await waitReceipt(o.tx_hash);
    }
    const m1 = await core.getMerchant(db, 'm1');
    const payee = toChecksumAddress('0x' + hex(randomBytes(20)));
    const wid = (await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'eth', to: payee, amount: 100 * U, source: 'api' })).withdrawal_no;
    await approvePayouts(db, { ids: [wid], actor: 'admin' });
    const statusOf = async () => (await db.query('select status from withdrawals where id = $1', [wid]))[0].status;

    // ① 凑批 A、签名、广播，但节点迟迟不打包
    await rpc('evm_setAutomine', [false]);
    const A = (await svc.plan('eth')).batches[0];
    const sigA = sign(A.rawHex, hotKey);
    const sentA = await svc.submit(A.id, { sigHex: sigA });
    const publicRawA = attachSignature(A.rawHex, sigA).raw; // 进过公开内存池的原文，任何人都拿得到
    const nonceN = BigInt(A.nonce);
    // ② 我们连的节点把 A 挤出了交易池
    await rpc('anvil_dropTransaction', [sentA.tx_hash]);
    assert.equal(await rpc('eth_getTransactionByHash', [sentA.tx_hash]), null, '前提：节点已经查不到 A');
    // ③ 31 分钟后 worker 来确认：热钱包 nonce N 还没被用掉
    skew = 31 * 60_000;
    await svc.confirm();
    assert.ok(BigInt(await rpc('eth_getTransactionCount', [hot, 'latest'])) <= nonceN, '前提：nonce N 还没被用掉');
    assert.notEqual(await statusOf(), 'approved', 'nonce N 还没被用掉时就回到"已审核"：A 随时可能被重新广播上链，再凑批就会付两次');
    const again = await svc.plan('eth');
    assert.equal(again.batches.length, 0, 'nonce N 还没被用掉时又凑出了新的一批（同一笔会付两次）');

    // ④ A 的原文被（别人）重新广播并打包。服务器自己已经把 A 重新广播回交易池时，节点回"已经有了"（already imported / known）：
    //    这一步只是模拟重新广播，节点里确实有 A 就算到位，不当作失败
    try { await rpc('eth_sendRawTransaction', [publicRawA]); }
    catch (e) {
      if (!/already (imported|known)/i.test(e.message)) throw e;
      assert.notEqual(await rpc('eth_getTransactionByHash', [sentA.tx_hash]), null, `节点说已经有了 A，但查不到 A：${e.message}`);
    }
    await rpc('evm_mine', []);
    assert.equal((await waitReceipt(sentA.tx_hash)).status, '0x1');
    // ⑤ worker 再确认：A 已上链 → 这一笔完成；之后无论再凑批、签名、确认几次都不该再付
    await svc.confirm();
    skew = 0;
    await svc.confirm();
    for (let round = 0; round < 2; round++) {
      const p = await svc.plan('eth');
      for (const b of p.batches) { await svc.submit(b.id, { sigHex: sign(b.rawHex, hotKey) }); await rpc('evm_mine', []); }
      await svc.confirm();
    }

    assert.equal(await balanceOf(usdt, payee), 100n * BigInt(U), '一笔 100 USDT 的打款，收款人链上收到的必须正好是 100');
    assert.equal(await statusOf(), 'completed');
    const led = await db.query(`select type, amount::bigint a from ledger where ref = $1 and type = 'withdraw'`, [wid]);
    assert.equal(led.length, 1, `账本按这笔扣款应该正好一次，实际 ${JSON.stringify(led)}`);
    assert.equal(Number(led[0].a), -100 * U);
    const [bal] = await db.query(`select frozen::bigint f from balances where merchant_id = 'm1'`);
    assert.equal(Number(bal.f), 0, '冻结应该清零（扣一次，不多不少）');
  } finally {
    await rpc('evm_setAutomine', [true]);
  }
});

/** 公共准备：部署 BatchPayout 和测试 USDT、给热钱包钱和授权额度、商户余额 */
async function prepare() {
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { createPayoutService } = await import('../../server/wallet/payout.js');
  const core = await import('../../server/pay/core.js');
  const { approvePayouts } = await import('../../server/pay/payout.js');
  const { toChecksumAddress } = await import('../../server/wallet/create2.js');
  await rpc('evm_setAutomine', [true]);
  const [deployer] = await rpc('eth_accounts');
  const hotKey = randomBytes(32);
  const hot = '0x' + hex(keccak_256(secp256k1.getPublicKey(hotKey, false).slice(1))).slice(24);
  await rpc('anvil_setBalance', [hot, '0x' + (10n ** 19n).toString(16)]);
  const payout = await deploy(deployer, artifact(OUT, 'BatchPayout.sol', 'BatchPayout'), hot);
  const usdt = await deploy(deployer, artifact(OUT_P, 'PayoutMocks.sol', 'MockUsdtTF'));
  await send(deployer, usdt, call('mint(address,uint256)', hot, 5_000n * BigInt(U)));
  const chainId = Number(BigInt(await rpc('eth_chainId')));
  const db = await setupDb({ customers: [] });
  await db.query('update balances set available = available + $1', [10_000 * U]);
  const clock = { skew: 0 };
  const svc = createPayoutService({ db, verifyCode: async () => true, now: () => Date.now() + clock.skew,
    chains: { eth: { adapter: createEvmAdapter({ chain: 'eth', rpcUrl: RPC, usdt, decimals: 6, confirmations: 0 }), chainId, token: usdt, contract: payout, hot, decimals: 6 } } });
  for (const s of (await svc.allowancePlan('eth', { amount: 5_000 * U, reason: 'qa', code: '000000' })).steps) {
    const o = await svc.allowanceSubmit('eth', { rawHex: s.rawHex, sigHex: sign(s.rawHex, hotKey) });
    await waitReceipt(o.tx_hash);
  }
  const m1 = await core.getMerchant(db, 'm1');
  const newPayee = () => toChecksumAddress('0x' + hex(randomBytes(20)));
  const pay = async (to, amount) => {
    const wid = (await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'eth', to, amount: amount * U, source: 'api' })).withdrawal_no;
    await approvePayouts(db, { ids: [wid], actor: 'admin' });
    return wid;
  };
  const statusOf = async (wid) => (await db.query('select status, hold_reason from withdrawals where id = $1', [wid]))[0];
  return { db, svc, hot, hotKey, usdt, payout, deployer, clock, newPayee, pay, statusOf };
}

test('以太坊打款：A 被挤出交易池后热钱包的 nonce N 被别的交易用掉、A 没有回执 → 整批回到已审核；重凑后收款人只收到一次', { skip, timeout: 180_000 }, async () => {
  const { encodeUnsignedLegacyTx, attachSignature } = await import('../../server/wallet/evm-payout-codec.js');
  try {
    const t = await prepare();
    const payee = t.newPayee();
    const wid = await t.pay(payee, 100);
    await rpc('evm_setAutomine', [false]);
    const A = (await t.svc.plan('eth')).batches[0];
    const sentA = await t.svc.submit(A.id, { sigHex: sign(A.rawHex, t.hotKey) });
    await rpc('anvil_dropTransaction', [sentA.tx_hash]);
    // 运营用同一个 nonce 签一笔"转 0 给自己"、网络费更高的交易把 A 作废，上链
    const cancelRaw = encodeUnsignedLegacyTx({ nonce: BigInt(A.nonce), gasPrice: 10n ** 11n, gas: 21_000n, to: t.hot, value: 0, data: '0x', chainId: Number(BigInt(await rpc('eth_chainId'))) });
    const cancel = attachSignature(cancelRaw, sign(cancelRaw, t.hotKey));
    await rpc('eth_sendRawTransaction', [cancel.raw]);
    await rpc('evm_mine', []);
    await rpc('evm_setAutomine', [true]);
    assert.ok(BigInt(await rpc('eth_getTransactionCount', [t.hot, 'latest'])) > BigInt(A.nonce), '前提：nonce N 已被用掉');
    t.clock.skew = 31 * 60_000;
    await t.svc.confirm();
    assert.equal((await t.statusOf(wid)).status, 'approved', 'nonce N 已被别的交易用掉、A 没有回执：整批回到已审核');
    t.clock.skew = 0;
    const B = (await t.svc.plan('eth')).batches;
    assert.equal(B.length, 1, '可以重新凑批');
    const sentB = await t.svc.submit(B[0].id, { sigHex: sign(B[0].rawHex, t.hotKey) });
    await waitReceipt(sentB.tx_hash);
    await t.svc.confirm();
    assert.equal(await balanceOf(t.usdt, payee), 100n * BigInt(U), '收款人只收到一次 100');
    assert.equal((await t.statusOf(wid)).status, 'completed');
    assert.equal(await rpc('eth_getTransactionReceipt', [sentA.tx_hash]), null, 'A 不会再上链');
  } finally {
    await rpc('evm_setAutomine', [true]);
  }
});

test('以太坊打款：一批里一个收款人转不了（试算回滚 TransferFailed(i)）→ 只挂起那一笔，其余照常付出；挂起的不再进批，驳回后退冻结', { skip, timeout: 180_000 }, async () => {
  const { rejectApprovedPayout } = await import('../../server/pay/payout.js');
  const t = await prepare();
  const good1 = t.newPayee(), bad = t.newPayee(), good2 = t.newPayee();
  const ids = [await t.pay(good1, 10), await t.pay(bad, 20), await t.pay(good2, 30)];
  await send(t.deployer, t.usdt, call('block_(address,bool)', bad, 1)); // 代币拉黑这个收款人
  const p = await t.svc.plan('eth');
  assert.deepEqual(p.held.filter((h) => h.reason === 'transfer_failed').map((h) => h.id), [ids[1]], '只挂起转不了的那一笔');
  assert.equal(p.batches.length, 1);
  assert.deepEqual(p.batches[0].items.map((i) => i.id).sort(), [ids[0], ids[2]].sort(), '其余照常凑批');
  const sent = await t.svc.submit(p.batches[0].id, { sigHex: sign(p.batches[0].rawHex, t.hotKey) });
  assert.equal((await waitReceipt(sent.tx_hash)).status, '0x1');
  await t.svc.confirm();
  assert.equal(await balanceOf(t.usdt, good1), 10n * BigInt(U));
  assert.equal(await balanceOf(t.usdt, good2), 30n * BigInt(U));
  assert.equal(await balanceOf(t.usdt, bad), 0n);
  const held = await t.statusOf(ids[1]);
  assert.equal(held.status, 'approved', '挂起的对外仍是已审核');
  assert.equal(held.hold_reason, 'transfer_failed');
  const again = await t.svc.plan('eth');
  assert.equal(again.batches.length, 0, '挂起的不再进批');
  const before = (await t.db.query(`select available::bigint a, frozen::bigint f from balances where merchant_id = 'm1'`))[0];
  await rejectApprovedPayout(t.db, { id: ids[1], reason: '收款地址转不了', actor: 'admin' });
  const after = (await t.db.query(`select available::bigint a, frozen::bigint f from balances where merchant_id = 'm1'`))[0];
  const [w] = await t.db.query('select amount::bigint a, fee::bigint f, status from withdrawals where id = $1', [ids[1]]);
  assert.equal(w.status, 'rejected');
  assert.equal(Number(before.f) - Number(after.f), Number(w.a) + Number(w.f), '驳回后退冻结（金额 + 手续费）');
});
