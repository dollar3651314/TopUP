// 测试会话先写的用例（研发不改）：测试商户免提币 IP 白名单（只在测试环境）。
// 需求：
//   - 环境变量 TEST_MERCHANT_IP_BYPASS = 一个商户编号（变量名在这里固定；要改名先和测试商量）
//   - 只在和测试管理员相同的条件下生效：APP_ENV=staging、TRON_NETWORK=nile、配了的以太坊 / BSC 节点链 ID 都在测试网白名单
//     （11155111、17000、560048、97）；条件不满足就当没配
//   - 生产（APP_ENV=production）配了这个变量：拒绝启动（和测试管理员一样，说明里只有变量名、没有值）
//   - 效果：只对这一个商户，开放 API 的每一处 IP 白名单检查（提币 POST /api/v1/withdrawals/、批量打款 POST /api/v1/payouts/batch/）都跳过；签名、时间戳、幂等、余额等其余检查照旧；
//     别的商户不受影响（白名单为空照样 403）
//   - 健康检查：测试环境给出是否开着（只给是否，不给商户编号，仓库是公开的）；生产没有这一项
//   - 启动时记一行日志说明已开启，不带密钥
// 用例：
//   一、开关：生产配了拒绝启动（refuseConfig、createApp 都拒绝），测试环境、本地、生产没配都不拒绝
//   二、生效：staging + nile、没配以太坊 / BSC 节点：这个商户白名单为空、IP 不在白名单都能提币；签名错、时间戳过期、
//       没有幂等键、余额不够照样拒绝；别的商户照旧 403
//   三、不生效：TRON 不是 Nile、本地（APP_ENV=local）、以太坊节点是主网（链 ID 1）、变量没配：这个商户照旧 403
//   四、生效：以太坊节点是 Sepolia（11155111）时照样生效
//   五、健康检查：测试环境开着时 test_merchant_ip_bypass = true、没有商户编号；没开 false；生产起不来、没有这一项
//   六、启动日志：开着时恰好一行说明，不带 APP_SECRET、API 密钥；没开时没有这一行
//   七、批量打款（POST /api/v1/payouts/batch/）也免：这个商户白名单为空、IP 不在白名单都能提交；空列表、一行不对、签名错、
//       没有幂等键照样拒绝，幂等照旧；别的商户照旧 403（开放 API 里每一处 IP 白名单检查都免，只对这一个商户）
// 只用替身：内嵌数据库、内存 Redis；以太坊节点是本机起的一个只回链 ID 的假节点。商户编号、密钥都是这里随机生成的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { refuseConfig, createApp } from '../server/app.js';
import { createWeb } from '../server/web.js';
import { createPayDeps } from '../server/pay/deps.js';
import { createMemRedis } from '../server/kyb/memredis.js';
import { deriveKeys } from '../server/kyb/crypto.js';
import * as core from '../server/pay/core.js';
import { signRequest, canonicalPath } from '../server/pay/api-v1.js';
import { fakeTronGridNet } from './tron-helpers.js';

const ENV = 'TEST_MERCHANT_IP_BYPASS';
// TRON 节点用本机替身（tron-helpers.js 的 fakeTronGridNet）：走 createPayDeps 时不连外网的 nile.trongrid.io（K-4 起测试环境要核对节点真是 Nile）
let restoreNet;
test.before(() => { restoreNet = fakeTronGridNet(); });
test.after(() => restoreNet?.());
const U = 1_000_000;
const SECRET = 'test-app-secret-test-app-secret-0123456789';
const TO = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const quietly = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const lines = [];
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { return { out: await fn(), lines }; } finally { Object.assign(console, saved); }
};

/** 本机假以太坊节点：eth_chainId 回给定的链 ID，其余只读调用回空 */
async function fakeRpc(chainId) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const one = ({ id, method }) => {
        const result = { eth_chainId: '0x' + chainId.toString(16), eth_blockNumber: '0x64', eth_call: '0x', eth_getCode: '0x', eth_gasPrice: '0x1', eth_getBalance: '0x0' }[method];
        return result === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } } : { jsonrpc: '2.0', id, result };
      };
      let body; try { body = JSON.parse(raw); } catch { body = {}; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

/**
 * 按给定环境变量组装收付款（和 web、worker 启动时一样走 createPayDeps），建两个商户：
 *   bypass（编号写进 TEST_MERCHANT_IP_BYPASS，白名单为空）、other（白名单为空）；各有 100 USDT 余额
 */
async function stack(env = {}, { setVar = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ipb-'));
  const bypassId = `qa_ipb_${randomBytes(4).toString('hex')}`;
  const config = loadConfig({ APP_ENV: 'staging', TRON_NETWORK: 'nile', APP_SECRET: SECRET, LOCAL_DB_DIR: join(dir, 'db'), ...(setVar ? { [ENV]: bypassId } : {}), ...env });
  let ip = '198.51.100.23';
  const { out: deps, lines } = await quietly(() => createPayDeps({ config, kyb: { redis: createMemRedis(), keys: deriveKeys(SECRET) }, send: async () => {}, getIp: () => ip, origin: 'https://stg.test' }));
  const mk = async (id) => {
    const m = await core.createMerchant(deps.db, { id, name: id, feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
    await deps.db.query('update balances set available = $2 where merchant_id = $1', [id, 100 * U]);
    const [row] = await deps.db.query('select * from merchants where id = $1', [id]);
    return { m: row, cred: await deps.ops.regenerateSecret(row) };
  };
  const bypass = await mk(bypassId);
  const other = await mk(`qa_other_${randomBytes(4).toString('hex')}`);
  const call = async (cred, method, path, body, { ts = Math.floor(Date.now() / 1000), sig, idem = randomUUID(), noIdem = false } = {}) => {
    const raw = body ? JSON.stringify(body) : '';
    const full = `https://stg.test/api/v1/${path}`;
    const s = sig ?? signRequest(cred.api_secret, String(ts), method, canonicalPath(full), raw);
    const res = await deps.v1(new Request(full, { method, body: raw || undefined, headers: { 'content-type': 'application/json', 'x-topup-key': cred.api_key, 'x-topup-timestamp': String(ts), 'x-topup-signature': s, ...(method === 'POST' && !noIdem ? { 'idempotency-key': idem } : {}) } }));
    return { status: res.status, body: await res.json() };
  };
  const withdraw = (who, extra = {}, opts) => call(who.cred, 'POST', 'withdrawals/', { kind: 'payout', to: TO, amount: '10', customer_id: 'qa_buyer', ...extra }, opts);
  return { deps, config, bypass, other, call, withdraw, lines, bypassId, setIp: (v) => (ip = v), done: async () => { await deps.db.end?.(); rmSync(dir, { recursive: true, force: true }); } };
}
const code = (r) => r.body?.error?.code;

// ---------- 一、开关 ----------

test('一、生产配了 TEST_MERCHANT_IP_BYPASS：refuseConfig 拒绝（只有变量名、没有商户编号），createApp 也拒绝；测试环境、本地、生产没配都不拒绝', async () => {
  const id = `qa_ipb_${randomBytes(4).toString('hex')}`;
  const prod = loadConfig({ APP_ENV: 'production', NODE_ENV: 'production', [ENV]: id });
  const why = refuseConfig(prod);
  assert.ok(why, '生产配了这个变量要拒绝启动');
  assert.match(why, new RegExp(ENV));
  assert.ok(!why.includes(id), '拒绝说明里不能有商户编号');
  await assert.rejects(createApp(prod), (e) => !String(e.message).includes(id) && !e.missing, 'createApp 也要拒绝（不是因为缺配置）');
  assert.ok(refuseConfig(loadConfig({ APP_ENV: 'production', NODE_ENV: 'production', TRON_NETWORK: 'nile', [ENV]: id })), '生产即使 TRON_NETWORK=nile 也拒绝');
  assert.equal(refuseConfig(loadConfig({ APP_ENV: 'staging', NODE_ENV: 'production', TRON_NETWORK: 'nile', [ENV]: id })), null, '测试环境不拒绝');
  assert.equal(refuseConfig(loadConfig({ APP_ENV: 'staging', NODE_ENV: 'production', [ENV]: id })), null, '测试环境条件不满足：当没配，不拒绝');
  assert.equal(refuseConfig(loadConfig({ APP_ENV: 'local', [ENV]: id })), null, '本地忽略');
  assert.equal(refuseConfig(loadConfig({ APP_ENV: 'production', NODE_ENV: 'production' })), null, '生产没配：照常');
});

// ---------- 二、生效 ----------

test('二、staging + nile、没配以太坊 / BSC 节点：这个商户白名单为空、IP 不在白名单都能提币；其余检查照旧；别的商户照旧 403', async () => {
  const s = await stack();
  try {
    // 先确认组装的环境：没配以太坊 / BSC 节点
    assert.ok(!s.deps.layer.enabledChains.includes('eth') && !s.deps.layer.enabledChains.includes('bsc'), JSON.stringify(s.deps.layer.enabledChains));
    // 别的商户：白名单为空，照旧 403
    const o = await s.withdraw(s.other);
    assert.equal(o.status, 403); assert.equal(code(o), 'ip_not_allowed');
    // 测试商户：白名单为空也能提
    const w = await s.withdraw(s.bypass);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.status, 'pending');
    // 白名单里只有别的 IP、请求 IP 不在里面：照样能提
    await s.deps.ops.setIpWhitelist(s.bypass.m, ['203.0.113.10']);
    const [m2] = await s.deps.db.query('select * from merchants where id = $1', [s.bypassId]);
    s.bypass.m = m2;
    s.setIp('198.51.100.99');
    const w2 = await s.withdraw(s.bypass, { amount: '5' });
    assert.equal(w2.status, 200, JSON.stringify(w2.body));
    // 别的商户把这个 IP 以外的地址加进白名单：仍 403（只免这一个商户）
    await s.deps.ops.setIpWhitelist(s.other.m, ['203.0.113.10']);
    assert.equal(code(await s.withdraw(s.other)), 'ip_not_allowed');
    // 其余检查照旧：签名错、时间戳过期、没有幂等键、余额不够
    assert.equal((await s.withdraw(s.bypass, {}, { sig: 'deadbeef' })).status, 401);
    assert.equal(code(await s.withdraw(s.bypass, {}, { ts: Math.floor(Date.now() / 1000) - 400 })), 'timestamp_expired');
    assert.equal(code(await s.withdraw(s.bypass, {}, { noIdem: true })), 'idempotency_key_required');
    assert.equal(code(await s.withdraw(s.bypass, { amount: '1000' })), 'insufficient_balance');
    // 幂等：同一个 Key、同样的内容返回第一次的结果，不会再提一笔
    const idem = randomUUID();
    const a1 = await s.withdraw(s.bypass, { amount: '1' }, { idem });
    const a2 = await s.withdraw(s.bypass, { amount: '1' }, { idem });
    assert.equal(a1.status, 200); assert.equal(a2.body.withdrawal_no, a1.body.withdrawal_no);
    assert.equal(code(await s.withdraw(s.bypass, { amount: '2' }, { idem })), 'idempotency_conflict');
  } finally { await s.done(); }
});

// ---------- 三、不生效 ----------

test('三、条件不满足时当没配：TRON 不是 Nile、本地、变量没配：这个商户照旧 403 ip_not_allowed', async () => {
  for (const [label, env, opt] of [
    ['TRON_NETWORK 没设（主网）', { TRON_NETWORK: '' }],
    ['TRON_NETWORK=mainnet', { TRON_NETWORK: 'mainnet' }],
    ['APP_ENV=local', { APP_ENV: 'local' }],
    ['变量没配', {}, { setVar: false }],
  ]) {
    const s = await stack(env, opt);
    try {
      const r = await s.withdraw(s.bypass);
      assert.equal(r.status, 403, `${label}：${JSON.stringify(r.body)}`);
      assert.equal(code(r), 'ip_not_allowed', label);
    } finally { await s.done(); }
  }
});

test('三、以太坊节点是主网（链 ID 1）：不在测试网白名单，不生效（照旧 403）', async () => {
  const rpc = await fakeRpc(1);
  try {
    const s = await stack({ ETH_RPC_URL: rpc.url });
    try {
      const CHAIN = 1;
      assert.ok(s.deps.layer.adapters?.eth, `先确认以太坊节点接上了（钱包层有以太坊适配器）：${JSON.stringify(s.deps.layer.errors)}`);
      assert.equal(Number(await s.deps.layer.adapters.eth.chainId()), CHAIN, '先确认节点回的链 ID');
      const r = await s.withdraw(s.bypass);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(code(r), 'ip_not_allowed');
    } finally { await s.done(); }
  } finally { await rpc.close(); }
});

// ---------- 四、测试网节点 ----------

test('四、以太坊节点是 Sepolia（11155111）：在测试网白名单里，照样生效', async () => {
  const rpc = await fakeRpc(11155111);
  try {
    const s = await stack({ ETH_RPC_URL: rpc.url });
    try {
      const CHAIN = 11155111;
      assert.ok(s.deps.layer.adapters?.eth, `先确认以太坊节点接上了（钱包层有以太坊适配器）：${JSON.stringify(s.deps.layer.errors)}`);
      assert.equal(Number(await s.deps.layer.adapters.eth.chainId()), CHAIN, '先确认节点回的链 ID');
      const r = await s.withdraw(s.bypass);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(code(await s.withdraw(s.other)), 'ip_not_allowed', '别的商户照旧');
    } finally { await s.done(); }
  } finally { await rpc.close(); }
});

// ---------- 五、健康检查 ----------

test('五、健康检查：测试环境开着时 test_merchant_ip_bypass = true、不含商户编号；没开 false；生产起不来、没有这一项', async () => {
  const id = `qa_ipb_${randomBytes(4).toString('hex')}`;
  const get = async (env) => {
    const { out } = await quietly(async () => {
      const web = createWeb(loadConfig(env));
      web.app.catch(() => {});
      const res = await web.handle(new Request('http://x/api/health/'));
      return { status: res.status, body: await res.json() };
    });
    return out;
  };
  const on = await get({ APP_ENV: 'staging', TRON_NETWORK: 'nile', [ENV]: id });
  assert.equal(on.body.test_merchant_ip_bypass, true, JSON.stringify(on.body));
  assert.ok(!JSON.stringify(on.body).includes(id), '健康检查里不能有商户编号');
  assert.equal((await get({ APP_ENV: 'staging', TRON_NETWORK: 'nile' })).body.test_merchant_ip_bypass, false);
  assert.equal((await get({ APP_ENV: 'staging', TRON_NETWORK: 'mainnet', [ENV]: id })).body.test_merchant_ip_bypass, false, 'TRON 不是 Nile：没开');
  const pr = await get({ APP_ENV: 'production', [ENV]: id });
  assert.equal(pr.status, 503);
  assert.equal('test_merchant_ip_bypass' in pr.body, false);
  assert.ok(!JSON.stringify(pr.body).includes(id));
});

// ---------- 六、启动日志 ----------

test('六、启动日志：开着时恰好一行说明（提到 TEST_MERCHANT_IP_BYPASS），不带 APP_SECRET 和 API 密钥；没开时没有这一行', async () => {
  const s = await stack();
  try {
    const hit = s.lines.filter((l) => l.includes(ENV));
    assert.equal(hit.length, 1, `开着时恰好一行：${JSON.stringify(s.lines)}`);
    assert.ok(!hit[0].includes(SECRET), '日志不能带 APP_SECRET');
    assert.ok(!hit[0].includes(s.bypass.cred.api_secret) && !hit[0].includes(s.other.cred.api_secret));
  } finally { await s.done(); }
  const off = await stack({}, { setVar: false });
  try { assert.equal(off.lines.filter((l) => l.includes(ENV)).length, 0, '没开时没有这一行'); } finally { await off.done(); }
  const notNile = await stack({ TRON_NETWORK: 'mainnet' });
  try {
    const hit = notNile.lines.filter((l) => l.includes(ENV));
    assert.ok(hit.every((l) => !/启用|已开|enabled/i.test(l) || /不|未|not|ignored|disabled/i.test(l)), `条件不满足时不能说已开启：${JSON.stringify(hit)}`);
  } finally { await notNile.done(); }
});

// ---------- 七、批量打款 ----------

test('七、批量打款 POST /api/v1/payouts/batch/ 也免 IP 白名单（只对这个商户）；空列表、一行不对、签名错、没有幂等键照样拒绝；别的商户照旧 403', async () => {
  const s = await stack();
  try {
    const items = [{ chain: 'tron', to: TO, amount: '5', customer_id: 'qa_buyer' }, { chain: 'tron', to: TO, amount: '3', merchant_ref: 'QA-2' }];
    const batch = (who, body = { items }, opts) => s.call(who.cred, 'POST', 'payouts/batch/', body, opts);
    // 别的商户：白名单为空，照旧 403
    const o = await batch(s.other);
    assert.equal(o.status, 403); assert.equal(code(o), 'ip_not_allowed');
    // 测试商户：白名单为空也能提交
    const idem = randomUUID();
    const r1 = await batch(s.bypass, { items }, { idem });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.items.length, 2);
    // 幂等：同一个 Key、同样的内容返回同一批
    const r2 = await batch(s.bypass, { items }, { idem });
    assert.equal(r2.body.batch_no, r1.body.batch_no);
    // 白名单里只有别的 IP、请求 IP 不在里面：照样能提交
    await s.deps.ops.setIpWhitelist(s.bypass.m, ['203.0.113.10']);
    s.setIp('198.51.100.77');
    assert.equal((await batch(s.bypass, { items: [items[0]] })).status, 200);
    // 别的商户：白名单有别的 IP，照旧 403
    await s.deps.ops.setIpWhitelist(s.other.m, ['203.0.113.10']);
    assert.equal(code(await batch(s.other)), 'ip_not_allowed');
    // 其余检查照旧
    assert.equal(code(await batch(s.bypass, { items: [] })), 'invalid_param', '空列表');
    const bad = await batch(s.bypass, { items: [items[0], { chain: 'tron', to: 'not-an-address', amount: '1' }] });
    assert.equal(bad.status, 422, JSON.stringify(bad.body));
    assert.equal(code(bad), 'invalid_rows');
    assert.equal((await batch(s.bypass, { items }, { sig: 'deadbeef' })).status, 401);
    assert.equal(code(await batch(s.bypass, { items }, { noIdem: true })), 'idempotency_key_required');
  } finally { await s.done(); }
});
