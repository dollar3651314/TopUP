// TOTP（RFC 6238）：30 秒一个 6 位动态码，与 Google Authenticator、1Password 等验证器 App 兼容。
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpCode(secret, timeMs = Date.now(), step = 30) {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
/** 允许前后各 1 个时间窗（±30 秒）的误差 */
export function verifyTotp(secret, code, timeMs = Date.now()) {
  return totpStep(secret, code, timeMs) >= 0;
}

/** 返回动态码对应的时间步（允许前后各一个 30 秒窗口）；不匹配返回 -1。用于防止同一个码被重复使用。 */
export function totpStep(secret, code, timeMs = Date.now()) {
  if (!/^[0-9]{6}$/.test(String(code))) return -1;
  for (const w of [-1, 0, 1]) {
    const t = timeMs + w * 30_000;
    if (totpCode(secret, t) === String(code)) return Math.floor(t / 30_000);
  }
  return -1;
}
export const otpauthUrl = (secret, label = 'TopUP Admin') =>
  `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent('TopUP')}&algorithm=SHA1&digits=6&period=30`;
