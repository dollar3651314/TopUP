import en from '../i18n/en.json';
import zh from '../i18n/zh.json';

export type Lang = 'en' | 'zh';
export type Dict = typeof en;
export const LANGS: Lang[] = ['en', 'zh'];
export const HTML_LANG: Record<Lang, string> = { en: 'en', zh: 'zh-Hans' };

const dicts: Record<Lang, Dict> = { en, zh };
export const t = (lang: Lang): Dict => dicts[lang];

/** 页面标识 → URL 路径片段（中英共用同一套路径，中文加 /zh 前缀）。 */
export const PAGES = {
  home: '',
  merchant: 'merchant/',
  docs: 'docs/',
} as const;
export type PageKey = keyof typeof PAGES;

export function href(lang: Lang, page: PageKey, hash = ''): string {
  return (lang === 'en' ? '/' : '/zh/') + PAGES[page] + (hash ? `#${hash}` : '');
}

/** 供每个页面的 getStaticPaths 使用：英文放根路径，中文放 /zh/ 下。 */
export function langStaticPaths() {
  return LANGS.map((lang) => ({ params: { lang: lang === 'en' ? undefined : lang }, props: { lang } }));
}
