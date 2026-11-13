// TRON 地址工具（服务器端）：从公钥（xpub）推导收款地址、地址格式转换和校验。
// 推导路径 m/44'/195'/0'/0/序号（BIP44，195 是 TRON 的编号）。服务器只有账户级公钥 m/44'/195'/0'，
// 只能推导地址，无法得到任何私钥。
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { createBase58check, hex } from '@scure/base';

const b58c = createBase58check(sha256);
export const ACCOUNT_PATH = "m/44'/195'/0'";

/** 未压缩公钥（65 字节）或压缩公钥（33 字节）→ TRON 地址（T 开头） */
export function addressFromPublicKey(pub) {
  const raw = pub.length === 65 ? pub : secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false);
  const h = keccak_256(raw.slice(1));
  const bytes = new Uint8Array(21);
  bytes[0] = 0x41;
  bytes.set(h.slice(-20), 1);
  return b58c.encode(bytes);
}

/** 按序号推导地址：xpub 是账户级公钥（m/44'/195'/0'） */
export function deriveAddress(xpub, index) {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) throw new Error('bad_index');
  const child = HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index);
  return addressFromPublicKey(child.publicKey);
}

/** 检查 xpub 的格式，并确认它是公钥而不是私钥（误把 xprv 交给服务器时直接拒绝） */
export function checkXpub(xpub) {
  const k = HDKey.fromExtendedKey(String(xpub).trim());
  if (k.privateKey) throw new Error('private_key_not_allowed');
  if (k.depth !== 3) throw new Error('wrong_depth');
  return k.publicExtendedKey;
}

/** 地址校验（包括 Base58 校验和） */
export function isValidAddress(a) {
  try { const b = b58c.decode(String(a)); return b.length === 21 && b[0] === 0x41; } catch { return false; }
}
/** 41 开头的 21 字节十六进制，或者合约事件里的 0x + 20 字节 → T 开头的地址 */
export function hexToAddress(h) {
  let s = String(h).toLowerCase().replace(/^0x/, '');
  if (s.length === 40) s = '41' + s;
  if (s.length !== 42 || !s.startsWith('41')) throw new Error('bad_hex_address');
  return b58c.encode(hex.decode(s));
}
export const addressToHex = (a) => hex.encode(b58c.decode(a));
