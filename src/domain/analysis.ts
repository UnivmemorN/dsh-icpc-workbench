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
  const conflicting = [...new Set(input.conflictingSolutionIds ?? [])];
  if (input.verdict === 'support') {
    invariant(conflicting.length === 0, 'invalid_input', 'a supporting verification cannot list conflicts', {
      suggestionId: input.suggestionId,
    });
    invariant(input.evidenceOk, 'invalid_input', 'a supporting verification requires evidenceOk', {
      suggestionId: input.suggestionId,
    });
  }
  return deepFreeze({
    verificationId: `verification|${contentHashOf({
      suggestionId: input.suggestionId,
      verdict: input.verdict,
      checkedAt,
    }).slice(0, 32)}`,
    suggestionId: input.suggestionId,
    problemKey: problemKey(input.problemRef),
    snapshotId: input.snapshotId,
    verdict: input.verdict,
    verifierRole: input.verifierRole,
    evidenceOk: input.evidenceOk,
    conflictingSolutionIds: conflicting,
    note: input.note?.trim() || null,
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
  return deepFreeze({
    draftId: `reasoning|${contentHashOf({ key, snapshotId: input.snapshotId, createdAt }).slice(0, 32)}`,
    problemKey: key,
    snapshotId: input.snapshotId,
    taxonomyIds: [...new Set(input.taxonomyIds)],
    rationale: input.rationale.trim(),
    evidence: (input.evidence ?? []).map((evidence) => createEvidenceRef(evidence)),
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
  const analysisId = `analysis|${contentHashOf({
    key,
    snapshotId: input.snapshotId,
    taxonomyVersion: input.taxonomyVersion,
    createdAt,
    status: input.status,
    suggestions: suggestions.map((suggestion) => suggestion.suggestionId),
    verifications: verifications.map((verification) => verification.verificationId),
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
export function analysisJobIdOf(snapshotId: string): string {
  return `analysis-job|${contentHashOf({ snapshotId }).slice(0, 32)}`;
}

export function createAnalysisJob(input: {
  readonly problemRef: ProblemRef;
  readonly snapshotId: string;
  readonly at: string;
}): AnalysisJobState {
  const at = assertIsoTimestamp('at', input.at);
  return deepFreeze({
    jobId: analysisJobIdOf(input.snapshotId),
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
