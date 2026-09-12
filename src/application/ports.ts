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
 *   (Hydro, and the Stage 2 store), so the UI can never advertise unimplemented support.
 */
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

export interface FetchEditorialRequest {
  readonly problemRef: ProblemRef;
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
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

/** Result of one model call. Usage is reported even on failure (a failed call still costs). */
export type ModelCallResult<T> =
  | { readonly ok: true; readonly value: T; readonly usage: ModelUsage; readonly callId: string }
  | { readonly ok: false; readonly error: ModelGatewayError; readonly usage: ModelUsage; readonly callId: string };

export interface AnalyzeRequest {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: Taxonomy;
  readonly token: CancellationToken;
  readonly limits: ModelLimits;
  readonly roles: ModelRoleSettings;
}

export interface VerifyRequest {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: Taxonomy;
  readonly suggestions: readonly AiTagSuggestion[];
  readonly token: CancellationToken;
  readonly limits: ModelLimits;
  readonly roles: ModelRoleSettings;
}

export interface ReasonRequest {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: Taxonomy;
  /** Why the analysis role could not be used; operational errors never reach this call. */
  readonly reason: 'editorial_absent';
  readonly token: CancellationToken;
  readonly limits: ModelLimits;
  readonly roles: ModelRoleSettings;
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
 * Implemented in Stage 2 (SQLite). Declared here so Stage 1 code, tests and the UI can be
 * written against a stable contract. `getCurrentSnapshotHead` is the authority for staleness
 * checks: an analysis may only write decisions when its snapshot id equals the stored head.
 */
export interface TrainingStore {
  capabilities(): StoreCapabilities;

  // Problems & submissions
  upsertProblems(problems: readonly NormalizedProblem[]): Promise<void>;
  listProblems(query: ProblemQuery): Promise<Page<NormalizedProblem>>;
  upsertSubmissions(submissions: readonly Submission[]): Promise<void>;
  listSubmissions(accountId: string, query: PageRequest): Promise<Page<Submission>>;

  // Snapshots
  getCurrentSnapshotHead(ref: ProblemRef): Promise<SnapshotHead | null>;
  getSnapshot(snapshotId: string): Promise<ProblemSnapshot | null>;
  /** Persists a snapshot and makes it current for its problem. */
  saveSnapshot(snapshot: ProblemSnapshot): Promise<void>;

  // Analyses & jobs (separate ownership: results are immutable, jobs are mutable)
  getAnalysis(analysisId: string): Promise<AnalysisResult | null>;
  listAnalyses(problemKey: string): Promise<readonly AnalysisResult[]>;
  saveAnalysis(result: AnalysisResult): Promise<void>;
  getJob(jobId: string): Promise<AnalysisJobState | null>;
  listJobs(status: AnalysisJobStatus | null): Promise<readonly AnalysisJobState[]>;
  saveJob(state: AnalysisJobState): Promise<void>;

  // Tag decisions
  listTagDecisions(problemKey: string): Promise<readonly TagDecision[]>;
  saveTagDecisions(decisions: readonly TagDecision[]): Promise<void>;
  listManualDecisions(problemKey: string): Promise<readonly ManualTagDecision[]>;
  saveManualDecision(decision: ManualTagDecision): Promise<void>;

  // Training
  saveRetrospective(retrospective: Retrospective): Promise<void>;
  listRetrospectives(accountId: string): Promise<readonly Retrospective[]>;
  savePlan(plan: TrainingPlan): Promise<void>;
  getPlan(planId: string): Promise<TrainingPlan | null>;
  listPlans(accountId: string | null): Promise<readonly TrainingPlan[]>;

  /** Run `work` inside one store transaction; implementations must roll back on throw. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

/** Cancellation-aware sleep used by adapters to honour platform rate limits. */
export interface RateLimiter {
  /** Resolves when a request may be issued, or throws a `cancelled` DomainError. */
  acquire(token: CancellationToken): Promise<void>;
}
