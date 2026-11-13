// 付款页面的查询接口：/api/pay/?o=<订单号>。付款方不需要登录，只返回付款需要的信息（不含客户标识、邮箱）。
// 多链：返回这个客户每条链现在用的地址（停用的不给）；商户创建订单时指定了链，就只给这条链（付款页跳过选择）。
import { json } from '../kyb/http.js';
import { stateOf } from './matching.js';
import { amt, iso } from './common.js';

const NETWORK = { eth: 'ETH', bsc: 'BSC', tron: 'TRON' };
const ORDER = ['eth', 'bsc', 'tron'];

export function createPayApi({ db, layer = null, now = () => Date.now() }) {
  return async function handle(request) {
    const id = new URL(request.url).searchParams.get('o') || '';
    if (!/^ORD-\d{8}-[0-9A-F]{8}$/.test(id)) return json(404, { error: { code: 'not_found' } });
    const [o] = await db.query(`select o.*, c.address, m.name from orders o join customers c on c.merchant_id = o.merchant_id and c.customer_id = o.customer_id
      join merchants m on m.id = o.merchant_id where o.id = $1`, [id]);
    if (!o) return json(404, { error: { code: 'not_found' } });
    // 过期由每分钟的任务写回数据库；这里先按时间算一次，页面不用等下一分钟
    const status = stateOf({ amount: o.amount, matched: o.matched, expiresAt: iso(o.expires_at), low: o.low, high: o.high }, now());
    const rows = await db.query(`select chain, address from customer_addresses where merchant_id = $1 and customer_id = $2 and status = 'active'`, [o.merchant_id, o.customer_id]);
    const enabled = layer ? [...layer.enabledChains, 'tron'] : ORDER;
    let addresses = ORDER.map((c) => rows.find((r) => r.chain === c)).filter((r) => r && enabled.includes(r.chain)).map((r) => ({ chain: r.chain, network: NETWORK[r.chain], address: r.address }));
    if (o.chain) addresses = addresses.filter((a) => a.chain === o.chain);
    // 只有 TRON 旧地址、还没有补进 customer_addresses 的老客户：照旧给 TRON
    if (!addresses.length && !o.chain && o.address) addresses = [{ chain: 'tron', network: 'TRON', address: o.address }];
    const confirmations = layer ? Object.fromEntries(Object.entries(layer.config).map(([c, v]) => [c, v.confirmations])) : {};
    const first = addresses[0] || null;
    return json(200, {
      order_no: o.id, merchant: o.name, amount: amt(o.amount), matched: amt(o.matched), status, expires_at: iso(o.expires_at), low: o.low, high: o.high, token: 'USDT',
      chain: o.chain || null, addresses, confirmations,
      // 旧字段（第 0 批的付款页）：第一个可用的地址
      address: first ? first.address : null, network: first ? first.network : null,
    });
  };
}
