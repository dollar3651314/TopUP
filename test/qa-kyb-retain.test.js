// 测试会话补测（TU-15，2026-11-13 决定：客户资料含开户资料永久保留、不删）：
//   一、worker 的一轮：每日任务到点时只跑每日检查，不再调用开户资料清理（即使调用方还传了 cleanup 也不调用）
//   二、worker 进程的组装：startWorker 不再把开户资料清理接进定时任务
// 超过 365 天 / 5 年后资料（含文件）仍可读取的用例在 kyb-flow.test.js 的"永久保留（TU-15）"两条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { runOnce } from '../server/worker.js';

const quiet = { error: () => {}, log: () => {}, warn: () => {} };

test('一、worker 一轮：每日任务到点时不调用开户资料清理，连续多天都不调用；每日检查照常执行', async () => {
  const db = await createTestDb(); await migrate(db);
  const calls = [];
  const deps = {
    db, owner: 'w1', atUtc: '19:15', log: quiet,
    tick: async () => { calls.push('tick'); return {}; },
    cleanup: async () => { calls.push('cleanup'); return { deleted: 1 }; },
    daily: async () => { calls.push('daily'); return { ok: true }; },
  };
  const t0 = Date.parse('2026-11-13T19:30:00Z');
  for (let d = 0; d < 3; d++) {
    calls.length = 0;
    const out = await runOnce({ ...deps, now: t0 + d * 864e5 });
    assert.ok(calls.includes('daily'), `第 ${d + 1} 天：每日检查要执行（先确认到了每日任务）`);
    assert.ok(!calls.includes('cleanup'), `第 ${d + 1} 天：不能调用开户资料清理`);
    assert.equal(out.cleanup, undefined, '结果里不再有清理的记录');
  }
  await db.end?.();
});

test('二、worker 进程组装：定时任务里没有开户资料清理（不把 kyb.cleanup 接进 runOnce，也不再调用）', () => {
  const src = readFileSync(new URL('../server/worker.js', import.meta.url), 'utf8');
  // 去掉注释，只看代码
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /kyb\.cleanup/, 'startWorker 不能再把 app.kyb.cleanup 传给 runOnce');
  assert.doesNotMatch(code, /\bcleanup\s*\(/, 'runOnce 不能再调用 cleanup()');
  // 头部说明不能再写"开户资料到期清理"
  assert.doesNotMatch(src, /开户资料到期清理/, 'worker.js 的说明还写着每天做开户资料到期清理');
});
