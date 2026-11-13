// 开发者文档的字段说明（site/src/docs/api-reference.mjs）和接口实际返回的内容必须一致：
// 逐个调用每个接口，检查返回的字段名、类型、可能为 null 的字段和文档写的完全一致；回调的内容也一样检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createOps } from '../server/pay/ops.js';
import { createApiV1, signRequest, canonicalPath } from '../server/pay/api-v1.js';
import { derivePayKeys } from '../server/pay/common.js';
import { deliverDue } from '../server/pay/callbacks.js';
import { ENDPOINTS, OBJECTS, LIST, EVENTS, EVENT_ENVELOPE, ERRORS, TYPES, returnFields } from '../site/src/docs/api-reference.mjs';
import { legacyTronCustomer } from './legacy-tron.js'; // K1：新客户不再生成地址；要用 TRON 地址的用例先造已有 TRON 地址的老客户

const U = 1_000_000;
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
const TO = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const AMOUNT = /^-?\d+\.\d{2,6}$/;
function checkValue(where, [name, type, , nullable], v) {
  if (v === null) { assert.ok(nullable, `${where}.${name} 是 null，但文档没有写"可能为 null"`); return; }
  const ok = { string: typeof v === 'string', amount: typeof v === 'string' && AMOUNT.test(v), integer: Number.isInteger(v), boolean: typeof v === 'boolean', time: typeof v === 'string' && ISO.test(v), array: Array.isArray(v), object: v && typeof v === 'object' }[type];
  assert.ok(ok, `${where}.${name} 的类型应该是 ${type}，实际是 ${JSON.stringify(v)}`);
}
/** 对象的字段和文档完全一致（不多不少），类型也一致 */
function checkObject(where, fields, obj) {
  assert.deepEqual(Object.keys(obj).sort(), fields.map((f) => f[0]).sort(), `${where} 的字段和文档不一致`);
  for (const f of fields) checkValue(where, f, obj[f[0]]);
}

test('开发者文档：每个接口都写进了文档，文档里的接口都存在', async () => {
  const db = await createTestDb(); await migrate(db);
  const api = createApiV1({ db, keys, ops: createOps({ db, keys }) });
  const documented = ENDPOINTS.map((e) => `${e.method} ${e.path.replace(/\/$/, '')}`);
  assert.deepEqual([...documented].sort(), [...api.routes].sort());
  // 文档里引用的对象、类型、错误码都有定义
  for (const e of ENDPOINTS) {
    for (const n of e.returns) assert.ok(OBJECTS[n], `${e.path} 引用了不存在的对象 ${n}`);
    for (const p of [...(e.query || []), ...(e.body || [])]) assert.ok(TYPES[p[1]], `${e.path} 的参数 ${p[0]} 类型 ${p[1]} 没有定义`);
    for (const c of e.errors || []) assert.ok(ERRORS.some((x) => x[1] === c), `${e.path} 引用了没有写进错误码表的 ${c}`);
  }
  await db.end();
});

test('开发者文档：每个接口实际返回的字段、类型和文档一致；回调的内容也一致', async () => {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const ops = createOps({ db, keys, payBase: 'https://pay.test' });
  const m = await core.createMerchant(db, { id: 'md', name: 'Docs Ltd', feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } });
  const cred = await ops.regenerateSecret(m);
  const api = createApiV1({ db, keys, ops, getIp: () => '203.0.113.10' });
  await ops.setIpWhitelist(m, ['203.0.113.10']);
  const call = async (method, path, body) => {
    const raw = body ? JSON.stringify(body) : '';
    const url = `https://api.test/api/v1/${path}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await api(new Request(url, { method, body: raw || undefined, headers: { 'content-type': 'application/json', 'x-topup-key': cred.api_key, 'x-topup-timestamp': ts, 'x-topup-signature': signRequest(cred.api_secret, ts, method, canonicalPath(url), raw), ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) } }));
    const out = await res.json();
    assert.equal(res.status, 200, `${method} ${path}：${JSON.stringify(out)}`);
    return out;
  };
  const seen = new Set();
  const check = (method, path, out) => {
    const ep = ENDPOINTS.find((e) => e.method === method && e.path === path);
    seen.add(`${method} ${path}`);
    const fields = returnFields(ep);
    if (ep.list) {
      checkObject(`${method} ${path}`, LIST, out);
      assert.ok(out.items.length > 0, `${method} ${path} 没有返回记录，检查不到字段`);
      for (const it of out.items) checkObject(`${method} ${path} items[]`, fields, it);
    } else checkObject(`${method} ${path}`, fields, out);
    for (const d of out.deposits || []) checkObject(`${method} ${path} deposits[]`, OBJECTS.OrderDeposit, d);
    return out;
  };

  await legacyTronCustomer(db, 'md', 'c1'); // 到账要用地址：已有 TRON 地址的老客户（新客户按 K1 在充值时才生成地址）
  const c = check('POST', 'customers/', await call('POST', 'customers/', { customer_id: 'c1', name: 'Lin', email: 'lin@example.com', remark: 'vip' }));
  check('GET', 'customers/', await call('GET', 'customers/?customer_id=c1'));
  check('GET', 'customers/list/', await call('GET', 'customers/list/'));
  await core.recordDeposit(db, { txid: 'a'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 100 * U, time: new Date() });
  await core.recordDeposit(db, { txid: 'b'.repeat(64), logIndex: 0, block: 2, to: c.address, amount: U / 2, time: new Date() }); // 低于 1 USDT
  const o = check('POST', 'orders/', await call('POST', 'orders/', { customer_id: 'c1', merchant_order_no: 'DOC-1', amount: '500' }));
  check('GET', 'orders/', await call('GET', `orders/?order_no=${o.order_no}`));
  check('GET', 'orders/list/', await call('GET', 'orders/list/'));
  const deps = check('GET', 'deposits/', await call('GET', 'deposits/?customer_id=c1'));
  // 低于 1 USDT 的那笔商户看不到（只在运营后台的异常到账里）
  assert.ok(deps.items.every((d) => d.result === 'credited'));
  assert.equal(deps.items.length, 1);
  const dep = deps.items[0];
  const matched = check('POST', 'orders/match/', await call('POST', 'orders/match/', { order_no: o.order_no, deposit_id: dep.id }));
  assert.equal(matched.deposits.length, 1);
  check('GET', 'deposits/', await call('GET', 'deposits/?customer_id=c1')); // 匹配后 order_no、matched_by 有值
  check('POST', 'orders/unmatch/', await call('POST', 'orders/unmatch/', { order_no: o.order_no, deposit_id: dep.id }));
  check('GET', 'customers/stats/', await call('GET', 'customers/stats/?customer_id=c1'));
  check('GET', 'balance/', await call('GET', 'balance/'));
  check('GET', 'ledger/', await call('GET', 'ledger/'));
  const w = check('POST', 'withdrawals/', await call('POST', 'withdrawals/', { kind: 'payout', customer_id: 'c1', to: TO, amount: '10', merchant_ref: 'R-1' }));
  check('GET', 'withdrawals/', await call('GET', `withdrawals/?withdrawal_no=${w.withdrawal_no}`));
  check('POST', 'withdrawals/cancel/', await call('POST', 'withdrawals/cancel/', { withdrawal_no: w.withdrawal_no }));
  assert.deepEqual([...seen].sort(), ENDPOINTS.map((e) => `${e.method} ${e.path}`).sort(), '有接口没有被检查到');

  // 回调：检查实际发出去的请求体（外层和每种事件的 data）
  const sent = [];
  await deliverDue(db, {
    getTarget: async () => ({ url: 'https://merchant.example/cb', secret: 's' }),
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('', { status: 200 }); },
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  for (const ev of EVENTS) {
    const list = sent.filter((p) => p.type === ev.type);
    assert.ok(list.length, `没有发出 ${ev.type} 回调，检查不到字段`);
    for (const p of list) {
      checkObject(`回调 ${ev.type}`, EVENT_ENVELOPE, p);
      checkObject(`回调 ${ev.type} data`, [...ev.data.flatMap((n) => OBJECTS[n]), ...(ev.extra || [])], p.data);
      for (const d of p.data.deposits || []) checkObject(`回调 ${ev.type} deposits[]`, OBJECTS.OrderDeposit, d);
    }
  }
  await db.end();
});
