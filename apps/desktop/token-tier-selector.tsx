import React from 'react';
import { TOKEN_TIERS, type TokenTier } from '../../packages/contracts/token-policy.js';
export function TokenTierSelector({value,onChange}:{value:TokenTier;onChange:(value:TokenTier)=>void}) {
 return <fieldset className="token-tier"><legend>Token 消耗</legend><div className="token-tier-options" role="radiogroup" aria-label="Token 消耗档位">{(Object.keys(TOKEN_TIERS) as TokenTier[]).map(tier=><label key={tier} className={tier===value?'selected':''}><input type="radio" name="token-tier" value={tier} checked={tier===value} onChange={()=>onChange(tier)}/><strong>{TOKEN_TIERS[tier].label}</strong><span>{tier==='medium'?'累计 500 万':tier==='high'?'累计 5,000 万':'不设 Token 上限'}</span></label>)}</div><p className="form-hint">{value==='unlimited'?'持续统计用量，不因累计 Token 或单次调用预留停工。取消、超时、验收与 Codex 账户限额仍然有效。':'主控、子 Agent、验收、修复及后续跟进共用累计额度；到达额度时停止派发。'}</p></fieldset>;
}
