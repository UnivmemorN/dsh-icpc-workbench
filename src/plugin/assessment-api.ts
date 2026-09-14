import type {HostConnectionFetch} from '@deepseek-ai/dsh-client-connection';
import {AssessmentService,AssessmentServiceError,type AssessmentAttemptView} from '../application/assessment-service.js';
import type {ApiAssessmentView} from '../application/assessment-api-types.js';
import type {ApiRequest,WorkbenchApiMap} from '../application/workbench-api.js';
import type {CancellationToken} from '../domain/index.js';
import {registerApiRoute,ApiTransportError,type ApiErrorCode} from './api-transport.js';
import {mapBusinessError} from './api-validation.js';
import {disposeAll,rollback} from './lifecycle.js';
/** Never serialize an internal attempt, its audit correlations, or source snapshot. */
export function projectAssessment(view:AssessmentAttemptView,includeEvidence=true):ApiAssessmentView{
 return {requestId:view.requestId,status:view.status,requestedAt:view.requestedAt,expiresAt:view.expiresAt,finishedAt:view.finishedAt,
 provider:view.provider,model:view.model,settingsRevision:view.settingsRevision,methodIds:[...view.methodIds],usage:view.usage,report:view.report,
 error:view.error,settlementFailure:view.settlementFailure,verification:view.verification,guidance:view.attempt.preparation.capture.snapshot.guidance,
 evidence:includeEvidence?view.attempt.preparation.capture.prompt:null};
}
const errors:Record<AssessmentServiceError['code'],{code:ApiErrorCode;message:string}>={
 invalid_request:{code:'invalid_input',message:'评估请求无效，请检查账号与方法选择。'},not_found:{code:'not_found',message:'当前账号找不到这条评估记录。'},
 conflict:{code:'conflict',message:'请求与原准备记录不同，请重新准备。'},stale:{code:'conflict',message:'证据或指导方法已变化，请重新准备。'},
 settings:{code:'settings_changed',message:'模型设置已变化，请刷新后重新准备。'},quota:{code:'conflict',message:'已达到最近 24 小时的独立评估调用上限。'},
 busy:{code:'model_busy',message:'已有评估正在生成，请等待完成。'},closing:{code:'model_busy',message:'插件正在关闭，暂不接收新评估。'}
};
export async function registerAssessmentApi(registry:HostConnectionFetch,service:AssessmentService){
 const disposers:(()=>Promise<void>)[]=[];
 function add<K extends keyof WorkbenchApiMap>(operation:K,required:string[],optional:string[],handle:(input:ApiRequest<K>,token:CancellationToken)=>Promise<unknown>){
  disposers.push(registerApiRoute(registry,{operation,method:'POST',validate(value:unknown){
   if(value===null||typeof value!=='object'||Array.isArray(value))throw new ApiTransportError('invalid_input');
   const obj=value as Record<string,unknown>;
   if(required.some(k=>!Object.hasOwn(obj,k))||Object.keys(obj).some(k=>!required.includes(k)&&!optional.includes(k)))throw new ApiTransportError('invalid_input');
   return value as ApiRequest<K>;
  },async handle(input,token){try{return await handle(input,token);}catch(error){
   if(error instanceof AssessmentServiceError){const e=errors[error.code];throw new ApiTransportError(e.code,e.message);}
   throw mapBusinessError(error);
  }}}));
 }
 try{
  add('assessment.config',[],[],(_,t)=>service.config(t));
  add('assessment.prepare',['requestId','accountId','methodIds'],[],async(r,t)=>projectAssessment(await service.prepare(r,t)));
  add('assessment.run',['requestId','accountId'],[],async(r,t)=>{const v=await service.run(r,t);return {started:v.started,attempt:projectAssessment(v.attempt)};});
  add('assessment.status',['requestId','accountId'],[],async(r,t)=>{const v=await service.status(r,t);return v===null?null:projectAssessment(v);});
  add('assessment.cancel',['requestId','accountId'],[],async(r,t)=>projectAssessment(await service.cancel(r,t)));
  add('assessment.history',['accountId'],['status','limit','cursor'],async(r,t)=>{const v=await service.history(r,t);return {items:v.items.map(x=>projectAssessment(x,false)),nextCursor:v.nextCursor};});
  return disposeAll(disposers);
 }catch(error){return rollback(error,disposers);}
}
