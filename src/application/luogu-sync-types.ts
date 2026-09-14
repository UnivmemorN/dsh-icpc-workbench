/**
 * Durable Luogu synchronization state and its persistence port (Sprint 17c).
 *
 * Everything here is **plain data plus pure validation**: no filesystem, HTTP, clock or OS access,
 * so the application layer owns the shape of the state while an adapter (SQLite) owns the bytes.
 *
 * ## What is stored, and what is deliberately not
 *
 * The state carries only non-secret, account-scoped facts: the current phase, whether the first
 * full backfill ever completed, when the last scan started and succeeded, page/submission counters,
 * the durable missing-metadata backlog, the cross-instance owner/lease of the running pass and a
 * **safe** failure code with an optional retry instant and an optional
 * {@link LuoguSyncFailureStage}. A session cookie, a credential reference or
 * a raw provider message has no field here; the connection record holds only the *opaque* vault
 * reference of an account's session, which is not secret material.
 *
 * ## Independent facts
 *
 * {@link LuoguSyncState.historyComplete} is an independent fact from the connection status and from
 * the last attempt's failure: a failed incremental scan leaves `historyComplete` untouched, so a
 * later failure can never erase the evidence that the first backfill finished. Only an explicit
 * full reconciliation (and the completion of that reconciliation) moves it back to `false`/`true`.
 *
 * ## Validation
 *
 * Every persisted body is re-validated on the way in *and* on the way out. The validators are
 * closed: an unknown or credential-shaped key (`cookie`, `session`, `secret`, …) is a hard
 * `invalid_input` instead of being stored, the failure code comes from a fixed allowlist, an
 * optional failure `stage` must be one of the two known halves, and the
 * backlog may only hold canonical problem keys of the state's own source instance.
 */
import {
  DomainError,
  invariant,
  assertIsoTimestamp,
  parseProblemKey,
  problemKey as canonicalProblemKeyOf,
} from '../domain/index.js';
import { CREDENTIAL_REFERENCE_PATTERN } from './local-credential-vault.js';
import { PLATFORM_ERROR_REASONS, type PlatformErrorReason } from './platform-errors.js';

// ---------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------

/** Default automatic-sync interval in minutes; the contract default is 30. */
export const LUOGU_SYNC_DEFAULT_INTERVAL_MINUTES = 30;

/** Minimum accepted automatic-sync interval in minutes. */
export const LUOGU_SYNC_INTERVAL_MIN_MINUTES = 5;

/** Maximum accepted automatic-sync interval in minutes (24 hours). */
export const LUOGU_SYNC_INTERVAL_MAX_MINUTES = 1440;

/**
 * Recent-verdict overlap of an incremental scan, in milliseconds (7 days).
 *
 * The window starts at the previous **successful scan start** minus this overlap, so a verdict that
 * changed shortly after it was first seen is refreshed. It is deliberately not a claim that every
 * historical rejudge is detected: an arbitrary old rejudge needs the explicit full reconciliation.
 */
export const LUOGU_SYNC_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows requested per history page. Kept ≤ 50 so the page's missing-metadata report is complete. */
export const LUOGU_SYNC_PAGE_SIZE = 50;

/** History pages one pass may commit; the remainder resumes on the next pass. */
export const LUOGU_SYNC_MAX_PAGES_PER_PASS = 20;

/** Default page size of the `luogu.metadataBacklog` read. */
export const LUOGU_METADATA_BACKLOG_DEFAULT_PAGE_SIZE = 20;

/**
 * Maximum accepted `pageSize` of the `luogu.metadataBacklog` read.
 *
 * The read is deliberately bounded: a caller can never ask this operation for the whole durable
 * backlog in one answer, so the endpoint cannot be turned into an unbounded database scan.
 */
export const LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE = 50;

/**
 * Fixed sentence for a queued key with no recorded per-key diagnostic.
 *
 * It deliberately says "no per-key failure has been recorded yet" rather than "never attempted":
 * a state row written before the diagnostics existed carries no per-key record even though the key
 * may have failed many times, and an honest label must not assert history it cannot prove.
 */
export const LUOGU_METADATA_UNKNOWN_ISSUE_LABEL = '尚无逐题失败记录';

/**
 * Problem metadata rows one **ordinary** pass may fetch.
 *
 * Raised from the original `10` by Sprint 22a so a routine pass repairs a useful batch; the explicit
 * metadata-only start mode drains up to {@link LUOGU_SYNC_MAX_METADATA_BACKLOG} keys in one pass
 * instead, one attempt per key.
 */
export const LUOGU_SYNC_METADATA_PER_PASS = 100;

/**
 * Upper bound of the durable missing-metadata backlog.
 *
 * Overflow is **backpressure, not a drop path**: a caller that reaches the bound stops requesting
 * further history pages (the sync service refuses to page past it) and reports the full backlog,
 * so every key stays recoverable and `backlogDropped` stays `0`.
 */
export const LUOGU_SYNC_MAX_METADATA_BACKLOG = 2000;

/** Lease length of one running pass; refreshed on every committed page. */
export const LUOGU_SYNC_DEFAULT_LEASE_MS = 120_000;

/** First retry delay after a retryable platform failure. */
export const LUOGU_SYNC_MIN_BACKOFF_MS = 2_000;

/** Ceiling of the exponential retry backoff. */
export const LUOGU_SYNC_MAX_BACKOFF_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------------------

/**
 * Durable phase of one account's synchronization.
 *
 * `backfill` means the first full history scan has not completed; `incremental` means it has;
 * `reconcile` is set exactly while an explicitly requested full reconciliation is in progress and
 * implies `historyComplete === false`.
 */
export type LuoguSyncPhase = 'backfill' | 'incremental' | 'reconcile';

export const LUOGU_SYNC_PHASES: readonly LuoguSyncPhase[] = ['backfill', 'incremental', 'reconcile'];

/**
 * Safe failure codes a status may carry.
 *
 * The vocabulary is fixed so no raw provider text, exception message, cookie or record body can
 * ever be persisted: a failure is a code plus two instants and nothing else.
 */
export type LuoguSyncFailureCode =
  | 'auth_required'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'changed_response'
  | 'invalid_input'
  | 'not_connected'
  | 'unsupported'
  | 'lease_lost'
  | 'cleanup_failed'
  | 'internal';

export const LUOGU_SYNC_FAILURE_CODES: readonly LuoguSyncFailureCode[] = [
  'auth_required',
  'forbidden',
  'rate_limited',
  'timeout',
  'unavailable',
  'changed_response',
  'invalid_input',
  'not_connected',
  'unsupported',
  'lease_lost',
  'cleanup_failed',
  'internal',
];

/**
 * Codes that pause automatic attempts until the user acts (reconnect, or an explicit restart).
 *
 * A rate limit or a transient outage is *not* in this set: those carry `retryAt` and resume on
 * their own, without a tight loop. `invalid_input` **is** in this set because a rejected request is
 * deterministic: an automatic retry could only repeat the same refusal forever, so it waits for the
 * explicit action that changes the request instead.
 */
export const LUOGU_SYNC_PAUSING_FAILURES: readonly LuoguSyncFailureCode[] = [
  'auth_required',
  'forbidden',
  'changed_response',
  'invalid_input',
  'not_connected',
  'unsupported',
  'cleanup_failed',
];

/** True when `code` pauses automatic attempts until an explicit user action. */
export function luoguSyncFailurePauses(code: LuoguSyncFailureCode): boolean {
  return LUOGU_SYNC_PAUSING_FAILURES.includes(code);
}

/**
 * Which half of one pass produced a failure.
 *
 * A pass reads the authenticated submission history first and then repairs the problem-metadata
 * backlog, which starts as an anonymous public read and may retry exactly once with the account's
 * own stored session. Both halves can answer `auth_required`, but the two answers do not mean the
 * same thing: a metadata `auth_required` is a public problem read the platform asked to
 * authenticate (older records may predate the authenticated retry) so it is not evidence that the
 * session of the history reader is broken. `stage` exists to keep that distinction durable instead
 * of inferring it from a code that two different operations share.
 */
export type LuoguSyncFailureStage = 'history' | 'metadata';

export const LUOGU_SYNC_FAILURE_STAGES: readonly LuoguSyncFailureStage[] = ['history', 'metadata'];

/** One sanitized failure of the last synchronization attempt. */
export interface LuoguSyncFailure {
  readonly code: LuoguSyncFailureCode;
  /** When the failure was observed. */
  readonly at: string;
  /** When automatic attempts may resume (retryable failures), or `null` when they stay paused. */
  readonly retryAt: string | null;
  /** True when automatic attempts are paused until the user acts, independent of `retryAt`. */
  readonly paused: boolean;
  /**
   * Which half of the pass failed, on every failure this build records.
   *
   * The field is optional because records written before it existed carry exactly four fields:
   * reading one never invents a stage. A missing stage therefore means "this record predates the
   * distinction", not `history`.
   */
  readonly stage?: LuoguSyncFailureStage;
  /**
   * Canonical key of the **one** item this failure addresses, for an item-scoped failure.
   *
   * Optional, like `stage`: a record written before the field existed — or a session-level failure
   * that belongs to no single key — carries none, and a missing value is never read as "some key".
   * The field is what lets a later successful repair clear a stored failure only when that failure
   * explicitly names the key it just addressed.
   */
  readonly problemKey?: string;
  /** Closed, body-free diagnostic reason of the failure, when this build can name one. */
  readonly reason?: PlatformErrorReason;
}

/**
 * Maximum accepted `attempts` of one durable per-key issue.
 *
 * A bound keeps a hostile or corrupted row from claiming an absurd counter; the value is a count of
 * observed failures, so reaching it is not a drop path — later failures keep the ceiling instead of
 * overflowing.
 */
export const LUOGU_METADATA_MAX_ISSUE_ATTEMPTS = 1_000_000;

/**
 * One durable, body-free diagnostic of the last failed metadata attempt for one backlog key.
 *
 * The record answers "why is this key still queued?" without holding any content: `code` is the
 * durable failure vocabulary, `reason` is the closed {@link PlatformErrorReason} classification (or
 * `null` when this build cannot name one), `at` is when the failure was observed and `attempts` is
 * how many failures this key has accumulated. A raw parser message, an exception text, a response
 * body, a cookie and a credential have no field here and are refused on the way in.
 *
 * The issue is **deferrable** for exactly two item-scoped refusals: an explicit `missing_statement`
 * and a `forbidden` refusal of a private `U`/`T` problem. Those leave the key queued and the sync
 * continues with the other keys, while the diagnostic stays until that key is actually resolved. An
 * `auth_required` answer is not one of them: the metadata read first retries with the account's own
 * stored session and, if that also asks for authentication, this diagnostic is recorded while the
 * source pauses instead of deferring the key.
 */
export interface LuoguMetadataIssue {
  readonly problemKey: string;
  readonly code: LuoguSyncFailureCode;
  readonly reason: PlatformErrorReason | null;
  readonly at: string;
  readonly attempts: number;
}

/** Closed key set of one durable metadata issue. */
export const LUOGU_METADATA_ISSUE_KEYS = ['problemKey', 'code', 'reason', 'at', 'attempts'] as const;

/**
 * Durable per-account synchronization state.
 *
 * The object is the complete truth about one account's sync bookkeeping; timestamps and counters are
 * supplied by the caller, so a replay is deterministic. `missingMetadata` holds canonical problem
 * keys of exactly this state's source instance, capped at
 * {@link LUOGU_SYNC_MAX_METADATA_BACKLOG} distinct entries. The cap is backpressure, not a drop
 * path: this build never forgets a key, so a caller at the bound stops paging instead of trimming
 * the list, and `backlogDropped` must stay `0`.
 */
export interface LuoguSyncState {
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly phase: LuoguSyncPhase;
  /** True only after a full history scan reached its end; a failed incremental scan never clears it. */
  readonly historyComplete: boolean;
  readonly historyCompletedAt: string | null;
  /** Start instant of the currently running pass, or of the last one that ran. */
  readonly scanStartedAt: string | null;
  /** Start instant of the last **successful** scan; the incremental window is derived from it. */
  readonly lastScanStartedAt: string | null;
  /** Completion instant of the last successful scan. */
  readonly lastSuccessAt: string | null;
  readonly pagesInPass: number;
  readonly totalPages: number;
  readonly submissionsSeen: number;
  readonly missingMetadata: readonly string[];
  /**
   * Number of backlog keys this build had to forget to respect the cap.
   *
   * Always `0`: the bound is enforced as backpressure, there is no drop path, and the validator
   * refuses a non-zero value instead of accepting state that has already lost keys.
   */
  readonly backlogDropped: number;
  readonly metadataResolved: number;
  readonly metadataFailed: number;
  /**
   * Bounded per-key diagnostics of the queued backlog, newest recorded failure per key.
   *
   * Optional because rows written before the field existed carry no per-key record: a missing field
   * means **unknown**, never an inferred failure, and reading one changes nothing on disk. When the
   * field is written it holds at most one entry per key, only canonical keys that are members of
   * this state's own `missingMetadata` backlog, and never any raw text. The number of entries is a
   * count of *known* issues and is deliberately independent of {@link metadataFailed}, which counts
   * failed attempts over the whole history.
   */
  readonly metadataIssues?: readonly LuoguMetadataIssue[];
  /** Cross-instance lease owner of the running pass, or `null` when idle. */
  readonly owner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly failure: LuoguSyncFailure | null;
  readonly updatedAt: string;
}

/** One stored state plus the revision its next save must match (or `null` for a create). */
export interface LuoguSyncStateRecord {
  readonly revision: number;
  readonly value: LuoguSyncState;
}

/** Fresh state of an account that never synced; `phase: 'backfill'`, history incomplete. */
export function emptyLuoguSyncState(
  accountId: string,
  sourceInstanceId: string,
  at: string,
): LuoguSyncState {
  return {
    accountId,
    sourceInstanceId,
    phase: 'backfill',
    historyComplete: false,
    historyCompletedAt: null,
    scanStartedAt: null,
    lastScanStartedAt: null,
    lastSuccessAt: null,
    pagesInPass: 0,
    totalPages: 0,
    submissionsSeen: 0,
    missingMetadata: [],
    backlogDropped: 0,
    metadataResolved: 0,
    metadataFailed: 0,
    metadataIssues: [],
    owner: null,
    leaseExpiresAt: null,
    failure: null,
    updatedAt: assertIsoTimestamp('sync state updatedAt', at),
  };
}

/**
 * True when `at` is at or after the state's lease deadline, i.e. the running pass is recoverable.
 *
 * An unleased state counts as expired: there is no deadline to wait for. Both instants are
 * validated, so a malformed clock argument is a typed refusal instead of a `NaN` comparison that
 * would silently answer "not expired".
 */
export function luoguLeaseExpired(state: LuoguSyncState, at: string): boolean {
  const instant = assertIsoTimestamp('lease at', at);
  if (state.owner === null || state.leaseExpiresAt === null) {
    return true;
  }
  return Date.parse(state.leaseExpiresAt) <= Date.parse(instant);
}

/**
 * True when the state holds a **live** lease at `at`, optionally held by `owner`.
 *
 * `owner === null` asks "is any pass running right now?"; a concrete owner asks "is that running
 * pass mine?". The answer is `true` only when a lease exists, its deadline is still in the future,
 * and — when an owner is named — the stored owner is exactly that owner. A lease held by a
 * *different* live owner is therefore `false` here; {@link luoguLeaseHeldByAnother} names that
 * situation explicitly.
 */
export function luoguLeaseLive(state: LuoguSyncState, owner: string | null, at: string): boolean {
  if (state.owner === null || state.leaseExpiresAt === null || luoguLeaseExpired(state, at)) {
    return false;
  }
  return owner === null || state.owner === owner;
}

/**
 * True when a **live** lease at `at` belongs to another owner than `owner`.
 *
 * This is the explicit back-off predicate: `luoguLeaseHeldByAnother(state, me, at)` means someone
 * else is running a pass right now and the caller must not start one. Within live leases it is the
 * exact complement of `luoguLeaseLive(state, owner, at)`.
 */
export function luoguLeaseHeldByAnother(state: LuoguSyncState, owner: string, at: string): boolean {
  invariant(
    typeof owner === 'string' && owner.trim().length > 0,
    'invalid_input',
    'lease owner must be a non-empty string',
    { owner },
  );
  return luoguLeaseLive(state, null, at) && state.owner !== owner;
}

// ---------------------------------------------------------------------------------------
// Sync settings
// ---------------------------------------------------------------------------------------

/**
 * Durable automatic-synchronization configuration of **one account**.
 *
 * Automation is per account, never a plugin-wide singleton: enabling it for one account does not
 * enable another, and disconnecting an account only turns off that account's automation. Defaults
 * are automatic sync **off** and startup synchronization on *for when it is enabled*: the plugin
 * never contacts a platform on its own until the user enables it for an account, and once enabled a
 * host start performs one pass. The interval is bounded to 5..1440 minutes. Nothing here identifies
 * a model, a cost or a credential.
 */
export interface LuoguSyncSettings {
  readonly accountId: string;
  readonly automaticEnabled: boolean;
  readonly runOnStartup: boolean;
  readonly intervalMinutes: number;
  readonly updatedAt: string;
}

/** One stored settings value plus the revision its next save must match (or `null` for a create). */
export interface LuoguSyncSettingsRecord {
  readonly revision: number;
  readonly value: LuoguSyncSettings;
}

/** Contract defaults of one account: automation off, startup pass on when enabled, 30-minute interval. */
export function defaultLuoguSyncSettings(accountId: string, at: string): LuoguSyncSettings {
  return {
    accountId: requireText('sync settings accountId', accountId),
    automaticEnabled: false,
    runOnStartup: true,
    intervalMinutes: LUOGU_SYNC_DEFAULT_INTERVAL_MINUTES,
    updatedAt: assertIsoTimestamp('sync settings updatedAt', at),
  };
}

// ---------------------------------------------------------------------------------------
// Connection record
// ---------------------------------------------------------------------------------------

/**
 * Connection status of one account's stored session.
 *
 * `connected` means the last probe answered with real records; `session_expired` is an
 * authentication wall, `challenge` an HTML/CAPTCHA-shaped answer, `schema_changed` a payload this
 * build no longer understands, and `unavailable` any other operational refusal. Every non-connected
 * status pauses automatic attempts of that account until the user acts.
 */
export type LuoguConnectionStatus = 'connected' | 'session_expired' | 'challenge' | 'schema_changed' | 'unavailable';

export const LUOGU_CONNECTION_STATUSES: readonly LuoguConnectionStatus[] = [
  'connected',
  'session_expired',
  'challenge',
  'schema_changed',
  'unavailable',
];

/**
 * Durable, non-secret connection record of one account.
 *
 * `reference` is the **opaque** vault reference the session is stored under; it is not a secret and
 * is useless without the workspace-scoped OS credential store that owns it. `staleReference` records
 * a reference whose credential could not be removed during a replacement, so a failed cleanup stays
 * visible and is retried instead of being swallowed.
 */
export interface LuoguConnectionState {
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly reference: string;
  readonly status: LuoguConnectionStatus;
  readonly connectedAt: string;
  readonly checkedAt: string;
  readonly failureCode: LuoguSyncFailureCode | null;
  readonly staleReference: string | null;
}

/** One stored connection plus the revision its next save must match (or `null` for a create). */
export interface LuoguConnectionRecord {
  readonly revision: number;
  readonly value: LuoguConnectionState;
}

/**
 * One write-ahead journal entry of the connection adapter.
 *
 * `connect` records the **opaque** reference of a session here *before* the secret is written to
 * the OS credential store, so a crash between the vault write and the connection save can never
 * leave a credential that nothing points at. The journal holds no secret — only the same opaque
 * reference a connection row would hold — and an entry whose reference appears on the account's
 * current connection row is *adopted*: recovery retires the entry without touching that credential.
 */
export interface LuoguConnectionJournalEntry {
  readonly accountId: string;
  readonly reference: string;
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------------------

/**
 * Persistence port for durable Luogu synchronization state.
 *
 * Deliberately separate from {@link import('./ports.js').TrainingStore} so an unrelated store fake is
 * never forced to implement capabilities it does not have, and so the plugin composes exactly the
 * capability it needs. Every method joins the caller's open transaction when there is one; none of
 * them opens a nested transaction, which is what lets the page-commit hook write progress in the
 * same transaction as the page data and the checkpoint.
 *
 * `save*` methods are compare-and-set: `expectedRevision` is `null` only for the first save and the
 * previously read revision for every update; a mismatch rejects *before* any write, so a stale
 * writer can never resurrect a disconnected job or overwrite newer progress. A connection revision
 * is additionally **never reissued**: an implementation keeps a per-account generation counter
 * across a delete, so a caller prepared against a removed row cannot mutate the row a later
 * reconnect creates.
 */
export interface LuoguSyncStore {
  /** Automatic-sync settings of one account, or `null` before that account's first save. */
  getLuoguSyncSettings(accountId: string): Promise<LuoguSyncSettingsRecord | null>;
  /** Insert or update one account's settings; the account must already be stored. */
  saveLuoguSyncSettings(value: LuoguSyncSettings, expectedRevision: number | null): Promise<number>;
  getLuoguSyncState(accountId: string): Promise<LuoguSyncStateRecord | null>;
  /** Insert or update one account's state; the account must already be stored (never created here). */
  saveLuoguSyncState(value: LuoguSyncState, expectedRevision: number | null): Promise<number>;
  getLuoguConnection(accountId: string): Promise<LuoguConnectionRecord | null>;
  /** Insert or update one account's connection reference; the account must already be stored. */
  saveLuoguConnection(value: LuoguConnectionState, expectedRevision: number | null): Promise<number>;
  /**
   * Delete the connection row of `accountId` under revision CAS.
   *
   * Deleting a row that is already gone is a successful no-op, but a row at a different revision is
   * refused: a disconnect prepared against an older read must never remove a newly replaced session.
   */
  deleteLuoguConnection(accountId: string, expectedRevision: number | null): Promise<void>;
  /** Every stored connection in deterministic account-id order (never an enumeration of secrets). */
  listLuoguConnections(): Promise<readonly LuoguConnectionState[]>;
  /**
   * Every unlinked credential reference of `accountId`, in recorded order.
   *
   * The journal is the durable write-ahead half of a connection replacement: an adapter records a
   * fresh opaque reference here **before** it writes the secret, so a crash or a failed link leaves
   * a reference that recovery can remove instead of an unreachable credential. Entries never hold
   * secret material; a reference that is also on the account's connection row is adopted and must
   * never be deleted by journal cleanup.
   */
  listLuoguConnectionJournal(accountId: string): Promise<readonly LuoguConnectionJournalEntry[]>;
  /** Record one opaque reference before its secret is written; idempotent for an existing pair. */
  appendLuoguConnectionJournal(accountId: string, reference: string): Promise<void>;
  /** Forget one journal entry after its credential was adopted or removed; idempotent. */
  removeLuoguConnectionJournalEntry(accountId: string, reference: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

const STATE_KEYS = [
  'accountId',
  'sourceInstanceId',
  'phase',
  'historyComplete',
  'historyCompletedAt',
  'scanStartedAt',
  'lastScanStartedAt',
  'lastSuccessAt',
  'pagesInPass',
  'totalPages',
  'submissionsSeen',
  'missingMetadata',
  'backlogDropped',
  'metadataResolved',
  'metadataFailed',
  'owner',
  'leaseExpiresAt',
  'failure',
  'updatedAt',
] as const;

const FAILURE_KEYS = ['code', 'at', 'retryAt', 'paused'] as const;
/**
 * Keys a failure may carry *in addition to* {@link FAILURE_KEYS}.
 *
 * `stage` was added after the first durable failures existed, so it is accepted but never required:
 * a pre-existing four-field row stays valid and is never rewritten just to gain a stage, while an
 * unknown value (or any other undeclared key) is still a hard refusal. `problemKey` and `reason`
 * follow the same rule: item-scoped diagnostics a record may name, never fields a reader invents.
 */
const FAILURE_OPTIONAL_KEYS = ['stage', 'problemKey', 'reason'] as const;
/**
 * Keys of a sync state that are optional.
 *
 * `metadataIssues` was added after the first durable states existed: a row written before it must
 * stay readable and must **not** be rewritten, so the field is optional on the way in and is never
 * defaulted. A missing field means "no per-key diagnostics recorded", never "no failures happened".
 */
const STATE_OPTIONAL_KEYS = ['metadataIssues'] as const;
const SETTINGS_KEYS = ['accountId', 'automaticEnabled', 'runOnStartup', 'intervalMinutes', 'updatedAt'] as const;
const CONNECTION_KEYS = [
  'accountId',
  'sourceInstanceId',
  'reference',
  'status',
  'connectedAt',
  'checkedAt',
  'failureCode',
  'staleReference',
] as const;
const JOURNAL_ENTRY_KEYS = ['accountId', 'reference', 'recordedAt'] as const;

/**
 * Validate one sync state and return a detached copy.
 *
 * Rejected: an undeclared key (which is how a credential-shaped field would arrive), a missing
 * declared key, a non-canonical or foreign backlog key, an unknown phase, failure code or failure
 * stage, a
 * `historyComplete` flag without its completion instant, a half lease (`owner` without a deadline or
 * the reverse), a retry instant before the failure, and a paused failure that also carries a retry
 * instant (the two are contradictory claims).
 */
export function validateLuoguSyncState(value: unknown): LuoguSyncState {
  const record = requireObject('sync state', value);
  requireExactKeys('sync state', record, STATE_KEYS, STATE_OPTIONAL_KEYS);
  const accountId = requireText('sync state accountId', record['accountId']);
  const sourceInstanceId = requireText('sync state sourceInstanceId', record['sourceInstanceId']);
  const phase = record['phase'];
  invariant(
    LUOGU_SYNC_PHASES.includes(phase as LuoguSyncPhase),
    'invalid_input',
    `unknown sync phase ${String(phase)}`,
    { phase },
  );
  const historyComplete = requireBoolean('sync state historyComplete', record['historyComplete']);
  const historyCompletedAt = requireNullableTimestamp('sync state historyCompletedAt', record['historyCompletedAt']);
  invariant(
    !historyComplete || historyCompletedAt !== null,
    'invalid_input',
    'a completed history requires its completion instant',
    { reason: 'history_completion_missing' },
  );
  invariant(
    phase !== 'reconcile' || !historyComplete,
    'invalid_input',
    'a running full reconciliation cannot claim a complete history',
    { reason: 'reconcile_complete' },
  );
  const scanStartedAt = requireNullableTimestamp('sync state scanStartedAt', record['scanStartedAt']);
  const lastScanStartedAt = requireNullableTimestamp('sync state lastScanStartedAt', record['lastScanStartedAt']);
  const lastSuccessAt = requireNullableTimestamp('sync state lastSuccessAt', record['lastSuccessAt']);
  const pagesInPass = requireCount('sync state pagesInPass', record['pagesInPass']);
  const totalPages = requireCount('sync state totalPages', record['totalPages']);
  const submissionsSeen = requireCount('sync state submissionsSeen', record['submissionsSeen']);
  invariant(
    Array.isArray(record['missingMetadata']),
    'invalid_input',
    'sync state missingMetadata must be an array',
    {},
  );
  const rawBacklog = record['missingMetadata'] as readonly unknown[];
  invariant(
    rawBacklog.length <= LUOGU_SYNC_MAX_METADATA_BACKLOG,
    'invalid_input',
    `sync state missingMetadata holds at most ${LUOGU_SYNC_MAX_METADATA_BACKLOG} keys`,
    { length: rawBacklog.length, bound: LUOGU_SYNC_MAX_METADATA_BACKLOG },
  );
  const seen = new Set<string>();
  const missingMetadata = rawBacklog.map((entry) => {
    const key = requireText('sync state missingMetadata entry', entry);
    const canonical = canonicalKeyOf(sourceInstanceId, key);
    invariant(!seen.has(canonical), 'invalid_input', `sync state repeats backlog key ${canonical}`, {
      problemKey: canonical,
    });
    seen.add(canonical);
    return canonical;
  });
  const backlogDropped = requireCount('sync state backlogDropped', record['backlogDropped']);
  invariant(
    backlogDropped === 0,
    'invalid_input',
    'this build has no backlog-drop path; a full backlog refuses the write instead of forgetting keys',
    { reason: 'backlog_drop_unsupported', backlogDropped },
  );
  const metadataResolved = requireCount('sync state metadataResolved', record['metadataResolved']);
  const metadataFailed = requireCount('sync state metadataFailed', record['metadataFailed']);
  const metadataIssues = validateMetadataIssues(record['metadataIssues'], sourceInstanceId, seen);
  const owner = requireNullableText('sync state owner', record['owner']);
  const leaseExpiresAt = requireNullableTimestamp('sync state leaseExpiresAt', record['leaseExpiresAt']);
  invariant(
    (owner === null) === (leaseExpiresAt === null),
    'invalid_input',
    'sync state must hold an owner and a lease deadline together',
    { reason: 'half_lease', owner, leaseExpiresAt },
  );
  const failure = record['failure'] === null ? null : validateLuoguSyncFailure(record['failure']);
  const updatedAt = requireTimestamp('sync state updatedAt', record['updatedAt']);
  return {
    accountId,
    sourceInstanceId,
    phase: phase as LuoguSyncPhase,
    historyComplete,
    historyCompletedAt,
    scanStartedAt,
    lastScanStartedAt,
    lastSuccessAt,
    pagesInPass,
    totalPages,
    submissionsSeen,
    missingMetadata,
    backlogDropped,
    metadataResolved,
    metadataFailed,
    // A legacy row without per-key diagnostics is returned without the field, so re-saving it never
    // invents an empty list where the stored bytes say "unknown".
    ...(metadataIssues === undefined ? {} : { metadataIssues }),
    owner,
    leaseExpiresAt,
    failure,
    updatedAt,
  };
}

/** Validate one sanitized failure record; `stage` is validated when present and never required. */
export function validateLuoguSyncFailure(value: unknown): LuoguSyncFailure {
  const record = requireObject('sync failure', value);
  requireExactKeys('sync failure', record, FAILURE_KEYS, FAILURE_OPTIONAL_KEYS);
  const code = record['code'];
  invariant(
    LUOGU_SYNC_FAILURE_CODES.includes(code as LuoguSyncFailureCode),
    'invalid_input',
    `unknown sync failure code ${String(code)}`,
    { code },
  );
  const at = requireTimestamp('sync failure at', record['at']);
  const retryAt = requireNullableTimestamp('sync failure retryAt', record['retryAt']);
  const paused = requireBoolean('sync failure paused', record['paused']);
  const stage = record['stage'];
  invariant(
    !Object.prototype.hasOwnProperty.call(record, 'stage') || LUOGU_SYNC_FAILURE_STAGES.includes(stage as LuoguSyncFailureStage),
    'invalid_input',
    `unknown sync failure stage ${String(stage)}`,
    { stage },
  );
  const problemKey = optionalFailureProblemKey(record['problemKey']);
  const reason = optionalFailureReason(record['reason']);
  invariant(
    !paused || retryAt === null,
    'invalid_input',
    'a paused failure waits for the user, so it cannot carry a retry instant',
    { reason: 'paused_with_retry' },
  );
  if (retryAt !== null) {
    invariant(
      Date.parse(retryAt) >= Date.parse(at),
      'invalid_input',
      'a retry instant cannot precede the failure it belongs to',
      { at, retryAt },
    );
  }
  // A legacy record is returned exactly as stored: no stage, key or reason is invented for it.
  return {
    code: code as LuoguSyncFailureCode,
    at,
    retryAt,
    paused,
    ...(stage === undefined ? {} : { stage: stage as LuoguSyncFailureStage }),
    ...(problemKey === undefined ? {} : { problemKey }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Validate one durable per-key metadata issue and return a detached copy.
 *
 * The record is closed: exactly {@link LUOGU_METADATA_ISSUE_KEYS} must be present, the key must be
 * canonical, the code must come from the durable failure vocabulary, the reason must be a declared
 * {@link PlatformErrorReason} or `null`, the instant must be ISO-8601 and `attempts` a bounded
 * integer ≥ 1. A raw string detail, a body sample, a cookie or an exception message has no field
 * here, so none of them can be persisted through this validator.
 */
export function validateLuoguMetadataIssue(value: unknown): LuoguMetadataIssue {
  const record = requireObject('metadata issue', value);
  requireExactKeys('metadata issue', record, LUOGU_METADATA_ISSUE_KEYS);
  const problemKey = canonicalIssueKey(requireText('metadata issue problemKey', record['problemKey']));
  const code = record['code'];
  invariant(
    LUOGU_SYNC_FAILURE_CODES.includes(code as LuoguSyncFailureCode),
    'invalid_input',
    `metadata issue has unknown code ${String(code)}`,
    { code },
  );
  const reason = record['reason'];
  invariant(
    reason === null || (typeof reason === 'string' && PLATFORM_ERROR_REASONS.includes(reason as PlatformErrorReason)),
    'invalid_input',
    `metadata issue has unknown reason ${String(reason)}`,
    { reason },
  );
  const attempts = record['attempts'];
  invariant(
    typeof attempts === 'number' &&
      Number.isSafeInteger(attempts) &&
      attempts >= 1 &&
      attempts <= LUOGU_METADATA_MAX_ISSUE_ATTEMPTS,
    'invalid_input',
    `metadata issue attempts must be an integer within 1..${LUOGU_METADATA_MAX_ISSUE_ATTEMPTS}`,
    { attempts },
  );
  return {
    problemKey,
    code: code as LuoguSyncFailureCode,
    reason: reason === null ? null : (reason as PlatformErrorReason),
    at: requireTimestamp('metadata issue at', record['at']),
    attempts,
  };
}

/** The recorded issue of one key, or `null` when that key has no known issue. */
export function metadataIssueFor(
  issues: readonly LuoguMetadataIssue[] | undefined,
  problemKey: string,
): LuoguMetadataIssue | null {
  if (issues === undefined) {
    return null;
  }
  return issues.find((issue) => issue.problemKey === problemKey) ?? null;
}

/**
 * Insert or replace the issue of exactly one key, keeping the oldest-first order of the rest.
 *
 * The result holds at most one entry per key, so it can never grow past the backlog bound it
 * describes. Unrelated issues are carried over unchanged — a failure of one key never erases the
 * diagnostic another key earned.
 */
export function upsertMetadataIssue(
  issues: readonly LuoguMetadataIssue[] | undefined,
  issue: LuoguMetadataIssue,
): readonly LuoguMetadataIssue[] {
  const validated = validateLuoguMetadataIssue(issue);
  const kept = (issues ?? []).filter((entry) => entry.problemKey !== validated.problemKey);
  return [...kept, validated];
}

/** Remove **only** the issue of `problemKey`; every other diagnostic stays untouched. */
export function clearMetadataIssue(
  issues: readonly LuoguMetadataIssue[] | undefined,
  problemKey: string,
): readonly LuoguMetadataIssue[] {
  return (issues ?? []).filter((entry) => entry.problemKey !== problemKey);
}

/** Canonicalize one issue key without a source check; the state validator proves the source. */
function canonicalIssueKey(key: string): string {
  let canonical: string;
  try {
    canonical = canonicalProblemKeyOf(parseProblemKey(key));
  } catch (error) {
    throw new DomainError('invalid_input', `metadata issue key ${key} is not a canonical problem key`, {
      reason: 'non_canonical_issue_key',
      problemKey: key,
      cause: String(error),
    });
  }
  invariant(canonical === key, 'invalid_input', `metadata issue key ${key} is not a canonical problem key`, {
    reason: 'non_canonical_issue_key',
    problemKey: key,
  });
  return canonical;
}

/** Validate the whole optional per-key diagnostics list against its own backlog and source. */
function validateMetadataIssues(
  value: unknown,
  sourceInstanceId: string,
  backlog: ReadonlySet<string>,
): readonly LuoguMetadataIssue[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  invariant(Array.isArray(value), 'invalid_input', 'sync state metadataIssues must be an array', {});
  const raw = value as readonly unknown[];
  invariant(
    raw.length <= LUOGU_SYNC_MAX_METADATA_BACKLOG,
    'invalid_input',
    `sync state metadataIssues holds at most ${LUOGU_SYNC_MAX_METADATA_BACKLOG} entries`,
    { length: raw.length, bound: LUOGU_SYNC_MAX_METADATA_BACKLOG },
  );
  const issues: LuoguMetadataIssue[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const issue = validateLuoguMetadataIssue(entry);
    // Source identity is re-derived from the key itself, exactly like the backlog keys.
    canonicalKeyOf(sourceInstanceId, issue.problemKey);
    invariant(
      !seen.has(issue.problemKey),
      'invalid_input',
      `sync state repeats the metadata issue of ${issue.problemKey}`,
      { problemKey: issue.problemKey },
    );
    invariant(
      backlog.has(issue.problemKey),
      'invalid_input',
      `sync state metadata issue ${issue.problemKey} is not a member of the missingMetadata backlog`,
      { reason: 'issue_not_in_backlog', problemKey: issue.problemKey },
    );
    seen.add(issue.problemKey);
    issues.push(issue);
  }
  return issues;
}

/** Optional canonical key of an item-scoped failure; `undefined` stays `undefined`. */
function optionalFailureProblemKey(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return canonicalIssueKey(requireText('sync failure problemKey', value));
}

/** Optional closed diagnostic reason of a failure; an undeclared value is refused. */
function optionalFailureReason(value: unknown): PlatformErrorReason | undefined {
  if (value === undefined) {
    return undefined;
  }
  invariant(
    typeof value === 'string' && PLATFORM_ERROR_REASONS.includes(value as PlatformErrorReason),
    'invalid_input',
    `unknown sync failure reason ${String(value)}`,
    { reason: value },
  );
  return value as PlatformErrorReason;
}

/** Validate sync settings of one account, enforcing the documented interval bounds. */
export function validateLuoguSyncSettings(value: unknown): LuoguSyncSettings {
  const record = requireObject('sync settings', value);
  requireExactKeys('sync settings', record, SETTINGS_KEYS);
  const accountId = requireText('sync settings accountId', record['accountId']);
  const intervalMinutes = record['intervalMinutes'];
  invariant(
    typeof intervalMinutes === 'number' &&
      Number.isSafeInteger(intervalMinutes) &&
      intervalMinutes >= LUOGU_SYNC_INTERVAL_MIN_MINUTES &&
      intervalMinutes <= LUOGU_SYNC_INTERVAL_MAX_MINUTES,
    'invalid_input',
    `sync interval must be an integer within ${LUOGU_SYNC_INTERVAL_MIN_MINUTES}..${LUOGU_SYNC_INTERVAL_MAX_MINUTES} minutes`,
    { intervalMinutes },
  );
  return {
    accountId,
    automaticEnabled: requireBoolean('sync settings automaticEnabled', record['automaticEnabled']),
    runOnStartup: requireBoolean('sync settings runOnStartup', record['runOnStartup']),
    intervalMinutes,
    updatedAt: requireTimestamp('sync settings updatedAt', record['updatedAt']),
  };
}

/** Validate one connection record; the reference must be a well-formed opaque vault reference. */
export function validateLuoguConnectionState(value: unknown): LuoguConnectionState {
  const record = requireObject('connection state', value);
  requireExactKeys('connection state', record, CONNECTION_KEYS);
  const status = record['status'];
  invariant(
    LUOGU_CONNECTION_STATUSES.includes(status as LuoguConnectionStatus),
    'invalid_input',
    `unknown connection status ${String(status)}`,
    { status },
  );
  const failureCode = record['failureCode'];
  invariant(
    failureCode === null || LUOGU_SYNC_FAILURE_CODES.includes(failureCode as LuoguSyncFailureCode),
    'invalid_input',
    `unknown connection failure code ${String(failureCode)}`,
    { failureCode },
  );
  const staleReference = record['staleReference'];
  return {
    accountId: requireText('connection state accountId', record['accountId']),
    sourceInstanceId: requireText('connection state sourceInstanceId', record['sourceInstanceId']),
    reference: requireOpaqueReference('connection state reference', record['reference']),
    status: status as LuoguConnectionStatus,
    connectedAt: requireTimestamp('connection state connectedAt', record['connectedAt']),
    checkedAt: requireTimestamp('connection state checkedAt', record['checkedAt']),
    failureCode: failureCode === null ? null : (failureCode as LuoguSyncFailureCode),
    staleReference:
      staleReference === null ? null : requireOpaqueReference('connection state staleReference', staleReference),
  };
}

/** The only connection statuses that are usable for synchronization. */
export function connectionIsUsable(state: LuoguConnectionState | null): boolean {
  return state !== null && state.status === 'connected';
}

/**
 * Validate one write-ahead journal entry and return a detached copy.
 *
 * The entry is the whole durable record of an unlinked credential: an account, an **opaque**
 * reference and the instant it was recorded. An undeclared key — most importantly anything
 * credential-shaped — is refused instead of being stored, exactly like every other record here.
 */
export function validateLuoguConnectionJournalEntry(value: unknown): LuoguConnectionJournalEntry {
  const record = requireObject('connection journal entry', value);
  requireExactKeys('connection journal entry', record, JOURNAL_ENTRY_KEYS);
  return {
    accountId: requireText('connection journal entry accountId', record['accountId']),
    reference: requireOpaqueReference('connection journal entry reference', record['reference']),
    recordedAt: requireTimestamp('connection journal entry recordedAt', record['recordedAt']),
  };
}

// ---------------------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function requireObject(label: string, value: unknown): JsonObject {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `${label} must be a JSON object`,
    { label },
  );
  return value as JsonObject;
}

/**
 * Enforce a closed key set: `keys` must all be present, `optional` may be present, and anything
 * else is an unknown key. The `optional` half exists for a field added after the first durable rows
 * were written ({@link LuoguSyncFailure.stage}); it is never required and never defaulted.
 */
function requireExactKeys(
  label: string,
  value: JsonObject,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key) && !optional.includes(key));
  invariant(
    unknown.length === 0,
    'invalid_input',
    `${label} has unknown keys: ${unknown.join(', ')}`,
    { label, unknown },
  );
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  invariant(missing.length === 0, 'invalid_input', `${label} is missing keys: ${missing.join(', ')}`, {
    label,
    missing,
  });
}

function requireText(label: string, value: unknown): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} must be a non-empty string`,
    { label },
  );
  return value;
}

function requireNullableText(label: string, value: unknown): string | null {
  return value === null ? null : requireText(label, value);
}

function requireBoolean(label: string, value: unknown): boolean {
  invariant(typeof value === 'boolean', 'invalid_input', `${label} must be a boolean`, { label });
  return value;
}

function requireTimestamp(label: string, value: unknown): string {
  invariant(typeof value === 'string', 'invalid_input', `${label} must be a string`, { label });
  return assertIsoTimestamp(label, value);
}

function requireNullableTimestamp(label: string, value: unknown): string | null {
  return value === null ? null : requireTimestamp(label, value);
}

function requireCount(label: string, value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'invalid_input',
    `${label} must be a safe integer >= 0`,
    { label },
  );
  return value;
}

/** Re-derive a backlog key and refuse one that belongs to another source instance. */
function canonicalKeyOf(sourceInstanceId: string, key: string): string {
  let canonical: string;
  try {
    canonical = canonicalProblemKeyOf(parseProblemKey(key));
  } catch (error) {
    throw new DomainError('invalid_input', `backlog key ${key} is not a canonical problem key`, {
      reason: 'non_canonical_backlog_key',
      problemKey: key,
      cause: String(error),
    });
  }
  invariant(
    canonical === key,
    'invalid_input',
    `backlog key ${key} is not a canonical problem key`,
    { reason: 'non_canonical_backlog_key', problemKey: key },
  );
  const ref = parseProblemKey(key);
  invariant(
    ref.sourceInstanceId === sourceInstanceId,
    'invalid_input',
    `backlog key ${key} belongs to another source instance`,
    { reason: 'foreign_backlog_key', sourceInstanceId, problemKey: key },
  );
  return canonical;
}

/** One opaque credential reference as the vault port defines it; never secret material. */
function requireOpaqueReference(label: string, value: unknown): string {
  invariant(
    typeof value === 'string' && CREDENTIAL_REFERENCE_PATTERN.test(value),
    'invalid_input',
    `${label} must be an opaque credential reference`,
    { label },
  );
  return value;
}

/**
 * Validate one opaque, non-secret credential reference.
 *
 * Exported for the store and the connection adapter: a reference is the only credential-shaped
 * value either of them may persist, so both validate it with the vault's own pattern before any
 * write. A cookie or any other secret never matches.
 */
export function validateCredentialReference(value: unknown): string {
  return requireOpaqueReference('credential reference', value);
}
