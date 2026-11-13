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
/**
 * 严格读一层字段：只许出现 allowed 里的字段号（{ 字段号: 线型 }），线型要对得上，每个字段号最多一次（repeated 里列出的除外）。
 * 返回 Map(字段号 → 值)；repeated 字段的值是数组。不符合就抛出。
 * 为什么：protobuf 同一个字段号可以出现多次，java-tron 取最后一个，"取第一个"的解码会让页面核对一组、链上执行另一组；
 * java-tron 遇到线型不对的字段当作未知字段跳过（值留默认），所以线型不对、白名单外的字段也一律不认。
 */
export function strictFields(bytes, allowed, where, repeated = []) {
  const m = new Map();
  for (const f of fields(bytes)) {
    if (!(f.no in allowed)) throw new Error(`${where}: unexpected field ${f.no}`);
    if (allowed[f.no] !== f.wire) throw new Error(`${where}: field ${f.no} has wire type ${f.wire}`);
    if (repeated.includes(f.no)) { if (!m.has(f.no)) m.set(f.no, []); m.get(f.no).push(f.value); continue; }
    if (m.has(f.no)) throw new Error(`${where}: duplicate field ${f.no}`);
    m.set(f.no, f.value);
  }
  return m;
}
// 整数字段：超出安全整数范围的一律不认（java-tron 按 int64 / int32 截断，和这里读出的值可能不同）
const num = (v, where = 'field') => {
  if (v === undefined) return 0;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${where}: integer out of range`);
  return Number(v);
};
// 地址字段：必须 21 字节、0x41 开头
const addrOf = (v, where) => {
  if (v === undefined) return null;
  if (v.length !== 21 || v[0] !== 0x41) throw new Error(`${where}: address must be 21 bytes starting with 0x41`);
  return toAddress(v);
};
const L = 2, V = 0; // 线型：长度前缀、整数
// 交易原文：1 ref_block_bytes、4 ref_block_hash、8 expiration、11 contract（可多个）、14 timestamp、18 fee_limit；别的（memo、auths、scripts…）不认
const RAW_FIELDS = { 1: L, 4: L, 8: V, 11: L, 14: V, 18: V };
// Contract：1 type、2 parameter（Any）、5 Permission_id（真实交易里会出现，见 fixtures）
const CONTRACT_FIELDS = { 1: V, 2: L, 5: V };
const ANY_FIELDS = { 1: L, 2: L };
// 每种交易的参数白名单
const PARAM_FIELDS = {
  1: { 1: L, 2: L, 3: V }, // TransferContract：owner、to、amount
  31: { 1: L, 2: L, 3: V, 4: L, 5: V, 6: V }, // TriggerSmartContract：owner、contract、call_value、data、call_token_value、token_id
  57: { 1: L, 2: V, 3: V, 4: L, 5: V, 6: V }, // DelegateResourceContract：owner、resource、balance、receiver、lock、lock_period
  58: { 1: L, 2: V, 3: V, 4: L }, // UnDelegateResourceContract：owner、resource、balance、receiver
};

// ---------- 解码 ----------
/**
 * 解码交易原文（raw_data_hex），每一层按白名单严格读（strictFields），不符合就抛出。返回：
 * { txId, expiration, timestamp, feeLimit, contracts: [{ type, owner, to, amount, contract?, resource? }] }
 * USDT 转账时 to、amount 是从合约调用数据里解出来的收款地址和金额；contract 是被调用的合约地址。
 */
export function decodeRaw(rawHex) {
  const b = hex.decode(rawHex);
  const f = strictFields(b, RAW_FIELDS, 'raw_data', [11]);
  const contracts = (f.get(11) || []).map((cv) => {
    const cf = strictFields(cv, CONTRACT_FIELDS, 'contract');
    const typeNo = num(cf.get(1), 'contract.type');
    const type = TYPES[typeNo] || `Unknown(${typeNo})`;
    const permissionId = num(cf.get(5), 'contract.Permission_id'); // 多签权限：本项目从不使用，签名页面见到就拦下
    if (!PARAM_FIELDS[typeNo]) return { type, permissionId };
    const any = strictFields(cf.get(2) || new Uint8Array(), ANY_FIELDS, 'parameter');
    if (new TextDecoder().decode(any.get(1) || new Uint8Array()) !== `type.googleapis.com/protocol.${type}`) throw new Error('parameter: type_url does not match contract type');
    const p = strictFields(any.get(2) || new Uint8Array(), PARAM_FIELDS[typeNo], type);
    const addr = (no) => addrOf(p.get(no), `${type}.${no}`);
    const int = (no) => num(p.get(no), `${type}.${no}`);
    if (typeNo === 1) return { type, permissionId, owner: addr(1), to: addr(2), amount: int(3) };
    if (typeNo === 31) {
      const data = p.get(4) || new Uint8Array();
      const dh = hex.encode(data);
      let to = null, amount = null, method = dh.slice(0, 8);
      // transfer(address,uint256)：地址那一格前 12 字节必须是 0；金额超出安全整数的不认
      if (method === TRANSFER_SELECTOR && dh.length === 8 + 128 && /^0{24}$/.test(dh.slice(8, 8 + 24))) {
        to = toAddress(hex.decode('41' + dh.slice(8 + 24, 8 + 64)));
        amount = num(BigInt('0x' + dh.slice(8 + 64)), 'transfer amount');
      }
      return { type, permissionId, owner: addr(1), contract: addr(2), callValue: int(3), callTokenValue: int(5), tokenId: int(6), method, to, amount };
    }
    // lock 是 bool：java-tron 非 0 即 true
    return { type, permissionId, owner: addr(1), resource: int(2) === 1 ? 'ENERGY' : 'BANDWIDTH', amount: int(3), to: addr(4), lock: int(5) !== 0, lockPeriod: int(6) };
  });
  return { txId: txIdOf(rawHex), expiration: num(f.get(8), 'expiration'), timestamp: num(f.get(14), 'timestamp'), feeLimit: num(f.get(18), 'fee_limit'), contracts };
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
