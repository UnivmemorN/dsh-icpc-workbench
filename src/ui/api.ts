import type {ApiRequest,ApiResponse,WorkbenchApiOperation} from '../application/workbench-api.js';
const OPERATIONS=new Set<WorkbenchApiOperation>(['bootstrap','model.catalog','backup','account.create','sync.page','import.preview','import.apply','material.refresh','material.supplement','problem.list','problem.browse','problem.detail','review.tag','retro.record','weakness','plan.preview','plan.list','plan.detail','plan.adopt','plan.edit','plan.checkoff','batch.prepare','batch.run','batch.resume','batch.pause','batch.cancel','batch.recover','batch.detail','batch.list','coaching.ask','coaching.status','coaching.history','coaching.cancel','settings.save']);
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
    if(!OPERATIONS.has(operation))throw new ApiClientError('invalid_operation',0,'未知操作');
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