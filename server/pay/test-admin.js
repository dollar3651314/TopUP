// 测试管理员（只在测试环境 APP_ENV=staging）：给自动化验收用例（.github/workflows/staging-e2e.yml）在测试环境跑运营后台的接口，不用管理员输动态码。
//   - 凭据：一个随机的"测试令牌"。服务器上只存它的 SHA-256（.env 的 TEST_ADMIN_TOKEN_SHA256，由 sudo topup gen-test-admin 生成），
//     令牌原文只在生成时在终端上显示一次，由管理员填进 GitHub 环境 staging-e2e 的密钥；服务器、仓库、日志里都没有原文。
//   - 用法：请求头 X-TopUP-Test-Admin: <令牌>，只认 /api/wallet/（运营后台的收付款接口）；开户审核后台（/api/kyb/）不认，看不到开户资料。
//   - 只能调用下面白名单里的动作（没列的一律 403，新加的动作默认不给）；签名、交签名、改授权额度、改钱包设置（归集门槛、提供方）、
//     确认作废、开通商户（会给任意邮箱发信）都不在里面。要动态码的动作（改打款上限）对测试管理员免动态码。
//   - 审计：业务动作的 actor 记成 test-admin；另外每个 POST 再记一条 test_admin.request（动作名、成功或错误码）。
//   - 生产（APP_ENV=production）配了 TEST_ADMIN_TOKEN_SHA256：web、worker 拒绝启动（server/app.js 的 refuseConfig）；本地忽略。
//   - 只在测试网开：APP_ENV=staging 且 TRON_NETWORK=nile；配了以太坊 / BSC 节点的，节点的链 ID 要在测试网白名单里（TESTNET_CHAIN_IDS），查不到时这次不认（server/pay/deps.js）。
//     TRON 节点本身是不是 Nile 没有另外核对（只看 TRON_NETWORK）。
//   - 开户和商户资料：商户列表（merchants，含联系人邮箱和待开通的开户申请）、客户列表和客户详情（customers、customer，含客户姓名）不在白名单；
//     其余返回里的商户名（merchant）、名称（name，链名除外）、邮箱（email）、公司名（company）一律打码成"首字 + ***"（maskForTestAdmin）；
//     任何字段里邮箱形式的内容（例如商户拿邮箱当客户编号、驳回原因里写了邮箱）也打码成"首字***"（不留 @）。
//   - 改东西的动作只收 POST（GET 调改东西的动作 405）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';

export const TEST_ADMIN_HEADER = 'x-topup-test-admin';
export const TEST_ADMIN_ACTOR = 'test-admin';
export const TEST_ADMIN_ENV = 'TEST_ADMIN_TOKEN_SHA256';

/** 测试管理员能调用的运营后台动作（/api/wallet/?a=…）。只读的和"到待签名为止"的操作；签名、钱包设置不在里面 */
export const TEST_ADMIN_ACTIONS = Object.freeze(new Set([
  // 只读（merchants、customers、customer 不给：里面是开户联系人邮箱、开户申请、客户姓名）
  'status', 'withdrawals', 'batches', 'anomalies', 'recon', 'overview', 'overview-chain', 'wallet',
  'sweep-list', 'payout-overview', 'payout-plans', 'payout-tx-batch', 'payout-limits', 'payout-wallets',
  'wallet-chains', 'wallet-sweep', 'wallet-sweep-addresses', 'wallet-sweep-batches', 'wallet-sweep-batch', 'wallet-sweep-settings', 'wallet-routes',
  // 打款：审核、驳回、挂起解除、凑批到"待签名"、作废没签名的批次、改上限（测试币）
  'payout-approve', 'payout-review', 'payout-reject-approved', 'withdraw-reject', 'payout-unhold', 'payout-plan', 'payout-resume', 'payout-void',
  'withdraw-plan', 'payout-limits-save',
  // 归集：凑批、确认（服务器上的测试网发起账户发出，钱只进冷钱包）、作废；老 TRON 地址的归集只到"待签名"
  'wallet-sweep-propose', 'wallet-sweep-approve', 'wallet-sweep-cancel', 'sweep-plan',
  // 对账、异常到账
  'recon-run', 'anomaly-handle',
]));

/** 白名单里改东西的动作：只收 POST */
export const TEST_ADMIN_WRITES = Object.freeze(new Set([
  'payout-approve', 'payout-review', 'payout-reject-approved', 'withdraw-reject', 'payout-unhold', 'payout-plan', 'payout-resume', 'payout-void',
  'withdraw-plan', 'payout-limits-save', 'wallet-sweep-propose', 'wallet-sweep-approve', 'wallet-sweep-cancel', 'sweep-plan', 'recon-run', 'anomaly-handle',
]));

const HEX64 = /^[0-9a-f]{64}$/;
const MASK_KEYS = new Set(['merchant', 'email', 'company', 'name']);
const mask = (v) => (typeof v === 'string' && v ? `${[...v][0]}***` : v);
// 邮箱形式的内容（客户编号、驳回原因等自由文本里都可能有）：不管字段名，一律打码成"首字***"（不留 @）
// 也认 %40（网址编码）和全角＠；两边限长（本地部分最多 64、域名部分最多 255），没有 @ 的字符串直接原样返回：
// payout-plan 之类的返回里有很长的交易原文（十六进制），不能让正则在上面来回回溯拖住 web 进程。
// 这只是兜底，不是完整的个人信息清洗（电话、地址、姓名这类不按内容识别）
const AT_LIKE = /@|＠|%40/i;
const EMAIL_LIKE = /[^\s@＠%"'<>(),;:]{1,64}(?:@|＠|%40)[^\s@＠%"'<>(),;:]{1,255}/giu;
const scrubEmail = (v) => (AT_LIKE.test(v) ? v.replace(EMAIL_LIKE, (m) => `${[...m][0]}***`) : v);
/**
 * 测试管理员拿到的返回：商户名、名称（链名除外）、邮箱、公司名打码；其余字符串里邮箱形式的内容也打码（customer_id、reason 这类自由文本，
 * 按字段名列不全，所以按内容兜底）；别的原样
 */
export function maskForTestAdmin(x) {
  if (typeof x === 'string') return scrubEmail(x);
  if (Array.isArray(x)) return x.map(maskForTestAdmin);
  if (!x || typeof x !== 'object') return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (MASK_KEYS.has(k) && typeof v === 'string' && !(k === 'name' && (v === x.chain || ['eth', 'bsc', 'tron'].includes(v)))) out[k] = mask(v);
    else out[k] = maskForTestAdmin(v);
  }
  return out;
}
const sha256 = (s) => createHash('sha256').update(String(s)).digest();

/** 这个环境的测试管理员是否开着：只有测试环境、配了 64 位十六进制的哈希才开 */
export function testAdminHash(config) {
  const h = String(config?.testAdminTokenSha256 || '').toLowerCase();
  return config?.appEnv === 'staging' && config?.tronNetwork === 'nile' && HEX64.test(h) ? h : '';
}

/** 认可的以太坊 / BSC 测试网链 ID：Sepolia、Holesky、Hoodi、BSC 测试网。配的节点不在里面（主网或别的链）就不认测试管理员 */
export const TESTNET_CHAIN_IDS = Object.freeze([11155111, 17000, 560048, 97]);
/**
 * 核对配了的以太坊 / BSC 节点都是认可的测试网（白名单，不是"不是主网"）。都核对过返回 true；不在白名单返回 false 并记住；
 * 节点查不到返回 false（这次不认），下次再查。adapters：{ eth?, bsc? }，每个有 chainId()
 */
export function createTestnetCheck(adapters = {}) {
  let result = null;
  return async () => {
    if (result !== null) return result;
    for (const a of Object.values(adapters)) {
      if (!a || typeof a.chainId !== 'function') continue;
      let id;
      try { id = Number(await a.chainId()); } catch { return false; }
      if (!Number.isFinite(id)) return false;
      if (!TESTNET_CHAIN_IDS.includes(id)) { result = false; console.error('[test-admin] EVM node is not a known testnet, test admin disabled'); return false; }
    }
    result = true;
    return true;
  };
}

/** 生产配了测试管理员变量：返回拒绝启动的说明（只有变量名，没有值）；否则 null */
export function refuseTestAdmin(config) {
  return config?.appEnv === 'production' && String(config?.testAdminTokenSha256 || '') !== ''
    ? `生产环境不能有测试管理员：.env 里有 ${TEST_ADMIN_ENV}，删掉这一行再启动（sudo topup gen-test-admin 只在测试环境用）`
    : null;
}

/** 请求头里的令牌对不对（按 SHA-256 定长比较）。没带这个请求头返回 null；带了但不对返回 false */
export function matchTestAdmin(request, hash) {
  const got = request.headers.get(TEST_ADMIN_HEADER);
  if (got === null) return null;
  if (!hash || !got) return false;
  return timingSafeEqual(sha256(got.trim()), Buffer.from(hash, 'hex'));
}

// 当前请求是不是测试管理员发起的（要动态码的动作据此免动态码；只在白名单动作里生效）
const store = new AsyncLocalStorage();
export const asTestAdmin = (fn) => store.run({ testAdmin: true }, fn);
export const isTestAdmin = () => store.getStore()?.testAdmin === true;
