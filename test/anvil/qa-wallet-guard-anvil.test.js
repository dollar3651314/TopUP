// 测试会话补测（第 1 批返工复核），anvil 本地链：
//   一、链上合约参数核对接到真的钱包层（server/wallet/index.js 的 createWalletLayer，和服务器启动时同一条路径）：
//       以太坊配置的 parent 和链上不一致 → 这条链停用（不在开通列表、不分配地址、商户建以太坊订单 409 chain_not_enabled、不凑批）、发一封告警；
//       BSC 一致 → 照常；系统状态（?verify=1）以太坊卡片 onchain_mismatch，只给字段名不给地址的值；
//       factory 和链上不一致（另部署一个工厂）→ mismatch，字段 factory
//   二、节点连不上时不下结论：核对结果 unverified，这条链不停用、不发告警；节点恢复后再核对一次，不一致才停用
//   三、广播时响应丢了但交易其实送到了节点：过了 15 分钟也按链上结果算"已完成"，不误标"没送到"
// 怎么跑：和 wallet-anvil.test.js 相同（先 forge build，再起 anvil，设 TOPUP_ANVIL_RPC）。没设 TOPUP_ANVIL_RPC：本地跳过，CI 里直接失败。
// 这个文件自己另起一个 anvil（随机端口，用完关掉），不用 TOPUP_ANVIL_RPC 那个共用节点：node --test 会并行跑 test/anvil/ 下的文件，
// 共用一个节点时这里发交易、出块会打乱 wallet-anvil.test.js 的"确认数不够还扫不到"，同一个部署账户并行发交易还会撞 nonce。
import test, { before, after } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { setupDb } from '../wallet-helpers.js';

const GATE = process.env.TOPUP_ANVIL_RPC || '';
let RPC = '';
let anvilProc = null;
const OUT = process.env.TOPUP_CONTRACTS_OUT || new URL('../../contracts/out/', import.meta.url).pathname;
const hex = (b) => Buffer.from(b).toString('hex');
const sel = (sig) => hex(keccak_256(Buffer.from(sig))).slice(0, 8);
const word = (v) => (typeof v === 'string' && v.startsWith('0x') ? v.slice(2).toLowerCase() : BigInt(v).toString(16)).padStart(64, '0');
const call = (sig, ...args) => '0x' + sel(sig) + args.map(word).join('');
const MIN = 60_000;
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function waitReceipt(h) {
  for (let i = 0; i < 100; i++) { const r = await rpc('eth_getTransactionReceipt', [h]); if (r) return r; await new Promise((ok) => setTimeout(ok, 50)); }
  throw new Error(`等不到回执 ${h}`);
}
async function send(from, to, data) {
  const r = await waitReceipt(await rpc('eth_sendTransaction', [{ from, ...(to ? { to } : {}), data, gas: '0x' + (8_000_000).toString(16) }]));
  assert.equal(r.status, '0x1');
  return r;
}
async function deploy(from, file, name, ...ctor) {
  const p = `${OUT.replace(/\/$/, '')}/${file}/${name}.json`;
  assert.ok(existsSync(p), `找不到合约编译产物 ${p}：先 cd contracts && forge build`);
  const code = JSON.parse(readFileSync(p, 'utf8')).bytecode.object.replace(/^0x/, '');
  return (await send(from, null, '0x' + code + ctor.map(word).join(''))).contractAddress;
}
async function contracts() {
  const [deployer, parent, other] = await rpc('eth_accounts');
  const opKey = secp256k1.utils.randomPrivateKey ? secp256k1.utils.randomPrivateKey() : randomBytes(32);
  const operator = '0x' + hex(keccak_256(secp256k1.getPublicKey(opKey, false).slice(1))).slice(24);
  await rpc('anvil_setBalance', [operator, '0x' + (10n ** 19n).toString(16)]);
  const impl = await deploy(deployer, 'ForwarderV4.sol', 'ForwarderV4');
  const factory = await deploy(deployer, 'ForwarderFactoryV4.sol', 'ForwarderFactoryV4', impl);
  const batcher = await deploy(deployer, 'SweepBatcher.sol', 'SweepBatcher', factory, parent, operator);
  const usdt = await deploy(deployer, 'Mocks.sol', 'MockErc20', 18);
  return { deployer, parent, other, opKey, operator, impl, factory, batcher, usdt };
}
/** 转发到 anvil 的小代理：down = true 时直接断开连接（模拟节点连不上） */
async function flakyProxy() {
  const st = { down: false };
  const srv = createServer(async (req, res) => {
    if (st.down) { req.socket.destroy(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((ok) => srv.close(ok)) };
}

const skip = !GATE && !process.env.CI ? '没有设置 TOPUP_ANVIL_RPC（本地跳过；CI 里必须跑）' : false;

before(async () => {
  if (skip) return;
  const port = 20000 + Math.floor(Math.random() * 20000);
  anvilProc = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' }); if (r.ok) { RPC = url; return; } } catch {}
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('自己起的 anvil 没起来（CI 的 contracts 任务里 anvil 在 PATH 上）');
});
after(() => { anvilProc?.kill(); });

test('anvil：链上参数和配置不一致 → 真的钱包层停用这条链（不分配地址、不能建这条链的订单、不凑批）、告警一次；另一条链照常；系统状态卡 onchain_mismatch 不带地址值；factory 不一致也能查出', { skip, timeout: 120_000 }, async () => {
  assert.ok(GATE && RPC, 'CI 里必须设置 TOPUP_ANVIL_RPC 并启动 anvil');
  const { createWalletLayer } = await import('../../server/wallet/index.js');
  const { verifyChain } = await import('../../server/wallet/verify-onchain.js');
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { addressFor } = await import('../../server/wallet/addresses.js');
  const { proposeSweep } = await import('../../server/wallet/sweep.js');
  const { createOps } = await import('../../server/pay/ops.js');
  const { createWalletApi } = await import('../../server/pay/wallet-api.js');
  const { createFakeTron } = await import('../../server/pay/fake-trongrid.js');
  const { derivePayKeys } = await import('../../server/pay/common.js');
  const c = await contracts();
  const good = { usdt: c.usdt, factory: c.factory, implementation: c.impl, parent: c.parent, batcher: c.batcher, ver: 1 };
  const db = await setupDb({ customers: [['m1', 'c1']] });
  await db.query(`update merchants set order_mode = jsonb_set(order_mode, '{enabled}', 'true') where id = 'm1'`).catch(() => {});
  const config = { appEnv: 'staging', fakeEvm: false, ethRpcUrl: RPC, bscRpcUrl: RPC, ethConfirmations: 1, bscConfirmations: 1, sweepOperatorKey: '0x' + hex(c.opKey) };
  const layer = createWalletLayer({ db, config, evm: { eth: { ...good, parent: c.other }, bsc: good } });
  assert.deepEqual([...layer.enabledChains].sort(), ['bsc', 'eth'], '前提：核对前两条链都开通');
  const mails = [];
  const notify = async (s, t) => { mails.push(`${s}\n${t}`); };

  const r = await layer.verifyOnchain({ db, notify });
  assert.equal(r.eth.result, 'mismatch');
  assert.deepEqual(r.eth.fields, ['parent']);
  assert.equal(r.bsc.result, 'ok');
  assert.deepEqual(layer.enabledChains, ['bsc'], '以太坊从开通列表里拿掉');
  assert.equal(layer.errors.eth, 'onchain_mismatch');
  await assert.rejects(addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'eth', providers: layer.providers }), (e) => e.code === 'chain_not_enabled', '以太坊不再分配地址');
  assert.match((await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'bsc', providers: layer.providers })).address, /^0x[0-9a-fA-F]{40}$/, 'BSC 照常分配');
  const ops = createOps({ db, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), payBase: 'https://pay.test', wallet: layer });
  const [m] = await db.query(`select * from merchants where id = 'm1'`);
  await assert.rejects(ops.createOrder(m, { customer_id: 'c1', merchant_order_no: 'QA-ETH', amount: '1', chain: 'eth' }), (e) => e.code === 'chain_not_enabled' && e.status === 409, '商户建以太坊订单：409 chain_not_enabled');
  await assert.rejects(proposeSweep(db, { chain: 'eth', providers: layer.providers, notify }), (e) => e.code === 'chain_not_enabled', '以太坊不凑批');
  assert.equal(mails.length, 1, '告警一封');
  assert.match(mails[0], /以太坊/);
  assert.match(mails[0], /parent/);
  assert.doesNotMatch(mails[0], /0x[0-9a-fA-F]{40}/, '告警不写地址的值');

  // 系统状态（看的时候再核对一次）：以太坊卡片 onchain_mismatch、只给字段名；BSC 正常；不重复发邮件
  const api = createWalletApi({ db, tron: createFakeTron(), keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), wallets: { hot: '', cold: '' }, requireAdmin: async () => {}, verifyAdminCode: async () => true, notify, layer });
  const res = await api(new Request('https://x/api/wallet/?a=wallet-chains&verify=1', { headers: { 'x-topup-csrf': '1' } }));
  assert.equal(res.status, 200);
  const j = await res.json();
  const eth = j.chains.find((x) => x.chain === 'eth'), bsc = j.chains.find((x) => x.chain === 'bsc');
  assert.equal(eth.status, 'onchain_mismatch');
  assert.equal(eth.ok, false);
  assert.equal(eth.config_error, 'onchain_mismatch');
  assert.deepEqual(eth.onchain_fields, ['parent']);
  assert.notEqual(bsc.status, 'onchain_mismatch');
  assert.doesNotMatch(JSON.stringify(eth), /0x[0-9a-fA-F]{40}/, '以太坊卡片不带地址的值');
  assert.equal(mails.length, 1, '再核对一次不重复发告警');

  // 停用之后：就算配置和链上又一致了（这里把内存里的配置改成链上的 parent），也不再核对、不发"核对一致"恢复邮件、仍停用（到重新部署、重启为止）
  layer.chainsConfigured.eth.scheme.parent = c.parent;
  await layer.verifyOnchain({ db, notify });
  assert.equal(layer.onchain.eth.result, 'mismatch');
  assert.deepEqual(layer.enabledChains, ['bsc']);
  assert.equal(mails.length, 1, '不发恢复邮件');

  // factory 不一致：另部署一个工厂（同一个实现），配置写成它 → 字段 factory
  const factory2 = await deploy(c.deployer, 'ForwarderFactoryV4.sol', 'ForwarderFactoryV4', c.impl);
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: RPC, usdt: c.usdt, decimals: 18, confirmations: 1 });
  assert.deepEqual(await verifyChain(adapter, { ...good, factory: factory2 }), { result: 'mismatch', fields: ['factory'] });
  await db.end?.();
});

test('anvil：启动时节点连不上 → unverified，这条链不停用、不发告警；节点恢复后再核对，不一致才停用', { skip, timeout: 120_000 }, async () => {
  assert.ok(GATE && RPC, 'CI 里必须设置 TOPUP_ANVIL_RPC 并启动 anvil');
  const { createWalletLayer } = await import('../../server/wallet/index.js');
  const c = await contracts();
  const proxy = await flakyProxy();
  try {
    const db = await setupDb({ customers: [['m1', 'c1']] });
    const scheme = { usdt: c.usdt, factory: c.factory, implementation: c.impl, parent: c.other, batcher: c.batcher, ver: 1 }; // parent 配错
    const layer = createWalletLayer({ db, config: { appEnv: 'staging', fakeEvm: false, ethRpcUrl: proxy.url, bscRpcUrl: '', ethConfirmations: 1, sweepOperatorKey: '0x' + hex(c.opKey) }, evm: { eth: scheme } });
    const mails = [];
    const notify = async (s, t) => { mails.push(`${s}\n${t}`); };
    proxy.st.down = true;
    const t0 = Date.now();
    const r1 = await layer.verifyOnchain({ db, notify, timeoutMs: 5000 });
    assert.ok(Date.now() - t0 < 15_000, '连不上时不会卡住');
    assert.equal(r1.eth.result, 'unverified');
    assert.deepEqual(layer.enabledChains, ['eth'], '没核对上不下结论，不停用');
    assert.equal(mails.length, 0, '连不上不发"参数不一致"告警');
    proxy.st.down = false;
    const r2 = await layer.verifyOnchain({ db, notify });
    assert.equal(r2.eth.result, 'mismatch');
    assert.deepEqual(layer.enabledChains, [], '恢复后核对出不一致：停用');
    assert.equal(mails.length, 1);
    await db.end?.();
  } finally { await proxy.close(); }
});

test('anvil：广播时响应丢了但交易其实送到了节点（结果不确定）→ 过了 15 分钟也按链上回执算"已完成"，不误标"没送到"；钱进 parent', { skip, timeout: 120_000 }, async () => {
  assert.ok(GATE && RPC, 'CI 里必须设置 TOPUP_ANVIL_RPC 并启动 anvil');
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { createContractProvider } = await import('../../server/wallet/providers/contract.js');
  const { addressFor } = await import('../../server/wallet/addresses.js');
  const { proposeSweep, approveSweep, confirmSweeps, getBatch } = await import('../../server/wallet/sweep.js');
  const { recordDeposit } = await import('../../server/pay/core.js');
  const c = await contracts();
  const db = await setupDb({ customers: [['m1', 'c1']] });
  // 发交易那次请求：转给 anvil（交易真的进了节点），但把响应丢掉、当成连接断了
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const r = await fetch(url, init);
    if (!Array.isArray(body) && body.method === 'eth_sendRawTransaction') { await r.text(); throw new TypeError('fetch failed'); }
    return r;
  };
  const adapter = createEvmAdapter({ chain: 'bsc', rpcUrl: RPC, fetchImpl, usdt: c.usdt, decimals: 18, confirmations: 1 });
  const providers = { contract: await createContractProvider({ db, operatorKey: '0x' + hex(c.opKey), chains: { bsc: { adapter, scheme: { ver: 1, factory: c.factory, implementation: c.impl, parent: c.parent, batcher: c.batcher }, usdt: c.usdt } } }) };
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'bsc', providers });
  const cursor = String(Number(BigInt(await rpc('eth_blockNumber'))));
  await send(c.deployer, c.usdt, call('mint(address,uint256)', address, 150n * 10n ** 18n));
  await rpc('anvil_mine', ['0x2']);
  for (const d of (await providers.contract.scan('bsc', cursor)).deposits) await recordDeposit(db, { ...d, amount: Number(d.amount) });
  const [b] = await proposeSweep(db, { chain: 'bsc', providers, notify: async () => {} });
  assert.ok(b, '前提：凑出一批');
  const sent = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'anvil', providers });
  assert.equal(sent.broadcast, 'uncertain', '前提：广播结果不确定');
  await waitReceipt(sent.txRefs[0]);
  await rpc('anvil_mine', ['0x2']);
  const sentAt = Date.parse((await getBatch(db, b.id)).updatedAt);
  const mails = [];
  await confirmSweeps(db, { providers, notify: async (s) => { mails.push(s); }, now: sentAt + 20 * MIN });
  const after = await getBatch(db, b.id);
  assert.equal(after.status, 'confirmed', JSON.stringify(after, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.deepEqual(after.items.map((i) => i.status), ['swept']);
  assert.equal(mails.filter((s) => /失败/.test(s)).length, 0);
  assert.equal(BigInt(await rpc('eth_call', [{ to: c.usdt, data: call('balanceOf(address)', c.parent) }, 'latest'])) >= 150n * 10n ** 18n, true, '钱进了 parent');
  await db.end?.();
});

test('anvil：交易签了但根本没送到节点（广播时连不上）→ 节点查不到这笔交易，过了 15 分钟标失败（not_broadcast）、地址放回；链上钱没动', { skip, timeout: 120_000 }, async () => {
  assert.ok(GATE && RPC, 'CI 里必须设置 TOPUP_ANVIL_RPC 并启动 anvil');
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { createContractProvider } = await import('../../server/wallet/providers/contract.js');
  const { addressFor } = await import('../../server/wallet/addresses.js');
  const { proposeSweep, approveSweep, confirmSweeps, getBatch } = await import('../../server/wallet/sweep.js');
  const { recordDeposit } = await import('../../server/pay/core.js');
  const c = await contracts();
  const db = await setupDb({ customers: [['m1', 'c1']] });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body) && body.method === 'eth_sendRawTransaction') throw new TypeError('fetch failed'); // 没送出去
    return fetch(url, init);
  };
  const adapter = createEvmAdapter({ chain: 'bsc', rpcUrl: RPC, fetchImpl, usdt: c.usdt, decimals: 18, confirmations: 1 });
  const providers = { contract: await createContractProvider({ db, operatorKey: '0x' + hex(c.opKey), chains: { bsc: { adapter, scheme: { ver: 1, factory: c.factory, implementation: c.impl, parent: c.parent, batcher: c.batcher }, usdt: c.usdt } } }) };
  const { address } = await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'bsc', providers });
  const cursor = String(Number(BigInt(await rpc('eth_blockNumber'))));
  await send(c.deployer, c.usdt, call('mint(address,uint256)', address, 150n * 10n ** 18n));
  await rpc('anvil_mine', ['0x2']);
  for (const d of (await providers.contract.scan('bsc', cursor)).deposits) await recordDeposit(db, { ...d, amount: Number(d.amount) });
  const [b] = await proposeSweep(db, { chain: 'bsc', providers, notify: async () => {} });
  const sent = await approveSweep(db, { id: b.id, actor: 'admin@x', reason: 'anvil', providers });
  assert.equal(sent.broadcast, 'uncertain');
  assert.equal(await rpc('eth_getTransactionByHash', [sent.txRefs[0]]), null, '前提：节点确实不认识这笔交易');
  const sentAt = Date.parse((await getBatch(db, b.id)).updatedAt);
  await confirmSweeps(db, { providers, now: sentAt + 10 * MIN });
  assert.equal((await getBatch(db, b.id)).status, 'sent', '不到 15 分钟照常等');
  await confirmSweeps(db, { providers, now: sentAt + 16 * MIN });
  const after = await getBatch(db, b.id);
  assert.equal(after.status, 'failed');
  assert.deepEqual(after.items.map((i) => [i.status, i.reason]), [['released', 'not_broadcast']]);
  assert.equal(BigInt(await rpc('eth_call', [{ to: c.usdt, data: call('balanceOf(address)', address) }, 'latest'])), 150n * 10n ** 18n, '钱还在客户地址里');
  await db.end?.();
});
