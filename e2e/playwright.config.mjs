import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '.tmp/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:8080', browserName: 'chromium' },
});
