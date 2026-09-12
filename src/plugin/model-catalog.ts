import type { LlmRuntime, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import type { CancellationToken } from '../domain/index.js';
import type { WorkbenchSettings } from '../application/workbench-settings.js';
import type { ModelValidationDiagnostic, ModelDiagnosticRole } from '../application/model-operation-types.js';
import type { CatalogModel, ModelCatalogResult } from '../application/bootstrap-types.js';
import { ModelOperationError } from '../application/model-operation-types.js';
export type CatalogHost = Pick<LlmRuntime, 'listProviders' | 'listModels' | 'resolveModelInfo'>;
const diagnostic=(code:string,severity:'warning'|'error',message:string):ModelValidationDiagnostic=>({code,severity,message});
/** A bounded race also observes a late failure from an uncooperative host adapter. */
async function bounded<T>(work:(signal:AbortSignal)=>Promise<T>,token:CancellationToken,timeoutMs:number):Promise<T> {
  token.throwIfCancelled();const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let off=()=>{};
  const interrupted=new Promise<never>((_resolve,reject)=>{
    off=token.onCancel(()=>{abort.abort();reject(new ModelOperationError('cancelled','model metadata lookup cancelled'));});
    timer=setTimeout(()=>{abort.abort();reject(new Error('MODEL_METADATA_TIMEOUT'));},timeoutMs);
  });
  try { const result=await Promise.race([Promise.resolve().then(()=>work(abort.signal)),interrupted]);token.throwIfCancelled();return result; }
  finally {clearTimeout(timer);off();}
}
function safeText(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.length>4096)throw Error('INVALID_MODEL_METADATA');return value;}
function view(info:LlmModelInfo|LlmResolvedModelInfo):CatalogModel {
  const resolved=info as LlmResolvedModelInfo;
  const result: {id:string;name:string;description?:string;inputModalities?:readonly string[];contextWindow?:number;defaultMaxTokens?:number;reasoningEfforts?:readonly string[]}={id:safeText(info.id),name:safeText(info.name)};
  if(info.description!==undefined)result.description=safeText(info.description);
  if(info.inputModalities!==undefined){if(!Array.isArray(info.inputModalities)||info.inputModalities.length>16)throw Error('INVALID_MODEL_METADATA');result.inputModalities=info.inputModalities.map(safeText);}
  if(resolved.context?.contextWindow!==undefined){if(!Number.isSafeInteger(resolved.context.contextWindow)||resolved.context.contextWindow<=0)throw Error('INVALID_MODEL_METADATA');result.contextWindow=resolved.context.contextWindow;}
  if(resolved.defaultMaxTokens!==undefined){if(!Number.isSafeInteger(resolved.defaultMaxTokens)||resolved.defaultMaxTokens<=0)throw Error('INVALID_MODEL_METADATA');result.defaultMaxTokens=resolved.defaultMaxTokens;}
  if(resolved.reasoning!==undefined){if(!Array.isArray(resolved.reasoning.efforts)||resolved.reasoning.efforts.length>100)throw Error('INVALID_MODEL_METADATA');result.reasoningEfforts=resolved.reasoning.efforts.map(e=>safeText(e.id));}
  return result;
}
/** Catalog membership is advisory. Only known negative capabilities block a configured model. */
export class ModelCatalog {
  private readonly host:CatalogHost; private readonly timeoutMs:number;
  constructor(host:CatalogHost,timeoutMs=10_000) {this.host=host;this.timeoutMs=timeoutMs;}
  async list(provider:string,token:CancellationToken):Promise<ModelCatalogResult>{
    safeText(provider);token.throwIfCancelled();
    let providers:ModelCatalogResult['providers']=[];
    try {
      const rows=this.host.listProviders();if(rows.length>1000)throw Error('CATALOG_OVERFLOW');
      providers=rows.map(p=>({id:safeText(p.id),name:safeText(p.name)}));
      if(!providers.some(p=>p.id===provider))return {provider,providers,models:[],diagnostics:[diagnostic('provider_missing','error','请先在 dsh 中配置该模型提供方。')]};
      const models=await bounded(()=>this.host.listModels(provider),token,this.timeoutMs);
      if(models.length>1000)throw Error('CATALOG_OVERFLOW');
      return {provider,providers,models:models.map(view),diagnostics:[]};
    } catch(error) {token.throwIfCancelled();if(error instanceof ModelOperationError&&error.code==='cancelled')throw error;
      return {provider,providers,models:[],diagnostics:[diagnostic('catalog_unavailable','warning','模型目录暂时不可用；不会自动更换已配置的模型。')]};}
  }
  async validate(settings:WorkbenchSettings,token:CancellationToken):Promise<readonly ModelValidationDiagnostic[]>{
    token.throwIfCancelled();
    try {const providers=this.host.listProviders();if(providers.length>1000||!providers.some(p=>p.id===settings.provider))return [diagnostic('provider_missing','error','请先在 dsh 中配置该模型提供方。')];}
    catch(error){token.throwIfCancelled();return [diagnostic('provider_unavailable','error','无法读取 dsh 模型提供方配置。')];}
    const roles:readonly [ModelDiagnosticRole,string,number][]=[['analysis',settings.roles.analysisModel,settings.roles.maxOutputTokens],['verification',settings.roles.verificationModel,settings.roles.maxOutputTokens],['reasoning',settings.roles.reasoningModel,settings.roles.maxOutputTokens],['coaching',settings.coaching.model,settings.coaching.maxOutputTokens]];
    const ids=[...new Set(roles.map(r=>r[1]))];
    const results=await Promise.all(ids.map(async model=>{
      try {const info=await bounded(signal=>this.host.resolveModelInfo(settings.provider,model,signal),token,this.timeoutMs);
        if(info.provider!==settings.provider||info.id!==model)throw Error('MODEL_IDENTITY_MISMATCH');
        return [model,view(info)] as const;
      } catch(error){token.throwIfCancelled();if(error instanceof ModelOperationError&&error.code==='cancelled')throw error;return [model,null] as const;}
    }));
    const byId=new Map(results), diagnostics:ModelValidationDiagnostic[]=[];
    for(const [role,model,maxOutput] of roles){
      const info=byId.get(model);
      const add=(code:string,severity:'warning'|'error',message:string)=>diagnostics.push({...diagnostic(code,severity,message),role,model});
      if(!info){add('metadata_unknown','warning','模型元数据未知；保留自定义模型 ID，实际调用仍会校验。');continue;}
      if(info.inputModalities!==undefined&&!info.inputModalities.includes('text'))add('text_unsupported','error','该模型明确不支持文本输入。');
      if(info.reasoningEfforts!==undefined&&!info.reasoningEfforts.includes('max'))add('max_unsupported','error','该模型未声明支持 max 推理强度。');
      if(info.contextWindow!==undefined&&maxOutput+4096>=info.contextWindow)add('context_too_small','error','模型上下文不足以容纳配置的输出额度和输入。');
      if(info.inputModalities===undefined||info.reasoningEfforts===undefined||info.contextWindow===undefined)add('capabilities_unknown','warning','部分模型能力未披露；不会推测额度或修改模型。');
    }
    return diagnostics;
  }
}