// 测试先写（第 3 批）：商户上传表格（三步：上传 → 逐行检查 → 按链汇总 + 动态码提交）和开放 API 批量打款接口。
// 依据：TU-7（商户上传表格 + 开放 API）、Q-B6（一张表 / 一次 API 最多 500 笔）、原型偏离第 4 条（重复行警告、500 行、只提交没问题的行）、
//   原型偏离第 6 条（可以取消还没审核的批量打款）、Q-B5（网络费不另收）、Q-B7（23:00 后写第二天 8:00 后处理）、P5（余额一个数、提时选链）。
//
// 期望（给研发）：
//   server/pay/payout.js 的 parsePayoutSheet(text) → { rows: [{ line, chain, to, amount, customer_id, merchant_ref }] }
//     CSV，第一行是表头 chain,to,amount,customer_id,merchant_ref（后两列可省）；去掉 UTF-8 BOM；空行跳过；line 是数据行的序号（从 1 起，不算表头）；
//     链名不分大小写：eth / ethereum / 以太坊 → eth，bsc → bsc，tron / trc20 → tron；认不出的原样留着，交给逐行检查报 unknown_chain
//   商户后台接口（/api/merchant/?a=）：
//     payout-batch-check（POST { csv }）→ { rows: [{ line, chain, to, amount, ok, errors: [code], warnings: [code] }], totals: { <链>: { count, amount, fee, total } }, available, enough, service }
//       errors：unknown_chain、invalid_address（按链）、invalid_amount（≤ 0、超过 6 位小数、不是数字）；warnings：duplicate_row（同链、同地址、同金额出现不止一次，每一行都标）；
//       超过 500 行整张 too_many_items（422）；enough = 没问题的行合计 ≤ 可用余额（余额一个数，P5）
//     payout-batch-submit（POST { csv, code, only_valid }）→ submitPayoutBatch 的结果；动态码不对 bad_code；余额不够 insufficient_balance
//     payout-batches（GET）→ { items: [{ batch_no, status, count, total, created_at }] }；payout-batch（GET &batch_no=）→ 批次和逐笔状态、交易哈希
//     payout-batch-cancel（POST { batch_no }）→ { cancelled, kept }
//     withdraw（POST）多一个 chain 参数（不传是 tron，老页面照旧能用）
//   开放 API：POST /api/v1/payouts/batch/（要 IP 白名单、Idempotency-Key）body { items: [{ chain, to, amount, customer_id?, merchant_ref? }] }
//     最多 500 笔（too_many_items）；有一行不对整个请求 422 invalid_rows，error.rows 列出 [{ index, code }]（API 不做"只收没问题的"，口径待确认）；
//     500 笔的请求体会超过现在的 32 KB 上限，这个接口要放宽（建议 256 KB）；
//     GET /api/v1/payouts/batch/?batch_no= → { batch_no, status, items: [{ withdrawal_no, chain, to, amount, fee, status, txid }] }
//     两个接口都写进 site/src/docs/api-reference.mjs（test/docs-reference.test.js 会核对）
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createOps } from '../server/pay/ops.js';
import { createMerchantApi, inviteMerchantUser } from '../server/pay/merchant-api.js';
import { createApiV1, signRequest, canonicalPath } from '../server/pay/api-v1.js';
import { derivePayKeys } from '../server/pay/common.js';
import { totpCode } from '../server/kyb/totp.js';
import { toChecksumAddress } from '../server/wallet/create2.js';

const U = 1_000_000;
const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');
const evm = () => toChecksumAddress('0x' + randomBytes(20).toString('hex'));
const TRON_A = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const load = () => import(new URL('../server/pay/payout.js', import.meta.url).href);

async function setup({ fund = 10_000, start = Date.parse('2026-11-14T03:00:00Z') } = {}) {
  const db = await createTestDb(); await migrate(db);
  const ops = createOps({ db, keys, payBase: 'https://pay.test' });
  const m = await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 1 * U, min: 0 } });
  await core.createMerchant(db, { id: 'm2', name: 'Other', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 1 * U, min: 0 } });
  for (const id of ['m1', 'm2']) {
    await db.query('update balances set available = available + $2 where merchant_id = $1', [id, fund * U]);
    await db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ($1, 'deposit', $2, $2, 0, 'seed')`, [id, fund * U]);
  }
  let t = start; // 默认东八区 11:00
  const api = createMerchantApi({ db, keys, ops, now: () => t });
  let jar = '';
  const call = async (a, body, { qs = '' } = {}) => {
    const res = await api(new Request(`https://x.test/api/merchant/?a=${a}${qs}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', cookie: jar, 'x-topup-csrf': '1' } }));
    const sc = res.headers.get('set-cookie'); if (sc) jar = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const { link } = await inviteMerchantUser(db, keys, { merchantId: 'm1', email: 'f@acme.example', send: async () => {}, origin: 'https://x.test' });
  const token = new URL(link).searchParams.get('setup');
  const b = (await call('setup-begin', { token, password: 'correct horse battery' })).body;
  await call('setup-confirm', { token, code: totpCode(b.secret, t) });
  t += 31_000;
  await call('login', { email: 'f@acme.example', password: 'correct horse battery', code: totpCode(b.secret, t) });
  const code = () => { t += 31_000; return totpCode(b.secret, t); };
  return { db, ops, m, call, code, setNow: (v) => (t = v) };
}
const csv = (rows, header = 'chain,to,amount,customer_id,merchant_ref') => [header, ...rows.map((r) => r.join(','))].join('\n');

test('parsePayoutSheet：表头、BOM、空行、链名别名；行号从 1 起', async () => {
  const p = await load();
  const a = evm();
  const r = p.parsePayoutSheet('﻿' + csv([['ETH', a, '10.5', 'u1', 'r1'], [], ['以太坊', a, '1', '', ''], ['bsc', a, '2'], ['TRC20', TRON_A, '3'], ['BTC', a, '4']]));
  assert.deepEqual(r.rows.map((x) => [x.line, x.chain, x.amount]), [[1, 'eth', '10.5'], [2, 'eth', '1'], [3, 'bsc', '2'], [4, 'tron', '3'], [5, 'BTC', '4']]);
  assert.equal(r.rows[0].customer_id, 'u1');
  assert.equal(r.rows[0].merchant_ref, 'r1');
  assert.equal(r.rows[0].to, a);
});

test('上传第 2 步逐行检查：链名、地址按链、金额小数位、重复行警告；按链汇总含付款手续费、不另收网络费；余额一个数', async () => {
  const s = await setup({ fund: 100 });
  const a = evm();
  const sheet = csv([
    ['eth', a, '10'], ['eth', a, '10'], // 重复行：两行都标警告，但都算没问题
    ['bsc', TRON_A, '5'], // BSC 填了 TRON 地址
    ['tron', TRON_A, '1.0000001'], // 7 位小数
    ['tron', TRON_A, '0'],
    ['btc', a, '1'],
    ['tron', TRON_A, '20'],
  ]);
  const r = await s.call('payout-batch-check', { csv: sheet });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byLine = Object.fromEntries(r.body.rows.map((x) => [x.line, x]));
  assert.deepEqual([byLine[1].ok, byLine[1].warnings], [true, ['duplicate_row']]);
  assert.deepEqual([byLine[2].ok, byLine[2].warnings], [true, ['duplicate_row']]);
  assert.deepEqual(byLine[3].errors, ['invalid_address']);
  assert.deepEqual(byLine[4].errors, ['invalid_amount']);
  assert.deepEqual(byLine[5].errors, ['invalid_amount']);
  assert.deepEqual(byLine[6].errors, ['unknown_chain']);
  assert.equal(byLine[7].ok, true);
  assert.deepEqual(r.body.totals.eth, { count: 2, amount: '20.00', fee: '2.00', total: '22.00' });
  assert.deepEqual(r.body.totals.tron, { count: 1, amount: '20.00', fee: '1.00', total: '21.00' });
  assert.equal(r.body.available, '100.00');
  assert.equal(r.body.enough, true);
  // 余额不够：第 3 步提交按钮要禁用，这里 enough = false
  const big = await s.call('payout-batch-check', { csv: csv([['tron', TRON_A, '100']]) });
  assert.equal(big.body.enough, false);
});

test('一张表最多 500 行：501 行整张不收；500 行可以', async () => {
  const s = await setup({ fund: 10_000 });
  const rows = (n) => Array.from({ length: n }, () => ['tron', TRON_A, '1']);
  const r = await s.call('payout-batch-check', { csv: csv(rows(501)) });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'too_many_items');
  const ok = await s.call('payout-batch-check', { csv: csv(rows(500)) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rows.length, 500);
});

test('第 3 步提交：要动态码；有问题的行默认不收，勾"只提交没问题的行"才收其余；批次列表、明细、取消还没审的', async () => {
  const s = await setup({ fund: 1_000 });
  const sheet = csv([['eth', evm(), '10'], ['bsc', 'bad', '1'], ['tron', TRON_A, '5']]);
  assert.equal((await s.call('payout-batch-submit', { csv: sheet, code: '000000', only_valid: true })).body.error.code, 'bad_code');
  const all = await s.call('payout-batch-submit', { csv: sheet, code: s.code() });
  assert.equal(all.status, 422);
  assert.equal(all.body.error.code, 'invalid_rows');
  const r = await s.call('payout-batch-submit', { csv: sheet, code: s.code(), only_valid: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.accepted.length, 2);
  assert.deepEqual(r.body.rejected_rows.map((x) => x.line), [2]);
  assert.equal(r.body.service.open, true);
  const list = (await s.call('payout-batches')).body.items;
  assert.equal(list[0].batch_no, r.body.batch_no);
  assert.equal(list[0].count, 2);
  const d = (await s.call('payout-batch', null, { qs: `&batch_no=${r.body.batch_no}` })).body;
  assert.deepEqual(d.items.map((x) => [x.chain, x.status]), [['eth', 'pending'], ['tron', 'pending']]);
  const c = await s.call('payout-batch-cancel', { batch_no: r.body.batch_no });
  assert.deepEqual([c.body.cancelled, c.body.kept], [2, 0]);
  assert.equal((await s.call('overview')).body.available, '1000.00', '取消后全部退回');
});

test('Q-B7：23:00 以后提交，返回里写明不在处理时段、下一个 8:00', async () => {
  const s = await setup({ start: Date.parse('2026-11-14T15:05:00Z') }); // 东八区 23:05（登录也在这个时间，免得会话过期）
  const r = await s.call('payout-batch-submit', { csv: csv([['tron', TRON_A, '5']]), code: s.code() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.service.open, false);
  assert.equal(r.body.service.next_open_at, '2026-11-15T00:00:00.000Z');
});

test('商户提币选链（P5）：withdraw 带 chain；不带 chain 的老页面照旧是 TRON', async () => {
  const s = await setup();
  const to = evm();
  await s.db.query(`update merchants set cashout_wallets = $1::jsonb where id = 'm1'`, [JSON.stringify([{ chain: 'bsc', address: to }])]);
  const ok = await s.call('withdraw', { kind: 'cashout', chain: 'bsc', to, amount: '5', code: s.code() });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.chain, 'bsc');
  const no = await s.call('withdraw', { kind: 'cashout', chain: 'eth', to, amount: '5', code: s.code() });
  assert.equal(no.body.error.code, 'address_not_registered');
  const old = await s.call('withdraw', { kind: 'payout', to: TRON_A, amount: '1', code: s.code() });
  assert.equal(old.body.chain, 'tron');
});

// ---------- 开放 API ----------
async function apiSetup() {
  const db = await createTestDb(); await migrate(db);
  const ops = createOps({ db, keys, payBase: 'https://pay.test' });
  const m = await core.createMerchant(db, { id: 'ma', name: 'ma', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 1 * U, min: 0 } });
  const mb = await core.createMerchant(db, { id: 'mb', name: 'mb', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 1 * U, min: 0 } });
  for (const id of ['ma', 'mb']) {
    await db.query('update balances set available = available + $2 where merchant_id = $1', [id, 10_000 * U]);
    await db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ($1, 'deposit', $2, $2, 0, 'seed')`, [id, 10_000 * U]);
  }
  await db.query(`update merchants set ip_whitelist = '["203.0.113.10"]'::jsonb`);
  const cred = await ops.regenerateSecret(m), credB = await ops.regenerateSecret(mb);
  let ip = '203.0.113.10';
  const api = createApiV1({ db, keys, ops, getIp: () => ip });
  const call = async (c, method, path, body, { idem = randomUUID() } = {}) => {
    const raw = body ? JSON.stringify(body) : '';
    const full = `https://api.test/api/v1/${path}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await api(new Request(full, { method, body: raw || undefined, headers: { 'content-type': 'application/json', 'x-topup-key': c.api_key, 'x-topup-timestamp': ts, 'x-topup-signature': signRequest(c.api_secret, ts, method, canonicalPath(full), raw), ...(method === 'POST' ? { 'idempotency-key': idem } : {}) } }));
    return { status: res.status, body: await res.json() };
  };
  return { db, api, call, cred, credB, setIp: (v) => (ip = v) };
}

test('开放 API POST /payouts/batch/：IP 白名单、Idempotency-Key 重试返回同一批、一行不对整个 422 并列出是哪几行', async () => {
  const s = await apiSetup();
  const items = [{ chain: 'eth', to: evm(), amount: '10', merchant_ref: 'A-1' }, { chain: 'tron', to: TRON_A, amount: '5', customer_id: 'u9' }];
  assert.ok(s.api.routes.includes('POST payouts/batch'), '开放 API 要有 POST payouts/batch');
  assert.ok(s.api.routes.includes('GET payouts/batch'), '开放 API 要有 GET payouts/batch');
  s.setIp('198.51.100.1');
  assert.equal((await s.call(s.cred, 'POST', 'payouts/batch/', { items })).body.error.code, 'ip_not_allowed');
  s.setIp('203.0.113.10');
  const idem = randomUUID();
  const r1 = await s.call(s.cred, 'POST', 'payouts/batch/', { items }, { idem });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.items.length, 2);
  assert.deepEqual(r1.body.items.map((x) => [x.chain, x.amount, x.fee, x.status]), [['eth', '10.00', '1.00', 'pending'], ['tron', '5.00', '1.00', 'pending']]);
  const r2 = await s.call(s.cred, 'POST', 'payouts/batch/', { items }, { idem });
  assert.equal(r2.body.batch_no, r1.body.batch_no, '同一个 Key 重试不重复建批');
  const [{ n }] = await s.db.query(`select count(*)::int n from withdrawals where merchant_id = 'ma'`);
  assert.equal(n, 2);
  const bad = await s.call(s.cred, 'POST', 'payouts/batch/', { items: [items[0], { chain: 'bsc', to: TRON_A, amount: '1' }, { chain: 'eth', to: evm(), amount: '-1' }] });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'invalid_rows');
  assert.deepEqual(bad.body.error.rows.map((x) => [x.index, x.code]), [[1, 'invalid_address'], [2, 'invalid_amount']]);
  const [{ n: n2 }] = await s.db.query(`select count(*)::int n from withdrawals where merchant_id = 'ma'`);
  assert.equal(n2, 2, '整个不收');
});

test('开放 API：500 笔可以（请求体超过 32 KB 也要收），501 笔 too_many_items；GET 查批次逐笔；别的商户查不到', async () => {
  const s = await apiSetup();
  const many = (n) => Array.from({ length: n }, () => ({ chain: 'bsc', to: evm(), amount: '1', merchant_ref: 'ref-' + randomBytes(8).toString('hex') }));
  const over = await s.call(s.cred, 'POST', 'payouts/batch/', { items: many(501) });
  assert.equal(over.body.error.code, 'too_many_items');
  const body = { items: many(500) };
  assert.ok(JSON.stringify(body).length > 32 * 1024, '用例本身：500 笔的请求体要超过 32 KB');
  const ok = await s.call(s.cred, 'POST', 'payouts/batch/', body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.equal(ok.body.items.length, 500);
  const got = await s.call(s.cred, 'GET', `payouts/batch/?batch_no=${ok.body.batch_no}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.items.length, 500);
  assert.equal(got.body.items[0].status, 'pending');
  assert.equal((await s.call(s.credB, 'GET', `payouts/batch/?batch_no=${ok.body.batch_no}`)).status, 404, '商户隔离');
});

// C1（2026-11-14）：批量打款只能整批取消还没审核的部分；批次里的单笔不能单独取消（商户后台、开放 API 都一样）。
// 被拒：409 batch_item_cancel（研发 2026-11-14 报来的错误码）；这一笔仍是待审核、余额和冻结都没动、批次里其余的也没动。
test('C1 批量打款里的单笔不能单独取消：商户后台 withdraw-cancel、开放 API withdrawals/cancel/ 都拒绝；整批取消照旧可以', async () => {
  const s = await setup({ fund: 1_000 });
  const r = await s.call('payout-batch-submit', { csv: csv([['eth', evm(), '10'], ['tron', TRON_A, '5']]), code: s.code() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [one, two] = r.body.accepted.map((x) => x.withdrawal_no);
  const money = async () => JSON.stringify(await s.db.query(`select available, frozen from balances where merchant_id = 'm1'`));
  const before = await money();
  const c = await s.call('withdraw-cancel', { withdrawal_no: one });
  assert.equal(c.status, 409, `批次里的单笔应该 409 被拒，实际：${JSON.stringify(c.body)}`);
  assert.equal(c.body.error.code, 'batch_item_cancel');
  const st = await s.db.query('select id, status from withdrawals where id = any($1::text[]) order by batch_line', [[one, two]]);
  assert.deepEqual(st.map((x) => x.status), ['pending', 'pending'], '这一笔和批次里其余的都还是待审核');
  assert.equal(await money(), before, '余额、冻结都没动');
  // 普通单笔提币照旧可以取消（不是一刀切）
  const w = await s.call('withdraw', { kind: 'payout', chain: 'tron', to: TRON_A, amount: '3', code: s.code() });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal((await s.call('withdraw-cancel', { withdrawal_no: w.body.withdrawal_no })).status, 200);
  // 整批取消照旧可以
  const all = await s.call('payout-batch-cancel', { batch_no: r.body.batch_no });
  assert.deepEqual([all.body.cancelled, all.body.kept], [2, 0]);

  const a = await apiSetup();
  const b = await a.call(a.cred, 'POST', 'payouts/batch/', { items: [{ chain: 'eth', to: evm(), amount: '10' }, { chain: 'tron', to: TRON_A, amount: '5' }] });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const beforeA = JSON.stringify(await a.db.query(`select available, frozen from balances where merchant_id = 'ma'`));
  const x = await a.call(a.cred, 'POST', 'withdrawals/cancel/', { withdrawal_no: b.body.items[0].withdrawal_no });
  assert.equal(x.status, 409, `开放 API 取消批次里的单笔应该 409 被拒，实际：${JSON.stringify(x.body)}`);
  assert.equal(x.body.error.code, 'batch_item_cancel');
  const g = await a.call(a.cred, 'GET', `payouts/batch/?batch_no=${b.body.batch_no}`);
  assert.deepEqual(g.body.items.map((i) => i.status), ['pending', 'pending']);
  assert.equal(JSON.stringify(await a.db.query(`select available, frozen from balances where merchant_id = 'ma'`)), beforeA);
});
