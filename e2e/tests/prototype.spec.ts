import { test, expect } from '@playwright/test';
import { PAGES } from './pages';

const PROTO = 'http://127.0.0.1:8090';

// TC-22 原型模式（PROTOTYPE=1 构建）：每页都有原型标识和 noindex；正式构建里没有
for (const p of PAGES) {
  test(`TC-22 ${p.path} 原型构建带标识，正式构建不带`, async ({ page }) => {
    await page.goto(PROTO + p.path);
    await expect(page.locator('[data-prototype-banner]')).toBeVisible();
    await expect(page.locator('[data-prototype-banner]')).toContainText('PROTOTYPE');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await page.goto(p.path); // 正式构建（8080）
    await expect(page.locator('[data-prototype-banner]')).toHaveCount(0);
  });
}
