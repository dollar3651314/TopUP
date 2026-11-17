// 测试先写（第 2 批）：本机 TRON 私链端到端（tronbox/tre，java-tron 4.8.2；Nile 上线前的替身，和 scripts/tron-nile/ 同一个私链）。
// 流程：TRON 官方编译器编译 TRON 派生版合约（ForwarderTron、ForwarderFactoryTron、SweepBatcherTron）和"transfer 成功也返回 false"的测试 USDT
//   → 部署（parent = 一个没有私钥的随机地址，钱只能进它）→ 真的钱包层（createWalletLayer，和服务器启动同一条路径）核对链上参数 ok
//   → 按需分配 3 个 TRON 合约地址（0x41，和批量合约 forwarderAddress() 一致）→ 其中一个地址先被转 1 TRX 激活（R1）
//   → 转 USDT（200、150、50）→ worker 扫链入账 → 凑批（50 低于门槛 100 跳过）→ 管理员确认 → 一笔交易归集进 parent
//   → 按事件确认：两个地址都成功（USDT 返回 false 也算成功，合约按 parent 余额核对），parent 收到 350 USDT，激活时的 1 TRX 也进了 parent；账本不动
// 另外：parent 配错时链上核对 mismatch、停用 TRON。
// 私钥：只用私链容器自己生成的 0 号测试账户（CI 从容器日志里取，只在内存里用，不打印、不写文件）；它同时是部署账户和归集发起账户。
// 怎么跑（CI 的 tron-local 每个 PR 都跑）：
//   docker run -d --name tre -p 9090:9090 tronbox/tre（等日志里出现 Available Accounts）
//   TOPUP_TRON_LOCAL_NODE=http://127.0.0.1:9090 TOPUP_TRON_LOCAL_PRIVATE_KEY="$(docker logs tre 2>&1 | grep -m1 -E '^\(0\) [0-9a-f]{64}$' | awk '{print $2}')" \
//     node --test test/tron-local/*.test.js
// 没设这两个变量：本地跳过，CI 里直接失败（不能悄悄不跑）。只准连本机私链：连到 Nile 或主网直接失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, moneySnapshot } from '../wallet-helpers.js';
import { randomTron, T } from '../tron-helpers.js';

const NODE = process.env.TOPUP_TRON_LOCAL_NODE || '';
const KEY = process.env.TOPUP_TRON_LOCAL_PRIVATE_KEY || '';
const skip = (!NODE || !KEY) && !process.env.CI ? '没有设置 TOPUP_TRON_LOCAL_NODE / TOPUP_TRON_LOCAL_PRIVATE_KEY（本地跳过；CI 里必须跑）' : false;
const U = 1_000_000n;
const FEE = 1_000_000_000;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** 等某个条件成立；每轮用 poke 发一笔小额 TRX 转账让私链出块（tronbox/tre 没有交易时不出块，确认数就一直不够） */
async function until(what, fn, poke, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    if (poke) await poke(); else await sleep(2000);
  }
}

async function deployAll(node, signer) {
  const { compile } = await import('../../scripts/tron-nile/compile.mjs');
  const { artifacts } = await compile();
  for (const n of ['ForwarderTron', 'ForwarderFactoryTron', 'SweepBatcherTron', 'TronUsdtMock']) assert.ok(artifacts[n], `compile.mjs 要编译出 ${n}`);
  // parent：随机地址（没有私钥），先转 1 TRX 激活，之后只看余额
  const parent = randomTron();
  await node.transferTrx(signer, parent, 1_000_000);
  const impl = await node.deploy(signer, { name: 'ForwarderTron', ...artifacts.ForwarderTron, feeLimit: FEE });
  const factory = await node.deploy(signer, { name: 'ForwarderFactoryTron', ...artifacts.ForwarderFactoryTron, params: node.enc(['address'], [impl.address]), feeLimit: FEE });
  const usdt = await node.deploy(signer, { name: 'TronUsdtMock', ...artifacts.TronUsdtMock, feeLimit: FEE });
  const batcher = await node.deploy(signer, { name: 'SweepBatcherTron', ...artifacts.SweepBatcherTron, params: node.enc(['address', 'address', 'address'], [factory.address, parent, signer.address]), feeLimit: FEE });
  const minted = await node.send(signer, usdt.address, 'mint(address,uint256)', ['address', 'uint256'], [signer.address, 1_000_000n * U], { feeLimit: FEE });
  assert.ok(minted.ok, 'mint');
  return { parent, impl: impl.address, factory: factory.address, usdt: usdt.address, batcher: batcher.address, energy: { impl: impl.info.receipt?.energy_usage_total, factory: factory.info.receipt?.energy_usage_total, batcher: batcher.info.receipt?.energy_usage_total } };
}

function layerFor(db, c, { parent = c.parent } = {}) {
  return import('../../server/wallet/index.js').then(({ createWalletLayer }) => createWalletLayer({
    db,
    config: { appEnv: 'staging', fakeEvm: false, fakeTron: false, ethRpcUrl: '', bscRpcUrl: '', tronNetwork: 'nile', tronApiKey: '', tronNodeUrl: NODE, tronConfirmations: 1, sweepOperatorKey: '', sweepOperatorKeyTron: KEY },
    evm: {},
    tron: { ver: 1, usdt: c.usdt, factory: c.factory, implementation: c.impl, parent, batcher: c.batcher },
  }));
}

test('TRON 私链端到端：分配地址 → 转账（含先被激活的地址）→ 扫链入账 → 凑批 → 确认 → 一笔交易归集进 parent；USDT 返回 false 也算成功；账本不动', { skip, timeout: 15 * 60_000 }, async () => {
  assert.ok(NODE && KEY, 'CI 里必须设置 TOPUP_TRON_LOCAL_NODE、TOPUP_TRON_LOCAL_PRIVATE_KEY 并启动 tronbox/tre（见本文件开头）');
  const { createNode, makeSigner } = await import('../../scripts/tron-nile/tron-node.mjs');
  const node = createNode({ base: NODE });
  assert.equal((await node.checkNetwork()).network, 'local', '只准连本机私链');
  const signer = makeSigner(KEY);
  const c = await deployAll(node, signer);
  const { addressFor } = await import('../../server/wallet/addresses.js');
  const { scanEvm } = await import('../../server/wallet/scan.js');
  const { proposeSweep, approveSweep, confirmSweeps, getBatch } = await import('../../server/wallet/sweep.js');

  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2'], ['m1', 'c3']] });
  const layer = await layerFor(db, c);
  assert.ok(layer.enabledChains.includes('tron'), JSON.stringify(layer.errors));
  await layer.verifyOnchain({ db });
  assert.equal(layer.onchain.tron?.result, 'ok', `链上参数核对：${JSON.stringify(layer.onchain.tron)}`);
  const providers = layer.providers;

  // 1. 按需分配地址；和链上批量合约按 0x41 算出的地址一致
  const addrs = [];
  for (const id of ['c1', 'c2', 'c3']) addrs.push((await addressFor(db, { merchantId: 'm1', customerId: id, chain: 'tron', providers })).address);
  for (const a of addrs) {
    const [row] = await db.query(`select salt, provider from customer_addresses where address = $1`, [a]);
    assert.equal(row.provider, 'contract');
    const w = await node.call(c.batcher, 'forwarderAddress(bytes32)', ['bytes32'], [row.salt]);
    assert.equal(T(w.slice(-40)), a, '后端地址 = 批量合约 forwarderAddress()（0x41）');
  }
  // 2. c2 的地址先被转 1 TRX 激活（R1：激活后还要能部署）
  await node.transferTrx(signer, addrs[1], 1_000_000);
  assert.equal(await node.balance(addrs[1]), 1_000_000);

  // 3. 扫链起点 → 转 USDT（测试 USDT 的 transfer 成功也返回 false）→ 扫链入账
  await scanEvm(db, { layer });
  for (const [i, amt] of [[0, 200n], [1, 150n], [2, 50n]]) {
    const r = await node.send(signer, c.usdt, 'transfer(address,uint256)', ['address', 'uint256'], [addrs[i], amt * U], { feeLimit: FEE });
    assert.ok(r.ok, 'USDT 转账上链');
  }
  const sink = randomTron();
  const poke = () => node.transferTrx(signer, sink, 1_000_000);
  await until('三笔到账入账', async () => { await scanEvm(db, { layer }); return (await db.query(`select count(*)::int n from deposits where chain = 'tron'`))[0].n === 3; }, poke);
  const deps = await db.query(`select customer_id, amount from deposits where chain = 'tron' order by customer_id`);
  assert.deepEqual(deps.map((d) => [d.customer_id, BigInt(d.amount)]), [['c1', 200n * U], ['c2', 150n * U], ['c3', 50n * U]]);

  // 4. 凑批：门槛 100（c3 的 50 跳过）
  const snap = await moneySnapshot(db);
  const bs = await proposeSweep(db, { chain: 'tron', providers, limits: { threshold: 100n * U, capPerAddress: 5000n * U, capPerBatch: 20000n * U, maxFeeRatioPct: 0, maxAddresses: 20 } });
  assert.equal(bs.length, 1);
  assert.deepEqual(bs[0].items.map((i) => i.address).sort(), [addrs[0], addrs[1]].sort());
  assert.deepEqual(bs[0].skipped.map((s) => [s.address, s.reason]), [[addrs[2], 'belowThreshold']]);

  // 5. 确认 → 一笔交易
  const parentTrx = await node.balance(c.parent);
  const r = await approveSweep(db, { id: bs[0].id, actor: 'qa', reason: '私链端到端', providers });
  assert.equal(r.status, 'sent');
  assert.equal(r.txRefs.length, 1, '一批一笔交易');
  await until('归集确认', async () => { await confirmSweeps(db, { providers }); return (await getBatch(db, bs[0].id)).status !== 'sent'; }, poke);
  const done = await getBatch(db, bs[0].id);
  assert.equal(done.status, 'confirmed', done.items.map((i) => `${i.status}:${i.reason}`).join(', '));
  assert.ok(done.items.every((i) => i.status === 'swept'));

  // 6. 链上：parent 收到 350；两个转发地址清空；c3 的 50 没动；激活时的 1 TRX 由 init 转给了 parent
  const bal = async (who) => BigInt('0x' + (await node.call(c.usdt, 'balanceOf(address)', ['address'], [who])));
  assert.equal(await bal(c.parent), 350n * U);
  assert.equal(await bal(addrs[0]), 0n);
  assert.equal(await bal(addrs[1]), 0n);
  assert.equal(await bal(addrs[2]), 50n * U);
  assert.equal(await node.balance(addrs[1]), 0, '激活时转入的 1 TRX 不留在地址上');
  assert.equal((await node.balance(c.parent)) - parentTrx, 1_000_000, 'parent 收到这 1 TRX');
  const info = await node.post('/wallet/gettransactioninfobyid', { value: r.txRefs[0] });
  assert.equal(info.receipt?.result, 'SUCCESS');
  console.log(`[tron-local] 能量：实现合约 ${c.energy.impl}、工厂 ${c.energy.factory}、批量合约 ${c.energy.batcher}；一批 2 个地址（都首次部署）归集 ${info.receipt?.energy_usage_total}`);

  // 7. 归集不写账本、不改商户余额
  assert.equal(await moneySnapshot(db), snap);

  // 8. 再凑一批：c3 仍低于门槛，没有批次；已归集的不再列出
  assert.deepEqual(await proposeSweep(db, { chain: 'tron', providers, limits: { threshold: 100n * U, capPerAddress: 5000n * U, capPerBatch: 20000n * U, maxFeeRatioPct: 0, maxAddresses: 20 } }), []);

  // 9. parent 配错：链上核对 mismatch，停用 TRON
  const db2 = await setupDb({ customers: [['m1', 'x1']] });
  const wrong = await layerFor(db2, c, { parent: randomTron() });
  await wrong.verifyOnchain({ db: db2 });
  assert.equal(wrong.onchain.tron?.result, 'mismatch');
  assert.deepEqual(wrong.onchain.tron.fields, ['parent']);
  assert.ok(!wrong.enabledChains.includes('tron'));
  await db.end?.(); await db2.end?.();
});
