// 测试工具（不是测试文件）：v1.1 开放 API 补接口（提现单号永久防重、对账查询、每天上限按商户算、冲正）几个测试文件共用的准备工作。
// 两个商户 ma、mb（各自有 API Key、IP 白名单 203.0.113.10）；api(cred, method, path, body, opts) 按开发者文档签名后调用开放 API。
import { randomUUID } from 'node:crypto';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../server/pay/db.js';
import { migrate } from '../server/pay/schema.js';
import * as core from '../server/pay/core.js';
import { createOps } from '../server/pay/ops.js';
import { createApiV1, signRequest, canonicalPath } from '../server/pay/api-v1.js';
import { derivePayKeys } from '../server/pay/common.js';
import { legacyTronCustomer } from './legacy-tron.js';

export const U = 1_000_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
export const TO = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const TO2 = 'TJ1c1YU6Jq3orqQ8mPGkpXt1TTNC3EBK7Q';
export const ETH_TO = '0x52908400098527886E0F7030069857D2E4169EE7';
export const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');
export const IP = '203.0.113.10';
/** 和接口一样过一遍 JSON（undefined 的字段消失） */
export const wire = (x) => JSON.parse(JSON.stringify(x));

/**
 * fee：两个商户的付款手续费（默认每笔 1 USDT）、收款手续费（默认 1%）。fund：每个商户先放进可用余额多少 USDT（直接改余额，不记账本）
 */
export async function world({ fund = 10_000, feeIn = { ppm: 10_000, fixed: 0, min: 0 }, feeOut = { ppm: 0, fixed: 1 * U, min: 0 } } = {}) {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  let clock = Date.now();
  const now = () => clock;
  const mails = [];
  const notify = async (subject, text) => { mails.push({ subject, text }); };
  const ops = createOps({ db, keys, payBase: 'https://pay.test', now, notify });
  const mk = async (id) => {
    const m = await core.createMerchant(db, { id, name: `Name ${id}`, feeIn, feeOut });
    const cred = await ops.regenerateSecret(m);
    await ops.setIpWhitelist(m, [IP]);
    if (fund) await db.query('update balances set available = available + $2 where merchant_id = $1', [id, fund * U]);
    return { id, cred, m: async () => core.getMerchant(db, id) };
  };
  const a = await mk('ma'), b = await mk('mb');
  const handler = createApiV1({ db, keys, ops, getIp: () => IP, allow: async () => true }); // 限流另有测试，这里不限
  /** 调开放 API：path 不带 /api/v1/ 前缀，例如 'withdrawals/'、'deposits/?from=...' */
  const api = async (who, method, path, body, { idem = randomUUID() } = {}) => {
    const raw = body ? JSON.stringify(body) : '';
    const url = `https://api.test/api/v1/${path}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await handler(new Request(url, { method, body: raw || undefined, headers: { 'content-type': 'application/json', 'x-topup-key': who.cred.api_key, 'x-topup-timestamp': ts, 'x-topup-signature': signRequest(who.cred.api_secret, ts, method, canonicalPath(url), raw), ...(method === 'POST' ? { 'idempotency-key': idem } : {}) } }));
    return { status: res.status, body: await res.json() };
  };
  const balance = async (id) => (await db.query('select * from balances where merchant_id = $1', [id]))[0];
  /** 造一个有 TRON 老地址的客户，返回地址 */
  const customer = async (mid, cid) => (await legacyTronCustomer(db, mid, cid)).address;
  let seq = 0;
  const txid = () => (++seq).toString(16).padStart(8, '0') + randomUUID().replace(/-/g, '') + 'a'.repeat(24);
  return { db, ops, a, b, api, balance, customer, txid, mails, notify, now, setNow: (v) => (clock = v), advance: (ms) => (clock += ms), handler };
}
