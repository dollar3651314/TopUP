// ETH / BSC 节点的本地替身：接口和 adapters/evm.js 相同，数据放在内存里。只用于本地开发和端到端测试（APP_ENV=local）。
// 本地服务器另提供 /__fake/evm/pay/，端到端测试用它"模拟一笔链上转账"。归集交易会被解码：每个盐对应的地址余额转给 parent。
// 第 3 批批量打款：替身也执行 USDT 的 approve（以太坊按 USDT 的规则：非 0 改非 0 回滚）和 BatchPayout.pay（从签名人的额度 transferFrom，
// 一笔不行整笔回滚、回执 status 0x0）；/__fake/evm/block/ 让替身拒收某个收款人（模拟 USDT 黑名单）。签名人由签名算出，不信任何说明。
import { randomBytes } from 'node:crypto';
import { keccakHex, selector } from '../evm-tx.js';
import { toChecksumAddress } from '../create2.js';
import { toUnits, fromUnits } from '../units.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { rlpEncode, decodePayCall, decodeApproveCall, selectorOf, PAY_SIGNATURE, APPROVE_SIGNATURE } from '../evm-payout-codec.js';

const PAY_SEL = selectorOf(PAY_SIGNATURE);
const APPROVE_SEL = selectorOf(APPROVE_SIGNATURE);
/** 已签名旧式交易的签名人（EIP-155） */
function senderOf(f) {
  const v = BigInt('0x' + (f[6].toString('hex') || '0'));
  const chainId = (v - 35n) / 2n, rec = Number((v - 35n) % 2n);
  const cid = chainId.toString(16);
  const unsigned = rlpEncode([...f.slice(0, 6).map((x) => new Uint8Array(x)), new Uint8Array(Buffer.from(cid.length % 2 ? '0' + cid : cid, 'hex')), new Uint8Array(0), new Uint8Array(0)]);
  const r = BigInt('0x' + f[7].toString('hex')), s = BigInt('0x' + f[8].toString('hex'));
  const pub = new secp256k1.Signature(r, s).addRecoveryBit(rec).recoverPublicKey(keccak_256(unsigned)).toRawBytes(false);
  return '0x' + Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString('hex');
}

const SWEPT = keccakHex(Buffer.from('Swept(bytes32,address,bool)'));
const SWEEP_SEL = selector('sweep(address,bytes32[])');

/** RLP 解码（只解替身收到的交易用） */
function rlpDecode(buf) {
  const one = (b, i) => {
    const p = b[i];
    if (p < 0x80) return [b.subarray(i, i + 1), i + 1];
    if (p < 0xb8) return [b.subarray(i + 1, i + 1 + p - 0x80), i + 1 + p - 0x80];
    if (p < 0xc0) { const l = p - 0xb7; const n = Number(BigInt('0x' + b.subarray(i + 1, i + 1 + l).toString('hex'))); return [b.subarray(i + 1 + l, i + 1 + l + n), i + 1 + l + n]; }
    let start, end;
    if (p < 0xf8) { start = i + 1; end = start + p - 0xc0; } else { const l = p - 0xf7; start = i + 1 + l; end = start + Number(BigInt('0x' + b.subarray(i + 1, i + 1 + l).toString('hex'))); }
    const out = []; let j = start;
    while (j < end) { const [x, k] = one(b, j); out.push(x); j = k; }
    return [out, end];
  };
  return one(buf, 0)[0];
}

export function createFakeEvm({ chain, usdt, decimals, confirmations = 0, parent }) {
  let block = 1000;
  const transfersList = [];
  const balances = new Map(); // 小写地址 → 原始数
  const code = new Set();
  const txs = new Map();
  const allowances = new Map(); // owner|spender（小写）→ 原始数
  const blocked = new Set();
  let resolveSalt = null;
  const id = () => '0x' + randomBytes(32).toString('hex');
  const key = (a) => a.toLowerCase();
  return {
    chain, usdt, decimals, confirmations, fake: true,
    /** 归集时盐 → 地址（由 contract 提供方告诉替身） */
    bindSaltResolver(fn) { resolveSalt = fn; },
    /** 模拟一笔已确认的 USDT 转账；amount 是 0.000001 USDT 单位 */
    pay({ to, amount, from = '0x000000000000000000000000000000000000dEaD', time = Date.now() }) {
      const raw = fromUnits(BigInt(amount), decimals);
      const e = { chain, txid: id(), logIndex: 0, block: ++block, time, from: toChecksumAddress(from), to: toChecksumAddress(to), raw };
      transfersList.push(e);
      balances.set(key(to), (balances.get(key(to)) || 0n) + raw);
      return { chain, txid: e.txid, block: e.block, to: e.to, amount: String(amount) };
    },
    async head() { return block + confirmations; },
    async transfers({ cursor, addresses = [] }) {
      const start = cursor === null || cursor === undefined || cursor === '' ? 0 : Number(cursor);
      const want = new Set(addresses.map(key));
      const deposits = transfersList.filter((e) => e.block > start && e.block <= block && want.has(key(e.to)))
        .map((e) => { const u = toUnits(e.raw, decimals); return { chain, txid: e.txid, logIndex: e.logIndex, block: e.block, time: e.time, from: e.from, to: e.to, amount: Number(u), rawAmount: e.raw.toString() }; });
      return { deposits, next: String(block) };
    },
    async tokenBalanceRaw(address) { return balances.get(key(address)) || 0n; },
    async allowanceRaw(owner, spender) { return allowances.get(`${key(owner)}|${key(spender)}`) || 0n; },
    /** 让替身拒收某个收款人（模拟 USDT 黑名单）：之后付给它的整笔回滚 */
    block(address, on = true) { if (on) blocked.add(key(address)); else blocked.delete(key(address)); return { ok: true }; },
    async nativeBalance() { return 10n ** 18n; },
    async isContract(address) { return code.has(key(address)); },
    async chainId() { return 31337n; },
    async gasPrice() { return 1_000_000_000n; },
    async nonce() { return BigInt(txs.size); },
    async estimateGas() { throw new Error('fake: no estimate'); },
    async sendRaw(raw) {
      const hash = keccakHex(Buffer.from(raw.slice(2), 'hex'));
      const f = rlpDecode(Buffer.from(raw.slice(2), 'hex'));
      const to = '0x' + f[3].toString('hex');
      const data = f[5].toString('hex');
      const logs = [];
      let status = '0x1';
      if (data.startsWith(APPROVE_SEL) && key(to) === key(usdt)) {
        const from = senderOf(f);
        const { spender, amount } = decodeApproveCall('0x' + data);
        const k = `${key(from)}|${key(spender)}`;
        const cur = allowances.get(k) || 0n;
        if (chain === 'eth' && cur !== 0n && amount !== 0n) status = '0x0'; // 以太坊 USDT：先归零再设
        else allowances.set(k, amount);
      } else if (data.startsWith(PAY_SEL)) {
        const from = key(senderOf(f));
        const call = decodePayCall('0x' + data);
        const sum = call.items.reduce((s, i) => s + i.amount, 0n);
        const k = `${from}|${key(to)}`;
        const ok = key(call.token) === key(usdt) && (allowances.get(k) || 0n) >= sum && (balances.get(from) || 0n) >= sum && !call.items.some((i) => blocked.has(key(i.to)));
        if (!ok) status = '0x0';
        else {
          allowances.set(k, allowances.get(k) - sum);
          for (const i of call.items) {
            balances.set(from, balances.get(from) - i.amount);
            balances.set(key(i.to), (balances.get(key(i.to)) || 0n) + i.amount);
          }
        }
      }
      if (data.startsWith(SWEEP_SEL)) {
        const n = Number(BigInt('0x' + data.slice(8 + 128, 8 + 192)));
        for (let i = 0; i < n; i++) {
          const salt = '0x' + data.slice(8 + 192 + i * 64, 8 + 256 + i * 64);
          const addr = resolveSalt ? resolveSalt(salt) : null;
          if (!addr) continue;
          const bal = balances.get(key(addr)) || 0n;
          balances.set(key(addr), 0n);
          if (parent) balances.set(key(parent), (balances.get(key(parent)) || 0n) + bal);
          const deployed = !code.has(key(addr));
          code.add(key(addr));
          logs.push({ address: to, topics: [SWEPT, salt, '0x' + addr.slice(2).toLowerCase().padStart(64, '0')], data: '0x' + (deployed ? '1' : '0').padStart(64, '0') });
        }
      }
      txs.set(hash, { status, blockNumber: '0x' + (++block).toString(16), logs: status === '0x1' ? logs : [] });
      return hash;
    },
    async receipt(hash) { const t = txs.get(hash); return t ? { transactionHash: hash, ...t } : null; },
    async txStatus(hash) { const t = txs.get(hash); return !t ? 'pending' : t.status === '0x1' ? 'confirmed' : 'failed'; },
    async confirmationsOf(hash) { const t = txs.get(hash); return t ? block - Number(BigInt(t.blockNumber)) + 1 : 0; },
    async txKnown(hash) { return txs.has(hash); },
  };
}
