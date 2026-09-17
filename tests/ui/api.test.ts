import assert from 'node:assert/strict';import{test}from'node:test';
import{ApiClient,ApiClientError}from'../../src/ui/api.js';
test('browser API uses same-origin credentials and exact typed paths',async()=>{
 const calls:{input:RequestInfo|URL;init?:RequestInit}[]=[];
 const client=new ApiClient(async(input,init)=>{calls.push({input,init});return Response.json({apiVersion:1,ok:true,value:{revision:2}});});
 await client.request('bootstrap',{});await client.request('batch.run',{batchId:'batch-1',expectedSettingsRevision:1});
 assert.equal(calls[0]?.input,'/api/icpc/v1/bootstrap');assert.equal(calls[0]?.init?.method,'GET');assert.equal(calls[0]?.init?.body,undefined);
 assert.equal(calls[1]?.init?.credentials,'same-origin');assert.deepEqual(JSON.parse(calls[1]!.init!.body as string),{batchId:'batch-1',expectedSettingsRevision:1});
});
test('browser API rejects missing values, incompatible versions and false successes',async()=>{
 for(const [body,status,code]of [[{apiVersion:2,ok:true,value:{}},200,'version_mismatch'],[{apiVersion:1,ok:true},200,'invalid_response'],[{apiVersion:1,ok:true,value:{}},500,'invalid_response']]as const){
  const client=new ApiClient(async()=>Response.json(body,{status}));await assert.rejects(()=>client.request('bootstrap',{}),e=>e instanceof ApiClientError&&e.code===code);
 }
 const client=new ApiClient(async()=>Response.json({apiVersion:1,ok:false,error:{code:'settings_changed',message:'reload'}},{status:409}));await assert.rejects(()=>client.request('bootstrap',{}),e=>e instanceof ApiClientError&&e.code==='settings_changed'&&e.status===409);
});
test('browser API reports cancellation and expired authentication explicitly',async()=>{
 const abort=new AbortController();abort.abort();const client=new ApiClient(async()=>{throw Error('network cancellation');});await assert.rejects(()=>client.request('bootstrap',{},abort.signal),e=>e instanceof ApiClientError&&e.code==='cancelled');
 const auth=new ApiClient(async()=>new Response('unauthorized',{status:401}));await assert.rejects(()=>auth.request('bootstrap',{}),e=>e instanceof ApiClientError&&e.code==='unauthorized');
});
test('merged bank transport retains the account selection and exact authenticated endpoint',async()=>{
 const input={accountIds:['selected-account'],sourceInstanceId:'luogu:www.luogu.com.cn',status:'solved' as const,page:3,limit:25};
 let called=false;const controller=new AbortController();
 const client=new ApiClient(async(url,init)=>{
  called=true;assert.equal(url,'/api/icpc/v1/problem.mergedBrowse');assert.equal(init?.method,'POST');assert.equal(init?.credentials,'same-origin');assert.equal(init?.signal,controller.signal);assert.deepEqual(JSON.parse(init?.body as string),input);
  return Response.json({apiVersion:1,ok:true,value:{items:[],page:3}});
 });
 await client.request('problem.mergedBrowse',input,controller.signal);assert.equal(called,true);
});
test('guidance and virtual performance operations reach authenticated browser transport',async()=>{
 const calls:string[]=[];const client=new ApiClient(async(url,init)=>{calls.push(String(url));assert.equal(init?.credentials,'same-origin');return Response.json({apiVersion:1,ok:true,value:{}});});
 await client.request('guidance.catalog',{});
 await client.request('performance.list',{accountId:'synthetic'});
 await client.request('performance.save',{accountId:'synthetic',expectedRevision:0,contestId:1,participatedAt:'2026-09-01T00:00:00.000Z',performance:1700,calculationMethod:'calculator',sourceUrl:'https://example.com',independence:'independent',priorExposure:false});
 await client.request('performance.delete',{accountId:'synthetic',expectedRevision:1,evidenceId:'example'});
 assert.deepEqual(calls,['guidance.catalog','performance.list','performance.save','performance.delete'].map(op=>'/api/icpc/v1/'+op));
});

test('problem management browser transport keeps explicit selection and expected state', async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const client = new ApiClient(async (input, init) => { calls.push({ input, init }); return Response.json({ apiVersion: 1, ok: true, value: { changed: 1 } }); });
  const controller = new AbortController();
  const mutation = { accountId: 'synthetic', action: 'trash' as const, items: [{ problemKey: 'synthetic-key', expectedState: 'active' as const }] };
  await client.request('luogu.manageProblems', mutation, controller.signal);
  await client.request('luogu.managedProblems', { accountId: 'synthetic', state: 'trashed', page: 2, pageSize: 20 });
  assert.equal(calls[0]?.input, '/api/icpc/v1/luogu.manageProblems');
  assert.equal(calls[0]?.init?.credentials, 'same-origin'); assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), mutation);
  assert.equal(calls[1]?.input, '/api/icpc/v1/luogu.managedProblems');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { accountId: 'synthetic', state: 'trashed', page: 2, pageSize: 20 });
});

test('bulk material refresh browser transport keeps the exact six authenticated endpoints', async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const client = new ApiClient(async (input, init) => { calls.push({ input, init }); return Response.json({ apiVersion: 1, ok: true, value: { batchId: 'material-batch-1' } }); });
  const controller = new AbortController();
  const prepared = { items: [{ problemKey: 'codeforces:codeforces.com|1A', accountId: null, officialTutorialUrl: 'https://codeforces.com/blog/entry/1', fetchStatement: false }] };
  await client.request('material.prepare', prepared, controller.signal);
  await client.request('material.start', { batchId: 'material-batch-1' });
  await client.request('material.detail', { batchId: 'material-batch-1' });
  await client.request('material.list', { status: 'paused', limit: 20 });
  await client.request('material.cancel', { batchId: 'material-batch-1' });
  await client.request('material.retryFailed', { batchId: 'material-batch-1' });
  assert.deepEqual(
    calls.map(call => call.input),
    ['material.prepare', 'material.start', 'material.detail', 'material.list', 'material.cancel', 'material.retryFailed'].map(operation => '/api/icpc/v1/' + operation),
  );
  for (const call of calls) {
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.credentials, 'same-origin');
    assert.equal(call.init?.headers && (call.init.headers as Record<string, string>)['content-type'], 'application/json');
  }
  assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), prepared);
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { status: 'paused', limit: 20 });
  await assert.rejects(() => client.request('material.unknown' as never, {} as never), (error: unknown) => error instanceof ApiClientError && error.code === 'invalid_operation');
});
