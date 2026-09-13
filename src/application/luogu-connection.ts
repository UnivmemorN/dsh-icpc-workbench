/**
 * Luogu connection-management port (Sprint 17c).
 *
 * The application layer defines *what* connecting an account must do; an adapter composes the
 * accepted 17b OS credential vault with the accepted 17a authenticated reader and implements it.
 *
 * ## The one rule about secrets
 *
 * The session cookie is carried by exactly one place: {@link LuoguConnectRequest.sessionCookie}, the
 * ephemeral value of one user action. It is never returned from a call, never part of a status, a
 * result, an error or a durable record, and the adapter must persist it only inside the OS-protected
 * credential store under an opaque reference. {@link LuoguConnectionState} therefore holds a
 * *reference*, a status and two instants — never secret material.
 *
 * ## Operations
 *
 * - `capabilities()` — an honest statement of whether this platform has a supported OS-protected
 *   backend. An unsupported platform is a *connection* refusal, never a plugin activation failure.
 * - `connect(request)` — validate the selected canonical account, test the supplied session with a
 *   real authenticated reader page, store it under a **fresh** opaque reference, persist that
 *   reference *before* deleting the previous credential, and leave the previous usable connection in
 *   place on any failure.
 * - `probe(accountId, token)` — re-test the stored session and persist the resulting status
 *   (`connected`, `session_expired`, `challenge`, `schema_changed`, `unavailable`).
 * - `forget(accountId, token)` — clear that account's connection reference and remove **only** that
 *   account's credential. Other credentials are never enumerated or touched.
 *
 * Every operation observes the caller's cancellation token, and the caller (the sync service)
 * serializes connection work with synchronization so an account switch can never race a pass.
 */
import type { Account, CancellationToken } from '../domain/index.js';
import type { LuoguConnectionState } from './luogu-sync-types.js';

/** What a connection implementation can actually do on this platform. */
export interface LuoguConnectionCapabilities {
  /** False when the platform has no supported OS-protected credential backend. */
  readonly implemented: boolean;
  /** Resolved platform, e.g. `win32`. */
  readonly platform: string;
  readonly notes: readonly string[];
}

/** Stable codes of a connection failure a caller may branch on. */
export type LuoguConnectionErrorCode =
  | 'unsupported'
  | 'account_missing'
  | 'account_mismatch'
  | 'not_connected'
  | 'invalid_input'
  | 'cleanup_failed'
  | 'busy';

/**
 * Typed connection failure.
 *
 * The message is a fixed, sanitized sentence: a session value, a vault backend message or a
 * provider body must never travel through it.
 */
export class LuoguConnectionError extends Error {
  readonly code: LuoguConnectionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: LuoguConnectionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'LuoguConnectionError';
    this.code = code;
    this.details = details;
  }
}

/** One connect action: the selected account plus its ephemeral session cookie. */
export interface LuoguConnectRequest {
  /** Canonical id of an **already stored** account; connecting never creates an account. */
  readonly accountId: string;
  /**
   * Raw session cookie value of this one user action.
   *
   * Never logged, never returned, never persisted outside the OS-protected vault.
   */
  readonly sessionCookie: string;
  readonly token: CancellationToken;
}

/** What one successful probe/connect answers with; never carries the session. */
export interface LuoguConnectionResult {
  readonly account: Account;
  readonly state: LuoguConnectionState;
}

/**
 * Connection management for one Luogu source instance.
 *
 * Implementations must resolve the account from their own store (never from caller-supplied
 * identity), must never enumerate credentials, and must keep every failure free of secret material.
 */
export interface LuoguConnectionManager {
  capabilities(): LuoguConnectionCapabilities;
  /** Validate, test and store a session; on failure the previous usable connection stays. */
  connect(request: LuoguConnectRequest): Promise<LuoguConnectionResult>;
  /**
   * Re-test the stored session of one account and persist the observed status.
   *
   * A session-level refusal (expiry, challenge, changed schema, outage) is *data*: it is persisted
   * and returned, not thrown. Only a missing account, a missing connection or an unsupported
   * platform rejects.
   */
  probe(accountId: string, token: CancellationToken): Promise<LuoguConnectionResult>;
  /**
   * Clear the connection of one account and remove only its credential.
   *
   * Idempotent: forgetting a connection that does not exist is a successful no-op.
   */
  forget(accountId: string, token: CancellationToken): Promise<void>;
}
