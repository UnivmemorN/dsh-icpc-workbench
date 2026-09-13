import{useState}from'react';
import{api}from'./api.js';
import{ErrorNotice,ExternalLink,Notice,useAction,useWorkbench}from'./common.js';
import{USER_ANSWER_SOURCE_EXAMPLES,USER_ANSWER_ANALYSIS_NOTE,USER_ANSWER_ASSOCIATED_URL_NOTE,USER_ANSWER_LOCAL_ONLY_NOTE,USER_ANSWER_SOURCE_URL_NOTE,defaultUserAnswerDraft,safeUserAnswerUrl,userAnswerProvenance,userAnswerRequest,validateUserAnswerDraft}from'./user-answer-view.js';
/**
 * Dedicated entry for an answer the user obtained elsewhere (GPT6, a teacher, their own write-up).
 *
 * It is a visible panel, not a hidden reveal step: pasting is a local write that must stay possible
 * while spoilers are withheld. Saving calls the one additive `material.supplement` answer input and
 * makes no model call; the panel says so, names the stored note, and renders the distinction between
 * a user-supplied citation and the associated problem link. A failed save keeps the draft, including
 * the exact text, so nothing the user typed is lost to a refusal.
 */
export function UserAnswer({problemKey,snapshotId,hasStatement,onChange}:{problemKey:string;snapshotId:string|null;hasStatement:boolean;onChange:()=>void}){
 const {navigate,setSelectedKeys}=useWorkbench();
 const action=useAction(),[draft,setDraft]=useState(defaultUserAnswerDraft),[saved,setSaved]=useState<{version:number}|null>(null);
 const check=validateUserAnswerDraft(draft),citation=safeUserAnswerUrl(draft.url);
 const update=(patch:Partial<typeof draft>)=>{setDraft(current=>({...current,...patch}));setSaved(null);};
 const save=()=>{const answer=userAnswerRequest(draft);if(answer===null)return;void action.run(async signal=>{
  const result=await api.request('material.supplement',{problemKey,expectedSnapshotId:snapshotId,answer},signal);
  setDraft(defaultUserAnswerDraft());setSaved({version:result.snapshot.version});onChange();return true;
 });};
 return <details className="icpc-user-answer"><summary>粘贴外部答案 / 用户提供解析</summary>
 <p className="icpc-muted">把你在别处得到的解答原文粘贴进来，作为<b>用户提供来源</b>保存：来源标注由你填写，正文按原样保留。{USER_ANSWER_LOCAL_ONLY_NOTE}</p>
 <label>来源标注<input disabled={action.busy} value={draft.sourceLabel} maxLength={200} placeholder={USER_ANSWER_SOURCE_EXAMPLES.join(' / ')} onChange={e=>update({sourceLabel:e.target.value})}/></label>
 <label>来源链接（可选，仅作标注，不会抓取）<input disabled={action.busy} value={draft.url} onChange={e=>update({url:e.target.value})} placeholder="https://…"/></label>
 <label>答案正文（原样保存，支持 Markdown / 代码）<textarea disabled={action.busy} aria-label="答案正文" rows={10} value={draft.text} onChange={e=>update({text:e.target.value})}/></label>
 <p className="icpc-muted">{citation===undefined?USER_ANSWER_ASSOCIATED_URL_NOTE:USER_ANSWER_SOURCE_URL_NOTE}{check.message?' '+check.message:''}</p>
 <ErrorNotice error={action.error}/>
 <div className="icpc-actions"><button disabled={action.busy||!check.valid} onClick={save}>保存为本地用户提供解析</button></div>
 {saved&&<Notice>已保存为快照 v{saved.version} 的用户提供来源：本插件未核验其正确性，也未采用任何标签。
{USER_ANSWER_LOCAL_ONLY_NOTE}
{USER_ANSWER_ANALYSIS_NOTE}<div className="icpc-actions"><button onClick={()=>{setSelectedKeys([problemKey]);navigate('review');}}>选中此题并前往标签审核</button></div></Notice>}
 {!hasStatement&&<Notice>当前缺少完整题面：粘贴内容照常保存，但分析通常需要完整题面，请先刷新或手工补充。</Notice>}
 </details>;
}
/**
 * One revealed user-provided source, rendered with its honest provenance.
 *
 * The stored note is shown verbatim and the link is named by what it really is: the answer's own
 * citation when the user supplied one, otherwise the associated problem page. The body stays inside
 * a `pre` element, so pasted Markdown or code is text and is never executed as HTML.
 */
export function UserAnswerSource({source}:{source:{sourceId:string;url:string;title:string;note:string|null;kind:string}}){
 const provenance=userAnswerProvenance(source);
 if(!provenance.userProvided)return <><ExternalLink href={source.url}>{source.title}</ExternalLink> · {source.kind}</>;
 return <article className="icpc-user-answer-source"><h4>{source.title}</h4>
 <p className="icpc-muted">{provenance.note}</p>
 <p className="icpc-muted">{provenance.origin==='problem'?USER_ANSWER_ASSOCIATED_URL_NOTE:USER_ANSWER_SOURCE_URL_NOTE} <ExternalLink href={source.url}>{provenance.origin==='problem'?'题目链接':'来源链接'}</ExternalLink></p></article>;
}
