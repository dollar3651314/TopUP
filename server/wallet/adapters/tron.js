// 钱包接口层第二层 ChainAdapter（TRON，只给 contract 提供方用，形状和 adapters/evm.js 一致）：直接问 TRON 全节点的 HTTP 接口（java-tron /wallet/*，
// TronGrid、Nile、本机私链都是同样的路径）。
//   - transfers：按区块读交易回执（/wallet/gettransactioninfobyblocknum），从日志里找 USDT 合约的 Transfer 事件、只要转到我们地址的；
//     只读到"最新区块 − 确认数"；第一次（没有游标）从当前已确认区块开始、不回扫；一次最多读 maxRange 个区块；
//     区间里任何一个块读不到（连不上、HTTP 出错含 429、返回 Error、超时）整段作废、直接抛出，游标不动
//   - txStatus：连不上 unknown（不等于失败）；没回执 pending；确认数不够 pending；够了 SUCCESS → confirmed，否则 failed
//   - 地址对外一律 T 开头；金额 0.000001 USDT 单位（TRON USDT 6 位小数）
// 每个请求都有超时（timeoutMs，默认 10 秒）；错误信息不含节点地址（可能带 API Key）。
import { toUnits } from '../units.js';
import { isTronAddress, hex20, tronOf } from '../tron-create2.js';
import { txIdOf } from '../../pay/txcodec.js';
import { keccakHex } from '../evm-tx.js';

export const TRANSFER_TOPIC = keccakHex(Buffer.from('Transfer(address,address,uint256)')).slice(2);
const BLOCK_CONCURRENCY = 4; // 读回执时同时最多几个请求（TronGrid 有频率限制）
const word = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hex41 = (a) => '41' + hex20(a);
/** 日志里的合约地址：一般是 20 字节十六进制（不带 41），个别节点带 41 */
export const logAddr = (a) => { const s = String(a || '').toLowerCase(); return s.length === 42 && s.startsWith('41') ? s.slice(2) : s.padStart(40, '0'); };

export class TronNodeError extends Error {
  constructor(message, { code = 'rpc_error', nodeCode } = {}) { super(message); this.code = code; this.nodeCode = nodeCode; }
}

/** 节点返回的 message 多半是十六进制编码的文字：能解就解 */
export function nodeMessage(m) {
  const s = String(m ?? '');
  if (/^([0-9a-f]{2})+$/i.test(s)) { try { return Buffer.from(s, 'hex').toString('utf8'); } catch { return s; } }
  return s;
}

/**
 * base：节点地址（例如 https://api.trongrid.io、http://127.0.0.1:9090）；usdt：T 开头的 USDT 合约地址；
 * confirmations：确认数（默认 19，TRON 固化块）；maxRange：一次最多读多少个区块；apiKey：TronGrid 的 API Key（放请求头）
 */
export function createTronAdapter({ base, fetchImpl = fetch, usdt, confirmations = 19, maxRange = 100, timeoutMs = 10_000, apiKey = '' }) {
  if (!isTronAddress(usdt)) throw new Error('tron adapter: usdt must be a T-address');
  if (!base) throw new Error('tron adapter: node url missing');
  const usdtHex = hex20(usdt);
  const root = String(base).replace(/\/+$/, '');

  async function post(path, body = {}) {
    let res;
    try {
      res = await fetchImpl(root + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TronNodeError(`tron: node unreachable (${e?.cause?.code || e?.name || 'network'}) ${path}`, { code: 'rpc_unreachable' });
    }
    if (!res.ok) throw new TronNodeError(`tron: HTTP ${res.status} ${path}`, { code: 'rpc_http' });
    let j;
    try { j = await res.json(); } catch { throw new TronNodeError(`tron: invalid JSON ${path}`, { code: 'rpc_http' }); }
    if (j && !Array.isArray(j) && typeof j === 'object' && j.Error) throw new TronNodeError(`tron: ${path}: ${String(j.Error).slice(0, 200)}`);
    return j;
  }

  const head = async () => {
    const b = await post('/wallet/getnowblock');
    const n = b?.block_header?.raw_data?.number;
    if (!Number.isSafeInteger(n)) throw new TronNodeError('tron: getnowblock: unexpected response');
    return n;
  };

  async function blockInfos(n) {
    const r = await post('/wallet/gettransactioninfobyblocknum', { num: n });
    if (Array.isArray(r)) return r;
    if (r && typeof r === 'object' && !Object.keys(r).length) return []; // 空块：有的节点返回 {}
    throw new TronNodeError(`tron: block ${n}: unexpected response`);
  }

  async function transfers({ cursor, addresses = [] }) {
    const safe = (await head()) - confirmations;
    const start = cursor === null || cursor === undefined || cursor === '' ? safe : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('tron: bad cursor');
    const from = start + 1;
    const to = Math.min(safe, start + maxRange);
    if (to < from) return { deposits: [], next: String(start) };
    const wanted = new Set(addresses.map((a) => { try { return hex20(a); } catch { return null; } }).filter(Boolean));
    const nums = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const infos = new Array(nums.length);
    let next = 0;
    // 同时最多 BLOCK_CONCURRENCY 个请求；任何一个失败整段作废（Promise.all 抛出）
    await Promise.all(Array.from({ length: Math.min(BLOCK_CONCURRENCY, nums.length) }, async () => {
      while (next < nums.length) { const i = next++; infos[i] = await blockInfos(nums[i]); }
    }));
    const deposits = [];
    for (const [bi, list] of infos.entries()) {
      for (const info of list) {
        if (info?.receipt?.result !== 'SUCCESS' || info.result === 'FAILED') continue; // 失败的交易：日志不算
        for (const [logIndex, l] of (info.log || []).entries()) {
          if (logAddr(l.address) !== usdtHex) continue;
          const t = l.topics || [];
          if (t.length !== 3 || String(t[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
          const toHex = String(t[2]).slice(-40).toLowerCase();
          if (!wanted.has(toHex)) continue;
          const raw = BigInt('0x' + (l.data || '0'));
          const units = toUnits(raw, 6);
          deposits.push({
            chain: 'tron', txid: info.id, logIndex, block: Number(info.blockNumber ?? nums[bi]), time: Number(info.blockTimeStamp),
            from: tronOf(String(t[1]).slice(-40)), to: tronOf(toHex),
            amount: units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : units, rawAmount: raw.toString(),
          });
        }
      }
    }
    deposits.sort((a, b) => a.block - b.block || (a.txid === b.txid ? a.logIndex - b.logIndex : 0));
    return { deposits, next: String(to) };
  }

  /** 交易信息（回执、日志、区块号）；还没上链返回 null */
  async function receipt(txid) {
    const i = await post('/wallet/gettransactioninfobyid', { value: txid });
    return i && i.id ? i : null;
  }
  const failedInfo = (i) => i.result === 'FAILED' || (i.receipt?.result && i.receipt.result !== 'SUCCESS');

  async function txStatus(txid) {
    try {
      const i = await receipt(txid);
      if (!i) return 'pending';
      if ((await head()) - Number(i.blockNumber) < confirmations) return 'pending';
      return failedInfo(i) ? 'failed' : 'confirmed';
    } catch { return 'unknown'; }
  }

  /** 已经有几个确认（上链那个区块算 1 个）；还没上链 0；连不上 null */
  async function confirmationsOf(txid) {
    try {
      const i = await receipt(txid);
      return i ? Math.max(0, (await head()) - Number(i.blockNumber) + 1) : 0;
    } catch { return null; }
  }

  /** 只读调用：返回节点原样结果（{ result: { result, code, message }, constant_result, energy_used }）；连不上、HTTP 出错抛出 */
  async function constantCall(contract, selector, parameter = '', owner = contract) {
    return post('/wallet/triggerconstantcontract', { owner_address: hex41(owner), contract_address: hex41(contract), function_selector: selector, parameter, visible: false });
  }
  /** 只读调用，结果必须成功：返回第一个返回值（64 位十六进制，可能是空字符串） */
  async function callWord(contract, selector, parameter = '', owner) {
    const r = await constantCall(contract, selector, parameter, owner);
    if (!r?.result?.result) throw new TronNodeError(`tron: ${selector}: ${r?.result?.code || 'error'} ${nodeMessage(r?.result?.message).slice(0, 160)}`, { nodeCode: r?.result?.code });
    return String(r.constant_result?.[0] ?? '');
  }

  return {
    chain: 'tron', usdt, decimals: 6, confirmations,
    post, head, transfers, receipt, txStatus, confirmationsOf, constantCall, callWord,
    /** USDT 余额（原始数，bigint）：走合约 balanceOf，没激活的地址也能查到 */
    async tokenBalanceRaw(address, token = usdt) {
      const w = await callWord(token, 'balanceOf(address)', word(hex20(address)), address);
      if (!/^[0-9a-f]{1,64}$/i.test(w)) throw new TronNodeError('tron: balanceOf: empty result');
      return BigInt('0x' + w);
    },
    /** TRX 余额（sun，bigint）；没激活的地址为 0 */
    async nativeBalance(address) { const a = await post('/wallet/getaccount', { address: hex41(address) }); return BigInt(a?.balance ?? 0); },
    async isContract(address) { const c = await post('/wallet/getcontract', { value: hex41(address) }); return Boolean(c && (c.bytecode || c.contract_address)); },
    /** 节点认不认识这笔交易（已上链或在交易池）；连不上时抛出 */
    async txKnown(txid) { const t = await post('/wallet/gettransactionbyid', { value: txid }); return Boolean(t && t.txID); },
    /** 链参数：能量单价（sun / 能量）、fee_limit 上限（sun） */
    async chainParams() {
      const r = await post('/wallet/getchainparameters');
      const m = Object.fromEntries((r?.chainParameter || []).map((p) => [p.key, Number(p.value ?? 0)]));
      if (!m.getEnergyFee) throw new TronNodeError('tron: getchainparameters: no getEnergyFee');
      return { energyFee: BigInt(m.getEnergyFee), maxFeeLimit: m.getMaxFeeLimit ? BigInt(m.getMaxFeeLimit) : null };
    },
    /** 账户的能量（质押 + 别人代理给它的，减去已用）；连不上抛出 */
    async energyAvailable(address) {
      const r = await post('/wallet/getaccountresource', { address: hex41(address) });
      return BigInt(Math.max(0, Number(r?.EnergyLimit ?? 0) - Number(r?.EnergyUsed ?? 0)));
    },
    /** 预估一次合约调用要多少能量（只读模拟执行）；模拟失败返回 null */
    async estimateEnergy({ owner, contract, selector, parameter }) {
      const r = await constantCall(contract, selector, parameter, owner);
      if (!r?.result?.result) return null;
      const e = Number(r.energy_used ?? 0);
      return e > 0 ? BigInt(e) : null;
    },
    /** 让节点建一笔 TriggerSmartContract 交易（未签名）：返回 { txID, raw_data_hex }，核对 txID = sha256(原文) */
    async buildTrigger({ owner, contract, selector, parameter, feeLimit, callValue = 0 }) {
      const r = await post('/wallet/triggersmartcontract', {
        owner_address: hex41(owner), contract_address: hex41(contract), function_selector: selector, parameter, fee_limit: Number(feeLimit), call_value: callValue, visible: false,
      });
      const tx = r?.transaction;
      if (!r?.result?.result || !tx?.raw_data_hex || !tx.txID) throw new TronNodeError(`tron: triggersmartcontract: ${r?.result?.code || 'no transaction'} ${nodeMessage(r?.result?.message).slice(0, 160)}`, { nodeCode: r?.result?.code });
      if (txIdOf(tx.raw_data_hex) !== tx.txID) throw new TronNodeError('tron: txID does not match raw_data_hex');
      return { txID: tx.txID, raw: tx.raw_data_hex };
    },
    /** 广播已签名的交易（十六进制）：{ result, code, message } 原样返回；连不上抛出（code rpc_unreachable） */
    async broadcastHex(signedHex) { return post('/wallet/broadcasthex', { transaction: signedHex }); },
  };
}
