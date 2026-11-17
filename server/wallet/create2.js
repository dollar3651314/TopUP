// 合约充值地址（ETH / BSC）：盐和 CREATE2 地址的计算，和链上 BitGo ForwarderFactoryV4 部署出的地址一致。
//   盐 = keccak256(前缀 ‖ uint256 大端序号)，前缀 "topup-deposit"
//   finalSalt = keccak256(parent ‖ feeAddress ‖ 盐)（feeAddress 就是批量合约 SweepBatcher）
//   地址 = keccak256(0xff ‖ 工厂 ‖ finalSalt ‖ keccak256(EIP-1167 代理初始化代码))[12:]
// 测试向量：test/fixtures/wallet/（Foundry 用真实工厂逐个部署核对同样两份文件）。
import { keccak_256 } from '@noble/hashes/sha3';

export const SALT_PREFIX = 'topup-deposit';
const PROXY_HEAD = Buffer.from('3d602d80600a3d3981f3363d3d373d3d3d363d73', 'hex');
const PROXY_TAIL = Buffer.from('5af43d82803e903d91602b57fd5bf3', 'hex');
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const SALT_RE = /^0x[0-9a-fA-F]{64}$/;

export const isEvmAddress = (s) => typeof s === 'string' && ADDR_RE.test(s);

function addrBytes(v, field) {
  if (!isEvmAddress(v)) throw new Error(`${field}: not a valid EVM address`);
  return Buffer.from(v.slice(2), 'hex');
}

/** EIP-55 大小写校验格式 */
export function toChecksumAddress(addr) {
  if (!isEvmAddress(addr)) throw new Error('not a valid EVM address');
  const lower = addr.slice(2).toLowerCase();
  const h = Buffer.from(keccak_256(Buffer.from(lower, 'ascii'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** 序号 → 盐（0x + 64 位小写十六进制）。序号必须是正整数（Number 安全整数或 bigint） */
export function depositSalt(seq, prefix = SALT_PREFIX) {
  let n;
  if (typeof seq === 'bigint') n = seq;
  else if (typeof seq === 'number' && Number.isSafeInteger(seq)) n = BigInt(seq);
  else throw new Error('seq must be a positive integer');
  if (n <= 0n || n >= 2n ** 256n) throw new Error('seq must be a positive integer');
  const p = typeof prefix === 'string' ? Buffer.from(prefix, 'utf8') : Buffer.from(prefix);
  const word = Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
  return '0x' + Buffer.from(keccak_256(Buffer.concat([p, word]))).toString('hex');
}

/** 转发地址（EIP-55）。所有输入都检查格式，不对就报错（不默默算出一个错地址） */
export function forwarderAddress({ factory, implementation, parent, feeAddress, salt }) {
  const f = addrBytes(factory, 'factory');
  const impl = addrBytes(implementation, 'implementation');
  const p = addrBytes(parent, 'parent');
  const fee = addrBytes(feeAddress, 'feeAddress');
  if (typeof salt !== 'string' || !SALT_RE.test(salt)) throw new Error('salt: must be 0x + 64 hex characters');
  const finalSalt = keccak_256(Buffer.concat([p, fee, Buffer.from(salt.slice(2), 'hex')]));
  const initHash = keccak_256(Buffer.concat([PROXY_HEAD, impl, PROXY_TAIL]));
  const h = keccak_256(Buffer.concat([Buffer.from([0xff]), f, Buffer.from(finalSalt), Buffer.from(initHash)]));
  return toChecksumAddress('0x' + Buffer.from(h).toString('hex').slice(24));
}
