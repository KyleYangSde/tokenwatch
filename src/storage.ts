import { readdir, stat, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { createParser, MAX_LINE_LENGTH } from './parsers.js';
import { VERSION } from './version.js';
import { Source, UsageEvent, object } from './types.js';
import { Limits } from './window.js';
export interface Directories { claudeDir?: string; codexDir?: string; source?: Source | 'all'; since?: string; cache?: boolean }
export function expand(path: string): string { return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(),path.slice(2)) : path); }
export function directories(options: Directories) {
  return {claude:expand(options.claudeDir ?? process.env.TOKENWATCH_CLAUDE_DIR ?? join(homedir(),'.claude','projects')),
    codex:expand(options.codexDir ?? process.env.TOKENWATCH_CODEX_DIR ?? join(homedir(),'.codex','sessions'))};
}
export async function files(root: string): Promise<string[]> {
  let entries;
  try {entries=await readdir(root,{withFileTypes:true});} catch (error) {
    if (['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries) {
    const path=join(root,entry.name);
    if (entry.isDirectory()) for (const child of await files(path)) result.push(child);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path);
  }
  return result.sort();
}
export const CACHE_SCHEMA = 1;
interface CacheEntry { source: Source; mtimeMs: number; size: number; events: UsageEvent[] }
interface DiskCache { version: string; schema: number; entries: Record<string, CacheEntry> }

export async function parseLogFile(path: string, source: Source): Promise<UsageEvent[]> {
  const parser = createParser(source, path);
  // Discard oversized lines while reading chunks, before readline can buffer them.
  let pending = '', oversized = false;
  const bounded = new Transform({
    decodeStrings: false,
    transform(chunk: string, _encoding, callback) {
      let start = 0;
      for (;;) {
        const end = chunk.indexOf('\n', start);
        const segment = chunk.slice(start, end < 0 ? undefined : end);
        if (!oversized) {
          if (pending.length + segment.length > MAX_LINE_LENGTH) { pending = ''; oversized = true; }
          else pending += segment;
        }
        if (end < 0) break;
        if (!oversized) this.push(pending + '\n');
        pending = ''; oversized = false; start = end + 1;
      }
      callback();
    },
    flush(callback) { if (!oversized && pending) this.push(pending); callback(); }
  });
  const input = createReadStream(path, { encoding: 'utf8' });
  input.on('error', error => bounded.destroy(error));
  input.pipe(bounded);
  const lines = createInterface({ input: bounded, crlfDelay: Infinity });
  try { for await (const line of lines) parser.line(line); }
  finally { lines.close(); input.destroy(); bounded.destroy(); }
  return parser.result();
}

export class LogReader {
  async read(options: Directories): Promise<UsageEvent[]> {
    const dirs = directories(options), events: UsageEvent[] = [];
    const cacheDir = expand(process.env.TOKENWATCH_CACHE_DIR ?? join(homedir(), '.cache', 'tokenwatch'));
    const cachePath = join(cacheDir, 'cache.json');
    const cache: DiskCache = { version: VERSION, schema: CACHE_SCHEMA, entries: Object.create(null) };
    if (options.cache !== false) {
      try {
        const saved = JSON.parse(await readFile(cachePath, 'utf8'));
        if (saved.version === VERSION && saved.schema === CACHE_SCHEMA && saved.entries && typeof saved.entries === 'object') {
          for (const [path, entry] of Object.entries(saved.entries)) {
            const value = entry as CacheEntry;
            if (value && ['claude', 'codex'].includes(value.source) && typeof value.mtimeMs === 'number' && typeof value.size === 'number' && Array.isArray(value.events)) cache.entries[path] = value;
          }
        }
      } catch { /* Missing or damaged caches are rebuilt. */ }
    }
    const jobs: { path: string; source: Source }[] = [];
    for (const source of ['claude', 'codex'] as const) {
      if (options.source && options.source !== 'all' && options.source !== source) continue;
      for (const path of await files(dirs[source])) jobs.push({ path, source });
    }
    let next = 0, completed = 0, bytes = 0, progressWidth = 0;
    const results: UsageEvent[][] = new Array(jobs.length);
    const progress = () => {
      if (!process.stderr.isTTY) return;
      const message = `Scanning ${completed}/${jobs.length} files (${(bytes / 1e9).toFixed(1)} GB)...`;
      progressWidth = Math.max(progressWidth, message.length);
      process.stderr.write('\r' + message.padEnd(progressWidth));
    };
    const since = options.since ? Date.parse(options.since) : -Infinity;
    const worker = async () => {
      while (next < jobs.length) {
        const index = next++, { path, source } = jobs[index];
        try {
          const info = await stat(path);
          bytes += info.size;
          if (info.mtimeMs < since) continue;
          let entry = options.cache === false ? undefined : cache.entries[path];
          if (!entry || entry.source !== source || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
            const parsed = await parseLogFile(path, source);
            entry = { source, mtimeMs: info.mtimeMs, size: info.size, events: parsed };
            // Do not cache a file changed during scanning.
            const after = await stat(path);
            if (options.cache !== false && after.mtimeMs === info.mtimeMs && after.size === info.size) cache.entries[path] = entry;
            else delete cache.entries[path];
          }
          results[index] = entry.events;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          delete cache.entries[path];
        } finally { completed++; progress(); }
      }
    };
    progress();
    try {
      const workers = await Promise.allSettled(Array.from({ length: Math.min(8, jobs.length) }, worker));
      for (const result of workers) if (result.status === 'rejected') throw result.reason;
    } finally { if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(progressWidth) + '\r'); }
    for (const result of results) if (result) for (const event of result) events.push(event);
    if (options.cache !== false) {
      // Preserve other sources/roots, but prune deleted files everywhere.
      for (const path of Object.keys(cache.entries)) {
        try { await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') delete cache.entries[path]; }
      }
      const temporary = join(cacheDir, `cache.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
        await rename(temporary, cachePath);
      } catch { /* Cache availability must not prevent reading logs. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
    return events.sort((a,b) => a.timestamp.localeCompare(b.timestamp));
  }
}
export async function readConfig(path=join(homedir(),'.tokenwatch.json')): Promise<Limits> {
  let text: string;
  try {text=await readFile(path,'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return {}; throw error;}
  const config=object(JSON.parse(text)), result:Limits={};
  for (const field of ['limitTokens','limitCost'] as const) {
    if (config[field] !== undefined) {
      if (typeof config[field] !== 'number' || !Number.isFinite(config[field]) || config[field] <= 0) throw new Error(`Config ${field} must be a positive number`);
      result[field]=config[field];
    }
  }
  return result;
}
