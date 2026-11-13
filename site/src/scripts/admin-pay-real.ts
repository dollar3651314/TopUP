// 运营后台的收付款部分（正式模式：测试环境和生产）。接口：/api/wallet/?a=<动作>。
// 签名在这个页面里完成：
//   ① 服务器给出待签名的交易原文 → ② 页面自己解码、按规则核对（server/pay/verify.js）
//   ③ 管理员输入验证码（先交给服务器验证）→ ④ 页面用私钥或助记词签名，只把签名交给服务器
// 私钥和助记词只在函数里用一次，签名后清空输入框；页面不写入浏览器存储，也不发给任何地址。
import { mnemonicToSeedSync, validateMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import wallets from '../../../config/wallets.json';
import { checkStep } from '../../../server/pay/verify.js';
import { signTxId, addressOfPrivateKey, keyForAddress } from '../../../server/pay/signing.js';
import { decodeRaw } from '../../../server/pay/txcodec.js';
import { describeFee, fmtUsdt, parseUsdt, shortAddr } from '../lib/money';
import { copyBtn, field, fieldErr, fmtTime, h, mono, stat, status, table, toast } from './ui';
import { dialog, feeInputs, modeInputs, modeText, tronscan, minsAgo, TRONSCAN } from './admin-pay';
import { mountOverview } from './admin-overview';
import { pickSweepChain, renderEvmSweep, renderRoutes, walletBadges, walletStatus, walletTodo, type WalletUi } from './admin-wallet';

const root = document.getElementById('admin-root')!;
const PROTO = root.dataset.prototype === '1';
const ENV = (root.dataset.walletEnv || 'local') as 'production' | 'staging' | 'local';
const RULES = { hot: wallets[ENV].hot, cold: wallets[ENV].cold, usdt: wallets[ENV].usdt };
const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
const say = (m: string) => toast(root, '[data-toast]', m);
const t = (iso?: string | null) => (iso ? fmtTime(iso, 'zh') : '—');
const u = (v: unknown) => { const s = String(v ?? '0'); const neg = s.startsWith('-'); return (parseUsdt(neg ? s.slice(1) : s) ?? 0) * (neg ? -1 : 1); };
const usd = (v: unknown) => fmtUsdt(u(v));
const ACCOUNT = "m/44'/195'/0'";
const toolbar = (title: string, ...right: (HTMLElement | null)[]) => h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, title), h('div', { class: 'tool-actions' }, ...right));

class WErr extends Error { constructor(public code: string, public field?: string) { super(code); } }
const ERR: Record<string, string> = {
  internal_error: '服务器出错了，请稍后重试。如果一直出错，看"系统状态"或服务器日志。', http_500: '服务器出错了，请稍后重试。', http_502: '服务器暂时连不上，请稍后重试。', http_503: '服务暂时不可用，请稍后重试。', http_504: '服务器响应超时，请稍后重试。',
  bad_code: '动态码不正确或已经用过，请等下一个动态码。', hot_wallet_insufficient: '热钱包的 USDT 不够，请先归集。', verify_required: '验证码已过期，请重新签名。', bad_signature: '签名和交易的付款地址不一致。',
  invalid_state: '状态已经变化，请刷新后再试。', nothing_to_sweep: '选中的地址在链上已经没有 USDT。', sweep_in_progress: '有地址正在归集中，请等上一次完成。', cold_wallet_not_configured: '还没有配置冷钱包地址。',
  already_initialized: '已经初始化过了。', first_address_mismatch: '服务器算出的第 1 个地址和浏览器不一致，已停止。', private_key_not_allowed: '只能提交公钥。', invalid_fee: '手续费格式不对。', invalid_order_mode: '订单模式的设置超出范围。',
  invalid_address: 'TRON 地址格式不对。', not_configured: '收付款还没有配置好（数据库、TronGrid 等），请先在服务器上完成配置（看"系统状态"里哪一项没配置）。', unauthorized: '登录已过期，请重新登录。',
};
const errText = (e: unknown) => ERR[(e as WErr).code] || `操作失败（${(e as WErr).code || '网络错误'}），请稍后重试。`;
async function call(a: string, body?: unknown, qs = '') {
  const res = await fetch(`/api/wallet/?a=${a}${qs}`, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new WErr(d?.error?.code || `http_${res.status}`, d?.error?.field);
  return d;
}

const render: Record<string, (p: HTMLElement) => Promise<void>> = {};
/** 合约钱包部分（admin-wallet.ts）用的工具：rerender 重画当前标签 */
const wui = (tab: string): WalletUi => ({ call, dialog, say, errText, rerender: () => show(tab), go: (x) => root.querySelector<HTMLElement>(`[data-tab="${x}"]`)?.click() });
async function show(tab: string) {
  const p = $(`[data-panel="${tab}"]`);
  // 走查：接口慢时页面一片空白。0.3 秒还没好就显示"加载中"；出错时显示原因和"重试"
  const switching = p.dataset.shown !== '1';
  const slow = switching ? window.setTimeout(() => p.replaceChildren(h('p', { class: 'muted', 'data-loading': '' }, '加载中……')), 300) : 0;
  try { await render[tab.slice(2)](p); p.dataset.shown = '1'; } catch (e) {
    p.dataset.shown = '';
    p.replaceChildren(h('div', { class: 'alert', 'data-load-error': '' }, errText(e), ' ', h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => show(tab) }, '重试')));
  } finally { clearTimeout(slow); }
  counts();
}
const v2 = (x: string) => `${x}有失败、部分成功或手续费不够，要处理`;
async function counts() {
  const set = (k: string, n: number | null, meaning: string) => {
    const b = root.querySelector<HTMLElement>(`[data-pcount="${k}"]`);
    if (!b) return;
    b.textContent = n === null ? '' : String(n); // 读取失败时不显示（CSS 隐藏空的数字），不出现空圆圈
    b.title = n === null ? '' : `${meaning}：${n}`;
  };
  // 三个数字分别读取：一个失败不影响其他两个
  const jobs: [string, string, () => Promise<number>][] = [
    ['merchants', '已开通的商户', async () => (await call('merchants')).merchants.filter((x: any) => x.status === 'active').length],
    ['withdrawals', '待审核的提币', async () => (await call('withdrawals')).items.length],
    ['anomalies', '未处理的异常到账', async () => (await call('anomalies')).items.filter((x: any) => !x.handled).length],
  ];
  await Promise.all([...jobs.map(async ([k, meaning, f]) => {
    try { set(k, await f(), meaning); } catch (e) { set(k, null, meaning); console.warn(`[admin] 导航数字 ${k} 读取失败：${(e as WErr).code || e}`); }
  }),
  // 归集、系统状态的角标（"!" 表示有出错要处理）
  walletBadges(wui('p-overview')).then((b) => {
    for (const [k, v, meaning] of [['sweep', b.sweep, v2('归集')], ['status', b.status, '系统状态有链不正常']] as [string, string | null, string][]) {
      const el = root.querySelector<HTMLElement>(`[data-pcount="${k}"]`);
      if (!el) continue;
      el.textContent = v ?? ''; el.classList.toggle('badge-bad', v === '!'); el.title = v === '!' ? meaning : v ? `等你确认的归集批次：${v}` : '';
    }
  }).catch(() => {})]);
}
if (!PROTO) {
  root.querySelectorAll<HTMLElement>('[data-tab^="p-"]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab!)));
  // 登录后刷新导航上的数字
  new MutationObserver(() => { if (!$('[data-view="app"]').hidden) counts(); }).observe($('[data-view="app"]'), { attributes: true, attributeFilter: ['hidden'] });
  // 页面打开时已经是登录状态（观察者注册之前就显示了后台）：也读取一次
  if (!$('[data-view="app"]').hidden) counts();
}

// ============ 签名 ============
interface Step { kind: string; stage: number; rawHex: string; txID: string; expect?: { to: string; amount: number }; withdrawal_id?: string; amount?: number }
interface SignJob { title: string; batchId: string; cols: string[]; rows: { cells: (string | Node)[]; steps: Step[]; index?: number; address?: string }[]; needMnemonic: boolean; summary: [string, string][]; onDone: (r: any) => void }
const KIND: Record<string, string> = { withdraw: '打款 USDT', fee_trx: '补 TRX 手续费', delegate: '借出能量', sweep_usdt: '转出 USDT', undelegate: '收回能量' };

function signDialog(job: SignJob) {
  // 第一遍核对：不需要私钥。归集时"付款地址"要用助记词推导，这里先按服务器给的地址显示，签名时再用助记词核对一次
  const results = job.rows.map((r) => r.steps.map((s) => checkStep(s, s.kind === 'withdraw' ? s.expect! : s.kind === 'sweep_usdt' ? { from: r.address! } : { to: r.address! }, RULES)));
  const bad = results.flat().filter((x) => !x.ok);
  const detail = (s: Step, i: number, j: number) => {
    const r = results[i][j];
    const c = r.decoded?.contracts?.[0];
    const what = !c ? '' : s.kind === 'withdraw' || s.kind === 'sweep_usdt' ? `${fmtUsdt(c.amount ?? 0)} USDT → ${shortAddr(c.to || '')}` : s.kind === 'fee_trx' ? `${fmtUsdt(c.amount ?? 0, 0)} TRX → ${shortAddr(c.to || '')}` : `${fmtUsdt(c.amount ?? 0, 0)} TRX 的能量 · ${shortAddr(c.to || '')}`;
    return h('li', {}, `${KIND[s.kind] || s.kind}：${what} `, r.ok ? h('span', { class: 'ok' }, '✓ 一致') : h('span', { class: 'bad' }, `✗ ${r.error}`));
  };
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
  const mn = h('textarea', { rows: '3', autocomplete: 'off', spellcheck: false, class: 'mono-input' }) as HTMLTextAreaElement;
  const hot = h('input', { type: 'password', autocomplete: 'off', spellcheck: false, class: 'mono-input' }) as HTMLInputElement;
  const body = h('div', { class: 'stack' },
    h('p', { class: 'hint muted m0' }, '下面每一行的内容，都是浏览器自己从交易原文里解码出来的，并按规则逐项核对（收款地址只能是写在代码里的热钱包或冷钱包）。'),
    table([...job.cols, '浏览器核对'], job.rows.map((r, i) => [...r.cells, h('ul', { class: 'plain-list' }, ...r.steps.map((s, j) => detail(s, i, j)))]), '—'),
    bad.length ? h('p', { class: 'alert m0' }, '有交易没通过核对，页面已拦下，不能签名。请不要继续，并检查服务器是否被篡改。') : null,
    h('dl', { class: 'kv kv-tight' }, ...job.summary.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, h('b', {}, v))])),
    h('p', { class: 'hint muted m0' }, `热钱包：${RULES.hot || '（没有配置）'}${RULES.cold ? ` · 冷钱包：${RULES.cold}` : ''}。大额打款前，可以在 Tronscan 上再核对一次收款地址。`),
    field('ps-code', '验证器动态码（6 位）', code),
    job.needMnemonic ? field('ps-mn', '主助记词（只在本页面使用，签名后立即清除，不会发送给服务器）', mn) : null,
    field('ps-hot', '热钱包的私钥或助记词（64 位十六进制的私钥，或 TronLink 里这个钱包的 12/24 个单词；只在本页面使用，签名后立即清除，不会发送给服务器）', hot),
  );
  const ok = $<HTMLButtonElement>('[data-pdialog-ok]');
  dialog(job.title, body, '签名并广播', async () => {
    if (bad.length) return false;
    let err = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : '请输入 6 位动态码');
    const hotIn = hot.value;
    err = fieldErr(hot, hotIn.trim() ? null : '请输入热钱包的私钥或助记词') || err;
    const words = mn.value.trim().toLowerCase().split(/\s+/).join(' ');
    if (job.needMnemonic) err = fieldErr(mn, validateMnemonic(words, wordlist) ? null : '助记词不正确（检查单词和顺序）') || err;
    if (err) return false;
    ok.disabled = true;
    try {
      // 私钥或助记词都可以：助记词时在浏览器里推导，找出热钱包地址的私钥
      const kr = await keyForAddress(hotIn, RULES.hot);
      if (!kr.key) { fieldErr(hot, { format: '请输入 64 位十六进制的私钥，或 12/24 个单词的助记词', mnemonic: '助记词不正确（检查单词和顺序）', mismatch: '这个私钥对应的地址不是热钱包', not_found: '这组助记词里找不到热钱包地址（前 20 个账户都不是）' }[kr.error]); return false; }
      const hotKey = kr.key;
      const acct = job.needMnemonic ? HDKey.fromMasterSeed(mnemonicToSeedSync(words)).derive(ACCOUNT) : null;
      // 签名前先把验证码交给服务器验证
      try { await call('sign-verify', { batch_id: job.batchId, code: code.value.trim() }); } catch (e) { fieldErr(code, errText(e)); return false; }
      const signatures: Record<string, string> = {};
      for (const r of job.rows) {
        let addrKey: Uint8Array | null = null;
        if (acct && r.index !== undefined) {
          addrKey = acct.deriveChild(0).deriveChild(r.index).privateKey!;
          if (addressOfPrivateKey(addrKey) !== r.address) { fieldErr(mn, `助记词推导出的第 ${r.index} 个地址和要归集的地址不一致，已停止`); return false; }
        }
        for (const s of r.steps) {
          const owner = decodeRaw(s.rawHex).contracts[0].owner;
          const key = owner === RULES.hot ? hotKey : addrKey;
          if (!key || addressOfPrivateKey(key) !== owner) { fieldErr(hot, '找不到这笔交易付款地址的私钥'); return false; }
          signatures[s.txID] = signTxId(s.txID, key);
        }
      }
      // 签完立即清除
      hot.value = ''; mn.value = ''; hotKey.fill(0);
      let res;
      try { res = await call('sign-submit', { batch_id: job.batchId, signatures }); } catch (e) { say(errText(e)); return true; }
      job.onDone(res);
      return true;
    } finally { ok.disabled = false; }
  });
}

// ============ 商户 ============
render.overview = async (p) => {
  const go = (tab: string, chain?: string) => { if (chain) pickSweepChain(chain); root.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.click(); };
  mountOverview(p, {
    db: async () => {
      try { return await call('overview'); } catch (e) {
        // 收付款还没有配置（例如只用开户功能的环境）：概览退回"开户申请"
        if ((e as WErr).code === 'not_configured') go('apps');
        throw e;
      }
    },
    chain: () => call('overview-chain'),
  }, go);
  // 第 1 批：最上面加"待处理"（按等了多久排，出错的排最前）；读取失败时显示"待处理读取失败 + 重试"，不显示"现在没事要做"
  const todo = await walletTodo(wui('p-overview')).catch(() => h('div', { class: 'alert', 'data-todo-error': '' }, '待处理读取失败。 ', h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => show('p-overview') }, '重试')));
  const head = p.querySelector('.toolbar'); if (head) head.after(todo); else p.prepend(todo);
};
render.routes = (p) => renderRoutes(wui('p-routes'), p);
render.merchants = async (p) => {
  const { merchants, pending } = await call('merchants');
  p.replaceChildren(
    toolbar('商户'),
    pending.length ? h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '开户已通过，待开通收付款'),
      table(['编号', '企业名称', '授权联系人邮箱', '提现钱包', ''], pending.map((a: any) => [a.ref, a.company, a.email || '—', a.cashout_wallets.length ? mono(shortAddr(a.cashout_wallets[0]), a.cashout_wallets[0]) : '—',
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openMerchant(a) }, '开通商户')]), '—')) : h('span'),
    table(['商户', '状态', '手续费（收款 / 付款）', '订单模式（下限–上限 · 过期 · 回看）', '可用余额', '客户数', 'API 提币', '登录账号'], merchants.map((m: any) => [
      m.name, status(m.status === 'active' ? 'approved' : 'expired', m.status === 'active' ? '已开通' : '已停用'), `${describeFee(m.fee_in)} / ${describeFee(m.fee_out)}`, modeText(m.order_mode),
      sub(usd(m.available), u(m.frozen) ? `冻结 ${usd(m.frozen)}` : ''), String(m.customers), m.ip_whitelist.length ? '已设白名单' : h('span', { class: 'muted' }, '未开放（没有白名单）'),
      m.users.map((x: any) => `${x.email}${x.active ? '' : '（未设置密码）'}`).join('，') || '—']), '暂无商户', { onRow: (i) => editMerchant(merchants[i]) }),
  );
};
function openMerchant(a: any) {
  const fin = feeInputs({ ppm: 10000, fixed: 0, min: 0 }, 'om-in', '收款手续费');
  const fout = feeInputs({ ppm: 0, fixed: 2_000_000, min: 0 }, 'om-out', '付款手续费');
  const mode = modeInputs({ enabled: true, low: 900_000, high: 1_100_000, ttlMin: 30, lookbackH: 24 }, 'om-mode');
  const email = h('input', { type: 'email', value: a.email || '' }) as HTMLInputElement;
  const langSel = h('select', {}, h('option', { value: 'zh' }, '中文'), h('option', { value: 'en' }, 'English')) as HTMLSelectElement;
  dialog(`开通商户：${a.company}`, h('div', { class: 'stack' }, field('om-email', '授权联系人邮箱（收设置密码的邮件）', email), field('om-lang', '邮件里的链接语言', langSel), fin.box, fout.box, mode.box,
    h('p', { class: 'hint muted m0' }, a.cashout_wallets.length ? `提现钱包：${a.cashout_wallets.join('、')}（来自开户表的钱包授权）` : '开户表里没有可用的提现钱包地址；需要时在商户设置里补充。')), '开通并发送邮件', async () => {
    const i = fin.read(), o = fout.read(), md = mode.read(); if (!i || !o || !md) return false;
    if (fieldErr(email, /@/.test(email.value) ? null : '请输入邮箱')) return false;
    try { await call('merchant-open', { name: a.company, kyb_ref: a.ref, email: email.value.trim(), lang: langSel.value, fee_in: i, fee_out: o, order_mode: md, cashout_wallets: a.cashout_wallets }); }
    catch (e) { say(errText(e)); return false; }
    say(`已开通 ${a.company}，并发送设置密码的邮件`); show('p-merchants');
  });
}
function editMerchant(m: any) {
  const fin = feeInputs(m.fee_in, 'em-in', '收款手续费'), fout = feeInputs(m.fee_out, 'em-out', '付款手续费');
  const mode = modeInputs(m.order_mode, 'em-mode');
  const active = h('input', { type: 'checkbox', checked: m.status === 'active' }) as HTMLInputElement;
  const wallets = h('textarea', { rows: '2', class: 'mono-input' }) as HTMLTextAreaElement; wallets.value = m.cashout_wallets.join('\n');
  const reEmail = h('input', { type: 'email', value: m.users[0]?.email || '' }) as HTMLInputElement;
  dialog(m.name, h('div', { class: 'stack' }, h('label', { class: 'check-row' }, active, '启用（停用后商户不能登录，API 返回 403，已分配的地址照常监控入账）'),
    fin.box, fout.box, mode.box, field('em-w', '已登记的提现钱包（每行一个）', wallets),
    h('div', { class: 'inline-form' }, field('em-re', '重新发送设置密码的邮件', reEmail), h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async () => {
      try { await call('merchant-reinvite', { id: m.id, email: reEmail.value.trim() }); say('已重新发送'); } catch (e) { say(errText(e)); }
    } }, '发送'))), '保存', async () => {
    const i = fin.read(), o = fout.read(), md = mode.read(); if (!i || !o || !md) return false;
    const ws = wallets.value.split('\n').map((x) => x.trim()).filter(Boolean);
    try { await call('merchant-save', { id: m.id, fee_in: i, fee_out: o, order_mode: md, status: active.checked ? 'active' : 'disabled', cashout_wallets: ws }); }
    catch (e) { fieldErr((e as WErr).field === 'cashout_wallets' ? wallets : reEmail, errText(e)); return false; }
    say('已保存。新的费率和订单模式从下一笔开始生效，已有记录不变。'); show('p-merchants');
  });
}

// ============ 客户 ============
let custQ = '', custM = '';
render.customers = async (p) => {
  const { merchants } = await call('merchants');
  const sel = h('select', { class: 'input-sm' }, h('option', { value: '' }, '全部商户'), ...merchants.map((m: any) => h('option', { value: m.id, selected: m.id === custM }, m.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { custM = sel.value; render.customers(p); });
  const q = h('input', { type: 'search', class: 'input-sm input-wide', placeholder: '客户标识、名称或地址', value: custQ }) as HTMLInputElement;
  q.addEventListener('change', () => { custQ = q.value.trim(); render.customers(p); });
  const { items } = await call('customers', undefined, `&q=${encodeURIComponent(custQ)}&merchant_id=${encodeURIComponent(custM)}`);
  p.replaceChildren(toolbar('客户', sel, q), h('p', { class: 'hint muted' }, '商户的客户由商户自己定义标识，每个客户一个永久地址。这里可以跨商户查找任意客户。'),
    table(['商户', '客户标识 · 名称', '地址', '累计收款（笔数）', '手续费', '未匹配', '未归集', '最近付款'], items.map((x: any) => [x.merchant, sub(mono(x.customer_id), x.name || ''), x.address ? mono(shortAddr(x.address), x.address) : h('span', { class: 'muted' }, '—'), sub(usd(x.total), `${x.count} 笔`), usd(x.fees), usd(x.unmatched), usd(x.onchain), t(x.last_payment_at)]),
      '没有找到客户', { onRow: (i) => customerDetail(items[i]) }));
};
async function customerDetail(x: any) {
  const r = await call('customer', undefined, `&merchant_id=${encodeURIComponent(x.merchant_id)}&customer_id=${encodeURIComponent(x.customer_id)}`);
  const OS: Record<string, string> = { pending: '等待付款', partial: '部分付款', completed: '已完成', overpaid: '超额付款', expired: '已过期', expired_partial: '部分付款（已过期）' };
  dialog(`${x.merchant} · ${x.customer_id}`, h('div', { class: 'stack' },
    h('dl', { class: 'kv' }, h('dt', {}, '地址'), h('dd', {}, r.customer.address ? h('span', { class: 'copy-row' }, mono(r.customer.address), tronscan(r.customer.address)) : h('span', { class: 'muted' }, '没有 TRON 地址（地址在客户发起充值时按链生成）')), h('dt', {}, '名称'), h('dd', {}, r.customer.name || '—'), h('dt', {}, '创建时间'), h('dd', {}, t(r.customer.created_at))),
    h('div', { class: 'stats' }, stat('累计收款', usd(r.customer.total), 'USDT'), stat('笔数', String(r.customer.count)), stat('手续费', usd(r.customer.fees), 'USDT'), stat('未匹配', usd(r.customer.unmatched), 'USDT')),
    h('h3', { class: 'h-sm m0' }, '订单'), table(['订单号', '金额', '已匹配', '状态', '创建'], r.orders.map((o: any) => [mono(o.order_no), usd(o.amount), usd(o.matched), OS[o.status] || o.status, t(o.created_at)]), '暂无'),
    h('h3', { class: 'h-sm m0' }, '到账'), table(['时间', '金额', '结果', '订单', '交易'], r.deposits.map((d: any) => [t(d.time), usd(d.amount), d.result === 'credited' ? '已入账' : '低于 1 USDT', d.order_no ? mono(d.order_no) : '—', mono(d.txid.slice(0, 10) + '…', d.txid)]), '暂无'),
  ), '关闭', null);
}

// ============ 提币审核 ============
const wdSel = new Set<string>();
let wdAll = false;
const WD: Record<string, [string, string]> = { pending: ['submitted', '待审核'], rejected: ['rejected', '已驳回'], cancelled: ['expired', '已取消'], signing: ['invited', '已批准'], broadcast: ['in_progress', '已广播'], completed: ['approved', '已完成'], failed: ['needs_info', '失败'] };
render.withdrawals = async (p) => {
  const r = await call('withdrawals', undefined, wdAll ? '&all=1' : '');
  const pend = r.items.filter((w: any) => w.status === 'pending');
  for (const id of [...wdSel]) if (!pend.some((w: any) => w.id === id)) wdSel.delete(id);
  const chosen = pend.filter((w: any) => wdSel.has(w.id));
  const need = chosen.reduce((s: number, w: any) => s + u(w.amount), 0);
  const hotUsdt = r.hot.usdt === null ? null : u(r.hot.usdt);
  const short = hotUsdt !== null && need > hotUsdt;
  const filters = h('div', { class: 'filters' },
    h('button', { type: 'button', 'aria-pressed': String(!wdAll), onclick: () => { wdAll = false; render.withdrawals(p); } }, `待审核 ${wdAll ? '' : r.items.length}`),
    h('button', { type: 'button', 'aria-pressed': String(wdAll), onclick: () => { wdAll = true; render.withdrawals(p); } }, '全部'));
  p.replaceChildren(
    toolbar('提币审核', h('span', { class: 'muted' }, `热钱包 ${hotUsdt === null ? '—' : fmtUsdt(hotUsdt)} USDT`)),
    h('p', { class: 'hint muted' }, '每一笔提币都要人工审核（后台和 API 发起的都一样）。有新的提币申请时，系统给你发邮件，1 分钟内的多笔合并成一封。商户看到的处理时效：东八区 8:00–23:00 内 1 小时处理。'),
    filters,
    table(['', '编号', '提交时间', '商户', '类型 · 来源', '客户', '收款地址', '金额（手续费）', '状态'], r.items.map((w: any) => {
      const isP = w.status === 'pending';
      const cb = h('input', { type: 'checkbox', class: 'check', checked: isP && wdSel.has(w.id), disabled: !isP, 'aria-label': `选择 ${w.id}` }) as HTMLInputElement;
      cb.addEventListener('change', () => { cb.checked ? wdSel.add(w.id) : wdSel.delete(w.id); render.withdrawals(p); });
      const st = h('span', { class: 'status-cell' }, status(...(WD[w.status] || ['submitted', w.status])));
      if (w.txid) st.append(h('a', { href: `${TRONSCAN}/#/transaction/${w.txid}`, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, w.txid.slice(0, 8) + '…'));
      if (w.reason) st.append(h('span', { class: 'hint muted' }, w.reason));
      return [cb, mono(w.id), sub(t(w.created_at), isP ? `已等待 ${minsAgo(w.created_at)}` : ''), w.merchant, `${w.kind === 'payout' ? '代付' : '商户提现'} · ${w.source === 'api' ? 'API' : '后台'}`, w.customer_id ? mono(w.customer_id) : '—', mono(shortAddr(w.to), w.to), sub(h('b', {}, usd(w.amount)), `手续费 ${usd(w.fee)}`), st];
    }), wdAll ? '暂无提币' : '暂无待审核的提币'),
    short ? h('p', { class: 'alert' }, `热钱包余额不足：已选 ${fmtUsdt(need)} USDT，热钱包只有 ${fmtUsdt(hotUsdt!)} USDT。请先归集，或少选几笔。`) : h('span'),
    !r.items.length ? h('span') : h('div', { class: 'sumbar' }, h('span', {}, '已选 ', h('b', {}, String(chosen.length)), ' 笔 · 合计打出 ', h('b', {}, `${fmtUsdt(need)} USDT`)),
      h('span', { class: 'sumbar-actions' },
        h('button', { type: 'button', class: 'btn btn-outline btn-on-dark', disabled: !chosen.length, onclick: () => rejectWd(chosen, p) }, '驳回'),
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !chosen.length || short || !RULES.hot, onclick: () => planWd(chosen, p) }, `批准并签名（${chosen.length} 笔）`))),
  );
};
function rejectWd(chosen: any[], p: HTMLElement) {
  const reason = h('textarea', { rows: '3' }) as HTMLTextAreaElement;
  dialog(`驳回 ${chosen.length} 笔提币`, h('div', { class: 'stack' }, field('pr-reason', '驳回原因（商户能看到）', reason), h('p', { class: 'hint muted m0' }, '驳回后，冻结的金额退回商户的可用余额，并发回调通知商户。')), '驳回', async () => {
    if (fieldErr(reason, reason.value.trim() ? null : '请填写驳回原因')) return false;
    for (const w of chosen) { try { await call('withdraw-reject', { id: w.id, reason: reason.value.trim() }); } catch (e) { say(`${w.id}：${errText(e)}`); } }
    wdSel.clear(); say('已驳回，冻结金额已退回'); render.withdrawals(p); counts();
  }, true);
}
async function planWd(chosen: any[], p: HTMLElement) {
  let plan;
  try { plan = await call('withdraw-plan', { ids: chosen.map((w) => w.id) }); } catch (e) { say(errText(e)); return; }
  const byId = Object.fromEntries(chosen.map((w) => [w.id, w]));
  // 核对用的期望值来自审核列表（收款地址、金额），页面显示的是解码出来的值
  const steps: Step[] = plan.steps.map((s: any) => ({ ...s, expect: { to: byId[s.withdrawal_id].to, amount: u(byId[s.withdrawal_id].amount) } }));
  signDialog({
    title: `签名并打款（${steps.length} 笔）`, batchId: plan.batch_id, cols: ['商户', '类型', '审核列表里的收款地址', '金额'], needMnemonic: false,
    rows: steps.map((s) => { const w = byId[s.withdrawal_id!]; return { cells: [w.merchant, w.kind === 'payout' ? '代付' : '商户提现', mono(w.to), usd(w.amount)], steps: [s] }; }),
    summary: [['合计打出', `${usd(plan.total)} USDT`], ['付款地址', `热钱包 ${shortAddr(RULES.hot)}`]],
    onDone: (r) => {
      const failed = r.results.filter((x: any) => x.status !== 'broadcast');
      say(failed.length ? `${failed.length} 笔广播失败，冻结金额已退回：${failed.map((x: any) => x.error).join('；')}` : `${r.results.length} 笔已广播，链上确认后自动完成`);
      wdSel.clear(); render.withdrawals(p); counts();
    },
  });
}

// ============ 归集 ============
const swSel = new Set<string>();
let swMin = '100', swTo: 'hot' | 'cold' = 'hot';
render.sweep = async (p) => {
  // 以太坊、BSC 合约钱包（第 1 批）在上面；下面是 TRON 已有地址的第 0 批方式（助记词签名，逐个地址）
  const evm = await renderEvmSweep(wui('p-sweep'));
  const [r, b] = await Promise.all([call('sweep-list'), call('batches')]);
  const min = parseUsdt(swMin) ?? 0;
  const rows = r.items.filter((x: any) => u(x.balance) >= min);
  const chosen = r.items.filter((x: any) => swSel.has(x.address));
  const minInput = h('input', { inputmode: 'decimal', value: swMin, class: 'input-sm' }) as HTMLInputElement;
  minInput.addEventListener('change', () => { swMin = minInput.value; render.sweep(p); });
  const toSel = h('select', { class: 'input-sm' }, h('option', { value: 'hot', selected: swTo === 'hot' }, '热钱包'), RULES.cold ? h('option', { value: 'cold', selected: swTo === 'cold' }, '冷钱包') : null) as HTMLSelectElement;
  toSel.addEventListener('change', () => { swTo = toSel.value as 'hot' | 'cold'; });
  const total = r.items.reduce((s: number, x: any) => s + u(x.balance), 0);
  const running = b.items.filter((x: any) => x.kind === 'sweep' && x.status !== 'done' && x.status !== 'planned');
  p.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, '归集'), h('span', { class: 'muted' }, '把收款地址里的 USDT 一批批转进冷钱包 · 半自动：系统凑批，你确认才执行')),
    evm,
    h('h2', { class: 'h-sm', id: 'sw-tron' }, 'TRON 已有地址（第 0 批方式：助记词签名、逐个地址）'),
    h('div', { class: 'toolbar tron-toolbar' }, h('span', { class: 'muted' }, 'TRON 合约钱包第 2 批上线；在那之前，已有 TRON 地址里的钱用这里归集。'), h('div', { class: 'tool-actions' }, h('label', { class: 'inline-label' }, '金额 ≥', minInput),
      h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { const all = rows.every((x: any) => swSel.has(x.address)); rows.forEach((x: any) => (all ? swSel.delete(x.address) : swSel.add(x.address))); render.sweep(p); } }, '全选 / 取消'))),
    h('div', { class: 'stats' }, stat('未归集总额（按账本）', fmtUsdt(total), `USDT · ${r.items.length} 个地址`), stat('热钱包可借出能量', r.energy_left === null ? '—' : Number(r.energy_left).toLocaleString('en'), `大约够 ${r.energy_left === null ? '—' : Math.floor(r.energy_left / r.energy_per_sweep)} 笔归集`)),
    running.length ? h('p', { class: 'note-box' }, `有 ${running.length} 批归集正在进行（每一步链上确认后自动进行下一步，大约每分钟推进一次）。`) : h('span'),
    table(['', '商户', '客户', '地址', 'USDT（按账本）', '最后到账', ''], rows.map((x: any) => {
      const cb = h('input', { type: 'checkbox', class: 'check', checked: swSel.has(x.address), 'aria-label': `选择 ${x.address}` }) as HTMLInputElement;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { cb.checked ? swSel.add(x.address) : swSel.delete(x.address); render.sweep(p); });
      return [cb, x.merchant, mono(x.customer_id), mono(shortAddr(x.address), x.address), h('b', {}, usd(x.balance)), t(x.last_payment_at), x.activated ? '' : h('span', { class: 'pill' }, '首次，含激活')];
    }), (() => {
      // 有地址只是低于筛选金额：说清楚，免得以为没有钱可以归集
      const below = r.items.filter((x: any) => u(x.balance) < min);
      return below.length ? `有 ${below.length} 个地址低于 ${swMin} USDT（合计 ${fmtUsdt(below.reduce((s: number, x: any) => s + u(x.balance), 0))} USDT），调低上面的"金额 ≥"就能看到。每次归集都要花费能量或 TRX，金额太小不划算。` : '暂无需要归集的地址';
    })()),
    h('p', { class: 'hint muted' }, '点"签名并归集"后，服务器向链上核实每个地址的实际余额，并根据热钱包的能量决定"借出能量"还是"转 TRX 燃烧"；签名框里会逐笔显示。'),
    !r.items.length ? h('span') : h('div', { class: 'sumbar' },
      h('span', {}, '已选 ', h('b', {}, String(chosen.length)), ' 个地址 · 合计约 ', h('b', {}, `${fmtUsdt(chosen.reduce((s: number, x: any) => s + u(x.balance), 0))} USDT`)),
      h('span', { class: 'sumbar-actions' }, '归集到：', toSel, h('button', { type: 'button', class: 'btn btn-primary', disabled: !chosen.length || !RULES.hot, onclick: () => planSweep(p) }, '签名并归集'))),
    b.items.filter((x: any) => x.kind === 'sweep').length ? h('h2', { class: 'h-sm' }, '最近的归集') : h('span'),
    b.items.some((x: any) => x.kind === 'sweep') ? table(['批次', '状态', '地址', '步骤'], b.items.filter((x: any) => x.kind === 'sweep').slice(0, 10).flatMap((x: any) => (x.items || []).map((it: any) => [mono(x.id), BATCH_ST[x.status] || x.status, mono(shortAddr(it.address), it.address),
      it.steps.map((s: any) => `${KIND[s.kind] || s.kind}：${STEP_ST[s.status] || s.status}`).join(' → ')])), '暂无') : h('span'),
  );
};
// 走查：批次和步骤的状态原来直接显示英文代码
const BATCH_ST: Record<string, string> = { planned: '等待签名', broadcasting: '广播中', stage1: '第 1 步进行中', stage2: '第 2 步进行中', stage3: '第 3 步进行中', done: '完成', failed: '失败', cancelled: '已取消' };
const STEP_ST: Record<string, string> = { pending: '等待', broadcasting: '广播中', planned: '等待', signed: '已签名', broadcast: '已广播', confirmed: '已确认', done: '完成', failed: '失败', skipped: '跳过' };
/** 表格里的一格：主要内容 + 下面一行小字 */
const sub = (main: string | HTMLElement, note: string | HTMLElement) => h('span', { class: 'cell-2' }, main, note ? h('span', { class: 'hint muted' }, note) : null);
const netName = (n: string) => (n === 'mainnet' ? 'TRON 主网（真实资金）' : n === 'nile' ? 'Nile 测试网' : n);
async function planSweep(p: HTMLElement) {
  let plan;
  try { plan = await call('sweep-plan', { addresses: [...swSel], to: swTo }); } catch (e) { say(errText(e)); return; }
  const dest = swTo === 'cold' ? '冷钱包' : '热钱包';
  signDialog({
    title: `签名并归集（${plan.items.length} 个地址）`, batchId: plan.batch_id, cols: ['商户 · 客户', '地址（序号）', '链上 USDT'], needMnemonic: true,
    rows: plan.items.map((it: any) => ({ cells: [`${it.merchant_id} · ${it.customer_id}`, `#${it.index} ${shortAddr(it.address)}`, usd(it.amount)], steps: it.steps, index: it.index, address: it.address })),
    summary: [['归集到', `${dest} ${shortAddr(swTo === 'cold' ? RULES.cold : RULES.hot)}`], ['合计', `${fmtUsdt(plan.items.reduce((s: number, it: any) => s + u(it.amount), 0))} USDT`], ['签名需要', '主助记词（收款地址）+ 热钱包私钥（补手续费、借出和收回能量）']],
    onDone: (r) => { const bad = r.items.filter((x: any) => x.error); say(bad.length ? `${bad.length} 个地址第 1 步失败：${bad.map((x: any) => x.error).join('；')}` : '第 1 步已广播，后面的步骤每分钟自动推进'); swSel.clear(); render.sweep(p); },
  });
}

// ============ 异常到账、对账 ============
const ANOM: Record<string, [string, string]> = { token: ['不支持的币', '不入账。需要时由你手动处理（例如联系商户后原路退回）'], below_min: ['低于 1 USDT', '不入账、不通知，只记录（防止垃圾转账）'], process_error: ['处理失败', '这笔到账没有入账，请联系研发处理（扫链没有因此停下）'] };
render.anomalies = async (p) => {
  const { items } = await call('anomalies');
  p.replaceChildren(toolbar('异常到账'), h('p', { class: 'hint muted' }, '不支持的币每天检查一次，最多晚 24 小时出现在这里。过期后才到的 USDT 不算异常：已入账，记为客户未匹配的到账。'),
    table(['时间', '类型', '商户', '客户', '地址', '金额', '系统的处理', ''], items.map((a: any) => [t(a.created_at), status(a.type === 'token' ? 'needs_info' : 'submitted', ANOM[a.type]?.[0] || a.type), a.merchant || '—', a.customer_id ? mono(a.customer_id) : '—', mono(shortAddr(a.address), a.address), a.amount,
      h('span', { class: 'hint' }, ANOM[a.type]?.[1] || ''), a.handled ? h('span', { class: 'muted' }, '已处理') : h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async () => { await call('anomaly-handle', { id: a.id }); render.anomalies(p); counts(); } }, '标记已处理')]), '暂无异常到账'));
};
render.recon = async (p) => {
  const r = await call('recon');
  // 立即对账：和每天的自动任务相同（对账、检查其他代币、提醒）。测试环境没有每天的自动任务，要用这个按钮
  const run = h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async () => {
    run.disabled = true; run.textContent = '正在对账…';
    try { await call('recon-run', {}); say('对账完成'); } catch (e) { say(errText(e)); }
    render.recon(p); counts();
  } }, '立即对账') as HTMLButtonElement;
  p.replaceChildren(toolbar('对账', run), h('p', { class: 'hint muted' }, '每天核对一次：链上实际持有的 USDT（客户地址 + 热钱包 + 冷钱包）应该等于商户余额之和 + 平台收取的手续费 + 低于 1 USDT 没有入账的钱。你从热钱包或冷钱包转出利润后，差额会是负数，属于正常。'),
    table(['日期', '商户余额合计', '链上合计', '手续费和未入账', '差额', '结果'], r.days.map((d: any) => [d.day, usd(d.balances), usd(d.chain), usd(d.fees), u(d.diff) ? h('b', { class: 'neg' }, usd(d.diff)) : '0.00',
      !d.detail.complete ? status('submitted', `只查了 ${d.detail.checked}/${d.detail.address_count ?? '—'} 个地址`) : u(d.diff) ? status('needs_info', '不一致') : status('approved', '一致')]), '暂无对账记录（每天自动对账一次，也可以点右上角的"立即对账"）'),
    h('h2', { class: 'h-sm' }, '按商户核对客户合计'),
    table(['商户', '商户收款合计', '客户收款合计', '结果'], r.merchants.map((m: any) => [m.name, usd(m.deposits_total), usd(m.customers_total), status(m.ok ? 'approved' : 'needs_info', m.ok ? '一致' : '不一致')]), '暂无'));
};

// ============ 钱包设置 ============
render.wallet = async (p) => {
  const w = await call('wallet');
  const acc = (x: any, name: string) => h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, name),
    x ? h('dl', { class: 'kv' }, h('dt', {}, '地址'), h('dd', {}, h('span', { class: 'copy-row' }, mono(x.address), copyBtn(() => x.address, '复制', '已复制', 'link-copy'), tronscan(x.address))),
      h('dt', {}, 'USDT'), h('dd', {}, x.error ? '查询失败' : usd(x.usdt)), h('dt', {}, 'TRX'), h('dd', {}, x.error ? '查询失败' : usd(x.trx))) : h('p', { class: 'm0 muted' }, '没有配置（config/wallets.json）'));
  p.replaceChildren(
    toolbar('钱包设置', h('span', { class: 'muted' }, `网络：${netName(w.network)}`)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '主助记词（收款地址）'),
      w.initialized ? h('dl', { class: 'kv' }, h('dt', {}, '状态'), h('dd', {}, status('approved', '已初始化')), h('dt', {}, '推导路径'), h('dd', {}, mono("m/44'/195'/0'/0/序号")),
        h('dt', {}, '公钥末 8 位'), h('dd', {}, mono(w.xpub_fingerprint)), h('dt', {}, '第 1 个地址（用来核对）'), h('dd', {}, mono(w.first_address)), h('dt', {}, '已分配地址'), h('dd', {}, `${w.customers} 个`))
        : h('div', { class: 'stack' }, h('p', { class: 'm0' }, '还没有初始化。初始化后才能给客户分配收款地址。'), h('div', {}, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => initWallet(p) }, '初始化主助记词'))),
      h('p', { class: 'hint muted m0' }, '系统只保存公钥，无法动用任何收款地址里的钱。助记词请离线抄写两份，分开保存。')),
    acc(w.hot, '热钱包'),
    w.energy ? h('p', { class: 'hint muted' }, `热钱包可借出能量 ${Number(w.energy.left).toLocaleString('en')} / ${Number(w.energy.limit).toLocaleString('en')}，大约够 ${Math.floor(w.energy.left / w.energy.per_sweep)} 笔归集。质押 TRX、增加能量：在 TronLink 或 Tronscan 里操作。`) : h('span'),
    acc(w.cold, '冷钱包'),
    h('p', { class: 'note-box' }, '热钱包和冷钱包的地址写在代码仓库的配置文件 config/wallets.json 里，签名页面只允许把钱归集到这两个地址。修改地址要提交 PR，服务器改不了。'),
  );
};
function initWallet(p: HTMLElement) {
  const words = generateMnemonic(wordlist, 256).split(' ');
  const pick = [3, 11, 20];
  dialog('初始化主助记词 · 第 1 步：抄写', h('div', { class: 'stack' },
    h('p', { class: 'alert m0' }, '这 24 个单词只显示这一次。请用纸笔（或金属板）按顺序抄写，抄两份，分开保存。不要拍照、截图，不要存进任何云端（包括 iCloud 密码）。丢了它，收款地址里还没归集的钱就取不出来。'),
    h('ol', { class: 'mnemonic' }, ...words.map((x) => h('li', {}, x)))), '我已抄写好', () => {
    const inputs = pick.map(() => h('input', { autocomplete: 'off', spellcheck: false }) as HTMLInputElement);
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
    setTimeout(() => dialog('初始化主助记词 · 第 2 步：确认', h('div', { class: 'stack' }, h('p', { class: 'm0' }, '为了确认抄对了，请填写下面几个位置的单词：'), ...inputs.map((inp, i) => field(`wi-${i}`, `第 ${pick[i]} 个单词`, inp)), field('wi-code', '验证器动态码（6 位）', code)), '确认并提交公钥', async () => {
      let bad = false;
      inputs.forEach((inp, i) => { bad = fieldErr(inp, inp.value.trim().toLowerCase() === words[pick[i] - 1] ? null : '不对，请对照抄写的内容') || bad; });
      bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : '请输入 6 位动态码') || bad;
      if (bad) return false;
      // 浏览器只算出账户级公钥（xpub）和第 1 个地址交给服务器；助记词不离开这个页面
      const acct = HDKey.fromMasterSeed(mnemonicToSeedSync(words.join(' '))).derive(ACCOUNT);
      const first = addressOfPrivateKey(acct.deriveChild(0).deriveChild(0).privateKey!);
      try { await call('wallet-init', { xpub: acct.publicExtendedKey, first_address: first, code: code.value.trim() }); }
      catch (e) { fieldErr(code, errText(e)); return false; }
      words.fill('');
      setTimeout(() => dialog('初始化完成', h('div', { class: 'stack' }, h('p', { class: 'm0' }, '浏览器只把公钥交给了服务器，助记词已从页面清除。'),
        h('dl', { class: 'kv' }, h('dt', {}, '第 1 个地址'), h('dd', {}, mono(first))), h('p', { class: 'hint muted m0' }, '建议用 TronLink 导入同一个助记词，确认第 1 个地址一致。')), '完成', () => { render.wallet(p); }), 0);
    }), 0);
  });
}

// ============ 系统状态 ============
render.status = async (p) => {
  const s = await call('status');
  const ago = s.tick ? Math.round((Date.now() - Date.parse(s.tick.at)) / 1000) : null;
  const pct = s.disk && s.disk.total_mb ? s.disk.used_mb / s.disk.total_mb : 0;
  const chains = await walletStatus(wui('p-status'));
  p.replaceChildren(
    toolbar('系统状态', h('span', { class: 'muted' }, `TRON 网络：${netName(s.network)}`)),
    chains,
    h('h2', { class: 'h-sm' }, 'TRON 链上监控、回调、磁盘'),
    h('div', { class: 'stats' },
      stat('链上监控最后一次运行', ago === null ? '从未运行' : ago < 120 ? `${ago} 秒前` : `${Math.round(ago / 60)} 分钟前`, ago !== null && ago > 300 ? '⚠️ 超过 5 分钟，请检查 worker 进程' : '每 15 秒一次（worker）'),
      stat('扫描到的时间点', s.cursor ? t(new Date(Number(s.cursor)).toISOString()) : '—', s.solid_block ? `链上最新已确认区块 ${Number(s.solid_block.number).toLocaleString('en')}` : 'TronGrid 暂时查询不到'),
      stat('回调队列', `${s.callbacks.waiting} 待发 · ${s.callbacks.retrying} 重试中`, `24 小时内放弃 ${s.callbacks.failed} 条`)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, '磁盘用量'),
      h('div', { class: 'quota' }, h('div', { class: 'quota-row' }, h('span', {}, '服务器磁盘'), h('meter', { min: '0', max: '1', low: '0.5', high: '0.7', optimum: '0', value: String(pct) }), h('span', { class: pct >= 0.7 ? 'neg' : '' }, s.disk ? `${s.disk.used_mb.toLocaleString('en')} / ${s.disk.total_mb.toLocaleString('en')} MB（${Math.round(pct * 100)}%）` : '读不到'))),
      h('p', { class: 'hint muted m0' }, `其中数据库 ${(s.db_bytes / 1048576).toFixed(1)} MB。TronGrid 的用量没有开放查询接口，请在它们的后台查看。磁盘用量达到 70%、链上监控超过 5 分钟没有运行，每日检查会发邮件提醒你。`)),
    s.tick ? h('details', {}, h('summary', {}, '最近一次运行的详情'), h('pre', { class: 'mono' }, JSON.stringify(s.tick, null, 2))) : h('span'),
  );
};
