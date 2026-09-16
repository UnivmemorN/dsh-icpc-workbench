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
 *   against the **required** `_uid` cookie, and normalizes whatever the provider holds (a minimal
 *   pair, a stored legacy whole-Cookie value, an optional `Cookie:` prefix) to the canonical
 *   `__client_id=…; _uid=…` pair through the pure domain rule, so unrelated cookies never travel.
 *   `__client_id` is an opaque session identifier, not a UID: it only has to be present and
 *   syntactically safe, and it is never compared with the UID. Real OS credential storage is Sprint
 *   17b; this module never touches a credential store.
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
  type EditorialFetchResult,
  type ListSubmissionsRequest,
  type Page,
  type PlatformLimits,
} from '../../application/ports.js';
import type { LuoguSessionReader } from '../../application/luogu-session.js';
import type { LuoguEditorialRequest } from '../../application/luogu-session.js';
import {
  PLATFORM_ERROR_CODES,
  PlatformError,
  editorialFailureFromPlatformError,
  isPlatformError,
  type PlatformErrorCode,
  type PlatformOperation,
} from '../../application/platform-errors.js';
import {
  DomainError,
  assertIsoTimestamp,
  createSubmission,
  normalizeLuoguSessionCookie,
  type Account,
  type CancellationToken,
  type LuoguCookieProblem,
  type ProblemRef,
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
import { LUOGU_BASE_URL, isLuoguLoginPath, requireLuoguInstance } from './adapter.js';
import { LUOGU_UID_PATTERN, requireLuoguUid } from './account.js';
import { isHtmlResponse, isJsonRecord } from './parsers.js';
import {
  buildEditorialMaterial,
  lentilleContextPayload,
  parseLuoguEditorialPage,
  type LuoguEditorialFailureKind,
  type LuoguEditorialPage,
  type ObservedSolution,
} from './editorial-parser.js';
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
/**
 * Fixed page ceiling of one editorial read.
 *
 * Every page is one authenticated request, so this bounds one read to a fixed number of requests. The
 * observed P1001 answer needs six pages (`count` 56 at `perPage` 10) and no other observed answer needs
 * more; a declared total that requires more pages is refused **whole** — the first page is read, then
 * the read fails as `changed_response` — instead of returning a partial list of write-ups.
 */
export const LUOGU_MAX_EDITORIAL_PAGES = 20;
/** Upper bound of the write-ups one editorial read will materialize; beyond it the read fails whole. */
export const LUOGU_MAX_EDITORIAL_SOLUTIONS = 1_000;
/** Upper bound of the retrieved body characters one editorial read will materialize. */
export const LUOGU_MAX_EDITORIAL_CONTENT_CHARS = 4_000_000;

const RECORD_LIST_PATH = '/record/list';
/** The authenticated solution surface this reader addresses by problem id (Sprint 33C). */
const SOLUTION_PATH_PREFIX = '/problem/solution/';
const LENTILLE_HEADER = 'x-lentille-request';
const LENTILLE_VALUE = 'content-only';
const MAX_LIMITS_VALUE = 600_000;
const MAX_CONCURRENCY = 64;
/** Canonical server page number of the internally built `/record/list?user=…&page=N` request. */
const CANONICAL_PAGE_PATTERN = /^[1-9][0-9]{0,6}$/u;

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
  /**
   * Session cookie text of this one call: a minimal pair, a stored legacy whole-Cookie value or an
   * optional `Cookie:` header line. The reader normalizes it to the canonical two-cookie pair before
   * it can travel; it is never logged, echoed, persisted in a cursor or put in an error.
   */
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
/**
 * Stable operational code of one unreadable editorial payload.
 *
 * The mapping is total and closed, so a payload this build cannot read always becomes a code the
 * caller already understands — and never `absent`. A `404` is `unavailable` (the observed capture
 * says so explicitly), the authentication wall and a refusal keep their own codes, and every
 * structural defect is `changed_response`.
 */
const EDITORIAL_FAILURE_CODES: Readonly<Record<LuoguEditorialFailureKind, PlatformErrorCode>> = {
  not_an_object: 'changed_response',
  envelope_unreadable: 'changed_response',
  envelope_status: 'changed_response',
  no_solutions_block: 'changed_response',
  solutions_unreadable: 'changed_response',
  count_unreadable: 'changed_response',
  per_page_unreadable: 'changed_response',
  count_result_mismatch: 'changed_response',
  no_problem_block: 'changed_response',
  problem_pid_mismatch: 'changed_response',
  item_unreadable: 'changed_response',
  lid_unreadable: 'changed_response',
  content_truncated: 'changed_response',
  empty_content: 'changed_response',
  not_found: 'unavailable',
  authentication_required: 'auth_required',
  rate_limited: 'rate_limited',
  server_error: 'unavailable',
  refused: 'forbidden',
};

function editorialFailureCode(kind: LuoguEditorialFailureKind): PlatformErrorCode {
  return EDITORIAL_FAILURE_CODES[kind];
}

/**
 * The canonical problem id of one reference, validated against this instance.
 *
 * The id is what addresses the platform's solution surface, so it must be exactly the canonical
 * external key of a main-problemset Luogu problem: a source instance that is not ours and a
 * sub-domain are refused before any request, and the key must be the pid shape the platform uses.
 * This mirrors the adapter's own check, because the reader is reachable through its port as well.
 */
function requireLuoguProblemId(ref: ProblemRef, instance: SourceInstance, operation: PlatformOperation): string {
  if (!ref || typeof ref !== 'object') {
    throw invalidInput(operation, 'a problem reference is required');
  }
  if (ref.sourceInstanceId !== instance.id) {
    throw invalidInput(operation, 'the problem reference belongs to another source instance');
  }
  const domain = (ref.domain ?? '').trim().toLowerCase();
  if (domain !== '' && domain !== instance.domain) {
    throw invalidInput(operation, `Luogu problems have no sub-domain, got ${domain}`);
  }
  const raw = typeof ref.externalKey === 'string' ? ref.externalKey.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(raw)) {
    throw invalidInput(operation, 'the problem id must be 1-80 alphanumeric, underscore or hyphen characters');
  }
  return raw;
}

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
 * Fixed, secret-free text for every way a supplied session can be unusable.
 *
 * The pure domain normalizer answers a stable `problem` discriminant; the reader maps it onto its own
 * fixed sentence, so no branch can quote a cookie value, a provider detail or a parser message.
 */
const AUTHENTICATED_COOKIE_FAILURES: Readonly<Record<LuoguCookieProblem, string>> = {
  not_text: 'the Luogu session carries no usable cookie header value',
  empty: 'the Luogu session carries no usable cookie header value',
  too_long: 'the Luogu session cookie header is too long',
  unsafe_characters: 'the Luogu session cookie header contains control characters',
  missing_client_id: 'the Luogu session cookie carries no __client_id',
  missing_uid: 'the Luogu session cookie carries no _uid',
  duplicate_client_id: 'the Luogu session cookie header repeats __client_id',
  duplicate_uid: 'the Luogu session cookie header repeats _uid',
  unusable_client_id: 'the Luogu session cookie __client_id is not a syntactically safe opaque value',
  unusable_uid: 'the Luogu session cookie _uid is not a canonical Luogu UID',
  uid_not_canonical: 'the requested account UID is not canonical',
  foreign_uid: 'the Luogu session cookie uid does not match the selected account',
};

/**
 * Validate an injected session against the selected account and return its canonical cookie value.
 *
 * `__client_id` is Luogu's **opaque session identifier**, not a UID. It is required to be present,
 * non-empty and syntactically safe, and it is deliberately never compared with the account UID:
 * doing so would reject valid sessions and pretend to prove an account binding it cannot prove.
 * The account binding comes from the required `_uid` cookie, which must be the canonical UID of
 * both the selected account and `session.uid`.
 *
 * The returned value is always the canonical two-cookie pair: an optional `Cookie:` prefix, outer
 * spaces, unrelated cookies and a stored legacy whole-Cookie value are accepted and reduced here, so
 * exactly `__client_id` and `_uid` can ever travel. Refused: no session at all, an account UID that
 * is not canonical, a session UID that is not that UID, input beyond the bounded raw size, text
 * containing control characters (header injection), a missing/empty/repeated/unusable
 * `__client_id`, and a missing, empty, unusable or foreign `_uid`. Every failure is an
 * `invalid_input` whose detail names no cookie value.
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
  const normalized = normalizeLuoguSessionCookie(
    typeof session.cookie === 'string' ? session.cookie : null,
    expectedUid,
  );
  if (!normalized.ok) {
    throw invalidInput(operation, AUTHENTICATED_COOKIE_FAILURES[normalized.problem]);
  }
  return normalized.cookie;
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
  if (isLuoguLoginPath(url)) {
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
 * The one target the authenticated transport may currently address.
 *
 * The credential is the most sensitive value in this process, so it is attached only to a target the
 * owning call has bound *by identity*: an exact record page of the account, or an exact solution page
 * of one problem. `null` means no call owns the transport, and then no request is made at all — a
 * caller that reaches the transport without a bound target cannot obtain a cookie.
 */
type SessionTarget =
  | { readonly kind: 'record'; readonly page: number }
  | { readonly kind: 'editorial'; readonly pid: string; readonly page: number };

/**
 * Refuse any target that is not the bound solution page of this problem.
 *
 * The same properties as {@link assertExpectedRecordTarget} hold: official origin only, no URL
 * credentials and no non-default port, the exact official path, no fragment and nothing but the one
 * canonical `page` parameter this call bound. The observed surface spells the first page with **no**
 * query at all and every later page as `?page=N`, so the accepted query is exactly that:
 *
 * - page 1: an empty query string;
 * - page `N > 1`: exactly one `page` parameter equal to the canonical decimal spelling of `N` — a
 *   repeated `page`, a zero-padded spelling such as `page=02`, an additional parameter of any name, a
 *   `+` or `%` spelling and a value that is not this call's own page are all refused before dispatch.
 *
 * The guard runs on **every** dispatch, the manual redirect hops included, so a redirect target that is
 * not this call's own page can never receive the cookie either. A login path means the session is gone
 * and is refused as such; every other deviation is an `unavailable` refusal that echoes nothing about
 * the request (in particular not the query, which carries the page number).
 */
function assertExpectedEditorialTarget(url: string, expectedPid: string, expectedPage: number): void {
  const operation: PlatformOperation = 'editorial';
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
  if (isLuoguLoginPath(url)) {
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
  if (parsed.pathname !== `${SOLUTION_PATH_PREFIX}${encodeURIComponent(expectedPid)}`) {
    throw new PlatformError({
      code: 'unavailable',
      operation,
      retryable: false,
      detail: 'refusing to attach a Luogu session outside the expected solution endpoint of this problem',
    });
  }
  const pages = parsed.searchParams.getAll('page');
  const extra = [...parsed.searchParams.keys()].filter((name) => name !== 'page');
  const expectedQuery = expectedPage === 1 ? '' : `?page=${String(expectedPage)}`;
  if (
    parsed.hash.length > 0 ||
    extra.length > 0 ||
    parsed.search !== expectedQuery ||
    (expectedPage > 1 && (pages.length !== 1 || pages[0] !== String(expectedPage)))
  ) {
    throw new PlatformError({
      code: 'unavailable',
      operation,
      retryable: false,
      detail: 'refusing an authenticated solution request that is not the expected page of this problem',
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

/**
 * The one status whose body a read may interpret: every other status is the whole answer.
 *
 * See {@link emptyRefusalResponse}: the status decides, and a refusal body is never pulled, parsed or
 * measured.
 */
const INTERPRETABLE_STATUS = 200;

/**
 * Best-effort teardown of a body a refusal's caller will never read.
 *
 * The response this replaces is a refusal, so its body is discarded without being pulled: no byte of it
 * can then reach the byte cap (an oversized refusal body would otherwise change `401` into a payload
 * failure), and a body stream that throws while being read can no longer replace the refusal's own
 * typed code. Deferred and never awaited, exactly like the transport's own teardown, so a stream that
 * refuses to cancel cannot hang the request.
 */
function discardRefusalBody(response: FetchResponseLike): void {
  const body = response.body;
  if (body === null) {
    return;
  }
  void Promise.resolve()
    .then(() => body.getReader().cancel())
    .catch(() => undefined);
}

/**
 * Replace a non-200 response with one whose body carries no content and no declared length.
 *
 * `content-length` is dropped on purpose: the transport checks it *before* it looks at the body, so
 * forwarding the refusal's declared size would let an oversized refusal body raise a payload failure
 * even though nothing is read. `location` and `retry-after` are kept, because the transport's redirect
 * policy and retry metadata are part of the answer.
 */
function emptyRefusalResponse(response: FetchResponseLike): FetchResponseLike {
  discardRefusalBody(response);
  return {
    status: response.status,
    headers: {
      get: (name: string): string | null => {
        const lower = name.trim().toLowerCase();
        if (lower === 'content-length') {
          return null;
        }
        return response.headers.get(name);
      },
    },
    body: null,
  };
}

export interface AuthenticatedLuoguFetchOptions {
  /** Returns the currently bound session cookie, or `null` when no session is bound. */
  readonly cookie: () => string | null;
  /** Canonical UID of the account this transport serves; a request may address only this account. */
  readonly expectedUid: string;
  /** Target the owning reader call is currently reading; `null` when no call owns the transport. */
  readonly expectedTarget: () => SessionTarget | null;
  /** Underlying fetch; every call it receives already carries a validated cookie header. */
  readonly fetchImpl: FetchLike;
}

/**
 * Wrap a fetch implementation so it attaches the bound session cookie.
 *
 * This is the single place a Luogu credential becomes an outgoing header. Properties the tests pin
 * down: the cookie is attached only to the internally bound target of one account (any other origin,
 * path, account, page, problem id, extra parameter or fragment is refused before dispatch, and a
 * login redirect becomes `auth_required` without a request being sent to it); a caller-supplied
 * `cookie` header is refused instead of merged; every failure from the underlying fetch — whose
 * message or typed detail may contain anything, including the cookie — is reconstructed with only
 * the validated code and retry metadata; `HttpTransport` still owns pacing, cancellation, timeout,
 * the byte cap and the same-origin-only manual redirect policy, so a cross-origin redirect target
 * is never fetched at all.
 *
 * **A non-200 answer is returned with an empty body, before the transport can read one.** The status is
 * the whole answer for a refusal, so the body is discarded unread here — the earliest point in the
 * stack — which is what makes `401` remain `auth_required` even when that body is oversized, is not
 * JSON, or throws when read.
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
    const target = options.expectedTarget();
    if (target === null) {
      throw invalidInput(operation, 'no target is currently bound to this transport');
    }
    if (target.kind === 'record') {
      assertExpectedRecordTarget(url, expectedUid, target.page);
    } else {
      assertExpectedEditorialTarget(url, target.pid, target.page);
    }
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
    if (response.status !== INTERPRETABLE_STATUS) {
      return emptyRefusalResponse(response);
    }
    return withSanitizedBody(response, operation);
  };
}

/**
 * The typed outcome of reading one authenticated solution page.
 *
 * A page is data and a failure is *returned* rather than thrown, so the walk can keep the two apart and
 * every failure keeps its own platform code (an authentication wall, a refusal, a rate limit, a
 * challenge, a changed payload) instead of being folded into "nothing to store". A raw page can never
 * be an absence: only the walk knows that it read page 1 and that page 1 declared zero write-ups.
 */
type EditorialPageRead =
  | { readonly ok: true; readonly page: LuoguEditorialPage }
  | { readonly ok: false; readonly error: PlatformError };

interface SessionHolder {
  cookie: string | null;
  /** Target the owning call is currently reading; set only while its request is in flight. */
  target: SessionTarget | null;
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
        bound.holder.target = null;
      }
    } finally {
      this.endAccountScan(account.id);
    }
  }

  /**
   * Read one problem's solution material through this account's session (Sprint 33C, paged in the
   * revision).
   *
   * The shape this reads was observed from a sanitized capture of the authenticated
   * `/problem/solution/<pid>` surface and is parsed per page by {@link parseLuoguEditorialPage}, whose
   * rules decide that only an explicit `count: 0` with an empty result list is an absence. The
   * capture also recorded `?page=2` answering the same shape with a non-empty result while `count` is
   * the **total** number of write-ups (56 for P1001 at `perPage` 10), so one whole read is the walk
   * {@link readAllEditorialPages} performs:
   *
   * - the credential comes from the injected provider and is normalized to the canonical cookie pair,
   *   exactly as the submission path does, so an unverified or foreign session is refused before any
   *   request;
   * - the transport is the account's own bound transport, so pacing (>= 2 s) is shared with the
   *   account's other calls, and the target holder is bound per request to exactly one page of exactly
   *   this problem — the first page with no query at all, every later page as the canonical
   *   `?page=N`;
   * - a body that arrives as HTML (a login redirect, a challenge page, a changed layout) is classified
   *   as an authentication wall or an unreadable answer — never as "no editorial";
   * - a payload the parser cannot read becomes a fixed sanitized `changed_response`: the parser's
   *   structural path is dropped, so a server-provided value can never travel in a diagnostic, and a
   *   `sample` is never taken from an authenticated body at all.
   */
  async fetchEditorial(request: LuoguEditorialRequest): Promise<EditorialFetchResult> {
    const operation: PlatformOperation = 'editorial';
    const token = request.token;
    throwIfCancelled(token);
    requireLuoguInstance(this.sourceInstance, operation);
    const http = resolvePlatformLimits(request.limits, operation);
    if (request.officialTutorialUrl !== undefined && request.officialTutorialUrl !== null) {
      // Luogu's own material is addressed by problem id, so a supplied URL cannot be honoured. It is
      // refused instead of being silently ignored, which would let a caller believe it was used.
      throw invalidInput(operation, 'a supplied editorial URL cannot be honoured: Luogu material is addressed by problem id');
    }
    const account: Account = request.account;
    if (!account || typeof account !== 'object') {
      throw invalidInput(operation, 'a Luogu account is required for an authenticated editorial read');
    }
    const uid = requireLuoguUid(this.sourceInstance, account);
    const pid = requireLuoguProblemId(request.problemRef, this.sourceInstance, operation);
    throwIfCancelled(token);

    try {
      this.beginAccountScan(account.id, operation);
      try {
        const cookie = requireLuoguSessionCookie(await this.readEditorialSession(account, token), uid);
        throwIfCancelled(token);
        const bound = this.transportFor(account.id, uid);
        bound.holder.cookie = cookie;
        try {
          return await this.readAllEditorialPages(pid, token, http, bound);
        } finally {
          // The cookie lives exactly as long as the call that owns it, on every outcome.
          bound.holder.cookie = null;
          bound.holder.target = null;
        }
      } finally {
        this.endAccountScan(account.id);
      }
    } catch (cause) {
      // The reader answers its port the way the adapter answers the pipeline: an operational failure
      // is *returned* with its own discriminant, so the material gate can tell an authentication wall
      // or a rate limit apart from an absence. A cancellation and a malformed request are the caller's
      // own failures and keep propagating.
      if (isPlatformError(cause)) {
        return editorialFailureFromPlatformError(cause);
      }
      throw cause;
    }
  }

  /**
   * Resolve the session of exactly this account for an editorial read.
   *
   * The credential provider is an untrusted boundary — its rejection can carry the cookie in a detail
   * or a sample — so the failure is rebuilt as a fixed sanitized one, and cancellation keeps its own
   * discriminant.
   *
   * A session that belongs to *another* account is the one case that is not a malformed input: it
   * means this call cannot be authenticated at all, so it is reported as the authentication wall it
   * is. The provider is never asked to authenticate as somebody else.
   */
  private async readEditorialSession(account: Account, token: CancellationToken): Promise<LuoguSession> {
    throwIfCancelled(token);
    try {
      const session = await this.sessions.sessionFor(account, token);
      throwIfCancelled(token);
      if (typeof session?.uid !== 'string' || session.uid.trim() !== account.handle) {
        throw new PlatformError({
          code: 'auth_required',
          operation: 'editorial',
          retryable: false,
          detail: SAFE_FAILURE_DETAILS.auth_required,
        });
      }
      return session;
    } catch (cause) {
      throwIfCancelled(token);
      sanitizeAuthenticatedFailure(cause, 'editorial', 'session');
    }
  }

  /**
   * Walk the server pages of one problem's solution list and compose the whole stored material.
   *
   * The rules this method owns, in order:
   *
   * 1. page 1 is read **without a query**, exactly as the capture recorded it;
   * 2. only page 1 may report an absence, and only when the parser recognised an explicit
   *    `count: 0` with an empty list;
   * 3. the declared total fixes how many pages exist (`ceil(count / perPage)`, at most
   *    {@link LUOGU_MAX_EDITORIAL_PAGES}); a total that needs more pages fails the read **whole**
   *    after the first page, so no partial list of write-ups is ever returned;
   * 4. every later page is requested as the canonical `?page=N`; a page whose declared `count` or
   *    `perPage` differs from the first page is drift and fails the read;
   * 5. every page must be exactly `min(perPage, max(0, count - (page - 1) * perPage))` write-ups long
   *    — a short, empty or over-long page would silently skip or duplicate material — and a repeated
   *    `lid` inside one page or across pages is drift as well;
   * 6. a page that answers 401/403/404, HTML, a challenge or a rate limit keeps its own typed
   *    discriminant and is never turned into an absence;
   * 7. the number of write-ups and the total retrieved body size are bounded
   *    ({@link LUOGU_MAX_EDITORIAL_SOLUTIONS}, {@link LUOGU_MAX_EDITORIAL_CONTENT_CHARS}); crossing a
   *    bound fails the read whole instead of storing what was read so far;
   * 8. the token is checked before and after every await, and `retrievedAt` is read **once** so every
   *    source and the result itself carry the same instant.
   *
   * Nothing is returned until every page was read, checked and could be materialized: a failure means
   * no write-up of this read exists anywhere.
   */
  private async readAllEditorialPages(
    pid: string,
    token: CancellationToken,
    http: Partial<HttpLimits>,
    bound: AccountTransport,
  ): Promise<EditorialFetchResult> {
    const first = await this.readEditorialPage(1, pid, token, http, bound);
    throwIfCancelled(token);
    if (!first.ok) {
      throw first.error;
    }
    const { count, perPage } = first.page;
    const pageCount = Math.ceil(count / perPage);
    if (pageCount > LUOGU_MAX_EDITORIAL_PAGES) {
      // The declared total needs more requests than one read may spend. The first page was read, so
      // this is an observation about the answer, and the whole read fails instead of returning a
      // partial list.
      throw this.editorialDrift(
        `the declared total ${count} at page size ${perPage} needs ${pageCount} pages, more than the ${LUOGU_MAX_EDITORIAL_PAGES} this read may fetch`,
      );
    }
    const expectedFirst = Math.min(perPage, Math.max(0, count));
    if (first.page.items.length !== expectedFirst) {
      throw this.editorialDrift(
        `server page 1 answered ${first.page.items.length} write-ups but the declared total ${count} requires ${expectedFirst}`,
      );
    }
    if (count === 0) {
      // The one absence this stage recognises: page 1 explicitly declared zero write-ups and answered
      // an empty list of them. Any other empty or short answer is a failure, not an absence.
      return { status: 'absent', detail: 'Luogu reported no solution for this problem (count 0 with an empty result list)' };
    }
    const items: ObservedSolution[] = [];
    const seen = new Set<string>();
    // Local accumulators, so two reads can never share a budget: at most one read per account is in
    // flight, but nothing here depends on that.
    const budget = { items: 0, contentChars: 0 };
    this.collectEditorialItems(first.page.items, items, seen, budget);
    for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
      throwIfCancelled(token);
      const next = await this.readEditorialPage(pageNumber, pid, token, http, bound);
      throwIfCancelled(token);
      if (!next.ok) {
        throw next.error;
      }
      if (next.page.count !== count || next.page.perPage !== perPage) {
        throw this.editorialDrift(
          `the declared solution pagination changed from ${count}/${perPage} to ${next.page.count}/${next.page.perPage} at page ${pageNumber}`,
        );
      }
      const expected = Math.min(perPage, Math.max(0, count - (pageNumber - 1) * perPage));
      if (next.page.items.length !== expected) {
        throw this.editorialDrift(
          `server page ${pageNumber} answered ${next.page.items.length} write-ups but the declared total ${count} requires ${expected}`,
        );
      }
      // Duplicates are checked page by page, so the read stops at the first page that overlaps instead
      // of spending every remaining request on a broken answer.
      this.collectEditorialItems(next.page.items, items, seen, budget);
    }
    throwIfCancelled(token);
    if (items.length !== count) {
      throw this.editorialDrift(`the read returned ${items.length} write-ups but the declared total is ${count}`);
    }
    // Read exactly once, so every source of this read and the result itself carry the same instant.
    const retrievedAt = this.nowIso();
    throwIfCancelled(token);
    return this.materializeEditorial(items, pid, retrievedAt);
  }

  /**
   * Append one page's write-ups, enforcing the two bounded budgets and the cross-page identity rule.
   *
   * A repeated `lid` — inside one page or across pages — means the pages overlap or the ids are not
   * per-write-up identities; storing both copies would give one write-up two records. The key compared
   * here is the parser's **canonical** lid (trimmed and NFC-normalised), which is exactly the string
   * every stored id is built from, so two Unicode spellings of one id also collide here. The number of
   * write-ups and the total retrieved body size are bounded as well, so a pathological answer is
   * refused while it is read rather than after it was materialized.
   */
  private collectEditorialItems(
    pageItems: readonly ObservedSolution[],
    items: ObservedSolution[],
    seen: Set<string>,
    budget: { items: number; contentChars: number },
  ): void {
    for (const item of pageItems) {
      if (seen.has(item.lid)) {
        throw this.editorialDrift('the read repeated one write-up id');
      }
      seen.add(item.lid);
      items.push(item);
      budget.items += 1;
      if (budget.items > LUOGU_MAX_EDITORIAL_SOLUTIONS) {
        throw this.editorialDrift(
          `the read returned more than the ${LUOGU_MAX_EDITORIAL_SOLUTIONS} write-ups one read may store`,
        );
      }
      budget.contentChars += item.content.length;
      if (budget.contentChars > LUOGU_MAX_EDITORIAL_CONTENT_CHARS) {
        throw this.editorialDrift(
          `the read retrieved more than the ${LUOGU_MAX_EDITORIAL_CONTENT_CHARS} characters one read may store`,
        );
      }
    }
  }

  /**
   * Turn the validated write-ups of one whole read into the typed editorial result.
   *
   * The parser's per-write-up builder owns the stored identity; a refusal here (a value that cannot
   * become a stored id) becomes a fixed sanitized `changed_response` carrying no value, and a
   * programming error is rethrown unchanged rather than being disguised as a platform answer.
   */
  private materializeEditorial(
    items: readonly ObservedSolution[],
    pid: string,
    retrievedAt: string,
  ): EditorialFetchResult {
    const built = buildEditorialMaterial(items, pid, retrievedAt);
    if (built.ok && built.status === 'found') {
      return { status: 'found', sources: built.sources, solutions: built.solutions, retrievedAt };
    }
    if (!built.ok) {
      throw this.editorialFailure(built.kind);
    }
    // `buildEditorialMaterial` only reports `found`: an empty read never reaches it, because the walk
    // above already answered the one absence it recognises.
    throw this.editorialDrift('the read produced no material and no absence');
  }

  /** Fixed sanitized `changed_response` for one structural drift of an authenticated read. */
  private editorialDrift(detail: string): PlatformError {
    return new PlatformError({
      code: 'changed_response',
      operation: 'editorial',
      retryable: false,
      detail,
    });
  }

  /** Fixed sanitized failure of one unreadable payload; the parser's path is deliberately dropped. */
  private editorialFailure(kind: LuoguEditorialFailureKind): PlatformError {
    const code = editorialFailureCode(kind);
    return new PlatformError({
      code,
      operation: 'editorial',
      // A declared rate limit and a declared server-side failure are transient, exactly like the same
      // conditions as real HTTP statuses; every structural defect is terminal.
      retryable: code === 'rate_limited' || kind === 'server_error',
      // Neither carries a declared delay in a payload, so the delay stays unknown rather than invented.
      ...(code === 'rate_limited' ? { retryAfterMs: null } : {}),
      detail: SAFE_FAILURE_DETAILS[code],
    });
  }

  /** Dispatch one authenticated editorial page request; failures are sanitized like every other hop. */
  private async requestEditorial(
    pid: string,
    pageNumber: number,
    token: CancellationToken,
    http: Partial<HttpLimits>,
    bound: AccountTransport,
  ): Promise<HttpResponse> {
    throwIfCancelled(token);
    // The solution page of exactly this problem is bound, so the credential can reach only it. The
    // bound page is what the target guard compares the dispatched URL (and every redirect hop) with.
    bound.holder.target = { kind: 'editorial', pid, page: pageNumber };
    try {
      return await bound.transport.request(this.editorialPath(pid, pageNumber), {
        token,
        operation: 'editorial',
        headers: { [LENTILLE_HEADER]: LENTILLE_VALUE },
        // The observed error envelopes arrive as these statuses, and they are accepted so the reader
        // can answer with *its* fixed, body-blind classification of them (see
        // `editorialStatusFailure`) instead of a generic transport error. The body of a non-200 answer
        // is never parsed, so a shaped success block inside a refusal cannot become material or an
        // absence. Anything else (a server error, a rate limit, a challenge) stays a transport failure
        // with its own typed code, so a 429 keeps `rate_limited`.
        acceptStatuses: [400, 401, 403, 404],
        limits: http,
      });
    } catch (cause) {
      sanitizeAuthenticatedFailure(cause, 'editorial', 'transport');
    } finally {
      // The credential is bound to one request at a time; nothing is left bound between pages.
      bound.holder.target = null;
    }
  }

  /**
   * The one accepted address of one solution page.
   *
   * The unparameterised path is the observed first page; `?page=N` is the observed continuation. No
   * other spelling is ever built here, which is what makes the target guard's exact comparison
   * meaningful.
   */
  private editorialPath(pid: string, pageNumber: number): string {
    const base = `${SOLUTION_PATH_PREFIX}${encodeURIComponent(pid)}`;
    return pageNumber === 1 ? base : `${base}?page=${String(pageNumber)}`;
  }

  /** One authenticated solution page, parsed and typed; a failure is returned, never thrown. */
  private async readEditorialPage(
    pageNumber: number,
    pid: string,
    token: CancellationToken,
    http: Partial<HttpLimits>,
    bound: AccountTransport,
  ): Promise<EditorialPageRead> {
    const response = await this.requestEditorial(pid, pageNumber, token, http, bound);
    throwIfCancelled(token);
    try {
      return { ok: true, page: this.classifyEditorialPage(response, pid) };
    } catch (cause) {
      throwIfCancelled(token);
      if (isPlatformError(cause)) {
        return { ok: false, error: cause };
      }
      throw cause;
    }
  }

  /**
   * Classify one authenticated editorial response and parse exactly one page of it.
   *
   * **The HTTP status decides first, and only `200` may reach the payload parser.** The accepted
   * statuses exist so the answer is a *typed* code rather than a generic transport error, and the body
   * of a non-200 answer is never read at all: a refusal is never allowed to look like content, so an
   * error page that happens to carry a shaped, empty `solutions` block (or even a shaped non-empty one)
   * can never become `absent` or `found`.
   *
   * | HTTP status | Result |
   * | --- | --- |
   * | `200` | the payload is parsed; the body decides between material, drift and a body-level error envelope |
   * | `401` | `auth_required`, fixed text, whether the body is JSON or an inline login page |
   * | `403` | `forbidden`, fixed text |
   * | `404` | `unavailable` (never `absent`), fixed text |
   * | `400` | `unavailable` with a fixed text: the platform refused the request itself |
   * | anything else | the transport's own typed failure (a `429` stays `rate_limited`) |
   *
   * Two `200` body forms are accepted, because both carry the same payload shape: the JSON envelope of
   * the request itself, and the hydration element of the page the platform answers with instead. At
   * status `200` an HTML body is never parsed as material: a login page reached by a redirect is
   * refused by the target guard before the cookie is attached, an inline login page at the solution URL
   * carries no reliable structural signal and is therefore `changed_response`, and any other page
   * without a hydration element is an unreadable answer. A payload this build cannot read becomes its
   * own typed failure — never a page with no write-ups, which the walk would have to interpret.
   */
  private classifyEditorialPage(response: HttpResponse, pid: string): LuoguEditorialPage {
    const statusFailure = this.editorialStatusFailure(response.status);
    if (statusFailure !== null) {
      throw statusFailure;
    }
    const payload = this.editorialPayload(response);
    const parsed = parseLuoguEditorialPage(payload, pid);
    if (!parsed.ok) {
      throw this.editorialFailure(parsed.kind);
    }
    // `parseLuoguEditorialPage` reads pages only; the per-page `absent` status belongs to the
    // whole-payload wrapper, which the walk deliberately does not use.
    if (parsed.status !== 'page') {
      throw this.editorialDrift('the solution payload was classified as a whole-payload answer');
    }
    return parsed.page;
  }

  /**
   * The fixed, body-blind classification of one non-200 authenticated editorial status.
   *
   * Returns `null` for `200` (the only status whose body may be parsed) and a fixed sanitized failure
   * for every other status this read accepts. The mapping is total, so a status this build does not
   * expect is still a non-`absent` failure rather than an unreadable body.
   */
  private editorialStatusFailure(status: number): PlatformError | null {
    if (status === 200) {
      return null;
    }
    const fixed = (code: PlatformErrorCode, detail: string): PlatformError =>
      new PlatformError({ code, operation: 'editorial', retryable: false, detail });
    if (status === 401) {
      return fixed('auth_required', 'Luogu refused the authenticated solution request: HTTP 401');
    }
    if (status === 403) {
      return fixed('forbidden', 'Luogu refused the authenticated solution request: HTTP 403');
    }
    if (status === 404) {
      return fixed('unavailable', 'Luogu answered HTTP 404 for the solution request');
    }
    if (status === 400) {
      // The platform rejected the request itself; this is not evidence about the material and can
      // never be an absence.
      return fixed('unavailable', 'Luogu rejected the solution request: HTTP 400');
    }
    return fixed('unavailable', `Luogu answered HTTP ${String(status)} for the solution request`);
  }

  /**
   * Extract the payload of one **HTTP 200** authenticated response without ever echoing its body.
   *
   * Only reached after {@link editorialStatusFailure} accepted the status, so no refusal body is ever
   * interpreted. A login path is still refused here as defence in depth — the target guard normally
   * refuses a redirect to it *before* the cookie is attached — and any other HTML page is an unreadable
   * answer with a fixed, body-free detail.
   */
  private editorialPayload(response: HttpResponse): unknown {
    const contentType = response.headers['content-type'] ?? null;
    if (isHtmlResponse(contentType, response.body)) {
      if (isLuoguLoginPath(response.url)) {
        throw new PlatformError({
          code: 'auth_required',
          operation: 'editorial',
          retryable: false,
          detail: 'the Luogu session is no longer valid: the solution page was answered by the login page',
        });
      }
      const hydrated = lentilleContextPayload(response.body);
      if (hydrated === null) {
        // A challenge page, a changed layout or a page without the hydration element. This says
        // nothing about whether an editorial exists.
        throw new PlatformError({
          code: 'changed_response',
          operation: 'editorial',
          retryable: false,
          detail: 'Luogu answered a page without a readable solution payload instead of solution JSON',
        });
      }
      return hydrated;
    }
    return this.parseEditorialBody(response.body);
  }

  /** Parse the JSON body without ever echoing it: the parser's message can quote the input. */
  private parseEditorialBody(body: string): unknown {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new PlatformError({
        code: 'changed_response',
        operation: 'editorial',
        retryable: false,
        detail: 'Luogu answered a solution response that is not valid JSON',
      });
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
    const holder: SessionHolder = { cookie: null, target: null };
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
        expectedTarget: () => holder.target,
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
    bound.holder.target = { kind: 'record', page: pageNumber };
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
      bound.holder.target = null;
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
      if (isLuoguLoginPath(response.url)) {
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
