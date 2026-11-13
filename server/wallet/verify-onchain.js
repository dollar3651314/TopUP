// 启动时和看系统状态时，用 eth_call 核对链上批量合约的参数和 config/wallets.json 一致：
//   batcher.parent() = parent（冷钱包）、batcher.factory() = factory、factory.implementationAddress() = implementation。
// 这三项决定 CREATE2 充值地址和钱的去向；配错了算出来的地址收到的钱归集不了，所以不一致就不开通这条链（不分配地址、不凑批）并发邮件告警。
// 节点连不上时不下结论（unverified），下一轮再核对；不一致只关这一条链，不让健康检查整体 DOWN。只返回结果，不返回地址的值。
import { selector } from './evm-tx.js';
import { raiseAlert, clearAlert, CHAIN_NAMES } from './sweep.js';

const call0 = (sig) => '0x' + selector(sig);
const asAddr = (word) => (typeof word === 'string' && /^0x[0-9a-fA-F]{64}$/.test(word) ? '0x' + word.slice(-40).toLowerCase() : null);

/** 核对一条链：返回 { result: 'ok' | 'mismatch' | 'unverified', fields?: [...不一致的字段名] } */
export async function verifyChain(adapter, scheme) {
  const ec = (to, sig) => adapter.rpc.call('eth_call', [{ to, data: call0(sig) }, 'latest']);
  let parent, factory, impl;
  try {
    [parent, factory] = await Promise.all([ec(scheme.batcher, 'parent()'), ec(scheme.batcher, 'factory()')]);
    impl = await ec(scheme.factory, 'implementationAddress()');
  } catch (e) {
    // 节点明确返回错误（例如这个地址上没有合约，调用回滚）算不一致；连不上算没核对
    if (e?.code === 'rpc_error') return { result: 'mismatch', fields: ['batcher'] };
    return { result: 'unverified' };
  }
  const fields = [];
  const same = (a, b) => a !== null && a === String(b).toLowerCase();
  if (!same(asAddr(parent), scheme.parent)) fields.push('parent');
  if (!same(asAddr(factory), scheme.factory)) fields.push('factory');
  if (!same(asAddr(impl), scheme.implementation)) fields.push('implementation');
  return fields.length ? { result: 'mismatch', fields } : { result: 'ok' };
}

/**
 * 核对 layer 里开通的每条链（本地替身不核对）。不一致：从 enabledChains 里拿掉、提供方停用这条链、记 errors、发告警。
 * 结果存在 layer.onchain[chain]（系统状态、健康检查用）。timeoutMs：每条链最多等多久（启动时不能卡住）
 */
export async function verifyLayer(layer, { db, notify, timeoutMs = 8000, now = Date.now() } = {}) {
  layer.onchain ||= {};
  const checks = Object.keys(layer.chainsConfigured || {}).map(async (chain) => {
    const c = layer.chainsConfigured[chain];
    if (c.adapter.fake) { layer.onchain[chain] = { result: 'ok', fake: true, at: new Date(now).toISOString() }; return; }
    let timer;
    const r = await Promise.race([verifyChain(c.adapter, c.scheme), new Promise((ok) => { timer = setTimeout(() => ok({ result: 'unverified' }), timeoutMs); })]).finally(() => clearTimeout(timer));
    layer.onchain[chain] = { ...r, at: new Date(now).toISOString() };
    const name = CHAIN_NAMES[chain];
    if (r.result === 'mismatch') {
      layer.disableChain(chain, 'onchain_mismatch');
      if (db) await raiseAlert(db, `onchain_${chain}`, notify, `${name} 合约参数和链上不一致，已停用这条链`,
        `${name} 链上批量合约的 ${r.fields.join('、')} 和 config/wallets.json 不一致。为了不分配收不了钱的地址，这条链已停用（不分配新地址、不凑批），其他链和收款页面不受影响。\n请核对 config/wallets.json 的 evm.${chain}，改好后走 PR 重新部署。`, { now }).catch(() => {});
    } else if (r.result === 'ok' && db) {
      await clearAlert(db, `onchain_${chain}`, notify, `${name} 合约参数核对一致`, `${name} 链上批量合约的参数和 config/wallets.json 一致。`).catch(() => {});
    }
  });
  await Promise.all(checks);
  return layer.onchain;
}
