// 钱包接口层第一层 WalletProvider：钱由谁管（contract 合约钱包 / cobo / fireblocks）。
// 业务层只认这个接口，不知道钱在合约里还是在第三方托管；第三方自己扫链和签名，不经过 ChainAdapter。
// 每个提供方必须有下面这些方法；识别到账二选一：自己扫链（scan）或收 Webhook（handleWebhook）。

export const CHAINS = Object.freeze(['eth', 'bsc', 'tron']);
export const PROVIDER_IDS = Object.freeze(['contract', 'cobo', 'fireblocks']);
export const REQUIRED_METHODS = Object.freeze(['capabilities', 'allocateAddress', 'planSweep', 'executeSweep', 'planPayout', 'submitPayout', 'balance', 'estimateFee', 'txStatus']);
export const NO_CAPABILITIES = Object.freeze({ batchSweep: false, batchPayout: false, selfScan: false, webhook: false });

/** 带错误码的错误：业务层和接口层按 code 判断（不按文字） */
export class WalletError extends Error {
  constructor(code, message = code, status = 409) { super(message); this.code = code; this.status = status; }
}

export const isChain = (c) => CHAINS.includes(c);

/** 检查一个提供方的实现是否齐全，缺的方法名写进错误信息 */
export function assertProvider(p) {
  if (!p || typeof p !== 'object') throw new Error('provider: not an object');
  if (!PROVIDER_IDS.includes(p.id)) throw new Error(`provider id "${p.id}" is not one of ${PROVIDER_IDS.join(', ')}`);
  const missing = REQUIRED_METHODS.filter((m) => typeof p[m] !== 'function');
  if (missing.length) throw new Error(`provider ${p.id}: missing method(s) ${missing.join(', ')}`);
  const scan = typeof p.scan === 'function', hook = typeof p.handleWebhook === 'function';
  if (scan === hook) throw new Error(`provider ${p.id}: must have exactly one of scan / handleWebhook (has ${scan ? 'both' : 'neither'})`);
  return p;
}

/** 还没接入的提供方（第一版的 cobo、fireblocks）：能力全 false，任何操作都明确拒绝；健康状态"未开通"、不告警 */
export function createUnavailableProvider(id) {
  const no = async () => { throw new WalletError('provider_not_enabled', `wallet provider ${id} is not enabled`); };
  return {
    id, enabled: false,
    capabilities: () => ({ ...NO_CAPABILITIES }),
    allocateAddress: no, planSweep: no, executeSweep: no, planPayout: no, submitPayout: no,
    balance: no, estimateFee: no, txStatus: no, handleWebhook: no,
    health: () => ({ enabled: false, status: 'not_enabled', alert: false }),
  };
}
