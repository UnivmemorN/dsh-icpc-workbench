/**
 * Owned model operations controller (Stage 4h2a).
 *
 * This module is the single owner of *starting* paid work. It holds the one local start/save gate,
 * captures the settings record a start is validated and executed against, keeps the owned
 * cancellation token and promise of every background batch/coaching operation, and performs the
 * workbench settings save under the same gate. It registers no HTTP route (Stage 4h2b does that),
 * builds no adapter and never contacts a provider: the analysis pipeline arrives through
 * {@link ModelOperationsOptions.createPipeline} and the model-metadata probe through
 * {@link ModelOperationsOptions.validateModels}, both supplied by host composition later.
 *
 * ## One gate, captured settings
 *
 * `batch.run`, `batch.resume`, `batch.prepare`, a **new** `coaching.ask` reservation and
 * `settings.save` all acquire one synchronous gate before their first `await` and release it in a
 * `finally`. The gate is never held across a model call: it covers exactly the start/save critical
 * section. That makes a race deterministic — whichever call reaches the gate first proceeds and the
 * other is refused with `model_busy` — and it guarantees that a start cannot capture settings while
 * a save is rewriting them, or vice versa. The reservation/lease write itself is serialized across
 * processes by the store's own transaction, and `settings.save` re-checks persisted live leases
 * *inside* that transaction.
 *
 * A start therefore refuses when the caller's `expectedSettingsRevision` is not the stored revision
 * (`settings_changed`), and `settings.save` refuses while this instance owns any operation or while
 * *any* persisted batch holds an unexpired lease / any reservation is unexpired, whoever owns them
 * (`model_busy`). An expired orphan never blocks configuration permanently, and allowing a save
 * neither settles, refunds nor relabels it.
 *
 * ## Owned background work
 *
 * A queued start answers with plain metadata; the work runs on the controller's **own** cancellation
 * token, never on the HTTP request's token, so a client abort after the acknowledgement cannot
 * cancel paid work while an explicit `batch.cancel`/`coaching.cancel` still can. The stored promise
 * is a containment barrier: it never rejects, it records the fixed safe error code of a background
 * failure and hands the raw failure only to the optional local diagnostic observer. Settled
 * operations are retained in bounded maps (oldest settled first out, active never pruned) so
 * `batch.detail` and `coaching.status` can report this instance's own view without re-reading a
 * log; a fulfilled coaching call is retained as its safe metadata projection only, never its body.
 *
 * ## Projections
 *
 * Every answer is a redacted projection. Batch views expose identity, status, counters, known usage
 * and stable error codes — never a model outcome, an analysis suggestion, reasoning draft,
 * editorial evidence or a provider error message. A coaching start view never carries the hint text.
 *
 * ## Disposal
 *
 * {@link ModelOperations.close} stops accepting work, cancels every owned token and waits a bounded
 * time, reporting which operations settled and which are still outstanding: it never claims a
 * settlement it did not observe, and concurrent callers share one attempt and one report.
 * {@link ModelOperations.whenSettled} waits for the outstanding ones, so root composition can defer
 * closing the store until the durable settlement really finished.
 */
import {
  DomainError,
  createCancellationSource,
  parseProblemKey,
  type CancellationToken,
  type ModelUsage,
  type ProblemSnapshot,
} from '../domain/index.js';
import {
  AnalysisPipeline,
  classifySnapshotAvailability,
  type PreparedBatch,
} from '../application/analysis-pipeline.js';
import type { AnalysisBatch, AnalysisBatchLimits, ModelCallAttempt } from '../application/batch-types.js';
import {
  CoachingService,
  CoachingServiceError,
  MAX_COACHING_REQUEST_ID_CHARS,
  type CoachingAskRequest,
  type CoachingAskResult,
  type CoachingHistoryRequest,
} from '../application/coaching-service.js';
import { COACHING_LEVELS, type CoachingLevel, type CoachingStore } from '../application/coaching-types.js';
import type { TrainingStore } from '../application/ports.js';
import {
  DEFAULT_MODEL_BATCH_MAX_JOBS,
  MAX_MODEL_ATTEMPT_HISTORY,
  MAX_MODEL_BATCH_LIST_ITEMS,
  MAX_MODEL_BATCH_POPULATION,
  MAX_MODEL_BATCH_PROBLEMS,
  MAX_MODEL_RESERVATION_PAGES,
  MAX_SETTLED_MODEL_OPERATIONS,
  MODEL_DIAGNOSTIC_ROLES,
  MODEL_DIAGNOSTIC_SEVERITIES,
  MODEL_RESERVATION_PAGE_SIZE,
  ModelOperationError,
  type ModelAttemptView,
  type ModelBatchAvailabilitySummary,
  type ModelBatchCallUpperBound,
  type ModelBatchControlResult,
  type ModelBatchDetailResult,
  type ModelBatchIdRequest,
  type ModelBatchJobSummary,
  type ModelBatchJobView,
  type ModelBatchListRequest,
  type ModelBatchListResult,
  type ModelBatchPrepareRequest,
  type ModelBatchPrepareResult,
  type ModelBatchPreparedJobView,
  type ModelBatchRecoverRequest,
  type ModelBatchRecoverResult,
  type ModelBatchResumeRequest,
  type ModelBatchRunRequest,
  type ModelBatchStartResult,
  type ModelBatchSummaryView,
  type ModelBatchView,
  type ModelCoachingAskRequest,
  type ModelCoachingAskResult,
  type ModelCoachingCancelRequest,
  type ModelCoachingCancelResult,
  type ModelCoachingHistoryRequest,
  type ModelCoachingHistoryResult,
  type ModelCoachingStatusRequest,
  type ModelCoachingStatusResult,
  type ModelCurrentSettings,
  type ModelDiagnosticRole,
  type ModelDiagnosticSeverity,
  type ModelOperationCloseReport,
  type ModelOperationErrorCode,
  type ModelOperationName,
  type ModelOperationStatusView,
  type ModelRoleModels,
  type ModelSettingsSaveRequest,
  type ModelSettingsSaveResult,
  type ModelValidationDiagnostic,
} from '../application/model-operation-types.js';
import {
  defaultWorkbenchSettings,
  validateWorkbenchSettings,
  type SettingsStore,
  type WorkbenchSettings,
  type WorkbenchSettingsRecord,
} from '../application/workbench-settings.js';

/** Persistence surface the controller needs; one SQLite store implements all three ports. */
export type ModelOperationsStore = TrainingStore & SettingsStore & CoachingStore;

/** One background failure offered to {@link ModelOperationsOptions.onInternalError}. */
export interface ModelOperationFailureReport {
  readonly operation: ModelOperationName;
  readonly operationId: string;
  /** Batch id or coaching request id the operation belongs to. */
  readonly key: string;
  /** The original thrown value; never persisted and never returned by a projection. */
  readonly error: unknown;
}

export interface ModelOperationsOptions {
  readonly store: ModelOperationsStore;
  readonly coaching: CoachingService;
  /**
   * Build the pipeline a start captures. Called once per accepted start with the settings record it
   * was validated against, so a run's model roles, limits and prompts are frozen at that moment.
   */
  readonly createPipeline: (settings: WorkbenchSettingsRecord) => AnalysisPipeline;
  /**
   * Probe registered provider/model metadata **before** a paid start or a settings save. Diagnostics
   * of severity `error` refuse; `warning`/`info` are advisory and returned to the caller.
   */
  readonly validateModels: (
    settings: WorkbenchSettings,
    token: CancellationToken,
  ) => Promise<readonly ModelValidationDiagnostic[]>;
  /** Injected clock; every timestamp this controller records comes from here. */
  readonly now: () => string;
  /** Injected id source for owned operation identifiers. */
  readonly uniqueId: (prefix: string) => string;
  /** Optional local diagnostic sink for background failures; no public projection carries them. */
  readonly onInternalError?: (report: ModelOperationFailureReport) => void;
  /** Bounded wait of {@link ModelOperations.close}; defaults to 5000 ms. */
  readonly closeWaitMs?: number;
}

/** Identity of an owned coaching operation, for exact request-id conflict checks. */
interface OwnedCoachingIdentity {
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
}

/** One owned background operation: the controller's own token, promise and settlement record. */
interface OwnedOperation {
  readonly operation: ModelOperationName;
  readonly operationId: string;
  /** Batch id (`batch.*`) or coaching request id (`coaching.ask`). */
  readonly key: string;
  readonly source: ReturnType<typeof createCancellationSource>;
  /** Pipeline that owns the live run, so pause/cancel can signal that exact instance. */
  readonly pipeline: AnalysisPipeline | null;
  readonly coaching: OwnedCoachingIdentity | null;
  readonly settingsRevision: number | null;
  readonly startedAt: string;
  settled: boolean;
  settledAt: string | null;
  errorCode: string | null;
  /** Fixed safe projection of a fulfilled coaching call; never a hint body. */
  coachingResult: ModelCoachingAskResult | null;
  /** Never rejects; see {@link ModelOperations.launch}. */
  promise: Promise<void> | null;
}

interface ResolvedProblem {
  readonly problemKey: string;
  readonly snapshotId: string;
  /** `null` when the head references a snapshot row that is not readable. */
  readonly snapshot: ProblemSnapshot | null;
}

/**
 * The one synchronous start/save gate.
 *
 * Acquisition and release are synchronous and there is no queue: a caller that cannot acquire is
 * refused deterministically instead of waiting behind a model call.
 */
class StartGate {
  private held = false;

  tryAcquire(): boolean {
    if (this.held) {
      return false;
    }
    this.held = true;
    return true;
  }

  release(): void {
    this.held = false;
  }
}

/**
 * Owned model operations. One instance per plugin activation; it must not be shared across profiles
 * because the gate and the owned maps are per-instance state.
 */
export class ModelOperations {
  private readonly store: ModelOperationsStore;
  private readonly coaching: CoachingService;
  private readonly createPipeline: (settings: WorkbenchSettingsRecord) => AnalysisPipeline;
  private readonly validateModels: (
    settings: WorkbenchSettings,
    token: CancellationToken,
  ) => Promise<readonly ModelValidationDiagnostic[]>;
  private readonly now: () => string;
  private readonly uniqueId: (prefix: string) => string;
  private readonly onInternalError: ((report: ModelOperationFailureReport) => void) | undefined;
  private readonly closeWaitMs: number;
  private readonly gate = new StartGate();
  private ownedBatch: OwnedOperation | null = null;
  private ownedCoaching: OwnedOperation | null = null;
  private readonly settledBatches = new Map<string, OwnedOperation>();
  private readonly settledCoaching = new Map<string, OwnedOperation>();
  private closed = false;
  /** The one close attempt every caller shares; see {@link ModelOperations.close}. */
  private closing: Promise<ModelOperationCloseReport> | null = null;

  constructor(options: ModelOperationsOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('model operations need an options object');
    }
    if (options.store === null || typeof options.store !== 'object') {
      throw new TypeError('model operations need the store intersection');
    }
    if (!(options.coaching instanceof CoachingService)) {
      throw new TypeError('model operations need the accepted CoachingService');
    }
    if (typeof options.createPipeline !== 'function') {
      throw new TypeError('model operations need a createPipeline(settingsRecord) factory');
    }
    if (typeof options.validateModels !== 'function') {
      throw new TypeError('model operations need a validateModels(settings, token) probe');
    }
    if (typeof options.now !== 'function' || typeof options.uniqueId !== 'function') {
      throw new TypeError('model operations need an injected now() and uniqueId()');
    }
    if (options.onInternalError !== undefined && typeof options.onInternalError !== 'function') {
      throw new TypeError('ModelOperationsOptions.onInternalError must be a function when supplied');
    }
    const closeWaitMs = options.closeWaitMs ?? 5000;
    if (!Number.isSafeInteger(closeWaitMs) || closeWaitMs < 1) {
      throw new TypeError('ModelOperationsOptions.closeWaitMs must be a positive integer');
    }
    this.store = options.store;
    this.coaching = options.coaching;
    this.createPipeline = options.createPipeline;
    this.validateModels = options.validateModels;
    this.now = options.now;
    this.uniqueId = options.uniqueId;
    this.onInternalError = options.onInternalError;
    this.closeWaitMs = closeWaitMs;
  }

  // -------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------

  /**
   * Effective settings plus the revision a caller must echo back.
   *
   * Available before any operation and after disposal, because composition/bootstrap needs it
   * without starting paid work. `revision: null` means the built-in defaults are in effect.
   */
  async currentSettings(): Promise<ModelCurrentSettings> {
    const record = await this.store.getWorkbenchSettings();
    return record === null
      ? { revision: null, value: defaultWorkbenchSettings() }
      : { revision: record.revision, value: record.value };
  }

  /**
   * Validate and store the settings under one CAS save.
   *
   * Refused with `model_busy` while this instance owns any operation or while a persisted batch
   * lease / coaching reservation is still unexpired; refused with `model_invalid` when the model
   * probe reports a blocking diagnostic (the stored settings then stay unchanged); refused with
   * `settings_changed` when `expectedRevision` is not the stored revision. A cancellation after the
   * write rolls the transaction back, so a cancelled save never leaves a new revision behind.
   */
  async saveSettings(request: ModelSettingsSaveRequest, token: CancellationToken): Promise<ModelSettingsSaveResult> {
    const cancellation = requireToken(token);
    const expectedRevision = requireStoredRevision(request?.expectedRevision);
    if (!this.gate.tryAcquire()) {
      throw busyFailure('another model operation is already starting or saving settings');
    }
    try {
      this.assertOpen();
      cancellation.throwIfCancelled();
      if (this.activeOperations().length > 0) {
        throw busyFailure('an owned model operation is still running');
      }
      let value: WorkbenchSettings;
      try {
        value = validateWorkbenchSettings(request.value);
      } catch (error) {
        throw new ModelOperationError('invalid_input', 'the workbench settings are not a valid configuration', {
          cause: error,
        });
      }
      cancellation.throwIfCancelled();
      const blocking = await this.findLivePersistedOperation(cancellation);
      if (blocking !== null) {
        throw busyFailure(`${blocking} is still running`);
      }
      const diagnostics = normalizeDiagnostics(await this.validateModels(value, cancellation));
      const errors = diagnostics.filter((entry) => entry.severity === 'error');
      if (errors.length > 0) {
        throw new ModelOperationError('model_invalid', 'the configured provider or models are not available', {
          diagnostics: errors,
        });
      }
      cancellation.throwIfCancelled();
      this.assertOpen();
      let revision: number;
      try {
        revision = await this.store.transaction(async () => {
          // Re-check inside the transaction: a start whose lease landed between the first check and
          // this write must win, and the store's own transaction is the serialization point.
          const inside = await this.findLivePersistedOperation(cancellation);
          if (inside !== null) {
            throw busyFailure(`${inside} is still running`);
          }
          cancellation.throwIfCancelled();
          const saved = await this.store.saveWorkbenchSettings(value, expectedRevision);
          // After the write: a cancellation observed here rolls the transaction back, so settings
          // stay unchanged for a request that was cancelled while saving.
          cancellation.throwIfCancelled();
          return saved;
        });
      } catch (error) {
        throw mapSettingsWriteFailure(error);
      }
      return { revision, value, diagnostics };
    } finally {
      this.gate.release();
    }
  }

  // -------------------------------------------------------------------------------------
  // Batch preparation
  // -------------------------------------------------------------------------------------

  /**
   * Resolve real current snapshots and prepare a batch for them.
   *
   * Missing problems (`not_found`) and problems without a current snapshot head (`conflict`) are
   * refused before any batch state is written. The batch captures the settings limits in force at
   * this moment, and finished jobs are reported as `alreadyDone` instead of being reset.
   */
  async prepareBatch(request: ModelBatchPrepareRequest, token: CancellationToken): Promise<ModelBatchPrepareResult> {
    const cancellation = requireToken(token);
    const problemKeys = requireProblemKeys(request);
    const maxJobs = requireMaxJobs(request?.maxJobs);
    if (!this.gate.tryAcquire()) {
      throw busyFailure('another model operation is already starting or saving settings');
    }
    try {
      this.assertOpen();
      cancellation.throwIfCancelled();
      const record = await this.effectiveSettings();
      cancellation.throwIfCancelled();
      const resolved = await this.resolveCurrentSnapshots(problemKeys, cancellation);
      const limits = batchLimitsOf(record.value);
      const pipeline = this.createPipeline(record);
      const prepared = await pipeline.prepareBatch(
        resolved.map((entry) => entry.snapshotId),
        { maxJobs, limits },
      );
      return prepareResult(prepared, resolved, record, limits);
    } finally {
      this.gate.release();
    }
  }

  // -------------------------------------------------------------------------------------
  // Batch execution
  // -------------------------------------------------------------------------------------

  /**
   * Start the owned background run of a prepared batch.
   *
   * Refused (`settings_changed`) when `expectedSettingsRevision` is not the stored revision, and
   * (`model_busy`) when this instance already owns a batch operation. The answer is metadata only;
   * the run continues on the controller's own token and its progress is read back through
   * {@link batchDetail}.
   */
  async runBatch(request: ModelBatchRunRequest, token: CancellationToken): Promise<ModelBatchStartResult> {
    const cancellation = requireToken(token);
    const batchId = requireId(request?.batchId);
    const revision = requireSettingsRevision(request?.expectedSettingsRevision);
    return this.startBatchOperation(
      'batch.run',
      batchId,
      revision,
      cancellation,
      (pipeline, ownedToken) => pipeline.run(batchId, ownedToken),
    );
  }

  /**
   * Explicitly resume a paused/failed batch and run it in the background.
   *
   * `pipeline.resume` runs first (requeueing quota-paused and failed jobs, keeping every counter),
   * then the same owned run. Nothing is resumed automatically: only this call can lift a pause.
   */
  async resumeBatch(request: ModelBatchResumeRequest, token: CancellationToken): Promise<ModelBatchStartResult> {
    const cancellation = requireToken(token);
    const batchId = requireId(request?.batchId);
    const revision = requireSettingsRevision(request?.expectedSettingsRevision);
    return this.startBatchOperation('batch.resume', batchId, revision, cancellation, async (pipeline, ownedToken) => {
      await pipeline.resume(batchId);
      return pipeline.run(batchId, ownedToken);
    });
  }

  /**
   * Pause a batch through the pipeline instance that owns its run.
   *
   * The persisted pause is written first and the live run is signalled through the same instance, so
   * a paused batch never adopts a late model result. A batch this instance does not own is paused
   * through a pipeline created from the current settings — the state write is the existing public
   * method, never a direct store overwrite of another owner's lease.
   */
  async pauseBatch(request: ModelBatchIdRequest, token: CancellationToken): Promise<ModelBatchControlResult> {
    const cancellation = requireToken(token);
    const batchId = requireId(request?.batchId);
    cancellation.throwIfCancelled();
    this.assertOpen();
    const pipeline = await this.pipelineForControl(batchId, cancellation);
    return controlResult(await pipeline.pause(batchId));
  }

  /**
   * Cancel a batch terminally through the pipeline instance that owns its run, so the live run is
   * signalled and nothing of the paid work can be adopted afterwards.
   */
  async cancelBatch(request: ModelBatchIdRequest, token: CancellationToken): Promise<ModelBatchControlResult> {
    const cancellation = requireToken(token);
    const batchId = requireId(request?.batchId);
    cancellation.throwIfCancelled();
    this.assertOpen();
    const pipeline = await this.pipelineForControl(batchId, cancellation);
    return controlResult(await pipeline.cancel(batchId));
  }

  /**
   * Explicit recovery only: expired leases and reservations are reclaimed, nothing is run.
   *
   * A live lease is left untouched whatever its owner, reserved attempts without a live lease become
   * `uncertain`, and no counter or cost is ever refunded. `batchId: null`/absent recovers every
   * non-terminal batch.
   */
  async recoverBatches(request: ModelBatchRecoverRequest, token: CancellationToken): Promise<ModelBatchRecoverResult> {
    const cancellation = requireToken(token);
    const batchId =
      request?.batchId === undefined || request.batchId === null ? null : requireId(request.batchId);
    cancellation.throwIfCancelled();
    this.assertOpen();
    const record = await this.effectiveSettings();
    cancellation.throwIfCancelled();
    const report = await this.createPipeline(record).recover(batchId);
    return {
      batches: report.batches.map((entry) => ({
        batchId: entry.batchId,
        status: entry.status,
        requeuedJobs: entry.requeuedJobs,
        uncertainAttempts: entry.uncertainAttempts,
        skipped: entry.skipped,
      })),
    };
  }

  // -------------------------------------------------------------------------------------
  // Batch reads
  // -------------------------------------------------------------------------------------

  /**
   * Redacted detail of one batch: persisted state plus this instance's own operation view.
   *
   * The projection carries identity, status, counters, known usage, stable error codes and call
   * correlation — never an attempt outcome, analysis, suggestion, reasoning draft or raw error. A
   * batch whose attempt history would exceed the projection bound is refused instead of truncated,
   * and its jobs are bounded by the batch's own `maxJobs` (at most 100).
   */
  async batchDetail(request: ModelBatchIdRequest, token: CancellationToken): Promise<ModelBatchDetailResult> {
    const cancellation = requireToken(token);
    const batchId = requireId(request?.batchId);
    cancellation.throwIfCancelled();
    this.assertOpen();
    const batch = await this.store.getBatch(batchId);
    cancellation.throwIfCancelled();
    if (batch === null) {
      throw new ModelOperationError('not_found', 'the requested batch does not exist');
    }
    if (batch.jobs.length > MAX_MODEL_BATCH_PROBLEMS) {
      throw overflowFailure('the batch lists more jobs than the projection bound');
    }
    const attempts = await this.store.listModelCallAttempts({ batchId });
    cancellation.throwIfCancelled();
    if (attempts.length > MAX_MODEL_ATTEMPT_HISTORY) {
      throw overflowFailure('the batch attempt history exceeds the projection bound');
    }
    return { batch: await this.projectBatch(batch, attempts, cancellation), operation: this.operationStatusView(batchId) };
  }

  /**
   * Latest batch summaries, capped at {@link MAX_MODEL_BATCH_LIST_ITEMS}.
   *
   * The port returns the whole population as an array; a population beyond the accepted bound is
   * refused rather than partially reported, and each item stays batch-level (the per-job and
   * per-attempt projection belongs to `batch.detail`).
   */
  async batchList(request: ModelBatchListRequest, token: CancellationToken): Promise<ModelBatchListResult> {
    const cancellation = requireToken(token);
    const limit = requireListLimit(request?.limit);
    cancellation.throwIfCancelled();
    this.assertOpen();
    const batches = await this.store.listBatches(null);
    cancellation.throwIfCancelled();
    if (batches.length > MAX_MODEL_BATCH_POPULATION) {
      throw overflowFailure('the stored batch population exceeds the projection bound');
    }
    const ordered = [...batches].sort((left, right) =>
      left.updatedAt === right.updatedAt
        ? right.batchId.localeCompare(left.batchId)
        : right.updatedAt.localeCompare(left.updatedAt),
    );
    return {
      items: ordered.slice(0, limit).map((batch) => batchSummary(batch)),
      total: batches.length,
    };
  }

  // -------------------------------------------------------------------------------------
  // Coaching
  // -------------------------------------------------------------------------------------

  /**
   * Start one owned coaching call, or answer a free replay of an already durable request.
   *
   * A duplicate of the operation this instance is running returns that same operation without a
   * second call; the same request id with another account/problem/level is a `conflict`. A new
   * reservation requires the stored settings revision (`settings_changed` otherwise), is validated
   * against the model probe before any dispatch, and is refused with `model_busy` while another
   * owned coaching call is running or the gate is held. An already durable request id is replayed
   * without any settings requirement, so an idempotent answer stays readable after a settings
   * change.
   */
  async coachingAsk(request: ModelCoachingAskRequest, token: CancellationToken): Promise<ModelCoachingAskResult> {
    const cancellation = requireToken(token);
    const ask = parseCoachingAsk(request);
    const owned = this.ownedCoaching;
    if (owned !== null && owned.key === ask.requestId) {
      // A duplicate is acknowledged only while this instance is still open and the caller has not
      // cancelled: a cancelled request must not be told its work is running.
      cancellation.throwIfCancelled();
      this.assertOpen();
      assertCoachingIdentity(owned, ask);
      return ownedCoachingView(owned, ask);
    }
    const start = await this.beginCoaching(ask, cancellation);
    return start.kind === 'owned'
      ? ownedCoachingView(start.operation, ask)
      : this.replayCoaching(ask, cancellation);
  }

  /**
   * `coaching.status`: metadata unless exactly one level's body is explicitly requested.
   *
   * The accepted service owns the durable read and its spoiler rules; this controller adds its own
   * operation view of the same request — an acknowledged start that has not reserved yet, a terminal
   * refusal that wrote no row, or a background failure — and attaches it only when the caller's
   * account and problem are exactly the ones the operation was started for.
   */
  async coachingStatus(
    request: ModelCoachingStatusRequest,
    token: CancellationToken,
  ): Promise<ModelCoachingStatusResult> {
    const cancellation = requireToken(token);
    cancellation.throwIfCancelled();
    this.assertOpen();
    const requestId = requireId(request?.requestId);
    const problemKey = requireId(request?.problemKey);
    const durable = await this.coachingCall(() =>
      this.coaching.getStatus(requestId, request.accountId, problemKey, cancellation, {
        includeResponseText: request.includeResponseText === true,
        includeStale: request.includeStale === true,
      }),
    );
    return { ...durable, operation: this.coachingOperationView(requestId, request.accountId, problemKey) };
  }

  /**
   * `coaching.history`: metadata pages unless one level's body is explicitly requested.
   *
   * The accepted service owns the spoiler rules — a body needs an explicit level plus
   * `includeResponseText`, and a stale answer additionally needs `includeStale` — so this method
   * delegates rather than re-implementing them.
   */
  async coachingHistory(
    request: ModelCoachingHistoryRequest,
    token: CancellationToken,
  ): Promise<ModelCoachingHistoryResult> {
    const cancellation = requireToken(token);
    cancellation.throwIfCancelled();
    this.assertOpen();
    const history: CoachingHistoryRequest = {
      accountId: request.accountId,
      problemKey: requireId(request?.problemKey),
      level: request.level ?? null,
      includeResponseText: request.includeResponseText === true,
      includeStale: request.includeStale === true,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    };
    return this.coachingCall(() => this.coaching.history(history, cancellation));
  }

  /**
   * Cancel the owned call of exactly this request identity.
   *
   * Only this instance's own token is cancelled: a reservation owned by another process (or one that
   * already settled) is reported with `cancelled: false` and its known status — it is never refunded,
   * never rewritten as cancelled and never claimed as settled here.
   */
  async coachingCancel(
    request: ModelCoachingCancelRequest,
    token: CancellationToken,
  ): Promise<ModelCoachingCancelResult> {
    const cancellation = requireToken(token);
    const cancel = parseCoachingCancel(request);
    cancellation.throwIfCancelled();
    this.assertOpen();
    const owned = this.ownedCoaching;
    if (owned !== null && owned.key === cancel.requestId) {
      assertCoachingIdentity(owned, cancel);
      owned.source.cancel('coaching request cancelled by the user');
      // The token cancellation is this instance's own and is reported as such, but the returned
      // status is the durable one: before the reservation is written it is still `unknown`, and an
      // invented `reserved` would claim a paid reservation that does not exist.
      const status = await this.coachingCall(() =>
        this.coaching.getStatus(cancel.requestId, cancel.accountId, cancel.problemKey, cancellation),
      );
      return {
        requestId: cancel.requestId,
        cancelled: true,
        status: status.status === 'unknown' ? 'unknown' : status.attempt.status,
      };
    }
    const status = await this.coachingCall(() =>
      this.coaching.getStatus(cancel.requestId, cancel.accountId, cancel.problemKey, cancellation),
    );
    if (status.status === 'unknown') {
      return { requestId: cancel.requestId, cancelled: false, status: 'unknown' };
    }
    if (status.attempt.level !== cancel.level) {
      throw new ModelOperationError('conflict', 'the request id already belongs to another coaching level');
    }
    return { requestId: cancel.requestId, cancelled: false, status: status.attempt.status };
  }

  // -------------------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------------------

  /**
   * Stop accepting work, cancel every owned token and wait a bounded time.
   *
   * Idempotent and concurrent-safe: the first call starts the one close attempt and every later or
   * concurrent caller awaits that same promise, so they cannot re-run the wait or observe a
   * different outcome. `outstanding` lists operations whose durable settlement is still in flight;
   * root composition must keep the store open and await {@link whenSettled} instead of closing
   * under a pending settlement.
   */
  async close(): Promise<ModelOperationCloseReport> {
    if (this.closing === null) {
      this.closing = this.closeOnce();
    }
    return this.closing;
  }

  /** The single bounded close attempt shared by every caller of {@link close}. */
  private async closeOnce(): Promise<ModelOperationCloseReport> {
    this.closed = true;
    const active = this.activeOperations();
    for (const operation of active) {
      operation.source.cancel('the model operations controller is closing');
    }
    const deadline = Date.now() + this.closeWaitMs;
    const settled: string[] = [];
    const outstanding: string[] = [];
    for (const operation of active) {
      const finished = await settlesWithin(operation.promise, deadline - Date.now());
      (finished ? settled : outstanding).push(operation.operationId);
    }
    return { settled, outstanding };
  }

  /**
   * Wait until every owned operation has settled, however long that takes.
   *
   * Used after a bounded {@link close} reported `outstanding`, so the store is only closed once the
   * last durable settlement really finished. A worker that ignores its cancellation token keeps this
   * pending — deliberately: the caller decides, it is never silently declared settled.
   */
  async whenSettled(): Promise<ModelOperationCloseReport> {
    for (;;) {
      const active = this.activeOperations();
      if (active.length === 0) {
        break;
      }
      await Promise.all(active.map((operation) => operation.promise ?? Promise.resolve()));
    }
    const settled: string[] = [];
    for (const operation of this.settledBatches.values()) {
      settled.push(operation.operationId);
    }
    for (const operation of this.settledCoaching.values()) {
      settled.push(operation.operationId);
    }
    return { settled, outstanding: [] };
  }

  // -------------------------------------------------------------------------------------
  // Start plumbing
  // -------------------------------------------------------------------------------------

  /** Shared start path of `batch.run`/`batch.resume`: gate, CAS settings, model probe, owned run. */
  private async startBatchOperation(
    operation: 'batch.run' | 'batch.resume',
    batchId: string,
    revision: number,
    token: CancellationToken,
    work: (pipeline: AnalysisPipeline, ownedToken: CancellationToken) => Promise<unknown>,
  ): Promise<ModelBatchStartResult> {
    if (!this.gate.tryAcquire()) {
      throw busyFailure('another model operation is already starting or saving settings');
    }
    try {
      this.assertOpen();
      token.throwIfCancelled();
      if (this.ownedBatch !== null) {
        throw busyFailure('an owned batch is already running');
      }
      const batch = await this.store.getBatch(batchId);
      token.throwIfCancelled();
      if (batch === null) {
        throw new ModelOperationError('not_found', 'the requested batch does not exist');
      }
      const record = await this.requireCurrentSettings(revision, token);
      await this.requireValidModels(record.value, token);
      token.throwIfCancelled();
      const pipeline = this.createPipeline(record);
      // Re-checked synchronously right before the launch: a close that landed while the settings
      // were read must not let new paid work start.
      this.assertOpen();
      const source = createCancellationSource();
      const owned: OwnedOperation = {
        operation,
        operationId: this.uniqueId('model-op'),
        key: batchId,
        source,
        pipeline,
        coaching: null,
        settingsRevision: record.revision,
        startedAt: this.now(),
        settled: false,
        settledAt: null,
        errorCode: null,
        coachingResult: null,
        promise: null,
      };
      this.ownedBatch = owned;
      this.launch(owned, work(pipeline, source.token));
      return {
        batchId,
        operationId: owned.operationId,
        settingsRevision: record.revision,
        provider: record.value.provider,
        models: modelRolesOf(record.value),
        limits: { ...batch.limits },
      };
    } finally {
      this.gate.release();
    }
  }

  /**
   * Begin a coaching request: a durable attempt is a free replay, anything else is validated and
   * launched as owned background work.
   */
  private async beginCoaching(
    ask: ParsedCoachingAsk,
    token: CancellationToken,
  ): Promise<{ readonly kind: 'owned'; readonly operation: OwnedOperation } | { readonly kind: 'replay' }> {
    if (!this.gate.tryAcquire()) {
      throw busyFailure('another model operation is already starting or saving settings');
    }
    try {
      this.assertOpen();
      token.throwIfCancelled();
      const existing = await this.store.getCoachingAttempt(ask.requestId);
      token.throwIfCancelled();
      if (existing !== null) {
        // A durable attempt is answered by the service without a new reservation, so it needs no
        // settings revision and no model probe: an idempotent answer stays readable after a change.
        return { kind: 'replay' };
      }
      if (this.ownedCoaching !== null) {
        throw busyFailure('an owned coaching call is already running');
      }
      const record = await this.requireCurrentSettings(ask.expectedSettingsRevision, token);
      await this.requireValidModels(record.value, token);
      token.throwIfCancelled();
      this.assertOpen();
      const source = createCancellationSource();
      const owned: OwnedOperation = {
        operation: 'coaching.ask',
        operationId: this.uniqueId('model-op'),
        key: ask.requestId,
        source,
        pipeline: null,
        coaching: { accountId: ask.accountId, problemKey: ask.problemKey, level: ask.level },
        settingsRevision: record.revision,
        startedAt: this.now(),
        settled: false,
        settledAt: null,
        errorCode: null,
        coachingResult: null,
        promise: null,
      };
      this.ownedCoaching = owned;
      this.launch(owned, this.coaching.ask(serviceAsk(ask), source.token), replayView);
      return { kind: 'owned', operation: owned };
    } finally {
      this.gate.release();
    }
  }

  /** Free replay of an already durable coaching request; the service owns identity and spoilers. */
  private async replayCoaching(
    ask: ParsedCoachingAsk,
    token: CancellationToken,
  ): Promise<ModelCoachingAskResult> {
    const result = await this.coachingCall(() => this.coaching.ask(serviceAsk(ask), token));
    return replayView(result);
  }

  /**
   * Register an owned operation and attach its containment promise.
   *
   * The stored promise never rejects: a background failure is recorded as a fixed safe code and
   * handed only to the local diagnostic observer, so an acknowledged start can never surface as an
   * unhandled rejection. A fulfilled coaching call is projected once, metadata-only, and retained on
   * the operation so `coaching.status` can still report a refusal or another terminal outcome that
   * never wrote a durable row.
   */
  private launch<T>(owned: OwnedOperation, work: Promise<T>, project?: (value: T) => ModelCoachingAskResult): void {
    const settled = work.then(
      (value: T) => {
        if (project !== undefined) {
          try {
            owned.coachingResult = project(value);
          } catch (error) {
            // A failed projection is a background failure of this operation, never a silent success.
            this.settleOperation(owned, error);
            return;
          }
        }
        this.settleOperation(owned, null);
      },
      (error: unknown) => {
        this.settleOperation(owned, error);
      },
    );
    owned.promise = settled.then(undefined, (containment: unknown) => {
      // Last-resort barrier: `settleOperation` is written not to throw, and a failure of the
      // diagnostic observer must not become an unhandled rejection of the stored promise.
      this.notifyFailure(containment, owned);
    });
  }

  /** Record the terminal state of one owned operation and move it into its bounded settled map. */
  private settleOperation(owned: OwnedOperation, error: unknown): void {
    if (owned.settled) {
      return;
    }
    owned.settled = true;
    owned.settledAt = this.clockOrNull();
    owned.errorCode = error === null ? null : safeErrorCode(error);
    if (this.ownedBatch === owned) {
      this.ownedBatch = null;
    }
    if (this.ownedCoaching === owned) {
      this.ownedCoaching = null;
    }
    const target = owned.operation === 'coaching.ask' ? this.settledCoaching : this.settledBatches;
    target.set(owned.key, owned);
    while (target.size > MAX_SETTLED_MODEL_OPERATIONS) {
      const oldest = target.keys().next();
      if (oldest.done === true) {
        break;
      }
      target.delete(oldest.value);
    }
    if (error !== null) {
      this.notifyFailure(error, owned);
    }
  }

  /** Offer one background failure to the optional local observer, contained. */
  private notifyFailure(error: unknown, owned: OwnedOperation): void {
    const observer = this.onInternalError;
    if (observer === undefined) {
      return;
    }
    try {
      observer({ operation: owned.operation, operationId: owned.operationId, key: owned.key, error });
    } catch (observerFailure) {
      discardDiagnostic(observerFailure);
    }
  }

  // -------------------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------------------

  /** Stored settings, or a typed `settings_changed` refusal when the caller's revision is stale. */
  private async requireCurrentSettings(
    expectedRevision: number,
    token: CancellationToken,
  ): Promise<WorkbenchSettingsRecord> {
    const record = await this.store.getWorkbenchSettings();
    token.throwIfCancelled();
    if (record === null || record.revision !== expectedRevision) {
      throw new ModelOperationError('settings_changed', 'the workbench settings changed; reload them and retry');
    }
    return record;
  }

  /** Run the injected model probe and refuse a start on any blocking diagnostic. */
  private async requireValidModels(
    settings: WorkbenchSettings,
    token: CancellationToken,
  ): Promise<readonly ModelValidationDiagnostic[]> {
    const diagnostics = normalizeDiagnostics(await this.validateModels(settings, token));
    const errors = diagnostics.filter((entry) => entry.severity === 'error');
    if (errors.length > 0) {
      throw new ModelOperationError('model_invalid', 'the configured provider or models are not available', {
        diagnostics: errors,
      });
    }
    return diagnostics;
  }

  /** Settings the pipeline is built from; built-in defaults are marked with revision 0. */
  private async effectiveSettings(): Promise<WorkbenchSettingsRecord> {
    const record = await this.store.getWorkbenchSettings();
    return record ?? { revision: 0, value: defaultWorkbenchSettings() };
  }

  /** Pipeline of a control operation: the owned instance first, else one from current settings. */
  private async pipelineForControl(batchId: string, token: CancellationToken): Promise<AnalysisPipeline> {
    const owned = this.ownedBatch;
    if (owned !== null && owned.key === batchId && owned.pipeline !== null) {
      return owned.pipeline;
    }
    const record = await this.effectiveSettings();
    token.throwIfCancelled();
    return this.createPipeline(record);
  }

  /**
   * Resolve every requested problem to its stored current snapshot.
   *
   * A missing problem is `not_found`; a problem whose material was never frozen is `conflict`. The
   * snapshot body is read only to summarise availability — a head whose row is unreadable is counted
   * as an error and left for the pipeline's own `missing_reference` refusal.
   */
  private async resolveCurrentSnapshots(
    problemKeys: readonly string[],
    token: CancellationToken,
  ): Promise<readonly ResolvedProblem[]> {
    const resolved: ResolvedProblem[] = [];
    for (const key of problemKeys) {
      const problem = await this.store.getProblem(key);
      if (problem === null) {
        throw new ModelOperationError('not_found', 'a requested problem is not stored; sync or import it first');
      }
      const head = await this.store.getCurrentSnapshotHead(problem.ref);
      token.throwIfCancelled();
      if (head === null) {
        throw new ModelOperationError(
          'conflict',
          'a requested problem has no current snapshot; refresh its material first',
        );
      }
      resolved.push({
        problemKey: key,
        snapshotId: head.snapshotId,
        snapshot: await this.store.getSnapshot(head.snapshotId),
      });
      token.throwIfCancelled();
    }
    return resolved;
  }

  /**
   * Find a persisted operation that must block a settings save.
   *
   * Only a *live* lease or reservation blocks: an expired orphan is reported so the caller can
   * recover it explicitly, but it never prevents configuration forever. The walk over reserved
   * coaching rows is paged and bounded; exceeding the bound refuses the save rather than guessing.
   */
  private async findLivePersistedOperation(token: CancellationToken): Promise<string | null> {
    const at = this.now();
    const running = await this.store.listBatches('running');
    token.throwIfCancelled();
    const live = running.find(
      (batch) => batch.status === 'running' && Date.parse(batch.leaseExpiresAt ?? at) > Date.parse(at),
    );
    if (live !== undefined) {
      return `batch ${live.batchId}`;
    }
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_RESERVATION_PAGES; page += 1) {
      const result = await this.store.listCoachingAttempts({
        status: 'reserved',
        limit: MODEL_RESERVATION_PAGE_SIZE,
        cursor,
      });
      token.throwIfCancelled();
      for (const attempt of result.items) {
        if (Date.parse(attempt.expiresAt) > Date.parse(at)) {
          return `coaching request ${attempt.id}`;
        }
      }
      cursor = result.nextCursor;
      if (cursor === null) {
        return null;
      }
    }
    throw overflowFailure('the reserved coaching history exceeds the recovery bound');
  }

  // -------------------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------------------

  /** Redacted projection of one batch with its jobs and call audit. */
  private async projectBatch(
    batch: AnalysisBatch,
    attempts: readonly ModelCallAttempt[],
    token: CancellationToken,
  ): Promise<ModelBatchView> {
    const byJob = new Map<string, ModelCallAttempt[]>();
    for (const attempt of attempts) {
      const bucket = byJob.get(attempt.jobId);
      if (bucket === undefined) {
        byJob.set(attempt.jobId, [attempt]);
      } else {
        bucket.push(attempt);
      }
    }
    const jobs: ModelBatchJobView[] = [];
    let uncertainAttempts = 0;
    for (const spec of batch.jobs) {
      const job = await this.store.getJob(spec.jobId);
      token.throwIfCancelled();
      const calls = byJob.get(spec.jobId) ?? [];
      const uncertain = calls.filter((attempt) => attempt.status === 'uncertain').length;
      uncertainAttempts += uncertain;
      jobs.push({
        jobId: spec.jobId,
        snapshotId: spec.snapshotId,
        problemKey: job?.problemKey ?? null,
        status: job?.status ?? null,
        attempts: job?.attempts ?? null,
        counters: job === null ? null : { ...job.counters },
        analysisId: job?.analysisId ?? null,
        usage: sumSettledUsage(calls),
        uncertainAttempts: uncertain,
        errorCode: job?.lastError?.code ?? null,
        updatedAt: job?.updatedAt ?? null,
        leaseExpiresAt: job?.leaseExpiresAt ?? null,
        calls: calls.map(attemptViewOf),
      });
    }
    return {
      batchId: batch.batchId,
      status: batch.status,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      maxJobs: batch.maxJobs,
      limits: { ...batch.limits },
      counters: { ...batch.counters },
      uncertainAttempts,
      lastErrorCode: batch.lastError?.code ?? null,
      jobs,
    };
  }

  /** This instance's own view of one key: active first, then the most recent settled operation. */
  private operationStatusView(key: string): ModelOperationStatusView | null {
    const owned =
      this.activeOperations().find((entry) => entry.key === key) ??
      this.settledBatches.get(key) ??
      this.settledCoaching.get(key) ??
      null;
    if (owned === null) {
      return null;
    }
    return {
      operationId: owned.operationId,
      operation: owned.operation,
      state: owned.settled ? 'settled' : 'running',
      startedAt: owned.startedAt,
      settledAt: owned.settledAt,
      errorCode: owned.errorCode,
    };
  }

  /**
   * This instance's own metadata view of one coaching request, or `null`.
   *
   * Attached only when the caller's account and problem are exactly the identity the operation was
   * started for, so one account can never read another's operation state. A fulfilled call is
   * reported from its retained projection (never a hint body); a settled operation without one is a
   * background failure and reports its fixed safe code.
   */
  private coachingOperationView(
    requestId: string,
    accountId: string | null,
    problemKey: string,
  ): ModelCoachingAskResult | null {
    const owned = (this.ownedCoaching?.key === requestId ? this.ownedCoaching : this.settledCoaching.get(requestId)) ?? null;
    const identity = owned?.coaching ?? null;
    if (
      owned === null ||
      owned.key !== requestId ||
      identity === null ||
      identity.accountId !== accountId ||
      identity.problemKey !== problemKey
    ) {
      return null;
    }
    const retained = owned.coachingResult;
    if (retained !== null) {
      return {
        ...retained,
        operationId: owned.operationId,
        state: owned.settled ? 'settled' : 'running',
        settingsRevision: owned.settingsRevision,
        startedAt: owned.startedAt,
        settledAt: owned.settledAt ?? retained.settledAt,
      };
    }
    if (owned.settled) {
      return {
        requestId: owned.key,
        operationId: owned.operationId,
        state: 'settled',
        status: 'failed',
        attemptId: null,
        accountId: identity.accountId,
        problemKey: identity.problemKey,
        level: identity.level,
        snapshotId: null,
        snapshotState: 'unknown',
        usage: null,
        errorCode: owned.errorCode,
        retryable: null,
        settingsRevision: owned.settingsRevision,
        startedAt: owned.startedAt,
        settledAt: owned.settledAt,
      };
    }
    return ownedCoachingView(owned, identity);
  }

  /** All operations this instance currently owns. */
  private activeOperations(): readonly OwnedOperation[] {
    const active: OwnedOperation[] = [];
    if (this.ownedBatch !== null) {
      active.push(this.ownedBatch);
    }
    if (this.ownedCoaching !== null) {
      active.push(this.ownedCoaching);
    }
    return active;
  }

  /** Wrap one accepted-service read so its typed failures surface as controller codes. */
  private async coachingCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw mapCoachingFailure(error);
    }
  }

  private clockOrNull(): string | null {
    try {
      return this.now();
    } catch (error) {
      // An injected clock that fails leaves the settlement instant unknown instead of inventing one;
      // the recorded outcome and safe error code are unaffected.
      discardDiagnostic(error);
      return null;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw busyFailure('the model operations controller is closed');
    }
  }
}

// ---------------------------------------------------------------------------------------
// Parsing and projections
// ---------------------------------------------------------------------------------------

interface ParsedCoachingIdentity {
  readonly requestId: string;
  readonly accountId: string | null;
  readonly problemKey: string;
  readonly level: CoachingLevel;
  readonly explicitFullSolution: boolean;
}

interface ParsedCoachingAsk extends ParsedCoachingIdentity {
  readonly expectedSettingsRevision: number;
}

/** Closed key set of one plain ask request; an undeclared member is refused, never ignored. */
const COACHING_ASK_KEYS: readonly string[] = [
  'requestId',
  'accountId',
  'problemKey',
  'level',
  'explicitFullSolution',
  'expectedSettingsRevision',
];

function parseCoachingAsk(request: ModelCoachingAskRequest): ParsedCoachingAsk {
  if (request !== null && typeof request === 'object') {
    const unknown = Object.keys(request).filter((key) => !COACHING_ASK_KEYS.includes(key));
    if (unknown.length > 0) {
      throw new ModelOperationError('invalid_input', `the coaching ask request has unknown keys: ${unknown.join(', ')}`);
    }
  }
  const identity = parseCoachingIdentity(request);
  return { ...identity, expectedSettingsRevision: requireSettingsRevision(request?.expectedSettingsRevision) };
}

function parseCoachingCancel(request: ModelCoachingCancelRequest): ParsedCoachingIdentity {
  return parseCoachingIdentity(request);
}

function parseCoachingIdentity(request: {
  readonly requestId?: unknown;
  readonly accountId?: unknown;
  readonly problemKey?: unknown;
  readonly level?: unknown;
  readonly explicitFullSolution?: unknown;
} | null): ParsedCoachingIdentity {
  if (request === null || typeof request !== 'object') {
    throw new ModelOperationError('invalid_input', 'the coaching request must be an object');
  }
  const requestId = request.requestId;
  if (
    typeof requestId !== 'string' ||
    requestId.trim().length === 0 ||
    requestId.length > MAX_COACHING_REQUEST_ID_CHARS
  ) {
    throw new ModelOperationError('invalid_input', 'requestId must be a non-empty bounded string');
  }
  const accountId = request.accountId;
  if (accountId !== null && (typeof accountId !== 'string' || accountId.trim().length === 0)) {
    throw new ModelOperationError('invalid_input', 'accountId must be null or a non-empty stored account id');
  }
  const problemKey = request.problemKey;
  if (typeof problemKey !== 'string' || problemKey.trim().length === 0) {
    throw new ModelOperationError('invalid_input', 'problemKey must be a non-empty canonical problem key');
  }
  try {
    parseProblemKey(problemKey);
  } catch (error) {
    throw new ModelOperationError('invalid_input', 'problemKey is not a canonical problem key', { cause: error });
  }
  const level = request.level;
  if (!COACHING_LEVELS.includes(level as CoachingLevel)) {
    throw new ModelOperationError('invalid_input', 'level must be one of 1, 2, 3 or full');
  }
  if (request.explicitFullSolution !== undefined && typeof request.explicitFullSolution !== 'boolean') {
    throw new ModelOperationError('invalid_input', 'explicitFullSolution must be boolean when present');
  }
  const explicitFullSolution = request.explicitFullSolution === true;
  if (level !== 'full' && explicitFullSolution) {
    throw new ModelOperationError('invalid_input', 'a hint level must not request the full solution');
  }
  return { requestId, accountId, problemKey, level: level as CoachingLevel, explicitFullSolution };
}

/** Identity check of a duplicate request against the operation this instance already owns. */
function assertCoachingIdentity(owned: OwnedOperation, identity: ParsedCoachingIdentity): void {
  const known = owned.coaching;
  if (
    known === null ||
    known.accountId !== identity.accountId ||
    known.problemKey !== identity.problemKey ||
    known.level !== identity.level
  ) {
    throw new ModelOperationError('conflict', 'the request id already belongs to another coaching request');
  }
}

/** Service request built field by field; an absent optional flag is omitted, never `undefined`. */
function serviceAsk(ask: ParsedCoachingAsk): CoachingAskRequest {
  return {
    requestId: ask.requestId,
    accountId: ask.accountId,
    problemKey: ask.problemKey,
    level: ask.level,
    ...(ask.explicitFullSolution ? { explicitFullSolution: true } : {}),
    expectedSettingsRevision: ask.expectedSettingsRevision,
  };
}

/** Metadata view of an operation this instance owns; it never carries the hint text. */
function ownedCoachingView(owned: OwnedOperation, identity: OwnedCoachingIdentity): ModelCoachingAskResult {
  return {
    requestId: owned.key,
    operationId: owned.operationId,
    state: owned.settled ? 'settled' : 'running',
    status: 'pending',
    attemptId: null,
    accountId: identity.accountId,
    problemKey: identity.problemKey,
    level: identity.level,
    snapshotId: null,
    snapshotState: 'unknown',
    usage: null,
    errorCode: owned.errorCode,
    retryable: null,
    settingsRevision: owned.settingsRevision,
    startedAt: owned.startedAt,
    settledAt: owned.settledAt,
  };
}

/** Metadata view of an already durable coaching request; the answer body is dropped here. */
function replayView(result: CoachingAskResult): ModelCoachingAskResult {
  const base = {
    requestId: result.requestId,
    operationId: null,
    state: result.status === 'pending' ? ('running' as const) : ('settled' as const),
    status: result.status,
    attemptId: result.attemptId,
    accountId: result.accountId,
    problemKey: result.problemKey,
    level: result.level,
    snapshotId: result.snapshotId,
    snapshotState: result.snapshotState,
    usage: result.usage,
    settingsRevision: null,
    startedAt: null,
  };
  if (result.status === 'answered') {
    return { ...base, state: 'settled', errorCode: null, retryable: null, settledAt: result.finishedAt };
  }
  return {
    ...base,
    errorCode: result.error.code,
    retryable: result.error.retryable,
    settledAt: null,
  };
}

function prepareResult(
  prepared: PreparedBatch,
  resolved: readonly ResolvedProblem[],
  record: WorkbenchSettingsRecord,
  limits: AnalysisBatchLimits,
): ModelBatchPrepareResult {
  const keyBySnapshot = new Map(resolved.map((entry) => [entry.snapshotId, entry.problemKey] as const));
  const batch = prepared.batch;
  const jobs: ModelBatchPreparedJobView[] = [];
  for (const job of batch?.jobs ?? []) {
    const problemKey = keyBySnapshot.get(job.snapshotId);
    if (problemKey === undefined) {
      throw new ModelOperationError('internal', 'a prepared batch job could not be mapped to a requested problem');
    }
    jobs.push({ jobId: job.jobId, snapshotId: job.snapshotId, problemKey });
  }
  const availability = availabilityOf(resolved);
  return {
    batchId: batch?.batchId ?? null,
    settingsRevision: record.revision === 0 ? null : record.revision,
    provider: record.value.provider,
    models: modelRolesOf(record.value),
    limits: batch === null ? { ...limits } : { ...batch.limits },
    upperBoundCalls: upperBoundCalls(jobs.length, batch?.limits ?? limits),
    availability,
    jobs,
    alreadyDone: (prepared.alreadyDone ?? []).map(alreadyDoneView),
  };
}

/** Availability counts of the requested material; never a title, source or excerpt. */
function availabilityOf(resolved: readonly ResolvedProblem[]): ModelBatchAvailabilitySummary {
  let ready = 0;
  let absent = 0;
  let error = 0;
  for (const entry of resolved) {
    const kind = entry.snapshot === null ? 'unreadable' : classifySnapshotAvailability(entry.snapshot).kind;
    if (kind === 'editorial') {
      ready += 1;
    } else if (kind === 'absent') {
      absent += 1;
    } else {
      error += 1;
    }
  }
  return { ready, absent, error };
}

/**
 * Conservative upper bound of the paid calls a batch with `jobCount` jobs can dispatch.
 *
 * The bound is the batch's own quota, not a prediction of what it will spend: every dispatch —
 * retries included — reserves and counts against the batch limits, so the analysis and reasoning
 * budgets are hard maxima. A batch with no job is never run and is bounded by zero.
 */
function upperBoundCalls(jobCount: number, limits: AnalysisBatchLimits): ModelBatchCallUpperBound {
  return jobCount === 0
    ? { analysisCalls: 0, reasoningCalls: 0 }
    : { analysisCalls: limits.maxAnalysisCalls, reasoningCalls: limits.maxReasoningCalls };
}

function alreadyDoneView(entry: {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly status: ModelBatchJobSummary['status'];
  readonly analysisId: string | null;
}): ModelBatchJobSummary {
  return { jobId: entry.jobId, snapshotId: entry.snapshotId, status: entry.status, analysisId: entry.analysisId };
}

function batchSummary(batch: AnalysisBatch): ModelBatchSummaryView {
  return {
    batchId: batch.batchId,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    maxJobs: batch.maxJobs,
    jobCount: batch.jobs.length,
    limits: { ...batch.limits },
    counters: { ...batch.counters },
    lastErrorCode: batch.lastError?.code ?? null,
  };
}

function controlResult(batch: AnalysisBatch): ModelBatchControlResult {
  return { batchId: batch.batchId, status: batch.status, counters: { ...batch.counters } };
}

/** Redacted call projection: identity, lifecycle, usage and a stable error code only. */
function attemptViewOf(attempt: ModelCallAttempt): ModelAttemptView {
  return {
    attemptId: attempt.attemptId,
    role: attempt.role,
    provider: attempt.provider,
    model: attempt.model,
    promptVersion: attempt.promptVersion,
    status: attempt.status,
    requestedAt: attempt.requestedAt,
    finishedAt: attempt.finishedAt,
    hostSessionId: attempt.hostSessionId,
    hostCallId: attempt.hostCallId,
    usage: attempt.usage,
    errorCode: attempt.error?.code ?? null,
  };
}

/** Usage of the persisted **settled** attempts only; `null` when no cost is known, never zero. */
function sumSettledUsage(attempts: readonly ModelCallAttempt[]): ModelUsage | null {
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let known = false;
  for (const attempt of attempts) {
    if (attempt.status !== 'settled' || attempt.usage === null) {
      continue;
    }
    known = true;
    calls += attempt.usage.calls;
    promptTokens += attempt.usage.promptTokens;
    completionTokens += attempt.usage.completionTokens;
    totalTokens += attempt.usage.totalTokens;
  }
  return known ? { calls, promptTokens, completionTokens, totalTokens } : null;
}

function modelRolesOf(settings: WorkbenchSettings): ModelRoleModels {
  return {
    analysis: settings.roles.analysisModel,
    verification: settings.roles.verificationModel,
    reasoning: settings.roles.reasoningModel,
  };
}

function batchLimitsOf(settings: WorkbenchSettings): AnalysisBatchLimits {
  return {
    maxAnalysisCalls: settings.modelLimits.maxAnalysisCalls,
    maxReasoningCalls: settings.modelLimits.maxReasoningCalls,
    concurrency: settings.modelLimits.concurrency,
  };
}

// -------------------------------------------------------------------------------------
// Failures and bounded waits
// -------------------------------------------------------------------------------------

/** Fixed safe messages of the coaching-service failures this controller re-codes. */
const COACHING_FAILURE_MESSAGES = {
  invalid_request: 'the coaching request is invalid',
  request_conflict: 'the request id already belongs to another coaching request',
  history_overflow: 'the coaching history exceeds the readable bound',
  storage_inconsistent: 'the stored coaching record is inconsistent',
} as const;

/** Domain codes that map onto a stable controller refusal instead of a sanitized `internal`. */
const DOMAIN_FAILURE_CODES: Readonly<Partial<Record<DomainError['code'], ModelOperationErrorCode>>> = {
  invalid_input: 'invalid_input',
  invalid_id_part: 'invalid_input',
  invalid_url: 'invalid_input',
  invalid_timestamp: 'invalid_input',
  unknown_taxonomy_id: 'invalid_input',
  missing_reference: 'not_found',
  duplicate_id: 'conflict',
  immutable_violation: 'conflict',
  invalid_transition: 'conflict',
  non_serializable_content: 'conflict',
  cancelled: 'cancelled',
  unfilled_settings: 'internal',
};

function busyFailure(message: string): ModelOperationError {
  return new ModelOperationError('model_busy', message);
}

function overflowFailure(message: string): ModelOperationError {
  return new ModelOperationError('history_overflow', message);
}

/** Stable code of a background failure; the raw error and its message never travel. */
function safeErrorCode(error: unknown): ModelOperationErrorCode {
  if (error instanceof ModelOperationError) {
    return error.code;
  }
  if (error instanceof CoachingServiceError) {
    return coachingFailureCode(error.code);
  }
  if (error instanceof DomainError) {
    return DOMAIN_FAILURE_CODES[error.code] ?? 'internal';
  }
  return 'internal';
}

function coachingFailureCode(code: CoachingServiceError['code']): ModelOperationErrorCode {
  if (code === 'invalid_request') {
    return 'invalid_input';
  }
  if (code === 'request_conflict') {
    return 'conflict';
  }
  if (code === 'history_overflow') {
    return 'history_overflow';
  }
  return 'internal';
}

/** Re-code an accepted-service refusal so the UI can branch on one stable controller vocabulary. */
function mapCoachingFailure(error: unknown): unknown {
  if (!(error instanceof CoachingServiceError)) {
    return error;
  }
  return new ModelOperationError(coachingFailureCode(error.code), COACHING_FAILURE_MESSAGES[error.code], {
    retryable: false,
    cause: error,
  });
}

/** A CAS write that found another revision (or an existing singleton) is a settings conflict. */
function mapSettingsWriteFailure(error: unknown): unknown {
  if (error instanceof ModelOperationError) {
    return error;
  }
  if (error instanceof DomainError && (error.code === 'invalid_transition' || error.code === 'duplicate_id')) {
    return new ModelOperationError('settings_changed', 'the workbench settings changed; reload them and retry', {
      cause: error,
    });
  }
  return error;
}

/** Validate the narrow, application-owned diagnostic shape; a host object is never spread in. */
function normalizeDiagnostics(raw: readonly ModelValidationDiagnostic[]): readonly ModelValidationDiagnostic[] {
  if (!Array.isArray(raw)) {
    throw new TypeError('validateModels must resolve to an array of diagnostics');
  }
  return raw.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('every model diagnostic must be an object');
    }
    const record = entry as Record<string, unknown>;
    const code = record['code'];
    const severity = record['severity'];
    const message = record['message'];
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new TypeError('a model diagnostic needs a non-empty code');
    }
    if (!MODEL_DIAGNOSTIC_SEVERITIES.includes(severity as ModelDiagnosticSeverity)) {
      throw new TypeError('a model diagnostic needs a known severity');
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new TypeError('a model diagnostic needs a non-empty message');
    }
    const role = record['role'];
    if (role !== undefined && !MODEL_DIAGNOSTIC_ROLES.includes(role as ModelDiagnosticRole)) {
      throw new TypeError('a model diagnostic role must name a configured model role');
    }
    const model = record['model'];
    if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
      throw new TypeError('a model diagnostic model must be a non-empty id when present');
    }
    return {
      code,
      severity: severity as ModelDiagnosticSeverity,
      message,
      ...(role === undefined ? {} : { role: role as ModelDiagnosticRole }),
      ...(model === undefined ? {} : { model: model as string }),
    };
  });
}

function requireToken(token: CancellationToken | null | undefined): CancellationToken {
  if (
    token === null ||
    token === undefined ||
    typeof token !== 'object' ||
    typeof token.cancelled !== 'boolean' ||
    typeof token.throwIfCancelled !== 'function'
  ) {
    throw new ModelOperationError('invalid_input', 'a cancellation token is required');
  }
  return token;
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ModelOperationError('invalid_input', 'a non-empty identifier is required');
  }
  return value;
}

function requireSettingsRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ModelOperationError('invalid_input', 'expectedSettingsRevision must be a positive integer');
  }
  return value;
}

function requireStoredRevision(value: unknown): number | null {
  return value === null ? null : requireSettingsRevision(value);
}

function requireProblemKeys(request: ModelBatchPrepareRequest | null | undefined): readonly string[] {
  if (request === null || request === undefined || typeof request !== 'object') {
    throw new ModelOperationError('invalid_input', 'batch.prepare needs a request object');
  }
  const keys = request.problemKeys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_MODEL_BATCH_PROBLEMS) {
    throw new ModelOperationError(
      'invalid_input',
      `batch.prepare needs 1..${MAX_MODEL_BATCH_PROBLEMS} problem keys`,
    );
  }
  const seen = new Set<string>();
  const accepted: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new ModelOperationError('invalid_input', 'every problem key must be a non-empty string');
    }
    try {
      parseProblemKey(key);
    } catch (error) {
      throw new ModelOperationError('invalid_input', 'a problem key is not canonical', { cause: error });
    }
    if (seen.has(key)) {
      throw new ModelOperationError('invalid_input', 'batch.prepare received the same problem key twice');
    }
    seen.add(key);
    accepted.push(key);
  }
  return accepted;
}

function requireMaxJobs(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_MODEL_BATCH_MAX_JOBS;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_MODEL_BATCH_PROBLEMS) {
    throw new ModelOperationError('invalid_input', `maxJobs must be an integer within 1..${MAX_MODEL_BATCH_PROBLEMS}`);
  }
  return value;
}

function requireListLimit(value: unknown): number {
  if (value === undefined) {
    return MAX_MODEL_BATCH_LIST_ITEMS;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_MODEL_BATCH_LIST_ITEMS) {
    throw new ModelOperationError(
      'invalid_input',
      `the batch list limit must be an integer within 1..${MAX_MODEL_BATCH_LIST_ITEMS}`,
    );
  }
  return value;
}

/** True when `work` settled before `timeoutMs` elapsed; a missing promise counts as settled. */
async function settlesWithin(work: Promise<void> | null, timeoutMs: number): Promise<boolean> {
  if (work === null) {
    return true;
  }
  if (timeoutMs <= 0) {
    return false;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Explicitly drop a diagnostic failure that has no reporting channel and cannot change an outcome. */
function discardDiagnostic(_error: unknown): void {
  // Deliberately empty: the call sites document why the dropped failure is inconsequential.
}
