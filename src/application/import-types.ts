/**
 * Application-owned import contracts.
 *
 * These types are the boundary between whatever produces input (a manual document parsed by
 * the adapter layer, a UI action, a platform adapter) and the persistence port. Two rules
 * shape all of them:
 *
 * - **No adapter types.** A manual bundle carries plain domain records plus an
 *   application-owned material declaration, so the manual parser's shapes never leak into
 *   application code and a parser or adapter can be replaced without touching the service.
 * - **No optimistic reporting.** A report states what actually happened: exact
 *   inserted/updated/unchanged counts for records the store can look up by canonical key,
 *   `processed` for submissions (the port exposes no submission-by-id read), the persisted
 *   cursor after a page, and the availability of *cached* material separately from material
 *   the call actually fetched.
 */
import {
  contentHashOf,
  problemKey,
  type Account,
  type CancellationToken,
  type EditorialAvailability,
  type NormalizedProblem,
  type ProblemRef,
  type SourceInstance,
  type Submission,
} from '../domain/index.js';
import type { PlatformError } from './platform-errors.js';
import type {
  EditorialFetchResult,
  ListProblemsRequest,
  ListSubmissionsRequest,
  Page,
  PlatformLimits,
} from './ports.js';
import { STORAGE_PAGE_LIMITS, type SyncCheckpoint, type SyncResource } from './storage-types.js';

/**
 * Hard per-page bounds for one sync page.
 *
 * The service enforces exactly the bound the store documents for a paged read, so a caller
 * cannot ask an adapter for an unbounded page and no continuation loop is open-ended.
 */
export const IMPORT_PAGE_LIMITS = STORAGE_PAGE_LIMITS;

/** Upper bound on the missing-problem keys echoed in a report (the count itself is exact). */
export const MISSING_PROBLEM_KEY_LIMIT = 50;

/** Reserved id prefix of a synthesized "material check" record. */
const MATERIAL_CHECK_ID_PREFIX = 'editorial-check-';

/**
 * Stable id of the record that represents the *outcome of one material check* for one
 * refetch target: an explicit `absent` declaration, or a refresh that returned no material.
 *
 * The id is derived from the problem identity and the target that was actually checked
 * (the adapter-validated `officialTutorialUrl`, else the problem URL), never from a token,
 * a retry delay, a timestamp or a title. Checking the same target twice therefore addresses
 * the same record instead of piling up anonymous failure rows.
 */
export function editorialSourceIdOf(ref: ProblemRef, target: string): string {
  return `${MATERIAL_CHECK_ID_PREFIX}${contentHashOf({ problemKey: problemKey(ref), target }).slice(0, 32)}`;
}

/** True when `id` belongs to the reserved "material check" namespace of this service. */
export function isMaterialCheckSourceId(id: string): boolean {
  return id.startsWith(MATERIAL_CHECK_ID_PREFIX);
}

// ---------------------------------------------------------------------------------------
// Manual import
// ---------------------------------------------------------------------------------------

/**
 * One material declaration owned by the application.
 *
 * A `found` result already carries the adapter's real sources and solutions. For an explicit
 * `absent` declaration the port-shaped result holds only a detail, so the attribution the
 * user supplied (`url`/`title`/`note`) travels next to it — without it the declaration would
 * lose the page it refers to. An `unavailable` entry is *not* a declaration: the caller
 * synthesizes one for every problem the document omits, and the service preserves the
 * previously imported material instead of treating the omission as "no editorial".
 */
export interface ManualMaterialInput {
  readonly problemKey: string;
  readonly result: EditorialFetchResult;
  readonly url: string | null;
  readonly title: string | null;
  readonly note: string | null;
}

/**
 * One validated manual document, already reduced to application-owned records.
 *
 * The caller guarantees a strict parse; the service rechecks the source/account/problem
 * identities, canonical ids, references and duplicates before writing anything, because a
 * second check is cheap and a corrupted identity is permanent.
 */
export interface ManualImportBundle {
  readonly source: SourceInstance;
  readonly accounts: readonly Account[];
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  /** Material declarations by canonical problem key; a problem without an entry declares nothing. */
  readonly materials?: readonly ManualMaterialInput[];
}

/** Exact classification of records the store can look up by canonical key. */
export interface ImportCounts {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
}

/** Result of persisting (or deliberately reusing) one problem snapshot. */
export interface SnapshotWrite {
  readonly problemKey: string;
  readonly snapshotId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly capturedAt: string;
  /**
   * False when the semantic content did not change: the stored snapshot object was reused
   * and `saveSnapshot` was not called, so `capturedAt` differences alone never create a
   * colliding immutable id.
   */
  readonly changed: boolean;
}

/** What one material declaration or refresh did to the stored editorial state. */
export type MaterialOutcome = 'applied' | 'preserved' | 'ignored';

export interface MaterialReport {
  readonly problemKey: string;
  /**
   * `applied` wrote a record for the refetch target, `preserved` kept cached successful
   * material instead of overwriting it with a non-found result, `ignored` declared nothing
   * (a synthesized `unavailable` entry).
   */
  readonly outcome: MaterialOutcome;
  /** Availability written for the refetch target; set only for `applied`. */
  readonly availability: EditorialAvailability | null;
  /** True only when this call's own result was `found` and it was written. */
  readonly freshFound: boolean;
  /**
   * Availability of cached material this call did **not** refresh. Non-null means the call
   * produced no fresh material and the caller must show the cached state instead of
   * presenting the check as a successful fetch.
   */
  readonly staleCachedAvailability: EditorialAvailability | null;
  /** Editorial sources and solutions in the resulting snapshot body. */
  readonly sources: number;
  readonly solutions: number;
}

export interface ManualImportReport {
  readonly sourceInstanceId: string;
  /** Accounts written with the document (upsert, so re-importing is idempotent). */
  readonly accountsProcessed: number;
  /** Exact; every problem of the document is looked up by canonical key. */
  readonly problems: ImportCounts;
  /**
   * Submissions written with the document. Reported as processed rather than counted as
   * inserts because the store port has no submission-by-id read and scanning a whole history
   * per import would be a hidden, unbounded cost.
   */
  readonly submissionsProcessed: number;
  readonly materials: readonly MaterialReport[];
  /** One entry per problem of the document, in document order. */
  readonly snapshots: readonly SnapshotWrite[];
  readonly changedSnapshots: number;
}

// ---------------------------------------------------------------------------------------
// Manual supplementation
// ---------------------------------------------------------------------------------------

/**
 * Hard upper bound on a manually supplied statement, in characters.
 *
 * A bounded input keeps one paste from becoming an unbounded write, and the bound is far
 * above any real statement a user would type or paste.
 */
export const MAX_SUPPLEMENT_STATEMENT_CHARS = 200_000;

/**
 * Supplement one **stored** problem with a manually supplied statement and/or material
 * declaration.
 *
 * This is the operation behind the workbench's unsolved-problem form. That form's DTO
 * deliberately hides raw platform tags, ratings and cached editorial, so having it re-import a
 * whole problem would let a partial client-side copy erase the metadata it is not allowed to
 * see. The service therefore never accepts a problem body: it reads the stored problem and
 * replaces only what this request names.
 *
 * Rules:
 * - at least one of `statement`/`material` must be supplied; a request that would write nothing
 *   is rejected instead of being reported as a successful supplement;
 * - `statement` keeps the caller's text but must be non-blank after trimming and at most
 *   {@link MAX_SUPPLEMENT_STATEMENT_CHARS} characters; an explicit `null` is rejected because
 *   this operation never deletes a stored statement;
 * - `material` is one already-normalised declaration for the *same* problem: `found` with a
 *   non-empty, rebuildable source/solution set, or an explicit `absent` with the URL, title and
 *   note it refers to;
 * - `expectedSnapshotId` is the snapshot the caller saw (`null` when it saw none); the write is
 *   refused when the stored head has moved on.
 */
export interface SupplementMaterialRequest {
  readonly problemKey: string;
  readonly expectedSnapshotId: string | null;
  readonly statement?: string;
  readonly material?: ManualMaterialInput;
}

/**
 * Result of one supplementation.
 *
 * Deliberately narrow: identity, the committed snapshot descriptor and the material outcome.
 * No problem body, raw tag or editorial text is echoed, so this operation cannot become a way
 * to read the hidden metadata it exists to protect.
 */
export interface SupplementMaterialReport {
  readonly problemKey: string;
  readonly snapshot: SnapshotWrite;
  /** Outcome of the supplied declaration; `null` when the request carried none. */
  readonly material: MaterialReport | null;
}

// ---------------------------------------------------------------------------------------
// Local problem supplementation (manual recovery of one queued key)
// ---------------------------------------------------------------------------------------

/**
 * Hard upper bound on a locally supplied problem title, in characters.
 *
 * A missing problem's title is real user input, so it is bounded exactly like the statement
 * ({@link MAX_SUPPLEMENT_STATEMENT_CHARS}) while staying far above any real problem name.
 */
export const MAX_SUPPLEMENT_TITLE_CHARS = 500;

/**
 * Canonical identity and page URL of a problem the store may not know yet.
 *
 * The reference and the URL are derived by the caller from the **configured source instance**
 * (the canonical key of the account's backlog plus that instance's own base URL), never taken
 * from a request body: the manual-recovery form never sees a platform URL, so it cannot supply
 * one, and no caller can invent an identity the configured source would not produce.
 */
export interface LocalProblemSeed {
  readonly ref: ProblemRef;
  /** Exact canonical problem page URL of the configured source instance. */
  readonly url: string;
  /** Real title the user supplied; used **only** when the problem row does not exist yet. */
  readonly title: string;
}

/**
 * Record a **locally supplied** statement for one problem, creating the row when it is missing.
 *
 * This is the application half of the workbench's manual recovery for a queued key the platform
 * will not serve (an explicitly incomplete personal statement, a deleted problem, ...). It is
 * deliberately narrower than {@link SupplementMaterialRequest}: the statement is mandatory
 * because it is the material being recorded, there is no editorial declaration, and a missing
 * problem is created from a {@link LocalProblemSeed} whose identity comes from the configured
 * source rather than from the caller.
 *
 * Rules:
 * - the seed's `ref` must be canonical (`problemKey(ref)` round-trips through
 *   `parseProblemKey`) and the statement must be non-blank and at most
 *   {@link MAX_SUPPLEMENT_STATEMENT_CHARS} characters;
 * - an **existing** problem keeps its stored title, url, ratings and raw tags; the supplied
 *   title is used only when the row is created, and a created row carries no rating and no raw
 *   tag at all — unknown stays unknown instead of being invented;
 * - `expectedSnapshotId` is the snapshot the caller saw (`null` when it saw none) and is
 *   compared with the stored head **before** the first write, so a recovery built on a
 *   superseded snapshot is refused rather than merged;
 * - the problem row and its snapshot are written in **one** transaction, and a created problem
 *   carries a real snapshot of the supplied statement and **no** editorial source: a manual
 *   recovery never records an editorial declaration, never marks a tag reviewed and never
 *   claims the platform was read.
 */
export interface SupplementLocalProblemRequest {
  readonly problem: LocalProblemSeed;
  /** Complete statement supplied by the user; written as the problem's statement. */
  readonly statement: string;
  readonly expectedSnapshotId: string | null;
  readonly token: CancellationToken;
  /**
   * Optional hook awaited **inside** the commit transaction, after the problem row and its
   * snapshot were written and before the transaction commits (the same contract as
   * {@link RefreshProblemMetadataRequest.beforeCommit}): a throw rolls the problem, its snapshot
   * and every mutation the hook performed back together. It is internal plumbing for the Luogu
   * synchronization service — the lease re-check plus the atomic dequeue of the recovered key —
   * and is deliberately not part of any business-API DTO.
   */
  readonly beforeCommit?: () => Promise<void> | void;
}

/**
 * Result of one local supplementation.
 *
 * `created` states whether the problem row did not exist and was created from the seed, so a
 * caller can distinguish "recovered a missing problem" from "completed a stored one" without
 * reading the problem back.
 */
export interface SupplementLocalProblemReport {
  readonly problemKey: string;
  readonly snapshot: SnapshotWrite;
  /** True when the problem row did not exist and was created from the supplied seed. */
  readonly created: boolean;
}

// ---------------------------------------------------------------------------------------
// Paged sync
// ---------------------------------------------------------------------------------------

/** How one sync page relates to the stored checkpoint. */
export type SyncMode = 'start' | 'continue' | 'restart';

/**
 * The platform surface one sync page actually needs.
 *
 * A full {@link import('./ports.js').PlatformAdapter} satisfies this shape, and so does an
 * authenticated submissions-only reader (Sprint 17a) that deliberately exposes no problem catalog
 * or editorial operation. `listProblems` is therefore optional: it is required exactly when
 * `SyncPageRequest.resource` is `problems`, and its absence for that resource is a typed refusal
 * instead of a page that silently returns nothing.
 */
export interface SyncPageSource {
  readonly sourceInstance: SourceInstance;
  listProblems?(request: ListProblemsRequest): Promise<Page<NormalizedProblem>>;
  listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>>;
}

export interface SyncPageRequest {
  readonly resource: SyncResource;
  /** Required for `submissions`, optional account scope for `problems`. */
  readonly account?: Account | null;
  readonly mode: SyncMode;
  /**
   * Time bound of the scan.
   *
   * `undefined` means "no explicit bound": `start` then performs a conservative full scan
   * (never the newest stored submission time, which would miss late verdict changes), and
   * `restart` keeps the bound the interrupted scan was already using. `null` is an explicit
   * full scan.
   */
  readonly since?: string | null;
  readonly limit: number;
  readonly limits: PlatformLimits;
  readonly token: CancellationToken;
  /**
   * Internal commit hook, invoked **inside** the page's transaction after the page rows and the
   * checkpoint were written.
   *
   * It exists so a durable caller (the Sprint 17c synchronization service) can save its own
   * progress and missing-metadata backlog atomically with the page: a throw from the hook aborts
   * the whole transaction, so the page data and the checkpoint roll back together and no caller can
   * ever observe a page that was written without its progress record. It is a plain function and is
   * deliberately **not** part of any business-API DTO or UI input validation: no client can supply
   * one, and `undefined` (the default) means the hook is simply not called.
   */
  readonly onPageCommitted?: (report: SyncPageReport) => Promise<void> | void;
}

export interface ProblemPageCounts {
  readonly kind: 'problems';
  /** Raw page size; the classifications below are per distinct problem key. */
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
}

export interface SubmissionPageCounts {
  readonly kind: 'submissions';
  readonly fetched: number;
  /** Rows upserted; the port cannot report an insert/update split without a full history scan. */
  readonly processed: number;
  /**
   * Referenced problems whose metadata is not stored yet. Such submissions are retained
   * as-is: a history page may legitimately arrive before the problem catalog, and inventing
   * a title or dropping the row would be a silent data change.
   */
  readonly missingProblemMetadata: number;
  /** First {@link MISSING_PROBLEM_KEY_LIMIT} of those keys, for diagnostics. */
  readonly missingProblemKeys: readonly string[];
}

export type SyncPageCounts = ProblemPageCounts | SubmissionPageCounts;

export interface SyncPageReport {
  readonly resource: SyncResource;
  readonly mode: SyncMode;
  readonly sourceInstanceId: string;
  readonly accountId: string | null;
  /** Bound the scan is using; it never changes across the pages of one scan. */
  readonly since: string | null;
  /** Cursor this page was fetched with (`null` = first page). */
  readonly cursor: string | null;
  /** Persisted cursor of the committed checkpoint; `null` means the scan is complete. */
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly counts: SyncPageCounts;
  readonly checkpoint: SyncCheckpoint;
  /** Observation time reported by the adapter for this page. */
  readonly pageFetchedAt: string;
}

// ---------------------------------------------------------------------------------------
// Material refresh
// ---------------------------------------------------------------------------------------

export interface RefreshMaterialRequest {
  readonly problemRef: ProblemRef;
  /** Fetch the full problem detail/statement in addition to the editorial material. */
  readonly fetchStatement: boolean;
  /**
   * Official tutorial/editorial URL supplied by the caller. The adapter validates it against
   * its own official origin before issuing a request, so a typed answer means the URL was
   * accepted and it becomes the attribution of a non-found record.
   */
  readonly officialTutorialUrl?: string | null;
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
}

export type StatementRefreshStatus = 'fetched' | 'not_requested' | 'failed';

export interface StatementRefreshOutcome {
  readonly status: StatementRefreshStatus;
  /** The freshly fetched problem; set only for `fetched`. */
  readonly fetchedProblem: NormalizedProblem | null;
  /** Operational failure; set only for `failed`. Never a fake success. */
  readonly error: PlatformError | null;
}

export interface EditorialRefreshOutcome {
  readonly attempted: boolean;
  /** Typed adapter answer, or the conversion of a thrown platform error. */
  readonly result: EditorialFetchResult | null;
  /** Set when the adapter threw; `result` then carries the converted failure. */
  readonly error: PlatformError | null;
  /**
   * Set when no request was made because the problem has no stored metadata: a snapshot
   * cannot be built without a real problem, and the service never invents one.
   */
  readonly skippedReason: 'problem_metadata_missing' | null;
}

export interface RefreshMaterialReport {
  readonly problemKey: string;
  /** Effective metadata after merging the fetch over the stored body; null when none exists. */
  readonly problem: NormalizedProblem | null;
  readonly statement: StatementRefreshOutcome;
  readonly editorial: EditorialRefreshOutcome;
  /** Editorial merge outcome; null when no editorial request was made. */
  readonly material: MaterialReport | null;
  /** Committed snapshot; null when there was nothing to persist. */
  readonly snapshot: SnapshotWrite | null;
}

// ---------------------------------------------------------------------------------------
// Problem metadata refresh (metadata only)
// ---------------------------------------------------------------------------------------

/**
 * Fetch one problem's **metadata** without touching its editorial material.
 *
 * This is the entry point an automatic history sync uses for the problems a submission page
 * referenced before their catalog metadata existed. It is deliberately narrower than
 * {@link RefreshMaterialRequest}: there is no `fetchStatement` flag and no editorial request at all,
 * so a background sync can never turn into an editorial fetch (and never into a reasoning call).
 * `refreshMaterial` keeps its own semantics, including its always-on editorial fetch, untouched.
 */
export interface RefreshProblemMetadataRequest {
  readonly problemRef: ProblemRef;
  readonly token: CancellationToken;
  readonly limits: PlatformLimits;
  /**
   * Optional hook awaited **inside** the metadata commit transaction, after the problem row and its
   * snapshot were written and before the transaction commits.
   *
   * It exists for a durable caller that must keep its own record consistent with the write: the Luogu
   * sync service uses it to re-check its source-wide lease — so a takeover or a cancellation aborts
   * the write — and to dequeue the repaired key in the very same transaction, which is what makes
   * "problem written" and "key dequeued" atomic. The hook runs before anything is committed, so a
   * hook that throws rolls the whole metadata write back; it must not open a nested transaction
   * (every store call already joins this one) and must not perform platform or model work.
   */
  readonly beforeCommit?: () => Promise<void>;
}

/**
 * Outcome of one metadata-only refresh.
 *
 * `fetched` means the adapter answered with a real problem whose identity matched the request and
 * the write transaction committed; `failed` carries a typed operational error and wrote nothing.
 * There is no third "nothing happened" success: a problem the adapter cannot answer for is a
 * failure, never a fabricated body.
 */
export interface RefreshProblemMetadataReport {
  readonly problemKey: string;
  readonly status: 'fetched' | 'failed';
  /** Effective metadata after merging the fetch over the stored body; null for a failure. */
  readonly problem: NormalizedProblem | null;
  /** Operational failure; set only for `failed` and never a fake success. */
  readonly error: PlatformError | null;
  /** Committed snapshot descriptor; null when the fetch failed. */
  readonly snapshot: SnapshotWrite | null;
}
