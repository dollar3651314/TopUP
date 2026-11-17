import crypto from 'node:crypto';

// Verify a TopUP callback. rawBody must be the exact request body you received,
// not an object you parsed and serialised again.
export function verifyCallback(secret, timestamp, signature, rawBody) {
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}\n${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature || ''));
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
  return fresh && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Express example:
// app.post('/callback', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyCallback(SECRET, req.get('X-TopUP-Timestamp'), req.get('X-TopUP-Signature'), req.body)) return res.sendStatus(401);
//   const event = JSON.parse(req.body); // the same event may arrive more than once: deduplicate by event.id
//   res.sendStatus(200);
// });
