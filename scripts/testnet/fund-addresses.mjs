#!/usr/bin/env node
// 测试网充值第 1 步（.github/workflows/testnet-fund.yml 的 addresses，GitHub 环境 staging-e2e，要管理员批准）：
// 用测试商户的开放 API（签名规则和开发者文档一样，用服务器自己的 signRequest）在测试环境建 N 个客户、生成指定链的充值地址。
//   开放 API 生成充值地址的唯一入口是"建单时指定链"（POST /api/v1/orders/，customer_id + chain：先建客户、再生成这条链的地址、再建订单）；
//   测试商户没开订单模式时建单返回 403 order_mode_disabled，但地址在建单之前已经生成了。所以每个客户都再用 GET /api/v1/customers/ 读一遍，
//   以读到的这条链"使用中"的地址为准（建单返回了地址时两边必须一样）。
//   客户标识 fee-ac3-<链>-<运行编号>-<序号>，订单号同客户标识，Idempotency-Key 按客户标识固定：同一次运行重跑不会建出第二个客户或第二张单。
// 输出只有公开信息：客户标识和充值地址（GITHUB_OUTPUT 的 plan、运行摘要、OUT_DIR/addresses.json），不输出接口返回的其他内容、测试环境地址、商户信息。
//
// 环境变量：STAGING_URL（仓库密钥）、STAGING_E2E_MERCHANT_KEY、STAGING_E2E_MERCHANT_SECRET（环境 staging-e2e 的密钥）、
//   FUND_CHAINS（eth,tron）、FUND_COUNT（每条链几个，1～50）、FUND_AMOUNT（每个地址打多少，1000 以内；这一步只记进清单、建单金额）、
//   FUND_RUN（运行编号，GitHub 上是 run_id）、OUT_DIR（默认 testnet-fund）
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { signRequest } from '../../server/pay/api-v1.js';
import { parseChains, parseCount, parseAmount, customerIdFor, validatePlan, secretList, maskWith, FUND_TARGETS } from './fund-lib.mjs';

/** 失败说明只给 HTTP 状态和错误码（不带响应内容、不带测试环境地址） */
const why = (r) => `HTTP ${r.status}${r.body?.error?.code ? ` ${String(r.body.error.code).replace(/[^\w.-]/g, '')}` : ''}`;

/** 测试商户的开放 API 客户端；fetchImpl 测试时换成替身 */
export function merchantClient({ base, key, secret, fetchImpl = fetch, now = () => Date.now() }) {
  const BASE = String(base || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(BASE) || !key || !secret) throw new Error('需要 STAGING_URL（仓库密钥）和 STAGING_E2E_MERCHANT_KEY、STAGING_E2E_MERCHANT_SECRET（环境 staging-e2e 的密钥）');
  return async function call(method, path, body, { idem } = {}) {
    const p = `/api/v1/${String(path).replace(/^\/+/, '')}`;
    const text = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Math.floor(now() / 1000));
    const headers = { 'x-topup-key': key, 'x-topup-timestamp': ts, 'x-topup-signature': signRequest(secret, ts, method, p, text) };
    if (method !== 'GET') { headers['content-type'] = 'application/json'; headers['idempotency-key'] = idem || `fund-${randomUUID()}`; }
    let res;
    try {
      res = await fetchImpl(BASE + p, { method, headers, body: method === 'GET' ? undefined : text, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new Error(`${method} ${p.split('?')[0]}：连不上（${e?.name || 'error'}）`);
    }
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
    return { status: res.status, body: json };
  };
}

/** 建单时可以接受的失败：地址已经生成（没开订单模式），或订单号已用过（同一次运行重跑） */
const OK_ORDER_ERRORS = new Set(['order_mode_disabled', 'duplicate_merchant_order_no']);

/** 一个客户：建单（生成地址）→ 读客户，返回这条链使用中的地址 */
export async function addressFor(call, { chain, customerId, amount }) {
  const r = await call('POST', 'orders/', { customer_id: customerId, chain, amount, merchant_order_no: customerId }, { idem: `fund-${customerId}` });
  if (r.status !== 200 && !OK_ORDER_ERRORS.has(r.body?.error?.code)) throw new Error(`${customerId}：生成 ${FUND_TARGETS[chain].name} 地址失败（POST /api/v1/orders/ 返回 ${why(r)}）`);
  const fromOrder = r.status === 200 ? String(r.body?.address || '') : '';
  const g = await call('GET', `customers/?customer_id=${encodeURIComponent(customerId)}`);
  if (g.status !== 200) throw new Error(`${customerId}：读客户失败（GET /api/v1/customers/ 返回 ${why(g)}）`);
  const got = (Array.isArray(g.body?.addresses) ? g.body.addresses : []).find((a) => a?.chain === chain);
  const address = String(got?.address || '');
  if (!address) throw new Error(`${customerId}：客户没有 ${FUND_TARGETS[chain].name} 的使用中地址`);
  if (fromOrder && fromOrder.toLowerCase() !== address.toLowerCase()) throw new Error(`${customerId}：建单返回的地址和客户的使用中地址不一样`);
  return address;
}

/** 每条链建 count 个客户、拿地址，返回（已经过 validatePlan 核对的）清单 */
export async function collect(call, { chains, count, amount, run, log = () => {} }) {
  const plan = { run, chains: {} };
  for (const chain of chains) {
    const items = [];
    for (let i = 1; i <= count; i++) {
      const customerId = customerIdFor(chain, run, i);
      items.push({ customer_id: customerId, address: await addressFor(call, { chain, customerId, amount }) });
      log(`  ${customerId}：${items.at(-1).address}`);
    }
    plan.chains[chain] = { amount, items };
  }
  const v = validatePlan(plan);
  return { run: v.run, chains: Object.fromEntries(Object.entries(v.chains).map(([c, p]) => [c, { amount: p.amount, items: p.items }])) };
}

export function planMarkdown(plan) {
  const lines = ['## 测试网充值第 1 步：充值地址', '', `运行编号 \`${plan.run}\`。只有客户标识和公开地址。`, ''];
  for (const [chain, p] of Object.entries(plan.chains)) {
    lines.push(`### ${FUND_TARGETS[chain].name}（${p.items.length} 个，每个准备打 ${p.amount} 测试 USDT）`, '', '| 客户标识 | 充值地址 |', '|---|---|');
    for (const it of p.items) lines.push(`| \`${it.customer_id}\` | \`${it.address}\` |`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const env = process.env;
  const secret = String(env.STAGING_E2E_MERCHANT_SECRET || '').trim();
  const base = String(env.STAGING_URL || '').trim();
  delete env.STAGING_E2E_MERCHANT_SECRET;
  const mask = maskWith(secretList({ urls: [base], values: [secret] }));
  const OUT = env.OUT_DIR || 'testnet-fund';
  try {
    const chains = parseChains(env.FUND_CHAINS || 'eth,tron');
    const count = parseCount(env.FUND_COUNT || '20');
    const amount = parseAmount(env.FUND_AMOUNT || '100').text;
    const run = String(env.FUND_RUN || `local-${randomUUID().slice(0, 8)}`);
    const call = merchantClient({ base, key: String(env.STAGING_E2E_MERCHANT_KEY || '').trim(), secret });
    console.log(`测试网充值第 1 步：${chains.join('、')} 每条链 ${count} 个地址`);
    const plan = await collect(call, { chains, count, amount, run, log: (m) => console.log(m) });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'addresses.json'), mask(JSON.stringify(plan, null, 2)) + '\n');
    const md = mask(planMarkdown(plan));
    writeFileSync(join(OUT, 'addresses.md'), md + '\n');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n');
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `plan=${mask(JSON.stringify(plan))}\n`);
  } catch (e) {
    const m = mask(e?.message || String(e));
    console.error(`::error::${m.replace(/\r?\n/g, ' ')}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## 测试网充值第 1 步失败\n\n${m}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
