// 测试先写（测试会话）：第 0 批浏览器签名页面的交易核对（server/pay/verify.js 的 checkStep，解码用 server/pay/txcodec.js 的 decodeRaw）
// 不能被"核对一组、执行另一组"骗过。
//   protobuf 里同一个字段号可以出现多次：txcodec 现在取第一个，java-tron 执行时取最后一个。服务器（或被攻破的服务器、被劫持的 TronGrid）
//   给页面一份原文：前面放页面期望的值（收款地址、金额、fee_limit……），后面再塞一个同号字段放真正要执行的值，页面核对通过、管理员签名，
//   链上按后面那个执行。另外 TriggerSmartContract 的字段 5 / 6（call_token_value、token_id）会顺带转走 TRC-10 代币，未知字段、
//   地址第一个字节不是 0x41 也不该放过。
// 期望：这些原文 checkStep 一律不通过（ok = false）；正常的原文照常通过（对照组）。
// 做法建议（给研发）：解码时每一层（交易原文、Contract、参数）按白名单逐个字段读，同号字段出现第二次、白名单外的字段、地址不是 21 字节且 0x41 开头都直接报错；
//   或者核对通过后按解码出来的值本地重新编码一份原文，和服务器给的逐字节比较，不一致就拒签（两种做法这里的用例都能满足）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import { createBase58check, hex } from '@scure/base';
import { checkStep } from '../server/pay/verify.js';

const b58c = createBase58check(sha256);
const U = 1_000_000;
const NOW = Date.now();
const addr21 = (t) => Array.from(b58c.decode(t));
const randAddr = () => b58c.encode(Uint8Array.from([0x41, ...randomBytes(20)]));
const HOT = randAddr(), COLD = randAddr(), USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', PAYEE = randAddr(), ATTACKER = randAddr(), CUSTOMER = randAddr();
const RULES = { hot: HOT, cold: COLD, usdt: USDT };

// ---------- 手工拼原文（可以重复字段、加字段） ----------
const varint = (x) => { const out = []; let v = BigInt(x); do { let c = Number(v & 0x7fn); v >>= 7n; if (v) c |= 0x80; out.push(c); } while (v); return out; };
const L = (no, bytes) => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
const I = (no, v) => [...varint((no << 3) | 0), ...varint(v)];
const A = (no, t, prefix = 0x41) => L(no, [prefix, ...addr21(t).slice(1)]);
const transferData = (to, amount) => Array.from(hex.decode('a9059cbb' + hex.encode(b58c.decode(to)).slice(2).padStart(64, '0') + BigInt(amount).toString(16).padStart(64, '0')));
const TYPES = { TransferContract: 1, TriggerSmartContract: 31, DelegateResourceContract: 57, UnDelegateResourceContract: 58 };
function rawOf({ type, param, contractExtra = [], rawExtra = [], expiration = NOW + 60_000, feeLimit = 0, rawPre = [] }) {
  const any = [...L(1, Array.from(Buffer.from(`type.googleapis.com/protocol.${type}`))), ...L(2, param)];
  const contract = [...I(1, TYPES[type]), ...L(2, any), ...contractExtra];
  return hex.encode(Uint8Array.from([...L(1, [0x6f, 0x3b]), ...L(4, Array.from(randomBytes(8))), ...rawPre, ...I(8, expiration), ...L(11, contract), ...I(14, NOW), ...(feeLimit ? I(18, feeLimit) : []), ...rawExtra]));
}
const step = (kind, rawHex) => ({ kind, rawHex });

// 正常的原文
const withdrawParam = (extra = [], { owner = HOT, contract = USDT, to = PAYEE, amount = 100 * U, ownerPrefix, contractPrefix } = {}) => [...A(1, owner, ownerPrefix), ...A(2, contract, contractPrefix), ...L(4, transferData(to, amount)), ...extra];
const sweepParam = (extra = []) => [...A(1, CUSTOMER), ...A(2, USDT), ...L(4, transferData(HOT, 50 * U)), ...extra];
const feeParam = (extra = [], amount = 1 * U) => [...A(1, HOT), ...A(2, CUSTOMER), ...I(3, amount), ...extra];
const delegateParam = (extra = []) => [...A(1, HOT), ...I(2, 1), ...I(3, 100 * U), ...A(4, CUSTOMER), ...extra];

const WITHDRAW = { kind: 'withdraw', expect: { to: PAYEE, amount: 100 * U } };
const SWEEP = { kind: 'sweep_usdt', expect: { from: CUSTOMER, amount: 50 * U } };
const FEE = { kind: 'fee_trx', expect: { to: CUSTOMER } };
const DELEGATE = { kind: 'delegate', expect: { to: CUSTOMER } };

test('对照组：正常的原文照常核对通过（提币、归集 USDT、补手续费、借能量）', () => {
  assert.ok(checkStep(step('withdraw', rawOf({ type: 'TriggerSmartContract', param: withdrawParam(), feeLimit: 30 * U })), WITHDRAW.expect, RULES, NOW).ok);
  assert.ok(checkStep(step('sweep_usdt', rawOf({ type: 'TriggerSmartContract', param: sweepParam(), feeLimit: 30 * U })), SWEEP.expect, RULES, NOW).ok);
  assert.ok(checkStep(step('fee_trx', rawOf({ type: 'TransferContract', param: feeParam() })), FEE.expect, RULES, NOW).ok);
  assert.ok(checkStep(step('delegate', rawOf({ type: 'DelegateResourceContract', param: delegateParam() })), DELEGATE.expect, RULES, NOW).ok);
});

// 每一条：前面是页面期望的值，后面塞的才是 java-tron 实际执行的值
const ATTACKS = {
  '提币：重复的调用数据（后一个转给攻击者 100 万 USDT）': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam(L(4, transferData(ATTACKER, 1_000_000 * U))), feeLimit: 30 * U }],
  '提币：重复的合约地址（后一个是别的合约）': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam(A(2, randAddr())), feeLimit: 30 * U }],
  '提币：重复的付款地址': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam(A(1, randAddr())), feeLimit: 30 * U }],
  '提币：call_value 先 0 后 1,000 TRX（重复字段 3）': [WITHDRAW, { type: 'TriggerSmartContract', param: [...A(1, HOT), ...A(2, USDT), ...I(3, 0), ...L(4, transferData(PAYEE, 100 * U)), ...I(3, 1000 * U)], feeLimit: 30 * U }],
  '提币：带字段 5 / 6（call_token_value、token_id：顺带转走 TRC-10 代币）': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam([...I(5, 1_000_000), ...I(6, 1_000_001)]), feeLimit: 30 * U }],
  '提币：参数里有未知字段（9）': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam(I(9, 1)), feeLimit: 30 * U }],
  '提币：fee_limit 先 30 TRX 后 15,000 TRX（交易原文里重复字段 18）': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam(), feeLimit: 30 * U, rawExtra: I(18, 15_000 * U) }],
  '提币：过期时间先正常后一年（交易原文里重复字段 8）': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam(), feeLimit: 30 * U, rawExtra: I(8, NOW + 365 * 86_400_000) }],
  '提币：多签权限先 0 后 2（Contract 里重复字段 5 Permission_id）': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam(), feeLimit: 30 * U, contractExtra: [...I(5, 0), ...I(5, 2)] }],
  '提币：付款地址第一个字节不是 0x41': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam([], { ownerPrefix: 0xa0 }), feeLimit: 30 * U }],
  '提币：合约地址第一个字节不是 0x41': [WITHDRAW, { type: 'TriggerSmartContract', param: withdrawParam([], { contractPrefix: 0xa0 }), feeLimit: 30 * U }],
  '归集 USDT：重复的调用数据（后一个转给攻击者，不是热钱包）': [SWEEP, { type: 'TriggerSmartContract', param: sweepParam(L(4, transferData(ATTACKER, 50 * U))), feeLimit: 30 * U }],
  '补手续费：重复的收款地址（后一个是攻击者）': [FEE, { type: 'TransferContract', param: feeParam(A(2, ATTACKER)) }],
  '补手续费：重复的金额（先 1 TRX 后 10,000 TRX）': [FEE, { type: 'TransferContract', param: feeParam(I(3, 10_000 * U)) }],
  '补手续费：参数里有未知字段（9）': [FEE, { type: 'TransferContract', param: feeParam(I(9, 1)) }],
  '借能量：重复的接收地址（后一个是攻击者）': [DELEGATE, { type: 'DelegateResourceContract', param: delegateParam(A(4, ATTACKER)) }],
  '借能量：重复的锁定设置（先不锁后锁定）': [DELEGATE, { type: 'DelegateResourceContract', param: delegateParam([...I(5, 0), ...I(5, 1)]) }],
  '借能量：重复的资源类型（先能量后带宽）': [DELEGATE, { type: 'DelegateResourceContract', param: delegateParam(I(2, 0)) }],
};

for (const [name, [s, spec]] of Object.entries(ATTACKS)) {
  test(`拒绝核对通过：${name}`, () => {
    const r = checkStep(step(s.kind, rawOf(spec)), s.expect, RULES, NOW);
    assert.equal(r.ok, false, `页面会让管理员签这笔：${name}`);
  });
}
