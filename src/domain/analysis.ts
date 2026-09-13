/**
 * Analysis results and persisted job state.
 *
 * Two distinct owners (architecture): the {@link AnalysisResult} is the immutable analysis
 * output for one snapshot, while {@link AnalysisJobState} is the mutable, persistable
 * progress record (attempts, model-call budget, lease, cancellation). Keeping them apart
 * is what allows a restart to resume a job without rewriting past results.
 *
 * Every transition is a pure function of the previous state plus an explicit event; the
 * clock, the lease owner and the limits are always passed in by the caller.
 */
import { DomainError, invariant, requireFiniteInt } from './errors.js';
import { assertIsoTimestamp, problemKey, type ProblemRef } from './ids.js';
import { deepFreeze } from './immutable.js';
import { contentHashOf } from './hash.js';
import type { EvidenceRef } from './editorial.js';
import { createEvidenceRef, type AiTagSuggestion, type ModelRole } from './tags.js';
import { isSnapshotStale, type SnapshotHead } from './snapshot.js';

/** Outcome of the second verification pass over one suggestion. */
export type VerificationVerdict = 'support' | 'conflict' | 'insufficient';

export interface SuggestionVerification {
  readonly verificationId: string;
  readonly suggestionId: string;
  readonly problemKey: string;
  readonly snapshotId: string;
  readonly verdict: VerificationVerdict;
  /** `verification` is the dedicated second pass; `reasoning` is the reasoning role. */
  readonly verifierRole: Extract<ModelRole, 'verification' | 'reasoning'>;
  /** The verifier re-checked that evidence really occurs in the named solution. */
  readonly evidenceOk: boolean;
  /** Solutions that contradict the suggestion (empty means no conflict). */
  readonly conflictingSolutionIds: readonly string[];
  readonly note: string | null;
  readonly checkedAt: string;
}

export interface CreateSuggestionVerificationInput {
  readonly suggestionId: string;
  readonly problemRef: ProblemRef;
  readonly snapshotId: string;
  readonly verdict: VerificationVerdict;
  readonly verifierRole: 'verification' | 'reasoning';
  readonly evidenceOk: boolean;
  readonly checkedAt: string;
  readonly conflictingSolutionIds?: readonly string[];
  readonly note?: string | null;
}

/** Build a validated, frozen verification record. */
export function createSuggestionVerification(input: CreateSuggestionVerificationInput): SuggestionVerification {
  const checkedAt = assertIsoTimestamp('checkedAt', input.checkedAt);
  const problem = problemKey(input.problemRef);
  const conflicting = [...new Set(input.conflictingSolutionIds ?? [])];
  const note = input.note?.trim() || null;
  if (input.verdict === 'support') {
    invariant(conflicting.length === 0, 'invalid_input', 'a supporting verification cannot list conflicts', {
      suggestionId: input.suggestionId,
    });
    invariant(input.evidenceOk, 'invalid_input', 'a supporting verification requires evidenceOk', {
      suggestionId: input.suggestionId,
    });
  }
  // The id covers the verdict's semantics (role, evidence check, conflicts and note), so two
  // different second opinions recorded at the same instant stay distinct immutable records.
  return deepFreeze({
    verificationId: `verification|${contentHashOf({
      problem,
      snapshotId: input.snapshotId,
      suggestionId: input.suggestionId,
      verdict: input.verdict,
      verifierRole: input.verifierRole,
      evidenceOk: input.evidenceOk,
      conflictingSolutionIds: conflicting,
      note,
      checkedAt,
    }).slice(0, 32)}`,
    suggestionId: input.suggestionId,
    problemKey: problem,
    snapshotId: input.snapshotId,
    verdict: input.verdict,
    verifierRole: input.verifierRole,
    evidenceOk: input.evidenceOk,
    conflictingSolutionIds: conflicting,
    note,
    checkedAt,
  });
}

/**
 * Reasoning-role output. It is never adopted automatically: reasoning is used when no
 * editorial was found, so there is nothing to cite, and the product requires human review.
 */
export interface ReasoningDraft {
  readonly draftId: string;
  readonly problemKey: string;
  readonly snapshotId: string;
  readonly taxonomyIds: readonly string[];
  readonly rationale: string;
  readonly evidence: readonly EvidenceRef[];
  readonly createdAt: string;
}

export interface CreateReasoningDraftInput {
  readonly problemRef: ProblemRef;
  readonly snapshotId: string;
  readonly taxonomyIds: readonly string[];
  readonly rationale: string;
  readonly createdAt: string;
  readonly evidence?: readonly EvidenceRef[];
}

/** Build a validated, frozen reasoning draft. */
export function createReasoningDraft(input: CreateReasoningDraftInput): ReasoningDraft {
  const createdAt = assertIsoTimestamp('createdAt', input.createdAt);
  const key = problemKey(input.problemRef);
  const taxonomyIds = [...new Set(input.taxonomyIds)];
  const rationale = input.rationale.trim();
  const evidence = (input.evidence ?? []).map((entry) => createEvidenceRef(entry));
  // The id covers the draft body (tags, rationale, evidence): two different drafts for the
  // same snapshot in the same millisecond must not collide into one immutable record.
  return deepFreeze({
    draftId: `reasoning|${contentHashOf({
      key,
      snapshotId: input.snapshotId,
      taxonomyIds,
      rationale,
      evidence,
      createdAt,
    }).slice(0, 32)}`,
    problemKey: key,
    snapshotId: input.snapshotId,
    taxonomyIds,
    rationale,
    evidence,
    createdAt,
  });
}

/** Token/call accounting for one analysis run. */
export interface ModelUsage {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export function createModelUsage(input: Partial<ModelUsage> = {}): ModelUsage {
  const promptTokens = requireFiniteInt(input.promptTokens ?? 0, 'promptTokens');
  const completionTokens = requireFiniteInt(input.completionTokens ?? 0, 'completionTokens');
  return deepFreeze({
    calls: requireFiniteInt(input.calls ?? 0, 'calls'),
    promptTokens,
    completionTokens,
    totalTokens: requireFiniteInt(input.totalTokens ?? promptTokens + completionTokens, 'totalTokens'),
  });
}

export type AnalysisStatus = 'completed' | 'failed' | 'cancelled' | 'partial';

export interface AnalysisFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Version of the completeness/audit procedure recorded on an analysis result.
 *
 * Bumping this value invalidates every earlier check: `prepareBatch` skips a stored success
 * only while its recorded version is current, and `reanalyze` (or a legacy record without the
 * metadata) creates new work instead. Old results keep their own recorded version forever —
 * history is never rewritten.
 */
export const COMPLETENESS_AUDIT_VERSION = 'completeness-v1';

/**
 * Proof that one analysis actually performed the completeness check.
 *
 * The check is a *workflow* fact, not a mathematical proof of exhaustiveness: a current
 * editorial analysis completed **and** an independent verification pass answered the
 * omissions question (`missingSuggestions`) against the same snapshot and taxonomy.
 * Reasoning-only, failed and cancelled runs carry no completeness at all, so "unchecked"
 * stays visibly different from "checked".
 *
 * The record is additive and optional on {@link AnalysisResult}: a legacy row without it is
 * read as unchecked, and re-saving a legacy body stays byte-identical because the field only
 * enters the canonical body and the content hash when it is actually present.
 */
export interface AnalysisCompleteness {
  /** Audit procedure version; see {@link COMPLETENESS_AUDIT_VERSION}. */
  readonly version: string;
  /** Taxonomy version the check ran against, frozen together with the snapshot relation. */
  readonly taxonomyVersion: string;
  /** Snapshot the check applies to; a different head makes it outdated, not wrong. */
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly checkedAt: string;
  /** The independent pass really answered the omissions question (possibly with "none"). */
  readonly omissionsChecked: true;
}

export interface CreateAnalysisCompletenessInput {
  readonly version?: string;
  readonly taxonomyVersion: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly checkedAt: string;
}

/** Build the validated, frozen completeness record of one successful checked analysis. */
export function createAnalysisCompleteness(input: CreateAnalysisCompletenessInput): AnalysisCompleteness {
  const version = (input.version ?? COMPLETENESS_AUDIT_VERSION).trim();
  invariant(version.length > 0, 'invalid_input', 'completeness version must not be empty', { input });
  invariant(
    typeof input.taxonomyVersion === 'string' && input.taxonomyVersion.trim().length > 0,
    'invalid_input',
    'completeness taxonomyVersion must not be empty',
    { taxonomyVersion: input.taxonomyVersion },
  );
  invariant(
    typeof input.snapshotId === 'string' && input.snapshotId.trim().length > 0,
    'invalid_input',
    'completeness snapshotId must not be empty',
    { snapshotId: input.snapshotId },
  );
  invariant(
    Number.isInteger(input.snapshotVersion) && input.snapshotVersion >= 1,
    'invalid_input',
    'completeness snapshotVersion must be >= 1',
    { snapshotVersion: input.snapshotVersion },
  );
  return deepFreeze({
    version,
    taxonomyVersion: input.taxonomyVersion,
    snapshotId: input.snapshotId,
    snapshotVersion: input.snapshotVersion,
    checkedAt: assertIsoTimestamp('checkedAt', input.checkedAt),
    omissionsChecked: true as const,
  });
}

/** What a caller currently requires a stored completeness record to match. */
export interface RequiredCompleteness {
  readonly version: string;
  readonly taxonomyVersion: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
}

/**
 * True only when the recorded check is the *current* procedure against the *current*
 * snapshot and taxonomy. A missing record (legacy), an older audit version, an outdated
 * snapshot or a different taxonomy all report `false` — such a result stays readable, but it
 * no longer satisfies the check.
 */
export function completenessIsCurrent(
  completeness: AnalysisCompleteness | null | undefined,
  required: RequiredCompleteness,
): boolean {
  if (completeness === null || completeness === undefined) {
    return false;
  }
  return (
    completeness.version === required.version &&
    completeness.taxonomyVersion === required.taxonomyVersion &&
    completeness.snapshotId === required.snapshotId &&
    completeness.snapshotVersion === required.snapshotVersion &&
    completeness.omissionsChecked === true
  );
}

/** Immutable analysis output for exactly one snapshot. */
export interface AnalysisResult {
  readonly analysisId: string;
  readonly problemKey: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly taxonomyVersion: string;
  readonly createdAt: string;
  readonly status: AnalysisStatus;
  readonly suggestions: readonly AiTagSuggestion[];
  readonly verifications: readonly SuggestionVerification[];
  readonly reasoningDrafts: readonly ReasoningDraft[];
  readonly usage: ModelUsage | null;
  readonly failure: AnalysisFailure | null;
  /**
   * Present only when this run really performed the completeness check; absent on legacy rows
   * (recorded before the check existed) and on reasoning-only/failed/cancelled runs.
   */
  readonly completeness?: AnalysisCompleteness;
}

export interface CreateAnalysisResultInput {
  readonly problemRef: ProblemRef;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly taxonomyVersion: string;
  readonly createdAt: string;
  readonly status: AnalysisStatus;
  readonly suggestions?: readonly AiTagSuggestion[];
  readonly verifications?: readonly SuggestionVerification[];
  readonly reasoningDrafts?: readonly ReasoningDraft[];
  readonly usage?: ModelUsage | null;
  readonly failure?: AnalysisFailure | null;
  /** Omitted (or `null`) keeps the legacy body and content hash byte-identical. */
  readonly completeness?: AnalysisCompleteness | null;
}

/**
 * Build a validated, frozen analysis result. `analysisId` is a content hash, so replaying
 * the same model output for the same snapshot is idempotent.
 */
export function createAnalysisResult(input: CreateAnalysisResultInput): AnalysisResult {
  const createdAt = assertIsoTimestamp('createdAt', input.createdAt);
  const key = problemKey(input.problemRef);
  invariant(
    Number.isInteger(input.snapshotVersion) && input.snapshotVersion >= 1,
    'invalid_input',
    'snapshotVersion must be >= 1',
    { snapshotVersion: input.snapshotVersion },
  );
  const suggestions = input.suggestions ?? [];
  const verifications = input.verifications ?? [];
  const reasoningDrafts = input.reasoningDrafts ?? [];
  const suggestionIds = new Set(suggestions.map((suggestion) => suggestion.suggestionId));
  for (const suggestion of suggestions) {
    invariant(suggestion.problemKey === key, 'invalid_input', 'suggestion belongs to another problem', {
      suggestionId: suggestion.suggestionId,
    });
    invariant(suggestion.snapshotId === input.snapshotId, 'invalid_input', 'suggestion targets another snapshot', {
      suggestionId: suggestion.suggestionId,
    });
  }
  for (const verification of verifications) {
    invariant(suggestionIds.has(verification.suggestionId), 'missing_reference', 'verification targets unknown suggestion', {
      suggestionId: verification.suggestionId,
    });
    invariant(verification.problemKey === key, 'invalid_input', 'verification belongs to another problem', {
      verificationId: verification.verificationId,
      problemKey: verification.problemKey,
    });
    invariant(verification.snapshotId === input.snapshotId, 'invalid_input', 'verification targets another snapshot', {
      verificationId: verification.verificationId,
      snapshotId: verification.snapshotId,
    });
  }
  for (const draft of reasoningDrafts) {
    invariant(draft.problemKey === key, 'invalid_input', 'reasoning draft belongs to another problem', {
      draftId: draft.draftId,
      problemKey: draft.problemKey,
    });
    invariant(draft.snapshotId === input.snapshotId, 'invalid_input', 'reasoning draft targets another snapshot', {
      draftId: draft.draftId,
      snapshotId: draft.snapshotId,
    });
  }
  if (input.status === 'failed' || input.status === 'cancelled') {
    invariant(input.failure !== null && input.failure !== undefined, 'invalid_input', `${input.status} requires a failure record`, {
      status: input.status,
    });
  }
  const completeness = input.completeness ?? null;
  if (completeness !== null) {
    invariant(
      completeness.snapshotId === input.snapshotId && completeness.snapshotVersion === input.snapshotVersion,
      'invalid_input',
      'completeness record targets another snapshot',
      {
        completenessSnapshotId: completeness.snapshotId,
        completenessSnapshotVersion: completeness.snapshotVersion,
        snapshotId: input.snapshotId,
        snapshotVersion: input.snapshotVersion,
      },
    );
    invariant(
      completeness.taxonomyVersion === input.taxonomyVersion,
      'invalid_input',
      'completeness record was produced under another taxonomy version',
      {
        completenessTaxonomyVersion: completeness.taxonomyVersion,
        taxonomyVersion: input.taxonomyVersion,
      },
    );
    invariant(
      input.status === 'completed',
      'invalid_input',
      'only a completed analysis may carry a completeness record',
      { status: input.status },
    );
  }
  // The id covers the whole semantic result (version, suggestions, verifications, drafts,
  // usage and failure), not only the referenced ids and the timestamp: two different model
  // answers recorded in the same millisecond must stay distinct immutable records, while an
  // identical replay still produces the identical id. The optional completeness record joins
  // the hash **only when present**, so a legacy replay keeps its original id and body.
  const analysisId = `analysis|${contentHashOf({
    key,
    snapshotId: input.snapshotId,
    snapshotVersion: input.snapshotVersion,
    taxonomyVersion: input.taxonomyVersion,
    createdAt,
    status: input.status,
    suggestions,
    verifications,
    reasoningDrafts,
    usage: input.usage ?? null,
    failure: input.failure ?? null,
    ...(completeness === null ? {} : { completeness }),
  }).slice(0, 32)}`;
  return deepFreeze({
    analysisId,
    problemKey: key,
    snapshotId: input.snapshotId,
    snapshotVersion: input.snapshotVersion,
    taxonomyVersion: input.taxonomyVersion,
    createdAt,
    status: input.status,
    suggestions,
    verifications,
    reasoningDrafts,
    usage: input.usage ?? null,
    failure: input.failure ?? null,
    ...(completeness === null ? {} : { completeness }),
  });
}

/**
 * True when this analysis no longer matches the current snapshot of its problem.
 * No current head means nothing is stored for this problem, so the analysis is not usable.
 *
 * The recorded snapshot id already embeds the analysed content hash and version; the
 * version is compared again explicitly, so an analysis of an earlier `A` stays stale
 * against a reverted `A` at a higher version.
 */
export function analysisIsStale(analysis: AnalysisResult, current: SnapshotHead | null | undefined): boolean {
  if (!current) {
    return true;
  }
  return isSnapshotStale(
    { snapshotId: analysis.snapshotId, contentHash: current.contentHash, version: analysis.snapshotVersion },
    current,
  );
}

/** Verification record for one suggestion, if the second pass ran. */
export function verificationFor(
  analysis: AnalysisResult,
  suggestionId: string,
): SuggestionVerification | null {
  return analysis.verifications.find((verification) => verification.suggestionId === suggestionId) ?? null;
}

// ---------------------------------------------------------------------------------------
// Persisted job state
// ---------------------------------------------------------------------------------------

export type AnalysisJobStatus = 'pending' | 'running' | 'paused_quota' | 'succeeded' | 'failed' | 'cancelled';

/** Model-call counters persisted with the job so restarts cannot reset the budget. */
export interface AnalysisJobCounters {
  readonly analysisCalls: number;
  readonly reasoningCalls: number;
  readonly retries: number;
}

export interface AnalysisJobError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Mutable, persistable progress record for one (problem, snapshot) analysis. */
export interface AnalysisJobState {
  readonly jobId: string;
  readonly problemKey: string;
  readonly snapshotId: string;
  readonly status: AnalysisJobStatus;
  readonly attempts: number;
  readonly counters: AnalysisJobCounters;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly analysisId: string | null;
  readonly lastError: AnalysisJobError | null;
}

/** Explicit runtime limits, supplied by the caller (validated configuration). */
export interface AnalysisJobLimits {
  readonly maxAnalysisCalls: number;
  readonly maxReasoningCalls: number;
  readonly maxAttempts: number;
  readonly leaseMs: number;
}

/**
 * Deterministic job id for a snapshot: re-running the same work is idempotent.
 *
 * The snapshot id encodes the analysed content hash *and* its version, so a snapshot that
 * merely reverts to earlier content (`A -> B -> A`, a new version) gets a fresh job instead
 * of inheriting the finished job of the first `A`.
 */
export function analysisJobIdOf(snapshotId: string, runId?: string | null): string {
  return runId === undefined || runId === null
    ? `analysis-job|${contentHashOf({ snapshotId }).slice(0, 32)}`
    : `analysis-job|${contentHashOf({ snapshotId, runId }).slice(0, 32)}`;
}

export function createAnalysisJob(input: {
  readonly problemRef: ProblemRef;
  readonly snapshotId: string;
  readonly at: string;
  /**
   * Optional run identity: a rerun of an already finished snapshot gets its own job instead of
   * overwriting the immutable legacy one. Omitting it keeps the legacy deterministic id, so
   * existing callers and recorded fixtures are unaffected.
   */
  readonly runId?: string | null;
}): AnalysisJobState {
  const at = assertIsoTimestamp('at', input.at);
  if (input.runId !== undefined && input.runId !== null) {
    invariant(
      typeof input.runId === 'string' && input.runId.trim().length > 0,
      'invalid_input',
      'runId must be a non-empty string when supplied',
      { runId: input.runId },
    );
  }
  return deepFreeze({
    jobId: analysisJobIdOf(input.snapshotId, input.runId ?? null),
    problemKey: problemKey(input.problemRef),
    snapshotId: input.snapshotId,
    status: 'pending',
    attempts: 0,
    counters: { analysisCalls: 0, reasoningCalls: 0, retries: 0 },
    createdAt: at,
    updatedAt: at,
    leaseOwner: null,
    leaseExpiresAt: null,
    analysisId: null,
    lastError: null,
  });
}

/** Events that drive the job state machine. Every event carries its own timestamp. */
export type AnalysisJobEvent =
  | { readonly type: 'start'; readonly owner: string; readonly at: string; readonly leaseMs: number }
  | { readonly type: 'consume_call'; readonly kind: 'analysis' | 'reasoning'; readonly at: string; readonly limits: AnalysisJobLimits }
  | { readonly type: 'succeed'; readonly at: string; readonly analysisId: string }
  | { readonly type: 'fail'; readonly at: string; readonly error: AnalysisJobError; readonly limits: AnalysisJobLimits }
  | { readonly type: 'pause_for_quota'; readonly at: string; readonly reason: string }
  | { readonly type: 'requeue'; readonly at: string }
  | { readonly type: 'cancel'; readonly at: string }
  | { readonly type: 'resume'; readonly owner: string; readonly at: string; readonly leaseMs: number };

const TERMINAL: readonly AnalysisJobStatus[] = ['succeeded', 'cancelled'];

function stopped(status: AnalysisJobStatus): boolean {
  return TERMINAL.includes(status);
}

function assertNotStopped(state: AnalysisJobState, event: AnalysisJobEvent): void {
  invariant(
    !stopped(state.status),
    'invalid_transition',
    `cannot apply ${event.type} to ${state.status} job`,
    { jobId: state.jobId, status: state.status, event: event.type },
  );
}

/** Model work may only be accounted for and finished while the job actually runs. */
function assertRunning(state: AnalysisJobState, event: AnalysisJobEvent): void {
  invariant(
    state.status === 'running',
    'invalid_transition',
    `cannot apply ${event.type} to ${state.status} job`,
    { jobId: state.jobId, status: state.status, event: event.type },
  );
}

/**
 * Pure job transition. Throws {@link DomainError} with code `invalid_transition` for
 * transitions the product must not perform (e.g. succeeding a cancelled job).
 */
export function transitionJob(state: AnalysisJobState, event: AnalysisJobEvent): AnalysisJobState {
  switch (event.type) {
    case 'start': {
      invariant(
        state.status === 'pending' || state.status === 'paused_quota',
        'invalid_transition',
        `cannot start a ${state.status} job`,
        { status: state.status },
      );
      const at = assertIsoTimestamp('at', event.at);
      return deepFreeze({
        ...state,
        status: 'running',
        attempts: state.attempts + 1,
        updatedAt: at,
        leaseOwner: event.owner,
        leaseExpiresAt: new Date(Date.parse(at) + requireFiniteInt(event.leaseMs, 'leaseMs', 1)).toISOString(),
      });
    }
    case 'consume_call': {
      assertRunning(state, event);
      const at = assertIsoTimestamp('at', event.at);
      const limit =
        event.kind === 'analysis'
          ? requireFiniteInt(event.limits.maxAnalysisCalls, 'maxAnalysisCalls', 1)
          : requireFiniteInt(event.limits.maxReasoningCalls, 'maxReasoningCalls', 1);
      const used = event.kind === 'analysis' ? state.counters.analysisCalls : state.counters.reasoningCalls;
      if (used >= limit) {
        // Budget exhausted: pause explicitly instead of silently continuing.
        return deepFreeze({
          ...state,
          status: 'paused_quota',
          updatedAt: at,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: { code: 'quota_exhausted', message: `${event.kind} call limit ${limit} reached`, retryable: true },
        });
      }
      return deepFreeze({
        ...state,
        updatedAt: at,
        counters: {
          ...state.counters,
          analysisCalls: state.counters.analysisCalls + (event.kind === 'analysis' ? 1 : 0),
          reasoningCalls: state.counters.reasoningCalls + (event.kind === 'reasoning' ? 1 : 0),
        },
      });
    }
    case 'succeed': {
      assertRunning(state, event);
      const at = assertIsoTimestamp('at', event.at);
      return deepFreeze({
        ...state,
        status: 'succeeded',
        updatedAt: at,
        leaseOwner: null,
        leaseExpiresAt: null,
        analysisId: event.analysisId,
        lastError: null,
      });
    }
    case 'fail': {
      assertNotStopped(state, event);
      const at = assertIsoTimestamp('at', event.at);
      const maxAttempts = requireFiniteInt(event.limits.maxAttempts, 'maxAttempts', 1);
      // A non-retryable error is terminal immediately; a retryable one only after the
      // attempt budget is exhausted. In both cases the job must not stay schedulable.
      const terminal = !event.error.retryable || state.attempts >= maxAttempts;
      return deepFreeze({
        ...state,
        status: terminal ? 'failed' : 'pending',
        updatedAt: at,
        leaseOwner: null,
        leaseExpiresAt: null,
        counters: {
          ...state.counters,
          retries: state.counters.retries + (terminal ? 0 : 1),
        },
        lastError: event.error,
      });
    }
    case 'pause_for_quota': {
      assertNotStopped(state, event);
      const at = assertIsoTimestamp('at', event.at);
      return deepFreeze({
        ...state,
        status: 'paused_quota',
        updatedAt: at,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: { code: 'quota_exhausted', message: event.reason, retryable: true },
      });
    }
    case 'requeue': {
      assertNotStopped(state, event);
      const at = assertIsoTimestamp('at', event.at);
      invariant(
        state.status !== 'running' || isLeaseExpired(state, at),
        'invalid_transition',
        'cannot requeue a job whose lease is still live',
        { jobId: state.jobId, status: state.status, leaseExpiresAt: state.leaseExpiresAt, at },
      );
      return deepFreeze({
        ...state,
        status: 'pending',
        updatedAt: at,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }
    case 'cancel': {
      assertNotStopped(state, event);
      const at = assertIsoTimestamp('at', event.at);
      return deepFreeze({
        ...state,
        status: 'cancelled',
        updatedAt: at,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: { code: 'cancelled', message: 'analysis cancelled by user', retryable: false },
      });
    }
    case 'resume': {
      invariant(
        state.status === 'paused_quota',
        'invalid_transition',
        `cannot resume a ${state.status} job`,
        { status: state.status },
      );
      const at = assertIsoTimestamp('at', event.at);
      return deepFreeze({
        ...state,
        status: 'running',
        attempts: state.attempts + 1,
        updatedAt: at,
        leaseOwner: event.owner,
        leaseExpiresAt: new Date(Date.parse(at) + requireFiniteInt(event.leaseMs, 'leaseMs', 1)).toISOString(),
        lastError: null,
      });
    }
    default: {
      const exhaustive: never = event;
      throw new DomainError('invalid_transition', `unsupported job event ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** True when a running job's lease has expired and the job may be reclaimed. */
export function isLeaseExpired(state: AnalysisJobState, now: string): boolean {
  if (state.status !== 'running' || state.leaseExpiresAt === null) {
    return false;
  }
  return Date.parse(now) >= Date.parse(state.leaseExpiresAt);
}

/**
 * Restart recovery: a running job whose lease expired goes back to `pending` (its counters
 * and attempts are preserved); paused jobs stay paused until the user resumes them.
 */
export function recoverAfterRestart(state: AnalysisJobState, now: string): AnalysisJobState {
  const at = assertIsoTimestamp('now', now);
  if (isLeaseExpired(state, at)) {
    return deepFreeze({ ...state, status: 'pending', updatedAt: at, leaseOwner: null, leaseExpiresAt: null });
  }
  return state;
}
