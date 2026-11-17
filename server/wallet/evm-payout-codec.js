// 以太坊、BSC 批量打款交易的编码和严格解码（第 3 批）：服务器出交易原文、签名页面自己解码核对、服务器套签名后广播，三处用同一份代码。
// 这个文件没有 Node 专属的依赖（不引入 Node 内置模块、不用 Node 的字节缓冲类）：服务器和浏览器的签名页面共用。
// "页面核对的就是链上执行的"：只认唯一一种写法——
//   交易原文：EIP-155 未签名旧式交易，RLP 列表正好 9 项、第 8、9 项为空；整数最短编码、长度前缀最短、列表后面不许多字节、to 必须 20 字节
//   pay / approve 调用数据：标准 ABI 布局（数组偏移固定、长度相等、结尾不许多字节、地址那一格高 12 字节为 0）
// 任何"不同解码器可能读出不同结果"的写法都拒签。
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

export const PAY_SIGNATURE = 'pay(address,bytes32,address[],uint256[])';
export const APPROVE_SIGNATURE = 'approve(address,uint256)';
export const MAX_PAY_ITEMS = 100; // 和 BatchPayout.MAX_ITEMS 一致

export class CodecError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
const fail = (code, msg) => { throw new CodecError(code, msg); };

// ---------- 字节和十六进制 ----------
const enc = new TextEncoder();
export function hexToBytes(h) {
  const s = String(h);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) fail('noncanonical', 'not 0x-prefixed even-length hex');
  const out = new Uint8Array((s.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}
export function bytesToHex(b) {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const bytesToBig = (b) => (b.length ? BigInt(bytesToHex(b)) : 0n);
function bigToBytes(v) {
  const n = BigInt(v);
  if (n < 0n) fail('invalid_param', 'negative integer');
  if (n === 0n) return new Uint8Array(0);
  const s = n.toString(16);
  return hexToBytes('0x' + (s.length % 2 ? '0' : '') + s);
}
const keccakHex = (b) => bytesToHex(keccak_256(b));

/** EIP-55 大小写校验格式（和 create2.js 的 toChecksumAddress 结果一样，这里只用 Uint8Array） */
export function checksumAddress(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(addr))) fail('invalid_address', 'not an EVM address');
  const lower = addr.slice(2).toLowerCase();
  const h = bytesToHex(keccak_256(enc.encode(lower))).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}
/** 按链校验地址：全小写 / 全大写不带校验信息的也收；大小写混合的必须校验和正确 */
export function isChecksumAddress(s) {
  if (typeof s !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(s)) return false;
  const body = s.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return checksumAddress(s) === s;
}

// ---------- RLP ----------
export function rlpEncode(item) {
  if (Array.isArray(item)) {
    const body = concat(item.map(rlpEncode));
    return concat([lenPrefix(body.length, 0xc0), body]);
  }
  if (item.length === 1 && item[0] < 0x80) return item;
  return concat([lenPrefix(item.length, 0x80), item]);
}
function lenPrefix(len, base) {
  if (len < 56) return Uint8Array.of(base + len);
  const l = bigToBytes(len);
  return concat([Uint8Array.of(base + 55 + l.length), l]);
}
/** 严格解码一项：返回 { item, end }；非最短写法一律拒 */
function rlpDecodeAt(b, i) {
  if (i >= b.length) fail('noncanonical', 'rlp: truncated');
  const p = b[i];
  const readLen = (n) => {
    if (n === 0 || i + 1 + n > b.length) fail('noncanonical', 'rlp: truncated length');
    if (b[i + 1] === 0) fail('noncanonical', 'rlp: length with leading zero');
    let len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + b[i + 1 + k];
    if (len < 56) fail('noncanonical', 'rlp: long form for short length');
    return len;
  };
  if (p < 0x80) return { item: b.subarray(i, i + 1), end: i + 1 };
  if (p <= 0xb7) {
    const len = p - 0x80, s = i + 1;
    if (s + len > b.length) fail('noncanonical', 'rlp: truncated string');
    if (len === 1 && b[s] < 0x80) fail('noncanonical', 'rlp: single byte with prefix');
    return { item: b.subarray(s, s + len), end: s + len };
  }
  if (p <= 0xbf) {
    const n = p - 0xb7, len = readLen(n), s = i + 1 + n;
    if (s + len > b.length) fail('noncanonical', 'rlp: truncated string');
    return { item: b.subarray(s, s + len), end: s + len };
  }
  let len, s;
  if (p <= 0xf7) { len = p - 0xc0; s = i + 1; } else { const n = p - 0xf7; len = readLen(n); s = i + 1 + n; }
  if (s + len > b.length) fail('noncanonical', 'rlp: truncated list');
  const items = [];
  let j = s;
  while (j < s + len) { const r = rlpDecodeAt(b, j); items.push(r.item); j = r.end; }
  if (j !== s + len) fail('noncanonical', 'rlp: list length mismatch');
  return { item: items, end: s + len };
}
function rlpDecode(b) {
  const r = rlpDecodeAt(b, 0);
  if (r.end !== b.length) fail('noncanonical', 'rlp: trailing bytes');
  return r.item;
}
function strictInt(bytes, field) {
  if (Array.isArray(bytes)) fail('noncanonical', `${field}: list instead of integer`);
  if (bytes.length && bytes[0] === 0) fail('noncanonical', `${field}: leading zero`);
  if (bytes.length > 32) fail('noncanonical', `${field}: too long`);
  return bytesToBig(bytes);
}

// ---------- 交易原文 ----------
/** 编码未签名的 EIP-155 旧式交易：{ nonce, gasPrice, gas, to, value, data, chainId } → 0x 十六进制 */
export function encodeUnsignedLegacyTx(tx) {
  const fields = [bigToBytes(tx.nonce), bigToBytes(tx.gasPrice), bigToBytes(tx.gas), hexToBytes(String(tx.to).toLowerCase()), bigToBytes(tx.value || 0), hexToBytes(String(tx.data || '0x').toLowerCase()), bigToBytes(tx.chainId), new Uint8Array(0), new Uint8Array(0)];
  return bytesToHex(rlpEncode(fields));
}

/** 严格解码未签名的 EIP-155 旧式交易 */
export function decodeUnsignedLegacyTx(rawHex) {
  const b = hexToBytes(rawHex);
  if (!b.length || b[0] < 0xc0) fail('noncanonical', 'not a legacy transaction (typed or not a list)');
  const items = rlpDecode(b);
  if (!Array.isArray(items) || items.length !== 9) fail('noncanonical', 'expected 9 fields (EIP-155 unsigned)');
  if (items.some(Array.isArray)) fail('noncanonical', 'nested list');
  const [nonce, gasPrice, gas, to, value, data, chainId, r, s] = items;
  if (r.length || s.length) fail('noncanonical', 'already signed');
  if (to.length !== 20) fail('noncanonical', 'to must be 20 bytes');
  const id = strictInt(chainId, 'chainId');
  if (id === 0n) fail('noncanonical', 'chainId is 0');
  return {
    nonce: strictInt(nonce, 'nonce'), gasPrice: strictInt(gasPrice, 'gasPrice'), gas: strictInt(gas, 'gas'),
    to: checksumAddress(bytesToHex(to)), value: strictInt(value, 'value'), data: bytesToHex(data), chainId: id,
  };
}

// ---------- ABI ----------
export const selectorOf = (sig) => bytesToHex(keccak_256(enc.encode(sig)).subarray(0, 4)).slice(2);
const PAY_SEL = selectorOf(PAY_SIGNATURE);
const APPROVE_SEL = selectorOf(APPROVE_SIGNATURE);
const W = 64; // 一格的十六进制字符数
const uw = (n) => BigInt(n).toString(16).padStart(64, '0');
const aw = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const words = (dataHex, sel) => {
  const d = String(dataHex).toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(d) || (d.length - 2) % 2) fail('noncanonical', 'bad calldata hex');
  if (d.slice(2, 10) !== sel) fail('wrong_method', 'unexpected function selector');
  const body = d.slice(10);
  if (body.length % W) fail('noncanonical', 'calldata not word-aligned');
  return Array.from({ length: body.length / W }, (_, i) => body.slice(i * W, (i + 1) * W));
};
const addrWord = (w) => {
  if (!w.startsWith('000000000000000000000000')) fail('noncanonical', 'address word has dirty high bytes');
  return checksumAddress('0x' + w.slice(24));
};
const uintWord = (w) => BigInt('0x' + w);

export function encodePayCall(token, batchId, items) {
  const n = items.length;
  const offB = 128 + 32 * (1 + n);
  return '0x' + PAY_SEL + aw(token) + aw(batchId) + uw(128) + uw(offB) + uw(n) + items.map((i) => aw(i.to)).join('') + uw(n) + items.map((i) => uw(i.amount)).join('');
}
export const encodeApproveCall = (spender, amount) => '0x' + APPROVE_SEL + aw(spender) + uw(amount);

/** BatchPayout.pay 的调用数据 → { token, batchId, items: [{ to, amount }] }（只认标准布局） */
export function decodePayCall(dataHex) {
  const w = words(dataHex, PAY_SEL);
  if (w.length < 6) fail('noncanonical', 'pay: calldata too short');
  const token = addrWord(w[0]);
  const batchId = '0x' + w[1];
  if (uintWord(w[2]) !== 128n) fail('noncanonical', 'pay: first array offset must be 0x80');
  const n = uintWord(w[4]);
  if (n < 1n || n > BigInt(MAX_PAY_ITEMS)) fail('noncanonical', 'pay: item count out of range');
  const k = Number(n);
  if (uintWord(w[3]) !== BigInt(128 + 32 * (1 + k))) fail('noncanonical', 'pay: second array must follow the first');
  if (w.length !== 4 + 2 + 2 * k) fail('noncanonical', 'pay: calldata length mismatch');
  if (uintWord(w[5 + k]) !== n) fail('noncanonical', 'pay: array lengths differ');
  const items = [];
  for (let i = 0; i < k; i++) items.push({ to: addrWord(w[5 + i]), amount: uintWord(w[6 + k + i]) });
  return { token, batchId, items };
}

/** approve(address,uint256) 的调用数据 → { spender, amount } */
export function decodeApproveCall(dataHex) {
  const w = words(dataHex, APPROVE_SEL);
  if (w.length !== 2) fail('noncanonical', 'approve: calldata length mismatch');
  return { spender: addrWord(w[0]), amount: uintWord(w[1]) };
}

// ---------- 核对 ----------
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const big = (v) => BigInt(v);
function checkEnvelope(tx, expect, to) {
  if (tx.chainId !== big(expect.chainId)) fail('wrong_chain', 'chain id mismatch');
  if (!same(tx.to, to)) fail('wrong_contract', 'transaction is not sent to the expected contract');
  if (tx.value !== 0n) fail('value_nonzero', 'transaction carries native coin');
}
function checkFee(tx, maxFeeWei) {
  if (maxFeeWei === undefined || maxFeeWei === null) fail('invalid_param', 'maxFeeWei required');
  if (tx.gas * tx.gasPrice > big(maxFeeWei)) fail('fee_too_high', 'gas × gasPrice exceeds the limit');
}

/**
 * 核对一笔打款交易：expect = { chainId, contract, token, batchId, items: [{ to, amount }], maxFeeWei }。
 * 通过返回 { tx, call }；不通过抛出 CodecError（e.code）。签名页面用页面自己的 maxFeeWei 常量，不用服务器给的。
 */
export function checkPayoutTx(rawHex, expect) {
  const tx = decodeUnsignedLegacyTx(rawHex);
  checkEnvelope(tx, expect, expect.contract);
  const call = decodePayCall(tx.data);
  if (!same(call.token, expect.token)) fail('wrong_token', 'token mismatch');
  if (!same(call.batchId, expect.batchId)) fail('wrong_batch', 'batch id mismatch');
  const want = expect.items || [];
  if (call.items.length !== want.length || call.items.some((it, i) => !same(it.to, want[i].to) || it.amount !== big(want[i].amount))) fail('item_mismatch', 'items differ from the approved list');
  checkFee(tx, expect.maxFeeWei);
  return { tx, call };
}

/** 核对一笔改授权额度的交易：expect = { chainId, token, spender, amount, maxFeeWei } */
export function checkApproveTx(rawHex, expect) {
  const tx = decodeUnsignedLegacyTx(rawHex);
  checkEnvelope(tx, expect, expect.token);
  const call = decodeApproveCall(tx.data);
  if (!same(call.spender, expect.spender)) fail('wrong_spender', 'spender mismatch');
  if (call.amount !== big(expect.amount)) fail('amount_mismatch', 'amount mismatch');
  checkFee(tx, expect.maxFeeWei);
  return { tx, call };
}

// ---------- 签名 ----------
const HALF_N = secp256k1.CURVE.n / 2n;
/** 未签名原文的签名哈希（页面签的就是它） */
export const sighashOf = (rawHex) => keccak_256(hexToBytes(rawHex));

/**
 * 把浏览器交回的 65 字节签名（r ‖ s ‖ recovery）套到服务器存的未签名原文上：返回 { raw, hash, from }。
 * 只收低 s（防可塑签名）；签名人由服务器自己算，不信页面说的。
 */
export function attachSignature(rawHex, sigHex) {
  const tx = decodeUnsignedLegacyTx(rawHex);
  const sig = hexToBytes(sigHex);
  if (sig.length !== 65) fail('bad_signature', 'signature must be 65 bytes');
  const r = bytesToBig(sig.subarray(0, 32)), s = bytesToBig(sig.subarray(32, 64));
  let rec = sig[64];
  if (rec >= 27) rec -= 27;
  if (rec !== 0 && rec !== 1) fail('bad_signature', 'bad recovery id');
  if (r <= 0n || r >= secp256k1.CURVE.n || s <= 0n || s > HALF_N) fail('bad_signature', 'signature out of range (high s not accepted)');
  let pub;
  try { pub = new secp256k1.Signature(r, s).addRecoveryBit(rec).recoverPublicKey(sighashOf(rawHex)).toRawBytes(false); } catch { fail('bad_signature', 'cannot recover signer'); }
  const from = checksumAddress(bytesToHex(keccak_256(pub.subarray(1)).subarray(12)));
  const v = tx.chainId * 2n + 35n + BigInt(rec);
  const signed = rlpEncode([bigToBytes(tx.nonce), bigToBytes(tx.gasPrice), bigToBytes(tx.gas), hexToBytes(tx.to.toLowerCase()), bigToBytes(tx.value), hexToBytes(tx.data), bigToBytes(v), bigToBytes(r), bigToBytes(s)]);
  return { raw: bytesToHex(signed), hash: keccakHex(signed), from };
}

/** 签名页面用：私钥（32 字节）签一份未签名原文 → 0x + r ‖ s ‖ recovery（65 字节） */
export function signUnsigned(rawHex, keyBytes) {
  const s = secp256k1.sign(sighashOf(rawHex), keyBytes, { lowS: true });
  return '0x' + s.r.toString(16).padStart(64, '0') + s.s.toString(16).padStart(64, '0') + s.recovery.toString(16).padStart(2, '0');
}
/** 私钥（32 字节）→ 地址（EIP-55） */
export function addressOfKeyBytes(keyBytes) {
  return checksumAddress(bytesToHex(keccak_256(secp256k1.getPublicKey(keyBytes, false).subarray(1)).subarray(12)));
}
