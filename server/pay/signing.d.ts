export declare function addressOfPublicKey(pub: Uint8Array): string;
export declare function addressOfPrivateKey(priv: Uint8Array): string;
export declare function signTxId(txIdHex: string, priv: Uint8Array): string;
export declare function signerOf(txIdHex: string, sigHex: string): string | null;
export declare function keyForAddress(input: string, address: string): Promise<{ key: Uint8Array; error?: undefined } | { key?: undefined; error: 'format' | 'mnemonic' | 'mismatch' | 'not_found' }>;
