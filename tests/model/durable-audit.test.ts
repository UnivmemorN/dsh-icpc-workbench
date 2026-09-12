import test from 'node:test';
import assert from 'node:assert/strict';
import {Session,SessionId,type SessionEvent} from '@deepseek-ai/dsh-session';
import type {SessionHandle,SessionPersistence} from '@deepseek-ai/dsh-session-persistence';
import {DurableAuditSessions} from '../../src/adapters/dsh/durable-audit-sessions.js';
import {DshAuditedModelClient} from '../../src/adapters/dsh/audited-client.js';
import {createCancellationSource} from '../../src/domain/index.js';
function fixture(){
 const stored:SessionEvent[]=[],durable:SessionEvent[]=[],order:string[]=[];let closes=0,fail=false;
 const handle={append:async(events:readonly SessionEvent[])=>{assert.equal(events[0]?.seq,stored.length);order.push('append');stored.push(...events);},flush:async()=>{order.push('durable');if(fail)throw Error('disk unavailable');durable.splice(0,durable.length,...stored);},close:async()=>{closes++;}} as unknown as SessionHandle;
 const live={prepare:(id:SessionId)=>Session.create(id),flush:async()=>{throw Error('observer flush is not durable');}};
 const persistence={create:async()=>handle} as unknown as Pick<SessionPersistence,'create'>;
 const sessions=new DurableAuditSessions(live,persistence);return {sessions,stored,durable,order,closes:()=>closes,setFailure:()=>{fail=true;}};
}
test('concurrent checkpoints persist contiguous suffixes once and release ownership once',async()=>{
 const f=fixture(),session=await f.sessions.create(SessionId('durable-test'));
 session.append('icpc/model-call-result',{} as never);
 const a=f.sessions.flush(session);session.append('icpc/model-call-result',{} as never);const b=f.sessions.flush(session);
 await Promise.all([a,b]);assert.equal(f.stored.length,2);assert.deepEqual(f.durable.map(e=>e.seq),[0,1]);assert.ok(f.durable.every(e=>e.ignorable===true));assert.deepEqual(f.durable.map(e=>e.data),session.snapshotEvents().map(e=>e.data));
 await Promise.all([f.sessions.close(),f.sessions.close()]);assert.equal(f.closes(),1);await assert.rejects(()=>f.sessions.create(SessionId('closed')));
});
test('real audited call dispatches only after durable input and returns only after durable output',async()=>{
 const f=fixture();const client=new DshAuditedModelClient({sessions:f.sessions,llm:{async *stream(){assert.ok(f.durable.some(e=>e.type==='icpc/model-call-audit'));f.order.push('provider');yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'{}'};yield {type:'block-end',index:0,block:{type:'text',text:'{}'}};yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};yield {type:'finish',reason:{kind:'stop'}};}}},{now:()=>new Date().toISOString()});
 const result=await client.callJson({provider:'test',model:'test',role:'analysis',attemptId:'attempt',promptVersion:'test-v1',snapshotId:'snapshot',system:'system',userPrompt:'{}',maxTokens:1000,temperature:0,timeoutMs:1000,token:createCancellationSource().token},value=>value);
 assert.equal(result.ok,true);assert.ok(f.durable.some(e=>e.type==='icpc/model-call-result'));assert.ok(f.order.indexOf('durable')<f.order.indexOf('provider'));await f.sessions.close();
});
test('failed durable input blocks model dispatch and closes the handle despite the failed queue',async()=>{
 const f=fixture();f.setFailure();let calls=0;const client=new DshAuditedModelClient({sessions:f.sessions,llm:{async *stream(){calls++;throw Error('must not dispatch');}}},{now:()=>new Date().toISOString()});
 const result=await client.callJson({provider:'test',model:'test',role:'analysis',attemptId:'attempt',promptVersion:'test-v1',snapshotId:'snapshot',system:'system',userPrompt:'{}',maxTokens:1000,temperature:0,timeoutMs:1000,token:createCancellationSource().token},v=>v);
 assert.equal(result.ok,false);assert.equal(calls,0);await assert.rejects(()=>f.sessions.close());assert.equal(f.closes(),1);
});
