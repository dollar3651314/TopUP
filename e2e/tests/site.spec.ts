import { test, expect } from '@playwright/test';
import { PAGES } from './pages';

// 公开页面（首页、开发者文档）：可访问、无死链、语言切换、站点地图、404、安全响应头、严格 CSP、无控制台报错、各宽度无横向滚动

// TC-01 公开页面全部返回 200
for (const p of PAGES) {
  test(`TC-01 ${p.path} 可访问`, async ({ request }) => {
    const r = await request.get(p.path);
    expect(r.status()).toBe(200);
  });
}

// TC-02 站内链接没有死链：爬取每个页面上的所有站内链接和资源
test('TC-02 站内链接和资源无 404', async ({ page, request }) => {
  const seen = new Set<string>();
  for (const p of PAGES) {
    await page.goto(p.path);
    const urls = await page.$$eval('a[href], link[href], script[src], img[src]', (els) =>
      els.map((e) => (e as HTMLAnchorElement).href || (e as HTMLScriptElement).src),
    );
    for (const u of urls) {
      const url = new URL(u);
      if (url.origin !== 'http://127.0.0.1:8080') continue;
      seen.add(url.pathname);
    }
  }
  const broken: string[] = [];
  for (const path of seen) {
    const r = await request.get(path);
    if (r.status() !== 200) broken.push(`${path} → ${r.status()}`);
  }
  expect(broken, `死链：${broken.join(', ')}`).toEqual([]);
  expect(seen.size).toBeGreaterThan(5);
  // 测试经理补（第 0 批复核）：页面减到 4 个后数量下限只能放低，改为逐个列出必须爬到的地址，确认爬取本身没有失效
  for (const must of ['/', '/zh/', '/docs/', '/zh/docs/', '/merchant/', '/zh/merchant/', '/favicon.svg']) expect([...seen], must).toContain(must);
  expect([...seen].filter((x) => x.startsWith('/_astro/') && x.endsWith('.css')).length, '样式文件').toBeGreaterThan(0);
});

// TC-03 语言切换跳到另一种语言的对应页面
for (const p of PAGES) {
  test(`TC-03 ${p.path} 语言切换 → ${p.other}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(p.path);
    await page.click('header a.lang');
    await expect(page).toHaveURL(p.other);
    // 测试经理补（第 0 批复核）：原 TC-03 有这一条，搬过来时漏了
    await expect(page.locator('html')).toHaveAttribute('lang', p.lang === 'en' ? 'zh-Hans' : 'en');
  });
}

// TC-07 sitemap 和 robots：全站 noindex 期间，站点地图不收录任何页面（和 noindex 口径一致）
test('TC-07 sitemap.xml 不收录任何页面（全站 noindex），robots.txt 引用 sitemap', async ({ request }) => {
  const sm = await request.get('/sitemap.xml');
  expect(sm.status()).toBe(200);
  const xml = await sm.text();
  expect(xml).toContain('<urlset');
  expect((xml.match(/<url>/g) || []).length).toBe(0);
  // 站点地图收录的页面不能是 noindex：逐个公开页面确认 noindex
  for (const p of PAGES) {
    const html = await (await request.get(p.path)).text();
    expect(html, p.path).toMatch(/<meta name="robots" content="noindex/);
  }
  const rb = await request.get('/robots.txt');
  expect(rb.status()).toBe(200);
  expect(await rb.text()).toContain('Sitemap: http://127.0.0.1:8080/sitemap.xml');
});

// TC-08 补充：404 页面、安全响应头、页面无控制台报错（包括 CSP 拦截）
test('TC-08 补充 不存在的页面返回 404 页面', async ({ request }) => {
  const r = await request.get('/no-such-page/');
  expect(r.status()).toBe(404);
  expect(await r.text()).toContain('Page not found');
});

test('TC-08 补充 安全响应头齐全（按 server/http-rules.json；严格 CSP 和 HSTS 对所有地址生效）', async ({ request }) => {
  for (const path of ['/', '/zh/docs/', '/merchant/', '/favicon.svg', '/api/health/']) {
    const h = (await request.get(path)).headers();
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['referrer-policy'], path).toBeTruthy();
    expect(h['content-security-policy'], path).toContain("script-src 'self'");
    expect(h['strict-transport-security'], path).toContain('max-age=31536000');
  }
});

// TC-08b 补充：生产环境启用了严格 CSP（禁止内联脚本和内联样式），构建产物必须与之兼容
test('TC-08b 补充 构建产物中没有内联脚本、内联样式和 style 属性（与严格 CSP 兼容）', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dist = join(process.cwd(), '..', 'site', 'dist');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') ? [p] : [];
  });
  const bad: string[] = [];
  for (const f of walk(dist)) {
    const html = readFileSync(f, 'utf8');
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) bad.push(`${f}: 内联 <script>`);
    if (/<style[\s>]/i.test(html)) bad.push(`${f}: 内联 <style>`);
    if (/\sstyle="/i.test(html)) bad.push(`${f}: style 属性`);
  }
  expect(bad).toEqual([]);
});

for (const p of PAGES) {
  test(`TC-08 补充 ${p.path} 无控制台报错`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(p.path, { waitUntil: 'networkidle' });
    expect(errors).toEqual([]);
  });
}

// TC-09 375 / 768 / 1280 三种宽度下没有横向滚动，元素没有溢出视口；同时保存截图供人工复核（.tmp/screens/）
for (const w of [375, 768, 1280]) {
  for (const p of PAGES) {
    test(`TC-09 ${w}px ${p.path}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(p.path);
      const res = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const overflow: string[] = [];
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          if (el.closest('.hp, .sr-only, [aria-hidden="true"] *, .skip-link')) continue;
          // 在可以横向滚动的容器里（开发者文档的代码块）：容器自己滚动，不算溢出
          let a = el.parentElement;
          while (a && !['auto', 'scroll'].includes(getComputedStyle(a).overflowX)) a = a.parentElement;
          if (a) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.right > vw + 1 || r.left < -1) overflow.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`);
        }
        return { scrollW: document.documentElement.scrollWidth, vw, overflow: overflow.slice(0, 5) };
      });
      expect(res.scrollW, '页面出现横向滚动').toBeLessThanOrEqual(res.vw);
      expect(res.overflow, '元素溢出视口').toEqual([]);
      await page.screenshot({ path: `.tmp/screens/${w}${p.path.replace(/\//g, '_')}.png`, fullPage: true });
    });
  }
}

// TC-V71-2 首页的商户登录进入对应语言的商户后台登录页
test('TC-V71-2 首页点击商户登录进入对应语言的商户后台', async ({ page }) => {
  for (const [path, merchant] of [['/', '/merchant/'], ['/zh/', '/zh/merchant/']]) {
    await page.goto(path);
    await page.click('[data-merchant-login]');
    await expect(page).toHaveURL(merchant);
    await expect(page.locator('[data-view="login"]')).toHaveCount(1); // 商户后台页面（8080 实例的收付款接口只用于开户测试，这里只确认到了这个页面）
  }
});

// ---------- 测试经理补（第 0 批复核）：原 TC-05、TC-10、TC-V71-1 里和保留页面有关的断言 ----------
// TC-05 剩下的部分：页脚的"不向中国大陆提供服务"声明（风险提示、隐私政策、服务条款随营销页一起去掉，已反馈产品确认）
for (const p of PAGES) {
  test(`TC-05 补 ${p.path} 页脚有不面向中国大陆的声明`, async ({ page }) => {
    await page.goto(p.path);
    await expect(page.locator('footer')).toContainText(p.lang === 'en' ? 'Mainland China' : '中国大陆');
  });
}

// TC-10 剩下的部分：首页文字里不出现法币费率、法币到账时间的具体数字（规则和原 content.spec.ts 一字不改）
const FIAT_PATTERNS: [string, RegExp][] = [
  ['百分比', /\d+(?:\.\d+)?\s*%/],
  ['英文时效数字', /\b\d+\s*(?:-|–|to)?\s*\d*\s*(?:business\s+|working\s+)?(?:days?|hours?|hrs?)\b/i],
  ['中文时效数字', /\d+\s*(?:-|–|至|到)?\s*\d*\s*(?:个)?(?:工作日|天|小时内|小时到账)/],
  ['英文法币金额', /(?:\$|USD|EUR|HKD|SGD)\s?\d/i],
  ['中文法币金额', /\d+(?:\.\d+)?\s*(?:万)?\s*(?:美元|元|港币|欧元)/],
  ['费用数字', /(?:fee|fees|charge|手续费|费率)[^.。]{0,20}\d/i],
];
for (const path of ['/', '/zh/']) {
  test(`TC-10 补 ${path} 无法币数字承诺`, async ({ page }) => {
    await page.goto(path);
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('script, style').forEach((e) => e.remove());
      return clone.innerText;
    });
    const hits = FIAT_PATTERNS.flatMap(([name, re]) => {
      const m = text.match(new RegExp(re.source, re.flags + 'g'));
      return m ? [`${name}: ${m.join(' | ')}`] : [];
    });
    expect(hits, hits.join('\n')).toEqual([]);
  });
}

// TC-V71-1 剩下的部分：首页的商户登录链接（地址跟随语言、文字正确；手机宽度也看得到）
for (const [path, merchant, label] of [['/', '/merchant/', 'Merchant login'], ['/zh/', '/zh/merchant/', '商户登录']]) {
  test(`TC-V71-1 补 ${path} 商户登录入口`, async ({ page }) => {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(path);
      const login = page.locator('[data-merchant-login]');
      await expect(login).toBeVisible();
      await expect(login).toHaveAttribute('href', merchant);
      await expect(login).toHaveText(label);
    }
  });
}

// TC-V71-3 几种宽度下页头不折行、无横向滚动
for (const w of [375, 768, 1000, 1024, 1101, 1280]) {
  for (const path of ['/', '/zh/']) {
    test(`TC-V71-3 ${w}px ${path} 页头不折行、无横向滚动`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      await page.goto(path);
      const r = await page.evaluate(() => ({
        over: document.documentElement.scrollWidth - window.innerWidth,
        wrapped: [...document.querySelectorAll<HTMLElement>('header .brand, header a.lang')].filter((a) => a.offsetParent && a.getClientRects().length > 1).map((a) => a.textContent?.trim()),
        brandH: document.querySelector('header .brand')!.getBoundingClientRect().height,
      }));
      expect(r.over).toBeLessThanOrEqual(0);
      expect(r.wrapped).toEqual([]);
      expect(r.brandH).toBeLessThan(48);
    });
  }
}

// TC-V71-4 站点地图不包含商户后台和管理平台
test('TC-V71-4 sitemap 不包含 /merchant/、/admin/', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text();
  expect(xml).not.toContain('/merchant/');
  expect(xml).not.toContain('/admin/');
});
