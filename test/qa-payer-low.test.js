// 测试会话补测（归集发起账户手续费币只够约 3 批时提前发提醒邮件；server/wallet/operator-gas.js）
// 需求口径：按一批典型归集（10 个地址、一半首次）估够几批；
//   不够 3 批 → "只够约 N 批"；不够 1 批 / 余额 0 / 付不起待确认批次 → "不够一批"；补到够约 4 批 → "已补足"；
//   状态变了才发、同一状态不重发、重启不重发；节点查不到余额不改状态、不发；没开通或没配发起账户的链不提醒；
//   后台（归集页、系统状态的 operator.low）和邮件用同一个判断；邮件只有公开地址和余额（不含私钥、节点地址）。
//   一、阈值：3 批 / 1 批 / 余额 0 / 待确认批次（三条链各走一遍，币种和链名对）
//   二、恢复与抖动：4 批才"已补足"；3 批上下来回、gas 价来回不重发
//   三、重启：状态在数据库里，新建钱包层后不重发、恢复照常发
//   四、节点失败：不改状态、不发信；一条链失败不影响别的链
//   五、没开通、没配发起账户的链：不查、不发
//   六、邮件内容：不含私钥、节点地址
//   七、后台和邮件同一口径（真实的本地钱包层 + 运营后台 wallet-sweep）
// 只用替身（内存数据库、手写的钱包层替身、ETH/BSC 内存替身），不需要任何密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { createWalletLayer } from '../server/wallet/index.js';
import { loadConfig } from '../server/config.js';
import { walletsFor } from '../server/pay/deps.js';
import { walletAdminActions } from '../server/wallet/admin-actions.js';
import { checkOperatorGas, operatorGasStatus, gasLevel, OPERATOR_GAS_CHECK_MS } from '../server/wallet/operator-gas.js';

const T0 = Date.parse('2026-12-02T03:00:00Z');
const SYM = { eth: 'ETH', bsc: 'BNB', tron: 'TRX' };
const NAME = { eth: '以太坊', bsc: 'BSC', tron: 'TRON' };
// 一批典型归集的手续费（最小单位）：每条链各不相同，避免几条链串了也看不出来
const PER = { eth: 3_000_000_000_000_000n, bsc: 500_000_000_000_000n, tron: 120_000_000n };
const ADDR = { evm: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', tron: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' };
// 只在替身里出现、绝不能进邮件的值
const SECRET_KEY = '0x' + 'ab12'.repeat(16);
const RPC = { eth: 'https://eth-node.example.invalid/v3/k3y-should-not-leak', bsc: 'https://bsc-node.example.invalid/k3y', tron: 'https://tron-node.example.invalid/k3y' };

/** 手写的钱包层替身：每条链的余额、每批手续费可随时改；calls 记录查过哪几条链 */
function fakeLayer({ enabled = ['eth', 'bsc', 'tron'], evmOp = true, tronOp = true } = {}) {
  const bal = { eth: PER.eth * 10n, bsc: PER.bsc * 10n, tron: PER.tron * 10n };
  const per = { ...PER };
  const fail = { eth: null, bsc: null, tron: null };
  const feeFail = { eth: false, bsc: false, tron: false };
  const calls = [];
  const layer = {
    enabledChains: [...enabled],
    operatorConfigured: evmOp,
    tronOperatorConfigured: tronOp,
    sweepOperatorKey: SECRET_KEY,
    config: { eth: { rpcUrl: RPC.eth }, bsc: { rpcUrl: RPC.bsc }, tron: { rpcUrl: RPC.tron } },
    providers: {
      contract: {
        operator: evmOp ? ADDR.evm : null,
        tronOperator: tronOp ? ADDR.tron : null,
        async operatorGas(chain) {
          calls.push(chain);
          if (fail[chain]) throw Object.assign(new Error(`connect ECONNREFUSED ${RPC[chain]}`), { code: 'rpc_unreachable' });
          return bal[chain];
        },
        async estimateFee(chain, op, n, { deploy } = {}) {
          assert.equal(op, 'sweep'); assert.equal(n, 10, '按一批 10 个地址估'); assert.equal(deploy, 5, '一半首次');
          if (feeFail[chain]) throw new Error(`gas price failed at ${RPC[chain]}`);
          return { native: per[chain] };
        },
      },
    },
  };
  return { layer, bal, per, fail, feeFail, calls };
}

async function setup(opts) {
  const db = await createTestDb(); await migrate(db);
  const f = fakeLayer(opts);
  const mails = [];
  const notify = async (subject, text) => { mails.push({ subject, text }); };
  let t = T0;
  const run = (o = {}) => { t += OPERATOR_GAS_CHECK_MS; return checkOperatorGas(db, { layer: f.layer, notify, now: t, adminUrl: 'https://pay.example.invalid/admin/', ...o }); };
  const level = async (chain) => (await db.query('select value from pay_meta where key = $1', [`operator_gas_${chain}`]))[0]?.value?.level ?? 'ok';
  return { db, ...f, mails, notify, run, level, at: () => t };
}

async function addAwaiting(db, chain, nativeNeed, id = `QA-OG-${chain}-${Math.random().toString(36).slice(2, 8)}`) {
  await db.query(`insert into wallet_sweep_batches (id, chain, provider, status, total, address_count, skipped, fee_estimate, slot, created_at, expires_at, updated_at)
    values ($1, $2, 'contract', 'awaiting_approval', 1, 1, '[]', $3::jsonb, '', now(), now() + interval '1 day', now())`, [id, chain, JSON.stringify({ native: String(nativeNeed) })]);
  return id;
}

// ───────────── 一、阈值 ─────────────
for (const chain of ['eth', 'bsc', 'tron']) {
  test(`一、${chain}：正好 3 批不发；差 1 个最小单位发"只够约 2 批"；正好 1 批仍是"只够约 1 批"；再少发"不够一批"`, async () => {
    const t = await setup();
    const only = { chains: [chain] };
    t.bal[chain] = PER[chain] * 3n;
    assert.equal((await t.run(only)).chains[chain], 'ok');
    assert.equal(t.mails.length, 0, '够 3 批：不发');

    t.bal[chain] = PER[chain] * 3n - 1n;
    assert.equal((await t.run(only)).chains[chain], 'low');
    assert.equal(t.mails.length, 1);
    assert.ok(t.mails[0].subject.includes(`${NAME[chain]} 归集发起账户的 ${SYM[chain]} 只够约 2 批归集`), t.mails[0].subject);
    assert.ok(t.mails[0].text.includes(SYM[chain]));
    assert.equal(await t.level(chain), 'low', '状态记在数据库');

    t.bal[chain] = PER[chain] * 2n;
    await t.run(only);
    t.bal[chain] = PER[chain];
    assert.equal((await t.run(only)).chains[chain], 'low', '正好 1 批：还是偏低，不算不够一批');
    assert.equal(t.mails.length, 1, '2 批、1 批都在"偏低"里：不重发');

    t.bal[chain] = PER[chain] - 1n;
    assert.equal((await t.run(only)).chains[chain], 'out');
    assert.equal(t.mails.length, 2);
    assert.ok(t.mails[1].subject.includes(`${NAME[chain]} 归集发起账户的 ${SYM[chain]} 不够付一批归集`), t.mails[1].subject);
    assert.equal(await t.level(chain), 'out');
    await t.db.end?.();
  });
}

test('一、余额 0：从正常直接到"不够一批"只发一封；gas 价也查不到时照样发', async () => {
  const t = await setup();
  t.bal.bsc = 0n;
  assert.equal((await t.run({ chains: ['bsc'] })).chains.bsc, 'out');
  assert.equal(t.mails.length, 1);
  assert.match(t.mails[0].subject, /BSC 归集发起账户的 BNB 不够付一批归集/);
  assert.match(t.mails[0].text, /现在有 0 BNB/);
  // 另一条链：余额 0 且估不出手续费
  t.bal.tron = 0n; t.feeFail.tron = true;
  assert.equal((await t.run({ chains: ['tron'] })).chains.tron, 'out');
  assert.equal(t.mails.length, 2);
  assert.match(t.mails[1].subject, /TRON 归集发起账户的 TRX 不够付一批归集/);
  await t.db.end?.();
});

test('一、余额够 10 批但付不起待确认批次：算"不够一批"并写明待确认批次；批次没了、余额够 4 批以上发"已补足"', async () => {
  const t = await setup();
  t.bal.eth = PER.eth * 10n;
  const id = await addAwaiting(t.db, 'eth', PER.eth * 10n + 1n);
  // 别的链的待确认批次不算到以太坊头上
  await addAwaiting(t.db, 'bsc', PER.bsc * 1000n);
  const r = await t.run({ chains: ['eth', 'bsc'] });
  assert.equal(r.chains.eth, 'out');
  assert.equal(r.chains.bsc, 'out', 'BSC 按自己的待确认批次算');
  const ethMails = t.mails.filter((m) => m.subject.includes('以太坊'));
  assert.equal(ethMails.length, 1);
  assert.equal(t.mails.length, 2);
  assert.match(ethMails[0].subject, /不够付一批归集/);
  assert.match(ethMails[0].text, /待确认的归集批次估的手续费/);
  // 待确认批次处理掉（过期）后：余额 10 批 → 已补足
  await t.db.query(`update wallet_sweep_batches set status = 'expired' where id = $1`, [id]);
  assert.equal((await t.run({ chains: ['eth'] })).chains.eth, 'ok');
  const last = t.mails.at(-1);
  assert.match(last.subject, /以太坊 归集发起账户的 ETH 已补足/);
  assert.match(last.text, /够约 10 批/);
  await t.db.end?.();
});

test('一、待确认批次只按本链算：BSC 的大批次不让以太坊报警', async () => {
  const t = await setup();
  await addAwaiting(t.db, 'bsc', PER.eth * 1000n);
  t.bal.eth = PER.eth * 10n;
  assert.equal((await t.run({ chains: ['eth'] })).chains.eth, 'ok');
  assert.equal(t.mails.length, 0);
  await t.db.end?.();
});

// ───────────── 二、恢复与抖动 ─────────────
test('二、偏低后补到正好 3 批 / 3.9 批都不发"已补足"；够 4 批发一封，主题、正文写清；之后不再发', async () => {
  const t = await setup();
  const only = { chains: ['eth'] };
  t.bal.eth = PER.eth * 2n;
  await t.run(only);
  assert.equal(t.mails.length, 1);
  for (const b of [PER.eth * 3n, PER.eth * 4n - 1n]) {
    t.bal.eth = b;
    assert.equal((await t.run(only)).chains.eth, 'low');
  }
  assert.equal(t.mails.length, 1, '3 批～4 批之间：仍在提醒中，不发恢复');
  t.bal.eth = PER.eth * 4n;
  assert.equal((await t.run(only)).chains.eth, 'ok');
  assert.equal(t.mails.length, 2);
  assert.match(t.mails[1].subject, /以太坊 归集发起账户的 ETH 已补足/);
  assert.match(t.mails[1].text, /够约 4 批/);
  assert.equal(await t.level('eth'), 'ok');
  t.bal.eth = PER.eth * 3n; // 恢复后掉回 3 批：在 3 批线上，不算偏低
  await t.run(only); await t.run(only);
  assert.equal(t.mails.length, 2, '恢复后同状态不再发');
  await t.db.end?.();
});

test('二、"不够一批"直接补到够 5 批：只发一封"已补足"（不先发一封"偏低"）', async () => {
  const t = await setup();
  const only = { chains: ['tron'] };
  t.bal.tron = 0n;
  await t.run(only);
  t.bal.tron = PER.tron * 5n;
  assert.equal((await t.run(only)).chains.tron, 'ok');
  assert.equal(t.mails.length, 2);
  assert.match(t.mails[1].subject, /TRON 归集发起账户的 TRX 已补足/);
  await t.db.end?.();
});

test('二、抖动：余额在 2～3 批来回、gas 价来回（同一余额 2.5～3.5 批）都不重复发信', async () => {
  const t = await setup();
  const only = { chains: ['bsc'] };
  t.bal.bsc = PER.bsc * 2n;
  await t.run(only);
  assert.equal(t.mails.length, 1);
  for (let i = 0; i < 6; i++) {
    t.bal.bsc = i % 2 ? PER.bsc * 2n : PER.bsc * 3n + PER.bsc / 2n;
    await t.run(only);
  }
  // gas 价来回：余额固定 3 批的量，每批手续费在 0.85～1.2 倍之间变
  t.bal.bsc = PER.bsc * 3n;
  for (const k of [120n, 85n, 120n, 85n]) { t.per.bsc = PER.bsc * k / 100n; await t.run(only); }
  assert.equal(t.mails.length, 1, '一直在提醒中：一封都不多发');
  await t.db.end?.();
});

test('二、正常状态下 3～4 批来回：不发信（只有掉到 3 批以下才发）', async () => {
  const t = await setup();
  const only = { chains: ['eth'] };
  for (const b of [PER.eth * 3n, PER.eth * 4n, PER.eth * 3n, PER.eth * 5n, PER.eth * 3n]) { t.bal.eth = b; await t.run(only); }
  assert.equal(t.mails.length, 0);
  await t.db.end?.();
});

// ───────────── 三、重启 ─────────────
test('三、重启（新建钱包层、同一个数据库）：偏低不重发、"不够一批"照发、补足后照发"已补足"；10 分钟间隔也跨重启', async () => {
  const db = await createTestDb(); await migrate(db);
  const mails = [];
  const notify = async (s, x) => { mails.push({ subject: s, text: x }); };
  const a = fakeLayer();
  a.bal.eth = PER.eth * 2n;
  await checkOperatorGas(db, { layer: a.layer, notify, now: T0, chains: ['eth'] });
  assert.equal(mails.length, 1);
  // 重启后马上跑（同一 10 分钟内）：跳过
  const b = fakeLayer(); b.bal.eth = PER.eth * 2n;
  assert.equal((await checkOperatorGas(db, { layer: b.layer, notify, now: T0 + 60_000, chains: ['eth'] })).skipped, 'interval');
  assert.equal(b.calls.length, 0, '间隔内不查节点');
  // 过了 10 分钟：仍偏低，不重发
  assert.equal((await checkOperatorGas(db, { layer: b.layer, notify, now: T0 + OPERATOR_GAS_CHECK_MS, chains: ['eth'] })).chains.eth, 'low');
  assert.equal(mails.length, 1, '重启后同一状态不重发');
  // 再"重启"一次，掉到不够一批：照发
  const c = fakeLayer(); c.bal.eth = PER.eth - 1n;
  assert.equal((await checkOperatorGas(db, { layer: c.layer, notify, now: T0 + 2 * OPERATOR_GAS_CHECK_MS, chains: ['eth'] })).chains.eth, 'out');
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /不够付一批/);
  // 再"重启"一次，补到 4 批：照常发已补足
  const d = fakeLayer(); d.bal.eth = PER.eth * 4n;
  assert.equal((await checkOperatorGas(db, { layer: d.layer, notify, now: T0 + 3 * OPERATOR_GAS_CHECK_MS, chains: ['eth'] })).chains.eth, 'ok');
  assert.equal(mails.length, 3);
  assert.match(mails[2].subject, /已补足/);
  await db.end?.();
});

// ───────────── 四、节点失败 ─────────────
test('四、偏低时节点查不到余额：unknown、状态不变、不发信；恢复后仍偏低不重发，够 4 批才发"已补足"', async () => {
  const t = await setup();
  const only = { chains: ['eth'] };
  t.bal.eth = PER.eth * 2n;
  await t.run(only);
  t.fail.eth = true;
  for (let i = 0; i < 3; i++) assert.equal((await t.run(only)).chains.eth, 'unknown');
  assert.equal(t.mails.length, 1, '节点失败：不发信（不当成恢复、也不当成余额 0）');
  assert.equal(await t.level('eth'), 'low', '节点失败：状态不变');
  t.fail.eth = null;
  assert.equal((await t.run(only)).chains.eth, 'low');
  assert.equal(t.mails.length, 1, '节点好了、仍偏低：不重发');
  t.bal.eth = PER.eth * 4n;
  await t.run(only);
  assert.equal(t.mails.length, 2);
  assert.match(t.mails[1].subject, /已补足/);
  await t.db.end?.();
});

test('四、正常时节点查不到余额：不发信、不记状态；偏低时只是 gas 价查不到（余额不为 0）：不发恢复', async () => {
  const t = await setup();
  t.fail.bsc = true;
  assert.equal((await t.run({ chains: ['bsc'] })).chains.bsc, 'unknown');
  assert.equal(t.mails.length, 0);
  assert.equal(await t.level('bsc'), 'ok');
  t.fail.bsc = null;
  t.bal.tron = PER.tron * 2n;
  await t.run({ chains: ['tron'] });
  assert.equal(t.mails.length, 1);
  t.feeFail.tron = true; t.bal.tron = PER.tron * 2n;
  assert.equal((await t.run({ chains: ['tron'] })).chains.tron, 'low', '估不出够几批：保持原状态');
  assert.equal(t.mails.length, 1);
  await t.db.end?.();
});

test('四、一条链节点失败不影响别的链：以太坊失败，BSC 偏低照发、TRON 正常不发', async () => {
  const t = await setup();
  t.fail.eth = true;
  t.bal.bsc = PER.bsc * 2n;
  const r = await t.run();
  assert.deepEqual(r.chains, { eth: 'unknown', bsc: 'low', tron: 'ok' });
  assert.equal(t.mails.length, 1);
  assert.match(t.mails[0].subject, /^BSC 归集发起账户的 BNB 只够约 2 批归集$/);
  await t.db.end?.();
});

// ───────────── 五、没开通、没配发起账户 ─────────────
test('五、没开通的链（TRON 不在开通列表）：不查节点、不发信，即使余额为 0', async () => {
  const t = await setup({ enabled: ['eth', 'bsc'] });
  t.bal.tron = 0n;
  const r = await t.run();
  assert.equal(r.chains.tron, 'off');
  assert.ok(!t.calls.includes('tron'), '没开通的链不查余额');
  assert.equal(t.mails.length, 0);
  await t.db.end?.();
});

test('五、没配发起账户：EVM 没配 → 以太坊、BSC off；TRON 没配 → 只 TRON off，别的链照常提醒', async () => {
  const a = await setup({ evmOp: false });
  a.bal.eth = 0n; a.bal.bsc = 0n; a.bal.tron = PER.tron * 2n;
  assert.deepEqual((await a.run()).chains, { eth: 'off', bsc: 'off', tron: 'low' });
  assert.equal(a.mails.length, 1);
  assert.match(a.mails[0].subject, /^TRON /);
  await a.db.end?.();

  const b = await setup({ tronOp: false });
  b.bal.tron = 0n; b.bal.eth = PER.eth * 2n;
  assert.deepEqual((await b.run()).chains, { eth: 'low', bsc: 'ok', tron: 'off' });
  assert.equal(b.mails.length, 1);
  assert.match(b.mails[0].subject, /^以太坊 /);
  await b.db.end?.();
});

test('五、提醒中的链被停用：清掉状态、不发"已补足"；重新开通后仍偏低再提醒一次', async () => {
  const t = await setup();
  t.bal.eth = PER.eth * 2n;
  await t.run({ chains: ['eth'] });
  assert.equal(t.mails.length, 1);
  t.layer.enabledChains.splice(t.layer.enabledChains.indexOf('eth'), 1);
  assert.equal((await t.run({ chains: ['eth'] })).chains.eth, 'off');
  assert.equal(t.mails.length, 1, '停用：不发信');
  assert.equal(await t.level('eth'), 'ok', '停用：状态清掉');
  t.layer.enabledChains.push('eth');
  assert.equal((await t.run({ chains: ['eth'] })).chains.eth, 'low');
  assert.equal(t.mails.length, 2);
  await t.db.end?.();
});

test('五、没有钱包层（没配钱包）：直接跳过', async () => {
  const db = await createTestDb(); await migrate(db);
  assert.deepEqual(await checkOperatorGas(db, { layer: null, notify: async () => assert.fail('不该发信'), now: T0 }), { skipped: 'no_wallet' });
  await db.end?.();
});

// ───────────── 六、邮件内容 ─────────────
test('六、邮件只有公开地址和余额：不含私钥、节点地址（含节点报错信息）、64 位十六进制', async () => {
  const t = await setup();
  // 依次走一遍每种邮件：三条链偏低、不够一批（含待确认批次）、已补足
  t.bal.eth = PER.eth * 2n; t.bal.bsc = PER.bsc - 1n; t.bal.tron = PER.tron * 2n;
  await addAwaiting(t.db, 'tron', PER.tron * 3n);
  await t.run();
  t.fail.eth = true; await t.run(); t.fail.eth = null; // 节点报错（报错信息里有节点地址）这轮不该发信
  t.bal.eth = PER.eth * 6n; t.bal.bsc = PER.bsc * 6n; await t.run({ chains: ['eth', 'bsc'] });
  assert.equal(t.mails.length, 5, '三封提醒 + 两封已补足');
  for (const m of t.mails) {
    const all = `${m.subject}\n${m.text}`;
    assert.ok(!all.includes(SECRET_KEY) && !all.toLowerCase().includes(SECRET_KEY.slice(2)), '不含私钥');
    assert.doesNotMatch(all, /0x[0-9a-f]{64}/i, '不出现 64 位十六进制');
    assert.doesNotMatch(all, /[0-9a-f]{64}/i);
    for (const u of Object.values(RPC)) assert.ok(!all.includes(u) && !all.includes(new URL(u).host), `不含节点地址 ${new URL(u).host}`);
    assert.doesNotMatch(all, /k3y|ECONNREFUSED|rpc_unreachable/i, '不含节点报错信息');
    assert.doesNotMatch(all, /private|私钥|mnemonic|助记词|api[_ ]?key/i);
  }
  const tron = t.mails.find((m) => m.subject.startsWith('TRON'));
  assert.ok(tron.text.includes(ADDR.tron), 'TRON 邮件有 TRON 发起账户公开地址');
  assert.ok(!tron.text.includes(ADDR.evm), 'TRON 邮件不混入 EVM 地址');
  assert.match(tron.subject, /不够付一批/, 'TRON：余额 2 批但待确认批次要 3 批 → 不够一批');
  assert.match(tron.text, /240 TRX/, '余额按 6 位小数换算（240 TRX）');
  const eth = t.mails.find((m) => m.subject.startsWith('以太坊') && /只够/.test(m.subject));
  assert.ok(eth.text.includes(ADDR.evm));
  assert.match(eth.text, /0\.006 ETH/, '余额按 18 位小数换算');
  assert.match(eth.text, /https:\/\/pay\.example\.invalid\/admin\//, '带运营后台链接');
  await t.db.end?.();
});

// ───────────── 七、后台和邮件同一口径 ─────────────
test('七、后台归集页 operator.low 与邮件判断一致：本地钱包层（以太坊 / BSC 替身）逐个余额核对', async () => {
  const db = await createTestDb(); await migrate(db);
  const layer = createWalletLayer({ db, config: loadConfig({ APP_ENV: 'local' }), evm: walletsFor('local').evm || {} });
  const chains = ['eth', 'bsc'].filter((c) => layer.enabledChains.includes(c));
  assert.ok(chains.length >= 1 && layer.operatorConfigured, '前提：本地至少一条 EVM 链开通、发起账户已配');
  const acts = walletAdminActions({ db, layer, verifyAdminCode: async () => true, notify: null });
  const mails = [];
  let t = T0;
  for (const chain of chains) {
    const per = BigInt((await layer.providers.contract.estimateFee(chain, 'sweep', 10, { deploy: 5 })).native);
    for (const [b, want] of [[0n, 'out'], [per - 1n, 'out'], [per, 'low'], [per * 3n - 1n, 'low'], [per * 3n, 'ok'], [per * 9n, 'ok']]) {
      // 每个余额都从"正常"开始比（进提醒的口径）
      await db.query(`delete from pay_meta where key = $1`, [`operator_gas_${chain}`]);
      layer.adapters[chain].nativeBalance = async () => b;
      const s = await operatorGasStatus({ db, layer, chain });
      const row = (await acts['wallet-sweep']()).chains.find((c) => c.chain === chain);
      t += OPERATOR_GAS_CHECK_MS;
      const r = await checkOperatorGas(db, { layer, notify: async (x) => mails.push(x), now: t, chains: [chain] });
      assert.equal(r.chains[chain], want, `${chain} 余额 ${b}：邮件级别`);
      assert.equal(gasLevel(s), want);
      assert.equal(row.operator.low, want !== 'ok', `${chain} 余额 ${b}：后台 low 与邮件一致`);
      assert.equal(row.operator.batches_left, s.batches_left, '后台显示的"够约几批"和邮件同一个数');
    }
    // 待确认批次：后台和邮件都算偏低
    await db.query(`delete from pay_meta where key = $1`, [`operator_gas_${chain}`]);
    layer.adapters[chain].nativeBalance = async () => per * 9n;
    await addAwaiting(db, chain, per * 10n);
    const row = (await acts['wallet-sweep']()).chains.find((c) => c.chain === chain);
    t += OPERATOR_GAS_CHECK_MS;
    assert.equal((await checkOperatorGas(db, { layer, notify: async (x) => mails.push(x), now: t, chains: [chain] })).chains[chain], 'out');
    assert.equal(row.operator.low, true);
    // 节点失败：后台显示查不到（不标 low），邮件不改状态
    layer.adapters[chain].nativeBalance = async () => { throw new Error('down'); };
    const row2 = (await acts['wallet-sweep']()).chains.find((c) => c.chain === chain);
    assert.equal(row2.operator.gas, null);
    assert.equal(row2.operator.low, false);
    t += OPERATOR_GAS_CHECK_MS;
    assert.equal((await checkOperatorGas(db, { layer, notify: async (x) => mails.push(x), now: t, chains: [chain] })).chains[chain], 'unknown');
  }
  await db.end?.();
});
