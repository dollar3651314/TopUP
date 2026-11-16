// 验收用例自己解码以太坊 / BSC 打款交易原文（不装依赖：staging-e2e 流程不 npm install，所以不能引用 server/wallet/evm-payout-codec.js，它要 @noble）。
// 只为核对"服务器给的原文里到底写了什么"，不拿期望值（expect.*，同样来自服务器）自证。
// 只认 EIP-155 未签名旧式交易（RLP 列表 9 项）和 BatchPayout.pay(address,bytes32,address[],uint256[]) 的标准 ABI 布局；
// 和服务器的严格解码器在 test/staging-e2e-evm-raw.test.js 里对拍。
const hexToBytes = (h) => {
  const s = String(h).replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(s) || s.length % 2) throw new Error('bad hex');
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));
};
const toHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const toInt = (b) => (b.length ? BigInt(toHex(b)) : 0n);
const beLen = (b, at, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[at + i]; return v; };

/** 读一个 RLP 项：返回 [值（字节或列表）, 下一项的位置] */
function rlpItem(b, at) {
  const p = b[at];
  if (p === undefined) throw new Error('rlp: out of range');
  if (p < 0x80) return [b.subarray(at, at + 1), at + 1];
  if (p < 0xb8) return [b.subarray(at + 1, at + 1 + p - 0x80), at + 1 + p - 0x80];
  if (p < 0xc0) { const n = p - 0xb7, len = beLen(b, at + 1, n); return [b.subarray(at + 1 + n, at + 1 + n + len), at + 1 + n + len]; }
  let start, end;
  if (p < 0xf8) { start = at + 1; end = start + p - 0xc0; } else { const n = p - 0xf7; start = at + 1 + n; end = start + beLen(b, at + 1, n); }
  if (end > b.length) throw new Error('rlp: list overruns');
  const out = [];
  for (let i = start; i < end;) { const [v, next] = rlpItem(b, i); out.push(v); i = next; }
  return [out, end];
}

/** 未签名旧式交易原文 → { nonce, gasPrice, gas, to（小写）, value, data（0x…）, chainId }（整数都是 bigint） */
export function decodeRawTx(rawHex) {
  const b = hexToBytes(rawHex);
  const [items, end] = rlpItem(b, 0);
  if (!Array.isArray(items) || items.length !== 9 || end !== b.length) throw new Error('not an unsigned EIP-155 legacy tx');
  const [nonce, gasPrice, gas, to, value, data, chainId, r, s] = items;
  if (r.length || s.length || to.length !== 20) throw new Error('signed or bad to');
  return { nonce: toInt(nonce), gasPrice: toInt(gasPrice), gas: toInt(gas), to: toHex(to), value: toInt(value), data: toHex(data), chainId: toInt(chainId) };
}

/** BatchPayout.pay 的调用数据 → { selector, token（小写）, batchId, items: [{ to（小写）, amount（bigint） }] } */
export function decodePay(dataHex) {
  const d = String(dataHex).toLowerCase().replace(/^0x/, '');
  const w = Array.from({ length: Math.floor((d.length - 8) / 64) }, (_, i) => d.slice(8 + i * 64, 8 + (i + 1) * 64));
  const addr = (x) => '0x' + x.slice(24);
  const n = Number(BigInt('0x' + w[4]));
  if (w.length !== 6 + 2 * n || BigInt('0x' + w[5 + n]) !== BigInt(n)) throw new Error('pay: layout');
  return { selector: '0x' + d.slice(0, 8), token: addr(w[0]), batchId: '0x' + w[1], items: Array.from({ length: n }, (_, i) => ({ to: addr(w[5 + i]), amount: BigInt('0x' + w[6 + n + i]) })) };
}
