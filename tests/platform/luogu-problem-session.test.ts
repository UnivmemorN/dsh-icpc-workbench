/**
 * Sprint 30a — authenticated Luogu problem reader regressions.
 *
 * Everything here is synthetic and in-process: the shared fixture harness, synthetic session
 * strings and original fixture payloads. No network, no real credential, no downloaded statement.
 * The synthetic `__client_id` is an opaque session identifier deliberately unequal to any account
 * UID, and the fixture also carries an unrelated `__session` secret so every dispatch assertion
 * proves a whole-Cookie input is reduced to the two required cookies.
 *
 * Pinned properties: the exact single authenticated target (alternate path/pid/query/fragment/
 * origin refused, login redirects classified without a dispatch), account and session binding,
 * fresh session per call with a released overlap slot, fixed secret-free failures from every
 * untrusted boundary (provider, fetch, body stream, parser) with code/retry/diagnostic-reason
 * preservation, distinct auth/permission/rate-limit/missing-statement outcomes, honest
 * cancellation, pacing floor and retry budget, and the untouched anonymous cookie prohibition.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_BASE_URL,
  LUOGU_PROBLEM_PATH_PREFIX,
  createLuoguAccount,
  createLuoguAdapter,
  createLuoguProblemSessionSource,
  luoguSourceInstance,
  type LuoguProblemSessionSource,
  type LuoguProblemSessionSourceOptions,
  type LuoguSession,
  type LuoguSessionProvider,
} from '../../src/adapters/luogu/index.js';
import type { FetchLike } from '../../src/adapters/platform/http.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import type { FetchProblemRequest, PlatformLimits } from '../../src/application/ports.js';
import {
  DomainError,
  createAccount,
  createCancellationSource,
  createSourceInstance,
  type Account,
  type CancellationToken,
  type NormalizedProblem,
} from '../../src/domain/index.js';
import {
  createHttpHarness,
  hangUntilAbort,
  htmlResponse,
  jsonResponse,
  tick,
  type HttpHarness,
  type HttpHarnessOptions,
} from './fixtures.js';

const UID = '248159';
const OTHER_UID = '100001';
/** Synthetic session material: never a real cookie, never stored outside this file. */
const SESSION_SECRET = 'synthetic-session-secret-0123456789abcdef';
/** Opaque synthetic `__client_id` values; a session identifier, deliberately not a UID. */
const CLIENT_ID = 'b7f1c0a94e2d4f6a8c1b3d5e7f901234';
const OTHER_CLIENT_ID = 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const COOKIE = `__client_id=${CLIENT_ID}; _uid=${UID}; __session=${SESSION_SECRET}`;
/** The canonical pair every accepted session is reduced to before it can travel. */
const CANONICAL_COOKIE = `__client_id=${CLIENT_ID}; _uid=${UID}`;
const OTHER_COOKIE = `__client_id=${OTHER_CLIENT_ID}; _uid=${UID}`;
const SESSION: LuoguSession = { uid: UID, cookie: COOKIE };
const SOURCE = luoguSourceInstance();
const ACCOUNT = createLuoguAccount(SOURCE, UID, 'Synthetic User');
const PID = 'P3374';
const STATEMENT_MARKER = 'STATEMENT-MARKER';
const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 30_000,
  maxRetries: 0,
  pageSize: 100,
  maxConcurrency: 1,
};

function ref(externalKey = PID, sourceInstanceId = SOURCE.id): FetchProblemRequest['problemRef'] {
  return { sourceInstanceId, domain: null, externalKey };
}

interface PlatformErrorLike {
  readonly code?: string;
  readonly detail?: string;
  readonly sample?: string | null;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number | null;
  readonly attempts?: number;
  readonly reason?: string | null;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<PlatformErrorLike> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.notEqual(error, null, `expected a ${code} rejection`);
  assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
  return error as PlatformErrorLike;
}

/** Every textual surface of an error, for secret-leak assertions. */
function errorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error);
  }
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['name', 'message', 'detail', 'sample', 'stack']) {
    const value = record[key];
    if (typeof value === 'string') {
      parts.push(value);
    }
  }
  return parts.join(' | ');
}

/** Every textual surface — fields, message and JSON projection — must stay secret-free. */
function assertNoSecret(error: unknown): void {
  const projection =
    typeof error === 'object' && error !== null ? JSON.stringify(error as Record<string, unknown>) : String(error);
  const text = `${errorText(error)} | ${projection}`;
  assert.ok(!text.includes(SESSION_SECRET), `the session secret leaked into: ${text}`);
  assert.ok(!text.includes(COOKIE), `the session cookie leaked into: ${text}`);
}

function harness(routes: HttpHarnessOptions['routes']): HttpHarness {
  return createHttpHarness({ origin: LUOGU_BASE_URL, routes });
}

function sessionProvider(session: LuoguSession = SESSION): LuoguSessionProvider {
  return { sessionFor: async () => session };
}

function countingProvider(session: LuoguSession = SESSION): {
  readonly provider: LuoguSessionProvider;
  readonly calls: Account[];
} {
  const calls: Account[] = [];
  return {
    calls,
    provider: {
      sessionFor: async (account: Account) => {
        calls.push(account);
        return session;
      },
    },
  };
}

function sourceFor(
  h: HttpHarness,
  sessions: LuoguSessionProvider = sessionProvider(),
  options: Partial<LuoguProblemSessionSourceOptions> = {},
): LuoguProblemSessionSource {
  return createLuoguProblemSessionSource({
    sourceInstance: SOURCE,
    account: ACCOUNT,
    sessions,
    ...h.impl,
    ...options,
  });
}

function fetchOnce(
  source: LuoguProblemSessionSource,
  overrides: {
    readonly pid?: string;
    readonly problemRef?: FetchProblemRequest['problemRef'];
    readonly limits?: PlatformLimits;
    readonly token?: CancellationToken;
  } = {},
): Promise<NormalizedProblem> {
  return source.fetchProblem({
    problemRef: overrides.problemRef ?? ref(overrides.pid ?? PID),
    token: overrides.token ?? createCancellationSource().token,
    limits: overrides.limits ?? LIMITS,
  });
}

function problemBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: PID,
    difficulty: 4,
    tags: [53, 523],
    content: {
      name: '树状数组 1',
      background: null,
      description: `maintain prefix sums of $a_1, \\dots, a_n$ (${STATEMENT_MARKER})`,
      formatI: '第一行两个整数 $n, m$。',
      formatO: '对于每个询问输出一行。',
      hint: '复杂度 $O(\\log n)$。',
    },
    samples: [['3 2\n1 2 3\n1 1 3\n2 2 5', '6']],
    limits: { time: [1000], memory: [524288] },
    ...overrides,
  };
}

function detailPayload(overrides: Record<string, unknown> = {}): unknown {
  return { data: { problem: problemBody(overrides) } };
}

/** A 200 response whose body stream fails on the first read with `message`. */
function erroringBody(message: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(message));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('a validated detail becomes a normalized problem with only the minimal cookie attached', async () => {
  const h = harness({
    '/problem/P3374': () => jsonResponse(detailPayload()),
    '/_lfe/tags': () => jsonResponse({ tags: [{ id: 53, name: '树状数组' }] }),
  });

  const problem = await fetchOnce(sourceFor(h));

  assert.equal(problem.title, '树状数组 1');
  assert.equal(problem.ref.externalKey, PID);
  assert.equal(problem.url, `${LUOGU_BASE_URL}${LUOGU_PROBLEM_PATH_PREFIX}${PID}`);
  assert.ok(problem.statement?.includes(STATEMENT_MARKER), 'the statement is assembled from the detail');
  assert.deepEqual(problem.rawTags.map((tag) => tag.raw), ['luogu-tag:53', 'luogu-tag:523']);
  assert.deepEqual(
    problem.ratings.map((rating) => [rating.dimension, rating.value, rating.raw]),
    [['difficulty', 4, '4']],
  );
  assert.equal(problem.fetchedAt, new Date(0).toISOString());

  assert.equal(h.requests.length, 1, 'no dictionary or catalog request is made');
  const request = h.requests[0]!;
  const target = new URL(request.url);
  assert.equal(target.origin, LUOGU_BASE_URL);
  assert.equal(target.pathname, `${LUOGU_PROBLEM_PATH_PREFIX}${PID}`);
  assert.equal(target.search, '');
  assert.equal(target.hash, '');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.redirect, 'manual');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.headers['x-lentille-request'], 'content-only');
  assert.equal(request.init.headers.cookie, CANONICAL_COOKIE, 'only the minimal cookie pair travels');
  assert.ok(!request.init.headers.cookie.includes(SESSION_SECRET), 'an unrelated cookie never travels');
});

test('the anonymous adapter keeps sending no cookie and the transport keeps refusing one', async () => {
  const h = harness({ '/problem/P3374': () => jsonResponse(detailPayload()) });
  const anonymous = createLuoguAdapter({ sourceInstance: SOURCE, transport: h.transport });

  const problem = await anonymous.fetchProblem({
    problemRef: ref(),
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.equal(problem.title, '树状数组 1');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.init.headers.cookie, undefined, 'the anonymous path never sends a session');

  const error = await rejectsWithCode(
    h.transport.request(`${LUOGU_PROBLEM_PATH_PREFIX}${PID}`, {
      token: createCancellationSource().token,
      operation: 'problem',
      headers: { cookie: COOKIE },
    }),
    'invalid_input',
  );
  assert.equal(h.requests.length, 1, 'the blanket cookie prohibition refuses before dispatch');
  assertNoSecret(error);
});

test('a login redirect is auth_required and the session is never dispatched to it', async () => {
  for (const loginPath of ['/auth/login', '/login']) {
    const h = harness({
      '/problem/P3374': () =>
        new Response('', { status: 302, headers: { location: loginPath, 'content-type': 'text/html' } }),
      [loginPath]: () => htmlResponse('<!doctype html><html><body>log in</body></html>'),
    });
    const error = await rejectsWithCode(fetchOnce(sourceFor(h)), 'auth_required');
    assert.match(String(error.detail), /no longer valid/);
    assertNoSecret(error);
    assert.deepEqual(
      h.requests.map((request) => new URL(request.url).pathname),
      ['/problem/P3374'],
      `the login path ${loginPath} is classified, never fetched with the session`,
    );
  }
});

test('a same-origin redirect outside the exact bound problem is refused before dispatch', async () => {
  const cases: readonly (readonly [string, string])[] = [
    ['/problem/P3375', 'unavailable'],
    ['/problem/P3374?x=1', 'unavailable'],
    ['/problem/P3374/', 'unavailable'],
    ['https://evil.example/problem/P3374', 'unavailable'],
    ['https://user:pass@www.luogu.com.cn/problem/P3374', 'changed_response'],
    ['https://www.luogu.com.cn:8443/problem/P3374', 'changed_response'],
  ];
  for (const [location, code] of cases) {
    const h = harness({ '/problem/P3374': () => new Response('', { status: 302, headers: { location } }) });
    const error = await rejectsWithCode(fetchOnce(sourceFor(h)), code);
    assertNoSecret(error);
    assert.equal(h.requests.length, 1, `no request is dispatched to ${location}`);
    assert.equal(new URL(h.requests[0]!.url).pathname, '/problem/P3374');
  }
});

test('foreign instances, accounts, sessions and pids are refused before the provider is consulted', async () => {
  const h = harness({ '/problem/P3374': () => jsonResponse(detailPayload()) });
  const counter = countingProvider();
  const source = sourceFor(h, counter.provider);

  await rejectsWithCode(fetchOnce(source, { problemRef: ref(PID, 'luogu:example.com') }), 'invalid_input');
  await rejectsWithCode(fetchOnce(source, { problemRef: ref('P3374/../x') }), 'invalid_input');
  await rejectsWithCode(
    fetchOnce(source, { problemRef: { sourceInstanceId: SOURCE.id, domain: 'mirror.example.com', externalKey: PID } }),
    'invalid_input',
  );
  await rejectsWithCode(fetchOnce(source, { limits: { ...LIMITS, maxRetries: 99 } }), 'invalid_input');
  assert.deepEqual(counter.calls, [], 'the provider is never consulted for rejected input');
  assert.equal(h.requests.length, 0);

  const foreign = await rejectsWithCode(
    fetchOnce(sourceFor(h, sessionProvider({ uid: OTHER_UID, cookie: `__client_id=${CLIENT_ID}; _uid=${OTHER_UID}` }))),
    'invalid_input',
  );
  assert.match(String(foreign.detail), /another account/);
  assertNoSecret(foreign);
  assert.equal(h.requests.length, 0);

  const mismatched = await rejectsWithCode(
    fetchOnce(sourceFor(h, sessionProvider({ uid: UID, cookie: `__client_id=${CLIENT_ID}; _uid=${OTHER_UID}` }))),
    'invalid_input',
  );
  assert.match(String(mismatched.detail), /does not match/);
  assertNoSecret(mismatched);
  assert.equal(h.requests.length, 0);

  const mirror = createSourceInstance({
    platform: 'luogu',
    baseUrl: LUOGU_BASE_URL,
    domain: 'mirror.example.com',
    displayName: 'Mirror',
  });
  assert.throws(
    () => sourceFor(h, counter.provider, { account: createLuoguAccount(mirror, UID) }),
    (error: unknown) => codeOf(error) === 'invalid_input',
    'an account of a mirror instance is refused at construction',
  );
  assert.throws(
    () =>
      sourceFor(h, counter.provider, {
        account: createAccount({ sourceInstanceId: SOURCE.id, handle: '00123', displayName: null, profileUrl: null }),
      }),
    (error: unknown) => codeOf(error) === 'invalid_input',
    'a non-canonical account handle is refused at construction',
  );
});

test('provider, fetch, body and parser failures never expose the synthetic secret', async () => {
  const leakingProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      throw new Error(`provider said ${SESSION_SECRET}`);
    },
  };
  const quiet = harness({});
  const providerFailure = await rejectsWithCode(fetchOnce(sourceFor(quiet, leakingProvider)), 'unavailable');
  assert.equal(providerFailure.retryable, false, 'a broken credential seam is terminal');
  assertNoSecret(providerFailure);
  assert.equal(quiet.requests.length, 0);

  const typedProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      throw new PlatformError({
        code: 'rate_limited',
        operation: 'submissions',
        retryable: true,
        retryAfterMs: 1500,
        detail: `slow down ${SESSION_SECRET}`,
      });
    },
  };
  const typedFailure = await rejectsWithCode(fetchOnce(sourceFor(harness({}), typedProvider)), 'rate_limited');
  assert.equal(typedFailure.retryable, true);
  assert.equal(typedFailure.retryAfterMs, 1500);
  assert.equal(typedFailure.detail, 'Luogu rate-limited the authenticated problem request');
  assertNoSecret(typedFailure);

  const throwingFetch: FetchLike = async () => {
    throw new Error(`network failure ${SESSION_SECRET}`);
  };
  const fetchFailure = await rejectsWithCode(
    fetchOnce(sourceFor(harness({}), sessionProvider(), { fetchImpl: throwingFetch })),
    'unavailable',
  );
  assert.equal(fetchFailure.retryable, true, 'an unrecognized transport failure stays retryable');
  assertNoSecret(fetchFailure);

  const bodyFailure = await rejectsWithCode(
    fetchOnce(sourceFor(harness({ '/problem/P3374': () => erroringBody(`stream broke ${SESSION_SECRET}`) }))),
    'unavailable',
  );
  assertNoSecret(bodyFailure);
  assert.equal(bodyFailure.retryable, true);

  const parserFailure = await rejectsWithCode(
    fetchOnce(
      sourceFor(
        harness({
          '/problem/P3374': () =>
            jsonResponse({ data: { errorCode: 418, errorType: `teapot ${SESSION_SECRET}` } }),
        }),
      ),
    ),
    'changed_response',
  );
  assertNoSecret(parserFailure);
  assert.ok(!String(parserFailure.detail).includes('teapot'), 'server-provided errorType text never survives');
});

test('auth walls, permission walls, rate limits and a blank description stay distinct', async () => {
  const auth = await rejectsWithCode(
    fetchOnce(sourceFor(harness({ '/problem/P3374': () => new Response('denied', { status: 401 }) }))),
    'auth_required',
  );
  assert.equal(auth.retryable, false);
  assert.equal(auth.reason ?? null, null);

  const forbidden = await rejectsWithCode(
    fetchOnce(sourceFor(harness({ '/problem/P3374': () => new Response('no', { status: 403 }) }))),
    'forbidden',
  );
  assert.equal(forbidden.retryable, false);

  const limited = await rejectsWithCode(
    fetchOnce(
      sourceFor(
        harness({
          '/problem/P3374': () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
        }),
      ),
    ),
    'rate_limited',
  );
  assert.equal(limited.retryAfterMs, 3000, 'the declared delay is preserved exactly');
  assert.equal(limited.retryable, true);

  const blank = await rejectsWithCode(
    fetchOnce(
      sourceFor(
        harness({
          '/problem/P3374': () =>
            jsonResponse(
              detailPayload({
                content: { name: 'X', background: null, description: '   ', formatI: '输入', formatO: '输出', hint: null },
              }),
            ),
        }),
      ),
    ),
    'changed_response',
  );
  assert.equal(blank.reason, 'missing_statement');
  assert.ok(!String(blank.detail).includes('description'), 'the raw parser sentence is replaced by the fixed one');

  const bodyAuth = await rejectsWithCode(
    fetchOnce(
      sourceFor(
        harness({ '/problem/T1234': () => jsonResponse({ data: { errorCode: 401, errorType: 'UserUnloginException' } }) }),
      ),
      { pid: 'T1234' },
    ),
    'auth_required',
  );
  assertNoSecret(bodyAuth);
});

test('changed-response reasons stay diagnostic while the body itself never travels', async () => {
  const html = await rejectsWithCode(
    fetchOnce(
      sourceFor(
        harness({
          '/problem/P3374': () => htmlResponse(`<!doctype html><html><body>${SESSION_SECRET}</body></html>`),
        }),
      ),
    ),
    'changed_response',
  );
  assert.equal(html.reason, 'html_response');
  assert.equal(html.sample, null, 'an authenticated failure never carries a body sample');
  assertNoSecret(html);

  const badJson = await rejectsWithCode(
    fetchOnce(
      sourceFor(
        harness({
          '/problem/P3374': () =>
            new Response(`{"data": ${SESSION_SECRET}`, { status: 200, headers: { 'content-type': 'application/json' } }),
        }),
      ),
    ),
    'changed_response',
  );
  assert.equal(badJson.reason, 'invalid_json');
  assert.equal(badJson.sample, null);
  assertNoSecret(badJson);

  const badShape = await rejectsWithCode(
    fetchOnce(sourceFor(harness({ '/problem/P3374': () => jsonResponse([SESSION_SECRET, 'nope']) }))),
    'changed_response',
  );
  assert.equal(badShape.reason, 'invalid_payload');
  assert.equal(badShape.sample, null);
  assertNoSecret(badShape);

  const missing = await rejectsWithCode(
    fetchOnce(
      sourceFor(
        harness({ '/problem/P3374': () => jsonResponse(detailPayload({ content: { name: 'X', description: null } })) }),
      ),
    ),
    'changed_response',
  );
  assert.equal(missing.reason, 'missing_statement');

  // A `T`-prefixed personal problem is neither an auth wall nor automatically statement-less: a
  // complete detail is accepted, an auth denial stays an auth denial, and only a payload that
  // really lacks a description is reported as `missing_statement`.
  const complete = await fetchOnce(
    sourceFor(harness({ '/problem/T1234': () => jsonResponse(detailPayload({ pid: 'T1234' })) })),
    { pid: 'T1234' },
  );
  assert.equal(complete.ref.externalKey, 'T1234');
  assert.ok(complete.statement?.includes(STATEMENT_MARKER));

  const denied = await rejectsWithCode(
    fetchOnce(sourceFor(harness({ '/problem/T1234': () => new Response('login', { status: 401 }) })), { pid: 'T1234' }),
    'auth_required',
  );
  assertNoSecret(denied);

  const personalMissing = await rejectsWithCode(
    fetchOnce(
      sourceFor(
        harness({
          '/problem/T1234': () => jsonResponse(detailPayload({ pid: 'T1234', content: { name: 'X', description: null } })),
        }),
      ),
      { pid: 'T1234' },
    ),
    'changed_response',
  );
  assert.equal(personalMissing.reason, 'missing_statement');
});

test('every call resolves the session fresh and a failed call leaves nothing bound behind', async () => {
  const h = harness({ '/problem/P3374': () => jsonResponse(detailPayload()) });
  const scripted: readonly (LuoguSession | Error)[] = [
    SESSION,
    new PlatformError({
      code: 'auth_required',
      operation: 'submissions',
      retryable: false,
      detail: `expired ${SESSION_SECRET}`,
    }),
    { uid: UID, cookie: OTHER_COOKIE },
  ];
  let index = 0;
  const provider: LuoguSessionProvider = {
    sessionFor: async () => {
      const step = scripted[index];
      index += 1;
      if (step === undefined) {
        throw new Error('the provider was called more often than the script allows');
      }
      if (step instanceof Error) {
        throw step;
      }
      return step;
    },
  };
  const source = sourceFor(h, provider);

  await fetchOnce(source);
  assert.equal(h.requests[0]!.init.headers.cookie, CANONICAL_COOKIE);

  const failure = await rejectsWithCode(fetchOnce(source), 'auth_required');
  assertNoSecret(failure);
  assert.equal(h.requests.length, 1, 'a refused session never reaches the network');

  await fetchOnce(source);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1]!.init.headers.cookie, OTHER_COOKIE, 'the next call binds its own fresh session');
  assert.equal(index, 3, 'the session is resolved once per owning call');
});

test('cancellation stays cancellation before, during and after the provider', async () => {
  const preCancelled = createCancellationSource();
  preCancelled.cancel('user stopped');
  const counter = countingProvider();
  const quiet = harness({});
  const beforeError = await fetchOnce(sourceFor(quiet, counter.provider), { token: preCancelled.token }).then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.ok(beforeError instanceof DomainError, `expected a cancellation, got ${String(beforeError)}`);
  assert.equal(codeOf(beforeError), 'cancelled');
  assert.equal(counter.calls.length, 0, 'a cancelled call never consults the provider');
  assert.equal(quiet.requests.length, 0);

  const hanging = harness({ '/problem/P3374': hangUntilAbort });
  const cancellation = createCancellationSource();
  const pending = fetchOnce(sourceFor(hanging), { token: cancellation.token });
  await tick();
  cancellation.cancel('user stopped');
  const duringError = await pending.then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.ok(duringError instanceof DomainError, `expected a cancellation, got ${String(duringError)}`);
  assert.equal(hanging.requests.length, 1, 'the request was really in flight when it was cancelled');

  let release!: (session: LuoguSession) => void;
  const slowProvider: LuoguSessionProvider = {
    sessionFor: () =>
      new Promise<LuoguSession>((resolve) => {
        release = resolve;
      }),
  };
  const delayed = createCancellationSource();
  const waiting = fetchOnce(sourceFor(harness({}), slowProvider), { token: delayed.token });
  await tick();
  delayed.cancel('user stopped');
  release(SESSION);
  const afterError = await waiting.then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.ok(afterError instanceof DomainError, `expected a cancellation, got ${String(afterError)}`);
  assert.equal(codeOf(afterError), 'cancelled');

  // The cancelled call released its slot: the same source is usable again afterwards.
  const reusable = sourceFor(harness({ '/problem/P3374': () => jsonResponse(detailPayload()) }));
  assert.equal((await fetchOnce(reusable)).title, '树状数组 1');
});

test('an overlapping call is refused before the provider and the slot is released afterwards', async () => {
  const h = harness({ '/problem/P3374': () => jsonResponse(detailPayload()) });
  let release!: (session: LuoguSession) => void;
  let calls = 0;
  const provider: LuoguSessionProvider = {
    sessionFor: () => {
      calls += 1;
      return new Promise<LuoguSession>((resolve) => {
        release = resolve;
      });
    },
  };
  const source = sourceFor(h, provider);

  const first = fetchOnce(source);
  const overlap = await rejectsWithCode(fetchOnce(source), 'unavailable');
  assert.equal(overlap.retryable, true);
  assert.equal(calls, 1, 'the second call never consults the provider');
  assert.equal(h.requests.length, 0);

  release(SESSION);
  assert.equal((await first).title, '树状数组 1');
  assert.equal(h.requests.length, 1);

  const again = fetchOnce(source);
  assert.equal(calls, 2, 'the new owning call reads a fresh session');
  release(SESSION);
  await again;
  assert.equal(h.requests.length, 2, 'the slot is released after the owning call settles');
});

test('the authenticated problem transport keeps the two-second floor and the retry budget', async () => {
  let attempts = 0;
  const h = harness({
    '/problem/P3374': () => {
      attempts += 1;
      return attempts <= 2 ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(detailPayload());
    },
  });
  const source = sourceFor(h);
  const problem = await fetchOnce(source, { limits: { ...LIMITS, maxRetries: 2 } });
  assert.equal(problem.title, '树状数组 1');
  assert.deepEqual(
    h.requests.map((request) => request.at),
    [0, 2000, 4000],
    'the 2 s platform floor paces every attempt, whatever a caller asked for',
  );
  assert.deepEqual(h.waits, [2000, 2000]);

  await fetchOnce(source);
  assert.equal(h.requests[3]!.at, 6000, 'pacing is shared across calls of the same source instance');

  const exhausted = harness({ '/problem/P3374': () => new Response('boom', { status: 500 }) });
  const failure = await rejectsWithCode(
    fetchOnce(sourceFor(exhausted), { limits: { ...LIMITS, maxRetries: 1 } }),
    'unavailable',
  );
  assert.equal(failure.retryable, true);
  assert.equal(failure.attempts, 2, 'the retry budget bounds the dispatched attempts');
  assert.equal(exhausted.requests.length, 2);
});

test('root viewer fields are never turned into problem data', async () => {
  const viewer = 'VIEWER-ONLY-MARKER';
  const h = harness({
    '/problem/P3374': () =>
      jsonResponse({
        user: { uid: OTHER_UID, name: viewer },
        data: { user: { uid: OTHER_UID, name: viewer }, problem: problemBody() },
      }),
  });
  const problem = await fetchOnce(sourceFor(h));
  assert.equal(problem.title, '树状数组 1');
  assert.ok(problem.statement?.includes(STATEMENT_MARKER));
  assert.ok(!JSON.stringify(problem).includes(viewer), 'no viewer field reaches the normalized problem');
});
