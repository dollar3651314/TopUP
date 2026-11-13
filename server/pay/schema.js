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

create table if not exists pay_audit (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target text not null default '',
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
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
