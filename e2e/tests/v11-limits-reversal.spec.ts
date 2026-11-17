import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonl, decodeQP, MAILS, KYB_ENV, TMP } from '../stack.mjs';
// @ts-ignore 与后端同一份 TOTP 实现
import { totpCode, totpStep } from '../../server/kyb/totp.js';

// 测试先写（v1.1 开放 API 补接口的页面部分）：正式构建、真实接口，8102 端口的独立实例（e2e/stack.mjs）。
// 依据：v1.1 高保真原型（已通过，原型偏离 8 条照原型做）和用户路径、状态清单（A1、A2、A3、M1、M2、M3）；
//   每天上限按商户 + 全平台取小、冲正记欠款（有欠款不能提币，到账先还欠款，账本加"还欠款"一类、概览欠款一格一直显示、冲正记录可标记已处理、
//   全平台总上限改到低于今天已通过只提醒不挡）。接口约定见 test/qa-v11-daily-limit.test.js、test/qa-v11-reversal.test.js 的开头。
// 研发补的替身接口（只在本地 FAKE_TRON 时存在，和 /__fake/tick/ 一样）：
//   POST /__fake/recheck/ { gone: [<交易哈希>], unreachable: boolean, now: <毫秒> } → 用替身链适配器跑一次 reversal.recheckDeposits：
//     gone 里的交易 check 返回 false，unreachable 为 true 时 check 一律抛错（节点连不上），其余返回 true；now 不传为现在。返回 recheckDeposits 的结果。
// 页面钩子（研发照着加）：
//   运营后台 · 打款审核（data-tab="p-withdrawals"）：今天已通过卡 [data-today-card]（全平台：已通过 / 上限），每家商户一行 [data-today-merchant="<商户编号>"]
//     （已通过 / 上限、还能过）；待审核行 [data-payout-row="<单号>"] 加 data-limit-check="ok | merchant | platform | per_item"，
//     "上限检查"一格写"超商户每天上限" / "超全平台每天上限"；有超限时顶部写"其中 N 笔超了今天的上限"；
//     审核弹窗三行检查（单笔每批、这个商户、全平台），超限时 [data-pdialog-ok] 灰掉并写"这个商户今天…" / "全平台今天…"，给 [data-goto-limits]（去改上限）。
//   改上限弹窗（[data-edit-limits]）：多一项 #pl-perMerchantDay（"每个商户每天上限"，注明对所有商户一起生效）；商户每天 > 全平台每天时输入框下红字（含"不能大于全平台"）、不保存；
//     全平台每天低于今天已通过时 [data-limit-warn] 黄字"今天剩下的单都会留在待审核"，照样能保存。
//   运营后台 · 异常到账（data-tab="p-anomalies"）：子标签 [data-anomaly-tab="reversal"]（冲正，未处理的有红色数字）；每笔冲正一行 [data-reversal-row="<交易哈希>"]
//     （冲正时间、商户、客户、链、哈希、到账、扣回、记成欠款、回调状态）；点一行看详情时间线 [data-reversal-timeline]；"标记已处理" [data-reversal-handle]；
//     另一张表 [data-recheck-inconclusive]"复核没下结论的（不会冲正）"。
//   商户后台 · 概览：欠款一格 [data-debt]（一直显示：没欠款写 0.00 和"没有欠款"）；有欠款时红框 [data-debt-alert]"你有欠款 X USDT，还清前不能提币"
//     + 按钮 [data-goto-reversed]（跳到交易页并勾上"只看已冲正" #tx-only-reversed）。
//   商户后台 · 交易：到账里冲正过的标"已冲正"[data-reversed]；账本类型有"冲正""还欠款"，加一列"变动后欠款"。
//   商户后台 · 提币：有欠款时红框 [data-debt-block]（含"用 API 提交也会被拒"），表单的提交按钮 [data-mw-submit] 灰掉；还清后自动恢复。
const B = 'http://127.0.0.1:8102';
const U = 1_000_000;
const ADMIN_PW = 'e2e-v11-admin-password';
const M_EMAIL = 'finance@v11-e2e.example';
const M_PW = 'v11 e2e merchant password';
const STATE = resolve(TMP, 'v11-e2e.json');
const ASTATE = resolve(TMP, 'v11-e2e-admin.json'), MSTATE = resolve(TMP, 'v11-e2e-merchant.json');
type St = { adminSecret: string; merchantSecret: string; ma: string; mb: string; txid: string };
const st: St = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { adminSecret: '', merchantSecret: '', ma: '', mb: '', txid: '' };
const lastStep: Record<string, number> = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')).lastStep || {}) : {};
const save = () => writeFileSync(STATE, JSON.stringify({ ...st, lastStep }));
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
const rndEvm = () => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

test.describe('TC-V11 每天上限按商户算、冲正和欠款（页面）', () => {
  test.setTimeout(180_000);
  test.use({ actionTimeout: 15_000 });
  let actx: BrowserContext, mctx: BrowserContext, admin: Page, merchant: Page;
  test.beforeAll(async ({ browser }) => {
    actx = await browser.newContext({ baseURL: B, ...(existsSync(ASTATE) ? { storageState: ASTATE } : {}) }); admin = await actx.newPage();
    mctx = await browser.newContext({ baseURL: B, ...(existsSync(MSTATE) ? { storageState: MSTATE } : {}) }); merchant = await mctx.newPage();
    await admin.goto('/admin/'); await merchant.goto('/zh/merchant/');
  });
  test.afterEach(() => save());
  test.afterAll(async () => { await actx?.close(); await mctx?.close(); });

  const tick = async () => { const r = await admin.request.get(`${B}/__fake/tick/`); expect(r.status()).toBe(200); };
  const fake = async (path: string, data: unknown) => { const r = await admin.request.post(`${B}/__fake/${path}/`, { data }); expect(r.status(), `${path}: ${await r.text()}`).toBe(200); return r.json(); };
  const sql = async (q: string, params: unknown[] = []) => (await admin.request.post(`${B}/__fake/sql/`, { data: { sql: q, params } })).json();
  const call = (page: Page, base: string) => (a: string, body?: unknown, qs = '') => page.evaluate(async ([base, a, body, qs]) => {
    const r = await fetch(`${base}?a=${a}${qs}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, [base, a, body, qs] as const);
  const mcall = (a: string, body?: unknown, qs = '') => call(merchant, '/api/merchant/')(a, body, qs);
  const wcall = (a: string, body?: unknown, qs = '') => call(admin, '/api/wallet/')(a, body, qs);
  async function adminTab(tab: string) {
    await admin.goto('/admin/');
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    await admin.click(`[data-tab="${tab}"]`);
    await expect(admin.locator(`[data-panel="${tab}"]`)).toBeVisible();
    await expect(admin.locator(`[data-panel="${tab}"] [data-loading]`)).toHaveCount(0);
  }
  async function merchantTab(tab: string) {
    await merchant.goto('/zh/merchant/');
    await merchant.click(`[data-mtab="${tab}"]`);
    await expect(merchant.locator(`[data-mpanel="${tab}"]`)).toBeVisible();
  }
  const dlg = () => admin.locator('[data-pdialog]');
  /** 直接写一笔待审核的提币（冻结一起记上），返回单号 */
  async function pending(mid: string, amount: number) {
    const id = `WD-V11-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    await sql(`update balances set available = available - $2, frozen = frozen + $2 where merchant_id = $1`, [mid, amount * U]);
    await sql(`insert into withdrawals (id, merchant_id, kind, to_address, amount, fee, source, status, chain) values ($1, $2, 'payout', $3, $4, 0, 'api', 'pending', 'eth')`, [id, mid, rndEvm(), amount * U]);
    return id;
  }
  const limits = async (values: Record<string, string>) => {
    const r = await wcall('payout-limits-save', { values, reason: '端到端测试', code: await code(st.adminSecret) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  test('TC-V11-00 准备：后台登录；开通商户 A（登录商户后台）、商户 B；A 以太坊收到 100', async () => {
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
    const open = async (name: string, email: string) => {
      const r = await wcall('merchant-open', { name, email, fee_in: { ppm: 0, fixed: 0, min: 0 }, fee_out: { ppm: 0, fixed: 0, min: 0 }, order_mode: { enabled: true, low: 900000, high: 1100000, ttlMin: 30, lookbackH: 24 } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.id as string;
    };
    st.ma = await open('V11 Alpha Ltd', M_EMAIL);
    st.mb = await open('V11 Beta Ltd', 'ops@v11-beta.example');
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
    await expect(merchant.locator('[data-merchant-name]')).toHaveText('V11 Alpha Ltd');
    await mctx.storageState({ path: MSTATE });
    expect((await mcall('customer-save', { customer_id: 'c1' })).status).toBe(200);
    const o = await mcall('order-create', { customer_id: 'c1', merchant_order_no: 'V11-1', amount: '100', chain: 'eth' });
    await fake('evm/pay', { chain: 'eth', to: o.body.address, amount: 100 * U });
    await tick();
    expect((await mcall('overview')).body.available).toBe('100.00');
    st.txid = (await sql(`select txid from deposits where merchant_id = $1 order by id desc limit 1`, [st.ma]))[0].txid;
    // 打款审核用的余额（直接改，不经过链）
    await sql(`update balances set available = available + $2 where merchant_id = $1`, [st.mb, 5_000 * U]);
  });

  test('TC-V11-01（A1-1～A1-4）打款审核：今天已通过分全平台和每家商户；超商户每天、超全平台每天分开写；超限的"通过"灰掉、给去改上限', async () => {
    await limits({ perItem: '1000', perBatch: '1500', perDay: '1500', perMerchantDay: '1000' });
    await sql(`update balances set available = available + $2 where merchant_id = $1`, [st.ma, 2_000 * U]);
    const a900 = await pending(st.ma, 900), b500 = await pending(st.mb, 500);
    expect((await wcall('payout-approve', { ids: [a900, b500] })).body.approved).toHaveLength(2);
    const a200 = await pending(st.ma, 200), b200 = await pending(st.mb, 200), b50 = await pending(st.mb, 50);
    await adminTab('p-withdrawals');
    const panel = admin.locator('[data-panel="p-withdrawals"]');
    const card = panel.locator('[data-today-card]');
    await expect(card).toContainText('1,400.00');
    await expect(card).toContainText('1,500.00');
    await expect(card.locator(`[data-today-merchant="${st.ma}"]`)).toContainText('900.00');
    await expect(card.locator(`[data-today-merchant="${st.ma}"]`)).toContainText('1,000.00');
    await expect(card.locator(`[data-today-merchant="${st.ma}"]`)).toContainText('100.00'); // 还能过
    await expect(card.locator(`[data-today-merchant="${st.mb}"]`)).toContainText('500.00');
    await expect(panel).toContainText('笔超了今天的上限');
    await expect(panel.locator(`[data-payout-row="${a200}"]`)).toHaveAttribute('data-limit-check', 'merchant');
    await expect(panel.locator(`[data-payout-row="${a200}"]`)).toContainText('超商户每天上限');
    await expect(panel.locator(`[data-payout-row="${b200}"]`)).toHaveAttribute('data-limit-check', 'platform');
    await expect(panel.locator(`[data-payout-row="${b200}"]`)).toContainText('超全平台每天上限');
    await expect(panel.locator(`[data-payout-row="${b50}"]`)).toHaveAttribute('data-limit-check', 'ok');
    // 审核弹窗：超商户每天
    await panel.locator(`[data-payout-row="${a200}"]`).click();
    await expect(dlg()).toContainText('这个商户今天');
    await expect(dlg()).toContainText('全平台今天');
    await expect(admin.locator('[data-pdialog-ok]')).toBeDisabled();
    await expect(dlg().locator('[data-goto-limits]')).toBeVisible();
    await admin.keyboard.press('Escape');
    // 超全平台每天
    await panel.locator(`[data-payout-row="${b200}"]`).click();
    await expect(dlg()).toContainText('全平台今天');
    await expect(admin.locator('[data-pdialog-ok]')).toBeDisabled();
    await admin.keyboard.press('Escape');
    // 没超的能过；"今天已通过"马上变
    await panel.locator(`[data-payout-row="${b50}"]`).click();
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).not.toBeVisible();
    await expect(panel.locator('[data-today-card]')).toContainText('1,450.00');
    await expect(panel.locator(`[data-today-merchant="${st.mb}"]`)).toContainText('550.00');
    expect((await sql(`select status from withdrawals where id = $1`, [a200]))[0].status).toBe('pending');
  });

  test('TC-V11-02（A2-1～A2-2）改上限：多一项"每个商户每天上限"；商户每天 > 全平台每天标红不保存；全平台每天低于今天已通过只黄字提醒、照样保存', async () => {
    await adminTab('p-withdrawals');
    const panel = admin.locator('[data-panel="p-withdrawals"]');
    await expect(panel.locator('[data-payout-limits]')).toContainText('每个商户每天');
    await panel.locator('[data-edit-limits]').click();
    await expect(dlg()).toContainText('对所有商户一起生效');
    await dlg().locator('#pl-perMerchantDay').fill('40000');
    await dlg().locator('#pl-perDay').fill('30000');
    await dlg().locator('#pl-perBatch').fill('20000');
    await dlg().locator('#pl-reason').fill('端到端测试');
    await dlg().locator('#pl-code').fill(await code(st.adminSecret));
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('不能大于全平台');
    expect((await wcall('payout-limits')).body.perMerchantDay).toBe('1000.00');
    // 全平台每天 1,000 < 今天已通过 1,450：黄字提醒，不挡
    await dlg().locator('#pl-perMerchantDay').fill('1000');
    await dlg().locator('#pl-perDay').fill('1000');
    await dlg().locator('#pl-perBatch').fill('1000');
    await expect(dlg().locator('[data-limit-warn]')).toContainText('今天剩下的单都会留在待审核');
    await dlg().locator('#pl-code').fill(await code(st.adminSecret));
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).not.toBeVisible();
    expect((await wcall('payout-limits')).body.perDay).toBe('1000.00');
    await limits({ perItem: '5000', perBatch: '20000', perDay: '30000', perMerchantDay: '30000' }); // 恢复默认
  });

  test('TC-V11-03（A3-1～A3-3、M1-2、M2-1、M2-2、M3-1）到账被链上撤回：自动冲正、余额不够记欠款；后台冲正记录可标记已处理；商户看到欠款、提币被挡', async () => {
    await sql(`update balances set available = 0 where merchant_id = $1`, [st.ma]); // 钱已经花掉
    let reversed = false;
    for (let h = 1; h <= 24 && !reversed; h++) {
      await fake('recheck', { gone: [st.txid], now: Date.now() + h * 3_600_000 });
      reversed = (await sql(`select result from deposits where txid = $1`, [st.txid]))[0].result === 'reversed';
    }
    expect(reversed, '24 小时内要冲正').toBe(true);
    expect((await mcall('overview')).body.debt).toBe('100.00');
    // 运营后台：异常到账 → 冲正
    await adminTab('p-anomalies');
    const p = admin.locator('[data-panel="p-anomalies"]');
    await p.locator('[data-anomaly-tab="reversal"]').click();
    const row = p.locator(`[data-reversal-row="${st.txid}"]`);
    await expect(row).toContainText('V11 Alpha Ltd');
    await expect(row).toContainText('100.00');
    await expect(row).toContainText('欠款');
    await row.click();
    await expect(p.locator('[data-reversal-timeline]')).toContainText('deposit.reversed');
    await expect(p.locator('[data-reversal-timeline]')).toContainText('账本追加冲正');
    await p.locator('[data-reversal-handle]').first().click();
    await expect(admin.locator('body')).toContainText('已标记为已处理');
    await expect(p.locator(`[data-reversal-row="${st.txid}"]`)).toContainText('已处理');
    // 商户：概览红框 → 只看已冲正
    await merchantTab('overview');
    const ov = merchant.locator('[data-mpanel="overview"]');
    await expect(ov.locator('[data-debt]')).toContainText('100.00');
    await expect(ov.locator('[data-debt-alert]')).toContainText('还清前不能提币');
    await ov.locator('[data-goto-reversed]').click();
    const tx = merchant.locator('[data-mpanel="transactions"]');
    await expect(tx).toBeVisible();
    await expect(tx.locator('#tx-only-reversed')).toBeChecked();
    await expect(tx.locator('[data-reversed]').first()).toContainText('已冲正');
    // 账本：冲正一行、变动后欠款一列
    await tx.getByRole('button', { name: '账本' }).click();
    await expect(tx).toContainText('冲正');
    await expect(tx).toContainText('变动后欠款');
    // 提币被挡
    await merchantTab('withdraw');
    const wd = merchant.locator('[data-mpanel="withdraw"]');
    await expect(wd.locator('[data-debt-block]')).toContainText('用 API 提交也会被拒');
    await expect(wd.locator('[data-mw-submit]')).toBeDisabled();
    const r = await mcall('withdraw', { kind: 'cashout', chain: 'eth', to: rndEvm(), amount: '1', code: await code(st.merchantSecret) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('debt_outstanding');
  });

  test('TC-V11-04（M1-2 还清后、L5）下一笔到账先还欠款：账本多"还欠款"、欠款到 0、提币恢复；概览欠款一格写 0.00 和"没有欠款"', async () => {
    const addr = (await sql(`select address from customer_addresses where merchant_id = $1 and chain = 'eth' limit 1`, [st.ma]))[0].address;
    await fake('evm/pay', { chain: 'eth', to: addr, amount: 150 * U });
    await tick();
    const o = (await mcall('overview')).body;
    expect(o.debt).toBe('0.00');
    expect(o.available).toBe('50.00');
    await merchantTab('overview');
    const ov = merchant.locator('[data-mpanel="overview"]');
    await expect(ov.locator('[data-debt]')).toContainText('0.00');
    await expect(ov.locator('[data-debt]')).toContainText('没有欠款');
    await expect(ov.locator('[data-debt-alert]')).toHaveCount(0);
    await merchantTab('transactions');
    const tx = merchant.locator('[data-mpanel="transactions"]');
    await tx.getByRole('button', { name: '账本' }).click();
    await expect(tx).toContainText('还欠款');
    await merchantTab('withdraw');
    await expect(merchant.locator('[data-mpanel="withdraw"] [data-debt-block]')).toHaveCount(0);
  });

  test('TC-V11-05（A3-4）复核时节点连不上：不冲正，后台"复核没下结论的"列出', async () => {
    const addr = (await sql(`select address from customer_addresses where merchant_id = $1 and chain = 'eth' limit 1`, [st.ma]))[0].address;
    await fake('evm/pay', { chain: 'eth', to: addr, amount: 20 * U });
    await tick();
    const tx = (await sql(`select txid from deposits where merchant_id = $1 order by id desc limit 1`, [st.ma]))[0].txid;
    for (const h of [2, 8, 14]) await fake('recheck', { unreachable: true, now: Date.now() + h * 3_600_000 });
    expect((await sql(`select result from deposits where txid = $1`, [tx]))[0].result).toBe('credited');
    await adminTab('p-anomalies');
    const p = admin.locator('[data-panel="p-anomalies"]');
    await p.locator('[data-anomaly-tab="reversal"]').click();
    await expect(p.locator('[data-recheck-inconclusive]')).toContainText('复核没下结论');
    await expect(p.locator('[data-recheck-inconclusive]')).toContainText(tx.slice(0, 10));
  });
});
