export interface DecodedContract { type: string; permissionId: number; owner?: string; to?: string | null; amount?: number | null; contract?: string; callValue?: number; method?: string; resource?: string; lock?: boolean }
export interface DecodedTx { txId: string; expiration: number; timestamp: number; feeLimit: number; contracts: DecodedContract[] }
export declare function decodeRaw(rawHex: string): DecodedTx;
export declare function txIdOf(rawHex: string): string;
export declare function setExpiration(rawHex: string, expirationMs: number): string;
export declare function encodeSigned(rawHex: string, signatureHex: string): string;
export declare function encodeRaw(c: { type: string; owner: string; to: string; amount: number; contract?: string }, opts?: { expiration?: number; timestamp?: number; feeLimit?: number }): string;
export declare const toAddress: (b: Uint8Array) => string;
export declare const fromAddress: (a: string) => Uint8Array;
