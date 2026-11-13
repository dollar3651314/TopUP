// 归集（ETH / BSC，半自动）：
//   - 预览（凑批）：门槛 ETH 100 / BSC 10 USDT；上线初期上限每地址每次 ≤ 5,000、每批 ≤ 20,000 USDT（在后端预览时检查，合约里没有）；
//     手续费占比上限 3%；超过每批上限（或每批地址数）的自动拆成几批，每批都不超
//   - 每天 10:00、20:00（东八区）各凑一次批，另有"现在就凑一批"；系统凑好批次、发邮件（邮件里没有确认按钮，必须登录后台确认）
//   - 管理员在后台确认才执行（确认不要动态码）；待确认超过 24 小时作废，下一轮重凑
//   - 部分成功：失败的地址放回待归集，不自动重试（下一批还要人确认）
//   - 改门槛和上限：动态码、原因必填、记审计（修改前后的值）
//   - 归集不写账本、不改商户余额；归集出错只进告警（邮件），不影响其他任务，健康检查不因此变差
// 要实现的模块：server/wallet/sweep.js、server/wallet/status.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, moneySnapshot } from './wallet-helpers.js';

const sweepMod = () => import('../server/wallet/sweep.js');
const U = (usdt) => BigInt(Math.round(usdt * 1e6)); // USDT → 0.000001 USDT 单位（bigint）
const cand = (address, usdt, extra = {}) => ({ address, salt: '0x' + address.slice(2).padStart(64, '0'), schemeVer: 1, balance: U(usdt), deployed: false, estFee: null, ...extra });
const A = (n) => '0x' + String(n).padStart(40, '0');
const H = 3_600_000;
const T0 = Date.parse('2026-12-01T04:00:00Z'); // 东八区 12:00
const CODE = { code: '123456', verifyCode: async (c) => c === '123456' };
const all = (plan) => plan.batches.flatMap((b) => b.items);

// ---------- 默认值 ----------

test('默认值：门槛 ETH 100、BSC 10、TRON 100 USDT；每地址每次 5,000、每批 20,000 USDT；手续费占比上限 3%；待确认 24 小时作废；凑批时间 10:00、20:00（东八区）', async () => {
  const { SWEEP_DEFAULTS, SWEEP_TIMES, SWEEP_EXPIRE_HOURS } = await sweepMod();
  assert.deepEqual(SWEEP_DEFAULTS.thresholds, { eth: U(100), bsc: U(10), tron: U(100) });
  assert.equal(SWEEP_DEFAULTS.capPerAddress, U(5000));
  assert.equal(SWEEP_DEFAULTS.capPerBatch, U(20000));
  assert.equal(SWEEP_DEFAULTS.maxFeeRatioPct, 3);
  assert.equal(SWEEP_EXPIRE_HOURS, 24);
  assert.deepEqual([...SWEEP_TIMES], ['10:00', '20:00']);
});

// ---------- 预览（纯计算） ----------

const LIM = { threshold: U(100), capPerAddress: U(5000), capPerBatch: U(20000), maxFeeRatioPct: 3, maxAddresses: 100, schemeVer: 1 };

test('预览：低于门槛的跳过（等于门槛的归集）；余额为 0 的不列出', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 99.999999), cand(A(2), 100), cand(A(3), 0)], LIM);
  assert.deepEqual(all(p).map((i) => i.address), [A(2)]);
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]), [[A(1), 'belowThreshold']]);
  assert.equal(p.total, U(100));
  // BSC 门槛 10
  const b = planSweep([cand(A(4), 10), cand(A(5), 9.99)], { ...LIM, threshold: U(10) });
  assert.deepEqual(all(b).map((i) => i.address), [A(4)]);
  // 没有可归集的：没有批次
  assert.deepEqual(planSweep([cand(A(6), 1)], LIM).batches, []);
});

test('预览：单个地址超过 5,000 的这次跳过（不拆成部分归集），等于 5,000 的归集', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 5000), cand(A(2), 5000.000001), cand(A(3), 6000)], LIM);
  assert.deepEqual(all(p).map((i) => [i.address, i.amount]), [[A(1), U(5000)]]);
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]).sort(), [[A(2), 'overAddressCap'], [A(3), 'overAddressCap']]);
});

test('预览：合计超过 20,000 自动拆成几批，每批 ≤ 20,000，每个地址只在一批里，一个都不落下；正好 20,000 是一批', async () => {
  const { planSweep } = await sweepMod();
  const cs = [cand(A(1), 4000), cand(A(2), 5000), cand(A(3), 5000), cand(A(4), 5000), cand(A(5), 4500), cand(A(6), 1000)]; // 合计 24,500
  const p = planSweep(cs, LIM);
  assert.equal(p.batches.length, 2);
  for (const b of p.batches) {
    assert.ok(b.total <= U(20000), `一批 ${b.total}`);
    assert.equal(b.total, b.items.reduce((s, i) => s + i.amount, 0n));
  }
  assert.deepEqual(all(p).map((i) => i.address).sort(), cs.map((c) => c.address).sort());
  assert.equal(p.total, U(24500));
  assert.deepEqual(p.skipped, []);
  const exact = planSweep([cand(A(1), 5000), cand(A(2), 5000), cand(A(3), 5000), cand(A(4), 5000)], LIM);
  assert.equal(exact.batches.length, 1);
  assert.equal(exact.batches[0].total, U(20000));
});

test('预览：每批地址数满了也拆批；上限是 0 表示不限（后台可改）', async () => {
  const { planSweep } = await sweepMod();
  const q = planSweep([cand(A(1), 300), cand(A(2), 200), cand(A(3), 100)], { ...LIM, maxAddresses: 2 });
  assert.equal(q.batches.length, 2);
  for (const b of q.batches) assert.ok(b.items.length <= 2);
  assert.equal(all(q).length, 3);
  const p = planSweep([cand(A(1), 9000), cand(A(2), 30000)], { ...LIM, capPerAddress: 0n, capPerBatch: 0n });
  assert.equal(p.batches.length, 1);
  assert.equal(p.total, U(39000));
});

test('预览：手续费占比超过 3% 的跳过（预估手续费折 USDT > 余额 × 3%）；不知道价格（estFee 为空）时不按占比跳过', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 100, { estFee: U(3) }), cand(A(2), 100, { estFee: U(3.000001) }), cand(A(3), 100, { estFee: null })], LIM);
  assert.deepEqual(all(p).map((i) => i.address).sort(), [A(1), A(3)]);
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]), [[A(2), 'feeRatio']]);
});

test('预览：已经在别的批次里的、方案版本不是当前这套的跳过；每个地址只出现一次，金额都是 bigint', async () => {
  const { planSweep } = await sweepMod();
  const p = planSweep([cand(A(1), 500, { inBatch: true }), cand(A(2), 500, { schemeVer: 2 }), cand(A(3), 500, { deployed: true }), cand(A(4), 400)], LIM);
  assert.deepEqual(all(p).map((i) => [i.address, i.deploy]), [[A(3), false], [A(4), true]]);
  assert.deepEqual(p.skipped.map((s) => [s.address, s.reason]).sort(), [[A(1), 'inBatch'], [A(2), 'otherScheme']]);
  for (const i of all(p)) { assert.equal(typeof i.amount, 'bigint'); assert.match(i.salt, /^0x[0-9a-f]{64}$/); }
  const addrs = [...all(p), ...p.skipped].map((x) => x.address);
  assert.equal(new Set(addrs).size, addrs.length);
});

// ---------- 凑批时间 ----------

test('凑批时间：每天东八区 10:00、20:00 各一次；没到点不凑；同一个时间点只凑一次；worker 停了一阵，补上最近的一个时间点、不连补', async () => {
  const { sweepSlotDue } = await sweepMod();
  const at = (s) => Date.parse(s);
  // 东八区 10:00 = UTC 02:00；20:00 = UTC 12:00。返回这个时间点（UTC ISO）表示该凑批了，null 表示不用
  assert.equal(sweepSlotDue(at('2026-12-01T01:59:59Z'), '2026-11-30T12:00:00.000Z'), null);
  assert.equal(sweepSlotDue(at('2026-12-01T02:00:00Z'), '2026-11-30T12:00:00.000Z'), '2026-12-01T02:00:00.000Z');
  assert.equal(sweepSlotDue(at('2026-12-01T05:00:00Z'), '2026-12-01T02:00:00.000Z'), null);
  assert.equal(sweepSlotDue(at('2026-12-01T12:00:30Z'), '2026-12-01T02:00:00.000Z'), '2026-12-01T12:00:00.000Z');
  assert.equal(sweepSlotDue(at('2026-12-03T03:00:00Z'), '2026-12-01T02:00:00.000Z'), '2026-12-03T02:00:00.000Z');
  assert.equal(sweepSlotDue(at('2026-12-01T02:00:00Z'), null), '2026-12-01T02:00:00.000Z');
});

// ---------- 半自动：凑批 → 管理员确认 → 执行 ----------

/** 假的 contract 提供方：地址余额由 balances 给定；记下 executeSweep 的调用；outcome 决定确认时哪些地址失败 */
function fakeContract(balances, { failStatus = false, failed = [] } = {}) {
  const executed = [];
  return {
    id: 'contract', enabled: true, executed,
    capabilities: () => ({ batchSweep: true, batchPayout: false, selfScan: true, webhook: false }),
    async balance(chain, { address }) { return balances[address] ?? 0n; },
    async planSweep(chain, candidates, limits) { const { planSweep } = await sweepMod(); return { chain, ...planSweep(candidates, limits) }; },
    async executeSweep(plan) { executed.push(plan); return { txRefs: ['0x' + String(executed.length).padStart(64, 'a')] }; },
    async txStatus() { if (failStatus) throw new Error('node down'); return 'confirmed'; },
    async sweepOutcome(chain, txRef, items) {
      if (failStatus) throw new Error('node down');
      return { status: 'confirmed', swept: items.map((i) => i.address).filter((a) => !failed.includes(a)), failed: failed.filter((a) => items.some((i) => i.address === a)).map((address) => ({ address, reason: 'reverted' })) };
    },
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
const customers = (n) => Array.from({ length: n }, (_, i) => ['m1', `c${i + 1}`]);

test('半自动：凑批只建"待确认"的批次并发一封邮件（没有确认按钮或链接，要登录后台），不发链上交易；确认（原因必填、不要动态码）后才执行，且只执行一次', async () => {
  const { proposeSweep, approveSweep } = await sweepMod();
  const db = await setupDb({ customers: customers(3) });
  await seedAddresses(db, 'eth', [A(1), A(2), A(3)]);
  const p = fakeContract({ [A(1)]: U(150), [A(2)]: U(6000), [A(3)]: U(50) });
  const providers = { contract: p };
  const mails = [];
  const notify = async (subject, text) => { mails.push({ subject, text }); };
  const money0 = await moneySnapshot(db);

  const bs = await proposeSweep(db, { chain: 'eth', providers, notify, now: T0 });
  assert.equal(bs.length, 1);
  const b = bs[0];
  assert.equal(b.status, 'awaiting_approval');
  assert.equal(b.chain, 'eth');
  assert.equal(b.provider, 'contract');
  assert.deepEqual(b.items.map((i) => [i.address, i.amount]), [[A(1), U(150)]]); // 6000 超单地址上限、50 低于门槛
  assert.equal(b.total, U(150));
  assert.equal(p.executed.length, 0, '没确认之前不执行');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /归集待确认/);
  assert.match(mails[0].text, /150/);
  assert.match(mails[0].text, /后台/);
  assert.doesNotMatch(mails[0].text, /approve|[?&](id|batch|token|code)=/i, '邮件里没有确认按钮或确认链接');

  // 同一条链已经有没过期的待确认批次：再凑批返回那几批，不新建、不重复发邮件
  const again = await proposeSweep(db, { chain: 'eth', providers, notify, now: T0 + H });
  assert.deepEqual(again.map((x) => x.id), [b.id]);
  assert.equal(mails.length, 1);

  await assert.rejects(approveSweep(db, { id: b.id, actor: 'admin@x', reason: '', providers, now: T0 + H }), (e) => e.code === 'reason_required');
  assert.equal(p.executed.length, 0);
  // 确认不要动态码：不传 code 也能确认
  const r = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: '本周归集', providers, now: T0 + H });
  assert.equal(r.status, 'sent');
  assert.equal(r.txRefs.length, 1);
  assert.equal(p.executed.length, 1);
  assert.deepEqual(p.executed[0].items.map((i) => i.address), [A(1)]);
  await assert.rejects(approveSweep(db, { id: b.id, actor: 'admin@x', reason: '再点一次', providers, now: T0 + H }), (e) => e.code === 'batch_state');
  assert.equal(p.executed.length, 1, '重复确认不会再发一次');
  const audit = JSON.stringify(await db.query(`select actor, detail from pay_audit where actor = 'admin@x'`));
  assert.ok(audit.includes('本周归集'));

  assert.equal(await moneySnapshot(db), money0, '归集不写账本、不改商户余额');
  await db.end?.();
});

test('半自动：合计超过 20,000 时一次凑出两批（邮件一封），两批分别确认、分别执行', async () => {
  const { proposeSweep, approveSweep } = await sweepMod();
  const db = await setupDb({ customers: customers(5) });
  const list = [A(1), A(2), A(3), A(4), A(5)];
  await seedAddresses(db, 'bsc', list);
  const p = fakeContract(Object.fromEntries(list.map((a) => [a, U(4900)]))); // 合计 24,500
  const mails = [];
  const bs = await proposeSweep(db, { chain: 'bsc', providers: { contract: p }, notify: async (s) => { mails.push(s); }, now: T0 });
  assert.equal(bs.length, 2);
  for (const b of bs) assert.ok(b.total <= U(20000));
  assert.deepEqual(bs.flatMap((b) => b.items.map((i) => i.address)).sort(), list);
  assert.equal(mails.length, 1);
  for (const b of bs) await approveSweep(db, { id: b.id, actor: 'admin@x', reason: '两批', providers: { contract: p }, now: T0 + H });
  assert.equal(p.executed.length, 2);
  await db.end?.();
});

test('半自动：没有达到条件的地址时不建批次、不发邮件；BSC 用 BSC 的门槛（10）', async () => {
  const { proposeSweep } = await sweepMod();
  const db = await setupDb({ customers: customers(2) });
  await seedAddresses(db, 'bsc', [A(1), A(2)]);
  const mails = [];
  const notify = async (s) => { mails.push(s); };
  assert.deepEqual(await proposeSweep(db, { chain: 'bsc', providers: { contract: fakeContract({ [A(1)]: U(9.99) }) }, notify, now: T0 }), []);
  assert.equal(mails.length, 0);
  const bs = await proposeSweep(db, { chain: 'bsc', providers: { contract: fakeContract({ [A(1)]: U(10), [A(2)]: U(9.99) }) }, notify, now: T0 });
  assert.deepEqual(bs[0].items.map((i) => i.address), [A(1)]);
  await db.end?.();
});

test('待确认超过 24 小时作废：不能再确认；下一轮重新凑批（重新发邮件）', async () => {
  const { proposeSweep, approveSweep } = await sweepMod();
  const db = await setupDb({ customers: customers(1) });
  await seedAddresses(db, 'eth', [A(1)]);
  const p = fakeContract({ [A(1)]: U(500) });
  const providers = { contract: p };
  const mails = [];
  const notify = async (s) => { mails.push(s); };
  const [b1] = await proposeSweep(db, { chain: 'eth', providers, notify, now: T0 });
  await assert.rejects(approveSweep(db, { id: b1.id, actor: 'admin@x', reason: '晚了', providers, now: T0 + 24 * H + 1000 }), (e) => e.code === 'batch_expired' || e.code === 'batch_state');
  assert.equal(p.executed.length, 0);
  const [b2] = await proposeSweep(db, { chain: 'eth', providers, notify, now: T0 + 24 * H + 2000 });
  assert.notEqual(b2.id, b1.id);
  assert.deepEqual(b2.items.map((i) => i.address), [A(1)], '作废那批的地址重新列入');
  assert.equal(mails.length, 2);
  await assert.rejects(approveSweep(db, { id: b1.id, actor: 'admin@x', reason: '还是晚了', providers, now: T0 + 24 * H + 3000 }));
  await db.end?.();
});

test('部分成功：成功的地址记完成；失败的地址放回待归集、不自动重试（下一轮凑进新批次，仍要人确认）；发告警', async () => {
  const { proposeSweep, approveSweep, confirmSweeps } = await sweepMod();
  const db = await setupDb({ customers: customers(2) });
  await seedAddresses(db, 'eth', [A(1), A(2)]);
  const p = fakeContract({ [A(1)]: U(500), [A(2)]: U(300) }, { failed: [A(2)] });
  const providers = { contract: p };
  const mails = [];
  const notify = async (s) => { mails.push(s); };
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify, now: T0 });
  await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + H });
  mails.length = 0;
  const out = await confirmSweeps(db, { providers, notify, now: T0 + 2 * H });
  assert.ok(out && typeof out === 'object');
  assert.equal(p.executed.length, 1, '不自动重试');
  assert.ok(mails.some((s) => /归集/.test(s) && /部分/.test(s)), '部分成功发告警');
  // A(1) 已归走（余额变 0），A(2) 放回待归集：下一轮凑进新批次，待确认
  p.balance = async (chain, { address }) => (address === A(2) ? U(300) : 0n);
  const next = await proposeSweep(db, { chain: 'eth', providers, notify, now: T0 + 3 * H });
  assert.equal(next.length, 1);
  assert.notEqual(next[0].id, b.id);
  assert.equal(next[0].status, 'awaiting_approval');
  assert.deepEqual(next[0].items.map((i) => i.address), [A(2)]);
  assert.equal(p.executed.length, 1);
  await db.end?.();
});

test('半自动：只归集这个提供方名下的地址（切换后旧地址仍由原提供方归集，停用多久都算；新提供方的地址不混进来）', async () => {
  const { proposeSweep } = await sweepMod();
  const db = await setupDb({ customers: customers(2) });
  await seedAddresses(db, 'eth', [A(1)]);
  await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'c2', 'eth', 'fireblocks', 1, 'fb-1', $1, 'active')`, [A(2)]);
  await db.query(`update customer_addresses set status = 'retired', retired_at = now() - interval '400 days' where address = $1 and chain = 'eth'`, [A(1)]);
  const p = fakeContract({ [A(1)]: U(500), [A(2)]: U(500) });
  const [b] = await proposeSweep(db, { chain: 'eth', providers: { contract: p, fireblocks: { id: 'fireblocks', enabled: false } }, notify: async () => {}, now: T0 });
  assert.deepEqual(b.items.map((i) => i.address), [A(1)]);
  await db.end?.();
});

// ---------- 归集设置 ----------

test('归集设置：没改过时是默认值；改门槛和上限要动态码、原因必填，记审计（修改前后的值）；改完凑批按新值', async () => {
  const { getSweepSettings, updateSweepSettings, proposeSweep, SWEEP_DEFAULTS } = await sweepMod();
  const db = await setupDb({ customers: customers(1) });
  assert.deepEqual(await getSweepSettings(db), SWEEP_DEFAULTS);
  const values = { ...SWEEP_DEFAULTS, thresholds: { ...SWEEP_DEFAULTS.thresholds, eth: U(500) } };
  await assert.rejects(updateSweepSettings(db, { actor: 'admin@x', reason: '调门槛', values, code: '000000', verifyCode: CODE.verifyCode }), (e) => e.code === 'bad_code');
  await assert.rejects(updateSweepSettings(db, { actor: 'admin@x', reason: ' ', values, ...CODE }), (e) => e.code === 'reason_required');
  await assert.rejects(updateSweepSettings(db, { actor: 'admin@x', reason: '负数', values: { ...values, capPerBatch: -1n }, ...CODE }));
  assert.deepEqual(await getSweepSettings(db), SWEEP_DEFAULTS, '被拒绝的修改没有生效');
  await updateSweepSettings(db, { actor: 'admin@x', reason: '调门槛', values, ...CODE });
  assert.equal((await getSweepSettings(db)).thresholds.eth, U(500));
  const [a] = await db.query(`select actor, detail from pay_audit where actor = 'admin@x' order by id desc limit 1`);
  const d = JSON.stringify(a.detail);
  assert.ok(d.includes('调门槛'));
  assert.ok(d.includes('100') && d.includes('500'), '审计里有修改前后的值');
  await seedAddresses(db, 'eth', [A(1)]);
  assert.deepEqual(await proposeSweep(db, { chain: 'eth', providers: { contract: fakeContract({ [A(1)]: U(300) }) }, notify: async () => {}, now: T0 }), [], '按新门槛 500，300 不够');
  await db.end?.();
});

// ---------- 出错只告警；系统状态 ----------

test('归集确认出错：只发告警邮件，不抛出（不影响同一轮的其他任务）', async () => {
  const { proposeSweep, approveSweep, confirmSweeps } = await sweepMod();
  const db = await setupDb({ customers: customers(1) });
  await seedAddresses(db, 'eth', [A(1)]);
  const p = fakeContract({ [A(1)]: U(500) }, { failStatus: true });
  const providers = { contract: p };
  const mails = [];
  const notify = async (subject) => { mails.push(subject); };
  const [b] = await proposeSweep(db, { chain: 'eth', providers, notify, now: T0 });
  await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'r', providers, now: T0 + H });
  mails.length = 0;
  const out = await confirmSweeps(db, { providers, notify, now: T0 + 2 * H });
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

test('系统状态（每条链一张卡）：扫块情况、合约地址配没配齐（只给是否，不给值）；扫块停了或少配一项时这条链标出问题（这一项不进健康检查的整体 ok）', async () => {
  const { walletChainStatus } = await import('../server/wallet/status.js');
  const scheme = { factory: '0x' + '11'.repeat(20), implementation: '0x' + '22'.repeat(20), parent: '0x' + '33'.repeat(20), batcher: '0x' + '44'.repeat(20) };
  const now = T0;
  const ok = walletChainStatus({ chain: 'eth', rpcConfigured: true, usdtConfigured: true, scheme, cursor: '990', head: 1000, confirmations: 12, lastScanAt: now - 20_000, now });
  assert.equal(ok.chain, 'eth');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.contracts, { factory: true, implementation: true, parent: true, batcher: true });
  assert.equal(ok.scan.ok, true);
  assert.equal(typeof ok.scan.lag_blocks, 'number');
  const s = JSON.stringify(ok);
  for (const v of Object.values(scheme)) assert.ok(!s.toLowerCase().includes(v.slice(2)), '不返回地址的值');
  // 少配一项
  const miss = walletChainStatus({ chain: 'eth', rpcConfigured: true, usdtConfigured: true, scheme: { ...scheme, batcher: '' }, cursor: '990', head: 1000, confirmations: 12, lastScanAt: now - 20_000, now });
  assert.equal(miss.contracts.batcher, false);
  assert.equal(miss.ok, false);
  // 扫块停了（超过 5 分钟没扫）
  const stale = walletChainStatus({ chain: 'bsc', rpcConfigured: true, usdtConfigured: true, scheme, cursor: '500', head: 1000, confirmations: 15, lastScanAt: now - 6 * 60_000, now });
  assert.equal(stale.scan.ok, false);
  assert.equal(stale.ok, false);
  // TRON 第 1 批：显示"第 2 批"，不算问题
  const tron = walletChainStatus({ chain: 'tron', enabled: false, now });
  assert.equal(tron.ok, true);
  assert.equal(tron.status, 'not_in_this_batch');
});
