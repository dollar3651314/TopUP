// K1（11/13 决定）：所有地址都是客户发起充值时才生成，客户要用哪条链就给哪条链。
//   1. 新建客户不生成任何地址（含 TRON）；没初始化 TRON 主助记词也能建客户；新客户 address 为 null、addresses 为空
//   2. 订单指定了链：创建订单时生成这条链的地址；订单不指定链：付款人在付款页选了链（付款页接口带 chain）才生成这条链的地址
//      同一客户同一条链只生成一次、之后复用（永久地址）；ETH、BSC 同一个盐、同一串地址，但只给被选中的链建行
//   3. TRON 第 1 批仍不提供（chain_not_enabled）；已有 TRON 地址的老客户照常入账、照常显示
//   4. 商户后台看客户地址不会生成地址；开发者文档不再写"新建客户就有永久地址"
// 付款页接口：GET /api/pay/?o=<订单号>[&chain=eth|bsc]。带 chain 时为这条链生成（或复用）地址并返回；
// 返回里新加 chains：付款人现在能选的链（第 1 批：eth、bsc；老客户已有 TRON 地址时加 tron；订单指定了链时只有这条链）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createOps } from '../server/pay/ops.js';
import { createPayApi } from '../server/pay/pay-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { createWalletLayer } from '../server/wallet/index.js';
import { loadConfig } from '../server/config.js';
import { walletsFor } from '../server/pay/deps.js';
import { legacyTronCustomer } from './legacy-tron.js';

const U = 1_000_000;
const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;

/** 和本地运行同一套钱包层（ETH、BSC 内存替身）；withXpub = false 表示 TRON 主助记词还没初始化 */
async function setup({ withXpub = false } = {}) {
  const db = await createTestDb(); await migrate(db);
  if (withXpub) await core.setMeta(db, 'xpub', XPUB);
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm: walletsFor('local').evm || {} });
  const ops = createOps({ db, keys, payBase: 'https://pay.test', wallet: layer });
  const pay = createPayApi({ db, layer });
  await core.createMerchant(db, { id: 'ma', name: 'ma', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  await db.query(`update merchants set order_mode = jsonb_set(order_mode, '{enabled}', 'true') where id = 'ma'`);
  const [m] = await db.query(`select * from merchants where id = 'ma'`);
  const payGet = async (orderNo, chain) => {
    const res = await pay(new Request(`https://pay.test/api/pay/?o=${orderNo}${chain ? `&chain=${chain}` : ''}`));
    return { status: res.status, body: await res.json() };
  };
  const rows = async (customerId) => (await db.query(`select chain, address from customer_addresses where merchant_id = 'ma' and customer_id = $1 order by chain`, [customerId]));
  return { db, ops, m, payGet, rows };
}

test('K1 新建客户：不生成任何地址（也没有 TRON）；没初始化 TRON 主助记词也能建（不再 503）；address 为 null、addresses 为空；商户后台看地址也不会生成', async () => {
  const { db, ops, m, rows } = await setup({ withXpub: false });
  const c = await ops.upsertCustomer(m, { customer_id: 'n1', name: 'New' });
  assert.equal(c.address, null);
  assert.deepEqual(c.addresses, []);
  assert.deepEqual(await rows('n1'), []);
  const look = await ops.customerAddresses(m, 'n1');
  assert.deepEqual(look.addresses, [], '商户后台查看地址不生成地址');
  assert.deepEqual(await rows('n1'), []);
  assert.equal((await ops.getCustomer(m, 'n1')).address, null);
  // 初始化过 TRON 主助记词也一样：新客户不再派生 TRON 地址
  const s2 = await setup({ withXpub: true });
  const c2 = await s2.ops.upsertCustomer(s2.m, { customer_id: 'n2' });
  assert.equal(c2.address, null);
  assert.deepEqual(await s2.rows('n2'), []);
  await db.end?.(); await s2.db.end?.();
});

test('K1 订单指定了链：创建订单时只生成这条链的地址；同一客户同一条链之后复用；再指定另一条链才给那条链建行（ETH、BSC 同一串）', async () => {
  const { db, ops, m, rows } = await setup();
  await ops.upsertCustomer(m, { customer_id: 'k1' });
  const o1 = await ops.createOrder(m, { customer_id: 'k1', merchant_order_no: 'E1', amount: '10', chain: 'eth' });
  assert.match(o1.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(o1.chain, 'eth');
  assert.deepEqual((await rows('k1')).map((r) => r.chain), ['eth'], '只生成 ETH，不顺带生成 BSC');
  const o2 = await ops.createOrder(m, { customer_id: 'k1', merchant_order_no: 'E2', amount: '10', chain: 'eth' });
  assert.equal(o2.address, o1.address, '同一条链复用永久地址');
  assert.equal((await rows('k1')).length, 1);
  const o3 = await ops.createOrder(m, { customer_id: 'k1', merchant_order_no: 'B1', amount: '10', chain: 'bsc' });
  assert.equal(o3.address, o1.address, 'ETH、BSC 同一个盐，同一串地址');
  assert.deepEqual((await rows('k1')).map((r) => r.chain), ['bsc', 'eth']);
  const c = await ops.getCustomer(m, 'k1');
  assert.deepEqual(c.addresses.map((a) => a.chain).sort(), ['bsc', 'eth']);
  assert.equal(c.address, null, '旧字段 address 只给 TRON');
  // 不同客户的地址不同
  await ops.upsertCustomer(m, { customer_id: 'k2' });
  const o4 = await ops.createOrder(m, { customer_id: 'k2', merchant_order_no: 'E3', amount: '10', chain: 'eth' });
  assert.notEqual(o4.address, o1.address);
  // TRON 第 1 批不提供
  await assert.rejects(ops.createOrder(m, { customer_id: 'k2', merchant_order_no: 'T1', amount: '10', chain: 'tron' }), (e) => e.code === 'chain_not_enabled');
  assert.deepEqual((await rows('k2')).map((r) => r.chain), ['eth']);
  await db.end?.();
});

test('K1 订单不指定链：创建时不生成地址、不带地址；付款页选了链才生成这条链的地址，之后复用；只给选中的链建行', async () => {
  const { db, ops, m, payGet, rows } = await setup();
  await ops.upsertCustomer(m, { customer_id: 'p1' });
  const o = await ops.createOrder(m, { customer_id: 'p1', merchant_order_no: 'A1', amount: '10' });
  assert.equal(o.address, null);
  assert.deepEqual(o.addresses, []);
  assert.deepEqual(await rows('p1'), []);
  // 付款页打开、还没选链：没有地址，告诉页面能选哪些链
  const g0 = await payGet(o.order_no);
  assert.equal(g0.status, 200);
  assert.equal(g0.body.address, null);
  assert.deepEqual(g0.body.addresses, []);
  assert.deepEqual(g0.body.chains, ['eth', 'bsc']);
  assert.deepEqual(await rows('p1'), [], '只打开付款页不生成地址');
  // 选 BSC：生成 BSC 地址
  const g1 = await payGet(o.order_no, 'bsc');
  assert.equal(g1.status, 200);
  assert.match(g1.body.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(g1.body.network, 'BSC');
  assert.deepEqual(g1.body.addresses, [{ chain: 'bsc', network: 'BSC', address: g1.body.address }]);
  assert.deepEqual((await rows('p1')).map((r) => r.chain), ['bsc'], '只给选中的链建行');
  // 再选一次 BSC（刷新）：复用，不新建
  const g2 = await payGet(o.order_no, 'bsc');
  assert.equal(g2.body.address, g1.body.address);
  assert.equal((await rows('p1')).length, 1);
  // 不带 chain 再查：列出已生成的链
  assert.deepEqual((await payGet(o.order_no)).body.addresses.map((a) => a.chain), ['bsc']);
  // 换成 ETH：生成 ETH 行，同一串
  const g3 = await payGet(o.order_no, 'eth');
  assert.equal(g3.body.address, g1.body.address);
  assert.deepEqual((await rows('p1')).map((r) => r.chain), ['bsc', 'eth']);
  // TRON 不提供；不认识的链 422
  const gt = await payGet(o.order_no, 'tron');
  assert.equal(gt.status, 409);
  assert.equal(gt.body.error.code, 'chain_not_enabled');
  assert.equal((await payGet(o.order_no, 'sol')).status, 422);
  // 付款页生成的地址照常入账，算这个客户的
  const r = await core.recordDeposit(db, { chain: 'bsc', txid: '0x' + 'ab'.repeat(32), logIndex: 0, block: 1, time: Date.now(), from: '0x' + '11'.repeat(20), to: g1.body.address, amount: 10 * U, rawAmount: String(10n * 10n ** 18n) });
  assert.equal(r.status, 'credited');
  assert.equal(r.deposit.customer_id, 'p1');
  await db.end?.();
});

test('K1 付款页：订单指定了链时只能用这条链（带别的链 409、不生成别的链）；能选的只有这条链', async () => {
  const { db, ops, m, payGet, rows } = await setup();
  await ops.upsertCustomer(m, { customer_id: 'f1' });
  const o = await ops.createOrder(m, { customer_id: 'f1', merchant_order_no: 'F1', amount: '10', chain: 'eth' });
  const g = await payGet(o.order_no);
  assert.deepEqual(g.body.chains, ['eth']);
  assert.deepEqual(g.body.addresses.map((a) => a.chain), ['eth']);
  assert.equal(g.body.address, o.address);
  const bad = await payGet(o.order_no, 'bsc');
  assert.equal(bad.status, 409);
  assert.deepEqual((await rows('f1')).map((r) => r.chain), ['eth']);
  await db.end?.();
});

test('K1 老客户（已有 TRON 地址）：照常显示 TRON 地址，付款页可以选 TRON；照常入账', async () => {
  const { db, ops, m, payGet } = await setup({ withXpub: true });
  const old = await legacyTronCustomer(db, 'ma', 'old1');
  const c = await ops.getCustomer(m, 'old1');
  assert.equal(c.address, old.address);
  assert.deepEqual(c.addresses, [{ chain: 'tron', address: old.address }]);
  const o = await ops.createOrder(m, { customer_id: 'old1', merchant_order_no: 'O1', amount: '10' });
  const g = await payGet(o.order_no);
  assert.deepEqual(g.body.chains, ['eth', 'bsc', 'tron']);
  assert.deepEqual(g.body.addresses, [{ chain: 'tron', network: 'TRON', address: old.address }]);
  const r = await core.recordDeposit(db, { txid: 'c'.repeat(64), logIndex: 0, block: 1, time: Date.now(), from: 'TX', to: old.address, amount: 10 * U });
  assert.equal(r.status, 'credited');
  await db.end?.();
});

test('K1 开发者文档：不再写"新的标识会自动创建客户和永久地址"；写明地址在充值时按链生成', async () => {
  const { ENDPOINTS, OBJECTS } = await import('../site/src/docs/api-reference.mjs');
  const text = JSON.stringify({ ENDPOINTS, OBJECTS });
  assert.doesNotMatch(text, /创建客户和永久地址|creates the customer and its permanent address/);
  const addrs = JSON.stringify(OBJECTS.Customer.find((f) => f[0] === 'addresses'));
  assert.match(addrs, /充值/, '客户 addresses 的说明写明在充值时按链生成');
});
