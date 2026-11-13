// 数据库访问层：统一成 { query(sql, params) → rows, tx(fn) } 两个方法。
// - 生产和测试环境：服务器上自装的 Postgres（postgres.js，关闭预编译语句，兼容经连接池访问）。
// - 本地和自动化测试：内嵌的 Postgres（PGlite），和生产使用同一份建表脚本和 SQL。
// bigint（金额）统一转成 JS 数字：金额单位是 0.000001 USDT，Number 能精确表示到 90 亿 USDT。

const INT8 = 20;

/** 生产：DATABASE_URL 指向 Postgres（直连或经 transaction 模式的连接池） */
export async function createPgDb(url) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, {
    prepare: false, max: MAX_CONN, idle_timeout: 20, connect_timeout: 10, onnotice: () => {},
    types: {
      bigint: { to: INT8, from: [INT8], serialize: (x) => String(x), parse: (x) => Number(x) },
      // 代码里 jsonb 参数一律先 JSON.stringify 再传入（和 PGlite 一致）。postgres.js 默认会对 json/jsonb 参数再 stringify 一次，
      // 存进去的就成了 JSON 字符串，读出来也是字符串。这里字符串原样传入，读出时解析成对象。
      json: { to: 114, from: [114, 3802], serialize: (x) => (typeof x === 'string' ? x : JSON.stringify(x)), parse: (x) => JSON.parse(x) },
    },
  });
  // 同时进行的查询不超过连接数：超过时 postgres.js 会把多个查询排在同一个连接上连续发送（pipelining），
  // 经过 transaction 模式的连接池时会卡住不返回，接口超时。这里在程序里排队，一个完成再发下一个
  const wrap = (s, limit) => {
    const run = gate(limit);
    return { query: (text, params = []) => run(async () => [...(await s.unsafe(text, params))]) };
  };
  return { ...wrap(sql, MAX_CONN), tx: (fn) => sql.begin((t) => fn(wrap(t, 1))), end: () => sql.end({ timeout: 5 }) };
}

const MAX_CONN = 3;
/** 并发闸门：最多 limit 个任务同时进行，其余排队 */
export function gate(limit) {
  let active = 0;
  const queue = [];
  const next = () => { if (active >= limit || !queue.length) return; active++; const { fn, ok, fail } = queue.shift(); fn().then(ok, fail).finally(() => { active--; next(); }); };
  return (fn) => new Promise((ok, fail) => { queue.push({ fn, ok, fail }); next(); });
}

/** 本地和测试：内嵌 Postgres。dir 为空时只在内存里 */
export async function createLiteDb(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dir || undefined, { parsers: { [INT8]: (v) => Number(v) } });
  const wrap = (s) => ({ query: async (text, params = []) => (await s.query(text, params)).rows });
  // PGlite 只有一个连接：事务串行执行，行锁的语义和生产一致
  return { ...wrap(db), tx: (fn) => db.transaction((t) => fn(wrap(t))), exec: (text) => db.exec(text), end: () => db.close() };
}

/**
 * 测试用：设置了 TEST_DATABASE_URL 时连真实的 Postgres（每次一个新的 schema，互不影响），否则用内嵌 Postgres。
 * 本地和线上用的驱动不同（PGlite / postgres.js），用这个在真实 Postgres 上把整套测试跑一遍。
 */
export async function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createLiteDb();
  const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = await createPgDb(url);
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return createPgDb(u.toString());
}
