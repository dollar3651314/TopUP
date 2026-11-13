// 以太坊 / BSC 交易的编码和签名（只给归集发起账户用）：RLP、ABI 的最小实现，旧式交易 + EIP-155 链 ID 防重放。
// 以太坊和 BSC 都接受旧式交易；不引入大型依赖（ethers 等），只用已有的 @noble 库。
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { toChecksumAddress } from './create2.js';

const hexToBytes = (h) => { const s = String(h).replace(/^0x/, ''); return Buffer.from(s.length % 2 ? '0' + s : s, 'hex'); };
export const keccakHex = (b) => '0x' + Buffer.from(keccak_256(b)).toString('hex');

/** 无符号整数 → 最短大端字节（0 是空字节串） */
function intBytes(v) {
  const n = BigInt(v);
  if (n < 0n) throw new Error('rlp: negative integer');
  if (n === 0n) return Buffer.alloc(0);
  return hexToBytes(n.toString(16));
}

/** RLP 编码：Buffer（字节串）或数组（列表） */
export function rlp(item) {
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlp));
    return Buffer.concat([lenPrefix(body.length, 0xc0), body]);
  }
  const b = Buffer.from(item);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([lenPrefix(b.length, 0x80), b]);
}
function lenPrefix(len, base) {
  if (len < 56) return Buffer.from([base + len]);
  const l = intBytes(len);
  return Buffer.concat([Buffer.from([base + 55 + l.length]), l]);
}

/** 函数选择器：keccak256("name(types)") 的前 4 字节 */
export const selector = (sig) => Buffer.from(keccak_256(Buffer.from(sig))).subarray(0, 4).toString('hex');
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');

/** balanceOf(address) 的调用数据 */
export const encodeBalanceOf = (addr) => '0x' + selector('balanceOf(address)') + word(addr);

/** SweepBatcher.sweep(address token, bytes32[] salts) 的调用数据 */
export function encodeSweep(token, salts) {
  return '0x' + selector('sweep(address,bytes32[])') + word(token) + uintWord(64) + uintWord(salts.length) + salts.map(word).join('');
}

/** 私钥（0x + 64 位十六进制）→ 地址（EIP-55） */
export function addressOfKey(key) {
  const k = parseKey(key);
  const pub = secp256k1.getPublicKey(k, false).subarray(1);
  return toChecksumAddress('0x' + Buffer.from(keccak_256(pub)).subarray(12).toString('hex'));
}
function parseKey(key) {
  if (typeof key !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error('operator key: must be 32 bytes hex');
  return Buffer.from(key.replace(/^0x/, ''), 'hex');
}

/**
 * 签名一笔旧式交易（EIP-155）。tx：{ nonce, gasPrice, gas, to, value = 0, data, chainId }，数字可以是 Number / bigint / 0x 字符串。
 * 返回 { raw, hash }（都是 0x 十六进制）
 */
export function signLegacyTx(tx, key) {
  const k = parseKey(key);
  const chainId = BigInt(tx.chainId);
  const fields = [intBytes(tx.nonce), intBytes(tx.gasPrice), intBytes(tx.gas), hexToBytes(tx.to), intBytes(tx.value || 0), hexToBytes(tx.data || '0x')];
  const sighash = keccak_256(rlp([...fields, intBytes(chainId), Buffer.alloc(0), Buffer.alloc(0)]));
  const sig = secp256k1.sign(sighash, k, { lowS: true });
  const v = chainId * 2n + 35n + BigInt(sig.recovery);
  const raw = rlp([...fields, intBytes(v), intBytes(sig.r), intBytes(sig.s)]);
  return { raw: '0x' + raw.toString('hex'), hash: keccakHex(raw) };
}
