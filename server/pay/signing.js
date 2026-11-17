// 签名和验签（浏览器和服务器共用）。签名格式：r(32) + s(32) + 恢复位(1，取值 0 或 1)，
// 和 TRON 主网上的真实交易一致（测试里用主网的真实交易验证过）。
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hex } from '@scure/base';
import { toAddress } from './txcodec.js';

export function addressOfPublicKey(pub) {
  const raw = pub.length === 65 ? pub : secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false);
  const h = keccak_256(raw.slice(1));
  const b = new Uint8Array(21); b[0] = 0x41; b.set(h.slice(-20), 1);
  return toAddress(b);
}
export const addressOfPrivateKey = (priv) => addressOfPublicKey(secp256k1.getPublicKey(priv, false));

/** 签名交易哈希（txID），返回 130 位十六进制 */
export function signTxId(txIdHex, priv) {
  const s = secp256k1.sign(hex.decode(txIdHex), priv, { lowS: true });
  return hex.encode(s.toCompactRawBytes()) + s.recovery.toString(16).padStart(2, '0');
}
/** 从签名恢复出签名人的地址；签名格式不对时返回 null */
export function signerOf(txIdHex, sigHex) {
  try {
    if (!/^[0-9a-f]{130}$/i.test(sigHex)) return null;
    const v = parseInt(sigHex.slice(128), 16);
    const rec = v >= 27 ? v - 27 : v;
    if (rec !== 0 && rec !== 1) return null;
    const pub = secp256k1.Signature.fromCompact(sigHex.slice(0, 128)).addRecoveryBit(rec).recoverPublicKey(hex.decode(txIdHex)).toRawBytes(false);
    return addressOfPublicKey(pub);
  } catch { return null; }
}

/**
 * 从"私钥或助记词"里取出某个地址的私钥（浏览器里用：签名框的热钱包一栏两种都可以填）。
 * - 64 位十六进制：直接当私钥，核对地址。
 * - 12/24 个单词：按 TRON 的推导路径找这个地址。TronLink 同一个钱包里的多个账户可能在 m/44'/195'/0'/0/i 或 m/44'/195'/i'/0/0，
 *   两种都试前 20 个。
 * 返回 { key } 或 { error: 'format' | 'mnemonic' | 'mismatch' | 'not_found' }
 */
export async function keyForAddress(input, address) {
  const v = String(input || '').trim();
  const hexStr = v.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hexStr)) {
    const key = hex.decode(hexStr.toLowerCase());
    return addressOfPrivateKey(key) === address ? { key } : { error: 'mismatch' };
  }
  const words = v.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 12 && words.length !== 24) return { error: 'format' };
  const [{ mnemonicToSeedSync, validateMnemonic }, { wordlist }, { HDKey }] = await Promise.all([import('@scure/bip39'), import('@scure/bip39/wordlists/english'), import('@scure/bip32')]);
  const phrase = words.join(' ');
  if (!validateMnemonic(phrase, wordlist)) return { error: 'mnemonic' };
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase));
  for (let i = 0; i < 20; i++) {
    for (const path of [`m/44'/195'/0'/0/${i}`, `m/44'/195'/${i}'/0/0`]) {
      const key = root.derive(path).privateKey;
      if (key && addressOfPrivateKey(key) === address) return { key };
    }
  }
  return { error: 'not_found' };
}
