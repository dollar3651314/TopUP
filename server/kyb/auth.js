// 后台认证：密码（scrypt 哈希）+ TOTP；签名会话 Cookie；连续失败 5 次锁定 15 分钟。
import { scryptSync, randomBytes } from 'node:crypto';
import { hmac, safeEqual } from './crypto.js';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const LOCK_MAX = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const COOKIE = 'topup_admin';

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, salt, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const got = scryptSync(String(pw), Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 });
  return safeEqual(got.toString('base64url'), h);
}

/** 会话：base64url(JSON{exp,v}) + "." + HMAC。v 是会话版本号，退出登录时递增，旧 Cookie 全部失效 */
export function makeSession(key, version, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ exp: now + SESSION_TTL_MS, v: version })).toString('base64url');
  return `${body}.${hmac(key, body)}`;
}
export function readSession(key, cookieHeader, version, now = Date.now()) {
  const m = /(?:^|;\s*)topup_admin=([^;]+)/.exec(cookieHeader || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig || !safeEqual(hmac(key, body), sig)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (s.exp <= now || s.v !== version) return null;
    return s;
  } catch { return null; }
}
export const sessionCookie = (value, maxAgeSec) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
