#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { LogReader, readConfig, Directories } from './storage.js';
import { aggregate, Group, Summary } from './aggregation.js';
import { currentWindow } from './window.js';
import { notify, WatchState } from './watch.js';
function positive(value:string):number {const n=Number(value); if (!Number.isFinite(n) || n<=0) throw new InvalidArgumentError('must be a positive number'); return n;}
function integer(value:string):number {const n=positive(value); if (!Number.isInteger(n)) throw new InvalidArgumentError('must be a positive integer'); return n;}
function date(value:string):string {if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) throw new InvalidArgumentError('must be a valid YYYY-MM-DD date'); return value;}
function table(rows:Summary[]):string {
  if (!rows.length) return 'No usage found.';
  const data=[['Group','Input','Output','Cache write','Cache read','Tokens','Cost USD','Unknown models'],...rows.map(r=>[r.key,String(r.input),String(r.output),String(r.cacheWrite),String(r.cacheRead),String(r.tokens),`$${r.costUSD.toFixed(4)}`,r.unknownModels.join(', ') || '-'])];
  // Strip terminal control characters from untrusted log fields.
  const clean=data.map(row=>row.map(cell=>cell.replace(/[\x00-\x1f\x7f-\x9f]/g,'?')));
  const widths=clean[0].map((_,i)=>Math.max(...clean.map(r=>r[i].length)));
  return clean.map((row,index)=>row.map((v,i)=>v.padEnd(widths[i])).join('  ')+(index===0?'\n'+widths.map(w=>'-'.repeat(w)).join('  '):'')).join('\n');
}
const program=new Command().name('tokenwatch').description('Local Claude Code and Codex CLI usage estimates').version('0.1.0');
program.option('--claude-dir <path>','Claude projects directory (TOKENWATCH_CLAUDE_DIR)').option('--codex-dir <path>','Codex sessions directory (TOKENWATCH_CODEX_DIR)');
function common(command:Command):Command {
  return command.option('--claude-dir <path>','override Claude projects directory').option('--codex-dir <path>','override Codex sessions directory')
    .addOption(new Option('--source <source>','usage source').choices(['claude','codex','all']).default('all'));
}
const reader=new LogReader();
common(program.command('report').description('Aggregate usage and estimated API cost'))
  .option('--since <date>','inclusive UTC date',date)
  .addOption(new Option('--by <group>','group output').choices(['session','project','model','day']))
  .option('--top <N>','maximum sessions (or rows with --by)',integer,10).option('--json','machine-readable report')
  .action(async (_options,command:Command)=>{
    const options=command.optsWithGlobals();
    const events=(await reader.read(options)).filter(e=>!options.since || e.timestamp.slice(0,10)>=options.since);
    const groups:Group[]=options.by ? [options.by] : ['day','model','project','session'];
    const report=Object.fromEntries(groups.map(by=>[by,aggregate(events,by).slice(0,options.by || by==='session' ? options.top : undefined)]));
    if (options.json) console.log(JSON.stringify(report,null,2));
    else {for (const [by,rows] of Object.entries(report)) console.log(`\nBy ${by}\n${table(rows)}`); console.log('\nUSD estimates; unknown models cost $0. Days use UTC.');}
  });
common(program.command('window').description('Current five-hour usage block'))
  .option('--limit-tokens <N>','token limit',integer).option('--limit-cost <USD>','USD limit',positive).option('--json','machine-readable window')
  .action(async (_options,command:Command)=>{
    const options=command.optsWithGlobals(), config=await readConfig();
    const window=currentWindow(await reader.read(options),Date.now(),{limitTokens:options.limitTokens ?? config.limitTokens,limitCost:options.limitCost ?? config.limitCost});
    if (options.json) {console.log(JSON.stringify(window,null,2)); return;}
    if (!window) {console.log('No active window. The next usage event starts a new 5-hour block.'); return;}
    const prediction=(time:number|null)=>time===null?'unavailable (no limit or no burn rate)':`${new Date(time).toISOString()}${time>Date.parse(window.end)?' (after reset)':''}`;
    console.log(`Window: ${window.start} → ${window.end}\nUsed: ${window.tokens} tokens; $${window.costUSD.toFixed(4)}\nBurn rate: ${window.tokensPerHour.toFixed(0)} tokens/hour; $${window.costPerHour.toFixed(4)}/hour\nToken limit: ${window.limitTokens ?? 'unset'}; predicted hit: ${prediction(window.predictedTokenLimitAt)}\nCost limit: ${window.limitCost ?? 'unset'}; predicted hit: ${prediction(window.predictedCostLimitAt)}\nReset in: ${Math.ceil(window.resetInSeconds/60)} minutes${window.unknownModels.length?'\nUnknown models ($0): '+window.unknownModels.join(', '):''}`);
  });
common(program.command('watch').description('Poll logs and notify on idle sessions or window thresholds'))
  .option('--interval <sec>','poll seconds',positive,30).option('--idle-minutes <N>','idle duration',positive,10)
  .option('--threshold-tokens <N>','notify token threshold',integer).option('--threshold-cost <USD>','notify USD threshold',positive)
  .action(async (_options,command:Command)=>{
    const options=command.optsWithGlobals(), state=new WatchState();
    let stopped=false, wake:(()=>void)|undefined;
    const stop=()=>{stopped=true; wake?.();};
    process.on('SIGINT',stop); process.on('SIGTERM',stop);
    console.log(`Watching logs every ${options.interval}s; idle timeout ${options.idleMinutes} minutes. Press Ctrl+C to stop.`);
    try {
      while (!stopped) {
        for (const message of state.check(await reader.read(options as Directories),{idleMinutes:options.idleMinutes,thresholdTokens:options.thresholdTokens,thresholdCost:options.thresholdCost})) await notify(message);
        if (!stopped) await new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},Math.min(options.interval*1000,2147483647)); wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});
      }
    } finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  });
program.parseAsync().catch((error:Error)=>{console.error(`tokenwatch: ${error.message}`);process.exitCode=1;});
