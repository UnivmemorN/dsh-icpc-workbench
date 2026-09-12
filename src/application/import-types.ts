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
import type { EditorialFetchResult, PlatformLimits } from './ports.js';
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
// Paged sync
// ---------------------------------------------------------------------------------------

/** How one sync page relates to the stored checkpoint. */
export type SyncMode = 'start' | 'continue' | 'restart';

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
