// 研发补测（v1.1 PR #42 产品验收）：页面上不能出现文字 "null"。
// 原生 replaceChildren / append / prepend 会把参数里的 null 写成文字 "null"（ui.ts 的 h() 和 put() 会跳过 null）。
// 这里检查 site/src/scripts 里所有这三种调用：顶层参数里不能有 null（例如 `x ? h(...) : null`），
// 也不能直接传可能返回 null 的函数（debtAlert 等）；要传可能为 null 的就改用 put()。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../site/src/scripts');
// 返回可能为 null 的函数（直接作为参数传进去也会写出 "null"）
const NULLABLE_FNS = ['debtAlert', 'recentReversals'];

/** 去掉字符串、模板字符串和注释的内容，免得里面的括号、"null" 干扰（换行保留，行号不变） */
function strip(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); out += src.slice(i, e < 0 ? src.length : e + 2).replace(/[^\n]/g, ' '); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += q; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += q; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** 找出顶层参数里有 null、或者直接传了可能返回 null 的函数的 replaceChildren / append / prepend 调用 */
function findNullCalls(raw, f) {
  const src = strip(raw);
  const bad = [];
  for (const m of src.matchAll(/\.(replaceChildren|append|prepend)\(/g)) {
    let i = m.index + m[0].length, depth = 1, top = '';
    while (i < src.length && depth) {
      const c = src[i];
      if ('([{'.includes(c)) { if (depth === 1) top += c; depth++; }
      else if (')]}'.includes(c)) depth--;
      else if (depth === 1) top += c;
      i++;
    }
    const line = src.slice(0, m.index).split('\n').length;
    if (/\bnull\b/.test(top)) bad.push(`${f}:${line} .${m[1]}(…) 顶层参数里有 null`);
    for (const fn of NULLABLE_FNS) if (new RegExp(`(^|[^\\w.])${fn}\\(`).test(top)) bad.push(`${f}:${line} .${m[1]}(${fn}(…))：${fn} 可能返回 null`);
  }
  return bad;
}

test('页面脚本：replaceChildren / append / prepend 的顶层参数里没有 null（会显示成文字 "null"）', () => {
  const bad = readdirSync(DIR).filter((x) => x.endsWith('.ts')).flatMap((f) => findNullCalls(readFileSync(resolve(DIR, f), 'utf8'), f));
  assert.deepEqual(bad, [], `这些调用会把 null 显示成文字，改用 ui.ts 的 put()：\n${bad.join('\n')}`);
});

test('自检：抓得到直接传 null 和可能返回 null 的函数；h() 里面的、字符串里的不算', () => {
  assert.equal(findNullCalls("p.replaceChildren(a, ok ? h('p', {}, 'x') : null, b);", 't').length, 1);
  assert.equal(findNullCalls('p.replaceChildren(debtAlert(o.debt), b);', 't').length, 1);
  assert.equal(findNullCalls("p.replaceChildren(h('div', {}, ok ? 'x' : null, debtAlert(d)), 'null');", 't').length, 0);
  assert.equal(findNullCalls('put(p, debtAlert(o.debt), ok ? b : null);', 't').length, 0);
});
