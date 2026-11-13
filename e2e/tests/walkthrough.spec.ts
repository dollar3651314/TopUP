import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonl, decodeQP, MAILS, KYB_ENV, TMP } from '../stack.mjs';
// @ts-ignore 与后端同一份 TOTP 实现
import { totpCode, totpStep } from '../../server/kyb/totp.js';

// 页面走查：逐页、逐状态截图，并自动检查常见的显示问题。
// 注意：8094 端口用的是 site/dist，运行前先 `cd site && npm run build`，否则截到的是旧页面。
// 不属于日常测试，只在 WALKTHROUGH=1 时运行：  WALKTHROUGH=1 npx playwright test tests/walkthrough.spec.ts
// 截图和检查结果放在 WALKTHROUGH_OUT（默认 e2e/.tmp/walkthrough/）。
// 状态：空（新商户）→ 有数据（很多条、大额、小额、灰尘）→ 慢（接口延迟 25 秒）→ 出错（接口返回 500）；桌面 1280 和手机 390。

test.skip(!process.env.WALKTHROUGH, '页面走查只在 WALKTHROUGH=1 时运行');
const B = 'http://127.0.0.1:8094';
const U = 1_000_000;
const OUT = process.env.WALKTHROUGH_OUT || resolve(TMP, 'walkthrough');
const ADMIN_PW = 'walkthrough-admin-password';
const M_EMAIL = 'finance@walk.example', M_PW = 'walkthrough merchant pw';
const ADMIN_TABS = ['p-overview', 'apps', 'p-merchants', 'p-customers', 'p-sweep', 'p-withdrawals', 'p-anomalies', 'p-recon', 'p-wallet', 'p-status'];
const MERCHANT_TABS = ['overview', 'customers', 'orders', 'transactions', 'withdraw', 'api', 'callbacks'];

const lastStep: Record<string, number> = {};
async function code(secret: string) {
  for (;;) {
    for (const off of [0, 30_000]) { const c = totpCode(secret, Date.now() + off); const s = totpStep(secret, c, Date.now()); if (s > (lastStep[secret] || 0)) { lastStep[secret] = s; return c; } }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const mailsTo = (addr: string) => readJsonl(MAILS).filter((m: any) => m.to.includes(addr)).map((m: any) => decodeQP(m.raw));
const fake = (page: Page, path: string, body: unknown = {}) => page.request.post(`${B}/__fake/${path}/`, { data: body });
const tick = (page: Page) => page.request.get(`${B}/__fake/tick/`);
const post = (page: Page, url: string, body: unknown) => page.evaluate(async ([u, b]) => { const r = await fetch(u as string, { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body] as const);

// ---------- 自动检查 ----------
const findings: { shot: string; issue: string }[] = [];
const consoleErrors: Record<string, string[]> = {};
function watch(page: Page, who: string) {
  consoleErrors[who] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors[who].push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors[who].push(`pageerror: ${String(e).slice(0, 200)} @ ${page.url()} ${(e.stack || '').split('\n').slice(1, 3).join(' ')}`));
}
async function shot(page: Page, name: string) {
  const file = `${name}.png`;
  await page.screenshot({ path: resolve(OUT, file), fullPage: true });
  const r = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('pre, code, script, style').forEach((e) => e.remove()); // 文档里的示例代码可以有 undefined
    const text = clone.innerText || clone.textContent || '';
    const bad = ['NaN', 'undefined', 'Invalid Date', '[object Object]', 'null USDT', 'Infinity'].filter((w) => text.includes(w));
    const huge = (text.match(/\d{1,3}(,\d{3}){3,}\.\d{2}/g) || []).slice(0, 3); // 10 亿以上的金额，大概率是没转换
    const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    const emptyBadges = [...document.querySelectorAll<HTMLElement>('.badge')].filter((b) => b.offsetParent && !b.textContent!.trim()).length;
    const inScroller = (e: Element) => { for (let x = e.parentElement; x; x = x.parentElement) { const o = getComputedStyle(x).overflowX; if ((o === 'auto' || o === 'scroll') && x.scrollWidth > x.clientWidth + 1) return true; } return false; };
    // 横向滚动的导航和表格在手机上是有意的，不算"超出屏幕"
    const offscreen = [...document.querySelectorAll<HTMLElement>('button, a, input, select')].filter((e) => { const b = e.getBoundingClientRect(); return e.offsetParent && b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1) && !inScroller(e); }).length;
    // 桌面宽度下表格还要横向滚动才能看全（例如最后一列的按钮被挡住）
    const wideTables = window.innerWidth >= 1000 ? [...document.querySelectorAll<HTMLElement>('.table-scroll')].filter((x) => x.offsetParent && x.scrollWidth > x.clientWidth + 1).length : 0;
    // 当前显示的页面（后台的一个标签）是空白的：接口慢或出错时应该显示"加载中"或原因
    const panel = [...document.querySelectorAll<HTMLElement>('[data-panel], [data-mpanel]')].find((x) => x.offsetParent);
    const blank = !!panel && !panel.innerText.trim();
    return { bad, huge, overflow, emptyBadges, offscreen, wideTables, blank };
  });
  for (const w of r.bad) findings.push({ shot: file, issue: `页面文字里有 "${w}"` });
  for (const x of r.huge) findings.push({ shot: file, issue: `异常大的金额 ${x}` });
  if (r.overflow) findings.push({ shot: file, issue: '页面横向溢出' });
  if (r.emptyBadges) findings.push({ shot: file, issue: `${r.emptyBadges} 个空的数字圆圈` });
  if (r.offscreen) findings.push({ shot: file, issue: `${r.offscreen} 个按钮或输入框超出屏幕` });
  if (r.blank) findings.push({ shot: file, issue: '页面空白（没有内容，也没有"加载中"或出错原因）' });
  if (r.wideTables) findings.push({ shot: file, issue: `${r.wideTables} 个表格在桌面上要横向滚动才能看全` });
}
async function adminTab(page: Page, tab: string) { await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(600); }
async function merchantTab(page: Page, tab: string) { await page.click(`[data-mtab="${tab}"]`); await page.waitForTimeout(600); }

test.describe.serial('页面走查', () => {
  test.setTimeout(600_000);
  let actx: BrowserContext, mctx: BrowserContext, admin: Page, merchant: Page, adminSecret = '', merchantSecret = '';
  test.beforeAll(async ({ browser }) => {
    mkdirSync(OUT, { recursive: true });
    actx = await browser.newContext({ baseURL: B, viewport: { width: 1280, height: 900 } }); admin = await actx.newPage(); watch(admin, 'admin');
    mctx = await browser.newContext({ baseURL: B, viewport: { width: 1280, height: 900 } }); merchant = await mctx.newPage(); watch(merchant, 'merchant');
  });

  test('准备：后台、钱包、商户', async () => {
    await admin.goto('/admin/');
    await admin.fill('#s-token', KYB_ENV.ADMIN_SETUP_TOKEN); await admin.fill('#s-pw', ADMIN_PW); await admin.fill('#s-pw2', ADMIN_PW);
    await admin.click('[data-setup] button[type="submit"]');
    await expect(admin.locator('[data-setup2]')).toBeVisible();
    adminSecret = (await admin.locator('[data-secret]').textContent())!.replace(/\s/g, '');
    await admin.fill('#s-otp', await code(adminSecret)); await admin.click('[data-setup2] button[type="submit"]');
    await admin.fill('#a-pw', ADMIN_PW); await admin.fill('#a-otp', await code(adminSecret)); await admin.click('[data-login] button[type="submit"]');
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    // 钱包还没初始化时的各页面（空状态之一）
    for (const tab of ['p-overview', 'p-wallet', 'p-sweep']) { await adminTab(admin, tab); await shot(admin, `admin-0-uninit-${tab}`); }
    await adminTab(admin, 'p-wallet');
    await admin.click('text=初始化主助记词');
    const words = await admin.locator('.mnemonic li').allTextContents();
    await admin.click('[data-pdialog-ok]');
    for (const [i, n] of [3, 11, 20].entries()) await admin.fill(`#wi-${i}`, words[n - 1]);
    await admin.fill('#wi-code', await code(adminSecret));
    await admin.click('[data-pdialog-ok]');
    await expect(admin.locator('[data-pdialog]')).toContainText('初始化完成');
    await admin.click('[data-pdialog-ok]');
    const r = await post(admin, '/api/wallet/?a=merchant-open', { name: 'Walkthrough Trading Co., Ltd.', email: M_EMAIL, fee_in: { ppm: 10000, fixed: 0, min: 0 }, fee_out: { ppm: 0, fixed: 2 * U, min: 0 }, order_mode: { enabled: true, low: 900000, high: 1100000, ttlMin: 30, lookbackH: 24 } });
    expect(r.status).toBe(200);
    await expect.poll(() => mailsTo(M_EMAIL).length).toBeGreaterThan(0);
    const link = mailsTo(M_EMAIL)[0].match(/https?:\/\/[^\s]+\/merchant\/\?setup=[A-Za-z0-9_-]+/)![0].replace(/^https?:\/\/[^/]+/, B);
    await merchant.goto(link);
    await shot(merchant, 'merchant-0-setup');
    await merchant.fill('#ms-pw', M_PW); await merchant.fill('#ms-pw2', M_PW); await merchant.click('[data-setup] button[type="submit"]');
    await expect(merchant.locator('[data-setup-qr]')).toHaveAttribute('src', /^data:image\/png;base64,/); // 二维码出来后再读密钥
    merchantSecret = (await merchant.locator('[data-setup-secret]').textContent())!.trim();
    await shot(merchant, 'merchant-0-setup-totp');
    // 动态码刚好在 30 秒的边界上时会被拒绝：等下一个动态码再试（最多 3 次）
    for (let i = 0; i < 3 && !(await merchant.locator('[data-view="login"]').isVisible()); i++) {
      await merchant.fill('#ms-otp', await code(merchantSecret)); await merchant.click('[data-setup] button[type="submit"]');
      await merchant.waitForTimeout(1500);
    }
    await expect(merchant.locator('[data-view="login"]')).toBeVisible();
    await shot(merchant, 'merchant-0-login');
    for (let i = 0; i < 3 && !(await merchant.locator('[data-merchant-name]').isVisible()); i++) {
      await merchant.fill('#ml-em', M_EMAIL); await merchant.fill('#ml-pw', M_PW); await merchant.fill('#ml-otp', await code(merchantSecret));
      await merchant.click('[data-login] button[type="submit"]');
      await merchant.waitForTimeout(1500);
    }
    await expect(merchant.locator('[data-merchant-name]')).toBeVisible();
  });

  test('状态 1：空（新商户，没有任何数据）', async () => {
    await admin.goto('/admin/');
    for (const tab of ADMIN_TABS) { await adminTab(admin, tab); await shot(admin, `admin-1-empty-${tab}`); }
    await merchant.goto('/merchant/');
    for (const tab of MERCHANT_TABS) { await merchantTab(merchant, tab); await shot(merchant, `merchant-1-empty-${tab}`); }
  });

  test('准备数据：很多客户和订单、大额、小额、灰尘、提币、异常', async () => {
    const names = ['Lin Trading', '', 'A very long customer name that goes on and on, Limited Liability Company', '张三的贸易公司', 'O\'Brien & Sons <b>'];
    const custs: { id: string; address: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await post(merchant, '/api/merchant/?a=customer-save', { customer_id: `cust_${String(i).padStart(3, '0')}`, name: names[i % names.length], email: i % 3 ? `user${i}@example.com` : '' });
      expect(r.status).toBe(200);
      custs.push({ id: r.body.customer_id, address: r.body.address });
    }
    // 到账：普通、大额、小数很多、低于 1 USDT、灰尘
    const amounts = [100 * U, 1_234_567.89 * U, 12.345678 * U, 0.5 * U, 1, 999_999, 5000 * U];
    for (let i = 0; i < 40; i++) await fake(merchant, 'tron/pay', { to: custs[i].address, amount: Math.round(amounts[i % amounts.length]), time: Date.now() - (40 - i) * 60_000 });
    await tick(merchant);
    // 订单：55 个（等待付款、已完成、超额）
    for (let i = 0; i < 55; i++) {
      const r = await post(merchant, '/api/merchant/?a=order-create', { customer_id: custs[40 + (i % 20)].id, merchant_order_no: `WALK-${i}`, amount: String(10 + i) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    for (let i = 0; i < 6; i++) await fake(merchant, 'tron/pay', { to: custs[40 + i].address, amount: (10 + i) * U * (i % 2 ? 1.5 : 1), time: Date.now() - 1000 });
    await tick(merchant);
    // 提币申请
    const w = await post(merchant, '/api/merchant/?a=withdraw', { kind: 'payout', to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: '50', customer_id: 'cust_000', code: await code(merchantSecret) });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    await fake(merchant, 'daily');
  });

  test('状态 2：有数据（桌面）', async () => {
    await admin.goto('/admin/');
    for (const tab of ADMIN_TABS) { await adminTab(admin, tab); await shot(admin, `admin-2-full-${tab}`); }
    await merchant.goto('/merchant/');
    for (const tab of MERCHANT_TABS) { await merchantTab(merchant, tab); await shot(merchant, `merchant-2-full-${tab}`); }
    // 弹窗：订单详情、客户详情、创建订单
    await merchantTab(merchant, 'orders');
    await merchant.locator('[data-order]').first().click(); await merchant.waitForTimeout(500); await shot(merchant, 'merchant-2-dialog-order');
    await merchant.keyboard.press('Escape');
    await merchantTab(merchant, 'customers');
    await merchant.locator('[data-mpanel="customers"] tbody tr').first().click(); await merchant.waitForTimeout(500); await shot(merchant, 'merchant-2-dialog-customer');
    await merchant.keyboard.press('Escape');
    await merchantTab(merchant, 'orders');
    await merchant.click('[data-mpanel="orders"] .toolbar .btn-primary'); await merchant.fill('#mo-cust', 'cust'); await merchant.waitForTimeout(600); await shot(merchant, 'merchant-2-dialog-create-order');
    await merchant.keyboard.press('Escape'); await merchant.keyboard.press('Escape');
    // 付款页面：等待付款、找不到订单
    const orderNo = (await merchant.locator('[data-order]').first().getAttribute('data-order'))!;
    const pay = await mctx.newPage(); watch(pay, 'pay');
    await pay.goto(`/zh/pay/${orderNo}/`); await pay.waitForTimeout(800); await shot(pay, 'pay-2-order');
    await pay.goto('/zh/pay/ORD-20260101-00000000/'); await pay.waitForTimeout(800); await shot(pay, 'pay-2-notfound');
    await pay.goto('/zh/docs/'); await shot(pay, 'docs-2-zh');
    await pay.close();
  });

  test('状态 2：有数据（手机 390）', async () => {
    await admin.setViewportSize({ width: 390, height: 844 }); await merchant.setViewportSize({ width: 390, height: 844 });
    await admin.goto('/admin/');
    for (const tab of ADMIN_TABS) { await adminTab(admin, tab); await shot(admin, `admin-2m-full-${tab}`); }
    await merchant.goto('/merchant/');
    for (const tab of MERCHANT_TABS) { await merchantTab(merchant, tab); await shot(merchant, `merchant-2m-full-${tab}`); }
    await merchantTab(merchant, 'orders');
    await merchant.locator('[data-order]').first().click(); await merchant.waitForTimeout(500); await shot(merchant, 'merchant-2m-dialog-order');
    await merchant.keyboard.press('Escape');
    const orderNo = (await merchant.locator('[data-order]').first().getAttribute('data-order'))!;
    const pay = await mctx.newPage(); await pay.setViewportSize({ width: 390, height: 844 });
    await pay.goto(`/zh/pay/${orderNo}/`); await pay.waitForTimeout(800); await shot(pay, 'pay-2m-order');
    await pay.goto('/zh/docs/'); await shot(pay, 'docs-2m-zh');
    await pay.close();
    await admin.setViewportSize({ width: 1280, height: 900 }); await merchant.setViewportSize({ width: 1280, height: 900 });
  });

  // 开户页 4 个步骤，桌面和手机；空状态、校验出错、接口出错
  test('开户页：4 个步骤（桌面、手机）、校验出错、接口出错', async ({ browser }) => {
    // 每一轮用一份新的申请：填过第 ① 步的申请再打开时会直接到第 ② 步
    let n = 0;
    const newLink = async () => {
      const email = `walk-onboarding-${++n}@walk.example`;
      const r = await post(admin, '/api/kyb/?g=admin&a=invite', { company: 'Walkthrough Onboarding Co', email });
      expect(r.status).toBe(200);
      await expect.poll(() => mailsTo(email).length).toBeGreaterThan(0);
      return mailsTo(email).at(-1)!.match(/https?:\/\/[^\s]+\/onboarding\/\?t=[A-Za-z0-9_-]+/)![0].replace(/^https?:\/\/[^/]+/, B);
    };
    for (const [w, h, tag] of [[1280, 900, 'd'], [390, 844, 'm']] as const) {
      const ctx = await browser.newContext({ baseURL: B, viewport: { width: w, height: h } });
      const page = await ctx.newPage(); watch(page, `onboarding-${tag}`);
      for (const lang of ['', '/zh']) {
        const link = await newLink();
        await page.goto(`${B}${lang}${link.replace(B, '')}`);
        await expect(page.locator('#ob-form')).toBeVisible();
        // 前端校验会阻止跳到后面的步骤：逐个只显示一个步骤来截图（空状态）
        for (let i = 0; i < 4; i++) {
          await page.evaluate((n) => document.querySelectorAll<HTMLElement>('[data-step]').forEach((e) => (e.hidden = e.dataset.step !== String(n))), i);
          await shot(page, `onboarding-${tag}${lang.replace('/', '-')}-step${i + 1}-empty`);
        }
        // 校验出错：第 ① 步、第 ② 步不填直接下一步
        await page.goto(`${B}${lang}${link.replace(B, '')}`);
        await page.click('[data-next]'); await page.waitForTimeout(300);
        await shot(page, `onboarding-${tag}${lang.replace('/', '-')}-step1-errors`);
        // 填好第 ① 步，进入第 ② 步后不填直接下一步
        for (const [k, v] of Object.entries({ legalName: 'Walk Co', legalForm: 'Ltd', regNumber: '1', incDate: '2020-01-01', incPlace: 'SG', regAddress: 'a', physAddress: 'a', website: 'walk.example', email: 'a@walk.example', phone: '+65 1234 5678' })) await page.fill(`[name="entity.${k}"]`, v);
        for (const [k, v] of [['nature', 'export'], ['purpose', 'deposits'], ['volume', 'lt50k'], ['currencies', 'usdt'], ['markets', 'apac'], ['sanctions', 'no']]) await page.check(`[name="entity.${k}"][value="${v}"]`);
        await page.click('[data-next]');
        await expect(page.locator('[data-step="1"]')).toBeVisible();
        await page.click('[data-add-person]');
        await page.click('[data-next]'); await page.waitForTimeout(300);
        await shot(page, `onboarding-${tag}${lang.replace('/', '-')}-step2-errors`);
      }
      // 接口出错：打开页面时接口返回 500
      await page.route(/\/api\/kyb\//, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"server_error"}' }));
      await page.goto(await newLink()); await page.waitForTimeout(800);
      await shot(page, `onboarding-${tag}-4-error`);
      await ctx.close();
    }
  });

  test('状态 3：接口很慢（3 秒时的样子）和状态 4：接口出错', async () => {
    for (const [state, handler] of [
      ['3-slow', async (route: any) => { await new Promise((r) => setTimeout(r, 25_000)); await route.continue().catch(() => {}); }],
      ['4-error', async (route: any) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal_error', message: 'Internal error' } }) })],
    ] as const) {
      for (const [page, tabs, sel, who] of [[admin, ADMIN_TABS, 'data-tab', 'admin'], [merchant, MERCHANT_TABS, 'data-mtab', 'merchant']] as const) {
        await page.goto(who === 'admin' ? '/admin/' : '/merchant/');
        await page.waitForTimeout(1500);
        await page.route(/\/api\/(wallet|merchant|kyb)\//, handler as any);
        for (const tab of tabs) {
          await page.click(`[${sel}="${tab}"]`).catch(() => {});
          await page.waitForTimeout(state === '3-slow' ? 3000 : 800);
          await shot(page, `${who}-${state}-${tab}`);
        }
        await page.unroute(/\/api\/(wallet|merchant|kyb)\//);
      }
    }
  });

  test.afterAll(async () => {
    writeFileSync(resolve(OUT, 'findings.json'), JSON.stringify({ findings, consoleErrors }, null, 2));
    await actx.close(); await mctx.close();
  });
});
