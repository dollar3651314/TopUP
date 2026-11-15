// 测试会话补测（没开通的链不算出错）：config/wallets.json 里一条链的合约地址（usdt、factory、implementation、parent、batcher）
// 一个都没填 = 有意没开通，系统状态给 not_enabled、ok = true（不进待处理、不亮红点）；只填了一部分才是 not_configured（ok = false）。
//   一、walletChainStatus：全空 → not_enabled（节点配没配都一样），不返回任何地址的值；只填 usdt、只缺 batcher → not_configured
//   二、运营后台 wallet-chains：以太坊发起账户余额为 0、估手续费失败（或节点报的 gas 价为 0）时 operator.low 照样是 true
//   三、健康检查 /api/health/ 的 wallet.chains：测试环境配置里 BSC 的合约地址全空 → not_enabled（需要 TEST_DATABASE_URL）
// 只用替身（内存数据库 / 真实 Postgres、ETH/BSC 内存替身、TronGrid 替身），不需要任何密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walletChainStatus } from '../server/wallet/status.js';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { createWalletLayer } from '../server/wallet/index.js';
import { loadConfig } from '../server/config.js';
import { walletsFor } from '../server/pay/deps.js';
import { addressOfPrivateKey } from '../server/pay/signing.js';

const T0 = Date.parse('2026-12-01T04:00:00Z');
const A = (n) => '0x' + String(n).repeat(40).slice(0, 40); // 假地址（只看配没配，不上链）
const FULL = { ver: 1, factory: A(1), implementation: A(2), parent: A(3), batcher: A(4) };
const EMPTY = { ver: 1, factory: '', implementation: '', parent: '', batcher: '' };
const fresh = { cursor: '990', head: 1000, confirmations: 10, lastScanAt: new Date(T0 - 20_000).toISOString(), now: T0 };

// ---------- 一、walletChainStatus ----------

test('全空的链（节点已配）：not_enabled、ok = true，不返回任何地址的值', () => {
  const s = walletChainStatus({ chain: 'bsc', rpcConfigured: true, usdtConfigured: false, scheme: EMPTY, ...fresh });
  assert.equal(s.status, 'not_enabled');
  assert.equal(s.ok, true);
  assert.equal(s.chain, 'bsc');
  assert.equal(s.usdt, false);
  assert.deepEqual(s.contracts, { factory: false, implementation: false, parent: false, batcher: false });
  assert.doesNotMatch(JSON.stringify(s), /0x[0-9a-fA-F]{40}/, '不返回地址的值');
});

test('全空的链（节点没配、从没扫过块）：同样是 not_enabled、ok = true；scheme 缺省或只有 ver 也算全空', () => {
  for (const scheme of [EMPTY, {}, undefined, { ver: 1 }]) {
    const s = walletChainStatus({ chain: 'eth', rpcConfigured: false, usdtConfigured: false, scheme, now: T0 });
    assert.equal(s.status, 'not_enabled', JSON.stringify(scheme));
    assert.equal(s.ok, true);
    assert.equal(s.rpc, false);
  }
});

test('只填了一部分：只填 usdt → not_configured、ok = false', () => {
  const s = walletChainStatus({ chain: 'bsc', rpcConfigured: true, usdtConfigured: true, scheme: EMPTY, ...fresh });
  assert.equal(s.status, 'not_configured');
  assert.equal(s.ok, false);
});

test('只填了一部分：只缺 batcher → not_configured、ok = false；只填一个合约地址（usdt 没填）也是 not_configured', () => {
  const s = walletChainStatus({ chain: 'eth', rpcConfigured: true, usdtConfigured: true, scheme: { ...FULL, batcher: '' }, ...fresh });
  assert.equal(s.status, 'not_configured');
  assert.equal(s.ok, false);
  assert.equal(s.contracts.batcher, false);
  const one = walletChainStatus({ chain: 'eth', rpcConfigured: true, usdtConfigured: false, scheme: { ...EMPTY, factory: A(1) }, ...fresh });
  assert.equal(one.status, 'not_configured');
  assert.equal(one.ok, false);
});

test('对照：全填 + 节点已配 + 扫块正常 → ok；全填但节点没配 → not_configured（节点没配不算"没开通"）', () => {
  assert.equal(walletChainStatus({ chain: 'eth', rpcConfigured: true, usdtConfigured: true, scheme: FULL, ...fresh }).status, 'ok');
  const s = walletChainStatus({ chain: 'eth', rpcConfigured: false, usdtConfigured: true, scheme: FULL, ...fresh });
  assert.equal(s.status, 'not_configured');
  assert.equal(s.ok, false);
});

// ---------- 二、发起账户余额为 0 ----------

const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');
const HOT = addressOfPrivateKey(Buffer.alloc(32, 0x11));
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function apiSetup(appEnv = 'local') {
  const db = await createTestDb(); await migrate(db);
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: appEnv }), evm: walletsFor(appEnv).evm || {} });
  const api = createWalletApi({ db, tron: createFakeTron(), keys, wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => true, layer });
  const call = async (a) => {
    const res = await api(new Request(`https://x/api/wallet/?a=${a}`, { headers: { 'x-topup-csrf': '1' } }));
    const body = await res.json();
    assert.equal(res.status, 200, `${a}: ${JSON.stringify(body)}`);
    return body;
  };
  return { db, layer, call };
}

test('以太坊发起账户余额为 0、估手续费失败：operator.low = true（不能因为估不出手续费就不提醒）', async () => {
  const { db, layer, call } = await apiSetup();
  assert.ok(layer.enabledChains.includes('eth'), '前提：本地以太坊开通');
  layer.adapters.eth.nativeBalance = async () => 0n;
  layer.adapters.eth.gasPrice = async () => { throw new Error('rpc down'); };
  const op = (await call('wallet-chains')).chains.find((c) => c.chain === 'eth').operator;
  assert.equal(op.configured, true, '前提：发起账户已配');
  assert.equal(op.gas, '0', '前提：余额读到了 0');
  assert.equal(op.batches_left, null, '前提：手续费没估出来');
  assert.equal(op.low, true);
  const bsc = (await call('wallet-chains')).chains.find((c) => c.chain === 'bsc').operator;
  assert.equal(bsc.low, false, 'BSC 不受影响');
  await db.end?.();
});

test('以太坊发起账户余额为 0、节点报的 gas 价为 0：operator.low = true', async () => {
  const { db, layer, call } = await apiSetup();
  layer.adapters.eth.nativeBalance = async () => 0n;
  layer.adapters.eth.gasPrice = async () => 0n;
  const op = (await call('wallet-chains')).chains.find((c) => c.chain === 'eth').operator;
  assert.equal(op.gas, '0', '前提：余额读到了 0，没有因为除以 0 报错');
  assert.equal(op.low, true);
  await db.end?.();
});

test('对照：余额不为 0、估手续费失败 → 不标 low（只有余额 0 才一定提醒）', async () => {
  const { db, layer, call } = await apiSetup();
  layer.adapters.eth.nativeBalance = async () => 10n ** 18n;
  layer.adapters.eth.gasPrice = async () => { throw new Error('rpc down'); };
  const op = (await call('wallet-chains')).chains.find((c) => c.chain === 'eth').operator;
  assert.equal(op.batches_left, null);
  assert.equal(op.low, false);
  await db.end?.();
});

test('运营后台 wallet-chains（测试环境配置：BSC 合约地址全空）：BSC 是 not_enabled、ok = true，不返回地址的值', async () => {
  const { db, call } = await apiSetup('staging');
  const chains = (await call('wallet-chains')).chains;
  const bsc = chains.find((c) => c.chain === 'bsc');
  assert.ok(bsc, '前提：有 BSC 一张卡');
  assert.equal(bsc.status, 'not_enabled');
  assert.equal(bsc.ok, true);
  assert.equal(bsc.operator?.low ?? false, false, '没开通的链不报手续费不够');
  assert.doesNotMatch(JSON.stringify(bsc), /0x[0-9a-fA-F]{40}/);
  await db.end?.();
});

// ---------- 三、健康检查（真实 Postgres） ----------

const PG = process.env.TEST_DATABASE_URL || '';
test('健康检查 wallet.chains：测试环境配置里 BSC 合约地址全空 → not_enabled、ok = true；以太坊（地址全填、节点没配）仍是 not_configured（需要 TEST_DATABASE_URL）', { skip: PG ? false : '没有设置 TEST_DATABASE_URL' }, async () => {
  const { createWeb } = await import('../server/web.js');
  const dir = mkdtempSync(join(tmpdir(), 'topup-qa-chainoff-'));
  const err = console.error; console.error = () => {};
  let web;
  try {
    web = createWeb(loadConfig({ APP_ENV: 'staging', REDIS_URL: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:1', DATABASE_URL: PG, MAIL_FROM: 'a@x', MAIL_TO: 'b@x', SMTP_HOST: 'smtp.x', APP_SECRET: 'x'.repeat(40), BLOB_DIR: dir, PUBLIC_URL: 'https://x.test', TRONGRID_API_KEY: 'k' }), { site: dir });
    const res = await web.handle(new Request('http://x.test/api/health/'));
    const b = await res.json();
    assert.ok(b.wallet && Array.isArray(b.wallet.chains), `前提：有 wallet 项 ${JSON.stringify(b.wallet)}`);
    const by = Object.fromEntries(b.wallet.chains.map((c) => [c.chain, c]));
    assert.equal(by.bsc.status, 'not_enabled');
    assert.equal(by.bsc.ok, true);
    assert.equal(by.eth.status, 'not_configured', '以太坊地址填了、节点没配：照旧报没配齐');
    assert.equal(by.eth.ok, false);
    assert.doesNotMatch(JSON.stringify(b.wallet), /0x[0-9a-fA-F]{40}/, 'wallet 项不返回地址的值');
  } finally {
    // 断言失败时也要关掉连接，否则进程挂住不退出
    if (web) await (await web.app).close().catch(() => {});
    console.error = err; rmSync(dir, { recursive: true, force: true });
  }
});
