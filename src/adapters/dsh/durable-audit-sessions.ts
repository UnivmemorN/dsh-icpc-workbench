/** Own a detached public session and its durable handle; never mix manual append with live-event routing. */
import {SessionLogOffset,type Session,type SessionId} from '@deepseek-ai/dsh-session';
import type {SessionPersistence,SessionHandle} from '@deepseek-ai/dsh-session-persistence';
import type {DshAuditedHost} from './audited-client.js';
interface Entry{session:Session;handle:SessionHandle;cursor:number;tail:Promise<void>;}
type AuditSessions=DshAuditedHost['sessions'];
export class DurableAuditSessions implements AuditSessions {
 private readonly live:{prepare(id:SessionId):Session};private readonly persistence:Pick<SessionPersistence,'create'>;
 private readonly entries=new Map<Session,Entry>();private readonly pending=new Set<Promise<Session>>();
 private closed=false;private closing:Promise<void>|null=null;
 constructor(live:{prepare(id:SessionId):Session},persistence:Pick<SessionPersistence,'create'>){this.live=live;this.persistence=persistence;}
 create(id:SessionId):Promise<Session>{
  if(this.closed)return Promise.reject(Error('Audit persistence is closed'));
  const creating=(async()=>{
   const session=this.live.prepare(id),handle=await this.persistence.create(session.header,{inheritedEventCount:session.inheritedEventCount});
   if(this.closed){await handle.close();throw Error('Audit persistence closed during creation');}
   this.entries.set(session,{session,handle,cursor:0,tail:Promise.resolve()});return session;
  })();
  this.pending.add(creating);void creating.then(()=>this.pending.delete(creating),()=>this.pending.delete(creating));return creating;
 }
 async flush(session:Session):Promise<boolean>{
  const entry=this.entries.get(session);if(this.closed||!entry)throw Error('Audit session has no owned persistence handle');
  const work=entry.tail.then(async()=>{
   const events=session.snapshotEvents(SessionLogOffset(entry.cursor));
   if(events.length){// Public persistence marker: these plugin records are informational to dsh conversation replay.
   // Business decisions live independently in TrainingStore; preserve every audit payload verbatim.
   await entry.handle.append(events.map(event=>event.type==='icpc/model-call-audit'||event.type==='icpc/model-call-result'?{...event,ignorable:true as const}:event));entry.cursor+=events.length;}
   await entry.handle.flush();
  });
  // A failed barrier poisons subsequent appends; an ambiguous write must not be retried blindly.
  entry.tail=work;await work;return true;
 }
 close():Promise<void>{
  if(this.closing)return this.closing;this.closed=true;
  this.closing=(async()=>{
   await Promise.allSettled([...this.pending]);
   const results=await Promise.allSettled([...this.entries.values()].map(async entry=>{try{await entry.tail;}finally{await entry.handle.close();}}));
   this.entries.clear();const errors=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);if(errors.length)throw new AggregateError(errors,'Audit persistence close failed');
  })();return this.closing;
 }
}
