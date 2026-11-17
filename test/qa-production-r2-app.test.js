// 测试先写（测试经理，生产第 2 轮）：生产（APP_ENV=production）连的不是 TRON 主网 → web、worker 拒绝启动。开发不要改这个文件，有异议找测试经理改。
// 约定（接口）：
//   - refuseConfig(config)：APP_ENV=production 且 config.tronNetwork !== 'mainnet' → 返回拒绝说明（字符串）；说明里有变量名 TRON_NETWORK，没有它的值
//   - createApp 同样拒绝（抛错，错误信息里有 TRON_NETWORK、没有值）；startWorker 拒绝；createWeb 的健康检查 503（初始化不成功）
//   - TRON_NETWORK 没填时按默认 mainnet，不拒绝；测试环境（staging + nile）不受影响
// 不需要数据库：拒绝发生在连数据库之前，也在检查配置齐不齐（missingConfig）之前。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { refuseConfig, createApp } from '../server/app.js';

const BASE = { APP_ENV: 'production', NODE_ENV: 'production', APP_SECRET: 'p'.repeat(48), BLOB_DIR: '/nonexistent-qa', PUBLIC_URL: 'https://topup.example.com', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' };
// 故意不给 REDIS_URL：拒绝要在检查配置齐不齐之前（和测试管理员的拒绝一样），也免得测试去连本机不存在的 Redis
const BAD = ['nile', 'shasta', 'Mainnet', 'mainnet2'];

test('refuseConfig：生产 + TRON_NETWORK 不是 mainnet → 拒绝，说明里只有变量名', () => {
  for (const v of BAD) {
    const why = refuseConfig(loadConfig({ ...BASE, TRON_NETWORK: v }));
    assert.equal(typeof why, 'string', `TRON_NETWORK=${v}：要拒绝`);
    assert.match(why, /TRON_NETWORK/);
    assert.ok(!why.includes(v), `说明里没有值 ${v}：${why}`);
  }
});

test('对照：生产 + mainnet（或没填，默认 mainnet）不拒绝；测试环境 + nile 不拒绝', () => {
  assert.equal(refuseConfig(loadConfig({ ...BASE, TRON_NETWORK: 'mainnet' })), null);
  assert.equal(refuseConfig(loadConfig({ ...BASE })), null);
  assert.equal(refuseConfig(loadConfig({ ...BASE, APP_ENV: 'staging', TRON_NETWORK: 'nile' })), null);
});

test('createApp：生产 + nile → 拒绝（不初始化），错误信息里有 TRON_NETWORK、没有值', async () => {
  await assert.rejects(createApp(loadConfig({ ...BASE, TRON_NETWORK: 'nile' })), (e) => /TRON_NETWORK/.test(String(e.message)) && !String(e.message).includes('nile'));
});

test('startWorker：生产 + nile → 拒绝', async () => {
  const { startWorker } = await import('../server/worker.js');
  const log = { log() {}, error() {}, warn() {} };
  await assert.rejects(startWorker(loadConfig({ ...BASE, TRON_NETWORK: 'nile' }), { log }), (e) => /TRON_NETWORK/.test(String(e.message)) && !String(e.message).includes('nile'));
});

test('createWeb：生产 + nile → 健康检查 503（收付款没有初始化）', async () => {
  const { createWeb } = await import('../server/web.js');
  const err = console.error; console.error = () => {};
  try {
    const web = createWeb(loadConfig({ ...BASE, TRON_NETWORK: 'nile' }));
    web.app.catch(() => {});
    const res = await web.handle(new Request('https://topup.example.com/api/health/'));
    assert.equal(res.status, 503);
    const b = await res.json();
    assert.equal(b.wallet, undefined, '没有初始化成功的钱包项');
  } finally { console.error = err; }
});
