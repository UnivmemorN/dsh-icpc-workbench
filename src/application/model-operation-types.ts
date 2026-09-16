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
import type {
  PlanAttemptRequest,
  PlanHistoryRequest,
  PlanPrepareRequest,
  PlanPrepareResult,
  PlanRunRequest,
  PlanningAttemptView,
} from './planning-service.js';
import type { PlanAttemptStatus } from './planning-types.js';
import type { WorkbenchSettings } from './workbench-settings.js';
import type { WorkbenchPlanView } from './workbench-types.js';

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
  /**
   * The selected material or a stored batch's material is not runnable (Sprint 33A).
   *
   * A start is refused with this code *before* any model availability probe, owned operation,
   * attempt reservation or counter movement, so an old batch that references a blocked snapshot
   * cannot dispatch a paid call — and refreshing the problem's material later cannot revive it,
   * because the batch keeps referring to the immutable snapshot it captured. The caller has to
   * refresh or supplement the material and prepare a **new** batch, which is what the UI says.
   */
  | 'materials_blocked'
  | 'cancelled'
  /**
   * The operation is intentionally not installed in this host composition. AI planning is optional
   * only so an old isolated controller fixture still composes; host composition always installs it,
   * and a UI that receives this code must render "unavailable" instead of retrying.
   */
  | 'unavailable'
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
  /**
   * Explicit rerun request; defaults to `false`.
   *
   * `false` is the ordinary "补齐尚未通过完整性检查的题目" mode: a snapshot is skipped only while
   * its stored success carries a *current* completeness check for the current snapshot and
   * taxonomy. `true` creates a new run identity even for an already checked result, keeping the
   * old job, analysis and decision history immutable while the rerun corrects them.
   */
  readonly reanalyze?: boolean;
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
  /** Why it was skipped: its stored success carries the current completeness check. */
  readonly completeness: 'current';
}

/** A finished job that this prepare superseded with a new run identity. */
export interface ModelBatchRerunView {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly previousJobId: string;
  readonly previousStatus: AnalysisJobStatus;
  /**
   * `legacy_unchecked` (stored before/without the current check), `cancelled_run` (the old
   * cancelled run stays immutable) or `reanalyze_requested` (explicit force rerun).
   */
  readonly reason: 'legacy_unchecked' | 'cancelled_run' | 'reanalyze_requested';
}

/**
 * One selected problem or unfinished job whose **current material is not runnable**.
 *
 * It is reported explicitly instead of silently dropping it, rejecting the whole selection or
 * fabricating an empty snapshot: no job is created and no model call is made for it, so a blocked
 * problem consumes no quota, writes no attempt and produces no audit record. A metadata-only
 * snapshot is deliberately **not** fabricated, because an empty snapshot would claim that material
 * was captured when nothing was.
 *
 * The reason is a stable code, never the classifier's English diagnostic: an unknown source set
 * (`editorial_unknown`) is *not* an absence, a found source without body is not material a model may
 * reason over, and an operational failure is never evidence that no editorial exists. The action is
 * the one entry point that can fix it, and it either requests platform material
 * (`refresh_materials`, no model call) or writes a locally provided body (`supplement_*`, no model
 * call). Neither action may claim a platform editorial that was not retrieved.
 */
export interface ModelBatchBlockedProblemView {
  readonly problemKey: string;
  readonly reason:
    | 'material_missing'
    | 'snapshot_unreadable'
    | 'editorial_unknown'
    | 'editorial_empty'
    | 'source_unavailable'
    | 'missing_statement';
  readonly action: 'refresh_materials' | 'supplement_editorial' | 'supplement_statement';
}

/**
 * Spoiler-free availability of the requested material.
 *
 * `ready` means a usable editorial exists, `absent` means every source explicitly reported absence
 * (the expensive reasoning role may run), and `error` groups everything that must not be treated as
 * absence — an operational source failure, a missing statement, an unknown source set, a missing
 * snapshot head and an unreadable snapshot body. `ready + absent + error` is the whole selection,
 * and every non-`ready`/non-`absent` problem also appears in `blocked`.
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
 * bounded by zero. `blocked` is the number of selected problems that were *not* turned into jobs
 * because their material is not runnable; it is reported next to the bound so "20 selected" can
 * never be read as "20 new tasks", and it contributes nothing to either maximum.
 */
export interface ModelBatchCallUpperBound {
  readonly analysisCalls: number;
  readonly reasoningCalls: number;
  readonly blocked: number;
}

export interface ModelBatchPrepareResult {
  /** `null` when no runnable job was produced, so no batch was created and nothing can be paid for. */
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
  /** Finished jobs this prepare replaced with a fresh run identity; old history is untouched. */
  readonly reruns: readonly ModelBatchRerunView[];
  /**
   * Selected problems whose material is not runnable; never silently dropped, never paid for.
   *
   * A fresh material state produces a *new* snapshot, so a problem listed here has to be prepared
   * again after refreshing or supplementing it: an old batch can never be repaired in place.
   */
  readonly blocked: readonly ModelBatchBlockedProblemView[];
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
  /**
   * Read-only material preflight of this batch's **own** immutable snapshots.
   *
   * It is computed while the detail is projected and writes nothing: a batch stored by an earlier
   * version may already reference a snapshot that cannot be analysed, and reporting that here is
   * how the UI can disable "start"/"resume" before a paid call is attempted. Refreshing a problem's
   * material produces a new snapshot and therefore never clears this list — the batch keeps the
   * material it captured, so the only fix is a new free preparation of the refreshed problem.
   */
  readonly materialBlocks: readonly ModelBatchBlockedProblemView[];
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
export const MODEL_OPERATION_NAMES = ['batch.run', 'batch.resume', 'coaching.ask', 'plan.aiRun'] as const;
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
// AI planning (Sprint 11d)
// ---------------------------------------------------------------------------------------

/**
 * `plan.aiPrepare`: the free, durable AI plan preparation.
 *
 * The request is the accepted planning-service request verbatim, so the HTTP contract cannot drift
 * from the service it drives: `candidateProblemKeys` absent/`null` means the bounded automatic
 * unsolved pool, an explicit (possibly empty) list means exactly that selection, and the scheduling
 * settings are optional approved bounds. The service owns the strict validation of every member;
 * the HTTP layer adds only its closed-key and bound checks on top.
 */
export type ModelPlanPrepareRequest = PlanPrepareRequest;
/** Free preparation answer: the durable preparation view, or the service's typed refusal. */
export type ModelPlanPrepareResult = PlanPrepareResult;

/** `plan.aiRun`: the one paid call of an existing preparation, guarded by the stored revision. */
export type ModelPlanRunRequest = Omit<PlanRunRequest, 'expectedSettingsRevision'> & { readonly expectedSettingsRevision: number };

/** `plan.aiStatus`: one account-scoped status read; `reveal` asks for the candidate tags. */
export type ModelPlanStatusRequest = PlanAttemptRequest & { readonly reveal?: boolean };
/** `plan.aiCancel`: one account-scoped cancel/abandon of an attempt. */
export type ModelPlanCancelRequest = PlanAttemptRequest;
/** `plan.aiHistory`: one account-scoped, bounded, newest-first page of attempt metadata. */
export type ModelPlanHistoryRequest = PlanHistoryRequest;

/**
 * Metadata of one AI planning run this controller instance owns.
 *
 * It never carries a preparation, a candidate pool, a model answer or a refusal message: only the
 * owned operation identity, its lifecycle, the captured settings revision and the stable code of a
 * background failure or typed dispatch refusal. `errorCode` is `null` while the run is still
 * running or when it completed normally; `retryable` is only meaningful together with a refusal.
 */
export interface ModelPlanOperationView {
  readonly operationId: string;
  readonly operation: 'plan.aiRun';
  readonly state: 'running' | 'settled';
  readonly startedAt: string;
  readonly settledAt: string | null;
  /** Stored settings revision the paid run was validated and executed against. */
  readonly settingsRevision: number | null;
  readonly errorCode: string | null;
  readonly retryable: boolean | null;
}

/**
 * `plan.aiRun` acknowledgement.
 *
 * `operation` is this instance's owned run (the start it acknowledged, or its retained settled
 * record). `attempt` is the durable attempt as read when the request was answered: the `prepared`
 * row of an accepted start, or the terminal/reserved row of an idempotent repeat. Both are
 * metadata-only; the stored plan is reachable through `plan.aiStatus` and its spoiler projection.
 */
export interface ModelPlanRunResult {
  readonly requestId: string;
  readonly accountId: string;
  readonly operation: ModelPlanOperationView | null;
  readonly attempt: PlanningAttemptView | null;
  readonly verification: 'unverified_ai';
}

/**
 * `plan.aiStatus` answer.
 *
 * An attempt of another account answers exactly like an unknown id, so a caller can neither spoof
 * an account nor learn whether somebody else's request id exists. `operation` is attached only when
 * the caller's account is exactly the one this instance's run was started for. `plan` is the
 * workbench's own spoiler-safe projection of the stored plan (`WorkbenchPlanView`) and is `null`
 * while the attempt has no stored plan; the raw stored row never travels through this answer.
 */
export type ModelPlanStatusResult =
  | {
      readonly status: 'unknown';
      readonly requestId: string;
      readonly accountId: string;
      readonly attempt: null;
      readonly operation: ModelPlanOperationView | null;
      readonly plan: null;
      readonly verification: 'unverified_ai';
    }
  | {
      readonly status: 'found';
      readonly requestId: string;
      readonly accountId: string;
      readonly attempt: PlanningAttemptView;
      readonly operation: ModelPlanOperationView | null;
      readonly plan: WorkbenchPlanView | null;
      readonly verification: 'unverified_ai';
    };

/**
 * `plan.aiCancel` answer.
 *
 * `cancelled: true` means this instance cancelled its own live run; `cancelled: false` with a
 * durable `cancelled` status means the free preparation was abandoned by the service. A reserved
 * attempt is never rewritten or refunded here: its real usage is recorded by the settlement path
 * the token cancellation triggers, so `status: 'reserved'` is the honest answer.
 */
export interface ModelPlanCancelResult {
  readonly requestId: string;
  readonly accountId: string;
  readonly cancelled: boolean;
  readonly status: 'unknown' | PlanAttemptStatus;
  readonly operation: ModelPlanOperationView | null;
  readonly verification: 'unverified_ai';
}

/** `plan.aiHistory` answer: one bounded page of attempt metadata, newest first, never a plan body. */
export interface ModelPlanHistoryResult {
  readonly items: readonly PlanningAttemptView[];
  readonly total: number;
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
