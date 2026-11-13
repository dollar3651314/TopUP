// 测试先写（第 2 批）：TRON 合约钱包地址按需生成（K1 同样适用，第 2 批开通后解除 chain_not_enabled）。
//   - 地址 = TRON 派生版 BitGo 工厂的 CREATE2 地址，前缀 0x41（不是 0xff）：
//     finalSalt = keccak256(parent ‖ batcher ‖ 盐)，地址 = keccak256(0x41 ‖ 工厂 ‖ finalSalt ‖ keccak256(EIP-1167 代理))[12:]，T 开头
//     （算法和 scripts/tron-nile/tron-create2.mjs 一致，已在本机 TRON 私链上用工厂实际部署核对）；盐和 ETH、BSC 一样 = keccak256("topup-deposit" ‖ 客户序号)
//   - 纯计算、不访问节点；地址发出去前不用部署、不用激活
//   - 合约参数检查：TRON 的地址必须是 T 开头的合法地址；钱只能进写死的 parent，parent 不能是批量合约、USDT、工厂、实现
//   - 能力：批量归集 true、批量打款 false（Q16 A：TRON 打款不走合约）、自己扫链
//   - 钱包层：createWalletLayer 多一个 tron 参数（config/wallets.json 的 tron 一节：usdt、factory、implementation、parent、batcher、ver）；
//     给了就开通 TRON（enabledChains 含 tron），没给就和第 1 批一样不开通（第 1 批的用例不传 tron，照旧 chain_not_enabled）
//   - 开通后：新客户发起 TRON 充值时按需生成合约地址（provider = contract）；同一客户同一条链只生成一次；付款页能选 TRON
//   - 老客户（第 0 批 legacy_hd 地址）：继续用老地址收款、照常入账，不另发合约地址；"更换地址"才换成合约地址，老地址停用后一直入账
// 要实现的模块：server/wallet/providers/contract.js（TRON 链）、server/wallet/index.js（tron 参数、本地替身）、server/wallet/addresses.js、
//   server/wallet/router.js（TRON 不再写死"不在本批"，看提供方有没有开通 tron）、server/pay/core.js（recordDeposit 的 TRON 按 customer_addresses 找客户）
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeTronNode, tronScheme, randomTron, forwarderOf } from './tron-helpers.js';
import { setupDb } from './wallet-helpers.js';
import { depositSalt } from '../server/wallet/create2.js';
import { forwarderAddress as tronCreate2 } from '../scripts/tron-nile/tron-create2.mjs';

const U = 1_000_000;

async function provider(db, { down = false } = {}) {
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const { createTronAdapter } = await import('../server/wallet/adapters/tron.js');
  const { scheme, usdt } = tronScheme();
  const node = fakeTronNode({ scheme, usdt, down });
  const adapter = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19 });
  return { p: createContractProvider({ db, chains: { tron: { adapter, scheme, usdt } } }), node, scheme, usdt, adapter };
}

test('TRON 合约地址：0x41 前缀的 CREATE2（feeAddress = 批量合约，盐和 ETH / BSC 相同）；T 开头；不是 0xff 算法的地址；纯计算不访问节点', async () => {
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  const { p, node, scheme } = await provider(db, { down: true });
  const a1 = await p.allocateAddress({ merchantId: 'm1', customerId: 'c1', chain: 'tron' });
  const a2 = await p.allocateAddress({ merchantId: 'm1', customerId: 'c2', chain: 'tron' });
  const [c1] = await db.query(`select seq from customers where customer_id = 'c1'`);
  const salt = depositSalt(BigInt(c1.seq));
  assert.equal(a1.providerRef, salt, '盐和 ETH、BSC 同一个算法');
  assert.equal(a1.schemeVer, 1);
  const want = tronCreate2({ factory: scheme.factory, implementation: scheme.implementation, parent: scheme.parent, feeAddress: scheme.batcher, salt });
  assert.equal(a1.address, want.tron, '0x41 算法');
  assert.notEqual(a1.address, want.evmStyle, '不能用以太坊的 0xff 算法');
  assert.match(a1.address, /^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  assert.notEqual(a2.address, a1.address);
  assert.equal(p.addressForSalt('tron', salt), a1.address);
  assert.equal(node.calls.length, 0, '分配地址不访问节点');
  await db.end?.();
});

test('TRON 合约参数检查：地址必须是 T 开头的合法 TRON 地址；parent 不能是批量合约、USDT、工厂或实现（钱只能进写死的 parent）', async () => {
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const { createTronAdapter } = await import('../server/wallet/adapters/tron.js');
  const db = await setupDb();
  const { scheme, usdt } = tronScheme();
  const node = fakeTronNode({ scheme, usdt });
  const adapter = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19 });
  const mk = (s, u = usdt) => createContractProvider({ db, chains: { tron: { adapter, scheme: s, usdt: u } } });
  assert.doesNotThrow(() => mk(scheme));
  assert.throws(() => mk({ ...scheme, parent: '0x' + '11'.repeat(20) }), /parent/i, 'TRON 的 parent 要 T 开头');
  assert.throws(() => mk({ ...scheme, parent: 'T' + 'x'.repeat(33) }), /parent/i, '校验和不对');
  assert.throws(() => mk({ ...scheme, parent: scheme.batcher }), /parent/i);
  assert.throws(() => mk({ ...scheme, parent: usdt }), /parent/i);
  assert.throws(() => mk({ ...scheme, parent: scheme.factory }), /parent/i);
  assert.throws(() => mk({ ...scheme, parent: scheme.implementation }), /parent/i);
  assert.throws(() => mk({ ...scheme, factory: '' }), /factory/i);
  assert.throws(() => mk({ ...scheme, ver: 0 }), /ver/i);
  await db.end?.();
});

test('TRON 能力：批量归集、自己扫链；批量打款 false（Q16 A：TRON 打款不走合约，第 3 批）', async () => {
  const db = await setupDb();
  const { p } = await provider(db);
  assert.deepEqual(p.capabilities('tron'), { batchSweep: true, batchPayout: false, selfScan: true, webhook: false });
  assert.ok(p.chains.includes('tron'));
  await assert.rejects(p.planPayout('tron', []), (e) => e.code === 'not_supported');
  await db.end?.();
});

test('addressFor：TRON 开通后新客户按需生成合约地址（provider = contract、记盐和参数版本）；再要返回同一个；没开通 TRON 的提供方照旧 chain_not_enabled', async () => {
  const { addressFor, activeAddresses } = await import('../server/wallet/addresses.js');
  const db = await setupDb({ customers: [['m1', 'n1']] });
  const { p, scheme } = await provider(db);
  const providers = { contract: p };
  const a = await addressFor(db, { merchantId: 'm1', customerId: 'n1', chain: 'tron', providers });
  assert.equal(a.provider, 'contract');
  assert.equal(a.chain, 'tron');
  const [row] = await db.query(`select * from customer_addresses where customer_id = 'n1' and chain = 'tron'`);
  assert.equal(row.address, a.address);
  assert.equal(row.address, forwarderOf(scheme, row.salt));
  assert.equal(row.scheme_ver, 1);
  const again = await addressFor(db, { merchantId: 'm1', customerId: 'n1', chain: 'tron', providers });
  assert.equal(again.address, a.address);
  assert.equal((await db.query(`select count(*)::int n from customer_addresses where customer_id = 'n1'`))[0].n, 1, '只生成一次');
  assert.deepEqual((await activeAddresses(db, { merchantId: 'm1', customerId: 'n1' })).map((x) => x.chain), ['tron']);
  // 提供方没开 TRON（第 1 批的样子）：照旧拒绝
  const db2 = await setupDb({ customers: [['m1', 'n2']] });
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const evmOnly = createContractProvider({ db: db2, chains: {} });
  await assert.rejects(addressFor(db2, { merchantId: 'm1', customerId: 'n2', chain: 'tron', providers: { contract: evmOnly } }), (e) => e.code === 'chain_not_enabled');
  await db.end?.(); await db2.end?.();
});

test('老客户（第 0 批 legacy_hd 的 TRON 地址）：TRON 开通后要 TRON 地址仍给老地址（不另生成合约地址）；"更换地址"才换成合约地址，老地址停用但一直入账', async () => {
  const { addressFor } = await import('../server/wallet/addresses.js');
  const core = await import('../server/pay/core.js');
  const db = await setupDb({ customers: [['m1', 'old']] });
  const [c] = await db.query(`select address from customers where customer_id = 'old'`);
  const legacy = randomTron();
  await db.query(`update customers set address = $1 where customer_id = 'old'`, [legacy]);
  await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'old', 'tron', 'legacy_hd', 0, '', $1, 'active')`, [legacy]);
  assert.ok(c);
  const { p } = await provider(db);
  const providers = { contract: p };
  const got = await addressFor(db, { merchantId: 'm1', customerId: 'old', chain: 'tron', providers });
  assert.equal(got.address, legacy);
  assert.equal(got.provider, 'legacy_hd');
  const renewed = await addressFor(db, { merchantId: 'm1', customerId: 'old', chain: 'tron', providers, renew: true });
  assert.equal(renewed.provider, 'contract');
  assert.notEqual(renewed.address, legacy);
  const rows = await db.query(`select address, provider, status from customer_addresses where customer_id = 'old' and chain = 'tron' order by id`);
  assert.deepEqual(rows.map((r) => [r.provider, r.status]), [['legacy_hd', 'retired'], ['contract', 'active']]);
  // 老地址停用后照常入账（第 0 批的扫链路径：不带 chain）
  const r1 = await core.recordDeposit(db, { txid: 'a'.repeat(64), logIndex: 0, block: 1, time: Date.now(), from: 'TX', to: legacy, amount: 10 * U });
  assert.equal(r1.status, 'credited');
  // 新的合约地址也照常入账（合约扫链：chain = tron）
  const r2 = await core.recordDeposit(db, { chain: 'tron', txid: 'b'.repeat(64), logIndex: 0, block: 2, time: Date.now(), from: randomTron(), to: renewed.address, amount: 10 * U, rawAmount: String(10 * U) });
  assert.equal(r2.status, 'credited');
  assert.equal(r2.deposit.customer_id, 'old');
  await db.end?.();
});

test('按链切换：TRON 开通后可以设置 TRON 的提供方（不再 chain_not_enabled）；切到没开通的提供方 provider_not_enabled', async () => {
  const { setChainProvider } = await import('../server/wallet/router.js');
  const { createUnavailableProvider } = await import('../server/wallet/provider.js');
  const db = await setupDb();
  const { p } = await provider(db);
  const providers = { contract: p, cobo: createUnavailableProvider('cobo') };
  const CODE = { code: '123456', verifyCode: async (c) => c === '123456' };
  const r = await setChainProvider(db, { chain: 'tron', provider: 'contract', actor: 'admin', reason: '第 2 批开通', providers, ...CODE });
  assert.equal(r.to, 'contract');
  await assert.rejects(setChainProvider(db, { chain: 'tron', provider: 'cobo', actor: 'admin', reason: 'x', providers, ...CODE }), (e) => e.code === 'provider_not_enabled');
  await db.end?.();
});

// ---------- 钱包层 + 商户接口（和本地运行同一条路径） ----------

async function stack({ withTron = true } = {}) {
  const { createTestDb } = await import('../server/pay/db.js');
  const { migrate } = await import('../server/pay/schema.js');
  const core = await import('../server/pay/core.js');
  const { createOps } = await import('../server/pay/ops.js');
  const { createPayApi } = await import('../server/pay/pay-api.js');
  const { derivePayKeys } = await import('../server/pay/common.js');
  const { createWalletLayer } = await import('../server/wallet/index.js');
  const { loadConfig } = await import('../server/config.js');
  const { walletsFor } = await import('../server/pay/deps.js');
  const db = await createTestDb(); await migrate(db);
  const { scheme, usdt } = tronScheme();
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm: walletsFor('local').evm || {}, ...(withTron ? { tron: { ...scheme, usdt } } : {}) });
  const ops = createOps({ db, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), payBase: 'https://pay.test', wallet: layer });
  const pay = createPayApi({ db, layer });
  await core.createMerchant(db, { id: 'ma', name: 'ma', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  await db.query(`update merchants set order_mode = jsonb_set(order_mode, '{enabled}', 'true') where id = 'ma'`);
  const [m] = await db.query(`select * from merchants where id = 'ma'`);
  const payGet = async (o, chain) => { const res = await pay(new Request(`https://pay.test/api/pay/?o=${o}${chain ? `&chain=${chain}` : ''}`)); return { status: res.status, body: await res.json() }; };
  return { db, layer, ops, m, payGet, scheme, core };
}

test('钱包层：传了 tron 合约参数就开通 TRON（本地用替身，不连节点）；不传和第 1 批一样不开通', async () => {
  const on = await stack();
  assert.ok(on.layer.enabledChains.includes('tron'), JSON.stringify(on.layer.errors));
  assert.ok(on.layer.providers.contract.chains.includes('tron'));
  const off = await stack({ withTron: false });
  assert.ok(!off.layer.enabledChains.includes('tron'));
  await on.db.end?.(); await off.db.end?.();
});

test('K1 + 第 2 批：订单指定 TRON 时建单生成 TRON 合约地址；付款页能选 TRON、选了才生成；同一客户复用；照常入账', async () => {
  const { db, ops, m, payGet, scheme, core } = await stack();
  await ops.upsertCustomer(m, { customer_id: 'k1' });
  const o1 = await ops.createOrder(m, { customer_id: 'k1', merchant_order_no: 'T1', amount: '10', chain: 'tron' });
  assert.match(o1.address, /^T/);
  assert.equal(o1.chain, 'tron');
  assert.equal(o1.network, 'TRON');
  const [row] = await db.query(`select * from customer_addresses where customer_id = 'k1' and chain = 'tron'`);
  assert.equal(row.provider, 'contract');
  assert.equal(row.address, forwarderOf(scheme, row.salt));
  const o2 = await ops.createOrder(m, { customer_id: 'k1', merchant_order_no: 'T2', amount: '10', chain: 'tron' });
  assert.equal(o2.address, o1.address, '同一条链复用');
  // 不指定链：付款页能选三条链，选 TRON 才生成
  await ops.upsertCustomer(m, { customer_id: 'k2' });
  const o3 = await ops.createOrder(m, { customer_id: 'k2', merchant_order_no: 'A1', amount: '10' });
  const g0 = await payGet(o3.order_no);
  assert.deepEqual(g0.body.chains, ['eth', 'bsc', 'tron']);
  assert.equal((await db.query(`select count(*)::int n from customer_addresses where customer_id = 'k2'`))[0].n, 0);
  const gt = await payGet(o3.order_no, 'tron');
  assert.equal(gt.status, 200, JSON.stringify(gt.body));
  assert.match(gt.body.address, /^T/);
  assert.equal(gt.body.network, 'TRON');
  assert.deepEqual((await db.query(`select chain from customer_addresses where customer_id = 'k2'`)).map((r) => r.chain), ['tron']);
  // 新客户的旧字段 address：对外 customer.address 仍是第 0 批的意思（老 TRON 地址），新客户为 null —— 待产品确认（见交回说明）
  const r = await core.recordDeposit(db, { chain: 'tron', txid: 'e'.repeat(64), logIndex: 0, block: 1, time: Date.now(), from: randomTron(), to: gt.body.address, amount: 10 * U, rawAmount: String(10 * U) });
  assert.equal(r.status, 'credited');
  assert.equal(r.deposit.customer_id, 'k2');
  await db.end?.();
});
