// 每日任务（worker 每天运行一次）：
// ① 对账：链上实际持有的 USDT（客户地址 + 热钱包 + 冷钱包）应该等于
//    商户余额之和 + 平台收取的手续费 + 低于 1 USDT 没有入账的钱。不一致时发邮件。
// ② 资产检查：客户地址上出现 USDT 以外的代币，记为"异常到账"。
// ③ 提醒：服务器磁盘用量达到 70%、链上监控超过 5 分钟没有运行，发邮件。
import { getMeta } from './core.js';
import { fmtUsdt } from './money.js';
import { diskUsage, DISK_ALERT } from './disk.js';

export async function runDaily({ db, tron, wallets, notify, now = new Date(), maxAddresses = 1000, diskPath = null }) {
  const out = {};
  // 地址：有余额的全部查；其余按最近付款时间取一部分，逐日轮换（控制 TronGrid 的用量）
  const addrs = await db.query(`select merchant_id, customer_id, address, onchain from customers where address is not null
    order by (onchain > 0) desc, last_at desc nulls last limit $1`, [maxAddresses]);
  let chainAddr = 0, checked = 0, found = 0;
  for (const a of addrs) {
    let acc;
    try { acc = await tron.account(a.address); } catch { continue; }
    checked++;
    chainAddr += acc.trc20[tron.contract] || 0;
    for (const [token, bal] of Object.entries(acc.trc20)) {
      if (token === tron.contract || !bal) continue;
      found++;
      await db.query(`insert into anomalies (type, merchant_id, customer_id, address, amount, ref) values ('token', $1, $2, $3, $4, $5) on conflict do nothing`,
        [a.merchant_id, a.customer_id, a.address, `${bal}（合约 ${token}）`, token]);
    }
  }
  const wal = async (addr) => { if (!addr) return 0; try { return (await tron.account(addr)).trc20[tron.contract] || 0; } catch { return 0; } };
  const hot = await wal(wallets.hot), cold = await wal(wallets.cold);
  const [s] = await db.query(`select coalesce(sum(available + frozen), 0)::bigint balances from balances`);
  const [f] = await db.query(`select coalesce(-sum(amount) filter (where type = 'fee_in'), 0)::bigint fee_in, coalesce(-sum(amount) filter (where type = 'fee_out'), 0)::bigint fee_out from ledger`);
  const [bm] = await db.query(`select coalesce(sum(amount), 0)::bigint below from deposits where result = 'below_min'`);
  const chain = chainAddr + hot + cold;
  const fees = f.fee_in + f.fee_out + bm.below;
  const diff = chain - (s.balances + fees);
  const day = now.toISOString().slice(0, 10);
  const complete = checked === addrs.length;
  await db.query(`insert into recon (day, balances, chain, fees, diff, detail) values ($1, $2, $3, $4, $5, $6::jsonb)
    on conflict (day) do update set balances = excluded.balances, chain = excluded.chain, fees = excluded.fees, diff = excluded.diff, detail = excluded.detail, created_at = now()`,
    [day, s.balances, chain, fees, diff, JSON.stringify({ addresses: chainAddr, hot, cold, checked, address_count: addrs.length, complete })]);
  out.recon = { chain, balances: s.balances, fees, diff, complete };
  out.tokens = found;
  // 客户合计：每个商户下所有客户的收款合计 = 这个商户的收款合计
  const mismatch = await db.query(`select m.name from merchants m where coalesce((select sum(amount) from ledger l where l.merchant_id = m.id and l.type = 'deposit'), 0)
    <> coalesce((select sum(total) from customers c where c.merchant_id = m.id), 0)`);
  const msgs = [];
  if (diff !== 0 && complete) msgs.push(`对账不一致：链上 ${fmtUsdt(chain)} USDT，应为 ${fmtUsdt(s.balances + fees)} USDT（商户余额 ${fmtUsdt(s.balances)} + 手续费和未入账 ${fmtUsdt(fees)}），差额 ${fmtUsdt(diff)}。如果你从热钱包或冷钱包转出过利润，差额会是负数，属于正常。`);
  if (mismatch.length) msgs.push(`客户收款合计和商户收款合计不一致：${mismatch.map((x) => x.name).join('、')}`);
  if (found) msgs.push(`发现 ${found} 笔 USDT 以外的代币转入客户地址，已记到"异常到账"。`);
  const [size] = await db.query('select pg_database_size(current_database())::bigint bytes').catch(() => [{ bytes: 0 }]);
  out.dbBytes = size.bytes;
  const disk = diskUsage(diskPath);
  if (disk && disk.used_mb > disk.total_mb * DISK_ALERT) msgs.push(`服务器磁盘已用 ${Math.round((disk.used_mb / disk.total_mb) * 100)}%（${disk.used_mb} / ${disk.total_mb} MB，其中数据库 ${Math.round(size.bytes / 1048576)} MB），请清理或扩容。`);
  const tick = await getMeta(db, 'tick_last');
  if (!tick || now.getTime() - Date.parse(tick.at) > 5 * 60_000) msgs.push(`链上监控最后一次运行：${tick ? tick.at : '从未运行'}，已超过 5 分钟。请检查 worker 进程。`);
  if (msgs.length && notify) await notify('每日检查需要处理', msgs.join('\n\n'));
  // 回调记录保留 7 天（控制存储用量）；幂等记录保留 24 小时
  await db.query(`delete from callbacks where status <> 'pending' and created_at < now() - interval '7 days'`);
  await db.query(`delete from idempotency where created_at < now() - interval '24 hours'`);
  out.alerts = msgs.length;
  return out;
}
