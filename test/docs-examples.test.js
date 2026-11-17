// 开发者文档里的回调验证示例可以直接使用（请求签名示例在端到端测试里对本地接口实际运行）
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCallback } from '../site/src/docs/verify-callback.mjs';
import { signCallback } from '../server/pay/callbacks.js';

test('文档的回调验证示例：真的回调通过；改了内容、签名错误、时间戳过期都不通过', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'deposit', data: { amount: '10.00' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signCallback('s3cret', ts, body);
  assert.equal(verifyCallback('s3cret', ts, sig, body), true);
  assert.equal(verifyCallback('s3cret', ts, sig, body.replace('10.00', '99.00')), false);
  assert.equal(verifyCallback('other', ts, sig, body), false);
  const old = String(Math.floor(Date.now() / 1000) - 600);
  assert.equal(verifyCallback('s3cret', old, signCallback('s3cret', old, body), body), false);
});
