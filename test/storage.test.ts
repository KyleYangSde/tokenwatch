import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directories, LogReader, readConfig } from '../src/storage.js';
const temporary:string[]=[];
async function temp() {const p=await mkdtemp(join(tmpdir(),'tokenwatch-test-'));temporary.push(p);return p;}
let savedCacheDir:string|undefined;
beforeEach(async()=>{savedCacheDir=process.env.TOKENWATCH_CACHE_DIR;process.env.TOKENWATCH_CACHE_DIR=join(await temp(),'cache');});
afterEach(()=>{if(savedCacheDir===undefined) delete process.env.TOKENWATCH_CACHE_DIR; else process.env.TOKENWATCH_CACHE_DIR=savedCacheDir;});
afterEach(async()=>{await Promise.all(temporary.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
describe('log polling',()=>{
  it('discovers nested files, reuses unchanged logs and reparses appended or truncated files',async()=>{
    const root=await temp(), claude=join(root,'claude'), codex=join(root,'codex'), nested=join(claude,'-work-demo');
    await mkdir(nested,{recursive:true}); await mkdir(join(codex,'2026','01','01'),{recursive:true});
    const c=await readFile(new URL('fixtures/claude.jsonl',import.meta.url),'utf8');
    const x=await readFile(new URL('fixtures/codex.jsonl',import.meta.url),'utf8');
    const file=join(nested,'c1.jsonl');
    await writeFile(file,c); await writeFile(join(codex,'2026','01','01','rollout-test.jsonl'),x);
    const reader=new LogReader(), dirs={claudeDir:claude,codexDir:codex};
    expect(await reader.read(dirs)).toHaveLength(7); expect(await reader.read(dirs)).toHaveLength(7);
    expect(await reader.read({...dirs,source:'codex'})).toHaveLength(4);
    await writeFile(file,c+'\n'+JSON.stringify({type:'assistant',timestamp:'2026-01-03',message:{id:'new',usage:{output_tokens:4}}}));
    expect(await reader.read(dirs)).toHaveLength(8);
    await writeFile(file,''); expect(await reader.read(dirs)).toHaveLength(4);
    await rm(codex,{recursive:true}); expect(await reader.read(dirs)).toHaveLength(0);
  });
  it('uses CLI overrides before environment overrides',()=>{
    const saved=process.env.TOKENWATCH_CLAUDE_DIR;
    try {
      process.env.TOKENWATCH_CLAUDE_DIR='/tmp/from-env';
      expect(directories({}).claude).toBe('/tmp/from-env');
      expect(directories({claudeDir:'/tmp/from-cli'}).claude).toBe('/tmp/from-cli');
    } finally {if (saved===undefined) delete process.env.TOKENWATCH_CLAUDE_DIR; else process.env.TOKENWATCH_CLAUDE_DIR=saved;}
  });
});
describe('config',()=>{
  it('handles missing config, accepts known limits and rejects invalid values',async()=>{
    const path=join(await temp(),'config.json');
    expect(await readConfig(path)).toEqual({});
    await writeFile(path,'{"limitTokens":1000,"limitCost":2.5,"future":true}');
    expect(await readConfig(path)).toEqual({limitTokens:1000,limitCost:2.5});
    await writeFile(path,'{"limitCost":-1}'); await expect(readConfig(path)).rejects.toThrow('positive');
    await writeFile(path,'broken'); await expect(readConfig(path)).rejects.toThrow();
  });
});
