/**
 * Ability assessment domain rules (Sprint 11a).
 *
 * Pure reduction cases over `computeAbilityAssessment`: distinct-problem counting, first-AC
 * recency, future exclusion, account/source isolation, the five-sample gate, missing/blank ratings,
 * latest-retrospective downgrades, the three sample tiers with their caveats, no cross-platform
 * conversion, extreme-outlier robustness and the identifier-free planning aggregate. Nothing here
 * touches a store, a clock, a network or a model.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ABILITY_ASSESSMENT_VERSION,
  ABILITY_MIN_ESTIMATE_SAMPLES,
  ABILITY_REASON_TEXT,
  CF_OFFICIAL_RATING_API_HELP_URL,
  CF_TRAINING_BAND_HEURISTIC_VERSION,
  CF_TRAINING_POOL_FLOOR,
  DomainError,
  aggregateAbilityForPlanning,
  computeAbilityAssessment,
  createNormalizedProblem,
  createRetrospective,
  createSubmission,
  isDeeplyFrozen,
  type AbilityAssessment,
  type CompletionMode,
  type ComputeAbilityAssessmentInput,
  type NormalizedProblem,
  type PlatformRating,
  type Retrospective,
  type Submission,
  type SubmissionVerdict,
} from '../../src/domain/index.js';

const NOW = '2026-11-01T08:00:00.000Z';
/** 31 days before `NOW`: inside the default 90-day window. */
const RECENT = '2026-10-01T08:00:00.000Z';
const OLD = '2025-06-01T08:00:00.000Z';
const FUTURE = '2026-12-01T08:00:00.000Z';
const CF_SOURCE = 'codeforces:codeforces.com';
const ALICE = 'account:alice';
const BOB = 'account:bob';

function rating(value: number | string, dimension = 'rating'): PlatformRating {
  return { dimension, value, scale: null, raw: String(value) };
}

function problem(
  externalKey: string,
  options: { readonly ratings?: readonly PlatformRating[]; readonly sourceInstanceId?: string } = {},
): NormalizedProblem {
  return createNormalizedProblem({
    ref: { sourceInstanceId: options.sourceInstanceId ?? CF_SOURCE, domain: null, externalKey },
    title: `Problem ${externalKey}`,
    url: `https://codeforces.com/problemset/problem/${externalKey}`,
    statement: null,
    fetchedAt: NOW,
    ratings: options.ratings ?? [rating(1600)],
  });
}

function submission(
  accountId: string,
  target: NormalizedProblem,
  externalId: string,
  verdict: SubmissionVerdict,
  submittedAt: string,
): Submission {
  return createSubmission({ accountId, ref: target.ref, externalId, verdict, submittedAt });
}

function retrospective(
  accountId: string,
  target: NormalizedProblem,
  mode: CompletionMode,
  recordedAt: string,
): Retrospective {
  return createRetrospective({ problemRef: target.ref, accountId, mode, recordedAt });
}

function assess(overrides: Partial<ComputeAbilityAssessmentInput> = {}): AbilityAssessment {
  return computeAbilityAssessment({
    accountId: ALICE,
    sourceInstanceId: CF_SOURCE,
    platform: 'codeforces',
    problems: [],
    submissions: [],
    retrospectives: [],
    now: NOW,
    ...overrides,
  });
}

interface Cohort {
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  readonly retrospectives: readonly Retrospective[];
}

/** Distinct rated problems solved at `solvedAt`, each with an independent retrospective. */
function cohort(
  ratings: readonly number[],
  options: { readonly solvedAt?: string; readonly withRetrospective?: boolean; readonly accountId?: string } = {},
): Cohort {
  const accountId = options.accountId ?? ALICE;
  const solvedAt = options.solvedAt ?? RECENT;
  const problems = ratings.map((value, index) => problem(`P${index + 1}`, { ratings: [rating(value)] }));
  const submissions = problems.map((entry, index) =>
    submission(accountId, entry, `S${index + 1}`, 'accepted', solvedAt),
  );
  const retrospectives =
    options.withRetrospective === false
      ? []
      : problems.map((entry) => retrospective(accountId, entry, 'independent', solvedAt));
  return { problems, submissions, retrospectives };
}

void test('first AC defines a new solve and a repeated AC never refreshes it', () => {
  const old = problem('P1', { ratings: [rating(1500)] });
  const fresh = problem('P2', { ratings: [rating(1700)] });
  const report = assess({
    problems: [old, fresh],
    submissions: [
      submission(ALICE, old, 'A1', 'accepted', OLD),
      // The same problem accepted again inside the window: a repeated AC of an old solve.
      submission(ALICE, old, 'A2', 'accepted', RECENT),
      submission(ALICE, old, 'A3', 'wrong_answer', RECENT),
      submission(ALICE, fresh, 'B1', 'accepted', RECENT),
    ],
  });

  assert.equal(report.version, ABILITY_ASSESSMENT_VERSION);
  assert.equal(report.counts.attemptedDistinct, 2);
  assert.equal(report.counts.solvedDistinct, 2);
  assert.equal(report.counts.unsolvedDistinct, 0);
  assert.equal(report.last90Days.attemptedDistinct, 2);
  assert.equal(report.last90Days.newSolvedDistinct, 1, 'only the first-solved problem is new');
  assert.equal(report.last90Days.repeatedAcDistinct, 1);
  assert.equal(isDeeplyFrozen(report), true);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

void test('submissions after the explicit now are excluded, never clamped', () => {
  const entry = problem('P1', { ratings: [rating(1500)] });
  const report = assess({
    problems: [entry],
    submissions: [
      submission(ALICE, entry, 'A1', 'wrong_answer', RECENT),
      submission(ALICE, entry, 'A2', 'accepted', FUTURE),
    ],
  });

  assert.equal(report.counts.attemptedDistinct, 1);
  assert.equal(report.counts.solvedDistinct, 0, 'a future AC is not evidence yet');
  assert.equal(report.coverage.futureSubmissionsExcluded, 1);
  assert.equal(report.last90Days.newSolvedDistinct, 0);
  assert.equal(report.estimate.status, 'unknown');
});

void test('empty and below-gate evidence is unknown, never zero or newbie', () => {
  const empty = assess({});
  assert.equal(empty.estimate.status, 'unknown');
  assert.equal(empty.estimate.baselineTrainingLevel, null);
  assert.equal(empty.estimate.confidence, null);
  assert.equal(empty.estimate.basis, null);
  assert.ok(empty.reasonCodes.includes('no_data'));
  assert.equal(empty.reasons.includes(ABILITY_REASON_TEXT.no_data), true);
  assert.equal(empty.officialRating.status, 'not_loaded');
  assert.equal(empty.officialRating.apiHelpUrl, CF_OFFICIAL_RATING_API_HELP_URL);
  assert.equal(empty.coverage.nativeDimension, 'rating');

  const few = cohort([1200, 1300, 1400, 1500]);
  const report = assess({
    problems: few.problems,
    submissions: few.submissions,
    retrospectives: few.retrospectives,
  });
  assert.equal(report.estimate.status, 'unknown');
  assert.equal(report.estimate.sampleSize, 4);
  assert.equal(report.estimate.minimumSampleSize, ABILITY_MIN_ESTIMATE_SAMPLES);
  assert.equal(report.estimate.baselineTrainingLevel, null);
  assert.ok(report.reasonCodes.includes('insufficient_samples'));
  assert.equal(report.reasons.includes(ABILITY_REASON_TEXT.insufficient_samples), true);
});

void test('five recent independent samples produce the versioned CF training band', () => {
  const samples = cohort([1200, 1400, 1600, 1800, 2000]);
  const report = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: samples.retrospectives,
  });
  const estimate = report.estimate;

  assert.equal(estimate.status, 'estimated');
  assert.equal(estimate.heuristicVersion, CF_TRAINING_BAND_HEURISTIC_VERSION);
  assert.equal(estimate.basis, 'recent_independent');
  assert.equal(estimate.confidence, 'medium', 'the heuristic itself is never high confidence');
  assert.equal(estimate.provisional, false);
  assert.equal(estimate.stale, false);
  assert.equal(estimate.sampleSize, 5);
  assert.equal(estimate.medianRating, 1600);
  assert.equal(estimate.baselineTrainingLevel, 1600, 'median rounded to 100');
  assert.deepEqual(estimate.quartileBand, { min: 1400, max: 1800 });
  assert.deepEqual(estimate.baselinePool, { min: 1500, max: 1700 });
  assert.deepEqual(estimate.stretchPool, { min: 1700, max: 1900 });
  assert.ok(report.reasonCodes.includes('heuristic_unvalidated'));
  assert.ok(report.reasonCodes.includes('selection_bias_practice_vs_contest'));
  assert.ok(report.reasonCodes.includes('official_rating_not_loaded'));
  assert.equal(report.completionModes.allTime.independent, 5);
  assert.equal(report.completionModes.allTime.unknown, 0);
  assert.equal(report.coverage.recentIndependentDistinct, 5);
  assert.equal(report.coverage.allTimeEligibleDistinct, 5);
});

void test('recent independent samples take priority over a larger historical pool', () => {
  const recent = cohort([1300, 1500, 1700, 1900, 2100]);
  const historicalRatings = [2400, 2500, 2600, 2700, 2800, 2900];
  const historicalProblems = historicalRatings.map((value, index) =>
    problem(`H${index + 1}`, { ratings: [rating(value)] }),
  );
  const historicalSubmissions = historicalProblems.map((entry, index) =>
    submission(ALICE, entry, `H${index + 1}`, 'accepted', OLD),
  );
  const report = assess({
    problems: [...recent.problems, ...historicalProblems],
    submissions: [...recent.submissions, ...historicalSubmissions],
    retrospectives: recent.retrospectives,
  });

  assert.equal(report.estimate.basis, 'recent_independent');
  assert.equal(report.estimate.sampleSize, 5, 'the historical six are not mixed into the recent pool');
  assert.equal(report.estimate.baselineTrainingLevel, 1700);
  assert.equal(report.coverage.allTimeEligibleDistinct, 11);
  assert.equal(report.coverage.recentEligibleDistinct, 5);
  assert.equal(report.completionModes.allTime.unknown, 6);
});

void test('assisted and solution-used problems are excluded, and the latest retrospective wins', () => {
  const samples = cohort([1300, 1400, 1500, 1600, 1700]);
  const initial = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: samples.retrospectives,
  });
  assert.equal(initial.estimate.status, 'estimated');
  assert.equal(initial.excludedFromEstimate.total, 0);

  const downgraded = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: [
      ...samples.retrospectives,
      retrospective(ALICE, samples.problems[4] as NormalizedProblem, 'solution_used', '2026-10-05T08:00:00.000Z'),
    ],
  });
  assert.equal(downgraded.completionModes.allTime.solutionUsed, 1, 'the latest retrospective replaces the earlier one');
  assert.equal(downgraded.completionModes.allTime.independent, 4);
  assert.equal(downgraded.excludedFromEstimate.solutionUsedDistinct, 1);
  assert.equal(downgraded.estimate.status, 'unknown', 'four eligible samples stay below the gate');
  assert.equal(downgraded.estimate.baselineTrainingLevel, null);
  assert.ok(downgraded.reasonCodes.includes('assisted_excluded'));

  const assisted = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: [
      ...samples.retrospectives.slice(0, 4),
      retrospective(ALICE, samples.problems[4] as NormalizedProblem, 'assisted', '2026-10-05T08:00:00.000Z'),
    ],
  });
  assert.equal(assisted.counts.solvedDistinct, 5, 'the assisted solve is still solved evidence');
  assert.equal(assisted.excludedFromEstimate.assistedDistinct, 1);
  assert.equal(assisted.estimate.status, 'unknown');
});

void test('unknown independence gives a provisional low-confidence recent estimate', () => {
  const samples = cohort([1200, 1400, 1600, 1800, 2000], { withRetrospective: false });
  const report = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: [],
  });

  assert.equal(report.estimate.status, 'estimated');
  assert.equal(report.estimate.basis, 'recent_observed');
  assert.equal(report.estimate.confidence, 'low');
  assert.equal(report.estimate.provisional, true, 'observed AC with unknown independence is provisional');
  assert.equal(report.estimate.stale, false);
  assert.ok(report.reasonCodes.includes('unknown_independent_status'));
  assert.equal(report.completionModes.allTime.unknown, 5);
  assert.equal(report.coverage.solvedWithoutRetrospective, 5);

  // Two independently confirmed samples never outrank five recent observed ACs.
  const mixed = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: samples.problems
      .slice(0, 2)
      .map((entry) => retrospective(ALICE, entry, 'independent', RECENT)),
  });
  assert.equal(mixed.estimate.basis, 'recent_observed');
  assert.equal(mixed.estimate.sampleSize, 5);
});

void test('an old pool is used only with the explicit stale caveat', () => {
  const samples = cohort([1400, 1600, 1800, 2000, 2200], { solvedAt: OLD, withRetrospective: false });
  const report = assess({ problems: samples.problems, submissions: samples.submissions });

  assert.equal(report.estimate.status, 'estimated');
  assert.equal(report.estimate.basis, 'historical');
  assert.equal(report.estimate.stale, true);
  assert.equal(report.estimate.provisional, true);
  assert.equal(report.estimate.confidence, 'low');
  assert.equal(report.estimate.baselineTrainingLevel, 1800);
  assert.ok(report.reasonCodes.includes('stale_data'));
  assert.ok(report.reasonCodes.includes('unknown_independent_status'));
  assert.equal(report.coverage.recentEligibleDistinct, 0);
  assert.equal(report.last90Days.newSolvedDistinct, 0);
});

void test('missing, blank and text ratings stay missing; non-CF platforms never convert', () => {
  const blank = problem('P1', { ratings: [rating('', 'rating')] });
  const text = problem('P2', { ratings: [rating('unrated', 'rating')] });
  const good = [0, 1, 2, 3, 4].map((index) => problem(`G${index + 1}`, { ratings: [rating(1200 + index * 100)] }));
  const all = [blank, text, ...good];
  const report = assess({
    problems: all,
    submissions: all.map((entry, index) => submission(ALICE, entry, `S${index}`, 'accepted', RECENT)),
    retrospectives: all.map((entry) => retrospective(ALICE, entry, 'independent', RECENT)),
  });

  assert.equal(report.counts.solvedDistinct, 7);
  assert.equal(report.coverage.solvedWithNativeValue, 5);
  assert.equal(report.coverage.solvedWithoutNativeValue, 2);
  assert.equal(report.nativeDifficulty[0]?.dimension, 'rating');
  assert.equal(report.nativeDifficulty[0]?.count, 5);
  assert.equal(report.nativeDifficulty[0]?.missing, 2);
  assert.equal(report.estimate.basis, 'recent_independent');
  assert.equal(report.estimate.sampleSize, 5, 'blank and text values are not coerced to 0');
  assert.ok(report.reasonCodes.includes('missing_rating_values'));

  const luoguSource = 'luogu:www.luogu.com.cn';
  const luoguProblems = [0, 1, 2, 3, 4].map((index) =>
    problem(`L${index + 1}`, { ratings: [rating(index + 2, 'difficulty')], sourceInstanceId: luoguSource }),
  );
  const luogu = assess({
    sourceInstanceId: luoguSource,
    platform: 'luogu',
    problems: luoguProblems,
    submissions: luoguProblems.map((entry, index) => submission(ALICE, entry, `L${index}`, 'accepted', RECENT)),
    retrospectives: luoguProblems.map((entry) => retrospective(ALICE, entry, 'independent', RECENT)),
  });
  assert.equal(luogu.estimate.status, 'unknown');
  assert.equal(luogu.estimate.baselineTrainingLevel, null);
  assert.ok(luogu.reasonCodes.includes('non_cf_native_scale_only'));
  assert.equal(luogu.coverage.nativeDimension, 'difficulty');
  assert.equal(luogu.nativeDifficulty[0]?.dimension, 'difficulty');
  assert.equal(
    luogu.nativeDifficulty.some((row) => row.dimension === 'rating'),
    false,
    'a CF rating scale is never invented for another platform',
  );
});

void test('another account is isolated and a foreign source instance is refused', () => {
  const alice = cohort([1200, 1300, 1400]);
  const bobProblems = [0, 1, 2, 3, 4].map((index) =>
    problem(`B${index + 1}`, { ratings: [rating(2400 + index * 100)] }),
  );
  const bobSubmissions = bobProblems.map((entry, index) =>
    submission(BOB, entry, `B${index + 1}`, 'accepted', RECENT),
  );
  const report = assess({
    problems: [...alice.problems, ...bobProblems],
    submissions: [...alice.submissions, ...bobSubmissions],
    retrospectives: alice.retrospectives,
  });

  assert.equal(report.counts.attemptedDistinct, 3, "bob's history never describes alice");
  assert.equal(report.counts.solvedDistinct, 3);
  assert.equal(report.coverage.foreignSubmissionsExcluded, 5);
  assert.equal(report.estimate.status, 'unknown');

  const foreign = problem('X1', { sourceInstanceId: 'luogu:www.luogu.com.cn' });
  assert.throws(
    () =>
      assess({
        problems: [foreign],
        submissions: [submission(ALICE, foreign, 'X1', 'accepted', RECENT)],
      }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === 'invalid_input' &&
      error.details['reason'] === 'ability_source_mismatch',
  );
});

void test('quantiles resist extreme outliers and suggested pools are never capped', () => {
  const samples = cohort([1200, 1300, 1400, 1500, 100000]);
  const report = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: samples.retrospectives,
  });

  assert.equal(report.estimate.baselineTrainingLevel, 1400, 'the median ignores the outlier');
  assert.deepEqual(report.estimate.quartileBand, { min: 1300, max: 1500 });
  assert.deepEqual(report.estimate.baselinePool, { min: 1300, max: 1500 });
  assert.deepEqual(report.estimate.stretchPool, { min: 1500, max: 1700 });
  assert.equal(
    report.nativeDifficulty[0]?.max,
    100000,
    'the descriptive distribution still reports the raw outlier honestly',
  );

  const top = cohort([3400, 3400, 3400, 3400, 3400]);
  const high = assess({
    problems: top.problems,
    submissions: top.submissions,
    retrospectives: top.retrospectives,
  });
  assert.equal(high.estimate.baselineTrainingLevel, 3400);
  assert.deepEqual(high.estimate.stretchPool, { min: 3500, max: 3700 }, 'the old 3500 cap is gone');
  assert.deepEqual(high.estimate.baselinePool, { min: 3300, max: 3500 });
});

void test('CF problem ratings above 3500 are preserved instead of clamped', () => {
  const samples = cohort([4000, 4000, 4000, 4000, 4000]);
  const report = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: samples.retrospectives,
  });

  assert.equal(report.estimate.status, 'estimated');
  assert.equal(report.estimate.medianRating, 4000);
  assert.equal(report.estimate.baselineTrainingLevel, 4000, 'a valid high rating is not pulled down to 3500');
  assert.deepEqual(report.estimate.quartileBand, { min: 4000, max: 4000 });
  assert.deepEqual(report.estimate.baselinePool, { min: 3900, max: 4100 });
  assert.deepEqual(report.estimate.stretchPool, { min: 4100, max: 4300 });
  assert.equal(report.nativeDifficulty[0]?.max, 4000);
  assert.equal(report.coverage.allTimeEligibleDistinct, 5);
});

void test('zero, negative and fractional CF ratings never satisfy the sample gate', () => {
  const build = (ratings: readonly (number | string)[]): AbilityAssessment => {
    const problems = ratings.map((value, index) => problem(`R${index + 1}`, { ratings: [rating(value)] }));
    return assess({
      problems,
      submissions: problems.map((entry, index) => submission(ALICE, entry, `R${index + 1}`, 'accepted', RECENT)),
      retrospectives: problems.map((entry) => retrospective(ALICE, entry, 'independent', RECENT)),
    });
  };
  const valid = [1300, 1400, 1500, 1600];

  const gated = build([...valid, 0]);
  assert.equal(gated.counts.solvedDistinct, 5);
  assert.equal(gated.coverage.allTimeEligibleDistinct, 4, 'the raw 0 is not estimate evidence');
  assert.equal(gated.estimate.status, 'unknown', 'an invalid fifth value cannot reach the gate');
  assert.equal(gated.estimate.sampleSize, 4);
  assert.equal(gated.estimate.baselineTrainingLevel, null);
  assert.deepEqual(
    gated.nativeDifficulty[0]?.buckets.map((bucket) => bucket.value),
    [0, 1300, 1400, 1500, 1600],
    'the descriptive distribution still reports every raw observed value',
  );

  assert.equal(build([...valid, -1200]).estimate.status, 'unknown', 'a negative rating is invalid');
  assert.equal(build([...valid, 1200.5]).estimate.status, 'unknown', 'a fractional rating is invalid');

  const five = build([...valid, 1700]);
  assert.equal(five.estimate.status, 'estimated');
  assert.equal(five.estimate.sampleSize, 5);
  assert.equal(five.estimate.baselineTrainingLevel, 1500);
});

void test('the training floor shapes suggested pools but never rewrites observed statistics', () => {
  const samples = cohort([400, 500, 600, 700, 800]);
  const report = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: samples.retrospectives,
  });

  assert.equal(report.estimate.medianRating, 600);
  assert.equal(report.estimate.baselineTrainingLevel, 600, 'an observed baseline below the floor is preserved');
  assert.deepEqual(report.estimate.quartileBand, { min: 500, max: 700 }, 'observed P25–P75 is preserved');
  assert.deepEqual(
    report.estimate.baselinePool,
    { min: CF_TRAINING_POOL_FLOOR, max: CF_TRAINING_POOL_FLOOR },
    'a suggested pool below the floor collapses onto the chosen training floor',
  );
  assert.deepEqual(report.estimate.stretchPool, { min: CF_TRAINING_POOL_FLOOR, max: 900 });
});

void test('native difficulty reports quantiles, buckets and missing coverage per dimension', () => {
  const samples = cohort([1200, 1200, 1500]);
  const extra = problem('E1', { ratings: [rating(3, 'difficulty'), rating(1800, 'rating')] });
  const report = assess({
    problems: [...samples.problems, extra],
    submissions: [...samples.submissions, submission(ALICE, extra, 'E1', 'accepted', RECENT)],
    retrospectives: samples.retrospectives,
  });

  const native = report.nativeDifficulty;
  assert.deepEqual(
    native.map((row) => row.dimension),
    ['rating', 'difficulty'],
    'the expected dimension leads, other raw dimensions follow',
  );
  const ratingRow = native[0];
  assert.ok(ratingRow);
  assert.equal(ratingRow.count, 4);
  assert.equal(ratingRow.missing, 0);
  assert.deepEqual(ratingRow.buckets, [
    { value: 1200, count: 2 },
    { value: 1500, count: 1 },
    { value: 1800, count: 1 },
  ]);
  assert.equal(ratingRow.median, 1350);
  assert.equal(ratingRow.sufficientSamples, false, 'only four numeric samples here');
  const difficultyRow = native[1];
  assert.ok(difficultyRow);
  assert.equal(difficultyRow.count, 1);
  assert.equal(difficultyRow.missing, 3);
});

void test('the planning aggregate carries no account, handle or row identifiers', () => {
  const samples = cohort([1200, 1400, 1600, 1800, 2000]);
  const report = assess({
    problems: samples.problems,
    submissions: samples.submissions,
    retrospectives: samples.retrospectives,
  });
  const aggregate = aggregateAbilityForPlanning(report);

  assert.equal(aggregate.estimateStatus, 'estimated');
  assert.equal(aggregate.baselineTrainingLevel, 1600);
  assert.equal(aggregate.platform, 'codeforces');
  assert.ok(aggregate.caveats.length > 0);
  const serialized = JSON.stringify(aggregate);
  assert.equal(serialized.includes(ALICE), false, 'no account id');
  assert.equal(serialized.includes(CF_SOURCE), false, 'no source instance id');
  assert.equal(serialized.includes('P1'), false, 'no problem key or external key');
  assert.equal(serialized.includes('S1'), false, 'no submission id');
  assert.equal(isDeeplyFrozen(aggregate), true);
  assert.deepEqual(JSON.parse(serialized), aggregate);
});
