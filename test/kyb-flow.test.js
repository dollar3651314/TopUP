import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemRedis } from '../server/kyb/memredis.js';
import { deriveKeys, decryptJson } from '../server/kyb/crypto.js';
import { createRepo } from '../server/kyb/repo.js';
import { createLocalBlobs } from '../server/kyb/blobs.js';
import { createOnboardingHandler } from '../server/kyb/onboarding.js';
import { createAdminHandler, createCleanup } from '../server/kyb/admin.js';
import { totpCode } from '../server/kyb/totp.js';
import { approvedFromKyb } from '../server/pay/kyb-link.js';

const quiet = { error() {}, warn() {} };
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]).toString('base64');
const B = 'http://kyb.test';

function setup() {
  let t = Date.parse('2026-09-28T02:00:00Z');
  const now = () => t;
  const dir = mkdtempSync(join(tmpdir(), 'kyb-'));
  const redis = createMemRedis({ now });
  const keys = deriveKeys('flow-test-secret-flow-test-secret-0123456789');
  const repo = createRepo({ redis, keys, now });
  const blobs = createLocalBlobs(join(dir, 'blobs'));
  const mails = [];
  const send = async (m) => mails.push(m);
  const config = { mailTo: 'admin@example.test', adminSetupToken: 'setup-token-123' };
  const ob = createOnboardingHandler({ repo, blobs, send, config, now, log: quiet, getIp: () => '198.51.100.7' });
  const ad = createAdminHandler({ repo, blobs, send, redis, keys, config, now, log: quiet });
  const cleanup = createCleanup({ repo, blobs, now, log: quiet });
  let cookie = '';
  const admin = async (action, body, method = body === undefined ? 'GET' : 'POST') => {
    const r = await ad(new Request(`${B}/api/admin/${action}`, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }));
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return [r.status, r.headers.get('content-type')?.includes('json') ? await r.json() : r];
  };
  const client = (token) => async (action, body, extra = {}) => {
    const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'x-kyb-token': token, ...(extra.headers || {}) } };
    if (body !== undefined) { init.body = extra.raw ? body : JSON.stringify(body); if (!extra.raw) init.headers['content-type'] = 'application/json'; }
    const r = await ob(new Request(`${B}/api/onboarding/${action}`, init));
    return [r.status, await r.json()];
  };
  const tokenFrom = (mail) => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('t');
  const login = async () => {
    const [s1, b1] = await admin('setup-begin/', { setupToken: 'setup-token-123', password: 'a-long-password-123' });
    assert.equal(s1, 200);
    assert.ok(b1.qr.startsWith('data:image/png;base64,'));
    assert.equal((await admin('setup-confirm/', { setupToken: 'setup-token-123', code: totpCode(b1.secret, t) }))[0], 200);
    assert.equal((await admin('login/', { password: 'a-long-password-123', code: totpCode(b1.secret, t) }))[0], 200);
    return b1.secret;
  };
  return { redis, keys, repo, blobs, mails, admin, client, tokenFrom, login, cleanup, setNow: (x) => (t = x), getNow: () => t, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// 4 个步骤；授权联系人是人员的一个角色
const SECS = ['entity', 'people', 'wallet', 'decl'];
const fullForm = () => ({
  entity: { legalName: 'Acme Export Limited', legalForm: 'Ltd', regNumber: '202012345K', incDate: '2020-04-18', incPlace: 'Singapore', regAddress: '10 Anson Road', physAddress: '10 Anson Road', website: 'acme.example', email: 'ops@acme.example', phone: '+65 6000 1234', nature: ['export'], purpose: ['deposits'], volume: 'lt50k', currencies: ['usdt'], markets: ['apac'], sanctions: 'no' },
  people: [
    { pid: '0', roles: ['director', 'ubo'], fullName: 'Jane Tan', dob: '1984-02-11', nationality: 'SG', address: '8 Demo St', idType: 'passport', idNo: 'K7654321Z', idCountry: 'SG', idExpiry: '2031-05-01', ownershipPct: '100', votingPct: '100', pep: 'no' },
    { pid: '1', roles: ['contact', 'signatory'], fullName: 'Bob Lee', dob: '1990-03-02', nationality: 'SG', address: '9 Demo St', idType: 'id_card', idNo: 'S1234567D', idCountry: 'SG', idExpiry: '2032-01-01', pep: 'no', email: 'bob@acme.example', phone: '+65 9000 2222' },
  ],
  wallet: { clientName: 'Acme Export Limited', email: 'ops@acme.example', address: 'TXYZ123', network: 'tron', use: 'both', ownershipOk: true, riskOk: true },
  decl: { repName: 'Bob Lee', position: 'Director', confirm: true },
});
const saveAll = async (c, f) => { for (const sec of SECS) assert.equal((await c('save/', { section: sec, data: f[sec] }))[0], 200, sec); };
const uploadIds = async (c) => { for (const pid of ['0', '1']) assert.equal((await upload(c, 'id', pid, 'image/png'))[0], 200, pid); };
async function upload(c, doc, person, type = 'application/pdf', bytes = Buffer.from('%PDF-1.4 test')) {
  const q = new URLSearchParams({ doc, ...(person ? { person } : {}) });
  const [s, r] = await c(`local-upload/?${q}`, bytes, { raw: true, headers: { 'content-type': type } });
  if (s !== 200) return [s, r];
  return c('file/', { pathname: r.pathname, doc, person, name: `${doc}.pdf` });
}

test('完整流程：初始化 → 登录 → 发送链接 → 填写 → 上传 → 提交 → 补件 → 再提交 → 通过 → 删除', async () => {
  const s = setup();
  try {
    assert.equal((await s.admin('apps/'))[0], 401); // 未登录
    await s.login();
    const [si, inv] = await s.admin('invite/', { company: 'Acme Export Ltd', email: 'client@acme.example' });
    assert.equal(si, 200); assert.equal(inv.emailed, true); assert.match(inv.ref, /^TU-2026-0001$/);
    assert.equal(s.mails.length, 1);
    assert.equal(s.mails[0].to, 'client@acme.example');
    assert.match(s.mails[0].text, /This is a business onboarding invitation from TopUP/);
    const token = s.tokenFrom(s.mails[0]);
    assert.ok(token.length >= 43); // 256 位
    const c = s.client(token);
    let [st, state] = await c('state/');
    assert.equal(st, 200); assert.equal(state.meta.status, 'invited'); assert.equal(state.uploadMode, 'local');

    const f = fullForm();
    await saveAll(c, f);
    // 旧步骤名不能再保存
    for (const old of ['contact', 'rep', 'docs']) assert.equal((await c('save/', { section: old, data: {} }))[0], 400, old);
    [, state] = await c('state/');
    assert.equal(state.meta.status, 'in_progress');
    assert.equal(state.form.entity.legalName, 'Acme Export Limited'); // 保存后可以读回

    // 未上传文件就提交 → 拒绝，并指出缺少的文件
    let [ss, sb] = await c('submit/', { signature: PNG });
    assert.equal(ss, 400); assert.equal(sb.fields['docs.id:0'], 'required'); assert.equal(sb.fields['docs.id:1'], 'required');
    assert.equal(sb.fields['docs.company'], undefined); // 公司文件选传
    // 文件类型不对 → 拒绝
    assert.equal((await upload(c, 'company', undefined, 'text/html'))[0], 400);
    // 人员不存在、身份证明不带人员、公司文件带人员 → 拒绝
    assert.equal((await upload(c, 'id', '9'))[0], 400);
    assert.equal((await upload(c, 'id'))[0], 400);
    assert.equal((await upload(c, 'company', '0'))[0], 400);
    // 旧版文件项不能再上传
    for (const d of ['d1', 'passport', 'poa', 'walletProof']) assert.equal((await upload(c, d, d === 'passport' || d === 'poa' ? '0' : undefined))[0], 400, d);
    // 身份证明每人最多 3 个
    for (let i = 0; i < 3; i++) assert.equal((await upload(c, 'id', '0', 'image/png'))[0], 200);
    const [t4, b4] = await upload(c, 'id', '0', 'image/png');
    assert.equal(t4, 400); assert.equal(b4.error, 'too_many_files');
    assert.equal((await upload(c, 'id', '1', 'image/png'))[0], 200);
    assert.equal((await upload(c, 'company'))[0], 200);
    // 没有签名 → 拒绝
    assert.equal((await c('submit/', { signature: 'data:image/png;base64,AAAA' }))[1].fields.signature, 'required');
    [ss] = await c('submit/', { signature: PNG });
    assert.equal(ss, 200);
    // 提交后：客户看不到资料、不能再保存
    [, state] = await c('state/');
    assert.equal(state.meta.status, 'submitted'); assert.equal(state.form, undefined);
    assert.equal((await c('save/', { section: 'entity', data: f.entity }))[0], 409);
    // 通知管理员：不含敏感字段
    const note = s.mails.at(-1);
    assert.equal(note.to, 'admin@example.test');
    for (const secret of ['K7654321Z', '8 Demo St', 'client@acme.example', 'jane@acme.example']) assert.ok(!note.text.includes(secret), secret);

    // 数据库里是密文
    const raw = JSON.stringify(s.redis.raw());
    for (const secret of ['K7654321Z', '8 Demo St', 'jane@acme.example', 'client@acme.example', 'Acme Export Limited']) assert.ok(!raw.includes(secret), `明文泄露：${secret}`);
    assert.ok(!raw.includes(token), '令牌明文不应存储');

    // 后台查看详情、下载文件
    const [, list] = await s.admin('apps/');
    const id = list.apps[0].id;
    assert.equal(list.apps[0].status, 'submitted');
    const [, detail] = await s.admin(`app/?id=${id}`);
    assert.equal(detail.form.people[0].idNo, 'K7654321Z');
    assert.equal(detail.form.v, 7);
    assert.equal(detail.signature.ip, '198.51.100.7');
    assert.equal(detail.files.length, 5);
    const [fs, fr] = await s.admin(`file/?id=${id}&fileId=${detail.files[0].id}`);
    assert.equal(fs, 200); assert.equal(await fr.text(), '%PDF-1.4 test');
    assert.match(fr.headers.get('content-disposition'), /^attachment/);

    // 要求补件：只开放"企业信息"（含公司文件）；旧步骤名被忽略
    const [ns, nb] = await s.admin('decide/', { id, action: 'needs_info', sections: ['entity', 'docs'], message: '存续证明需要 90 天内签发' });
    assert.equal(ns, 200); assert.equal(nb.emailed, true);
    assert.equal((await c('state/'))[0], 404); // 旧链接失效
    const token2 = s.tokenFrom(s.mails.at(-1));
    assert.match(s.mails.at(-1).text, /存续证明需要 90 天内签发/);
    const c2 = s.client(token2);
    [, state] = await c2('state/');
    assert.deepEqual(state.editable.sort(), ['decl', 'entity']);
    assert.match(s.mails.at(-1).text, /企业信息和公司文件/); assert.doesNotMatch(s.mails.at(-1).text, /证明文件/);
    assert.equal((await c2('save/', { section: 'people', data: f.people }))[0], 403); // 未开放的部分不能改
    assert.equal((await upload(c2, 'id', '0', 'image/png'))[0], 403); // 人员的身份证明也不能改
    const oldIdFile = state.files.find((x) => x.doc === 'id');
    assert.equal((await c2('file-delete/', { fileId: oldIdFile.id }))[0], 403);
    const oldCompany = state.files.find((x) => x.doc === 'company');
    assert.equal((await c2('file-delete/', { fileId: oldCompany.id }))[0], 200);
    assert.equal((await upload(c2, 'company'))[0], 200);
    assert.equal((await c2('submit/', { signature: PNG }))[0], 200);
    assert.match(s.mails.at(-1).subject, /resubmitted/);

    // 通过 → 保留期：业务关系存续期间一直保留
    assert.equal((await s.admin('decide/', { id, action: 'approve' }))[0], 200);
    let [, d2] = await s.admin(`app/?id=${id}`);
    assert.equal(d2.app.status, 'approved'); assert.equal(d2.app.retentionUntil, null); assert.equal(d2.review.reviewer, '管理员');
    assert.ok(d2.audit.map((x) => x.action).join(',').includes('needs_info,resubmitted,approved'));
    // 待开通列表的邮箱是授权联系人的邮箱
    const approved = await approvedFromKyb(s.repo)();
    assert.deepEqual(approved.map((x) => [x.ref, x.email]), [[inv.ref, 'bob@acme.example']]);

    // 删除：申请和全部文件都查不到
    assert.equal((await s.admin('delete/', { id, confirmRef: 'wrong' }))[0], 400);
    assert.equal((await s.admin('delete/', { id, confirmRef: inv.ref }))[0], 200);
    assert.equal((await s.admin(`app/?id=${id}`))[0], 404);
    const left = existsSync(join(s.dir, 'blobs', 'kyb', id)) ? readdirSync(join(s.dir, 'blobs', 'kyb', id)) : [];
    assert.deepEqual(left, []);
  } finally { s.done(); }
});

test('安全：一个客户的链接不能访问另一个申请的文件；无效令牌 404；未登录不能下载', async () => {
  const s = setup();
  try {
    await s.login();
    await s.admin('invite/', { company: 'A', email: 'a@a.com' });
    await s.admin('invite/', { company: 'B', email: 'b@b.com' });
    const [ta, tb] = [s.tokenFrom(s.mails[0]), s.tokenFrom(s.mails[1])];
    const ca = s.client(ta), cb = s.client(tb);
    const [, stA] = await ca('state/');
    const [, up] = await ca('local-upload/?doc=company', Buffer.from('%PDF'), { raw: true, headers: { 'content-type': 'application/pdf' } });
    // B 试图把 A 的文件登记到自己名下 → 拒绝
    assert.equal((await cb('file/', { pathname: up.pathname, doc: 'company', name: 'x.pdf' }))[0], 400);
    assert.ok(up.pathname.startsWith(stA.uploadPrefix));
    assert.equal((await s.client('not-a-real-token-not-a-real-token-xx')('state/'))[0], 404);
    assert.equal((await s.client('')('state/'))[0], 404);
    // 退出登录后，旧会话失效
    assert.equal((await s.admin('logout/', {}))[0], 200);
    assert.equal((await s.admin('apps/'))[0], 401);
  } finally { s.done(); }
});

test('登录锁定：连续错误 5 次锁定 15 分钟', async () => {
  const s = setup();
  try {
    const secret = await s.login();
    await s.admin('logout/', {});
    for (let i = 0; i < 5; i++) assert.equal((await s.admin('login/', { password: 'wrong', code: '000000' }))[0], 401);
    const [ls, lb] = await s.admin('login/', { password: 'a-long-password-123', code: totpCode(secret, s.getNow()) });
    assert.equal(ls, 429); assert.equal(lb.error, 'locked');
    s.setNow(s.getNow() + 15 * 60 * 1000 + 1000);
    assert.equal((await s.admin('login/', { password: 'a-long-password-123', code: totpCode(secret, s.getNow()) }))[0], 200);
  } finally { s.done(); }
});

test('同一个动态码不能重复登录（防重放）', async () => {
  const s = setup();
  try {
    const secret = await s.login();
    const code = totpCode(secret, s.getNow());
    await s.admin('logout/', {});
    assert.equal((await s.admin('login/', { password: 'a-long-password-123', code }))[0], 401);
    s.setNow(s.getNow() + 30_000);
    assert.equal((await s.admin('login/', { password: 'a-long-password-123', code: totpCode(secret, s.getNow()) }))[0], 200);
  } finally { s.done(); }
});

test('初始化：口令错误、密码太短、重复初始化都被拒绝', async () => {
  const s = setup();
  try {
    assert.equal((await s.admin('setup-begin/', { setupToken: 'nope', password: 'a-long-password-123' }))[0], 403);
    assert.equal((await s.admin('setup-begin/', { setupToken: 'setup-token-123', password: 'short' }))[0], 400);
    await s.login();
    assert.equal((await s.admin('setup-begin/', { setupToken: 'setup-token-123', password: 'a-long-password-123' }))[0], 409);
  } finally { s.done(); }
});

test('链接 30 天过期；重新发送后旧链接失效、新链接可用', async () => {
  const s = setup();
  try {
    const secret = await s.login();
    await s.admin('invite/', { company: 'Late Co', email: 'late@x.com' });
    const t0 = s.tokenFrom(s.mails.at(-1));
    assert.equal((await s.client(t0)('state/'))[0], 200);
    s.setNow(s.getNow() + 31 * 864e5);
    assert.equal((await s.client(t0)('state/'))[0], 404); // 过期
    assert.equal((await s.admin('apps/'))[0], 401); // 会话 8 小时后过期
    assert.equal((await s.admin('login/', { password: 'a-long-password-123', code: totpCode(secret, s.getNow()) }))[0], 200);
    const [, list] = await s.admin('apps/');
    assert.equal(list.apps[0].status, 'expired');
    assert.equal((await s.admin('resend/', { id: list.apps[0].id }))[0], 200);
    const t1 = s.tokenFrom(s.mails.at(-1));
    assert.notEqual(t1, t0);
    assert.equal((await s.client(t0)('state/'))[0], 404);
    const [st, body] = await s.client(t1)('state/');
    assert.equal(st, 200); assert.equal(body.meta.status, 'invited');
  } finally { s.done(); }
});

test('自动清理：未通过的申请满 1 年删除；通过且业务关系结束满 5 年删除', async () => {
  const s = setup();
  try {
    const { app: a1 } = await s.repo.create({ company: 'Old', email: 'o@x.com' });
    const { app: a2 } = await s.repo.create({ company: 'Client', email: 'c@x.com' });
    a2.status = 'approved'; await s.repo.save(a2);
    s.setNow(s.getNow() + 366 * 864e5);
    assert.deepEqual(await s.cleanup(), { deleted: 1 });
    assert.equal(await s.repo.get(a1.id), null);
    const cur = await s.repo.get(a2.id);
    cur.relationshipEndedAt = new Date(s.getNow()).toISOString(); await s.repo.save(cur);
    s.setNow(s.getNow() + 5 * 366 * 864e5);
    assert.deepEqual(await s.cleanup(), { deleted: 1 });
    assert.equal(await s.repo.get(a2.id), null);
  } finally { s.done(); }
});

test('原始存储中的申请记录只有明文的编号、状态、企业名称', async () => {
  const s = setup();
  try {
    const { app } = await s.repo.create({ company: 'Visible Co', email: 'secret-mail@x.com' });
    const raw = s.redis.raw().kv[`topup:app:${app.id}`];
    assert.ok(raw.includes('Visible Co')); assert.ok(!raw.includes('secret-mail@x.com'));
    assert.equal(decryptJson(s.keys.enc, JSON.parse(raw).enc).email, 'secret-mail@x.com');
  } finally { s.done(); }
});

test('制裁声明选"是"时，列表里有明文标记，但不含说明内容', async () => {
  const s = setup();
  try {
    await s.login();
    await s.admin('invite/', { company: 'Flag Co', email: 'flag@x.com' });
    const c = s.client(s.tokenFrom(s.mails.at(-1)));
    const f = fullForm();
    f.entity = { ...f.entity, sanctions: 'yes', sanctionsDetails: 'SECRET-SANCTION-DETAIL region' };
    await saveAll(c, f);
    await uploadIds(c);
    assert.equal((await c('submit/', { signature: PNG }))[0], 200);
    const [, list] = await s.admin('apps/');
    assert.deepEqual(list.apps[0].flags, { sanctions: true });
    assert.ok(!JSON.stringify(s.redis.raw()).includes('SECRET-SANCTION-DETAIL'), '说明内容必须加密');
    // 公司文件最多 20 个
    await s.admin('decide/', { id: list.apps[0].id, action: 'needs_info', sections: ['entity'], message: 'x' });
    const c2 = s.client(s.tokenFrom(s.mails.at(-1)));
    for (let i = 0; i < 20; i++) assert.equal((await upload(c2, 'company'))[0], 200, i);
    assert.equal((await upload(c2, 'company'))[1].error, 'too_many_files');
  } finally { s.done(); }
});

// 旧格式（7 步）的申请，用来验证改成 4 步后的兼容
const v4Form = () => ({
  entity: { legalName: 'Old Co Ltd', legalForm: 'Ltd', regNumber: 'R1', incDate: '2020-01-01', incPlace: 'SG', regAddress: 'a', physAddress: 'a', nature: ['export'], purpose: ['deposits'], volume: 'lt50k', currencies: ['usd'], markets: ['apac'], sanctions: 'no', lei: 'LEI-OLD', tin: 'TIN-OLD' },
  contact: { website: 'old.example', email: 'ops@old.example', phone: '+65 6000 0000', otherContact: 'wechat old' },
  rep: { name: 'Rep Person', email: 'rep@old.example', phone: '+65 9000 0000' },
  people: [{ pid: '0', roles: ['director', 'ubo'], fullName: 'Jane Old', dob: '1980-01-01', nationality: 'SG', residence: 'SG', address: 'b', passportNo: 'P-OLD-1', passportCountry: 'SG', passportExpiry: '2031-01-01', ownershipPct: '100', votingPct: '100', pep: 'no', email: 'jane@old.example', phone: '+65 9000 0001' }],
  wallet: { clientName: 'Old Co Ltd', idTypeNo: 'Reg R1', userId: 'U1', email: 'ops@old.example', address: 'TOLD', network: 'tron', use: 'both', ownershipOk: true, riskOk: true, proofType: 'provider' },
  decl: { repName: 'Rep Person', position: 'Director', confirm: true },
});
async function seedV4(s, company, status, extra = {}) {
  const { app, token } = await s.repo.create({ company, email: `${company.replace(/\W/g, '')}@x.com` });
  const p = s.repo.open(app);
  p.form = v4Form();
  const f = (id, doc, person) => ({ id, doc, person, name: `${doc}.pdf`, size: 10, type: 'application/pdf', pathname: `kyb/${app.id}/${id}` });
  p.files = [f('o1', 'd1'), f('o2', 'd2'), f('o3', 'passport', '0'), f('o4', 'poa', '0'), f('o5', 'walletProof')];
  for (const x of p.files) await s.blobs.put(x.pathname, Buffer.from('%PDF old'), 'application/pdf');
  Object.assign(app, { status }, extra);
  await s.repo.seal(app, p);
  return { app, token };
}

test('旧格式（7 步）的申请——已提交的在后台原样显示；填写中的打开后自动整理，补传身份证明后可以提交', async () => {
  const s = setup();
  try {
    await s.login();
    const done = await seedV4(s, 'Old Submitted', 'submitted');
    const [, detail] = await s.admin(`app/?id=${done.app.id}`);
    assert.equal(detail.form.v, undefined);
    assert.equal(detail.form.rep.email, 'rep@old.example'); // 原有内容不受影响
    assert.equal(detail.form.entity.lei, 'LEI-OLD');
    assert.deepEqual(detail.files.map((x) => x.doc), ['d1', 'd2', 'passport', 'poa', 'walletProof']);
    // 审核通过后，待开通列表仍取原来第 ③ 步的邮箱
    assert.equal((await s.admin('decide/', { id: done.app.id, action: 'approve' }))[0], 200);
    assert.equal((await approvedFromKyb(s.repo)())[0].email, 'rep@old.example');

    const wip = await seedV4(s, 'Old Draft', 'in_progress');
    const c = s.client(wip.token);
    const [, state] = await c('state/');
    assert.equal(state.form.v, 7);
    assert.equal(state.form.entity.website, 'old.example');
    assert.deepEqual(state.form.people.map((p) => [p.fullName, p.roles, p.idNo || '']), [['Jane Old', ['director', 'ubo'], 'P-OLD-1'], ['Rep Person', ['contact'], '']]);
    assert.deepEqual(state.files.map((x) => x.doc), ['company', 'company', 'id', 'poa', 'walletProof']);
    // 新增的必填项（授权联系人的证件信息和身份证明）补齐前不能提交
    const [st, body] = await c('submit/', { signature: PNG });
    assert.equal(st, 400);
    for (const k of ['people.1.idNo', 'people.1.dob', 'docs.id:1']) assert.equal(body.fields[k], 'required', k);
    assert.equal(body.fields['docs.id:0'], undefined); // 原来的护照算作身份证明
    const people = state.form.people.map((p) => (p.pid === '1' ? { ...p, dob: '1985-01-01', nationality: 'SG', address: 'c', idType: 'id_card', idNo: 'ID-NEW', idCountry: 'SG', idExpiry: '2033-01-01', pep: 'no' } : p));
    assert.equal((await c('save/', { section: 'people', data: people }))[0], 200);
    assert.equal((await upload(c, 'id', '1', 'image/png'))[0], 200);
    assert.equal((await c('submit/', { signature: PNG }))[0], 200);
    const [, d2] = await s.admin(`app/?id=${wip.app.id}`);
    assert.equal(d2.form.v, 7);
    assert.equal(d2.form.people[0].passportNo, 'P-OLD-1'); // 删掉的字段数据不删
    assert.equal(d2.form.people[0].residence, 'SG');
    assert.equal(d2.form.entity.lei, 'LEI-OLD');
    assert.equal(d2.form.rep.email, 'rep@old.example');
    assert.equal(d2.files.find((x) => x.doc === 'company').legacyDoc, 'd1');
    assert.equal((await s.admin('decide/', { id: wip.app.id, action: 'approve' }))[0], 200);
    assert.equal((await approvedFromKyb(s.repo)()).find((x) => x.company === 'Old Draft').email, 'rep@old.example'); // 现在是授权联系人的邮箱

    // 时被要求补件、开放的是旧步骤名"证明文件"：现在开放企业信息和人员
    const ni = await seedV4(s, 'Old Needs Info', 'needs_info', { unlocked: ['docs'] });
    const [, st3] = await s.client(ni.token)('state/');
    assert.deepEqual(st3.editable.sort(), ['decl', 'entity', 'people']);
    assert.deepEqual(st3.unlocked.sort(), ['entity', 'people']);
  } finally { s.done(); }
});
