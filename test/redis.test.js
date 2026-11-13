// Redis：本地替身（kyb/memredis.js）和自装 Redis 的客户端（redis.js）对业务代码的行为必须一致。
// 设置了 TEST_REDIS_URL 时两边都跑一遍（CI 用 Redis 7 容器），否则只跑替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMemRedis } from '../server/kyb/memredis.js';
import { createRedis } from '../server/redis.js';

async function contract(r, p) {
  // 字符串原样、对象自动转 JSON、读出时自动解析
  assert.equal(await r.set(`${p}s`, 'hello'), 'OK');
  assert.equal(await r.get(`${p}s`), 'hello');
  await r.set(`${p}o`, { a: 1, b: ['x'] });
  assert.deepEqual(await r.get(`${p}o`), { a: 1, b: ['x'] });
  assert.equal(await r.get(`${p}missing`), null);
  // nx：已存在时不覆盖
  assert.equal(await r.set(`${p}s`, 'other', { nx: true }), null);
  assert.equal(await r.get(`${p}s`), 'hello');
  // 计数
  assert.equal(await r.incr(`${p}n`), 1);
  assert.equal(await r.incr(`${p}n`), 2);
  assert.equal(await r.expire(`${p}n`, 60), 1);
  // 有序集合
  await r.zadd(`${p}z`, { score: 2, member: 'b' });
  await r.zadd(`${p}z`, { score: 1, member: 'a' });
  await r.zadd(`${p}z`, { score: 3, member: 'c' });
  assert.deepEqual(await r.zrange(`${p}z`, 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(await r.zrange(`${p}z`, 0, -1, { rev: true }), ['c', 'b', 'a']);
  await r.zrem(`${p}z`, 'b');
  assert.deepEqual(await r.zrange(`${p}z`, 0, -1), ['a', 'c']);
  // 列表：对象自动转 JSON，读出时解析
  await r.rpush(`${p}l`, JSON.stringify({ at: 1 }), { at: 2 });
  assert.deepEqual(await r.lrange(`${p}l`, 0, -1), [{ at: 1 }, { at: 2 }]);
  // 集合
  await r.sadd(`${p}set`, 'x', 'y', 'x');
  assert.deepEqual((await r.smembers(`${p}set`)).sort(), ['x', 'y']);
  // 删除：任何类型都能删
  assert.equal(await r.del(`${p}s`, `${p}z`, `${p}l`, `${p}set`, `${p}o`, `${p}n`), 6);
  assert.equal(await r.get(`${p}s`), null);
  assert.deepEqual(await r.lrange(`${p}l`, 0, -1), []);
}

test('Redis 替身：业务用到的命令', async () => {
  await contract(createMemRedis(), 't:');
});

test('自装 Redis 的客户端：和替身行为一致（需要 TEST_REDIS_URL）', { skip: !process.env.TEST_REDIS_URL && '没有设置 TEST_REDIS_URL' }, async () => {
  const r = createRedis(process.env.TEST_REDIS_URL);
  try { await contract(r, `test:${randomBytes(4).toString('hex')}:`); } finally { await r.quit(); }
});
