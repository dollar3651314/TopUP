// TRON 交易原文的解码和编码（protobuf），只支持本项目用到的 4 种交易：
// TRX 转账（激活地址、补手续费）、USDT 转账、借出能量、收回能量。
// 这个文件没有 Node 专属的依赖：服务器和浏览器的签名页面共用。签名页面用它自己解码交易原文，
// 不相信服务器给的任何文字说明。
import { sha256 } from '@noble/hashes/sha256';
import { createBase58check, hex } from '@scure/base';

const b58c = createBase58check(sha256);
export const toAddress = (bytes21) => b58c.encode(bytes21);
export const fromAddress = (a) => b58c.decode(a);

export const TYPES = { 1: 'TransferContract', 31: 'TriggerSmartContract', 57: 'DelegateResourceContract', 58: 'UnDelegateResourceContract' };
const TRANSFER_SELECTOR = 'a9059cbb';

// ---------- protobuf 基础 ----------
function readVarint(b, i) {
  let x = 0n, shift = 0n;
  for (;;) {
    if (i >= b.length) throw new Error('truncated');
    const c = b[i++];
    x |= BigInt(c & 0x7f) << shift;
    if (!(c & 0x80)) return [x, i];
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
}
function writeVarint(x) {
  const out = [];
  let v = BigInt(x);
  do { let c = Number(v & 0x7fn); v >>= 7n; if (v) c |= 0x80; out.push(c); } while (v);
  return out;
}
/** 读出一层 protobuf 的所有字段：[{ no, wire, value(BigInt 或 Uint8Array), start, end }] */
export function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const start = i;
    let key; [key, i] = readVarint(b, i);
    const no = Number(key >> 3n), wire = Number(key & 7n);
    let value;
    if (wire === 0) [value, i] = readVarint(b, i);
    else if (wire === 2) { let len; [len, i] = readVarint(b, i); const n = Number(len); if (i + n > b.length) throw new Error('truncated'); value = b.slice(i, i + n); i += n; }
    else if (wire === 1) { value = b.slice(i, i + 8); i += 8; }
    else if (wire === 5) { value = b.slice(i, i + 4); i += 4; }
    else throw new Error(`unsupported wire type ${wire}`);
    out.push({ no, wire, value, start, end: i });
  }
  return out;
}
const one = (fs, no) => fs.find((f) => f.no === no)?.value;
const num = (v) => (v === undefined ? 0 : Number(v));

// ---------- 解码 ----------
/**
 * 解码交易原文（raw_data_hex）。返回：
 * { txId, expiration, timestamp, feeLimit, contracts: [{ type, owner, to, amount, contract?, resource? }] }
 * USDT 转账时 to、amount 是从合约调用数据里解出来的收款地址和金额；contract 是被调用的合约地址。
 */
export function decodeRaw(rawHex) {
  const b = hex.decode(rawHex);
  const f = fields(b);
  const contracts = f.filter((x) => x.no === 11).map((c) => {
    const cf = fields(c.value);
    const typeNo = num(one(cf, 1));
    const any = fields(one(cf, 2) || new Uint8Array());
    const p = fields(one(any, 2) || new Uint8Array());
    const type = TYPES[typeNo] || `Unknown(${typeNo})`;
    const permissionId = num(one(cf, 5)); // 多签权限：本项目从不使用，签名页面见到就拦下
    const addr = (no) => { const v = one(p, no); return v ? toAddress(v) : null; };
    if (typeNo === 1) return { type, permissionId, owner: addr(1), to: addr(2), amount: num(one(p, 3)) };
    if (typeNo === 31) {
      const data = one(p, 4) || new Uint8Array();
      const dh = hex.encode(data);
      let to = null, amount = null, method = dh.slice(0, 8);
      if (method === TRANSFER_SELECTOR && dh.length === 8 + 128) {
        to = toAddress(hex.decode('41' + dh.slice(8 + 24, 8 + 64)));
        amount = Number(BigInt('0x' + dh.slice(8 + 64)));
      }
      return { type, permissionId, owner: addr(1), contract: addr(2), callValue: num(one(p, 3)), method, to, amount };
    }
    if (typeNo === 57 || typeNo === 58) return { type, permissionId, owner: addr(1), resource: num(one(p, 2)) === 1 ? 'ENERGY' : 'BANDWIDTH', amount: num(one(p, 3)), to: addr(4), lock: num(one(p, 5)) === 1 };
    return { type, permissionId };
  });
  return { txId: txIdOf(rawHex), expiration: num(one(f, 8)), timestamp: num(one(f, 14)), feeLimit: num(one(f, 18)), contracts };
}
export const txIdOf = (rawHex) => hex.encode(sha256(hex.decode(rawHex)));

// ---------- 编码 ----------
/** 改交易的过期时间（字段 8），其他字段原样保留。TronGrid 默认只给 60 秒，签名需要更长的时间 */
export function setExpiration(rawHex, expirationMs) {
  const b = hex.decode(rawHex);
  const out = [];
  let done = false;
  for (const x of fields(b)) {
    if (x.no === 8 && !done) { out.push(...writeVarint((8 << 3) | 0), ...writeVarint(expirationMs)); done = true; }
    else out.push(...b.slice(x.start, x.end));
  }
  if (!done) out.push(...writeVarint((8 << 3) | 0), ...writeVarint(expirationMs));
  return hex.encode(Uint8Array.from(out));
}
/** 已签名的完整交易：Transaction { raw_data = 1, signature = 2 }，用于 /wallet/broadcasthex */
export function encodeSigned(rawHex, signatureHex) {
  const raw = hex.decode(rawHex), sig = hex.decode(signatureHex);
  return hex.encode(Uint8Array.from([0x0a, ...writeVarint(raw.length), ...raw, 0x12, ...writeVarint(sig.length), ...sig]));
}

// ---------- 构造（只用于本地替身和测试；正式环境的交易由 TronGrid 构造） ----------
const lenField = (no, bytes) => [...writeVarint((no << 3) | 2), ...writeVarint(bytes.length), ...bytes];
const intField = (no, v) => [...writeVarint((no << 3) | 0), ...writeVarint(v)];
const NAMES = { TransferContract: 1, TriggerSmartContract: 31, DelegateResourceContract: 57, UnDelegateResourceContract: 58 };
/** 按 TRON 的 protobuf 格式生成交易原文。c = { type, owner, to, amount, contract? } */
export function encodeRaw(c, { expiration = Date.now() + 60_000, timestamp = Date.now(), feeLimit = 0, refBlock = 'abcd', refHash = '0102030405060708' } = {}) {
  const addr = (a) => Array.from(fromAddress(a));
  let p;
  if (c.type === 'TransferContract') p = [...lenField(1, addr(c.owner)), ...lenField(2, addr(c.to)), ...intField(3, c.amount)];
  else if (c.type === 'TriggerSmartContract') {
    const data = hex.decode(TRANSFER_SELECTOR + hex.encode(fromAddress(c.to)).slice(2).padStart(64, '0') + BigInt(c.amount).toString(16).padStart(64, '0'));
    p = [...lenField(1, addr(c.owner)), ...lenField(2, addr(c.contract)), ...lenField(4, Array.from(data))];
  } else p = [...lenField(1, addr(c.owner)), ...intField(2, 1), ...intField(3, c.amount), ...lenField(4, addr(c.to))];
  const typeUrl = Array.from(new TextEncoder().encode(`type.googleapis.com/protocol.${c.type}`));
  const contract = [...intField(1, NAMES[c.type]), ...lenField(2, [...lenField(1, typeUrl), ...lenField(2, p)])];
  const raw = [...lenField(1, Array.from(hex.decode(refBlock))), ...lenField(4, Array.from(hex.decode(refHash))), ...intField(8, expiration), ...lenField(11, contract), ...intField(14, timestamp), ...(feeLimit ? intField(18, feeLimit) : [])];
  return hex.encode(Uint8Array.from(raw));
}
