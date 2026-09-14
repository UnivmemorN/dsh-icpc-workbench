import test from 'node:test';
import assert from 'node:assert/strict';
import {priceUsage,totalConservativeCny} from './usage.mjs';
test('dsh cached input is additive, not a subset of uncached input',()=>{
  assert.equal(priceUsage({inputTokens:1000000,cacheReadTokens:2000000,outputTokens:1000000}).conservativeCny,10.08);
});
test('no cache usage is charged at the conservative uncached rate',()=>{
  assert.equal(priceUsage({inputTokens:1000000,outputTokens:0}).conservativeCny,2);
});
test('bad or missing usage cannot look like a free request',()=>{
  assert.equal(priceUsage(undefined),null);
  assert.equal(priceUsage({inputTokens:-1,outputTokens:0}),null);
});
test('reconciliation preserves raw estimates and charges only subsequent runs',()=>{
 const ledger={runs:[{id:'a',conservativeCny:80},{id:'b',conservativeCny:2}]};
 assert.equal(totalConservativeCny(ledger),82);
 ledger.accountingBaseline={reportedActualCny:30,conservativeCny:35,throughRunIds:['a'],source:'user-reported-platform-total',recordedAt:'2026-09-12T00:00:00Z'};
 const before=JSON.stringify(ledger);assert.equal(totalConservativeCny(ledger),37);assert.equal(JSON.stringify(ledger),before);
 ledger.runs.push({id:'c',conservativeCny:1.5});assert.equal(totalConservativeCny(ledger),38.5);
});
test('untraceable or optimistic reconciliation is refused',()=>{
 const baseline={reportedActualCny:30,conservativeCny:35,throughRunIds:['a'],source:'user-reported-platform-total',recordedAt:'2026-09-12T00:00:00Z'};
 for(const patch of [{conservativeCny:29},{throughRunIds:['unknown']},{throughRunIds:['a','a']},{recordedAt:'bad'},{reportedActualCny:NaN}])assert.throws(()=>totalConservativeCny({runs:[{id:'a',conservativeCny:80}],accountingBaseline:{...baseline,...patch}}));
 assert.throws(()=>totalConservativeCny({runs:[{id:'a',conservativeCny:1},{id:'a',conservativeCny:2}]}));
});
test('official balance reconciliation keeps the same conservative and traceability rules',()=>{
 const runs=[{id:'covered',conservativeCny:20},{id:'later',conservativeCny:2}];
 const baseline={reportedActualCny:10,conservativeCny:15,throughRunIds:['covered'],source:'official-platform-balance',recordedAt:'2026-09-14T00:00:00Z'};
 assert.equal(totalConservativeCny({runs,accountingBaseline:baseline}),17);
 assert.throws(()=>totalConservativeCny({runs,accountingBaseline:{...baseline,source:'unverified-estimate'}}));
 assert.throws(()=>totalConservativeCny({runs,accountingBaseline:{...baseline,conservativeCny:9}}));
});
