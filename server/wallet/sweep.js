// 合约钱包归集（ETH / BSC，半自动）：
//   凑批（每天东八区 10:00、20:00 各一次，另有"现在就凑一批"）→ 存成"待确认"的批次、发一封邮件（没有确认按钮，要登录后台）
//   → 管理员在后台确认（原因必填，不要动态码）→ 发起账户签名、一笔交易 → worker 按回执逐个地址确认（部分成功照记）。
// 待确认超过 24 小时作废，下一轮重凑；失败的地址放回待归集、不自动重试（下一批还要人确认）。
// 归集不写账本、不改商户余额（钱本来就是平台的，只是从充值地址挪到冷钱包）。
// 归集出错只告警（故障时发一次、恢复时发一次，长期没恢复每天一次），不影响 worker 的其他任务。
import { randomBytes } from 'node:crypto';
import { PayError, audit, getMeta, setMeta } from '../pay/core.js';
import { fmtUsdt } from '../pay/money.js';
import { gate } from '../pay/db.js';
import { sweepCandidates } from './addresses.js';
import { planSweep } from './sweep-plan.js';

export { planSweep };
const U = (usdt) => BigInt(usdt) * 1_000_000n;

export const SWEEP_DEFAULTS = {
  thresholds: { eth: U(100), bsc: U(10), tron: U(100) },
  capPerAddress: U(5000),
  capPerBatch: U(20000),
  maxFeeRatioPct: 3,
  maxAddresses: 50,
};
export const SWEEP_TIMES = Object.freeze(['10:00', '20:00']); // 东八区
export const SWEEP_TZ_OFFSET_H = 8;
export const SWEEP_EXPIRE_HOURS = 24;
export const SWEEP_CHAINS = Object.freeze(['eth', 'bsc']);
export const CHAIN_NAMES = Object.freeze({ eth: '以太坊', bsc: 'BSC', tron: 'TRON' });
const ACTIVE_ITEM = ['pending', 'sent'];
const H = 3_600_000;

const at = (now) => new Date(now ?? Date.now());
const usdt = (u) => fmtUsdt(Number(u));
const plainUsdt = (u) => usdt(u).replace(/,/g, '');
const newBatchId = (d) => `SW-${d.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;

// ---------- 设置 ----------
const SETTINGS_KEY = 'wallet_sweep_settings';
const toJson = (s) => ({
  thresholds: Object.fromEntries(Object.entries(s.thresholds).map(([k, v]) => [k, String(v)])),
  capPerAddress: String(s.capPerAddress), capPerBatch: String(s.capPerBatch), maxFeeRatioPct: s.maxFeeRatioPct, maxAddresses: s.maxAddresses,
});
const fromJson = (j) => ({
  thresholds: Object.fromEntries(Object.keys(SWEEP_DEFAULTS.thresholds).map((k) => [k, BigInt(j?.thresholds?.[k] ?? SWEEP_DEFAULTS.thresholds[k])])),
  capPerAddress: BigInt(j?.capPerAddress ?? SWEEP_DEFAULTS.capPerAddress),
  capPerBatch: BigInt(j?.capPerBatch ?? SWEEP_DEFAULTS.capPerBatch),
  maxFeeRatioPct: Number(j?.maxFeeRatioPct ?? SWEEP_DEFAULTS.maxFeeRatioPct),
  maxAddresses: Number(j?.maxAddresses ?? SWEEP_DEFAULTS.maxAddresses),
});
/** 给人看的设置（审计、后台）：金额写成 USDT */
export const settingsForHumans = (s) => ({
  thresholds: Object.fromEntries(Object.entries(s.thresholds).map(([k, v]) => [k, plainUsdt(v)])),
  capPerAddress: plainUsdt(s.capPerAddress), capPerBatch: plainUsdt(s.capPerBatch), maxFeeRatioPct: s.maxFeeRatioPct, maxAddresses: s.maxAddresses,
});

export async function getSweepSettings(db) {
  return fromJson(await getMeta(db, SETTINGS_KEY, null));
}

function units(v, field) {
  let b;
  if (typeof v === 'bigint') b = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) b = BigInt(v);
  else if (typeof v === 'string' && /^\d+$/.test(v)) b = BigInt(v);
  else throw new PayError('invalid_param', 422, field);
  if (b < 0n || b > U(1_000_000_000)) throw new PayError('invalid_param', 422, field);
  return b;
}
/** 检查并规范化设置；字段不对时报出是哪个字段 */
export function checkSweepSettings(v) {
  if (!v || typeof v !== 'object') throw new PayError('invalid_param', 422, 'values');
  const out = {
    thresholds: Object.fromEntries(Object.keys(SWEEP_DEFAULTS.thresholds).map((k) => [k, units(v.thresholds?.[k], `thresholds.${k}`)])),
    capPerAddress: units(v.capPerAddress, 'capPerAddress'),
    capPerBatch: units(v.capPerBatch, 'capPerBatch'),
    maxFeeRatioPct: Number(v.maxFeeRatioPct),
    maxAddresses: Number(v.maxAddresses ?? SWEEP_DEFAULTS.maxAddresses),
  };
  if (!Number.isFinite(out.maxFeeRatioPct) || out.maxFeeRatioPct < 0 || out.maxFeeRatioPct > 100) throw new PayError('invalid_param', 422, 'maxFeeRatioPct');
  if (!Number.isInteger(out.maxAddresses) || out.maxAddresses < 1 || out.maxAddresses > 200) throw new PayError('invalid_param', 422, 'maxAddresses');
  if (out.capPerAddress > 0n && out.capPerBatch > 0n && out.capPerAddress > out.capPerBatch) throw new PayError('invalid_param', 422, 'capPerAddress');
  return out;
}

/** 改门槛和上限：动态码、原因必填，审计记修改前后的值 */
export async function updateSweepSettings(db, { actor, reason, values, code, verifyCode }) {
  const why = String(reason ?? '').trim();
  if (!code || typeof verifyCode !== 'function' || !(await verifyCode(String(code)))) throw new PayError('bad_code', 422, 'code');
  if (!why) throw new PayError('reason_required', 422, 'reason');
  const next = checkSweepSettings(values);
  const before = await getSweepSettings(db);
  await db.tx(async (t) => {
    await setMeta(t, SETTINGS_KEY, toJson(next));
    await audit(t, actor, 'wallet.sweep_settings', '', { reason: why.slice(0, 500), before: settingsForHumans(before), after: settingsForHumans(next) });
  });
  return next;
}

function limitsFor(settings, chain, provider) {
  return {
    threshold: settings.thresholds[chain] ?? 0n, capPerAddress: settings.capPerAddress, capPerBatch: settings.capPerBatch,
    maxFeeRatioPct: settings.maxFeeRatioPct, maxAddresses: settings.maxAddresses, schemeVer: provider.schemeVer?.(chain),
  };
}

// ---------- 凑批时间 ----------
/** 到点的凑批时间点（UTC ISO）或 null：同一个时间点只凑一次；worker 停了一阵只补最近的一个 */
export function sweepSlotDue(nowMs, lastSlotIso) {
  const slots = [];
  const d = new Date(nowMs);
  for (const back of [0, 1]) {
    const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
    for (const t of SWEEP_TIMES) {
      const [h, m] = t.split(':').map(Number);
      slots.push(base + (h - SWEEP_TZ_OFFSET_H) * H + m * 60_000);
    }
  }
  const latest = Math.max(...slots.filter((s) => s <= nowMs));
  if (lastSlotIso && Date.parse(lastSlotIso) >= latest) return null;
  return new Date(latest).toISOString();
}
/** 下一次凑批的时间（后台显示） */
export function nextSweepSlot(nowMs) {
  for (let i = 0; i < 3; i++) {
    const d = new Date(nowMs);
    const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i);
    for (const t of SWEEP_TIMES) {
      const [h, m] = t.split(':').map(Number);
      const s = base + (h - SWEEP_TZ_OFFSET_H) * H + m * 60_000;
      if (s > nowMs) return new Date(s).toISOString();
    }
  }
  return null;
}

// ---------- 批次 ----------
async function itemsOf(q, ids) {
  if (!ids.length) return new Map();
  const rows = await q.query('select * from wallet_sweep_items where batch_id = any($1::text[]) order by id', [ids]);
  const m = new Map(ids.map((id) => [id, []]));
  for (const r of rows) m.get(r.batch_id).push(r);
  return m;
}
function batchView(b, items = []) {
  return {
    id: b.id, status: b.status, chain: b.chain, provider: b.provider,
    items: items.map((i) => ({ address: i.address, salt: i.salt, amount: BigInt(i.amount), deploy: i.deploy, status: i.status, reason: i.reason || null })),
    total: BigInt(b.total), addressCount: b.address_count, skipped: b.skipped || [], feeEstimate: b.fee_estimate || {},
    txRefs: b.tx_refs || [], slot: b.slot || '', approvedBy: b.approved_by || null, approvedAt: b.approved_at ? new Date(b.approved_at).toISOString() : null,
    reason: b.reason || null, error: b.error || null,
    createdAt: new Date(b.created_at).toISOString(), expiresAt: new Date(b.expires_at).toISOString(), updatedAt: new Date(b.updated_at).toISOString(),
  };
}
export async function getBatch(db, id) {
  const [b] = await db.query('select * from wallet_sweep_batches where id = $1', [id]);
  if (!b) return null;
  return batchView(b, (await itemsOf(db, [id])).get(id));
}
export async function listBatches(db, { chain = '', status = '', limit = 50, before = null } = {}) {
  const vals = [Math.min(200, Math.max(1, limit)) + 1];
  let where = 'true';
  if (chain) { vals.push(chain); where += ` and chain = $${vals.length}`; }
  if (status) { vals.push(status.split(',')); where += ` and status = any($${vals.length}::text[])`; }
  if (before) { vals.push(new Date(before)); where += ` and created_at < $${vals.length}`; }
  const rows = await db.query(`select * from wallet_sweep_batches where ${where} order by created_at desc, id desc limit $1`, vals);
  const more = rows.length > vals[0] - 1;
  const page = more ? rows.slice(0, -1) : rows;
  const items = await itemsOf(db, page.map((b) => b.id));
  return { items: page.map((b) => batchView(b, items.get(b.id))), next: more ? new Date(page.at(-1).created_at).toISOString() : null };
}

/** 待确认超过 24 小时的作废：批次 expired，地址放回待归集 */
export async function expireStale(db, { now } = {}) {
  const rows = await db.query(`update wallet_sweep_batches set status = 'expired', updated_at = now() where status = 'awaiting_approval' and expires_at <= $1 returning id`, [at(now)]);
  if (rows.length) await db.query(`update wallet_sweep_items set status = 'released', reason = 'expired' where batch_id = any($1::text[]) and status = 'pending'`, [rows.map((r) => r.id)]);
  return rows.length;
}

async function awaiting(q, chain, now) {
  const rows = await q.query(`select * from wallet_sweep_batches where chain = $1 and status = 'awaiting_approval' and expires_at > $2 order by created_at, id`, [chain, at(now)]);
  const items = await itemsOf(q, rows.map((b) => b.id));
  return rows.map((b) => batchView(b, items.get(b.id)));
}

/**
 * 凑批：门槛、上限按当前设置（或传入的 limits）；没有可归集的返回 []、不发邮件。
 * 这条链已有没过期的待确认批次时返回那几批，不新建、不再发邮件。一次凑出几批也只发一封邮件。
 */
export async function proposeSweep(db, { chain, providers = {}, notify, provider: providerId = 'contract', limits, now, slot = '', adminUrl = '', actor = 'system', balanceConcurrency = 8 }) {
  if (!SWEEP_CHAINS.includes(chain)) throw new PayError('chain_not_enabled', 409, 'chain');
  const p = providers[providerId];
  if (!p || p.enabled === false) throw new PayError('provider_not_enabled', 409, 'provider');
  await expireStale(db, { now });
  const existing = await awaiting(db, chain, now);
  if (existing.length) return existing;

  const settings = limits?.thresholds ? limits : limits ? null : await getSweepSettings(db);
  const lim = settings ? limitsFor(settings, chain, p) : { ...limits, schemeVer: limits.schemeVer ?? p.schemeVer?.(chain) };
  // 候选和余额在事务外读（访问节点，不能放进事务）
  const inBatch = new Set((await db.query(`select lower(address) a from wallet_sweep_items where chain = $1 and status = any($2::text[])`, [chain, ACTIVE_ITEM])).map((r) => r.a));
  const cands = await sweepCandidates(db, { chain, provider: providerId });
  const run = gate(balanceConcurrency);
  const enriched = await Promise.all(cands.map((c) => run(async () => {
    const balance = BigInt(await p.balance(chain, { address: c.address }));
    const deployed = balance > 0n && typeof p.isDeployed === 'function' ? await p.isDeployed(chain, c.address) : false;
    return { ...c, balance, deployed, estFee: null, inBatch: inBatch.has(c.address.toLowerCase()) };
  })));
  const plan = await p.planSweep(chain, enriched, lim);
  if (!plan.batches.length) return [];

  const fees = [];
  for (const b of plan.batches) {
    let fee = {};
    if (typeof p.estimateFee === 'function') {
      try {
        const deploy = b.items.filter((i) => i.deploy).length;
        const f = await p.estimateFee(chain, 'sweep', b.items.length, { deploy });
        fee = { native: String(f.native ?? ''), gas: f.gas != null ? String(f.gas) : undefined, gas_price: f.gasPrice != null ? String(f.gasPrice) : undefined };
      } catch { fee = {}; }
    }
    fees.push(fee);
  }
  const when = at(now);
  const created = await db.tx(async (t) => {
    await t.query(`insert into pay_meta (key, value) values ('wallet_sweep_lock', '{}'::jsonb) on conflict (key) do nothing`);
    await t.query(`select 1 from pay_meta where key = 'wallet_sweep_lock' for update`);
    const raced = await awaiting(t, chain, now);
    if (raced.length) return { raced };
    const skipped = plan.skipped.map((s) => ({ address: s.address, amount: String(s.amount), reason: s.reason }));
    const ids = [];
    for (const [i, b] of plan.batches.entries()) {
      const id = newBatchId(when);
      ids.push(id);
      await t.query(`insert into wallet_sweep_batches (id, chain, provider, status, total, address_count, skipped, fee_estimate, slot, created_at, expires_at, updated_at)
        values ($1, $2, $3, 'awaiting_approval', $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $9)`,
        [id, chain, providerId, String(b.total), b.items.length, JSON.stringify(i === 0 ? skipped : []), JSON.stringify(fees[i]), slot, when, new Date(when.getTime() + SWEEP_EXPIRE_HOURS * H)]);
      for (const it of b.items) {
        await t.query(`insert into wallet_sweep_items (batch_id, chain, address, salt, amount, deploy, status) values ($1, $2, $3, $4, $5, $6, 'pending')`,
          [id, chain, it.address, it.salt, String(it.amount), it.deploy]);
      }
    }
    await audit(t, actor, 'wallet.sweep_propose', chain, { batches: ids, total: plainUsdt(plan.total), slot });
    return { ids };
  });
  if (created.raced) return created.raced;
  const batches = await Promise.all(created.ids.map((id) => getBatch(db, id)));
  if (notify) {
    const name = CHAIN_NAMES[chain];
    const lines = batches.map((b, i) => `- 第 ${i + 1} 批：${b.addressCount} 个地址，合计 ${usdt(b.total)} USDT`);
    const reasons = {};
    for (const s of plan.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    const why = { inBatch: '已在别的批次里', otherScheme: '合约参数不是当前这套', belowThreshold: '低于门槛', overAddressCap: '超过每地址上限', feeRatio: '手续费占比太高' };
    const skippedLine = Object.keys(reasons).length ? `\n这次跳过的地址：${Object.entries(reasons).map(([k, n]) => `${why[k] || k} ${n} 个`).join('，')}（在后台可以看到明细）。` : '';
    await notify(`归集待确认：${name} ${batches.length} 批，合计 ${usdt(plan.total)} USDT`,
      `${name} 有 ${batches.length} 批归集等你确认，合计 ${usdt(plan.total)} USDT，钱只会进冷钱包。\n${lines.join('\n')}${skippedLine}\n\n`
      + `请登录运营后台，在"归集"页核对后确认${adminUrl ? `（${adminUrl}）` : ''}。这封邮件里没有确认按钮。\n`
      + `${SWEEP_EXPIRE_HOURS} 小时内没有确认的批次会作废，下一次凑批时重新列出。`);
  }
  return batches;
}

/** 管理员确认一批：原因必填（不要动态码）；只有待确认、没过期的能确认，确认后只执行一次 */
export async function approveSweep(db, { id, actor, reason, providers = {}, now }) {
  const why = String(reason ?? '').trim();
  if (!why) throw new PayError('reason_required', 422, 'reason');
  const when = at(now);
  const step = await db.tx(async (t) => {
    const [b] = await t.query('select * from wallet_sweep_batches where id = $1 for update', [id]);
    if (!b) throw new PayError('not_found', 404);
    if (b.status === 'awaiting_approval' && new Date(b.expires_at) <= when) {
      await t.query(`update wallet_sweep_batches set status = 'expired', updated_at = now() where id = $1`, [id]);
      await t.query(`update wallet_sweep_items set status = 'released', reason = 'expired' where batch_id = $1 and status = 'pending'`, [id]);
      return { expired: true };
    }
    if (b.status !== 'awaiting_approval') throw new PayError('batch_state', 409);
    const p = providers[b.provider];
    if (!p || p.enabled === false) throw new PayError('provider_not_enabled', 409);
    await t.query(`update wallet_sweep_batches set status = 'sending', approved_by = $2, approved_at = $3, reason = $4, updated_at = now() where id = $1`, [id, actor, when, why.slice(0, 500)]);
    await audit(t, actor, 'wallet.sweep_approve', id, { chain: b.chain, total: plainUsdt(b.total), addresses: b.address_count, reason: why.slice(0, 500) });
    return { batch: b };
  });
  if (step.expired) throw new PayError('batch_expired', 409);
  const b = step.batch;
  const items = (await itemsOf(db, [id])).get(id).map((i) => ({ address: i.address, salt: i.salt, amount: BigInt(i.amount), deploy: i.deploy }));
  let res;
  try {
    res = await providers[b.provider].executeSweep({ chain: b.chain, items });
  } catch (e) {
    if (e?.stage === 'prepare') {
      // 交易还没签出去（例如节点连不上）：退回待确认，可以稍后再点
      await db.query(`update wallet_sweep_batches set status = 'awaiting_approval', error = $2, updated_at = now() where id = $1`, [id, String(e.message).slice(0, 300)]);
      throw new PayError('sweep_not_sent', 502);
    }
    await db.tx(async (t) => {
      await t.query(`update wallet_sweep_batches set status = 'failed', error = $2, updated_at = now() where id = $1`, [id, String(e?.message || e).slice(0, 300)]);
      await t.query(`update wallet_sweep_items set status = 'released', reason = 'send_failed' where batch_id = $1 and status = 'pending'`, [id]);
    });
    throw new PayError('sweep_send_failed', 502);
  }
  const txRefs = res?.txRefs || [];
  await db.tx(async (t) => {
    await t.query(`update wallet_sweep_batches set status = 'sent', tx_refs = $2::jsonb, error = null, updated_at = now() where id = $1`, [id, JSON.stringify(txRefs)]);
    await t.query(`update wallet_sweep_items set status = 'sent' where batch_id = $1 and status = 'pending'`, [id]);
  });
  return { status: 'sent', txRefs };
}

/** 不归集这批：待确认的批次作废，地址放回待归集 */
export async function cancelSweep(db, { id, actor, reason }) {
  const why = String(reason ?? '').trim();
  if (!why) throw new PayError('reason_required', 422, 'reason');
  return db.tx(async (t) => {
    const [b] = await t.query(`update wallet_sweep_batches set status = 'cancelled', reason = $2, updated_at = now() where id = $1 and status = 'awaiting_approval' returning *`, [id, why.slice(0, 500)]);
    if (!b) throw new PayError('batch_state', 409);
    await t.query(`update wallet_sweep_items set status = 'released', reason = 'cancelled' where batch_id = $1 and status = 'pending'`, [id]);
    await audit(t, actor, 'wallet.sweep_cancel', id, { chain: b.chain, reason: why.slice(0, 500) });
    return { status: 'cancelled' };
  });
}

// ---------- 告警（故障发一次、恢复发一次、长期没恢复每天一次；重启不重发） ----------
export async function raiseAlert(db, key, notify, subject, text, { now } = {}) {
  const k = `alert_${key}`;
  const cur = await getMeta(db, k, null);
  const t = at(now).getTime();
  if (cur && t - Date.parse(cur.last) < 24 * H) return false;
  await setMeta(db, k, { since: cur?.since || new Date(t).toISOString(), last: new Date(t).toISOString(), subject });
  if (notify) await notify(subject, text);
  return true;
}
export async function clearAlert(db, key, notify, subject, text) {
  const k = `alert_${key}`;
  const cur = await getMeta(db, k, null);
  if (!cur) return false;
  await db.query('delete from pay_meta where key = $1', [k]);
  if (notify) await notify(subject, text);
  return true;
}

/** worker 每轮：作废过期的待确认批次；已发出的批次按回执逐个地址确认。出错只告警，不抛出 */
export async function confirmSweeps(db, { providers = {}, notify, now } = {}) {
  const out = { expired: 0, checked: 0, confirmed: 0, partial: 0, failed: 0, errors: [] };
  try { out.expired = await expireStale(db, { now }); } catch (e) { out.errors.push(e.message); }
  let sent = [];
  try { sent = await db.query(`select * from wallet_sweep_batches where status = 'sent' order by updated_at limit 20`); } catch (e) { out.errors.push(e.message); }
  for (const b of sent) {
    try {
      const p = providers[b.provider];
      if (!p) throw new Error(`provider ${b.provider} is not available`);
      const items = (await itemsOf(db, [b.id])).get(b.id);
      const plain = items.map((i) => ({ address: i.address, salt: i.salt, amount: BigInt(i.amount), deploy: i.deploy }));
      let status = 'confirmed';
      const swept = new Set(), failed = new Map();
      for (const ref of b.tx_refs || []) {
        const r = typeof p.sweepOutcome === 'function'
          ? await p.sweepOutcome(b.chain, ref, plain)
          : await (async () => { const s = await p.txStatus(b.chain, ref); return { status: s, swept: s === 'confirmed' ? plain.map((i) => i.address) : [], failed: s === 'failed' ? plain.map((i) => ({ address: i.address, reason: 'tx_failed' })) : [] }; })();
        if (r.status === 'pending' || r.status === 'unknown') { status = 'wait'; break; }
        for (const a of r.swept) swept.add(a);
        for (const f of r.failed) failed.set(f.address, f.reason || 'failed');
      }
      out.checked++;
      if (status === 'wait') continue;
      const final = !failed.size ? 'confirmed' : swept.size ? 'partial' : 'failed';
      await db.tx(async (t) => {
        await t.query(`update wallet_sweep_batches set status = $2, updated_at = now() where id = $1 and status = 'sent'`, [b.id, final]);
        for (const i of items) {
          if (failed.has(i.address)) await t.query(`update wallet_sweep_items set status = 'released', reason = $2 where id = $1`, [i.id, failed.get(i.address)]);
          else await t.query(`update wallet_sweep_items set status = 'swept' where id = $1`, [i.id]);
        }
      });
      out[final]++;
      if (final !== 'confirmed' && notify) {
        const name = CHAIN_NAMES[b.chain];
        const okAmt = items.filter((i) => !failed.has(i.address)).reduce((s, i) => s + BigInt(i.amount), 0n);
        const bad = items.filter((i) => failed.has(i.address));
        await notify(final === 'partial' ? `归集部分成功：${name} ${b.id}` : `归集失败：${name} ${b.id}`,
          `${name} 批次 ${b.id}：成功 ${items.length - bad.length} 个地址（${usdt(okAmt)} USDT），失败 ${bad.length} 个。\n`
          + `${bad.map((i) => `- ${i.address}：${failed.get(i.address)}`).join('\n')}\n\n失败的地址已放回待归集，不会自动重试；下一次凑批会重新列出，仍要你在后台确认。`);
      }
    } catch (e) {
      out.errors.push(`${b.id}: ${e.message}`);
    }
  }
  if (out.errors.length) {
    await raiseAlert(db, 'sweep_confirm', notify, '归集确认出错', `查询归集交易的结果时出错（会自动重试，不影响收款）：\n${out.errors.slice(0, 5).join('\n')}`, { now }).catch(() => {});
  } else {
    await clearAlert(db, 'sweep_confirm', notify, '归集确认已恢复', '查询归集交易的结果已恢复正常。').catch(() => {});
  }
  return out;
}

/** 到点的凑批（worker 调用）：每条链各凑一次，记下这个时间点，同一个时间点只凑一次 */
export async function proposeDue(db, { chains = SWEEP_CHAINS, providers, notify, adminUrl, now = Date.now() } = {}) {
  const last = await getMeta(db, 'wallet_sweep_slot', null);
  const slot = sweepSlotDue(now, last);
  if (!slot) return { slot: null };
  await setMeta(db, 'wallet_sweep_slot', slot);
  // 第一次运行（刚部署）：只记下最近的时间点，不立刻凑批；从下一个时间点开始
  if (!last) return { slot, first: true };
  const out = { slot, chains: {} };
  for (const chain of chains) {
    try {
      const bs = await proposeSweep(db, { chain, providers, notify, adminUrl, now, slot });
      out.chains[chain] = bs.length;
    } catch (e) { out.chains[chain] = { error: e.message }; }
  }
  return out;
}
