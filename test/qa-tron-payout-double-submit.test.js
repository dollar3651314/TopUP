// 测试先写（第 3 批，安全审查发现的双付）：TRON 打款签名提交（sign-submit，payout_batch 那一支）。
// 1. 同一批并发交两次（双击、网络重试）：只能有一次通过，另一次 409；这一笔不能因为第二次广播被节点拒（DUP_TRANSACTION_ERROR）回到"已审核"。
// 2. 广播返回 DUP_TRANSACTION_ERROR：说明这份已签名交易节点已经有了，按"已广播"处理（记下 txid），不回到"已审核"。
// 3. 广播报别的错（例如网络断了，交易其实已经到了节点）：在已签名交易过期（SIGN_TTL，30 分钟）之前不回到"已审核"、不能重新凑批签名。
// 不管哪种，一笔打款最后只能有一笔链上转账，账本只扣一次。
// 节点行为的替身在本文件里（只包一层 createFakeTron，不改产品代码里的替身）：
//   同一份已签名交易第二次广播 → DUP_TRANSACTION_ERROR（按真实节点的行为推断：TronGrid 对重复交易返回 result=false、code DUP_TRANSACTION_ERROR）；
//   failNext = 'network'：交易到了节点，但返回前连接断了（调用方拿到的是错误）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '@scure/base';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';
import { createWalletApi } from '../server/pay/wallet-api.js';
import { derivePayKeys } from '../server/pay/common.js';
import { signTxId, addressOfPrivateKey } from '../server/pay/signing.js';
import { runTick } from '../server/pay/tick.js';
import { encodeSigned } from '../server/pay/txcodec.js';

const U = 1_000_000;
const HOT_KEY = hex.decode('11'.repeat(32)); // 公开的测试私钥（config/wallets.json local.hot 同一个）
const HOT = addressOfPrivateKey(HOT_KEY);
const COLD = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const PAYEE = 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q';

/** 节点替身：重复广播返回 DUP_TRANSACTION_ERROR；failNext 模拟"到了节点但调用方收到错误" */
function nodeLike(tron) {
  const seen = new Set();
  const orig = tron.broadcastHex.bind(tron);
  const ctl = { failNext: null };
  tron.broadcastHex = async (h) => {
    await new Promise((r) => setTimeout(r, 5)); // 节点有延迟，并发的两次提交能交错
    if (seen.has(h)) throw Object.assign(new Error('broadcast_failed DUP_TRANSACTION_ERROR'), { code: 'DUP_TRANSACTION_ERROR' });
    const txid = await orig(h);
    seen.add(h);
    if (ctl.failNext === 'network') { ctl.failNext = null; throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }); }
    return txid;
  };
  return ctl;
}

async function setup() {
  const db = await createTestDb(); await migrate(db);
  const tron = createFakeTron();
  const node = nodeLike(tron);
  await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 0, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 1 * U, min: 0 } });
  await db.query('update balances set available = available + $1', [1000 * U]);
  const api = createWalletApi({ db, tron, keys: derivePayKeys('test-app-secret-test-app-secret-0123456789'), wallets: { hot: HOT, cold: COLD }, requireAdmin: async () => {}, verifyAdminCode: async () => true });
  const call = async (a, body, qs = '') => {
    const res = await api(new Request(`https://x/api/wallet/?a=${a}${qs}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-topup-csrf': '1' } }));
    return { status: res.status, body: await res.json() };
  };
  tron.accounts.set(HOT, { activated: true, trx: 100 * U, trc20: { [tron.contract]: 1000 * U } });
  const w = await core.requestWithdrawal(db, await core.getMerchant(db, 'm1'), { kind: 'payout', chain: 'tron', to: PAYEE, amount: 100 * U, source: 'web' });
  const wid = w.withdrawal_no;
  assert.equal((await call('payout-approve', { ids: [wid] })).status, 200);
  /** 凑批 → 签名 → 动态码；返回 batch_id 和签名 */
  const prepare = async () => {
    const r = await call('withdraw-plan', { ids: [wid] });
    if (r.status !== 200) return { status: r.status, body: r.body };
    const plan = r.body;
    const sigs = Object.fromEntries(plan.steps.map((s) => [s.txID, signTxId(s.txID, HOT_KEY)]));
    assert.equal((await call('sign-verify', { batch_id: plan.batch_id, code: '123456' })).status, 200);
    return { status: 200, plan, sigs };
  };
  const statusOf = async () => (await db.query('select status, txid from withdrawals where id = $1', [wid]))[0];
  /** 这一笔的链上转账（按 txid 去重） */
  const transfers = () => new Set(tron.broadcasts.filter((d) => d.contracts[0].to === PAYEE).map((d) => d.txId));
  /** 收尾：确认已广播的转账 → 跑一次定时任务 → 运营看到"已审核"就再签一次（如果凑得出批）→ 再确认一次 */
  const finish = async () => {
    for (const t of transfers()) tron.confirm(t, true);
    await runTick({ db, tron, getTarget: async () => null });
    const again = await prepare();
    if (again.status === 200) {
      await call('sign-submit', { batch_id: again.plan.batch_id, signatures: again.sigs });
      for (const t of transfers()) tron.confirm(t, true);
      await runTick({ db, tron, getTarget: async () => null });
    }
  };
  /** 最终：只有一笔链上转账、已完成、账本只扣一次 */
  const assertPaidOnce = async () => {
    assert.equal(transfers().size, 1, `同一笔 100 USDT 的打款上了 ${transfers().size} 笔不同的链上转账`);
    assert.equal((await statusOf()).status, 'completed');
    const led = await db.query(`select amount::bigint a from ledger where ref = $1 and type = 'withdraw'`, [wid]);
    assert.equal(led.length, 1, `账本按这笔扣款应该正好一次，实际 ${led.length} 次`);
    const [b] = await db.query(`select frozen::bigint f from balances where merchant_id = 'm1'`);
    assert.equal(Number(b.f), 0, '冻结应该清零');
  };
  return { db, tron, node, call, wid, prepare, statusOf, transfers, finish, assertPaidOnce };
}

test('TRON 打款：同一批并发提交两次只通过一次（另一次 409），这一笔不回到已审核；最后只有一笔链上转账', async () => {
  const t = await setup();
  const { plan, sigs } = await t.prepare();
  const [r1, r2] = await Promise.all([
    t.call('sign-submit', { batch_id: plan.batch_id, signatures: sigs }),
    t.call('sign-submit', { batch_id: plan.batch_id, signatures: sigs }),
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [200, 409], `同一批并发提交两次应该一次 200、一次 409，实际 ${JSON.stringify([r1, r2].map((r) => [r.status, r.body?.error?.code]))}`);
  const st = await t.statusOf();
  assert.equal(st.status, 'broadcast', `并发提交后这一笔应该是"已广播"，实际 ${st.status}`);
  assert.equal(t.transfers().size, 1);
  await t.finish();
  await t.assertPaidOnce();
});

test('TRON 打款：广播返回 DUP_TRANSACTION_ERROR 按"已广播"处理（记下 txid），不回到已审核；最后只有一笔链上转账', async () => {
  const t = await setup();
  const { plan, sigs } = await t.prepare();
  // 这份已签名交易节点已经有了（例如上一次请求超时前其实已经交上去了）：先交一份给节点
  const step = plan.steps[0];
  await t.tron.broadcastHex(encodeSigned(step.rawHex, sigs[step.txID]));
  const r = await t.call('sign-submit', { batch_id: plan.batch_id, signatures: sigs });
  assert.equal(r.status, 200);
  const st = await t.statusOf();
  assert.equal(st.status, 'broadcast', `DUP_TRANSACTION_ERROR 应该按"已广播"处理，实际这一笔是 ${st.status}`);
  assert.equal(st.txid, step.txID, 'txid 应该记成这份已签名交易的 txID');
  await t.finish();
  await t.assertPaidOnce();
});

test('TRON 打款：广播报别的错（交易其实已到节点）时，签名过期前不回到已审核、不能重新凑批签名；最后只有一笔链上转账', async () => {
  const t = await setup();
  const { plan, sigs } = await t.prepare();
  t.node.failNext = 'network';
  await t.call('sign-submit', { batch_id: plan.batch_id, signatures: sigs });
  assert.equal(t.transfers().size, 1, '前提：交易已经到了节点');
  const st = await t.statusOf();
  assert.notEqual(st.status, 'approved', '广播报错（结果不明）就回到"已审核"：签名还没过期，原来那笔随时可能上链，再签一次就付两次');
  const again = await t.call('withdraw-plan', { ids: [t.wid] });
  assert.notEqual(again.status, 200, '签名过期前不能把这一笔再凑进新的一批');
  await t.finish();
  await t.assertPaidOnce();
});
