/**
 * Provisional training statistics (Stage 07b).
 *
 * Pure aggregation over the evidence one weakness read already collected. Two deliberately
 * different statements live here, and neither of them is mastery:
 *
 * - {@link SolvedDistribution} describes every distinct accepted problem by **one raw platform
 *   dimension at a time**. Codeforces `rating`, Luogu `difficulty` and a manual `difficulty` stay
 *   separate series — no cross-platform scale is invented — and a problem whose dimension is
 *   absent, blank, non-numeric or non-finite counts as `unknown` instead of being coerced to `0`.
 * - {@link PlatformTagStatistics} counts **raw platform labels** per distinct attempted problem.
 *   Those labels are unverified platform claims, never accepted taxonomy tags: they are reported
 *   next to the formal weakness report and never enter it (and never steer a plan).
 *
 * Every count is per distinct problem: duplicate submissions collapse, an accepted submission
 * followed by a wrong answer stays solved, one problem contributes at most once per dimension and
 * at most once per label, and labels are compared case-insensitively while their original spelling
 * is preserved. Dimensions whose sums overlap are reported as separate series on purpose: the
 * labels of one problem may carry several directions, so tag counts are not a partition and do not
 * sum to the attempted total.
 *
 * Bucket counting reads each solved problem's rating array once, whatever number of raw dimensions
 * the import carries, and a repeated dimension is decided by its first entry; the cost therefore
 * stays linear in the evidence instead of rescanning every solved problem per observed dimension.
 * Every ordering here is code-point order (never `localeCompare`), so the same evidence orders
 * identically on every machine and locale.
 */
import { invariant, requireFiniteInt } from './errors.js';
import type { SourcePlatform } from './ids.js';
import { deepFreeze } from './immutable.js';
import type { NormalizedProblem, PlatformRating } from './problem.js';
import { numericText } from './sorting.js';
import { isAccepted, type Submission } from './submission.js';

/** One numeric value of one raw dimension and how many distinct solved problems carry it. */
export interface SolvedBucket {
  readonly value: number;
  readonly count: number;
}

/**
 * One raw platform dimension of the solved distribution.
 *
 * `knownCount` counts solved problems with a usable numeric value; `unknownCount` counts the rest
 * (missing local metadata, absent dimension, blank/text/non-finite value). Their sum is always the
 * number of distinct solved problems, so an all-unknown series stays renderable instead of empty.
 */
export interface SolvedDimensionDistribution {
  /** Original platform dimension name, exactly as the platform reports it. */
  readonly dimension: string;
  /** Numeric buckets sorted ascending by value; `sum(count)` equals `knownCount`. */
  readonly buckets: readonly SolvedBucket[];
  readonly knownCount: number;
  readonly unknownCount: number;
}

/** Difficulty distribution of every distinct accepted problem, one series per raw dimension. */
export interface SolvedDistribution {
  readonly totalSolved: number;
  /** Solved problems whose local metadata row is absent; they can carry no rating at all. */
  readonly metadataMissingSolved: number;
  /** At least the dimension the source is expected to report, even when it has no usable value. */
  readonly dimensions: readonly SolvedDimensionDistribution[];
}

/** One raw platform label with its distinct-problem sample. */
export interface PlatformTagStatRow {
  readonly rawTag: string;
  readonly attemptedDistinct: number;
  readonly solvedDistinct: number;
  readonly unconfirmedDistinct: number;
  /** solvedDistinct / attemptedDistinct, in [0, 1]. */
  readonly solveRate: number;
  /** True from `minimumSampleSize` distinct attempts; never an inference of weakness. */
  readonly sufficientEvidence: boolean;
}

/** Descriptive reference over raw platform labels; explicitly not verified weakness evidence. */
export interface PlatformTagStatistics {
  /** Always `false`: a raw platform label is a platform claim, not an accepted tag. */
  readonly verified: false;
  /** Distinct attempted problems carrying at least one raw label. */
  readonly attemptedTaggedDistinct: number;
  /** Distinct solved problems carrying at least one raw label. */
  readonly solvedTaggedDistinct: number;
  readonly minimumSampleSize: number;
  readonly tags: readonly PlatformTagStatRow[];
}

export interface TrainingStatistics {
  readonly solvedDistribution: SolvedDistribution;
  readonly platformTagStats: PlatformTagStatistics;
}

export interface ComputeTrainingStatisticsInput {
  /** Metadata rows of the attempted problems; a metadata-missing problem is simply absent. */
  readonly problems: readonly NormalizedProblem[];
  /** Every submission row of ONE account; the aggregation itself is account-agnostic. */
  readonly submissions: readonly Submission[];
  /** Raw dimension the source reports for numeric difficulty; always part of the output. */
  readonly expectedDimension: string;
  readonly minimumSampleSize: number;
}

/**
 * Raw dimension of a platform's own difficulty scale.
 *
 * Codeforces publishes `rating`; Luogu and a manual source publish `difficulty`. The mapping is a
 * display default for "which series must exist", never a conversion between the two scales.
 */
export function expectedRatingDimension(platform: SourcePlatform): string {
  return platform === 'codeforces' ? 'rating' : 'difficulty';
}

/** Case-insensitive identity of one raw dimension label. */
function dimensionKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Usable numeric value of one raw rating entry, or `null` when it is blank/text/non-finite.
 *
 * The strict numeric-text rule is the domain's single implementation (`domain/sorting.ts`), so this
 * module cannot drift from the bank's difficulty ordering. `Number('')` and `Number('   ')` are
 * `0`, so a blank value stays `unknown` instead of becoming a fabricated zero.
 */
function numericRatingValue(value: PlatformRating['value']): number | null {
  return typeof value === 'number' ? (Number.isFinite(value) ? value : null) : numericText(value);
}

/** Locale-independent UTF-16 text order of two raw labels; `0` only for equal text. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Output order: the source's expected dimension first, then every other observed dimension. */
function collectDimensionLabels(
  problems: readonly NormalizedProblem[],
  expectedDimension: string,
): readonly { readonly key: string; readonly label: string }[] {
  const expectedKey = dimensionKey(expectedDimension);
  const labels = new Map<string, string>();
  // Canonical-key order, so the retained spelling of a case collision never depends on the order
  // the caller happened to pass its problems in.
  for (const problem of [...problems].sort((left, right) => compareText(left.key, right.key))) {
    for (const rating of problem.ratings) {
      const label = rating.dimension.trim();
      const key = dimensionKey(label);
      if (key.length === 0 || key === expectedKey || labels.has(key)) {
        continue;
      }
      labels.set(key, label);
    }
  }
  const ordered = [...labels.entries()].sort(([left], [right]) => compareText(left, right));
  return [
    { key: expectedKey, label: expectedDimension },
    ...ordered.map(([key, label]) => ({ key, label })),
  ];
}

/**
 * Aggregate the provisional statistics of one weakness read.
 *
 * Every input is already bounded and coherent (the application layer refused incoherent rows), and
 * nothing here reads a clock, a store or a model: the reduction is pure, deterministic and
 * idempotent, so the same evidence always produces the same numbers. Solved-problem buckets are
 * accumulated in one pass over the solved problems' rating arrays, so a manual import that reports
 * several raw dimensions stays linear in the evidence instead of rescanning every solved problem
 * once per dimension.
 */
export function computeTrainingStatistics(input: ComputeTrainingStatisticsInput): TrainingStatistics {
  const minimumSampleSize = requireFiniteInt(input.minimumSampleSize, 'minimumSampleSize', 1);
  const expectedDimension = input.expectedDimension.trim();
  invariant(
    expectedDimension.length > 0,
    'invalid_input',
    'expectedDimension must be a non-blank platform dimension label',
    { expectedDimension: input.expectedDimension },
  );

  const problemByKey = new Map(input.problems.map((problem) => [problem.key, problem]));
  const attempted = new Set<string>();
  const solved = new Set<string>();
  for (const submission of input.submissions) {
    attempted.add(submission.key);
    if (isAccepted(submission)) {
      solved.add(submission.key);
    }
  }

  // One accumulator per output dimension, kept in output order; `labels` already resolved the
  // expected dimension first and deduplicated the observed labels case-insensitively.
  const labels = collectDimensionLabels(input.problems, expectedDimension);
  const accumulators = new Map<string, { label: string; counts: Map<number, number>; knownCount: number }>(
    labels.map(({ key, label }) => [key, { label, counts: new Map<number, number>(), knownCount: 0 }]),
  );

  let metadataMissingSolved = 0;
  // One pass over the solved problems: each rating array is read once no matter how many raw
  // dimensions the import carries, and `seen` keeps a repeated dimension's first entry in charge,
  // exactly as a later duplicate must not turn an honest unknown into a number the platform never
  // reported for this series.
  for (const problemKey of solved) {
    const problem = problemByKey.get(problemKey);
    if (problem === undefined) {
      // Missing local metadata is unknown, never skipped: the series must still account for every
      // solved problem, otherwise `knownCount + unknownCount` would silently shrink the sample.
      metadataMissingSolved += 1;
      continue;
    }
    const seen = new Set<string>();
    for (const rating of problem.ratings) {
      const key = dimensionKey(rating.dimension);
      const accumulator = accumulators.get(key);
      if (accumulator === undefined || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const value = numericRatingValue(rating.value);
      if (value === null) {
        continue;
      }
      accumulator.counts.set(value, (accumulator.counts.get(value) ?? 0) + 1);
      accumulator.knownCount += 1;
    }
  }

  // Map insertion order is the documented output order, so the expected dimension leads.
  const dimensions = [...accumulators.values()].map((accumulator) => {
    const buckets = [...accumulator.counts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([value, count]) => ({ value, count }));
    return {
      dimension: accumulator.label,
      buckets,
      knownCount: accumulator.knownCount,
      // A solved problem contributes at most one value or one unknown to each dimension, so the
      // remainder is exactly the honest unknown count (missing metadata included).
      unknownCount: solved.size - accumulator.knownCount,
    };
  });

  const tagsByKey = new Map<string, { rawTag: string; attempted: Set<string>; solved: Set<string> }>();
  let attemptedTaggedDistinct = 0;
  let solvedTaggedDistinct = 0;
  // Sorted keys make the retained spelling of a case-colliding label independent of row order.
  for (const problemKey of [...attempted].sort()) {
    const problem = problemByKey.get(problemKey);
    if (problem === undefined) {
      continue;
    }
    const seen = new Set<string>();
    let tagged = false;
    for (const tag of problem.rawTags) {
      const label = tag.raw.trim();
      const key = dimensionKey(label);
      if (key.length === 0 || seen.has(key)) {
        continue;
      }
      seen.add(key);
      tagged = true;
      const row = tagsByKey.get(key) ?? { rawTag: label, attempted: new Set<string>(), solved: new Set<string>() };
      row.attempted.add(problemKey);
      if (solved.has(problemKey)) {
        row.solved.add(problemKey);
      }
      tagsByKey.set(key, row);
    }
    if (tagged) {
      attemptedTaggedDistinct += 1;
      if (solved.has(problemKey)) {
        solvedTaggedDistinct += 1;
      }
    }
  }

  const tags = [...tagsByKey.values()]
    .map((row) => {
      const attemptedDistinct = row.attempted.size;
      const solvedDistinct = row.solved.size;
      return {
        rawTag: row.rawTag,
        attemptedDistinct,
        solvedDistinct,
        unconfirmedDistinct: attemptedDistinct - solvedDistinct,
        solveRate: attemptedDistinct === 0 ? 0 : solvedDistinct / attemptedDistinct,
        sufficientEvidence: attemptedDistinct >= minimumSampleSize,
      };
    })
    .sort(
      (left, right) =>
        right.unconfirmedDistinct - left.unconfirmedDistinct ||
        left.solveRate - right.solveRate ||
        right.attemptedDistinct - left.attemptedDistinct ||
        // A final code-point tie break, never `localeCompare`: the reference order must not depend on
        // the machine's locale.
        compareText(left.rawTag, right.rawTag),
    );

  return deepFreeze({
    solvedDistribution: {
      totalSolved: solved.size,
      metadataMissingSolved,
      dimensions,
    },
    platformTagStats: {
      verified: false,
      attemptedTaggedDistinct,
      solvedTaggedDistinct,
      minimumSampleSize,
      tags,
    },
  });
}
