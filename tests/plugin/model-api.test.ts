import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { CoachingService } from '../../src/application/coaching-service.js';
import { AnalysisPipeline } from '../../src/application/analysis-pipeline.js';
import { createAnalysisBatch } from '../../src/application/batch-types.js';
import type { ModelGateway } from '../../src/application/ports.js';
import { defaultWorkbenchSettings } from '../../src/application/workbench-settings.js';
import {
  analysisJobIdOf,
  createModelUsage,
  createProblemSnapshot,
  createTaxonomy,
} from '../../src/domain/index.js';
import { ModelOperations } from '../../src/plugin/model-operations.js';
import { registerModelApi } from '../../src/plugin/model-api.js';
import { disposeAll } from '../../src/plugin/lifecycle.js';
import * as fx from '../storage/fixtures.js';

class Registry {
  routes = new Map<string, ConnectionFetchRoute>();
  failAt = Infinity;
  register(route: ConnectionFetchRoute): () => Promise<void> {
    if (this.routes.size === this.failAt) throw Error('registration failure');
    this.routes.set(route.path, route);
    return async () => { await Promise.resolve(); this.routes.delete(route.path); };
  }
  async call(operation: string, value: unknown, signal?: AbortSignal): Promise<{ status: number; body: any }> {
    const route = this.routes.get('/api/icpc/v1/' + operation)!;
    const response = await route.fetch(new Request('http://localhost/api/icpc/v1/' + operation, {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(value), signal,
    }));
    return {status: response.status, body: await response.json()};
  }
}
async function setup() {
  const now=()=>fx.AT, store=new SqliteTrainingStore({path:':memory:',now});
  const world=fx.makeScope('codeforces','codeforces.com','alice','1A');
  await store.upsertSourceInstances([world.instance]);await store.upsertProblems([world.problem]);
  await store.saveSnapshot(fx.makeSnapshot(world.problem));await store.saveWorkbenchSettings(defaultWorkbenchSettings(),null);
  let generated=0, analyzed=0, ids=0;
  const usage=createModelUsage({calls:1,promptTokens:10,completionTokens:10});
  const coaching=new CoachingService({store,now,generator:{generate:async()=>{
    generated++; return {ok:true,value:{text:'PRIVATE HINT BODY'},usage,callId:'call',sessionId:'session'};
  }}});
  const gateway: ModelGateway={capabilities:()=>({provider:'fake',implemented:true,roles:['analysis','verification','reasoning'],maxConcurrency:2,notes:[]}),
    analyze:async()=>{analyzed++;return {ok:false,error:{code:'provider_error',message:'local boundary failure',retryable:false},usage,callId:'analysis',sessionId:'session'};},
    verify:async()=>{throw Error('Unexpected verification');},reason:async()=>{throw Error('Unexpected reasoning');}};
  const controller=new ModelOperations({store,coaching,now,uniqueId:(p)=>p+'-'+(++ids),validateModels:async()=>[],
    createPipeline:(r)=>new AnalysisPipeline({store,gateway,taxonomy:createTaxonomy({version:'test',nodes:[]}),roles:r.value.roles,limits:r.value.modelLimits,now,uniqueId:(p)=>p+'-'+(++ids)})});
  const registry=new Registry(), dispose=await registerModelApi({registry:registry as unknown as HostConnectionFetch,controller});
  return {world,store,controller,registry,calls:()=>({generated,analyzed}), close:async()=>{await dispose();await controller.close();await controller.whenSettled();await store.close();}};
}

test('HTTP batch preparation is free, stale start refuses, 202 run settles durable calls',async()=>{
  const b=await setup();try {
    const prepared=await b.registry.call('batch.prepare',{problemKeys:[b.world.problem.key]});
    assert.equal(prepared.status,200);assert.equal(b.calls().analyzed,0);
    const batchId=prepared.body.value.batchId;
    assert.equal((await b.registry.call('batch.run',{batchId,expectedSettingsRevision:2})).status,409);
    assert.equal(b.calls().analyzed,0);
    assert.equal((await b.registry.call('batch.run',{batchId,expectedSettingsRevision:1})).status,202);
    await b.controller.whenSettled();
    const detail=await b.registry.call('batch.detail',{batchId});
    assert.equal(detail.body.value.operation.state,'settled');assert.equal(b.calls().analyzed,1);
    assert.equal(detail.body.value.batch.jobs[0].calls.length,1);
    assert.equal(JSON.stringify(detail).includes('local boundary failure'),false);
  } finally {await b.close();}
});
test('HTTP coaching has terminal refusals, free replay, strict shapes and explicit body reveal',async()=>{
  const b=await setup();try {
    const identity={requestId:'hint-1',accountId:null,problemKey:b.world.problem.key};
    assert.equal((await b.registry.call('coaching.ask',{...identity,level:1,expectedSettingsRevision:1,typo:true})).status,400);
    const settings=defaultWorkbenchSettings();
    assert.equal((await b.registry.call('settings.save',{expectedRevision:1,value:{...settings,roles:{...settings.roles,typo:1}}})).status,400);
    const aborted=new AbortController();aborted.abort();
    assert.equal((await b.registry.call('coaching.ask',{...identity,level:1,expectedSettingsRevision:1},aborted.signal)).status,499);
    assert.equal(b.calls().generated,0);
    assert.equal((await b.registry.call('coaching.ask',{...identity,level:'full',expectedSettingsRevision:1})).status,400);
    assert.equal((await b.registry.call('coaching.ask',{...identity,level:1,expectedSettingsRevision:1})).status,202);
    await b.controller.whenSettled();
    const hidden=await b.registry.call('coaching.status',identity);
    assert.equal(hidden.body.value.operation.status,'answered');assert.equal(JSON.stringify(hidden).includes('PRIVATE HINT BODY'),false);
    const shown=await b.registry.call('coaching.status',{...identity,includeResponseText:true});
    assert.ok(JSON.stringify(shown).includes('PRIVATE HINT BODY'));
    await b.registry.call('settings.save',{expectedRevision:1,value:settings});
    await b.registry.call('coaching.ask',{...identity,level:1,expectedSettingsRevision:1});
    assert.equal(b.calls().generated,1);
    const missing={...identity,requestId:'missing',problemKey:fx.makeScope('codeforces','codeforces.com','alice','9999A').problem.key};
    await b.registry.call('coaching.ask',{...missing,level:1,expectedSettingsRevision:2});await b.controller.whenSettled();
    const refusal=await b.registry.call('coaching.status',missing);
    assert.equal(refusal.body.value.operation.status,'refused');assert.equal(b.calls().generated,1);
  } finally {await b.close();}
});
test('model route registration rolls back async contributions on partial failure',async()=>{
  const b=await setup();try {
    const registry=new Registry();registry.failAt=3;
    await assert.rejects(()=>registerModelApi({registry:registry as unknown as HostConnectionFetch,controller:b.controller}),/registration failure/);
    assert.equal(registry.routes.size,0);
  } finally {await b.close();}
});
test('cleanup attempts all resources once and retains failure',async()=>{
  const seen:number[]=[];const close=disposeAll([async()=>{seen.push(1);},async()=>{seen.push(2);throw Error('failure');},async()=>{seen.push(3);}]);
  const a=close(), b=close();assert.strictEqual(a,b);await assert.rejects(a,AggregateError);assert.deepEqual(seen,[3,2,1]);
});

// ---------------------------------------------------------------------------------------
// Material preflight at the HTTP boundary (Sprint 33A)
// ---------------------------------------------------------------------------------------

/** One snapshot whose editorial state is unknown: no source record at all, so nothing is runnable. */
function unreadableMaterialSnapshot(problem: Parameters<typeof createProblemSnapshot>[0]['problem']) {
  return createProblemSnapshot({ problem, sources: [], solutions: [], capturedAt: fx.AT });
}

test('HTTP batch.prepare reports blocked material without a batch, and batch.detail keeps it read-only',async()=>{
  const b=await setup();try {
    const bare=fx.makeProblem(fx.makeRef(fx.makeInstance('codeforces','codeforces.com'),'4242X'));
    await b.store.upsertProblems([bare]);
    await b.store.saveSnapshot(unreadableMaterialSnapshot(bare));

    const prepared=await b.registry.call('batch.prepare',{problemKeys:[bare.key]});
    assert.equal(prepared.status,200);
    assert.equal(prepared.body.value.batchId,null);
    assert.deepEqual(prepared.body.value.jobs,[]);
    // The refusal is explicit, free and spoiler-free: a reason, an action and zero calls.
    assert.deepEqual(prepared.body.value.blocked,[{problemKey:bare.key,reason:'editorial_unknown',action:'refresh_materials'}]);
    assert.deepEqual(prepared.body.value.availability,{ready:0,absent:0,error:1});
    assert.deepEqual(prepared.body.value.upperBoundCalls,{analysisCalls:0,reasoningCalls:0,blocked:1});
    assert.equal(b.calls().analyzed,0);
    // No statement, source title, editorial body or classifier detail travels through the answer.
    const serialized=JSON.stringify(prepared);
    for (const leak of [bare.title,bare.statement!,'carry no referenced solution text','absence cannot be concluded']) {
      assert.equal(serialized.includes(leak),false,`the answer must not carry ${leak}`);
    }
    // `batch.detail` of a fresh runnable batch carries the new read-only preflight field.
    const runnable=await b.registry.call('batch.prepare',{problemKeys:[b.world.problem.key]});
    assert.deepEqual(runnable.body.value.blocked,[]);
    const detail=await b.registry.call('batch.detail',{batchId:runnable.body.value.batchId});
    assert.deepEqual(detail.body.value.batch.materialBlocks,[]);
  } finally {await b.close();}
});

test('a stored batch whose material cannot be analysed is refused over HTTP without an operation or a call',async()=>{
  const b=await setup();try {
    const batchId='legacy-http-blocked';
    const snapshotId=b.world.problem.key+'@'+'0'.repeat(64)+':v1';
    await b.store.saveBatch(createAnalysisBatch({
      batchId,
      jobs:[{jobId:analysisJobIdOf(snapshotId),snapshotId}],
      createdAt:fx.AT,
      maxJobs:1,
    }),null);

    // A direct API caller cannot bypass the gate: the refusal is `materials_blocked` with a fixed
    // safe message, it is a 409 conflict, and no owned operation was created.
    const run=await b.registry.call('batch.run',{batchId,expectedSettingsRevision:1});
    assert.equal(run.status,409);
    assert.equal(run.body.error.code,'materials_blocked');
    assert.equal(typeof run.body.error.message,'string');
    assert.equal(b.calls().analyzed,0);

    const detail=await b.registry.call('batch.detail',{batchId});
    assert.equal(detail.body.value.operation,null);
    assert.equal(detail.body.value.batch.status,'pending');
    assert.equal(detail.body.value.batch.jobs[0].snapshotId,snapshotId);
    assert.deepEqual(detail.body.value.batch.counters,{analysisCalls:0,reasoningCalls:0,retries:0});
    assert.equal(detail.body.value.batch.materialBlocks.length,1);
    assert.equal(detail.body.value.batch.materialBlocks[0].reason,'snapshot_unreadable');
    assert.equal(detail.body.value.batch.materialBlocks[0].action,'refresh_materials');
    // A resume of the same batch is refused identically, so neither control path can start it.
    const resume=await b.registry.call('batch.resume',{batchId,expectedSettingsRevision:1});
    assert.equal(resume.status,409);
    assert.equal(resume.body.error.code,'materials_blocked');
    assert.equal(b.calls().analyzed,0);
    // Nothing of the batch moved.
    const after=await b.store.getBatch(batchId);
    assert.equal(after?.status,'pending');
    assert.equal(after?.revision,1);
    assert.deepEqual(await b.store.listModelCallAttempts({batchId}),[]);
  } finally {await b.close();}
});