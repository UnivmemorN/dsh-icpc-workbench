import{useState}from'react';
import{api}from'./api.js';
import{WorkbenchContext,useRequest,useAction,ErrorNotice,Empty,ExternalLink,type PageName}from'./common.js';
import{ACCOUNT_ERROR_ID,ACCOUNT_GUIDES,ACCOUNT_HELP_ID,ACCOUNT_SAVE_NOTE,checkAccountInput,type AccountPlatform}from'./account-input.js';
import{Review}from'./Review.js';import{Weakness}from'./Weakness.js';import{Plans}from'./Plans.js';
import{Bank}from'./Bank.js';import{Today}from'./Today.js';import{Settings}from'./Settings.js';
export function App({onExit}:{onExit:()=>void}){
 const bootstrap=useRequest('bootstrap',{}),[page,setPage]=useState<PageName>('today'),[accountId,setAccountId]=useState<string|null>(null),[problemKey,setProblemKey]=useState<string|null>(null);
 const [selectedKeys,setSelectedKeys]=useState<string[]>([]);
 const [adding,setAdding]=useState(false),[platform,setPlatform]=useState<AccountPlatform>('codeforces'),[handle,setHandle]=useState(''),action=useAction();
 const check=checkAccountInput(platform,handle),guide=ACCOUNT_GUIDES[platform],inlineError=check.state==='invalid'?check.message:null;
 const navigate=(next:PageName,key?:string)=>{setPage(next);if(key!==undefined)setProblemKey(key);};
 /** A platform change invalidates both the old identifier and the old failure message. */
 const changePlatform=(next:AccountPlatform)=>{setPlatform(next);setHandle('');action.clear();};
 const close=()=>{setAdding(false);action.clear();};
 /** Local validation first; the adapter factory still canonicalizes whatever is submitted. Input survives a failure. */
 const submit=()=>{const ready=checkAccountInput(platform,handle);if(ready.state!=='valid')return;
  void action.run(async signal=>{const saved=await api.request('account.create',{platform,handle:ready.handle},signal);
   setAccountId(saved.account.id);setProblemKey(null);setSelectedKeys([]);setAdding(false);setHandle('');bootstrap.refresh();return true;});};
 return <div className="icpc-root"><header className="icpc-header"><div className="icpc-brand"><span className="icpc-mark">IC</span><div><strong>ICPC 训练</strong><small>每一步都有依据</small></div></div><div className="icpc-header-actions"><label className="icpc-account">当前账号<select aria-label="当前账号" value={accountId??''} onChange={e=>{setAccountId(e.target.value||null);setProblemKey(null);setSelectedKeys([]);}}><option value="">未选择账号</option>{bootstrap.data?.accounts.map(a=><option key={a.id} value={a.id}>{a.displayName??a.handle} · {a.sourceInstanceId.split(':')[0]}</option>)}</select></label><button onClick={()=>{if(adding)close();else setAdding(true);}}>{adding?'收起':'添加账号'}</button><button onClick={onExit}>返回对话</button></div></header>
 {adding&&<form className="icpc-add-account" aria-label="添加账号" onSubmit={e=>{e.preventDefault();submit();}}>
  <div className="icpc-field"><label htmlFor="icpc-account-platform">平台</label><select id="icpc-account-platform" disabled={action.busy} value={platform} onChange={e=>changePlatform(e.target.value as AccountPlatform)}><option value="codeforces">Codeforces</option><option value="luogu">洛谷</option></select><p className="icpc-form-note">{ACCOUNT_SAVE_NOTE}</p></div>
  <div className="icpc-field"><label htmlFor="icpc-account-input">{guide.label}</label><input id="icpc-account-input" name="handle" type="text" disabled={action.busy} value={handle} placeholder={guide.placeholder} autoComplete="off" spellCheck={false} inputMode="text" aria-required="true" aria-invalid={inlineError?'true':undefined} aria-describedby={inlineError?`${ACCOUNT_HELP_ID} ${ACCOUNT_ERROR_ID}`:ACCOUNT_HELP_ID} onChange={e=>{setHandle(e.target.value);action.clear();}}/><p className="icpc-field-help" id={ACCOUNT_HELP_ID}>{guide.help}</p>{inlineError&&<p className="icpc-field-error" id={ACCOUNT_ERROR_ID} role="alert">{inlineError}</p>}</div>
  <div className="icpc-field"><p className="icpc-field-example">示例（仅说明格式，打开示例不会创建账号）：<ExternalLink href={guide.exampleUrl}>{guide.exampleText}</ExternalLink></p><div className="icpc-actions"><button className="icpc-primary" type="submit" disabled={action.busy||check.state!=='valid'} aria-busy={action.busy}>{action.busy?'保存中…':'添加账号'}</button><button type="button" disabled={action.busy} onClick={close}>取消</button></div><ErrorNotice error={action.error}/></div>
 </form>}
 <nav className="icpc-nav" aria-label="训练工作台">{([['today','今日训练'],['bank','题库'],['review','标签审核'],['weakness','薄弱项'],['plans','训练计划'],['settings','设置']] as const).map(([id,title])=><button key={id} aria-current={page===id?'page':undefined} onClick={()=>navigate(id)}>{title}</button>)}<span>{bootstrap.data?.settings.value.provider??'正在连接'} · max</span></nav>
 <main className="icpc-content"><ErrorNotice error={bootstrap.error}/>{Boolean(bootstrap.error)&&<button onClick={bootstrap.refresh}>重试连接</button>}{bootstrap.pending&&!bootstrap.data&&<Empty>正在加载训练工作台…</Empty>}{bootstrap.data&&<WorkbenchContext.Provider value={{boot:bootstrap.data,accountId,refresh:bootstrap.refresh,navigate,problemKey,selectedKeys,setSelectedKeys}}><div key={accountId??'anonymous'}>{page==='settings'?<Settings/>:page==='bank'?<Bank/>:page==='review'?<Review/>:page==='weakness'?<Weakness/>:page==='plans'?<Plans/>:<Today/>}</div></WorkbenchContext.Provider>}</main><footer className="icpc-footer">本地数据 · 证据复核 · 原始标签与人工判断分别保留</footer>
 </div>;
}
