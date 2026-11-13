// TRON 归集的能量（Q9 A：先租 TronSave，租不到烧 TRX）。
//   - 租能量平台：TronSave（REST API v2，API Key 方式，从平台的预存余额里扣钱，不用逐单签名）。
//     接口按官方文档（docs.tronsave.io，2026-11-13 核对）：
//       POST /v2/buy-resource（请求头 apikey；resourceType、unitPrice、resourceAmount、receiver、durationSec、options）→ data.orderId
//       GET  /v2/order/:id → data.fulfilledPercent（0～100）、remainAmount
//       GET  /v2/user-info → data.balance（预存余额，单位 sun）
//     正式环境 https://api.tronsave.io，Nile 测试网 https://api-dev.tronsave.io。没有真的调用过（没有账号），Nile 联调时实测。
//   - 一批只给发起账户租一次；租不到（平台出错、超时、余额不够、没成交）由调用方回退烧 TRX（providers/contract.js）
//   - 预存余额上限：K5（API Key）泄露时的最大损失 = 平台预存余额，建议 ≤ 1,000 TRX；超过就告警（故障一次、恢复一次），查不到不告警
import { raiseAlert, clearAlert } from './sweep.js';

export const RENTAL_PREPAID_MAX_TRX = 1000;
const SUN = 1_000_000n;
export const TRONSAVE_BASE = Object.freeze({ mainnet: 'https://api.tronsave.io', nile: 'https://api-dev.tronsave.io' });
/** 租多久（秒）：一批归集几分钟内发完，租 1 小时（平台默认 3 天，按时长计价） */
export const RENT_DURATION_SEC = 3600;
/**
 * 单价上限（sun / 能量，TRONSAVE_MAX_PRICE_SUN）默认 90：主网烧 TRX 的单价是链参数 getEnergyFee（2026-11 为 100 sun，推断，上线前核对），
 * 租比烧便宜才值得租；高于 90 平台不会成交，就回退烧 TRX
 */
export const RENT_MAX_PRICE_SUN = 90;
/**
 * 单次最多租多少能量（TRON_RENT_MAX_ENERGY）默认 6,500,000：按后端的预估，一批 20 个地址全部首次部署约 627 万能量（含 20% 余量），
 * 正常的一批都能租；超过说明预估异常，不租、改烧 TRX 并告警。按单价上限 90 sun 算，一单最多约 585 TRX（预存余额上限 1,000 TRX 以内）
 */
export const RENT_MAX_ENERGY = 6_500_000;

const errOf = (code, message = code) => Object.assign(new Error(message), { code });

/**
 * TronSave 客户端：rent({ receiver, energy }) → { orderId }（等到成交才返回，等不到抛出）；balance() → 预存余额（sun，bigint）。
 * 每个请求有超时；下单不自动重试（避免重复下单）；出错抛出带 code 的错误（平台的错误文字，例如 INTERNAL_BALANCE_ACCOUNT_TOO_LOW）。
 */
export function createTronSaveRenter({ apiKey, network = 'mainnet', base, maxPriceSun = RENT_MAX_PRICE_SUN, fetchImpl = fetch, timeoutMs = 10_000, fillWaitMs = 30_000, pollMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!apiKey) throw new Error('tronsave: api key missing');
  const root = (base || TRONSAVE_BASE[network] || TRONSAVE_BASE.mainnet).replace(/\/+$/, '');
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(root + path, { method, headers: { apikey: apiKey, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw errOf(e?.name === 'TimeoutError' ? 'timeout' : 'tronsave_unavailable', `tronsave: ${e?.name === 'TimeoutError' ? 'timeout' : 'unreachable'}`);
    }
    let j = null;
    try { j = await res.json(); } catch { /* 下面按 HTTP 状态处理 */ }
    if (res.status === 429) throw errOf('rate_limited', 'tronsave: rate limited');
    if (!res.ok || !j || j.error) {
      const m = String(j?.message || `HTTP ${res.status}`).replace(/[^\w .:-]/g, '').slice(0, 80);
      throw errOf(res.status >= 500 ? 'tronsave_unavailable' : m || 'tronsave_error', `tronsave: ${m}`);
    }
    return j.data;
  }
  return {
    id: 'tronsave',
    async rent({ receiver, energy }) {
      const d = await call('POST', '/v2/buy-resource', {
        // 单价写成数值上限（sun / 能量），不用 FAST / MEDIUM 这类随行情变的档位
        resourceType: 'ENERGY', unitPrice: Number(maxPriceSun), resourceAmount: Number(energy), receiver, durationSec: RENT_DURATION_SEC,
        // 只在能立刻全部成交时下单；同样参数还有没成交的单时不再下
        options: { allowPartialFill: false, onlyCreateWhenFulfilled: true, preventDuplicateIncompleteOrders: true },
      });
      const orderId = d?.orderId;
      if (!orderId) throw errOf('tronsave_error', 'tronsave: no orderId');
      // 等平台把能量代理到发起账户（成交 100%）；等不到就当租不到（这一单可能稍后成交，钱照扣，记日志）
      const end = Date.now() + fillWaitMs;
      for (;;) {
        const o = await call('GET', `/v2/order/${encodeURIComponent(orderId)}`).catch(() => null);
        if (o && Number(o.fulfilledPercent) >= 100) return { orderId };
        // 带出订单号：这一单之后仍可能成交、照样扣预存余额，要能对账
        if (Date.now() >= end) throw Object.assign(errOf('not_filled', `tronsave: order ${orderId} not filled in time`), { orderId: String(orderId) });
        await sleep(pollMs);
      }
    },
    async balance() {
      const d = await call('GET', '/v2/user-info');
      if (!/^\d+$/.test(String(d?.balance ?? ''))) throw errOf('tronsave_error', 'tronsave: no balance');
      return BigInt(d.balance);
    },
  };
}

/**
 * 每天检查一次租能量平台的预存余额：超过 1,000 TRX 告警（故障一次、恢复一次，长期没恢复每天一次）。
 * 返回 { status: 'ok' | 'over' | 'unknown' | 'not_configured', balanceTrx? }；查不到余额不告警、不报错。
 */
export async function checkRentalBalance(db, { renter, notify, now = Date.now() } = {}) {
  if (!renter || typeof renter.balance !== 'function') return { status: 'not_configured' };
  let sun;
  try { sun = BigInt(await renter.balance()); } catch { return { status: 'unknown' }; }
  const trx = `${(sun / SUN).toLocaleString('en-US')}${sun % SUN ? '.' + (sun % SUN).toString().padStart(6, '0').replace(/0+$/, '') : ''}`;
  const max = BigInt(RENTAL_PREPAID_MAX_TRX) * SUN;
  if (sun > max) {
    await raiseAlert(db, 'tron_energy_prepaid', notify, `TRON 租能量平台预存余额超过 ${RENTAL_PREPAID_MAX_TRX.toLocaleString('en-US')} TRX`,
      `租能量平台（TronSave）的预存余额现在是 ${trx} TRX，超过建议上限 ${RENTAL_PREPAID_MAX_TRX.toLocaleString('en-US')} TRX。\n`
      + `平台的 API Key 在服务器上，万一泄露，最大损失就是这笔预存余额。请把多余的 TRX 提回去，余额回到上限以下后会发一封恢复邮件。`, { now });
    return { status: 'over', balanceTrx: trx };
  }
  await clearAlert(db, 'tron_energy_prepaid', notify, 'TRON 租能量平台预存余额已回到上限以下', `租能量平台（TronSave）的预存余额现在是 ${trx} TRX，没有超过 ${RENTAL_PREPAID_MAX_TRX.toLocaleString('en-US')} TRX。`);
  return { status: 'ok', balanceTrx: trx };
}
