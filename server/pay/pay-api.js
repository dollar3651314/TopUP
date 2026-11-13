// 付款页面的查询接口：/api/pay/?o=<订单号>[&chain=eth|bsc|tron]。付款方不需要登录，只返回付款需要的信息（不含客户标识、邮箱）。
// K1：地址在客户发起充值时按链生成。
//   - 订单指定了链：只用这条链（创建订单时已生成）；带了别的链 409 chain_mismatch
//   - 没指定链：付款人在付款页选了链（带 chain）才为这条链生成（或复用）地址；没选时 address、network 为 null
//   - chains：付款人现在能选的链（第 1 批 eth、bsc；老客户已有 TRON 地址时加 tron；订单指定了链时只有这条）
//   - chain=tron：只给已有 TRON 地址的老客户，其他 409 chain_not_enabled；不认识的链 422
import { json } from '../kyb/http.js';
import { stateOf } from './matching.js';
import { amt, iso } from './common.js';
import { addressFor } from '../wallet/addresses.js';

const NETWORK = { eth: 'ETH', bsc: 'BSC', tron: 'TRON' };
const ORDER = ['eth', 'bsc', 'tron'];
const err = (status, code, field) => json(status, { error: { code, ...(field ? { field } : {}) } });

export function createPayApi({ db, layer = null, now = () => Date.now() }) {
  return async function handle(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get('o') || '';
    const want = url.searchParams.get('chain') || '';
    if (!/^ORD-\d{8}-[0-9A-F]{8}$/.test(id)) return err(404, 'not_found');
    if (want && !ORDER.includes(want)) return err(422, 'invalid_param', 'chain');
    const [o] = await db.query(`select o.*, m.name from orders o join merchants m on m.id = o.merchant_id where o.id = $1`, [id]);
    if (!o) return err(404, 'not_found');
    // 过期由每分钟的任务写回数据库；这里先按时间算一次，页面不用等下一分钟
    const status = stateOf({ amount: o.amount, matched: o.matched, expiresAt: iso(o.expires_at), low: o.low, high: o.high }, now());
    const active = async () => db.query(`select chain, address from customer_addresses where merchant_id = $1 and customer_id = $2 and status = 'active'`, [o.merchant_id, o.customer_id]);
    let rows = await active();
    const evm = layer ? [...layer.enabledChains] : [];
    const hasTron = rows.some((r) => r.chain === 'tron');
    const chains = o.chain ? [o.chain] : ORDER.filter((c) => (c === 'tron' ? hasTron : evm.includes(c)));
    if (want) {
      if (o.chain && want !== o.chain) return err(409, 'chain_mismatch', 'chain');
      if (!chains.includes(want)) return err(409, 'chain_not_enabled', 'chain');
      if (want !== 'tron' && !rows.some((r) => r.chain === want)) {
        try { await addressFor(db, { merchantId: o.merchant_id, customerId: o.customer_id, chain: want, providers: layer?.providers || {} }); }
        catch (e) { return err(e.status || 409, e.code || 'chain_not_enabled', 'chain'); }
        rows = await active();
      }
    }
    const pick = want || o.chain || '';
    let addresses = ORDER.map((c) => rows.find((r) => r.chain === c)).filter((r) => r && (r.chain === 'tron' || evm.includes(r.chain)))
      .map((r) => ({ chain: r.chain, network: NETWORK[r.chain], address: r.address }));
    if (o.chain) addresses = addresses.filter((a) => a.chain === o.chain);
    else if (want) addresses = addresses.filter((a) => a.chain === want);
    const cur = pick ? addresses.find((a) => a.chain === pick) || null : null;
    const confirmations = layer ? Object.fromEntries(Object.entries(layer.config).map(([c, v]) => [c, v.confirmations])) : {};
    return json(200, {
      order_no: o.id, merchant: o.name, amount: amt(o.amount), matched: amt(o.matched), status, expires_at: iso(o.expires_at), low: o.low, high: o.high, token: 'USDT',
      chain: o.chain || null, chains, addresses, confirmations,
      // 旧字段：付款人选的（或订单指定的）这条链的地址；还没选时为 null
      address: cur ? cur.address : null, network: cur ? cur.network : null,
    });
  };
}
