/** Scale regression: source/search predicates must not recompute every group for every problem. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {SqliteTrainingStore} from '../../src/adapters/sqlite/index.js';
import * as sql from '../../src/adapters/sqlite/merged-bank.js';
import {naturalSortKey} from '../../src/domain/index.js';
import {NATURAL_KEY_FUNCTION,RATING_VALUE_FUNCTION,ratingValueFromBody} from '../../src/adapters/sqlite/sorting.js';
import * as fx from './fixtures.js';

void test('merged source/search/status queries retain linear identity work on a multi-platform bank', async()=>{
 const paths=fx.tempDatabase(),store=new SqliteTrainingStore({path:paths.path});
 let db:DatabaseSync|null=null;
 try{
  const cf=fx.makeInstance('codeforces','codeforces.com'),lg=fx.makeInstance('luogu','www.luogu.com.cn');
  const account=fx.makeAccount(cf,'scale-user');
  const problems=Array.from({length:1200},(_,i)=>fx.makeProblem(fx.makeRef(cf,`${i+1}A`)));
  const mirrors=problems.filter((_,i)=>(i+1)%2===0).map(p=>fx.makeProblem(fx.makeRef(lg,`CF${p.ref.externalKey}`)));
  const submissions=problems.filter((_,i)=>(i+1)%3===0).map((p,i)=>fx.makeSubmission(account,p.ref,`scale-${i}`,'accepted'));
  await store.upsertSourceInstances([cf,lg]);await store.upsertAccounts([account]);
  await store.upsertProblems([...problems,...mirrors]);await store.upsertSubmissions(submissions);await store.close();
  db=new DatabaseSync(paths.path,{readOnly:true});
  let calls=0;const allowance=(problems.length+mirrors.length+submissions.length)*40;
  db.function(sql.MERGED_REF_KEY_FUNCTION,{deterministic:true},sql.mergedRefKeyOfColumns);
  db.function(sql.MERGED_GROUP_KEY_FUNCTION,{deterministic:true},(source,domain,key)=>{
   calls++;assert.ok(calls<=allowance,'identity work exceeded a generous linear bound; likely a correlated bank rescan');
   return sql.mergedGroupKeyOfColumns(source,domain,key);
  });
  db.function(NATURAL_KEY_FUNCTION,{deterministic:true},value=>naturalSortKey(String(value)));
  db.function(RATING_VALUE_FUNCTION,{deterministic:true},ratingValueFromBody);
  for(const [source,status,expected] of [[null,'all',1200],[cf.id,'all',1200],[cf.id,'solved',400],[lg.id,'solved',200]] as const){
   calls=0;
   const plan=sql.planMergedBrowse({accounts:[{id:account.id,sourceInstanceId:cf.id}],sourceInstanceId:source,status,onlyAttempted:false,search:'Problem',sort:'problem_asc',ratingDimension:null});
   const count=sql.mergedCountQuery(plan);assert.equal(db.prepare(count.sql).get(...count.params)?.['total'],expected);
   const page=sql.mergedPageQuery(plan,25,0),rows:Record<string,unknown>[]=db.prepare(page.sql).all(...page.params);
   assert.equal(rows.length,25);assert.equal(new Set(rows.map(r=>r['group_key'])).size,25);
   const evidence=sql.mergedEvidenceQuery(plan,rows.map(r=>String(r['group_key'])));
   const accepted:Record<string,unknown>[]=db.prepare(evidence.sql).all(...evidence.params);
   if(status==='solved')assert.equal(accepted.length,25);
   assert.ok(accepted.every(r=>r['account_id']===account.id));assert.ok(calls<=allowance);
  }
 }finally{db?.close();await store.close();fx.removeDirectory(paths.dir);}
});
