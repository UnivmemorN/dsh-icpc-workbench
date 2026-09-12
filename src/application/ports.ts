/**
 * Application ports.
 *
 * Stage 1 defines contracts only — no implementation lives here. Adapters (platform, model,
 * storage) implement these interfaces; the plugin composes them. Consequences that matter:
 *
 * - **No implementation imports.** This module imports `domain` and nothing else, so the
 *   application layer cannot depend on Cordis, SQLite, HTTP clients or provider SDKs.
 * - **Explicit limits.** Every rate, timeout, budget and concurrency value is passed in by
 *   the caller as a settings object. Nothing is read from globals or environment variables,
 *   which keeps runtime behaviour testable and prevents hidden quota.
 * - **Cancellation everywhere.** Every IO/LLM call takes a {@link CancellationToken}.
 * - **Honest capabilities.** `implemented: false` marks a contract that has no adapter yet
 *   (Hydro), so the UI can never advertise unimplemented support. The persistence port is
 *   implemented by `adapters/sqlite`.
 */
import type { JobLeaseRequest, SyncCheckpoint, SyncCheckpointRef } from './storage-types.js';
import type {
  AnalysisBatch,
  AnalysisBatchStatus,
  ModelCallAttempt,
  ModelCallAttemptQuery,
} from './batch-types.js';
import type {
  Account,
  AiTagSuggestion,
  AnalysisJobLimits,
  AnalysisJobState,
  AnalysisJobStatus,
  AnalysisResult,
  CancellationToken,
  EditorialSolution,
  EditorialSource,
  ManualTagDecision,
  ModelUsage,
  NormalizedProblem,
  ProblemRef,
  ProblemSnapshot,
  ReasoningDraft,
  Retrospective,
  SnapshotHead,
  SourceInstance,
  SourcePlatform,
  Submission,
  SuggestionVerification,
  TagDecision,
  Taxonomy,
  TrainingPlan,
} from '../domain/index.js';

// ---------------------------------------------------------------------------------------
// Shared request shapes
// ---------------------------------------------------------------------------------------

/** Explicit platform IO limits. Defaults describe the approved v1 policy (CF: >= 2s apart). */
export interface PlatformLimits {
  /** Minimum delay between two requests to the same source instance. */
  readonly minRequestIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  /** Page size requested from the platform. */
  readonly pageSize: number;
  readonly maxConcurrency: number;
}

export const DEFAULT_PLATFORM_LIMITS: PlatformLimits = {
  minRequestIntervalMs: 2000,
  requestTimeoutMs: 30_000,
  maxRetries: 3,
  pageSize: 100,
  maxConcurrency: 1,
};

/** Cursor page request. `cursor === null` asks for the first page. */
export interface PageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

/** One page of results plus the cursor for the next page (`null` when exhausted). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly fetchedAt: string;
}

// ---------------------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------------------

/** What an adapter can actually do. Never advertise more than is implemented. */
export interface PlatformCapabilities {
  readonly platform: SourcePlatform;
  /** False for contracts without an adapter (Hydro in v1). */
  readonly implemented: boolean;
  readonly problems: boolean;
  readonly submissions: boolean;
  readonly editorial: boolean;
  readonly pagedProblems: boolean;
  readonly pagedSubmissions: boolean;
  readonly requiresAuth: boolean;
  readonly supportsAccountHistory: boolean;
  /** Platform-enforced minimum request interval, when the platform documents one. */
  readonly minRequestIntervalMs: number | null;
  readonly notes: readonly string[];
}

export interface ListProblemsRequest extends PageRequest {
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
  /** Optional account scope (some platforms personalise the problem list). */
  readonly account?: Account | null;
}

export interface ListSubmissionsRequest extends PageRequest {
  readonly account: Account;
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
  /** Optional inclusive lower bound for incremental sync (ISO timestamp). */
  readonly since?: string | null;
}

/**
 * Direct problem-detail request.
 *
 * Catalog/list metadata does not contain a statement, so full statements are fetched through
 * this explicit operation. A blocked detail fetch must stay visible as an operational failure
 * instead of being reported as a metadata-only problem.
 */
export interface FetchProblemRequest {
  readonly problemRef: ProblemRef;
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
}

export interface FetchEditorialRequest {
  readonly problemRef: ProblemRef;
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
  /**
   * Optional official tutorial/editorial URL supplied by the caller (for example the
   * attribution of a manual import).
   *
   * An adapter must strictly validate it against its own official origin and article shape
   * *before* issuing any request; it never turns an arbitrary URL into a fetch target.
   */
  readonly officialTutorialUrl?: string | null;
}

/**
 * Editorial retrieval result.
 *
 * The discriminants are part of the contract because the product treats them differently:
 * `absent` means an analysis may fall back to the reasoning role, while auth/forbidden/
 * rate-limit/unavailable/changed-response are operational failures that must never be
 * disguised as "no editorial" (that would spend reasoning budget on a broken request).
 */
export type EditorialFetchResult =
  | {
      readonly status: 'found';
      readonly sources: readonly EditorialSource[];
      readonly solutions: readonly EditorialSolution[];
      readonly retrievedAt: string;
    }
  | { readonly status: 'absent'; readonly detail: string }
  | { readonly status: 'auth_required'; readonly detail: string }
  | { readonly status: 'forbidden'; readonly detail: string }
  | { readonly status: 'rate_limited'; readonly detail: string; readonly retryAfterMs: number | null }
  | { readonly status: 'unavailable'; readonly detail: string; readonly retryable: boolean }
  | { readonly status: 'changed_response'; readonly detail: string; readonly sample: string | null };

/**
 * One platform implementation bound to one source instance.
 * Implementations must honour `limits`, observe `token`, and normalise payloads into
 * domain types (runtime validation of external payloads happens here, not in the domain).
 */
export interface PlatformAdapter {
  readonly sourceInstance: SourceInstance;
  capabilities(): PlatformCapabilities;
  listProblems(request: ListProblemsRequest): Promise<Page<NormalizedProblem>>;
  listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>>;
  /** Fetch one problem's full detail, including its statement when the platform has one. */
  fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem>;
  fetchEditorial(request: FetchEditorialRequest): Promise<EditorialFetchResult>;
}

// ---------------------------------------------------------------------------------------
// Model gateway
// ---------------------------------------------------------------------------------------

/** Explicit model budget/selection. Roles map to configured model ids. */
export interface ModelRoleSettings {
  readonly analysisModel: string;
  readonly verificationModel: string;
  readonly reasoningModel: string;
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

/** Explicit call budgets. Defaults mirror the approved v1 limits. */
export interface ModelLimits {
  readonly maxAnalysisCalls: number;
  readonly maxReasoningCalls: number;
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly job: AnalysisJobLimits;
}

export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  maxAnalysisCalls: 50,
  maxReasoningCalls: 5,
  concurrency: 2,
  requestTimeoutMs: 60_000,
  maxRetries: 2,
  job: { maxAnalysisCalls: 50, maxReasoningCalls: 5, maxAttempts: 2, leaseMs: 120_000 },
};

export interface ModelCapabilities {
  readonly provider: string;
  readonly implemented: boolean;
  readonly roles: readonly ('analysis' | 'verification' | 'reasoning')[];
  readonly maxConcurrency: number;
  readonly notes: readonly string[];
}

export type ModelErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'invalid_output'
  | 'provider_error'
  | 'unsupported';

export interface ModelGatewayError {
  readonly code: ModelErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Result of one model call. Usage is reported even on failure (a failed call still costs).
 *
 * `attemptId` (request) and `callId`/`sessionId` (result) exist so the host can correlate a
 * durable {@link ModelCallAttempt} with its own model log. The pipeline sets `attemptId` from
 * the reservation it persisted *before* dispatch and stores `callId`/`sessionId` on the
 * settled attempt; a gateway that cannot report a session leaves `sessionId` unset.
 */
export type ModelCallResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly usage: ModelUsage;
      readonly callId: string;
      readonly sessionId?: string | null;
    }
  | {
      readonly ok: false;
      readonly error: ModelGatewayError;
      readonly usage: ModelUsage;
      readonly callId: string;
      readonly sessionId?: string | null;
    };

export interface AnalyzeRequest {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: Taxonomy;
  readonly token: CancellationToken;
  readonly limits: ModelLimits;
  readonly roles: ModelRoleSettings;
  /** Durable attempt this call was reserved as; echoed into the host's own logs. */
  readonly attemptId?: string;
  /**
   * Prompt identity the caller recorded for this dispatch.
   *
   * Optional because a gateway may be driven directly, but the analysis pipeline always sets it
   * to the same effective identity it persists on the durable attempt, so a provider-side cache
   * keyed on the prompt stays aligned with the recorded provenance of the call.
   */
  readonly promptVersion?: string;
}

export interface VerifyRequest {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: Taxonomy;
  readonly suggestions: readonly AiTagSuggestion[];
  readonly token: CancellationToken;
  readonly limits: ModelLimits;
  readonly roles: ModelRoleSettings;
  readonly attemptId?: string;
  /** Prompt identity shared with the persisted attempt; see {@link AnalyzeRequest.promptVersion}. */
  readonly promptVersion?: string;
}

export interface ReasonRequest {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: Taxonomy;
  /** Why the analysis role could not be used; operational errors never reach this call. */
  readonly reason: 'editorial_absent';
  readonly token: CancellationToken;
  readonly limits: ModelLimits;
  readonly roles: ModelRoleSettings;
  readonly attemptId?: string;
  /** Prompt identity shared with the persisted attempt; see {@link AnalyzeRequest.promptVersion}. */
  readonly promptVersion?: string;
}

export interface AnalyzeOutcome {
  readonly suggestions: readonly AiTagSuggestion[];
}

export interface VerifyOutcome {
  readonly verifications: readonly SuggestionVerification[];
}

export interface ReasonOutcome {
  readonly drafts: readonly ReasoningDraft[];
}

/**
 * Model access for the analysis pipeline.
 *
 * `analyze` reads editorial material; `verify` is the independent second pass that gates
 * automatic adoption; `reason` is the expensive reasoning role used **only** when no
 * editorial exists. Callers own budgeting and persistence; the gateway owns none of it.
 */
export interface ModelGateway {
  capabilities(): ModelCapabilities;
  analyze(request: AnalyzeRequest): Promise<ModelCallResult<AnalyzeOutcome>>;
  verify(request: VerifyRequest): Promise<ModelCallResult<VerifyOutcome>>;
  reason(request: ReasonRequest): Promise<ModelCallResult<ReasonOutcome>>;
}

// ---------------------------------------------------------------------------------------
// Training store (implemented in Stage 2)
// ---------------------------------------------------------------------------------------

export interface StoreCapabilities {
  readonly implemented: boolean;
  /** SQLite schema version this store writes. */
  readonly schemaVersion: number;
  readonly transactional: boolean;
  readonly notes: readonly string[];
}

export interface ProblemQuery {
  readonly sourceInstanceId?: string | null;
  readonly accountId?: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}

/**
 * Persistence port.
 *
 * Implemented by the SQLite adapter (`adapters/sqlite`). Declared here so Stage 1 code,
 * tests and the UI can be written against a stable contract. `getCurrentSnapshotHead` is
 * the authority for staleness checks: an analysis may only write decisions when its
 * snapshot id equals the stored head.
 *
 * Identity rules every implementation must honour:
 * - ids are the ones the domain derives (`problemKey`, `submissionKey`, `snapshotIdOf`,
 *   `analysisId`, …), so a source-instance/domain/account scope can never collapse;
 * - snapshot, analysis, tag-decision and retrospective records are immutable: re-saving the
 *   same id with a different body must be rejected, while an identical re-save is a no-op;
 * - manual decisions are independent of AI decisions and only a genuinely new manual
 *   decision advances {@link TrainingStore.getManualRevision};
 * - job counters survive restarts and are never reset by an update.
 */
export interface TrainingStore {
  capabilities(): StoreCapabilities;

  // Sources, accounts & incremental sync
  upsertSourceInstances(instances: readonly SourceInstance[]): Promise<void>;
  getSourceInstance(id: string): Promise<SourceInstance | null>;
  listSourceInstances(): Promise<readonly SourceInstance[]>;
  upsertAccounts(accounts: readonly Account[]): Promise<void>;
  getAccount(id: string): Promise<Account | null>;
  listAccounts(sourceInstanceId: string | null): Promise<readonly Account[]>;
  getSyncCheckpoint(ref: SyncCheckpointRef): Promise<SyncCheckpoint | null>;
  saveSyncCheckpoint(checkpoint: SyncCheckpoint): Promise<void>;

  // Problems & submissions
  upsertProblems(problems: readonly NormalizedProblem[]): Promise<void>;
  listProblems(query: ProblemQuery): Promise<Page<NormalizedProblem>>;
  /**
   * One problem by its canonical key, without a scan.
   *
   * The adapter/pipeline resolves a job's problem through this method instead of paging
   * through `listProblems`; `null` means the problem is not stored.
   */
  getProblem(key: string): Promise<NormalizedProblem | null>;
  upsertSubmissions(submissions: readonly Submission[]): Promise<void>;
  listSubmissions(accountId: string, query: PageRequest): Promise<Page<Submission>>;

  // Snapshots
  getCurrentSnapshotHead(ref: ProblemRef): Promise<SnapshotHead | null>;
  getSnapshot(snapshotId: string): Promise<ProblemSnapshot | null>;
  /**
   * Persists a snapshot and makes it current for its problem.
   *
   * Throws when the snapshot would move the stored head backwards (an older version) and
   * when its version already exists with a different snapshot id; a save of the current
   * head is idempotent and never discards newer stored data.
   */
  saveSnapshot(snapshot: ProblemSnapshot): Promise<void>;

  // Analyses & jobs (separate ownership: results are immutable, jobs are mutable)
  getAnalysis(analysisId: string): Promise<AnalysisResult | null>;
  listAnalyses(problemKey: string): Promise<readonly AnalysisResult[]>;
  saveAnalysis(result: AnalysisResult): Promise<void>;
  getJob(jobId: string): Promise<AnalysisJobState | null>;
  listJobs(status: AnalysisJobStatus | null): Promise<readonly AnalysisJobState[]>;
  /** Persists job progress; counters and attempts are monotonic and never reset. */
  saveJob(state: AnalysisJobState): Promise<void>;
  /**
   * Atomically leases a `pending` job (or re-leases a `running` job whose lease expired at
   * `request.at`) to `request.owner`.
   *
   * Resolves `null` when the job does not exist, is terminal, is paused for quota, or is
   * held by another live lease. Recovery of expired leases is explicit via
   * {@link TrainingStore.recoverExpiredJobs}; the pipeline that consumes leases is a later
   * stage.
   */
  claimJob(request: JobLeaseRequest): Promise<AnalysisJobState | null>;
  /** Returns every expired `running` lease to `pending`, preserving counters. */
  recoverExpiredJobs(now: string): Promise<number>;

  // Analysis batches & model-call attempts (durable groundwork; orchestration is a later stage)
  getBatch(batchId: string): Promise<AnalysisBatch | null>;
  listBatches(status: AnalysisBatchStatus | null): Promise<readonly AnalysisBatch[]>;
  /**
   * Persist a batch under optimistic concurrency control and return the stored revision.
   *
   * `expectedRevision` is `null` only for the first save of a new batch and the previously
   * read revision for every update; a mismatch rejects before any write (a stale caller must
   * re-read instead of overwriting a newer state). A create stores revision 1, an update
   * `expectedRevision + 1`. Identity (`batchId`, `createdAt`, `jobs`, `maxJobs`) is immutable,
   * counters never decrease, a `completed`/`cancelled` batch stays terminal, and the lease
   * shape must match the status (`running` holds one lease; every other status holds none).
   * Temporal metadata must be ordered: `updatedAt >= createdAt`, and a running lease expires
   * strictly after `updatedAt`.
   */
  saveBatch(batch: AnalysisBatch, expectedRevision: number | null): Promise<number>;
  getModelCallAttempt(attemptId: string): Promise<ModelCallAttempt | null>;
  /** Attempts of one batch and/or job, in deterministic `requestedAt, attemptId` order. */
  listModelCallAttempts(query: ModelCallAttemptQuery): Promise<readonly ModelCallAttempt[]>;
  /**
   * Insert a `reserved` attempt before model dispatch, or advance an existing one
   * (`reserved → uncertain | settled`, `uncertain → settled`; nothing returns to `reserved`).
   *
   * A settled attempt is immutable and an identical re-save is a no-op; a different body is
   * rejected, so a finished call can never be rewritten. Once `hostSessionId`/`hostCallId` are
   * known they are never reassigned or cleared, and `finishedAt >= requestedAt`. The caller owns
   * the surrounding transaction, so the reservation and the job/batch counter bump commit
   * together.
   */
  saveModelCallAttempt(attempt: ModelCallAttempt): Promise<void>;

  // Tag decisions
  listTagDecisions(problemKey: string): Promise<readonly TagDecision[]>;
  saveTagDecisions(decisions: readonly TagDecision[]): Promise<void>;
  listManualDecisions(problemKey: string): Promise<readonly ManualTagDecision[]>;
  saveManualDecision(decision: ManualTagDecision): Promise<void>;
  /**
   * Monotonic revision of the manual decision history of one problem.
   *
   * It advances exactly once per genuinely new manual decision (same transaction as the
   * insert) and never for AI decisions or repeated saves. A later pipeline captures this
   * value before adopting a result and rejects the adoption when it changed.
   */
  getManualRevision(problemKey: string): Promise<number>;

  // Training
  saveRetrospective(retrospective: Retrospective): Promise<void>;
  listRetrospectives(accountId: string): Promise<readonly Retrospective[]>;
  savePlan(plan: TrainingPlan): Promise<void>;
  getPlan(planId: string): Promise<TrainingPlan | null>;
  listPlans(accountId: string | null): Promise<readonly TrainingPlan[]>;

  /**
   * Run `work` inside one store transaction; implementations must roll back on throw.
   *
   * Transactions do not nest. A store that owns a single connection cannot emulate two
   * concurrent nested transactions without letting them release or roll back each other's
   * savepoints, so an implementation may reject a `transaction()` call made inside an active
   * transaction instead of approximating one; callers must treat that rejection as final and
   * run the work in the outer transaction. The SQLite adapter rejects it before the callback
   * runs with the stable `nested_transaction` storage error code. Reads and writes issued
   * inside the callback are unaffected: they join the open transaction.
   */
  transaction<T>(work: () => Promise<T>): Promise<T>;

  /**
   * Write a standalone, SQLite-consistent copy (WAL content included) of this store's own
   * database to `path`. Must refuse to overwrite an existing file.
   *
   * A backup needs the store's own connection, so it must not be requested from inside a
   * transaction of the same store: the SQLite adapter rejects such a call before it queues
   * (stable `backup_in_transaction` code) rather than waiting for a mutex the caller itself
   * holds.
   */
  backupTo(path: string): Promise<void>;

  /** Release the store's resources. Safe to call more than once. */
  close(): Promise<void>;
}

/** Cancellation-aware sleep used by adapters to honour platform rate limits. */
export interface RateLimiter {
  /** Resolves when a request may be issued, or throws a `cancelled` DomainError. */
  acquire(token: CancellationToken): Promise<void>;
}
