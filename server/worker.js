// worker 进程：常驻运行的定时任务。
//   - 每 TICK_INTERVAL_MS（默认 15 秒）一次：扫链入账、订单过期、提币确认、发送回调、归集确认（pay/tick.js）
//   - 每天 DAILY_AT_UTC（默认 19:15 UTC）一次：开户资料到期清理、收付款的对账和资产检查（kyb/admin.js、pay/daily.js）
// 同一时间只有一个 worker 在跑：用数据库里的租约（pay_meta 的 worker_lease），租约过期才能被别的 worker 接手；
// 正常退出时把租约到期时间设成 1970 年，新的 worker 不用等。
// 用法：node server/worker.js（环境变量和 web 进程相同）
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createApp, refuseLocal } from './app.js';

export const LEASE_MS = 60_000;

/** 抢租约：没有租约、租约已过期、或者租约本来就是自己的，才算抢到 */
export async function takeLease(db, owner, { now = Date.now(), ms = LEASE_MS } = {}) {
  const value = JSON.stringify({ owner, until: new Date(now + ms).toISOString() });
  const rows = await db.query(`insert into pay_meta (key, value) values ('worker_lease', $1::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (pay_meta.value->>'until')::timestamptz < $2::timestamptz or pay_meta.value->>'owner' = $3
    returning key`, [value, new Date(now).toISOString(), owner]);
  return rows.length === 1;
}

export async function releaseLease(db, owner) {
  await db.query(`update pay_meta set value = jsonb_build_object('owner', value->>'owner', 'until', '1970-01-01T00:00:00Z'), updated_at = now()
    where key = 'worker_lease' and value->>'owner' = $1`, [owner]);
}

/** 今天（UTC）的每日任务时间点是否已到 */
export function dailyDue(nowMs, atUtc, lastDay) {
  const d = new Date(nowMs);
  const day = d.toISOString().slice(0, 10);
  if (lastDay === day) return null;
  const [h, m] = String(atUtc).split(':').map(Number);
  return d.getUTCHours() * 60 + d.getUTCMinutes() >= h * 60 + (m || 0) ? day : null;
}

/**
 * 跑一轮：抢到租约才执行。tick / daily / cleanup 各自出错只记日志，不影响下一轮。
 * state.lastDaily 记在 pay_meta（worker_daily），重启后不会重复执行当天的每日任务。
 */
export async function runOnce({ db, tick, daily, cleanup, owner, atUtc, now = Date.now(), log = console }) {
  if (!(await takeLease(db, owner, { now }))) return { skipped: 'lease' };
  const out = {};
  try { out.tick = await tick(); } catch (e) { log.error(`[worker] tick: ${e.stack || e}`); out.tick = { error: 'failed' }; }
  const [r] = await db.query(`select value from pay_meta where key = 'worker_daily'`);
  const due = dailyDue(now, atUtc, r?.value?.day);
  if (due) {
    try { out.cleanup = await cleanup(); } catch (e) { log.error(`[worker] cleanup: ${e.stack || e}`); out.cleanup = { error: 'failed' }; }
    try { out.daily = await daily(); } catch (e) { log.error(`[worker] daily: ${e.stack || e}`); out.daily = { error: 'failed' }; }
    await db.query(`insert into pay_meta (key, value) values ('worker_daily', $1::jsonb)
      on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify({ day: due, at: new Date(now).toISOString() })]);
  }
  return out;
}

export async function startWorker(config = loadConfig(), { log = console } = {}) {
  const refused = refuseLocal(config);
  if (refused) throw Object.assign(new Error(refused), { missing: ['APP_ENV'] });
  const app = await createApp(config);
  const pay = await app.pay;
  const owner = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const deps = { db: pay.db, tick: pay.tick, daily: pay.daily, cleanup: app.kyb.cleanup, owner, atUtc: config.dailyAtUtc, log };
  let stopped = false, timer = null, running = null;
  const loop = async () => {
    if (stopped) return;
    running = runOnce({ ...deps, now: Date.now() }).catch((e) => log.error(`[worker] ${e.stack || e}`));
    await running;
    if (!stopped) timer = setTimeout(loop, config.tickIntervalMs);
  };
  log.log(`[worker] started (${config.appEnv}), every ${config.tickIntervalMs} ms, daily at ${config.dailyAtUtc} UTC`);
  loop();
  return {
    async stop() {
      stopped = true; clearTimeout(timer);
      await running;
      try { await releaseLease(pay.db, owner); } catch {}
      await app.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const w = await startWorker().catch((err) => { console.error(`[worker] init failed: ${err.missing ? err.message : err.code || err.message}`); process.exit(1); });
  const stop = async () => { await w.stop(); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
