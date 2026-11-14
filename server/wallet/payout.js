// 以太坊、BSC 批量打款的链上一侧（第 3 批）：按链凑批（三者取最小，读链上热钱包余额和授权额度）→ 出未签名交易原文 →
// 浏览器解码核对后用热钱包私钥签名、只把签名交回 → 服务器套签名（签名人必须是该链热钱包）、广播的就是自己存的那份原文 →
// worker 按回执整批确认；链上回滚整批回到已审核（解得出是哪一笔转不了的，那一笔挂起、不再进批）。
// 广播后迟迟不上链：只要热钱包的这个 nonce 还没被别的交易用掉，旧交易随时可能被任何人重新广播上链，所以不退回，
// 只用库里存的已签名原文重发；nonce 已被别的交易用掉、我们的交易又没有回执，才算没发出去、整批回到已审核（同一笔不会付两次）。
// 改授权额度（以太坊 USDT 非 0 改非 0 先归零再设，两笔；BSC 一笔；TRON 不用）。
// 服务器上没有热钱包私钥；交易只能调用 BatchPayout.pay（只花热钱包自己的额度），或 USDT 的 approve(BatchPayout, 数额)。
import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { PayError, audit, getMeta, setMeta } from '../pay/core.js';
import { getPayoutLimits, planPayoutBatches, effectiveBatchCap, createPayoutTxBatch, settlePayoutBatch, expirePayoutBatch, holdPayout } from '../pay/payout.js';
import { encodePayCall, encodeApproveCall, encodeUnsignedLegacyTx, decodeUnsignedLegacyTx, decodePayCall, attachSignature, checkPayoutTx, checkApproveTx, CodecError, selectorOf } from './evm-payout-codec.js';
import { toUnits, fromUnits } from './units.js';
import { fmtUsdt } from '../pay/money.js';
import { raiseAlert, clearAlert, CHAIN_NAMES } from './sweep.js';

/** 每笔交易网络费上限（gas × gasPrice，wei）：签名页面用同样的常量自己核对，服务器出的交易超了直接不出 */
export const MAX_FEE_WEI = Object.freeze({ eth: 2n * 10n ** 17n, bsc: 5n * 10n ** 16n });
/**
 * BatchPayout 的运行时代码（去掉末尾编译器元数据后）的 keccak256：solc 0.8.20、paris、优化 1000 次（contracts/foundry.toml）。
 * 去掉元数据是为了改注释不影响；合约代码一改，这里要按 forge build 的 deployedBytecode 重新算（算法见 payoutCodeHash）。
 */
export const BATCH_PAYOUT_CODE_HASH = '0x44298a4edf4971ca1dfb065391abee29659b97daf10e53727a0a3ca02ad728f8';
const STALE_MS = 30 * 60_000; // 广播后 30 分钟还没上链：查 nonce，没被用掉就重发，用掉了才算没发出去
const ALLOWANCE_TTL_MS = 30 * 60_000; // 改额度的两笔要在 30 分钟内签完，期间这条链的打款暂停
const REVERIFY_MS = 60_000; // 没核对上的链：用到时再核对，最多每分钟一次
const STUCK_ALERT_MS = 60 * 60_000; // nonce 已用掉、节点却还认得我们这笔超过 1 小时：告警一次，等管理员确认作废
const DROP_RECHECK_MS = 5 * 60_000; // nonce 用掉、我们的交易查不到：隔 5 分钟再查一轮仍是这样才退回
const MAX_REPLAN = 5; // 凑批时试算发现某一笔转不了：挂起那一笔重凑，最多几次
const TRANSFER_FAILED = selectorOf('TransferFailed(uint256)');
const ZERO_ADDRESS_ERR = selectorOf('ZeroAddress()');
const usdt = (u) => fmtUsdt(Number(u)).replace(/,/g, '');
const isZero = (a) => /^0x0{40}$/i.test(String(a || ''));
/** 节点回"已经有这笔 / nonce 已用过"：同一份原文已经在交易池里或上过链，按已广播处理（由 confirm 按 nonce 判断） */
const KNOWN_RE = /already known|already imported|known transaction|nonce too low|alreadyknown/i;

/** 合约代码去掉末尾 CBOR 元数据后的 keccak256（没有代码返回 null） */
export function payoutCodeHash(codeHex) {
  const h = String(codeHex || '').replace(/^0x/, '');
  if (!h || /^0*$/.test(h) || h.length % 2) return null;
  const b = Buffer.from(h, 'hex');
  const n = b.length >= 2 ? b.readUInt16BE(b.length - 2) : 0;
  const core = n > 0 && n + 2 < b.length ? b.subarray(0, b.length - 2 - n) : b;
  return '0x' + Buffer.from(keccak_256(core)).toString('hex');
}
/** 回滚数据 → 出错的那一笔（TransferFailed(i)）；解不出返回 null */
export function failedIndexOf(data) {
  const d = String(data || '').toLowerCase().replace(/^0x/, '');
  if (d.startsWith(TRANSFER_FAILED) && d.length >= 8 + 64) { const i = BigInt('0x' + d.slice(8, 72)); return i < 1000n ? Number(i) : null; }
  return null;
}
/** 节点明确回了错误（回滚、余额不够付网络费等），不是连不上 */
const isRevert = (e) => Boolean(e) && e.code !== 'rpc_unreachable' && e.code !== 'rpc_http';

/**
 * 启动时核对一条链的 BatchPayout（沿用 verify-onchain.js 的判定规则）：拿到了结果且不对 → mismatch（停用这条链的打款并告警）；
 * 节点连不上、报错 → unverified（这条链的打款先不开，下一轮再核对）。核对三项：热钱包是 payer、代码哈希、owner 是冷钱包 Safe（evm.<链>.parent）。
 */
export async function verifyPayoutChain(c) {
  if (c.adapter.fake) return { result: 'ok', fake: true };
  const sel = (sig) => '0x' + selectorOf(sig);
  const word = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
  // 先取代码：取不到（连不上、节点报错）才算"未核对"；取到了但不是这一版 BatchPayout（别的合约、普通地址）直接判不一致，
  // 不再去调 isPayer / owner（别的合约上调这两个会回滚，不能因此当成"未核对"）
  let code;
  try { code = await c.adapter.getCode(c.contract); } catch { return { result: 'unverified' }; }
  if (payoutCodeHash(code) !== BATCH_PAYOUT_CODE_HASH) return { result: 'mismatch', fields: ['code'] };
  let payer, owner;
  try {
    payer = await c.adapter.call({ to: c.contract, data: sel('isPayer(address)') + word(c.hot) });
    owner = await c.adapter.call({ to: c.contract, data: sel('owner()') });
  } catch { return { result: 'unverified' }; }
  const fields = [];
  if (!/^0x0{63}1$/i.test(String(payer || ''))) fields.push('isPayer');
  const o = /^0x[0-9a-fA-F]{64}$/.test(String(owner || '')) ? '0x' + owner.slice(-40).toLowerCase() : null;
  if (!o || !c.safe || o !== String(c.safe).toLowerCase()) fields.push('owner');
  return fields.length ? { result: 'mismatch', fields } : { result: 'ok' };
}

/**
 * chains.<eth|bsc> = { adapter, chainId?, token, contract（BatchPayout）, hot（热钱包）, decimals, safe?（冷钱包 Safe） }。
 * verifyContracts：true 时打款前要先核对过链上合约（verify()），没核对上的链不出交易（生产、测试环境由 deps.js 打开）。
 */
export function createPayoutService({ db, chains = {}, verifyCode, now = () => Date.now(), notify = null, verifyContracts = false }) {
  const onchain = {}; // 链 → { result, fields?, at }
  const cfgOf = (chain) => {
    const c = chains[chain];
    if (!c) throw new PayError(chain === 'tron' ? 'not_applicable' : 'chain_not_enabled', 409, 'chain');
    return c;
  };
  /**
   * 还没核对上（启动时节点连不上）的链：用到时再核对一次，同一条链最多每分钟一次。
   * web 进程没有 worker 的定时任务，靠这里自己恢复；worker 每轮也会核对（deps.js）
   */
  const lastTry = {};
  async function ensureVerified(chain) {
    if (!verifyContracts) return;
    const r = onchain[chain]?.result;
    if (r === 'ok' || r === 'mismatch' || (lastTry[chain] && now() - lastTry[chain] < REVERIFY_MS)) return;
    await verify({ timeoutMs: 5000, only: chain }).catch(() => {});
  }
  const readyOf = async (chain) => {
    const c = cfgOf(chain);
    await ensureVerified(chain);
    if (verifyContracts && onchain[chain]?.result !== 'ok') throw new PayError(onchain[chain]?.result === 'mismatch' ? 'payout_contract_mismatch' : 'payout_contract_unverified', 409, 'chain');
    return c;
  };
  const ids = {};
  const chainIdOf = async (chain) => { const c = cfgOf(chain); if (c.chainId) return BigInt(c.chainId); ids[chain] ??= await c.adapter.chainId(); return ids[chain]; };
  const decode = (fn) => { try { return fn(); } catch (e) { if (e instanceof CodecError) throw new PayError(e.code, 422); throw e; } };
  const allowanceKey = (chain) => `payout_allowance_${chain}`;
  async function allowanceBusy(chain) {
    const p = await getMeta(db, allowanceKey(chain));
    return Boolean(p && p.steps?.some((s) => !s.done) && now() - Date.parse(p.at) < ALLOWANCE_TTL_MS);
  }
  /** 广播：null 成功；'known' 节点已经有这笔（按已广播处理）；'unreachable' 连不上（不算失败，按交易号查）；其他字符串是节点明确拒绝的原因 */
  async function broadcast(c, raw) {
    try { await c.adapter.sendRaw(raw); return null; }
    catch (e) {
      if (e?.code === 'rpc_unreachable' || e?.code === 'rpc_http') return 'unreachable';
      if (KNOWN_RE.test(String(e?.message || ''))) return 'known';
      return e?.message || 'rejected';
    }
  }

  /** 核对每条链的 BatchPayout；不一致的停用这条链的打款并告警，一致了清掉告警 */
  async function verify({ timeoutMs = 8000, only = null } = {}) {
    await Promise.all(Object.keys(chains).filter((ch) => !only || ch === only).map(async (chain) => {
      if (onchain[chain]?.result === 'mismatch') return; // 停用到修好配置、重启为止
      lastTry[chain] = now();
      let timer;
      const r = await Promise.race([verifyPayoutChain(chains[chain]), new Promise((ok) => { timer = setTimeout(() => ok({ result: 'unverified' }), timeoutMs); })]).finally(() => clearTimeout(timer));
      onchain[chain] = { ...r, at: new Date(now()).toISOString() };
      const name = CHAIN_NAMES[chain] || chain;
      if (r.result === 'mismatch') await raiseAlert(db, `payout_onchain_${chain}`, notify, `${name} 批量打款合约核对不一致，已停用这条链的打款`,
        `${name} 的 BatchPayout（config/wallets.json 的 evm.${chain}.payout）核对不一致：${r.fields.join('、')}（code = 合约代码不是这一版 BatchPayout；isPayer = 热钱包不是登记的付款人；owner = 合约所有者不是冷钱包 Safe）。这条链的打款已停用（不凑批、不签名），收款和归集不受影响。请核对合约和配置后重启服务。`).catch(() => {});
      else if (r.result === 'ok') await clearAlert(db, `payout_onchain_${chain}`, notify, `${name} 批量打款合约核对一致`, `${name} 的 BatchPayout 核对一致，这条链的打款已开通。`).catch(() => {});
    }));
    return onchain;
  }

  /** 热钱包 USDT 余额（0.000001 单位）：运营概览算平台资产用 */
  async function hotBalance(chain) { const c = cfgOf(chain); return Number(toUnits(await c.adapter.tokenBalanceRaw(c.hot, c.token), c.decimals)); }

  /** 在途：已交签名、还没出结果的批次合计（0.000001 单位）。链上余额和额度还没扣它们，凑新批时要先扣掉 */
  async function inflightOf(chain) {
    const [r] = await db.query(`select coalesce(sum(total), 0)::bigint v from payout_tx_batches where chain = $1 and status = 'broadcast'`, [chain]);
    return BigInt(r.v);
  }
  /** 热钱包余额、授权额度（链上读，0.000001 单位）够不够付这么多：用来区分"收款地址转不了"和"钱或额度不够" */
  async function fundsCover(c, units) {
    const [hotRaw, alRaw] = await Promise.all([c.adapter.tokenBalanceRaw(c.hot, c.token), c.adapter.allowanceRaw(c.hot, c.contract, c.token)]);
    const need = BigInt(units);
    return toUnits(hotRaw, c.decimals) >= need && toUnits(alRaw, c.decimals) >= need;
  }

  /** hot_balance、allowance 是扣掉在途批次之后还能用的（链上的原数是 hot_onchain、allowance_onchain） */
  async function status(chain) {
    const c = cfgOf(chain);
    await ensureVerified(chain);
    const [hotRaw, alRaw] = await Promise.all([c.adapter.tokenBalanceRaw(c.hot, c.token), c.adapter.allowanceRaw(c.hot, c.contract, c.token)]);
    const inflight = await inflightOf(chain);
    const hot0 = toUnits(hotRaw, c.decimals), al0 = toUnits(alRaw, c.decimals);
    const free = (v) => (v > inflight ? v - inflight : 0n);
    const hot = free(hot0), allowance = free(al0);
    const limits = await getPayoutLimits(db);
    const { cap, by } = effectiveBatchCap({ perBatch: limits.perBatch, hotBalance: hot, allowance });
    return { chain, hot: c.hot, contract: c.contract, hot_balance: Number(hot), allowance: Number(allowance), hot_onchain: Number(hot0), allowance_onchain: Number(al0), inflight: Number(inflight), cap: Number(cap), by, limits, hot_low: Number(hot0) < limits.hotLow, allowance_busy: await allowanceBusy(chain), onchain: verifyContracts ? onchain[chain]?.result || 'unverified' : 'ok' };
  }

  /**
   * 这条链所有已审核、不在批次里、没挂起的单 → 凑批出交易（每批一笔 pay）；之前没签名的批次先作废（单回到已审核）。
   * 每批先试算（eth_estimateGas）：会回滚的不出交易——解得出是哪一笔（TransferFailed(i)）就挂起那一笔重凑，解不出整次拒绝（不回落默认网络费）。
   */
  async function plan(chain, { actor = 'admin' } = {}) {
    const c = await readyOf(chain);
    if (await allowanceBusy(chain)) throw new PayError('allowance_in_progress', 409);
    for (const b of await db.query(`select id from payout_tx_batches where chain = $1 and status = 'planned'`, [chain])) await expirePayoutBatch(db, b.id);
    const chainId = await chainIdOf(chain);
    const heldNow = [];
    for (let attempt = 0; attempt < MAX_REPLAN; attempt++) {
      const rows = await db.query(`select id, amount, to_address from withdrawals where chain = $1 and status = 'approved' and batch_id is null and hold_reason is null order by approved_at, created_at, coalesce(batch_line, 0), id`, [chain]);
      // 收款地址是 0（老数据，提交时已经拒收）：BatchPayout 会整批回滚，直接挂起
      const zero = rows.filter((r) => isZero(r.to_address));
      for (const r of zero) { await holdPayout(db, r.id, 'zero_address', actor); heldNow.push({ id: r.id, reason: 'zero_address' }); }
      const st = await status(chain);
      const p = planPayoutBatches(rows.filter((r) => !isZero(r.to_address)).map((r) => ({ id: r.id, amount: Number(r.amount), to: r.to_address })), { chain, perBatch: st.limits.perBatch, hotBalance: st.hot_balance, allowance: st.allowance, perItem: st.limits.perItem });
      const prepared = [];
      let bad = null;
      if (p.batches.length) {
        const gasPrice = await c.adapter.gasPrice();
        for (const b of p.batches) {
          const batchId = '0x' + randomBytes(32).toString('hex');
          const items = b.items.map((i) => ({ to: i.to, amount: fromUnits(i.amount, c.decimals) }));
          const data = encodePayCall(c.token, batchId, items);
          let gas;
          try { gas = (await c.adapter.estimateGas({ from: c.hot, to: c.contract, data })) * 12n / 10n; }
          catch (e) {
            const i = failedIndexOf(e?.data);
            // TransferFailed(i) 也可能是热钱包余额或额度不够（代币在第 i 笔时扣不动）：先确认钱和额度够付这一批，才算第 i 个收款地址转不了
            if (i !== null && b.items[i]) {
              if (!(await fundsCover(c, b.total))) throw new PayError('funds_short', 409);
              bad = b.items[i].id; break;
            }
            if (isRevert(e)) throw new PayError('estimate_reverted', 409);
            throw new PayError('rpc_unreachable', 503);
          }
          if (gas * gasPrice > MAX_FEE_WEI[chain]) throw new PayError('fee_too_high', 409);
          prepared.push({ b, batchId, items, data, gas, gasPrice });
        }
      }
      if (bad) { await holdPayout(db, bad, 'transfer_failed', actor); heldNow.push({ id: bad, reason: 'transfer_failed' }); continue; }
      const out = [];
      if (prepared.length) {
        let nonce = await c.adapter.nonce(c.hot);
        for (const x of prepared) {
          const rawHex = encodeUnsignedLegacyTx({ nonce, gasPrice: x.gasPrice, gas: x.gas, to: c.contract, value: 0, data: x.data, chainId });
          const expect = { chainId: String(chainId), contract: c.contract, token: c.token, batchId: x.batchId, items: x.items.map((i) => ({ to: i.to, amount: String(i.amount) })), maxFeeWei: String(MAX_FEE_WEI[chain]) };
          decode(() => checkPayoutTx(rawHex, expect)); // 出给页面之前自己先核对一遍
          const id = await createPayoutTxBatch(db, { chain, ids: x.b.items.map((i) => i.id), actor, total: Number(x.b.total), extra: { batchHex: x.batchId, rawHex, expect, nonce: String(nonce) } });
          out.push({ id, chain, rawHex, expect, total: Number(x.b.total), nonce: String(nonce), fee_wei: String(x.gas * x.gasPrice), items: x.b.items.map((i) => ({ id: i.id, to: i.to, amount: i.amount })) });
          nonce += 1n;
        }
        await audit(db, actor, 'payout.plan', chain, { batches: out.map((x) => x.id), held: p.held.length + heldNow.length });
      }
      return { chain, cap: Number(p.cap), by: p.by, batches: out, held: [...heldNow, ...p.held] };
    }
    throw new PayError('too_many_bad_items', 409);
  }

  /** 还没签名的批次（页面关了）：给页面"继续签名"用的原文和期望值；金额按 0.000001 单位 */
  async function resume(id) {
    const [b] = await db.query('select * from payout_tx_batches where id = $1', [String(id || '')]);
    if (!b) throw new PayError('not_found', 404);
    if (b.status !== 'planned' || !b.raw_hex || b.chain === 'tron') throw new PayError('invalid_state', 409);
    const c = cfgOf(b.chain);
    const rows = await db.query('select id, to_address, amount from withdrawals where id = any($1::text[])', [b.item_ids]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const tx = decodeUnsignedLegacyTx(b.raw_hex);
    const call = decodePayCall(tx.data);
    // 期望值按审核通过的单重新算（不用存的），和原文对不上就不给继续签，让运营作废重凑
    const expect = { chainId: String(tx.chainId), contract: c.contract, token: c.token, batchId: call.batchId, items: b.item_ids.map((x) => ({ to: byId[x]?.to_address, amount: String(fromUnits(Number(byId[x]?.amount || 0), c.decimals)) })), maxFeeWei: String(MAX_FEE_WEI[b.chain]) };
    decode(() => checkPayoutTx(b.raw_hex, expect));
    return { chain: b.chain, batches: [{ id: b.id, chain: b.chain, rawHex: b.raw_hex, expect, total: Number(b.total), nonce: String(tx.nonce), fee_wei: String(tx.gas * tx.gasPrice), items: b.item_ids.map((x) => ({ id: x, to: byId[x].to_address, amount: Number(byId[x].amount) })) }], held: [] };
  }

  /** 收签名：签名人必须是这条链的热钱包；广播服务器自己存的原文 + 签名 */
  async function submit(id, { sigHex, actor = 'admin' }) {
    const [b] = await db.query('select * from payout_tx_batches where id = $1', [String(id || '')]);
    if (!b) throw new PayError('not_found', 404);
    if (b.status !== 'planned' || !b.raw_hex) throw new PayError('invalid_state', 409);
    const c = await readyOf(b.chain);
    const signed = decode(() => attachSignature(b.raw_hex, String(sigHex || '')));
    if (signed.from.toLowerCase() !== c.hot.toLowerCase()) throw new PayError('wrong_signer', 422, 'signature');
    const nonce = String(decodeUnsignedLegacyTx(b.raw_hex).nonce);
    // 先占住这一批（同一批不能交两次；作废了的不再广播），同时存下已签名原文，迟迟不上链时用它重发
    const [claimed] = await db.query(`update payout_tx_batches set status = 'broadcast', tx_hash = $2, signed_raw = $3, nonce = $4, updated_at = now() where id = $1 and status = 'planned' returning id`, [b.id, signed.hash, signed.raw, nonce]);
    if (!claimed) throw new PayError('invalid_state', 409);
    await db.query(`update withdrawals set status = 'broadcast', txid = $2, updated_at = now() where batch_id = $1 and status = 'signing'`, [b.id, signed.hash]);
    await audit(db, actor, 'payout.signed', b.id, { chain: b.chain, tx_hash: signed.hash, count: b.item_ids.length });
    const err = await broadcast(c, signed.raw);
    if (err && err !== 'unreachable' && err !== 'known') {
      // 节点明确拒收：这份原文只交给过这个节点，没进交易池，nonce 也没用掉；重凑的批次用同一个 nonce，两笔最多上链一笔
      await settlePayoutBatch(db, b.id, { success: false, error: String(err).slice(0, 300) });
      if (notify) await notify(`打款没发出去：${b.id}`, `节点拒绝了这笔打款交易（${String(err).slice(0, 200)}），这一批 ${b.item_ids.length} 笔已回到"已审核"，钱没动，可以重新凑批签名。`);
      throw new PayError('broadcast_rejected', 409);
    }
    return { id: b.id, tx_hash: signed.hash, status: 'broadcast', unreachable: err === 'unreachable' };
  }

  /** 链上回滚：试算一次，解得出是哪一笔转不了（TransferFailed(i)）就把那一笔挂起，不再进批 */
  async function holdFailed(c, b) {
    try {
      const tx = decodeUnsignedLegacyTx(b.raw_hex);
      await c.adapter.call({ from: c.hot, to: tx.to, data: tx.data });
      return null;
    } catch (e) {
      const i = failedIndexOf(e?.data);
      const wid = i !== null ? b.item_ids[i] : null;
      if (!wid) return null;
      // 钱或额度不够也会回滚在第 i 笔：确认现在够付这一批和别的在途批次，才怪到收款地址上
      // 在途合计里已经含这一批
      try { if (!(await fundsCover(c, await inflightOf(b.chain)))) return null; } catch { return null; }
      await holdPayout(db, wid, 'transfer_failed', 'system').catch(() => {});
      return wid;
    }
  }

  /**
   * 判断一个已广播批次的 nonce 情况（先查 nonce，再查交易；两次都是单个批量请求，带回答它的后端的最新区块号）：
   * not_used：这个 nonce 还没被用掉；ours_known：用掉了、节点还认得我们这笔（有交易或回执）；
   * gone：用掉了、我们这笔查不到；lagging：查交易的后端比查 nonce 的旧，这次的"查不到"不算数
   */
  async function probe(c, b) {
    const nonce = BigInt(b.nonce ?? decodeUnsignedLegacyTx(b.raw_hex).nonce);
    const ns = await c.adapter.nonceSnapshot(c.hot);
    if (ns.nonce <= nonce) return { state: 'not_used' };
    const lk = await c.adapter.txLookup(b.tx_hash);
    if (lk.receipt || lk.tx) return { state: 'ours_known', receipt: lk.receipt, tx: lk.tx };
    if (lk.head < ns.head) return { state: 'lagging' };
    return { state: 'gone' };
  }

  /**
   * 管理员"确认作废"（动态码，审计 payout.void_confirmed）：只在热钱包这个 nonce 已被用掉、我们这笔没有回执时允许，整批回到已审核。
   * 用在"nonce 已用掉、节点却还认得这笔"一直没结论的批次（例如某个节点的交易池里还挂着旧交易）
   */
  async function voidConfirmed(id, { code, actor = 'admin' } = {}) {
    if (!verifyCode || !(await verifyCode(String(code || '')))) throw new PayError('bad_code', 400);
    const [b] = await db.query('select * from payout_tx_batches where id = $1', [String(id || '')]);
    if (!b) throw new PayError('not_found', 404);
    if (b.status !== 'broadcast' || b.chain === 'tron' || !chains[b.chain]) throw new PayError('invalid_state', 409);
    const c = chains[b.chain];
    let pr;
    try { pr = await probe(c, b); } catch { throw new PayError('rpc_unreachable', 503); }
    if (pr.state === 'not_used') throw new PayError('nonce_not_used', 409);
    if (pr.state === 'lagging') throw new PayError('node_lagging', 409);
    if (pr.receipt) throw new PayError('tx_on_chain', 409);
    await settlePayoutBatch(db, b.id, { success: false, error: 'void_confirmed' });
    await audit(db, actor, 'payout.void_confirmed', b.id, { chain: b.chain, tx_hash: b.tx_hash, nonce: String(b.nonce ?? ''), count: b.item_ids.length });
    return { ok: true, id: b.id, count: b.item_ids.length };
  }

  /**
   * worker 每轮：已广播的批次按回执处理。确认 → 整批完成；回滚 → 整批回到已审核（转不了的那一笔挂起）。
   * 30 分钟还没上链：热钱包已确认的 nonce 还没超过这笔的 nonce → 用存的已签名原文重发、继续等（不退回）；
   * nonce 已被别的交易用掉、我们这笔的回执和交易都查不到 → 先记下时间，隔 DROP_RECHECK_MS 再查一轮仍是这样，才整批回到已审核。
   */
  async function confirm() {
    const rows = await db.query(`select * from payout_tx_batches where status = 'broadcast' and chain = any($1::text[]) order by created_at limit 50`, [Object.keys(chains)]);
    const out = { confirmed: 0, failed: 0, pending: 0, rebroadcast: 0 };
    for (const b of rows) {
      const c = chains[b.chain];
      const s = await c.adapter.txStatus(b.tx_hash);
      if (s === 'confirmed') { await settlePayoutBatch(db, b.id, { success: true, txid: b.tx_hash }); out.confirmed++; continue; }
      if (s === 'failed') {
        const held = await holdFailed(c, b);
        await settlePayoutBatch(db, b.id, { success: false, error: 'reverted' });
        out.failed++;
        if (notify) await notify(`打款整批回滚：${b.id}`, `${b.chain.toUpperCase()} 打款交易 ${b.tx_hash} 在链上失败（整笔回滚），这一批 ${b.item_ids.length} 笔都回到了"已审核"，商户余额没动。${held ? `其中 ${held} 的收款地址转不了，已挂起、不再进批（在"打款审核"里驳回它，冻结的金额退回商户）。` : ''}请到运营后台"打款审核"重新凑批签名。`);
        continue;
      }
      if (s !== 'pending' || now() - new Date(b.updated_at).getTime() <= STALE_MS) { out.pending++; continue; }
      const nonce = BigInt(b.nonce ?? decodeUnsignedLegacyTx(b.raw_hex).nonce);
      let pr;
      try { pr = await probe(c, b); } catch { out.pending++; continue; }
      if (pr.state === 'lagging') { out.pending++; continue; } // 查交易的后端比查 nonce 的旧：这一轮不算数
      if (pr.state === 'ours_known') {
        // nonce 已被用掉，但节点还认得我们这笔（有交易、没回执）：通常是确认数还不够；超过 1 小时还这样就告警一次（每批一次），由管理员核对后"确认作废"
        const since = b.stuck_since ? new Date(b.stuck_since).getTime() : now();
        if (!b.stuck_since || b.drop_suspect_at) await db.query(`update payout_tx_batches set stuck_since = coalesce(stuck_since, $2), drop_suspect_at = null where id = $1`, [b.id, new Date(since)]);
        if (!pr.receipt && !b.stuck_alerted && now() - since > STUCK_ALERT_MS) {
          await db.query(`update payout_tx_batches set stuck_alerted = true where id = $1`, [b.id]);
          if (notify) await notify(`打款一直没有结果：${b.id}`, `${b.chain.toUpperCase()} 打款交易 ${b.tx_hash}：热钱包的这个 nonce（${nonce}）已经被用掉超过 1 小时，但节点还认得这笔交易、没有回执，系统没法自己判断。这一批 ${b.item_ids.length} 笔的冻结金额还没退回。请在区块浏览器上核对：如果这个 nonce 上链的是别的交易（例如作废交易），到运营后台"打款审核"的签名批次里点"确认作废"，这一批回到"已审核"；如果上链的就是这笔，等确认即可。`);
        }
        out.pending++; continue;
      }
      if (pr.state === 'gone') {
        // nonce 已被用掉、我们这笔查不到（查交易的后端不比查 nonce 的旧）：先只记下时间，隔 DROP_RECHECK_MS 再查一轮仍是这样才退回
        if (!b.drop_suspect_at) { await db.query(`update payout_tx_batches set drop_suspect_at = $2 where id = $1 and status = 'broadcast'`, [b.id, new Date(now())]); out.pending++; continue; }
        if (now() - new Date(b.drop_suspect_at).getTime() < DROP_RECHECK_MS) { out.pending++; continue; }
        await settlePayoutBatch(db, b.id, { success: false, error: 'dropped' });
        out.failed++;
        if (notify) await notify(`打款没上链：${b.id}`, `${b.chain.toUpperCase()} 打款交易 ${b.tx_hash} 没上链，热钱包的这个 nonce（${nonce}）已经被别的交易用掉（隔了 ${Math.round(DROP_RECHECK_MS / 60_000)} 分钟查了两次），这笔不会再上链。这一批 ${b.item_ids.length} 笔已回到"已审核"，商户余额没动，可以重新凑批签名。`);
        continue;
      }
      if (b.drop_suspect_at) await db.query(`update payout_tx_batches set drop_suspect_at = null where id = $1`, [b.id]);
      if (b.rebroadcast_at && now() - new Date(b.rebroadcast_at).getTime() <= STALE_MS) { out.pending++; continue; }
      // nonce 还没被用掉：旧交易随时可能被人重新广播上链，不能退回；用存的已签名原文重发，继续等
      const first = !b.rebroadcast_at;
      const err = b.signed_raw ? await broadcast(c, b.signed_raw) : 'no_signed_raw';
      await db.query(`update payout_tx_batches set rebroadcast_at = $2, error = $3 where id = $1 and status = 'broadcast'`, [b.id, new Date(now()), err && err !== 'known' ? String(err).slice(0, 300) : null]);
      out.pending++; out.rebroadcast++;
      if (first && notify) await notify(`打款 30 分钟还没上链：${b.id}`, `${b.chain.toUpperCase()} 打款交易 ${b.tx_hash}（热钱包 nonce ${nonce}）广播 30 分钟后还没上链。为了不付两次，这一批 ${b.item_ids.length} 笔不会退回"已审核"，${b.signed_raw ? '系统已用原来签好的交易重发，之后每 30 分钟重发一次' : `这笔是升级前签的，服务器没存签好的原文，没法重发`}。通常是网络费出低了：等网络费回落就会上链。要尽快了结，请用热钱包签一笔同一个 nonce（${nonce}）、网络费更高的交易（例如转 0 给自己）把它作废，作废那笔上链后这一批会自动回到"已审核"。`);
    }
    return out;
  }

  /** 改授权额度：原因 + 动态码，审计；新额度不超过热钱包上限；以太坊当前不是 0 时先 approve(0) 再 approve(新值) 两笔 */
  async function allowancePlan(chain, { amount, reason, code, actor = 'admin' }) {
    const c = await readyOf(chain);
    if (!String(reason || '').trim()) throw new PayError('reason_required', 422, 'reason');
    if (!verifyCode || !(await verifyCode(String(code || '')))) throw new PayError('bad_code', 400);
    const units = typeof amount === 'number' ? amount : /^\d{1,16}$/.test(String(amount)) ? Number(amount) : NaN;
    if (!Number.isSafeInteger(units) || units < 0) throw new PayError('invalid_param', 422, 'amount');
    if (units > (await getPayoutLimits(db)).hotMax) throw new PayError('exceeds_hot_max', 422, 'amount');
    const target = fromUnits(units, c.decimals);
    const current = await c.adapter.allowanceRaw(c.hot, c.contract, c.token);
    const values = chain === 'eth' && current !== 0n && target !== 0n ? [0n, target] : [target];
    const chainId = await chainIdOf(chain);
    let nonce = await c.adapter.nonce(c.hot);
    const gasPrice = await c.adapter.gasPrice();
    const steps = [];
    for (const v of values) {
      const data = encodeApproveCall(c.contract, v);
      let gas;
      // 以太坊先归零再设：第 2 笔试算时额度还没归零，USDT 会回滚，只有这种情况按固定值出（页面照样核对网络费上限）
      try { gas = (await c.adapter.estimateGas({ from: c.hot, to: c.token, data })) * 12n / 10n; }
      catch (e) { if (steps.length && isRevert(e)) gas = 80_000n; else throw new PayError(isRevert(e) ? 'estimate_reverted' : 'rpc_unreachable', isRevert(e) ? 409 : 503); }
      const rawHex = encodeUnsignedLegacyTx({ nonce, gasPrice, gas, to: c.token, value: 0, data, chainId });
      const expect = { chainId: String(chainId), token: c.token, spender: c.contract, amount: String(v), maxFeeWei: String(MAX_FEE_WEI[chain]) };
      decode(() => checkApproveTx(rawHex, expect));
      steps.push({ rawHex, expect, amount: Number(toUnits(v, c.decimals)) });
      nonce += 1n;
    }
    const why = String(reason).trim().slice(0, 500);
    await setMeta(db, allowanceKey(chain), { at: new Date(now()).toISOString(), actor, reason: why, steps: steps.map((s) => ({ rawHex: s.rawHex, done: false })) });
    await audit(db, actor, 'payout.allowance', chain, { chain, reason: why, before: usdt(toUnits(current, c.decimals)), after: usdt(units), steps: steps.length });
    return { chain, current: Number(toUnits(current, c.decimals)), target: units, steps };
  }
  /** 改额度的一笔签名：rawHex 必须是 allowancePlan 刚给出的、按顺序的下一笔；签名人必须是热钱包。节点连不上不算完成（同一笔可以重签再交） */
  async function allowanceSubmit(chain, { rawHex, sigHex, actor = 'admin' }) {
    const c = await readyOf(chain);
    const p = await getMeta(db, allowanceKey(chain));
    const next = p?.steps?.find((s) => !s.done);
    if (!next || next.rawHex !== rawHex || now() - Date.parse(p.at) > ALLOWANCE_TTL_MS) throw new PayError('invalid_state', 409);
    const signed = decode(() => attachSignature(next.rawHex, String(sigHex || '')));
    if (signed.from.toLowerCase() !== c.hot.toLowerCase()) throw new PayError('wrong_signer', 422, 'signature');
    const err = await broadcast(c, signed.raw);
    if (err === 'unreachable') throw new PayError('broadcast_unreachable', 503);
    if (err && err !== 'known') throw new PayError('broadcast_rejected', 409);
    next.done = true; next.tx_hash = signed.hash;
    await setMeta(db, allowanceKey(chain), p);
    await audit(db, actor, 'payout.allowance_signed', chain, { tx_hash: signed.hash, left: p.steps.filter((s) => !s.done).length });
    return { tx_hash: signed.hash, left: p.steps.filter((s) => !s.done).length };
  }

  return { chains: Object.keys(chains), onchain, verify, hotBalance, status, plan, resume, submit, confirm, voidConfirmed, allowancePlan, allowanceSubmit, config: (chain) => cfgOf(chain) };
}
