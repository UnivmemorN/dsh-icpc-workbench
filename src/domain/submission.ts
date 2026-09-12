/**
 * Submissions and the "distinct problem" reductions used by statistics.
 *
 * Platforms report every attempt, including many rejected submissions for the same
 * problem. Statistics must count distinct problems, so the reduction helpers here are the
 * single place that decides what "attempted" and "solved" mean. Repeat submissions never
 * inflate a count.
 */
import { invariant } from './errors.js';
import {
  assertIsoTimestamp,
  encodeIdPart,
  problemKey,
  submissionKey,
  type ProblemRef,
  type SubmissionRef,
} from './ids.js';
import { deepFreeze } from './immutable.js';

export type SubmissionVerdict =
  | 'accepted'
  | 'wrong_answer'
  | 'time_limit_exceeded'
  | 'memory_limit_exceeded'
  | 'runtime_error'
  | 'compile_error'
  | 'presentation_error'
  | 'partial'
  | 'skipped'
  | 'unknown';

export const SUBMISSION_VERDICTS: readonly SubmissionVerdict[] = [
  'accepted',
  'wrong_answer',
  'time_limit_exceeded',
  'memory_limit_exceeded',
  'runtime_error',
  'compile_error',
  'presentation_error',
  'partial',
  'skipped',
  'unknown',
];

/** One submission as reported by a platform, normalised. */
export interface Submission {
  /** Stable id `submissionKey|externalId`; every component is escaped. */
  readonly id: string;
  readonly accountId: string;
  readonly ref: ProblemRef;
  readonly key: string;
  /** Platform submission id (string, platforms disagree on numeric width). */
  readonly externalId: string;
  readonly verdict: SubmissionVerdict;
  readonly submittedAt: string;
  readonly language: string | null;
  readonly timeMs: number | null;
  readonly memoryKb: number | null;
}

export interface CreateSubmissionInput {
  readonly accountId: string;
  readonly ref: ProblemRef;
  readonly externalId: string;
  readonly verdict: SubmissionVerdict;
  readonly submittedAt: string;
  readonly language?: string | null;
  readonly timeMs?: number | null;
  readonly memoryKb?: number | null;
}

/** Build a validated, frozen submission. */
export function createSubmission(input: CreateSubmissionInput): Submission {
  const externalId = input.externalId.trim();
  invariant(externalId.length > 0, 'invalid_input', 'submission externalId must not be empty', { input });
  invariant(
    SUBMISSION_VERDICTS.includes(input.verdict),
    'invalid_input',
    `unknown submission verdict ${String(input.verdict)}`,
    { verdict: input.verdict },
  );
  const ref: SubmissionRef = { ...input.ref, accountId: input.accountId };
  return deepFreeze({
    // Both the nested account id and the opaque platform submission id are escaped, so the
    // composite id stays unambiguous even when a platform id contains `|`.
    id: [submissionKey(ref), encodeIdPart(externalId)].join('|'),
    accountId: input.accountId,
    ref: input.ref,
    key: problemKey(input.ref),
    externalId,
    verdict: input.verdict,
    submittedAt: assertIsoTimestamp('submittedAt', input.submittedAt),
    language: input.language?.trim() || null,
    timeMs: input.timeMs ?? null,
    memoryKb: input.memoryKb ?? null,
  });
}

/** True for an accepted submission. */
export function isAccepted(submission: Pick<Submission, 'verdict'>): boolean {
  return submission.verdict === 'accepted';
}

/** Distinct-problem reduction result for one account. */
export interface AccountProblemTally {
  readonly accountId: string;
  /** Distinct problems with at least one submission of any verdict. */
  readonly attemptedProblems: ReadonlySet<string>;
  /** Distinct problems with at least one accepted submission. */
  readonly solvedProblems: ReadonlySet<string>;
  /** Attempt counts per problem, for diagnostics only (never for ranking). */
  readonly submissionCounts: ReadonlyMap<string, number>;
}

/**
 * Reduce submissions to distinct problems per account.
 * Multiple AC/WA submissions of the same problem yield exactly one attempted and one solved entry.
 */
export function reduceSubmissionsByAccount(submissions: readonly Submission[]): Map<string, AccountProblemTally> {
  const attempted = new Map<string, Set<string>>();
  const solved = new Map<string, Set<string>>();
  const counts = new Map<string, Map<string, number>>();

  for (const submission of submissions) {
    let attemptedSet = attempted.get(submission.accountId);
    if (!attemptedSet) {
      attemptedSet = new Set<string>();
      attempted.set(submission.accountId, attemptedSet);
    }
    attemptedSet.add(submission.key);

    let countMap = counts.get(submission.accountId);
    if (!countMap) {
      countMap = new Map<string, number>();
      counts.set(submission.accountId, countMap);
    }
    countMap.set(submission.key, (countMap.get(submission.key) ?? 0) + 1);

    if (isAccepted(submission)) {
      let solvedSet = solved.get(submission.accountId);
      if (!solvedSet) {
        solvedSet = new Set<string>();
        solved.set(submission.accountId, solvedSet);
      }
      solvedSet.add(submission.key);
    }
  }

  const result = new Map<string, AccountProblemTally>();
  for (const [accountId, attemptedSet] of attempted) {
    result.set(accountId, {
      accountId,
      attemptedProblems: attemptedSet,
      solvedProblems: solved.get(accountId) ?? new Set<string>(),
      submissionCounts: counts.get(accountId) ?? new Map<string, number>(),
    });
  }
  return result;
}

/** Latest submission per (account, problem), used for "current verdict" displays. */
export function latestSubmissionByProblem(submissions: readonly Submission[]): Map<string, Submission> {
  const latest = new Map<string, Submission>();
  for (const submission of submissions) {
    const key = `${submission.accountId}|${submission.key}`;
    const current = latest.get(key);
    if (!current || Date.parse(submission.submittedAt) >= Date.parse(current.submittedAt)) {
      latest.set(key, submission);
    }
  }
  return latest;
}

/** Deduplicate submissions by stable id, keeping the first occurrence. */
export function dedupeSubmissions(submissions: readonly Submission[]): Submission[] {
  const seen = new Set<string>();
  const out: Submission[] = [];
  for (const submission of submissions) {
    if (seen.has(submission.id)) {
      continue;
    }
    seen.add(submission.id);
    out.push(submission);
  }
  return out;
}
