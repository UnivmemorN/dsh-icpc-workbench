import { abilityHistoryLabel, abilityPeriodValue } from './ability-history-view.js';
import {useEffect,useRef,useState} from 'react';
import type {ApiResponse} from '../application/workbench-api.js';
import type {WorkbenchPlanTaskView,WorkbenchPlanView} from '../application/workbench-types.js';
import {api,ApiClientError} from './api.js';
import {Panel,Notice,Empty,ErrorNotice,ExternalLink,Stats,useAction,useRequest,useWorkbench,tagName,usePollAfterSettle,errorText} from './common.js';
import {
 AI_PLAN_DEFAULTS,CANDIDATE_SCOPE_LABELS,DEFAULT_PLANNING_MODE,PLANNING_CANDIDATE_SPOILER_NOTE,PLANNING_CONFIG_NOTE,
 PLANNING_GENERATE_LABEL,PLANNING_HISTORY_NOTE,PLANNING_MODE_LABELS,PLANNING_PAID_DISCLOSURE_NOTE,PLANNING_PREPARE_FREE_NOTE,RULE_PLAN_DEFAULTS,
 adoptPreparation,candidateScopeNotice,candidateScopeValidation,defaultCandidateScope,isTerminalAttempt,newPlanningRequestId,
 planningAbilitySummary,planningCancelText,planningCandidateRequest,planningErrorText,planningInputSignature,planningRetryText,
 planningRunNote,planningStatusLabel,planningUsageText,shouldPollPlanning,trackedForAccount,validateAiDraft,validateRuleDraft,
 type CandidateScope,type PlanningDraft,type PlanningMode,type RuleDraft,type TrackedPlanningRequest,
} from './planning-view.js';
const kinds={solve:'做题',review:'复习',upskill:'专题提高'} as const;
function PlanTask({task,plan,onChange}:{task:WorkbenchPlanTaskView;plan:WorkbenchPlanView;onChange:()=>void}){
 const {accountId,boot,navigate}=useWorkbench(),action=useAction(),[editing,setEditing]=useState(false),[day,setDay]=useState(task.day),[minutes,setMinutes]=useState(task.minutes),[kind,setKind]=useState(task.kind);
 const valid=Number.isInteger(day)&&day>=1&&day<=plan.horizonDays&&Number.isInteger(minutes)&&minutes>=1&&minutes<=plan.minutesPerDay;
 const cas={planId:plan.planId,accountId:accountId!,expectedHash:plan.contentHash,taskId:task.taskId};
 return <article className="icpc-task"><div className="icpc-toolbar"><strong>第 {task.day} 天 · {task.minutes} 分钟</strong><span className="icpc-tag">{kinds[task.kind]}</span><button onClick={()=>navigate('bank',task.problemKey)}>{task.title}</button><ExternalLink href={task.sourceUrl}>原题</ExternalLink><span>{task.status==='planned'?'待完成':task.status==='done'?'已打卡':'已跳过'}</span></div>
 {task.taxonomyIds&&<p className="icpc-muted">{task.taxonomyIds.map(t=>tagName(t,boot)).join('、')} · {task.rationale}</p>}
 <ErrorNotice error={action.error}/><div className="icpc-actions"><button disabled={action.busy||task.status!=='planned'} onClick={()=>setEditing(v=>!v)}>{editing?'收起编辑':'调整安排'}</button>{plan.status==='adopted'&&(['done','skipped'] as const).map(status=><button key={status} disabled={action.busy||task.status!=='planned'} onClick={()=>{void action.run(async signal=>{await api.request('plan.checkoff',{...cas,status},signal);onChange();return true;});}}>{status==='done'?'完成打卡':'跳过此项'}</button>)}</div>
 {editing&&<form className="icpc-toolbar" onSubmit={e=>{e.preventDefault();void action.run(async signal=>{await api.request('plan.edit',{...cas,patch:{day,minutes,kind}},signal);setEditing(false);onChange();return true;});}}><label>第几天<input type="number" min="1" max={plan.horizonDays} value={day} onChange={e=>setDay(Number(e.target.value))}/></label><label>分钟<input type="number" min="1" max={plan.minutesPerDay} value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></label><label>类型<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}>{Object.entries(kinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><button disabled={!valid||action.busy}>保存调整</button></form>}
 </article>;
}
/** Transport failure rendered with the stable Chinese planning copy when the code is known. */
function PlanningFailure({error}:{error:unknown}){
 return error?<div className="icpc-notice icpc-error" role="alert">{planningErrorText(error instanceof ApiClientError?error.code:null,errorText(error))}</div>:null;
}
/**
 * Training-plan page.
 *
 * Two explicit modes share one plan store. The default mode is AI planning: a **free** durable
 * preparation first (`plan.aiPrepare`, no model call), then one explicit paid call
 * (`plan.aiRun`) whose settings revision, provider, model and candidate pool all come from the
 * preparation, never from a guessed current value. The legacy rule mode keeps its own preview,
 * title contract and old bounds, and the saved-plan panel below is reachable in both modes, so an
 * AI failure never hides existing plans. Nothing on this page dispatches a paid call on mount, on
 * mode/view switching, on preparation, on history loading or on polling; the only paid trigger is
 * the explicit generate button.
 */
export function Plans(){
 const {accountId,selectedKeys,navigate,boot}=useWorkbench(),action=useAction();
 const [mode,setMode]=useState<PlanningMode>(DEFAULT_PLANNING_MODE);
 const [reveal,setReveal]=useState(false);
 const [draft,setDraft]=useState<PlanningDraft>(()=>({...AI_PLAN_DEFAULTS}));
 const [scope,setScope]=useState<CandidateScope>(()=>defaultCandidateScope(selectedKeys));
 const [prepared,setPrepared]=useState<ApiResponse<'plan.aiPrepare'>|null>(null);
 const [preparedSignature,setPreparedSignature]=useState<string|null>(null);
 const [tracked,setTracked]=useState<TrackedPlanningRequest|null>(null);
 const [runNote,setRunNote]=useState<string|null>(null),[cancelNote,setCancelNote]=useState<string|null>(null);
 const [rule,setRule]=useState<RuleDraft>(()=>({...RULE_PLAN_DEFAULTS}));
 const [preview,setPreview]=useState<ApiResponse<'plan.preview'>|null>(null);
 const [id,setId]=useState<string|null>(null);
 const list=useRequest('plan.list',accountId?{accountId,reveal}:null),detail=useRequest('plan.detail',accountId&&id?{accountId,planId:id,reveal}:null),plan=detail.data;
 const history=useRequest('plan.aiHistory',accountId?{accountId,limit:20}:null);
 const trackedHere=trackedForAccount(tracked,accountId);
 const statusRead=useRequest('plan.aiStatus',accountId!==null&&trackedHere!==null?{requestId:trackedHere.requestId,accountId,reveal}:null);
 const candidateRequest=planningCandidateRequest(scope,selectedKeys),scopeCheck=candidateScopeValidation(scope,selectedKeys);
 const draftCheck=validateAiDraft(draft),ruleCheck=validateRuleDraft(rule);
 const signature=planningInputSignature({accountId:accountId??'',settingsRevision:boot.settings.revision,scope,selectedKeys,draft,reveal});
 const signatureRef=useRef(signature);signatureRef.current=signature;
 const currentPrepared=preparedSignature===signature?prepared:null;
 const view=currentPrepared?.outcome==='prepared'?currentPrepared.view:null,summary=view?planningAbilitySummary(view.ability):null;
 const statusData=statusRead.data,attempt=statusData?.status==='found'?statusData.attempt:null;
 const foundPlan=statusData?.status==='found'?statusData.plan:null,operation=statusData?.operation??null;
 const operationState=operation?.state??null,attemptStatus=attempt?.status??null;
 // `ownedRunning` survives an acknowledgement that arrives before the reservation exists, and the
 // two effects below retire it as soon as the owned operation or the durable attempt is terminal.
 const ownedRunning=trackedHere!==null&&trackedHere.ownedRunning&&operationState!=='settled';
 // A failed status read keeps its message and waits for the manual refresh button instead of
 // hammering the endpoint; the poll itself is free and never triggers a paid retry.
 const pollWanted=trackedHere!==null&&statusRead.error===null&&shouldPollPlanning({status:attemptStatus,operationState,ownedRunning});
 usePollAfterSettle(pollWanted,statusRead.pending,statusRead.refresh,1500);
 /** Any account, selection, scope, schedule, settings-revision or reveal change invalidates the visible preparation at once. */
 useEffect(()=>{setPrepared(null);},[signature]);
 useEffect(()=>{if(operationState==='settled'||(attemptStatus!==null&&isTerminalAttempt(attemptStatus)))setTracked(previous=>previous!==null&&previous.ownedRunning?{...previous,ownedRunning:false}:previous);},[operationState,attemptStatus]);
 const completedPlanId=attempt?.planId??null;
 /** A finished paid run selects its stored plan and refreshes the shared plan list/detail. */
 useEffect(()=>{if(completedPlanId!==null){setId(completedPlanId);list.refresh();}},[completedPlanId]);
 useEffect(()=>{if(operationState==='settled'||(attemptStatus!==null&&isTerminalAttempt(attemptStatus)))history.refresh();},[operationState,attemptStatus]);
 const update=()=>{detail.refresh();list.refresh();};
 const selectPlan=(planId:string|null)=>{if(planId===null)return;setId(planId);list.refresh();};
 const trackItem=(requestId:string)=>{if(accountId===null)return;setTracked({requestId,accountId,ownedRunning:false});setRunNote(null);setCancelNote(null);};
 const prepare=()=>{
  if(accountId===null||!draftCheck.valid||!scopeCheck.valid)return;
  const snapshot=signature;
  void action.run(async signal=>{
   const requestId=newPlanningRequestId();
   const value=await api.request('plan.aiPrepare',{requestId,accountId,settings:{...draft},candidateLimit:candidateRequest.candidateLimit,candidateProblemKeys:candidateRequest.candidateProblemKeys,reveal},signal);
   // A late answer of an older snapshot is ignored instead of being adopted as the current form.
   const adopted=adoptPreparation(value,snapshot,signatureRef.current);
   if(adopted===null)return value;
   setPreparedSignature(snapshot);setPrepared(adopted);setRunNote(null);setCancelNote(null);history.refresh();
   return value;
  });
 };
 const generate=()=>{
  if(accountId===null||view===null||view.status!=='prepared')return;
  const revision=view.settingsRevision,requestId=view.requestId;
  if(revision===null)return;
  void action.run(async signal=>{
   const result=await api.request('plan.aiRun',{requestId,accountId,expectedSettingsRevision:revision},signal);
   setTracked({requestId,accountId,ownedRunning:result.operation?.state==='running'});
   setPrepared(null);
   setRunNote(planningRunNote(result));setCancelNote(null);
   if(result.attempt?.planId)selectPlan(result.attempt.planId);
   statusRead.refresh();history.refresh();
   return result;
  });
 };
 const cancel=(requestId:string)=>{
  if(accountId===null)return;
  void action.run(async signal=>{
   const result=await api.request('plan.aiCancel',{requestId,accountId},signal);
   setCancelNote(planningCancelText(result));
   setTracked(previous=>previous!==null&&previous.requestId===requestId?{...previous,ownedRunning:false}:previous);
   statusRead.refresh();history.refresh();
   return result;
  });
 };
 const previewRule=()=>{
  if(accountId===null||!ruleCheck.valid)return;
  void action.run(async signal=>{
   const value=await api.request('plan.preview',{accountId,candidateProblemKeys:selectedKeys,title:rule.title,horizonDays:rule.horizonDays,minutesPerDay:rule.minutesPerDay,estimatedMinutes:rule.estimatedMinutes,reveal},signal);
   setPreview(value);if(value.outcome==='draft')setId(value.plan.planId);list.refresh();return value;
  });
 };
 return <><div className="icpc-page-heading"><div><p className="icpc-eyebrow">TRAINING PLAN</p><h1>把方向变成每天能完成的练习</h1><p>AI 计划默认免费准备、确认后才调用一次模型；也可以选择免费规则计划。确认采用后开始打卡。</p></div></div>
 {!accountId?<Empty>请先选择账号；AI 计划使用该账号自己的候选题与本地统计。</Empty>:<>
 <div className="icpc-viewswitch" role="group" aria-label="训练计划模式">
  <button type="button" aria-pressed={mode==='ai'} onClick={()=>setMode('ai')}>{PLANNING_MODE_LABELS.ai}</button>
  <button type="button" aria-pressed={mode==='rule'} onClick={()=>setMode('rule')}>{PLANNING_MODE_LABELS.rule}</button>
  <span className="icpc-muted">AI 计划：准备免费，生成付费；规则计划：全程不调用模型。</span>
 </div>
 {mode==='ai'?<>
 <Panel title="准备 AI 计划（免费）">
  <Notice>{PLANNING_PREPARE_FREE_NOTE}{PLANNING_PAID_DISCLOSURE_NOTE}{PLANNING_CONFIG_NOTE}</Notice>
  <PlanningFailure error={action.error}/>
  {currentPrepared?.outcome==='refused'&&<div className="icpc-notice icpc-error" role="alert">{planningErrorText(currentPrepared.error.code,'准备被拒绝。')}（{planningRetryText(currentPrepared.error.retryable)}）</div>}
  <form onSubmit={e=>{e.preventDefault();prepare();}}>
   <div className="icpc-form-grid">
    <label>天数（1–30）<input type="number" min="1" max="30" value={draft.horizonDays} onChange={e=>setDraft({...draft,horizonDays:Number(e.target.value)})}/></label>
    <label>每天分钟（1–480）<input type="number" min="1" max="480" value={draft.minutesPerDay} onChange={e=>setDraft({...draft,minutesPerDay:Number(e.target.value)})}/></label>
    <label>每日题量（1–3）<input type="number" min="1" max="3" value={draft.maxTasksPerDay} onChange={e=>setDraft({...draft,maxTasksPerDay:Number(e.target.value)})}/></label>
    <label>每题预计分钟（1–每天分钟）<input type="number" min="1" max={draft.minutesPerDay} value={draft.estimatedMinutes} onChange={e=>setDraft({...draft,estimatedMinutes:Number(e.target.value)})}/></label>
   </div>
   <div className="icpc-form-grid">
    <label>候选题范围<select value={scope} onChange={e=>setScope(e.target.value as CandidateScope)}>
     <option value="selected">{CANDIDATE_SCOPE_LABELS.selected}（{selectedKeys.length} 道）</option>
     <option value="auto">{CANDIDATE_SCOPE_LABELS.auto}</option>
    </select></label>
    <label className="icpc-plan-check"><input type="checkbox" checked={reveal} onChange={e=>{setReveal(e.target.checked);setPrepared(null);}}/>显示候选平台原始标签与计划算法提示（未复核，可选剧透）</label>
   </div>
   <p className="icpc-muted">{candidateScopeNotice(scope,selectedKeys)}</p>
   {!draftCheck.valid&&<p className="icpc-plan-invalid" role="status">{draftCheck.message}</p>}
   {!scopeCheck.valid&&<p className="icpc-plan-invalid" role="status">{scopeCheck.message}</p>}
   <div className="icpc-actions">
    <button className="icpc-primary" disabled={action.busy||!draftCheck.valid||!scopeCheck.valid} aria-busy={action.busy}>{action.busy?'正在准备…':'免费准备'}</button>
    <button type="button" onClick={()=>navigate('bank')}>去题库选择候选题</button>
    {prepared!==null&&<button type="button" disabled={action.busy} onClick={()=>setPrepared(null)}>清除本页准备结果</button>}
   </div>
   {prepared!==null&&<p className="icpc-muted">清除只隐藏本页显示；已保存的免费准备仍可在下方“最近的 AI 计划记录”中取消。</p>}
  </form>
  {view&&summary&&<div className="icpc-plan-prepared">
   <h3>准备记录（{planningStatusLabel(view.status)}）</h3>
   <div className="icpc-plan-meta">
    <span>请求：{view.requestId}</span><span>准备时间：{new Date(view.preparedAt).toLocaleString()}</span>
    <span>设置版本：{view.settingsRevision??'未捕获（无法付费生成）'}</span><span>候选上限：{view.exclusions.candidateLimit}</span>
   </div>
   <p className="icpc-muted">数据披露：{view.disclosure}。一次生成只发起一次模型调用，费用取决于输入和输出用量；候选原始标签只是临时参考。</p>
   <Stats items={[
    {label:'能力评估（聚合）',value:summary.headline},
    {label:'练习样本 P25–P75',value:summary.band},
    {label:'样本',value:summary.sample},
    {label:'水平来源',value:summary.confidence},
   ]}/>
   {summary.native.length>0&&<ul className="icpc-diagnosis">{summary.native.map(line=><li key={line}>{line}</li>)}</ul>}
   {view.ability.history && <p className="icpc-muted">AI 同时读取历史与近期练习分布：
    {view.ability.history.periods.map(period => abilityHistoryLabel(period.period, view.ability.history!.recentWindowDays) + '：' + abilityPeriodValue(period, view.ability.platform) + '（有效 ' + period.eligibleDistinct + ' 题）').join('；')}。
   </p>}
   <div className="icpc-actions"><button type="button" onClick={()=>navigate('weakness')}>查看完整能力评估</button></div>
   <div className="icpc-plan-meta">
    <span>提供方：{view.generator.provider}</span><span>模型：{view.generator.model}</span><span>推理强度：{view.generator.effort}</span>
    <span>输出上限：{view.generator.maxOutputTokens} tokens</span><span>24 小时计划调用上限：{view.generator.maxCallsPer24Hours}（与提示各自计数）</span>
    <span>并发上限：{view.generator.maxConcurrent}</span><span>请求超时：{view.generator.requestTimeoutMs} 毫秒</span>
   </div>
   <p className="icpc-muted">已通过排除 {view.exclusions.nativeSolvedExcluded} 道 · 重复题目 {view.exclusions.duplicateExcluded} 道 · 非本来源 {view.exclusions.foreignExcluded} 道 · 参与筛选 {view.exclusions.considered} 道 · 实际候选 {view.candidates.length} 道（上限 {view.exclusions.candidateLimit}）。</p>
   <details className="icpc-coverage" open>
    <summary>实际候选题（{view.candidates.length} 道）</summary>
    {view.candidates.length===0?<Empty>准备中没有可用的真实候选题。</Empty>:<div className="icpc-table-wrap"><table className="icpc-plan-candidates">
     <thead><tr><th>题目</th><th>预计分钟</th><th>原生难度</th>{view.spoilersVisible&&<th>临时标签（未复核）</th>}</tr></thead>
     <tbody>{view.candidates.map(c=><tr key={c.candidateId}>
      <td><button type="button" onClick={()=>navigate('bank',c.problemKey)}>{c.title}</button><span className="icpc-muted">{c.externalKey}</span><ExternalLink href={c.url}>原题</ExternalLink></td>
      <td>{c.estimatedMinutes}</td>
      <td>{c.ratings.map(r=>`${r.dimension} ${r.raw}`).join('；')||'未提供'}</td>
      {view.spoilersVisible&&<td>{c.taxonomyIds?.map(id=>tagName(id,boot)).join('、')||'暂无已复核标签'}{c.provisionalRawTags&&c.provisionalRawTags.length>0&&<span className="icpc-tag">临时原始标签：{c.provisionalRawTags.join('、')}</span>}</td>}
     </tr>)}</tbody>
    </table></div>}
    <p className="icpc-muted">{PLANNING_CANDIDATE_SPOILER_NOTE}{view.spoilersVisible?'':'候选的算法标签与平台原始标签默认隐藏：勾选剧透开关后，请重新点击“免费准备”查看标签。'}</p>
   </details>
   <div className="icpc-actions">
    <button className="icpc-primary" disabled={action.busy||view.status!=='prepared'||view.settingsRevision===null} onClick={generate}>{PLANNING_GENERATE_LABEL}</button>
    <button type="button" disabled={action.busy} onClick={()=>cancel(view.requestId)}>取消这次准备（免费）</button>
   </div>
   {view.status!=='prepared'&&<p className="icpc-muted">该准备已经不在“已准备”状态，不能再发起付费生成；请重新免费准备。</p>}
   {view.settingsRevision===null&&<p className="icpc-muted">准备时没有捕获到已保存的设置版本：请到设置页保存一次设置，再重新免费准备，之后才能付费生成。</p>}
  </div>}
 </Panel>
 {trackedHere&&<Panel title="当前 AI 计划请求">
  <div className="icpc-plan-meta">
   <span>请求：{trackedHere.requestId}</span>
   {attempt&&<span>状态：{planningStatusLabel(attempt.status)}</span>}
   {attempt&&<span>候选：{attempt.candidateCount} 道</span>}
   {attempt&&<span>请求时间：{new Date(attempt.requestedAt).toLocaleString()}</span>}
   {attempt?.finishedAt&&<span>结算时间：{new Date(attempt.finishedAt).toLocaleString()}</span>}
  </div>
  {attempt&&<p className="icpc-plan-usage">{planningUsageText(attempt)}</p>}
  {attempt?.error&&attempt.status!=='cancelled'&&<div className="icpc-notice icpc-error" role="alert">{planningErrorText(attempt.error.code,'调用失败。')}（{planningRetryText(attempt.error.retryable)}）</div>}
  {attempt?.status==='cancelled'&&<Notice>已取消：这次准备在调用模型前被放弃，未产生费用；如果调用已经预留，费用以结算记录为准。</Notice>}
  {operation&&<p className="icpc-muted">生成任务：{operationState==='running'?'运行中':'已结束'}（设置版本 {operation.settingsRevision??'未知'}）{operation.errorCode&&` · ${planningErrorText(operation.errorCode,'调用失败。')}`}</p>}
  {statusData?.status==='unknown'&&<Notice>该请求对当前账号不可见：可能不存在，或不属于当前账号。</Notice>}
  {foundPlan&&<p>已保存计划：<strong>{foundPlan.title}</strong> · {foundPlan.taskCount} 项 / {foundPlan.totalPlannedMinutes} 分钟。<button type="button" onClick={()=>selectPlan(foundPlan.planId)}>在下方查看结果</button></p>}
  {runNote&&<Notice>{runNote}</Notice>}
  {cancelNote&&<Notice>{cancelNote}</Notice>}
  <PlanningFailure error={statusRead.error}/>
  <div className="icpc-actions">
   <button type="button" disabled={statusRead.pending} onClick={()=>{statusRead.refresh();history.refresh();}}>{statusRead.pending?'正在读取…':'刷新状态'}</button>
   {(attempt===null||attempt.status==='prepared'||attempt.status==='reserved'||ownedRunning)&&<button type="button" disabled={action.busy} onClick={()=>cancel(trackedHere.requestId)}>取消本次任务</button>}
   {attempt?.status==='prepared'&&<button type="button" disabled={action.busy||!draftCheck.valid||!scopeCheck.valid} onClick={prepare}>按当前表单重新准备（免费）</button>}
   <button type="button" onClick={()=>{setTracked(null);setRunNote(null);setCancelNote(null);}}>停止跟踪</button>
  </div>
 </Panel>}
 <Panel title="最近的 AI 计划记录" tools={<button type="button" disabled={history.pending} onClick={history.refresh}>{history.pending?'正在读取…':'刷新记录'}</button>}>
  <Notice>{PLANNING_HISTORY_NOTE}</Notice>
  <PlanningFailure error={history.error}/>
  {history.data===null?<Empty>正在读取记录，或该账号还没有记录。</Empty>:history.data.items.length===0?<Empty>当前账号还没有 AI 计划请求记录。</Empty>:<div className="icpc-table-wrap"><table className="icpc-plan-history">
   <thead><tr><th>时间 / 请求</th><th>状态</th><th>候选</th><th>用量</th><th>操作</th></tr></thead>
   <tbody>{history.data.items.map(item=><tr key={item.requestId}>
    <td>{new Date(item.requestedAt).toLocaleString()}<span className="icpc-muted">{item.requestId}</span></td>
    <td>{planningStatusLabel(item.status)}{item.error&&item.status!=='cancelled'&&<span className="icpc-muted">{planningErrorText(item.error.code,'调用失败。')}</span>}{item.planId!==null&&<span className="icpc-muted">已保存计划</span>}</td>
    <td>{item.candidateCount}</td>
    <td className="icpc-plan-usage">{planningUsageText(item)}</td>
    <td><div className="icpc-plan-actions">
     <button type="button" onClick={()=>trackItem(item.requestId)}>查看状态</button>
     {item.planId!==null&&<button type="button" onClick={()=>selectPlan(item.planId)}>查看结果</button>}
     {(item.status==='prepared'||item.status==='reserved')&&<button type="button" disabled={action.busy} onClick={()=>cancel(item.requestId)}>取消</button>}
    </div></td>
   </tr>)}</tbody>
  </table></div>}
  <p className="icpc-muted">共 {history.data?.total??0} 条（本页最多显示最近 20 条）。记录按当前账号读取；状态未知的请求不会显示内容。</p>
 </Panel>
 </>:<Panel title="生成规则计划草案（不调用模型）">
  <p>已选 {selectedKeys.length} 道真实候选题。规则生成不调用模型；可自行填写标题和每日时间。</p>
  <ErrorNotice error={action.error}/>
  <form onSubmit={e=>{e.preventDefault();previewRule();}}>
   <div className="icpc-form-grid">
    <label>标题<input value={rule.title} maxLength={200} onChange={e=>setRule({...rule,title:e.target.value})}/></label>
    <label>天数<input type="number" min="1" max="30" value={rule.horizonDays} onChange={e=>setRule({...rule,horizonDays:Number(e.target.value)})}/></label>
    <label>每天分钟<input type="number" min="1" max="1440" value={rule.minutesPerDay} onChange={e=>setRule({...rule,minutesPerDay:Number(e.target.value)})}/></label>
    <label>每题预计分钟<input type="number" min="1" max={rule.minutesPerDay} value={rule.estimatedMinutes} onChange={e=>setRule({...rule,estimatedMinutes:Number(e.target.value)})}/></label>
   </div>
   {!ruleCheck.valid&&<p className="icpc-plan-invalid" role="status">{ruleCheck.message}</p>}
   <div className="icpc-actions"><button className="icpc-primary" disabled={action.busy||!ruleCheck.valid}>预览规则草案</button><button type="button" onClick={()=>navigate('bank')}>选择候选题</button></div>
  </form>
  {preview?.outcome==='insufficient_evidence'&&<Notice>没有足够的有效候选题，未保存计划。可先练习：{preview.beginnerRecommendations.map(t=>tagName(t.taxonomyId,boot)).join('、')||'先补充题目与有效标签'}。</Notice>}
  {preview&&preview.rejectedCandidates.length>0&&<details><summary>查看未纳入候选（{preview.rejectedCandidates.length}）</summary>{preview.rejectedCandidates.map((c,i)=><p key={i}>{c.candidateId?.split('||').at(-1)??'候选'}：{c.reason} · {c.detail}</p>)}</details>}
 </Panel>}
 <Panel title="已保存计划"><ErrorNotice error={list.error}/><label>选择计划<select value={id??''} onChange={e=>setId(e.target.value||null)}><option value="">请选择</option>{list.data?.plans.map(p=><option key={p.planId} value={p.planId}>{p.title} · {p.status==='draft'?'草案':'已采用'} · {new Date(p.createdAt).toLocaleDateString()}</option>)}</select></label><div className="icpc-toolbar"><label className="icpc-check"><input type="checkbox" checked={reveal} onChange={e=>setReveal(e.target.checked)}/>显示计划中的算法提示与候选临时标签（未复核）</label><button onClick={update}>刷新计划</button></div><ErrorNotice error={detail.error}/>
 {plan?<><h3>{plan.title}</h3><Notice>{plan.horizonDays} 天，共 {plan.taskCount} 项 / {plan.totalPlannedMinutes} 分钟。候选不足而未安排 {plan.totalUnmetMinutes} 分钟。依据：{plan.evidence.level==='personal_history'?'已有训练记录':'历史样本不足'}；已尝试 {plan.evidence.attemptedDistinctTotal} 道题。{plan.source==='model'?'此计划由 AI 生成（未经验证），采用前请自行检查。':''}</Notice><p className="icpc-muted">打卡只记录计划执行，不会把题目改成评测通过。</p>{plan.status==='draft'&&<button className="icpc-primary" disabled={action.busy} onClick={()=>{void action.run(async signal=>{await api.request('plan.adopt',{accountId,planId:plan.planId,expectedHash:plan.contentHash},signal);update();return true;});}}>采用这份计划</button>}{plan.tasks.map(task=><PlanTask key={task.taskId+'|'+plan.contentHash} task={task} plan={plan} onChange={update}/>)}</>:<Empty>选择一份草案或已采用的计划查看安排。</Empty>}</Panel>
 </>}</>;
}
