// 钱包第 1 批返工（研发写，补在测试会话的检查之外，不改测试会话的测试）：
//   一、节点明确拒绝广播才算发送失败；广播后 15 分钟节点仍不认识这笔交易，按"没送到"标失败、地址放回
//   二、启动和看系统状态时用 eth_call 核对链上 batcher.parent()、factory()、factory.implementationAddress()；不一致的链停用、告警，不影响别的链
//   三、运营概览"资金"包含 ETH / BSC：未归集按账本、冷钱包按链上；任何一条开通的链查不到余额，合计不出数
//   四、发起账户手续费币不够（够不了 3 批典型归集）时标 low
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fakeEvm, setupDb } from './wallet-helpers.js';
import { proposeSweep, approveSweep, confirmSweeps, getBatch, reconcileReleased } from '../server/wallet/sweep.js';
import { createEvmAdapter } from '../server/wallet/adapters/evm.js';
import { createContractProvider } from '../server/wallet/providers/contract.js';
import { addressFor, evmUnswept } from '../server/wallet/addresses.js';
import { verifyChain, verifyLayer } from '../server/wallet/verify-onchain.js';
import { selector } from '../server/wallet/evm-tx.js';
import { walletChainStatus } from '../server/wallet/status.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/wallet/create2-vectors-topup.json', import.meta.url), 'utf8'));
const SCHEME = { ver: 1, factory: V.factory, implementation: V.implementation, parent: V.parents[0], batcher: V.feeAddresses[0] };
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const U = (usdt) => BigInt(Math.round(usdt * 1e6));
const MIN = 60_000;
const T0 = Date.parse('2026-12-01T04:00:00Z');
const word = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** 在测试会话的替身节点外面再包一层：可以改某个方法的返回（例如节点拒绝广播、parent() 的结果） */
function wrap(node, over) {
  const fetchImpl = async (url, init) => {
    if (node.state.down) return node.fetchImpl(url, init); // 整个节点连不上时交给替身（抛连接错误）
    const body = JSON.parse(init.body);
    const one = (x) => (over[x.method] ? over[x.method](x) : undefined);
    if (!Array.isArray(body) && one(body) !== undefined) return Response.json({ jsonrpc: '2.0', id: body.id, ...one(body) });
    return node.fetchImpl(url, init);
  };
  return { ...node, fetchImpl };
}

async function realContract(usdt = 500, over = {}) {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const node = wrap(fakeEvm({ head: 1000 }), over);
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: node.rpcUrl, fetchImpl: node.fetchImpl, usdt: USDT, decimals: 6, confirmations: 12 });
  const provider = await createContractProvider({ db, chains: { eth: { adapter, scheme: SCHEME, usdt: USDT } }, operatorKey: '0x' + randomBytes(32).toString('hex') });
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers: { contract: provider }, now: T0 });
  node.state.balances[address.toLowerCase()] = U(usdt);
  return { db, node, adapter, providers: { contract: provider }, address };
}

test('广播时节点明确拒绝（JSON-RPC 返回错误）：才算发送失败，地址放回待归集', async () => {
  const { db, providers, address } = await realContract(500, { eth_sendRawTransaction: () => ({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } }) });
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 });
  await assert.rejects(approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + MIN }), (e) => e.code === 'sweep_send_failed');
  const after = await getBatch(db, b.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.items[0].status, 'released');
  assert.match(after.error, /insufficient funds/);
  const again = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 + 2 * MIN });
  assert.deepEqual(again.flatMap((x) => x.items.map((i) => i.address)), [address]);
  await db.end?.();
});

test('广播时连不上、之后 15 分钟节点仍不认识这笔交易：标失败（not_broadcast）、地址放回；15 分钟内、节点连不上时照常等', async () => {
  const known = { v: null }; // null：eth_getTransactionByHash 返回 null（节点不认识）
  const { db, node, providers } = await realContract(500, { eth_getTransactionByHash: () => ({ result: known.v }) });
  node.state.downFor = ['eth_sendRawTransaction'];
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify: async () => {}, now: T0 });
  const r = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + MIN });
  assert.equal(r.broadcast, 'uncertain');
  node.state.downFor = [];
  const sentAt = Date.parse((await getBatch(db, b.id)).updatedAt);
  await confirmSweeps(db, { providers, now: sentAt + 10 * MIN });
  assert.equal((await getBatch(db, b.id)).status, 'sent', '15 分钟内照常等');
  known.v = { hash: r.txRefs[0] };
  await confirmSweeps(db, { providers, now: sentAt + 20 * MIN });
  assert.equal((await getBatch(db, b.id)).status, 'sent', '节点认识这笔交易（在交易池里）：照常等');
  node.state.down = true;
  await confirmSweeps(db, { providers, now: sentAt + 20 * MIN });
  assert.equal((await getBatch(db, b.id)).status, 'sent', '连不上节点：照常等');
  node.state.down = false; known.v = null;
  const mails = [];
  await confirmSweeps(db, { providers, notify: async (s) => { mails.push(s); }, now: sentAt + 20 * MIN });
  const after = await getBatch(db, b.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.items[0].reason, 'not_broadcast');
  assert.ok(mails.some((s) => /归集失败/.test(s)));
  await db.end?.();
});

const sel = (sig) => '0x' + selector(sig);
function chainNode({ parent = SCHEME.parent, factory = SCHEME.factory, impl = SCHEME.implementation, revert = false } = {}) {
  const node = fakeEvm({ head: 1000 });
  return wrap(node, {
    eth_call: (x) => {
      const d = x.params[0].data;
      if (revert && d !== sel('balanceOf(address)')) return { error: { code: 3, message: 'execution reverted' } };
      if (d === sel('parent()')) return { result: word(parent) };
      if (d === sel('factory()')) return { result: word(factory) };
      if (d === sel('implementationAddress()')) return { result: word(impl) };
      return undefined;
    },
  });
}
const adapterOf = (node) => createEvmAdapter({ chain: 'eth', rpcUrl: node.rpcUrl, fetchImpl: node.fetchImpl, usdt: USDT, decimals: 6, confirmations: 12 });

test('链上核对：parent、factory、implementation 都一致 → ok；任何一项不一致 → mismatch 并写出字段名；节点报错（例如回滚、限流）、连不上 → unverified', async () => {
  assert.deepEqual(await verifyChain(adapterOf(chainNode()), SCHEME), { result: 'ok' });
  const other = '0x' + '77'.repeat(20);
  assert.deepEqual(await verifyChain(adapterOf(chainNode({ parent: other })), SCHEME), { result: 'mismatch', fields: ['parent'] });
  assert.deepEqual(await verifyChain(adapterOf(chainNode({ factory: other, impl: other })), SCHEME), { result: 'mismatch', fields: ['factory', 'implementation'] });
  assert.equal((await verifyChain(adapterOf(chainNode({ revert: true })), SCHEME)).result, 'unverified', '节点报错（含限流）不下结论，下一轮再核对');
  assert.equal((await verifyChain(adapterOf(chainNode({ parent: '0x' + '00'.repeat(20) })), SCHEME)).result, 'mismatch', '拿到的结果对不上才算不一致');
  const down = chainNode(); down.state.down = true;
  assert.deepEqual(await verifyChain(adapterOf(down), SCHEME), { result: 'unverified' });
});

test('链上核对不一致：这条链停用（不分配地址、不在开通列表里）、发告警；另一条链照常；状态卡显示 onchain_mismatch，不返回地址的值', async () => {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const bad = adapterOf(chainNode({ parent: '0x' + '77'.repeat(20) }));
  const good = createEvmAdapter({ chain: 'bsc', rpcUrl: 'http://x', fetchImpl: chainNode().fetchImpl, usdt: USDT, decimals: 18, confirmations: 15 });
  const contract = createContractProvider({ db, chains: { eth: { adapter: bad, scheme: SCHEME, usdt: USDT }, bsc: { adapter: good, scheme: SCHEME, usdt: USDT } }, operatorKey: '' });
  const enabledChains = ['eth', 'bsc'];
  const errors = {};
  const layer = { enabledChains, errors, providers: { contract }, chainsConfigured: { eth: { adapter: bad, scheme: SCHEME }, bsc: { adapter: good, scheme: SCHEME } }, onchain: {},
    disableChain(chain, why) { enabledChains.splice(enabledChains.indexOf(chain), 1); contract.disableChain(chain); errors[chain] = why; } };
  const mails = [];
  const r = await verifyLayer(layer, { db, notify: async (s, t) => { mails.push(s + t); }, now: T0 });
  assert.equal(r.eth.result, 'mismatch');
  assert.equal(r.bsc.result, 'ok');
  assert.deepEqual(enabledChains, ['bsc']);
  assert.equal(errors.eth, 'onchain_mismatch');
  await assert.rejects(addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers: { contract }, now: T0 }), (e) => e.code === 'chain_not_enabled');
  assert.match((await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'bsc', providers: { contract }, now: T0 })).address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(mails.length, 1);
  assert.match(mails[0], /parent/);
  assert.doesNotMatch(mails[0], /0x[0-9a-fA-F]{40}/, '告警邮件不写地址的值');
  // 再核对一次不重复发邮件（一天一次）
  await verifyLayer(layer, { db, notify: async (s, t) => { mails.push(s + t); }, now: T0 + MIN });
  assert.equal(mails.length, 1);
  const card = walletChainStatus({ chain: 'eth', rpcConfigured: true, usdtConfigured: true, scheme: SCHEME, lastScanAt: new Date(T0).toISOString(), now: T0, onchain: 'mismatch' });
  assert.equal(card.status, 'onchain_mismatch');
  assert.equal(card.ok, false);
  assert.doesNotMatch(JSON.stringify(card), /0x[0-9a-fA-F]{40}/);
  await db.end?.();
});

test('本地替身（fake）不核对，直接算 ok', async () => {
  const layer = { chainsConfigured: { eth: { adapter: { fake: true }, scheme: SCHEME } }, onchain: {}, disableChain() { throw new Error('不该停用'); } };
  assert.equal((await verifyLayer(layer, {})).eth.result, 'ok');
});

test('ETH / BSC 未归集按账本：到账合计 − 已归集；达到门槛的个数按每条链的门槛', async () => {
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  const a1 = '0x' + '11'.repeat(20), a2 = '0x' + '22'.repeat(20);
  for (const [c, a] of [['c1', a1], ['c2', a2]]) await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', $1, 'eth', 'contract', 1, $2, $3, 'active')`, [c, '0x' + c.padStart(64, '0'), a]);
  const dep = (a, n, tx) => db.query(`insert into deposits (txid, log_index, block, time, address, amount, merchant_id, customer_id, result, chain) values ($1, 0, 1, now(), $2, $3, 'm1', 'c1', 'credited', 'eth')`, [tx, a, n]).catch(async () => {
    const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'deposits'`)).map((r) => r.column_name);
    throw new Error(`deposits 列：${cols.join(',')}`);
  });
  await dep(a1, 150_000_000, 't1'); await dep(a1, 50_000_000, 't2'); await dep(a2, 30_000_000, 't3');
  await db.query(`insert into wallet_sweep_batches (id, chain, provider, status, total, address_count, skipped, fee_estimate, slot, created_at, expires_at, updated_at) values ('B1', 'eth', 'contract', 'confirmed', 150000000, 1, '[]', '{}', '', now(), now(), now())`);
  await db.query(`insert into wallet_sweep_items (batch_id, chain, address, salt, amount, deploy, status) values ('B1', 'eth', $1, '0x1', 150000000, true, 'swept')`, [a1]);
  const r = await evmUnswept(db, { thresholds: { eth: U(40), bsc: U(10) } });
  assert.equal(r.eth.total, U(80));
  assert.equal(r.eth.count, 2);
  assert.equal(r.eth.over, 1);
  assert.equal(r.eth.overTotal, U(50));
  assert.equal(r.bsc.total, 0n);
  await db.end?.();
});

test('凑批时按链上余额校正"放回待归集"：放回的地址链上已经没钱（交易后来上链了），把放回的记录改记为已归集，"待归集"不再多算；取消、作废的不动', async () => {
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const a = '0x' + '33'.repeat(20);
  await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'c1', 'eth', 'contract', 1, '0x1', $1, 'active')`, [a]);
  await db.query(`insert into deposits (txid, log_index, block, time, address, amount, merchant_id, customer_id, result, chain) values ('t1', 0, 1, now(), $1, 300000000, 'm1', 'c1', 'credited', 'eth')`, [a]);
  await db.query(`insert into wallet_sweep_batches (id, chain, provider, status, total, address_count, skipped, fee_estimate, slot, created_at, expires_at, updated_at) values ('B1', 'eth', 'contract', 'failed', 300000000, 1, '[]', '{}', '', now(), now(), now()), ('B0', 'eth', 'contract', 'cancelled', 300000000, 1, '[]', '{}', '', now(), now(), now())`);
  await db.query(`insert into wallet_sweep_items (batch_id, chain, address, salt, amount, deploy, status, reason) values ('B0', 'eth', $1, '0x1', 300000000, true, 'released', 'cancelled'), ('B1', 'eth', $1, '0x1', 300000000, true, 'released', 'interrupted')`, [a]);
  // 链上还有 300：不动
  assert.deepEqual(await reconcileReleased(db, 'eth', [{ address: a, balance: U(300) }]), []);
  assert.equal((await evmUnswept(db)).eth.total, U(300));
  // 链上已经是 0：中断那条改记为已归集，取消那条不动
  assert.deepEqual(await reconcileReleased(db, 'eth', [{ address: a, balance: 0n }]), [a]);
  const items = await db.query(`select batch_id, status, reason from wallet_sweep_items order by batch_id`);
  assert.deepEqual(items.map((i) => [i.batch_id, i.status, i.reason]), [['B0', 'released', 'cancelled'], ['B1', 'swept', 'reconciled_onchain']]);
  assert.equal((await evmUnswept(db)).eth.total, 0n);
  await db.end?.();
});

test('付款页接口按 IP 限流：超过每秒上限返回 429 rate_limited；没有 IP 时不限', async () => {
  const { createPayApi, PAY_RATE_PER_SEC } = await import('../server/pay/pay-api.js');
  const { createMemRedis } = await import('../server/kyb/memredis.js');
  const db = await setupDb();
  const pay = createPayApi({ db, redis: createMemRedis(), getIp: (r) => r.headers.get('x-real-ip') || '', now: () => T0 });
  const get = (ip) => pay(new Request('https://pay.test/api/pay/?o=ORD-20261201-00000000', { headers: ip ? { 'x-real-ip': ip } : {} }));
  for (let i = 0; i < PAY_RATE_PER_SEC; i++) assert.equal((await get('203.0.113.9')).status, 404);
  const r = await get('203.0.113.9');
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.code, 'rate_limited');
  assert.equal((await get('203.0.113.10')).status, 404, '别的 IP 不受影响');
  assert.equal((await get('')).status, 404);
  await db.end?.();
});
