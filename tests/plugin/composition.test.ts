import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import type {ConnectionFetchRoute} from '@deepseek-ai/dsh-client-connection';
import {activateHost,resolveHarnessHome,type PublicHost} from '../../src/plugin/index.js';
import {ModelCatalog} from '../../src/plugin/model-catalog.js';
import {SqliteTrainingStore} from '../../src/adapters/sqlite/index.js';
import {defaultWorkbenchSettings} from '../../src/application/workbench-settings.js';
import {createCancellationSource} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

function fixture() {
 const temp=fx.tempDatabase(),hostDir=join(temp.dir,'host'),dataDir=join(temp.dir,'training');
 mkdirSync(hostDir);writeFileSync(join(hostDir,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1.5-rc.2'}));
 const launcherPath=join(hostDir,'bin.js');writeFileSync(launcherPath,'// fixture');
 const routes=new Map<string,ConnectionFetchRoute>();let calls=0,failAt=Infinity;
 const host={connection:{fetch:{register(route:ConnectionFetchRoute){if(routes.size===failAt)throw Error('injected registration failure');routes.set(route.path,route);return async()=>{await Promise.resolve();routes.delete(route.path);};}}},
  llm:{listProviders:()=>[{id:'deepseek-official',name:'DeepSeek'}],listModels:async(provider:string)=>[{id:'deepseek-flash',provider,name:'Flash'}],
   resolveModelInfo:async(provider:string,id:string)=>({provider,id,name:id,inputModalities:['text'],context:{contextWindow:1_000_000},defaultMaxTokens:1024,reasoning:{efforts:[{id:'max',name:'Max'}]}}),
   async *stream(){calls++;throw Error('unexpected paid call');}},
  sessionPersistence:{create(){calls++;throw Error('unexpected persistence creation');}},
  sessions:{prepare(){calls++;throw Error('unexpected audit session');},create(){calls++;throw Error('unexpected audit session');},flush:async()=>{calls++;return true;}}} as unknown as PublicHost;
 const environment={nodeVersion:'24.15.0',launcherPath,dshHome:join(temp.dir,'dsh-home')};
 return {temp,host,dataDir,environment,routes,calls:()=>calls,setFailure:(n:number)=>{failAt=n;},
  async call(operation:string,value?:unknown){const route=routes.get('/api/icpc/v1/'+operation)!;assert.ok(route,'registered route '+operation);const response=await route.fetch(new Request('http://localhost/api/icpc/v1/'+operation,value===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}));return {status:response.status,body:await response.json() as any};},
  remove:()=>fx.removeDirectory(temp.dir)};
}
test('host composition keeps activation free, persists settings/accounts and creates a restorable backup',async()=>{
 const f=fixture();let runtime=await activateHost(f.host,{dataDir:f.dataDir},f.environment);
 try {
  assert.equal(f.calls(),0);assert.equal(f.routes.size,40); // 34 stage-06 routes + problem.mergedBrowse (stage 08b) + the 5 AI-planning routes (stage 11d)
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
