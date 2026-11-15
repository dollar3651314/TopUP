// 测试管理员（server/pay/test-admin.js，只在测试环境）：
//   一、只有 APP_ENV=staging 且配了 64 位十六进制哈希才开；生产配了这个变量拒绝启动（refuseConfig、createApp），本地忽略
//   二、请求头带对令牌才算；带错（或这个环境没开）一律 401、不再看 Cookie；不带照旧看管理员会话
//   三、白名单：签名、交签名、改授权额度、改钱包设置、确认作废、开通商户一律 403（并记审计）；新加的动作默认不给
//   四、改打款上限对测试管理员免动态码，actor 记 test-admin；这次请求结束后免动态码不会"漏"给别的请求
//   五、健康检查：测试环境有 test_admin（只给是否），生产没有
// 只用替身（内存数据库、内存 Redis、TronGrid 替身），令牌是这里随机生成的，不是任何环境的真实令牌。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createTestDb } from '../server/pay/db.js';
import { createMerchant } from '../server/pay/core.js';
import { migrate } from '../server/pay/schema.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { createAdminGate } from '../server/pay/admin-gate.js';
import { derivePayKeys } from '../server/pay/common.js';
import { deriveKeys } from '../server/kyb/crypto.js';
import { createMemRedis } from '../server/kyb/memredis.js';
import { loadConfig } from '../server/config.js';
import { refuseConfig, createApp } from '../server/app.js';
import { createWeb } from '../server/web.js';
import { testAdminHash, refuseTestAdmin, TEST_ADMIN_ACTIONS, TEST_ADMIN_WRITES, TEST_ADMIN_HEADER, isTestAdmin, maskForTestAdmin, createTestnetCheck } from '../server/pay/test-admin.js';

const TOKEN = randomBytes(32).toString('hex');
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const SECRET = 'test-app-secret-test-app-secret-0123456789';

// ---------- 一、开关 ----------

test('一、只有 staging + 64 位十六进制哈希才开；生产、本地、格式不对都不开', () => {
  assert.equal(testAdminHash(loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile', TEST_ADMIN_TOKEN_SHA256: HASH })), HASH);
  assert.equal(testAdminHash(loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile', TEST_ADMIN_TOKEN_SHA256: ` ${HASH.toUpperCase()}\n` })), HASH, '复制时带的空白、大写都认');
  assert.equal(testAdminHash(loadConfig({ APP_ENV: 'production', TEST_ADMIN_TOKEN_SHA256: HASH })), '');
  assert.equal(testAdminHash(loadConfig({ APP_ENV: 'local', TEST_ADMIN_TOKEN_SHA256: HASH })), '');
  assert.equal(testAdminHash(loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile', TEST_ADMIN_TOKEN_SHA256: TOKEN.slice(0, 63) })), '');
  assert.equal(testAdminHash(loadConfig({ APP_ENV: 'staging', TEST_ADMIN_TOKEN_SHA256: HASH })), '', 'TRON 不是 Nile（默认主网）：不开');
  assert.equal(testAdminHash(loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'mainnet', TEST_ADMIN_TOKEN_SHA256: HASH })), '');
  assert.equal(testAdminHash(loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile' })), '');
});

test('一、生产配了 TEST_ADMIN_TOKEN_SHA256：refuseConfig 拒绝（说明里只有变量名、没有值），createApp 也拒绝；测试环境、本地不拒绝', async () => {
  const prod = loadConfig({ APP_ENV: 'production', NODE_ENV: 'production', TEST_ADMIN_TOKEN_SHA256: HASH });
  const why = refuseConfig(prod);
  assert.match(why, /TEST_ADMIN_TOKEN_SHA256/);
  assert.ok(!why.includes(HASH));
  assert.equal(refuseTestAdmin(loadConfig({ APP_ENV: 'production', TEST_ADMIN_TOKEN_SHA256: 'x' })) !== null, true, '值不对也拒绝：有这个变量就不行');
  await assert.rejects(createApp(prod), (e) => e.code === 'test_admin_in_production' && !String(e.message).includes(HASH));
  assert.equal(refuseConfig(loadConfig({ APP_ENV: 'staging', NODE_ENV: 'production', TEST_ADMIN_TOKEN_SHA256: HASH })), null);
  assert.equal(refuseConfig(loadConfig({ APP_ENV: 'production', NODE_ENV: 'production' })), null, '生产没配：照常');
});

// ---------- 二～四、运营后台接口 ----------

async function setup({ hash = HASH, testnetCheck = null } = {}) {
  const db = await createTestDb(); await migrate(db);
  const gate = createAdminGate({ redis: createMemRedis(), kybKeys: deriveKeys(SECRET), testAdminHash: hash, testnetCheck });
  const api = createWalletApi({ db, tron: createFakeTron(), keys: derivePayKeys(SECRET), wallets: { hot: '', cold: '' }, ...gate });
  const call = async (a, { token = TOKEN, body, headers = {} } = {}) => {
    const h = { 'x-topup-csrf': '1', ...(token === null ? {} : { [TEST_ADMIN_HEADER]: token }), ...headers };
    const res = await api(new Request(`https://x/api/wallet/?a=${a}`, body ? { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: h }));
    return { status: res.status, body: await res.json() };
  };
  const audits = async () => db.query('select actor, action, target, detail from pay_audit order by id');
  return { db, gate, api, call, audits };
}

test('二、带对令牌：能读；带错令牌：401；这个环境没开（哈希空）：带了也 401；不带：照旧要管理员会话（401）', async () => {
  const { db, call } = await setup();
  const ok = await call('payout-limits');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.perItem);
  assert.equal((await call('payout-limits', { token: 'wrong' })).status, 401);
  assert.equal((await call('payout-limits', { token: '' })).status, 401);
  assert.equal((await call('payout-limits', { token: null })).status, 401);
  await db.end?.();
  const off = await setup({ hash: '' });
  assert.equal((await off.call('payout-limits')).status, 401, '没开：令牌对也不认');
  await off.db.end?.();
});

test('三、白名单外的动作一律 403（签名、交签名、改授权额度、改钱包设置、确认作废、开通商户），并记一条审计', async () => {
  const { db, call, audits } = await setup();
  const forbidden = ['sign-verify', 'sign-submit', 'payout-submit', 'payout-void-confirmed', 'allowance-plan', 'allowance-submit',
    'wallet-sweep-settings-save', 'wallet-route-set', 'merchant-open', 'merchant-save', 'merchant-reinvite', 'merchants', 'customers', 'customer'];
  for (const a of forbidden) {
    assert.ok(!TEST_ADMIN_ACTIONS.has(a), `${a} 不在白名单里`);
    const r = await call(a, { body: { code: '000000', reason: 'x' } });
    if (r.status !== 403) assert.fail(`${a}: ${r.status}`);
    assert.equal(r.status, 403, a);
    assert.equal(r.body.error.code, 'test_admin_forbidden');
  }
  const rows = (await audits()).filter((r) => r.action === 'test_admin.request');
  assert.equal(rows.length, forbidden.length);
  assert.ok(rows.every((r) => r.actor === 'test-admin' && r.detail.result === 'forbidden'));
  await db.end?.();
});

test('三、白名单里的动作都是真实存在的动作；默认不给：动作清单里不在白名单的都 403', async () => {
  const { db, api, call } = await setup();
  for (const a of TEST_ADMIN_ACTIONS) assert.ok(api.actions.includes(a), `${a} 不是运营后台的动作`);
  for (const a of api.actions.filter((x) => !TEST_ADMIN_ACTIONS.has(x))) {
    assert.equal((await call(a)).status, 403, a);
  }
  await db.end?.();
});

test('四、改打款上限：测试管理员免动态码、actor 记 test-admin；之后同一个 gate 的动态码核对恢复正常（不漏给别的请求）', async () => {
  const { db, gate, call, audits } = await setup();
  const r = await call('payout-limits-save', { body: { values: { perItem: '123' }, reason: '测试管理员改上限', code: '000000' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.perItem, '123.00');
  const rows = await audits();
  assert.ok(rows.some((x) => x.actor === 'test-admin' && x.action !== 'test_admin.request'), '业务审计的 actor 是 test-admin');
  assert.ok(rows.some((x) => x.action === 'test_admin.request' && x.target === 'payout-limits-save' && x.detail.result === 'ok'));
  assert.ok(!JSON.stringify(rows).includes(TOKEN), '审计里没有令牌');
  assert.equal(isTestAdmin(), false);
  assert.equal(await gate.verifyAdminCode('000000'), false, '请求外：照常核对动态码（没有管理员 → false）');
  // 原因没填：照常报错（只免动态码，不免别的检查），审计记错误码
  const bad = await call('payout-limits-save', { body: { values: { perItem: '5' }, reason: '', code: '000000' } });
  assert.equal(bad.status, 422);
  assert.ok((await audits()).some((x) => x.action === 'test_admin.request' && x.detail.result === 'reason_required'));
  await db.end?.();
});

test('四、并发：测试管理员和没登录的请求同时进来，没登录的仍是 401', async () => {
  const { db, call } = await setup();
  const rs = await Promise.all([call('payout-limits-save', { body: { values: { perItem: '9' }, reason: 'r', code: '1' } }), call('payout-limits-save', { token: null, body: { values: { perItem: '9' }, reason: 'r', code: '1' } })]);
  assert.deepEqual(rs.map((x) => x.status), [200, 401]);
  await db.end?.();
});

test('三、改东西的动作只收 POST（GET 405）；白名单里的改动作都在 TEST_ADMIN_WRITES', async () => {
  const { db, call } = await setup();
  for (const a of TEST_ADMIN_WRITES) {
    assert.ok(TEST_ADMIN_ACTIONS.has(a), a);
    const r = await call(a);
    assert.equal(r.status, 405, a);
  }
  await db.end?.();
});

test('三、打码：商户名、名称、邮箱、公司名首字 + ***；链名、地址、金额不动', () => {
  const out = maskForTestAdmin({ items: [{ merchant: '某某科技有限公司', email: 'a@b.c', amount: '1.00', to: '0xabc' }], cards: [{ name: 'eth', chain: 'eth' }], top_merchants: [{ name: 'Acme', amount: 5 }], company: 'Zed' });
  assert.deepEqual(out, { items: [{ merchant: '某***', email: 'a***', amount: '1.00', to: '0xabc' }], cards: [{ name: 'eth', chain: 'eth' }], top_merchants: [{ name: 'A***', amount: 5 }], company: 'Z***' });
});

test('三、节点核对（测试网白名单）：以太坊 / BSC 节点不是认可的测试网（主网、别的链）或查不到时不认测试管理员；Sepolia、Holesky、Hoodi、BSC 测试网照常', async () => {
  const t = (ids) => createTestnetCheck(Object.fromEntries(ids.map((id, i) => [`c${i}`, { chainId: async () => { if (id === 'down') throw new Error('down'); return id; } }])));
  const err = console.error; console.error = () => {};
  try {
    assert.equal(await t([11155111])(), true);
    assert.equal(await t([11155111, 97])(), true);
    assert.equal(await t([17000, 560048])(), true);
    assert.equal(await t([137])(), false, '别的链（不是主网也不在白名单）：不认');
    assert.equal(await t([31337])(), false, '本机链：不认');
    assert.equal(await t([1])(), false);
    assert.equal(await t([11155111, 56])(), false);
    assert.equal(await t(['down'])(), false);
    assert.equal(await createTestnetCheck({})(), true, '没配以太坊 / BSC 节点：只看 TRON_NETWORK');
  } finally { console.error = err; }
  const { db, call } = await setup({ testnetCheck: t([1]) });
  assert.equal((await call('payout-limits')).status, 401, '主网节点：令牌对也不认');
  await db.end?.();
});

test('三、打码兜底：任何字段里的邮箱形式内容（客户编号、驳回原因、商户名）都打码；白名单里所有只读动作的返回都没有 @', async () => {
  assert.equal(JSON.stringify(maskForTestAdmin({ customer_id: 'bob@x.com', reason: '联系 a.b@c.d 处理', list: ['z@y.x'] })), JSON.stringify({ customer_id: 'b***', reason: '联系 a*** 处理', list: ['z***'] }));
  const { db, call } = await setup();
  const m = await createMerchant(db, { name: 'shop@example.com 科技', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  await db.query(`insert into customers (merchant_id, customer_id, name, address, hd_index, onchain) values ($1, 'cust@example.com', 'n@example.com', 'TQ-test-address', 1, 5)`, [m.id]);
  await db.query(`insert into anomalies (type, merchant_id, customer_id, address, amount) values ('unknown', $1, 'anom@example.com', 'TQ-a', '1')`, [m.id]);
  for (const [id, status] of [['WD-T1', 'pending'], ['WD-T2', 'rejected']]) {
    await db.query(`insert into withdrawals (id, merchant_id, kind, customer_id, to_address, amount, fee, source, status, reason) values ($1, $2, 'payout', 'wd@example.com', 'TQ-to', 1000000, 0, 'api', $3, '已通知 ops@example.com')`, [id, m.id, status]);
  }
  const reads = [...TEST_ADMIN_ACTIONS].filter((a) => !TEST_ADMIN_WRITES.has(a));
  const okOnes = [];
  for (const a of reads) {
    for (const qs of a === 'withdrawals' ? ['', '&all=1'] : ['']) {
      const r = await call(a + qs);
      if (r.status !== 200) continue;
      okOnes.push(a);
      assert.ok(!JSON.stringify(r.body).includes('@'), `${a}${qs} 的返回里有 @`);
    }
  }
  for (const a of ['withdrawals', 'payout-overview', 'anomalies', 'sweep-list', 'overview']) assert.ok(okOnes.includes(a), `前提：${a} 读到了（${okOnes.join(',')}）`);
  await db.end?.();
});

// ---------- 五、健康检查 ----------

test('五、健康检查：测试环境有 test_admin（只给是否、没有哈希）；生产配了这个变量：起不来（503、没有 test_admin）', async () => {
  const st = createWeb(loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile', TEST_ADMIN_TOKEN_SHA256: HASH }));
  st.app.catch(() => {});
  const h = await (await st.handle(new Request('http://x/api/health/'))).json();
  assert.equal(h.test_admin, true);
  assert.ok(!JSON.stringify(h).includes(HASH));
  const st2 = createWeb(loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile' }));
  st2.app.catch(() => {});
  assert.equal((await (await st2.handle(new Request('http://x/api/health/'))).json()).test_admin, false);
  const pr = createWeb(loadConfig({ APP_ENV: 'production', TEST_ADMIN_TOKEN_SHA256: HASH }));
  pr.app.catch(() => {});
  const res = await pr.handle(new Request('http://x/api/health/'));
  const hp = await res.json();
  assert.equal(res.status, 503);
  assert.equal('test_admin' in hp, false);
});
