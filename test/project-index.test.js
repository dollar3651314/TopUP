// 《项目索引》（仓库根目录的 项目索引.md）不能过时：
// ① 通用部分交给 scripts/check-project-index.mjs（按 项目索引.config.json 检查文件、路径、环境变量、数据库表等）；
// ② 接口动作和开放 API 路由要创建处理函数才能读出来，在这里检查。新增或删除了却没有更新索引，测试就失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMerchantApi } from '../server/pay/merchant-api.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { createApiV1 } from '../server/pay/api-v1.js';
import { createAdminHandler } from '../server/kyb/admin.js';
import { createOnboardingHandler } from '../server/kyb/onboarding.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX = readFileSync(join(ROOT, '项目索引.md'), 'utf8');
/** 反引号里的内容 */
const ticks = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
/** 按标题取一节（到下一个同级或更高级标题为止） */
function section(title) {
  const lines = INDEX.split('\n');
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && l.includes(title));
  assert.ok(start >= 0, `项目索引里找不到"${title}"这一节`);
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}
/** 表格第一列里反引号中的内容 */
const firstCol = (text) => text.split('\n').filter((l) => l.startsWith('| `')).map((l) => l.split('|')[1]).flatMap(ticks);

test('项目索引：通用检查（文件、路径、环境变量、数据库表、pay_meta 键、后台标签，见 项目索引.config.json）', () => {
  // scripts/check-project-index.mjs 的检查，CI 也单独运行它
  const r = spawnSync(process.execPath, ['scripts/check-project-index.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('项目索引：每个接口的每个动作都写了，没有写已经删除的动作', () => {
  const stub = {};
  const groups = [
    ['`/api/merchant/?a=`', createMerchantApi({ db: stub, keys: stub, ops: stub, send: () => {} }).actions],
    ['`/api/wallet/?a=`', createWalletApi({ db: stub, tron: stub, keys: stub, wallets: stub, requireAdmin: () => {}, verifyAdminCode: () => {}, send: () => {} }).actions],
    ['`/api/kyb/?g=admin&a=`', createAdminHandler({ repo: stub, blobs: stub, send: () => {}, redis: stub, keys: stub, config: stub }).actions],
    ['`/api/kyb/?g=onboarding&a=`', createOnboardingHandler({ repo: stub, blobs: stub, send: () => {}, config: stub }).actions],
    ['`/api/v1/`', createApiV1({ db: stub, keys: stub, ops: stub }).routes],
  ];
  for (const [title, actual] of groups) {
    assert.deepEqual([...new Set(firstCol(section(title)))].sort(), [...actual].sort(), `《项目索引》的 ${title} 和代码里的动作不一致`);
  }
});
