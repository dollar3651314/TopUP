// 所有配置都从环境变量读取，敏感信息不进代码仓库。
// 服务器上的变量放在 .env 文件里（只在服务器上，权限 600），变量名见仓库根目录的 .env.example。
export function loadConfig(rawEnv = process.env) {
  // 去掉首尾空白：从终端或密码管理器复制时，容易带上换行
  const env = new Proxy(rawEnv, { get: (o, k) => (typeof o[k] === 'string' ? o[k].trim() : o[k]) });
  const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
  const appEnv = env.APP_ENV || 'local';
  return {
    // 当前环境：production / staging / local
    appEnv,
    // NODE_ENV=production（Docker 镜像）时不允许 APP_ENV=local
    nodeEnv: env.NODE_ENV || '',
    // web 进程
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 8080),
    // 站点的对外地址（邮件里的链接、付款链接），例如 https://pay.example.com；本地不填时用 http://127.0.0.1:<PORT>
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // 在 Nginx 后面运行时为 1：访客 IP 取 Nginx 写入的 X-Real-IP；否则取 TCP 连接的地址（访客无法伪造）
    trustProxy: env.TRUST_PROXY === '1',
    dataDir: env.DATA_DIR || '',
    // Redis（管理员会话、限流、开户资料）：redis://[:密码@]主机:端口/库号
    redisUrl: env.REDIS_URL || '',
    // 邮件：配置了 RESEND_API_KEY 就用 Resend，否则使用 SMTP
    resendApiKey: env.RESEND_API_KEY || '',
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      secure: env.SMTP_SECURE === '1',
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
    },
    mailFrom: env.MAIL_FROM || '',
    mailTo: env.MAIL_TO || '',
    // 开户（KYB）和管理员登录
    appSecret: env.APP_SECRET || '',
    adminSetupToken: env.ADMIN_SETUP_TOKEN || '',
    // 开户文件：服务器本地目录（加密保存，备份由部署脚本负责）
    blobDir: env.BLOB_DIR || '',
    // 收付款
    databaseUrl: env.DATABASE_URL || '',
    localDbDir: env.LOCAL_DB_DIR || '', // 本地和自动化测试：内嵌 Postgres 的数据目录
    tronNetwork: env.TRON_NETWORK || 'mainnet',
    tronApiKey: env.TRONGRID_API_KEY || '',
    usdtContract: env.USDT_CONTRACT || '',
    // 本地和自动化测试：用 TronGrid 替身（只在 APP_ENV=local 时生效）
    fakeTron: appEnv === 'local' && env.FAKE_TRON !== '0',
    // ETH、BSC 合约钱包：节点地址（可能带 API Key，只放 .env）、确认数；合约地址在 config/wallets.json（公开信息，改要走 PR）
    ethRpcUrl: env.ETH_RPC_URL || '',
    bscRpcUrl: env.BSC_RPC_URL || '',
    ethConfirmations: int(env.ETH_CONFIRMATIONS, 12),
    bscConfirmations: int(env.BSC_CONFIRMATIONS, 15),
    // 归集发起账户的私钥（只在服务器的 .env；它只能调用批量合约，钱只能进冷钱包）。没有时只能分配地址、扫链，不能执行归集
    sweepOperatorKey: env.SWEEP_OPERATOR_KEY || '',
    // 本地和自动化测试：ETH、BSC 用内存替身（只在 APP_ENV=local 时生效）
    fakeEvm: appEnv === 'local' && env.FAKE_EVM !== '0',
    // worker 进程：扫链间隔、每日任务的时间（UTC 小时:分钟）
    tickIntervalMs: int(env.TICK_INTERVAL_MS, 15_000),
    dailyAtUtc: env.DAILY_AT_UTC || '19:15',
  };
}
