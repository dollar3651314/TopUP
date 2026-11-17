// 测试工具（不是测试文件）：造一个"已有 TRON 地址的老客户"。
// 按 K1 口径，第 1 批新建客户不再生成任何地址、也不提供新的 TRON 地址；只有升级前的老客户有 TRON 地址，照常入账、照常显示。
// TRON 老地址相关的用例（到账、匹配、TRON 归集、对账）用它直接写入"旧数据"：和第 0 批一样按公钥和序号推导 TRON 地址，
// 写进 customers（address、hd_index）和 customer_addresses（tron、legacy_hd），和升级时补进来的老客户同一个样子。
import { deriveAddress } from '../server/pay/tron.js';
import { getMeta } from '../server/pay/core.js';

export async function legacyTronCustomer(db, merchantId, customerId, { name = '' } = {}) {
  const [found] = await db.query('select * from customers where merchant_id = $1 and customer_id = $2', [merchantId, customerId]);
  if (found?.address) return found;
  const xpub = await getMeta(db, 'xpub');
  if (!xpub) throw new Error('legacyTronCustomer：先 setMeta(db, "xpub", ...)');
  const [n] = await db.query('select coalesce(max(hd_index), -1) + 1 as i from customers');
  const index = Number(n.i);
  const address = deriveAddress(xpub, index);
  const [c] = found
    ? await db.query('update customers set address = $3, hd_index = $4 where merchant_id = $1 and customer_id = $2 returning *', [merchantId, customerId, address, index])
    : await db.query('insert into customers (merchant_id, customer_id, name, address, hd_index) values ($1, $2, $3, $4, $5) returning *', [merchantId, customerId, name, address, index]);
  // 第 0 批派生 TRON 地址用的序号计数（next_index）往后推，免得和代码里别的派生撞号
  await db.query(`insert into pay_meta (key, value) values ('next_index', $1::jsonb)
    on conflict (key) do update set value = to_jsonb(greatest((pay_meta.value)::text::int, (excluded.value)::text::int))`, [JSON.stringify(index + 1)]);
  await db.query(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status)
    values ($1, $2, 'tron', 'legacy_hd', 0, '', $3, 'active') on conflict do nothing`, [merchantId, customerId, address]);
  return c;
}
