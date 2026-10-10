import { UsageEvent } from './types.js';
import { cost } from './pricing.js';
export type Group = 'session' | 'project' | 'model' | 'day';
export interface Summary { key: string; events: number; input: number; output: number; cacheWrite: number; cacheRead: number; reasoning: number; tokens: number; costUSD: number; unknownModels: string[] }
export function aggregate(events: UsageEvent[], by: Group): Summary[] {
  const groups = new Map<string, Summary>();
  for (const e of events) {
    const key = by === 'day' ? e.timestamp.slice(0,10) : by === 'session' ? `${e.source}:${e.session}` : e[by];
    const row = groups.get(key) ?? {key,events:0,input:0,output:0,cacheWrite:0,cacheRead:0,reasoning:0,tokens:0,costUSD:0,unknownModels:[]};
    row.events++; row.tokens += e.total;
    for (const field of ['input','output','cacheWrite','cacheRead','reasoning'] as const) row[field] += e[field];
    const c = cost(e); row.costUSD += c.usd;
    if (c.unknown && !row.unknownModels.includes(e.model)) row.unknownModels.push(e.model);
    groups.set(key,row);
  }
  return [...groups.values()].sort((a,b) => by === 'day' ? b.key.localeCompare(a.key) : b.costUSD-a.costUSD || b.tokens-a.tokens || a.key.localeCompare(b.key));
}
