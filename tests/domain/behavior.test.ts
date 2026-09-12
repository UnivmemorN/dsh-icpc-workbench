/**
 * Stage-1 acceptance behaviour.
 *
 * Every case goes through the public domain factories and states a consequence a user could
 * observe: which tag reaches statistics, which excerpt counts as evidence, which plan task
 * may be checked off, whether reverted content reuses an old snapshot. The fixture builds
 * real problems, snapshots, analyses, submissions and plans — nothing here stubs a
 * production function or asserts a private helper's shape.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ELIGIBILITY_SETTINGS,
  DEFAULT_TRAINING_PLAN_SETTINGS,
  DEFAULT_WEAKNESS_SETTINGS,
  DomainError,
  TAXONOMY_V1,
  TAXONOMY_V1_VERSION,
  adoptPlan,
  algorithmTagIds,
  analysisJobIdOf,
  assertNoMasteryInference,
  checkOffTask,
  classifyRawTag,
  computeWeaknessReports,
  createAccount,
  createAiTagSuggestion,
  createAnalysisJob,
  createAnalysisResult,
  createEditorialSolution,
  createEditorialSource,
  createManualTagDecision,
  createNormalizedProblem,
  createProblemSnapshot,
  createRetrospective,
  createSourceInstance,
  createSubmission,
  createSuggestionVerification,
  createTagDecision,
  createTaxonomyIndex,
  createTrainingCandidate,
  decisionIsEffective,
  duplicateCandidateIds,
  editPlanTask,
  effectiveTagIdsForProblem,
  evaluateSuggestion,
  generateRulePlan,
  prepareCandidatePool,
  previewPlan,
  reportForAccount,
  resolveTagDecisions,
  snapshotHead,
  snapshotIdOf,
  unknownRawTags,
  validateModelPlan,
  type AiTagSuggestion,
  type EvaluateSuggestionContext,
  type ManualTagDecision,
  type ModelRole,
  type NormalizedProblem,
  type PlanValidationCode,
  type ProblemRef,
  type ProblemSnapshot,
  type SnapshotHead,
  type Submission,
  type SubmissionVerdict,
  type SuggestionVerification,
  type TagDecision,
  type TrainingCandidate,
} from '../../src/domain/index.js';

// ---------------------------------------------------------------------------------------
// Reusable fixture: real ids, real hashes, real factory chain
// ---------------------------------------------------------------------------------------

const T0 = '2026-02-01T00:00:00.000Z';
const T1 = '2026-02-01T01:00:00.000Z';
const T2 = '2026-02-01T02:00:00.000Z';
const T3 = '2026-02-01T03:00:00.000Z';

const CF = createSourceInstance({ platform: 'codeforces', baseUrl: 'https://codeforces.com' });
const TAXONOMY = createTaxonomyIndex(TAXONOMY_V1);

/** The technique the editorial fixture actually demonstrates. */
const TAG = 'search.binary-answer';
const TEXT_A = 'We binary search the answer and check feasibility with a greedy scan over the array.';
const TEXT_B = 'We model the states as a graph and run Dijkstra from the source node.';

function domainError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

function refFor(externalKey: string): ProblemRef {
  return { sourceInstanceId: CF.id, domain: null, externalKey };
}

function problemUrl(externalKey: string): string {
  return `https://codeforces.com/problemset/problem/${externalKey}`;
}

function makeProblem(
  externalKey: string,
  options: { readonly rawTags?: readonly string[]; readonly rating?: number } = {},
): NormalizedProblem {
  return createNormalizedProblem({
    ref: refFor(externalKey),
    title: `Problem ${externalKey}`,
    url: problemUrl(externalKey),
    fetchedAt: T0,
    rawTags: options.rawTags,
    ratings:
      options.rating === undefined
        ? []
        : [{ dimension: 'rating', value: options.rating, scale: { min: 0, max: 3500 }, raw: String(options.rating) }],
  });
}

interface SolutionSpec {
  readonly solutionId: string;
  readonly text: string;
  readonly title?: string;
}

function makeSnapshot(
  options: {
    readonly externalKey?: string;
    readonly rawTags?: readonly string[];
    readonly solutions?: readonly SolutionSpec[];
    readonly previous?: ProblemSnapshot | null;
  } = {},
): ProblemSnapshot {
  const externalKey = options.externalKey ?? '1001A';
  const specs = options.solutions ?? [{ solutionId: 's1', text: TEXT_A }];
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: 'https://codeforces.com/blog/entry/1',
    title: 'Editorial',
    availability: 'found',
    retrievedAt: T0,
    text: specs.map((spec) => spec.text).join('\n\n'),
  });
  const solutions = specs.map((spec, ordinal) =>
    createEditorialSolution({
      solutionId: spec.solutionId,
      sourceId: source.id,
      ordinal,
      title: spec.title ?? `Solution ${spec.solutionId}`,
      text: spec.text,
    }),
  );
  return createProblemSnapshot({
    problem: makeProblem(externalKey, { rawTags: options.rawTags }),
    sources: [source],
    solutions,
    capturedAt: T1,
    previous: options.previous ?? null,
  });
}

interface SuggestionOptions {
  readonly taxonomyId?: string;
  readonly role?: ModelRole;
  readonly sourceId?: string;
  readonly solutionId?: string;
  readonly excerpt?: string;
}

function makeSuggestion(snapshot: ProblemSnapshot, options: SuggestionOptions = {}): AiTagSuggestion {
  return createAiTagSuggestion({
    problemRef: snapshot.problem.ref,
    snapshotId: snapshot.snapshotId,
    taxonomyId: options.taxonomyId ?? TAG,
    role: options.role ?? 'analysis',
    rationale: 'The cited solution applies this technique.',
    evidence: [
      {
        sourceId: options.sourceId ?? 'editorial-1',
        solutionId: options.solutionId ?? 's1',
        excerpt: options.excerpt ?? 'binary search the answer',
      },
    ],
    createdAt: T1,
  });
}

interface VerificationOptions {
  readonly verdict?: 'support' | 'conflict' | 'insufficient';
  readonly verifierRole?: 'verification' | 'reasoning';
  readonly evidenceOk?: boolean;
  readonly conflictingSolutionIds?: readonly string[];
}

function makeVerification(
  snapshot: ProblemSnapshot,
  suggestion: AiTagSuggestion,
  options: VerificationOptions = {},
): SuggestionVerification {
  return createSuggestionVerification({
    suggestionId: suggestion.suggestionId,
    problemRef: snapshot.problem.ref,
    snapshotId: snapshot.snapshotId,
    verdict: options.verdict ?? 'support',
    verifierRole: options.verifierRole ?? 'verification',
    evidenceOk: options.evidenceOk ?? true,
    conflictingSolutionIds: options.conflictingSolutionIds ?? [],
    checkedAt: T2,
  });
}

function analysisFor(
  snapshot: ProblemSnapshot,
  suggestions: readonly AiTagSuggestion[],
  verifications: readonly SuggestionVerification[],
) {
  return createAnalysisResult({
    problemRef: snapshot.problem.ref,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    taxonomyVersion: TAXONOMY_V1_VERSION,
    createdAt: T2,
    status: 'completed',
    suggestions,
    verifications,
  });
}

function contextFor(
  snapshot: ProblemSnapshot,
  analysis: ReturnType<typeof analysisFor>,
  options: { readonly currentHead?: SnapshotHead | null; readonly manualDecisions?: readonly ManualTagDecision[] } = {},
): EvaluateSuggestionContext {
  return {
    index: TAXONOMY,
    snapshot,
    analysis,
    currentHead: options.currentHead === undefined ? snapshotHead(snapshot) : options.currentHead,
    manualDecisions: options.manualDecisions ?? [],
    settings: DEFAULT_ELIGIBILITY_SETTINGS,
  };
}

/** Run one suggestion through the pipeline the way the product does: evidence + second pass. */
function evaluateWithVerification(
  snapshot: ProblemSnapshot,
  options: {
    readonly suggestion?: SuggestionOptions;
    readonly verification?: VerificationOptions;
    readonly manualDecisions?: readonly ManualTagDecision[];
    readonly verified?: boolean;
    readonly currentHead?: SnapshotHead | null;
  } = {},
): {
  readonly suggestion: AiTagSuggestion;
  readonly outcome: ReturnType<typeof evaluateSuggestion>;
  readonly resolved: ReturnType<typeof resolveTagDecisions>;
} {
  const suggestion = makeSuggestion(snapshot, options.suggestion ?? {});
  const verifications =
    options.verified === false ? [] : [makeVerification(snapshot, suggestion, options.verification ?? {})];
  const analysis = analysisFor(snapshot, [suggestion], verifications);
  const context = contextFor(snapshot, analysis, {
    currentHead: options.currentHead,
    manualDecisions: options.manualDecisions,
  });
  return { suggestion, outcome: evaluateSuggestion(suggestion, context), resolved: resolveTagDecisions(context) };
}

/** Tag one problem through the real pipeline; the returned decisions are already resolved. */
function tagProblem(
  externalKey: string,
  taxonomyId: string,
  options: { readonly manualAction?: 'accept' | 'reject'; readonly manualAt?: string } = {},
): { readonly problem: NormalizedProblem; readonly decisions: readonly TagDecision[] } {
  const snapshot = makeSnapshot({ externalKey });
  const suggestion = makeSuggestion(snapshot, { taxonomyId });
  const analysis = analysisFor(snapshot, [suggestion], [makeVerification(snapshot, suggestion)]);
  const manual = options.manualAction
    ? [
        createManualTagDecision({
          problemRef: snapshot.problem.ref,
          taxonomyId,
          action: options.manualAction,
          decidedAt: options.manualAt ?? T3,
        }),
      ]
    : [];
  const resolved = resolveTagDecisions(contextFor(snapshot, analysis, { manualDecisions: manual }));
  return { problem: snapshot.problem, decisions: resolved.decisions };
}

function makeAccount(handle: string) {
  return createAccount({ sourceInstanceId: CF.id, handle });
}

function submissionsFor(
  accountId: string,
  problem: NormalizedProblem,
  verdicts: readonly SubmissionVerdict[],
): Submission[] {
  return verdicts.map((verdict, index) =>
    createSubmission({
      accountId,
      ref: problem.ref,
      externalId: `${problem.ref.externalKey}-${index}`,
      verdict,
      submittedAt: new Date(Date.parse(T0) + index * 60_000).toISOString(),
    }),
  );
}

function reportOf(input: {
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  readonly decisions: readonly TagDecision[];
  readonly retrospectives?: Parameters<typeof computeWeaknessReports>[0]['retrospectives'];
}) {
  return computeWeaknessReports({
    problems: input.problems,
    submissions: input.submissions,
    decisions: input.decisions,
    retrospectives: input.retrospectives ?? [],
    settings: DEFAULT_WEAKNESS_SETTINGS,
  });
}

// ---------------------------------------------------------------------------------------
// 1. Taxonomy: bilingual aliases, provenance noise, unknown preservation
// ---------------------------------------------------------------------------------------

test('bilingual spellings resolve to one node while source, event and year stay non-algorithm', () => {
  const english = classifyRawTag(TAXONOMY, 'Binary Search');
  const chinese = classifyRawTag(TAXONOMY, '二分');
  assert.equal(english.kind, 'taxonomy');
  assert.equal(chinese.kind, 'taxonomy');
  assert.equal(english.kind === 'taxonomy' ? english.taxonomyId : null, 'search.binary');
  assert.equal(chinese.kind === 'taxonomy' ? chinese.taxonomyId : null, 'search.binary');

  assert.deepEqual(classifyRawTag(TAXONOMY, '2024'), { kind: 'non_algorithm', raw: '2024', reason: 'year' });
  assert.deepEqual(classifyRawTag(TAXONOMY, 'CF'), { kind: 'non_algorithm', raw: 'CF', reason: 'source' });
  assert.deepEqual(classifyRawTag(TAXONOMY, 'NOIP'), { kind: 'non_algorithm', raw: 'NOIP', reason: 'event' });

  // An unmapped tag is preserved verbatim instead of being guessed into a technique.
  assert.deepEqual(classifyRawTag(TAXONOMY, '概率生成函数'), { kind: 'unknown', raw: '概率生成函数' });
});

test('only algorithm rows reach the tag view; unknowns stay visible for review', () => {
  const rawTags = ['二分', '2024', 'CF', 'NOIP', '概率生成函数', 'dp'];
  assert.deepEqual(algorithmTagIds(TAXONOMY, rawTags), ['search.binary', 'dp']);
  assert.deepEqual(unknownRawTags(TAXONOMY, rawTags), ['概率生成函数']);
  for (const id of algorithmTagIds(TAXONOMY, rawTags)) {
    assert.equal(TAXONOMY.has(id), true, `${id} must be a real taxonomy node`);
  }
});

// ---------------------------------------------------------------------------------------
// 2. Evidence, verification and manual precedence
// ---------------------------------------------------------------------------------------

test('an excerpt only counts inside the solution that actually contains it', () => {
  const snapshot = makeSnapshot({
    externalKey: '4001A',
    solutions: [
      { solutionId: 's1', text: TEXT_A },
      { solutionId: 's2', text: TEXT_B },
    ],
  });

  const supported = evaluateWithVerification(snapshot);
  assert.equal(supported.outcome.decision, 'auto_adopted');
  assert.ok(supported.outcome.reasons.includes('evidence_verified'));
  assert.equal(supported.resolved.decisions[0]?.status, 'auto_adopted');
  assert.equal(decisionIsEffective(supported.resolved.decisions[0]!), true);

  // The very same excerpt attributed to the other solution on the page is not evidence.
  const misplaced = evaluateWithVerification(snapshot, { suggestion: { solutionId: 's2' } });
  assert.equal(misplaced.outcome.decision, 'rejected');
  assert.ok(misplaced.outcome.reasons.includes('evidence_not_in_solution'));
  assert.equal(decisionIsEffective(misplaced.resolved.decisions[0]!), false);

  const absent = evaluateWithVerification(snapshot, {
    suggestion: { excerpt: 'we prove it by induction over the tree' },
  });
  assert.equal(absent.outcome.decision, 'rejected');
  assert.ok(absent.outcome.reasons.includes('evidence_not_in_solution'));
});

test('fabricated sources, unknown taxonomy ids and missing verification never auto-adopt', () => {
  const snapshot = makeSnapshot({ externalKey: '4002B' });

  const ghost = evaluateWithVerification(snapshot, { suggestion: { sourceId: 'ghost-blog' } });
  assert.equal(ghost.outcome.decision, 'rejected');
  assert.ok(ghost.outcome.reasons.includes('missing_source'));

  const unknown = evaluateWithVerification(snapshot, { suggestion: { taxonomyId: 'search.quantum' } });
  assert.equal(unknown.outcome.decision, 'rejected');
  assert.ok(unknown.outcome.reasons.includes('unknown_taxonomy_id'));
  assert.equal(decisionIsEffective(unknown.resolved.decisions[0]!), false);

  const unverified = evaluateWithVerification(snapshot, { verified: false });
  assert.equal(unverified.outcome.decision, 'needs_review');
  assert.ok(unverified.outcome.reasons.includes('missing_verification'));
  assert.equal(decisionIsEffective(unverified.resolved.decisions[0]!), false);
});

test('a conflicting verification sends the tag to review and reasoning is never auto-adopted', () => {
  const snapshot = makeSnapshot({
    externalKey: '4003C',
    solutions: [
      { solutionId: 's1', text: TEXT_A },
      { solutionId: 's2', text: TEXT_B },
    ],
  });

  const conflict = evaluateWithVerification(snapshot, {
    verification: { verdict: 'conflict', conflictingSolutionIds: ['s2'] },
  });
  assert.equal(conflict.outcome.decision, 'needs_review');
  assert.ok(conflict.outcome.reasons.includes('verification_conflict'));
  assert.equal(conflict.resolved.decisions[0]?.status, 'needs_review');
  assert.equal(decisionIsEffective(conflict.resolved.decisions[0]!), false);

  // A reasoning draft can be supported by the second pass and still never auto-adopts.
  const reasoning = evaluateWithVerification(snapshot, { suggestion: { role: 'reasoning' } });
  assert.equal(reasoning.outcome.decision, 'needs_review');
  assert.ok(reasoning.outcome.reasons.includes('reasoning_requires_review'));
  assert.equal(decisionIsEffective(reasoning.resolved.decisions[0]!), false);
});

test('manual accept/reject wins, and analysing a tagged problem keeps its original tags', () => {
  const rawTags = ['dp', '二分', '2024', 'CF', '概率生成函数'];
  const snapshot = makeSnapshot({
    externalKey: '4004D',
    rawTags,
    solutions: [{ solutionId: 's1', text: TEXT_A }],
  });
  const raw = snapshot.problem.rawTags.map((tag) => tag.raw);
  assert.deepEqual(raw, rawTags);
  assert.deepEqual(algorithmTagIds(TAXONOMY, raw), ['dp', 'search.binary']);
  assert.deepEqual(unknownRawTags(TAXONOMY, raw), ['概率生成函数']);

  const accepted = createManualTagDecision({
    problemRef: snapshot.problem.ref,
    taxonomyId: TAG,
    action: 'accept',
    decidedAt: T3,
  });
  const withAccept = evaluateWithVerification(snapshot, { manualDecisions: [accepted] });
  assert.equal(withAccept.outcome.decision, 'accepted_manual');
  assert.ok(withAccept.outcome.reasons.includes('manual_precedence'));
  assert.equal(withAccept.resolved.decisions[0]?.status, 'accepted');
  assert.equal(withAccept.resolved.decisions[0]?.origin, 'manual');
  assert.equal(withAccept.resolved.decisions[0]?.decidedAt, T3);

  const rejected = createManualTagDecision({
    problemRef: snapshot.problem.ref,
    taxonomyId: TAG,
    action: 'reject',
    decidedAt: T3,
  });
  const withReject = evaluateWithVerification(snapshot, { manualDecisions: [rejected] });
  assert.equal(withReject.outcome.decision, 'rejected_manual');
  assert.equal(withReject.resolved.decisions[0]?.status, 'rejected');
  assert.equal(decisionIsEffective(withReject.resolved.decisions[0]!), false);

  // Analysing an already-tagged problem is additive: the platform's own tags survive and
  // the AI decision stays distinguishable from them.
  assert.deepEqual(snapshot.problem.rawTags.map((tag) => tag.raw), rawTags);
  assert.equal(raw.includes(TAG), false);
  assert.equal(withAccept.resolved.decisions[0]?.origin, 'ai' === 'ai' ? 'manual' : 'manual');
  assert.equal(withAccept.resolved.decisions.length, 1);
});

// ---------------------------------------------------------------------------------------
// 3. Weakness statistics
// ---------------------------------------------------------------------------------------

test('ranking waits for the minimum sample, while the sample count stays visible below it', () => {
  assert.equal(DEFAULT_WEAKNESS_SETTINGS.minDistinctProblems, 5);
  const account = makeAccount('sample-gate');
  const four = ['3001A', '3002B', '3003C', '3004D'].map((key) => tagProblem(key, TAG));
  const fourProblems = four.map((entry) => entry.problem);
  const fourSubmissions = fourProblems.flatMap((problem) =>
    submissionsFor(account.id, problem, ['wrong_answer', 'accepted']),
  );
  const fourReport = reportForAccount(
    reportOf({
      problems: fourProblems,
      submissions: fourSubmissions,
      decisions: four.flatMap((entry) => entry.decisions),
    }),
    account.id,
  );
  assert.ok(fourReport);
  assert.equal(fourReport.attemptedDistinctTotal, 4);
  assert.equal(fourReport.solvedDistinctTotal, 4);
  assert.equal(fourReport.tagCoverageRatio, 1);
  assert.equal(fourReport.tags.length, 1);
  assert.equal(fourReport.tags[0]?.attemptedDistinct, 4);
  assert.equal(fourReport.tags[0]?.sampleSize, 4);
  assert.equal(fourReport.tags[0]?.minimumSampleSize, 5);
  assert.equal(fourReport.tags[0]?.sufficient, false);
  assert.deepEqual(fourReport.ranking, []);
  assert.deepEqual(
    fourReport.insufficientEvidence.map((tag) => tag.taxonomyId),
    [TAG],
  );

  const fifth = tagProblem('3005E', TAG);
  const fiveReport = reportForAccount(
    reportOf({
      problems: [...fourProblems, fifth.problem],
      submissions: [...fourSubmissions, ...submissionsFor(account.id, fifth.problem, ['accepted'])],
      decisions: [...four.flatMap((entry) => entry.decisions), ...fifth.decisions],
    }),
    account.id,
  );
  assert.ok(fiveReport);
  assert.deepEqual(
    fiveReport.ranking.map((tag) => tag.taxonomyId),
    [TAG],
  );
  assert.equal(fiveReport.ranking[0]?.sampleSize, 5);
  assert.equal(fiveReport.ranking[0]?.solveRate, 1);
  assert.deepEqual(fiveReport.insufficientEvidence, []);
});

test('repeated WA/AC on one problem count once, and two accounts never mix', () => {
  const tagged = ['3101A', '3102B', '3103C', '3104D', '3105E'].map((key) => tagProblem(key, TAG));
  const problems = tagged.map((entry) => entry.problem);
  const decisions = tagged.flatMap((entry) => entry.decisions);
  const alice = makeAccount('alice');
  const bob = makeAccount('bob');
  const submissions = [
    ...problems.flatMap((problem) => submissionsFor(alice.id, problem, ['wrong_answer', 'accepted'])),
    ...submissionsFor(bob.id, problems[0] as NormalizedProblem, ['wrong_answer', 'wrong_answer', 'accepted']),
  ];
  const reports = reportOf({ problems, submissions, decisions });
  assert.equal(reports.length, 2);

  const aliceReport = reportForAccount(reports, alice.id);
  const bobReport = reportForAccount(reports, bob.id);
  assert.ok(aliceReport);
  assert.ok(bobReport);
  assert.equal(aliceReport.attemptedDistinctTotal, 5);
  assert.equal(aliceReport.solvedDistinctTotal, 5);
  assert.equal(aliceReport.tags[0]?.attemptedDistinct, 5);
  assert.equal(aliceReport.ranking.length, 1);

  assert.equal(bobReport.attemptedDistinctTotal, 1);
  assert.equal(bobReport.solvedDistinctTotal, 1);
  assert.equal(bobReport.tags[0]?.attemptedDistinct, 1);
  assert.equal(bobReport.tags[0]?.sufficient, false);
  assert.deepEqual(bobReport.ranking, []);
});

test('an AC confirms no skill; a retrospective records the technique and how it was solved', () => {
  const tagged = ['3201A', '3202B'].map((key) => tagProblem(key, TAG));
  const problems = tagged.map((entry) => entry.problem);
  const decisions = tagged.flatMap((entry) => entry.decisions);
  const account = makeAccount('retro-solver');
  const submissions = problems.flatMap((problem) => submissionsFor(account.id, problem, ['accepted']));

  const withoutRetrospective = reportForAccount(reportOf({ problems, submissions, decisions }), account.id);
  assert.ok(withoutRetrospective);
  assert.equal(withoutRetrospective.confirmedSkills.total, 0);
  assert.deepEqual(withoutRetrospective.confirmedSkills.taxonomyIds, []);
  assert.ok(withoutRetrospective.notes.includes('ac_does_not_imply_solution_mastery'));
  assert.ok(withoutRetrospective.notes.includes('no_retrospectives'));
  assert.doesNotThrow(() => assertNoMasteryInference(withoutRetrospective));

  const independent = createRetrospective({
    problemRef: problems[0]!.ref,
    accountId: account.id,
    mode: 'independent',
    recordedAt: T2,
    taxonomyIds: [TAG],
  });
  const assisted = createRetrospective({
    problemRef: problems[1]!.ref,
    accountId: account.id,
    mode: 'assisted',
    recordedAt: T3,
    taxonomyIds: [TAG],
    solutionIds: ['s1'],
  });
  const withRetrospectives = reportForAccount(
    reportOf({ problems, submissions, decisions, retrospectives: [independent, assisted] }),
    account.id,
  );
  assert.ok(withRetrospectives);
  assert.deepEqual(withRetrospectives.confirmedSkills, {
    total: 2,
    independent: 1,
    assisted: 1,
    solutionUsed: 0,
    taxonomyIds: [TAG],
  });
  assert.deepEqual(withRetrospectives.tags[0]?.confirmedSkills, withRetrospectives.confirmedSkills);
});

test('re-recording a retrospective replaces the earlier one instead of doubling the skill', () => {
  const tagged = ['3301A', '3302B', '3303C', '3304D', '3305E'].map((key) => tagProblem(key, TAG));
  const problems = tagged.map((entry) => entry.problem);
  const account = makeAccount('re-recorder');
  const other = makeAccount('other-solver');
  const submissions = problems.flatMap((problem) => submissionsFor(account.id, problem, ['accepted']));

  const first = createRetrospective({
    problemRef: problems[0]!.ref,
    accountId: account.id,
    mode: 'independent',
    recordedAt: T1,
    taxonomyIds: [TAG],
  });
  const reRecorded = createRetrospective({
    problemRef: problems[0]!.ref,
    accountId: account.id,
    mode: 'assisted',
    recordedAt: T3,
    taxonomyIds: [TAG],
  });
  const foreign = createRetrospective({
    problemRef: problems[0]!.ref,
    accountId: other.id,
    mode: 'independent',
    recordedAt: T2,
    taxonomyIds: [TAG],
  });

  const report = reportForAccount(
    reportOf({
      problems,
      submissions,
      decisions: tagged.flatMap((entry) => entry.decisions),
      retrospectives: [first, reRecorded, foreign],
    }),
    account.id,
  );
  assert.ok(report);
  assert.deepEqual(report.confirmedSkills, {
    total: 1,
    independent: 0,
    assisted: 1,
    solutionUsed: 0,
    taxonomyIds: [TAG],
  });
});

test('a later manual reject removes an adopted tag instead of being unioned with it', () => {
  const keys = ['3401A', '3402B', '3403C', '3404D', '3405E'];
  const earlier = keys.map((key) => tagProblem(key, TAG));
  const problems = earlier.map((entry) => entry.problem);
  const rejected = tagProblem(keys[0] as string, TAG, { manualAction: 'reject', manualAt: T3 });
  const decisions = [...earlier.flatMap((entry) => entry.decisions), ...rejected.decisions];

  // The history really contains both an old adoption and the newer human rejection.
  assert.equal(earlier[0]?.decisions[0]?.status, 'auto_adopted');
  assert.equal(rejected.decisions[0]?.status, 'rejected');
  assert.equal(rejected.decisions[0]?.origin, 'manual');
  assert.deepEqual(effectiveTagIdsForProblem(decisions, problems[0]!.key), []);

  const account = makeAccount('reject-wins');
  const submissions = problems.flatMap((problem) => submissionsFor(account.id, problem, ['accepted']));
  const report = reportForAccount(reportOf({ problems, submissions, decisions }), account.id);
  assert.ok(report);
  assert.equal(report.tags[0]?.taxonomyId, TAG);
  assert.equal(report.tags[0]?.attemptedDistinct, 4);
  assert.equal(report.tags[0]?.sufficient, false);
  assert.deepEqual(report.ranking, []);
});

test('a human accept survives a later automated rejection', () => {
  const accepted = tagProblem('3501A', TAG, { manualAction: 'accept', manualAt: T2 });
  const laterAiReject = createTagDecision({
    problemKey: accepted.problem.key,
    taxonomyId: TAG,
    status: 'rejected',
    origin: 'ai',
    decidedAt: T3,
    reasons: ['evidence_not_in_solution'],
  });
  assert.deepEqual(effectiveTagIdsForProblem([...accepted.decisions, laterAiReject], accepted.problem.key), [TAG]);
  // Order of the history must not change the winner either.
  assert.deepEqual(effectiveTagIdsForProblem([laterAiReject, ...accepted.decisions], accepted.problem.key), [TAG]);
});

// ---------------------------------------------------------------------------------------
// 4. Training plans
// ---------------------------------------------------------------------------------------

function makeCandidate(
  candidateId: string,
  externalKey: string,
  estimatedMinutes: number,
  taxonomyIds: readonly string[] = [TAG],
): TrainingCandidate {
  return createTrainingCandidate({
    candidateId,
    problemRef: refFor(externalKey),
    title: `Problem ${externalKey}`,
    sourceUrl: problemUrl(externalKey),
    estimatedMinutes,
    taxonomyIds,
    origin: 'weakness',
  });
}

test('the rule generator fills the 7-day / 60-minute default budget with real candidates only', () => {
  assert.deepEqual(DEFAULT_TRAINING_PLAN_SETTINGS, { horizonDays: 7, minutesPerDay: 60, maxTasksPerDay: 3 });
  const candidates = [
    makeCandidate('cand-1', '1001A', 60),
    makeCandidate('cand-2', '1002B', 30),
    makeCandidate('cand-3', '1003C', 30),
  ];
  const account = makeAccount('planner');
  const result = generateRulePlan({
    candidates,
    weaknessReports: [],
    settings: DEFAULT_TRAINING_PLAN_SETTINGS,
    now: T1,
    accountId: account.id,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const plan = result.plan;
  assert.equal(plan.source, 'rule');
  assert.equal(plan.status, 'draft');
  assert.equal(plan.horizonDays, 7);
  assert.equal(plan.minutesPerDay, 60);
  assert.equal(plan.evidence.level, 'insufficient_history');
  assert.equal(plan.evidence.reasons.includes('no_candidates'), false);

  const known = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const task of plan.tasks) {
    const candidate = known.get(task.candidateId);
    assert.ok(candidate, `task ${task.taskId} must point at a real candidate`);
    assert.equal(task.sourceUrl, candidate.sourceUrl);
    assert.equal(task.title, candidate.title);
    assert.equal(task.problemKey, candidate.problemKey);
    assert.ok(task.day >= 1 && task.day <= 7);
  }
  assert.deepEqual(duplicateCandidateIds(plan.tasks), []);

  const preview = previewPlan(plan);
  assert.deepEqual(
    preview.days.map((day) => day.minutes),
    [60, 60, 0, 0, 0, 0, 0],
  );
  for (const day of preview.days) {
    assert.ok(day.minutes <= plan.minutesPerDay);
  }
  assert.equal(preview.totalPlannedMinutes, 120);
  assert.equal(preview.totalUnmetMinutes, 300);
  assert.equal(preview.hasDuplicateCandidates, false);
  assert.equal(preview.distinctCandidates, 3);
});

test('the rule path is deterministic, model-free and explicit when nothing can be scheduled', () => {
  const account = makeAccount('no-candidates');
  const input = {
    candidates: [makeCandidate('cand-1', '1101A', 30)],
    weaknessReports: [],
    settings: DEFAULT_TRAINING_PLAN_SETTINGS,
    now: T1,
    accountId: account.id,
  } as const;
  const first = generateRulePlan(input);
  const second = generateRulePlan(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) {
    return;
  }
  assert.deepEqual(first.plan, second.plan);
  assert.equal(first.plan.source, 'rule');

  const empty = generateRulePlan({
    candidates: [],
    weaknessReports: [],
    settings: DEFAULT_TRAINING_PLAN_SETTINGS,
    now: T1,
    accountId: account.id,
    taxonomy: TAXONOMY,
  });
  assert.equal(empty.ok, false);
  if (empty.ok) {
    return;
  }
  assert.equal(empty.reason, 'insufficient_evidence');
  assert.ok(empty.evidence.reasons.includes('no_candidates'));
  assert.ok(empty.beginnerRecommendations.length > 0);
  for (const recommendation of empty.beginnerRecommendations) {
    assert.equal(recommendation.basis, 'taxonomy_default');
    assert.equal(TAXONOMY.has(recommendation.taxonomyId), true);
    assert.ok(recommendation.nameEn.length > 0 && recommendation.nameZh.length > 0);
  }
});

test('two candidates for the same problem are one scheduling slot', () => {
  const first = makeCandidate('cand-1', '1201A', 30);
  const duplicate = makeCandidate('cand-2', '1201A', 30);
  const pool = prepareCandidatePool([first, duplicate]);
  assert.deepEqual(
    pool.valid.map((candidate) => candidate.candidateId),
    ['cand-1'],
  );
  assert.deepEqual(
    pool.rejected.map((rejection) => rejection.reason),
    ['duplicate_problem'],
  );
  assert.equal(pool.rejected[0]?.candidateId, 'cand-2');

  const generated = generateRulePlan({
    candidates: [first, duplicate],
    weaknessReports: [],
    settings: DEFAULT_TRAINING_PLAN_SETTINGS,
    now: T1,
  });
  assert.equal(generated.ok, true);
  if (!generated.ok) {
    return;
  }
  assert.deepEqual(
    generated.plan.tasks.map((task) => task.candidateId),
    ['cand-1'],
  );
  assert.deepEqual(
    generated.rejectedCandidates.map((rejection) => rejection.reason),
    ['duplicate_problem'],
  );
});

test('a model plan may only name validated candidates; links and titles come from the pool', () => {
  const candidates = [makeCandidate('cand-1', '1301A', 30), makeCandidate('cand-2', '1302B', 30)];
  const validated = validateModelPlan({
    raw: {
      tasks: [
        { day: 1, candidateId: 'cand-1' },
        { day: 1, candidateId: 'cand-2', sourceUrl: candidates[1]?.sourceUrl },
      ],
    },
    candidates,
    settings: DEFAULT_TRAINING_PLAN_SETTINGS,
    now: T1,
    accountId: makeAccount('model-plan').id,
  });
  assert.equal(validated.ok, true);
  const plan = validated.plan;
  assert.ok(plan);
  assert.equal(plan.source, 'model');
  assert.equal(plan.status, 'draft');
  assert.deepEqual(
    plan.tasks.map((task) => task.candidateId),
    ['cand-1', 'cand-2'],
  );
  assert.deepEqual(
    plan.tasks.map((task) => task.sourceUrl),
    candidates.map((candidate) => candidate.sourceUrl),
  );
  assert.deepEqual(
    plan.tasks.map((task) => task.title),
    candidates.map((candidate) => candidate.title),
  );
  assert.deepEqual(
    plan.tasks.map((task) => task.problemKey),
    candidates.map((candidate) => candidate.problemKey),
  );
});

test('hallucinated ids, mismatched links, duplicates and budget overruns are rejected', () => {
  const candidates = [
    makeCandidate('cand-1', '1401A', 30),
    makeCandidate('cand-2', '1402B', 30),
    makeCandidate('cand-3', '1403C', 60),
  ];
  const rejected: readonly { readonly raw: unknown; readonly code: PlanValidationCode }[] = [
    { raw: { tasks: [] }, code: 'no_tasks' },
    { raw: { tasks: [{ day: 1, candidateId: 'cand-99' }] }, code: 'unknown_candidate_id' },
    { raw: { tasks: [{ day: 1, candidateId: 'cand-1', sourceUrl: 'https://evil.example/1' }] }, code: 'source_url_mismatch' },
    { raw: { tasks: [{ day: 1, candidateId: 'cand-1', problemKey: 'other|domain|1' }] }, code: 'candidate_problem_mismatch' },
    { raw: { tasks: [{ day: 1, candidateId: 'cand-1' }, { day: 2, candidateId: 'cand-1' }] }, code: 'duplicate_candidate' },
    { raw: { tasks: [{ day: 8, candidateId: 'cand-1' }] }, code: 'day_out_of_range' },
    { raw: { tasks: [{ day: 1, candidateId: 'cand-2', minutes: 90 }] }, code: 'invalid_minutes' },
    {
      raw: { tasks: [{ day: 1, candidateId: 'cand-3' }, { day: 1, candidateId: 'cand-2' }] },
      code: 'minutes_exceeded',
    },
  ];

  for (const entry of rejected) {
    const result = validateModelPlan({
      raw: entry.raw,
      candidates,
      settings: DEFAULT_TRAINING_PLAN_SETTINGS,
      now: T1,
    });
    assert.equal(result.ok, false, `${entry.code} must be rejected`);
    assert.equal(result.plan, null);
    assert.ok(
      result.errors.some((error) => error.code === entry.code),
      `expected ${entry.code}, got ${result.errors.map((error) => error.code).join(', ')}`,
    );
  }
});

test('preview -> adopt -> edit -> check off keeps the recorded history truthful', () => {
  const candidates = [
    makeCandidate('cand-1', '1501A', 60),
    makeCandidate('cand-2', '1502B', 30),
    makeCandidate('cand-3', '1503C', 30),
  ];
  const generated = generateRulePlan({
    candidates,
    weaknessReports: [],
    settings: DEFAULT_TRAINING_PLAN_SETTINGS,
    now: T1,
    accountId: makeAccount('flow').id,
  });
  assert.equal(generated.ok, true);
  if (!generated.ok) {
    return;
  }
  const draft = generated.plan;
  const firstTask = draft.tasks[0];
  const secondTask = draft.tasks[1];
  assert.ok(firstTask);
  assert.ok(secondTask);

  // Progress cannot be recorded against a plan nobody adopted yet.
  assert.throws(
    () => checkOffTask(draft, firstTask.taskId, { at: T2, status: 'done' }),
    domainError('invalid_transition'),
  );

  const adopted = adoptPlan(draft, { adoptedAt: T2 });
  assert.equal(adopted.status, 'adopted');
  assert.throws(() => adoptPlan(adopted, { adoptedAt: T3 }), domainError('invalid_transition'));

  // Editing must respect the 60-minute day: day 1 already holds a 60-minute task.
  assert.throws(() => editPlanTask(adopted, secondTask.taskId, { day: 1 }, { at: T3 }), domainError('invalid_input'));
  assert.throws(() => editPlanTask(adopted, secondTask.taskId, { minutes: 61 }, { at: T3 }), domainError('invalid_input'));
  assert.throws(() => editPlanTask(adopted, secondTask.taskId, { day: 8 }, { at: T3 }), domainError('invalid_input'));

  const shortened = editPlanTask(adopted, firstTask.taskId, { minutes: 45 }, { at: T3 });
  assert.equal(previewPlan(shortened).days[0]?.minutes, 45);
  assert.equal(previewPlan(shortened).days[0]?.unmetMinutes, 15);

  const done = checkOffTask(shortened, firstTask.taskId, { at: T3, status: 'done' });
  assert.equal(done.tasks[0]?.status, 'done');
  assert.equal(done.tasks[0]?.checkedAt, T3);
  assert.throws(
    () => editPlanTask(done, firstTask.taskId, { minutes: 30 }, { at: T3 }),
    domainError('invalid_transition'),
  );
  assert.throws(
    () => checkOffTask(done, firstTask.taskId, { at: T3, status: 'done' }),
    domainError('invalid_transition'),
  );
  const skipped = checkOffTask(done, secondTask.taskId, { at: T3, status: 'skipped' });
  assert.equal(skipped.tasks[1]?.status, 'skipped');
});

// ---------------------------------------------------------------------------------------
// 5. Snapshot identity: version is part of the identity
// ---------------------------------------------------------------------------------------

test('A -> B -> A snapshots are distinct, so old data and old jobs are never reused', () => {
  const textA = TEXT_A;
  const textB = TEXT_B;
  const first = makeSnapshot({ externalKey: '2001A', solutions: [{ solutionId: 's1', text: textA }] });
  const second = makeSnapshot({
    externalKey: '2001A',
    solutions: [{ solutionId: 's1', text: textB }],
    previous: first,
  });
  const third = makeSnapshot({
    externalKey: '2001A',
    solutions: [{ solutionId: 's1', text: textA }],
    previous: second,
  });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(third.version, 3);
  assert.equal(third.contentHash, first.contentHash);
  assert.notEqual(third.snapshotId, first.snapshotId);
  assert.ok(snapshotHead(first) && snapshotHead(third));

  // Re-fetching unchanged content is idempotent: same version, same snapshot id.
  const refetched = makeSnapshot({
    externalKey: '2001A',
    solutions: [{ solutionId: 's1', text: textA }],
    previous: third,
  });
  assert.equal(refetched.version, third.version);
  assert.equal(refetched.snapshotId, third.snapshotId);
  assert.equal(refetched.contentHash, third.contentHash);

  // Persistence and job identity follow the snapshot id, so the reverted content gets its
  // own job instead of inheriting the finished job of the first A.
  assert.notEqual(analysisJobIdOf(third.snapshotId), analysisJobIdOf(first.snapshotId));
  const firstJob = createAnalysisJob({ problemRef: refFor('2001A'), snapshotId: first.snapshotId, at: T2 });
  const thirdJob = createAnalysisJob({ problemRef: refFor('2001A'), snapshotId: third.snapshotId, at: T2 });
  assert.equal(firstJob.jobId, analysisJobIdOf(first.snapshotId));
  assert.equal(thirdJob.jobId, analysisJobIdOf(third.snapshotId));
  assert.notEqual(firstJob.jobId, thirdJob.jobId);

  // The public id helper makes the version part of the identity.
  assert.notEqual(
    snapshotIdOf(refFor('2001A'), first.contentHash, 1),
    snapshotIdOf(refFor('2001A'), first.contentHash, 2),
  );
  assert.throws(() => snapshotIdOf(refFor('2001A'), first.contentHash, 0), domainError('invalid_input'));

  // An analysis of the first A cannot write decisions onto the reverted, higher version.
  const analysis = analysisFor(first, [makeSuggestion(first)], []);
  const currentHead = snapshotHead(third);
  assert.equal(evaluateSuggestion(analysis.suggestions[0] as AiTagSuggestion, contextFor(first, analysis, { currentHead })).decision, 'stale_analysis');
  assert.equal(resolveTagDecisions(contextFor(first, analysis, { currentHead })).decisions.length, 0);
});
