// 开户资料的服务端校验。规则与前端（site/src/scripts/onboarding.ts）一致；服务端是最终依据。
// 4 个步骤。旧版的 contact、rep、docs 三步并入 entity、people，旧数据保留，只用于显示
export const SECTIONS = ['entity', 'people', 'wallet', 'decl'];
export const FORM_VERSION = 7;
// 文件只有两类。公司文件（选传，最多 20 个）和每位人员的身份证明（必传，1～3 个）。
// 旧版的文件项（d1～d16、护照、地址证明、钱包所有权证明）保留在已有申请里，后台照常可以下载
export const DOC_IDS = new Set(['company', 'id']);
export const MAX_COMPANY_FILES = 20;
export const MAX_ID_FILES = 3;
/** 文件属于哪一步（决定补件时能不能改） */
export const docSection = (doc) => (doc === 'company' || /^d\d+$/.test(doc) ? 'entity' : doc === 'walletProof' ? 'wallet' : 'people');
export const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PEOPLE = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-() ]{5,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 0 到 100，最多 2 位小数（UBO 的持股比例和投票权比例）
const PCT_RE = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const F = (type, required, extra = {}) => ({ type, required, ...extra });
const ENTITY = {
  legalName: F('text', true), tradingName: F('text', false), legalForm: F('text', true), regNumber: F('text', true),
  incDate: F('date', true, { past: true }), incPlace: F('text', true), regAddress: F('long', true), physAddress: F('long', true),
  // 公司联系方式并入企业信息；删除 LEI、税号、集团 / 母公司
  website: F('text', true), email: F('email', true), phone: F('tel', true),
  nature: F('multi', true, { options: ['export', 'manufacturing', 'b2b', 'cfd', 'securities', 'fx', 'other'] }), natureOther: F('text', false),
  // 业务用途改为 4 个选项、多选；月交易量去掉"其他"，50 万以上要写金额；新增币种和制裁声明
  purpose: F('multi', true, { options: ['crypto', 'exchange', 'deposits', 'other'] }), purposeOther: F('text', false),
  volume: F('choice', true, { options: ['lt50k', '50k-100k', '100k-500k', 'gt500k'] }), volumeAmount: F('text', false),
  currencies: F('multi', true, { options: ['usd', 'eur', 'usdt', 'usdc', 'btc', 'eth', 'other'] }), currenciesOther: F('text', false),
  markets: F('multi', true, { options: ['europe', 'na', 'latam', 'uk', 'me', 'apac', 'other'] }), marketsOther: F('text', false),
  sanctions: F('choice', true, { options: ['yes', 'no'] }), sanctionsDetails: F('long', false),
};
const PERSON = {
  // 授权联系人是人员的一个角色（必须有且只有 1 位）；证件不限护照；删除居住国
  roles: F('multi', true, { options: ['director', 'ubo', 'signatory', 'contact'] }), fullName: F('text', true), dob: F('date', true, { past: true }),
  nationality: F('text', true), address: F('long', true),
  idType: F('choice', true, { options: ['passport', 'id_card'] }), idNo: F('text', true), idCountry: F('text', true), idExpiry: F('date', true, { future: true }),
  ownershipPct: F('percent', false), votingPct: F('percent', false), // 勾选 UBO 时必填
  pep: F('choice', true, { options: ['yes', 'no'] }),
  pepDetails: F('long', false), email: F('email', false), phone: F('tel', false), // 只有授权联系人必填
};
const WALLET = {
  // 删除证件类型及号码、User ID、所有权证明
  clientName: F('text', true), email: F('email', true), address: F('text', true),
  network: F('choice', true, { options: ['tron', 'ethereum', 'other'] }), networkOther: F('text', false),
  use: F('choice', true, { options: ['deposit', 'withdrawal', 'both'] }),
  ownershipOk: F('bool', true), riskOk: F('bool', true),
};
const DECL = { repName: F('text', true), position: F('text', true), confirm: F('bool', true) };
export const SCHEMA = { entity: ENTITY, wallet: WALLET, decl: DECL };
/** 每一组的字段名（保存时用来保留旧版字段的数据） */
export const FIELD_NAMES = { entity: Object.keys(ENTITY), wallet: Object.keys(WALLET), decl: Object.keys(DECL), person: Object.keys(PERSON) };

/** 清洗单个字段：去掉未知字段、限制长度和类型。返回 [值, 错误码] */
function clean(spec, v, { strict, today }) {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || v === false;
  if (empty) return [spec.type === 'multi' ? [] : spec.type === 'bool' ? false : '', strict && spec.required ? 'required' : null];
  switch (spec.type) {
    case 'bool': return [v === true, v === true ? null : 'invalid'];
    case 'multi': {
      if (typeof v === 'string') v = [v]; // 旧版的单选值（例如业务用途 "deposits"）按一个选项处理
      if (!Array.isArray(v) || v.some((x) => !spec.options.includes(x))) return [[], 'invalid'];
      return [[...new Set(v)], null];
    }
    case 'choice': return spec.options.includes(v) ? [v, null] : ['', 'invalid'];
    default: {
      if (typeof v !== 'string') return ['', 'invalid'];
      const s = v.trim();
      const max = spec.type === 'long' ? 2000 : 300;
      if (s.length > max) return [s.slice(0, max), 'length'];
      if (CTRL_RE.test(s) || (spec.type !== 'long' && /[\r\n]/.test(s))) return ['', 'invalid'];
      if (spec.type === 'percent' && !PCT_RE.test(s)) return [s, 'percent'];
      if (spec.type === 'email' && !EMAIL_RE.test(s)) return [s, strict ? 'email' : null];
      if (spec.type === 'tel' && !PHONE_RE.test(s)) return [s, strict ? 'phone' : null];
      if (spec.type === 'date') {
        if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) return [s, strict ? 'date' : null];
        if (strict && spec.future && s <= today) return [s, 'future'];
        if (strict && spec.past && s > today) return [s, 'date'];
      }
      return [s, null];
    }
  }
}

function cleanGroup(specs, input, opts, prefix, errors) {
  const out = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const [k, spec] of Object.entries(specs)) {
    const [v, err] = clean(spec, src[k], opts);
    out[k] = v;
    if (err && (opts.strict || err === 'invalid' || err === 'length')) errors[`${prefix}.${k}`] = err;
  }
  // "其他"被选中时必须注明
  if (opts.strict) {
    for (const k of Object.keys(specs)) {
      const v = out[k];
      const picked = Array.isArray(v) ? v.includes('other') : v === 'other';
      if (picked && specs[`${k}Other`] && !out[`${k}Other`]) errors[`${prefix}.${k}Other`] = 'required';
    }
  }
  return out;
}

/**
 * 校验一个步骤的数据。strict=false 用于"保存草稿"（只拦截非法类型和超长内容），strict=true 用于"提交"。
 * 返回 { data, errors }
 */
export function validateSection(section, input, { strict = false, now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const opts = { strict, today };
  const errors = {};
  if (section === 'people') {
    const list = Array.isArray(input) ? input.slice(0, MAX_PEOPLE) : [];
    const data = list.map((p, i) => {
      const o = cleanGroup(PERSON, p, opts, `people.${i}`, errors);
      o.pid = typeof p?.pid === 'string' && /^[a-z0-9]{1,16}$/.test(p.pid) ? p.pid : String(i);
      if (strict && o.pep === 'yes' && !o.pepDetails) errors[`people.${i}.pepDetails`] = 'required';
      // 授权联系人的邮箱、电话必填
      if (strict && o.roles.includes('contact')) for (const k of ['email', 'phone']) if (!o[k]) errors[`people.${i}.${k}`] = 'required';
      // 只有 UBO 填写持股比例和投票权比例；不是 UBO 时清空，不保存
      if (o.roles.includes('ubo')) {
        for (const k of ['ownershipPct', 'votingPct']) if (strict && !o[k]) errors[`people.${i}.${k}`] = 'required';
      } else { o.ownershipPct = ''; o.votingPct = ''; delete errors[`people.${i}.ownershipPct`]; delete errors[`people.${i}.votingPct`]; }
      return o;
    });
    if (strict) {
      if (!data.some((p) => p.roles.includes('director')) || !data.some((p) => p.roles.includes('ubo')) || data.filter((p) => p.roles.includes('contact')).length !== 1) errors.people = 'people';
    }
    return { data, errors };
  }
  if (!SCHEMA[section]) return { data: null, errors: { _section: 'invalid' } };
  const data = cleanGroup(SCHEMA[section], input, opts, section, errors);
  if (section === 'entity') {
    // 按选择才需要填写的字段；不适用时清空
    if (data.volume === 'gt500k') { if (strict && !data.volumeAmount) errors['entity.volumeAmount'] = 'required'; } else data.volumeAmount = '';
    if (data.sanctions === 'yes') { if (strict && !data.sanctionsDetails) errors['entity.sanctionsDetails'] = 'required'; } else data.sanctionsDetails = '';
  }
  return { data, errors };
}

/** 提交前的整体校验：全部步骤 + 每位人员的身份证明（公司文件选传） */
export function validateForSubmit(form, files, now = Date.now()) {
  const errors = {};
  for (const s of SECTIONS) Object.assign(errors, validateSection(s, form?.[s], { strict: true, now }).errors);
  for (const p of form?.people || []) if (!files.some((f) => f.doc === 'id' && f.person === p.pid)) errors[`docs.id:${p.pid}`] = 'required';
  return errors;
}

/**
 * 把 及以前格式的申请（填写中、被要求补件的）整理成 4 步的格式。只改 payload，返回是否有改动；已经是 的不动。
 * - ② 公司联系方式的官网、邮箱、电话 → ① 企业信息
 * - ③ 授权联系人 → 一位人员，角色"授权联系人"（按邮箱或姓名找到已有的人员时，只加上这个角色）
 * - 人员的护照号码、签发国、到期日 → 证件号码、签发国、到期日（证件类型记为护照）
 * - 文件：护照 → 身份证明，公司文件项 d1～d16 → 公司文件；地址证明、钱包所有权证明保留但不再使用
 * 删掉的字段和旧的步骤数据都保留，后台照常显示
 */
export function upgradeToV7(payload) {
  const form = payload.form || (payload.form = {});
  if (form.v === FORM_VERSION) return false;
  const entity = (form.entity = { ...(form.entity || {}) });
  for (const k of ['website', 'email', 'phone']) if (entity[k] === undefined && form.contact?.[k] !== undefined) entity[k] = form.contact[k];
  const people = (form.people = (Array.isArray(form.people) ? form.people : []).map((p) => {
    const o = { ...p };
    if (o.idNo === undefined && (o.passportNo !== undefined || o.passportCountry !== undefined || o.passportExpiry !== undefined)) {
      o.idType = 'passport'; o.idNo = o.passportNo || ''; o.idCountry = o.passportCountry || ''; o.idExpiry = o.passportExpiry || '';
    }
    return o;
  }));
  const rep = form.rep;
  if ((rep?.name || rep?.email) && !people.some((p) => (p.roles || []).includes('contact'))) {
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && String(a || '').trim() !== '';
    const hit = people.find((p) => same(p.email, rep.email)) || people.find((p) => same(p.fullName, rep.name));
    if (hit) {
      hit.roles = [...new Set([...(hit.roles || []), 'contact'])];
      if (!hit.email) hit.email = rep.email || '';
      if (!hit.phone) hit.phone = rep.phone || '';
    } else {
      const next = String(people.reduce((m, p) => Math.max(m, Number(p.pid) + 1 || 0), 0));
      people.push({ pid: next, roles: ['contact'], fullName: rep.name || '', email: rep.email || '', phone: rep.phone || '' });
    }
  }
  payload.files = (payload.files || []).map((f) => (f.doc === 'passport' ? { ...f, doc: 'id' } : /^d\d+$/.test(f.doc) ? { ...f, doc: 'company', legacyDoc: f.doc } : f));
  form.v = FORM_VERSION;
  return true;
}

/** 旧版补件时开放的步骤名 → 新步骤名 */
export function mapUnlocked(sections = []) {
  const map = { contact: ['entity'], rep: ['people'], docs: ['entity', 'people'] };
  return [...new Set(sections.flatMap((s) => map[s] || [s]))].filter((s) => SECTIONS.includes(s));
}

/** 保存某一步时，把旧版字段（已删除的字段）的数据带过来，不丢。人员按 pid 对应 */
export function keepLegacy(section, old, clean) {
  const known = section === 'people' ? FIELD_NAMES.person : FIELD_NAMES[section];
  const legacy = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).filter(([k]) => !known.includes(k) && k !== 'pid'));
  if (section !== 'people') return { ...legacy(old), ...clean };
  const byPid = new Map((Array.isArray(old) ? old : []).map((p) => [p?.pid, p]));
  return clean.map((p) => ({ ...legacy(byPid.get(p.pid)), ...p }));
}
