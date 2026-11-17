// 测试经理补的用例（第 0 批复核）：开户文件改成存在服务器本地目录（原来在第三方文件存储），
// kyb-core.test.js 只测了 "../escape"。名字以存储目录开头的相邻目录（例如 blobs-old）同样不能被读写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalBlobs } from '../server/kyb/blobs.js';

test('开户文件：路径不能跳到名字以存储目录开头的相邻目录（读、写、删都拒绝）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'topup-qa-blobs-'));
  try {
    const dir = join(root, 'blobs');
    const b = createLocalBlobs(dir, { key: Buffer.alloc(32, 7) });
    mkdirSync(join(root, 'blobs-old'));
    writeFileSync(join(root, 'blobs-old', 'f'), 'OTHER');
    await assert.rejects(b.put('../blobs-old/new', Buffer.from('x'), 'text/plain'), /bad pathname/);
    assert.equal(existsSync(join(root, 'blobs-old', 'new')), false);
    await assert.rejects(b.read('../blobs-old/f'), /bad pathname/);
    await assert.rejects(b.head('../blobs-old/f'), /bad pathname/);
    await assert.rejects(b.del(['../blobs-old/f']), /bad pathname/);
    assert.equal(existsSync(join(root, 'blobs-old', 'f')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
