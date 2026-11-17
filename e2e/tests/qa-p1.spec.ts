import { test, expect, type Page, type Route } from '@playwright/test';

// 测试先写（测试经理）：上线前清理 P1 的两处页面。开发不要改这个文件，有异议找测试经理改。
//   K-1 运营后台显示商户编号（m_ 开头）：商户列表每一行、商户详情（点一行打开的弹窗）、打款审核"等你审"的每一行（单笔、商户批量）和审一笔的弹窗。
//   K-3 页面过期：部署后旧页面调接口，服务器回 409 stale_page → 页面显示含"请刷新页面"的中文提示（不显示 stale_page、wrong_spender 这类代码）；
//       页面调 /api/wallet/ 时带请求头 X-TopUP-Build = #admin-root 的 data-build（构建时的提交号）。
// 做法：用 8080 主实例的正式构建页面，后台接口全部用浏览器拦截喂数据（返回的样子照 server/pay/wallet-api.js 实际返回抄的），
// 不登录、不改服务器上的数据，和别的用例互不影响。
const B = 'http://127.0.0.1:8080';
const MID = 'm_qa7x2';
const GID = 'm_qb9k4';
const BUILD = 'c0ffee'.padEnd(40, '0');
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const MERCHANT = {
  id: MID, name: 'QA 商户', kyb_ref: null, status: 'active', fee_in: { min: 0, ppm: 10000, fixed: 0 }, fee_out: { min: 0, ppm: 0, fixed: 2000000 },
  order_mode: { low: 900000, high: 1100000, ttlMin: 30, enabled: true, lookbackH: 24 }, available: '988.00', frozen: '12.00', customers: 0, ip_whitelist: [], cashout_wallets: [], users: [],
};
function withdrawals() {
  const single = { id: 'WD-20261117-01D5A4F1', merchant_id: MID, merchant: 'QA 商户', kind: 'payout', chain: 'tron', to: 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q', amount: '10.00', fee: '2.00', source: 'web',
    customer_id: null, merchant_ref: null, batch_no: null, created_at: iso(5), registered: false, first_time: true };
  const gitem = { ...single, id: 'WD-20261117-02B6C7D8', merchant_id: GID, merchant: '批量商户', batch_no: 'PB-20261117-0001', created_at: iso(3) };
  const card = (chain: string, max: number) => ({ chain, approved_count: 0, approved_total: '0.00', enabled: false, hot: null, hot_balance: null, allowance: null, cap: null, by: null, blocked: 'not_enabled', max_items: max, planned_batches: 0 });
  return {
    singles: [single], groups: [{ batch_no: 'PB-20261117-0001', merchant: '批量商户', merchant_id: GID, source: 'api', created_at: iso(3), items: [gitem], count: 1, total: '10.00' }],
    pending_count: 2, approved: [], batches: [], limits: { perItem: '5000.00', perBatch: '20000.00', perDay: '30000.00', hotMax: '10000.00', hotLow: '2000.00' },
    cards: [card('eth', 100), card('bsc', 100), card('tron', 20)], today_approved: '0.00', per_day: '30000.00', service: { open: true }, hot: { address: '', usdt: '0.00' }, items: [single, gitem],
  };
}
const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** 拦截后台接口：已登录；wallet 动作按 handlers 回，没列的回 {}；stale = true 时 /api/wallet/ 一律 409 stale_page */
async function mockAdmin(page: Page, opts: { stale?: boolean; build?: string } = {}) {
  const seen: { a: string; build: string | null }[] = [];
  await page.route((u) => u.pathname === '/api/kyb/', (r) => {
    const a = new URL(r.request().url()).searchParams.get('a');
    if (a === 'me') return json(r, { initialized: true, authed: true });
    if (a === 'apps') return json(r, { apps: [] });
    return json(r, {});
  });
  await page.route((u) => u.pathname === '/api/wallet/', (r) => {
    const a = new URL(r.request().url()).searchParams.get('a') || '';
    seen.push({ a, build: r.request().headers()['x-topup-build'] ?? null });
    if (opts.stale) return json(r, { error: { code: 'stale_page', message: 'stale_page' } }, 409);
    if (a === 'merchants') return json(r, { merchants: [MERCHANT], pending: [] });
    if (a === 'withdrawals' || a === 'payout-overview') return json(r, withdrawals());
    if (a === 'anomalies') return json(r, { items: [] });
    return json(r, {});
  });
  if (opts.build !== undefined) {
    // 模拟"构建时记下了提交号"：把 #admin-root 的 data-build 换成指定值（没有这个属性就加上）
    await page.route((u) => u.pathname === '/admin/', async (r) => {
      const res = await r.fetch();
      let html = await res.text();
      html = /id="admin-root"[^>]*data-build="/.test(html)
        ? html.replace(/(id="admin-root"[^>]*data-build=")[^"]*"/, `$1${opts.build}"`)
        : html.replace('id="admin-root"', `id="admin-root" data-build="${opts.build}"`);
      await r.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
    });
  }
  await page.goto(`${B}/admin/`);
  await expect(page.locator('[data-view="app"]')).toBeVisible();
  return seen;
}
async function tab(page: Page, name: string) {
  await page.click(`[data-tab="${name}"]`);
  await expect(page.locator(`[data-panel="${name}"]`)).toBeVisible();
  await expect(page.locator(`[data-panel="${name}"] [data-loading]`)).toHaveCount(0);
}

test.describe('QA-P1 后台：商户编号、页面过期提示', () => {
  test('K-1 商户列表每一行、商户详情弹窗都显示商户编号（m_ 开头）', async ({ page }) => {
    await mockAdmin(page);
    await tab(page, 'p-merchants');
    const row = page.locator('[data-panel="p-merchants"] tbody tr').filter({ hasText: 'QA 商户' });
    await expect(row).toHaveCount(1);
    await expect(row, '列表这一行要有商户编号').toContainText(MID);
    await row.click();
    await expect(page.locator('[data-pdialog]'), '商户详情（弹窗）要有商户编号').toContainText(MID);
  });

  test('K-1 打款审核：等你审的单笔、商户批量每一行都显示商户编号；审一笔的弹窗里也有', async ({ page }) => {
    await mockAdmin(page);
    await tab(page, 'p-withdrawals');
    const p = page.locator('[data-panel="p-withdrawals"]');
    await expect(p.locator('[data-payout-row="WD-20261117-01D5A4F1"]'), '单笔这一行').toContainText(MID);
    await expect(p.locator('[data-payout-group="PB-20261117-0001"]'), '商户批量这一行').toContainText(GID);
    await p.locator('[data-payout-row="WD-20261117-01D5A4F1"]').click();
    await expect(page.locator('[data-pdialog]'), '审一笔的弹窗').toContainText(MID);
  });

  test('K-3 页面过期：接口回 409 stale_page → 显示"请刷新页面"的中文提示，不显示 stale_page 这类代码', async ({ page }) => {
    await mockAdmin(page, { stale: true });
    await page.click('[data-tab="p-merchants"]');
    const p = page.locator('[data-panel="p-merchants"]');
    await expect(p.locator('[data-load-error]')).toContainText('请刷新页面');
    await expect(p).not.toContainText('stale_page');
    await expect(p).not.toContainText('操作失败（');
  });

  test('K-3 页面调 /api/wallet/ 时带 X-TopUP-Build = #admin-root 的 data-build', async ({ page }) => {
    const seen = await mockAdmin(page, { build: BUILD });
    await expect(page.locator('#admin-root')).toHaveAttribute('data-build', BUILD);
    await tab(page, 'p-merchants');
    const calls = seen.filter((x) => x.a === 'merchants');
    expect(calls.length, '调过 merchants').toBeGreaterThan(0);
    expect(calls.every((x) => x.build === BUILD), `每次都带 X-TopUP-Build：${JSON.stringify(calls)}`).toBe(true);
  });

  test('K-3 正式构建的 admin 页有 data-build 属性（构建时的提交号；本地构建可以是空的）', async ({ request }) => {
    const html = await (await request.get(`${B}/admin/`)).text();
    expect(html, '#admin-root 带 data-build').toMatch(/id="admin-root"[^>]*data-build="[0-9a-f]*"/);
  });
});
