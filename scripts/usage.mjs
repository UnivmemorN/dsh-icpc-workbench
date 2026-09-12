/** Conservative CNY pricing for dsh's normalized (disjoint) token buckets. */
export function priceUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 ||
      !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) return null;
  const cached = usage.cacheReadTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  if (![cached, written].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  // dsh inputTokens already excludes cached reads. Never subtract them twice.
  return { inputTokens:usage.inputTokens, outputTokens:usage.outputTokens, cacheReadTokens:cached,
    conservativeCny:((usage.inputTokens+written)*2+cached*0.04+usage.outputTokens*8)/1e6 };
}
/** Audited platform-total reconciliation keeps raw runs immutable and prices later work once. */
export function totalConservativeCny(ledger) {
  if (!Array.isArray(ledger.runs)) throw Error('Missing usage runs');
  const ids=new Set();
  for(const run of ledger.runs){
    if(typeof run.id!=='string'||!run.id||ids.has(run.id)||!Number.isFinite(run.conservativeCny)||run.conservativeCny<0)throw Error('Invalid usage run');
    ids.add(run.id);
  }
  const baseline=ledger.accountingBaseline;
  if(baseline===undefined)return ledger.runs.reduce((sum,run)=>sum+run.conservativeCny,0);
  if(!Number.isFinite(baseline.reportedActualCny)||baseline.reportedActualCny<0||!Number.isFinite(baseline.conservativeCny)||baseline.conservativeCny<baseline.reportedActualCny||!Array.isArray(baseline.throughRunIds)||new Set(baseline.throughRunIds).size!==baseline.throughRunIds.length||baseline.throughRunIds.some(id=>!ids.has(id))||baseline.source!=='user-reported-platform-total'||!Number.isFinite(Date.parse(baseline.recordedAt)))throw Error('Invalid accounting baseline');
  const covered=new Set(baseline.throughRunIds);
  return baseline.conservativeCny+ledger.runs.filter(run=>!covered.has(run.id)).reduce((sum,run)=>sum+run.conservativeCny,0);
}
