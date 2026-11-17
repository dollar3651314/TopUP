// anvil 本地链：启动时的链上合约参数核对（server/wallet/verify-onchain.js）对真的合约跑一遍。
// 部署 BitGo 工厂、实现和 SweepBatcher → 配置一致时 ok；parent、factory、implementation 任何一项和配置不一致时 mismatch；batcher 地址上没有合约时 mismatch。
// 怎么跑：和 wallet-anvil.test.js 相同（先 forge build，再起 anvil，设 TOPUP_ANVIL_RPC）。
// 这个文件自己另起一个 anvil（随机端口，用完关掉），不用 TOPUP_ANVIL_RPC 那个共用节点：node --test 并行跑 test/anvil/ 下的文件，
// 共用节点时同一个部署账户并行发交易会撞 nonce，这里出块也会打乱 wallet-anvil.test.js 的确认数判断。
import test, { before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';

const SHARED = process.env.TOPUP_ANVIL_RPC || '';
let RPC = '';
let anvilProc = null;
const OUT = process.env.TOPUP_CONTRACTS_OUT || new URL('../../contracts/out/', import.meta.url).pathname;
const hex = (b) => Buffer.from(b).toString('hex');
const word = (v) => (typeof v === 'string' && v.startsWith('0x') ? v.slice(2).toLowerCase() : BigInt(v).toString(16)).padStart(64, '0');
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function deploy(from, file, name, ...ctor) {
  const p = `${OUT.replace(/\/$/, '')}/${file}/${name}.json`;
  assert.ok(existsSync(p), `找不到合约编译产物 ${p}：先 cd contracts && forge build`);
  const code = JSON.parse(readFileSync(p, 'utf8')).bytecode.object.replace(/^0x/, '');
  const h = await rpc('eth_sendTransaction', [{ from, data: '0x' + code + ctor.map(word).join(''), gas: '0x' + (8_000_000).toString(16) }]);
  for (let i = 0; i < 100; i++) { const r = await rpc('eth_getTransactionReceipt', [h]); if (r) { assert.equal(r.status, '0x1'); return r.contractAddress; } await new Promise((ok) => setTimeout(ok, 50)); }
  throw new Error('等不到回执');
}
const skip = !SHARED && !process.env.CI ? '没有设置 TOPUP_ANVIL_RPC（本地跳过；CI 里必须跑）' : false;

before(async () => {
  if (skip) return;
  for (let tries = 0; tries < 5 && !RPC; tries++) {
    // 先让系统给一个空闲端口，再交给 anvil（随机挑可能撞上别的文件起的 anvil）
    const port = await new Promise((ok, no) => { const srv = createServer(); srv.once('error', no); srv.listen(0, '127.0.0.1', () => { const n = srv.address().port; srv.close(() => ok(n)); }); });
    const p = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (p.exitCode !== null) break; // 端口被占：换一个
      try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' }); if (r.ok && p.exitCode === null) { await new Promise((ok) => setTimeout(ok, 200)); if (p.exitCode === null) { RPC = url; anvilProc = p; } break; } } catch { /* 还没起来 */ }
      await new Promise((ok) => setTimeout(ok, 100));
    }
    if (!RPC) p.kill();
  }
  if (!RPC) throw new Error('自己起的 anvil 没起来（CI 的 contracts 任务里 anvil 在 PATH 上）');
});
after(() => { anvilProc?.kill(); });

test('anvil：链上合约参数核对——配置一致 ok；parent / factory / implementation 不一致 mismatch 并写出字段；batcher 地址没合约 mismatch', { skip, timeout: 60_000 }, async () => {
  assert.ok(RPC, '自己起的 anvil 没起来');
  const { createEvmAdapter } = await import('../../server/wallet/adapters/evm.js');
  const { verifyChain } = await import('../../server/wallet/verify-onchain.js');
  const [deployer, parent, other] = await rpc('eth_accounts');
  const operator = '0x' + hex(keccak_256(Buffer.from('op'))).slice(24);
  const impl = await deploy(deployer, 'ForwarderV4.sol', 'ForwarderV4');
  const factory = await deploy(deployer, 'ForwarderFactoryV4.sol', 'ForwarderFactoryV4', impl);
  const batcher = await deploy(deployer, 'SweepBatcher.sol', 'SweepBatcher', factory, parent, operator);
  const usdt = await deploy(deployer, 'Mocks.sol', 'MockErc20', 18);
  const adapter = createEvmAdapter({ chain: 'eth', rpcUrl: RPC, usdt, decimals: 18, confirmations: 1 });
  const scheme = { ver: 1, factory, implementation: impl, parent, batcher };
  assert.deepEqual(await verifyChain(adapter, scheme), { result: 'ok' });
  assert.deepEqual(await verifyChain(adapter, { ...scheme, parent: other }), { result: 'mismatch', fields: ['parent'] });
  assert.deepEqual(await verifyChain(adapter, { ...scheme, implementation: other }), { result: 'mismatch', fields: ['implementation'] });
  const r = await verifyChain(adapter, { ...scheme, batcher: other }); // 普通账户上 eth_call 返回空
  assert.equal(r.result, 'mismatch');
});
