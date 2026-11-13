// 签名页面的核对规则：浏览器自己解码每一笔待签名的交易原文，按规则逐项核对，
// 不符合的交易不给签名。服务器和测试也用这份规则，但只有浏览器里的这一次核对才算数：
// 就算服务器被攻破、改了交易，页面也会拦下。
import { decodeRaw } from './txcodec.js';

const TRX = 1_000_000;
export const LIMITS = { activateMax: 2 * TRX, feeTrxMax: 30 * TRX, feeLimitMax: 50 * TRX, maxExpiryMs: 2 * 60 * 60 * 1000 };

/**
 * 核对一笔交易。
 * step = { kind, rawHex, txID }；expect = 浏览器自己确定的期望值：
 * - withdraw：{ to, amount }（页面显示给管理员核对的金额和收款地址，是解码出来的值）
 * - sweep_usdt：{ from（浏览器用助记词按序号推导出的地址）, amount }
 * - fee_trx / delegate / undelegate：{ to（同上，被归集的地址） }
 * rules = { hot, cold, usdt }：热钱包、冷钱包地址来自仓库里的配置文件，不来自服务器
 * 返回 { ok, error?, decoded }
 */
export function checkStep(step, expect, rules, now = Date.now()) {
  let d;
  try { d = decodeRaw(step.rawHex); } catch { return { ok: false, error: '交易原文无法解码' }; }
  const fail = (error) => ({ ok: false, error, decoded: d });
  if (step.txID && step.txID !== d.txId) return fail('交易哈希和原文不一致');
  if (d.contracts.length !== 1) return fail('一笔交易里有多个操作');
  const c = d.contracts[0];
  if (c.permissionId) return fail('交易使用了多签权限');
  if (d.expiration < now || d.expiration > now + LIMITS.maxExpiryMs) return fail('交易过期时间不正常');
  switch (step.kind) {
    case 'withdraw':
      if (c.type !== 'TriggerSmartContract' || c.method !== 'a9059cbb' || c.callValue) return fail('不是 USDT 转账');
      if (c.contract !== rules.usdt) return fail('合约不是 USDT');
      if (c.owner !== rules.hot) return fail(`付款地址不是热钱包：${c.owner}`);
      if (c.to !== expect.to) return fail(`收款地址不一致：交易里是 ${c.to}`);
      if (c.amount !== expect.amount) return fail('金额不一致');
      if (d.feeLimit > LIMITS.feeLimitMax) return fail('手续费上限过高');
      break;
    case 'sweep_usdt':
      if (c.type !== 'TriggerSmartContract' || c.method !== 'a9059cbb' || c.callValue) return fail('不是 USDT 转账');
      if (c.contract !== rules.usdt) return fail('合约不是 USDT');
      if (c.owner !== expect.from) return fail('付款地址和助记词推导出的地址不一致');
      if (c.to !== rules.hot && !(rules.cold && c.to === rules.cold)) return fail(`收款地址不是热钱包或冷钱包：${c.to}`);
      if (expect.amount !== undefined && c.amount !== expect.amount) return fail('金额不一致');
      if (d.feeLimit > LIMITS.feeLimitMax) return fail('手续费上限过高');
      break;
    case 'fee_trx':
      if (c.type !== 'TransferContract') return fail('不是 TRX 转账');
      if (c.owner !== rules.hot) return fail('付款地址不是热钱包');
      if (c.to !== expect.to) return fail('补手续费的地址不是要归集的地址');
      if (c.amount > LIMITS.feeTrxMax) return fail('补手续费的金额过高');
      break;
    case 'delegate':
    case 'undelegate':
      if (c.type !== (step.kind === 'delegate' ? 'DelegateResourceContract' : 'UnDelegateResourceContract')) return fail('交易类型不对');
      if (c.owner !== rules.hot) return fail('不是热钱包的能量');
      if (c.to !== expect.to) return fail('能量借给的地址不是要归集的地址');
      if (c.resource !== 'ENERGY' || c.lock) return fail('资源类型或锁定设置不对');
      break;
    default:
      return fail('未知的交易类型');
  }
  return { ok: true, decoded: d };
}
