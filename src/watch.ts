import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UsageEvent } from './types.js';
import { currentWindow } from './window.js';
const exec = promisify(execFile);
export async function notify(message: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      const escaped=message.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/[\r\n]/g,' ');
      await exec('osascript',['-e',`display notification "${escaped}" with title "TokenWatch"`],{timeout:5000});
    } else if (process.platform === 'linux') await exec('notify-send',['--','TokenWatch',message],{timeout:5000});
    else throw new Error('No desktop notification backend');
  } catch {console.log(`[TokenWatch] ${message}`);}
}
export interface WatchOptions { idleMinutes: number; thresholdTokens?: number; thresholdCost?: number }
export class WatchState {
  private sessions = new Map<string,{last:number; notified:boolean}>();
  private windows = new Set<string>();
  private initialized=false;
  check(events:UsageEvent[], options:WatchOptions, now=Date.now()):string[] {
    const messages:string[]=[], latest=new Map<string,UsageEvent>();
    for (const e of events) {
      if (Date.parse(e.timestamp)>now || e.total<=0) continue;
      const key=`${e.source}:${e.session}`, old=latest.get(key);
      if (!old || e.timestamp>old.timestamp) latest.set(key,e);
    }
    for (const [key,e] of latest) {
      const last=Date.parse(e.timestamp), old=this.sessions.get(key);
      if (!old || last>old.last) this.sessions.set(key,{last,notified: !this.initialized && now-last >= options.idleMinutes*60000});
      const state=this.sessions.get(key)!;
      if (!state.notified && now-state.last>=options.idleMinutes*60000) {
        messages.push(`Session ended: ${key} (${e.project}); idle ${options.idleMinutes} minutes`); state.notified=true;
      }
    }
    const window=currentWindow(events,now);
    if (window && !this.windows.has(window.start) && ((options.thresholdTokens !== undefined && window.tokens>=options.thresholdTokens) || (options.thresholdCost !== undefined && window.costUSD>=options.thresholdCost))) {
      messages.push(`Window threshold reached: ${window.tokens} tokens, $${window.costUSD.toFixed(4)}; reset ${window.end}`);
      this.windows.add(window.start);
    }
    this.initialized=true;
    return messages;
  }
}
