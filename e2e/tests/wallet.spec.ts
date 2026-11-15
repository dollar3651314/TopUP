import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonl, decodeQP, MAILS, KYB_ENV, TMP } from '../stack.mjs';
// @ts-ignore 与后端同一份 TOTP 实现
import { totpCode, totpStep } from '../../server/kyb/totp.js';
import { legacyTron, legacyMnemonic } from './legacy-tron';

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
  // 同一个名字每次给同一个函数：page.unroute 按"同一个函数对象"认路由，每次新建一个函数的话 unroute 什么都不撤
  const walletMatchers: Record<string, (url: URL) => boolean> = {};
  const isWallet = (name: string) => (walletMatchers[name] ||= (url: URL) => url.pathname === '/api/wallet/' && url.searchParams.get('a') === name);
  /** 拦截接口、改返回再交给页面。页面切走或用例结束时请求可能已经作废（响应被释放）：这时不再处理，不把错误留给后面的用例 */
  const patchJson = (edit: (j: any) => void) => async (r: any) => {
    let res, j;
    try { res = await r.fetch(); j = await res.json(); } catch { await r.abort().catch(() => {}); return; }
    edit(j);
    await r.fulfill({ response: res, json: j }).catch(() => {});
  };
  async function adminTab(tab: string) {
    if (!(await admin.locator('[data-view="app"]').isVisible())) await admin.goto('/admin/');
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    await admin.click(`[data-tab="${tab}"]`);
    await expect(admin.locator(`[data-panel="${tab}"]`)).toBeVisible();
    await expect(admin.locator(`[data-panel="${tab}"] [data-loading]`)).toHaveCount(0);
  }
  const usdtOf = (s: string) => Number(s.replace(/[^\d.]/g, ''));
  // TRON 没开通时面向用户的口径（产品定的口径变更：原来写"第 2 批"，改成"未开通"）
  const OFF = '未开通', OLD = '第 2 批';
  const LATER_NOTE = '平台还没开通 TRON 收款，暂时不能选。';
  const TRON_LATER = '平台还没开通 TRON 收款；开通后，客户在 TRON 发起充值时生成。';
  const TRON_STATUS_NOTE = 'TRON 合约钱包没开通（config/wallets.json 的 tron 参数没填全，或链上核对没通过），不分配新的 TRON 地址；已有的老 TRON 地址照常入账。';

  // ---- 第 2 批（TRON 合约钱包）开通后的收尾：本地（config/wallets.json 的 local）不开通 TRON 合约钱包，
  // "开通"用浏览器拦截接口模拟：商户页看概览接口的 chains、付款页看 /api/pay/ 的 chains。每个用例用新开的页面，不影响 merchant 页面里已读到的开通列表。
  const mMatchers: Record<string, (url: URL) => boolean> = {};
  const isMerchant = (name: string) => (mMatchers[name] ||= (url: URL) => url.pathname === '/api/merchant/' && url.searchParams.get('a') === name);
  const withTron = (j: any) => { j.chains = [...new Set([...(j.chains || []), 'tron'])]; };
  /** 新开一个商户页面，概览接口的 chains 带上 tron（TRON 已开通） */
  async function merchantTronOn() {
    const mp = await mctx.newPage();
    let seen = false;
    await mp.route(isMerchant('overview'), patchJson((j) => { expect(j.chains, '前提：概览接口返回 chains').toBeTruthy(); withTron(j); seen = true; }));
    await mp.goto('/zh/merchant/');
    await expect(mp.locator('[data-merchant-name]')).toHaveText('Wallet E2E Ltd');
    await expect.poll(() => seen, { message: '前提：页面读过（被改成开通 TRON 的）概览接口' }).toBe(true);
    return mp;
  }

  test('TC-W00 准备：后台初始化并登录、初始化 TRON 主助记词；开通商户 → 设置密码和验证码 → 登录', async () => {
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
    // TRON 主助记词：按 K1 新建客户不再需要它（不初始化也不该 503，单元测试 test/wallet-k1.test.js 守着）；
    // 后面的旧地址（第 0 批）用例要用，按 Q-A1 后台不再提供初始化，这里造"旧系统早已初始化"的旧数据（服务器只有公钥）
    const { words } = await legacyMnemonic(admin, B);
    expect(words).toHaveLength(24);
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

  test('TC-W01 准备（K1）：建客户不生成地址；按链建订单时才生成这条链的地址（只这条链）；ETH 150 / 6,000 超每地址上限 / 50 低于门槛；BSC 5 × 4,900 合计超每批上限', async () => {
    const plan: [string, string, number][] = [['sw_e1', 'eth', 150], ['sw_e2', 'eth', 6000], ['sw_e3', 'eth', 50], ...[1, 2, 3, 4, 5].map((i) => [`sw_b${i}`, 'bsc', 4900] as [string, string, number])];
    for (const [cid, chain, amount] of plan) {
      expect((await mcall('customer-save', { customer_id: cid })).status).toBe(200);
      // K1：客户发起充值时才按链生成地址。建订单时指定链 → 生成这条链的地址（订单金额和到账不同，不会被匹配）
      const o = await mcall('order-create', { customer_id: cid, merchant_order_no: `GEN-${cid}`, amount: '1', chain });
      expect(o.status).toBe(200);
      expect(o.body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const r = await mcall('customer-addresses', undefined, `&customer_id=${cid}`);
      expect.soft(r.body.addresses.map((a: any) => a.chain), `${cid} 只生成被选的这条链`).toEqual([chain]); // soft：K1 没实现时这里红，但照样准备好后面用例要的数据
      st.ev[cid] = o.body.address;
      const p = await admin.request.post(`${B}/__fake/evm/pay/`, { data: { chain, to: o.body.address, amount: amount * U } });
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
    const a = (await mcall('order-create', { customer_id: 'sw_e4', merchant_order_no: 'GEN-sw_e4', amount: '1', chain: 'eth' })).body.address; // K1：按链建订单时才生成地址
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

  test('TC-W07 钱包提供方：没有别的已接入提供方时"切换"按钮禁用；Cobo、Fireblocks 显示"未接入"；TRON 标"未开通"、不写"第 2 批"', async () => {
    await adminTab('p-routes');
    const p = admin.locator('[data-panel="p-routes"]');
    await expect(p).toContainText('未接入');
    // TRON：标签（链名旁边、切换按钮的位置）都写"未开通"
    const tags = p.locator('.later-tag');
    await expect(tags.first()).toBeVisible();
    for (const t of await tags.allInnerTexts()) expect(t.trim()).toBe(OFF);
    await expect(p).not.toContainText(OLD);
    for (const ch of ['eth', 'bsc']) await expect(p.locator(`[data-switch="${ch}"]`)).toBeDisabled();
  });

  test('TC-W08 系统状态：每条链一张卡；扫块停了的链标红（状态和提示），正常的链不标红；TRON 标"未开通"、说明写新口径、不写"第 2 批"；不显示合约地址的值', async () => {
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
    const tc = p.locator('[data-chain-card="tron"]');
    await expect(tc.locator('.later-tag')).toHaveText(OFF);
    await expect(tc).toContainText(TRON_STATUS_NOTE);
    await expect(tc).not.toContainText(OLD);
    await expect(tc).not.toContainText('第 1 批');
    await expect(p).not.toContainText(OLD);
    expect(await p.locator('[data-wallet-status]').innerText()).not.toMatch(/0x[0-9a-fA-F]{40}/);
    await admin.unroute(isWallet('wallet-chains'));
  });

  test('TC-W09 商户客户（K1）：新建客户后没有地址，写明"客户发起充值时按链生成"；列表按链分列；列表的 TRON 一列标"未开通"，不写"第 2 批"', async () => {
    await merchant.goto('/zh/merchant/');
    await merchant.click('[data-mtab="customers"]');
    const panel = merchant.locator('[data-mpanel="customers"]');
    await expect(panel.locator('thead')).toContainText('以太坊');
    await expect(panel.locator('thead')).toContainText('BSC');
    // 口径的断言用 soft：没改时这里红，但照样往下建客户（后面的用例要用）
    await expect.soft(panel).not.toContainText(OLD);
    await panel.locator('.toolbar .btn-primary').click();
    await merchant.fill('#mc-id', 'ui_multi_1');
    await merchant.click('[data-mdialog-ok]');
    await expect(merchant.locator('[data-mtoast]')).toBeVisible();
    expect((await mcall('customer-addresses', undefined, '&customer_id=ui_multi_1')).body.addresses).toEqual([]);
    if (await merchant.locator('[data-mdialog]').isVisible()) await merchant.keyboard.press('Escape');
    await panel.locator('[data-customer="ui_multi_1"]').click();
    const dlg = merchant.locator('[data-mdialog]');
    await expect(dlg).toBeVisible();
    await expect(dlg).not.toContainText(/0x[0-9a-fA-F]{40}/);
    await expect(dlg).toContainText('充值'); // 说明地址在客户发起充值时按链生成
    // 新客户没有地址时详情不画按链的地址卡（只写说明），TRON 一行的口径在 TC-W09B 断言；这里只断言不写"第 2 批"
    await expect.soft(dlg).not.toContainText(OLD);
    await expect.soft(dlg).not.toContainText('第 2 批上线');
    await merchant.keyboard.press('Escape');
    // 列表的 TRON 一列：标"未开通"
    const heads = (await panel.locator('thead th').allInnerTexts()).map((x) => x.trim());
    const ti = heads.findIndex((x) => x.includes('TRON'));
    expect(ti, `前提：列表有 TRON 一列（表头 ${heads.join(' | ')}）`).toBeGreaterThan(0);
    await expect(panel.locator('[data-customer="ui_multi_1"] td').nth(ti)).toHaveText(OFF);
    await expect(panel.locator('tbody')).not.toContainText(OLD);
  });

  test('TC-W09B 商户客户：以太坊、BSC 都生成过时，客户详情两行同一串，旁边写一句说明（免得商户以为只能收一条链）；TRON 标"未开通"、不写"第 2 批"', async () => {
    await mcall('customer-save', { customer_id: 'ui_multi_2' });
    for (const chain of ['eth', 'bsc']) expect((await mcall('order-create', { customer_id: 'ui_multi_2', merchant_order_no: `GEN2-${chain}`, amount: '1', chain })).status).toBe(200);
    await merchant.goto('/zh/merchant/');
    await merchant.click('[data-mtab="customers"]');
    const panel = merchant.locator('[data-mpanel="customers"]');
    await panel.locator('[data-customer="ui_multi_2"]').click();
    const dlg = merchant.locator('[data-mdialog]');
    const eth = dlg.locator('[data-addresses] [data-chain="eth"]'), bsc = dlg.locator('[data-addresses] [data-chain="bsc"]');
    await expect(eth).toBeVisible(); await expect(bsc).toBeVisible();
    expect((await eth.locator('.mono').textContent())!.trim()).toBe((await bsc.locator('.mono').textContent())!.trim());
    await expect(eth).toContainText('ERC20'); await expect(bsc).toContainText('BEP20');
    await expect(dlg.locator('[data-addresses] [data-chain="tron"] .later-tag')).toHaveText(OFF);
    await expect(dlg.locator('[data-addresses] [data-chain="tron"]')).toContainText(TRON_LATER);
    await expect(dlg).not.toContainText(OLD);
    await expect(dlg).toContainText('同一串');
    await merchant.keyboard.press('Escape');
  });

  test('TC-W09C 商户客户（TRON 开通后）：概览 chains 带 tron、客户还没有 TRON 地址时，客户详情的 TRON 一行和以太坊一样写"客户在这条链发起充值时生成"，不标"第 2 批"；列表的 TRON 一列同样不标', async () => {
    const mp = await merchantTronOn();
    await mp.click('[data-mtab="customers"]');
    const panel = mp.locator('[data-mpanel="customers"]');
    const row = panel.locator('[data-customer="ui_multi_2"]');
    await expect(row).toBeVisible();
    // 列表：TRON 那一列（表头含 TRON）是"—"，整行没有"第 2 批"
    const heads = (await panel.locator('thead th').allInnerTexts()).map((x) => x.trim());
    const ti = heads.findIndex((x) => x.includes('TRON'));
    expect(ti, `前提：列表按链分列、有 TRON 一列（表头 ${heads.join(' | ')}）`).toBeGreaterThan(0);
    await expect(row.locator('td').nth(ti)).toHaveText('—');
    await expect(row).not.toContainText('第 2 批');
    await expect(panel.locator('tbody')).not.toContainText('第 2 批');
    // 详情
    await row.click();
    const dlg = mp.locator('[data-mdialog]');
    const tron = dlg.locator('[data-addresses] [data-chain="tron"]');
    await expect(dlg.locator('[data-addresses] [data-chain="eth"] .mono')).toBeVisible(); // 前提：详情已显示（以太坊有地址）
    await expect(tron).toBeVisible();
    await expect(tron).toContainText('客户在这条链发起充值时生成');
    await expect(tron).not.toContainText('第 2 批');
    await expect(dlg).not.toContainText('第 2 批');
    await expect(dlg).not.toContainText(OFF); // 开通后也不标"未开通"
    await expect(dlg.locator('.later-tag')).toHaveCount(0);
    await mp.close();
  });

  test('TC-W10 订单选链（K1）：可选"不指定 / 以太坊 / BSC"，TRON 灰（标"未开通"、写新口径的说明，不写"第 2 批"）；不指定时不给地址（付款人选了链才生成）；指定 BSC 时生成并只给 BSC 地址', async () => {
    const create = async (no: string, chain: string) => {
      await merchant.click('[data-mtab="orders"]');
      await merchant.click('[data-mpanel="orders"] .toolbar .btn-primary');
      const box = merchant.locator('[data-mdialog] [data-chain-choice]');
      await expect(box).toBeVisible();
      await expect(box.locator('input[value="tron"]')).toBeDisabled();
      const tronChoice = box.locator('label.chain-choice', { has: merchant.locator('input[value="tron"]') });
      // soft：口径没改时这里红，但照样往下建单（后面的付款页用例要用）
      await expect.soft(tronChoice.locator('.later-tag')).toHaveText(OFF);
      await expect.soft(tronChoice).toContainText(LATER_NOTE);
      await expect.soft(box).not.toContainText(OLD);
      await expect(box.locator('input[value=""]')).toBeChecked(); // 默认不指定
      // 客户搜索列表出来以后再按 Esc（只关列表）：列表还没出来时 Esc 会关掉整个弹窗（CI 上搜索慢时第二张单的表单就不见了）
      await merchant.fill('#mo-cust', 'ui_multi_1');
      await expect(merchant.locator('#mo-cust-list')).toBeVisible();
      await merchant.press('#mo-cust', 'Escape');
      await expect(merchant.locator('#mo-cust-list')).toBeHidden();
      await expect(box).toBeVisible();
      await merchant.fill('#mo-no', no); await merchant.fill('#mo-amt', '20');
      await box.locator(`input[value="${chain}"]`).check();
      await merchant.click('[data-mdialog-ok]');
      await expect(merchant.locator('[data-mdialog]')).toContainText('等待付款');
      const id = (await merchant.locator('[data-mdialog-title]').textContent())!.match(/ORD-\d{8}-[0-9A-F]{8}/)![0];
      return id;
    };
    const dlg = merchant.locator('[data-mdialog]');
    // 先建不指定链的订单：客户还没有任何地址，订单里也不给地址
    st.orderAny = await create('CHAIN-ANY-1', '');
    // soft：K1 没实现时这里红，但照样往下建 BSC 订单（后面的付款页用例要用）
    await expect.soft(dlg).not.toContainText(/0x[0-9a-fA-F]{40}/);
    await merchant.keyboard.press('Escape');
    expect.soft((await mcall('customer-addresses', undefined, '&customer_id=ui_multi_1')).body.addresses).toEqual([]);
    // 指定 BSC：创建订单时生成 BSC 地址，只给 BSC
    st.orderBsc = await create('CHAIN-BSC-1', 'bsc');
    await expect(dlg.locator('.chain-tag')).toHaveText(['BSC']);
    const o = await mcall('order', undefined, `&order_no=${st.orderBsc}`);
    expect(o.body.order.chain).toBe('bsc');
    expect(o.body.order.network).toBe('BSC');
    expect(o.body.order.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    st.ev.ui_multi_1 = o.body.order.address;
    await expect(dlg).toContainText(st.ev.ui_multi_1);
    await merchant.keyboard.press('Escape');
    expect.soft((await mcall('customer-addresses', undefined, '&customer_id=ui_multi_1')).body.addresses.map((a: any) => a.chain)).toEqual(['bsc']);
  });

  test('TC-W10B 订单选链（TRON 开通后）：概览 chains 带 tron 时 TRON 可选、不标"第 2 批"；选 TRON 能建单，请求带 chain=tron，建好后订单详情写 TRON', async () => {
    const mp = await merchantTronOn();
    // 本地服务器不开通 TRON 合约钱包（按 TRON 建单会 409）：建单请求先核对页面发的是 chain=tron，再去掉 chain 交给真服务器建一张真订单，
    // 订单详情接口把这张单改成服务器开通 TRON 时会返回的样子（chain=tron、TRON 地址）。服务器按 TRON 建单在单元测试里测。
    const TADDR = 'TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW';
    let sent: any = null, made = '';
    await mp.route(isMerchant('order-create'), async (r) => {
      sent = r.request().postDataJSON();
      const { chain, ...rest } = sent;
      let res, j;
      try { res = await r.fetch({ postData: JSON.stringify(rest) }); j = await res.json(); } catch { await r.abort().catch(() => {}); return; }
      if (res.ok()) { made = j.order_no; Object.assign(j, { chain: 'tron', network: 'TRON', address: TADDR }); }
      await r.fulfill({ response: res, json: j }).catch(() => {});
    });
    await mp.route(isMerchant('order'), patchJson((j) => { if (j.order && j.order.order_no === made) Object.assign(j.order, { chain: 'tron', network: 'TRON', address: TADDR }); }));
    await mp.click('[data-mtab="orders"]');
    await mp.click('[data-mpanel="orders"] .toolbar .btn-primary');
    const box = mp.locator('[data-mdialog] [data-chain-choice]');
    await expect(box).toBeVisible();
    await expect(box.locator('input[value="eth"]')).toBeEnabled(); // 前提：选链已显示
    await expect(box.locator('input[value="tron"]')).toBeEnabled();
    await expect(box).not.toContainText('第 2 批');
    await expect(box).not.toContainText(OFF);
    await expect(box.locator('.later-tag')).toHaveCount(0);
    await mp.fill('#mo-cust', 'ui_multi_1');
    await expect(mp.locator('#mo-cust-list')).toBeVisible();
    await mp.press('#mo-cust', 'Escape');
    await expect(mp.locator('#mo-cust-list')).toBeHidden();
    await expect(box).toBeVisible();
    await mp.fill('#mo-no', `CHAIN-TRON-${Date.now().toString(36).toUpperCase()}`); await mp.fill('#mo-amt', '20');
    await box.locator('input[value="tron"]').check();
    await mp.click('[data-mdialog-ok]');
    const dlg = mp.locator('[data-mdialog]');
    await expect(dlg).toContainText('等待付款');
    expect(sent?.chain, '页面发出的建单请求要带 chain=tron').toBe('tron');
    expect(made).toMatch(/^ORD-\d{8}-[0-9A-F]{8}$/);
    await expect(mp.locator('[data-mdialog-title]')).toContainText(made);
    await expect(dlg.locator('.chain-tag')).toHaveText(['TRON']);
    await expect(dlg).toContainText(TADDR);
    await expect(dlg).not.toContainText('第 2 批');
    await mp.close();
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

  test('TC-W11B 付款页 TRON 按钮的小字：没开通时灰着、写"暂未开通"；开通后（/api/pay/ 的 chains 带 tron）可点、写"波场网络"、不写"即将开通"', async () => {
    expect(st.orderAny, '前提：TC-W10 建了不指定链的订单').toMatch(/^ORD-/);
    // 没开通（本地服务器的真实返回）
    const off = await mctx.newPage();
    await off.goto(`/zh/pay/${st.orderAny}/`);
    await expect(off.locator('[data-pay-choose]')).toBeVisible();
    await expect(off.locator('[data-net="eth"]')).toBeEnabled(); // 前提：选网络的按钮已画出
    await expect(off.locator('[data-net="tron"]')).toBeDisabled();
    await expect(off.locator('[data-net="tron"]')).toContainText('暂未开通');
    await expect(off.locator('[data-net="tron"]')).not.toContainText('即将开通');
    // 新口径：没开通的链去掉标签，只留"暂未开通"小字（不再写"第 2 批"，也不另加"未开通"标签）
    await expect(off.locator('[data-net="tron"] .later-tag')).toHaveCount(0);
    await expect(off.locator('[data-net="tron"]')).not.toContainText(OLD);
    expect(((await off.locator('[data-net="tron"]').innerText()).match(/未开通/g) || []).length, 'TRON 按钮里"未开通"只出现在"暂未开通"小字里一次').toBe(1);
    await expect(off.locator('[data-pay-chains]')).not.toContainText(OLD);
    await off.close();
    // 开通：付款页接口的 chains 带上 tron
    const on = await mctx.newPage();
    let seen = false;
    await on.route((url: URL) => url.pathname === '/api/pay/', patchJson((j) => { if (Array.isArray(j.chains)) { withTron(j); seen = true; } }));
    await on.goto(`/zh/pay/${st.orderAny}/`);
    await expect(on.locator('[data-pay-choose]')).toBeVisible();
    await expect.poll(() => seen, { message: '前提：付款页读过（被改成开通 TRON 的）接口' }).toBe(true);
    const t = on.locator('[data-net="tron"]');
    await expect(t).toBeEnabled();
    await expect(t).not.toHaveClass(/disabled/);
    await expect(t).toContainText('波场网络');
    await expect(t).not.toContainText('即将开通');
    await expect(t).not.toContainText('暂未开通');
    await on.close();
  });

  test('TC-W11C 付款页（英文）没开通的 TRON：没有标签，只有"Not available yet"小字；不写"Release 2"', async () => {
    expect(st.orderAny, '前提：TC-W10 建了不指定链的订单').toMatch(/^ORD-/);
    const pay = await mctx.newPage();
    await pay.goto(`/pay/${st.orderAny}/`);
    await expect(pay.locator('[data-pay-choose]')).toBeVisible();
    await expect(pay.locator('[data-net="eth"]')).toBeEnabled(); // 前提：选网络的按钮已画出
    const t = pay.locator('[data-net="tron"]');
    await expect(t).toBeDisabled();
    await expect(t).toContainText('Not available yet');
    await expect(t.locator('.later-tag')).toHaveCount(0);
    await expect(t).not.toContainText('Not enabled');
    await expect(pay.locator('[data-pay-chains]')).not.toContainText(/release 2/i);
    await pay.close();
  });

  test('TC-W09D 商户客户（英文）TRON 没开通：客户详情、列表、建单选链的标签写"Not enabled"，不写"Release 2"', async () => {
    const mp = await mctx.newPage();
    await mp.goto('/merchant/');
    await expect(mp.locator('[data-merchant-name]')).toHaveText('Wallet E2E Ltd');
    await mp.click('[data-mtab="customers"]');
    const panel = mp.locator('[data-mpanel="customers"]');
    const row = panel.locator('[data-customer="ui_multi_2"]');
    await expect(row).toBeVisible();
    await expect(row.locator('.later-tag')).toHaveText('Not enabled');
    await expect(panel).not.toContainText(/release 2/i);
    await row.click();
    const dlg = mp.locator('[data-mdialog]');
    await expect(dlg.locator('[data-addresses] [data-chain="eth"] .mono')).toBeVisible(); // 前提：详情已显示
    await expect(dlg.locator('[data-addresses] [data-chain="tron"] .later-tag')).toHaveText('Not enabled');
    await expect(dlg).not.toContainText(/release 2/i);
    await mp.keyboard.press('Escape');
    await mp.click('[data-mtab="orders"]');
    await mp.click('[data-mpanel="orders"] .toolbar .btn-primary');
    const box = mp.locator('[data-mdialog] [data-chain-choice]');
    await expect(box).toBeVisible();
    await expect(box.locator('input[value="tron"]')).toBeDisabled();
    await expect(box.locator('.later-tag')).toHaveText('Not enabled');
    await expect(box).not.toContainText(/release 2/i);
    await mp.close();
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

  test('TC-W13 老 TRON 客户（K1）：不指定链的订单和新客户一样不显示地址；付款页可以选 TRON，选了才给已有的 TRON 地址', async () => {
    const tron = await legacyTron(admin, B, 'Wallet E2E Ltd', 'old_tron_1');
    expect(tron).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    const o = await mcall('order-create', { customer_id: 'old_tron_1', merchant_order_no: 'OLD-TRON-1', amount: '10' });
    expect(o.status).toBe(200);
    const no = o.body.order_no;
    // 付款页：先选网络，TRON 可选（老客户有 TRON 地址）；选之前不给地址
    const pay = await mctx.newPage();
    await pay.goto(`/zh/pay/${no}/`);
    await expect(pay.locator('[data-net="tron"]')).toBeEnabled();
    await pay.click('[data-net="tron"]');
    await expect(pay.locator('[data-pay-address]')).toHaveText(tron);
    await pay.close();
    // 创建订单的返回：和新客户一样不带地址（放最后：K1 没实现时这里红，不挡住上面的检查）
    expect(o.body.address).toBeNull();
    expect(o.body.network).toBeNull();
  });

  // 复核补测（第 1 批返工）：概览"待处理"里研发新加的几类、资金按链拆开时一条链查不到余额
  test('TC-W14 概览"待处理"：链上合约参数不一致（已停用）、发起账户手续费不够、等确认的批次都列出；出错的排在等确认的前面，第一条配大按钮', async () => {
    await adminTab('p-overview');
    const created = new Date(Date.now() - 3 * 3600_000).toISOString();
    await admin.route(isWallet('wallet-chains'), patchJson((j) => {
      for (const c of j.chains) {
        if (c.chain === 'eth') Object.assign(c, { status: 'onchain_mismatch', ok: false, config_error: 'onchain_mismatch', onchain_fields: ['parent'] });
        if (c.chain === 'bsc') c.operator = { ...c.operator, configured: true, gas: '0.001', symbol: 'BNB', batches_left: 1, low: true };
      }
    }));
    await admin.route(isWallet('wallet-sweep'), patchJson((j) => {
      const eth = (j.chains || []).find((c: any) => c.chain === 'eth');
      if (eth) eth.batches = [...(eth.batches || []), { id: 'QA-AWAIT-1', status: 'awaiting_approval', chain: 'eth', total_usdt: '123.45', address_count: 2, split_of: 1, created_at: created }];
    }));
    await admin.click('[data-tab="p-sweep"]'); await admin.click('[data-tab="p-overview"]');
    const todo = admin.locator('[data-panel="p-overview"] [data-todo]');
    await expect(todo).toContainText('以太坊：合约参数和链上不一致，已停用');
    await expect(todo).toContainText('BSC 发起账户的 BNB 不够付手续费');
    await expect(todo).toContainText('确认归集 QA-AWAIT-1');
    // 顺序：出错的（不一致、手续费不够）在等确认的前面
    const rows = await todo.locator('tbody tr').allInnerTexts();
    const at = (s: string) => rows.findIndex((x) => x.includes(s));
    expect(at('合约参数和链上不一致')).toBeGreaterThanOrEqual(0);
    expect(at('合约参数和链上不一致')).toBeLessThan(at('QA-AWAIT-1'));
    expect(at('不够付手续费')).toBeLessThan(at('QA-AWAIT-1'));
    await expect(todo.locator('.hero-bad')).toBeVisible();
    expect(await todo.innerText()).not.toMatch(/0x[0-9a-fA-F]{40}/);
    // 按钮去对的页面：手续费不够 → 归集页
    await todo.locator('tbody tr', { hasText: '不够付手续费' }).locator('button', { hasText: '去补手续费' }).click();
    await expect(admin.locator('[data-panel="p-sweep"]')).toBeVisible();
    // 归集页（和侧栏角标）还在读 wallet-sweep、wallet-chains：等页面读完，再等在途的拦截处理完才撤拦截，不把没处理完的请求留给下一条用例
    await expect(admin.locator('[data-panel="p-sweep"] [data-loading]')).toHaveCount(0);
    await admin.unroute(isWallet('wallet-chains'), { behavior: 'wait' });
    await admin.unroute(isWallet('wallet-sweep'), { behavior: 'wait' });
  });

  test('TC-W15 概览资金按链拆开：BSC 冷钱包查不到时 BSC 那行冷钱包和合计显示"—"，平台资产、利润显示"—"；TRON、以太坊那行照常有数', async () => {
    await adminTab('p-overview');
    let byChain = false;
    await admin.route(isWallet('overview-chain'), patchJson((j) => {
      byChain = Boolean(j.funds.by_chain?.bsc);
      Object.assign(j.funds, { cold_usdt: null, assets_total: null, profit_total: null, profit_now: null, profit_after_sweep: null });
      if (j.funds.by_chain?.bsc) j.funds.by_chain.bsc.cold_usdt = null;
    }));
    await admin.click('[data-tab="p-sweep"]'); await admin.click('[data-tab="p-overview"]');
    const p = admin.locator('[data-panel="p-overview"]');
    const box = p.locator('[data-funds-chains]');
    await expect(box).toBeVisible();
    await expect(p.locator('[data-ov-refresh]')).toBeEnabled(); // 两批数据都回来了
    expect(byChain, '前提：接口按链返回资金').toBe(true);
    const row = (name: string) => box.locator('tbody tr', { hasText: name });
    const cells = async (name: string) => (await row(name).locator('td').allInnerTexts()).map((x) => x.trim());
    const bsc = await cells('BSC');
    expect(bsc[3]).toBe('—'); // 冷钱包
    expect(bsc[4]).toBe('—'); // 合计
    const tron = await cells('TRON'), eth = await cells('以太坊');
    expect(tron[4]).not.toBe('—');
    expect(eth[3]).not.toBe('—');
    expect(eth[4]).not.toBe('—');
    const statV = (label: string) => p.locator('.stat').filter({ has: admin.locator('.k', { hasText: new RegExp(`^${label}$`) }) }).locator('.v');
    await expect(statV('平台资产')).toHaveText('—');
    await expect(statV('利润')).toHaveText('—');
    await expect(statV('现在就能转走的利润')).toHaveText('—');
    await admin.unroute(isWallet('overview-chain'), { behavior: 'wait' });
  });

  test('TC-W16 付款页接口按 IP 限流（整套服务）：同一个 IP 一下子查很多次，每秒前 20 次照常、超过的返回 429 rate_limited；过了这一秒又能查', async () => {
    // 本地不在反向代理后面：服务端用连接的来源地址当 IP（不信请求头），这里所有请求都来自 127.0.0.1。
    // "别的 IP 不受影响"在单元测试里测（wallet-rework.test.js）
    const url = `${B}/api/pay/?o=${st.orderAny || 'ORD-20261201-00000000'}`;
    await new Promise((ok) => setTimeout(ok, 1100)); // 从新的一秒开始，不受前面用例的请求影响
    const rs = await Promise.all(Array.from({ length: 60 }, () => fetch(url)));
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 429).length, codes.join(',')).toBeGreaterThan(0);
    expect(codes.filter((c) => c !== 429).length, codes.join(',')).toBeGreaterThanOrEqual(20); // 每秒前 20 次照常返回
    const limited = rs.find((r) => r.status === 429)!;
    expect((await limited.json()).error.code).toBe('rate_limited');
    await Promise.all(rs.filter((r) => r !== limited).map((r) => r.arrayBuffer()));
    // 过了这一秒，同一个 IP 又能查（后面的用例不受影响）
    await new Promise((ok) => setTimeout(ok, 1100));
    expect((await fetch(url)).status).not.toBe(429);
  });

  test('TC-W17 归集"门槛和上限"（TRON 开通后的收尾）：#sw-settings 不再标"第 2 批"；修改弹窗的 TRON 一项叫"TRON 门槛（USDT）"', async () => {
    await adminTab('p-sweep');
    const set = admin.locator('[data-panel="p-sweep"] #sw-settings');
    await expect(set).toBeVisible();
    await expect(set).toContainText('归集门槛'); // 前提：门槛一行已显示
    await expect(set).toContainText('TRON');
    await expect(set).not.toContainText('第 2 批');
    await set.locator('[data-edit-settings]').click();
    const dlg = admin.locator('[data-pdialog]');
    await expect(dlg.locator('#ss-tron')).toBeVisible();
    await expect(dlg.locator('label[for="ss-tron"]')).toHaveText('TRON 门槛（USDT）');
    await expect(dlg).not.toContainText('第 2 批');
    await admin.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    // 各链待归集地址的链切换：TRON 没开通时标"未开通"，整个归集页不写"第 2 批"
    const ttab = admin.locator('[data-panel="p-sweep"] [data-sweep-tab="tron"]');
    await expect(ttab).toBeDisabled();
    await expect(ttab).toContainText(OFF);
    await expect(ttab).not.toContainText(OLD);
    await expect(admin.locator('[data-panel="p-sweep"]')).not.toContainText(OLD);
  });

  // ---- 没开通的链不算出错（测试会话补测）：config/wallets.json 里一条链的合约地址全空 = not_enabled（ok = true），
  // 灰着显示"未开通"，不进待处理、不亮系统状态红点；只填一部分才是 not_configured（照旧报错）。用拦截 wallet-chains 模拟。
  // mode 换了以后切一次页面，概览"待处理"和侧栏角标会重新读 wallet-chains。
  const chainOff = (j: any, mode: 'not_enabled' | 'not_configured') => {
    for (const c of j.chains) if (c.chain === 'bsc') {
      if (mode === 'not_enabled') Object.assign(c, { status: 'not_enabled', ok: true, usdt: false, contracts: { factory: false, implementation: false, parent: false, batcher: false }, scan: { ok: true, lag_blocks: null, age_s: null }, onchain: null });
      else Object.assign(c, { status: 'not_configured', ok: false, rpc: true, usdt: true, contracts: { ...c.contracts, batcher: false } });
    }
  };
  async function reloadOverview() {
    await admin.click('[data-tab="p-sweep"]');
    await expect(admin.locator('[data-panel="p-sweep"] [data-loading]')).toHaveCount(0);
    await admin.click('[data-tab="p-overview"]');
    await expect(admin.locator('[data-panel="p-overview"]')).toBeVisible();
    await expect(admin.locator('[data-panel="p-overview"] [data-todo] [data-loading]')).toHaveCount(0);
  }

  test('TC-W18 BSC 没开通（not_enabled）：概览待处理没有"合约地址没配齐"、侧栏系统状态不亮"!"；系统状态 BSC 卡片灰着标"未开通"、不标红；顶部"开通的链都正常"并写"BSC未开通"', async () => {
    await adminTab('p-overview');
    let mode: 'not_enabled' | 'not_configured' = 'not_configured';
    await admin.route(isWallet('wallet-chains'), patchJson((j) => chainOff(j, mode)));
    const todo = admin.locator('[data-panel="p-overview"] [data-todo]');
    const badge = admin.locator('[data-pcount="status"]');
    // 前提：先用"没配齐"让红点亮起来，再换成"没开通"，看红点是不是跟着灭（不是一直就没亮）
    await reloadOverview();
    await expect(todo).toContainText('BSC：合约地址没配齐');
    await expect(badge).toHaveText('!');
    mode = 'not_enabled';
    await reloadOverview();
    await expect(todo).not.toContainText('读取失败');
    await expect(todo).not.toContainText('BSC：合约地址没配齐');
    await expect(badge).not.toHaveText('!');
    await expect(badge).not.toHaveClass(/badge-bad/);
    // 系统状态
    await admin.click('[data-tab="p-status"]');
    const p = admin.locator('[data-panel="p-status"]');
    await expect(p.locator('[data-wallet-status]')).toBeVisible();
    const card = p.locator('[data-chain-card="bsc"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.later-tag')).toHaveText(OFF);
    await expect(card).not.toHaveClass(/chain-bad/);
    await expect(card.locator('.st-rejected')).toHaveCount(0);
    await expect(card.locator('.alert')).toHaveCount(0);
    await expect(card).not.toContainText('少 ');
    const top = p.locator('[data-wallet-status] [data-hero]').first();
    await expect(top).toHaveAttribute('data-hero', 'ok');
    await expect(top).toContainText('开通的链都正常');
    await expect(top).toContainText('BSC未开通');
    await expect(p.locator('[data-wallet-status] .hero-bad')).toHaveCount(0);
    // 以太坊照常一张正常的卡
    await expect(p.locator('[data-chain-card="eth"] .later-tag')).toHaveCount(0);
    expect(await p.locator('[data-wallet-status]').innerText()).not.toMatch(/0x[0-9a-fA-F]{40}/);
    await expect(p.locator('[data-loading]')).toHaveCount(0);
    await admin.unroute(isWallet('wallet-chains'), { behavior: 'wait' });
  });

  test('TC-W19 BSC 只填了一部分（not_configured、节点已配）：概览待处理有"BSC：合约地址没配齐"、侧栏系统状态亮"!"；系统状态 BSC 卡片标红、没有"未开通"', async () => {
    await adminTab('p-overview');
    await admin.route(isWallet('wallet-chains'), patchJson((j) => chainOff(j, 'not_configured')));
    await reloadOverview();
    const todo = admin.locator('[data-panel="p-overview"] [data-todo]');
    await expect(todo).toContainText('BSC：合约地址没配齐');
    await expect(admin.locator('[data-pcount="status"]')).toHaveText('!');
    await admin.click('[data-tab="p-status"]');
    const p = admin.locator('[data-panel="p-status"]');
    await expect(p.locator('[data-wallet-status]')).toBeVisible();
    const card = p.locator('[data-chain-card="bsc"]');
    await expect(card).toHaveClass(/chain-bad/);
    await expect(card.locator('.st-rejected')).toBeVisible();
    await expect(card.locator('.later-tag')).toHaveCount(0);
    await expect(p.locator('[data-wallet-status] .hero-bad')).toContainText('BSC');
    await expect(p.locator('[data-wallet-status]')).not.toContainText('开通的链都正常');
    await expect(p.locator('[data-loading]')).toHaveCount(0);
    await admin.unroute(isWallet('wallet-chains'), { behavior: 'wait' });
  });

  test('TC-W20 以太坊发起账户 ETH 余额 0（手续费没估出来、low = true）：概览待处理有"以太坊 发起账户的 ETH 不够付手续费"、侧栏"归集"亮"!"', async () => {
    await adminTab('p-overview');
    await admin.route(isWallet('wallet-chains'), patchJson((j) => {
      for (const c of j.chains) if (c.chain === 'eth') c.operator = { ...c.operator, configured: true, gas: '0', symbol: 'ETH', batches_left: null, low: true };
    }));
    await reloadOverview();
    const todo = admin.locator('[data-panel="p-overview"] [data-todo]');
    await expect(todo).toContainText('以太坊 发起账户的 ETH 不够付手续费');
    await expect(todo.locator('tbody tr', { hasText: '不够付手续费' })).toContainText('0 ETH');
    await expect(admin.locator('[data-pcount="sweep"]')).toHaveText('!');
    await expect(admin.locator('[data-pcount="sweep"]')).toHaveClass(/badge-bad/);
    await admin.unroute(isWallet('wallet-chains'), { behavior: 'wait' });
  });

});
