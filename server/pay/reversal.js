// v1.1 冲正和欠款：到账入账后 24 小时内复核它还在不在链上（链重组等会让已确认的转账消失），没了就冲正。
// - 复核排期（deposits.recheck_*）：入账后 30 分钟、12 小时各复核一次（确认还在才算数）；节点连不上、节点落后于扫链进度都不算消失，10 分钟后再查。
//   第一次查到"没了"先记下，至少隔 10 分钟再查一次（节点不能落后），仍然没了才冲正；第二次查到还在就不冲正。确认这一次最晚在入账后 25 小时内。
//   每次复核记一行 deposit_rechecks（present / gone / error）。
// - 冲正（reverseDeposit，一个事务）：账本追加一行 reversal（扣回入账金额 = 到账 − 收款手续费，即退回手续费）；可用余额不够扣时扣到 0，
//   差额记进 balances.debt（余额不许为负的约束不变）；到账标 reversed；解除订单匹配并发 order.matched；回调 deposit.reversed；
//   客户合计（总额、笔数、手续费）和第 0 批老 TRON 地址的未归集金额减回；运营后台"异常到账"加一行 reversal。事务提交后发邮件给管理员。
// - 欠款：有欠款时不能提币（core.assertNoDebt），之后的到账先还欠款（core.repayDebt）。
import { PayError, postDebt, releaseDepositMatch, enqueueCallback, getMeta } from './core.js';
import { fmtUsdt } from './money.js';

const MIN = 60_000, HOUR = 60 * MIN;
/** 例行复核：入账后多久（第 1 次、第 2 次）。都要在 24 小时内 */
export const RECHECK_AT = [30 * MIN, 12 * HOUR];
export const RECHECK_WINDOW_MS = 24 * HOUR;
/** 查到"没了"之后的确认复核：至少隔 10 分钟，最晚入账后 25 小时 */
export const CONFIRM_GAP_MS = 10 * MIN;
export const CONFIRM_WINDOW_MS = 25 * HOUR;
/** 节点连不上 / 落后：隔多久再查 */
export const RETRY_MS = 10 * MIN;

const usd = (u) => fmtUsdt(Number(u));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const errCode = (e) => String(e?.code || 'error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'error';

/**
 * worker 每轮调用：复核到期的到账。check({ id, chain, txid, logIndex, block, address, amount }, { confirm }) → true 还在 / false 没了；抛错 = 节点连不上或落后，不下结论。
 * confirm：查到"没了"之后的确认复核（适配器要用不落后的节点，落后就抛错）。
 * 返回 { checked, reversed, inconclusive }
 */
export async function recheckDeposits(db, { now = Date.now(), check, notify = null, limit = 200 } = {}) {
  const at = new Date(Number(now));
  const nowMs = at.getTime();
  const due = await db.query(`select id, chain, txid, log_index, block, address, amount, created_at, recheck_n, recheck_gone_at from deposits
    where result = 'credited' and recheck_next_at is not null and recheck_next_at <= $1 order by recheck_next_at, id limit $2`, [at, limit]);
  const out = { checked: 0, reversed: 0, inconclusive: 0 };
  const log = (id, result, detail = '') => db.query('insert into deposit_rechecks (deposit_id, checked_at, result, detail) values ($1, $2, $3, $4)', [id, at, result, detail]);
  const setNext = (id, fields) => db.query(`update deposits set recheck_next_at = $2, recheck_n = $3, recheck_gone_at = $4 where id = $1 and result = 'credited'`,
    [id, fields.next === null ? null : new Date(fields.next), fields.n, fields.goneAt === null ? null : new Date(fields.goneAt)]);
  for (const d of due) {
    const created = new Date(d.created_at).getTime();
    const age = nowMs - created;
    const confirming = Boolean(d.recheck_gone_at);
    const n = Number(d.recheck_n) || 0;
    // 过了窗口：不再复核（最后一次没下结论的，运营后台"复核没下结论的"列出）
    if (age > (confirming ? CONFIRM_WINDOW_MS : RECHECK_WINDOW_MS)) { await setNext(d.id, { next: null, n, goneAt: d.recheck_gone_at }); continue; }
    if (age < 0) continue;
    let present;
    try {
      present = await check({ id: String(d.id), chain: d.chain, txid: d.txid, logIndex: Number(d.log_index), block: Number(d.block), address: d.address, amount: Number(d.amount) }, { confirm: confirming });
    } catch (e) {
      out.inconclusive++;
      await log(d.id, 'error', errCode(e));
      await setNext(d.id, { next: nowMs + RETRY_MS, n, goneAt: d.recheck_gone_at });
      continue;
    }
    out.checked++;
    if (present) {
      await log(d.id, 'present');
      const n2 = n + 1;
      const next = n2 >= RECHECK_AT.length ? null : Math.max(created + RECHECK_AT[n2], nowMs + RETRY_MS);
      await setNext(d.id, { next: next !== null && next - created > RECHECK_WINDOW_MS ? null : next, n: n2, goneAt: null });
      continue;
    }
    await log(d.id, 'gone');
    if (!confirming) { await setNext(d.id, { next: nowMs + CONFIRM_GAP_MS, n, goneAt: nowMs }); continue; }
    const r = await reverseDeposit(db, d.id, { now: nowMs, notify });
    if (r.status === 'reversed') out.reversed++;
  }
  return out;
}

/** 冲正一笔到账。同一笔第二次调用什么都不改，返回 already_reversed */
export async function reverseDeposit(db, depositId, { now = Date.now(), notify = null } = {}) {
  const at = new Date(Number(now));
  const r = await db.tx(async (t) => {
    const [d] = await t.query('select * from deposits where id = $1 for update', [Number(depositId)]);
    if (!d) throw new PayError('not_found', 404);
    if (d.result === 'reversed') return { status: 'already_reversed' };
    if (d.result !== 'credited') throw new PayError('invalid_state', 409);
    await t.query('select 1 from customers where merchant_id = $1 and customer_id = $2 for update', [d.merchant_id, d.customer_id]);
    const amount = Number(d.amount), fee = Number(d.fee), net = amount - fee;
    const [b] = await t.query('select available, debt from balances where merchant_id = $1 for update', [d.merchant_id]);
    const taken = Math.min(Number(b.available), net), debtAdded = net - taken;
    const ref = d.txid.slice(0, 16);
    // 一行冲正：金额是入账净额；明细写到账、手续费、从可用余额扣的、记成欠款的（冻结的不动）
    const after = await postDebt(t, d.merchant_id, 'reversal', -taken, debtAdded, ref, d.customer_id, { amount: -net, detail: { gross: amount, fee, from_available: taken, to_debt: debtAdded } });
    const orderNo = d.order_id || null;
    const detail = { amount, fee, net, taken, debt_added: debtAdded, debt_after: Number(after.debt), order_no: orderNo };
    await t.query(`update deposits set result = 'reversed', reversed_at = $2, reversal = $3::jsonb, recheck_next_at = null where id = $1`, [d.id, at, JSON.stringify(detail)]);
    // 匹配过订单：解除匹配（订单状态按现在重算）、发 order.matched
    if (orderNo) await releaseDepositMatch(t, d, at.getTime());
    await t.query(`update customers set unmatched = coalesce((select sum(amount) from deposits where merchant_id = $1 and customer_id = $2 and result = 'credited' and order_id is null), 0)
      where merchant_id = $1 and customer_id = $2`, [d.merchant_id, d.customer_id]);
    // 客户合计减回（最后付款时间不回退）；第 0 批老 TRON 地址：未归集金额减回，归集不去追已经没了的钱
    await t.query('update customers set total = greatest(0, total - $3), count = greatest(0, count - 1), fees = greatest(0, fees - $4) where merchant_id = $1 and customer_id = $2',
      [d.merchant_id, d.customer_id, amount, fee]);
    if (d.chain === 'tron') await t.query('update customers set onchain = greatest(0, onchain - $3) where merchant_id = $1 and customer_id = $2 and address = $4', [d.merchant_id, d.customer_id, amount, d.address]);
    await t.query(`insert into anomalies (type, merchant_id, customer_id, address, amount, ref) values ('reversal', $1, $2, $3, $4, $5) on conflict do nothing`,
      [d.merchant_id, d.customer_id, d.address, `${amount / 1e6} USDT`, `${d.chain}:${d.txid}:${d.log_index}`]);
    await enqueueCallback(t, d.merchant_id, 'deposit.reversed', {
      customer_id: d.customer_id, chain: d.chain, address: d.address, txid: d.txid, amount, fee, credited: net, order_no: orderNo, time: iso(d.time), reversed_at: at.toISOString(),
    });
    const [m] = await t.query('select name from merchants where id = $1', [d.merchant_id]);
    return { status: 'reversed', d, detail, merchant: m?.name || d.merchant_id };
  });
  if (r.status === 'reversed' && notify) {
    const { d, detail, merchant } = r;
    const lines = [
      `${merchant}（${d.merchant_id}）客户 ${d.customer_id} 的一笔到账在入账后复核时链上已经找不到（例如链重组），系统已自动冲正。`,
      `链：${d.chain}`, `交易哈希：${d.txid}`, `到账 ${usd(detail.amount)} USDT，收款手续费 ${usd(detail.fee)} USDT（退回），扣回入账 ${usd(detail.net)} USDT。`,
      `实际从可用余额扣 ${usd(detail.taken)} USDT。`,
      detail.debt_added ? `可用余额不够扣，差额 ${usd(detail.debt_added)} USDT 记成欠款；这个商户现在欠款 ${usd(detail.debt_after)} USDT，还清前不能提币（已提交的单也不能通过），之后的到账先还欠款。` : '没有欠款。',
      detail.order_no ? `订单 ${detail.order_no} 已解除匹配，已回调商户 order.matched。` : '',
      '已回调商户 deposit.reversed。请到运营后台"异常到账 → 冲正"看一眼，看完标记已处理。',
    ].filter(Boolean);
    try { await notify(detail.debt_added ? `到账被撤回已冲正，商户记了欠款：${merchant}` : `到账被撤回已冲正：${merchant}`, lines.join('\n')); }
    catch (e) { console.error(`[reversal] mail: ${e.message}`); }
  }
  return { status: r.status };
}

/**
 * 正式的复核函数：按链问节点这笔转账还在不在。节点连不上、或者节点比我们扫链时看到的最新区块还旧（落后的节点可能还没有这个区块），一律抛错（不下结论）。
 * - 以太坊、BSC：同一个批量请求里取最新区块号和回执；回执里要有同一个日志序号、同一个收款地址的 USDT Transfer
 * - TRON：TronGrid 的已固化区块和交易结果（固化区块比到账所在区块旧就算落后）
 * 替身（本地、端到端测试）：看替身链上有没有这笔转账
 */
export function createChainCheck({ db, tron, layer }) {
  const lagging = () => Object.assign(new Error('node_lagging'), { code: 'node_lagging' });
  return async (x) => {
    if (x.chain === 'eth' || x.chain === 'bsc') {
      const ad = layer?.adapters?.[x.chain];
      if (!ad) throw Object.assign(new Error('chain_not_enabled'), { code: 'chain_not_enabled' });
      if (ad.fake) return ad.hasTransfer(x.txid, x.logIndex);
      const { head, receipt } = await ad.txLookup(x.txid);
      const scan = await getMeta(db, `evm_scan_${x.chain}`, null);
      if (!Number.isFinite(head) || head < x.block + (ad.confirmations || 0) || (Number.isFinite(Number(scan?.head)) && head < Number(scan.head))) throw lagging();
      if (!receipt || Number(receipt.status) !== 1) return false;
      if (!Array.isArray(receipt.logs)) return true;
      const to = String(x.address).toLowerCase().replace(/^0x/, '');
      return receipt.logs.some((l) => !l.removed && Number(l.logIndex) === x.logIndex && String(l.address).toLowerCase() === String(ad.usdt).toLowerCase()
        && String(l.topics?.[2] || '').toLowerCase().endsWith(to));
    }
    if (x.chain === 'tron') {
      if (typeof tron?.hasTransfer === 'function') return tron.hasTransfer(x.txid, x.logIndex);
      const solid = await tron.solidBlock();
      if (!(Number(solid?.number) >= x.block)) throw lagging();
      const info = await tron.txInfo(x.txid);
      return Boolean(info && info.ok);
    }
    throw Object.assign(new Error('unsupported_chain'), { code: 'unsupported_chain' });
  };
}
