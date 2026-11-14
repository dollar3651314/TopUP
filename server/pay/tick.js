// 定时任务：由 worker 进程（server/worker.js）每 15 秒调用一次。
// 顺序：① 扫描已确认的 USDT 转账 → ② 订单过期 → ③ 提币的链上确认 → 归集（确认、到点凑批）→ ④ 发送回调 → ⑤ 合并发送提币通知邮件 → 记录运行时间。
// 每次整体控制在 25 秒内；没做完的下一次接着做。
import { recordDeposit, expireOrders, settleWithdrawal, getMeta, setMeta } from './core.js';
import { settlePayoutItem } from './payout.js';
import { deliverDue } from './callbacks.js';
import { fmtUsdt } from './money.js';
import { raiseAlert, clearAlert } from '../wallet/sweep.js';

const OVERLAP_MS = 3 * 60_000; // 每次往前多扫 3 分钟，防止边界上的事件漏掉（重复的由唯一约束去掉）
const INDEX_LAG_MS = 30_000; // 已确认的区块，TronGrid 的事件索引可能还要晚几秒才查得到
const MAX_WINDOW_MS = 10 * 60_000;

/** ① 扫链：从上次的时间点往后读，只处理转到我们客户地址的转账 */
export async function scan(db, tron, { now = Date.now(), budgetMs = 12_000, maxPages = 40, onError } = {}) {
  const started = Date.now();
  const cursor = (await getMeta(db, 'scan_cursor')) ?? now - 5 * 60_000; // 第一次运行：从 5 分钟前开始
  const minTs = Math.max(0, cursor - OVERLAP_MS);
  // 只读到最新的已确认区块为止：还没确认的转账现在查不到，游标不能越过它们，否则下一次也扫不到了
  const solid = await tron.solidBlock();
  const maxTs = Math.max(minTs, Math.min(now, solid.time - INDEX_LAG_MS, cursor + MAX_WINDOW_MS));
  let fp = null, pages = 0, seen = 0, credited = 0, lastTs = cursor, complete = false;
  const failed = [];
  while (pages < maxPages && Date.now() - started < budgetMs) {
    const { events, next } = await tron.transfers({ minTs, maxTs, fingerprint: fp });
    pages++; seen += events.length;
    if (events.length) {
      const mine = new Set((await db.query('select address from customers where address = any($1::text[])', [[...new Set(events.map((e) => e.to))]])).map((r) => r.address));
      for (const e of events) {
        if (mine.has(e.to)) {
          // 一笔处理失败不能卡住所有商户的扫链：记为异常、通知管理员，继续处理后面的
          try { const r = await recordDeposit(db, e); if (r.status === 'credited') credited++; }
          catch (err) {
            console.error(`[tick] deposit ${e.txid}:${e.logIndex} failed: ${err.message}`);
            await db.query(`insert into anomalies (type, address, amount, ref) values ('process_error', $1, $2, $3) on conflict do nothing`, [e.to, `${e.amount / 1e6} USDT`, `${e.txid}:${e.logIndex}`]);
            failed.push(`${e.txid}:${e.logIndex}`);
          }
        }
        lastTs = Math.max(lastTs, e.time);
      }
    }
    if (!next || !events.length) { complete = true; break; }
    fp = next;
  }
  // 这一段全部读完：游标移到这一段的结尾；没读完：移到已经处理到的位置
  await setMeta(db, 'scan_cursor', complete ? maxTs : lastTs);
  if (failed.length && onError) await onError(failed);
  return { pages, seen, credited, complete, cursor: complete ? maxTs : lastTs, failed: failed.length };
}

/** TRON 交易原文出给页面时的有效期（server/pay/wallet-api.js 的 SIGN_TTL_MS）；过期后再加 5 分钟余量（等区块固化）链上仍查不到，才算没发出去 */
export const TRON_TX_TTL_MS = 30 * 60_000;
const TRON_GONE_MS = TRON_TX_TTL_MS + 5 * 60_000;
const CHAIN_MARGIN_MS = 5 * 60_000; // 链上已固化的最新区块时间比原文过期时间晚这么多，才算一定上不了链
const GONE_RECHECK_MS = 5 * 60_000; // 第一次判"上不了链"后隔这么久再查一轮，仍查不到才退回（和以太坊一样两轮）

/**
 * ③ 已广播的提币：链上确认成功就扣除冻结；失败就按规则退回。
 * 链上查不到：交易过期（记成已广播之后 SIGN_TTL + 5 分钟）之前一律继续等——签好的交易可能已经在别的节点上，随时会上链；
 * 过期之后仍查不到才算没发出去（打款回到已审核待签名、冻结不动；老的单笔提币解冻）。查询出错不下结论，下一轮再查。
 */
export async function confirmWithdrawals(db, tron, { notify, now = Date.now() } = {}) {
  // TRON 的单（以太坊、BSC 的整批由 server/wallet/payout.js 的 confirm 按回执处理）
  const rows = await db.query(`select id, txid, approved_at, updated_at, tx_expires_at, gone_suspect_at from withdrawals where status = 'broadcast' and txid is not null and chain = 'tron' order by updated_at limit 50`);
  let done = 0, solid;
  // 链上时间（已固化的最新区块）：判断过期按链上时间，不按服务器时钟（服务器时钟快了会提前退回、付两次）
  const chainTime = async () => { if (solid === undefined) solid = await tron.solidBlock().then((b) => Number(b?.time) || null).catch(() => null); return solid; };
  for (const w of rows) {
    let info;
    try { info = await tron.txInfo(w.txid); } catch { continue; }
    if (!info) {
      if (w.tx_expires_at !== null && w.tx_expires_at !== undefined) {
        const ct = await chainTime();
        if (ct === null || ct <= Number(w.tx_expires_at) + CHAIN_MARGIN_MS) continue; // 链上时间读不到、或还没过期：继续等
      } else if (now - new Date(w.updated_at).getTime() <= TRON_GONE_MS) continue; // 升级前交了签名的：没存过期时间，按记成已广播之后 35 分钟
      // 已过期、链上查不到：第一轮只记下时间，隔 GONE_RECHECK_MS 再查一轮仍查不到才退回（固化节点偶尔落后，一轮的"查不到"不算数）
      if (!w.gone_suspect_at) { await db.query(`update withdrawals set gone_suspect_at = $2 where id = $1 and status = 'broadcast'`, [w.id, new Date(now)]); continue; }
      if (now - new Date(w.gone_suspect_at).getTime() < GONE_RECHECK_MS) continue;
      if (w.approved_at) await settlePayoutItem(db, w.id, { success: false, reason: 'expired_not_onchain' });
      else await settleWithdrawal(db, w.id, false);
      if (notify) await notify(`TRON 打款没上链：${w.id}`, w.approved_at ? `TRON 打款 ${w.id} 的交易（${w.txid}）已过期，链上查不到，不会再上链。这一笔回到"已审核"，冻结的金额不动，可以重新签名。` : `提币 ${w.id} 的交易（${w.txid}）已过期，链上查不到，冻结的金额已退回商户余额。`);
      done++;
      continue;
    }
    // 审核通过后凑批签的（第 3 批起都是）：逐笔记账，失败的回到已审核待签名、冻结不动（Q-B2）
    if (w.approved_at) await settlePayoutItem(db, w.id, { success: info.ok, txid: w.txid, reason: info.ok ? null : 'chain_failed' });
    else await settleWithdrawal(db, w.id, info.ok);
    if (!info.ok && notify) await notify(`提币失败：${w.id}`, w.approved_at ? `TRON 打款 ${w.id} 的链上交易失败（${w.txid}），这一笔回到"已审核"，可以重新签名，冻结的金额不动。` : `提币 ${w.id} 的链上交易失败（${w.txid}），冻结的金额已退回商户余额。请到运营后台查看。`);
    done++;
  }
  return done;
}

/** ⑤ 新的提币申请合并成一封邮件（每分钟最多一封） */
export async function notifyWithdrawals(db, notify, adminUrl) {
  const rows = await db.query(`select w.id, w.amount, w.kind, w.source, m.name from withdrawals w join merchants m on m.id = w.merchant_id where w.status = 'pending' and not w.notified order by w.created_at`);
  if (!rows.length || !notify) return 0;
  const lines = rows.map((w) => `- ${w.id} · ${w.name} · ${w.kind === 'payout' ? '代付' : '商户提现'} · ${fmtUsdt(w.amount)} USDT · ${w.source === 'api' ? 'API' : '后台'}`);
  await notify(`有 ${rows.length} 笔新的提币申请待审核`, `${lines.join('\n')}\n\n请到运营后台审核：${adminUrl}\n商户看到的处理时效：东八区 8:00–23:00 内 1 小时处理。`);
  await db.query('update withdrawals set notified = true where id = any($1::text[])', [rows.map((w) => w.id)]);
  return rows.length;
}

export async function runTick({ db, tron, getTarget, notify, adminUrl = '', fetchImpl, resolve, confirmSweeps, scanEvm, confirmPayouts, now = () => Date.now() }) {
  const t0 = Date.now();
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e.message }; console.error(`[tick] ${name}: ${e.message}`); } };
  await step('scan', () => scan(db, tron, { onError: notify && ((ids) => notify('到账处理失败', `以下链上转账没有处理成功，已记到"异常到账"，请联系研发：\n${ids.join('\n')}`)) }));
  if (scanEvm) await step('scan_evm', () => scanEvm()); // ETH、BSC（server/wallet/scan.js，每条链各自出错各自告警）
  await step('expired', () => expireOrders(db));
  await step('withdrawals', () => confirmWithdrawals(db, tron, { notify, now: now() }));
  if (confirmPayouts) await step('payouts', () => confirmPayouts()); // 以太坊、BSC 批量打款：按回执整批确认或整批回到已审核
  // 归集（确认已发出的批次、到点凑批）：出错只告警（故障一次、恢复一次、长期没恢复每天一次），不影响其他步骤和运行时间
  if (confirmSweeps) {
    await step('sweeps', () => confirmSweeps());
    const err = out.sweeps?.error;
    try {
      if (err) await raiseAlert(db, 'sweep_step', notify, '归集出错', `worker 的归集步骤出错（扫链、回调照常，下一轮自动重试）：${err}`);
      else await clearAlert(db, 'sweep_step', notify, '归集已恢复', 'worker 的归集步骤已恢复正常。');
    } catch (e) { console.error(`[tick] sweep alert: ${e.message}`); }
  }
  await step('callbacks', () => deliverDue(db, { getTarget, fetchImpl, resolve }));
  await step('mail', () => notifyWithdrawals(db, notify, adminUrl));
  out.ms = Date.now() - t0;
  await setMeta(db, 'tick_last', { at: new Date().toISOString(), ...out });
  return out;
}
