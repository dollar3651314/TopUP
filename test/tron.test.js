// 地址推导（用已知助记词和已知地址验证）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveAddress, checkXpub, addressFromPublicKey, isValidAddress, hexToAddress, addressToHex, ACCOUNT_PATH } from '../server/pay/tron.js';

// 公开的测试助记词，任何人都知道，只能用于测试
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const account = root.derive(ACCOUNT_PATH);

test('xpub 推导的地址与助记词直接推导的一致（第 0 到 4 个）', () => {
  for (let i = 0; i < 5; i++) {
    const priv = root.derive(`${ACCOUNT_PATH}/0/${i}`).privateKey;
    const fromPriv = addressFromPublicKey(secp256k1.getPublicKey(priv, false));
    assert.equal(deriveAddress(account.publicExtendedKey, i), fromPriv);
  }
});

test('已知测试向量：abandon…about 的第 0 个 TRON 地址', () => {
  assert.equal(deriveAddress(account.publicExtendedKey, 0), 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
});

test('服务器只接受公钥：xprv、层级不对都拒绝', () => {
  assert.throws(() => checkXpub(account.privateExtendedKey), /private_key_not_allowed/);
  assert.throws(() => checkXpub(root.publicExtendedKey), /wrong_depth/);
  assert.equal(checkXpub(account.publicExtendedKey), account.publicExtendedKey);
});

test('地址校验和、十六进制互转', () => {
  const a = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // 主网 USDT 合约
  assert.ok(isValidAddress(a));
  assert.ok(!isValidAddress(a.slice(0, -1) + 'u'));
  assert.equal(addressToHex(a), '41a614f803b6fd780986a42c78ec9c7f77e6ded13c');
  assert.equal(hexToAddress('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'), a);
});

test('TronGrid：没有激活的地址也能查到 USDT 余额（账户接口对没激活的地址什么都不返回）', async () => {
  const { createTronGrid } = await import('../server/pay/trongrid.js');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('/v1/accounts/')) return Response.json({ data: [], success: true });
    if (url.includes('triggerconstantcontract')) return Response.json({ result: { result: true }, constant_result: ['0000000000000000000000000000000000000000000000000000000001312d01'] });
    throw new Error(url);
  };
  const t = createTronGrid({ network: 'nile', fetchImpl });
  const a = await t.account('TYHaeUfLZJTT3db7wQYJ2cDC9QGUsrMsGq');
  assert.deepEqual(a, { activated: false, trx: 0, trc20: { [t.contract]: 20_000_001 } });
  assert.ok(calls.some((u) => u.includes('triggerconstantcontract')));
});
