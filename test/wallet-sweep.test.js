// 归集（ETH / BSC，半自动）：
//   - 预览（凑批）：门槛 ETH 100 / BSC 10 USDT；上线初期上限每地址每次 ≤ 5,000、每批 ≤ 20,000 USDT（在后端预览时检查，合约里没有）；手续费占比；每批地址数
//   - 系统凑好批次、发邮件，管理员在后台确认才执行；没确认之前不发任何链上交易
//   - 归集不写账本、不改商户余额
//   - 归集出错只进告警（邮件），不影响扫链等其他任务，worker 照常记运行时间（健康检查不因此变差）
// 要实现的模块：server/wallet/sweep.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, moneySnapshot } from './wallet-helpers.js';

const sweepMod = () => import('../server/wallet/sweep.js');
const U = (usdt) => BigInt(Math.round(usdt * 1e6)); // USDT → 0.000001 USDT 单位（bigint）
const cand = (address, usdt, extra = {}) => ({ address, salt: '0x' + address.slice(2).padStart(64, '0'), schemeVer: 1, balance: U(usdt), deployed: false, estFee: null, ...extra });
const A = (n) => '0x' + String(n).padStart(40, '0');

// ---------- 默认值 ----------

test('默认值：门槛 ETH 100、BSC 10、TRON 100 USDT；每地址每次 5,000、每批 20,000 USDT；手续费占比上限 3%', async () => {
  const { SWEEP_DEFAULTS } = await sweepMod();
  assert.deepEqual(SWEEP_DEFAULTS.thresholds, { eth: U(100), bsc: U(10), tron: U(100) });
  assert.equal(SWEEP_DEFAULTS.capPerAddress, U(5000));
  assert.equal(SWEEP_DEFAULTS.capPerBatch, U(20000));
  assert.equal(SWEEP_DEFAULTS.maxFeeRatioPct, 3);
});

// ---------- 预览（纯计算） ----------

const LIM = { threshold: U(100), capPerAddress: U(5000), capPerBatch: U(20000), maxFeeRatioPct: 3, maxAddresses: 100, schemeVer: 1 };

test('预览：低于门槛的跳过（等于门槛的归集）；余额为 0 的不列出', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 99.999999), cand(A(2), 100), cand(A(3), 0)], LIM);
  assert.deepEqual(p.items.map((i) => i.address), [A(2)]);
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]), [[A(1), 'belowThreshold']]);
  assert.equal(p.total, U(100));
  // BSC 门槛 10
  const b = planSweep([cand(A(4), 10), cand(A(5), 9.99)], { ...LIM, threshold: U(10) });
  assert.deepEqual(b.items.map((i) => i.address), [A(4)]);
});

test('预览：单个地址超过 5,000 的这次跳过（不拆成部分归集），等于 5,000 的归集', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 5000), cand(A(2), 5000.000001), cand(A(3), 6000)], LIM);
  assert.deepEqual(p.items.map((i) => [i.address, i.amount]), [[A(1), U(5000)]]);
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]).sort(), [[A(2), 'overAddressCap'], [A(3), 'overAddressCap']]);
});

test('预览：每批合计 ≤ 20,000——按余额从大到小装，装不下的跳过、继续看更小的；正好 20,000 可以', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 4000), cand(A(2), 5000), cand(A(3), 5000), cand(A(4), 5000), cand(A(5), 4500), cand(A(6), 1000)], LIM);
  // 5000 + 5000 + 5000 = 15000；+4500 = 19500；+4000 超了跳过；+1000 超了跳过
  assert.deepEqual(p.items.map((i) => i.amount), [U(5000), U(5000), U(5000), U(4500)]);
  assert.equal(p.total, U(19500));
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]).sort(), [[A(1), 'overBatchCap'], [A(6), 'overBatchCap']]);
  const exact = planSweep([cand(A(1), 5000), cand(A(2), 5000), cand(A(3), 5000), cand(A(4), 5000)], LIM);
  assert.equal(exact.total, U(20000));
  assert.equal(exact.items.length, 4);
  assert.ok(exact.total <= LIM.capPerBatch);
});

test('预览：上限是 0 表示不限（后台可改）；每批地址数满了的跳过（batchFull）', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 9000), cand(A(2), 30000)], { ...LIM, capPerAddress: 0n, capPerBatch: 0n });
  assert.equal(p.total, U(39000));
  const q = planSweep([cand(A(1), 300), cand(A(2), 200), cand(A(3), 100)], { ...LIM, maxAddresses: 2 });
  assert.deepEqual(q.items.map((i) => i.address), [A(1), A(2)]);
  assert.deepEqual(q.skipped.map((s) => [s.address, s.reason]), [[A(3), 'batchFull']]);
});

test('预览：手续费占比超过上限的跳过（预估手续费折 USDT > 余额 × 3%）；不知道价格（estFee 为空）时不按占比跳过', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 100, { estFee: U(3) }), cand(A(2), 100, { estFee: U(3.000001) }), cand(A(3), 100, { estFee: null })], LIM);
  assert.deepEqual(p.items.map((i) => i.address).sort(), [A(1), A(3)]);
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]), [[A(2), 'feeRatio']]);
});

test('预览：已经在别的批次里的、方案版本不是当前这套的跳过；结果里每个地址只出现一次，金额都是 bigint', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 500, { inBatch: true }), cand(A(2), 500, { schemeVer: 2 }), cand(A(3), 500, { deployed: true }), cand(A(4), 400)], LIM);
  assert.deepEqual(p.items.map((i) => [i.address, i.deploy]), [[A(3), false], [A(4), true]]);
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]).sort(), [[A(1), 'inBatch'], [A(2), 'otherScheme']]);
  for (const i of p.items) { assert.equal(typeof i.amount, 'bigint'); assert.match(i.salt, /^0x[0-9a-f]{64}$/); }
  const all = [...p.items, ...p.skipped].map((x) => x.address);
  assert.equal(new Set(all).size, all.length);
});

// ---------- 半自动：凑批 → 管理员确认 → 执行 ----------

/** 假的 contract 提供方：地址余额由 balances 给定；记下 executeSweep 的调用 */
function fakeContract(balances, { failStatus = false } = {}) {
  const executed = [];
  return {
    id: 'contract', enabled: true, executed,
    capabilities: () => ({ batchSweep: true, batchPayout: false, selfScan: true, webhook: false }),
    async balance(chain, { address }) { return balances[address] ?? 0n; },
    async planSweep(chain, candidates, limits) { const { planSweep } = await sweepMod(); return { chain, ...planSweep(candidates, limits) }; },
    async executeSweep(plan) { executed.push(plan); return { txRefs: ['0x' + 'aa'.repeat(32)] }; },
    async txStatus() { if (failStatus) throw new Error('node down'); return 'confirmed'; },
    async estimateFee() { return { native: 0n, detail: 'fake' }; },
  };
}

async function seedAddresses(db, chain, list) {
  let i = 0;
  for (const address of list) {
    i++;
    await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status)
      values ('m1', $1, $2, 'contract', 1, $3, $4, 'active')`, [`c${i}`, chain, '0x' + String(i).padStart(64, '0'), address]);
  }
}

test('半自动：凑批只建"待确认"的批次并发一封邮件，不发链上交易；确认（原因必填）后才执行，且只执行一次', async () => {
  const { proposeSweep, approveSweep } = await sweepMod();
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2'], ['m1', 'c3']] });
  await seedAddresses(db, 'eth', [A(1), A(2), A(3)]);
  const p = fakeContract({ [A(1)]: U(150), [A(2)]: U(6000), [A(3)]: U(50) });
  const providers = { contract: p };
  const mails = [];
  const notify = async (subject, text) => { mails.push({ subject, text }); };
  const money0 = await moneySnapshot(db);

  const b = await proposeSweep(db, { chain: 'eth', providers, notify });
  assert.equal(b.status, 'awaiting_approval');
  assert.equal(b.chain, 'eth');
  assert.equal(b.provider, 'contract');
  assert.deepEqual(b.items.map((i) => [i.address, i.amount]), [[A(1), U(150)]]); // 6000 超单地址上限、50 低于门槛
  assert.equal(b.total, U(150));
  assert.equal(p.executed.length, 0, '没确认之前不执行');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /归集待确认/);
  assert.match(mails[0].text, /150/);

  // 同一条链已经有待确认的批次：再凑批返回同一批，不重复发邮件
  const again = await proposeSweep(db, { chain: 'eth', providers, notify });
  assert.equal(again.id, b.id);
  assert.equal(mails.length, 1);

  await assert.rejects(approveSweep(db, { id: b.id, actor: 'admin@x', reason: '', providers }), (e) => e.code === 'reason_required');
  assert.equal(p.executed.length, 0);
  const r = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: '本周归集', providers });
  assert.equal(r.status, 'sent');
  assert.deepEqual(r.txRefs, ['0x' + 'aa'.repeat(32)]);
  assert.equal(p.executed.length, 1);
  assert.deepEqual(p.executed[0].items.map((i) => i.address), [A(1)]);
  await assert.rejects(approveSweep(db, { id: b.id, actor: 'admin@x', reason: '再点一次', providers }), (e) => e.code === 'batch_state');
  assert.equal(p.executed.length, 1, '重复确认不会再发一次');
  // 审计：谁确认的、原因
  const audit = JSON.stringify(await db.query(`select actor, detail from pay_audit where actor = 'admin@x'`));
  assert.ok(audit.includes('本周归集'));

  assert.equal(await moneySnapshot(db), money0, '归集不写账本、不改商户余额');
  await db.end?.();
});

test('半自动：没有达到条件的地址时不建批次、不发邮件；BSC 用 BSC 的门槛（10）', async () => {
  const { proposeSweep } = await sweepMod();
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  await seedAddresses(db, 'bsc', [A(1), A(2)]);
  const mails = [];
  const notify = async (s, t) => { mails.push(s); };
  const none = await proposeSweep(db, { chain: 'bsc', providers: { contract: fakeContract({ [A(1)]: U(9.99) }) }, notify });
  assert.equal(none, null);
  assert.equal(mails.length, 0);
  const b = await proposeSweep(db, { chain: 'bsc', providers: { contract: fakeContract({ [A(1)]: U(10), [A(2)]: U(9.99) }) }, notify });
  assert.deepEqual(b.items.map((i) => i.address), [A(1)]);
  await db.end?.();
});

test('半自动：只归集这个提供方名下的地址（切换后旧地址仍由原提供方归集，新提供方的地址不混进来）', async () => {
  const { proposeSweep } = await sweepMod();
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  await seedAddresses(db, 'eth', [A(1)]);
  await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'c2', 'eth', 'fireblocks', 1, 'fb-1', $1, 'active')`, [A(2)]);
  await db.query(`update customer_addresses set status = 'retired', retired_at = now() - interval '60 days' where address = $1 and chain = 'eth'`, [A(1)]);
  const p = fakeContract({ [A(1)]: U(500), [A(2)]: U(500) });
  const b = await proposeSweep(db, { chain: 'eth', providers: { contract: p, fireblocks: { id: 'fireblocks', enabled: false } }, notify: async () => {} });
  assert.deepEqual(b.items.map((i) => i.address), [A(1)], '停用 60 天的旧地址仍归集；别家的地址不在这一批');
  await db.end?.();
});

// ---------- 出错只告警 ----------

test('归集确认出错：只发告警邮件，不抛出（不影响同一轮的其他任务）', async () => {
  const { proposeSweep, approveSweep, confirmSweeps } = await sweepMod();
  const db = await setupDb({ customers: [['m1', 'c1']] });
  await seedAddresses(db, 'eth', [A(1)]);
  const p = fakeContract({ [A(1)]: U(500) }, { failStatus: true });
  const providers = { contract: p };
  const mails = [];
  const notify = async (subject, text) => { mails.push(subject); };
  const b = await proposeSweep(db, { chain: 'eth', providers, notify });
  await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers });
  mails.length = 0;
  const out = await confirmSweeps(db, { providers, notify });
  assert.ok(out && typeof out === 'object');
  assert.equal(mails.length, 1);
  assert.match(mails[0], /归集/);
  await db.end?.();
});

test('worker 一轮：归集步骤出错时发告警邮件；扫链、回调照常执行，照常记下运行时间（健康检查看的 tick_last 不受影响）', async () => {
  const { runTick } = await import('../server/pay/tick.js');
  const { createFakeTron } = await import('../server/pay/fake-trongrid.js');
  const db = await setupDb();
  const mails = [];
  const notify = async (subject) => { mails.push(subject); };
  const err = console.error; console.error = () => {};
  let out;
  try {
    out = await runTick({ db, tron: createFakeTron({ network: 'nile' }), getTarget: async () => null, notify, confirmSweeps: async () => { throw new Error('sweep rpc down'); } });
  } finally { console.error = err; }
  assert.ok(out.sweeps?.error, '归集步骤记为出错');
  assert.ok(!out.scan?.error, '扫链照常');
  assert.ok('callbacks' in out);
  const [last] = await db.query(`select value from pay_meta where key = 'tick_last'`);
  assert.ok(last, '运行时间照常记录');
  assert.ok(mails.some((s) => /归集/.test(s)), '归集出错发了告警邮件');
  await db.end?.();
});
