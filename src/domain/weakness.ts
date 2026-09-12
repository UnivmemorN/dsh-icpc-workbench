/**
 * Weakness statistics.
 *
 * Counting rules (deliberately conservative):
 * - the unit is the **distinct problem**, per account: 30 submissions on one problem count
 *   once, and repeated ACs never inflate anything;
 * - a tag is only counted for a problem through *effective* decisions (auto-adopted or
 *   manually accepted), and only the *current* decision per (problem, tag) is read:
 *   a later manual reject removes the tag again, and pending review never enters
 *   statistics;
 * - raw platform rating dimensions are reported as-is (`rating`, `difficulty`, …); the
 *   product never invents a cross-platform difficulty scale;
 * - a tag with fewer than `minDistinctProblems` distinct attempts is reported as
 *   insufficient evidence and excluded from the weakness ranking, but its sample size and
 *   coverage are still exposed;
 * - an AC proves at most that a solution was submitted. Confirmed skills come exclusively
 *   from retrospectives and are reported as a **separate** metric; because a retrospective
 *   can be re-recorded, only the latest one per (account, problem) counts.
 */
import { invariant, requireFiniteInt } from './errors.js';
import { deepFreeze } from './immutable.js';
import type { NormalizedProblem } from './problem.js';
import { numericRating } from './problem.js';
import { reduceSubmissionsByAccount, type Submission } from './submission.js';
import { effectiveTagIdsByProblem, type TagDecision } from './tags.js';
import { latestRetrospectiveByProblem, type Retrospective, type CompletionMode } from './retrospective.js';

/** Explicit statistics settings; `minDistinctProblems` is the sample gate. */
export interface WeaknessSettings {
  readonly minDistinctProblems: number;
  /** Raw rating dimension to aggregate, e.g. `rating` (CF) or `difficulty` (Luogu). */
  readonly ratingDimension: string | null;
}

export const DEFAULT_WEAKNESS_SETTINGS: WeaknessSettings = { minDistinctProblems: 5, ratingDimension: null };

export interface RatingSummary {
  readonly dimension: string;
  readonly sampleSize: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
}

/** Confirmed skills from retrospectives — never derived from AC verdicts. */
export interface ConfirmedSkillSummary {
  readonly total: number;
  readonly independent: number;
  readonly assisted: number;
  readonly solutionUsed: number;
  readonly taxonomyIds: readonly string[];
}

export interface TagWeaknessSample {
  readonly accountId: string;
  readonly taxonomyId: string;
  readonly attemptedDistinct: number;
  readonly solvedDistinct: number;
  readonly unsolvedDistinct: number;
  /** solvedDistinct / attemptedDistinct, in [0, 1]. */
  readonly solveRate: number;
  /** Sample size actually observed for this tag (= attemptedDistinct). */
  readonly sampleSize: number;
  readonly minimumSampleSize: number;
  /** False while the sample is below the configured minimum. */
  readonly sufficient: boolean;
  /** Share of the account's distinct attempted problems that carry this tag. */
  readonly coverageRatio: number;
  readonly ratingSummary: readonly RatingSummary[];
  readonly confirmedSkills: ConfirmedSkillSummary;
}

export interface AccountWeaknessReport {
  readonly accountId: string;
  readonly attemptedDistinctTotal: number;
  readonly solvedDistinctTotal: number;
  /** Distinct attempted problems that carry at least one effective algorithm tag. */
  readonly taggedAttemptedDistinct: number;
  /** taggedAttemptedDistinct / attemptedDistinctTotal; `null` when nothing was attempted. */
  readonly tagCoverageRatio: number | null;
  readonly tags: readonly TagWeaknessSample[];
  /** Tags with a sufficient sample, weakest (lowest solve rate) first. */
  readonly ranking: readonly TagWeaknessSample[];
  /** Tags below the sample gate, largest sample first. */
  readonly insufficientEvidence: readonly TagWeaknessSample[];
  readonly confirmedSkills: ConfirmedSkillSummary;
  readonly notes: readonly string[];
}

export interface ComputeWeaknessInput {
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  readonly decisions: readonly TagDecision[];
  readonly retrospectives: readonly Retrospective[];
  readonly settings: WeaknessSettings;
  /** Accounts to report even when they have no submissions (explicit empty evidence). */
  readonly accountIds?: readonly string[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function ratingSummaryFor(problems: readonly NormalizedProblem[], dimension: string | null): readonly RatingSummary[] {
  const byDimension = new Map<string, number[]>();
  for (const problem of problems) {
    for (const rating of problem.ratings) {
      if (dimension !== null && rating.dimension.toLowerCase() !== dimension.toLowerCase()) {
        continue;
      }
      const value = numericRating(problem, rating.dimension);
      if (value === null) {
        continue;
      }
      const bucket = byDimension.get(rating.dimension);
      if (bucket) {
        bucket.push(value);
      } else {
        byDimension.set(rating.dimension, [value]);
      }
    }
  }
  return [...byDimension.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dimensionName, values]) => ({
      dimension: dimensionName,
      sampleSize: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      median: median(values),
    }));
}

function confirmedSkillsFrom(
  retrospectives: readonly Retrospective[],
  taxonomyId: string | null,
): ConfirmedSkillSummary {
  const relevant = taxonomyId === null
    ? retrospectives
    : retrospectives.filter((retrospective) => retrospective.taxonomyIds.includes(taxonomyId));
  const counts: Record<CompletionMode, number> = { independent: 0, assisted: 0, solution_used: 0 };
  const taxonomyIds = new Set<string>();
  for (const retrospective of relevant) {
    counts[retrospective.mode] += 1;
    for (const id of retrospective.taxonomyIds) {
      taxonomyIds.add(id);
    }
  }
  return {
    total: relevant.length,
    independent: counts.independent,
    assisted: counts.assisted,
    solutionUsed: counts.solution_used,
    taxonomyIds: [...taxonomyIds].sort(),
  };
}

/** Effective taxonomy ids per problem key (current decision per tag, manual precedence). */
function effectiveTagsByProblem(decisions: readonly TagDecision[]): Map<string, Set<string>> {
  return new Map(
    [...effectiveTagIdsByProblem(decisions)].map(([key, ids]) => [key, new Set<string>(ids)]),
  );
}

/**
 * Compute one weakness report per account.
 * Accounts listed in `accountIds` are always present, even with zero records, so callers can
 * show "insufficient evidence" instead of an empty screen.
 */
export function computeWeaknessReports(input: ComputeWeaknessInput): readonly AccountWeaknessReport[] {
  const minimumSampleSize = requireFiniteInt(input.settings.minDistinctProblems, 'minDistinctProblems', 1);
  const problemByKey = new Map(input.problems.map((problem) => [problem.key, problem]));
  const tagsByProblem = effectiveTagsByProblem(input.decisions);
  const tallies = reduceSubmissionsByAccount(input.submissions);
  // A retrospective may be re-recorded; only the latest one per (account, problem) is a
  // statement about the solver, so older entries must not inflate the skill counts.
  const latestRetrospectives = [...latestRetrospectiveByProblem(input.retrospectives).values()];

  const accountIds = new Set<string>([...tallies.keys(), ...(input.accountIds ?? [])]);
  const reports: AccountWeaknessReport[] = [];

  for (const accountId of [...accountIds].sort()) {
    const tally = tallies.get(accountId);
    const attempted = tally?.attemptedProblems ?? new Set<string>();
    const solved = tally?.solvedProblems ?? new Set<string>();
    const attemptedTotal = attempted.size;

    const tagAttempted = new Map<string, Set<string>>();
    const tagSolved = new Map<string, Set<string>>();
    let taggedAttemptedDistinct = 0;
    for (const problemKey of attempted) {
      const tags = tagsByProblem.get(problemKey);
      if (!tags || tags.size === 0) {
        continue;
      }
      taggedAttemptedDistinct += 1;
      for (const taxonomyId of tags) {
        const attemptedSet = tagAttempted.get(taxonomyId) ?? new Set<string>();
        attemptedSet.add(problemKey);
        tagAttempted.set(taxonomyId, attemptedSet);
        if (solved.has(problemKey)) {
          const solvedSet = tagSolved.get(taxonomyId) ?? new Set<string>();
          solvedSet.add(problemKey);
          tagSolved.set(taxonomyId, solvedSet);
        }
      }
    }

    const accountRetrospectives = latestRetrospectives.filter(
      (retrospective) => retrospective.accountId === accountId,
    );

    const tags: TagWeaknessSample[] = [...tagAttempted.entries()]
      .map(([taxonomyId, attemptedSet]) => {
        const solvedSet = tagSolved.get(taxonomyId) ?? new Set<string>();
        const attemptedCount = attemptedSet.size;
        const solvedCount = solvedSet.size;
        const problemsForTag = [...attemptedSet]
          .map((key) => problemByKey.get(key))
          .filter((problem): problem is NormalizedProblem => problem !== undefined);
        return deepFreeze({
          accountId,
          taxonomyId,
          attemptedDistinct: attemptedCount,
          solvedDistinct: solvedCount,
          unsolvedDistinct: attemptedCount - solvedCount,
          solveRate: attemptedCount === 0 ? 0 : solvedCount / attemptedCount,
          sampleSize: attemptedCount,
          minimumSampleSize,
          sufficient: attemptedCount >= minimumSampleSize,
          coverageRatio: attemptedTotal === 0 ? 0 : attemptedCount / attemptedTotal,
          ratingSummary: ratingSummaryFor(problemsForTag, input.settings.ratingDimension),
          confirmedSkills: confirmedSkillsFrom(accountRetrospectives, taxonomyId),
        });
      })
      .sort((left, right) =>
        right.attemptedDistinct - left.attemptedDistinct || left.taxonomyId.localeCompare(right.taxonomyId),
      );

    const ranking = [...tags]
      .filter((tag) => tag.sufficient)
      .sort(
        (left, right) =>
          left.solveRate - right.solveRate ||
          right.attemptedDistinct - left.attemptedDistinct ||
          left.taxonomyId.localeCompare(right.taxonomyId),
      );

    const notes = ['ac_does_not_imply_solution_mastery'];
    if (attemptedTotal === 0) {
      notes.push('no_attempted_problems');
    }
    if (accountRetrospectives.length === 0) {
      notes.push('no_retrospectives');
    }

    reports.push(
      deepFreeze({
        accountId,
        attemptedDistinctTotal: attemptedTotal,
        solvedDistinctTotal: solved.size,
        taggedAttemptedDistinct,
        tagCoverageRatio: attemptedTotal === 0 ? null : taggedAttemptedDistinct / attemptedTotal,
        tags,
        ranking,
        insufficientEvidence: tags.filter((tag) => !tag.sufficient),
        confirmedSkills: confirmedSkillsFrom(accountRetrospectives, null),
        notes,
      }),
    );
  }

  return reports;
}

/** Convenience: the report for one account, or `null` when unknown. */
export function reportForAccount(
  reports: readonly AccountWeaknessReport[],
  accountId: string,
): AccountWeaknessReport | null {
  return reports.find((report) => report.accountId === accountId) ?? null;
}

/** True when the account has no usable history at all. */
export function hasInsufficientHistory(report: AccountWeaknessReport): boolean {
  return report.attemptedDistinctTotal === 0;
}

/** Guard: statistics must never be presented as mastery of all solutions. */
export function assertNoMasteryInference(report: AccountWeaknessReport): void {
  invariant(
    report.notes.includes('ac_does_not_imply_solution_mastery'),
    'invalid_input',
    'weakness report must carry the AC-inference disclaimer',
    { accountId: report.accountId },
  );
}
