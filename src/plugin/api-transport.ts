/**
 * Shared HTTP envelope and exact-route primitives (Stage 4h0).
 *
 * Every workbench endpoint is one exact Fetch route below `/api/icpc/v1/`. This module owns the
 * parts that must be identical on every route: the fixed prefix and operation identity, the
 * bounded streaming request-body reader, the cancellation bridge, the versioned response
 * envelope, and the sanitized failure mapping. A business handler receives an already validated,
 * plain input value plus one cancellation token and never touches a `Request` or a `Response`.
 *
 * Authentication is not implemented here: the host Connection carrier authenticates and
 * origin-checks the request before this Fetch callback is invoked, so a handler can trust that it
 * runs on an authenticated, same-origin call. Nothing in this module contacts a model provider,
 * the storage layer or the network, and no request body content is ever logged.
 */
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { createCancellationSource, type CancellationToken } from '../domain/index.js';

/** Envelope version every route below {@link API_PREFIX} speaks. */
export const API_VERSION = 1;
/** Fixed path prefix of the private workbench API. */
export const API_PREFIX = '/api/icpc/v1/';
/** Hard cap on one request body, in bytes; checked before and while the body is read. */
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
/** Whole-body deadline; a reader that ignores cancellation cannot park a request past it. */
export const API_BODY_TIMEOUT_MS = 30_000;
/** Response content type of the versioned envelope. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
/** Response cache directive: every answer is per-user and must not be stored. */
export const NO_STORE_CACHE_CONTROL = 'no-store';
/** Longest accepted operation identifier. */
export const MAX_OPERATION_LENGTH = 128;

/** Stable failure codes of the transport envelope. */
export type ApiErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'timeout'
  | 'cancelled'
  | 'internal';

/** HTTP status of each stable failure code. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  timeout: 408,
  cancelled: 499,
  internal: 500,
};

/** Fixed message of each code, used whenever a typed error supplies none. */
const DEFAULT_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  invalid_input: 'the request is invalid',
  not_found: 'the requested resource does not exist',
  conflict: 'the request conflicts with the current state',
  payload_too_large: `the request body exceeds the ${MAX_API_BODY_BYTES}-byte limit`,
  unsupported_media_type: 'the request body must be sent as application/json',
  timeout: 'the request did not complete in time',
  cancelled: 'the request was cancelled',
  internal: 'the request failed',
};

/** Failure body carried by a failed envelope. */
export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
}

/**
 * Versioned response envelope.
 *
 * A successful answer always carries its value; a failure always carries a stable code and a
 * message that is safe to show. `internal` never describes the underlying failure.
 */
export type ApiEnvelope<T> =
  | { readonly apiVersion: typeof API_VERSION; readonly ok: true; readonly value: T }
  | { readonly apiVersion: typeof API_VERSION; readonly ok: false; readonly error: ApiErrorBody };

/**
 * Typed transport failure a handler may throw to choose a safe code, message and status.
 *
 * Anything else a handler throws becomes a sanitized `internal` failure, so no stack, SQL text,
 * database path or provider string can reach a caller.
 */
export class ApiTransportError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message?: string) {
    super(nonEmptyText(message) ?? DEFAULT_ERROR_MESSAGES[code]);
    this.name = 'ApiTransportError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
  }
}

/** Methods this registry accepts; the host carrier dispatches everything else elsewhere. */
export type ApiRouteMethod = 'GET' | 'POST';

/**
 * One registered route.
 *
 * `validate` receives the decoded JSON root object (`{}` for `GET`, which accepts no query or
 * body) and either returns the typed input or refuses it — an {@link ApiTransportError} keeps its
 * own safe code and status, while any other throw is a programmer error that becomes the same
 * sanitized `internal` failure as an unexpected handler error. `handle` receives that typed input
 * and a
 * token that is cancelled when the client aborts; it must not start paid or long work after the
 * token is cancelled. `successStatus` is 200 for a synchronous answer and 202 for a request that
 * only starts a persisted job; the body envelope is the same in both cases.
 */
export interface ApiRouteSpec<T, R> {
  /** Static operation identifier: letters, digits, dots and hyphens, starting with a letter. */
  readonly operation: string;
  readonly method: ApiRouteMethod;
  readonly validate: (value: unknown) => T;
  readonly handle: (input: T, token: CancellationToken) => Promise<R>;
  /** Defaults to 200. */
  readonly successStatus?: 200 | 202;
}

/** What a route's own diagnostics see. */
export interface ApiInternalErrorContext {
  readonly operation: string;
  readonly method: ApiRouteMethod;
}

/** Optional registration hooks. */
export interface ApiRouteOptions {
  /**
   * Observer for failures a handler or validator could not describe, including programmer errors.
   * It runs before the sanitized 500 is returned. A throwing observer never changes the response:
   * it is contained and replaced by one fixed process warning that carries no failure detail.
   */
  readonly onInternalError?: (error: unknown, context: ApiInternalErrorContext) => void;
}

/** Operation identifiers: `problems.list`, `tag-analysis` are valid; paths and spaces are not. */
const OPERATION_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/;

/**
 * Register one exact route on the host Connection Fetch registry.
 *
 * The route is fixed to `GET`/`POST` below {@link API_PREFIX} with `requestBody: 'streaming'`, and
 * the returned disposer releases exactly that contribution. Registration failures are programmer
 * errors and throw immediately; nothing is registered unless the whole specification is valid.
 */
export function registerApiRoute<T, R>(
  registry: HostConnectionFetch,
  spec: ApiRouteSpec<T, R>,
  options: ApiRouteOptions = {},
): () => Promise<void> {
  if (spec === null || typeof spec !== 'object') {
    throw new TypeError('an API route specification must be an object');
  }
  const operation = requireOperation(spec.operation);
  const method = requireMethod(spec.method);
  const successStatus = spec.successStatus ?? 200;
  if (successStatus !== 200 && successStatus !== 202) {
    throw new TypeError(`ApiRouteSpec.successStatus must be 200 or 202 (received ${String(spec.successStatus)})`);
  }
  if (typeof spec.validate !== 'function') {
    throw new TypeError(`route ${operation} must supply validate(unknown)`);
  }
  if (typeof spec.handle !== 'function') {
    throw new TypeError(`route ${operation} must supply handle(input, token)`);
  }
  if (registry === null || typeof registry !== 'object' || typeof registry.register !== 'function') {
    throw new TypeError('the connection Fetch registry must expose register(route)');
  }
  if (options.onInternalError !== undefined && typeof options.onInternalError !== 'function') {
    throw new TypeError('ApiRouteOptions.onInternalError must be a function when supplied');
  }
  const prepared: PreparedRoute<T, R> = {
    operation,
    method,
    successStatus,
    ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError }),
    validate: spec.validate,
    handle: spec.handle,
  };
  const route: ConnectionFetchRoute = {
    path: `${API_PREFIX}${operation}`,
    methods: [method],
    requestBody: 'streaming',
    fetch: (request) =>
      serve(prepared, request).catch((error: unknown) => {
        // The last containment barrier: even a failure outside the handler path answers with the
        // sanitized envelope instead of rejecting into the carrier.
        reportInternal(prepared, error);
        return errorResponse('internal');
      }),
  };
  const registered = registry.register(route);
  if (typeof registered !== 'function') {
    throw new TypeError('the connection Fetch registry did not return a disposer');
  }
  let disposed = false;
  return async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await registered();
  };
}

/** A validated route plus its registration-time hooks. */
interface RouteContext {
  readonly operation: string;
  readonly method: ApiRouteMethod;
  readonly successStatus: 200 | 202;
  readonly onInternalError?: ApiRouteOptions['onInternalError'];
}

interface PreparedRoute<T, R> extends RouteContext {
  readonly validate: (value: unknown) => T;
  readonly handle: (input: T, token: CancellationToken) => Promise<R>;
}

/** One served request under one global body deadline and the client's abort signal. */
async function serve<T, R>(route: PreparedRoute<T, R>, request: Request): Promise<Response> {
  // The bridge is established synchronously: an abort that happened before this call is observed
  // immediately, and one that happens later cancels the token before any handler runs.
  const source = createCancellationSource();
  const token = source.token;
  const onAbort = (): void => source.cancel('the client aborted the request');
  let release = (): void => {};
  if (request.signal.aborted) {
    onAbort();
  } else {
    request.signal.addEventListener('abort', onAbort, { once: true });
    release = (): void => request.signal.removeEventListener('abort', onAbort);
  }
  try {
    const input = await readInput(route.method, request, token);
    if (input.kind === 'response') {
      return input.response;
    }
    if (token.cancelled) {
      return errorResponse('cancelled');
    }
    let value: T;
    try {
      value = route.validate(input.value);
    } catch (error) {
      // A typed refusal is the validator's own decision. Any other throw is a programmer error,
      // not client input, so it is sanitized and observed exactly like an unexpected handler error.
      if (error instanceof ApiTransportError) {
        return errorResponse(error.code, error.message);
      }
      reportInternal(route, error);
      return errorResponse('internal');
    }
    if (token.cancelled) {
      return errorResponse('cancelled');
    }
    let pending: Promise<R>;
    try {
      pending = route.handle(value, token);
    } catch (error) {
      return failureResponse(route, error);
    }
    const raced = await raceCancellation(Promise.resolve(pending), token);
    if (raced.kind === 'value') {
      // The second checkpoint: a value that arrived after the client aborted is not delivered.
      return token.cancelled ? errorResponse('cancelled') : successResponse(route, raced.value);
    }
    if (raced.kind === 'cancelled') {
      return errorResponse('cancelled');
    }
    if (raced.kind === 'error') {
      return failureResponse(route, raced.error);
    }
    // Not reachable: a cancellation-only race has no deadline to miss. Reported as a plugin bug
    // rather than silently answered as a success.
    reportInternal(route, new Error('the handler race settled on a deadline it does not have'));
    return errorResponse('internal');
  } finally {
    release();
  }
}

/** Either the decoded input for `validate`, or the refusal that ends the request. */
type InputOutcome =
  | { readonly kind: 'input'; readonly value: unknown }
  | { readonly kind: 'response'; readonly response: Response };

/**
 * Decode one request into the value a validator sees.
 *
 * `GET` owns no query string and no body and always validates `{}`. `POST` requires a JSON media
 * type, refuses an oversized or malformed `Content-Length` before reading a byte, reads under the
 * body deadline with an incremental byte cap, and only then decodes UTF-8 once and parses JSON.
 * Every refusal is a fixed message: no body content, parser position or header echo is returned.
 */
async function readInput(method: ApiRouteMethod, request: Request, token: CancellationToken): Promise<InputOutcome> {
  if (method === 'GET') {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return { kind: 'response', response: errorResponse('invalid_input', 'the request URL could not be read') };
    }
    if (url.search.length > 0 && url.search !== '?') {
      return { kind: 'response', response: errorResponse('invalid_input', 'GET routes do not accept a query string') };
    }
    if (request.body !== null) {
      return { kind: 'response', response: errorResponse('invalid_input', 'GET routes do not accept a request body') };
    }
    return { kind: 'input', value: {} };
  }
  const mediaProblem = mediaTypeProblem(request.headers.get('content-type'));
  if (mediaProblem !== null) {
    return { kind: 'response', response: errorResponse('unsupported_media_type', mediaProblem) };
  }
  const length = contentLength(request.headers.get('content-length'));
  if (length === 'invalid') {
    return {
      kind: 'response',
      response: errorResponse('invalid_input', 'the Content-Length header is not a non-negative integer'),
    };
  }
  if (length === 'too_large') {
    return {
      kind: 'response',
      response: errorResponse('payload_too_large', `the request body exceeds the ${MAX_API_BODY_BYTES}-byte limit`),
    };
  }
  const body = await readBoundedBody(request, token);
  if (body.kind === 'failed') {
    return { kind: 'response', response: errorResponse(body.error.code, body.error.message) };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
  } catch {
    return { kind: 'response', response: errorResponse('invalid_input', 'the request body is not valid UTF-8') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'response', response: errorResponse('invalid_input', 'the request body is not valid JSON') };
  }
  if (!isPlainObject(parsed)) {
    return { kind: 'response', response: errorResponse('invalid_input', 'the request body must be a JSON object') };
  }
  return { kind: 'input', value: parsed };
}

/** Outcome of reading a bounded body. */
type BodyOutcome =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'failed'; readonly error: ApiTransportError };

/**
 * Read the request body under one deadline with an incremental byte cap.
 *
 * The cap is applied to the running total before a chunk is kept, so an oversized body is refused
 * without concatenating what was received. A reader that ignores cancellation is abandoned: the
 * stream is cancelled best-effort and never awaited, so a hung reader cannot hold the request.
 */
async function readBoundedBody(request: Request, token: CancellationToken): Promise<BodyOutcome> {
  const stream = request.body;
  if (stream === null) {
    return { kind: 'bytes', bytes: new Uint8Array(0) };
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return { kind: 'failed', error: new ApiTransportError('invalid_input', 'the request body could not be read') };
  }
  const deadline = Date.now() + API_BODY_TIMEOUT_MS;
  const body = new BodyAccumulator();
  for (;;) {
    const step = await raceRead(reader.read(), deadline, token);
    if (step.kind === 'cancelled') {
      abandon(reader);
      return { kind: 'failed', error: new ApiTransportError('cancelled', 'the client aborted the request') };
    }
    if (step.kind === 'timeout') {
      abandon(reader);
      return { kind: 'failed', error: new ApiTransportError('timeout', 'the request body was not received in time') };
    }
    if (step.kind === 'error') {
      abandon(reader);
      return { kind: 'failed', error: new ApiTransportError('invalid_input', 'the request body could not be read') };
    }
    if (step.value.done === true) {
      releaseFinishedReader(reader);
      return { kind: 'bytes', bytes: body.toBytes() };
    }
    const chunk = step.value.value;
    if (chunk === undefined) {
      continue;
    }
    if (!body.append(chunk)) {
      abandon(reader);
      return {
        kind: 'failed',
        error: new ApiTransportError('payload_too_large', `the request body exceeds the ${MAX_API_BODY_BYTES}-byte limit`),
      };
    }
  }
}

/**
 * Bounded accumulation of one request body.
 *
 * Accepted bytes are copied into a single growing buffer. Keeping one buffer instead of the
 * stream's chunks means a source that reuses its buffer cannot rewrite bytes that were already
 * accepted, zero-length chunks cost nothing, and the retained memory never exceeds
 * {@link MAX_API_BODY_BYTES}.
 */
class BodyAccumulator {
  private buffer = new Uint8Array(0);
  private size = 0;

  /** Copy one chunk in; `false` means the body would exceed the cap. Empty chunks are ignored. */
  append(chunk: Uint8Array): boolean {
    const length = chunk.byteLength;
    if (length === 0) {
      return true;
    }
    if (this.size + length > MAX_API_BODY_BYTES) {
      return false;
    }
    this.reserve(this.size + length);
    this.buffer.set(chunk, this.size);
    this.size += length;
    return true;
  }

  /** The accepted bytes, copied to their exact length unless the buffer already fits them. */
  toBytes(): Uint8Array {
    return this.size === this.buffer.byteLength ? this.buffer : this.buffer.slice(0, this.size);
  }

  /** Grow geometrically so many small chunks cost linear copying and at most the cap. */
  private reserve(needed: number): void {
    if (needed <= this.buffer.byteLength) {
      return;
    }
    const grown = Math.min(
      MAX_API_BODY_BYTES,
      Math.max(needed, this.buffer.byteLength === 0 ? 4096 : this.buffer.byteLength * 2),
    );
    const next = new Uint8Array(grown);
    next.set(this.buffer.subarray(0, this.size));
    this.buffer = next;
  }
}

/** Release a stream without ever awaiting it; a reader that hangs on cancel must not park us. */
function abandon(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const pending: unknown = reader.cancel();
    if (pending !== null && typeof pending === 'object' && typeof (pending as { then?: unknown }).then === 'function') {
      void Promise.resolve(pending).then(
        () => undefined,
        () => undefined,
      );
    }
  } catch (error) {
    // The reader is already unusable (locked, errored or closed); there is nothing left to release.
    discard(error);
  }
}

/** Release a reader whose stream ended normally, so the underlying source is not held. */
function releaseFinishedReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch (error) {
    // A finished reader can only refuse release when it is already detached; cleanup after a
    // complete body read must not change the request outcome.
    discard(error);
  }
}

/** Explicitly drop a cleanup failure that has no reporting channel and cannot change the answer. */
function discard(_error: unknown): void {
  // Deliberately empty: every call site documents why the dropped failure is inconsequential.
}

/** `Content-Length` classification performed before any byte of the body is read. */
function contentLength(raw: string | null): 'missing' | 'ok' | 'invalid' | 'too_large' {
  if (raw === null) {
    return 'missing';
  }
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return 'invalid';
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return 'invalid';
  }
  return value > MAX_API_BODY_BYTES ? 'too_large' : 'ok';
}

/** Fixed problem of an unusable media type, or `null` when the header is acceptable. */
function mediaTypeProblem(raw: string | null): string | null {
  if (raw === null) {
    return 'the request must declare Content-Type: application/json';
  }
  const [type, ...parameters] = raw.split(';');
  if (type === undefined || type.trim().toLowerCase() !== 'application/json') {
    return 'the request body must be declared as application/json';
  }
  for (const parameter of parameters) {
    const [name, ...rest] = parameter.split('=');
    if (name === undefined || name.trim().toLowerCase() !== 'charset') {
      return 'the request Content-Type carries an unsupported parameter';
    }
    const charset = rest.join('=').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
    if (charset !== 'utf-8' && charset !== 'utf8') {
      return 'only a UTF-8 request body is supported';
    }
  }
  return null;
}

/** JSON objects only: arrays and scalars never reach a validator as an input object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Map one failure to its response; only {@link ApiTransportError} may describe itself. */
function failureResponse(route: RouteContext, error: unknown): Response {
  if (error instanceof ApiTransportError) {
    return errorResponse(error.code, error.message);
  }
  reportInternal(route, error);
  return errorResponse('internal');
}

/** Offer an unexpected failure to the route's observer; the observer never changes the response. */
function reportInternal(route: RouteContext, error: unknown): void {
  const observer = route.onInternalError;
  if (observer === undefined) {
    return;
  }
  try {
    observer(error, { operation: route.operation, method: route.method });
  } catch {
    // Diagnostics are not part of the answer and must never recurse into the observer. The
    // fallback is one fixed warning with no failure text, provider string or path.
    reportObserverFailure();
  }
}

/** Fixed, sanitized diagnostic for an observer that failed; never includes the original failure. */
function reportObserverFailure(): void {
  try {
    process.emitWarning(
      'dsh-icpc-workbench: the API internal-error observer threw; the sanitized response was returned but the failure was not reported',
      { code: 'ICPC_API_OBSERVER_FAILED' },
    );
  } catch (error) {
    // A host without process warnings still receives the sanitized response.
    discard(error);
  }
}

/** Successful envelope: the value is serialized separately so a missing value cannot look like one. */
function successResponse(route: RouteContext, value: unknown): Response {
  let serialized: string;
  try {
    serialized = serializeJsonValue(value);
  } catch (error) {
    // A value JSON cannot carry losslessly is a handler bug, not a success with altered data.
    reportInternal(route, error);
    return errorResponse('internal');
  }
  return jsonResponse(route.successStatus, `{"apiVersion":${API_VERSION},"ok":true,"value":${serialized}}`);
}

/**
 * Serialize a value only when JSON can carry it without changing it.
 *
 * Finite numbers, strings, booleans, `null`, dense arrays and plain records are accepted. Anything
 * `JSON.stringify` would silently rewrite — `NaN`/`Infinity` to `null`, a `Map`, `Set`, `Date` or
 * class instance to `{}`, an `undefined` member to a dropped key — is refused, as are cycles,
 * accessors, sparse arrays and a custom `toJSON` that would replace the handler's data. The
 * failure is sanitized by the caller, so nothing about the value leaks to the client.
 */
function serializeJsonValue(value: unknown): string {
  return writeJsonValue(value, new Set<object>());
}

function writeJsonValue(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('a response value contains a number JSON cannot carry');
      }
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      return value === null ? 'null' : writeJsonObject(value, ancestors);
    default:
      throw new TypeError(`a response value contains ${typeof value}, which JSON cannot carry`);
  }
}

function writeJsonObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new TypeError('a response value contains a cycle');
  }
  if (hasEnumerableSymbolKeys(value)) {
    throw new TypeError('a response value contains symbol-keyed data');
  }
  ancestors.add(value);
  try {
    return Array.isArray(value) ? writeJsonArray(value, ancestors) : writeJsonRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

/** Dense arrays only: JSON has no representation for a hole or for named array properties. */
function writeJsonArray(value: readonly unknown[], ancestors: Set<object>): string {
  if (Object.keys(value).length !== value.length) {
    throw new TypeError('a response value contains an array JSON cannot carry');
  }
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('a response value contains an array JSON cannot carry');
    }
    parts.push(writeJsonValue(descriptor.value, ancestors));
  }
  return `[${parts.join(',')}]`;
}

/** Plain records only: the prototype must be `Object.prototype` or `null`. */
function writeJsonRecord(value: object, ancestors: Set<object>): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('a response value contains an object JSON cannot carry');
  }
  if (hasOwnToJSON(value)) {
    throw new TypeError('a response value defines toJSON, which would replace its data');
  }
  const parts: string[] = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('a response value contains an accessor property');
    }
    parts.push(`${JSON.stringify(key)}:${writeJsonValue(descriptor.value, ancestors)}`);
  }
  return `{${parts.join(',')}}`;
}

/** True when the object carries its own `toJSON` data function or getter. */
function hasOwnToJSON(value: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'toJSON');
  if (descriptor === undefined) {
    return false;
  }
  return 'value' in descriptor ? typeof descriptor.value === 'function' : true;
}

/** Enumerable symbol-keyed members have no JSON form and would otherwise be dropped silently. */
function hasEnumerableSymbolKeys(value: object): boolean {
  return Object.getOwnPropertySymbols(value).some(
    (symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true,
  );
}

/** Failed envelope with a stable code, a safe message and the code's own status. */
function errorResponse(code: ApiErrorCode, message?: string): Response {
  const text = nonEmptyText(message) ?? DEFAULT_ERROR_MESSAGES[code];
  const body: ApiEnvelope<never> = { apiVersion: API_VERSION, ok: false, error: { code, message: text } };
  return jsonResponse(API_ERROR_STATUS[code], JSON.stringify(body));
}

/** One JSON response; `no-store` because every answer is per-user. */
function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE, 'cache-control': NO_STORE_CACHE_CONTROL },
  });
}

/** Race one handler promise against cancellation; a cancelled handler is never awaited. */
function raceCancellation<T>(work: Promise<T>, token: CancellationToken): Promise<Raced<T>> {
  return race({ work, token, deadline: null });
}

/** Race one body read against the body deadline and cancellation. */
function raceRead<T>(work: Promise<T>, deadline: number, token: CancellationToken): Promise<Raced<T>> {
  return race({ work, token, deadline });
}

/** What one raced dependency settled on. */
type Raced<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout' };

/**
 * Race `work` against cancellation and, when given, a deadline.
 *
 * Every path observes `work`: the racing settlements route through the same `finish`, and the two
 * early returns attach handlers before they answer, so a late rejection of an abandoned handler or
 * reader is never an unhandled rejection.
 */
function race<T>(options: {
  readonly work: Promise<T>;
  readonly token: CancellationToken;
  readonly deadline: number | null;
}): Promise<Raced<T>> {
  const { work, token, deadline } = options;
  if (token.cancelled) {
    observeSettlement(work);
    return Promise.resolve<Raced<T>>({ kind: 'cancelled' });
  }
  const remaining = deadline === null ? null : deadline - Date.now();
  if (remaining !== null && remaining <= 0) {
    observeSettlement(work);
    return Promise.resolve<Raced<T>>({ kind: 'timeout' });
  }
  return new Promise<Raced<T>>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let off: (() => void) | undefined;
    const finish = (outcome: Raced<T>): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      off?.();
      resolve(outcome);
    };
    work.then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
    if (remaining !== null) {
      timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(1, remaining));
    }
    off = token.onCancel(() => finish({ kind: 'cancelled' }));
    if (token.cancelled) {
      finish({ kind: 'cancelled' });
    }
  });
}

/** Observe a settlement this race no longer waits for, without ever awaiting that work. */
function observeSettlement(work: Promise<unknown>): void {
  void work.then(
    () => undefined,
    () => undefined,
  );
}

/** Registration-time operation validation; an invalid identifier never reaches the carrier. */
function requireOperation(operation: unknown): string {
  if (
    typeof operation !== 'string' ||
    operation.length === 0 ||
    operation.length > MAX_OPERATION_LENGTH ||
    !OPERATION_PATTERN.test(operation)
  ) {
    throw new TypeError(
      `ApiRouteSpec.operation must be 1..${MAX_OPERATION_LENGTH} characters of letters, digits, dots and hyphens, starting with a letter (received ${JSON.stringify(operation)})`,
    );
  }
  return operation;
}

/** Registration-time method validation. */
function requireMethod(method: unknown): ApiRouteMethod {
  if (method !== 'GET' && method !== 'POST') {
    throw new TypeError(`ApiRouteSpec.method must be GET or POST (received ${JSON.stringify(method)})`);
  }
  return method;
}

function nonEmptyText(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
