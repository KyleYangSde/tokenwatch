import { UsageEvent } from './types.js';
import { cost } from './pricing.js';
export const WINDOW_MS = 5 * 60 * 60 * 1000;
export interface Limits { limitTokens?: number; limitCost?: number }
export function currentWindow(events: UsageEvent[], now = Date.now(), limits: Limits = {}) {
  const sorted = events.filter(e => Date.parse(e.timestamp) <= now && e.total > 0).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  let start: number | undefined;
  let active: UsageEvent[] = [];
  for (const e of sorted) {
    const t = Date.parse(e.timestamp);
    if (start === undefined || t >= start + WINDOW_MS) {start=t; active=[];}
    active.push(e);
  }
  if (start === undefined || now >= start + WINDOW_MS) return null;
  const end = start + WINDOW_MS, elapsed = (now-start)/3600000;
  const tokens = active.reduce((sum,e)=>sum+e.total,0), costUSD = active.reduce((sum,e)=>sum+cost(e).usd,0);
  const tokensPerHour = elapsed > 0 ? tokens/elapsed : 0, costPerHour = elapsed > 0 ? costUSD/elapsed : 0;
  const predict = (limit: number | undefined, used: number, rate: number) => limit === undefined ? null : used >= limit ? now : rate > 0 ? now+(limit-used)/rate*3600000 : null;
  return {start:new Date(start).toISOString(), end:new Date(end).toISOString(), tokens,costUSD,tokensPerHour,costPerHour,
    predictedTokenLimitAt: predict(limits.limitTokens,tokens,tokensPerHour), predictedCostLimitAt:predict(limits.limitCost,costUSD,costPerHour),
    resetInSeconds:(end-now)/1000, unknownModels:[...new Set(active.filter(e=>cost(e).unknown).map(e=>e.model))], ...limits};
}
