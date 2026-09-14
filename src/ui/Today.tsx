import {api} from './api.js';
import {Panel,Empty,ErrorNotice,Stats,Notice,ExternalLink,useWorkbench,useRequest,useAction,localDay} from './common.js';
import {SolvedDistribution} from './SolvedDistribution.js';
export function Today(){
 const {accountId}=useWorkbench(),action=useAction();
 const weakness=useRequest('weakness',accountId?{accountId}:null),plans=useRequest('plan.list',accountId?{accountId}:null);
 const today=localDay(new Date());
 const tasks=(plans.data?.plans??[]).filter(p=>p.status==='adopted'&&p.adoptedAt!==null).flatMap(p=>p.tasks.filter(t=>t.day===today-localDay(p.adoptedAt!)+1).map(t=>({plan:p,task:t})));
 return <><div className="icpc-page-heading"><div><p className="icpc-eyebrow">TODAY</p><h1>把训练落到每一道题</h1><p>从真实记录出发，记下你实际使用的解法。</p></div><span className="icpc-date">{new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'})}</span></div>
 {!accountId?<Empty>先在顶部选择账号，或到「账号与同步」添加账号，即可查看训练统计和今日计划；公开目录同步与手工材料导入也在该页。</Empty>:<>
 <ErrorNotice error={weakness.error??plans.error??action.error}/>
 {weakness.pending&&<Notice>正在读取训练记录…</Notice>}
 {weakness.data&&<Stats items={[{label:'不同题目',value:weakness.data.report.attemptedDistinctTotal},{label:'已通过题目',value:weakness.data.report.solvedDistinctTotal},{label:'已复核标签覆盖',value:weakness.data.report.taggedAttemptedDistinct+' / '+weakness.data.report.attemptedDistinctTotal},{label:'今日待完成',value:plans.data?tasks.filter(t=>t.task.status==='planned').length:'读取中'}]}/>}
 {weakness.data&&<SolvedDistribution distribution={weakness.data.solvedDistribution}/>}
 <Panel title="今日计划" tools={<button onClick={plans.refresh} disabled={plans.pending}>刷新</button>}>
 {plans.pending?<p>正在读取计划…</p>:tasks.length===0?<Empty>今天还没有安排。先导入训练记录，再用真实候选题生成并采纳计划。</Empty>:<div className="icpc-task-list">{tasks.map(({plan,task})=><div className="icpc-task" key={task.taskId}><div><small>{plan.title} · 第 {task.day} 天</small><h3><ExternalLink href={task.sourceUrl}>{task.title}</ExternalLink></h3><span>{task.minutes} 分钟 · {({solve:'做题',review:'复习',upskill:'专题提高'})[task.kind]} · {task.status==='planned'?'待完成':task.status==='done'?'已完成':'已跳过'}</span></div>{task.status==='planned'&&<div className="icpc-actions">{(['done','skipped'] as const).map(status=><button key={status} disabled={action.busy} onClick={()=>{void action.run(async signal=>{await api.request('plan.checkoff',{accountId:accountId!,planId:plan.planId,taskId:task.taskId,expectedHash:plan.contentHash,status},signal);plans.refresh();return true;});}}>{status==='done'?'完成':'跳过'}</button>)}</div>}</div>)}</div>}
 </Panel><Notice>计划完成是手工训练记录，不代表 OJ 判题结果。一次 AC 也不代表掌握这道题的全部解法。</Notice>
 </>}
 </>;
}