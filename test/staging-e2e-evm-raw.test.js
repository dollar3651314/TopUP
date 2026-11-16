// 验收用例自带的以太坊交易原文解码（e2e/staging-e2e/evm-raw.mjs，不装依赖）和服务器的严格编码器（server/wallet/evm-payout-codec.js）对拍：
// 服务器编出来的原文，用例解出来的链 ID、合约、value、nonce、收款地址、金额都一样；E05 里写死的 pay 选择器和服务器算的一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeUnsignedLegacyTx, encodePayCall, decodeUnsignedLegacyTx, selectorOf, PAY_SIGNATURE, checksumAddress } from '../server/wallet/evm-payout-codec.js';
import { decodeRawTx, decodePay } from '../e2e/staging-e2e/evm-raw.mjs';

const addr = () => checksumAddress('0x' + randomBytes(20).toString('hex'));

test('evm-raw 解码服务器编的 BatchPayout 交易原文：字段逐个一致', () => {
  for (const n of [1, 2, 10, 100]) {
    const token = addr(), contract = addr();
    const items = Array.from({ length: n }, (_, i) => ({ to: addr(), amount: BigInt(i + 1) * 1_000_001n }));
    const batchId = '0x' + randomBytes(32).toString('hex');
    const data = encodePayCall(token, batchId, items);
    for (const [nonce, chainId] of [[0n, 11155111n], [5n, 97n], [300n, 1n]]) {
      const raw = encodeUnsignedLegacyTx({ nonce, gasPrice: 20n, gas: 941_557n, to: contract, value: 0, data, chainId });
      const tx = decodeRawTx(raw);
      const ref = decodeUnsignedLegacyTx(raw);
      assert.equal(tx.chainId, chainId);
      assert.equal(tx.nonce, nonce);
      assert.equal(tx.value, 0n);
      assert.equal(tx.gas, ref.gas);
      assert.equal(tx.to, contract.toLowerCase());
      const call = decodePay(tx.data);
      assert.equal(call.selector, '0x' + selectorOf(PAY_SIGNATURE));
      assert.equal(call.token, token.toLowerCase());
      assert.equal(call.batchId, batchId);
      assert.deepEqual(call.items, items.map((i) => ({ to: i.to.toLowerCase(), amount: i.amount })));
    }
  }
});

test('E05 写死的 pay 选择器 0x52ecd4bd 就是 pay(address,bytes32,address[],uint256[])', () => {
  assert.equal('0x' + selectorOf(PAY_SIGNATURE), '0x52ecd4bd');
});

test('evm-raw 不认的：不是 9 项的列表、坏的十六进制、调用数据布局不对', () => {
  assert.throws(() => decodeRawTx('0xc0'));
  assert.throws(() => decodeRawTx('0x' + 'zz'));
  assert.throws(() => decodePay('0x52ecd4bd' + '00'.repeat(32)));
});
