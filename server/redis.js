// 自装 Redis 的客户端：对外的命令和 kyb/memredis.js（本地替身）完全一样，
// 包括"读取时自动把 JSON 字符串解析成对象、写入对象时自动转成 JSON"，业务代码不用区分是哪一个。
import Redis from 'ioredis';

const auto = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const ser = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

export function createRedis(url, { client } = {}) {
  const r = client || new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3, enableOfflineQueue: true });
  return {
    client: r,
    async get(k) { return auto(await r.get(k)); },
    async set(k, v, opts = {}) {
      const args = [k, ser(v)];
      if (opts.ex) args.push('EX', opts.ex);
      if (opts.nx) args.push('NX');
      return r.set(...args);
    },
    async del(...keys) { const ks = keys.flat(); return ks.length ? r.del(...ks) : 0; },
    async incr(k) { return r.incr(k); },
    async expire(k, sec) { return r.expire(k, sec); },
    async zadd(k, { score, member }) { return r.zadd(k, score, member); },
    async zrem(k, member) { return r.zrem(k, member); },
    async zrange(k, start, stop, opts = {}) { return opts.rev ? r.zrevrange(k, start, stop) : r.zrange(k, start, stop); },
    async rpush(k, ...vals) { return r.rpush(k, ...vals.map(ser)); },
    async lrange(k, start, stop) { return (await r.lrange(k, start, stop)).map(auto); },
    async sadd(k, ...m) { return r.sadd(k, ...m); },
    async smembers(k) { return r.smembers(k); },
    async ping() { return r.ping(); },
    async quit() { if (r.status !== 'ready') { r.disconnect(); return; } try { await r.quit(); } catch { r.disconnect(); } },
  };
}
