import {useEffect,useState} from 'react';
import type {ApiResponse} from '../application/workbench-api.js';
import {api} from './api.js';
import {Bank} from './Bank.js';
import {Panel,Notice,Empty,ErrorNotice,useAction,useRequest,useWorkbench} from './common.js';
import {MATERIALS_BLOCKED_CODE,MATERIAL_ACTION_HINT_TEXT,MATERIAL_BLOCKS_NOTICE_TEXT,NO_RUNNABLE_BATCH_TEXT,PREPARED_BLOCKED_ELSEWHERE_TEXT,RECOVER_HINT_TEXT,REVIEW_SCOPE_LOADING_TEXT,batchStartState,blockedCountText,diagnosticText,failureCodeOf,prepareSummary,preparedBlockedRows,preparedStartState,problemLabel,reviewMaterialScope} from './review-view.js';
import {BulkMaterialRefresh} from './BulkMaterialRefresh.js';
import {OLD_ANALYSIS_BATCH_TEXT,materialScopeIdentity,refreshMaterialProblemKeys,refreshMaterialScopeText} from './material-batch-view.js';
const names:Record<string,string>={pending:'待开始',running:'运行中',paused:'已暂停',completed:'已完成',cancelled:'已取消',failed:'失败',needs_review:'待人工审核',succeeded:'已分析',quota_exhausted:'额度已用完'};
const rerunReasons:Record<string,string>={legacy_unchecked:'旧结果未记录当前完整性检查',cancelled_run:'旧任务已取消',reanalyze_requested:'按你的要求强制重跑'};
export function Review(){
 const {selectedKeys,boot,navigate,accountId}=useWorkbench(),action=useAction(),list=useRequest('batch.list',{limit:50});
 const [prepared,setPrepared]=useState<ApiResponse<'batch.prepare'>|null>(null),[batchId,setBatchId]=useState<string|null>(null),[maxJobs,setMaxJobs]=useState(20),[reanalyze,setReanalyze]=useState(false),[recovered,setRecovered]=useState<ApiResponse<'batch.recover'>|null>(null),[materialScopeOpen,setMaterialScopeOpen]=useState<string|null>(null);
 const detail=useRequest('batch.detail',batchId?{batchId}:null),live=detail.data?.operation?.state==='running';
 useEffect(()=>{if(!live)return;const timer=setInterval(()=>detail.refresh(),1500);return()=>clearInterval(timer);},[live,batchId]);
 const update=()=>{detail.refresh();list.refresh();};
 const batch=detail.data?.batch;
 const stored=batchStartState(batch,live),fresh=preparedStartState(prepared);
 // The paid start is offered only for the batch this session just prepared: the settings revision
 // it was validated against belongs to that preparation, so an older stored batch must be prepared
 // again rather than started with a revision it never captured.
 const canStart=stored.canStart&&fresh.canStart&&prepared?.batchId===batchId;
 // Blocked rows belong to the selected batch only: the free-preparation answer is used while its own
 // batchId is selected, the stored detail while it describes that same batch. A changed selection
 // therefore contributes nothing from the previous batch, not even while the new detail is loading.
 const scope=reviewMaterialScope({selectedBatchId:batchId,prepared,detail:detail.data,detailPending:detail.pending});
 const materialRows=scope.rows;
 const preparedRows=preparedBlockedRows(prepared,batchId);
 // Only refresh_materials rows of the current scope become a platform refresh; the supplement rows
 // stay hand-supplied local writes and are never folded into this scope.
 const refreshScope=refreshMaterialProblemKeys(materialRows);
 // The reusable material panel owns its own durable batch id, so it is pinned to the identity of the
 // analysis scope it was opened for. A changed analysis batch or refresh-key scope closes it, and a
 // reopen mounts a fresh panel, so no control can start/cancel/retry a prior scope's material batch
 // while the new scope's text is shown.
 const panelScope=materialScopeIdentity(batchId,refreshScope.keys);
 const panelOpen=materialScopeOpen!==null&&materialScopeOpen===panelScope&&refreshScope.ready;
 const summary=prepared?prepareSummary(prepared):null;
 const refusal=failureCodeOf(action.error)===MATERIALS_BLOCKED_CODE?MATERIALS_BLOCKED_CODE:null;
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
 <Panel title="标签分析批次"><ErrorNotice error={action.error}/>{refusal&&<Notice>{MATERIAL_BLOCKS_NOTICE_TEXT}</Notice>}<p>已选 {selectedKeys.length} 题。准备操作只建立任务；开始运行后才调用模型。默认只补查尚未完成当前版本完整性检查的题目；已有平台标签的题目同样可以入选。只有题解可用或已确认无题解且题面完整的题目才会建立任务。</p><div className="icpc-toolbar"><label>本批最多题数<input type="number" min="1" max="100" value={maxJobs} onChange={e=>setMaxJobs(Number(e.target.value))}/></label><label><input className="icpc-check" type="checkbox" checked={reanalyze} onChange={e=>setReanalyze(e.target.checked)}/>重新分析（保留旧结果）</label><button disabled={action.busy||!selectedKeys.length||!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>100} onClick={()=>{void action.run(async signal=>{const value=await api.request('batch.prepare',{problemKeys:selectedKeys,maxJobs,reanalyze},signal);setPrepared(value);setBatchId(value.batchId);list.refresh();return value;});}}>免费准备批次</button><button onClick={()=>navigate('bank')}>去题库选择</button></div>
 {prepared&&summary&&<Notice><p>{prepared.provider} · 分析 {prepared.models.analysis} · 复核 {prepared.models.verification} · 无题解推理 {prepared.models.reasoning} · max</p><p>可运行的新任务 {summary.runnableJobs}；已完成且检查仍有效 {summary.alreadyDone}；重新分析 {summary.reruns}；{blockedCountText(summary.blocked)}。</p><p>已找到题解 {summary.ready}；已明确无题解 {summary.absent}；材料错误 {summary.error}。</p><p>模型调用硬上限：分析/复核 {summary.analysisCalls} 次、推理 {summary.reasoningCalls} 次（含重试）。这不是费用预测。</p>{summary.empty&&<p>{NO_RUNNABLE_BATCH_TEXT}</p>}{summary.alreadyDone>0&&<p>跳过仅表示这些题目的当前快照已完成当前版本完整性检查；它不代表所有标签都已正确，旧版结果或缺少检查记录的任务不会被当作已完成。</p>}{summary.reruns>0&&<p>重跑：{prepared.reruns.map(r=>rerunReasons[r.reason]??r.reason).join('、')}（每题都会建立独立的新任务，旧任务、旧结果与旧标签历史全部保留）。</p>}{summary.blocked>0&&<p>{MATERIAL_ACTION_HINT_TEXT}</p>}
 {preparedRows.length>0&&<div className="icpc-table-wrap"><table><thead><tr><th>题目</th><th>材料状态与处理</th></tr></thead><tbody>{preparedRows.map(b=><tr key={b.problemKey}><td><button type="button" onClick={()=>navigate('bank',b.problemKey)}>{problemLabel(b.problemKey)}</button></td><td>{b.text}<button type="button" onClick={()=>navigate('bank',b.problemKey)}>{b.actionText}</button></td></tr>)}</tbody></table></div>}
 {prepared.blocked.length>0&&preparedRows.length===0&&<p className="icpc-muted">{PREPARED_BLOCKED_ELSEWHERE_TEXT}</p>}
 </Notice>}
 <label>查看已保存批次<select value={batchId??''} onChange={e=>{setBatchId(e.target.value||null);setRecovered(null);}}><option value="">请选择</option>{list.data?.items.map(b=><option key={b.batchId} value={b.batchId}>{new Date(b.createdAt).toLocaleString()} · {b.jobCount} 题 · {names[b.status]??b.status}</option>)}</select></label><ErrorNotice error={list.error}/><ErrorNotice error={detail.error}/>
 {batch&&<><div className="icpc-actions"><strong>{names[batch.status]??batch.status}</strong><button className="icpc-primary" disabled={action.busy||!canStart} onClick={()=>void control('batch.run')}>确认开始付费分析</button><button disabled={action.busy||!live} onClick={()=>void control('batch.pause')}>暂停</button><button disabled={action.busy||live||!stored.canResume} onClick={()=>void control('batch.resume')}>确认继续付费分析</button><button disabled={action.busy||['completed','cancelled'].includes(batch.status)} onClick={()=>void control('batch.cancel')}>取消批次</button><button disabled={action.busy||live||['completed','cancelled'].includes(batch.status)} onClick={()=>void control('batch.recover')}>恢复中断状态</button><button onClick={update}>刷新状态</button></div>
 <p className="icpc-muted">{RECOVER_HINT_TEXT}</p>
 {materialRows.length>0&&<Notice><p>{MATERIAL_BLOCKS_NOTICE_TEXT}</p>{MATERIAL_ACTION_HINT_TEXT}<div className="icpc-table-wrap"><table><thead><tr><th>题目</th><th>材料状态与处理</th></tr></thead><tbody>{materialRows.map(row=><tr key={row.problemKey+row.reason}><td><button type="button" onClick={()=>navigate('bank',row.problemKey)}>{problemLabel(row.problemKey)}</button></td><td>{row.text}<button type="button" onClick={()=>navigate('bank',row.problemKey)}>{row.actionText}</button></td></tr>)}</tbody></table></div></Notice>}
 {materialRows.length===0&&batch.status==='pending'&&batch.jobs.length===0&&<Notice>{NO_RUNNABLE_BATCH_TEXT}</Notice>}
 <p className="icpc-muted">已计入 {batch.counters.analysisCalls} 次分析/复核、{batch.counters.reasoningCalls} 次推理。未知用量 {batch.uncertainAttempts} 次；未知费用不会当作零或自动退回。</p>
 {recovered&&<Notice>{recovered.batches.map(b=>'重新排队 '+b.requeuedJobs+' 题，未知用量 '+b.uncertainAttempts+' 次'+(b.skipped?'；仍有有效租约':'')).join('；')}。恢复状态后需要明确点击继续。</Notice>}
 <div className="icpc-table-wrap"><table><thead><tr><th>题目</th><th>状态</th><th>调用与用量</th></tr></thead><tbody>{batch.jobs.map(j=><tr key={j.jobId}><td><button disabled={!j.problemKey} onClick={()=>navigate('bank',j.problemKey!)}>{j.problemKey?problemLabel(j.problemKey):'材料已不可读'}</button></td><td>{j.status?names[j.status]??j.status:'不可读'}</td><td>{j.calls.length} 次；{j.usage?j.usage.promptTokens+' 输入 / '+j.usage.completionTokens+' 输出 tokens':'尚无已知用量'}{j.uncertainAttempts>0?'；未知 '+j.uncertainAttempts+' 次':''}</td></tr>)}</tbody></table></div>
 <details><summary>诊断信息</summary><p className="icpc-muted">{diagnosticText(batch.lastErrorCode??detail.data?.operation?.errorCode??'none')}</p><p className="icpc-muted">{batch.jobs.filter(j=>j.errorCode).map(j=>diagnosticText(j.errorCode!)).join('；')||'没有题目级错误码。'}</p></details></>}
 {!batchId&&!prepared&&<Empty>在题库勾选要分析的题目，已有平台标签的题目也可以分析。</Empty>}
 {scope.loading&&<p className="icpc-muted">{REVIEW_SCOPE_LOADING_TEXT}</p>}
 {refreshScope.total>0&&<Notice><p>{refreshMaterialScopeText(refreshScope)}</p><div className="icpc-actions"><button type="button" disabled={!refreshScope.ready||action.busy} title={refreshScope.ready?undefined:refreshMaterialScopeText(refreshScope)} onClick={()=>setMaterialScopeOpen(panelScope)}>批量刷新平台材料（不调用 AI）</button>{panelOpen&&<button type="button" onClick={()=>setMaterialScopeOpen(null)}>收起批量刷新面板</button>}</div><p className="icpc-muted">{OLD_ANALYSIS_BATCH_TEXT}</p></Notice>}
 </Panel>
 {panelOpen&&<BulkMaterialRefresh key={panelScope} problemKeys={refreshScope.keys} accountId={accountId} title="批量刷新平台材料（标签分析受阻材料）" scopeNote={refreshMaterialScopeText(refreshScope)} boundaryNote={<p>{OLD_ANALYSIS_BATCH_TEXT}</p>} onClose={()=>setMaterialScopeOpen(null)}/>}
 <details><summary>浏览待人工审核题目</summary><Bank reviewOnly/></details></>;
}
