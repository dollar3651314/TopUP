// 收付款的公共初始化：生产（api/_pay.js）和本地服务器共用。同一个函数实例内只初始化一次。
import { readFileSync } from 'node:fs';
import { createPgDb, createLiteDb } from './db.js';
import { migrate, backfillEmailHash } from './schema.js';
import { createTronGrid } from './trongrid.js';
import { createFakeTron } from './fake-trongrid.js';
import { derivePayKeys, emailHash } from './common.js';
import { createOps } from './ops.js';
import { createApiV1 } from './api-v1.js';
import { createMerchantApi } from './merchant-api.js';
import { createPayApi } from './pay-api.js';
import { createWalletApi, sweepProgress } from './wallet-api.js';
import { createAdminGate } from './admin-gate.js';
import { runTick } from './tick.js';
import { runDaily } from './daily.js';
import { decryptJson } from '../kyb/crypto.js';
import { createWalletLayer } from '../wallet/index.js';
import { scanEvm } from '../wallet/scan.js';
import { confirmSweeps, proposeDue } from '../wallet/sweep.js';
import { checkRentalBalance } from '../wallet/energy.js';
import { checkWalletsChange } from './wallets-change.js';

const WALLETS_RAW = readFileSync(new URL('../../config/wallets.json', import.meta.url), 'utf8');
const WALLETS = JSON.parse(WALLETS_RAW);
export const walletsFor = (appEnv) => WALLETS[appEnv === 'production' ? 'production' : appEnv === 'staging' ? 'staging' : 'local'];


/** config：loadConfig() 的结果；kyb：{ redis, keys }（管理员登录）；send：发邮件；origin：站点地址（邮件里的链接） */
export async function createPayDeps({ config, kyb, send, getIp, origin }) {
  const db = config.databaseUrl ? await createPgDb(config.databaseUrl) : await createLiteDb(config.localDbDir || undefined);
  await migrate(db);
  const tron = config.fakeTron ? createFakeTron({ network: config.tronNetwork }) : createTronGrid({ network: config.tronNetwork, apiKey: config.tronApiKey, usdt: config.usdtContract || undefined });
  const keys = derivePayKeys(config.appSecret);
  await backfillEmailHash(db, { decrypt: (s) => decryptJson(keys.enc, s), hash: (e) => emailHash(keys, e) });
  const keyPrefix = config.appEnv === 'production' ? 'topup_live_' : 'topup_test_';
  const wallets = walletsFor(config.appEnv);
  // 钱包层（ETH、BSC、TRON 合约钱包；cobo、fireblocks 未开通）。TRON 一节空着时不开通 TRON 合约钱包
  const layer = createWalletLayer({ db, config, evm: wallets.evm || {}, tron: wallets.tron || null });
  const ops = createOps({ db, keys, payBase: origin, keyPrefix, wallet: layer });
  const gate = createAdminGate({ redis: kyb.redis, kybKeys: kyb.keys });
  const notify = config.mailTo ? (subject, text) => send({ to: config.mailTo, subject: `[收付款] ${subject}`, text }).catch((e) => console.error(`[pay] mail: ${e.message}`)) : null;
  // 启动时用 eth_call 核对链上批量合约的 parent、factory 和配置一致；不一致的链不开通并告警（最多等 8 秒，连不上下一轮再核对）
  await layer.verifyOnchain({ db, notify }).catch((e) => console.error(`[wallet] onchain check: ${e.message}`));
  // config/wallets.json 和上次启动时不一样：发邮件（web、worker 同时启动也只发一封）
  await checkWalletsChange(db, { raw: WALLETS_RAW, appEnv: config.appEnv, section: wallets, notify }).catch((e) => console.error(`[pay] wallets.json check: ${e.message}`));
  const diskPath = config.blobDir || config.dataDir || '/'; // 用量提醒看这块磁盘
  const getTarget = async (merchantId) => {
    const [m] = await db.query('select callback_url, api_secret_enc from merchants where id = $1', [merchantId]);
    return m && m.callback_url && m.api_secret_enc ? { url: m.callback_url, secret: decryptJson(keys.enc, m.api_secret_enc) } : null;
  };
  const listApproved = kyb.listApproved || (async () => []);
  const pendingKyb = kyb.pendingKyb || (async () => 0);
  return {
    db, tron, keys, ops, wallets, layer,
    v1: createApiV1({ db, keys, ops, getIp, redis: kyb.redis }), // 限流计数和开户共用同一个 Redis
    merchant: createMerchantApi({ db, keys, ops, send }),
    pay: createPayApi({ db, layer, redis: kyb.redis, getIp }), // 按 IP 限流，和开放 API 共用 Redis
    wallet: createWalletApi({ db, tron, keys, wallets, send, origin, notify, layer, listApproved, pendingKyb, runDaily: () => runDaily({ db, tron, wallets, notify, diskPath }), diskPath, ...gate }),
    tick: () => runTick({
      db, tron, getTarget, notify, adminUrl: `${origin}/admin/`,
      scanEvm: () => scanEvm(db, { layer, notify }),
      // 归集：TRON 第 0 批的浏览器签名批次；ETH、BSC 合约钱包确认已发出的批次、到点凑批（东八区 10:00、20:00）
      confirmSweeps: async () => {
        const tronSweeps = await sweepProgress(db, tron, { notify });
        // 启动时节点连不上、还没核对过链上参数的链：每轮再核对一次
        if (Object.values(layer.onchain).some((x) => x.result === 'unverified')) await layer.verifyOnchain({ db, notify }).catch(() => {});
        const evm = await confirmSweeps(db, { providers: layer.providers, notify });
        const proposed = layer.enabledChains.length ? await proposeDue(db, { chains: layer.enabledChains, providers: layer.providers, notify, adminUrl: `${origin}/admin/` }) : null;
        return { tron: tronSweeps, evm, proposed };
      },
    }),
    daily: async () => {
      const out = await runDaily({ db, tron, wallets, notify, diskPath });
      // 租能量平台的预存余额每天查一次（超过 1,000 TRX 告警；没配不查）
      const rental = await checkRentalBalance(db, { renter: layer.tronEnergy, notify }).catch((e) => ({ status: 'error', error: e.message }));
      return out && typeof out === 'object' ? { ...out, energyRental: rental.status } : out;
    },
  };
}
