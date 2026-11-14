import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readJsonl, decodeQP, MAILS, KYB_ENV, DATA_PAY, TMP } from '../stack.mjs';
// @ts-ignore 与后端同一份 TOTP 实现
import { totpCode, totpStep } from '../../server/kyb/totp.js';
import { legacyTron, legacyMnemonic } from './legacy-tron';

// 收付款端到端（正式构建、真实接口；数据库是内嵌 Postgres，链上用 TronGrid 替身）：
// 后台初始化 → 钱包初始化（浏览器生成助记词，只提交公钥）→ 开通商户 → 商户设置密码和验证码 → 登录
// → 客户、订单 → 模拟链上付款、两笔累计完成 → 开放 API（签名、先到账后建单）→ 提币：浏览器核对并签名 → 链上确认
// → 归集 3 步 → 付款页面 → 安全检查：数据库和日志里没有助记词、私钥。
const B = 'http://127.0.0.1:8094';
const U = 1_000_000;
const ADMIN_PW = 'e2e-pay-admin-password';
const M_EMAIL = 'finance@pay-e2e.example';
const M_PW = 'merchant e2e password';
const HOT_KEY = '11'.repeat(32); // 本地测试用的热钱包私钥（config/wallets.json 的 local.hot）
let adminSecret = '', merchantSecret = '';
let words: string[] = [];
let actx: BrowserContext, mctx: BrowserContext, admin: Page, merchant: Page;
let apiKey = '', apiSecret = '';
let orderNo = '', address = '';

// 同一个动态码不能用两次：每次取一个比上次更新的时间步（必要时等下一个 30 秒）
const lastStep: Record<string, number> = {};
async function code(secret: string) {
  for (;;) {
    for (const off of [0, 30_000]) {
      const c = totpCode(secret, Date.now() + off);
      const s = totpStep(secret, c, Date.now());
      if (s > (lastStep[secret] || 0)) { lastStep[secret] = s; return c; }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
/** 邮件正文：nodemailer 会按内容选 quoted-printable 或 base64 */
const mailText = (raw: string) => { const [head, ...rest] = raw.split('\r\n\r\n'); const body = rest.join('\r\n\r\n'); return /base64/i.test(head) ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : decodeQP(raw); };
const mailsTo = (addr: string) => readJsonl(MAILS).filter((m: any) => m.to.includes(addr)).map((m: any) => decodeQP(m.raw));
const fake = (page: Page, path: string, body: unknown = {}) => page.request.post(`${B}/__fake/${path}/`, { data: body });
// 代替 worker 立即跑一次定时任务（扫链、回调、提币和归集确认）
const tick = async (page: Page) => { const r = await page.request.get(`${B}/__fake/tick/`); expect(r.status()).toBe(200); return r.json(); };
const cspErrors = (page: Page) => { const errs: string[] = []; page.on('console', (m) => /Content Security Policy|Uncaught|TypeError/i.test(m.text()) && errs.push(m.text())); page.on('pageerror', (e) => errs.push(String(e))); return errs; };
async function api(page: Page, method: 'GET' | 'POST', path: string, body?: unknown) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = String(Math.floor(Date.now() / 1000));
  const p = `/api/v1/${path}`;
  const sig = createHmac('sha256', apiSecret).update([ts, method, p, createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
  const r = await page.request.fetch(`${B}${p}`, { method, data: raw || undefined, headers: { 'content-type': 'application/json', 'X-TopUP-Key': apiKey, 'X-TopUP-Timestamp': ts, 'X-TopUP-Signature': sig, ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) } });
  return { status: r.status(), body: await r.json() };
}
async function adminOk(page: Page) { await page.click('[data-pdialog-ok]'); }

// 金额全局检查：接口里的金额一律是字符串（例如 "20.00"）。数据库里存的是 0.000001 USDT 为单位的整数，
// 哪个字段漏了转换，页面就会把它当成 USDT 显示，放大 100 万倍。这里记录每个收付款接口的返回：
// 任何不在"数量类字段"名单里、却 ≥ 1,000,000 的整数都算漏转换（测试里的金额都 ≥ 1 USDT，漏转换时一定 ≥ 1,000,000）
const COUNT_KEYS = new Set(['count', 'customers', 'attempts', 'last_code', 'index', 'energy_left', 'energy_per_sweep', 'left', 'limit', 'per_sweep', 'db_bytes', 'used_mb', 'total_mb', 'ms', 'age_s', 'payout_count', 'checked', 'address_count', 'stage', 'cursor', 'number', 'time', 'at_ms',
  // 设置项：手续费规则（ppm、fixed、min）和订单模式（low、high）按内部单位传给页面，页面和服务器用同一份计算代码（lib/money.ts）
  'ppm', 'fixed', 'min', 'low', 'high']);
const rawAmounts: string[] = [];
function scanAmounts(url: string, v: unknown, path = '') {
  if (Array.isArray(v)) v.forEach((x, i) => scanAmounts(url, x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'number' && Number.isInteger(x) && Math.abs(x) >= 1_000_000 && !COUNT_KEYS.has(k)) rawAmounts.push(`${url.replace(B, '')} ${path}.${k} = ${x}`);
    else scanAmounts(url, x, `${path}.${k}`);
  }
}
function watchAmounts(page: Page) {
  page.on('response', async (r) => {
    if (!/\/api\/(wallet|merchant|v1|pay)\//.test(r.url()) || !(r.headers()['content-type'] || '').includes('json')) return;
    try { scanAmounts(r.url(), await r.json()); } catch { /* 非 JSON */ }
  });
}

test.describe.serial('TC-P 收付款（正式接口）', () => {
  // 同一个动态码不能用两次，测试里有时要等下一个 30 秒的动态码
  test.setTimeout(120_000);
  test.beforeAll(async ({ browser }) => {
    actx = await browser.newContext({ baseURL: B }); admin = await actx.newPage();
    mctx = await browser.newContext({ baseURL: B }); merchant = await mctx.newPage();
    watchAmounts(admin); watchAmounts(merchant);
  });
  test.afterAll(async () => { await actx.close(); await mctx.close(); });

  test('TC-P01 后台初始化并登录；钱包设置：旧地址的主助记词（第 0 批，服务器只有公钥）照常可用，没有"初始化主助记词"', async () => {
    const errs = cspErrors(admin);
    await admin.goto('/admin/');
    await admin.fill('#s-token', KYB_ENV.ADMIN_SETUP_TOKEN); await admin.fill('#s-pw', ADMIN_PW); await admin.fill('#s-pw2', ADMIN_PW);
    await admin.click('[data-setup] button[type="submit"]');
    await expect(admin.locator('[data-setup2]')).toBeVisible();
    adminSecret = (await admin.locator('[data-secret]').textContent())!.replace(/\s/g, '');
    await admin.fill('#s-otp', totpCode(adminSecret, Date.now()));
    await admin.click('[data-setup2] button[type="submit"]');
    await expect(admin.locator('[data-view="login"]')).toBeVisible();
    await admin.fill('#a-pw', ADMIN_PW); await admin.fill('#a-otp', await code(adminSecret));
    await admin.click('[data-login] button[type="submit"]');
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    // Q-A1：后台不再提供"初始化主助记词"。旧地址（第 0 批）的主助记词在旧系统里早已初始化：
    // 测试进程生成助记词、只把账户级公钥写进旧数据（服务器只有公钥），后面 TC-P06 归集旧地址时在页面里输入助记词签名
    // B1（2026-11-14）：全新系统（还没初始化、也没有任何客户）也不出现"初始化主助记词"
    await admin.click('[data-tab="p-wallet"]');
    const wpanel = admin.locator('[data-panel="p-wallet"]');
    await expect(wpanel.locator('[data-wallet-card="tron"]')).toBeVisible();
    expect((await admin.evaluate(async () => (await fetch('/api/wallet/?a=wallet')).json())).initialized).toBe(false); // 先确认到了"全新系统"这个状态
    await expect(wpanel).not.toContainText('初始化主助记词');
    const legacy = await legacyMnemonic(admin, B);
    words = legacy.words;
    expect(words).toHaveLength(24);
    await admin.reload();
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    await admin.click('[data-tab="p-wallet"]');
    await expect(wpanel.locator('[data-wallet-card="tron"] [data-legacy-addresses]')).toContainText('照常归集');
    await expect(wpanel).not.toContainText('初始化主助记词');
    // 服务器认的是这份旧公钥：第 1 个地址和测试自己用助记词推出来的一致
    const w = await admin.evaluate(async () => (await fetch('/api/wallet/?a=wallet')).json());
    expect(w.initialized).toBe(true);
    expect(w.first_address).toBe(legacy.firstAddress);
    // 导航上的数字：没有数据时也显示 0，不出现空圆圈
    for (const k of ['merchants', 'withdrawals', 'anomalies']) await expect(admin.locator(`[data-pcount="${k}"]`)).toHaveText(/^\d+$/);
    expect(errs).toEqual([]);
  });

  test('TC-P02 开通商户 → 邮件 → 设置密码和验证码 → 登录', async () => {
    const r = await admin.evaluate(async (email) => (await fetch('/api/wallet/?a=merchant-open', { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify({ name: 'Pay E2E Ltd', email, fee_in: { ppm: 10000, fixed: 0, min: 0 }, fee_out: { ppm: 0, fixed: 2000000, min: 0 }, order_mode: { enabled: true, low: 900000, high: 1100000, ttlMin: 30, lookbackH: 24 } }) })).status, M_EMAIL);
    expect(r).toBe(200);
    await expect.poll(() => mailsTo(M_EMAIL).length).toBeGreaterThan(0);
    const link = mailsTo(M_EMAIL)[0].match(/https?:\/\/[^\s]+\/merchant\/\?setup=[A-Za-z0-9_-]+/)![0].replace(/^https?:\/\/[^/]+/, B);
    const errs = cspErrors(merchant);
    await merchant.goto(link);
    await merchant.fill('#ms-pw', M_PW); await merchant.fill('#ms-pw2', M_PW);
    await merchant.click('[data-setup] button[type="submit"]');
    await expect(merchant.locator('[data-setup-qr]')).toHaveAttribute('src', /^data:image\/png;base64,/);
    merchantSecret = (await merchant.locator('[data-setup-secret]').textContent())!.trim();
    await merchant.fill('#ms-otp', await code(merchantSecret));
    await merchant.click('[data-setup] button[type="submit"]');
    await expect(merchant.locator('[data-view="login"]')).toBeVisible();
    await merchant.fill('#ml-em', M_EMAIL); await merchant.fill('#ml-pw', M_PW); await merchant.fill('#ml-otp', await code(merchantSecret));
    await merchant.click('[data-login] button[type="submit"]');
    await expect(merchant.locator('[data-merchant-name]')).toHaveText('Pay E2E Ltd');
    // 空状态
    await expect(merchant.locator('[data-mpanel="overview"] .stat .v').first()).toHaveText('0.00');
    await expect(merchant.locator('[data-mpanel="overview"]')).toContainText('暂无');
    expect(errs).toEqual([]);
  });

  test('TC-P03 创建订单 → 模拟链上两笔付款 → 累计达到下限自动完成', async () => {
    // K1：新客户不生成地址、第 1 批不提供新的 TRON 地址；这条 TRON 收款流程用已有 TRON 地址的老客户
    address = await legacyTron(admin, B, 'Pay E2E Ltd', 'buyer_1', 'Buyer One');
    await merchant.click('[data-mtab="orders"]');
    await merchant.click('[data-mpanel="orders"] .toolbar .btn-primary');
    await merchant.fill('#mo-cust', 'buyer_1');
    await expect(merchant.locator('#mo-cust-list .picker-opt').first()).toContainText('buyer_1');
    await merchant.press('#mo-cust', 'ArrowDown'); await merchant.press('#mo-cust', 'Enter');
    await expect(merchant.locator('#mo-cname')).toHaveValue('Buyer One');
    await merchant.fill('#mo-amt', '100');
    await merchant.click('[data-mdialog-ok]');
    await expect(merchant.locator('[data-mdialog]')).toContainText('等待付款');
    // K1：不指定链的订单创建时不带地址（付款人在付款页选链后再给），这里不从弹窗里读地址；用老客户已有的 TRON 地址付款
    expect(address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    orderNo = (await merchant.locator('[data-mdialog-title]').textContent())!.match(/ORD-\d{8}-[0-9A-F]{8}/)![0];
    await merchant.keyboard.press('Escape');
    await fake(merchant, 'tron/pay', { to: address, amount: 60 * U });
    await tick(merchant);
    await fake(merchant, 'tron/pay', { to: address, amount: 35 * U });
    await tick(merchant);
    await merchant.click('[data-mtab="orders"]');
    await expect(merchant.locator(`[data-order="${orderNo}"]`)).toContainText('已完成');
    await merchant.click('[data-mtab="overview"]');
    await expect(merchant.locator('[data-mpanel="overview"] .stat .v').first()).toHaveText('94.05'); // 95 − 1% 收款费
    // 付款页面（正式接口）显示付款成功
    const pay = await mctx.newPage();
    await pay.goto(`/zh/pay/${orderNo}/`);
    await expect(pay.locator('[data-pay-result-title]')).toHaveText('付款成功');
    await pay.close();
  });

  test('TC-P09 创建订单的客户选择：按编号、名称、邮箱模糊搜索；选中已有客户带出名称和邮箱；可以新建客户', async () => {
    const saved = await merchant.evaluate(async () => (await fetch('/api/merchant/?a=customer-save', { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify({ customer_id: 'vip_77', name: 'Harbor Trading', email: 'Ops@Harbor.example' }) })).status);
    expect(saved).toBe(200);
    await merchant.click('[data-mtab="orders"]');
    await merchant.click('[data-mpanel="orders"] .toolbar .btn-primary');
    const input = merchant.locator('#mo-cust'), list = merchant.locator('#mo-cust-list');
    // 按邮箱搜索（邮箱加密保存，服务端解密后比对），不区分大小写
    await input.fill('ops@harbor');
    await expect(list.locator('.picker-opt').first()).toContainText('vip_77');
    // 列表就在输入框正下方（不再跑偏）
    const ib = (await input.boundingBox())!, lb = (await list.boundingBox())!;
    expect(Math.abs(lb.x - ib.x)).toBeLessThan(2);
    expect(lb.y - (ib.y + ib.height)).toBeGreaterThanOrEqual(0);
    expect(lb.y - (ib.y + ib.height)).toBeLessThan(10);
    // 按名称搜索，用键盘选中
    await input.fill('harbor trad');
    await expect(list.locator('.picker-opt').first()).toContainText('vip_77');
    await input.press('ArrowDown'); await input.press('Enter');
    await expect(input).toHaveValue('vip_77');
    await expect(merchant.locator('#mo-cname')).toHaveValue('Harbor Trading');
    await expect(merchant.locator('#mo-cemail')).toHaveValue('Ops@Harbor.example');
    await expect(merchant.locator('#mo-cname')).toHaveJSProperty('readOnly', true);
    // 按编号搜索；列表显示已有客户 buyer_1（TC-P03 创建）
    await input.fill('buyer');
    await expect(list.locator('.picker-opt').first()).toContainText('buyer_1');
    // 新的编号：列表最后一项是"新建客户"；名称和邮箱清空、可以填写
    await input.fill('brand_new_1');
    await expect(list.locator('.picker-new')).toContainText('brand_new_1');
    await list.locator('.picker-new').click();
    await expect(merchant.locator('#mo-cname')).toHaveValue('');
    await expect(merchant.locator('#mo-cname')).toHaveJSProperty('readOnly', false);
    await expect(merchant.locator('[data-mdialog]')).toContainText('新客户');
    // Esc 只关闭列表，不关闭弹窗
    await input.fill('brand'); await expect(list).toBeVisible(); await input.press('Escape');
    await expect(list).toBeHidden();
    await expect(merchant.locator('[data-mdialog]')).toBeVisible();
    await merchant.keyboard.press('Escape');
  });

  test('TC-P04 开放 API：签名、先到账后建单、商户隔离', async () => {
    await merchant.click('[data-mtab="api"]');
    await merchant.click('text=重新生成 Secret');
    await merchant.fill('#mapi-code', await code(merchantSecret));
    await merchant.click('[data-mdialog-ok]');
    const kv = merchant.locator('[data-mdialog] dd .mono');
    apiKey = (await kv.nth(0).textContent())!.trim(); apiSecret = (await kv.nth(1).textContent())!.trim();
    expect(apiKey).toMatch(/^topup_test_/);
    await merchant.click('[data-mdialog-ok]');
    // 未签名的请求
    expect((await merchant.request.get(`${B}/api/v1/balance/`)).status()).toBe(401);
    expect((await api(merchant, 'GET', 'balance/')).body.available).toBe('94.05');
    // 客户 buyer_2 先付款，再建订单：自动匹配
    await legacyTron(admin, B, 'Pay E2E Ltd', 'buyer_2'); // K1：TRON 到账用已有 TRON 地址的老客户
    const c = (await api(merchant, 'POST', 'customers/', { customer_id: 'buyer_2', name: 'Buyer Two' })).body;
    await fake(merchant, 'tron/pay', { to: c.address, amount: 49 * U });
    await tick(merchant);
    const o = (await api(merchant, 'POST', 'orders/', { customer_id: 'buyer_2', merchant_order_no: 'API-1', amount: '50' })).body;
    expect(o.status).toBe('completed');
    expect(o.deposits[0].matched_by).toBe('order');
    const st = (await api(merchant, 'GET', 'customers/stats/?customer_id=buyer_2')).body;
    expect([st.total, st.count]).toEqual(['49.00', 1]);
    // 开发者文档里的签名示例，原样运行（只把接口地址换成本地）
    const env = { ...process.env, TOPUP_KEY: apiKey, TOPUP_SECRET: apiSecret };
    const node = execFileSync(process.execPath, [join(TMP, '../../site/src/docs/sign-request.mjs')], { env: { ...env, TOPUP_BASE: `${B}/api/v1/` }, encoding: 'utf8' });
    expect(node.trim()).toMatch(/\/pay\/ORD-\d{8}-[0-9A-F]{8}\/$/);
    const py = execFileSync('python3', [join(TMP, '../../site/src/docs/sign_request.py')], { env: { ...env, TOPUP_BASE_URL: B }, encoding: 'utf8' });
    expect(py).toContain("'available': '142.56'"); // 94.05 + 49 × 99%
  });

  test('TC-P05 提币：商户提交 → 后台浏览器核对并签名 → 链上确认后完成', async () => {
    await merchant.click('[data-mtab="withdraw"]');
    // 第 3 批：先选"代付"，再选链（TRON），收款地址填在代付的地址框
    await merchant.locator('input[name="wd-kind"][value="payout"]').check();
    await merchant.selectOption('#mw-chain', 'tron');
    await merchant.fill('#mw-pay-to', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'); await merchant.fill('#mw-amt', '50'); await merchant.fill('#mw-cust', 'buyer_1');
    await merchant.fill('#mw-code', await code(merchantSecret));
    await merchant.click('.wd-form button[type="submit"]');
    await expect(merchant.locator('[data-mpanel="withdraw"]')).toContainText('待审核');
    await tick(merchant);
    await expect.poll(() => readJsonl(MAILS).some((m: any) => /请到运营后台审核/.test(mailText(m.raw)))).toBe(true);
    // 热钱包有足够的 USDT（替身）
    const hot = JSON.parse(readFileSync(new URL('../../config/wallets.json', import.meta.url), 'utf8')).local.hot;
    await fake(admin, 'tron/account', { address: hot, account: { activated: true, trx: 100 * U, trc20: { TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: 1000 * U } } });
    await admin.click('[data-tab="p-withdrawals"]');
    // 第 3 批：先逐笔审核（打开这一笔 → 通过），再到 TRON 卡片"核对并签名"
    await admin.locator('[data-panel="p-withdrawals"] [data-payout-row]').first().click();
    await expect(admin.locator('[data-pdialog]')).toContainText('50.00 USDT');
    await adminOk(admin);
    await expect(admin.locator('[data-pdialog]')).not.toBeVisible();
    await expect(admin.locator('[data-panel="p-withdrawals"] [data-payout-row]')).toHaveCount(0);
    await admin.click('[data-panel="p-withdrawals"] [data-payout-sign="tron"]');
    await expect(admin.locator('[data-pdialog]')).toContainText('✓ 一致');
    await admin.fill('#ps-code', await code(adminSecret));
    await admin.fill('#ps-hot', '22'.repeat(32)); // 不是热钱包的私钥：页面拦下
    await adminOk(admin);
    await expect(admin.locator('[data-pdialog]')).toContainText('不是热钱包');
    await admin.fill('#ps-hot', HOT_KEY);
    await adminOk(admin);
    await expect(admin.locator('[data-pdialog]')).not.toBeVisible();
    await expect(admin.locator('#ps-hot')).toHaveValue(''); // 签名后私钥已从输入框清除
    await fake(admin, 'tron/confirm-all');
    await tick(admin);
    await merchant.click('[data-mtab="withdraw"]');
    await expect(merchant.locator('[data-mpanel="withdraw"] tbody tr').first()).toContainText('已完成');
  });

  test('TC-P06 归集：助记词 + 热钱包私钥签名；借出能量 → 转出 USDT → 收回能量', async () => {
    await fake(admin, 'tron/account', { address, account: { activated: true, trx: 0, trc20: { TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: 95 * U } } });
    await admin.click('[data-tab="p-sweep"]');
    await admin.fill('[data-panel="p-sweep"] .toolbar input', '1'); await admin.press('[data-panel="p-sweep"] .toolbar input', 'Enter');
    const row = admin.locator('[data-panel="p-sweep"] tbody tr', { hasText: 'buyer_1' });
    await row.locator('input[type=checkbox]').check();
    await admin.click('[data-panel="p-sweep"] .sumbar .btn-primary');
    const dlg = admin.locator('[data-pdialog]');
    await expect(dlg).toContainText('借出能量');
    await expect(dlg).not.toContainText('✗');
    await admin.fill('#ps-code', await code(adminSecret));
    await admin.fill('#ps-mn', words.join(' '));
    await admin.fill('#ps-hot', HOT_KEY);
    await adminOk(admin);
    await expect(dlg).not.toBeVisible();
    for (let i = 0; i < 3; i++) { await fake(admin, 'tron/confirm-all'); await tick(admin); }
    const rows = await (await admin.request.post(`${B}/__fake/sql/`, { data: { sql: "select status from sign_batches where kind = 'sweep'" } })).json();
    expect(rows[0].status).toBe('done');
  });

  test('TC-P08 所有弹窗：在弹窗上滚动鼠标滚轮，背景页面不跟着滚动', async () => {
    for (const [page, path] of [[admin, '/admin/'], [merchant, '/merchant/']] as const) {
      await page.goto(path);
      await page.waitForLoadState('networkidle'); // 页面自己的加载（可能会打开或关闭弹窗）结束后再测
      const dialogs = await page.locator('dialog').count();
      expect(dialogs).toBeGreaterThan(0);
      for (let i = 0; i < dialogs; i++) {
        await page.evaluate((i) => {
          document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((d) => d.close()); // 每次只打开要测的这一个
          document.body.style.minHeight = '5000px'; // 保证背景页面可以滚动
          window.scrollTo({ top: 100, behavior: 'instant' }); // 页面开启了平滑滚动，这里要立即到位
          const d = document.querySelectorAll('dialog')[i] as HTMLDialogElement;
          d.style.minHeight = '200px';
          d.showModal();
        }, i);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(100);
        const before = await page.evaluate(() => window.scrollY);
        const box = (await page.locator('dialog').nth(i).boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let k = 0; k < 5; k++) await page.mouse.wheel(0, 800);
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => window.scrollY);
        expect(after, `${path} 第 ${i + 1} 个弹窗`).toBe(before);
        await page.evaluate((i) => { (document.querySelectorAll('dialog')[i] as HTMLDialogElement).close(); document.body.style.minHeight = ''; }, i);
      }
    }
  });

  test('TC-P10 所有后台页面的金额：逐个打开运营后台和商户后台的每个页面，接口里没有漏转换的金额', async () => {
    // 先准备数据：新客户收到一笔 20.000001 USDT（未归集），热钱包有 USDT 和 TRX（钱包设置、提币审核会显示）
    await legacyTron(admin, B, 'Pay E2E Ltd', 'amount_check_1'); // K1：TRON 到账用已有 TRON 地址的老客户
    const c = await api(merchant, 'POST', 'customers/', { customer_id: 'amount_check_1' });
    expect(c.status).toBe(200);
    await fake(admin, 'tron/pay', { to: c.body.address, amount: 20 * U });
    await fake(admin, 'tron/pay', { to: c.body.address, amount: 1 }); // 0.000001 USDT 的灰尘转账
    await fake(admin, 'tron/account', { address: 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ', account: { activated: true, trx: 500 * U, trc20: { TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: 3000 * U } } });
    await tick(admin);
    await fake(admin, 'daily');
    await admin.goto('/admin/');
    // 登录后默认打开"概览"
    await expect(admin.locator('[data-panel="p-overview"]')).toBeVisible();
    await expect(admin.locator('[data-panel="p-overview"]')).toContainText('现在就能转走的利润');
    await expect(admin.locator('[data-panel="p-overview"]')).toContainText('欠商户');
    for (const tab of ['p-overview', 'p-merchants', 'p-customers', 'p-sweep', 'p-withdrawals', 'p-anomalies', 'p-recon', 'p-wallet', 'p-status']) {
      await admin.click(`[data-tab="${tab}"]`);
      await expect(admin.locator(`[data-panel="${tab}"] .alert`)).toHaveCount(0);
      await admin.waitForLoadState('networkidle');
    }
    // 客户页的"未归集"、对账的合计，显示的是正常的金额（不是放大 100 万倍）
    await admin.click('[data-tab="p-customers"]');
    await expect(admin.locator('[data-panel="p-customers"]')).toContainText('20.000001');
    await expect(admin.locator('[data-panel="p-customers"]')).not.toContainText(/\d{1,3}(,\d{3}){2,}\.\d{2}/);
    await admin.click('[data-tab="p-wallet"]');
    await expect(admin.locator('[data-panel="p-wallet"]')).toContainText('3,000.00');
    await admin.click('[data-tab="p-recon"]');
    await expect(admin.locator('[data-panel="p-recon"]')).not.toContainText(/\d{1,3}(,\d{3}){2,}\.\d{2}/);
    // 立即对账（测试环境没有每天的自动任务）
    await admin.locator('[data-panel="p-recon"] .toolbar button', { hasText: '立即对账' }).click();
    await expect(admin.locator('[data-toast]')).toContainText('对账完成');
    await expect(admin.locator('[data-panel="p-recon"] tbody').first()).toContainText(new Date().toISOString().slice(0, 10));
    // 归集：地址都低于筛选金额时，说明有多少个地址被筛掉了
    // 归集页前面已经打开过：点标签会重新读取并整页重画。先等这次读取的两个接口都返回；
    // 万一填值时正好重画，值会写进已移除的旧输入框，所以"填值、回车、检查"整体重试，直到在稳定的页面上生效
    const sweepLoaded = Promise.all([admin.waitForResponse(/a=sweep-list/), admin.waitForResponse(/a=batches/)]);
    await admin.click('[data-tab="p-sweep"]');
    await sweepLoaded;
    await expect(async () => {
      const minInput = admin.locator('[data-panel="p-sweep"] .toolbar input');
      await minInput.fill('100000');
      await minInput.press('Enter');
      await expect(admin.locator('[data-panel="p-sweep"]')).toContainText(/有 \d+ 个地址低于 100000 USDT/, { timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    // 低于 1 USDT 的到账：运营后台的异常到账里有，商户后台看不到（不结算给商户）
    await admin.click('[data-tab="p-anomalies"]');
    await expect(admin.locator('[data-panel="p-anomalies"]')).toContainText('0.000001');
    await merchant.goto('/merchant/');
    await merchant.click('[data-mtab="transactions"]');
    await expect(merchant.locator('[data-mpanel="transactions"]')).toContainText('amount_check_1');
    await expect(merchant.locator('[data-mpanel="transactions"]')).not.toContainText('0.000001');
    await expect(merchant.locator('[data-mpanel="transactions"]')).not.toContainText('低于 1 USDT');
    const csv = await merchant.evaluate(async () => (await fetch('/api/merchant/?a=export&type=deposits')).text());
    expect(csv).toContain('amount_check_1');
    expect(csv).not.toContain('0.000001');
    for (const tab of ['overview', 'customers', 'orders', 'transactions', 'withdraw', 'api', 'callbacks']) {
      await merchant.click(`[data-mtab="${tab}"]`);
      await merchant.waitForLoadState('networkidle');
    }
    expect(rawAmounts, '接口返回了没有转换的金额（整数）').toEqual([]);
  });

  test('TC-P07 安全：数据库和服务器日志里没有助记词和私钥', async () => {
    const dump = await (await admin.request.post(`${B}/__fake/sql/`, { data: { sql: `select string_agg(t::text, ' ') s from (
      select row_to_json(x)::text t from pay_meta x union all select row_to_json(x)::text from sign_batches x union all select row_to_json(x)::text from pay_audit x
      union all select row_to_json(x)::text from customers x union all select row_to_json(x)::text from callbacks x) q` } })).json();
    const text = String(dump[0].s);
    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain(HOT_KEY);
    expect(text).not.toContain(words.slice(0, 4).join(' '));
    expect(text).not.toContain(words.join(' '));
    const log = readFileSync(join(TMP, 'web-8094.log'), 'utf8');
    expect(log).not.toContain(HOT_KEY);
    expect(log).not.toContain(words.slice(0, 4).join(' '));
    // 数据目录里的任何文件都不包含私钥
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk(DATA_PAY)) expect(readFileSync(f).includes(Buffer.from(HOT_KEY))).toBe(false);
  });

  test('TC-P11 TRON 打款签名窗口：交签名返回 duplicate_txid（一批里两笔交易号相同）时，提示"作废这一批、重新凑批"，不是"稍后重试"', async () => {
    // 商户再提一笔 TRON 代付 → 逐笔审核 → TRON 卡片"核对并签名"；交签名的接口用替身返回 409 duplicate_txid
    await merchant.click('[data-mtab="withdraw"]');
    await merchant.locator('input[name="wd-kind"][value="payout"]').check();
    await merchant.selectOption('#mw-chain', 'tron');
    await merchant.fill('#mw-pay-to', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'); await merchant.fill('#mw-amt', '5'); await merchant.fill('#mw-cust', 'buyer_dup');
    await merchant.fill('#mw-code', await code(merchantSecret));
    await merchant.click('.wd-form button[type="submit"]');
    await expect(merchant.locator('[data-mpanel="withdraw"] tbody tr').first()).toContainText('buyer_dup'); // 商户页这时可能是英文，按客户编号认这一笔
    const [w] = await (await admin.request.post(`${B}/__fake/sql/`, { data: { sql: `select id from withdrawals where customer_id = 'buyer_dup' order by created_at desc limit 1` } })).json();
    const hot = JSON.parse(readFileSync(new URL('../../config/wallets.json', import.meta.url), 'utf8')).local.hot;
    await fake(admin, 'tron/account', { address: hot, account: { activated: true, trx: 100 * U, trc20: { TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: 1000 * U } } });
    await admin.click('[data-tab="p-withdrawals"]');
    await admin.locator('[data-panel="p-withdrawals"] [data-payout-row]').first().click();
    await expect(admin.locator('[data-pdialog]')).toContainText('5.00 USDT');
    await adminOk(admin);
    await expect(admin.locator('[data-pdialog]')).not.toBeVisible();
    const dup = /\/api\/wallet\/\?a=sign-submit/;
    let hit = 0;
    await admin.route(dup, (route) => { hit++; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'duplicate_txid', message: 'duplicate_txid' } }) }); });
    await admin.click('[data-panel="p-withdrawals"] [data-payout-sign="tron"]');
    await expect(admin.locator('[data-pdialog]')).toContainText('✓ 一致');
    await admin.fill('#ps-code', await code(adminSecret));
    await admin.fill('#ps-hot', HOT_KEY);
    await adminOk(admin);
    await expect.poll(() => hit, { message: '前提：页面交了签名（拿到替身的 duplicate_txid）' }).toBe(1);
    const msg = admin.locator('[data-toast]');
    await expect(msg).toContainText('作废');
    await expect(msg).toContainText('重');
    await expect(msg).not.toContainText('稍后');
    await expect(msg).not.toContainText('duplicate_txid');
    await admin.unroute(dup);
    await expect(admin.locator('#ps-hot')).toHaveValue(''); // 出错也清空私钥
    // 收尾：作废这一批、驳回这一笔（退冻结），不影响后面的用例
    const post = (a: string, body: unknown) => admin.evaluate(async ([a, body]) => (await fetch(`/api/wallet/?a=${a}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify(body) })).status, [a, body] as const);
    const [pb] = await (await admin.request.post(`${B}/__fake/sql/`, { data: { sql: `select batch_id from withdrawals where id = '${w.id}'` } })).json();
    if (pb.batch_id) expect(await post('payout-void', { id: pb.batch_id })).toBe(200);
    expect(await post('payout-reject-approved', { id: w.id, reason: '测试收尾' })).toBe(200);
  });
});
