export declare const DECIMALS: number;
export interface FeeRule { ppm: number; fixed: number; min: number }
export declare function parseUsdt(input: string): number | null;
export declare function fmtUsdt(units: number, minFrac?: number): string;
export declare function calcFee(amount: number, rule: FeeRule): number;
export declare function describeFee(rule: FeeRule, lang?: 'en' | 'zh'): string;
export declare const isTronAddress: (s: string) => boolean;
export declare const shortAddr: (a: string) => string;
