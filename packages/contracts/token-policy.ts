/** null explicitly disables Supervisor token ceilings; never serialize Infinity. */
export type TokenLimit = number | null;
export type TokenTier = 'medium' | 'high' | 'unlimited';
export const TOKEN_TIERS: Record<TokenTier, {label:string;limit:TokenLimit;reservation:number;verificationReserve:number}> = {
  medium: {label:'中',limit:5_000_000,reservation:500_000,verificationReserve:1_000_000},
  high: {label:'高',limit:50_000_000,reservation:2_000_000,verificationReserve:5_000_000},
  unlimited: {label:'无限',limit:null,reservation:500_000,verificationReserve:1_000_000},
};
/** Only for local comparisons/arithmetic. Persist the original nullable value. */
export function tokenCapacity(limit:TokenLimit):number { return limit === null ? Infinity : limit; }
export function tokenRemaining(limit:TokenLimit,used:number):TokenLimit { return limit === null ? null : limit-used; }
/** Reservations stay finite accounting estimates in unlimited mode. */
export function withinTokenReservation(limit:TokenLimit,usage:number,reservation:number):boolean {return Number.isSafeInteger(usage)&&usage>=0&&Number.isSafeInteger(reservation)&&reservation>=0&&(limit===null||usage<=reservation);}
export function formatTokenLimit(limit:TokenLimit):string {return limit===null?'无限':limit.toLocaleString('zh-CN');}
