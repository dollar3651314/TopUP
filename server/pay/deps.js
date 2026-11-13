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

const WALLETS = JSON.parse(readFileSync(new URL('../../config/wallets.json', import.meta.url), 'utf8'));
export const walletsFor = (appEnv) => WALLETS[appEnv === 'production' ? 'production' : appEnv === 'staging' ? 'staging' : 'local'];

/** config：loadConfig() 的结果；kyb：{ redis, keys }（管理员登录）；send：发邮件；origin：站点地址（邮件里的链接） */
export async function createPayDeps({ config, kyb, send, getIp, origin }) {
  const db = config.databaseUrl ? await createPgDb(config.databaseUrl) : await createLiteDb(config.localDbDir || undefined);
  await migrate(db);
  const tron = config.fakeTron ? createFakeTron({ network: config.tronNetwork }) : createTronGrid({ network: config.tronNetwork, apiKey: config.tronApiKey, usdt: config.usdtContract || undefined });
  const keys = derivePayKeys(config.appSecret);
  await backfillEmailHash(db, { decrypt: (s) => decryptJson(keys.enc, s), hash: (e) => emailHash(keys, e) });
  const keyPrefix = config.appEnv === 'production' ? 'topup_live_' : 'topup_test_';
  const ops = createOps({ db, keys, payBase: origin, keyPrefix });
  const gate = createAdminGate({ redis: kyb.redis, kybKeys: kyb.keys });
  const notify = config.mailTo ? (subject, text) => send({ to: config.mailTo, subject: `[收付款] ${subject}`, text }).catch((e) => console.error(`[pay] mail: ${e.message}`)) : null;
  const wallets = walletsFor(config.appEnv);
  const diskPath = config.blobDir || config.dataDir || '/'; // 用量提醒看这块磁盘
  const getTarget = async (merchantId) => {
    const [m] = await db.query('select callback_url, api_secret_enc from merchants where id = $1', [merchantId]);
    return m && m.callback_url && m.api_secret_enc ? { url: m.callback_url, secret: decryptJson(keys.enc, m.api_secret_enc) } : null;
  };
  const listApproved = kyb.listApproved || (async () => []);
  const pendingKyb = kyb.pendingKyb || (async () => 0);
  return {
    db, tron, keys, ops, wallets,
    v1: createApiV1({ db, keys, ops, getIp, redis: kyb.redis }), // 限流计数和开户共用同一个 Redis
    merchant: createMerchantApi({ db, keys, ops, send }),
    pay: createPayApi({ db }),
    wallet: createWalletApi({ db, tron, keys, wallets, send, origin, notify, listApproved, pendingKyb, runDaily: () => runDaily({ db, tron, wallets, notify, diskPath }), diskPath, ...gate }),
    tick: () => runTick({ db, tron, getTarget, notify, adminUrl: `${origin}/admin/`, confirmSweeps: () => sweepProgress(db, tron, { notify }) }),
    daily: () => runDaily({ db, tron, wallets, notify, diskPath }),
  };
}
