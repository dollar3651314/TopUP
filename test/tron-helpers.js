// TRON 合约钱包测试共用的小工具（不是测试文件，npm test 不单独运行它）：
//   - fakeTronNode：替身 TRON 全节点（java-tron HTTP 接口，/wallet/*），数据在内存里，记录每次请求；
//     支持扫块（gettransactioninfobyblocknum）、只读调用（balanceOf、parent()、factory()、implementationAddress()）、
//     建交易（triggersmartcontract）、广播（broadcasthex，核对签名人 = 发起地址）、按交易号查回执、账户、链参数；
//     down = true 时整个节点连不上，downFor 列出的路径单独连不上，httpStatus 让所有请求返回这个 HTTP 状态
//   - 收到发给批量合约的 sweep(address,bytes32[])：按盐算出 0x41 转发地址，把代币余额转给 parent，发 Swept / SweepFailed 事件
//   - 测试用的发起账户私钥每次随机生成，只活在这个测试进程里（不是任何真实或测试网账户）
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import { addr20, toBase58, forwarderAddress as tronForwarder } from '../scripts/tron-nile/tron-create2.mjs';
import { fields } from '../server/pay/txcodec.js';
import { signerOf } from '../server/pay/signing.js';

export const kHex = (s) => hex.encode(keccak_256(Buffer.from(s)));
export const TRANSFER_TOPIC = kHex('Transfer(address,address,uint256)');
export const APPROVAL_TOPIC = kHex('Approval(address,address,uint256)');
export const SWEPT_TOPIC = kHex('Swept(bytes32,address,bool)');
export const SWEEP_FAILED_TOPIC = kHex('SweepFailed(bytes32,address,bytes)');
export const SWEEP_SELECTOR = kHex('sweep(address,bytes32[])').slice(0, 8);
export const quiet = { error: () => {}, log: () => {}, warn: () => {} };

/** 任意格式（T 开头、41 开头十六进制、0x 十六进制）→ 20 字节小写十六进制 */
export const h20 = (a) => hex.encode(addr20(a));
/** 任意格式 → T 开头 */
export const T = (a) => toBase58(addr20(a));
export const word = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
/** 随机的 TRON 地址（只当作合约地址、冷钱包地址用，没有私钥） */
export const randomTron = () => toBase58(randomBytes(20));
/** 测试进程里随机生成的发起账户：{ key（64 位十六进制）, address } */
export function testOperator() {
  const key = randomBytes(32).toString('hex');
  const pub = secp256k1.getPublicKey(hex.decode(key), false);
  return { key, address: toBase58(keccak_256(pub.slice(1)).slice(-20)) };
}

/** 一套 TRON 合约参数（随机地址）：{ ver, factory, implementation, parent, batcher } + usdt */
export function tronScheme() {
  return { scheme: { ver: 1, factory: randomTron(), implementation: randomTron(), parent: randomTron(), batcher: randomTron() }, usdt: randomTron() };
}
/** 盐对应的 0x41 转发地址（scripts/tron-nile/tron-create2.mjs，已在本机 TRON 私链上核对过） */
export const forwarderOf = (scheme, salt) => tronForwarder({ factory: scheme.factory, implementation: scheme.implementation, parent: scheme.parent, feeAddress: scheme.batcher, salt }).tron;

// ---------- protobuf（只编码替身要返回的 TriggerSmartContract 交易原文） ----------
const varint = (x) => { const out = []; let v = BigInt(x); do { let c = Number(v & 0x7fn); v >>= 7n; if (v) c |= 0x80; out.push(c); } while (v); return out; };
const lenF = (no, bytes) => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
const intF = (no, v) => [...varint((no << 3) | 0), ...varint(v)];
/** 交易原文的字段编码（测试里拼"带重复字段 / 多余字段"的原文用） */
export const proto = { len: lenF, int: intF };
function encodeTrigger({ owner, contract, data, feeLimit, callValue = 0, refBlock, refHash, ownerPrefix = 0x41, contractPrefix = 0x41, extraParam = [] }) {
  const p = [...lenF(1, [ownerPrefix, ...addr20(owner)]), ...lenF(2, [contractPrefix, ...addr20(contract)]), ...(callValue ? intF(3, callValue) : []), ...lenF(4, Array.from(hex.decode(data))), ...extraParam];
  const typeUrl = Array.from(Buffer.from('type.googleapis.com/protocol.TriggerSmartContract'));
  const c = [...intF(1, 31), ...lenF(2, [...lenF(1, typeUrl), ...lenF(2, p)])];
  const now = Date.now();
  const raw = [...lenF(1, Array.from(hex.decode(refBlock))), ...lenF(4, Array.from(hex.decode(refHash))), ...intF(8, now + 60_000), ...lenF(11, c), ...intF(14, now), ...(feeLimit ? intF(18, feeLimit) : [])];
  return hex.encode(Uint8Array.from(raw));
}
const one = (fs, no) => fs.find((f) => f.no === no)?.value;
/** 解已签名的完整交易（broadcasthex 收到的）：{ txId, raw, sig, type, owner, contract, data, feeLimit, callValue } */
export function decodeSigned(txHex) {
  const top = fields(hex.decode(txHex));
  const raw = one(top, 1), sig = one(top, 2);
  const rf = fields(raw);
  const cf = fields(one(rf, 11));
  const type = Number(one(cf, 1));
  const any = fields(one(cf, 2));
  const p = fields(one(any, 2));
  const a = (no) => { const v = one(p, no); return v ? toBase58(v.slice(1)) : null; };
  return {
    txId: hex.encode(sha256(raw)), raw: hex.encode(raw), sig: sig ? hex.encode(sig) : '', type,
    owner: a(1), contract: type === 31 ? a(2) : null, to: type === 1 ? a(2) : null,
    data: type === 31 ? hex.encode(one(p, 4) || new Uint8Array()) : '', callValue: Number(one(p, 3) ?? 0), feeLimit: Number(one(rf, 18) ?? 0),
  };
}
/** sweep(address,bytes32[]) 的调用数据 → { token（T 开头）, salts（0x + 64 位） } */
export function decodeSweep(data) {
  if (!data.startsWith(SWEEP_SELECTOR)) return null;
  const d = data.slice(8);
  const token = T(d.slice(24, 64));
  const off = Number(BigInt('0x' + d.slice(64, 128))) * 2;
  const n = Number(BigInt('0x' + d.slice(off, off + 64)));
  const salts = [];
  for (let i = 0; i < n; i++) salts.push('0x' + d.slice(off + 64 + i * 64, off + 128 + i * 64));
  return { token, salts };
}

/**
 * 替身 TRON 全节点。state 可覆盖：head（最新区块号）、solidLag（固化落后几个块，默认 19）、
 * energyFee（sun / 能量，默认 100）、scheme + usdt（批量合约收到 sweep 时用）、
 * onchain：{ parent, factory, implementation }（只读调用 parent()/factory()/implementationAddress() 返回什么；值为 '' 表示空结果）
 */
export function fakeTronNode(state = {}) {
  const s = {
    head: 1000, solidLag: 19, energyFee: 100, blocks: new Map(), infos: new Map(), txs: new Map(),
    tokens: new Map(), accounts: new Map(), code: new Set(),
    down: false, downFor: [], httpStatus: 0, broadcasts: [], rejectBroadcast: null, failSalts: new Set(), nextReceipt: 'SUCCESS',
    scheme: null, usdt: null, onchain: null, constantError: null, estimateEnergy: null, tamperTrigger: null,
    ...state,
  };
  const calls = [];
  const blockTime = (n) => 1_700_000_000_000 + n * 3000;
  const tok = (token) => { const k = h20(token); if (!s.tokens.has(k)) s.tokens.set(k, new Map()); return s.tokens.get(k); };
  const bal = (token, who) => tok(token).get(h20(who)) || 0n;
  const setBal = (token, who, v) => tok(token).set(h20(who), v);
  const txid = () => randomBytes(32).toString('hex');
  const blockId = (n) => n.toString(16).padStart(16, '0') + randomBytes(24).toString('hex');
  const pushInfo = (num, info) => {
    if (!s.blocks.has(num)) s.blocks.set(num, []);
    s.blocks.get(num).push(info);
    s.infos.set(info.id, info);
  };

  /** 测试用：一笔 USDT（或别的 TRC-20 代币）转账，放在 block 号区块（默认 head，也就是最新块），代币余额同时增加 */
  function transfer({ token = s.usdt, to, amount, from = randomTron(), block = s.head, result = 'SUCCESS', extraLogs = [], topics }) {
    const raw = BigInt(amount);
    const info = {
      id: txid(), blockNumber: block, blockTimeStamp: blockTime(block), contract_address: '41' + h20(token),
      receipt: { result, energy_usage_total: 30_000 },
      log: result === 'SUCCESS' || extraLogs.length ? [...(result === 'SUCCESS' ? [{ address: h20(token), topics: topics || [TRANSFER_TOPIC, word(h20(from)), word(h20(to))], data: word(raw.toString(16)) }] : []), ...extraLogs] : [],
    };
    if (result !== 'SUCCESS') info.result = 'FAILED';
    pushInfo(block, info);
    if (result === 'SUCCESS' && !topics) setBal(token, to, bal(token, to) + raw);
    return { txid: info.id, block, info };
  }

  function constant(body) {
    const sel = String(body.function_selector || '');
    const contract = h20(body.contract_address);
    // 只读调用出错：constantError = 错误码（所有合约都报）；notContract = [地址…]（这些地址"不是合约"，节点报 CONTRACT_VALIDATE_ERROR）
    if (s.constantError) return { result: { result: false, code: s.constantError, message: Buffer.from(`${s.constantError}: node error`).toString('hex') } };
    if ((s.notContract || []).some((a) => h20(a) === contract)) return { result: { result: false, code: 'CONTRACT_VALIDATE_ERROR', message: Buffer.from('Contract validate error : No contract or not a valid smart contract').toString('hex') } };
    const ok = (w, energy = 500) => ({ result: { result: true }, constant_result: [w], energy_used: energy });
    if (sel === 'balanceOf(address)') return ok(word(bal(T(contract), String(body.parameter).slice(-40)).toString(16)));
    const on = s.onchain || (s.scheme ? { parent: s.scheme.parent, factory: s.scheme.factory, implementation: s.scheme.implementation } : {});
    const addrWord = (a) => (a === '' ? '' : word(h20(a)));
    if (sel === 'parent()' && s.scheme && contract === h20(s.scheme.batcher)) return ok(addrWord(on.parent));
    if (sel === 'factory()' && s.scheme && contract === h20(s.scheme.batcher)) return ok(addrWord(on.factory));
    if (sel === 'implementationAddress()' && s.scheme && contract === h20(s.scheme.factory)) return ok(addrWord(on.implementation));
    if (sel === 'sweep(address,bytes32[])') {
      const sw = decodeSweep(SWEEP_SELECTOR + String(body.parameter || ''));
      const n = sw ? sw.salts.length : 1;
      return ok('', s.estimateEnergy ?? 20_000 + n * 160_000);
    }
    return ok('');
  }

  function execSweep(d) {
    const sw = decodeSweep(d.data);
    const num = ++s.head;
    const info = { id: d.txId, blockNumber: num, blockTimeStamp: blockTime(num), receipt: { result: s.nextReceipt, energy_usage_total: 120_000 * (sw?.salts.length || 1) }, fee: 0, log: [] };
    if (s.nextReceipt !== 'SUCCESS') { info.result = 'FAILED'; info.resMessage = Buffer.from('REVERT opcode executed').toString('hex'); }
    else if (sw && s.scheme && h20(d.contract) === h20(s.scheme.batcher)) {
      for (const salt of sw.salts) {
        const fwd = forwarderOf(s.scheme, salt);
        const deployed = !s.code.has(h20(fwd));
        if (s.failSalts.has(salt)) {
          info.log.push({ address: h20(s.scheme.batcher), topics: [SWEEP_FAILED_TOPIC, word(salt), word(h20(fwd))], data: word('20') + word('0') });
          continue;
        }
        s.code.add(h20(fwd));
        const v = bal(sw.token, fwd);
        setBal(sw.token, fwd, 0n);
        setBal(sw.token, s.scheme.parent, bal(sw.token, s.scheme.parent) + v);
        info.log.push({ address: h20(s.scheme.batcher), topics: [SWEPT_TOPIC, word(salt), word(h20(fwd))], data: word(deployed ? '1' : '0') });
      }
    }
    s.txs.set(d.txId, d);
    pushInfo(num, info);
  }

  function handle(path, body) {
    switch (path) {
      case '/wallet/getnowblock': return { blockID: blockId(s.head), block_header: { raw_data: { number: s.head, timestamp: blockTime(s.head) } } };
      case '/walletsolidity/getnowblock': { const n = s.head - s.solidLag; return { blockID: blockId(n), block_header: { raw_data: { number: n, timestamp: blockTime(n) } } }; }
      case '/wallet/getblockbynum': case '/walletsolidity/getblockbynum': {
        const n = Number(body.num);
        return n > s.head ? {} : { blockID: blockId(n), block_header: { raw_data: { number: n, timestamp: blockTime(n) } } };
      }
      case '/wallet/gettransactioninfobyblocknum': case '/walletsolidity/gettransactioninfobyblocknum': {
        const n = Number(body.num);
        if (n > s.head) return [];
        return s.blocks.get(n) || [];
      }
      case '/wallet/gettransactioninfobyid': case '/walletsolidity/gettransactioninfobyid': {
        const i = s.infos.get(String(body.value));
        return i && i.blockNumber <= s.head ? i : {};
      }
      case '/wallet/gettransactionbyid': { const t = s.txs.get(String(body.value)); return t ? { txID: t.txId, raw_data_hex: t.raw } : {}; }
      case '/wallet/triggerconstantcontract': return constant(body);
      case '/wallet/estimateenergy': { const r = constant({ ...body, function_selector: body.function_selector }); return { result: { result: true }, energy_required: r.energy_used }; }
      case '/wallet/triggersmartcontract': {
        const sel = String(body.function_selector || '');
        const data = (sel === 'sweep(address,bytes32[])' ? SWEEP_SELECTOR : kHex(sel).slice(0, 8)) + String(body.parameter || '');
        const bid = blockId(s.head);
        // tamperTrigger：测试用，模拟节点（被劫持或出错）建出一笔和请求不一样的交易；返回要改的字段
        //   { owner, contract, data, feeLimit, callValue, ownerPrefix, contractPrefix（地址第一个字节，正常 0x41）, extraParam（追加到 TriggerSmartContract 里的原始字段字节）}
        const t = { owner: body.owner_address, contract: body.contract_address, data, feeLimit: Number(body.fee_limit || 0), callValue: Number(body.call_value || 0), ...(s.tamperTrigger ? s.tamperTrigger({ ...body, data }) : {}) };
        const raw = encodeTrigger({ ...t, refBlock: bid.slice(12, 16), refHash: bid.slice(16, 32) });
        const id = hex.encode(sha256(hex.decode(raw)));
        return { result: { result: true }, transaction: { txID: id, raw_data_hex: raw, raw_data: { contract: [{ type: 'TriggerSmartContract' }] }, visible: false } };
      }
      case '/wallet/broadcasthex': {
        const d = decodeSigned(String(body.transaction));
        s.broadcasts.push(d);
        if (s.rejectBroadcast) return { result: false, code: s.rejectBroadcast, message: Buffer.from('rejected by fake node').toString('hex'), txid: d.txId };
        if (signerOf(d.txId, d.sig) !== d.owner) return { result: false, code: 'SIGERROR', message: Buffer.from('bad signature').toString('hex'), txid: d.txId };
        if (d.type === 31) execSweep(d);
        return { result: true, code: 'SUCCESS', txid: d.txId };
      }
      case '/wallet/broadcasttransaction': return { result: false, code: 'OTHER_ERROR', message: 'fake: use broadcasthex' };
      case '/wallet/getaccount': {
        const a = s.accounts.get(h20(body.address));
        return a ? { address: '41' + h20(body.address), balance: a.balance ?? 0, ...(s.code.has(h20(body.address)) ? { type: 'Contract' } : {}) } : {};
      }
      case '/wallet/getcontract': return s.code.has(h20(body.value)) ? { bytecode: '6080', contract_address: '41' + h20(body.value) } : {};
      case '/wallet/getaccountresource': { const a = s.accounts.get(h20(body.address)) || {}; return { EnergyLimit: a.energyLimit ?? 0, EnergyUsed: a.energyUsed ?? 0, freeNetLimit: 600 }; }
      case '/wallet/getchainparameters': return { chainParameter: [{ key: 'getEnergyFee', value: s.energyFee }, { key: 'getTransactionFee', value: 1000 }, { key: 'getMaxFeeLimit', value: 15_000_000_000 }] };
      default: return { Error: `fake: unsupported path ${path}` };
    }
  }

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url ?? String(url));
    const path = u.pathname;
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    calls.push({ path, body, headers: init.headers || {} });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (s.down || s.downFor.includes(path)) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (s.httpStatus) return new Response(JSON.stringify({ Error: `HTTP ${s.httpStatus}` }), { status: s.httpStatus, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(handle(path, body)), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  return {
    state: s, calls, fetchImpl, base: 'http://fake-tron.test',
    transfer, bal, setBal,
    /** 出 n 个空块 */
    mine(n = 1) { s.head += n; return s.head; },
    /** 激活一个地址（转了 TRX）：balance 单位 sun */
    activate(address, balance = 1_000_000) { s.accounts.set(h20(address), { ...(s.accounts.get(h20(address)) || {}), balance }); },
    /** 把替身节点开成一个本机 HTTP 服务（给只接受节点地址、不接受 fetch 的入口用，例如 createWalletLayer）；返回 { url, close } */
    async listen() {
      const { createServer } = await import('node:http');
      const srv = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        try {
          const r = await fetchImpl(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() || undefined });
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(await r.text());
        } catch { req.socket.destroy(); }
      });
      await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
      return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }) };
    },
  };
}
