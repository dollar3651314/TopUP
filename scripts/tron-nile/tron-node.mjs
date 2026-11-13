// 连 TRON 节点（HTTP 接口）：建交易、本地签名、广播、等回执、只读调用。
// 只允许连 Nile 测试网或本机私链：先查 0 号区块，主网直接拒绝；Nile 的地址必须对上 Nile 的 0 号区块。
// 私钥只在内存里，用来签名，从不打印、不写文件、不发给节点（节点只收到签好名的交易）。
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hex } from '@scure/base';
import { encodeSigned, fields, txIdOf } from '../../server/pay/txcodec.js';
import { addr20, toBase58 } from './tron-create2.mjs';

export const MAINNET_GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc';
export const NILE_GENESIS = '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc';
const NILE_HOSTS = new Set(['nile.trongrid.io', 'api.nileex.io']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 私钥（64 位十六进制）→ { address（T 开头）, sign(txIdHex) }。私钥不出这个闭包 */
export function makeSigner(privHex) {
  const k = String(privHex || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('private key must be 64 hex characters');
  const priv = hex.decode(k.toLowerCase());
  const pub = secp256k1.getPublicKey(priv, false);
  const address = toBase58(keccak_256(pub.slice(1)).slice(-20));
  return {
    address,
    sign(txIdHex) {
      const s = secp256k1.sign(hex.decode(txIdHex), priv);
      return hex.encode(s.toCompactRawBytes()) + (s.recovery + 27).toString(16).padStart(2, '0');
    },
  };
}

export function createNode({ base, apiKey = '', timeoutMs = 15_000, retries = 3 }) {
  const url = new URL(base);
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (!isLocal && !NILE_HOSTS.has(url.hostname)) throw new Error(`node host not allowed: ${url.hostname}（只允许 Nile 测试网或本机）`);
  if (!isLocal && url.protocol !== 'https:') throw new Error('Nile node must use https');

  async function post(path, body) {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(new URL(path, base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status} ${path}`), { retry: true });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
        return await res.json();
      } catch (e) {
        last = e;
        const retry = e.retry || e.name === 'TimeoutError' || e.name === 'AbortError' || e.cause;
        if (!retry || i === retries) break;
        await sleep(1000 * 2 ** i);
      }
    }
    throw last;
  }

  /** 节点所在的链：拒绝主网；Nile 的地址必须是 Nile */
  async function checkNetwork() {
    const g = await post('/wallet/getblockbynum', { num: 0 });
    const id = g.blockID;
    if (!id) throw new Error('cannot read genesis block');
    if (id === MAINNET_GENESIS) throw new Error('this node is TRON MAINNET — refused');
    if (!isLocal && id !== NILE_GENESIS) throw new Error(`not Nile (genesis ${id})`);
    return { genesis: id, network: id === NILE_GENESIS ? 'nile' : 'local' };
  }

  /** 节点建好的交易：核对 txID = sha256(raw_data_hex)、类型、发起地址，再签名广播 */
  async function signAndSend(tx, signer, expectType) {
    if (!tx?.raw_data_hex || !tx.txID) throw new Error('node did not return a transaction: ' + JSON.stringify(tx).slice(0, 300));
    if (txIdOf(tx.raw_data_hex) !== tx.txID) throw new Error('txID does not match raw_data_hex');
    const raw = hex.decode(tx.raw_data_hex);
    const c = fields(raw).find((f) => f.no === 11);
    const cf = fields(c.value);
    const typeNo = Number(cf.find((f) => f.no === 1)?.value ?? -1);
    if (typeNo !== expectType) throw new Error(`unexpected contract type ${typeNo}, want ${expectType}`);
    const any = fields(cf.find((f) => f.no === 2).value);
    const p = fields(any.find((f) => f.no === 2).value);
    const owner = p.find((f) => f.no === 1)?.value;
    if (!owner || toBase58(owner.slice(1)) !== signer.address) throw new Error('transaction owner is not the signer');
    const r = await post('/wallet/broadcasthex', { transaction: encodeSigned(tx.raw_data_hex, signer.sign(tx.txID)) });
    if (!r.result) { const m = String(r.message || ''); throw new Error(`broadcast rejected: ${r.code || ''} ${/^[0-9a-f]+$/i.test(m) ? Buffer.from(m, 'hex').toString() : m || JSON.stringify(r)}`); }
    return tx.txID;
  }

  /** 等交易进块，返回交易信息（含能量、结果、日志） */
  async function waitInfo(txId, { timeoutMs: t = 120_000 } = {}) {
    const end = Date.now() + t;
    while (Date.now() < end) {
      const info = await post('/wallet/gettransactioninfobyid', { value: txId });
      if (info && info.id) return info;
      await sleep(3000);
    }
    throw new Error(`transaction not confirmed in time: ${txId}`);
  }

  const hexAddr = (a) => '41' + hex.encode(addr20(a));
  const word = (h) => h.padStart(64, '0');
  /** ABI 参数：address、bytes32、uint256 */
  const enc = (types, values) => types.map((t, i) => {
    if (t === 'address') return word(hex.encode(addr20(values[i])));
    if (t === 'bytes32') return word(String(values[i]).replace(/^0x/, '').toLowerCase());
    if (t === 'uint256') return word(BigInt(values[i]).toString(16));
    throw new Error(`type ${t}`);
  }).join('');

  return {
    isLocal, post, checkNetwork, waitInfo, enc,
    async account(addr) { return post('/wallet/getaccount', { address: hexAddr(addr) }); },
    async contract(addr) { return post('/wallet/getcontract', { value: hexAddr(addr) }); },
    async balance(addr) { return Number((await this.account(addr)).balance || 0); },
    async deploy(signer, { name, abi, bytecode, params = '', feeLimit }) {
      const tx = await post('/wallet/deploycontract', {
        owner_address: hexAddr(signer.address), abi: JSON.stringify(abi), bytecode, parameter: params,
        fee_limit: feeLimit, call_value: 0, consume_user_resource_percent: 100, origin_energy_limit: 10_000_000, name,
      });
      const txId = await signAndSend(tx, signer, 30);
      const info = await waitInfo(txId);
      if (info.receipt?.result !== 'SUCCESS') throw new Error(`deploy ${name} failed: ${info.receipt?.result} ${info.resMessage ? Buffer.from(info.resMessage, 'hex').toString() : ''}`);
      return { txId, address: toBase58(addr20(info.contract_address)), info };
    },
    async send(signer, contract, signature, types = [], values = [], { feeLimit, callValue = 0 } = {}) {
      const r = await post('/wallet/triggersmartcontract', {
        owner_address: hexAddr(signer.address), contract_address: hexAddr(contract), function_selector: signature,
        parameter: enc(types, values), fee_limit: feeLimit, call_value: callValue,
      });
      if (!r.result?.result) throw new Error(`trigger ${signature} rejected: ${JSON.stringify(r).slice(0, 300)}`);
      const txId = await signAndSend(r.transaction, signer, 31);
      const info = await waitInfo(txId);
      return { txId, info, ok: info.receipt?.result === 'SUCCESS' };
    },
    async call(contract, signature, types = [], values = [], from) {
      const r = await post('/wallet/triggerconstantcontract', {
        owner_address: hexAddr(from || contract), contract_address: hexAddr(contract), function_selector: signature, parameter: enc(types, values),
      });
      if (!r.result?.result || !r.constant_result) throw new Error(`call ${signature} failed: ${JSON.stringify(r).slice(0, 300)}`);
      return r.constant_result[0];
    },
    async transferTrx(signer, to, sun) {
      const tx = await post('/wallet/createtransaction', { owner_address: hexAddr(signer.address), to_address: hexAddr(to), amount: sun });
      const txId = await signAndSend(tx, signer, 1);
      const info = await waitInfo(txId);
      return { txId, info };
    },
  };
}
