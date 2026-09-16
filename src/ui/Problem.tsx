import{Coaching}from'./Coaching.js';import{Retrospective}from'./Retrospective.js';
import{UserAnswer,UserAnswerSource}from'./UserAnswer.js';
import{useState}from'react';
import type{ApiMaterialRefreshResult,ApiSupplementEditorial}from'../application/workbench-api.js';
import{api}from'./api.js';
import{Panel,Empty,Notice,ErrorNotice,ExternalLink,useWorkbench,useRequest,useAction,tagName}from'./common.js';
import{mirrorReuseView,materialAliasLinks,materialAliasSummary,parseMaterialAliasEvidence}from'./material-view.js';
import{MarkdownView}from'./MarkdownView.js';
import{nativeSolvedText}from'./merged.js';
import{rawTagListView,rawTagSourceOf,LUOGU_TAG_DICTIONARY_CAVEAT}from'./raw-tag-view.js';
import{LUOGU_TAG_DICTIONARY_ENTRY_COUNT,LUOGU_TAG_DICTIONARY_RETRIEVED_AT,LUOGU_TAG_DICTIONARY_SOURCE_URL}from'./luogu-tag-dictionary.js';
export function ProblemView({problemKey,onChange}:{problemKey:string;onChange:()=>void}){
 const {boot,accountId}=useWorkbench(),[reveal,setReveal]=useState(false),read=useRequest('problem.detail',{problemKey,accountId,reveal}),action=useAction();
 const [tutorial,setTutorial]=useState(''),[refreshed,setRefreshed]=useState<ApiMaterialRefreshResult|null>(null),[statement,setStatement]=useState(''),[materialMode,setMaterialMode]=useState<'statement'|'found'|'absent'>('statement');
 const [url,setUrl]=useState(''),[title,setTitle]=useState(''),[materialText,setMaterialText]=useState(''),[tag,setTag]=useState(''),[note,setNote]=useState('');
 const problem=read.data;
 const changed=()=>{read.refresh();onChange();};
 if(!problem)return <Panel title="题目详情"><ErrorNotice error={read.error}/>{read.pending?<p>正在读取题目…</p>:<button onClick={read.refresh}>重试</button>}</Panel>;
 // Raw-tag names are resolved only through this problem's own source instance; the opaque
 // `problemKey` is never parsed and raw text is never trusted on its own.
 const rawTagList=rawTagListView(problem.rawTags,rawTagSourceOf(problem.sourceInstanceId,boot.sources));
 return <Panel title={problem.externalKey+' · '+problem.title} tools={<ExternalLink href={problem.url}>原题</ExternalLink>}>
 <div className="icpc-tags">{problem.rawRatings.map((r,i)=><span key={i} className="icpc-tag">{r.dimension}：{r.raw??r.value}</span>)}<span className="icpc-tag">{nativeSolvedText(problem.solvedByAccount,accountId)}</span></div>
 <ErrorNotice error={action.error}/><h3>题面</h3>{problem.statement?<MarkdownView text={problem.statement} baseUrl={problem.url} label="题面" source={rawTagSourceOf(problem.sourceInstanceId,boot.sources)?.platform==='luogu'?'luogu':undefined}/>:<Empty>本地尚无完整题面，可刷新平台材料或手工补充。</Empty>}
 <p className="icpc-muted">{problem.snapshot?'快照 v'+problem.snapshot.version+' · '+problem.snapshot.sourceCount+' 个来源 · '+problem.snapshot.solutionCount+' 个解法':'尚未建立材料快照'}{problem.staleAnalysisCount?' · '+problem.staleAnalysisCount+' 份旧分析已过期':''}</p>
 {!problem.spoilersVisible?<Notice>算法标签和题解默认隐藏。<button onClick={()=>setReveal(true)}>显示算法标签与题解</button></Notice>:<>
 <h3>标签与来源</h3><p className="icpc-muted">平台原始标签（未经本插件核验）</p>{rawTagList===null?<p className="icpc-muted">本次响应未包含平台原始标签。</p>:rawTagList.items.length===0?<p className="icpc-muted">这道题还没有平台原始标签。</p>:<div className="icpc-tags">{rawTagList.items.map(item=><span key={JSON.stringify(item.raws)} className="icpc-tag">{item.label}</span>)}</div>}{rawTagList!==null&&rawTagList.raws.length>0&&<details><summary>查看原始标签编号（{rawTagList.raws.length} 条）</summary><p className="icpc-muted">{rawTagList.raws.join('、')}</p>{rawTagList.luoguSource&&<p className="icpc-muted">名称来自洛谷官方标签字典快照（<ExternalLink href={LUOGU_TAG_DICTIONARY_SOURCE_URL}>官方标签数据</ExternalLink>，核对日期 {LUOGU_TAG_DICTIONARY_RETRIEVED_AT}，共 {LUOGU_TAG_DICTIONARY_ENTRY_COUNT} 条）。{LUOGU_TAG_DICTIONARY_CAVEAT}</p>}</details>}<p className="icpc-muted">当前采用的标签</p><div className="icpc-tags">{problem.effectiveTaxonomyIds?.map(t=><span key={t} className="icpc-tag">{tagName(t,boot)}</span>)}</div>
 <details><summary>查看当前分析与证据</summary>{problem.analyses?.filter(a=>a.current).map(a=><div key={a.analysisId}><p className="icpc-muted">{a.status} · 词表 {a.taxonomyVersion}</p><p className="icpc-muted">{a.completeness?`完整性检查 ${a.completeness.version}（${a.completeness.state==='current'?'当前有效':'已过期'}，${a.completeness.checkedAt}）`:'完整性检查：无记录（旧结果或未执行检查），不代表已检查通过'}</p>{a.suggestions.map(s=><div className="icpc-card" key={s.suggestionId}><strong>{tagName(s.taxonomyId,boot)}</strong><p>{s.rationale}</p>{s.evidence.map((e,i)=><blockquote key={i}>{e.excerpt}<small> · 解法 {e.solutionId}</small></blockquote>)}<p className="icpc-muted">{s.verification?'复核：'+s.verification.verdict:'尚无复核记录'}</p><div className="icpc-actions">{(['accept','reject'] as const).map(choice=><button key={choice} disabled={action.busy} onClick={()=>{void action.run(async signal=>{await api.request('review.tag',{problemKey,taxonomyId:s.taxonomyId,action:choice,note:note||null},signal);changed();return true;});}}>{choice==='accept'?'人工接受':'人工拒绝'}</button>)}</div></div>)}{a.reasoningDrafts.length>0&&<Notice>无题解推理仅供人工审核：{a.reasoningDrafts.map(d=>d.rationale).join('\n')}</Notice>}</div>)}</details>
 <details><summary>手工指定标签</summary><label>标签<select value={tag} onChange={e=>setTag(e.target.value)}><option value="">请选择</option>{boot.taxonomy.nodes.filter(n=>n.kind!=='category').map(n=><option key={n.id} value={n.id}>{n.names.zh}</option>)}</select></label><label>审核备注<input value={note} onChange={e=>setNote(e.target.value)}/></label><div className="icpc-actions">{(['accept','reject'] as const).map(choice=><button key={choice} disabled={action.busy||!tag} onClick={()=>{void action.run(async signal=>{await api.request('review.tag',{problemKey,taxonomyId:tag,action:choice,note:note||null},signal);changed();return true;});}}>{choice==='accept'?'采用此标签':'排除此标签'}</button>)}</div></details>
 <details><summary>查看保存的题解（{problem.snapshot?.solutionCount??0}）</summary>{problem.snapshot?.solutions?.map(s=><article key={s.solutionId}><h3>{s.title}</h3><MarkdownView text={s.text} baseUrl={problem.snapshot?.sources?.find(source=>source.sourceId===s.sourceId)?.url??problem.url} label="题解"/></article>)}{problem.snapshot?.sources?.map(s=><div key={s.sourceId}><UserAnswerSource source={s}/> · {s.availability}<AliasEvidence note={s.note}/></div>)}</details>
 {problem.staleAnalysisCount>0&&<details><summary>查看已过期分析</summary>{problem.analyses?.filter(a=>a.stale).map(a=><Notice key={a.analysisId}>旧快照 v{a.snapshotVersion} · {a.status}\n{a.suggestions.map(s=>tagName(s.taxonomyId,boot)).join('、')}（不用于当前统计）</Notice>)}</details>}
 </>}
 <UserAnswer key={problemKey} problemKey={problemKey} snapshotId={problem.snapshot?.snapshotId??null} hasStatement={Boolean(problem.statement)} onChange={changed}/>
 <Coaching key={problem.snapshot?.snapshotId??'no-snapshot'} problemKey={problemKey} snapshotId={problem.snapshot?.snapshotId??null} hasStatement={Boolean(problem.statement)} baseUrl={problem.url}/>
 <Retrospective problem={problem} onChange={changed} onReveal={()=>setReveal(true)}/>
 <details><summary>刷新或补充材料</summary><label>CF 官方 tutorial 链接（可选）<input value={tutorial} onChange={e=>setTutorial(e.target.value)} placeholder="https://codeforces.com/blog/entry/…"/></label><p className="icpc-muted">{accountId?'题解通过当前所选账号的登录会话读取（洛谷需要登录才能看到题解）；未连接该账号时会明确报告需要登录，不会当成“没有题解”。':'未选择账号：题解只能匿名读取，需要登录的平台会报告需要登录，不会当成“没有题解”。'}</p><button disabled={action.busy} onClick={()=>{void action.run(async signal=>{const result=await api.request('material.refresh',{problemKey,fetchStatement:true,accountId,...(tutorial.trim()?{officialTutorialUrl:tutorial.trim()}:{})},signal);setRefreshed(result);changed();return result;});}}>从平台刷新题面与题解</button>
 {refreshed&&<Notice>题面：{refreshed.statement.status}{refreshed.statement.failure?' / '+refreshed.statement.failure.code:''}\n题解：{refreshed.editorial.status??'未获取'}{refreshed.editorial.failure?' / '+refreshed.editorial.failure.code:''}{refreshed.editorial.skippedReason?' / '+refreshed.editorial.skippedReason:''}{'\n'}{mirrorReuseView(refreshed.mirror, refreshed.editorial.status).text}</Notice>}
 <Notice>鉴权、限流和网络错误不代表“没有题解”。可以手工粘贴你已获取的真实材料。</Notice>
 <label>补充方式<select value={materialMode} onChange={e=>setMaterialMode(e.target.value as typeof materialMode)}><option value="statement">仅补充题面</option><option value="found">已有真实题解</option><option value="absent">已核实没有题解</option></select></label><label>完整题面（可选）<textarea value={statement} onChange={e=>setStatement(e.target.value)}/></label>
 {materialMode!=='statement'&&<><label>来源 URL<input value={url} onChange={e=>setUrl(e.target.value)}/></label><label>来源标题<input value={title} onChange={e=>setTitle(e.target.value)}/></label><label>{materialMode==='found'?'对应题目的完整题解段落':'核实说明（为什么确认没有题解）'}<textarea value={materialText} onChange={e=>setMaterialText(e.target.value)}/></label></>}
 <button disabled={action.busy||(materialMode==='statement'?!statement.trim():!url.trim()||!title.trim()||!materialText.trim())} onClick={()=>{void action.run(async signal=>{
  const editorial:ApiSupplementEditorial|undefined=materialMode==='statement'?undefined:materialMode==='found'?{status:'found',url,title,text:materialText}:{status:'absent',url,title,note:materialText};
  await api.request('material.supplement',{problemKey,expectedSnapshotId:problem.snapshot?.snapshotId??null,...(statement.trim()?{statement}:{}),...(editorial?{editorial}:{})},signal);setMaterialText('');setStatement('');changed();return true;
 });}}>保存材料并建立快照</button></details>
 </Panel>;
}
/**
 * The shared-round evidence of one stored editorial source, when it has any.
 *
 * A Div.1/Div.2 round shares one official tutorial, so a problem's write-up can legitimately live in
 * the other division's section. The page says so instead of presenting the text as if the requested
 * problem's own section produced it: the one-line mapping is the visible claim, and the expandable
 * detail names both official problems, the evidence type and the official blog so the pairing can be
 * checked rather than taken on trust. An ordinary section renders nothing here.
 */
function AliasEvidence({note}:{note:string|null}){
 const evidence=parseMaterialAliasEvidence(note);
 if(!evidence)return null;
 const links=materialAliasLinks(evidence);
 return <details><summary>{materialAliasSummary(evidence)}</summary>
  <p className="icpc-muted">请求的官方题目 {evidence.requestedKey} · 题解实际所属题目 {evidence.sectionKey} · 证据类型 {evidence.method}</p>
  <p className="icpc-muted"><ExternalLink href={links.requestedUrl}>请求的官方题目</ExternalLink> · <ExternalLink href={links.sectionUrl}>题解实际所属题目</ExternalLink> · <ExternalLink href={links.blogUrl}>官方题解博客</ExternalLink></p>
 </details>;
}
