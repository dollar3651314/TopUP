// 测试会话补测（每日对账扩到三条链）：需求是每日对账按链核对"账本应收"和"链上实际"——
//   链上 = 合约充值地址上的 USDT + 这条链的合约冷钱包（parent）+ 这条链的热钱包；没开通的链跳过；有差额告警。
//   一、三条链都开通、钱分散在充值地址 / 冷钱包 / 热钱包：链上按链列出（ETH 100、BSC 50、TRON 30），合计差额 0，不告警
//   二、BSC 冷钱包少了 5 USDT：合计差额 -5；发对账不一致的告警，告警里按链列出、BSC 那一行是 45
//   三、只开通 TRON：以太坊、BSC 跳过（不列、不算、不告警），TRON 照常核对，冷钱包余额计入
//   四、冷钱包余额计入：三条链的钱全部归集进冷钱包后，每条链的链上 = 冷钱包 = 入账金额，差额仍是 0
//   五、账本应收也按链列出、按链算差额（BSC 少 5 时只有 BSC 差额 -5）
// 只用内存数据库和 ETH、BSC、TRON 的内存替身（APP_ENV=local），不连任何节点、不需要密钥。
// 读取结果的小工具 perChain / onchainOf 只认"按链列出"的结构（recon.by_chain 等），字段名对上研发的实现时只改这里，不改期望。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createOps } from '../server/pay/ops.js';
import { derivePayKeys } from '../server/pay/common.js';
import { createWalletLayer } from '../server/wallet/index.js';
import { loadConfig } from '../server/config.js';
import { walletsFor } from '../server/pay/deps.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { runDaily } from '../server/pay/daily.js';
import { tronScheme, randomTron } from './tron-helpers.js';

const U = 1_000_000;
const CHAINS = ['eth', 'bsc', 'tron'];
const LABEL = { eth: /以太坊|ETH|Ethereum/i, bsc: /BSC|BNB/i, tron: /TRON/i };

async function setup(enabled = CHAINS, { coldIsTronParent = false } = {}) {
  const db = await createTestDb(); await migrate(db);
  const local = walletsFor('local');
  const evm = Object.fromEntries(Object.entries(local.evm || {}).filter(([c]) => enabled.includes(c)));
  const { scheme, usdt } = tronScheme();
  const tronCfg = enabled.includes('tron') ? { ...scheme, usdt } : null;
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm, tron: tronCfg });
  assert.deepEqual([...layer.enabledChains].sort(), [...enabled].sort(), `替身钱包层开通的链：${JSON.stringify(layer.errors)}`);
  const ops = createOps({ db, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), payBase: 'https://pay.test', wallet: layer });
  await core.createMerchant(db, { id: 'mr', name: 'Recon Co', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  await db.query(`update merchants set order_mode = jsonb_set(order_mode, '{enabled}', 'true') where id = 'mr'`);
  const [m] = await db.query(`select * from merchants where id = 'mr'`);
  await ops.upsertCustomer(m, { customer_id: 'cu1' });
  const addr = {};
  for (const chain of enabled) addr[chain] = (await ops.createOrder(m, { customer_id: 'cu1', merchant_order_no: `R-${chain}`, amount: '10', chain })).address;
  // 冷钱包：合约钱包的 parent；热钱包：config/wallets.json 里这条链的 hot（TRON 合约钱包没有单独的热钱包）
  const parent = { eth: local.evm?.eth?.parent, bsc: local.evm?.bsc?.parent, tron: scheme.parent };
  const hot = { eth: local.evm?.eth?.hot, bsc: local.evm?.bsc?.hot };
  /** 客户付款：链上转到充值地址 + 记账（等同扫链入账） */
  const deposit = async (chain, amount, status = 'credited') => {
    const p = layer.adapters[chain].pay({ to: addr[chain], amount });
    const r = await core.recordDeposit(db, { chain, txid: String(p.txid).replace(/^0x/, ''), logIndex: 0, block: p.block, to: addr[chain], amount, time: new Date() });
    assert.equal(r.status, status);
  };
  /** 链上把钱从充值地址挪到别处（归集进冷钱包、冷钱包给热钱包备款）：账本不变 */
  const move = async (chain, from, to, amount) => {
    const a = layer.adapters[chain];
    // 替身没有"转出"的接口：给目标付一笔正数、给来源付一笔负数，余额变化和真实转账相同
    a.pay({ to, amount });
    a.pay({ to: from, amount: -amount });
    assert.ok((await a.tokenBalanceRaw(from)) >= 0n, '模拟转出后来源余额不能为负');
  };
  const tron = createFakeTron(); // 第 0 批助记词地址（本用例没有老客户）
  await core.setMeta(db, 'tick_last', { at: new Date().toISOString() }); // 链上监控刚跑过，不触发"超过 5 分钟"的提醒
  const mails = [];
  const notify = async (s, t) => { mails.push(`${s}\n${t}`); };
  // coldIsTronParent：顶层 cold（TRON 第 0 批冷钱包）和 TRON 合约钱包的 parent 是同一个地址
  const wallets = { ...local, tron: tronCfg, ...(coldIsTronParent ? { cold: scheme.parent } : {}) };
  const daily = () => runDaily({ db, tron, wallets, notify, layer });
  return { db, layer, addr, parent, hot, deposit, move, mails, daily, m, tron, wallets };
}

/** 从每日任务的结果里取"按链列出"的对账：返回 { eth?, bsc?, tron? }，每项有链上合计 total（或差额 diff），0.000001 USDT 单位 */
function perChain(out) {
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return null;
    seen.add(o);
    if (Array.isArray(o) && o.length && o.every((x) => x && typeof x === 'object' && CHAINS.includes(x.chain))) return Object.fromEntries(o.map((x) => [x.chain, x]));
    if (!Array.isArray(o) && CHAINS.some((c) => o[c] && typeof o[c] === 'object' && ('diff' in o[c] || 'total' in o[c]))) return Object.fromEntries(CHAINS.filter((c) => o[c]).map((c) => [c, o[c]]));
    for (const v of Object.values(o)) { const r = walk(v, depth + 1); if (r) return r; }
    return null;
  };
  return walk(out.recon ?? out, 0);
}
const skipped = (e) => !e || e.skipped === true || /skip|not_enabled|disabled/i.test(String(e.status ?? e.result ?? ''));
const num = (v) => Number(v);
/** 这条链的链上合计（充值地址 + 热钱包 + 冷钱包） */
const onchainOf = (e) => num(e.total ?? e.onchain ?? e.chain_total);
const coldOf = (e) => num(e.cold ?? e.parent);
/** 这条链的账本应收（研发实现里有按链应收时用；没有返回 NaN） */
const ledgerOf = (e) => num(e.ledger ?? e.expected ?? e.receivable);

test('一、三条链都开通，钱分散在充值地址、合约冷钱包、热钱包：链上按链列出、各链金额对，合计差额 0，不告警', async () => {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  // ETH：60 留在充值地址，30 已归集进冷钱包，10 由冷钱包备到热钱包；BSC：全部归集进冷钱包；TRON：留在充值地址
  await s.move('eth', s.addr.eth, s.parent.eth, 40 * U);
  await s.move('eth', s.parent.eth, s.hot.eth, 10 * U);
  await s.move('bsc', s.addr.bsc, s.parent.bsc, 50 * U);
  const out = await s.daily();
  const pc = perChain(out);
  assert.ok(pc, `对账结果要按链列出：${JSON.stringify(out.recon)}`);
  for (const [c, want] of [['eth', 100 * U], ['bsc', 50 * U], ['tron', 30 * U]]) {
    assert.ok(pc[c] && !skipped(pc[c]), `${c}：开通了就要核对`);
    assert.equal(onchainOf(pc[c]), want, `${c}：链上合计（充值地址 + 热钱包 + 冷钱包）应为 ${want}（${JSON.stringify(pc[c])}）`);
  }
  assert.equal(num(out.recon.diff), 0, `合计差额应为 0：${JSON.stringify(out.recon)}`);
  assert.equal(s.mails.filter((m) => /对账/.test(m)).length, 0, `一致时不发对账告警：${s.mails.join('\n---\n')}`);
});

test('二、BSC 冷钱包少了 5 USDT：合计差额 -5，发对账不一致告警；告警里按链列出，BSC 那一行是 45', async () => {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  await s.move('bsc', s.addr.bsc, s.parent.bsc, 50 * U);
  await s.move('bsc', s.parent.bsc, '0x000000000000000000000000000000000000dEaD', 5 * U); // 冷钱包里少了 5
  const out = await s.daily();
  const pc = perChain(out);
  assert.ok(pc, `对账结果要按链列出：${JSON.stringify(out.recon)}`);
  assert.equal(num(out.recon.diff), -5 * U, JSON.stringify(out.recon));
  assert.equal(onchainOf(pc.bsc), 45 * U, JSON.stringify(pc.bsc));
  assert.equal(onchainOf(pc.eth), 100 * U, JSON.stringify(pc.eth));
  assert.equal(onchainOf(pc.tron), 30 * U, JSON.stringify(pc.tron));
  const alert = s.mails.find((m) => /对账不一致/.test(m));
  assert.ok(alert, `要发对账不一致的告警：${s.mails.join('\n---\n')}`);
  const bscLine = alert.split('\n').find((l) => LABEL.bsc.test(l));
  assert.ok(bscLine, `告警要按链列出 BSC：${alert}`);
  assert.match(bscLine, /45(\.0+)?\b/, `BSC 那一行要写出 45：${bscLine}`);
  for (const c of ['eth', 'tron']) assert.ok(alert.split('\n').some((l) => LABEL[c].test(l)), `告警要按链列出 ${c}：${alert}`);
});

test('三、只开通 TRON：以太坊、BSC 跳过（不核对、不算不一致、不告警），TRON 照常核对，冷钱包余额计入', async () => {
  const s = await setup(['tron']);
  await s.deposit('tron', 30 * U);
  await s.move('tron', s.addr.tron, s.parent.tron, 20 * U); // 20 已归集进 TRON 合约冷钱包
  const out = await s.daily();
  const pc = perChain(out);
  assert.ok(pc && pc.tron, `TRON 要按链列出：${JSON.stringify(out.recon)}`);
  assert.ok(!skipped(pc.tron), 'TRON 开通了，要核对');
  assert.equal(onchainOf(pc.tron), 30 * U, `TRON 冷钱包余额要计入（${JSON.stringify(pc.tron)}）`);
  assert.equal(coldOf(pc.tron), 20 * U, `TRON 冷钱包 20（${JSON.stringify(pc.tron)}）`);
  for (const c of ['eth', 'bsc']) {
    assert.ok(skipped(pc[c]), `${c} 没开通，应跳过（${JSON.stringify(pc[c])}）`);
    if (pc[c]) assert.ok(!onchainOf(pc[c]), `${c} 跳过时不能有金额`);
  }
  assert.equal(num(out.recon.diff), 0, JSON.stringify(out.recon));
  assert.equal(out.recon.complete, true, '没开通的链不能让对账变成"没查完"');
  assert.equal(s.mails.filter((m) => /对账/.test(m)).length, 0, `只开 TRON 且一致时不告警：${s.mails.join('\n---\n')}`);
});

test('四、合约冷钱包余额计入：三条链的钱全部归集进冷钱包后，每条链链上 = 冷钱包 = 入账金额，差额仍是 0', async () => {
  const s = await setup();
  const want = { eth: 70 * U, bsc: 20 * U, tron: 40 * U };
  for (const [c, a] of Object.entries(want)) {
    await s.deposit(c, a);
    await s.move(c, s.addr[c], s.parent[c], a);
  }
  const out = await s.daily();
  const pc = perChain(out);
  assert.ok(pc, `对账结果要按链列出：${JSON.stringify(out.recon)}`);
  for (const c of CHAINS) {
    assert.equal(coldOf(pc[c]), want[c], `${c}：冷钱包余额（${JSON.stringify(pc[c])}）`);
    assert.equal(onchainOf(pc[c]), want[c], `${c}：链上合计含冷钱包（${JSON.stringify(pc[c])}）`);
  }
  assert.equal(num(out.recon.diff), 0, JSON.stringify(out.recon));
  assert.equal(s.mails.filter((m) => /对账/.test(m)).length, 0, s.mails.join('\n---\n'));
});

test('五、账本应收按链列出、按链算差额：BSC 冷钱包少 5 时 BSC 应收 50、差额 -5，以太坊、TRON 差额 0', async () => {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  await s.move('bsc', s.addr.bsc, s.parent.bsc, 50 * U);
  await s.move('bsc', s.parent.bsc, '0x000000000000000000000000000000000000dEaD', 5 * U);
  const out = await s.daily();
  const pc = perChain(out);
  assert.ok(pc, `对账结果要按链列出：${JSON.stringify(out.recon)}`);
  for (const [c, ledger, diff] of [['eth', 100 * U, 0], ['bsc', 50 * U, -5 * U], ['tron', 30 * U, 0]]) {
    assert.equal(ledgerOf(pc[c]), ledger, `${c}：账本应收要按链列出，应为 ${ledger}（${JSON.stringify(pc[c])}）`);
    assert.equal(num(pc[c].diff), diff, `${c}：按链差额应为 ${diff}（${JSON.stringify(pc[c])}）`);
  }
});

/** 让替身查某个地址的余额时出错（模拟节点查不到热钱包、冷钱包） */
function failBalanceOf(adapter, address) {
  const orig = adapter.tokenBalanceRaw.bind(adapter);
  adapter.tokenBalanceRaw = async (a, ...rest) => {
    if (String(a).toLowerCase() === String(address).toLowerCase()) throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    return orig(a, ...rest);
  };
}
const mismatchMails = (s) => s.mails.filter((m) => /对账不一致/.test(m));

test('六、热钱包或冷钱包查不到：这条链 complete = false，对账没查完，这条链标【没查完】不比、查完的链对不上照常告警、不比合计；存进 recon 表（后台对账页读它）的也是"没查完"', async () => {
  for (const [label, pick] of [['以太坊热钱包', (s) => ['eth', s.hot.eth]], ['TRON 冷钱包（parent）', (s) => ['tron', s.parent.tron]]]) {
    const s = await setup();
    await s.deposit('eth', 100 * U);
    await s.deposit('bsc', 50 * U);
    await s.deposit('tron', 30 * U);
    await s.move('eth', s.addr.eth, s.hot.eth, 40 * U);
    await s.move('tron', s.addr.tron, s.parent.tron, 30 * U);
    await s.move('bsc', s.addr.bsc, '0x000000000000000000000000000000000000dEaD', 5 * U); // 另有一条链真的少了钱，也不能拿没查完的数字告警
    const [chain, address] = pick(s);
    failBalanceOf(s.layer.adapters[chain], address);
    const out = await s.daily();
    const pc = perChain(out);
    assert.ok(pc && pc[chain], `${label}：对账结果要按链列出（${JSON.stringify(out.recon)}）`);
    assert.equal(pc[chain].complete, false, `${label}：这条链应是 complete = false（${JSON.stringify(pc[chain])}）`);
    assert.ok(num(pc[chain].wallet_errors) >= 1, `${label}：要记下钱包没查到（${JSON.stringify(pc[chain])}）`);
    for (const c of CHAINS.filter((x) => x !== chain)) assert.equal(pc[c].complete, true, `${label}：别的链（${c}）照常查完`);
    assert.equal(out.recon.complete, false, `${label}：整份对账没查完`);
    // 口径变更（对账小改，产品验收定）：没查完的链不比、不拿它的数字告警；查完的 BSC 真的少了 5，照常告警；合计这次不比
    const alert = mismatchMails(s)[0];
    assert.ok(alert, `${label}：查完的 BSC 少了 5，要告警：${s.mails.join('\n---\n')}`);
    const line = (c) => alert.split('\n').find((l) => new RegExp(`^(【[^】]+】)?(?:${LABEL[c].source})[：:]`).test(l)) || '';
    assert.match(line(chain), /^【没查完】/, `${label}：没查完的链标【没查完】：${alert}`);
    assert.doesNotMatch(line(chain), /差额/, `${label}：没查完的链不写差额：${alert}`);
    assert.match(line('bsc'), /^【对不上】/, `${label}：BSC 标【对不上】：${alert}`);
    assert.doesNotMatch(alert, /合计链上/, `${label}：有链没查完时不比合计：${alert}`);
    // 后台"对账"页和概览读的是 recon 表：存进去的也必须是没查完
    const [row] = await s.db.query('select detail from recon order by day desc limit 1');
    assert.equal(row.detail.complete, false, `${label}：存进 recon 表的是"没查完"`);
    assert.equal(row.detail.by_chain[chain].complete, false, `${label}：recon 表里这条链是"没查完"`);
  }
});

test('七、低于 1 USDT 的到账：算进这条链的应收和链上，差额 0，不告警', async () => {
  const s = await setup();
  await s.deposit('bsc', 500_000, 'below_min'); // 0.5 USDT：不入账，但钱在链上
  await s.deposit('eth', 10 * U);
  const out = await s.daily();
  const pc = perChain(out);
  assert.equal(ledgerOf(pc.bsc), 500_000, `BSC 应收要算上 0.5（${JSON.stringify(pc.bsc)}）`);
  assert.equal(onchainOf(pc.bsc), 500_000, `BSC 链上 0.5（${JSON.stringify(pc.bsc)}）`);
  assert.equal(num(pc.bsc.diff), 0, JSON.stringify(pc.bsc));
  assert.equal(num(pc.eth.diff), 0, JSON.stringify(pc.eth));
  assert.equal(num(out.recon.diff), 0, `合计差额 0（未入账的钱算在应有里）：${JSON.stringify(out.recon)}`);
  assert.equal(mismatchMails(s).length, 0, s.mails.join('\n---\n'));
});

test('八、已完成的打款从打款那条链的应收里扣；没完成的打款（待审核、已广播未确认）不扣', async () => {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  const TO = '0x1111111111111111111111111111111111111111';
  // 以太坊打款 30：已完成，链上从热钱包付出去
  const done = await core.requestWithdrawal(s.db, s.m, { kind: 'payout', chain: 'eth', to: TO, amount: 30 * U, source: 'web' });
  await core.markWithdrawal(s.db, done.withdrawal_no, 'signing'); await core.markWithdrawal(s.db, done.withdrawal_no, 'broadcast', { txid: '0x' + 'a'.repeat(64) });
  await core.settleWithdrawal(s.db, done.withdrawal_no, true);
  await s.move('eth', s.addr.eth, s.hot.eth, 30 * U);
  await s.move('eth', s.hot.eth, TO, 30 * U);
  // BSC 打款 20：已广播还没确认（钱还在链上热钱包里没出去）；以太坊再一笔 5 待审核
  const pend = await core.requestWithdrawal(s.db, s.m, { kind: 'payout', chain: 'bsc', to: TO, amount: 20 * U, source: 'web' });
  await core.markWithdrawal(s.db, pend.withdrawal_no, 'signing'); await core.markWithdrawal(s.db, pend.withdrawal_no, 'broadcast', { txid: '0x' + 'b'.repeat(64) });
  await core.requestWithdrawal(s.db, s.m, { kind: 'payout', chain: 'eth', to: TO, amount: 5 * U, source: 'web' });
  const out = await s.daily();
  const pc = perChain(out);
  assert.equal(ledgerOf(pc.eth), 70 * U, `以太坊应收 = 到账 100 − 已完成打款 30（${JSON.stringify(pc.eth)}）`);
  assert.equal(ledgerOf(pc.bsc), 50 * U, `BSC 没完成的打款不扣（${JSON.stringify(pc.bsc)}）`);
  assert.equal(ledgerOf(pc.tron), 30 * U, `TRON 不受别的链打款影响（${JSON.stringify(pc.tron)}）`);
  for (const c of CHAINS) assert.equal(num(pc[c].diff), 0, `${c}：差额 0（${JSON.stringify(pc[c])}）`);
  assert.equal(num(out.recon.diff), 0, JSON.stringify(out.recon));
  assert.equal(mismatchMails(s).length, 0, s.mails.join('\n---\n'));
});

test('九、链之间调钱（TRON 冷钱包 10 换到以太坊热钱包）：TRON -10、以太坊 +10、合计 0；仍然告警，两条链都标出对不上', async () => {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  await s.move('tron', s.addr.tron, s.parent.tron, 30 * U);
  await s.move('tron', s.parent.tron, randomTron(), 10 * U); // TRON 冷钱包转出 10（换币）
  s.layer.adapters.eth.pay({ to: s.hot.eth, amount: 10 * U }); // 以太坊热钱包收到 10
  const out = await s.daily();
  const pc = perChain(out);
  assert.equal(num(pc.tron.diff), -10 * U, JSON.stringify(pc.tron));
  assert.equal(num(pc.eth.diff), 10 * U, JSON.stringify(pc.eth));
  assert.equal(num(pc.bsc.diff), 0, JSON.stringify(pc.bsc));
  assert.equal(num(out.recon.diff), 0, `合计差额 0：${JSON.stringify(out.recon)}`);
  const alert = mismatchMails(s)[0];
  assert.ok(alert, `合计为 0 也要告警（按链对不上）：${s.mails.join('\n---\n')}`);
  const lineOf = (c) => alert.split('\n').find((l) => LABEL[c].test(l) && /应收|链上/.test(l));
  for (const c of ['tron', 'eth']) assert.match(lineOf(c) || '', /对不上/, `${c} 那一行要标出对不上：${alert}`);
  assert.doesNotMatch(lineOf('bsc') || '', /对不上/, `BSC 对得上，不能标：${alert}`);
});

test('十、顶层 cold 和 TRON 合约钱包的 parent 是同一个地址：冷钱包余额只算一次', async () => {
  const s = await setup(CHAINS, { coldIsTronParent: true });
  assert.equal(s.wallets.cold, s.parent.tron, '先确认两个配置是同一个地址');
  await s.deposit('tron', 30 * U);
  await s.move('tron', s.addr.tron, s.parent.tron, 20 * U);
  // 同一个地址，两种查法（第 0 批的 TronGrid 账户接口、合约钱包的节点）都能查到这 20
  s.tron.accounts.set(s.parent.tron, { activated: true, trx: 0, trc20: { [s.tron.contract]: 20 * U } });
  const out = await s.daily();
  const pc = perChain(out);
  assert.equal(coldOf(pc.tron), 20 * U, `冷钱包只算一次（${JSON.stringify(pc.tron)}）`);
  assert.equal(onchainOf(pc.tron), 30 * U, JSON.stringify(pc.tron));
  assert.equal(num(pc.tron.diff), 0, JSON.stringify(pc.tron));
  assert.equal(mismatchMails(s).length, 0, s.mails.join('\n---\n'));
});

test('十一、TRON 合约充值地址上出现 USDT 以外的代币：记到"异常到账"，并在每日检查邮件里提醒', async () => {
  const s = await setup();
  await s.deposit('tron', 30 * U);
  const OTHER = 'TOtherTokenxxxxxxxxxxxxxxxxxxxxxx';
  // TronGrid 账户接口列出这个合约地址上的代币：USDT 30 + 另一种代币 7
  s.tron.accounts.set(s.addr.tron, { activated: true, trx: 0, trc20: { [s.layer.config.tron.usdt]: 30 * U, [OTHER]: 7 } });
  const out = await s.daily();
  assert.equal(out.tokens, 1, JSON.stringify(out));
  const rows = await s.db.query(`select type, merchant_id, customer_id, address, ref from anomalies where type = 'token' and address = $1`, [s.addr.tron]);
  assert.equal(rows.length, 1, '这个合约地址记一条异常到账');
  assert.equal(rows[0].ref, OTHER);
  assert.equal(rows[0].merchant_id, 'mr');
  assert.equal(rows[0].customer_id, 'cu1');
  assert.ok(s.mails.some((m) => /USDT 以外的代币/.test(m)), s.mails.join('\n---\n'));
  assert.equal(num(perChain(out).tron.diff), 0, 'USDT 本身照常对账');
  await s.daily(); // 第二天再查：同一笔不重复记
  assert.equal((await s.db.query(`select count(*)::int n from anomalies where type = 'token' and address = $1`, [s.addr.tron]))[0].n, 1);
});
