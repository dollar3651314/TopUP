// 钱包接口层第二层 ChainAdapter（只给 contract 提供方用）：以太坊、BSC 的 JSON-RPC 读写。
//   - transfers：扫 USDT 的 Transfer 事件，只读到"最新区块 − 确认数"，按 to 主题过滤我们的地址
//   - txStatus：连不上 / 出错 → unknown（不等于失败）；没回执 → pending；确认数不够 → pending；够了 → confirmed；回滚 → failed
// 每个请求都有超时（默认 10 秒）；出错直接抛出，不返回空结果、不推进游标，由 worker 下一轮重试。
import { toUnits } from '../units.js';
import { toChecksumAddress, isEvmAddress } from '../create2.js';
import { encodeBalanceOf, encodeAllowance, keccakHex } from '../evm-tx.js';

export const TRANSFER_TOPIC = keccakHex(Buffer.from('Transfer(address,address,uint256)'));
const TOPIC_GROUP = 100; // 地址多时分组查，每组 100 个
const hex = (n) => '0x' + BigInt(n).toString(16);
const num = (h) => Number(BigInt(h));
const topicOf = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const addrOfTopic = (t) => toChecksumAddress('0x' + t.slice(-40));

export class RpcError extends Error {
  constructor(message, { code = 'rpc_error', rpcCode, data } = {}) { super(message); this.code = code; this.rpcCode = rpcCode; if (data !== undefined) this.data = data; }
}

/** 最小的 JSON-RPC 客户端：单个或批量请求，超时，HTTP / JSON-RPC 错误都抛出 RpcError（错误信息不含节点地址，节点地址里可能有 API Key） */
export function createRpc({ rpcUrl, fetchImpl = fetch, timeoutMs = 10_000, label = 'rpc' }) {
  let id = 0;
  async function post(body) {
    let res;
    try {
      res = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new RpcError(`${label}: node unreachable (${e?.cause?.code || e?.name || 'network'})`, { code: 'rpc_unreachable' });
    }
    if (!res.ok) throw new RpcError(`${label}: HTTP ${res.status}`, { code: 'rpc_http' });
    try { return await res.json(); } catch { throw new RpcError(`${label}: invalid JSON`, { code: 'rpc_http' }); }
  }
  const unwrap = (r, method) => {
    if (!r || typeof r !== 'object') throw new RpcError(`${label}: ${method}: empty response`);
    // data：合约回滚时节点带回的回滚数据（自定义错误的选择器 + 参数），批量打款用它找出是哪一笔
    if (r.error) throw new RpcError(`${label}: ${method}: ${r.error.message || 'error'}`, { rpcCode: r.error.code, data: typeof r.error.data === 'string' ? r.error.data : r.error.data?.data });
    return r.result;
  };
  return {
    async call(method, params = []) {
      return unwrap(await post({ jsonrpc: '2.0', id: ++id, method, params }), method);
    },
    /** 批量：[[method, params], ...] → 结果数组（顺序一致） */
    async batch(calls) {
      if (!calls.length) return [];
      const base = id;
      const out = await post(calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: base + i + 1, method, params })));
      id += calls.length;
      if (!Array.isArray(out)) throw new RpcError(`${label}: batch: unexpected response`);
      const byId = new Map(out.map((r) => [r.id, r]));
      return calls.map(([method], i) => unwrap(byId.get(base + i + 1), method));
    },
  };
}

/**
 * chain：eth / bsc；usdt：USDT 合约地址；decimals：USDT 的小数位数（ETH 6、BSC 18）；
 * confirmations：确认数；maxRange：一次最多读多少个区块（节点对 eth_getLogs 的范围有限制）
 */
export function createEvmAdapter({ chain, rpcUrl, fetchImpl = fetch, usdt, decimals, confirmations = 12, maxRange = 1000, timeoutMs = 10_000 }) {
  if (!['eth', 'bsc'].includes(chain)) throw new Error(`evm adapter: unsupported chain ${chain}`);
  if (!isEvmAddress(usdt)) throw new Error('evm adapter: usdt is not a valid address');
  const rpc = createRpc({ rpcUrl, fetchImpl, timeoutMs, label: chain });
  const head = async () => num(await rpc.call('eth_blockNumber'));

  async function transfers({ cursor, addresses = [] }) {
    const safe = (await head()) - confirmations;
    // 第一次（没有游标）：从当前已确认区块开始，不回扫历史
    const start = cursor === null || cursor === undefined || cursor === '' ? safe : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error(`${chain}: bad cursor`);
    const from = start + 1;
    const to = Math.min(safe, start + maxRange);
    if (to < from) return { deposits: [], next: String(start) };
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const logs = [];
    for (let i = 0; i < wanted.length; i += TOPIC_GROUP) {
      const group = wanted.slice(i, i + TOPIC_GROUP).map(topicOf);
      const part = await rpc.call('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: usdt, topics: [TRANSFER_TOPIC, null, group] }]);
      if (!Array.isArray(part)) throw new RpcError(`${chain}: eth_getLogs: unexpected response`);
      logs.push(...part);
    }
    const mine = logs.filter((l) => !l.removed && l.address?.toLowerCase() === usdt.toLowerCase() && l.topics?.length === 3 && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC
      && wanted.includes(('0x' + l.topics[2].slice(-40)).toLowerCase()));
    const blocks = [...new Set(mine.map((l) => num(l.blockNumber)))];
    const infos = await rpc.batch(blocks.map((b) => ['eth_getBlockByNumber', [hex(b), false]]));
    const times = new Map(blocks.map((b, i) => {
      if (!infos[i]) throw new RpcError(`${chain}: block ${b} not found`);
      return [b, num(infos[i].timestamp) * 1000];
    }));
    const deposits = mine.map((l) => {
      const raw = BigInt(l.data === '0x' ? 0 : l.data);
      const units = toUnits(raw, decimals);
      return {
        chain, txid: l.transactionHash, logIndex: num(l.logIndex), block: num(l.blockNumber), time: times.get(num(l.blockNumber)),
        from: addrOfTopic(l.topics[1]), to: addrOfTopic(l.topics[2]),
        amount: units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : units, rawAmount: raw.toString(),
      };
    }).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    return { deposits, next: String(to) };
  }

  async function receipt(hash) { return rpc.call('eth_getTransactionReceipt', [hash]); }

  async function txStatus(hash) {
    try {
      const [r, h] = await rpc.batch([['eth_getTransactionReceipt', [hash]], ['eth_blockNumber', []]]);
      if (!r) return 'pending';
      if (num(h) - num(r.blockNumber) < confirmations) return 'pending';
      return num(r.status) === 1 ? 'confirmed' : 'failed';
    } catch {
      return 'unknown';
    }
  }

  /** 已经有几个确认（上链那个区块算 1 个）；还没上链 0；连不上 null */
  async function confirmationsOf(hash) {
    try {
      const [r, h] = await rpc.batch([['eth_getTransactionReceipt', [hash]], ['eth_blockNumber', []]]);
      return r ? Math.max(0, num(h) - num(r.blockNumber) + 1) : 0;
    } catch { return null; }
  }

  return {
    chain, usdt, decimals, confirmations, rpc, confirmationsOf,
    head, transfers, receipt, txStatus,
    /** USDT 余额（原始数，bigint） */
    async tokenBalanceRaw(address, token = usdt) { return BigInt(await rpc.call('eth_call', [{ to: token, data: encodeBalanceOf(address) }, 'latest'])); },
    /** USDT 授权额度 allowance(owner, spender)（原始数，bigint）：批量打款读热钱包给 BatchPayout 的额度 */
    async allowanceRaw(owner, spender, token = usdt) { return BigInt(await rpc.call('eth_call', [{ to: token, data: encodeAllowance(owner, spender) }, 'latest'])); },
    async nativeBalance(address) { return BigInt(await rpc.call('eth_getBalance', [address, 'latest'])); },
    async isContract(address) { const c = await rpc.call('eth_getCode', [address, 'latest']); return typeof c === 'string' && c !== '0x' && c !== '0x0'; },
    async chainId() { return BigInt(await rpc.call('eth_chainId')); },
    async gasPrice() { return BigInt(await rpc.call('eth_gasPrice')); },
    async nonce(address) { return BigInt(await rpc.call('eth_getTransactionCount', [address, 'pending'])); },
    /** 已确认的 nonce：最新区块往前退"确认数"个区块时这个地址发过几笔（批量打款判断某个 nonce 是否已被别的交易用掉） */
    async confirmedNonce(address) {
      const h = await head();
      const at = Math.max(0, h - confirmations);
      return BigInt(await rpc.call('eth_getTransactionCount', [address, at === h ? 'latest' : hex(at)]));
    },
    /** 只读调用（eth_call，latest）：返回数据；回滚时抛出 RpcError，err.data 是回滚数据 */
    async call(tx) { return rpc.call('eth_call', [tx, 'latest']); },
    /** 地址上的合约代码（十六进制；没有代码是 0x） */
    async getCode(address) { return rpc.call('eth_getCode', [address, 'latest']); },
    async estimateGas(tx) { return BigInt(await rpc.call('eth_estimateGas', [tx])); },
    async sendRaw(raw) { return rpc.call('eth_sendRawTransaction', [raw]); },
    /** 节点认不认识这笔交易（在交易池里或已上链）；连不上时抛出 */
    async txKnown(hash) { return (await rpc.call('eth_getTransactionByHash', [hash])) !== null; },
  };
}
