// anvil 本地链端到端（ETH / BSC 合约钱包）：部署 BitGo 转发合约、工厂、SweepBatcher 和测试 USDT → 分配 CREATE2 充值地址 → 转 USDT
// → 扫链入账 → 凑批 → 管理员确认 → 一笔交易归集 → 冷钱包 parent 收到，账本不动。
// 不需要任何私钥：部署账户和 parent 用 anvil 自带的已解锁账户；归集发起账户由测试随机生成（只活在这次测试里）。
// 怎么跑（CI 每个 PR 都跑）：
//   cd contracts && forge build && cd ..
//   anvil --port 18545 --silent &
//   TOPUP_ANVIL_RPC=http://127.0.0.1:18545 node --test test/anvil/*.test.js
// 合约编译产物默认读 contracts/out（可用 TOPUP_CONTRACTS_OUT 改）。没设 TOPUP_ANVIL_RPC：本地跳过，CI 里直接失败（不能悄悄不跑）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { setupDb, moneySnapshot } from '../wallet-helpers.js';

const RPC = process.env.TOPUP_ANVIL_RPC || '';
const OUT = process.env.TOPUP_CONTRACTS_OUT || new URL('../../contracts/out/', import.meta.url).pathname;
const hex = (b) => Buffer.from(b).toString('hex');
const sel = (sig) => hex(keccak_256(Buffer.from(sig))).slice(0, 8);
const word = (v) => (typeof v === 'string' && v.startsWith('0x') ? v.slice(2).toLowerCase() : BigInt(v).toString(16)).padStart(64, '0');
const call = (sig, ...args) => '0x' + sel(sig) + args.map(word).join('');
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
function artifact(file, name) {
  const p = `${OUT.replace(/\/$/, '')}/${file}/${name}.json`;
  assert.ok(existsSync(p), `找不到合约编译产物 ${p}：先 cd contracts && forge build`);
  return JSON.parse(readFileSync(p, 'utf8')).bytecode.object;
}
async function send(from, to, data) {
  const h = await rpc('eth_sendTransaction', [{ from, ...(to ? { to } : {}), data, gas: '0x' + (8_000_000).toString(16) }]);
  const r = await waitReceipt(h);
  assert.equal(r.status, '0x1', `交易失败 ${h}`);
  return r;
}
async function waitReceipt(h) {
  for (let i = 0; i < 100; i++) {
    const r = await rpc('eth_getTransactionReceipt', [h]);
    if (r) return r;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`等不到回执 ${h}`);
}
async function deploy(from, file, name, ...ctor) {
  const r = await send(from, null, '0x' + artifact(file, name).replace(/^0x/, '') + ctor.map(word).join(''));
  return r.contractAddress;
}
const balanceOf = async (token, who) => BigInt(await rpc('eth_call', [{ to: token, data: call('balanceOf(address)', who) }, 'latest']));
const mine = (n) => rpc('anvil_mine', ['0x' + n.toString(16)]);
const head = async () => Number(BigInt(await rpc('eth_blockNumber')));

const skip = !RPC && !process.env.CI ? '没有设置 TOPUP_ANVIL_RPC（本地跳过；CI 里必须跑）' : false;

test('anvil 端到端：CREATE2 地址 → 扫链入账 → 凑批 → 确认 → 一笔交易归集进 parent；超上限、低于门槛的不动；账本不动；BSC 18 位小数', { skip, timeout: 120_000 }, async () => {
  assert.ok(RPC, 'CI 里必须设置 TOPUP_ANVIL_RPC 并启动 anvil（见本文件开头）');
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { createContractProvider } = await import('../../server/wallet/providers/contract.js');
  const { addressFor } = await import('../../server/wallet/addresses.js');
  const { proposeSweep, approveSweep, confirmSweeps } = await import('../../server/wallet/sweep.js');
  const { recordDeposit } = await import('../../server/pay/core.js');

  // 部署：anvil 0 号账户部署，1 号账户当冷钱包 parent；发起账户随机生成
  const [deployer, parent] = await rpc('eth_accounts');
  const opKey = secp256k1.utils.randomPrivateKey ? secp256k1.utils.randomPrivateKey() : randomBytes(32);
  const operator = '0x' + hex(keccak_256(secp256k1.getPublicKey(opKey, false).slice(1))).slice(24);
  await rpc('anvil_setBalance', [operator, '0x' + (10n ** 19n).toString(16)]);
  const impl = await deploy(deployer, 'ForwarderV4.sol', 'ForwarderV4');
  const factory = await deploy(deployer, 'ForwarderFactoryV4.sol', 'ForwarderFactoryV4', impl);
  const batcher = await deploy(deployer, 'SweepBatcher.sol', 'SweepBatcher', factory, parent, operator);
  const usdt6 = await deploy(deployer, 'Mocks.sol', 'MockUsdtNoReturn'); // 像以太坊 USDT：6 位、transfer 不返回 bool
  const usdt18 = await deploy(deployer, 'Mocks.sol', 'MockErc20', 18); // 像 BSC USDT：18 位
  const scheme = { ver: 1, factory, implementation: impl, parent, batcher };

  const db = await setupDb({ customers: [['m1', 'c1'], ['m1', 'c2'], ['m1', 'c3']] });
  const adapter = (chain) => createEvmAdapter({ chain, rpcUrl: RPC, usdt: chain === 'bsc' ? usdt18 : usdt6, decimals: chain === 'bsc' ? 18 : 6, confirmations: 2 });
  const provider = await createContractProvider({
    db, operatorKey: '0x' + hex(opKey),
    chains: { eth: { adapter: adapter('eth'), scheme, usdt: usdt6 }, bsc: { adapter: adapter('bsc'), scheme, usdt: usdt18 } },
  });
  const providers = { contract: provider };
  const mails = [];
  const notify = async (subject, text) => { mails.push({ subject, text }); };

  // 地址：链上批量合约算出的地址和后端一致；同一客户 ETH、BSC 同一个地址
  const addr = {};
  for (const c of ['c1', 'c2', 'c3']) addr[c] = (await addressFor(db, { merchantId: 'm1', customerId: c, chain: 'eth', providers })).address;
  const bscC1 = (await addressFor(db, { merchantId: 'm1', customerId: 'c1', chain: 'bsc', providers })).address;
  assert.equal(bscC1, addr.c1);
  for (const c of ['c1', 'c2', 'c3']) {
    const [row] = await db.query(`select salt from customer_addresses where customer_id = $1 and chain = 'eth'`, [c]);
    const onchain = '0x' + (await rpc('eth_call', [{ to: batcher, data: call('forwarderAddress(bytes32)', row.salt) }, 'latest'])).slice(-40);
    assert.equal(onchain.toLowerCase(), addr[c].toLowerCase(), `${c} 的地址和链上 forwarderAddress 一致`);
    assert.equal(await rpc('eth_getCode', [addr[c], 'latest']), '0x', '地址还没部署合约（纯计算）');
  }

  // 充值：c1 150、c2 6,000（超单地址上限）、c3 50（低于门槛）；BSC 上 c1 12.345678912345678900
  const cursor0 = String(await head());
  await send(deployer, usdt6, call('mint(address,uint256)', addr.c1, 150_000_000n));
  await send(deployer, usdt6, call('mint(address,uint256)', addr.c2, 6_000_000_000n));
  await send(deployer, usdt6, call('mint(address,uint256)', addr.c3, 50_000_000n));
  const raw18 = 12_345_678_912_345_678_900n;
  await send(deployer, usdt18, call('mint(address,uint256)', addr.c1, raw18));

  // 确认数不够时扫不到：anvil 每笔交易出一个块，c3 那笔之后只有 1 个块（确认数设的是 2）
  const early = await provider.scan('eth', cursor0);
  assert.ok(!early.deposits.some((d) => d.to === addr.c3), '确认数不够的转账还扫不到');
  await mine(3);
  const eth = await provider.scan('eth', cursor0);
  assert.deepEqual(eth.deposits.map((d) => [d.to, BigInt(d.amount)]).sort(), [[addr.c1, 150_000_000n], [addr.c2, 6_000_000_000n], [addr.c3, 50_000_000n]].sort());
  const bsc = await provider.scan('bsc', cursor0);
  assert.equal(bsc.deposits.length, 1);
  assert.equal(BigInt(bsc.deposits[0].amount), 12_345_678n);
  assert.equal(bsc.deposits[0].rawAmount, raw18.toString());
  for (const d of [...eth.deposits, ...bsc.deposits]) assert.equal((await recordDeposit(db, { ...d, amount: Number(d.amount) })).status, 'credited');
  // 同一段再扫一次：重复的不会重复入账
  for (const d of (await provider.scan('eth', cursor0)).deposits) assert.equal((await recordDeposit(db, { ...d, amount: Number(d.amount) })).status, 'duplicate');
  const [bal] = await db.query(`select available from balances where merchant_id = 'm1'`);
  assert.equal(Number(bal.available), 150_000_000 + 6_000_000_000 + 50_000_000 + 12_345_678);
  const money = await moneySnapshot(db);

  // 凑批：只有 c1；没确认之前链上什么都不发
  const nonce0 = await rpc('eth_getTransactionCount', [operator, 'latest']);
  const batch = await proposeSweep(db, { chain: 'eth', providers, notify });
  assert.deepEqual(batch.items.map((i) => i.address), [addr.c1]);
  assert.match(mails.at(-1).subject, /归集待确认/);
  assert.equal(await rpc('eth_getTransactionCount', [operator, 'latest']), nonce0, '确认前没有发交易');

  // 确认 → 一笔交易
  const sent = await approveSweep(db, { id: batch.id, actor: 'admin@x', reason: 'anvil 演练', providers });
  assert.equal(sent.txRefs.length, 1);
  const receipt = await waitReceipt(sent.txRefs[0]);
  assert.equal(receipt.status, '0x1');
  assert.equal(receipt.to.toLowerCase(), batcher.toLowerCase(), '发起账户只调用批量合约');
  assert.notEqual(await provider.txStatus('eth', sent.txRefs[0]), 'failed');
  await mine(3);
  assert.equal(await provider.txStatus('eth', sent.txRefs[0]), 'confirmed');
  await confirmSweeps(db, { providers, notify });

  // 钱只进 parent；批量合约、发起账户手里没有钱；超上限和低于门槛的地址原样不动
  assert.equal(await balanceOf(usdt6, parent), 150_000_000n);
  assert.equal(await balanceOf(usdt6, addr.c1), 0n);
  assert.equal(await balanceOf(usdt6, addr.c2), 6_000_000_000n);
  assert.equal(await balanceOf(usdt6, addr.c3), 50_000_000n);
  assert.equal(await balanceOf(usdt6, batcher), 0n);
  assert.equal(await balanceOf(usdt6, operator), 0n);
  assert.notEqual(await rpc('eth_getCode', [addr.c1, 'latest']), '0x', 'c1 的转发合约已部署');

  // BSC：18 位小数的余数随归集一起转走（链上原始数全部进 parent）
  const b2 = await proposeSweep(db, { chain: 'bsc', providers, notify });
  assert.deepEqual(b2.items.map((i) => [i.address, i.amount]), [[addr.c1, 12_345_678n]]);
  const s2 = await approveSweep(db, { id: b2.id, actor: 'admin@x', reason: 'anvil 演练 BSC', providers });
  await waitReceipt(s2.txRefs[0]);
  await mine(3);
  await confirmSweeps(db, { providers, notify });
  assert.equal(await balanceOf(usdt18, parent), raw18);
  assert.equal(await balanceOf(usdt18, addr.c1), 0n);

  // 归集不写账本、不改商户余额
  assert.equal(await moneySnapshot(db), money);
  // 这一轮没有出错告警
  assert.equal(mails.filter((m) => /失败|出错|告警/.test(m.subject)).length, 0, JSON.stringify(mails));
  await db.end?.();
});
