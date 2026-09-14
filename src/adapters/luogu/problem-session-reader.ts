/**
 * Authenticated Luogu problem reader (Sprint 30a).
 *
 * ## Why this module exists
 *
 * A known queued problem can be publicly listed while its detail page answers the anonymous
 * Lentille request with `auth_required`. The website session of the user can read that page, so a
 * *bounded* authenticated reader is needed for exactly one already-known problem — never for a
 * catalog, a dictionary, an editorial or a submission history.
 *
 * ## What it owns
 *
 * - an account-bound source (`createLuoguProblemSessionSource`) exposing only `sourceInstance` and
 *   `fetchProblem(request)`, which reuses {@link LuoguAdapter} for parsing and normalization over a
 *   custom {@link HttpTransport} whose outgoing fetch attaches the session cookie;
 * - that transport wrapper: the cookie is attached **only** to the exact official HTTPS origin and
 *   the exact `/problem/<internally bound pid>` path, with no query, fragment, userinfo or
 *   alternate pid. A login path means the session is gone (`auth_required`) and is refused before
 *   any cookie could travel there; every other deviation, cross-origin redirect included, is
 *   refused before dispatch. `credentials: 'omit'` and the manual same-origin-only redirect policy
 *   stay the shared transport's, and the anonymous adapter/transport keep their blanket cookie
 *   prohibition untouched;
 * - an injected {@link LuoguSessionProvider} seam. The session is read **fresh per call**, validated
 *   against the bound canonical account with {@link requireLuoguSessionCookie}, and reduced to the
 *   minimal `__client_id=…; _uid=…` pair, so unrelated cookies never travel; the cookie and the
 *   expected pid live only while the owning call's request runs and are cleared in a `finally` on
 *   every success, error and cancellation path. At most one call per source instance may be in
 *   flight — an overlapping call is refused before the provider is consulted. The cached transport
 *   (and therefore its >= 2 s pacing state) survives across calls;
 * - a fixed, secret-free failure vocabulary. The injected provider, the injected fetch, the response
 *   body stream and the payload parser can all fail with text that quotes a cookie, a body or a
 *   server-provided `errorType`, so every failure crossing one of those boundaries is rebuilt from a
 *   fixed table keeping only the validated code, a real boolean `retryable`, a normalized
 *   `retryAfterMs`, the attempt count and the closed diagnostic `reason`
 *   (`missing_statement`/`html_response`/`invalid_json`/`invalid_payload`). No `sample`, no `cause`,
 *   no raw parser or network message survives; cancellation stays `cancelled`.
 *
 * ## Non-goals
 *
 * This module never falls back to the anonymous adapter, never probes another endpoint, never
 * loads a tag dictionary, and never infers a missing statement from a `T`/`U` personal-problem
 * prefix or from an authentication denial. The host and sync service own fallback orchestration.
 */
import {
  DEFAULT_PLATFORM_LIMITS,
  type FetchProblemRequest,
  type PlatformLimits,
} from '../../application/ports.js';
import {
  PLATFORM_ERROR_CODES,
  PLATFORM_ERROR_REASONS,
  PlatformError,
  isPlatformError,
  type PlatformErrorCode,
  type PlatformErrorReason,
  type PlatformOperation,
} from '../../application/platform-errors.js';
import {
  DomainError,
  type Account,
  type CancellationToken,
  type NormalizedProblem,
  type ProblemRef,
  type SourceInstance,
} from '../../domain/index.js';
import {
  HARD_MAX_RETRIES,
  HttpTransport,
  type ClockFn,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
  type SetTimerFn,
  type WaitFn,
} from '../platform/http.js';
import {
  LUOGU_BASE_URL,
  LUOGU_DOMAIN,
  LUOGU_MAX_LIST_LIMIT,
  LuoguAdapter,
  requireLuoguInstance,
} from './adapter.js';
import { requireLuoguUid } from './account.js';
import { LUOGU_PID_PATTERN, isJsonRecord } from './parsers.js';
import {
  LUOGU_MIN_REQUEST_INTERVAL_MS,
  requireLuoguSessionCookie,
  type LuoguSession,
  type LuoguSessionProvider,
} from './session-reader.js';

/** Official problem path prefix; the authenticated transport may attach a cookie to nothing else. */
export const LUOGU_PROBLEM_PATH_PREFIX = '/problem/';

/** Paths that mean "the session is gone" rather than "the shape changed". */
const LOGIN_PATHS: ReadonlySet<string> = new Set(['/auth/login', '/login']);
const MAX_LIMITS_VALUE = 600_000;
const MAX_CONCURRENCY = 64;

/**
 * Fixed, secret-free text for every authenticated failure code.
 *
 * Failures reconstructed from this table can never quote a cookie, a provider detail, a parser
 * message, a response body or a network message; callers branch on `code`, never on the text.
 */
const SAFE_FAILURE_DETAILS: Readonly<Record<PlatformErrorCode, string>> = {
  cancelled: 'operation cancelled',
  auth_required: 'the Luogu session is no longer valid',
  forbidden: 'Luogu refused the authenticated problem request',
  rate_limited: 'Luogu rate-limited the authenticated problem request',
  unavailable: 'the authenticated Luogu problem request failed',
  changed_response: 'Luogu answered an unexpected authenticated problem payload',
  invalid_input: 'the authenticated problem request was rejected',
};

/** Runtime allowlist of the codes a sanitized failure may carry; anything else is not a discriminant. */
const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set<string>(PLATFORM_ERROR_CODES);

/**
 * Which untrusted boundary a cause crossed; it decides the retry metadata of an unknown failure.
 *
 * `transport` (the injected fetch and the response body stream) covers real network failures, so an
 * unrecognized one stays retryable. `session` (the credential provider) and `shape` (the adapter and
 * its payload parsers) are not transient IO, so an unrecognized one is terminal.
 */
type UnknownFailureBoundary = 'transport' | 'session' | 'shape';

function invalidInput(operation: PlatformOperation, detail: string): PlatformError {
  return new PlatformError({ code: 'invalid_input', operation, retryable: false, detail });
}

/** Fixed cancellation error: a cancelled call never surfaces a provider or caller message. */
function cancelledFailure(): DomainError {
  return new DomainError('cancelled', SAFE_FAILURE_DETAILS.cancelled);
}

function throwIfCancelled(token: CancellationToken): void {
  if (token.cancelled) {
    throw cancelledFailure();
  }
}

function isKnownFailureCode(value: unknown): value is PlatformErrorCode {
  return typeof value === 'string' && KNOWN_FAILURE_CODES.has(value);
}

/** Keep only a normalized finite non-negative delay; a forged string, `NaN` or a negative is `null`. */
function normalizeRetryAfterMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Keep only a real non-negative attempt count; the shared error contract validates the rest. */
function normalizeAttempts(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Keep only a reason of the closed diagnostic vocabulary; free text is never a reason. */
function normalizeReason(value: unknown): PlatformErrorReason | null {
  return typeof value === 'string' && (PLATFORM_ERROR_REASONS as readonly string[]).includes(value)
    ? (value as PlatformErrorReason)
    : null;
}

/** Fixed failure for a cause that carries no usable discriminant, with boundary-appropriate retryability. */
function unknownFailure(boundary: UnknownFailureBoundary, retryAfterMs: unknown = null): PlatformError {
  return new PlatformError({
    code: 'unavailable',
    operation: 'problem',
    retryable: boundary === 'transport',
    retryAfterMs: normalizeRetryAfterMs(retryAfterMs),
    detail: SAFE_FAILURE_DETAILS.unavailable,
  });
}

/**
 * Rebuild any failure that crosses an untrusted boundary as a fixed sanitized error.
 *
 * `PlatformError` validates neither `code` nor `retryable` at runtime, so a typed cause is only
 * rebuilt when its `code` is one of the shared {@link PLATFORM_ERROR_CODES} **and** its `retryable`
 * is a real boolean; only then do that code, flag, normalized `retryAfterMs`, attempt count and
 * closed `reason` survive. `detail`, `message`, `sample` and `cause` never do. Cancellation keeps
 * its discriminant and becomes a `cancelled` {@link DomainError} with a fixed message; every
 * unusable cause becomes the fixed {@link unknownFailure} of its boundary.
 */
function sanitizeProblemFailure(cause: unknown, boundary: UnknownFailureBoundary): never {
  if (isPlatformError(cause)) {
    const typed = cause as {
      readonly code?: unknown;
      readonly retryable?: unknown;
      readonly retryAfterMs?: unknown;
      readonly attempts?: unknown;
      readonly reason?: unknown;
    };
    if (isKnownFailureCode(typed.code) && typeof typed.retryable === 'boolean') {
      if (typed.code === 'cancelled') {
        throw cancelledFailure();
      }
      throw new PlatformError({
        code: typed.code,
        operation: 'problem',
        retryable: typed.retryable,
        retryAfterMs: normalizeRetryAfterMs(typed.retryAfterMs),
        attempts: normalizeAttempts(typed.attempts),
        reason: normalizeReason(typed.reason),
        detail: SAFE_FAILURE_DETAILS[typed.code],
      });
    }
    throw unknownFailure(boundary, typed.retryAfterMs);
  }
  if (cause instanceof DomainError && cause.code === 'cancelled') {
    throw cancelledFailure();
  }
  throw unknownFailure(boundary);
}

function requireLimitInteger(
  value: unknown,
  label: string,
  operation: PlatformOperation,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidInput(operation, `${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/**
 * Validate every caller limit before the credential provider is consulted; invalid values are never
 * defaulted. The bounds mirror {@link LuoguAdapter}'s own validation, so a request that reaches the
 * adapter is already known to be acceptable to it.
 */
function requireProblemLimits(limits: PlatformLimits, operation: PlatformOperation): void {
  if (!isJsonRecord(limits)) {
    throw invalidInput(operation, 'platform limits are required');
  }
  requireLimitInteger(limits.pageSize, 'limits.pageSize', operation, 1, LUOGU_MAX_LIST_LIMIT);
  requireLimitInteger(limits.maxConcurrency, 'limits.maxConcurrency', operation, 1, MAX_CONCURRENCY);
  requireLimitInteger(limits.minRequestIntervalMs, 'limits.minRequestIntervalMs', operation, 0, MAX_LIMITS_VALUE);
  requireLimitInteger(limits.requestTimeoutMs, 'limits.requestTimeoutMs', operation, 1, MAX_LIMITS_VALUE);
  requireLimitInteger(limits.maxRetries, 'limits.maxRetries', operation, 0, HARD_MAX_RETRIES);
}

/** Resolve one problem reference onto this source instance; only official Luogu ids are accepted. */
function requireProblemRef(
  ref: ProblemRef | null | undefined,
  sourceInstanceId: string,
  operation: PlatformOperation,
): string {
  if (!ref || typeof ref !== 'object') {
    throw invalidInput(operation, 'a problem reference is required');
  }
  if (ref.sourceInstanceId !== sourceInstanceId) {
    throw invalidInput(operation, 'the problem reference belongs to another source instance');
  }
  const domain = typeof ref.domain === 'string' ? ref.domain.trim().toLowerCase() : '';
  if (domain !== '' && domain !== LUOGU_DOMAIN) {
    throw invalidInput(operation, `Luogu problems have no sub-domain, got ${domain}`);
  }
  const raw = typeof ref.externalKey === 'string' ? ref.externalKey.trim() : '';
  if (!LUOGU_PID_PATTERN.test(raw)) {
    throw invalidInput(operation, 'the problem id must be 1-80 alphanumeric, underscore or hyphen characters');
  }
  return raw;
}

const defaultFetchImpl: FetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return { status: response.status, headers: response.headers, body: response.body };
};

/**
 * Refuse any target that is not the internally expected authenticated problem request.
 *
 * The cookie may travel to exactly one endpoint shape: the official HTTPS origin, the exact
 * `/problem/<bound pid>` path built by the owning call, no query, no fragment, no userinfo and no
 * non-default port. A login path means the session is gone (`auth_required`) and is refused before
 * any cookie could be attached to it; every other deviation is an `unavailable` refusal. No failure
 * echoes the target, because a target may address the account's own problem.
 */
function assertExpectedProblemTarget(url: string, expectedPid: string): void {
  const operation: PlatformOperation = 'problem';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PlatformError({
      code: 'unavailable',
      operation,
      retryable: false,
      detail: 'the authenticated request target is not a valid URL',
    });
  }
  if (LOGIN_PATHS.has(parsed.pathname)) {
    throw new PlatformError({
      code: 'auth_required',
      operation,
      retryable: false,
      detail: SAFE_FAILURE_DETAILS.auth_required,
    });
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== LUOGU_BASE_URL ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0
  ) {
    throw new PlatformError({
      code: 'unavailable',
      operation,
      retryable: false,
      detail: 'refusing to attach a Luogu session to a target outside the official origin',
    });
  }
  if (parsed.href !== `${LUOGU_BASE_URL}${LUOGU_PROBLEM_PATH_PREFIX}${expectedPid}`) {
    throw new PlatformError({
      code: 'unavailable',
      operation,
      retryable: false,
      detail: 'refusing an authenticated request that is not the expected problem of this source instance',
    });
  }
}

/**
 * Forward a response, replacing any failure of its body stream with a fixed sanitized error.
 *
 * The shared transport maps a non-typed body-read failure to `network failure: <message>`; that
 * message comes from the injected stream and may quote anything, so the stream is wrapped here — at
 * the authenticated boundary — instead of reaching the transport's error mapping.
 */
function withSanitizedBody(response: FetchResponseLike): FetchResponseLike {
  const body = response.body;
  if (body === null) {
    return response;
  }
  return {
    status: response.status,
    headers: response.headers,
    body: {
      getReader() {
        const reader = body.getReader();
        return {
          async read() {
            try {
              return await reader.read();
            } catch (cause) {
              sanitizeProblemFailure(cause, 'transport');
            }
          },
          cancel(reason?: unknown): Promise<void> {
            return reader.cancel(reason);
          },
        };
      },
    },
  };
}

interface AuthenticatedProblemFetchOptions {
  /** Returns the currently bound session cookie, or `null` when no call owns the transport. */
  readonly cookie: () => string | null;
  /** Canonical pid the owning call is fetching; `null` when no call owns the transport. */
  readonly pid: () => string | null;
  /** Underlying fetch; every call it receives already carries a validated cookie header. */
  readonly fetchImpl: FetchLike;
}

/**
 * Wrap a fetch implementation so it attaches the bound session cookie to exactly one problem URL.
 *
 * Properties the tests pin down: the cookie is attached only to the bound canonical pid of this
 * source instance (any other origin, path, query, fragment, userinfo, port or pid is refused before
 * dispatch, and a login redirect becomes `auth_required` without a request being sent to it); every
 * failure from the underlying fetch — whose message or typed detail may contain anything, including
 * the cookie — is reconstructed with only the validated code and retry metadata; `HttpTransport`
 * still owns pacing, cancellation, timeout, the byte cap and the same-origin-only manual redirect
 * policy, so a cross-origin redirect target is never fetched at all.
 */
function createAuthenticatedLuoguProblemFetch(options: AuthenticatedProblemFetchOptions): FetchLike {
  const operation: PlatformOperation = 'problem';
  return async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    const cookie = options.cookie();
    if (typeof cookie !== 'string' || cookie.length === 0) {
      throw invalidInput(operation, 'no Luogu session is bound to this transport');
    }
    const pid = options.pid();
    if (typeof pid !== 'string' || !LUOGU_PID_PATTERN.test(pid)) {
      throw invalidInput(operation, 'no Luogu problem is currently bound to this transport');
    }
    assertExpectedProblemTarget(url, pid);
    const headers: Record<string, string> = { ...init.headers };
    for (const name of Object.keys(headers)) {
      if (name.trim().toLowerCase() === 'cookie') {
        throw invalidInput(operation, 'the authenticated transport sets its own cookie header');
      }
    }
    headers.cookie = cookie;
    let response: FetchResponseLike;
    try {
      response = await options.fetchImpl(url, { ...init, headers });
    } catch (cause) {
      // The injected fetch can reject with anything — including a typed error whose detail or
      // sample quotes the cookie — so only its validated code and retry metadata may survive.
      sanitizeProblemFailure(cause, 'transport');
    }
    return withSanitizedBody(response);
  };
}

/** One account-bound authenticated problem source: it can only ever fetch for its own account. */
export interface LuoguProblemSessionSource {
  readonly sourceInstance: SourceInstance;
  /**
   * Fetch one known problem with the session of the bound account.
   *
   * The reader validates the source, the canonical account, the problem reference and the limits
   * before consulting the session provider; the session it resolves is normalized to the minimal
   * cookie pair and bound to exactly this call's request.
   */
  fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem>;
}

export interface LuoguProblemSessionSourceOptions {
  readonly sourceInstance: SourceInstance;
  /** Account this source is bound to; its canonical UID addresses every request. */
  readonly account: Account;
  readonly sessions: LuoguSessionProvider;
  /** Injectable transport wiring (tests, host composition); production uses the platform defaults. */
  readonly fetchImpl?: FetchLike;
  readonly clock?: ClockFn;
  readonly wait?: WaitFn;
  readonly setTimer?: SetTimerFn;
  /** Streaming body cap of the authenticated transport; defaults to the shared 8 MiB. */
  readonly maxResponseBytes?: number;
  /** Same-origin redirect budget; defaults to the shared 3. */
  readonly maxRedirects?: number;
}

/**
 * Authenticated Luogu problem reader for one account of one source instance.
 *
 * The adapter and its transport are built once, so parsing/normalization and pacing are shared by
 * every call; only the session binding and the expected pid are per call. The account and the source
 * instance are proven before the provider is consulted, and at most one call may be in flight, so
 * two calls can never swap or clear each other's cookie.
 */
export class LuoguProblemSessionSourceAdapter implements LuoguProblemSessionSource {
  readonly sourceInstance: SourceInstance;
  private readonly account: Account;
  private readonly sessions: LuoguSessionProvider;
  private readonly adapter: LuoguAdapter;
  /** Bound exactly while one call's request runs; see {@link fetchProblem}. */
  private readonly holder: { cookie: string | null; pid: string | null } = { cookie: null, pid: null };
  private active = false;

  constructor(options: LuoguProblemSessionSourceOptions) {
    const operation: PlatformOperation = 'problem';
    if (!options || typeof options !== 'object') {
      throw invalidInput(operation, 'the authenticated problem source requires its options');
    }
    requireLuoguInstance(options.sourceInstance, operation);
    if (!options.sessions || typeof options.sessions.sessionFor !== 'function') {
      throw invalidInput(operation, 'a Luogu session provider exposing sessionFor(account, token) is required');
    }
    this.sourceInstance = options.sourceInstance;
    this.account = options.account;
    this.sessions = options.sessions;
    this.requireScope();
    this.adapter = new LuoguAdapter({
      sourceInstance: this.sourceInstance,
      transport: new HttpTransport({
        origin: LUOGU_BASE_URL,
        minRequestIntervalMs: LUOGU_MIN_REQUEST_INTERVAL_MS,
        platformMinRequestIntervalMs: LUOGU_MIN_REQUEST_INTERVAL_MS,
        requestTimeoutMs: DEFAULT_PLATFORM_LIMITS.requestTimeoutMs,
        maxRetries: DEFAULT_PLATFORM_LIMITS.maxRetries,
        maxResponseBytes: options.maxResponseBytes,
        maxRedirects: options.maxRedirects,
        fetchImpl: createAuthenticatedLuoguProblemFetch({
          cookie: () => this.holder.cookie,
          pid: () => this.holder.pid,
          fetchImpl: options.fetchImpl ?? defaultFetchImpl,
        }),
        clock: options.clock,
        wait: options.wait,
        setTimer: options.setTimer,
      }),
      clock: options.clock,
      // A tag dictionary would need a second, authenticated catalog request; raw tag ids are
      // preserved instead and no dictionary is ever loaded by this reader.
      resolveTagNames: false,
    });
  }

  /**
   * Fetch one problem detail with a fresh session.
   *
   * Everything the caller supplies is validated before the session provider is consulted. The
   * resolved session is reduced to the minimal cookie pair and bound together with the expected
   * canonical pid; both are cleared in a `finally` on every success, error and cancellation path.
   */
  async fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem> {
    const operation: PlatformOperation = 'problem';
    const token = request.token;
    throwIfCancelled(token);
    const uid = this.requireScope();
    const pid = requireProblemRef(request.problemRef, this.sourceInstance.id, operation);
    requireProblemLimits(request.limits, operation);
    throwIfCancelled(token);
    this.beginFetch(operation);
    try {
      const cookie = await this.readCookie(uid, token);
      throwIfCancelled(token);
      this.holder.cookie = cookie;
      this.holder.pid = pid;
      try {
        return await this.readDetail(request, token);
      } finally {
        // The cookie and the expected pid live exactly as long as the call that owns them; the
        // cached adapter and transport (and their pacing state) survive.
        this.holder.cookie = null;
        this.holder.pid = null;
      }
    } finally {
      this.endFetch();
    }
  }

  /**
   * Prove the source instance and the canonical account before any credential work.
   *
   * The account is fixed at construction, but it is re-proven on every call: a caller that mutated
   * the object, or built it for a mirror instance, must never reach the session provider.
   */
  private requireScope(): string {
    const operation: PlatformOperation = 'problem';
    requireLuoguInstance(this.sourceInstance, operation);
    if (!this.account || typeof this.account !== 'object') {
      throw invalidInput(operation, 'a Luogu account is required for the authenticated problem reader');
    }
    try {
      return requireLuoguUid(this.sourceInstance, this.account);
    } catch (cause) {
      // The account rule reports as a submissions failure; this reader reports its own operation,
      // while keeping the fixed, caller-safe sentence of the shared validator.
      if (isPlatformError(cause)) {
        throw new PlatformError({ code: cause.code, operation, retryable: false, detail: cause.detail });
      }
      throw cause;
    }
  }

  /** Claim the single per-source fetch slot; an overlap is refused before the provider is consulted. */
  private beginFetch(operation: PlatformOperation): void {
    if (this.active) {
      throw new PlatformError({
        code: 'unavailable',
        operation,
        retryable: true,
        detail: 'another authenticated problem fetch for this source instance is already running',
      });
    }
    this.active = true;
  }

  private endFetch(): void {
    this.active = false;
  }

  /**
   * Read the session of exactly this account.
   *
   * Anything the injected provider rejects with — including a typed error whose detail or sample
   * quotes the cookie, or a `DomainError` with a secret message — is reconstructed as a fixed
   * sanitized failure; cancellation keeps its `cancelled` discriminant.
   */
  private async readSession(token: CancellationToken): Promise<LuoguSession> {
    throwIfCancelled(token);
    let session: LuoguSession;
    try {
      session = await this.sessions.sessionFor(this.account, token);
    } catch (cause) {
      throwIfCancelled(token);
      sanitizeProblemFailure(cause, 'session');
    }
    throwIfCancelled(token);
    return session;
  }

  /**
   * Resolve and validate the session cookie of this account.
   *
   * {@link requireLuoguSessionCookie} reduces a whole-Cookie value to the canonical
   * `__client_id=…; _uid=…` pair and proves the `_uid` binding; its refusals already carry fixed,
   * cookie-free sentences, and only the operation is restated for this reader.
   */
  private async readCookie(uid: string, token: CancellationToken): Promise<string> {
    const session = await this.readSession(token);
    try {
      return requireLuoguSessionCookie(session, uid);
    } catch (cause) {
      if (isPlatformError(cause)) {
        throw new PlatformError({ code: cause.code, operation: 'problem', retryable: false, detail: cause.detail });
      }
      throw cause;
    }
  }

  /**
   * Fetch the detail through the reusable adapter.
   *
   * Everything the adapter hands back is reconstructed here: a parser message may quote a body, a
   * server-provided `errorType` or a sample, so only the validated code, retry metadata, attempt
   * count and closed reason may survive.
   */
  private async readDetail(request: FetchProblemRequest, token: CancellationToken): Promise<NormalizedProblem> {
    throwIfCancelled(token);
    let problem: NormalizedProblem;
    try {
      problem = await this.adapter.fetchProblem(request);
    } catch (cause) {
      throwIfCancelled(token);
      sanitizeProblemFailure(cause, 'shape');
    }
    throwIfCancelled(token);
    return problem;
  }
}

/** Build the authenticated problem source of one account on one validated Luogu source instance. */
export function createLuoguProblemSessionSource(
  options: LuoguProblemSessionSourceOptions,
): LuoguProblemSessionSourceAdapter {
  return new LuoguProblemSessionSourceAdapter(options);
}
