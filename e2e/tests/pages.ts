// 测试用的公开页面清单：首页和开发者文档，每类都有中英两版（第一版不做营销页）
export const SLUGS = ['', 'docs/'];
export const PAGES = SLUGS.flatMap((s) => [
  { lang: 'en', path: '/' + s, other: '/zh/' + s },
  { lang: 'zh', path: '/zh/' + s, other: '/' + s },
]);
