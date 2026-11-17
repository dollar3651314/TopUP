// 金额规则的唯一实现在 server/pay/money.js（服务器和页面共用），这里只是转出。
export * from '../../../server/pay/money.js';
export type { FeeRule } from '../../../server/pay/money.js';
