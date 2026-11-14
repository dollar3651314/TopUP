// 运营后台"概览"（登录后的首页）：资金、待处理、待归集、业务趋势、系统状态。
// 页面先显示出来（数字为"—"），数据分两批加载，哪一批先回来就先填上（超时就显示"—"，有手动刷新）：
//   ① 数据库统计（/api/wallet/?a=overview）  ② 链上余额、利润、开户数据（/api/wallet/?a=overview-chain）
// 每一批最多等 20 秒。原型模式用 admin-pay.ts 里的示例数据，页面由这里统一渲染。
// 金额都是字符串（例如 "1234.50"）；没有数据时是 null 或者不存在，显示"—"。
import { fmtUsdt, parseUsdt } from '../lib/money';
import { h, stat, table } from './ui';

type Amt = string | null | undefined;
type Num = number | null | undefined;
type Period = { amount: Amt; count: Num; fees_in: Amt; active_merchants: Num; new_customers: Num; orders_done: Num; orders_closed: Num };
export interface OverviewData {
  funds: Partial<{
    collected_total: Amt; deposit_count: Num; owed_total: Amt; owed_available: Amt; owed_frozen: Amt;
    assets_total: Amt; unswept_total: Amt; hot_usdt: Amt; cold_usdt: Amt; cold_configured: boolean;
    profit_total: Amt; profit_now: Amt; profit_after_sweep: Amt; income_fee_in: Amt; income_fee_out: Amt; income_dust: Amt;
    by_chain: Record<string, Partial<{ hot_usdt: Amt; cold_usdt: Amt; hot_enabled: boolean }>>;
  }>;
  todo: Partial<{ withdrawals_count: Num; withdrawals_amount: Amt; kyb_pending: Num; merchants_to_open: Num; anomalies: Num; callbacks_failed: Num }>;
  sweep: Partial<{ unswept_total: Amt; address_count: Num; over_threshold: Num; over_threshold_total: Amt; threshold: Amt; hot_trx: Amt; energy_left: Num; energy_per_sweep: Num; month_sweep_trx: Amt;
    by_chain: Record<string, Partial<{ unswept_total: Amt; address_count: Num; over_threshold: Num; over_threshold_total: Amt; threshold: Amt; enabled: boolean }>> }>;
  periods?: Record<'today' | 'd7' | 'd30', Period>;
  top_merchants?: { name: string; amount: Amt; count: number }[];
  system?: { tick_age_s: number | null; recon: { day: string; diff: Amt; complete: boolean } | null; db_bytes: number; disk: { used_mb: number; total_mb: number } | null };
}
type Part = 'db' | 'chain';
type PartState = 'loading' | 'ok' | 'failed';

const units = (v: Amt) => { if (v === null || v === undefined) return null; const neg = v.startsWith('-'); return (parseUsdt(neg ? v.slice(1) : v) ?? 0) * (neg ? -1 : 1); };
const usd = (v: Amt) => { const u = units(v); return u === null ? '—' : fmtUsdt(u); };
const num = (v: Num) => (v === null || v === undefined ? '—' : String(v));
const pct = (a: Num, b: Num) => (a != null && b ? `${Math.round((a / b) * 100)}%（${a}/${b}）` : '—');
const ago = (s: number | null) => (s === null ? '从未运行' : s < 120 ? `${s} 秒前` : s < 7200 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`);
const empty = (): OverviewData => ({ funds: {}, todo: {}, sweep: {} });
/** 把一批数据合并进来（funds、todo、sweep 按字段合并，其他整体替换） */
function merge(d: OverviewData, x: Partial<OverviewData>): OverviewData {
  return { ...d, ...x, funds: { ...d.funds, ...x.funds }, todo: { ...d.todo, ...x.todo }, sweep: { ...d.sweep, ...x.sweep } };
}

/**
 * 加载并显示概览。load.db / load.chain 各返回一批数据；go(tab) 跳到对应页面。
 * 返回的函数可以再次调用来刷新。
 */
export function mountOverview(p: HTMLElement, load: Record<Part, () => Promise<Partial<OverviewData>>>, go: (tab: string, chain?: string) => void) {
  let data = empty();
  let run = 0;
  const state: Record<Part, PartState> = { db: 'loading', chain: 'loading' };
  const refresh = () => {
    const my = ++run;
    data = empty(); state.db = state.chain = 'loading';
    draw();
    for (const part of ['db', 'chain'] as Part[]) {
      let timer = 0;
      const timeout = new Promise<never>((_, rej) => { timer = window.setTimeout(() => rej(new Error('timeout')), 20_000); });
      Promise.race([load[part](), timeout])
        .then((x) => { if (my !== run) return; data = merge(data, x); state[part] = 'ok'; draw(); })
        .catch(() => { if (my !== run) return; state[part] = 'failed'; draw(); })
        .finally(() => clearTimeout(timer));
    }
  };
  const draw = () => renderOverview(p, data, state, go, refresh);
  refresh();
  return refresh;
}

const CHAINS = ['tron', 'eth', 'bsc'];
const CHAIN_NAME: Record<string, string> = { eth: '以太坊', bsc: 'BSC', tron: 'TRON' };
const chainTag = (c: string) => h('span', { class: `chain-tag c-${c}` }, CHAIN_NAME[c] || c);
function renderOverview(p: HTMLElement, d: OverviewData, state: Record<Part, PartState>, go: (tab: string, chain?: string) => void, refresh: () => void) {
  const f = d.funds, t = d.todo, s = d.sweep, sys = d.system;
  const link = (label: string, tab: string, n: Num, sub = '') => h('button', { type: 'button', class: `todo-item${n ? ' todo-on' : ''}`, onclick: () => go(tab) }, h('span', { class: 'todo-n' }, num(n)), h('span', {}, label, sub ? h('span', { class: 'muted' }, ` · ${sub}`) : null));
  const hot = units(f.hot_usdt), cold = units(f.cold_usdt), owed = units(f.owed_total);
  const owedCovered = hot !== null && cold !== null && owed !== null ? hot + cold >= owed : null;
  const periodRow = (label: string, x: Period | undefined) => x
    ? [label, `${usd(x.amount)} USDT`, num(x.count), `${usd(x.fees_in)} USDT`, num(x.active_merchants), num(x.new_customers), pct(x.orders_done, x.orders_closed)]
    : [label, '—', '—', '—', '—', '—', '—'];
  const incomes = [f.income_fee_in, f.income_fee_out, f.income_dust];
  const loading = state.db === 'loading' || state.chain === 'loading';
  const failed = (['db', 'chain'] as Part[]).filter((x) => state[x] === 'failed');
  const statusLine = loading ? '正在加载……' : failed.length ? `${failed.map((x) => (x === 'db' ? '统计数据' : '链上余额和开户数据')).join('、')}加载超时，显示为"—"。可以点"刷新"再试。` : '';
  const diskPct = sys && sys.disk && sys.disk.total_mb ? Math.round((sys.disk.used_mb / sys.disk.total_mb) * 100) : null;
  p.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, '概览'), h('div', { class: 'tool-actions' },
      statusLine ? h('span', { class: 'muted', 'data-ov-status': '' }, statusLine) : null,
      h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-ov-refresh': '', disabled: loading, onclick: refresh }, loading ? '加载中…' : '刷新'))),
    h('p', { class: 'hint muted' }, '金额单位都是 USDT，三条链（TRON、以太坊、BSC）合在一起算。热钱包和冷钱包的余额实时查询链上，客户地址里没归集的钱按账本计算。以太坊、BSC 归集直接进冷钱包；开通了批量打款的链，热钱包余额也算进平台资产。'),

    // ① 资金
    h('h2', { class: 'h-sm' }, '资金'),
    h('div', { class: 'stats' },
      stat('代收总额', usd(f.collected_total), `帮商户收到的钱 · ${num(f.deposit_count)} 笔`),
      stat('欠商户', usd(f.owed_total), `可提 ${usd(f.owed_available)} · 提币中冻结 ${usd(f.owed_frozen)}`),
      stat('平台资产', usd(f.assets_total), `未归集 ${usd(f.unswept_total)} + 热钱包 ${usd(f.hot_usdt)}${f.cold_configured ? ` + 冷钱包 ${usd(f.cold_usdt)}` : ''}`),
      stat('利润', usd(f.profit_total), '平台资产 − 欠商户'),
    ),
    h('div', { class: 'stats' },
      stat('现在就能转走的利润', usd(f.profit_now), `热钱包${f.cold_configured ? ' + 冷钱包' : ''} − 欠商户。转走后，钱包里仍然够付所有商户的提币`),
      stat('归集后才能转走', usd(f.profit_after_sweep), '这部分还在客户地址里，归集到热钱包或冷钱包之后才能转走'),
      stat('利润来源合计', incomes.every((x) => units(x) !== null) ? fmtUsdt(incomes.reduce((a, x) => a + (units(x) ?? 0), 0)) : '—', `收款手续费 ${usd(f.income_fee_in)} · 提币手续费 ${usd(f.income_fee_out)} · 低于 1 USDT 的转入 ${usd(f.income_dust)}`),
    ),
    fundsByChain(d),
    owedCovered === false ? h('p', { class: 'alert', 'data-owed-alert': '' }, '三条链的热钱包和冷钱包合计少于欠商户的金额：商户提币时可能要先归集（看下面每条链的"去归集"）。不要从钱包里转走利润。') : h('span'),
    h('p', { class: 'hint muted' }, '利润来源三项加起来和"利润"之间的差，是还没对上的部分：例如你之前从钱包转走过利润，或者有到账还在确认中。以"对账"页面为准。'),

    // ② 待处理
    h('h2', { class: 'h-sm' }, '待处理'),
    h('div', { class: 'todo-grid' },
      link('笔打款待审核', 'p-withdrawals', t.withdrawals_count, t.withdrawals_count ? `${usd(t.withdrawals_amount)} USDT` : ''),
      link('份开户申请待审核', 'apps', t.kyb_pending),
      link('个商户待开通收付款', 'p-merchants', t.merchants_to_open),
      link('条异常到账未处理', 'p-anomalies', t.anomalies),
      link('条回调 24 小时内发送失败', 'p-status', t.callbacks_failed),
    ),

    // ③ 待归集（每条链一行，按链去归集）
    h('h2', { class: 'h-sm' }, '待归集'),
    table(['链', '未归集', '地址', '达到门槛', ''], CHAINS.map((c) => {
      const x = s.by_chain?.[c];
      return [chainTag(c), x ? `${usd(x.unswept_total)} USDT` : '—', num(x?.address_count), x ? `${num(x.over_threshold)} 个（门槛 ${usd(x.threshold)}，合计 ${usd(x.over_threshold_total)}）` : '—',
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-ov-sweep': c, disabled: c !== 'tron' && x?.enabled === false, onclick: () => go('p-sweep', c) }, `去归集 ${CHAIN_NAME[c]}`)];
    }), '—'),
    h('div', { class: 'stats' },
      stat('合计未归集', usd(s.unswept_total), `${num(s.address_count)} 个地址；其中 ${num(s.over_threshold)} 个达到门槛（合计 ${usd(s.over_threshold_total)}）`),
      stat('TRON 热钱包 TRX', usd(s.hot_trx), s.energy_left == null || !s.energy_per_sweep ? '可借出能量：—' : `可借出能量 ${s.energy_left.toLocaleString('en')}，大约够 ${Math.floor(s.energy_left / s.energy_per_sweep)} 笔归集`),
      stat('本月 TRON 归集花费', `${usd(s.month_sweep_trx)} TRX`, '补给新地址用于燃烧的 TRX（成本，不从 USDT 利润里扣）。以太坊、BSC 的手续费看"归集"页的发起账户'),
    ),

    // ④ 业务趋势
    h('h2', { class: 'h-sm' }, '业务'),
    table(['时间（东八区）', '收款金额', '笔数', '收款手续费', '有收款的商户', '新增客户', '订单按时完成'],
      [periodRow('今天', d.periods?.today), periodRow('近 7 天', d.periods?.d7), periodRow('近 30 天', d.periods?.d30)], '—'),
    h('p', { class: 'hint muted' }, '订单按时完成 = 期间创建、已经结束的订单里，完成（含超额付款）的比例。'),
    h('h3', { class: 'h-sm' }, '近 30 天收款最多的商户'),
    table(['商户', '收款金额', '笔数'], (d.top_merchants || []).map((m) => [m.name, `${usd(m.amount)} USDT`, String(m.count)]), d.top_merchants ? '近 30 天还没有收款' : '—'),

    // ⑤ 系统状态
    h('h2', { class: 'h-sm' }, '系统'),
    h('div', { class: 'stats' },
      stat('链上监控', sys ? ago(sys.tick_age_s) : '—', !sys ? '' : sys.tick_age_s !== null && sys.tick_age_s <= 300 ? '正常（每 15 秒运行）' : '超过 5 分钟没有运行，请检查 worker 进程'),
      stat('最近一次对账', !sys ? '—' : sys.recon ? sys.recon.day : '还没有', !sys ? '' : sys.recon ? (!sys.recon.complete ? '没有查完所有地址' : units(sys.recon.diff) ? `差额 ${usd(sys.recon.diff)} USDT` : '一致') : '在"对账"页面点"立即对账"'),
      stat('磁盘用量', diskPct === null ? '—' : `${diskPct}%`, sys ? `${sys.disk ? `${sys.disk.used_mb.toLocaleString('en')} / ${sys.disk.total_mb.toLocaleString('en')} MB · ` : ''}数据库 ${(sys.db_bytes / 1048576).toFixed(1)} MB` : ''),
    ),
  );
}

/** 资金按链拆开：未归集 + 热钱包 + 冷钱包（以太坊、BSC 的热钱包只有开通了批量打款才有） */
function fundsByChain(d: OverviewData) {
  const f = d.funds, s = d.sweep;
  const rows = CHAINS.map((c) => {
    const w = f.by_chain?.[c], u = s.by_chain?.[c];
    const hotOff = c !== 'tron' && w?.hot_enabled !== true;
    const hot = hotOff ? 0 : units(w?.hot_usdt), cold = units(w?.cold_usdt), uns = units(u?.unswept_total);
    const off = c !== 'tron' && u?.enabled === false;
    const sum = hot !== null && cold !== null && uns !== null ? hot + cold + uns : null;
    return [chainTag(c), uns === null ? '—' : fmtUsdt(uns), hotOff ? h('span', { class: 'muted' }, '没开通打款') : hot === null ? '—' : fmtUsdt(hot),
      off ? h('span', { class: 'muted' }, '未开通') : cold === null ? '—' : fmtUsdt(cold), sum === null ? '—' : h('b', {}, fmtUsdt(sum))];
  });
  // 显示"—"的地方写原因：哪条链的哪个余额暂时查不到（数据都回来以后才判断，加载中不算）
  const why: string[] = [];
  if (f.by_chain) for (const c of CHAINS) {
    const w = f.by_chain[c], u = s.by_chain?.[c];
    if (c !== 'tron' && u?.enabled === false) continue;
    if (!w) continue; // 没开通的链
    if ((c === 'tron' || w.hot_enabled) && units(w.hot_usdt) === null) why.push(`${CHAIN_NAME[c]} 热钱包余额暂时查不到`);
    if (units(w.cold_usdt) === null) why.push(`${CHAIN_NAME[c]} 冷钱包余额暂时查不到`);
  }
  return h('details', { class: 'funds-chains', open: true, 'data-funds-chains': '' }, h('summary', {}, '平台资产按链拆开（USDT）'),
    table(['链', '未归集', '热钱包', '冷钱包', '合计'], rows, '—'),
    why.length ? h('p', { class: 'hint neg m0', 'data-funds-why': '' }, `${why.join('；')}：对应的合计、平台资产和利润显示"—"，稍后点"刷新"再试。`) : null);
}
