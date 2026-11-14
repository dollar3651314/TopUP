// 以太坊、BSC 批量打款的链上一侧（第 3 批）：按链凑批（三者取最小，读链上热钱包余额和授权额度）→ 出未签名交易原文 →
// 浏览器解码核对后用热钱包私钥签名、只把签名交回 → 服务器套签名（签名人必须是该链热钱包）、广播的就是自己存的那份原文 →
// worker 按回执整批确认或整批回到已审核（Q15）。改授权额度（以太坊 USDT 非 0 改非 0 先归零再设，两笔；BSC 一笔；TRON 不用）。
// 服务器上没有热钱包私钥；交易只能调用 BatchPayout.pay（只花热钱包自己的额度），或 USDT 的 approve(BatchPayout, 数额)。
import { randomBytes } from 'node:crypto';
import { PayError, audit, getMeta, setMeta } from '../pay/core.js';
import { getPayoutLimits, planPayoutBatches, effectiveBatchCap, createPayoutTxBatch, settlePayoutBatch, expirePayoutBatch } from '../pay/payout.js';
import { encodePayCall, encodeApproveCall, encodeUnsignedLegacyTx, attachSignature, checkPayoutTx, checkApproveTx, CodecError } from './evm-payout-codec.js';
import { toUnits, fromUnits } from './units.js';
import { fmtUsdt } from '../pay/money.js';

/** 每笔交易网络费上限（gas × gasPrice，wei）：签名页面用同样的常量自己核对，服务器出的交易超了直接不出 */
export const MAX_FEE_WEI = Object.freeze({ eth: 2n * 10n ** 17n, bsc: 5n * 10n ** 16n });
const GAS = { base: 60_000n, perItem: 45_000n, approve: 80_000n };
const STALE_MS = 30 * 60_000; // 广播后 30 分钟节点还不认识这笔交易：当作没发出去，整批回到已审核
const ALLOWANCE_TTL_MS = 30 * 60_000; // 改额度的两笔要在 30 分钟内签完，期间这条链的打款暂停
const usdt = (u) => fmtUsdt(Number(u)).replace(/,/g, '');

export function createPayoutService({ db, chains = {}, verifyCode, now = () => Date.now(), notify = null }) {
  const cfgOf = (chain) => {
    const c = chains[chain];
    if (!c) throw new PayError(chain === 'tron' ? 'not_applicable' : 'chain_not_enabled', 409, 'chain');
    return c;
  };
  const ids = {};
  const chainIdOf = async (chain) => { const c = cfgOf(chain); if (c.chainId) return BigInt(c.chainId); ids[chain] ??= await c.adapter.chainId(); return ids[chain]; };
  const decode = (fn) => { try { return fn(); } catch (e) { if (e instanceof CodecError) throw new PayError(e.code, 422); throw e; } };
  const allowanceKey = (chain) => `payout_allowance_${chain}`;
  async function allowanceBusy(chain) {
    const p = await getMeta(db, allowanceKey(chain));
    return Boolean(p && p.steps?.some((s) => !s.done) && now() - Date.parse(p.at) < ALLOWANCE_TTL_MS);
  }
  async function gasFor(c, data, fallback) {
    try { const g = await c.adapter.estimateGas({ from: c.hot, to: data.to, data: data.data }); return g * 12n / 10n; } catch { return fallback; }
  }
  /** 广播：节点明确拒绝 → 抛出 rejected；连不上 → 不算失败（按本地算出的交易号查） */
  async function broadcast(c, raw) {
    try { await c.adapter.sendRaw(raw); return null; }
    catch (e) { if (e?.code === 'rpc_unreachable' || e?.code === 'rpc_http') return 'unreachable'; return e?.message || 'rejected'; }
  }

  async function status(chain) {
    const c = cfgOf(chain);
    const [hotRaw, alRaw] = await Promise.all([c.adapter.tokenBalanceRaw(c.hot, c.token), c.adapter.allowanceRaw(c.hot, c.contract, c.token)]);
    const hot = toUnits(hotRaw, c.decimals), allowance = toUnits(alRaw, c.decimals);
    const limits = await getPayoutLimits(db);
    const { cap, by } = effectiveBatchCap({ perBatch: limits.perBatch, hotBalance: hot, allowance });
    return { chain, hot: c.hot, contract: c.contract, hot_balance: Number(hot), allowance: Number(allowance), cap: Number(cap), by, limits, hot_low: Number(hot) < limits.hotLow, allowance_busy: await allowanceBusy(chain) };
  }

  /** 这条链所有已审核、不在批次里的单 → 凑批出交易（每批一笔 pay）；之前没签名的批次先作废（单回到已审核） */
  async function plan(chain, { actor = 'admin' } = {}) {
    const c = cfgOf(chain);
    if (await allowanceBusy(chain)) throw new PayError('allowance_in_progress', 409);
    for (const b of await db.query(`select id from payout_tx_batches where chain = $1 and status = 'planned'`, [chain])) await expirePayoutBatch(db, b.id);
    const rows = await db.query(`select id, amount, to_address from withdrawals where chain = $1 and status = 'approved' and batch_id is null order by approved_at, created_at, coalesce(batch_line, 0), id`, [chain]);
    const st = await status(chain);
    const p = planPayoutBatches(rows.map((r) => ({ id: r.id, amount: Number(r.amount), to: r.to_address })), { chain, perBatch: st.limits.perBatch, hotBalance: st.hot_balance, allowance: st.allowance, perItem: st.limits.perItem });
    const chainId = await chainIdOf(chain);
    const out = [];
    if (p.batches.length) {
      let nonce = await c.adapter.nonce(c.hot);
      const gasPrice = await c.adapter.gasPrice();
      for (const b of p.batches) {
        const batchId = '0x' + randomBytes(32).toString('hex');
        const items = b.items.map((i) => ({ to: i.to, amount: fromUnits(i.amount, c.decimals) }));
        const data = encodePayCall(c.token, batchId, items);
        const gas = await gasFor(c, { to: c.contract, data }, GAS.base + GAS.perItem * BigInt(items.length));
        if (gas * gasPrice > MAX_FEE_WEI[chain]) throw new PayError('fee_too_high', 409);
        const rawHex = encodeUnsignedLegacyTx({ nonce, gasPrice, gas, to: c.contract, value: 0, data, chainId });
        const expect = { chainId: String(chainId), contract: c.contract, token: c.token, batchId, items: items.map((i) => ({ to: i.to, amount: String(i.amount) })), maxFeeWei: String(MAX_FEE_WEI[chain]) };
        decode(() => checkPayoutTx(rawHex, expect)); // 出给页面之前自己先核对一遍
        const id = await createPayoutTxBatch(db, { chain, ids: b.items.map((i) => i.id), actor, total: Number(b.total), extra: { batchHex: batchId, rawHex, expect } });
        out.push({ id, chain, rawHex, expect, total: Number(b.total), nonce: String(nonce), fee_wei: String(gas * gasPrice), items: b.items.map((i) => ({ id: i.id, to: i.to, amount: i.amount })) });
        nonce += 1n;
      }
      await audit(db, actor, 'payout.plan', chain, { batches: out.map((x) => x.id), held: p.held.length });
    }
    return { chain, cap: Number(p.cap), by: p.by, batches: out, held: p.held };
  }

  /** 收签名：签名人必须是这条链的热钱包；广播服务器自己存的原文 + 签名 */
  async function submit(id, { sigHex, actor = 'admin' }) {
    const [b] = await db.query('select * from payout_tx_batches where id = $1', [String(id || '')]);
    if (!b) throw new PayError('not_found', 404);
    if (b.status !== 'planned' || !b.raw_hex) throw new PayError('invalid_state', 409);
    const c = cfgOf(b.chain);
    const signed = decode(() => attachSignature(b.raw_hex, String(sigHex || '')));
    if (signed.from.toLowerCase() !== c.hot.toLowerCase()) throw new PayError('wrong_signer', 422, 'signature');
    // 先占住这一批（同一批不能交两次）
    const [claimed] = await db.query(`update payout_tx_batches set status = 'broadcast', tx_hash = $2, updated_at = now() where id = $1 and status = 'planned' returning id`, [b.id, signed.hash]);
    if (!claimed) throw new PayError('invalid_state', 409);
    await db.query(`update withdrawals set status = 'broadcast', txid = $2, updated_at = now() where batch_id = $1 and status = 'signing'`, [b.id, signed.hash]);
    await audit(db, actor, 'payout.signed', b.id, { chain: b.chain, tx_hash: signed.hash, count: b.item_ids.length });
    const err = await broadcast(c, signed.raw);
    if (err && err !== 'unreachable') {
      await settlePayoutBatch(db, b.id, { success: false, error: String(err).slice(0, 300) });
      if (notify) await notify(`打款没发出去：${b.id}`, `节点拒绝了这笔打款交易（${String(err).slice(0, 200)}），这一批 ${b.item_ids.length} 笔已回到"已审核"，钱没动，可以重新凑批签名。`);
      throw new PayError('broadcast_rejected', 409);
    }
    return { id: b.id, tx_hash: signed.hash, status: 'broadcast', unreachable: err === 'unreachable' };
  }

  /** worker 每轮：已广播的批次按回执整批确认或整批回到已审核 */
  async function confirm() {
    const rows = await db.query(`select * from payout_tx_batches where status = 'broadcast' and chain = any($1::text[]) order by created_at limit 50`, [Object.keys(chains)]);
    const out = { confirmed: 0, failed: 0, pending: 0 };
    for (const b of rows) {
      const c = chains[b.chain];
      const s = await c.adapter.txStatus(b.tx_hash);
      if (s === 'confirmed') { await settlePayoutBatch(db, b.id, { success: true, txid: b.tx_hash }); out.confirmed++; continue; }
      let gone = s === 'failed';
      if (s === 'pending' && now() - new Date(b.updated_at).getTime() > STALE_MS) gone = !(await c.adapter.txKnown(b.tx_hash).catch(() => true));
      if (!gone) { out.pending++; continue; }
      await settlePayoutBatch(db, b.id, { success: false, error: s === 'failed' ? 'reverted' : 'dropped' });
      out.failed++;
      if (notify) await notify(`打款整批回滚：${b.id}`, `${b.chain.toUpperCase()} 打款交易 ${b.tx_hash} ${s === 'failed' ? '在链上失败（整笔回滚）' : '30 分钟后节点仍查不到'}，这一批 ${b.item_ids.length} 笔都回到了"已审核"，商户余额没动。请到运营后台"打款审核"重新凑批签名。`);
    }
    return out;
  }

  /** 改授权额度：原因 + 动态码，审计；以太坊当前不是 0 时先 approve(0) 再 approve(新值) 两笔 */
  async function allowancePlan(chain, { amount, reason, code, actor = 'admin' }) {
    const c = cfgOf(chain);
    if (!String(reason || '').trim()) throw new PayError('reason_required', 422, 'reason');
    if (!verifyCode || !(await verifyCode(String(code || '')))) throw new PayError('bad_code', 400);
    const units = typeof amount === 'number' ? amount : /^\d{1,16}$/.test(String(amount)) ? Number(amount) : NaN;
    if (!Number.isSafeInteger(units) || units < 0) throw new PayError('invalid_param', 422, 'amount');
    const target = fromUnits(units, c.decimals);
    const current = await c.adapter.allowanceRaw(c.hot, c.contract, c.token);
    const values = chain === 'eth' && current !== 0n && target !== 0n ? [0n, target] : [target];
    const chainId = await chainIdOf(chain);
    let nonce = await c.adapter.nonce(c.hot);
    const gasPrice = await c.adapter.gasPrice();
    const steps = [];
    for (const v of values) {
      const data = encodeApproveCall(c.contract, v);
      const gas = await gasFor(c, { to: c.token, data }, GAS.approve);
      const rawHex = encodeUnsignedLegacyTx({ nonce, gasPrice, gas, to: c.token, value: 0, data, chainId });
      const expect = { chainId: String(chainId), token: c.token, spender: c.contract, amount: String(v), maxFeeWei: String(MAX_FEE_WEI[chain]) };
      decode(() => checkApproveTx(rawHex, expect));
      steps.push({ rawHex, expect, amount: Number(toUnits(v, c.decimals)) });
      nonce += 1n;
    }
    const why = String(reason).trim().slice(0, 500);
    await setMeta(db, allowanceKey(chain), { at: new Date(now()).toISOString(), actor, reason: why, steps: steps.map((s) => ({ rawHex: s.rawHex, done: false })) });
    await audit(db, actor, 'payout.allowance', chain, { chain, reason: why, before: usdt(toUnits(current, c.decimals)), after: usdt(units), steps: steps.length });
    return { chain, current: Number(toUnits(current, c.decimals)), target: units, steps };
  }
  /** 改额度的一笔签名：rawHex 必须是 allowancePlan 刚给出的、按顺序的下一笔；签名人必须是热钱包 */
  async function allowanceSubmit(chain, { rawHex, sigHex, actor = 'admin' }) {
    const c = cfgOf(chain);
    const p = await getMeta(db, allowanceKey(chain));
    const next = p?.steps?.find((s) => !s.done);
    if (!next || next.rawHex !== rawHex || now() - Date.parse(p.at) > ALLOWANCE_TTL_MS) throw new PayError('invalid_state', 409);
    const signed = decode(() => attachSignature(next.rawHex, String(sigHex || '')));
    if (signed.from.toLowerCase() !== c.hot.toLowerCase()) throw new PayError('wrong_signer', 422, 'signature');
    const err = await broadcast(c, signed.raw);
    if (err && err !== 'unreachable') throw new PayError('broadcast_rejected', 409);
    next.done = true; next.tx_hash = signed.hash;
    await setMeta(db, allowanceKey(chain), p);
    await audit(db, actor, 'payout.allowance_signed', chain, { tx_hash: signed.hash, left: p.steps.filter((s) => !s.done).length });
    return { tx_hash: signed.hash, left: p.steps.filter((s) => !s.done).length };
  }

  return { chains: Object.keys(chains), status, plan, submit, confirm, allowancePlan, allowanceSubmit, config: (chain) => cfgOf(chain) };
}
