// 审核后台的交互逻辑。
// - 正式模式：通过 /api/kyb/?g=admin&a=<动作>（会话 Cookie；首次使用先初始化）。
// - 原型模式：使用内置的模拟数据（虚构），格式与真实接口相同，所有操作只改页面上的数据。
import copy from '../i18n/onboarding.json';
import { kybUrl } from './kyb-url';

const C = copy.zh;
const root = document.getElementById('admin-root')!;
const PROTO = root.dataset.prototype === '1';
const $ = <T extends Element = HTMLElement>(sel: string, el: ParentNode = root) => el.querySelector<T>(sel)!;
const el = (tag: string, cls = '', text = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

const STATUS: Record<string, string> = { invited: '已邀请', in_progress: '填写中', submitted: '已提交', needs_info: '需要补件', approved: '已通过', rejected: '已拒绝', expired: '已过期' };
// 4 个步骤。旧版（及以前）申请里的 contact、rep、docs 只用于显示原来的内容和补件记录
const SECTION_NAMES: Record<string, string> = { entity: '① 企业信息', people: '② 人员', wallet: '③ 钱包授权', decl: '④ 声明与签名', contact: '旧版：公司联系方式', rep: '旧版：授权联系人', docs: '旧版：证明文件' };
/** 要求补件时可以勾选的部分（声明与签名每次都要重签，不用勾） */
const NEEDS_INFO_SECTIONS = ['entity', 'people', 'wallet'];
const AUDIT: Record<string, string> = { invited: '发送开户链接', link_resent: '重新发送链接（旧链接失效）', submitted: '客户提交', resubmitted: '客户补件后再次提交', approved: '通过', rejected: '拒绝', needs_info: '要求补件', notes_updated: '更新备注', invite_email_failed: '⚠️ 邀请邮件发送失败' };
const day = (s?: string | null) => (s ? String(s).slice(0, 10) : '—');
const dt = (s?: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');

// ---------- 字段标签（与客户页面同一份文案） ----------
const LG = C.legacy;
const LABELS: Record<string, Record<string, string>> = {
  entity: { legalName: C.s1.legalName, tradingName: C.s1.tradingName, legalForm: C.s1.legalForm, regNumber: C.s1.regNumber, incDate: C.s1.incDate, incPlace: C.s1.incPlace, regAddress: C.s1.regAddress, physAddress: C.s1.physAddress, website: C.s1.website, email: C.s1.email, phone: C.s1.phone, nature: C.s1.nature, purpose: C.s1.purpose, volume: C.s1.volume, volumeAmount: C.s1.volumeAmount, currencies: C.s1.currencies, markets: C.s1.markets, sanctions: '涉及制裁', sanctionsDetails: '制裁说明', lei: LG.entity.lei, tin: LG.entity.tin, parent: LG.entity.parent },
  contact: { website: LG.contact.website, email: LG.contact.email, phone: LG.contact.phone, otherContact: LG.contact.otherContact },
  rep: { name: LG.rep.name, email: LG.rep.email, phone: LG.rep.phone, otherContact: LG.rep.otherContact },
  person: { roles: C.s2.roles, dob: C.s2.dob, nationality: C.s2.nationality, address: C.s2.address, idType: C.s2.idType, idNo: C.s2.idNo, idCountry: C.s2.idCountry, idExpiry: C.s2.idExpiry, ownershipPct: C.s2.ownershipPct, votingPct: C.s2.votingPct, pep: 'PEP', pepDetails: 'PEP 说明', email: C.s2.email, phone: C.s2.phone, residence: LG.person.residence, passportNo: LG.person.passportNo, passportCountry: LG.person.passportCountry, passportExpiry: LG.person.passportExpiry },
  wallet: { clientName: C.s3.clientName, email: C.s3.email, address: C.s3.wallet, network: C.s3.network, use: C.s3.use, ownershipOk: C.s3.ownershipTitle, riskOk: C.s3.riskTitle, idTypeNo: LG.wallet.idTypeNo, userId: LG.wallet.userId, proofType: LG.wallet.proof },
  decl: { repName: C.s4.repName, position: C.s4.position, confirm: '确认声明' },
};
const OPTIONS: Record<string, Record<string, string>> = {
  nature: C.s1.natureOptions, purpose: C.s1.purposeOptions, volume: { ...C.s1.volumeOptions, other: '其他（旧版选项）' }, currencies: C.s1.currencyOptions, markets: C.s1.marketOptions, sanctions: { yes: C.yes, no: C.no },
  roles: C.s2.roleOptions, idType: C.s2.idTypeOptions, pep: { yes: C.yes, no: C.no }, network: C.s3.networkOptions, use: C.s3.useOptions, proofType: LG.wallet.proofOptions,
};
const DOC_NAMES: Record<string, string> = {
  company: '公司文件', id: C.s2.idDoc,
  // 及以前的文件项：已有申请里的文件照常显示和下载
  ...(LG.docs as Record<string, string>), passport: `${LG.docs.passport}（旧版）`, poa: `${LG.docs.poa}（旧版）`, walletProof: `${LG.wallet.proof}（旧版）`,
  d11: `${LG.docs.d11}（旧版文件项）`, d12: `${LG.docs.d12}（旧版文件项）`,
};
// 新增的字段：提交的申请里没有，显示为"（提交，没有此项）"
const V4_FIELDS = new Set(['currencies', 'sanctions', 'sanctionsDetails', 'volumeAmount', 'ownershipPct', 'votingPct']);
const LEGACY = '（旧版提交，没有此项）';
/** 按选择才出现的字段：不适用时不显示这一行 */
function applicable(key: string, group: Record<string, any>): boolean {
  // 某个版本的表单里没有这个字段（例如 删掉的 LEI，或 申请里没有的证件类型）：不显示这一行
  if (group[key] === undefined && !V4_FIELDS.has(key)) return false;
  if (key === 'volumeAmount') return group.volume === 'gt500k';
  if (key === 'sanctionsDetails') return group.sanctions === 'yes';
  if (key === 'ownershipPct' || key === 'votingPct') return Array.isArray(group.roles) && group.roles.includes('ubo');
  return true;
}
const sanctionsFlag = () => el('span', 'status st-needs_info flag-sanctions', '涉及制裁：是');
function fmt(key: string, group: Record<string, any>): string {
  const v = group[key];
  if (v === undefined && V4_FIELDS.has(key)) return LEGACY;
  if ((key === 'ownershipPct' || key === 'votingPct') && v) return `${v}%`;
  if (v === true) return '已确认';
  if (v === false || v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '—';
  const opts = OPTIONS[key];
  const other = group[`${key}Other`];
  const show = (x: string) => (x === 'other' && other ? `${opts?.[x] || x}：${other}` : opts?.[x] || x);
  return Array.isArray(v) ? v.map(show).join('、') : show(String(v));
}

// ---------- 接口 ----------
class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.error || String(status)); } }
async function call(path: string, body?: unknown) {
  const res = await fetch(kybUrl('admin', path), body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !['login/', 'me/'].includes(path)) { showView('login'); throw new ApiError(401, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- 原型的模拟数据（虚构，格式与真实接口相同） ----------
const now = Date.now();
const d = (days: number) => new Date(now + days * 864e5).toISOString();
// ?empty=1 时显示空状态（没有任何申请），用来确认空状态的样子
const PROTO_EMPTY = new URLSearchParams(location.search).get('empty') === '1';
const protoApps: any[] = PROTO_EMPTY ? [] : [
  { id: 'a5', ref: 'TU-2026-0004', company: 'Delta Payments FZE', status: 'submitted', updatedAt: d(0), createdAt: d(-4), submittedAt: d(0), expiresAt: d(26), retentionUntil: d(361), fileCount: 1, flags: { sanctions: true } },
  { id: 'a1', ref: 'TU-2026-0003', company: 'Acme Export Ltd', status: 'submitted', updatedAt: d(0), createdAt: d(-6), submittedAt: d(0), expiresAt: d(24), retentionUntil: d(359), fileCount: 5 },
  { id: 'a2', ref: 'TU-2026-0002', company: 'Northwind Manufacturing Co.', status: 'in_progress', updatedAt: d(-1), createdAt: d(-3), submittedAt: null, expiresAt: d(27), retentionUntil: d(362), fileCount: 2 },
  { id: 'a3', ref: 'TU-2026-0001', company: 'Blue Harbor Trading', status: 'needs_info', updatedAt: d(-2), createdAt: d(-12), submittedAt: d(-5), expiresAt: d(28), retentionUntil: d(353), fileCount: 5 },
  { id: 'a6', ref: 'TU-2026-0000', company: 'Harbor Legacy Ltd（旧版提交）', status: 'approved', updatedAt: d(-20), createdAt: d(-40), submittedAt: d(-30), expiresAt: d(-10), retentionUntil: null, fileCount: 9 },
];
// 格式的人员：授权联系人是一个角色，证件信息不限护照
const demoPeople = [
  { pid: '0', roles: ['director', 'ubo', 'signatory', 'contact'], fullName: 'Jane Tan', dob: '1984-02-11', nationality: 'Singapore', address: '8 Demo Street, Singapore', idType: 'passport', idNo: 'K1234567X', idCountry: 'Singapore', idExpiry: '2031-05-01', ownershipPct: '60', votingPct: '60', pep: 'no', pepDetails: '', email: 'jane@acme-export.example', phone: '+65 9000 1111' },
  { pid: '1', roles: ['ubo'], fullName: 'Wei Lim', dob: '1979-09-30', nationality: 'Malaysia', address: '21 Sample Road, Singapore', idType: 'id_card', idNo: '790930-14-5521', idCountry: 'Malaysia', idExpiry: '2029-11-20', ownershipPct: '40', votingPct: '40', pep: 'no', pepDetails: '', email: '', phone: '' },
];
const demoRest = {
  wallet: { clientName: 'Acme Export Limited', email: 'ops@acme-export.example', address: 'TXYZ…DEMO…9Kp2', network: 'tron', use: 'both', ownershipOk: true, riskOk: true },
  decl: { repName: 'Jane Tan', position: 'Director', confirm: true },
};
const demoEntity = { legalName: 'Acme Export Limited', tradingName: 'Acme', legalForm: 'Ltd', regNumber: '202012345K', incDate: '2020-04-18', incPlace: 'Singapore', regAddress: '10 Anson Road, #20-01, Singapore 079903', physAddress: '10 Anson Road, #20-01, Singapore 079903', website: 'acme-export.example', email: 'ops@acme-export.example', phone: '+65 6000 1234', nature: ['export', 'b2b'], purpose: ['deposits', 'crypto'], volume: '100k-500k', volumeAmount: '', currencies: ['usd', 'usdt'], markets: ['apac', 'me'], sanctions: 'no', sanctionsDetails: '' };
const demoFiles = [
  { id: 'c1', doc: 'company', name: 'certificate-of-incorporation.pdf', size: 420000 }, { id: 'c2', doc: 'company', name: 'shareholder-register.pdf', size: 310000 },
  { id: 'i1', doc: 'id', person: '0', name: 'jane-passport.jpg', size: 1900000 },
  { id: 'i2', doc: 'id', person: '1', name: 'wei-id-front.jpg', size: 1200000 }, { id: 'i3', doc: 'id', person: '1', name: 'wei-id-back.jpg', size: 1100000 },
];
// 提交的旧申请：7 步的格式（公司联系方式、授权联系人单独一步，护照字段，证明文件一步）
const legacyPeople = [
  { pid: '0', roles: ['director', 'ubo', 'signatory'], fullName: 'Jane Tan', dob: '1984-02-11', nationality: 'Singapore', residence: 'Singapore', address: '8 Demo Street, Singapore', passportNo: 'K1234567X', passportCountry: 'Singapore', passportExpiry: '2031-05-01', pep: 'no', pepDetails: '', email: 'jane@harbor.example', phone: '+65 9000 1111' },
];
const legacyFiles = [
  ...['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((x, i) => ({ id: 'f' + i, doc: x, name: `${x}-document.pdf`, size: 400000 + i * 90000 })),
  { id: 'old11', doc: 'd11', name: 'initial-funding.pdf', size: 300000 },
  { id: 'p1', doc: 'passport', person: '0', name: 'jane-passport.jpg', size: 1900000 }, { id: 'p2', doc: 'poa', person: '0', name: 'jane-poa.pdf', size: 500000 },
  { id: 'w1', doc: 'walletProof', name: 'wallet-screenshot.png', size: 700000 },
];
const protoForms: Record<string, any> = {
  a1: { v: 7, entity: demoEntity, people: demoPeople, ...demoRest },
  a5: {
    v: 7,
    entity: { ...demoEntity, legalName: 'Delta Payments FZE', nature: ['other'], natureOther: 'Payment service provider', purpose: ['exchange', 'deposits'], volume: 'gt500k', volumeAmount: 'USD 1,200,000', currencies: ['usdt', 'usdc', 'other'], currenciesOther: 'TRX', markets: ['me', 'apac'], sanctions: 'yes', sanctionsDetails: 'Some end users may be located in a sanctioned region; estimated volume under USD 20,000 per month.' },
    people: [demoPeople[0]], ...demoRest,
  },
  a3: { v: 7, entity: { ...demoEntity, legalName: 'Blue Harbor Trading' }, people: demoPeople, ...demoRest },
  // 提交的申请：没有 新增的字段，业务用途还是单选
  a6: {
    entity: (({ currencies, sanctions, sanctionsDetails, volumeAmount, website, email, phone, ...rest }) => ({ ...rest, legalName: 'Harbor Legacy Limited', purpose: 'deposits', lei: '', tin: 'T20SG1234A', parent: '' }))(demoEntity as any),
    contact: { website: 'harbor.example', email: 'ops@harbor.example', phone: '+65 6000 1234', otherContact: 'Telegram @harborops' },
    rep: { name: 'Jane Tan', email: 'jane@harbor.example', phone: '+65 9000 1111', otherContact: '' },
    people: legacyPeople,
    wallet: { clientName: 'Harbor Legacy Limited', idTypeNo: 'Registration 201912345K', userId: '', email: 'ops@harbor.example', address: 'TXYZ…DEMO…9Kp2', network: 'tron', use: 'both', ownershipOk: true, riskOk: true, proofType: 'provider' },
    decl: { repName: 'Jane Tan', position: 'Director', confirm: true },
  },
};
const protoDetail = (a: any) => {
  const form = protoForms[a.id];
  return {
    app: { ...a, email: form ? 'ops@acme-export.example' : 'contact@example.com', invitedAt: a.createdAt, unlocked: a.status === 'needs_info' ? ['people'] : [] },
    form: form || {},
    files: !form ? [] : a.id === 'a6' ? legacyFiles : a.id === 'a5' ? demoFiles.filter((x) => x.person !== '1' && x.doc !== 'company') : demoFiles,
    signature: form ? { signedAt: a.submittedAt, ip: '203.0.113.24' } : null,
    review: form ? { received: a.submittedAt, ...(a.status === 'approved' ? { reviewer: '管理员', reviewDate: a.updatedAt } : {}) } : {},
    audit: [{ at: a.createdAt, actor: 'admin', action: 'invited' }, ...(a.submittedAt ? [{ at: a.submittedAt, actor: 'client', action: 'submitted' }] : [])],
  };
};

const A = PROTO
  ? {
      me: async () => ({ initialized: true, authed: false }),
      login: async (b: any) => { if (!/^[0-9]{6}$/.test(b.code) || !b.password) throw new ApiError(401, { error: 'bad_credentials' }); return { ok: true }; },
      logout: async () => ({ ok: true }),
      apps: async () => ({ apps: protoApps }),
      app: async (id: string) => protoDetail(protoApps.find((x) => x.id === id)),
      invite: async (b: any) => { protoApps.unshift({ id: 'n' + Date.now(), ref: 'TU-2026-000' + protoApps.length, company: b.company, status: 'invited', updatedAt: d(0), createdAt: d(0), expiresAt: d(30), retentionUntil: d(365), fileCount: 0 }); return { ok: true, emailed: true }; },
      resend: async () => ({ ok: true, emailed: true }),
      decide: async (b: any) => { const a = protoApps.find((x) => x.id === b.id); a.status = b.action === 'approve' ? 'approved' : b.action === 'reject' ? 'rejected' : 'needs_info'; return { ok: true, emailed: true }; },
      notes: async () => ({ ok: true }),
      delete: async (b: any) => { protoApps.splice(protoApps.findIndex((x) => x.id === b.id), 1); return { ok: true }; },
      fileUrl: () => '#',
      sigUrl: () => '/proto/signature-sample.svg',
    }
  : {
      me: () => call('me/'),
      login: (b: any) => call('login/', b),
      logout: () => call('logout/', {}),
      apps: () => call('apps/'),
      app: (id: string) => call(`app/?id=${encodeURIComponent(id)}`),
      invite: (b: any) => call('invite/', b),
      resend: (id: string) => call('resend/', { id }),
      decide: (b: any) => call('decide/', b),
      notes: (b: any) => call('notes/', b),
      delete: (b: any) => call('delete/', b),
      fileUrl: (id: string, fileId: string) => kybUrl('admin', `file/?id=${encodeURIComponent(id)}&fileId=${encodeURIComponent(fileId)}`),
      sigUrl: (id: string) => kybUrl('admin', `file/?id=${encodeURIComponent(id)}&sig=1&inline=1`),
    };

// ---------- 视图 ----------
const views = [...root.querySelectorAll<HTMLElement>('[data-view]')];
const panels = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
const showView = (v: string) => views.forEach((x) => (x.hidden = x.dataset.view !== v));
const showPanel = (p: string) => {
  panels.forEach((x) => (x.hidden = x.dataset.panel !== p));
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => (b.dataset.tab === p || (p === 'detail' && b.dataset.tab === 'apps') ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  window.scrollTo({ top: 0 });
};
function toast(msg: string) { const t = $('[data-toast]'); t.textContent = msg; t.hidden = false; setTimeout(() => (t.hidden = true), 3000); }
const statusBadge = (s: string) => el('span', `status st-${s}`, STATUS[s] || s);
const errText = (e: unknown) => ({ bad_credentials: '密码或动态码不正确。', locked: '连续输错次数过多，已锁定 15 分钟。', bad_setup_token: '初始化口令不正确。', weak_password: '密码至少 12 位。', bad_code: '动态码不正确，请重试。', expired: '初始化超时，请重新开始。' } as Record<string, string>)[(e as ApiError).body?.error] || '操作失败，请稍后重试。';

// ---------- 初始化与登录 ----------
let setupToken = '';
$('[data-setup]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const er = $('[data-setup-err]');
  const pw = $<HTMLInputElement>('#s-pw').value;
  if (pw.length < 12) { er.textContent = '密码至少 12 位。'; er.hidden = false; return; }
  if (pw !== $<HTMLInputElement>('#s-pw2').value) { er.textContent = '两次输入的密码不一致。'; er.hidden = false; return; }
  setupToken = $<HTMLInputElement>('#s-token').value;
  try {
    const r = await call('setup-begin/', { setupToken, password: pw });
    $<HTMLImageElement>('[data-qr]').src = r.qr;
    $('[data-secret]').textContent = r.secret;
    $('[data-setup]').hidden = true; $('[data-setup2]').hidden = false;
  } catch (err) { er.textContent = errText(err); er.hidden = false; }
});
$('[data-setup2]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const er = $('[data-setup2-err]');
  try { await call('setup-confirm/', { setupToken, code: $<HTMLInputElement>('#s-otp').value.trim() }); toast('初始化完成，请登录。'); showView('login'); }
  catch (err) { er.textContent = errText(err); er.hidden = false; }
});
$('[data-login]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const er = $('[data-login-err]');
  try {
    await A.login({ password: $<HTMLInputElement>('#a-pw').value, code: $<HTMLInputElement>('#a-otp').value.trim() });
    $<HTMLInputElement>('#a-pw').value = ''; $<HTMLInputElement>('#a-otp').value = ''; er.hidden = true;
    await enterApp();
  } catch (err) { er.textContent = errText(err); er.hidden = false; }
});
$('[data-logout]').addEventListener('click', async () => { await A.logout().catch(() => {}); showView('login'); });
// 收付款的标签（p- 开头）由 admin-pay.ts 渲染，这里只切换面板
// 走查：原来先等接口返回再切换页面——接口慢时点了没反应，等数据回来又把人从别的页面拉回来；接口出错时一直停在原页面。
// 改成：点了马上切换；0.3 秒还没好显示"加载中"；出错时在页面顶部显示原因和"重试"
const panelNote = (p: string) => {
  const panel = $(`[data-panel="${p}"]`);
  let n = panel.querySelector<HTMLElement>(':scope > [data-panel-note]');
  if (!n) { n = el('div', '', ''); n.dataset.panelNote = ''; panel.prepend(n); }
  return n;
};
async function openListTab(p: string) {
  showPanel(p);
  const note = panelNote(p);
  const slow = window.setTimeout(() => { note.className = 'muted'; note.textContent = '加载中……'; note.hidden = false; }, 300);
  try { await renderList(); note.hidden = true; }
  catch {
    const retry = el('button', 'btn btn-outline btn-sm', '重试') as HTMLButtonElement;
    retry.type = 'button'; retry.addEventListener('click', () => openListTab(p));
    note.className = 'alert'; note.replaceChildren('读取失败，请稍后重试。 ', retry); note.hidden = false;
  } finally { clearTimeout(slow); }
}
root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { const p = b.dataset.tab!; if (p.startsWith('p-')) showPanel(p); else openListTab(p); }));
// 登录后默认打开"概览"（收付款没有配置时，概览页会自动退回"开户申请"）
// 先切到概览再显示后台：否则数据加载期间用户点了别的页面，加载完又会被切回概览
// 开户申请读取失败时也进入后台（收付款的页面照常可用），失败的页面自己显示原因和"重试"
async function enterApp() {
  const res = await Promise.allSettled([renderList()]);
  showPanel('apps'); $<HTMLElement>('[data-tab="p-overview"]').click(); showView('app');
  res.forEach((r) => { if (r.status === 'rejected') console.warn('[admin] 开户申请读取失败', r.reason); });
}
// 导航上的数字：0 也显示（不再出现空圆圈）；悬停时说明数字的含义
function setCount(key: 'apps', n: number, meaning: string) {
  const b = $(`[data-count="${key}"]`);
  b.textContent = String(n);
  b.title = `${meaning}：${n}`;
  b.setAttribute('aria-label', b.title);
}

async function refreshAppsCount() {
  appsCache = (await A.apps()).apps;
  setCount('apps', appsCache.filter((a) => a.status === 'submitted').length, '待审核（已提交）');
}

// ---------- 列表 ----------
let filter = 'all';
let appsCache: any[] = [];
async function renderList() {
  appsCache = (await A.apps()).apps;
  const box = $('[data-filters]'); box.innerHTML = '';
  for (const [k, label] of [['all', '全部'], ...Object.entries(STATUS)]) {
    const n = k === 'all' ? appsCache.length : appsCache.filter((a) => a.status === k).length;
    const b = el('button', '', `${label} ${n}`) as HTMLButtonElement;
    b.type = 'button'; b.setAttribute('aria-pressed', String(filter === k));
    b.addEventListener('click', () => { filter = k; renderList().catch(() => toast('读取失败，请稍后重试。')); });
    box.appendChild(b);
  }
  setCount('apps', appsCache.filter((a) => a.status === 'submitted').length, '待审核（已提交）');
  const body = $('[data-apps-body]'); body.innerHTML = '';
  for (const a of appsCache.filter((x) => filter === 'all' || x.status === filter)) {
    const tr = el('tr');
    tr.append(el('td', '', a.ref), el('td', '', a.company));
    const st = el('td', 'status-cell'); st.appendChild(statusBadge(a.status)); if (a.flags?.sanctions) st.appendChild(sanctionsFlag()); tr.appendChild(st);
    tr.append(el('td', '', day(a.updatedAt)), el('td', '', a.retentionUntil ? day(a.retentionUntil) : '业务关系存续期间'));
    tr.tabIndex = 0;
    tr.dataset.ref = a.ref;
    tr.addEventListener('click', () => openDetail(a.id));
    tr.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') openDetail(a.id); });
    body.appendChild(tr);
  }
  if (!body.children.length) { const tr = el('tr'); const td = el('td', 'muted', '暂无申请'); (td as HTMLTableCellElement).colSpan = 5; tr.appendChild(td); body.appendChild(tr); }
}
// ---------- 对话框 ----------
const dlg = $<HTMLDialogElement>('[data-dialog]');
function dialog(title: string, body: HTMLElement, okText: string, onOk: () => void, danger = false) {
  $('[data-dialog-title]').textContent = title;
  const b = $('[data-dialog-body]'); b.innerHTML = ''; b.appendChild(body);
  const ok = $<HTMLButtonElement>('[data-dialog-ok]'); ok.textContent = okText; ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  dlg.returnValue = '';
  dlg.onclose = () => { if (dlg.returnValue === 'ok') onOk(); };
  dlg.showModal();
}
function inviteDialog(company: string, email: string, after?: () => void) {
  const body = el('div', 'stack');
  body.innerHTML = `<div class="f"><label for="i-co">企业名称</label><input id="i-co" /></div><div class="f"><label for="i-em">客户邮箱</label><input id="i-em" type="email" /></div><p class="hint m0">系统会生成一个 30 天有效的专属链接，并用你的邮箱发送给客户。</p>`;
  $<HTMLInputElement>('#i-co', body).value = company;
  $<HTMLInputElement>('#i-em', body).value = email;
  dialog('发送开户链接', body, '发送', async () => {
    try {
      const r = await A.invite({ company: $<HTMLInputElement>('#i-co', body).value, email: $<HTMLInputElement>('#i-em', body).value });
      toast(r.emailed ? `已创建 ${r.ref || ''} 并发送开户链接${PROTO ? '（原型：未实际发送）' : ''}` : '申请已创建，但邮件发送失败，请检查邮箱配置后点"重新发送链接"');
      await (after ? after() : renderList());
    } catch (err) { toast((err as ApiError).body?.fields ? '请填写正确的企业名称和邮箱' : errText(err)); }
  });
}
$('[data-new-invite]').addEventListener('click', () => inviteDialog('', ''));

// ---------- 详情 ----------
function kvCard(title: string, rows: [string, string][]) {
  const card = el('section', 'card section-card');
  card.appendChild(el('h3', '', title));
  const dl = el('dl', 'kv');
  for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
  card.appendChild(dl);
  return card;
}
const rowsOf = (labels: Record<string, string>, group: Record<string, any> = {}) => Object.keys(labels).filter((k) => applicable(k, group)).map((k) => [labels[k], fmt(k, group)] as [string, string]);
async function openDetail(id: string) {
  const r = await A.app(id);
  const a = r.app, f = r.form || {};
  const box = $('[data-detail-sections]'); box.innerHTML = '';
  const head = el('div', 'toolbar');
  head.append(el('h1', 'm0', a.company), statusBadge(a.status));
  if (f.entity?.sanctions === 'yes' || a.flags?.sanctions) head.appendChild(sanctionsFlag());
  box.appendChild(head);
  if (a.status === 'needs_info' && a.unlocked?.length) box.appendChild(el('p', 'notice', `已要求补件：${a.unlocked.map((s: string) => SECTION_NAMES[s]).join('、')}。客户再次提交后会通知你。`));
  if (!f.entity) {
    box.appendChild(el('p', 'notice', a.status === 'expired' ? '客户在链接有效期内没有提交。可以在右侧重新发送链接。' : '客户尚未填写，提交后可以查看完整资料。'));
  } else {
    box.appendChild(kvCard(SECTION_NAMES.entity, rowsOf(LABELS.entity, f.entity)));
    // 及以前的申请：公司联系方式和授权联系人是单独的两步
    if (f.contact) box.appendChild(kvCard(SECTION_NAMES.contact, rowsOf(LABELS.contact, f.contact)));
    if (f.rep) box.appendChild(kvCard(SECTION_NAMES.rep, rowsOf(LABELS.rep, f.rep)));
    const fileRow = (x: any) => {
      const row = el('div', 'file-link');
      const link = el('a', '', `${x.name} · ${x.size >= 1048576 ? (x.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(x.size / 1024)) + ' KB'}`) as HTMLAnchorElement;
      link.href = A.fileUrl(a.id, x.id);
      if (PROTO) link.addEventListener('click', (e) => { e.preventDefault(); toast('原型：正式版会通过后台函数安全下载'); });
      row.append(el('span', '', DOC_NAMES[x.legacyDoc || x.doc] || x.doc), link); // 整理过的旧文件显示原来的文件项名称
      return row;
    };
    const fileCard = (title: string, list: any[], empty: string) => {
      const c = el('section', 'card section-card'); c.appendChild(el('h3', '', title));
      if (!list.length) c.appendChild(el('p', 'muted m0', empty));
      list.forEach((x) => c.appendChild(fileRow(x)));
      return c;
    };
    // 公司文件：的公司文件和旧版的公司文件项（d1～d16）
    box.appendChild(fileCard('公司文件', r.files.filter((x: any) => !x.person && x.doc !== 'walletProof'), '没有上传（非必传）'));
    (f.people || []).forEach((p: any, i: number) => {
      const card = kvCard(`${SECTION_NAMES.people} · ${i + 1}. ${p.fullName || '—'}`, rowsOf(LABELS.person, p));
      const mine = r.files.filter((x: any) => x.person === p.pid);
      card.appendChild(el('h4', 'h-sm', '身份证明'));
      if (!mine.length) card.appendChild(el('p', 'muted m0', '没有上传'));
      mine.forEach((x: any) => card.appendChild(fileRow(x)));
      box.appendChild(card);
    });
    const walletProof = r.files.filter((x: any) => x.doc === 'walletProof');
    if (walletProof.length) box.appendChild(fileCard(DOC_NAMES.walletProof, walletProof, ''));
    box.appendChild(kvCard(SECTION_NAMES.wallet, rowsOf(LABELS.wallet, f.wallet)));
    const sc = kvCard(SECTION_NAMES.decl, [...rowsOf(LABELS.decl, f.decl), ['签署时间', dt(r.signature?.signedAt)], ['签署 IP', r.signature?.ip || '—']]);
    if (r.signature) { const img = el('img', 'sig-img') as HTMLImageElement; img.src = A.sigUrl(a.id); img.alt = '客户手写签名'; sc.appendChild(img); }
    box.appendChild(sc);
  }
  renderSide(r);
  showPanel('detail');
}
function renderSide(r: any) {
  const a = r.app;
  const side = $('[data-side]'); side.innerHTML = '';
  side.appendChild(el('h3', 'm0', '审核'));
  const dl = el('dl', 'kv');
  const info: Record<string, string> = {
    编号: a.ref, 客户邮箱: a.email, 发送链接: day(a.invitedAt), 链接有效期至: day(a.expiresAt), 提交时间: dt(a.submittedAt),
    收件日期: day(r.review?.received), 审核人: r.review?.reviewer || '—', 审核日期: day(r.review?.reviewDate),
    保留截止: a.retentionUntil ? day(a.retentionUntil) : '业务关系存续期间（结束后保留 5 年）',
  };
  for (const [k, v] of Object.entries(info)) dl.append(el('dt', '', k), el('dd', '', v));
  side.appendChild(dl);
  const notes = el('div', 'f');
  notes.innerHTML = '<label for="rv-notes">内部备注（客户看不到）</label><textarea id="rv-notes" rows="3"></textarea>';
  const ta = $<HTMLTextAreaElement>('textarea', notes); ta.value = r.review?.notes || '';
  ta.addEventListener('change', async () => { await A.notes({ id: a.id, notes: ta.value }); toast('备注已保存'); });
  side.appendChild(notes);
  if (a.status === 'approved') {
    const rel = el('div', 'f');
    rel.innerHTML = '<label for="rv-rel">业务关系结束日期（填写后开始计算 5 年保留期）</label><input id="rv-rel" type="date" />';
    const inp = $<HTMLInputElement>('input', rel); inp.value = a.relationshipEndedAt ? day(a.relationshipEndedAt) : '';
    inp.addEventListener('change', async () => { await A.notes({ id: a.id, relationshipEndedAt: inp.value || null }); toast('已保存'); openDetail(a.id); });
    side.appendChild(rel);
  }
  const act = (text: string, cls: string, fn: () => void, show = true) => { if (!show) return; const b = el('button', `btn ${cls}`, text) as HTMLButtonElement; b.type = 'button'; b.dataset.action = text; b.addEventListener('click', fn); side.appendChild(b); };
  // 审核后同时刷新导航上的数字（不用刷新页面，"开户申请"的待审核数量就会变）
  const after = async (msg: string) => { toast(msg); await Promise.all([openDetail(a.id), refreshAppsCount()]); };
  const canReview = a.status === 'submitted';
  act('通过', 'btn-primary', () => dialog('确认通过', el('p', 'm0', `确认通过 ${a.company} 的开户申请？之后请线下完成开户。`), '通过', async () => { await A.decide({ id: a.id, action: 'approve' }); await after('已通过'); }), canReview);
  act('要求补件', 'btn-outline', () => {
    const body = el('div', 'stack');
    body.appendChild(el('p', 'm0', '勾选需要客户修改的部分。客户只能修改这些部分，并需要重新签名提交。'));
    const ch = el('div', 'choices');
    for (const k of NEEDS_INFO_SECTIONS) { const v = SECTION_NAMES[k]; const l = el('label'); const i = document.createElement('input'); i.type = 'checkbox'; i.value = k; l.append(i, v); ch.appendChild(l); }
    body.appendChild(ch);
    const msg = el('div', 'f'); msg.innerHTML = '<label for="ni-msg">给客户的说明（会写进邮件）</label><textarea id="ni-msg" rows="3"></textarea>'; body.appendChild(msg);
    dialog('要求补件', body, '发送补件通知', async () => {
      const sections = [...ch.querySelectorAll<HTMLInputElement>('input:checked')].map((x) => x.value);
      if (!sections.length) { toast('请至少勾选一个部分'); return; }
      const res = await A.decide({ id: a.id, action: 'needs_info', sections, message: $<HTMLTextAreaElement>('#ni-msg', body).value });
      await after(res.emailed ? '已发送补件通知' : '状态已更新，但邮件发送失败，请检查邮箱配置');
    });
  }, canReview);
  act('拒绝', 'btn-outline', () => dialog('确认拒绝', el('p', 'm0', `确认拒绝 ${a.company} 的申请？`), '拒绝', async () => { await A.decide({ id: a.id, action: 'reject' }); await after('已拒绝'); }, true), canReview);
  act('重新发送链接', 'btn-outline', async () => { const res = await A.resend(a.id); await after(res.emailed ? '已重新发送，旧链接已失效' : '链接已更新，但邮件发送失败'); }, ['invited', 'in_progress', 'expired', 'needs_info'].includes(a.status));
  act('删除申请', 'btn-outline', () => {
    const body = el('div', 'stack'); body.innerHTML = '<p class="m0">删除后，申请和全部文件都无法恢复。请输入编号 <b></b> 确认。</p><div class="f"><input aria-label="输入编号确认" /></div>';
    $('b', body).textContent = a.ref;
    dialog('删除申请', body, '永久删除', async () => {
      const v = $<HTMLInputElement>('input', body).value.trim();
      if (v !== a.ref) { toast('编号不一致，未删除'); return; }
      await A.delete({ id: a.id, confirmRef: v }); await renderList(); showPanel('apps'); toast('已删除');
    }, true);
  });
  const lg = el('div'); lg.appendChild(el('h3', 'm0', '操作记录'));
  const ul = el('ul', 'timeline-mini');
  for (const x of r.audit || []) ul.appendChild(el('li', '', `${dt(x.at)} ${AUDIT[x.action] || x.action}${x.detail ? '：' + x.detail : ''}`));
  lg.appendChild(ul);
  side.appendChild(lg);
}
$('[data-back-list]').addEventListener('click', () => openListTab('apps'));

// ---------- 启动 ----------
(async () => {
  try {
    const me = await A.me();
    if (!me.initialized) showView('setup');
    else if (me.authed) await enterApp();
    else showView('login');
  } catch {
    showView('login');
    const er = $('[data-login-err]'); er.textContent = '后台暂时无法连接，请检查服务配置。'; er.hidden = false;
  }
})();
