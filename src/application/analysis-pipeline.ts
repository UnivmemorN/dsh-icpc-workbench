/**
 * Analysis pipeline: durable orchestration of analysis batches.
 *
 * The pipeline is pure application code — it depends on the domain, on the persistence port
 * and on the model-gateway port only. It never reads a clock, an environment variable or the
 * filesystem: `now()` and `uniqueId()` are injected, so a replay with the same inputs makes
 * the same decisions, and the tests can drive time deterministically.
 *
 * ## The accounting protocol
 *
 * 1. `prepareBatch` transactionally verifies that every snapshot is the stored current head,
 *    creates the deterministic analysis job of each snapshot only when absent, captures the
 *    problem's manual-decision revision for the later compare-and-set, and saves the batch
 *    with its immutable job mapping. A legacy batch whose jobs do not record that revision
 *    refuses to execute instead of assuming the current one.
 * 2. `run` claims the batch by persisting owner + lease through `saveBatch` under revision
 *    CAS, then drives a bounded worker pool. The batch lease is never taken by calling
 *    `claimJob`: the pipeline reads with `getJob` and applies the *pure* `transitionJob`
 *    inside the same transaction, because store transactions do not nest.
 * 3. Before every model dispatch the pipeline writes a `reserved` attempt and bumps the job
 *    and batch counters **in one transaction**. A dispatched call is therefore never
 *    unaccounted for, and the model is never awaited inside a database transaction.
 * 4. Every settlement — success, typed error, cancellation or an unexpected throw (recorded
 *    as `uncertain`) — is persisted with its usage. Nothing is refunded. Retries only happen
 *    for declared retryable errors, inside the configured retry/attempt budget, and each
 *    retry dispatch reserves and counts again.
 * 5. The commit transaction re-reads the batch status/owner/lease, the job status/owner/lease,
 *    the cancellation token, the snapshot head (id, hash, version) and the manual revision, and
 *    only then writes the immutable analysis result, the resolved decisions and the job success
 *    together. The token is checked again after every await inside that transaction, so a
 *    cancellation that lands while the commit callback runs rolls back instead of leaving a
 *    partial write. A paused, cancelled, expired or stale job can never be turned into a
 *    success, and a stale result can never overwrite a newer manual decision.
 * 6. Recorded usage is the sum of the job's persisted **settled** attempts — a reused analysis
 *    pass and settled retry failures were paid for too. An `uncertain` attempt carries no usage
 *    and is counted separately; token cost is never estimated.
 *
 * ## Availability
 *
 * Analyzable material means at least one `found` editorial source with a referenced,
 * non-empty solution. When every source is explicitly `absent` and the statement is present,
 * the reasoning role runs and its drafts always require review. Operational failures
 * (auth/forbidden/rate-limited/unavailable/changed-response) and unknown source sets never
 * trigger reasoning — they fail the job explicitly, so a broken request can never be
 * disguised as "no editorial exists".
 */
import type {
  AnalyzeOutcome,
  ModelCallResult,
  ModelCapabilities,
  ModelGateway,
  ModelGatewayError,
  ModelLimits,
  ModelRoleSettings,
  ReasonOutcome,
  TrainingStore,
  VerifyOutcome,
} from './ports.js';
import {
  DEFAULT_ANALYSIS_BATCH_MAX_JOBS,
  budgetKindOfRole,
  createAnalysisBatch,
  type AnalysisBatch,
  type AnalysisBatchCounters,
  type AnalysisBatchError,
  type AnalysisBatchJob,
  type AnalysisBatchLimits,
  type AnalysisBatchStatus,
  type ModelCallAttempt,
  type ModelCallOutcome,
  type ModelCallRole,
} from './batch-types.js';
import {
  DomainError,
  analysisJobIdOf,
  createAnalysisJob,
  createAnalysisResult,
  createCancellationSource,
  createModelUsage,
  createTaxonomyIndex,
  deepFreeze,
  invariant,
  resolveTagDecisions,
  transitionJob,
  type AiTagSuggestion,
  type AnalysisJobState,
  type AnalysisJobStatus,
  type CancellationToken,
  type ModelUsage,
  type ProblemSnapshot,
  type SuggestionVerification,
  type Taxonomy,
  type TaxonomyIndex,
} from '../domain/index.js';

/**
 * Prompt versions recorded on every attempt, so a resumed batch reuses only identical input.
 *
 * The pipeline appends the taxonomy version when it persists or sends one
 * (`<version>|taxonomy:<version>`); see `AnalysisPipeline.promptVersionFor`.
 */
export const DEFAULT_PROMPT_VERSIONS: Readonly<Record<ModelCallRole, string>> = {
  analysis: 'analysis-v1',
  verification: 'verification-v1',
  reasoning: 'reasoning-v1',
};

export interface AnalysisPipelineOptions {
  readonly store: TrainingStore;
  readonly gateway: ModelGateway;
  /** Validated taxonomy; its `version` is recorded on every analysis result. */
  readonly taxonomy: Taxonomy;
  readonly roles: ModelRoleSettings;
  readonly limits: ModelLimits;
  /** Injected clock. Every persisted timestamp comes from here. */
  readonly now: () => string;
  /** Injected id source; called with a short prefix (`attempt`, `batch`, `worker`). */
  readonly uniqueId: (prefix: string) => string;
  /** Worker identity written into batch/job leases; defaults to a unique worker id. */
  readonly owner?: string;
  /** Job lease duration; must strictly exceed `limits.requestTimeoutMs`. */
  readonly leaseMs?: number;
  /** Batch lease duration; defaults to `leaseMs` and must cover one request timeout. */
  readonly batchLeaseMs?: number;
  /** Extra dispatch attempts per call after a declared retryable failure. */
  readonly maxRetries?: number;
  readonly minExcerptChars?: number;
  readonly promptVersions?: Partial<Record<ModelCallRole, string>>;
}

/** How a snapshot can be analysed. */
export type SnapshotAvailability =
  | { readonly kind: 'editorial' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'missing_statement'; readonly detail: string }
  | { readonly kind: 'unknown_sources'; readonly detail: string }
  | { readonly kind: 'operational'; readonly code: string; readonly detail: string };

/**
 * Classify the persisted material of one snapshot.
 *
 * `editorial` requires a `found` source with at least one referenced non-empty solution;
 * `absent` requires that *every* source explicitly reports absence **and** that the statement
 * exists. Everything else is an explicit failure: an empty source list is unknown, and an
 * operational source status is never treated as absence, so reasoning budget is never spent
 * on a broken request.
 */
export function classifySnapshotAvailability(snapshot: ProblemSnapshot): SnapshotAvailability {
  const found = snapshot.sources.filter((source) => source.availability === 'found');
  const usable = found.filter((source) =>
    snapshot.solutions.some((solution) => solution.sourceId === source.id && solution.text.trim().length > 0),
  );
  if (usable.length > 0) {
    return { kind: 'editorial' };
  }
  if (found.length > 0) {
    return {
      kind: 'operational',
      code: 'editorial_empty',
      detail: `found editorial source(s) ${found.map((source) => source.id).join(', ')} carry no referenced solution text`,
    };
  }
  if (snapshot.sources.length === 0) {
    return {
      kind: 'unknown_sources',
      detail: `snapshot ${snapshot.snapshotId} has no editorial sources; absence cannot be concluded`,
    };
  }
  const blocking = snapshot.sources.filter((source) => source.availability !== 'absent');
  if (blocking.length > 0) {
    return {
      kind: 'operational',
      code: 'source_unavailable',
      detail: `editorial source(s) ${blocking
        .map((source) => `${source.id}:${source.availability}`)
        .join(', ')} did not answer with an explicit absence`,
    };
  }
  if (snapshot.problem.statement === null || snapshot.problem.statement.trim().length === 0) {
    return {
      kind: 'missing_statement',
      detail: `every editorial source of ${snapshot.snapshotId} is absent and the problem statement is empty`,
    };
  }
  return { kind: 'absent' };
}

export interface PrepareBatchSettings {
  readonly batchId?: string;
  readonly maxJobs?: number;
  readonly limits?: Partial<AnalysisBatchLimits>;
  readonly createdAt?: string;
}

/** A job that was already finished before the batch was prepared; it is never reset. */
export interface AlreadyDoneJob {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly status: AnalysisJobStatus;
  readonly analysisId: string | null;
}

export interface PreparedBatch {
  /** `null` when every requested job was already done, so no batch was created. */
  readonly batch: AnalysisBatch | null;
  readonly alreadyDone: readonly AlreadyDoneJob[];
}

export interface AnalysisJobOutcome {
  readonly jobId: string;
  readonly snapshotId: string;
  readonly status: AnalysisJobStatus;
  readonly analysisId: string | null;
  readonly error: AnalysisBatchError | null;
  /** Why the job was not executed in this run (`job_lease_live`, `stale_snapshot`, …). */
  readonly skipped: string | null;
}

export interface AnalysisRunSummary {
  readonly batchId: string;
  readonly status: AnalysisBatchStatus;
  readonly jobs: readonly AnalysisJobOutcome[];
  readonly counters: AnalysisBatchCounters;
  readonly pausedForQuota: boolean;
  /**
   * Attempts of this batch persisted as `uncertain` (dispatched, cost unknown).
   *
   * They are deliberately not folded into any usage sum: an unknown cost stays visible as a
   * count instead of being invented as zero tokens.
   */
  readonly uncertainAttempts: number;
}

export interface RecoveredBatch {
  readonly batchId: string;
  readonly status: AnalysisBatchStatus;
  readonly requeuedJobs: number;
  readonly uncertainAttempts: number;
  /** `live_lease` when another owner was still executing this batch. */
  readonly skipped: string | null;
}

export interface RecoveryReport {
  readonly batches: readonly RecoveredBatch[];
}

interface ClaimedJob {
  readonly batchId: string;
  readonly jobSpec: AnalysisBatchJob;
  readonly job: AnalysisJobState;
  readonly snapshot: ProblemSnapshot;
  /** Manual revision the batch captured; re-read and compared before every dispatch and adoption. */
  readonly manualRevision: number;
}

type ClaimResult = { readonly kind: 'run'; readonly claim: ClaimedJob } | { readonly kind: 'skip'; readonly reason: string };

type ReservationResult =
  | { readonly kind: 'reserved'; readonly attempt: ModelCallAttempt }
  | { readonly kind: 'quota'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly reason: string }
  /** The call must not be paid for at all (`unsupported`, `stale_snapshot`, `manual_revision_changed`). */
  | { readonly kind: 'refused'; readonly error: AnalysisBatchError };

type RoleCallOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly usage: ModelUsage }
  | { readonly kind: 'error'; readonly error: AnalysisBatchError }
  | { readonly kind: 'quota'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly reason: string };

type AbortReason =
  | 'batch_cancelled'
  | 'cancelled'
  | 'paused'
  | 'job_cancelled'
  | 'ownership_lost'
  | 'lease_expired'
  | 'job_not_running'
  | 'stale_snapshot'
  | 'manual_revision_changed';

type CommitResult = { readonly kind: 'adopted'; readonly analysisId: string } | { readonly kind: 'aborted'; readonly reason: AbortReason };

/**
 * Internal rollback signal of the adoption transaction.
 *
 * Thrown *inside* the commit callback when a pause or a cancellation is observed after a write
 * has already been issued: the store then rolls the entire transaction back instead of committing
 * a partial adoption. Returning a refusal after a write would commit it, so this signal is the
 * only correct way out. It is caught in `adoptOrRefuse` and never escapes the pipeline. It is
 * deliberately not a `DomainError`, so no generic error handler can mistake it for a reportable
 * user-visible failure.
 */
class AdoptionRollback extends Error {
  readonly reason: AbortReason;

  constructor(reason: AbortReason) {
    super(`analysis adoption rolled back (${reason})`);
    this.name = 'AdoptionRollback';
    this.reason = reason;
  }
}

/** Model output to adopt; the recorded usage is read from the persisted attempts, not passed in. */
interface AdoptableContent {
  readonly suggestions: readonly AiTagSuggestion[];
  readonly verifications: readonly SuggestionVerification[];
  readonly reasoningDrafts: readonly import('../domain/index.js').ReasoningDraft[];
}

interface ActiveRun {
  readonly source: ReturnType<typeof createCancellationSource>;
  requestPause(): void;
}

/**
 * Durable analysis pipeline. One instance may be shared by many batches; a batch may only be
 * executed by one owner at a time (in-process via the active-run registry, cross-process via
 * the persisted batch lease).
 */
export class AnalysisPipeline {
  private readonly store: TrainingStore;
  private readonly gateway: ModelGateway;
  private readonly taxonomy: Taxonomy;
  private readonly index: TaxonomyIndex;
  private readonly roles: ModelRoleSettings;
  private readonly limits: ModelLimits;
  private readonly now: () => string;
  private readonly uniqueId: (prefix: string) => string;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly batchLeaseMs: number;
  private readonly maxRetries: number;
  private readonly minExcerptChars: number;
  private readonly promptVersions: Readonly<Record<ModelCallRole, string>>;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: AnalysisPipelineOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.taxonomy = options.taxonomy;
    this.index = createTaxonomyIndex(options.taxonomy);
    // Detach the caller-owned settings: a later mutation of the caller's object must not change
    // the roles or the budget a run was validated against.
    this.roles = deepFreeze({ ...options.roles });
    this.limits = deepFreeze({ ...options.limits, job: { ...options.limits.job } });
    this.now = options.now;
    this.uniqueId = options.uniqueId;
    this.owner = options.owner ?? options.uniqueId('worker');
    this.leaseMs = options.leaseMs ?? options.limits.job.leaseMs;
    this.batchLeaseMs = options.batchLeaseMs ?? this.leaseMs;
    this.maxRetries = options.maxRetries ?? options.limits.maxRetries;
    this.minExcerptChars = options.minExcerptChars ?? 12;
    this.promptVersions = { ...DEFAULT_PROMPT_VERSIONS, ...(options.promptVersions ?? {}) };
    invariant(
      Number.isInteger(this.limits.job.maxAttempts) && this.limits.job.maxAttempts >= 1,
      'invalid_input',
      'limits.job.maxAttempts must be an integer >= 1',
      { maxAttempts: this.limits.job.maxAttempts },
    );
    invariant(
      Number.isInteger(this.limits.concurrency) && this.limits.concurrency >= 1,
      'invalid_input',
      'limits.concurrency must be an integer >= 1',
      { concurrency: this.limits.concurrency },
    );
    invariant(
      Number.isInteger(this.maxRetries) && this.maxRetries >= 0,
      'invalid_input',
      'analysis pipeline maxRetries must be an integer >= 0',
      { maxRetries: this.maxRetries },
    );
    // A lease that does not outlive one request would let a second owner take the job while
    // the first call is still running; the constructor refuses that configuration.
    invariant(
      this.leaseMs > this.limits.requestTimeoutMs,
      'invalid_input',
      `analysis pipeline leaseMs (${this.leaseMs}) must exceed the model request timeout (${this.limits.requestTimeoutMs})`,
      { leaseMs: this.leaseMs, requestTimeoutMs: this.limits.requestTimeoutMs },
    );
    invariant(
      this.batchLeaseMs > this.limits.requestTimeoutMs,
      'invalid_input',
      `analysis pipeline batchLeaseMs (${this.batchLeaseMs}) must exceed the model request timeout (${this.limits.requestTimeoutMs})`,
      { batchLeaseMs: this.batchLeaseMs, requestTimeoutMs: this.limits.requestTimeoutMs },
    );
  }

  // -------------------------------------------------------------------------------------
  // Batch preparation
  // -------------------------------------------------------------------------------------

  /**
   * Prepare a batch for already persisted, current snapshots.
   *
   * Runs in one store transaction: each snapshot must exist and still be its problem's head;
   * the deterministic job of each snapshot is created only when absent (a finished job is
   * reported `alreadyDone`, never reset and never overwritten); a job already scheduled by
   * another active batch is refused; and each job records the problem's manual revision at
   * this moment. When every requested job was already done, no batch is created.
   */
  async prepareBatch(snapshotIds: readonly string[], settings: PrepareBatchSettings = {}): Promise<PreparedBatch> {
    invariant(snapshotIds.length > 0, 'invalid_input', 'prepareBatch needs at least one snapshot id', {});
    invariant(
      new Set(snapshotIds).size === snapshotIds.length,
      'duplicate_id',
      'prepareBatch received the same snapshot id twice',
      { snapshotIds },
    );
    const at = this.now();
    const batchId = settings.batchId ?? this.uniqueId('batch');
    const createdAt = settings.createdAt ?? at;
    const maxJobs = settings.maxJobs ?? DEFAULT_ANALYSIS_BATCH_MAX_JOBS;
    return this.store.transaction(async () => {
      const snapshots: ProblemSnapshot[] = [];
      for (const snapshotId of snapshotIds) {
        const snapshot = await this.store.getSnapshot(snapshotId);
        if (!snapshot) {
          throw new DomainError('missing_reference', `snapshot ${snapshotId} is not stored; persist it before preparing a batch`, {
            snapshotId,
          });
        }
        const head = await this.store.getCurrentSnapshotHead(snapshot.problem.ref);
        const current =
          head !== null &&
          head.snapshotId === snapshot.snapshotId &&
          head.contentHash === snapshot.contentHash &&
          head.version === snapshot.version;
        if (!current) {
          throw new DomainError(
            'invalid_input',
            `snapshot ${snapshotId} is not the current head of ${snapshot.problem.key}; save a fresh snapshot first`,
            { snapshotId, problemKey: snapshot.problem.key },
          );
        }
        snapshots.push(snapshot);
      }

      const activeBatches = (await this.store.listBatches(null)).filter(
        (batch) => batch.status === 'pending' || batch.status === 'running' || batch.status === 'paused',
      );
      const jobs: AnalysisBatchJob[] = [];
      const alreadyDone: AlreadyDoneJob[] = [];
      for (const snapshot of snapshots) {
        const jobId = analysisJobIdOf(snapshot.snapshotId);
        const owner = activeBatches.find(
          (batch) => batch.batchId !== batchId && batch.jobs.some((job) => job.jobId === jobId),
        );
        if (owner) {
          throw new DomainError('invalid_transition', `job ${jobId} already belongs to active batch ${owner.batchId}`, {
            jobId,
            batchId: owner.batchId,
          });
        }
        const existing = await this.store.getJob(jobId);
        if (existing && (existing.status === 'succeeded' || existing.status === 'cancelled')) {
          alreadyDone.push({
            jobId,
            snapshotId: snapshot.snapshotId,
            status: existing.status,
            analysisId: existing.analysisId,
          });
          continue;
        }
        if (!existing) {
          await this.store.saveJob(
            createAnalysisJob({ problemRef: snapshot.problem.ref, snapshotId: snapshot.snapshotId, at: createdAt }),
          );
        } else if (existing.status === 'failed') {
          // A previously failed job may be scheduled again; its counters and attempts survive.
          await this.store.saveJob(transitionJob(existing, { type: 'requeue', at }));
        }
        const manualRevision = await this.store.getManualRevision(snapshot.problem.key);
        jobs.push({ jobId, snapshotId: snapshot.snapshotId, manualRevision });
      }
      if (jobs.length === 0) {
        return { batch: null, alreadyDone };
      }
      const batch = createAnalysisBatch({
        batchId,
        jobs,
        createdAt,
        maxJobs,
        status: 'pending',
        ...(settings.limits ? { limits: settings.limits } : {}),
      });
      const revision = await this.store.saveBatch(batch, null);
      return { batch: { ...batch, revision }, alreadyDone };
    });
  }

  // -------------------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------------------

  /**
   * Execute a prepared batch until it is finished, paused for quota, or interrupted.
   *
   * The in-process active-run slot is taken **before the first await**, so two concurrent calls
   * on the same instance can never both claim the batch; cross-instance exclusion is the
   * persisted live lease. The returned summary reflects persisted state. A batch that is
   * `paused` or `failed` must be resumed first; a completed/cancelled batch is reported without
   * touching it. A caller token that was already cancelled — or gets cancelled while no call is
   * in flight — persists a terminal cancellation instead of leaving paid work schedulable.
   */
  async run(batchId: string, cancellationToken?: CancellationToken): Promise<AnalysisRunSummary> {
    if (this.activeRuns.has(batchId)) {
      throw new DomainError('invalid_transition', `batch ${batchId} is already running in this pipeline`, { batchId });
    }
    const source = createCancellationSource();
    const pause = { requested: false };
    // Register before any await: a second `run` must observe this slot even while the first call
    // is still reading state, and `pause` must be able to reach the run.
    this.activeRuns.set(batchId, {
      source,
      requestPause: () => {
        pause.requested = true;
      },
    });
    // The listener stays synchronous: an async listener's rejection would be unobservable.
    const externalOff = cancellationToken?.onCancel(() => source.cancel(cancellationToken.reason ?? 'cancelled'));
    const token = source.token;
    const outcomes: AnalysisJobOutcome[] = [];
    try {
      const initial = await this.store.getBatch(batchId);
      if (!initial) {
        throw new DomainError('missing_reference', `batch ${batchId} does not exist`, { batchId });
      }
      this.assertExecutable(initial);
      if (initial.status === 'completed' || initial.status === 'cancelled') {
        return this.summarize(initial, outcomes);
      }
      if (initial.status === 'paused') {
        throw new DomainError('invalid_transition', `batch ${batchId} is paused; resume it before running`, { batchId });
      }
      if (token.cancelled && !pause.requested) {
        // Pre-cancelled token (or cancelled while reading): persist the terminal state and
        // dispatch nothing, so no job of this batch can be executed later by accident. A pause
        // is not a cancellation, so it falls through to the claim, which refuses a paused batch.
        const cancelled = (await this.cancelPersisted(batchId)) ?? initial;
        return this.summarize(cancelled, outcomes);
      }
      // Validate the provider contract *before* the claim writes `running` + a lease: an
      // unimplemented provider or an invalid concurrency advert must leave the batch exactly as
      // it was found — pending, unowned, with no attempt row and no counter movement.
      const capabilities = this.requireCapabilities(batchId);
      const claimed = await this.claimBatch(batchId);
      if (claimed.status !== 'running') {
        return this.summarize(claimed, outcomes);
      }
      const concurrency = Math.max(
        1,
        Math.min(
          claimed.limits.concurrency,
          this.limits.concurrency,
          capabilities.maxConcurrency,
          claimed.jobs.length,
        ),
      );
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (token.cancelled || pause.requested) {
            return;
          }
          const index = cursor;
          cursor += 1;
          const spec = claimed.jobs[index];
          if (!spec) {
            return;
          }
          outcomes.push(await this.processJob(claimed.batchId, spec, token, pause));
        }
      };
      const workers: Promise<void>[] = [];
      for (let index = 0; index < concurrency; index += 1) {
        workers.push(worker());
      }
      // Await the whole bounded pool before touching batch state; a rejected worker is
      // re-thrown only after every other worker settled, so no promise escapes unobserved.
      const settled = await Promise.allSettled(workers);
      for (const entry of settled) {
        if (entry.status === 'rejected') {
          throw entry.reason;
        }
      }
      if (token.cancelled && !pause.requested) {
        // An external cancellation that arrived between calls: the terminal state must be made
        // durable here, because no job is in flight to persist it.
        await this.cancelPersisted(batchId);
      } else {
        await this.finalizeBatch(batchId);
      }
      const finalBatch = (await this.store.getBatch(batchId)) ?? initial;
      return this.summarize(finalBatch, outcomes);
    } finally {
      externalOff?.();
      this.activeRuns.delete(batchId);
    }
  }

  /**
   * Pause a batch.
   *
   * The intent is persisted first (`paused`, lease released), then the local run is notified and
   * its token cancelled, so no further call is dispatched and an in-flight one is asked to stop.
   * This is **not** a cancellation: a call that settles anyway stays on the books as audit — its
   * attempt row may still be written — but no analysis result and no tag decision is adopted
   * while the batch is paused. The interrupted job returns to `pending`, and a later `resume`
   * continues from the paid pass.
   */
  async pause(batchId: string): Promise<AnalysisBatch> {
    const paused = await this.store.transaction(async () => {
      const batch = await this.store.getBatch(batchId);
      if (!batch) {
        throw new DomainError('missing_reference', `batch ${batchId} does not exist`, { batchId });
      }
      this.assertExecutable(batch);
      if (batch.status === 'paused') {
        return batch;
      }
      if (batch.status === 'completed' || batch.status === 'cancelled') {
        throw new DomainError('invalid_transition', `batch ${batchId} is ${batch.status} and cannot be paused`, {
          batchId,
          status: batch.status,
        });
      }
      const at = this.now();
      const next: AnalysisBatch = { ...batch, status: 'paused', owner: null, leaseExpiresAt: null, updatedAt: at };
      const revision = await this.store.saveBatch(next, batch.revision);
      return { ...next, revision };
    });
    const active = this.activeRuns.get(batchId);
    active?.requestPause();
    // Cancelling the local token stops the in-flight call; the commit still refuses to adopt
    // because the persisted batch is `paused`, so this can never become a terminal cancel.
    active?.source.cancel('batch paused');
    return paused;
  }

  /**
   * Cancel a batch: the terminal state is persisted first (batch and every unfinished job),
   * then local runs are cancelled through their tokens. A model result that arrives after the
   * cancellation is still recorded as audit but can never be adopted, because the commit
   * re-reads the job status and refuses a cancelled job.
   */
  async cancel(batchId: string): Promise<AnalysisBatch> {
    const cancelled = await this.cancelPersisted(batchId);
    if (!cancelled) {
      const batch = await this.store.getBatch(batchId);
      if (!batch) {
        throw new DomainError('missing_reference', `batch ${batchId} does not exist`, { batchId });
      }
      throw new DomainError('invalid_transition', `batch ${batchId} is completed and cannot be cancelled`, {
        batchId,
      });
    }
    this.activeRuns.get(batchId)?.source.cancel('batch cancelled');
    return cancelled;
  }

  /**
   * Persist terminal cancellation of a batch and of every job that is not already finished.
   *
   * Idempotent (`cancelled` returns the stored record) and tolerant of a batch that finished
   * meanwhile: `null` means the batch is missing or `completed`, so a late cancellation can never
   * rewrite a finished batch. Used by {@link cancel} and by the run loop when an external token
   * was cancelled without a `cancel()` call.
   */
  private async cancelPersisted(batchId: string): Promise<AnalysisBatch | null> {
    return this.store.transaction(async () => {
      const batch = await this.store.getBatch(batchId);
      if (!batch || batch.status === 'completed') {
        return null;
      }
      if (batch.status === 'cancelled') {
        return batch;
      }
      const at = this.now();
      for (const spec of batch.jobs) {
        const job = await this.store.getJob(spec.jobId);
        if (!job || job.status === 'succeeded' || job.status === 'cancelled') {
          continue;
        }
        await this.store.saveJob(transitionJob(job, { type: 'cancel', at }));
      }
      const next: AnalysisBatch = { ...batch, status: 'cancelled', owner: null, leaseExpiresAt: null, updatedAt: at };
      const revision = await this.store.saveBatch(next, batch.revision);
      return { ...next, revision };
    });
  }

  /**
   * Resume a paused or failed batch: quota-paused and failed jobs go back to `pending` and the
   * batch becomes `pending` with no lease, ready for the next `run`. A `running` batch is
   * refused — `recover` reclaims an expired lease — so a live lease is never stolen and its
   * counters are never reset. Raising `limits` here is how a user increases the budget; the
   * recorded counters are never reset or refunded.
   */
  async resume(batchId: string, settings: { readonly limits?: Partial<AnalysisBatchLimits> } = {}): Promise<AnalysisBatch> {
    return this.store.transaction(async () => {
      const batch = await this.store.getBatch(batchId);
      if (!batch) {
        throw new DomainError('missing_reference', `batch ${batchId} does not exist`, { batchId });
      }
      this.assertExecutable(batch);
      if (batch.status === 'running') {
        // A live lease belongs to whoever holds it — possibly this very owner — and taking it
        // over here would let two workers execute the same job.
        throw new DomainError(
          'invalid_transition',
          `batch ${batchId} is running; recover an expired lease before resuming it`,
          { batchId },
        );
      }
      if (batch.status === 'completed' || batch.status === 'cancelled') {
        throw new DomainError('invalid_transition', `batch ${batchId} is ${batch.status} and cannot be resumed`, {
          batchId,
          status: batch.status,
        });
      }
      const at = this.now();
      for (const spec of batch.jobs) {
        const job = await this.store.getJob(spec.jobId);
        if (job && (job.status === 'paused_quota' || job.status === 'failed')) {
          await this.store.saveJob(transitionJob(job, { type: 'requeue', at }));
        }
      }
      const next: AnalysisBatch = {
        ...batch,
        status: 'pending',
        owner: null,
        leaseExpiresAt: null,
        limits: { ...batch.limits, ...(settings.limits ?? {}) },
        updatedAt: at,
        lastError: null,
      };
      const revision = await this.store.saveBatch(next, batch.revision);
      return { ...next, revision };
    });
  }

  /**
   * Explicit recovery after a crash or restart.
   *
   * A batch whose lease expired is returned to `pending`; a job whose lease expired is
   * requeued; and every still-`reserved` attempt of a job that no longer holds a live lease
   * becomes `uncertain` (dispatched, cost unknown). A live lease is left untouched whatever its
   * owner — including this instance's own owner string — so recovery can never run the same job
   * twice. Counters are never refunded.
   */
  async recover(batchId?: string | null): Promise<RecoveryReport> {
    let batches: readonly AnalysisBatch[];
    if (batchId) {
      const batch = await this.store.getBatch(batchId);
      if (!batch) {
        throw new DomainError('missing_reference', `batch ${batchId} does not exist`, { batchId });
      }
      batches = [batch];
    } else {
      batches = await this.store.listBatches(null);
    }
    const report: RecoveredBatch[] = [];
    for (const batch of batches) {
      if (batch.status === 'completed' || batch.status === 'cancelled') {
        continue;
      }
      const at = this.now();
      let recovered = batch;
      if (batch.status === 'running') {
        // Only a live lease is untouchable. Owner identity is irrelevant: an expired lease must
        // be reclaimable even by the instance that took it (a crashed run of this same owner).
        if (Date.parse(batch.leaseExpiresAt ?? at) > Date.parse(at)) {
          report.push({
            batchId: batch.batchId,
            status: batch.status,
            requeuedJobs: 0,
            uncertainAttempts: 0,
            skipped: 'live_lease',
          });
          continue;
        }
        recovered = await this.store.transaction(async () => {
          const current = await this.store.getBatch(batch.batchId);
          if (!current || current.status !== 'running') {
            return current ?? batch;
          }
          if (Date.parse(current.leaseExpiresAt ?? at) > Date.parse(at)) {
            return current;
          }
          const next: AnalysisBatch = {
            ...current,
            status: 'pending',
            owner: null,
            leaseExpiresAt: null,
            updatedAt: at,
            lastError: { code: 'recovered', message: 'batch lease expired; the batch was returned to pending', retryable: true },
          };
          const revision = await this.store.saveBatch(next, current.revision);
          return { ...next, revision };
        });
      }
      let requeuedJobs = 0;
      let uncertainAttempts = 0;
      for (const spec of recovered.jobs) {
        const recoveredJob = await this.recoverJob(spec.jobId, at);
        requeuedJobs += recoveredJob.requeuedJobs;
        uncertainAttempts += recoveredJob.uncertainAttempts;
      }
      report.push({
        batchId: batch.batchId,
        status: recovered.status,
        requeuedJobs,
        uncertainAttempts,
        skipped: null,
      });
    }
    return { batches: report };
  }

  // -------------------------------------------------------------------------------------
  // Claiming
  // -------------------------------------------------------------------------------------

  /**
   * Validate the gateway's advertised contract before any batch state is claimed.
   *
   * An unimplemented provider, or a `maxConcurrency` that is not a finite positive integer, is a
   * configuration error: refusing here leaves the batch `pending` with no lease, no attempt row
   * and no counter movement, so the very same batch can run unchanged once the gateway is fixed.
   * Nothing is written before this check, which is why it must run before `claimBatch`.
   */
  private requireCapabilities(batchId: string): ModelCapabilities {
    const capabilities = this.gateway.capabilities();
    invariant(
      capabilities.implemented,
      'invalid_input',
      `model provider ${capabilities.provider} advertises no implementation; refusing to run batch ${batchId}`,
      { batchId, provider: capabilities.provider },
    );
    invariant(
      Number.isInteger(capabilities.maxConcurrency) &&
        Number.isFinite(capabilities.maxConcurrency) &&
        capabilities.maxConcurrency > 0,
      'invalid_input',
      `model provider ${capabilities.provider} advertises an invalid maxConcurrency (${String(
        capabilities.maxConcurrency,
      )}); refusing to run batch ${batchId}`,
      { batchId, provider: capabilities.provider, maxConcurrency: capabilities.maxConcurrency },
    );
    return capabilities;
  }

  private async claimBatch(batchId: string): Promise<AnalysisBatch> {
    return this.store.transaction(async () => {
      const batch = await this.store.getBatch(batchId);
      if (!batch) {
        throw new DomainError('missing_reference', `batch ${batchId} does not exist`, { batchId });
      }
      this.assertExecutable(batch);
      if (batch.status === 'completed' || batch.status === 'cancelled') {
        return batch;
      }
      if (batch.status === 'paused') {
        // Re-read inside the transaction: a pause that landed between `run`'s initial read and
        // this claim must refuse instead of being overwritten by a lease.
        throw new DomainError('invalid_transition', `batch ${batchId} is paused; resume it before running`, {
          batchId,
        });
      }
      if (batch.status === 'failed') {
        throw new DomainError('invalid_transition', `batch ${batchId} is failed; resume it before running`, {
          batchId,
        });
      }
      const at = this.now();
      if (batch.status === 'running' && Date.parse(batch.leaseExpiresAt ?? at) > Date.parse(at)) {
        // A live lease is refused for every owner, including this instance's own owner string:
        // only an expired lease may be taken over, and `recover` can reclaim it explicitly.
        throw new DomainError(
          'invalid_transition',
          `batch ${batchId} is owned by ${String(batch.owner)} until ${String(batch.leaseExpiresAt)}`,
          { batchId, owner: batch.owner, leaseExpiresAt: batch.leaseExpiresAt },
        );
      }
      const next: AnalysisBatch = {
        ...batch,
        status: 'running',
        owner: this.owner,
        leaseExpiresAt: new Date(Date.parse(at) + this.batchLeaseMs).toISOString(),
        updatedAt: at,
        lastError: null,
      };
      const revision = await this.store.saveBatch(next, batch.revision);
      return { ...next, revision };
    });
  }

  private async claimJobForBatch(
    batchId: string,
    spec: AnalysisBatchJob,
    token: CancellationToken,
  ): Promise<ClaimResult> {
    token.throwIfCancelled();
    return this.store.transaction(async () => {
      const batch = await this.store.getBatch(batchId);
      if (!batch) {
        return { kind: 'skip', reason: 'batch_missing' };
      }
      if (batch.status !== 'running' || batch.owner !== this.owner) {
        return { kind: 'skip', reason: `batch_${batch.status}` };
      }
      const at = this.now();
      if (Date.parse(batch.leaseExpiresAt ?? at) <= Date.parse(at)) {
        return { kind: 'skip', reason: 'batch_lease_expired' };
      }
      const job = await this.store.getJob(spec.jobId);
      if (!job) {
        throw new DomainError('missing_reference', `batch ${batchId} references job ${spec.jobId} which is not stored`, {
          batchId,
          jobId: spec.jobId,
        });
      }
      if (job.status === 'succeeded' || job.status === 'cancelled' || job.status === 'failed') {
        return { kind: 'skip', reason: `job_${job.status}` };
      }
      if (job.status === 'paused_quota') {
        // Only an explicit resume() may lift a quota pause.
        return { kind: 'skip', reason: 'job_paused_quota' };
      }
      if (job.status === 'running' && Date.parse(job.leaseExpiresAt ?? at) > Date.parse(at)) {
        return { kind: 'skip', reason: 'job_lease_live' };
      }
      const snapshot = await this.store.getSnapshot(spec.snapshotId);
      if (!snapshot) {
        throw new DomainError(
          'missing_reference',
          `job ${spec.jobId} references snapshot ${spec.snapshotId} which is not stored`,
          { jobId: spec.jobId, snapshotId: spec.snapshotId },
        );
      }
      const head = await this.store.getCurrentSnapshotHead(snapshot.problem.ref);
      const current =
        head !== null &&
        head.snapshotId === snapshot.snapshotId &&
        head.contentHash === snapshot.contentHash &&
        head.version === snapshot.version;
      if (!current) {
        // The snapshot was superseded before the job started: fail it explicitly instead of
        // spending a model call on material that can no longer be adopted.
        await this.store.saveJob(
          transitionJob(job, {
            type: 'fail',
            at,
            error: {
              code: 'stale_snapshot',
              message: `snapshot ${snapshot.snapshotId} is no longer the current head of ${snapshot.problem.key}`,
              retryable: false,
            },
            limits: this.limits.job,
          }),
        );
        return { kind: 'skip', reason: 'stale_snapshot' };
      }
      const expectedRevision = spec.manualRevision;
      invariant(
        expectedRevision !== undefined,
        'invalid_input',
        `batch job ${spec.jobId} has no captured manual revision; recreate the batch from its snapshots`,
        { batchId, jobId: spec.jobId },
      );
      const manualRevision = await this.store.getManualRevision(snapshot.problem.key);
      if (manualRevision !== expectedRevision) {
        // A human decision landed after the batch was prepared: fail the job before any paid
        // call instead of adopting against a revision the batch never captured.
        await this.store.saveJob(
          transitionJob(job, {
            type: 'fail',
            at,
            error: {
              code: 'manual_revision_changed',
              message: `manual decisions of ${snapshot.problem.key} changed after batch ${batchId} was prepared`,
              retryable: false,
            },
            limits: this.limits.job,
          }),
        );
        return { kind: 'skip', reason: 'manual_revision_changed' };
      }
      const started =
        job.status === 'running'
          ? transitionJob(transitionJob(job, { type: 'requeue', at }), {
              type: 'start',
              owner: this.owner,
              at,
              leaseMs: this.leaseMs,
            })
          : transitionJob(job, { type: 'start', owner: this.owner, at, leaseMs: this.leaseMs });
      await this.store.saveJob(started);
      const renewed: AnalysisBatch = {
        ...batch,
        leaseExpiresAt: new Date(
          Math.max(Date.parse(batch.leaseExpiresAt ?? at), Date.parse(at) + this.batchLeaseMs),
        ).toISOString(),
        updatedAt: at,
      };
      await this.store.saveBatch(renewed, batch.revision);
      return { kind: 'run', claim: { batchId, jobSpec: spec, job: started, snapshot, manualRevision: expectedRevision } };
    });
  }

  // -------------------------------------------------------------------------------------
  // Job execution
  // -------------------------------------------------------------------------------------

  private async processJob(
    batchId: string,
    spec: AnalysisBatchJob,
    token: CancellationToken,
    pause: { requested: boolean },
  ): Promise<AnalysisJobOutcome> {
    const claim = await this.claimJobForBatch(batchId, spec, token);
    if (claim.kind === 'skip') {
      return this.outcomeOf(spec, await this.store.getJob(spec.jobId), claim.reason);
    }
    try {
      return await this.executeJob(claim.claim, token, pause);
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === 'cancelled') {
          return this.outcomeOf(spec, await this.store.getJob(spec.jobId), 'cancelled');
        }
        return this.failJob(claim.claim, { code: error.code, message: error.message, retryable: false });
      }
      throw error;
    }
  }

  private async executeJob(
    claim: ClaimedJob,
    token: CancellationToken,
    pause: { requested: boolean },
  ): Promise<AnalysisJobOutcome> {
    const availability = classifySnapshotAvailability(claim.snapshot);
    if (availability.kind === 'operational') {
      return this.failJob(claim, { code: availability.code, message: availability.detail, retryable: false });
    }
    if (availability.kind === 'unknown_sources') {
      return this.failJob(claim, { code: 'editorial_unknown', message: availability.detail, retryable: false });
    }
    if (availability.kind === 'missing_statement') {
      return this.failJob(claim, { code: 'missing_statement', message: availability.detail, retryable: false });
    }
    if (availability.kind === 'absent') {
      return this.runReasoningJob(claim, token, pause);
    }
    return this.runAnalysisJob(claim, token, pause);
  }

  private async runAnalysisJob(
    claim: ClaimedJob,
    token: CancellationToken,
    pause: { requested: boolean },
  ): Promise<AnalysisJobOutcome> {
    let suggestions: readonly AiTagSuggestion[];
    const reused = await this.reusableAnalyzeOutcome(claim);
    if (reused) {
      // Durable resume: the analysis pass was already paid for and settled, so only the
      // verification pass runs again.
      suggestions = reused.suggestions;
    } else {
      const analyzed = await this.callRole<AnalyzeOutcome>(claim, 'analysis', token, pause, (attemptId, callToken) =>
        this.gateway.analyze({
          snapshot: claim.snapshot,
          taxonomy: this.taxonomy,
          token: callToken,
          limits: this.limits,
          roles: this.roles,
          attemptId,
          promptVersion: this.promptVersionFor('analysis'),
        }),
      );
      if (analyzed.kind !== 'ok') {
        return this.handleCallStop(claim, analyzed);
      }
      suggestions = analyzed.value.suggestions;
    }
    let verifications: readonly SuggestionVerification[] = [];
    if (suggestions.length > 0) {
      const verified = await this.callRole<VerifyOutcome>(claim, 'verification', token, pause, (attemptId, callToken) =>
        this.gateway.verify({
          snapshot: claim.snapshot,
          taxonomy: this.taxonomy,
          suggestions,
          token: callToken,
          limits: this.limits,
          roles: this.roles,
          attemptId,
          promptVersion: this.promptVersionFor('verification'),
        }),
      );
      if (verified.kind !== 'ok') {
        return this.handleCallStop(claim, verified);
      }
      verifications = verified.value.verifications;
    }
    return this.adoptOrRefuse(claim, { suggestions, verifications, reasoningDrafts: [] }, token, pause);
  }

  private async runReasoningJob(
    claim: ClaimedJob,
    token: CancellationToken,
    pause: { requested: boolean },
  ): Promise<AnalysisJobOutcome> {
    const drafted = await this.callRole<ReasonOutcome>(claim, 'reasoning', token, pause, (attemptId, callToken) =>
      this.gateway.reason({
        snapshot: claim.snapshot,
        taxonomy: this.taxonomy,
        reason: 'editorial_absent',
        token: callToken,
        limits: this.limits,
        roles: this.roles,
        attemptId,
        promptVersion: this.promptVersionFor('reasoning'),
      }),
    );
    if (drafted.kind !== 'ok') {
      return this.handleCallStop(claim, drafted);
    }
    return this.adoptOrRefuse(
      claim,
      { suggestions: [], verifications: [], reasoningDrafts: drafted.value.drafts },
      token,
      pause,
    );
  }

  /**
   * One role call with the pipeline's retry budget.
   *
   * Each iteration reserves and counts a fresh attempt before dispatch. A retryable declared
   * error spends one retry: the job returns to `pending` with its counters bumped and is
   * restarted immediately. When the retry or attempt budget is exhausted the call is reported
   * as a non-retryable failure, so the job cannot silently stay schedulable. A declared
   * `quota_exhausted` and a refusal (`stale_snapshot`, `manual_revision_changed`, `unsupported`)
   * are never retried: the first pauses the batch, the second fails the job before it can spend.
   */
  private async callRole<T>(
    claim: ClaimedJob,
    role: ModelCallRole,
    token: CancellationToken,
    pause: { requested: boolean },
    invoke: (attemptId: string, token: CancellationToken) => Promise<ModelCallResult<T>>,
  ): Promise<RoleCallOutcome<T>> {
    let retriesLeft = this.maxRetries;
    for (;;) {
      if (token.cancelled) {
        return { kind: 'stopped', reason: 'cancelled' };
      }
      if (pause.requested) {
        return { kind: 'stopped', reason: 'paused' };
      }
      const reservation = await this.reserveAttempt(claim, role);
      if (reservation.kind === 'quota') {
        return { kind: 'quota', reason: reservation.reason };
      }
      if (reservation.kind === 'refused') {
        return { kind: 'error', error: reservation.error };
      }
      if (reservation.kind === 'stopped') {
        return { kind: 'stopped', reason: reservation.reason };
      }
      const attempt = reservation.attempt;
      let result: ModelCallResult<T>;
      try {
        result = await invoke(attempt.attemptId, token);
      } catch (error) {
        // Unknown outcome: the call was dispatched, so it stays on the books as uncertain and
        // is never silently retried.
        await this.markUncertain(attempt, `model ${role} call threw: ${describeError(error)}`);
        return {
          kind: 'error',
          error: {
            code: 'provider_error',
            message: `model ${role} call threw: ${describeError(error)}`,
            retryable: false,
          },
        };
      }
      await this.settleAttempt(attempt, result);
      if (result.ok) {
        return { kind: 'ok', value: result.value, usage: result.usage };
      }
      if (result.error.code === 'cancelled') {
        return { kind: 'stopped', reason: pause.requested ? 'paused' : 'cancelled' };
      }
      if (result.error.code === 'quota_exhausted') {
        // A provider quota stop is not a transient call error: retrying it would burn the rest of
        // the budget for nothing. Pause the batch persistently instead of failing it.
        return { kind: 'quota', reason: result.error.message };
      }
      if (result.error.retryable && retriesLeft > 0) {
        const retry = await this.registerRetry(claim, result.error);
        if (retry === 'planned') {
          retriesLeft -= 1;
          continue;
        }
        if (retry === 'lost') {
          return { kind: 'stopped', reason: 'ownership_lost' };
        }
        return { kind: 'error', error: { ...result.error, retryable: false } };
      }
      return { kind: 'error', error: { ...result.error, retryable: false } };
    }
  }

  private async handleCallStop(
    claim: ClaimedJob,
    outcome: Exclude<RoleCallOutcome<unknown>, { readonly kind: 'ok' }>,
  ): Promise<AnalysisJobOutcome> {
    if (outcome.kind === 'quota') {
      await this.pauseForQuota(claim, outcome.reason);
      return this.outcomeOf(claim.jobSpec, await this.store.getJob(claim.jobSpec.jobId), 'quota_exhausted');
    }
    if (outcome.kind === 'stopped') {
      await this.releaseJob(claim, `analysis interrupted (${outcome.reason})`);
      return this.outcomeOf(claim.jobSpec, await this.store.getJob(claim.jobSpec.jobId), outcome.reason);
    }
    return this.failJob(claim, outcome.error);
  }

  /**
   * Reserve one model call: check capabilities and staleness, then write the `reserved` attempt,
   * consume job and batch budget and renew both leases in a single transaction, before the
   * network call happens.
   */
  private async reserveAttempt(claim: ClaimedJob, role: ModelCallRole): Promise<ReservationResult> {
    // Capability checks come first, outside the transaction: a provider that does not implement
    // the role can never consume job or batch budget, let alone be paid.
    const capabilities = this.gateway.capabilities();
    if (!capabilities.implemented) {
      return {
        kind: 'refused',
        error: {
          code: 'unsupported',
          message: `model provider ${capabilities.provider} advertises no implementation`,
          retryable: false,
        },
      };
    }
    if (!capabilities.roles.includes(role)) {
      return {
        kind: 'refused',
        error: {
          code: 'unsupported',
          message: `model provider ${capabilities.provider} does not implement the ${role} role`,
          retryable: false,
        },
      };
    }
    return this.store.transaction(async () => {
      const batch = await this.store.getBatch(claim.batchId);
      if (!batch) {
        return { kind: 'stopped', reason: 'batch_missing' };
      }
      if (batch.status !== 'running' || batch.owner !== this.owner) {
        return { kind: 'stopped', reason: `batch_${batch.status}` };
      }
      const at = this.now();
      if (Date.parse(batch.leaseExpiresAt ?? at) <= Date.parse(at)) {
        return { kind: 'stopped', reason: 'batch_lease_expired' };
      }
      const job = await this.store.getJob(claim.jobSpec.jobId);
      if (!job) {
        return { kind: 'stopped', reason: 'job_missing' };
      }
      if (job.status !== 'running' || job.leaseOwner !== this.owner) {
        return { kind: 'stopped', reason: `job_${job.status}` };
      }
      if (Date.parse(job.leaseExpiresAt ?? at) <= Date.parse(at)) {
        return { kind: 'stopped', reason: 'job_lease_expired' };
      }
      // Staleness is re-checked before the counter moves. Verification and retry dispatches must
      // not spend after the snapshot head or the manual decisions moved: such a call could never
      // be adopted, so it is refused here instead of being discovered in the commit.
      const head = await this.store.getCurrentSnapshotHead(claim.snapshot.problem.ref);
      const current =
        head !== null &&
        head.snapshotId === claim.snapshot.snapshotId &&
        head.contentHash === claim.snapshot.contentHash &&
        head.version === claim.snapshot.version;
      if (!current) {
        return {
          kind: 'refused',
          error: {
            code: 'stale_snapshot',
            message: `snapshot ${claim.snapshot.snapshotId} is no longer the current head of ${claim.snapshot.problem.key}`,
            retryable: false,
          },
        };
      }
      const manualRevision = await this.store.getManualRevision(claim.snapshot.problem.key);
      if (manualRevision !== claim.manualRevision) {
        return {
          kind: 'refused',
          error: {
            code: 'manual_revision_changed',
            message: `manual decisions of ${claim.snapshot.problem.key} changed while the job was running`,
            retryable: false,
          },
        };
      }
      const kind = budgetKindOfRole(role);
      const limit = kind === 'analysis' ? batch.limits.maxAnalysisCalls : batch.limits.maxReasoningCalls;
      const used = kind === 'analysis' ? batch.counters.analysisCalls : batch.counters.reasoningCalls;
      if (used >= limit) {
        return { kind: 'quota', reason: `batch ${kind} call limit ${limit} reached` };
      }
      const consumed = transitionJob(job, { type: 'consume_call', kind, at, limits: this.limits.job });
      if (consumed.status === 'paused_quota') {
        await this.store.saveJob(consumed);
        return { kind: 'quota', reason: consumed.lastError?.message ?? `${kind} call limit reached for job ${job.jobId}` };
      }
      const attempt: ModelCallAttempt = {
        attemptId: this.uniqueId('attempt'),
        batchId: claim.batchId,
        jobId: claim.jobSpec.jobId,
        snapshotId: claim.snapshot.snapshotId,
        role,
        provider: capabilities.provider,
        model: this.modelFor(role),
        promptVersion: this.promptVersionFor(role),
        requestedAt: at,
        status: 'reserved',
        finishedAt: null,
        hostSessionId: null,
        hostCallId: null,
        usage: null,
        error: null,
        outcome: null,
      };
      await this.store.saveModelCallAttempt(attempt);
      const renewedJob: AnalysisJobState = {
        ...consumed,
        leaseExpiresAt: new Date(
          Math.max(Date.parse(consumed.leaseExpiresAt ?? at), Date.parse(at) + this.leaseMs),
        ).toISOString(),
        updatedAt: at,
      };
      await this.store.saveJob(renewedJob);
      const counters: AnalysisBatchCounters = {
        analysisCalls: batch.counters.analysisCalls + (kind === 'analysis' ? 1 : 0),
        reasoningCalls: batch.counters.reasoningCalls + (kind === 'reasoning' ? 1 : 0),
        retries: batch.counters.retries,
      };
      const renewedBatch: AnalysisBatch = {
        ...batch,
        counters,
        leaseExpiresAt: new Date(
          Math.max(Date.parse(batch.leaseExpiresAt ?? at), Date.parse(at) + this.batchLeaseMs),
        ).toISOString(),
        updatedAt: at,
      };
      await this.store.saveBatch(renewedBatch, batch.revision);
      return { kind: 'reserved', attempt };
    });
  }

  private async settleAttempt<T>(attempt: ModelCallAttempt, result: ModelCallResult<T>): Promise<void> {
    const settled: ModelCallAttempt = {
      ...attempt,
      status: 'settled',
      finishedAt: this.now(),
      hostSessionId: result.sessionId ?? null,
      hostCallId: result.callId,
      usage: result.usage,
      error: result.ok ? null : result.error,
      outcome: result.ok ? outcomeFor(attempt.role, result.value) : null,
    };
    await this.store.saveModelCallAttempt(settled);
  }

  private async markUncertain(attempt: ModelCallAttempt, message: string): Promise<void> {
    const uncertain: ModelCallAttempt = {
      ...attempt,
      status: 'uncertain',
      finishedAt: this.now(),
      usage: null,
      error: { code: 'provider_error', message, retryable: false },
      outcome: null,
    };
    await this.store.saveModelCallAttempt(uncertain);
  }

  private async registerRetry(claim: ClaimedJob, error: ModelGatewayError): Promise<'planned' | 'exhausted' | 'lost'> {
    return this.store.transaction(async () => {
      const batch = await this.store.getBatch(claim.batchId);
      if (!batch || batch.status !== 'running' || batch.owner !== this.owner) {
        return 'lost';
      }
      const job = await this.store.getJob(claim.jobSpec.jobId);
      if (!job || job.status !== 'running' || job.leaseOwner !== this.owner) {
        return 'lost';
      }
      const at = this.now();
      const failed = transitionJob(job, {
        type: 'fail',
        at,
        error: { code: error.code, message: error.message, retryable: true },
        limits: this.limits.job,
      });
      if (failed.status !== 'pending') {
        // The job attempt budget is exhausted: the retry cannot happen.
        await this.store.saveJob(failed);
        return 'exhausted';
      }
      const restarted = transitionJob(failed, { type: 'start', owner: this.owner, at, leaseMs: this.leaseMs });
      await this.store.saveJob(restarted);
      const counters: AnalysisBatchCounters = { ...batch.counters, retries: batch.counters.retries + 1 };
      const renewed: AnalysisBatch = {
        ...batch,
        counters,
        leaseExpiresAt: new Date(
          Math.max(Date.parse(batch.leaseExpiresAt ?? at), Date.parse(at) + this.batchLeaseMs),
        ).toISOString(),
        updatedAt: at,
      };
      await this.store.saveBatch(renewed, batch.revision);
      return 'planned';
    });
  }

  /** Persist a quota stop: the batch is `paused` and the job `paused_quota`, counts intact. */
  private async pauseForQuota(claim: ClaimedJob, reason: string): Promise<void> {
    await this.store.transaction(async () => {
      const batch = await this.store.getBatch(claim.batchId);
      if (!batch || batch.status !== 'running' || batch.owner !== this.owner) {
        // Another owner took over (or the batch ended): never overwrite newer state.
        return;
      }
      const at = this.now();
      const job = await this.store.getJob(claim.jobSpec.jobId);
      if (job && job.status !== 'succeeded' && job.status !== 'cancelled') {
        await this.store.saveJob(transitionJob(job, { type: 'pause_for_quota', at, reason }));
      }
      const next: AnalysisBatch = {
        ...batch,
        status: 'paused',
        owner: null,
        leaseExpiresAt: null,
        updatedAt: at,
        lastError: { code: 'quota_exhausted', message: reason, retryable: true },
      };
      await this.store.saveBatch(next, batch.revision);
    });
  }

  /**
   * Give up a job we still own without failing it: the interruption (pause, cancellation race,
   * lost batch ownership) is recorded, counters survive and the job returns to `pending` so a
   * later run or an explicit resume can finish it.
   */
  private async releaseJob(claim: ClaimedJob, reason: string): Promise<void> {
    await this.store.transaction(async () => {
      const job = await this.store.getJob(claim.jobSpec.jobId);
      if (!job || job.status === 'succeeded' || job.status === 'cancelled' || job.status === 'paused_quota') {
        return;
      }
      if (job.status !== 'running' || job.leaseOwner !== this.owner) {
        // Only a lease we still own may be released; anything else is newer state.
        return;
      }
      const at = this.now();
      let next = transitionJob(job, {
        type: 'fail',
        at,
        error: { code: 'interrupted', message: reason, retryable: true },
        limits: this.limits.job,
      });
      if (next.status === 'failed') {
        // Interruptions must not exhaust the job's attempt budget.
        next = transitionJob(next, { type: 'requeue', at });
      }
      await this.store.saveJob(next);
    });
  }

  private async failJob(claim: ClaimedJob, error: AnalysisBatchError): Promise<AnalysisJobOutcome> {
    await this.store.transaction(async () => {
      const job = await this.store.getJob(claim.jobSpec.jobId);
      if (!job || job.status === 'succeeded' || job.status === 'cancelled' || job.status === 'failed') {
        return;
      }
      if (job.status === 'running' && job.leaseOwner !== this.owner) {
        // Another owner holds a live lease: its state is newer than our view.
        return;
      }
      const at = this.now();
      await this.store.saveJob(transitionJob(job, { type: 'fail', at, error, limits: this.limits.job }));
    });
    return this.outcomeOf(claim.jobSpec, await this.store.getJob(claim.jobSpec.jobId), error.code);
  }

  /**
   * Commit an analysis result, or turn a refusal into persisted state.
   *
   * A stop observed before any write is a plain refusal; a stop observed after a write throws the
   * internal {@link AdoptionRollback} signal from inside the transaction, so the store rolls every
   * write back — returning a refusal instead would commit a partial adoption. Only that signal is
   * caught here; the abort is then persisted by `handleAbort` outside the transaction.
   */
  private async adoptOrRefuse(
    claim: ClaimedJob,
    content: AdoptableContent,
    token: CancellationToken,
    pause: { requested: boolean },
  ): Promise<AnalysisJobOutcome> {
    let commit: CommitResult;
    try {
      commit = await this.commitAdoption(claim, content, token, pause);
    } catch (error) {
      // ONLY the internal rollback signal is handled here: a storage failure (rollback_failed,
      // revision_conflict, …) must keep propagating to the caller.
      if (error instanceof AdoptionRollback) {
        return this.handleAbort(claim, error.reason);
      }
      throw error;
    }
    if (commit.kind === 'adopted') {
      return {
        jobId: claim.jobSpec.jobId,
        snapshotId: claim.snapshot.snapshotId,
        status: 'succeeded',
        analysisId: commit.analysisId,
        error: null,
        skipped: null,
      };
    }
    return this.handleAbort(claim, commit.reason);
  }

  /**
   * The adoption transaction itself.
   *
   * Everything that must still hold is re-read inside one transaction — batch status/owner and
   * lease, job status/owner and lease, snapshot head (id, hash, version) and the captured manual
   * revision — and the cancellation/pause state is re-checked after every await **and after every
   * write**. A stop before the first write is returned as a refusal (nothing was written, so
   * letting the read-only transaction commit is harmless); a stop after a write throws
   * {@link AdoptionRollback}, because returning a refusal would commit a partial adoption.
   *
   * Linearization: this commit transaction is the linearization point. `pause` and `cancel`
   * persist through the same store, so their write transactions serialize with this one:
   * whichever commits first wins. A pause/cancel that persists before this transaction's re-read
   * is refused; one observed in-process while this transaction runs rolls it back; one that lands
   * after this transaction has committed does not undo the adoption — the adopted result stays
   * durable and only subsequent work sees the paused/cancelled state.
   *
   * A paused, cancelled, lost or expired job leaves the paid result as audit only. The recorded
   * usage is read from this job's persisted settled attempts.
   */
  private async commitAdoption(
    claim: ClaimedJob,
    content: AdoptableContent,
    token: CancellationToken,
    pause: { requested: boolean },
  ): Promise<CommitResult> {
    const abort = (reason: AbortReason): CommitResult => ({ kind: 'aborted', reason });
    // `paused` wins over `cancelled`: pausing cancels the local token as well, and a pause must
    // stay resumable instead of becoming a terminal cancellation.
    const stopReason = (): AbortReason | null => (pause.requested ? 'paused' : token.cancelled ? 'cancelled' : null);
    /** A stop after a write must roll the transaction back; returning would commit it. */
    const rollbackIfStopped = (): void => {
      const reason = stopReason();
      if (reason !== null) {
        throw new AdoptionRollback(reason);
      }
    };
    return this.store.transaction(async (): Promise<CommitResult> => {
      const firstStop = stopReason();
      if (firstStop) {
        return abort(firstStop);
      }
      const batch = await this.store.getBatch(claim.batchId);
      const afterBatch = stopReason();
      if (afterBatch) {
        return abort(afterBatch);
      }
      if (!batch || batch.status === 'cancelled') {
        return abort('batch_cancelled');
      }
      if (batch.status === 'paused') {
        return abort('paused');
      }
      if (batch.status !== 'running' || batch.owner !== this.owner) {
        return abort('ownership_lost');
      }
      const at = this.now();
      if (Date.parse(batch.leaseExpiresAt ?? at) <= Date.parse(at)) {
        return abort('lease_expired');
      }
      const job = await this.store.getJob(claim.jobSpec.jobId);
      const afterJob = stopReason();
      if (afterJob) {
        return abort(afterJob);
      }
      if (!job || job.status === 'cancelled') {
        return abort('job_cancelled');
      }
      if (job.status !== 'running' || job.leaseOwner !== this.owner) {
        return abort('job_not_running');
      }
      if (Date.parse(job.leaseExpiresAt ?? at) <= Date.parse(at)) {
        // Another job of the batch may have renewed the batch lease while this job's own lease
        // ran out: an old result must not be adopted on the strength of the batch lease alone.
        return abort('lease_expired');
      }
      const head = await this.store.getCurrentSnapshotHead(claim.snapshot.problem.ref);
      const afterHead = stopReason();
      if (afterHead) {
        return abort(afterHead);
      }
      const current =
        head !== null &&
        head.snapshotId === claim.snapshot.snapshotId &&
        head.contentHash === claim.snapshot.contentHash &&
        head.version === claim.snapshot.version;
      if (!current) {
        return abort('stale_snapshot');
      }
      const manualRevision = await this.store.getManualRevision(claim.snapshot.problem.key);
      const afterRevision = stopReason();
      if (afterRevision) {
        return abort(afterRevision);
      }
      if (manualRevision !== claim.manualRevision) {
        return abort('manual_revision_changed');
      }
      const usage = await this.settledUsage(claim);
      const manualDecisions = await this.store.listManualDecisions(claim.snapshot.problem.key);
      const afterDecisions = stopReason();
      if (afterDecisions) {
        return abort(afterDecisions);
      }
      const result = createAnalysisResult({
        problemRef: claim.snapshot.problem.ref,
        snapshotId: claim.snapshot.snapshotId,
        snapshotVersion: claim.snapshot.version,
        taxonomyVersion: this.taxonomy.version,
        createdAt: at,
        status: 'completed',
        suggestions: content.suggestions,
        verifications: content.verifications,
        reasoningDrafts: content.reasoningDrafts,
        usage,
        failure: null,
      });
      const resolved = resolveTagDecisions({
        index: this.index,
        snapshot: claim.snapshot,
        analysis: result,
        currentHead: head,
        manualDecisions,
        settings: { minExcerptChars: this.minExcerptChars },
      });
      await this.store.saveAnalysis(result);
      rollbackIfStopped();
      await this.store.saveTagDecisions(resolved.decisions);
      rollbackIfStopped();
      await this.store.saveJob(transitionJob(job, { type: 'succeed', at, analysisId: result.analysisId }));
      rollbackIfStopped();
      await this.store.saveBatch({ ...batch, updatedAt: at }, batch.revision);
      // Immediately before the transaction resolves: a pause/cancellation that landed during the
      // last write must still roll every write of this transaction back.
      rollbackIfStopped();
      return { kind: 'adopted', analysisId: result.analysisId };
    });
  }

  /**
   * Turn a refused commit into persisted state.
   *
   * A cancellation (token cancelled without a `cancel()` call) becomes a terminal batch/job
   * cancellation; a pause returns the job to `pending` so `resume` continues from the paid
   * result; staleness fails the job explicitly; anything else releases the lease without
   * touching newer state.
   */
  private async handleAbort(claim: ClaimedJob, reason: AbortReason): Promise<AnalysisJobOutcome> {
    if (reason === 'cancelled') {
      await this.cancelPersisted(claim.batchId);
      return this.outcomeOf(claim.jobSpec, await this.store.getJob(claim.jobSpec.jobId), reason);
    }
    if (reason === 'batch_cancelled' || reason === 'job_cancelled') {
      return this.outcomeOf(claim.jobSpec, await this.store.getJob(claim.jobSpec.jobId), reason);
    }
    if (reason === 'paused') {
      await this.releaseJob(claim, 'analysis interrupted (paused)');
      return this.outcomeOf(claim.jobSpec, await this.store.getJob(claim.jobSpec.jobId), reason);
    }
    if (reason === 'stale_snapshot' || reason === 'manual_revision_changed') {
      return this.failJob(claim, {
        code: reason,
        message:
          reason === 'stale_snapshot'
            ? `snapshot ${claim.snapshot.snapshotId} changed while the model was running; the result was not adopted`
            : `manual decisions changed while the model was running; the result was not adopted`,
        retryable: false,
      });
    }
    await this.releaseJob(claim, `analysis interrupted (${reason})`);
    return this.outcomeOf(claim.jobSpec, await this.store.getJob(claim.jobSpec.jobId), reason);
  }

  /**
   * A settled analysis pass of this batch/job that may be reused for this run.
   *
   * Identity must match on every input that shaped the paid call: the manual revision the batch
   * captured, the snapshot, the provider, the model and the effective prompt version — which
   * includes the taxonomy version the model actually saw, so a resumed batch under a different
   * taxonomy never reuses an outcome produced under the old one.
   */
  private async reusableAnalyzeOutcome(claim: ClaimedJob): Promise<AnalyzeOutcome | null> {
    if (claim.jobSpec.manualRevision !== claim.manualRevision) {
      return null;
    }
    const attempts = await this.store.listModelCallAttempts({
      batchId: claim.batchId,
      jobId: claim.jobSpec.jobId,
      status: 'settled',
    });
    const provider = this.gateway.capabilities().provider;
    const model = this.modelFor('analysis');
    const promptVersion = this.promptVersionFor('analysis');
    for (const attempt of attempts) {
      if (
        attempt.role === 'analysis' &&
        attempt.snapshotId === claim.snapshot.snapshotId &&
        attempt.provider === provider &&
        attempt.model === model &&
        attempt.promptVersion === promptVersion &&
        attempt.outcome !== null &&
        attempt.outcome.kind === 'analysis'
      ) {
        return attempt.outcome.value;
      }
    }
    return null;
  }

  /**
   * Usage of every persisted **settled** attempt of this batch/job.
   *
   * Deliberately not the sum of the calls this run happened to observe: a reused analysis pass
   * and settled retry failures were paid for as well. An attempt without usage (still
   * `uncertain`) is skipped rather than estimated, and is reported as a separate count.
   */
  private async settledUsage(claim: ClaimedJob): Promise<ModelUsage | null> {
    const attempts = await this.store.listModelCallAttempts({
      batchId: claim.batchId,
      jobId: claim.jobSpec.jobId,
      status: 'settled',
    });
    return sumUsage(attempts.map((attempt) => attempt.usage).filter((usage): usage is ModelUsage => usage !== null));
  }

  private async recoverJob(jobId: string, at: string): Promise<{ requeuedJobs: number; uncertainAttempts: number }> {
    return this.store.transaction(async () => {
      const job = await this.store.getJob(jobId);
      if (job && job.status === 'running') {
        if (Date.parse(job.leaseExpiresAt ?? at) > Date.parse(at)) {
          // Live lease of another owner: never touched.
          return { requeuedJobs: 0, uncertainAttempts: 0 };
        }
        await this.store.saveJob(transitionJob(job, { type: 'requeue', at }));
      }
      const fresh = await this.store.getJob(jobId);
      if (fresh && fresh.status === 'running') {
        return { requeuedJobs: 0, uncertainAttempts: 0 };
      }
      const reserved = await this.store.listModelCallAttempts({ jobId, status: 'reserved' });
      for (const attempt of reserved) {
        const uncertain: ModelCallAttempt = {
          ...attempt,
          status: 'uncertain',
          finishedAt: at,
          usage: null,
          error: null,
          outcome: null,
        };
        await this.store.saveModelCallAttempt(uncertain);
      }
      return { requeuedJobs: job?.status === 'running' ? 1 : 0, uncertainAttempts: reserved.length };
    });
  }

  /** Re-read what the workers did and close the batch explicitly. */
  private async finalizeBatch(batchId: string): Promise<void> {
    await this.store.transaction(async () => {
      const batch = await this.store.getBatch(batchId);
      if (!batch || batch.status !== 'running' || batch.owner !== this.owner) {
        return;
      }
      const statuses: AnalysisJobStatus[] = [];
      let firstError: AnalysisBatchError | null = null;
      for (const spec of batch.jobs) {
        const job = await this.store.getJob(spec.jobId);
        statuses.push(job?.status ?? 'failed');
        if (firstError === null && job?.lastError) {
          firstError = job.lastError;
        }
      }
      const at = this.now();
      let status: AnalysisBatchStatus;
      let lastError: AnalysisBatchError | null;
      if (statuses.every((entry) => entry === 'succeeded')) {
        status = 'completed';
        lastError = null;
      } else if (statuses.some((entry) => entry === 'paused_quota')) {
        status = 'paused';
        lastError = firstError ?? {
          code: 'quota_exhausted',
          message: 'analysis call budget exhausted',
          retryable: true,
        };
      } else if (statuses.some((entry) => entry === 'pending' || entry === 'running')) {
        status = 'pending';
        lastError = firstError;
      } else if (statuses.every((entry) => entry === 'cancelled')) {
        status = 'cancelled';
        lastError = firstError;
      } else {
        status = 'failed';
        lastError = firstError ?? {
          code: 'job_failed',
          message: 'one or more analysis jobs failed',
          retryable: false,
        };
      }
      const next: AnalysisBatch = {
        ...batch,
        status,
        owner: null,
        leaseExpiresAt: null,
        updatedAt: at,
        lastError,
      };
      await this.store.saveBatch(next, batch.revision);
    });
  }

  private async summarize(batch: AnalysisBatch, outcomes: readonly AnalysisJobOutcome[]): Promise<AnalysisRunSummary> {
    const skippedByJob = new Map(outcomes.map((outcome) => [outcome.jobId, outcome.skipped] as const));
    const jobs: AnalysisJobOutcome[] = [];
    for (const spec of batch.jobs) {
      const job = await this.store.getJob(spec.jobId);
      jobs.push({
        jobId: spec.jobId,
        snapshotId: spec.snapshotId,
        status: job?.status ?? 'failed',
        analysisId: job?.analysisId ?? null,
        error: job?.lastError ?? null,
        skipped: skippedByJob.get(spec.jobId) ?? null,
      });
    }
    const current = (await this.store.getBatch(batch.batchId)) ?? batch;
    const uncertain = await this.store.listModelCallAttempts({ batchId: current.batchId, status: 'uncertain' });
    return {
      batchId: current.batchId,
      status: current.status,
      jobs,
      counters: current.counters,
      pausedForQuota: current.status === 'paused' || outcomes.some((outcome) => outcome.status === 'paused_quota'),
      uncertainAttempts: uncertain.length,
    };
  }

  private outcomeOf(spec: AnalysisBatchJob, job: AnalysisJobState | null, skipped: string): AnalysisJobOutcome {
    return {
      jobId: spec.jobId,
      snapshotId: spec.snapshotId,
      status: job?.status ?? 'failed',
      analysisId: job?.analysisId ?? null,
      error: job?.lastError ?? null,
      skipped,
    };
  }

  private modelFor(role: ModelCallRole): string {
    if (role === 'analysis') {
      return this.roles.analysisModel;
    }
    if (role === 'verification') {
      return this.roles.verificationModel;
    }
    return this.roles.reasoningModel;
  }

  /**
   * Prompt identity recorded on an attempt and sent to the gateway.
   *
   * The taxonomy version is part of the model input, so it is part of the prompt identity: a
   * resumed batch that would run under a different taxonomy must not reuse an outcome that was
   * produced under the old one. Requests and attempts share this one value, so a provider-side
   * cache keyed on it stays aligned with the recorded provenance.
   */
  private promptVersionFor(role: ModelCallRole): string {
    return `${this.promptVersions[role]}|taxonomy:${this.taxonomy.version}`;
  }

  /**
   * A batch is executable only when every job recorded the manual revision it was prepared
   * against. A legacy record without it refuses to execute: assuming the current revision
   * could silently override a human decision made after the batch was created.
   */
  private assertExecutable(batch: AnalysisBatch): void {
    const legacy = batch.jobs.filter(
      (job) => !Number.isInteger(job.manualRevision) || (job.manualRevision ?? -1) < 0,
    );
    invariant(
      legacy.length === 0,
      'invalid_input',
      `batch ${batch.batchId} does not record the captured manual revision of job(s) ${legacy
        .map((job) => job.jobId)
        .join(', ')}; recreate the batch from its snapshots before running it`,
      { batchId: batch.batchId, jobIds: legacy.map((job) => job.jobId) },
    );
  }
}

function outcomeFor(role: ModelCallRole, value: unknown): ModelCallOutcome {
  if (role === 'analysis') {
    return { kind: 'analysis', value: value as AnalyzeOutcome };
  }
  if (role === 'verification') {
    return { kind: 'verification', value: value as VerifyOutcome };
  }
  return { kind: 'reasoning', value: value as ReasonOutcome };
}

function sumUsage(usages: readonly ModelUsage[]): ModelUsage | null {
  if (usages.length === 0) {
    return null;
  }
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  for (const usage of usages) {
    calls += usage.calls;
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    totalTokens += usage.totalTokens;
  }
  return createModelUsage({ calls, promptTokens, completionTokens, totalTokens });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'unknown error';
}
