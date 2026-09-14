import {useState} from 'react';
import {MAX_GUIDANCE_SELECTION} from '../domain/guidance.js';
import type {GuidanceKind,GuidanceSnapshot} from '../domain/guidance.js';
import {useRequest,ErrorNotice,ExternalLink} from './common.js';
/** Keep explicit empty selections and missing selected IDs; never silently substitute a method. */
export function useGuidance(kind:GuidanceKind,scope:string|null){
 const read=useRequest('guidance.catalog',{}),[choice,setChoice]=useState<{scope:string|null;ids:string[]}|null>(null);
 const methods=(read.data?.methods??[]).filter(m=>kind==='plan'?m.definition.capabilities.plan:m.definition.capabilities.assessment);
 const ids=choice?.scope===scope?choice.ids:methods.some(m=>m.definition.methodId==='balanced-dual-axis')?['balanced-dual-axis']:[];
 const missing=ids.filter(id=>!methods.some(m=>m.definition.methodId===id));
 /** The domain bound (4). A selection at the bound disables every *unchecked* box and refuses a 5th id. */
 const atMax=ids.length>=MAX_GUIDANCE_SELECTION;
 return {read,methods,ids,missing,atMax,ready:!read.pending&&!read.error&&ids.length>0&&ids.length<=MAX_GUIDANCE_SELECTION&&missing.length===0,
 signature:JSON.stringify([ids,methods.map(m=>[m.definition.methodId,m.methodHash])]),
 select:(next:string[])=>setChoice({scope,ids:next.length>MAX_GUIDANCE_SELECTION?ids:next})};
}
export function GuidancePicker({value:g}:{value:ReturnType<typeof useGuidance>}){return <fieldset><legend>指导方法插件</legend>
 <ErrorNotice error={g.read.error}/>{g.read.pending&&<p>正在读取已安装的方法…</p>}
 {!g.read.pending&&g.methods.length===0&&<p>请在 dsh 插件管理中安装并启用指导方法包；规则计划仍可使用。</p>}
 {g.methods.map(({definition:d})=>{const checked=g.ids.includes(d.methodId),blocked=!checked&&g.atMax;return <label key={d.methodId} style={{display:'block',margin:'8px 0'}}><input type="checkbox" checked={checked} disabled={blocked} aria-describedby={blocked?'icpc-guidance-max':undefined} onChange={e=>{if(e.target.checked&&g.atMax)return;g.select(e.target.checked?[...g.ids,d.methodId]:g.ids.filter(id=>id!==d.methodId));}}/>{d.name} · {d.version}<span className="icpc-muted"> — {d.summary}</span></label>;})}
 {g.atMax&&<p id="icpc-guidance-max" className="icpc-muted">最多同时选择 {MAX_GUIDANCE_SELECTION} 个方法：想换一个时，先取消一个已选方法；已选择的不会被自动取消或替换。</p>}
 {g.missing.length>0&&<p role="alert">所选方法已卸载或不可用：{g.missing.join('、')}。请重新选择。</p>}
 <button type="button" onClick={g.read.refresh}>刷新方法列表</button>
 <details><summary>方法出处</summary>{g.methods.map(({definition:d})=><div key={d.methodId}><strong>{d.name}</strong>{d.sources.map(s=><p key={s.url}><ExternalLink href={s.url}>{s.title}</ExternalLink></p>)}</div>)}</details>
 </fieldset>;}
export function GuidanceSources({snapshot}:{snapshot:GuidanceSnapshot|null|undefined}){return snapshot?<details><summary>使用的指导方法：{snapshot.methods.map(m=>m.name+' '+m.version).join('、')}</summary>{snapshot.methods.map(m=><div key={m.methodId}><p>{m.summary}</p>{m.sources.map(s=><p key={s.url}><ExternalLink href={s.url}>{s.title}</ExternalLink></p>)}</div>)}</details>:<p className="icpc-muted">未记录指导方法（旧版或规则计划）。</p>;}
export const AXIS_LABELS={thinking:'思维',templates:'板子'} as const;
export const PRIORITY_LABELS={thinking:'重点补强思维',templates:'重点补强板子',balanced:'两方面共同推进',diagnostic:'先做诊断训练'} as const;
