// TronGrid 的本地替身：接口和 trongrid.js 相同，数据放在内存里。只用于本地开发和自动化测试。
// 本地服务器还提供 /__fake/tron/* 地址，端到端测试用它"模拟一笔链上转账"。
import { randomBytes } from 'node:crypto';
import { encodeRaw, txIdOf, decodeRaw } from './txcodec.js';
import { signerOf } from './signing.js';

export function createFakeTron({ network = 'nile', contract = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', pageSize = 200 } = {}) {
  const events = [];
  const txs = new Map(); // txid → { ok }
  const accounts = new Map(); // address → { activated, trx, trc20 }
  let block = 1_000_000;
  const broadcasts = [];
  const tx = () => randomBytes(32).toString('hex');
  return {
    network, contract, events, txs, accounts,
    /** 测试用：模拟一笔已确认的 USDT 转账 */
    pay({ to, amount, from = 'TMa7yK2d9Qp4XvB8sN1cF6rH3wZ5jL0eUt', time = Date.now(), txid = tx(), logIndex = 0 }) {
      const e = { txid, logIndex, block: ++block, time, from, to, amount };
      events.push(e); events.sort((a, b) => a.time - b.time);
      return e;
    },
    async transfers({ minTs, maxTs, fingerprint }) {
      const all = events.filter((e) => e.time >= minTs && e.time <= maxTs);
      const start = fingerprint ? Number(fingerprint) : 0;
      const page = all.slice(start, start + pageSize);
      return { events: page, next: start + pageSize < all.length ? String(start + pageSize) : null };
    },
    // 替身里的转账一到就算已确认：已确认区块的时间放在未来一点，扫描不会因为"还没确认"而等待
    async solidBlock() { return { number: block, time: Date.now() + 60_000 }; },
    async txInfo(txid) { const t = txs.get(txid); return t ? { ok: t.ok, fee: 0, energy: 65_000, block } : null; },
    async account(address) { return accounts.get(address) || { activated: false, trx: 0, trc20: {} }; },
    async resources() { return { energyLimit: 820_000, energyUsed: 400_000, totalEnergyLimit: 180_000_000_000, totalEnergyWeight: 19_000_000_000 }; },
    async canDelegate() { return 30_000 * 1_000_000; },
    async chainParams() { return [{ key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1000 }]; },
    async buildUsdtTransfer(p) { return fakeTx({ type: 'TriggerSmartContract', owner: p.from, to: p.to, amount: p.amount, contract }, p.feeLimit || 50_000_000); },
    async buildTrxTransfer(p) { return fakeTx({ type: 'TransferContract', owner: p.from, to: p.to, amount: p.amount }); },
    async buildDelegate(p) { return fakeTx({ type: p.undelegate ? 'UnDelegateResourceContract' : 'DelegateResourceContract', owner: p.from, to: p.to, amount: p.amount }); },
    /** 广播：检查签名人是否是付款地址（和真实节点一样），交易先记为"待确认" */
    async broadcastHex(txHex) {
      const { raw, sig } = splitSigned(txHex);
      const d = decodeRaw(raw);
      if (signerOf(d.txId, sig) !== d.contracts[0].owner) throw Object.assign(new Error('broadcast_failed SIGERROR'), { code: 'SIGERROR' });
      if (d.expiration < Date.now()) throw Object.assign(new Error('broadcast_failed TRANSACTION_EXPIRATION_ERROR'), { code: 'TRANSACTION_EXPIRATION_ERROR' });
      broadcasts.push(d);
      return d.txId;
    },
    broadcasts,
    /** 测试用：让一笔已广播的交易"确认" */
    confirm(txid, ok = true) { txs.set(txid, { ok }); },
  };
}
function fakeTx(c, feeLimit = 0) {
  const raw_data_hex = encodeRaw(c, { feeLimit });
  return { txID: txIdOf(raw_data_hex), raw_data_hex, raw_data: { contract: [{ type: c.type }] } };
}
/** 已签名的完整交易 → { raw, sig }（和 txcodec.encodeSigned 相反） */
function splitSigned(h) {
  const b = Buffer.from(h, 'hex');
  let i = 1, len = 0, shift = 0;
  for (;;) { const c = b[i++]; len |= (c & 0x7f) << shift; if (!(c & 0x80)) break; shift += 7; }
  const raw = b.subarray(i, i + len).toString('hex');
  i += len + 1;
  const sl = b[i++];
  return { raw, sig: b.subarray(i, i + sl).toString('hex') };
}
