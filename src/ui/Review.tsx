import {useEffect,useState} from 'react';
import type {ApiResponse} from '../application/workbench-api.js';
import {api} from './api.js';
import {Bank} from './Bank.js';
import {Panel,Notice,Empty,ErrorNotice,useAction,useRequest,useWorkbench} from './common.js';
const names:Record<string,string>={pending:'待开始',running:'运行中',paused:'已暂停',completed:'已完成',cancelled:'已取消',failed:'失败',needs_review:'待人工审核',succeeded:'已分析',quota_exhausted:'额度已用完'};
const rerunReasons:Record<string,string>={legacy_unchecked:'旧结果未记录当前完整性检查',cancelled_run:'旧任务已取消',reanalyze_requested:'按你的要求强制重跑'};
export function Review(){
 const {selectedKeys,boot,navigate}=useWorkbench(),action=useAction(),list=useRequest('batch.list',{limit:50});
 const [prepared,setPrepared]=useState<ApiResponse<'batch.prepare'>|null>(null),[batchId,setBatchId]=useState<string|null>(null),[maxJobs,setMaxJobs]=useState(20),[reanalyze,setReanalyze]=useState(false),[recovered,setRecovered]=useState<ApiResponse<'batch.recover'>|null>(null);
 const detail=useRequest('batch.detail',batchId?{batchId}:null),live=detail.data?.operation?.state==='running';
 useEffect(()=>{if(!live)return;const timer=setInterval(()=>detail.refresh(),1500);return()=>clearInterval(timer);},[live,batchId]);
 const update=()=>{detail.refresh();list.refresh();};
 const batch=detail.data?.batch;
 async function control(op:'batch.run'|'batch.resume'|'batch.pause'|'batch.cancel'|'batch.recover'){
  if(!batchId)return;
  await action.run(async signal=>{
   if(op==='batch.run'||op==='batch.resume')await api.request(op,{batchId,expectedSettingsRevision:prepared?.batchId===batchId?prepared.settingsRevision!:boot.settings.revision!},signal);
   else if(op==='batch.recover')setRecovered(await api.request(op,{batchId},signal));
   else await api.request(op,{batchId},signal);
   update();return true;
  });
 }
 return <><div className="icpc-page-heading"><div><p className="icpc-eyebrow">EVIDENCE & REVIEW</p><h1>先找证据，再采用标签</h1><p>题解分析与第二次复核分别执行，推测和冲突留给人工判断。</p></div></div>
 <Panel title="标签分析批次"><ErrorNotice error={action.error}/><p>已选 {selectedKeys.length} 题。准备操作只建立任务；开始运行后才调用模型。默认只补查尚未完成当前版本完整性检查的题目；已有平台标签的题目同样可以入选。</p><div className="icpc-toolbar"><label>本批最多题数<input type="number" min="1" max="100" value={maxJobs} onChange={e=>setMaxJobs(Number(e.target.value))}/></label><label><input className="icpc-check" type="checkbox" checked={reanalyze} onChange={e=>setReanalyze(e.target.checked)}/>重新分析（保留旧结果）</label><button disabled={action.busy||!selectedKeys.length||!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>100} onClick={()=>{void action.run(async signal=>{const value=await api.request('batch.prepare',{problemKeys:selectedKeys,maxJobs,reanalyze},signal);setPrepared(value);setBatchId(value.batchId);list.refresh();return value;});}}>免费准备批次</button><button onClick={()=>navigate('bank')}>去题库选择</button></div>
 {prepared&&<Notice><p>{prepared.provider} · 分析 {prepared.models.analysis} · 复核 {prepared.models.verification} · 无题解推理 {prepared.models.reasoning} · max</p><p>已找到题解 {prepared.availability.ready}；已确认无题解 {prepared.availability.absent}；材料不全或获取失败 {prepared.availability.error}。</p><p>本批最多 {prepared.upperBoundCalls.analysisCalls} 次分析/复核、{prepared.upperBoundCalls.reasoningCalls} 次推理（含重试）。这不是费用预测。</p><p>新任务 {prepared.jobs.length}；已跳过（现有完整性检查仍有效） {prepared.alreadyDone.length}；重跑（旧结果保留） {prepared.reruns.length}；材料缺失 {prepared.blocked.length}。</p>{prepared.alreadyDone.length>0&&<p>跳过仅表示这些题目的当前快照已完成当前版本完整性检查；它不代表所有标签都已正确，旧版结果或缺少检查记录的任务不会被当作已完成。</p>}{prepared.reruns.length>0&&<p>重跑：{prepared.reruns.map(r=>rerunReasons[r.reason]??r.reason).join('、')}（每题都会建立独立的新任务，旧任务、旧结果与旧标签历史全部保留）。</p>}{prepared.blocked.length>0&&<p>以下题目缺少材料快照，未建立任务也未调用模型：{prepared.blocked.map(b=><button key={b.problemKey} type="button" onClick={()=>navigate('bank',b.problemKey)}>{b.problemKey.split('||').at(-1)}</button>)}。请到题目详情刷新平台材料后再准备。</p>}</Notice>}
 <label>查看已保存批次<select value={batchId??''} onChange={e=>{setBatchId(e.target.value||null);setRecovered(null);}}><option value="">请选择</option>{list.data?.items.map(b=><option key={b.batchId} value={b.batchId}>{new Date(b.createdAt).toLocaleString()} · {b.jobCount} 题 · {names[b.status]??b.status}</option>)}</select></label><ErrorNotice error={list.error}/><ErrorNotice error={detail.error}/>
 {batch&&<><div className="icpc-actions"><strong>{names[batch.status]??batch.status}</strong><button className="icpc-primary" disabled={action.busy||live||batch.status!=='pending'} onClick={()=>void control('batch.run')}>确认开始付费分析</button><button disabled={action.busy||!live} onClick={()=>void control('batch.pause')}>暂停</button><button disabled={action.busy||live||!['paused','failed'].includes(batch.status)} onClick={()=>void control('batch.resume')}>确认继续付费分析</button><button disabled={action.busy||['completed','cancelled'].includes(batch.status)} onClick={()=>void control('batch.cancel')}>取消批次</button><button disabled={action.busy||live||['completed','cancelled'].includes(batch.status)} onClick={()=>void control('batch.recover')}>恢复中断状态</button><button onClick={update}>刷新状态</button></div>
 <p className="icpc-muted">已计入 {batch.counters.analysisCalls} 次分析/复核、{batch.counters.reasoningCalls} 次推理。未知用量 {batch.uncertainAttempts} 次；未知费用不会当作零或自动退回。</p>
 {(batch.lastErrorCode||detail.data?.operation?.errorCode)&&<Notice>任务报告：{batch.lastErrorCode??detail.data?.operation?.errorCode}</Notice>}
 {recovered&&<Notice>{recovered.batches.map(b=>'重新排队 '+b.requeuedJobs+' 题，未知用量 '+b.uncertainAttempts+' 次'+(b.skipped?'；仍有有效租约':'')).join('；')}。恢复状态后需要明确点击继续。</Notice>}
 <div className="icpc-table-wrap"><table><thead><tr><th>题目</th><th>状态</th><th>调用与用量</th></tr></thead><tbody>{batch.jobs.map(j=><tr key={j.jobId}><td><button disabled={!j.problemKey} onClick={()=>navigate('bank',j.problemKey!)}>{j.problemKey?.split('||').at(-1)??'材料已不可读'}</button></td><td>{j.status?names[j.status]??j.status:'不可读'}{j.errorCode?' / '+j.errorCode:''}</td><td>{j.calls.length} 次；{j.usage?j.usage.promptTokens+' 输入 / '+j.usage.completionTokens+' 输出 tokens':'尚无已知用量'}{j.uncertainAttempts>0?'；未知 '+j.uncertainAttempts+' 次':''}</td></tr>)}</tbody></table></div></>}
 {!batchId&&!prepared&&<Empty>在题库勾选要分析的题目，已有平台标签的题目也可以分析。</Empty>}</Panel>
 <details><summary>浏览待人工审核题目</summary><Bank reviewOnly/></details></>;
}
