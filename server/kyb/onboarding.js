// 客户填写页面的接口：/api/kyb/?g=onboarding&a=<动作>，全部凭链接里的令牌（请求头 x-kyb-token）访问本人申请。
import { randomBytes } from 'node:crypto';
import { json, readJson, actionOf, originOf } from './http.js';
import { validateSection, validateForSubmit, DOC_IDS, FILE_TYPES, MAX_FILE_BYTES, SECTIONS, MAX_COMPANY_FILES, MAX_ID_FILES, docSection, upgradeToV7, mapUnlocked, keepLegacy } from './schema.js';
import { adminNotifyEmail } from './emails.js';

const SIG_MAX = 300 * 1024; // 签名图片（PNG data URL）上限

export function createOnboardingHandler({ repo, blobs, send, config, now = () => Date.now(), waitUntil = (p) => p, log = console, getIp = () => '' }) {
  // 旧版补件开放的步骤名（contact、rep、docs）换成新步骤名
  const editableSections = (app) => (repo.effectiveStatus(app) === 'needs_info' ? [...new Set([...mapUnlocked(app.unlocked), 'decl'])] : SECTIONS);
  // 可以编辑的申请：每次打开都按 整理（只在内存里；下一次保存时一起写回）。已提交、已审核的保持原样
  const open = (app) => {
    const p = repo.open(app);
    if (repo.isEditable(app)) upgradeToV7(p);
    return p;
  };

  async function authed(request) {
    const app = await repo.byToken(request.headers.get('x-kyb-token') || '');
    if (!app) throw Object.assign(new Error('invalid_link'), { status: 404 });
    return app;
  }
  const mustEdit = (app, section) => {
    if (!repo.isEditable(app)) throw Object.assign(new Error('not_editable'), { status: 409 });
    if (section && !editableSections(app).includes(section)) throw Object.assign(new Error('section_locked'), { status: 403 });
  };
  // 只能上传公司文件（不带人员）和身份证明（必须是已保存的人员）；超过数量上限时拒绝
  function checkDoc(app, payload, doc, person) {
    if (!DOC_IDS.has(doc)) throw Object.assign(new Error('invalid_doc'), { status: 400 });
    const personDoc = doc === 'id';
    if (personDoc && !(payload.form.people || []).some((p) => p.pid === person)) throw Object.assign(new Error('invalid_person'), { status: 400 });
    if (!personDoc && person) throw Object.assign(new Error('invalid_person'), { status: 400 });
    mustEdit(app, docSection(doc));
    const used = payload.files.filter((f) => f.doc === doc && (!personDoc || f.person === person)).length;
    if (used >= (personDoc ? MAX_ID_FILES : MAX_COMPANY_FILES)) throw Object.assign(new Error('too_many_files'), { status: 400 });
  }
  const publicFiles = (files) => files.map(({ id, doc, person, name, size }) => ({ id, doc, person, name, size }));
  async function touch(app) { if (app.status === 'invited') app.status = 'in_progress'; }

  const actions = {
    // 读取申请：只有可以编辑时才返回已填内容；已提交的申请只返回状态
    async state(request) {
      const app = await authed(request);
      const status = repo.effectiveStatus(app);
      const meta = { company: app.company, ref: app.ref, expiresAt: app.expiresAt, status };
      if (!repo.isEditable(app)) return json(200, { meta, editable: [] });
      const p = open(app);
      return json(200, { meta, form: p.form, files: publicFiles(p.files), editable: editableSections(app), unlocked: mapUnlocked(app.unlocked), uploadMode: blobs?.mode || null, uploadPrefix: `kyb/${app.id}/` });
    },

    // 保存某一步（草稿校验：只拦截非法类型和超长内容）
    async save(request) {
      const app = await authed(request);
      const { section, data } = await readJson(request);
      if (!SECTIONS.includes(section)) return json(400, { ok: false, error: 'invalid_section' });
      mustEdit(app, section);
      const { data: clean, errors } = validateSection(section, data, { strict: false, now: now() });
      const bad = Object.entries(errors).filter(([, v]) => v === 'invalid' || v === 'length');
      if (bad.length) return json(400, { ok: false, error: 'validation', fields: Object.fromEntries(bad) });
      const p = open(app);
      p.form[section] = keepLegacy(section, p.form[section], clean); // 删掉的旧字段的数据保留，后台照常显示
      if (section === 'people') { // 删除了的人员，其文件一并删除
        const pids = new Set(clean.map((x) => x.pid));
        const gone = p.files.filter((f) => f.person && !pids.has(f.person));
        if (gone.length && blobs) await blobs.del(gone.map((f) => f.pathname));
        p.files = p.files.filter((f) => !gone.includes(f));
      }
      await touch(app);
      await repo.seal(app, p);
      return json(200, { ok: true });
    },

    // 上传文件：浏览器把文件直接发到本接口（请求体就是文件内容），服务器加密后保存到本地目录
    async 'local-upload'(request) {
      if (blobs?.mode !== 'local') return json(404, { ok: false, error: 'not_found' });
      const app = await authed(request);
      const u = new URL(request.url);
      const doc = u.searchParams.get('doc'), person = u.searchParams.get('person') || undefined;
      const type = (request.headers.get('content-type') || '').split(';')[0];
      const p = open(app);
      checkDoc(app, p, doc, person);
      if (!FILE_TYPES.includes(type)) return json(400, { ok: false, error: 'file_type' });
      if (Number(request.headers.get('content-length')) > MAX_FILE_BYTES) return json(413, { ok: false, error: 'file_size' });
      const bytes = Buffer.from(await request.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) return json(413, { ok: false, error: 'file_size' });
      const pathname = `kyb/${app.id}/${randomBytes(12).toString('base64url')}`;
      await blobs.put(pathname, bytes, type);
      return json(200, { pathname });
    },

    // 登记一个已上传的文件：服务端核实文件确实存在、属于本申请、类型和大小合规
    async file(request) {
      const app = await authed(request);
      const { pathname, doc, person, name } = await readJson(request);
      const p = open(app);
      checkDoc(app, p, doc, person || undefined);
      if (typeof pathname !== 'string' || !pathname.startsWith(`kyb/${app.id}/`) || pathname.includes('..')) return json(400, { ok: false, error: 'invalid_pathname' });
      const h = await blobs.head(pathname);
      if (!h) return json(400, { ok: false, error: 'not_uploaded' });
      if (!FILE_TYPES.includes(h.contentType) || h.size > MAX_FILE_BYTES) { await blobs.del([pathname]); return json(400, { ok: false, error: 'file_type' }); }
      const rec = { id: randomBytes(8).toString('base64url'), doc, person: person || undefined, pathname, name: String(name || 'file').slice(0, 150), size: h.size, type: h.contentType, uploadedAt: new Date(now()).toISOString() };
      p.files.push(rec);
      await touch(app);
      await repo.seal(app, p);
      return json(200, { ok: true, file: publicFiles([rec])[0] });
    },

    async 'file-delete'(request) {
      const app = await authed(request);
      const { fileId } = await readJson(request);
      const p = open(app);
      const f = p.files.find((x) => x.id === fileId);
      if (!f) return json(404, { ok: false, error: 'not_found' });
      mustEdit(app, docSection(f.doc));
      await blobs.del([f.pathname]);
      p.files = p.files.filter((x) => x !== f);
      await repo.seal(app, p);
      return json(200, { ok: true });
    },

    // 提交：整体严格校验 + 手写签名
    async submit(request) {
      const app = await authed(request);
      mustEdit(app);
      const { signature } = await readJson(request, 512 * 1024);
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(signature || ''));
      const png = m ? Buffer.from(m[1], 'base64') : null;
      if (!png || png.length < 200 || png.length > SIG_MAX || png.readUInt32BE(0) !== 0x89504e47) return json(400, { ok: false, error: 'validation', fields: { signature: 'required' } });
      const p = open(app);
      const errors = validateForSubmit(p.form, p.files, now());
      if (Object.keys(errors).length) return json(400, { ok: false, error: 'validation', fields: errors });
      const resubmit = repo.effectiveStatus(app) === 'needs_info';
      const sigPath = `kyb/${app.id}/signature-${Date.now()}.png`;
      await blobs.put(sigPath, png, 'image/png');
      if (p.signature?.pathname) await blobs.del([p.signature.pathname]);
      p.signature = { pathname: sigPath, signedAt: new Date(now()).toISOString(), ip: getIp(request) || '', userAgent: String(request.headers.get('user-agent') || '').slice(0, 300) };
      p.review.received = p.review.received || new Date(now()).toISOString();
      app.status = 'submitted';
      app.submittedAt = new Date(now()).toISOString();
      // 制裁声明选"是"时，在明文记录里留一个标记（只是是 / 否，不含说明内容），后台列表用红色标出
      app.flags = { sanctions: p.form?.entity?.sanctions === 'yes' };
      app.unlocked = [];
      await repo.seal(app, p);
      await repo.audit(app.id, 'client', resubmit ? 'resubmitted' : 'submitted');
      if (config.mailTo) {
        const mail = adminNotifyEmail({ company: app.company, ref: app.ref, kind: resubmit ? 'resubmitted' : 'submitted', adminUrl: `${originOf(request)}/admin/` });
        waitUntil(send({ to: config.mailTo, ...mail }).catch((e) => log.error(`[kyb] NOTIFY_FAILED ${app.ref}: ${e.message}`)));
      }
      return json(200, { ok: true });
    },
  };

  const handle = async function handle(request) {
    const action = actionOf(request);
    const fn = Object.hasOwn(actions, action) ? actions[action] : null;
    if (!fn) return json(404, { ok: false, error: 'not_found' });
    if (action === 'state' ? request.method !== 'GET' : request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
    try {
      return await fn(request);
    } catch (err) {
      if (err.status) return json(err.status, { ok: false, error: err.message });
      if (/invalid_link|invalid_doc|invalid_person|invalid_pathname|not_editable|section_locked|too_many_files/.test(err.message)) return json(400, { ok: false, error: err.message });
      log.error(`[kyb] onboarding ${action} failed: ${err.stack || err}`);
      return json(500, { ok: false, error: 'server_error' });
    }
  };
  // 接口入口文件（api/<分组>/<动作>.js）按这个列表逐个生成，测试会检查两边一致
  handle.actions = Object.keys(actions);
  return handle;
}
