import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonl, decodeQP, MAILS, KYB_ENV, TMP } from '../stack.mjs';
// @ts-ignore 与后端同一份 TOTP 实现
import { totpCode, totpStep } from '../../server/kyb/totp.js';

// 钱包第 1 批页面端到端（以太坊、BSC 合约钱包；正式构建、真实接口，8096 端口的独立实例）：
// 归集（凑批 → 确认三步 → 链上确认；BSC 超每批上限拆批；超每地址上限跳过；确认失败的提示；部分成功、失败）、
// 概览"待处理"、钱包提供方、系统状态每条链一张卡、商户客户的多链地址、订单选链、付款页先选网络和出错提示。
// 链上用 ETH、BSC 内存替身（/__fake/evm/pay/ 模拟一笔已确认的转账），/__fake/tick/ 代替 worker；
// 接口出错、"另一个窗口"用浏览器拦截接口模拟；部分成功、失败的批次用 /__fake/sql/ 改状态（只在本地有）。
// 用例之间要共享的东西（登录状态、地址、批次号、订单号）存在 .tmp/wallet-e2e.json：一个用例失败后 Playwright 换新进程，
// 后面的用例照样能跑（一个红的不挡住别的）。
const B = 'http://127.0.0.1:8096';
const U = 1_000_000;
const ADMIN_PW = 'e2e-wallet-admin-password';
const M_EMAIL = 'finance@wallet-e2e.example';
const M_PW = 'wallet e2e merchant password';
const STATE = resolve(TMP, 'wallet-e2e.json');
const ASTATE = resolve(TMP, 'wallet-e2e-admin.json'), MSTATE = resolve(TMP, 'wallet-e2e-merchant.json');
type St = { adminSecret: string; merchantSecret: string; ev: Record<string, string>; sw: { eth: string[]; bsc: string[] }; orderAny: string; orderBsc: string };
const st: St = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { adminSecret: '', merchantSecret: '', ev: {}, sw: { eth: [], bsc: [] }, orderAny: '', orderBsc: '' };
const save = () => writeFileSync(STATE, JSON.stringify(st));

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
const mailsTo = (addr: string) => readJsonl(MAILS).filter((m: any) => m.to.includes(addr)).map((m: any) => decodeQP(m.raw));
async function adminOk(page: Page) { await page.click('[data-pdialog-ok]'); }

test.describe('TC-W 钱包第 1 批页面（以太坊、BSC）', () => {
  test.setTimeout(180_000);
  let actx: BrowserContext, mctx: BrowserContext, admin: Page, merchant: Page;
  test.beforeAll(async ({ browser }) => {
    actx = await browser.newContext({ baseURL: B, ...(existsSync(ASTATE) ? { storageState: ASTATE } : {}) }); admin = await actx.newPage();
    mctx = await browser.newContext({ baseURL: B, ...(existsSync(MSTATE) ? { storageState: MSTATE } : {}) }); merchant = await mctx.newPage();
    await admin.goto('/admin/'); await merchant.goto('/zh/merchant/');
  });
  test.afterEach(() => save());
  test.afterAll(async () => { await actx?.close(); await mctx?.close(); });

  const tick = async (page: Page) => { const r = await page.request.get(`${B}/__fake/tick/`); expect(r.status()).toBe(200); return r.json(); };
  const sql = async (q: string) => (await admin.request.post(`${B}/__fake/sql/`, { data: { sql: q } })).json();
  const mcall = (a: string, body?: unknown, qs = '') => merchant.evaluate(async ([a, body, qs]) => {
    const r = await fetch(`/api/merchant/?a=${a}${qs}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, [a, body, qs] as const);
  const wcall = (a: string, body?: unknown) => admin.evaluate(async ([a, body]) => {
    const r = await fetch(`/api/wallet/?a=${a}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, [a, body] as const);
  const isWallet = (name: string) => (url: URL) => url.pathname === '/api/wallet/' && url.searchParams.get('a') === name;
  async function adminTab(tab: string) {
    if (!(await admin.locator('[data-view="app"]').isVisible())) await admin.goto('/admin/');
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    await admin.click(`[data-tab="${tab}"]`);
    await expect(admin.locator(`[data-panel="${tab}"]`)).toBeVisible();
    await expect(admin.locator(`[data-panel="${tab}"] [data-loading]`)).toHaveCount(0);
  }
  const usdtOf = (s: string) => Number(s.replace(/[^\d.]/g, ''));

  test('TC-W00 准备：后台初始化并登录、初始化 TRON 主助记词（现在新建客户仍要它，见说明）；开通商户 → 设置密码和验证码 → 登录', async () => {
    await admin.goto('/admin/');
    await admin.fill('#s-token', KYB_ENV.ADMIN_SETUP_TOKEN); await admin.fill('#s-pw', ADMIN_PW); await admin.fill('#s-pw2', ADMIN_PW);
    await admin.click('[data-setup] button[type="submit"]');
    await expect(admin.locator('[data-setup2]')).toBeVisible();
    st.adminSecret = (await admin.locator('[data-secret]').textContent())!.replace(/\s/g, '');
    await admin.fill('#s-otp', totpCode(st.adminSecret, Date.now()));
    await admin.click('[data-setup2] button[type="submit"]');
    await expect(admin.locator('[data-view="login"]')).toBeVisible();
    await admin.fill('#a-pw', ADMIN_PW); await admin.fill('#a-otp', await code(st.adminSecret));
    await admin.click('[data-login] button[type="submit"]');
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    await actx.storageState({ path: ASTATE });
    // 现在新建客户仍会派生一个 TRON 地址（第 0 批的做法），钱包没初始化时新建客户返回 503。是否保留另行决定，这里照现状先初始化
    await admin.click('[data-tab="p-wallet"]');
    await admin.click('text=初始化主助记词');
    const words = await admin.locator('.mnemonic li').allTextContents();
    expect(words).toHaveLength(24);
    await adminOk(admin);
    for (const [i, n] of [3, 11, 20].entries()) await admin.fill(`#wi-${i}`, words[n - 1]);
    await admin.fill('#wi-code', await code(st.adminSecret));
    await adminOk(admin);
    await expect(admin.locator('[data-pdialog]')).toContainText('初始化完成');
    await adminOk(admin);
    const r = await wcall('merchant-open', { name: 'Wallet E2E Ltd', email: M_EMAIL, fee_in: { ppm: 10000, fixed: 0, min: 0 }, fee_out: { ppm: 0, fixed: 2000000, min: 0 }, order_mode: { enabled: true, low: 900000, high: 1100000, ttlMin: 30, lookbackH: 24 } });
    expect(r.status).toBe(200);
    await expect.poll(() => mailsTo(M_EMAIL).length).toBeGreaterThan(0);
    const link = mailsTo(M_EMAIL)[0].match(/https?:\/\/[^\s]+\/merchant\/\?setup=[A-Za-z0-9_-]+/)![0].replace(/^https?:\/\/[^/]+/, B);
    await merchant.goto(link);
    await merchant.fill('#ms-pw', M_PW); await merchant.fill('#ms-pw2', M_PW);
    await merchant.click('[data-setup] button[type="submit"]');
    await expect(merchant.locator('[data-setup-qr]')).toHaveAttribute('src', /^data:image\/png;base64,/);
    st.merchantSecret = (await merchant.locator('[data-setup-secret]').textContent())!.trim();
    await merchant.fill('#ms-otp', await code(st.merchantSecret));
    await merchant.click('[data-setup] button[type="submit"]');
    await expect(merchant.locator('[data-view="login"]')).toBeVisible();
    await merchant.fill('#ml-em', M_EMAIL); await merchant.fill('#ml-pw', M_PW); await merchant.fill('#ml-otp', await code(st.merchantSecret));
    await merchant.click('[data-login] button[type="submit"]');
    await expect(merchant.locator('[data-merchant-name]')).toHaveText('Wallet E2E Ltd');
    await mctx.storageState({ path: MSTATE });
  });

  test('TC-W01 准备：ETH、BSC 客户地址和到账（ETH 150 / 6,000 超每地址上限 / 50 低于门槛；BSC 5 × 4,900 合计超每批上限）', async () => {
    const plan: [string, string, number][] = [['sw_e1', 'eth', 150], ['sw_e2', 'eth', 6000], ['sw_e3', 'eth', 50], ...[1, 2, 3, 4, 5].map((i) => [`sw_b${i}`, 'bsc', 4900] as [string, string, number])];
    for (const [cid, chain, amount] of plan) {
      expect((await mcall('customer-save', { customer_id: cid })).status).toBe(200);
      const r = await mcall('customer-addresses', undefined, `&customer_id=${cid}`);
      expect(r.status).toBe(200);
      const byChain = Object.fromEntries(r.body.addresses.map((a: any) => [a.chain, a.address]));
      expect(byChain.eth).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(byChain.bsc).toBe(byChain.eth); // 同一套合约，两条链同一个地址
      expect(byChain.tron).toBeUndefined(); // 第 1 批不分配新的 TRON 地址
      st.ev[cid] = byChain.eth;
      const p = await admin.request.post(`${B}/__fake/evm/pay/`, { data: { chain, to: byChain[chain], amount: amount * U } });
      expect(p.status()).toBe(200);
    }
    await tick(admin);
    const d = await mcall('deposits', undefined, '&customer_id=sw_e1');
    expect(d.body.items[0].chain).toBe('eth');
  });

  test('TC-W02 归集（ETH）：现在就凑一批 → 确认三步（核对：冷钱包、地址明细、跳过的地址和原因；原因预填"例行归集"，直接确认）→ 已发出 → 链上确认后"已完成"，记录里原因是"例行归集"', async () => {
    await adminTab('p-sweep');
    await admin.click('[data-propose="eth"]');
    await expect(admin.locator('[data-toast]')).toContainText('1 批');
    const c = admin.locator('[data-panel="p-sweep"] [data-batch]', { hasText: '以太坊' }).filter({ hasText: '待确认' });
    await expect(c).toHaveCount(1);
    const id = (await c.getAttribute('data-batch'))!;
    st.sw.eth.push(id);
    await expect(c.locator('.batch-amt')).toContainText('150.00');
    await expect(admin.locator('[data-panel="p-sweep"] [data-hero]')).toContainText('等你确认');
    await c.locator(`[data-confirm="${id}"]`).click();
    const dlg = admin.locator('[data-pdialog]');
    await expect(dlg).toBeVisible();
    // 第 1 步：核对
    await expect(dlg.locator('.stepper-3 li.on')).toHaveText('核对');
    await expect(dlg).toContainText('冷钱包');
    await expect(dlg.locator(`[title="${st.ev.sw_e1}"]`)).toHaveCount(1);
    await dlg.locator('summary', { hasText: '跳过的' }).click();
    await expect(dlg.locator('tr', { has: admin.locator(`[title="${st.ev.sw_e2}"]`) })).toContainText('超过每地址上限');
    await expect(dlg.locator('tr', { has: admin.locator(`[title="${st.ev.sw_e3}"]`) })).toContainText('低于门槛');
    // 原因按原型预填"例行归集"（可清空）；不改直接确认就能发出
    await expect(admin.locator('#sw-reason')).toHaveValue('例行归集');
    await adminOk(admin);
    // 第 3 步：已发出一笔交易
    await expect(dlg).toContainText('已发出一笔交易');
    await expect(dlg.locator('.stepper-3 li.on')).toHaveText('看链上结果');
    await admin.keyboard.press('Escape');
    for (let i = 0; i < 2; i++) await tick(admin);
    await adminTab('p-sweep');
    await expect(admin.locator('[data-panel="p-sweep"] #sw-records tr', { hasText: id })).toContainText('已完成');
    // 超上限、低于门槛的地址留在"各链待归集地址"里
    await expect(admin.locator('[data-panel="p-sweep"] #sw-addresses')).toContainText('sw_e2');
    const rec = await wcall(`wallet-sweep-batch&id=${id}`);
    expect(rec.status).toBe(200);
    expect(rec.body.reason).toBe('例行归集');
  });

  test('TC-W02B 归集（ETH）：确认时把预填的原因清空也能确认，记录里原因仍是"例行归集"', async () => {
    const r = await mcall('customer-save', { customer_id: 'sw_e4' });
    expect(r.status).toBe(200);
    const a = (await mcall('customer-addresses', undefined, '&customer_id=sw_e4')).body.addresses.find((x: any) => x.chain === 'eth').address;
    st.ev.sw_e4 = a;
    expect((await admin.request.post(`${B}/__fake/evm/pay/`, { data: { chain: 'eth', to: a, amount: 200 * U } })).status()).toBe(200);
    await tick(admin);
    await adminTab('p-sweep');
    await admin.click('[data-propose="eth"]');
    const c = admin.locator('[data-panel="p-sweep"] [data-batch]', { hasText: '以太坊' }).filter({ hasText: '待确认' });
    await expect(c).toHaveCount(1);
    const id = (await c.getAttribute('data-batch'))!;
    await c.locator(`[data-confirm="${id}"]`).click();
    const dlg = admin.locator('[data-pdialog]');
    await expect(admin.locator('#sw-reason')).toHaveValue('例行归集');
    await admin.fill('#sw-reason', '');
    await adminOk(admin);
    await expect(dlg).toContainText('已发出一笔交易');
    await admin.keyboard.press('Escape');
    const rec = await wcall(`wallet-sweep-batch&id=${id}`);
    expect(rec.status).toBe(200);
    expect(rec.body.reason).toBe('例行归集');
  });

  test('TC-W03 归集（BSC）：合计超过每批上限自动拆成两批，每批 ≤ 20,000', async () => {
    await adminTab('p-sweep');
    await admin.click('[data-propose="bsc"]');
    await expect(admin.locator('[data-toast]')).toContainText('2 批');
    const cards = admin.locator('[data-panel="p-sweep"] [data-batch]', { hasText: 'BSC' }).filter({ hasText: '待确认' });
    await expect(cards).toHaveCount(2);
    let sum = 0;
    for (const c of await cards.all()) {
      st.sw.bsc.push((await c.getAttribute('data-batch'))!);
      const v = usdtOf((await c.locator('.batch-amt').textContent())!);
      expect(v).toBeLessThanOrEqual(20000);
      sum += v;
    }
    expect(sum).toBe(24500);
    await expect(admin.locator('[data-panel="p-sweep"] [data-hero]')).toContainText(/\d+ 个批次等你确认/); // 前面的用例红了时可能还有别的待确认批次
  });

  test('TC-W04 确认失败的提示：节点连不上没发出（仍待确认）、等确认超过 24 小时作废、另一个窗口已经确认', async () => {
    const [a] = st.sw.bsc;
    const dlg = admin.locator('[data-pdialog]');
    const openConfirm = async () => {
      await adminTab('p-sweep');
      await admin.click(`[data-confirm="${a}"]`);
      await expect(dlg).toBeVisible();
      await admin.fill('#sw-reason', '端到端：失败提示');
    };
    // 节点连不上：交易没发出，这批仍是"待确认"，弹窗不关，可以稍后再点
    await openConfirm();
    await admin.route(isWallet('wallet-sweep-approve'), (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'sweep_not_sent' } }) }), { times: 1 });
    await adminOk(admin);
    await expect(admin.locator('[data-toast]')).toContainText('没有发出');
    await expect(dlg).toBeVisible();
    await admin.keyboard.press('Escape');
    expect((await sql(`select status from wallet_sweep_batches where id = '${a}'`))[0].status).toBe('awaiting_approval');
    // 超过 24 小时作废
    await openConfirm();
    await admin.route(isWallet('wallet-sweep-approve'), (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'batch_expired' } }) }), { times: 1 });
    await adminOk(admin);
    await expect(admin.locator('[data-toast]')).toContainText('24 小时');
    if (await dlg.isVisible()) await admin.keyboard.press('Escape');
    // 另一个窗口已经确认（真实接口）：页面提示后刷新，不会再发一次
    await openConfirm();
    const other = await wcall('wallet-sweep-approve', { id: a, reason: '另一个窗口' });
    expect(other.status).toBe(200);
    await adminOk(admin);
    await expect(admin.locator('[data-toast]')).toContainText('另一个窗口');
    await expect(dlg).toBeHidden();
    await expect(admin.locator(`[data-confirm="${a}"]`)).toHaveCount(0);
    for (let i = 0; i < 2; i++) await tick(admin);
  });

  test('TC-W05 部分成功、失败的批次：批次记录"有问题"里能看到；详情写明失败的地址放回待归集、不自动重试', async () => {
    const [a, b] = st.sw.bsc;
    // a：部分成功（第一个地址失败、放回）；b：失败（全部放回）
    await sql(`update wallet_sweep_batches set status = 'partial', error = 'SweepFailed' where id = '${a}'`);
    await sql(`update wallet_sweep_items set status = 'released', reason = 'reverted' where id = (select min(id) from wallet_sweep_items where batch_id = '${a}')`);
    await sql(`update wallet_sweep_items set status = 'swept' where batch_id = '${a}' and status in ('pending', 'sent')`);
    await sql(`update wallet_sweep_batches set status = 'failed', error = 'tx_reverted' where id = '${b}'`);
    await sql(`update wallet_sweep_items set status = 'released', reason = 'tx_reverted' where batch_id = '${b}'`);
    await adminTab('p-sweep');
    await admin.locator('[data-panel="p-sweep"] #sw-records .seg button', { hasText: '有问题' }).click();
    const rows = admin.locator('[data-panel="p-sweep"] #sw-records tbody tr');
    await expect(rows.filter({ hasText: a })).toContainText('部分成功');
    await expect(rows.filter({ hasText: b })).toContainText('失败');
    await rows.filter({ hasText: a }).click();
    await expect(admin.locator('[data-pdialog]')).toContainText('放回待归集');
    await expect(admin.locator('[data-pdialog]')).toContainText('不会自动重试');
    await admin.keyboard.press('Escape');
  });

  test('TC-W06 概览"待处理"：失败、部分成功的归集批次进待处理', async () => {
    const [a, b] = st.sw.bsc;
    await adminTab('p-overview');
    const todo = admin.locator('[data-panel="p-overview"] [data-todo]');
    await expect(todo).toBeVisible();
    await expect(todo).toContainText(a);
    await expect(todo).toContainText(b);
  });

  test('TC-W06B 概览"待处理"：归集接口读取失败时显示"读取失败"和"重试"，不显示"现在没事要做"；点重试恢复', async () => {
    await adminTab('p-overview');
    await admin.route(isWallet('wallet-sweep'), (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal_error' } }) }));
    await admin.click('[data-tab="p-sweep"]'); await admin.click('[data-tab="p-overview"]');
    await expect(admin.locator('[data-panel="p-overview"]')).toContainText('读取失败');
    await expect(admin.locator('[data-panel="p-overview"] [data-todo]')).not.toContainText('现在没事要做');
    const retry = admin.locator('[data-panel="p-overview"] [data-todo] button', { hasText: '重试' });
    await expect(retry).toBeVisible();
    await admin.unroute(isWallet('wallet-sweep'));
    await retry.click();
    await expect(admin.locator('[data-panel="p-overview"] [data-todo]')).not.toContainText('读取失败');
  });

  test('TC-W07 钱包提供方：没有别的已接入提供方时"切换"按钮禁用；Cobo、Fireblocks 显示"未接入"', async () => {
    await adminTab('p-routes');
    const p = admin.locator('[data-panel="p-routes"]');
    await expect(p).toContainText('未接入');
    await expect(p).toContainText('第 2 批'); // TRON
    for (const ch of ['eth', 'bsc']) await expect(p.locator(`[data-switch="${ch}"]`)).toBeDisabled();
  });

  test('TC-W08 系统状态：每条链一张卡；扫块停了的链标红（状态和提示），正常的链不标红；TRON 显示"第 2 批"；不显示合约地址的值', async () => {
    await tick(admin); // 先让两条链都扫一次块（正常状态）
    await admin.route(isWallet('wallet-chains'), async (r) => {
      const res = await r.fetch(); const j = await res.json();
      for (const c of j.chains) if (c.chain === 'bsc') Object.assign(c, { status: 'scan_stalled', ok: false, scan: { ...c.scan, ok: false, age_s: 900 } });
      await r.fulfill({ response: res, json: j });
    });
    await adminTab('p-status');
    const p = admin.locator('[data-panel="p-status"]');
    for (const ch of ['eth', 'bsc', 'tron']) await expect(p.locator(`[data-chain-card="${ch}"]`)).toHaveCount(1);
    await expect(p.locator('[data-chain-card="bsc"] .st-rejected')).toBeVisible();
    await expect(p.locator('[data-chain-card="bsc"] .alert')).toBeVisible();
    await expect(p.locator('[data-chain-card="eth"] .st-rejected')).toHaveCount(0);
    await expect(p.locator('[data-wallet-status] .hero-bad')).toContainText('BSC');
    await expect(p.locator('[data-chain-card="tron"]')).toContainText('第 2 批');
    expect(await p.locator('[data-wallet-status]').innerText()).not.toMatch(/0x[0-9a-fA-F]{40}/);
    await admin.unroute(isWallet('wallet-chains'));
  });

  test('TC-W09 商户客户：每条链一行地址（ETH、BSC 两行，同一串）；列表上方有说明；TRON 标"第 2 批"；列表按链分列', async () => {
    await merchant.goto('/zh/merchant/');
    await merchant.click('[data-mtab="customers"]');
    const panel = merchant.locator('[data-mpanel="customers"]');
    await expect(panel.locator('.info-box')).toContainText('同一串');
    await expect(panel.locator('thead')).toContainText('以太坊');
    await expect(panel.locator('thead')).toContainText('BSC');
    await panel.locator('.toolbar .btn-primary').click();
    await merchant.fill('#mc-id', 'ui_multi_1');
    await merchant.click('[data-mdialog-ok]');
    const dlg = merchant.locator('[data-mdialog]');
    const eth = dlg.locator('[data-addresses] [data-chain="eth"]'), bsc = dlg.locator('[data-addresses] [data-chain="bsc"]');
    await expect(eth).toBeVisible(); await expect(bsc).toBeVisible();
    const ea = (await eth.locator('.mono').textContent())!.trim(), ba = (await bsc.locator('.mono').textContent())!.trim();
    expect(ea).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(ba).toBe(ea);
    await expect(eth).toContainText('ERC20'); await expect(bsc).toContainText('BEP20');
    await expect(dlg.locator('[data-addresses] [data-chain="tron"]')).toContainText('第 2 批');
    st.ev.ui_multi_1 = ea;
    await merchant.keyboard.press('Escape');
    // 客户详情里同样每条链一行
    await panel.locator('[data-customer="ui_multi_1"]').click();
    await expect(dlg.locator('[data-addresses] [data-chain="eth"]')).toBeVisible();
    await expect(dlg.locator('[data-addresses] [data-chain="bsc"]')).toBeVisible();
    await merchant.keyboard.press('Escape');
  });

  test('TC-W09B 商户客户：地址弹窗和客户详情里两行同一串时就近说明（免得商户以为只能收一条链）', async () => {
    await merchant.goto('/zh/merchant/');
    await merchant.click('[data-mtab="customers"]');
    const panel = merchant.locator('[data-mpanel="customers"]');
    await panel.locator('.toolbar .btn-primary').click();
    await merchant.fill('#mc-id', 'ui_multi_2');
    await merchant.click('[data-mdialog-ok]');
    const dlg = merchant.locator('[data-mdialog]');
    await expect(dlg.locator('[data-addresses] [data-chain="bsc"]')).toBeVisible();
    await expect(dlg).toContainText('同一串');
    await merchant.keyboard.press('Escape');
    await panel.locator('[data-customer="ui_multi_2"]').click();
    await expect(dlg.locator('[data-addresses] [data-chain="bsc"]')).toBeVisible();
    await expect(dlg).toContainText('同一串');
    await merchant.keyboard.press('Escape');
  });

  test('TC-W10 订单选链：可选"不指定 / 以太坊 / BSC"，TRON 灰（第 2 批）；指定 BSC 只给 BSC 地址，不指定给每条链的地址', async () => {
    const create = async (no: string, chain: string) => {
      await merchant.click('[data-mtab="orders"]');
      await merchant.click('[data-mpanel="orders"] .toolbar .btn-primary');
      const box = merchant.locator('[data-mdialog] [data-chain-choice]');
      await expect(box).toBeVisible();
      await expect(box.locator('input[value="tron"]')).toBeDisabled();
      await expect(box.locator('input[value=""]')).toBeChecked(); // 默认不指定
      await merchant.fill('#mo-cust', 'ui_multi_1'); await merchant.press('#mo-cust', 'Escape');
      await merchant.fill('#mo-no', no); await merchant.fill('#mo-amt', '20');
      await box.locator(`input[value="${chain}"]`).check();
      await merchant.click('[data-mdialog-ok]');
      await expect(merchant.locator('[data-mdialog]')).toContainText('等待付款');
      const id = (await merchant.locator('[data-mdialog-title]').textContent())!.match(/ORD-\d{8}-[0-9A-F]{8}/)![0];
      return id;
    };
    st.orderBsc = await create('CHAIN-BSC-1', 'bsc');
    const dlg = merchant.locator('[data-mdialog]');
    await expect(dlg.locator('.chain-tag')).toHaveText(['BSC']);
    await expect(dlg).toContainText(st.ev.ui_multi_1);
    await merchant.keyboard.press('Escape');
    st.orderAny = await create('CHAIN-ANY-1', '');
    await expect(dlg.locator('.chain-tag', { hasText: '以太坊' })).toHaveCount(1);
    await expect(dlg.locator('.chain-tag', { hasText: 'BSC' })).toHaveCount(1);
    await merchant.keyboard.press('Escape');
    const o = await mcall('order', undefined, `&order_no=${st.orderBsc}`);
    expect(o.body.order.chain).toBe('bsc');
    expect(o.body.order.network).toBe('BSC');
  });

  test('TC-W11 付款页：没指定链时先选网络（TRON 灰）→ 显示这条链的地址和警示 → 可以换网络；指定了链时直接显示', async () => {
    const pay = await mctx.newPage();
    await pay.goto(`/zh/pay/${st.orderAny}/`);
    await expect(pay.locator('[data-pay-choose]')).toBeVisible();
    await expect(pay.locator('[data-pay-live]')).toBeHidden(); // 选网络之前不给地址
    await expect(pay.locator('[data-net="tron"]')).toBeDisabled();
    await pay.click('[data-net="eth"]');
    await expect(pay.locator('[data-pay-network]')).toContainText('以太坊');
    await expect(pay.locator('[data-pay-address]')).toHaveText(st.ev.ui_multi_1);
    await expect(pay.locator('[data-pay-warn]')).toContainText('ERC20');
    await pay.click('[data-pay-change]');
    await expect(pay.locator('[data-pay-choose]')).toBeVisible();
    await pay.click('[data-net="bsc"]');
    await expect(pay.locator('[data-pay-network]')).toContainText('BSC');
    await expect(pay.locator('[data-pay-warn]')).toContainText('BEP20');
    // 刷新后仍是刚才选的网络
    await pay.reload();
    await expect(pay.locator('[data-pay-network]')).toContainText('BSC');
    // 指定了 BSC 的订单：不用选，直接显示；没有"换网络"
    await pay.goto(`/zh/pay/${st.orderBsc}/`);
    await expect(pay.locator('[data-pay-network]')).toContainText('BSC');
    await expect(pay.locator('[data-pay-choose]')).toBeHidden();
    await expect(pay.locator('[data-pay-change]')).toBeHidden();
    await pay.close();
  });

  test('TC-W12 付款页：查询接口出错（500）时显示"暂时查不到状态"并提醒已付请不要重复付，不显示"订单不存在"；恢复后自动接着查', async () => {
    const pay = await mctx.newPage();
    const isPay = (url: URL) => url.pathname === '/api/pay/';
    await pay.route(isPay, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal_error' } }) }));
    await pay.goto(`/zh/pay/${st.orderBsc}/`);
    await expect(pay.locator('body')).toContainText('暂时查不到');
    await expect(pay.locator('body')).toContainText('不要重复付');
    await expect(pay.locator('[data-pay-notfound]')).toBeHidden();
    // 已经显示过地址后接口出错：地址留着，同样提示
    await pay.unroute(isPay);
    await pay.reload();
    await expect(pay.locator('[data-pay-network]')).toContainText('BSC');
    await pay.route(isPay, (r) => r.fulfill({ status: 500, body: 'x' }));
    await expect(pay.locator('body')).toContainText('暂时查不到', { timeout: 15_000 });
    await expect(pay.locator('[data-pay-address]')).toHaveText(st.ev.ui_multi_1);
    await pay.unroute(isPay);
    await expect(pay.locator('body')).not.toContainText('暂时查不到', { timeout: 15_000 });
    await pay.close();
  });

});
