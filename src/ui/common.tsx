import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {ApiRequest,ApiResponse,WorkbenchApiOperation} from '../application/workbench-api.js';
import type {BootstrapResult} from '../application/bootstrap-types.js';
import {api,ApiClientError} from './api.js';
export type PageName='today'|'bank'|'accounts'|'review'|'weakness'|'plans'|'settings';
/**
 * Shared workbench state.
 *
 * `selectAccount` is the one account switch: it also clears the open problem detail and the
 * candidate selection, whether it is called from the header selector or from the accounts page.
 */
export interface WorkbenchContextValue{boot:BootstrapResult;accountId:string|null;selectAccount:(accountId:string|null)=>void;refresh:()=>void;navigate:(page:PageName,problemKey?:string)=>void;problemKey:string|null;selectedKeys:string[];setSelectedKeys:(keys:string[])=>void;}
export const WorkbenchContext=createContext<WorkbenchContextValue|null>(null);
export function useWorkbench():WorkbenchContextValue{const value=useContext(WorkbenchContext);if(!value)throw Error('Workbench context missing');return value;}
const messages:Record<string,string>={settings_changed:'设置已变化，请刷新后重新确认。',conflict:'数据已变化或任务状态冲突，请刷新后重试。',model_busy:'模型任务仍在运行，请等待或取消后再修改。',model_invalid:'模型配置暂不可用，请在设置页查看原因。',invalid_input:'输入不符合要求，请检查填写内容。',cancelled:'请求已取消。',internal:'操作失败，请查看本地 dsh 日志。',unauthorized:'登录已失效，请从 dsh 启动地址重新打开。'};
export function errorText(error:unknown):string{return error instanceof ApiClientError?messages[error.code]??error.message:error instanceof Error?error.message:'操作失败。';}
export function ErrorNotice({error}:{error:unknown}){return error?<div className="icpc-notice icpc-error" role="alert">{errorText(error)}</div>:null;}
export function Notice({children}:{children:ReactNode}){return <div className="icpc-notice">{children}</div>;}
export function Empty({children}:{children:ReactNode}){return <div className="icpc-empty">{children}</div>;}
export function Panel({title,children,tools}:{title:string;children:ReactNode;tools?:ReactNode}){return <section className="icpc-card"><div className="icpc-card-head"><h2>{title}</h2>{tools}</div>{children}</section>;}
export function ExternalLink({href,children}:{href:string;children:ReactNode}){let safe=false;try{safe=['http:','https:'].includes(new URL(href).protocol);}catch(error){safe=false;}return safe?<a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a>:<span>{children}</span>;}
export function useRequest<K extends WorkbenchApiOperation>(operation:K,input:ApiRequest<K>|null){
  const [state,setState]=useState<{key:string;data:ApiResponse<K>|null;error:unknown;pending:boolean}>({key:'',data:null,error:null,pending:false});
  const [version,setVersion]=useState(0),serialized=input===null?null:JSON.stringify(input),key=operation+'|'+serialized;
  useEffect(()=>{if(serialized===null){setState({key,data:null,error:null,pending:false});return;}
    const abort=new AbortController();let alive=true;setState(previous=>({key,data:previous.key===key?previous.data:null,error:null,pending:true}));
    void api.request(operation,JSON.parse(serialized) as ApiRequest<K>,abort.signal).then(data=>{if(alive)setState({key,data,error:null,pending:false});},error=>{if(alive)setState({key,data:null,error,pending:false});});
    return()=>{alive=false;abort.abort();};
  },[key,version]);
  return {...(state.key===key?state:{data:null,error:null,pending:serialized!==null}),refresh:()=>setVersion(v=>v+1)};
}
/** One user action at a time; unmount aborts only the HTTP request, not acknowledged owned work. */
export function useAction(){
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),active=useRef<AbortController|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current?.abort();};},[]);
  async function run<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T|undefined>{
    if(active.current)return undefined;const controller=new AbortController();active.current=controller;setBusy(true);setError(null);
    try{const value=await work(controller.signal);return alive.current&&!controller.signal.aborted?value:undefined;}
    catch(failure){if(alive.current)setError(failure);return undefined;}
    finally{if(active.current===controller)active.current=null;if(alive.current)setBusy(false);}
  }
  return {run,busy,error,cancel:()=>active.current?.abort(),clear:()=>setError(null)};
}
/**
 * Re-run one refresh after the previous read settled, only while `active`.
 *
 * It never overlaps itself, so a slow status read cannot be aborted by its own next tick, and it
 * starts no work of its own: the caller decides when polling is meaningful (for AI planning: only
 * while a run is owned or an attempt is durably reserved).
 */
export function usePollAfterSettle(active:boolean,pending:boolean,refresh:()=>void,delayMs=1500){
  const latest=useRef(refresh);latest.current=refresh;
  useEffect(()=>{if(!active||pending)return;const timer=setTimeout(()=>latest.current(),delayMs);return()=>clearTimeout(timer);},[active,pending,delayMs]);
}
export function tagName(id:string,boot:BootstrapResult):string{return boot.taxonomy.nodes.find(n=>n.id===id)?.names.zh??id;}
export function percent(value:number|null|undefined):string{return value===null||value===undefined?'暂无样本':(value*100).toFixed(0)+'%';}
export function localDay(time:string|Date):number{const d=new Date(time);return Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86400000;}
export function Stats({items}:{items:readonly {label:string;value:ReactNode}[]}){return <div className="icpc-stats">{items.map(i=><div key={i.label}><span>{i.label}</span><strong>{i.value}</strong></div>)}</div>;}