import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '.tmp/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:8080',
    browserName: 'chromium',
    // 单个操作（点击、填写、选择等）最多等 15 秒：目标一直不出现或被挡住时，直接报出是哪个元素，
    // 而不是等到整条用例超时（收付款用例组是 2 分钟）才失败、看不出卡在哪一步。断言的等待时间不变。
    actionTimeout: 15_000,
    // 失败时保留追踪和截图（CI 失败时上传 e2e/test-results/），用来查偶发失败卡在哪一步
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
