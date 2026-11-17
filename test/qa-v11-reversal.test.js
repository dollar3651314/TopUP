// 测试先写（v1.1）：到账入账后链上消失 → 冲正（账本追加、到账标已冲正、解除订单匹配、回调 deposit.reversed、邮件），余额不够记欠款。
// 依据：v1.1 开放 API 补接口需求的"冲正通知"一节（已定：余额不够时可用余额扣到 0、差额记进"欠款"，保留"余额不许为负"的约束，
//   欠款不为 0 期间不能提现，以后到账先还欠款，邮件通知管理员）；原型已通过（账本加"还欠款"一类、不加主动还款按钮、冲正记录可标记已处理）。
//
// 给研发的接口约定（需求没写死的地方由测试定，照着做）：
//   - 新文件 server/pay/reversal.js：
//       recheckDeposits(db, { now, check, notify, limit }) → { checked, reversed, inconclusive }：worker 每轮调用（tick 里加一步）。
//         只看入账（deposits.created_at）后 24 小时内、result = 'credited' 的到账；每笔在这 24 小时内至少复核 2 次（时点研发定，
//         只要 worker 每 10 分钟以内调一次就能做到）。check({ id, chain, txid, logIndex, block, address, amount }) 由链适配器提供：
//         resolve true = 还在链上，false = 没了；抛错 = 节点连不上 / 出错，不下结论（不冲正，下一轮再查）。
//         每次复核记一行 deposit_rechecks（deposit_id、checked_at = now、result：'present' | 'gone' | 'error'）。
//         check 返回 false 后可以先记嫌疑、下一轮再确认（两轮），但要在入账后 24 小时内完成冲正。
//       reverseDeposit(db, depositId, { now, notify }) → { status: 'reversed' | 'already_reversed' }：执行一次冲正；同一笔第二次调用什么都不改。
//   - 冲正：一个事务里——
//       ① 账本追加一条 type 'reversal'（ref 同到账那两条：交易哈希前 16 位；customer_id 同到账），amount = −实际从可用余额扣掉的金额；
//          要扣的是"入账金额"（到账金额 − 收款手续费，即手续费退回）；可用余额不够时扣到 0，差额加进 balances.debt（新列，bigint，≥ 0，默认 0）；
//          balances.available ≥ 0 的约束保留。账本加一列 debt_after（变动后欠款），旧记录为 0。
//       ② deposits.result = 'reversed'、deposits.reversed_at = now；匹配过的订单解除匹配（订单 matched 减去、状态重算）并发 order.matched 回调。
//       ③ 回调 deposit.reversed，data 至少有 customer_id、chain、address、txid、amount、fee、credited、order_no（冲正前匹配的订单，没有为 null）、reversed_at。
//       ④ notify(标题, 正文)：标题含"冲正"，正文含交易哈希；记了欠款时正文含"欠款"和欠款金额。
//       ⑤ 运营后台异常到账：anomalies 加一行 type 'reversal'（merchant_id、customer_id、address、amount、ref 含交易哈希），沿用 anomaly-handle 标记已处理。
//   - 欠款：balances.debt > 0 时提币（开放 API POST withdrawals/、POST payouts/batch/，商户后台提币、批量打款）一律 409 'debt_outstanding'，不冻结；
//     取消提币不受影响（取消退回的冻结回到可用余额，不自动还欠款）。之后每笔到账：照旧记 deposit、fee_in，再追加一条 type 'debt_repay'（amount = −还掉的金额 = min(到账后的可用余额, 欠款)，debt_after 变小），先还欠款。
//   - 对外：GET balance/ 加 debt；GET deposits/ 里冲正过的到账 result = 'reversed'，加字段 reversed_at（没冲正为 null）；
//     GET ledger/ 的类型多 reversal、debt_repay，每条加 debt_after；商户后台 overview 加 debt。金额字段一律是字符串。
//   - 开发者文档：回调事件加 deposit.reversed，写明"不认识的事件请忽略并返回 200"；错误码表加 409 debt_outstanding；上面新字段都写进对象。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, U, TO, HOUR, DAY } from './qa-v11-helpers.js';
import * as core from '../server/pay/core.js';
import { deliverDue, signCallback, RETRY_MIN } from '../server/pay/callbacks.js';
import { readFileSync } from 'node:fs';
import { EVENTS, ERRORS, OBJECTS, EVENT_ENVELOPE } from '../site/src/docs/api-reference.mjs';

const MIN = 60_000;
const rev = () => import('../server/pay/reversal.js');

/** 商户 ma 的客户 c1 收到一笔 100 USDT（收款手续费 1%：入账 99） */
async function setup({ fund = 0 } = {}) {
  const w = await world({ fund });
  const addr = await w.customer('ma', 'c1');
  const deposit = async (amount = 100, time = new Date()) => {
    const txid = w.txid();
    const r = await core.recordDeposit(w.db, { txid, logIndex: 0, block: 1, to: addr, amount: amount * U, time });
    assert.equal(r.status, 'credited');
    return { id: String(r.deposit.id), txid, order: r.order };
  };
  const dep = async (id) => (await w.db.query('select * from deposits where id = $1', [Number(id)]))[0];
  const ledger = async () => w.db.query(`select * from ledger where merchant_id = 'ma' order by id`);
  const callbacks = async (event) => w.db.query(`select * from callbacks where merchant_id = 'ma' and event = $1 order by created_at`, [event]);
  return { ...w, addr, deposit, dep, ledger, callbacks };
}
/** 从 start 起每 10 分钟调一次 recheckDeposits，直到 until（毫秒） */
async function runRechecks(t, { check, from = Date.now(), until = from + 25 * HOUR, stepMs = 10 * MIN, stopWhen = null }) {
  const { recheckDeposits } = await rev();
  for (let at = from; at <= until; at += stepMs) {
    await recheckDeposits(t.db, { now: at, check, notify: t.notify });
    if (stopWhen && (await stopWhen())) return at;
  }
  return null;
}

test('TG-11 ① 冲正（余额够）：账本只追加一条 reversal（扣回入账、退回手续费），到账标已冲正，余额对得上', async () => {
  const t = await setup();
  const d = await t.deposit(100);
  const before = await t.ledger();
  assert.equal((await t.balance('ma')).available, 99 * U);
  const { reverseDeposit } = await rev();
  const r = await reverseDeposit(t.db, d.id, { now: Date.now(), notify: t.notify });
  assert.equal(r.status, 'reversed');
  const after = await t.ledger();
  assert.equal(after.length, before.length + 1, '账本只多一条');
  assert.deepEqual(after.slice(0, before.length), before, '旧记录不改');
  const last = after.at(-1);
  assert.equal(last.type, 'reversal');
  assert.equal(Number(last.amount), -99 * U, '扣回入账金额（100 − 手续费 1）');
  assert.equal(last.ref, d.txid.slice(0, 16));
  assert.equal(last.customer_id, 'c1');
  assert.equal(Number(last.available_after), 0);
  assert.equal(Number(last.debt_after), 0);
  const b = await t.balance('ma');
  assert.equal(Number(b.available), 0);
  assert.equal(Number(b.debt), 0);
  const row = await t.dep(d.id);
  assert.equal(row.result, 'reversed');
  assert.ok(row.reversed_at);
  // 开放 API：到账显示已冲正、余额带欠款、账本有 reversal
  const deps = await t.api(t.a, 'GET', 'deposits/');
  const it = deps.body.items.find((x) => x.id === d.id);
  assert.ok(it, '冲正过的到账商户仍能看到');
  assert.equal(it.result, 'reversed');
  assert.match(it.reversed_at, /^\d{4}-\d{2}-\d{2}T/);
  const bal = await t.api(t.a, 'GET', 'balance/');
  assert.equal(bal.body.debt, '0.00');
  const led = await t.api(t.a, 'GET', 'ledger/');
  assert.equal(led.body.items[0].type, 'reversal');
  assert.equal(led.body.items[0].amount, '-99.00');
  assert.equal(led.body.items[0].debt_after, '0.00');
  await t.db.end();
});

test('TG-11 ① 匹配过订单的到账被冲正：解除匹配、订单 matched 减回、发 order.matched 回调', async () => {
  const t = await setup();
  const o = await t.ops.createOrder(await core.getMerchant(t.db, 'ma'), { customer_id: 'c1', merchant_order_no: 'O-1', amount: '100' });
  const d = await t.deposit(100);
  assert.equal(d.order, o.order_no, '前提：到账自动匹配到订单');
  const n0 = (await t.callbacks('order.matched')).length;
  const { reverseDeposit } = await rev();
  await reverseDeposit(t.db, d.id, { now: Date.now(), notify: t.notify });
  const row = await t.dep(d.id);
  assert.equal(row.order_id, null, '解除匹配');
  const [ord] = await t.db.query('select matched, status from orders where id = $1', [o.order_no]);
  assert.equal(Number(ord.matched), 0);
  assert.ok(['pending', 'expired'].includes(ord.status), ord.status);
  const cbs = await t.callbacks('order.matched');
  assert.equal(cbs.length, n0 + 1, '要发 order.matched');
  assert.equal(cbs.at(-1).payload.data.order_no, o.order_no);
  const rv = (await t.callbacks('deposit.reversed'))[0];
  assert.equal(rv.payload.data.order_no, o.order_no, 'deposit.reversed 带冲正前匹配的订单');
  await t.db.end();
});

test('TG-11 ② 回调 deposit.reversed：内容（链、交易哈希、金额、冲正时间）、签名正确、失败按现有规则重试', async () => {
  const t = await setup();
  const d = await t.deposit(100);
  const at = Date.now();
  const { reverseDeposit } = await rev();
  await reverseDeposit(t.db, d.id, { now: at, notify: t.notify });
  const [cb] = await t.callbacks('deposit.reversed');
  assert.ok(cb, '要生成 deposit.reversed 回调');
  const data = cb.payload.data;
  for (const k of ['customer_id', 'chain', 'address', 'txid', 'amount', 'fee', 'credited', 'order_no', 'reversed_at']) assert.ok(k in data, `data 缺 ${k}`);
  assert.equal(data.chain, 'tron');
  assert.equal(data.txid, d.txid);
  assert.equal(data.customer_id, 'c1');
  assert.equal(data.reversed_at, new Date(at).toISOString());
  const sent = [];
  let fail = true;
  const target = { url: 'https://merchant.example/cb', secret: 's3cret' };
  const deliver = (now) => deliverDue(t.db, { now, getTarget: async () => target, resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, init) => { sent.push(init); return { status: fail ? 500 : 200 }; } });
  await t.db.query(`update callbacks set status = 'ok' where event <> 'deposit.reversed'`);
  const t0 = new Date();
  await deliver(t0);
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].body);
  assert.equal(body.type, 'deposit.reversed');
  assert.equal(body.data.amount, '100.00', '金额是字符串');
  assert.equal(body.data.credited, '99.00');
  const h = sent[0].headers;
  assert.equal(h['X-TopUP-Signature'], signCallback('s3cret', h['X-TopUP-Timestamp'], sent[0].body), '签名正确');
  const [after1] = await t.callbacks('deposit.reversed');
  assert.equal(after1.status, 'pending', '失败后等重试');
  assert.equal(after1.attempts, 1);
  assert.equal(new Date(after1.next_at).getTime(), t0.getTime() + RETRY_MIN[0] * MIN, '按现有规则（1 分钟后）重试');
  fail = false;
  await deliver(new Date(t0.getTime() + RETRY_MIN[0] * MIN));
  assert.equal((await t.callbacks('deposit.reversed'))[0].status, 'ok');
  await t.db.end();
});

test('TG-11 ③④ 邮件通知管理员；同一笔不会冲正两次（直接调、复核再看到都不会）', async () => {
  const t = await setup({ fund: 50 });
  const d = await t.deposit(100);
  const { reverseDeposit } = await rev();
  await reverseDeposit(t.db, d.id, { now: Date.now(), notify: t.notify });
  assert.equal(t.mails.length, 1, '发一封邮件');
  assert.match(t.mails[0].subject, /冲正/);
  assert.ok(t.mails[0].text.includes(d.txid), '正文写交易哈希');
  const n = (await t.ledger()).length, bal = await t.balance('ma');
  const again = await reverseDeposit(t.db, d.id, { now: Date.now(), notify: t.notify });
  assert.equal(again.status, 'already_reversed');
  await runRechecks(t, { check: async () => false, until: Date.now() + 2 * HOUR });
  assert.equal((await t.ledger()).length, n, '不能再记一次冲正');
  assert.deepEqual(await t.balance('ma'), bal);
  assert.equal((await t.callbacks('deposit.reversed')).length, 1, '只发一次回调');
  assert.equal(t.mails.length, 1, '只发一封邮件');
  assert.equal((await t.db.query(`select count(*)::int n from anomalies where type = 'reversal'`))[0].n, 1);
  await t.db.end();
});

test('TG-11 复核发现链上没了：24 小时内自动冲正（recheckDeposits 调 check 得到 false）；运营后台异常到账列出、可标记已处理', async () => {
  const t = await setup({ fund: 10 });
  const d = await t.deposit(100);
  const keep = await t.deposit(20);
  const gone = new Set([d.txid]);
  const start = Date.now();
  const hit = await runRechecks(t, { check: async (x) => !gone.has(x.txid), stopWhen: async () => (await t.dep(d.id)).result === 'reversed' });
  assert.ok(hit !== null, '链上没了的到账要被冲正');
  assert.ok(hit - start <= 24 * HOUR, `要在入账后 24 小时内冲正，实际 ${(hit - start) / HOUR} 小时`);
  assert.equal((await t.dep(keep.id)).result, 'credited', '还在链上的不动');
  const [an] = await t.db.query(`select * from anomalies where type = 'reversal'`);
  assert.ok(an, '异常到账要有冲正记录');
  assert.equal(an.merchant_id, 'ma');
  assert.ok(an.ref.includes(d.txid));
  assert.equal(an.handled, false);
  // 运营后台：沿用"异常到账"的列表和标记已处理
  const { createWalletApi } = await import('../server/pay/wallet-api.js');
  const wapi = createWalletApi({ db: t.db, tron: {}, keys: {}, wallets: {}, requireAdmin: async () => {}, verifyAdminCode: async () => true });
  const call = async (a, body) => { const r = await wapi(new Request(`https://x/api/wallet/?a=${a}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } })); return { status: r.status, body: await r.json() }; };
  const list = await call('anomalies');
  const item = list.body.items.find((x) => x.type === 'reversal');
  assert.ok(item, JSON.stringify(list.body));
  assert.equal((await call('anomaly-handle', { id: item.id })).status, 200);
  assert.equal((await call('anomalies')).body.items.find((x) => x.type === 'reversal').handled, true);
  assert.equal(Number((await t.balance('ma')).available), 10 * U + 20 * U - 0.2 * U, '标记已处理不动钱');
  await t.db.end();
});

test('TG-11 ⑤ 复核时节点连不上不算消失：不冲正，记 error，下一轮再查', async () => {
  const t = await setup();
  const d = await t.deposit(100);
  const bal = await t.balance('ma');
  const r = await runRechecks(t, { check: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
  assert.equal(r, null);
  assert.equal((await t.dep(d.id)).result, 'credited', '节点连不上不能冲正');
  assert.deepEqual(await t.balance('ma'), bal);
  assert.equal((await t.callbacks('deposit.reversed')).length, 0);
  const rows = await t.db.query('select result from deposit_rechecks where deposit_id = $1', [Number(d.id)]);
  assert.ok(rows.length >= 1 && rows.every((x) => x.result === 'error'), `连不上要记 error：${JSON.stringify(rows)}`);
  // 有的轮次连不上、有的查到还在：照样不冲正
  const d2 = await t.deposit(30);
  let n = 0;
  await runRechecks(t, { check: async () => { if (++n % 2) throw new Error('timeout'); return true; } });
  assert.equal((await t.dep(d2.id)).result, 'credited');
  await t.db.end();
});

test('TG-11 ⑥ 入账后 24 小时内每笔到账至少被复核 2 次（造 5 笔，时间调快，按复核记录逐笔计数）', async () => {
  const t = await setup();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await t.deposit(10 + i)).id);
  const created = Object.fromEntries((await t.db.query('select id, created_at from deposits where id = any($1::bigint[])', [ids.map(Number)])).map((r) => [String(r.id), new Date(r.created_at).getTime()]));
  const calls = [];
  await runRechecks(t, { check: async (x) => { calls.push(x); return true; } });
  for (const id of ids) {
    const rows = await t.db.query(`select checked_at, result from deposit_rechecks where deposit_id = $1 and result = 'present'`, [Number(id)]);
    const within = rows.filter((r) => new Date(r.checked_at).getTime() - created[id] <= 24 * HOUR);
    assert.ok(within.length >= 2, `到账 ${id} 入账后 24 小时内只复核了 ${within.length} 次`);
  }
  assert.ok(calls.every((x) => x.txid && x.chain && 'logIndex' in x), 'check 拿到链、交易哈希、日志序号');
  for (const id of ids) assert.equal((await t.dep(id)).result, 'credited');
  await t.db.end();
});

test('TG-11 ⑦ 余额不够扣：可用余额扣到 0（不变负），差额进欠款；提币被挡（409 debt_outstanding）；下一笔到账先还欠款（debt_repay）；邮件写欠款', async () => {
  const t = await setup();
  const d = await t.deposit(100); // 入账 99
  // 商户先提走一部分：冻结 50 + 1
  const w0 = await t.api(t.a, 'POST', 'withdrawals/', { kind: 'payout', chain: 'tron', to: TO, amount: '50' });
  assert.equal(w0.status, 200);
  assert.equal(Number((await t.balance('ma')).available), 48 * U);
  const { reverseDeposit } = await rev();
  await reverseDeposit(t.db, d.id, { now: Date.now(), notify: t.notify });
  const b = await t.balance('ma');
  assert.equal(Number(b.available), 0, '扣到 0');
  assert.equal(Number(b.frozen), 51 * U, '冻结的不动');
  assert.equal(Number(b.debt), 51 * U, '差额 99 − 48 = 51 记成欠款');
  const last = (await t.ledger()).at(-1);
  assert.equal(last.type, 'reversal');
  assert.equal(Number(last.amount), -48 * U, '账本记实际扣掉的');
  assert.equal(Number(last.debt_after), 51 * U);
  assert.match(t.mails.at(-1).text, /欠款/);
  assert.match(t.mails.at(-1).text, /51/);
  // 余额不许为负的约束还在
  await assert.rejects(() => t.db.query(`update balances set available = -1 where merchant_id = 'ma'`), /check|constraint/i);
  // 有欠款：提币一律被挡，返回明确错误码
  await t.db.query(`update balances set available = 1000000000 where merchant_id = 'ma'`); // 就算有可用余额也挡
  const w1 = await t.api(t.a, 'POST', 'withdrawals/', { kind: 'payout', chain: 'tron', to: TO, amount: '1' });
  assert.equal(w1.status, 409, JSON.stringify(w1.body));
  assert.equal(w1.body.error.code, 'debt_outstanding');
  const pb = await t.api(t.a, 'POST', 'payouts/batch/', { items: [{ chain: 'tron', to: TO, amount: '1' }] });
  assert.equal(pb.status, 409, JSON.stringify(pb.body));
  assert.equal(pb.body.error.code, 'debt_outstanding');
  const mm = await core.getMerchant(t.db, 'ma');
  await assert.rejects(() => t.ops.withdraw(mm, { kind: 'payout', chain: 'tron', to: TO, amount: '1' }, 'web'), (e) => e.code === 'debt_outstanding' && e.status === 409, '商户后台提币也挡');
  await assert.rejects(() => t.ops.payoutSubmit(mm, [{ chain: 'tron', to: TO, amount: '1', line: 1 }], 'web', false), (e) => e.code === 'debt_outstanding', '商户后台批量打款也挡');
  assert.equal((await t.balance('ma')).frozen, 51 * U, '被挡的不冻结');
  await t.db.query(`update balances set available = 0 where merchant_id = 'ma'`);
  // 取消已有的提币不受影响
  assert.equal((await t.api(t.a, 'POST', 'withdrawals/cancel/', { withdrawal_no: w0.body.withdrawal_no })).status, 200);
  assert.equal(Number((await t.balance('ma')).debt), 51 * U);
  assert.equal(Number((await t.balance('ma')).available), 51 * U, '取消退回冻结的 51');
  // 开放 API 看得到欠款
  assert.equal((await t.api(t.a, 'GET', 'balance/')).body.debt, '51.00');
  // 下一笔到账 30（入账 29.7）：先还欠款 51（可用余额 51 + 29.7 够还清）
  const n0 = (await t.ledger()).length;
  await t.deposit(30);
  const rows = (await t.ledger()).slice(n0);
  assert.deepEqual(rows.map((x) => x.type), ['deposit', 'fee_in', 'debt_repay'], '到账、手续费照旧各一行，再追加一行还欠款');
  const repay = rows[2];
  assert.equal(Number(repay.amount), -51 * U);
  assert.equal(Number(repay.debt_after), 0);
  const b2 = await t.balance('ma');
  assert.equal(Number(b2.debt), 0);
  assert.equal(Number(b2.available), 29_700_000);
  // 还清后能提币
  assert.equal((await t.api(t.a, 'POST', 'withdrawals/', { kind: 'payout', chain: 'tron', to: TO, amount: '1' })).status, 200);
  await t.db.end();
});

test('TG-11 ⑦ 一笔到账不够还清：还一部分，欠款减少、可用余额 0，仍不能提币', async () => {
  const t = await setup();
  const d = await t.deposit(100);
  await t.db.query(`update balances set available = 0 where merchant_id = 'ma'`); // 钱已经花掉（测试直接清零）
  const { reverseDeposit } = await rev();
  await reverseDeposit(t.db, d.id, { now: Date.now(), notify: t.notify });
  assert.equal(Number((await t.balance('ma')).debt), 99 * U);
  await t.deposit(50); // 入账 49.5
  const b = await t.balance('ma');
  assert.equal(Number(b.available), 0);
  assert.equal(Number(b.debt), 49.5 * U);
  const last = (await t.ledger()).at(-1);
  assert.equal(last.type, 'debt_repay');
  assert.equal(Number(last.amount), -49.5 * U);
  assert.equal(Number(last.debt_after), 49.5 * U);
  assert.equal((await t.api(t.a, 'POST', 'withdrawals/', { kind: 'payout', chain: 'tron', to: TO, amount: '1' })).body.error.code, 'debt_outstanding');
  await t.db.end();
});

test('TG-11 数据结构：旧记录不动（到账 credited、欠款 0、账本 debt_after 0）；账本类型约束放进 reversal、debt_repay；到账结果放进 reversed', async () => {
  const t = await setup();
  const d = await t.deposit(10);
  assert.equal((await t.dep(d.id)).result, 'credited');
  assert.equal(Number((await t.balance('ma')).debt), 0);
  assert.ok((await t.ledger()).every((x) => Number(x.debt_after) === 0));
  await t.db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ('ma', 'reversal', 0, 0, 0, 'x'), ('ma', 'debt_repay', 0, 0, 0, 'y')`);
  await t.db.query(`update deposits set result = 'reversed' where id = $1`, [Number(d.id)]);
  await assert.rejects(() => t.db.query(`update balances set debt = -1 where merchant_id = 'ma'`), /check|constraint/i, '欠款不能为负');
  await t.db.end();
});

test('TG-11 开发者文档：回调事件有 deposit.reversed（写明不认识的事件忽略并返回 200）；错误码表有 409 debt_outstanding；余额有 debt', () => {
  const ev = EVENTS.find((e) => e.type === 'deposit.reversed');
  assert.ok(ev, '回调事件要有 deposit.reversed');
  const fields = [...ev.data.flatMap((n) => OBJECTS[n] || []), ...(ev.extra || [])].map((f) => f[0]);
  for (const k of ['chain', 'txid', 'amount', 'reversed_at']) assert.ok(fields.includes(k), `deposit.reversed 的 data 要写 ${k}`);
  assert.match(EVENT_ENVELOPE.find((f) => f[0] === 'type')[2][1], /deposit\.reversed/);
  const src = readFileSync(new URL('../site/src/docs/api-reference.mjs', import.meta.url), 'utf8');
  assert.match(src, /不认识的事件请忽略并返回 200/);
  assert.match(src, /[Ii]gnore.{0,40}unknown|unknown.{0,60}ignore/i);
  const e = ERRORS.find((x) => x[1] === 'debt_outstanding');
  assert.ok(e, '错误码表要有 debt_outstanding');
  assert.equal(e[0], '409');
  assert.ok(OBJECTS.Balance.some((f) => f[0] === 'debt'), '余额对象要有 debt');
  assert.ok(Object.values(OBJECTS).flat().some((f) => f[0] === 'reversed_at'), '到账对象要有 reversed_at');
  assert.ok(Object.values(OBJECTS).flat().some((f) => f[0] === 'debt_after'), '账本对象要有 debt_after');
});
