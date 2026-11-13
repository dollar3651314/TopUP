// 用 TRON 官方编译器（tron-solidity 0.8.20，wasm 版）编译 Nile 验证要部署的合约。
// 编译器从 TRON 官方的 solc-bin 下载，sha256 写死在下面，对不上就拒绝使用。下载后缓存在 contracts/out-tron/（不进仓库）。
// 编译参数和以太坊版一致：0.8.20、paris、优化器 1000 次。BitGo 源码用 contracts/lib/ 下原样保存的文件，一行不改。
// 第 2 批另编 TRON 派生版合约（contracts/src/tron/：ForwarderTron、ForwarderFactoryTron、SweepBatcherTron）和测试代币 TronUsdtMock
// （contracts/test-tron/TronMocks.sol，transfer 成功也返回 false，像 TRON 主网 USDT）；私链端到端（test/tron-local/）部署这几个。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const CONTRACTS = join(ROOT, 'contracts');
const CACHE = join(CONTRACTS, 'out-tron');

export const COMPILER = {
  version: '0.8.20+commit.5f1834b',
  url: 'https://tronprotocol.github.io/solc-bin/wasm/soljson-v0.8.20+commit.5f1834b.js',
  sha256: '3842487fd8c7752e9aa21aeafa12172523b8d37b83b65c34c40c51f4fe8ba58c',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function compilerPath({ timeoutMs = 120_000 } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const p = join(CACHE, `soljson-${COMPILER.version}.cjs`);
  if (existsSync(p) && sha256(readFileSync(p)) === COMPILER.sha256) return p;
  const res = await fetch(COMPILER.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`compiler download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== COMPILER.sha256) throw new Error(`compiler sha256 mismatch: ${got}`);
  writeFileSync(p, buf);
  return p;
}

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (n.endsWith('.sol')) out.push(p);
  }
  return out;
}

/** 标准 JSON 输入：BitGo（bitgo/…）、OpenZeppelin（@openzeppelin/contracts/…）、验证合约 */
function sources() {
  const s = {};
  const add = (base, prefix) => { for (const f of walk(base)) s[prefix + relative(base, f).split('\\').join('/')] = { content: readFileSync(f, 'utf8') }; };
  add(join(CONTRACTS, 'lib', 'eth-multisig-v4', 'contracts'), 'bitgo/');
  add(join(CONTRACTS, 'lib', 'openzeppelin-contracts', 'contracts'), '@openzeppelin/contracts/');
  s['tron-nile/NileProbe.sol'] = { content: readFileSync(join(CONTRACTS, 'script', 'tron-nile', 'NileProbe.sol'), 'utf8') };
  // TRON 派生版：按仓库里的相对路径放（SweepBatcherTron 用 ../SweepBatcher.sol 引用以太坊版里的接口）
  for (const f of ['src/SweepBatcher.sol', 'src/tron/ForwarderTron.sol', 'src/tron/ForwarderFactoryTron.sol', 'src/tron/SweepBatcherTron.sol', 'test-tron/TronMocks.sol']) {
    s[f] = { content: readFileSync(join(CONTRACTS, ...f.split('/')), 'utf8') };
  }
  return s;
}

const WANT = {
  ForwarderV4: 'bitgo/ForwarderV4.sol',
  ForwarderFactoryV4: 'bitgo/ForwarderFactoryV4.sol',
  NileProbe: 'tron-nile/NileProbe.sol',
  NileTestToken: 'tron-nile/NileProbe.sol',
  ForwarderTron: 'src/tron/ForwarderTron.sol',
  ForwarderFactoryTron: 'src/tron/ForwarderFactoryTron.sol',
  SweepBatcherTron: 'src/tron/SweepBatcherTron.sol',
  TronUsdtMock: 'test-tron/TronMocks.sol',
};

/** 编译，返回 { compiler, artifacts: { 名字: { abi, bytecode, bytecodeSha256 } } } */
export async function compile() {
  const require = createRequire(import.meta.url);
  const soljson = require(await compilerPath());
  const solc = soljson.cwrap('solidity_compile', 'string', ['string', 'number', 'number']);
  const input = {
    language: 'Solidity',
    sources: sources(),
    settings: {
      optimizer: { enabled: true, runs: 1000 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc(JSON.stringify(input), 0, 0));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error('compile failed:\n' + errors.map((e) => e.formattedMessage).join('\n'));
  const artifacts = {};
  for (const [name, file] of Object.entries(WANT)) {
    const c = out.contracts?.[file]?.[name];
    if (!c?.evm?.bytecode?.object) throw new Error(`missing artifact ${name}`);
    const bytecode = c.evm.bytecode.object;
    artifacts[name] = { abi: c.abi, bytecode, bytecodeSha256: sha256(Buffer.from(bytecode, 'hex')) };
  }
  return { compiler: COMPILER.version, artifacts };
}
