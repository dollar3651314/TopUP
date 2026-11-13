// 钱包层的组装（web 和 worker 共用）：按配置建 ETH、BSC 的链适配器和 contract 提供方，cobo、fireblocks 是"未开通"的空实现。
// 合约参数来自 config/wallets.json 的 evm（公开地址，改要走 PR）；节点地址、确认数、发起账户私钥来自环境变量。
// 本地（APP_ENV=local）用内存替身，地址是假的，不在任何链上。
import { randomBytes } from 'node:crypto';
import { createEvmAdapter } from './adapters/evm.js';
import { createFakeEvm } from './adapters/fake-evm.js';
import { createContractProvider, EVM_CHAINS } from './providers/contract.js';
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

export function createWalletLayer({ db, config, evm = {} }) {
  const cfg = chainConfig(config, evm);
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
  // 本地替身没有真的私钥：每次启动随机生成一个（只活在这个进程里）
  const operatorKey = config.sweepOperatorKey || (config.fakeEvm ? '0x' + randomBytes(32).toString('hex') : '');
  let contract;
  try {
    contract = createContractProvider({ db, chains, operatorKey });
  } catch (e) {
    // 合约参数不对（例如 parent 等于批量合约）：不开通，系统状态里显示，不让整个服务起不来
    for (const chain of Object.keys(chains)) errors[chain] = e.message;
    contract = createContractProvider({ db, chains: {}, operatorKey: '' });
    for (const k of Object.keys(chains)) delete chains[k];
  }
  for (const [chain, a] of Object.entries(adapters)) if (a.fake && chains[chain]) a.bindSaltResolver((salt) => contract.addressForSalt(chain, salt));
  const providers = { contract, cobo: createUnavailableProvider('cobo'), fireblocks: createUnavailableProvider('fireblocks') };
  const enabledChains = Object.keys(chains);
  const layer = {
    providers, config: cfg, adapters, enabledChains, errors, operatorConfigured: Boolean(config.sweepOperatorKey) || Boolean(config.fakeEvm),
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
