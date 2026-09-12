/**
 * Durable analysis batches and model-call attempts.
 *
 * Scope: this module defines the **records and their rules only**. The pipeline that
 * orchestrates a batch is a later task; persistence of these records is the store port's job.
 * Everything here is plain data plus pure validation — ids and timestamps are supplied by the
 * caller, so nothing in the application layer reads a clock, an environment variable or an OS
 * resource, and a restart/replay produces exactly the same records.
 *
 * Two budget rules live here:
 *
 * - A batch's job/snapshot mapping, its `maxJobs` bound and its `createdAt` are fixed at
 *   creation, and `analysisCalls`/`reasoningCalls`/`retries` only move forward. Resuming a
 *   batch or raising its limits therefore can never refund calls it already spent.
 * - An attempt is persisted as `reserved` *before* the model is dispatched and only moves
 *   forward (`reserved → uncertain | settled`, `uncertain → settled`). An `uncertain` call is
 *   never free: it stays on the books until late usage settles it. A `settled` record is
 *   immutable, so an audit row cannot be rewritten after the fact.
 *
 * Attempts keep only typed fields: role, provider/model identity, usage and an
 * {@link ModelCallOutcome} whose kind must equal the attempt's role. The store projects each
 * record onto its declared **top-level** fields, so an undeclared field cannot be persisted.
 * Nested values (`usage`, `error`, `outcome`) are stored as canonical JSON and trusted as
 * validated by the model gateway at runtime; storage does not re-validate them field by field.
 */
import { assertIsoTimestamp, canonicalJson, deepFreeze, invariant, type ModelUsage } from '../domain/index.js';
import type {
  AnalyzeOutcome,
  ModelErrorCode,
  ModelGatewayError,
  ReasonOutcome,
  VerifyOutcome,
} from './ports.js';

// ---------------------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------------------

/** Largest batch a caller may declare, even explicitly. */
export const MAX_ANALYSIS_BATCH_JOBS = 100;

/** Default bound on the immutable job/snapshot mapping of one batch. */
export const DEFAULT_ANALYSIS_BATCH_MAX_JOBS = 20;

/** Upper sanity bound for one batch limit value; every limit must be an explicit finite int. */
export const MAX_ANALYSIS_BATCH_LIMIT = 1000;

/** Approved v1 batch defaults: 50 analysis (analyze + verify), 5 reasoning, 2 in flight. */
export const DEFAULT_ANALYSIS_BATCH_LIMITS: AnalysisBatchLimits = deepFreeze({
  maxAnalysisCalls: 50,
  maxReasoningCalls: 5,
  concurrency: 2,
});

export const ANALYSIS_BATCH_STATUSES: readonly AnalysisBatchStatus[] = [
  'pending',
  'running',
  'paused',
  'cancelled',
  'completed',
  'failed',
];

export const MODEL_CALL_ROLES: readonly ModelCallRole[] = ['analysis', 'verification', 'reasoning'];

export const MODEL_CALL_STATUSES: readonly ModelCallStatus[] = ['reserved', 'settled', 'uncertain'];

const MODEL_ERROR_CODES: readonly ModelErrorCode[] = [
  'cancelled',
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'invalid_output',
  'provider_error',
  'unsupported',
];

/** Fields of a batch that are fixed by its first save; changing one is an immutable violation. */
export const ANALYSIS_BATCH_IDENTITY_FIELDS: readonly (keyof AnalysisBatch)[] = [
  'batchId',
  'jobs',
  'maxJobs',
  'createdAt',
];

/** Fields of an attempt that identify the call and its input scope; they never change. */
export const MODEL_CALL_ATTEMPT_IDENTITY_FIELDS: readonly (keyof ModelCallAttempt)[] = [
  'attemptId',
  'batchId',
  'jobId',
  'snapshotId',
  'role',
  'provider',
  'model',
  'promptVersion',
  'requestedAt',
];

// ---------------------------------------------------------------------------------------
// Analysis batch
// ---------------------------------------------------------------------------------------

export type AnalysisBatchStatus = 'pending' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';

/** One job of a batch and the snapshot that job analyses. */
export interface AnalysisBatchJob {
  readonly jobId: string;
  readonly snapshotId: string;
  /**
   * Manual-decision revision of the problem, captured when the batch was prepared.
   *
   * The pipeline re-reads `TrainingStore.getManualRevision` before it adopts a model result
   * and refuses that adoption when the revision changed meanwhile, so a human accept/reject
   * made while the model was running always wins. The field is optional only so records
   * written before it existed can still be read: a batch whose jobs lack it must refuse to
   * execute instead of assuming the current revision.
   */
  readonly manualRevision?: number;
}

/** Explicit call budget of one batch: analysis (analyze + verify) and reasoning are separate. */
export interface AnalysisBatchLimits {
  readonly maxAnalysisCalls: number;
  readonly maxReasoningCalls: number;
  readonly concurrency: number;
}

/** Monotonic call accounting of one batch; a save may never decrease a counter. */
export interface AnalysisBatchCounters {
  readonly analysisCalls: number;
  readonly reasoningCalls: number;
  readonly retries: number;
}

export interface AnalysisBatchError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Durable state of one batch of analysis jobs.
 *
 * `revision` is the optimistic-concurrency token: 0 while the record is still in memory,
 * and the store assigns 1, 2, … as saves land. `owner`/`leaseExpiresAt` are either both set
 * (the batch is `running`) or both `null`; any other shape is rejected.
 */
export interface AnalysisBatch {
  readonly batchId: string;
  readonly jobs: readonly AnalysisBatchJob[];
  readonly maxJobs: number;
  readonly createdAt: string;
  readonly status: AnalysisBatchStatus;
  readonly revision: number;
  readonly owner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly limits: AnalysisBatchLimits;
  readonly counters: AnalysisBatchCounters;
  readonly updatedAt: string;
  readonly lastError: AnalysisBatchError | null;
}

export interface CreateAnalysisBatchInput {
  readonly batchId: string;
  /** Job/snapshot mapping, in caller order; 1..`maxJobs` entries with unique job ids. */
  readonly jobs: readonly AnalysisBatchJob[];
  readonly createdAt: string;
  /** Explicit bound on `jobs`; defaults to {@link DEFAULT_ANALYSIS_BATCH_MAX_JOBS}, max 100. */
  readonly maxJobs?: number;
  /** Partial override of {@link DEFAULT_ANALYSIS_BATCH_LIMITS}; each value is validated. */
  readonly limits?: Partial<AnalysisBatchLimits>;
  readonly status?: AnalysisBatchStatus;
  readonly owner?: string | null;
  readonly leaseExpiresAt?: string | null;
  readonly lastError?: AnalysisBatchError | null;
}

/**
 * Build a validated, frozen batch with the approved defaults.
 *
 * A new batch starts at `status: 'pending'`, `revision: 0` and zero counters; a caller that
 * creates it already running must pass `status`, `owner` and `leaseExpiresAt` together.
 */
export function createAnalysisBatch(input: CreateAnalysisBatchInput): AnalysisBatch {
  const createdAt = assertIsoTimestamp('batch createdAt', input.createdAt);
  const maxJobs = input.maxJobs === undefined ? DEFAULT_ANALYSIS_BATCH_MAX_JOBS : input.maxJobs;
  const batch: AnalysisBatch = {
    batchId: input.batchId,
    jobs: (input.jobs ?? []).map((job) => {
      validateJobManualRevision(job);
      return job.manualRevision === undefined
        ? { jobId: job.jobId, snapshotId: job.snapshotId }
        : { jobId: job.jobId, snapshotId: job.snapshotId, manualRevision: job.manualRevision };
    }),
    maxJobs,
    createdAt,
    status: input.status ?? 'pending',
    revision: 0,
    owner: input.owner ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    limits: {
      maxAnalysisCalls: input.limits?.maxAnalysisCalls ?? DEFAULT_ANALYSIS_BATCH_LIMITS.maxAnalysisCalls,
      maxReasoningCalls: input.limits?.maxReasoningCalls ?? DEFAULT_ANALYSIS_BATCH_LIMITS.maxReasoningCalls,
      concurrency: input.limits?.concurrency ?? DEFAULT_ANALYSIS_BATCH_LIMITS.concurrency,
    },
    counters: { analysisCalls: 0, reasoningCalls: 0, retries: 0 },
    updatedAt: createdAt,
    lastError: input.lastError ?? null,
  };
  validateAnalysisBatch(batch);
  return deepFreeze(batch);
}

/**
 * Validate plain batch data and every boundary before a store writes or accepts it.
 *
 * Timestamps must be ordered: `updatedAt >= createdAt`, and a `running` batch's lease must
 * expire strictly after `updatedAt` (so a live lease always covers the state it guards).
 */
export function validateAnalysisBatch(batch: AnalysisBatch): void {
  invariant(
    batch !== null && typeof batch === 'object',
    'invalid_input',
    'analysis batch must be an object',
    { valueType: typeof batch },
  );
  requireText('batch id', batch.batchId);
  const maxJobs = requireCount('batch maxJobs', batch.maxJobs, 1);
  invariant(
    maxJobs <= MAX_ANALYSIS_BATCH_JOBS,
    'invalid_input',
    `batch maxJobs must be <= ${MAX_ANALYSIS_BATCH_JOBS}`,
    { maxJobs, max: MAX_ANALYSIS_BATCH_JOBS },
  );
  invariant(Array.isArray(batch.jobs), 'invalid_input', 'batch jobs must be an array', {
    batchId: batch.batchId,
  });
  invariant(batch.jobs.length >= 1, 'invalid_input', 'a batch must contain at least one job', {
    batchId: batch.batchId,
  });
  invariant(
    batch.jobs.length <= maxJobs,
    'invalid_input',
    `batch ${batch.batchId} lists ${batch.jobs.length} jobs but its bound is ${maxJobs}`,
    { batchId: batch.batchId, jobs: batch.jobs.length, maxJobs },
  );
  const jobIds = new Set<string>();
  for (const job of batch.jobs) {
    const jobId = requireText('batch job id', job?.jobId);
    requireText('batch job snapshot id', job?.snapshotId);
    invariant(!jobIds.has(jobId), 'duplicate_id', `batch ${batch.batchId} lists job ${jobId} more than once`, {
      batchId: batch.batchId,
      jobId,
    });
    jobIds.add(jobId);
  }
  assertIsoTimestamp('batch createdAt', batch.createdAt);
  assertIsoTimestamp('batch updatedAt', batch.updatedAt);
  invariant(
    instant(batch.updatedAt) >= instant(batch.createdAt),
    'invalid_input',
    `batch ${batch.batchId} updatedAt must not precede createdAt`,
    { batchId: batch.batchId, createdAt: batch.createdAt, updatedAt: batch.updatedAt },
  );
  invariant(
    ANALYSIS_BATCH_STATUSES.includes(batch.status),
    'invalid_input',
    `unknown batch status ${String(batch.status)}`,
    { status: batch.status },
  );
  requireCount('batch revision', batch.revision, 0);
  requireLimit('batch maxAnalysisCalls', batch.limits?.maxAnalysisCalls, 0);
  requireLimit('batch maxReasoningCalls', batch.limits?.maxReasoningCalls, 0);
  requireLimit('batch concurrency', batch.limits?.concurrency);
  requireCount('batch analysisCalls', batch.counters?.analysisCalls, 0);
  requireCount('batch reasoningCalls', batch.counters?.reasoningCalls, 0);
  requireCount('batch retries', batch.counters?.retries, 0);
  validateBatchLease(batch);
  validateBatchError(batch.lastError);
}

/**
 * Validate an update against the stored record: identity is fixed, counters are monotonic and
 * a terminal (`completed`/`cancelled`) batch cannot leave its end state. Raising limits and
 * resuming a paused batch are legal and keep the recorded counters.
 */
export function validateAnalysisBatchTransition(previous: AnalysisBatch, next: AnalysisBatch): void {
  validateAnalysisBatch(previous);
  validateAnalysisBatch(next);
  invariant(
    previous.batchId === next.batchId &&
      previous.createdAt === next.createdAt &&
      previous.maxJobs === next.maxJobs &&
      canonicalJson(previous.jobs) === canonicalJson(next.jobs),
    'immutable_violation',
    `batch ${previous.batchId} already exists with a different identity`,
    { batchId: previous.batchId },
  );
  if (previous.status === 'completed' || previous.status === 'cancelled') {
    invariant(
      next.status === previous.status,
      'invalid_transition',
      `batch ${previous.batchId} is ${previous.status} and cannot leave that state`,
      { batchId: previous.batchId, previousStatus: previous.status, status: next.status },
    );
  }
  for (const name of ['analysisCalls', 'reasoningCalls', 'retries'] as const) {
    invariant(
      next.counters[name] >= previous.counters[name],
      'invalid_transition',
      `batch ${previous.batchId} would decrease ${name}`,
      { batchId: previous.batchId, name, previous: previous.counters[name], next: next.counters[name] },
    );
  }
}

function validateBatchLease(batch: AnalysisBatch): void {
  if (batch.status === 'running') {
    requireText('running batch owner', batch.owner);
    const leaseExpiresAt = requireText('running batch leaseExpiresAt', batch.leaseExpiresAt);
    assertIsoTimestamp('running batch leaseExpiresAt', leaseExpiresAt);
    invariant(
      instant(leaseExpiresAt) > instant(batch.updatedAt),
      'invalid_input',
      `running batch ${batch.batchId} leaseExpiresAt must be after updatedAt`,
      { batchId: batch.batchId, updatedAt: batch.updatedAt, leaseExpiresAt },
    );
    return;
  }
  invariant(
    batch.owner === null && batch.leaseExpiresAt === null,
    'invalid_input',
    `a ${batch.status} batch must not hold a lease`,
    { batchId: batch.batchId, status: batch.status, owner: batch.owner, leaseExpiresAt: batch.leaseExpiresAt },
  );
}

function validateBatchError(error: AnalysisBatchError | null): void {
  if (error === null) {
    return;
  }
  requireText('batch error code', error?.code);
  requireText('batch error message', error?.message);
  invariant(typeof error.retryable === 'boolean', 'invalid_input', 'batch error retryable must be boolean', {
    retryable: error?.retryable,
  });
}

// ---------------------------------------------------------------------------------------
// Model-call attempts
// ---------------------------------------------------------------------------------------

/** Which model role produced an attempt: `analysis`, independent `verification`, or `reasoning`. */
export type ModelCallRole = 'analysis' | 'verification' | 'reasoning';

/**
 * Lifecycle of one model call.
 *
 * `reserved` is written before dispatch; `uncertain` means the call was dispatched but its
 * result (and possibly its cost) is not known; `settled` means the record is final.
 */
export type ModelCallStatus = 'reserved' | 'settled' | 'uncertain';

/**
 * Typed result of a settled attempt. `kind` must equal the attempt's `role`, so a verification
 * outcome can never be filed against a reasoning call (and vice versa).
 */
export type ModelCallOutcome =
  | { readonly kind: 'analysis'; readonly value: AnalyzeOutcome }
  | { readonly kind: 'verification'; readonly value: VerifyOutcome }
  | { readonly kind: 'reasoning'; readonly value: ReasonOutcome };

/**
 * Durable audit row for one model call.
 *
 * The row is written `reserved` before dispatch (inside the caller's transaction, together
 * with the job/batch counter bump), then settled with the typed outcome *or* a typed error
 * plus usage when the gateway reported it. `hostSessionId`/`hostCallId` stay nullable until
 * the host exposes them, which is what lets runtime recovery correlate a call after a crash.
 */
export interface ModelCallAttempt {
  readonly attemptId: string;
  readonly batchId: string;
  readonly jobId: string;
  readonly snapshotId: string;
  readonly role: ModelCallRole;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly requestedAt: string;
  readonly finishedAt: string | null;
  readonly status: ModelCallStatus;
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
  readonly usage: ModelUsage | null;
  readonly error: ModelGatewayError | null;
  readonly outcome: ModelCallOutcome | null;
}

/** Which model calls to read back; unset scope means "all of them". */
export interface ModelCallAttemptQuery {
  readonly batchId?: string | null;
  readonly jobId?: string | null;
  readonly status?: ModelCallStatus | null;
}

/**
 * Which batch budget a role consumes: `analyze` and `verify` share the analysis budget,
 * `reasoning` has its own. Reservation itself is enforced by the pipeline, not here.
 */
export function budgetKindOfRole(role: ModelCallRole): 'analysis' | 'reasoning' {
  return role === 'reasoning' ? 'reasoning' : 'analysis';
}

/** Validate plain attempt data, its status shape and its role/outcome match. */
export function validateModelCallAttempt(attempt: ModelCallAttempt): void {
  invariant(
    attempt !== null && typeof attempt === 'object',
    'invalid_input',
    'model call attempt must be an object',
    { valueType: typeof attempt },
  );
  requireText('attempt id', attempt.attemptId);
  requireText('attempt batch id', attempt.batchId);
  requireText('attempt job id', attempt.jobId);
  requireText('attempt snapshot id', attempt.snapshotId);
  invariant(
    MODEL_CALL_ROLES.includes(attempt.role),
    'invalid_input',
    `unknown model call role ${String(attempt.role)}`,
    { role: attempt.role },
  );
  requireText('attempt provider', attempt.provider);
  requireText('attempt model', attempt.model);
  requireText('attempt promptVersion', attempt.promptVersion);
  assertIsoTimestamp('attempt requestedAt', attempt.requestedAt);
  if (attempt.finishedAt !== null) {
    assertIsoTimestamp('attempt finishedAt', attempt.finishedAt);
    invariant(
      instant(attempt.finishedAt) >= instant(attempt.requestedAt),
      'invalid_input',
      `attempt ${attempt.attemptId} finishedAt must not precede requestedAt`,
      { attemptId: attempt.attemptId, requestedAt: attempt.requestedAt, finishedAt: attempt.finishedAt },
    );
  }
  invariant(
    MODEL_CALL_STATUSES.includes(attempt.status),
    'invalid_input',
    `unknown model call status ${String(attempt.status)}`,
    { status: attempt.status },
  );
  requireOptionalText('attempt hostSessionId', attempt.hostSessionId);
  requireOptionalText('attempt hostCallId', attempt.hostCallId);
  if (attempt.usage !== null) {
    validateUsage(attempt.usage);
  }
  if (attempt.error !== null) {
    validateModelError(attempt.error);
  }
  validateOutcomeMatch(attempt);
  if (attempt.status === 'reserved') {
    invariant(
      attempt.finishedAt === null && attempt.usage === null && attempt.error === null && attempt.outcome === null,
      'invalid_input',
      `reserved attempt ${attempt.attemptId} must not carry a result`,
      { attemptId: attempt.attemptId },
    );
    return;
  }
  if (attempt.status === 'uncertain') {
    invariant(
      attempt.outcome === null,
      'invalid_input',
      `uncertain attempt ${attempt.attemptId} must not carry an outcome`,
      { attemptId: attempt.attemptId },
    );
    return;
  }
  invariant(
    attempt.finishedAt !== null,
    'invalid_input',
    `settled attempt ${attempt.attemptId} requires finishedAt`,
    { attemptId: attempt.attemptId },
  );
  invariant(
    (attempt.outcome === null) !== (attempt.error === null),
    'invalid_input',
    `settled attempt ${attempt.attemptId} must record exactly one of outcome or error`,
    { attemptId: attempt.attemptId, hasOutcome: attempt.outcome !== null, hasError: attempt.error !== null },
  );
}

/**
 * Validate one save of an existing attempt.
 *
 * Identity, model and input scope are immutable; a settled row is immutable entirely (an
 * identical re-save is handled by the caller as a no-op before this check). A host
 * correlation that is already known (`hostSessionId`/`hostCallId` non-null) is a recorded
 * fact: a later settlement may not reassign or clear it, so a wrong settlement cannot be
 * filed against a host call that is not the one reserved. The lifecycle only moves forward,
 * so nothing ever returns to `reserved`.
 */
export function validateModelCallAttemptTransition(previous: ModelCallAttempt, next: ModelCallAttempt): void {
  validateModelCallAttempt(previous);
  validateModelCallAttempt(next);
  const changed = MODEL_CALL_ATTEMPT_IDENTITY_FIELDS.filter((field) => {
    const before = previous[field];
    const after = next[field];
    return typeof before === 'object' || typeof after === 'object'
      ? canonicalJson(before) !== canonicalJson(after)
      : before !== after;
  });
  invariant(
    changed.length === 0,
    'immutable_violation',
    `attempt ${previous.attemptId} already exists with a different ${changed.join(', ')}`,
    { attemptId: previous.attemptId, conflicts: changed },
  );
  for (const field of ['hostSessionId', 'hostCallId'] as const) {
    const known = previous[field];
    invariant(
      known === null || next[field] === known,
      'immutable_violation',
      `attempt ${previous.attemptId} already records ${field} ${known}; a known host correlation cannot be reassigned or cleared`,
      { attemptId: previous.attemptId, field, previous: known, next: next[field], reason: 'host_correlation' },
    );
  }
  invariant(
    previous.status !== 'settled',
    'immutable_violation',
    `settled attempt ${previous.attemptId} cannot be rewritten`,
    { attemptId: previous.attemptId },
  );
  const allowed: readonly ModelCallStatus[] =
    previous.status === 'reserved' ? ['reserved', 'uncertain', 'settled'] : ['uncertain', 'settled'];
  invariant(
    allowed.includes(next.status),
    'invalid_transition',
    `attempt ${previous.attemptId} cannot move from ${previous.status} to ${next.status}`,
    { attemptId: previous.attemptId, previousStatus: previous.status, status: next.status },
  );
}

function validateOutcomeMatch(attempt: ModelCallAttempt): void {
  const outcome = attempt.outcome;
  if (outcome === null || outcome === undefined) {
    return;
  }
  invariant(
    outcome !== null && typeof outcome === 'object',
    'invalid_input',
    'attempt outcome must be an object',
    { attemptId: attempt.attemptId, valueType: typeof outcome },
  );
  invariant(
    outcome.kind === attempt.role,
    'invalid_input',
    `attempt ${attempt.attemptId} has role ${attempt.role} but stores a ${String(outcome.kind)} outcome`,
    { attemptId: attempt.attemptId, role: attempt.role, kind: outcome.kind },
  );
  const value: unknown = outcome.value;
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `attempt ${attempt.attemptId} outcome payload must be an object`,
    { attemptId: attempt.attemptId, role: attempt.role },
  );
  if (outcome.kind === 'analysis') {
    invariant(
      Array.isArray((value as AnalyzeOutcome).suggestions),
      'invalid_input',
      `analysis outcome of attempt ${attempt.attemptId} requires suggestions`,
      { attemptId: attempt.attemptId },
    );
  } else if (outcome.kind === 'verification') {
    invariant(
      Array.isArray((value as VerifyOutcome).verifications),
      'invalid_input',
      `verification outcome of attempt ${attempt.attemptId} requires verifications`,
      { attemptId: attempt.attemptId },
    );
  } else {
    invariant(
      Array.isArray((value as ReasonOutcome).drafts),
      'invalid_input',
      `reasoning outcome of attempt ${attempt.attemptId} requires drafts`,
      { attemptId: attempt.attemptId },
    );
  }
}

function validateUsage(usage: ModelUsage): void {
  requireCount('usage calls', usage?.calls, 0);
  requireCount('usage promptTokens', usage?.promptTokens, 0);
  requireCount('usage completionTokens', usage?.completionTokens, 0);
  requireCount('usage totalTokens', usage?.totalTokens, 0);
}

function validateModelError(error: ModelGatewayError): void {
  invariant(
    MODEL_ERROR_CODES.includes(error?.code),
    'invalid_input',
    `unknown model error code ${String(error?.code)}`,
    { code: error?.code },
  );
  requireText('model error message', error?.message);
  invariant(typeof error.retryable === 'boolean', 'invalid_input', 'model error retryable must be boolean', {
    retryable: error?.retryable,
  });
}

// ---------------------------------------------------------------------------------------
// Shared field checks
// ---------------------------------------------------------------------------------------

/** Epoch milliseconds of an already-validated ISO timestamp, for ordering checks. */
function instant(value: string): number {
  return Date.parse(value);
}

function requireText(label: string, value: unknown): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} is required`,
    { label, value },
  );
  return value;
}

function requireOptionalText(label: string, value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireText(label, value);
}

function requireCount(label: string, value: unknown, min: number): number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value >= min,
    'invalid_input',
    `${label} must be an integer >= ${min}`,
    { label, value },
  );
  return value;
}

function requireLimit(label: string, value: unknown, min=1): number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_ANALYSIS_BATCH_LIMIT,
    'invalid_input',
    `${label} must be an explicit integer within ${min}..${MAX_ANALYSIS_BATCH_LIMIT}`,
    { label, value },
  );
  return value;
}

/**
 * Validate the optional captured manual revision of one batch job.
 *
 * `undefined` is tolerated (legacy record); anything else must be a non-negative integer, so
 * a malformed value can never be stored as if it were a real captured revision.
 */
function validateJobManualRevision(job: AnalysisBatchJob): void {
  const manualRevision = job?.manualRevision;
  invariant(
    manualRevision === undefined ||
      (typeof manualRevision === 'number' && Number.isInteger(manualRevision) && manualRevision >= 0),
    'invalid_input',
    `batch job ${String(job?.jobId)} manualRevision must be a non-negative integer when present`,
    { jobId: job?.jobId, manualRevision },
  );
}
