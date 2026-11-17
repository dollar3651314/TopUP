// config/wallets.json 一有改动就发邮件（K2）：服务启动时比较 sha256；第一次发"开始记录"；没变不发；变了发一封；两个进程同时启动只发一封
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDb } from './wallet-helpers.js';
import { checkWalletsChange } from '../server/pay/wallets-change.js';

test('config/wallets.json 改动提醒：第一次记录发一封；没变不发；变了发一封（写明环境、前后哈希、公开地址）；同时启动只发一封', async () => {
  const db = await setupDb();
  const mails = [];
  const notify = async (s, t) => mails.push([s, t]);
  const a = '{"staging":{"cold":"TA"}}', b = '{"staging":{"cold":"TB"}}';
  const r0 = await checkWalletsChange(db, { raw: a, appEnv: 'staging', section: { cold: 'TA' }, notify });
  assert.equal(r0.first, true);
  assert.equal(mails.length, 1);
  assert.match(mails[0][0], /开始记录/);
  assert.equal((await checkWalletsChange(db, { raw: a, appEnv: 'staging', section: { cold: 'TA' }, notify })).changed, false);
  assert.equal(mails.length, 1, '没变不发');
  const [x, y] = await Promise.all([1, 2].map(() => checkWalletsChange(db, { raw: b, appEnv: 'staging', section: { cold: 'TB' }, notify })));
  assert.equal([x, y].filter((r) => r.changed).length, 1, 'web、worker 同时启动只有一个发');
  assert.equal(mails.length, 2);
  assert.match(mails[1][0], /已更改（staging）/);
  assert.ok(mails[1][1].includes(r0.sha) && mails[1][1].includes(x.sha), '写明前后 sha256');
  assert.match(mails[1][1], /TB/);
  // 没配收件人：只记录不发
  const r3 = await checkWalletsChange(db, { raw: a, appEnv: 'staging', section: {}, notify: null });
  assert.equal(r3.changed, true);
  assert.equal(r3.notified, false);
  await db.end?.();
});

test('config/wallets.json 改动提醒：发信失败不记下这次（下次启动重试），发成功才记 notified；健康检查的 config_watch', async () => {
  const { walletsWatchStatus } = await import('../server/pay/wallets-change.js');
  const db = await setupDb();
  const ok = async () => {};
  await checkWalletsChange(db, { raw: 'A', appEnv: 'production', section: {}, notify: ok });
  const fail = async () => { throw new Error('smtp down'); };
  await assert.rejects(checkWalletsChange(db, { raw: 'B', appEnv: 'production', section: {}, notify: fail }));
  const mails = [];
  const r = await checkWalletsChange(db, { raw: 'B', appEnv: 'production', section: {}, notify: async (s) => mails.push(s) });
  assert.equal(r.changed, true, '上次发信失败，这次重试');
  assert.equal(r.notified, true);
  assert.equal(mails.length, 1);
  assert.deepEqual((({ mail, notified, ok: o }) => ({ mail, notified, ok: o }))(await walletsWatchStatus(db, { mailConfigured: true })), { mail: true, notified: true, ok: true });
  assert.equal((await walletsWatchStatus(db, { mailConfigured: false })).ok, false, '没配收件人：标红');
  await db.end?.();
});
