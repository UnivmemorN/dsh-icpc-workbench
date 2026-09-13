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
 * metadata rows.
 * Completion is only ever derived from the adapter's `nextCursor: null`. `phase`/`historyComplete`
 * are independent of failures, a manual full reconciliation resets `historyComplete` without
 * deleting stored rows, and the whole-scan start instant is preserved across resumed passes so a
 * multi-day interruption cannot skip records. Failures are recorded as one of the fixed
 * {@link LuoguSyncFailureCode} values with a durable retry instant (or a pause that waits for the
 * user) — never as a raw provider message, and never as a silent success.
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
  invariant,
  parseProblemKey,
  throwIfCancelled,
  type Account,
  type CancellationToken,
  type SourceInstance,
} from '../domain/index.js';
import type { ImportService } from './import-service.js';
import type { SyncMode, SyncPageReport, SyncPageSource } from './import-types.js';
import { LuoguConnectionError, type LuoguConnectionManager } from './luogu-connection.js';
import { isPlatformError, type PlatformErrorCode } from './platform-errors.js';
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
  connectionIsUsable,
  defaultLuoguSyncSettings,
  emptyLuoguSyncState,
  luoguLeaseHeldByAnother,
  luoguLeaseLive,
  luoguSyncFailurePauses,
  validateLuoguSyncSettings,
  type LuoguConnectionState,
  type LuoguSyncFailure,
  type LuoguSyncFailureCode,
  type LuoguSyncPhase,
  type LuoguSyncSettings,
  type LuoguSyncState,
  type LuoguSyncStateRecord,
  type LuoguSyncStore,
} from './luogu-sync-types.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformAdapter, type PlatformLimits, type TrainingStore } from './ports.js';

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

/** How a start request relates to the durable scan position. */
export type LuoguSyncStartMode = 'resume' | 'full';

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
}

interface ClaimRequest {
  readonly purpose: 'sync' | 'connect' | 'probe';
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

/** True for the store's stale-revision refusal, the one expected compare-and-set loss. */
function isStaleRevision(error: unknown): boolean {
  return (
    error instanceof DomainError &&
    (error.code === 'invalid_transition' || error.code === 'duplicate_id') &&
    error.details['reason'] === 'stale_revision'
  );
}

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
   * ## The source slot is taken synchronously
   *
   * The pass is published to `this.running` **before** its durable reservation is written, so every
   * other caller of this service — a second `start`, a sweep, a queued reconciliation or a
   * connection operation — sees it. A concurrent request for the *same* account and mode is
   * therefore never answered `coalesced` while the store could still refuse the reservation: until
   * the reservation committed the honest answer is `busy` (the documented choice of this build),
   * and once it committed the request coalesces with the launched pass — or queues its full
   * reconciliation behind it. A request for another account, or one that arrives while a connection
   * operation holds the source lease, is refused as `busy` instead of overwriting the live owner.
   */
  async start(
    accountId: string,
    mode: LuoguSyncStartMode,
    token?: CancellationToken,
  ): Promise<LuoguSyncStartResult> {
    this.assertUsable(token ?? null);
    invariant(mode === 'resume' || mode === 'full', 'invalid_input', `unknown synchronization mode ${String(mode)}`);
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
   * by simply overwriting it with this reservation. For a `sync` claim the checkpoint is read in
   * the same transaction and the pass plan is derived from it:
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
      if (request.purpose !== 'sync') {
        next = { ...state, owner, leaseExpiresAt, updatedAt: at };
        claim = { pageMode: 'continue', since: null };
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
        claim = { pageMode, since };
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
      claim = await this.claim(account, { purpose: 'sync', mode }, token);
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

  /** One bounded pass: at most 20 history pages, then at most 10 metadata repairs. */
  private async runPass(account: Account, claim: Claim, token: CancellationToken): Promise<void> {
    let failure: LuoguSyncFailure | null = null;
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
      failure = await this.repairMetadata(account, token);
    } catch (error) {
      failure = await this.describeFailure(account.id, error);
    }
    try {
      await this.settleState(account.id, failure);
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
   * pass still owns a live lease, and refuses a page whose backlog keys would not fit — so a
   * throw rolls the page rows, the checkpoint and this progress back together.
   */
  private async commitPage(accountId: string, report: SyncPageReport): Promise<void> {
    const at = this.nowIso();
    const record = await this.store.getLuoguSyncState(accountId);
    if (record === null || record.value.owner !== this.ownerId || !luoguLeaseLive(record.value, this.ownerId, at)) {
      throw new DomainError('invalid_transition', 'the synchronization lease was lost before the page commit', {
        reason: 'lease_lost',
      });
    }
    const current = record.value;
    const counts = report.counts;
    const keys = counts.kind === 'submissions' ? counts.missingProblemKeys : [];
    if (counts.kind === 'submissions' && counts.missingProblemMetadata > keys.length) {
      throw new DomainError(
        'invalid_transition',
        'the adapter reported more missing problems than it named; refusing a page whose keys could not be recorded',
        { reason: 'metadata_keys_truncated', reported: counts.missingProblemMetadata, named: keys.length },
      );
    }
    const backlog = [...current.missingMetadata];
    for (const key of keys) {
      if (backlog.includes(key)) {
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
   * Repair referenced problem metadata, at most {@link LUOGU_SYNC_METADATA_PER_PASS} rows per pass.
   *
   * Each key is attempted at most once per pass and a failed key is rotated to the end of the
   * durable backlog, so a permanently failing first key cannot starve the others; a failure never
   * discards the already imported submissions. Editorial material is never requested — only
   * `ImportService.refreshProblemMetadata` is used. A session-level failure or a rate limit stops
   * the phase with a typed, durable failure; transient failures just move on.
   */
  private async repairMetadata(account: Account, token: CancellationToken): Promise<LuoguSyncFailure | null> {
    const record = await this.store.getLuoguSyncState(account.id);
    if (record === null || record.value.owner !== this.ownerId) {
      return null;
    }
    const attempted = new Set<string>();
    const backlog = [...record.value.missingMetadata];
    let resolved = 0;
    let failed = 0;
    let failure: LuoguSyncFailure | null = null;
    let fetches = 0;
    while (fetches < LUOGU_SYNC_METADATA_PER_PASS && backlog.length > 0) {
      const key = backlog[0]!;
      if (attempted.has(key)) {
        // Every remaining key was already tried in this pass; the rest wait for the next one.
        break;
      }
      attempted.add(key);
      fetches += 1;
      throwIfCancelled(token);
      const report = await this.gate.run(token, () =>
        this.imports.refreshProblemMetadata(this.metadataSource, {
          problemRef: parseProblemKey(key),
          token,
          limits: this.limits,
        }),
      );
      backlog.shift();
      if (report.status === 'fetched') {
        resolved += 1;
        continue;
      }
      failed += 1;
      // Rotation is the durable fairness cursor: the failed key moves to the end of the backlog.
      backlog.push(key);
      const at = this.nowIso();
      const code: LuoguSyncFailureCode = report.error === null ? 'internal' : failureCodeOf(report.error.code);
      failure = this.buildFailure(code, at, report.error === null ? null : report.error.retryAfterMs, failure);
      if (failure.paused || code === 'rate_limited') {
        break;
      }
    }
    await this.saveMetadataProgress(account.id, { backlog, resolved, failed, failure });
    return failure;
  }

  /** Persist backlog/rotation/counters under the pass's lease, never clobbering a newer owner. */
  private async saveMetadataProgress(
    accountId: string,
    progress: {
      readonly backlog: readonly string[];
      readonly resolved: number;
      readonly failed: number;
      readonly failure: LuoguSyncFailure | null;
    },
  ): Promise<void> {
    const at = this.nowIso();
    try {
      await this.store.transaction(async () => {
        const record = await this.store.getLuoguSyncState(accountId);
        if (record === null || record.value.owner !== this.ownerId) {
          return;
        }
        await this.store.saveLuoguSyncState(
          {
            ...record.value,
            missingMetadata: progress.backlog,
            metadataResolved: record.value.metadataResolved + progress.resolved,
            metadataFailed: record.value.metadataFailed + progress.failed,
            failure: progress.failure ?? record.value.failure,
            updatedAt: at,
          },
          record.revision,
        );
      });
    } catch (error) {
      if (isStaleRevision(error)) {
        // A newer owner replaced the row while the metadata answers were being fetched. The fetched
        // problem rows are already stored (idempotent); the backlog update is dropped rather than
        // clobbering that owner, and the keys stay in the backlog for a later attempt.
        return;
      }
      throw error;
    }
  }

  /** Clear the lease and record the pass outcome; a newer owner's row is never overwritten. */
  private async settleState(accountId: string, failure: LuoguSyncFailure | null): Promise<void> {
    const at = this.nowIso();
    try {
      await this.store.transaction(async () => {
        const record = await this.store.getLuoguSyncState(accountId);
        if (record === null || record.value.owner !== this.ownerId) {
          return;
        }
        await this.store.saveLuoguSyncState(
          { ...record.value, owner: null, leaseExpiresAt: null, pagesInPass: 0, failure, updatedAt: at },
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

  /** Build one durable failure, honoring Retry-After and growing the exponential backoff. */
  private buildFailure(
    code: LuoguSyncFailureCode,
    at: string,
    retryAfterMs: number | null,
    previous: LuoguSyncFailure | null,
  ): LuoguSyncFailure {
    if (luoguSyncFailurePauses(code)) {
      return { code, at, retryAt: null, paused: true };
    }
    const delay =
      retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.round(retryAfterMs)
        : exponentialBackoff(previous);
    return { code, at, retryAt: new Date(Date.parse(at) + delay).toISOString(), paused: false };
  }

  /** Map any pass failure onto the durable vocabulary; cancellation is not a failure. */
  private async describeFailure(accountId: string, error: unknown): Promise<LuoguSyncFailure | null> {
    const at = this.nowIso();
    let code: LuoguSyncFailureCode = 'internal';
    let retryAfterMs: number | null = null;
    if (error instanceof DomainError && error.code === 'cancelled') {
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
    return this.buildFailure(code, at, retryAfterMs, record?.value.failure ?? null);
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
