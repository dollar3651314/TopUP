// 钱包层的组装（web 和 worker 共用）：按配置建 ETH、BSC、TRON 的链适配器和 contract 提供方，cobo、fireblocks 是"未开通"的空实现。
// 合约参数来自 config/wallets.json 的 evm 和 tron（公开地址，改要走 PR）；节点地址、确认数、发起账户私钥、租能量平台的 API Key 来自环境变量。
// 本地（APP_ENV=local）用内存替身，地址是假的，不在任何链上。
import { randomBytes } from 'node:crypto';
import { createEvmAdapter } from './adapters/evm.js';
import { createFakeEvm } from './adapters/fake-evm.js';
import { createContractProvider, EVM_CHAINS, checkScheme } from './providers/contract.js';
import { tronOperatorOf } from './providers/contract-tron.js';
import { createTronAdapter } from './adapters/tron.js';
import { createFakeTronAdapter } from './adapters/fake-tron.js';
import { isTronAddress } from './tron-create2.js';
import { createTronSaveRenter } from './energy.js';
import { NETWORKS as TRONGRID } from '../pay/trongrid.js';
import { createUnavailableProvider } from './provider.js';
import { isEvmAddress } from './create2.js';
import { verifyLayer } from './verify-onchain.js';

const DECIMALS = { eth: 6, bsc: 18 };

/** 每条链的配置情况（只给是否已配置，不给值） */
export function chainConfig(config, evm = {}) {
  const out = {};
  for (const chain of EVM_CHAINS) {
    const s = evm[chain] || {};
    const rpcUrl = config.fakeEvm ? 'fake' : config[`${chain}RpcUrl`] || '';
    const scheme = { ver: Number(s.ver) || 1, factory: s.factory || '', implementation: s.implementation || '', parent: s.parent || '', batcher: s.batcher || '' };
    const complete = Boolean(rpcUrl) && isEvmAddress(s.usdt || '') && ['factory', 'implementation', 'parent', 'batcher'].every((k) => isEvmAddress(scheme[k]));
    out[chain] = { chain, rpcUrl, usdt: s.usdt || '', scheme, complete, confirmations: config.fakeEvm ? 0 : config[`${chain}Confirmations`], decimals: DECIMALS[chain] };
  }
  return out;
}

/** TRON 合约钱包的配置情况（config/wallets.json 的 tron 一节；空着的不开通）。节点默认按 TRON_NETWORK 用 TronGrid */
export function tronChainConfig(config, tron) {
  if (!tron || typeof tron !== 'object') return null;
  const scheme = { ver: Number(tron.ver) || 1, factory: tron.factory || '', implementation: tron.implementation || '', parent: tron.parent || '', batcher: tron.batcher || '' };
  const rpcUrl = config.fakeTron ? 'fake' : config.tronNodeUrl || (TRONGRID[config.tronNetwork] || TRONGRID.mainnet).base;
  const complete = isTronAddress(tron.usdt || '') && ['factory', 'implementation', 'parent', 'batcher'].every((k) => isTronAddress(scheme[k]));
  return { chain: 'tron', rpcUrl, usdt: tron.usdt || '', scheme, complete, confirmations: config.fakeTron ? 0 : config.tronConfirmations ?? 19, decimals: 6 };
}

export function createWalletLayer({ db, config, evm = {}, tron = null }) {
  const cfg = chainConfig(config, evm);
  const tcfg = tronChainConfig(config, tron);
  if (tcfg) cfg.tron = tcfg;
  const chains = {};
  const adapters = {};
  const errors = {};
  for (const chain of EVM_CHAINS) {
    const c = cfg[chain];
    if (!c.complete) continue;
    try {
      adapters[chain] = config.fakeEvm
        ? createFakeEvm({ chain, usdt: c.usdt, decimals: c.decimals, parent: c.scheme.parent })
        : createEvmAdapter({ chain, rpcUrl: c.rpcUrl, usdt: c.usdt, decimals: c.decimals, confirmations: c.confirmations });
      chains[chain] = { adapter: adapters[chain], scheme: c.scheme, usdt: c.usdt };
    } catch (e) { errors[chain] = e.message; }
  }
  if (tcfg?.complete) {
    try {
      adapters.tron = config.fakeTron
        ? createFakeTronAdapter({ usdt: tcfg.usdt })
        : createTronAdapter({ base: tcfg.rpcUrl, apiKey: config.tronNodeUrl ? '' : config.tronApiKey || '', usdt: tcfg.usdt, confirmations: tcfg.confirmations });
      chains.tron = { adapter: adapters.tron, scheme: tcfg.scheme, usdt: tcfg.usdt };
    } catch (e) { errors.tron = e.message; }
  }
  // 每条链的合约参数先各自检查：一条链配错只停这条链，不连带别的链
  for (const chain of Object.keys(chains)) {
    try { checkScheme(chain, chains[chain].scheme, chains[chain].usdt); } catch (e) { errors[chain] = e.message; delete chains[chain]; delete adapters[chain]; }
  }
  // TRON 发起账户私钥：格式不对时当作没配（能分配地址、扫链，不能归集），系统状态里显示，不让整个服务起不来
  let tronOperatorKey = config.sweepOperatorKeyTron || '';
  if (tronOperatorKey) { try { tronOperatorOf(tronOperatorKey); } catch { errors.tron_operator = 'invalid_key'; tronOperatorKey = ''; } }
  // 租能量平台（TronSave）：配了 API Key 才用；没配就直接烧 TRX
  let tronEnergy = null;
  if (config.tronsaveApiKey && chains.tron && !config.fakeTron) {
    try { tronEnergy = createTronSaveRenter({ apiKey: config.tronsaveApiKey, network: config.tronNetwork === 'nile' ? 'nile' : 'mainnet', maxPriceSun: config.tronsaveMaxPriceSun || undefined }); } catch (e) { errors.tron_energy = e.message; }
  }
  // 本地替身没有真的私钥：每次启动随机生成一个（只活在这个进程里）
  const operatorKey = config.sweepOperatorKey || (config.fakeEvm ? '0x' + randomBytes(32).toString('hex') : '');
  let contract;
  try {
    contract = createContractProvider({ db, chains, operatorKey, tronOperatorKey, tronEnergy, tronRentMaxEnergy: config.tronRentMaxEnergy || null });
  } catch (e) {
    // 合约参数不对（例如 parent 等于批量合约）：不开通，系统状态里显示，不让整个服务起不来
    for (const chain of Object.keys(chains)) errors[chain] = e.message;
    contract = createContractProvider({ db, chains: {}, operatorKey: '' });
    for (const k of Object.keys(chains)) delete chains[k];
  }
  for (const [chain, a] of Object.entries(adapters)) if (a.fake && chains[chain] && typeof a.bindSaltResolver === 'function') a.bindSaltResolver((salt) => contract.addressForSalt(chain, salt));
  const providers = { contract, cobo: createUnavailableProvider('cobo'), fireblocks: createUnavailableProvider('fireblocks') };
  const enabledChains = Object.keys(chains);
  const layer = {
    providers, config: cfg, adapters, enabledChains, errors, operatorConfigured: Boolean(config.sweepOperatorKey) || Boolean(config.fakeEvm),
    tronOperatorConfigured: Boolean(tronOperatorKey), tronEnergy,
    chainsConfigured: { ...chains }, onchain: {},
    /** 停用一条链（链上参数和配置不一致）：从开通列表里拿掉（同一个数组，ops、付款页都看得到）、提供方不再给这条链地址和归集 */
    disableChain(chain, why) {
      const i = enabledChains.indexOf(chain);
      if (i >= 0) enabledChains.splice(i, 1);
      contract.disableChain?.(chain);
      errors[chain] = why;
    },
    /** 用 eth_call 核对链上合约参数（verify-onchain.js）；启动时、系统状态里调用 */
    verifyOnchain: (opts) => verifyLayer(layer, opts),
  };
  return layer;
}
