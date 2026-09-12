/** Local coordinator: one isolated dsh SDK invocation with conservative cost accounting. */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { priceUsage } from './usage.mjs';
import { taskContext } from './worker-context.mjs';
const root = resolve(import.meta.dirname, '..');
const install = resolve(process.env.DSH_INSTALL_ROOT ?? 'D:/DeepSeek Harness/source');
const taskPath = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/worker.mjs <task.json>');
const task = JSON.parse(readFileSync(taskPath, 'utf8'));
const providedContext = taskContext(task, root);
const maxOutputTokens=65536, missingUsageReserveCny=2.63;
const local = join(root, '.local');
mkdirSync(local, {recursive:true});
const lock = join(local, 'worker.lock');
const fd = openSync(lock, 'wx');
writeFileSync(fd, JSON.stringify({pid:process.pid, task:task.id}));
closeSync(fd);
const ledgerFile = join(local, 'usage.json');
let ledger;
try { ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; ledger = {budgetCny:100, stopCny:90, conservativeCny:0, runs:[]}; }
if (ledger.conservativeCny >= ledger.stopCny) { unlinkSync(lock); throw new Error('Construction budget reached'); }
const runId = task.id + '-' + randomUUID().slice(0,8);
const log = join(local, runId+'.jsonl');
const report = {id:runId, task:task.id, startedAt:new Date().toISOString(), model:'deepseek-flash', effort:'max', maxOutputTokens, missingUsageReserveCny, requests:0, settlements:0, inputTokens:0, outputTokens:0, cacheReadTokens:0, conservativeCny:0, missingUsage:0, status:'starting'};
ledger.runs.push(report);
const flush = () => { ledger.conservativeCny = ledger.runs.reduce((s,r)=>s+r.conservativeCny,0); writeFileSync(ledgerFile, JSON.stringify(ledger,null,2)+'\n'); writeFileSync(join(local,'latest.json'),JSON.stringify(report,null,2)+'\n'); };
const load = p => import(pathToFileURL(join(install,p)).href);
const { DeepSeekHarness } = await load('packages/sdk/client/lib/index.js');
const { lastAssistantStreamChunk, joinAssistantStreamText } = await load('packages/llm/llm/lib/index.js');
let harness, timer, stopping=false;
const stop = reason => { if(stopping) return; stopping=true; report.status=reason; flush(); console.log(JSON.stringify({event:'stopping', reason})); void harness?.close(); };
try {
  harness = new DeepSeekHarness({
    dshBin:join(install,'apps/cli/lib/bin.js'), profile:'icpc-builder',
    dshHome:process.env.DSH_HOME ?? 'C:/Users/admin/.dsh',
    processCwd:root, cwd:root, provider:'deepseek-official', model:'deepseek-flash',
    reasoningEffort:'max', maxTokens:maxOutputTokens, initializeTimeoutMs:45000,
    env:{...process.env, DSH_PERMISSION_MODE:task.readOnly?'read-only':'workspace-write', DSH_MAX_TOKENS_AS_SUCCESS:'false'}
  });
  await harness.start();
  console.log(JSON.stringify({event:'ready', task:task.id, model:report.model, effort:report.effort}));
  report.status='running'; flush();
  timer=setTimeout(()=>stop('timeout'),(task.timeoutMinutes??30)*60000);
  const prompt = 'Execute only the assigned Sprint Contract. You are the implementation worker; the coordinator owns review and Git. Do not spawn agents, invoke paid APIs outside ctx.llm, inspect secrets, alter security settings, commit or push. The agreed plan is already approved. If a required permission is unavailable, report the exact blocker; do not bypass it.\n\n'+task.prompt+providedContext;
  const result=await harness.run(prompt, {onNotification:n=>{
    appendFileSync(log,JSON.stringify(n)+'\n');
    if(n.method!=='session.event') return;
    const e=n.params.event;
    if(e.type==='turn/end')report.finishReason=e.data.reason?.kind;
    if(e.type==='step/start'||e.type==='llm/retry-started') {
      report.requests++; flush();
      console.log(JSON.stringify({event:'request',count:report.requests}));
      if(report.requests>(task.maxRequests??40)) stop('request-limit');
    }
    if(e.type==='assistant/message'||e.type==='assistant/attempt'||(e.type==='compaction/summary'&&e.data.llmStreamCall)) {
      const u=e.data.usage??(e.data.stream?lastAssistantStreamChunk(e.data.stream,'usage')?.usage:undefined);
      report.settlements++;
      const priced=priceUsage(u);
      if(priced) {
        for(const k of ['inputTokens','outputTokens','cacheReadTokens','conservativeCny']) report[k]+=priced[k];
      } else { report.missingUsage++; report.conservativeCny+=missingUsageReserveCny; }
      if(e.type==='compaction/summary') report.compactions=(report.compactions??0)+1;
      if(e.type==='assistant/message'){
        const summary=joinAssistantStreamText(e.data.stream);
        console.log(JSON.stringify({event:'assistant', text:summary.slice(0,1500), cny:report.conservativeCny}));
      }
      flush();
      if(ledger.conservativeCny>=ledger.stopCny) stop('budget');
    }
    if(e.type==='tool/call') console.log(JSON.stringify({event:'tool',name:e.data.name??e.data.toolName??'tool'}));
    if(e.type==='approval/request'||e.type==='interaction/request') console.log(JSON.stringify({event:'attention',type:e.type}));
  }});
  report.sessionId=result.sessionId;
  writeFileSync(join(local,runId+'.md'),result.finalResponse+'\n');
  if(!stopping) report.status=report.finishReason==='max-tokens'?'truncated':'returned-awaiting-review';
  console.log(JSON.stringify({event:'result',status:report.status,finalResponse:result.finalResponse,conservativeCny:report.conservativeCny}));
} catch(e) {
  if(!stopping) report.status='error';
  report.error=String(e.message);
  console.error(JSON.stringify({event:'error',message:report.error}));
  process.exitCode=1;
} finally {
  clearTimeout(timer);
  try { await harness?.close(); } catch(e) { report.cleanupError=String(e.message); process.exitCode=1; }
  report.unsettledRequests=Math.max(0,report.requests-report.settlements+(report.compactions??0));
  report.conservativeCny+=report.unsettledRequests*missingUsageReserveCny;
  report.accountingVersion=2;
  report.finishedAt=new Date().toISOString(); flush(); unlinkSync(lock);
}