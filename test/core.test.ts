import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseClaude, parseCodex } from '../src/parsers.js';
import { cost, priceFor } from '../src/pricing.js';
import { aggregate } from '../src/aggregation.js';
import { currentWindow, WINDOW_MS } from '../src/window.js';
import { WatchState } from '../src/watch.js';
const fixture=(name:string)=>readFileSync(new URL(`fixtures/${name}.jsonl`,import.meta.url),'utf8');
const claude=parseClaude(fixture('claude')), codex=parseCodex(fixture('codex'));
const start=Date.parse('2026-01-01T00:00:00Z');
describe('Claude parser',()=>{
  it('skips bad lines, merges streaming snapshots and keeps distinct request IDs',()=>{
    expect(claude).toHaveLength(3); expect(claude[0]).toMatchObject({session:'c1',project:'/work/demo',input:100,output:30,cacheWrite:20,cacheRead:80,total:230,timestamp:'2026-01-01T00:00:00.000Z'});
    expect(claude[1].total).toBe(60); expect(claude[2].total).toBe(10);
  });
  it('falls back to filename and encoded project and tolerates invalid shapes',()=>{
    expect(parseClaude('[]\n{"type":"assistant","message":null}')).toEqual([]);
    const e=parseClaude('{"type":"assistant","timestamp":"2026-01-01","message":{"usage":{"output_tokens":1}}}','/logs/-work-demo/session.jsonl')[0];
    expect(e).toMatchObject({session:'session',project:'-work-demo',model:'unknown'});
  });
});
describe('Codex parser',()=>{
  it('uses last usage or cumulative differences, skips repeats/null, tracks models and resets',()=>{
    expect(codex).toHaveLength(4);
    expect(codex[0]).toMatchObject({input:60,cacheRead:40,output:20,reasoning:10,total:120,model:'gpt-5',session:'x1'});
    expect(codex[1]).toMatchObject({input:40,cacheRead:10,output:10,total:60});
    expect(codex[2]).toMatchObject({model:'o4-mini',input:10,cacheRead:5,cacheWrite:5,total:25});
    expect(codex[3].total).toBe(12);
  });
  it('deduplicates identical timestamp/usage when cumulative totals are absent',()=>{
    const line=JSON.stringify({timestamp:'2026-01-01',type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:10,output_tokens:1}}}});
    expect(parseCodex(`${line}\n${line}`)).toHaveLength(1);
  });
});
describe('pricing',()=>{
  it('prices Claude separate cache buckets and dated model names',()=>{
    expect(cost(claude[0]).usd).toBeCloseTo((100*3+30*15+20*3.75+80*0.3)/1e6);
    expect(priceFor('claude-opus-4-5-20251101')?.input).toBe(5);
    expect(priceFor('claude-opus-4-20250514')?.input).toBe(15);
  });
  it('prices cached OpenAI input without adding reasoning to output',()=>{
    expect(cost(codex[0]).usd).toBeCloseTo((60*1.25+40*0.125+20*10)/1e6);
    expect(priceFor('gpt-4.1-2025-04-14')?.cacheRead).toBe(0.5);
    expect(priceFor('o4-mini')?.cacheRead).toBe(0.275);
  });
  it('marks unknown models without guessing family prices',()=>{
    expect(cost(claude[2])).toEqual({usd:0,unknown:true}); expect(priceFor('gpt-5-future')).toBeUndefined();
  });
});
describe('aggregation',()=>{
  it('groups days, projects, models and namespaced sessions',()=>{
    const events=[...claude,...codex];
    expect(aggregate(events,'day')).toHaveLength(2);
    expect(aggregate(events,'project').find(r=>r.key==='/work/demo')?.tokens).toBe(507);
    expect(aggregate(events,'model').find(r=>r.key==='future-model')?.unknownModels).toEqual(['future-model']);
    expect(aggregate(events,'session').map(r=>r.key)).toContain('codex:x1');
    expect(aggregate(events,'day').reduce((s,r)=>s+r.costUSD,0)).toBeCloseTo(events.reduce((s,e)=>s+cost(e).usd,0));
  });
});
describe('windows',()=>{
  const e=(hours:number)=>({...claude[0],timestamp:new Date(start+hours*3600000).toISOString()});
  it('anchors each block at first event after prior end, excluding future usage',()=>{
    const w=currentWindow([e(0),e(4),e(6),e(7),e(12)],start+8*3600000)!;
    expect(w.start).toBe(e(6).timestamp); expect(w.end).toBe(e(11).timestamp); expect(w.tokens).toBe(460);
  });
  it('expires exactly at reset and starts a new block at boundary',()=>{
    expect(currentWindow([e(0)],start+WINDOW_MS)).toBeNull();
    expect(currentWindow([e(0),e(5)],start+WINDOW_MS)?.tokens).toBe(230);
    expect(currentWindow([],start)).toBeNull();
  });
  it('calculates elapsed burn rates and predicts limits',()=>{
    const w=currentWindow([e(0)],start+3600000,{limitTokens:460,limitCost:cost(e(0)).usd*2})!;
    expect(w.tokensPerHour).toBe(230); expect(w.predictedTokenLimitAt).toBe(start+7200000);
    expect(w.predictedCostLimitAt).toBeCloseTo(start+7200000); expect(w.resetInSeconds).toBe(14400);
    expect(currentWindow([e(0)],start,{limitTokens:100})?.predictedTokenLimitAt).toBe(start);
    expect(currentWindow([e(0)],start,{limitTokens:1000})?.predictedTokenLimitAt).toBeNull();
  });
});
describe('watch state',()=>{
  it('notifies once after idle, rearms after activity, skips already idle startup sessions',()=>{
    const state=new WatchState(), options={idleMinutes:10};
    expect(state.check([claude[0]],options,start+60000)).toEqual([]);
    expect(state.check([claude[0]],options,start+600000)).toHaveLength(1);
    expect(state.check([claude[0]],options,start+700000)).toEqual([]);
    expect(state.check([claude[0],claude[1]],options,start+3600000)).toEqual([]);
    expect(state.check([claude[0],claude[1]],options,start+4200000)).toHaveLength(1);
    expect(new WatchState().check([claude[0]],options,start+4200000)).toEqual([]);
  });
  it('notifies once per window across either threshold and again in the next block',()=>{
    const state=new WatchState(), options={idleMinutes:10,thresholdTokens:100,thresholdCost:0.00001};
    expect(state.check([claude[0]],options,start)).toHaveLength(1);
    expect(state.check([claude[0]],options,start+1000)).toEqual([]);
    const later={...claude[0],timestamp:new Date(start+6*3600000).toISOString()};
    expect(state.check([later],options,start+6*3600000)).toHaveLength(1);
  });
});
