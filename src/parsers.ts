import { basename, dirname } from 'node:path';
import { UsageEvent, number as n, object, string } from './types.js';
function lines(text: string): Record<string, any>[] {
  const result: Record<string, any>[] = [];
  for (const line of text.split(/\r?\n/)) { try { result.push(object(JSON.parse(line))); } catch { /* incomplete or corrupt line */ } }
  return result;
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return;
  return new Date(value).toISOString();
}
export function parseClaude(text: string, file = 'session.jsonl'): UsageEvent[] {
  const events = new Map<string, UsageEvent>();
  let index = 0;
  for (const row of lines(text)) {
    const message = object(row.message), usage = object(message.usage), time = timestamp(row.timestamp);
    if (row.type !== 'assistant' || !time || !Object.keys(usage).length) continue;
    const event: UsageEvent = {
      source: 'claude', session: string(row.sessionId, basename(file, '.jsonl')),
      project: string(row.cwd, basename(dirname(file))), model: string(message.model, 'unknown'), timestamp: time,
      input: n(usage.input_tokens), output: n(usage.output_tokens), cacheWrite: n(usage.cache_creation_input_tokens),
      cacheRead: n(usage.cache_read_input_tokens), reasoning: 0, total: 0
    };
    event.total = event.input + event.output + event.cacheWrite + event.cacheRead;
    const key = typeof message.id === 'string' ? JSON.stringify([event.session, message.id, row.requestId ?? message.requestId ?? '']) : `line:${index++}`;
    const previous = events.get(key);
    // Streaming snapshots are cumulative; merge maxima rather than charging each snapshot.
    if (previous) {
      for (const field of ['input', 'output', 'cacheWrite', 'cacheRead'] as const) event[field] = Math.max(previous[field], event[field]);
      event.total = event.input + event.output + event.cacheWrite + event.cacheRead;
      event.timestamp = previous.timestamp;
    }
    events.set(key, event);
  }
  return [...events.values()];
}
const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'] as const;
export function parseCodex(text: string, file = 'rollout.jsonl'): UsageEvent[] {
  let session = basename(file, '.jsonl'), project = 'unknown', model = 'unknown';
  let previous: Record<string, number> | undefined;
  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  for (const row of lines(text)) {
    const payload = object(row.payload);
    if (row.type === 'session_meta') { session = string(payload.id, session); project = string(payload.cwd, project); }
    if (row.type === 'turn_context') model = string(payload.model, model);
    if (row.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const time = timestamp(row.timestamp), info = object(payload.info);
    if (!time || !Object.keys(info).length) continue;
    const total = object(info.total_token_usage), last = object(info.last_token_usage);
    const hasTotal = Object.keys(total).length > 0;
    const current = Object.fromEntries(fields.map(f => [f, n(total[f])]));
    if (hasTotal && previous && fields.every(f => previous![f] === current[f])) continue;
    let usage: Record<string, any> = last;
    if (!Object.keys(last).length) {
      if (!hasTotal) continue;
      const reset = previous && (current.input_tokens < previous.input_tokens || current.output_tokens < previous.output_tokens);
      usage = Object.fromEntries(fields.map(f => [f, Math.max(0, current[f] - (reset ? 0 : previous?.[f] ?? 0))]));
    }
    if (hasTotal) previous = current;
    else {
      const key = JSON.stringify([session, time, usage]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const input = n(usage.input_tokens), output = n(usage.output_tokens);
    const write = Math.min(input, n(usage.cache_write_input_tokens));
    const read = Math.min(input - write, n(usage.cached_input_tokens));
    const event: UsageEvent = {source:'codex', session, project, model, timestamp:time,
      input: input - read - write, output, cacheWrite:write, cacheRead:read,
      reasoning:n(usage.reasoning_output_tokens), total:input + output};
    if (event.total > 0) events.push(event);
  }
  return events;
}
