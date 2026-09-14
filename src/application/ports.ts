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
  ProblemDispositionAction,
  ProblemDispositionRecord,
  ProblemDispositionState,
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
 * One account's validated public profile.
 *
 * Only what the product displays is representable: the source instance the answer belongs to, the
 * canonical uid it was requested for, and the platform's own nickname. A profile answer never
 * carries the other fields a profile endpoint may return (biography, scores, followers, ...).
 */
export interface AccountProfile {
  readonly sourceInstanceId: string;
  /** Canonical decimal uid the profile was requested for; must equal the account's own handle. */
  readonly uid: string;
  readonly displayName: string;
}

/**
 * Direct public-profile request.
 *
 * Anonymous on platforms whose profile page is public, so it carries no credential; an adapter must
 * validate the answered identity against `account` and must not fabricate a name for a payload
 * whose shape it does not recognize.
 */
export interface FetchAccountProfileRequest {
  readonly account: Account;
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
}

/**
 * One platform implementation bound to one source instance.
 * Implementations must honour `limits`, observe `token`, and normalise payloads into
 * domain types (runtime validation of external payloads happens here, not in the domain).
 */
export interface PlatformAdapter {
  readonly sourceInstance: SourceInstance;
  capabilities(): PlatformCapabilities;
  /** Optional official contest-rating capability; absent on unsupported platforms. */
  fetchOfficialRating?(request: { readonly account: Account; readonly token: CancellationToken; readonly limits: PlatformLimits }): Promise<import('../domain/official-rating.js').OfficialRatingData>;
  /**
   * Optional public-profile read: the requested account's own nickname.
   *
   * Absent on platforms that cannot answer it, so a caller must check for the method instead of
   * assuming a nickname can be fetched at all. An answer names only the source instance, the uid and
   * the nickname, and is never a fallback for an unrecognized payload.
   */
  fetchAccountProfile?(request: FetchAccountProfileRequest): Promise<AccountProfile>;
  listProblems(request: ListProblemsRequest): Promise<Page<NormalizedProblem>>;
  listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>>;
  /** Fetch one problem's full detail, including its statement when the platform has one. */
  fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem>;
  fetchEditorial(request: FetchEditorialRequest): Promise<EditorialFetchResult>;
}

/**
 * Credential-free problem-detail port (Sprint 30b).
 *
 * The metadata repair path reads exactly one problem's public detail, so its port is narrowed to
 * that: a full {@link PlatformAdapter} satisfies it structurally, and so does an account-bound
 * authenticated reader. `capabilities()`, `listProblems`, `listSubmissions` and `fetchEditorial`
 * are deliberately unreachable through it, so a caller holding this port cannot turn one metadata
 * repair into a catalog scan, a history read or an editorial fetch — and an implementation that
 * needs a session still only ever receives one problem request, never a caller-supplied cookie.
 */
export interface ProblemMetadataSource {
  readonly sourceInstance: SourceInstance;
  /** Fetch one problem's full detail; identical to {@link PlatformAdapter.fetchProblem}. */
  fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem>;
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
 * Result of one model call. Success always carries known usage; a failure carries it when the
 * provider reported it, and `null` when the cost is unknown (never fabricated as zero).
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
      /**
       * Usage of the failed call, or `null` when the provider reported no usable usage.
       *
       * `null` means unknown, not free: the pipeline keeps such an attempt `uncertain` and
       * never silently retries it, so an unaccounted call stays visible instead of becoming
       * a fabricated free request.
       */
      readonly usage: ModelUsage | null;
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
  /**
   * Suggestions to verify; **may be empty**.
   *
   * An empty list still requires the call: the independent pass must scan the full material
   * for omissions even when the analysis proposed nothing, and that answer is what makes the
   * run a completeness check.
   */
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
  /**
   * Omissions the verifier found in the material: taxonomy methods the editorial really uses
   * but the analysis pass never proposed.
   *
   * Present only when the call ran under the completeness-aware verification prompt; a legacy
   * outcome omits the member entirely, so replaying an old answer can never be mistaken for an
   * omissions answer. A present (possibly empty) array **is** the omissions answer — an empty
   * analysis still requires the verification call, and it counts against the call budget.
   */
  readonly missingSuggestions?: readonly AiTagSuggestion[];
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
  /**
   * Optional literal, case-insensitive substring filter (1..200 characters) over the whole bank:
   * a problem matches when the term occurs in its title or in its platform external key.
   * Matching is literal, so `%` and `_` are ordinary characters and quoting is unnecessary.
   */
  readonly query?: string | null;
  /**
   * Optional review-queue filter: keep only problems that still hold an unresolved item at their
   * current snapshot head (a current AI `needs_review` decision, or a taxonomy id of a current
   * analysis' reasoning draft without a manual decision). An implementation applies it before
   * pagination, so a page never has to be filtered by the caller.
   */
  readonly needsReviewOnly?: boolean | null;
}

/**
 * Solved-state filter of one numbered bank page, relative to the selected account.
 *
 * `solved` means "this account has at least one accepted submission for the problem"; `unconfirmed`
 * means exactly the negation — a problem never attempted and one attempted without an accepted
 * submission are the same statement. A later wrong answer never revokes an earlier AC, duplicate
 * submissions still count one problem, and another account, source instance or domain can never
 * confer solved status — an implementation must additionally require the account's own stored source
 * instance to match the problem's, so an incoherent stored row cannot confer one either. `all` (the
 * default) imposes no solved filter at all.
 */
export type ProblemSolvedFilter = 'all' | 'solved' | 'unconfirmed';

/** Accepted solved-state filters, in the order the bank UI presents them. */
export const PROBLEM_SOLVED_FILTERS: readonly ProblemSolvedFilter[] = ['all', 'solved', 'unconfirmed'];

/**
 * Ordering of one numbered bank page.
 *
 * `default` is the legacy canonical-key ascending order and is what an omitted/`null` sort means, so
 * existing callers keep their exact order and `problem.list`'s cursor order is untouched.
 * `problem_asc`/`problem_desc` order by the problem's own external key in **natural** order (`2A`
 * before `10A`), `title_asc`/`title_desc` by title and `difficulty_asc`/`difficulty_desc` by one raw
 * platform rating dimension. Every order is fully deterministic: ties are broken by the canonical
 * key, so no row is ever skipped or repeated across pages.
 */
export type ProblemSort =
  | 'default'
  | 'problem_asc'
  | 'problem_desc'
  | 'title_asc'
  | 'title_desc'
  | 'difficulty_asc'
  | 'difficulty_desc';

/** Accepted bank sorts, in the order the bank UI presents them. */
export const PROBLEM_SORTS: readonly ProblemSort[] = [
  'default',
  'problem_asc',
  'problem_desc',
  'title_asc',
  'title_desc',
  'difficulty_asc',
  'difficulty_desc',
];

/** Sorts that read one raw rating dimension; each needs a source instance and a non-empty dimension. */
export const RATING_SORTS: readonly ProblemSort[] = ['difficulty_asc', 'difficulty_desc'];

/** Longest accepted `ratingDimension`: a dimension is a short platform label (`rating`, `difficulty`). */
export const MAX_RATING_DIMENSION_CHARS = 100;

/** Legal page sizes of {@link ProblemBrowseQuery.limit}: any integer within `min..max`. */
export const BROWSE_PAGE_LIMITS = { minPageSize: 1, maxPageSize: 100 } as const;

/**
 * Distinct accounts one merged-bank read accepts; more is refused instead of truncated.
 *
 * The bound is part of the contract, not a tuning knob: a merged read resolves every selected
 * account, so an unbounded selection would turn one request into an unbounded number of lookups.
 */
export const MAX_MERGED_BANK_ACCOUNTS = 32;

/**
 * One numbered page of the bank: page number and size instead of a cursor.
 *
 * Every predicate is applied in SQL before both the count and the selected page, so `items` and the
 * totals always describe the same filter set. `status` and `onlyAttempted` are statements about the
 * selected account's own submissions and are refused without one. `sort` is applied inside the same
 * `ORDER BY` before `LIMIT/OFFSET`; a difficulty sort additionally requires `sourceInstanceId` and a
 * non-empty `ratingDimension`, so one difficulty comparison always stays within one source instance
 * and one raw dimension instead of inventing a cross-platform scale.
 */
export interface ProblemBrowseQuery {
  readonly sourceInstanceId?: string | null;
  /** Solved context and the scope of `status`/`onlyAttempted`; both need an explicit account. */
  readonly accountId?: string | null;
  readonly status?: ProblemSolvedFilter | null;
  readonly onlyAttempted?: boolean | null;
  /** Literal case-insensitive substring over title and external key, as in {@link ProblemQuery}. */
  readonly query?: string | null;
  readonly needsReviewOnly?: boolean | null;
  /** Ordering of the whole filtered set; omitted/`null` is the legacy canonical-key ascending order. */
  readonly sort?: ProblemSort | null;
  /** Raw rating dimension of a difficulty sort; required exactly for {@link RATING_SORTS}. */
  readonly ratingDimension?: string | null;
  /** 1-based page number; a page beyond the last match is clamped to the last valid page. */
  readonly page: number;
  readonly limit: number;
}

/** One bank row plus the requested account's solved verdict, decided in SQL. */
export interface BrowsedProblem {
  readonly problem: NormalizedProblem;
  /**
   * True when this account has an accepted submission for the problem's full stored identity and
   * the account's own stored source instance matches the problem's.
   */
  readonly solvedByAccount: boolean;
}

/** One numbered bank page plus the totals of exactly the same filter set. */
export interface ProblemBrowsePage {
  readonly items: readonly BrowsedProblem[];
  /** Page actually returned: `1` when nothing matched, otherwise within `1..totalPages`. */
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly fetchedAt: string;
}

/**
 * One merged-bank read (Sprint Contract 08b): the same bank, grouped by problem identity across the
 * selected accounts' source instances.
 *
 * `accountIds` is a *selection*, bounded by {@link MAX_MERGED_BANK_ACCOUNTS} and holding at most one
 * account per source instance: two accounts of one instance would describe one person twice, and the
 * solved state of a group is a statement about the selected accounts only. An empty selection is
 * legal for the unfiltered read, but `status` and `onlyAttempted` are statements about selected
 * accounts and are refused without at least one.
 *
 * `sourceInstanceId` is a *display filter*, not an account scope: it keeps groups that have a member
 * from that instance, while accepted evidence may still come from any selected account on an
 * equivalent source (that is what makes a Luogu group solved by a Codeforces account observable).
 * A difficulty sort additionally reads its raw dimension from the member of that same instance.
 *
 * The implementation groups stored problems before it counts, filters or pages, so `totalItems` and
 * `items` always describe the same grouping, and it never returns more members than the selected
 * page's groups can hold.
 */
export interface MergedProblemBrowseQuery {
  readonly accountIds: readonly string[];
  readonly sourceInstanceId?: string | null;
  /** Solved/attempted statements about the selected accounts; refused without at least one. */
  readonly status?: ProblemSolvedFilter | null;
  readonly onlyAttempted?: boolean | null;
  /** Literal case-insensitive substring over ANY member's title or external key. */
  readonly query?: string | null;
  readonly sort?: ProblemSort | null;
  /** Raw rating dimension of a difficulty sort; required exactly for {@link RATING_SORTS}. */
  readonly ratingDimension?: string | null;
  /** 1-based page number; a page beyond the last group is clamped to the last valid page. */
  readonly page: number;
  readonly limit: number;
}

/** One stored problem of a merged group, plus this row's own direct solved verdict. */
export interface MergedProblemMemberRow {
  readonly problem: NormalizedProblem;
  /** Selected account of this problem's own source instance, or `null` when none is selected. */
  readonly accountId: string | null;
  /**
   * True only when `accountId` has an accepted submission for **this** problem's own identity.
   * A linked solve of an equivalent problem on the other site never sets it.
   */
  readonly solvedByAccount: boolean;
}

/**
 * One canonical accepted submission behind a group's solved state.
 *
 * One row per `(accountId, problemKey)`: the earliest accepted submission of that account for that
 * problem identity, ordered by `submittedAt, submissionId`. It carries identity and time only —
 * never a verdict body, a source code or a score.
 */
export interface MergedProblemEvidenceRow {
  readonly accountId: string;
  readonly problemKey: string;
  readonly sourceInstanceId: string;
  readonly externalKey: string;
  readonly submissionId: string;
  readonly submittedAt: string;
}

/** How one merged group was formed: a recognized cross-site identity, or a single problem key. */
export type MergedProblemMappingKind = 'luogu_cf_identifier' | 'single';

/**
 * One merged group.
 *
 * `solved` is true exactly when `acceptedEvidence` is non-empty, and `attempted` is true when any
 * selected account submitted to any equivalent problem identity. Members are the stored problem rows
 * of the group (at most one per recognized mirror spelling): a recognized group with only one member
 * is legal, because the other site's metadata may simply never have been fetched.
 */
export interface MergedProblemGroupRow {
  readonly groupKey: string;
  readonly members: readonly MergedProblemMemberRow[];
  readonly solved: boolean;
  readonly attempted: boolean;
  readonly acceptedEvidence: readonly MergedProblemEvidenceRow[];
  readonly mappingKind: MergedProblemMappingKind;
}

/** One numbered page of merged groups plus the totals of exactly the same grouped filter set. */
export interface MergedProblemBrowsePage {
  readonly items: readonly MergedProblemGroupRow[];
  /** Page actually returned: `1` when nothing matched, otherwise within `1..totalPages`. */
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly fetchedAt: string;
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
  /** Latest account calibration, including explicit withdrawals. Imports never change it. */
  getOfficialRating(accountId: string): Promise<import('../domain/official-rating.js').OfficialRatingSnapshot | null>;
  saveOfficialRating(record: import('../domain/official-rating.js').OfficialRatingSnapshot, expectedRevision: number): Promise<void>;
  getAbilityCalibration(accountId: string): Promise<import('../domain/ability-calibration.js').AbilityCalibration | null>;
  /** Append exactly the next revision; expectedRevision 0 means no prior calibration. */
  saveAbilityCalibration(record: import('../domain/ability-calibration.js').AbilityCalibration, expectedRevision: number): Promise<void>;
  /**
   * Latest user-entered virtual-contest performance ledger of one account, or `null`.
   *
   * The ledger is Codeforces-only evidence with a monotonic per-account revision and rows unique by
   * contest id. Reading or writing it never touches an official rating snapshot, a calibration or
   * any platform record.
   */
  getVirtualPerformanceLedger(accountId: string): Promise<import('../domain/virtual-performance.js').VirtualPerformanceLedger | null>;
  /**
   * Append exactly the next ledger revision; `expectedRevision` 0 means no prior ledger.
   *
   * A delete that empties the ledger still stores an explicit empty body with the next revision, so
   * a stale writer can never resurrect the rows it read.
   */
  saveVirtualPerformanceLedger(record: import('../domain/virtual-performance.js').VirtualPerformanceLedger, expectedRevision: number): Promise<void>;
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
   * One numbered page of the bank, with the filtered total and the account's solved verdict.
   *
   * This is not cursor paging: the implementation counts the filtered unique problems and selects
   * exactly one `LIMIT/OFFSET` page in the SAME read, deciding `solvedByAccount` in SQL against the
   * indexed submissions, so no submission history is walked and no page is filtered by the caller.
   * A page beyond the last match is clamped to the last valid page (and to `1` when the filter
   * matched nothing) instead of answering with an empty out-of-range page.
   */
  browseProblems(query: ProblemBrowseQuery): Promise<ProblemBrowsePage>;
  /**
   * One numbered page of the merged bank: stored problems grouped by problem identity.
   *
   * The implementation groups the stored bank **before** it counts, filters and pages, so the
   * totals and the returned page describe the same groups; it applies the merge rule as a pure
   * scalar SQL function over each stored reference (never by title, tag or rating), reduces the
   * selected accounts' submissions to one accepted evidence per `(account, problem)` plus an attempt
   * flag, and returns only the members and evidence of the selected page's groups. Accepted evidence
   * is found even when the accepted problem has no stored metadata row, because it is derived from
   * the canonical submission identity. A page beyond the last group is clamped to the last valid
   * page, and an empty filter set reports `page: 1` with `totalPages: 0`.
   */
  browseMergedProblems(query: MergedProblemBrowseQuery): Promise<MergedProblemBrowsePage>;
  /**
   * One problem by its canonical key, without a scan.
   *
   * The adapter/pipeline resolves a job's problem through this method instead of paging
   * through `listProblems`; `null` means the problem is not stored.
   */
  getProblem(key: string): Promise<NormalizedProblem | null>;
  upsertSubmissions(submissions: readonly Submission[]): Promise<void>;
  listSubmissions(accountId: string, query: PageRequest): Promise<Page<Submission>>;
  /**
   * One submission by its own stable id, without a scan.
   *
   * The merged bank re-reads the exact submission behind every accepted evidence row, so a broken or
   * hostile port cannot make a fabricated evidence record reveal a linked solve; `null` means the
   * submission is not stored.
   */
  getSubmission(submissionId: string): Promise<Submission | null>;

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

  /** Durable local state, shared by native problem key across accounts. */
  getProblemDisposition(problemKey: string): Promise<ProblemDispositionRecord | null>;
  /** A bounded raw-title recovery read; includes hidden rows only in this explicit view. */
  listProblemDispositions(query: ProblemDispositionQuery): Promise<ProblemDispositionPage>;
  /** Atomic CAS batch. Does not delete original evidence; caller coordinates source leases. */
  applyProblemDispositions(request: ProblemDispositionChangeRequest): Promise<number>;
}
export interface ProblemDispositionQuery {
  readonly sourceInstanceId: string;
  readonly state: ProblemDispositionState;
  readonly page: number;
  readonly limit: number;
}
export interface ProblemDispositionPage {
  readonly items: readonly (ProblemDispositionRecord & { readonly title: string | null })[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}
export interface ProblemDispositionChangeItem {
  readonly problemKey: string;
  readonly expectedState: ProblemDispositionState | null;
}
export interface ProblemDispositionChangeRequest {
  readonly accountId: string;
  readonly action: ProblemDispositionAction;
  readonly items: readonly ProblemDispositionChangeItem[];
}

/** Cancellation-aware sleep used by adapters to honour platform rate limits. */
export interface RateLimiter {
  /** Resolves when a request may be issued, or throws a `cancelled` DomainError. */
  acquire(token: CancellationToken): Promise<void>;
}
