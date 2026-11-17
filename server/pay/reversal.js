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
import { toUnits } from '../wallet/units.js';
import { TRANSFER_TOPIC } from '../wallet/adapters/evm.js';

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

/** 抢到一笔到期的到账后，别的 worker 多久之内不会再抢它（复核一笔远用不了这么久；过了这个时间算这次没做完，别人可以接手） */
export const CLAIM_MS = 15 * MIN;

/**
 * worker 每轮调用：复核到期的到账。check({ id, chain, txid, logIndex, block, address, amount }, { confirm }) → true 还在 / false 没了；抛错 = 节点连不上或落后，不下结论。
 * confirm：查到"没了"之后的确认复核（适配器要更严：用不落后的节点、两次回答一致，否则抛错）。
 * 并发（worker 租约过期时可能有两个 worker 同时跑）：每一笔先原子地"抢"下来（把 recheck_next_at 推后 CLAIM_MS，只有到期的才抢得到），
 *   之后的排期只在还是自己抢的那一次时才写回；冲正前在行锁里再核对一次"确实查到没了、隔够 10 分钟、之后没有查到还在"。
 * 一笔出错只记日志，不影响其他笔。返回 { checked, reversed, inconclusive }
 */
export async function recheckDeposits(db, { now = Date.now(), check, notify = null, limit = 200, log: logger = console } = {}) {
  const at = new Date(Number(now));
  const nowMs = at.getTime();
  const due = await db.query(`select id from deposits
    where result = 'credited' and recheck_next_at is not null and recheck_next_at <= $1 order by recheck_next_at, id limit $2`, [at, limit]);
  const out = { checked: 0, reversed: 0, inconclusive: 0 };
  const log = (id, result, detail = '') => db.query('insert into deposit_rechecks (deposit_id, checked_at, result, detail) values ($1, $2, $3, $4)', [id, at, result, detail]);
  for (const { id } of due) {
    try {
      const claim = new Date(nowMs + CLAIM_MS);
      const [d] = await db.query(`update deposits set recheck_next_at = $2 where id = $1 and result = 'credited' and recheck_next_at is not null and recheck_next_at <= $3
        returning id, chain, txid, log_index, block, address, amount, created_at, recheck_n, recheck_gone_at`, [id, claim, at]);
      if (!d) continue; // 别的 worker 已经抢走（或已冲正）
      // 只在还是自己这次抢的时候写回排期（别的 worker 在抢的期限过后接手了，就以它为准）
      const setNext = (fields) => db.query(`update deposits set recheck_next_at = $2, recheck_n = $3, recheck_gone_at = $4 where id = $1 and result = 'credited' and recheck_next_at = $5`,
        [d.id, fields.next === null ? null : new Date(fields.next), fields.n, fields.goneAt === null ? null : new Date(fields.goneAt), claim]);
      const created = new Date(d.created_at).getTime();
      const age = nowMs - created;
      const confirming = Boolean(d.recheck_gone_at);
      const n = Number(d.recheck_n) || 0;
      // 过了窗口：不再复核（最后一次没下结论的，运营后台"复核没下结论的"列出）
      if (age > (confirming ? CONFIRM_WINDOW_MS : RECHECK_WINDOW_MS)) { await setNext({ next: null, n, goneAt: d.recheck_gone_at }); continue; }
      if (age < 0) { await setNext({ next: created, n, goneAt: d.recheck_gone_at }); continue; }
      let present;
      try {
        present = await check({ id: String(d.id), chain: d.chain, txid: d.txid, logIndex: Number(d.log_index), block: Number(d.block), address: d.address, amount: Number(d.amount) }, { confirm: confirming });
      } catch (e) {
        out.inconclusive++;
        await log(d.id, 'error', errCode(e));
        await setNext({ next: nowMs + RETRY_MS, n, goneAt: d.recheck_gone_at });
        continue;
      }
      out.checked++;
      if (present) {
        await log(d.id, 'present');
        const n2 = n + 1;
        const next = n2 >= RECHECK_AT.length ? null : Math.max(created + RECHECK_AT[n2], nowMs + RETRY_MS);
        await setNext({ next: next !== null && next - created > RECHECK_WINDOW_MS ? null : next, n: n2, goneAt: null });
        continue;
      }
      await log(d.id, 'gone');
      if (!confirming) { await setNext({ next: nowMs + CONFIRM_GAP_MS, n, goneAt: nowMs }); continue; }
      const r = await reverseDeposit(db, d.id, { now: nowMs, notify, confirmedGone: true });
      if (r.status === 'reversed') out.reversed++;
      else if (r.status === 'not_confirmed') await setNext({ next: nowMs + RETRY_MS, n, goneAt: null }); // 核对不过（例如别的 worker 刚查到还在）：重新从头确认
    } catch (e) {
      logger.error(`[reversal] recheck deposit ${id}: ${e.message}`);
    }
  }
  return out;
}

/**
 * 冲正前在行锁里核对"确实查到没了"：第一次查到没了的时间（recheck_gone_at）有值且已隔够 CONFIRM_GAP_MS，
 * 之后的复核记录里没有"还在"，最新一条是"没了"。不满足返回原因，满足返回 null
 */
async function goneNotConfirmed(t, d, nowMs) {
  if (!d.recheck_gone_at) return 'no_gone_mark';
  const goneAt = new Date(d.recheck_gone_at);
  if (nowMs - goneAt.getTime() < CONFIRM_GAP_MS) return 'gap_too_short';
  const rows = await t.query(`select result from deposit_rechecks where deposit_id = $1 and checked_at >= $2 order by id desc`, [d.id, goneAt]);
  if (!rows.length || rows[0].result !== 'gone') return 'latest_not_gone';
  if (rows.some((x) => x.result === 'present')) return 'present_after_gone';
  return null;
}

/**
 * 冲正一笔到账。同一笔第二次调用什么都不改，返回 already_reversed。
 * confirmedGone（复核调用时为 true）：在行锁里再核对一次确实查到没了（见 goneNotConfirmed），不满足什么都不改，返回 not_confirmed。
 * 加锁顺序和入账一样：先客户行，再到账行（避免死锁）
 */
export async function reverseDeposit(db, depositId, { now = Date.now(), notify = null, confirmedGone = false } = {}) {
  const at = new Date(Number(now));
  const r = await db.tx(async (t) => {
    const [peek] = await t.query('select merchant_id, customer_id from deposits where id = $1', [Number(depositId)]);
    if (!peek) throw new PayError('not_found', 404);
    await t.query('select 1 from customers where merchant_id = $1 and customer_id = $2 for update', [peek.merchant_id, peek.customer_id]);
    const [d] = await t.query('select * from deposits where id = $1 for update', [Number(depositId)]);
    if (d.result === 'reversed') return { status: 'already_reversed' };
    if (d.result !== 'credited') throw new PayError('invalid_state', 409);
    if (confirmedGone) {
      const why = await goneNotConfirmed(t, d, at.getTime());
      if (why) { console.error(`[reversal] deposit ${d.id}: not reversed (${why})`); return { status: 'not_confirmed', why }; }
    }
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
 * 正式的复核函数：按链问节点这笔转账还在不在。节点连不上、节点比我们扫链时看到的最新区块还旧（落后的节点可能还没有这个区块）、
 * 或者回答说明不了"没了"（例如交易回到了交易池），一律抛错（不下结论，稍后再查）。
 * - 以太坊、BSC：同一个批量请求里取最新区块号、回执和交易（同一台后端回答）。
 *   回执里有同一个收款地址、同一金额的 USDT Transfer 就算还在（重组后换了区块或日志序号也算）；
 *   回执没有但交易还在（回到交易池、等重新打包）→ 不下结论；回执和交易都没有、或交易执行失败 → 没了。
 * - TRON：已固化区块和交易结果（/walletsolidity）。固化区块比到账所在区块旧就算落后。
 *   确认复核（confirm）要两次回答一致：固化区块 → 交易结果 → 交易结果 → 固化区块，两次交易结果不一样、固化区块倒退都不下结论。
 * 替身（本地、端到端测试）：看替身链上有没有这笔转账；TRON 同时看老 TronGrid 替身和合约钱包的替身（两种到账都在替身里）
 */
export function createChainCheck({ db, tron, layer }) {
  const lagging = () => Object.assign(new Error('node_lagging'), { code: 'node_lagging' });
  const unsure = (code) => Object.assign(new Error(code), { code });
  const evmLogMatches = (l, ad, x) => {
    if (l.removed || String(l.address).toLowerCase() !== String(ad.usdt).toLowerCase()) return false;
    if (!Array.isArray(l.topics) || l.topics.length !== 3 || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return false;
    const to = String(x.address).toLowerCase().replace(/^0x/, '');
    if (!String(l.topics[2] || '').toLowerCase().endsWith(to.padStart(40, '0'))) return false;
    let raw;
    try { raw = BigInt(l.data && l.data !== '0x' ? l.data : '0x0'); } catch { return false; }
    return Number(toUnits(raw, ad.decimals || 6)) === Number(x.amount);
  };
  return async (x, { confirm = false } = {}) => {
    if (x.chain === 'eth' || x.chain === 'bsc') {
      const ad = layer?.adapters?.[x.chain];
      if (!ad) throw unsure('chain_not_enabled');
      if (ad.fake) return ad.hasTransfer(x.txid, x.logIndex);
      const { head, receipt, tx } = await ad.txLookup(x.txid);
      const scan = await getMeta(db, `evm_scan_${x.chain}`, null);
      if (!Number.isFinite(head) || head < x.block + (ad.confirmations || 0) || (Number.isFinite(Number(scan?.head)) && head < Number(scan.head))) throw lagging();
      if (!receipt) {
        if (tx) throw unsure('tx_pending'); // 交易还在（交易池里），等它重新打包或消失
        return false;
      }
      if (Number(receipt.status) !== 1) return false;
      if (!Array.isArray(receipt.logs)) throw unsure('receipt_without_logs');
      return receipt.logs.some((l) => evmLogMatches(l, ad, x));
    }
    if (x.chain === 'tron') {
      const fakes = [tron, layer?.adapters?.tron].filter((f) => f && typeof f.hasTransfer === 'function');
      if (fakes.length) return fakes.some((f) => f.hasTransfer(x.txid, x.logIndex));
      const answer = async (solidFirst) => {
        let solid, info;
        if (solidFirst) { solid = await tron.solidBlock(); info = await tron.txInfo(x.txid); }
        else { info = await tron.txInfo(x.txid); solid = await tron.solidBlock(); }
        const n = Number(solid?.number);
        if (!(n >= x.block)) throw lagging();
        return { n, present: Boolean(info && info.ok) };
      };
      const first = await answer(true);
      if (!confirm) return first.present;
      const second = await answer(false);
      if (second.n < first.n) throw lagging();
      if (second.present !== first.present) throw unsure('node_inconsistent');
      return first.present;
    }
    throw unsure('unsupported_chain');
  };
}
