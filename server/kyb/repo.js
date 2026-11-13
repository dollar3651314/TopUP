// 开户申请的数据仓库（Redis）。敏感内容全部放在 enc 字段里，写入前加密。
//   topup:app:<id>        申请记录（明文部分只有编号、状态、企业名称、时间等）
//   topup:apps            申请索引（按创建时间排序）
//   topup:tok:<HMAC>      客户令牌 → 申请 id，30 天后自动过期
//   topup:audit:<id>      操作记录（只追加，不记录字段内容）
//   topup:appseq:<年份>   编号计数器
import { randomBytes } from 'node:crypto';
import { encryptJson, decryptJson, newToken, hashToken } from './crypto.js';

export const LINK_TTL_DAYS = 30;
const DAY = 864e5;
export const RETENTION_UNAPPROVED_DAYS = 365;
export const RETENTION_AFTER_RELATIONSHIP_YEARS = 5;
const EDITABLE = new Set(['invited', 'in_progress', 'needs_info']);

export function createRepo({ redis, keys, now = () => Date.now() }) {
  const K = { app: (id) => `topup:app:${id}`, tok: (h) => `topup:tok:${h}`, audit: (id) => `topup:audit:${id}` };
  const iso = (t = now()) => new Date(t).toISOString();

  function retentionUntil(app) {
    if (app.status === 'approved') {
      if (!app.relationshipEndedAt) return null; // 业务关系存续期间一直保留
      const d = new Date(app.relationshipEndedAt); d.setFullYear(d.getFullYear() + RETENTION_AFTER_RELATIONSHIP_YEARS);
      return d.toISOString();
    }
    return new Date(Date.parse(app.createdAt) + RETENTION_UNAPPROVED_DAYS * DAY).toISOString();
  }
  function effectiveStatus(app) {
    if ((app.status === 'invited' || app.status === 'in_progress') && Date.parse(app.expiresAt) <= now()) return 'expired';
    return app.status;
  }
  async function write(app) {
    app.updatedAt = iso();
    app.retentionUntil = retentionUntil(app);
    await redis.set(K.app(app.id), JSON.stringify(app));
    return app;
  }
  async function issueToken(app) {
    if (app.tokHash) await redis.del(K.tok(app.tokHash)); // 旧链接立即失效
    const token = newToken();
    app.tokHash = hashToken(keys.token, token);
    app.expiresAt = iso(now() + LINK_TTL_DAYS * DAY);
    await redis.set(K.tok(app.tokHash), app.id, { ex: LINK_TTL_DAYS * 86400 });
    return token;
  }

  return {
    effectiveStatus,
    isEditable: (app) => EDITABLE.has(effectiveStatus(app)),

    async create({ company, email }) {
      const year = new Date(now()).getUTCFullYear();
      const n = await redis.incr(`topup:appseq:${year}`);
      const app = {
        id: randomBytes(9).toString('base64url'), ref: `TU-${year}-${String(n).padStart(4, '0')}`,
        status: 'invited', company: String(company).slice(0, 200),
        createdAt: iso(), invitedAt: iso(), submittedAt: null, decidedAt: null, relationshipEndedAt: null,
        unlocked: [], fileCount: 0,
        enc: encryptJson(keys.enc, { email, form: { v: 7 }, files: [], signature: null, review: {} }),
      };
      const token = await issueToken(app);
      await write(app);
      await redis.zadd('topup:apps', { score: Date.parse(app.createdAt), member: app.id });
      return { app, token };
    },
    async get(id) {
      const a = await redis.get(K.app(id));
      return a ? (typeof a === 'string' ? JSON.parse(a) : a) : null;
    },
    async byToken(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const id = await redis.get(K.tok(hashToken(keys.token, token)));
      if (!id) return null;
      const app = await this.get(String(id));
      if (!app || app.tokHash !== hashToken(keys.token, token)) return null;
      return app;
    },
    async list() {
      const ids = await redis.zrange('topup:apps', 0, -1, { rev: true });
      const apps = [];
      for (const id of ids) { const a = await this.get(id); if (a) apps.push(a); }
      return apps;
    },
    open: (app) => decryptJson(keys.enc, app.enc),
    async seal(app, payload) {
      app.enc = encryptJson(keys.enc, payload);
      app.fileCount = payload.files.length;
      return write(app);
    },
    save: write,
    reissueToken: async (app) => { const t = await issueToken(app); await write(app); return t; },
    async audit(id, actor, action, detail) {
      await redis.rpush(K.audit(id), JSON.stringify({ at: iso(), actor, action, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }));
    },
    async auditLog(id) { return (await redis.lrange(K.audit(id), 0, -1)).map((x) => (typeof x === 'string' ? JSON.parse(x) : x)); },
    async remove(app) {
      if (app.tokHash) await redis.del(K.tok(app.tokHash));
      await redis.del(K.app(app.id), K.audit(app.id));
      await redis.zrem('topup:apps', app.id);
    },
  };
}
