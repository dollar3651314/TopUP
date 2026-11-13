// 回调发送：签名、重试、只允许 https 且不能指向内网。
// 签名：hex( HMAC-SHA256( 商户的 API Secret, 时间戳 + "\n" + 原始请求体 ) )
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { money } from './common.js';

/** 第 1 次立即发送；失败后在第 1 次发送之后的 1 分钟、5 分钟、30 分钟、2 小时、6 小时、12 小时、24 小时重试，然后停止（F5：从第 1 次发送算起，一共 24 小时） */
export const RETRY_MIN = [1, 5, 30, 120, 360, 720, 1440];

export const signCallback = (secret, ts, body) => createHmac('sha256', secret).update(`${ts}\n${body}`).digest('hex');

const PRIVATE_V4 = [['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['0.0.0.0', 8], ['100.64.0.0', 10], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const v4num = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
/** IPv6 → 8 个 16 位整数；格式不对返回 null。支持 :: 缩写和末尾的 IPv4 写法（::ffff:127.0.0.1） */
function v6parts(s) {
  let str = s.toLowerCase().replace(/%.*$/, '');
  const m = str.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { if (isIP(m[2]) !== 4) return null; const n = v4num(m[2]); str = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8 || all.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => parseInt(x, 16));
}
const v4of = (hi, lo) => [hi >>> 8, hi & 255, lo >>> 8, lo & 255].join('.');
export function isPrivateIp(ip) {
  if (isIP(ip) === 4) return PRIVATE_V4.some(([base, bits]) => (v4num(ip) >>> (32 - bits)) === (v4num(base) >>> (32 - bits)));
  const p = v6parts(ip);
  if (!p) return true; // 看不懂的地址一律当作内网
  const zero = (a, b) => p.slice(a, b).every((x) => x === 0);
  // 内嵌 IPv4 的各种写法都取出 IPv4 再判断（[::ffff:7f00:1] 这种十六进制写法也要拦住）
  if (zero(0, 5) && (p[5] === 0xffff || p[5] === 0)) return p[5] === 0 && p[6] === 0 && p[7] <= 1 ? true : isPrivateIp(v4of(p[6], p[7])); // ::ffff:a.b.c.d、::a.b.c.d、::、::1
  if (p[0] === 0x64 && p[1] === 0xff9b && zero(2, 6)) return isPrivateIp(v4of(p[6], p[7])); // NAT64
  if (p[0] === 0x2002) return isPrivateIp(v4of(p[1], p[2])); // 6to4
  return (p[0] & 0xfe00) === 0xfc00 || (p[0] & 0xffc0) === 0xfe80 || (p[0] & 0xff00) === 0xff00; // 唯一本地、链路本地、组播
}

/**
 * 发送回调用的请求：连接时再检查一次解析出来的地址（防止检查时解析到公网、真正连接时解析到内网的 DNS 重绑定）。
 * 不跟随跳转。返回 { status }
 */
export function pinnedFetch(url, { method = 'POST', headers = {}, body = '', signal } = {}, resolve = (h) => lookup(h, { all: true })) {
  return new Promise((done, fail) => {
    const checked = (host, opts, cb) => {
      resolve(host).then((list) => {
        if (!list.length || list.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error('private_address'), { code: 'EPRIVATE' }));
        if (opts && opts.all) return cb(null, list.map((a) => ({ address: a.address, family: a.family || isIP(a.address) })));
        cb(null, list[0].address, list[0].family || isIP(list[0].address));
      }, cb);
    };
    const req = httpsRequest(url, { method, headers, signal, lookup: checked }, (res) => { res.resume(); done({ status: res.statusCode }); });
    req.on('error', fail);
    req.end(body);
  });
}
/** 回调地址检查：https、没有账号密码、域名解析出来的地址都不是内网（防止借我们的服务器访问内网） */
export async function checkCallbackUrl(raw, resolve = (h) => lookup(h, { all: true })) {
  let u;
  try { u = new URL(raw); } catch { return 'invalid_url'; }
  if (u.protocol !== 'https:') return 'https_required';
  if (u.username || u.password) return 'invalid_url';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await resolve(host).catch(() => [])).map((x) => x.address);
  if (!ips.length) return 'unresolvable';
  if (ips.some(isPrivateIp)) return 'private_address';
  return null;
}

/**
 * 发送到期的回调。getSecret(merchantId) 返回 { url, secret }。
 * 每次最多发送 limit 条，并发 concurrency 条，每条最多等 timeoutMs。
 */
export async function deliverDue(db, { getTarget, fetchImpl = pinnedFetch, resolve, now = new Date(), limit = 50, concurrency = 10, timeoutMs = 5000 }) {
  const due = await db.query(`select * from callbacks where status = 'pending' and next_at <= $1 order by next_at limit $2`, [now, limit]);
  let ok = 0, failed = 0;
  const one = async (cb) => {
    const target = await getTarget(cb.merchant_id);
    let code = null, good = false;
    if (target?.url && target.secret && !(await checkCallbackUrl(target.url, resolve))) {
      // 金额和开放 API 的返回一样用字符串（例如 "500.00"）；数据库里存的是整数（0.000001 USDT）
      const body = JSON.stringify(money(cb.payload));
      const ts = String(Math.floor(now.getTime() / 1000));
      try {
        const res = await fetchImpl(target.url, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), body,
          headers: { 'content-type': 'application/json', 'user-agent': 'TopUP-Callback/1', 'X-TopUP-Event-Id': cb.id, 'X-TopUP-Timestamp': ts, 'X-TopUP-Signature': signCallback(target.secret, ts, body) },
        });
        code = res.status; good = res.status >= 200 && res.status < 300;
      } catch { code = null; }
    }
    const attempts = cb.attempts + 1;
    if (good) { ok++; await db.query(`update callbacks set status = 'ok', attempts = $2, last_code = $3 where id = $1`, [cb.id, attempts, code]); return; }
    // 两次重试之间的间隔 = 这一次和上一次的时间点之差，合计正好 24 小时
    const delay = RETRY_MIN[attempts - 1] === undefined ? undefined : RETRY_MIN[attempts - 1] - (RETRY_MIN[attempts - 2] ?? 0);
    if (delay === undefined) { failed++; await db.query(`update callbacks set status = 'failed', attempts = $2, last_code = $3 where id = $1`, [cb.id, attempts, code]); return; }
    await db.query(`update callbacks set attempts = $2, last_code = $3, next_at = $4 where id = $1`, [cb.id, attempts, code, new Date(now.getTime() + delay * 60_000)]);
  };
  for (let i = 0; i < due.length; i += concurrency) await Promise.all(due.slice(i, i + concurrency).map(one));
  return { sent: due.length, ok, failed };
}

/** 手动重发：重新排到最前面，重试次数清零 */
export async function resend(db, merchantId, id) {
  const r = await db.query(`update callbacks set status = 'pending', attempts = 0, next_at = now() where id = $1 and ($2::text is null or merchant_id = $2) returning id`, [id, merchantId]);
  return r.length > 0;
}
