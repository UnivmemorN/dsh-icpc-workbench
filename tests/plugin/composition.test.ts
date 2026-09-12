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
  assert.equal(f.calls(),0);assert.equal(f.routes.size,33);
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