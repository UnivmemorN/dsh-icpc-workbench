/**
 * Focused regressions for the identity, job-state and eligibility rules repaired in the
 * stage-1 second review. Everything here goes through the public domain factories, so the
 * tests fail if a factory and its parser/validator ever disagree again.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ELIGIBILITY_SETTINGS,
  DomainError,
  TAXONOMY_V1,
  TAXONOMY_V1_VERSION,
  analysisJobIdOf,
  createAccount,
  createAiTagSuggestion,
  createAnalysisJob,
  createAnalysisResult,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  createProblemSnapshot,
  createSourceInstance,
  createSubmission,
  createSuggestionVerification,
  createTaxonomyIndex,
  encodeIdPart,
  evaluateSuggestion,
  isDeeplyFrozen,
  isSnapshotStale,
  parseAccountId,
  parseProblemKey,
  problemKey,
  recoverAfterRestart,
  resolveTagDecisions,
  snapshotHead,
  sourceInstanceIdOf,
  transitionJob,
  type AnalysisJobLimits,
  type EditorialSource,
  type EvaluateSuggestionContext,
  type ProblemRef,
  type ProblemSnapshot,
} from '../../src/domain/index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:10:00.000Z';
const T2 = '2026-01-01T00:20:00.000Z';
const T3 = '2026-01-01T00:30:00.000Z';

const CF = createSourceInstance({ platform: 'codeforces', baseUrl: 'https://codeforces.com' });
const HYDRO_8080 = createSourceInstance({ platform: 'hydro', baseUrl: 'http://localhost:8080' });
const HYDRO_9090 = createSourceInstance({ platform: 'hydro', baseUrl: 'http://localhost:9090' });

const TAXONOMY = createTaxonomyIndex(TAXONOMY_V1);
const TAG = 'search.binary-answer';
const SOLUTION_TEXT = 'We binary search the answer and check feasibility with a greedy scan.';

function domainError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

// ---------------------------------------------------------------------------------------
// Identity: nested instance/account ids, separators, unicode, canonical parsing
// ---------------------------------------------------------------------------------------

test('instance ids keep the platform and support host:port deployments', () => {
  assert.equal(CF.id, 'codeforces:codeforces.com');
  assert.equal(HYDRO_8080.id, 'hydro:localhost%3A8080');
  assert.equal(HYDRO_9090.id, 'hydro:localhost%3A9090');
  assert.notEqual(HYDRO_8080.id, HYDRO_9090.id);

  // A colon in the domain is legitimate (host:port) and must not be rejected.
  assert.equal(sourceInstanceIdOf('hydro', 'localhost:8080'), HYDRO_8080.id);
  assert.equal(sourceInstanceIdOf('hydro', '  LOCALHOST:8080 '), HYDRO_8080.id);
});

test('account ids nest the instance id and keep handles opaque', () => {
  const handle = 'Alice|β@x:7';
  const account = createAccount({ sourceInstanceId: HYDRO_8080.id, handle });
  assert.equal(account.handle, handle);
  assert.deepEqual(parseAccountId(account.id), { sourceInstanceId: HYDRO_8080.id, handle });

  const otherDeployment = createAccount({ sourceInstanceId: HYDRO_9090.id, handle });
  assert.notEqual(account.id, otherDeployment.id);
  assert.deepEqual(parseAccountId(otherDeployment.id), { sourceInstanceId: HYDRO_9090.id, handle });

  // Handles are case preserving; normalisation is the adapter's job.
  assert.equal(createAccount({ sourceInstanceId: CF.id, handle: 'Tourist' }).handle, 'Tourist');
});

test('problem keys roundtrip nested ids, domain scopes and unicode keys', () => {
  const ref: ProblemRef = { sourceInstanceId: HYDRO_8080.id, domain: 'group|α', externalKey: 'P 1001|A' };
  const key = problemKey(ref);
  assert.deepEqual(parseProblemKey(key), ref);
  assert.equal(problemKey(parseProblemKey(key)), key);

  const unicodeRef: ProblemRef = { sourceInstanceId: CF.id, domain: 'contests/2026', externalKey: '题目·一' };
  assert.deepEqual(parseProblemKey(problemKey(unicodeRef)), unicodeRef);

  // External keys are opaque at domain level: case is preserved, normalisation is the adapter's job.
  const mixedCase: ProblemRef = { sourceInstanceId: CF.id, domain: null, externalKey: 'ABC-1234/X' };
  assert.deepEqual(parseProblemKey(problemKey(mixedCase)), mixedCase);

  const noDomain = { ...ref, domain: null };
  const domainA = { ...ref, domain: 'group-a' };
  const domainB = { ...ref, domain: 'group-b' };
  assert.equal(new Set([problemKey(noDomain), problemKey(domainA), problemKey(domainB)]).size, 3);
  assert.equal(problemKey({ ...ref, domain: '   ' }), problemKey(noDomain));

  // Two deployments of the same platform never share a problem key.
  assert.notEqual(problemKey({ ...ref, sourceInstanceId: HYDRO_9090.id }), key);
});

test('submissions compose escaped account, problem and external ids', () => {
  const handle = 'Alice|β@x:7';
  const account = createAccount({ sourceInstanceId: HYDRO_8080.id, handle });
  const ref: ProblemRef = { sourceInstanceId: HYDRO_8080.id, domain: 'group|α', externalKey: 'P 1001|A' };
  const input = {
    accountId: account.id,
    ref,
    externalId: 'S 7|9',
    verdict: 'accepted' as const,
    submittedAt: T0,
  };
  const submission = createSubmission(input);
  assert.equal(submission.key, problemKey(ref));
  assert.equal(submission.externalId, 'S 7|9');
  assert.deepEqual(parseProblemKey(submission.key), ref);
  assert.deepEqual(parseAccountId(submission.accountId), { sourceInstanceId: HYDRO_8080.id, handle });

  assert.equal(createSubmission(input).id, submission.id);
  assert.notEqual(createSubmission({ ...input, externalId: 'S 7' }).id, submission.id);
  const otherAccount = createAccount({ sourceInstanceId: HYDRO_9090.id, handle });
  assert.notEqual(createSubmission({ ...input, accountId: otherAccount.id }).id, submission.id);
});

test('factory chain: source instance -> account -> problem -> submission', () => {
  const ref: ProblemRef = { sourceInstanceId: HYDRO_8080.id, domain: 'contest|A', externalKey: 'P|1001' };
  const problem = createNormalizedProblem({
    ref,
    title: 'Problem 1001',
    url: 'http://localhost:8080/p/1001',
    fetchedAt: T0,
  });
  for (const handle of ['Alice|β', 'bob@例:2']) {
    const account = createAccount({ sourceInstanceId: HYDRO_8080.id, handle });
    const submission = createSubmission({
      accountId: account.id,
      ref: problem.ref,
      externalId: 'S|1',
      verdict: 'accepted',
      submittedAt: T0,
    });
    assert.equal(submission.key, problem.key);
    assert.deepEqual(parseProblemKey(submission.key), ref);
    assert.deepEqual(parseAccountId(submission.accountId), { sourceInstanceId: HYDRO_8080.id, handle });
  }
  // Handles stay case sensitive: two spellings are two accounts.
  assert.notEqual(
    createAccount({ sourceInstanceId: HYDRO_8080.id, handle: 'Alice|β' }).id,
    createAccount({ sourceInstanceId: HYDRO_8080.id, handle: 'alice|β' }).id,
  );
});

test('malformed and non-canonical ids are rejected', () => {
  const encodedInstance = encodeIdPart(HYDRO_8080.id);
  assert.throws(() => parseProblemKey('a|b'), domainError('invalid_id_part'));
  assert.throws(() => parseProblemKey(`${encodedInstance}|x|%E0%A4%A`), domainError('invalid_id_part'));
  assert.throws(() => parseProblemKey(`${encodedInstance}|x|bad%2f`), domainError('invalid_id_part'));
  assert.throws(() => parseProblemKey(`${encodedInstance}|x|a|b`), domainError('invalid_id_part'));
  assert.throws(
    () => problemKey({ sourceInstanceId: HYDRO_8080.id, domain: null, externalKey: 'x\u0007y' }),
    domainError('invalid_id_part'),
  );
  assert.throws(
    () => createAccount({ sourceInstanceId: HYDRO_8080.id, handle: 'a\u0000b' }),
    domainError('invalid_id_part'),
  );
  assert.throws(() => encodeIdPart('\uD800'), domainError('invalid_id_part'));
});

test('snapshot construction clones caller input without freezing it', () => {
  const ref: ProblemRef = { sourceInstanceId: CF.id, domain: null, externalKey: ' 1234A ' };
  const rawTags = ['dp', 'graphs'];
  const ratings = [{ dimension: 'rating', value: 1500, scale: { min: 0, max: 3000 }, raw: '1500' }];
  const problem = createNormalizedProblem({
    ref,
    title: 'Two Sum',
    url: 'https://codeforces.com/problemset/problem/1234/A',
    fetchedAt: T0,
    rawTags,
    ratings,
  });

  assert.equal(Object.isFrozen(ref), false);
  assert.equal(Object.isFrozen(rawTags), false);
  assert.equal(Object.isFrozen(ratings), false);
  assert.equal(Object.isFrozen(ratings[0]), false);
  assert.equal(ref.externalKey, ' 1234A ');
  assert.equal(problem.ref.externalKey, '1234A');
  assert.deepEqual(parseProblemKey(problem.key), {
    sourceInstanceId: CF.id,
    domain: null,
    externalKey: '1234A',
  });

  const source = createEditorialSource({
    id: 'cf-blog-1',
    kind: 'editorial',
    url: 'https://codeforces.com/blog/entry/1',
    title: 'Editorial',
    availability: 'found',
    retrievedAt: T0,
    text: SOLUTION_TEXT,
  });
  const solution = createEditorialSolution({
    solutionId: 'cf-blog-1-s1',
    sourceId: source.id,
    ordinal: 0,
    title: 'Solution',
    text: SOLUTION_TEXT,
  });
  const callerSources: EditorialSource[] = [{ ...source }];
  const callerSolutions = [{ ...solution }];
  const snapshot = createProblemSnapshot({
    problem,
    sources: callerSources,
    solutions: callerSolutions,
    capturedAt: T1,
  });

  assert.equal(Object.isFrozen(callerSources), false);
  assert.equal(Object.isFrozen(callerSources[0]), false);
  assert.equal(Object.isFrozen(callerSolutions), false);
  assert.ok(isDeeplyFrozen(snapshot));

  // Later caller-side mutation cannot reach into the snapshot.
  Object.assign(callerSources[0]!, { title: 'mutated after snapshot' });
  rawTags.push('mutated');
  assert.equal(snapshot.sources[0]?.title, 'Editorial');
  assert.equal(problem.rawTags.length, 2);
  assert.equal(snapshot.problem.key, problem.key);
});

// ---------------------------------------------------------------------------------------
// Persisted job state
// ---------------------------------------------------------------------------------------

function jobFixture(): ReturnType<typeof createAnalysisJob> {
  const ref: ProblemRef = { sourceInstanceId: CF.id, domain: null, externalKey: '1234A' };
  return createAnalysisJob({ problemRef: ref, snapshotId: 'snapshot|one', at: T0 });
}

const LIMITS: AnalysisJobLimits = { maxAnalysisCalls: 2, maxReasoningCalls: 1, maxAttempts: 3, leaseMs: 60_000 };

test('job transitions require running state and honour non-retryable failures', () => {
  const job = jobFixture();
  assert.throws(
    () => transitionJob(job, { type: 'consume_call', kind: 'analysis', at: T1, limits: LIMITS }),
    domainError('invalid_transition'),
  );
  assert.throws(
    () => transitionJob(job, { type: 'succeed', at: T1, analysisId: 'analysis|one' }),
    domainError('invalid_transition'),
  );

  const running = transitionJob(job, { type: 'start', owner: 'worker-1', at: T1, leaseMs: LIMITS.leaseMs });
  assert.equal(running.status, 'running');
  assert.equal(running.attempts, 1);

  const consumed = transitionJob(running, { type: 'consume_call', kind: 'analysis', at: T1, limits: LIMITS });
  assert.equal(consumed.counters.analysisCalls, 1);
  assert.equal(consumed.status, 'running');

  const permanent = transitionJob(running, {
    type: 'fail',
    at: T1,
    error: { code: 'invalid_request', message: 'model rejected the prompt', retryable: false },
    limits: LIMITS,
  });
  assert.equal(permanent.status, 'failed');
  assert.equal(permanent.counters.retries, 0);
  assert.equal(permanent.leaseOwner, null);

  const transient = transitionJob(running, {
    type: 'fail',
    at: T1,
    error: { code: 'timeout', message: 'gateway timeout', retryable: true },
    limits: LIMITS,
  });
  assert.equal(transient.status, 'pending');
  assert.equal(transient.counters.retries, 1);
});

test('quota pauses retain counters across resume and restart', () => {
  const job = jobFixture();
  const started = transitionJob(job, { type: 'start', owner: 'worker-1', at: T0, leaseMs: 1_000 });
  const first = transitionJob(started, { type: 'consume_call', kind: 'analysis', at: T0, limits: LIMITS });
  const second = transitionJob(first, { type: 'consume_call', kind: 'analysis', at: T0, limits: LIMITS });
  const paused = transitionJob(second, { type: 'consume_call', kind: 'analysis', at: T1, limits: LIMITS });
  assert.equal(paused.status, 'paused_quota');
  assert.equal(paused.counters.analysisCalls, 2);
  assert.equal(paused.lastError?.code, 'quota_exhausted');

  const resumed = transitionJob(paused, { type: 'resume', owner: 'worker-2', at: T2, leaseMs: 1_000 });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.counters.analysisCalls, 2);
  const stillPaused = transitionJob(resumed, { type: 'consume_call', kind: 'analysis', at: T2, limits: LIMITS });
  assert.equal(stillPaused.status, 'paused_quota');
  assert.equal(stillPaused.counters.analysisCalls, 2);

  // A restart reclaim may reset the lease but never the spent budget.
  const recovered = recoverAfterRestart(resumed, T3);
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.counters.analysisCalls, 2);
  const restarted = transitionJob(recovered, { type: 'start', owner: 'worker-3', at: T3, leaseMs: 1_000 });
  assert.equal(restarted.counters.analysisCalls, 2);
  assert.equal(restarted.attempts, resumed.attempts + 1);
});

test('requeue cannot steal a live lease', () => {
  const job = jobFixture();
  const running = transitionJob(job, { type: 'start', owner: 'worker-1', at: T0, leaseMs: 60_000 });
  // The lease is live until 00:01:00; a requeue inside that window must be refused.
  assert.throws(
    () => transitionJob(running, { type: 'requeue', at: '2026-01-01T00:00:30.000Z' }),
    domainError('invalid_transition'),
  );

  const expired = '2026-01-01T01:00:01.000Z';
  const requeued = transitionJob(running, { type: 'requeue', at: expired });
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.leaseOwner, null);
  assert.equal(requeued.attempts, running.attempts);
});

// ---------------------------------------------------------------------------------------
// Analysis constructor + eligibility rules
// ---------------------------------------------------------------------------------------

function makeSnapshot(text: string, previous: ProblemSnapshot | null): ProblemSnapshot {
  const ref: ProblemRef = { sourceInstanceId: CF.id, domain: null, externalKey: '1234A' };
  const problem = createNormalizedProblem({
    ref,
    title: 'Two Sum',
    url: 'https://codeforces.com/problemset/problem/1234/A',
    fetchedAt: T0,
  });
  const source = createEditorialSource({
    id: 'cf-blog-1',
    kind: 'editorial',
    url: 'https://codeforces.com/blog/entry/1',
    title: 'Editorial',
    availability: 'found',
    retrievedAt: T0,
    text,
  });
  const solution = createEditorialSolution({
    solutionId: 'cf-blog-1-s1',
    sourceId: source.id,
    ordinal: 0,
    title: 'Solution',
    text,
  });
  return createProblemSnapshot({ problem, sources: [source], solutions: [solution], capturedAt: T1, previous });
}

const ANALYSIS_REF: ProblemRef = { sourceInstanceId: CF.id, domain: null, externalKey: '1234A' };

function suggestionFor(snapshot: ProblemSnapshot) {
  return createAiTagSuggestion({
    problemRef: ANALYSIS_REF,
    snapshotId: snapshot.snapshotId,
    taxonomyId: TAG,
    role: 'analysis',
    rationale: 'The editorial binary searches the answer.',
    evidence: [{ sourceId: 'cf-blog-1', solutionId: 'cf-blog-1-s1', excerpt: 'binary search the answer' }],
    createdAt: T1,
  });
}

function supportFor(snapshot: ProblemSnapshot, suggestionId: string, overrides: Partial<ProblemRef> = {}) {
  return createSuggestionVerification({
    suggestionId,
    problemRef: { ...ANALYSIS_REF, ...overrides },
    snapshotId: snapshot.snapshotId,
    verdict: 'support',
    verifierRole: 'verification',
    evidenceOk: true,
    checkedAt: T1,
  });
}

function contextFor(
  snapshot: ProblemSnapshot,
  analysis: ReturnType<typeof createAnalysisResult>,
  currentHead: ReturnType<typeof snapshotHead>,
): EvaluateSuggestionContext {
  return {
    index: TAXONOMY,
    snapshot,
    analysis,
    currentHead,
    manualDecisions: [],
    settings: DEFAULT_ELIGIBILITY_SETTINGS,
  };
}

test('analysis constructor rejects verifications from another problem or snapshot', () => {
  const snapshot = makeSnapshot(SOLUTION_TEXT, null);
  const suggestion = suggestionFor(snapshot);
  const base = {
    problemRef: ANALYSIS_REF,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    taxonomyVersion: TAXONOMY_V1_VERSION,
    createdAt: T2,
    status: 'completed' as const,
    suggestions: [suggestion],
  };
  assert.throws(
    () => createAnalysisResult({ ...base, verifications: [supportFor(snapshot, suggestion.suggestionId, { externalKey: '9999Z' })] }),
    domainError('invalid_input'),
  );
  const wrongSnapshot = createSuggestionVerification({
    suggestionId: suggestion.suggestionId,
    problemRef: ANALYSIS_REF,
    snapshotId: 'snapshot|other',
    verdict: 'support',
    verifierRole: 'verification',
    evidenceOk: true,
    checkedAt: T1,
  });
  assert.throws(() => createAnalysisResult({ ...base, verifications: [wrongSnapshot] }), domainError('invalid_input'));
  assert.doesNotThrow(() => createAnalysisResult({ ...base, verifications: [supportFor(snapshot, suggestion.suggestionId)] }));
});

test('only a completed analysis may auto-adopt a verified tag', () => {
  assert.equal(TAXONOMY.has(TAG), true, 'fixture tag must exist in the taxonomy');
  const snapshot = makeSnapshot(SOLUTION_TEXT, null);
  const suggestion = suggestionFor(snapshot);
  const verification = supportFor(snapshot, suggestion.suggestionId);
  const base = {
    problemRef: ANALYSIS_REF,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    taxonomyVersion: TAXONOMY_V1_VERSION,
    createdAt: T2,
    suggestions: [suggestion],
    verifications: [verification],
  };

  const completed = createAnalysisResult({ ...base, status: 'completed' });
  const completedContext = contextFor(snapshot, completed, snapshotHead(snapshot));
  assert.equal(evaluateSuggestion(suggestion, completedContext).decision, 'auto_adopted');
  const resolved = resolveTagDecisions(completedContext);
  assert.equal(resolved.stale, false);
  assert.equal(resolved.decisions.length, 1);
  assert.equal(resolved.decisions[0]?.status, 'auto_adopted');

  const partial = createAnalysisResult({ ...base, status: 'partial' });
  const partialOutcome = evaluateSuggestion(suggestion, contextFor(snapshot, partial, snapshotHead(snapshot)));
  assert.equal(partialOutcome.decision, 'needs_review');
  assert.ok(partialOutcome.reasons.includes('analysis_incomplete'));

  const failed = createAnalysisResult({
    ...base,
    status: 'failed',
    failure: { code: 'model_error', message: 'gateway failed', retryable: true },
  });
  const failedOutcome = evaluateSuggestion(suggestion, contextFor(snapshot, failed, snapshotHead(snapshot)));
  assert.equal(failedOutcome.decision, 'needs_review');
  assert.ok(failedOutcome.reasons.includes('analysis_incomplete'));
});

test('stale detection survives A -> B -> A and empty suggestion lists', () => {
  const first = makeSnapshot(SOLUTION_TEXT, null);
  const second = makeSnapshot(`${SOLUTION_TEXT} Now with an extra paragraph.`, first);
  const third = makeSnapshot(SOLUTION_TEXT, second);
  // A -> B -> A returns to the first content hash, but version 3 is a *different*
  // snapshot: the id embeds the version, so persisted bodies and analysis jobs can never
  // be silently reused for the reverted content.
  assert.equal(third.contentHash, first.contentHash);
  assert.equal(first.version, 1);
  assert.equal(third.version, 3);
  assert.notEqual(third.snapshotId, first.snapshotId);
  assert.notEqual(analysisJobIdOf(third.snapshotId), analysisJobIdOf(first.snapshotId));
  assert.ok(isSnapshotStale(snapshotHead(first), snapshotHead(third)));

  const suggestion = suggestionFor(first);
  const analysis = createAnalysisResult({
    problemRef: ANALYSIS_REF,
    snapshotId: first.snapshotId,
    snapshotVersion: first.version,
    taxonomyVersion: TAXONOMY_V1_VERSION,
    createdAt: T2,
    status: 'completed',
    suggestions: [suggestion],
    verifications: [supportFor(first, suggestion.suggestionId)],
  });
  const staleContext = contextFor(first, analysis, snapshotHead(third));
  assert.equal(evaluateSuggestion(suggestion, staleContext).decision, 'stale_analysis');
  const stale = resolveTagDecisions(staleContext);
  assert.equal(stale.stale, true);
  assert.equal(stale.decisions.length, 0);

  // Zero suggestions must not make a stale analysis look current.
  const emptyAnalysis = createAnalysisResult({
    problemRef: ANALYSIS_REF,
    snapshotId: first.snapshotId,
    snapshotVersion: first.version,
    taxonomyVersion: TAXONOMY_V1_VERSION,
    createdAt: T2,
    status: 'completed',
  });
  const empty = resolveTagDecisions(contextFor(first, emptyAnalysis, snapshotHead(third)));
  assert.equal(empty.stale, true);
  assert.equal(empty.decisions.length, 0);
  assert.deepEqual(empty.outcomes, []);
});
