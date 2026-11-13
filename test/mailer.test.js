// 测试经理补的用例（第 0 批复核）：原 handler.test.js 的"Resend 发信：请求格式正确；API 返回错误时抛出异常"
// 测的是已淘汰的表单发信函数。开户邀请、审核通知、商户开通、收付款通知都走 createRawSender，
// 它的 Resend 分支原来没有单元测试，这里补上同样的断言。原 TC-S03（测试环境邮件标题带"[测试环境]"）也随表单淘汰，
// 这里在发信函数这一层确认测试环境的标题前缀真的加上了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRawSender } from '../server/mailer.js';
import { loadConfig } from '../server/config.js';

test('Resend 发信（通用发信）：请求格式正确；测试环境标题带"[测试环境]"；API 返回错误时抛出异常', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); };
  const ok = createRawSender({ resendApiKey: 'k', mailFrom: 'a@x.com', mailTo: 'b@x.com', appEnv: 'production' }, fakeFetch);
  await ok({ to: 'c@x.com', subject: 'Invitation', text: 'hello', replyTo: 'r@x.com' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { from: 'a@x.com', to: ['c@x.com'], subject: 'Invitation', text: 'hello', reply_to: 'r@x.com' });
  // 没有 replyTo 时不带 reply_to
  await ok({ to: 'c@x.com', subject: 'S', text: 't' });
  assert.equal('reply_to' in JSON.parse(calls[1].init.body), false);
  // 测试环境：标题前面加"[测试环境]"（loadConfig 读 APP_ENV）
  const stg = createRawSender({ ...loadConfig({ APP_ENV: 'staging', RESEND_API_KEY: 'k', MAIL_FROM: 'a@x.com' }) }, fakeFetch);
  await stg({ to: 'c@x.com', subject: 'Invitation', text: 't' });
  assert.equal(JSON.parse(calls[2].init.body).subject, '[测试环境] Invitation');
  // 出错：抛出异常，信息里有状态码，不吞掉
  const bad = createRawSender({ resendApiKey: 'k', mailFrom: 'a@x.com' }, async () => new Response('nope', { status: 403 }));
  await assert.rejects(bad({ to: 'c@x.com', subject: 'S', text: 't' }), /Resend 403/);
});
