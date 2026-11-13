// 审核后台的接口：/api/kyb/?g=admin&a=<动作>。除 setup-begin、setup-confirm、login、me 外，全部要求有效的会话。
import QRCode from 'qrcode';
import { json, readJson, actionOf, originOf } from './http.js';
import { encryptJson, decryptJson, safeEqual } from './crypto.js';
import { newTotpSecret, verifyTotp, totpStep, otpauthUrl } from './totp.js';
import { hashPassword, verifyPassword, makeSession, readSession, sessionCookie, SESSION_TTL_MS, LOCK_MAX, LOCK_MS } from './auth.js';
import { inviteEmail, needsInfoEmail, SECTION_LABELS } from './emails.js';
import { SECTIONS } from './schema.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAdminHandler({ repo, blobs, send, redis, keys, config, now = () => Date.now(), log = console }) {
  const getAdmin = async () => { const a = await redis.get('topup:admin'); return a ? (typeof a === 'string' ? JSON.parse(a) : a) : null; };
  const linkFor = (request, token) => `${originOf(request)}/onboarding/?t=${token}`;

  async function sendInvite(request, app, token) {
    const p = repo.open(app);
    const mail = inviteEmail({ company: app.company, ref: app.ref, link: linkFor(request, token), expiresAt: app.expiresAt });
    try { await send({ to: p.email, ...mail }); return true; }
    catch (e) { log.error(`[kyb] INVITE_FAILED ${app.ref}: ${e.message}`); await repo.audit(app.id, 'system', 'invite_email_failed'); return false; }
  }
  async function deleteApp(app) {
    const p = repo.open(app);
    const paths = [...p.files.map((f) => f.pathname), ...(p.signature?.pathname ? [p.signature.pathname] : [])];
    if (paths.length && blobs) await blobs.del(paths);
    await repo.remove(app);
  }
  const summary = (a) => ({ id: a.id, ref: a.ref, company: a.company, status: repo.effectiveStatus(a), updatedAt: a.updatedAt, createdAt: a.createdAt, submittedAt: a.submittedAt, expiresAt: a.expiresAt, retentionUntil: a.retentionUntil, fileCount: a.fileCount, flags: a.flags || {} });
  const need = async (request) => {
    const admin = await getAdmin();
    if (!admin || !readSession(keys.session, request.headers.get('cookie'), admin.version, now())) throw Object.assign(new Error('unauthorized'), { status: 401 });
    return admin;
  };
  const byId = async (id) => { const a = await repo.get(String(id || '')); if (!a) throw Object.assign(new Error('not_found'), { status: 404 }); return a; };

  const open = {
    async me(request) {
      const admin = await getAdmin();
      const authed = !!admin && !!readSession(keys.session, request.headers.get('cookie'), admin.version, now());
      return json(200, { initialized: !!admin, authed });
    },
    // 首次初始化第 1 步：校验初始化口令，设置密码，生成 TOTP 密钥（10 分钟内确认有效）
    async 'setup-begin'(request) {
      if (await getAdmin()) return json(409, { ok: false, error: 'already_initialized' });
      const { setupToken, password } = await readJson(request);
      if (!config.adminSetupToken || !safeEqual(setupToken || '', config.adminSetupToken)) return json(403, { ok: false, error: 'bad_setup_token' });
      if (typeof password !== 'string' || password.length < 12 || password.length > 200) return json(400, { ok: false, error: 'weak_password' });
      const secret = newTotpSecret();
      await redis.set('topup:admin:pending', JSON.stringify({ pw: hashPassword(password), totp: encryptJson(keys.enc, secret) }), { ex: 600 });
      const url = otpauthUrl(secret);
      return json(200, { ok: true, otpauth: url, secret, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
    },
    async 'setup-confirm'(request) {
      if (await getAdmin()) return json(409, { ok: false, error: 'already_initialized' });
      const { setupToken, code } = await readJson(request);
      if (!config.adminSetupToken || !safeEqual(setupToken || '', config.adminSetupToken)) return json(403, { ok: false, error: 'bad_setup_token' });
      const pending = await redis.get('topup:admin:pending');
      if (!pending) return json(400, { ok: false, error: 'expired' });
      const pd = typeof pending === 'string' ? JSON.parse(pending) : pending;
      if (!verifyTotp(decryptJson(keys.enc, pd.totp), code, now())) return json(400, { ok: false, error: 'bad_code' });
      await redis.set('topup:admin', JSON.stringify({ pw: pd.pw, totp: pd.totp, version: 1, createdAt: new Date(now()).toISOString() }));
      await redis.del('topup:admin:pending');
      return json(200, { ok: true });
    },
    // 登录：密码 + 动态码；连续失败 5 次锁定 15 分钟
    async login(request) {
      const admin = await getAdmin();
      if (!admin) return json(409, { ok: false, error: 'not_initialized' });
      const lockedUntil = Number(await redis.get('topup:admin:lock') || 0);
      if (lockedUntil > now()) return json(429, { ok: false, error: 'locked', retryAfter: Math.ceil((lockedUntil - now()) / 1000) });
      const { password, code } = await readJson(request);
      // 同一个动态码只能登录一次（时间步必须大于上次成功登录时的时间步）
      const step = typeof password === 'string' && verifyPassword(password, admin.pw) ? totpStep(decryptJson(keys.enc, admin.totp), code, now()) : -1;
      const ok = step >= 0 && step > Number(await redis.get('topup:admin:totp-last') || 0);
      if (!ok) {
        const n = await redis.incr('topup:admin:fails');
        await redis.expire('topup:admin:fails', LOCK_MS / 1000);
        if (n >= LOCK_MAX) { await redis.set('topup:admin:lock', String(now() + LOCK_MS), { ex: LOCK_MS / 1000 }); await redis.del('topup:admin:fails'); }
        return json(401, { ok: false, error: 'bad_credentials', remaining: Math.max(0, LOCK_MAX - n) });
      }
      await redis.del('topup:admin:fails');
      await redis.set('topup:admin:totp-last', String(step), { ex: 180 });
      return json(200, { ok: true }, { 'set-cookie': sessionCookie(makeSession(keys.session, admin.version, now()), SESSION_TTL_MS / 1000) });
    },
  };

  const secured = {
    // 退出登录：会话版本号加一，所有已签发的会话立即失效
    async logout(request, admin) {
      admin.version += 1;
      await redis.set('topup:admin', JSON.stringify(admin));
      return json(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
    },
    async apps() { return json(200, { apps: (await repo.list()).map(summary) }); },
    async app(request) {
      const a = await byId(new URL(request.url).searchParams.get('id'));
      const p = repo.open(a);
      return json(200, {
        app: { ...summary(a), invitedAt: a.invitedAt, decidedAt: a.decidedAt, relationshipEndedAt: a.relationshipEndedAt, unlocked: a.unlocked, email: p.email },
        form: p.form, files: p.files.map(({ id, doc, legacyDoc, person, name, size, type, uploadedAt }) => ({ id, doc, legacyDoc, person, name, size, type, uploadedAt })),
        signature: p.signature ? { signedAt: p.signature.signedAt, ip: p.signature.ip } : null, review: p.review, audit: await repo.auditLog(a.id),
      });
    },
    // 下载文件：经服务器从私有存储转发，不暴露存储地址
    async file(request) {
      const u = new URL(request.url);
      const a = await byId(u.searchParams.get('id'));
      const p = repo.open(a);
      const f = u.searchParams.get('sig') === '1' ? (p.signature && { pathname: p.signature.pathname, name: `${a.ref}-signature.png` }) : p.files.find((x) => x.id === u.searchParams.get('fileId'));
      if (!f) return json(404, { ok: false, error: 'not_found' });
      const r = await blobs.read(f.pathname);
      if (!r) return json(404, { ok: false, error: 'not_found' });
      const inline = u.searchParams.get('inline') === '1';
      return new Response(r.stream, { status: 200, headers: {
        'content-type': r.contentType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      } });
    },
    async invite(request) {
      const { company, email } = await readJson(request);
      if (typeof company !== 'string' || !company.trim() || company.length > 200) return json(400, { ok: false, error: 'validation', fields: { company: 'required' } });
      if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254) return json(400, { ok: false, error: 'validation', fields: { email: 'email' } });
      const { app, token } = await repo.create({ company: company.trim(), email: email.trim() });
      await repo.audit(app.id, 'admin', 'invited');
      const emailed = await sendInvite(request, app, token);
      return json(200, { ok: true, id: app.id, ref: app.ref, emailed });
    },
    async resend(request) {
      const { id } = await readJson(request);
      const a = await byId(id);
      if (!['invited', 'in_progress', 'expired', 'needs_info'].includes(repo.effectiveStatus(a))) return json(409, { ok: false, error: 'bad_state' });
      if (a.status === 'expired' || repo.effectiveStatus(a) === 'expired') a.status = 'invited';
      const token = await repo.reissueToken(a);
      await repo.audit(a.id, 'admin', 'link_resent');
      return json(200, { ok: true, emailed: await sendInvite(request, a, token) });
    },
    // 审核决定：通过 / 拒绝 / 要求补件
    async decide(request) {
      const { id, action, sections, message } = await readJson(request);
      const a = await byId(id);
      if (repo.effectiveStatus(a) !== 'submitted') return json(409, { ok: false, error: 'bad_state' });
      const p = repo.open(a);
      const today = new Date(now()).toISOString();
      if (action === 'approve' || action === 'reject') {
        a.status = action === 'approve' ? 'approved' : 'rejected';
        a.decidedAt = today;
        p.review.reviewer = '管理员'; p.review.reviewDate = today;
        await repo.seal(a, p);
        await repo.audit(a.id, 'admin', a.status);
        return json(200, { ok: true });
      }
      if (action === 'needs_info') {
        const secs = Array.isArray(sections) ? sections.filter((s) => SECTIONS.includes(s)) : [];
        if (!secs.length) return json(400, { ok: false, error: 'validation', fields: { sections: 'required' } });
        const msg = typeof message === 'string' ? message.slice(0, 2000) : '';
        a.status = 'needs_info';
        a.unlocked = secs;
        p.review.reviewer = '管理员'; p.review.reviewDate = today; p.review.lastRequest = { sections: secs, message: msg, at: today };
        await repo.seal(a, p);
        const token = await repo.reissueToken(a); // 补件邮件里附上新链接（旧链接失效），有效期重新计算为 30 天
        await repo.audit(a.id, 'admin', 'needs_info', secs.map((s) => SECTION_LABELS[s][1]).join('、'));
        let emailed = true;
        try { await send({ to: p.email, ...needsInfoEmail({ company: a.company, ref: a.ref, sections: secs, message: msg, link: linkFor(request, token) }) }); }
        catch (e) { emailed = false; log.error(`[kyb] NEEDS_INFO_EMAIL_FAILED ${a.ref}: ${e.message}`); }
        return json(200, { ok: true, emailed });
      }
      return json(400, { ok: false, error: 'invalid_action' });
    },
    async notes(request) {
      const { id, notes, relationshipEndedAt } = await readJson(request);
      const a = await byId(id);
      const p = repo.open(a);
      if (notes !== undefined) p.review.notes = String(notes).slice(0, 5000);
      if (relationshipEndedAt !== undefined) {
        if (relationshipEndedAt && !/^\d{4}-\d{2}-\d{2}$/.test(relationshipEndedAt)) return json(400, { ok: false, error: 'validation' });
        a.relationshipEndedAt = relationshipEndedAt || null;
      }
      await repo.seal(a, p);
      await repo.audit(a.id, 'admin', 'notes_updated');
      return json(200, { ok: true, retentionUntil: a.retentionUntil });
    },
    async delete(request) {
      const { id, confirmRef } = await readJson(request);
      const a = await byId(id);
      if (confirmRef !== a.ref) return json(400, { ok: false, error: 'confirm_mismatch' });
      await deleteApp(a);
      log.warn?.(`[kyb] application deleted by admin: ${a.ref}`);
      return json(200, { ok: true });
    },
  };
  const GETS = new Set(['me', 'apps', 'app', 'file']);

  const handle = async function handle(request) {
    const action = actionOf(request);
    const fn = Object.hasOwn(open, action) ? open[action] : Object.hasOwn(secured, action) ? secured[action] : null;
    if (!fn) return json(404, { ok: false, error: 'not_found' });
    if (GETS.has(action) ? request.method !== 'GET' : request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
    // 防跨站请求：写操作必须来自本站页面
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && origin !== originOf(request)) return json(403, { ok: false, error: 'bad_origin' });
    }
    try {
      if (Object.hasOwn(secured, action)) return await fn(request, await need(request));
      return await fn(request);
    } catch (err) {
      if (err.status) return json(err.status, { ok: false, error: err.message });
      log.error(`[kyb] admin ${action} failed: ${err.stack || err}`);
      return json(500, { ok: false, error: 'server_error' });
    }
  };
  // 接口入口文件（api/<分组>/<动作>.js）按这个列表逐个生成，测试会检查两边一致
  handle.actions = [...Object.keys(open), ...Object.keys(secured)];
  return handle;
}

/** 每日清理：删除超过保留期限的申请及其文件 */
export function createCleanup({ repo, blobs, now = () => Date.now(), log = console }) {
  return async function cleanup() {
    let deleted = 0;
    for (const a of await repo.list()) {
      if (a.retentionUntil && Date.parse(a.retentionUntil) <= now()) {
        const p = repo.open(a);
        const paths = [...p.files.map((f) => f.pathname), ...(p.signature?.pathname ? [p.signature.pathname] : [])];
        if (paths.length) await blobs.del(paths);
        await repo.remove(a);
        deleted++;
        log.warn?.(`[kyb] retention cleanup deleted ${a.ref}`);
      }
    }
    return { deleted };
  };
}
