/**
 * Luogu authenticated editorial reading (Sprint 33C), over the real session reader.
 *
 * The reader's payload rules were written against a sanitized capture of the authenticated
 * `/problem/solution/<pid>` surface (`.local/observations/luogu-editorial-shape.v1.json`,
 * classification `sanitized-schema-only`). Every fixture here is **synthetic**: it reproduces the
 * captured field names, types and optionality, and every value is an invented placeholder. No captured
 * cookie, viewer identity, author value, problem title, solution body or error message is copied.
 *
 * The capture recorded a **paginated** surface: page 1 is read with no query at all, `?page=2` answers
 * the same shape with a non-empty result, and `count` is the *total* number of write-ups (56 for
 * P1001) rather than one page's length. Every case below is therefore driven through the real
 * `LuoguSessionReaderAdapter` over a synthetic transport: the reader walks `ceil(count / perPage)`
 * pages, and the whole read either succeeds or fails — there is no partial material.
 *
 * The cases pin the boundary the whole stage exists for: **only an explicit `count: 0` with an empty
 * result list, on page 1, is an absence.** Every unreadable, refused or unauthenticated answer is a
 * typed failure, because reporting `absent` there would start the statement-only reasoning path on a
 * broken request. No case in this file may reach the network: every response comes from the in-process
 * harness.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLuoguSessionReader, luoguSourceInstance } from '../../src/adapters/luogu/index.js';
import { createLuoguAdapter } from '../../src/adapters/luogu/adapter.js';
import { LENTILLE_CONTEXT_ELEMENT_ID } from '../../src/adapters/luogu/editorial-parser.js';
import {
  createAuthenticatedLuoguFetch,
  type LuoguSession,
  type LuoguSessionProvider,
} from '../../src/adapters/luogu/session-reader.js';
import { createLuoguAccount } from '../../src/adapters/luogu/account.js';
import type { FetchInitLike } from '../../src/adapters/platform/http.js';
import { DEFAULT_PLATFORM_LIMITS, type EditorialFetchResult, type PlatformLimits } from '../../src/application/ports.js';
import { PlatformError, isPlatformError } from '../../src/application/platform-errors.js';
import { createCancellationSource, type Account, type CancellationToken, type ProblemRef } from '../../src/domain/index.js';
import { createHttpHarness, htmlResponse, jsonResponse, type HttpHarnessOptions } from './fixtures.js';

const UID = '123456';
const CLIENT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const COOKIE = `__client_id=${CLIENT_ID}; _uid=${UID}`;
const CANONICAL_COOKIE = `__client_id=${CLIENT_ID}; _uid=${UID}`;
const SESSION: LuoguSession = { uid: UID, cookie: COOKIE };
const SOURCE = luoguSourceInstance();
const ACCOUNT = createLuoguAccount(SOURCE, UID, 'Synthetic User');
const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 30_000,
  maxRetries: 0,
  pageSize: 100,
  maxConcurrency: 1,
};
const PID = 'P1001';
const REF: ProblemRef = { sourceInstanceId: SOURCE.id, domain: null, externalKey: PID };
const AT = '2026-09-15T00:00:00.000Z';
/** Values that must never travel out of a failure of any kind. */
const LID_SENTINEL = 'LID_SECRET_SENTINEL';
const ANONYMOUS_BODY_SENTINEL = 'ANONYMOUS_BODY_SENTINEL';

// ---------------------------------------------------------------------------------------
// Sanitized-shape fixtures
// ---------------------------------------------------------------------------------------

/** One solution item in the observed shape; `lid` defaults to an index-derived placeholder. */
function solutionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lid: 'lid-1',
    title: 'PLACEHOLDER_TITLE',
    category: 1,
    time: 1_700_000_000,
    author: {
      uid: 1,
      avatar: 'https://example.invalid/avatar.png',
      name: 'PLACEHOLDER_AUTHOR',
      slogan: '',
      badge: null,
      isAdmin: false,
      isBanned: false,
      color: 'Gray',
      ccfLevel: 0,
      xcpcLevel: 0,
      background: '',
    },
    upvote: 3,
    replyCount: 0,
    favorCount: 1,
    status: 2,
    solutionFor: { pid: PID, type: 'P', name: 'PLACEHOLDER_NAME', difficulty: 1, fullScore: 100 },
    promoteStatus: 0,
    collection: null,
    content: 'PLACEHOLDER_BODY',
    contentFull: true,
    adminNote: null,
    voted: null,
    canReply: false,
    canEdit: false,
    ...overrides,
  };
}

/** One whole-payload answer: `count` is the length of the result set it carries. */
function positivePayload(result: readonly unknown[], count?: number): Record<string, unknown> {
  return {
    instance: 'PLACEHOLDER',
    template: 'PLACEHOLDER',
    status: 200,
    locale: 'zh-CN',
    data: {
      solutions: { perPage: 10, count: count ?? result.length, result },
      problem: { pid: PID, type: 'P', name: 'PLACEHOLDER_NAME', difficulty: 1, fullScore: 100 },
      acceptSolution: false,
    },
    user: { uid: 1, name: 'PLACEHOLDER_VIEWER' },
    time: 1_700_000_000,
  };
}

/** One server page of a paginated answer; `count` is the total across every page. */
function pagePayload(
  result: readonly unknown[],
  count: number,
  perPage = 10,
): Record<string, unknown> {
  return {
    instance: 'PLACEHOLDER',
    template: 'PLACEHOLDER',
    status: 200,
    locale: 'zh-CN',
    data: {
      solutions: { perPage, count, result },
      problem: { pid: PID, type: 'P', name: 'PLACEHOLDER_NAME', difficulty: 1, fullScore: 100 },
      acceptSolution: false,
    },
    user: { uid: 1, name: 'PLACEHOLDER_VIEWER' },
    time: 1_700_000_000,
  };
}

function errorPayload(errorCode: number, status: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance: 'PLACEHOLDER',
    template: 'PLACEHOLDER',
    status,
    locale: 'zh-CN',
    data: {
      errorCode,
      errorType: 'PLACEHOLDER_ERROR_TYPE',
      errorMessage: 'PLACEHOLDER_ERROR_MESSAGE',
      errorData: { needLogin: errorCode === 401 ? 1 : 0 },
      ...extra,
    },
    user: null,
    time: 1_700_000_000,
  };
}

/** One authenticated solution page whose hydration element carries `payload`. */
function solutionPage(payload: unknown): string {
  return (
    '<!doctype html><html><head><title>PLACEHOLDER</title></head><body><div id="app"></div>' +
    `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">${JSON.stringify(payload)}</script>` +
    '</body></html>'
  );
}

// ---------------------------------------------------------------------------------------
// A paged synthetic solution surface
// ---------------------------------------------------------------------------------------

interface EditorialFeed {
  /** Route for `createHttpHarness`; answers the pages this feed declares. */
  readonly route: (url: URL) => Response | Promise<Response>;
  /** The `page` parameter of every request, in order; `null` for a request without one. */
  readonly pages: (number | null)[];
  /** The exact request URLs, in order. */
  readonly urls: string[];
  /** The `page` values (or `null`) whose answer is replaced by `replacement`. */
  readonly override: Map<number | null, (url: URL) => Response | Promise<Response>>;
}

/**
 * A synthetic `/problem/solution/<pid>` surface that really pages.
 *
 * `count` is the declared total, `perPage` the declared page size, and the pages are slices of a
 * deterministic `lid` sequence, so a test can assert the exact order the reader delivered. A page the
 * server is asked for but that does not exist answers an empty page with the declared metadata, which
 * is exactly the shape a server that ignores `page` would produce.
 */
function editorialFeed(options: { readonly count: number; readonly perPage?: number }): EditorialFeed {
  const perPage = options.perPage ?? 10;
  const pages: (number | null)[] = [];
  const urls: string[] = [];
  const override = new Map<number | null, (url: URL) => Response | Promise<Response>>();
  return {
    pages,
    urls,
    override,
    route: (url) => {
      const raw = url.searchParams.get('page');
      const page = raw === null ? null : Number(raw);
      pages.push(page);
      urls.push(url.toString());
      const forced = override.get(page);
      if (forced !== undefined) {
        return forced(url);
      }
      const number = page ?? 1;
      const start = (number - 1) * perPage;
      const length = Math.min(perPage, Math.max(0, options.count - start));
      const result = Array.from({ length }, (_, index) =>
        solutionItem({ lid: `lid-${String(start + index)}`, content: `PLACEHOLDER_BODY_${String(start + index)}` }),
      );
      return jsonResponse(pagePayload(result, options.count, perPage));
    },
  };
}

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

const SOLUTION_PATH = `/problem/solution/${PID}`;

function harness(routes: HttpHarnessOptions['routes']): ReturnType<typeof createHttpHarness> {
  return createHttpHarness({ origin: 'https://www.luogu.com.cn', routes });
}

/**
 * Every paced wait the reader asked for, in order.
 *
 * The fixture's synthetic clock advances by exactly the requested delay, so the *recorded* delay grows
 * as the schedule drifts ahead of the frozen fetch time; what the reader can be held to is that a wait
 * happened before every request after the first and that the modelled instants are at least the
 * platform floor apart.
 */
const pacedWaits: number[] = [];

function readerFor(
  h: ReturnType<typeof createHttpHarness>,
  sessions: LuoguSessionProvider = { sessionFor: async () => SESSION },
) {
  // The reader's own clock is what stamps a stored `retrievedAt`, so it is pinned here rather than
  // left to wall time.
  const impl = {
    ...h.impl,
    wait: async (ms: number, token: CancellationToken) => {
      pacedWaits.push(ms);
      return h.impl.wait(ms, token);
    },
  };
  return createLuoguSessionReader({ sourceInstance: SOURCE, sessions, ...impl, clock: () => Date.parse(AT) });
}

/** A reader over one paged feed. */
function pagedReader(feed: EditorialFeed, sessions?: LuoguSessionProvider) {
  const h = harness({ [SOLUTION_PATH]: (url) => feed.route(url) });
  return { h, reader: readerFor(h, sessions) };
}

function readEditorial(reader: ReturnType<typeof createLuoguSessionReader>, overrides: Partial<{
  readonly account: Account;
  readonly problemRef: ProblemRef;
  readonly officialTutorialUrl: string | null;
  readonly token: ReturnType<typeof createCancellationSource>['token'];
}> = {}) {
  return reader.fetchEditorial({
    account: overrides.account ?? ACCOUNT,
    problemRef: overrides.problemRef ?? REF,
    token: overrides.token ?? createCancellationSource().token,
    limits: LIMITS,
    ...(overrides.officialTutorialUrl === undefined ? {} : { officialTutorialUrl: overrides.officialTutorialUrl }),
  });
}

async function rejectsWithCode(work: Promise<unknown>, code: string): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    assert.equal(isPlatformError(error) ? error.code : undefined, code);
    return error;
  }
  assert.fail(`expected a ${code} refusal`);
}

/** A projection of everything a failure may carry, so a leak can be asserted on the whole object. */
function projectionOf(error: unknown): string {
  const typed = error as { readonly code?: string; readonly detail?: string; readonly sample?: string | null; readonly message?: string };
  return [typed.code ?? '', typed.detail ?? '', typed.sample ?? '', typed.message ?? '', JSON.stringify(error ?? null)].join(' | ');
}

// ---------------------------------------------------------------------------------------
// Reading real material
// ---------------------------------------------------------------------------------------

void test('an authenticated read turns the observed payload into stored material', async () => {
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  const result = await readEditorial(readerFor(h));

  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  // One write-up is one attributed source plus its body-bearing solution.
  assert.equal(result.sources.length, 1);
  assert.equal(result.solutions.length, 1);
  assert.equal(result.solutions[0]?.text, 'PLACEHOLDER_BODY');
  assert.equal(result.solutions[0]?.sourceId, result.sources[0]?.id);
  assert.equal(result.sources[0]?.availability, 'found');
  assert.equal(result.sources[0]?.kind, 'solution');
  assert.equal(result.sources[0]?.title, 'PLACEHOLDER_TITLE');
  assert.equal(result.sources[0]?.author, 'PLACEHOLDER_AUTHOR');
  assert.equal(result.sources[0]?.publishedAt, null);
  assert.equal(result.sources[0]?.language, null);
  assert.match(result.sources[0]?.url ?? '', new RegExp(`/problem/solution/${PID}$`, 'u'));
  assert.match(result.solutions[0]?.solutionId ?? '', /lid-1$/u);
  assert.equal(result.retrievedAt, AT);
  assert.equal(result.sources[0]?.retrievedAt, AT);

  // The session was used, and only in the one way it may be: the canonical cookie pair on the request.
  assert.equal(h.requests.length, 1);
  const sent = h.requests[0];
  assert.equal(sent?.url, `https://www.luogu.com.cn${SOLUTION_PATH}`);
  const headers = sent?.init.headers as Readonly<Record<string, string>> | undefined;
  assert.equal(headers?.['cookie'], CANONICAL_COOKIE);
  assert.equal(headers?.['x-lentille-request'], 'content-only');
  // The material carries the public author name — that is the attribution the product stores — and no
  // viewer identity and no avatar.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('PLACEHOLDER_AUTHOR'), true);
  assert.equal(serialized.includes('PLACEHOLDER_VIEWER'), false);
  assert.equal(serialized.includes('avatar.png'), false);
});

void test('a multi-write-up payload is accepted and kept in platform order', async () => {
  const items = [solutionItem({ lid: 'lid-a' }), solutionItem({ lid: 'lid-b' }), solutionItem({ lid: 'lid-c' })];
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload(items)) });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.equal(result.solutions.length, 3);
  assert.equal(result.sources.length, 3);
  assert.deepEqual(result.solutions.map((solution) => solution.ordinal), [0, 1, 2]);
  assert.deepEqual(
    result.solutions.map((solution) => solution.solutionId.replace(/^.*lid-/u, 'lid-')),
    ['lid-a', 'lid-b', 'lid-c'],
  );
});

void test('a real multi-page answer is read page by page, in order, and composed whole', async () => {
  // The recorded real shape of P1001: 56 write-ups at 10 per page, so six pages.
  const feed = editorialFeed({ count: 56 });
  const { h, reader } = pagedReader(feed);
  const result = await readEditorial(reader);

  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.equal(result.solutions.length, 56);
  assert.equal(result.sources.length, 56);
  // The platform's global order is preserved across the page boundary.
  assert.deepEqual(
    result.solutions.map((solution) => solution.ordinal),
    Array.from({ length: 56 }, (_, index) => index),
  );
  assert.equal(result.solutions[0]?.solutionId.endsWith('lid-0'), true);
  assert.equal(result.solutions[55]?.solutionId.endsWith('lid-55'), true);
  assert.equal(result.solutions[9]?.text, 'PLACEHOLDER_BODY_9');
  assert.equal(result.solutions[10]?.text, 'PLACEHOLDER_BODY_10');
  // Six requests, in order: page 1 without any query, then the canonical `?page=N` for every other.
  assert.deepEqual(feed.pages, [null, 2, 3, 4, 5, 6]);
  assert.deepEqual(feed.urls, [
    `https://www.luogu.com.cn${SOLUTION_PATH}`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=2`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=3`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=4`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=5`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=6`,
  ]);
  // The session travelled on every page and only there.
  assert.equal(h.requests.length, 6);
  for (const request of h.requests) {
    assert.equal((request.init.headers as Readonly<Record<string, string>>)['cookie'], CANONICAL_COOKIE);
  }
  // The whole read ran on the account's one paced transport: every page after the first waited out the
  // 2 s platform floor, and no two requests were dispatched closer together than that floor.
  assert.equal(pacedWaits.length, 5, 'one paced wait per page after the first');
  assert.equal(pacedWaits.every((ms) => ms >= 2_000), true, JSON.stringify(pacedWaits));
  const instants = h.requests.map((request) => request.at);
  assert.deepEqual(instants[0], 0);
  for (let index = 1; index < instants.length; index += 1) {
    assert.equal((instants[index] ?? 0) - (instants[index - 1] ?? 0) >= 2_000, true, `gap ${String(index)}`);
  }
  // Every source of one read carries the one read instant, and every write-up belongs to a source of
  // this read.
  const sourceIds = new Set(result.sources.map((source) => source.id));
  assert.equal(result.sources.every((source) => source.retrievedAt === AT), true);
  assert.equal(result.solutions.every((solution) => sourceIds.has(solution.sourceId)), true);
  assert.equal(new Set(result.sources.map((source) => source.id)).size, 56);
});

void test('a page-shaped answer is read from its hydration element', async () => {
  // The capture recorded the payload as the `#lentille-context` element of a `text/html` document, so a
  // page answer that carries it is read the same way a JSON body is.
  const h = harness({ [SOLUTION_PATH]: () => htmlResponse(solutionPage(positivePayload([solutionItem()]))) });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.equal(result.solutions[0]?.text, 'PLACEHOLDER_BODY');
});

void test('an HTML script body is read as raw text, so entities in a body survive verbatim', async () => {
  // A `<script>` body is raw text: `&amp;` in it is part of the JSON string, not markup. Decoding it
  // would silently rewrite the write-up the record is supposed to preserve.
  const literal = 'a &amp;&amp; b &lt;x&gt; &quot;q&quot;';
  const h = harness({
    [SOLUTION_PATH]: () => htmlResponse(solutionPage(positivePayload([solutionItem({ content: literal })]))),
  });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.equal(result.solutions[0]?.text, literal);
});

void test('a same-id hydration script of another type is not the payload', async () => {
  const payload = positivePayload([solutionItem()]);
  // The id is right but the declared type is not, so the page carries no readable payload.
  const h = harness({
    [SOLUTION_PATH]: () =>
      htmlResponse(
        `<html><body><script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="text/javascript">${JSON.stringify(payload)}</script></body></html>`,
      ),
  });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'found');
  assert.notEqual(result.status, 'absent');
});

// ---------------------------------------------------------------------------------------
// Paging drift: a short, empty, repeated or over-long page is never a partial success
// ---------------------------------------------------------------------------------------

void test('a declared total that disagrees with the pages fails the whole read', async () => {
  // Page 3 of six answers one write-up short: taking what arrived would silently drop material.
  const feed = editorialFeed({ count: 56 });
  feed.override.set(3, () => jsonResponse(pagePayload([solutionItem({ lid: 'lid-20' })], 56)));
  const result = await readEditorial(pagedReader(feed).reader);
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
  assert.deepEqual(feed.pages, [null, 2, 3], 'the read stops at the page that drifted');
});

void test('an empty middle page fails the whole read instead of shortening it', async () => {
  const feed = editorialFeed({ count: 56 });
  feed.override.set(2, () => jsonResponse(pagePayload([], 56)));
  const result = await readEditorial(pagedReader(feed).reader);
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
});

void test('a server that ignores the page parameter is caught as repeated write-ups', async () => {
  // The classic broken-paging answer: every request gets page 1. The declared count still says 56, so
  // the read must not deliver the first ten write-ups six times.
  const feed = editorialFeed({ count: 56 });
  feed.override.set(2, () => jsonResponse(pagePayload(
    Array.from({ length: 10 }, (_, index) => solutionItem({ lid: `lid-${String(index)}` })),
    56,
  )));
  const result = await readEditorial(pagedReader(feed).reader);
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
  assert.deepEqual(feed.pages, [null, 2], 'the duplicate is caught at the first continuation page');
});

void test('the declared pagination must not drift between pages', async () => {
  // A different page size: the page lengths no longer follow from the first page's declaration.
  const driftedPerPage = editorialFeed({ count: 56 });
  driftedPerPage.override.set(2, () => jsonResponse(pagePayload(
    Array.from({ length: 20 }, (_, index) => solutionItem({ lid: `lid-${String(10 + index)}` })),
    56,
    20,
  )));
  assert.equal((await readEditorial(pagedReader(driftedPerPage).reader)).status, 'changed_response');

  // A different total: the number of pages itself is no longer known.
  const driftedCount = editorialFeed({ count: 56 });
  driftedCount.override.set(2, () => jsonResponse(pagePayload(
    Array.from({ length: 10 }, (_, index) => solutionItem({ lid: `lid-${String(10 + index)}` })),
    60,
  )));
  assert.equal((await readEditorial(pagedReader(driftedCount).reader)).status, 'changed_response');
});

void test('a repeated write-up id inside one page is refused', async () => {
  const feed = editorialFeed({ count: 2 });
  feed.override.set(null, () => jsonResponse(pagePayload([solutionItem({ lid: 'lid-0' }), solutionItem({ lid: 'lid-0' })], 2)));
  const result = await readEditorial(pagedReader(feed).reader);
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
});

void test('a write-up id repeated across pages is refused', async () => {
  const feed = editorialFeed({ count: 20 });
  // Page 2 repeats page 1's last id while every page keeps its declared length.
  feed.override.set(2, () => jsonResponse(pagePayload(
    Array.from({ length: 10 }, (_, index) => solutionItem({ lid: `lid-${String(9 + index)}` })),
    20,
  )));
  const result = await readEditorial(pagedReader(feed).reader);
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
});

void test('a total that needs more pages than one read may fetch fails whole after the first page', async () => {
  const feed = editorialFeed({ count: 2_000, perPage: 10 });
  const result = await readEditorial(pagedReader(feed).reader);
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
  assert.deepEqual(feed.pages, [null], 'nothing beyond the first page is requested');
});

void test('more retrieved body than one read may store fails whole, without partial material', async () => {
  // 1,000 page-size write-ups is inside the write-up bound, but their bodies are not.
  const feed = editorialFeed({ count: 1_000, perPage: 100 });
  feed.override.set(null, () => jsonResponse(pagePayload(
    Array.from({ length: 100 }, (_, index) =>
      solutionItem({ lid: `lid-${String(index)}`, content: 'x'.repeat(50_000) }),
    ),
    1_000,
    100,
  )));
  feed.override.set(2, () => jsonResponse(pagePayload(
    Array.from({ length: 100 }, (_, index) =>
      solutionItem({ lid: `lid-${String(100 + index)}`, content: 'x'.repeat(50_000) }),
    ),
    1_000,
    100,
  )));
  const result = await readEditorial(pagedReader(feed).reader);
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
});

void test('an HTTP refusal is classified by its status before any body is read', async () => {
  // The classic way a refusal could be mistaken for content: an error status whose body still carries a
  // shaped, empty `solutions` block. The status decides, so none of these can be an absence…
  const emptyBody = {
    status: 200,
    data: { solutions: { perPage: 10, count: 0, result: [] }, problem: { pid: PID, type: 'P' }, acceptSolution: false },
    user: null,
    time: 1_700_000_000,
  };
  const refused: readonly { readonly http: number; readonly code: string }[] = [
    { http: 400, code: 'unavailable' },
    { http: 401, code: 'auth_required' },
    { http: 403, code: 'forbidden' },
    { http: 404, code: 'unavailable' },
  ];
  // …and no shaped *non-empty* block either: a refusal is never material.
  const foundBody = {
    status: 200,
    data: {
      solutions: { perPage: 10, count: 10, result: [solutionItem({ lid: 'lid-0' })] },
      problem: { pid: PID, type: 'P' },
      acceptSolution: false,
    },
    user: null,
    time: 1_700_000_000,
  };
  for (const entry of refused) {
    for (const [label, body] of [['fake empty', emptyBody], ['fake found', foundBody]] as const) {
      const h = harness({ [SOLUTION_PATH]: () => jsonResponse(body, entry.http) });
      const result = await readEditorial(readerFor(h));
      assert.equal(result.status, entry.code, `HTTP ${String(entry.http)} (${label})`);
      assert.notEqual(result.status, 'absent', `HTTP ${String(entry.http)} (${label})`);
      assert.notEqual(result.status, 'found', `HTTP ${String(entry.http)} (${label})`);
      if (result.status === 'unavailable' || result.status === 'changed_response') {
        // Fixed text only: the refusal never quotes the body it refused to read.
        assert.equal(projectionOf(result).includes('PLACEHOLDER_BODY'), false, `HTTP ${String(entry.http)}`);
        assert.equal(result.status === 'changed_response' ? result.sample : null, null);
      }
    }
  }
});

void test('an HTTP 401 is the authentication wall even when it answers an HTML page at the solution URL', async () => {
  // The final URL is still the requested solution path and the body is a page, so neither the path nor
  // the content type may decide: the HTTP status makes this the authentication wall.
  const h = harness({
    [SOLUTION_PATH]: () => htmlResponse('<html><body><form id="login-form"></form></body></html>', 401),
  });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'auth_required');
  assert.notEqual(result.status, 'absent');
  assert.notEqual(result.status, 'changed_response');
  assert.equal(h.requests[0]?.url, `https://www.luogu.com.cn${SOLUTION_PATH}`);
});

void test('an HTTP 200 inline login page at the solution URL is changed_response, not auth_required', async () => {
  // There is no reliable structural signal for an inline login page served with a success status, so it
  // is reported as an unreadable answer: inventing an authentication wall would hide a changed layout.
  const h = harness({
    [SOLUTION_PATH]: () => htmlResponse('<html><body><form id="login-form"></form></body></html>', 200),
  });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'auth_required');
  assert.notEqual(result.status, 'absent');
});

void test('two Unicode spellings of one write-up id are one identity, inside and across pages', async () => {
  // One write-up, two spellings: `é` precomposed and `e` + U+0301. The reader must store one identity
  // and refuse the payload that would give it two.
  const precomposed = 'caf\u00e9-7';
  const decomposed = 'cafe\u0301-7';
  const canonical = encodeURIComponent(precomposed);
  const single = editorialFeed({ count: 1 });
  single.override.set(null, () => jsonResponse(pagePayload([solutionItem({ lid: decomposed })], 1)));
  const found = await readEditorial(pagedReader(single).reader);
  assert.equal(found.status, 'found');
  if (found.status === 'found') {
    assert.equal(found.solutions[0]?.solutionId.endsWith(canonical), true, found.solutions[0]?.solutionId);
    const serialized = JSON.stringify({ sources: found.sources, solutions: found.solutions });
    assert.equal(serialized.includes('\u0301'), false);
    assert.equal(serialized.includes('%CC%81'), false);
  }

  // Inside one page: both spellings of the same id.
  const samePage = editorialFeed({ count: 2 });
  samePage.override.set(null, () =>
    jsonResponse(pagePayload([solutionItem({ lid: precomposed }), solutionItem({ lid: decomposed })], 2)),
  );
  const samePageResult = await readEditorial(pagedReader(samePage).reader);
  assert.equal(samePageResult.status, 'changed_response');
  assert.notEqual(samePageResult.status, 'absent');
  assert.notEqual(samePageResult.status, 'found');

  // Across pages: page 2 repeats page 1's last id under the other spelling.
  const acrossPages = editorialFeed({ count: 20 });
  acrossPages.override.set(null, () =>
    jsonResponse(
      pagePayload(
        Array.from({ length: 10 }, (_, index) =>
          solutionItem({ lid: index === 9 ? precomposed : `lid-${String(index)}` }),
        ),
        20,
      ),
    ),
  );
  acrossPages.override.set(2, () =>
    jsonResponse(
      pagePayload(
        Array.from({ length: 10 }, (_, index) =>
          solutionItem({ lid: index === 0 ? decomposed : `lid-${String(10 + index)}` }),
        ),
        20,
      ),
    ),
  );
  const acrossResult = await readEditorial(pagedReader(acrossPages).reader);
  assert.equal(acrossResult.status, 'changed_response');
  assert.notEqual(acrossResult.status, 'absent');
  assert.notEqual(acrossResult.status, 'found');
});

void test('a refusal body is never pulled, so it cannot change the refusal code', async () => {
  // The transport reads a response body before the reader sees it, so an oversized refusal body or a
  // body stream that throws would otherwise replace `auth_required` with a payload/transport failure.
  // The authenticated fetch discards a non-200 body *unread*, so the status stays the answer.
  const sentinel = 'REFUSAL_BODY_SENTINEL';
  const cases: readonly { readonly label: string; readonly response: () => Response; readonly http: number; readonly code: string }[] = [
    {
      label: '401 with a body whose stream errors',
      http: 401,
      code: 'auth_required',
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error(sentinel));
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    },
    {
      label: '401 declaring more bytes than the cap',
      http: 401,
      code: 'auth_required',
      response: () =>
        new Response('x'.repeat(4096), {
          status: 401,
          headers: { 'content-type': 'application/json', 'content-length': '999999999' },
        }),
    },
    {
      label: '403 with a body that is not valid JSON',
      http: 403,
      code: 'forbidden',
      response: () => new Response(`{"error": "${sentinel}`, { status: 403, headers: { 'content-type': 'application/json' } }),
    },
    {
      label: '404 with an oversized body',
      http: 404,
      code: 'unavailable',
      response: () =>
        new Response(`{"error": "${sentinel}"}`, {
          status: 404,
          headers: { 'content-type': 'application/json', 'content-length': '999999999' },
        }),
    },
    {
      label: '400 with a body whose stream errors',
      http: 400,
      code: 'unavailable',
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error(sentinel));
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    },
  ];
  for (const entry of cases) {
    const h = harness({ [SOLUTION_PATH]: entry.response });
    // A small byte cap, so a body that *were* read would certainly exceed it.
    const reader = createLuoguSessionReader({
      sourceInstance: SOURCE,
      sessions: { sessionFor: async () => SESSION },
      ...h.impl,
      maxResponseBytes: 1024,
      clock: () => Date.parse(AT),
    });
    const result = await readEditorial(reader);
    assert.equal(result.status, entry.code, entry.label);
    assert.notEqual(result.status, 'absent', entry.label);
    assert.notEqual(result.status, 'found', entry.label);
    assert.equal(projectionOf(result).includes(sentinel), false, entry.label);
    assert.equal(h.requests.length, 1, entry.label);
  }
});

void test('a body-level rate limit keeps rate_limited through the reader', async () => {
  // Lentille can declare a rate limit inside an HTTP 200 envelope; the read must keep that meaning
  // instead of reporting a refusal.
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(errorPayload(429, 200)) });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'rate_limited');
  assert.notEqual(result.status, 'forbidden');
  assert.notEqual(result.status, 'absent');
});

void test('a body-level 5xx keeps its meaning as an outage, not a permission problem', async () => {
  // Lentille declares some failures in an HTTP 200 envelope; a declared 5xx must stay `unavailable`
  // (and retryable) instead of becoming `forbidden`.
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(errorPayload(500, 200)) });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'unavailable');
  assert.notEqual(result.status, 'forbidden');
  assert.notEqual(result.status, 'absent');
  if (result.status === 'unavailable') {
    assert.equal(result.retryable, true, 'a server outage is transient');
  }
});

void test('a continuation page keeps its own typed failure and is never an absence', async () => {
  const cases: readonly { readonly label: string; readonly answer: () => Response; readonly code: string }[] = [
    { label: 'auth', answer: () => jsonResponse(errorPayload(401, 401), 401), code: 'auth_required' },
    { label: 'forbidden', answer: () => jsonResponse(errorPayload(403, 403), 403), code: 'forbidden' },
    { label: 'not found', answer: () => jsonResponse(errorPayload(404, 404), 404), code: 'unavailable' },
    { label: 'html challenge', answer: () => htmlResponse('<html><body><h1>Just a moment</h1></body></html>'), code: 'changed_response' },
    { label: 'fake empty success', answer: () => jsonResponse(pagePayload([], 56)), code: 'changed_response' },
    {
      label: 'server error',
      answer: () => jsonResponse(errorPayload(500, 500), 500),
      code: 'unavailable',
    },
  ];
  for (const entry of cases) {
    const feed = editorialFeed({ count: 56 });
    feed.override.set(2, entry.answer);
    const result = await readEditorial(pagedReader(feed).reader);
    assert.equal(result.status, entry.code, entry.label);
    assert.notEqual(result.status, 'absent', entry.label);
  }
});

void test('a rate-limited continuation page stays rate_limited', async () => {
  const feed = editorialFeed({ count: 56 });
  feed.override.set(2, () => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
  const h = harness({ [SOLUTION_PATH]: (url) => feed.route(url) });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'rate_limited');
  assert.notEqual(result.status, 'absent');
  if (result.status === 'rate_limited') {
    assert.equal(result.retryAfterMs, 30_000);
  }
});

void test('a cancellation between pages dispatches no further request', async () => {
  const source = createCancellationSource();
  const feed = editorialFeed({ count: 56 });
  const h = harness({ [SOLUTION_PATH]: (url) => feed.route(url) });
  // Cancel while the second page is being answered, i.e. after the first page's request was made.
  feed.override.set(2, () => {
    source.cancel('cancelled while page 2 was answered');
    return jsonResponse(pagePayload(
      Array.from({ length: 10 }, (_, index) => solutionItem({ lid: `lid-${String(10 + index)}` })),
      56,
    ));
  });
  await assert.rejects(readEditorial(readerFor(h), { token: source.token }));
  assert.deepEqual(feed.pages, [null, 2], 'no page beyond the cancelled one is requested');
});

// ---------------------------------------------------------------------------------------
// Absence: the one explicit signal
// ---------------------------------------------------------------------------------------

void test('only an explicit zero count with an empty list is reported as absent', async () => {
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([], 0)) });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'absent');
  if (result.status === 'absent') {
    // The sentence states the observation and carries no platform value.
    assert.match(result.detail, /count 0/u);
    assert.equal(result.detail.includes('PLACEHOLDER'), false);
  }
});

void test('an authenticated absence is what unlocks the statement-only reasoning path', async () => {
  // `absent` is the only status the pipeline treats as "there is no editorial": it is what the
  // material gate lets through to reasoning. It must therefore require the explicit signal.
  const absent = await readEditorial(readerFor(harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([], 0)) })));
  assert.equal(absent.status, 'absent');

  // Every neighbouring answer must NOT be `absent`.
  const notAbsent: readonly { readonly label: string; readonly routes: HttpHarnessOptions['routes'] }[] = [
    { label: 'count disagrees with result', routes: { [SOLUTION_PATH]: () => jsonResponse(positivePayload([], 3)) } },
    {
      label: 'solutions block missing',
      routes: { [SOLUTION_PATH]: () => jsonResponse({ status: 200, data: { problem: { pid: PID } } }) },
    },
    {
      label: 'page without hydration',
      routes: { [SOLUTION_PATH]: () => htmlResponse('<html><body><div id="app"></div></body></html>') },
    },
    { label: 'not json', routes: { [SOLUTION_PATH]: () => jsonResponse({ status: 200, data: 'PLACEHOLDER' }) } },
    {
      // A shaped, empty solution block next to an error envelope: the classic way a refusal could be
      // mistaken for "no editorial exists".
      label: 'error envelope with a fake empty block',
      routes: {
        [SOLUTION_PATH]: () => jsonResponse(errorPayload(401, 401, { solutions: { perPage: 10, count: 0, result: [] } }), 401),
      },
    },
    {
      label: 'wrong pid',
      routes: {
        [SOLUTION_PATH]: () =>
          jsonResponse({
            status: 200,
            data: {
              solutions: { perPage: 10, count: 0, result: [] },
              problem: { pid: 'P9999', type: 'P' },
            },
          }),
      },
    },
    {
      label: 'problem block missing',
      routes: {
        [SOLUTION_PATH]: () =>
          jsonResponse({ status: 200, data: { solutions: { perPage: 10, count: 0, result: [] } } }),
      },
    },
    {
      label: 'perPage unreadable',
      routes: {
        [SOLUTION_PATH]: () =>
          jsonResponse({ status: 200, data: { solutions: { perPage: 0, count: 0, result: [] }, problem: { pid: PID } } }),
      },
    },
    {
      // A shaped, empty solution block under a status that is not a recognised success.
      label: 'envelope status not 200',
      routes: {
        [SOLUTION_PATH]: () =>
          jsonResponse({
            status: 500,
            data: { solutions: { perPage: 10, count: 0, result: [] }, problem: { pid: PID } },
          }),
      },
    },
  ];
  for (const entry of notAbsent) {
    const result = await readEditorial(readerFor(harness(entry.routes)));
    assert.notEqual(result.status, 'absent', entry.label);
  }
});

// ---------------------------------------------------------------------------------------
// Failures keep their own code
// ---------------------------------------------------------------------------------------

void test('a 404 payload is unavailable and explicitly not an absence', async () => {
  for (const payload of [errorPayload(404, 404), errorPayload(404, 200)]) {
    const result = await readEditorial(readerFor(harness({ [SOLUTION_PATH]: () => jsonResponse(payload, 404) })));
    assert.equal(result.status, 'unavailable');
    assert.notEqual(result.status, 'absent');
  }
});

void test('an authentication wall is auth_required, never an absence and never a free reasoning run', async () => {
  const result = await readEditorial(
    readerFor(harness({ [SOLUTION_PATH]: () => jsonResponse(errorPayload(401, 401), 401) })),
  );
  assert.equal(result.status, 'auth_required');
  assert.notEqual(result.status, 'absent');
  // The classification reads the code only, so no server-provided text can reach a diagnostic.
  if (result.status === 'auth_required') {
    assert.equal(result.detail.includes('PLACEHOLDER_ERROR_MESSAGE'), false);
    assert.equal(result.detail.includes('PLACEHOLDER_ERROR_TYPE'), false);
  }
});

void test('a refusal and a server failure are reported as operational failures', async () => {
  const forbidden = await readEditorial(
    readerFor(harness({ [SOLUTION_PATH]: () => jsonResponse(errorPayload(403, 403), 403) })),
  );
  assert.equal(forbidden.status, 'forbidden');
  assert.notEqual(forbidden.status, 'absent');

  const broken = await readEditorial(
    readerFor(harness({ [SOLUTION_PATH]: () => jsonResponse(errorPayload(500, 500), 500) })),
  );
  assert.equal(broken.status, 'unavailable');
  assert.notEqual(broken.status, 'absent');
});

void test('a login redirect and a page without hydration are recognized, and neither is an absence', async () => {
  // A redirect towards a login path is refused *before* the credential could be sent to it, so the
  // answer is an operational failure — never an absence.
  const redirect = await readEditorial(
    readerFor(
      harness({
        [SOLUTION_PATH]: () =>
          new Response('', {
            status: 302,
            headers: { location: 'https://www.luogu.com.cn/auth/login' },
          }),
      }),
    ),
  );
  assert.notEqual(redirect.status, 'absent');
  assert.equal(redirect.status === 'unavailable' || redirect.status === 'auth_required', true);

  // A page without the hydration element says nothing about whether material exists.
  const page = await readEditorial(
    readerFor(harness({ [SOLUTION_PATH]: () => htmlResponse('<html><body><h1>Just a moment</h1></body></html>') })),
  );
  assert.equal(page.status, 'changed_response');
  assert.notEqual(page.status, 'absent');

  // An HTML login page answered in place is the authentication wall.
  const loginPage = await readEditorial(
    readerFor(
      harness({ [SOLUTION_PATH]: () => htmlResponse('<html><body><form id="login-form"></form></body></html>') }),
    ),
  );
  assert.equal(loginPage.status, 'changed_response');
  assert.notEqual(loginPage.status, 'absent');
});

void test('a truncated write-up is refused rather than stored as complete material', async () => {
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem({ contentFull: false })])) });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
});

void test('a write-up id this build cannot store is refused without carrying the value', async () => {
  const h = harness({
    [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem({ lid: `${LID_SENTINEL}\u0007` })])),
  });
  const result = await readEditorial(readerFor(h));
  assert.equal(result.status, 'changed_response');
  assert.notEqual(result.status, 'absent');
  const projection = projectionOf(result);
  assert.equal(projection.includes(LID_SENTINEL), false, 'the refused id must not travel with the failure');
});

// ---------------------------------------------------------------------------------------
// Credential and scope boundaries
// ---------------------------------------------------------------------------------------

void test('the raw provider cookie never reaches a result, a diagnostic or a sample', async () => {
  // A provider whose stored value is a whole Cookie line, including a session secret.
  const secret = 'SESSION_SECRET_PLACEHOLDER';
  const sessions: LuoguSessionProvider = {
    sessionFor: async () => ({ uid: UID, cookie: `Cookie: __client_id=${CLIENT_ID}; _uid=${UID}; __session=${secret}` }),
  };
  const ok = await readEditorial(readerFor(harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) }), sessions));
  assert.equal(ok.status, 'found');
  assert.equal(JSON.stringify(ok).includes(secret), false);

  // The provider itself fails with a message that quotes the credential: the refusal must not.
  const leaking: LuoguSessionProvider = {
    sessionFor: async () => {
      throw new Error(`credential store rejected ${secret} for uid ${UID}`);
    },
  };
  const failure = await readEditorial(
    readerFor(harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) }), leaking),
  );
  // A credential-provider failure is an operational failure, returned with its own discriminant.
  assert.equal(failure.status, 'unavailable');
  assert.notEqual(failure.status, 'absent');
  assert.equal(projectionOf(failure).includes(secret), false);
  assert.equal(projectionOf(failure).includes(CLIENT_ID), false);

  // A body-read failure whose message would quote the cookie is sanitized the same way.
  const bodyFailure = await readEditorial(
    readerFor(
      harness({
        [SOLUTION_PATH]: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error(`stream failed while sending ${COOKIE}`));
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      }),
    ),
  );
  assert.equal(bodyFailure.status, 'unavailable');
  assert.equal(projectionOf(bodyFailure).includes(CLIENT_ID), false);
});

void test('a session for another account is refused as an authentication wall, before any request', async () => {
  const foreign: LuoguSessionProvider = { sessionFor: async () => ({ uid: '999999', cookie: COOKIE }) };
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  const result = await readEditorial(readerFor(h, foreign));
  assert.equal(result.status, 'auth_required');
  assert.notEqual(result.status, 'absent');
  assert.equal(h.requests.length, 0);
});

void test('a reference of another instance and a malformed reference are refused before any request', async () => {
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  const reader = readerFor(h);
  await rejectsWithCode(
    readEditorial(reader, { problemRef: { sourceInstanceId: 'luogu:mirror.example', domain: null, externalKey: PID } }),
    'invalid_input',
  );
  await rejectsWithCode(
    readEditorial(reader, { problemRef: { sourceInstanceId: SOURCE.id, domain: 'extra', externalKey: PID } }),
    'invalid_input',
  );
  await rejectsWithCode(
    readEditorial(reader, { problemRef: { sourceInstanceId: SOURCE.id, domain: null, externalKey: 'bad key!' } }),
    'invalid_input',
  );
  assert.equal(h.requests.length, 0);
});

void test('a supplied editorial URL is refused because Luogu material is addressed by problem id', async () => {
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  await rejectsWithCode(
    readEditorial(readerFor(h), { officialTutorialUrl: 'https://www.luogu.com.cn/problem/solution/P1001' }),
    'invalid_input',
  );
  assert.equal(h.requests.length, 0);
});

void test('a cancelled read dispatches nothing and a cancellation during it is observed', async () => {
  const preCancelled = createCancellationSource();
  preCancelled.cancel('cancelled before the read');
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  await assert.rejects(readEditorial(readerFor(h), { token: preCancelled.token }));
  assert.equal(h.requests.length, 0);

  // Cancelled while the session resolves: nothing is dispatched and the outcome is a cancellation.
  const afterSession = createCancellationSource();
  const cancelling: LuoguSessionProvider = {
    sessionFor: async () => {
      afterSession.cancel('cancelled while the session resolved');
      return SESSION;
    },
  };
  await assert.rejects(
    readEditorial(readerFor(harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) }), cancelling), {
      token: afterSession.token,
    }),
  );
});

// ---------------------------------------------------------------------------------------
// The target guard of the session transport
// ---------------------------------------------------------------------------------------

/**
 * A transport that may answer exactly one solution page of one problem.
 *
 * The reader only ever builds the one canonical URL per page, so the guard's refusals can only be
 * observed by asking the transport for the URLs it must refuse — which is exactly what a redirect, a
 * future refactor or a hostile caller would do. `bound` is what the owning call would have bound
 * before its request, and it is changed here the way the reader changes it: never while a request is
 * in flight.
 */
function guardHarness() {
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(pagePayload([solutionItem()], 1)) });
  const bound: { target: { kind: 'editorial'; pid: string; page: number } | null } = {
    target: { kind: 'editorial', pid: PID, page: 2 },
  };
  const fetchImpl = createAuthenticatedLuoguFetch({
    cookie: () => CANONICAL_COOKIE,
    expectedUid: UID,
    expectedTarget: () => bound.target,
    fetchImpl: h.impl.fetchImpl,
  });
  return { h, bound, fetchImpl };
}

const UNBOUND_REQUEST: FetchInitLike = {
  method: 'GET',
  headers: {},
  redirect: 'manual',
  credentials: 'omit',
  signal: new AbortController().signal,
};

void test('the session transport accepts the canonical page of this problem and nothing else', async () => {
  const good = guardHarness();
  const accepted = await good.fetchImpl(`https://www.luogu.com.cn${SOLUTION_PATH}?page=2`, UNBOUND_REQUEST);
  assert.equal(accepted.status, 200);
  assert.equal(good.h.requests.length, 1);
  assert.equal(
    (good.h.requests[0]?.init.headers as Readonly<Record<string, string>>)['cookie'],
    CANONICAL_COOKIE,
    'exactly the one bound page receives the credential',
  );

  // The first page is the unparameterised surface; page 1 with an explicit query is not this call's
  // target, and neither is a zero-padded spelling of the page it did bind.
  const refused: readonly string[] = [
    `https://www.luogu.com.cn${SOLUTION_PATH}`, // bound page 2, asked for page 1
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=02`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=2&page=2`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=2&extra=1`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?extra=1&page=2`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=2#fragment`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=3`,
    `https://www.luogu.com.cn/problem/P1002?page=2`,
    `https://www.luogu.com.cn/problem/solution/P1002?page=2`,
    `https://www.luogu.com.cn/problem/solution/P1001?page=2&extra=`,
    'https://www.luogu.com.cn/auth/login',
    'https://evil.example.com/problem/solution/P1001?page=2',
    'https://www.luogu.com.cn:8443/problem/solution/P1001?page=2',
    'https://user:secret@www.luogu.com.cn/problem/solution/P1001?page=2',
    'http://www.luogu.com.cn/problem/solution/P1001?page=2',
    'not a url',
  ];
  for (const url of refused) {
    try {
      await good.fetchImpl(url, UNBOUND_REQUEST);
      assert.fail(`the guard must refuse ${url}`);
    } catch (error) {
      const code = isPlatformError(error) ? error.code : undefined;
      assert.equal(code === 'unavailable' || code === 'auth_required', true, `${url} -> ${String(code)}`);
      // No refusal echoes the query (it carries the account's page) or the URL itself.
      assert.equal(projectionOf(error).includes('extra=1'), false, url);
      assert.equal(projectionOf(error).includes('secret'), false, url);
    }
  }
  assert.equal(good.h.requests.length, 1, 'every refusal happened before dispatch');
});

void test('the session transport refuses to send anything while no target is bound', async () => {
  const guard = guardHarness();
  guard.bound.target = null;
  await assert.rejects(
    guard.fetchImpl(`https://www.luogu.com.cn${SOLUTION_PATH}?page=2`, UNBOUND_REQUEST),
    (error: unknown) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.equal(guard.h.requests.length, 0);
});

void test('the reader binds page 1 without a query and every later page canonically', async () => {
  const feed = editorialFeed({ count: 21 });
  const paged = pagedReader(feed);
  const found = await readEditorial(paged.reader);
  assert.equal(found.status, 'found');
  assert.deepEqual(feed.urls, [
    `https://www.luogu.com.cn${SOLUTION_PATH}`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=2`,
    `https://www.luogu.com.cn${SOLUTION_PATH}?page=3`,
  ]);
  assert.equal(paged.h.requests.length, 3);
});

// ---------------------------------------------------------------------------------------
// The adapter seam
// ---------------------------------------------------------------------------------------

void test('the composed adapter delegates to the reader when an account is given', async () => {
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  const reader = readerFor(h);
  const adapter = createLuoguAdapter({ sourceInstance: SOURCE, sessionReader: reader });
  const result = await adapter.fetchEditorial({
    problemRef: REF,
    token: createCancellationSource().token,
    limits: LIMITS,
    account: ACCOUNT,
  });
  assert.equal(result.status, 'found');
  assert.equal(h.requests.length, 1);
  // The capability is advertised only because a reader is installed.
  assert.equal(adapter.capabilities().editorial, true);
});

void test('without an account the adapter probes anonymously and never reports an absence', async () => {
  // The anonymous probe is the *adapter's own* transport: no session, no account, no reader. Every
  // case below installs the harness wiring, so nothing here can reach the network.
  const walled = harness({ [SOLUTION_PATH]: () => jsonResponse(errorPayload(401, 401), 401) });
  const adapter = createLuoguAdapter({ sourceInstance: SOURCE, sessionReader: readerFor(walled), ...walled.impl });
  const result = await adapter.fetchEditorial({ problemRef: REF, token: createCancellationSource().token, limits: LIMITS });
  assert.equal(result.status, 'auth_required');
  assert.notEqual(result.status, 'absent');
  assert.equal(walled.requests.length, 1, 'the anonymous probe is what answered, not the reader');

  // Without a reader at all, the anonymous probe answers what the platform answers it: an unfamiliar
  // successful payload is a changed response and the observed authentication wall is `auth_required`.
  // Neither is ever an absence, because an anonymous read is not evidence about whether material exists.
  const bare = createLuoguAdapter({ sourceInstance: SOURCE });
  assert.equal(bare.capabilities().editorial, false);
  const unknownPayload = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  const anonymous = await createLuoguAdapter({ sourceInstance: SOURCE, ...unknownPayload.impl }).fetchEditorial({
    problemRef: REF,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.equal(anonymous.status, 'changed_response');
  assert.notEqual(anonymous.status, 'absent');
  const bareWalled = harness({ [SOLUTION_PATH]: () => jsonResponse(errorPayload(401, 401), 401) });
  const wall = await createLuoguAdapter({ sourceInstance: SOURCE, ...bareWalled.impl }).fetchEditorial({
    problemRef: REF,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.equal(wall.status, 'auth_required');
  assert.notEqual(wall.status, 'absent');
});

void test('the anonymous probe is body-blind on every answer shape', async () => {
  // The anonymous surface is unverified material, and an editorial failure's sample is persisted into a
  // note (and travels in the DTO), so *no* answer shape may reproduce what the body contained: not an
  // HTML page, not a body that is not valid JSON, not a non-object JSON body and not an error envelope
  // whose own `errorType`/`errorMessage` carry the text.
  const anonymousRead = async (response: Response): Promise<{ readonly result: unknown; readonly status: string }> => {
    const h = harness({ [SOLUTION_PATH]: () => response });
    const result = await createLuoguAdapter({ sourceInstance: SOURCE, ...h.impl }).fetchEditorial({
      problemRef: REF,
      token: createCancellationSource().token,
      limits: LIMITS,
    });
    return { result, status: result.status };
  };
  const answers: readonly { readonly label: string; readonly response: () => Response; readonly status: string }[] = [
    {
      label: 'html page',
      response: () => htmlResponse(`<html><body><h1>${ANONYMOUS_BODY_SENTINEL}</h1></body></html>`),
      status: 'changed_response',
    },
    {
      label: 'broken json',
      response: () =>
        new Response(`{"solutions": "${ANONYMOUS_BODY_SENTINEL}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      status: 'changed_response',
    },
    { label: 'json scalar', response: () => jsonResponse(ANONYMOUS_BODY_SENTINEL), status: 'changed_response' },
    {
      label: 'json array',
      response: () => jsonResponse([ANONYMOUS_BODY_SENTINEL]),
      status: 'changed_response',
    },
    {
      label: 'error envelope 401',
      response: () => jsonResponse(errorPayload(401, 200, { errorMessage: ANONYMOUS_BODY_SENTINEL }), 200),
      status: 'auth_required',
    },
    {
      label: 'error envelope 403',
      response: () => jsonResponse(errorPayload(403, 200, { errorType: ANONYMOUS_BODY_SENTINEL }), 200),
      status: 'forbidden',
    },
    {
      label: 'error envelope 429',
      response: () => jsonResponse(errorPayload(429, 200, { errorMessage: ANONYMOUS_BODY_SENTINEL }), 200),
      status: 'rate_limited',
    },
    {
      label: 'error envelope 500',
      response: () => jsonResponse(errorPayload(500, 200, { errorMessage: ANONYMOUS_BODY_SENTINEL }), 200),
      status: 'unavailable',
    },
    {
      label: 'error envelope unknown code',
      response: () => jsonResponse(errorPayload(418, 200, { errorMessage: ANONYMOUS_BODY_SENTINEL }), 200),
      status: 'changed_response',
    },
  ];
  for (const entry of answers) {
    const { result, status } = await anonymousRead(entry.response());
    assert.equal(status, entry.status, entry.label);
    assert.notEqual(status, 'absent', entry.label);
    assert.notEqual(status, 'found', entry.label);
    const projection = projectionOf(result);
    assert.equal(projection.includes(ANONYMOUS_BODY_SENTINEL), false, `${entry.label}: the body must not travel`);
    // `changed_response` is the only variant with a sample, and it must be null; the others have no
    // sample member at all.
    const typed = result as { readonly sample?: string | null };
    assert.equal(typed.sample ?? null, null, `${entry.label}: no sample`);
  }
});

void test('an anonymously readable solution body is never echoed into the failure sample', async () => {
  // If the anonymous surface ever starts answering bodies, the adapter's `changed_response` must not
  // become the place where a body is reproduced — a sample travels into DTOs, notes and diagnostics.
  const body = {
    status: 200,
    data: {
      solutions: {
        perPage: 10,
        count: 1,
        result: [solutionItem({ content: ANONYMOUS_BODY_SENTINEL })],
      },
      problem: { pid: PID, type: 'P' },
    },
    user: null,
    time: 1_700_000_000,
  };
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(body) });
  const result = await createLuoguAdapter({ sourceInstance: SOURCE, ...h.impl }).fetchEditorial({
    problemRef: REF,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.equal(result.status, 'changed_response');
  if (result.status === 'changed_response') {
    assert.equal(result.sample, null, 'an anonymous body must never become the sample');
    assert.equal(JSON.stringify(result).includes(ANONYMOUS_BODY_SENTINEL), false);
  }
});

void test('the anonymous probe rebuilds every transport failure without its text or sample', async () => {
  // The shared transport's failures are typed but not body-free: a network message can quote an
  // injected fetch's error, and a bad redirect `Location` is attached as a `sample`. An anonymous answer
  // is unverified material, so none of that may reach the returned result.
  const sentinel = 'TRANSPORT_SENTINEL';
  const read = async (routes: HttpHarnessOptions['routes']): Promise<EditorialFetchResult> => {
    const h = harness(routes);
    const adapter = createLuoguAdapter({ sourceInstance: SOURCE, ...h.impl });
    return await adapter.fetchEditorial({ problemRef: REF, token: createCancellationSource().token, limits: LIMITS });
  };
  const cases: readonly { readonly label: string; readonly run: () => Promise<EditorialFetchResult>; readonly status: string }[] = [
    {
      label: 'fetch rejects',
      status: 'unavailable',
      run: async () => {
        const h = harness({});
        const adapter = createLuoguAdapter({
          sourceInstance: SOURCE,
          ...h.impl,
          fetchImpl: async () => {
            throw new Error(`socket failed with ${sentinel}`);
          },
        });
        return await adapter.fetchEditorial({ problemRef: REF, token: createCancellationSource().token, limits: LIMITS });
      },
    },
    {
      label: 'body stream throws',
      status: 'unavailable',
      run: () =>
        read({
          [SOLUTION_PATH]: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error(`stream failed with ${sentinel}`));
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        }),
    },
    {
      label: 'redirect Location is not a URL',
      status: 'changed_response',
      run: () =>
        read({
          [SOLUTION_PATH]: () =>
            new Response('', { status: 302, headers: { location: `http://[${sentinel}` } }),
        }),
    },
    {
      label: 'cross-origin redirect',
      status: 'unavailable',
      run: () =>
        read({
          [SOLUTION_PATH]: () =>
            new Response('', { status: 302, headers: { location: `https://evil.example.com/${sentinel}` } }),
        }),
    },
  ];
  for (const entry of cases) {
    const result = await entry.run();
    assert.equal(result.status, entry.status, entry.label);
    assert.notEqual(result.status, 'absent', entry.label);
    assert.notEqual(result.status, 'found', entry.label);
    const projection = projectionOf(result);
    assert.equal(projection.includes(sentinel), false, `${entry.label}: no transport text may travel`);
    const typed = result as { readonly sample?: string | null };
    assert.equal(typed.sample ?? null, null, `${entry.label}: no sample`);
  }
});

void test('a forged platform failure cannot smuggle its own metadata into the anonymous result', async () => {
  // The failure is untrusted at the runtime level: an injected fetch can construct a `PlatformError`
  // whose `code` is not a declared discriminant, whose `retryable` is not a boolean, or whose
  // `retryAfterMs` is not a delay. None of that may reach the result — and the call must still return a
  // complete typed failure rather than `undefined`.
  const CODE_SENTINEL = 'FORGED_CODE_SENTINEL';
  const RETRY_SENTINEL = 'RETRY_SENTINEL';
  const AFTER_SENTINEL = 'RETRY_AFTER_SENTINEL';
  const failureFrom = async (forge: (error: PlatformError) => void): Promise<EditorialFetchResult> => {
    const h = harness({});
    const adapter = createLuoguAdapter({
      sourceInstance: SOURCE,
      ...h.impl,
      fetchImpl: async () => {
        const error = new PlatformError({ code: 'unavailable', operation: 'editorial', detail: 'x' });
        forge(error);
        throw error;
      },
    });
    return await adapter.fetchEditorial({ problemRef: REF, token: createCancellationSource().token, limits: LIMITS });
  };

  // A code outside the declared vocabulary: fixed `unavailable`, non-retryable, no trace of the value.
  const forgedCode = await failureFrom((error) => {
    (error as unknown as { code: unknown }).code = CODE_SENTINEL;
  });
  assert.equal(forgedCode.status, 'unavailable');
  if (forgedCode.status === 'unavailable') {
    assert.equal(forgedCode.retryable, false);
  }
  assert.equal(projectionOf(forgedCode).includes(CODE_SENTINEL), false);
  assert.equal(JSON.stringify(forgedCode).includes('undefined'), false);

  // A forged `retryable`: the whole answer degrades to the fixed non-retryable `unavailable`, so a
  // non-boolean can never be read as "retry me" by the layer above.
  const forgedRetryable = await failureFrom((error) => {
    (error as unknown as { retryable: unknown }).retryable = RETRY_SENTINEL;
  });
  assert.equal(forgedRetryable.status, 'unavailable');
  if (forgedRetryable.status === 'unavailable') {
    assert.equal(forgedRetryable.retryable, false);
    assert.equal(typeof forgedRetryable.retryable, 'boolean');
  }
  assert.equal(projectionOf(forgedRetryable).includes(RETRY_SENTINEL), false);

  // A forged delay: the code's own mapping is kept and the delay is dropped. Note that the shared error
  // constructor already normalizes some shapes on its way through the transport (a negative or infinite
  // value becomes `null`, a fractional one is rounded), so what this boundary must guarantee is that
  // nothing forged survives — never a sentinel, and never a value that is not a safe non-negative
  // integer.
  const droppedDelays: readonly unknown[] = [AFTER_SENTINEL, -1, Number.MAX_VALUE, Number.POSITIVE_INFINITY, null];
  for (const forgedDelay of [...droppedDelays, 1.5]) {
    const result = await failureFrom((error) => {
      (error as unknown as { code: unknown }).code = 'rate_limited';
      (error as unknown as { retryable: unknown }).retryable = true;
      (error as unknown as { retryAfterMs: unknown }).retryAfterMs = forgedDelay;
    });
    assert.equal(result.status, 'rate_limited', String(forgedDelay));
    if (result.status === 'rate_limited') {
      const delay = result.retryAfterMs;
      assert.equal(
        delay === null || (Number.isSafeInteger(delay) && delay >= 0),
        true,
        `${String(forgedDelay)} produced ${String(delay)}`,
      );
    }
    assert.equal(projectionOf(result).includes(AFTER_SENTINEL), false, String(forgedDelay));
  }
  // The values that reach this boundary un-normalized are dropped outright rather than forwarded.
  for (const forgedDelay of droppedDelays) {
    const result = await failureFrom((error) => {
      (error as unknown as { code: unknown }).code = 'rate_limited';
      (error as unknown as { retryable: unknown }).retryable = true;
      (error as unknown as { retryAfterMs: unknown }).retryAfterMs = forgedDelay;
    });
    if (result.status === 'rate_limited') {
      assert.equal(result.retryAfterMs, null, String(forgedDelay));
    }
  }
});

void test('a redirect to a login path is the authentication wall for the anonymous probe', async () => {
  // A followed redirect that ends on the login page is the session wall, whatever the page body is; an
  // inline login page served at the original URL has no reliable structural signal and stays a changed
  // response.
  for (const loginPath of ['/auth/login', '/login']) {
    const h = harness({
      [SOLUTION_PATH]: () => new Response('', { status: 302, headers: { location: `https://www.luogu.com.cn${loginPath}` } }),
      [loginPath]: () => htmlResponse('<html><body><form id="login-form"></form></body></html>'),
    });
    const result = await createLuoguAdapter({ sourceInstance: SOURCE, ...h.impl }).fetchEditorial({
      problemRef: REF,
      token: createCancellationSource().token,
      limits: LIMITS,
    });
    assert.equal(result.status, 'auth_required', loginPath);
    assert.notEqual(result.status, 'changed_response', loginPath);
    assert.notEqual(result.status, 'absent', loginPath);
  }
  // The same page served inline at the solution URL is a changed response, not an authentication wall.
  const inline = harness({
    [SOLUTION_PATH]: () => htmlResponse('<html><body><form id="login-form"></form></body></html>'),
  });
  const inlineResult = await createLuoguAdapter({ sourceInstance: SOURCE, ...inline.impl }).fetchEditorial({
    problemRef: REF,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.equal(inlineResult.status, 'changed_response');
  assert.notEqual(inlineResult.status, 'auth_required');
});

void test('a reader that cannot serve editorial material is refused at construction', () => {
  // The adapter advertises `editorial: true` whenever a reader is installed, so a reader that cannot
  // answer `fetchEditorial` must be refused instead of being advertised and called anyway.
  assert.throws(
    () =>
      createLuoguAdapter({
        sourceInstance: SOURCE,
        sessionReader: {
          listSubmissions: async () => ({ items: [], nextCursor: null, fetchedAt: AT }),
        } as unknown as Parameters<typeof createLuoguAdapter>[0]['sessionReader'],
      }),
    (error: unknown) => isPlatformError(error) && error.code === 'invalid_input',
  );
  assert.throws(
    () =>
      createLuoguAdapter({
        sourceInstance: SOURCE,
        sessionReader: {
          fetchEditorial: async () => ({ status: 'absent', detail: 'x' }),
        } as unknown as Parameters<typeof createLuoguAdapter>[0]['sessionReader'],
      }),
    (error: unknown) => isPlatformError(error) && error.code === 'invalid_input',
  );
});

void test('an account of another source instance is refused before the adapter delegates', async () => {
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  const adapter = createLuoguAdapter({ sourceInstance: SOURCE, sessionReader: readerFor(h) });
  // A Codeforces account can never authenticate a Luogu read; the scope check refuses it first.
  const foreignAccount: Account = {
    id: 'codeforces:codeforces.com|alice',
    sourceInstanceId: 'codeforces:codeforces.com',
    handle: 'alice',
    displayName: 'Alice',
    profileUrl: null,
  };
  await assert.rejects(
    adapter.fetchEditorial({
      problemRef: REF,
      token: createCancellationSource().token,
      limits: LIMITS,
      account: foreignAccount,
    }),
  );
  assert.equal(h.requests.length, 0);
});

void test('two reads of one payload produce the same stored hashes', async () => {
  // The stored record is a function of the payload, not of when it was read: `retrievedAt` is a
  // timestamp, while the identity and content hashes stay stable across reads.
  const h = harness({ [SOLUTION_PATH]: () => jsonResponse(positivePayload([solutionItem()])) });
  const first = await readEditorial(readerFor(h));
  const second = await readEditorial(readerFor(h));
  assert.equal(first.status, 'found');
  assert.equal(second.status, 'found');
  if (first.status !== 'found' || second.status !== 'found') {
    return;
  }
  assert.equal(first.sources[0]?.contentHash, second.sources[0]?.contentHash);
  assert.equal(first.solutions[0]?.contentHash, second.solutions[0]?.contentHash);
  assert.equal(first.sources[0]?.retrievedAt, AT);
  assert.deepEqual(DEFAULT_PLATFORM_LIMITS.maxRetries >= 0, true);
});
