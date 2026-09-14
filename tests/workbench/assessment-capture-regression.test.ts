import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SqliteTrainingStore} from '../../src/adapters/sqlite/index.js';
import {WorkbenchService} from '../../src/application/workbench-service.js';
import {CURRENT_TAXONOMY,createTaxonomyIndex,createCancellationSource} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';
const token=createCancellationSource().token;
async function bench(run:(b:{store:SqliteTrainingStore;workbench:WorkbenchService;scope:fx.Scope})=>Promise<void>){
 const paths=fx.tempDatabase(),store=new SqliteTrainingStore({path:paths.path,now:()=>fx.AT});
 const scope=fx.makeScope('codeforces','codeforces.com','capture-regression','1A');
 try{
  await store.upsertSourceInstances([scope.instance]);await store.upsertAccounts([scope.account]);await store.upsertProblems([scope.problem]);
  await store.upsertSubmissions([fx.makeSubmission(scope.account,scope.problem.ref,'accepted','accepted',fx.AT)]);
  const workbench=new WorkbenchService({store,taxonomy:createTaxonomyIndex(CURRENT_TAXONOMY),now:()=>fx.AT,uniqueId:()=> 'capture-review'});
  await run({store,workbench,scope});
 }finally{await store.close();fx.removeDirectory(paths.dir);}
}
test('assessment source identity detects metadata changes that leave all aggregate counts unchanged',async()=>bench(async({store,workbench,scope})=>{
 const capture=()=>workbench.captureAssessmentInput({accountId:scope.account.id,capturedAt:fx.AT},token);
 const before=await capture();
 await store.upsertProblems([fx.makeProblem(scope.problem.ref,{title:'corrected metadata title',fetchedAt:fx.LATER})]);
 const after=await capture();
 assert.deepEqual(before.prompt.ability.counts,after.prompt.ability.counts);
 assert.notEqual(before.sourceHash,after.sourceHash,'changed raw evidence must invalidate a prepared assessment');
}));
test('assessment source identity remains stable when only the 90-day boundary moves',async()=>bench(async({workbench,scope})=>{
 const before=await workbench.captureAssessmentInput({accountId:scope.account.id,capturedAt:fx.AT},token);
 const after=await workbench.captureAssessmentInput({accountId:scope.account.id,capturedAt:'2027-03-01T12:00:00.000Z'},token);
 assert.equal(before.sourceHash,after.sourceHash,'aging alone does not change stored source evidence');
}));
test('assessment knowledge rows preserve their native difficulty band',async()=>bench(async({workbench,scope})=>{
 const capture=await workbench.captureAssessmentInput({accountId:scope.account.id,capturedAt:fx.AT},token);
 assert.ok(capture.prompt.knowledge.length>0);
 assert.ok(capture.prompt.knowledge.every(row=>row.band!=='[object Object]'&&row.band.trim().length>0));
}));
