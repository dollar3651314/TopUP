import type { Page } from '@playwright/test';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
// @ts-ignore 与后端同一份 TRON 地址推导
import { deriveAddress, ACCOUNT_PATH } from '../../server/pay/tron.js';

// 端到端用：造一个"已有 TRON 地址的老客户"（和 test/legacy-tron.js 同一个做法，经本地才有的 /__fake/sql/ 写入旧数据）。
// 按 K1 口径，第 1 批新建客户不生成任何地址、也不提供新的 TRON 地址；TRON 到账、TRON 归集这些第 0 批流程只对老客户，
// 所以这些用例先造老客户再用。merchantName：商户名称（按名称找商户编号）。
export async function legacyTron(page: Page, base: string, merchantName: string, customerId: string, name = '') {
  const sql = async (q: string, params: unknown[] = []) => {
    const r = await page.request.post(`${base}/__fake/sql/`, { data: { sql: q, params } });
    if (!r.ok()) throw new Error(`fake sql ${r.status()}: ${await r.text()}`);
    return r.json();
  };
  const [m] = await sql('select id from merchants where name = $1', [merchantName]);
  const [found] = await sql('select address from customers where merchant_id = $1 and customer_id = $2', [m.id, customerId]);
  if (found?.address) return found.address as string;
  const [x] = await sql(`select value from pay_meta where key = 'xpub'`);
  const [n] = await sql('select coalesce(max(hd_index), -1) + 1 as i from customers');
  const index = Number(n.i);
  const address: string = deriveAddress(x.value, index);
  if (found) await sql('update customers set address = $3, hd_index = $4 where merchant_id = $1 and customer_id = $2', [m.id, customerId, address, index]);
  else await sql('insert into customers (merchant_id, customer_id, name, address, hd_index) values ($1, $2, $3, $4, $5)', [m.id, customerId, name, address, index]);
  await sql(`insert into pay_meta (key, value) values ('next_index', $1::jsonb)
    on conflict (key) do update set value = to_jsonb(greatest((pay_meta.value)::text::int, (excluded.value)::text::int))`, [JSON.stringify(index + 1)]);
  await sql(`insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status)
    values ($1, $2, 'tron', 'legacy_hd', 0, '', $3, 'active') on conflict do nothing`, [m.id, customerId, address]);
  return address;
}

// 端到端用：造"第 0 批已经初始化过 TRON 主助记词"的旧系统（Q-A1 之后后台不再提供"初始化主助记词"，
// 线上的旧系统早已初始化；全新的测试环境只能经本地才有的 /__fake/sql/ 写入旧数据）。
// 助记词在测试进程里生成（相当于当年浏览器生成、离线抄写），服务器只拿到账户级公钥 xpub，和当年的初始化一样。
// 返回 24 个单词（旧地址归集签名时要用）和 xpub。已经有 xpub 时报错（不覆盖，避免用例之间互相污染）。
export async function legacyMnemonic(page: Page, base: string) {
  const sql = async (q: string, params: unknown[] = []) => {
    const r = await page.request.post(`${base}/__fake/sql/`, { data: { sql: q, params } });
    if (!r.ok()) throw new Error(`fake sql ${r.status()}: ${await r.text()}`);
    return r.json();
  };
  const [had] = await sql(`select value from pay_meta where key = 'xpub'`);
  if (had) throw new Error('xpub 已经存在：legacyMnemonic 只能在全新的环境里用一次');
  const words = generateMnemonic(wordlist, 256).split(' ');
  const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(words.join(' '))).derive(ACCOUNT_PATH).publicExtendedKey;
  await sql(`insert into pay_meta (key, value) values ('xpub', $1::jsonb)`, [JSON.stringify(xpub)]);
  return { words, xpub, firstAddress: deriveAddress(xpub, 0) as string };
}
