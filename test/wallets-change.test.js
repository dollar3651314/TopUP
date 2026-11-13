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
  await db.end?.();
});
