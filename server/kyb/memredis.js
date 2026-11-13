// 本地开发和测试用的 Redis 替身：实现本项目用到的少量命令，行为与 server/redis.js 对齐
// （包括"读取时自动把 JSON 字符串解析成对象"）。可选择把数据持久化到一个 JSON 文件，方便测试检查原始存储内容。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function createMemRedis({ file, now = () => Date.now() } = {}) {
  let db = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { kv: {}, exp: {}, z: {}, l: {}, s: {} };
  const persist = () => file && writeFileSync(file, JSON.stringify(db));
  const alive = (k) => { if (db.exp[k] && db.exp[k] <= now()) { delete db.kv[k]; delete db.exp[k]; } return k in db.kv; };
  const auto = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
  const ser = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  return {
    raw: () => db,
    async get(k) { return alive(k) ? auto(db.kv[k]) : null; },
    async set(k, v, opts = {}) {
      if (opts.nx && alive(k)) return null;
      db.kv[k] = ser(v);
      if (opts.ex) db.exp[k] = now() + opts.ex * 1000; else delete db.exp[k];
      persist(); return 'OK';
    },
    async del(...keys) { let n = 0; for (const k of keys.flat()) { for (const t of ['kv', 'z', 'l', 's']) if (k in db[t]) { delete db[t][k]; n++; } delete db.exp[k]; } persist(); return n; },
    async incr(k) { const v = Number(alive(k) ? db.kv[k] : 0) + 1; db.kv[k] = String(v); persist(); return v; },
    async expire(k, sec) { if (k in db.kv) { db.exp[k] = now() + sec * 1000; persist(); } return 1; },
    async zadd(k, { score, member }) { (db.z[k] ??= {})[member] = score; persist(); return 1; },
    async zrem(k, member) { if (db.z[k]) delete db.z[k][member]; persist(); return 1; },
    async zrange(k, start, stop, opts = {}) {
      const items = Object.entries(db.z[k] || {}).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
      if (opts.rev) items.reverse();
      return items.slice(start, stop === -1 ? undefined : stop + 1);
    },
    async rpush(k, ...vals) { (db.l[k] ??= []).push(...vals.map(ser)); persist(); return db.l[k].length; },
    async lrange(k, start, stop) { return (db.l[k] || []).slice(start, stop === -1 ? undefined : stop + 1).map(auto); },
    async sadd(k, ...m) { const s = new Set(db.s[k] || []); m.forEach((x) => s.add(x)); db.s[k] = [...s]; persist(); return 1; },
    async smembers(k) { return db.s[k] || []; },
  };
}
