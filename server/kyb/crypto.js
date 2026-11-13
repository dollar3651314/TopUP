// 加密工具：所有密钥都由一个主密钥 APP_SECRET 通过 HKDF 派生。
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync, createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function deriveKeys(appSecret) {
  if (!appSecret || appSecret.length < 32) throw new Error('APP_SECRET missing or too short (need 32+ chars)');
  const k = (info) => Buffer.from(hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.from('topup-kyb-v1'), Buffer.from(info), 32));
  return { enc: k('enc'), session: k('session'), token: k('token') };
}

/** AES-256-GCM 加密任意 JSON 值，返回紧凑的字符串 v1.<iv>.<tag>.<密文>（base64url） */
export function encryptJson(key, value) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function decryptJson(key, packed) {
  const [v, iv, tag, ct] = String(packed).split('.');
  if (v !== 'v1') throw new Error('unknown ciphertext version');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
}

/** 客户链接令牌：32 字节随机数（256 位）。数据库里只保存它的 HMAC，拿到数据库也还原不出链接 */
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (key, token) => createHmac('sha256', key).update(String(token)).digest('base64url');

export function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest('base64url');
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
