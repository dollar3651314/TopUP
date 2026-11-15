import { test, expect, type Page } from '@playwright/test';

// 测试会话补测（TU-15 第 ⑤ 条：隐私政策、服务条款中英各一页，页脚有链接，开户最后一步写"提交即表示您已阅读《隐私政策》"并带链接）。
// 条款内容可以先空着（上生产前再补），这里只查位置：页面存在、页脚能点到、开户最后一步有那句话和链接。
// 不猜页面地址：从页脚的链接文字找到地址，再逐个打开。
const LANGS = [
  { lang: 'en', home: '/', pages: ['/', '/docs/', '/onboarding/'], privacy: /privacy/i, terms: /terms/i, read: /by submitting[\s\S]*read/i },
  { lang: 'zh', home: '/zh/', pages: ['/zh/', '/zh/docs/', '/zh/onboarding/'], privacy: /隐私政策/, terms: /服务条款|用户协议|使用条款/, read: /提交即表示[\s\S]*已阅读/ },
] as const;

async function footerLinks(page: Page, path: string, re: RegExp) {
  await page.goto(path);
  const footer = page.locator('footer');
  await expect(footer, `${path} 有页脚`).toHaveCount(1);
  const link = footer.locator('a').filter({ hasText: re });
  await expect(link.first(), `${path} 页脚要有 ${re} 的链接`).toBeVisible();
  return new URL((await link.first().getAttribute('href'))!, page.url()).pathname;
}

test('TC-T01 隐私政策、服务条款中英各一页：页脚链接在各页一致，打开返回 200、语言对得上', async ({ page, request }) => {
  const seen: Record<string, string> = {};
  for (const L of LANGS) {
    for (const kind of ['privacy', 'terms'] as const) {
      const hrefs = new Set<string>();
      for (const p of L.pages) hrefs.add(await footerLinks(page, p, L[kind]));
      expect([...hrefs].length, `${L.lang} 各页页脚的${kind}链接指向同一页`).toBe(1);
      const href = [...hrefs][0];
      seen[`${L.lang}-${kind}`] = href;
      expect((await request.get(href)).status(), `${href} 可访问`).toBe(200);
      await page.goto(href);
      await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${L.lang}`));
      await expect(page.locator('h1')).toContainText(L[kind]);
    }
  }
  // 中英是两页，不是同一个地址
  expect(seen['en-privacy']).not.toBe(seen['zh-privacy']);
  expect(seen['en-terms']).not.toBe(seen['zh-terms']);
});

test('TC-T02 开户最后一步（声明与签名）有"提交即表示已阅读《隐私政策》"并链到隐私政策', async ({ page }) => {
  for (const L of LANGS) {
    const privacy = await footerLinks(page, L.home, L.privacy);
    await page.goto(L.pages[2]);
    const last = page.locator('[data-step="3"]'); // 4 步里的最后一步（未登录时整页表单隐藏，内容在页面里）
    await expect(last).toHaveCount(1);
    await expect(last.locator('[name="decl.confirm"]'), '先确认这是声明与签名那一步').toHaveCount(1);
    const text = (await last.textContent()) || '';
    expect(text, `${L.lang} 最后一步要有"提交即表示已阅读"`).toMatch(L.read);
    const link = last.locator('a').filter({ hasText: L.privacy });
    await expect(link, `${L.lang} 最后一步要有隐私政策的链接`).toHaveCount(1);
    expect(new URL((await link.getAttribute('href'))!, page.url()).pathname).toBe(privacy);
  }
});
