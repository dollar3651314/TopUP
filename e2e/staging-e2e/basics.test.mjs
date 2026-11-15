// 测试管理员的自检（运维写的基础用例；业务验收用例由测试经理另写文件，放在同一目录）：
//   连的是测试环境、测试管理员开着；令牌对能读、错了 401；签名、改钱包设置等一律 403；开户审核后台不认它；
//   改上限免动态码（读出现在的值、原样写回，不改变测试环境的状态）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, raw, ok, expectError } from './lib.mjs';

test('连的是测试环境，测试管理员开着', async () => {
  const h = (await raw('/api/health/')).body;
  assert.equal(h?.env, 'staging', '不是测试环境：停止');
  assert.equal(h?.test_admin, true, '测试管理员没开（服务器上 sudo topup gen-test-admin）');
});

test('令牌对：能读打款上限、每条链的状态、归集设置', async () => {
  const limits = ok(await admin('payout-limits'), 'payout-limits');
  assert.ok(limits.perItem && limits.perDay);
  const chains = ok(await admin('wallet-chains'), 'wallet-chains');
  assert.ok(Array.isArray(chains.chains));
  ok(await admin('wallet-sweep-settings'), 'wallet-sweep-settings');
});

test('令牌错或不带：401', async () => {
  expectError(await admin('payout-limits', { token: 'not-the-token' }), 401, 'unauthorized', '错令牌');
  expectError(await raw('/api/wallet/?a=payout-limits'), 401, 'unauthorized', '不带令牌');
});

test('签名、交签名、改授权额度、改钱包设置、确认作废、开通商户：403（服务器在执行前就拦下，不改任何东西）', async () => {
  for (const a of ['sign-verify', 'sign-submit', 'payout-submit', 'payout-void-confirmed', 'allowance-plan', 'allowance-submit', 'wallet-sweep-settings-save', 'wallet-route-set', 'merchant-open']) {
    expectError(await admin(a, { body: { code: '000000', reason: 'staging-e2e 自检：应当被拒绝' } }), 403, 'test_admin_forbidden', a);
  }
});

test('开户审核后台不认测试令牌：401', async () => {
  const r = await raw('/api/kyb/?g=admin&a=apps', { headers: { 'x-topup-test-admin': process.env.STAGING_TEST_ADMIN_TOKEN } });
  assert.equal(r.status, 401);
});

test('改打款上限免动态码：现在的值原样写回，返回的值不变', async () => {
  const before = ok(await admin('payout-limits'), 'payout-limits');
  const after = ok(await admin('payout-limits-save', { body: { values: before, reason: 'staging-e2e 自检：原值写回', code: '000000' } }), 'payout-limits-save');
  assert.deepEqual(after, before);
});
