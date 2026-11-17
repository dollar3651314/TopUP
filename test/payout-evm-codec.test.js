// 测试先写（第 3 批）：以太坊、BSC 批量打款交易的解码核对（浏览器签名页面用）——"页面核对的就是链上执行的"。
// 和 TRON 的 txcodec.strictFields 同一个要求：页面自己解码服务器给的交易原文，只认唯一一种写法，任何"解码器之间可能读出不同结果"的写法都拒签。
//
// 期望的新模块 server/wallet/evm-payout-codec.js（服务器和签名页面共用，所以不能用 Node 专属的东西：不 import node:*、不用 Buffer）：
//   decodeUnsignedLegacyTx(rawHex) → { nonce, gasPrice, gas, to, value, data, chainId }（数字是 bigint，to 是 EIP-55，data 是 0x 小写十六进制）
//       只认 EIP-155 未签名旧式交易：RLP 列表正好 9 项、第 8、9 项是空串；整数最短编码（没有前导 0，单字节 < 0x80 不加前缀）；
//       长度前缀最短；列表后面不许多字节；to 必须 20 字节；EIP-1559 / EIP-2930（0x01、0x02 开头）不认
//   decodePayCall(dataHex) → { token, batchId, items: [{ to, amount }] }
//       BatchPayout.pay(address token, bytes32 batchId, address[] to, uint256[] amount) 的调用数据；只认标准布局：
//       两个数组的偏移必须是 0x80 和紧跟第一个数组之后，长度相等，结尾不许多字节，地址那一格高 12 字节必须是 0
//   decodeApproveCall(dataHex) → { spender, amount }（approve(address,uint256)，同样严格）
//   checkPayoutTx(rawHex, expect) → 解码结果；不对就抛出 Error，e.code 是下面之一：
//       wrong_chain、wrong_contract、value_nonzero、wrong_method、wrong_token、wrong_batch、item_mismatch、fee_too_high、noncanonical
//       expect = { chainId, contract（BatchPayout 地址）, token, batchId, items: [{ to, amount }]（按审核通过的顺序）, maxFeeWei }
//   checkApproveTx(rawHex, expect) → 同上；expect = { chainId, token, spender（BatchPayout）, amount, maxFeeWei }；不对抛出（wrong_spender、amount_mismatch 等）
//   attachSignature(rawHex, sigHex) → { raw, hash, from }：把浏览器交回的 65 字节签名（r ‖ s ‖ recovery）套到服务器存的未签名原文上，
//       算出签名人；服务器只广播自己存的那份原文 + 签名，签名人不是该链热钱包就拒（wrong_signer，见 payout-flow.test.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { rlp, selector } from '../server/wallet/evm-tx.js';
import { toChecksumAddress } from '../server/wallet/create2.js';

const MOD = new URL('../server/wallet/evm-payout-codec.js', import.meta.url);
const load = () => import(MOD.href);

const hex = (b) => Buffer.from(b).toString('hex');
const rnd = () => toChecksumAddress('0x' + hex(randomBytes(20)));
const word = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uw = (n) => BigInt(n).toString(16).padStart(64, '0');
const intB = (v) => { const n = BigInt(v); if (n === 0n) return Buffer.alloc(0); const s = n.toString(16); return Buffer.from(s.length % 2 ? '0' + s : s, 'hex'); };
const hb = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');

const PAYOUT = rnd(), TOKEN = rnd(), HOT_KEY = randomBytes(32);
const HOT = toChecksumAddress('0x' + hex(keccak_256(secp256k1.getPublicKey(HOT_KEY, false).slice(1))).slice(24));
const BATCH = '0x' + hex(randomBytes(32));
const ITEMS = [{ to: rnd(), amount: 1_500_000n }, { to: rnd(), amount: 2_000_000_000n }, { to: rnd(), amount: 7n }];
const PAY_SIG = 'pay(address,bytes32,address[],uint256[])';

/** 标准布局的 pay 调用数据（独立实现，不用被测模块） */
function payData(token, batchId, items, { offA = 128, offB = null, extra = '' } = {}) {
  const n = items.length;
  const a = uw(n) + items.map((i) => word(i.to)).join('');
  const b = uw(n) + items.map((i) => uw(i.amount)).join('');
  const ob = offB ?? offA + 32 * (1 + n);
  return '0x' + selector(PAY_SIG) + word(token) + word(batchId) + uw(offA) + uw(ob) + a + b + extra;
}
const approveData = (spender, amount) => '0x' + selector('approve(address,uint256)') + word(spender) + uw(amount);
/** 未签名的 EIP-155 旧式交易原文 */
function unsigned({ nonce = 5, gasPrice = 2_000_000_000n, gas = 400_000, to = PAYOUT, value = 0, data, chainId = 1 }) {
  return '0x' + hex(rlp([intB(nonce), intB(gasPrice), intB(gas), hb(to), intB(value), hb(data), intB(chainId), Buffer.alloc(0), Buffer.alloc(0)]));
}
const EXPECT = { chainId: 1, contract: PAYOUT, token: TOKEN, batchId: BATCH, items: ITEMS, maxFeeWei: 10n ** 16n };
const good = () => unsigned({ data: payData(TOKEN, BATCH, ITEMS) });
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code || e.message; } return 'passed'; };

test('模块存在，且能在浏览器里用：不 import node:*、不用 Buffer（签名页面和服务器共用同一份）', () => {
  assert.ok(existsSync(MOD), '缺少 server/wallet/evm-payout-codec.js');
  const src = readFileSync(MOD, 'utf8');
  assert.doesNotMatch(src, /from ['"]node:/);
  assert.doesNotMatch(src, /\bBuffer\b/);
  assert.doesNotMatch(src, /\brequire\(/);
});

test('签名页面用的就是这份解码：打款签名脚本 import evm-payout-codec，且不自己另写解码', () => {
  const dir = new URL('../site/src/scripts/', import.meta.url);
  const files = ['admin-payout.ts', 'admin-pay-real.ts'].map((f) => new URL(f, dir)).filter((u) => existsSync(u));
  const src = files.map((u) => readFileSync(u, 'utf8')).join('\n');
  assert.ok(/server\/wallet\/evm-payout-codec\.js/.test(src), '签名页面没有 import server/wallet/evm-payout-codec.js');
  assert.ok(/checkPayoutTx/.test(src), '签名页面没有调用 checkPayoutTx');
  assert.ok(/checkApproveTx/.test(src), '改授权额度的签名没有调用 checkApproveTx');
});

test('对照组：标准的 pay 交易解码出来的就是输入；checkPayoutTx 通过', async () => {
  const c = await load();
  const tx = c.decodeUnsignedLegacyTx(good());
  assert.equal(tx.chainId, 1n);
  assert.equal(tx.to, PAYOUT);
  assert.equal(tx.value, 0n);
  assert.equal(tx.nonce, 5n);
  const call = c.decodePayCall(tx.data);
  assert.equal(call.token, TOKEN);
  assert.equal(call.batchId, BATCH);
  assert.deepEqual(call.items.map((i) => [i.to, BigInt(i.amount)]), ITEMS.map((i) => [i.to, i.amount]));
  assert.doesNotThrow(() => c.checkPayoutTx(good(), EXPECT));
  // 期望里的金额也可以是字符串（接口里一律是字符串）
  assert.doesNotThrow(() => c.checkPayoutTx(good(), { ...EXPECT, items: ITEMS.map((i) => ({ to: i.to.toLowerCase(), amount: String(i.amount) })) }));
});

test('改一笔金额、换一个收款人、多一笔、少一笔、顺序调换：item_mismatch', async () => {
  const c = await load();
  const v = (items) => codeOf(() => c.checkPayoutTx(unsigned({ data: payData(TOKEN, BATCH, items) }), EXPECT));
  assert.equal(v([ITEMS[0], { ...ITEMS[1], amount: ITEMS[1].amount + 1n }, ITEMS[2]]), 'item_mismatch');
  assert.equal(v([ITEMS[0], { ...ITEMS[1], to: rnd() }, ITEMS[2]]), 'item_mismatch');
  assert.equal(v([...ITEMS, { to: rnd(), amount: 1n }]), 'item_mismatch');
  assert.equal(v(ITEMS.slice(0, 2)), 'item_mismatch');
  assert.equal(v([ITEMS[1], ITEMS[0], ITEMS[2]]), 'item_mismatch');
});

test('不是 BatchPayout、链 ID 不对（以太坊签的拿到 BSC 重放）、带了原生币、不是 pay、代币或批次号不对：拒签', async () => {
  const c = await load();
  const transfer = '0x' + selector('transfer(address,uint256)') + word(rnd()) + uw(1);
  assert.equal(codeOf(() => c.checkPayoutTx(unsigned({ to: TOKEN, data: transfer }), EXPECT)), 'wrong_contract');
  assert.equal(codeOf(() => c.checkPayoutTx(unsigned({ chainId: 56, data: payData(TOKEN, BATCH, ITEMS) }), EXPECT)), 'wrong_chain');
  assert.equal(codeOf(() => c.checkPayoutTx(unsigned({ value: 1, data: payData(TOKEN, BATCH, ITEMS) }), EXPECT)), 'value_nonzero');
  const setPayer = '0x' + selector('setPayer(address,bool)') + word(rnd()) + uw(1);
  assert.equal(codeOf(() => c.checkPayoutTx(unsigned({ data: setPayer }), EXPECT)), 'wrong_method');
  assert.equal(codeOf(() => c.checkPayoutTx(unsigned({ data: payData(rnd(), BATCH, ITEMS) }), EXPECT)), 'wrong_token');
  assert.equal(codeOf(() => c.checkPayoutTx(unsigned({ data: payData(TOKEN, '0x' + hex(randomBytes(32)), ITEMS) }), EXPECT)), 'wrong_batch');
});

test('网络费上限：gas × gasPrice 超过 maxFeeWei 拒签（服务器不能借打款塞一笔天价手续费）', async () => {
  const c = await load();
  const raw = unsigned({ gas: 10_000_000, gasPrice: 10n ** 12n, data: payData(TOKEN, BATCH, ITEMS) });
  assert.equal(codeOf(() => c.checkPayoutTx(raw, EXPECT)), 'fee_too_high');
});

test('调用数据只认标准布局：偏移指到别处的"第二套数组"、两个数组共用、结尾多字节、地址高位不为 0、长度不等，一律拒签', async () => {
  const c = await load();
  const n = ITEMS.length;
  const other = [{ to: rnd(), amount: 999_000_000n }, ITEMS[1], ITEMS[2]];
  // 第二套数组放在后面，偏移指过去：只按"固定位置"读的解码器看到 ITEMS，合约按偏移执行 other
  const std = payData(TOKEN, BATCH, ITEMS);
  const tailA = uw(n) + other.map((i) => word(i.to)).join('');
  const tailB = uw(n) + other.map((i) => uw(i.amount)).join('');
  const lenStd = (std.length - 2 - 8) / 2 - 32 * 4; // 标准布局里两段数组的字节数
  const hijack = '0x' + selector(PAY_SIG) + word(TOKEN) + word(BATCH) + uw(128 + lenStd) + uw(128 + lenStd + 32 * (1 + n))
    + std.slice(2 + 8 + 64 * 4) + tailA + tailB;
  assert.throws(() => c.decodePayCall(hijack));
  assert.notEqual(codeOf(() => c.checkPayoutTx(unsigned({ data: hijack }), EXPECT)), 'passed');
  // to 和 amount 指到同一段
  assert.throws(() => c.decodePayCall(payData(TOKEN, BATCH, ITEMS, { offB: 128 })));
  // 结尾多 32 字节
  assert.throws(() => c.decodePayCall(std + uw(1)));
  // 地址那一格高 12 字节不是 0（Solidity 会回滚或截断，两种解码器读法不同）
  const dirty = std.slice(0, 2 + 8 + 64 * 4 + 64) + 'ff' + std.slice(2 + 8 + 64 * 4 + 64 + 2);
  assert.throws(() => c.decodePayCall(dirty));
  // 长度不等
  const uneven = '0x' + selector(PAY_SIG) + word(TOKEN) + word(BATCH) + uw(128) + uw(128 + 32 * (1 + n))
    + uw(n) + ITEMS.map((i) => word(i.to)).join('') + uw(n - 1) + ITEMS.slice(0, -1).map((i) => uw(i.amount)).join('');
  assert.throws(() => c.decodePayCall(uneven));
  // 截断
  assert.throws(() => c.decodePayCall(std.slice(0, -2)));
});

test('交易原文只认 EIP-155 未签名旧式交易的唯一写法：多字段、少字段、尾巴多字节、整数前导 0、已签名、类型化交易一律不认', async () => {
  const c = await load();
  const data = hb(payData(TOKEN, BATCH, ITEMS));
  const base = [intB(5), intB(2_000_000_000n), intB(400_000), hb(PAYOUT), intB(0), data, intB(1), Buffer.alloc(0), Buffer.alloc(0)];
  const enc = (items) => '0x' + hex(rlp(items));
  assert.doesNotThrow(() => c.decodeUnsignedLegacyTx(enc(base)));
  assert.throws(() => c.decodeUnsignedLegacyTx(enc([...base, Buffer.alloc(0)])), /./, '10 项');
  assert.throws(() => c.decodeUnsignedLegacyTx(enc(base.slice(0, 6))), /./, '6 项（没有链 ID，不防重放）');
  assert.throws(() => c.decodeUnsignedLegacyTx(enc(base) + '00'), /./, '尾巴多一个字节');
  assert.throws(() => c.decodeUnsignedLegacyTx(enc([Buffer.from([0, 5]), ...base.slice(1)])), /./, 'nonce 前导 0');
  // 单字节 0x05 写成 0x81 0x05（不是最短编码）：手工拼列表
  const body = '8105' + base.slice(1).map((x) => hex(rlp(x))).join('');
  const len = body.length / 2;
  const listPrefix = len < 56 ? (0xc0 + len).toString(16) : (0xf7 + intB(len).length).toString(16) + hex(intB(len));
  assert.throws(() => c.decodeUnsignedLegacyTx('0x' + listPrefix + body), /./, '单字节加了前缀');
  assert.throws(() => c.decodeUnsignedLegacyTx(enc([...base.slice(0, 7), intB(1), intB(2)])), /./, '已签名（r、s 不为空）');
  assert.throws(() => c.decodeUnsignedLegacyTx(enc([...base.slice(0, 3), Buffer.alloc(19, 1), ...base.slice(4)])), /./, 'to 不是 20 字节');
  assert.throws(() => c.decodeUnsignedLegacyTx('0x02' + enc(base).slice(2)), /./, 'EIP-1559');
  assert.throws(() => c.decodeUnsignedLegacyTx('0x01' + enc(base).slice(2)), /./, 'EIP-2930');
  // 长度前缀不是最短：把 data 的前缀从 0xb8 xx 写成 0xb9 00 xx
  const raw = enc(base);
  const i = raw.indexOf('b8' + (data.length).toString(16).padStart(2, '0'));
  if (i > 0) {
    const bad = raw.slice(0, i) + 'b900' + raw.slice(i + 2);
    assert.throws(() => c.decodeUnsignedLegacyTx(bad), /./, '长度前缀不是最短');
  }
});

test('改授权额度的交易：approve(BatchPayout, 数额) 才通过；spender 不对、数额不对、发给了别的合约都拒签', async () => {
  const c = await load();
  const ex = { chainId: 1, token: TOKEN, spender: PAYOUT, amount: 10_000_000_000n, maxFeeWei: 10n ** 16n };
  const ok = unsigned({ to: TOKEN, gas: 60_000, data: approveData(PAYOUT, ex.amount) });
  assert.doesNotThrow(() => c.checkApproveTx(ok, ex));
  assert.deepEqual(Object.values(c.decodeApproveCall(approveData(PAYOUT, 0n))).map(String), [PAYOUT, '0']);
  assert.doesNotThrow(() => c.checkApproveTx(unsigned({ to: TOKEN, gas: 60_000, data: approveData(PAYOUT, 0n) }), { ...ex, amount: 0n }), '以太坊第 1 笔：归零');
  assert.throws(() => c.checkApproveTx(unsigned({ to: TOKEN, gas: 60_000, data: approveData(rnd(), ex.amount) }), ex), /./, 'spender 不对');
  assert.throws(() => c.checkApproveTx(unsigned({ to: TOKEN, gas: 60_000, data: approveData(PAYOUT, ex.amount + 1n) }), ex), /./, '数额不对');
  assert.throws(() => c.checkApproveTx(unsigned({ to: rnd(), gas: 60_000, data: approveData(PAYOUT, ex.amount) }), ex), /./, '发给了别的合约');
  assert.throws(() => c.checkApproveTx(unsigned({ to: TOKEN, gas: 60_000, data: approveData(PAYOUT, ex.amount) + '00' }), ex), /./, '尾巴多字节');
  assert.throws(() => c.checkApproveTx(unsigned({ to: TOKEN, chainId: 56, gas: 60_000, data: approveData(PAYOUT, ex.amount) }), ex), /./, '链 ID 不对');
});

test('attachSignature：签名套在服务器存的原文上，签名人算得出来；签的是别的原文时签名人对不上', async () => {
  const c = await load();
  const raw = good();
  const sighash = keccak_256(hb(raw));
  const s = secp256k1.sign(sighash, HOT_KEY, { lowS: true });
  const sig = s.r.toString(16).padStart(64, '0') + s.s.toString(16).padStart(64, '0') + s.recovery.toString(16).padStart(2, '0');
  const out = c.attachSignature(raw, '0x' + sig);
  assert.equal(out.from, HOT);
  assert.match(out.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(out.hash, '0x' + hex(keccak_256(hb(out.raw))));
  // 页面签了另一份原文（例如被换过的），交回的签名套在服务器的原文上算出来的不是热钱包
  const other = unsigned({ data: payData(TOKEN, BATCH, ITEMS.slice(0, 1)) });
  const s2 = secp256k1.sign(keccak_256(hb(other)), HOT_KEY, { lowS: true });
  const sig2 = s2.r.toString(16).padStart(64, '0') + s2.s.toString(16).padStart(64, '0') + s2.recovery.toString(16).padStart(2, '0');
  assert.notEqual(c.attachSignature(raw, '0x' + sig2).from, HOT);
  // 高 s（可塑签名）不收
  const highS = (secp256k1.CURVE.n - s.s).toString(16).padStart(64, '0');
  assert.throws(() => c.attachSignature(raw, '0x' + s.r.toString(16).padStart(64, '0') + highS + (1 - s.recovery).toString(16).padStart(2, '0')));
});
