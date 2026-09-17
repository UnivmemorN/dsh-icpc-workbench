import type {ApiRequest,ApiResponse,WorkbenchApiOperation} from '../application/workbench-api.js';
/** Exhaustive shared contract: adding an endpoint requires its browser transport entry. */
const OPERATIONS={
 'bootstrap':true,
 'model.catalog':true,
 'backup':true,
 'account.create':true,
 'ability.calibrate':true,
 'ability.syncRating':true,
 'sync.page':true,
 'import.preview':true,
 'import.apply':true,
 'material.refresh':true,
 'material.supplement':true,
 'material.prepare':true,
 'material.start':true,
 'material.detail':true,
 'material.list':true,
 'material.cancel':true,
 'material.retryFailed':true,
 'problem.list':true,
 'problem.browse':true,
 'problem.mergedBrowse':true,
 'problem.detail':true,
 'review.tag':true,
 'retro.record':true,
 'retro.list':true,
 'retro.editPreview':true,
 'retro.editApply':true,
 'weakness':true,
 'plan.preview':true,
 'plan.list':true,
 'plan.detail':true,
 'plan.adopt':true,
 'plan.edit':true,
 'plan.checkoff':true,
 'plan.aiPrepare':true,
 'plan.aiRun':true,
 'plan.aiStatus':true,
 'plan.aiCancel':true,
 'plan.aiHistory':true,
 'batch.prepare':true,
 'batch.run':true,
 'batch.resume':true,
 'batch.pause':true,
 'batch.cancel':true,
 'batch.recover':true,
 'batch.detail':true,
 'batch.list':true,
 'coaching.ask':true,
 'coaching.status':true,
 'coaching.history':true,
 'coaching.cancel':true,
 'settings.save':true,
 'luogu.status':true,
 'luogu.connect':true,
 'luogu.probe':true,
 'luogu.disconnect':true,
 'luogu.configure':true,
 'luogu.start':true,
 'luogu.cancel':true,
 'luogu.profile':true,
 'luogu.metadataBacklog':true,
 'luogu.retryMetadata':true,
 'luogu.supplementMetadata':true,
 'luogu.managedProblems':true,
 'luogu.manageProblems':true,
 'assessment.config':true,
 'assessment.prepare':true,
 'assessment.run':true,
 'assessment.status':true,
 'assessment.cancel':true,
 'assessment.history':true,
 'guidance.catalog':true,
 'performance.list':true,
 'performance.save':true,
 'performance.delete':true,
} as const satisfies Readonly<Record<WorkbenchApiOperation,true>>;
export class ApiClientError extends Error {
  readonly code:string;readonly status:number;
  constructor(code:string,status:number,message:string){super(message);this.name='ApiClientError';this.code=code;this.status=status;}
}
export type BrowserFetch=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
/** Only the authenticated same-origin business API is reachable through this client. */
export class ApiClient {
  private readonly send:BrowserFetch;
  constructor(send:BrowserFetch=globalThis.fetch.bind(globalThis)){this.send=send;}
  async request<K extends WorkbenchApiOperation>(operation:K,input:ApiRequest<K>,signal?:AbortSignal):Promise<ApiResponse<K>>{
    if(!Object.hasOwn(OPERATIONS,operation))throw new ApiClientError('invalid_operation',0,'未知操作');
    let response:Response;
    try{response=await this.send('/api/icpc/v1/'+operation,{method:operation==='bootstrap'?'GET':'POST',credentials:'same-origin',headers:operation==='bootstrap'?{}:{'content-type':'application/json'},...(operation==='bootstrap'?{}:{body:JSON.stringify(input)}),signal});}
    catch(error){throw new ApiClientError(signal?.aborted?'cancelled':'network_error',0,signal?.aborted?'已取消请求':'无法连接工作台，请检查 dsh 是否运行。');}
    let body:unknown;
    try{body=await response.json();}catch(error){throw new ApiClientError(response.status===401?'unauthorized':'invalid_response',response.status,response.status===401?'登录已失效，请从 dsh 启动地址重新打开。':'服务返回了无法识别的响应。');}
    if(signal?.aborted)throw new ApiClientError('cancelled',0,'已取消请求');
    if(!body||typeof body!=='object')throw new ApiClientError('invalid_response',response.status,'响应不是有效对象。');
    const envelope=body as Record<string,unknown>;
    if(envelope.apiVersion!==1||typeof envelope.ok!=='boolean')throw new ApiClientError('version_mismatch',response.status,'工作台接口版本不兼容，请重新加载插件。');
    if(envelope.ok===true){if(!response.ok||!Object.hasOwn(envelope,'value'))throw new ApiClientError('invalid_response',response.status,'响应缺少结果。');return envelope.value as ApiResponse<K>;}
    const error=envelope.error as Record<string,unknown>|null;
    if(!error||typeof error.code!=='string'||typeof error.message!=='string')throw new ApiClientError('invalid_response',response.status,'响应缺少错误信息。');
    throw new ApiClientError(error.code,response.status,error.message);
  }
}
export const api=new ApiClient();