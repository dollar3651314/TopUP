import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { startNode, KYB_ENV, TMP } from '../stack.mjs';

// worker 进程（server/worker.js）：常驻运行定时任务，写入"上次运行时间"；收到 SIGTERM 时释放租约后退出。
// 需要真实 Postgres（E2E_DATABASE_URL）：worker 和收付款实例（8094）用同一个数据库，测试通过 8094 的 /__fake/sql/ 查看结果。
const B = 'http://127.0.0.1:8094';
const sql = async (request: any, q: string) => (await (await request.post(`${B}/__fake/sql/`, { data: { sql: q } })).json());

test('TC-W01 worker：每隔几秒运行一次定时任务，退出时释放租约', async ({ request }) => {
  test.skip(!process.env.E2E_DATABASE_URL, '需要 E2E_DATABASE_URL（真实 Postgres）');
  const started = Date.now();
  const w = startNode('server/worker.js', 'worker', { ...KYB_ENV, DATABASE_URL: process.env.E2E_DATABASE_URL, DATA_DIR: resolve(TMP, 'data-worker'), FAKE_TRON: '1', TICK_INTERVAL_MS: '500' });
  try {
    await expect.poll(async () => {
      const [r] = await sql(request, `select value from pay_meta where key = 'tick_last'`);
      return r ? Date.parse(r.value.at) : 0;
    }, { timeout: 20_000 }).toBeGreaterThan(started);
    const [lease] = await sql(request, `select value from pay_meta where key = 'worker_lease'`);
    expect(Date.parse(lease.value.until)).toBeGreaterThan(Date.now());
  } finally {
    const exited = new Promise((r) => w.once('exit', r));
    w.kill('SIGTERM');
    await exited;
  }
  const [lease] = await sql(request, `select value from pay_meta where key = 'worker_lease'`);
  expect(lease.value.until).toBe('1970-01-01T00:00:00Z');
});
