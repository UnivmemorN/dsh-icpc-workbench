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