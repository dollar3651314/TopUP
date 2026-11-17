// TronGrid 客户端（TRON 官方节点服务）。只做本项目用到的几个接口；fetch 可以替换，测试时用本地替身。
// 主网 USDT 合约 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t；测试环境用 Nile 测试网（USDT_CONTRACT 可以覆盖）。
import { hexToAddress, addressToHex } from './tron.js';
import { createRateLimit, retryWait, RETRY_ATTEMPTS, RETRY_STATUSES, DEFAULT_QPS, genesisError } from '../wallet/adapters/tron.js';

export const NETWORKS = {
  mainnet: { base: 'https://api.trongrid.io', usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  nile: { base: 'https://nile.trongrid.io', usdt: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' },
};

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodeError = (message, code, httpStatus) => Object.assign(new Error(message), { code, ...(httpStatus !== undefined ? { httpStatus } : {}) });

/**
 * 限流、重试和 TRON 合约钱包的适配器（server/wallet/adapters/tron.js）同一套：任意 1 秒里最多开始 qps 个请求（默认 10，重试也算，配置 TRON_NODE_QPS）；
 * HTTP 429 / 503 退避重试，每个请求最多 4 次（间隔 1、2、4 秒，Retry-After 照着等但每次最多 10 秒）；其他 HTTP 错误不重试。
 * 出错：HTTP 错误 code 'rpc_http' + httpStatus；连不上、超时 code 'rpc_unreachable'（不重试：不知道节点收没收到）；返回的不是 JSON code 'rpc_http'。
 * 错误信息里只有接口路径（不含查询串），没有节点地址和 API Key。广播重试发的是同一份请求体（同一笔已签名交易）。
 * sleep、now：等待和限流的时钟（默认真的计时器 / Date.now，测试注入假的）
 */
export function createTronGrid({ network = 'mainnet', apiKey = '', usdt, base, fetchImpl = fetch, timeoutMs = 8000, qps = DEFAULT_QPS, now, sleep: injectedSleep } = {}) {
  const sleep = injectedSleep || realSleep;
  const net = NETWORKS[network] || NETWORKS.mainnet;
  const root = base || net.base;
  const contract = usdt || net.usdt;
  const rate = createRateLimit({ qps, now, sleep: injectedSleep }); // 只把调用方注入的 sleep 交给限流（自己的真计时器不算注入）
  async function call(path, body) {
    const where = path.split('?')[0];
    const payload = body ? JSON.stringify(body) : undefined;
    let wait = 0;
    for (let n = 1; ; n++) {
      const mark = await rate();
      let res;
      try {
        mark();
        res = await fetchImpl(root + path, {
          method: body ? 'POST' : 'GET',
          headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw nodeError(`trongrid: node unreachable (${e?.cause?.code || e?.name || 'network'}) ${where}`, 'rpc_unreachable');
      }
      if (res.ok) {
        try { return await res.json(); } catch { throw nodeError(`trongrid: invalid JSON ${where}`, 'rpc_http'); }
      }
      const retryAfter = res.headers.get('retry-after');
      await res.body?.cancel().catch(() => {});
      if (!RETRY_STATUSES.has(res.status) || n >= RETRY_ATTEMPTS) {
        throw nodeError(`trongrid: HTTP ${res.status} ${where}${n > 1 ? ` (after ${n} attempts)` : ''}`, 'rpc_http', res.status);
      }
      wait = retryWait(n, wait, retryAfter);
      await sleep(wait);
    }
  }
  /** USDT 合约的 balanceOf：激活与否都能查到 */
  async function usdtBalance(address) {
    const r = await call('/wallet/triggerconstantcontract', { owner_address: address, contract_address: contract, function_selector: 'balanceOf(address)', parameter: hexParam(address), visible: true });
    const hex = r.constant_result?.[0];
    if (!r.result?.result || !hex) throw new Error('balance_query_failed');
    return Number(BigInt(`0x${hex}`));
  }
  return {
    network, contract, qps: rate.qps,
    /** 创世块（0 号块）的 blockID（小写十六进制）：核对节点是主网还是 Nile（test-admin.js 的 TRON_GENESIS）；连不上抛出；答了但答的不是创世块抛 code genesis_invalid */
    async genesisBlockId() {
      let r;
      try { r = await call('/wallet/getblockbynum', { num: 0 }); } catch (e) { throw genesisError(e); }
      const id = String(r?.blockID || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id)) throw nodeError('trongrid: getblockbynum 0: unexpected response', 'genesis_invalid');
      return id;
    },
    /**
     * 已确认的 USDT 转账事件（Transfer），按时间升序。返回 { events, next }：next 是翻页用的 fingerprint。
     * 每条事件：{ txid, logIndex, block, time, from, to, amount }
     */
    async transfers({ minTs, maxTs, fingerprint }) {
      const q = new URLSearchParams({ event_name: 'Transfer', only_confirmed: 'true', order_by: 'block_timestamp,asc', limit: '200', min_block_timestamp: String(minTs), max_block_timestamp: String(maxTs) });
      if (fingerprint) q.set('fingerprint', fingerprint);
      const r = await call(`/v1/contracts/${contract}/events?${q}`);
      const events = (r.data || []).map((e) => ({
        txid: e.transaction_id, logIndex: Number(e.event_index), block: Number(e.block_number), time: Number(e.block_timestamp),
        from: hexToAddress(e.result.from), to: hexToAddress(e.result.to), amount: Number(e.result.value),
      }));
      return { events, next: r.meta?.fingerprint || null };
    },
    /** 最新已确认（固化）的区块号和时间 */
    async solidBlock() {
      const r = await call('/walletsolidity/getnowblock', {});
      return { number: r.block_header.raw_data.number, time: r.block_header.raw_data.timestamp };
    },
    /** 交易结果：null 表示还没确认；{ ok, fee, energy } */
    async txInfo(txid) {
      const r = await call('/walletsolidity/gettransactioninfobyid', { value: txid });
      if (!r || !r.id) return null;
      const ok = !r.receipt?.result || r.receipt.result === 'SUCCESS';
      return { ok: ok && r.result !== 'FAILED', fee: r.fee || 0, energy: r.receipt?.energy_usage_total || 0, block: r.blockNumber };
    },
    /** 账户资产：TRX、各种 TRC20 余额；账户不存在（没有激活）时 activated = false */
    async account(address) {
      const r = await call(`/v1/accounts/${address}`);
      const a = (r.data || [])[0];
      // USDT 余额直接向合约查询：没有激活的地址（只收过 USDT、没收过 TRX，新客户地址都是这样），
      // 账户接口什么都不返回，之前会当成 0，新地址无法归集，对账也漏算
      const usdt = await usdtBalance(address);
      if (!a) return { activated: false, trx: 0, trc20: usdt ? { [contract]: usdt } : {} };
      const trc20 = Object.assign({}, ...(a.trc20 || []));
      // 其他代币的余额可能超过 JS 能精确表示的范围：放不下的保留原始字符串（只用于显示），USDT 的余额一定放得下
      const out = Object.fromEntries(Object.entries(trc20).map(([k, v]) => [k, Number.isSafeInteger(Number(v)) ? Number(v) : String(v)]));
      if (usdt) out[contract] = usdt; else delete out[contract];
      return { activated: true, trx: a.balance || 0, trc20: out };
    },
    usdtBalance,
    /** 账户的能量和带宽 */
    async resources(address) {
      const r = await call('/wallet/getaccountresource', { address, visible: true });
      return { energyLimit: r.EnergyLimit || 0, energyUsed: r.EnergyUsed || 0, totalEnergyLimit: r.TotalEnergyLimit || 0, totalEnergyWeight: r.TotalEnergyWeight || 0 };
    },
    /** 最多还能借出多少质押的 TRX（单位 sun）来提供能量 */
    async canDelegate(address) {
      const r = await call('/wallet/getcandelegatedmaxsize', { owner_address: address, type: 1, visible: true });
      return r.max_size || 0;
    },
    /** 链上参数（能量价格等），用来估算手续费 */
    async chainParams() { return (await call('/wallet/getchainparameters', {})).chainParameter || []; },
    /** 构造 USDT 转账（不含签名）：返回交易原文，由浏览器解码核对后签名 */
    async buildUsdtTransfer({ from, to, amount, feeLimit = 50_000_000 }) {
      const param = hexParam(to) + BigInt(amount).toString(16).padStart(64, '0');
      const r = await call('/wallet/triggersmartcontract', { owner_address: from, contract_address: contract, function_selector: 'transfer(address,uint256)', parameter: param, fee_limit: feeLimit, call_value: 0, visible: true });
      if (!r.result?.result) throw new Error('build_failed');
      return r.transaction;
    },
    async buildTrxTransfer({ from, to, amount }) {
      const r = await call('/wallet/createtransaction', { owner_address: from, to_address: to, amount, visible: true });
      if (!r.txID) throw new Error('build_failed');
      return r;
    },
    async buildDelegate({ from, to, amount, undelegate = false }) {
      const r = await call(undelegate ? '/wallet/undelegateresource' : '/wallet/delegateresource', { owner_address: from, receiver_address: to, balance: amount, resource: 'ENERGY', lock: false, visible: true });
      if (!r.txID) throw new Error('build_failed');
      return r;
    },
    /** 广播已签名的完整交易（protobuf 十六进制）：签名的是我们自己改过过期时间的原文，所以用 hex 广播 */
    async broadcastHex(txHex) {
      const r = await call('/wallet/broadcasthex', { transaction: txHex });
      if (!r.result) throw Object.assign(new Error(`broadcast_failed ${r.code || ''} ${r.message || ''}`.trim()), { code: r.code });
      return r.txid;
    },
    /** 广播已签名的交易 */
    async broadcast(signedTx) {
      const r = await call('/wallet/broadcasttransaction', signedTx);
      if (!r.result) throw Object.assign(new Error(`broadcast_failed ${r.code || ''}`), { code: r.code });
      return r.txid || signedTx.txID;
    },
  };
}
// ABI 参数：地址左补零到 32 字节（去掉 41 前缀）
const hexParam = (addr) => addressToHex(addr).slice(2).padStart(64, '0');
