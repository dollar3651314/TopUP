import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonl, decodeQP, MAILS, KYB_ENV, TMP } from '../stack.mjs';
// @ts-ignore 与后端同一份 TOTP 实现
import { totpCode, totpStep } from '../../server/kyb/totp.js';

// 测试先写（第 2 批页面 + 第 3 批批量打款页面）：正式构建、真实接口，8098 端口的独立实例（e2e/stack.mjs）。
// 依据：第 2、3 批高保真原型（已通过）和原型说明；已定 TU-6、TU-7、Q15、Q16、P4、P5、Q-B1～Q-B7、Q-A1、TRON 每批 20 个，原型偏离 8 条都按原型做。
// 链上用 ETH、BSC 内存替身（APP_ENV=local）：替身要能执行 BatchPayout.pay 和 approve（研发补：/__fake/evm/pay/ 给热钱包打 USDT；
//   新增 /__fake/evm/block/ { chain, address } 让替身拒收某个收款人，用来造"整批回滚"）。本地热钱包 = config/wallets.json 的 local.evm.<链>.hot，
//   私钥是公开的测试私钥 11…11（和 local.hot 的 TRON 热钱包同一个，只用于自动化测试）；local.evm.<链>.payout 是替身里的 BatchPayout 地址。
// 本地不开通 TRON 合约钱包，第 2 批 TRON 页面（归集卡片能量行、系统状态能量租用）用浏览器拦截接口、喂规定好的返回来测页面怎么画；
//   接口字段（研发补进 wallet-sweep / wallet-chains）：批次 energy { mode: 'rented' | 'burn' | null, energy, cost_trx, order_id, reason }；
//   TRON 一行 operator 加 energy、rental_prepaid_trx；系统状态 TRON 卡加 energy_rental { prepaid_trx, month_cost_trx, burn_count, unit_price_sun, low, orders: [{ order_id, batch_id, status, energy, cost_trx, at }] }。
// 页面钩子（研发照着加）：
//   运营后台：菜单 data-tab="p-withdrawals" 文字改"打款审核"；[data-payout-oldest]（去审最早的一笔）；单笔行 [data-payout-row="<提币单号>"]（data-wait="warn" 超 30 分、"late" 超 1 小时）；
//     商户批量一行 [data-payout-group="<批次号>"]；审核弹窗 [data-pdialog] 里 [data-review-item="<单号>"] 复选框、#pr-reason、[data-payout-reject]；
//     按链凑批卡 [data-payout-plan="<链>"]、签名按钮 [data-payout-sign="<链>"]、去改额度 [data-goto-allowance]；签名四步 [data-sign-step] 当前一步带 .on，
//     第 1 步每笔 [data-decoded-row]（通过的有 .ok，对不上的有 .bad）；动态码 #ps-code、热钱包私钥 #ps-hot；批次明细 [data-payout-batch="<批次号>"]
//   钱包设置（data-tab="p-wallet"）：每条链一张卡 [data-wallet-card="eth|bsc|tron"]；授权额度 [data-allowance="<链>"]、改额度 [data-allowance-edit="<链>"]；
//     改额度弹窗 #al-amount、#al-reason、#al-code、#ps-hot；TRON 卡 [data-legacy-addresses]
//   商户后台：菜单 data-mtab="payout-batch"（批量打款）；上传 input[type=file][data-mb-file]；第 2 步每行 [data-row-line="<行号>"]；#mb-only-valid；
//     第 3 步每条链 [data-sum-chain="<链>"]、[data-mb-available]、#mb-code、[data-mb-submit]；批次记录 [data-mb-batch="<批次号>"]、[data-mb-cancel]；
//     提币：#mw-chain（以太坊 / BSC / TRON）、#mw-to 变成该链已登记地址的下拉框
const B = 'http://127.0.0.1:8098';
const U = 1_000_000;
const ADMIN_PW = 'e2e-payout-admin-password';
const M_EMAIL = 'finance@payout-e2e.example';
const M_PW = 'payout e2e merchant password';
const HOT_KEY = '11'.repeat(32); // 公开的测试私钥（只用于自动化测试）
const STATE = resolve(TMP, 'payout-e2e.json');
const ASTATE = resolve(TMP, 'payout-e2e-admin.json'), MSTATE = resolve(TMP, 'payout-e2e-merchant.json');
type St = { adminSecret: string; merchantSecret: string; batch: string; cashout: string; mid: string };
const st: St = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { adminSecret: '', merchantSecret: '', batch: '', cashout: '', mid: '' };
const save = () => writeFileSync(STATE, JSON.stringify({ ...st, lastStep }));
const WALLETS = JSON.parse(readFileSync(new URL('../../config/wallets.json', import.meta.url), 'utf8')).local;
const rndEvm = () => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

// 用过的动态码时间步也存进状态文件：一个用例失败后 Playwright 会换一个新的 worker 进程，只放内存里会丢，
// 下一个用例就可能拿到同一个 30 秒里已经用过的动态码（bad_code）
const lastStep: Record<string, number> = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')).lastStep || {}) : {};
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

test.describe('TC-PB 批量打款（第 3 批）和第 2 批 TRON 页面', () => {
  test.setTimeout(180_000);
  // 页面还没做时点击会一直等到用例超时：每个操作最多等 15 秒，红得快一些、错误信息直接指到缺的那个元素
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
  const fake = async (path: string, data: unknown) => { const r = await admin.request.post(`${B}/__fake/${path}/`, { data }); expect(r.status(), path).toBe(200); return r.json(); };
  const sql = async (q: string) => (await admin.request.post(`${B}/__fake/sql/`, { data: { sql: q } })).json();
  const call = (page: Page, base: string) => (a: string, body?: unknown, qs = '') => page.evaluate(async ([base, a, body, qs]) => {
    const r = await fetch(`${base}?a=${a}${qs}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, [base, a, body, qs] as const);
  const mcall = (a: string, body?: unknown, qs = '') => call(merchant, '/api/merchant/')(a, body, qs);
  const wcall = (a: string, body?: unknown, qs = '') => call(admin, '/api/wallet/')(a, body, qs);
  const isWallet = (name: string) => (url: URL) => url.pathname === '/api/wallet/' && url.searchParams.get('a') === name;
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
  async function merchantTab(tab: string) {
    await merchant.click(`[data-mtab="${tab}"]`);
    await expect(merchant.locator(`[data-mpanel="${tab}"]`)).toBeVisible();
  }
  const csvFile = (rows: string[][]) => ({ name: 'payouts.csv', mimeType: 'text/csv', buffer: Buffer.from(['chain,to,amount,customer_id,merchant_ref', ...rows.map((r) => r.join(','))].join('\n')) });
  const dlg = () => admin.locator('[data-pdialog]');

  test('TC-PB00 准备：本地热钱包和 BatchPayout 写在 config/wallets.json；后台登录；开通商户（每笔付款手续费 1 USDT）→ 登录；商户以太坊收到 30,000；热钱包有 USDT', async () => {
    for (const c of ['eth', 'bsc']) {
      expect.soft(WALLETS.evm[c]?.hot, `config/wallets.json local.evm.${c}.hot`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect.soft(WALLETS.evm[c]?.payout, `config/wallets.json local.evm.${c}.payout`).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
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
    st.cashout = rndEvm();
    const r = await wcall('merchant-open', { name: 'Payout E2E Ltd', email: M_EMAIL, fee_in: { ppm: 0, fixed: 0, min: 0 }, fee_out: { ppm: 0, fixed: 1_000_000, min: 0 }, order_mode: { enabled: true, low: 900000, high: 1100000, ttlMin: 30, lookbackH: 24 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    st.mid = r.body.id;
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
    await expect(merchant.locator('[data-merchant-name]')).toHaveText('Payout E2E Ltd');
    await mctx.storageState({ path: MSTATE });
    expect((await mcall('customer-save', { customer_id: 'fund' })).status).toBe(200);
    const o = await mcall('order-create', { customer_id: 'fund', merchant_order_no: 'FUND-1', amount: '1', chain: 'eth' });
    await fake('evm/pay', { chain: 'eth', to: o.body.address, amount: 30_000 * U });
    for (const c of ['eth', 'bsc']) if (WALLETS.evm[c]?.hot) await fake('evm/pay', { chain: c, to: WALLETS.evm[c].hot, amount: 15_000 * U });
    await tick();
    expect((await mcall('overview')).body.available).toBe('30000.00');
  });

  test('TC-PB01 商户批量打款三步：上传 → 逐行检查（地址按链、小数位、链名、重复行警告）→ 按链汇总（付款手续费、合计、余额一个数）+ 动态码 → 只提交没问题的行', async () => {
    await merchantTab('payout-batch');
    const p = merchant.locator('[data-mpanel="payout-batch"]');
    await expect(p).toContainText('选择表格文件');
    const a = rndEvm(), b = rndEvm();
    await p.locator('input[type=file][data-mb-file]').setInputFiles(csvFile([
      ['eth', a, '100'], ['eth', a, '100'], ['bsc', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '5'], ['bsc', b, '1.0000001'], ['btc', b, '1'], ['TRON', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '20'],
    ]));
    // 第 2 步
    await expect(p.locator('[data-row-line="1"]')).toContainText('重复');
    await expect(p.locator('[data-row-line="2"]')).toContainText('重复');
    await expect(p.locator('[data-row-line="3"]')).toContainText('地址');
    await expect(p.locator('[data-row-line="4"]')).toContainText('小数');
    await expect(p.locator('[data-row-line="5"]')).toContainText('链');
    await expect(p).toContainText('3 行有问题');
    // 有问题的行不勾"只提交没问题的行"就不能往下走
    await p.locator('#mb-only-valid').check();
    await p.locator('[data-mb-next]').click();
    // 第 3 步：按链汇总；网络费不另收（只有付款手续费一列）
    await expect(p.locator('[data-sum-chain="eth"]')).toContainText('200.00');
    await expect(p.locator('[data-sum-chain="eth"]')).toContainText('2.00');
    await expect(p.locator('[data-sum-chain="tron"]')).toContainText('21.00');
    await expect(p).not.toContainText('网络费另收');
    await expect(p.locator('[data-mb-available]')).toContainText('30,000.00');
    await p.locator('#mb-code').fill(await code(st.merchantSecret));
    await p.locator('[data-mb-submit]').click();
    await expect(p).toContainText('已提交 3 笔');
    const list = await mcall('payout-batches');
    st.batch = list.body.items[0].batch_no;
    await expect(p.locator(`[data-mb-batch="${st.batch}"]`)).toContainText('待审核');
  });

  test('TC-PB02 商户上传：501 行整张不收；余额不够时第 3 步提交按钮禁用并写原因；动态码错不提交', async () => {
    await merchantTab('payout-batch');
    const p = merchant.locator('[data-mpanel="payout-batch"]');
    await p.locator('[data-mb-reset]').click().catch(() => {});
    await p.locator('input[type=file][data-mb-file]').setInputFiles(csvFile(Array.from({ length: 501 }, () => ['tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '1'])));
    await expect(p).toContainText('最多 500');
    await p.locator('[data-mb-reset]').click();
    await p.locator('input[type=file][data-mb-file]').setInputFiles(csvFile([['bsc', rndEvm(), '99999']]));
    await p.locator('[data-mb-next]').click();
    await expect(p.locator('[data-mb-submit]')).toBeDisabled();
    await expect(p).toContainText('余额不够');
    await p.locator('[data-mb-reset]').click();
    await p.locator('input[type=file][data-mb-file]').setInputFiles(csvFile([['bsc', rndEvm(), '1']]));
    await p.locator('[data-mb-next]').click();
    await p.locator('#mb-code').fill('000000');
    await p.locator('[data-mb-submit]').click();
    await expect(p).toContainText('动态码');
  });

  test('TC-PB03 商户可以取消还没审核的批量打款，退回余额', async () => {
    await merchantTab('payout-batch');
    const p = merchant.locator('[data-mpanel="payout-batch"]');
    await p.locator('[data-mb-reset]').click().catch(() => {});
    await p.locator('input[type=file][data-mb-file]').setInputFiles(csvFile([['bsc', rndEvm(), '10'], ['bsc', rndEvm(), '10']]));
    await p.locator('[data-mb-next]').click();
    await p.locator('#mb-code').fill(await code(st.merchantSecret));
    await p.locator('[data-mb-submit]').click();
    const no = (await mcall('payout-batches')).body.items[0].batch_no;
    const before = Number((await mcall('overview')).body.available);
    await p.locator(`[data-mb-batch="${no}"] [data-mb-cancel]`).click();
    await merchant.locator('[data-mdialog-ok], [data-pdialog-ok]').first().click();
    await expect(p.locator(`[data-mb-batch="${no}"]`)).toContainText('已取消');
    expect(Number((await mcall('overview')).body.available)).toBe(before + 22);
  });

  test('TC-PB04 提币选链（P5）：余额一个数；没登记地址的链标出来；只能选该链登记过的地址', async () => {
    // 后台给商户登记 BSC 的提币地址（按链登记：{ chain, address }）
    const saved = await wcall('merchant-save', { id: st.mid, cashout_wallets: [{ chain: 'bsc', address: st.cashout }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await merchant.reload();
    await merchantTab('withdraw');
    const p = merchant.locator('[data-mpanel="withdraw"]');
    await expect(p.locator('#mw-chain')).toBeVisible();
    await p.locator('#mw-chain').selectOption('eth');
    await expect(p).toContainText('没有登记');
    await p.locator('#mw-chain').selectOption('bsc');
    await expect(p.locator('#mw-to option')).toHaveCount(1);
    await expect(p.locator('#mw-to')).toHaveValue(new RegExp(st.cashout, 'i'));
    await p.locator('#mw-amt').fill('5');
    await p.locator('#mw-code').fill(await code(st.merchantSecret));
    await p.locator('.wd-form button[type="submit"]').click();
    await expect(p.locator('tbody tr').first()).toContainText('BSC');
    await expect(p.locator('tbody tr').first()).toContainText('待审核');
  });

  test('TC-PB05 打款审核（改名）：大按钮去审最早的一笔；商户批量逐行勾选、一次审完（不勾的要填原因、驳回退冻结）；单笔一单一审', async () => {
    await adminTab('p-withdrawals');
    await expect(admin.locator('[data-tab="p-withdrawals"]')).toContainText('打款审核');
    const panel = admin.locator('[data-panel="p-withdrawals"]');
    await expect(panel.locator('[data-payout-oldest]')).toBeVisible();
    const g = panel.locator(`[data-payout-group="${st.batch}"]`);
    await expect(g).toContainText('3 笔');
    await g.click();
    const items = dlg().locator('[data-review-item]');
    await expect(items).toHaveCount(3);
    const ids = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-review-item')!));
    await items.nth(2).uncheck(); // 驳回第 3 笔（TRON 那笔）；两笔以太坊留给 TC-PB11 签名
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('原因'); // 有不勾的要填原因
    await dlg().locator('#pr-reason').fill('收款地址重复');
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).not.toBeVisible();
    const rows = await sql(`select id, status from withdrawals where id in ('${ids.join("','")}') order by id`);
    expect(rows.map((r: any) => r.status).sort()).toEqual(['approved', 'approved', 'rejected']);
    // 单笔：商户 TC-PB04 那笔提币
    const single = panel.locator('[data-payout-row]').first();
    await single.click();
    await expect(dlg()).toContainText('登记地址');
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).not.toBeVisible();
    // 商户那边批次显示"部分被驳回"
    await merchantTab('payout-batch');
    await expect(merchant.locator(`[data-mb-batch="${st.batch}"]`)).toContainText('部分被驳回');
  });

  test('TC-PB06 打款审核：等了超 30 分钟的标橙、超 1 小时的标红', async () => {
    const no = (await mcall('withdraw', { kind: 'payout', chain: 'bsc', to: rndEvm(), amount: '1', code: await code(st.merchantSecret) })).body.withdrawal_no;
    const old = (await mcall('withdraw', { kind: 'payout', chain: 'bsc', to: rndEvm(), amount: '1', code: await code(st.merchantSecret) })).body.withdrawal_no;
    await sql(`update withdrawals set created_at = now() - interval '40 minutes' where id = '${no}'`);
    await sql(`update withdrawals set created_at = now() - interval '70 minutes' where id = '${old}'`);
    await adminTab('p-withdrawals');
    const panel = admin.locator('[data-panel="p-withdrawals"]');
    await expect(panel.locator(`[data-payout-row="${no}"]`)).toHaveAttribute('data-wait', 'warn');
    await expect(panel.locator(`[data-payout-row="${old}"]`)).toHaveAttribute('data-wait', 'late');
    // 最早的一笔在最前，大按钮打开的就是它
    await panel.locator('[data-payout-oldest]').click();
    await expect(dlg()).toContainText(old);
    await dlg().locator('[data-payout-reject]').click();
    await dlg().locator('#pr-reason').fill('测试驳回');
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).not.toBeVisible();
  });

  test('TC-PB07 按链凑批卡片：显示每批实际上限（三者取最小、说出是哪个），额度不够时签名按钮禁用、写原因、给"去改授权额度"', async () => {
    await adminTab('p-withdrawals');
    const card = admin.locator('[data-panel="p-withdrawals"] [data-payout-plan="eth"]');
    await expect(card).toBeVisible();
    // 授权额度还是 0（还没授权过）：被额度挡住
    await expect(card.locator('[data-payout-sign="eth"]')).toBeDisabled();
    await expect(card).toContainText('授权额度');
    await expect(card.locator('[data-goto-allowance]')).toBeVisible();
    await card.locator('[data-goto-allowance]').click();
    await expect(admin.locator('[data-panel="p-wallet"]')).toBeVisible();
  });

  test('TC-PB08 改授权额度（以太坊）：填新额度和原因 → 签第 1 笔归零 → 签第 2 笔设新值 → 读回链上额度；两笔之间写明以太坊打款暂停', async () => {
    await adminTab('p-wallet');
    const card = admin.locator('[data-wallet-card="eth"]');
    await card.locator('[data-allowance-edit="eth"]').click();
    await dlg().locator('#al-amount').fill('10000');
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('原因'); // 原因必填
    await dlg().locator('#al-reason').fill('补到热钱包上限');
    await dlg().locator('#al-code').fill(await code(st.adminSecret));
    await admin.click('[data-pdialog-ok]');
    // 当前额度是 0：以太坊只要一笔；再改一次（非 0 → 非 0）才是两笔
    await dlg().locator('#ps-hot').fill(HOT_KEY);
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('10,000');
    await admin.keyboard.press('Escape');
    await card.locator('[data-allowance-edit="eth"]').click();
    await dlg().locator('#al-amount').fill('9000');
    await dlg().locator('#al-reason').fill('收紧');
    await dlg().locator('#al-code').fill(await code(st.adminSecret));
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('先归零');
    await expect(dlg()).toContainText('两笔之间以太坊打款暂停');
    await expect(dlg().locator('[data-sign-step].on')).toContainText('第 1 笔');
    await dlg().locator('#ps-hot').fill(HOT_KEY);
    await admin.click('[data-pdialog-ok]');
    await expect(dlg().locator('[data-sign-step].on')).toContainText('第 2 笔');
    await dlg().locator('#ps-hot').fill(HOT_KEY);
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('9,000');
    await admin.keyboard.press('Escape');
    await expect(card.locator('[data-allowance="eth"]')).toContainText('9,000');
    const audit = await sql(`select detail from pay_audit where action = 'payout.allowance' order by id`);
    expect(audit.map((a: any) => a.detail.reason)).toEqual(['补到热钱包上限', '收紧']);
  });

  test('TC-PB09 改授权额度（BSC 一笔）；TRON 卡没有授权额度', async () => {
    await adminTab('p-wallet');
    const card = admin.locator('[data-wallet-card="bsc"]');
    await card.locator('[data-allowance-edit="bsc"]').click();
    await dlg().locator('#al-amount').fill('10000');
    await dlg().locator('#al-reason').fill('首次授权');
    await dlg().locator('#al-code').fill(await code(st.adminSecret));
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).not.toContainText('先归零');
    await dlg().locator('#ps-hot').fill(HOT_KEY);
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('10,000');
    await admin.keyboard.press('Escape');
    await expect(admin.locator('[data-wallet-card="tron"] [data-allowance-edit]')).toHaveCount(0);
  });

  test('TC-PB10 钱包设置（P4、Q-A1）：三条链各一张卡（冷钱包、热钱包、授权额度、发起账户）；以太坊、BSC 没有"主助记词"；TRON 只留"旧地址 N 个，照常归集"、没有初始化', async () => {
    await adminTab('p-wallet');
    for (const c of ['eth', 'bsc', 'tron']) {
      const card = admin.locator(`[data-wallet-card="${c}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText('冷钱包');
      await expect(card).toContainText('热钱包');
      await expect(card).toContainText('发起账户');
    }
    for (const c of ['eth', 'bsc']) await expect(admin.locator(`[data-wallet-card="${c}"]`)).not.toContainText('助记词');
    const tron = admin.locator('[data-wallet-card="tron"]');
    await expect(tron.locator('[data-legacy-addresses]')).toContainText('照常归集');
    await expect(admin.locator('[data-panel="p-wallet"]')).not.toContainText('初始化主助记词');
    await expect(admin.locator('[data-panel="p-wallet"]')).toContainText('config/wallets.json');
  });

  test('TC-PB11 签名四步（以太坊）：核对每一笔（解码对比）→ 动态码 + 热钱包私钥 → 签名并提交 → 链上确认；私钥签完清空', async () => {
    await adminTab('p-withdrawals');
    const card = admin.locator('[data-panel="p-withdrawals"] [data-payout-plan="eth"]');
    await expect(card.locator('[data-payout-sign="eth"]')).toBeEnabled();
    await card.locator('[data-payout-sign="eth"]').click();
    await expect(dlg().locator('[data-sign-step].on')).toContainText('核对');
    const rows = dlg().locator('[data-decoded-row]');
    await expect(rows).toHaveCount(2); // TC-PB05 通过的两笔以太坊
    await expect(rows.locator('.ok')).toHaveCount(2);
    await dlg().locator('[data-sign-next]').click();
    await dlg().locator('#ps-code').fill(await code(st.adminSecret));
    await dlg().locator('#ps-hot').fill('22'.repeat(32));
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('不是热钱包');
    await dlg().locator('#ps-hot').fill(HOT_KEY);
    await admin.click('[data-pdialog-ok]');
    await expect(dlg().locator('[data-sign-step].on')).toContainText('链上确认');
    await expect(admin.locator('#ps-hot')).toHaveCount(0);
    await tick();
    await tick();
    const done = await sql(`select status from withdrawals where chain = 'eth' and status = 'completed'`);
    expect(done.length).toBe(2);
  });

  test('TC-PB12 签名第 1 步：服务器给的交易被改过（金额 / 收款人和审核通过的不一致）时页面拦下、不能签名', async () => {
    const id = (await mcall('withdraw', { kind: 'payout', chain: 'bsc', to: rndEvm(), amount: '3', code: await code(st.merchantSecret) })).body.withdrawal_no;
    expect((await wcall('payout-approve', { ids: [id] })).status).toBe(200);
    // 把交易原文里这一笔的金额（BSC 18 位：3 × 10¹⁸）改成 4 × 10¹⁸：长度不变、RLP 照样合法，解码出来的金额和审核通过的不一致
    const word = (n: bigint) => n.toString(16).padStart(64, '0');
    await admin.route(isWallet('payout-plan'), patchJson((j) => {
      for (const b of j.batches || []) b.rawHex = String(b.rawHex).replace(word(3n * 10n ** 18n), word(4n * 10n ** 18n));
    }));
    await adminTab('p-withdrawals');
    await admin.locator('[data-panel="p-withdrawals"] [data-payout-sign="bsc"]').click();
    await expect(dlg().locator('[data-decoded-row] .bad')).not.toHaveCount(0);
    await expect(dlg()).toContainText('不一致');
    await expect(dlg().locator('[data-sign-next]')).toBeDisabled();
    await admin.unroute(isWallet('payout-plan'));
    await admin.keyboard.press('Escape');
  });

  test('TC-PB13 整批回滚（以太坊）：一个收款人被拒，回执失败 → 批次"整批回滚"，每笔回到已审核、可以重签；商户余额不动', async () => {
    const bad = rndEvm();
    const ids: string[] = [];
    for (const to of [rndEvm(), bad]) ids.push((await mcall('withdraw', { kind: 'payout', chain: 'eth', to, amount: '4', code: await code(st.merchantSecret) })).body.withdrawal_no);
    expect((await wcall('payout-approve', { ids })).status).toBe(200);
    const bal = (await mcall('overview')).body;
    await adminTab('p-withdrawals');
    await admin.locator('[data-panel="p-withdrawals"] [data-payout-sign="eth"]').click();
    await dlg().locator('[data-sign-next]').click();
    await fake('evm/block', { chain: 'eth', address: bad }); // 核对之后、签名之前，收款人被代币拉黑
    await dlg().locator('#ps-code').fill(await code(st.adminSecret));
    await dlg().locator('#ps-hot').fill(HOT_KEY);
    await admin.click('[data-pdialog-ok]');
    await tick(); await tick();
    await admin.keyboard.press('Escape');
    await adminTab('p-withdrawals');
    const panel = admin.locator('[data-panel="p-withdrawals"]');
    await expect(panel).toContainText('整批回滚');
    const rows = await sql(`select status from withdrawals where id in ('${ids.join("','")}')`);
    expect(rows.map((r: any) => r.status)).toEqual(['approved', 'approved']);
    expect((await mcall('overview')).body).toEqual(bal);
  });

  test('TC-PB14 处理时段（Q-B7）：东八区 23:00 以后商户提交，页面写"第二天 8:00 后处理"', async () => {
    await merchant.route((u) => u.pathname === '/api/merchant/' && u.searchParams.get('a') === 'payout-batch-submit', patchJson((j) => { j.service = { open: false, next_open_at: '2026-11-15T00:00:00.000Z' }; }));
    await merchantTab('payout-batch');
    const p = merchant.locator('[data-mpanel="payout-batch"]');
    await p.locator('[data-mb-reset]').click().catch(() => {});
    await p.locator('input[type=file][data-mb-file]').setInputFiles(csvFile([['bsc', rndEvm(), '1']]));
    await p.locator('[data-mb-next]').click();
    await p.locator('#mb-code').fill(await code(st.merchantSecret));
    await p.locator('[data-mb-submit]').click();
    await expect(p).toContainText('第二天 8:00 后处理');
    await merchant.unroute((u) => u.pathname === '/api/merchant/' && u.searchParams.get('a') === 'payout-batch-submit');
  });

  test('TC-PB15 TRON 打款（Q16、Q-B2、A2）：测试环境直接烧 TRX（不租能量）、一次签 N 笔；部分成功的批次写明成功几笔、失败的回到已审核待签名', async () => {
    await admin.route(isWallet('withdrawals'), patchJson((j) => {
      // A2（2026-11-14）：TRON 打款直接烧 TRX，后端给的就是 { mode: 'burn' }
      j.batches = [{ id: 'PB-TRON-1', chain: 'tron', status: 'partial', count: 3, ok: 2, failed: 1, energy: { mode: 'burn' },
        items: [{ id: 'WD-T1', status: 'completed' }, { id: 'WD-T2', status: 'approved', reason: 'OUT_OF_ENERGY' }, { id: 'WD-T3', status: 'completed' }] }];
    }));
    await adminTab('p-withdrawals');
    const b = admin.locator('[data-panel="p-withdrawals"] [data-payout-batch="PB-TRON-1"]');
    await expect(b).toContainText('部分成功');
    await expect(b).toContainText('2 笔成功');
    await expect(b).toContainText('回到已审核');
    await expect(b).toContainText('直接烧 TRX');
    for (const rent of ['确认后才租', '租到', '先租能量']) await expect(b).not.toContainText(rent); // 不说会租能量（"不租能量"这样的说明可以有）
    // TRON 凑批卡片也写明直接烧 TRX，不提租能量
    const card = admin.locator('[data-panel="p-withdrawals"] [data-payout-plan="tron"]');
    await expect(card).toContainText('直接烧 TRX');
    for (const rent of ['确认后才租', '租到', '先租能量']) await expect(card).not.toContainText(rent);
    await admin.unroute(isWallet('withdrawals'));
  });

  test('TC-PB16 C1：批量打款只能整批取消还没审核的部分——提币记录里批次中的单笔没有"取消"按钮，普通单笔提币照旧有', async () => {
    // 新建一批（2 笔）和一笔普通提币，都还没审核
    const sheet = ['chain,to,amount', `bsc,${rndEvm()},4`, `bsc,${rndEvm()},4`].join('\n');
    const sub = await mcall('payout-batch-submit', { csv: sheet, code: await code(st.merchantSecret) });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const batchIds: string[] = sub.body.accepted.map((x: any) => x.withdrawal_no);
    const single = (await mcall('withdraw', { kind: 'payout', chain: 'bsc', to: rndEvm(), amount: '2', code: await code(st.merchantSecret) })).body.withdrawal_no;
    try {
      await merchantTab('withdraw');
      const p = merchant.locator('[data-mpanel="withdraw"]');
      const row = (id: string) => p.locator('tbody tr', { hasText: id });
      // 先确认到了要检查的状态：三行都在、都是待审核
      for (const id of [...batchIds, single]) await expect(row(id)).toContainText('待审核');
      await expect(row(single).getByRole('button', { name: '取消' })).toHaveCount(1); // 对照：普通单笔照旧能取消
      for (const id of batchIds) await expect(row(id).getByRole('button', { name: '取消' })).toHaveCount(0);
    } finally {
      // 收尾（失败时也做）：整批取消、单笔取消，不留下待审核的单影响后面的用例；放在打款用例最后，不打乱前面用例看到的提币记录顺序
      expect((await mcall('payout-batch-cancel', { batch_no: sub.body.batch_no })).body.cancelled).toBe(2);
      expect((await mcall('withdraw-cancel', { withdrawal_no: single })).status).toBe(200);
    }
  });

  // ---------- 第 2 批 TRON 页面（本地不开通 TRON 合约钱包：拦截接口喂数据，测页面怎么画） ----------
  const tronSweep = (j: any) => {
    const t = j.chains.find((c: any) => c.chain === 'tron');
    Object.assign(t, {
      enabled: true, not_in_this_batch: false, scan_ok: true, estimate: { address_count: 25, total_usdt: '5200', over_threshold: 25, over_threshold_usdt: '5200' },
      operator: { configured: true, address: 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ', gas: '320.5', symbol: 'TRX', batches_left: 9, low: false, energy: '0', rental_prepaid_trx: '850' },
      batches: [
        { id: 'SW-T-AWAIT', status: 'awaiting_approval', chain: 'tron', provider: 'contract', total_usdt: '4000', address_count: 20, items: Array.from({ length: 20 }, (_, i) => ({ address: `TAddr${i}`, amount_usdt: '200', deploy: i < 4, status: 'pending' })), skipped: [], fee: { native: '120', symbol: 'TRX' }, energy: { mode: null } },
        { id: 'SW-T-RENT', status: 'sent', chain: 'tron', provider: 'contract', total_usdt: '800', address_count: 4, items: [], skipped: [], fee: { native: '30', symbol: 'TRX' }, energy: { mode: 'rented', energy: '1300000', cost_trx: '91.2', order_id: 'TS-1' } },
        { id: 'SW-T-BURN', status: 'sent', chain: 'tron', provider: 'contract', total_usdt: '400', address_count: 1, items: [], skipped: [], fee: { native: '30', symbol: 'TRX' }, energy: { mode: 'burn', reason: 'tronsave_timeout', energy: '400000' } },
      ],
    });
  };

  test('TC-T01 归集 TRON 标签可点：三格数字（发起账户能量、TronSave 预存余额、发起账户 TRX）；每批 ≤ 20 个地址；首次地址"要先部署"', async () => {
    await admin.route(isWallet('wallet-sweep'), patchJson(tronSweep));
    await adminTab('p-sweep');
    const panel = admin.locator('[data-panel="p-sweep"]');
    await panel.locator('[data-chain-tab="tron"]').click();
    await expect(panel).toContainText('发起账户能量');
    await expect(panel).toContainText('TronSave 预存余额');
    await expect(panel).toContainText('850');
    await expect(panel).toContainText('320.5');
    const c = panel.locator('[data-batch="SW-T-AWAIT"]');
    await expect(c).toContainText('20 个地址');
    await expect(c).toContainText('4 个要先部署');
    await expect(panel).not.toContainText('第 2 批上线后');
    await admin.unroute(isWallet('wallet-sweep'));
  });

  test('TC-T02 TRON 批次卡片的能量一行：确认后才租 / 租到多少花多少 TRX / 租失败已改烧 TRX', async () => {
    await admin.route(isWallet('wallet-sweep'), patchJson(tronSweep));
    await adminTab('p-sweep');
    const panel = admin.locator('[data-panel="p-sweep"]');
    await panel.locator('[data-chain-tab="tron"]').click();
    await expect(panel.locator('[data-batch="SW-T-AWAIT"] [data-energy-line]')).toContainText('确认后才租');
    await expect(panel.locator('[data-batch="SW-T-RENT"] [data-energy-line]')).toContainText('1,300,000');
    await expect(panel.locator('[data-batch="SW-T-RENT"] [data-energy-line]')).toContainText('91.2 TRX');
    await expect(panel.locator('[data-batch="SW-T-BURN"] [data-energy-line]')).toContainText('改烧 TRX');
    await admin.unroute(isWallet('wallet-sweep'));
  });

  test('TC-T03 TRON 归集确认弹窗：写明"确认后先租能量，租不到改烧 TRX，不再问你"；失败时写明没提交', async () => {
    await admin.route(isWallet('wallet-sweep'), patchJson(tronSweep));
    await admin.route(isWallet('wallet-sweep-approve'), (r) => r.fulfill({ status: 409, json: { error: { code: 'energy_and_trx_insufficient' } } }));
    await adminTab('p-sweep');
    const panel = admin.locator('[data-panel="p-sweep"]');
    await panel.locator('[data-chain-tab="tron"]').click();
    await panel.locator('[data-confirm="SW-T-AWAIT"]').click();
    await expect(dlg()).toContainText('确认后先租能量');
    await expect(dlg()).toContainText('改烧 TRX');
    await admin.click('[data-pdialog-ok]');
    await expect(dlg()).toContainText('没提交');
    await admin.unroute(isWallet('wallet-sweep-approve'));
    await admin.unroute(isWallet('wallet-sweep'));
    await admin.keyboard.press('Escape');
  });

  test('TC-T04 系统状态"TRON 能量租用"：预存余额（不够一批标红）、本月花费、改烧次数、租价、每一单的状态；写明充值由管理员自己做', async () => {
    await admin.route(isWallet('wallet-chains'), patchJson((j) => {
      const t = j.chains.find((c: any) => c.chain === 'tron') || (j.chains.push({ chain: 'tron' }), j.chains.at(-1));
      t.energy_rental = { prepaid_trx: '60', month_cost_trx: '412.8', burn_count: 2, unit_price_sun: 70, low: true,
        orders: [{ order_id: 'TS-1', batch_id: 'SW-T-RENT', status: 'filled', energy: '1300000', cost_trx: '91.2', at: '2026-11-14T02:00:00Z' }, { order_id: 'TS-2', batch_id: 'SW-T-BURN', status: 'timeout', energy: '400000', cost_trx: null, at: '2026-11-14T12:00:00Z' }] };
    }));
    await adminTab('p-status');
    const s = admin.locator('[data-panel="p-status"] [data-energy-rental]');
    await expect(s).toContainText('TRON 能量租用');
    await expect(s).toContainText('60');
    await expect(s.locator('.bad, .badge-bad, [data-low]').first()).toBeVisible();
    await expect(s).toContainText('412.8');
    await expect(s).toContainText('改烧');
    await expect(s).toContainText('70');
    await expect(s).toContainText('TS-1');
    await expect(s).toContainText('TS-2');
    await expect(s).toContainText('自己');
    await admin.unroute(isWallet('wallet-chains'));
  });
});
