// TRON 的 CREATE2 地址（离线计算，不联网）。服务器（server/wallet/）和 Nile 验证脚本（scripts/tron-nile/tron-create2.mjs 转出）共用这一份。
// java-tron 的算法：地址 = keccak256(部署合约的 21 字节地址（0x41 开头）‖ 盐 ‖ keccak256(初始化代码))[12:]，前面再加 0x41。
// 和以太坊的唯一区别是第一个字节：以太坊是 0xff + 20 字节地址，TRON 是 0x41 + 20 字节地址。
// 转发地址（BitGo ForwarderFactoryV4）：finalSalt = keccak256(parent ‖ feeAddress ‖ 盐)（都是 20 字节），初始化代码是指向实现合约的 EIP-1167 代理。
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { createBase58check, hex } from '@scure/base';

const b58c = createBase58check(sha256);
const PROXY_HEAD = '3d602d80600a3d3981f3363d3d373d3d3d363d73';
const PROXY_TAIL = '5af43d82803e903d91602b57fd5bf3';

/** T 开头的地址、41 开头的 42 位十六进制、0x + 40 位十六进制 → 20 字节 */
export function addr20(a) {
  const s = String(a);
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) {
    const b = b58c.decode(s);
    if (b.length !== 21 || b[0] !== 0x41) throw new Error(`not a TRON address: ${s}`);
    return b.slice(1);
  }
  const h = s.toLowerCase().replace(/^0x/, '');
  if (/^41[0-9a-f]{40}$/.test(h)) return hex.decode(h.slice(2));
  if (/^[0-9a-f]{40}$/.test(h)) return hex.decode(h);
  throw new Error(`bad address: ${s}`);
}
/** 20 字节 → T 开头的地址 */
export const toBase58 = (b20) => b58c.encode(Uint8Array.from([0x41, ...b20]));
/** 20 字节 → 41 开头的十六进制 */
export const toHex41 = (b20) => '41' + hex.encode(b20);

function bytes32(v, field) {
  const h = String(v).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${field}: must be 32 bytes hex`);
  return hex.decode(h);
}
const cat = (...xs) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of xs) { out.set(x, i); i += x.length; }
  return out;
};

/** 通用 CREATE2：prefix 0x41（TRON）或 0xff（以太坊）。返回 20 字节 */
export function create2(prefix, deployer, salt, initCodeHash) {
  if (prefix !== 0x41 && prefix !== 0xff) throw new Error('prefix must be 0x41 or 0xff');
  const h = keccak_256(cat(Uint8Array.of(prefix), addr20(deployer), bytes32(salt, 'salt'), bytes32(initCodeHash, 'initCodeHash')));
  return h.slice(12);
}

/** EIP-1167 代理初始化代码的哈希（指向实现合约） */
export const proxyInitCodeHash = (implementation) =>
  hex.encode(keccak_256(cat(hex.decode(PROXY_HEAD), addr20(implementation), hex.decode(PROXY_TAIL))));

/** BitGo 工厂的 finalSalt = keccak256(parent ‖ feeAddress ‖ 盐) */
export const finalSalt = (parent, feeAddress, salt) =>
  hex.encode(keccak_256(cat(addr20(parent), addr20(feeAddress), bytes32(salt, 'salt'))));

/**
 * 转发地址：{ tron（T 开头，按 0x41 算）, hex41, evmStyle（按 0xff 算，只做对照）}
 * factory、implementation、parent、feeAddress 可以是 T 开头的地址或十六进制。
 */
export function forwarderAddress({ factory, implementation, parent, feeAddress, salt }) {
  const fs = finalSalt(parent, feeAddress, salt);
  const ih = proxyInitCodeHash(implementation);
  const t = create2(0x41, factory, fs, ih);
  const e = create2(0xff, factory, fs, ih);
  return { tron: toBase58(t), hex41: toHex41(t), evmStyle: toBase58(e) };
}

/** 是不是合法的 T 开头 TRON 地址（含校验和） */
export function isTronAddress(s) {
  if (typeof s !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return false;
  try { addr20(s); return true; } catch { return false; }
}
/** 任意格式 → 20 字节小写十六进制（比较地址用） */
export const hex20 = (a) => hex.encode(addr20(a));
/** 20 字节十六进制（或 41 开头）→ T 开头 */
export const tronOf = (h) => toBase58(addr20(h));
