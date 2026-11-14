// 开放 API 的字段说明（开发者文档 /docs/ 的"接口详情"由这份数据生成）。
// test/docs-reference.test.js 会逐个调用接口，检查返回的字段和这里写的完全一致：接口改了字段而文档没改，测试就会失败。
// 每一项的说明是 [英文, 中文]。

/** 字段类型 */
export const TYPES = {
  string: ['string', '字符串'],
  amount: ['amount', '金额'],
  integer: ['integer', '整数'],
  boolean: ['boolean', '布尔值'],
  time: ['timestamp', '时间'],
  array: ['array', '数组'],
};

/** 返回的对象：[字段, 类型, [英文说明, 中文说明], 可能为 null] */
export const OBJECTS = {
  OrderDeposit: [
    ['id', 'string', ['Deposit ID', '到账编号']],
    ['txid', 'string', ['On-chain transaction ID', '链上交易哈希']],
    ['amount', 'amount', ['Amount received', '到账金额']],
    ['matched_by', 'string', ['How it was matched: deposit (payment arrived after the order), order (order created after the payment) or manual', '匹配方式：deposit（先建单后到账）、order（先到账后建单）、manual（手动匹配）']],
    ['time', 'time', ['Block time of the payment', '链上付款时间']],
  ],
  OrderCore: [
    ['order_no', 'string', ['Order number assigned by TopUP', 'TopUP 生成的订单号']],
    ['merchant_order_no', 'string', ['Your order number', '你的订单号']],
    ['customer_id', 'string', ['Your customer ID', '你的客户标识']],
    ['amount', 'amount', ['Order amount', '订单金额']],
    ['matched', 'amount', ['Total of the deposits matched to this order', '已经匹配到这个订单的到账合计']],
    ['status', 'string', ['pending, partial, completed, overpaid, expired or expired_partial (see Matching rules)', 'pending、partial、completed、overpaid、expired、expired_partial 之一（见"匹配规则"）']],
    ['created_at', 'time', ['Created at', '创建时间']],
    ['expires_at', 'time', ['Expiry time', '过期时间']],
    ['deposits', 'array', ['Deposits matched to this order (OrderDeposit objects)', '匹配到这个订单的到账（OrderDeposit 对象）']],
  ],
  OrderPay: [
    ['address', 'string', ["Address to pay to on the order's chain; null when no chain was given (the payer picks one on the payment page)", '付款地址：指定了链时是这条链的地址；没有指定时为 null（付款人在付款页选链）'], true],
    ['network', 'string', ['Network of address: ETH, BSC or TRON; null when no chain was given', 'address 所在的网络：ETH、BSC 或 TRON；没有指定链时为 null'], true],
    ['chain', 'string', ['Chain given when the order was created (eth or bsc); null = the payer chooses on the payment page', '创建订单时指定的链（eth 或 bsc）；null 表示付款人在付款页自己选'], true],
    ['addresses', 'array', ['Addresses already generated for this customer: [{ chain, address }] (only the order\'s chain when one was given). ETH and BSC use the same address; pay only on the chain you choose', '这个客户已经生成过的地址：[{ chain, address }]（指定了链时只给这条链）。ETH 和 BSC 是同一串地址，只按选定的网络转账'], true],
    ['token', 'string', ['Always USDT', '固定为 USDT']],
    ['pay_url', 'string', ['Hosted payment page for this order', '这个订单的付款页面']],
  ],
  OrderListItem: [
    ['order_no', 'string', ['Order number', '订单号']],
    ['merchant_order_no', 'string', ['Your order number', '你的订单号']],
    ['customer_id', 'string', ['Your customer ID', '你的客户标识']],
    ['amount', 'amount', ['Order amount', '订单金额']],
    ['matched', 'amount', ['Matched total', '已匹配合计']],
    ['status', 'string', ['Order status', '订单状态']],
    ['created_at', 'time', ['Created at', '创建时间']],
    ['expires_at', 'time', ['Expiry time', '过期时间']],
  ],
  Customer: [
    ['customer_id', 'string', ['Your customer ID', '你的客户标识']],
    ['name', 'string', ['Name', '名称']],
    ['email', 'string', ['Email (stored encrypted)', '邮箱（加密保存）']],
    ['remark', 'string', ['Your note', '备注']],
    ['address', 'string', ['Permanent TRON address (older field; only customers who already had one, otherwise null. Use addresses)', '永久收款地址（TRON，旧字段；只有原来就有 TRON 地址的老客户才有，其他为 null；请改用 addresses）'], true],
    ['addresses', 'array', ['Permanent address on each chain used so far: [{ chain, address }], chain is eth, bsc or tron. Generated per chain when the customer makes a deposit (an order names the chain, or the payer picks it); empty for a new customer. ETH and BSC use the same address', '每条链的永久收款地址：[{ chain, address }]，chain 是 eth、bsc 或 tron。在客户发起充值时按链生成（订单指定了链，或付款人在付款页选了链），新客户为空；ETH 和 BSC 是同一串地址']],
    ['total', 'amount', ['Total credited deposits', '累计入账的到账金额']],
    ['count', 'integer', ['Number of credited deposits', '入账的到账笔数']],
    ['fees', 'amount', ['Total collection fees', '累计收款手续费']],
    ['unmatched', 'amount', ['Credited deposits not matched to any order', '已入账但没有匹配订单的金额']],
    ['last_payment_at', 'time', ['Time of the last payment', '最后一次付款时间'], true],
    ['created_at', 'time', ['Created at', '创建时间']],
  ],
  Stats: [
    ['customer_id', 'string', ['Your customer ID', '你的客户标识']],
    ['from', 'time', ['Start of the period', '统计开始时间']],
    ['to', 'time', ['End of the period', '统计结束时间']],
    ['total', 'amount', ['Credited deposits in the period', '期间入账的到账金额']],
    ['count', 'integer', ['Number of credited deposits', '入账笔数']],
    ['fees', 'amount', ['Collection fees', '收款手续费']],
    ['unmatched', 'amount', ['Credited deposits not matched to an order', '没有匹配订单的金额']],
    ['last_payment_at', 'time', ['Last payment in the period', '期间最后一次付款时间'], true],
    ['payouts', 'amount', ['Completed payouts to this customer', '已完成的给这个客户的代付金额']],
    ['payout_count', 'integer', ['Number of completed payouts', '已完成的代付笔数']],
  ],
  Balance: [
    ['available', 'amount', ['Available balance', '可用余额']],
    ['frozen', 'amount', ['Frozen by pending withdrawals', '提币中冻结的金额']],
    ['currency', 'string', ['Always USDT', '固定为 USDT']],
  ],
  LedgerEntry: [
    ['id', 'string', ['Entry ID; also the cursor for the next page', '记录编号，也用于翻页']],
    ['type', 'string', ['deposit, fee_in, freeze, unfreeze, withdraw or fee_out', 'deposit、fee_in、freeze、unfreeze、withdraw、fee_out 之一']],
    ['amount', 'amount', ['Change: positive adds, negative subtracts (withdraw and fee_out change the frozen balance)', '变动金额：正数增加，负数减少（withdraw、fee_out 变动的是冻结余额）']],
    ['available_after', 'amount', ['Available balance after this entry', '这条记录之后的可用余额']],
    ['frozen_after', 'amount', ['Frozen balance after this entry', '这条记录之后的冻结余额']],
    ['ref', 'string', ['Related deposit ID or withdrawal number', '关联的到账编号或提币单号']],
    ['customer_id', 'string', ['Related customer', '关联的客户'], true],
    ['created_at', 'time', ['Created at', '记录时间']],
  ],
  Deposit: [
    ['id', 'string', ['Deposit ID (used by orders/match/)', '到账编号（手动匹配时使用）']],
    ['customer_id', 'string', ['Your customer ID', '你的客户标识']],
    ['chain', 'string', ['Chain of the payment: eth, bsc or tron', '付款所在的链：eth、bsc 或 tron']],
    ['address', 'string', ['Receiving address', '收款地址']],
    ['txid', 'string', ['On-chain transaction ID', '链上交易哈希']],
    ['amount', 'amount', ['Amount received', '到账金额']],
    ['fee', 'amount', ['Collection fee (never more than the amount)', '收款手续费（最多等于到账金额）']],
    ['credited', 'amount', ['Amount added to your balance (amount − fee)', '计入余额的金额（到账金额减手续费）']],
    ['result', 'string', ['Always credited. Payments under 1 USDT are not credited and are not listed', '固定为 credited。低于 1 USDT 的付款不入账，也不会列出']],
    ['order_no', 'string', ['Matched order', '匹配到的订单'], true],
    ['matched_by', 'string', ['deposit, order or manual', 'deposit、order、manual 之一'], true],
    ['time', 'time', ['Block time of the payment', '链上付款时间']],
  ],
  PayoutBatch: [
    ['batch_no', 'string', ['Batch number', '批次号']],
    ['source', 'string', ['api or web (uploaded sheet)', 'api（开放 API）或 web（商户后台上传表格）']],
    ['status', 'string', ['pending (some items not reviewed yet), approved, partially_rejected, rejected, completed or cancelled', 'pending（还有没审核的）、approved、partially_rejected（部分被驳回）、rejected、completed、cancelled 之一']],
    ['count', 'integer', ['Number of items accepted', '收下的笔数']],
    ['total', 'amount', ['Total amount (fees not included)', '金额合计（不含手续费）']],
    ['created_at', 'time', ['Created at', '创建时间']],
    ['items', 'array', ['Items: [{ withdrawal_no, chain, to, amount, fee, status, txid, reason, customer_id, merchant_ref }], in the order submitted', '逐笔：[{ withdrawal_no, chain, to, amount, fee, status, txid, reason, customer_id, merchant_ref }]，按提交顺序']],
  ],
  PayoutBatchService: [
    ['service', 'object', ['Processing hours (UTC+8 08:00–23:00): { open } and, outside the hours, next_open_at', '处理时段（东八区 8:00–23:00）：{ open }，不在时段内另给 next_open_at（下一个 8:00）']],
  ],
  Withdrawal: [
    ['withdrawal_no', 'string', ['Withdrawal number', '提币单号']],
    ['kind', 'string', ['payout (to your customer) or cashout (to your registered wallet)', 'payout（付给你的客户）或 cashout（提到你登记的钱包）']],
    ['chain', 'string', ['Chain it is paid on: eth, bsc or tron', '付款所在的链：eth、bsc 或 tron']],
    ['batch_no', 'string', ['Batch it belongs to (batch payouts); null for single withdrawals', '所属的批量打款批次号；单笔提币为 null'], true],
    ['customer_id', 'string', ['Customer, for payouts', '代付对应的客户'], true],
    ['to', 'string', ['Destination address on that chain', '收款地址（所在链的地址）']],
    ['amount', 'amount', ['Amount sent', '提币金额']],
    ['fee', 'amount', ['Withdrawal fee (amount + fee is frozen on submit)', '提币手续费（提交时冻结"金额 + 手续费"）']],
    ['status', 'string', ['pending, approved, broadcast, completed, rejected, cancelled or failed', 'pending、approved、broadcast、completed、rejected、cancelled、failed 之一']],
    ['txid', 'string', ['On-chain transaction ID once broadcast', '广播后的链上交易哈希'], true],
    ['reason', 'string', ['Rejection or failure reason', '驳回或失败的原因'], true],
    ['merchant_ref', 'string', ['Your reference', '你的备注编号'], true],
    ['source', 'string', ['api or web (merchant dashboard)', 'api（开放 API）或 web（商户后台）']],
    ['created_at', 'time', ['Created at', '创建时间']],
  ],
  DepositEvent: [
    ['customer_id', 'string', ['Your customer ID', '你的客户标识']],
    ['chain', 'string', ['Chain of the payment: eth, bsc or tron', '付款所在的链：eth、bsc 或 tron']],
    ['address', 'string', ['Receiving address', '收款地址']],
    ['txid', 'string', ['On-chain transaction ID', '链上交易哈希']],
    ['amount', 'amount', ['Amount received', '到账金额']],
    ['fee', 'amount', ['Collection fee', '收款手续费']],
    ['credited', 'amount', ['Amount added to your balance', '计入余额的金额']],
    ['order_no', 'string', ['Order it was matched to', '匹配到的订单'], true],
    ['time', 'time', ['Block time of the payment', '链上付款时间']],
  ],
};

/** 列表接口的外层：{ items, next_cursor } */
export const LIST = [
  ['items', 'array', ['Items, newest first', '记录，按时间倒序']],
  ['next_cursor', 'string', ['Pass as cursor to get the next page; null on the last page', '传给 cursor 取下一页；最后一页为 null'], true],
];
const PAGING = [
  ['cursor', 'string', false, ['next_cursor from the previous page', '上一页返回的 next_cursor']],
  ['limit', 'integer', false, ['Page size, 1–100 (default 50)', '每页条数，1 到 100，默认 50']],
];

/**
 * 接口：query / body 是参数 [名称, 类型, 必填, 说明]；returns 是返回的对象（可以是几个对象合并，list 表示外面包一层 LIST）
 */
export const ENDPOINTS = [
  {
    method: 'POST', path: 'orders/', title: ['Create an order', '创建订单'],
    body: [
      ['customer_id', 'string', true, ['Your ID for the customer, 1–128 characters: letters, digits and _ . @ -. A new ID creates the customer (no address yet: addresses are generated per chain when the customer makes a deposit)', '你给客户的标识，1 到 128 位，可用字母、数字和 _ . @ -；新的标识会自动创建客户（不带地址：地址在客户发起充值时按链生成）']],
      ['merchant_order_no', 'string', true, ['Your order number, 1–64 characters: letters, digits, _ and -. Unique in your account', '你的订单号，1 到 64 位，可用字母、数字、_ 和 -；在你的账户里不能重复']],
      ['amount', 'amount', true, ['Order amount in USDT, up to 6 decimals, e.g. "100.5"', '订单金额（USDT），最多 6 位小数，例如 "100.5"']],
      ['customer_name', 'string', false, ['Used only when the customer is new', '只在新建客户时使用']],
      ['customer_email', 'string', false, ['Used only when the customer is new', '只在新建客户时使用']],
      ['chain', 'string', false, ['eth or bsc: the payer can only pay on this chain, and the customer\'s address on this chain is generated now. Leave out to let the payer choose on the payment page (recommended); the address is generated when they choose', 'eth 或 bsc：付款人只能用这条链付款，创建订单时生成客户在这条链的地址。不传时由付款人在付款页选择（推荐），选了才生成那条链的地址']],
    ],
    returns: ['OrderCore', 'OrderPay'],
    errors: ['order_mode_disabled', 'duplicate_merchant_order_no', 'chain_not_enabled', 'invalid_param'],
  },
  {
    method: 'GET', path: 'orders/', title: ['Get an order', '查询订单'],
    query: [
      ['order_no', 'string', false, ['Order number (either this or merchant_order_no)', '订单号（和 merchant_order_no 二选一）']],
      ['merchant_order_no', 'string', false, ['Your order number', '你的订单号']],
    ],
    returns: ['OrderCore', 'OrderPay'], errors: ['not_found'],
  },
  {
    method: 'GET', path: 'orders/list/', title: ['List orders', '订单列表'],
    query: [
      ['status', 'string', false, ['Filter by status', '按状态筛选']],
      ['customer_id', 'string', false, ['Filter by customer', '按客户筛选']],
      ...PAGING,
    ],
    returns: ['OrderListItem'], list: true,
  },
  {
    method: 'POST', path: 'orders/match/', title: ['Match a deposit to an order', '手动匹配'],
    body: [
      ['order_no', 'string', true, ['Order number', '订单号']],
      ['deposit_id', 'string', true, ['Deposit ID from deposits/ (same customer, not yet matched)', '到账编号（来自 deposits/；同一个客户、还没有匹配）']],
    ],
    returns: ['OrderCore'], errors: ['not_found', 'cannot_match'],
    note: ['Changes only the link between the deposit and the order; the balance does not change. Sends an order.matched callback with manual = true.', '只改变到账和订单的关联，不改变余额；会发送 order.matched 回调（manual 为 true）。'],
  },
  {
    method: 'POST', path: 'orders/unmatch/', title: ['Unmatch a deposit', '解除匹配'],
    body: [
      ['order_no', 'string', true, ['Order number', '订单号']],
      ['deposit_id', 'string', true, ['A deposit currently matched to this order', '当前匹配在这个订单上的到账编号']],
    ],
    returns: ['OrderCore'], errors: ['not_found', 'not_matched'],
  },
  {
    method: 'POST', path: 'customers/', title: ['Create or update a customer', '新建或更新客户'],
    body: [
      ['customer_id', 'string', true, ['Your ID for the customer (see Create an order). Cannot be changed later', '你给客户的标识（规则同"创建订单"），之后不能修改']],
      ['name', 'string', false, ['Name, up to 200 characters', '名称，最多 200 个字符']],
      ['email', 'string', false, ['Email', '邮箱']],
      ['remark', 'string', false, ['Note, up to 500 characters', '备注，最多 500 个字符']],
    ],
    returns: ['Customer'], errors: ['invalid_param'],
    note: ['Fields you leave out are not changed. No address is created here: each chain\'s address is generated when the customer first makes a deposit on it, and never changes.', '没有传的字段保持不变；这里不生成地址：每条链的地址在客户第一次在这条链充值时生成，之后不会改变。'],
  },
  {
    method: 'GET', path: 'customers/', title: ['Get a customer', '查询客户'],
    query: [['customer_id', 'string', true, ['Your customer ID', '你的客户标识']]],
    returns: ['Customer'], errors: ['not_found'],
  },
  {
    method: 'GET', path: 'customers/list/', title: ['List customers', '客户列表'],
    query: [['q', 'string', false, ['Search by customer ID, name or email (partial, case-insensitive), or by exact address', '按客户标识、名称或邮箱搜索（部分匹配，不区分大小写），或按地址精确搜索']], ...PAGING],
    returns: ['Customer'], list: true,
  },
  {
    method: 'GET', path: 'customers/stats/', title: ['Customer statistics', '客户统计'],
    query: [
      ['customer_id', 'string', true, ['Your customer ID', '你的客户标识']],
      ['from', 'time', false, ['Start (ISO 8601); default: the beginning', '开始时间（ISO 8601），默认从最早开始']],
      ['to', 'time', false, ['End (ISO 8601); default: now', '结束时间（ISO 8601），默认到现在']],
    ],
    returns: ['Stats'], errors: ['not_found', 'invalid_param'],
  },
  { method: 'GET', path: 'balance/', title: ['Balance', '余额'], returns: ['Balance'] },
  {
    method: 'GET', path: 'ledger/', title: ['Ledger', '账本明细'],
    query: [['customer_id', 'string', false, ['Filter by customer', '按客户筛选']], ...PAGING],
    returns: ['LedgerEntry'], list: true,
  },
  {
    method: 'GET', path: 'deposits/', title: ['Deposits', '到账明细'],
    query: [
      ['customer_id', 'string', false, ['Filter by customer', '按客户筛选']],
      ['matched', 'string', false, ['"false" = credited and not matched to an order; "true" = matched', '"false" 表示已入账但没有匹配订单；"true" 表示已匹配']],
      ...PAGING,
    ],
    returns: ['Deposit'], list: true,
  },
  {
    method: 'POST', path: 'withdrawals/', title: ['Request a withdrawal', '发起提币'],
    body: [
      ['kind', 'string', true, ['payout (to your customer) or cashout (to a wallet registered in your onboarding form)', 'payout（付给你的客户）或 cashout（提到开户时登记的钱包）']],
      ['chain', 'string', false, ['eth, bsc or tron (default tron)', 'eth、bsc 或 tron（不传是 tron）']],
      ['to', 'string', true, ['Destination address on that chain (ETH / BSC: 0x address, mixed case must match the EIP-55 checksum; TRON: Base58). For cashout it must be a wallet registered for that chain', '收款地址：以太坊、BSC 是 0x 地址（大小写混合的必须校验和正确），TRON 是 T 开头的地址；cashout 必须是这条链上登记过的钱包']],
      ['amount', 'amount', true, ['Amount in USDT, up to 6 decimals', '金额（USDT），最多 6 位小数']],
      ['customer_id', 'string', false, ['For payouts: the customer being paid', '代付时填写收款的客户']],
      ['merchant_ref', 'string', false, ['Your reference, up to 64 characters', '你的备注编号，最多 64 个字符']],
    ],
    returns: ['Withdrawal'], errors: ['ip_not_allowed', 'invalid_address', 'address_not_registered', 'insufficient_balance', 'invalid_param'],
    note: ['Requires an IP whitelist. Amount + fee is frozen immediately. Every withdrawal is reviewed manually.', '需要先设置 IP 白名单；提交后立即冻结"金额 + 手续费"；每一笔都经过人工审核。'],
  },
  {
    method: 'GET', path: 'withdrawals/', title: ['Get a withdrawal', '查询提币'],
    query: [['withdrawal_no', 'string', true, ['Withdrawal number', '提币单号']]],
    returns: ['Withdrawal'], errors: ['not_found'],
  },
  {
    method: 'POST', path: 'withdrawals/cancel/', title: ['Cancel a withdrawal', '取消提币'],
    body: [['withdrawal_no', 'string', true, ['Withdrawal number; only pending withdrawals can be cancelled. Items of a batch payout cannot be cancelled one by one: cancel the batch (its not-yet-reviewed items) instead', '提币单号；只能取消待审核（pending）的提币。批量打款里的单不能单笔取消，只能整批取消还没审核的部分']]],
    returns: ['Withdrawal'], errors: ['not_found', 'invalid_state', 'batch_item_cancel'],
  },
  {
    method: 'POST', path: 'payouts/batch/', title: ['Submit a batch payout', '提交批量打款'],
    body: [
      ['items', 'array', true, ['Up to 500 items: [{ chain, to, amount, customer_id?, merchant_ref? }] (chain: eth, bsc or tron; amount in USDT, up to 6 decimals)', '最多 500 笔：[{ chain, to, amount, customer_id?, merchant_ref? }]（chain 是 eth、bsc 或 tron；amount 是 USDT，最多 6 位小数）']],
    ],
    returns: ['PayoutBatch', 'PayoutBatchService'], errors: ['ip_not_allowed', 'too_many_items', 'invalid_rows', 'insufficient_balance', 'invalid_param'],
    note: ['Requires an IP whitelist. If any item is invalid the whole request is rejected with 422 invalid_rows and error.rows = [{ index, code }] (index starts at 0); nothing is frozen. Otherwise amount + fee of every item is frozen at once and each item is reviewed manually. Network fees are not charged separately. Body limit for this endpoint is 256 KB.', '需要先设置 IP 白名单。有一笔不对整个请求返回 422 invalid_rows，error.rows 列出 [{ index, code }]（index 从 0 起），不冻结任何金额；全部没问题时一次冻结每笔的"金额 + 手续费"，每一笔都经过人工审核。网络费不另收。这个接口的请求体上限是 256 KB。'],
  },
  {
    method: 'GET', path: 'payouts/batch/', title: ['Get a batch payout', '查询批量打款'],
    query: [['batch_no', 'string', true, ['Batch number', '批次号']]],
    returns: ['PayoutBatch'], errors: ['not_found'],
  },
];

/** 回调事件：data 的内容 */
export const EVENTS = [
  { type: 'deposit', data: ['DepositEvent'], when: ['A payment of 1 USDT or more to a customer address is credited', '客户地址收到 1 USDT 及以上的付款并入账'] },
  { type: 'order.matched', data: ['OrderCore'], extra: [['manual', 'boolean', ['true when matched or unmatched manually', '手动匹配或解除匹配时为 true']]], when: ['An order changes because deposits were matched or unmatched', '订单因为匹配或解除匹配发生变化'] },
  { type: 'withdrawal.updated', data: ['Withdrawal'], when: ['A withdrawal is created or changes status', '提币创建或状态变化'] },
];
export const EVENT_ENVELOPE = [
  ['id', 'string', ['Event ID; deduplicate by it', '事件编号，请按它去重']],
  ['type', 'string', ['deposit, order.matched or withdrawal.updated', 'deposit、order.matched、withdrawal.updated 之一']],
  ['created_at', 'time', ['When the event was created', '事件产生时间']],
  ['data', 'object', ['Event data, see below', '事件内容，见下表']],
];

/** 错误码：[HTTP, code, 说明] */
export const ERRORS = [
  ['400', 'idempotency_key_required', ['POST without an Idempotency-Key (8–128 characters: letters, digits and _ . : -)', 'POST 请求没有带 Idempotency-Key（8 到 128 位，可用字母、数字和 _ . : -）']],
  ['400', 'invalid_param', ['The request body is not valid JSON', '请求体不是合法的 JSON']],
  ['401', 'invalid_signature', ['Missing or wrong signature, or unknown API Key', '没有签名、签名错误或 API Key 不存在']],
  ['401', 'timestamp_expired', ['Timestamp more than 5 minutes from server time', '时间戳和服务器相差超过 5 分钟']],
  ['403', 'merchant_disabled', ['Account disabled', '账户已停用']],
  ['403', 'order_mode_disabled', ['Order mode is not enabled for your account', '你的账户没有开启订单模式']],
  ['403', 'ip_not_allowed', ['Withdrawal request not from a whitelisted IP (or no whitelist set)', '提币请求不是来自白名单 IP（或没有设置白名单）']],
  ['404', 'not_found', ['Unknown endpoint, or no such object in your account', '接口不存在，或你的账户里没有这条记录']],
  ['409', 'duplicate_merchant_order_no', ['merchant_order_no already used', '商户订单号已经存在']],
  ['409', 'idempotency_conflict', ['Same Idempotency-Key with a different request', '同一个 Idempotency-Key 用在了不同的请求上']],
  ['409', 'request_in_progress', ['A request with this Idempotency-Key is still running; retry shortly', '同一个 Idempotency-Key 的请求还在处理中，请稍后重试']],
  ['409', 'cannot_match', ['The deposit cannot be matched to this order (other customer, already matched, not credited, or order closed)', '这笔到账不能匹配到这个订单（不是同一个客户、已经匹配过、没有入账或订单已关闭）']],
  ['409', 'not_matched', ['The deposit is not matched to this order', '这笔到账没有匹配在这个订单上']],
  ['409', 'chain_not_enabled', ['This chain is not open for new addresses yet (TRON comes in a later release)', '这条链还没有开放分配新地址（TRON 在后续版本开放）']],
  ['409', 'invalid_state', ['Not allowed in the current state (e.g. cancelling a withdrawal that is no longer pending)', '当前状态不允许这个操作（例如取消已经不是待审核的提币）']],
  ['409', 'batch_item_cancel', ['The withdrawal belongs to a batch payout and cannot be cancelled on its own; cancel the batch instead', '这笔属于批量打款，不能单笔取消，请整批取消（只取消还没审核的部分）']],
  ['413', 'too_large', ['Request body over 32 KB (256 KB for POST payouts/batch/)', '请求体超过 32 KB（POST payouts/batch/ 是 256 KB）']],
  ['422', 'invalid_param', ['A parameter is missing or invalid; see error.field', '参数缺失或格式错误，见 error.field']],
  ['422', 'invalid_address', ['Not a valid address for the chain', '不是这条链的合法地址']],
  ['422', 'too_many_items', ['More than 500 items in one batch', '一批超过 500 笔']],
  ['422', 'invalid_rows', ['Some batch items are invalid; see error.rows = [{ index, code }]', '批量打款里有不对的行，见 error.rows = [{ index, code }]']],
  ['422', 'address_not_registered', ['cashout to a wallet that is not registered', 'cashout 的地址不是登记过的钱包']],
  ['422', 'insufficient_balance', ['Amount + fee exceeds available balance', '金额加手续费超过了可用余额']],
  ['429', 'rate_limited', ['More than 20 requests per second; retry later', '每秒超过 20 个请求，请稍后重试']],
  ['503', 'wallet_not_initialized', ['Service not ready yet', '服务还没有准备好']],
  ['500', 'internal_error', ['Unexpected error; safe to retry with the same Idempotency-Key', '服务器内部错误，可以用同一个 Idempotency-Key 重试']],
];

/** 一个接口返回的全部字段（按顺序） */
export function returnFields(ep) {
  return ep.returns.flatMap((name) => OBJECTS[name]);
}
