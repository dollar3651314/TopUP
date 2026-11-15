// 测试先写（第 2 批 TRON 合约钱包开通后的收尾）：钱包设置 payout-wallets 的 TRON 卡。
// 依据（研发说明的需求）：
//   - 配了 TRON 合约钱包（config/wallets.json 的 tron.parent，到服务里是 layer.config.tron.scheme.parent）：
//     冷钱包以 parent 为准；链开通时冷钱包 USDT 和以太坊、BSC 一样从合约提供方读（balance('tron', { vault: 'cold' })，提供方按 tron.usdt 读）；
//   - 配了 parent 但 TRON 停用（不在开通列表里）：冷钱包仍写 parent，不读余额（没有 cold_balance），也不去读老 cold 的余额；
//   - 没配 parent：照第 0 批的老口径，冷钱包是 wallets.cold，余额用 TronGrid 读老 USDT 合约。
// 接口层直接调 server/pay/payout-admin.js 的动作（和 /api/wallet/ 同一份处理），返回值过一遍 JSON（undefined 的字段会消失，和接口一样）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDb } from './wallet-helpers.js';
import { parseUsdt } from '../server/pay/money.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';

const U = 1_000_000;
const wire = (x) => JSON.parse(JSON.stringify(x));
const TH = 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ'; // 热钱包
const TC = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // 第 0 批的老冷钱包（wallets.cold）
const TP = 'TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW'; // TRON 合约钱包的冷钱包（tron.parent）

/**
 * parent：tron.parent（null = 没配合约钱包）；on：TRON 在不在开通列表里
 * 返回 TRON 卡、合约提供方被问过的读数、TronGrid 被查过的地址
 */
async function tronCard({ parent, on }) {
  const db = await setupDb({ customers: [] });
  const tron = createFakeTron();
  tron.accounts.set(TH, { activated: true, trx: 50 * U, trc20: { [tron.contract]: 1_000 * U } });
  tron.accounts.set(TC, { activated: true, trx: 1 * U, trc20: { [tron.contract]: 111 * U } }); // 老冷钱包：111
  const asked = [];
  const inner = tron.account.bind(tron);
  tron.account = async (addr) => { asked.push(addr); return inner(addr); };
  const providerCalls = [];
  const layer = {
    enabledChains: on ? ['tron'] : [],
    config: { tron: { complete: Boolean(parent), ...(parent ? { scheme: { parent }, usdt: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' } : {}) } },
    providers: { contract: {
      tronOperator: null,
      async balance(chain, opts = {}) { providerCalls.push([chain, opts.vault]); return 2_222n * BigInt(U); }, // 合约提供方：2,222
    } },
    adapters: {},
  };
  const { payoutAdminActions } = await import('../server/pay/payout-admin.js');
  const acts = payoutAdminActions({ db, tron, wallets: { hot: TH, cold: TC, evm: {} }, layer, verifyAdminCode: async () => true });
  const r = wire(await acts['payout-wallets']());
  return { card: r.cards.find((c) => c.chain === 'tron'), providerCalls, asked };
}

test('payout-wallets（TRON 开通、配了 tron.parent）：冷钱包是 parent，cold_balance 来自合约提供方（tron、vault = cold），不按老冷钱包读', async () => {
  const { card, providerCalls, asked } = await tronCard({ parent: TP, on: true });
  assert.equal(card.enabled, true);
  assert.equal(card.cold, TP, '冷钱包要写合约钱包的 parent，不是第 0 批的老 cold');
  assert.equal(typeof card.cold_balance, 'string');
  assert.equal(parseUsdt(card.cold_balance), 2_222 * U, 'cold_balance 要是合约提供方读到的数（2,222），不是老冷钱包的 111');
  assert.deepEqual(providerCalls.filter(([c]) => c === 'tron'), [['tron', 'cold']], '按 balance("tron", { vault: "cold" }) 读一次');
  assert.ok(!asked.includes(TC), '不该再去 TronGrid 读老冷钱包的余额');
});

test('payout-wallets（配了 tron.parent 但 TRON 停用）：冷钱包仍写 parent；不读余额（没有 cold_balance），也不读老冷钱包', async () => {
  const { card, providerCalls, asked } = await tronCard({ parent: TP, on: false });
  assert.equal(card.enabled, false);
  assert.equal(card.cold, TP);
  assert.ok(!('cold_balance' in card), `停用的链不读冷钱包余额，cold_balance 不该出现（实际 ${JSON.stringify(card.cold_balance)}）`);
  assert.deepEqual(providerCalls.filter(([c]) => c === 'tron'), [], '停用时不问合约提供方');
  assert.ok(!asked.includes(TC), '不读老冷钱包');
  assert.ok(!asked.includes(TP), '也不用 TronGrid 读 parent');
});

for (const on of [true, false]) {
  test(`payout-wallets（没配 tron.parent，TRON ${on ? '在开通列表里' : '没开通'}）：老口径——冷钱包是 wallets.cold，余额用 TronGrid 读老 USDT 合约`, async () => {
    const { card, providerCalls, asked } = await tronCard({ parent: null, on });
    assert.equal(card.cold, TC);
    assert.equal(parseUsdt(card.cold_balance), 111 * U);
    assert.ok(asked.includes(TC), '老冷钱包用 TronGrid 读');
    assert.deepEqual(providerCalls.filter(([c]) => c === 'tron'), [], '没配合约钱包时不问合约提供方');
  });
}
