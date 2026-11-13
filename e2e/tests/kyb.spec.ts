import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonl, decodeQP, MAILS, DATA_MAIN, KYB_ENV } from '../stack.mjs';
// @ts-ignore 与后端同一份 TOTP 实现（已用 RFC 6238 测试向量验证）
import { totpCode } from '../../server/kyb/totp.js';

// 开户（KYB）端到端：初始化后台 → 登录 → 后台发送开户链接 → 客户填写 4 步并上传、签名、提交
// → 后台要求补件 → 客户只改被开放的部分再提交 → 通过 → 删除。串行执行，共享同一个后台账号。
const PW = 'e2e-admin-password-1';
const COMPANY = 'Mekong Export Co';
const CLIENT = 'kyb-client@mekong.example';
const PDF = { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e test file\n') };
const PNG = { name: 'id.png', mimeType: 'image/png', buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]) };
let totpSecret = '';
let ref = '';
let adminCtx: BrowserContext;
let admin: Page;

const mailsTo = (addr: string) => readJsonl(MAILS).filter((m: any) => m.to.includes(addr)).map((m: any) => decodeQP(m.raw));
const linkIn = (mail: string) => mail.match(/https?:\/\/[^\s]+\/onboarding\/\?t=[A-Za-z0-9_-]+/)![0];
const cspErrors = (page: Page) => { const errs: string[] = []; page.on('console', (m) => /Content Security Policy/i.test(m.text()) && errs.push(m.text())); return errs; };

const browserGet = (page: Page, url: string) => page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: 'same-origin' });
  return { status: r.status, disposition: r.headers.get('content-disposition') || '', text: await r.text() };
}, url);

// 用鼠标在签名框里画一笔；先等页面滚动停下，避免坐标偏移
async function sign(page: Page) {
  const cv = page.locator('[data-signature]');
  await cv.scrollIntoViewIfNeeded();
  let box = (await cv.boundingBox())!;
  await expect.poll(async () => { const b = (await cv.boundingBox())!; const same = b.y === box.y; box = b; return same; }).toBe(true);
  await page.mouse.move(box.x + 20, box.y + box.height / 2); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * 18, box.y + box.height / 2 + (i % 2 ? -18 : 18));
  await page.mouse.up();
}

async function login(page: Page) {
  await page.goto('/admin/');
  await expect(page.locator('[data-view="login"]')).toBeVisible();
  await page.fill('#a-pw', PW);
  await page.fill('#a-otp', totpCode(totpSecret, Date.now()));
  await page.click('[data-login] button[type="submit"]');
  await expect(page.locator('[data-view="app"]')).toBeVisible();
  await page.click('[data-tab="apps"]'); // 登录后默认打开"概览"，开户的用例从开户申请开始
}
async function confirmDialog(page: Page) {
  await page.click('[data-dialog-ok]');
  await expect(page.locator('[data-dialog]')).not.toBeVisible();
}
async function fillText(page: Page, values: Record<string, string>) {
  for (const [name, v] of Object.entries(values)) await page.fill(`[name="${name}"]`, v);
}
async function next(page: Page, step: number) {
  await page.click('[data-next]');
  await expect(page.locator(`[data-step="${step}"]`)).toBeVisible();
}

test.describe.serial('TC-K 在线开户', () => {
  test.beforeAll(async ({ browser }) => {
    adminCtx = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
    admin = await adminCtx.newPage();
  });
  test.afterAll(async () => { await adminCtx.close(); });

  test('TC-K01 后台首次初始化：口令 + 密码 + 绑定验证器', async () => {
    const errs = cspErrors(admin);
    await admin.goto('/admin/');
    await expect(admin.locator('[data-view="setup"]')).toBeVisible();
    await admin.fill('#s-token', 'wrong-token');
    await admin.fill('#s-pw', PW); await admin.fill('#s-pw2', PW);
    await admin.click('[data-setup] button[type="submit"]');
    await expect(admin.locator('[data-setup-err]')).toBeVisible();
    await admin.fill('#s-token', KYB_ENV.ADMIN_SETUP_TOKEN);
    await admin.click('[data-setup] button[type="submit"]');
    await expect(admin.locator('[data-setup2]')).toBeVisible();
    await expect(admin.locator('[data-qr]')).toHaveAttribute('src', /^data:image\/png;base64,/);
    totpSecret = (await admin.locator('[data-secret]').textContent())!.replace(/\s/g, '');
    expect(totpSecret).toMatch(/^[A-Z2-7]{32}$/);
    await admin.fill('#s-otp', '000000');
    await admin.click('[data-setup2] button[type="submit"]');
    await expect(admin.locator('[data-setup2-err]')).toBeVisible();
    await admin.fill('#s-otp', totpCode(totpSecret, Date.now()));
    await admin.click('[data-setup2] button[type="submit"]');
    await expect(admin.locator('[data-view="login"]')).toBeVisible();
    // 已初始化后，不能再次初始化
    const again = await admin.request.post('/api/kyb/?g=admin&a=setup-begin', { data: { setupToken: KYB_ENV.ADMIN_SETUP_TOKEN, password: PW } });
    expect(again.status()).toBe(409);
    expect(errs).toEqual([]);
  });

  test('TC-K02 登录：密码或动态码错误被拒绝；正确后进入后台；会话 Cookie 为 HttpOnly', async () => {
    await admin.goto('/admin/');
    await admin.fill('#a-pw', PW); await admin.fill('#a-otp', '123456');
    await admin.click('[data-login] button[type="submit"]');
    await expect(admin.locator('[data-login-err]')).toBeVisible();
    await login(admin);
    // 导航上的数字登录后立即显示，0 也显示为"0"
    await expect(admin.locator('[data-count="apps"]')).toHaveText('0');
    await expect(admin.locator('[data-apps-body]')).toContainText('暂无申请'); // 空状态
    await expect(admin.locator('[data-count="apps"]')).toHaveAttribute('title', '待审核（已提交）：0');
    const c = (await adminCtx.cookies()).find((x) => x.name === 'topup_admin')!;
    expect(c.httpOnly).toBe(true); expect(c.sameSite).toBe('Strict');
  });

  test('TC-K03 后台手动发送开户链接，客户收到 30 天有效的专属链接', async () => {
    await admin.click('[data-tab="apps"]');
    await admin.click('[data-new-invite]');
    await admin.fill('#i-co', COMPANY); await admin.fill('#i-em', CLIENT);
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('已创建 TU-');
    ref = (await admin.locator('[data-toast]').textContent())!.match(/TU-\d{4}-\d{4}/)![0];

    const mail = mailsTo(CLIENT).at(-1)!;
    expect(mail).toContain('TopUP');
    expect(mail).toContain(ref);
    expect(mail).toMatch(/^from:.*TopUP/im); // 发件人是本产品（不出现其他公司的名字）
    const link = linkIn(mail);
    expect(new URL(link).searchParams.get('t')!.length).toBeGreaterThanOrEqual(43);
  });

  test('TC-K04 客户填写 4 步（中途离开可继续）、上传公司文件和身份证明、签名提交', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
    const page = await ctx.newPage();
    const errs = cspErrors(page);
    const link = linkIn(mailsTo(CLIENT).at(-1)!);
    await page.goto(link);
    await expect(page.locator('#ob-form')).toBeVisible();
    await expect(page.locator('[data-meta="company"]')).toHaveText(COMPANY);
    await expect(page.locator('[data-meta="ref"]')).toHaveText(ref);

    // ① 必填项为空时不能进入下一步
    await page.click('[data-next]');
    await expect(page.locator('[data-err-for="entity.legalName"]')).not.toBeEmpty();
    // 没有 LEI、税号、集团 / 母公司；联系方式在企业信息里
    for (const gone of ['entity.lei', 'entity.tin', 'entity.parent', 'contact.website', 'contact.otherContact', 'rep.name']) await expect(page.locator(`[name="${gone}"]`)).toHaveCount(0);
    await expect(page.locator('[data-step]')).toHaveCount(4);
    await fillText(page, {
      'entity.legalName': 'Mekong Export Company Limited', 'entity.legalForm': 'Limited liability company', 'entity.regNumber': '0312345678',
      'entity.incDate': '2019-03-12', 'entity.incPlace': 'Ho Chi Minh City, Vietnam', 'entity.regAddress': '12 Nguyen Hue, District 1', 'entity.physAddress': '12 Nguyen Hue, District 1',
      'entity.website': 'mekong.example', 'entity.email': 'info@mekong.example', 'entity.phone': '+84 28 1234 5678',
    });
    await page.check('[name="entity.nature"][value="export"]');
    await page.check('[name="entity.purpose"][value="deposits"]');
    await page.check('[name="entity.purpose"][value="crypto"]'); // 多选
    // 月交易量没有"其他"；选 50 万以上要写金额
    await expect(page.locator('[name="entity.volume"][value="other"]')).toHaveCount(0);
    await page.check('[name="entity.volume"][value="gt500k"]');
    await page.click('[data-next]');
    await expect(page.locator('[data-err-for="entity.volumeAmount"]')).not.toBeEmpty();
    await page.fill('[name="entity.volumeAmount"]', 'USD 800,000');
    // 币种必填，选"其他"要注明
    await expect(page.locator('[data-err-for="entity.currencies"]')).not.toBeEmpty();
    await page.check('[name="entity.currencies"][value="usdt"]');
    await page.check('[name="entity.currencies"][value="other"]');
    await page.fill('[name="entity.currenciesOther"]', 'TRX');
    await page.check('[name="entity.markets"][value="apac"]');
    // 制裁声明必填，选"是"要写说明
    await expect(page.locator('[data-err-for="entity.sanctions"]')).not.toBeEmpty();
    await page.check('[name="entity.sanctions"][value="yes"]');
    await page.click('[data-next]');
    await expect(page.locator('[data-err-for="entity.sanctionsDetails"]')).not.toBeEmpty();
    await page.fill('[name="entity.sanctionsDetails"]', 'SANCTION-DETAIL-E2E: limited exposure, under USD 5,000 per month');
    // 公司文件：选传，有提示文字；类型不对被拒绝
    const company = page.locator('[data-doc="company"]');
    await expect(page.locator('[data-company-docs-hint]')).toContainText(/certificate of incorporation.*optional.*up to 20 files/i);
    await expect(company).toContainText(/optional/i);
    await page.setInputFiles('[data-upload="company"]', { name: 'bad.html', mimeType: 'text/html', buffer: Buffer.from('<b>x</b>') });
    await expect(page.locator('[data-files="company"]')).not.toContainText('bad.html');
    await expect(company.locator('.row-err')).not.toBeEmpty();
    await page.setInputFiles('[data-upload="company"]', [{ ...PDF, name: 'certificate.pdf' }, { ...PDF, name: 'articles.pdf' }]); // 一次选多个
    await expect(page.locator('[data-files="company"]')).toContainText('certificate.pdf');
    await expect(page.locator('[data-files="company"]')).toContainText('articles.pdf');
    await next(page, 1);

    // 离开后用同一链接回来，已填内容还在
    await page.goto(link);
    await expect(page.locator('[name="entity.legalName"]')).toHaveValue('Mekong Export Company Limited');
    await expect(page.locator('[data-files="company"]')).toContainText('articles.pdf');
    await page.click('[data-goto="1"]');
    await expect(page.locator('[data-step="1"]')).toBeVisible();

    // ② 人员：至少一名董事、一名最终受益人、恰好一位授权联系人
    const p = page.locator('[data-person]').first();
    await expect(p.locator('[name$=".residence"]')).toHaveCount(0); // 没有居住国
    await p.locator('[name$=".roles"][value="director"]').check();
    await expect(p.locator('[data-ubo-fields]')).toBeHidden(); // 不是 UBO 时不显示持股比例
    await p.locator('[name$=".roles"][value="ubo"]').check();
    await expect(p.locator('[data-ubo-fields]')).toBeVisible();
    await p.locator('[name$=".ownershipPct"]').fill('120');
    await p.locator('[name$=".votingPct"]').fill('75.5');
    for (const [k, v] of Object.entries({ fullName: 'Nguyen Thi Lan', dob: '1985-06-01', nationality: 'Vietnam', address: '5 Le Loi, District 1', idNo: 'C9876543', idCountry: 'Vietnam', idExpiry: '2020-01-31' }))
      await p.locator(`[name$=".${k}"]`).fill(v);
    await p.locator('[name$=".idType"][value="passport"]').check();
    await p.locator('[name$=".pep"][value="yes"]').check();
    await expect(p.locator('[data-pep-details]')).toBeVisible(); // 选"是"时要求说明
    await p.locator('[name$=".pep"][value="no"]').check();
    await page.click('[data-next]');
    await expect(p.locator('[data-err-for$=".ownershipPct"]')).toHaveText(/0 to 100/);
    await expect(p.locator('[data-err-for$=".idExpiry"]')).not.toBeEmpty(); // 证件已过期
    await expect(page.locator('[data-err-for="people"]')).not.toBeEmpty(); // 没有授权联系人
    await expect(p.locator('[data-doc^="id:"] .row-err')).not.toBeEmpty(); // 没有身份证明
    await p.locator('[name$=".ownershipPct"]').fill('75.5');
    await p.locator('[name$=".idExpiry"]').fill('2032-01-31');
    // 授权联系人：邮箱、电话必填（只有这位）
    await p.locator('[name$=".roles"][value="contact"]').check();
    await page.click('[data-next]');
    await expect(p.locator('[data-err-for$=".email"]')).not.toBeEmpty();
    await p.locator('[name$=".email"]').fill(CLIENT);
    await p.locator('[name$=".phone"]').fill('+84 90 123 4567');
    await p.locator('[data-upload^="id:"]').setInputFiles([{ ...PNG, name: 'id-front.png' }, { ...PNG, name: 'id-back.png' }]);
    await expect(p.locator('[data-files^="id:"]')).toContainText('id-back.png');
    // 第二位人员：签字人，用身份证；邮箱电话可以不填
    await page.click('[data-add-person]');
    const p2 = page.locator('[data-person]').nth(1);
    await p2.locator('[name$=".roles"][value="signatory"]').check();
    for (const [k, v] of Object.entries({ fullName: 'Tran Van Minh', dob: '1979-11-20', nationality: 'Vietnam', address: '7 Hai Ba Trung, District 3', idNo: '079079001234', idCountry: 'Vietnam', idExpiry: '2034-11-20' }))
      await p2.locator(`[name$=".${k}"]`).fill(v);
    await p2.locator('[name$=".idType"][value="id_card"]').check();
    await p2.locator('[name$=".pep"][value="no"]').check();
    await page.click('[data-next]');
    await expect(p2.locator('[data-doc^="id:"] .row-err')).not.toBeEmpty(); // 第二位也必须上传
    await p2.locator('[data-upload^="id:"]').setInputFiles({ ...PDF, name: 'minh-id.pdf' });
    await expect(p2.locator('[data-files^="id:"]')).toContainText('minh-id.pdf');
    await next(page, 2);

    // ③ 钱包授权：法定全称、邮箱自动带出；没有证件类型及号码、User ID、所有权证明
    await expect(page.locator('[name="wallet.clientName"]')).toHaveValue('Mekong Export Company Limited');
    await expect(page.locator('[name="wallet.email"]')).toHaveValue('info@mekong.example');
    for (const gone of ['wallet.idTypeNo', 'wallet.userId', 'wallet.proofType']) await expect(page.locator(`[name="${gone}"]`)).toHaveCount(0);
    await expect(page.locator('[data-upload="walletProof"]')).toHaveCount(0);
    await fillText(page, { 'wallet.address': 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' });
    await page.check('[name="wallet.network"][value="tron"]');
    await page.check('[name="wallet.use"][value="both"]');
    await page.check('[name="wallet.ownershipOk"]'); await page.check('[name="wallet.riskOk"]');
    await next(page, 3);

    // ④ 声明与签名：授权代表姓名自动带出授权联系人；没签名不能提交
    await expect(page.locator('[name="decl.repName"]')).toHaveValue('Nguyen Thi Lan');
    await fillText(page, { 'decl.position': 'Director' });
    await page.check('[name="decl.confirm"]');
    await page.click('[data-submit]');
    await expect(page.locator('[data-err-for="signature"]')).not.toBeEmpty();
    await sign(page);
    await page.click('[data-submit]');
    await expect(page.locator('[data-ob-done]')).toBeVisible();

    // 提交后同一链接只能看到"已提交"
    await page.goto(link);
    await expect(page.locator('[data-ob-done]')).toBeVisible();
    await expect(page.locator('#ob-form')).toBeHidden();
    expect(errs).toEqual([]);
    await ctx.close();

    // 管理员收到通知，但通知里没有敏感信息
    // 通知邮件在提交返回之后才异步发送（waitUntil）：等邮件到了再检查，不要马上读
    await expect.poll(() => mailsTo('sales@example.test').filter((m) => m.includes(ref)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const note = mailsTo('sales@example.test').filter((m) => m.includes(ref)).at(-1)!;
    for (const s of ['C9876543', '5 Le Loi', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE']) expect(note).not.toContain(s);
  });

  test('TC-K05 存储中只有密文：证件号码、地址、邮箱、钱包地址都不以明文出现', async () => {
    const raw = readFileSync(resolve(DATA_MAIN, 'kyb-redis.json'), 'utf8');
    expect(raw).toContain(ref);
    for (const s of ['C9876543', '079079001234', '5 Le Loi', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', 'Mekong Export Company Limited', 'Nguyen Thi Lan', 'SANCTION-DETAIL-E2E', 'USD 800,000']) expect(raw).not.toContain(s); // 新字段同样加密
  });

  test('TC-K06 后台查看完整资料、下载文件、查看签名', async () => {
    await admin.reload();
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    await admin.click('[data-tab="apps"]'); // 登录后默认打开"概览"，这里切到开户申请
    await expect(admin.locator('[data-count="apps"]')).toHaveText('1'); // 1 个待审核
    const row = admin.locator(`[data-apps-body] tr[data-ref="${ref}"]`);
    await expect(row).toContainText('已提交');
    await expect(row).toContainText('涉及制裁：是'); // 红色标记
    await row.click();
    await expect(admin.locator('[data-detail-sections]')).toContainText('Mekong Export Company Limited');
    const sections = admin.locator('[data-detail-sections]');
    await expect(sections.locator('.flag-sanctions')).toBeVisible();
    for (const t of ['USDT、其他：TRX', 'USD 800,000', 'SANCTION-DETAIL-E2E', '75.5%', '接受客户的加密货币付款']) await expect(sections).toContainText(t);
    await expect(admin.locator('[data-detail-sections]')).toContainText('C9876543');
    // 后台详情：企业信息含联系方式、公司文件、每位人员含身份证明
    for (const t of ['info@mekong.example', 'certificate.pdf', 'articles.pdf', 'id-front.png', 'id-back.png', 'minh-id.pdf', '079079001234', '身份证', '授权联系人']) await expect(sections).toContainText(t);
    await expect(sections).not.toContainText('LEI');
    await expect(admin.locator('[data-side]')).toContainText(CLIENT);
    const sig = admin.getByRole('img', { name: '客户手写签名' });
    await expect(sig).toBeVisible();
    await expect.poll(() => sig.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0); // 签名图片在 CSP 下能正常加载
    await admin.setViewportSize({ width: 1280, height: 900 });    const href = await admin.locator('.file-link a').first().getAttribute('href');
    // 在浏览器里下载（与管理员点击链接相同，带 HttpOnly 会话 Cookie）
    const res = await browserGet(admin, href!);
    expect(res.status).toBe(200);
    expect(res.disposition).toMatch(/^attachment/);
    expect(res.text).toContain('%PDF-1.4');
    // 未登录不能下载、不能看列表
    const anon = await admin.context().browser()!.newContext({ baseURL: 'http://127.0.0.1:8080' });
    expect((await anon.request.get(href!)).status()).toBe(401);
    expect((await anon.request.get('/api/kyb/?g=admin&a=apps')).status()).toBe(401);
    await anon.close();
  });

  test('TC-K07 要求补件：只开放勾选的部分，客户修改后再次签名提交', async ({ browser }) => {
    const oldLink = linkIn(mailsTo(CLIENT).at(-1)!);
    await admin.getByRole('button', { name: '要求补件' }).click();
    // 可以勾选的是 3 个新步骤
    expect(await admin.locator('[data-dialog] input[type="checkbox"]').evaluateAll((l) => l.map((x) => (x as HTMLInputElement).value))).toEqual(['entity', 'people', 'wallet']);
    await admin.locator('[data-dialog] input[value="entity"]').check();
    await admin.fill('#ni-msg', '营业执照副本请上传彩色扫描件');
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('已发送补件通知');
    await expect(admin.locator('[data-detail-sections]')).toContainText('已要求补件');

    const mail = mailsTo(CLIENT).at(-1)!;
    expect(mail).toContain('营业执照副本请上传彩色扫描件');
    const link = linkIn(mail);
    expect(link).not.toBe(oldLink);

    const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
    const page = await ctx.newPage();
    await page.goto(oldLink);
    await expect(page.locator('[data-ob-invalid]')).toBeVisible(); // 旧链接失效
    await page.goto(link);
    await expect(page.locator('#ob-form')).toBeVisible();
    await expect(page.locator('[name="entity.legalName"]')).toBeEnabled(); // 开放的部分可以改
    await page.click('[data-goto="1"]');
    await expect(page.locator('[name$=".fullName"]').first()).toBeDisabled(); // 未开放的部分只读
    await expect(page.locator('[data-upload^="id:"]').first()).toBeDisabled();
    await page.click('[data-goto="0"]');
    await page.setViewportSize({ width: 375, height: 812 });    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('[data-upload="company"]')).toBeEnabled();
    await page.setInputFiles('[data-upload="company"]', { ...PDF, name: 'd1-colour.pdf' });
    await expect(page.locator('[data-files="company"]')).toContainText('d1-colour.pdf');
    await page.click('[data-goto="3"]');
    await sign(page);
    await page.click('[data-submit]');
    await expect(page.locator('[data-ob-done]')).toBeVisible();
    await ctx.close();
  });

  test('TC-K08 通过申请；保留期显示为"业务关系存续期间"；操作记录完整', async () => {
    await admin.click('[data-back-list]');
    const row = admin.locator(`[data-apps-body] tr[data-ref="${ref}"]`);
    await expect(row).toContainText('已提交');
    await row.click();
    await expect(admin.locator('[data-detail-sections]')).toContainText('d1-colour.pdf');
    await admin.getByRole('button', { name: '通过' }).click();
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('已通过');
    // 审核后导航上的"待审核"数字马上更新，不需要刷新页面
    await expect(admin.locator('[data-count="apps"]')).toHaveText('0');
    await expect(admin.locator('[data-side]')).toContainText('业务关系存续期间');
    await expect(admin.locator('.timeline-mini')).toContainText('补件');
    await admin.fill('#rv-notes', 'e2e 内部备注');
    await admin.locator('#rv-notes').blur();
    await expect(admin.locator('[data-toast]')).toContainText('备注已保存');
  });

  test('TC-K09 删除申请需要输入编号；删除后申请和文件都无法访问', async () => {
    const href = await admin.locator('.file-link a').first().getAttribute('href');
    await admin.getByRole('button', { name: '删除申请' }).click();
    await admin.locator('[data-dialog] input').fill('TU-0000-0000');
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('编号不一致');
    await admin.getByRole('button', { name: '删除申请' }).click();
    await admin.locator('[data-dialog] input').fill(ref);
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('已删除');
    await expect(admin.locator(`[data-apps-body] tr[data-ref="${ref}"]`)).toHaveCount(0);
    expect((await browserGet(admin, href!)).status).toBe(404);
    const dir = resolve(DATA_MAIN, 'blobs', 'kyb', new URL(href!, 'http://x').searchParams.get('id')!);
    expect(existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => statSync(resolve(dir, String(f))).isFile()) : []).toEqual([]); // 文件全部删除
  });

  test('TC-K10 无效令牌显示"链接无效"；接口返回 404', async ({ page }) => {
    await page.goto('/onboarding/?t=not-a-valid-token-not-a-valid-token-xx');
    await expect(page.locator('[data-ob-invalid]')).toBeVisible();
    await page.goto('/onboarding/');
    await expect(page.locator('[data-ob-invalid]')).toBeVisible();
    const r = await page.request.get('/api/kyb/?g=onboarding&a=state', { headers: { 'x-kyb-token': 'nope' } });
    expect(r.status()).toBe(404);
    // 走查：服务器出错时不说"链接无效"，而是提示重试
    await page.route(/\/api\/kyb\//, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"server_error"}' }));
    await page.goto('/onboarding/?t=some-token-some-token-some-token-xx');
    await expect(page.locator('[data-ob-invalid]')).toContainText('could not load');
    await expect(page.locator('[data-ob-invalid]')).not.toContainText('invalid or has expired');
    await expect(page.locator('[data-ob-invalid] button')).toHaveText('Try again');
  });

  test('TC-K11 到期清理由 worker 执行，没有对外的接口（本地用 /__fake/cleanup/ 代替 worker 立即跑一次）', async ({ request }) => {
    expect((await request.get('/api/cron/cleanup/')).status()).toBe(404);
    expect((await request.get('/api/cron/cleanup/', { headers: { authorization: 'Bearer wrong' } })).status()).toBe(404);
    const ok = await request.get('/__fake/cleanup/');
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, deleted: 0 });
  });

  test('TC-K12 跨站请求（Origin 不一致）被拒绝', async () => {
    // 浏览器不允许脚本伪造 Origin，所以这里直接带上会话 Cookie 从测试端发请求
    const c = (await adminCtx.cookies()).find((x) => x.name === 'topup_admin')!;
    const r = await fetch('http://127.0.0.1:8080/api/kyb/?g=admin&a=invite', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `topup_admin=${c.value}`, origin: 'https://evil.example' }, body: JSON.stringify({ company: 'X', email: 'x@x.com' }) });
    expect(r.status).toBe(403);
    const same = await fetch('http://127.0.0.1:8080/api/kyb/?g=admin&a=apps', { headers: { cookie: `topup_admin=${c.value}` } });
    expect(same.status).toBe(200); // 同一个 Cookie 的正常请求可以通过，说明 403 来自 Origin 检查
  });

  test('TC-K14 切换语言不丢失未保存的内容；超过 10MB 的文件被拒绝', async ({ browser }) => {
    const email = 'lang-switch@mekong.example';
    const r = await admin.evaluate(async (em) => (await fetch('/api/kyb/?g=admin&a=invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Lang Switch Co', email: em }) })).status, email);
    expect(r).toBe(200);
    const link = linkIn(mailsTo(email).at(-1)!);
    const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
    const page = await ctx.newPage();
    await page.goto(link);
    await page.fill('[name="entity.legalName"]', 'Unsaved Before Switch Ltd');
    await page.click('a[data-keep-query]');
    await expect(page).toHaveURL(/\/zh\/onboarding\/\?t=.+#step-0$/);
    await expect(page.locator('[name="entity.legalName"]')).toHaveValue('Unsaved Before Switch Ltd');
    await expect(page.locator('[data-step="0"] h2')).toHaveText(/企业信息/);
    // 超过 10MB：服务端拒绝（前端也会提示）
    const token = new URL(link).searchParams.get('t')!;
    const big = await fetch('http://127.0.0.1:8080/api/kyb/?g=onboarding&a=local-upload&doc=company', { method: 'POST', headers: { 'x-kyb-token': token, 'content-type': 'application/pdf' }, body: Buffer.alloc(10 * 1024 * 1024 + 1) });
    expect(big.status).toBe(413);
    await ctx.close();
  });

  test('TC-K17 旧的接口地址已不存在（与线上一致返回 404）', async ({ request }) => {
    expect((await request.get('/api/admin/me/')).status()).toBe(404);
    expect((await request.get('/api/kyb/?g=nope&a=me')).status()).toBe(404);
  });

  test('TC-K13 连续输错 5 次后锁定（放在最后执行）', async ({ request }) => {
    for (let i = 0; i < 5; i++) expect((await request.post('/api/kyb/?g=admin&a=login', { data: { password: 'wrong', code: '000000' } })).status()).toBe(401);
    const r = await request.post('/api/kyb/?g=admin&a=login', { data: { password: PW, code: totpCode(totpSecret, Date.now()) } });
    expect(r.status()).toBe(429);
  });
});

// TC-K16 开户页和后台在三种宽度下没有横向滚动（原型构建，表单可见）
for (const w of [375, 768, 1280]) {
  for (const path of ['/onboarding/?t=demo', '/zh/onboarding/?t=demo', '/admin/']) {
    test(`TC-K16 ${w}px ${path} 无横向滚动`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto('http://127.0.0.1:8090' + path);
      await page.waitForLoadState('networkidle');
      if (path.includes('onboarding')) {
        // 前端校验会阻止跳到后面的步骤，所以直接把 4 个步骤同时显示出来，一次检查全部内容
        await page.evaluate(() => document.querySelectorAll('[data-step]').forEach((e) => e.removeAttribute('hidden')));
        await expect(page.locator('[data-step="3"]')).toBeVisible();
        await page.click('[data-add-person]'); // 两个人员卡片
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    });
  }
}
