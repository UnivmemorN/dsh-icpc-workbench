/**
 * Authenticated Luogu submission-history reader (Sprint 17a).
 *
 * ## What this module owns
 *
 * - an `application/LuoguSessionReader` implementation that turns `/record/list` pages into
 *   domain submissions, with a scope-bound resumable cursor and no silent skipping;
 * - a narrowly scoped authenticated transport: {@link createAuthenticatedLuoguFetch} attaches the
 *   session cookie **only** to the internally expected request of the selected account — the exact
 *   official origin, the exact `/record/list` path, exactly one `user=<canonical uid>` parameter
 *   and exactly the page the reader is currently reading. Any other path, an alternate account or
 *   page, an extra query parameter, a fragment or a login redirect is refused *before* dispatch,
 *   so the cookie cannot travel anywhere else. Requests still go through the shared
 *   {@link HttpTransport}, so pacing (>= 2 s between requests, a floor no caller may lower),
 *   timeouts, retries, the streaming body cap, cancellation, `credentials: 'omit'`,
 *   request-header validation and the manual same-origin-only redirect policy are all inherited
 *   unchanged. The anonymous Luogu transport keeps its blanket cookie prohibition; this wrapper is
 *   the single, documented exception;
 * - an injected {@link LuoguSessionProvider} seam. The provider returns a session for exactly the
 *   selected account; the reader validates the account's canonical UID against `session.uid` and
 *   against the **required** `_uid` cookie. `__client_id` is an opaque session identifier, not a
 *   UID: it only has to be present and syntactically safe, and it is never compared with the UID.
 *   Real OS credential storage is Sprint 17b; this module never touches a credential store.
 *
 * ## Secret handling
 *
 * The cookie value is passed to `fetch` as a header and nowhere else. It is never written to a
 * cursor, a returned page, a log line or an error. Every failure crossing an untrusted boundary —
 * the injected session provider, the injected fetch, the response body stream, and the payload
 * parsers (whose `data.errorType` text comes from the server) — is reconstructed from a fixed
 * table that keeps only a validated `code`, a real boolean `retryable` and a normalized
 * `retryAfterMs`; raw `detail`/`message`/`sample`/`cause` never survive, cancellation stays
 * `cancelled` with a fixed message, and a cause with no usable discriminant becomes a fixed
 * `unavailable` that is retryable at the fetch/body-stream boundary and terminal at the
 * credential-provider and payload-shape boundaries. Authenticated reader failures never carry a
 * response sample.
 *
 * ## One owning call per account
 *
 * At most one `listSubmissions` call per account may be in flight: an overlapping same-account
 * call is refused before the credential provider is consulted, and the bound cookie is cleared in
 * a `finally` on every success, error and cancellation path. The cached transport — and therefore
 * the shared pacing state — survives across calls.
 *
 * ## Scan rules
 *
 * - the request URL is built internally from the canonical UID (`/record/list?user=<uid>&page=N`);
 *   a caller cannot point the reader at another account;
 * - `limit` is exact: at most that many rows are returned, sliced across server pages;
 * - `since` is inclusive; the descending order means the first older record ends the window, so
 *   an incremental scan reports `nextCursor: null` only when the window really ended;
 * - a resumed cursor re-reads its page and verifies the account scope, the `since` window, the
 *   declared page size/total, the boundary record and the page identity fingerprint before it
 *   delivers or advances anything. Any mismatch is a typed restart error: an insertion, deletion
 *   or reorder is never turned into a silent skip or a duplicated record;
 * - `status` maps through {@link luoguStatusVerdict}: unknown and pending codes stay `unknown`
 *   and are never accepted. Numeric language ids stay `null`; `time`/`memory` are not imported,
 *   because their units are unverified.
 */
import {
  DEFAULT_PLATFORM_LIMITS,
  type ListSubmissionsRequest,
  type Page,
  type PlatformLimits,
} from '../../application/ports.js';
import type { LuoguSessionReader } from '../../application/luogu-session.js';
import {
  PLATFORM_ERROR_CODES,
  PlatformError,
  isPlatformError,
  type PlatformErrorCode,
  type PlatformOperation,
} from '../../application/platform-errors.js';
import {
  DomainError,
  assertIsoTimestamp,
  createSubmission,
  type Account,
  type CancellationToken,
  type SourceInstance,
  type Submission,
} from '../../domain/index.js';
import {
  HARD_MAX_RETRIES,
  HttpTransport,
  type ClockFn,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
  type HttpLimits,
  type HttpResponse,
  type SetTimerFn,
  type WaitFn,
} from '../platform/http.js';
import { LUOGU_BASE_URL, requireLuoguInstance } from './adapter.js';
import { LUOGU_UID_PATTERN, requireLuoguUid } from './account.js';
import { isHtmlResponse, isJsonRecord } from './parsers.js';
import {
  decodeLuoguRecordCursor,
  encodeLuoguRecordCursor,
  luoguRecordPageFingerprint,
  type LuoguRecordCursor,
  type LuoguRecordCursorScope,
} from './record-cursors.js';
import { luoguStatusVerdict, parseRecordPage, type LuoguRecord, type LuoguRecordPage } from './records.js';

/** Platform floor: authenticated record requests are never issued closer together than this. */
export const LUOGU_MIN_REQUEST_INTERVAL_MS = 2_000;
/** Upper bound of one `listSubmissions` call; larger windows require cursor continuation. */
export const LUOGU_MAX_SUBMISSION_LIMIT = 500;

const RECORD_LIST_PATH = '/record/list';
const LENTILLE_HEADER = 'x-lentille-request';
const LENTILLE_VALUE = 'content-only';
/** Paths that mean "the session is gone" rather than "the shape changed". */
const LOGIN_PATHS: ReadonlySet<string> = new Set(['/auth/login', '/login']);
const MAX_LIMITS_VALUE = 600_000;
const MAX_COOKIE_CHARS = 4_096;
const MAX_CONCURRENCY = 64;
/** Cookie-name token characters (RFC 6265 `token`); a name is never secret material. */
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
/**
 * A syntactically safe opaque `__client_id`: printable, bounded, and free of `;`, `=`, whitespace
 * and control characters, so it can be a cookie value without changing the header's structure.
 * Its *content* is deliberately unconstrained — Luogu's `__client_id` is a session identifier.
 */
const OPAQUE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._~+/:-]{1,256}$/u;
/** Canonical server page number of the internally built `/record/list?user=…&page=N` request. */
const CANONICAL_PAGE_PATTERN = /^[1-9][0-9]{0,6}$/u;
/** Control characters (including CR/LF) may never enter a header value. */
const UNSAFE_HEADER_VALUE = /[\u0000-\u001f\u007f]/u;

/**
 * Fixed, secret-free text for every authenticated failure code.
 *
 * Failures reconstructed from this table can never quote a cookie, a provider detail, a parser
 * message or a response body; callers branch on `code`, never on the text.
 */
const SAFE_FAILURE_DETAILS: Readonly<Record<PlatformErrorCode, string>> = {
  cancelled: 'operation cancelled',
  auth_required: 'the Luogu session is no longer valid',
  forbidden: 'Luogu refused the authenticated request',
  rate_limited: 'Luogu rate-limited the authenticated request',
  unavailable: 'the authenticated Luogu request failed',
  changed_response: 'Luogu answered an unexpected authenticated response',
  invalid_input: 'the authenticated Luogu request was rejected',
};

/** Runtime allowlist of the codes a sanitized failure may carry; see {@link isKnownFailureCode}. */
const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set<string>(PLATFORM_ERROR_CODES);

/**
 * One authenticated Luogu session, owned by the adapter seam.
 *
 * `uid` is the account the session belongs to; `cookie` is the raw `Cookie` header value.
 * Neither field is ever surfaced by the reader.
 */
export interface LuoguSession {
  /** Canonical Luogu UID this session authenticates. */
  readonly uid: string;
  /** Raw `Cookie` header value; never logged, echoed, persisted in a cursor or put in an error. */
  readonly cookie: string;
}

/**
 * Injected credential seam: resolve the session of exactly `account`.
 *
 * Sprint 17b implements this over Windows Credential Manager (or an equivalent OS-protected
 * store) with an injectable test backend. Implementations must resolve the session for the
 * account they are given and must not return a session belonging to anyone else; the reader
 * verifies that independently.
 */
export interface LuoguSessionProvider {
  sessionFor(account: Account, token: CancellationToken): Promise<LuoguSession>;
}

export interface LuoguSessionReaderOptions {
  readonly sourceInstance: SourceInstance;
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

function invalidInput(operation: PlatformOperation, detail: string): PlatformError {
  return new PlatformError({ code: 'invalid_input', operation, retryable: false, detail });
}

function driftError(detail: string): PlatformError {
  return new PlatformError({
    code: 'changed_response',
    operation: 'submissions',
    retryable: false,
    detail: `${detail}; restart the submission listing`,
  });
}

/** Fixed cancellation error: a cancelled call never surfaces a provider or caller message. */
function cancelledFailure(): DomainError {
  return new DomainError('cancelled', SAFE_FAILURE_DETAILS.cancelled);
}

/** Cancellation with a fixed message, so a caller-supplied reason is never echoed either. */
function throwIfCancelled(token: CancellationToken): void {
  if (token.cancelled) {
    throw cancelledFailure();
  }
}

/**
 * Which untrusted boundary a cause crossed; it decides the retry metadata of an unknown failure.
 *
 * `transport` (the injected fetch and the response body stream) covers real network failures: a
 * `TypeError` or a mid-body disconnect is transient, so it stays eligible for the configured retry
 * budget and for automatic sync backoff. `session` (the credential provider) and `shape` (the
 * payload parser) are not transient IO, so an unrecognized one is terminal — automatic sync never
 * retries a broken credential seam or a changed envelope.
 */
type UnknownFailureBoundary = 'transport' | 'session' | 'shape';

/** True only for a code the shared error contract defines; anything else is a forged discriminant. */
function isKnownFailureCode(value: unknown): value is PlatformErrorCode {
  return typeof value === 'string' && KNOWN_FAILURE_CODES.has(value);
}

/** Keep only a normalized finite non-negative delay; a forged string, `NaN` or a negative is `null`. */
function normalizeRetryAfterMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * Fixed failure for a cause that carries no usable discriminant.
 *
 * The text is the shared `unavailable` wording and only a normalized finite non-negative
 * `retryAfterMs` may survive; the retryable flag follows the boundary, never the untrusted cause.
 */
function unknownFailure(
  operation: PlatformOperation,
  boundary: UnknownFailureBoundary,
  retryAfterMs: unknown = null,
): PlatformError {
  return new PlatformError({
    code: 'unavailable',
    operation,
    retryable: boundary === 'transport',
    retryAfterMs: normalizeRetryAfterMs(retryAfterMs),
    detail: SAFE_FAILURE_DETAILS.unavailable,
  });
}

/**
 * Rebuild any failure that crosses an untrusted boundary as a fixed sanitized error.
 *
 * Inputs whose text cannot be trusted: the injected session provider, the injected fetch, the
 * response body stream and the payload parsers (which can echo a server-provided `errorType`).
 * `PlatformError` validates neither `code` nor `retryable` at runtime, and an injected boundary can
 * cast a forged object into one, so a typed cause is only rebuilt when its `code` is one of the
 * shared {@link PLATFORM_ERROR_CODES} **and** its `retryable` is a real boolean; only then do that
 * code, flag and normalized `retryAfterMs` survive. `detail`, `message`, `sample`, `attempts` and
 * `cause` never do. Cancellation keeps its discriminant and becomes a `cancelled`
 * {@link DomainError} with the fixed message above; every unusable cause becomes the fixed
 * {@link unknownFailure} of its boundary — retryable for the fetch/body-stream boundary, terminal
 * for the credential-provider and payload-shape boundaries.
 */
function sanitizeAuthenticatedFailure(
  cause: unknown,
  operation: PlatformOperation,
  boundary: UnknownFailureBoundary,
): never {
  if (isPlatformError(cause)) {
    const typed = cause as { readonly code?: unknown; readonly retryable?: unknown; readonly retryAfterMs?: unknown };
    if (isKnownFailureCode(typed.code) && typeof typed.retryable === 'boolean') {
      if (typed.code === 'cancelled') {
        throw cancelledFailure();
      }
      throw new PlatformError({
        code: typed.code,
        operation,
        retryable: typed.retryable,
        retryAfterMs: normalizeRetryAfterMs(typed.retryAfterMs),
        detail: SAFE_FAILURE_DETAILS[typed.code],
      });
    }
    throw unknownFailure(operation, boundary, typed.retryAfterMs);
  }
  if (cause instanceof DomainError && cause.code === 'cancelled') {
    throw cancelledFailure();
  }
  throw unknownFailure(operation, boundary);
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

/** Validate every caller limit before it reaches the transport; invalid values are never defaulted. */
function resolvePlatformLimits(limits: PlatformLimits, operation: PlatformOperation): Partial<HttpLimits> {
  if (!isJsonRecord(limits)) {
    throw invalidInput(operation, 'platform limits are required');
  }
  requireLimitInteger(limits.pageSize, 'limits.pageSize', operation, 1, LUOGU_MAX_SUBMISSION_LIMIT);
  requireLimitInteger(limits.maxConcurrency, 'limits.maxConcurrency', operation, 1, MAX_CONCURRENCY);
  return {
    minRequestIntervalMs: requireLimitInteger(
      limits.minRequestIntervalMs,
      'limits.minRequestIntervalMs',
      operation,
      0,
      MAX_LIMITS_VALUE,
    ),
    requestTimeoutMs: requireLimitInteger(
      limits.requestTimeoutMs,
      'limits.requestTimeoutMs',
      operation,
      1,
      MAX_LIMITS_VALUE,
    ),
    maxRetries: requireLimitInteger(limits.maxRetries, 'limits.maxRetries', operation, 0, HARD_MAX_RETRIES),
  };
}

/** Exact row limit of one call, bounded by the adapter cap and the configured page size. */
function resolveRowLimit(limit: number, limits: PlatformLimits, operation: PlatformOperation): number {
  const value = requireLimitInteger(limit, 'limit', operation, 1, LUOGU_MAX_SUBMISSION_LIMIT);
  if (value > limits.pageSize) {
    throw invalidInput(operation, `limit ${value} exceeds the configured pageSize ${limits.pageSize}`);
  }
  return value;
}

/** Normalize the inclusive lower bound; a value that is not a timestamp is refused, never dropped. */
function normalizeSince(value: string | null | undefined, operation: PlatformOperation): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidInput(operation, 'since must be an ISO timestamp or null');
  }
  try {
    return assertIsoTimestamp('since', value);
  } catch (cause) {
    throw invalidInput(
      operation,
      `since must be a parseable ISO timestamp (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
}

/**
 * Parse a raw `Cookie` header value into a name→value map.
 *
 * Strict by design: every non-empty segment must be `name=value` with a valid cookie-name token,
 * and a repeated name is refused as ambiguous — a header that names `_uid` or `__client_id` twice
 * must not let either value silently win. Every failure names no cookie *value*.
 */
function parseCookieHeader(cookie: string): Map<string, string> {
  const operation: PlatformOperation = 'submissions';
  const parsed = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const segment = part.trim();
    if (segment.length === 0) {
      continue;
    }
    const separator = segment.indexOf('=');
    if (separator <= 0) {
      throw invalidInput(operation, 'the Luogu session cookie header is malformed');
    }
    const name = segment.slice(0, separator).trim();
    if (!COOKIE_NAME_PATTERN.test(name)) {
      throw invalidInput(operation, 'the Luogu session cookie header has an invalid cookie name');
    }
    if (parsed.has(name)) {
      throw invalidInput(operation, `the Luogu session cookie header repeats ${name}`);
    }
    parsed.set(name, segment.slice(separator + 1).trim());
  }
  return parsed;
}

/**
 * Validate an injected session against the selected account and return its cookie header value.
 *
 * `__client_id` is Luogu's **opaque session identifier**, not a UID. It is required to be present,
 * non-empty and syntactically safe, and it is deliberately never compared with the account UID:
 * doing so would reject valid sessions and pretend to prove an account binding it cannot prove.
 * The account binding comes from the required `_uid` cookie, which must be the canonical UID of
 * both the selected account and `session.uid`.
 *
 * Refused: no session at all, an account UID that is not canonical, a session UID that is not that
 * UID, a missing or oversized cookie, a cookie containing control characters or surrounding
 * whitespace (header injection), a malformed or ambiguous cookie header (a segment without `=`,
 * an invalid name, a repeated name), a missing/empty/unusable `__client_id`, and a missing, empty
 * or foreign `_uid`. Every failure is an `invalid_input` whose detail names no cookie value.
 */
export function requireLuoguSessionCookie(
  session: LuoguSession | null | undefined,
  expectedUid: string,
): string {
  const operation: PlatformOperation = 'submissions';
  if (typeof expectedUid !== 'string' || !LUOGU_UID_PATTERN.test(expectedUid)) {
    throw invalidInput(operation, 'the requested account UID is not canonical');
  }
  if (!session || typeof session !== 'object') {
    throw invalidInput(operation, 'the Luogu session provider returned no session');
  }
  const sessionUid = typeof session.uid === 'string' ? session.uid.trim() : '';
  if (sessionUid !== expectedUid) {
    throw invalidInput(operation, 'the Luogu session belongs to another account');
  }
  const cookie = typeof session.cookie === 'string' ? session.cookie : '';
  if (
    cookie.length === 0 ||
    cookie.length > MAX_COOKIE_CHARS ||
    cookie !== cookie.trim() ||
    UNSAFE_HEADER_VALUE.test(cookie)
  ) {
    throw invalidInput(operation, 'the Luogu session carries no usable cookie header value');
  }
  const values = parseCookieHeader(cookie);
  const clientId = values.get('__client_id');
  if (clientId === undefined || clientId.length === 0) {
    throw invalidInput(operation, 'the Luogu session cookie carries no __client_id');
  }
  if (!OPAQUE_CLIENT_ID_PATTERN.test(clientId)) {
    throw invalidInput(operation, 'the Luogu session cookie __client_id is not a syntactically safe opaque value');
  }
  const uidCookie = values.get('_uid');
  if (uidCookie === undefined || uidCookie.length === 0) {
    throw invalidInput(operation, 'the Luogu session cookie carries no _uid');
  }
  if (uidCookie !== expectedUid) {
    throw invalidInput(operation, 'the Luogu session cookie uid does not match the selected account');
  }
  return cookie;
}

const defaultFetchImpl: FetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return { status: response.status, headers: response.headers, body: response.body };
};

/**
 * Refuse any target that is not the internally expected authenticated record request.
 *
 * The cookie may travel to exactly one endpoint shape: the official HTTPS origin, the
 * `/record/list` path, exactly one `user` parameter equal to the canonical UID of the account this
 * transport serves, exactly one canonical `page` parameter equal to the page the owning reader
 * call is reading, no other parameter and no fragment. A login path means the session is gone
 * (`auth_required`) and is refused before any cookie could be attached to it; every other
 * deviation is an `unavailable` refusal. No failure echoes the query string, because the query
 * carries the account identity.
 */
function assertExpectedRecordTarget(url: string, expectedUid: string, expectedPage: number): void {
  const operation: PlatformOperation = 'submissions';
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
  if (parsed.pathname !== RECORD_LIST_PATH) {
    throw new PlatformError({
      code: 'unavailable',
      operation,
      retryable: false,
      detail: 'refusing to attach a Luogu session outside the expected record endpoint',
    });
  }
  const users = parsed.searchParams.getAll('user');
  const pages = parsed.searchParams.getAll('page');
  const extra = [...parsed.searchParams.keys()].filter((name) => name !== 'user' && name !== 'page');
  if (
    parsed.hash.length > 0 ||
    users.length !== 1 ||
    pages.length !== 1 ||
    users[0] !== expectedUid ||
    pages[0] !== String(expectedPage) ||
    !CANONICAL_PAGE_PATTERN.test(pages[0] ?? '') ||
    extra.length > 0
  ) {
    throw new PlatformError({
      code: 'unavailable',
      operation,
      retryable: false,
      detail: 'refusing an authenticated request that is not the expected record page of this account',
    });
  }
}

/**
 * Forward a response, replacing any failure of its body stream with a fixed sanitized error.
 *
 * The shared transport maps a non-typed body-read failure to `network failure: <message>`; that
 * message comes from the injected stream and may quote anything, including the cookie, so the
 * stream is wrapped here — at the authenticated boundary — instead of reaching the transport's
 * error mapping.
 */
function withSanitizedBody(response: FetchResponseLike, operation: PlatformOperation): FetchResponseLike {
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
              sanitizeAuthenticatedFailure(cause, operation, 'transport');
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

export interface AuthenticatedLuoguFetchOptions {
  /** Returns the currently bound session cookie, or `null` when no session is bound. */
  readonly cookie: () => string | null;
  /** Canonical UID of the account this transport serves; a request may address only this account. */
  readonly expectedUid: string;
  /** Page the owning reader call is currently reading; `null` when no call owns the transport. */
  readonly expectedPage: () => number | null;
  /** Underlying fetch; every call it receives already carries a validated cookie header. */
  readonly fetchImpl: FetchLike;
}

/**
 * Wrap a fetch implementation so it attaches the bound session cookie.
 *
 * This is the single place a Luogu credential becomes an outgoing header. Properties the tests pin
 * down: the cookie is attached only to the internally expected record page of one account (any
 * other origin, path, account, page, extra parameter or fragment is refused before dispatch, and a
 * login redirect becomes `auth_required` without a request being sent to it); a caller-supplied
 * `cookie` header is refused instead of merged; every failure from the underlying fetch — whose
 * message or typed detail may contain anything, including the cookie — is reconstructed with only
 * the validated code and retry metadata; `HttpTransport` still owns pacing, cancellation, timeout,
 * the byte cap and the same-origin-only manual redirect policy, so a cross-origin redirect target
 * is never fetched at all.
 */
export function createAuthenticatedLuoguFetch(options: AuthenticatedLuoguFetchOptions): FetchLike {
  const operation: PlatformOperation = 'submissions';
  if (typeof options.expectedUid !== 'string' || !LUOGU_UID_PATTERN.test(options.expectedUid)) {
    throw invalidInput(operation, 'the authenticated transport requires the canonical UID of one account');
  }
  const expectedUid = options.expectedUid;
  return async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    const cookie = options.cookie();
    if (typeof cookie !== 'string' || cookie.length === 0) {
      throw invalidInput(operation, 'no Luogu session is bound to this transport');
    }
    const page = options.expectedPage();
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
      throw invalidInput(operation, 'no record page is currently bound to this transport');
    }
    assertExpectedRecordTarget(url, expectedUid, page);
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
      sanitizeAuthenticatedFailure(cause, operation, 'transport');
    }
    return withSanitizedBody(response, operation);
  };
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

interface SessionHolder {
  cookie: string | null;
  /** Page number the owning scan is currently reading; set only while its request is in flight. */
  page: number | null;
}

interface AccountTransport {
  readonly transport: HttpTransport;
  readonly holder: SessionHolder;
}

/**
 * Authenticated Luogu submission reader.
 *
 * One transport is cached per account, so pacing is shared by every page request of that account
 * across calls; the session cookie is resolved from the provider on each call, bound for exactly
 * the duration of that call and read by the transport wrapper at request time. At most one call
 * per account may be in flight — an overlapping same-account call is refused before the provider
 * is consulted — so two calls can never swap or clear each other's cookie. The account is
 * validated before any request, the session is validated before the transport can carry it, and
 * every await is followed by a cancellation check on the caller's token.
 */
export class LuoguSessionReaderAdapter implements LuoguSessionReader {
  readonly sourceInstance: SourceInstance;
  private readonly sessions: LuoguSessionProvider;
  private readonly fetchImpl: FetchLike;
  private readonly clock: ClockFn;
  private readonly maxResponseBytes: number | undefined;
  private readonly maxRedirects: number | undefined;
  private readonly transportOptions: {
    readonly clock: ClockFn | undefined;
    readonly wait: WaitFn | undefined;
    readonly setTimer: SetTimerFn | undefined;
  };
  private readonly transports = new Map<string, AccountTransport>();
  /** Accounts whose owning scan is currently in flight; see {@link beginAccountScan}. */
  private readonly activeAccounts = new Set<string>();

  constructor(options: LuoguSessionReaderOptions) {
    requireLuoguInstance(options.sourceInstance, 'submissions');
    if (!options.sessions || typeof options.sessions.sessionFor !== 'function') {
      throw invalidInput('submissions', 'a Luogu session provider exposing sessionFor(account, token) is required');
    }
    this.sourceInstance = options.sourceInstance;
    this.sessions = options.sessions;
    this.fetchImpl = options.fetchImpl ?? defaultFetchImpl;
    this.clock = options.clock ?? (() => Date.now());
    this.maxResponseBytes = options.maxResponseBytes;
    this.maxRedirects = options.maxRedirects;
    this.transportOptions = { clock: options.clock, wait: options.wait, setTimer: options.setTimer };
  }

  /**
   * One page of authenticated submission history.
   *
   * Resolves with at most `limit` submissions of the requested account, all at or after `since`,
   * plus the continuation cursor (or `null` when the window is exhausted). Every failure — invalid
   * input, a foreign session, drift, an authentication wall, a challenge page, a rate limit, a
   * timeout or an oversized body — rejects with a typed {@link PlatformError}; a failure never
   * becomes an empty page.
   */
  async listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>> {
    const operation: PlatformOperation = 'submissions';
    const token = request.token;
    throwIfCancelled(token);
    requireLuoguInstance(this.sourceInstance, operation);
    const http = resolvePlatformLimits(request.limits, operation);
    const limit = resolveRowLimit(request.limit, request.limits, operation);
    const account: Account = request.account;
    if (!account || typeof account !== 'object') {
      throw invalidInput(operation, 'a Luogu account is required for submission history');
    }
    const uid = requireLuoguUid(this.sourceInstance, account);
    const since = normalizeSince(request.since, operation);
    const scope: LuoguRecordCursorScope = {
      sourceInstanceId: this.sourceInstance.id,
      accountId: account.id,
      handle: uid,
      since,
    };
    const cursor =
      request.cursor === null || request.cursor === undefined
        ? null
        : decodeLuoguRecordCursor(request.cursor, scope);
    throwIfCancelled(token);

    this.beginAccountScan(account.id, operation);
    try {
      const cookie = requireLuoguSessionCookie(await this.readSession(account, token), uid);
      throwIfCancelled(token);
      const bound = this.transportFor(account.id, uid);
      bound.holder.cookie = cookie;
      try {
        return await this.scan(account, uid, since, cursor, limit, http, token, bound);
      } finally {
        // The cookie lives exactly as long as the call that owns it, on every success, error and
        // cancellation path; the cached transport (and its pacing state) survives.
        bound.holder.cookie = null;
        bound.holder.page = null;
      }
    } finally {
      this.endAccountScan(account.id);
    }
  }

  /** The paging body of one owning call; the caller validated the scope and bound the session. */
  private async scan(
    account: Account,
    uid: string,
    since: string | null,
    cursor: LuoguRecordCursor | null,
    limit: number,
    http: Partial<HttpLimits>,
    token: CancellationToken,
    bound: AccountTransport,
  ): Promise<Page<Submission>> {
    const items: Submission[] = [];
    let page: number;
    let offset: number;
    let delivered: number;
    let perPage: number | null;
    let count: number | null;
    let parsed: LuoguRecordPage;
    let fingerprint: string;
    if (cursor === null) {
      page = 1;
      offset = 0;
      delivered = 0;
      parsed = await this.readPage(1, uid, token, http, bound);
      perPage = parsed.perPage;
      count = parsed.count;
      fingerprint = luoguRecordPageFingerprint(1, parsed);
    } else {
      page = cursor.page;
      offset = cursor.offset;
      delivered = cursor.delivered;
      perPage = cursor.perPage;
      count = cursor.count;
      parsed = await this.readPage(page, uid, token, http, bound);
      const declared = this.reconcileDeclared({ perPage, count }, parsed, page);
      perPage = declared.perPage;
      count = declared.count;
      if (luoguRecordPageFingerprint(page, parsed) !== cursor.pageFingerprint) {
        throw driftError(`the content of server page ${page} changed`);
      }
      if (offset > parsed.records.length) {
        throw driftError(`the cursor offset ${offset} lies past the end of server page ${page}`);
      }
      if (offset > 0 && parsed.records[offset - 1]?.id !== cursor.boundaryId) {
        throw driftError('the cursor boundary record moved');
      }
      fingerprint = cursor.pageFingerprint;
    }

    const sinceMs = since === null ? null : Date.parse(since);
    let complete = false;
    for (;;) {
      throwIfCancelled(token);
      this.assertPosition({ page, offset, delivered, perPage, count, parsed });
      const records = parsed.records;
      let outOfWindow = false;
      while (offset < records.length) {
        if (items.length >= limit) {
          break;
        }
        const record = records[offset]!;
        // The list is newest-first, so the first record older than the inclusive bound ends the
        // requested window: everything after it is older too.
        if (sinceMs !== null && record.submitTimeSeconds * 1000 < sinceMs) {
          outOfWindow = true;
          break;
        }
        items.push(this.toSubmission(record, account.id));
        offset += 1;
        delivered += 1;
      }
      if (outOfWindow) {
        complete = true;
        break;
      }
      if (offset >= records.length) {
        // A short page is the last page when the server declared its page size; a declared total
        // that has been reached ends the scan even without one. `count` is never used to skip a
        // page whose content was not read.
        if (perPage !== null && records.length < perPage) {
          complete = true;
          break;
        }
        if (count !== null && delivered >= count) {
          complete = true;
          break;
        }
      }
      if (items.length >= limit) {
        break;
      }
      const previousRecord = records[records.length - 1];
      const next = await this.readPage(page + 1, uid, token, http, bound);
      throwIfCancelled(token);
      const declared = this.reconcileDeclared({ perPage, count }, next, page + 1);
      perPage = declared.perPage;
      count = declared.count;
      if (next.records.length === 0) {
        if (count !== null && delivered < count) {
          throw driftError(
            `server page ${page + 1} is empty but the declared total ${count} says more records exist`,
          );
        }
        complete = true;
        break;
      }
      // Continuity across the page boundary: the next page must continue strictly older. A new
      // insertion shifts the boundary, which is a safe restart instead of a duplicate delivery.
      if (previousRecord !== undefined && Number(next.records[0]!.id) >= Number(previousRecord.id)) {
        throw driftError(`server page ${page + 1} does not continue after record ${previousRecord.id}`);
      }
      page += 1;
      offset = 0;
      parsed = next;
      fingerprint = luoguRecordPageFingerprint(page, next);
    }

    throwIfCancelled(token);
    const nextCursor = complete
      ? null
      : encodeLuoguRecordCursor({
          sourceInstanceId: this.sourceInstance.id,
          accountId: account.id,
          handle: uid,
          since,
          page,
          offset,
          perPage,
          count,
          delivered,
          boundaryId: offset === 0 ? null : parsed.records[offset - 1]!.id,
          pageFingerprint: fingerprint,
        });
    return { items, nextCursor, fetchedAt: this.nowIso() };
  }

  /**
   * Read the session of exactly this account.
   *
   * Anything the injected provider rejects with — including a typed error whose detail or sample
   * quotes the cookie, or a `DomainError` with a secret message — is reconstructed as a fixed
   * sanitized failure; cancellation keeps its `cancelled` discriminant.
   */
  private async readSession(account: Account, token: CancellationToken): Promise<LuoguSession> {
    throwIfCancelled(token);
    let session: LuoguSession;
    try {
      session = await this.sessions.sessionFor(account, token);
    } catch (cause) {
      throwIfCancelled(token);
      sanitizeAuthenticatedFailure(cause, 'submissions', 'session');
    }
    throwIfCancelled(token);
    return session;
  }

  /**
   * Claim the single per-account scan slot.
   *
   * An overlapping same-account call is refused *before* the credential provider is consulted, so
   * two calls can never swap or clear each other's cookie. The scheduler serializes platform jobs
   * too; this guard makes the adapter safe on its own.
   */
  private beginAccountScan(accountId: string, operation: PlatformOperation): void {
    if (this.activeAccounts.has(accountId)) {
      throw new PlatformError({
        code: 'unavailable',
        operation,
        retryable: true,
        detail: 'another authenticated scan for this account is already running',
      });
    }
    this.activeAccounts.add(accountId);
  }

  /** Release the per-account scan slot; the owning call's `finally` guarantees this runs. */
  private endAccountScan(accountId: string): void {
    this.activeAccounts.delete(accountId);
  }

  /** One transport per account so pacing is shared across calls; the holder carries its session. */
  private transportFor(accountId: string, uid: string): AccountTransport {
    const existing = this.transports.get(accountId);
    if (existing !== undefined) {
      return existing;
    }
    const holder: SessionHolder = { cookie: null, page: null };
    const transport = new HttpTransport({
      origin: LUOGU_BASE_URL,
      minRequestIntervalMs: LUOGU_MIN_REQUEST_INTERVAL_MS,
      platformMinRequestIntervalMs: LUOGU_MIN_REQUEST_INTERVAL_MS,
      requestTimeoutMs: DEFAULT_PLATFORM_LIMITS.requestTimeoutMs,
      maxRetries: DEFAULT_PLATFORM_LIMITS.maxRetries,
      maxResponseBytes: this.maxResponseBytes,
      maxRedirects: this.maxRedirects,
      fetchImpl: createAuthenticatedLuoguFetch({
        cookie: () => holder.cookie,
        expectedUid: uid,
        expectedPage: () => holder.page,
        fetchImpl: this.fetchImpl,
      }),
      clock: this.transportOptions.clock,
      wait: this.transportOptions.wait,
      setTimer: this.transportOptions.setTimer,
    });
    const created: AccountTransport = { transport, holder };
    this.transports.set(accountId, created);
    return created;
  }

  /**
   * Dispatch one page request and unbind the page afterwards.
   *
   * Everything the shared transport (fed by an injected fetch) hands back is reconstructed here:
   * a body-read failure message may quote the cookie and a redirect failure may carry a sample, so
   * only the validated code and retry metadata may survive.
   */
  private async requestRecordPage(
    pageNumber: number,
    uid: string,
    token: CancellationToken,
    http: Partial<HttpLimits>,
    bound: AccountTransport,
  ): Promise<HttpResponse> {
    throwIfCancelled(token);
    // The target guard reads this holder, so every dispatch — a redirect hop included — is bound
    // to exactly the page this call requested.
    bound.holder.page = pageNumber;
    try {
      return await bound.transport.request(
        `${RECORD_LIST_PATH}?user=${encodeURIComponent(uid)}&page=${pageNumber}`,
        {
          token,
          operation: 'submissions',
          headers: { [LENTILLE_HEADER]: LENTILLE_VALUE },
          limits: http,
        },
      );
    } catch (cause) {
      sanitizeAuthenticatedFailure(cause, 'submissions', 'transport');
    } finally {
      bound.holder.page = null;
    }
  }

  /** One `/record/list` page: authenticated, typed, sample-free and cancellation-checked. */
  private async readPage(
    pageNumber: number,
    uid: string,
    token: CancellationToken,
    http: Partial<HttpLimits>,
    bound: AccountTransport,
  ): Promise<LuoguRecordPage> {
    const response = await this.requestRecordPage(pageNumber, uid, token, http, bound);
    throwIfCancelled(token);
    if (isHtmlResponse(response.headers['content-type'] ?? null, response.body)) {
      const path = pathOf(response.url);
      if (path !== null && LOGIN_PATHS.has(path)) {
        throw new PlatformError({
          code: 'auth_required',
          operation: 'submissions',
          retryable: false,
          detail: `the Luogu session is no longer valid: page ${pageNumber} was answered by the login page`,
        });
      }
      throw new PlatformError({
        code: 'changed_response',
        operation: 'submissions',
        retryable: false,
        detail: `Luogu answered an HTML page instead of record JSON for page ${pageNumber}`,
      });
    }
    const parsed = this.jsonRoot(response.body, pageNumber);
    throwIfCancelled(token);
    try {
      return parseRecordPage(parsed, uid, 'submissions');
    } catch (cause) {
      // Parser details can quote server-provided text (`data.errorType`), so the failure is
      // rebuilt as a fixed sanitized one, keeping only its validated code and retry metadata.
      sanitizeAuthenticatedFailure(cause, 'submissions', 'shape');
    }
  }

  /**
   * Parse the JSON envelope without echoing the body.
   *
   * The parser's own message can quote part of the input, so it is deliberately dropped: an
   * authenticated payload never becomes a `changed_response` sample.
   */
  private jsonRoot(body: string, pageNumber: number): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new PlatformError({
        code: 'changed_response',
        operation: 'submissions',
        retryable: false,
        detail: `the record page ${pageNumber} is not valid JSON`,
      });
    }
    if (!isJsonRecord(parsed)) {
      throw new PlatformError({
        code: 'changed_response',
        operation: 'submissions',
        retryable: false,
        detail: `the record page ${pageNumber} is not a JSON object`,
      });
    }
    return parsed;
  }

  /** Merge a page's declared pagination metadata with what the scan already knows. */
  private reconcileDeclared(
    known: { readonly perPage: number | null; readonly count: number | null },
    parsed: LuoguRecordPage,
    pageNumber: number,
  ): { readonly perPage: number | null; readonly count: number | null } {
    if (known.perPage !== null && parsed.perPage !== null && known.perPage !== parsed.perPage) {
      throw driftError(`the server page size changed from ${known.perPage} to ${parsed.perPage} at page ${pageNumber}`);
    }
    if (known.count !== null && parsed.count !== null && known.count !== parsed.count) {
      throw driftError(`the declared record total changed from ${known.count} to ${parsed.count} at page ${pageNumber}`);
    }
    return { perPage: known.perPage ?? parsed.perPage, count: known.count ?? parsed.count };
  }

  /**
   * Structural checks of one position against the pagination metadata it was read with.
   *
   * A non-final page that answers fewer records than the declared total requires would silently
   * skip records, so it is refused; a page that answers more than the declared total allows is
   * refused as well. The `delivered` counter must match the server position, so a cursor can never
   * be advanced by a number of records that was not actually returned.
   */
  private assertPosition(args: {
    readonly page: number;
    readonly offset: number;
    readonly delivered: number;
    readonly perPage: number | null;
    readonly count: number | null;
    readonly parsed: LuoguRecordPage;
  }): void {
    const { page, offset, delivered, perPage, count, parsed } = args;
    if (offset > parsed.records.length) {
      throw driftError(`the position ${offset} lies past the end of server page ${page}`);
    }
    if (perPage !== null) {
      if (parsed.records.length > perPage) {
        throw driftError(
          `server page ${page} answered ${parsed.records.length} records but the declared page size is ${perPage}`,
        );
      }
      if ((page - 1) * perPage + offset !== delivered) {
        throw driftError('the delivered count does not match the server page position');
      }
      if (count !== null) {
        const pageStart = (page - 1) * perPage;
        const expected = Math.min(perPage, Math.max(0, count - pageStart));
        if (parsed.records.length !== expected) {
          throw driftError(
            `server page ${page} answered ${parsed.records.length} records but the declared total ${count} requires ${expected}`,
          );
        }
      }
      return;
    }
    if (count !== null && delivered + parsed.records.length > count) {
      throw driftError(`server page ${page} answers more records than the declared total ${count}`);
    }
  }

  /** One validated record as a domain submission of this account. */
  private toSubmission(record: LuoguRecord, accountId: string): Submission {
    return createSubmission({
      accountId,
      ref: { sourceInstanceId: this.sourceInstance.id, domain: null, externalKey: record.pid },
      externalId: record.id,
      verdict: luoguStatusVerdict(record.status),
      submittedAt: record.submittedAt,
      language: record.language,
    });
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }
}

/** Build the authenticated Luogu submission reader for one validated source instance. */
export function createLuoguSessionReader(options: LuoguSessionReaderOptions): LuoguSessionReaderAdapter {
  return new LuoguSessionReaderAdapter(options);
}
