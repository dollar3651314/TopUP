// 测试先写（第 2 批）：TRON 的 ChainAdapter（只给 contract 提供方用，和 adapters/evm.js 同一个形状）。
//   - 扫块：直接问 TRON 全节点（java-tron HTTP 接口，Nile 用 TronGrid 同样的路径；本机私链也一样），
//     按区块读交易回执（/wallet/gettransactioninfobyblocknum），从日志里找 USDT 合约的 Transfer 事件，只要转到我们地址的
//   - 只读到"最新区块 − 确认数"；第一次（没有游标）从当前已确认区块开始、不回扫历史；一次最多读 maxRange 个区块
//   - 失败的交易（回执不是 SUCCESS）不算；别的代币、Approval 事件、转给别人的不算；同一笔交易里几次转账各算一笔（logIndex 不同）
//   - 节点连不上、HTTP 出错（含 429 限流）、返回 Error、超时：直接抛出，不返回空结果、不推进游标（区间里任何一个块读不到都整段作废）
//   - txStatus：连不上 unknown；没回执 pending；确认数不够 pending；够了 SUCCESS → confirmed，否则 failed
//   - 地址对外一律 T 开头（customer_addresses.address 存的就是 T 开头）
// 要实现的模块：server/wallet/adapters/tron.js（createTronAdapter）；worker 每轮的扫链（server/wallet/scan.js 的 scanEvm 按开通的链循环，TRON 也在里面）；
//   server/pay/core.js 的 recordDeposit 对 TRON 也按 customer_addresses（链、地址）找客户（新地址不在 customers.address 里）
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeTronNode, tronScheme, randomTron, h20, word, APPROVAL_TOPIC, TRANSFER_TOPIC, quiet } from './tron-helpers.js';
import { setupDb, moneySnapshot } from './wallet-helpers.js';

const adapterMod = () => import('../server/wallet/adapters/tron.js');
const U = 1_000_000;

async function mk(state = {}, opts = {}) {
  const { usdt } = tronScheme();
  const node = fakeTronNode({ usdt, ...state });
  const { createTronAdapter } = await adapterMod();
  const a = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19, maxRange: 100, timeoutMs: 2000, ...opts });
  return { node, a, usdt };
}

test('TRON 适配器：形状和 evm 适配器一致（chain = tron、USDT 6 位小数、确认数），地址都是 T 开头', async () => {
  const { a, usdt } = await mk();
  assert.equal(a.chain, 'tron');
  assert.equal(a.decimals, 6);
  assert.equal(a.confirmations, 19);
  assert.equal(a.usdt, usdt);
  for (const m of ['head', 'transfers', 'txStatus', 'receipt', 'confirmationsOf', 'tokenBalanceRaw', 'nativeBalance', 'isContract', 'txKnown']) assert.equal(typeof a[m], 'function', m);
  const { createTronAdapter } = await adapterMod();
  assert.throws(() => createTronAdapter({ base: 'http://x', usdt: '0x' + '11'.repeat(20) }), /usdt/i, 'usdt 必须是 T 开头的 TRON 地址');
});

test('TRON 扫块：第一次没有游标时从当前已确认区块开始（不回扫历史）；之后从游标往后读，只读到"最新区块 − 确认数"', async () => {
  const { node, a } = await mk({ head: 1000 });
  const me = randomTron();
  node.transfer({ to: me, amount: 5 * U, block: 900 }); // 历史上的，不回扫
  const r0 = await a.transfers({ cursor: null, addresses: [me] });
  assert.deepEqual(r0.deposits, []);
  assert.equal(r0.next, String(1000 - 19));
  // 已确认区间里的转账能扫到；还没确认的（最新 19 个块里）不报、游标不越过它
  node.transfer({ to: me, amount: 7 * U, block: 983 });
  node.transfer({ to: me, amount: 9 * U, block: 995 });
  node.mine(5); // head 1005，已确认到 986
  const r1 = await a.transfers({ cursor: r0.next, addresses: [me] });
  assert.deepEqual(r1.deposits.map((d) => [d.block, d.amount]), [[983, 7 * U]]);
  assert.equal(r1.next, String(1005 - 19));
  // 再出块，995 那笔确认了
  node.mine(20);
  const r2 = await a.transfers({ cursor: r1.next, addresses: [me] });
  assert.deepEqual(r2.deposits.map((d) => [d.block, d.amount]), [[995, 9 * U]]);
});

test('TRON 扫块：识别 USDT 的 Transfer 事件——字段齐全（链、交易号、日志序号、区块、时间、付款方、收款方 T 开头、金额 0.000001 单位、链上原始数）', async () => {
  const { node, a } = await mk({ head: 2000 });
  const me = randomTron(), payer = randomTron();
  const t = node.transfer({ to: me, from: payer, amount: 123_456_789n, block: 1950 });
  const r = await a.transfers({ cursor: '1949', addresses: [me] });
  assert.equal(r.deposits.length, 1);
  const d = r.deposits[0];
  assert.equal(d.chain, 'tron');
  assert.equal(d.txid, t.txid);
  assert.equal(d.logIndex, 0);
  assert.equal(d.block, 1950);
  assert.equal(typeof d.time, 'number');
  assert.ok(d.time > 1_600_000_000_000, '时间是毫秒');
  assert.equal(d.to, me, '收款地址 T 开头，和 customer_addresses 里存的一致');
  assert.equal(d.from, payer);
  assert.equal(d.amount, 123_456_789);
  assert.equal(d.rawAmount, '123456789');
});

test('TRON 扫块：别的代币、Approval 事件、转给别人的、失败的交易都不算；一笔交易里两次转给我们各算一笔（logIndex 不同）；按区块、日志序号排序', async () => {
  const { node, a, usdt } = await mk({ head: 3000 });
  const me = randomTron(), other = randomTron(), fakeToken = randomTron();
  node.transfer({ token: fakeToken, to: me, amount: 50 * U, block: 2901 }); // 别的代币（假 USDT）
  node.transfer({ to: other, amount: 50 * U, block: 2902 }); // 转给别人
  node.transfer({ to: me, amount: 50 * U, block: 2903, topics: [APPROVAL_TOPIC, word(h20(randomTron())), word(h20(me))] }); // Approval
  // 失败的交易：回执 REVERT，带着一条看起来像 Transfer 的日志也不能算
  node.transfer({ to: me, amount: 50 * U, block: 2904, result: 'REVERT', extraLogs: [{ address: h20(usdt), topics: [TRANSFER_TOPIC, word(h20(randomTron())), word(h20(me))], data: word((50 * U).toString(16)) }] });
  // 一笔交易里两次转给我们（第二条日志）
  const two = node.transfer({ to: me, amount: 11 * U, block: 2906, extraLogs: [{ address: h20(usdt), topics: [TRANSFER_TOPIC, word(h20(randomTron())), word(h20(me))], data: word((12 * U).toString(16)) }] });
  node.transfer({ to: me, amount: 3 * U, block: 2905 });
  const r = await a.transfers({ cursor: '2900', addresses: [me] });
  assert.deepEqual(r.deposits.map((d) => [d.block, d.logIndex, d.amount]), [[2905, 0, 3 * U], [2906, 0, 11 * U], [2906, 1, 12 * U]]);
  assert.equal(r.deposits[1].txid, two.txid);
  assert.equal(r.deposits[2].txid, two.txid);
});

test('TRON 扫块：一次最多读 maxRange 个区块，游标只推进到读过的地方；地址很多也照样识别', async () => {
  const { node, a } = await mk({ head: 10_000 }, { maxRange: 50 });
  const mine = Array.from({ length: 250 }, () => randomTron());
  node.transfer({ to: mine[249], amount: 1 * U, block: 5040 });
  node.transfer({ to: mine[0], amount: 2 * U, block: 5060 });
  const r = await a.transfers({ cursor: '5000', addresses: mine });
  assert.equal(r.next, '5050');
  assert.deepEqual(r.deposits.map((d) => d.amount), [1 * U]);
  const r2 = await a.transfers({ cursor: r.next, addresses: mine });
  assert.deepEqual(r2.deposits.map((d) => d.amount), [2 * U]);
});

test('TRON 扫块：节点连不上、HTTP 500、429 限流、返回 Error、区间里有一个块读不到：都抛出（不返回空结果）', async () => {
  const me = randomTron();
  for (const bad of [{ down: true }, { httpStatus: 500 }, { httpStatus: 429 }]) {
    const { node, a } = await mk({ head: 4000, ...bad });
    node.transfer({ to: me, amount: 1 * U, block: 3950 });
    await assert.rejects(a.transfers({ cursor: '3940', addresses: [me] }), undefined, JSON.stringify(bad));
  }
  // 节点在某一个块上返回 Error：整段作废
  const { node, a } = await mk({ head: 4000 });
  node.transfer({ to: me, amount: 1 * U, block: 3945 });
  node.state.blocks.set(3950, { Error: 'class org.tron.core.exception.StoreException : block not found' });
  await assert.rejects(a.transfers({ cursor: '3940', addresses: [me] }));
  // 只有读回执那一步连不上（最新区块能读到）：同样抛出
  const b = await mk({ head: 4000 });
  b.node.transfer({ to: me, amount: 1 * U, block: 3950 });
  b.node.state.downFor = ['/wallet/gettransactioninfobyblocknum', '/walletsolidity/gettransactioninfobyblocknum'];
  await assert.rejects(b.a.transfers({ cursor: '3940', addresses: [me] }));
});

test('TRON 适配器：每个请求有超时（节点不回话时按 timeoutMs 失败，不卡住 worker）', async () => {
  const { usdt } = tronScheme();
  const { createTronAdapter } = await adapterMod();
  // 节点不回话：一直挂着，直到请求自己的超时把它取消（另开一个计时器让进程别提前退出；最多挂 5 秒）
  const hang = (url, init = {}) => new Promise((_, rej) => {
    const keep = setTimeout(() => rej(new Error('adapter did not time out within 5 s')), 5000);
    init.signal?.addEventListener('abort', () => { clearTimeout(keep); rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); });
  });
  const a = createTronAdapter({ base: 'http://hang.test', fetchImpl: hang, usdt, confirmations: 19, timeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(a.transfers({ cursor: '1', addresses: [randomTron()] }));
  assert.ok(Date.now() - t0 < 3000, `应在超时后很快失败，实际 ${Date.now() - t0} ms`);
  assert.equal(await a.txStatus('ab'.repeat(32)), 'unknown', '查交易时节点不回话：unknown');
});

test('TRON txStatus / confirmationsOf：连不上 unknown（不等于失败）；没回执 pending；确认数不够 pending；够了 SUCCESS → confirmed，回滚 → failed', async () => {
  const { node, a } = await mk({ head: 500 });
  const ok = node.transfer({ to: randomTron(), amount: 1, block: 495 });
  const bad = node.transfer({ to: randomTron(), amount: 1, block: 495, result: 'REVERT' });
  assert.equal(await a.txStatus('cd'.repeat(32)), 'pending');
  assert.equal(await a.txStatus(ok.txid), 'pending', '只有 6 个确认');
  assert.equal(await a.confirmationsOf(ok.txid), 6);
  assert.equal(await a.confirmationsOf('cd'.repeat(32)), 0);
  node.mine(30);
  assert.equal(await a.txStatus(ok.txid), 'confirmed');
  assert.equal(await a.txStatus(bad.txid), 'failed');
  node.state.down = true;
  assert.equal(await a.txStatus(ok.txid), 'unknown');
  assert.equal(await a.confirmationsOf(ok.txid), null);
});

test('TRON 适配器：USDT 余额走合约 balanceOf（地址没激活也能查到）；TRX 余额（sun）没激活为 0；isContract', async () => {
  const { node, a } = await mk({ head: 100 });
  const me = randomTron();
  node.transfer({ to: me, amount: 42n * BigInt(U), block: 99 });
  assert.equal(await a.tokenBalanceRaw(me), 42n * BigInt(U));
  assert.equal(BigInt(await a.nativeBalance(me)), 0n);
  node.activate(me, 1_000_000);
  assert.equal(BigInt(await a.nativeBalance(me)), 1_000_000n);
  assert.equal(await a.isContract(me), false);
  node.state.code.add(h20(me));
  assert.equal(await a.isContract(me), true);
  node.state.down = true;
  await assert.rejects(a.tokenBalanceRaw(me), undefined, '查余额连不上要抛出，不能当成 0');
});

// ---------- worker 每轮扫链：TRON 合约地址 ----------

/** contract 提供方只开 TRON（替身节点），客户 c1 分配一个 TRON 合约地址 */
async function tronLayer({ head = 1000 } = {}) {
  const { createContractProvider } = await import('../server/wallet/providers/contract.js');
  const { createTronAdapter } = await adapterMod();
  const { addressFor } = await import('../server/wallet/addresses.js');
  const { scheme, usdt } = tronScheme();
  const node = fakeTronNode({ head, scheme, usdt });
  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2']] });
  const adapter = createTronAdapter({ base: node.base, fetchImpl: node.fetchImpl, usdt, confirmations: 19, timeoutMs: 2000 });
  const contract = createContractProvider({ db, chains: { tron: { adapter, scheme, usdt } } });
  const providers = { contract };
  const layer = { providers, adapters: { tron: adapter }, enabledChains: ['tron'], errors: {}, onchain: {} };
  const a1 = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'tron', providers });
  return { db, node, layer, a1, scheme, usdt, providers };
}

test('worker 扫链：TRON 合约地址收到 USDT → 按（tron、地址）找到客户入账（地址不在 customers.address 里也要找到）；同一笔不重复入账', async () => {
  const { scanEvm } = await import('../server/wallet/scan.js');
  const { db, node, layer, a1 } = await tronLayer();
  assert.match(a1.address, /^T/);
  await scanEvm(db, { layer }); // 第一次：只记下起点
  node.transfer({ to: a1.address, amount: 150 * U, block: node.state.head + 1 });
  node.mine(25);
  const r = await scanEvm(db, { layer });
  assert.equal(r.tron.credited, 1, JSON.stringify(r));
  const deps = await db.query(`select chain, address, customer_id, amount from deposits`);
  assert.deepEqual(deps.map((d) => [d.chain, d.address, d.customer_id, Number(d.amount)]), [['tron', a1.address, 'c1', 150 * U]]);
  const [b] = await db.query(`select available from balances where merchant_id = 'm1'`);
  assert.ok(Number(b.available) > 0, '入了商户余额');
  // 再扫一遍（游标没动的情况下也不重复）
  await scanEvm(db, { layer });
  assert.equal((await db.query(`select count(*)::int n from deposits`))[0].n, 1);
  await db.end?.();
});

test('worker 扫链：TRON 节点连不上时游标不动、告警一次；恢复后从停下的区块接着扫，期间的到账不丢；以太坊、BSC 不受影响', async () => {
  const { scanEvm } = await import('../server/wallet/scan.js');
  const { db, node, layer, a1 } = await tronLayer();
  const mails = [];
  const notify = async (s, t) => { mails.push(s); };
  await scanEvm(db, { layer, notify });
  const before = await db.query(`select key, value from pay_meta where key like '%tron%' order by key`);
  node.transfer({ to: a1.address, amount: 200 * U, block: node.state.head + 1 });
  node.mine(25);
  node.state.down = true;
  const origErr = console.error; console.error = quiet.error;
  try {
    const r1 = await scanEvm(db, { layer, notify });
    const r2 = await scanEvm(db, { layer, notify });
    assert.ok(r1.tron.error && r2.tron.error);
  } finally { console.error = origErr; }
  const during = await db.query(`select key, value from pay_meta where key like '%tron%' and key not like 'alert_%' order by key`);
  assert.deepEqual(during.filter((r) => /cursor/.test(r.key)), before.filter((r) => /cursor/.test(r.key)), '连不上时游标不动');
  assert.equal(mails.filter((m) => /TRON/.test(m) && /出错/.test(m)).length, 1, `告警只发一次：${mails}`);
  assert.equal((await db.query(`select count(*)::int n from deposits`))[0].n, 0);
  node.state.down = false;
  const r3 = await scanEvm(db, { layer, notify });
  assert.equal(r3.tron.credited, 1, '恢复后补上');
  assert.ok(mails.some((m) => /TRON/.test(m) && /恢复/.test(m)), '恢复时发一封');
  await db.end?.();
});

test('worker 扫链：第 0 批的老 TRON 地址（legacy_hd）不归合约扫链管（老地址由原来的 TronGrid 扫链入账），同一笔不会被两边各记一次', async () => {
  const { scanEvm } = await import('../server/wallet/scan.js');
  const { db, node, layer } = await tronLayer();
  const legacy = 'T' + 'L'.repeat(33);
  await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status) values ('m1', 'c2', 'tron', 'legacy_hd', 0, '', $1, 'active')`, [legacy]);
  await scanEvm(db, { layer });
  const snap = await moneySnapshot(db);
  // 老地址收到的 USDT（替身节点里随便造一个能被 h20 识别的地址）
  const legacyLike = randomTron();
  await db.query(`update customer_addresses set address = $1 where address = $2`, [legacyLike, legacy]);
  node.transfer({ to: legacyLike, amount: 300 * U, block: node.state.head + 1 });
  node.mine(25);
  const r = await scanEvm(db, { layer });
  assert.equal(r.tron.credited, 0);
  assert.equal(await moneySnapshot(db), snap, '合约扫链不碰老地址');
  const watched = node.calls.filter((c) => c.path.includes('gettransactioninfobyblocknum')).length;
  assert.ok(watched > 0, '确实扫过块');
  await db.end?.();
});
