// 测试网部署的 EVM 发送（scripts/testnet/evm-send.mjs）：gas 按节点估算 × 1.25 且不超过单笔上限、发之前整套模拟和余额核对、
// 每笔核对回执（失败立即停、写清楚）、对齐 nonce。节点用替身（记录每次调用），不连真实网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { gasLimitFor, preflight, sendAll, alignNonce, pickGasPrice, waitReceipt, TX_GAS_CAP } from '../scripts/testnet/evm-send.mjs';
import { addressOfKey } from '../server/wallet/evm-tx.js';

const KEY = '0x' + '11'.repeat(32);
const FROM = addressOfKey(KEY);
const hex = (n) => '0x' + BigInt(n).toString(16);

/** 节点替身：nonce 随发出的交易增加；receipts 按发出顺序给回执（函数，拿到 gas limit） */
function fakeNode({ nonce = 0, balance = 10n ** 18n, estimate = () => 100_000, simulate = null, receipts = [], gasPrice = 10n ** 9n } = {}) {
  const calls = [];
  const sent = [];
  const state = { nonce };
  const rpc = async (method, params = []) => {
    calls.push(method);
    switch (method) {
      case 'eth_getTransactionCount': return hex(state.nonce);
      case 'eth_getBalance': return hex(balance);
      case 'eth_gasPrice': return hex(gasPrice);
      case 'eth_maxPriorityFeePerGas': return hex(2);
      case 'eth_getBlockByNumber': return { baseFeePerGas: hex(15) };
      case 'eth_estimateGas': return hex(estimate(params[0]));
      case 'eth_simulateV1':
        if (!simulate) throw new Error('eth_simulateV1: the method eth_simulateV1 does not exist/is not available');
        return simulate(params[0].blockStateCalls[0].calls);
      case 'eth_sendRawTransaction': {
        const i = sent.length;
        sent.push(params[0]);
        state.nonce += 1;
        state.last = i;
        return null; // 交易号由下面的包装换成本地算的
      }
      case 'eth_getTransactionReceipt': {
        const r = receipts[state.last];
        return typeof r === 'function' ? r(state) : r === undefined ? { status: '0x1', gasUsed: hex(50_000), blockNumber: '0x10' } : r;
      }
      default: throw new Error('unexpected ' + method);
    }
  };
  // eth_sendRawTransaction 返回交易号：用 keccak(raw)，和 signLegacyTx 算的一致
  const wrapped = async (method, params) => {
    if (method === 'eth_sendRawTransaction') {
      await rpc(method, params);
      const { keccakHex } = await import('../server/wallet/evm-tx.js');
      return keccakHex(Buffer.from(params[0].slice(2), 'hex'));
    }
    return rpc(method, params);
  };
  return { rpc: wrapped, calls, sent, state };
}

const createTx = (nonce, label = 'ForwarderV4 创建', contractAddress = '0x' + 'ab'.repeat(20)) => ({ label, nonce, to: null, data: '0x6000', value: 0n, contractAddress });
const fastWait = { timeoutMs: 50, pollMs: 1, sleep: async () => {} };

test('gas limit：节点估算 × 1.25，不超过单笔上限 2^24；估算本身超过上限直接报错', () => {
  assert.equal(gasLimitFor(100_000), 125_000);
  assert.equal(gasLimitFor(14_028_265), TX_GAS_CAP); // Sepolia 上 ForwarderV4 实测要 14,028,265
  assert.throws(() => gasLimitFor(TX_GAS_CAP + 1, 'X'), /超过单笔上限/);
  assert.throws(() => gasLimitFor(0, 'X'), /没有给出 gas 估算/);
});

test('gas 价格：max(eth_gasPrice, 2 × baseFee + 小费)；EVM_GAS_PRICE_GWEI 优先', async () => {
  const n = fakeNode({ gasPrice: 17n });
  assert.equal(await pickGasPrice(n.rpc), 32n); // 2 × 15 + 2
  assert.equal(await pickGasPrice(fakeNode({ gasPrice: 10n ** 9n }).rpc), 10n ** 9n);
  assert.equal(await pickGasPrice(n.rpc, { overrideGwei: '0.5' }), 500_000_000n);
  await assert.rejects(pickGasPrice(n.rpc, { overrideGwei: 'abc' }), /正数/);
});

test('发之前整套模拟：按模拟的用量算费用，余额不够一笔都不发', async () => {
  const n = fakeNode({ balance: 10n ** 15n, simulate: (calls) => [{ calls: calls.map(() => ({ status: '0x1', gasUsed: hex(14_000_000) })) }] });
  const txs = [createTx(1), createTx(2, 'ForwarderFactoryV4 创建')];
  await assert.rejects(preflight(n.rpc, { from: FROM, txs, gasPrice: 10n ** 9n, balance: 10n ** 15n }), /不够（一笔都没有发）/);
  assert.equal(n.sent.length, 0);
  const ok = await preflight(n.rpc, { from: FROM, txs, gasPrice: 10n ** 9n, balance: 10n ** 17n });
  assert.equal(ok.simulated, true);
  assert.deepEqual(ok.gas, [14_000_000, 14_000_000]);
  assert.equal(ok.totalLimit, TX_GAS_CAP * 2);
});

test('发之前整套模拟：有一笔按节点规则会失败或超过单笔上限，直接报错', async () => {
  const fails = fakeNode({ simulate: (calls) => [{ calls: calls.map((_, i) => (i === 1 ? { status: '0x0', gasUsed: '0x1', error: { message: 'out of gas' } } : { status: '0x1', gasUsed: hex(1000) })) }] });
  await assert.rejects(preflight(fails.rpc, { from: FROM, txs: [createTx(0), createTx(1, '工厂')], gasPrice: 1n, balance: 10n ** 18n }), /第 2\/2 笔（工厂）按节点的规则模拟会失败：out of gas/);
  const big = fakeNode({ simulate: (calls) => [{ calls: calls.map(() => ({ status: '0x1', gasUsed: hex(TX_GAS_CAP + 1) })) }] });
  await assert.rejects(preflight(big.rpc, { from: FROM, txs: [createTx(0)], gasPrice: 1n, balance: 10n ** 18n }), /超过单笔上限/);
});

test('节点不支持 eth_simulateV1：只估第一笔，照样核对余额', async () => {
  const n = fakeNode({ estimate: () => 14_028_265 });
  const r = await preflight(n.rpc, { from: FROM, txs: [createTx(1), createTx(2)], gasPrice: 10n ** 9n, balance: 10n ** 18n });
  assert.equal(r.simulated, false);
  assert.deepEqual(r.gas, [14_028_265]);
});

test('回执 status 0（gas 用光）：立即停，后面的不发，错误写清楚是哪一笔、gas、下次的 nonce', async () => {
  const n = fakeNode({ nonce: 1, estimate: () => 2_000_000, receipts: [undefined, () => ({ status: '0x0', gasUsed: hex(349_963), blockNumber: '0x20', contractAddress: null })] });
  const recs = [];
  const txs = [createTx(1, 'ForwarderV4 创建', null), createTx(2, 'ForwarderFactoryV4 创建', null), createTx(3, 'SweepBatcher 创建', null)];
  // 第 2 笔的 gas limit = 2,000,000 × 1.25 = 2,500,000；替身回执说用了 349,963（没用光）
  await assert.rejects(sendAll(n.rpc, { key: KEY, from: FROM, chainId: 11155111, gasPrice: 1n, txs, onTx: (t) => recs.push(t), wait: fastWait, explorer: 'https://sepolia.etherscan.io' }),
    (e) => /第 2\/3 笔（ForwarderFactoryV4 创建，nonce 2）：链上失败（status 0x0，用了 gas 349,963 \/ 2,500,000）/.test(e.message) && /后面的交易没有发出；部署账户的 nonce 现在是 3/.test(e.message) && /sepolia\.etherscan\.io\/tx\/0x/.test(e.message));
  assert.equal(n.sent.length, 2);
  assert.deepEqual(recs.map((r) => r.status), ['ok', 'failed']);

  const oog = fakeNode({ nonce: 0, estimate: () => 1_000_000, receipts: [() => ({ status: '0x0', gasUsed: hex(1_250_000), blockNumber: '0x1' })] });
  await assert.rejects(sendAll(oog.rpc, { key: KEY, from: FROM, chainId: 11155111, gasPrice: 1n, txs: [createTx(0, 'ForwarderV4 创建', null), createTx(1)], wait: fastWait }),
    /gas 全部用光（limit 1,250,000，节点估算 1,000,000）/);
  assert.equal(oog.sent.length, 1);
});

test('合约地址和 forge 算的不一样、nonce 被别的交易占了、迟迟不上链：都停下', async () => {
  const mism = fakeNode({ receipts: [{ status: '0x1', gasUsed: '0x1', blockNumber: '0x1', contractAddress: '0x' + 'cd'.repeat(20) }] });
  await assert.rejects(sendAll(mism.rpc, { key: KEY, from: FROM, chainId: 1, gasPrice: 1n, txs: [createTx(0)], wait: fastWait }), /和 forge 算的 .* 不一样/);
  const busy = fakeNode({ nonce: 5 });
  await assert.rejects(sendAll(busy.rpc, { key: KEY, from: FROM, chainId: 1, gasPrice: 1n, txs: [createTx(4)], wait: fastWait }), /nonce 是 5，不是 4/);
  assert.equal(busy.sent.length, 0);
  const slow = fakeNode({ receipts: [null] });
  await assert.rejects(sendAll(slow.rpc, { key: KEY, from: FROM, chainId: 1, gasPrice: 1n, txs: [createTx(0, 'X', null), createTx(1)], wait: fastWait }), /还没有上链。已停止/);
  assert.equal(slow.sent.length, 1);
  assert.equal(await waitReceipt(async () => null, '0x', fastWait), null);
});

test('对齐 nonce：小于起始 nonce 时给自己转 0 推上去；已经超过时报错（不能往回退）', async () => {
  const n = fakeNode({ nonce: 0, estimate: () => 21_000 });
  const recs = [];
  assert.equal(await alignNonce(n.rpc, { key: KEY, from: FROM, chainId: 97, target: 1, gasPrice: 10n ** 9n, onTx: (t) => recs.push(t), wait: fastWait }), 1);
  assert.equal(n.state.nonce, 1);
  assert.equal(recs[0].label, '对齐 nonce（给自己转 0）');
  assert.equal(await alignNonce(n.rpc, { key: KEY, from: FROM, chainId: 97, target: 1, gasPrice: 1n, wait: fastWait }), 0);
  await assert.rejects(alignNonce(fakeNode({ nonce: 2 }).rpc, { key: KEY, from: FROM, chainId: 97, target: 1, gasPrice: 1n, wait: fastWait }), /nonce 已经是 2，大于起始 nonce 1/);
  await assert.rejects(alignNonce(fakeNode({ nonce: 0, balance: 1n }).rpc, { key: KEY, from: FROM, chainId: 97, target: 3, gasPrice: 1n, wait: fastWait }), /部署账户只有/);
});
