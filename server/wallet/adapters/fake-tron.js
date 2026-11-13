// TRON 节点的本地替身（合约钱包第 2 批）：接口和 adapters/tron.js 的读的部分相同，数据放在内存里。只用于本地开发和自动化测试（APP_ENV=local）。
// 本地 /__fake/evm/pay/（chain = tron）可以"模拟一笔链上转账"。本地不能真的归集（没有链）：建交易时报"本地替身不支持"，批次退回待确认。
import { randomBytes } from 'node:crypto';
import { fromUnits, toUnits } from '../units.js';
import { hex20, tronOf } from '../tron-create2.js';

export function createFakeTronAdapter({ usdt, confirmations = 0 }) {
  let block = 1000;
  const list = [];
  const balances = new Map(); // 20 字节十六进制 → 原始数
  const notLocal = async () => { throw Object.assign(new Error('fake tron: not supported locally'), { code: 'not_supported' }); };
  return {
    chain: 'tron', usdt, decimals: 6, confirmations, fake: true,
    /** 模拟一笔已确认的 USDT 转账；amount 是 0.000001 USDT 单位 */
    pay({ to, amount, from = tronOf('00'.repeat(19) + '01'), time = Date.now() }) {
      const raw = fromUnits(BigInt(amount), 6);
      const e = { txid: randomBytes(32).toString('hex'), block: ++block, time, from: tronOf(hex20(from)), to: tronOf(hex20(to)), raw };
      list.push(e);
      balances.set(hex20(to), (balances.get(hex20(to)) || 0n) + raw);
      return { chain: 'tron', txid: e.txid, block: e.block, to: e.to, amount: String(amount) };
    },
    async head() { return block + confirmations; },
    async transfers({ cursor, addresses = [] }) {
      const start = cursor === null || cursor === undefined || cursor === '' ? 0 : Number(cursor);
      const want = new Set(addresses.map(hex20));
      const deposits = list.filter((e) => e.block > start && want.has(hex20(e.to)))
        .map((e) => ({ chain: 'tron', txid: e.txid, logIndex: 0, block: e.block, time: e.time, from: e.from, to: e.to, amount: Number(toUnits(e.raw, 6)), rawAmount: e.raw.toString() }));
      return { deposits, next: String(block) };
    },
    async tokenBalanceRaw(address) { return balances.get(hex20(address)) || 0n; },
    async nativeBalance() { return 0n; },
    async isContract() { return false; },
    async txStatus() { return 'pending'; },
    async confirmationsOf() { return 0; },
    async receipt() { return null; },
    async txKnown() { return false; },
    async chainParams() { return { energyFee: 100n, maxFeeLimit: 15_000_000_000n }; },
    async estimateEnergy() { return null; },
    buildTrigger: notLocal,
    broadcastHex: notLocal,
    constantCall: notLocal,
  };
}
