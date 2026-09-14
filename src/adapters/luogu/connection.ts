/**
 * Luogu connection manager adapter (Sprint 17c2).
 *
 * Implements the accepted `application/LuoguConnectionManager` port on top of
 * the Sprint 17c1 connection store, the Sprint 17b OS credential vault and the Sprint 17a
 * authenticated session reader. Nothing here is a second credential path: the session cookie
 * travels from the connect request into the vault, and from the vault into exactly one
 * authenticated reader call, and it is never echoed by a result, a status or an error.
 *
 * ## Connect protocol (order matters)
 *
 * 1. Resolve the **already stored** account and prove it is a canonical account of the official
 *    Luogu instance; connecting never creates an account.
 * 2. Recover — best effort — any journaled reference an interrupted connect left unlinked, then
 *    test the supplied ephemeral cookie with a real authenticated reader page *before* anything is
 *    replaced. A previously recorded stale reference is cleaned next, so a failure there changes
 *    nothing.
 * 3. Record the fresh opaque reference in the durable **write-ahead journal** *before* writing the
 *    cookie under it. A crash between the vault write and the link therefore leaves a reference
 *    that recovery can remove, instead of a credential nothing points at.
 * 4. Persist the new connection record under revision CAS **before** deleting the previous secret.
 *    A CAS or validation failure removes the fresh reference (and retires its journal entry) and
 *    leaves the previous usable connection untouched.
 * 5. Retire the journal entry, delete the previous secret and re-read the stored row: a row that was
 *    removed or replaced in the meantime is refused as `busy` instead of answering with an invented
 *    `connected` result. A failed previous-secret removal is represented durably by
 *    `staleReference` on the new record — never swallowed, never fatal to the new connection — and a
 *    later probe retries it.
 *
 * ## Probe, forget and the stored-session provider
 *
 * `probe` re-reads the current connection *and* the vault on every call, records only the observed
 * status and a fixed failure code, and never surfaces a provider message; it also retries the
 * journal recovery, so an orphaned reference is cleaned even when the connection row never
 * appeared. `forget` removes every reference of the account — the row's own and the journal's —
 * after which it retires the journal entries and deletes the row under CAS. The stored-session
 * provider is the only component that turns a reference into a secret: it re-reads both rows per
 * call and returns `{uid, cookie}` to the reader, with a fixed typed `auth_required` error for a
 * missing or non-connected session.
 *
 * ## Concurrency
 *
 * The service serializes `connect`/`probe`/`forget` per account and the store compares revisions on
 * every write, so a stale writer loses. Recovery reads the journal and the connection row without a
 * lock: an overlapping operation of the *same* account is not expected (the service refuses it), and
 * a reference is only ever removed when it is neither the row's current nor its stale reference.
 *
 * ## Known limitation
 *
 * The accepted Sprint 17a reader folds every HTML answer that is not the login page into
 * `changed_response`; it exposes no separate "challenge" discriminant. This adapter therefore maps
 * `changed_response` onto `schema_changed` and never fabricates `challenge`. A future reader that
 * distinguishes a CAPTCHA can be classified here without touching the port.
 */
import { randomUUID } from 'node:crypto';
import {
  DomainError,
  invariant,
  normalizeLuoguSessionCookie,
  throwIfCancelled,
  type Account,
  type CancellationToken,
  type LuoguCookieProblem,
  type SourceInstance,
} from '../../domain/index.js';
import type { SyncPageSource } from '../../application/import-types.js';
import {
  LuoguConnectionError,
  type LuoguConnectionCapabilities,
  type LuoguConnectRequest,
  type LuoguConnectionManager,
  type LuoguConnectionResult,
} from '../../application/luogu-connection.js';
import {
  LocalCredentialVaultError,
  MAX_CREDENTIAL_SECRET_BYTES,
  requireCredentialReference,
  requireCredentialSecret,
  type LocalCredentialVault,
} from '../../application/local-credential-vault.js';
import type {
  LuoguConnectionJournalEntry,
  LuoguConnectionRecord,
  LuoguConnectionState,
  LuoguConnectionStatus,
  LuoguSyncFailureCode,
} from '../../application/luogu-sync-types.js';
import { PlatformError, isPlatformError } from '../../application/platform-errors.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformLimits } from '../../application/ports.js';
import type { LuoguSourceGate } from '../../application/luogu-source-gate.js';
import type { ClockFn, FetchLike, SetTimerFn, WaitFn } from '../platform/http.js';
import { requireLuoguInstance } from './adapter.js';
import { requireLuoguUid } from './account.js';
import type { LuoguSessionReader } from '../../application/luogu-session.js';
import {
  createLuoguSessionReader,
  type LuoguSession,
  type LuoguSessionProvider,
} from './session-reader.js';

/** The persistence surface a connection manager needs; `SqliteTrainingStore` satisfies it. */
export interface LuoguConnectionStore {
  getAccount(id: string): Promise<Account | null>;
  getLuoguConnection(accountId: string): Promise<LuoguConnectionRecord | null>;
  saveLuoguConnection(value: LuoguConnectionState, expectedRevision: number | null): Promise<number>;
  deleteLuoguConnection(accountId: string, expectedRevision: number | null): Promise<void>;
  /** Unlinked write-ahead references of one account; see {@link LuoguConnectionJournalEntry}. */
  listLuoguConnectionJournal(accountId: string): Promise<readonly LuoguConnectionJournalEntry[]>;
  /** Record one opaque reference durably *before* its secret is written; idempotent. */
  appendLuoguConnectionJournal(accountId: string, reference: string): Promise<void>;
  /** Retire one journal entry once its credential was adopted or removed; idempotent. */
  removeLuoguConnectionJournalEntry(accountId: string, reference: string): Promise<void>;
}

/** Transport wiring forwarded to the default reader factory (tests inject a synthetic fetch). */
export interface LuoguReaderTransportOptions {
  readonly fetchImpl?: FetchLike;
  readonly clock?: ClockFn;
  readonly wait?: WaitFn;
  readonly setTimer?: SetTimerFn;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
}

/**
 * A submissions reader bound to its own source instance.
 *
 * `SyncPageSource` needs the instance next to `listSubmissions`, and the accepted
 * {@link LuoguSessionReader} port deliberately does not carry it, so the factory below states the
 * additional, non-secret requirement explicitly.
 */
export type LuoguBoundSessionReader = LuoguSessionReader & { readonly sourceInstance: SourceInstance };

export interface LuoguConnectionAdapterOptions {
  readonly store: LuoguConnectionStore;
  readonly vault: LocalCredentialVault;
  readonly sourceInstance: SourceInstance;
  /** Injected clock returning an ISO-8601 timestamp for the recorded instants. */
  readonly now: () => string;
  /** Fresh opaque reference factory; defaults to `luogu.session.<uuid>`. */
  readonly newReference?: () => string;
  /** Limits of the validation page; defaults to the approved v1 policy with one requested row. */
  readonly limits?: PlatformLimits;
  /** Shared source-wide pacing gate; supply the same instance the sync service uses. */
  readonly gate?: LuoguSourceGate | null;
  /** Reader factory seam; defaults to the accepted authenticated Luogu reader. */
  readonly createReader?: (sessions: LuoguSessionProvider) => LuoguBoundSessionReader;
  readonly transport?: LuoguReaderTransportOptions;
}

export interface StoredLuoguSessionProviderOptions {
  readonly store: LuoguConnectionStore;
  readonly vault: LocalCredentialVault;
  /**
   * When true (the default) a stored connection whose last observation is not `connected` is
   * refused before the vault is read; the sync path must not issue a request with a session that is
   * already known to be dead. `probe` sets it to false, because re-observing is its whole purpose.
   */
  readonly requireConnectedStatus?: boolean;
}

export interface StoredSubmissionsSourceOptions extends StoredLuoguSessionProviderOptions {
  readonly sourceInstance: SourceInstance;
  readonly createReader?: (sessions: LuoguSessionProvider) => LuoguBoundSessionReader;
  readonly transport?: LuoguReaderTransportOptions;
}

/**
 * A token that is never cancelled.
 *
 * Used only for **compensating cleanup** after an aborted connection write: a freshly written
 * credential must not be left behind without a durable reference, so the compensation runs to
 * completion regardless of the caller's cancellation and the original failure is rethrown after it.
 */
const NEVER_CANCELLED: CancellationToken = {
  cancelled: false,
  reason: null,
  throwIfCancelled() {},
  onCancel() {
    return () => {};
  },
};

/** A fixed `auth_required` failure; the reader rebuilds it into its own sanitized error anyway. */
function missingSession(accountId: string): PlatformError {
  return new PlatformError({
    code: 'auth_required',
    operation: 'submissions',
    retryable: false,
    detail: `the stored Luogu session of ${accountId} is missing or expired`,
  });
}

/**
 * Credential provider over the **current** connection row and vault entry.
 *
 * Every call re-reads both, so a reconnect, a probe or a forget performed between two reader calls
 * is observed immediately; a cached cookie would let a removed session keep working. The stored
 * value is normalized to the canonical `__client_id=…; _uid=…` pair on every read — a legacy
 * whole-Cookie entry therefore keeps working without being rewritten — and only that pair is handed
 * to the reader. A stored value that cannot yield a usable session is an authentication wall.
 */
export function createStoredLuoguSessionProvider(
  options: StoredLuoguSessionProviderOptions,
): LuoguSessionProvider {
  invariant(
    options !== null && typeof options === 'object' && options.store !== null && options.vault !== null,
    'unfilled_settings',
    'the stored-session provider requires the connection store and the credential vault',
  );
  const requireConnected = options.requireConnectedStatus !== false;
  return {
    async sessionFor(account: Account, token: CancellationToken): Promise<LuoguSession> {
      throwIfCancelled(token);
      const record = await options.store.getLuoguConnection(account.id);
      if (record === null) {
        throw missingSession(account.id);
      }
      if (requireConnected && record.value.status !== 'connected') {
        throw missingSession(account.id);
      }
      const stored = await options.vault.read(record.value.reference, token);
      if (typeof stored !== 'string' || stored.length === 0) {
        throw missingSession(account.id);
      }
      // Normalized on every read: the vault is never rewritten just to change the shape of a legacy
      // whole-Cookie entry, and only the two required cookies reach the authenticated reader.
      const normalized = normalizeLuoguSessionCookie(stored, account.handle);
      if (!normalized.ok) {
        throw missingSession(account.id);
      }
      return { uid: account.handle, cookie: normalized.cookie };
    },
  };
}

/**
 * Build the submissions source the sync service drives.
 *
 * One reader per account is cached, so the reader's own per-account transport pacing survives
 * across pages; the stored-session provider under it re-reads the current session on every call.
 */
export function createStoredSubmissionsSource(
  options: StoredSubmissionsSourceOptions,
): (account: Account) => SyncPageSource {
  invariant(
    options !== null && typeof options === 'object' && options.sourceInstance !== null,
    'unfilled_settings',
    'the stored submissions source requires the official Luogu source instance',
  );
  const provider = createStoredLuoguSessionProvider(options);
  const createReader =
    options.createReader ??
    ((sessions: LuoguSessionProvider): LuoguBoundSessionReader =>
      createLuoguSessionReader({
        sourceInstance: options.sourceInstance,
        sessions,
        fetchImpl: options.transport?.fetchImpl,
        clock: options.transport?.clock,
        wait: options.transport?.wait,
        setTimer: options.transport?.setTimer,
        maxResponseBytes: options.transport?.maxResponseBytes,
        maxRedirects: options.transport?.maxRedirects,
      }));
  const readers = new Map<string, LuoguBoundSessionReader>();
  return (account: Account): SyncPageSource => {
    const existing = readers.get(account.id);
    if (existing !== undefined) {
      return existing;
    }
    const reader = createReader(provider);
    readers.set(account.id, reader);
    return reader;
  };
}

/** What one observed reader failure means for the stored connection. */
interface ProbeClassification {
  readonly status: LuoguConnectionStatus;
  readonly code: LuoguSyncFailureCode;
}

/** Map a typed reader failure onto the persisted status vocabulary; never a raw message. */
function classifyFailure(error: unknown): ProbeClassification {
  if (isPlatformError(error)) {
    switch (error.code) {
      case 'auth_required':
        return { status: 'session_expired', code: 'auth_required' };
      case 'forbidden':
        return { status: 'unavailable', code: 'forbidden' };
      case 'rate_limited':
        return { status: 'unavailable', code: 'rate_limited' };
      case 'changed_response':
        return { status: 'schema_changed', code: 'changed_response' };
      case 'invalid_input':
        return { status: 'unavailable', code: 'invalid_input' };
      case 'unavailable':
        return { status: 'unavailable', code: 'unavailable' };
      case 'cancelled':
        return { status: 'unavailable', code: 'internal' };
    }
  }
  return { status: 'unavailable', code: 'internal' };
}

/** Map a rejected connection write onto a stable, secret-free connection error. */
function mapConnectionSaveFailure(error: unknown): LuoguConnectionError {
  if (error instanceof DomainError && (error.code === 'invalid_transition' || error.code === 'duplicate_id')) {
    return new LuoguConnectionError(
      'busy',
      'the stored connection changed while this operation was running; re-read before retrying',
      { reason: 'stale_revision' },
    );
  }
  return new LuoguConnectionError('busy', 'the connection could not be persisted', { reason: 'persistence' });
}

/** Fixed, secret-free reason text per unusable supplied session; it never quotes the supplied value. */
const COOKIE_FAILURES: Readonly<Record<LuoguCookieProblem, string>> = {
  not_text: 'a non-empty Luogu session cookie value is required',
  empty: 'a non-empty Luogu session cookie value is required',
  too_long: 'the supplied Luogu session cookie value is too long',
  unsafe_characters: 'the supplied Luogu session cookie value contains control characters',
  missing_client_id: 'the supplied Luogu session carries no __client_id',
  missing_uid: 'the supplied Luogu session carries no _uid',
  duplicate_client_id: 'the supplied Luogu session repeats __client_id',
  duplicate_uid: 'the supplied Luogu session repeats _uid',
  unusable_client_id: 'the supplied Luogu session __client_id is not a syntactically safe opaque value',
  unusable_uid: 'the supplied Luogu session _uid is not a canonical Luogu UID',
  uid_not_canonical: 'the selected account has no canonical Luogu UID',
  foreign_uid: 'the supplied Luogu session belongs to another account',
};

/**
 * Normalize and validate the supplied session value before any credential work.
 *
 * A whole browser Cookie header is accepted, but only the two required cookies survive: what reaches
 * the vault is the canonical pair, so an unrelated cookie can neither be stored nor make the value
 * exceed the credential store's capacity. The **normalized** size is what is checked against
 * {@link MAX_CREDENTIAL_SECRET_BYTES}; the raw input is bounded by the pure domain normalizer.
 */
function requireCookieText(value: unknown, uid: string): string {
  const normalized = normalizeLuoguSessionCookie(value, uid);
  if (!normalized.ok) {
    throw new LuoguConnectionError('invalid_input', COOKIE_FAILURES[normalized.problem]);
  }
  try {
    requireCredentialSecret(normalized.cookie);
  } catch {
    throw new LuoguConnectionError(
      'invalid_input',
      `the normalized Luogu session cookie exceeds the ${MAX_CREDENTIAL_SECRET_BYTES} byte credential capacity`,
    );
  }
  return normalized.cookie;
}

/**
 * Connection management for the official Luogu instance.
 *
 * Construction is inert and never throws on an unsupported platform: `capabilities()` answers
 * honestly and every operation that would need the OS store rejects with `unsupported`.
 */
export class LuoguConnectionAdapter implements LuoguConnectionManager {
  private readonly store: LuoguConnectionStore;
  private readonly vault: LocalCredentialVault;
  private readonly sourceInstance: SourceInstance;
  private readonly now: () => string;
  private readonly newReference: () => string;
  private readonly limits: PlatformLimits;
  private readonly gate: LuoguSourceGate | null;
  private readonly createReader: ((sessions: LuoguSessionProvider) => LuoguBoundSessionReader) | null;
  private readonly transport: LuoguReaderTransportOptions;

  constructor(options: LuoguConnectionAdapterOptions) {
    invariant(
      options !== null && typeof options === 'object' && options.store !== null && options.vault !== null,
      'unfilled_settings',
      'LuoguConnectionAdapter requires an explicit connection store and credential vault',
    );
    invariant(typeof options.now === 'function', 'unfilled_settings', 'LuoguConnectionAdapter requires now()');
    if (options.newReference !== undefined && typeof options.newReference !== 'function') {
      throw new LuoguConnectionError('invalid_input', 'newReference must be a function when supplied');
    }
    if (options.createReader !== undefined && typeof options.createReader !== 'function') {
      throw new LuoguConnectionError('invalid_input', 'createReader must be a function when supplied');
    }
    // The instance proof runs at construction: an adapter bound to another origin could never be
    // allowed to attach a session, so it is refused before anything can call it.
    requireLuoguInstance(options.sourceInstance, 'submissions');
    this.store = options.store;
    this.vault = options.vault;
    this.sourceInstance = options.sourceInstance;
    this.now = options.now;
    this.newReference = options.newReference ?? (() => `luogu.session.${randomUUID()}`);
    this.limits = options.limits ?? DEFAULT_PLATFORM_LIMITS;
    this.gate = options.gate ?? null;
    this.createReader = options.createReader ?? null;
    this.transport = options.transport ?? {};
  }

  /** Honest capability statement; never advertises a backend the platform does not have. */
  capabilities(): LuoguConnectionCapabilities {
    const vault = this.vault.capabilities();
    return {
      implemented: vault.implemented,
      platform: vault.platform,
      notes: [
        'Luogu sessions are held only by the injected OS credential vault; the cookie is used for exactly one authenticated reader call and is never returned through this port.',
        ...vault.notes,
      ],
    };
  }

  /**
   * Validate, test and store one session.
   *
   * Resolves only after the new reference is durably persisted; a session-level or compare-and-set
   * failure leaves the previous usable connection in place. The fresh reference is journaled before
   * its secret is written, so neither a crash nor a failed cleanup can leave an unreachable
   * credential. A cleanup failure of the *previous* secret does not fail the call: it stays visible
   * as `staleReference` on the returned record.
   */
  async connect(request: LuoguConnectRequest): Promise<LuoguConnectionResult> {
    const token = request.token;
    throwIfCancelled(token);
    this.requireSupported();
    const account = await this.requireAccount(request.accountId);
    const cookie = requireCookieText(request.sessionCookie, account.handle);

    const previous = await this.store.getLuoguConnection(account.id);
    // Recover what an interrupted connect left behind before a new credential is created. The
    // current row's own references are never removed here: their cleanup belongs to the protocol
    // below (`staleReference`) and to `forget`.
    await this.recoverJournal(account.id, previous?.value ?? null, token);

    // Test the ephemeral cookie with the accepted reader before anything is replaced.
    await this.testSession(account, cookie, token);
    throwIfCancelled(token);

    const stale = previous?.value.staleReference ?? null;
    if (stale !== null && stale !== (previous?.value.reference ?? null)) {
      // An earlier replacement could not delete its predecessor. It is retried before a new
      // credential is written, so a failure here changes nothing at all.
      await this.removeCredential(stale, token, 'stale_cleanup');
      await this.retireJournalEntry(account.id, stale);
    }

    const reference = this.newReference();
    requireCredentialReference(reference);
    if (previous !== null && previous.value.reference === reference) {
      throw new LuoguConnectionError('invalid_input', 'the reference factory returned the reference already in use');
    }
    // Write-ahead: the reference is durable before the secret exists, so a crash between the vault
    // write and the connection save leaves something addressable to clean up.
    await this.recordJournalEntry(account.id, reference);
    try {
      await this.writeCredential(reference, cookie, token);
    } catch (error) {
      // The vault may have committed the secret before reporting a failure; compensating cleanup
      // runs on a token that is never cancelled and preserves the journal entry if even that fails.
      await this.compensateJournalEntry(account.id, reference);
      throw error;
    }

    const at = this.nowIso();
    const state: LuoguConnectionState = {
      accountId: account.id,
      sourceInstanceId: this.sourceInstance.id,
      reference,
      status: 'connected',
      connectedAt: at,
      checkedAt: at,
      failureCode: null,
      // Marked before the removal is attempted so a crash or a failed removal can never leave an
      // unrecorded credential behind.
      staleReference: previous !== null && previous.value.reference !== reference ? previous.value.reference : null,
    };
    let revision: number;
    try {
      revision = await this.store.saveLuoguConnection(state, previous === null ? null : previous.revision);
    } catch (error) {
      await this.compensateJournalEntry(account.id, reference);
      if (error instanceof DomainError && error.code === 'cancelled') {
        // The cancellation is reported unchanged after the compensating cleanup.
        throw error;
      }
      throw mapConnectionSaveFailure(error);
    }

    // The reference is linked now. A journal entry that survives this (a failed retirement, a crash)
    // is *adopted*: recovery only retires the entry and must never delete this credential.
    await this.retireJournalEntry(account.id, reference);

    if (state.staleReference !== null) {
      try {
        await this.vault.remove(state.staleReference, token);
        await this.store.saveLuoguConnection({ ...state, staleReference: null }, revision);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'cancelled') {
          throw error;
        }
        // The previous secret could not be removed (or the clearing write lost a CAS race). The new
        // connection stays usable and the leftover reference stays recorded and retryable.
      }
    }
    const stored = await this.store.getLuoguConnection(account.id);
    if (stored === null || stored.value.reference !== state.reference) {
      // Between the successful save and this read another writer removed or replaced the row, so
      // nothing addresses the fresh credential anymore. Re-journal it before refusing, so recovery
      // can still remove it instead of leaving it unreachable.
      await this.recordJournalEntry(account.id, reference);
      throw new LuoguConnectionError(
        'busy',
        'the stored connection changed before the new session was linked; re-read before retrying',
        { reason: 'connection_changed', accountId: account.id },
      );
    }
    return { account, state: stored.value };
  }

  /**
   * Re-test the stored session and persist the observed status.
   *
   * A session-level refusal is data, not an exception: it is classified, persisted and returned.
   * Only a missing account, a missing connection row or an unsupported platform rejects.
   */
  async probe(accountId: string, token: CancellationToken): Promise<LuoguConnectionResult> {
    throwIfCancelled(token);
    this.requireSupported();
    const account = await this.requireAccount(accountId);
    const record = await this.store.getLuoguConnection(account.id);
    // Recovery runs before the missing-row refusal: an interrupted connect whose row never appeared
    // must not leave its credential unreachable just because there is nothing to probe.
    await this.recoverJournal(account.id, record?.value ?? null, token);
    if (record === null) {
      throw new LuoguConnectionError('not_connected', `account ${account.id} has no stored Luogu session`, {
        accountId: account.id,
      });
    }
    const provider = createStoredLuoguSessionProvider({
      store: this.store,
      vault: this.vault,
      // A probe exists to re-observe; it must not trust the previous observation.
      requireConnectedStatus: false,
    });
    let status: LuoguConnectionStatus = 'connected';
    let failureCode: LuoguSyncFailureCode | null = null;
    try {
      await this.readOne(account, token, provider);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'cancelled') {
        throw error;
      }
      const classified = classifyFailure(error);
      status = classified.status;
      failureCode = classified.code;
    }

    let staleReference = record.value.staleReference;
    if (staleReference !== null) {
      try {
        await this.vault.remove(staleReference, token);
        staleReference = null;
      } catch (error) {
        if (error instanceof DomainError && error.code === 'cancelled') {
          throw error;
        }
        // Still unremovable: it stays recorded on the row so the condition remains visible.
      }
    }

    const next: LuoguConnectionState = {
      accountId: account.id,
      sourceInstanceId: this.sourceInstance.id,
      reference: record.value.reference,
      status,
      connectedAt: record.value.connectedAt,
      checkedAt: this.nowIso(),
      failureCode,
      staleReference,
    };
    try {
      await this.store.saveLuoguConnection(next, record.revision);
    } catch (error) {
      throw mapConnectionSaveFailure(error);
    }
    return { account, state: next };
  }

  /**
   * Remove one account's session and clear its connection row.
   *
   * Idempotent for a missing row and for an account that only has journaled references. Credentials
   * of the row *and* of the write-ahead journal are removed **before** anything is forgotten, so a
   * failure keeps every addressable reference in place for a retry instead of orphaning a credential
   * nothing points at. Only references of this account are ever addressed.
   */
  async forget(accountId: string, token: CancellationToken): Promise<void> {
    throwIfCancelled(token);
    this.requireSupported();
    const account = await this.requireAccount(accountId);
    const record = await this.store.getLuoguConnection(account.id);
    const journal = await this.store.listLuoguConnectionJournal(account.id);
    if (record === null && journal.length === 0) {
      return;
    }
    const references = [
      ...new Set([
        ...[record?.value.reference, record?.value.staleReference].filter(
          (reference): reference is string => reference !== null && reference !== undefined,
        ),
        ...journal.map((entry) => entry.reference),
      ]),
    ];
    const failed: string[] = [];
    for (const reference of references) {
      try {
        await this.vault.remove(reference, token);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'cancelled') {
          throw error;
        }
        failed.push(reference);
      }
    }
    if (failed.length > 0) {
      throw new LuoguConnectionError(
        'cleanup_failed',
        `the stored credential of ${account.id} could not be removed; the connection row was kept so the removal can be retried`,
        { accountId: account.id, references: failed },
      );
    }
    for (const entry of journal) {
      await this.store.removeLuoguConnectionJournalEntry(account.id, entry.reference);
    }
    if (record === null) {
      return;
    }
    try {
      await this.store.deleteLuoguConnection(account.id, record.revision);
    } catch (error) {
      throw mapConnectionSaveFailure(error);
    }
  }

  // -------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------

  /** Resolve the stored canonical account of this official instance. */
  private async requireAccount(accountId: string): Promise<Account> {
    if (typeof accountId !== 'string' || accountId.trim().length === 0) {
      throw new LuoguConnectionError('invalid_input', 'accountId must be a non-empty string');
    }
    const account = await this.store.getAccount(accountId);
    if (account === null) {
      throw new LuoguConnectionError('account_missing', `account ${accountId} is not stored`, { accountId });
    }
    if (account.sourceInstanceId !== this.sourceInstance.id) {
      throw new LuoguConnectionError(
        'account_mismatch',
        `account ${accountId} belongs to another source instance`,
        { accountId },
      );
    }
    try {
      requireLuoguUid(this.sourceInstance, account);
    } catch {
      throw new LuoguConnectionError(
        'account_mismatch',
        `account ${accountId} is not a canonical account of this Luogu instance`,
        { accountId },
      );
    }
    return account;
  }

  private requireSupported(): void {
    if (!this.vault.capabilities().implemented) {
      throw new LuoguConnectionError(
        'unsupported',
        'this platform has no supported OS-protected credential backend',
      );
    }
  }

  /** Build one reader over an injected session provider. */
  private readerFor(sessions: LuoguSessionProvider): LuoguBoundSessionReader {
    if (this.createReader !== null) {
      return this.createReader(sessions);
    }
    return createLuoguSessionReader({
      sourceInstance: this.sourceInstance,
      sessions,
      fetchImpl: this.transport.fetchImpl,
      clock: this.transport.clock,
      wait: this.transport.wait,
      setTimer: this.transport.setTimer,
      maxResponseBytes: this.transport.maxResponseBytes,
      maxRedirects: this.transport.maxRedirects,
    });
  }

  /** One authenticated reader page of exactly one row, as one whole gated operation. */
  private async readOne(
    account: Account,
    token: CancellationToken,
    provider: LuoguSessionProvider,
  ): Promise<void> {
    const reader = this.readerFor(provider);
    const request = {
      account,
      cursor: null,
      limit: 1,
      token,
      limits: this.limits,
      since: null,
    };
    if (this.gate === null) {
      await reader.listSubmissions(request);
      return;
    }
    // The gate owns the whole call: the reader may walk more than one server page under its own
    // internal pacing, and the next source-wide operation waits the floor after this one finished.
    await this.gate.run(token, () => reader.listSubmissions(request));
  }

  /** Validate an ephemeral cookie through the accepted reader; refusal is a typed connection error. */
  private async testSession(account: Account, cookie: string, token: CancellationToken): Promise<void> {
    const provider: LuoguSessionProvider = {
      sessionFor: async (requested: Account): Promise<LuoguSession> => ({ uid: requested.handle, cookie }),
    };
    try {
      await this.readOne(account, token, provider);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'cancelled') {
        throw error;
      }
      const classified = classifyFailure(error);
      throw new LuoguConnectionError(
        'not_connected',
        `the supplied session was not accepted by Luogu (${classified.status})`,
        { status: classified.status, failureCode: classified.code },
      );
    }
  }

  /** Store one secret, mapping vault failures onto typed connection errors. */
  private async writeCredential(reference: string, cookie: string, token: CancellationToken): Promise<void> {
    try {
      await this.vault.write(reference, cookie, token);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'cancelled') {
        throw error;
      }
      if (error instanceof LocalCredentialVaultError) {
        if (error.code === 'unsupported') {
          throw new LuoguConnectionError('unsupported', 'the OS credential vault is not supported on this platform');
        }
        if (error.code === 'invalid_input') {
          throw new LuoguConnectionError('invalid_input', 'the session cookie was rejected by the credential store');
        }
      }
      throw new LuoguConnectionError('not_connected', 'the session could not be stored in the OS credential vault', {
        stage: 'vault_write',
        status: 'unavailable',
        failureCode: 'unavailable',
      });
    }
  }

  /** Remove one credential, reporting a typed `cleanup_failed` instead of swallowing the failure. */
  private async removeCredential(reference: string, token: CancellationToken, stage: string): Promise<void> {
    try {
      await this.vault.remove(reference, token);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'cancelled') {
        throw error;
      }
      if (error instanceof LocalCredentialVaultError && error.code === 'unsupported') {
        throw new LuoguConnectionError('unsupported', 'the OS credential vault is not supported on this platform');
      }
      throw new LuoguConnectionError('cleanup_failed', 'a stored credential could not be removed', {
        stage,
        reference,
      });
    }
  }

  /**
   * Durably journal one fresh reference before its secret is written.
   *
   * A failure here aborts the connect before any secret exists, so nothing can be orphaned; the
   * error is a persistence refusal and never carries a provider or vault message.
   */
  private async recordJournalEntry(accountId: string, reference: string): Promise<void> {
    try {
      await this.store.appendLuoguConnectionJournal(accountId, reference);
    } catch (error) {
      throw new LuoguConnectionError(
        'busy',
        'the new session reference could not be recorded durably before the session was stored',
        {
          reason: 'journal_write_failed',
          accountId,
          cause: error instanceof DomainError ? error.code : 'storage',
        },
      );
    }
  }

  /**
   * Retire one journal entry after its credential was adopted or removed.
   *
   * Returns `false` when the entry could not be retired. That is safe and deliberately not fatal:
   * the reference simply stays journaled, and recovery un-journals a reference that is the account's
   * current one without ever removing that credential (see {@link recoverJournal}). Turning this
   * bookkeeping failure into a connection failure would report an already stored, usable session as
   * broken.
   */
  private async retireJournalEntry(accountId: string, reference: string): Promise<boolean> {
    try {
      await this.store.removeLuoguConnectionJournalEntry(accountId, reference);
      return true;
    } catch {
      // Documented above: the entry stays journaled and the next recovery retries it.
      return false;
    }
  }

  /**
   * Clean the references an interrupted connect journaled but never linked.
   *
   * A reference that is the account's **current** connection reference (or its recorded
   * `staleReference`) is *adopted*: its credential is live and is only un-journaled, never removed —
   * a crash after the link but before the journal cleanup must not delete a working session. Every
   * other entry is an orphan: its credential is removed (removing an absent entry is a no-op) and the
   * entry retired. A failed removal keeps the entry, so the leftover stays tracked and is retried by
   * the next connect/probe/forget.
   */
  private async recoverJournal(
    accountId: string,
    current: LuoguConnectionState | null,
    token: CancellationToken,
  ): Promise<void> {
    const journal = await this.store.listLuoguConnectionJournal(accountId);
    if (journal.length === 0) {
      return;
    }
    const adopted = new Set(
      [current?.reference ?? null, current?.staleReference ?? null].filter(
        (reference): reference is string => reference !== null,
      ),
    );
    for (const entry of journal) {
      throwIfCancelled(token);
      if (adopted.has(entry.reference)) {
        await this.retireJournalEntry(accountId, entry.reference);
        continue;
      }
      try {
        await this.vault.remove(entry.reference, token);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'cancelled') {
          throw error;
        }
        // Keep the journal entry: the orphan stays addressable for a later attempt.
        continue;
      }
      await this.retireJournalEntry(accountId, entry.reference);
    }
  }

  /**
   * Compensate a refused vault write or connection save by removing the fresh reference.
   *
   * Runs on a token that is never cancelled: an abort between the vault write and the connection
   * save must not leave a credential nothing points at. If the removal fails, the journal entry is
   * kept, so the leftover stays tracked and recoverable. Never throws: the original failure is what
   * the caller must observe.
   */
  private async compensateJournalEntry(accountId: string, reference: string): Promise<void> {
    try {
      await this.vault.remove(reference, NEVER_CANCELLED);
    } catch {
      // The reference stays journaled; a later recovery retries the removal.
      return;
    }
    await this.retireJournalEntry(accountId, reference);
  }

  private nowIso(): string {
    return this.now();
  }
}

/** Build the connection manager for one official Luogu instance. */
export function createLuoguConnectionManager(
  options: LuoguConnectionAdapterOptions,
): LuoguConnectionAdapter {
  return new LuoguConnectionAdapter(options);
}
