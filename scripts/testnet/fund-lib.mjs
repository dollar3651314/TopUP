// 测试网充值工具（.github/workflows/testnet-fund.yml）共用的检查：只认测试网、只认 staging 的测试 USDT、数量和金额上限、地址格式。
// 用途：归集手续费对比验收（每条链 N 个新充值地址、每个打 100 个测试 USDT）不用人工一笔笔转账。说明见同目录 README.md 第 5 节。
// 这里只有纯函数（不连网络、不读密钥），单元测试 test/testnet-fund.test.js。
import { isChecksumAddress } from '../../server/wallet/evm-payout-codec.js';
import { isTronAddress } from '../../server/wallet/tron-create2.js';
import { refuseMainnet } from './evm-send.mjs';

/** 一次运行每条链最多几个地址 */
export const FUND_MAX_ADDRESSES = 50;
/** 每个地址最多打多少个测试 USDT */
export const FUND_MAX_AMOUNT = 1000;
export const FUND_CHAINS = ['eth', 'tron'];

/**
 * 允许的链和代币（写死，和 config/wallets.json 的 staging 一节对照）：
 * 以太坊只认 Sepolia（链 ID 11155111），TRON 只认 Nile；代币只认 staging 部署的测试 USDT（谁都能铸造，没有真实价值）。
 * config/wallets.json 里 staging 的测试 USDT 换了，要同时改这里（不会默默跟着配置走）。
 */
export const FUND_TARGETS = {
  eth: { name: '以太坊 Sepolia', chainId: 11155111, token: '0x7cED3d4efa3e4cfb8d8812716E9f08554a29500e', decimals: 6, explorer: 'https://sepolia.etherscan.io', txPath: 'tx/' },
  tron: { name: 'TRON Nile', network: 'nile', token: 'TRRciutGz3Ht2jCvKAqV3a7Qb1TUvdLdAr', decimals: 6, explorer: 'https://nile.tronscan.org', txPath: '#/transaction/' },
};

/** 主网 USDT（以太坊、BSC、TRON）：不管配置怎么写都拒绝 */
export const MAINNET_USDT = ['0xdac17f958d2ee523a2206206994597c13d831ec7', '0x55d398326f99059ff775485246999027b3197955', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'];

const lower = (a) => String(a || '').toLowerCase();
const sameAddr = (chain, a, b) => (chain === 'eth' ? lower(a) === lower(b) : String(a) === String(b));
const fail = (m) => { throw new Error(m); };

/** 以太坊节点的链 ID：主网（1、56）拒绝，不是 Sepolia 也拒绝 */
export function checkEvmChainId(chainId) {
  refuseMainnet(chainId);
  if (Number(chainId) !== FUND_TARGETS.eth.chainId) fail(`节点的链 ID 是 ${Number(chainId)}，不是 Sepolia（${FUND_TARGETS.eth.chainId}）：测试网充值只准 Sepolia`);
}

/** TRON 节点：只准 Nile（tron-node.mjs 的 checkNetwork 已拒绝主网；这里连本机私链也不准） */
export function checkTronNetwork(net) {
  if (net?.network !== FUND_TARGETS.tron.network) fail(`TRON 节点不是 Nile（${net?.network || '未知'}）：测试网充值只准 Nile`);
}

/** 这条链用哪个代币：config/wallets.json staging 一节里的地址，必须和写死的测试 USDT 一样，且不是主网 USDT */
export function tokenFor(chain, wallets) {
  const t = FUND_TARGETS[chain] || fail(`不认识的链：${chain}（只能是 ${FUND_CHAINS.join('、')}）`);
  const configured = chain === 'eth' ? wallets?.staging?.evm?.eth?.usdt : wallets?.staging?.tron?.usdt;
  if (!configured) fail(`${t.name}：config/wallets.json 的 staging 一节没有测试 USDT 地址`);
  if (MAINNET_USDT.some((m) => lower(m) === lower(configured))) fail(`${t.name}：${configured} 是主网 USDT，拒绝`);
  if (!sameAddr(chain, configured, t.token)) fail(`${t.name}：config/wallets.json staging 的 USDT ${configured} 不是允许的测试 USDT ${t.token}（换了测试币要同时改 scripts/testnet/fund-lib.mjs）`);
  return t.token;
}

/**
 * config/wallets.json staging 一节里这条链的系统地址（热钱包、冷钱包、parent、payout、batcher、factory、implementation、usdt）：
 * 都不能当收款地址（打进去会被当成系统资金，或打乱余额、对账）
 */
export function stagingSystemAddresses(wallets, chain) {
  const st = wallets?.staging || {};
  const KEYS = ['hot', 'cold', 'parent', 'payout', 'batcher', 'factory', 'implementation', 'usdt'];
  const pick = (o) => KEYS.map((k) => o?.[k]).filter((v) => typeof v === 'string' && v);
  const list = chain === 'eth' ? pick(st.evm?.eth) : chain === 'tron' ? [...pick(st), ...pick(st.tron)] : [];
  return [...new Set(list.filter((a) => isValidAddress(chain, a)))];
}

/** 链清单（逗号或空白分隔）→ 去重后的数组；只认 eth、tron */
export function parseChains(text) {
  const list = [...new Set(String(text ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
  if (!list.length) fail('没有指定链（eth、tron）');
  for (const c of list) if (!FUND_CHAINS.includes(c)) fail(`不认识的链：${c}（只能是 ${FUND_CHAINS.join('、')}）`);
  return list;
}

/** 每条链几个地址：1～50 的整数 */
export function parseCount(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,3}$/.test(s)) fail(`地址个数要填 1～${FUND_MAX_ADDRESSES} 的整数（现在是 "${s.slice(0, 20)}"）`);
  const n = Number(s);
  if (n < 1 || n > FUND_MAX_ADDRESSES) fail(`地址个数 ${n} 超出范围：每条链 1～${FUND_MAX_ADDRESSES} 个`);
  return n;
}

/** 每个地址打多少个测试 USDT：大于 0、不超过 1000、最多 6 位小数 → { text, units（最小单位，BigInt） } */
export function parseAmount(v, decimals = 6) {
  const s = String(v ?? '').trim();
  const m = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) fail(`金额要填正数、最多 6 位小数（现在是 "${s.slice(0, 20)}"）`);
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] || '').padEnd(decimals, '0').slice(0, decimals) || '0');
  if (units <= 0n) fail('金额要大于 0');
  if (units > BigInt(FUND_MAX_AMOUNT) * 10n ** BigInt(decimals)) fail(`金额 ${s} 超过每个地址最多 ${FUND_MAX_AMOUNT} 个`);
  return { text: fmtUnits(units, decimals), units };
}

/** 最小单位 → 十进制文字（去掉多余的 0） */
export function fmtUnits(units, decimals = 6) {
  const base = 10n ** BigInt(decimals);
  const u = BigInt(units);
  const frac = (u % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${u / base}${frac ? `.${frac}` : ''}`;
}

/** 地址格式：以太坊 0x + 40 位（大小写混合时校验和必须对），不能是零地址；TRON 是 T 开头、校验和对 */
export function isValidAddress(chain, a) {
  if (chain === 'eth') return isChecksumAddress(a) && !/^0x0{40}$/i.test(a);
  if (chain === 'tron') return isTronAddress(a);
  return false;
}

/** 运行编号 → 只留数字、小写字母和横线（客户标识里用） */
export const runTag = (s) => String(s || '').toLowerCase().replace(/[^0-9a-z-]/g, '').replace(/^-+|-+$/g, '').slice(0, 40) || 'local';

/** 客户标识：fee-ac3-<链>-<运行编号>-<两位序号> */
export const customerIdFor = (chain, run, i) => `fee-ac3-${chain}-${runTag(run)}-${String(i).padStart(2, '0')}`;
const CUSTOMER_ID_RE = /^(?:fee-ac3-(eth|tron)-[0-9a-z-]{1,40}-\d{2}|manual-\d{2})$/;

/**
 * 核对要打币的清单（第 1 步的输出，或手动填的地址）：
 * { chains: { eth: { amount: '100', items: [{ customer_id, address }] }, tron: {...} } }
 * exclude：每条链不能打的地址（部署账户自己、代币合约）。返回规范后的清单（amountUnits 是最小单位）
 */
export function validatePlan(plan, { exclude = {} } = {}) {
  if (!plan || typeof plan !== 'object' || !plan.chains || typeof plan.chains !== 'object') fail('清单格式不对：要有 chains');
  const chains = Object.keys(plan.chains);
  if (!chains.length) fail('清单里没有链');
  const out = { run: runTag(plan.run), chains: {} };
  for (const chain of chains) {
    const t = FUND_TARGETS[chain] || fail(`清单里有不认识的链：${chain}`);
    const p = plan.chains[chain] || {};
    const { text, units } = parseAmount(p.amount, t.decimals);
    if (!Array.isArray(p.items) || !p.items.length) fail(`${t.name}：清单里没有地址`);
    if (p.items.length > FUND_MAX_ADDRESSES) fail(`${t.name}：清单里有 ${p.items.length} 个地址，超过一次最多 ${FUND_MAX_ADDRESSES} 个`);
    const banned = [t.token, ...MAINNET_USDT, ...(exclude[chain] || [])].filter(Boolean);
    const seenAddr = new Set(), seenId = new Set();
    const items = p.items.map((it, i) => {
      const where = `${t.name} 第 ${i + 1} 个`;
      const id = String(it?.customer_id ?? '');
      const addr = String(it?.address ?? '').trim();
      if (!CUSTOMER_ID_RE.test(id)) fail(`${where}：客户标识格式不对（要 fee-ac3-<链>-<运行编号>-<序号> 或 manual-<序号>）`);
      const idChain = CUSTOMER_ID_RE.exec(id)[1];
      if (idChain && idChain !== chain) fail(`${where}：客户标识 ${id} 不是这条链的`);
      if (!isValidAddress(chain, addr)) fail(`${where}（${id}）：地址格式不对`);
      if (banned.some((b) => sameAddr(chain, b, addr))) fail(`${where}（${id}）：${addr} 是代币合约、部署账户或 staging 的系统地址，不能打`);
      const key = chain === 'eth' ? lower(addr) : addr;
      if (seenAddr.has(key)) fail(`${where}（${id}）：地址 ${addr} 重复`);
      if (seenId.has(id)) fail(`${where}：客户标识 ${id} 重复`);
      seenAddr.add(key); seenId.add(id);
      return { customer_id: id, address: addr };
    });
    out.chains[chain] = { amount: text, amountUnits: units, items };
  }
  return out;
}

/** 手动填的地址（空白或逗号分隔，只有一条链）→ 清单；客户标识 manual-01、manual-02… */
export function planFromList(chain, text, amount, run = '') {
  const addrs = String(text ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return { run, chains: { [chain]: { amount: String(amount), items: addrs.map((address, i) => ({ customer_id: `manual-${String(i + 1).padStart(2, '0')}`, address })) } } };
}

/** ERC-20 transfer(to, amount) 的 calldata */
export function erc20TransferData(to, units) {
  return '0xa9059cbb' + lower(to).replace(/^0x/, '').padStart(64, '0') + BigInt(units).toString(16).padStart(64, '0');
}
/** ERC-20 balanceOf(addr) 的 calldata */
export const erc20BalanceOfData = (addr) => '0x70a08231' + lower(addr).replace(/^0x/, '').padStart(64, '0');

/**
 * 遮盖表：私钥（十六进制、十进制）、节点地址（可能带 key，另把路径和参数里 8 位以上的每一段单独遮盖）、TronGrid key、测试环境地址、商户 Secret。
 * 写日志、错误、运行摘要和产物之前整段过一遍（GitHub 只遮盖原样的密钥值）
 */
export function secretList({ key = '', urls = [], values = [] } = {}) {
  const list = [];
  const k = String(key || '').replace(/^0x/, '');
  if (/^[0-9a-fA-F]{64}$/.test(k)) list.push(k, k.toLowerCase(), BigInt('0x' + k).toString(10));
  for (const u of urls) {
    if (!u) continue;
    list.push(String(u));
    for (const part of String(u).split(/[/?&=#:@]+/)) if (part.length >= 8 && !/^(https?|localhost)$/i.test(part) && !/\.(com|io|org|net|xyz|dev)$/i.test(part)) list.push(part);
  }
  for (const v of values) if (v) list.push(String(v));
  return [...new Set(list.map(String).filter((x) => x.length >= 6))].sort((a, b) => b.length - a.length);
}
export function maskWith(list) {
  return (text) => { let t = String(text); for (const x of list) t = t.split(x).join('<已遮盖>'); return t; };
}

/** 交易链接 */
export const txLink = (chain, id) => (id ? `${FUND_TARGETS[chain].explorer}/${FUND_TARGETS[chain].txPath}${String(id).replace(chain === 'tron' ? /^0x/ : /^$/, '')}` : '');
