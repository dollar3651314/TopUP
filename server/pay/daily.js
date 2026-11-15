// 每日任务（worker 每天运行一次）：
// ① 对账：按链（TRON、以太坊、BSC；没开通的链跳过）查链上实际持有的 USDT——
//    未归集的客户地址（TRON 第 0 批老地址 customers.address + 合约钱包充值地址 customer_addresses）
//    + 热钱包（顶层 hot = TRON；evm.<链>.hot）+ 冷钱包（顶层 cold = TRON 第 0 批；合约钱包的 parent），
//    三条链合计应该等于 商户余额之和 + 平台收取的手续费 + 低于 1 USDT 没有入账的钱。
//    每条链另算账本应收 = 这条链上的全部到账（含低于 1 USDT 的）− 这条链已完成的打款（账本 withdraw 记录按打款单的链归），
//    和这条链的链上合计比，差额按链列出；任何一条链（或合计）对不上就发邮件。
// ② 资产检查：TRON 客户地址（老地址和合约地址）上出现 USDT 以外的代币，记为"异常到账"。
//    以太坊、BSC 的节点接口列不出一个地址上有哪些代币，这一版不查（见项目地图"已知限制"）。
// ③ 提醒：服务器磁盘用量达到 70%、链上监控超过 5 分钟没有运行，发邮件。
import { getMeta } from './core.js';
import { fmtUsdt } from './money.js';
import { diskUsage, DISK_ALERT } from './disk.js';
import { toUnits } from '../wallet/units.js';

const CHAIN_NAMES = { tron: 'TRON', eth: '以太坊', bsc: 'BSC' };
const EVM_CHAINS = ['eth', 'bsc'];

/** 合约钱包的充值地址（含停用的旧地址）：按账本估算的未归集金额从多到少，最多 limit 个 */
async function contractAddresses(db, chain, limit) {
  return db.query(`select ca.merchant_id, ca.customer_id, ca.address,
      coalesce((select sum(d.amount) from deposits d where d.chain = ca.chain and lower(d.address) = lower(ca.address)), 0)
      - coalesce((select sum(i.amount) from wallet_sweep_items i where i.chain = ca.chain and lower(i.address) = lower(ca.address) and i.status = 'swept'), 0) v
    from customer_addresses ca where ca.chain = $1 and ca.provider = 'contract' order by v desc, ca.id desc limit $2`, [chain, limit]);
}

export async function runDaily({ db, tron, wallets, layer = null, notify, now = new Date(), maxAddresses = 1000, diskPath = null }) {
  const out = {};
  const enabled = new Set(layer?.enabledChains || []);
  const byChain = {};
  let found = 0;
  // TRON 地址上的其他代币（TronGrid 的账户接口列得出 TRC20），USDT 本身不算
  const otherTokens = async (a, acc, usdts) => {
    for (const [token, bal] of Object.entries(acc?.trc20 || {})) {
      if (usdts.includes(token) || !bal) continue;
      found++;
      await db.query(`insert into anomalies (type, merchant_id, customer_id, address, amount, ref) values ('token', $1, $2, $3, $4, $5) on conflict do nothing`,
        [a.merchant_id, a.customer_id, a.address, `${bal}（合约 ${token}）`, token]);
    }
  };
  // 热钱包、冷钱包：查不到余额时这条链算"没查完"（不拿缺一块的数字告警）
  const walletSum = async (row, list) => {
    let sum = 0;
    for (const read of list) {
      try { sum += Number(await read()); } catch { row.wallet_errors++; }
    }
    return sum;
  };

  // ---------- TRON ----------
  {
    const tAd = enabled.has('tron') ? layer.adapters?.tron : null;
    const tUsdt = tAd ? layer.config?.tron?.usdt || tron.contract : tron.contract;
    const usdts = [...new Set([tron.contract, tUsdt])];
    const row = { addresses: 0, hot: 0, cold: 0, checked: 0, address_count: 0, wallet_errors: 0 };
    // 第 0 批老地址：有余额的全部查；其余按最近付款时间取一部分，逐日轮换（控制 TronGrid 的用量）
    const legacy = await db.query(`select merchant_id, customer_id, address, onchain from customers where address is not null
      order by (onchain > 0) desc, last_at desc nulls last limit $1`, [maxAddresses]);
    row.address_count += legacy.length;
    for (const a of legacy) {
      let acc;
      try { acc = await tron.account(a.address); } catch { continue; }
      row.checked++;
      row.addresses += acc.trc20[tron.contract] || 0;
      await otherTokens(a, acc, usdts);
    }
    // 第 2 批合约钱包充值地址：USDT 按 tron.usdt 向合约查余额；其他代币用 TronGrid 的账户接口（查不到只跳过代币检查）
    if (tAd) {
      const rows = await contractAddresses(db, 'tron', maxAddresses);
      row.address_count += rows.length;
      for (const a of rows) {
        let bal;
        try { bal = toUnits(await tAd.tokenBalanceRaw(a.address, tUsdt), 6); } catch { continue; }
        row.checked++;
        row.addresses += Number(bal);
        const acc = await tron.account(a.address).catch(() => null);
        await otherTokens(a, acc, usdts);
      }
    }
    const legacyWal = (addr) => async () => (await tron.account(addr)).trc20[tron.contract] || 0;
    row.hot = await walletSum(row, wallets?.hot ? [legacyWal(wallets.hot)] : []);
    // 冷钱包：第 0 批的 cold + 合约钱包的 parent（同一个地址只算一次）
    const parent = tAd ? layer.config?.tron?.scheme?.parent || '' : '';
    const colds = [];
    if (wallets?.cold) colds.push(legacyWal(wallets.cold));
    if (parent && parent !== wallets?.cold) colds.push(async () => toUnits(await tAd.tokenBalanceRaw(parent, tUsdt), 6));
    row.cold = await walletSum(row, colds);
    byChain.tron = row;
  }

  // ---------- 以太坊、BSC（钱包层开通了才查） ----------
  for (const chain of EVM_CHAINS) {
    const ad = enabled.has(chain) ? layer.adapters?.[chain] : null;
    if (!ad) continue;
    const c = layer.config?.[chain] || {};
    const read = (addr) => async () => toUnits(await ad.tokenBalanceRaw(addr, c.usdt), c.decimals);
    const row = { addresses: 0, hot: 0, cold: 0, checked: 0, address_count: 0, wallet_errors: 0 };
    const rows = await contractAddresses(db, chain, maxAddresses);
    row.address_count = rows.length;
    for (const a of rows) {
      try { row.addresses += Number(await read(a.address)()); row.checked++; } catch { /* 这个地址没查到：算没查完 */ }
    }
    const hot = wallets?.evm?.[chain]?.hot || '';
    row.hot = await walletSum(row, hot ? [read(hot)] : []);
    const parent = c.scheme?.parent || '';
    row.cold = await walletSum(row, parent ? [read(parent)] : []);
    byChain[chain] = row;
  }

  // 每条链的账本应收：到账 − 已完成的打款
  const depBy = Object.fromEntries((await db.query(`select chain, coalesce(sum(amount), 0)::bigint v from deposits group by chain`)).map((x) => [x.chain, Number(x.v)]));
  const outBy = Object.fromEntries((await db.query(`select w.chain, coalesce(-sum(l.amount), 0)::bigint v from ledger l join withdrawals w on w.id = l.ref where l.type = 'withdraw' group by w.chain`)).map((x) => [x.chain, Number(x.v)]));
  for (const [k, r] of Object.entries(byChain)) {
    r.total = r.addresses + r.hot + r.cold;
    r.receivable = (depBy[k] || 0) - (outBy[k] || 0);
    r.diff = r.total - r.receivable;
    r.complete = r.checked === r.address_count && r.wallet_errors === 0;
  }
  const rows = Object.values(byChain);
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const chainAddr = sum('addresses'), hot = sum('hot'), cold = sum('cold');
  const checked = sum('checked'), addressCount = sum('address_count');
  const [s] = await db.query(`select coalesce(sum(available + frozen), 0)::bigint balances from balances`);
  const [f] = await db.query(`select coalesce(-sum(amount) filter (where type = 'fee_in'), 0)::bigint fee_in, coalesce(-sum(amount) filter (where type = 'fee_out'), 0)::bigint fee_out from ledger`);
  const [bm] = await db.query(`select coalesce(sum(amount), 0)::bigint below from deposits where result = 'below_min'`);
  const chain = chainAddr + hot + cold;
  const fees = f.fee_in + f.fee_out + bm.below;
  const diff = chain - (s.balances + fees);
  const day = now.toISOString().slice(0, 10);
  const complete = rows.every((r) => r.complete);
  const detailByChain = Object.fromEntries(Object.entries(byChain).map(([k, r]) => [k, { receivable: r.receivable, addresses: r.addresses, hot: r.hot, cold: r.cold, total: r.total, diff: r.diff, checked: r.checked, address_count: r.address_count, wallet_errors: r.wallet_errors, complete: r.complete }]));
  await db.query(`insert into recon (day, balances, chain, fees, diff, detail) values ($1, $2, $3, $4, $5, $6::jsonb)
    on conflict (day) do update set balances = excluded.balances, chain = excluded.chain, fees = excluded.fees, diff = excluded.diff, detail = excluded.detail, created_at = now()`,
    [day, s.balances, chain, fees, diff, JSON.stringify({ addresses: chainAddr, hot, cold, checked, address_count: addressCount, complete, by_chain: detailByChain })]);
  out.recon = { chain, balances: s.balances, fees, diff, complete, by_chain: detailByChain };
  out.tokens = found;
  // 客户合计：每个商户下所有客户的收款合计 = 这个商户的收款合计
  const mismatch = await db.query(`select m.name from merchants m where coalesce((select sum(amount) from ledger l where l.merchant_id = m.id and l.type = 'deposit'), 0)
    <> coalesce((select sum(total) from customers c where c.merchant_id = m.id), 0)`);
  const msgs = [];
  const badChains = Object.entries(byChain).filter(([, r]) => r.diff !== 0);
  if ((diff !== 0 || badChains.length) && complete) {
    const lines = Object.entries(byChain).map(([k, r]) => `${CHAIN_NAMES[k]}：账本应收 ${fmtUsdt(r.receivable)}，链上 ${fmtUsdt(r.total)}（未归集地址 ${fmtUsdt(r.addresses)} + 热钱包 ${fmtUsdt(r.hot)} + 冷钱包 ${fmtUsdt(r.cold)}），差额 ${fmtUsdt(r.diff)}`);
    const which = badChains.length ? `对不上的链：${badChains.map(([k]) => CHAIN_NAMES[k]).join('、')}。` : '';
    msgs.push(`对账不一致：${which}合计链上 ${fmtUsdt(chain)} USDT，应为 ${fmtUsdt(s.balances + fees)} USDT（商户余额 ${fmtUsdt(s.balances)} + 手续费和未入账 ${fmtUsdt(fees)}），差额 ${fmtUsdt(diff)}。如果你从热钱包或冷钱包转出过利润，差额会是负数，属于正常；在链之间调过钱（例如从 TRON 冷钱包换到以太坊热钱包）时，两条链的差额一正一负。\n各链：\n${lines.join('\n')}`);
  }
  if (mismatch.length) msgs.push(`客户收款合计和商户收款合计不一致：${mismatch.map((x) => x.name).join('、')}`);
  if (found) msgs.push(`发现 ${found} 笔 USDT 以外的代币转入 TRON 客户地址，已记到"异常到账"。`);
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
