#!/usr/bin/env node
// 测试网合约部署（Sepolia、BSC 测试网、TRON Nile）。说明见同目录 README.md；GitHub 上由 .github/workflows/testnet-deploy.yml 运行（环境 testnet，要管理员批准）。
//   ETH / BSC：forge script contracts/script/DeployTestnet.s.sol（实现合约 → 工厂 → SweepBatcher → 测试 USDT → BatchPayout）
//   TRON：TRON 官方编译器（scripts/tron-nile/compile.mjs）编译，ForwarderTron → ForwarderFactoryTron → SweepBatcherTron → 测试 USDT（TRC20）
// 部署完用服务器自己的代码核对（server/wallet/：和服务器启动时同一套链上核对、同一套充值地址算法），全部通过才算成功。
// 结果：OUT_DIR（默认 testnet-deploy/）下 deployment.json（全部是公开地址和交易号，可以填进 config/wallets.json 的 staging 一节）和 summary.md。
//
// 环境变量（GitHub 上由 workflow 从环境 testnet 的密钥和运行时填的参数传进来）：
//   TOPUP_TESTNET_DEPLOYER_KEY   部署账户私钥（64 位十六进制，可带 0x）：ETH、BSC、TRON 用同一把（同一个私钥在 TRON 上对应一个 T 地址）。只在内存里用，不打印、不写文件
//   TESTNET_CHAINS               要部署的链，逗号分隔：eth,bsc,tron（默认三条）
//   TESTNET_ETH_RPC_URL / TESTNET_BSC_RPC_URL   节点地址（可以带 key，日志里不打印）；不填用公共测试网节点
//   TESTNET_TRON_NODE            TRON 节点（默认 https://nile.trongrid.io）；TRONGRID_API_KEY 可选
//   EVM_PARENT / EVM_OPERATOR / EVM_OWNER（默认 = parent）/ EVM_START_NONCE（默认 0）
//   TRON_PARENT / TRON_OPERATOR / TRON_OWNER（默认 = parent）
//   TESTNET_USDT                 1 = 每条链部署一个测试 USDT（默认 1）；0 = 不部署（TRON 用 config/wallets.json 里 Nile 官方测试 USDT；ETH、BSC 没有官方的，usdt 留空）
//   TESTNET_USDT_MINT            部署时给部署账户多少个测试 USDT（默认 1,000,000）
//   PAYOUT_PAYER                 批量打款的热钱包地址（ETH、BSC）；填了才部署 BatchPayout（src/BatchPayout.sol 合并进来之后才有）
//   TESTNET_LOCAL=1              本机演练：允许本地 anvil（链 ID 31337）和本机 TRON 私链；GitHub 上不要设
//   OUT_DIR                      结果目录（默认 testnet-deploy）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = process.env;
const LOCAL = env.TESTNET_LOCAL === '1';
const OUT = env.OUT_DIR || 'testnet-deploy';
const CHAINS = (env.TESTNET_CHAINS || 'eth,bsc,tron').split(',').map((s) => s.trim()).filter(Boolean);
const USDT = (env.TESTNET_USDT ?? '1') === '1';
const MINT = env.TESTNET_USDT_MINT || '1000000';
const EVM = {
  eth: { name: '以太坊 Sepolia', chainId: 11155111, rpc: env.TESTNET_ETH_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
  bsc: { name: 'BSC 测试网', chainId: 97, rpc: env.TESTNET_BSC_RPC_URL || 'https://bsc-testnet-rpc.publicnode.com', explorer: 'https://testnet.bscscan.com', legacy: true },
};
const TRON_NODE = env.TESTNET_TRON_NODE || 'https://nile.trongrid.io';
const FEE_LIMIT = 1_000_000_000; // TRON 每笔最多烧 1,000 TRX（测试币）
// TRON 整套部署的能量：本机私链 tronbox/tre（java-tron 4.8.2）2026-11-14 实测合计 1,872,265（实现合约 601,275、工厂 178,701、
// 批量合约 583,947、transferOwnership 22,250、测试 USDT 486,092），取 2,000,000；开始前按节点当前的能量单价 × 1.2 估算要多少 TRX，
// 不够就不开始（不会只部署一半）。Nile 上的实际用量以运行结果为准
const TRON_ENERGY_EST = 2_000_000;

const WALLETS = JSON.parse(readFileSync(join(ROOT, 'config/wallets.json'), 'utf8'));
const out = { generatedAt: new Date().toISOString(), commit: env.GITHUB_SHA || '', local: LOCAL, chains: {}, walletsStaging: {}, notes: [] };
const log = (...a) => console.log(...a);
const fail = (m) => { throw new Error(m); };
const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');

function key() {
  const k = String(env.TOPUP_TESTNET_DEPLOYER_KEY || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) fail('没有部署账户私钥：GitHub 环境 testnet 的密钥 TOPUP_TESTNET_DEPLOYER_KEY 没填，或不是 64 位十六进制');
  return k.toLowerCase();
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const isLocalHost = (u) => ['127.0.0.1', 'localhost', '::1'].includes(hostOf(u));

/** JSON-RPC（10 秒超时，连接错误和 429 / 5xx 退避重试 3 次）；地址里可能有 key，错误信息里不带地址 */
async function rpc(url, method, params = []) {
  let last;
  for (let i = 0; i <= 3; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      const j = await res.json();
      if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) {
      last = e;
      if (!(e.retry || e.name === 'TimeoutError' || e.cause) || i === 3) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw new Error(`节点请求失败（${method}）：${last?.message}`);
}

/**
 * forge script：私钥、参数都走环境变量（不进命令行参数）；返回 TOPUP_OUT 行里的地址。
 * 不加 -v：失败时 forge 的调用轨迹会把私钥按十进制整数打出来（vm.addr、startBroadcast 的参数），GitHub 只遮盖原样的密钥值。
 * 另外把输出里出现的私钥（十六进制、十进制）和节点地址（可能带 key）都换掉再显示。
 */
function forge(c, extraEnv, k) {
  const args = ['script', 'script/DeployTestnet.s.sol:DeployTestnet', '--rpc-url', c.rpc, '--broadcast', '--slow', ...(c.legacy ? ['--legacy'] : [])];
  const secrets = [k, BigInt('0x' + k).toString(10), ...(c.rpc && !isLocalHost(c.rpc) ? [c.rpc] : [])];
  return new Promise((resolve, reject) => {
    // 空着的参数不传（forge 的 vm.envOr 遇到空字符串会报解析错误，而不是用默认值）
    const childEnv = Object.fromEntries(Object.entries({ ...env, ...extraEnv, TOPUP_TESTNET_DEPLOYER_KEY: '0x' + k }).filter(([, v]) => v !== '' && v !== undefined));
    const p = spawn('forge', args, { cwd: join(ROOT, 'contracts'), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const mask = (s) => secrets.reduce((t, x) => t.split(x).join('<已遮盖>'), String(s).replace(/0x([0-9a-f]{64})/gi, (m, h) => (h.toLowerCase() === k ? '<已遮盖>' : m)));
    // 按行输出（一个值不会被切在两块数据之间漏掉遮盖）
    let buf = { out: '', err: '' };
    const feed = (which, d, w) => { buf[which] += d; const lines = buf[which].split('\n'); buf[which] = lines.pop(); for (const l of lines) { const m = mask(l); text += m + '\n'; w.write(m + '\n'); } };
    p.stdout.on('data', (d) => feed('out', d, process.stdout));
    p.stderr.on('data', (d) => feed('err', d, process.stderr));
    p.on('error', reject);
    p.on('close', (code) => {
      for (const [w, s] of [[process.stdout, buf.out], [process.stderr, buf.err]]) if (s) { const m = mask(s); text += m; w.write(m + '\n'); }
      if (code !== 0) return reject(new Error(`forge script 失败（退出码 ${code}），看上面的输出`));
      const got = {};
      for (const m of text.matchAll(/TOPUP_OUT (\w+) (\S+)/g)) got[m[1]] = m[2];
      resolve(got);
    });
  });
}

function broadcastTxs(chainId) {
  const f = join(ROOT, 'contracts/broadcast/DeployTestnet.s.sol', String(chainId), 'run-latest.json');
  if (!existsSync(f)) return [];
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return (j.transactions || []).map((t) => ({ hash: t.hash, type: t.transactionType, contract: t.contractName || null, address: t.contractAddress || null, fn: t.function || null }));
}

async function deployEvm(chain, k) {
  const c = EVM[chain];
  const parent = env.EVM_PARENT, operator = env.EVM_OPERATOR, owner = env.EVM_OWNER || parent;
  if (!isEvm(parent) || !isEvm(operator) || !isEvm(owner)) fail(`${c.name}：EVM_PARENT（冷钱包）、EVM_OPERATOR（发起账户）要填 0x 开头的地址`);
  if (env.PAYOUT_PAYER && !isEvm(env.PAYOUT_PAYER)) fail('PAYOUT_PAYER 要填 0x 开头的地址');
  if (env.PAYOUT_PAYER && !existsSync(join(ROOT, 'contracts/src/BatchPayout.sol'))) fail('填了 PAYOUT_PAYER，但这个提交里还没有 contracts/src/BatchPayout.sol（第 3 批合并之后再部署批量打款）');
  const id = Number(await rpc(c.rpc, 'eth_chainId'));
  if (id === 1 || id === 56) fail(`${c.name}：节点是主网（链 ID ${id}），拒绝`);
  const localOk = LOCAL && id === 31337 && isLocalHost(c.rpc);
  if (id !== c.chainId && !localOk) fail(`${c.name}：节点的链 ID 是 ${id}，应该是 ${c.chainId}`);
  log(`\n== ${c.name}（链 ID ${id}）`);
  const got = await forge(c, {
    SWEEP_PARENT: parent, SWEEP_OPERATOR: operator, SWEEP_OWNER: owner,
    SWEEP_EXPECT_NONCE: env.EVM_START_NONCE || '0', TESTNET_USDT: USDT ? '1' : '0', TESTNET_USDT_MINT: MINT,
    TESTNET_USDT_DECIMALS: chain === 'bsc' ? '18' : '6', PAYOUT_PAYER: env.PAYOUT_PAYER || '',
  }, k);
  for (const n of ['implementation', 'factory', 'batcher']) if (!isEvm(got[n])) fail(`${c.name}：forge 的输出里没有 ${n} 地址`);
  // 地址上确实有代码（forge 模拟出的地址和真正上链的一致）
  for (const n of ['implementation', 'factory', 'batcher', 'usdt', 'payout']) {
    if (got[n] && (await rpc(c.rpc, 'eth_getCode', [got[n], 'latest'])) === '0x') fail(`${c.name}：${n} ${got[n]} 上没有合约代码`);
  }
  const prev = WALLETS.staging?.evm?.[chain] || {};
  const section = {
    usdt: got.usdt || '', factory: got.factory, implementation: got.implementation, parent, batcher: got.batcher, ver: nextVer(prev, got.factory),
    ...(got.payout ? { hot: got.hot, payout: got.payout } : {}),
  };
  if (!section.usdt) out.notes.push(`${c.name} 没有部署测试 USDT，也没有官方测试 USDT：usdt 要另外填，否则这条链不开通`);
  out.chains[chain] = { name: c.name, chainId: id, explorer: localOk ? null : c.explorer, deployer: got.deployer, startNonce: Number(got.startNonce), operator, owner, ...got, txs: broadcastTxs(id) };
  out.walletsStaging.evm ||= {};
  out.walletsStaging.evm[chain] = section;
  await serverCheck(chain, section, { rpcUrl: c.rpc });
}

/** wallets.json 里已经有一套不同的地址时 ver 加 1（换参数要加版本号），否则沿用 */
function nextVer(prev, factory) {
  const v = Number(prev.ver) || 1;
  return prev.factory && String(prev.factory).toLowerCase() !== String(factory).toLowerCase() ? v + 1 : v;
}

async function deployTron(k) {
  const { compile } = await import('../tron-nile/compile.mjs');
  const { createNode, makeSigner } = await import('../tron-nile/tron-node.mjs');
  const { isTronAddress, forwarderAddress, hex20 } = await import('../../server/wallet/tron-create2.js');
  const { depositSalt } = await import('../../server/wallet/create2.js');
  const parent = env.TRON_PARENT, operator = env.TRON_OPERATOR, owner = env.TRON_OWNER || parent;
  if (![parent, operator, owner].every((a) => isTronAddress(a || ''))) fail('TRON：TRON_PARENT（冷钱包）、TRON_OPERATOR（发起账户）要填 T 开头的地址');
  const node = createNode({ base: TRON_NODE, apiKey: env.TRONGRID_API_KEY || '' }); // 只准 Nile 或本机
  const net = await node.checkNetwork(); // 主网直接拒绝
  if (net.network === 'local' && !LOCAL) fail('TRON：连的是本机私链，只有本机演练（TESTNET_LOCAL=1）才允许');
  log(`\n== TRON（${net.network}）`);
  const signer = makeSigner(k);
  if (signer.address === parent) fail('TRON：parent（冷钱包）不要用部署账户：部署账户的私钥在 GitHub 里');
  const params = Object.fromEntries(((await node.post('/wallet/getchainparameters', {})).chainParameter || []).map((x) => [x.key, x.value ?? 0]));
  const energyFee = Number(params.getEnergyFee || 420);
  const needSun = Math.ceil(TRON_ENERGY_EST * energyFee * 1.2) + 2_000_000;
  const bal = await node.balance(signer.address);
  log(`部署账户 ${signer.address}，余额 ${bal / 1e6} TRX；能量单价 ${energyFee} sun，估计要 ${Math.ceil(needSun / 1e6)} TRX`);
  if (bal < needSun) fail(`TRON：部署账户 ${signer.address} 只有 ${bal / 1e6} TRX，估计要 ${Math.ceil(needSun / 1e6)} TRX（Nile 水龙头领）`);

  const { compiler, artifacts } = await compile();
  const txs = [];
  const step = (name, r) => { txs.push({ name, txId: r.txId, address: r.address || null, energy: r.info?.receipt?.energy_usage_total ?? null }); log(`  ${name}：${r.address || r.txId}（能量 ${r.info?.receipt?.energy_usage_total ?? '?'}）`); return r; };
  const impl = step('ForwarderTron', await node.deploy(signer, { name: 'ForwarderTron', ...artifacts.ForwarderTron, feeLimit: FEE_LIMIT }));
  const factory = step('ForwarderFactoryTron', await node.deploy(signer, { name: 'ForwarderFactoryTron', ...artifacts.ForwarderFactoryTron, params: node.enc(['address'], [impl.address]), feeLimit: FEE_LIMIT }));
  const batcher = step('SweepBatcherTron', await node.deploy(signer, { name: 'SweepBatcherTron', ...artifacts.SweepBatcherTron, params: node.enc(['address', 'address', 'address'], [factory.address, parent, operator]), feeLimit: FEE_LIMIT }));
  const own = step('SweepBatcherTron.transferOwnership', await node.send(signer, batcher.address, 'transferOwnership(address)', ['address'], [owner], { feeLimit: FEE_LIMIT }));
  if (!own.ok) fail('TRON：transferOwnership 失败');
  let usdt = '';
  if (USDT) {
    // 小数 6 位、transfer 成功也返回 false（像 TRON 主网 USDT）；部署时给部署账户 TESTNET_USDT_MINT 个
    usdt = step('TestUSDT', await node.deploy(signer, { name: 'TestUSDT', ...artifacts.TestUSDT, params: node.enc(['uint256', 'uint256', 'address', 'uint256'], [6, 1, signer.address, MINT]), feeLimit: FEE_LIMIT })).address;
  } else {
    usdt = WALLETS.staging?.tron?.usdt || WALLETS.staging?.usdt || '';
    out.notes.push('TRON 没有部署测试 USDT：usdt 用 config/wallets.json 里 Nile 官方测试 USDT');
  }
  // 核对（只读调用）：发起账户已登记、所有者交给 owner（等 owner 接受）、用户 1 的充值地址和服务器算法一致
  const word = async (to, sig, types = [], values = []) => node.call(to, sig, types, values);
  const isOp = BigInt('0x' + (await word(batcher.address, 'isOperator(address)', ['address'], [operator]))) === 1n;
  const pending = (await word(batcher.address, 'pendingOwner()')).slice(-40).toLowerCase();
  if (!isOp) fail('TRON：发起账户没有登记');
  if (pending !== hex20(owner)) fail('TRON：所有者没有交给 owner');
  const salt = depositSalt(1);
  const onchain = (await word(batcher.address, 'forwarderAddress(bytes32)', ['bytes32'], [salt])).slice(-40).toLowerCase();
  const offline = forwarderAddress({ factory: factory.address, implementation: impl.address, parent, feeAddress: batcher.address, salt });
  if (onchain !== hex20(offline.tron)) fail(`TRON：用户 1 的充值地址链上 ${onchain} ≠ 服务器算法 ${offline.tron}`);
  log(`  核对：发起账户已登记、所有者等 owner 接受、用户 1 的充值地址 ${offline.tron} = 链上算出的`);
  const prev = WALLETS.staging?.tron || {};
  const section = { usdt, factory: factory.address, implementation: impl.address, parent, batcher: batcher.address, ver: nextVer(prev, factory.address) };
  out.chains.tron = { name: 'TRON', network: net.network, explorer: net.network === 'nile' ? 'https://nile.tronscan.org' : null, compiler, deployer: signer.address, operator, owner, energyFee, user1: offline.tron, txs, ...section };
  out.walletsStaging.tron = section;
  await serverCheck('tron', section, { tronNodeUrl: net.network === 'local' ? TRON_NODE : '' });
}

/** 用服务器自己的钱包层（和服务器启动时同一条路径）检查：配置格式通过、链上核对 ok、地址算法和合约一致 */
async function serverCheck(chain, section, { rpcUrl = '', tronNodeUrl = '' }) {
  const { createWalletLayer } = await import('../../server/wallet/index.js');
  const config = {
    appEnv: 'staging', fakeEvm: false, fakeTron: false, tronNetwork: 'nile', tronApiKey: env.TRONGRID_API_KEY || '', tronNodeUrl, tronConfirmations: 19,
    ethRpcUrl: chain === 'eth' ? rpcUrl : '', bscRpcUrl: chain === 'bsc' ? rpcUrl : '', ethConfirmations: 12, bscConfirmations: 15, sweepOperatorKey: '', sweepOperatorKeyTron: '',
  };
  const layer = createWalletLayer({ db: null, config, evm: chain === 'tron' ? {} : { [chain]: section }, tron: chain === 'tron' ? section : null });
  if (!layer.enabledChains.includes(chain)) fail(`${chain}：服务器的钱包层不开通这条链：${JSON.stringify(layer.errors)}`);
  await layer.verifyOnchain({ db: null, timeoutMs: 30_000 });
  const r = layer.onchain?.[chain];
  if (r?.result !== 'ok') fail(`${chain}：服务器的链上核对没有通过：${JSON.stringify(r)}`);
  if (chain !== 'tron') {
    const { depositSalt, forwarderAddress } = await import('../../server/wallet/create2.js');
    const { selector } = await import('../../server/wallet/evm-tx.js');
    const salt = depositSalt(1);
    const want = forwarderAddress({ factory: section.factory, implementation: section.implementation, parent: section.parent, feeAddress: section.batcher, salt });
    const got = await rpc(rpcUrl, 'eth_call', [{ to: section.batcher, data: '0x' + selector('forwarderAddress(bytes32)') + salt.slice(2) }, 'latest']);
    if (('0x' + got.slice(-40)).toLowerCase() !== want.toLowerCase()) fail(`${chain}：用户 1 的充值地址链上 ${got} ≠ 服务器算法 ${want}`);
    out.chains[chain].user1 = want;
  }
  out.chains[chain].serverCheck = 'ok';
  log(`  服务器钱包层核对（config/wallets.json 格式、链上 parent / factory / implementation、充值地址算法）：通过`);
}

function summary() {
  const lines = ['# 测试网合约部署结果', '', `提交 ${out.commit ? out.commit.slice(0, 7) : '本地'} · ${out.generatedAt}${out.local ? ' · 本机演练（不是测试网）' : ''}`, ''];
  lines.push('全部是公开地址。下一步：把下面这段填进 `config/wallets.json` 的 `staging`（只替换对应的链，其他字段不动），开 PR，由管理员自己合并。', '');
  lines.push('```json', JSON.stringify(out.walletsStaging, null, 2), '```', '');
  for (const [chain, c] of Object.entries(out.chains)) {
    lines.push(`## ${c.name}${c.chainId ? `（链 ID ${c.chainId}）` : c.network ? `（${c.network}）` : ''}`, '');
    lines.push(`- 部署账户 ${c.deployer}${c.startNonce !== undefined ? `（起始 nonce ${c.startNonce}）` : ''}`, `- 发起账户 ${c.operator}；所有者交给 ${c.owner}（等它调用 acceptOwnership 接受）`);
    lines.push(`- 用户 1 的充值地址 ${c.user1}；服务器钱包层核对：${c.serverCheck || '未通过'}`);
    const txs = (c.txs || []).map((t) => ({ ...t, label: t.contract && t.fn ? `${t.contract}.${t.fn.replace(/\(.*/, '')}` : t.contract || t.name || t.fn || 'tx' }));
    if (txs.length) lines.push(`- 交易（${txs.length} 笔）：${txs.map((t) => (c.explorer ? `[${t.label}](${c.explorer}/${chain === 'tron' ? '#/transaction' : 'tx'}/${(t.hash || t.txId || '').replace(/^0x/, chain === 'tron' ? '' : '0x')})` : `${t.label} ${t.hash || t.txId}`)).join('、')}`);
    lines.push('');
  }
  if (out.notes.length) lines.push('提醒：', ...out.notes.map((n) => `- ${n}`), '');
  lines.push('Safe / 冷钱包还要做的：用 owner 地址分别对 SweepBatcher（三条链）和 BatchPayout（如果部署了）调用 `acceptOwnership()`。不接受不影响归集（parent、发起账户已经写死在合约里），只影响以后增删发起账户。');
  return lines.join('\n') + '\n';
}

async function main() {
  const k = key();
  for (const c of CHAINS) if (!['eth', 'bsc', 'tron'].includes(c)) fail(`不认识的链：${c}（只能是 eth、bsc、tron）`);
  mkdirSync(OUT, { recursive: true });
  let error = null;
  try {
    for (const chain of CHAINS) if (chain === 'tron') await deployTron(k); else await deployEvm(chain, k);
  } catch (e) { error = e; }
  // 失败时也写出已经部署了的部分（公开信息），方便查和重新部署
  if (error) out.error = error.message;
  writeFileSync(join(OUT, 'deployment.json'), JSON.stringify(out, null, 2) + '\n');
  const md = summary() + (error ? `\n**失败**：${error.message}\n` : '');
  writeFileSync(join(OUT, 'summary.md'), md);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  if (error) { console.error(`\n失败：${error.message}`); process.exit(1); }
  log(`\n全部通过。结果在 ${join(OUT, 'deployment.json')}、${join(OUT, 'summary.md')}`);
}

main().catch((e) => { console.error(`失败：${e.message}`); process.exit(1); });
