// 商户后台接口：/api/merchant/?a=<动作>（页面 /merchant/）。
// 登录：邮箱 + 密码（scrypt）+ 验证器动态码；8 小时会话 Cookie；连续输错 5 次锁定 15 分钟；同一个动态码不能用两次。
// 所有 POST 请求要带 x-topup-csrf 请求头（页面自动带），Cookie 设为 SameSite=Strict，防止别的网站冒用登录状态。
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { json, readJson } from '../kyb/http.js';
import { hashPassword, verifyPassword } from '../kyb/auth.js';
import { encryptJson, decryptJson, hmac, safeEqual, hashToken } from '../kyb/crypto.js';
import { newTotpSecret, totpStep, otpauthUrl } from '../kyb/totp.js';
import { PayError } from './core.js';
import { money, errorResponse, iso, amt } from './common.js';
import { resend } from './callbacks.js';
import * as core from './core.js';

export const M_COOKIE = 'topup_merchant';
const SESSION_MS = 8 * 60 * 60 * 1000;
const SETUP_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_MAX = 5, LOCK_MS = 15 * 60 * 1000;
const cookie = (v, maxAge) => `${M_COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

/** 开通商户时调用：建一个登录账号，并发送设置密码的邮件 */
export async function inviteMerchantUser(db, keys, { merchantId, email, send, origin, lang = 'zh' }) {
  const token = randomBytes(32).toString('base64url');
  await db.query(`insert into merchant_users (merchant_id, email, setup_hash, setup_expires) values ($1, lower($2), $3, $4)
    on conflict (email) do update set setup_hash = excluded.setup_hash, setup_expires = excluded.setup_expires where merchant_users.merchant_id = excluded.merchant_id`,
    [merchantId, email, hashToken(keys.token, token), new Date(Date.now() + SETUP_MS)]);
  const link = `${origin}${lang === 'en' ? '' : '/zh'}/merchant/?setup=${token}`;
  if (send) await send({ to: email, subject: 'TopUP 商户后台：请设置登录密码 / Set up your merchant account', text:
    `您好，\n\n您的 TopUP 商户账户已开通。请在 7 天内打开下面的链接，设置登录密码并绑定手机验证器：\n${link}\n\nYour TopUP merchant account is ready. Open the link above within 7 days to set a password and an authenticator app.\n\nTopUP` });
  return { link };
}

const csvCell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows, cols) => '﻿' + [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => csvCell(c[1](r))).join(','))].join('\r\n');

export function createMerchantApi({ db, keys, ops, send, now = () => Date.now() }) {
  const makeSession = (u) => { const body = Buffer.from(JSON.stringify({ u: u.id, v: u.session_version, exp: now() + SESSION_MS })).toString('base64url'); return `${body}.${hmac(keys.session, body)}`; };
  async function sessionUser(request) {
    const m = new RegExp(`(?:^|;\\s*)${M_COOKIE}=([^;]+)`).exec(request.headers.get('cookie') || '');
    if (!m) return null;
    const [body, sig] = m[1].split('.');
    if (!body || !sig || !safeEqual(hmac(keys.session, body), sig)) return null;
    let s; try { s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!s || s.exp <= now()) return null;
    const [u] = await db.query('select * from merchant_users where id = $1', [s.u]);
    if (!u || u.session_version !== s.v || u.setup_hash) return null;
    const merchant = await core.getMerchant(db, u.merchant_id);
    if (!merchant || merchant.status !== 'active') return null;
    return { user: u, merchant };
  }
  /** 验证动态码，并记录用过的时间步（同一个码不能用两次） */
  async function checkCode(u, code) {
    const step = totpStep(decryptJson(keys.enc, u.totp_enc), code, now());
    if (step < 0 || step <= Number(u.last_totp_step)) return false;
    await db.query('update merchant_users set last_totp_step = $2 where id = $1', [u.id, step]);
    return true;
  }
  const setupUser = async (token) => {
    const [u] = await db.query('select * from merchant_users where setup_hash = $1 and setup_expires > $2', [hashToken(keys.token, String(token || '')), new Date(now())]);
    if (!u) throw new PayError('invalid_setup_link', 400);
    return u;
  };

  // 不需要登录的动作
  const open = {
    async me(request) {
      const s = await sessionUser(request);
      if (!s) return { authed: false };
      const m = s.merchant;
      return { authed: true, email: s.user.email, merchant: { id: m.id, name: m.name, order_mode: m.order_mode, fee_in: m.fee_in, fee_out: m.fee_out, cashout_wallets: m.cashout_wallets } };
    },
    async 'setup-begin'(request, b) {
      const u = await setupUser(b.token);
      if (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 200) throw new PayError('weak_password', 400);
      const secret = newTotpSecret();
      await db.query('update merchant_users set pw_hash = $2, totp_enc = $3 where id = $1', [u.id, hashPassword(b.password), encryptJson(keys.enc, secret)]);
      const url = otpauthUrl(secret, `TopUP:${u.email}`);
      return { otpauth: url, secret, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
    },
    async 'setup-confirm'(request, b) {
      const u = await setupUser(b.token);
      if (!u.pw_hash || !u.totp_enc || !(await checkCode(u, b.code))) throw new PayError('bad_code', 400);
      await db.query('update merchant_users set setup_hash = null, setup_expires = null, fail_count = 0 where id = $1', [u.id]);
      await core.audit(db, `merchant:${u.merchant_id}`, 'user.setup', u.email);
      return { ok: true };
    },
    async login(request, b) {
      const [u] = await db.query('select * from merchant_users where email = lower($1)', [String(b.email || '').trim()]);
      if (u?.locked_until && new Date(u.locked_until).getTime() > now()) throw new PayError('locked', 429);
      const ok = u && !u.setup_hash && u.pw_hash && typeof b.password === 'string' && verifyPassword(b.password, u.pw_hash) && (await checkCode(u, b.code));
      if (!ok) {
        // 连续输错 5 次锁定 15 分钟；锁定期满后重新计数
        if (u) await db.query(`update merchant_users set fail_count = case when fail_count + 1 >= $2 then 0 else fail_count + 1 end,
          locked_until = case when fail_count + 1 >= $2 then $3::timestamptz else locked_until end where id = $1`, [u.id, LOCK_MAX, new Date(now() + LOCK_MS)]);
        throw new PayError('bad_credentials', 401);
      }
      await db.query('update merchant_users set fail_count = 0, locked_until = null where id = $1', [u.id]);
      const [fresh] = await db.query('select * from merchant_users where id = $1', [u.id]);
      return { ok: true, __cookie: cookie(makeSession(fresh), SESSION_MS / 1000) };
    },
  };

  // 需要登录的动作：m 是当前商户
  const authed = {
    async logout(m, b, s) { await db.query('update merchant_users set session_version = session_version + 1 where id = $1', [s.user.id]); return { ok: true, __cookie: cookie('', 0) }; },
    async overview(m) {
      const bal = await ops.balance(m);
      const [t] = await db.query(`select coalesce(sum(amount), 0)::bigint total, count(*)::int n, coalesce(sum(fee), 0)::bigint fees from deposits
        where merchant_id = $1 and result = 'credited' and time >= (date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai')`, [m.id]); // 今日 = 东八区的自然日（F9）
      const [o] = await db.query(`select count(*)::int n from orders where merchant_id = $1 and status in ('pending', 'partial')`, [m.id]);
      const [u] = await db.query(`select coalesce(sum(amount), 0)::bigint total, count(*)::int n from deposits where merchant_id = $1 and result = 'credited' and order_id is null`, [m.id]);
      const [w] = await db.query(`select count(*)::int n from withdrawals where merchant_id = $1 and status = 'pending'`, [m.id]);
      return { ...bal, today: t.total, today_count: t.n, today_fees: t.fees, open_orders: o.n, unmatched: u.total, unmatched_count: u.n, pending_withdrawals: w.n, recent: (await ops.deposits(m, { limit: 6 })).items };
    },
    customers: (m, b, s, q) => ops.listCustomers(m, { q: q.get('q') || '', cursor: q.get('cursor'), limit: 50 }),
    async customer(m, b, s, q) {
      const id = q.get('customer_id') || '';
      const days = Number(q.get('days') || 30);
      const from = days > 0 ? new Date(now() - days * 864e5).toISOString() : null;
      return { customer: await ops.getCustomer(m, id), stats: await ops.customerStats(m, id, { from }),
        orders: (await ops.listOrders(m, { customerId: id, limit: 50 })).items, deposits: (await ops.deposits(m, { customerId: id, limit: 50 })).items,
        payouts: (await db.query(`select id, amount, status, created_at from withdrawals where merchant_id = $1 and customer_id = $2 order by created_at desc limit 50`, [m.id, id])).map((w) => ({ withdrawal_no: w.id, amount: w.amount, status: w.status, created_at: iso(w.created_at) })) };
    },
    'customer-save': (m, b) => ops.upsertCustomer(m, b),
    orders: (m, b, s, q) => ops.listOrders(m, { status: q.get('status') || '', customerId: q.get('customer_id') || '', cursor: q.get('cursor'), limit: 50 }),
    async order(m, b, s, q) {
      const o = await ops.getOrder(m, { orderNo: q.get('order_no') });
      const free = (await ops.deposits(m, { customerId: o.customer_id, matched: 'false', limit: 50 })).items;
      return { order: o, unmatched: free };
    },
    'order-create': (m, b) => ops.createOrder(m, b),
    match: (m, b, s) => ops.match(m, b, `merchant:${s.user.email}`, true),
    unmatch: (m, b, s) => ops.match(m, b, `merchant:${s.user.email}`, false),
    deposits: (m, b, s, q) => ops.deposits(m, { cursor: q.get('cursor'), limit: 100, customerId: q.get('customer_id') || '', matched: q.get('matched') || '' }),
    ledger: (m, b, s, q) => ops.ledger(m, { cursor: q.get('cursor'), limit: 100, customerId: q.get('customer_id') || '' }),
    async withdraw(m, b, s) {
      if (!(await checkCode(s.user, b.code))) throw new PayError('bad_code', 400);
      return ops.withdraw(m, b, 'web');
    },
    withdrawals: (m, b, s, q) => ops.listWithdrawals(m, { cursor: q.get('cursor'), limit: 50 }),
    'withdraw-cancel': (m, b) => ops.cancelWithdrawal(m, b.withdrawal_no),
    api: (m) => ({ api_key: m.api_key, has_secret: !!m.api_secret_enc, callback_url: m.callback_url, ip_whitelist: m.ip_whitelist, order_mode: m.order_mode }),
    async 'api-regen'(m, b, s) {
      if (!(await checkCode(s.user, b.code))) throw new PayError('bad_code', 400);
      return ops.regenerateSecret(m);
    },
    'callback-save': (m, b) => ops.setCallback(m, b.callback_url),
    'ip-save': (m, b) => ops.setIpWhitelist(m, b.ip_whitelist),
    async 'callback-test'(m) {
      const id = await core.enqueueCallback(db, m.id, 'test', { message: 'This is a test callback from TopUP.' });
      return { id };
    },
    callbacks: (m, b, s, q) => ops.callbacks(m, { cursor: q.get('cursor'), limit: 50 }),
    async 'callback-resend'(m, b) { if (!(await resend(db, m.id, String(b.id || '')))) throw new PayError('not_found', 404); return { ok: true }; },
  };

  // CSV 导出（GET，直接下载）
  async function exportCsv(m, q) {
    const kind = q.get('type');
    const customerId = q.get('customer_id') || '';
    if (kind === 'deposits' || kind === 'customer') {
      const rows = await db.query(`select * from deposits where merchant_id = $1 and result = 'credited' and ($2 = '' or customer_id = $2) order by id desc limit 20000`, [m.id, customerId]); // 低于 1 USDT 的不给商户看
      return csv(rows, [['time', (r) => iso(r.time)], ['customer_id', (r) => r.customer_id], ['address', (r) => r.address], ['txid', (r) => r.txid], ['amount', (r) => amt(r.amount)], ['fee', (r) => amt(r.fee)],
        ['credited', (r) => (r.result === 'credited' ? amt(r.amount - r.fee) : '0.00')], ['result', (r) => r.result], ['order_no', (r) => r.order_id || ''], ['matched_by', (r) => r.match_type || '']]);
    }
    if (kind === 'ledger') {
      const rows = await db.query(`select * from ledger where merchant_id = $1 and ($2 = '' or customer_id = $2) order by id desc limit 20000`, [m.id, customerId]);
      return csv(rows, [['time', (r) => iso(r.created_at)], ['type', (r) => r.type], ['amount', (r) => amt(r.amount)], ['available_after', (r) => amt(r.available_after)], ['frozen_after', (r) => amt(r.frozen_after)], ['ref', (r) => r.ref], ['customer_id', (r) => r.customer_id || '']]);
    }
    throw new PayError('invalid_param', 422, 'type');
  }

  const handle = async function handle(request) {
    try {
      const url = new URL(request.url);
      const a = url.searchParams.get('a') || '';
      const isPost = request.method === 'POST';
      if (isPost && request.headers.get('x-topup-csrf') !== '1') return json(403, { error: { code: 'csrf', message: 'Missing CSRF header' } });
      const b = isPost ? await readJson(request, 32 * 1024) : {};
      let out;
      if (open[a]) out = await open[a](request, b);
      else {
        const s = await sessionUser(request);
        if (!s) return json(401, { error: { code: 'unauthorized', message: 'Please sign in' } });
        if (a === 'export' && !isPost) {
          const body = await exportCsv(s.merchant, url.searchParams);
          return new Response(body, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="topup-${url.searchParams.get('type')}-${new Date().toISOString().slice(0, 10)}.csv"` } });
        }
        if (!authed[a]) return json(404, { error: { code: 'not_found', message: 'Unknown action' } });
        out = await authed[a](s.merchant, b, s, url.searchParams);
      }
      const { __cookie, ...rest } = out || {};
      return json(200, money(rest), __cookie ? { 'set-cookie': __cookie } : {});
    } catch (e) {
      if (e?.status && ['unsupported_media_type', 'too_large', 'invalid_json'].includes(e.message)) return json(e.status, { error: { code: e.message } });
      if (e instanceof PayError && ['bad_credentials', 'locked', 'bad_code', 'weak_password', 'invalid_setup_link'].includes(e.code)) return json(e.status, { error: { code: e.code } });
      return errorResponse(e);
    }
  };
  handle.actions = [...Object.keys(open), ...Object.keys(authed), 'export']; // 项目索引的测试用：检查每个动作都写进了《项目索引》
  return handle;
}
