/**
 * Pure provisional training statistics (Stage 07b).
 *
 * The reduction is driven directly, with no store, no clock and no model: every case pins an
 * externally meaningful rule — distinct-problem counting, AC-then-WA, metadata-missing and
 * blank/text/non-finite ratings as honest unknowns, one series per raw dimension, case-insensitive
 * label identity, the deterministic reference ordering and the renderable empty case.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DomainError,
  computeTrainingStatistics,
  createNormalizedProblem,
  expectedRatingDimension,
  type NormalizedProblem,
  type PlatformRating,
  type Submission,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const INSTANCE = fx.makeInstance('codeforces', 'codeforces.com');
const ACCOUNT = fx.makeAccount(INSTANCE, 'alice');
const SAMPLE = 5;

/** One raw platform rating entry, exactly as an adapter would normalise it. */
function rating(value: number | string, dimension = 'rating'): PlatformRating {
  return { dimension, value, scale: null, raw: String(value) };
}

/** A Codeforces problem with explicitly chosen ratings/tags (the fixtures always ship both). */
function problem(
  externalKey: string,
  options: { readonly ratings?: readonly PlatformRating[]; readonly rawTags?: readonly string[] } = {},
): NormalizedProblem {
  return createNormalizedProblem({
    ref: { sourceInstanceId: INSTANCE.id, domain: null, externalKey },
    title: `Problem ${externalKey}`,
    url: `https://codeforces.com/problem/${externalKey}`,
    statement: null,
    fetchedAt: fx.AT,
    ratings: options.ratings ?? [],
    rawTags: options.rawTags ?? [],
  });
}

function accepted(problem: NormalizedProblem, externalId = `s-${problem.ref.externalKey}`): Submission {
  return fx.makeSubmission(ACCOUNT, problem.ref, externalId, 'accepted');
}

function run(options: {
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  readonly expectedDimension?: string;
  readonly minimumSampleSize?: number;
}) {
  return computeTrainingStatistics({
    problems: options.problems,
    submissions: options.submissions,
    expectedDimension: options.expectedDimension ?? 'rating',
    minimumSampleSize: options.minimumSampleSize ?? SAMPLE,
  });
}

void test('one problem counts once per dimension and unknown always closes the sum', () => {
  const p1 = problem('P1', { ratings: [rating(1800)] });
  const p2 = problem('P2', { ratings: [rating(2400)] });
  const p3 = problem('P3');
  const ghost = fx.makeSubmission(
    ACCOUNT,
    { sourceInstanceId: INSTANCE.id, domain: null, externalKey: 'GHOST' },
    'g1',
    'accepted',
  );
  const stats = run({
    problems: [p1, p2, p3],
    submissions: [
      accepted(p1, 'a1'),
      accepted(p1, 'a2'),
      fx.makeSubmission(ACCOUNT, p1.ref, 'a3', 'wrong_answer'),
      accepted(p2, 'b1'),
      accepted(p3, 'c1'),
      ghost,
    ],
  });

  assert.equal(stats.solvedDistribution.totalSolved, 4, 'duplicate ACs collapse and AC-then-WA stays solved');
  assert.equal(stats.solvedDistribution.metadataMissingSolved, 1);
  assert.deepEqual(stats.solvedDistribution.dimensions, [
    { dimension: 'rating', buckets: [{ value: 1800, count: 1 }, { value: 2400, count: 1 }], knownCount: 2, unknownCount: 2 },
  ]);
  for (const dimension of stats.solvedDistribution.dimensions) {
    assert.equal(
      dimension.buckets.reduce((sum, bucket) => sum + bucket.count, 0) + dimension.unknownCount,
      stats.solvedDistribution.totalSolved,
    );
  }
  assert.equal(stats.platformTagStats.verified, false);
});

void test('blank, whitespace, text, non-finite and repeated values stay unknown, never zero', () => {
  const blank = problem('B', { ratings: [{ dimension: 'rating', value: '', scale: null, raw: '' }] });
  const spaces = problem('S', { ratings: [{ dimension: 'rating', value: '   ', scale: null, raw: '   ' }] });
  const text = problem('T', { ratings: [{ dimension: 'rating', value: 'unrated', scale: null, raw: 'unrated' }] });
  const nan = problem('N', { ratings: [{ dimension: 'rating', value: 'NaN', scale: null, raw: 'NaN' }] });
  const infinite = problem('I', { ratings: [{ dimension: 'rating', value: 'Infinity', scale: null, raw: 'Infinity' }] });
  const repeated = problem('R', {
    ratings: [{ dimension: 'rating', value: '', scale: null, raw: '' }, rating(1500)],
  });
  const padded = problem('P', { ratings: [{ dimension: 'rating', value: ' 1800 ', scale: null, raw: ' 1800 ' }] });
  const problems = [blank, spaces, text, nan, infinite, repeated, padded];
  const stats = run({ problems, submissions: problems.map((entry) => accepted(entry)) });

  const [dimension] = stats.solvedDistribution.dimensions;
  assert.ok(dimension, 'the expected dimension exists even for unusable values');
  assert.deepEqual(dimension.buckets, [{ value: 1800, count: 1 }], 'a padded numeric string is a usable value');
  assert.equal(dimension.knownCount, 1);
  assert.equal(dimension.unknownCount, 6, 'blank/text/non-finite and the first of a repeated dimension are unknown');
  assert.equal(stats.solvedDistribution.totalSolved, 7);
});

void test('the expected dimension always exists and other dimensions stay separate series', () => {
  const ratingSpelled = problem('A', { ratings: [{ dimension: 'Rating', value: 1800, scale: null, raw: '1800' }] });
  const difficultyLower = problem('B', { ratings: [rating(7, 'difficulty')] });
  const difficultyUpper = problem('C', { ratings: [{ dimension: 'Difficulty', value: '9', scale: null, raw: '9' }] });
  const problems = [ratingSpelled, difficultyLower, difficultyUpper];
  const submissions = problems.map((entry) => accepted(entry));

  const fromLuogu = run({ problems, submissions, expectedDimension: 'difficulty' });
  assert.deepEqual(
    fromLuogu.solvedDistribution.dimensions.map((entry) => entry.dimension),
    ['difficulty', 'Rating'],
    'the expected dimension leads, and a case-different spelling joins its own series instead of inventing one',
  );
  assert.deepEqual(fromLuogu.solvedDistribution.dimensions[0]?.buckets, [{ value: 7, count: 1 }, { value: 9, count: 1 }]);
  assert.deepEqual(fromLuogu.solvedDistribution.dimensions[1]?.buckets, [{ value: 1800, count: 1 }]);
  assert.equal(fromLuogu.solvedDistribution.dimensions[1]?.unknownCount, 2);

  const fromCodeforces = run({ problems, submissions, expectedDimension: 'rating' });
  assert.deepEqual(fromCodeforces.solvedDistribution.dimensions.map((entry) => entry.dimension), ['rating', 'difficulty']);
  assert.deepEqual(fromCodeforces.solvedDistribution.dimensions[0]?.buckets, [{ value: 1800, count: 1 }]);
  assert.equal(fromCodeforces.solvedDistribution.dimensions[0]?.unknownCount, 2);
});

void test('platform labels count distinct problems, dedupe case-insensitively and order deterministically', () => {
  const p1 = problem('P1', { rawTags: ['segment tree', 'greedy'] });
  const p2 = problem('P2', { rawTags: ['Segment Tree'] });
  const p3 = problem('P3', { rawTags: ['Segment Tree', 'dp'] });
  const p4 = problem('P4', { rawTags: ['segment tree'] });
  const p5 = problem('P5', { rawTags: ['dp'] });
  const p6 = problem('P6');
  const stats = run({
    problems: [p1, p2, p3, p4, p5, p6],
    submissions: [
      accepted(p1),
      fx.makeSubmission(ACCOUNT, p2.ref, 'b1', 'wrong_answer'),
      fx.makeSubmission(ACCOUNT, p3.ref, 'c1', 'wrong_answer'),
      fx.makeSubmission(ACCOUNT, p4.ref, 'd1', 'wrong_answer'),
      accepted(p5),
      fx.makeSubmission(ACCOUNT, p6.ref, 'f1', 'wrong_answer'),
    ],
  });

  assert.equal(stats.platformTagStats.attemptedTaggedDistinct, 5);
  assert.equal(stats.platformTagStats.solvedTaggedDistinct, 2);
  assert.equal(stats.platformTagStats.minimumSampleSize, SAMPLE);
  assert.deepEqual(stats.platformTagStats.tags, [
    { rawTag: 'segment tree', attemptedDistinct: 4, solvedDistinct: 1, unconfirmedDistinct: 3, solveRate: 0.25, sufficientEvidence: false },
    { rawTag: 'dp', attemptedDistinct: 2, solvedDistinct: 1, unconfirmedDistinct: 1, solveRate: 0.5, sufficientEvidence: false },
    { rawTag: 'greedy', attemptedDistinct: 1, solvedDistinct: 1, unconfirmedDistinct: 0, solveRate: 1, sufficientEvidence: false },
  ]);
  assert.equal(
    stats.platformTagStats.tags.reduce((sum, row) => sum + row.attemptedDistinct, 0),
    7,
    'labels overlap, so their samples deliberately do not sum to the attempted total of 6',
  );
});

void test('insufficient samples are listed explicitly and never silently dropped', () => {
  const problems = ['P1', 'P2', 'P3', 'P4', 'P5'].map((key) => problem(key, { rawTags: ['brute force'] }));
  const stats = run({
    problems,
    submissions: problems.map((entry, index) =>
      index === 0 ? accepted(entry) : fx.makeSubmission(ACCOUNT, entry.ref, `s-${index}`, 'wrong_answer'),
    ),
  });
  const [row] = stats.platformTagStats.tags;
  assert.ok(row);
  assert.equal(row.attemptedDistinct, SAMPLE);
  assert.equal(row.sufficientEvidence, true);
  assert.equal(row.solveRate, 0.2);
});

void test('empty evidence stays renderable and honest', () => {
  const stats = run({ problems: [], submissions: [] });
  assert.deepEqual(stats.solvedDistribution, {
    totalSolved: 0,
    metadataMissingSolved: 0,
    dimensions: [{ dimension: 'rating', buckets: [], knownCount: 0, unknownCount: 0 }],
  });
  assert.deepEqual(stats.platformTagStats, {
    verified: false,
    attemptedTaggedDistinct: 0,
    solvedTaggedDistinct: 0,
    minimumSampleSize: SAMPLE,
    tags: [],
  });
});

void test('the expected dimension is the platform default and the sample gate must be positive', () => {
  assert.equal(expectedRatingDimension('codeforces'), 'rating');
  assert.equal(expectedRatingDimension('luogu'), 'difficulty');
  assert.equal(expectedRatingDimension('manual'), 'difficulty');
  assert.equal(expectedRatingDimension('hydro'), 'difficulty');
  assert.throws(
    () => run({ problems: [], submissions: [], minimumSampleSize: 0 }),
    (error: unknown) => error instanceof DomainError && error.code === 'unfilled_settings',
  );
});

void test('several dimensions stay exact in one pass and a repeated dimension keeps its first entry', () => {
  // The same problem carries a blank `rating` before a numeric `Rating`, a numeric `difficulty`
  // before a second one, and a numeric `manual-note` before a blank one: the first entry of each
  // dimension decides, so one series is unknown and the other is not.
  const multi = problem('M', {
    ratings: [
      { dimension: 'rating', value: '', scale: null, raw: '' },
      { dimension: 'Rating', value: 1500, scale: null, raw: '1500' },
      { dimension: 'difficulty', value: 7, scale: null, raw: '7' },
      { dimension: 'difficulty', value: 9, scale: null, raw: '9' },
      { dimension: 'manual-note', value: '1200', scale: null, raw: '1200' },
      { dimension: 'manual-note', value: '', scale: null, raw: '' },
    ],
  });
  const other = problem('N', { ratings: [rating(1500), rating(7, 'difficulty')] });
  // An attempted but unsolved problem still contributes its observed dimension, as all-unknown.
  const unsolved = problem('O', { ratings: [rating(2100, 'editorial-rating')] });
  const stats = run({
    problems: [multi, other, unsolved],
    submissions: [
      accepted(multi, 'm1'),
      accepted(multi, 'm2'),
      accepted(other, 'n1'),
      fx.makeSubmission(ACCOUNT, unsolved.ref, 'o1', 'wrong_answer'),
    ],
  });

  assert.equal(stats.solvedDistribution.totalSolved, 2, 'duplicate ACs still collapse across dimensions');
  assert.equal(stats.solvedDistribution.metadataMissingSolved, 0);
  assert.deepEqual(
    stats.solvedDistribution.dimensions,
    [
      { dimension: 'rating', buckets: [{ value: 1500, count: 1 }], knownCount: 1, unknownCount: 1 },
      { dimension: 'difficulty', buckets: [{ value: 7, count: 2 }], knownCount: 2, unknownCount: 0 },
      { dimension: 'editorial-rating', buckets: [], knownCount: 0, unknownCount: 2 },
      { dimension: 'manual-note', buckets: [{ value: 1200, count: 1 }], knownCount: 1, unknownCount: 1 },
    ],
    'every observed dimension keeps its own buckets, and blank/non-numeric first entries are unknown',
  );
  for (const dimension of stats.solvedDistribution.dimensions) {
    assert.equal(
      dimension.buckets.reduce((sum, bucket) => sum + bucket.count, 0) + dimension.unknownCount,
      stats.solvedDistribution.totalSolved,
    );
  }
});

void test('raw-label ties break by code point, never by the machine locale', () => {
  // Both rows tie on unconfirmed count, solve rate and sample size, so only the final tie break
  // decides: code points put `B` (0x42) before `a` (0x61), while a locale collation orders `a`
  // first. The reference order must not depend on the machine running the aggregation.
  const lower = problem('T1', { rawTags: ['a'] });
  const upper = problem('T2', { rawTags: ['B'] });
  const stats = run({
    problems: [lower, upper],
    submissions: [accepted(lower, 't1'), accepted(upper, 't2')],
  });

  assert.deepEqual(
    stats.platformTagStats.tags.map((row) => ({ rawTag: row.rawTag, attemptedDistinct: row.attemptedDistinct })),
    [
      { rawTag: 'B', attemptedDistinct: 1 },
      { rawTag: 'a', attemptedDistinct: 1 },
    ],
  );
});
