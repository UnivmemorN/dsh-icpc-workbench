/**
 * Transport behaviour tests: FIFO queueing, shared pacing (including the Codeforces floor and
 * retries), cancellation at every stage, whole-response timeout, redirect origin policy, payload
 * cap, header policy and limit validation. Network is disabled: every response is in-process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpTransport, type WaitFn } from '../../src/adapters/platform/http.js';
import { isPlatformError } from '../../src/application/platform-errors.js';
import { DomainError, createCancellationSource } from '../../src/domain/index.js';
import {
  createHttpHarness,
  hangUntilAbort,
  htmlResponse,
  jsonResponse,
  stalledBodyResponse,
  tick,
  unstoppableBodyResponse,
} from './fixtures.js';

const operation = 'catalog' as const;

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
}

test('requests are queued FIFO and paced across the shared transport', async () => {
  const harness = createHttpHarness({
    minRequestIntervalMs: 2000,
    platformMinRequestIntervalMs: 2000,
    routes: {
      '/api/a': () => jsonResponse({ ok: 'a' }),
      '/api/b': () => jsonResponse({ ok: 'b' }),
      '/api/c': () => jsonResponse({ ok: 'c' }),
    },
  });
  const source = createCancellationSource();
  const responses = await Promise.all([
    harness.transport.request('/api/a', { token: source.token, operation }),
    harness.transport.request('/api/b', { token: source.token, operation }),
    harness.transport.request('/api/c', { token: source.token, operation }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.body),
    ['{"ok":"a"}', '{"ok":"b"}', '{"ok":"c"}'],
  );
  assert.deepEqual(
    harness.requests.map((request) => new URL(request.url).pathname),
    ['/api/a', '/api/b', '/api/c'],
  );
  assert.deepEqual(
    harness.requests.map((request) => request.at),
    [0, 2000, 4000],
  );
  assert.deepEqual(harness.waits, [2000, 2000]);
});

test('the documented platform floor overrides a lower caller interval', async () => {
  const harness = createHttpHarness({
    minRequestIntervalMs: 10,
    platformMinRequestIntervalMs: 2000,
    routes: { '/api/a': () => jsonResponse({ ok: true }) },
  });
  assert.equal(harness.transport.effectiveMinRequestIntervalMs, 2000);
  const source = createCancellationSource();
  await Promise.all([
    harness.transport.request('/api/a', { token: source.token, operation }),
    harness.transport.request('/api/a', { token: source.token, operation }),
  ]);
  assert.deepEqual(
    harness.requests.map((request) => request.at),
    [0, 2000],
  );
});

test('a retry stays inside the shared pacing and reports its attempt count', async () => {
  let calls = 0;
  const harness = createHttpHarness({
    minRequestIntervalMs: 2000,
    platformMinRequestIntervalMs: 2000,
    maxRetries: 1,
    routes: {
      '/api/a': () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ failure: true }, 503) : jsonResponse({ ok: true });
      },
    },
  });
  const source = createCancellationSource();
  const response = await harness.transport.request('/api/a', { token: source.token, operation });
  assert.equal(response.status, 200);
  assert.equal(response.attempts, 2);
  assert.deepEqual(
    harness.requests.map((request) => request.at),
    [0, 2000],
  );
});

test('Retry-After is honoured when it fits and reported as declared when it cannot be honoured', async () => {
  let first = true;
  const honoured = createHttpHarness({
    minRequestIntervalMs: 2000,
    platformMinRequestIntervalMs: 2000,
    maxRetries: 1,
    routes: {
      '/api/a': () => {
        if (first) {
          first = false;
          return new Response('busy', { status: 429, headers: { 'retry-after': '5' } });
        }
        return jsonResponse({ ok: true });
      },
    },
  });
  const source = createCancellationSource();
  const response = await honoured.transport.request('/api/a', { token: source.token, operation });
  assert.equal(response.attempts, 2);
  assert.deepEqual(honoured.waits, [5000]);
  assert.deepEqual(
    honoured.requests.map((request) => request.at),
    [0, 5000],
  );

  const exhausted = createHttpHarness({
    maxRetries: 1,
    routes: { '/api/a': () => new Response('busy', { status: 503 }) },
  });
  await assert.rejects(
    exhausted.transport.request('/api/a', { token: source.token, operation }),
    (error) => isPlatformError(error) && error.code === 'unavailable' && error.attempts === 2,
  );

  const declared = createHttpHarness({
    maxRetries: 3,
    maxRetryAfterMs: 30_000,
    routes: { '/api/a': () => new Response('busy', { status: 429, headers: { 'retry-after': '99999' } }) },
  });
  await assert.rejects(
    declared.transport.request('/api/a', { token: source.token, operation }),
    (error) =>
      isPlatformError(error) &&
      error.code === 'rate_limited' &&
      error.retryable &&
      error.retryAfterMs === 99_999_000 &&
      error.attempts === 1,
  );
  // The declared wait is longer than the transport may hold, so it must not retry early.
  assert.equal(declared.requests.length, 1);
  assert.deepEqual(declared.waits, []);
});

test('the transport never sends cookies and rejects a caller cookie header', async () => {
  const harness = createHttpHarness({ routes: { '/api/a': () => jsonResponse({ ok: true }) } });
  const source = createCancellationSource();
  await harness.transport.request('/api/a', { token: source.token, operation });
  const init = harness.requests[0]?.init;
  assert.ok(init);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'manual');
  assert.equal(Object.keys(init.headers).includes('cookie'), false);
  await assert.rejects(
    harness.transport.request('/api/a', { token: source.token, operation, headers: { Cookie: 'session=1' } }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.equal(harness.requests.length, 1);
});

test('only the official origin is contacted, including through redirects', async () => {
  const source = createCancellationSource();
  const crossOrigin = createHttpHarness({
    routes: { '/api/a': () => new Response('', { status: 302, headers: { location: 'https://evil.example/api/a' } }) },
  });
  await assert.rejects(
    crossOrigin.transport.request('/api/a', { token: source.token, operation }),
    (error) => isPlatformError(error) && error.code === 'unavailable' && error.retryable === false,
  );
  assert.equal(crossOrigin.requests.length, 1);
  assert.ok(crossOrigin.requests.every((request) => new URL(request.url).origin === 'https://codeforces.com'));

  const sameOrigin = createHttpHarness({
    routes: {
      '/api/a': () => new Response('', { status: 302, headers: { location: '/api/b' } }),
      '/api/b': () => jsonResponse({ ok: true }),
    },
  });
  const followed = await sameOrigin.transport.request('/api/a', { token: source.token, operation });
  assert.equal(followed.status, 200);
  assert.deepEqual(
    sameOrigin.requests.map((request) => new URL(request.url).pathname),
    ['/api/a', '/api/b'],
  );

  const absolute = createHttpHarness({ routes: {} });
  await assert.rejects(
    absolute.transport.request('https://evil.example/api/a', { token: source.token, operation }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.equal(absolute.requests.length, 0);
});

test('HTTP statuses map to honest operational codes', async () => {
  const source = createCancellationSource();
  const cases: readonly (readonly [number, string])[] = [
    [401, 'auth_required'],
    [403, 'forbidden'],
    [404, 'unavailable'],
    [500, 'unavailable'],
  ];
  for (const [status, code] of cases) {
    const harness = createHttpHarness({ routes: { '/api/a': () => new Response('nope', { status }) } });
    await assert.rejects(
      harness.transport.request('/api/a', { token: source.token, operation }),
      (error) => isPlatformError(error) && error.code === code,
    );
  }
});

test('failure details never include the response body', async () => {
  const harness = createHttpHarness({
    routes: { '/api/a': () => new Response('secret-token-abcdef', { status: 500 }) },
  });
  const source = createCancellationSource();
  await assert.rejects(
    harness.transport.request('/api/a', { token: source.token, operation }),
    (error) => {
      assert.ok(isPlatformError(error));
      assert.equal(error.message.includes('secret-token'), false);
      assert.equal(error.detail.includes('secret-token'), false);
      return true;
    },
  );
});

test('an oversized body is rejected without being buffered into the error', async () => {
  const harness = createHttpHarness({
    maxResponseBytes: 1024,
    routes: { '/api/a': () => htmlResponse('x'.repeat(8192)) },
  });
  const source = createCancellationSource();
  await assert.rejects(
    harness.transport.request('/api/a', { token: source.token, operation }),
    (error) => isPlatformError(error) && error.code === 'changed_response' && !error.detail.includes('xxxx'),
  );
  assert.equal(harness.requests.length, 1);
});

test('the timeout covers the whole response, including the body', async () => {
  const source = createCancellationSource();
  const hanging = createHttpHarness({ requestTimeoutMs: 500, routes: { '/api/a': hangUntilAbort } });
  const pending = hanging.transport.request('/api/a', { token: source.token, operation });
  await tick();
  hanging.fireTimers();
  await assert.rejects(
    pending,
    (error) => isPlatformError(error) && error.code === 'unavailable' && error.retryable === true,
  );

  const stalled = createHttpHarness({ requestTimeoutMs: 500, routes: { '/api/a': () => stalledBodyResponse() } });
  const stalledPending = stalled.transport.request('/api/a', { token: source.token, operation });
  await tick();
  stalled.fireTimers();
  await assert.rejects(
    stalledPending,
    (error) => isPlatformError(error) && error.code === 'unavailable' && error.retryable === true,
  );
});

test('cancellation is honoured before queueing, in the queue, during fetch, during body and before returning', async () => {
  const beforeQueue = createHttpHarness({ routes: { '/api/a': () => jsonResponse({ ok: true }) } });
  const beforeSource = createCancellationSource();
  beforeSource.cancel('early');
  await assert.rejects(
    beforeQueue.transport.request('/api/a', { token: beforeSource.token, operation }),
    (error) => codeOf(error) === 'cancelled',
  );
  assert.equal(beforeQueue.requests.length, 0);

  let release: () => void = () => {};
  const slow = new Promise<Response>((resolve) => {
    release = () => resolve(jsonResponse({ ok: 'slow' }));
  });
  const queued = createHttpHarness({
    routes: { '/api/slow': () => slow, '/api/a': () => jsonResponse({ ok: true }) },
  });
  const firstSource = createCancellationSource();
  const secondSource = createCancellationSource();
  const first = queued.transport.request('/api/slow', { token: firstSource.token, operation });
  const second = queued.transport.request('/api/a', { token: secondSource.token, operation });
  await tick();
  secondSource.cancel('queued');
  release();
  await first;
  await assert.rejects(second, (error) => codeOf(error) === 'cancelled');
  assert.deepEqual(
    queued.requests.map((request) => new URL(request.url).pathname),
    ['/api/slow'],
  );

  const inFlight = createHttpHarness({ routes: { '/api/a': hangUntilAbort } });
  const inFlightSource = createCancellationSource();
  const pending = inFlight.transport.request('/api/a', { token: inFlightSource.token, operation });
  await tick();
  inFlightSource.cancel('user');
  await assert.rejects(pending, (error) => codeOf(error) === 'cancelled');

  const body = createHttpHarness({ routes: { '/api/a': () => stalledBodyResponse() } });
  const bodySource = createCancellationSource();
  const bodyPending = body.transport.request('/api/a', { token: bodySource.token, operation });
  await tick();
  bodySource.cancel('user');
  await assert.rejects(bodyPending, (error) => codeOf(error) === 'cancelled');

  const lateSource = createCancellationSource();
  const late = createHttpHarness({
    routes: {
      '/api/a': () => {
        lateSource.cancel('late');
        return jsonResponse({ ok: true });
      },
    },
  });
  await assert.rejects(
    late.transport.request('/api/a', { token: lateSource.token, operation }),
    (error) => codeOf(error) === 'cancelled',
  );
});

test('limit numbers and the origin are validated before any request', async () => {
  assert.throws(
    () => new HttpTransport({ origin: 'https://codeforces.com', minRequestIntervalMs: -1 }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.throws(
    () => new HttpTransport({ origin: 'https://codeforces.com', maxRetries: 99 }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.throws(
    () => new HttpTransport({ origin: 'https://codeforces.com', maxResponseBytes: 10 }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.throws(
    () => new HttpTransport({ origin: 'https://codeforces.com/path' }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.throws(
    () => new HttpTransport({ origin: 'ftp://codeforces.com' }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );

  const harness = createHttpHarness({ routes: { '/api/a': () => jsonResponse({ ok: true }) } });
  const source = createCancellationSource();
  await assert.rejects(
    harness.transport.request('/api/a', { token: source.token, operation, limits: { requestTimeoutMs: 0 } }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.equal(harness.requests.length, 0);
});

test('a queued request rejects as soon as its token is cancelled, before the first request ends', async () => {
  let release: () => void = () => {};
  const slow = new Promise<Response>((resolve) => {
    release = () => resolve(jsonResponse({ ok: 'slow' }));
  });
  const harness = createHttpHarness({
    routes: { '/api/slow': () => slow, '/api/a': () => jsonResponse({ ok: true }) },
  });
  const firstSource = createCancellationSource();
  const secondSource = createCancellationSource();
  const first = harness.transport.request('/api/slow', { token: firstSource.token, operation });
  const second = harness.transport.request('/api/a', { token: secondSource.token, operation });
  await tick();
  secondSource.cancel('queued');
  // Rejects while `slow` is still pending: the queued caller is not held until the first ends.
  await assert.rejects(second, (error) => codeOf(error) === 'cancelled');
  release();
  await first;
  await tick();
  assert.deepEqual(
    harness.requests.map((request) => new URL(request.url).pathname),
    ['/api/slow'],
  );
});

test('a fetch that ignores its signal cannot hang the request, and its late body is cancelled', async () => {
  const source = createCancellationSource();
  let releaseFetch: (response: Response) => void = () => {};
  const ignored = new Promise<Response>((resolve) => {
    releaseFetch = resolve;
  });
  const harness = createHttpHarness({ requestTimeoutMs: 500, routes: { '/api/a': () => ignored } });
  const pending = harness.transport.request('/api/a', { token: source.token, operation });
  await tick();
  harness.fireTimers();
  await assert.rejects(
    pending,
    (error) => isPlatformError(error) && error.code === 'unavailable' && error.retryable === true,
  );
  assert.equal(source.token.cancelled, false);

  let lateCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      lateCancelled = true;
    },
  });
  releaseFetch(new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }));
  await tick();
  assert.equal(lateCancelled, true);
});

test('a body whose cancel never settles cannot hang the byte-cap rejection', async () => {
  const harness = createHttpHarness({
    maxResponseBytes: 1024,
    routes: { '/api/a': () => unstoppableBodyResponse() },
  });
  const source = createCancellationSource();
  await assert.rejects(
    harness.transport.request('/api/a', { token: source.token, operation }),
    (error) => isPlatformError(error) && error.code === 'changed_response',
  );
  assert.equal(harness.requests.length, 1);
});

test('the attempt count includes redirect hops, not only retries', async () => {
  const harness = createHttpHarness({
    routes: {
      '/api/a': () => new Response('', { status: 302, headers: { location: '/api/b' } }),
      '/api/b': () => new Response('', { status: 301, headers: { location: '/api/c' } }),
      '/api/c': () => jsonResponse({ ok: true }),
    },
  });
  const source = createCancellationSource();
  const response = await harness.transport.request('/api/a', { token: source.token, operation });
  assert.equal(response.attempts, 3);
  assert.equal(response.url, 'https://codeforces.com/api/c');
});

test('URLs carrying credentials or a non-default port are refused, including on redirects', async () => {
  const source = createCancellationSource();
  assert.throws(
    () => new HttpTransport({ origin: 'https://user:secret@codeforces.com' }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.throws(
    () => new HttpTransport({ origin: 'https://codeforces.com:8443' }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );

  const harness = createHttpHarness({ routes: { '/api/a': () => jsonResponse({ ok: true }) } });
  await assert.rejects(
    harness.transport.request('https://user:secret@codeforces.com/api/a', { token: source.token, operation }),
    (error) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.equal(harness.requests.length, 0);

  const redirect = createHttpHarness({
    routes: {
      '/api/a': () =>
        new Response('', { status: 302, headers: { location: 'https://user:secret@codeforces.com/api/b' } }),
    },
  });
  await assert.rejects(
    redirect.transport.request('/api/a', { token: source.token, operation }),
    (error) => isPlatformError(error) && error.code === 'changed_response',
  );
  assert.equal(redirect.requests.length, 1);
});

test('an oversized Content-Length cancels the unread body and aborts the transport', async () => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const transport = new HttpTransport({
    origin: 'https://codeforces.com', maxRetries: 0, maxResponseBytes: 1024,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return {
        status: 200,
        headers: { get: (name: string) => name === 'content-length' ? '2048' : null },
        body: { getReader: () => ({
          read: async () => { throw new Error('oversized body must not be read'); },
          cancel: async () => { cancelled = true; },
        }) },
      };
    },
  });
  await assert.rejects(
    transport.request('/oversized', { token: createCancellationSource().token, operation }),
    (error: unknown) => isPlatformError(error) && error.code === 'changed_response',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(signal?.aborted, true);
});

test('a positive Retry-After becomes the shared not-before instant of later requests', async () => {
  let calls = 0;
  const harness = createHttpHarness({
    maxRetries: 0,
    routes: {
      '/api/a': () => {
        calls += 1;
        return calls === 1
          ? new Response('busy', { status: 429, headers: { 'retry-after': '5' } })
          : jsonResponse({ ok: true });
      },
    },
  });
  const source = createCancellationSource();
  await assert.rejects(
    harness.transport.request('/api/a', { token: source.token, operation }),
    (error) =>
      isPlatformError(error) && error.code === 'rate_limited' && error.retryAfterMs === 5000 && error.attempts === 1,
  );
  assert.deepEqual(
    harness.requests.map((request) => request.at),
    [0],
    'the first request dispatched immediately',
  );
  assert.deepEqual(harness.waits, [], 'giving up on the retry budget must not sleep through the delay');

  // The provider deadline is now shared transport state: a later request — whichever call site queued
  // it — dispatches no earlier than that deadline even though the first request never retried.
  const response = await harness.transport.request('/api/a', { token: source.token, operation });
  assert.equal(response.status, 200);
  assert.deepEqual(
    harness.requests.map((request) => request.at),
    [0, 5000],
  );
  assert.deepEqual(harness.waits, [5000]);
});

test('cancellation during a shared Retry-After cooldown dispatches nothing', async () => {
  const harness = createHttpHarness({
    maxRetries: 0,
    routes: { '/api/a': () => new Response('busy', { status: 429, headers: { 'retry-after': '5' } }) },
  });
  // A deterministic cooldown wait: it resolves only when the test releases it and rejects the moment
  // the caller cancels. No real timer and no real sleep are involved anywhere in this case.
  const releases: (() => void)[] = [];
  const cooldown: WaitFn = (_ms, token) =>
    new Promise<void>((resolve, reject) => {
      if (token.cancelled) {
        reject(new DomainError('cancelled', 'cancelled before the shared cooldown started'));
        return;
      }
      const off = token.onCancel(() => {
        off();
        reject(new DomainError('cancelled', 'cancelled during the shared cooldown'));
      });
      releases.push(() => {
        off();
        resolve();
      });
    });
  const transport = new HttpTransport({
    origin: 'https://codeforces.com',
    maxRetries: 0,
    fetchImpl: harness.impl.fetchImpl,
    clock: harness.impl.clock,
    wait: cooldown,
  });

  const first = createCancellationSource();
  await assert.rejects(
    transport.request('/api/a', { token: first.token, operation }),
    (error) => isPlatformError(error) && error.code === 'rate_limited' && error.retryAfterMs === 5000,
  );
  assert.equal(harness.requests.length, 1);

  const second = createCancellationSource();
  const pendingRequest = transport.request('/api/a', { token: second.token, operation });
  await tick();
  assert.equal(releases.length, 1, 'the cooled-down request is waiting on the provider deadline');
  assert.equal(harness.requests.length, 1, 'nothing was dispatched during the cooldown');
  second.cancel('user');
  await assert.rejects(pendingRequest, (error) => codeOf(error) === 'cancelled');
  assert.equal(harness.requests.length, 1, 'a cancelled cooldown dispatches nothing');
  for (const release of releases) {
    release();
  }
  await tick();
  assert.equal(harness.requests.length, 1, 'an abandoned cooldown still dispatches nothing');
});
