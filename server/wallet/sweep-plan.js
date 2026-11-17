// 归集预览（纯计算，金额一律 bigint，单位 0.000001 USDT）。
// 跳过的原因按顺序判断：inBatch（已在别的批次里）→ otherScheme（合约参数不是当前这套）→ belowThreshold（低于门槛）
//   → overAddressCap（超过每地址上限，这次整个地址跳过，不拆成部分归集）→ feeRatio（预估手续费 > 余额 × 占比；不知道价格时不判）。
// 其余按余额从大到小装批：超过每批上限或每批地址数就自动拆成几批，每批都不超，每个地址只在一批里。上限 0 = 不限。

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v ?? 0));

export function planSweep(candidates, limits = {}) {
  const threshold = big(limits.threshold);
  const capAddr = big(limits.capPerAddress);
  const capBatch = big(limits.capPerBatch);
  const maxAddr = Number(limits.maxAddresses) || 0;
  const pct = Number(limits.maxFeeRatioPct);
  const pctMilli = Number.isFinite(pct) && pct > 0 ? BigInt(Math.round(pct * 1000)) : null;
  const skipped = [];
  const ok = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = String(c.address).toLowerCase();
    if (seen.has(key)) continue; // 同一个地址只看一次
    seen.add(key);
    const amount = big(c.balance);
    if (amount <= 0n) continue;
    const skip = (reason) => skipped.push({ address: c.address, amount, reason });
    if (c.inBatch) { skip('inBatch'); continue; }
    if (limits.schemeVer != null && c.schemeVer != null && Number(c.schemeVer) !== Number(limits.schemeVer)) { skip('otherScheme'); continue; }
    if (amount < threshold) { skip('belowThreshold'); continue; }
    if (capAddr > 0n && amount > capAddr) { skip('overAddressCap'); continue; }
    // 一个地址比每批上限还大（只在每地址不限、每批有上限时出现）：也是整个地址跳过
    if (capBatch > 0n && amount > capBatch) { skip('overAddressCap'); continue; }
    if (pctMilli !== null && c.estFee !== null && c.estFee !== undefined && big(c.estFee) * 100n * 1000n > amount * pctMilli) { skip('feeRatio'); continue; }
    ok.push({ address: c.address, salt: c.salt, amount, deploy: !c.deployed });
  }
  ok.sort((a, b) => (a.amount === b.amount ? (a.address < b.address ? -1 : 1) : a.amount > b.amount ? -1 : 1));
  // 装批：从大到小，放进第一个还装得下的批次（地址数和金额都不超）
  const batches = [];
  for (const it of ok) {
    let b = batches.find((x) => (capBatch === 0n || x.total + it.amount <= capBatch) && (!maxAddr || x.items.length < maxAddr));
    if (!b) { b = { items: [], total: 0n }; batches.push(b); }
    b.items.push(it);
    b.total += it.amount;
  }
  const total = batches.reduce((s, b) => s + b.total, 0n);
  return { batches, skipped, total };
}
