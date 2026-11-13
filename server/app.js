// web 和 worker 两个进程共用的初始化：按配置组装存储、开户、收付款的依赖。
//   - 生产和测试环境（APP_ENV=production / staging）：自装 Redis（REDIS_URL）、Postgres（DATABASE_URL）、
//     服务器本地目录保存开户文件（BLOB_DIR，加密），缺一项就安全失败（接口返回 503，不泄露配置值）。
//   - 本地（APP_ENV=local）：Redis 用本地替身、数据库用内嵌 Postgres、链上用 TronGrid 替身，不需要任何外部服务。
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRawSender } from './mailer.js';
import { createMemRedis } from './kyb/memredis.js';
import { createRedis } from './redis.js';
import { deriveKeys } from './kyb/crypto.js';
import { createRepo } from './kyb/repo.js';
import { createLocalBlobs } from './kyb/blobs.js';
import { createOnboardingHandler } from './kyb/onboarding.js';
import { createAdminHandler, createCleanup } from './kyb/admin.js';
import { createPayDeps } from './pay/deps.js';
import { approvedFromKyb, pendingKybCount } from './pay/kyb-link.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_SECRET = 'local-dev-secret-local-dev-secret-0123456789';

/** 生产和测试环境必须配置的变量（只返回变量名，不返回值） */
export function missingConfig(config) {
  if (config.appEnv === 'local') return [];
  const miss = [];
  if (!config.redisUrl) miss.push('REDIS_URL');
  if (!config.databaseUrl) miss.push('DATABASE_URL');
  if (config.appSecret.length < 32) miss.push('APP_SECRET');
  if (!config.blobDir) miss.push('BLOB_DIR');
  if (!config.publicUrl) miss.push('PUBLIC_URL');
  return miss;
}

/** 镜像里（NODE_ENV=production）不允许以本地模式运行：本地模式有测试用的入口、开发用的主密钥。返回错误说明或 null */
export function refuseLocal(config) {
  return config.nodeEnv === 'production' && config.appEnv === 'local' ? 'NODE_ENV=production 时不能以 APP_ENV=local 运行，请设置 APP_ENV=production 或 staging' : null;
}

/** 本地运行时的默认值：数据目录、内嵌数据库、开发用主密钥 */
export function withLocalDefaults(config) {
  if (config.appEnv !== 'local') return config;
  const dataDir = config.dataDir || join(ROOT, 'data');
  return {
    ...config,
    dataDir,
    appSecret: config.appSecret || LOCAL_SECRET,
    blobDir: config.blobDir || join(dataDir, 'blobs'),
    localDbDir: config.databaseUrl ? '' : config.localDbDir || join(dataDir, 'paydb'),
    publicUrl: config.publicUrl || `http://127.0.0.1:${config.port}`,
  };
}

/**
 * 组装全部依赖。返回 { config, redis, kyb: { onboarding, admin, cleanup }, pay: Promise<payDeps>, close() }。
 * 配置不全时抛出错误（err.missing 是缺少的变量名）。
 */
export async function createApp(rawConfig, { getIp = () => '' } = {}) {
  const miss = missingConfig(rawConfig);
  if (miss.length) throw Object.assign(new Error(`not configured: ${miss.join(', ')}`), { missing: miss });
  const config = withLocalDefaults(rawConfig);
  const redis = config.redisUrl ? createRedis(config.redisUrl) : createMemRedis({ file: join(config.dataDir, 'kyb-redis.json') });
  const keys = deriveKeys(config.appSecret);
  const blobs = createLocalBlobs(config.blobDir, { key: keys.enc });
  const repo = createRepo({ redis, keys });
  const send = createRawSender(config);
  const kyb = {
    onboarding: createOnboardingHandler({ repo, blobs, send, config, getIp }),
    admin: createAdminHandler({ repo, blobs, send, redis, keys, config }),
    cleanup: createCleanup({ repo, blobs }),
  };
  const pay = createPayDeps({
    config, kyb: { redis, keys, listApproved: approvedFromKyb(repo), pendingKyb: pendingKybCount(repo) }, send, getIp, origin: config.publicUrl,
  });
  pay.catch(() => {}); // 由使用方处理（接口返回 503）
  return {
    config, redis, keys, blobs, repo, kyb, pay,
    async close() {
      try { await (await pay).db.end?.(); } catch {}
      await redis.quit?.();
    },
  };
}

/** 初始化失败的类别（只是类别，不含任何配置值），测试环境的接口和健康检查里返回，方便排查 */
export function initReason(err) {
  const m = String(err?.message || '');
  if (/not configured/.test(m)) return undefined;
  if (err?.code === '28P01') return 'db_auth';                        // 密码错误
  if (err?.code === '3D000') return 'db_name';                        // 数据库名错误
  if (err instanceof TypeError && /url/i.test(m)) return 'db_url_invalid'; // 连接串格式错误（例如密码里有 @ # / ? 等字符没有转义）
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(err?.code)) return 'db_host';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'ECONNRESET'].includes(err?.code)) return 'db_unreachable';
  if (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return `db_${err.code}`;
  return 'init_failed';
}
