// 测试先写（第 3 批安全终审）：以太坊 / BSC 打款"没上链才退回"的剩余问题（PoC R1、R2b、R3、R4）。
// 口径（研发定的接口和规则）：
//   - 适配器两个新方法，各自一个 JSON-RPC 批量请求里带上 eth_blockNumber（两个答案来自同一台后端）：
//       adapter.nonceSnapshot(hot) → { head, nonce }（head − 确认数那个块的 nonce）；adapter.txLookup(hash) → { head, receipt, tx }
//     confirm() 每轮先 nonceSnapshot 再 txLookup；txLookup 的 head 比 nonceSnapshot 的小 → 这一轮不算（不记、"疑似没上链"不往前走）。
//     仍是隔至少 5 分钟两轮都"nonce 已用、查不到"才退回。
//   - 一直等：nonce 已用，但还有节点认识我们这笔（有 tx、没有回执）超过 1 小时 → 每批告警一次（不重复）。
//   - 人工"确认作废"：svc.voidConfirmed(id, { code, actor })，接口 /api/wallet/?a=payout-void-confirmed { id, code }；
//     成功整批回到已审核、审计 payout.void_confirmed；错误：bad_code 400、not_found 404、invalid_state 409（不是已广播，或 TRON）、
//     nonce_not_used 409、tx_on_chain 409（有回执）、node_lagging 409、rpc_unreachable 503。
// 落后的后端用替身包一层适配器模拟：txLookup 返回更小的 head、查不到回执和交易（只改 receipt / txByHash 不算）；回执、交易状态、按哈希查交易也落在这台。
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
const MIN = 60_000;
const CODE = '246810';
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
  return (await send(from, null, '0x' + json.bytecode.object.replace(/^0x/, '') + ctor.map(word).join(''))).contractAddress;
}
const balanceOf = async (token, who) => BigInt(await rpc('eth_call', [{ to: token, data: call('balanceOf(address)', who) }, 'latest']));
const sign = (rawHex, key) => {
  const s = secp256k1.sign(keccak_256(Buffer.from(rawHex.slice(2), 'hex')), key, { lowS: true });
  return '0x' + s.r.toString(16).padStart(64, '0') + s.s.toString(16).padStart(64, '0') + s.recovery.toString(16).padStart(2, '0');
};
const mine = async (n) => { for (let i = 0; i < n; i++) await rpc('evm_mine', []); };
const skip = !RPC && !process.env.CI ? '没有设置 TOPUP_ANVIL_RPC（本地跳过；CI 里必须跑）' : false;

/**
 * 一台卡住 / 落后的后端（lag.on 时）：查交易的请求都落在它上面——txLookup 的 head 比真实的小 20 个块、查不到回执和交易；
 * receipt、txByHash、txStatus 也一样查不到。查 nonce 的请求（nonceSnapshot、confirmedNonce）落在正常后端。
 */
const stuckBackend = (lag) => (a) => ({ ...a,
  txStatus: async (h) => (lag.on ? 'pending' : a.txStatus(h)),
  receipt: async (h) => (lag.on ? null : a.receipt(h)),
  txByHash: async (h) => (lag.on ? null : a.txByHash(h)),
  txLookup: async (h) => {
    if (!a.txLookup) throw new Error('适配器还没有 txLookup');
    const r = await a.txLookup(h);
    if (!lag.on) return r;
    return { ...r, head: typeof r.head === 'bigint' ? r.head - 20n : Number(r.head) - 20, receipt: null, tx: null };
  },
});

/** 部署 BatchPayout + 测试 USDT，授权额度，商户余额；返回服务和常用操作 */
async function setup({ confirmations = 0, wrap = (a) => a } = {}) {
  assert.ok(RPC, 'CI 里必须设置 TOPUP_ANVIL_RPC 并启动 anvil（见 test/anvil/payout-anvil.test.js 开头）');
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { createPayoutService } = await import('../../server/wallet/payout.js');
  const { approvePayouts } = await import('../../server/pay/payout.js');
  const core = await import('../../server/pay/core.js');
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
  const net = { down: false };
  const fetchImpl = (url, init) => (net.down ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init));
  const notes = [];
  const adapter = wrap(createEvmAdapter({ chain: 'eth', rpcUrl: RPC, fetchImpl, usdt, decimals: 6, confirmations, timeoutMs: 2_000 }));
  const svc = createPayoutService({ db, notify: async (subject, text) => { notes.push(`${subject}\n${text}`); }, verifyCode: async (c) => c === CODE, now: () => Date.now() + clock.skew,
    chains: { eth: { adapter, chainId, token: usdt, contract: payout, hot, decimals: 6 } } });
  for (const s of (await svc.allowancePlan('eth', { amount: 5_000 * U, reason: 'qa', code: CODE })).steps) {
    const o = await svc.allowanceSubmit('eth', { rawHex: s.rawHex, sigHex: sign(s.rawHex, hotKey) });
    await waitReceipt(o.tx_hash);
  }
  const m1 = await core.getMerchant(db, 'm1');
  /** 一笔 100 USDT 的以太坊打款，审核通过 */
  const newPayout = async () => {
    const payee = toChecksumAddress('0x' + hex(randomBytes(20)));
    const wid = (await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'eth', to: payee, amount: 100 * U, source: 'api' })).withdrawal_no;
    assert.deepEqual((await approvePayouts(db, { ids: [wid], actor: 'admin' })).approved, [wid]);
    return { wid, payee };
  };
  /** 凑批 → 签名 → 广播（自动出块关着：先不打包） */
  const broadcastA = async () => {
    await rpc('evm_setAutomine', [false]);
    const A = (await svc.plan('eth')).batches[0];
    const sent = await svc.submit(A.id, { sigHex: sign(A.rawHex, hotKey) });
    return { A, sent };
  };
  /** 用同一个 nonce、更高网络费的"转 0 给自己"把 A 作废并打包 */
  const cancelA = async (A) => {
    const { encodeUnsignedLegacyTx, attachSignature } = await import('../../server/wallet/evm-payout-codec.js');
    const raw = encodeUnsignedLegacyTx({ nonce: BigInt(A.nonce), gasPrice: 10n ** 12n, gas: 21_000n, to: hot, value: 0, data: '0x', chainId });
    await rpc('eth_sendRawTransaction', [attachSignature(raw, sign(raw, hotKey)).raw]);
    await mine(1);
    await rpc('evm_setAutomine', [true]);
  };
  /** 重新凑批、签名、打包、确认（运营看到"已审核"会这样做） */
  const replanAndPay = async () => {
    clock.skew = 0;
    const p = await svc.plan('eth');
    for (const b of p.batches) { const s = await svc.submit(b.id, { sigHex: sign(b.rawHex, hotKey) }); await waitReceipt(s.tx_hash); await mine(confirmations + 1); }
    await svc.confirm();
    return p.batches.length;
  };
  const statusOf = async (wid) => (await db.query('select status, hold_reason from withdrawals where id = $1', [wid]))[0];
  const batchOf = async (bid) => (await db.query('select * from payout_tx_batches where id = $1', [bid]))[0];
  const ledgerOnce = async (wid) => (await db.query(`select count(*)::int n from ledger where ref = $1 and type = 'withdraw'`, [wid]))[0].n;
  return { db, svc, usdt, hot, hotKey, payout, clock, net, notes, newPayout, broadcastA, cancelA, replanAndPay, statusOf, batchOf, ledgerOnce, core };
}
const rejectsWith = async (p, code, status) => {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e, `应该被拒（${code}），实际成功了`);
  assert.equal(e.code, code, `应该是 ${code}，实际 ${e.code}（${e.message}）`);
  if (status) assert.equal(e.status, status, `${code} 的状态码应该是 ${status}，实际 ${e.status}`);
};

// ---------- 🟡B：卡住的后端 ----------

test('PoC R1：查回执、按哈希查交易连续 5 分钟以上落在卡住的后端（查 nonce 的是正常后端）→ 这几轮都不算，不退回；收款人只收到 100', { skip, timeout: 180_000 }, async () => {
  const lag = { on: false };
  const t = await setup({ confirmations: 12, wrap: stuckBackend(lag) });
  const { wid, payee } = await t.newPayout();
  const { sent } = await t.broadcastA();
  await mine(14); // A 打包，之后又出 13 个块
  await rpc('evm_setAutomine', [true]);
  assert.equal((await waitReceipt(sent.tx_hash)).status, '0x1', '前提：A 已上链');
  lag.on = true;
  for (const m of [31, 33, 36.5, 40, 45, 52]) {
    t.clock.skew = m * MIN;
    await t.svc.confirm();
    assert.equal((await t.statusOf(wid)).status, 'broadcast', `第 ${m} 分钟：查交易的后端比查 nonce 的落后，这一轮不该算数（不能退回已审核）`);
  }
  // 后端恢复：按回执完成
  lag.on = false;
  t.clock.skew = 53 * MIN;
  await t.svc.confirm();
  assert.equal((await t.statusOf(wid)).status, 'completed');
  assert.equal(await t.replanAndPay(), 0, '不该再凑出批次');
  assert.equal(await balanceOf(t.usdt, payee), 100n * BigInt(U), '收款人链上收到的必须正好是 100（付了两次）');
  assert.equal(await t.ledgerOnce(wid), 1);
});

test('PoC R2b 抖动：查交易的后端时而落后、时而正常（正常时回执在、确认数没到）→ 一直不退回，收款人只收到 100', { skip, timeout: 180_000 }, async () => {
  const lag = { on: false };
  const t = await setup({ confirmations: 50, wrap: (a) => ({ ...stuckBackend(lag)(a), txStatus: async () => 'pending' }) }); // 确认数一直没到
  const { wid, payee } = await t.newPayout();
  const { sent } = await t.broadcastA();
  await mine(61); // A 打包后又出 60 块：head − 50 那个块的 nonce 已经用掉
  await rpc('evm_setAutomine', [true]);
  assert.equal((await waitReceipt(sent.tx_hash)).status, '0x1', '前提：A 已上链');
  for (const [m, on] of [[31, true], [34, false], [37, true], [42.5, true], [48, true], [55, false], [61, true], [67, true]]) {
    lag.on = on;
    t.clock.skew = m * MIN;
    await t.svc.confirm();
    assert.equal((await t.statusOf(wid)).status, 'broadcast', `第 ${m} 分钟（${on ? '落后' : '正常'}）：不能退回`);
  }
  lag.on = false;
  assert.equal(await t.replanAndPay(), 0, '不该再凑出批次');
  assert.equal(await balanceOf(t.usdt, payee), 100n * BigInt(U));
});

test('PoC R4（对照，要一直通过）：真没上链（同一 nonce 被作废交易用掉、各节点都不认识 A）→ 第一轮记嫌疑，隔 5 分钟第二轮才退回；重凑后收款人只收到 100', { skip, timeout: 180_000 }, async () => {
  const t = await setup();
  const { wid, payee } = await t.newPayout();
  const { A } = await t.broadcastA();
  await t.cancelA(A);
  t.clock.skew = 31 * MIN; await t.svc.confirm();
  assert.equal((await t.statusOf(wid)).status, 'broadcast', '第一轮不退回');
  t.clock.skew = 35 * MIN; await t.svc.confirm();
  assert.equal((await t.statusOf(wid)).status, 'broadcast', '隔 4 分钟不退回');
  t.clock.skew = 36.1 * MIN; await t.svc.confirm();
  assert.equal((await t.statusOf(wid)).status, 'approved', '隔 5 分钟以上第二轮仍查不到：回到已审核');
  assert.equal(await t.replanAndPay(), 1);
  assert.equal(await balanceOf(t.usdt, payee), 100n * BigInt(U));
  assert.equal((await t.statusOf(wid)).status, 'completed');
});

// ---------- 🟡C：一直等 → 告警 + 人工确认作废 ----------

/** A 被同一 nonce 的作废交易替换上链，但某台节点的交易池里还挂着 A（有 tx、没有回执） */
const ghost = (a) => ({ ...a,
  txByHash: async (h) => (await a.txByHash(h)) || { hash: h, blockNumber: null },
  txLookup: async (h) => { if (!a.txLookup) throw new Error('适配器还没有 txLookup'); const r = await a.txLookup(h); return { ...r, tx: r.tx || { hash: h, blockNumber: null } }; },
});

test('PoC R3：nonce 已用、还有节点认识 A（没有回执）→ 不自动退回；超过 1 小时告警一次（不重复）；人工"确认作废"（动态码 + 审计）后整批回到已审核，重凑只付一次', { skip, timeout: 180_000 }, async () => {
  const t = await setup({ wrap: ghost });
  const { wid, payee } = await t.newPayout();
  const { A } = await t.broadcastA();
  await t.cancelA(A);
  const aboutA = () => t.notes.filter((n) => n.includes(A.id) || n.includes(A.id.slice(-6)));
  for (const m of [31, 40, 55]) { t.clock.skew = m * MIN; await t.svc.confirm(); }
  assert.equal((await t.statusOf(wid)).status, 'broadcast', '还有节点认识 A：不自动退回');
  const before = aboutA().length;
  for (const m of [95, 125, 180, 24 * 60]) { t.clock.skew = m * MIN; await t.svc.confirm(); }
  assert.equal((await t.statusOf(wid)).status, 'broadcast', '24 小时后仍不自动退回（要人工确认）');
  assert.equal(aboutA().length - before, 1, `超过 1 小时应该告警一次、不重复，实际 ${aboutA().length - before} 次：${JSON.stringify(t.notes)}`);
  // 人工确认作废：动态码不对 / 没有 → bad_code，什么都不变
  await rejectsWith(t.svc.voidConfirmed(A.id, { code: '000000', actor: 'admin' }), 'bad_code', 400);
  await rejectsWith(t.svc.voidConfirmed(A.id, { actor: 'admin' }), 'bad_code', 400);
  assert.equal((await t.statusOf(wid)).status, 'broadcast');
  await rejectsWith(t.svc.voidConfirmed('PT-ETH-20990101-XXX', { code: CODE, actor: 'admin' }), 'not_found', 404);
  // 动态码对：整批回到已审核、记审计
  t.clock.skew = 24 * 60 * MIN + MIN;
  await t.svc.voidConfirmed(A.id, { code: CODE, actor: 'admin' });
  assert.equal((await t.statusOf(wid)).status, 'approved', '确认作废后整批回到已审核');
  assert.notEqual((await t.batchOf(A.id)).status, 'broadcast');
  const aud = await t.db.query(`select actor, target from pay_audit where action = 'payout.void_confirmed'`);
  assert.equal(aud.length, 1, '审计 payout.void_confirmed 一条');
  assert.equal(aud[0].target, A.id);
  assert.equal(aud[0].actor, 'admin');
  // 再确认一次：已经不是已广播 → invalid_state
  await rejectsWith(t.svc.voidConfirmed(A.id, { code: CODE, actor: 'admin' }), 'invalid_state', 409);
  // 重凑：只付一次
  assert.equal(await t.replanAndPay(), 1);
  assert.equal(await balanceOf(t.usdt, payee), 100n * BigInt(U));
  assert.equal((await t.statusOf(wid)).status, 'completed');
  assert.equal(await t.ledgerOnce(wid), 1);
});

test('人工"确认作废"的前提：nonce 没用掉 → nonce_not_used；有回执 → tx_on_chain；查交易的后端落后 → node_lagging；节点连不上 → rpc_unreachable 503；都不改状态', { skip, timeout: 180_000 }, async () => {
  // ① nonce 还没用掉（A 被挤出交易池）
  {
    const t = await setup();
    const { wid } = await t.newPayout();
    const { sent, A } = await t.broadcastA();
    await rpc('anvil_dropTransaction', [sent.tx_hash]);
    await rpc('evm_setAutomine', [true]);
    t.clock.skew = 2 * 60 * MIN;
    await rejectsWith(t.svc.voidConfirmed(A.id, { code: CODE, actor: 'admin' }), 'nonce_not_used', 409);
    assert.equal((await t.statusOf(wid)).status, 'broadcast');
  }
  // ② A 已上链（有回执），确认数还没到
  {
    const t = await setup({ confirmations: 50 });
    const { wid } = await t.newPayout();
    const { sent, A } = await t.broadcastA();
    await mine(3);
    await rpc('evm_setAutomine', [true]);
    assert.ok(await rpc('eth_getTransactionReceipt', [sent.tx_hash]), '前提：A 有回执');
    await mine(60); // head − 50 的 nonce 也已用掉
    await rejectsWith(t.svc.voidConfirmed(A.id, { code: CODE, actor: 'admin' }), 'tx_on_chain', 409);
    assert.equal((await t.statusOf(wid)).status, 'broadcast');
  }
  // ③ 查交易的后端比查 nonce 的落后
  {
    const lag = { on: false };
    const t = await setup({ wrap: stuckBackend(lag) });
    const { wid } = await t.newPayout();
    const { A } = await t.broadcastA();
    await t.cancelA(A);
    lag.on = true;
    await rejectsWith(t.svc.voidConfirmed(A.id, { code: CODE, actor: 'admin' }), 'node_lagging', 409);
    assert.equal((await t.statusOf(wid)).status, 'broadcast');
    // ④ 节点连不上
    lag.on = false;
    t.net.down = true;
    await rejectsWith(t.svc.voidConfirmed(A.id, { code: CODE, actor: 'admin' }), 'rpc_unreachable', 503);
    t.net.down = false;
    assert.equal((await t.statusOf(wid)).status, 'broadcast');
    assert.equal((await t.db.query(`select count(*)::int n from pay_audit where action = 'payout.void_confirmed'`))[0].n, 0, '被拒的不记审计');
  }
});

test('人工"确认作废"接口 /api/wallet/?a=payout-void-confirmed：动态码错 400 bad_code、批次不存在 404、没签名的批次和 TRON 批次 409 invalid_state、成功后整批回到已审核', { skip, timeout: 180_000 }, async () => {
  const t = await setup({ wrap: ghost });
  const { createWalletApi } = await import('../../server/pay/wallet-api.js');
  const { createFakeTron } = await import('../../server/pay/fake-trongrid.js');
  const { derivePayKeys } = await import('../../server/pay/common.js');
  const { createPayoutTxBatch, approvePayouts } = await import('../../server/pay/payout.js');
  const api = createWalletApi({ db: t.db, tron: createFakeTron(), keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), wallets: {}, requireAdmin: async () => {}, verifyAdminCode: async (c) => c === CODE, payoutSvc: t.svc, now: () => Date.now() + t.clock.skew });
  const post = async (body) => {
    const res = await api(new Request('https://x/api/wallet/?a=payout-void-confirmed', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } }));
    return { status: res.status, body: await res.json() };
  };
  const { wid } = await t.newPayout();
  const { A } = await t.broadcastA();
  await t.cancelA(A);
  t.clock.skew = 2 * 60 * MIN;
  let r = await post({ id: A.id, code: '000000' });
  assert.deepEqual([r.status, r.body.error?.code], [400, 'bad_code']);
  r = await post({ id: 'PT-ETH-20990101-XXX', code: CODE });
  assert.deepEqual([r.status, r.body.error?.code], [404, 'not_found']);
  // 没签名的批次（planned）
  const { wid: w2 } = await t.newPayout();
  const planned = (await t.svc.plan('eth')).batches[0];
  assert.deepEqual(planned.items.map((i) => i.id), [w2]);
  r = await post({ id: planned.id, code: CODE });
  assert.deepEqual([r.status, r.body.error?.code], [409, 'invalid_state'], '没签名的批次不能"确认作废"');
  // TRON 批次（已广播）
  const m1 = await t.core.getMerchant(t.db, 'm1');
  const tw = (await t.core.requestWithdrawal(t.db, m1, { kind: 'payout', chain: 'tron', to: 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q', amount: 10 * U, source: 'web' })).withdrawal_no;
  await approvePayouts(t.db, { ids: [tw], actor: 'admin' });
  const tb = await createPayoutTxBatch(t.db, { chain: 'tron', ids: [tw], actor: 'admin' });
  await t.db.query(`update payout_tx_batches set status = 'broadcast' where id = $1`, [tb]);
  r = await post({ id: tb, code: CODE });
  assert.deepEqual([r.status, r.body.error?.code], [409, 'invalid_state'], 'TRON 批次不走这个');
  // 成功
  r = await post({ id: A.id, code: CODE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await t.statusOf(wid)).status, 'approved');
  assert.equal((await t.db.query(`select count(*)::int n from pay_audit where action = 'payout.void_confirmed' and target = $1`, [A.id]))[0].n, 1);
});
