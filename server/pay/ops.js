// 商户的操作：开放 API（api/v1）和商户后台（api/merchant）共用这一份，保证两边功能一致。
// 每个函数的第一个参数都带着商户，所有查询都限定在这个商户下。
import { randomBytes } from 'node:crypto';
import { encryptJson, decryptJson } from '../kyb/crypto.js';
import * as core from './core.js';
import { PayError, CUSTOMER_RE } from './core.js';
import { parseAmount, iso, page, emailHash } from './common.js';
import { checkCallbackUrl } from './callbacks.js';
import { addressFor } from '../wallet/addresses.js';

export const NETWORK = { eth: 'ETH', bsc: 'BSC', tron: 'TRON' };
const CHAIN_ORDER = ['eth', 'bsc', 'tron'];

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const cleanText = (v, max) => String(v ?? '').trim().slice(0, max);

export function createOps({ db, keys, payBase = '', keyPrefix = 'topup_live_', wallet = null }) {
  const enabledChains = wallet?.enabledChains || [];
  /** 新客户、老客户第一次要地址：给每条已开通的链分配地址（合约钱包是纯计算）；分配失败只记日志，下次再要时重试 */
  async function ensureAddresses(m, customerId) {
    for (const chain of enabledChains) {
      try { await addressFor(db, { merchantId: m.id, customerId, chain, providers: wallet.providers }); }
      catch (e) { console.error(`[pay] address ${chain}: ${e.code || e.message}`); }
    }
  }
  /** 一批客户每条链现在用的地址（停用的不给）：Map(customer_id → [{ chain, address }]) */
  async function addressesOf(merchantId, ids) {
    const out = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const rows = await db.query(`select customer_id, chain, address from customer_addresses where merchant_id = $1 and customer_id = any($2::text[]) and status = 'active'`, [merchantId, ids]);
    for (const r of rows.sort((a, b) => CHAIN_ORDER.indexOf(a.chain) - CHAIN_ORDER.indexOf(b.chain))) out.get(r.customer_id)?.push({ chain: r.chain, address: r.address });
    return out;
  }
  const withAddrs = async (m, rows) => {
    const map = await addressesOf(m.id, rows.map((r) => r.customer_id));
    return rows.map((r) => customerView(r, map.get(r.customer_id)));
  };
  const enc = (s) => (s ? encryptJson(keys.enc, s) : '');
  const dec = (s) => { if (!s) return ''; try { return decryptJson(keys.enc, s); } catch { return ''; } };
  const payUrl = (id) => `${payBase}/pay/${id}/`;
  const eh = (s) => emailHash(keys, s);

  const customerView = (c, addresses = []) => ({
    customer_id: c.customer_id, name: c.name, email: dec(c.email_enc), remark: c.remark, address: c.address ?? null, addresses,
    total: c.total, count: c.count, fees: c.fees, unmatched: c.unmatched, last_payment_at: iso(c.last_at), created_at: iso(c.created_at),
  });
  const needCustomer = async (m, id) => {
    const [c] = await db.query('select * from customers where merchant_id = $1 and customer_id = $2', [m.id, id]);
    if (!c) throw new PayError('not_found', 404);
    return c;
  };
  /** 订单的付款信息：指定了链时 address 是这条链的地址；没有指定时是 TRON 地址（旧字段），addresses 给出每条链的地址 */
  const withPay = async (m, o, chain) => {
    const addrs = (await addressesOf(m.id, [o.customer_id])).get(o.customer_id);
    const [c] = await db.query('select address from customers where merchant_id = $1 and customer_id = $2', [m.id, o.customer_id]);
    const picked = chain ? addrs.find((a) => a.chain === chain)?.address ?? null : c?.address ?? null;
    return { ...o, address: picked, network: NETWORK[chain || 'tron'], chain: chain || null, addresses: addrs, token: 'USDT', pay_url: payUrl(o.order_no) };
  };
  const orderOwned = async (m, id) => {
    const [o] = await db.query('select id from orders where merchant_id = $1 and (id = $2 or merchant_order_no = $3)', [m.id, id?.orderNo || '', id?.merchantOrderNo || '']);
    if (!o) throw new PayError('not_found', 404);
    return o.id;
  };

  return {
    /** 已开通的链（第 1 批：ETH、BSC；TRON 只给已有地址的老客户） */
    chains: () => [...enabledChains],
    // ---------- 客户 ----------
    async upsertCustomer(m, b) {
      const id = String(b.customer_id || '');
      if (!CUSTOMER_RE.test(id)) throw new PayError('invalid_param', 422, 'customer_id');
      if (b.email && !EMAIL_RE.test(String(b.email))) throw new PayError('invalid_param', 422, 'email');
      const c = await db.tx(async (t) => {
        const email = cleanText(b.email, 320);
        const row = await core.ensureCustomer(t, m.id, id, { name: cleanText(b.name, 200), emailEnc: enc(email), emailHash: eh(email) });
        const sets = [], vals = [m.id, id];
        if (b.name !== undefined) { vals.push(cleanText(b.name, 200)); sets.push(`name = $${vals.length}`); }
        if (b.email !== undefined) { vals.push(enc(email), eh(email)); sets.push(`email_enc = $${vals.length - 1}`, `email_hash = $${vals.length}`); }
        if (b.remark !== undefined) { vals.push(cleanText(b.remark, 500)); sets.push(`remark = $${vals.length}`); }
        if (!sets.length) return row;
        return (await t.query(`update customers set ${sets.join(', ')} where merchant_id = $1 and customer_id = $2 returning *`, vals))[0];
      });
      await ensureAddresses(m, id);
      return (await withAddrs(m, [c]))[0];
    },
    async getCustomer(m, id) { return (await withAddrs(m, [await needCustomer(m, id)]))[0]; },
    /** 这个客户每条链的地址（商户后台新建客户后弹出） */
    async customerAddresses(m, id) {
      await needCustomer(m, id);
      await ensureAddresses(m, id);
      return { customer_id: id, addresses: (await addressesOf(m.id, [id])).get(id), chains: enabledChains };
    },
    async listCustomers(m, { q = '', cursor = null, limit = 50 }) {
      const vals = [m.id];
      let where = 'merchant_id = $1';
      if (cursor) { vals.push(new Date(Number(cursor))); where += ` and created_at < $${vals.length}`; }
      let rows;
      if (q) {
        // 按客户标识、名称、邮箱模糊搜索，或按地址精确搜索。邮箱是加密保存的：
        // - 输入的是完整邮箱时，按检索哈希精确查找，不受客户数量限制
        // - 部分邮箱：解密最近的 5000 个客户后比对（保持 的体验）
        const needle = q.toLowerCase();
        const cand = await db.query(`select * from customers where ${where} order by created_at desc limit 5000`, vals);
        const byAddr = new Set((await db.query(`select customer_id from customer_addresses where merchant_id = $1 and lower(address) = lower($2)`, [m.id, q.trim()])).map((r) => r.customer_id));
        rows = cand.filter((r) => r.address === q || byAddr.has(r.customer_id) || [r.customer_id, r.name, dec(r.email_enc)].some((v) => (v || '').toLowerCase().includes(needle)));
        if (EMAIL_RE.test(q.trim())) {
          const exact = await db.query(`select * from customers where ${where} and email_hash = $${vals.length + 1} order by created_at desc limit ${limit + 1}`, [...vals, eh(q)]);
          const seen = new Set(rows.map((r) => r.customer_id));
          rows = [...rows, ...exact.filter((r) => !seen.has(r.customer_id))].sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
        }
        rows = rows.slice(0, limit + 1);
      } else {
        vals.push(limit + 1);
        rows = await db.query(`select * from customers where ${where} order by created_at desc limit $${vals.length}`, vals);
      }
      const p = page(rows.map((r) => ({ ...r, cursor: new Date(r.created_at).getTime() })), limit);
      return { items: await withAddrs(m, p.items), next_cursor: p.next_cursor };
    },
    /** 客户在一个时间段内的统计（只算已入账的到账） */
    async customerStats(m, id, { from, to }) {
      await needCustomer(m, id);
      const f = from ? new Date(from) : new Date(0), t = to ? new Date(to) : new Date();
      if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new PayError('invalid_param', 422, 'from');
      const [s] = await db.query(`select coalesce(sum(amount), 0)::bigint total, count(*)::int count, coalesce(sum(fee), 0)::bigint fees,
        coalesce(sum(amount) filter (where order_id is null), 0)::bigint unmatched, max(time) last
        from deposits where merchant_id = $1 and customer_id = $2 and result = 'credited' and time >= $3 and time <= $4`, [m.id, id, f, t]);
      const [p] = await db.query(`select coalesce(sum(amount), 0)::bigint payouts, count(*)::int payout_count from withdrawals
        where merchant_id = $1 and customer_id = $2 and status = 'completed' and created_at >= $3 and created_at <= $4`, [m.id, id, f, t]);
      return { customer_id: id, from: iso(f), to: iso(t), total: s.total, count: s.count, fees: s.fees, unmatched: s.unmatched, last_payment_at: iso(s.last), payouts: p.payouts, payout_count: p.payout_count };
    },

    // ---------- 订单 ----------
    async createOrder(m, b) {
      if (b.customer_email && !EMAIL_RE.test(String(b.customer_email))) throw new PayError('invalid_param', 422, 'customer_email');
      const chain = b.chain === undefined || b.chain === null || b.chain === '' ? null : String(b.chain);
      if (chain && !['eth', 'bsc', 'tron'].includes(chain)) throw new PayError('invalid_param', 422, 'chain');
      if (chain && !enabledChains.includes(chain)) throw new PayError('chain_not_enabled', 409, 'chain');
      const o = await core.createOrder(db, m, {
        customerId: String(b.customer_id || ''), customerName: cleanText(b.customer_name, 200), customerEmailEnc: enc(cleanText(b.customer_email, 320)), customerEmailHash: eh(cleanText(b.customer_email, 320)),
        merchantOrderNo: String(b.merchant_order_no || ''), amount: parseAmount(b.amount), chain,
      });
      const { address, ...v } = o;
      await ensureAddresses(m, v.customer_id);
      return withPay(m, v, chain);
    },
    async getOrder(m, { orderNo, merchantOrderNo }) {
      const id = await orderOwned(m, { orderNo, merchantOrderNo });
      const v = await core.orderView(db, id);
      const [o] = await db.query('select chain from orders where id = $1', [id]);
      return withPay(m, v, o.chain);
    },
    async listOrders(m, { status = '', customerId = '', cursor = null, limit = 50 }) {
      const vals = [m.id, limit + 1];
      let where = 'merchant_id = $1';
      if (status) { vals.push(status); where += ` and status = $${vals.length}`; }
      if (customerId) { vals.push(customerId); where += ` and customer_id = $${vals.length}`; }
      if (cursor) { vals.push(new Date(Number(cursor))); where += ` and created_at < $${vals.length}`; }
      const rows = await db.query(`select * from orders where ${where} order by created_at desc limit $2`, vals);
      const p = page(rows.map((r) => ({ ...r, cursor: new Date(r.created_at).getTime() })), limit);
      return {
        items: p.items.map((o) => ({ order_no: o.id, merchant_order_no: o.merchant_order_no, customer_id: o.customer_id, amount: o.amount, matched: o.matched, status: o.status, created_at: iso(o.created_at), expires_at: iso(o.expires_at) })),
        next_cursor: p.next_cursor,
      };
    },
    async match(m, b, actor, on) {
      const id = await orderOwned(m, { orderNo: String(b.order_no || '') });
      const depositId = String(b.deposit_id || '');
      if (!/^\d{1,18}$/.test(depositId)) throw new PayError('invalid_param', 422, 'deposit_id');
      return core.setMatch(db, m.id, id, depositId, on, actor);
    },

    // ---------- 余额、账本、到账 ----------
    async balance(m) {
      const [b] = await db.query('select available, frozen from balances where merchant_id = $1', [m.id]);
      return { available: b.available, frozen: b.frozen, currency: 'USDT' };
    },
    async ledger(m, { cursor = null, limit = 50, customerId = '' }) {
      const vals = [m.id, limit + 1];
      let where = 'merchant_id = $1';
      if (cursor) { vals.push(Number(cursor)); where += ` and id < $${vals.length}`; }
      if (customerId) { vals.push(customerId); where += ` and customer_id = $${vals.length}`; }
      const rows = await db.query(`select * from ledger where ${where} order by id desc limit $2`, vals);
      const p = page(rows.map((r) => ({ ...r, cursor: r.id })), limit);
      return { items: p.items.map((l) => ({ id: String(l.id), type: l.type, amount: l.amount, available_after: l.available_after, frozen_after: l.frozen_after, ref: l.ref, customer_id: l.customer_id, created_at: iso(l.created_at) })), next_cursor: p.next_cursor };
    },
    async deposits(m, { cursor = null, limit = 50, customerId = '', matched = '' }) {
      const vals = [m.id, limit + 1];
      // 低于 1 USDT 的到账不入账、不结算给商户，商户（后台和开放 API）看不到，只在运营后台的"异常到账"里显示
      let where = "merchant_id = $1 and result = 'credited'";
      if (cursor) { vals.push(Number(cursor)); where += ` and id < $${vals.length}`; }
      if (customerId) { vals.push(customerId); where += ` and customer_id = $${vals.length}`; }
      if (matched === 'false') where += ' and order_id is null';
      if (matched === 'true') where += ' and order_id is not null';
      const rows = await db.query(`select * from deposits where ${where} order by id desc limit $2`, vals);
      const p = page(rows.map((r) => ({ ...r, cursor: r.id })), limit);
      return {
        items: p.items.map((d) => ({ id: String(d.id), customer_id: d.customer_id, chain: d.chain, address: d.address, txid: d.txid, amount: d.amount, fee: d.fee, credited: d.result === 'credited' ? d.amount - d.fee : 0, result: d.result, order_no: d.order_id, matched_by: d.match_type, time: iso(d.time) })),
        next_cursor: p.next_cursor,
      };
    },

    // ---------- 提币 ----------
    async withdraw(m, b, source) {
      return core.requestWithdrawal(db, m, { kind: String(b.kind || ''), to: String(b.to || '').trim(), amount: parseAmount(b.amount), customerId: b.customer_id ? String(b.customer_id) : null, source, merchantRef: b.merchant_ref ? cleanText(b.merchant_ref, 64) : null });
    },
    async getWithdrawal(m, id) {
      const [w] = await db.query('select id from withdrawals where id = $1 and merchant_id = $2', [String(id || ''), m.id]);
      if (!w) throw new PayError('not_found', 404);
      return core.withdrawalView(db, w.id);
    },
    async listWithdrawals(m, { cursor = null, limit = 50 }) {
      const vals = [m.id, limit + 1];
      let where = 'merchant_id = $1';
      if (cursor) { vals.push(new Date(Number(cursor))); where += ` and created_at < $${vals.length}`; }
      const rows = await db.query(`select id, created_at from withdrawals where ${where} order by created_at desc limit $2`, vals);
      const p = page(rows.map((r) => ({ ...r, cursor: new Date(r.created_at).getTime() })), limit);
      return { items: await Promise.all(p.items.map((w) => core.withdrawalView(db, w.id))), next_cursor: p.next_cursor };
    },
    cancelWithdrawal: (m, id) => core.cancelWithdrawal(db, m.id, String(id || '')),

    // ---------- API 密钥 ----------
    /** 生成新的 API Secret（旧的立即失效）；API Key 第一次生成后不变。Secret 只在这里返回一次 */
    async regenerateSecret(m) {
      const apiKey = m.api_key || keyPrefix + randomBytes(8).toString('hex');
      const secret = randomBytes(24).toString('hex');
      await db.query('update merchants set api_key = $2, api_secret_enc = $3 where id = $1', [m.id, apiKey, encryptJson(keys.enc, secret)]);
      await core.audit(db, `merchant:${m.id}`, 'api.secret_regenerated', m.id);
      return { api_key: apiKey, api_secret: secret };
    },
    async setIpWhitelist(m, list) {
      const ips = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))];
      if (ips.length > 20 || ips.some((x) => !/^(\d{1,3}\.){3}\d{1,3}$/.test(x) && !/^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(x))) throw new PayError('invalid_param', 422, 'ip_whitelist');
      await db.query('update merchants set ip_whitelist = $2::jsonb where id = $1', [m.id, JSON.stringify(ips)]);
      await core.audit(db, `merchant:${m.id}`, 'api.ip_whitelist', m.id, { ips });
      return { ip_whitelist: ips };
    },

    // ---------- 回调设置 ----------
    async setCallback(m, url) {
      const u = String(url || '').trim();
      if (u) { const bad = await checkCallbackUrl(u); if (bad) throw new PayError('invalid_param', 422, 'callback_url'); }
      await db.query('update merchants set callback_url = $2 where id = $1', [m.id, u]);
      return { callback_url: u };
    },
    async callbacks(m, { cursor = null, limit = 50 }) {
      const vals = [m.id, limit + 1];
      let where = 'merchant_id = $1';
      if (cursor) { vals.push(new Date(Number(cursor))); where += ` and created_at < $${vals.length}`; }
      const rows = await db.query(`select id, event, status, attempts, last_code, next_at, created_at, payload from callbacks where ${where} order by created_at desc limit $2`, vals);
      const p = page(rows.map((r) => ({ ...r, cursor: new Date(r.created_at).getTime() })), limit);
      const ref = (x) => x.payload?.data?.order_no || x.payload?.data?.withdrawal_no || x.payload?.data?.customer_id || '';
      return { items: p.items.map((x) => ({ id: x.id, event: x.event, ref: ref(x), status: x.status, attempts: x.attempts, last_code: x.last_code, next_at: x.status === 'pending' ? iso(x.next_at) : null, created_at: iso(x.created_at) })), next_cursor: p.next_cursor };
    },
  };
}
