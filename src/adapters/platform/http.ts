/**
 * Official-origin HTTP transport for platform adapters.
 *
 * Design constraints that matter:
 * - one transport per source instance, shared by every operation, so the FIFO queue and the
 *   request pacing are shared by catalog, statement, submission and editorial requests alike
 *   (including their retries);
 * - every limit is explicit and validated; a platform-documented floor (Codeforces: 2000 ms)
 *   always wins over a lower caller value, constructor overrides and per-request limits alike;
 * - a request is only ever sent to the configured official origin. Redirects are resolved by
 *   this transport with `redirect: 'manual'`, so headers are never forwarded to another
 *   origin: a cross-origin redirect is refused instead of followed. URL userinfo (which
 *   `URL.origin` hides) and non-default ports are refused on the request URL and on every
 *   redirect target;
 * - no cookies and no TLS overrides: `credentials: 'omit'`, caller-supplied cookie headers are
 *   rejected and `set-cookie` is never read;
 * - cancellation is checked before queueing, while waiting for a pacing slot, during the fetch
 *   and the body read, and immediately before the response is returned. A request cancelled
 *   while it is still queued rejects at once and is never dispatched;
 * - the timeout covers the whole response (headers *and* body), not just the connect phase, and
 *   is raced against the fetch itself: an injected fetch that ignores its abort signal cannot
 *   hang the request, and a response arriving after the abort has its body cancelled;
 * - `Retry-After` is preserved exactly as declared; a delay above `maxRetryAfterMs` is reported
 *   as `rate_limited`/`unavailable` with `retryAfterMs` instead of retrying early;
 * - owned timers stay referenced while a request is pending, so a standalone Node process cannot
 *   exit before a paced request runs or is cancelled;
 * - a response body is capped in bytes while streaming, so an unexpected payload cannot exhaust
 *   memory before it is rejected; abort/teardown is best-effort and never awaited.
 */
import { DomainError, type CancellationToken } from '../../domain/index.js';
import { PlatformError, isPlatformError, type PlatformOperation } from '../../application/platform-errors.js';

/** Minimal structural view of a fetch response; real `Response` objects satisfy it. */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
      cancel(reason?: unknown): Promise<void>;
    };
  } | null;
}

export interface FetchInitLike {
  readonly method: 'GET';
  readonly headers: Record<string, string>;
  readonly redirect: 'manual';
  readonly credentials: 'omit';
  readonly signal: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;
export type ClockFn = () => number;
export type WaitFn = (ms: number, token: CancellationToken) => Promise<void>;
export type SetTimerFn = (callback: () => void, ms: number) => () => void;

/** Transport limits, all validated on construction and on every per-request override. */
export interface HttpLimits {
  readonly minRequestIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly maxResponseBytes: number;
}

export interface HttpTransportOptions {
  /** Official origin, e.g. `https://codeforces.com`. Normalized to scheme://host[:port]. */
  readonly origin: string;
  readonly minRequestIntervalMs?: number;
  /** Platform-documented floor that no caller setting may lower. */
  readonly platformMinRequestIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
  readonly maxRetryAfterMs?: number;
  /** Baseline request headers; cookie headers are rejected. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: FetchLike;
  readonly clock?: ClockFn;
  readonly wait?: WaitFn;
  readonly setTimer?: SetTimerFn;
}

export interface HttpRequestOptions {
  readonly token: CancellationToken;
  readonly operation: PlatformOperation;
  /** Non-2xx statuses the caller wants to inspect instead of receiving an error. */
  readonly acceptStatuses?: readonly number[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly limits?: Partial<HttpLimits>;
}

export interface HttpResponse {
  /** Final URL after same-origin redirects (never another origin). */
  readonly url: string;
  readonly status: number;
  /** Allow-listed headers only; `set-cookie` is never read. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** HTTP attempts this response took, including redirects and retries. */
  readonly attempts: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  minRequestIntervalMs: 2000,
  requestTimeoutMs: 30_000,
  maxRetries: 3,
  maxResponseBytes: 8 * 1024 * 1024,
};

export const HARD_MAX_RETRIES = 10;
export const MIN_RESPONSE_BYTES = 1024;
export const HARD_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const MAX_INTERVAL_MS = 600_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const HEADER_NAMES = ['content-length', 'content-type', 'location', 'retry-after'] as const;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set(['cookie', 'set-cookie']);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const UNSAFE_HEADER_VALUE = /[\u0000-\u001f\u007f]/u;

interface ResolvedRequest {
  readonly token: CancellationToken;
  readonly operation: PlatformOperation;
  readonly acceptStatuses: readonly number[];
  readonly headers: Record<string, string>;
}

interface RawResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Counts every HTTP request this transport actually dispatches, redirect hops included. */
interface AttemptCounter {
  count: number;
}

function requireInt(value: number, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PlatformError({
      code: 'invalid_input',
      operation: 'catalog',
      retryable: false,
      detail: `${name} must be an integer in [${min}, ${max}]`,
    });
  }
  return value;
}

function invalidInput(operation: PlatformOperation, detail: string): PlatformError {
  return new PlatformError({ code: 'invalid_input', operation, retryable: false, detail });
}

function cancelledError(token: CancellationToken): DomainError {
  return new DomainError('cancelled', token.reason ? `operation cancelled: ${token.reason}` : 'operation cancelled', {
    reason: token.reason,
  });
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw invalidInput('catalog', `origin must be an absolute URL: ${String(cause)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalidInput('catalog', `origin must use http(s), got ${parsed.protocol}`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw invalidInput('catalog', 'origin must not carry credentials');
  }
  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw invalidInput('catalog', 'origin must not carry a path, query or fragment');
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw invalidInput('catalog', `origin must use the default HTTPS port, got ${parsed.port}`);
  }
  return parsed.origin;
}

/**
 * Refuse URL shapes that never belong to an official endpoint: embedded credentials (which
 * `URL.origin` silently drops, so they would otherwise pass the origin comparison) and ports
 * other than the default HTTPS port.
 */
function assertOfficialUrlForm(
  parsed: URL,
  operation: PlatformOperation,
  code: 'invalid_input' | 'changed_response',
  label: string,
): void {
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new PlatformError({ code, operation, retryable: false, detail: `${label} must not embed credentials` });
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new PlatformError({
      code,
      operation,
      retryable: false,
      detail: `${label} must use the default HTTPS port, got ${parsed.port}`,
    });
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Parse `Retry-After` (delta seconds or HTTP date) into the declared delay in milliseconds.
 *
 * The declared delay is preserved exactly. The caller decides whether it may be honoured, so a
 * provider that asked for a longer pause than this transport allows is never retried early.
 */
function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (value === undefined) {
    return null;
  }
  const text = value.trim();
  if (text.length === 0) {
    return null;
  }
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(text);
  if (Number.isFinite(date)) {
    return Math.max(date - now, 0);
  }
  return null;
}

function collectHeaders(response: FetchResponseLike): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of HEADER_NAMES) {
    const value = response.headers.get(name);
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

const ABORTED = Symbol('aborted');

/** Resolve as soon as `signal` aborts; lets an attempt race a fetch that ignores its signal. */
function waitForAbort(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });
}

/**
 * Best-effort teardown of a response the transport no longer reads: a late body must not keep a
 * socket or stream alive behind a request that already settled.
 *
 * Deferred into a promise chain so a synchronous throw from an already-locked or disturbed
 * stream still lands in the catch, and never awaited: teardown must not be able to hang the
 * caller or replace the failure that actually ended the attempt.
 */
function discardBody(response: FetchResponseLike): void {
  const body = response.body;
  if (body === null) {
    return;
  }
  void Promise.resolve()
    .then(() => body.getReader().cancel())
    .catch(() => undefined);
}

function validateHeaders(
  operation: PlatformOperation,
  base: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [rawName, rawValue] of [...Object.entries(base), ...Object.entries(extra ?? {})]) {
    const name = rawName.trim().toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw invalidInput(operation, `header ${name} is not supported: the transport never sends or stores cookies`);
    }
    if (!HEADER_NAME.test(name)) {
      throw invalidInput(operation, `invalid header name ${JSON.stringify(rawName)}`);
    }
    if (typeof rawValue !== 'string' || UNSAFE_HEADER_VALUE.test(rawValue)) {
      throw invalidInput(operation, `invalid value for header ${name}`);
    }
    merged[name] = rawValue;
  }
  return merged;
}

const defaultFetch: FetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return { status: response.status, headers: response.headers, body: response.body };
};

const defaultWait: WaitFn = (ms, token) => {
  token.throwIfCancelled();
  return new Promise<void>((resolve, reject) => {
    let off: () => void = () => {};
    // Deliberately not unref'd: this timer belongs to a request that is still pending, so a
    // standalone Node process must stay alive until the paced request runs or is cancelled.
    const timer = setTimeout(() => {
      off();
      resolve();
    }, ms);
    off = token.onCancel(() => {
      clearTimeout(timer);
      reject(cancelledError(token));
    });
  });
};

const defaultSetTimer: SetTimerFn = (callback, ms) => {
  // Referenced on purpose, for the same reason as `defaultWait`: an in-flight request owns this
  // timeout, and the process must not exit while that request can still complete or fail.
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/**
 * Serialized, paced, cancellable HTTP transport bound to one official origin.
 *
 * Requests are queued FIFO. Pacing state is shared by every request and every retry, so the
 * interval is honoured globally rather than per call site.
 */
export class HttpTransport {
  readonly origin: string;
  /** `minRequestIntervalMs` after the platform floor is applied. */
  readonly effectiveMinRequestIntervalMs: number;

  private readonly defaultLimits: HttpLimits;
  private readonly platformFloorMs: number;
  private readonly maxRedirects: number;
  private readonly maxRetryAfterMs: number;
  private readonly baseHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: FetchLike;
  private readonly clock: ClockFn;
  private readonly waitImpl: WaitFn;
  private readonly setTimer: SetTimerFn;
  private queueTail: Promise<void> = Promise.resolve();
  private nextSlotAt: number | null = null;

  constructor(options: HttpTransportOptions) {
    this.origin = normalizeOrigin(options.origin);
    this.platformFloorMs = requireInt(
      options.platformMinRequestIntervalMs ?? 0,
      'platformMinRequestIntervalMs',
      0,
      MAX_INTERVAL_MS,
    );
    this.defaultLimits = {
      minRequestIntervalMs: requireInt(
        options.minRequestIntervalMs ?? DEFAULT_HTTP_LIMITS.minRequestIntervalMs,
        'minRequestIntervalMs',
        0,
        MAX_INTERVAL_MS,
      ),
      requestTimeoutMs: requireInt(
        options.requestTimeoutMs ?? DEFAULT_HTTP_LIMITS.requestTimeoutMs,
        'requestTimeoutMs',
        1,
        MAX_INTERVAL_MS,
      ),
      maxRetries: requireInt(options.maxRetries ?? DEFAULT_HTTP_LIMITS.maxRetries, 'maxRetries', 0, HARD_MAX_RETRIES),
      maxResponseBytes: requireInt(
        options.maxResponseBytes ?? DEFAULT_HTTP_LIMITS.maxResponseBytes,
        'maxResponseBytes',
        MIN_RESPONSE_BYTES,
        HARD_MAX_RESPONSE_BYTES,
      ),
    };
    this.maxRedirects = requireInt(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, 'maxRedirects', 0, 10);
    this.maxRetryAfterMs = requireInt(
      options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
      'maxRetryAfterMs',
      0,
      MAX_INTERVAL_MS,
    );
    this.baseHeaders = validateHeaders('catalog', options.headers ?? {}, undefined);
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.clock = options.clock ?? (() => Date.now());
    this.waitImpl = options.wait ?? defaultWait;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.effectiveMinRequestIntervalMs = Math.max(this.defaultLimits.minRequestIntervalMs, this.platformFloorMs);
  }

  /**
   * Issue one GET request to the official origin.
   *
   * Resolves with the response for 2xx and for `acceptStatuses` statuses; rejects with a
   * {@link PlatformError} for every other failure, and with a `cancelled` DomainError when the
   * token is cancelled at any point.
   */
  async request(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
    const limits = this.resolveLimits(options.limits);
    const target = this.resolveUrl(url, options.operation);
    const headers = validateHeaders(options.operation, this.baseHeaders, options.headers);
    const acceptStatuses = [...(options.acceptStatuses ?? [])];
    for (const status of acceptStatuses) {
      requireInt(status, 'acceptStatuses entry', 100, 599);
    }
    options.token.throwIfCancelled();
    const resolved: ResolvedRequest = {
      token: options.token,
      operation: options.operation,
      acceptStatuses,
      headers,
    };
    return this.rejectWhenCancelled(this.enqueue(() => this.execute(target, resolved, limits)), options.token);
  }

  private resolveUrl(url: string, operation: PlatformOperation): string {
    let parsed: URL;
    try {
      parsed = new URL(url, this.origin);
    } catch (cause) {
      throw invalidInput(operation, `request url must be absolute or rooted: ${String(cause)}`);
    }
    assertOfficialUrlForm(parsed, operation, 'invalid_input', 'request url');
    if (parsed.origin !== this.origin) {
      throw invalidInput(operation, `refusing a request outside the official origin ${this.origin}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw invalidInput(operation, `request url must use http(s), got ${parsed.protocol}`);
    }
    return parsed.toString();
  }

  private resolveLimits(override: Partial<HttpLimits> | undefined): HttpLimits {
    return {
      minRequestIntervalMs: Math.max(
        requireInt(override?.minRequestIntervalMs ?? this.defaultLimits.minRequestIntervalMs, 'minRequestIntervalMs', 0, MAX_INTERVAL_MS),
        this.platformFloorMs,
      ),
      requestTimeoutMs: requireInt(
        override?.requestTimeoutMs ?? this.defaultLimits.requestTimeoutMs,
        'requestTimeoutMs',
        1,
        MAX_INTERVAL_MS,
      ),
      maxRetries: requireInt(override?.maxRetries ?? this.defaultLimits.maxRetries, 'maxRetries', 0, HARD_MAX_RETRIES),
      maxResponseBytes: requireInt(
        override?.maxResponseBytes ?? this.defaultLimits.maxResponseBytes,
        'maxResponseBytes',
        MIN_RESPONSE_BYTES,
        HARD_MAX_RESPONSE_BYTES,
      ),
    };
  }

  /** FIFO queue: a request runs only after every request queued before it settled. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(task);
    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Settle as soon as `token` is cancelled, even while the request is still queued behind an
   * earlier one. The queued task keeps its FIFO slot and observes the cancelled token before it
   * dispatches anything; a non-cancellation failure from the task passes through unchanged.
   */
  private rejectWhenCancelled<T>(pending: Promise<T>, token: CancellationToken): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let off: () => void = () => {};
      off = token.onCancel(() => {
        off();
        reject(cancelledError(token));
      });
      pending.then(
        (value) => {
          off();
          resolve(value);
        },
        (error: unknown) => {
          off();
          reject(error);
        },
      );
    });
  }

  /** Wait for this request's pacing slot and reserve the next one. */
  private async pace(intervalMs: number, token: CancellationToken): Promise<void> {
    token.throwIfCancelled();
    const scheduled = this.nextSlotAt;
    const now = this.clock();
    if (scheduled !== null && scheduled > now) {
      await this.waitImpl(scheduled - now, token);
      token.throwIfCancelled();
    }
    this.nextSlotAt = Math.max(this.clock(), scheduled ?? this.clock()) + intervalMs;
  }

  private async execute(url: string, request: ResolvedRequest, limits: HttpLimits): Promise<HttpResponse> {
    const counter: AttemptCounter = { count: 0 };
    for (let round = 0; ; round += 1) {
      await this.pace(limits.minRequestIntervalMs, request.token);
      try {
        const response = await this.followRedirects(url, request, limits, counter);
        if (!isSuccess(response.status) && !request.acceptStatuses.includes(response.status)) {
          throw this.statusError(
            response.status,
            response.url,
            request.operation,
            parseRetryAfter(response.headers['retry-after'], this.clock()),
          );
        }
        request.token.throwIfCancelled();
        return {
          url: response.url,
          status: response.status,
          headers: response.headers,
          body: response.body,
          attempts: counter.count,
        };
      } catch (cause) {
        request.token.throwIfCancelled();
        const error = isPlatformError(cause) ? cause : this.transportFailure(cause, request.operation);
        if (
          (error.retryAfterMs !== null && error.retryAfterMs > this.maxRetryAfterMs) ||
          round >= limits.maxRetries ||
          !error.retryable
        ) {
          // Either the retry budget is spent, the failure is terminal, or the provider asked for
          // a longer pause than this transport may take: report the declared delay instead of
          // retrying early. The real attempt count (redirect hops included) is only known here.
          throw this.withAttempts(error, counter.count);
        }
        if (error.retryAfterMs !== null && error.retryAfterMs > 0) {
          await this.waitImpl(error.retryAfterMs, request.token);
        }
      }
    }
  }

  /** Rebuild an error with the total number of dispatched HTTP requests. */
  private withAttempts(error: PlatformError, attempts: number): PlatformError {
    return new PlatformError({
      code: error.code,
      operation: error.operation,
      detail: error.detail,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      attempts,
      sample: error.sample,
    });
  }

  private async followRedirects(
    url: string,
    request: ResolvedRequest,
    limits: HttpLimits,
    counter: AttemptCounter,
  ): Promise<RawResponse> {
    let current = url;
    const visited = new Set<string>([url]);
    for (let hop = 0; ; hop += 1) {
      if (hop > 0) {
        await this.pace(limits.minRequestIntervalMs, request.token);
      }
      const response = await this.fetchAttempt(current, request, limits, counter);
      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }
      const location = response.headers['location'];
      if (location === undefined || location.trim().length === 0) {
        throw new PlatformError({
          code: 'unavailable',
          operation: request.operation,
          retryable: false,
          detail: `redirect from ${this.pathOf(current)} has no Location header`,
        });
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch (cause) {
        throw new PlatformError({
          code: 'changed_response',
          operation: request.operation,
          retryable: false,
          detail: `redirect target is not a valid URL: ${String(cause)}`,
          sample: location,
        });
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new PlatformError({
          code: 'changed_response',
          operation: request.operation,
          retryable: false,
          detail: `redirect to unsupported protocol ${next.protocol}`,
        });
      }
      assertOfficialUrlForm(next, request.operation, 'changed_response', 'the redirect target');
      if (next.origin !== this.origin) {
        throw new PlatformError({
          code: 'unavailable',
          operation: request.operation,
          retryable: false,
          detail: `refused a redirect from ${this.pathOf(current)} to another origin`,
        });
      }
      if (hop >= this.maxRedirects) {
        throw new PlatformError({
          code: 'unavailable',
          operation: request.operation,
          retryable: false,
          detail: `more than ${this.maxRedirects} redirects for ${this.pathOf(url)}`,
        });
      }
      const nextUrl = next.toString();
      if (visited.has(nextUrl)) {
        throw new PlatformError({
          code: 'changed_response',
          operation: request.operation,
          retryable: false,
          detail: `redirect loop detected at ${next.pathname}`,
        });
      }
      visited.add(nextUrl);
      current = nextUrl;
    }
  }

  private async fetchAttempt(
    url: string,
    request: ResolvedRequest,
    limits: HttpLimits,
    counter: AttemptCounter,
  ): Promise<RawResponse> {
    counter.count += 1;
    const controller = new AbortController();
    let timedOut = false;
    const clearTimer = this.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, limits.requestTimeoutMs);
    const offCancel = request.token.onCancel(() => controller.abort());
    const aborted = waitForAbort(controller.signal);
    try {
      const fetchPromise = this.fetchImpl(url, {
        method: 'GET',
        headers: request.headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
      // A fetch implementation may ignore the signal, so the abort is raced against the fetch
      // itself: timeout and cancellation stay effective, and a response that still arrives after
      // the abort has its body cancelled instead of being left open behind a settled request.
      const outcome = await Promise.race([fetchPromise, aborted]);
      if (outcome === ABORTED) {
        void fetchPromise.then((late) => discardBody(late), () => undefined);
        request.token.throwIfCancelled();
        throw timedOut
          ? this.timeoutError(request.operation, url, limits.requestTimeoutMs)
          : this.transportFailure(new Error('request aborted before a response'), request.operation);
      }
      const body = await this.readBody(outcome, limits.maxResponseBytes, aborted, request.operation);
      request.token.throwIfCancelled();
      if (timedOut) {
        throw this.timeoutError(request.operation, url, limits.requestTimeoutMs);
      }
      return { url, status: outcome.status, headers: collectHeaders(outcome), body };
    } catch (cause) {
      // Stop the underlying request even when a local validation failure ends the read.
      controller.abort();
      request.token.throwIfCancelled();
      if (timedOut) {
        throw this.timeoutError(request.operation, url, limits.requestTimeoutMs);
      }
      if (isPlatformError(cause)) {
        throw cause;
      }
      throw this.transportFailure(cause, request.operation);
    } finally {
      clearTimer();
      offCancel();
    }
  }

  private async readBody(
    response: FetchResponseLike,
    cap: number,
    aborted: Promise<typeof ABORTED>,
    operation: PlatformOperation,
  ): Promise<string> {
    const declared = response.headers.get('content-length');
    if (declared !== null) {
      const length = Number(declared.trim());
      if (Number.isFinite(length) && length > cap) {
        discardBody(response);
        throw this.payloadError(operation, cap, length);
      }
    }
    if (response.body === null) {
      return '';
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let complete = false;
    try {
      for (;;) {
        const reading = reader.read();
        // The abort may win the race below and abandon the pending read; this keeps the
        // torn-down stream from surfacing as an unhandled rejection. The failure that is
        // actually reported is the abort, not the stream teardown.
        void reading.catch(() => undefined);
        const outcome = await Promise.race([reading, aborted]);
        if (outcome === ABORTED) {
          throw new PlatformError({
            code: 'unavailable',
            operation,
            retryable: true,
            detail: 'request aborted',
          });
        }
        if (outcome.done) {
          complete = true;
          break;
        }
        const value = outcome.value;
        if (value === undefined) {
          continue;
        }
        total += value.byteLength;
        if (total > cap) {
          throw this.payloadError(operation, cap, total);
        }
        chunks.push(value);
      }
      return new TextDecoder('utf-8').decode(concat(chunks, total));
    } finally {
      if (!complete) {
        // Never awaited: a body whose `cancel` never settles, or one already torn down by the
        // abort, must neither hang the failing attempt nor keep the underlying request open.
        void Promise.resolve()
          .then(() => reader.cancel())
          .catch(() => undefined);
      }
    }
  }

  private payloadError(operation: PlatformOperation, cap: number, actual: number): PlatformError {
    return new PlatformError({
      code: 'changed_response',
      operation,
      retryable: false,
      detail: `response exceeds the ${cap} byte cap (at least ${actual} bytes)`,
    });
  }

  private timeoutError(operation: PlatformOperation, url: string, timeoutMs: number): PlatformError {
    return new PlatformError({
      code: 'unavailable',
      operation,
      retryable: true,
      detail: `request to ${this.pathOf(url)} timed out after ${timeoutMs} ms`,
    });
  }

  private transportFailure(cause: unknown, operation: PlatformOperation): PlatformError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new PlatformError({
      code: 'unavailable',
      operation,
      retryable: true,
      detail: `network failure: ${message}`,
    });
  }

  private statusError(
    status: number,
    url: string,
    operation: PlatformOperation,
    retryAfterMs: number | null,
  ): PlatformError {
    const path = this.pathOf(url);
    if (status === 401) {
      return new PlatformError({
        code: 'auth_required',
        operation,
        retryable: false,
        detail: `HTTP 401 from ${path}: authentication is required`,
      });
    }
    if (status === 403) {
      return new PlatformError({
        code: 'forbidden',
        operation,
        retryable: false,
        detail: `HTTP 403 from ${path}`,
      });
    }
    if (status === 429) {
      return new PlatformError({
        code: 'rate_limited',
        operation,
        retryable: true,
        retryAfterMs,
        detail: `HTTP 429 from ${path}`,
      });
    }
    if (isRetryableStatus(status)) {
      return new PlatformError({
        code: 'unavailable',
        operation,
        retryable: true,
        retryAfterMs,
        detail: `HTTP ${status} from ${path}`,
      });
    }
    return new PlatformError({
      code: 'unavailable',
      operation,
      retryable: false,
      detail: `HTTP ${status} from ${path}`,
    });
  }

  /** Path only: query strings may carry account-specific values and never enter errors. */
  private pathOf(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return 'the official origin';
    }
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
