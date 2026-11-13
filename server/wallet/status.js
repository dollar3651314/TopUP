// 系统状态（运营后台每条链一张卡、/api/health/ 的 wallet 一项）：扫块情况、合约地址配没配齐。
// 只给"是否已配置"，不返回任何地址的值；这一项单独显示，不进健康检查的整体 ok（钱包出问题不能让收款页面报 503）。
export const SCAN_STALE_MS = 5 * 60_000;

export function walletChainStatus({ chain, enabled = true, rpcConfigured = false, usdtConfigured = false, scheme = {}, cursor = null, head = null, confirmations = 0, lastScanAt = null, now = Date.now() }) {
  const contracts = Object.fromEntries(['factory', 'implementation', 'parent', 'batcher'].map((k) => [k, Boolean(scheme?.[k])]));
  if (!enabled) return { chain, status: 'not_in_this_batch', ok: true, contracts, rpc: false, usdt: false, scan: { ok: true, lag_blocks: null, age_s: null } };
  const age = lastScanAt ? Math.max(0, Math.round((now - new Date(lastScanAt).getTime()) / 1000)) : null;
  const lag = head != null && cursor != null && cursor !== '' ? Math.max(0, Number(head) - Number(confirmations) - Number(cursor)) : null;
  const scanOk = age !== null && age * 1000 <= SCAN_STALE_MS;
  const configured = rpcConfigured && usdtConfigured && Object.values(contracts).every(Boolean);
  const status = !configured ? 'not_configured' : !scanOk ? 'scan_stalled' : lag !== null && lag > 0 ? 'catching_up' : 'ok';
  return { chain, status, ok: configured && scanOk, contracts, rpc: Boolean(rpcConfigured), usdt: Boolean(usdtConfigured), scan: { ok: scanOk, lag_blocks: lag, age_s: age } };
}
