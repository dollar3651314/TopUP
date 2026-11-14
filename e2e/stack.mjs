// 端到端测试的本地环境：模拟 SMTP 服务器 + 几个 web 进程（server/web.js，和生产同一份代码：
// 提供静态文件、按 server/http-rules.json 输出响应头、用 TCP 连接的地址写入 x-real-ip，/api 使用与生产相同的处理）
// 端口：8080 主实例、8090 原型构建、8092 测试环境构建、8094 收付款（独立的数据和后台账号）、8096 钱包第 1 批页面（独立）、8098 批量打款和第 2 批 TRON 页面（独立）、
//   8100 测试环境构建 + 收付款接口（看测试环境才有的东西，例如区块浏览器链到测试网；独立的数据和后台账号）、2525 SMTP
// 收付款实例的数据库默认是内嵌 Postgres；设置 E2E_DATABASE_URL 时改用真实 Postgres（和生产同一个驱动 postgres.js）
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const TMP = resolve(HERE, '.tmp');
export const MAILS = resolve(TMP, 'mails.jsonl');
export const DATA_MAIN = resolve(TMP, 'data-main');
export const DATA_PROTO = resolve(TMP, 'data-prototype');
export const PROTO_DIST = resolve(TMP, 'proto-dist');
// 测试环境（APP_ENV=staging）的构建，放在 8092 端口
export const STAGING_DIST = resolve(TMP, 'staging-dist');
export const DATA_STG = resolve(TMP, 'data-staging');
// 收付款端到端测试用的实例（内嵌 Postgres + TronGrid 替身），放在 8094 端口
export const DATA_PAY = resolve(TMP, 'data-pay');
export const PAY_ENV = { FAKE_TRON: '1', FAKE_SQL: '1' };
// 钱包第 1 批页面（以太坊、BSC 合约钱包）端到端测试用的实例，放在 8096 端口：独立的数据和后台账号，一个用例失败不影响收付款用例
export const DATA_WALLET = resolve(TMP, 'data-wallet');
// 批量打款（第 3 批）和第 2 批 TRON 页面的端到端实例，放在 8098 端口：独立的数据和后台账号
export const DATA_PAYOUT = resolve(TMP, 'data-payout');
// 测试环境构建（STAGING_DIST）+ 收付款接口，放在 8100 端口：服务器照样是本地模式（替身链），只有页面是测试环境构建
export const DATA_STG_PAYOUT = resolve(TMP, 'data-staging-payout');
// 开户（KYB）测试用的密钥：只用于本地测试
export const KYB_ENV = { APP_SECRET: 'e2e-app-secret-e2e-app-secret-0123456789ab', ADMIN_SETUP_TOKEN: 'e2e-setup-token' };
const children = [];

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

/** 启动一个 node 进程（web 或 worker），输出写到 .tmp/<name>.log */
export function startNode(script, name, env) {
  const p = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: {
      ...process.env, APP_ENV: 'local',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: '0', RESEND_API_KEY: '',
      MAIL_FROM: 'TopUP <no-reply@example.test>', MAIL_TO: 'sales@example.test',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = resolve(TMP, `${name}.log`);
  p.stdout.on('data', (d) => appendFileSync(log, d));
  p.stderr.on('data', (d) => appendFileSync(log, d));
  children.push(p);
  return p;
}
const startWeb = (port, dataDir, extraEnv = {}) => startNode('server/web.js', `web-${port}`, { PORT: String(port), DATA_DIR: dataDir, ...extraEnv });

export async function start() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        appendFileSync(MAILS, JSON.stringify({ to: session.envelope.rcptTo.map((r) => r.address), raw }) + '\n');
        cb();
      });
    },
  });
  await new Promise((r) => smtp.listen(2525, '127.0.0.1', r));

  startWeb(8080, DATA_MAIN, KYB_ENV);

  // 原型构建（PROTOTYPE=1），放在 8090 端口
  execFileSync(process.execPath, [resolve(ROOT, 'site/node_modules/astro/bin/astro.mjs'), 'build', '--outDir', PROTO_DIST],
    { cwd: resolve(ROOT, 'site'), env: { ...process.env, PROTOTYPE: '1' }, stdio: 'pipe' });
  startWeb(8090, DATA_PROTO, { SITE_DIR: PROTO_DIST });
  // 测试环境构建（页面带"测试环境"标识）；服务器用本地模式，接口照常可用
  execFileSync(process.execPath, [resolve(ROOT, 'site/node_modules/astro/bin/astro.mjs'), 'build', '--outDir', STAGING_DIST],
    { cwd: resolve(ROOT, 'site'), env: { ...process.env, APP_ENV: 'staging' }, stdio: 'pipe' });
  startWeb(8092, DATA_STG, { SITE_DIR: STAGING_DIST, ...KYB_ENV });

  startWeb(8094, DATA_PAY, { ...KYB_ENV, ...PAY_ENV, ...(process.env.E2E_DATABASE_URL ? { DATABASE_URL: process.env.E2E_DATABASE_URL } : {}) });

  startWeb(8096, DATA_WALLET, { ...KYB_ENV, ...PAY_ENV }); // 内嵌 Postgres
  startWeb(8098, DATA_PAYOUT, { ...KYB_ENV, ...PAY_ENV }); // 内嵌 Postgres
  startWeb(8100, DATA_STG_PAYOUT, { SITE_DIR: STAGING_DIST, ...KYB_ENV, ...PAY_ENV }); // 内嵌 Postgres

  await Promise.all([8080, 8090, 8092, 8094, 8096, 8098, 8100].map((p) => waitFor(`http://127.0.0.1:${p}/api/health/`)));
  return async () => {
    for (const c of children) c.kill('SIGTERM');
    await new Promise((r) => smtp.close(r));
  };
}

// 解码邮件正文里的 quoted-printable（=3D、软换行）
export const decodeQP = (raw) => Buffer.from(raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');

export const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
