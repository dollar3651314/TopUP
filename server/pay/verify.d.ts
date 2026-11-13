import type { DecodedTx } from './txcodec.js';
export declare const LIMITS: { activateMax: number; feeTrxMax: number; feeLimitMax: number; maxExpiryMs: number };
export declare function checkStep(step: { kind: string; rawHex: string; txID?: string }, expect: { to?: string; from?: string; amount?: number }, rules: { hot: string; cold: string; usdt: string }, now?: number): { ok: boolean; error?: string; decoded?: DecodedTx };
