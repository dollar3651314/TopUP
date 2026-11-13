// 运营后台的钱包动作（/api/wallet/?a=wallet-*，管理员登录后才能用）：归集、钱包提供方、每条链的系统状态。
// 金额一律返回 USDT 字符串（例如 "150.5"），原生币手续费返回 wei 字符串和换算后的小数字符串。
import { PayError, getMeta } from '../pay/core.js';
import { fmtUsdt, parseUsdt } from '../pay/money.js';
import { CHAINS, PROVIDER_IDS } from './provider.js';
import { routeOverview, setChainProvider, CHAINS_NOT_IN_BATCH } from './router.js';
import {
  proposeSweep, approveSweep, cancelSweep, listBatches, getBatch, getSweepSettings, updateSweepSettings, settingsForHumans,
  nextSweepSlot, SWEEP_CHAINS, SWEEP_EXPIRE_HOURS, SWEEP_TIMES,
} from './sweep.js';
import { walletChainStatus } from './status.js';

const usdt = (u) => fmtUsdt(Number(u)).replace(/,/g, '');
/** 原生币最小单位 → 小数字符串：ETH、BNB 18 位（wei），TRX 6 位（sun） */
const NATIVE_DECIMALS = { eth: 18, bsc: 18, tron: 6 };
const native = (wei, chain = 'eth') => {
  if (wei === null || wei === undefined || wei === '') return null;
  const w = BigInt(wei), d = NATIVE_DECIMALS[chain] ?? 18, u = 10n ** BigInt(d);
  const int = w / u, frac = (w % u).toString().padStart(d, '0').slice(0, 6).replace(/0+$/, '');
  return `${int}${frac ? '.' + frac : ''}`;
};
const NATIVE = { eth: 'ETH', bsc: 'BNB', tron: 'TRX' };
/** 发起账户的手续费币少于够付几批典型归集时告警 */
export const LOW_GAS_BATCHES = 3;

function batchOut(b, extra = {}) {
  return {
    ...extra,
    id: b.id, status: b.status, chain: b.chain, provider: b.provider, total_usdt: usdt(b.total), address_count: b.addressCount,
    items: b.items.map((i) => ({ address: i.address, amount_usdt: usdt(i.amount), deploy: i.deploy, status: i.status, reason: i.reason })),
    skipped: (b.skipped || []).map((s) => ({ address: s.address, amount_usdt: usdt(s.amount), reason: s.reason })),
    fee: b.feeEstimate?.native ? { native: native(b.feeEstimate.native, b.chain), symbol: NATIVE[b.chain], gas: b.feeEstimate.gas || null } : null,
    tx_refs: b.txRefs, slot: b.slot || null, approved_by: b.approvedBy, approved_at: b.approvedAt, reason: b.reason, error: b.error,
    created_at: b.createdAt, expires_at: b.expiresAt, updated_at: b.updatedAt,
  };
}

/** values 里的金额是 USDT 字符串（页面填的），转成 0.000001 单位的整数字符串；不对时报出字段 */
function settingsFromForm(v = {}) {
  const u = (x, field) => {
    const n = parseUsdt(String(x ?? ''));
    if (n === null) throw new PayError('invalid_param', 422, field);
    return String(n);
  };
  return {
    thresholds: Object.fromEntries(['eth', 'bsc', 'tron'].map((c) => [c, u(v.thresholds?.[c], `thresholds.${c}`)])),
    capPerAddress: u(v.capPerAddress, 'capPerAddress'), capPerBatch: u(v.capPerBatch, 'capPerBatch'),
    maxFeeRatioPct: Number(v.maxFeeRatioPct), maxAddresses: Number(v.maxAddresses),
  };
}

/** 同一次凑批拆成了几批（同一条链、同一时间建的批次数）：超过每批上限时系统会拆 */
async function splitCounts(db, batches) {
  if (!batches.length) return new Map();
  const rows = await db.query(`select b.id, (select count(*) from wallet_sweep_batches x where x.chain = b.chain and x.created_at = b.created_at)::int n
    from wallet_sweep_batches b where b.id = any($1::text[])`, [batches.map((x) => x.id)]);
  return new Map(rows.map((r) => [r.id, r.n]));
}
const outAll = async (db, list) => { const n = await splitCounts(db, list); return list.map((b) => batchOut(b, { split_of: n.get(b.id) || 1 })); };

export function walletAdminActions({ db, layer, verifyAdminCode, notify, origin = '', now = () => Date.now() }) {
  const need = () => { if (!layer) throw new PayError('wallet_not_configured', 503); return layer; };
  const providers = () => need().providers;
  const enabled = () => (layer ? layer.enabledChains : []);

  /** 发起账户的手续费币：余额、按一批典型的归集（10 个地址、一半首次）估够几批；不够 3 批或不够付待确认批次时 low = true */
  async function operatorGas(chain) {
    const configured = chain === 'tron' ? Boolean(layer?.tronOperatorConfigured) : Boolean(layer?.operatorConfigured);
    const out = { configured, gas: null, symbol: NATIVE[chain], batches_left: null, low: false };
    if (!enabled().includes(chain) || !configured) return out;
    const p = providers().contract;
    out.address = (chain === 'tron' ? p.tronOperator : p.operator) || null; // 发起账户的公开地址（补手续费时要复制它；不是密钥）
    try {
      const wei = await p.operatorGas(chain);
      out.gas = native(wei, chain);
      if (wei !== null && wei !== undefined) {
        const f = await p.estimateFee(chain, 'sweep', 10, { deploy: 5 }).catch(() => null);
        if (f?.native) out.batches_left = Number(BigInt(wei) / BigInt(f.native));
        const [w] = await db.query(`select coalesce(max((fee_estimate->>'native')::numeric), 0)::text need from wallet_sweep_batches where chain = $1 and status = 'awaiting_approval'`, [chain]);
        const needWei = BigInt(String(w?.need || '0').split('.')[0] || '0');
        out.low = (out.batches_left !== null && out.batches_left < LOW_GAS_BATCHES) || (needWei > 0n && BigInt(wei) < needWei);
      }
    } catch { out.gas = null; out.error = 'rpc'; }
    return out;
  }

  async function chainCards({ verify = false } = {}) {
    // 看系统状态时再用 eth_call 核对一次链上合约参数（最多等 5 秒；不一致的链停用并告警）
    if (verify && layer?.verifyOnchain) await layer.verifyOnchain({ db, notify, timeoutMs: 5000, now: now() }).catch(() => {});
    const out = [];
    for (const chain of CHAINS) {
      if ((chain === 'tron' && !enabled().includes('tron')) || CHAINS_NOT_IN_BATCH.includes(chain)) { out.push({ ...walletChainStatus({ chain, enabled: false, now: now() }), name: chain }); continue; }
      const c = layer?.config?.[chain] || { scheme: {}, rpcUrl: '', usdt: '', confirmations: 0 };
      const scan = await getMeta(db, `evm_scan_${chain}`, null);
      const card = walletChainStatus({
        chain, enabled: true, rpcConfigured: Boolean(c.rpcUrl), usdtConfigured: Boolean(c.usdt), scheme: c.scheme,
        cursor: scan?.cursor ?? null, head: scan?.head ?? null, confirmations: c.confirmations, lastScanAt: scan?.at ?? null, now: now(),
        onchain: layer?.onchain?.[chain]?.result ?? null,
      });
      card.confirmations = c.confirmations;
      card.config_error = layer?.errors?.[chain] ? (layer.errors[chain] === 'onchain_mismatch' ? 'onchain_mismatch' : 'invalid_config') : null;
      if (layer?.onchain?.[chain]?.fields) card.onchain_fields = layer.onchain[chain].fields; // 只给字段名，不给值
      card.operator = await operatorGas(chain);
      out.push(card);
    }
    return out;
  }

  return {
    /** 每条链一张卡：扫块、合约地址配没配齐（只给是否）、发起账户的手续费余额；提供方状态 */
    async 'wallet-chains'(b, actor, q) {
      const ps = layer ? Object.values(layer.providers).map((p) => ({ id: p.id, enabled: p.enabled !== false, ...(p.health ? p.health() : {}) })) : [];
      return { chains: await chainCards({ verify: q?.get('verify') === '1' }), providers: ps };
    },

    /** 归集页：每条链的待确认、进行中、最近的批次，估算的待归集金额，设置，下次凑批时间 */
    async 'wallet-sweep'() {
      const settings = await getSweepSettings(db);
      const chains = [];
      for (const chain of CHAINS) {
        const on = enabled().includes(chain);
        const row = { chain, enabled: on, not_in_this_batch: chain === 'tron' && !on, threshold_usdt: usdt(settings.thresholds[chain] ?? 0n) };
        if (on) {
          const active = await listBatches(db, { chain, status: 'awaiting_approval,sending,sent', limit: 50 });
          row.batches = (await outAll(db, active.items)).reverse(); // 最早的在前
          row.operator = await operatorGas(chain); // 发起账户的手续费币（归集页的卡片）
          // 估算（按数据库：到账合计 − 已归集），真正凑批时向链上查余额
          const [est] = await db.query(`with a as (
              select ca.address, coalesce((select sum(d.amount) from deposits d where d.chain = ca.chain and lower(d.address) = lower(ca.address)), 0)
                - coalesce((select sum(i.amount) from wallet_sweep_items i where i.chain = ca.chain and lower(i.address) = lower(ca.address) and i.status = 'swept'), 0) v
              from customer_addresses ca where ca.chain = $1 and ca.provider = 'contract')
            select count(*) filter (where v > 0)::int n, coalesce(sum(v) filter (where v > 0), 0)::bigint total,
              count(*) filter (where v >= $2)::int over_n, coalesce(sum(v) filter (where v >= $2), 0)::bigint over_total from a`, [chain, String(settings.thresholds[chain])]);
          row.estimate = { address_count: est.n, total_usdt: usdt(est.total), over_threshold: est.over_n, over_threshold_usdt: usdt(est.over_total) };
          const scan = await getMeta(db, `evm_scan_${chain}`, null);
          row.scan_ok = scan ? now() - Date.parse(scan.at) <= 5 * 60_000 : null; // null = 还没扫过（刚部署）
        }
        chains.push(row);
      }
      return {
        chains, settings: settingsForHumans(settings), times: [...SWEEP_TIMES], expire_hours: SWEEP_EXPIRE_HOURS,
        next_slot: nextSweepSlot(now()), last_slot: await getMeta(db, 'wallet_sweep_slot', null),
      };
    },
    /** 各链地址（待归集的估算，从多到少，最多 200 个） */
    async 'wallet-sweep-addresses'(b, actor, q) {
      const chain = q?.get('chain') || 'eth';
      if (!SWEEP_CHAINS.includes(chain)) throw new PayError('invalid_param', 422, 'chain');
      const rows = await db.query(`select ca.address, ca.status, ca.customer_id, m.name merchant,
          coalesce((select sum(d.amount) from deposits d where d.chain = ca.chain and lower(d.address) = lower(ca.address)), 0)
          - coalesce((select sum(i.amount) from wallet_sweep_items i where i.chain = ca.chain and lower(i.address) = lower(ca.address) and i.status = 'swept'), 0) v,
          (select i.batch_id from wallet_sweep_items i where i.chain = ca.chain and lower(i.address) = lower(ca.address) and i.status in ('pending', 'sent') limit 1) in_batch_id,
          exists (select 1 from wallet_sweep_items i where i.chain = ca.chain and lower(i.address) = lower(ca.address) and i.status = 'swept') swept_before
        from customer_addresses ca join merchants m on m.id = ca.merchant_id where ca.chain = $1 and ca.provider = 'contract' order by v desc limit 200`, [chain]);
      // 最近一次凑批跳过的地址和原因（跳过的记在那次凑批的第一批上）
      const [last] = await db.query(`select skipped from wallet_sweep_batches where chain = $1 and jsonb_array_length(skipped) > 0 order by created_at desc limit 1`, [chain]);
      const skip = new Map((last?.skipped || []).map((x) => [String(x.address).toLowerCase(), x.reason]));
      return { chain, items: rows.filter((r) => Number(r.v) > 0).map((r) => ({
        address: r.address, status: r.status, customer_id: r.customer_id, merchant: r.merchant, pending_usdt: usdt(r.v),
        in_batch: Boolean(r.in_batch_id), in_batch_id: r.in_batch_id || null, first_sweep: !r.swept_before,
        skip_reason: r.in_batch_id ? null : skip.get(r.address.toLowerCase()) || null,
      })) };
    },
    async 'wallet-sweep-batches'(b, actor, q) {
      const r = await listBatches(db, { chain: q?.get('chain') || '', status: q?.get('status') || '', before: q?.get('before') || null, limit: 50 });
      return { items: await outAll(db, r.items), next: r.next };
    },
    async 'wallet-sweep-batch'(b, actor, q) {
      const x = await getBatch(db, q?.get('id') || '');
      if (!x) throw new PayError('not_found', 404);
      const out = (await outAll(db, [x]))[0];
      // 链上确认数（发出后、确认前）：{ have, need }
      if (['sent', 'confirmed', 'partial'].includes(x.status) && x.txRefs?.length && layer?.providers?.[x.provider]?.txConfirmations && enabled().includes(x.chain)) {
        out.confirmations = await layer.providers[x.provider].txConfirmations(x.chain, x.txRefs[0]).catch(() => ({ have: null, need: null }));
      }
      return out;
    },
    /** 现在就凑一批（这条链已有待确认的批次时返回那几批） */
    async 'wallet-sweep-propose'(b, actor) {
      const chain = String(b.chain || '');
      if (!enabled().includes(chain)) throw new PayError('chain_not_enabled', 409, 'chain');
      const bs = await proposeSweep(db, { chain, providers: providers(), notify, adminUrl: `${origin}/admin/`, actor, slot: 'manual' });
      return { batches: await outAll(db, bs) };
    },
    /** 确认归集：原因必填，不要动态码（钱只能进冷钱包） */
    async 'wallet-sweep-approve'(b, actor) {
      return approveSweep(db, { id: String(b.id || ''), actor, reason: b.reason, providers: providers(), notify });
    },
    async 'wallet-sweep-cancel'(b, actor) {
      return cancelSweep(db, { id: String(b.id || ''), actor, reason: b.reason });
    },
    async 'wallet-sweep-settings'() {
      return settingsForHumans(await getSweepSettings(db));
    },
    /** 改门槛和上限：动态码、原因必填，审计记修改前后的值 */
    async 'wallet-sweep-settings-save'(b, actor) {
      const values = settingsFromForm(b.values);
      const next = await updateSweepSettings(db, { actor, reason: b.reason, values, code: b.code, verifyCode: (c) => verifyAdminCode(c) });
      return settingsForHumans(next);
    },

    /** 钱包提供方：每条链现在用哪家、切换记录、每家的状态和地址数 */
    async 'wallet-routes'() {
      const { current, history } = await routeOverview(db, { now: now() });
      const counts = await db.query(`select chain, provider, status, count(*)::int n from customer_addresses group by 1, 2, 3`);
      const ps = PROVIDER_IDS.map((id) => {
        const p = layer?.providers?.[id];
        return { id, enabled: Boolean(p && p.enabled !== false), status: p?.health ? p.health().status : 'not_enabled' };
      });
      return {
        chains: CHAINS.map((chain) => ({
          chain, provider: current[chain], not_in_this_batch: CHAINS_NOT_IN_BATCH.includes(chain) || (chain === 'tron' && !enabled().includes('tron')),
          addresses: counts.filter((c) => c.chain === chain).map((c) => ({ provider: c.provider, status: c.status, address_count: c.n })),
        })),
        providers: ps,
        history: history.map((h) => ({ chain: h.chain, provider: h.provider, effective_from: new Date(h.effective_from).toISOString(), actor: h.actor, reason: h.reason })),
      };
    },
    /** 按链整体切换提供方：动态码、原因必填、审计；只影响新分配的地址 */
    async 'wallet-route-set'(b, actor) {
      return setChainProvider(db, { chain: String(b.chain || ''), provider: String(b.provider || ''), actor, reason: b.reason, providers: providers(), code: b.code, verifyCode: (c) => verifyAdminCode(c) });
    },
  };
}
