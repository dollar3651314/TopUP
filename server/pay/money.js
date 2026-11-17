// 金额工具：USDT 金额一律用整数（单位 0.000001 USDT，和 USDT 合约的 6 位小数一致），不用浮点数。
// 页面显示、原型计算和正式接口共用这一份规则。

export const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

/** 手续费设置：百分比按"百万分之一"存（1% = 10000），固定金额和最低收费按最小单位存 */

/** "1,234.5" → 1234500000（最小单位）；格式不对或超过 6 位小数时返回 null */
export function parseUsdt(input) {
  const s = input.replace(/[,\s]/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  return Number(BigInt(m[1]) * UNIT + BigInt((m[2] || '').padEnd(DECIMALS, '0')));
}

/** 1234500000 → "1,234.50"（至少 2 位小数，多余的 0 去掉） */
export function fmtUsdt(units, minFrac = 2){
  const neg = units < 0;
  const v = BigInt(Math.abs(units));
  const int = (v / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = (v % UNIT).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

/** 手续费 = max(最低收费, 金额 × 百分比（向上取整到最小单位） + 固定金额) */
export function calcFee(amount, rule){
  const pct = (BigInt(amount) * BigInt(rule.ppm) + 999_999n) / 1_000_000n;
  const fee = Number(pct) + rule.fixed;
  return Math.max(rule.min, fee);
}

/** 手续费规则的文字说明，例如 "1% + 0.5 USDT，最低 1 USDT" */
export function describeFee(rule, lang = 'zh'){
  const parts = [];
  if (rule.ppm) parts.push(`${rule.ppm / 10000}%`);
  if (rule.fixed) parts.push(`${fmtUsdt(rule.fixed, 0)} USDT`);
  let s = parts.join(' + ') || '0';
  if (rule.min) s += lang === 'zh' ? `，最低 ${fmtUsdt(rule.min, 0)} USDT` : `, min ${fmtUsdt(rule.min, 0)} USDT`;
  return s;
}

/** TRON 地址的基本格式检查（T 开头、34 位 Base58）。正式版在服务器和签名页面还会校验地址的校验和 */
export const isTronAddress = (s) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s.trim());

/** TXk8fQ…d5Z3w */
export const shortAddr = (a) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a);
