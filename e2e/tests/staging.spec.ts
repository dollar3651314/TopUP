import { test, expect } from '@playwright/test';

// 测试环境 = APP_ENV=staging 构建。真实接口，蓝色"测试环境"标识，noindex（邮件标题带"[测试环境]"由单元测试 test/api.test.js 检查）
const STG = 'http://127.0.0.1:8092';

for (const path of ['/', '/zh/docs/', '/onboarding/?t=x', '/admin/']) {
  test(`TC-S01 ${path} 显示测试环境标识，没有原型标识，而且 noindex`, async ({ page }) => {
    await page.goto(STG + path);
    await expect(page.locator('[data-staging-banner]')).toBeVisible();
    await expect(page.locator('[data-staging-banner]')).toContainText('STAGING');
    await expect(page.locator('[data-prototype-banner]')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
}

test('TC-S02 测试环境使用真实接口：开户页不是原型模式（无效链接显示"链接无效"）', async ({ page }) => {
  await page.goto(STG + '/onboarding/?t=not-a-real-token');
  await expect(page.locator('[data-ob-invalid]')).toBeVisible();
  expect(JSON.parse((await page.locator('#ob-root').getAttribute('data-config'))!).prototype).toBe(false);
});

test('TC-S04 正式构建没有测试环境标识', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-staging-banner]')).toHaveCount(0);
});
