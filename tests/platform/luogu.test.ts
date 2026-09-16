/**
 * Luogu adapter regressions: list paging and cursor drift, raw tag/difficulty provenance, detail
 * statement assembly, typed authentication failures for the unverified authenticated endpoints,
 * and cancellation. Every payload here is a small original synthetic shape; no network is used
 * (responses come from the in-process harness or an injected fetch stub).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_BASE_URL,
  createLuoguAccount,
  createLuoguAdapter,
  encodeLuoguListCursor,
  luoguSourceInstance,
  parseProblemList,
  type LuoguAdapterOptions,
} from '../../src/adapters/luogu/index.js';
// The adapter verifies a cursor's stored fingerprint with this exact helper; the crafted-cursor
// regression below needs the fingerprint of a page it never received from a previous call.
import { luoguServerPageFingerprint } from '../../src/adapters/luogu/cursors.js';
import type { PlatformLimits } from '../../src/application/ports.js';
import { createAccount, createCancellationSource, createSourceInstance } from '../../src/domain/index.js';
import {
  AT,
  createHttpHarness,
  hangUntilAbort,
  htmlResponse,
  jsonResponse,
  tick,
  type HttpHarness,
  type HttpHarnessOptions,
} from './fixtures.js';

const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 30_000,
  maxRetries: 0,
  pageSize: 100,
  maxConcurrency: 1,
};
const SOURCE = luoguSourceInstance();
const ref = (pid: string) => ({ sourceInstanceId: SOURCE.id, domain: null, externalKey: pid });

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
    return true;
  });
}

function harness(routes: HttpHarnessOptions['routes']): HttpHarness {
  return createHttpHarness({ origin: LUOGU_BASE_URL, routes });
}

function adapterFor(h: HttpHarness, options: Partial<LuoguAdapterOptions> = {}) {
  return createLuoguAdapter({
    sourceInstance: SOURCE,
    transport: h.transport,
    clock: () => Date.parse(AT),
    ...options,
  });
}

function summary(input: { pid: string; name: string; difficulty?: number | null; tags?: readonly number[] }) {
  return {
    pid: input.pid,
    name: input.name,
    difficulty: input.difficulty === undefined ? 4 : input.difficulty,
    tags: [...(input.tags ?? [53])],
  };
}

function listPayload(
  result: readonly Record<string, unknown>[],
  options: { perPage?: number; count?: number } = {},
): unknown {
  return {
    data: { problems: { perPage: options.perPage ?? 50, count: options.count ?? result.length, result: [...result] } },
  };
}

/** A server that pages `items` in fixed `perPage` slices. */
function pagedRoute(items: readonly Record<string, unknown>[], perPage: number) {
  return (url: URL): Response => {
    const page = Number(url.searchParams.get('page') ?? '1');
    return jsonResponse(listPayload(items.slice((page - 1) * perPage, page * perPage), { perPage, count: items.length }));
  };
}

function detailPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      problem: {
        pid: 'P3374',
        difficulty: 4,
        tags: [53, 523],
        content: {
          name: '树状数组 1',
          background: null,
          description: '维护数列 $a_1, a_2, \\dots, a_n$ 的前缀和。',
          formatI: '第一行两个整数 $n, m$。',
          formatO: '对于每个询问输出一行。',
          hint: '复杂度 $O(\\log n)$。',
          locale: 'zh-CN',
        },
        samples: [['3 2\n1 2 3\n1 1 3\n2 2 5', '6']],
        limits: { time: [1000], memory: [524288] },
        ...overrides,
      },
    },
  };
}

test('an exact client limit pages across server pages without skipping or duplicating', async () => {
  const items = [
    summary({ pid: 'P1000', name: 'A', tags: [1] }),
    summary({ pid: 'P1001', name: 'B', tags: [-2] }),
    summary({ pid: 'P1002', name: 'C' }),
    summary({ pid: 'P1003', name: 'D' }),
    summary({ pid: 'P1004', name: 'E' }),
  ];
  const h = harness({ '/problem/list': pagedRoute(items, 2) });
  const adapter = adapterFor(h);
  const token = createCancellationSource().token;

  const first = await adapter.listProblems({ cursor: null, limit: 1, token, limits: LIMITS });
  assert.deepEqual(
    first.items.map((problem) => problem.title),
    ['A'],
  );
  assert.notEqual(first.nextCursor, null);

  const rest = await adapter.listProblems({ cursor: first.nextCursor, limit: 10, token, limits: LIMITS });
  assert.deepEqual(
    rest.items.map((problem) => problem.title),
    ['B', 'C', 'D', 'E'],
  );
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(
    rest.items[0]?.rawTags.map((tag) => tag.raw),
    ['luogu-tag:-2'],
  );
  assert.deepEqual(
    rest.items[0]?.ratings.map((rating) => [rating.dimension, rating.value, rating.raw, rating.scale]),
    [['difficulty', 4, '4', null]],
  );
  assert.equal(rest.items[0]?.url, 'https://www.luogu.com.cn/problem/P1001');
  assert.deepEqual(
    h.requests.map((request) => new URL(request.url).searchParams.get('page')),
    ['1', '1', '2', '3'],
  );
});

test('a client limit above the server page size consumes consecutive server pages', async () => {
  const items = Array.from({ length: 125 }, (_, index) => summary({ pid: `P${2000 + index}`, name: `T${index}` }));
  const h = harness({ '/problem/list': pagedRoute(items, 50) });
  const adapter = adapterFor(h);
  const page = await adapter.listProblems({
    cursor: null,
    limit: 120,
    token: createCancellationSource().token,
    limits: { ...LIMITS, pageSize: 500 },
  });
  assert.equal(page.items.length, 120);
  assert.deepEqual(
    [page.items[0]?.title, page.items[119]?.title],
    ['T0', 'T119'],
  );
  assert.notEqual(page.nextCursor, null);
  assert.deepEqual(
    h.requests.map((request) => new URL(request.url).searchParams.get('page')),
    ['1', '2', '3'],
  );
});

test('a continued cursor refuses a moved boundary or a changed total and asks for a restart', async () => {
  const items = [summary({ pid: 'P1000', name: 'A' }), summary({ pid: 'P1001', name: 'B' }), summary({ pid: 'P1002', name: 'C' })];
  let replaced = false;
  const moving = harness({
    '/problem/list': (url: URL) => {
      const current = replaced ? [summary({ pid: 'P9999', name: 'X' }), items[1]!, items[2]!] : items;
      return pagedRoute(current, 2)(url);
    },
  });
  const movingAdapter = adapterFor(moving);
  const token = createCancellationSource().token;
  const first = await movingAdapter.listProblems({ cursor: null, limit: 1, token, limits: LIMITS });
  replaced = true;
  const drift = await movingAdapter
    .listProblems({ cursor: first.nextCursor, limit: 2, token, limits: LIMITS })
    .then(() => null, (error: unknown) => error);
  assert.equal(codeOf(drift), 'changed_response');
  assert.match(String((drift as Error).message), /restart the listing/);

  let grown = false;
  const growing = harness({
    '/problem/list': (url: URL) => {
      const current = grown ? [...items, summary({ pid: 'P1003', name: 'D' })] : items;
      return pagedRoute(current, 2)(url);
    },
  });
  const growingAdapter = adapterFor(growing);
  const start = await growingAdapter.listProblems({ cursor: null, limit: 1, token, limits: LIMITS });
  grown = true;
  await rejectsWithCode(growingAdapter.listProblems({ cursor: start.nextCursor, limit: 2, token, limits: LIMITS }), 'changed_response');
});

test('foreign, stale-version and unsafe cursors are rejected before any request', async () => {
  const h = harness({ '/problem/list': () => jsonResponse(listPayload([])) });
  const adapter = adapterFor(h);
  const token = createCancellationSource().token;
  const raw = (payload: unknown): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const fingerprint = 'a'.repeat(64);

  const foreign = encodeLuoguListCursor({
    sourceInstanceId: 'luogu:example.com',
    accountId: null,
    page: 1,
    offset: 1,
    perPage: 2,
    count: 3,
    lastPid: 'P1000',
    pageFingerprint: fingerprint,
  });
  await rejectsWithCode(adapter.listProblems({ cursor: foreign, limit: 1, token, limits: LIMITS }), 'invalid_input');

  const base = {
    version: 2,
    sourceInstanceId: SOURCE.id,
    accountId: null,
    perPage: 2,
    count: 3,
    lastPid: 'P1000',
    pageFingerprint: fingerprint,
    checksum: 'x',
  };
  const unsafe = [
    raw({ ...base, version: 99, page: 1, offset: 1 }),
    raw({ ...base, page: 0, offset: 1 }),
    raw({ ...base, page: 1, offset: 3 }),
    raw({ ...base, page: 1, offset: 0, lastPid: 'P1000' }),
    raw({ ...base, page: 1, offset: 1, pageFingerprint: 'not-a-fingerprint' }),
    'not-base64url!!',
  ];
  for (const cursor of unsafe) {
    await rejectsWithCode(adapter.listProblems({ cursor, limit: 1, token, limits: LIMITS }), 'invalid_input');
  }

  // A version 1 token carries no server-page fingerprint: it is refused with a restart request.
  const stale = raw({ ...base, version: 1, page: 1, offset: 1, fingerprint });
  const staleError = await adapter
    .listProblems({ cursor: stale, limit: 1, token, limits: LIMITS })
    .then(() => null, (error: unknown) => error);
  assert.equal(codeOf(staleError), 'invalid_input');
  assert.match(String(staleError instanceof Error ? staleError.message : staleError), /restart the listing/);

  const resolving = adapterFor(h, { resolveTagNames: true });
  await rejectsWithCode(resolving.listProblems({ cursor: foreign, limit: 1, token, limits: LIMITS }), 'invalid_input');
  assert.equal(h.requests.length, 0);
});

test('instance, account, limit and cursor validation happen before any fetch', async () => {
  const h = harness({ '/problem/list': () => jsonResponse(listPayload([summary({ pid: 'P1000', name: 'A' })])) });
  const adapter = adapterFor(h);
  const token = createCancellationSource().token;
  const foreignInstance = createSourceInstance({ platform: 'luogu', baseUrl: 'https://example.com', domain: 'example.com' });

  await rejectsWithCode(
    adapter.listProblems({
      cursor: null,
      limit: 10,
      token,
      limits: LIMITS,
      account: createAccount({ sourceInstanceId: foreignInstance.id, handle: 'alice' }),
    }),
    'invalid_input',
  );
  await rejectsWithCode(adapter.listProblems({ cursor: null, limit: 0, token, limits: LIMITS }), 'invalid_input');
  await rejectsWithCode(adapter.listProblems({ cursor: null, limit: 501, token, limits: LIMITS }), 'invalid_input');
  await rejectsWithCode(
    adapter.listProblems({ cursor: null, limit: 10, token, limits: { ...LIMITS, pageSize: 0 } }),
    'invalid_input',
  );
  await rejectsWithCode(
    adapter.listProblems({ cursor: null, limit: 10, token, limits: { ...LIMITS, minRequestIntervalMs: Number.NaN } }),
    'invalid_input',
  );
  assert.equal(h.requests.length, 0);

  const rejectInstance = (instance: ReturnType<typeof createSourceInstance>): void => {
    assert.throws(
      () => createLuoguAdapter({ sourceInstance: instance, transport: h.transport }),
      (error: unknown) => codeOf(error) === 'invalid_input',
    );
  };
  rejectInstance(foreignInstance);
  rejectInstance(createSourceInstance({ platform: 'luogu', baseUrl: 'https://www.luogu.com.cn/gym' }));
  rejectInstance(createSourceInstance({ platform: 'luogu', baseUrl: 'https://www.luogu.com.cn:8443' }));
});

test('HTTP and body failures stay typed and never become an empty page', async () => {
  const cases: readonly (readonly [() => Response, string])[] = [
    [() => jsonResponse({}, 401), 'auth_required'],
    [() => jsonResponse({ data: { errorCode: 401, errorType: 'UserUnloginException' } }), 'auth_required'],
    [() => jsonResponse({}, 403), 'forbidden'],
    [() => jsonResponse({}, 429), 'rate_limited'],
    [() => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }), 'changed_response'],
    [() => htmlResponse('<html><body>challenge</body></html>'), 'changed_response'],
  ];
  for (const [route, code] of cases) {
    const adapter = adapterFor(harness({ '/problem/list': route }));
    await rejectsWithCode(adapter.listProblems({ cursor: null, limit: 10, token: createCancellationSource().token, limits: LIMITS }), code);
  }

  const limited = adapterFor(
    harness({
      '/problem/list': () =>
        new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } }),
    }),
  );
  const error = await limited
    .listProblems({ cursor: null, limit: 10, token: createCancellationSource().token, limits: LIMITS })
    .then(() => null, (cause: unknown) => cause);
  assert.equal(codeOf(error), 'rate_limited');
  assert.equal((error as { retryAfterMs?: number }).retryAfterMs, 2000);
});

test('detail combines every section and sample and keeps raw difficulty, tags and limits', async () => {
  const h = harness({ '/problem/P3374': () => jsonResponse(detailPayload()) });
  const adapter = adapterFor(h);
  const { problem, detail } = await adapter.fetchProblemDetail({
    problemRef: ref('P3374'),
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  const statement = problem.statement ?? '';
  for (const marker of [
    '## 题目描述',
    '## 输入格式',
    '## 输出格式',
    '## 提示',
    '## 样例 #1',
    '$a_1, a_2, \\dots, a_n$',
    '1 1 3',
    '复杂度 $O(\\log n)$',
  ]) {
    assert.ok(statement.includes(marker), `statement is missing ${marker}`);
  }
  assert.equal(problem.title, '树状数组 1');
  assert.deepEqual(
    problem.rawTags.map((tag) => tag.raw),
    ['luogu-tag:53', 'luogu-tag:523'],
  );
  assert.deepEqual(detail.timeLimitsMs, [1000]);
  assert.deepEqual(detail.memoryLimitsKib, [524288]);
  assert.equal(h.requests[0]?.init.headers['x-lentille-request'], 'content-only');
});

test('detail refuses a foreign pid, missing sections and invalid limits', async () => {
  const cases: readonly (readonly [unknown, string])[] = [
    [detailPayload({ pid: 'P9999' }), 'changed_response'],
    [detailPayload({ content: { name: 'X', background: null, description: null, formatI: null, formatO: null, hint: null } }), 'changed_response'],
    // Input/output format alone is never promoted to a full statement.
    [
      detailPayload({ content: { name: 'X', background: '背景', description: null, formatI: '输入', formatO: '输出', hint: null } }),
      'changed_response',
    ],
    [detailPayload({ content: { name: 'X', description: '   ', formatI: '输入格式' } }), 'changed_response'],
    [detailPayload({ limits: { time: ['soon'], memory: [524288] } }), 'changed_response'],
    [detailPayload({ samples: [['only input']] }), 'changed_response'],
    [detailPayload({ tags: [53.5] }), 'changed_response'],
  ];
  for (const [payload, code] of cases) {
    const adapter = adapterFor(harness({ '/problem/P3374': () => jsonResponse(payload) }));
    await rejectsWithCode(
      adapter.fetchProblem({ problemRef: ref('P3374'), token: createCancellationSource().token, limits: LIMITS }),
      code,
    );
  }

  const untouched = adapterFor(harness({}));
  const token = createCancellationSource().token;
  await rejectsWithCode(
    untouched.fetchProblem({
      problemRef: { sourceInstanceId: 'luogu:example.com', domain: null, externalKey: 'P3374' },
      token,
      limits: LIMITS,
    }),
    'invalid_input',
  );
  await rejectsWithCode(untouched.fetchProblem({ problemRef: ref('P3374/../x'), token, limits: LIMITS }), 'invalid_input');
});

test('raw tag ids stay visible and explicit dictionary names are added next to them', async () => {
  const h = harness({
    '/problem/list': () => jsonResponse(listPayload([summary({ pid: 'P1000', name: 'A', tags: [53, -2, 999] })])),
  });
  const adapter = adapterFor(h, {
    tagDictionary: new Map([
      [53, '树状数组'],
      [-2, '负编号标签'],
    ]),
  });
  const page = await adapter.listProblems({ cursor: null, limit: 10, token: createCancellationSource().token, limits: LIMITS });
  assert.deepEqual(
    page.items[0]?.rawTags.map((tag) => tag.raw),
    ['luogu-tag:53', '树状数组', 'luogu-tag:-2', '负编号标签', 'luogu-tag:999'],
  );
  assert.equal(h.requests.length, 1);
});

test('resolveTagNames loads the dictionary first and surfaces dictionary failures', async () => {
  const h = harness({
    '/_lfe/tags': () =>
      jsonResponse({
        tags: [
          { id: 53, name: '树状数组', type: 2, parent: null },
          { id: -2, name: '负编号标签', type: 1, parent: 3 },
        ],
        types: [],
        _locale: 'zh-CN',
        _version: 1,
      }),
    '/problem/list': () => jsonResponse(listPayload([summary({ pid: 'P1000', name: 'A', tags: [53, -2, 7] })])),
  });
  const adapter = adapterFor(h, { resolveTagNames: true });
  const page = await adapter.listProblems({ cursor: null, limit: 10, token: createCancellationSource().token, limits: LIMITS });
  assert.deepEqual(
    page.items[0]?.rawTags.map((tag) => tag.raw),
    ['luogu-tag:53', '树状数组', 'luogu-tag:-2', '负编号标签', 'luogu-tag:7'],
  );
  assert.deepEqual(
    h.requests.map((request) => new URL(request.url).pathname),
    ['/_lfe/tags', '/problem/list'],
  );

  const empty = adapterFor(harness({ '/_lfe/tags': () => jsonResponse({ tags: [] }) }), { resolveTagNames: true });
  await rejectsWithCode(
    empty.listProblems({ cursor: null, limit: 10, token: createCancellationSource().token, limits: LIMITS }),
    'changed_response',
  );

  const down = adapterFor(harness({ '/_lfe/tags': () => jsonResponse({}, 503) }), { resolveTagNames: true });
  await rejectsWithCode(
    down.listProblems({ cursor: null, limit: 10, token: createCancellationSource().token, limits: LIMITS }),
    'unavailable',
  );
});

test('capabilities stay honest and authenticated operations answer with typed failures', async () => {
  const h = harness({
    '/problem/solution/P3374': () => jsonResponse({ data: { errorCode: 401, errorType: 'UserUnloginException' } }, 401),
    '/record/list': () => jsonResponse({ data: { errorCode: 401, errorType: 'UserUnloginException' } }, 401),
  });
  const adapter = adapterFor(h);
  const capabilities = adapter.capabilities();
  assert.equal(capabilities.implemented, true);
  assert.equal(capabilities.problems, true);
  assert.equal(capabilities.pagedProblems, true);
  assert.equal(capabilities.submissions, false);
  assert.equal(capabilities.pagedSubmissions, false);
  assert.equal(capabilities.editorial, false);
  assert.equal(capabilities.requiresAuth, true);
  assert.equal(capabilities.supportsAccountHistory, false);

  const token = createCancellationSource().token;
  const editorial = await adapter.fetchEditorial({ problemRef: ref('P3374'), token, limits: LIMITS });
  assert.equal(editorial.status, 'auth_required');
  await rejectsWithCode(
    adapter.listSubmissions({
      account: createAccount({ sourceInstanceId: SOURCE.id, handle: 'alice' }),
      cursor: null,
      limit: 10,
      token,
      limits: LIMITS,
    }),
    'auth_required',
  );

  const forbidden = adapterFor(harness({ '/problem/solution/P3374': () => jsonResponse({}, 403) }));
  assert.equal((await forbidden.fetchEditorial({ problemRef: ref('P3374'), token, limits: LIMITS })).status, 'forbidden');
});

test('unfamiliar successful authenticated payloads are changed_response, never absent', async () => {
  const h = harness({
    '/problem/solution/P3374': () => jsonResponse({ data: { solutions: [], count: 0 } }),
    '/record/list': () => jsonResponse({ data: { records: [], count: 0 } }),
  });
  const adapter = adapterFor(h);
  const token = createCancellationSource().token;
  const editorial = await adapter.fetchEditorial({ problemRef: ref('P3374'), token, limits: LIMITS });
  assert.equal(editorial.status, 'changed_response');
  if (editorial.status === 'changed_response') {
    // The anonymous probe never quotes the body it received: a sample travels into stored notes and
    // into DTOs, so if that surface ever answers material it must not be reproduced there.
    assert.equal(editorial.sample, null);
    assert.equal(editorial.detail.includes('"solutions"'), false);
  }
  await rejectsWithCode(
    adapter.listSubmissions({
      account: createAccount({ sourceInstanceId: SOURCE.id, handle: 'alice' }),
      cursor: null,
      limit: 10,
      token,
      limits: LIMITS,
    }),
    'changed_response',
  );

  const untouched = adapterFor(harness({}));
  await rejectsWithCode(
    untouched.fetchEditorial({
      problemRef: ref('P3374'),
      token,
      limits: LIMITS,
      officialTutorialUrl: 'https://evil.example/problem/solution/P3374',
    }),
    'invalid_input',
  );
});

test('cancellation is observed before dispatch and during a request', async () => {
  const h = harness({ '/problem/list': hangUntilAbort });
  const adapter = adapterFor(h);
  const pre = createCancellationSource();
  pre.cancel('before start');
  await rejectsWithCode(
    adapter.listProblems({ cursor: null, limit: 10, token: pre.token, limits: LIMITS }),
    'cancelled',
  );
  assert.equal(h.requests.length, 0);

  const during = createCancellationSource();
  const pending = adapter.listProblems({ cursor: null, limit: 10, token: during.token, limits: LIMITS });
  await tick();
  during.cancel('mid flight');
  await rejectsWithCode(pending, 'cancelled');
});

test('integration: an injected fetch stub serves only synthetic counts and titles', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/problem/list') {
      return jsonResponse(
        listPayload([
          summary({ pid: 'P1000', name: 'Synthetic A' }),
          summary({ pid: 'P1001', name: 'Synthetic B' }),
        ]),
      );
    }
    return jsonResponse(detailPayload({ pid: path.split('/').pop() }));
  };
  const adapter = createLuoguAdapter({ sourceInstance: SOURCE, fetchImpl, clock: () => Date.parse(AT) });
  const token = createCancellationSource().token;
  const page = await adapter.listProblems({ cursor: null, limit: 2, token, limits: LIMITS });
  assert.deepEqual(
    page.items.map((problem) => problem.title),
    ['Synthetic A', 'Synthetic B'],
  );
  assert.equal(page.items.length, 2);
  const problem = await adapter.fetchProblem({ problemRef: page.items[0]!.ref, token, limits: LIMITS });
  assert.equal(problem.title, '树状数组 1');
  assert.ok((problem.statement ?? '').includes('## 样例 #1'));
  assert.deepEqual(calls, ['/problem/list', '/problem/P1000']);
});

test('a full server page stays in the cursor and is re-verified before the listing advances', async () => {
  const items = ['P1000', 'P1001', 'P1002', 'P1003', 'P1004', 'P1005'].map((pid, index) =>
    summary({ pid, name: `T${index}` }),
  );
  const h = harness({ '/problem/list': pagedRoute(items, 2) });
  const adapter = adapterFor(h);
  const token = createCancellationSource().token;

  const first = await adapter.listProblems({ cursor: null, limit: 2, token, limits: LIMITS });
  assert.deepEqual(first.items.map((problem) => problem.title), ['T0', 'T1']);
  assert.notEqual(first.nextCursor, null);

  const second = await adapter.listProblems({ cursor: first.nextCursor, limit: 2, token, limits: LIMITS });
  assert.deepEqual(second.items.map((problem) => problem.title), ['T2', 'T3']);
  assert.notEqual(second.nextCursor, null);

  const third = await adapter.listProblems({ cursor: second.nextCursor, limit: 2, token, limits: LIMITS });
  assert.deepEqual(third.items.map((problem) => problem.title), ['T4', 'T5']);
  assert.equal(third.nextCursor, null, 'a last page that is an exact multiple must end the listing');

  const delivered = [...first.items, ...second.items, ...third.items].map((problem) => problem.ref.externalKey);
  assert.deepEqual(delivered, ['P1000', 'P1001', 'P1002', 'P1003', 'P1004', 'P1005']);
  assert.equal(new Set(delivered).size, delivered.length);
  assert.deepEqual(
    h.requests.map((request) => new URL(request.url).searchParams.get('page')),
    ['1', '1', '2', '2', '3'],
  );
});

test('a continuation re-reads its cursor page and rejects a changed middle with an unchanged boundary', async () => {
  const firstPage = [summary({ pid: 'P1000', name: 'A' }), summary({ pid: 'P1001', name: 'B' })];
  const secondPage = [summary({ pid: 'P1002', name: 'C' }), summary({ pid: 'P1003', name: 'D' })];
  let mutate = false;
  const h = harness({
    '/problem/list': (url: URL) => {
      const page =
        url.searchParams.get('page') === '1'
          ? mutate
            ? [summary({ pid: 'P1000', name: 'A rewritten' }), firstPage[1]!]
            : firstPage
          : secondPage;
      return jsonResponse(listPayload(page, { perPage: 2, count: 4 }));
    },
  });
  const adapter = adapterFor(h);
  const token = createCancellationSource().token;
  const first = await adapter.listProblems({ cursor: null, limit: 2, token, limits: LIMITS });
  assert.notEqual(first.nextCursor, null);

  mutate = true;
  const drift = await adapter
    .listProblems({ cursor: first.nextCursor, limit: 2, token, limits: LIMITS })
    .then(() => null, (error: unknown) => error);
  assert.equal(codeOf(drift), 'changed_response');
  assert.match(String(drift instanceof Error ? drift.message : drift), /restart the listing/);
});

test('server page length, cursor position and repeated pids are rejected before any result', async () => {
  const token = createCancellationSource().token;

  // A non-final page that answers fewer entries than the declared total would silently skip records.
  const shortPage = adapterFor(
    harness({
      '/problem/list': () => jsonResponse(listPayload([summary({ pid: 'P1000', name: 'A' })], { perPage: 2, count: 6 })),
    }),
  );
  await rejectsWithCode(shortPage.listProblems({ cursor: null, limit: 6, token, limits: LIMITS }), 'changed_response');

  // A page that answers more entries than the declared total allows.
  const longPage = adapterFor(
    harness({
      '/problem/list': (url: URL) =>
        jsonResponse(
          listPayload(
            url.searchParams.get('page') === '2'
              ? [summary({ pid: 'P1002', name: 'C' }), summary({ pid: 'P1003', name: 'D' })]
              : [summary({ pid: 'P1000', name: 'A' }), summary({ pid: 'P1001', name: 'B' })],
            { perPage: 2, count: 3 },
          ),
        ),
    }),
  );
  await rejectsWithCode(longPage.listProblems({ cursor: null, limit: 3, token, limits: LIMITS }), 'changed_response');

  // The same pid twice inside one page, and across two pages of one call.
  const repeatedInPage = adapterFor(
    harness({
      '/problem/list': () =>
        jsonResponse(
          listPayload([summary({ pid: 'P1000', name: 'A' }), summary({ pid: 'P1000', name: 'A again' })], {
            perPage: 2,
            count: 2,
          }),
        ),
    }),
  );
  await rejectsWithCode(repeatedInPage.listProblems({ cursor: null, limit: 2, token, limits: LIMITS }), 'changed_response');

  const repeatedAcrossPages = adapterFor(
    harness({
      '/problem/list': (url: URL) =>
        jsonResponse(
          listPayload(
            url.searchParams.get('page') === '1'
              ? [summary({ pid: 'P1000', name: 'A' }), summary({ pid: 'P1001', name: 'B' })]
              : [summary({ pid: 'P1000', name: 'A again' }), summary({ pid: 'P1002', name: 'C' })],
            { perPage: 2, count: 4 },
          ),
        ),
    }),
  );
  await rejectsWithCode(repeatedAcrossPages.listProblems({ cursor: null, limit: 4, token, limits: LIMITS }), 'changed_response');

  // A cursor whose position lies past the declared total is refused instead of silently truncated.
  const items = ['P1000', 'P1001', 'P1002', 'P1003', 'P1004'].map((pid, index) => summary({ pid, name: `T${index}` }));
  const lastPage = parseProblemList(
    listPayload([summary({ pid: 'P1004', name: 'T4' })], { perPage: 2, count: 5 }) as Record<string, unknown>,
    'catalog',
  );
  const crafted = encodeLuoguListCursor({
    sourceInstanceId: SOURCE.id,
    accountId: null,
    page: 3,
    offset: 2,
    perPage: 2,
    count: 5,
    lastPid: 'P1004',
    pageFingerprint: luoguServerPageFingerprint(3, lastPage),
  });
  const craftedAdapter = adapterFor(harness({ '/problem/list': pagedRoute(items, 2) }));
  await rejectsWithCode(craftedAdapter.listProblems({ cursor: crafted, limit: 2, token, limits: LIMITS }), 'changed_response');
});

test('a cached tag dictionary still validates the token and limits on every call', async () => {
  const h = harness({});
  const adapter = adapterFor(h, { tagDictionary: new Map([[53, '树状数组']]) });
  const cancelled = createCancellationSource();
  cancelled.cancel('caller gave up before the cached dictionary was read');
  await rejectsWithCode(adapter.loadTagDictionary(cancelled.token, LIMITS), 'cancelled');
  await rejectsWithCode(adapter.loadTagDictionary(createCancellationSource().token, { ...LIMITS, pageSize: 0 }), 'invalid_input');
  await rejectsWithCode(
    adapter.loadTagDictionary(createCancellationSource().token, { ...LIMITS, requestTimeoutMs: Number.NaN }),
    'invalid_input',
  );

  const dictionary = await adapter.loadTagDictionary(createCancellationSource().token, LIMITS);
  assert.equal(dictionary.get(53), '树状数组');
  (dictionary as Map<number, string>).set(999, 'mutated copy');
  assert.equal((await adapter.loadTagDictionary(createCancellationSource().token, LIMITS)).has(999), false);
  assert.equal(h.requests.length, 0, 'a cached dictionary never issues a request');

  const live = adapterFor(harness({ '/_lfe/tags': () => jsonResponse({ tags: [{ id: 7, name: '图论' }] }) }), {
    resolveTagNames: true,
  });
  assert.equal((await live.loadTagDictionary(createCancellationSource().token, LIMITS)).get(7), '图论');
  const afterCache = createCancellationSource();
  afterCache.cancel('cancelled after the dictionary was cached');
  await rejectsWithCode(live.loadTagDictionary(afterCache.token, LIMITS), 'cancelled');
});

test('fetchProblem checks the token again after the awaited detail delegate returns', async () => {
  const source = createCancellationSource();
  const adapter = adapterFor(harness({ '/problem/P3374': () => jsonResponse(detailPayload()) }));
  const detail = adapter.fetchProblemDetail.bind(adapter);
  // Simulate a cancellation observed while the delegated detail call was settling.
  adapter.fetchProblemDetail = async (request) => {
    const result = await detail(request);
    source.cancel('cancelled while the detail delegate settled');
    return result;
  };
  await rejectsWithCode(adapter.fetchProblem({ problemRef: ref('P3374'), token: source.token, limits: LIMITS }), 'cancelled');
});

test('a description-only statement is accepted and keeps null background, formats, hint and samples', async () => {
  const payload = detailPayload({
    content: { name: '仅描述', background: null, description: '求 $a+b$ 的值。', formatI: null, formatO: null, hint: null },
    samples: [],
  });
  const adapter = adapterFor(harness({ '/problem/p3374': () => jsonResponse(payload) }));
  const { problem, detail } = await adapter.fetchProblemDetail({
    problemRef: ref('p3374'),
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  // The request is matched case-insensitively and the answered canonical pid is what is returned.
  assert.equal(detail.summary.pid, 'P3374');
  assert.equal(problem.ref.externalKey, 'P3374');
  assert.ok((problem.statement ?? '').includes('## 题目描述'));
  assert.ok(!(problem.statement ?? '').includes('## 题目背景'));
  assert.ok(!(problem.statement ?? '').includes('## 输入格式'));
  assert.ok(!(problem.statement ?? '').includes('## 提示'));
});

// ---------------------------------------------------------------------------------------
// Public profile nickname (Sprint 22b)
// ---------------------------------------------------------------------------------------

const PROFILE_ACCOUNT = createLuoguAccount(SOURCE, '123');

function profileRequest(account = PROFILE_ACCOUNT) {
  return { account, token: createCancellationSource().token, limits: LIMITS };
}

test('fetchAccountProfile reads data.user only and ignores the viewer identity', async () => {
  const h = harness({
    '/user/123': () =>
      jsonResponse({
        // `root.user` is the anonymous viewer identity Lentille attaches to the request; it must
        // never be mistaken for the requested account's own nickname.
        user: { uid: 999999, name: '查看者昵称' },
        data: { user: { uid: 123, name: '示例选手', biography: 'must not be read', followerCount: 7 } },
      }),
  });
  const profile = await adapterFor(h).fetchAccountProfile(profileRequest());
  assert.deepEqual(profile, { sourceInstanceId: SOURCE.id, uid: '123', displayName: '示例选手' });
  assert.equal(h.requests.length, 1, 'exactly one profile request was made');
  assert.equal(new URL(h.requests[0]!.url).pathname, '/user/123');
  assert.equal(h.requests[0]?.init.headers['x-lentille-request'], 'content-only');
});

test('a canonical decimal uid string is accepted as the answered identity', async () => {
  const h = harness({ '/user/123': () => jsonResponse({ data: { user: { uid: '123', name: '示例选手' } } }) });
  const profile = await adapterFor(h).fetchAccountProfile(profileRequest());
  assert.equal(profile.uid, '123');
  assert.equal(profile.displayName, '示例选手');
});

test('a foreign uid, missing/blank/oversized name or declared error is refused', async () => {
  const cases: readonly (readonly [string, unknown, string])[] = [
    ['viewer-only payload', { user: { uid: 123, name: '查看者昵称' }, data: {} }, 'changed_response'],
    ['viewer uid substituted', { data: { user: { uid: 999999, name: '别人' } } }, 'changed_response'],
    ['missing name', { data: { user: { uid: 123 } } }, 'changed_response'],
    ['blank name', { data: { user: { uid: 123, name: '   ' } } }, 'changed_response'],
    ['non-string name', { data: { user: { uid: 123, name: 42 } } }, 'changed_response'],
    ['oversized name', { data: { user: { uid: 123, name: 'x'.repeat(257) } } }, 'changed_response'],
    ['non-canonical uid', { data: { user: { uid: '0123', name: '示例选手' } } }, 'changed_response'],
    ['declared 404', { data: { errorCode: 404, user: { uid: 123, name: '示例选手' } } }, 'unavailable'],
  ];
  for (const [label, payload, code] of cases) {
    const h = harness({ '/user/123': () => jsonResponse(payload) });
    await rejectsWithCode(adapterFor(h).fetchAccountProfile(profileRequest()), code);
    assert.equal(h.requests.length, 1, `${label}: the refusal is about the answer, not a missing request`);
  }
});

test('HTML, invalid JSON and an unrecognized root are changed responses, never a nickname', async () => {
  const html = harness({ '/user/123': () => htmlResponse('<html><body>login required</body></html>') });
  await rejectsWithCode(adapterFor(html).fetchAccountProfile(profileRequest()), 'changed_response');

  const broken = harness({
    '/user/123': () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  await rejectsWithCode(adapterFor(broken).fetchAccountProfile(profileRequest()), 'changed_response');

  const array = harness({ '/user/123': () => jsonResponse([{ uid: 123, name: '示例选手' }]) });
  await rejectsWithCode(adapterFor(array).fetchAccountProfile(profileRequest()), 'changed_response');
});

test('a refused profile answer never quotes the page body, a sample or a cause', async () => {
  // A unique synthetic secret stands in for the biography/follower text a whole public profile page
  // carries. It may travel through the transport, the HTML check, JSON.parse or the declared-error
  // branch, but it must never appear in the refusal that leaves the adapter.
  const marker = 'PRIVATE_PROFILE_MARKER_7c41f0';
  const cases: readonly (readonly [string, Response])[] = [
    ['html page', htmlResponse(`<html><body><p>${marker}</p></body></html>`)],
    [
      'malformed json',
      new Response(`{"biography":"${marker}",`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
    [
      'declared error',
      jsonResponse({ data: { errorCode: 404, errorMessage: marker, user: { uid: 123, name: marker } } }),
    ],
    [
      'http refusal',
      new Response(`<html><body>${marker}</body></html>`, { status: 403, headers: { 'content-type': 'text/html' } }),
    ],
  ];
  for (const [label, response] of cases) {
    const h = harness({ '/user/123': () => response });
    let caught: unknown = null;
    try {
      await adapterFor(h).fetchAccountProfile(profileRequest());
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, `${label}: the profile answer must be refused`);
    const serialized = [
      String(caught),
      caught.message,
      caught.stack ?? '',
      JSON.stringify(caught, Object.getOwnPropertyNames(caught)),
    ].join('\n');
    assert.ok(!serialized.includes(marker), `${label}: the profile body leaked into the refusal`);
    assert.equal((caught as { sample?: unknown }).sample ?? null, null, `${label}: no sample may be attached`);
    assert.equal((caught as { cause?: unknown }).cause ?? null, null, `${label}: no cause may be attached`);
  }
});

test('a non-canonical account is refused before any profile request', async () => {
  const h = harness({ '/user/007': () => jsonResponse({ data: { user: { uid: 7, name: '示例选手' } } }) });
  const account = createAccount({ sourceInstanceId: SOURCE.id, handle: '007' });
  await rejectsWithCode(adapterFor(h).fetchAccountProfile(profileRequest(account)), 'invalid_input');
  assert.equal(h.requests.length, 0);
});

test('fetchAccountProfile observes cancellation before dispatch and during a request', async () => {
  const h = harness({ '/user/123': hangUntilAbort });
  const adapter = adapterFor(h);
  const pre = createCancellationSource();
  pre.cancel('before start');
  await rejectsWithCode(adapter.fetchAccountProfile({ ...profileRequest(), token: pre.token }), 'cancelled');
  assert.equal(h.requests.length, 0);

  const during = createCancellationSource();
  const pending = adapter.fetchAccountProfile({ ...profileRequest(), token: during.token });
  await tick();
  during.cancel('mid flight');
  await rejectsWithCode(pending, 'cancelled');
});
