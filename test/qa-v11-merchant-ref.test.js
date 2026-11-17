// 测试先写（v1.1）：提现单号 merchant_ref 在同一商户内永久唯一。
// 依据：v1.1 开放 API 补接口需求的"提现单号永久防重"一节（已定：重复时拒收 409 并给原来那笔的提现号；单号选填，填了就永久唯一）。
//
// 给研发的接口约定（需求没写死的地方由测试定，照着做）：
//   - 唯一范围：同一商户的 withdrawals.merchant_ref（单笔提币 POST withdrawals/、商户后台提币、批量打款每一行一起算），
//     任何状态都算（pending / approved / … / rejected / cancelled / failed），不随 Idempotency-Key 的 24 小时清理失效；
//     不填（null / 空串 / 只有空格）不算，可以有任意多笔。数据库层面要有唯一约束兜底（两个请求同时进来也只成功一笔）。
//   - 单笔重复：HTTP 409，error.code = 'duplicate_merchant_ref'，error.field = 'merchant_ref'，error.withdrawal_no = 原来那笔的提现号；
//     不冻结、不新建提现、不发回调。同一个 Idempotency-Key 的重试仍按原来的规则返回第一次的结果（200）。
//   - 批量打款：同一批里两行同号，后出现的那一行报错；和已有提现同号的那一行报错；行错误码都是 'duplicate_merchant_ref'
//     （开放 API：整个请求 422 invalid_rows，error.rows[] 里那一行 code / errors 有它；商户后台第 2 步 payout-batch-check：那一行 ok=false、errors 有它）。
//   - 按单号查：GET withdrawals/?merchant_ref=<单号>（和 withdrawal_no 二选一，同 GET orders/ 的 merchant_order_no），返回 Withdrawal；
//     别的商户的单号 404 not_found。
//   - 迁移：migrate() 建唯一约束之前，把已有的重复单号处理掉：同一商户同一单号保留最早的一笔（created_at 最早，相同再按 id），
//     其余改成 `<原单号前 40 字>~<提现号>`；每改一笔记一条审计 pay_audit（action = 'withdrawal.merchant_ref_dedup'，target = 提现号，
//     detail 带 before、after）。migrate() 可以重复执行（没有重复时什么都不改）；如果用了"只执行一次"的 pay_meta 标记，键名以 merchant_ref 开头。
//   - 开发者文档（site/src/docs/api-reference.mjs）：merchant_ref 说明写明同一商户永久唯一；错误码表加 409 duplicate_merchant_ref；
//     POST withdrawals/ 的 errors 加它；GET withdrawals/ 加 merchant_ref 查询参数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, U, TO, TO2, ETH_TO, DAY } from './qa-v11-helpers.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { ENDPOINTS, ERRORS } from '../site/src/docs/api-reference.mjs';

const wd = (ref, extra = {}) => ({ kind: 'payout', chain: 'tron', to: TO, amount: '10', ...(ref === undefined ? {} : { merchant_ref: ref }), ...extra });
const count = async (db, mid) => Number((await db.query('select count(*)::int n from withdrawals where merchant_id = $1', [mid]))[0].n);

test('TG-1 ① 同一商户同一单号第二次提交（新的 Idempotency-Key）：409 duplicate_merchant_ref + 原提现号，余额只冻结一次', async () => {
  const w = await world();
  const r1 = await w.api(w.a, 'POST', 'withdrawals/', wd('TRD-0001'));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const bal1 = await w.balance('ma');
  const r2 = await w.api(w.a, 'POST', 'withdrawals/', wd('TRD-0001', { amount: '20', to: TO2 }));
  assert.equal(r2.status, 409, `同号第二次应该 409，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
  assert.equal(r2.body.error.code, 'duplicate_merchant_ref');
  assert.equal(r2.body.error.field, 'merchant_ref');
  assert.equal(r2.body.error.withdrawal_no, r1.body.withdrawal_no, '要返回原来那笔的提现号');
  const bal2 = await w.balance('ma');
  assert.equal(bal2.available, bal1.available, '第二次不能再冻结');
  assert.equal(bal2.frozen, bal1.frozen);
  assert.equal(await count(w.db, 'ma'), 1);
  const cbs = await w.db.query(`select count(*)::int n from callbacks where merchant_id = 'ma' and event = 'withdrawal.updated'`);
  assert.equal(cbs[0].n, 1, '重复的不发回调');
  await w.db.end();
});

test('TG-1 ① 隔 25 小时（幂等记录已清理）同号再提交仍拒收；同一个 Idempotency-Key 在 24 小时内重试仍返回第一次的结果', async () => {
  const w = await world();
  const idem = 'retry-key-0001';
  const r1 = await w.api(w.a, 'POST', 'withdrawals/', wd('TRD-25H'), { idem });
  assert.equal(r1.status, 200);
  const again = await w.api(w.a, 'POST', 'withdrawals/', wd('TRD-25H'), { idem });
  assert.equal(again.status, 200, '同一个 Key 的重试照旧返回第一次的结果');
  assert.equal(again.body.withdrawal_no, r1.body.withdrawal_no);
  // 25 小时后：每日任务把超过 24 小时的幂等记录清掉（daily.js 同一条语句），商户用同一个 Key 重试
  await w.db.query(`update idempotency set created_at = created_at - interval '25 hours'`);
  await w.db.query(`delete from idempotency where created_at < now() - interval '24 hours'`);
  const late = await w.api(w.a, 'POST', 'withdrawals/', wd('TRD-25H'), { idem });
  assert.equal(late.status, 409, `幂等记录过期后靠单号拦住，实际 ${late.status} ${JSON.stringify(late.body)}`);
  assert.equal(late.body.error.code, 'duplicate_merchant_ref');
  assert.equal(late.body.error.withdrawal_no, r1.body.withdrawal_no);
  assert.equal(await count(w.db, 'ma'), 1, '不能付第二次');
  const b = await w.balance('ma');
  assert.equal(b.frozen, 11 * U, '只冻结了一次（10 + 手续费 1）');
  await w.db.end();
});

test('TG-1 不填单号照旧可以提交多笔（选填）；空串、空格不算单号', async () => {
  const w = await world();
  for (const ref of [undefined, null, '', '   ', undefined]) {
    const r = await w.api(w.a, 'POST', 'withdrawals/', ref === null ? { ...wd(), merchant_ref: null } : wd(ref));
    assert.equal(r.status, 200, `merchant_ref=${JSON.stringify(ref)}：${JSON.stringify(r.body)}`);
  }
  assert.equal(await count(w.db, 'ma'), 5);
  await w.db.end();
});

test('TG-1 ② 两个商户用同一单号互不影响', async () => {
  const w = await world();
  const ra = await w.api(w.a, 'POST', 'withdrawals/', wd('SAME-REF'));
  const rb = await w.api(w.b, 'POST', 'withdrawals/', wd('SAME-REF'));
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.notEqual(ra.body.withdrawal_no, rb.body.withdrawal_no);
  await w.db.end();
});

test('TG-1 ④ 被驳回、被取消的单号再提交仍被拒（永久唯一，不看状态）', async () => {
  const w = await world();
  const rej = await w.api(w.a, 'POST', 'withdrawals/', wd('REJ-1'));
  await core.rejectWithdrawal(w.db, rej.body.withdrawal_no, '收款地址不对', 'admin');
  const can = await w.api(w.a, 'POST', 'withdrawals/', wd('CAN-1'));
  assert.equal((await w.api(w.a, 'POST', 'withdrawals/cancel/', { withdrawal_no: can.body.withdrawal_no })).body.status, 'cancelled');
  for (const [ref, orig] of [['REJ-1', rej.body.withdrawal_no], ['CAN-1', can.body.withdrawal_no]]) {
    const r = await w.api(w.a, 'POST', 'withdrawals/', wd(ref));
    assert.equal(r.status, 409, `${ref} 已驳回 / 取消，仍要拒收：${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'duplicate_merchant_ref');
    assert.equal(r.body.error.withdrawal_no, orig);
  }
  await w.db.end();
});

test('TG-1 商户后台提币（web）和开放 API 共用同一套唯一：API 用过的单号后台再用被拒', async () => {
  const w = await world();
  const r = await w.api(w.a, 'POST', 'withdrawals/', wd('WEB-API-1'));
  assert.equal(r.status, 200);
  const m = await core.getMerchant(w.db, 'ma');
  await assert.rejects(() => w.ops.withdraw(m, wd('WEB-API-1'), 'web'), (e) => e.code === 'duplicate_merchant_ref' && e.status === 409, '后台提币同号要拒收');
  await w.db.end();
});

test('TG-1 两个同号请求同时到达（不同 Idempotency-Key）：只成功一笔，另一笔 409', async () => {
  const w = await world();
  const rs = await Promise.all([w.api(w.a, 'POST', 'withdrawals/', wd('RACE-1')), w.api(w.a, 'POST', 'withdrawals/', wd('RACE-1'))]);
  const st = rs.map((r) => r.status).sort();
  assert.deepEqual(st, [200, 409], JSON.stringify(rs.map((r) => r.body)));
  assert.equal(await count(w.db, 'ma'), 1);
  assert.equal((await w.balance('ma')).frozen, 11 * U);
  await w.db.end();
});

test('TG-1 ③ 批量打款（开放 API）：同一批两行同号，后一行报 duplicate_merchant_ref，整批不收、不冻结', async () => {
  const w = await world();
  const r = await w.api(w.a, 'POST', 'payouts/batch/', { items: [
    { chain: 'tron', to: TO, amount: '5', merchant_ref: 'B-1' },
    { chain: 'eth', to: ETH_TO, amount: '6', merchant_ref: 'B-2' },
    { chain: 'tron', to: TO2, amount: '7', merchant_ref: 'B-1' },
  ] });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'invalid_rows');
  const row = r.body.error.rows.find((x) => x.index === 2);
  assert.ok(row, `第 3 行（index 2）要报错：${JSON.stringify(r.body.error.rows)}`);
  assert.ok(row.code === 'duplicate_merchant_ref' || row.errors.includes('duplicate_merchant_ref'), JSON.stringify(row));
  assert.ok(!r.body.error.rows.some((x) => x.index === 1), '不重复的行不报错');
  assert.equal(await count(w.db, 'ma'), 0);
  assert.equal((await w.balance('ma')).frozen, 0);
  await w.db.end();
});

test('TG-1 ③ 批量打款：和已有提现（单笔或上一批）同号的那一行报错；不同商户不受影响', async () => {
  const w = await world();
  const single = await w.api(w.a, 'POST', 'withdrawals/', wd('OLD-1'));
  assert.equal(single.status, 200);
  const ok = await w.api(w.a, 'POST', 'payouts/batch/', { items: [{ chain: 'tron', to: TO, amount: '5', merchant_ref: 'BATCH-OLD' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  for (const ref of ['OLD-1', 'BATCH-OLD']) {
    const r = await w.api(w.a, 'POST', 'payouts/batch/', { items: [{ chain: 'tron', to: TO2, amount: '1', merchant_ref: 'NEW-OK' }, { chain: 'tron', to: TO2, amount: '1', merchant_ref: ref }] });
    assert.equal(r.status, 422, `${ref}：${JSON.stringify(r.body)}`);
    const row = r.body.error.rows.find((x) => x.index === 1);
    assert.ok(row && (row.code === 'duplicate_merchant_ref' || row.errors.includes('duplicate_merchant_ref')), JSON.stringify(r.body.error.rows));
  }
  // 另一个商户用同样的单号没问题
  const rb = await w.api(w.b, 'POST', 'payouts/batch/', { items: [{ chain: 'tron', to: TO, amount: '5', merchant_ref: 'OLD-1' }] });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  await w.db.end();
});

test('TG-1 ③ 商户后台上传表格第 2 步（payout-batch-check）：重复单号的行标成有问题的行', async () => {
  const w = await world();
  assert.equal((await w.api(w.a, 'POST', 'withdrawals/', wd('CSV-OLD'))).status, 200);
  const m = await core.getMerchant(w.db, 'ma');
  const r = await w.ops.payoutCheck(m, [
    { chain: 'tron', to: TO, amount: '1', merchant_ref: 'CSV-1', line: 1 },
    { chain: 'tron', to: TO2, amount: '2', merchant_ref: 'CSV-1', line: 2 },
    { chain: 'tron', to: TO2, amount: '3', merchant_ref: 'CSV-OLD', line: 3 },
    { chain: 'tron', to: TO2, amount: '4', merchant_ref: 'CSV-2', line: 4 },
  ]);
  const byLine = Object.fromEntries(r.rows.map((x) => [x.line, x]));
  assert.equal(byLine[2].ok, false, '同一张表第二次出现的单号是有问题的行');
  assert.ok(byLine[2].errors.includes('duplicate_merchant_ref'), JSON.stringify(byLine[2]));
  assert.equal(byLine[3].ok, false, '和已有提现同号是有问题的行');
  assert.ok(byLine[3].errors.includes('duplicate_merchant_ref'), JSON.stringify(byLine[3]));
  assert.equal(byLine[4].ok, true);
  // 只提交没问题的行：重复的不进库
  const s = await w.ops.payoutSubmit(m, [
    { chain: 'tron', to: TO, amount: '1', merchant_ref: 'CSV-3', line: 1 },
    { chain: 'tron', to: TO2, amount: '3', merchant_ref: 'CSV-OLD', line: 2 },
  ], 'web', true);
  assert.equal(s.accepted.length, 1);
  assert.ok(s.rejected_rows.some((x) => x.line === 2 && (x.code === 'duplicate_merchant_ref' || x.errors.includes('duplicate_merchant_ref'))), JSON.stringify(s.rejected_rows));
  await w.db.end();
});

test('TG-1 ⑤ 按单号查：GET withdrawals/?merchant_ref= 查到唯一一笔；别的商户的单号 404；没有的单号 404', async () => {
  const w = await world();
  const r = await w.api(w.a, 'POST', 'withdrawals/', wd('Q-REF-1'));
  await w.api(w.a, 'POST', 'withdrawals/', wd('Q-REF-2'));
  const rb = await w.api(w.b, 'POST', 'withdrawals/', wd('B-ONLY'));
  assert.equal(rb.status, 200);
  const got = await w.api(w.a, 'GET', 'withdrawals/?merchant_ref=Q-REF-1');
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.withdrawal_no, r.body.withdrawal_no);
  assert.equal(got.body.merchant_ref, 'Q-REF-1');
  const cross = await w.api(w.a, 'GET', 'withdrawals/?merchant_ref=B-ONLY');
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error.code, 'not_found');
  assert.equal((await w.api(w.a, 'GET', 'withdrawals/?merchant_ref=NOPE')).status, 404);
  // 原来按提现号查照旧
  assert.equal((await w.api(w.a, 'GET', `withdrawals/?withdrawal_no=${r.body.withdrawal_no}`)).body.merchant_ref, 'Q-REF-1');
  // 批量打款里的单也能按单号查到
  const pb = await w.api(w.a, 'POST', 'payouts/batch/', { items: [{ chain: 'tron', to: TO, amount: '2', merchant_ref: 'Q-BATCH' }] });
  assert.equal(pb.status, 200);
  const gb = await w.api(w.a, 'GET', 'withdrawals/?merchant_ref=Q-BATCH');
  assert.equal(gb.status, 200, JSON.stringify(gb.body));
  assert.equal(gb.body.withdrawal_no, pb.body.items[0].withdrawal_no);
  await w.db.end();
});

test('TG-1 迁移：已有的重复单号保留最早一笔，其余改成 <前 40 字>~<提现号>（≤ 64 字、唯一），每笔记审计；重复执行不再改', async () => {
  const w = await world();
  // 模拟升级前的旧数据：先拿掉 merchant_ref 上的唯一约束（不管研发起什么名字），再写进重复单号
  const idx = await w.db.query(`select indexname from pg_indexes where tablename = 'withdrawals' and indexdef ilike '%unique%' and indexdef ilike '%merchant_ref%'`);
  for (const { indexname } of idx) await w.db.query(`drop index if exists ${indexname}`);
  const cons = await w.db.query(`select conname from pg_constraint where conrelid = 'withdrawals'::regclass and contype = 'u'`);
  for (const { conname } of cons) await w.db.query(`alter table withdrawals drop constraint if exists ${conname}`);
  await w.db.query(`delete from pay_meta where key like 'merchant_ref%'`);
  const long = 'L'.repeat(64);
  const ins = (id, mid, ref, at) => w.db.query(`insert into withdrawals (id, merchant_id, kind, to_address, amount, fee, source, status, merchant_ref, created_at) values ($1, $2, 'payout', $3, $4, 0, 'api', 'rejected', $5, $6)`, [id, mid, TO, U, ref, new Date(at)]);
  const t0 = Date.now() - 10 * DAY;
  await ins('WD-20261101-AAAA', 'ma', 'DUP', t0 + 1000);
  await ins('WD-20261101-BBBB', 'ma', 'DUP', t0);           // 最早的：保留
  await ins('WD-20261101-CCCC', 'ma', 'DUP', t0 + 2000);
  await ins('WD-20261101-DDDD', 'mb', 'DUP', t0 + 5000);    // 别的商户：不算重复
  await ins('WD-20261101-EEEE', 'ma', long, t0);
  await ins('WD-20261101-FFFF', 'ma', long, t0 + 1);
  await ins('WD-20261101-GGGG', 'ma', null, t0);
  await ins('WD-20261101-HHHH', 'ma', null, t0);
  await migrate(w.db);
  const ref = async (id) => (await w.db.query('select merchant_ref from withdrawals where id = $1', [id]))[0].merchant_ref;
  assert.equal(await ref('WD-20261101-BBBB'), 'DUP', '最早的一笔保留原单号');
  assert.equal(await ref('WD-20261101-AAAA'), 'DUP~WD-20261101-AAAA');
  assert.equal(await ref('WD-20261101-CCCC'), 'DUP~WD-20261101-CCCC');
  assert.equal(await ref('WD-20261101-DDDD'), 'DUP', '别的商户的同号不动');
  assert.equal(await ref('WD-20261101-EEEE'), long);
  const f = await ref('WD-20261101-FFFF');
  assert.equal(f, `${'L'.repeat(40)}~WD-20261101-FFFF`);
  assert.ok(f.length <= 64);
  assert.equal(await ref('WD-20261101-GGGG'), null, '没填单号的不动');
  const audits = await w.db.query(`select target, detail from pay_audit where action = 'withdrawal.merchant_ref_dedup' order by target`);
  assert.deepEqual(audits.map((x) => x.target), ['WD-20261101-AAAA', 'WD-20261101-CCCC', 'WD-20261101-FFFF']);
  const a0 = audits[0].detail;
  assert.equal(a0.before, 'DUP');
  assert.equal(a0.after, 'DUP~WD-20261101-AAAA');
  // 迁移后唯一约束生效：再插同号被数据库拒绝
  await assert.rejects(() => ins('WD-20261101-IIII', 'ma', 'DUP', t0 + 9000), /unique|duplicate/i);
  // 重复执行：不再改、不再记审计
  await migrate(w.db);
  assert.equal((await w.db.query(`select count(*)::int n from pay_audit where action = 'withdrawal.merchant_ref_dedup'`))[0].n, 3);
  await w.db.end();
});

test('TG-1 开发者文档：单号说明写"同一商户永久唯一"；错误码表有 409 duplicate_merchant_ref；查询提币可按 merchant_ref', () => {
  const post = ENDPOINTS.find((e) => e.method === 'POST' && e.path === 'withdrawals/');
  const p = post.body.find((x) => x[0] === 'merchant_ref');
  assert.match(p[3][0], /unique/i, `英文说明：${p[3][0]}`);
  assert.match(p[3][1], /永久唯一/, `中文说明：${p[3][1]}`);
  assert.ok(post.errors.includes('duplicate_merchant_ref'), 'POST withdrawals/ 的错误码要有 duplicate_merchant_ref');
  const e = ERRORS.find((x) => x[1] === 'duplicate_merchant_ref');
  assert.ok(e, '错误码表要有 duplicate_merchant_ref');
  assert.equal(e[0], '409');
  assert.match(e[2][0], /withdrawal_no/, '说明要写明 error.withdrawal_no 是原来那笔');
  const get = ENDPOINTS.find((x) => x.method === 'GET' && x.path === 'withdrawals/');
  assert.ok((get.query || []).some((q) => q[0] === 'merchant_ref'), 'GET withdrawals/ 要有 merchant_ref 查询参数');
  const batch = ENDPOINTS.find((x) => x.method === 'POST' && x.path === 'payouts/batch/');
  assert.match(batch.note[0], /duplicate_merchant_ref/, '批量打款的说明要写到重复单号的行错误码');
});
