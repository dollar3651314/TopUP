// 研发写：txcodec 的严格解码（每一层白名单、同号字段只许一次、线型对得上、地址 21 字节 0x41 开头）。
// 补 test/qa-txcodec-dup.test.js 之外的边界：真实交易的字段 5（Permission_id）、借能量的字段 5 / 6 只出现一次照常解码；
// 线型不对、type_url 和类型对不上、超出安全整数、lock 非 0 非 1、调用数据里地址格前 12 字节不是 0 都不认。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import { createBase58check, hex } from '@scure/base';
import { decodeRaw, strictFields } from '../server/pay/txcodec.js';
import { checkStep } from '../server/pay/verify.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/tron-txs.json', import.meta.url)));
const b58c = createBase58check(sha256);
const U = 1_000_000;
const NOW = Date.now();
const randAddr = () => b58c.encode(Uint8Array.from([0x41, ...randomBytes(20)]));
const HOT = randAddr(), CUSTOMER = randAddr(), PAYEE = randAddr(), USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const RULES = { hot: HOT, usdt: USDT };

const varint = (x) => { const out = []; let v = BigInt(x); do { let c = Number(v & 0x7fn); v >>= 7n; if (v) c |= 0x80; out.push(c); } while (v); return out; };
const L = (no, bytes) => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
const I = (no, v) => [...varint((no << 3) | 0), ...varint(v)];
const A = (no, t) => L(no, Array.from(b58c.decode(t)));
const TYPES = { TransferContract: 1, TriggerSmartContract: 31, DelegateResourceContract: 57, UnDelegateResourceContract: 58 };
function rawOf({ type, param, typeUrl = `type.googleapis.com/protocol.${type}`, contractExtra = [] }) {
  const any = [...L(1, Array.from(Buffer.from(typeUrl))), ...L(2, param)];
  const contract = [...I(1, TYPES[type]), ...L(2, any), ...contractExtra];
  return hex.encode(Uint8Array.from([...L(1, [0x6f, 0x3b]), ...L(4, Array.from(randomBytes(8))), ...I(8, NOW + 60_000), ...L(11, contract), ...I(14, NOW)]));
}
const delegateParam = (extra = []) => [...A(1, HOT), ...I(2, 1), ...I(3, 100 * U), ...A(4, CUSTOMER), ...extra];
const feeParam = (extra = []) => [...A(1, HOT), ...A(2, CUSTOMER), ...I(3, U), ...extra];
const delegate = (raw) => checkStep({ kind: 'delegate', rawHex: raw }, { to: CUSTOMER }, RULES, NOW);
const fee = (raw) => checkStep({ kind: 'fee_trx', rawHex: raw }, { to: CUSTOMER }, RULES, NOW);

test('真实主网交易（含 Contract 字段 5 Permission_id）照常解码', () => {
  for (const k of Object.keys(fx)) assert.equal(decodeRaw(fx[k].raw_data_hex).txId, fx[k].txID, k);
  assert.equal(decodeRaw(fx.DelegateResourceContract.raw_data_hex).contracts[0].permissionId, 3);
});

test('借能量：字段 5 / 6 只出现一次照常解码；不锁定通过，锁定（含 lock = 2）拦下', () => {
  const d = decodeRaw(rawOf({ type: 'DelegateResourceContract', param: delegateParam([...I(5, 0), ...I(6, 0)]) })).contracts[0];
  assert.deepEqual([d.lock, d.lockPeriod, d.to], [false, 0, CUSTOMER]);
  assert.ok(delegate(rawOf({ type: 'DelegateResourceContract', param: delegateParam([...I(5, 0)]) })).ok);
  assert.equal(delegate(rawOf({ type: 'DelegateResourceContract', param: delegateParam([...I(5, 1), ...I(6, 28_800)]) })).ok, false);
  assert.equal(delegate(rawOf({ type: 'DelegateResourceContract', param: delegateParam([...I(5, 2)]) })).ok, false);
});

test('Contract 字段 5 出现一次：为 0 照常通过，非 0 按多签拦下', () => {
  assert.ok(fee(rawOf({ type: 'TransferContract', param: feeParam(), contractExtra: I(5, 0) })).ok);
  assert.equal(fee(rawOf({ type: 'TransferContract', param: feeParam(), contractExtra: I(5, 2) })).ok, false);
});

test('线型不对（金额写成长度前缀）不认', () => {
  const r = fee(rawOf({ type: 'TransferContract', param: [...A(1, HOT), ...A(2, CUSTOMER), ...L(3, [1, 2, 3])] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /无法解码.*wire type/);
});

test('type_url 和交易类型对不上不认', () => {
  assert.equal(fee(rawOf({ type: 'TransferContract', param: feeParam(), typeUrl: 'type.googleapis.com/protocol.TriggerSmartContract' })).ok, false);
});

test('整数超出安全整数范围不认（java-tron 会截断成别的值）', () => {
  assert.equal(fee(rawOf({ type: 'TransferContract', param: [...A(1, HOT), ...A(2, CUSTOMER), ...I(3, 2n ** 64n + 1n)] })).ok, false);
});

test('地址长度不是 21 字节不认', () => {
  assert.equal(fee(rawOf({ type: 'TransferContract', param: [...A(1, HOT), ...L(2, [0x41, ...randomBytes(19)]), ...I(3, U)] })).ok, false);
});

test('USDT 调用数据里地址那一格前 12 字节不是 0：解不出收款地址，核对不通过', () => {
  const data = hex.decode('a9059cbb' + 'ff'.repeat(12) + hex.encode(b58c.decode(PAYEE)).slice(2) + BigInt(100 * U).toString(16).padStart(64, '0'));
  const raw = rawOf({ type: 'TriggerSmartContract', param: [...A(1, HOT), ...A(2, USDT), ...L(4, Array.from(data))] });
  assert.equal(decodeRaw(raw).contracts[0].to, null);
  assert.equal(checkStep({ kind: 'withdraw', rawHex: raw }, { to: PAYEE, amount: 100 * U }, RULES, NOW).ok, false);
});

test('strictFields：重复、白名单外、线型不对都抛出；repeated 字段收成数组', () => {
  const b = Uint8Array.from([...I(1, 1), ...L(2, [1]), ...L(2, [2])]);
  assert.throws(() => strictFields(b, { 1: 0, 2: 2 }, 'x'), /duplicate field 2/);
  assert.deepEqual(strictFields(b, { 1: 0, 2: 2 }, 'x', [2]).get(2).map((v) => v[0]), [1, 2]);
  assert.throws(() => strictFields(b, { 1: 0 }, 'x'), /unexpected field 2/);
  assert.throws(() => strictFields(b, { 1: 2, 2: 2 }, 'x'), /field 1 has wire type 0/);
});
