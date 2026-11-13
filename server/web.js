// web 进程：提供页面（site/dist）和全部接口。生产环境在 Nginx 后面运行（HTTPS 由 Nginx 负责），本地开发和端到端测试直接运行。
//  - 页面：带尾斜杠的目录地址、404.html、server/http-rules.json 里的响应头和改写规则
//  - 接口：/api/kyb/、/api/v1/、/api/merchant/、/api/pay/、/api/wallet/、/api/health/
//  - 访客 IP：TRUST_PROXY=1 时取 Nginx 写入的 X-Real-IP，否则取 TCP 连接的地址，访客都无法伪造
//  - 定时任务（扫链、回调、每日清理和对账）不在这里，在 worker 进程（server/worker.js）
// 用法：PORT=8080 DATA_DIR=./data node server/web.js
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createApp, initReason, refuseLocal, ROOT } from './app.js';
import { json } from './kyb/http.js';
import { walletChainStatus } from './wallet/status.js';

const getMetaSafe = async (db, key) => { try { const [r] = await db.query('select value from pay_meta where key = $1', [key]); return r ? r.value : null; } catch { return null; } };

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain' };

export const RULES = JSON.parse(readFileSync(join(ROOT, 'server/http-rules.json'), 'utf8'));
const headerRules = (RULES.headers || []).map((r) => ({ re: new RegExp('^' + r.source.replace(/\(\.\*\)/g, '.*') + '$'), headers: r.headers }));
// 页面的改写（"/pay/:id/" 写法）：地址不变，返回目标页面的内容。/api/ 下的改写由接口路由直接处理
const rewrites = (RULES.rewrites || []).filter((r) => !r.source.startsWith('/api/')).map((r) => ({ re: new RegExp('^' + r.source.replace(/:[a-z]+/g, '[^/]+') + '$'), to: r.destination }));
const rewrite = (path) => rewrites.find((r) => r.re.test(path))?.to || path;
export function headersFor(path) {
  const out = {};
  for (const r of headerRules) if (r.re.test(path)) for (const h of r.headers) out[h.key] = h.value;
  return out;
}

/** 生成 web 的请求处理函数（单元测试直接调用它，不用起端口）。handle(Request, { ip }) → Response */
export function createWeb(config, { site = resolve(process.env.SITE_DIR || join(ROOT, 'site/dist')) } = {}) {
  const getIp = (req) => req.headers.get('x-real-ip') || '';
  const appPromise = createApp(config, { getIp });
  appPromise.catch((err) => console.error(`[web] init failed: ${err.missing ? err.message : err.code || err.message}`));
  const reason = (err) => (config.appEnv === 'production' ? undefined : err.missing ? 'not_configured' : initReason(err));
  const app = async () => appPromise;
  const pay = async () => (await appPromise).pay;

  async function kyb(request, g) {
    let a;
    try { a = await app(); } catch { return json(503, { ok: false, error: 'not_configured' }); }
    const h = g === 'admin' ? a.kyb.admin : g === 'onboarding' ? a.kyb.onboarding : null;
    return h ? h(request) : json(404, { ok: false, error: 'not_found' });
  }
  async function payRoute(name, request) {
    let d;
    try { d = await pay(); } catch (err) {
      const r = reason(err);
      return json(503, { error: { code: 'not_configured', ...(r && r !== 'not_configured' ? { reason: r } : {}) } });
    }
    return d[name](request);
  }
  async function health() {
    const c = config;
    const commit = (process.env.GIT_COMMIT || '').slice(0, 7); // 当前部署的提交（前 7 位，仓库是公开的，不算敏感信息）
    if (c.appEnv === 'local') return json(200, { ok: true, env: c.appEnv, commit, local: true });
    // 只返回是否已配置，不返回值
    const storage = Boolean(c.redisUrl);
    const db = Boolean(c.databaseUrl);
    const secret = c.appSecret.length >= 32;
    const blob = Boolean(c.blobDir);
    const mail = Boolean(c.mailFrom && c.mailTo && (c.resendApiKey || c.smtp.host));
    const mailMode = c.resendApiKey ? 'resend' : c.smtp.host ? 'smtp' : 'none';
    const payInfo = { tron: c.tronNetwork, trongridKey: Boolean(c.tronApiKey) };
    // worker 最近一次扫链距今的秒数（超过 5 分钟说明 worker 没在运行）；只用来告警，不影响 ok
    let worker = { age_s: null, ok: false };
    let ready = false;
    try {
      const d = await pay(); ready = true;
      const [r] = await d.db.query(`select value from pay_meta where key = 'tick_last'`);
      const age = r ? Math.round((Date.now() - Date.parse(r.value.at)) / 1000) : null;
      worker = { age_s: age, ok: age !== null && age <= 300 };
    } catch (err) { if (ready) worker.error = 'query_failed'; else if (reason(err)) payInfo.reason = reason(err); }
    // 钱包（ETH、BSC 每条链的扫块、合约地址配没配齐，只给是否）：单独显示，不进整体 ok
    let wallet = null;
    if (ready) {
      try {
        const d = await pay();
        wallet = { chains: [] };
        for (const chain of ['eth', 'bsc', 'tron']) {
          const cc = d.layer?.config?.[chain];
          const scan = chain === 'tron' ? null : await getMetaSafe(d.db, `evm_scan_${chain}`);
          wallet.chains.push(walletChainStatus(chain === 'tron' ? { chain, enabled: false } : {
            chain, rpcConfigured: Boolean(cc?.rpcUrl), usdtConfigured: Boolean(cc?.usdt), scheme: cc?.scheme || {},
            cursor: scan?.cursor ?? null, head: scan?.head ?? null, confirmations: cc?.confirmations ?? 0, lastScanAt: scan?.at ?? null,
            onchain: d.layer?.onchain?.[chain]?.result ?? null,
          }));
        }
        wallet.operator = Boolean(c.sweepOperatorKey);
      } catch { wallet = { error: 'query_failed' }; }
    }
    const ok = storage && db && secret && blob && mail && payInfo.trongridKey && ready;
    return json(ok ? 200 : 503, { ok, env: c.appEnv, commit, storage, db, mail, mailMode, secret, blob, pay: payInfo, worker, ...(wallet ? { wallet } : {}) });
  }
  async function fake(path, request) {
    const d = await pay();
    const body = request.method === 'POST' ? JSON.parse((await request.text()) || '{}') : {};
    if (path === '/__fake/tron/pay/') return Response.json(d.tron.pay({ to: body.to, amount: Number(body.amount), time: body.time ? Number(body.time) : Date.now() }));
    if (path === '/__fake/tron/account/') { d.tron.accounts.set(body.address, body.account); return Response.json({ ok: true }); }
    if (path === '/__fake/tron/confirm-all/') { for (const b of d.tron.broadcasts) if (!d.tron.txs.get(b.txId)?.ok) d.tron.confirm(b.txId, body.ok !== false); return Response.json({ ok: true, n: d.tron.broadcasts.length }); }
    if (path === '/__fake/evm/pay/') {
      const ad = d.layer?.adapters?.[body.chain];
      if (!ad?.fake) return Response.json({ error: 'chain_not_enabled' }, { status: 409 });
      return Response.json(ad.pay({ to: body.to, amount: Number(body.amount), time: body.time ? Number(body.time) : Date.now() }));
    }
    if (path === '/__fake/tick/') return Response.json(await d.tick());
    if (path === '/__fake/daily/') return Response.json(await d.daily());
    if (path === '/__fake/cleanup/') return Response.json({ ok: true, ...(await (await app()).kyb.cleanup()) });
    if (path === '/__fake/sql/' && process.env.FAKE_SQL === '1') return Response.json(await d.db.query(body.sql, body.params || []));
    return null;
  }

  async function handle(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    // trailingSlash：没有尾斜杠、也没有扩展名的地址，一律 308 跳转到带斜杠的地址（包括 /api）
    if (!path.endsWith('/') && !extname(path)) return new Response(null, { status: 308, headers: { location: path + '/' + url.search } });
    // 开户接口只有 /api/kyb/?g=<分组>&a=<动作> 一个入口
    if (path === '/api/kyb/') return kyb(request, url.searchParams.get('g'));
    if (path.startsWith('/api/v1/')) return payRoute('v1', request);
    if (path === '/api/merchant/') return payRoute('merchant', request);
    if (path === '/api/pay/') return payRoute('pay', request);
    if (path === '/api/wallet/') return payRoute('wallet', request);
    if (path === '/api/health/') return health();
    // 只在本地、使用 TronGrid 替身时存在：端到端测试用它"模拟"链上发生的事、代替 worker 立即跑一次任务
    if (path.startsWith('/__fake/') && config.fakeTron) { const r = await fake(path, request); if (r) return r; }
    if (path.startsWith('/api/')) return new Response('NOT_FOUND', { status: 404 });

    let file = join(site, rewrite(path));
    // 只能读页面目录里面的文件：按"目录 + 分隔符"判断，名字以页面目录开头的相邻目录（例如 dist-old）也不行
    const rel = relative(site, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (existsSync(file) && statSync(file).isFile()) return new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
    const nf = join(site, '404.html');
    return new Response(existsSync(nf) ? readFileSync(nf) : 'Not found', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  return {
    app: appPromise,
    async handle(request) {
      const path = new URL(request.url).pathname;
      let res;
      try { res = await handle(request); } catch (err) { console.error(err); res = new Response(null, { status: 500 }); }
      const extra = headersFor(path);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(extra)) if (!headers.has(k)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    },
  };
}

async function toRequest(req, trustProxy) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  if (!trustProxy) {
    // 不在 Nginx 后面时，这几个请求头由访客自己填写，不能相信
    for (const k of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) headers.delete(k);
    headers.set('x-real-ip', req.socket.remoteAddress.replace(/^::ffff:/, ''));
  }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
  return new Request(`http://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers, body });
}

export function startWeb(config = loadConfig()) {
  const refused = refuseLocal(config);
  if (refused) { console.error(`[web] ${refused}`); process.exit(1); }
  const web = createWeb(config);
  const server = http.createServer(async (req, res) => {
    try {
      const response = await web.handle(await toRequest(req, config.trustProxy));
      const headers = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      res.writeHead(500).end();
    }
  });
  server.listen(config.port, config.host, () => console.log(`[web] http://${config.host}:${config.port} (${config.appEnv})`));
  const stop = async () => { server.close(); try { await (await web.app).close(); } catch {} process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) startWeb();
