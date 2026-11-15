// E11：权限边界（只发会被拒绝的请求，服务器在执行前就拦下，不改任何东西）。
//   405：改东西的动作用 GET 调；403：白名单外的动作、不带防跨站请求头；401：令牌错 / 不带、开放 API 没签名或签名错、商户后台不认测试令牌；
//   404：不存在的动作。商户名、公司名、邮箱在测试管理员能读的列表里都打码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, raw, ok, expectError } from './lib.mjs';

/** 测试管理员能调的改东西的动作（server/pay/test-admin.js 的 TEST_ADMIN_WRITES）：只收 POST */
const WRITES = ['payout-approve', 'payout-review', 'payout-reject-approved', 'withdraw-reject', 'payout-unhold', 'payout-plan', 'payout-resume', 'payout-void',
  'withdraw-plan', 'payout-limits-save', 'wallet-sweep-propose', 'wallet-sweep-approve', 'wallet-sweep-cancel', 'sweep-plan', 'recon-run', 'anomaly-handle'];
/** 白名单外的动作（运营后台有、测试管理员一律不给） */
const FORBIDDEN = ['merchants', 'merchant-open', 'merchant-save', 'merchant-reinvite', 'customers', 'customer', 'sign-verify', 'sign-submit',
  'wallet-sweep-settings-save', 'wallet-route-set', 'payout-void-confirmed', 'payout-submit', 'allowance-plan', 'allowance-submit'];
const MASKED = /^.\*\*\*$/u;

test('E11 改东西的动作用 GET 调：一律 405', async () => {
  for (const a of WRITES) expectError(await admin(a), 405, 'method_not_allowed', `GET ${a}`);
});

test('E11 白名单外的动作：GET、POST 都 403', async () => {
  for (const a of FORBIDDEN) {
    expectError(await admin(a), 403, 'test_admin_forbidden', `GET ${a}`);
    expectError(await admin(a, { body: { id: 'e2e-no-such-id', reason: 'staging-e2e：应当被拒绝', code: '000000' } }), 403, 'test_admin_forbidden', `POST ${a}`);
  }
});

test('E11 令牌错或不带：读和写都 401', async () => {
  for (const a of ['payout-overview', 'recon']) {
    expectError(await admin(a, { token: 'not-the-token' }), 401, 'unauthorized', `错令牌 GET ${a}`);
  }
  for (const a of ['payout-approve', 'payout-limits-save', 'wallet-sweep-propose']) {
    expectError(await admin(a, { token: 'not-the-token', body: { ids: ['WD-E2E-NOT-EXIST'] } }), 401, 'unauthorized', `错令牌 POST ${a}`);
    expectError(await raw(`/api/wallet/?a=${a}`, { method: 'POST', body: { ids: ['WD-E2E-NOT-EXIST'] } }), 401, 'unauthorized', `不带令牌 POST ${a}`);
  }
});

test('E11 POST 不带防跨站请求头：403 csrf（令牌对也一样）', async () => {
  expectError(await raw('/api/wallet/?a=payout-approve', { method: 'POST', body: { ids: ['WD-E2E-NOT-EXIST'] }, withToken: true, raw: true }), 403, 'csrf', 'POST 不带 x-topup-csrf');
});

test('E11 不存在的动作：404', async () => {
  expectError(await admin('e2e-no-such-action'), 404, 'not_found', '不存在的动作');
});

test('E11 开放 API 没签名、签名错：401；商户后台、开户后台不认测试令牌：401', async () => {
  expectError(await raw('/api/v1/balance/'), 401, 'invalid_signature', '开放 API 没签名');
  expectError(await raw('/api/v1/balance/', { headers: { 'x-topup-key': 'topup_test_e2e', 'x-topup-timestamp': String(Math.floor(Date.now() / 1000)), 'x-topup-signature': '0'.repeat(64) } }), 401, 'invalid_signature', '开放 API 签名错');
  expectError(await raw('/api/v1/balance/', { withToken: true }), 401, 'invalid_signature', '开放 API 只带测试令牌');
  expectError(await raw('/api/merchant/?a=overview', { withToken: true }), 401, 'unauthorized', '商户后台带测试令牌');
  expectError(await raw('/api/kyb/?g=admin&a=apps', { withToken: true }), 401, '', '开户后台带测试令牌');
});

test('E11 测试管理员能读的列表里，商户名、公司名、邮箱都打码', async () => {
  const w = ok(await admin('withdrawals', { query: { all: '1' } }), 'withdrawals');
  const rows = [...(w.items || []), ...(w.singles || []), ...(w.approved || []), ...(w.groups || [])];
  assert.ok(rows.every((x) => !x.merchant || MASKED.test(x.merchant)), '提币列表、审核页的商户名已打码');
  const ov = ok(await admin('overview'), 'overview');
  assert.ok((ov.top_merchants || []).every((x) => !x.name || MASKED.test(x.name)), '概览的商户排行已打码');
  const seen = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (['merchant', 'email', 'company'].includes(k) && typeof v === 'string' && v && !MASKED.test(v)) seen.push(k);
      else walk(v);
    }
  };
  walk([w, ov, ok(await admin('sweep-list'), 'sweep-list'), ok(await admin('anomalies'), 'anomalies')]);
  assert.ok(!seen.length, `没有没打码的商户名、邮箱、公司名（字段：${[...new Set(seen)].join('、')}）`);
});
