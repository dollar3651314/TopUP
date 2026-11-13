// TRON CREATE2 地址（0x41 前缀）的离线计算：scripts/tron-nile/tron-create2.mjs。
// 向量来自本机 TRON 私链（tronbox/tre，java-tron 4.8.2）上用 BitGo 工厂实际部署出的地址；Nile 测试网的结果以 verify.mjs 的报告为准。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwarderAddress, create2, addr20, toBase58, toHex41 } from '../scripts/tron-nile/tron-create2.mjs';
import { forwarderAddress as evmForwarderAddress } from '../server/wallet/create2.js';
import { hex } from '@scure/base';

const LOCAL_CHAIN_VECTOR = {
  factory: 'TF9ghZ6gzZDN6kpafqMpFvx9XZxyosSe3Q',
  implementation: 'TVNzcFxAjjQ5zCkRvvztMExCGusAhadvWM',
  parent: 'TXBM9cmgL7bzN36mzXwMtYCGt3wWBbDkMs',
  feeAddress: 'TS9NozjjXQGeaQf7HiWUMDZMHxR2cLzwD1',
  salt: '0x33d2dffca5d56aa2aabe8546eb9c2506b8e7f456b7314398eaaccbf2579c2795',
  deployed: 'TFbpzCXS324eoaAHzNSy1bYwcKrhhYGkB4',
};

test('0x41 forwarder address equals the address the factory deployed on a local TRON chain', () => {
  const r = forwarderAddress(LOCAL_CHAIN_VECTOR);
  assert.equal(r.tron, LOCAL_CHAIN_VECTOR.deployed);
  assert.equal(r.hex41, toHex41(addr20(LOCAL_CHAIN_VECTOR.deployed)));
  assert.notEqual(r.evmStyle, r.tron);
});

test('0xff variant equals the Ethereum backend calculation for the same 20-byte inputs', () => {
  const v = LOCAL_CHAIN_VECTOR;
  const ev = (a) => '0x' + hex.encode(addr20(a));
  const evm = evmForwarderAddress({ factory: ev(v.factory), implementation: ev(v.implementation), parent: ev(v.parent), feeAddress: ev(v.feeAddress), salt: v.salt });
  assert.equal(forwarderAddress(v).evmStyle, toBase58(addr20(evm)));
});

test('address formats: T-address, 41-hex and 0x-hex are interchangeable; bad input throws', () => {
  const t = LOCAL_CHAIN_VECTOR.factory;
  const h = toHex41(addr20(t));
  assert.equal(toBase58(addr20(h)), t);
  assert.equal(toBase58(addr20('0x' + h.slice(2))), t);
  assert.throws(() => addr20('T' + 'x'.repeat(33)));
  assert.throws(() => create2(0x00, t, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32)));
  assert.throws(() => forwarderAddress({ ...LOCAL_CHAIN_VECTOR, salt: '0x1234' }));
});
