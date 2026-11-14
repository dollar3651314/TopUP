// 运营后台"打款审核"和"钱包设置"里批量打款的动作（/api/wallet/?a=payout-*、allowance-*，管理员登录后才能用；第 3 批）。
// 审核：单笔一单一审、商户批量逐行勾选一次审完；按链凑批（三者取最小）、签名（以太坊 / BSC 走 server/wallet/payout.js，TRON 走原来的 withdraw-plan / sign-submit）；
// 上限后台可改（原因 + 动态码 + 审计）；改授权额度（以太坊先归零再设两笔）。金额一律返回 USDT 字符串。
import { PayError, getMeta } from './core.js';
import { fmtUsdt, parseUsdt } from './money.js';
import { iso } from './common.js';
import * as payout from './payout.js';

const usdt = (u) => (u === null || u === undefined ? null : fmtUsdt(Number(u)).replace(/,/g, ''));
const EVM = ['eth', 'bsc'];
const limitsOut = (l) => Object.fromEntries(payout.LIMIT_KEYS.map((k) => [k, usdt(l[k])]));

/** 打款交易批次（payout_tx_batches）给页面的样子 */
export function txBatchOut(b) {
  const res = b.expect?.results || {};
  const ids = b.item_ids || [];
  const okN = ids.filter((x) => res[x]?.ok).length, badN = ids.filter((x) => res[x] && !res[x].ok).length;
  return {
    id: b.id, chain: b.chain, status: b.status, count: ids.length, total: usdt(b.total), tx_hash: b.tx_hash || null, error: b.error || null,
    ok: b.status === 'confirmed' ? ids.length : okN, failed: b.status === 'failed' ? ids.length : badN,
    energy: b.chain === 'tron' ? (b.energy || { mode: 'burn' }) : null,
    items: ids.map((id) => ({ id, status: res[id] ? (res[id].ok ? 'completed' : 'approved') : null, reason: res[id]?.reason || null })),
    created_at: iso(b.created_at), updated_at: iso(b.updated_at),
  };
}

export function payoutAdminActions({ db, tron, wallets = {}, layer = null, payoutSvc = null, verifyAdminCode, now = () => Date.now() }) {
  const svc = () => { if (!payoutSvc) throw new PayError('chain_not_enabled', 409, 'chain'); return payoutSvc; };
  const evmOn = () => (payoutSvc ? payoutSvc.chains : []);
  const checkCode = async (c) => { if (!(await verifyAdminCode(String(c || '')))) throw new PayError('bad_code', 400); };

  /** 每条链的凑批卡片：已审核待签名的笔数和金额、热钱包、授权额度、每批实际上限（三者取最小，说出是哪个）、签不了的原因 */
  async function plans() {
    const limits = await payout.getPayoutLimits(db);
    const appr = await db.query(`select chain, count(*)::int n, coalesce(sum(amount), 0)::bigint total, max(amount)::bigint biggest from withdrawals where status = 'approved' and batch_id is null group by chain`);
    const out = [];
    for (const chain of ['eth', 'bsc', 'tron']) {
      const a = appr.find((x) => x.chain === chain) || { n: 0, total: 0, biggest: 0 };
      const card = { chain, approved_count: a.n, approved_total: usdt(a.total), enabled: false, hot: null, hot_balance: null, allowance: null, cap: null, by: null, blocked: null, max_items: payout.MAX_ITEMS_PER_TX[chain] };
      if (EVM.includes(chain)) {
        if (!evmOn().includes(chain)) { card.blocked = 'not_enabled'; out.push(card); continue; }
        card.enabled = true;
        try {
          const s = await svc().status(chain);
          Object.assign(card, { hot: s.hot, contract: s.contract, hot_balance: usdt(s.hot_balance), allowance: usdt(s.allowance), cap: usdt(s.cap), by: s.by, hot_low: s.hot_low, allowance_busy: s.allowance_busy });
          if (s.allowance_busy) card.blocked = 'allowance_in_progress';
          else if (a.n && Number(s.cap) <= 0) card.blocked = s.by === 'allowance' ? 'allowance' : 'hot_balance';
          else if (a.n && Number(a.biggest) > Number(s.cap)) card.blocked = s.by === 'allowance' ? 'allowance' : s.by === 'hot_balance' ? 'hot_balance' : 'per_batch';
        } catch (e) { card.blocked = 'rpc'; card.error = String(e?.message || e).slice(0, 120); }
      } else {
        card.enabled = Boolean(wallets.hot);
        card.hot = wallets.hot || null;
        if (!card.enabled) { card.blocked = 'not_enabled'; out.push(card); continue; }
        try {
          const acc = await tron.account(wallets.hot);
          const hot = Number(acc.trc20[tron.contract] || 0);
          const { cap, by } = payout.effectiveBatchCap({ perBatch: limits.perBatch, hotBalance: hot, allowance: null });
          Object.assign(card, { hot_balance: usdt(hot), cap: usdt(cap), by, hot_low: hot < limits.hotLow });
          if (a.n && Number(cap) <= 0) card.blocked = 'hot_balance';
        } catch { card.blocked = 'rpc'; }
      }
      out.push(card);
    }
    return { limits: limitsOut(limits), cards: out };
  }

  return {
    /** 打款审核页：待审核的（单笔、商户批量分组）、各链凑批卡片、最近的签名批次、上限、处理时段 */
    async 'payout-overview'() {
      const rows = await db.query(`select w.*, m.name merchant, m.cashout_wallets from withdrawals w join merchants m on m.id = w.merchant_id where w.status = 'pending' order by w.created_at, coalesce(w.batch_line, 0), w.id limit 1000`);
      // 代付的收款地址是不是第一次付（原型偏离第 2 条：没有白名单，审核时提示）
      const seen = new Set((await db.query(`select distinct merchant_id || '|' || chain || '|' || lower(to_address) k from withdrawals where status = 'completed'`)).map((r) => r.k));
      const item = (w) => ({
        id: w.id, merchant_id: w.merchant_id, merchant: w.merchant, kind: w.kind, chain: w.chain, to: w.to_address, amount: usdt(w.amount), fee: usdt(w.fee), source: w.source,
        customer_id: w.customer_id, merchant_ref: w.merchant_ref, batch_no: w.batch_ref || null, created_at: iso(w.created_at),
        registered: w.kind === 'cashout', first_time: w.kind === 'payout' && !seen.has(`${w.merchant_id}|${w.chain}|${String(w.to_address).toLowerCase()}`),
      });
      const singles = rows.filter((w) => !w.batch_ref).map(item);
      const groups = [];
      for (const w of rows.filter((x) => x.batch_ref)) {
        let g = groups.find((x) => x.batch_no === w.batch_ref);
        if (!g) { g = { batch_no: w.batch_ref, merchant: w.merchant, merchant_id: w.merchant_id, source: w.source, created_at: iso(w.created_at), items: [] }; groups.push(g); }
        g.items.push(item(w));
      }
      for (const g of groups) { g.count = g.items.length; g.total = usdt(g.items.reduce((s, x) => s + (parseUsdt(x.amount) ?? 0), 0)); }
      const recent = await db.query(`select * from payout_tx_batches where status <> 'expired' order by created_at desc limit 20`);
      const limits = await payout.getPayoutLimits(db);
      const [today] = await db.query(`select coalesce(sum(amount), 0)::bigint v from withdrawals where approved_at >= $1 and status in ('approved', 'signing', 'broadcast', 'completed')`, [new Date(payout.dayStart(now()))]);
      return { singles, groups, pending_count: rows.length, batches: recent.map(txBatchOut), ...(await plans()), today_approved: usdt(today.v), per_day: usdt(limits.perDay), service: payout.serviceWindow(now()) };
    },
    /** 单笔（或几笔）审核通过：超单笔、每天上限的留在待审核，返回原因 */
    'payout-approve': (b, actor) => payout.approvePayouts(db, { ids: (b.ids || []).map(String), actor, now: now() }),
    /** 商户批量：勾的通过，其余驳回（有驳回时原因必填） */
    'payout-review': (b, actor) => payout.reviewPayoutBatch(db, { batchNo: String(b.batch_no || ''), approve: (b.approve || []).map(String), reason: b.reason, actor, now: now() }),
    'payout-plans': () => plans(),
    /** 以太坊 / BSC 凑批出交易（每批一笔 BatchPayout.pay，未签名原文 + 页面核对用的期望值） */
    async 'payout-plan'(b, actor) {
      const chain = String(b.chain || '');
      if (!EVM.includes(chain)) throw new PayError('invalid_param', 422, 'chain');
      const r = await svc().plan(chain, { actor });
      return { ...r, cap: usdt(r.cap), batches: r.batches.map((x) => ({ ...x, total: usdt(x.total), items: x.items.map((i) => ({ ...i, amount: usdt(i.amount) })) })) };
    },
    /** 交回签名（动态码先核对）：签名人必须是热钱包；广播服务器存的原文 */
    async 'payout-submit'(b, actor) {
      await checkCode(b.code);
      return svc().submit(String(b.id || ''), { sigHex: String(b.signature || ''), actor });
    },
    async 'payout-tx-batch'(b, actor, q) {
      const [x] = await db.query('select * from payout_tx_batches where id = $1', [q.get('id') || '']);
      if (!x) throw new PayError('not_found', 404);
      const items = await db.query(`select w.id, w.chain, w.to_address, w.amount, w.status, w.txid, w.reason, m.name merchant from withdrawals w join merchants m on m.id = w.merchant_id where w.id = any($1::text[])`, [x.item_ids]);
      return { ...txBatchOut(x), withdrawals: items.map((w) => ({ id: w.id, merchant: w.merchant, to: w.to_address, amount: usdt(w.amount), status: w.status, txid: w.txid, reason: w.reason })) };
    },
    'payout-limits': async () => limitsOut(await payout.getPayoutLimits(db)),
    /** 改上限：values 是 USDT 字符串；原因 + 动态码 + 审计 */
    async 'payout-limits-save'(b, actor) {
      const values = {};
      for (const k of payout.LIMIT_KEYS) if (b.values?.[k] !== undefined) { const n = parseUsdt(String(b.values[k])); if (!n) throw new PayError('invalid_param', 422, k); values[k] = n; }
      return limitsOut(await payout.updatePayoutLimits(db, { actor, reason: b.reason, values, code: b.code, verifyCode: (c) => verifyAdminCode(c) }));
    },
    /** 改授权额度：amount 是 USDT 字符串；以太坊当前不是 0 时两笔（先归零再设） */
    async 'allowance-plan'(b, actor) {
      const chain = String(b.chain || '');
      const n = parseUsdt(String(b.amount ?? ''));
      if (n === null) throw new PayError('invalid_param', 422, 'amount');
      const r = await svc().allowancePlan(chain, { amount: n, reason: b.reason, code: b.code, actor });
      return { ...r, current: usdt(r.current), target: usdt(r.target), steps: r.steps.map((s) => ({ ...s, amount: usdt(s.amount) })) };
    },
    'allowance-submit': (b, actor) => svc().allowanceSubmit(String(b.chain || ''), { rawHex: String(b.rawHex || ''), sigHex: String(b.signature || ''), actor }),
    /** 钱包设置（P4）：每条链一张卡——冷钱包、热钱包（余额、上限）、授权额度、发起账户、合约是否已配置；TRON 另有旧地址（第 0 批）个数 */
    async 'payout-wallets'() {
      const limits = await payout.getPayoutLimits(db);
      const cards = [];
      for (const chain of ['eth', 'bsc']) {
        const cfg = layer?.config?.[chain] || {};
        const ev = wallets.evm?.[chain] || {};
        const card = { chain, enabled: Boolean(layer?.enabledChains?.includes(chain)), cold: cfg.scheme?.parent || ev.parent || null, hot: ev.hot || null, payout: ev.payout || null,
          payout_enabled: evmOn().includes(chain), contracts_configured: Boolean(cfg.complete), operator: layer?.providers?.contract?.operator || null, onchain: layer?.onchain?.[chain]?.result ?? null,
          hot_balance: null, allowance: null, hot_max: usdt(limits.hotMax), hot_low: usdt(limits.hotLow), allowance_steps: chain === 'eth' ? 2 : 1 };
        if (card.payout_enabled) {
          try { const s = await svc().status(chain); card.hot_balance = usdt(s.hot_balance); card.allowance = usdt(s.allowance); card.low = s.hot_low; } catch { card.error = 'rpc'; }
        }
        cards.push(card);
      }
      const [legacy] = await db.query('select count(*)::int n from customers where address is not null');
      const tcard = { chain: 'tron', enabled: Boolean(layer?.enabledChains?.includes('tron')), cold: wallets.cold || null, hot: wallets.hot || null, payout: null, payout_enabled: Boolean(wallets.hot),
        contracts_configured: Boolean(layer?.config?.tron?.complete), operator: layer?.providers?.contract?.tronOperator || null, legacy_addresses: legacy.n, hot_balance: null, hot_max: usdt(limits.hotMax), hot_low: usdt(limits.hotLow), allowance: null, rental: Boolean(layer?.tronEnergy) };
      if (wallets.hot) { try { const acc = await tron.account(wallets.hot); tcard.hot_balance = usdt(acc.trc20[tron.contract] || 0); tcard.low = Number(acc.trc20[tron.contract] || 0) < limits.hotLow; } catch { tcard.error = 'rpc'; } }
      cards.push(tcard);
      return { cards, limits: limitsOut(limits), xpub: Boolean(await getMeta(db, 'xpub')) };
    },
  };
}
