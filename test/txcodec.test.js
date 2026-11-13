// 交易解码、改过期时间、签名。fixtures/tron-txs.json 是 TRON 主网上公开的真实交易
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hex } from '@scure/base';
import { decodeRaw, setExpiration, encodeSigned, txIdOf, fields } from '../server/pay/txcodec.js';
import { signTxId, signerOf, addressOfPrivateKey } from '../server/pay/signing.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/tron-txs.json', import.meta.url)));

test('四种交易：解码结果和 TronGrid 返回的 JSON 一致，txID = sha256(原文)', () => {
  const t = decodeRaw(fx.TriggerSmartContract.raw_data_hex);
  assert.equal(t.txId, fx.TriggerSmartContract.txID);
  const c = t.contracts[0], v = fx.TriggerSmartContract.value;
  assert.equal(c.owner, v.owner_address);
  assert.equal(c.contract, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  assert.equal(c.method, 'a9059cbb');
  assert.equal(c.amount, Number(BigInt('0x' + v.data.slice(-64))));
  const tr = decodeRaw(fx.TransferContract.raw_data_hex).contracts[0];
  assert.deepEqual([tr.type, tr.owner, tr.to, tr.amount], ['TransferContract', fx.TransferContract.value.owner_address, fx.TransferContract.value.to_address, fx.TransferContract.value.amount]);
  for (const k of ['DelegateResourceContract', 'UnDelegateResourceContract']) {
    const d = decodeRaw(fx[k].raw_data_hex).contracts[0], fv = fx[k].value;
    assert.deepEqual([d.type, d.owner, d.to, d.amount, d.resource], [k, fv.owner_address, fv.receiver_address, fv.balance, 'ENERGY']);
    assert.equal(d.permissionId, fx[k].value.Permission_id ?? d.permissionId);
    assert.equal(decodeRaw(fx[k].raw_data_hex).txId, fx[k].txID);
  }
});

test('真实交易的签名人就是付款地址（签名格式：恢复位 0/1）', () => {
  for (const k of Object.keys(fx)) {
    const d = decodeRaw(fx[k].raw_data_hex);
    // 带多签权限（permissionId > 0）的交易由别的密钥签名，不适用这条检查
    if (d.contracts[0].permissionId) continue;
    assert.equal(signerOf(d.txId, fx[k].signature[0]), d.contracts[0].owner, k);
  }
});

test('改过期时间：只改字段 8，其他内容不变，txID 跟着变', () => {
  const raw = fx.TriggerSmartContract.raw_data_hex;
  const later = fx.TriggerSmartContract.expiration + 30 * 60_000;
  const nh = setExpiration(raw, later);
  const a = decodeRaw(raw), b = decodeRaw(nh);
  assert.equal(b.expiration, later);
  assert.deepEqual(b.contracts, a.contracts);
  assert.notEqual(b.txId, a.txId);
  const strip = (h) => fields(hex.decode(h)).filter((f) => f.no !== 8).map((f) => hex.encode(hex.decode(h).slice(f.start, f.end))).join('');
  assert.equal(strip(nh), strip(raw));
});

test('签名：用私钥签名后能恢复出同一个地址；改一个字节就对不上', () => {
  const priv = hex.decode('1'.repeat(64));
  const id = txIdOf(fx.TransferContract.raw_data_hex);
  const sig = signTxId(id, priv);
  assert.equal(signerOf(id, sig), addressOfPrivateKey(priv));
  const other = txIdOf(setExpiration(fx.TransferContract.raw_data_hex, 1));
  assert.notEqual(signerOf(other, sig), addressOfPrivateKey(priv));
  assert.equal(signerOf(id, 'zz'), null);
  const full = encodeSigned(fx.TransferContract.raw_data_hex, sig);
  assert.ok(full.startsWith('0a') && full.endsWith(sig));
});
