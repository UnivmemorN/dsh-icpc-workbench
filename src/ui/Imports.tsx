import{useState}from'react';
import type{ApiImportRequest,ApiImportPreviewResult,ApiImportApplyResult,ApiSyncPageResult}from'../application/workbench-api.js';
import{api}from'./api.js';
import{Panel,Notice,ErrorNotice,useWorkbench,useAction,Stats}from'./common.js';
export function ImportPanel({sourceId,onChange}:{sourceId:string;onChange:()=>void}){
 const {boot,accountId,refresh}=useWorkbench(),action=useAction();
 const [format,setFormat]=useState<'json'|'csv'>('json'),[kind,setKind]=useState<'problems'|'submissions'>('problems'),[text,setText]=useState(''),[context,setContext]=useState('{}');
 const [prepared,setPrepared]=useState<{request:ApiImportRequest;preview:ApiImportPreviewResult}|null>(null),[applied,setApplied]=useState<ApiImportApplyResult|null>(null);
 const [sync,setSync]=useState<ApiSyncPageResult|null>(null),[pages,setPages]=useState(0),[resource,setResource]=useState<'problems'|'submissions'>('problems');
 const source=boot.sources.find(s=>s.id===sourceId),capability=boot.adapters.find(a=>a.sourceInstanceId===sourceId)?.capabilities;
 let request:ApiImportRequest|null=null,inputError:string|null=null;
 try{
  if(format==='json')request={format,text};else{
   if(!source)throw Error('请选择导入来源');const extra:unknown=JSON.parse(context);
   if(!extra||typeof extra!=='object'||Array.isArray(extra)||Object.keys(extra).some(k=>!['accounts','problems','editorials'].includes(k)))throw Error('CSV 索引只允许 accounts、problems 和 editorials');
   request={format,text,csv:{kind,source:{platform:source.platform,baseUrl:source.baseUrl,domain:source.domain,displayName:source.displayName},...extra}};
  }
 }catch(error){inputError=error instanceof Error?error.message:'CSV 索引格式无效';}
 const fresh=prepared&&request&&JSON.stringify(prepared.request)===JSON.stringify(request);
 const canSync=Boolean(capability?.implemented&&(resource==='problems'?capability.problems:capability.submissions&&accountId));
 async function synchronize(mode:'start'|'continue'|'restart'){
  setPages(0);setSync(null);
  await action.run(async signal=>{
   for(let page=0;page<20;page++){
    const result=await api.request('sync.page',{sourceInstanceId:sourceId,accountId:resource==='submissions'?accountId:null,resource,mode:page===0?mode:'continue',limit:50},signal);
    setPages(page+1);setSync(result);if(!result.ok||result.complete)break;
   }
   onChange();refresh();return true;
  });
 }
 return <><Panel title="导入与同步"><details><summary>从平台同步公开数据</summary><div className="icpc-toolbar"><label>数据类型<select value={resource} onChange={e=>setResource(e.target.value as typeof resource)}><option value="problems">题目目录</option><option value="submissions">所选账号的提交记录</option></select></label><button disabled={action.busy||!canSync} onClick={()=>{void synchronize('start');}}>开始同步</button><button disabled={action.busy||!canSync} onClick={()=>{void synchronize('continue');}}>继续上次进度</button><button disabled={action.busy||!canSync} onClick={()=>{void synchronize('restart');}}>从头重新同步</button>{action.busy&&<button onClick={action.cancel}>取消请求</button>}</div>
 {!canSync&&<Notice>当前来源或账号不支持此项在线同步。洛谷提交记录请使用手工导入；尚未实现 HydroOJ 在线适配。</Notice>}
 <p className="icpc-muted">每次点击最多同步 20 页，断点保存在本地。Codeforces 请求至少间隔 2 秒。</p>
 {sync&&<Notice>已处理 {pages} 页 · {sync.ok?(sync.complete?'同步完成':'仍有下一页，可继续'):'此次同步未完成'}{sync.failure?' · '+sync.failure.code:''}{sync.unavailableReason?' · '+sync.unavailableReason:''}{sync.counts?'\n本页：'+Object.entries(sync.counts).map(([k,v])=>k+' '+v).join(' / '):''}</Notice>}</details>
 <details><summary>导入 JSON / CSV 文件或粘贴材料</summary><div className="icpc-toolbar"><label>文件格式<select value={format} onChange={e=>setFormat(e.target.value as typeof format)}><option value="json">完整 JSON 文档</option><option value="csv">CSV</option></select></label><label>读取本地文件<input type="file" accept=".json,.csv,text/plain" onChange={e=>{const file=e.target.files?.[0];if(file)void action.run(async()=>{if(file.size>8*1024*1024)throw Error('文件超过 8 MiB 上限');setText(await file.text());setFormat(file.name.toLowerCase().endsWith('.csv')?'csv':'json');return true;});}}/></label></div>
 {format==='csv'&&<><label>CSV 内容<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="problems">题目</option><option value="submissions">提交记录</option></select></label><p className="icpc-muted">CSV 来源：{source?.displayName??'尚未选择'}。提交 CSV 需提供它引用的账号和题目索引。</p><label>补充索引（JSON，可包含 accounts / problems / editorials）<textarea value={context} onChange={e=>setContext(e.target.value)} spellCheck={false}/></label></>}
 <label>导入内容<textarea aria-label="导入内容" value={text} onChange={e=>setText(e.target.value)} spellCheck={false} placeholder="粘贴插件手工导入格式的数据，或选择本地文件"/></label><p className="icpc-muted">文件与 JSON/CSV 格式错误会定位到字段或行。预览不会写入数据。</p>
 {inputError&&<Notice>{inputError}</Notice>}<div className="icpc-actions"><button disabled={action.busy||!text.trim()||!request} onClick={()=>{const captured=request;if(captured)void action.run(async signal=>{const preview=await api.request('import.preview',captured,signal);setPrepared({request:captured,preview});setApplied(null);return true;});}}>预览导入</button>
 {fresh&&prepared.preview.parsed&&<button className="icpc-primary" disabled={action.busy} onClick={()=>{if(!prepared.preview.parsed)return;const expectedHash=prepared.preview.contentHash;void action.run(async signal=>{const result=await api.request('import.apply',{...prepared.request,expectedHash},signal);setApplied(result);setPrepared(null);onChange();refresh();return result;});}}>确认导入这份内容</button>}</div>
 {fresh&&prepared.preview.parsed&&<Stats items={[{label:'账号',value:prepared.preview.counts.accounts},{label:'题目',value:prepared.preview.counts.problems},{label:'提交',value:prepared.preview.counts.submissions},{label:'已有题解',value:prepared.preview.counts.editorialsFound}]}/>}
 {fresh&&!prepared.preview.parsed&&<Notice>{prepared.preview.issues.map(i=>[i.row!==null?'第 '+i.row+' 行':i.path,i.message].join('：')).join('\n')}</Notice>}
 {applied&&<Notice>导入完成：新增 {applied.problems.inserted} 题，更新 {applied.problems.updated} 题，提交记录 {applied.submissionsProcessed} 条，更新快照 {applied.changedSnapshots} 份。</Notice>}</details><ErrorNotice error={action.error}/></Panel></>;
}