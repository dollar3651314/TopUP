// 构建前检查：中英两份文案的字段结构必须完全一致，防止漏翻。
import { readFileSync } from 'node:fs';

const load = (l) => JSON.parse(readFileSync(new URL(`../src/i18n/${l}.json`, import.meta.url), 'utf8'));
function shape(o, p = '') {
  if (Array.isArray(o)) return [`${p}[]:${o.length}`, ...o.flatMap((x, i) => shape(x, `${p}[${i}]`))];
  if (o && typeof o === 'object') return Object.keys(o).sort().flatMap((k) => shape(o[k], `${p}.${k}`));
  return [p];
}
const en = new Set(shape(load('en')));
const zh = new Set(shape(load('zh')));
const onlyEn = [...en].filter((k) => !zh.has(k));
const onlyZh = [...zh].filter((k) => !en.has(k));
if (onlyEn.length || onlyZh.length) {
  console.error('i18n shape mismatch');
  if (onlyEn.length) console.error('  only in en:', onlyEn.join(', '));
  if (onlyZh.length) console.error('  only in zh:', onlyZh.join(', '));
  process.exit(1);
}
const ob = JSON.parse(readFileSync(new URL('../src/i18n/onboarding.json', import.meta.url), 'utf8'));
const obEn = shape(ob.en).join('|'), obZh = shape(ob.zh).join('|');
if (obEn !== obZh) { console.error('onboarding.json: en/zh shape mismatch'); process.exit(1); }
const mc = JSON.parse(readFileSync(new URL('../src/i18n/merchant.json', import.meta.url), 'utf8'));
if (shape(mc.en).join('|') !== shape(mc.zh).join('|')) { console.error('merchant.json: en/zh shape mismatch'); process.exit(1); }
console.log('i18n check OK');
