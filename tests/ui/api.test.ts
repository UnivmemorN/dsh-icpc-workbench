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