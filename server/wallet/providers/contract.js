// 默认的钱包提供方 contract：ETH / BSC 合约钱包。
//   - 地址：盐 = keccak256("topup-deposit" ‖ 客户序号)，地址 = BitGo 工厂 CREATE2（纯计算，不上链）；同一客户 ETH、BSC 同一个地址
//   - 到账：自己扫链（ChainAdapter evm）
//   - 归集：服务器上的发起账户签名调用批量合约 SweepBatcher.sweep(token, salts)；钱只能进部署时写死的 parent（冷钱包）
//   - TRON（第 2 批）：providers/contract-tron.js（0x41 地址、TRON 发起账户、租能量）；chains 里没有 tron 时照旧 chain_not_enabled
import { WalletError, NO_CAPABILITIES } from '../provider.js';
import { depositSalt, forwarderAddress, isEvmAddress } from '../create2.js';
import { toUnits } from '../units.js';
import { encodeSweep, signLegacyTx, addressOfKey, keccakHex } from '../evm-tx.js';
import { watchedAddresses } from '../addresses.js';
import { planSweep as plan } from '../sweep-plan.js';
import { checkTronScheme, createTronOps, tronOperatorOf } from './contract-tron.js';

export const EVM_CHAINS = Object.freeze(['eth', 'bsc']);
export const CONTRACT_CHAINS = Object.freeze(['eth', 'bsc', 'tron']);
const SWEPT_TOPIC = keccakHex(Buffer.from('Swept(bytes32,address,bool)'));
const SWEEP_FAILED_TOPIC = keccakHex(Buffer.from('SweepFailed(bytes32,address,bytes)'));
// gas 预估（实测：1 个地址首次 部署 + 归集 157,128；已部署 50,230，见 contracts/README.md）；留余量
/** 发出后多久还查不到这笔交易，就当没送到节点 */
export const DROPPED_AFTER_MS = 15 * 60_000;
/** 连接类错误（连不上、超时、HTTP 出错）：不知道节点收没收到；JSON-RPC 返回的错误才是节点明确拒绝 */
export const isConnectionError = (e) => ['rpc_unreachable', 'rpc_http'].includes(e?.code) || e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError;
export const SWEEP_GAS = Object.freeze({ base: 40_000n, deploy: 160_000n, deployed: 45_000n });

/** 合约参数检查：钱只能进写死的 parent，所以 parent 不能是批量合约或 USDT 合约；错误信息带出字段名 */
export function checkScheme(chain, scheme, usdt) {
  if (chain === 'tron') return checkTronScheme(scheme, usdt);
  if (!scheme || typeof scheme !== 'object') throw new Error(`${chain}: scheme missing`);
  if (!Number.isInteger(scheme.ver) || scheme.ver <= 0) throw new Error(`${chain}: scheme.ver must be a positive integer`);
  for (const k of ['factory', 'implementation', 'parent', 'batcher']) if (!isEvmAddress(scheme[k])) throw new Error(`${chain}: scheme.${k} is not a valid address`);
  if (!isEvmAddress(usdt)) throw new Error(`${chain}: usdt is not a valid address`);
  const lc = (a) => a.toLowerCase();
  if (lc(scheme.parent) === lc(scheme.batcher)) throw new Error(`${chain}: scheme.parent must not be the batcher contract`);
  if (lc(scheme.parent) === lc(usdt)) throw new Error(`${chain}: scheme.parent must not be the USDT contract`);
  if (lc(scheme.parent) === lc(scheme.factory) || lc(scheme.parent) === lc(scheme.implementation)) throw new Error(`${chain}: scheme.parent must not be the factory or implementation`);
}

/**
 * chains：{ eth|bsc: { adapter, scheme: { ver, factory, implementation, parent, batcher }, usdt } }，没配置的链不放进来；
 * operatorKey：归集发起账户的私钥（只在服务器的 .env 里）。没有时只能分配地址、扫链，不能执行归集
 */
export function createContractProvider({ db, chains = {}, operatorKey = '', tronOperatorKey = '', tronEnergy = null, tronRentMaxEnergy = null }) {
  const cfg = {};
  for (const [chain, c] of Object.entries(chains)) {
    if (!CONTRACT_CHAINS.includes(chain)) throw new Error(`contract provider: unsupported chain ${chain}`);
    if (!c?.adapter) throw new Error(`${chain}: adapter missing`);
    checkScheme(chain, c.scheme, c.usdt);
    cfg[chain] = { ...c, scheme: { ...c.scheme } };
  }
  const operator = operatorKey ? addressOfKey(operatorKey) : null;
  const need = (chain) => {
    if (!cfg[chain]) throw new WalletError('chain_not_enabled', `contract wallet: chain ${chain} is not enabled`);
    return cfg[chain];
  };
  // TRON 发起账户（SWEEP_OPERATOR_KEY_TRON）：只能调用 TRON 批量合约；租能量平台（TronSave）只给它租
  const tronOp = tronOperatorKey ? tronOperatorOf(tronOperatorKey) : null;
  const tron = createTronOps({ need: () => need('tron'), operator: tronOp, renter: tronEnergy || null, rentMaxEnergy: tronRentMaxEnergy ? BigInt(tronRentMaxEnergy) : null });
  const addrFor = (chain, salt) => {
    if (chain === 'tron') return tron.addressForSalt(salt);
    const { scheme } = need(chain);
    return forwarderAddress({ factory: scheme.factory, implementation: scheme.implementation, parent: scheme.parent, feeAddress: scheme.batcher, salt });
  };
  const gasFor = (items) => SWEEP_GAS.base + items.reduce((s, i) => s + (i.deploy ? SWEEP_GAS.deploy : SWEEP_GAS.deployed), 0n);

  const provider = {
    id: 'contract',
    enabled: true,
    chains: Object.keys(cfg),
    operator,
    /** TRON 发起账户的公开地址（补 TRX 时复制它；不是密钥） */
    tronOperator: tronOp ? tronOp.address : null,
    tronEnergy: tronEnergy || null,
    capabilities(chain) {
      return cfg[chain] ? { batchSweep: true, batchPayout: false, selfScan: true, webhook: false } : { ...NO_CAPABILITIES };
    },
    schemeVer(chain) { return cfg[chain]?.scheme.ver; },
    /** 停用一条链（链上参数和配置不一致时由钱包层调用）：之后这条链 chain_not_enabled */
    disableChain(chain) { delete cfg[chain]; provider.chains = Object.keys(cfg); },
    scheme(chain) { return cfg[chain] ? { ...cfg[chain].scheme } : null; },

    async allocateAddress({ merchantId, customerId, chain }) {
      need(chain);
      const [c] = await db.query('select seq from customers where merchant_id = $1 and customer_id = $2', [merchantId, customerId]);
      if (!c || !c.seq) throw new WalletError('customer_not_found', 'customer not found', 404);
      const salt = depositSalt(BigInt(c.seq));
      return { address: addrFor(chain, salt), providerRef: salt, schemeVer: cfg[chain].scheme.ver };
    },
    addressForSalt: (chain, salt) => addrFor(chain, salt),

    async scan(chain, cursor) {
      const { adapter } = need(chain);
      const addresses = await watchedAddresses(db, { chain, provider: 'contract' });
      return adapter.transfers({ cursor, addresses });
    },

    async planSweep(chain, candidates, limits) {
      need(chain);
      return { chain, ...plan(candidates, limits) };
    },

    /**
     * 签名并广播一笔归集交易。分两段处理出错：
     *   - 签名前（取 chainId、nonce、gasPrice，或者没配发起账户）出错：交易没签出去，错误带 stage = 'prepare'，批次退回待确认
     *   - 广播时连接类错误（连不上、超时、HTTP 出错）：交易可能已经到了节点，不当失败；返回签名后本地算出的交易号，
     *     broadcast = 'uncertain'，由 confirmSweeps 按交易号继续查
     *   - 只有节点明确拒绝（JSON-RPC 返回错误）才算发送失败（stage = 'broadcast'）
     */
    async executeSweep({ chain, items }) {
      if (chain === 'tron') return tron.executeSweep(items);
      const prep = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { stage: 'prepare' });
      let c;
      try { c = need(chain); } catch (e) { throw prep(e); }
      const { adapter, scheme, usdt } = c;
      if (!operator) throw prep(new WalletError('operator_not_configured', 'sweep operator key is not configured'));
      if (!items?.length) throw prep(new WalletError('empty_batch', 'nothing to sweep'));
      const salts = items.map((i) => i.salt);
      const data = encodeSweep(usdt, salts);
      let chainId, nonce, gasPrice;
      try { [chainId, nonce, gasPrice] = await Promise.all([adapter.chainId(), adapter.nonce(operator), adapter.gasPrice()]); } catch (e) { throw prep(e); }
      let gas;
      try { gas = (await adapter.estimateGas({ from: operator, to: scheme.batcher, data })) * 12n / 10n; } catch { gas = gasFor(items); }
      const { raw, hash } = signLegacyTx({ nonce, gasPrice, gas, to: scheme.batcher, value: 0, data, chainId }, operatorKey);
      try {
        await adapter.sendRaw(raw);
      } catch (e) {
        if (isConnectionError(e)) return { txRefs: [hash], broadcast: 'uncertain' };
        if (/already known|known transaction|already imported/i.test(String(e?.message))) return { txRefs: [hash] }; // 节点已经有这笔
        throw Object.assign(new WalletError('sweep_rejected', `node rejected the sweep transaction: ${String(e?.message || e).slice(0, 200)}`), { stage: 'broadcast' });
      }
      return { txRefs: [hash] }; // 以本地算出的交易号为准（和节点返回的一致）
    },

    /** 归集交易的结果：按批量合约的 Swept / SweepFailed 事件逐个地址判断（部分成功照记） */
    async sweepOutcome(chain, txRef, items, { sentAt = null, now = Date.now() } = {}) {
      if (chain === 'tron') return tron.sweepOutcome(txRef, items, { sentAt, now, droppedAfterMs: DROPPED_AFTER_MS });
      const { adapter, scheme } = need(chain);
      const status = await adapter.txStatus(txRef);
      if (status === 'pending' && sentAt && now - new Date(sentAt).getTime() > DROPPED_AFTER_MS && typeof adapter.txKnown === 'function') {
        // 发出超过 15 分钟、节点既没有回执也不认识这笔交易：广播时没送到（或被节点丢掉了）。
        // 地址放回待归集是安全的：就算这笔以后又上链，钱也只会进冷钱包。节点连不上（null）时照常等
        const known = await adapter.txKnown(txRef).catch(() => null);
        if (known === false) return { status: 'failed', swept: [], failed: items.map((i) => ({ address: i.address, reason: 'not_broadcast' })) };
      }
      if (status === 'pending' || status === 'unknown') return { status, swept: [], failed: [] };
      if (status === 'failed') return { status, swept: [], failed: items.map((i) => ({ address: i.address, reason: 'tx_reverted' })) };
      const r = await adapter.receipt(txRef);
      const mine = (r?.logs || []).filter((l) => l.address?.toLowerCase() === scheme.batcher.toLowerCase());
      const saltsOf = (topic) => new Set(mine.filter((l) => l.topics?.[0]?.toLowerCase() === topic).map((l) => l.topics[1].toLowerCase()));
      const ok = saltsOf(SWEPT_TOPIC), bad = saltsOf(SWEEP_FAILED_TOPIC);
      const swept = [], failed = [];
      for (const i of items) {
        const s = i.salt.toLowerCase();
        if (ok.has(s) && !bad.has(s)) swept.push(i.address);
        else failed.push({ address: i.address, reason: bad.has(s) ? 'reverted' : 'no_event' });
      }
      return { status: 'confirmed', swept, failed };
    },

    async planPayout() { throw new WalletError('not_supported', 'batch payout is not in this release'); },
    async submitPayout() { throw new WalletError('not_supported', 'batch payout is not in this release'); },

    /** USDT 余额（0.000001 单位，bigint）：address = 充值地址；vault = 'cold' 是冷钱包 parent */
    async balance(chain, { address, vault } = {}) {
      const { adapter, scheme } = need(chain);
      const who = address || (vault === 'cold' ? scheme.parent : null);
      if (!who) throw new WalletError('not_supported', 'balance: give an address or vault = cold');
      return toUnits(await adapter.tokenBalanceRaw(who), adapter.decimals);
    },
    async isDeployed(chain, address) { return need(chain).adapter.isContract(address); },
    /** 发起账户的原生币余额（付手续费用） */
    async operatorGas(chain) {
      const { adapter } = need(chain);
      const who = chain === 'tron' ? tronOp?.address : operator;
      return who ? adapter.nativeBalance(who) : null;
    },
    /** 预估手续费（原生币，wei）。n：地址数；deploy：其中要先部署的个数 */
    async estimateFee(chain, op, n = 1, { deploy = n } = {}) {
      const { adapter } = need(chain);
      if (op !== 'sweep') throw new WalletError('not_supported', 'only sweep fees are estimated in this release');
      if (chain === 'tron') return tron.estimateFee(n, { deploy });
      const gasPrice = await adapter.gasPrice();
      const gas = SWEEP_GAS.base + BigInt(deploy) * SWEEP_GAS.deploy + BigInt(Math.max(0, n - deploy)) * SWEEP_GAS.deployed;
      return { native: gas * gasPrice, gas, gasPrice, detail: `${n} address(es), ${deploy} first-time` };
    },
    async txStatus(chain, txRef) { return need(chain).adapter.txStatus(txRef); },
    /** 归集交易的确认数：{ have, need }；have 为 null 表示节点连不上 */
    async txConfirmations(chain, txRef) {
      const { adapter } = need(chain);
      const have = typeof adapter.confirmationsOf === 'function' ? await adapter.confirmationsOf(txRef) : null;
      return { have, need: adapter.confirmations };
    },
    health() {
      return { enabled: true, status: Object.keys(cfg).length ? 'ok' : 'not_configured', alert: false, chains: Object.keys(cfg), operator: Boolean(operator), tronOperator: Boolean(tronOp) };
    },
  };
  return provider;
}
