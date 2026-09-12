/**
 * Shared HTTP envelope and exact-route registration (Stage 4h0).
 *
 * Every case drives the real registered Fetch callback with real `Request`/`Response` objects and a
 * real streaming body, so the transport contract is exercised end to end: exact path and body mode,
 * bounded reading, malformed input, the 30-second body deadline, the abort bridge, cancellation of
 * the handler, sanitized failures and the versioned success envelope. Nothing here opens a socket,
 * calls a model or touches storage.
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import {
  API_BODY_TIMEOUT_MS,
  API_ERROR_STATUS,
  API_PREFIX,
  API_VERSION,
  ApiTransportError,
  JSON_CONTENT_TYPE,
  MAX_API_BODY_BYTES,
  MAX_OPERATION_LENGTH,
  NO_STORE_CACHE_CONTROL,
  registerApiRoute,
  type ApiEnvelope,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiInternalErrorContext,
  type ApiRouteMethod,
  type ApiRouteOptions,
  type ApiRouteSpec,
} from '../../src/plugin/api-transport.js';
import type { CancellationToken } from '../../src/domain/index.js';

type TestInput = Record<string, unknown>;

interface HarnessOptions {
  readonly operation?: string;
  readonly method?: ApiRouteMethod;
  readonly successStatus?: 200 | 202;
  readonly validate?: (value: unknown) => TestInput;
  readonly handle?: (input: TestInput, token: CancellationToken) => Promise<unknown>;
  readonly routeOptions?: ApiRouteOptions;
}

interface Harness {
  readonly routes: ConnectionFetchRoute[];
  readonly calls: TestInput[];
  readonly tokens: CancellationToken[];
  readonly disposalCount: () => number;
  readonly dispose: () => Promise<void>;
  fetch(request: Request): Promise<Response>;
}

/** Register one route on a fake registry that records exactly what the host would receive. */
function harness(options: HarnessOptions = {}): Harness {
  const routes: ConnectionFetchRoute[] = [];
  const calls: TestInput[] = [];
  const tokens: CancellationToken[] = [];
  let disposals = 0;
  const registry: HostConnectionFetch = {
    register(route) {
      routes.push(route);
      return async () => {
        disposals += 1;
      };
    },
  };
  const dispose = registerApiRoute<TestInput, unknown>(
    registry,
    {
      operation: options.operation ?? 'test.run',
      method: options.method ?? 'POST',
      successStatus: options.successStatus,
      validate: options.validate ?? ((value) => value as TestInput),
      handle: async (input, token) => {
        calls.push(input);
        tokens.push(token);
        return options.handle === undefined ? { echo: input } : await options.handle(input, token);
      },
    },
    options.routeOptions,
  );
  return {
    routes,
    calls,
    tokens,
    disposalCount: () => disposals,
    dispose,
    fetch(request: Request): Promise<Response> {
      const route = routes[0];
      if (route === undefined) {
        throw new Error('the route was not registered');
      }
      return route.fetch(request);
    },
  };
}

function urlFor(operation = 'test.run'): string {
  return `http://localhost${API_PREFIX}${operation}`;
}

function getRequest(operation = 'test.run', query = ''): Request {
  return new Request(`${urlFor(operation)}${query}`, { method: 'GET' });
}

function postRequest(
  body: string,
  headers: Record<string, string> = { 'content-type': 'application/json' },
  signal?: AbortSignal,
): Request {
  return new Request(urlFor(), {
    method: 'POST',
    headers,
    body,
    ...(signal === undefined ? {} : { signal }),
  });
}

function streamPost(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string> = { 'content-type': 'application/json' },
  signal?: AbortSignal,
): Request {
  return new Request(urlFor(), {
    method: 'POST',
    headers,
    body: stream,
    duplex: 'half',
    ...(signal === undefined ? {} : { signal }),
  } as RequestInit & { duplex: 'half' });
}

function bytesRequest(bytes: Uint8Array): Request {
  return streamPost(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  );
}

async function envelope(response: Response): Promise<ApiEnvelope<unknown>> {
  return (await response.json()) as ApiEnvelope<unknown>;
}

function failureOf(body: ApiEnvelope<unknown>): ApiErrorBody {
  if (body.ok) {
    assert.fail(`expected a failed envelope, received ${JSON.stringify(body)}`);
  }
  return body.error;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run `work` while watching for unhandled promise rejections.
 *
 * The transport abandons work it no longer waits for; that work must still be observed, so this
 * guard proves a late rejection cannot escape into the runtime's unhandled-rejection path.
 */
async function withoutUnhandledRejections(work: () => Promise<void>): Promise<void> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await work();
    await tick();
    await tick();
  } finally {
    process.off('unhandledRejection', listener);
  }
  assert.deepEqual(seen, []);
}

// ---------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------

void test('GET registers a buffered body mode compatible with the host bridge', () => {
  const h = harness({ method: 'GET' });

  assert.equal(h.routes.length, 1);
  const route = h.routes[0];
  assert.ok(route);
  assert.equal(route.path, `${API_PREFIX}test.run`);
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.requestBody, 'buffered');
  assert.equal(harness({ method: 'POST' }).routes[0]?.requestBody, 'streaming');
  assert.equal(typeof route.fetch, 'function');
});

void test('registration refuses an invalid specification before touching the registry', () => {
  const cases: readonly { readonly spec: Partial<ApiRouteSpec<TestInput, unknown>>; readonly pattern: RegExp }[] = [
    { spec: { operation: '' }, pattern: /operation/ },
    { spec: { operation: 'bad op' }, pattern: /operation/ },
    { spec: { operation: '../escape' }, pattern: /operation/ },
    { spec: { operation: 'problems/list' }, pattern: /operation/ },
    { spec: { operation: '-leading' }, pattern: /operation/ },
    { spec: { operation: 'x'.repeat(MAX_OPERATION_LENGTH + 1) }, pattern: /operation/ },
    { spec: { method: 'PUT' as ApiRouteMethod }, pattern: /method/ },
    { spec: { successStatus: 201 as 200 }, pattern: /successStatus/ },
  ];
  for (const { spec, pattern } of cases) {
    const routes: ConnectionFetchRoute[] = [];
    const registry: HostConnectionFetch = {
      register(route) {
        routes.push(route);
        return async () => undefined;
      },
    };
    assert.throws(
      () =>
        registerApiRoute(registry, {
          operation: 'test.run',
          method: 'POST',
          validate: (value) => value as TestInput,
          handle: async () => undefined,
          ...spec,
        }),
      pattern,
    );
    assert.equal(routes.length, 0, 'an invalid specification must not reach the carrier');
  }

  const registry: HostConnectionFetch = { register: () => async () => undefined };
  assert.throws(
    () =>
      registerApiRoute(registry, {
        operation: 'test.run',
        method: 'POST',
        handle: async () => undefined,
      } as unknown as ApiRouteSpec<TestInput, unknown>),
    /validate/,
  );
  assert.throws(
    () =>
      registerApiRoute(registry, {
        operation: 'test.run',
        method: 'POST',
        validate: (value: unknown) => value as TestInput,
      } as unknown as ApiRouteSpec<TestInput, unknown>),
    /handle/,
  );
  assert.throws(
    () =>
      registerApiRoute({} as HostConnectionFetch, {
        operation: 'test.run',
        method: 'POST',
        validate: (value) => value as TestInput,
        handle: async () => undefined,
      }),
    /register/,
  );
  assert.throws(
    () =>
      registerApiRoute(
        registry,
        {
          operation: 'test.run',
          method: 'POST',
          validate: (value) => value as TestInput,
          handle: async () => undefined,
        },
        { onInternalError: 'yes' as unknown as (error: unknown) => void },
      ),
    /onInternalError/,
  );
});

void test('the returned disposer releases the contribution exactly once', async () => {
  const h = harness();

  assert.equal(typeof h.dispose, 'function');
  await h.dispose();
  await h.dispose();

  assert.equal(h.disposalCount(), 1);
});

// ---------------------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------------------

void test('a GET route validates an empty object and answers the versioned envelope', async () => {
  const h = harness({ method: 'GET', handle: async (input) => ({ fields: Object.keys(input).length }) });

  const response = await h.fetch(getRequest());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), JSON_CONTENT_TYPE);
  assert.equal(response.headers.get('cache-control'), NO_STORE_CACHE_CONTROL);
  const body = await envelope(response);
  assert.deepEqual(body, { apiVersion: API_VERSION, ok: true, value: { fields: 0 } });
  assert.deepEqual(Object.keys(body), ['apiVersion', 'ok', 'value']);
  assert.deepEqual(h.calls, [{}]);
});

void test('a GET route refuses a query string without calling the handler', async () => {
  const h = harness({ method: 'GET' });

  const response = await h.fetch(getRequest('test.run', '?limit=1'));

  assert.equal(response.status, 400);
  assert.equal(failureOf(await envelope(response)).code, 'invalid_input');
  assert.equal(h.calls.length, 0);
});

// ---------------------------------------------------------------------------------------
// POST and the versioned envelope
// ---------------------------------------------------------------------------------------

void test('a POST route decodes the JSON object and returns the handler value', async () => {
  const h = harness();

  const response = await h.fetch(postRequest('{"answer":42}'));

  assert.equal(response.status, 200);
  assert.deepEqual(await envelope(response), {
    apiVersion: API_VERSION,
    ok: true,
    value: { echo: { answer: 42 } },
  });
  assert.deepEqual(h.calls, [{ answer: 42 }]);
});

void test('a 202 route starts work but keeps the same success envelope', async () => {
  const h = harness({ successStatus: 202, handle: async () => ({ jobId: 'job-1' }) });

  const response = await h.fetch(postRequest('{}'));

  assert.equal(response.status, 202);
  assert.deepEqual(await envelope(response), {
    apiVersion: API_VERSION,
    ok: true,
    value: { jobId: 'job-1' },
  });
});

void test('typed transport errors keep their own safe status and message', async () => {
  const codes: readonly ApiErrorCode[] = [
    'invalid_input',
    'not_found',
    'conflict',
    'payload_too_large',
    'unsupported_media_type',
    'timeout',
    'cancelled',
    'internal',
  ];
  for (const code of codes) {
    const h = harness({
      handle: async () => {
        throw new ApiTransportError(code, `safe ${code}`);
      },
    });
    const response = await h.fetch(postRequest('{}'));
    assert.equal(response.status, API_ERROR_STATUS[code]);
    const failure = failureOf(await envelope(response));
    assert.equal(failure.code, code);
    assert.equal(failure.message, `safe ${code}`);
  }

  const defaulted = harness({
    handle: async () => {
      throw new ApiTransportError('conflict');
    },
  });
  const response = await defaulted.fetch(postRequest('{}'));
  assert.equal(response.status, 409);
  assert.equal(failureOf(await envelope(response)).message.length > 0, true);
});

// ---------------------------------------------------------------------------------------
// Request body handling
// ---------------------------------------------------------------------------------------

void test('the JSON media type is required for a POST body', async () => {
  const refused: readonly Record<string, string>[] = [
    {},
    { 'content-type': 'application/x-www-form-urlencoded' },
    { 'content-type': 'application/json; charset=latin1' },
    { 'content-type': 'application/json; profile=x' },
  ];
  for (const headers of refused) {
    const h = harness();
    const request =
      Object.keys(headers).length === 0
        ? streamPost(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{}'));
                controller.close();
              },
            }),
            {},
          )
        : postRequest('{}', headers);
    const response = await h.fetch(request);
    assert.equal(response.status, 415, `expected 415 for ${JSON.stringify(headers)}`);
    assert.equal(failureOf(await envelope(response)).code, 'unsupported_media_type');
    assert.equal(h.calls.length, 0);
  }

  const accepted = ['application/json', 'application/json; charset=UTF-8', 'application/json;charset="utf-8"'];
  for (const contentType of accepted) {
    const h = harness();
    const response = await h.fetch(postRequest('{}', { 'content-type': contentType }));
    assert.equal(response.status, 200, `expected 200 for ${contentType}`);
    assert.equal(h.calls.length, 1);
  }
});

void test('malformed JSON, malformed UTF-8 and non-object roots are refused with fixed messages', async () => {
  const badJson = harness();
  const jsonResponse = await badJson.fetch(postRequest('{'));
  assert.equal(jsonResponse.status, 400);
  assert.equal(failureOf(await envelope(jsonResponse)).message, 'the request body is not valid JSON');
  assert.equal(badJson.calls.length, 0);

  const badUtf8 = harness();
  const utf8Response = await badUtf8.fetch(bytesRequest(new Uint8Array([0x7b, 0xff, 0x7d])));
  assert.equal(utf8Response.status, 400);
  assert.equal(failureOf(await envelope(utf8Response)).message, 'the request body is not valid UTF-8');
  assert.equal(badUtf8.calls.length, 0);

  for (const root of ['[1,2]', 'null', '"text"', '7', '']) {
    const h = harness();
    const response = await h.fetch(postRequest(root));
    assert.equal(response.status, 400, `expected 400 for root ${root}`);
    assert.equal(failureOf(await envelope(response)).code, 'invalid_input');
    assert.equal(h.calls.length, 0);
  }
});

void test('an oversized Content-Length is refused before a single byte is read', async () => {
  let pulls = 0;
  // A byte stream does not pull on its own, so a pull here means a real read of the body.
  const stream: ReadableStream<Uint8Array> = new ReadableStream({
    type: 'bytes',
    pull() {
      pulls += 1;
    },
  });
  const request = streamPost(stream, {
    'content-type': 'application/json',
    'content-length': String(MAX_API_BODY_BYTES + 1),
  });
  const before = pulls;
  const h = harness();

  const response = await h.fetch(request);

  assert.equal(response.status, 413);
  assert.equal(failureOf(await envelope(response)).code, 'payload_too_large');
  assert.equal(pulls, before);
  assert.equal(h.calls.length, 0);
});

void test('an invalid Content-Length is refused before a single byte is read', async () => {
  const h = harness();

  for (const raw of ['abc', '-1', '1.5', '1, 2']) {
    let pulls = 0;
    const stream: ReadableStream<Uint8Array> = new ReadableStream({
      type: 'bytes',
      pull() {
        pulls += 1;
      },
    });
    const request = streamPost(stream, { 'content-type': 'application/json', 'content-length': raw });
    const before = pulls;
    const response = await h.fetch(request);
    assert.equal(response.status, 400, `expected 400 for Content-Length ${raw}`);
    assert.equal(failureOf(await envelope(response)).code, 'invalid_input');
    assert.equal(pulls, before, `no byte may be read for Content-Length ${raw}`);
  }

  assert.equal(h.calls.length, 0);
});

void test('an incrementally oversized body is refused and its reader is cancelled', async () => {
  let cancelled = false;
  const megabyte = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(megabyte);
    },
    cancel() {
      cancelled = true;
    },
  });
  const h = harness();

  const response = await h.fetch(streamPost(stream));
  assert.equal(response.status, 413);
  assert.equal(failureOf(await envelope(response)).code, 'payload_too_large');
  await tick();

  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 0);
});

void test('a reused chunk buffer cannot rewrite bytes that were already accepted', async () => {
  const first = new TextEncoder().encode('{"answer":');
  const second = new TextEncoder().encode('42}');
  let pulls = 0;
  // `highWaterMark: 0` stops the source from pulling ahead, so `first` is mutated only when the
  // next chunk is requested — after the transport has had the chance to accept the first chunk.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls === 0) {
          controller.enqueue(first);
        } else if (pulls === 1) {
          first.fill(0x20);
          controller.enqueue(second);
        } else {
          controller.close();
        }
        pulls += 1;
      },
    },
    { highWaterMark: 0 },
  );
  const h = harness();

  const response = await h.fetch(streamPost(stream));

  assert.equal(response.status, 200, 'a source that reuses its buffer must not corrupt accepted bytes');
  assert.deepEqual(h.calls, [{ answer: 42 }]);
});

void test('zero-length chunks are ignored instead of accumulating', async () => {
  const payload = new TextEncoder().encode('{"ok":true}');
  const empty = new Uint8Array(0);
  let empties = 5_000;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (empties > 0) {
        empties -= 1;
        controller.enqueue(empty);
        return;
      }
      if (!sent) {
        sent = true;
        controller.enqueue(payload);
        controller.close();
      }
    },
  });
  const h = harness();

  const response = await h.fetch(streamPost(stream));

  assert.equal(response.status, 200, 'empty chunks must not turn a valid body into a malformed one');
  assert.deepEqual(h.calls, [{ ok: true }]);
});

void test('one-byte chunks are accepted without losing data', async () => {
  const text = JSON.stringify({ note: 'x'.repeat(5_000) });
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(index, index + 1));
      index += 1;
    },
  });
  const h = harness({ handle: async (input) => input });

  const response = await h.fetch(streamPost(stream));

  assert.equal(response.status, 200);
  assert.deepEqual(h.calls, [JSON.parse(text) as Record<string, unknown>]);
});

void test('a hung body read is abandoned at the body deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });
  const h = harness();
  const request = streamPost(stream);

  const pending = h.fetch(request);
  t.mock.timers.tick(API_BODY_TIMEOUT_MS);
  const response = await pending;

  assert.equal(response.status, 408);
  assert.equal(failureOf(await envelope(response)).code, 'timeout');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(getEventListeners(request.signal, 'abort'), []);
});

// ---------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------

void test('a client abort during the body read is answered as cancelled without calling the handler', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });
  const h = harness();
  const request = streamPost(stream, { 'content-type': 'application/json' }, controller.signal);

  const pending = h.fetch(request);
  await tick();
  controller.abort();
  const response = await pending;

  assert.equal(response.status, 499);
  assert.equal(failureOf(await envelope(response)).code, 'cancelled');
  assert.equal(h.calls.length, 0);
});

void test('an already aborted request never reaches the handler', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness();

  const response = await h.fetch(postRequest('{}', { 'content-type': 'application/json' }, controller.signal));

  assert.equal(response.status, 499);
  assert.equal(h.calls.length, 0);
});

void test('a handler is cancelled while it waits and the request answers promptly', async () => {
  let cancelled = false;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    handle: async (_input, token) => {
      token.onCancel(() => {
        cancelled = true;
      });
      await gate;
      return { late: true };
    },
  });
  const controller = new AbortController();
  const pending = h.fetch(postRequest('{}', { 'content-type': 'application/json' }, controller.signal));
  await tick();

  controller.abort();
  const response = await pending;

  assert.equal(response.status, 499);
  assert.equal(cancelled, true);
  assert.equal(h.tokens.length, 1);
  assert.equal(h.tokens[0]?.cancelled, true);
  release();
  await tick();
});

void test('an already aborted request observes a body read that rejects afterwards', async () => {
  const controller = new AbortController();
  controller.abort();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.error(new Error('the body source failed'));
    },
  });
  const request = streamPost(stream, { 'content-type': 'application/json' }, controller.signal);
  const h = harness();

  await withoutUnhandledRejections(async () => {
    const response = await h.fetch(request);
    assert.equal(response.status, 499);
    assert.equal(failureOf(await envelope(response)).code, 'cancelled');
    assert.equal(h.calls.length, 0);
  });
});

void test('a handler that rejects after cancellation is observed, not unhandled', async () => {
  let failHandler: (error: unknown) => void = () => undefined;
  const h = harness({
    handle: () =>
      new Promise((_resolve, reject) => {
        failHandler = reject;
      }),
  });
  const controller = new AbortController();

  await withoutUnhandledRejections(async () => {
    const pending = h.fetch(postRequest('{}', { 'content-type': 'application/json' }, controller.signal));
    await tick();
    controller.abort();
    const response = await pending;
    assert.equal(response.status, 499);
    failHandler(new Error('the handler failed after the client gave up'));
    await tick();
  });
});

// ---------------------------------------------------------------------------------------
// Failures and listener lifecycle
// ---------------------------------------------------------------------------------------

void test('an unknown handler failure is sanitized and reported to the observer', async () => {
  const reported: unknown[] = [];
  const contexts: ApiInternalErrorContext[] = [];
  const secret = new Error('SQLITE_ERROR at D:\\private\\training.sqlite');
  const marker = 'SECRET-BODY-MARKER';
  const h = harness({
    handle: async () => {
      throw secret;
    },
    routeOptions: {
      onInternalError(error, context) {
        reported.push(error);
        contexts.push(context);
      },
    },
  });

  const response = await h.fetch(postRequest(JSON.stringify({ note: marker })));

  assert.equal(response.status, 500);
  const text = JSON.stringify(await envelope(response));
  assert.equal(text.includes('SQLITE_ERROR'), false);
  assert.equal(text.includes('private'), false);
  assert.equal(text.includes(marker), false);
  assert.deepEqual(reported, [secret]);
  assert.deepEqual(contexts, [{ operation: 'test.run', method: 'POST' }]);
});

void test('a throwing observer is contained and replaced by one fixed diagnostic', async () => {
  const warnings: (Error & { code?: string })[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning as Error & { code?: string });
  };
  process.on('warning', onWarning);
  try {
    const h = harness({
      handle: async () => {
        throw new Error('SQLITE_ERROR at D:\\private\\training.sqlite');
      },
      routeOptions: {
        onInternalError() {
          throw new Error('the observer is broken too');
        },
      },
    });

    const response = await h.fetch(postRequest('{}'));

    assert.equal(response.status, 500);
    const failure = failureOf(await envelope(response));
    assert.equal(failure.code, 'internal');
    assert.equal(JSON.stringify(failure).includes('SQLITE_ERROR'), false);
    assert.equal(JSON.stringify(failure).includes('private'), false);
    // `process.emitWarning` emits on the next tick, so the listener must outlive one tick.
    await tick();
  } finally {
    process.off('warning', onWarning);
  }

  const fallbacks = warnings.filter((warning) => warning.code === 'ICPC_API_OBSERVER_FAILED');
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0]?.message.includes('observer'), true);
  assert.equal(fallbacks[0]?.message.includes('SQLITE_ERROR'), false);
  assert.equal(fallbacks[0]?.message.includes('private'), false);
});

void test('a typed validator refusal keeps its status; a validator programmer error is a sanitized 500', async () => {
  const typed = harness({
    validate: () => {
      throw new ApiTransportError('conflict', 'a job is already running');
    },
  });
  const typedResponse = await typed.fetch(postRequest('{}'));
  assert.equal(typedResponse.status, 409);
  assert.equal(failureOf(await envelope(typedResponse)).message, 'a job is already running');
  assert.equal(typed.calls.length, 0);

  const reported: unknown[] = [];
  const contexts: ApiInternalErrorContext[] = [];
  const bug = new TypeError('cannot read properties of undefined (reading planId)');
  const broken = harness({
    validate: () => {
      throw bug;
    },
    routeOptions: {
      onInternalError(error, context) {
        reported.push(error);
        contexts.push(context);
      },
    },
  });
  const brokenResponse = await broken.fetch(postRequest(JSON.stringify({ note: 'SECRET-VALIDATOR-MARKER' })));

  assert.equal(brokenResponse.status, 500, 'a programmer error must not be blamed on the client');
  const failure = failureOf(await envelope(brokenResponse));
  assert.equal(failure.code, 'internal');
  assert.equal(JSON.stringify(failure).includes('planId'), false);
  assert.equal(JSON.stringify(failure).includes('SECRET-VALIDATOR-MARKER'), false);
  assert.deepEqual(reported, [bug]);
  assert.deepEqual(contexts, [{ operation: 'test.run', method: 'POST' }]);
  assert.equal(broken.calls.length, 0);
});

void test('only lossless plain JSON values are answered as success', async () => {
  const value = {
    count: 3,
    ratio: 0.5,
    text: 'plain',
    flag: false,
    nothing: null,
    list: [1, 'two', { deep: [] }],
  };
  const valid = harness({ handle: async () => value });
  const validResponse = await valid.fetch(postRequest('{}'));
  assert.equal(validResponse.status, 200);
  assert.deepEqual(await envelope(validResponse), { apiVersion: API_VERSION, ok: true, value });

  const scalar = harness({ handle: async () => 0 });
  const scalarResponse = await scalar.fetch(postRequest('{}'));
  assert.equal(scalarResponse.status, 200);
  assert.deepEqual(await envelope(scalarResponse), { apiVersion: API_VERSION, ok: true, value: 0 });

  const sparse: unknown[] = [];
  sparse[1] = 'hole';
  const accessor = Object.defineProperty({}, 'hidden', { enumerable: true, get: () => 'value' });
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  const refused: readonly unknown[] = [
    { count: Number.NaN },
    { count: Number.POSITIVE_INFINITY },
    { member: undefined },
    { nested: { member: undefined } },
    { list: [1, undefined] },
    new Map([['key', 1]]),
    new Set([1]),
    new Date(),
    new (class Dto {
      readonly field = 1;
    })(),
    cyclic,
    undefined,
    () => 'function',
    Symbol('symbol'),
    1n,
    sparse,
    accessor,
    { toJSON: () => ({ replaced: true }) },
  ];
  for (const [index, candidate] of refused.entries()) {
    const reported: unknown[] = [];
    const h = harness({
      handle: async () => candidate,
      routeOptions: {
        onInternalError(error) {
          reported.push(error);
        },
      },
    });
    const refusal = await h.fetch(postRequest('{}'));
    assert.equal(refusal.status, 500, `case ${index} must be refused`);
    assert.equal(failureOf(await envelope(refusal)).code, 'internal', `case ${index} must be sanitized`);
    assert.equal(reported.length, 1, `case ${index} must be observed`);
  }
});

void test('the abort listener is removed on every path', async () => {
  const requests: Request[] = [];

  const success = harness();
  const okRequest = postRequest('{}');
  requests.push(okRequest);
  await success.fetch(okRequest);

  const invalid = harness();
  const invalidRequest = postRequest('{');
  requests.push(invalidRequest);
  await invalid.fetch(invalidRequest);

  const failing = harness({
    handle: async () => {
      throw new Error('boom');
    },
  });
  const failingRequest = postRequest('{}');
  requests.push(failingRequest);
  await failing.fetch(failingRequest);

  const controller = new AbortController();
  const aborted = harness();
  const abortedRequest = postRequest('{}', { 'content-type': 'application/json' }, controller.signal);
  requests.push(abortedRequest);
  const pending = aborted.fetch(abortedRequest);
  controller.abort();
  await pending;

  for (const request of requests) {
    assert.deepEqual(
      getEventListeners(request.signal, 'abort'),
      [],
      'every exit path must release the abort bridge',
    );
  }
});
