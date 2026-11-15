// 归集发起账户的手续费币（ETH / BNB / TRX）够不够：后台"系统状态"、归集页、概览待处理和 worker 的提醒邮件共用同一个判断。
//   - 按一批典型的归集（10 个地址、一半首次）估够几批；不够 LOW_GAS_BATCHES（3）批、余额为 0、或不够付待确认批次的手续费时算"偏低"（low）
//   - worker 每 10 分钟查一次（只读余额和 gas 价，不签名、不发交易）：状态变了才发邮件（正常 → 偏低 → 不够一批 → 恢复），
//     同一状态不重复发；重启不重发（状态记在 pay_meta）。恢复要够 LOW_GAS_BATCHES + 1 批，避免 gas 价来回波动时反复发信
// 发起账户的地址是公开地址（补手续费要复制它），不是密钥；这里不碰私钥。
import { getMeta, setMeta } from '../pay/core.js';

export const LOW_GAS_BATCHES = 3;
/** 恢复要够几批（比提醒线多 1 批，防止来回发） */
export const RECOVER_GAS_BATCHES = LOW_GAS_BATCHES + 1;
export const OPERATOR_GAS_CHECK_MS = 10 * 60_000;
export const NATIVE = Object.freeze({ eth: 'ETH', bsc: 'BNB', tron: 'TRX' });
const NATIVE_DECIMALS = { eth: 18, bsc: 18, tron: 6 };
const NAMES = { eth: '以太坊', bsc: 'BSC', tron: 'TRON' };

/** 原生币最小单位 → 小数字符串：ETH、BNB 18 位（wei），TRX 6 位（sun） */
export const native = (wei, chain = 'eth') => {
  if (wei === null || wei === undefined || wei === '') return null;
  const w = BigInt(wei), d = NATIVE_DECIMALS[chain] ?? 18, u = 10n ** BigInt(d);
  const int = w / u, frac = (w % u).toString().padStart(d, '0').slice(0, 6).replace(/0+$/, '');
  return `${int}${frac ? '.' + frac : ''}`;
};

/**
 * 一条链发起账户的手续费币情况。返回 { configured, enabled, address, wei, perBatch, batches_left, needWei, low, error }：
 *   wei / perBatch / needWei 是 bigint 或 null；batches_left 估不出来时为 null；节点查不到余额时 error = 'rpc'、low = false
 */
export async function operatorGasStatus({ db, layer, chain }) {
  const configured = chain === 'tron' ? Boolean(layer?.tronOperatorConfigured) : Boolean(layer?.operatorConfigured);
  const enabled = Boolean(layer?.enabledChains?.includes(chain));
  const out = { configured, enabled, address: null, wei: null, perBatch: null, batches_left: null, needWei: 0n, low: false, error: null };
  if (!enabled || !configured) return out;
  const p = layer.providers.contract;
  out.address = (chain === 'tron' ? p.tronOperator : p.operator) || null;
  try {
    const wei = await p.operatorGas(chain);
    if (wei === null || wei === undefined) return out;
    out.wei = BigInt(wei);
    const f = await p.estimateFee(chain, 'sweep', 10, { deploy: 5 }).catch(() => null);
    if (f?.native) { out.perBatch = BigInt(f.native); out.batches_left = Number(out.wei / out.perBatch); }
    const [w] = await db.query(`select coalesce(max((fee_estimate->>'native')::numeric), 0)::text need from wallet_sweep_batches where chain = $1 and status = 'awaiting_approval'`, [chain]);
    out.needWei = BigInt(String(w?.need || '0').split('.')[0] || '0');
    // 余额为 0 一定标 low（估不出手续费、节点报的 gas 价为 0 时也照样提醒；这是真问题，归集发不出去）
    out.low = out.wei === 0n || (out.batches_left !== null && out.batches_left < LOW_GAS_BATCHES) || (out.needWei > 0n && out.wei < out.needWei);
  } catch { out.wei = null; out.error = 'rpc'; out.low = false; }
  return out;
}

/** 提醒的级别：ok / low（不够 3 批）/ out（不够一批，或不够付待确认批次）；查不到时 null（不改状态） */
export function gasLevel(s, prev = 'ok') {
  if (!s.enabled || !s.configured) return 'off';
  if (s.error || s.wei === null) return null;
  const out = s.wei === 0n || (s.batches_left !== null && s.batches_left < 1) || (s.needWei > 0n && s.wei < s.needWei);
  if (out) return 'out';
  if (s.low) return 'low';
  // 已经在提醒中：要够 RECOVER_GAS_BATCHES 批才算恢复；估不出够几批时保持原状态
  if (prev === 'low' || prev === 'out') {
    if (s.batches_left === null) return prev;
    if (s.batches_left < RECOVER_GAS_BATCHES) return 'low';
  }
  return 'ok';
}

function mail(chain, level, s, adminUrl) {
  const name = NAMES[chain], sym = NATIVE[chain];
  const have = `${native(s.wei, chain)} ${sym}`;
  const per = s.perBatch ? `一批典型归集（10 个地址，一半第一次归集）约 ${native(s.perBatch, chain)} ${sym}` : '现在估不出一批的手续费（节点没给 gas 价）';
  const addr = s.address ? `\n发起账户地址（公开地址，补币时复制它）：${s.address}` : '';
  const where = adminUrl ? `\n运营后台：${adminUrl}（"归集"页有这条链的发起账户卡片和"去补手续费"）` : '';
  if (level === 'ok') {
    return [`${name} 归集发起账户的 ${sym} 已补足`,
      `${name} 归集发起账户现在有 ${have}，够约 ${s.batches_left ?? '—'} 批归集。提醒解除。${addr}`];
  }
  const left = s.batches_left === null ? '' : `，按现在的 gas 价够约 ${s.batches_left} 批`;
  const pending = s.needWei > 0n && s.wei < s.needWei ? `\n待确认的归集批次估的手续费是 ${native(s.needWei, chain)} ${sym}，比余额多，现在确认会发不出去。` : '';
  const head = level === 'out' ? `${name} 归集发起账户的 ${sym} 不够付一批归集` : `${name} 归集发起账户的 ${sym} 只够约 ${s.batches_left ?? '—'} 批归集`;
  return [head,
    `${name} 归集发起账户现在有 ${have}${left}（${per}）。${pending}\n`
    + `请往发起账户转一些 ${sym}（只用来付归集手续费；钱只会进冷钱包，充值地址里的钱不受影响）。${addr}${where}\n\n`
    + `这封是提前提醒：状态变了才发（偏低 → 不够一批 → 已补足），同一状态不会重复发；补到够约 ${RECOVER_GAS_BATCHES} 批以上会发一封"已补足"。`];
}

/**
 * worker 每轮调用：距上次检查不到 10 分钟直接返回。每条开通、配了发起账户的链查一次，状态变了才发邮件。
 * 返回 { skipped } 或 { chains: { eth: 'ok' | 'low' | 'out' | 'off' | 'unknown' } }。某条链查不到余额：不改状态、不发信
 */
export async function checkOperatorGas(db, { layer, notify, adminUrl = '', now = Date.now(), chains = ['eth', 'bsc', 'tron'], force = false } = {}) {
  if (!layer) return { skipped: 'no_wallet' };
  const last = await getMeta(db, 'operator_gas_check', null);
  if (!force && last?.at && now - Date.parse(last.at) < OPERATOR_GAS_CHECK_MS) return { skipped: 'interval' };
  await setMeta(db, 'operator_gas_check', { at: new Date(now).toISOString() });
  const out = {};
  for (const chain of chains) {
    const key = `operator_gas_${chain}`;
    const prev = (await getMeta(db, key, null))?.level || 'ok';
    const s = await operatorGasStatus({ db, layer, chain });
    const level = gasLevel(s, prev);
    if (level === null) { out[chain] = 'unknown'; continue; }
    if (level === 'off') {
      // 没开通或没配发起账户：不提醒（系统状态里有"没配置"），清掉旧状态、不发信
      if (prev !== 'ok') await db.query('delete from pay_meta where key = $1', [key]);
      out[chain] = 'off'; continue;
    }
    out[chain] = level;
    if (level === prev) continue;
    if (level === 'ok') await db.query('delete from pay_meta where key = $1', [key]);
    else await setMeta(db, key, { level, since: new Date(now).toISOString(), batches_left: s.batches_left });
    if (notify) { const [subject, text] = mail(chain, level, s, adminUrl); await notify(subject, text); }
  }
  return { chains: out };
}
