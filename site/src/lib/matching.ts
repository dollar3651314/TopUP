// 匹配规则的唯一实现在 server/pay/matching.js（服务器和页面共用），这里只是转出。
export * from '../../../server/pay/matching.js';
export type { MatchSettings, OrderState, MOrder, MDeposit } from '../../../server/pay/matching.js';
