// 测试会话补测（对账小改，产品验收留的 4 条里和对账有关的 3 条）：
//   R1 三条链都开通，BSC 冷钱包查不到、以太坊少 5：发"对账不一致"，以太坊行标【对不上】，BSC 行标【没查完】，邮件里没有合计差额
//   R2 只有一条链没查完、其他链都对得上：不发"对账不一致"（没查完的链自己少了钱也不比）
//   R3 同一条链连续没查完另发提醒：默认 N=2 时第 1 天不提醒、第 2 天"连续 2 天"、第 3 天"连续 3 天"；
//      中间缺一天对账记录、或有一天查完了，就重新从 1 数；N=1 当天提醒；环境变量 RECON_INCOMPLETE_DAYS 生效（配置和每日任务都接上）
//   R4 TRON 什么都没配（顶层 hot、cold 都空，没有第 0 批老地址，TRON 合约钱包没开通）：recon.by_chain 没有 tron，邮件里没有 TRON 行；
//      其中任何一项有，TRON 照常列出
// 只用内存数据库和 ETH、BSC、TRON 的内存替身（APP_ENV=local），不连任何节点、不需要密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createOps } from '../server/pay/ops.js';
import { derivePayKeys } from '../server/pay/common.js';
import { createWalletLayer } from '../server/wallet/index.js';
import { loadConfig } from '../server/config.js';
import { walletsFor, createPayDeps } from '../server/pay/deps.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { runDaily } from '../server/pay/daily.js';
import { tronScheme } from './tron-helpers.js';
import { deriveKeys } from '../server/kyb/crypto.js';
import { makeSession } from '../server/kyb/auth.js';

const U = 1_000_000;
const ALL = ['eth', 'bsc', 'tron'];
const LABEL = { eth: /以太坊/, bsc: /BSC/, tron: /TRON/ };
const DEAD = '0x000000000000000000000000000000000000dEaD';

/**
 * enabled：钱包层开通的链；top：顶层 hot、cold 用哪些（默认和本地配置一样两个都有）
 */
async function setup(enabled = ALL, { top = { hot: true, cold: true } } = {}) {
  const db = await createTestDb(); await migrate(db);
  const local = walletsFor('local');
  const evm = Object.fromEntries(Object.entries(local.evm || {}).filter(([c]) => enabled.includes(c)));
  const { scheme, usdt } = tronScheme();
  const tronCfg = enabled.includes('tron') ? { ...scheme, usdt } : null;
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm, tron: tronCfg });
  assert.deepEqual([...layer.enabledChains].sort(), [...enabled].sort(), `替身钱包层开通的链：${JSON.stringify(layer.errors)}`);
  const ops = createOps({ db, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), payBase: 'https://pay.test', wallet: layer });
  await core.createMerchant(db, { id: 'mr', name: 'Recon Co', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 0, min: 0 } });
  await db.query(`update merchants set order_mode = jsonb_set(order_mode, '{enabled}', 'true') where id = 'mr'`);
  const [m] = await db.query(`select * from merchants where id = 'mr'`);
  await ops.upsertCustomer(m, { customer_id: 'cu1' });
  const addr = {};
  for (const chain of enabled) addr[chain] = (await ops.createOrder(m, { customer_id: 'cu1', merchant_order_no: `R-${chain}`, amount: '10', chain })).address;
  const parent = { eth: local.evm?.eth?.parent, bsc: local.evm?.bsc?.parent, tron: scheme.parent };
  const deposit = async (chain, amount) => {
    const p = layer.adapters[chain].pay({ to: addr[chain], amount });
    const r = await core.recordDeposit(db, { chain, txid: String(p.txid).replace(/^0x/, ''), logIndex: 0, block: p.block, to: addr[chain], amount, time: new Date() });
    assert.equal(r.status, 'credited');
  };
  /** 链上把钱从 from 挪到 to（替身没有"转出"：给目标付正数、给来源付负数），账本不变 */
  const move = async (chain, from, to, amount) => {
    const a = layer.adapters[chain];
    a.pay({ to, amount });
    a.pay({ to: from, amount: -amount });
  };
  const tron = createFakeTron();
  await core.setMeta(db, 'tick_last', { at: new Date().toISOString() }); // 链上监控刚跑过，不触发"超过 5 分钟"的提醒
  const mails = [];
  const notify = async (s, t) => { mails.push(`${s}\n${t}`); };
  const wallets = { ...local, tron: tronCfg, hot: top.hot ? local.hot : '', cold: top.cold ? local.cold : '' };
  const daily = (opts = {}) => runDaily({ db, tron, wallets, notify, layer, ...opts });
  return { db, layer, addr, parent, deposit, move, mails, daily, tron, wallets };
}

/** 让替身查某个地址的余额时出错（模拟节点查不到冷钱包）；返回开关，off() 后恢复 */
function failBalanceOf(adapter, address) {
  const orig = adapter.tokenBalanceRaw.bind(adapter);
  let on = true;
  adapter.tokenBalanceRaw = async (a, ...rest) => {
    if (on && String(a).toLowerCase() === String(address).toLowerCase()) throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    return orig(a, ...rest);
  };
  return { off: () => { on = false; }, on: () => { on = true; } };
}
const mismatchMails = (mails) => mails.filter((m) => /对账不一致/.test(m));
/** 邮件里"各链"那几行：以链名开头（前面可以带【对不上】【没查完】） */
const chainLine = (mail, c) => mail.split('\n').find((l) => new RegExp(`^(【[^】]+】)?(?:${LABEL[c].source})[：:]`).test(l));
const stuckRe = (c, n) => new RegExp(`${LABEL[c].source}[^\\n]*连续 ${n} 天没查完`);
const anyStuck = (mails) => mails.filter((m) => /连续 \d+ 天没查完/.test(m));

// ---------- R1 ----------
test('R1 三条链都开通，BSC 冷钱包查不到、以太坊少 5：发"对账不一致"，以太坊【对不上】、BSC【没查完】、TRON 不标；邮件里没有合计差额', async () => {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  await s.move('bsc', s.addr.bsc, s.parent.bsc, 50 * U);
  await s.move('eth', s.addr.eth, DEAD, 5 * U); // 以太坊少 5
  failBalanceOf(s.layer.adapters.bsc, s.parent.bsc); // BSC 冷钱包查不到
  const out = await s.daily();
  // 先确认到达了要检查的状态：BSC 没查完、以太坊查完且差额 -5、TRON 查完且对得上
  assert.equal(out.recon.by_chain.bsc.complete, false, JSON.stringify(out.recon.by_chain.bsc));
  assert.equal(out.recon.by_chain.eth.complete, true, JSON.stringify(out.recon.by_chain.eth));
  assert.equal(out.recon.by_chain.eth.diff, -5 * U, JSON.stringify(out.recon.by_chain.eth));
  assert.equal(out.recon.by_chain.tron.complete, true);
  assert.equal(out.recon.by_chain.tron.diff, 0);
  assert.equal(out.recon.complete, false);
  const [alert, ...more] = mismatchMails(s.mails);
  assert.ok(alert, `查完的以太坊对不上，要发对账不一致：${s.mails.join('\n---\n')}`);
  assert.equal(more.length, 0, '只发一封');
  const eth = chainLine(alert, 'eth'), bsc = chainLine(alert, 'bsc'), tron = chainLine(alert, 'tron');
  assert.ok(eth && bsc && tron, `三条链各一行：${alert}`);
  assert.match(eth, /^【对不上】/, `以太坊行标【对不上】：${eth}`);
  assert.match(eth, /-5(\.0+)?\b/, `以太坊行写出差额 -5：${eth}`);
  assert.match(bsc, /^【没查完】/, `BSC 行标【没查完】：${bsc}`);
  assert.doesNotMatch(bsc, /对不上|差额/, `没查完的 BSC 不比、不写差额：${bsc}`);
  assert.doesNotMatch(tron, /【/, `TRON 对得上，不标：${tron}`);
  // 合计差额：三条链没都查完时不比。邮件里不能有"合计链上 … 差额 …"，链行以外不能出现带数字的差额
  assert.doesNotMatch(alert, /合计链上/, alert);
  const others = alert.split('\n').filter((l) => ![eth, bsc, tron].includes(l));
  for (const l of others) assert.doesNotMatch(l, /差额\s*-?[\d,]+(\.\d+)?/, `链行以外出现了数字差额：${l}`);
  // 默认 N=2，第 1 天不另发"连续没查完"
  assert.equal(anyStuck(s.mails).length, 0, s.mails.join('\n---\n'));
});

// ---------- R2 ----------
test('R2 只有 BSC 没查完、以太坊和 TRON 都对得上：不发"对账不一致"', async () => {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  await s.move('bsc', s.addr.bsc, s.parent.bsc, 50 * U);
  failBalanceOf(s.layer.adapters.bsc, s.parent.bsc);
  const out = await s.daily();
  assert.equal(out.recon.by_chain.bsc.complete, false, '前提：BSC 没查完');
  for (const c of ['eth', 'tron']) assert.deepEqual([out.recon.by_chain[c].complete, out.recon.by_chain[c].diff], [true, 0], `前提：${c} 查完且对得上`);
  assert.equal(mismatchMails(s.mails).length, 0, `只有一条链没查完时不发对账不一致：${s.mails.join('\n---\n')}`);
});

test('R2b 没查完的链自己少了钱（BSC 未归集地址少 5、冷钱包查不到）、别的链对得上：也不发"对账不一致"（没查完的链不比）', async () => {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  await s.move('bsc', s.addr.bsc, DEAD, 5 * U);
  failBalanceOf(s.layer.adapters.bsc, s.parent.bsc);
  const out = await s.daily();
  assert.equal(out.recon.by_chain.bsc.complete, false);
  assert.notEqual(out.recon.by_chain.bsc.diff, 0, '前提：BSC 的数字确实对不上');
  assert.equal(mismatchMails(s.mails).length, 0, s.mails.join('\n---\n'));
});

// ---------- R3 ----------
const DAY = (d) => new Date(`2026-11-${String(d).padStart(2, '0')}T19:15:00Z`);
/** BSC 冷钱包一直查不到；按给定的日期逐天跑每日任务，返回每天新发的邮件 */
async function runDays(s, days, opts = {}, hook = () => {}) {
  const per = {};
  for (const d of days) {
    await hook(d);
    const before = s.mails.length;
    await s.daily({ now: DAY(d), ...opts });
    per[d] = s.mails.slice(before);
  }
  return per;
}
async function stuckSetup() {
  const s = await setup();
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.deposit('tron', 30 * U);
  await s.move('bsc', s.addr.bsc, s.parent.bsc, 50 * U);
  s.bscFail = failBalanceOf(s.layer.adapters.bsc, s.parent.bsc);
  return s;
}

test('R3a 默认 N=2：BSC 连续没查完，第 1 天不提醒，第 2 天"连续 2 天"，第 3 天"连续 3 天"；以太坊、TRON 不提醒', async () => {
  const s = await stuckSetup();
  const per = await runDays(s, [1, 2, 3]);
  const rows = await s.db.query(`select day::text d, (detail->'by_chain'->'bsc'->>'complete') c from recon order by day`);
  assert.deepEqual(rows.map((r) => [r.d, r.c]), [['2026-11-01', 'false'], ['2026-11-02', 'false'], ['2026-11-03', 'false']], '前提：三天的对账记录都在、BSC 都没查完');
  assert.equal(anyStuck(per[1]).length, 0, `第 1 天不提醒：${per[1].join('\n---\n')}`);
  assert.match(per[2].join('\n'), stuckRe('bsc', 2), `第 2 天：${per[2].join('\n---\n')}`);
  assert.match(per[3].join('\n'), stuckRe('bsc', 3), `第 3 天：${per[3].join('\n---\n')}`);
  for (const d of [2, 3]) {
    assert.equal(per[d].join('\n').match(/连续 \d+ 天没查完/g).length, 1, `第 ${d} 天只提醒 BSC 一次`);
    for (const c of ['eth', 'tron']) assert.doesNotMatch(per[d].join('\n'), new RegExp(`${LABEL[c].source} 的对账已经连续`), `${c} 查完了，不提醒`);
  }
  // 只有一条链没查完、其他对得上：三天都不发对账不一致
  assert.equal(mismatchMails(s.mails).length, 0, s.mails.join('\n---\n'));
});

test('R3b 中间缺一天对账记录：重新从 1 数（N=2：1、2 号提醒"连续 2 天"，3 号没跑，4 号不提醒，5 号"连续 2 天"）', async () => {
  const s = await stuckSetup();
  const per = await runDays(s, [1, 2, 4, 5]);
  assert.equal((await s.db.query(`select 1 from recon where day = '2026-11-03'`)).length, 0, '前提：3 号没有对账记录');
  assert.match(per[2].join('\n'), stuckRe('bsc', 2));
  assert.equal(anyStuck(per[4]).length, 0, `缺了 3 号，4 号从 1 数，不提醒：${per[4].join('\n---\n')}`);
  assert.match(per[5].join('\n'), stuckRe('bsc', 2), `5 号"连续 2 天"（不是 4 天）：${per[5].join('\n---\n')}`);
  assert.doesNotMatch(per[5].join('\n'), /连续 [345] 天/);
});

test('R3c 中间有一天查完了：重新从 1 数（N=2：1 号没查完，2 号查完，3 号没查完不提醒，4 号"连续 2 天"）', async () => {
  const s = await stuckSetup();
  const per = await runDays(s, [1, 2, 3, 4], {}, (d) => (d === 2 ? s.bscFail.off() : s.bscFail.on()));
  const rows = await s.db.query(`select day::text d, (detail->'by_chain'->'bsc'->>'complete') c from recon order by day`);
  assert.deepEqual(rows.map((r) => r.c), ['false', 'true', 'false', 'false'], '前提：2 号 BSC 查完了');
  assert.equal(anyStuck(per[2]).length, 0);
  assert.equal(anyStuck(per[3]).length, 0, `2 号查完了，3 号从 1 数，不提醒：${per[3].join('\n---\n')}`);
  assert.match(per[4].join('\n'), stuckRe('bsc', 2), `4 号"连续 2 天"：${per[4].join('\n---\n')}`);
  assert.doesNotMatch(per[4].join('\n'), /连续 [34] 天/);
});

test('R3d N=1：第 1 天没查完当天就提醒"连续 1 天"', async () => {
  const s = await stuckSetup();
  const per = await runDays(s, [1], { incompleteDays: 1 });
  assert.match(per[1].join('\n'), stuckRe('bsc', 1), per[1].join('\n---\n'));
});

test('R3e N=3：第 2 天不提醒，第 3 天"连续 3 天"', async () => {
  const s = await stuckSetup();
  const per = await runDays(s, [1, 2, 3], { incompleteDays: 3 });
  assert.equal(anyStuck(per[1]).length + anyStuck(per[2]).length, 0, [...per[1], ...per[2]].join('\n---\n'));
  assert.match(per[3].join('\n'), stuckRe('bsc', 3));
});

test('R3f 环境变量 RECON_INCOMPLETE_DAYS：配置读到（默认 2、填 1、填 3），每日任务和"立即对账"按它提醒', async () => {
  assert.equal(loadConfig({ APP_ENV: 'local' }).reconIncompleteDays, 2, '没填时默认 2');
  assert.equal(loadConfig({ APP_ENV: 'local', RECON_INCOMPLETE_DAYS: '' }).reconIncompleteDays, 2, '空值时默认 2');
  assert.equal(loadConfig({ APP_ENV: 'local', RECON_INCOMPLETE_DAYS: ' 3 ' }).reconIncompleteDays, 3);
  // 整套依赖（生产和本地服务器共用的 createPayDeps）：BSC 冷钱包查不到，跑一次每日任务（第 1 天）
  const SECRET = 'test-app-secret-test-app-secret-0123456789';
  const runOnce = async (env, via) => {
    const sent = [];
    const config = loadConfig({ APP_ENV: 'local', APP_SECRET: SECRET, MAIL_TO: 'ops@recon.test', ...env });
    // 管理员会话：内存里的 Redis 替身 + 和服务器同一套密钥签的 Cookie（"立即对账"要登录）
    const kybKeys = deriveKeys(SECRET);
    const redis = { get: async (k) => (k === 'topup:admin' ? JSON.stringify({ version: 1 }) : null), set: async () => 'OK' };
    const deps = await createPayDeps({ config, kyb: { redis, keys: kybKeys }, send: async (m) => { sent.push(`${m.subject}\n${m.text}`); }, getIp: () => '', origin: 'https://pay.test' });
    try {
      assert.ok(deps.layer.enabledChains.includes('bsc'), `前提：本地替身开通了 BSC（${deps.layer.enabledChains}）`);
      failBalanceOf(deps.layer.adapters.bsc, deps.layer.config.bsc.scheme.parent);
      await core.setMeta(deps.db, 'tick_last', { at: new Date().toISOString() });
      if (via === 'daily') await deps.daily();
      else {
        const res = await deps.wallet(new Request('https://pay.test/api/wallet/?a=recon-run', { method: 'POST', body: '{}',
          headers: { 'content-type': 'application/json', 'x-topup-csrf': '1', cookie: `topup_admin=${makeSession(kybKeys.session, 1)}` } }));
        assert.equal(res.status, 200, `立即对账：${await res.text()}`);
      }
      const [row] = await deps.db.query('select detail from recon order by day desc limit 1');
      assert.equal(row.detail.by_chain.bsc.complete, false, '前提：BSC 没查完');
      return sent;
    } finally { await deps.db.end?.(); }
  };
  assert.equal(anyStuck(await runOnce({}, 'daily')).length, 0, '默认 2：第 1 天不提醒');
  assert.match((await runOnce({ RECON_INCOMPLETE_DAYS: '1' }, 'daily')).join('\n'), stuckRe('bsc', 1), 'RECON_INCOMPLETE_DAYS=1：每日任务第 1 天就提醒');
  assert.match((await runOnce({ RECON_INCOMPLETE_DAYS: '1' }, 'recon-run')).join('\n'), stuckRe('bsc', 1), 'RECON_INCOMPLETE_DAYS=1：后台"立即对账"也按它提醒');
});

// ---------- R4 ----------
test('R4a TRON 什么都没配（顶层 hot、cold 都空，没有老地址，TRON 合约钱包没开通）：recon.by_chain 没有 tron，邮件里没有 TRON 行', async () => {
  const s = await setup(['eth', 'bsc'], { top: { hot: false, cold: false } });
  await s.deposit('eth', 100 * U);
  await s.deposit('bsc', 50 * U);
  await s.move('eth', s.addr.eth, DEAD, 5 * U); // 让它发一封对账不一致，才看得到邮件里有哪些链
  assert.equal((await s.db.query('select 1 from customers where address is not null')).length, 0, '前提：没有第 0 批老地址');
  const out = await s.daily();
  assert.deepEqual(Object.keys(out.recon.by_chain).sort(), ['bsc', 'eth'], JSON.stringify(out.recon.by_chain));
  const [row] = await s.db.query('select detail from recon order by day desc limit 1');
  assert.deepEqual(Object.keys(row.detail.by_chain).sort(), ['bsc', 'eth'], '存进 recon 表（后台明细表读它）的也没有 tron');
  assert.equal(out.recon.complete, true, '不列的 TRON 不能让对账变成"没查完"');
  const alert = mismatchMails(s.mails)[0];
  assert.ok(alert, s.mails.join('\n---\n'));
  assert.ok(chainLine(alert, 'eth') && chainLine(alert, 'bsc'), alert);
  assert.equal(chainLine(alert, 'tron'), undefined, `邮件里不能有 TRON 行：${alert}`);
  assert.doesNotMatch(alert.split('\n各链：')[1] || alert, /TRON：/, alert);
});

test('R4b 顶层 hot、cold、老地址、TRON 合约钱包，有其中任何一项：TRON 照常列出（明细和邮件）', async () => {
  const cases = [
    ['只有顶层 hot', ['eth', 'bsc'], { hot: true, cold: false }, false],
    ['只有顶层 cold', ['eth', 'bsc'], { hot: false, cold: true }, false],
    ['只有第 0 批老地址', ['eth', 'bsc'], { hot: false, cold: false }, true],
    ['只开通 TRON 合约钱包', ALL, { hot: false, cold: false }, false],
  ];
  for (const [label, enabled, top, legacy] of cases) {
    const s = await setup(enabled, { top });
    if (legacy) {
      const T = 'TLegacyAddrxxxxxxxxxxxxxxxxxxxxxxx';
      await s.db.query(`update customers set address = $1 where customer_id = 'cu1'`, [T]);
      s.tron.accounts.set(T, { activated: true, trx: 0, trc20: {} });
    }
    await s.deposit('eth', 100 * U);
    await s.move('eth', s.addr.eth, DEAD, 5 * U);
    const out = await s.daily();
    assert.ok(out.recon.by_chain.tron, `${label}：TRON 要列出（${JSON.stringify(out.recon.by_chain)}）`);
    const alert = mismatchMails(s.mails)[0];
    assert.ok(alert, `${label}：${s.mails.join('\n---\n')}`);
    assert.ok(chainLine(alert, 'tron'), `${label}：邮件里要有 TRON 行：${alert}`);
  }
});
