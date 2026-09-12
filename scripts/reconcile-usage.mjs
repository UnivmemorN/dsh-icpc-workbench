/** Recompute completed worker ledgers from local durable event logs. Run only with no active worker. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {priceUsage} from './usage.mjs';
const root=resolve(import.meta.dirname,'..'), local=join(root,'.local');
if(existsSync(join(local,'worker.lock')))throw new Error('Wait until worker finishes');
const install=process.env.DSH_INSTALL_ROOT??'D:/DeepSeek Harness/source';
const {lastAssistantStreamChunk}=await import(pathToFileURL(join(install,'packages/llm/llm/lib/index.js')).href);
const path=join(local,'usage.json'), ledger=JSON.parse(readFileSync(path,'utf8'));
for(const run of ledger.runs){
  const log=join(local,run.id+'.jsonl');
  if(!existsSync(log))continue;
  Object.assign(run,{inputTokens:0,outputTokens:0,cacheReadTokens:0,conservativeCny:0,missingUsage:0,settlements:0,compactions:0});
  for(const line of readFileSync(log,'utf8').trim().split(/\r?\n/)){
    if(!line)continue;const n=JSON.parse(line), e=n.params?.event;
    if(n.method!=='session.event'||!e)continue;
    if(!['assistant/message','assistant/attempt','compaction/summary'].includes(e.type))continue;
    if(e.type==='compaction/summary'&&!e.data.llmStreamCall)continue;
    const u=e.data.usage??(e.data.stream?lastAssistantStreamChunk(e.data.stream,'usage')?.usage:undefined);
    const p=priceUsage(u);run.settlements++;
    if(e.type==='compaction/summary')run.compactions++;
    if(!p){run.missingUsage++;run.conservativeCny+=2.36;continue;}
    for(const k of ['inputTokens','outputTokens','cacheReadTokens','conservativeCny'])run[k]+=p[k];
  }
  run.unsettledRequests=Math.max(0,run.requests-run.settlements+run.compactions);
  run.conservativeCny+=run.unsettledRequests*2.36;
  run.accountingVersion=2;
}
ledger.conservativeCny=ledger.runs.reduce((s,r)=>s+r.conservativeCny,0);
writeFileSync(path,JSON.stringify(ledger,null,2)+'\n');
console.log(JSON.stringify({conservativeCny:ledger.conservativeCny,runs:ledger.runs.map(r=>({id:r.id,status:r.status,cny:r.conservativeCny,missing:r.missingUsage}))}));