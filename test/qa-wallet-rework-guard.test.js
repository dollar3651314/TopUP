// 测试会话补测（第 1 批返工复核）：研发返工里三处偏离原先做法的改动，补上之前没有检查守着的部分。
//   一、发出后"没送到节点"标失败的 15 分钟边界：14 分 59 秒仍等；过了 15 分钟（15 分 01 秒）节点仍不认识才标失败
//   二、运营概览资金按 TRON、以太坊、BSC 三条链合计：冷钱包 = 三条链冷钱包之和、平台资产 = 三条链未归集 + 热 + 冷；
//       任何一条开通的链查不到冷钱包余额，冷钱包合计、平台资产、利润三项都是 null（页面显示"—"），按链拆开那一行也是 null，别的链照常
//   三、系统状态里发起账户手续费币：够付 3 批典型归集时不标 low；不够 3 批、或不够付待确认批次的手续费时 low = true
// 只用替身（内存数据库 / 真实 Postgres、ETH/BSC 内存替身、TronGrid 替身），不需要任何密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fakeEvm, setupDb } from './wallet-helpers.js';
import { proposeSweep, approveSweep, confirmSweeps, getBatch } from '../server/wallet/sweep.js';
import { createEvmAdapter } from '../server/wallet/adapters/evm.js';
import { createContractProvider } from '../server/wallet/providers/contract.js';
import { addressFor } from '../server/wallet/addresses.js';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { createWalletLayer } from '../server/wallet/index.js';
import { loadConfig } from '../server/config.js';
import { walletsFor } from '../server/pay/deps.js';
import { legacyTronCustomer } from './legacy-tron.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { addressOfPrivateKey } from '../server/pay/signing.js';

const U = 1_000_000;
const MIN = 60_000;
const T0 = Date.parse('2026-12-01T04:00:00Z');
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'; // 以太坊 USDT（小写写法）
const V = JSON.parse(readFileSync(new URL('./fixtures/wallet/create2-vectors-topup.json', import.meta.url), 'utf8'));
const SCHEME = { ver: 1, factory: V.factory, implementation: V.implementation, parent: V.parents[0], batcher: V.feeAddresses[0] };

// ---------- 一、15 分钟边界 ----------

/** 替身节点外再包一层：eth_getTransactionByHash 按 known.v 返回（null = 节点不认识这笔交易） */
async function uncertainSweep() {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const node = fakeEvm({ head: 1000 });
  const known = { v: null };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body) && body.method === 'eth_getTransactionByHash' && !node.state.down) return Response.json({ jsonrpc: '2.0', id: body.id, result: known.v });
    return node.fetchImpl(url, init);
  };
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: node.rpcUrl, fetchImpl, usdt: USDT, decimals: 6, confirmations: 12 });
  const provider = await createContractProvider({ db, chains: { eth: { adapter, scheme: SCHEME, usdt: USDT } }, operatorKey: '0x' + randomBytes(32).toString('hex') });
  const providers = { contract: provider };
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers, now: T0 });
  node.state.balances[address.toLowerCase()] = 500n * BigInt(U);
  // 广播时连不上节点：交易已签名，可能已经发出，记"已发送"、broadcast = uncertain
  node.state.downFor = ['eth_sendRawTransaction'];
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 });
  const r = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + MIN });
  assert.equal(r.broadcast, 'uncertain', '前提：广播时连不上节点，批次记为已发送、结果不确定');
  node.state.downFor = [];
  const sentAt = Date.parse((await getBatch(db, b.id)).updatedAt);
  return { db, providers, id: b.id, sentAt, known };
}

test('没送到节点的交易：发出后 14 分 59 秒节点不认识仍照常等（已发送）；过了 15 分钟（15 分 01 秒）仍不认识才标失败（not_broadcast）、地址放回', async () => {
  const { db, providers, id, sentAt } = await uncertainSweep();
  const mails = [];
  const notify = async (s) => { mails.push(s); };
  await confirmSweeps(db, { providers, notify, now: sentAt + 15 * MIN - 1000 });
  assert.equal((await getBatch(db, id)).status, 'sent', '不到 15 分钟：照常等');
  assert.equal(mails.filter((s) => /归集失败/.test(s)).length, 0, '不到 15 分钟不发失败邮件');
  await confirmSweeps(db, { providers, notify, now: sentAt + 15 * MIN + 1000 });
  const after = await getBatch(db, id);
  assert.equal(after.status, 'failed', '过了 15 分钟节点仍不认识：标失败');
  assert.deepEqual(after.items.map((i) => [i.status, i.reason]), [['released', 'not_broadcast']]);
  assert.equal(mails.filter((s) => /归集失败/.test(s)).length, 1);
  await db.end?.();
});

test('没送到节点的判断只看"节点认不认识"：过了 1 小时节点仍认识这笔交易（在交易池里）就照常等，不标失败', async () => {
  const { db, providers, id, sentAt, known } = await uncertainSweep();
  known.v = { hash: '0x' + '00'.repeat(32), blockNumber: null };
  await confirmSweeps(db, { providers, now: sentAt + 60 * MIN });
  assert.equal((await getBatch(db, id)).status, 'sent');
  await db.end?.();
});

// ---------- 二、概览资金三条链合计 ----------

const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');
const HOT = addressOfPrivateKey(Buffer.alloc(32, 0x11)); // 测试用热钱包地址（公开的测试私钥）
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;

/** 和本地运行同一套钱包层（ETH、BSC 内存替身）+ TronGrid 替身；call(a) 调运营后台接口 */
async function overviewSetup() {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB); // TRON 老客户（legacyTronCustomer）要用
  const tron = createFakeTron();
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm: walletsFor('local').evm || {} });
  assert.deepEqual([...layer.enabledChains].sort(), ['bsc', 'eth'], '前提：本地 ETH、BSC 两条链都开通');
  await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  const api = createWalletApi({ db, tron, keys, wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => true, layer });
  const call = async (a) => {
    const res = await api(new Request(`https://x/api/wallet/?a=${a}`, { headers: { 'x-topup-csrf': '1' } }));
    const body = await res.json();
    assert.equal(res.status, 200, `${a}: ${JSON.stringify(body)}`);
    return body;
  };
  return { db, tron, layer, call };
}

test('概览资金三条链合计：冷钱包 = TRON + 以太坊 + BSC 冷钱包；平台资产 = 三条链未归集 + 热钱包 + 冷钱包；按链拆开每条链一行', async () => {
  const { db, tron, layer, call } = await overviewSetup();
  // TRON：老客户地址里 100 没归集；热钱包 50、冷钱包 20
  const t = await legacyTronCustomer(db, 'm1', 'tr');
  await core.recordDeposit(db, { txid: 'qa'.padEnd(64, '0'), logIndex: 0, block: 1, to: t.address, amount: 100 * U, time: new Date() });
  tron.accounts.set(HOT, { activated: true, trx: 300 * U, trc20: { [tron.contract]: 50 * U } });
  tron.accounts.set(COLD, { activated: true, trx: 0, trc20: { [tron.contract]: 20 * U } });
  // 以太坊：客户地址到账 40 没归集，冷钱包 30；BSC：冷钱包 7
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'tr', chain: 'eth', providers: layer.providers });
  const p = layer.adapters.eth.pay({ to: address, amount: 40 * U });
  assert.equal((await core.recordDeposit(db, { chain: 'eth', txid: p.txid, logIndex: 0, block: p.block, to: address, amount: 40 * U, time: new Date() })).status, 'credited');
  const ethCold = layer.providers.contract.scheme('eth').parent, bscCold = layer.providers.contract.scheme('bsc').parent;
  layer.adapters.eth.pay({ to: ethCold, amount: 30 * U });
  layer.adapters.bsc.pay({ to: bscCold, amount: 7 * U });

  const db1 = await call('overview');
  assert.equal(db1.funds.unswept_total, '140.00', '未归集 = TRON 100 + 以太坊 40');
  assert.equal(db1.sweep.by_chain.eth.unswept_total, '40.00');
  const ch = await call('overview-chain');
  const f = ch.funds;
  assert.equal(f.cold_usdt, '57.00', '冷钱包 = 20 + 30 + 7');
  assert.equal(f.hot_usdt, '50.00');
  assert.equal(f.assets_total, '247.00', '平台资产 = 未归集 140 + 热 50 + 冷 57');
  assert.deepEqual([f.by_chain.tron.cold_usdt, f.by_chain.eth.cold_usdt, f.by_chain.bsc.cold_usdt], ['20.00', '30.00', '7.00']);
  assert.equal(f.by_chain.eth.hot_usdt, null, '以太坊第 1 批没有热钱包');
  assert.notEqual(f.profit_total, null);
  await db.end?.();
});

test('概览资金：任何一条开通的链（BSC）查不到冷钱包余额 → 冷钱包合计、平台资产、三项利润都是 null（显示"—"），按链拆开 BSC 一行 null，TRON、以太坊照常', async () => {
  const { db, tron, layer, call } = await overviewSetup();
  tron.accounts.set(HOT, { activated: true, trx: 0, trc20: { [tron.contract]: 50 * U } });
  tron.accounts.set(COLD, { activated: true, trx: 0, trc20: { [tron.contract]: 20 * U } });
  layer.adapters.eth.pay({ to: layer.providers.contract.scheme('eth').parent, amount: 30 * U });
  layer.adapters.bsc.tokenBalanceRaw = async () => { throw Object.assign(new Error('bsc: node unreachable'), { code: 'rpc_unreachable' }); }; // BSC 节点连不上
  const f = (await call('overview-chain')).funds;
  assert.equal(f.cold_usdt, null, '少了 BSC：冷钱包合计不出数');
  assert.equal(f.assets_total, null);
  assert.deepEqual([f.profit_total, f.profit_now, f.profit_after_sweep], [null, null, null], '利润不拿缺一块的数字算');
  assert.equal(f.by_chain.bsc.cold_usdt, null);
  assert.deepEqual([f.by_chain.tron.cold_usdt, f.by_chain.eth.cold_usdt, f.hot_usdt], ['20.00', '30.00', '50.00'], '别的链照常显示');
  await db.end?.();
});

test('概览资金：TRON 冷钱包查不到 → 合计也是 null（不只看 ETH / BSC）', async () => {
  const { db, tron, call } = await overviewSetup();
  tron.accounts.set(HOT, { activated: true, trx: 0, trc20: { [tron.contract]: 50 * U } });
  const orig = tron.account.bind(tron);
  tron.account = async (a) => { if (a === COLD) throw new Error('trongrid down'); return orig(a); };
  const f = (await call('overview-chain')).funds;
  assert.equal(f.cold_usdt, null);
  assert.equal(f.assets_total, null);
  assert.equal(f.by_chain.tron.cold_usdt, null);
  assert.equal(f.by_chain.eth.cold_usdt, '0.00', '以太坊冷钱包查得到（0）');
  await db.end?.();
});

// ---------- 三、发起账户手续费币不够 ----------

test('系统状态"发起账户手续费"：够 3 批典型归集不标 low；不够 3 批标 low；够 3 批但不够付待确认批次的手续费也标 low', async () => {
  const { db, layer, call } = await overviewSetup();
  const card = async () => (await call('wallet-chains')).chains.find((c) => c.chain === 'eth').operator;
  const fee = BigInt((await layer.providers.contract.estimateFee('eth', 'sweep', 10, { deploy: 5 })).native);
  layer.adapters.eth.nativeBalance = async () => fee * 3n;
  let op = await card();
  assert.equal(op.batches_left, 3);
  assert.equal(op.low, false, '正好够 3 批：不标');
  layer.adapters.eth.nativeBalance = async () => fee * 3n - 1n;
  op = await card();
  assert.equal(op.batches_left, 2);
  assert.equal(op.low, true, '不够 3 批：标 low');
  // 够 3 批，但待确认批次估的手续费比余额还多
  layer.adapters.eth.nativeBalance = async () => fee * 3n;
  await db.query(`insert into wallet_sweep_batches (id, chain, provider, status, total, address_count, skipped, fee_estimate, slot, created_at, expires_at, updated_at)
    values ('QA-LOW', 'eth', 'contract', 'awaiting_approval', 1, 1, '[]', $1::jsonb, '', now(), now() + interval '1 day', now())`, [JSON.stringify({ native: String(fee * 3n + 1n) })]);
  op = await card();
  assert.equal(op.low, true, '不够付待确认批次：标 low');
  // BSC 不受影响
  const bsc = (await call('wallet-chains')).chains.find((c) => c.chain === 'bsc').operator;
  assert.equal(bsc.low, false);
  await db.end?.();
});

// ---------- 四、最后一轮小修（链上核对不误停、停用后不发恢复邮件、放回按链上余额校正、批次状态写回） ----------
import { verifyChain, verifyLayer } from '../server/wallet/verify-onchain.js';
import { selector } from '../server/wallet/evm-tx.js';
import { evmUnswept } from '../server/wallet/addresses.js';

const w32 = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel0 = (sig) => '0x' + selector(sig);
/** 链上核对用的替身节点：mode = ok | http429 | rpc429 | empty | wrong */
function verifyNode(mode) {
  const node = fakeEvm({ head: 1000 });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const one = (x) => {
      if (x.method !== 'eth_call') return null;
      if (mode === 'rpc429') return { jsonrpc: '2.0', id: x.id, error: { code: -32005, message: 'rate limit exceeded' } };
      if (mode === 'empty') return { jsonrpc: '2.0', id: x.id, result: '0x' };
      const d = x.params[0].data;
      const pick = d === sel0('parent()') ? SCHEME.parent : d === sel0('factory()') ? SCHEME.factory : d === sel0('implementationAddress()') ? SCHEME.implementation : null;
      if (!pick) return null;
      return { jsonrpc: '2.0', id: x.id, result: w32(mode === 'wrong' && d === sel0('parent()') ? '0x' + '77'.repeat(20) : pick) };
    };
    if (mode === 'http429') return new Response('Too Many Requests', { status: 429 });
    if (!Array.isArray(body) && one(body)) return Response.json(one(body));
    return node.fetchImpl(url, init);
  };
  return createEvmAdapter({ chain: 'eth', rpcUrl: node.rpcUrl, fetchImpl, usdt: USDT, decimals: 6, confirmations: 12 });
}

test('链上核对：节点限流（HTTP 429、JSON-RPC 限流错误）→ unverified，不停用；拿到空结果或地址不对 → mismatch', async () => {
  assert.deepEqual(await verifyChain(verifyNode('ok'), SCHEME), { result: 'ok' }, '前提：替身节点返回一致时 ok');
  assert.deepEqual(await verifyChain(verifyNode('http429'), SCHEME), { result: 'unverified' });
  assert.deepEqual(await verifyChain(verifyNode('rpc429'), SCHEME), { result: 'unverified' });
  assert.equal((await verifyChain(verifyNode('empty'), SCHEME)).result, 'mismatch', '空结果（地址上没有合约）');
  assert.deepEqual(await verifyChain(verifyNode('wrong'), SCHEME), { result: 'mismatch', fields: ['parent'] });
});

test('链上核对：限流时（unverified）这条链不停用、不发邮件；已因不一致停用的链之后节点返回一致也不再核对、不发"核对一致"恢复邮件、仍停用', async () => {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const mails = [];
  const notify = async (s) => { mails.push(s); };
  const enabledChains = ['eth'];
  const errors = {};
  const cfg = { eth: { adapter: verifyNode('rpc429'), scheme: SCHEME } };
  const layer = { enabledChains, errors, chainsConfigured: cfg, onchain: {},
    disableChain(chain, why) { const i = enabledChains.indexOf(chain); if (i >= 0) enabledChains.splice(i, 1); errors[chain] = why; } };
  await verifyLayer(layer, { db, notify, now: T0 });
  assert.equal(layer.onchain.eth.result, 'unverified');
  assert.deepEqual(enabledChains, ['eth'], '限流不停用');
  assert.equal(mails.length, 0);
  cfg.eth.adapter = verifyNode('wrong');
  await verifyLayer(layer, { db, notify, now: T0 + MIN });
  assert.deepEqual(enabledChains, []);
  assert.equal(mails.length, 1, '不一致告警一封');
  cfg.eth.adapter = verifyNode('ok'); // 节点这时返回一致（例如之前是节点出错）
  await verifyLayer(layer, { db, notify, now: T0 + 25 * 3600_000 });
  assert.equal(layer.onchain.eth.result, 'mismatch', '停用后不再核对，状态保持不一致');
  assert.deepEqual(enabledChains, [], '仍停用（到重新部署、重启为止）');
  assert.equal(mails.length, 1, '不发"核对一致"恢复邮件');
  await db.end?.();
});

/** 合约提供方 + 替身节点；executeSweep 可以挡住（gate）或换掉，模拟发送拖很久 */
async function sweepRig(usdt = 500) {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const node = fakeEvm({ head: 1000 });
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: node.rpcUrl, fetchImpl: node.fetchImpl, usdt: USDT, decimals: 6, confirmations: 12 });
  const real = await createContractProvider({ db, chains: { eth: { adapter, scheme: SCHEME, usdt: USDT } }, operatorKey: '0x' + randomBytes(32).toString('hex') });
  const hook = { exec: null };
  const contract = new Proxy(real, { get: (t, k) => (k === 'executeSweep' && hook.exec ? hook.exec : t[k]) });
  const providers = { contract };
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers, now: T0 });
  node.state.balances[address.toLowerCase()] = BigInt(usdt) * BigInt(U);
  return { db, node, providers, hook, real, address };
}
/** 发送卡住时 confirmSweeps 把"发送中"超过 15 分钟的批次标失败；然后发送才返回 */
async function interruptedThen(outcome) {
  const rig = await sweepRig();
  const { db, providers, hook } = rig;
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: Date.now() });
  let release;
  const gate = new Promise((ok) => { release = ok; });
  hook.exec = async (args) => { await gate; return outcome(args, rig); };
  const p = approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers }).then((x) => ({ ok: x }), (e) => ({ err: e }));
  for (let i = 0; i < 100 && (await getBatch(db, b.id)).status !== 'sending'; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal((await getBatch(db, b.id)).status, 'sending', '前提：已确认、正在发送');
  await confirmSweeps(db, { providers, now: Date.now() + 16 * MIN });
  const mid = await getBatch(db, b.id);
  assert.equal(mid.status, 'failed', '前提：发送中超过 15 分钟被标失败');
  assert.equal(mid.error, 'interrupted_while_sending');
  release();
  return { ...rig, id: b.id, result: await p };
}

test('批次状态写回带"仍是发送中"条件：已被标"发送中断"的批次，发送后来成功了也不改回已发送，记下交易号、error = sent_after_interrupted，地址仍是放回', async () => {
  const { db, id, result } = await interruptedThen((args, rig) => rig.real.executeSweep(args));
  assert.ok(result.ok, '发送本身成功返回');
  const b = await getBatch(db, id);
  assert.equal(b.status, 'failed', '不改回"已发送"');
  assert.equal(b.error, 'sent_after_interrupted');
  assert.equal(b.txRefs.length, 1, '交易号记下来，便于人工核对');
  assert.deepEqual(b.items.map((i) => [i.status, i.reason]), [['released', 'interrupted']]);
  await db.end?.();
});

test('批次状态写回带"仍是发送中"条件：已被标"发送中断"的批次，之后签名前出错不改回"待确认"，节点拒绝也不重复改状态', async () => {
  const prep = await interruptedThen(() => { throw Object.assign(new Error('node down'), { stage: 'prepare' }); });
  assert.equal(prep.result.err?.code, 'sweep_not_sent');
  let b = await getBatch(prep.db, prep.id);
  assert.equal(b.status, 'failed', '不退回待确认');
  assert.equal(b.error, 'interrupted_while_sending');
  await prep.db.end?.();
  const rej = await interruptedThen(() => { throw Object.assign(new Error('rejected'), { stage: 'broadcast' }); });
  assert.equal(rej.result.err?.code, 'sweep_send_failed');
  b = await getBatch(rej.db, rej.id);
  assert.equal(b.status, 'failed');
  assert.equal(b.error, 'interrupted_while_sending', '保留"发送中断"的原因');
  assert.deepEqual(b.items.map((i) => i.reason), ['interrupted']);
  await rej.db.end?.();
});

test('凑批时按链上余额校正"放回"：发送失败放回的地址链上已经没钱（交易后来上链），凑批后"待归集"不再多算，也不再凑进新批次；链上还有钱的照常凑', async () => {
  const { db, node, providers, hook, address } = await sweepRig();
  await db.query(`insert into deposits (txid, log_index, block, time, address, amount, merchant_id, customer_id, result, chain) values ('qa-t1', 0, 1, now(), $1, $2, 'm1', 'c1', 'credited', 'eth')`, [address, 500 * U]);
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 });
  hook.exec = async () => { throw Object.assign(new Error('rejected'), { stage: 'broadcast' }); };
  await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + MIN }).catch(() => {});
  assert.equal((await getBatch(db, b.id)).items[0].status, 'released', '前提：地址放回');
  // 链上还有 500：照常凑，估算不变
  const again = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 + 2 * MIN });
  assert.equal(again.length, 1);
  assert.equal((await evmUnswept(db)).eth.total, BigInt(500 * U));
  await db.query(`update wallet_sweep_batches set status = 'cancelled' where id = $1`, [again[0].id]);
  await db.query(`update wallet_sweep_items set status = 'released', reason = 'cancelled' where batch_id = $1`, [again[0].id]);
  // 交易后来上链了：链上余额变 0 → 凑批时校正，不再凑批、待归集 0
  node.state.balances[address.toLowerCase()] = 0n;
  const none = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 + 3 * MIN });
  assert.deepEqual(none, []);
  assert.equal((await evmUnswept(db)).eth.total, 0n, '待归集不再多算');
  const rows = await db.query(`select reason, status from wallet_sweep_items where chain = 'eth' order by id`);
  assert.deepEqual(rows.map((r) => [r.status, r.reason]), [['swept', 'reconciled_onchain'], ['released', 'cancelled']], '只改发送失败放回的那条，取消的不动');
  await db.end?.();
});
