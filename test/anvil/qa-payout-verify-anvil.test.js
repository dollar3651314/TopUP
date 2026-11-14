// 测试先写（第 3 批修复轮）：启动时核对 BatchPayout 合约（server/wallet/payout.js 的 verify / verifyPayoutChain，deps.js 启动时调、worker 每轮对"未核对"的再调）。
// 口径：核对三项——isPayer(热钱包) 为真、合约代码哈希是这一版 BatchPayout、owner 是冷钱包 Safe（evm.<链>.parent）。
//   拿到了结果而且不对 → mismatch：这条链的打款停用（不凑批、不签名、不改额度），告警（pay_meta 里 alert_payout_onchain_<链>、发一封信）；
//   节点连不上 / 不回 → unverified："未核对"，不算停用、不告警，打款先不出交易；下一轮再核对，核对上了就恢复；
//   凑批时估 gas 回滚（例如热钱包被取消了付款人）→ 拒绝凑批（estimate_reverted），不出交易、单留在已审核。
// 用真实的 BatchPayout（contracts/out）部署在 anvil 上；冷钱包 Safe 用 anvil 冒充一个地址（anvil_impersonateAccount）来接 owner。
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
async function deploy(from, json, ...ctor) {
  const r = await send(from, null, '0x' + json.bytecode.object.replace(/^0x/, '') + ctor.map(word).join(''));
  return r.contractAddress;
}
/** anvil 冒充一个地址发交易（冷钱包 Safe、热钱包改额度用；不需要私钥） */
async function as(addr, to, data) {
  await rpc('anvil_setBalance', [addr, '0x' + (10n ** 19n).toString(16)]);
  await rpc('anvil_impersonateAccount', [addr]);
  try { return await send(addr, to, data); } finally { await rpc('anvil_stopImpersonatingAccount', [addr]); }
}
const newAddr = () => '0x' + hex(randomBytes(20));
const skip = !RPC && !process.env.CI ? '没有设置 TOPUP_ANVIL_RPC（本地跳过；CI 里必须跑）' : false;

/**
 * 部署一套：BatchPayout(payer) + 像以太坊 USDT 的测试代币；owner 按 opts 交给 Safe（两步：transferOwnership → Safe acceptOwnership）。
 * opts.payer：构造时登记的付款人（默认热钱包）；opts.owner：'safe'（默认）/ 'deployer'（没转给 Safe）/ 'pending'（转了但 Safe 没接）
 */
async function world(opts = {}) {
  assert.ok(RPC, 'CI 里必须设置 TOPUP_ANVIL_RPC 并启动 anvil（见 test/anvil/payout-anvil.test.js 开头）');
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { createPayoutService } = await import('../../server/wallet/payout.js');
  const { approvePayouts } = await import('../../server/pay/payout.js');
  const core = await import('../../server/pay/core.js');
  const { toChecksumAddress } = await import('../../server/wallet/create2.js');
  const [deployer] = await rpc('eth_accounts');
  const hotKey = randomBytes(32);
  const hot = '0x' + hex(keccak_256(secp256k1.getPublicKey(hotKey, false).slice(1))).slice(24);
  const safe = newAddr();
  const payout = await deploy(deployer, artifact(OUT, 'BatchPayout.sol', 'BatchPayout'), opts.payer || hot);
  if ((opts.owner || 'safe') !== 'deployer') await send(deployer, payout, call('transferOwnership(address)', safe));
  if ((opts.owner || 'safe') === 'safe') await as(safe, payout, call('acceptOwnership()'));
  const token = await deploy(deployer, artifact(OUT_P, 'PayoutMocks.sol', 'MockUsdtTF'));
  await send(deployer, token, call('mint(address,uint256)', hot, 50_000n * BigInt(U)));
  await as(hot, token, call('approve(address,uint256)', payout, 10_000n * BigInt(U))); // 授权额度（正常流程是页面签 allowancePlan 的交易，这里不是要测的）
  const chainId = Number(BigInt(await rpc('eth_chainId')));
  const db = await setupDb({ customers: [] });
  await db.query('update balances set available = available + $1', [100_000 * U]);
  await db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ('m1', 'deposit', $1, $1, 0, 'seed')`, [100_000 * U]);
  // 节点开关：down = 'refuse' 连不上；'hang' 一直不回
  const net = { down: null };
  const fetchImpl = (url, init) => {
    if (net.down === 'refuse') return Promise.reject(new TypeError('fetch failed'));
    if (net.down === 'hang') return new Promise(() => {});
    return fetch(url, init);
  };
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: RPC, fetchImpl, usdt: token, decimals: 6, confirmations: 0, timeoutMs: 2_000 });
  const mails = [];
  const notify = async (subject, text) => { mails.push({ subject, text }); };
  const cfg = { adapter, chainId, token, contract: opts.contract || payout, hot, decimals: 6, safe };
  const svc = createPayoutService({ db, chains: { eth: cfg }, verifyCode: async (c) => c === '246810', notify, verifyContracts: true });
  const m1 = await core.getMerchant(db, 'm1');
  const approve = async (n = 1) => {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await core.requestWithdrawal(db, m1, { kind: 'payout', chain: 'eth', to: toChecksumAddress(newAddr()), amount: 100 * U, source: 'web' })).withdrawal_no);
    const r = await approvePayouts(db, { ids, actor: 'admin' });
    assert.deepEqual(r.approved, ids, '前提：审核通过');
    return ids;
  };
  const alertRow = async () => (await db.query(`select value from pay_meta where key = 'alert_payout_onchain_eth'`))[0] || null;
  const plannedCount = async () => (await db.query(`select count(*)::int n from payout_tx_batches where chain = 'eth' and status = 'planned'`))[0].n;
  const statusOf = async (wid) => (await db.query('select status, batch_id, hold_reason from withdrawals where id = $1', [wid]))[0];
  return { db, svc, cfg, net, mails, deployer, hot, hotKey, safe, payout, token, approve, alertRow, plannedCount, statusOf };
}
/** 停用的链：凑批、改额度都拒（payout_contract_mismatch / payout_contract_unverified），单留在已审核、不出批次 */
async function assertBlocked(w, code, ids, { nodeUp = true } = {}) {
  await assert.rejects(w.svc.plan('eth', { actor: 'admin' }), (e) => e.code === code, `凑批应该被拒（${code}）`);
  await assert.rejects(w.svc.allowancePlan('eth', { amount: 1_000 * U, reason: '补额度', code: '246810', actor: 'admin' }), (e) => e.code === code, `改额度应该被拒（${code}）`);
  assert.equal(await w.plannedCount(), 0, '不该出批次');
  for (const i of ids) assert.equal((await w.statusOf(i)).status, 'approved');
  if (nodeUp) assert.equal((await w.svc.status('eth')).onchain, code === 'payout_contract_mismatch' ? 'mismatch' : 'unverified');
}
/** 凑批卡片（运营后台"打款审核"）：这条链挡住的原因 */
async function cardBlocked(w) {
  const { payoutAdminActions } = await import('../../server/pay/payout-admin.js');
  const { createFakeTron } = await import('../../server/pay/fake-trongrid.js');
  const acts = payoutAdminActions({ db: w.db, tron: createFakeTron(), wallets: {}, payoutSvc: w.svc, verifyAdminCode: async () => true });
  return (await acts['payout-plans']()).cards.find((c) => c.chain === 'eth').blocked;
}

test('核对 BatchPayout（对照组）：热钱包是付款人、代码是这一版、owner 是冷钱包 Safe → ok，能凑批，不告警', { skip, timeout: 120_000 }, async () => {
  const w = await world();
  const r = await w.svc.verify();
  assert.equal(r.eth.result, 'ok', `应该核对一致：${JSON.stringify(r.eth)}`);
  const [wid] = await w.approve(1);
  const p = await w.svc.plan('eth', { actor: 'admin' });
  assert.equal(p.batches.length, 1);
  assert.deepEqual(p.batches[0].items.map((i) => i.id), [wid]);
  assert.equal(await w.alertRow(), null);
  assert.equal(w.mails.length, 0);
});

test('核对 BatchPayout：isPayer(热钱包) 不对（登记的付款人是别的地址）→ mismatch（isPayer），这条链打款停用并告警', { skip, timeout: 120_000 }, async () => {
  const w = await world({ payer: newAddr() });
  const ids = await w.approve(1);
  const r = await w.svc.verify();
  assert.equal(r.eth.result, 'mismatch', JSON.stringify(r.eth));
  assert.deepEqual(r.eth.fields, ['isPayer']);
  await assertBlocked(w, 'payout_contract_mismatch', ids);
  assert.equal(await cardBlocked(w), 'contract_mismatch');
  assert.ok(await w.alertRow(), '告警要记下来（pay_meta alert_payout_onchain_eth）');
  assert.equal(w.mails.length, 1, '发一封告警信');
  assert.match(w.mails[0].subject, /停用/);
  assert.match(w.mails[0].text, /isPayer/);
  // 下一轮再核对：停用的不会自己恢复（要核对配置后重启），也不重复发信
  assert.equal((await w.svc.verify()).eth.result, 'mismatch');
  assert.equal(w.mails.length, 1);
});

test('核对 BatchPayout：合约代码不是这一版（同一地址、代码多了一个字节）→ mismatch（code），停用并告警', { skip, timeout: 120_000 }, async () => {
  const w = await world();
  // 在编译器元数据前面插一个字节：存储（owner、付款人）不变，执行逻辑不变，只有代码哈希不同
  const code = Buffer.from((await rpc('eth_getCode', [w.payout, 'latest'])).slice(2), 'hex');
  const n = code.readUInt16BE(code.length - 2);
  const cut = code.length - 2 - n;
  await rpc('anvil_setCode', [w.payout, '0x' + hex(Buffer.concat([code.subarray(0, cut), Buffer.from([0]), code.subarray(cut)]))]);
  const ids = await w.approve(1);
  const r = await w.svc.verify();
  assert.equal(r.eth.result, 'mismatch', JSON.stringify(r.eth));
  assert.deepEqual(r.eth.fields, ['code']);
  await assertBlocked(w, 'payout_contract_mismatch', ids);
  assert.ok(await w.alertRow());
  assert.equal(w.mails.length, 1);
});

test('核对 BatchPayout：配置的合约地址是别的合约（例如填成了 USDT 地址）→ 代码哈希不符，mismatch，停用并告警（不能当成"节点连不上"）', { skip, timeout: 120_000 }, async () => {
  const pre = await world();
  const w = await world({ contract: pre.token }); // evm.eth.payout 填成了代币合约
  const ids = await w.approve(1);
  const r = await w.svc.verify();
  assert.equal(r.eth.result, 'mismatch', `节点好好的、地址上是别的合约：应该判"不一致"并告警，实际 ${JSON.stringify(r.eth)}`);
  assert.ok(r.eth.fields.includes('code'));
  await assertBlocked(w, 'payout_contract_mismatch', ids);
  assert.ok(await w.alertRow(), '要告警');
  assert.equal(w.mails.length, 1);
});

test('核对 BatchPayout：配置的合约地址上没有代码（普通地址）→ mismatch，停用并告警', { skip, timeout: 120_000 }, async () => {
  const w = await world({ contract: newAddr() });
  const ids = await w.approve(1);
  const r = await w.svc.verify();
  assert.equal(r.eth.result, 'mismatch', JSON.stringify(r.eth));
  assert.ok(r.eth.fields.includes('code'));
  await assertBlocked(w, 'payout_contract_mismatch', ids);
  assert.ok(await w.alertRow());
});

test('核对 BatchPayout：owner 不是冷钱包 Safe（没转给 Safe / 转了 Safe 还没接）→ mismatch（owner），停用并告警', { skip, timeout: 120_000 }, async () => {
  for (const owner of ['deployer', 'pending']) {
    const w = await world({ owner });
    const ids = await w.approve(1);
    const r = await w.svc.verify();
    assert.equal(r.eth.result, 'mismatch', `${owner}：${JSON.stringify(r.eth)}`);
    assert.deepEqual(r.eth.fields, ['owner'], owner);
    await assertBlocked(w, 'payout_contract_mismatch', ids);
    assert.ok(await w.alertRow(), owner);
    assert.equal(w.mails.length, 1, owner);
  }
});

test('核对 BatchPayout：节点连不上 / 不回 → "未核对"（不算停用、不告警），先不出交易；下一轮节点好了再核对 → 恢复凑批', { skip, timeout: 120_000 }, async () => {
  const w = await world();
  const ids = await w.approve(1);
  w.net.down = 'refuse';
  const r1 = await w.svc.verify();
  assert.equal(r1.eth.result, 'unverified', JSON.stringify(r1.eth));
  await assertBlocked(w, 'payout_contract_unverified', ids, { nodeUp: false });
  assert.equal(await cardBlocked(w), 'rpc', '节点连不上：凑批卡片写节点问题');
  assert.equal(await w.alertRow(), null, '连不上不算核对不一致，不告警');
  assert.equal(w.mails.length, 0);
  // 节点一直不回：最多等 timeoutMs，按"未核对"
  w.net.down = 'hang';
  const t0 = Date.now();
  const r2 = await w.svc.verify({ timeoutMs: 300 });
  assert.equal(r2.eth.result, 'unverified');
  assert.ok(Date.now() - t0 < 2_500, `不该一直等：等了 ${Date.now() - t0} ms`);
  assert.equal(w.mails.length, 0);
  // 节点好了、还没到下一轮核对：仍然"未核对"，卡片写"合约还没核对"，不出交易
  w.net.down = null;
  await assertBlocked(w, 'payout_contract_unverified', ids);
  assert.equal(await cardBlocked(w), 'contract_unverified');
  // 下一轮（worker 每轮对"未核对"的再核对）：核对上了 → ok，能凑批
  const r3 = await w.svc.verify();
  assert.equal(r3.eth.result, 'ok', JSON.stringify(r3.eth));
  const p = await w.svc.plan('eth', { actor: 'admin' });
  assert.deepEqual(p.batches.flatMap((b) => b.items.map((i) => i.id)), ids);
  assert.equal(await cardBlocked(w), null);
  assert.equal(w.mails.length, 0);
});

test('凑批时估 gas 回滚（热钱包被取消了付款人）→ 拒绝凑批（estimate_reverted）：不出交易、不落批次、单留在已审核、没挂起、热钱包 nonce 不动', { skip, timeout: 120_000 }, async () => {
  const w = await world();
  assert.equal((await w.svc.verify()).eth.result, 'ok');
  const ids = await w.approve(2);
  // 启动核对之后，冷钱包 Safe 把热钱包的付款人资格取消了：BatchPayout.pay 会回滚 NotPayer（不是 TransferFailed(i)，解不出是哪一笔）
  await as(w.safe, w.payout, call('setPayer(address,bool)', w.hot, 0));
  const n0 = await rpc('eth_getTransactionCount', [w.hot, 'latest']);
  await assert.rejects(w.svc.plan('eth', { actor: 'admin' }), (e) => e.code === 'estimate_reverted' && e.status === 409, '估 gas 回滚应该拒绝凑批（estimate_reverted，409），不能回落默认 gas 出交易');
  assert.equal(await w.plannedCount(), 0, '不该落下没签名的批次');
  for (const i of ids) assert.deepEqual(await w.statusOf(i), { status: 'approved', batch_id: null, hold_reason: null }, '单留在已审核、不挂起（不是收款地址的问题）');
  assert.equal(await rpc('eth_getTransactionCount', [w.hot, 'latest']), n0);
});
