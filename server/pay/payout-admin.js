// 运营后台"打款审核"和"钱包设置"里批量打款的动作（/api/wallet/?a=payout-*、allowance-*，管理员登录后才能用；第 3 批）。
// 审核：单笔一单一审、商户批量逐行勾选一次审完；按链凑批（三者取最小）、签名（以太坊 / BSC 走 server/wallet/payout.js，TRON 走原来的 withdraw-plan / sign-submit）；
// 上限后台可改（原因 + 动态码 + 审计）；改授权额度（以太坊先归零再设两笔）。金额一律返回 USDT 字符串。
import { PayError, getMeta, audit } from './core.js';
import { fmtUsdt, parseUsdt } from './money.js';
import { iso } from './common.js';
import * as payout from './payout.js';

const usdt = (u) => (u === null || u === undefined ? null : fmtUsdt(Number(u)).replace(/,/g, ''));
const EVM = ['eth', 'bsc'];
const TRON_SIGN_TTL_MS = 30 * 60_000; // 和 wallet-api.js 的 SIGN_TTL_MS 一致
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
    rebroadcast_at: iso(b.rebroadcast_at) || null,
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
    const appr = await db.query(`select chain, count(*)::int n, coalesce(sum(amount), 0)::bigint total, max(amount)::bigint biggest from withdrawals where status = 'approved' and batch_id is null and hold_reason is null group by chain`);
    const planned = await db.query(`select chain, count(*)::int n from payout_tx_batches where status = 'planned' group by chain`);
    const out = [];
    for (const chain of ['eth', 'bsc', 'tron']) {
      const a = appr.find((x) => x.chain === chain) || { n: 0, total: 0, biggest: 0 };
      const card = { chain, approved_count: a.n, approved_total: usdt(a.total), enabled: false, hot: null, hot_balance: null, allowance: null, cap: null, by: null, blocked: null, max_items: payout.MAX_ITEMS_PER_TX[chain], planned_batches: planned.find((x) => x.chain === chain)?.n || 0 };
      if (EVM.includes(chain)) {
        if (!evmOn().includes(chain)) { card.blocked = 'not_enabled'; out.push(card); continue; }
        card.enabled = true;
        try {
          const s = await svc().status(chain);
          Object.assign(card, { hot: s.hot, contract: s.contract, hot_balance: usdt(s.hot_balance), allowance: usdt(s.allowance), inflight: usdt(s.inflight), cap: usdt(s.cap), by: s.by, hot_low: s.hot_low, allowance_busy: s.allowance_busy, onchain: s.onchain });
          if (s.onchain === 'mismatch') card.blocked = 'contract_mismatch';
          else if (s.onchain !== 'ok') card.blocked = 'contract_unverified';
          else if (s.allowance_busy) card.blocked = 'allowance_in_progress';
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
          Object.assign(card, { hot_balance: usdt(hot), cap: usdt(cap), by, hot_low: hot < limits.hotLow, energy: { mode: 'burn' } });
          // 和以太坊 / BSC 一样自动拆批：先看这一批能签几笔、剩几笔留到下一轮（签名时服务器按同样的规则再算一次）
          const rows = a.n ? await db.query(`select id, amount from withdrawals where chain = 'tron' and status = 'approved' and batch_id is null and hold_reason is null order by approved_at, created_at, coalesce(batch_line, 0), id`) : [];
          const pl = payout.planPayoutBatches(rows.map((r) => ({ id: r.id, amount: Number(r.amount) })), { chain: 'tron', perBatch: limits.perBatch, hotBalance: hot, allowance: null, perItem: limits.perItem });
          card.batch_count = pl.batches[0]?.items.length || 0;
          card.batch_total = usdt(pl.batches[0]?.total ?? 0);
          card.left_count = a.n - card.batch_count;
          if (a.n && !card.batch_count) card.blocked = Number(cap) <= 0 || pl.held.some((h) => h.reason === 'exceeds_hot_balance') ? 'hot_balance' : 'per_batch';
        } catch { card.blocked = 'rpc'; }
      }
      out.push(card);
    }
    return { limits: limitsOut(limits), cards: out };
  }

  /** 没签名的批次（planned）：TRON 的还要看签名批次还在不在、交易原文快不快过期 */
  async function tronSignBatch(ptId) {
    const [sb] = await db.query(`select * from sign_batches where kind = 'withdraw' and status = 'planned' and plan->>'payout_batch' = $1 order by created_at desc limit 1`, [ptId]);
    return sb && now() - new Date(sb.created_at).getTime() < TRON_SIGN_TTL_MS - 60_000 ? sb : null;
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
      const recent = await db.query(`select * from payout_tx_batches order by created_at desc limit 20`); // 作废的（没签名、作废重凑）也列出来
      // 已审核、还没凑进批次的单（可以在这里驳回）；挂起的（收款地址转不了）排最前
      const appr = await db.query(`select w.*, m.name merchant from withdrawals w join merchants m on m.id = w.merchant_id where w.status = 'approved' and w.batch_id is null order by (w.hold_reason is null), w.approved_at, w.created_at limit 200`);
      const limits = await payout.getPayoutLimits(db);
      const [today] = await db.query(`select coalesce(sum(amount), 0)::bigint v from withdrawals where approved_at >= $1 and status in ('approved', 'signing', 'broadcast', 'completed')`, [new Date(payout.dayStart(now()))]);
      const approved = appr.map((w) => ({ id: w.id, merchant: w.merchant, kind: w.kind, chain: w.chain, to: w.to_address, amount: usdt(w.amount), batch_no: w.batch_ref || null, approved_at: iso(w.approved_at), hold: w.hold_reason || null }));
      return { singles, groups, pending_count: rows.length, approved, batches: recent.map(txBatchOut), ...(await plans()), today_approved: usdt(today.v), per_day: usdt(limits.perDay), service: payout.serviceWindow(now()) };
    },
    /** 单笔（或几笔）审核通过：超单笔、每天上限的留在待审核，返回原因 */
    'payout-approve': (b, actor) => payout.approvePayouts(db, { ids: (b.ids || []).map(String), actor, now: now() }),
    /** 商户批量：勾的通过，其余驳回（有驳回时原因必填） */
    'payout-review': (b, actor) => payout.reviewPayoutBatch(db, { batchNo: String(b.batch_no || ''), approve: (b.approve || []).map(String), reason: b.reason, actor, now: now() }),
    'payout-plans': () => plans(),
    /** 已审核（还没凑进批次）的驳回：原因必填，退冻结、回调、审计；挂起的（收款地址转不了）用它了结 */
    'payout-reject-approved': (b, actor) => payout.rejectApprovedPayout(db, { id: String(b.id || ''), reason: b.reason, actor }),
    /** 解除挂起：挂起的单回到普通的已审核（下一轮照常凑批），审计 payout.unhold */
    'payout-unhold': (b, actor) => payout.unholdPayout(db, { id: String(b.id || ''), actor }),
    /**
     * 作废一个还没签名的批次（页面关了、想重凑）：单回到已审核。只作废 planned 的——已经交了签名、可能已经广播的一律不动（invalid_state）。
     * TRON 先把签名批次改成 expired，之后交来的签名一律 409。
     */
    async 'payout-void'(b, actor) {
      const id = String(b.id || '');
      const [x] = await db.query('select id, chain, status from payout_tx_batches where id = $1', [id]);
      if (!x) throw new PayError('not_found', 404);
      if (x.chain === 'tron') await db.query(`update sign_batches set status = 'expired', updated_at = now() where kind = 'withdraw' and status = 'planned' and plan->>'payout_batch' = $1`, [id]);
      if (!(await payout.expirePayoutBatch(db, id))) throw new PayError('invalid_state', 409);
      await audit(db, actor, 'payout.void', id, { chain: x.chain });
      return { ok: true };
    },
    /** 继续签名一个还没签名的批次：以太坊 / BSC 给原文和期望值（重新核对过）；TRON 给签名批次的交易（快过期的不给，作废重凑） */
    async 'payout-resume'(b) {
      const id = String(b.id || '');
      const [x] = await db.query('select * from payout_tx_batches where id = $1', [id]);
      if (!x) throw new PayError('not_found', 404);
      if (x.status !== 'planned') throw new PayError('invalid_state', 409);
      if (x.chain !== 'tron') {
        const r = await svc().resume(id);
        return { ...r, batches: r.batches.map((y) => ({ ...y, total: usdt(y.total), items: y.items.map((i) => ({ ...i, amount: usdt(i.amount) })) })) };
      }
      const sb = await tronSignBatch(id);
      if (!sb) throw new PayError('plan_expired', 409);
      const ws = await db.query(`select w.id, w.kind, w.to_address, w.amount, m.name merchant from withdrawals w join merchants m on m.id = w.merchant_id where w.id = any($1::text[])`, [x.item_ids]);
      return { chain: 'tron', batch_id: sb.id, payout_batch: id, total: usdt(x.total), steps: sb.plan.steps.map(({ kind, stage, withdrawal_id, rawHex, txID }) => ({ kind, stage, withdrawal_id, rawHex, txID })),
        items: ws.map((w) => ({ id: w.id, merchant: w.merchant, kind: w.kind, to: w.to_address, amount: usdt(w.amount) })) };
    },
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
      const items = await db.query(`select w.id, w.chain, w.to_address, w.amount, w.status, w.txid, w.reason, w.hold_reason, m.name merchant from withdrawals w join merchants m on m.id = w.merchant_id where w.id = any($1::text[])`, [x.item_ids]);
      const resumable = x.status === 'planned' && (x.chain !== 'tron' ? Boolean(x.raw_hex) : Boolean(await tronSignBatch(x.id)));
      return { ...txBatchOut(x), resumable, voidable: x.status === 'planned', withdrawals: items.map((w) => ({ id: w.id, merchant: w.merchant, to: w.to_address, amount: usdt(w.amount), status: w.status, txid: w.txid, reason: w.reason, hold: w.hold_reason || null })) };
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
          try { const s = await svc().status(chain); card.hot_balance = usdt(s.hot_onchain); card.allowance = usdt(s.allowance_onchain); card.low = s.hot_low; } catch { card.error = 'rpc'; }
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
