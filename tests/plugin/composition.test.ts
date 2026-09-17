import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import type {ConnectionFetchRoute} from '@deepseek-ai/dsh-client-connection';
import {activateHost,resolveHarnessHome,type ActivationEnvironment,type PublicHost} from '../../src/plugin/index.js';
import {ModelCatalog} from '../../src/plugin/model-catalog.js';
import {SqliteTrainingStore} from '../../src/adapters/sqlite/index.js';
import {createLuoguAccount,luoguSourceInstance} from '../../src/adapters/luogu/index.js';
import type {FetchLike} from '../../src/adapters/platform/http.js';
import {problemKey} from '../../src/domain/index.js';
import {GuidanceMethodRegistry} from '../../src/adapters/guidance/index.js';
import * as balanced from '../../packages/dsh-icpc-method-balanced/index.js';
import {defaultWorkbenchSettings} from '../../src/application/workbench-settings.js';
import {createCancellationSource} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';
import * as sfx from '../sync/fixtures.js';

function fixture(luogu?:ActivationEnvironment['luogu']) {
 const temp=fx.tempDatabase(),hostDir=join(temp.dir,'host'),dataDir=join(temp.dir,'training');
 mkdirSync(hostDir);writeFileSync(join(hostDir,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1.5-rc.2'}));
 const launcherPath=join(hostDir,'bin.js');writeFileSync(launcherPath,'// fixture');
 const routes=new Map<string,ConnectionFetchRoute>();let calls=0,failAt=Infinity,failPath:((path:string)=>boolean)|null=null;
 const host={connection:{fetch:{register(route:ConnectionFetchRoute){if(routes.size===failAt||failPath?.(route.path)===true)throw Error('injected registration failure');routes.set(route.path,route);return async()=>{await Promise.resolve();routes.delete(route.path);};}}},
  llm:{listProviders:()=>[{id:'deepseek-official',name:'DeepSeek'}],listModels:async(provider:string)=>[{id:'deepseek-flash',provider,name:'Flash'}],
   resolveModelInfo:async(provider:string,id:string)=>({provider,id,name:id,inputModalities:['text'],context:{contextWindow:1_000_000},defaultMaxTokens:1024,reasoning:{efforts:[{id:'max',name:'Max'}]}}),
   async *stream(){calls++;throw Error('unexpected paid call');}},
  sessionPersistence:{create(){calls++;throw Error('unexpected persistence creation');}},
  sessions:{prepare(){calls++;throw Error('unexpected audit session');},create(){calls++;throw Error('unexpected audit session');},flush:async()=>{calls++;return true;}}} as unknown as PublicHost;
 const environment={nodeVersion:'24.15.0',launcherPath,dshHome:join(temp.dir,'dsh-home'),...(luogu===undefined?{}:{luogu})};
 return {temp,host,dataDir,environment,routes,calls:()=>calls,setFailure:(n:number)=>{failAt=n;},setFailurePath:(predicate:(path:string)=>boolean)=>{failPath=predicate;},
  async call(operation:string,value?:unknown){const route=routes.get('/api/icpc/v1/'+operation)!;assert.ok(route,'registered route '+operation);const response=await route.fetch(new Request('http://localhost/api/icpc/v1/'+operation,value===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}));return {status:response.status,body:await response.json() as any};},
  remove:()=>fx.removeDirectory(temp.dir)};
}
test('host composition keeps activation free, persists settings/accounts and creates a restorable backup',async()=>{
 const f=fixture();let runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
 try {
  assert.equal(f.calls(),0);assert.equal(f.routes.size,74); // 24 free business + 13 typed Luogu + 18 model/bootstrap + 6 bulk material refresh + 3 virtual-performance + 6 assessment + 1 guidance + 3 bootstrap operations.
  // The six durable ability-assessment routes are part of that count, so a registration regression
  // cannot hide behind a coincidentally unchanged total somewhere else.
  for(const operation of ['retro.list','retro.editPreview','retro.editApply','assessment.config','assessment.prepare','assessment.run','assessment.status','assessment.cancel','assessment.history'])assert.ok(f.routes.has('/api/icpc/v1/'+operation),'assessment route '+operation+' must be registered');
  // The six Sprint 34A bulk material-refresh routes are named too: each one is a real typed operation,
  // so a dropped registration cannot be absorbed by another stage's route count.
  for(const operation of ['material.prepare','material.start','material.detail','material.list','material.cancel','material.retryFailed'])assert.ok(f.routes.has('/api/icpc/v1/'+operation),'bulk material route '+operation+' must be registered');
  for (const operation of ['luogu.metadataBacklog', 'luogu.retryMetadata', 'luogu.supplementMetadata', 'luogu.managedProblems', 'luogu.manageProblems']) assert.ok(f.routes.has('/api/icpc/v1/' + operation), 'recovery route ' + operation + ' must be registered');
  assert.ok(f.routes.has('/api/icpc/v1/luogu.profile'),'the anonymous public-profile route must be registered');
  const boot=await f.call('bootstrap');assert.equal(boot.status,200);assert.equal(boot.body.value.settings.revision,1);assert.equal(boot.body.value.sources.length,2);assert.equal(boot.body.value.hydro.implemented,false);assert.equal(boot.body.value.hostVersion,'0.1.5-rc.2');
  assert.equal(f.calls(),0);
  const account=await f.call('account.create',{platform:'codeforces',handle:'Tourist'});assert.equal(account.status,200);
  const settings=defaultWorkbenchSettings();const saved=await f.call('settings.save',{expectedRevision:1,value:{...settings,coaching:{...settings.coaching,maxCallsPer24Hours:8}}});assert.equal(saved.status,200);
  const backup=await f.call('backup',{});assert.equal(backup.status,200);assert.ok(existsSync(backup.body.value.path));
  const restored=new SqliteTrainingStore({path:backup.body.value.path,now:()=>fx.AT});try{assert.equal((await restored.listAccounts(null)).length,1);assert.equal((await restored.getWorkbenchSettings())?.revision,2);}finally{await restored.close();}
  await runtime.dispose();assert.equal(f.routes.size,0);
  runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
  const reboot=await f.call('bootstrap');assert.equal(reboot.body.value.settings.revision,2);assert.equal(reboot.body.value.settings.value.coaching.maxCallsPer24Hours,8);assert.equal(reboot.body.value.accounts.length,1);assert.equal(f.calls(),0);
 }finally{await runtime.dispose();f.remove();}
});
test('incompatible host and shared data directory are refused before creating plugin data',async()=>{
 const f=fixture();try {
  await assert.rejects(()=>activateHost(f.host,{dataDir:f.dataDir},{...f.environment,nodeVersion:'23.0.0'}));assert.equal(existsSync(f.dataDir),false);
  await assert.rejects(()=>activateHost(f.host,{dataDir:join(f.environment.dshHome,'training')},f.environment));assert.equal(existsSync(f.environment.dshHome),false);assert.equal(f.routes.size,0);assert.equal(f.calls(),0);
 }finally{f.remove();}
});
test('partial activation unregisters all routes and releases the database',async()=>{
 const f=fixture();f.setFailure(20);try {
  await assert.rejects(()=>activateHost(f.host,{dataDir:f.dataDir},f.environment),/injected registration failure/);assert.equal(f.routes.size,0);
  const store=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>fx.AT});try{assert.equal((await store.getWorkbenchSettings())?.revision,1);}finally{await store.close();}
 }finally{f.remove();}
});
test('missing provider keeps import/bootstrap alive while paid starts are unavailable',async()=>{
 const f=fixture();f.host.llm.listProviders=()=>[];const runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
 try {const boot=await f.call('bootstrap');assert.equal(boot.status,200);assert.equal(boot.body.value.modelDiagnostics[0].code,'provider_missing');assert.ok(f.routes.has('/api/icpc/v1/import.apply'));assert.equal(f.calls(),0);}
 finally{await runtime.dispose();f.remove();}
});
test('catalog treats custom models as advisory and default output as no hard cap',async()=>{
 const f=fixture();try {
  const catalog=new ModelCatalog(f.host.llm),token=createCancellationSource().token,defaults=defaultWorkbenchSettings();
  const custom={...defaults,roles:{...defaults.roles,analysisModel:'opaque-custom-model'}};
  assert.equal((await catalog.validate(custom,token)).filter(d=>d.severity==='error').length,0);
  f.host.llm.resolveModelInfo=async(provider,id)=>({provider,id,name:id,inputModalities:['image']});
  assert.ok((await catalog.validate(defaults,token)).some(d=>d.code==='text_unsupported'));
  f.host.llm.listModels=async()=>{throw Error('PRIVATE PROVIDER ERROR');};
  const failure=await catalog.list('deepseek-official',token);assert.equal(failure.diagnostics[0]?.code,'catalog_unavailable');assert.equal(JSON.stringify(failure).includes('PRIVATE PROVIDER ERROR'),false);
 }finally{f.remove();}
});
test('catalog timeout and cancellation remain bounded when host ignores abort',async()=>{
 const f=fixture();try {
  f.host.llm.listModels=async()=>new Promise(()=>{});const catalog=new ModelCatalog(f.host.llm,10),token=createCancellationSource();
  const result=await catalog.list('deepseek-official',token.token);assert.equal(result.diagnostics[0]?.code,'catalog_unavailable');
  const pending=catalog.list('deepseek-official',token.token);token.cancel('test');await assert.rejects(pending);
 }finally{f.remove();}
});
test('harness home defaults and tilde expansion match the baseline path policy',()=>{
 const home=join(process.cwd(),'example-home');assert.equal(resolveHarnessHome('  ',home),join(home,'.dsh'));assert.equal(resolveHarnessHome('~',home),home);assert.equal(resolveHarnessHome('~/custom',home),join(home,'custom'));assert.equal(resolveHarnessHome('~\\custom',home),join(home,'custom'));
});
test('host activation recovers an expired AI plan reservation before any route serves a start',async()=>{
 const f=fixture();
 const scope=fx.makeScope('codeforces','codeforces.com','alice','1A');
 // Seed the plugin data directory directly: one source instance, one account and two unsolved
 // problems are all a free AI preparation needs, and no model call is involved anywhere below.
 mkdirSync(f.dataDir,{recursive:true});
 const seed=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>fx.AT});
 await seed.upsertSourceInstances([scope.instance]);
 await seed.upsertAccounts([scope.account]);
 await seed.upsertProblems([scope.problem,fx.makeProblem(fx.makeRef(scope.instance,'2B'))]);
 await seed.close();
 let runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
 try {
  const prepared=await f.call('plan.aiPrepare',{requestId:'restart-1',accountId:scope.account.id});
  assert.equal(prepared.status,200);assert.equal(prepared.body.value.outcome,'prepared');
  assert.equal(f.calls(),0);
  await runtime.dispose();
  // The durable state a process that died mid-reservation leaves behind: a `reserved` attempt whose
  // lease is already in the past relative to the real clock activation reads.
  const admin=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>new Date().toISOString()});
  const row=await admin.getPlanAttempt('restart-1');assert.ok(row);
  const nowMs=Date.now();
  await admin.savePlanAttempt({...row,status:'reserved',requestedAt:new Date(nowMs-120_000).toISOString(),expiresAt:new Date(nowMs-60_000).toISOString()});
  await admin.close();
  runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
  const status=await f.call('plan.aiStatus',{requestId:'restart-1',accountId:scope.account.id});
  assert.equal(status.status,200);
  assert.equal(status.body.value.status,'found');
  assert.equal(status.body.value.attempt.status,'uncertain'); // recovered on startup, never live
  assert.equal(status.body.value.operation,null); // the new controller instance owns no run for it
  assert.equal(status.body.value.plan,null);
  assert.equal(f.calls(),0);
 }finally{await runtime.dispose();f.remove();}
});
test('activation migrates legacy models once, preserves limits, and rejects non-Flash settings',async()=>{
 const f=fixture();mkdirSync(f.dataDir,{recursive:true});
 const seed=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>fx.AT});
 const original=defaultWorkbenchSettings();
 const legacy={...original,provider:'legacy-provider',roles:{...original.roles,reasoningModel:'deepseek-v4-pro',analysisModel:'legacy-analysis'},modelLimits:{...original.modelLimits,maxAnalysisCalls:7},coaching:{...original.coaching,model:'legacy-coaching',maxCallsPer24Hours:4}};
 await seed.saveWorkbenchSettings(legacy,null);await seed.close();
 let runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
 try {
  const boot=await f.call('bootstrap');const settings=boot.body.value.settings;
  assert.equal(settings.revision,2);assert.equal(settings.value.provider,'deepseek-official');
  for(const field of ['analysisModel','verificationModel','reasoningModel'])assert.equal(settings.value.roles[field],'deepseek-flash');
  assert.equal(settings.value.coaching.model,'deepseek-flash');assert.equal(settings.value.modelLimits.maxAnalysisCalls,7);assert.equal(settings.value.coaching.maxCallsPer24Hours,4);
  for(const field of ['analysisModel','verificationModel','reasoningModel']){
   const bad=structuredClone(settings.value);bad.roles[field]='deepseek-v4-pro';
   assert.equal((await f.call('settings.save',{expectedRevision:2,value:bad})).status,400);
  }
  const badCoach=structuredClone(settings.value);badCoach.coaching.model='custom-model';assert.equal((await f.call('settings.save',{expectedRevision:2,value:badCoach})).status,400);
  const badProvider=structuredClone(settings.value);badProvider.provider='legacy-provider';assert.equal((await f.call('settings.save',{expectedRevision:2,value:badProvider})).status,400);
  assert.equal((await f.call('bootstrap')).body.value.settings.revision,2);assert.equal(f.calls(),0);
  await runtime.dispose();runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
  assert.equal((await f.call('bootstrap')).body.value.settings.revision,2);assert.equal(f.calls(),0);
 }finally{await runtime.dispose();f.remove();}
});

/** Synthetic interval seam: records every schedule so a test can prove it was stopped. */
function timerSeam(){
 const entries:{callback:()=>void;intervalMs:number;stopped:boolean;stop:()=>void}[]=[];
 const interval=(callback:()=>void,ms:number)=>{const entry={callback,intervalMs:ms,stopped:false,stop:()=>{entry.stopped=true;}};entries.push(entry);return entry.stop;};
 return {entries,interval};
}
/** Poll an async condition while letting timers and IO settle. */
async function waitFor(predicate:()=>Promise<boolean>,label:string,limit=5000):Promise<void>{
 for(let index=0;index<limit;index+=1){if(await predicate())return;await new Promise<void>(resolve=>{setImmediate(resolve);});}
 throw new Error('condition was not reached: '+label);
}
test('the luogu host recovers durable state, keeps defaults offline and owns its timer',async()=>{
 const clock=sfx.createClock(),waits=sfx.createWait(),feed=sfx.createRecordFeed(),vault=sfx.createMemoryVault(),timers=timerSeam();
 const f=fixture({vault,now:clock.now,nowMs:clock.nowMs,wait:waits.wait,tickIntervalMs:1000,setInterval:timers.interval,
  transport:{fetchImpl:feed.fetchImpl,clock:clock.nowMs,wait:waits.wait,setTimer:sfx.neverFireTimer}});
 mkdirSync(f.dataDir,{recursive:true});
 const instance=luoguSourceInstance(),account=createLuoguAccount(instance,'800001');
 const seed=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>sfx.START});
 await seed.upsertSourceInstances([instance]);await seed.upsertAccounts([account]);await seed.close();
 const runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
 try {
  assert.equal(f.routes.size,74);
  assert.equal(feed.calls.length,0,'default automation must not contact the platform on startup');
  assert.equal(timers.entries.length,1,'exactly one owned periodic timer');
  assert.equal(timers.entries[0]?.intervalMs,1000);
  assert.equal(timers.entries[0]?.stopped,false);
  const status=await f.call('luogu.status',{accountId:account.id});
  assert.equal(status.status,200);
  assert.equal(status.body.value.settings.automaticEnabled,false);
  assert.equal(status.body.value.settingsRevision,1,'recovery materialized the contract defaults');
  assert.equal(status.body.value.phase,'backfill');
  assert.equal(status.body.value.connectionAvailable,vault.capabilities().implemented);
  assert.equal(status.body.value.connectionPlatform,vault.capabilities().platform);
  assert.equal(f.calls(),0);
 }finally{await runtime.dispose();}
 assert.equal(timers.entries[0]?.stopped,true,'disposal stops the owned timer');
 assert.equal(f.routes.size,0,'disposal removes every route');
 const inspect=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>sfx.START});
 try {
  assert.equal((await inspect.getLuoguSyncSettings(account.id))?.value.automaticEnabled,false);
  assert.equal((await inspect.getLuoguSyncState(account.id))?.value.phase,'backfill');
 }finally{await inspect.close();}
 f.remove();
});
test('an enabled runOnStartup account syncs through the injected transport and metadata source',async()=>{
 const clock=sfx.createClock(),waits=sfx.createWait(),vault=sfx.createMemoryVault(),timers=timerSeam();
 const feed=sfx.createRecordFeed(new Map([['800001',sfx.toPages(sfx.buildRecords(60,['P1001','P1002']),50)]]));
 const metadata=sfx.createMetadataAdapter(luoguSourceInstance(),clock.now);
 const f=fixture({vault,now:clock.now,nowMs:clock.nowMs,wait:waits.wait,tickIntervalMs:1000,setInterval:timers.interval,
  transport:{fetchImpl:feed.fetchImpl,clock:clock.nowMs,wait:waits.wait,setTimer:sfx.neverFireTimer},metadataSource:metadata.adapter});
 mkdirSync(f.dataDir,{recursive:true});
 const instance=luoguSourceInstance(),account=createLuoguAccount(instance,'800001'),reference='luogu.session.seeded-1';
 vault.secrets.set(reference,sfx.cookieFor('800001'));
 const seed=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>clock.now()});
 await seed.upsertSourceInstances([instance]);await seed.upsertAccounts([account]);
 await seed.saveLuoguSyncSettings({accountId:account.id,automaticEnabled:true,runOnStartup:true,intervalMinutes:30,updatedAt:clock.now()},null);
 await seed.saveLuoguConnection({accountId:account.id,sourceInstanceId:instance.id,reference,status:'connected',connectedAt:clock.now(),checkedAt:clock.now(),failureCode:null,staleReference:null},null);
 await seed.close();
 const runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
 try {
  await waitFor(async()=>{const view=await f.call('luogu.status',{accountId:account.id});return view.body.value.phase==='incremental';},'the startup pass to complete');
  const status=await f.call('luogu.status',{accountId:account.id});
  assert.equal(status.body.value.historyComplete,true);
  assert.equal(status.body.value.submissionsSeen,60);
  assert.equal(status.body.value.connection.status,'connected');
  assert.ok(feed.calls.length>0,'the authenticated reader really called the injected transport');
  assert.deepEqual(metadata.calls.sort(),['P1001','P1002'],'metadata repair uses the injected anonymous source');
  assert.equal(metadata.editorialCalls(),0,'the sync path never requests editorial material');
  assert.equal(f.calls(),0,'no model call is made anywhere in this slice');
 }finally{await runtime.dispose();}
 assert.equal(timers.entries[0]?.stopped,true);
 assert.equal(f.routes.size,0);
 f.remove();
});
test('a failed route registration rolls the luogu host back without leaving routes or timers',async()=>{
 const clock=sfx.createClock(),waits=sfx.createWait(),vault=sfx.createMemoryVault(),timers=timerSeam();
 const f=fixture({vault,now:clock.now,nowMs:clock.nowMs,wait:waits.wait,tickIntervalMs:1000,setInterval:timers.interval});
 f.setFailure(45); // A registration failure after the Luogu host already started and owned its timer.
 try {
  await assert.rejects(()=>activateHost(f.host,{dataDir:f.dataDir},f.environment),/injected registration failure/);
  assert.equal(f.routes.size,0);
  assert.equal(timers.entries.length,1);
  assert.equal(timers.entries[0]?.stopped,true,'rollback stops the owned timer');
 }finally{f.remove();}
});
test('a failed bulk material-refresh registration removes its routes and closes the service',async()=>{
 // The service is created, recovered and given a disposer *before* its API registration (route-first
 // disposal), so a failure while registering the very first material route must roll back through that
 // already-registered service disposer: no route is left behind and the database is still openable.
 const f=fixture();
 f.setFailurePath(path=>path.endsWith('/material.prepare'));
 try {
  await assert.rejects(()=>activateHost(f.host,{dataDir:f.dataDir},f.environment),/injected registration failure/);
  assert.equal(f.routes.size,0);
  assert.equal(f.routes.has('/api/icpc/v1/material.start'),false);
  const store=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>fx.AT});
  try{assert.deepEqual(await store.listMaterialRefreshBatches(null),[]);}finally{await store.close();}
 }finally{f.remove();}
});
test('an unsupported credential platform keeps bootstrap and the free business routes alive',async()=>{
 const vault=sfx.createMemoryVault({implemented:false,platform:'linux'});
 const f=fixture({vault});
 const runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
 try {
  const boot=await f.call('bootstrap');assert.equal(boot.status,200);assert.equal(boot.body.value.sources.length,2);
  assert.ok(f.routes.has('/api/icpc/v1/import.apply'),'free business routes stay registered');
  const created=await f.call('account.create',{platform:'luogu',handle:'800001'});assert.equal(created.status,200);
  const accountId=created.body.value.account.id;
  const status=await f.call('luogu.status',{accountId});
  assert.equal(status.status,200);
  assert.equal(status.body.value.connectionAvailable,false);
  assert.equal(status.body.value.connectionPlatform,'linux');
  const refused=await f.call('luogu.connect',{accountId,sessionCookie:'_uid=800001; __client_id=opaque'});
  assert.equal(refused.status,409);
  assert.match(refused.body.error.message,/安全凭据存储/);
  assert.equal(f.calls(),0);
 }finally{await runtime.dispose();f.remove();}
});
/**
 * A synthetic Luogu surface for the production composition: the anonymous problem statement, the
 * authenticated solution surface (really paginated) and the authenticated record list.
 *
 * Every response is an in-process object; nothing here can reach the network, and no real credential,
 * cookie or session is involved. `pages` records the `page` parameter of every solution request — the
 * first page must have none — so a test can prove the production reader really paged, and `at` records
 * the synthetic clock instant of every request, so a test can prove the source-wide floor holds across
 * the two *different* transports the composition uses (the business adapter's anonymous transport and
 * the account reader's transport).
 */
function luoguMaterialSurface(options:{readonly pid:string;readonly total:number;readonly perPage:number}){
 const pages:(number|null)[]=[];
 const paths:string[]=[];
 const calls:{readonly path:string;readonly page:number|null;readonly at:number}[]=[];
 let nowMs:()=>number=()=>0;
 const fetchImpl:FetchLike=async(url)=>{
  const parsed=new URL(url);
  paths.push(parsed.pathname);
  const raw=parsed.searchParams.get('page');
  calls.push({path:parsed.pathname,page:raw===null?null:Number(raw),at:nowMs()});
  if(parsed.pathname===`/problem/${options.pid}`){
   return sfx.jsonResponse({status:200,data:{problem:{pid:options.pid,type:'P',name:'Synthetic problem',
    difficulty:1,tags:[],content:{name:'Synthetic problem',description:'Given n, print n.',formatI:'One integer n.',
    formatO:'One integer.',hint:null},samples:[['1','1']],limits:{time:[1000],memory:[262144]}}}});}
  if(parsed.pathname===`/problem/solution/${options.pid}`){
   const page=raw===null?1:Number(raw);
   pages.push(raw===null?null:page);
   const start=(page-1)*options.perPage;
   const length=Math.min(options.perPage,Math.max(0,options.total-start));
   const result=Array.from({length},(_,index)=>({lid:`lid-${start+index}`,title:`SYNTHETIC_SOLUTION_${start+index}`,
    category:1,time:1_700_000_000,author:{uid:1,name:'synthetic-author'},upvote:1,replyCount:0,favorCount:0,status:2,
    solutionFor:{pid:options.pid,type:'P'},content:`SYNTHETIC_BODY_${start+index}`,contentFull:true}));
   return sfx.jsonResponse({status:200,data:{solutions:{perPage:options.perPage,count:options.total,result},
    problem:{pid:options.pid,type:'P',name:'Synthetic problem'},acceptSolution:false},user:{uid:1,name:'viewer'}});}
  throw new Error('the production composition must not request '+parsed.pathname);
 };
 return {fetchImpl,pages,paths,calls,setClock:(read:()=>number)=>{nowMs=read;}};
}

test('the production composition reads paged solution material through the host session reader',async()=>{
 const clock=sfx.createClock(),waits=sfx.createWait(),vault=sfx.createMemoryVault(),timers=timerSeam();
 const instance=luoguSourceInstance(),pid='P1001';
 const surface=luoguMaterialSurface({pid,total:56,perPage:10});
 // The gate and the transports share this one clock, and every paced wait advances it, so a recorded
 // request instant measures the real spacing between whole operations.
 const advancingWait=async(ms:number,token:Parameters<typeof waits.wait>[1]):Promise<void>=>{await waits.wait(ms,token);clock.advance(ms);};
 surface.setClock(clock.nowMs);
 const f=fixture({vault,now:clock.now,nowMs:clock.nowMs,wait:advancingWait,tickIntervalMs:1000,setInterval:timers.interval,
  transport:{fetchImpl:surface.fetchImpl,clock:clock.nowMs,wait:advancingWait,setTimer:sfx.neverFireTimer},
  anonymousTransport:{fetchImpl:surface.fetchImpl,clock:clock.nowMs,wait:advancingWait,setTimer:sfx.neverFireTimer}});
 mkdirSync(f.dataDir,{recursive:true});
 // Seed the durable shape a real connection leaves behind: the account, its connected session row and
 // the stored problem the refresh targets. The cookie itself lives only in the synthetic vault.
 const account=createLuoguAccount(instance,'800001'),reference='luogu.session.material-1';
 vault.secrets.set(reference,sfx.cookieFor('800001'));
 const problem=fx.makeProblem(fx.makeRef(instance,pid));
 const seed=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>clock.now()});
 await seed.upsertSourceInstances([instance]);await seed.upsertAccounts([account]);await seed.upsertProblems([problem]);
 await seed.saveLuoguConnection({accountId:account.id,sourceInstanceId:instance.id,reference,status:'connected',
  connectedAt:clock.now(),checkedAt:clock.now(),failureCode:null,staleReference:null},null);
 await seed.close();
 // The guard goes up **before** activation: every transport this activation builds (including a default
 // one that would capture `globalThis.fetch` at construction) must be the injected synthetic one, so a
 // missing seam fails the case instead of quietly reaching the platform. The runtime stays nullable
 // because activation itself is what the guard has to cover.
 const realFetch=globalThis.fetch;
 globalThis.fetch=(()=>{throw new Error('ICPC_TEST_NETWORK_FORBIDDEN');}) as typeof globalThis.fetch;
 let runtime:Awaited<ReturnType<typeof activateHost>>|null=null;
 try {
  runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
  // The capability the whole revision exists for: the *business* Luogu adapter really reports the
  // submissions and editorial support this composition has, instead of a session it cannot reach.
  const boot=await f.call('bootstrap');
  assert.equal(boot.status,200);
  const luogu=boot.body.value.adapters.find((entry:any)=>entry.sourceInstanceId===instance.id);
  assert.ok(luogu,'the Luogu adapter must be advertised');
  assert.equal(luogu.capabilities.submissions,true,'the business adapter advertises submissions');
  assert.equal(luogu.capabilities.editorial,true,'the business adapter advertises editorial material');

  const refreshed=await f.call('material.refresh',{problemKey:problem.key,fetchStatement:true,accountId:account.id});
  assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));
  const value=refreshed.body.value;
  assert.equal(value.editorial.attempted,true);
  assert.equal(value.editorial.status,'found');
  assert.equal(value.editorial.sourceCount,56,'every write-up of every page is stored');
  assert.equal(value.editorial.solutionCount,56);
  assert.equal(value.statement.status,'fetched',JSON.stringify(value.statement.failure));
  // The statement came from the anonymous metadata adapter and the material from the authenticated
  // reader: one statement request, six solution pages (the first without a query), whole answer stored.
  assert.deepEqual(surface.pages,[null,2,3,4,5,6]);
  assert.equal(surface.paths.filter(path=>path===`/problem/${pid}`).length,1,JSON.stringify(surface.paths));
  // Every business operation ran on the host's source gate, across two *different* transports: the
  // anonymous statement read and the authenticated solution read are one whole gated operation each, so
  // the first solution request starts at the source floor after the statement operation ended — the
  // anonymous transport's own pacing could never produce that gap. The six pages inside the solution
  // operation are paced by its transport (the gate is not re-entered per page).
  const statement=surface.calls.find(call=>call.path===`/problem/${pid}`);
  const solutions=surface.calls.filter(call=>call.path===`/problem/solution/${pid}`);
  assert.ok(statement&&solutions.length===6);
  const firstSolution=solutions[0]!;
  assert.equal(firstSolution.at-statement.at>=2000,true,
   `the source gate must separate the statement and solution operations: ${JSON.stringify(surface.calls)}`);
  const pageGaps=solutions.slice(1).map((call,index)=>call.at-(solutions[index]?.at??0));
  assert.equal(pageGaps.every(gap=>gap>=2000),true,JSON.stringify(surface.calls));
  assert.equal(value.snapshot.sourceCount,56);
  assert.equal(value.snapshot.solutionCount,56);
  // The response is a status projection: no retrieved body may appear in it.
  assert.equal(JSON.stringify(value).includes('SYNTHETIC_BODY'),false);
  assert.equal(JSON.stringify(value).includes('synthetic-author'),false);
  // And the stored snapshot really holds the bodies, one per write-up.
  const inspect=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>clock.now()});
  try {
   const head=await inspect.getCurrentSnapshotHead(problem.ref);
   assert.ok(head);
   const snapshot=await inspect.getSnapshot(head.snapshotId);
   assert.ok(snapshot);
   assert.equal(snapshot.solutions.length,56);
   assert.equal(snapshot.solutions.some(solution=>solution.text==='SYNTHETIC_BODY_55'),true,'the last page is stored');
   assert.equal(snapshot.solutions.filter(solution=>solution.text.startsWith('SYNTHETIC_BODY_')).length,56);
   assert.equal(snapshot.sources.length,56);
   assert.equal(snapshot.sources.some(source=>source.title==='SYNTHETIC_SOLUTION_55'),true);
   assert.equal(snapshot.sources.filter(source=>source.author==='synthetic-author').length,56);
   assert.equal(snapshot.sources.every(source=>source.publishedAt===null&&source.language===null),true);
   // Every source is the problem's own solution list, addressed by pid, and every write-up has its own
   // source: one source per write-up is what the revision stores instead of one page-wide source.
   assert.equal(snapshot.sources.every(source=>source.url===`https://www.luogu.com.cn/problem/solution/${pid}`),true);
   assert.equal(new Set(snapshot.sources.map(source=>source.id)).size,56);
   assert.equal(snapshot.solutions.every(solution=>snapshot.sources.some(source=>source.id===solution.sourceId)),true);
  }finally{await inspect.close();}
  assert.equal(f.calls(),0,'no model call is made anywhere in this slice');
 }finally{
  // Dispose first, then restore — and restore unconditionally: a disposal that throws must not leave
  // the process with a refusing global fetch or a temporary directory behind.
  try{
   if(runtime!==null)await runtime.dispose();
  }finally{
   globalThis.fetch=realFetch;
   f.remove();
  }
 }
});
test('the source gate serializes business reads across accounts',async()=>{
 // Two accounts of one source, each with its own stored session and its own reader transport. Both
 // business reads must run as whole gated operations of the *same* source: no request of the second
 // read may start within the floor of the first read's last request, whatever transport it uses.
 const clock=sfx.createClock(),waits=sfx.createWait(),vault=sfx.createMemoryVault(),timers=timerSeam();
 const instance=luoguSourceInstance(),pid='P1001';
 const surface=luoguMaterialSurface({pid,total:3,perPage:10});
 const advancingWait=async(ms:number,token:Parameters<typeof waits.wait>[1]):Promise<void>=>{await waits.wait(ms,token);clock.advance(ms);};
 surface.setClock(clock.nowMs);
 const f=fixture({vault,now:clock.now,nowMs:clock.nowMs,wait:advancingWait,tickIntervalMs:1000,setInterval:timers.interval,
  transport:{fetchImpl:surface.fetchImpl,clock:clock.nowMs,wait:advancingWait,setTimer:sfx.neverFireTimer},
  anonymousTransport:{fetchImpl:surface.fetchImpl,clock:clock.nowMs,wait:advancingWait,setTimer:sfx.neverFireTimer}});
 mkdirSync(f.dataDir,{recursive:true});
 const first=createLuoguAccount(instance,'800001'),second=createLuoguAccount(instance,'800002');
 vault.secrets.set('luogu.session.a',sfx.cookieFor('800001'));
 vault.secrets.set('luogu.session.b',sfx.cookieFor('800002'));
 const problem=fx.makeProblem(fx.makeRef(instance,pid));
 const seed=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>clock.now()});
 await seed.upsertSourceInstances([instance]);await seed.upsertAccounts([first,second]);await seed.upsertProblems([problem]);
 await seed.saveLuoguConnection({accountId:first.id,sourceInstanceId:instance.id,reference:'luogu.session.a',status:'connected',
  connectedAt:clock.now(),checkedAt:clock.now(),failureCode:null,staleReference:null},null);
 await seed.saveLuoguConnection({accountId:second.id,sourceInstanceId:instance.id,reference:'luogu.session.b',status:'connected',
  connectedAt:clock.now(),checkedAt:clock.now(),failureCode:null,staleReference:null},null);
 await seed.close();
 const realFetch=globalThis.fetch;
 globalThis.fetch=(()=>{throw new Error('ICPC_TEST_NETWORK_FORBIDDEN');}) as typeof globalThis.fetch;
 let runtime:Awaited<ReturnType<typeof activateHost>>|null=null;
 try {
  runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
  for(const account of [first,second]){
   const refreshed=await f.call('material.refresh',{problemKey:problem.key,fetchStatement:true,accountId:account.id});
   assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));
   assert.equal(refreshed.body.value.editorial.status,'found',account.handle);
   assert.equal(refreshed.body.value.editorial.solutionCount,3,account.handle);
  }
  // The recorded sequence is: statement(A), solutions(A), statement(B), solutions(B). Every gap is at
  // least the source floor — an ungated read would dispatch its first request at the same instant as the
  // previous operation's last one, because the two operations use different transports.
  const calls=surface.calls;
  assert.deepEqual(calls.map(call=>call.path),[`/problem/${pid}`,`/problem/solution/${pid}`,`/problem/${pid}`,`/problem/solution/${pid}`]);
  for(let index=1;index<calls.length;index+=1){
   const gap=(calls[index]?.at??0)-(calls[index-1]?.at??0);
   assert.equal(gap>=2000,true,`gap ${String(index)} was ${String(gap)} ms: ${JSON.stringify(calls)}`);
  }
  assert.equal(f.calls(),0);
 }finally{
  // Dispose first, then restore unconditionally: a throwing disposal must not leave the refusing guard
  // or the temporary directory behind.
  try{
   if(runtime!==null)await runtime.dispose();
  }finally{
   globalThis.fetch=realFetch;
   f.remove();
  }
 }
});
test('an enabled startup sync repairs metadata through the default anonymous transport seam',async()=>{
 // The host's *default* anonymous metadata source — the adapter a `runOnStartup` pass repairs missing
 // problem metadata with — must also run on the injected transport. The seam is not passed as
 // `metadataSource` here, so this case fails if that adapter is built without it (the refusing global
 // fetch below would reject the repair instead of the synthetic surface answering it).
 const clock=sfx.createClock(),waits=sfx.createWait(),vault=sfx.createMemoryVault(),timers=timerSeam();
 const instance=luoguSourceInstance(),pid='P1001';
 const surface=luoguMaterialSurface({pid,total:1,perPage:10});
 const feed=sfx.createRecordFeed(new Map([['800001',sfx.toPages(sfx.buildRecords(3,[pid]),50)]]));
 const routedFetch:FetchLike=async(url,init)=>{
  const path=new URL(url).pathname;
  return path==='/record/list'?feed.fetchImpl(url,init):surface.fetchImpl(url,init);
 };
 const f=fixture({vault,now:clock.now,nowMs:clock.nowMs,wait:waits.wait,tickIntervalMs:1000,setInterval:timers.interval,
  transport:{fetchImpl:routedFetch,clock:clock.nowMs,wait:waits.wait,setTimer:sfx.neverFireTimer},
  anonymousTransport:{fetchImpl:routedFetch,clock:clock.nowMs,wait:waits.wait,setTimer:sfx.neverFireTimer}});
 mkdirSync(f.dataDir,{recursive:true});
 const account=createLuoguAccount(instance,'800001');
 vault.secrets.set('luogu.session.startup',sfx.cookieFor('800001'));
 const seed=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>clock.now()});
 await seed.upsertSourceInstances([instance]);await seed.upsertAccounts([account]);
 await seed.saveLuoguSyncSettings({accountId:account.id,automaticEnabled:true,runOnStartup:true,intervalMinutes:30,updatedAt:clock.now()},null);
 await seed.saveLuoguConnection({accountId:account.id,sourceInstanceId:instance.id,reference:'luogu.session.startup',status:'connected',
  connectedAt:clock.now(),checkedAt:clock.now(),failureCode:null,staleReference:null},null);
 await seed.close();
 const realFetch=globalThis.fetch;
 globalThis.fetch=(()=>{throw new Error('ICPC_TEST_NETWORK_FORBIDDEN');}) as typeof globalThis.fetch;
 let runtime:Awaited<ReturnType<typeof activateHost>>|null=null;
 try {
  runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
  // The startup sweep runs before activation returns; wait for the pass to reach its incremental phase
  // **and** to drain the metadata backlog it queued. Waiting for the backlog as well is what makes the
  // assertions below read a committed repair: the phase alone flips when the history page commits,
  // while the per-key metadata write that follows it is still in flight.
  await waitFor(async()=>{const view=await f.call('luogu.status',{accountId:account.id});return view.body.value.phase==='incremental'&&view.body.value.metadataBacklog===0;},'the startup metadata repair to complete');
  const repaired=await f.call('luogu.status',{accountId:account.id});
  assert.equal(repaired.body.value.metadataResolved,1,'the queued key must be resolved, not failed');
  assert.equal(repaired.body.value.metadataFailed,0,'the startup repair must not fail the queued key');
  // The default anonymous metadata source answered from the injected surface…
  assert.equal(surface.calls.some(call=>call.path===`/problem/${pid}`),true,
   `the default metadata source must use the injected transport: ${JSON.stringify(surface.calls)}`);
  // …the submission history came from the injected record feed…
  assert.equal(feed.calls.length>0,true,'the authenticated reader used the injected record feed');
  // …and the repaired metadata really landed in the store.
  const inspect=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>clock.now()});
  try {
   const stored=await inspect.getProblem(problemKey({sourceInstanceId:instance.id,domain:null,externalKey:pid}));
   assert.ok(stored,'the startup pass must store the repaired problem');
   assert.equal(stored.title,'Synthetic problem');
  }finally{await inspect.close();}
  assert.equal(f.calls(),0);
 }finally{
  try{
   if(runtime!==null)await runtime.dispose();
  }finally{
   globalThis.fetch=realFetch;
   f.remove();
  }
 }
});
test('activation shares the installed guidance catalogue with production plan preparation',async()=>{
 // The very seam `apply()` uses for the `icpcGuidance` service: a method registered here is what a
 // companion package installs, and plan preparation must capture it instead of reporting that no
 // catalogue is composed.
 const registry=new GuidanceMethodRegistry();registry.register(balanced.balancedMethod);
 const f=fixture();
 const scope=fx.makeScope('codeforces','codeforces.com','alice','1A');
 mkdirSync(f.dataDir,{recursive:true});
 const seed=new SqliteTrainingStore({path:join(f.dataDir,'training.sqlite'),now:()=>fx.AT});
 await seed.upsertSourceInstances([scope.instance]);await seed.upsertAccounts([scope.account]);
 await seed.upsertProblems([scope.problem,fx.makeProblem(fx.makeRef(scope.instance,'2B'))]);
 await seed.close();
 const runtime=await activateHost(f.host,{dataDir:f.dataDir},{...f.environment,guidance:registry});
 try {
  const prepared=await f.call('plan.aiPrepare',{requestId:'wired-1',accountId:scope.account.id,guidanceMethodIds:[balanced.balancedMethod.methodId]});
  assert.equal(prepared.status,200);
  assert.equal(prepared.body.value.outcome,'prepared');
  // Without the catalogue, this request is the typed `guidance_unavailable` refusal and never 200.
  assert.deepEqual(prepared.body.value.view.guidanceMethodIds,[balanced.balancedMethod.methodId]);
  assert.equal(prepared.body.value.view.guidance.methods[0].methodId,balanced.balancedMethod.methodId);
  assert.equal(f.calls(),0,'preparing reserves a durable attempt without dispatching a paid call');
 }finally{await runtime.dispose();f.remove();}
});
