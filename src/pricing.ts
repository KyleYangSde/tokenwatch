import { UsageEvent } from './types.js';
export interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }
/** Standard API USD / million tokens; see README for sources and estimate limitations. */
export const prices: Record<string, Price> = {};
function add(names: string[], input: number, output: number, read = input * 0.1) {
  for (const name of names) prices[name] = {input, output, cacheRead:read, cacheWrite:input * 1.25};
}
add(['claude-3-opus','claude-opus-4','claude-opus-4-1'],15,75);
add(['claude-opus-4-5','claude-opus-4-6','claude-opus-4-7','claude-opus-4-8','claude-opus-5'],5,25);
add(['claude-3-5-sonnet','claude-3-7-sonnet','claude-sonnet-4','claude-sonnet-4-5','claude-sonnet-4-6'],3,15);
add(['claude-sonnet-5'],2,10);
add(['claude-3-haiku'],0.25,1.25);
add(['claude-3-5-haiku'],0.8,4);
add(['claude-haiku-4-5'],1,5);
add(['gpt-5','gpt-5-codex','gpt-5-chat-latest','gpt-5.1','gpt-5.1-codex','gpt-5.1-codex-max','gpt-5.1-chat-latest'],1.25,10);
add(['gpt-5-mini'],0.25,2);
add(['gpt-5-nano'],0.05,0.4);
add(['gpt-5.1-codex-mini'],0.25,2);
add(['gpt-5.2','gpt-5.2-codex','gpt-5.2-chat-latest','gpt-5.3-codex'],1.75,14);
add(['gpt-5-pro'],15,120,0);
add(['gpt-5.2-pro'],21,168,0);
add(['gpt-4.1'],2,8,0.5);
add(['gpt-4.1-mini'],0.4,1.6,0.1);
add(['gpt-4.1-nano'],0.1,0.4,0.025);
add(['o3'],2,8,0.5);
add(['o3-mini'],1.1,4.4,0.55);
add(['o4-mini'],1.1,4.4,0.275);
add(['o1'],15,60,7.5);
add(['gpt-4o'],2.5,10,1.25);
add(['gpt-4o-mini'],0.15,0.6,0.075);
add(['codex-mini-latest'],1.5,6,0.375);
export function priceFor(model: string): Price | undefined {
  const normalized = model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return prices[normalized];
}
export function cost(event: UsageEvent): { usd: number; unknown: boolean } {
  const p = priceFor(event.model);
  return p ? {usd:(event.input*p.input + event.output*p.output + event.cacheWrite*p.cacheWrite + event.cacheRead*p.cacheRead)/1e6, unknown:false} : {usd:0, unknown:true};
}
