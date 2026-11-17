// 合约充值地址（ETH / BSC）：CREATE2 地址派生、两套测试向量、BSC 18 位小数入账截断。
// 两套向量都在 test/fixtures/wallet/，Foundry（contracts/test/Vectors.t.sol）用真的 BitGo 工厂部署核对同样两份文件：
//   - create2-vectors-topup.json：TopUP 的盐前缀 "topup-deposit"
//   - create2-vectors-upstream.json：上游参考实现的向量（盐前缀不同，以十六进制给出），证明算法和上游完全一致
// 要实现的模块：server/wallet/create2.js、server/wallet/units.js（说明见本批测试先写的提交说明）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/wallet/${name}`, import.meta.url), 'utf8'));
const TOPUP = load('create2-vectors-topup.json');
const UPSTREAM = load('create2-vectors-upstream.json');
const create2 = () => import('../server/wallet/create2.js');
const units = () => import('../server/wallet/units.js');

test('向量文件本身：各 1,000 个，两套用同一组工厂、实现、parent、feeAddress、序号，只有盐前缀不同', () => {
  for (const v of [TOPUP, UPSTREAM]) {
    for (const k of ['parents', 'feeAddresses', 'seqs', 'salts', 'addresses']) assert.equal(v[k].length, 1000, k);
  }
  assert.equal(TOPUP.saltPrefix, 'topup-deposit');
  assert.match(UPSTREAM.saltPrefixHex, /^0x[0-9a-f]+$/);
  assert.deepEqual([TOPUP.factory, TOPUP.implementation, TOPUP.seqs], [UPSTREAM.factory, UPSTREAM.implementation, UPSTREAM.seqs]);
  assert.notDeepEqual(TOPUP.addresses, UPSTREAM.addresses);
});

test('盐的前缀是 topup-deposit；盐 = keccak256(前缀 ‖ uint256 序号)，和 TopUP 向量 1,000 个逐个一致', async () => {
  const { SALT_PREFIX, depositSalt } = await create2();
  assert.equal(SALT_PREFIX, 'topup-deposit');
  TOPUP.seqs.forEach((seq, i) => assert.equal(depositSalt(seq), TOPUP.salts[i], `盐 #${i}（序号 ${seq}）`));
  // 序号可以是 Number 或 bigint，结果一样
  assert.equal(depositSalt(1n), depositSalt(1));
});

test('同一算法换上游的盐前缀：和上游向量 1,000 个逐个一致（证明算法本身和上游一致）', async () => {
  const { depositSalt } = await create2();
  const prefix = Buffer.from(UPSTREAM.saltPrefixHex.slice(2), 'hex');
  UPSTREAM.seqs.forEach((seq, i) => assert.equal(depositSalt(seq, prefix), UPSTREAM.salts[i], `盐 #${i}`));
});

test('转发地址 = BitGo 工厂 CREATE2（0xff 前缀）：两套向量各 1,000 个逐个一致，输出 EIP-55 大小写校验格式', async () => {
  const { forwarderAddress } = await create2();
  for (const [name, v] of [['topup', TOPUP], ['upstream', UPSTREAM]]) {
    v.addresses.forEach((want, i) => {
      const got = forwarderAddress({ factory: v.factory, implementation: v.implementation, parent: v.parents[i], feeAddress: v.feeAddresses[i], salt: v.salts[i] });
      assert.equal(got, want, `${name} 地址 #${i}`);
    });
  }
  // 输入地址大小写不影响结果
  const v = TOPUP;
  const lower = forwarderAddress({ factory: v.factory.toLowerCase(), implementation: v.implementation.toLowerCase(), parent: v.parents[0].toLowerCase(), feeAddress: v.feeAddresses[0].toLowerCase(), salt: v.salts[0] });
  assert.equal(lower, v.addresses[0]);
});

test('地址只由（工厂、实现、parent、批量合约、盐）决定：ETH 和 BSC 用同一套参数时同一个客户地址相同；换 parent 或批量合约地址就变', async () => {
  const { forwarderAddress, depositSalt } = await create2();
  const scheme = { factory: TOPUP.factory, implementation: TOPUP.implementation, parent: TOPUP.parents[0], feeAddress: TOPUP.feeAddresses[0] };
  const salt = depositSalt(42);
  const eth = forwarderAddress({ ...scheme, salt });
  const bsc = forwarderAddress({ ...scheme, salt });
  assert.equal(eth, bsc);
  assert.notEqual(forwarderAddress({ ...scheme, parent: TOPUP.parents[300], salt }), eth);
  assert.notEqual(forwarderAddress({ ...scheme, feeAddress: TOPUP.feeAddresses[300], salt }), eth);
  assert.notEqual(forwarderAddress({ ...scheme, salt: depositSalt(43) }), eth);
});

test('输入检查：序号必须是正整数；地址、盐格式不对时报错（不默默算出一个错地址）', async () => {
  const { depositSalt, forwarderAddress } = await create2();
  for (const bad of [0, -1, 1.5, NaN, '1', null, undefined, 0n, -3n]) assert.throws(() => depositSalt(bad), `序号 ${String(bad)}`);
  const ok = { factory: TOPUP.factory, implementation: TOPUP.implementation, parent: TOPUP.parents[0], feeAddress: TOPUP.feeAddresses[0], salt: TOPUP.salts[0] };
  for (const [k, bad] of [['factory', '0x12'], ['parent', 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'], ['feeAddress', ''], ['implementation', '0xZZ00000000000000000000000000000000000000'], ['salt', '0x1234'], ['salt', TOPUP.salts[0].slice(0, -1) + 'g']]) {
    assert.throws(() => forwarderAddress({ ...ok, [k]: bad }), `${k} = ${bad}`);
  }
});

test('EIP-55：地址转成大小写校验格式（和以太坊官方示例一致）', async () => {
  const { toChecksumAddress } = await create2();
  // EIP-55 规范里的示例
  for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a);
    assert.equal(toChecksumAddress(a.toUpperCase().replace('0X', '0x')), a);
  }
});

test('BSC USDT 18 位小数：入账按 原始数 / 10^12 向下取整成 0.000001 USDT，余数不入账；6 位小数原样；全程整数不丢精度', async () => {
  const { toUnits } = await units();
  // 18 位
  assert.equal(toUnits('1000000000000000000', 18), 1_000_000n); // 1 USDT
  assert.equal(toUnits('1000000000000999999', 18), 1_000_000n); // 余数 0.000000999999 不入账
  assert.equal(toUnits('1234567890123456789', 18), 1_234_567n);
  assert.equal(toUnits('999999999999', 18), 0n); // 不到 0.000001
  assert.equal(toUnits('1000000000000', 18), 1n);
  assert.equal(toUnits(12_345_678_901_234_567_890_123n, 18), 12_345_678_901n); // 1,234 万 USDT 级别，bigint 输入
  assert.equal(toUnits('123456789012345678901234567890', 18), 123456789012345678n); // 超过 Number 精度也准确
  // 6 位（ETH USDT、TRON USDT）
  assert.equal(toUnits('1', 6), 1n);
  assert.equal(toUnits('150000000', 6), 150_000_000n);
  assert.equal(toUnits(0n, 18), 0n);
  // 不是非负整数的原始数报错
  for (const bad of ['-1', '1.5', '', 'abc', '0x10', -1n]) assert.throws(() => toUnits(bad, 18), `原始数 ${String(bad)}`);
  // 小数位数少于 6 的代币不在支持范围：直接报错，不猜换算
  assert.throws(() => toUnits('1', 2));
});
