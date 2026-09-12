import {useState} from 'react';
import type {WorkbenchProblemDetail} from '../application/workbench-types.js';
import {api} from './api.js';
import {Notice,ErrorNotice,useAction,useWorkbench} from './common.js';
const modes={independent:'独立完成',assisted:'使用提示完成',solution_used:'参考题解完成'} as const;
export function Retrospective({problem,onChange}:{problem:WorkbenchProblemDetail;onChange:()=>void}){
 const {accountId,boot}=useWorkbench(),action=useAction(),[mode,setMode]=useState<keyof typeof modes>('independent'),[tags,setTags]=useState<string[]>([]),[solutions,setSolutions]=useState<string[]>([]),[note,setNote]=useState(''),[saved,setSaved]=useState(false);
 if(!accountId)return <Notice>选择账号后，可以记录这道题实际使用的解法。</Notice>;
 return <details><summary>记录完成方式与实际解法</summary><ErrorNotice error={action.error}/>{problem.latestRetrospective&&<p className="icpc-muted">上次记录：{modes[problem.latestRetrospective.mode]} · {new Date(problem.latestRetrospective.recordedAt).toLocaleString()}</p>}
 <form onSubmit={e=>{e.preventDefault();void action.run(async signal=>{await api.request('retro.record',{problemKey:problem.problemKey,accountId,mode,taxonomyIds:tags,solutionIds:solutions,note:note||null},signal);setSaved(true);onChange();return true;});}}><label>完成方式<select value={mode} onChange={e=>setMode(e.target.value as typeof mode)}>{Object.entries(modes).map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label><label>实际使用的算法（可多选，Ctrl / Command 选择）<select multiple size={6} value={tags} onChange={e=>setTags(Array.from(e.target.selectedOptions,o=>o.value))}>{boot.taxonomy.nodes.filter(t=>t.kind!=='category').map(t=><option key={t.id} value={t.id}>{t.names.zh}</option>)}</select></label>
 {problem.snapshot?.solutions&&problem.snapshot.solutions.length>0&&<label>参考过的已保存解法（可多选）<select multiple value={solutions} onChange={e=>setSolutions(Array.from(e.target.selectedOptions,o=>o.value))}>{problem.snapshot.solutions.map(s=><option key={s.solutionId} value={s.solutionId}>{s.title}</option>)}</select></label>}<label>复盘备注<textarea value={note} onChange={e=>setNote(e.target.value)}/></label><button className="icpc-primary" disabled={action.busy}>保存本次复盘</button>{saved&&<Notice>复盘已保存；统计使用这道题最新的一次记录。</Notice>}</form></details>;
}
