import { readdir, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseClaude, parseCodex } from './parsers.js';
import { Source, UsageEvent, object } from './types.js';
import { Limits } from './window.js';
export interface Directories { claudeDir?: string; codexDir?: string; source?: Source | 'all' }
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
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path);
  }
  return result.sort();
}
export class LogReader {
  private cache = new Map<string,{signature:string; events:UsageEvent[]}>();
  async read(options: Directories): Promise<UsageEvent[]> {
    const dirs=directories(options), events:UsageEvent[]=[];
    const present=new Set<string>();
    for (const source of ['claude','codex'] as const) {
      if (options.source && options.source !== 'all' && options.source !== source) continue;
      for (const path of await files(dirs[source])) {
        const key=`${source}:${path}`; present.add(key);
        try {
          const info=await stat(path), signature=`${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
          let cached=this.cache.get(key);
          if (!cached || cached.signature !== signature) {
            const text=await readFile(path,'utf8');
            cached={signature,events:source==='claude' ? parseClaude(text,path) : parseCodex(text,path)};
            this.cache.set(key,cached);
          }
          events.push(...cached.events);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    for (const key of this.cache.keys()) if (!present.has(key)) this.cache.delete(key);
    return events.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
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
