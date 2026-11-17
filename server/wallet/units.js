// 链上原始金额 → 0.000001 USDT 单位（bigint）。
// ETH、TRON 的 USDT 是 6 位小数，原样；BSC 的 USDT 是 18 位小数，按 10^12 向下取整，余数不入账
// （归集时合约把地址上的全部余额转走，余数一起进冷钱包；对账按链上原始数另记）。
export const UNIT_DECIMALS = 6;

/** raw：十进制字符串或 bigint；decimals：代币小数位数（≥ 6） */
export function toUnits(raw, decimals) {
  if (!Number.isInteger(decimals) || decimals < UNIT_DECIMALS || decimals > 36) throw new Error(`unsupported token decimals: ${decimals}`);
  let v;
  if (typeof raw === 'bigint') v = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw)) v = BigInt(raw);
  else throw new Error(`raw amount must be a non-negative integer string or bigint: ${String(raw)}`);
  if (v < 0n) throw new Error(`raw amount must not be negative: ${v}`);
  return v / 10n ** BigInt(decimals - UNIT_DECIMALS);
}

/** 0.000001 USDT 单位 → 链上原始金额（bigint） */
export function fromUnits(units, decimals) {
  if (!Number.isInteger(decimals) || decimals < UNIT_DECIMALS) throw new Error(`unsupported token decimals: ${decimals}`);
  return BigInt(units) * 10n ** BigInt(decimals - UNIT_DECIMALS);
}
