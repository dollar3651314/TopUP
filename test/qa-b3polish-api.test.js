// 测试先写（第 3 批验收小改）：运营后台两个接口的新字段。
// 依据（研发提的需求，第 3 批产品验收的黄灯）：
//   payout-tx-batch：以太坊 / BSC 的签名批次返回 nonce（确认作废前在区块浏览器上核对热钱包的这个 nonce），TRON 返回 null；
//   payout-wallets：每条链的卡片返回冷钱包 USDT 余额 cold_balance、热钱包手续费币 hot_gas；节点出错时这两个字段是 null（页面写"暂时查不到"），
//     不是不给（字段缺了页面就什么都不写）。
// 接口层直接调 server/pay/payout-admin.js 的动作（和 /api/wallet/ 同一份处理），返回值过一遍 JSON（和接口实际返回一样：undefined 的字段会消失）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { setupDb, fakeEvm } from './wallet-helpers.js';
import * as core from '../server/pay/core.js';
import { createEvmAdapter } from '../server/wallet/adapters/evm.js';
import { toChecksumAddress } from '../server/wallet/create2.js';
import { decodeUnsignedLegacyTx } from '../server/wallet/evm-payout-codec.js';
import { parseUsdt } from '../server/pay/money.js';
import { createFakeTron } from '../server/pay/fake-trongrid.js';

const U = 1_000_000;
const hex = (b) => Buffer.from(b).toString('hex');
const rnd = () => toChecksumAddress('0x' + hex(randomBytes(20)));
const keyAddr = (k) => toChecksumAddress('0x' + hex(keccak_256(secp256k1.getPublicKey(k, false).slice(1))).slice(24));
const sign = (rawHex, key) => {
  const s = secp256k1.sign(keccak_256(Buffer.from(rawHex.slice(2), 'hex')), key, { lowS: true });
  return '0x' + s.r.toString(16).padStart(64, '0') + s.s.toString(16).padStart(64, '0') + s.recovery.toString(16).padStart(2, '0');
};
const ALLOWANCE = 'dd62ed3e';
/** 和接口一样过一遍 JSON：undefined 的字段不会出现在返回里 */
const wire = (x) => JSON.parse(JSON.stringify(x));
const actsMod = () => import('../server/pay/payout-admin.js');

/** 替身节点：热钱包 USDT 余额 + allowance(hot, contract)；热钱包下一个 nonce 由测试设（f.nonce，替身本身一直回 0） */
function node({ decimals, hotUsdt, allowance }) {
  const f = fakeEvm();
  f.nonce = 0;
  const inner = f.fetchImpl;
  f.fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const one = (x) => (x.method === 'eth_call' && String(x.params?.[0]?.data || '').startsWith('0x' + ALLOWANCE) ? { jsonrpc: '2.0', id: x.id, result: '0x' + BigInt(allowance).toString(16).padStart(64, '0') }
      : x.method === 'eth_getTransactionCount' ? { jsonrpc: '2.0', id: x.id, result: '0x' + f.nonce.toString(16) } : null);
    const all = [].concat(body);
    if (all.every(one)) { const out = all.map(one); return new Response(JSON.stringify(Array.isArray(body) ? out : out[0])); }
    return inner(url, init);
  };
  f.setHot = (hot) => { f.state.balances[hot.toLowerCase()] = BigInt(hotUsdt) * 10n ** BigInt(decimals) / 1_000_000n; };
  return f;
}

/** 一条链（eth / bsc）的打款服务 + 两笔已审核的单 */
async function evmWorld(chain) {
  const decimals = chain === 'bsc' ? 18 : 6;
  const scale = 10n ** BigInt(decimals - 6);
  const f = node({ decimals, hotUsdt: 10_000 * U, allowance: 10_000n * BigInt(U) * scale });
  const hotKey = randomBytes(32), hot = keyAddr(hotKey);
  f.setHot(hot);
  const token = rnd();
  const adapter = createEvmAdapter({ chain, rpcUrl: f.rpcUrl, fetchImpl: f.fetchImpl, usdt: token, decimals, confirmations: 0 });
  const db = await setupDb({ customers: [] });
  await db.query('update balances set available = available + $1', [100_000 * U]);
  await db.query(`insert into ledger (merchant_id, type, amount, available_after, frozen_after, ref) values ('m1', 'deposit', $1, $1, 0, 'seed')`, [100_000 * U]);
  const { createPayoutService } = await import('../server/wallet/payout.js');
  const { approvePayouts } = await import('../server/pay/payout.js');
  const svc = createPayoutService({ db, chains: { [chain]: { adapter, chainId: 31337, token, contract: rnd(), hot, decimals } }, verifyCode: async (c) => c === '123456' });
  const m1 = await core.getMerchant(db, 'm1');
  const approveOne = async (usdt) => {
    const { withdrawal_no: id } = await core.requestWithdrawal(db, m1, { kind: 'payout', chain, to: rnd(), amount: usdt * U, source: 'web' });
    await approvePayouts(db, { ids: [id], actor: 'admin' });
    return id;
  };
  return { db, f, svc, hot, hotKey, approveOne };
}

for (const chain of ['eth', 'bsc']) {
  test(`payout-tx-batch（${chain}）：已广播的批次返回 nonce，就是这一批交易原文里热钱包用的那个；两批的 nonce 各是各的`, async () => {
    const w = await evmWorld(chain);
    const { payoutAdminActions } = await actsMod();
    const acts = payoutAdminActions({ db: w.db, tron: createFakeTron(), wallets: {}, payoutSvc: w.svc, verifyAdminCode: async () => true });
    const seen = [];
    for (const [amt, n] of [[10, 41], [20, 42]]) {
      w.f.nonce = n; // 热钱包已经用到 n - 1（第二批时第一批已上链）
      await w.approveOne(amt);
      const plan = await w.svc.plan(chain, { actor: 'admin' });
      assert.equal(plan.batches.length, 1, '前提：凑出一批');
      const b = plan.batches[0];
      const want = decodeUnsignedLegacyTx(b.rawHex).nonce;
      await w.svc.submit(b.id, { sigHex: sign(b.rawHex, w.hotKey), actor: 'admin' });
      const d = wire(await acts['payout-tx-batch']({}, 'admin', new URLSearchParams({ id: b.id })));
      assert.equal(d.status, 'broadcast', '前提：已广播');
      assert.ok('nonce' in d, '返回里要有 nonce 字段');
      assert.notEqual(d.nonce, null, `${chain} 的批次要给 nonce`);
      assert.equal(String(want), String(n), '前提：交易原文用的是节点给的下一个 nonce');
      assert.equal(String(d.nonce), String(want), 'nonce 要和交易原文里的一致（确认作废时拿它去区块浏览器核对）');
      seen.push(String(d.nonce));
    }
    assert.notEqual(seen[0], seen[1], '第二批用的是下一个 nonce，返回的不能是同一个值');
  });
}

test('payout-tx-batch（TRON）：nonce 一律是 null（TRON 没有 nonce），字段照样在', async () => {
  const db = await setupDb({ customers: [] });
  const { payoutAdminActions } = await actsMod();
  const acts = payoutAdminActions({ db, tron: createFakeTron(), wallets: {}, verifyAdminCode: async () => true });
  // 库里哪怕有值（例如以后改表），TRON 也不给
  await db.query(`insert into payout_tx_batches (id, chain, status, item_ids, total, tx_hash, nonce) values ('PT-QA-TRON', 'tron', 'broadcast', '[]'::jsonb, $1, 'ab12', '9')`, [5 * U]);
  const d = wire(await acts['payout-tx-batch']({}, 'admin', new URLSearchParams({ id: 'PT-QA-TRON' })));
  assert.equal(d.chain, 'tron');
  assert.ok('nonce' in d, '返回里要有 nonce 字段');
  assert.equal(d.nonce, null);
});

/**
 * payout-wallets 的环境：以太坊、BSC、TRON 都开通；冷钱包、热钱包都配了。
 * down：哪些读数让节点出错（'eth-cold'、'eth-gas'、'bsc-cold'、'bsc-gas'、'tron'）
 */
async function walletWorld(down = []) {
  const db = await setupDb({ customers: [] });
  const tron = createFakeTron();
  const TH = 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ', TC = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  tron.accounts.set(TH, { activated: true, trx: 123_456_789, trc20: { [tron.contract]: 3_000 * U } });
  tron.accounts.set(TC, { activated: true, trx: 1_000_000, trc20: { [tron.contract]: 45_678.9 * U } });
  if (down.includes('tron')) tron.account = async () => { throw new TypeError('fetch failed'); };
  const evm = { eth: { hot: rnd(), payout: rnd(), parent: rnd() }, bsc: { hot: rnd(), payout: rnd(), parent: rnd() } };
  const COLD = { eth: 12_345.67 * U, bsc: 8_000 * U };
  const GAS = { eth: 15n * 10n ** 17n, bsc: 2n * 10n ** 16n }; // 1.5 ETH、0.02 BNB
  const layer = {
    enabledChains: ['eth', 'bsc', 'tron'],
    config: { eth: { complete: true }, bsc: { complete: true }, tron: { complete: true } },
    providers: { contract: {
      operator: rnd(), tronOperator: 'TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW',
      async balance(chain, { vault } = {}) {
        assert.equal(vault, 'cold', '冷钱包余额按 vault = cold 读');
        if (down.includes(`${chain}-cold`)) throw new TypeError('fetch failed');
        return BigInt(Math.round(COLD[chain]));
      },
    } },
    adapters: Object.fromEntries(['eth', 'bsc'].map((c) => [c, { async nativeBalance() { if (down.includes(`${c}-gas`)) throw new TypeError('fetch failed'); return GAS[c]; } }])),
  };
  const { payoutAdminActions } = await actsMod();
  const acts = payoutAdminActions({ db, tron, wallets: { hot: TH, cold: TC, evm }, layer, verifyAdminCode: async () => true });
  const r = wire(await acts['payout-wallets']());
  return Object.fromEntries(r.cards.map((c) => [c.chain, c]));
}

test('payout-wallets：每条链返回冷钱包 USDT 余额 cold_balance（USDT 字符串）和热钱包手续费币 hot_gas（ETH / BNB / TRX）', async () => {
  const c = await walletWorld();
  assert.equal(typeof c.eth.cold_balance, 'string');
  assert.equal(parseUsdt(c.eth.cold_balance), 12_345.67 * U);
  assert.equal(parseUsdt(c.bsc.cold_balance), 8_000 * U);
  assert.equal(parseUsdt(c.tron.cold_balance), 45_678.9 * U);
  assert.equal(typeof c.eth.hot_gas, 'string');
  assert.equal(Number(c.eth.hot_gas), 1.5);
  assert.equal(Number(c.bsc.hot_gas), 0.02);
  assert.equal(Number(c.tron.hot_gas), 123.456789);
});

for (const [what, down, chain, field] of [
  ['以太坊冷钱包', ['eth-cold'], 'eth', 'cold_balance'],
  ['以太坊热钱包手续费币', ['eth-gas'], 'eth', 'hot_gas'],
  ['BSC 冷钱包', ['bsc-cold'], 'bsc', 'cold_balance'],
  ['BSC 热钱包手续费币', ['bsc-gas'], 'bsc', 'hot_gas'],
]) {
  test(`payout-wallets：读${what}时节点出错 → ${field} 是 null（字段在、值为 null），别的读数照常`, async () => {
    const c = await walletWorld(down);
    assert.ok(field in c[chain], `${chain}.${field} 要返回（null），不能缺`);
    assert.equal(c[chain][field], null);
    const other = field === 'cold_balance' ? 'hot_gas' : 'cold_balance';
    assert.notEqual(c[chain][other], null, `${chain}.${other} 不受影响`);
    assert.notEqual(c[chain === 'eth' ? 'bsc' : 'eth'][field], null, '另一条链不受影响');
  });
}

test('payout-wallets：TRON 节点出错 → TRON 卡的 cold_balance、hot_gas 都是 null（字段在、值为 null），以太坊、BSC 照常', async () => {
  const c = await walletWorld(['tron']);
  assert.ok('cold_balance' in c.tron, 'tron.cold_balance 要返回（null），不能缺');
  assert.equal(c.tron.cold_balance, null);
  assert.ok('hot_gas' in c.tron, 'tron.hot_gas 要返回（null），不能缺：缺了页面就不写"暂时查不到"');
  assert.equal(c.tron.hot_gas, null);
  assert.notEqual(c.eth.cold_balance, null);
  assert.notEqual(c.bsc.hot_gas, null);
});
