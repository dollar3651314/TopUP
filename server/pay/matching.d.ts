export interface MatchSettings { low: number; high: number; ttlMin: number; lookbackH: number }
export type OrderState = 'pending' | 'partial' | 'completed' | 'overpaid' | 'expired' | 'expired_partial';
export interface MOrder { id: string; customer: string; amount: number; matched: number; createdAt: string; expiresAt: string; status: OrderState; low: number; high: number }
export interface MDeposit { id: string; customer: string; amount: number; time: string; credited: boolean; orderId: string | null; matchType?: 'deposit' | 'order' | 'manual' }
export declare function stateOf(o: MOrder, now?: number): OrderState;
export declare function matchOnDeposit(d: MDeposit, orders: MOrder[], now?: number): MOrder | null;
export declare function matchOnCreate(o: MOrder, deposits: MDeposit[], lookbackH: number): MDeposit[];
export declare function manualMatch(o: MOrder, d: MDeposit, now?: number): boolean;
export declare function unmatch(o: MOrder, d: MDeposit, now?: number): boolean;
