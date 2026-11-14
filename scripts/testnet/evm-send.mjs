// 测试网 EVM 部署的发送部分（scripts/testnet/deploy.mjs 用）：forge 只生成交易、不广播；gas 按节点自己的规则定，逐笔签名发出、逐笔核对回执。
// 为什么不让 forge 广播：forge 1.5.1 用自己内置的 EVM 估 gas，它不认识 Sepolia 2026-10-06 启用的新硬分叉（anvil --hardfork amsterdam 直接报
// "unimplemented Amsterdam"）；新规则下建合约贵很多（ForwarderV4 实测要 1,402 万 gas，forge 只给了 256 万），第一笔就耗尽 gas 失败。
// 所以：① 发之前用节点的 eth_simulateV1 把整套交易按链上规则跑一遍（不上链），算总 gas、核对余额，不够就一笔都不发；
//      ② 每一笔发之前用节点的 eth_estimateGas（前一笔已上链后的状态）× 1.25 定 gas，超过单笔上限 2^24 就停；
//      ③ 每一笔发出后等回执，status 不是 1、合约地址和 forge 算的不一样都立即停，写清楚是哪一笔、gas 用了多少、下次起始 nonce 填几。
import { signLegacyTx } from '../../server/wallet/evm-tx.js';

/** 单笔交易 gas 上限（EIP-7825，Sepolia 2025-10 起；BSC 也按这个算，宁可保守） */
export const TX_GAS_CAP = 16_777_216;
/** 节点估算的 gas × 1.25（再不超过单笔上限） */
export const GAS_MARGIN = 1.25;

const hex = (n) => '0x' + BigInt(n).toString(16);
const num = (h) => Number(BigInt(h));
const lower = (a) => String(a || '').toLowerCase();
export const fmtEth = (wei, unit = 'ETH') => `${(Number(wei) / 1e18).toFixed(6)} ${unit}`;

/** 节点估算值 → 这笔交易的 gas limit；估算本身超过单笔上限时报错（这条链上部署不了这个合约） */
export function gasLimitFor(estimate, label = '交易') {
  const est = Number(estimate);
  if (!(est > 0)) throw new Error(`${label}：节点没有给出 gas 估算`);
  if (est > TX_GAS_CAP) throw new Error(`${label}：按节点的规则要 ${est.toLocaleString('en-US')} gas，超过单笔上限 ${TX_GAS_CAP.toLocaleString('en-US')}，这条链上一笔部署不了`);
  return Math.min(Math.ceil(est * GAS_MARGIN), TX_GAS_CAP);
}

/** legacy 交易的 gasPrice：max(节点建议价, 2 × 当前 baseFee + 小费)；EVM_GAS_PRICE_GWEI 填了就用它 */
export async function pickGasPrice(rpc, { overrideGwei = '' } = {}) {
  if (overrideGwei) {
    const g = Number(overrideGwei);
    if (!(g > 0)) throw new Error('EVM_GAS_PRICE_GWEI 要填正数');
    return BigInt(Math.round(g * 1e9));
  }
  const suggested = BigInt(await rpc('eth_gasPrice'));
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  const base = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
  let tip = 0n;
  try { tip = BigInt(await rpc('eth_maxPriorityFeePerGas')); } catch { /* BSC 等不支持时只用 eth_gasPrice */ }
  const p = 2n * base + tip;
  return p > suggested ? p : suggested;
}

/** 等回执（每 pollMs 查一次，最多 timeoutMs）；查不到返回 null */
export async function waitReceipt(rpc, hash, { timeoutMs = 600_000, pollMs = 3_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    if (Date.now() >= until) return null;
    await sleep(pollMs);
  }
}

/**
 * 发之前按节点自己的规则把整套交易跑一遍（eth_simulateV1，不上链）。
 * 返回 { simulated, gas: [每笔用量], totalLimit, cost }；节点不支持 eth_simulateV1 时 simulated = false（只能估第一笔）。
 * 任何一笔在节点上会失败、超过单笔上限，或部署账户的余额不够付全部手续费，都直接报错（一笔都不发）。
 */
export async function preflight(rpc, { from, txs, gasPrice, balance, unit = 'ETH' }) {
  const calls = txs.map((t) => ({ from, ...(t.to ? { to: t.to } : {}), data: t.data, value: hex(t.value || 0), nonce: hex(t.nonce) }));
  let res = null;
  try {
    res = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']);
  } catch (e) {
    if (!/does not exist|not available|not found|unsupported|not supported|method/i.test(e.message)) throw e;
  }
  const gas = [];
  let simulated = false;
  if (Array.isArray(res) && res[0]?.calls?.length === txs.length) {
    simulated = true;
    res[0].calls.forEach((c, i) => {
      const label = `第 ${i + 1}/${txs.length} 笔（${txs[i].label}）`;
      if (c.status !== '0x1') throw new Error(`${label}按节点的规则模拟会失败：${c.error?.message || c.status}（一笔都没有发）`);
      gas.push(Math.max(num(c.gasUsed), c.maxUsedGas ? num(c.maxUsedGas) : 0)); // maxUsedGas：执行中用到的最多（有退款时比 gasUsed 大）
    });
  } else {
    // 节点不支持整套模拟：只能按当前状态估第一笔（后面的依赖前面的合约，发的时候逐笔再估）
    gas.push(num(await rpc('eth_estimateGas', [calls[0], 'latest'])));
  }
  const limits = gas.map((g, i) => gasLimitFor(g, `第 ${i + 1}/${txs.length} 笔（${txs[i].label}）`));
  const totalLimit = limits.reduce((a, b) => a + b, 0);
  const cost = BigInt(totalLimit) * BigInt(gasPrice);
  if (BigInt(balance) < cost) {
    throw new Error(`部署账户 ${from} 余额 ${fmtEth(balance, unit)}，${simulated ? `${txs.length} 笔全部` : '第一笔'}按 gas ${totalLimit.toLocaleString('en-US')} × ${gasPrice} wei 最多要 ${fmtEth(cost, unit)}，不够（一笔都没有发）：先去水龙头领，或填低一点的 gas 价格（GitHub 环境变量 TESTNET_EVM_GAS_PRICE_GWEI，本机 EVM_GAS_PRICE_GWEI）`);
  }
  return { simulated, gas, totalLimit, cost };
}

/** 一笔：核对 nonce → 节点估 gas → 签名发出 → 等回执 → 核对 status 和合约地址。失败时抛出带说明的错误 */
async function sendOne(rpc, { key, from, chainId, gasPrice, tx, step, total, explorer, wait }) {
  const label = `第 ${step}/${total} 笔（${tx.label}，nonce ${tx.nonce}）`;
  const nonce = num(await rpc('eth_getTransactionCount', [from, 'pending']));
  if (nonce !== tx.nonce) throw new Error(`${label}：部署账户现在的 nonce 是 ${nonce}，不是 ${tx.nonce}（有别的交易在用这个账户？）。已停止`);
  const call = { from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: hex(tx.value || 0) };
  const est = num(await rpc('eth_estimateGas', [call, 'latest']));
  const gas = gasLimitFor(est, label);
  const { raw, hash } = signLegacyTx({ nonce: tx.nonce, gasPrice, gas, to: tx.to || '0x', value: tx.value || 0, data: tx.data, chainId }, key);
  const sent = await rpc('eth_sendRawTransaction', [raw]);
  if (lower(sent) !== lower(hash)) throw new Error(`${label}：节点返回的交易号 ${sent} 和本地算的 ${hash} 不一样。已停止`);
  const rec = { step, label: tx.label, nonce: tx.nonce, hash, gasEstimate: est, gasLimit: gas, gasPrice: String(gasPrice), status: 'sent' };
  const link = explorer ? `（${explorer}/tx/${hash}）` : '';
  const receipt = await waitReceipt(rpc, hash, wait);
  if (!receipt) {
    rec.status = 'pending';
    return { rec, error: `${label}：发出 ${hash}${link} 后 ${Math.round((wait?.timeoutMs ?? 600_000) / 60_000)} 分钟还没有上链。已停止，后面的交易没有发出；等它上链或被丢弃后再查部署账户的 nonce` };
  }
  rec.gasUsed = num(receipt.gasUsed);
  rec.block = num(receipt.blockNumber);
  if (receipt.status !== '0x1') {
    rec.status = 'failed';
    const outOfGas = rec.gasUsed >= gas ? `，gas 全部用光（limit ${gas.toLocaleString('en-US')}，节点估算 ${est.toLocaleString('en-US')}）` : `，用了 gas ${rec.gasUsed.toLocaleString('en-US')} / ${gas.toLocaleString('en-US')}`;
    return { rec, error: `${label}：链上失败（status ${receipt.status}${outOfGas}），交易 ${hash}${link}。已停止，后面的交易没有发出；部署账户的 nonce 现在是 ${tx.nonce + 1}` };
  }
  if (tx.contractAddress && lower(receipt.contractAddress) !== lower(tx.contractAddress)) {
    rec.status = 'mismatch';
    return { rec, error: `${label}：合约地址 ${receipt.contractAddress} 和 forge 算的 ${tx.contractAddress} 不一样。已停止` };
  }
  rec.status = 'ok';
  if (receipt.contractAddress) rec.address = receipt.contractAddress;
  return { rec };
}

/** 按顺序发出全部交易，每笔核对回执；onTx 每笔发完（成功或失败）都会被调用（调用方把记录写进结果文件）。失败抛错 */
export async function sendAll(rpc, { key, from, chainId, gasPrice, txs, explorer = '', onTx = () => {}, log = () => {}, wait }) {
  for (let i = 0; i < txs.length; i++) {
    const { rec, error } = await sendOne(rpc, { key, from, chainId, gasPrice, tx: txs[i], step: i + 1, total: txs.length, explorer, wait });
    onTx(rec);
    if (error) throw new Error(error);
    log(`  ${rec.step}/${txs.length} ${rec.label}：${rec.address || rec.hash}（gas ${rec.gasUsed.toLocaleString('en-US')} / limit ${rec.gasLimit.toLocaleString('en-US')}，区块 ${rec.block}）`);
  }
}

/**
 * 把部署账户在这条链上的 nonce 推到 target：每笔给自己转 0（只花手续费）。
 * 用途：两条 EVM 链的起始 nonce 要一样，部署出的地址才相同；一条链已经用掉了 nonce（例如 Sepolia 第一次失败用掉了 0），另一条链先推到同一个值。
 * 现在的 nonce 已经超过 target 时报错（nonce 不能往回退，只能换一个起始 nonce 两条链重新部署）。
 */
export async function alignNonce(rpc, { key, from, chainId, target, gasPrice, explorer = '', onTx = () => {}, log = () => {}, wait, unit = 'ETH' }) {
  const latest = num(await rpc('eth_getTransactionCount', [from, 'latest']));
  const pending = num(await rpc('eth_getTransactionCount', [from, 'pending']));
  if (pending !== latest) throw new Error(`部署账户有还没上链的交易（nonce ${latest} 到 ${pending - 1}），等它们上链后再运行`);
  if (latest > target) throw new Error(`部署账户的 nonce 已经是 ${latest}，大于起始 nonce ${target}：nonce 不能往回退，起始 nonce 填 ${latest} 或更大，两条链都按这个值重新部署`);
  if (latest === target) return 0;
  const n = target - latest;
  const est = num(await rpc('eth_estimateGas', [{ from, to: from, value: '0x0' }, 'latest']));
  const gas = gasLimitFor(est, '对齐 nonce 的转账');
  const balance = BigInt(await rpc('eth_getBalance', [from, 'latest']));
  const cost = BigInt(gas) * BigInt(gasPrice) * BigInt(n);
  if (balance < cost) throw new Error(`对齐 nonce 要发 ${n} 笔 0 值转账，最多要 ${fmtEth(cost, unit)}，部署账户只有 ${fmtEth(balance, unit)}`);
  log(`  对齐 nonce：${latest} → ${target}（发 ${n} 笔给自己转 0）`);
  const txs = Array.from({ length: n }, (_, i) => ({ label: '对齐 nonce（给自己转 0）', nonce: latest + i, to: from, data: '0x', value: 0 }));
  await sendAll(rpc, { key, from, chainId, gasPrice, txs, explorer, onTx, log, wait });
  return n;
}
