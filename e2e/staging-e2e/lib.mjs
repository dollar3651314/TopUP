// 测试环境验收用例（e2e/staging-e2e/）共用的小工具：只用 Node 自带的 fetch，不需要 npm 安装。
//   - 地址、令牌只从环境变量来（STAGING_URL、STAGING_TEST_ADMIN_TOKEN，GitHub 环境 staging-e2e 的密钥），不写在用例里
//   - 这里的函数不打印、不返回请求头；出错信息只有动作名、HTTP 状态和接口返回的错误码，不含地址和令牌
//   - 用测试管理员调用运营后台接口：admin('payout-limits')、admin('payout-approve', { body: { ids: [...] } })
//     要动态码的动作（改上限）照样传 code 字段（随便填，例如 '000000'），服务器对测试管理员免核对
//   - 测试商户的开放 API（可选，造打款单用）：merchant('POST', 'payouts/', body)；要 GitHub 环境里另有
//     STAGING_E2E_MERCHANT_KEY、STAGING_E2E_MERCHANT_SECRET（管理员在测试环境的商户后台生成后自己填），没有时 hasMerchant = false
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const BASE = String(process.env.STAGING_URL || '').replace(/\/+$/, '');
const TOKEN = String(process.env.STAGING_TEST_ADMIN_TOKEN || '').trim();
const HEADER = 'x-topup-test-admin';

if (!BASE || !TOKEN) throw new Error('需要环境变量 STAGING_URL 和 STAGING_TEST_ADMIN_TOKEN（GitHub 环境 staging-e2e 的密钥）');

/** 地址里只留路径（报错时用，不带测试环境的域名） */
const pathOf = (p) => String(p).replace(/^https?:\/\/[^/]+/, '');

async function req(path, { method = 'GET', body, headers = {}, token = TOKEN, raw: noCsrf = false } = {}) {
  const h = { ...headers };
  if (token) h[HEADER] = token;
  if (method !== 'GET') { h['content-type'] = 'application/json'; if (!noCsrf) h['x-topup-csrf'] = '1'; }
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`${method} ${pathOf(path)}：连不上（${e?.name || 'error'}）`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, text: json ? '' : text.slice(0, 200) };
}

/**
 * 用测试管理员调用运营后台接口 /api/wallet/?a=<动作>。有 body 就是 POST。
 * 返回 { status, body }；不抛错（要 200 用 ok()）
 */
export function admin(action, { body, query = {}, token } = {}) {
  const qs = new URLSearchParams({ a: action, ...query }).toString();
  return req(`/api/wallet/?${qs}`, { method: body === undefined ? 'GET' : 'POST', body, token });
}

/** 不带令牌（或带指定的令牌）请求任意接口：req('/api/health/') */
export const raw = (path, opts = {}) => req(path, { token: '', ...opts });

/** 断言 200 并返回 body；不是 200 时报出动作名、状态和错误码 */
export function ok(r, what = '') {
  assert.equal(r.status, 200, `${what} 返回 ${r.status}：${JSON.stringify(r.body?.error || r.body || r.text)}`);
  return r.body;
}

/** 断言是某个错误：expectError(r, 403, 'test_admin_forbidden') */
export function expectError(r, status, code, what = '') {
  assert.equal(r.status, status, `${what} 期望 ${status}，实际 ${r.status}：${JSON.stringify(r.body?.error || r.body || r.text)}`);
  if (code) assert.equal(r.body?.error?.code, code, `${what} 错误码`);
}

const MKEY = String(process.env.STAGING_E2E_MERCHANT_KEY || '').trim();
const MSECRET = String(process.env.STAGING_E2E_MERCHANT_SECRET || '').trim();
/** 配了测试商户的 API Key 才能用 merchant()；用例里没有时 test(..., { skip: !hasMerchant && '没有测试商户的 API Key' }) */
export const hasMerchant = Boolean(MKEY && MSECRET);

/**
 * 测试商户调开放 API：merchant('GET', 'balance/')、merchant('POST', 'payouts/', { ... })。
 * 签名规则和开发者文档一样（时间戳、方法、路径和查询、请求体的 SHA-256）；POST 自动带一个新的 Idempotency-Key（重试同一笔时自己传 idem）
 */
export async function merchant(method, path, body, { idem } = {}) {
  if (!hasMerchant) throw new Error('没有测试商户的 API Key（STAGING_E2E_MERCHANT_KEY、STAGING_E2E_MERCHANT_SECRET）');
  const p = `/api/v1/${String(path).replace(/^\/+/, '')}`;
  const text = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', MSECRET).update([ts, method, p, createHash('sha256').update(text).digest('hex')].join('\n')).digest('hex');
  const headers = { 'x-topup-key': MKEY, 'x-topup-timestamp': ts, 'x-topup-signature': sig };
  if (method !== 'GET') headers['idempotency-key'] = idem || `e2e-${randomUUID()}`;
  return req(p, { method, body: body === undefined ? undefined : body, headers, token: '', raw: true });
}

