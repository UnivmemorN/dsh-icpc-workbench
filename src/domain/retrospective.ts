/**
 * Retrospectives: what the solver actually did after a problem was finished.
 *
 * The product must not infer "solved it myself, knows the technique" from an AC verdict.
 * Only a recorded retrospective turns a solved problem into a *confirmed* skill, and the
 * completion mode (independent / assisted / solution used) is preserved because an assisted
 * solve is much weaker evidence than an independent one.
 */
import { invariant } from './errors.js';
import { assertIsoTimestamp, problemKey, type ProblemRef } from './ids.js';
import { deepFreeze } from './immutable.js';
import { contentHashOf } from './hash.js';

export type CompletionMode = 'independent' | 'assisted' | 'solution_used';

export const COMPLETION_MODES: readonly CompletionMode[] = ['independent', 'assisted', 'solution_used'];

/** Human statements of *how* the problem was completed and which skills were exercised. */
export interface Retrospective {
  readonly retrospectiveId: string;
  readonly problemKey: string;
  readonly accountId: string;
  readonly mode: CompletionMode;
  /** Taxonomy ids the solver confirms they actually used. */
  readonly taxonomyIds: readonly string[];
  /** Editorial solutions that were consulted (empty for independent work). */
  readonly solutionIds: readonly string[];
  readonly recordedAt: string;
  readonly note: string | null;
}

export interface CreateRetrospectiveInput {
  readonly problemRef: ProblemRef;
  readonly accountId: string;
  readonly mode: CompletionMode;
  readonly recordedAt: string;
  readonly taxonomyIds?: readonly string[];
  readonly solutionIds?: readonly string[];
  readonly note?: string | null;
}

/** Build a validated, frozen retrospective. */
export function createRetrospective(input: CreateRetrospectiveInput): Retrospective {
  invariant(
    COMPLETION_MODES.includes(input.mode),
    'invalid_input',
    `unknown completion mode ${String(input.mode)}`,
    { mode: input.mode },
  );
  const key = problemKey(input.problemRef);
  const recordedAt = assertIsoTimestamp('recordedAt', input.recordedAt);
  invariant(input.accountId.trim().length > 0, 'invalid_input', 'retrospective requires an account id');
  return deepFreeze({
    retrospectiveId: `retro|${contentHashOf({ key, accountId: input.accountId, recordedAt }).slice(0, 32)}`,
    problemKey: key,
    accountId: input.accountId,
    mode: input.mode,
    taxonomyIds: [...new Set(input.taxonomyIds ?? [])],
    solutionIds: [...new Set(input.solutionIds ?? [])],
    recordedAt,
    note: input.note?.trim() || null,
  });
}

/** Latest retrospective per (account, problem); a re-recorded retrospective replaces the old one. */
export function latestRetrospectiveByProblem(
  retrospectives: readonly Retrospective[],
): ReadonlyMap<string, Retrospective> {
  const byKey = new Map<string, Retrospective>();
  for (const retrospective of retrospectives) {
    const key = `${retrospective.accountId}|${retrospective.problemKey}`;
    const current = byKey.get(key);
    if (!current || Date.parse(retrospective.recordedAt) >= Date.parse(current.recordedAt)) {
      byKey.set(key, retrospective);
    }
  }
  return byKey;
}
