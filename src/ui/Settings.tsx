import{useEffect,useState}from'react';
import type{WorkbenchSettings}from'../application/workbench-settings.js';
import{validateWorkbenchSettings}from'../application/workbench-settings.js';
import{api}from'./api.js';
import{Panel,Notice,ErrorNotice,useWorkbench,useRequest,useAction,ExternalLink}from'./common.js';
const labels:Record<string,string>={'roles.maxOutputTokens':'标签分析输出上限','roles.temperature':'采样温度','modelLimits.maxAnalysisCalls':'每批分析与复核调用上限','modelLimits.maxReasoningCalls':'每批无题解推理上限','modelLimits.concurrency':'批次并发','modelLimits.requestTimeoutMs':'模型请求超时（毫秒）','modelLimits.maxRetries':'批次重试上限','modelLimits.job.maxAnalysisCalls':'单题分析调用上限','modelLimits.job.maxReasoningCalls':'单题推理调用上限','modelLimits.job.maxAttempts':'单题尝试轮数','modelLimits.job.leaseMs':'单题租约（毫秒）','platformLimits.minRequestIntervalMs':'平台请求间隔（毫秒）','platformLimits.requestTimeoutMs':'平台请求超时（毫秒）','platformLimits.maxRetries':'平台重试上限','platformLimits.pageSize':'平台分页大小','platformLimits.maxConcurrency':'平台并发','coaching.maxCallsPer24Hours':'提示与计划各自的 24 小时调用上限','coaching.maxConcurrent':'提示并发上限','coaching.maxOutputTokens':'提示输出上限','coaching.requestTimeoutMs':'提示超时（毫秒）'};
function numbers(value:unknown,prefix=''):readonly [string,number][]{if(!value||typeof value!=='object')return[];return Object.entries(value).flatMap(([k,v])=>{const path=prefix?prefix+'.'+k:k;return typeof v==='number'&&path!=='schemaVersion'?[[path,v] as [string,number]]:numbers(v,path);});}
function setPath(settings:WorkbenchSettings,path:string,value:unknown):WorkbenchSettings{const copy=structuredClone(settings),parts=path.split('.');let current=copy as unknown as Record<string,unknown>;for(const part of parts.slice(0,-1))current=current[part] as Record<string,unknown>;current[parts.at(-1)!]=value;return copy;}
export function Settings(){
 const {boot,refresh}=useWorkbench(),[draft,setDraft]=useState(()=>structuredClone(boot.settings.value)),[backup,setBackup]=useState<string|null>(null),action=useAction();
 useEffect(()=>setDraft(structuredClone(boot.settings.value)),[boot.settings.revision]);
 const catalog=useRequest('model.catalog',{provider:draft.provider});let valid=true;try{validateWorkbenchSettings(draft);}catch(error){valid=false;}
 const modelFields:[string,string,string][]=[['roles.analysisModel','题解标签分析 / 训练计划',draft.roles.analysisModel],['roles.verificationModel','证据复核',draft.roles.verificationModel],['roles.reasoningModel','确认无题解时推理',draft.roles.reasoningModel],['coaching.model','逐级提示',draft.coaching.model]];
 return <><div className="icpc-page-heading"><div><p className="icpc-eyebrow">SETTINGS</p><h1>模型与训练设置</h1><p>更改设置后，新任务才会采用新的版本。当前版本 {boot.settings.revision}。</p></div></div>
 <ErrorNotice error={action.error??catalog.error}/>
 <Panel title="模型角色"><Notice>所有任务统一使用 DeepSeek V4.1 Flash（DSV4.1F），强度 max：标签分析、独立复核、无题解推理、逐级提示与训练计划均采用同一模型。模型不可用时会报告失败，不会改用 Pro 或其他模型。</Notice><div className="icpc-form-grid"><label>提供方<input value={draft.provider} readOnly/></label>
 {modelFields.map(([path,label,value])=><label key={path}>{label}<input value={value} readOnly/></label>)}</div>
 <p className="icpc-muted">旧配置会在升级时统一到 Flash，并保留原有额度与超时。确认无题解时仍可推理；也可以在题目详情粘贴从 GPT6、教师等处取得的解析。</p>
 {(catalog.data?.diagnostics??[]).map((d,i)=><Notice key={i}>{d.message}</Notice>)}{boot.modelDiagnostics.map((d,i)=><Notice key={'role'+i}>{d.role}：{d.message}</Notice>)}
 </Panel>
 <Panel title="调用额度与超时"><div className="icpc-form-grid">{numbers(draft).map(([path,value])=><label key={path}>{labels[path]??path}<input type="number" step={path==='roles.temperature'?'0.1':'1'} value={Number.isFinite(value)?value:''} onChange={e=>setDraft(setPath(draft,path,e.target.value===''?NaN:Number(e.target.value)))}/></label>)}</div><Notice>重试也占用调用额度。未知费用不会记为零；修改设置不会清除正在使用的额度。提示与计划使用各自独立的 24 小时计数器，但共用同一个上限值：计划调用不会消耗提示额度，反之亦然。Codeforces 请求至少间隔 2 秒。</Notice></Panel>
 <div className="icpc-actions"><button className="icpc-primary" disabled={action.busy||!valid} onClick={()=>{void action.run(async signal=>{await api.request('settings.save',{expectedRevision:boot.settings.revision,value:draft},signal);refresh();return true;});}}>{action.busy?'正在保存…':'保存设置'}</button><button onClick={refresh} disabled={action.busy}>重新读取</button>{!valid&&<span role="status">请检查输入范围；当前内容不能保存。</span>}</div>
 <Panel title="本地数据"><dl className="icpc-details"><dt>数据目录</dt><dd>{boot.dataDir}</dd><dt>宿主版本</dt><dd>{boot.hostVersion}</dd><dt>数据库版本</dt><dd>{boot.schemaVersion}</dd></dl><button disabled={action.busy} onClick={()=>{void action.run(async signal=>{const result=await api.request('backup',{},signal);setBackup(result.path);return result;});}}>创建本地备份</button>{backup&&<p className="icpc-wrap" role="status">已创建：{backup}</p>}</Panel>
 <Panel title="项目与许可"><p>MIT · 受 <ExternalLink href="https://github.com/ZF3373/icpc-workbench">icpc-workbench</ExternalLink> 启发，架构参考 NovaPhy。</p><p><ExternalLink href="https://github.com/UnivmemorN/dsh-icpc-workbench">查看本项目源码与许可证</ExternalLink></p><Notice>{boot.hydro.note}</Notice></Panel>
 </>;
}
