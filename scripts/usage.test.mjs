import test from 'node:test';
import assert from 'node:assert/strict';
import {priceUsage} from './usage.mjs';
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