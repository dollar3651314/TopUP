// 小工具：JSON 响应、读取请求体（限制大小）
export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export async function readJson(request, max = 256 * 1024) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('unsupported_media_type'), { status: 415 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > max) throw Object.assign(new Error('too_large'), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}
/** 从 /api/<组>/<动作>/ 形式的地址中取出"动作" */
// 动作名：线上是 /api/kyb/?a=<动作>；也兼容路径最后一段的写法（单元测试里用）
export const actionOf = (request) => { const u = new URL(request.url); return u.searchParams.get('a') || u.pathname.split('/').filter(Boolean).pop(); };
export const originOf = (request) => {
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || u.host;
  const proto = request.headers.get('x-forwarded-proto') || u.protocol.replace(':', '');
  return `${proto}://${host}`;
};
