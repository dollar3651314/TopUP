// 原型的模拟数据（全部虚构）。商户后台、付款页面和运营后台共用，格式与正式接口一致。
// ?empty=1：空数据，用来确认空状态；?ordermode=0：订单模式关闭。
import { calcFee, type FeeRule } from '../lib/money';
import { stateOf, type MatchSettings, type MDeposit, type MOrder, type OrderState } from '../lib/matching';

const q = new URLSearchParams(location.search);
export const EMPTY = q.get('empty') === '1';
const U = 1_000_000;
const now = Date.now();
export const ago = (min: number) => new Date(now - min * 60_000).toISOString();

// 固定种子的伪随机数，保证每次打开看到的数据一样
let seed = 20260929;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const fakeAddr = () => 'T' + Array.from({ length: 33 }, () => B58[Math.floor(rnd() * 58)]).join('');
export const fakeTx = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

export interface OrderMode extends MatchSettings { enabled: boolean }
export interface Merchant { id: string; name: string; status: 'active' | 'disabled'; feeIn: FeeRule; feeOut: FeeRule; mode: OrderMode; available: number; frozen: number; customers: number; ipWhitelist: string[]; cashoutWallets: string[]; since: string }
export const defaultMode = (): OrderMode => ({ enabled: true, low: 900_000, high: 1_100_000, ttlMin: 30, lookbackH: 24 });
export const merchants: Merchant[] = EMPTY ? [] : [
  { id: 'm1', name: 'Acme Export Ltd', status: 'active', feeIn: { ppm: 10000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, mode: { ...defaultMode(), enabled: q.get('ordermode') !== '0' }, available: 48_215_400_000, frozen: 1_002_000_000, customers: 6, ipWhitelist: ['203.0.113.10'], cashoutWallets: [fakeAddr()], since: ago(60 * 24 * 20) },
  { id: 'm2', name: 'Delta Trading Co.', status: 'active', feeIn: { ppm: 8000, fixed: 0, min: 500_000 }, feeOut: { ppm: 1000, fixed: 1 * U, min: 0 }, mode: { enabled: true, low: 950_000, high: 1_050_000, ttlMin: 60, lookbackH: 12 }, available: 12_380_120_000, frozen: 332_330_000, customers: 3, ipWhitelist: [], cashoutWallets: [fakeAddr()], since: ago(60 * 24 * 12) },
  { id: 'm3', name: 'Sunrise Co', status: 'active', feeIn: { ppm: 0, fixed: 1 * U, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, mode: { ...defaultMode(), enabled: false }, available: 906_200_000, frozen: 0, customers: 1, ipWhitelist: [], cashoutWallets: [], since: ago(60 * 24 * 3) },
  { id: 'm4', name: 'Northwind Manufacturing Co.', status: 'disabled', feeIn: { ppm: 10000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, mode: defaultMode(), available: 0, frozen: 0, customers: 0, ipWhitelist: [], cashoutWallets: [], since: ago(60 * 24 * 30) },
];
/** 开户已通过、还没开通收付款的企业（来自 开户申请） */
export const approvedApps = EMPTY ? [] : [{ id: 'a0', ref: 'TU-2026-0000', company: 'Harbor Legacy Ltd', email: 'finance@harbor-legacy.example' }];

// ---------- 当前商户（商户后台只看得到 Acme Export） ----------
export const me: Merchant = merchants[0] || { id: 'm1', name: 'Acme Export Ltd', status: 'active', feeIn: { ppm: 10000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, mode: defaultMode(), available: 0, frozen: 0, customers: 0, ipWhitelist: [], cashoutWallets: [fakeAddr()], since: ago(1) };

// ---------- 客户 ----------
export interface Customer { merchantId: string; id: string; name: string; email: string; remark: string; address: string; createdAt: string }
const cust = (merchantId: string, id: string, name: string, email: string, days: number, remark = ''): Customer => ({ merchantId, id, name, email, remark, address: fakeAddr(), createdAt: ago(60 * 24 * days) });
export const customers: Customer[] = EMPTY ? [] : [
  cust('m1', 'user_88213', 'Lin Trading', 'lin@lintrading.example', 18, 'VIP'),
  cust('m1', 'user_77120', 'Oak Retail', '', 9),
  cust('m1', 'buyer@northstar.example', 'Northstar GmbH', 'buyer@northstar.example', 6),
  cust('m1', 'user_10442', '', '', 2),
  cust('m1', 'user_20931', 'Blue Harbor', 'ap@blueharbor.example', 1),
  cust('m1', 'user_31007', 'Kestrel Ltd', '', 0.2),
  cust('m2', '10293', 'Pacific Imports', '', 11), cust('m2', '10311', '', '', 5), cust('m2', '10347', 'Gulf Supplies', '', 1),
  cust('m3', 's-551', '', '', 2),
];
export const customerOf = (merchantId: string, id: string) => customers.find((c) => c.merchantId === merchantId && c.id === id);
/** 客户第一次出现时自动创建，并推导一个新地址 */
export function ensureCustomer(merchantId: string, id: string, name = '', email = ''): Customer {
  let c = customerOf(merchantId, id);
  if (!c) { c = { merchantId, id, name, email, remark: '', address: fakeAddr(), createdAt: new Date().toISOString() }; customers.unshift(c); }
  return c;
}

// ---------- 订单 ----------
export type { OrderState };
export interface Order extends MOrder { merchantId: string; merchantNo: string }
const ord = (i: number, customer: string, amount: number, minAgo: number, ttl = 30): Order => ({
  merchantId: 'm1', id: `ORD-20260929-${String(412 - i).padStart(4, '0')}`, merchantNo: `ACME-${88100 + 412 - i}`, customer, amount, matched: 0,
  createdAt: ago(minAgo), expiresAt: ago(minAgo - ttl), status: 'pending', low: me.mode.low, high: me.mode.high,
});
export const orders: Order[] = EMPTY ? [] : [
  ord(0, 'user_20931', 500 * U, 6), ord(1, 'user_31007', 1_000 * U, 12), ord(2, 'user_88213', 250 * U, 5),
  ord(3, 'user_88213', 500 * U, 40), ord(4, 'buyer@northstar.example', 300 * U, 55), ord(5, 'user_77120', 120 * U, 80),
  ord(6, 'user_10442', 80 * U, 200), ord(7, 'user_77120', 2_000 * U, 260), ord(8, 'buyer@northstar.example', 60 * U, 300),
];

// ---------- 到账 ----------
export type DepResult = 'confirming' | 'credited' | 'below_min';
export interface Deposit extends MDeposit { merchantId: string; txid: string; address: string; fee: number; result: DepResult; confirmations?: number }
const dep = (minAgo: number, customer: string, amount: number, result: DepResult = 'credited', orderId: string | null = null, confirmations?: number): Deposit => ({
  merchantId: 'm1', id: 'd' + minAgo, time: ago(minAgo), txid: fakeTx(), address: customerOf('m1', customer)?.address || fakeAddr(), customer, amount,
  fee: result === 'credited' ? calcFee(amount, me.feeIn) : 0, result, credited: result === 'credited', orderId, matchType: orderId ? 'deposit' : undefined, confirmations,
});
export const deposits: Deposit[] = EMPTY ? [] : [
  dep(1, 'user_31007', 1_000 * U, 'confirming', null, 12),
  dep(26 * 60, 'user_88213', 250 * U), // 超过 24 小时回看时间，建单时不会自动匹配，用来演示手动匹配
  dep(35, 'user_88213', 500 * U, 'credited', 'ORD-20260929-0409'),
  dep(50, 'buyer@northstar.example', 150 * U, 'credited', 'ORD-20260929-0408'),
  dep(75, 'user_77120', 140 * U, 'credited', 'ORD-20260929-0407'),
  dep(47, 'user_10442', 300_000, 'below_min'),
  dep(190, 'user_10442', 40 * U, 'credited', 'ORD-20260929-0406'),
  dep(250, 'user_77120', 1_200 * U, 'credited', 'ORD-20260929-0405'),
  dep(240, 'user_77120', 800 * U, 'credited', 'ORD-20260929-0405'),
  dep(290, 'buyer@northstar.example', 59_900_000, 'credited', 'ORD-20260929-0404'),
  dep(600, 'user_20931', 75 * U),
];
// 按已匹配的到账计算订单的累计金额和状态
for (const o of orders) { o.matched = deposits.filter((d) => d.orderId === o.id).reduce((s, d) => s + d.amount, 0); o.status = stateOf(o); }

// ---------- 提币 ----------
export type WdStatus = 'pending' | 'rejected' | 'cancelled' | 'signing' | 'broadcast' | 'completed' | 'failed';
export interface Withdrawal { id: string; merchant: string; merchantId: string; kind: 'payout' | 'cashout'; customer?: string; to: string; amount: number; fee: number; source: 'web' | 'api'; status: WdStatus; time: string; txid?: string; reason?: string }
export const withdrawals: Withdrawal[] = EMPTY ? [] : [
  { id: 'WD-0031', merchant: 'Acme Export Ltd', merchantId: 'm1', kind: 'payout', customer: 'user_88213', to: fakeAddr(), amount: 1_000 * U, fee: 2 * U, source: 'web', status: 'pending', time: ago(14) },
  { id: 'WD-0030', merchant: 'Delta Trading Co.', merchantId: 'm2', kind: 'payout', customer: '10293', to: fakeAddr(), amount: 250 * U, fee: 1_250_000, source: 'api', status: 'pending', time: ago(22) },
  { id: 'WD-0029', merchant: 'Delta Trading Co.', merchantId: 'm2', kind: 'payout', to: fakeAddr(), amount: 80 * U, fee: 1_080_000, source: 'api', status: 'pending', time: ago(31) },
  { id: 'WD-0028', merchant: 'Acme Export Ltd', merchantId: 'm1', kind: 'payout', customer: 'user_77120', to: fakeAddr(), amount: 350 * U, fee: 2 * U, source: 'api', status: 'completed', time: ago(220), txid: fakeTx() },
  { id: 'WD-0027', merchant: 'Acme Export Ltd', merchantId: 'm1', kind: 'cashout', to: me.cashoutWallets[0], amount: 20_000 * U, fee: 2 * U, source: 'web', status: 'completed', time: ago(60 * 16), txid: fakeTx() },
  { id: 'WD-0026', merchant: 'Acme Export Ltd', merchantId: 'm1', kind: 'payout', to: fakeAddr(), amount: 45 * U, fee: 2 * U, source: 'web', status: 'rejected', time: ago(60 * 30), reason: '收款地址与付款说明不符 / Address does not match the payment note' },
];

// ---------- 账本 ----------
export type LedgerType = 'deposit' | 'fee_in' | 'freeze' | 'unfreeze' | 'withdraw' | 'fee_out';
export interface Ledger { time: string; type: LedgerType; amount: number; balance: number; ref: string; customer?: string }
export const ledger: Ledger[] = (() => {
  if (EMPTY) return [];
  const rows: Ledger[] = [];
  let bal = me.available;
  const push = (time: string, type: LedgerType, amount: number, ref: string, customer?: string) => { rows.push({ time, type, amount, balance: bal, ref, customer }); bal -= amount; };
  push(ago(14), 'freeze', -1_002 * U, 'WD-0031', 'user_88213');
  for (const d of deposits.filter((x) => x.credited)) { push(d.time, 'fee_in', -d.fee, d.txid.slice(0, 10), d.customer); push(d.time, 'deposit', d.amount, d.txid.slice(0, 10), d.customer); }
  return rows;
})();

// ---------- 回调 ----------
export type CbEvent = 'deposit' | 'order' | 'withdrawal';
export interface Callback { id: string; time: string; event: CbEvent; ref: string; attempts: number; result: 'ok' | 'retrying' | 'failed'; code: number | null; next?: string }
export const callbacks: Callback[] = EMPTY ? [] : [
  { id: 'evt_9f2a01', time: ago(8), event: 'deposit', ref: 'user_88213', attempts: 1, result: 'ok', code: 200 },
  { id: 'evt_9f2a02', time: ago(8), event: 'order', ref: 'ORD-20260929-0409', attempts: 1, result: 'ok', code: 200 },
  { id: 'evt_9f29f7', time: ago(11), event: 'deposit', ref: 'user_88213', attempts: 3, result: 'retrying', code: 502, next: ago(-24) },
  { id: 'evt_9f29c1', time: ago(14), event: 'withdrawal', ref: 'WD-0031', attempts: 1, result: 'ok', code: 200 },
  { id: 'evt_9f2811', time: ago(60 * 26), event: 'deposit', ref: 'user_77120', attempts: 8, result: 'failed', code: null },
];

// ---------- 运营后台：归集 ----------
export interface SweepRow { id: string; merchant: string; customer: string; address: string; balance: number; lastDeposit: string; activated: boolean }
export const sweepRows: SweepRow[] = EMPTY ? [] : [
  { id: 's1', merchant: 'Acme Export Ltd', customer: 'user_88213', address: fakeAddr(), balance: 8_420 * U, lastDeposit: ago(11), activated: true },
  { id: 's2', merchant: 'Acme Export Ltd', customer: 'user_31007', address: fakeAddr(), balance: 2_300 * U, lastDeposit: ago(40), activated: false },
  { id: 's3', merchant: 'Acme Export Ltd', customer: 'user_77120', address: fakeAddr(), balance: 3_450 * U, lastDeposit: ago(260), activated: true },
  { id: 's4', merchant: 'Delta Trading Co.', customer: '10293', address: fakeAddr(), balance: 1_150 * U, lastDeposit: ago(95), activated: true },
  { id: 's5', merchant: 'Delta Trading Co.', customer: '10311', address: fakeAddr(), balance: 610 * U, lastDeposit: ago(130), activated: true },
  { id: 's6', merchant: 'Delta Trading Co.', customer: '10347', address: fakeAddr(), balance: 2_549_800_000, lastDeposit: ago(300), activated: true },
  { id: 's7', merchant: 'Sunrise Co', customer: 's-551', address: fakeAddr(), balance: 6_200_000, lastDeposit: ago(60 * 30), activated: true },
];
export const wallet = {
  initialized: !EMPTY,
  hot: { address: fakeAddr(), usdt: 4_120 * U, trx: 3_210 * U, stakedTrx: 60_000 * U, energy: 420_000, energyMax: 820_000 },
  cold: { address: fakeAddr(), usdt: 250_000 * U },
  firstAddress: fakeAddr(),
};
/** 一笔 USDT 转账到已经有 USDT 的地址，大约需要的能量；燃烧 TRX 时大约需要的 TRX（按链上实时价格计算，这里是示意） */
export const ENERGY_PER_SWEEP = 65_000;
export const BURN_TRX_PER_SWEEP = 6.9;
export const ACTIVATE_TRX = 1.1;

export interface Anomaly { id: string; time: string; type: 'token' | 'below_min'; merchant: string; customer: string; address: string; amount: string; handled: boolean }
export const anomalies: Anomaly[] = EMPTY ? [] : [
  { id: 'x1', time: ago(47), type: 'below_min', merchant: 'Acme Export Ltd', customer: 'user_10442', address: fakeAddr(), amount: '0.30 USDT', handled: false },
  { id: 'x3', time: ago(60 * 20), type: 'token', merchant: 'Delta Trading Co.', customer: '10293', address: fakeAddr(), amount: '15.00 USDC', handled: false },
  { id: 'x4', time: ago(60 * 50), type: 'token', merchant: 'Sunrise Co', customer: 's-551', address: fakeAddr(), amount: '2.00 TRX', handled: true },
];

export interface Recon { date: string; balances: number; chain: number; fees: number; diff: number }
export const recon: Recon[] = EMPTY ? [] : [0, 1, 2, 3, 4, 5, 6].map((i) => {
  const balances = 61_503_720_000 - i * 3_100_000_000;
  const fees = 1_200_000_000 + i * 20_000_000;
  const diff = i === 3 ? -12_000_000 : 0;
  return { date: new Date(now - (i + 1) * 864e5).toISOString().slice(0, 10), balances, chain: balances + fees + diff, fees, diff };
});

export const quota = [
  { key: 'disk', name: '服务器磁盘', used: 9_800, limit: 81_920, unit: 'MB' },
  { key: 'trongrid', name: 'TronGrid 请求（今天）', used: 11_820, limit: 100_000, unit: '次' },
];

/** 客户统计：累计收款、笔数、手续费、最近付款、未匹配金额（只算已入账的到账） */
export function customerStats(merchantId: string, id: string, since = 0) {
  const ds = deposits.filter((d) => d.merchantId === merchantId && d.customer === id && d.credited && Date.parse(d.time) >= since);
  return {
    total: ds.reduce((s, d) => s + d.amount, 0), count: ds.length, fees: ds.reduce((s, d) => s + d.fee, 0),
    last: ds.map((d) => d.time).sort().pop() || '', unmatched: ds.filter((d) => !d.orderId).reduce((s, d) => s + d.amount, 0),
  };
}
