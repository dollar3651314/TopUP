// 归集发起账户手续费币的提前提醒（server/wallet/operator-gas.js）：
//   一、只够约 3 批以下发一封"偏低"、不够一批发一封"不够一批"，同一状态不重复发，重启（重新建对象）不重发
//   二、恢复要够 4 批才发"已补足"（gas 价来回波动不反复发）；查不到余额不改状态、不发信
//   三、10 分钟内只查一次；没配发起账户、没开通的链不提醒；后台和邮件用同一个判断
//   四、worker 的 runTick 带上这一步：出错只记在这一步，不影响别的步骤
// 只用替身（内存数据库、ETH/BSC 内存替身），不需要任何密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { createWalletLayer } from '../server/wallet/index.js';
import { loadConfig } from '../server/config.js';
import { walletsFor } from '../server/pay/deps.js';
import { checkOperatorGas, operatorGasStatus, gasLevel, OPERATOR_GAS_CHECK_MS } from '../server/wallet/operator-gas.js';
import { runTick } from '../server/pay/tick.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';

const T0 = Date.parse('2026-12-01T04:00:00Z');

async function setup() {
  const db = await createTestDb(); await migrate(db);
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm: walletsFor('local').evm || {} });
  const mails = [];
  const notify = async (subject, text) => { mails.push({ subject, text }); };
  const per = BigInt((await layer.providers.contract.estimateFee('eth', 'sweep', 10, { deploy: 5 })).native);
  const set = (wei) => { layer.adapters.eth.nativeBalance = async () => wei; };
  let t = T0;
  const run = (opts = {}) => { t += OPERATOR_GAS_CHECK_MS; return checkOperatorGas(db, { layer, notify, now: t, chains: ['eth'], adminUrl: 'https://x/admin/', ...opts }); };
  return { db, layer, mails, notify, per, set, run };
}

test('一、够 3 批不发；不够 3 批发一封"只够约 2 批"，同一状态不重复发；降到不够一批再发一封；补够 4 批发"已补足"', async () => {
  const { db, layer, mails, per, set, run } = await setup();
  assert.ok(layer.enabledChains.includes('eth') && layer.operatorConfigured, '前提：本地以太坊开通、发起账户已配');
  set(per * 3n);
  assert.equal((await run()).chains.eth, 'ok');
  assert.equal(mails.length, 0, '正好够 3 批：不发');
  set(per * 3n - 1n);
  assert.equal((await run()).chains.eth, 'low');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /以太坊 归集发起账户的 ETH 只够约 2 批归集/);
  assert.match(mails[0].text, /发起账户地址（公开地址/);
  assert.ok(mails[0].text.includes(layer.providers.contract.operator), '邮件里有发起账户的公开地址（补币用）');
  assert.doesNotMatch(mails[0].text, /0x[0-9a-f]{64}/i, '不出现 64 位十六进制（私钥长度）');
  await run(); await run();
  assert.equal(mails.length, 1, '同一状态不重复发');
  set(per - 1n);
  assert.equal((await run()).chains.eth, 'out');
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /不够付一批归集/);
  set(per * 3n);
  assert.equal((await run()).chains.eth, 'low', '补到正好 3 批：还没到恢复线（4 批），算偏低');
  assert.equal(mails.length, 3, 'out → low 是状态变化：发一封');
  assert.match(mails[2].subject, /以太坊 归集发起账户的 ETH 仍偏低：只够约 3 批归集（补到 4 批算恢复）/, '从不够一批补上来、还没到恢复线：写仍偏低');
  set(per * 4n);
  assert.equal((await run()).chains.eth, 'ok');
  assert.equal(mails.length, 4);
  assert.match(mails[3].subject, /已补足/);
  await run();
  assert.equal(mails.length, 4, '恢复后不再发');
  await db.end?.();
});

test('二、恢复线：偏低后 gas 价波动到正好 3 批（4 批以下）不发"已补足"；查不到余额不改状态、不发信', async () => {
  const { db, layer, mails, per, set, run } = await setup();
  set(per * 2n);
  await run();
  assert.equal(mails.length, 1);
  set(per * 3n + per / 2n);
  assert.equal((await run()).chains.eth, 'low');
  assert.equal(mails.length, 1, '3.5 批：不发恢复');
  layer.adapters.eth.nativeBalance = async () => { throw Object.assign(new Error('down'), { code: 'rpc_unreachable' }); };
  assert.equal((await run()).chains.eth, 'unknown');
  assert.equal(mails.length, 1, '节点连不上：不发信');
  set(per * 10n);
  assert.equal((await run()).chains.eth, 'ok');
  assert.equal(mails.length, 2);
  await db.end?.();
});

test('二、余额 0、估不出手续费：发"不够一批"；余额不为 0、估不出：不发（和后台一致）', async () => {
  const { db, layer, mails, set, run } = await setup();
  layer.adapters.eth.gasPrice = async () => { throw new Error('rpc down'); };
  set(10n ** 18n);
  assert.equal((await run()).chains.eth, 'ok');
  set(0n);
  assert.equal((await run()).chains.eth, 'out');
  assert.equal(mails.length, 1);
  await db.end?.();
});

test('二、待确认批次的手续费比余额多：算"不够一批"，发信', async () => {
  const { db, mails, per, set, run } = await setup();
  set(per * 5n);
  await db.query(`insert into wallet_sweep_batches (id, chain, provider, status, total, address_count, skipped, fee_estimate, slot, created_at, expires_at, updated_at)
    values ('OG-1', 'eth', 'contract', 'awaiting_approval', 1, 1, '[]', $1::jsonb, '', now(), now() + interval '1 day', now())`, [JSON.stringify({ native: String(per * 6n) })]);
  assert.equal((await run()).chains.eth, 'out');
  assert.match(mails[0].text, /待确认的归集批次估的手续费/);
  await db.end?.();
});

test('三、10 分钟内只查一次；重启（状态在数据库里）不重发', async () => {
  const { db, layer, mails, notify, per, set } = await setup();
  set(per);
  let calls = 0;
  const orig = layer.adapters.eth.nativeBalance;
  layer.adapters.eth.nativeBalance = async (a) => { calls++; return orig(a); };
  await checkOperatorGas(db, { layer, notify, now: T0, chains: ['eth'] });
  assert.equal((await checkOperatorGas(db, { layer, notify, now: T0 + OPERATOR_GAS_CHECK_MS - 1, chains: ['eth'] })).skipped, 'interval');
  assert.equal(calls, 1);
  assert.equal(mails.length, 1);
  // "重启"：新建的 layer、同一个数据库
  const layer2 = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm: walletsFor('local').evm || {} });
  layer2.adapters.eth.nativeBalance = async () => per;
  await checkOperatorGas(db, { layer: layer2, notify, now: T0 + OPERATOR_GAS_CHECK_MS, chains: ['eth'] });
  assert.equal(mails.length, 1, '重启后同一状态不重发');
  await db.end?.();
});

test('三、没配发起账户 / 没开通的链：off，不发信；之前在提醒中的状态清掉（不发恢复）', async () => {
  const { db, layer, mails, per, set, run } = await setup();
  set(per);
  await run();
  assert.equal(mails.length, 1);
  layer.operatorConfigured = false;
  assert.equal((await run()).chains.eth, 'off');
  assert.equal(mails.length, 1);
  const [r] = await db.query(`select count(*)::int n from pay_meta where key = 'operator_gas_eth'`);
  assert.equal(r.n, 0);
  assert.equal(gasLevel({ enabled: false, configured: true }), 'off');
  await db.end?.();
});

test('三、后台的 low 和邮件用同一个判断：operatorGasStatus 的 low 与级别对应', async () => {
  const { db, layer, per, set } = await setup();
  set(per * 2n);
  const s = await operatorGasStatus({ db, layer, chain: 'eth' });
  assert.equal(s.batches_left, 2);
  assert.equal(s.low, true);
  assert.equal(gasLevel(s), 'low');
  await db.end?.();
});

test('四、runTick 带上 operator_gas 一步：出错只记在这一步，回调等照常', async () => {
  const db = await createTestDb(); await migrate(db);
  const out = await runTick({ db, tron: createFakeTron({ network: 'nile' }), getTarget: async () => null, operatorGas: async () => { throw new Error('boom'); } });
  assert.deepEqual(out.operator_gas, { error: 'boom' });
  assert.ok('callbacks' in out);
  const ok = await runTick({ db, tron: createFakeTron({ network: 'nile' }), getTarget: async () => null, operatorGas: async () => ({ chains: { eth: 'ok' } }) });
  assert.deepEqual(ok.operator_gas, { chains: { eth: 'ok' } });
  await db.end?.();
});
