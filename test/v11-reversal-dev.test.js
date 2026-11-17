// 研发补测（v1.1 冲正，复核意见）：
// - 两个 worker 同时复核（租约过期时可能发生）：每笔先原子地抢下来，旧的"没了"不能在别人查到"还在"之后冲正；冲正前在行锁里再核对
// - createChainCheck 的真实分支（假节点）：以太坊 / BSC 回执、交易池、换了日志序号、节点落后；TRON 固化区块落后、确认复核两次回答不一致；
//   本地替身：合约钱包收到的 TRON 到账按合约钱包替身判断（老 TronGrid 替身不认识它，不能当成没了）
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, U } from './qa-v11-helpers.js';
import * as core from '../server/pay/core.js';
import { recheckDeposits, reverseDeposit, createChainCheck, CLAIM_MS, CONFIRM_GAP_MS } from '../server/pay/reversal.js';
import { createFakeTronAdapter } from '../server/wallet/adapters/fake-tron.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { TRANSFER_TOPIC } from '../server/wallet/adapters/evm.js';

const MIN = 60_000;
const silent = { error: () => {} };

async function setup() {
  const w = await world({ fund: 0 });
  const addr = await w.customer('ma', 'c1');
  const r = await core.recordDeposit(w.db, { txid: w.txid(), logIndex: 0, block: 1, to: addr, amount: 100 * U, time: new Date() });
  assert.equal(r.status, 'credited');
  const id = String(r.deposit.id);
  const dep = async () => (await w.db.query('select * from deposits where id = $1', [Number(id)]))[0];
  const created = new Date((await dep()).created_at).getTime();
  return { ...w, id, created, dep };
}
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

test('冲正并发：A 抢下确认复核后很慢；抢的期限内 B 抢不到；期限过后 B 查到还在，A 迟到的"没了"不能冲正', async () => {
  const t = await setup();
  const T = t.created;
  // 30 分钟：第一次查到没了
  await recheckDeposits(t.db, { now: T + 31 * MIN, check: async () => false, log: silent });
  assert.ok((await t.dep()).recheck_gone_at, '前提：记下了第一次没了');
  // 40 分钟：A 抢下确认复核，节点很慢
  const slow = deferred();
  let started;
  const startedP = new Promise((r) => { started = r; });
  const a = recheckDeposits(t.db, { now: T + 42 * MIN, check: async () => { started(); await slow.p; return false; }, log: silent });
  await startedP;
  // 同一时刻 B 也来：抢不到，不复核
  const b1 = await recheckDeposits(t.db, { now: T + 43 * MIN, check: async () => { throw new Error('B 不该复核'); }, log: silent });
  assert.equal(b1.checked + b1.inconclusive, 0, 'A 抢着的时候 B 抢不到');
  // A 的期限过了（例如 worker 卡住）：B 接手，查到还在
  const b2 = await recheckDeposits(t.db, { now: T + 42 * MIN + CLAIM_MS + MIN, check: async () => true, log: silent });
  assert.equal(b2.checked, 1);
  assert.equal((await t.dep()).recheck_gone_at, null, 'B 查到还在：清掉"没了"');
  // A 这时才回来说"没了"：不冲正
  slow.resolve();
  const ra = await a;
  assert.equal(ra.reversed, 0);
  const d = await t.dep();
  assert.equal(d.result, 'credited', '不能冲正');
  assert.equal(Number((await t.balance('ma')).available), 99 * U, '余额不动');
  assert.equal((await t.db.query(`select count(*)::int n from ledger where type = 'reversal'`))[0].n, 0);
  await t.db.end();
});

test('冲正前在行锁里核对：没有"没了"标记、隔不够 10 分钟、之后查到过还在，都不冲正（not_confirmed）', async () => {
  const t = await setup();
  const at = t.created + 60 * MIN;
  assert.equal((await reverseDeposit(t.db, t.id, { now: at, confirmedGone: true })).status, 'not_confirmed', '没有"没了"标记');
  // 刚标记 5 分钟
  await t.db.query('update deposits set recheck_gone_at = $2 where id = $1', [Number(t.id), new Date(at - 5 * MIN)]);
  await t.db.query(`insert into deposit_rechecks (deposit_id, checked_at, result) values ($1, $2, 'gone')`, [Number(t.id), new Date(at - 5 * MIN)]);
  assert.equal((await reverseDeposit(t.db, t.id, { now: at, confirmedGone: true })).status, 'not_confirmed', '隔不够 10 分钟');
  // 隔够了，但之间查到过还在
  await t.db.query(`insert into deposit_rechecks (deposit_id, checked_at, result) values ($1, $2, 'present')`, [Number(t.id), new Date(at)]);
  await t.db.query(`insert into deposit_rechecks (deposit_id, checked_at, result) values ($1, $2, 'gone')`, [Number(t.id), new Date(at + CONFIRM_GAP_MS)]);
  assert.equal((await reverseDeposit(t.db, t.id, { now: at + CONFIRM_GAP_MS, confirmedGone: true })).status, 'not_confirmed', '之间查到过还在');
  assert.equal((await t.dep()).result, 'credited');
  // 正常确认：之后只有"没了"
  await t.db.query('delete from deposit_rechecks where deposit_id = $1 and result = $2', [Number(t.id), 'present']);
  assert.equal((await reverseDeposit(t.db, t.id, { now: at + CONFIRM_GAP_MS, confirmedGone: true })).status, 'reversed');
  await t.db.end();
});

test('复核：处理一笔时出了别的错（例如数据库出错）只记日志，其余照常复核', async () => {
  const t = await setup();
  const addr = await t.customer('ma', 'c2');
  const r2 = await core.recordDeposit(t.db, { txid: t.txid(), logIndex: 0, block: 2, to: addr, amount: 50 * U, time: new Date() });
  const bad = Number(t.id);
  const db = { ...t.db, query: (sql, params) => (/insert into deposit_rechecks/.test(sql) && Number(params[0]) === bad ? Promise.reject(new Error('db down')) : t.db.query(sql, params)) };
  const errors = [];
  const out = await recheckDeposits(db, { now: t.created + 31 * MIN, log: { error: (m) => errors.push(m) }, check: async () => true });
  assert.equal(errors.length, 1, '出错的那一笔记日志');
  assert.match(errors[0], /db down/);
  assert.equal(out.checked, 2);
  const rows = await t.db.query('select result from deposit_rechecks where deposit_id = $1', [Number(r2.deposit.id)]);
  assert.deepEqual(rows.map((x) => x.result), ['present'], '另一笔照常复核');
  await t.db.end();
});

// ---------- createChainCheck：以太坊 / BSC ----------
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7';
const topicAddr = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const log = ({ to = ADDR, raw = 100n * 10n ** 6n, logIndex = 3, removed = false, address = USDT } = {}) => ({
  address, removed, logIndex: '0x' + logIndex.toString(16), topics: [TRANSFER_TOPIC, topicAddr('0x' + '11'.repeat(20)), topicAddr(to)], data: '0x' + raw.toString(16).padStart(64, '0'),
});
const metaDb = (scanHead = null) => ({ query: async (_sql, [key]) => (scanHead !== null && key === 'evm_scan_eth' ? [{ value: { head: scanHead } }] : []) });
const evmCheck = (lookup, { decimals = 6, scanHead = null, confirmations = 2 } = {}) => createChainCheck({
  db: metaDb(scanHead), tron: null, layer: { adapters: { eth: { usdt: USDT, decimals, confirmations, txLookup: async () => lookup } } },
});
const X = { id: '1', chain: 'eth', txid: '0xabc', logIndex: 3, block: 100, address: ADDR, amount: 100 * U };

test('复核（以太坊 / BSC）：回执里有同收款人同金额的 Transfer 算还在（换了区块或日志序号也算）；收款人或金额不对算没了', async () => {
  const ok = { head: 200, tx: { hash: '0xabc' }, receipt: { status: '0x1', blockNumber: '0x99', logs: [log()] } };
  assert.equal(await evmCheck(ok)(X), true);
  assert.equal(await evmCheck({ ...ok, receipt: { ...ok.receipt, logs: [log({ logIndex: 7 })], blockNumber: '0xa0' } })(X), true, '重组后重新打包，日志序号变了');
  assert.equal(await evmCheck({ ...ok, receipt: { ...ok.receipt, logs: [log({ to: '0x' + '22'.repeat(20) })] } })(X), false, '收款人不对');
  assert.equal(await evmCheck({ ...ok, receipt: { ...ok.receipt, logs: [log({ raw: 1n })] } })(X), false, '金额不对');
  assert.equal(await evmCheck({ ...ok, receipt: { ...ok.receipt, logs: [log({ removed: true })] } })(X), false, '日志被移除');
  assert.equal(await evmCheck({ ...ok, receipt: { ...ok.receipt, logs: [log({ address: '0x' + '33'.repeat(20) })] } })(X), false, '不是 USDT 合约');
  assert.equal(await evmCheck({ ...ok, receipt: { ...ok.receipt, status: '0x0', logs: [] } })(X), false, '重新打包后执行失败');
  // BSC 的 USDT 是 18 位小数
  const bsc = { ...ok, receipt: { ...ok.receipt, logs: [log({ raw: 100n * 10n ** 18n })] } };
  assert.equal(await evmCheck(bsc, { decimals: 18 })(X), true);
});

test('复核（以太坊 / BSC）：回执没有但交易还在（回到交易池）不下结论；回执和交易都没有算没了；节点落后不下结论', async () => {
  await assert.rejects(evmCheck({ head: 200, tx: { hash: '0xabc', blockNumber: null }, receipt: null })(X), { code: 'tx_pending' });
  assert.equal(await evmCheck({ head: 200, tx: null, receipt: null })(X), false);
  await assert.rejects(evmCheck({ head: 101, tx: null, receipt: null })(X), { code: 'node_lagging' }, '最新区块 < 到账区块 + 确认数');
  await assert.rejects(evmCheck({ head: 200, tx: null, receipt: null }, { scanHead: 250 })(X), { code: 'node_lagging' }, '比扫链记下的最新区块旧');
  await assert.rejects(evmCheck({ head: 200, tx: { hash: '0xabc' }, receipt: { status: '0x1' } })(X), { code: 'receipt_without_logs' });
});

// ---------- createChainCheck：TRON ----------
const T = { id: '1', chain: 'tron', txid: 'ab'.repeat(32), logIndex: 0, block: 500, address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: 100 * U };
const tronCheck = (answers) => {
  const solids = [...answers.solid], infos = [...answers.info];
  return createChainCheck({ db: metaDb(), layer: null, tron: { solidBlock: async () => ({ number: solids.shift() }), txInfo: async () => infos.shift() } });
};

test('复核（TRON）：固化区块比到账区块旧不下结论；交易结果成功算还在、没有或失败算没了', async () => {
  await assert.rejects(tronCheck({ solid: [499], info: [null] })(T), { code: 'node_lagging' });
  assert.equal(await tronCheck({ solid: [600], info: [{ ok: true, block: 500 }] })(T), true);
  assert.equal(await tronCheck({ solid: [600], info: [{ ok: true, block: 520 }] })(T), true, '重新打包到别的区块也算还在');
  assert.equal(await tronCheck({ solid: [600], info: [null] })(T), false);
  assert.equal(await tronCheck({ solid: [600], info: [{ ok: false }] })(T), false);
});

test('复核（TRON）确认复核：两次回答一致才下结论；不一致、固化区块倒退、任一次落后都不下结论', async () => {
  assert.equal(await tronCheck({ solid: [600, 601], info: [null, null] })(T, { confirm: true }), false, '两次都说没了');
  assert.equal(await tronCheck({ solid: [600, 601], info: [{ ok: true }, { ok: true }] })(T, { confirm: true }), true);
  await assert.rejects(tronCheck({ solid: [600, 601], info: [null, { ok: true }] })(T, { confirm: true }), { code: 'node_inconsistent' });
  await assert.rejects(tronCheck({ solid: [600, 590], info: [null, null] })(T, { confirm: true }), { code: 'node_lagging' }, '固化区块倒退（换了后端）');
  await assert.rejects(tronCheck({ solid: [600, 499], info: [null, null] })(T, { confirm: true }), { code: 'node_lagging' });
});

test('复核（本地替身）：合约钱包收到的 TRON 到账按合约钱包替身判断，老 TronGrid 替身不认识它也不算没了', async () => {
  const legacy = createFakeTron();
  const wallet = createFakeTronAdapter({ usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' });
  const paid = wallet.pay({ to: 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q', amount: 100 * U });
  const check = createChainCheck({ db: metaDb(), tron: legacy, layer: { adapters: { tron: wallet } } });
  assert.equal(await check({ ...T, txid: paid.txid, block: paid.block }), true);
  assert.equal(await check({ ...T, txid: 'cd'.repeat(32) }), false, '两个替身都没有：没了');
  assert.equal(await check({ ...T, txid: paid.txid, logIndex: 1 }), false);
});
