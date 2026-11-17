// worker 每轮：扫 ETH、BSC 已确认的 USDT 转账并入账（每条链一个游标）。一条链出错不影响另一条，也不影响 TRON。
// 游标、上次扫块时间和最新区块记在 pay_meta：evm_cursor_<链>、evm_scan_<链>。出错告警：故障一次、恢复一次、长期没恢复每天一次。
import { recordDeposit, getMeta, setMeta } from '../pay/core.js';
import { raiseAlert, clearAlert, CHAIN_NAMES } from './sweep.js';

export async function scanEvm(db, { layer, notify, maxRounds = 5 } = {}) {
  const out = {};
  const p = layer?.providers?.contract;
  for (const chain of layer?.enabledChains || []) {
    const r = { credited: 0, seen: 0 };
    try {
      let cursor = await getMeta(db, `evm_cursor_${chain}`, null);
      for (let i = 0; i < maxRounds; i++) {
        const { deposits, next } = await p.scan(chain, cursor);
        r.seen += deposits.length;
        for (const d of deposits) {
          try { if ((await recordDeposit(db, d)).status === 'credited') r.credited++; }
          catch (e) {
            console.error(`[scan:${chain}] deposit ${d.txid}:${d.logIndex} failed: ${e.message}`);
            await db.query(`insert into anomalies (type, address, amount, ref) values ('process_error', $1, $2, $3) on conflict do nothing`, [d.to, `${Number(d.amount) / 1e6} USDT`, `${chain}:${d.txid}:${d.logIndex}`]);
          }
        }
        const moved = String(next) !== String(cursor);
        cursor = next;
        await setMeta(db, `evm_cursor_${chain}`, cursor);
        if (!moved) break;
      }
      const head = await layer.adapters[chain].head().catch(() => null);
      await setMeta(db, `evm_scan_${chain}`, { at: new Date().toISOString(), cursor, head });
      r.cursor = cursor;
      await clearAlert(db, `scan_${chain}`, notify, `${CHAIN_NAMES[chain]} 扫块已恢复`, `${CHAIN_NAMES[chain]} 的扫块已恢复正常，期间的到账会按顺序补上。`);
    } catch (e) {
      r.error = e.message;
      console.error(`[scan:${chain}] ${e.message}`);
      await raiseAlert(db, `scan_${chain}`, notify, `${CHAIN_NAMES[chain]} 扫块出错`, `${CHAIN_NAMES[chain]} 扫块出错（会自动重试；恢复后补扫，到账不会丢）：${e.message}`).catch(() => {});
    }
    out[chain] = r;
  }
  return out;
}
