/**
 * Luogu synchronization service (Sprint 17c2).
 *
 * One service instance owns the scheduler of **one** official Luogu source instance: it reserves a
 * durable per-account lease, drives bounded history passes through the accepted
 * {@link ImportService}, repairs referenced problem metadata, and records every outcome in the
 * durable {@link LuoguSyncState} of Sprint 17c1. It never talks to a platform directly — the
 * authenticated submissions source and the anonymous metadata adapter arrive as injected ports —
 * and it never sees a credential: the stored-session provider lives in the adapter layer.
 *
 * ## Concurrency model
 *
 * - **One source slot per service, taken before the first `await` of an operation.** A
 *   synchronization pass is published in memory the instant its reservation starts to be written,
 *   and a connection operation is published the same way, so a second caller of *this* service — a
 *   manual `start`, a `startup()`/`tick()` sweep, a queued full reconciliation or a
 *   `connect`/`probe`/`disconnect` — observes the slot instead of taking it. Two live source
 *   operations can therefore never exist merely because they share `ownerId`, which is exactly what
 *   the durable lease alone cannot see: `luoguLeaseHeldByAnother` deliberately treats this owner's
 *   own live lease as recoverable, so the in-memory slot is the authority for same-owner
 *   concurrency and the durable row stays the authority across instances.
 * - **One pass at a time per source instance.** The reservation transaction scans *every* stored
 *   Luogu account and its state (not just the accounts that already have a connection row), so an
 *   account that is currently connecting — and therefore has no connection row yet — still blocks a
 *   foreign pass. A live foreign lease is refused; only an expired one is recovered.
 * - **Connection work is serialized against itself and against the pass.** While a pass (or the
 *   reservation being written for it) owns the source slot, `connect`/`probe`/`disconnect` are
 *   refused as `busy`; while a connection operation owns it, a synchronization claim is refused the
 *   same way. `disconnect` cancels and drains the account's own pass before it removes anything, so
 *   it still works on the account it targets. An identical `start` coalesces only once the
 *   reservation committed — while it is still being written the answer is the honest `busy`,
 *   because the store may yet refuse it.
 * - **Every history commit re-checks the lease inside the page transaction.** The `syncPage`
 *   commit hook reads the state in the page's own transaction and refuses to commit when the state
 *   is no longer owned by this pass, so a stale writer can never overwrite a newer owner and a page
 *   that lost its lease rolls back with its checkpoint.
 * - **Every platform operation runs through the shared source gate.** A history page, a metadata
 *   fetch and a connection probe/test are each one whole gated operation, and the gate keeps the
 *   source-wide floor after the previous operation *finished* — so a page that dispatched several
 *   HTTP requests over several seconds cannot be followed immediately by the next operation.
 * - **`close()` drains everything.** It marks the service closing, cancels the in-flight pass and
 *   every connection operation, and returns only after all of them settled.
 *
 * ## Bounded work and honesty
 *
 * A pass fetches at most {@link LUOGU_SYNC_MAX_PAGES_PER_PASS} history pages of
 * `min(LUOGU_SYNC_PAGE_SIZE, limits.pageSize)` rows and at most {@link LUOGU_SYNC_METADATA_PER_PASS}
 * metadata rows. The explicit `metadata` start mode skips the history half entirely — it reads no
 * page and moves no history watermark, checkpoint or completion flag — and repairs the backlog
 * present at its start once per key (at most {@link LUOGU_SYNC_MAX_METADATA_BACKLOG} keys), so a
 * user can drain a large backlog without pretending it is a history scan. Neither half invokes a
 * model: metadata repair stays the same anonymous platform read as before.
 * Completion is only ever derived from the adapter's `nextCursor: null`. `phase`/`historyComplete`
 * are independent of failures, a manual full reconciliation resets `historyComplete` without
 * deleting stored rows, and the whole-scan start instant is preserved across resumed passes so a
 * multi-day interruption cannot skip records. Failures are recorded as one of the fixed
 * {@link LuoguSyncFailureCode} values with a durable retry instant (or a pause that waits for the
 * user) — never as a raw provider message, and never as a silent success. A failure also records
 * which half of the pass produced it ({@link LuoguSyncFailureStage}): the authenticated history read
 * and the anonymous metadata repair can both answer `auth_required`, and only the recorded stage
 * keeps those two answers apart for the caller.
 *
 * ## Backpressure, not dropping
 *
 * The missing-metadata backlog is capped. When fewer than one page's worth of slots remain the pass
 * stops requesting history pages *before* the fetch, repairs as much of the backlog as the per-pass
 * bound allows (round-robin, so a permanently failing key cannot starve the others) and keeps the
 * checkpoint continuation for a later pass. No key is ever forgotten; `backlogDropped` stays `0`.
 */
import {
  DomainError,
  assertIsoTimestamp,
  createCancellationSource,
  MAX_DISPOSITION_BATCH,
  invariant,
  parseProblemKey,
  throwIfCancelled,
  validateDispositionBatch,
  type Account,
  type CancellationToken,
  type ProblemDispositionAction,
  type ProblemDispositionState,
  type ProblemRef,
  type SourceInstance,
} from '../domain/index.js';
import type { ImportService } from './import-service.js';
import {
  MAX_SUPPLEMENT_STATEMENT_CHARS,
  MAX_SUPPLEMENT_TITLE_CHARS,
  type SnapshotWrite,
  type SyncMode,
  type SyncPageReport,
  type SyncPageSource,
} from './import-types.js';
import { LuoguConnectionError, type LuoguConnectionManager } from './luogu-connection.js';
import { PlatformError, isPlatformError, type PlatformErrorCode, type PlatformErrorReason } from './platform-errors.js';
import type { LuoguSourceGate } from './luogu-source-gate.js';
import {
  LUOGU_SYNC_MAX_BACKOFF_MS,
  LUOGU_SYNC_MAX_METADATA_BACKLOG,
  LUOGU_SYNC_MAX_PAGES_PER_PASS,
  LUOGU_SYNC_METADATA_PER_PASS,
  LUOGU_SYNC_MIN_BACKOFF_MS,
  LUOGU_SYNC_OVERLAP_MS,
  LUOGU_SYNC_PAGE_SIZE,
  LUOGU_SYNC_DEFAULT_LEASE_MS,
  LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE,
  LUOGU_METADATA_MAX_ISSUE_ATTEMPTS,
  LUOGU_METADATA_UNKNOWN_ISSUE_LABEL,
  clearMetadataIssue,
  connectionIsUsable,
  defaultLuoguSyncSettings,
  emptyLuoguSyncState,
  luoguLeaseHeldByAnother,
  luoguLeaseLive,
  luoguSyncFailurePauses,
  metadataIssueFor,
  upsertMetadataIssue,
  validateLuoguSyncSettings,
  type LuoguConnectionState,
  type LuoguMetadataIssue,
  type LuoguSyncFailure,
  type LuoguSyncFailureCode,
  type LuoguSyncFailureStage,
  type LuoguSyncPhase,
  type LuoguSyncSettings,
  type LuoguSyncState,
  type LuoguSyncStateRecord,
  type LuoguSyncStore,
} from './luogu-sync-types.js';
import { DEFAULT_PLATFORM_LIMITS, type AccountProfile, type PlatformAdapter, type PlatformLimits, type TrainingStore } from './ports.js';

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/** Stable codes of a synchronization-service failure a caller may branch on. */
export type LuoguSyncErrorCode =
  | 'account_missing'
  | 'account_foreign'
  | 'not_connected'
  | 'busy'
  | 'closing'
  | 'invalid_input'
  | 'stale_revision'
  | 'unsupported'
  | 'cleanup_failed'
  | 'lease_lost'
  | 'internal';

/**
 * Fixed, secret-free text per code.
 *
 * The message a caller sees is always built from these constants plus an optional bounded,
 * sanitized detail; a session cookie, a provider body or a raw exception message can never travel
 * through it.
 */
const SYNC_ERROR_MESSAGES: Readonly<Record<LuoguSyncErrorCode, string>> = {
  account_missing: 'the requested account is not stored',
  account_foreign: 'the requested account belongs to another source instance',
  not_connected: 'the account has no usable Luogu session',
  busy: 'another Luogu operation is already running',
  closing: 'the Luogu synchronization service is closing',
  invalid_input: 'the synchronization request was rejected',
  stale_revision: 'the stored synchronization record changed; re-read before retrying',
  unsupported: 'the platform cannot store a Luogu session',
  cleanup_failed: 'a stored credential could not be removed',
  lease_lost: 'the synchronization lease is no longer held by this pass',
  internal: 'the synchronization operation failed',
};

const MAX_ERROR_DETAIL_CHARS = 200;
const UNSAFE_ERROR_TEXT = /[\u0000-\u001f\u007f]+/gu;
const WHITESPACE_RUN = /\s+/gu;

function sanitizeDetail(detail: string | undefined, fallback: string): string {
  if (typeof detail !== 'string') {
    return fallback;
  }
  const cleaned = detail.replace(UNSAFE_ERROR_TEXT, ' ').replace(WHITESPACE_RUN, ' ').trim();
  if (cleaned.length === 0) {
    return fallback;
  }
  return cleaned.length <= MAX_ERROR_DETAIL_CHARS ? cleaned : `${cleaned.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
}

/** One typed, sanitized synchronization-service failure. */
export class LuoguSyncError extends Error {
  readonly code: LuoguSyncErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: LuoguSyncErrorCode, detail?: string, details: Readonly<Record<string, unknown>> = {}) {
    super(sanitizeDetail(detail, SYNC_ERROR_MESSAGES[code]));
    this.name = 'LuoguSyncError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------

/**
 * How a start request relates to the durable scan position.
 *
 * `resume` continues the stored checkpoint (or starts the first backfill), `full` restarts an
 * explicit whole-history reconciliation, and `metadata` repairs the missing-metadata backlog only:
 * it never reads a history page and never moves a history watermark. A metadata pass and a history
 * pass are incompatible and never queue behind each other.
 */
export type LuoguSyncStartMode = 'resume' | 'full' | 'metadata';

/** How one `start` call was satisfied. */
export type LuoguSyncStartOutcome = 'started' | 'coalesced' | 'queued';

/** Why one account was not started by `startup()`/`tick()`. */
export type LuoguSyncSkipReason =
  | 'automation_disabled'
  | 'startup_disabled'
  | 'not_connected'
  | 'paused'
  | 'not_due'
  | 'busy'
  | 'already_running';

export interface LuoguSyncSkip {
  readonly accountId: string;
  readonly reason: LuoguSyncSkipReason;
}

/** Result of one automatic sweep (`startup()` or `tick()`). */
export interface LuoguSyncSweepResult {
  readonly started: readonly string[];
  readonly skipped: readonly LuoguSyncSkip[];
}

/**
 * Everything a caller may know about one account's synchronization.
 *
 * `connection` carries the stored, **non-secret** connection record (the opaque vault reference,
 * the observed status and the instants) because the adapter layer needs it for wiring; it is not
 * a credential and cannot be used without the workspace-scoped OS store. Sprint 17d must project
 * this field away before the status reaches the UI or any model input.
 *
 * The status is derived from durable rows (settings, state, checkpoint, connection) plus the
 * in-memory knowledge of *this* service instance. `running` therefore means "this service is
 * running that account's pass right now"; a pass of another instance is visible as a live
 * `leaseOwner` with `running: false`.
 */
export interface LuoguSyncStatus {
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly settings: LuoguSyncSettings;
  readonly connection: LuoguConnectionState | null;
  readonly phase: LuoguSyncPhase;
  readonly historyComplete: boolean;
  /** True when a durable checkpoint continuation exists; the next pass resumes it first. */
  readonly resumePending: boolean;
  /** Time bound the stored checkpoint froze, or `null` for a full-window scan. */
  readonly scanSince: string | null;
  readonly running: boolean;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  /** True when automatic attempts wait for an explicit user action. */
  readonly paused: boolean;
  readonly failure: LuoguSyncFailure | null;
  /** Next instant an automatic attempt becomes due; `null` means "due now" (or blocked). */
  readonly nextRunAt: string | null;
  readonly scanStartedAt: string | null;
  readonly lastScanStartedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly pagesInPass: number;
  readonly totalPages: number;
  readonly submissionsSeen: number;
  readonly metadataBacklog: number;
  readonly metadataBacklogFull: boolean;
  readonly metadataResolved: number;
  readonly metadataFailed: number;
  /** Always `0`: this build refuses a write instead of forgetting a backlog key. */
  readonly backlogDropped: number;
  readonly closing: boolean;
}

/** Result of one `start` call; the durable plan is visible in `status`. */
export interface LuoguSyncStartResult {
  readonly accountId: string;
  readonly mode: LuoguSyncStartMode;
  readonly outcome: LuoguSyncStartOutcome;
  readonly status: LuoguSyncStatus;
}

/** Automatic-sync fields a caller may change; the contract is closed, not best-effort. */
export interface LuoguSyncSettingsPatch {
  readonly automaticEnabled?: boolean;
  readonly runOnStartup?: boolean;
  readonly intervalMinutes?: number;
}

const SETTINGS_PATCH_KEYS: ReadonlySet<string> = new Set([
  'automaticEnabled',
  'runOnStartup',
  'intervalMinutes',
]);

export interface LuoguSyncServiceOptions {
  /** Store providing both the training data and the Sprint 17c1 Luogu state/settings/connection rows. */
  readonly store: TrainingStore & LuoguSyncStore;
  /** Accepted import orchestration used for every history page and metadata fetch. */
  readonly imports: ImportService;
  /** Accepted connection port used by `connect`/`probe`/`disconnect`. */
  readonly connections: LuoguConnectionManager;
  /** The official Luogu instance this service synchronizes. */
  readonly sourceInstance: SourceInstance;
  /** Authenticated submissions source of one account (stored session, re-read per call). */
  readonly submissionsFor: (account: Account) => SyncPageSource;
  /** Anonymous metadata source of the same instance; only `fetchProblem` is ever used. */
  readonly metadataSource: PlatformAdapter;
  /** Lease owner identity; must be unique per running service instance. */
  readonly ownerId: string;
  /** Injected clock returning an ISO-8601 timestamp. */
  readonly now: () => string;
  /** Injected cancellation-aware wait; the only timer this service uses. */
  readonly wait: (ms: number, token: CancellationToken) => Promise<void>;
  /** Shared source-wide operation gate (must be the one the connection adapter uses too). */
  readonly gate: LuoguSourceGate;
  /** Explicit platform limits; defaults to the approved v1 policy. */
  readonly limits?: PlatformLimits;
  /** Lease length for one pass; defaults to a length covering one page within the request budget. */
  readonly leaseMs?: number;
}

/** One durable reservation: what the pass must do with the stored checkpoint. */
interface Claim {
  readonly pageMode: SyncMode;
  /** Frozen time bound; `null` means the full window. */
  readonly since: string | null;
  /** True for the explicit `metadata` mode: repair the backlog, read no history at all. */
  readonly metadataOnly: boolean;
}

interface ClaimRequest {
  readonly purpose: 'sync' | 'metadata' | 'connect' | 'probe' | 'profile' | 'repair';
  readonly mode: LuoguSyncStartMode;
}

/**
 * The one source slot of this service: a synchronization pass from the instant its reservation
 * starts to be written until it settled.
 *
 * The object is published to `LuoguSyncService.running` **synchronously**, before the durable
 * reservation is written, so every other caller of this service observes it instead of reserving
 * the same source twice. `launched` becomes true only once the reservation committed and the pass
 * work was attached; that is what lets a caller tell "the store may still refuse this" (answer
 * `busy`) from "this pass really runs" (coalesce with it or queue behind it).
 */
interface RunningPass {
  readonly accountId: string;
  readonly mode: LuoguSyncStartMode;
  readonly source: ReturnType<typeof createCancellationSource>;
  /** Settles once: when a refused reservation is retired, or when a launched pass finished. */
  readonly promise: Promise<void>;
  /** Resolves {@link promise}; called exactly once by `finishPass`. */
  readonly finish: () => void;
  /** True once the durable reservation committed and the pass work was attached. */
  launched: boolean;
  /** A manual full reconciliation requested while this pass runs. */
  queuedFull: boolean;
}

/**
 * Combine a caller token with the service's close token; either cancels the operation.
 *
 * Exported so the typed API boundary can link its route lifetime to a request token the same way:
 * a disposal there interrupts the platform call a handler is waiting on instead of waiting for that
 * call to finish before the service may close.
 */
export function combineTokens(first: CancellationToken, second: CancellationToken): CancellationToken {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  first.onCancel(notify);
  second.onCancel(notify);
  const combined: CancellationToken = {
    get cancelled() {
      return first.cancelled || second.cancelled;
    },
    get reason() {
      return first.cancelled ? first.reason : second.reason;
    },
    throwIfCancelled() {
      if (first.cancelled) {
        first.throwIfCancelled();
      }
      if (second.cancelled) {
        second.throwIfCancelled();
      }
    },
    onCancel(listener) {
      if (combined.cancelled) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return combined;
}

/**
 * Default lease length of one pass.
 *
 * A page is the longest valid unit of work, and the transport bounds it by
 * `maxRetries + 1` attempts of `requestTimeoutMs` plus their pacing. The lease is at least the
 * contract default and otherwise exactly that worst case, so a long but still valid request cannot
 * outlive its lease, and a pass does not hold a lease far longer than its own request budget.
 */
function defaultLeaseMs(limits: PlatformLimits): number {
  const attempts = Math.max(1, limits.maxRetries + 1);
  const worstCase = attempts * (limits.requestTimeoutMs + limits.minRequestIntervalMs);
  return Math.max(LUOGU_SYNC_DEFAULT_LEASE_MS, worstCase + limits.minRequestIntervalMs);
}

/** Start of the incremental window: the last successful scan start minus the 7-day overlap. */
function incrementalSince(lastScanStartedAt: string | null): string | null {
  if (lastScanStartedAt === null) {
    return null;
  }
  return new Date(Date.parse(lastScanStartedAt) - LUOGU_SYNC_OVERLAP_MS).toISOString();
}

/**
 * Durable due instant of an account's next automatic attempt.
 *
 * Everything is derived from persisted facts, so a restart cannot loop: a pausing failure is `null`
 * (wait for the user), a retryable failure resumes exactly at its persisted `retryAt`, an
 * unfinished scan waits one interval after its last durable write, a completed scan waits one
 * interval after its last success, and an account that never attempted anything is due immediately.
 */
function nextRunAt(state: LuoguSyncState, settings: LuoguSyncSettings): string | null {
  const failure = state.failure;
  if (failure !== null) {
    if (failure.paused) {
      return null;
    }
    if (failure.retryAt !== null) {
      return failure.retryAt;
    }
  }
  const unfinished = state.scanStartedAt !== null;
  const anchor = unfinished ? state.updatedAt : state.lastSuccessAt;
  if (anchor === null) {
    return null;
  }
  return new Date(Date.parse(anchor) + settings.intervalMinutes * 60_000).toISOString();
}

/** Doubling delay derived from the previous durable failure; bounded by the contract ceiling. */
function exponentialBackoff(previous: LuoguSyncFailure | null): number {
  if (previous === null || previous.retryAt === null) {
    return LUOGU_SYNC_MIN_BACKOFF_MS;
  }
  const previousDelay = Date.parse(previous.retryAt) - Date.parse(previous.at);
  if (!Number.isFinite(previousDelay) || previousDelay <= 0) {
    return LUOGU_SYNC_MIN_BACKOFF_MS;
  }
  return Math.min(Math.max(previousDelay * 2, LUOGU_SYNC_MIN_BACKOFF_MS), LUOGU_SYNC_MAX_BACKOFF_MS);
}

/** Map an operational platform code onto the persisted failure vocabulary. */
function failureCodeOf(code: PlatformErrorCode): LuoguSyncFailureCode {
  switch (code) {
    case 'auth_required':
      return 'auth_required';
    case 'forbidden':
      return 'forbidden';
    case 'rate_limited':
      return 'rate_limited';
    case 'changed_response':
      return 'changed_response';
    case 'invalid_input':
      return 'invalid_input';
    case 'unavailable':
      return 'unavailable';
    case 'cancelled':
      return 'internal';
  }
}

/** Custom problem key: `U` or `T` followed by digits; access is classified only after a refusal. */
const PRIVATE_USER_PROBLEM_KEY = /^[UT]\d+$/u;

/**
 * True when one metadata answer is an **item-level** refusal of a private/user-created problem.
 *
 * The platform publishes user-created personal problems under `U` / `T` ids, and its public problem guide
 * documents private personal problems
 * (<https://help.luogu.com.cn/manual/luogu/problem/>). An anonymous metadata read of one may
 * therefore answer `auth_required` or `forbidden` while the session and every public problem remain
 * fine, so this is a refusal of *that key* and never evidence that the stored session expired. The
 * decision reads the canonical {@link ProblemRef.externalKey} of the parsed reference, so no raw
 * string, URL or display name can be mistaken for the private-key prefix.
 */
function isPrivateProblemRefusal(ref: ProblemRef, code: LuoguSyncFailureCode): boolean {
  return (code === 'auth_required' || code === 'forbidden') && PRIVATE_USER_PROBLEM_KEY.test(ref.externalKey);
}

/**
 * A successful one-key retry clears a stored failure only when it is this build's **metadata**
 * failure naming exactly that key.
 *
 * A history failure, a legacy stage-less record and a failure naming another key are evidence of
 * work this retry did not perform, so each survives verbatim; only the item the retry addressed can
 * have its own record cleared.
 */
function clearRetriedItemFailure(failure: LuoguSyncFailure | null, problemKeyValue: string): LuoguSyncFailure | null {
  return failure !== null && failure.stage === 'metadata' && failure.problemKey === problemKeyValue ? null : failure;
}

/**
 * The stored failure after a failed one-key retry.
 *
 * The retry's own item-scoped failure is recorded — with its backoff derived from the previous
 * record — but a preexisting history (or legacy stage-less) failure belongs to the other half of the
 * pass and is not erased by a retry of one metadata key.
 */
function retryFailure(previous: LuoguSyncFailure | null, next: LuoguSyncFailure): LuoguSyncFailure {
  return previous !== null && previous.stage !== 'metadata' ? previous : next;
}

/** True for the store's stale-revision refusal, the one expected compare-and-set loss. */
function isStaleRevision(error: unknown): boolean {
  return (
    error instanceof DomainError &&
    (error.code === 'invalid_transition' || error.code === 'duplicate_id') &&
    error.details['reason'] === 'stale_revision'
  );
}

/** Longest nickname this service accepts from a profile port; matches the platform field bound. */
const MAX_PROFILE_NAME_CHARS = 256;

/**
 * Re-validate one profile answer against the account it claims to describe.
 *
 * The adapter already validated its own payload; this second check makes the service independent of
 * a hostile or broken port: the answer must name this source instance and the account's own
 * canonical uid, and its nickname must be a non-blank bounded string without control characters.
 * A mismatch is a `changed_response`, never a nickname written onto another identity.
 */
function requireAccountProfile(account: Account, sourceInstanceId: string, profile: AccountProfile): string {
  if (
    profile === null ||
    typeof profile !== 'object' ||
    profile.sourceInstanceId !== sourceInstanceId ||
    profile.uid !== account.handle
  ) {
    throw new PlatformError({
      code: 'changed_response',
      operation: 'profile',
      retryable: false,
      detail: 'the profile source answered a profile of another account',
    });
  }
  const displayName = typeof profile.displayName === 'string' ? profile.displayName.trim() : '';
  if (displayName.length === 0 || displayName.length > MAX_PROFILE_NAME_CHARS || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw new PlatformError({
      code: 'changed_response',
      operation: 'profile',
      retryable: false,
      detail: 'the profile source answered an unusable display name',
    });
  }
  return displayName;
}

/** Default page size of the luogu.managedProblems read. */
export const LUOGU_MANAGED_PROBLEMS_DEFAULT_PAGE_SIZE = 20;

/**
 * Maximum accepted pageSize of the luogu.managedProblems read.
 *
 * The store's disposition read refuses more than 50 rows, so the boundary and the service enforce
 * exactly that bound instead of letting a caller ask for an unbounded recovery page.
 */
export const LUOGU_MANAGED_PROBLEMS_MAX_PAGE_SIZE = 50;

/**
 * Durable, source-wide synchronization service for the official Luogu instance.
 *
 * Construct once per running plugin instance. The service is stateful only in the ways the contract
 * requires (the in-flight pass, the per-account connection locks and the queued full request);
 * every durable fact lives in the store and every timestamp comes from the injected clock.
 */
export class LuoguSyncService {
  private readonly store: TrainingStore & LuoguSyncStore;
  private readonly imports: ImportService;
  private readonly connections: LuoguConnectionManager;
  private readonly sourceInstance: SourceInstance;
  private readonly submissionsFor: (account: Account) => SyncPageSource;
  private readonly metadataSource: PlatformAdapter;
  private readonly ownerId: string;
  private readonly now: () => string;
  private readonly gate: LuoguSourceGate;
  private readonly limits: PlatformLimits;
  private readonly leaseMs: number;

  private readonly closeSource = createCancellationSource();
  private readonly connectionOps = new Map<string, Promise<void>>();
  private readonly backgroundFailures: unknown[] = [];
  private idleWaiters: Array<() => void> = [];
  private running: RunningPass | null = null;
  private pendingLaunches = 0;
  private closing = false;
  private closed = false;

  constructor(options: LuoguSyncServiceOptions) {
    invariant(
      options !== null && typeof options === 'object' && options.store !== null && typeof options.store === 'object',
      'unfilled_settings',
      'LuoguSyncService requires an explicit store',
    );
    invariant(
      typeof options.ownerId === 'string' && options.ownerId.trim().length > 0,
      'unfilled_settings',
      'LuoguSyncService requires an explicit ownerId',
    );
    invariant(typeof options.now === 'function', 'unfilled_settings', 'LuoguSyncService requires an explicit now() clock');
    invariant(typeof options.wait === 'function', 'unfilled_settings', 'LuoguSyncService requires an explicit wait() port');
    invariant(
      options.gate !== null && typeof options.gate === 'object' && typeof options.gate.run === 'function',
      'unfilled_settings',
      'LuoguSyncService requires the shared source gate',
    );
    invariant(
      typeof options.submissionsFor === 'function',
      'unfilled_settings',
      'LuoguSyncService requires a submissions source factory',
    );
    invariant(
      options.metadataSource !== null && typeof options.metadataSource === 'object',
      'unfilled_settings',
      'LuoguSyncService requires an anonymous metadata source',
    );
    this.store = options.store;
    this.imports = options.imports;
    this.connections = options.connections;
    this.sourceInstance = options.sourceInstance;
    this.submissionsFor = options.submissionsFor;
    this.metadataSource = options.metadataSource;
    this.ownerId = options.ownerId;
    this.now = options.now;
    this.gate = options.gate;
    this.limits = options.limits ?? DEFAULT_PLATFORM_LIMITS;
    const configuredLease = options.leaseMs ?? defaultLeaseMs(this.limits);
    invariant(
      Number.isSafeInteger(configuredLease) && configuredLease > 0,
      'invalid_input',
      'leaseMs must be a positive safe integer',
      { leaseMs: configuredLease },
    );
    this.leaseMs = configuredLease;
  }

  // -------------------------------------------------------------------------------------
  // Status and settings
  // -------------------------------------------------------------------------------------

  /** Current durable status of one stored Luogu account, plus this service's in-flight knowledge. */
  async status(accountId: string): Promise<LuoguSyncStatus> {
    const account = await this.requireAccount(accountId);
    const at = this.nowIso();
    const settingsRecord = await this.store.getLuoguSyncSettings(account.id);
    const stateRecord = await this.store.getLuoguSyncState(account.id);
    const connectionRecord = await this.store.getLuoguConnection(account.id);
    const checkpoint = await this.store.getSyncCheckpoint(this.checkpointRef(account.id));
    const settings = settingsRecord?.value ?? defaultLuoguSyncSettings(account.id, at);
    const state = stateRecord?.value ?? emptyLuoguSyncState(account.id, this.sourceInstance.id, at);
    return {
      accountId: account.id,
      sourceInstanceId: this.sourceInstance.id,
      settings,
      connection: connectionRecord?.value ?? null,
      phase: state.phase,
      historyComplete: state.historyComplete,
      resumePending: checkpoint !== null && checkpoint.cursor !== null,
      scanSince: checkpoint === null ? null : checkpoint.since,
      running: this.running !== null && this.running.accountId === account.id,
      leaseOwner: state.owner,
      leaseExpiresAt: state.leaseExpiresAt,
      paused: state.failure !== null && state.failure.paused,
      failure: state.failure,
      nextRunAt: nextRunAt(state, settings),
      scanStartedAt: state.scanStartedAt,
      lastScanStartedAt: state.lastScanStartedAt,
      lastSuccessAt: state.lastSuccessAt,
      pagesInPass: state.pagesInPass,
      totalPages: state.totalPages,
      submissionsSeen: state.submissionsSeen,
      metadataBacklog: state.missingMetadata.length,
      metadataBacklogFull: state.missingMetadata.length >= LUOGU_SYNC_MAX_METADATA_BACKLOG,
      metadataResolved: state.metadataResolved,
      metadataFailed: state.metadataFailed,
      backlogDropped: state.backlogDropped,
      closing: this.closing,
    };
  }

  /**
   * Change one account's automatic-sync settings under revision CAS.
   *
   * The patch is a closed contract: an unknown field is refused instead of ignored. `expectedRevision`
   * is `null` only before the first settings row exists. Enabling automation is stored as stated;
   * the account only becomes *eligible* once its stored connection reports `connected`.
   */
  async configure(
    accountId: string,
    expectedRevision: number | null,
    patch: LuoguSyncSettingsPatch,
    token?: CancellationToken,
  ): Promise<LuoguSyncStatus> {
    this.assertUsable(token ?? null);
    const account = await this.requireAccount(accountId);
    const record = await this.store.getLuoguSyncSettings(account.id);
    const base = record?.value ?? defaultLuoguSyncSettings(account.id, this.nowIso());
    const merged = applySettingsPatch(base, patch, this.nowIso());
    const expected = expectedRevision ?? null;
    if (record === null ? expected !== null : expected !== record.revision) {
      throw new LuoguSyncError(
        'stale_revision',
        `the stored settings of ${account.id} are at revision ${record === null ? 'none' : String(record.revision)}, not ${String(expected)}`,
        { accountId: account.id, expectedRevision: expected, storedRevision: record?.revision ?? null },
      );
    }
    await this.store.saveLuoguSyncSettings(merged, expected);
    return this.status(account.id);
  }

  // -------------------------------------------------------------------------------------
  // Connection operations (serialized with synchronization per account)
  // -------------------------------------------------------------------------------------

  /**
   * Validate a freshly supplied session and store it as the account's connection.
   *
   * The connection adapter performs the real work (test the ephemeral cookie through an
   * authenticated reader, store a fresh opaque reference, persist it before deleting the previous
   * secret); this method only enforces source-wide exclusivity and the per-account serialization,
   * and clears a pausing failure on success because an explicit reconnect is exactly the user
   * action a paused account waits for.
   */
  async connect(accountId: string, sessionCookie: string, token: CancellationToken): Promise<LuoguSyncStatus> {
    this.assertUsable(token);
    const account = await this.requireAccount(accountId);
    return this.runConnectionOp(account.id, token, async (opToken) => {
      const claim = await this.claim(account, { purpose: 'connect', mode: 'resume' }, opToken);
      void claim;
      let connected = false;
      try {
        // The reservation above is already durable. A close that landed while it was written refuses
        // here, and the `finally` releases the reservation it committed.
        this.assertUsable(opToken);
        await this.connections.connect({ accountId: account.id, sessionCookie, token: opToken });
        connected = true;
      } finally {
        await this.releaseLease(account.id, connected);
      }
      return this.status(account.id);
    });
  }

  /**
   * Re-observe the stored session and persist the observed status.
   *
   * A session-level refusal is *data*: the adapter records it and this method reports it through
   * `status().connection`. Only a missing account, a missing connection or an unsupported platform
   * rejects.
   *
   * A successful probe never clears a stored synchronization failure. It only proves that the
   * session works *now*, so a paused account stays paused (and its failure stays visible) until the
   * user explicitly reconnects or continues; the probe releases the lease with
   * `clearPausingFailure: false` for exactly that reason.
   */
  async probe(accountId: string, token: CancellationToken): Promise<LuoguSyncStatus> {
    this.assertUsable(token);
    const account = await this.requireAccount(accountId);
    return this.runConnectionOp(account.id, token, async (opToken) => {
      await this.claim(account, { purpose: 'probe', mode: 'resume' }, opToken);
      try {
        this.assertUsable(opToken);
        await this.connections.probe(account.id, opToken);
      } finally {
        await this.releaseLease(account.id, false);
      }
      return this.status(account.id);
    });
  }

  /**
   * Refresh one account's public nickname from the anonymous profile endpoint.
   *
   * This is a **public, anonymous** read: it needs no stored session, works before any connection
   * exists and on a host whose credential backend is unsupported, and never touches the vault, the
   * connection rows, the submissions reader or the model gateway. It still takes the service's one
   * source slot and the durable per-account lease — through the same `runConnectionOp` path as
   * `connect`/`probe` — so it is refused as `busy` while a pass or another source operation runs and
   * is cancelled by {@link close}. Its claim records no history work and no failure: the phase,
   * watermarks, checkpoint, missing-metadata backlog and any stored synchronization failure are
   * preserved exactly as they were, and the lease is released with `clearPausingFailure: false`.
   *
   * The nickname is written only after the answer was re-validated against the account's own
   * canonical uid, and only inside one transaction that re-reads the account, re-checks that its
   * identity did not change and re-checks this operation's own live lease with a clock reading taken
   * *inside* that transaction. The caller's combined token is checked after the fetch, on both sides
   * of every awaited read, and immediately before and after the write, so a port that answers after
   * the caller cancelled — or a store read that waited across a cancellation — rolls the nickname
   * back instead of saving it. Every field except `displayName` stays exactly as stored; a failed,
   * malformed or cancelled lookup leaves the previous nickname and every durable record untouched.
   *
   * A missing optional `fetchAccountProfile` capability is refused as the typed `unsupported`
   * operation before any store or platform work: it is a capability gap of the configured source,
   * not a credential-backend condition and not an internal failure.
   *
   * Returns the updated {@link Account}, never the platform payload the nickname came from.
   */
  async refreshProfile(accountId: string, token: CancellationToken): Promise<Account> {
    this.assertUsable(token);
    const account = await this.requireAccount(accountId);
    const fetchProfile = this.metadataSource.fetchAccountProfile;
    if (typeof fetchProfile !== 'function') {
      throw new LuoguSyncError('unsupported', 'the configured Luogu source cannot read a public nickname', {
        accountId: account.id,
      });
    }
    return this.runConnectionOp(account.id, token, async (opToken) => {
      await this.claim(account, { purpose: 'profile', mode: 'resume' }, opToken);
      try {
        const answer = await this.gate.run(opToken, async () => {
          throwIfCancelled(opToken);
          // The claim above is durable, but the shared gate may park this operation behind another
          // source operation for a long time. The current lease is therefore re-taken and re-checked
          // inside the callback, immediately before the request: a takeover or expiry during that
          // wait must issue no public request and must never dispatch on a stale claim.
          await this.renewLease(account.id, 'before a profile request');
          throwIfCancelled(opToken);
          return fetchProfile.call(this.metadataSource, { account, token: opToken, limits: this.limits });
        });
        // A port may answer after the caller cancelled; the answer is discarded instead of stored.
        throwIfCancelled(opToken);
        const displayName = requireAccountProfile(account, this.sourceInstance.id, answer);
        return await this.storeProfile(account, displayName, opToken);
      } finally {
        await this.releaseLease(account.id, false);
      }
    });
  }

  /**
   * Read one bounded, deterministic page of the durable missing-metadata backlog.
   *
   * The answer is a **projection of stored rows**, not a platform read: it makes no request, moves no
   * watermark and never writes. It is bounded (at most `pageSize` items are assembled, `pageSize` is
   * validated by the typed API and by this method), deterministic (keys with a recorded per-key
   * diagnostic first, then the remaining keys in durable queue order) and honest about unknowns: a
   * key with no stored diagnostic answers `issue: null` plus the fixed
   * {@link LUOGU_METADATA_UNKNOWN_ISSUE_LABEL} sentence, which claims only that no per-key failure
   * has been recorded — never that the key was never attempted.
   *
   * `knownIssues` counts the items of this page that carry a diagnostic; `historicalFailedAttempts`
   * is the state's lifetime counter and is deliberately a different number.
   */
  async metadataBacklog(
    accountId: string,
    page: number,
    pageSize: number,
  ): Promise<{
    readonly accountId: string;
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly knownIssues: number;
    readonly historicalFailedAttempts: number;
    readonly unknownIssueLabel: string;
    readonly items: readonly {
      readonly problemKey: string;
      readonly externalKey: string;
      readonly url: string;
      readonly title: string | null;
      readonly issue: LuoguMetadataIssue | null;
      readonly expectedSnapshotId: string | null;
    }[];
  }> {
    const account = await this.requireAccount(accountId);
    invariant(
      Number.isSafeInteger(page) && page >= 1,
      'invalid_input',
      'metadata backlog page must be an integer >= 1',
      { page },
    );
    invariant(
      Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE,
      'invalid_input',
      `metadata backlog pageSize must be an integer within 1..${LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE}`,
      { pageSize },
    );
    const record = await this.store.getLuoguSyncState(account.id);
    const state = record === null ? null : record.value;
    const known = new Map<string, LuoguMetadataIssue>();
    for (const issue of state?.metadataIssues ?? []) {
      known.set(issue.problemKey, issue);
    }
    const backlog = state === null ? [] : [...state.missingMetadata];
    // Known issues first, then queue order: the presentation is stable and explainable, and it never
    // depends on the order a store happens to return rows in.
    const ordered = [...backlog.filter((key) => known.has(key)), ...backlog.filter((key) => !known.has(key))];
    const start = (page - 1) * pageSize;
    const items: {
      readonly problemKey: string;
      readonly externalKey: string;
      readonly url: string;
      readonly title: string | null;
      readonly issue: LuoguMetadataIssue | null;
      readonly expectedSnapshotId: string | null;
    }[] = [];
    for (const key of ordered.slice(start, start + pageSize)) {
      const ref = parseProblemKey(key);
      const stored = await this.store.getProblem(key);
      const head = await this.store.getCurrentSnapshotHead(ref);
      items.push({
        problemKey: key,
        externalKey: ref.externalKey,
        // Derived from the configured source base url; this operation performs no request.
        url: `${this.sourceInstance.baseUrl.replace(/\/+$/u, '')}/problem/${encodeURIComponent(ref.externalKey)}`,
        title: stored === null ? null : stored.title,
        issue: known.get(key) ?? null,
        expectedSnapshotId: head === null ? null : head.snapshotId,
      });
    }
    return {
      accountId: account.id,
      total: ordered.length,
      page,
      pageSize,
      knownIssues: items.filter((item) => item.issue !== null).length,
      historicalFailedAttempts: state === null ? 0 : state.metadataFailed,
      unknownIssueLabel: LUOGU_METADATA_UNKNOWN_ISSUE_LABEL,
      items,
    };
  }

  // -------------------------------------------------------------------------------------
  // Local problem management (Sprint 27b)
  // -------------------------------------------------------------------------------------

  /**
   * One bounded page of the durable problem dispositions of this source instance.
   *
   * This is a projection of stored tombstones plus the raw stored title: no platform read, no
   * connection, no lease and no request, so it works on a disconnected account. A disposition is
   * global to the canonical native key, so every account of this source sees the same entries.
   * The title is the raw stored title even while a trash hides the row; the store's explicit
   * recovery read is the only view allowed to return it.
   */
  async managedProblems(
    accountId: string,
    state: ProblemDispositionState,
    page: number,
    pageSize: number,
  ): Promise<{
    readonly items: readonly {
      readonly problemKey: string;
      readonly externalKey: string;
      readonly title: string | null;
      readonly state: ProblemDispositionState;
      readonly updatedAt: string;
    }[];
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
  }> {
    await this.requireAccount(accountId);
    invariant(
      state === 'skipped' || state === 'trashed',
      'invalid_input',
      'unknown disposition state ' + String(state),
    );
    invariant(
      Number.isSafeInteger(page) && page >= 1,
      'invalid_input',
      'managed problems page must be an integer >= 1',
      { page },
    );
    invariant(
      Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= LUOGU_MANAGED_PROBLEMS_MAX_PAGE_SIZE,
      'invalid_input',
      'managed problems pageSize must be an integer within 1..' + String(LUOGU_MANAGED_PROBLEMS_MAX_PAGE_SIZE),
      { pageSize },
    );
    const stored = await this.store.listProblemDispositions({
      sourceInstanceId: this.sourceInstance.id,
      state,
      page,
      limit: pageSize,
    });
    return {
      items: stored.items.map((item) => ({
        problemKey: item.problemKey,
        // The key was validated when the tombstone was written; parsing recovers the platform-facing
        // key for the caller without exposing any raw platform value.
        externalKey: parseProblemKey(item.problemKey).externalKey,
        title: item.title,
        state: item.state,
        updatedAt: item.updatedAt,
      })),
      total: stored.totalItems,
      page: stored.page,
      pageSize: stored.pageSize,
    };
  }

  /**
   * Change the durable disposition of up to MAX_DISPOSITION_BATCH canonical native keys.
   *
   * A purely local operation: no connection, no cookie, no model and no platform request, so a
   * disconnected account can still skip, trash or restore the problems it already knows. It still
   * takes this service's one source slot and the durable source-wide lease through runConnectionOp
   * and claim (purpose repair), so it can never race a pass or a live foreign lease; a foreign live
   * lease is refused as busy before any write. The lease is released in the finally even when the
   * batch is refused.
   *
   * One store transaction owns the whole mutation: it re-reads this operation's own state with a
   * clock reading taken after that read (a lease that expired or was taken over while the store
   * waited refuses), applies the domain's atomic CAS batch (active is the public spelling of the
   * internal "no disposition"), and then removes every affected key from the queue and the per-key
   * diagnostics of every account of this source, clearing a stored failure only when it names one
   * of the affected keys. Watermarks, checkpoints, counters, other backlog keys and other failures
   * are copied verbatim: nothing is advanced or fabricated and no raw row is deleted.
   *
   * A restore removes the tombstone first (so the store's hidden predicate no longer applies) and
   * queues back only the affected keys whose problem row does not exist **or carries no usable
   * statement** (absent or blank), into the initiating account's backlog. If the backlog cannot hold
   * them the whole transaction, including the tombstone removal, rolls back. Cancellation and the
   * initiator's own live lease are re-checked on both sides of every awaited store call — including
   * after the queue cleanup, immediately before this transaction's write boundary — so a
   * cancellation or a lease that expired while an awaited read was pending rolls the batch back
   * completely instead of committing it on a reading taken before the wait.
   */
  async manageProblems(
    request: {
      readonly accountId: string;
      readonly action: ProblemDispositionAction;
      readonly items: readonly {
        readonly problemKey: string;
        readonly expectedState: ProblemDispositionState | null;
      }[];
    },
    token: CancellationToken,
  ): Promise<{ readonly changed: number }> {
    this.assertUsable(token);
    invariant(
      request !== null && typeof request === 'object' && !Array.isArray(request),
      'invalid_input',
      'manage request must be an object',
    );
    const account = await this.requireAccount(request.accountId);
    invariant(
      Array.isArray(request.items) && request.items.length >= 1 && request.items.length <= MAX_DISPOSITION_BATCH,
      'invalid_input',
      'a disposition batch holds 1..' + String(MAX_DISPOSITION_BATCH) + ' keys',
      { items: Array.isArray(request.items) ? request.items.length : null },
    );
    // The domain owns the closed batch contract (action vocabulary, distinct canonical keys,
    // expected-state vocabulary); a key of another source instance is refused below, before any
    // lease, store write or platform work.
    const batch = validateDispositionBatch(request.action, request.items);
    for (const key of batch.problemKeys) {
      if (parseProblemKey(key).sourceInstanceId !== this.sourceInstance.id) {
        throw new LuoguSyncError('account_foreign', 'problem ' + key + ' does not belong to this Luogu instance', {
          problemKey: key,
        });
      }
    }
    const items = request.items.map((item) => ({
      problemKey: item.problemKey,
      expectedState: item.expectedState,
    }));
    return this.runConnectionOp(account.id, token, async (opToken) => {
      let changed = 0;
      try {
        await this.claim(account, { purpose: 'repair', mode: 'resume' }, opToken);
        changed = await this.store.transaction(async () => {
          // The clock is read inside the helper, after the awaited state read: a lease that expired
          // while the store waited is not accepted on the strength of a reading taken before it.
          await this.requireLiveRepairLease(account, opToken, 'before the batch');
          throwIfCancelled(opToken);
          const count = await this.store.applyProblemDispositions({
            accountId: account.id,
            action: request.action,
            items,
          });
          // A cancellation that landed while the CAS wrote must not commit it: throwing here rolls
          // the batch and the queue cleanup back together.
          throwIfCancelled(opToken);
          await this.cleanupDispositionQueues(account.id, batch.problemKeys, request.action, opToken);
          // The cleanup awaited per-account state reads and per-key problem reads, so this is the
          // batch's real write boundary: the initiator's live lease is re-derived from a row read
          // after that work, with a clock reading taken after the read. A lease that expired or was
          // taken over while the cleanup waited refuses the commit here instead of validating the
          // whole batch against the reading taken before the CAS.
          await this.requireLiveRepairLease(account, opToken, 'before the batch commit');
          throwIfCancelled(opToken);
          return count;
        });
      } finally {
        await this.releaseLease(account.id, false);
      }
      return { changed };
    });
  }

  /**
   * Re-assert this repair operation's own live lease from a row read at the write boundary.
   *
   * The state is read first and the clock is read **after** that awaited read, then the row must
   * still be this account's state of this source instance, still owned by this service, with an
   * unexpired deadline. Called before the CAS batch and again after the queue cleanup, so a lease
   * that expired or was taken over while any of those awaited reads was pending refuses here
   * instead of committing on a stale reading.
   */
  private async requireLiveRepairLease(
    account: Account,
    token: CancellationToken,
    phase: string,
  ): Promise<void> {
    throwIfCancelled(token);
    const record = await this.store.getLuoguSyncState(account.id);
    throwIfCancelled(token);
    const current = record === null ? null : record.value;
    const at = this.nowIso();
    if (
      current === null ||
      current.accountId !== account.id ||
      current.sourceInstanceId !== this.sourceInstance.id ||
      current.owner !== this.ownerId ||
      !luoguLeaseLive(current, this.ownerId, at)
    ) {
      throw new LuoguSyncError('lease_lost', `the disposition lease was lost ${phase}`, {
        accountId: account.id,
      });
    }
  }

  /**
   * Remove affected keys from every account queue of this source and clear their diagnostics.
   *
   * Runs inside the caller's transaction, the one that already holds the CAS batch, so the durable
   * disposition and the queue cleanup commit together or not at all. Every account of the source
   * instance is scanned, not only the initiating one, because a disposition is global to the
   * canonical native key: a key skipped or trashed from one account is never fetched for another.
   * Only the affected keys are touched; every other backlog key keeps its order and its per-key
   * diagnostic, and a stored failure is cleared only when it explicitly names one of them. History
   * fields, checkpoints and counters are copied verbatim.
   *
   * For a restore the affected keys whose problem row does not exist, or whose stored statement is
   * absent or blank, are queued back into the initiating account's backlog: a row without a usable
   * statement is exactly the user's empty testcase, which still needs repair, while a retained
   * non-blank statement needs nothing and is never re-queued. The tombstone was already removed by
   * the CAS above, so the store's trash predicate no longer hides an existing raw row and the
   * decision reads the now-visible raw statement. An overflow of the bounded backlog aborts the
   * whole transaction.
   */
  private async cleanupDispositionQueues(
    initiatingAccountId: string,
    affected: readonly string[],
    action: ProblemDispositionAction,
    token: CancellationToken,
  ): Promise<void> {
    if (affected.length === 0) {
      return;
    }
    const keys = new Set(affected);
    const accounts = await this.store.listAccounts(this.sourceInstance.id);
    throwIfCancelled(token);
    for (const candidate of accounts) {
      const record = await this.store.getLuoguSyncState(candidate.id);
      throwIfCancelled(token);
      if (record === null) {
        continue;
      }
      const current = record.value;
      const currentIssues = current.metadataIssues ?? [];
      const missingMetadata = current.missingMetadata.filter((key) => !keys.has(key));
      const metadataIssues = currentIssues.filter((issue) => !keys.has(issue.problemKey));
      const failure =
        current.failure !== null && current.failure.problemKey !== undefined && keys.has(current.failure.problemKey)
          ? null
          : current.failure;
      let nextBacklog: readonly string[] = missingMetadata;
      if (action === 'restore' && candidate.id === initiatingAccountId) {
        const restored: string[] = [...missingMetadata];
        for (const key of affected) {
          if (restored.includes(key)) {
            continue;
          }
          const stored = await this.store.getProblem(key);
          throwIfCancelled(token);
          // A stored row whose statement is absent or blank is exactly the problem the user's own
          // empty testcases report: the raw row exists but carries no usable material, so a restore
          // queues it for repair. Only a problem with a retained, non-blank statement needs nothing.
          if (stored === null || stored.statement === null || stored.statement.trim().length === 0) {
            restored.push(key);
          }
        }
        if (restored.length > LUOGU_SYNC_MAX_METADATA_BACKLOG) {
          throw new DomainError(
            'invalid_transition',
            'the missing-metadata backlog cannot hold the restored keys; the restore was rolled back',
            {
              reason: 'metadata_backlog_full',
              backlog: restored.length,
              max: LUOGU_SYNC_MAX_METADATA_BACKLOG,
            },
          );
        }
        nextBacklog = restored;
      }
      const sameBacklog =
        nextBacklog.length === current.missingMetadata.length &&
        nextBacklog.every((key, index) => key === current.missingMetadata[index]);
      const changed =
        !sameBacklog || metadataIssues.length !== currentIssues.length || failure !== current.failure;
      if (!changed) {
        // An account that never queued the key keeps its exact row: no write, no revision bump.
        continue;
      }
      const next: LuoguSyncState = {
        ...current,
        missingMetadata: nextBacklog,
        metadataIssues,
        failure,
        updatedAt: this.nowIso(),
      };
      throwIfCancelled(token);
      await this.store.saveLuoguSyncState(next, record.revision);
      throwIfCancelled(token);
    }
  }

  /**
   * Canonical native keys of the given keys that carry a durable disposition.
   *
   * Skip suppresses metadata fetching only; trash additionally hides every stored read. Neither may
   * be enqueued by a later pass, retried or supplemented, so the history commit and the metadata
   * loop consult this before they queue or fetch one of them. The decision is the durable tombstone
   * of the canonical native key, which is shared by every account of this source instance.
   */
  private async suppressedProblemKeys(keys: readonly string[]): Promise<ReadonlySet<string>> {
    const suppressed = new Set<string>();
    for (const key of keys) {
      if ((await this.store.getProblemDisposition(key)) !== null) {
        suppressed.add(key);
      }
    }
    return suppressed;
  }

  /**
   * Retry **exactly one** currently queued metadata key through the ordinary repair path.
   *
   * The operation is item-scoped but source-scoped in its discipline: it takes the same durable
   * source-wide lease as a pass (`claim`), renews it inside the shared gate immediately before the
   * request, refuses a key that left the backlog while the operation waited, and re-checks the lease
   * and the queued membership *inside* the metadata import transaction (a success commits the
   * problem row, its snapshot, the dequeue and the diagnostic in that one transaction; a failure is
   * persisted by its own guarded transaction). It releases the lease in a `finally`. It never reads
   * a history page, never moves or resets a checkpoint or watermark, never drops or reorders another
   * key, and never invokes a model — only `refreshProblemMetadata` runs.
   *
   * The outcome is typed rather than thrown: `resolved` means the key left the backlog and its
   * per-key diagnostic was cleared, `deferred` means the platform refused this one item for this
   * reader (an incomplete personal statement, or an anonymous refusal of a private user-created
   * problem) and the key stays queued with its diagnostic, and `failed` means any other refusal.
   * A refusal of the whole source — a live lease held elsewhere, a lost lease, an account or key that
   * is not queued — is still a typed `LuoguSyncError`, because it is not an outcome of this item.
   */
  async retryMetadata(
    accountId: string,
    problemKeyValue: string,
    token: CancellationToken,
  ): Promise<{
    readonly accountId: string;
    readonly problemKey: string;
    readonly outcome: 'resolved' | 'deferred' | 'failed';
    readonly failureCode: LuoguSyncFailureCode | null;
    readonly reason: PlatformErrorReason | null;
  }> {
    this.assertUsable(token);
    const account = await this.requireAccount(accountId);
    invariant(
      typeof problemKeyValue === 'string' && problemKeyValue.trim().length > 0,
      'invalid_input',
      'problemKey must be a non-empty string',
    );
    const key = problemKeyValue;
    // Exactly one currently queued key: a key that is not in this account's backlog is refused
    // before any lease, gate or platform work.
    const before = await this.store.getLuoguSyncState(account.id);
    // A suppressed key is never retried or supplemented: the durable tombstone outranks the queue
    // this operation read, and the store's CAS is the authority on the current state.
    if ((await this.store.getProblemDisposition(key)) !== null) {
      throw new LuoguSyncError('invalid_input', 'problem ' + key + ' is skipped or trashed by a local disposition', {
        accountId: account.id,
        problemKey: key,
      });
    }
    if (before === null || !before.value.missingMetadata.includes(key)) {
      throw new LuoguSyncError('invalid_input', `problem ${key} is not queued in the metadata backlog`, {
        accountId: account.id,
        problemKey: key,
      });
    }
    return this.runConnectionOp(account.id, token, async (opToken) => {
      await this.claim(account, { purpose: 'repair', mode: 'resume' }, opToken);
      try {
        const problemRef = parseProblemKey(key);
        const report = await this.gate.run(opToken, async () => {
          throwIfCancelled(opToken);
          await this.renewLease(account.id, 'before a metadata retry');
          throwIfCancelled(opToken);
          // The key may have left the backlog while this operation waited for the source floor or for
          // the lease: re-read the durable row and refuse without one platform request.
          await this.requireLiveQueuedMetadataKey(account.id, key, opToken, 'before a metadata retry');
          throwIfCancelled(opToken);
          return this.imports.refreshProblemMetadata(this.metadataSource, {
            problemRef,
            token: opToken,
            limits: this.limits,
            // Runs INSIDE the import transaction, before anything else is read back: a lease taken
            // over or expired during the request — or a cancellation — makes this throw and rolls
            // the problem row and its snapshot back, so a stale claim commits neither. The success
            // mutation opens no transaction of its own (the import owns one) and re-checks the lease
            // and the queued membership again at the write boundary.
            beforeCommit: async () => {
              await this.applyMetadataRetry(account.id, key, { status: 'fetched', error: null }, opToken);
            },
          });
        });
        if (report.status === 'fetched') {
          return { accountId: account.id, problemKey: key, outcome: 'resolved' as const, failureCode: null, reason: null };
        }
        const outcome = await this.commitMetadataRetry(account.id, key, { status: 'failed', error: report.error }, opToken);
        return { accountId: account.id, problemKey: key, ...outcome };
      } finally {
        // The lease is always released, and an unrelated history/metadata failure is preserved by
        // `releaseLease(…, false)`; only a stored failure that explicitly names this key is cleared.
        await this.releaseLease(account.id, false);
      }
    });
  }

  /**
   * Record one **locally supplied** problem body for a currently queued key, with no platform
   * request at all.
   *
   * This is the workbench's manual recovery for a queued problem the platform will not serve (an
   * explicitly incomplete personal statement, a deleted problem, ...): the user pastes the real
   * title and statement, and the row is created from the configured source's own canonical
   * identity — `parseProblemKey` plus this instance's base URL. Nothing here is a platform read:
   * the created problem carries no rating, no raw tag and no editorial source, so the stored
   * material never claims to be platform-verified, and no model is invoked.
   *
   * The operation is item-scoped but source-scoped in its discipline: it takes the same durable
   * source-wide lease as a pass through `runConnectionOp` + `claim` and therefore refuses a live
   * lease held by another owner (on this account or any other account of the instance), yet it
   * needs no stored connection, no cookie and no source-gate wait — a disconnected account can
   * still complete the items it already knows about. The lease is released in a `finally`.
   *
   * Exactly one store transaction commits the problem row, its immutable snapshot, the dequeue of
   * this one key, the clearing of this one key's diagnostic and one `metadataResolved` increment.
   * The `beforeCommit` hook re-checks the lease (with a clock reading taken inside the transaction)
   * and the queued membership immediately before that single write, so a cancellation, an expired
   * lease, a takeover or a stale snapshot rolls everything back and leaves the key queued. Every
   * other backlog key and its diagnostic, the history watermarks, the checkpoint, the submissions
   * and any stored failure that does not explicitly name this key are preserved verbatim.
   */
  async supplementMetadata(
    request: {
      readonly accountId: string;
      readonly problemKey: string;
      /** Real title the user supplied; used only when the problem row does not exist yet. */
      readonly title: string;
      /** Complete statement the user supplied; always written as the problem's statement. */
      readonly statement: string;
      readonly expectedSnapshotId: string | null;
    },
    token: CancellationToken,
  ): Promise<{
    readonly accountId: string;
    readonly problemKey: string;
    readonly snapshot: SnapshotWrite;
    readonly outcome: 'supplemented';
  }> {
    this.assertUsable(token);
    invariant(
      request !== null && typeof request === 'object' && !Array.isArray(request),
      'invalid_input',
      'supplement request must be an object',
    );
    const account = await this.requireAccount(request.accountId);
    invariant(
      typeof request.problemKey === 'string' && request.problemKey.trim().length > 0,
      'invalid_input',
      'problemKey must be a non-empty string',
    );
    const key = request.problemKey;
    // The key itself carries the source instance, so a key of another platform is refused here,
    // before any lease, store write or request.
    const ref = parseProblemKey(key);
    if (ref.sourceInstanceId !== this.sourceInstance.id) {
      throw new LuoguSyncError('account_foreign', `problem ${key} does not belong to this Luogu instance`, {
        problemKey: key,
      });
    }
    invariant(
      typeof request.title === 'string' && request.title.trim().length > 0,
      'invalid_input',
      'a recovered problem requires a non-blank title',
    );
    invariant(
      request.title.length <= MAX_SUPPLEMENT_TITLE_CHARS,
      'invalid_input',
      `a recovered problem title exceeds ${MAX_SUPPLEMENT_TITLE_CHARS} characters`,
      { length: request.title.length },
    );
    invariant(
      typeof request.statement === 'string' && request.statement.trim().length > 0,
      'invalid_input',
      'a recovered problem requires a non-blank statement',
    );
    invariant(
      request.statement.length <= MAX_SUPPLEMENT_STATEMENT_CHARS,
      'invalid_input',
      `a recovered statement exceeds ${MAX_SUPPLEMENT_STATEMENT_CHARS} characters`,
      { length: request.statement.length },
    );
    const expectedSnapshotId = request.expectedSnapshotId;
    invariant(
      expectedSnapshotId === null || (typeof expectedSnapshotId === 'string' && expectedSnapshotId.length > 0),
      'invalid_input',
      'expectedSnapshotId must be a snapshot id or null',
      { problemKey: key },
    );
    // Exactly one currently queued key of this account: a key that is not in its backlog is refused
    // before any lease is taken or any store write is attempted.
    const before = await this.store.getLuoguSyncState(account.id);
    // A suppressed key is never retried or supplemented: the durable tombstone outranks the queue
    // this operation read, and the store's CAS is the authority on the current state.
    if ((await this.store.getProblemDisposition(key)) !== null) {
      throw new LuoguSyncError('invalid_input', 'problem ' + key + ' is skipped or trashed by a local disposition', {
        accountId: account.id,
        problemKey: key,
      });
    }
    if (before === null || !before.value.missingMetadata.includes(key)) {
      throw new LuoguSyncError('invalid_input', `problem ${key} is not queued in the metadata backlog`, {
        accountId: account.id,
        problemKey: key,
      });
    }
    return this.runConnectionOp(account.id, token, async (opToken) => {
      await this.claim(account, { purpose: 'repair', mode: 'resume' }, opToken);
      try {
        const report = await this.imports.supplementLocalProblem({
          problem: {
            ref,
            // Derived from the configured instance, never from a request body.
            url: this.problemUrlOf(ref.externalKey),
            title: request.title,
          },
          statement: request.statement,
          expectedSnapshotId,
          token: opToken,
          // Runs INSIDE the import transaction: the lease, the source identity and the queued
          // membership are re-checked at the write boundary, so a takeover, an expiry or a
          // cancellation rolls the problem and its snapshot back together with the dequeue.
          beforeCommit: () => this.commitSupplementedItem(account.id, key, opToken),
        });
        return {
          accountId: account.id,
          problemKey: key,
          snapshot: report.snapshot,
          outcome: 'supplemented' as const,
        };
      } finally {
        await this.releaseLease(account.id, false);
      }
    });
  }

  /**
   * The commit hook of one manual recovery, run inside the metadata import transaction.
   *
   * The problem row, its snapshot, the dequeue of exactly this key, the clearing of exactly this
   * key's diagnostic and one `metadataResolved` increment commit together or not at all. The clock
   * is read after the state read (inside {@link requireLiveQueuedMetadataKey}), the caller's token
   * is checked on both sides of every awaited operation, and the lease, the source identity and
   * the queued membership are re-checked immediately before the only write. Only a stored failure
   * that explicitly names this key is cleared: a manual recovery is not a retry of the platform
   * read, so a history (or legacy stage-less) failure survives verbatim.
   */
  private async commitSupplementedItem(
    accountId: string,
    problemKeyValue: string,
    token: CancellationToken,
  ): Promise<void> {
    const { record, current, at } = await this.requireLiveQueuedMetadataKey(
      accountId,
      problemKeyValue,
      token,
      'before the manual recovery commit',
    );
    const next: LuoguSyncState = {
      ...current,
      missingMetadata: current.missingMetadata.filter((key) => key !== problemKeyValue),
      metadataIssues: [...clearMetadataIssue(current.metadataIssues, problemKeyValue)],
      metadataResolved: current.metadataResolved + 1,
      failure: clearRetriedItemFailure(current.failure, problemKeyValue),
      leaseExpiresAt: new Date(Date.parse(at) + this.leaseMs).toISOString(),
      updatedAt: at,
    };
    throwIfCancelled(token);
    await this.store.saveLuoguSyncState(next, record.revision);
    throwIfCancelled(token);
  }

  /** Canonical problem URL of this configured instance; a recovery never accepts a caller URL. */
  private problemUrlOf(externalKey: string): string {
    return `${this.sourceInstance.baseUrl.replace(/\/+$/u, '')}/problem/${encodeURIComponent(externalKey)}`;
  }

  /**
   * Stop this account's work, disable only its automation and remove its session.
   *
   * The order is the contract: cancel the pass, drain it (and any in-flight connect/probe of the
   * account), turn the account's own automatic setting off, and only then forget the connection.
   * Another account's automation, session and history are never touched.
   */
  async disconnect(accountId: string, token: CancellationToken): Promise<LuoguSyncStatus> {
    this.assertUsable(token);
    const account = await this.requireAccount(accountId);
    await this.drainPass(account.id);
    const pending = this.connectionOps.get(account.id);
    if (pending !== undefined) {
      // Drain the previous operation whatever its outcome; this call owns the account afterwards.
      await pending.catch(() => undefined);
    }
    return this.runConnectionOp(account.id, token, async (opToken) => {
      const settingsRecord = await this.store.getLuoguSyncSettings(account.id);
      if (settingsRecord !== null && settingsRecord.value.automaticEnabled) {
        await this.store.saveLuoguSyncSettings(
          { ...settingsRecord.value, automaticEnabled: false, updatedAt: this.nowIso() },
          settingsRecord.revision,
        );
      }
      await this.connections.forget(account.id, opToken);
      return this.status(account.id);
    });
  }

  // -------------------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------------------

  /**
   * Reserve and start one bounded synchronization pass.
   *
   * Returns as soon as the durable reservation committed; the pass itself runs in the background
   * and its outcome is observable through {@link status}. `resume` continues an unfinished
   * checkpoint before it considers an incremental window; `full` starts an explicit reconciliation
   * (resetting `historyComplete`, never deleting stored rows).
   *
   * `metadata` reserves the same source-wide slot but repairs the durable backlog only: it reads no
   * history page and leaves every history watermark, the checkpoint and `historyComplete` exactly as
   * stored. It is the mode a user picks to drain a large backlog without running a history scan, and
   * it never invokes a model — the metadata source is an anonymous platform read.
   *
   * ## The source slot is taken synchronously
   *
   * The pass is published to `this.running` **before** its durable reservation is written, so every
   * other caller of this service — a second `start`, a sweep, a queued reconciliation or a
   * connection operation — sees it. A concurrent request for the *same* account and mode is
   * therefore never answered `coalesced` while the store could still refuse the reservation: until
   * the reservation committed the honest answer is `busy` (the documented choice of this build),
   * and once it committed the request coalesces with the launched pass — or queues its full
   * reconciliation behind it. A request for another account, or one that arrives while a connection
   * operation holds the source lease, is refused as `busy` instead of overwriting the live owner. A
   * mode incompatible with the live pass (`metadata` against a history mode, or the reverse) is
   * refused as `busy` for the same reason: a metadata pass owns no history position, so it must
   * never be handed a queued full reconciliation or have one queued behind it.
   */
  async start(
    accountId: string,
    mode: LuoguSyncStartMode,
    token?: CancellationToken,
  ): Promise<LuoguSyncStartResult> {
    this.assertUsable(token ?? null);
    invariant(
      mode === 'resume' || mode === 'full' || mode === 'metadata',
      'invalid_input',
      `unknown synchronization mode ${String(mode)}`,
    );
    // The attempt is tracked synchronously, before its first await: a `close()` that lands while
    // this reservation is still being written waits for the attempt, and the attempt refuses to
    // launch (releasing its own reservation) once the close began.
    return this.trackLaunchAttempt(async (): Promise<LuoguSyncStartResult> => {
      const account = await this.requireAccount(accountId);
      this.assertUsable(token ?? null);
      // No `await` between observing the source slot and taking it: that is what makes a second
      // concurrent caller observe this attempt instead of reserving the same account twice.
      const running = this.running;
      if (running !== null) {
        if (running.accountId === account.id && running.launched) {
          if (running.mode === mode) {
            return { accountId: account.id, mode, outcome: 'coalesced', status: await this.status(account.id) };
          }
          // A metadata pass and a history pass are incompatible: queueing a full reconciliation
          // behind a metadata pass (or the reverse) would run a mode the caller never asked for.
          // The honest answer is `busy`, and nothing is queued.
          if (running.mode === 'metadata' || mode === 'metadata') {
            throw new LuoguSyncError(
              'busy',
              `account ${account.id} is already running the incompatible Luogu mode ${running.mode}`,
              { accountId: running.accountId, leaseOwner: this.ownerId, runningMode: running.mode },
            );
          }
          running.queuedFull = true;
          return { accountId: account.id, mode, outcome: 'queued', status: await this.status(account.id) };
        }
        throw new LuoguSyncError(
          'busy',
          running.accountId === account.id && !running.launched
            ? `account ${account.id} is still reserving the Luogu source`
            : `account ${running.accountId} is already synchronizing the Luogu source`,
          { accountId: running.accountId, leaseOwner: this.ownerId },
        );
      }
      const connectionHolders = [...this.connectionOps.keys()];
      if (connectionHolders.length > 0) {
        throw new LuoguSyncError(
          'busy',
          `a connection operation of ${connectionHolders[0]!} is using the Luogu source right now`,
          { accountId: connectionHolders[0]! },
        );
      }
      const pass = this.beginPass(account.id, mode);
      await this.reservePass(account, mode, pass, token ?? null);
      return { accountId: account.id, mode, outcome: 'started', status: await this.status(account.id) };
    });
  }

  /**
   * Cancel this account's running pass and wait for it to settle.
   *
   * Every page that was already committed stays committed, the checkpoint keeps its continuation
   * and the account simply becomes not-running: automation resumes it at the next durable due
   * instant (one interval after this attempt, or at a persisted retry instant), never in a tight
   * loop and never after `disconnect` disabled its automation.
   */
  async cancel(accountId: string): Promise<LuoguSyncStatus> {
    const account = await this.requireAccount(accountId);
    await this.drainPass(account.id);
    return this.status(account.id);
  }

  /** Wait until no pass of this service is running or queued. */
  async settle(): Promise<void> {
    while (this.running !== null || this.pendingLaunches > 0) {
      const pass = this.running;
      if (pass !== null) {
        await pass.promise;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
      });
    }
  }

  /**
   * Run one startup sweep: accounts with automation enabled **and** `runOnStartup`, connected and
   * due. Due/retry instants are durable, so restarting the host cannot loop a pass.
   */
  async startup(token?: CancellationToken): Promise<LuoguSyncSweepResult> {
    return this.sweep('startup', token ?? null);
  }

  /** Run one interval sweep over every connected, enabled and due account. */
  async tick(token?: CancellationToken): Promise<LuoguSyncSweepResult> {
    return this.sweep('tick', token ?? null);
  }

  /**
   * Mark the service closing, cancel everything in flight and wait for it to settle.
   *
   * Returns only after the running pass, every connection operation and every compensating cleanup
   * finished, so no platform write is still detached when the caller tears the plugin down. Later
   * calls are no-ops; operations requested after the close started are refused with `closing`.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closing = true;
    this.closeSource.cancel('the Luogu synchronization service is closing');
    const pass = this.running;
    if (pass !== null) {
      pass.source.cancel('the Luogu synchronization service is closing');
    }
    await this.settle();
    // Each connection operation's own caller observes its rejection; the close only waits for them.
    await Promise.allSettled([...this.connectionOps.values()]);
    this.closed = true;
    const failure = this.backgroundFailures[0];
    if (failure !== undefined) {
      throw failure;
    }
  }

  // -------------------------------------------------------------------------------------
  // Internals: reservation
  // -------------------------------------------------------------------------------------

  /**
   * Take the durable per-account lease inside one transaction.
   *
   * The whole source instance is scanned — every stored Luogu account and its state — because an
   * account that is connecting right now may not have a connection row yet and would be invisible
   * to a connection-only enumeration. A live foreign lease is refused; an expired one is recovered
   * by simply overwriting it with this reservation. A `metadata` claim reads no checkpoint at all:
   * it takes the owner slot and resets only the pass-scoped page counter, so draining a backlog can
   * never be mistaken for a history scan. For a `sync` claim the checkpoint is read in the same
   * transaction and the pass plan is derived from it:
   *
   * - an unfinished checkpoint is resumed with its own `since` and cursor;
   * - a first backfill starts with no bound at all;
   * - an incremental pass starts at the last **successful scan start** minus the 7-day overlap,
   *   and the bound is frozen in the checkpoint for every partial attempt that follows;
   * - a full reconciliation resets `historyComplete` and restarts from the first page.
   *
   * `token` is re-checked inside the transaction, both before the first read and immediately before
   * the only write: a close (or a caller cancellation) that landed while the caller was waiting must
   * not commit a reservation that no one is allowed to launch.
   */
  private async claim(
    account: Account,
    request: ClaimRequest,
    token: CancellationToken | null = null,
  ): Promise<Claim> {
    const at = this.nowIso();
    const owner = this.ownerId;
    const sourceInstanceId = this.sourceInstance.id;
    const leaseExpiresAt = new Date(Date.parse(at) + this.leaseMs).toISOString();
    return this.store.transaction(async () => {
      this.assertUsable(token);
      const accounts = await this.store.listAccounts(sourceInstanceId);
      let target: LuoguSyncStateRecord | null = null;
      let found = false;
      for (const candidate of accounts) {
        const record = await this.store.getLuoguSyncState(candidate.id);
        if (candidate.id === account.id) {
          target = record;
          found = true;
          continue;
        }
        if (record !== null && luoguLeaseLive(record.value, null, at)) {
          throw new LuoguSyncError(
            'busy',
            `another Luogu account (${candidate.id}) is using the source right now`,
            { accountId: candidate.id, leaseOwner: record.value.owner, leaseExpiresAt: record.value.leaseExpiresAt },
          );
        }
      }
      invariant(found, 'missing_reference', `account ${account.id} is not stored`, { accountId: account.id });
      const state = target === null ? emptyLuoguSyncState(account.id, sourceInstanceId, at) : target.value;
      if (luoguLeaseHeldByAnother(state, owner, at)) {
        throw new LuoguSyncError('busy', `account ${account.id} is already synchronizing elsewhere`, {
          accountId: account.id,
          leaseOwner: state.owner,
          leaseExpiresAt: state.leaseExpiresAt,
        });
      }
      let next: LuoguSyncState;
      let claim: Claim;
      if (request.purpose === 'metadata') {
        // The metadata-only claim takes the same source-wide owner slot but touches only the lease:
        // the phase, history watermarks, completion flag and checkpoint stay exactly as stored.
        next = { ...state, owner, leaseExpiresAt, pagesInPass: 0, updatedAt: at };
        claim = { pageMode: 'continue', since: null, metadataOnly: true };
      } else if (request.purpose !== 'sync') {
        next = { ...state, owner, leaseExpiresAt, updatedAt: at };
        claim = { pageMode: 'continue', since: null, metadataOnly: false };
      } else {
        const checkpoint = await this.store.getSyncCheckpoint(this.checkpointRef(account.id));
        const resuming = checkpoint !== null && checkpoint.cursor !== null;
        const full = request.mode === 'full';
        let phase: LuoguSyncPhase = state.phase;
        let historyComplete = state.historyComplete;
        let scanStartedAt = state.scanStartedAt;
        let since: string | null;
        let pageMode: SyncMode;
        if (full) {
          phase = 'reconcile';
          historyComplete = false;
          scanStartedAt = at;
          since = null;
          pageMode = 'restart';
        } else if (resuming) {
          // The unfinished scan wins over any incremental window: its frozen bound is reused so a
          // multi-day interruption cannot skip the records it had not reached yet.
          since = checkpoint.since;
          scanStartedAt = state.scanStartedAt ?? at;
          pageMode = 'continue';
        } else if (!state.historyComplete) {
          phase = state.phase === 'reconcile' ? 'reconcile' : 'backfill';
          since = null;
          scanStartedAt = at;
          pageMode = 'start';
        } else {
          phase = 'incremental';
          since = incrementalSince(state.lastScanStartedAt);
          scanStartedAt = at;
          pageMode = 'start';
        }
        next = {
          ...state,
          phase,
          historyComplete,
          scanStartedAt,
          owner,
          leaseExpiresAt,
          pagesInPass: 0,
          updatedAt: at,
        };
        claim = { pageMode, since, metadataOnly: false };
      }
      // Last gate before the single write of this transaction: the reservation is never committed
      // after the service began closing or the caller cancelled.
      this.assertUsable(token);
      await this.store.saveLuoguSyncState(next, target === null ? null : target.revision);
      return claim;
    });
  }

  /** Release the lease if it is still ours; never clobber a newer owner's row. */
  private async releaseLease(accountId: string, clearPausingFailure: boolean): Promise<void> {
    const at = this.nowIso();
    try {
      await this.store.transaction(async () => {
        const record = await this.store.getLuoguSyncState(accountId);
        if (record === null || record.value.owner !== this.ownerId) {
          return;
        }
        const failure = record.value.failure;
        await this.store.saveLuoguSyncState(
          {
            ...record.value,
            owner: null,
            leaseExpiresAt: null,
            pagesInPass: 0,
            // A successful reconnect is the explicit user action a paused account waits for.
            failure: clearPausingFailure && failure !== null && failure.paused ? null : failure,
            updatedAt: at,
          },
          record.revision,
        );
      });
    } catch (error) {
      if (isStaleRevision(error)) {
        return;
      }
      throw error;
    }
  }

  /**
   * Persist one validated nickname under a live owned lease, preserving every identity field.
   *
   * The account is re-read **inside** the transaction (the platform call happened before it, so no
   * transaction is ever held across IO): a row that vanished, moved to another source instance or
   * changed its handle is refused instead of being overwritten, and the durable state read in the
   * same transaction must still show this operation's own live lease. The caller's combined token is
   * re-checked on both sides of every awaited read and immediately before and after the write, and
   * the lease clock is read *inside* the transaction after those reads, so a store that waited
   * across a cancellation — or a lease that expired while it waited — rolls the nickname back
   * instead of saving it. Only `displayName` differs from the stored row; `id`, `sourceInstanceId`,
   * `handle` and `profileUrl` are copied verbatim.
   */
  private async storeProfile(account: Account, displayName: string, opToken: CancellationToken): Promise<Account> {
    const owner = this.ownerId;
    return this.store.transaction(async () => {
      throwIfCancelled(opToken);
      const current = await this.store.getAccount(account.id);
      throwIfCancelled(opToken);
      if (current === null) {
        throw new LuoguSyncError('account_missing', `account ${account.id} is not stored`, { accountId: account.id });
      }
      if (current.sourceInstanceId !== this.sourceInstance.id || current.handle !== account.handle) {
        throw new LuoguSyncError('internal', `account ${account.id} no longer matches the requested identity`, {
          accountId: account.id,
        });
      }
      const state = await this.store.getLuoguSyncState(account.id);
      throwIfCancelled(opToken);
      // The clock is read here, after the awaited reads: a lease that expired while the store waited
      // is not accepted on the strength of a reading taken before the transaction began.
      const at = this.nowIso();
      if (state === null || state.value.owner !== owner || !luoguLeaseLive(state.value, owner, at)) {
        throw new DomainError('invalid_transition', 'the profile lease was lost before the nickname update', {
          reason: 'lease_lost',
        });
      }
      const next: Account = { ...current, displayName };
      throwIfCancelled(opToken);
      await this.store.upsertAccounts([next]);
      // A cancellation that landed while the write ran must not commit the nickname: throwing here
      // rolls the transaction back.
      throwIfCancelled(opToken);
      return next;
    });
  }

  // -------------------------------------------------------------------------------------
  // Internals: pass execution
  // -------------------------------------------------------------------------------------

  /**
   * Publish the one source slot as a pass before its durable reservation is written.
   *
   * The pass owns a cancellation source from this instant, so `cancel`, `disconnect` and `close`
   * that land while the reservation is still in flight cancel the *attempt* instead of racing it,
   * and `settle()` observes it through `this.running`. `launched` stays false until `attachPass`
   * attaches the real work, which is how a concurrent caller knows that the store may still refuse
   * this reservation (and must therefore be answered `busy`, not `coalesced`).
   */
  private beginPass(accountId: string, mode: LuoguSyncStartMode): RunningPass {
    const source = createCancellationSource();
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pass: RunningPass = { accountId, mode, source, promise, finish, launched: false, queuedFull: false };
    this.running = pass;
    return pass;
  }

  /**
   * Write the durable reservation of an already-published pass and launch it.
   *
   * On any refusal — the store's own `busy`, a `close()` or a caller cancellation that landed while
   * the transaction ran — the pass is retired and the reservation this attempt committed (if any)
   * is released, so no caller leaves a lease that nothing will own and no `start` is answered with
   * work that will not run. Retiring the pass never depends on that release succeeding: a failed
   * release keeps the durable lease for its own expiry (the next accepted pass recovers it) and is
   * reported by `close()`, while `settle()`/`close()` still observe the retired pass instead of
   * waiting forever on one nothing would ever finish.
   */
  private async reservePass(
    account: Account,
    mode: LuoguSyncStartMode,
    pass: RunningPass,
    token: CancellationToken | null,
  ): Promise<void> {
    let claim: Claim;
    try {
      claim = await this.claim(account, { purpose: mode === 'metadata' ? 'metadata' : 'sync', mode }, token);
    } catch (error) {
      this.finishPass(pass);
      throw error;
    }
    const cancelled = pass.source.token.cancelled
      ? pass.source.token
      : token !== null && token.cancelled
        ? token
        : null;
    if (this.closing || cancelled !== null) {
      // The reservation is durable, so it is released before the pass is retired: no other caller
      // may observe a retired pass while its lease is still being written away. The pass is retired
      // in the `finally` because `close()`/`settle()` wait on exactly this pass's promise — a failed
      // release must never leave it published with nothing left to finish it. The durable lease then
      // stays owned until it expires on its own instead of being faked clear, and the failure is
      // retained for `close()` rather than swallowed.
      try {
        await this.releaseLease(account.id, false);
      } catch (error) {
        this.backgroundFailures.push(error);
      } finally {
        this.finishPass(pass);
      }
      // A close outranks the cancellation it just caused: a caller of a closed service must be able
      // to branch on `closing`, while a caller-driven cancellation keeps its own `cancelled` error.
      if (!this.closing && cancelled !== null) {
        cancelled.throwIfCancelled();
      }
      throw new LuoguSyncError('closing', 'the Luogu synchronization service is closing');
    }
    this.attachPass(account, claim, pass);
  }

  /** Attach the real pass work to the durable reservation and mark the pass launched. */
  private attachPass(account: Account, claim: Claim, pass: RunningPass): void {
    pass.launched = true;
    void this.runPass(account, claim, pass.source.token).then(
      () => {
        this.finishPass(pass);
      },
      (error: unknown) => {
        this.backgroundFailures.push(error);
        this.finishPass(pass);
      },
    );
  }

  /**
   * Retire one pass, queue the full reconciliation a launched pass was asked for and wake waiters.
   *
   * Only a pass that really ran can carry a queued-full request, so a refused reservation never
   * starts a reconciliation the store already refused. The follow-up pass is reserved synchronously
   * in the same tick, so no other caller can slip between a pass and the reconciliation queued
   * behind it.
   */
  private finishPass(pass: RunningPass): void {
    if (this.running === pass) {
      const queueFull = pass.launched && pass.queuedFull && !this.closing;
      this.running = null;
      if (queueFull) {
        void this.resumeQueuedFull(pass.accountId, this.beginPass(pass.accountId, 'full'));
      }
    }
    pass.finish();
    this.wakeIdle();
  }

  private wakeIdle(): void {
    if (this.running === null && this.pendingLaunches === 0) {
      for (const waiter of this.idleWaiters.splice(0)) {
        waiter();
      }
    }
  }

  /** Start the full reconciliation a caller queued while another pass was running. */
  private async resumeQueuedFull(accountId: string, pass: RunningPass): Promise<void> {
    this.pendingLaunches += 1;
    try {
      const account = await this.requireAccount(accountId);
      await this.reservePass(account, 'full', pass, null);
    } catch (error) {
      // `reservePass` retires a refused pass itself; this also covers a failure before it ran at all.
      this.finishPass(pass);
      if (!this.isClosureRefusal(error)) {
        this.backgroundFailures.push(error);
      }
    } finally {
      this.pendingLaunches -= 1;
      this.wakeIdle();
    }
  }

  /** True for the two refusals that mean "the service is going away", not a background failure. */
  private isClosureRefusal(error: unknown): boolean {
    return (
      (error instanceof LuoguSyncError && error.code === 'closing') ||
      (error instanceof DomainError && error.code === 'cancelled')
    );
  }

  /** Cancels one account's pass and waits for it; a queued full request is dropped with it. */
  private async drainPass(accountId: string): Promise<void> {
    const pass = this.running;
    if (pass === null || pass.accountId !== accountId) {
      return;
    }
    pass.queuedFull = false;
    pass.source.cancel('cancelled by the caller');
    await pass.promise;
  }

  /**
   * Track one launch attempt — a `start` reservation or one whole `startup()`/`tick()` sweep — as
   * in-flight work.
   *
   * The counter is raised synchronously, before the attempt's first `await`, so `close()` and
   * `settle()` observe the attempt from the instant it exists: a close that lands while a
   * reservation is still being written waits for it instead of returning while the caller could
   * still launch a pass. The matching `finally` always lowers it, including when the attempt is
   * refused because the close won the race.
   */
  private async trackLaunchAttempt<T>(work: () => Promise<T>): Promise<T> {
    this.pendingLaunches += 1;
    try {
      return await work();
    } finally {
      this.pendingLaunches -= 1;
      this.wakeIdle();
    }
  }

  /**
   * One bounded pass: at most 20 history pages, then metadata repairs bounded by
   * {@link LUOGU_SYNC_METADATA_PER_PASS} — or, for the explicit metadata-only mode, one attempt per
   * backlog key up to {@link LUOGU_SYNC_MAX_METADATA_BACKLOG}.
   *
   * The two halves are described separately. A failure of the authenticated history read (or of the
   * page commit under it) carries `stage: 'history'`; a failure of the anonymous metadata repair —
   * including an exception thrown while that work runs — carries `stage: 'metadata'`. A history
   * failure skips the metadata phase exactly as before, and neither half may clear the other's
   * evidence: history coverage, the backlog and the committed submissions are independent of
   * `failure`. A metadata-only reservation runs the metadata half alone and never touches the
   * history half's durable facts, so it also reports the failure it found at its start: bookkeeping
   * keeps a history failure this pass did not retry, while a previous metadata failure is exactly
   * what a successful drain repaired. A cancellation keeps the failure an earlier item of the same
   * phase already committed.
   */
  private async runPass(account: Account, claim: Claim, token: CancellationToken): Promise<void> {
    let failure: LuoguSyncFailure | null = null;
    // What the pass started with. A metadata-only success must not erase a failure it could not
    // have repaired: a history-stage (or legacy stage-less) failure survives because this pass read
    // no history, while a previous *metadata* failure is exactly what the drain repaired and is
    // cleared by a successful retry.
    let priorFailure: LuoguSyncFailure | null = null;
    let historyThrew = false;
    // A metadata-only claim skips the history half entirely: no page is requested, no checkpoint is
    // read or written, and no history watermark or completion flag moves.
    if (!claim.metadataOnly) {
      try {
        let mode: SyncMode = claim.pageMode;
        let since = claim.since;
        // The platform's configured page size is an upper bound the adapter enforces: a deployment
        // that lowers it (1..50) must be honored, while the 50-row cap of the metadata backlog report
        // is never exceeded.
        const pageSize = Math.min(LUOGU_SYNC_PAGE_SIZE, this.limits.pageSize);
        for (let index = 0; index < LUOGU_SYNC_MAX_PAGES_PER_PASS; index += 1) {
          // Backpressure before the fetch: a page may add up to a full page of new keys, so a pass
          // that cannot record them must not fetch it. The checkpoint continuation is kept.
          if (await this.backlogBlocksPaging(account.id)) {
            break;
          }
          const source = this.submissionsFor(account);
          const report = await this.gate.run(token, () =>
            this.imports.syncPage(source, {
              resource: 'submissions',
              account,
              mode,
              since,
              limit: pageSize,
              limits: this.limits,
              token,
              onPageCommitted: (page) => this.commitPage(account.id, page),
            }),
          );
          mode = 'continue';
          since = report.since;
          if (report.complete) {
            break;
          }
        }
      } catch (error) {
        historyThrew = true;
        failure = await this.describeFailure(account.id, error, 'history');
      }
    }
    // The metadata phase runs exactly when the history phase did not throw — the same rule as
    // before — so a cancelled or refused history pass still performs no metadata work at all.
    let cancelled = false;
    if (!historyThrew) {
      try {
        const repair = await this.repairMetadata(account, token, {
          bound: claim.metadataOnly ? LUOGU_SYNC_MAX_METADATA_BACKLOG : LUOGU_SYNC_METADATA_PER_PASS,
        });
        priorFailure = repair.priorFailure;
        failure = repair.failure;
      } catch (error) {
        // The pages this phase follows are already committed; an exception raised here is a metadata
        // failure and must never be recorded as a history failure, nor clear history coverage.
        failure = await this.describeFailure(account.id, error, 'metadata');
        // A cancellation leaves the failure this phase already committed for an earlier item exactly
        // where it is, instead of erasing the evidence of that item's failed request.
        cancelled = this.isCancellation(error);
      }
    }
    try {
      await this.settleState(account.id, failure, {
        // A pass cut short may not wipe the failure one of its own earlier items already recorded;
        // and a history failure survives a metadata-only success because no history was retried.
        keepPriorFailure: cancelled || (claim.metadataOnly && priorFailure?.stage !== 'metadata'),
        priorFailure,
      });
    } catch (error) {
      // The durable page data and checkpoint are already committed; only the bookkeeping write
      // failed. It is reported by `close()` instead of being swallowed.
      this.backgroundFailures.push(error);
    }
  }

  /** True when fewer than one page's worth of backlog slots remain. */
  private async backlogBlocksPaging(accountId: string): Promise<boolean> {
    const record = await this.store.getLuoguSyncState(accountId);
    const backlog = record === null ? 0 : record.value.missingMetadata.length;
    return LUOGU_SYNC_MAX_METADATA_BACKLOG - backlog < LUOGU_SYNC_PAGE_SIZE;
  }

  /**
   * The `syncPage` commit hook: progress and the missing-metadata backlog in the page transaction.
   *
   * Runs **inside** the page's transaction, performs no IO beyond the store, re-checks that this
   * pass still owns a live lease with a clock reading taken after **every** awaited read of this
   * commit, and refuses a page whose backlog keys would not fit — so a throw rolls the page rows,
   * the checkpoint and this progress back together. The per-key disposition lookups run before the
   * lease judgement for exactly that reason: a lease that expired while one of them was pending
   * must refuse the page instead of being validated against a reading taken before the wait.
   */
  private async commitPage(accountId: string, report: SyncPageReport): Promise<void> {
    const counts = report.counts;
    const keys = counts.kind === 'submissions' ? counts.missingProblemKeys : [];
    if (counts.kind === 'submissions' && counts.missingProblemMetadata > keys.length) {
      throw new DomainError(
        'invalid_transition',
        'the adapter reported more missing problems than it named; refusing a page whose keys could not be recorded',
        { reason: 'metadata_keys_truncated', reported: counts.missingProblemMetadata, named: keys.length },
      );
    }
    // A durable disposition is authoritative for every account of this source: a key the user
    // skipped (metadata fetching suppressed) or trashed (hidden everywhere) is never enqueued by a
    // later history pass, so raw submissions still import as evidence but can never resurrect it.
    const suppressed = await this.suppressedProblemKeys(keys);
    const record = await this.store.getLuoguSyncState(accountId);
    const at = this.nowIso();
    if (record === null || record.value.owner !== this.ownerId || !luoguLeaseLive(record.value, this.ownerId, at)) {
      throw new DomainError('invalid_transition', 'the synchronization lease was lost before the page commit', {
        reason: 'lease_lost',
      });
    }
    const current = record.value;
    const backlog = [...current.missingMetadata];
    for (const key of keys) {
      if (suppressed.has(key) || backlog.includes(key)) {
        continue;
      }
      if (backlog.length >= LUOGU_SYNC_MAX_METADATA_BACKLOG) {
        throw new DomainError(
          'invalid_transition',
          'the missing-metadata backlog is full; refusing a page that would have to drop keys',
          { reason: 'metadata_backlog_full', problemKey: key },
        );
      }
      backlog.push(key);
    }
    const complete = report.complete;
    const scannedFrom = current.scanStartedAt ?? at;
    const next: LuoguSyncState = {
      ...current,
      // Completion is derived only from `nextCursor: null`; a partial page keeps the phase and the
      // unfinished-scan marker so the next pass resumes the same whole scan.
      phase: complete ? 'incremental' : current.phase,
      historyComplete: complete ? true : current.historyComplete,
      historyCompletedAt: complete ? at : current.historyCompletedAt,
      scanStartedAt: complete ? null : scannedFrom,
      lastScanStartedAt: complete ? scannedFrom : current.lastScanStartedAt,
      lastSuccessAt: complete ? at : current.lastSuccessAt,
      pagesInPass: current.pagesInPass + 1,
      totalPages: current.totalPages + 1,
      submissionsSeen: current.submissionsSeen + counts.fetched,
      missingMetadata: backlog,
      owner: this.ownerId,
      leaseExpiresAt: new Date(Date.parse(at) + this.leaseMs).toISOString(),
      updatedAt: at,
    };
    await this.store.saveLuoguSyncState(next, record.revision);
  }

  /**
   * Repair referenced problem metadata, at most `bound` keys per pass.
   *
   * Each key is attempted at most once per pass and a failed key is rotated to the end of the
   * durable backlog, so a permanently failing first key cannot starve the others; a failure never
   * discards the already imported submissions. Editorial material is never requested — only
   * `ImportService.refreshProblemMetadata` is used. A session-level failure or a rate limit stops
   * the phase with a typed, durable failure; transient failures just move on.
   *
   * ## Private user-created problems refuse the item, not the session
   *
   * `auth_required` or `forbidden` for a `U`-prefixed user-created problem is that item being denied
   * to anonymous readers (see {@link isPrivateProblemRefusal}), not an expired session: the key is
   * rotated and counted as failed exactly like any other item, the phase keeps its remaining keys,
   * and the refusal is remembered as a **deferred** metadata failure so the backlog it leaves behind
   * is still reported. A later session-level failure (a non-private refusal, a rate limit or a
   * challenge) overwrites it and stops the phase, while any later success leaves it in place.
   *
   * ## Per-item commitment and the lease
   *
   * The lease is re-taken before every platform request, and progress is persisted per item under a
   * transaction that re-validates it. A **successful** item commits the problem row, its snapshot,
   * the dequeue of that key, the clearing of its diagnostic and its single counter increment inside
   * the metadata import's own transaction (`beforeCommit`), so a lease taken over, an expired lease
   * or a cancellation during the request rolls the metadata back instead of committing it on a stale
   * claim. A **failed** item is persisted by its own lease-guarded transaction. A long metadata-only
   * drain therefore shows a backlog that decreases while it runs, cannot outlive its lease, and stops
   * — without one further request — the moment another owner takes the source over. The
   * re-validation runs *inside* the gate's work callback, immediately before the request: the gate
   * may park this operation for a while, and a lease that expired (or was taken over) during that
   * wait must refuse the request rather than dispatch it on a stale claim.
   *
   * The returned `priorFailure` is the state's failure at entry, which the caller needs to tell a
   * metadata failure this pass can repair from a history failure it never touched. The returned
   * `failure` is the reason this phase stopped when it stopped, otherwise the remembered deferred
   * private-key refusal, otherwise the last transient item failure.
   */
  private async repairMetadata(
    account: Account,
    token: CancellationToken,
    options: { readonly bound: number },
  ): Promise<{ readonly failure: LuoguSyncFailure | null; readonly priorFailure: LuoguSyncFailure | null }> {
    const bound = options.bound;
    const record = await this.store.getLuoguSyncState(account.id);
    if (record === null || record.value.owner !== this.ownerId) {
      return { failure: null, priorFailure: null };
    }
    const priorFailure = record.value.failure;
    const attempted = new Set<string>();
    const backlog = [...record.value.missingMetadata];
    // Every item commits its own exact counter delta: a success inside the import transaction and a
    // failure in its own guarded transaction, so a cumulative counter is never written twice.
    let failed = 0;
    // Per-key diagnostics, carried forward across every item of this phase. A legacy row without the
    // field starts empty — unknown, never an inferred failure — and gains entries only for keys this
    // phase actually observed failing.
    let issues: readonly LuoguMetadataIssue[] = record.value.metadataIssues ?? [];
    // Three distinct facts, kept apart on purpose: the loop must stop only for `stop`, while the
    // durable failure it reports prefers `stop`, then the deferred item refusal, then the transient
    // one. A deferred private-key refusal therefore survives every later success of this phase but
    // is overwritten by a later session-level failure.
    let stop: LuoguSyncFailure | null = null;
    let deferred: LuoguSyncFailure | null = null;
    let transient: LuoguSyncFailure | null = null;
    let fetches = 0;
    while (fetches < bound && backlog.length > 0) {
      const key = backlog[0]!;
      if (attempted.has(key)) {
        // Every remaining key was already tried in this pass; the rest wait for the next one.
        break;
      }
      // A durable disposition is authoritative: a key skipped or trashed (from any account of this
      // source) is never fetched. A stale queue entry, for example a row written by another
      // instance, is dequeued and persisted here instead of being requested.
      throwIfCancelled(token);
      if ((await this.store.getProblemDisposition(key)) !== null) {
        backlog.shift();
        issues = clearMetadataIssue(issues, key);
        const saved = await this.saveMetadataProgress(
          account.id,
          { backlog, issues, resolved: 0, failed: 0, failure: null },
          token,
        );
        if (!saved) {
          throw new LuoguSyncError('lease_lost', 'another owner replaced the metadata pass lease', {
            accountId: account.id,
          });
        }
        continue;
      }
      attempted.add(key);
      fetches += 1;
      throwIfCancelled(token);
      // Parse once: the canonical reference decides both what is requested and whether a refusal is
      // an item-level private-problem refusal instead of a session-level stop.
      const problemRef = parseProblemKey(key);
      // The lease is validated and renewed inside the gate callback, immediately before the request:
      // the gate may park this operation for a long time, and a lease that expired or was taken over
      // during that wait must refuse the request instead of dispatching it on a stale claim.
      const report = await this.gate.run(token, async () => {
        throwIfCancelled(token);
        await this.renewLease(account.id, 'before a metadata request');
        throwIfCancelled(token);
        return this.imports.refreshProblemMetadata(this.metadataSource, {
          problemRef,
          token,
          limits: this.limits,
          // Runs INSIDE the metadata import transaction: the key is dequeued, its diagnostic is
          // cleared and its single counter increment is committed in the same commit as the problem
          // row and its snapshot. A lease taken over or expired during the request — or a
          // cancellation — makes the hook throw and rolls the whole metadata write back instead of
          // committing problem data on a stale claim.
          beforeCommit: () => this.commitMetadataBatchItem(account.id, key, token),
        });
      });
      if (report.status === 'fetched') {
        // The durable success was already committed by the hook above, in the import's own
        // transaction; only this loop's local queue and diagnostics need to follow it.
        backlog.shift();
        issues = clearMetadataIssue(issues, key);
      } else {
        failed += 1;
        // Rotation is the durable fairness cursor: the failed key moves to the end of the backlog.
        backlog.shift();
        backlog.push(key);
        const at = this.nowIso();
        const code: LuoguSyncFailureCode = report.error === null ? 'internal' : failureCodeOf(report.error.code);
        const reason = report.error === null ? null : (report.error.reason ?? null);
        // The durable diagnostic of this key: the closed code plus the closed, body-free reason and a
        // bounded attempt count. No parser message, body sample or exception text is representable.
        issues = upsertMetadataIssue(issues, {
          problemKey: key,
          code,
          reason,
          at,
          attempts: this.nextIssueAttempts(issues, key),
        });
        const itemFailure = this.buildFailure(
          code,
          at,
          report.error === null ? null : report.error.retryAfterMs,
          stop ?? deferred ?? transient,
          'metadata',
          { problemKey: key, reason },
        );
        // An item-scoped refusal — an anonymous refusal of a private user-created problem, or an
        // explicitly incomplete statement — is deferrable: the key keeps its queued place and its
        // diagnostic and the phase continues with the other keys. A challenge, an HTML answer, a
        // rate limit or any other unreadable payload still stops the source, so a blank personal
        // statement can no longer halt the whole queue.
        if (this.isDeferrableItemFailure(problemRef, code, reason)) deferred = itemFailure;
        else if (itemFailure.paused || code === 'rate_limited') stop = itemFailure;
        else transient = itemFailure;
        // The failed attempt is persisted by its own lease-guarded transaction: a takeover or a
        // cancellation that landed during the request writes nothing, and the caller stops the phase
        // instead of reporting a backlog this pass no longer owns.
        const failure = stop ?? deferred ?? transient;
        const saved = await this.saveMetadataProgress(account.id, {
          backlog,
          issues,
          resolved: 0,
          failed,
          failure,
        }, token);
        failed = 0;
        if (!saved) {
          // The durable row belongs to another owner now: stop immediately, leave their row intact and
          // let the keys still queued here be handled by whoever owns the source next.
          throw new LuoguSyncError('lease_lost', 'another owner replaced the metadata pass lease', {
            accountId: account.id,
          });
        }
        if (stop !== null) break;
      }
    }
    return { failure: stop ?? deferred ?? transient, priorFailure };
  }

  /**
   * Re-take this pass's durable lease before one metadata request.
   *
   * The transaction only reads the state row and pushes the deadline forward; a missing row, a
   * foreign owner or an already expired lease is a lost lease (`lease_lost`), never a silent renewal
   * on behalf of someone else. No platform call and no wait happens inside the transaction.
   */
  private async renewLease(accountId: string, phase: string): Promise<void> {
    const at = this.nowIso();
    await this.store.transaction(async () => {
      const record = await this.store.getLuoguSyncState(accountId);
      if (
        record === null ||
        record.value.owner !== this.ownerId ||
        !luoguLeaseLive(record.value, this.ownerId, at)
      ) {
        throw new DomainError('invalid_transition', `the synchronization lease was lost ${phase}`, {
          reason: 'lease_lost',
        });
      }
      await this.store.saveLuoguSyncState(
        {
          ...record.value,
          leaseExpiresAt: new Date(Date.parse(at) + this.leaseMs).toISOString(),
          updatedAt: at,
        },
        record.revision,
      );
    });
  }

  /**
   * The commit hook of one successful ordinary repair item, run inside the metadata import
   * transaction.
   *
   * The problem row, its snapshot, the dequeue of exactly this key, the clearing of exactly this
   * key's diagnostic and one `metadataResolved` increment commit together or not at all. The clock
   * is read after the state read, the caller's token is checked on both sides of every awaited
   * operation, and the lease, the source identity and the queued membership are re-checked
   * immediately before the write: a takeover, an expired lease, a cancellation or a concurrently
   * dequeued key refuses the write, which rolls the metadata back with it. Every other backlog key,
   * diagnostic, counter, history field and the stored failure are carried over unchanged.
   */
  private async commitMetadataBatchItem(
    accountId: string,
    problemKeyValue: string,
    token: CancellationToken,
  ): Promise<void> {
    const { record, current, at } = await this.requireLiveQueuedMetadataKey(
      accountId,
      problemKeyValue,
      token,
      'before the metadata commit',
    );
    const next: LuoguSyncState = {
      ...current,
      missingMetadata: current.missingMetadata.filter((key) => key !== problemKeyValue),
      metadataIssues: [...clearMetadataIssue(current.metadataIssues, problemKeyValue)],
      metadataResolved: current.metadataResolved + 1,
      leaseExpiresAt: new Date(Date.parse(at) + this.leaseMs).toISOString(),
      updatedAt: at,
    };
    throwIfCancelled(token);
    await this.store.saveLuoguSyncState(next, record.revision);
    throwIfCancelled(token);
  }

  /**
   * Re-read the durable state and require one live lease of this source with the key still queued.
   *
   * Used both immediately before a retry request and again at the write boundary, inside whatever
   * transaction the caller already owns. The disposition read runs first and the clock is read
   * **after** every awaited read of this check, so a store that queued this call behind another
   * operation cannot validate a lease against a reading taken before the wait — nor can the
   * disposition lookup extend the returned `at` past the lease judgement. The account, the source
   * identity, the owner, the lease deadline and the
   * queued membership are all re-derived from the row just read; an expired or replaced lease, a
   * state that moved to another source, or a key that left the backlog is a `lease_lost` refusal.
   */
  private async requireLiveQueuedMetadataKey(
    accountId: string,
    problemKeyValue: string,
    token: CancellationToken,
    phase: string,
  ): Promise<{ readonly record: LuoguSyncStateRecord; readonly current: LuoguSyncState; readonly at: string }> {
    throwIfCancelled(token);
    // A durable disposition outranks this pass's earlier queue read: a key skipped or trashed while
    // a request was in flight must never commit visible metadata on a stale claim. This awaited read
    // runs BEFORE the clock is read and the lease is judged, so the `at` returned to the caller was
    // taken after every awaited read of this check and cannot outlive the lease judgement.
    if ((await this.store.getProblemDisposition(problemKeyValue)) !== null) {
      throw new LuoguSyncError(
        'lease_lost',
        'problem ' + problemKeyValue + ' is suppressed by a local disposition ' + phase,
        { accountId, problemKey: problemKeyValue },
      );
    }
    throwIfCancelled(token);
    const record = await this.store.getLuoguSyncState(accountId);
    throwIfCancelled(token);
    const current = record === null ? null : record.value;
    const at = this.nowIso();
    if (
      record === null ||
      current === null ||
      current.accountId !== accountId ||
      current.sourceInstanceId !== this.sourceInstance.id ||
      current.owner !== this.ownerId ||
      !luoguLeaseLive(current, this.ownerId, at)
    ) {
      throw new LuoguSyncError('lease_lost', `another owner replaced the metadata lease ${phase}`, {
        accountId,
        problemKey: problemKeyValue,
      });
    }
    if (!current.missingMetadata.includes(problemKeyValue)) {
      throw new LuoguSyncError('lease_lost', `problem ${problemKeyValue} is no longer queued ${phase}`, {
        accountId,
        problemKey: problemKeyValue,
      });
    }
    return { record, current, at };
  }

  /**
   * Persist the outcome of exactly one item-scoped metadata attempt in its own transaction.
   *
   * This is the **outer** wrapper for the failure path of {@link retryMetadata}: it opens exactly
   * one transaction and delegates the mutation to {@link applyMetadataRetry}. The success path must
   * never come through here — it runs inside the metadata import's transaction, where a nested
   * `store.transaction` would be rejected, and calls the mutation helper directly.
   */
  private async commitMetadataRetry(
    accountId: string,
    problemKeyValue: string,
    outcome: { readonly status: 'fetched' | 'failed'; readonly error: PlatformError | null },
    token: CancellationToken,
  ): Promise<{
    readonly outcome: 'resolved' | 'deferred' | 'failed';
    readonly failureCode: LuoguSyncFailureCode | null;
    readonly reason: PlatformErrorReason | null;
  }> {
    return this.store.transaction(() => this.applyMetadataRetry(accountId, problemKeyValue, outcome, token));
  }

  /**
   * Mutate the durable state of exactly one item-scoped retry attempt.
   *
   * The caller already owns the transaction: this method performs only store reads and writes on
   * that transaction (a nested {@link TrainingStore.transaction} is rejected by the adapter), which
   * is what lets the success path commit the problem row, its snapshot, the dequeue of this one key
   * and the clearing of this one diagnostic together or not at all.
   *
   * The lease, the source identity and the queued membership of the key are re-checked at the write
   * boundary, immediately before the only write; the caller's token is checked on both sides of
   * every awaited operation. A cancellation or a lease that was taken over or expired while the
   * request ran therefore commits neither the metadata nor this state update.
   *
   * Only the addressed key is touched: `missingMetadata` keeps its order, every other per-key
   * diagnostic survives, and every history field, counter and checkpoint is carried over unchanged.
   * A success clears a stored failure only when that failure is this build's **metadata** failure
   * naming exactly this key; a history, a legacy stage-less failure or a failure naming another key
   * is evidence of work the retry did not do and survives verbatim. A failure records the new
   * item-scoped diagnostic without erasing such a preexisting failure either.
   */
  private async applyMetadataRetry(
    accountId: string,
    problemKeyValue: string,
    outcome: { readonly status: 'fetched' | 'failed'; readonly error: PlatformError | null },
    token: CancellationToken,
  ): Promise<{
    readonly outcome: 'resolved' | 'deferred' | 'failed';
    readonly failureCode: LuoguSyncFailureCode | null;
    readonly reason: PlatformErrorReason | null;
  }> {
    const { record, current, at } = await this.requireLiveQueuedMetadataKey(
      accountId,
      problemKeyValue,
      token,
      'before the retry commit',
    );
    const fetched = outcome.status === 'fetched';
    const error = outcome.error;
    const code: LuoguSyncFailureCode = error === null ? 'internal' : failureCodeOf(error.code);
    const reason = error === null ? null : (error.reason ?? null);
    const ref = parseProblemKey(problemKeyValue);
    const itemOutcome: 'resolved' | 'deferred' | 'failed' = fetched
      ? 'resolved'
      : this.isDeferrableItemFailure(ref, code, reason)
        ? 'deferred'
        : 'failed';
    const missingMetadata = fetched
      ? current.missingMetadata.filter((key) => key !== problemKeyValue)
      : [...current.missingMetadata];
    const metadataIssues = fetched
      ? clearMetadataIssue(current.metadataIssues, problemKeyValue)
      : upsertMetadataIssue(current.metadataIssues, {
          problemKey: problemKeyValue,
          code,
          reason,
          at,
          attempts: this.nextIssueAttempts(current.metadataIssues, problemKeyValue),
        });
    const failure = fetched
      ? clearRetriedItemFailure(current.failure, problemKeyValue)
      : retryFailure(current.failure, this.buildFailure(code, at, error === null ? null : error.retryAfterMs, current.failure, 'metadata', {
          problemKey: problemKeyValue,
          reason,
        }));
    throwIfCancelled(token);
    await this.store.saveLuoguSyncState(
      {
        ...current,
        missingMetadata,
        metadataIssues: [...metadataIssues],
        metadataResolved: current.metadataResolved + (fetched ? 1 : 0),
        metadataFailed: current.metadataFailed + (fetched ? 0 : 1),
        failure,
        leaseExpiresAt: new Date(Date.parse(at) + this.leaseMs).toISOString(),
        updatedAt: at,
      },
      record.revision,
    );
    // A cancellation that landed while the write ran must not commit it: throwing here rolls the
    // caller's transaction back, exactly like a lost lease.
    throwIfCancelled(token);
    return {
      outcome: itemOutcome,
      failureCode: fetched ? null : code,
      reason: fetched ? null : reason,
    };
  }

  /**
   * True when a metadata refusal addresses **this item** instead of the whole source.
   *
   * Two refusals are item-scoped and therefore deferrable: an anonymous refusal of a private
   * user-created problem ({@link isPrivateProblemRefusal}) and an explicitly diagnosed incomplete
   * statement (`missing_statement`), which the official manual allows for personal problems and
   * which no retry of the same request can repair. Every other refusal — a challenge, an HTML page,
   * malformed JSON, a rate limit — belongs to the source and keeps its pause/backoff behavior.
   */
  private isDeferrableItemFailure(
    problemRef: ProblemRef,
    code: LuoguSyncFailureCode,
    reason: PlatformErrorReason | null,
  ): boolean {
    // `missing_statement` is only meaningful as the reason of a `changed_response` payload refusal:
    // that is the exact pair the metadata reader records for a valid personal problem whose
    // description is empty. A nonsense pairing — an auth, forbidden or rate-limit answer that
    // happens to carry the reason — must not reclassify a source-level refusal as a deferred item.
    return (reason === 'missing_statement' && code === 'changed_response') || isPrivateProblemRefusal(problemRef, code);
  }

  /**
   * The next bounded attempt count of one key's durable diagnostic.
   *
   * The declared ceiling saturates instead of throwing: once a key has failed
   * {@link LUOGU_METADATA_MAX_ISSUE_ATTEMPTS} times, later failures keep the ceiling so the state
   * this build writes stays valid, rather than making the validator refuse the whole save.
   */
  private nextIssueAttempts(issues: readonly LuoguMetadataIssue[] | undefined, problemKeyValue: string): number {
    const previous = metadataIssueFor(issues, problemKeyValue)?.attempts ?? 0;
    return Math.min(LUOGU_METADATA_MAX_ISSUE_ATTEMPTS, previous + 1);
  }

  /**
   * Persist backlog/rotation/counters under the pass's renewed lease.
   *
   * Returns `true` when the write committed, `false` when the durable row is owned by someone else
   * (or changed under this pass). A long loop must stop on `false`: its remaining keys are stale,
   * the newer owner's row must not be clobbered, and the problem rows of the answers already fetched
   * are stored idempotently by the import service.
   */
  private async saveMetadataProgress(
    accountId: string,
    progress: {
      readonly backlog: readonly string[];
      /** Per-key diagnostics carried by this update; one entry per known issue, never raw text. */
      readonly issues: readonly LuoguMetadataIssue[];
      readonly resolved: number;
      readonly failed: number;
      readonly failure: LuoguSyncFailure | null;
    },
    token: CancellationToken,
  ): Promise<boolean> {
    try {
      return await this.store.transaction(async () => {
        throwIfCancelled(token);
        const record = await this.store.getLuoguSyncState(accountId);
        throwIfCancelled(token);
        const at = this.nowIso();
        if (
          record === null ||
          record.value.owner !== this.ownerId ||
          !luoguLeaseLive(record.value, this.ownerId, at)
        ) {
          return false;
        }
        await this.store.saveLuoguSyncState(
          {
            ...record.value,
            missingMetadata: progress.backlog,
            metadataIssues: progress.issues,
            metadataResolved: record.value.metadataResolved + progress.resolved,
            metadataFailed: record.value.metadataFailed + progress.failed,
            failure: progress.failure ?? record.value.failure,
            leaseExpiresAt: new Date(Date.parse(at) + this.leaseMs).toISOString(),
            updatedAt: at,
          },
          record.revision,
        );
        throwIfCancelled(token);
        return true;
      });
    } catch (error) {
      if (isStaleRevision(error)) {
        // A newer owner replaced the row while the metadata answers were being fetched. The fetched
        // problem rows are already stored (idempotent); the backlog update is dropped rather than
        // clobbering that owner, and the keys stay in the backlog for a later attempt.
        return false;
      }
      throw error;
    }
  }

  /**
   * Clear the lease and record the pass outcome; a newer owner's row is never overwritten.
   *
   * A pass that produced no failure of its own settles `failure: null`, which is the documented rule
   * for an ordinary, successful history+metadata pass: it retried both halves, so a previous failure
   * is genuinely repaired. `keepPriorFailure` is the explicit exception, used by the two cases where
   * `null` would report a success the pass did not achieve: a metadata-only run never reads history
   * (so a stored history-stage or legacy stage-less failure is untouched evidence) and a pass cut
   * short by a cancellation or a close must keep the failure one of its own earlier items already
   * committed. `priorFailure` is the failure read at the start of the metadata phase; when the phase
   * threw before returning it, the durable row is the honest fallback, because the per-item writes
   * may already hold a newer failure committed by this same pass.
   */
  private async settleState(
    accountId: string,
    failure: LuoguSyncFailure | null,
    options: { readonly keepPriorFailure: boolean; readonly priorFailure: LuoguSyncFailure | null },
  ): Promise<void> {
    const at = this.nowIso();
    try {
      await this.store.transaction(async () => {
        const record = await this.store.getLuoguSyncState(accountId);
        if (record === null || record.value.owner !== this.ownerId) {
          return;
        }
        const kept = options.priorFailure ?? record.value.failure;
        const recorded = failure ?? (options.keepPriorFailure ? kept : null);
        await this.store.saveLuoguSyncState(
          { ...record.value, owner: null, leaseExpiresAt: null, pagesInPass: 0, failure: recorded, updatedAt: at },
          record.revision,
        );
      });
    } catch (error) {
      if (isStaleRevision(error)) {
        return;
      }
      throw error;
    }
  }

  /**
   * True for the refusals that mean "this pass was stopped", not "this pass failed": a caller or
   * service cancellation — including the platform-code form the metadata reader re-wraps it in — and
   * a close. Each must keep the durable failure an earlier item of the same phase already committed
   * instead of letting the pass settle as a fresh success.
   */
  private isCancellation(error: unknown): boolean {
    return (
      (error instanceof DomainError && error.code === 'cancelled') ||
      (error instanceof LuoguSyncError && error.code === 'closing') ||
      (isPlatformError(error) && error.code === 'cancelled')
    );
  }

  /**
   * Build one durable failure, honoring Retry-After and growing the exponential backoff.
   *
   * `stage` names the half of the pass that produced it and is always recorded for a new failure;
   * only records written before the field existed lack it.
   */
  private buildFailure(
    code: LuoguSyncFailureCode,
    at: string,
    retryAfterMs: number | null,
    previous: LuoguSyncFailure | null,
    stage: LuoguSyncFailureStage,
    item?: { readonly problemKey: string; readonly reason: PlatformErrorReason | null },
  ): LuoguSyncFailure {
    const named =
      item === undefined
        ? {}
        : { problemKey: item.problemKey, ...(item.reason === null ? {} : { reason: item.reason }) };
    if (luoguSyncFailurePauses(code)) {
      return { code, at, retryAt: null, paused: true, stage, ...named };
    }
    const delay =
      retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.round(retryAfterMs)
        : exponentialBackoff(previous);
    return { code, at, retryAt: new Date(Date.parse(at) + delay).toISOString(), paused: false, stage, ...named };
  }

  /**
   * Map any pass failure onto the durable vocabulary; cancellation is not a failure.
   *
   * `stage` is passed through to {@link buildFailure} so the persisted record says which half of the
   * pass raised it instead of leaving the caller to guess from a code two halves share.
   */
  private async describeFailure(
    accountId: string,
    error: unknown,
    stage: LuoguSyncFailureStage,
  ): Promise<LuoguSyncFailure | null> {
    const at = this.nowIso();
    let code: LuoguSyncFailureCode = 'internal';
    let retryAfterMs: number | null = null;
    if (error instanceof DomainError && error.code === 'cancelled') {
      return null;
    }
    if (isPlatformError(error) && error.code === 'cancelled') {
      // The metadata reader re-wraps a domain cancellation as this platform code; it is the same
      // "the caller stopped this pass" signal, never a recorded failure of the platform read.
      return null;
    }
    if (isPlatformError(error)) {
      code = failureCodeOf(error.code);
      retryAfterMs = error.retryAfterMs;
    } else if (error instanceof LuoguConnectionError) {
      code = error.code === 'unsupported' ? 'unsupported' : error.code === 'cleanup_failed' ? 'cleanup_failed' : 'not_connected';
    } else if (error instanceof LuoguSyncError) {
      if (error.code === 'closing') {
        return null;
      }
      if (error.code === 'lease_lost' || error.code === 'busy' || error.code === 'stale_revision') {
        code = 'lease_lost';
      } else if (error.code === 'unsupported') {
        code = 'unsupported';
      } else if (error.code === 'cleanup_failed') {
        code = 'cleanup_failed';
      } else if (error.code === 'invalid_input') {
        code = 'invalid_input';
      } else if (error.code === 'not_connected' || error.code === 'account_missing' || error.code === 'account_foreign') {
        code = 'not_connected';
      }
    } else if (error instanceof DomainError) {
      const reason = error.details['reason'];
      // A deterministic refusal (for example a malformed sync request) is recorded as
      // `invalid_input`, which pauses automatic attempts instead of retrying the same refusal
      // forever. A lost lease keeps its own code; anything else stays `internal`.
      code = reason === 'lease_lost' ? 'lease_lost' : error.code === 'invalid_input' ? 'invalid_input' : 'internal';
    }
    const record = await this.store.getLuoguSyncState(accountId);
    return this.buildFailure(code, at, retryAfterMs, record?.value.failure ?? null, stage);
  }

  // -------------------------------------------------------------------------------------
  // Internals: sweeps, serialization, helpers
  // -------------------------------------------------------------------------------------

  /**
   * One automatic sweep; the durable lease makes later accounts of the sweep busy.
   *
   * The whole sweep is one tracked launch attempt: a close that lands while the store is being read
   * waits for the sweep, and the sweep stops at the next account boundary — releasing any
   * reservation it just committed — instead of launching work after the close. Accounts an
   * interrupted sweep never examined are simply absent from the result; no reason is fabricated for
   * them. A sweep that is already closing, or whose caller token is already cancelled, still refuses
   * up front through {@link assertUsable}.
   */
  private async sweep(kind: 'startup' | 'tick', token: CancellationToken | null): Promise<LuoguSyncSweepResult> {
    this.assertUsable(token);
    return this.trackLaunchAttempt(async (): Promise<LuoguSyncSweepResult> => {
      const at = this.nowIso();
      const accounts = [...(await this.store.listAccounts(this.sourceInstance.id))].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
      const started: string[] = [];
      const skipped: LuoguSyncSkip[] = [];
      for (const account of accounts) {
        if (this.closing || (token !== null && token.cancelled)) {
          break;
        }
        const settings = (await this.store.getLuoguSyncSettings(account.id))?.value ?? null;
        if (settings === null || !settings.automaticEnabled) {
          skipped.push({ accountId: account.id, reason: 'automation_disabled' });
          continue;
        }
        if (kind === 'startup' && !settings.runOnStartup) {
          skipped.push({ accountId: account.id, reason: 'startup_disabled' });
          continue;
        }
        const connection = await this.store.getLuoguConnection(account.id);
        if (!connectionIsUsable(connection?.value ?? null)) {
          skipped.push({ accountId: account.id, reason: 'not_connected' });
          continue;
        }
        const state = (await this.store.getLuoguSyncState(account.id))?.value ?? null;
        if (state !== null && state.failure !== null && state.failure.paused) {
          skipped.push({ accountId: account.id, reason: 'paused' });
          continue;
        }
        const due = state === null ? null : nextRunAt(state, settings);
        if (due !== null && Date.parse(due) > Date.parse(at)) {
          skipped.push({ accountId: account.id, reason: 'not_due' });
          continue;
        }
        const holder = this.running;
        if (holder !== null || this.connectionOps.size > 0) {
          // The source instance allows one pass at a time; this account was eligible but the sweep
          // already started (or found) another pass, or a connection operation holds the lease.
          skipped.push({
            accountId: account.id,
            reason: holder !== null && holder.accountId === account.id ? 'already_running' : 'busy',
          });
          continue;
        }
        // Published before the reservation is written, exactly like `start`: a concurrent manual
        // start or a second sweep observes this attempt instead of reserving the account again.
        const pass = this.beginPass(account.id, 'resume');
        try {
          await this.reservePass(account, 'resume', pass, token);
          started.push(account.id);
        } catch (error) {
          if (error instanceof LuoguSyncError && error.code === 'busy') {
            skipped.push({ accountId: account.id, reason: 'busy' });
            continue;
          }
          // The close interrupted this sweep: report the partial result instead of an internal
          // failure, and let `close()` observe the tracked attempt settling.
          if (error instanceof LuoguSyncError && error.code === 'closing') {
            break;
          }
          if (error instanceof DomainError && error.code === 'cancelled') {
            break;
          }
          throw error;
        }
      }
      return { started, skipped };
    });
  }

  /**
   * Run one connection operation, cancelled by `close()` and never overlapped with another source
   * operation.
   *
   * The entry is published to {@link connectionOps} synchronously, before the operation's first
   * `await`, so it is the second half of the service's one-source-slot rule: a synchronization pass
   * (or the reservation being written for it) refuses while any connection operation holds the
   * lease, and a connection operation refuses while a pass holds it. Refusing is the honest answer
   * here, because the durable lease belongs to this same service: a second claim would pass the
   * store's foreign-owner check yet let two operations release each other's lease.
   */
  private async runConnectionOp<T>(
    accountId: string,
    callerToken: CancellationToken,
    work: (token: CancellationToken) => Promise<T>,
  ): Promise<T> {
    this.assertUsable(callerToken);
    if (this.connectionOps.has(accountId)) {
      throw new LuoguSyncError('busy', `another connection operation of ${accountId} is still running`, {
        accountId,
      });
    }
    const holder = this.running;
    if (holder !== null || this.connectionOps.size > 0) {
      const busyWith = holder !== null ? holder.accountId : [...this.connectionOps.keys()][0]!;
      throw new LuoguSyncError('busy', `account ${busyWith} is using the Luogu source right now`, {
        accountId: busyWith,
      });
    }
    const token = combineTokens(callerToken, this.closeSource.token);
    const run = work(token);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.connectionOps.set(accountId, settled);
    try {
      return await run;
    } finally {
      if (this.connectionOps.get(accountId) === settled) {
        this.connectionOps.delete(accountId);
      }
    }
  }

  private checkpointRef(accountId: string): {
    readonly sourceInstanceId: string;
    readonly accountId: string;
    readonly resource: 'submissions';
  } {
    return { sourceInstanceId: this.sourceInstance.id, accountId, resource: 'submissions' };
  }

  private async requireAccount(accountId: string): Promise<Account> {
    invariant(
      typeof accountId === 'string' && accountId.trim().length > 0,
      'invalid_input',
      'accountId must be a non-empty string',
    );
    const account = await this.store.getAccount(accountId);
    if (account === null) {
      throw new LuoguSyncError('account_missing', `account ${accountId} is not stored`, { accountId });
    }
    if (account.sourceInstanceId !== this.sourceInstance.id) {
      throw new LuoguSyncError(
        'account_foreign',
        `account ${accountId} belongs to ${account.sourceInstanceId}, not this Luogu instance`,
        { accountId },
      );
    }
    return account;
  }

  private assertUsable(token: CancellationToken | null): void {
    if (this.closing) {
      throw new LuoguSyncError('closing', 'the Luogu synchronization service is closing');
    }
    if (token !== null) {
      throwIfCancelled(token);
    }
  }

  private nowIso(): string {
    return assertIsoTimestamp('now', this.now());
  }
}

/** Merge one closed settings patch over the current settings and validate the result. */
function applySettingsPatch(base: LuoguSyncSettings, patch: LuoguSyncSettingsPatch, at: string): LuoguSyncSettings {
  invariant(
    patch !== null && typeof patch === 'object' && !Array.isArray(patch),
    'invalid_input',
    'settings patch must be an object',
  );
  const unknown = Object.keys(patch).filter((field) => !SETTINGS_PATCH_KEYS.has(field));
  invariant(
    unknown.length === 0,
    'invalid_input',
    `settings patch carries unknown field(s): ${unknown.join(', ')}`,
    { fields: unknown },
  );
  return validateLuoguSyncSettings({
    accountId: base.accountId,
    automaticEnabled: patch.automaticEnabled ?? base.automaticEnabled,
    runOnStartup: patch.runOnStartup ?? base.runOnStartup,
    intervalMinutes: patch.intervalMinutes ?? base.intervalMinutes,
    updatedAt: at,
  });
}
