// 建表脚本。可以重复执行：已存在的表和索引会跳过。
// 金额全部是 bigint，单位 0.000001 USDT；比例（手续费百分比、匹配下限和上限）按百万分之一存。
// 生产、测试环境和本地共用这一份脚本。

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
create table if not exists pay_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists merchants (
  id text primary key,
  name text not null,
  kyb_ref text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  fee_in jsonb not null,
  fee_out jsonb not null,
  order_mode jsonb not null,
  api_key text unique,
  api_secret_enc text,
  callback_url text not null default '',
  ip_whitelist jsonb not null default '[]',
  cashout_wallets jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists balances (
  merchant_id text primary key references merchants(id),
  available bigint not null default 0 check (available >= 0),
  frozen bigint not null default 0 check (frozen >= 0)
);

create table if not exists merchant_users (
  id bigserial primary key,
  merchant_id text not null references merchants(id),
  email text not null unique,
  pw_hash text,
  totp_enc text,
  setup_hash text,
  setup_expires timestamptz,
  session_version int not null default 1,
  fail_count int not null default 0,
  locked_until timestamptz,
  last_totp_step bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists customers (
  merchant_id text not null references merchants(id),
  customer_id text not null,
  name text not null default '',
  email_enc text not null default '',
  remark text not null default '',
  address text not null unique,
  hd_index int not null unique,
  activated boolean not null default false,
  total bigint not null default 0,
  count int not null default 0,
  fees bigint not null default 0,
  unmatched bigint not null default 0,
  last_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (merchant_id, customer_id)
);

create table if not exists orders (
  id text primary key,
  merchant_id text not null,
  merchant_order_no text not null,
  customer_id text not null,
  amount bigint not null check (amount > 0),
  matched bigint not null default 0,
  status text not null,
  low int not null,
  high int not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (merchant_id, merchant_order_no),
  foreign key (merchant_id, customer_id) references customers (merchant_id, customer_id)
);
create index if not exists orders_open on orders (merchant_id, customer_id, created_at) where status in ('pending', 'partial');
create index if not exists orders_expiry on orders (expires_at) where status in ('pending', 'partial');

create table if not exists deposits (
  id bigserial primary key,
  txid text not null,
  log_index int not null,
  block bigint not null,
  address text not null,
  merchant_id text not null,
  customer_id text not null,
  amount bigint not null,
  fee bigint not null default 0,
  result text not null check (result in ('credited', 'below_min')),
  order_id text references orders(id),
  match_type text,
  matched_at timestamptz,
  time timestamptz not null,
  created_at timestamptz not null default now(),
  unique (txid, log_index)
);
create index if not exists deposits_customer on deposits (merchant_id, customer_id, time);
create index if not exists deposits_unmatched on deposits (merchant_id, customer_id, time) where order_id is null and result = 'credited';

create table if not exists ledger (
  id bigserial primary key,
  merchant_id text not null,
  type text not null check (type in ('deposit', 'fee_in', 'freeze', 'unfreeze', 'withdraw', 'fee_out')),
  amount bigint not null,
  available_after bigint not null,
  frozen_after bigint not null,
  ref text not null,
  customer_id text,
  created_at timestamptz not null default now()
);
create index if not exists ledger_merchant on ledger (merchant_id, id);

-- 账本只追加：任何修改和删除都在数据库层面被拒绝
create or replace function ledger_append_only() returns trigger language plpgsql as $$
begin raise exception 'ledger is append-only'; end $$;
drop trigger if exists ledger_append_only on ledger;
create trigger ledger_append_only before update or delete on ledger for each row execute function ledger_append_only();

create table if not exists withdrawals (
  id text primary key,
  merchant_id text not null references merchants(id),
  kind text not null check (kind in ('payout', 'cashout')),
  customer_id text,
  to_address text not null,
  amount bigint not null check (amount > 0),
  fee bigint not null,
  source text not null check (source in ('web', 'api')),
  status text not null,
  merchant_ref text,
  reason text,
  txid text,
  batch_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  notified boolean not null default false
);
create index if not exists withdrawals_status on withdrawals (status, created_at);

create table if not exists sign_batches (
  id text primary key,
  kind text not null check (kind in ('withdraw', 'sweep')),
  status text not null,
  plan jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sweeps (
  id bigserial primary key,
  batch_id text not null references sign_batches(id),
  address text not null,
  amount bigint not null,
  status text not null,
  txids jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create unique index if not exists sweeps_one_active on sweeps (address) where status in ('planned', 'broadcasting');

create table if not exists callbacks (
  id text primary key,
  merchant_id text not null,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'ok', 'failed')),
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  last_code int,
  created_at timestamptz not null default now()
);
create index if not exists callbacks_due on callbacks (next_at) where status = 'pending';

create table if not exists idempotency (
  merchant_id text not null,
  key text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (merchant_id, key)
);

create table if not exists anomalies (
  id bigserial primary key,
  type text not null,
  merchant_id text,
  customer_id text,
  address text not null,
  amount text not null,
  ref text not null default '',
  handled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (type, address, ref)
);

create table if not exists recon (
  day date primary key,
  balances bigint not null,
  chain bigint not null,
  fees bigint not null,
  diff bigint not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- 地址里还没归集的 USDT（按链上到账累加，归集完成后扣减；归集前会再向链上核实）
alter table customers add column if not exists onchain bigint not null default 0;
create index if not exists customers_onchain on customers (onchain) where onchain > 0;
alter table sign_batches add column if not exists verified_until timestamptz;

-- 客户邮箱的检索哈希（HMAC，见 common.js 的 emailHash）。按完整邮箱查找客户时用，客户再多也不用逐个解密
alter table customers add column if not exists email_hash text not null default '';
create index if not exists customers_email_hash on customers (merchant_id, email_hash) where email_hash <> '';

-- ---------- 多链（第 1 批：ETH、BSC 合约钱包） ----------
-- 客户序号：合约充值地址的盐由它算（正整数、客户之间唯一、各条链相同）。和 hd_index（TRON 助记词地址的序号）无关
create sequence if not exists customer_seq;
alter table customers add column if not exists seq bigint;
update customers set seq = nextval('customer_seq') where seq is null;
alter table customers alter column seq set default nextval('customer_seq');
create unique index if not exists customers_seq on customers (seq);
-- K1：地址在客户发起充值时按链生成，新客户不再派生 TRON 地址：address、hd_index 允许为空（唯一约束照旧，空值不冲突）
alter table customers alter column address drop not null;
alter table customers alter column hd_index drop not null;

-- 每个客户每条链的收款地址。创建时记下提供方、合约参数版本和盐；更换地址时旧地址停用（一直扫链、照常入账、由原提供方归集）
create table if not exists customer_addresses (
  id bigserial primary key,
  merchant_id text not null,
  customer_id text not null,
  chain text not null check (chain in ('eth', 'bsc', 'tron')),
  provider text not null,
  scheme_ver int not null default 0,
  salt text not null default '',
  address text not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (merchant_id, customer_id) references customers (merchant_id, customer_id),
  unique (chain, address)
);
create unique index if not exists customer_addresses_active on customer_addresses (merchant_id, customer_id, chain) where status = 'active';
create index if not exists customer_addresses_lookup on customer_addresses (chain, lower(address));
create index if not exists customer_addresses_provider on customer_addresses (chain, provider);
-- 升级前已有的 TRON 客户（助记词派生的地址）：补一行 tron、provider = legacy_hd；重复执行不重复插入
insert into customer_addresses (merchant_id, customer_id, chain, provider, scheme_ver, salt, address, status)
  select c.merchant_id, c.customer_id, 'tron', 'legacy_hd', 0, '', c.address, 'active' from customers c
  where c.address is not null and not exists (select 1 from customer_addresses a where a.chain = 'tron' and a.address = c.address)
  on conflict do nothing;

-- 钱包提供方路由：这个商户这条链 → 这条链 → 全局默认 contract。第一版只开放按链整体切换（merchant_id 留空）
create table if not exists wallet_routes (
  id bigserial primary key,
  merchant_id text,
  chain text not null check (chain in ('eth', 'bsc', 'tron')),
  provider text not null,
  effective_from timestamptz not null default now(),
  actor text not null default '',
  reason text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists wallet_routes_lookup on wallet_routes (chain, effective_from);

-- 到账记链；同一笔交易号在不同链上互不影响
alter table deposits add column if not exists chain text not null default 'tron';
alter table deposits drop constraint if exists deposits_chain_check;
alter table deposits add constraint deposits_chain_check check (chain in ('eth', 'bsc', 'tron'));
alter table deposits add column if not exists raw_amount text;
create unique index if not exists deposits_chain_tx on deposits (chain, txid, log_index);
alter table deposits drop constraint if exists deposits_txid_log_index_key;

-- 订单可以指定链（空 = 付款人自己选）
alter table orders add column if not exists chain text check (chain in ('eth', 'bsc', 'tron'));

-- 合约钱包归集（ETH、BSC，半自动）：系统凑批 → 管理员确认 → 一笔交易
create table if not exists wallet_sweep_batches (
  id text primary key,
  chain text not null,
  provider text not null,
  status text not null check (status in ('awaiting_approval', 'sending', 'sent', 'confirmed', 'partial', 'failed', 'expired', 'cancelled')),
  total bigint not null,
  address_count int not null,
  skipped jsonb not null default '[]',
  fee_estimate jsonb not null default '{}',
  tx_refs jsonb not null default '[]',
  slot text not null default '',
  approved_by text,
  approved_at timestamptz,
  reason text,
  error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists wallet_sweep_batches_status on wallet_sweep_batches (chain, status, created_at);
create table if not exists wallet_sweep_items (
  id bigserial primary key,
  batch_id text not null references wallet_sweep_batches(id),
  chain text not null,
  address text not null,
  salt text not null,
  amount bigint not null,
  deploy boolean not null,
  status text not null check (status in ('pending', 'sent', 'swept', 'failed', 'released')),
  reason text
);
-- 一个地址同一时间只在一个没结束的批次里
create unique index if not exists wallet_sweep_items_active on wallet_sweep_items (chain, address) where status in ('pending', 'sent');
create index if not exists wallet_sweep_items_batch on wallet_sweep_items (batch_id);

create table if not exists pay_audit (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target text not null default '',
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);

-- 第 3 批批量打款：提币按链（老数据是 TRON）；审核通过（approved）后按链凑批签名；商户上传的一张表 / 一次 API 是一个批次（batch_ref）
alter table withdrawals add column if not exists chain text not null default 'tron';
alter table withdrawals drop constraint if exists withdrawals_chain_check;
alter table withdrawals add constraint withdrawals_chain_check check (chain in ('eth', 'bsc', 'tron'));
alter table withdrawals add column if not exists batch_ref text;
alter table withdrawals add column if not exists approved_at timestamptz;
alter table withdrawals add column if not exists approved_by text;
create index if not exists withdrawals_batch_ref on withdrawals (batch_ref) where batch_ref is not null;
create index if not exists withdrawals_approved on withdrawals (chain, status, approved_at);
-- 商户的批量打款（一张表或一次 API）
create table if not exists payout_batches (
  batch_no text primary key,
  merchant_id text not null references merchants(id),
  source text not null check (source in ('web', 'api')),
  item_count int not null,
  total bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists payout_batches_merchant on payout_batches (merchant_id, created_at);
-- 打款交易批次（按链凑批）：ETH / BSC 一批一笔 BatchPayout.pay 交易；TRON 一批 N 笔转账（逐笔记账）
create table if not exists payout_tx_batches (
  id text primary key,
  chain text not null check (chain in ('eth', 'bsc', 'tron')),
  status text not null check (status in ('planned', 'broadcast', 'confirmed', 'partial', 'failed', 'expired')),
  item_ids jsonb not null,
  total bigint not null,
  batch_hex text,
  raw_hex text,
  expect jsonb,
  tx_hash text,
  energy jsonb,
  error text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payout_tx_batches_status on payout_tx_batches (chain, status, created_at);
`;

/**
 * 给已有的客户补算邮箱哈希（上线后第一次启动时执行，每批 500 个；全部补完后记一个标记，以后不再执行）。
 * 新建、修改客户时由 ops.js 同步写入，不需要再补。
 */
export async function backfillEmailHash(db, { decrypt, hash }) {
  const [done] = await db.query(`select 1 from pay_meta where key = 'email_hash_v7'`);
  if (done) return 0;
  let n = 0, last = -1;
  for (;;) {
    // 按地址序号（唯一）往后翻页；解密失败的行跳过，不会反复处理
    const rows = await db.query(`select hd_index, email_enc from customers where email_hash = '' and email_enc <> '' and hd_index > $1 order by hd_index limit 500`, [last]);
    if (!rows.length) break;
    for (const r of rows) {
      let e = ''; try { e = decrypt(r.email_enc); } catch { e = ''; }
      if (e) { await db.query('update customers set email_hash = $1 where hd_index = $2', [hash(e), r.hd_index]); n++; }
    }
    last = rows.at(-1).hd_index;
  }
  await db.query(`insert into pay_meta (key, value) values ('email_hash_v7', 'true'::jsonb) on conflict (key) do nothing`);
  return n;
}

/** 执行建表脚本，并记录版本号 */
export async function migrate(db) {
  // PGlite 的 query 只接受单条语句，exec 可以执行整段；postgres.js 的 unsafe 可以直接执行多条语句
  if (db.exec) await db.exec(SCHEMA); else await db.query(SCHEMA);
  await db.query(`insert into pay_meta (key, value) values ('schema_version', $1::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify(SCHEMA_VERSION)]);
  await repairDoubleEncoded(db);
}

/**
 * 数据修复（一次性）：修复之前，线上（postgres.js）存进 jsonb 的值被多编码了一层，成了 JSON 字符串。
 * 只处理"字符串里装的是对象、数组、字符串或数字"的值，这些不可能是正常数据；修完记一个标记，以后不再执行。
 */
export async function repairDoubleEncoded(db) {
  const [done] = await db.query(`select 1 from pay_meta where key = 'repair_p5'`);
  if (done) return;
  const cols = await db.query(`select table_name t, column_name c from information_schema.columns
    where table_schema = current_schema() and data_type = 'jsonb' order by 1, 2`);
  for (const { t, c } of cols) {
    await db.query(`update ${t} set ${c} = (${c} #>> '{}')::jsonb
      where jsonb_typeof(${c}) = 'string' and (${c} #>> '{}') ~ '^(\\{|\\[|"|-?[0-9]+(\\.[0-9]+)?$)'`);
  }
  await db.query(`insert into pay_meta (key, value) values ('repair_p5', 'true'::jsonb) on conflict (key) do nothing`);
}
