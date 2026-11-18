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

/** 管理员标识：每次（重新）初始化管理员都换一个（128 位随机），存在 topup:admin 的 sid 里 */
export const newAdminSid = () => randomBytes(16).toString('base64url');

/**
 * 会话：base64url(JSON{exp,v,s}) + "." + HMAC。v 是会话版本号，退出登录时递增，旧 Cookie 全部失效；
 * s 是签发时管理员的标识（sid），admin-reset 后重新初始化会换新标识，重置前的 Cookie 因此全部失效（版本号从 1 重来也不会复活）。
 * 升级前初始化的管理员记录没有 sid：只认同样没有 s 的 Cookie（旧规则），退出登录或下次重新初始化时补上标识。
 */
export function makeSession(key, version, now = Date.now(), sid = undefined) {
  const body = Buffer.from(JSON.stringify({ exp: now + SESSION_TTL_MS, v: version, ...(sid ? { s: sid } : {}) })).toString('base64url');
  return `${body}.${hmac(key, body)}`;
}
/** admin 是 topup:admin 的记录（{ version, sid }）；也可以只传版本号（等同于没有 sid 的记录） */
export function readSession(key, cookieHeader, admin, now = Date.now()) {
  const { version, sid } = typeof admin === 'object' && admin ? admin : { version: admin, sid: undefined };
  const m = /(?:^|;\s*)topup_admin=([^;]+)/.exec(cookieHeader || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig || !safeEqual(hmac(key, body), sig)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (s.exp <= now || s.v !== version) return null;
    if ((s.s || '') !== (sid || '')) return null; // 管理员标识对不上：重置前签发的 Cookie
    return s;
  } catch { return null; }
}
export const sessionCookie = (value, maxAgeSec) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
