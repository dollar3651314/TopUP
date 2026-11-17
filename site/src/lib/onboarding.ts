import copy from '../i18n/onboarding.json';
import type { Lang } from './i18n';

export type OCopy = typeof copy.en;
export const o = (lang: Lang): OCopy => copy[lang];
export const onboardingHref = (lang: Lang) => (lang === 'en' ? '/onboarding/' : '/zh/onboarding/');

/** 文件只有两类。公司文件（选传，最多 20 个）和每位人员的身份证明（必传，1～3 个）；数量上限和服务端 server/kyb/schema.js 一致 */
export const MAX_COMPANY_FILES = 20;
export const MAX_ID_FILES = 3;
export const ACCEPT = 'application/pdf,image/jpeg,image/png';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
