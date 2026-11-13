// 默认的钱包提供方 contract：ETH / BSC 合约钱包。
//   - 地址：盐 = keccak256("topup-deposit" ‖ 客户序号)，地址 = BitGo 工厂 CREATE2（纯计算，不上链）；同一客户 ETH、BSC 同一个地址
//   - 到账：自己扫链（ChainAdapter evm）
//   - 归集：服务器上的发起账户签名调用批量合约 SweepBatcher.sweep(token, salts)；钱只能进部署时写死的 parent（冷钱包）
//   - TRON 合约第 2 批上线，第 1 批这里不给 TRON 地址（chain_not_enabled）
import { WalletError, NO_CAPABILITIES } from '../provider.js';
import { depositSalt, forwarderAddress, isEvmAddress } from '../create2.js';
import { toUnits } from '../units.js';
import { encodeSweep, signLegacyTx, addressOfKey, keccakHex } from '../evm-tx.js';
import { watchedAddresses } from '../addresses.js';
import { planSweep as plan } from '../sweep-plan.js';

export const EVM_CHAINS = Object.freeze(['eth', 'bsc']);
const SWEPT_TOPIC = keccakHex(Buffer.from('Swept(bytes32,address,bool)'));
const SWEEP_FAILED_TOPIC = keccakHex(Buffer.from('SweepFailed(bytes32,address,bytes)'));
// gas 预估（实测：1 个地址首次 部署 + 归集 157,128；已部署 50,230，见 contracts/README.md）；留余量
export const SWEEP_GAS = Object.freeze({ base: 40_000n, deploy: 160_000n, deployed: 45_000n });

/** 合约参数检查：钱只能进写死的 parent，所以 parent 不能是批量合约或 USDT 合约；错误信息带出字段名 */
export function checkScheme(chain, scheme, usdt) {
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
export function createContractProvider({ db, chains = {}, operatorKey = '' }) {
  const cfg = {};
  for (const [chain, c] of Object.entries(chains)) {
    if (!EVM_CHAINS.includes(chain)) throw new Error(`contract provider: unsupported chain ${chain}`);
    if (!c?.adapter) throw new Error(`${chain}: adapter missing`);
    checkScheme(chain, c.scheme, c.usdt);
    cfg[chain] = { ...c, scheme: { ...c.scheme } };
  }
  const operator = operatorKey ? addressOfKey(operatorKey) : null;
  const need = (chain) => {
    if (!cfg[chain]) throw new WalletError('chain_not_enabled', `contract wallet: chain ${chain} is not enabled`);
    return cfg[chain];
  };
  const addrFor = (chain, salt) => {
    const { scheme } = need(chain);
    return forwarderAddress({ factory: scheme.factory, implementation: scheme.implementation, parent: scheme.parent, feeAddress: scheme.batcher, salt });
  };
  const gasFor = (items) => SWEEP_GAS.base + items.reduce((s, i) => s + (i.deploy ? SWEEP_GAS.deploy : SWEEP_GAS.deployed), 0n);

  const provider = {
    id: 'contract',
    enabled: true,
    chains: Object.keys(cfg),
    operator,
    capabilities(chain) {
      return cfg[chain] ? { batchSweep: true, batchPayout: false, selfScan: true, webhook: false } : { ...NO_CAPABILITIES };
    },
    schemeVer(chain) { return cfg[chain]?.scheme.ver; },
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

    async executeSweep({ chain, items }) {
      const { adapter, scheme, usdt } = need(chain);
      if (!operator) throw new WalletError('operator_not_configured', 'sweep operator key is not configured');
      if (!items?.length) throw new WalletError('empty_batch', 'nothing to sweep');
      const salts = items.map((i) => i.salt);
      const data = encodeSweep(usdt, salts);
      const [chainId, nonce, gasPrice] = await Promise.all([adapter.chainId(), adapter.nonce(operator), adapter.gasPrice()]);
      let gas;
      try { gas = (await adapter.estimateGas({ from: operator, to: scheme.batcher, data })) * 12n / 10n; } catch { gas = gasFor(items); }
      const { raw, hash } = signLegacyTx({ nonce, gasPrice, gas, to: scheme.batcher, value: 0, data, chainId }, operatorKey);
      const sent = await adapter.sendRaw(raw);
      return { txRefs: [sent || hash] };
    },

    /** 归集交易的结果：按批量合约的 Swept / SweepFailed 事件逐个地址判断（部分成功照记） */
    async sweepOutcome(chain, txRef, items) {
      const { adapter, scheme } = need(chain);
      const status = await adapter.txStatus(txRef);
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
      return operator ? adapter.nativeBalance(operator) : null;
    },
    /** 预估手续费（原生币，wei）。n：地址数；deploy：其中要先部署的个数 */
    async estimateFee(chain, op, n = 1, { deploy = n } = {}) {
      const { adapter } = need(chain);
      if (op !== 'sweep') throw new WalletError('not_supported', 'only sweep fees are estimated in this release');
      const gasPrice = await adapter.gasPrice();
      const gas = SWEEP_GAS.base + BigInt(deploy) * SWEEP_GAS.deploy + BigInt(Math.max(0, n - deploy)) * SWEEP_GAS.deployed;
      return { native: gas * gasPrice, gas, gasPrice, detail: `${n} address(es), ${deploy} first-time` };
    },
    async txStatus(chain, txRef) { return need(chain).adapter.txStatus(txRef); },
    health() {
      return { enabled: true, status: Object.keys(cfg).length ? 'ok' : 'not_configured', alert: false, chains: Object.keys(cfg), operator: Boolean(operator) };
    },
  };
  return provider;
}
