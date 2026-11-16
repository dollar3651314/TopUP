// 测试网充值工具（scripts/testnet/fund-*.mjs、.github/workflows/testnet-fund.yml）的硬性限制：
// 只准 Sepolia / Nile（主网链 ID、其他测试网、本机链拒绝）、只准 staging 的测试 USDT、每条链最多 50 个地址、每个最多 1000 个、地址逐个核对；
// 第 1 步只用开放 API 签名请求、输出只有公开地址；第 2 步每笔核对收款余额。节点、测试环境都用替身，不连真实网络。
// 研发自测（工具类，不是业务用例）：交测试经理复核。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FUND_TARGETS, FUND_MAX_ADDRESSES, checkEvmChainId, checkTronNetwork, tokenFor, parseChains, parseCount, parseAmount,
  isValidAddress, validatePlan, planFromList, customerIdFor, erc20TransferData, secretList, maskWith, stagingSystemAddresses,
} from '../scripts/testnet/fund-lib.mjs';
import { fundEvm, fundTron } from '../scripts/testnet/fund-send.mjs';
import { merchantClient, addressFor, collect } from '../scripts/testnet/fund-addresses.mjs';
import { signRequest } from '../server/pay/api-v1.js';
import { addressOfKey, keccakHex } from '../server/wallet/evm-tx.js';
import { checksumAddress } from '../server/wallet/evm-payout-codec.js';
import { makeSigner } from '../scripts/tron-nile/tron-node.mjs';

const WALLETS = JSON.parse(readFileSync(new URL('../config/wallets.json', import.meta.url), 'utf8'));
const KEY = '22'.repeat(32);
const FROM = addressOfKey('0x' + KEY);
const ETH_TOKEN = FUND_TARGETS.eth.token;
const TRON_TOKEN = FUND_TARGETS.tron.token;
const evmAddr = (i) => checksumAddress('0x' + (0x1000 + i).toString(16).padStart(40, '0'));
// 普通 TRON 地址（随便的测试私钥算出来的，不是 staging 的系统地址）
const TRON_ADDRS = ['44', '55', '66'].map((b) => makeSigner(b.repeat(32)).address);
const hex = (n) => '0x' + BigInt(n).toString(16);
const fastWait = { timeoutMs: 50, pollMs: 1, sleep: async () => {} };
const ethPlan = (n, amount = '100') => ({ amount, items: Array.from({ length: n }, (_, i) => ({ customer_id: customerIdFor('eth', '123', i + 1), address: evmAddr(i) })) });

// ---------- 链和代币 ----------
test('以太坊只准 Sepolia：主网 1、BSC 56、BSC 测试网 97、本机 31337 都拒绝', () => {
  assert.throws(() => checkEvmChainId(1), /主网/);
  assert.throws(() => checkEvmChainId(56), /主网/);
  assert.throws(() => checkEvmChainId(97), /不是 Sepolia/);
  assert.throws(() => checkEvmChainId(31337), /不是 Sepolia/);
  assert.doesNotThrow(() => checkEvmChainId(11155111));
});

test('TRON 只准 Nile：本机私链、未知都拒绝', () => {
  assert.throws(() => checkTronNetwork({ network: 'local' }), /不是 Nile/);
  assert.throws(() => checkTronNetwork(null), /不是 Nile/);
  assert.doesNotThrow(() => checkTronNetwork({ network: 'nile' }));
});

test('代币只准 staging 的测试 USDT：和 config/wallets.json 一致才过；换成别的合约、主网 USDT、没填都拒绝', () => {
  assert.equal(tokenFor('eth', WALLETS), ETH_TOKEN);
  assert.equal(tokenFor('tron', WALLETS), TRON_TOKEN);
  const w = (eth, tron) => ({ staging: { evm: { eth: { usdt: eth } }, tron: { usdt: tron } } });
  assert.throws(() => tokenFor('eth', w(evmAddr(9), TRON_TOKEN)), /不是允许的测试 USDT/);
  assert.throws(() => tokenFor('eth', w('0xdAC17F958D2ee523a2206206994597C13D831ec7', TRON_TOKEN)), /主网 USDT/);
  assert.throws(() => tokenFor('tron', w(ETH_TOKEN, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')), /主网 USDT/);
  assert.throws(() => tokenFor('tron', w(ETH_TOKEN, '')), /没有测试 USDT/);
  assert.throws(() => tokenFor('bsc', WALLETS), /不认识的链/);
});

// ---------- 数量、金额、链清单 ----------
test('地址个数 1～50 的整数', () => {
  assert.equal(parseCount('20'), 20);
  assert.equal(parseCount(FUND_MAX_ADDRESSES), 50);
  for (const bad of ['0', '51', '100', '1.5', 'abc', '', '-1']) assert.throws(() => parseCount(bad), /地址个数/, bad);
});

test('金额：大于 0、最多 1000、最多 6 位小数，换成最小单位', () => {
  assert.equal(parseAmount('100').units, 100_000_000n);
  assert.equal(parseAmount('1000').units, 1_000_000_000n);
  assert.equal(parseAmount('0.5').text, '0.5');
  assert.equal(parseAmount('0100.10').text, '100.1');
  for (const bad of ['0', '0.000000', '1000.000001', '1001', '1e3', '-1', '1.1234567', '', 'abc']) assert.throws(() => parseAmount(bad), /金额/, bad);
});

test('链清单只认 eth、tron', () => {
  assert.deepEqual(parseChains('eth,tron'), ['eth', 'tron']);
  assert.deepEqual(parseChains('tron eth tron'), ['tron', 'eth']);
  assert.throws(() => parseChains('eth,bsc'), /不认识的链：bsc/);
  assert.throws(() => parseChains(''), /没有指定链/);
});

// ---------- 地址清单 ----------
test('地址格式：以太坊大小写混合要校验和对、零地址拒绝；TRON 要校验和对', () => {
  const a = evmAddr(1);
  assert.ok(isValidAddress('eth', a));
  assert.ok(isValidAddress('eth', a.toLowerCase()));
  // 校验和：取一个大小写混合的地址，把其中一个字母的大小写翻过来（格式还对，校验和不对）→ 必须拒绝
  const mixed = ['33', '44', '55', '66', '77', '88', '99'].map((b) => checksumAddress(addressOfKey('0x' + b.repeat(32)))).find((x) => /[A-F]/.test(x.slice(2)) && /[a-f]/.test(x.slice(2)));
  assert.ok(mixed, '找到大小写混合的地址');
  const pos = 2 + mixed.slice(2).search(/[A-Fa-f]/);
  const flipped = mixed.slice(0, pos) + (mixed[pos] === mixed[pos].toUpperCase() ? mixed[pos].toLowerCase() : mixed[pos].toUpperCase()) + mixed.slice(pos + 1);
  assert.notEqual(flipped, mixed);
  assert.ok(/[A-F]/.test(flipped.slice(2)) && /[a-f]/.test(flipped.slice(2)), '翻完还是大小写混合（不是全小写、全大写）');
  assert.ok(isValidAddress('eth', mixed));
  assert.ok(!isValidAddress('eth', flipped), '校验和不对的混合大小写地址要拒绝');
  assert.throws(() => validatePlan({ chains: { eth: { amount: '1', items: [{ customer_id: 'manual-01', address: flipped }] } } }), /地址格式不对/);
  assert.ok(!isValidAddress('eth', '0x' + '0'.repeat(40)));
  assert.ok(!isValidAddress('eth', '0x1234'));
  assert.ok(!isValidAddress('eth', TRON_ADDRS[0]));
  assert.ok(isValidAddress('tron', TRON_ADDRS[0]));
  assert.ok(!isValidAddress('tron', TRON_ADDRS[0].slice(0, -1) + (TRON_ADDRS[0].endsWith('k') ? 'm' : 'k')));
  assert.ok(!isValidAddress('tron', evmAddr(1)));
});

test('清单核对：上限 50、重复（不分大小写）、代币合约、部署账户、别的链的客户标识、不认识的链都拒绝', () => {
  assert.equal(validatePlan({ chains: { eth: ethPlan(50) } }).chains.eth.items.length, 50);
  assert.throws(() => validatePlan({ chains: { eth: ethPlan(51) } }), /超过一次最多 50 个/);
  assert.throws(() => validatePlan({ chains: { eth: ethPlan(2, '1001') } }), /超过每个地址最多 1000/);
  const dup = ethPlan(2); dup.items[1].address = dup.items[0].address.toLowerCase();
  assert.throws(() => validatePlan({ chains: { eth: dup } }), /重复/);
  const tok = ethPlan(1); tok.items[0].address = ETH_TOKEN.toLowerCase();
  assert.throws(() => validatePlan({ chains: { eth: tok } }), /代币合约、部署账户或 staging 的系统地址/);
  const self = ethPlan(1); self.items[0].address = FROM;
  assert.throws(() => validatePlan({ chains: { eth: self } }, { exclude: { eth: [FROM] } }), /代币合约、部署账户或 staging 的系统地址/);
  const other = ethPlan(1); other.items[0].customer_id = customerIdFor('tron', '123', 1);
  assert.throws(() => validatePlan({ chains: { eth: other } }), /不是这条链的/);
  const badId = ethPlan(1); badId.items[0].customer_id = 'someone-else';
  assert.throws(() => validatePlan({ chains: { eth: badId } }), /客户标识格式不对/);
  assert.throws(() => validatePlan({ chains: { bsc: ethPlan(1) } }), /不认识的链/);
  assert.throws(() => validatePlan({ chains: { eth: { amount: '100', items: [] } } }), /没有地址/);
  assert.throws(() => validatePlan('[]'), /格式不对/);
});

test('手动填的地址：按空白或逗号拆开，客户标识 manual-01…，同样过核对', () => {
  const p = planFromList('tron', `${TRON_ADDRS[1]}, ${TRON_ADDRS[2]}`, '5');
  const v = validatePlan(p);
  assert.deepEqual(v.chains.tron.items.map((x) => x.customer_id), ['manual-01', 'manual-02']);
  assert.throws(() => validatePlan(planFromList('tron', 'Tabc', '5')), /地址格式不对/);
  // TRON 校验和不对（改一个字符）也拒绝
  const a = TRON_ADDRS[1];
  const bad = a.slice(0, -1) + (a.endsWith('2') ? '3' : '2');
  assert.ok(!isValidAddress('tron', bad));
});

test('staging 的系统地址（热钱包、冷钱包、parent、payout、batcher、factory、implementation、usdt）不能当收款地址', () => {
  const eth = stagingSystemAddresses(WALLETS, 'eth');
  const tron = stagingSystemAddresses(WALLETS, 'tron');
  const st = WALLETS.staging;
  for (const k of ['hot', 'parent', 'payout', 'batcher', 'factory', 'implementation', 'usdt']) if (st.evm.eth[k]) assert.ok(eth.includes(st.evm.eth[k]), `eth.${k}`);
  for (const a of [st.hot, st.usdt, st.tron.parent, st.tron.batcher, st.tron.factory, st.tron.implementation].filter(Boolean)) assert.ok(tron.includes(a), a);
  assert.ok(eth.length >= 5 && tron.length >= 5);
  for (const [chain, list] of [['eth', eth], ['tron', tron]]) {
    for (const a of list) {
      const plan = { chains: { [chain]: { amount: '1', items: [{ customer_id: 'manual-01', address: chain === 'eth' ? a.toLowerCase() : a }] } } };
      assert.throws(() => validatePlan(plan, { exclude: { [chain]: list } }), /代币合约、部署账户或 staging 的系统地址/, a);
    }
  }
});

test('遮盖表：私钥十六进制和十进制、节点地址和其中的 key、其他密钥值', () => {
  const mask = maskWith(secretList({ key: KEY, urls: ['https://eth-sepolia.example.com/v2/abcdefgh12345678'], values: ['tron-api-key-xyz'] }));
  const out = mask(`k=${KEY} d=${BigInt('0x' + KEY)} url=https://eth-sepolia.example.com/v2/abcdefgh12345678 part=abcdefgh12345678 t=tron-api-key-xyz`);
  assert.ok(!out.includes(KEY) && !out.includes(String(BigInt('0x' + KEY))) && !out.includes('abcdefgh12345678') && !out.includes('tron-api-key-xyz'));
});

// ---------- 第 2 步：以太坊（替身节点） ----------
function fakeEvm({ chainId = 11155111, balances = {}, deployerToken = 10n ** 12n, decimals = 6, failAt = -1, noCreditAt = -1 } = {}) {
  const bal = new Map(Object.entries(balances).map(([k, v]) => [k.toLowerCase(), v]));
  bal.set(FROM.toLowerCase(), deployerToken);
  const calls = [];
  const sent = [];
  let nonce = 7;
  const rpc = async (method, params = []) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId': return hex(chainId);
      case 'eth_call': {
        const { to, data } = params[0];
        assert.equal(to.toLowerCase(), ETH_TOKEN.toLowerCase(), '只读这个代币');
        if (data === '0x313ce567') return hex(decimals);
        if (data.startsWith('0x70a08231')) return hex(bal.get('0x' + data.slice(-40)) || 0n);
        throw new Error('unexpected call ' + data);
      }
      case 'eth_getTransactionCount': return hex(nonce);
      case 'eth_getBalance': return hex(10n ** 18n);
      case 'eth_gasPrice': return hex(10n ** 9n);
      case 'eth_maxPriorityFeePerGas': return hex(1);
      case 'eth_getBlockByNumber': return { baseFeePerGas: hex(10) };
      case 'eth_simulateV1': {
        const cs = params[0].blockStateCalls[0].calls;
        for (const c of cs) assert.equal(c.to.toLowerCase(), ETH_TOKEN.toLowerCase());
        return [{ calls: cs.map(() => ({ status: '0x1', gasUsed: hex(50_000) })) }];
      }
      case 'eth_estimateGas': return hex(50_000);
      case 'eth_sendRawTransaction': {
        const i = sent.length;
        sent.push(params[0]);
        nonce += 1;
        // 替身按发出顺序记账：收款地址取自 calldata（raw 里 transfer 的参数）
        const m = /a9059cbb([0-9a-f]{64})([0-9a-f]{64})/.exec(params[0]);
        if (i !== failAt && i !== noCreditAt) { const to = '0x' + m[1].slice(24); bal.set(to, (bal.get(to) || 0n) + BigInt('0x' + m[2])); }
        return keccakHex(Buffer.from(params[0].slice(2), 'hex'));
      }
      case 'eth_getTransactionReceipt': return { status: sent.length - 1 === failAt ? '0x0' : '0x1', gasUsed: hex(40_000), blockNumber: '0x10' };
      default: throw new Error('unexpected ' + method);
    }
  };
  return { rpc, calls, sent, bal };
}

test('以太坊：节点是主网（链 ID 1）或别的测试网，一笔都不发', async () => {
  for (const id of [1, 56, 97]) {
    const n = fakeEvm({ chainId: id });
    await assert.rejects(fundEvm(n.rpc, { key: KEY, token: ETH_TOKEN, plan: ethPlan(2), wait: fastWait }), /主网|不是 Sepolia/);
    assert.equal(n.sent.length, 0);
    assert.deepEqual(n.calls, ['eth_chainId']);
  }
});

test('以太坊：每个地址一笔 transfer 发给测试 USDT 合约，核对余额正好增加；已有余额的跳过', async () => {
  const plan = ethPlan(3);
  const n = fakeEvm({ balances: { [plan.items[1].address]: 100_000_000n } });
  const recs = await fundEvm(n.rpc, { key: KEY, token: ETH_TOKEN, plan, wait: fastWait });
  assert.deepEqual(recs.map((r) => r.status), ['ok', 'skipped', 'ok']);
  assert.equal(n.sent.length, 2);
  assert.ok(recs[0].txid.startsWith('0x') && recs[2].txid.startsWith('0x'));
  assert.equal(n.bal.get(plan.items[0].address.toLowerCase()), 100_000_000n);
  assert.ok(n.sent[0].includes(erc20TransferData(plan.items[0].address, 100_000_000n).slice(2)));
});

test('以太坊：部署账户测试 USDT 不够、小数位数不对，一笔都不发', async () => {
  const n = fakeEvm({ deployerToken: 150_000_000n });
  await assert.rejects(fundEvm(n.rpc, { key: KEY, token: ETH_TOKEN, plan: ethPlan(2), wait: fastWait }), /一笔都没有发/);
  assert.equal(n.sent.length, 0);
  const d = fakeEvm({ decimals: 18 });
  await assert.rejects(fundEvm(d.rpc, { key: KEY, token: ETH_TOKEN, plan: ethPlan(2), wait: fastWait }), /小数位数/);
  assert.equal(d.sent.length, 0);
});

test('以太坊：一笔链上失败立即停，后面的不发，记录里写清楚', async () => {
  const n = fakeEvm({ failAt: 1 });
  let last = [];
  await assert.rejects(fundEvm(n.rpc, { key: KEY, token: ETH_TOKEN, plan: ethPlan(3), wait: fastWait, onRecords: (r) => { last = r; } }), /链上失败/);
  assert.equal(n.sent.length, 2);
  assert.deepEqual(last.map((r) => r.status), ['ok', 'failed', 'not-sent']);
});

test('以太坊：回执成功但收款地址余额没有增加，立即停，后面的不发', async () => {
  const n = fakeEvm({ noCreditAt: 0 });
  let last = [];
  await assert.rejects(fundEvm(n.rpc, { key: KEY, token: ETH_TOKEN, plan: ethPlan(3), wait: fastWait, onRecords: (r) => { last = r; } }), /余额.*不是正好加 100.*已停止/);
  assert.equal(n.sent.length, 1, '只发了第一笔');
  assert.deepEqual(last.map((r) => r.status), ['failed', 'not-sent', 'not-sent']);
  assert.ok(last[0].txid.startsWith('0x'), '失败的那笔也记下交易号');
});

test('以太坊：清单里有部署账户自己、或传进来的系统地址，一笔都不发', async () => {
  const self = ethPlan(2); self.items[1].address = FROM;
  const n = fakeEvm();
  await assert.rejects(fundEvm(n.rpc, { key: KEY, token: ETH_TOKEN, plan: self, wait: fastWait }), /代币合约、部署账户或 staging 的系统地址/);
  assert.equal(n.sent.length, 0);
  const sys = ethPlan(2);
  const m = fakeEvm();
  await assert.rejects(fundEvm(m.rpc, { key: KEY, token: ETH_TOKEN, plan: sys, exclude: [sys.items[0].address.toLowerCase()], wait: fastWait }), /代币合约、部署账户或 staging 的系统地址/);
  assert.equal(m.sent.length, 0);
});

// ---------- 第 2 步：TRON（替身节点） ----------
function fakeTron({ network = 'nile', ok = true, credit = true, balances = {}, timeoutAt = -1 } = {}) {
  const signer = makeSigner(KEY);
  const bal = new Map([[signer.address, 10n ** 12n], ...Object.entries(balances)]);
  const sent = [];
  const node = {
    checkNetwork: async () => ({ network }),
    enc: () => '00',
    balance: async () => 1_000_000_000,
    post: async (path) => (path === '/wallet/getchainparameters' ? { chainParameter: [{ key: 'getEnergyFee', value: 210 }] } : { energy_used: 30_000 }),
    call: async (token, sig, types, values) => {
      assert.equal(token, TRON_TOKEN);
      if (sig === 'decimals()') return (6).toString(16).padStart(64, '0');
      return (bal.get(values[0]) || 0n).toString(16).padStart(64, '0');
    },
    send: async (s, token, sig, types, values) => {
      assert.equal(token, TRON_TOKEN);
      assert.equal(sig, 'transfer(address,uint256)');
      sent.push(values);
      if (sent.length - 1 === timeoutAt) throw new Error(`transaction not confirmed in time: ${'cd'.repeat(32)}`);
      if (credit) bal.set(values[0], (bal.get(values[0]) || 0n) + BigInt(values[1]));
      return { txId: 'ab'.repeat(32), ok, info: { receipt: { result: ok ? 'SUCCESS' : 'REVERT' } } };
    },
  };
  return { node, signer, sent };
}
const tronPlan = () => ({ amount: '100', items: TRON_ADDRS.slice(1).map((address, i) => ({ customer_id: customerIdFor('tron', '9', i + 1), address })) });

test('TRON：不是 Nile 一笔都不发', async () => {
  const t = fakeTron({ network: 'local' });
  await assert.rejects(fundTron(t.node, t.signer, { token: TRON_TOKEN, plan: tronPlan() }), /不是 Nile/);
  assert.equal(t.sent.length, 0);
});

test('TRON：逐笔 transfer、核对余额；回执成功但余额没加（transfer 返回 false 那类）也算失败并停下', async () => {
  const t = fakeTron();
  const recs = await fundTron(t.node, t.signer, { token: TRON_TOKEN, plan: tronPlan() });
  assert.deepEqual(recs.map((r) => r.status), ['ok', 'ok']);
  assert.equal(t.sent.length, 2);
  const bad = fakeTron({ credit: false });
  await assert.rejects(fundTron(bad.node, bad.signer, { token: TRON_TOKEN, plan: tronPlan() }), /没有成功/);
  assert.equal(bad.sent.length, 1);
});

test('TRON：已经有足够余额的地址跳过（重跑不重复打）', async () => {
  const plan = tronPlan();
  const t = fakeTron({ balances: { [plan.items[0].address]: 100_000_000n } });
  const recs = await fundTron(t.node, t.signer, { token: TRON_TOKEN, plan });
  assert.deepEqual(recs.map((r) => r.status), ['skipped', 'ok']);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0][0], plan.items[1].address);
});

test('TRON：等回执超时也记下交易号，停下', async () => {
  const t = fakeTron({ timeoutAt: 0 });
  let last = [];
  await assert.rejects(fundTron(t.node, t.signer, { token: TRON_TOKEN, plan: tronPlan(), onRecords: (r) => { last = r; } }), /等回执超时/);
  assert.equal(last[0].txid, 'cd'.repeat(32));
  assert.deepEqual(last.map((r) => r.status), ['failed', 'not-sent']);
  assert.equal(t.sent.length, 1);
});

test('TRON：部署账户自己不能在清单里', async () => {
  const t = fakeTron();
  const plan = { amount: '1', items: [{ customer_id: 'manual-01', address: t.signer.address }] };
  await assert.rejects(fundTron(t.node, t.signer, { token: TRON_TOKEN, plan }), /代币合约、部署账户或 staging 的系统地址/);
});

// ---------- 第 1 步：开放 API（替身） ----------
function fakeApi({ orderMode = true, addrs = {} } = {}) {
  const reqs = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    reqs.push({ method: init.method, path: u.pathname + u.search, headers: init.headers, body: init.body });
    const path = u.pathname + u.search;
    // 签名和服务器同一个函数核对
    assert.equal(init.headers['x-topup-signature'], signRequest('sec', init.headers['x-topup-timestamp'], init.method, path, init.body || ''));
    if (init.method === 'POST') {
      const b = JSON.parse(init.body);
      assert.ok(init.headers['idempotency-key'] === `fund-${b.customer_id}`);
      addrs[b.customer_id] ||= evmAddr(Object.keys(addrs).length + 1);
      if (!orderMode) return new Response(JSON.stringify({ error: { code: 'order_mode_disabled', message: 'x' } }), { status: 403 });
      return new Response(JSON.stringify({ order_no: 'o1', address: addrs[b.customer_id], chain: b.chain }), { status: 200 });
    }
    const id = u.searchParams.get('customer_id');
    return new Response(JSON.stringify({ customer_id: id, name: '某商户的客户', addresses: addrs[id] ? [{ chain: 'eth', address: addrs[id] }] : [] }), { status: 200 });
  };
  return { fetchImpl, reqs, addrs };
}

test('第 1 步：签名请求建单生成地址、再读客户核对；没开订单模式时以读到的地址为准；输出只有客户标识和地址', async () => {
  for (const orderMode of [true, false]) {
    const api = fakeApi({ orderMode });
    const call = merchantClient({ base: 'https://staging.example.test/', key: 'k', secret: 'sec', fetchImpl: api.fetchImpl });
    const plan = await collect(call, { chains: ['eth'], count: 3, amount: '100', run: '777' });
    assert.deepEqual(plan.chains.eth.items.map((x) => x.customer_id), ['fee-ac3-eth-777-01', 'fee-ac3-eth-777-02', 'fee-ac3-eth-777-03']);
    assert.deepEqual(Object.keys(plan.chains.eth.items[0]).sort(), ['address', 'customer_id']);
    assert.ok(!JSON.stringify(plan).includes('某商户') && !JSON.stringify(plan).includes('example.test'));
    assert.deepEqual(api.reqs.map((r) => `${r.method} ${r.path.split('?')[0]}`).slice(0, 2), ['POST /api/v1/orders/', 'GET /api/v1/customers/']);
  }
});

test('第 1 步：建单返回的地址和客户的不一样、接口报别的错，停下；错误里没有测试环境地址和响应内容', async () => {
  const api = fakeApi();
  const call = merchantClient({ base: 'https://staging.example.test', key: 'k', secret: 'sec', fetchImpl: async (url, init) => {
    if (init.method === 'GET') return new Response(JSON.stringify({ addresses: [{ chain: 'eth', address: evmAddr(40) }] }), { status: 200 });
    return api.fetchImpl(url, init);
  } });
  await assert.rejects(addressFor(call, { chain: 'eth', customerId: 'fee-ac3-eth-1-01', amount: '100' }), /不一样/);
  const call2 = merchantClient({ base: 'https://staging.example.test', key: 'k', secret: 'sec', fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'chain_not_enabled', message: 'secret detail' } }), { status: 409 }) });
  await assert.rejects(addressFor(call2, { chain: 'tron', customerId: 'fee-ac3-tron-1-01', amount: '100' }), (e) => /chain_not_enabled/.test(e.message) && !/example\.test|secret detail/.test(e.message));
});

// ---------- 流程文件 ----------
test('流程：第 1 步在环境 staging-e2e、第 2 步在环境 testnet；私钥只给第 2 步；只在 staging 或 testnet-fund/** 上跑', () => {
  const y = readFileSync(new URL('../.github/workflows/testnet-fund.yml', import.meta.url), 'utf8');
  const [, job1, job2] = /\n {2}addresses:\n([\s\S]*?)\n {2}fund:\n([\s\S]*)$/.exec(y);
  assert.match(job1, /environment: staging-e2e/);
  assert.match(job2, /environment: testnet/);
  assert.ok(!job1.includes('TOPUP_TESTNET_DEPLOYER_KEY'));
  assert.ok(!job2.includes('STAGING_E2E_MERCHANT'));
  for (const j of [job1, job2]) assert.match(j, /github\.ref == 'refs\/heads\/staging' \|\| \(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/heads\/testnet-fund\/'\)\)/);
  assert.match(y, /branches: \['testnet-fund\/\*\*'\]/);
  assert.match(job2, /needs: addresses/);
});

test('流程文件：只读权限、checkout 不留令牌、action 都按提交号固定、run 里没有 ${{ }}、npm ci 不跑安装脚本', () => {
  const y = readFileSync(new URL('../.github/workflows/testnet-fund.yml', import.meta.url), 'utf8');
  assert.match(y, /\npermissions:\n {2}contents: read\n/);
  assert.ok(!/write/.test(y.split('\njobs:')[0].split('permissions:')[1] || ''), '顶层权限里没有 write');
  const uses = [...y.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 6);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${u} 按提交号固定`);
  const checkouts = y.split('uses: actions/checkout@').slice(1);
  assert.equal(checkouts.length, 2);
  for (const c of checkouts) assert.match(c.split('- uses:')[0], /persist-credentials: false/);
  // run: 后面（单行或 | 块）不出现 ${{ }}：参数一律经环境变量传
  const lines = y.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    const block = [m[2]];
    if (/^[|>]/.test(m[2].trim())) for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) block.push(lines[j]);
    assert.ok(!block.join('\n').includes('${{'), `第 ${i + 1} 行的 run 里有 \${{ }}`);
  }
  const npm = [...y.matchAll(/run: (npm ci.*)/g)].map((m) => m[1]);
  assert.deepEqual(npm, ['npm ci --ignore-scripts', 'npm ci --ignore-scripts']);
});
