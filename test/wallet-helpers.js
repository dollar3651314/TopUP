// 钱包接口层测试共用的小工具（不是测试文件，npm test 不单独运行它）：
//   - fakeEvm：替身以太坊 JSON-RPC 节点（读日志、区块、回执、代码、余额，以及发交易要用的 chainId、gasPrice、nonce、estimateGas、sendRawTransaction），
//     记录每次请求，支持批量请求；down = true 时模拟连不上节点，downFor 列出的方法单独连不上
//   - setupDb：建表后插入一个商户和若干客户
//   - Transfer 事件的编码
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import { keccak_256 } from '@noble/hashes/sha3';

export const hex = (b) => Buffer.from(b).toString('hex');
export const TRANSFER_TOPIC = '0x' + hex(keccak_256(Buffer.from('Transfer(address,address,uint256)')));
export const topicOf = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const quiet = { error: () => {}, log: () => {}, warn: () => {} };

/** 一条 USDT Transfer 日志（eth_getLogs 的返回格式） */
export function transferLog({ token, from, to, raw, block, txid, logIndex = 0 }) {
  return {
    address: token.toLowerCase(),
    topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)],
    data: '0x' + BigInt(raw).toString(16).padStart(64, '0'),
    blockNumber: '0x' + block.toString(16),
    transactionHash: txid,
    logIndex: '0x' + logIndex.toString(16),
    removed: false,
  };
}

/**
 * 替身节点。state：{ head, logs: [], blockTime: (n) => 秒, receipts: { [hash]: { status, blockNumber } | null }, down, code: { [addr]: '0x..' } }
 * eth_getLogs 按 address、topics[0]、topics[2]（to）和区块范围过滤，和真实节点一样。
 */
export function fakeEvm(state = {}) {
  const s = { head: 100, logs: [], blockTime: (n) => 1_700_000_000 + n * 12, receipts: {}, code: {}, down: false, downFor: [], sent: [], balances: {}, ...state };
  const calls = [];
  const handle = ({ id, method, params = [] }) => {
    calls.push({ method, params });
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'eth_chainId': return ok('0x7a69');
      case 'eth_blockNumber': return ok('0x' + s.head.toString(16));
      case 'eth_getBlockByNumber': {
        const n = Number(BigInt(params[0]));
        return ok(n > s.head ? null : { number: '0x' + n.toString(16), timestamp: '0x' + s.blockTime(n).toString(16), hash: '0x' + n.toString(16).padStart(64, '0') });
      }
      case 'eth_getLogs': {
        const f = params[0] || {};
        const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
        if (to > s.head) return { jsonrpc: '2.0', id, error: { code: -32000, message: 'block range extends beyond current head block' } };
        const addrs = [].concat(f.address || []).map((a) => a.toLowerCase());
        const t = f.topics || [];
        const want = (i, v) => t[i] == null || [].concat(t[i]).map((x) => x.toLowerCase()).includes(v.toLowerCase());
        return ok(s.logs.filter((l) => {
          const b = Number(BigInt(l.blockNumber));
          return b >= from && b <= to && (!addrs.length || addrs.includes(l.address.toLowerCase())) && want(0, l.topics[0]) && want(1, l.topics[1]) && want(2, l.topics[2]);
        }));
      }
      case 'eth_getTransactionReceipt': {
        const r = s.receipts[params[0]];
        return ok(r ? { transactionHash: params[0], status: r.status, blockNumber: '0x' + r.blockNumber.toString(16), logs: r.logs || [] } : null);
      }
      case 'eth_getCode': return ok(s.code[String(params[0]).toLowerCase()] || '0x');
      case 'eth_gasPrice': return ok('0x3b9aca00');
      case 'eth_getTransactionCount': return ok('0x0');
      case 'eth_estimateGas': return ok('0x30d40');
      case 'eth_getBalance': return ok('0x' + (10n ** 18n).toString(16));
      case 'eth_call': { // 只支持 balanceOf(address)
        const d = String(params[0]?.data || '');
        if (d.startsWith('0x70a08231')) return ok('0x' + BigInt(s.balances[('0x' + d.slice(-40)).toLowerCase()] || 0).toString(16).padStart(64, '0'));
        return ok('0x');
      }
      case 'eth_sendRawTransaction': { s.sent.push(params[0]); return ok('0x' + hex(keccak_256(Buffer.from(String(params[0]).slice(2), 'hex')))); }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  };
  const fetchImpl = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    // down：整个节点连不上；downFor：请求里有这些方法时连不上（模拟广播时断线）
    if (s.down || [].concat(body).some((x) => s.downFor.includes(x.method))) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const out = Array.isArray(body) ? body.map(handle) : handle(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { state: s, calls, fetchImpl, rpcUrl: 'http://fake-evm.test/' };
}

const FEE = JSON.stringify({ ppm: 0, fixed: 0, min: 0 });

/** 建表，插入商户 m1（以及可选的 m2）和客户；返回 db */
export async function setupDb({ customers = [['m1', 'c1']], merchants = ['m1'] } = {}) {
  const db = await createTestDb();
  await migrate(db);
  for (const m of merchants) {
    await db.query(`insert into merchants (id, name, fee_in, fee_out, order_mode) values ($1, $1, $2::jsonb, $2::jsonb, '{"enabled":false}'::jsonb)`, [m, FEE]);
    await db.query('insert into balances (merchant_id) values ($1)', [m]);
  }
  let i = 0;
  for (const [m, c] of customers) {
    i++;
    // 现有的 TRON 地址列（customers.address、hd_index）保持原样；用不会和合约地址撞的假 TRON 地址
    await db.query('insert into customers (merchant_id, customer_id, address, hd_index) values ($1, $2, $3, $4)', [m, c, `T${String(i).padStart(33, 'x')}`, i]);
  }
  return db;
}

/** 账本和商户余额的快照：归集前后必须完全一样 */
export async function moneySnapshot(db) {
  const ledger = await db.query('select count(*)::int n, coalesce(sum(amount), 0)::bigint s from ledger');
  const balances = await db.query('select merchant_id, available, frozen from balances order by merchant_id');
  return JSON.stringify({ ledger, balances });
}
