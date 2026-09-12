/**
 * Browser-safe contracts of the owned model operations (Stage 4h2a).
 *
 * One module owns every request and answer of the controller — batch prepare/run/resume/pause/
 * cancel/recover/detail/list, workbench settings save/read, and the coaching start/status/history/
 * cancel group — so the HTTP registration of Stage 4h2b binds these types directly, without a
 * second vocabulary, and the browser half imports exactly the same shapes.
 *
 * Three rules shape every DTO:
 *
 * - **Progress is metadata.** No batch view carries a model outcome, an editorial excerpt, an
 *   analysis suggestion or a reasoning draft; an attempt view keeps its identity, status, usage and
 *   a stable error *code*, never the provider's message. A coaching start view never carries the
 *   hint text: a body is readable only through the coaching reads with their explicit visibility
 *   flags.
 * - **Unknown cost stays unknown.** `usage: null` plus a separate `uncertainAttempts` count is how a
 *   dispatched call whose provider reported no usage is reported; it is never folded into a sum.
 * - **Absent members are omitted.** A member is either present with a real value (`null` where the
 *   domain says "none") or not present at all, because the accepted serializer refuses an own
 *   `undefined` member instead of dropping it silently.
 *
 * The module is plain types, fixed bounds and one error class; it has no runtime dependency on a
 * store, a pipeline, a service or a provider.
 */
import type { AnalysisJobCounters, AnalysisJobStatus, ModelUsage } from '../domain/index.js';
import type {
  AnalysisBatchCounters,
  AnalysisBatchLimits,
  AnalysisBatchStatus,
  ModelCallRole,
  ModelCallStatus,
} from './batch-types.js';
import type { CoachingHistoryResult, CoachingStatusResult } from './coaching-service.js';
import type { CoachingLevel, CoachingStatus } from './coaching-types.js';
import type { WorkbenchSettings } from './workbench-settings.js';

// ---------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------

/** Largest accepted `batch.prepare.problemKeys` list. */
export const MAX_MODEL_BATCH_PROBLEMS = 100;
/** Default job/snapshot bound of one prepared batch, and its hard maximum. */
export const DEFAULT_MODEL_BATCH_MAX_JOBS = 20;
/** Largest number of batch summaries `batch.list` returns. */
export const MAX_MODEL_BATCH_LIST_ITEMS = 100;
/** Largest stored batch population one `batch.list` may scan before refusing. */
export const MAX_MODEL_BATCH_POPULATION = 5000;
/**
 * Largest attempt history one batch projection may read.
 *
 * More attempts are refused (`history_overflow`) instead of being truncated: a partial projection
 * would report a batch as cheaper or smaller than it really is.
 */
export const MAX_MODEL_ATTEMPT_HISTORY = 10_000;
/** Reserved coaching reservations inspected per page while checking persisted activity. */
export const MODEL_RESERVATION_PAGE_SIZE = 500;
/** Pages of reserved coaching reservations inspected before the activity check refuses. */
export const MAX_MODEL_RESERVATION_PAGES = 20;
/** Settled owned operations retained per kind for status reads (oldest settled are dropped). */
export const MAX_SETTLED_MODEL_OPERATIONS = 100;
/** Default bounded wait of {@link import('../plugin/model-operations.js').ModelOperations.close}. */
export const DEFAULT_MODEL_CLOSE_WAIT_MS = 5000;

// ---------------------------------------------------------------------------------------
// Validation diagnostics
// ---------------------------------------------------------------------------------------

/** Severities a model-metadata diagnostic may carry; only `error` blocks a start. */
export const MODEL_DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export type ModelDiagnosticSeverity = (typeof MODEL_DIAGNOSTIC_SEVERITIES)[number];

/** Roles a diagnostic may name, including the coaching model which no batch role uses. */
export const MODEL_DIAGNOSTIC_ROLES = ['analysis', 'verification', 'reasoning', 'coaching'] as const;
export type ModelDiagnosticRole = (typeof MODEL_DIAGNOSTIC_ROLES)[number];

/**
 * One advisory or blocking statement about the configured provider/model metadata.
 *
 * Application-owned and narrowed on purpose: the host's catalog probe may know provider-specific
 * fields, but only these fixed members travel, so an unknown host object can neither be spread into
 * a response nor smuggle a credential, endpoint or raw provider payload through it.
 */
export interface ModelValidationDiagnostic {
  readonly code: string;
  readonly severity: ModelDiagnosticSeverity;
  readonly message: string;
  readonly role?: ModelDiagnosticRole;
  readonly model?: string;
}

// ---------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------

/** Stable refusal codes the controller throws; Stage 4h2b maps them onto transport statuses. */
export type ModelOperationErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'settings_changed'
  | 'model_busy'
  | 'model_invalid'
  | 'history_overflow'
  | 'cancelled'
  | 'internal';

/**
 * Typed refusal of one controller operation.
 *
 * The message is always a fixed, safe sentence: no request content, model id, provider string,
 * store path or stack ever travels through it. Blocking model diagnostics are attached as data so
 * the UI can render them without parsing prose.
 */
export class ModelOperationError extends Error {
  readonly code: ModelOperationErrorCode;
  readonly retryable: boolean;
  readonly diagnostics: readonly ModelValidationDiagnostic[] | null;

  constructor(
    code: ModelOperationErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly diagnostics?: readonly ModelValidationDiagnostic[];
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelOperationError';
    this.code = code;
    this.retryable = options.retryable ?? (code === 'model_busy' || code === 'settings_changed');
    this.diagnostics = options.diagnostics ?? null;
  }
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

/** `settings.save` request: the CAS revision the caller read, and the complete new value. */
export interface ModelSettingsSaveRequest {
  /** `null` only for the first save (stored as revision 1); otherwise the revision just read. */
  readonly expectedRevision: number | null;
  readonly value: WorkbenchSettings;
}

/** Effective settings plus the revision a caller must echo back; `null` means built-in defaults. */
export interface ModelCurrentSettings {
  readonly revision: number | null;
  readonly value: WorkbenchSettings;
}

/** Answer of one accepted settings save: the new revision, the stored value and the diagnostics. */
export interface ModelSettingsSaveResult {
  readonly revision: number;
  readonly value: WorkbenchSettings;
  readonly diagnostics: readonly ModelValidationDiagnostic[];
}

// ---------------------------------------------------------------------------------------
// Batch requests
// ---------------------------------------------------------------------------------------

export interface ModelBatchPrepareRequest {
  /** Canonical problem keys, 1..{@link MAX_MODEL_BATCH_PROBLEMS}, all distinct. */
  readonly problemKeys: readonly string[];
  /** Job/snapshot bound of the prepared batch; defaults to {@link DEFAULT_MODEL_BATCH_MAX_JOBS}. */
  readonly maxJobs?: number;
}

export interface ModelBatchRunRequest {
  readonly batchId: string;
  /** Strictly positive settings revision the run is validated and executed against. */
  readonly expectedSettingsRevision: number;
}

export interface ModelBatchResumeRequest {
  readonly batchId: string;
  readonly expectedSettingsRevision: number;
}

export interface ModelBatchIdRequest {
  readonly batchId: string;
}

export interface ModelBatchRecoverRequest {
  /** `null`/absent recovers every non-terminal batch; a string recovers exactly that one. */
  readonly batchId?: string | null;
}

export interface ModelBatchListRequest {
  /** How many summaries to return, 1..{@link MAX_MODEL_BATCH_LIST_ITEMS}. */
  readonly limit?: number;
}

// ---------------------------------------------------------------------------------------
// Batch answers
// ---------------------------------------------------------------------------------------

/** Model ids one start executes with; provider identity is separate and never a credential. */
export interface ModelRoleModels {
  readonly analysis: string;
  readonly verification: string;
  readonly reasoning: string;
}

/** One job of a freshly prepared batch: identity only, never snapshot content. */
export interface ModelBatchPreparedJobView {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly problemKey: string;
}

/** A job that was already finished when the batch was prepared; it is never reset. */
export interface ModelBatchJobSummary {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly status: AnalysisJobStatus;
  readonly analysisId: string | null;
}

/**
 * Spoiler-free availability of the requested material.
 *
 * `ready` means a usable editorial exists, `absent` means every source explicitly reported absence
 * (the expensive reasoning role may run), and `error` groups everything that must not be treated as
 * absence — an operational source failure, a missing statement or an unknown source set.
 */
export interface ModelBatchAvailabilitySummary {
  readonly ready: number;
  readonly absent: number;
  readonly error: number;
}

/**
 * Conservative upper bound on the paid calls one prepared batch can ever dispatch.
 *
 * This is the batch's own quota, not an estimate of what it will spend. Every dispatch — retries
 * included — reserves and counts against the batch limits, so `maxAnalysisCalls` (analysis plus
 * verification) and `maxReasoningCalls` are hard maxima; a batch without jobs is never run and is
 * bounded by zero.
 */
export interface ModelBatchCallUpperBound {
  readonly analysisCalls: number;
  readonly reasoningCalls: number;
}

export interface ModelBatchPrepareResult {
  /** `null` when every requested job was already done, so no batch was created. */
  readonly batchId: string | null;
  /** Revision of the settings record the batch captured; `null` for built-in defaults. */
  readonly settingsRevision: number | null;
  readonly provider: string;
  readonly models: ModelRoleModels;
  /** Limits persisted onto the new batch (the batch's own defaults when it is `null`). */
  readonly limits: AnalysisBatchLimits;
  readonly upperBoundCalls: ModelBatchCallUpperBound;
  readonly availability: ModelBatchAvailabilitySummary;
  readonly jobs: readonly ModelBatchPreparedJobView[];
  readonly alreadyDone: readonly ModelBatchJobSummary[];
}

/** Acknowledgement of one accepted background batch start; the run itself is owned by the controller. */
export interface ModelBatchStartResult {
  readonly batchId: string;
  readonly operationId: string;
  readonly settingsRevision: number;
  readonly provider: string;
  readonly models: ModelRoleModels;
  readonly limits: AnalysisBatchLimits;
}

/** Result of an explicit pause/cancel: the persisted state that was written. */
export interface ModelBatchControlResult {
  readonly batchId: string;
  readonly status: AnalysisBatchStatus;
  readonly counters: AnalysisBatchCounters;
}

/** One batch recovered by an explicit `batch.recover`; nothing is refunded or auto-run. */
export interface ModelBatchRecoveredBatchView {
  readonly batchId: string;
  readonly status: AnalysisBatchStatus;
  readonly requeuedJobs: number;
  readonly uncertainAttempts: number;
  /** `live_lease` when another owner still holds the batch; `null` when it was recovered. */
  readonly skipped: string | null;
}

export interface ModelBatchRecoverResult {
  readonly batches: readonly ModelBatchRecoveredBatchView[];
}

/**
 * Redacted projection of one durable model call.
 *
 * Identity, lifecycle, usage and a stable error code only: the typed outcome, the provider's error
 * message and every analysis input stay in the store.
 */
export interface ModelAttemptView {
  readonly attemptId: string;
  readonly role: ModelCallRole;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly status: ModelCallStatus;
  readonly requestedAt: string;
  readonly finishedAt: string | null;
  readonly hostSessionId: string | null;
  readonly hostCallId: string | null;
  readonly usage: ModelUsage | null;
  readonly errorCode: string | null;
}

/** Redacted progress of one analysis job; `null` members mean the durable row is not readable. */
export interface ModelBatchJobView {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly problemKey: string | null;
  readonly status: AnalysisJobStatus | null;
  readonly attempts: number | null;
  readonly counters: AnalysisJobCounters | null;
  readonly analysisId: string | null;
  /** Sum of the job's persisted **settled** attempts; `null` when no usage is known. */
  readonly usage: ModelUsage | null;
  /** Dispatched calls whose cost the provider never reported; counted, never estimated. */
  readonly uncertainAttempts: number;
  readonly errorCode: string | null;
  readonly updatedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly calls: readonly ModelAttemptView[];
}

/** Redacted projection of one durable batch, including its jobs and their call audit. */
export interface ModelBatchView {
  readonly batchId: string;
  readonly status: AnalysisBatchStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly maxJobs: number;
  readonly limits: AnalysisBatchLimits;
  readonly counters: AnalysisBatchCounters;
  readonly uncertainAttempts: number;
  readonly lastErrorCode: string | null;
  readonly jobs: readonly ModelBatchJobView[];
}

/** Batch-level summary of a list page; the per-job projection belongs to `batch.detail`. */
export interface ModelBatchSummaryView {
  readonly batchId: string;
  readonly status: AnalysisBatchStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly maxJobs: number;
  readonly jobCount: number;
  readonly limits: AnalysisBatchLimits;
  readonly counters: AnalysisBatchCounters;
  readonly lastErrorCode: string | null;
}

export interface ModelBatchListResult {
  /** Latest batches first, at most {@link MAX_MODEL_BATCH_LIST_ITEMS}. */
  readonly items: readonly ModelBatchSummaryView[];
  /** Size of the stored batch population the page was taken from. */
  readonly total: number;
}

/** Owned background work this plugin instance is running, or last ran, for one key. */
export const MODEL_OPERATION_NAMES = ['batch.run', 'batch.resume', 'coaching.ask'] as const;
export type ModelOperationName = (typeof MODEL_OPERATION_NAMES)[number];

export interface ModelOperationStatusView {
  readonly operationId: string;
  readonly operation: ModelOperationName;
  readonly state: 'running' | 'settled';
  readonly startedAt: string;
  readonly settledAt: string | null;
  /** Stable code of the background failure, or `null` when the operation completed normally. */
  readonly errorCode: string | null;
}

export interface ModelBatchDetailResult {
  readonly batch: ModelBatchView;
  /** This instance's own view of the batch's run, or `null` when it never owned one. */
  readonly operation: ModelOperationStatusView | null;
}

// ---------------------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------------------

export interface ModelCoachingAskRequest {
  /** Caller-owned idempotency key: repeating it never pays for a second call. */
  readonly requestId: string;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
  readonly explicitFullSolution?: boolean;
  /** Strictly positive settings revision a **new** reservation is validated against. */
  readonly expectedSettingsRevision: number;
}

/**
 * Metadata-only view of one coaching request.
 *
 * It never carries the hint text: the answer body is readable through `coaching.status`/`history`
 * with `includeResponseText` for exactly one level. `operationId` is `null` when the request was
 * answered from an already durable attempt rather than owned background work, and `settingsRevision`
 * is `null` whenever this call did not capture settings (a free replay).
 */
export interface ModelCoachingAskResult {
  readonly requestId: string;
  readonly operationId: string | null;
  readonly state: 'running' | 'settled';
  readonly status: 'answered' | 'pending' | 'refused' | 'failed' | 'uncertain';
  readonly attemptId: string | null;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
  readonly snapshotId: string | null;
  readonly snapshotState: 'current' | 'stale' | 'unknown';
  readonly usage: ModelUsage | null;
  readonly errorCode: string | null;
  readonly retryable: boolean | null;
  readonly settingsRevision: number | null;
  readonly startedAt: string | null;
  readonly settledAt: string | null;
}

/** `coaching.status`: metadata unless one level's body is explicitly requested. */
export interface ModelCoachingStatusRequest {
  readonly requestId: string;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly includeResponseText?: boolean;
  /** Only meaningful together with `includeResponseText`; stale answers stay hidden by default. */
  readonly includeStale?: boolean;
}

/**
 * `coaching.status` answer: the durable status plus this instance's own operation view.
 *
 * `operation` reports work this instance acknowledged even when no durable row exists yet (an
 * active pre-reservation, a terminal refusal, a background failure). It is `null` when this
 * instance never started the request, or when the caller's account/problem is not exactly the
 * identity it was started for — one account never reads another's operation state. The answer body
 * stays service-controlled: only the durable reads with their explicit spoiler flags carry it.
 */
export type ModelCoachingStatusResult = CoachingStatusResult & {
  readonly operation: ModelCoachingAskResult | null;
};

/** `coaching.history`: metadata pages unless one level's body is explicitly requested. */
export interface ModelCoachingHistoryRequest {
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level?: CoachingLevel | null;
  readonly includeResponseText?: boolean;
  readonly includeStale?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export type ModelCoachingHistoryResult = CoachingHistoryResult;

export interface ModelCoachingCancelRequest {
  readonly requestId: string;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
}

/**
 * Result of one cancellation attempt.
 *
 * `cancelled: true` means this instance cancelled its own live operation. `cancelled: false` with a
 * known `status` means the attempt belongs to someone else (another process, or a request that
 * already settled): it is reported, never refunded and never rewritten as cancelled.
 */
export interface ModelCoachingCancelResult {
  readonly requestId: string;
  readonly cancelled: boolean;
  readonly status: 'unknown' | CoachingStatus;
}

// ---------------------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------------------

/**
 * Report of one bounded disposal.
 *
 * `outstanding` lists the owned operations that did not settle within the wait; the caller must keep
 * the store open until {@link import('../plugin/model-operations.js').ModelOperations.whenSettled}
 * resolves, because their durable settlement is still in flight.
 */
export interface ModelOperationCloseReport {
  readonly settled: readonly string[];
  readonly outstanding: readonly string[];
}
