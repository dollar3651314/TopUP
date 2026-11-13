import crypto from 'node:crypto';

const BASE = process.env.TOPUP_BASE || 'https://{BASE_URL}/api/v1/';
const KEY = process.env.TOPUP_KEY, SECRET = process.env.TOPUP_SECRET;

async function topup(method, path, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const raw = body ? JSON.stringify(body) : '';
  const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const url = new URL(path, BASE);
  const toSign = [ts, method, url.pathname + url.search, bodyHash].join('\n');
  const sig = crypto.createHmac('sha256', SECRET).update(toSign).digest('hex');
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-TopUP-Key': KEY, 'X-TopUP-Timestamp': ts, 'X-TopUP-Signature': sig,
      ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
    },
    body: raw || undefined,
  });
  return res.json();
}

const order = await topup('POST', 'orders/', { customer_id: 'user_88213', merchant_order_no: `ACME-${Date.now()}`, amount: '100.00' });
console.log(order.pay_url);
