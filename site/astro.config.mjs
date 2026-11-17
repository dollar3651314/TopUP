import { defineConfig } from 'astro/config';

// 站点地址（用于 canonical、sitemap）：构建时由环境变量 SITE_URL 指定；本地和自动化测试用 http://127.0.0.1:8080
const SITE = process.env.SITE_URL || 'http://127.0.0.1:8080';

export default defineConfig({
  site: SITE,
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // CSS 一律输出为外部文件，这样 CSP 可以禁止内联样式和内联脚本
    inlineStylesheets: 'never',
  },
  vite: {
    build: { assetsInlineLimit: 0 },
  },
});
