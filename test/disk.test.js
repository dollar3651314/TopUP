// 测试经理补的用例（第 0 批复核第 2 轮）：每日检查的"数据库免费额度 500 MB"提醒改成"服务器磁盘用量 70%"（server/pay/disk.js），
// 原来的提醒没有单元测试，这里补上：磁盘用量读得到 / 读不到；每日检查按用量决定提醒与否，旧的"免费额度"提醒不再出现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { runDaily } from '../server/pay/daily.js';
import { diskUsage, DISK_ALERT } from '../server/pay/disk.js';

test('磁盘用量：读得到时是整数 MB、已用不超过总量；路径为空或不存在时返回 null', () => {
  const d = diskUsage(tmpdir());
  assert.ok(d, '临时目录所在磁盘应该读得到');
  assert.ok(Number.isInteger(d.used_mb) && Number.isInteger(d.total_mb));
  assert.ok(d.total_mb > 0 && d.used_mb >= 0 && d.used_mb <= d.total_mb, JSON.stringify(d));
  assert.equal(diskUsage(null), null);
  assert.equal(diskUsage(''), null);
  assert.equal(diskUsage('/no/such/path/for/topup/qa'), null);
  assert.equal(DISK_ALERT, 0.7);
});

test('每日检查：磁盘用量超过 70% 才提醒（提醒里有百分比和 MB）；读不到磁盘时不提醒；不再出现"免费额度"', async () => {
  const db = await createTestDb(); await migrate(db);
  const tron = createFakeTron();
  await core.setMeta(db, 'tick_last', { at: new Date().toISOString() }); // 监控正常，只看磁盘这一条
  const mails = [];
  const notify = async (s, t) => mails.push(t);
  const wallets = { hot: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', cold: '' };
  await runDaily({ db, tron, wallets, notify, diskPath: '/no/such/path/for/topup/qa' });
  assert.equal(mails.filter((m) => /磁盘|免费额度|500 MB/.test(m)).length, 0, mails.join('\n'));
  mails.length = 0;
  const d = diskUsage(tmpdir());
  await runDaily({ db, tron, wallets, notify, diskPath: tmpdir() });
  const disk = mails.filter((m) => /磁盘/.test(m));
  if (d.used_mb > d.total_mb * DISK_ALERT) {
    assert.equal(disk.length, 1, mails.join('\n'));
    assert.match(disk[0], new RegExp(`服务器磁盘已用 ${Math.round((d.used_mb / d.total_mb) * 100)}%`));
    assert.match(disk[0], /MB/);
  } else {
    assert.equal(disk.length, 0, mails.join('\n'));
  }
  assert.equal(mails.some((m) => /免费额度|500 MB/.test(m)), false);
  await db.end?.();
});
