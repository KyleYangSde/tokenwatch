import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogReader, parseLogFile } from '../src/storage.js';
import { MAX_LINE_LENGTH, parseClaude, parseCodex } from '../src/parsers.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
let root: string;
let saved: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tokenwatch-performance-'));
  saved = process.env.TOKENWATCH_CACHE_DIR;
  process.env.TOKENWATCH_CACHE_DIR = join(root, 'cache');
  vi.mocked(createReadStream).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.TOKENWATCH_CACHE_DIR;
  else process.env.TOKENWATCH_CACHE_DIR = saved;
  await rm(root, { recursive: true, force: true });
});
const claudeLine = JSON.stringify({ type: 'assistant', timestamp: '2026-01-01', message: { usage: { output_tokens: 7 } } });
const codexLine = JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 7 } } } });
describe('large-log parsing', () => {
  it.each(['claude', 'codex'] as const)('streams %s across chunks, CRLF and a final unterminated line', async source => {
    const fixture = await readFile(new URL(`fixtures/${source}.jsonl`, import.meta.url), 'utf8');
    const text = ('{"unrelated":"' + 'x'.repeat(70000) + '"}\r\n').repeat(5) + fixture.replace(/\n/g, '\r\n').trimEnd();
    const file = join(root, 'session.jsonl');
    await writeFile(file, text);
    expect(await parseLogFile(file, source)).toEqual(source === 'claude' ? parseClaude(text, file) : parseCodex(text, file));
    expect(createReadStream).toHaveBeenCalledWith(file, { encoding: 'utf8' });
  });
  it('prefilters unrelated lines before JSON.parse and keeps metadata', () => {
    const spy = vi.spyOn(JSON, 'parse');
    parseClaude('{"type":"user"}\ninvalid\n' + claudeLine);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    const events = parseCodex('{"type":"user"}\ninvalid\n{"type":"session_meta","payload":{"id":"session"}}\n{"type":"turn_context","payload":{"model":"gpt-5"}}\n' + codexLine);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(events[0]).toMatchObject({ session: 'session', model: 'gpt-5' });
  });
  it.each(['claude', 'codex'] as const)('skips oversized %s lines without parsing and resumes at the next line', async source => {
    const line = source === 'claude' ? claudeLine : codexLine;
    const huge = line.slice(0, -1) + ',"padding":"' + 'x'.repeat(MAX_LINE_LENGTH) + '"}';
    const file = join(root, 'large.jsonl');
    await writeFile(file, huge + '\n' + line + '\n' + huge);
    const spy = vi.spyOn(JSON, 'parse');
    const events = await parseLogFile(file, source);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    spy.mockClear();
    expect(source === 'claude' ? parseClaude(huge) : parseCodex(huge)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
describe('persistent cache', () => {
  it('reuses events across readers and invalidates changed signatures, versions and schemas', async () => {
    const file = join(root, 'session.jsonl');
    await writeFile(file, claudeLine);
    const options = { claudeDir: root, source: 'claude' as const };
    const expected = await new LogReader().read(options);
    vi.mocked(createReadStream).mockClear();
    expect(await new LogReader().read(options)).toEqual(expected);
    expect(createReadStream).not.toHaveBeenCalled();
    await utimes(file, new Date(), new Date(Date.now() + 10000));
    await new LogReader().read(options);
    expect(createReadStream).toHaveBeenCalledTimes(1);
    await writeFile(file, claudeLine + '\n' + claudeLine);
    await new LogReader().read(options);
    expect(createReadStream).toHaveBeenCalledTimes(2);
    const cachePath = join(root, 'cache', 'cache.json');
    for (const field of ['version', 'schema']) {
      const cache = JSON.parse(await readFile(cachePath, 'utf8'));
      cache[field] = 'outdated';
      await writeFile(cachePath, JSON.stringify(cache));
      vi.mocked(createReadStream).mockClear();
      await new LogReader().read(options);
      expect(createReadStream).toHaveBeenCalledTimes(1);
    }
    await rm(file);
    await new LogReader().read(options);
    expect(JSON.parse(await readFile(cachePath, 'utf8')).entries).toEqual({});
  });
  it('limits simultaneous file streams to eight and reports progress only on a TTY', async () => {
    for (let i = 0; i < 20; i++) await writeFile(join(root, `${i}.jsonl`), claudeLine);
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    let active = 0, peak = 0;
    vi.mocked(createReadStream).mockImplementation((...args: Parameters<typeof createReadStream>) => {
      const stream = original.createReadStream(...args);
      active++; peak = Math.max(peak, active);
      stream.once('end', () => active--);
      return stream;
    });
    const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
      expect(await new LogReader().read({ claudeDir: root, source: 'claude', cache: false })).toHaveLength(20);
      expect(peak).toBeLessThanOrEqual(8);
      expect(peak).toBeGreaterThan(1);
      expect(output.mock.calls.some(([value]) => String(value).includes('Scanning 20/20 files (0.0 GB)...'))).toBe(true);
      expect(String(output.mock.calls.at(-1)?.[0])).toMatch(/^\r +\r$/);
      output.mockClear();
      Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false });
      await new LogReader().read({ claudeDir: root, source: 'claude', cache: false });
      expect(output).not.toHaveBeenCalled();
    } finally {
      if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
      vi.mocked(createReadStream).mockImplementation(original.createReadStream);
    }
  });
  it('bypasses cache entirely and skips files older than since', async () => {
    const file = join(root, 'session.jsonl');
    await writeFile(file, claudeLine);
    const options = { claudeDir: root, source: 'claude' as const, cache: false };
    await new LogReader().read(options);
    await new LogReader().read(options);
    expect(createReadStream).toHaveBeenCalledTimes(2);
    await expect(readFile(join(root, 'cache', 'cache.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await utimes(file, new Date('2025-01-01'), new Date('2025-01-01'));
    vi.mocked(createReadStream).mockClear();
    expect(await new LogReader().read({ ...options, since: '2026-01-01' })).toEqual([]);
    expect(createReadStream).not.toHaveBeenCalled();
  });
});
