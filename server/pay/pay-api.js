// 付款页面的查询接口：/api/pay/?o=<订单号>。付款方不需要登录，只返回付款需要的信息（不含客户标识、邮箱）。
import { json } from '../kyb/http.js';
import { stateOf } from './matching.js';
import { amt, iso } from './common.js';

export function createPayApi({ db, now = () => Date.now() }) {
  return async function handle(request) {
    const id = new URL(request.url).searchParams.get('o') || '';
    if (!/^ORD-\d{8}-[0-9A-F]{8}$/.test(id)) return json(404, { error: { code: 'not_found' } });
    const [o] = await db.query(`select o.*, c.address, m.name from orders o join customers c on c.merchant_id = o.merchant_id and c.customer_id = o.customer_id
      join merchants m on m.id = o.merchant_id where o.id = $1`, [id]);
    if (!o) return json(404, { error: { code: 'not_found' } });
    // 过期由每分钟的任务写回数据库；这里先按时间算一次，页面不用等下一分钟
    const status = stateOf({ amount: o.amount, matched: o.matched, expiresAt: iso(o.expires_at), low: o.low, high: o.high }, now());
    return json(200, { order_no: o.id, merchant: o.name, amount: amt(o.amount), matched: amt(o.matched), status, expires_at: iso(o.expires_at), address: o.address, low: o.low, high: o.high, network: 'TRON', token: 'USDT' });
  };
}
