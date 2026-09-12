import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNormalizedProblem,createProblemSnapshot} from '../../src/domain/index.js';
const at='2026-09-12T00:00:00.000Z';
const ref={sourceInstanceId:'manual:local',domain:null,externalKey:'statement-case'};
const problem=(statement?:string)=>createNormalizedProblem({ref,title:'Statement case',url:'https://example.org/p/1',fetchedAt:at,statement});
test('complete statement is retained in model snapshots and invalidates earlier analysis input',()=>{
 const a=createProblemSnapshot({problem:problem('Find shortest paths with nonnegative edge weights.'),capturedAt:at});
 const b=createProblemSnapshot({problem:problem('Find shortest paths; negative edges are allowed.'),capturedAt:at,previous:a});
 assert.equal(a.problem.statement,'Find shortest paths with nonnegative edge weights.');
 assert.notEqual(a.contentHash,b.contentHash);
 assert.notEqual(a.snapshotId,b.snapshotId);
 assert.equal(problem().statement,null);
 assert.equal(problem('   ').statement,null);
});
test('normalizing raw ratings does not freeze adapter-owned bounds',()=>{
 const bounds={min:0,max:7};
 const p=createNormalizedProblem({ref,title:'Rating',url:'https://example.org/p/1',fetchedAt:at,
 ratings:[{dimension:'luogu.difficulty',value:3,raw:'3',scale:bounds}]});
 bounds.max=8;
 assert.equal(p.ratings[0]?.scale?.max,7);
 assert.equal(Object.isFrozen(bounds),false);
});
