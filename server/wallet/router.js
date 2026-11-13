// 钱包提供方路由：查找顺序 这个商户这条链 → 这条链 → 全局默认 contract；生效时间没到的不算，同级取已生效的最新一条。
// 第一版只开放"按链整体切换"（动态码、原因必填、审计）；切换只影响新分配的地址。
import { PayError, audit } from '../pay/core.js';
import { CHAINS, PROVIDER_IDS } from './provider.js';

export const DEFAULT_PROVIDER = 'contract';
/** 第 1 批不在钱包层开放的链（TRON 合约第 2 批上线） */
export const CHAINS_NOT_IN_BATCH = Object.freeze(['tron']);

const at = (now) => new Date(now ?? Date.now());

export async function resolveProvider(db, { chain, merchantId = null, now }) {
  const [r] = await db.query(`select provider from wallet_routes
    where chain = $1 and effective_from <= $2 and (merchant_id is null or merchant_id = $3)
    order by (merchant_id is null), effective_from desc, id desc limit 1`, [chain, at(now), merchantId]);
  return r ? r.provider : DEFAULT_PROVIDER;
}

/** 每条链现在的提供方和切换记录（运营后台"钱包提供方"页） */
export async function routeOverview(db, { now } = {}) {
  const current = {};
  for (const chain of CHAINS) current[chain] = await resolveProvider(db, { chain, now });
  const history = await db.query(`select chain, provider, effective_from, actor, reason, created_at from wallet_routes where merchant_id is null order by id desc limit 100`);
  return { current, history };
}

export async function setChainProvider(db, { chain, provider, actor, reason, providers = {}, merchantId, code, verifyCode, now }) {
  if (!CHAINS.includes(chain)) throw new PayError('invalid_param', 422, 'chain');
  if (merchantId) throw new PayError('merchant_route_not_supported', 422, 'merchant_id');
  if (CHAINS_NOT_IN_BATCH.includes(chain)) throw new PayError('chain_not_enabled', 409, 'chain');
  const why = String(reason ?? '').trim();
  if (!why) throw new PayError('reason_required', 422, 'reason');
  if (!code || typeof verifyCode !== 'function' || !(await verifyCode(String(code)))) throw new PayError('bad_code', 422, 'code');
  if (!PROVIDER_IDS.includes(provider)) throw new PayError('invalid_provider', 422, 'provider');
  const p = providers[provider];
  if (!p || p.enabled === false) throw new PayError('provider_not_enabled', 409, 'provider');
  const when = at(now);
  return db.tx(async (t) => {
    const from = await resolveProvider(t, { chain, now: when });
    await t.query('insert into wallet_routes (merchant_id, chain, provider, effective_from, actor, reason) values (null, $1, $2, $3, $4, $5)', [chain, provider, when, actor, why.slice(0, 500)]);
    await audit(t, actor, 'wallet.route', chain, { chain, from, to: provider, reason: why.slice(0, 500) });
    return { chain, from, to: provider, effective_from: when.toISOString() };
  });
}
