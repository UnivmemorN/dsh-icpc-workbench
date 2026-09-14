/**
 * Luogu platform adapter (anonymous Lentille content-only reads).
 *
 * Scope and honesty rules this implementation enforces:
 * - exactly the official HTTPS origin `https://www.luogu.com.cn`; the source instance must be a
 *   coherent `luogu:www.luogu.com.cn` with that base URL and a transport bound to the same origin,
 *   all validated before any request;
 * - `listProblems` pages the fixed server page size locally: the cursor stops on the last visited
 *   server page, whose parsed content fingerprint and boundary pid are re-verified before the
 *   listing advances, so a client `limit` below or above the server `perPage` neither skips nor
 *   duplicates entries, and drift (page size, total count, page length, repeated ids, changed page
 *   content, foreign scope) fails visibly;
 * - `fetchProblem` assembles every content section and sample verbatim (Markdown/math text is
 *   never rendered or rewritten) and refuses a detail whose pid differs from the request;
 * - raw difficulty and raw numeric tag ids are preserved; a tag dictionary is optional and
 *   explicit, adds names next to the raw ids, and a dictionary failure is surfaced instead of
 *   producing zero-tag problems;
 * - submissions and editorial require a Luogu session. `listSubmissions` delegates to an injected
 *   authenticated session reader (Sprint 17a) when one is configured; without one the anonymous
 *   endpoints are probed and their observed answers reported: HTTP 401 / `data.errorCode=401`
 *   becomes the typed `auth_required` result, 403 `forbidden`, 429 `rate_limited`, a successful
 *   but unverified payload `changed_response`. An authentication wall is never an empty submission
 *   history and never an `absent` editorial.
 * - `fetchAccountProfile` reads the account's own public nickname from `/user/<canonical uid>`
 *   anonymously: only `data.user` is the profile (`root.user` is the *viewer* identity of the
 *   request and is never used), the answered uid must equal the requested account, and the
 *   nickname must be a non-blank bounded string. No other profile field is read or returned.
 * - every request goes through the shared {@link HttpTransport} (FIFO pacing, timeouts, retries,
 *   byte cap, official-origin redirect policy, no cookies) and every await is followed by a
 *   cancellation check on the caller's token.
 */
import {
  accountIdOf,
  createNormalizedProblem,
  createSourceInstance,
  sourceInstanceIdOf,
  type Account,
  type CancellationToken,
  type NormalizedProblem,
  type PlatformRating,
  type ProblemRef,
  type SourceInstance,
  type Submission,
} from '../../domain/index.js';
import type { LuoguSessionReader } from '../../application/luogu-session.js';
import {
  DEFAULT_PLATFORM_LIMITS,
  type AccountProfile,
  type EditorialFetchResult,
  type FetchAccountProfileRequest,
  type FetchEditorialRequest,
  type FetchProblemRequest,
  type ListProblemsRequest,
  type ListSubmissionsRequest,
  type Page,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformLimits,
} from '../../application/ports.js';
import {
  PlatformError,
  editorialFailureFromPlatformError,
  isPlatformError,
  type PlatformErrorCode,
  type PlatformOperation,
} from '../../application/platform-errors.js';
import {
  HARD_MAX_RETRIES,
  HttpTransport,
  type ClockFn,
  type FetchLike,
  type HttpLimits,
  type HttpResponse,
  type SetTimerFn,
  type WaitFn,
} from '../platform/http.js';
import { decodeLuoguListCursor, encodeLuoguListCursor, luoguServerPageFingerprint } from './cursors.js';
import { requireLuoguUid } from './account.js';
import {
  bodySnippet,
  isHtmlResponse,
  isJsonRecord,
  luoguData,
  luoguTagRaws,
  parseAccountProfile,
  parseProblemDetail,
  parseProblemList,
  parseTagDictionary,
  payloadError,
  type LuoguAccountProfile,
  type LuoguProblemDetail,
  type LuoguProblemPage,
  type LuoguProblemSummary,
} from './parsers.js';

/** Official Luogu origin; this adapter refuses to serve any other host, path or port. */
export const LUOGU_BASE_URL = 'https://www.luogu.com.cn';
export const LUOGU_DOMAIN = 'www.luogu.com.cn';
/** Upper bound of one list page; larger listings require cursor continuation. */
export const LUOGU_MAX_LIST_LIMIT = 500;

const PROBLEM_LIST_PATH = '/problem/list';
const PROBLEM_PATH_PREFIX = '/problem/';
const SOLUTION_PATH_PREFIX = '/problem/solution/';
const RECORD_LIST_PATH = '/record/list';
const PROFILE_PATH_PREFIX = '/user/';
const TAGS_PATH = '/_lfe/tags';
const LENTILLE_HEADER = 'x-lentille-request';
const LENTILLE_VALUE = 'content-only';
const MAX_LIMITS_VALUE = 600_000;

export interface LuoguProblemDetailResult {
  readonly problem: NormalizedProblem;
  readonly detail: LuoguProblemDetail;
}

export interface LuoguAdapterOptions {
  readonly sourceInstance: SourceInstance;
  /** Shared transport; must already be bound to {@link LUOGU_BASE_URL}. */
  readonly transport?: HttpTransport;
  /** Injectable transport wiring used only when `transport` is omitted. */
  readonly fetchImpl?: FetchLike;
  readonly clock?: ClockFn;
  readonly wait?: WaitFn;
  readonly setTimer?: SetTimerFn;
  /**
   * Explicit, caller-supplied tag dictionary. Supplying one never issues a request and never
   * replaces the raw tag ids; an empty or invalid dictionary is rejected here.
   */
  readonly tagDictionary?: ReadonlyMap<number, string>;
  /** Load `/_lfe/tags` on demand so raw ids are accompanied by dictionary names. */
  readonly resolveTagNames?: boolean;
  /**
   * Authenticated submission reader (Sprint 17a). When supplied, `listSubmissions` delegates to
   * it and the capabilities advertise submission history; without one the adapter keeps probing
   * the anonymous endpoint and reports the observed authentication wall instead of inventing a
   * history. Session material lives behind the reader; nothing credential-bearing appears here.
   */
  readonly sessionReader?: LuoguSessionReader | null;
}

function invalidInput(operation: PlatformOperation, detail: string): PlatformError {
  return new PlatformError({ code: 'invalid_input', operation, retryable: false, detail });
}

/**
 * Fixed, body-free detail of one public-profile failure.
 *
 * The anonymous `/user/<uid>` answer is a whole public profile page (biography, scores, follower
 * data, ...), while only its uid and nickname are ever used. No failure of this path may therefore
 * quote the body, a parser message (Node's JSON syntax error quotes the offending input) or another
 * error; the typed code, its retryability and a declared Retry-After are preserved and the detail is
 * one of these fixed sentences.
 */
const PROFILE_FAILURE_DETAILS: Readonly<Record<PlatformErrorCode, string>> = {
  cancelled: 'the Luogu profile lookup was cancelled',
  auth_required: 'the Luogu profile endpoint requires a session',
  forbidden: 'the Luogu profile endpoint refused the anonymous request',
  rate_limited: 'the Luogu profile endpoint rate limited the request',
  unavailable: 'the Luogu profile endpoint did not answer a profile',
  changed_response: 'the Luogu profile payload is not a validated public profile',
  invalid_input: 'the public profile request was rejected',
};

/**
 * Rebuild one public-profile failure so no profile text, parser message or cause can travel with it.
 *
 * The result keeps the original typed code, retryability, Retry-After and attempt count and never
 * carries a `sample`; cancellation and unexpected programming errors are not platform answers and
 * are rethrown unchanged by the caller.
 */
function safeProfileError(error: PlatformError): PlatformError {
  return new PlatformError({
    code: error.code,
    operation: 'profile',
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    attempts: error.attempts,
    detail: PROFILE_FAILURE_DETAILS[error.code],
  });
}

function requireInteger(
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
function requireListLimit(limit: number, limits: PlatformLimits, operation: PlatformOperation): number {
  const value = requireInteger(limit, 'limit', operation, 1, LUOGU_MAX_LIST_LIMIT);
  if (value > limits.pageSize) {
    throw invalidInput(operation, `limit ${value} exceeds the configured pageSize ${limits.pageSize}`);
  }
  return value;
}

/** A validated, frozen `luogu:www.luogu.com.cn` source instance. */
export function luoguSourceInstance(): SourceInstance {
  return createSourceInstance({
    platform: 'luogu',
    baseUrl: LUOGU_BASE_URL,
    domain: LUOGU_DOMAIN,
    displayName: 'Luogu',
  });
}

/**
 * Validate a Luogu source instance: platform, exact official origin (no path, port or embedded
 * credentials), official domain and the derived instance id.
 *
 * Exported because every Luogu implementation (the adapter, the authenticated session reader)
 * must refuse a foreign instance before it issues a request.
 */
export function requireLuoguInstance(instance: SourceInstance, operation: PlatformOperation = 'catalog'): void {
  if (!instance || instance.platform !== 'luogu') {
    throw invalidInput(operation, 'the Luogu adapter requires a luogu source instance');
  }
  let parsed: URL;
  try {
    parsed = new URL(instance.baseUrl);
  } catch (cause) {
    throw invalidInput(operation, `baseUrl must be an absolute URL: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (
    parsed.origin !== LUOGU_BASE_URL ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw invalidInput(operation, `the Luogu adapter serves exactly ${LUOGU_BASE_URL} with no path, port or credentials`);
  }
  if (instance.domain !== LUOGU_DOMAIN) {
    throw invalidInput(operation, `the Luogu instance domain must be ${LUOGU_DOMAIN}, got ${String(instance.domain)}`);
  }
  if (instance.id !== sourceInstanceIdOf('luogu', LUOGU_DOMAIN)) {
    throw invalidInput(operation, 'the source instance id does not match its platform and domain');
  }
}

function normalizeDictionary(input: ReadonlyMap<number, string>): ReadonlyMap<number, string> {
  const dictionary = new Map<number, string>();
  for (const [id, name] of input) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw invalidInput('catalog', 'tag dictionary ids must be safe integers');
    }
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length === 0) {
      throw invalidInput('catalog', `tag dictionary entry ${id} has no name`);
    }
    dictionary.set(id, trimmed);
  }
  if (dictionary.size === 0) {
    throw invalidInput('catalog', 'a supplied tag dictionary must not be empty');
  }
  return dictionary;
}

export class LuoguAdapter implements PlatformAdapter {
  readonly sourceInstance: SourceInstance;
  private readonly transport: HttpTransport;
  private readonly clock: ClockFn;
  private readonly resolveTagNames: boolean;
  private readonly sessionReader: LuoguSessionReader | null;
  private dictionary: ReadonlyMap<number, string> | null;

  constructor(options: LuoguAdapterOptions) {
    requireLuoguInstance(options.sourceInstance);
    this.sourceInstance = options.sourceInstance;
    const transport =
      options.transport ??
      new HttpTransport({
        origin: LUOGU_BASE_URL,
        minRequestIntervalMs: DEFAULT_PLATFORM_LIMITS.minRequestIntervalMs,
        requestTimeoutMs: DEFAULT_PLATFORM_LIMITS.requestTimeoutMs,
        maxRetries: DEFAULT_PLATFORM_LIMITS.maxRetries,
        fetchImpl: options.fetchImpl,
        clock: options.clock,
        wait: options.wait,
        setTimer: options.setTimer,
      });
    if (transport.origin !== LUOGU_BASE_URL) {
      throw invalidInput('catalog', `the transport origin ${transport.origin} is not ${LUOGU_BASE_URL}`);
    }
    this.transport = transport;
    this.clock = options.clock ?? (() => Date.now());
    this.resolveTagNames = options.resolveTagNames === true;
    this.dictionary = options.tagDictionary ? normalizeDictionary(options.tagDictionary) : null;
    const reader = options.sessionReader ?? null;
    if (reader !== null && typeof reader.listSubmissions !== 'function') {
      throw invalidInput('submissions', 'sessionReader must expose listSubmissions(request)');
    }
    this.sessionReader = reader;
  }

  capabilities(): PlatformCapabilities {
    const authenticated = this.sessionReader !== null;
    return {
      platform: 'luogu',
      implemented: true,
      problems: true,
      submissions: authenticated,
      editorial: false,
      pagedProblems: true,
      pagedSubmissions: authenticated,
      requiresAuth: true,
      supportsAccountHistory: authenticated,
      minRequestIntervalMs: null,
      notes: [
        'anonymous Lentille content-only requests to the official origin only',
        authenticated
          ? 'authenticated submission history runs through the injected Luogu session reader; its record envelope is structurally validated and has not been verified against a live authenticated response'
          : 'submissions and account history need a Luogu session; the authenticated record shape is not implemented',
        'editorials need a Luogu session; the anonymous solutions endpoint answers HTTP 401 UserUnloginException',
        'raw difficulty and raw tag ids (luogu-tag:<id>) are preserved; names need an explicit tag dictionary',
      ],
    };
  }

  async listProblems(request: ListProblemsRequest): Promise<Page<NormalizedProblem>> {
    const operation = 'catalog' as const;
    request.token.throwIfCancelled();
    const http = this.httpLimits(request.limits, operation);
    const limit = requireListLimit(request.limit, request.limits, operation);
    const accountId = this.accountScope(request.account ?? null, operation);
    const cursor =
      request.cursor === null
        ? null
        : decodeLuoguListCursor(request.cursor, { sourceInstanceId: this.sourceInstance.id, accountId });
    const dictionary = await this.requireDictionary(request.token, http, operation);
    request.token.throwIfCancelled();
    const items: NormalizedProblem[] = [];
    const deliveredPids = new Set<string>();
    let pageNumber = cursor?.page ?? 1;
    let offset = cursor?.offset ?? 0;
    let perPage = cursor?.perPage ?? 0;
    let count = cursor?.count ?? 0;
    let lastPid = cursor?.lastPid ?? null;
    // Only the first iteration re-reads the cursor's own page, so only it has a known fingerprint.
    let resumed = cursor !== null;
    let expectedPageFingerprint = cursor?.pageFingerprint ?? null;
    let knownServerPage = cursor !== null;
    let boundaryChecked = cursor === null || cursor.offset === 0;
    let finalPageFingerprint = '';
    for (;;) {
      const server = await this.readProblemPage(pageNumber, request.token, http);
      request.token.throwIfCancelled();
      if (knownServerPage) {
        if (server.perPage !== perPage) {
          throw this.drift(`the server page size changed from ${perPage} to ${server.perPage}`);
        }
        if (server.count !== count) {
          throw this.drift(`the problem total changed from ${count} to ${server.count}`);
        }
        if (expectedPageFingerprint !== null && luoguServerPageFingerprint(pageNumber, server) !== expectedPageFingerprint) {
          throw this.drift(`the content of server page ${pageNumber} changed`);
        }
      }
      knownServerPage = true;
      expectedPageFingerprint = null;
      perPage = server.perPage;
      count = server.count;
      finalPageFingerprint = luoguServerPageFingerprint(pageNumber, server);
      // The declared total fixes how long every server page must be; a short non-final page would
      // silently skip records, so it is rejected before anything is taken or returned.
      const pageStart = (pageNumber - 1) * perPage;
      const expectedLength = Math.min(perPage, Math.max(0, count - pageStart));
      if (server.items.length !== expectedLength) {
        throw this.drift(
          `server page ${pageNumber} answered ${server.items.length} entries but the declared total ${count} requires ${expectedLength}`,
        );
      }
      if (resumed && pageStart + offset >= count) {
        throw this.drift('the cursor position lies past the declared total');
      }
      if (offset > expectedLength) {
        throw this.drift(`the cursor offset ${offset} lies past the end of server page ${pageNumber}`);
      }
      const pagePids = new Set<string>();
      for (const summary of server.items) {
        if (pagePids.has(summary.pid)) {
          throw this.drift(`server page ${pageNumber} repeats problem ${summary.pid}`);
        }
        pagePids.add(summary.pid);
      }
      if (!boundaryChecked) {
        const boundary = server.items[offset - 1];
        if (boundary === undefined || boundary.pid !== lastPid) {
          throw this.drift('the cursor page boundary moved');
        }
        boundaryChecked = true;
      }
      resumed = false;
      const take = Math.min(limit - items.length, expectedLength - offset);
      for (let index = 0; index < take; index += 1) {
        const summary = server.items[offset + index];
        if (summary === undefined) {
          throw this.drift('the server page ended before the cursor offset');
        }
        if (deliveredPids.has(summary.pid)) {
          throw this.drift(`problem ${summary.pid} was delivered twice in one listing`);
        }
        deliveredPids.add(summary.pid);
        items.push(this.toNormalizedProblem(summary, dictionary, null));
        lastPid = summary.pid;
      }
      offset += take;
      const consumed = pageStart + offset;
      if (items.length >= limit || consumed >= count) {
        break;
      }
      // A cursor may sit exactly at the end of a full page (`offset === perPage`); that page was
      // just re-read and verified, so the listing advances instead of failing or skipping ahead.
      if (take === 0 && offset < perPage) {
        throw payloadError(operation, 'the server answered an empty page before the declared total was reached');
      }
      pageNumber += 1;
      offset = 0;
      lastPid = null;
    }
    request.token.throwIfCancelled();
    const nextCursor =
      (pageNumber - 1) * perPage + offset < count
        ? encodeLuoguListCursor({
            sourceInstanceId: this.sourceInstance.id,
            accountId,
            page: pageNumber,
            offset,
            perPage,
            count,
            lastPid,
            pageFingerprint: finalPageFingerprint,
          })
        : null;
    return { items, nextCursor, fetchedAt: this.nowIso() };
  }

  /**
   * Submission history.
   *
   * With an injected {@link LuoguSessionReader} the call is delegated to the authenticated reader,
   * which owns the session, the scope-bound cursor and the record-shape validation; the adapter
   * re-checks the account scope before the delegate and the token after it, so a cancellation
   * observed while the reader was resolving is never handed back as a successful page. Without a
   * reader, the anonymous record endpoint is probed so its answer stays visible
   * (`auth_required`/`forbidden`/`rate_limited`), and any unexpected success is reported as
   * `changed_response` instead of a fabricated page.
   */
  async listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>> {
    const operation = 'submissions' as const;
    request.token.throwIfCancelled();
    if (this.sessionReader !== null) {
      this.requireAccountHandle(request.account, operation);
      const page = await this.sessionReader.listSubmissions(request);
      request.token.throwIfCancelled();
      return page;
    }
    const handle = this.requireAccountHandle(request.account, operation);
    const http = this.httpLimits(request.limits, operation);
    requireListLimit(request.limit, request.limits, operation);
    if (request.cursor !== null) {
      throw invalidInput(operation, 'Luogu submission history is unavailable, so no continuation cursor exists');
    }
    const response = await this.get(
      `${RECORD_LIST_PATH}?user=${encodeURIComponent(handle)}&page=1`,
      request.token,
      http,
      operation,
    );
    request.token.throwIfCancelled();
    luoguData(this.jsonRoot(response, operation, `records for ${handle}`), operation);
    throw new PlatformError({
      code: 'changed_response',
      operation,
      retryable: false,
      detail: 'the authenticated Luogu record shape is not implemented',
      sample: bodySnippet(response.body),
    });
  }

  async fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem> {
    const result = await this.fetchProblemDetail(request);
    // The delegate checks its own awaits; the wrapper re-checks so a cancellation observed while
    // the detail call settled can never be handed back to the caller as a successful problem.
    request.token.throwIfCancelled();
    return result.problem;
  }

  /**
   * Full problem detail. `fetchProblem` returns the port shape; this variant additionally exposes
   * the validated time/memory limits, which the domain's {@link NormalizedProblem} does not model.
   */
  async fetchProblemDetail(request: FetchProblemRequest): Promise<LuoguProblemDetailResult> {
    const operation = 'problem' as const;
    request.token.throwIfCancelled();
    const pid = this.requireProblemRef(request.problemRef, operation);
    const http = this.httpLimits(request.limits, operation);
    const dictionary = await this.requireDictionary(request.token, http, operation);
    request.token.throwIfCancelled();
    const response = await this.get(`${PROBLEM_PATH_PREFIX}${encodeURIComponent(pid)}`, request.token, http, operation);
    request.token.throwIfCancelled();
    const detail = parseProblemDetail(this.jsonRoot(response, operation, `problem ${pid}`), pid, operation);
    request.token.throwIfCancelled();
    const problem = this.toNormalizedProblem(detail.summary, dictionary, detail.statement);
    request.token.throwIfCancelled();
    return { problem, detail };
  }

  /**
   * Anonymous editorial probe. The authenticated editorial shape is not implemented, so the only
   * honest answers are the observed authentication wall (or another typed operational failure) and
   * `changed_response` for an unfamiliar successful payload. Never `absent`.
   */
  async fetchEditorial(request: FetchEditorialRequest): Promise<EditorialFetchResult> {
    const operation = 'editorial' as const;
    request.token.throwIfCancelled();
    const pid = this.requireProblemRef(request.problemRef, operation);
    const http = this.httpLimits(request.limits, operation);
    if (request.officialTutorialUrl !== undefined && request.officialTutorialUrl !== null) {
      this.assertOfficialTutorialUrl(request.officialTutorialUrl, operation);
    }
    request.token.throwIfCancelled();
    try {
      const response = await this.get(`${SOLUTION_PATH_PREFIX}${encodeURIComponent(pid)}`, request.token, http, operation);
      request.token.throwIfCancelled();
      luoguData(this.jsonRoot(response, operation, `solutions for ${pid}`), operation);
      return {
        status: 'changed_response',
        detail: 'Luogu answered an anonymous solutions payload whose authenticated shape is not implemented',
        sample: bodySnippet(response.body),
      };
    } catch (cause) {
      if (isPlatformError(cause)) {
        return editorialFailureFromPlatformError(cause);
      }
      throw cause;
    }
  }

  /**
   * Anonymous public-profile read: the account's own nickname, addressed by its canonical UID.
   *
   * The request path is built from the account's canonical UID (never from free text), and the
   * answer is read from `data.user` only — `root.user` is the viewer identity of the anonymous
   * request and is never accepted as the requested account. The parsed uid must match the request.
   * Only the uid, the nickname and this source instance leave the parser; biography, scores and
   * follower data are not read at all, and a wrong or missing shape is a `changed_response`
   * instead of a fabricated name.
   *
   * Failures are rebuilt through {@link safeProfileError}: a public profile page is never quoted in
   * a detail, a sample, a parser message or a cause.
   */
  async fetchAccountProfile(request: FetchAccountProfileRequest): Promise<AccountProfile> {
    const operation = 'profile' as const;
    request.token.throwIfCancelled();
    try {
      let uid: string;
      try {
        uid = requireLuoguUid(this.sourceInstance, request.account);
      } catch (cause) {
        throw invalidInput(
          operation,
          cause instanceof PlatformError ? cause.detail : 'the account is not a canonical Luogu account',
        );
      }
      const http = this.httpLimits(request.limits, operation);
      const response = await this.get(`${PROFILE_PATH_PREFIX}${encodeURIComponent(uid)}`, request.token, http, operation);
      request.token.throwIfCancelled();
      const root = this.profileJsonRoot(response);
      request.token.throwIfCancelled();
      const profile: LuoguAccountProfile = parseAccountProfile(root, uid, operation);
      request.token.throwIfCancelled();
      return { sourceInstanceId: this.sourceInstance.id, uid: profile.uid, displayName: profile.displayName };
    } catch (cause) {
      // Every platform failure of this path — transport, HTML, malformed JSON or parser — is rebuilt
      // from its typed code so no page text, sample or parser message can travel with the refusal.
      // Cancellation and programming errors are not platform answers and are rethrown unchanged.
      if (cause instanceof PlatformError) {
        throw safeProfileError(cause);
      }
      throw cause;
    }
  }

  /** Load and cache the `/_lfe/tags` dictionary; failures propagate and are never zero tags. */
  async loadTagDictionary(token: CancellationToken, limits: PlatformLimits): Promise<ReadonlyMap<number, string>> {
    // A cached (or constructor-supplied) dictionary skips the request, never the contract: the
    // token is honoured and the limits are validated on every call, cache hit included.
    token.throwIfCancelled();
    const http = this.httpLimits(limits, 'catalog');
    token.throwIfCancelled();
    if (this.dictionary !== null) {
      return new Map(this.dictionary);
    }
    const dictionary = await this.fetchDictionary(token, http, 'catalog');
    token.throwIfCancelled();
    return new Map(dictionary);
  }

  private async requireDictionary(
    token: CancellationToken,
    http: Partial<HttpLimits>,
    operation: PlatformOperation,
  ): Promise<ReadonlyMap<number, string> | null> {
    if (this.dictionary !== null) {
      return this.dictionary;
    }
    if (!this.resolveTagNames) {
      return null;
    }
    return this.fetchDictionary(token, http, operation);
  }

  private async fetchDictionary(
    token: CancellationToken,
    http: Partial<HttpLimits>,
    operation: PlatformOperation,
  ): Promise<ReadonlyMap<number, string>> {
    const response = await this.get(TAGS_PATH, token, http, operation);
    token.throwIfCancelled();
    const dictionary = parseTagDictionary(this.jsonRoot(response, operation, 'the tag dictionary'), operation);
    this.dictionary = dictionary;
    return dictionary;
  }

  private async readProblemPage(
    pageNumber: number,
    token: CancellationToken,
    http: Partial<HttpLimits>,
  ): Promise<LuoguProblemPage> {
    const response = await this.get(`${PROBLEM_LIST_PATH}?page=${pageNumber}`, token, http, 'catalog');
    token.throwIfCancelled();
    return parseProblemList(this.jsonRoot(response, 'catalog', `problem list page ${pageNumber}`), 'catalog');
  }

  private async get(
    path: string,
    token: CancellationToken,
    http: Partial<HttpLimits>,
    operation: PlatformOperation,
  ): Promise<HttpResponse> {
    token.throwIfCancelled();
    const response = await this.transport.request(path, {
      token,
      operation,
      headers: { [LENTILLE_HEADER]: LENTILLE_VALUE },
      limits: http,
    });
    token.throwIfCancelled();
    return response;
  }

  /** Validate caller limits strictly and map them onto the transport's per-request override. */
  private httpLimits(limits: PlatformLimits, operation: PlatformOperation): Partial<HttpLimits> {
    if (!isJsonRecord(limits)) {
      throw invalidInput(operation, 'platform limits are required');
    }
    requireInteger(limits.pageSize, 'limits.pageSize', operation, 1, LUOGU_MAX_LIST_LIMIT);
    requireInteger(limits.maxConcurrency, 'limits.maxConcurrency', operation, 1, 64);
    return {
      minRequestIntervalMs: requireInteger(limits.minRequestIntervalMs, 'limits.minRequestIntervalMs', operation, 0, MAX_LIMITS_VALUE),
      requestTimeoutMs: requireInteger(limits.requestTimeoutMs, 'limits.requestTimeoutMs', operation, 1, MAX_LIMITS_VALUE),
      maxRetries: requireInteger(limits.maxRetries, 'limits.maxRetries', operation, 0, HARD_MAX_RETRIES),
    };
  }

  private jsonRoot(response: HttpResponse, operation: PlatformOperation, label: string): Record<string, unknown> {
    if (isHtmlResponse(response.headers['content-type'] ?? null, response.body)) {
      throw new PlatformError({
        code: 'changed_response',
        operation,
        retryable: false,
        detail: `${label} answered an HTML page instead of JSON`,
        sample: bodySnippet(response.body),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch (cause) {
      throw new PlatformError({
        code: 'changed_response',
        operation,
        retryable: false,
        detail: `${label} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        sample: bodySnippet(response.body),
      });
    }
    if (!isJsonRecord(parsed)) {
      throw payloadError(operation, `${label} must be a JSON object`, bodySnippet(response.body));
    }
    return parsed;
  }

  /**
   * Parse one public-profile answer without ever attaching body text to a failure.
   *
   * Unlike {@link jsonRoot}, this path computes no `bodySnippet` and quotes no parser message, so a
   * profile page's biography or any other unrelated field can never travel with the refusal. A
   * declared body-level `errorCode` is still translated later by `luoguData` inside
   * {@link parseAccountProfile}, and every {@link PlatformError} of this path is finally rebuilt by
   * {@link safeProfileError}.
   */
  private profileJsonRoot(response: HttpResponse): Record<string, unknown> {
    if (isHtmlResponse(response.headers['content-type'] ?? null, response.body)) {
      throw new PlatformError({
        code: 'changed_response',
        operation: 'profile',
        retryable: false,
        detail: PROFILE_FAILURE_DETAILS.changed_response,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch {
      // The parser message may quote the body, so it is deliberately dropped instead of attached.
      throw new PlatformError({
        code: 'changed_response',
        operation: 'profile',
        retryable: false,
        detail: PROFILE_FAILURE_DETAILS.changed_response,
      });
    }
    if (!isJsonRecord(parsed)) {
      throw new PlatformError({
        code: 'changed_response',
        operation: 'profile',
        retryable: false,
        detail: PROFILE_FAILURE_DETAILS.changed_response,
      });
    }
    return parsed;
  }

  private accountScope(account: Account | null, operation: PlatformOperation): string | null {
    if (account === null) {
      return null;
    }
    this.requireAccountHandle(account, operation);
    return account.id;
  }

  /** Require a coherent account: same instance, usable handle, id derived from both. */
  private requireAccountHandle(account: Account, operation: PlatformOperation): string {
    if (!account || typeof account !== 'object') {
      throw invalidInput(operation, 'an account is required');
    }
    if (account.sourceInstanceId !== this.sourceInstance.id) {
      throw invalidInput(operation, 'the account belongs to another source instance');
    }
    const handle = typeof account.handle === 'string' ? account.handle.trim() : '';
    if (handle.length === 0 || handle.length > 80 || /[\u0000-\u001f\u007f]/u.test(handle)) {
      throw invalidInput(operation, 'the account handle is not usable');
    }
    if (account.id !== accountIdOf(this.sourceInstance.id, handle)) {
      throw invalidInput(operation, 'the account id does not match its source instance and handle');
    }
    return handle;
  }

  /** Resolve one problem reference onto this instance; only official Luogu ids are accepted. */
  private requireProblemRef(ref: ProblemRef, operation: PlatformOperation): string {
    if (!ref || typeof ref !== 'object') {
      throw invalidInput(operation, 'a problem reference is required');
    }
    if (ref.sourceInstanceId !== this.sourceInstance.id) {
      throw invalidInput(operation, 'the problem reference belongs to another source instance');
    }
    const domain = (ref.domain ?? '').trim().toLowerCase();
    if (domain !== '' && domain !== LUOGU_DOMAIN) {
      throw invalidInput(operation, `Luogu problems have no sub-domain, got ${domain}`);
    }
    const raw = typeof ref.externalKey === 'string' ? ref.externalKey.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,80}$/u.test(raw)) {
      throw invalidInput(operation, 'the problem id must be 1-80 alphanumeric, underscore or hyphen characters');
    }
    return raw;
  }

  /** A caller-supplied tutorial URL is identity/attribution only and must be on the official origin. */
  private assertOfficialTutorialUrl(raw: string, operation: PlatformOperation): void {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw invalidInput(operation, 'officialTutorialUrl must be a non-empty string');
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch (cause) {
      throw invalidInput(operation, `officialTutorialUrl is not an absolute URL: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.origin !== LUOGU_BASE_URL ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0
    ) {
      throw invalidInput(operation, `officialTutorialUrl must be on the official origin ${LUOGU_BASE_URL}`);
    }
  }

  private toNormalizedProblem(
    summary: LuoguProblemSummary,
    dictionary: ReadonlyMap<number, string> | null,
    statement: string | null,
  ): NormalizedProblem {
    const ratings: PlatformRating[] =
      summary.difficulty === null
        ? []
        : [{ dimension: 'difficulty', value: summary.difficulty, scale: null, raw: String(summary.difficulty) }];
    return createNormalizedProblem({
      ref: { sourceInstanceId: this.sourceInstance.id, domain: null, externalKey: summary.pid },
      title: summary.title,
      url: `${LUOGU_BASE_URL}${PROBLEM_PATH_PREFIX}${encodeURIComponent(summary.pid)}`,
      statement,
      fetchedAt: this.nowIso(),
      ratings,
      rawTags: luoguTagRaws(summary.tagIds, dictionary),
    });
  }

  private drift(detail: string): PlatformError {
    return payloadError('catalog', `${detail}; restart the listing from the first page`);
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }
}

/** Build a Luogu adapter for one validated source instance. */
export function createLuoguAdapter(options: LuoguAdapterOptions): LuoguAdapter {
  return new LuoguAdapter(options);
}
