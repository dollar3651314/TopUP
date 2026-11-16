#!/usr/bin/env node
// 测试网充值第 2 步（.github/workflows/testnet-fund.yml 的 fund，GitHub 环境 testnet，要管理员批准）：
// 从部署账户（TOPUP_TESTNET_DEPLOYER_KEY，部署测试 USDT 时铸给了它 1,000,000 个）给第 1 步的每个充值地址转 AMOUNT 个测试 USDT。
//   以太坊 Sepolia：复用 evm-send.mjs（eth_simulateV1 整套模拟 + 余额核对，不够一笔不发；每笔 eth_estimateGas × 1.25；逐笔等回执，失败立即停；主网链 ID 拒绝）
//   TRON Nile：复用 scripts/tron-nile/tron-node.mjs（先查 0 号区块，只准 Nile；本地签名、广播、等回执）
// 硬性限制（scripts/testnet/fund-lib.mjs）：以太坊只准链 ID 11155111、TRON 只准 Nile；代币只准 staging 的测试 USDT（写死，和 config/wallets.json 对照）；
//   每条链最多 50 个地址、每个最多 1000 个；地址只来自第 1 步的输出（或手动运行时填的清单），逐个核对格式、不重复、不是代币合约或部署账户自己。
// 每笔转账后核对收款地址的代币余额正好增加 AMOUNT（TRON 的测试 USDT transfer 成功也返回 false，只看回执不够）。
// 收款地址已经有 ≥ AMOUNT 的余额时跳过（同一次运行重跑第 2 步不会重复打）。
// 结果：OUT_DIR（默认 testnet-fund）下 fund.json、fund.md（客户标识、地址、交易号）+ 运行摘要；私钥、节点地址、TronGrid key 一律遮盖。
//
// 环境变量：TOPUP_TESTNET_DEPLOYER_KEY、TESTNET_ETH_RPC_URL（可选）、TRONGRID_API_KEY（可选）、
//   FUND_PLAN（第 1 步输出的清单 JSON）或 FUND_ADDRESSES + FUND_CHAINS（只一条链）+ FUND_AMOUNT（手动填的地址）、OUT_DIR
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addressOfKey } from '../../server/wallet/evm-tx.js';
import { preflight, sendAll, pickGasPrice, refuseMainnet } from './evm-send.mjs';
import { FUND_TARGETS, checkEvmChainId, checkTronNetwork, tokenFor, validatePlan, planFromList, parseChains, erc20TransferData, erc20BalanceOfData, stagingSystemAddresses, secretList, maskWith, fmtUnits, txLink } from './fund-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEPOLIA_DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const NILE_NODE = 'https://nile.trongrid.io';
/** TRON 每笔最多烧 100 TRX（测试币） */
const TRON_FEE_LIMIT = 100_000_000;

/** JSON-RPC（15 秒超时，429 / 5xx / 连接错误退避重试 3 次）；错误信息不带节点地址 */
export function makeRpc(url, { fetchImpl = fetch } = {}) {
  return async function rpc(method, params = []) {
    let last;
    for (let i = 0; i <= 3; i++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
        const j = await res.json();
        if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`), { rpcError: true });
        return j.result;
      } catch (e) {
        last = e.rpcError || e.retry ? e : new Error(e.name === 'TimeoutError' ? '超时' : `连接失败${e.cause?.code ? `（${String(e.cause.code).replace(/[^A-Z0-9_]/gi, '')}）` : ''}`);
        if (e.rpcError || i === 3) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
    throw new Error(`节点请求失败（${method}）：${last?.message}`);
  };
}

const balanceEvm = async (rpc, token, addr) => BigInt(await rpc('eth_call', [{ to: token, data: erc20BalanceOfData(addr) }, 'latest']) || '0x0');

/**
 * 以太坊 Sepolia：核对链 ID → 代币余额 → 整套模拟 → 逐笔发出 → 核对每个收款地址的余额。
 * records：每个地址一条 { customer_id, address, amount, txid, status }（ok / skipped / failed / not-sent）
 */
export async function fundEvm(rpc, { key, token, plan, wait, gasPriceGwei = '', exclude = [], log = () => {}, onRecords = () => {} }) {
  const chainId = Number(BigInt(await rpc('eth_chainId')));
  checkEvmChainId(chainId);
  const from = addressOfKey(key);
  const p = validatePlan({ chains: { eth: plan } }, { exclude: { eth: [from, ...exclude] } }).chains.eth;
  const decimals = Number(BigInt(await rpc('eth_call', [{ to: token, data: '0x313ce567' }, 'latest'])));
  if (decimals !== FUND_TARGETS.eth.decimals) throw new Error(`测试 USDT 的小数位数是 ${decimals}，不是 ${FUND_TARGETS.eth.decimals}（一笔都没有发）`);
  const records = p.items.map((it) => ({ ...it, amount: p.amount, txid: '', status: 'not-sent' }));
  const before = [];
  for (const r of records) before.push(await balanceEvm(rpc, token, r.address));
  const todo = records.map((r, i) => i).filter((i) => {
    if (before[i] >= p.amountUnits) { records[i].status = 'skipped'; records[i].note = `已有 ${fmtUnits(before[i])}`; return false; }
    return true;
  });
  onRecords(records);
  if (!todo.length) { log('  全部地址已经有足够余额，没有要发的'); return records; }
  const need = p.amountUnits * BigInt(todo.length);
  const have = await balanceEvm(rpc, token, from);
  if (have < need) throw new Error(`部署账户 ${from} 只有 ${fmtUnits(have)} 测试 USDT，${todo.length} 个地址要 ${fmtUnits(need)}（一笔都没有发）`);
  const latest = Number(BigInt(await rpc('eth_getTransactionCount', [from, 'latest'])));
  const pending = Number(BigInt(await rpc('eth_getTransactionCount', [from, 'pending'])));
  if (latest !== pending) throw new Error(`部署账户有还没上链的交易（nonce ${latest} 到 ${pending - 1}），等它们上链后再运行（一笔都没有发）`);
  const txs = todo.map((i, n) => ({ label: `${records[i].customer_id} ← ${p.amount} 测试 USDT`, nonce: latest + n, to: token, data: erc20TransferData(records[i].address, p.amountUnits), value: 0, idx: i }));
  const gasPrice = await pickGasPrice(rpc, { overrideGwei: gasPriceGwei });
  const balance = BigInt(await rpc('eth_getBalance', [from, 'latest']));
  const pf = await preflight(rpc, { from, txs, gasPrice, balance });
  log(`  部署账户 ${from}：${todo.length} 笔，${pf.simulated ? '整套模拟通过' : '节点不支持整套模拟，只估了第一笔'}，gas 价格 ${gasPrice} wei`);
  // 一笔一笔发：每笔回执成功后立即核对收款地址余额正好增加 AMOUNT，不对就停（后面的不发）
  for (const [n, t] of txs.entries()) {
    const r = records[t.idx];
    await sendAll(rpc, {
      key, from, chainId, gasPrice, txs: [t], explorer: FUND_TARGETS.eth.explorer, wait, log,
      onTx: (rec) => { r.txid = rec.hash; r.status = rec.status === 'ok' ? 'sent' : 'failed'; if (rec.status !== 'ok') r.note = `第 ${n + 1}/${txs.length} 笔：${rec.status}`; onRecords(records); },
    });
    const after = await balanceEvm(rpc, token, r.address);
    r.status = after === before[t.idx] + p.amountUnits ? 'ok' : 'failed';
    onRecords(records);
    if (r.status === 'failed') {
      r.note = `回执成功，但余额 ${fmtUnits(before[t.idx])} → ${fmtUnits(after)}，不是正好加 ${p.amount}`;
      throw new Error(`第 ${n + 1}/${txs.length} 笔（${r.customer_id}）${r.note}，交易 ${txLink('eth', r.txid)}。已停止，后面的没有发`);
    }
  }
  return records;
}

const balanceTron = async (node, token, addr) => BigInt('0x' + ((await node.call(token, 'balanceOf(address)', ['address'], [addr])) || '0'));

/** TRON Nile：核对是 Nile → 代币余额、TRX 够不够 → 逐笔 transfer、等回执、核对收款地址余额 */
export async function fundTron(node, signer, { token, plan, exclude = [], log = () => {}, onRecords = () => {} }) {
  checkTronNetwork(await node.checkNetwork());
  const p = validatePlan({ chains: { tron: plan } }, { exclude: { tron: [signer.address, ...exclude] } }).chains.tron;
  const decimals = Number(BigInt('0x' + (await node.call(token, 'decimals()'))));
  if (decimals !== FUND_TARGETS.tron.decimals) throw new Error(`测试 USDT 的小数位数是 ${decimals}，不是 ${FUND_TARGETS.tron.decimals}（一笔都没有发）`);
  const records = p.items.map((it) => ({ ...it, amount: p.amount, txid: '', status: 'not-sent' }));
  const before = [];
  for (const r of records) before.push(await balanceTron(node, token, r.address));
  const todo = records.map((r, i) => i).filter((i) => {
    if (before[i] >= p.amountUnits) { records[i].status = 'skipped'; records[i].note = `已有 ${fmtUnits(before[i])}`; return false; }
    return true;
  });
  onRecords(records);
  if (!todo.length) { log('  全部地址已经有足够余额，没有要发的'); return records; }
  const need = p.amountUnits * BigInt(todo.length);
  const have = await balanceTron(node, token, signer.address);
  if (have < need) throw new Error(`部署账户 ${signer.address} 只有 ${fmtUnits(have)} 测试 USDT，${todo.length} 个地址要 ${fmtUnits(need)}（一笔都没有发）`);
  // TRX 够不够：按节点对第一笔的能量估算（新地址第一次收币最贵）× 1.5 × 笔数 × 能量单价，另加每笔 1 TRX 带宽
  const est = await node.post('/wallet/triggerconstantcontract', {
    owner_address: signer.address, contract_address: token, function_selector: 'transfer(address,uint256)',
    parameter: node.enc(['address', 'uint256'], [records[todo[0]].address, p.amountUnits]), visible: true,
  });
  const energy = Number(est?.energy_used || 0) || 65_000;
  const params = Object.fromEntries(((await node.post('/wallet/getchainparameters', {})).chainParameter || []).map((x) => [x.key, x.value ?? 0]));
  const energyFee = Number(params.getEnergyFee || 420);
  const needSun = Math.ceil(energy * 1.5 * energyFee + 1_000_000) * todo.length;
  const trx = await node.balance(signer.address);
  log(`  部署账户 ${signer.address}：${todo.length} 笔，每笔估计能量 ${energy}、单价 ${energyFee} sun，最多约 ${Math.ceil(needSun / 1e6)} TRX，余额 ${trx / 1e6} TRX`);
  if (trx < needSun) throw new Error(`部署账户 ${signer.address} 只有 ${trx / 1e6} TRX，估计要 ${Math.ceil(needSun / 1e6)} TRX（Nile 水龙头领；一笔都没有发）`);
  for (const [n, i] of todo.entries()) {
    const r = records[i];
    let res;
    try {
      res = await node.send(signer, token, 'transfer(address,uint256)', ['address', 'uint256'], [r.address, p.amountUnits], { feeLimit: TRON_FEE_LIMIT });
    } catch (e) {
      // 等回执超时：交易已经广播，把交易号记下来（tron-node 的错误里带着它）
      const pend = /not confirmed in time: ([0-9a-f]{64})/i.exec(String(e?.message || ''));
      if (pend) { r.txid = pend[1]; r.status = 'failed'; r.note = '已广播，等回执超时（到浏览器查这笔是否上链）'; onRecords(records); throw new Error(`第 ${n + 1}/${todo.length} 笔（${r.customer_id}）已广播但等回执超时，交易 ${txLink('tron', r.txid)}。已停止，后面的没有发`); }
      r.status = 'failed'; r.note = '发送出错'; onRecords(records);
      throw new Error(`第 ${n + 1}/${todo.length} 笔（${r.customer_id}）发送出错：${e.message}。已停止，后面的没有发`);
    }
    r.txid = res.txId;
    const after = await balanceTron(node, token, r.address);
    r.status = res.ok && after === before[i] + p.amountUnits ? 'ok' : 'failed';
    if (r.status === 'failed') r.note = `回执 ${res.info?.receipt?.result || '?'}，余额 ${fmtUnits(before[i])} → ${fmtUnits(after)}`;
    onRecords(records);
    if (r.status === 'failed') throw new Error(`第 ${n + 1}/${todo.length} 笔（${r.customer_id}）没有成功（${r.note}），交易 ${txLink('tron', r.txid)}。已停止，后面的没有发`);
    log(`  ${n + 1}/${todo.length} ${r.customer_id} ← ${p.amount}：${r.txid}（能量 ${res.info?.receipt?.energy_usage_total ?? '?'}）`);
  }
  return records;
}

const STATUS = { ok: '已到账', skipped: '跳过（已有余额）', failed: '失败', 'not-sent': '没有发', sent: '已发出、未核对' };
export function fundMarkdown(result) {
  const lines = ['## 测试网充值第 2 步：转测试 USDT', '', `运行编号 \`${result.run}\`。只有客户标识、公开地址和交易号。`, ''];
  for (const [chain, c] of Object.entries(result.chains)) {
    const ok = c.records.filter((r) => r.status === 'ok').length;
    lines.push(`### ${FUND_TARGETS[chain].name}：${ok}/${c.records.length} 个已到账（每个 ${c.amount} 测试 USDT，代币 \`${c.token}\`）`, '');
    if (c.error) lines.push(`**失败**：${c.error}`, '');
    lines.push('| # | 客户标识 | 充值地址 | 交易 | 结果 |', '|---|---|---|---|---|');
    c.records.forEach((r, i) => lines.push(`| ${i + 1} | \`${r.customer_id}\` | \`${r.address}\` | ${r.txid ? `[${r.txid.slice(0, 12)}…](${txLink(chain, r.txid)})` : '—'} | ${STATUS[r.status] || r.status}${r.note ? `（${r.note}）` : ''} |`));
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const env = process.env;
  const k = String(env.TOPUP_TESTNET_DEPLOYER_KEY || '').trim().replace(/^0x/, '');
  delete env.TOPUP_TESTNET_DEPLOYER_KEY;
  const ethUrl = String(env.TESTNET_ETH_RPC_URL || '').trim() || SEPOLIA_DEFAULT_RPC;
  const mask = maskWith(secretList({ key: k, urls: [env.TESTNET_ETH_RPC_URL], values: [env.TRONGRID_API_KEY] }));
  const OUT = env.OUT_DIR || 'testnet-fund';
  const result = { generatedAt: new Date().toISOString(), commit: env.GITHUB_SHA || '', run: '', chains: {} };
  const write = () => {
    mkdirSync(OUT, { recursive: true });
    const plain = JSON.parse(JSON.stringify(result, (key, v) => (typeof v === 'bigint' ? v.toString() : v)));
    writeFileSync(join(OUT, 'fund.json'), mask(JSON.stringify(plain, null, 2)) + '\n');
    writeFileSync(join(OUT, 'fund.md'), mask(fundMarkdown(result)) + '\n');
  };
  let failed = false;
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('没有部署账户私钥：GitHub 环境 testnet 的密钥 TOPUP_TESTNET_DEPLOYER_KEY 没填，或不是 64 位十六进制');
    const key = k.toLowerCase();
    let raw;
    if (String(env.FUND_ADDRESSES || '').trim()) {
      const chains = parseChains(env.FUND_CHAINS);
      if (chains.length !== 1) throw new Error('手动填地址时只能选一条链（eth 或 tron）');
      raw = planFromList(chains[0], env.FUND_ADDRESSES, env.FUND_AMOUNT || '100', env.FUND_RUN || '');
    } else {
      try { raw = JSON.parse(String(env.FUND_PLAN || '')); } catch { throw new Error('没有第 1 步的地址清单（FUND_PLAN），或格式不对'); }
    }
    const wallets = JSON.parse(readFileSync(join(ROOT, 'config/wallets.json'), 'utf8'));
    // 整份先核对一遍（格式、上限、重复、系统地址），有问题一笔都不发
    const plan = validatePlan(raw, { exclude: { eth: stagingSystemAddresses(wallets, 'eth'), tron: stagingSystemAddresses(wallets, 'tron') } });
    result.run = plan.run;
    for (const chain of Object.keys(plan.chains)) {
      const token = tokenFor(chain, wallets);
      const c = result.chains[chain] = { token, amount: plan.chains[chain].amount, records: [] };
      const onRecords = (recs) => { c.records = recs; };
      const sub = { amount: plan.chains[chain].amount, items: plan.chains[chain].items };
      console.log(`\n== ${FUND_TARGETS[chain].name}：${sub.items.length} 个地址，每个 ${sub.amount} 测试 USDT`);
      try {
        if (chain === 'eth') {
          await fundEvm(makeRpc(ethUrl), { key, token, plan: sub, exclude: stagingSystemAddresses(wallets, 'eth'), gasPriceGwei: env.EVM_GAS_PRICE_GWEI || '', log: (m) => console.log(mask(m)), onRecords });
        } else {
          const { createNode, makeSigner } = await import('../tron-nile/tron-node.mjs');
          const node = createNode({ base: NILE_NODE, apiKey: env.TRONGRID_API_KEY || '' });
          await fundTron(node, makeSigner(key), { token, plan: sub, exclude: stagingSystemAddresses(wallets, 'tron'), log: (m) => console.log(mask(m)), onRecords });
        }
      } catch (e) {
        c.error = mask(e?.message || String(e));
        failed = true;
        console.error(`::error::${c.error.replace(/\r?\n/g, ' ')}`);
      }
      write();
    }
  } catch (e) {
    const m = mask(e?.message || String(e));
    result.error = m;
    failed = true;
    console.error(`::error::${m.replace(/\r?\n/g, ' ')}`);
  }
  write();
  const md = mask(fundMarkdown(result)) + (result.error ? `\n**失败**：${result.error}\n` : '');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n');
  console.log('\n' + md);
  if (failed) process.exitCode = 1;
}

// refuseMainnet 也在 sendAll 里再查一遍；这里导出给测试核对同一个函数
export { refuseMainnet };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
