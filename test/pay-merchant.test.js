// 商户后台接口：开通邮件 → 设置密码和验证码 → 登录 → 页面接口；锁定、动态码防重放、CSRF、CSV 导出
import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createOps } from '../server/pay/ops.js';
import { createMerchantApi, inviteMerchantUser } from '../server/pay/merchant-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { totpCode } from '../server/kyb/totp.js';

const U = 1_000_000;
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');

async function setup() {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const ops = createOps({ db, keys, payBase: 'https://pay.test' });
  const m = await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } });
  const mails = [];
  let t = Date.now();
  const api = createMerchantApi({ db, keys, ops, now: () => t });
  let jar = '';
  const call = async (a, body, { csrf = true, method = body ? 'POST' : 'GET', qs = '' } = {}) => {
    const res = await api(new Request(`https://x.test/api/merchant/?a=${a}${qs}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', cookie: jar, ...(csrf ? { 'x-topup-csrf': '1' } : {}) } }));
    const sc = res.headers.get('set-cookie'); if (sc) jar = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };
  const { link } = await inviteMerchantUser(db, keys, { merchantId: 'm1', email: 'Finance@Acme.example', send: async (x) => mails.push(x), origin: 'https://x.test' });
  return { db, ops, m, api, call, mails, link, tick: (ms) => (t += ms), now: () => t };
}

test('开通邮件 → 设置密码 → 绑定验证码 → 登录；设置链接只能用一次', async () => {
  const s = await setup();
  assert.equal(s.mails.length, 1);
  const token = new URL(s.link).searchParams.get('setup');
  assert.equal((await s.call('setup-begin', { token, password: 'short' })).body.error.code, 'weak_password');
  const b = (await s.call('setup-begin', { token, password: 'correct horse battery' })).body;
  assert.match(b.qr, /^data:image\/png;base64,/);
  assert.equal((await s.call('setup-confirm', { token, code: totpCode(b.secret, s.now()) })).status, 200);
  assert.equal((await s.call('setup-begin', { token, password: 'correct horse battery' })).body.error.code, 'invalid_setup_link');
  s.tick(31_000);
  const login = await s.call('login', { email: 'finance@acme.example', password: 'correct horse battery', code: totpCode(b.secret, s.now()) });
  assert.equal(login.status, 200);
  const me = (await s.call('me')).body;
  assert.equal(me.authed, true);
  assert.equal(me.merchant.name, 'Acme');
  // 同一个动态码不能再用一次（例如用来提币）
  const w = await s.call('withdraw', { kind: 'payout', to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: '1', code: totpCode(b.secret, s.now()) });
  assert.equal(w.body.error.code, 'bad_code');
  // 退出后旧的 Cookie 失效
  await s.call('logout', {});
  assert.equal((await s.call('overview')).status, 401);
});

test('连续输错 5 次锁定；没有 CSRF 请求头的 POST 被拒绝；未登录返回 401', async () => {
  const s = await setup();
  const token = new URL(s.link).searchParams.get('setup');
  const b = (await s.call('setup-begin', { token, password: 'correct horse battery' })).body;
  await s.call('setup-confirm', { token, code: totpCode(b.secret, s.now()) });
  for (let i = 0; i < 5; i++) await s.call('login', { email: 'finance@acme.example', password: 'wrong password!!', code: '000000' });
  s.tick(31_000);
  assert.equal((await s.call('login', { email: 'finance@acme.example', password: 'correct horse battery', code: totpCode(b.secret, s.now()) })).body.error.code, 'locked');
  assert.equal((await s.call('login', {}, { csrf: false })).status, 403);
  assert.equal((await s.call('customers')).status, 401);
});

test('登录后：客户、订单、手动匹配、导出 CSV', async () => {
  const s = await setup();
  const token = new URL(s.link).searchParams.get('setup');
  const b = (await s.call('setup-begin', { token, password: 'correct horse battery' })).body;
  await s.call('setup-confirm', { token, code: totpCode(b.secret, s.now()) });
  s.tick(31_000);
  await s.call('login', { email: 'finance@acme.example', password: 'correct horse battery', code: totpCode(b.secret, s.now()) });
  const c = (await s.call('customer-save', { customer_id: '-cmd', name: 'Evil' })).body; // 防 CSV 公式注入
  await core.recordDeposit(s.db, { txid: 'd'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 40 * U, time: new Date(Date.now() - 30 * 3600_000) });
  const o = (await s.call('order-create', { customer_id: '-cmd', merchant_order_no: 'M-1', amount: '40' })).body;
  assert.equal(o.status, 'pending'); // 超出 24 小时回看
  const detail = (await s.call('order', null, { qs: `&order_no=${o.order_no}` })).body;
  assert.equal(detail.unmatched.length, 1);
  const done = (await s.call('match', { order_no: o.order_no, deposit_id: detail.unmatched[0].id })).body;
  assert.equal(done.status, 'completed');
  const cu = (await s.call('customer', null, { qs: '&customer_id=-cmd&days=0' })).body;
  assert.equal(cu.stats.total, '40.00');
  const file = await s.call('export', null, { qs: '&type=deposits' });
  assert.equal(file.status, 200);
  assert.match(file.body, /'-cmd/);
  const ov = (await s.call('overview')).body;
  assert.equal(ov.available, '39.60');
});
