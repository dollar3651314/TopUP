// 客户的收款地址（每条链一个）：第一次要地址时按路由从提供方拿，并记下提供方、合约参数版本和盐；以后再要返回同一个。
// 更换地址（renew）：旧地址停用（一直扫链、照常入账、由原提供方归集，不设期限），按当前路由要新地址。
// TRON（第 2 批）：提供方开通了 tron 才分配新的合约地址，没开通的照旧 chain_not_enabled（不调用提供方）；
// 第 0 批老客户已有的 TRON 地址（legacy_hd）照常返回，"更换地址"才换成合约地址，老地址停用后一直入账。
import { PayError } from '../pay/core.js';
import { CHAINS } from './provider.js';
import { resolveProvider, CHAINS_NOT_IN_BATCH, chainOpen } from './router.js';

const at = (now) => new Date(now ?? Date.now());
const view = (r) => ({ chain: r.chain, address: r.address, provider: r.provider, schemeVer: r.scheme_ver, status: r.status });

async function activeRow(q, merchantId, customerId, chain) {
  const [r] = await q.query(`select * from customer_addresses where merchant_id = $1 and customer_id = $2 and chain = $3 and status = 'active'`, [merchantId, customerId, chain]);
  return r || null;
}

export async function addressFor(db, { merchantId, customerId, chain, providers = {}, renew = false, now }) {
  if (!CHAINS.includes(chain)) throw new PayError('invalid_param', 422, 'chain');
  const cur = await activeRow(db, merchantId, customerId, chain);
  if (cur && !renew) return view(cur);
  if (CHAINS_NOT_IN_BATCH.includes(chain)) throw new PayError('chain_not_enabled', 409, 'chain');
  const providerId = await resolveProvider(db, { chain, merchantId, now });
  const p = providers[providerId];
  if (!p || p.enabled === false) throw new PayError('provider_not_enabled', 409, 'chain');
  if (!chainOpen(p, chain)) throw new PayError('chain_not_enabled', 409, 'chain');
  // 提供方在事务外调用（合约钱包是纯计算；第三方托管会访问网络，不能放在事务里）
  const got = await p.allocateAddress({ merchantId, customerId, chain });
  return db.tx(async (t) => {
    const active = await activeRow(t, merchantId, customerId, chain);
    if (active && !renew) return view(active); // 并发时另一个请求先分配好了
    if (active && active.address.toLowerCase() === got.address.toLowerCase()) return view(active); // 同一提供方、同一套参数：地址不变，不用停用
    if (active) await t.query(`update customer_addresses set status = 'retired', retired_at = $2 where id = $1`, [active.id, at(now)]);
    const [row] = await t.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, 'active', $8) on conflict do nothing returning *`,
      [merchantId, customerId, chain, providerId, got.schemeVer ?? 0, String(got.providerRef ?? ''), got.address, at(now)]);
    if (row) return view(row);
    const again = await activeRow(t, merchantId, customerId, chain);
    if (again) return view(again);
    throw new PayError('address_conflict', 409, 'chain'); // 这个地址已经属于别的记录（例如更换后又换回同一套参数），不默默复用
  });
}

/** 这个客户每条链现在用的地址（付款页、开放 API、商户后台只给这些；停用的不给） */
export async function activeAddresses(db, { merchantId, customerId }) {
  const rows = await db.query(`select * from customer_addresses where merchant_id = $1 and customer_id = $2 and status = 'active'`, [merchantId, customerId]);
  return CHAINS.map((c) => rows.find((r) => r.chain === c)).filter(Boolean).map(view);
}

/** 要扫链的地址：这个提供方在这条链上的全部地址（使用中 + 停用的，停用多久都算） */
export async function watchedAddresses(db, { chain, provider }) {
  const rows = await db.query(`select address from customer_addresses where chain = $1 and provider = $2 order by id`, [chain, provider]);
  return rows.map((r) => r.address);
}

/** 归集候选：这个提供方名下这条链的全部地址（含停用的旧地址） */
export async function sweepCandidates(db, { chain, provider }) {
  const rows = await db.query(`select address, salt, scheme_ver, status from customer_addresses where chain = $1 and provider = $2 order by id`, [chain, provider]);
  return rows.map((r) => ({ address: r.address, salt: r.salt, schemeVer: r.scheme_ver, status: r.status }));
}

/**
 * 合约钱包地址里还没归集的钱（ETH、BSC；chains 带 tron 时只算 TRON 合约地址，第 0 批老地址按 customers.onchain 另算）（按账本估算：到账合计 − 已归集），每条链一行：
 * { chain: { total, count, over, overTotal } }（金额是 0.000001 单位的 bigint）。thresholds：每条链的门槛（bigint），给了才算"达到门槛"
 */
export async function evmUnswept(db, { chains = ['eth', 'bsc'], thresholds = {} } = {}) {
  const out = {};
  for (const chain of chains) {
    const [r] = await db.query(`with a as (
        select coalesce((select sum(d.amount) from deposits d where d.chain = ca.chain and lower(d.address) = lower(ca.address)), 0)
          - coalesce((select sum(i.amount) from wallet_sweep_items i where i.chain = ca.chain and lower(i.address) = lower(ca.address) and i.status = 'swept'), 0) v
        from customer_addresses ca where ca.chain = $1 and (ca.chain <> 'tron' or ca.provider = 'contract'))
      select count(*) filter (where v > 0)::int n, coalesce(sum(v) filter (where v > 0), 0)::bigint total,
        count(*) filter (where v >= $2)::int over_n, coalesce(sum(v) filter (where v >= $2), 0)::bigint over_total from a`, [chain, String(thresholds[chain] ?? 0n)]);
    out[chain] = { total: BigInt(r.total), count: r.n, over: r.over_n, overTotal: BigInt(r.over_total) };
  }
  return out;
}
