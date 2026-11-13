// 测试先写（第 2 批）：TRON 合约归集（半自动，和 ETH / BSC 同一套流程）+ 租能量。
//   归集：
//   - 预览：门槛 TRON 100 USDT；每地址每次 ≤ 5,000（超过整个地址跳过）、每批 ≤ 20,000（超过自动拆批）；TRON 每批最多 20 个地址
//     （单笔交易 CPU 上限 80 毫秒，技术方案 04 页 2.3：先按 20 个一批，Nile 实测后再定）；凑批发一封邮件，管理员确认才执行
//   - 第 0 批的老地址（legacy_hd）不进合约归集（老地址仍走原来的浏览器签名归集；新地址走合约 —— 两种并存方式待产品确认）
//   - 确认后：发起账户（服务器上的 SWEEP_OPERATOR_KEY_TRON）签一笔 TriggerSmartContract：批量合约.sweep(USDT, 盐[])，钱只能进写死的 parent
//   - 按批量合约的事件逐个地址判断：Swept 算成功，SweepFailed / 没事件算失败（部分成功照记，失败的放回待归集、不自动重试）；
//     交易本身失败（回执不是 SUCCESS，例如能量不够、OUT_OF_TIME）整批失败
//   - 合约里 USDT 的 transfer 成功也返回 false：判断成功靠合约里"parent 余额增加了这么多"，后端只认 Swept / SweepFailed 事件，
//     不看 USDT 的返回值（返回值根本不在回执里）
//   - 节点连不上（签名前）退回待确认、钱没动；广播时连接出错不算失败（按本地算出的交易号继续查）；节点明确拒绝才算发送失败
//   - 归集不写账本、不改商户余额
//   租能量（Q9 A）：
//   - 一批只给发起账户租一次（不按地址各租一单）；租到 → 照常发；租不到（平台出错、超时、余额不够）→ 回退烧 TRX，
//     fee_limit 按"预估能量 × 能量单价"给够；发起账户 TRX 连烧都不够 → 不发（退回待确认），告诉管理员
//   - 租不到、回退烧 TRX 时发告警邮件（同类一天最多一封）；租到了不发
//   - 租能量平台预存余额建议 ≤ 1,000 TRX（K5 泄露的最大损失）：超过就告警（故障一次、恢复一次）；查不到余额不告警、不报错
// 要实现的模块：server/wallet/providers/contract.js（TRON 的 executeSweep、sweepOutcome、estimateFee）、server/wallet/sweep.js（TRON 进 SWEEP_CHAINS、每批 20 个）、
//   server/wallet/energy.js（checkRentalBalance、RENTAL_PREPAID_MAX_TRX）
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeTronNode, tronScheme, testOperator, decodeSweep, h20, T, SWEEP_SELECTOR, randomTron, quiet } from './tron-helpers.js';
import { setupDb, moneySnapshot } from './wallet-helpers.js';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';

const usd = (n) => BigInt(Math.round(n * 1e6));

async function addr(db, providers, customerId) {
  const { addressFor } = await import('../server/wallet/addresses.js');
  return (await addressFor(db, { merchantId: 'm1', customerId, chain: 'tron', providers })).address;
}
/** contract 提供方只开 TRON（替身节点）；n 个客户各分配一个 TRON 合约地址 */
async function setupT(opts = {}) {
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const { createTronAdapter } = await import('../server/wallet/adapters/tron.js');
  const { scheme, usdt } = tronScheme();
  const operator = opts.operator === undefined ? testOperator() : opts.operator;
  const node = fakeTronNode({ head: 1000, scheme, usdt, ...(opts.nodeState || {}) });
  if (operator) node.activate(operator.address, opts.opBalance ?? 5_000_000_000);
  const n = opts.customers ?? 3;
  const db = await setupDb({ customers: Array.from({ length: n }, (_, i) => ['m1', `c${i + 1}`]) });
  const adapter = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19, timeoutMs: 2000 });
  const p = createContractProvider({ db, chains: { tron: { adapter, scheme, usdt } }, tronOperatorKey: operator ? operator.key : '', tronEnergy: opts.renter });
  const providers = { contract: p };
  const addrs = [];
  for (let i = 1; i <= n; i++) addrs.push(await addr(db, providers, `c${i}`));
  return { db, node, p, providers, addrs, scheme, usdt, operator, adapter };
}

/** 每个地址存 amounts[i] USDT（替身节点上的链上余额，同时记一笔到账，账本"到账 − 已归集"也对得上） */
async function fund(t, amounts) {
  const core = await import('../server/pay/core.js');
  for (const [i, a] of amounts.entries()) {
    if (a == null) continue;
    const raw = usd(a);
    const tx = t.node.transfer({ to: t.addrs[i], amount: raw, block: t.node.state.head });
    await core.recordDeposit(t.db, { chain: 'tron', txid: tx.txid, logIndex: 0, block: tx.block, time: Date.now(), from: randomTron(), to: t.addrs[i], amount: Number(raw), rawAmount: String(raw) });
  }
}
const sweepMod = () => import('../server/wallet/sweep.js');
const LIM = { threshold: usd(100), capPerAddress: usd(5000), capPerBatch: usd(20000), maxFeeRatioPct: 0, maxAddresses: 50 };
const confirm = (t, n = 25) => t.node.mine(n);

// ---------- 预览、凑批 ----------

test('TRON 进归集：SWEEP_CHAINS 含 tron；默认门槛 100 USDT；凑批（预览）门槛、每地址 5,000、每批 20,000 都按设置', async () => {
  const { SWEEP_CHAINS, SWEEP_DEFAULTS, proposeSweep } = await sweepMod();
  assert.ok(SWEEP_CHAINS.includes('tron'));
  assert.equal(SWEEP_DEFAULTS.thresholds.tron, usd(100));
  const t = await setupT({ customers: 8 });
  // 99.999999 低于门槛；100 正好；5,000.000001 超每地址上限；其余凑到 20,000 以上要拆批
  await fund(t, [99.999999, 100, 5000.000001, 5000, 5000, 5000, 4000, 2000]);
  const mails = [];
  const bs = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, notify: async (s, x) => mails.push([s, x]) });
  assert.ok(bs.length >= 2, `21,100 USDT 要拆成至少两批，实际 ${bs.length}`);
  for (const b of bs) assert.ok(b.total <= usd(20000), `一批 ${b.total}`);
  const inBatches = bs.flatMap((b) => b.items.map((i) => i.address)).sort();
  assert.deepEqual(inBatches, [t.addrs[1], t.addrs[3], t.addrs[4], t.addrs[5], t.addrs[6], t.addrs[7]].sort());
  const sk = Object.fromEntries(bs[0].skipped.map((s) => [s.address, s.reason]));
  assert.equal(sk[t.addrs[0]], 'belowThreshold');
  assert.equal(sk[t.addrs[2]], 'overAddressCap');
  assert.equal(mails.length, 1, '一次凑出几批也只发一封');
  assert.match(mails[0][0], /TRON/);
  assert.doesNotMatch(mails[0][1], /https?:\/\/\S*approve/i, '邮件里没有确认按钮');
  for (const b of bs) assert.equal(b.status, 'awaiting_approval');
  await t.db.end?.();
});

test('TRON 每批最多 20 个地址（单笔交易 CPU 上限，先按 20 个一批）：25 个地址拆成两批，每个地址只在一批里', async () => {
  const { proposeSweep } = await sweepMod();
  const t = await setupT({ customers: 25 });
  await fund(t, Array(25).fill(150));
  const bs = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
  assert.equal(bs.length, 2);
  for (const b of bs) assert.ok(b.items.length <= 20, `一批 ${b.items.length} 个地址`);
  assert.equal(new Set(bs.flatMap((b) => b.items.map((i) => i.address))).size, 25);
  await t.db.end?.();
});

test('第 0 批的老 TRON 地址（legacy_hd）不进合约归集（继续走原来的浏览器签名归集）；只列 provider = contract 的地址', async () => {
  const { proposeSweep } = await sweepMod();
  const t = await setupT({ customers: 2 });
  const legacy = randomTron();
  await t.db.query(`insert into customers (merchant_id, customer_id, address, hd_index) values ('m1', 'old', $1, 77)`, [legacy]);
  await t.db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'old', 'tron', 'legacy_hd', 0, '', $1, 'active')`, [legacy]);
  t.node.transfer({ to: legacy, amount: usd(900), block: t.node.state.head });
  await fund(t, [300, 400]);
  const bs = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
  const all = bs.flatMap((b) => [...b.items.map((i) => i.address), ...b.skipped.map((s) => s.address)]);
  assert.ok(!all.includes(legacy), '老地址不出现在合约批次里（连"跳过"都不列）');
  assert.deepEqual(bs.flatMap((b) => b.items.map((i) => i.address)).sort(), [t.addrs[0], t.addrs[1]].sort());
  await t.db.end?.();
});

// ---------- 确认 → 一笔交易 ----------

test('确认后：发起账户签一笔交易调用批量合约 sweep(USDT, 盐[])——发起地址 = 发起账户、合约 = 批量合约、盐和批次一致、带 fee_limit；批次 sent、记交易号', async () => {
  const { proposeSweep, approveSweep, getBatch } = await sweepMod();
  const t = await setupT({ customers: 3 });
  await fund(t, [150, 250, 350]);
  const [b] = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
  const snap = await moneySnapshot(t.db);
  const r = await approveSweep(t.db, { id: b.id, actor: 'admin', reason: '例行归集', providers: t.providers });
  assert.equal(r.status, 'sent');
  assert.equal(t.node.state.broadcasts.length, 1, '一批一笔交易');
  const tx = t.node.state.broadcasts[0];
  assert.equal(tx.type, 31, 'TriggerSmartContract');
  assert.equal(tx.owner, t.operator.address);
  assert.equal(tx.contract, t.scheme.batcher, '只调用批量合约');
  assert.equal(tx.callValue, 0);
  assert.ok(tx.feeLimit > 0, '带 fee_limit');
  assert.ok(tx.data.startsWith(SWEEP_SELECTOR));
  const sw = decodeSweep(tx.data);
  assert.equal(sw.token, t.usdt);
  const got = await getBatch(t.db, b.id);
  assert.deepEqual(sw.salts.map((s) => s.toLowerCase()).sort(), got.items.map((i) => i.salt.toLowerCase()).sort());
  assert.equal(got.status, 'sent');
  assert.deepEqual(got.txRefs, [tx.txId]);
  assert.equal(r.txRefs[0], tx.txId, '交易号 = sha256(交易原文)');
  assert.equal(await moneySnapshot(t.db), snap, '归集不写账本、不改商户余额');
  await t.db.end?.();
});

test('确认结果：确认数够了才定；按事件逐个地址判断（Swept 成功、SweepFailed 失败）→ 部分成功照记，失败的放回待归集、邮件写明；钱进 parent', async () => {
  const { proposeSweep, approveSweep, confirmSweeps, getBatch } = await sweepMod();
  const t = await setupT({ customers: 3 });
  await fund(t, [150, 250, 350]);
  const [b] = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
  const bad = b.items.find((i) => i.address === t.addrs[1]);
  t.node.state.failSalts.add(bad.salt.toLowerCase());
  await approveSweep(t.db, { id: b.id, actor: 'admin', reason: '例行归集', providers: t.providers });
  const mails = [];
  const notify = async (s, x) => mails.push([s, x]);
  const early = await confirmSweeps(t.db, { providers: t.providers, notify });
  assert.equal((await getBatch(t.db, b.id)).status, 'sent', `确认数不够时不下结论：${JSON.stringify(early)}`);
  confirm(t);
  await confirmSweeps(t.db, { providers: t.providers, notify });
  const got = await getBatch(t.db, b.id);
  assert.equal(got.status, 'partial');
  const st = Object.fromEntries(got.items.map((i) => [i.address, [i.status, i.reason]]));
  assert.deepEqual(st[t.addrs[0]], ['swept', null]);
  assert.deepEqual(st[t.addrs[2]], ['swept', null]);
  assert.equal(st[t.addrs[1]][0], 'released');
  assert.ok(mails.some(([s, x]) => /部分成功/.test(s) && x.includes(t.addrs[1])), '邮件写明失败的地址');
  assert.equal(t.node.bal(t.usdt, t.scheme.parent), usd(500), '成功的两个地址进了 parent');
  // 失败的地址放回待归集：下一次凑批还在（不自动重试）
  const again = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
  assert.deepEqual(again.flatMap((x) => x.items.map((i) => i.address)), [t.addrs[1]]);
  await t.db.end?.();
});

test('确认结果：交易本身失败（回执 OUT_OF_ENERGY / REVERT / OUT_OF_TIME）→ 整批失败，地址都放回待归集', async () => {
  const { proposeSweep, approveSweep, confirmSweeps, getBatch } = await sweepMod();
  for (const res of ['OUT_OF_ENERGY', 'REVERT', 'OUT_OF_TIME']) {
    const t = await setupT({ customers: 2 });
    await fund(t, [150, 250]);
    const [b] = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
    t.node.state.nextReceipt = res;
    await approveSweep(t.db, { id: b.id, actor: 'admin', reason: '例行归集', providers: t.providers });
    confirm(t);
    await confirmSweeps(t.db, { providers: t.providers });
    const got = await getBatch(t.db, b.id);
    assert.equal(got.status, 'failed', res);
    assert.ok(got.items.every((i) => i.status === 'released'), res);
    await t.db.end?.();
  }
});

test('确认结果：回执里没有这个盐的事件（例如事件被别的合约发出、伪造的同名事件）→ 这个地址算失败；只认批量合约发出的事件', async () => {
  const t = await setupT({ customers: 2 });
  const { SWEPT_TOPIC, word } = await import('./tron-helpers.js');
  await fund(t, [150, 250]);
  const [c1] = await t.db.query(`select salt from customer_addresses where address = $1`, [t.addrs[0]]);
  const [c2] = await t.db.query(`select salt from customer_addresses where address = $1`, [t.addrs[1]]);
  const items = [{ address: t.addrs[0], salt: c1.salt }, { address: t.addrs[1], salt: c2.salt }];
  // 手工放一笔已上链的交易：c1 的 Swept 由批量合约发出；c2 的 Swept 由别的合约发出
  const id = 'ab'.repeat(32);
  const info = { id, blockNumber: 950, blockTimeStamp: Date.now(), receipt: { result: 'SUCCESS' }, log: [
    { address: h20(t.scheme.batcher), topics: [SWEPT_TOPIC, word(c1.salt), word(h20(t.addrs[0]))], data: word('1') },
    { address: h20(randomTron()), topics: [SWEPT_TOPIC, word(c2.salt), word(h20(t.addrs[1]))], data: word('1') },
  ] };
  t.node.state.infos.set(id, info);
  const r = await t.p.sweepOutcome('tron', id, items);
  assert.equal(r.status, 'confirmed');
  assert.deepEqual(r.swept, [t.addrs[0]]);
  assert.deepEqual(r.failed.map((f) => f.address), [t.addrs[1]]);
  await t.db.end?.();
});

test('发送出错：签名前节点连不上 → 退回待确认（钱没动、没广播）；广播时连接出错 → 不算失败，记本地算出的交易号；节点明确拒绝 → 发送失败、地址放回', async () => {
  const { proposeSweep, approveSweep, getBatch } = await sweepMod();
  const origErr = console.error; console.error = quiet.error;
  try {
    // ① 签名前
    const a = await setupT({ customers: 1 });
    await fund(a, [200]);
    const [ba] = await proposeSweep(a.db, { chain: 'tron', providers: a.providers, limits: LIM });
    a.node.state.down = true;
    await assert.rejects(approveSweep(a.db, { id: ba.id, actor: 'admin', reason: 'x', providers: a.providers }), (e) => e.code === 'sweep_not_sent');
    assert.equal((await getBatch(a.db, ba.id)).status, 'awaiting_approval');
    assert.equal(a.node.state.broadcasts.length, 0);
    // ② 广播时断线
    const b = await setupT({ customers: 1 });
    await fund(b, [200]);
    const [bb] = await proposeSweep(b.db, { chain: 'tron', providers: b.providers, limits: LIM });
    b.node.state.downFor = ['/wallet/broadcasthex', '/wallet/broadcasttransaction'];
    const r = await approveSweep(b.db, { id: bb.id, actor: 'admin', reason: 'x', providers: b.providers });
    assert.equal(r.status, 'sent');
    assert.equal(r.broadcast, 'uncertain');
    assert.match(r.txRefs[0], /^[0-9a-f]{64}$/);
    const gb = await getBatch(b.db, bb.id);
    assert.equal(gb.status, 'sent');
    assert.ok(gb.items.every((i) => i.status === 'sent'));
    // ③ 节点明确拒绝
    const c = await setupT({ customers: 1 });
    await fund(c, [200]);
    const [bc] = await proposeSweep(c.db, { chain: 'tron', providers: c.providers, limits: LIM });
    c.node.state.rejectBroadcast = 'CONTRACT_VALIDATE_ERROR';
    await assert.rejects(approveSweep(c.db, { id: bc.id, actor: 'admin', reason: 'x', providers: c.providers }), (e) => e.code === 'sweep_send_failed');
    const gc = await getBatch(c.db, bc.id);
    assert.equal(gc.status, 'failed');
    assert.ok(gc.items.every((i) => i.status === 'released'));
    for (const t of [a, b, c]) await t.db.end?.();
  } finally { console.error = origErr; }
});

test('没配 TRON 发起账户私钥：能分配地址、能扫链、能凑批，确认时不发（operator_not_configured，退回待确认）', async () => {
  const { proposeSweep, approveSweep, getBatch } = await sweepMod();
  const t = await setupT({ customers: 1, operator: null });
  await fund(t, [200]);
  const [b] = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
  const origErr = console.error; console.error = quiet.error;
  try {
    await assert.rejects(approveSweep(t.db, { id: b.id, actor: 'admin', reason: 'x', providers: t.providers }), (e) => e.code === 'sweep_not_sent');
  } finally { console.error = origErr; }
  const got = await getBatch(t.db, b.id);
  assert.equal(got.status, 'awaiting_approval');
  assert.match(got.error || '', /operator/);
  assert.equal(t.node.state.broadcasts.length, 0);
  await t.db.end?.();
});

// ---------- 能量 ----------

test('能量预估：estimateFee(tron, sweep) 给能量和烧 TRX 的价格（sun = 能量 × 链上能量单价）；首次部署的地址比已部署的贵；地址越多越贵', async () => {
  const t = await setupT({ customers: 1 });
  const f1 = await t.p.estimateFee('tron', 'sweep', 1, { deploy: 1 });
  const f1d = await t.p.estimateFee('tron', 'sweep', 1, { deploy: 0 });
  const f5 = await t.p.estimateFee('tron', 'sweep', 5, { deploy: 5 });
  for (const f of [f1, f1d, f5]) {
    assert.ok(BigInt(f.energy) > 0n);
    assert.equal(BigInt(f.native), BigInt(f.energy) * 100n, '替身节点的 getEnergyFee = 100 sun');
  }
  // 本机私链实测：部署一个转发合约 9 万～10 万能量、归集 1.8 万（标准代币；真 USDT 的转账 6.4 万起）——预估不能低于这个
  assert.ok(BigInt(f1.energy) >= 90_000n + 18_000n, `首次部署 + 归集至少 10.8 万能量，实际 ${f1.energy}`);
  assert.ok(BigInt(f1.energy) > BigInt(f1d.energy));
  assert.ok(BigInt(f5.energy) > BigInt(f1.energy));
  await t.db.end?.();
});

/** 租能量平台替身：rent({ receiver, energy }) → { orderId }；fail 时抛出 */
function renterStub({ fail = null, balanceSun = 500_000_000n } = {}) {
  const calls = [];
  return {
    calls,
    async rent(req) { calls.push(req); if (fail) throw Object.assign(new Error(fail), { code: fail }); return { orderId: `R${calls.length}` }; },
    async balance() { if (balanceSun instanceof Error) throw balanceSun; return balanceSun; },
  };
}

test('租能量：一批只给发起账户租一次（不按地址各租一单），租的量够这一批；租到 → 照常发，结果里记 rented 和订单号', async () => {
  const { proposeSweep } = await sweepMod();
  const renter = renterStub();
  const t = await setupT({ customers: 4, renter });
  await fund(t, [150, 150, 150, 150]);
  const [b] = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM });
  const est = await t.p.estimateFee('tron', 'sweep', 4, { deploy: 4 });
  // 直接看提供方的执行结果
  const items = b.items.map((i) => ({ address: i.address, salt: i.salt, amount: i.amount, deploy: i.deploy }));
  const r = await t.p.executeSweep({ chain: 'tron', items });
  assert.equal(renter.calls.length, 1, '一批租一次');
  assert.equal(renter.calls[0].receiver, t.operator.address, '租给发起账户');
  assert.ok(BigInt(renter.calls[0].energy) >= BigInt(est.energy), `租的量 ${renter.calls[0].energy} 不少于预估 ${est.energy}`);
  assert.equal(r.energy?.mode, 'rented');
  assert.equal(r.energy?.orderId, 'R1');
  assert.equal(t.node.state.broadcasts.length, 1);
  assert.ok(t.node.state.broadcasts[0].feeLimit > 0, '租到了也带 fee_limit（兜底）');
  await t.db.end?.();
});

test('租不到能量（平台出错、超时、余额不够）→ 回退烧 TRX：照常发，fee_limit ≥ 预估能量 × 能量单价，结果里记 burn 和原因', async () => {
  for (const fail of ['tronsave_unavailable', 'timeout', 'insufficient_balance']) {
    const renter = renterStub({ fail });
    const t = await setupT({ customers: 2, renter });
    await fund(t, [150, 150]);
    const items = (await t.db.query(`select address, salt from customer_addresses where chain = 'tron' order by id`)).map((r) => ({ ...r, amount: usd(150), deploy: true }));
    const est = await t.p.estimateFee('tron', 'sweep', 2, { deploy: 2 });
    const r = await t.p.executeSweep({ chain: 'tron', items });
    assert.equal(renter.calls.length, 1, fail);
    assert.equal(r.energy?.mode, 'burn', fail);
    assert.ok(r.energy?.reason, '记下租不到的原因');
    assert.equal(t.node.state.broadcasts.length, 1, fail);
    assert.ok(BigInt(t.node.state.broadcasts[0].feeLimit) >= BigInt(est.native), `fee_limit ${t.node.state.broadcasts[0].feeLimit} 要够烧 ${est.native}`);
    await t.db.end?.();
  }
});

test('租不到能量回退烧 TRX：发告警邮件（写明 TRON、能量、原因），同类一天最多一封；过了 24 小时再租不到再发一封；租到了不发', async () => {
  const { proposeSweep, approveSweep } = await sweepMod();
  const T0 = Date.parse('2026-12-01T04:00:00Z');
  const H = 3_600_000;
  const mails = [];
  const notify = async (s, x) => mails.push([s, x]);
  const renter = renterStub({ fail: 'tronsave_unavailable' });
  const t = await setupT({ customers: 3, renter });
  const one = async (i, now) => {
    await fund(t, [i === 0 ? 150 : null, i === 1 ? 150 : null, i === 2 ? 150 : null]);
    const bs = await proposeSweep(t.db, { chain: 'tron', providers: t.providers, limits: LIM, now });
    const b = bs.find((x) => x.items.some((it) => it.address === t.addrs[i]));
    const r = await approveSweep(t.db, { id: b.id, actor: 'admin', reason: '例行归集', providers: t.providers, notify, now });
    assert.equal(r.status, 'sent', '租不到也照常发');
    await t.db.query(`update wallet_sweep_batches set status = 'confirmed' where id = $1`, [b.id]); // 让下一次凑批不被这一批挡住
  };
  await one(0, T0);
  const energyMails = () => mails.filter(([s, x]) => /能量/.test(s + x));
  assert.equal(energyMails().length, 1, `第一次租不到发一封：${mails.map((m) => m[0])}`);
  assert.match(energyMails()[0][0] + energyMails()[0][1], /TRON/);
  assert.match(energyMails()[0][1], /烧|TRX/);
  assert.match(energyMails()[0][1], /tronsave_unavailable/, '写明租不到的原因');
  await one(1, T0 + 2 * H);
  assert.equal(energyMails().length, 1, '同一天第二次租不到不再发');
  await one(2, T0 + 25 * H);
  assert.equal(energyMails().length, 2, '过了 24 小时再发一封');
  await t.db.end?.();
  // 租到了：不发
  const ok = await setupT({ customers: 1, renter: renterStub() });
  await fund(ok, [150]);
  const okMails = [];
  const [b] = await proposeSweep(ok.db, { chain: 'tron', providers: ok.providers, limits: LIM, now: T0 });
  await approveSweep(ok.db, { id: b.id, actor: 'admin', reason: '例行归集', providers: ok.providers, notify: async (s, x) => okMails.push(s + x), now: T0 });
  assert.equal(okMails.filter((m) => /能量/.test(m)).length, 0);
  await ok.db.end?.();
});

test('没配租能量平台：直接烧 TRX；发起账户 TRX 连烧都不够 → 不发（签名前就停，批次退回待确认、错误写明 TRX 不够）', async () => {
  const { proposeSweep, approveSweep, getBatch } = await sweepMod();
  const t = await setupT({ customers: 2 });
  await fund(t, [150, 150]);
  const items = (await t.db.query(`select address, salt from customer_addresses where chain = 'tron' order by id`)).map((r) => ({ ...r, amount: usd(150), deploy: true }));
  const r = await t.p.executeSweep({ chain: 'tron', items });
  assert.equal(r.energy?.mode, 'burn');
  // TRX 不够
  const poor = await setupT({ customers: 2, renter: renterStub({ fail: 'tronsave_unavailable' }), opBalance: 1_000_000 });
  await fund(poor, [150, 150]);
  const [b] = await proposeSweep(poor.db, { chain: 'tron', providers: poor.providers, limits: LIM });
  const origErr = console.error; console.error = quiet.error;
  try {
    await assert.rejects(approveSweep(poor.db, { id: b.id, actor: 'admin', reason: 'x', providers: poor.providers }), (e) => e.code === 'sweep_not_sent');
  } finally { console.error = origErr; }
  const got = await getBatch(poor.db, b.id);
  assert.equal(got.status, 'awaiting_approval');
  assert.match(got.error || '', /trx|energy|能量/i);
  assert.equal(poor.node.state.broadcasts.length, 0);
  await t.db.end?.(); await poor.db.end?.();
});

test('租能量平台预存余额上限 1,000 TRX：超过就告警（只发一次，24 小时内不重发）；回到 1,000 以下发恢复；查不到余额不告警、不报错', async () => {
  const { checkRentalBalance, RENTAL_PREPAID_MAX_TRX } = await import('../server/wallet/energy.js');
  assert.equal(RENTAL_PREPAID_MAX_TRX, 1000);
  const db = await setupDb();
  const mails = [];
  const notify = async (s, x) => mails.push([s, x]);
  const now = Date.parse('2026-12-01T00:00:00Z');
  const r0 = await checkRentalBalance(db, { renter: renterStub({ balanceSun: 1_000_000_000n }), notify, now });
  assert.equal(r0.status, 'ok', '正好 1,000 TRX 不告警');
  assert.equal(mails.length, 0);
  const r1 = await checkRentalBalance(db, { renter: renterStub({ balanceSun: 1_000_000_001n }), notify, now });
  assert.equal(r1.status, 'over');
  assert.equal(mails.length, 1);
  assert.match(mails[0][0] + mails[0][1], /1,?000/);
  await checkRentalBalance(db, { renter: renterStub({ balanceSun: 5_000_000_000n }), notify, now: now + 3_600_000 });
  assert.equal(mails.length, 1, '24 小时内不重发');
  const r2 = await checkRentalBalance(db, { renter: renterStub({ balanceSun: new Error('down') }), notify, now: now + 7_200_000 });
  assert.equal(r2.status, 'unknown');
  assert.equal(mails.length, 1);
  await checkRentalBalance(db, { renter: renterStub({ balanceSun: 300_000_000n }), notify, now: now + 10_800_000 });
  assert.equal(mails.length, 2, '恢复发一封');
  // 没配租能量平台：不检查
  assert.equal((await checkRentalBalance(db, { renter: null, notify, now })).status, 'not_configured');
  await db.end?.();
});

test('交易号：返回的交易号 = sha256(交易原文)，签名人 = 发起账户（服务器只签批量合约的 sweep，不签别的）', async () => {
  const t = await setupT({ customers: 1 });
  await fund(t, [150]);
  const items = (await t.db.query(`select address, salt from customer_addresses where chain = 'tron'`)).map((r) => ({ ...r, amount: usd(150), deploy: true }));
  const r = await t.p.executeSweep({ chain: 'tron', items });
  const tx = t.node.state.broadcasts[0];
  assert.equal(r.txRefs[0], hex.encode(sha256(hex.decode(tx.raw))));
  assert.equal(T(tx.owner), t.operator.address);
  await t.db.end?.();
});
