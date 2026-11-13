// contract 提供方的 TRON 部分（第 2 批）：TRON 派生版 BitGo 转发合约（contracts/src/tron/）。
//   - 地址：盐和 ETH / BSC 相同；CREATE2 前缀 0x41（server/wallet/tron-create2.js），feeAddress = 批量合约 SweepBatcherTron；纯计算，不访问节点
//   - 归集：服务器上的 TRON 发起账户（SWEEP_OPERATOR_KEY_TRON）签一笔 TriggerSmartContract：批量合约.sweep(USDT, 盐[])，钱只能进写死的 parent
//   - 能量：一批只给发起账户租一次（TronSave）；租不到回退烧 TRX（fee_limit 给够）；发起账户 TRX 连烧都不够就不发
//   - 结果：只认批量合约发出的 Swept / SweepFailed 事件（TRON USDT 的 transfer 成功也返回 false，判断在合约里按 parent 余额做，后端不看返回值）
import { hex } from '@scure/base';
import { WalletError } from '../provider.js';
import { forwarderAddress as tronForwarder, isTronAddress, hex20 } from '../tron-create2.js';
import { addressOfPrivateKey, signTxId } from '../../pay/signing.js';
import { encodeSigned, fields } from '../../pay/txcodec.js';
import { keccakHex } from '../evm-tx.js';
import { logAddr, nodeMessage } from '../adapters/tron.js';

const topic = (sig) => keccakHex(Buffer.from(sig)).slice(2);
const SWEPT_TOPIC = topic('Swept(bytes32,address,bool)');
const SWEEP_FAILED_TOPIC = topic('SweepFailed(bytes32,address,bytes)');
export const SWEEP_SIG = 'sweep(address,bytes32[])';
const SWEEP_SELECTOR = topic(SWEEP_SIG).slice(0, 8);
const word = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * 能量预估（推断，Nile 实测后再调；本机私链实测见 contracts/README.md）：
 *   每批固定 base；每个地址：已部署的 flush（USDT 转账 6.4 万～13 万能量 + parent 余额前后两次 balanceOf + 代理转调）、
 *   首次还要加部署转发合约（本机私链 9 万～10 万）。宁多勿少：多给的 fee_limit 不会被扣，少了交易会 OUT_OF_ENERGY 整批失败
 */
export const TRON_SWEEP_ENERGY = Object.freeze({ base: 30_000n, deploy: 120_000n, flush: 140_000n });
/** 实际租 / fee_limit 在预估上再留的余量（%） */
export const ENERGY_MARGIN_PCT = 20n;

export const isConnectionError = (e) => ['rpc_unreachable', 'rpc_http'].includes(e?.code) || e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError;

/** TRON 合约参数检查：都要是 T 开头的合法地址；钱只能进写死的 parent，所以 parent 不能是批量合约、USDT、工厂或实现 */
export function checkTronScheme(scheme, usdt) {
  if (!scheme || typeof scheme !== 'object') throw new Error('tron: scheme missing');
  if (!Number.isInteger(scheme.ver) || scheme.ver <= 0) throw new Error('tron: scheme.ver must be a positive integer');
  for (const k of ['factory', 'implementation', 'parent', 'batcher']) if (!isTronAddress(scheme[k])) throw new Error(`tron: scheme.${k} is not a valid TRON address (T…)`);
  if (!isTronAddress(usdt)) throw new Error('tron: usdt is not a valid TRON address (T…)');
  const p = hex20(scheme.parent);
  if (p === hex20(scheme.batcher)) throw new Error('tron: scheme.parent must not be the batcher contract');
  if (p === hex20(usdt)) throw new Error('tron: scheme.parent must not be the USDT contract');
  if (p === hex20(scheme.factory) || p === hex20(scheme.implementation)) throw new Error('tron: scheme.parent must not be the factory or implementation');
}

/** 发起账户私钥（64 位十六进制，可带 0x）→ { address, priv }；格式不对抛出（不带出私钥） */
export function tronOperatorOf(key) {
  const k = String(key || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('tron operator key must be 64 hex characters');
  const priv = hex.decode(k.toLowerCase());
  return { address: addressOfPrivateKey(priv), priv };
}

export const sweepEnergyStatic = (n, deploy) => TRON_SWEEP_ENERGY.base + BigInt(deploy) * (TRON_SWEEP_ENERGY.deploy + TRON_SWEEP_ENERGY.flush) + BigInt(Math.max(0, n - deploy)) * TRON_SWEEP_ENERGY.flush;
export const encodeSweepParams = (usdt, salts) => word(hex20(usdt)) + word('40') + word(salts.length.toString(16)) + salts.map(word).join('');

/** 解节点建好的交易原文：{ type, owner, contract, data, callValue, feeLimit }（核对用） */
function decodeTrigger(rawHex) {
  const one = (fs, no) => fs.find((f) => f.no === no)?.value;
  const rf = fields(hex.decode(rawHex));
  const cs = rf.filter((f) => f.no === 11);
  if (cs.length !== 1) return null;
  const cf = fields(cs[0].value);
  const p = fields(one(fields(one(cf, 2)), 2));
  const a = (no) => { const v = one(p, no); return v ? hex.encode(v.slice(1)) : null; };
  return { type: Number(one(cf, 1)), owner: a(1), contract: a(2), callValue: Number(one(p, 3) ?? 0), data: hex.encode(one(p, 4) || new Uint8Array()), feeLimit: Number(one(rf, 18) ?? 0) };
}

/**
 * c：() => { adapter, scheme, usdt } | 抛出 chain_not_enabled；operator：{ address, priv } | null；renter：租能量平台（rent、balance）| null
 */
export function createTronOps({ need, operator, renter, log = console }) {
  const addressForSalt = (salt) => {
    const { scheme } = need();
    return tronForwarder({ factory: scheme.factory, implementation: scheme.implementation, parent: scheme.parent, feeAddress: scheme.batcher, salt }).tron;
  };

  async function estimateFee(n = 1, { deploy = n } = {}) {
    const { adapter } = need();
    const { energyFee } = await adapter.chainParams();
    const energy = sweepEnergyStatic(n, deploy);
    return { energy, native: energy * energyFee, energyFee, detail: `${n} address(es), ${deploy} first-time` };
  }

  /**
   * 签名并广播一笔归集交易（出错分段同 ETH / BSC：签名前 stage = prepare；广播时连接出错 uncertain；节点明确拒绝 stage = broadcast）。
   * 返回 { txRefs: [交易号], broadcast?, energy: { mode: 'rented' | 'burn', orderId?, reason?, energy, feeLimit } }
   */
  async function executeSweep(items) {
    const prep = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { stage: 'prepare' });
    let c;
    try { c = need(); } catch (e) { throw prep(e); }
    const { adapter, scheme, usdt } = c;
    if (!operator) throw prep(new WalletError('operator_not_configured', 'TRON sweep operator key (SWEEP_OPERATOR_KEY_TRON) is not configured'));
    if (!items?.length) throw prep(new WalletError('empty_batch', 'nothing to sweep'));
    const salts = items.map((i) => i.salt);
    const parameter = encodeSweepParams(usdt, salts);
    // 1. 能量单价、预估（节点模拟执行和静态表取大的）
    let energyFee, maxFeeLimit, simulated;
    try {
      ({ energyFee, maxFeeLimit } = await adapter.chainParams());
      simulated = await adapter.estimateEnergy({ owner: operator.address, contract: scheme.batcher, selector: SWEEP_SIG, parameter }).catch((e) => { if (isConnectionError(e)) throw e; return null; });
    } catch (e) { throw prep(e); }
    const deploy = items.filter((i) => i.deploy !== false).length;
    const base = sweepEnergyStatic(items.length, deploy);
    const energy = (simulated && simulated > base ? simulated : base) * (100n + ENERGY_MARGIN_PCT) / 100n;
    let feeLimit = energy * energyFee;
    if (maxFeeLimit && feeLimit > maxFeeLimit) feeLimit = maxFeeLimit;
    // 2. 租能量（一批租一次，给发起账户）；租不到回退烧 TRX
    let energyInfo = { mode: 'burn', energy: String(energy), feeLimit: String(feeLimit) };
    if (renter) {
      try {
        const r = await renter.rent({ receiver: operator.address, energy: String(energy) });
        energyInfo = { ...energyInfo, mode: 'rented', orderId: r?.orderId ?? null };
      } catch (e) {
        energyInfo = { ...energyInfo, mode: 'burn', reason: String(e?.code || e?.message || 'rent_failed').slice(0, 80) };
        log.error?.(`[sweep:tron] energy rental failed (${energyInfo.reason}), burning TRX instead`);
      }
    } else energyInfo.reason = null;
    // 3. 烧 TRX 时，发起账户的 TRX 要够烧（fee_limit 是上限，按预估的量算够不够）
    if (energyInfo.mode === 'burn') {
      let trx;
      try { trx = await adapter.nativeBalance(operator.address); } catch (e) { throw prep(e); }
      const needSun = energy * energyFee;
      if (trx < needSun) throw prep(new WalletError('insufficient_trx', `TRON operator has ${trx} sun TRX, needs about ${needSun} sun to burn for energy (rental ${energyInfo.reason || 'not configured'})`));
    }
    // 4. 节点建交易 → 核对（发起地址、只调批量合约的 sweep、调用数据、不带 TRX、fee_limit）→ 签名
    let tx;
    try { tx = await adapter.buildTrigger({ owner: operator.address, contract: scheme.batcher, selector: SWEEP_SIG, parameter, feeLimit }); } catch (e) { throw prep(e); }
    const d = decodeTrigger(tx.raw);
    if (!d || d.type !== 31 || d.owner !== hex20(operator.address) || d.contract !== hex20(scheme.batcher) || d.data !== SWEEP_SELECTOR + parameter || d.callValue !== 0 || BigInt(d.feeLimit) !== feeLimit) {
      throw prep(new WalletError('tx_mismatch', 'node built a transaction that does not match the sweep call'));
    }
    const signed = encodeSigned(tx.raw, signTxId(tx.txID, operator.priv));
    // 5. 广播
    let r;
    try { r = await adapter.broadcastHex(signed); } catch (e) {
      if (isConnectionError(e)) return { txRefs: [tx.txID], broadcast: 'uncertain', energy: energyInfo };
      throw Object.assign(new WalletError('sweep_rejected', `node rejected the sweep transaction: ${String(e?.message || e).slice(0, 200)}`), { stage: 'broadcast' });
    }
    if (!r?.result) {
      if (r?.code === 'DUP_TRANSACTION_ERROR') return { txRefs: [tx.txID], energy: energyInfo }; // 节点已经有这笔
      throw Object.assign(new WalletError('sweep_rejected', `node rejected the sweep transaction: ${r?.code || ''} ${nodeMessage(r?.message).slice(0, 160)}`), { stage: 'broadcast' });
    }
    return { txRefs: [tx.txID], energy: energyInfo };
  }

  /** 归集交易的结果：只认批量合约发出的 Swept / SweepFailed 事件，逐个地址判断 */
  async function sweepOutcome(txRef, items, { sentAt = null, now = Date.now(), droppedAfterMs }) {
    const { adapter, scheme } = need();
    const status = await adapter.txStatus(txRef);
    if (status === 'pending' && sentAt && now - new Date(sentAt).getTime() > droppedAfterMs) {
      const known = await adapter.txKnown(txRef).catch(() => null);
      if (known === false) return { status: 'failed', swept: [], failed: items.map((i) => ({ address: i.address, reason: 'not_broadcast' })) };
    }
    if (status === 'pending' || status === 'unknown') return { status, swept: [], failed: [] };
    if (status === 'failed') return { status, swept: [], failed: items.map((i) => ({ address: i.address, reason: 'tx_reverted' })) };
    const info = await adapter.receipt(txRef);
    const batcher = hex20(scheme.batcher);
    const mine = (info?.log || []).filter((l) => logAddr(l.address) === batcher);
    const saltsOf = (t) => new Set(mine.filter((l) => String(l.topics?.[0] || '').toLowerCase() === t).map((l) => word(l.topics[1])));
    const ok = saltsOf(SWEPT_TOPIC), bad = saltsOf(SWEEP_FAILED_TOPIC);
    const swept = [], failed = [];
    for (const i of items) {
      const s = word(i.salt);
      if (ok.has(s) && !bad.has(s)) swept.push(i.address);
      else failed.push({ address: i.address, reason: bad.has(s) ? 'reverted' : 'no_event' });
    }
    return { status: 'confirmed', swept, failed };
  }

  return { addressForSalt, estimateFee, executeSweep, sweepOutcome };
}
