/**
 * Sprint 17a — authenticated Luogu submission reader regressions.
 *
 * Everything here is synthetic and in-process: a fake HTTP harness, synthetic session strings and
 * original fixture records. No network, no real credential, no download. The synthetic
 * `__client_id` is an opaque session identifier deliberately unequal to any account UID, because
 * that is what the real cookie is, and the fixture also carries an unrelated `__session` secret so
 * every dispatch assertion proves a whole-Cookie input is normalized to the two required cookies.
 * The tests pin down the properties the contract promises: exact
 * row limits and cursor continuation without loss or duplication, inclusive `since`, scope-bound
 * and drift-checked cursors, rejudge tolerance, account and record identity rejection, the exact
 * authenticated target (login redirects classified without a dispatch, alternate path/UID/page
 * refused), fixed sanitized failures from every untrusted boundary (typed provider errors, typed
 * fetch errors, body-stream errors, parser `errorType` text), single-owner session binding with
 * overlap rejection and release on success/error/cancel, cancellation before and during IO, and the
 * honest capability split of a plain adapter versus one with an injected reader.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_MAX_SUBMISSION_LIMIT,
  LUOGU_UID_PATTERN,
  LuoguAdapter,
  createAuthenticatedLuoguFetch,
  createLuoguAccount,
  createLuoguAdapter,
  createLuoguSessionReader,
  luoguSourceInstance,
  luoguStatusVerdict,
  parseRecordPage,
  requireLuoguInstance,
  requireLuoguSessionCookie,
  type LuoguRecordPage,
  type LuoguSession,
  type LuoguSessionProvider,
  type LuoguSessionReaderAdapter,
  type LuoguSessionReaderOptions,
} from '../../src/adapters/luogu/index.js';
import {
  decodeLuoguRecordCursor,
  encodeLuoguRecordCursor,
  luoguRecordPageFingerprint,
} from '../../src/adapters/luogu/record-cursors.js';
import type { FetchInitLike, FetchLike } from '../../src/adapters/platform/http.js';
import type { LuoguSessionReader } from '../../src/application/luogu-session.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import type { PlatformLimits } from '../../src/application/ports.js';
import {
  DomainError,
  LUOGU_SESSION_UID_PATTERN,
  createAccount,
  createCancellationSource,
  createSourceInstance,
  inspectLuoguSessionCookie,
  luoguSessionCookieFromClientId,
  normalizeLuoguSessionCookie,
  type Submission,
} from '../../src/domain/index.js';
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

const UID = '248159';
const OTHER_UID = '100001';
/** Synthetic session material: never a real cookie, never stored outside this file. */
const SESSION_SECRET = 'synthetic-session-secret-0123456789abcdef';
/**
 * Opaque synthetic `__client_id` values. Luogu's client id is a session identifier, not a UID, so
 * the fixture is a random-looking token that is deliberately not equal to any account id.
 */
const CLIENT_ID = 'b7f1c0a94e2d4f6a8c1b3d5e7f901234';
const OTHER_CLIENT_ID = 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const COOKIE = `__client_id=${CLIENT_ID}; _uid=${UID}; __session=${SESSION_SECRET}`;
/** The canonical pair every accepted session is reduced to before it can travel. */
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
const START_SECONDS = 1_700_000_000;

interface PlatformErrorLike {
  readonly code?: string;
  readonly detail?: string;
  readonly sample?: string | null;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number | null;
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

/** Every textual surface of an error — fields, message and JSON projection — must stay secret-free. */
function assertNoSecret(error: unknown): void {
  const projection =
    typeof error === 'object' && error !== null ? JSON.stringify(error as Record<string, unknown>) : String(error);
  const text = `${errorText(error)} | ${projection}`;
  assert.ok(!text.includes(SESSION_SECRET), `the session secret leaked into: ${text}`);
  assert.ok(!text.includes(COOKIE), `the session cookie leaked into: ${text}`);
}

function sessionProvider(session: LuoguSession = SESSION): LuoguSessionProvider {
  return { sessionFor: async () => session };
}

function harness(routes: HttpHarnessOptions['routes'], options: Partial<HttpHarnessOptions> = {}): HttpHarness {
  return createHttpHarness({ origin: 'https://www.luogu.com.cn', ...options, routes });
}

function readerFor(
  h: HttpHarness,
  sessions: LuoguSessionProvider = sessionProvider(),
  options: Partial<LuoguSessionReaderOptions> = {},
): LuoguSessionReaderAdapter {
  return createLuoguSessionReader({ sourceInstance: SOURCE, sessions, ...h.impl, ...options });
}

/** One first-page scan of the synthetic account with fresh cancellation and the shared limits. */
function scanOnce(reader: LuoguSessionReaderAdapter): Promise<unknown> {
  return reader.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
}

interface SyntheticRecordOptions {
  readonly id: number;
  readonly pid?: string;
  readonly status?: number;
  readonly at: string;
  readonly language?: unknown;
  readonly user?: unknown;
}

function record(input: SyntheticRecordOptions): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: input.id,
    status: input.status ?? 12,
    submitTime: Math.floor(Date.parse(input.at) / 1000),
    problem: { pid: input.pid ?? 'P1000' },
  };
  if (input.language !== undefined) {
    item.language = input.language;
  }
  if (input.user !== undefined) {
    item.user = input.user;
  }
  return item;
}

/** Newest-first synthetic history: `id` 9000, 8999, … with one-minute steps. */
function history(
  count: number,
  options: { readonly startSeconds?: number; readonly status?: (index: number) => number } = {},
): Record<string, unknown>[] {
  const start = options.startSeconds ?? START_SECONDS;
  return Array.from({ length: count }, (_, index) =>
    record({
      id: 9_000 - index,
      pid: `P${1_000 + index}`,
      status: options.status ? options.status(index) : 12,
      at: new Date((start - index * 60) * 1000).toISOString(),
    }),
  );
}

function pagePayload(
  records: readonly Record<string, unknown>[],
  options: { readonly perPage?: number | null; readonly count?: number | null; readonly uid?: unknown } = {},
): Record<string, unknown> {
  const container: Record<string, unknown> = { result: [...records] };
  if (options.perPage !== undefined && options.perPage !== null) {
    container.perPage = options.perPage;
  }
  if (options.count !== undefined && options.count !== null) {
    container.count = options.count;
  }
  const data: Record<string, unknown> = { records: container };
  if (options.uid !== undefined) {
    data.uid = options.uid;
  }
  return { data };
}

function parseEntries(entries: readonly Record<string, unknown>[], expectedUid = UID): LuoguRecordPage {
  return parseRecordPage(pagePayload(entries, { perPage: entries.length, count: entries.length }), expectedUid);
}

/** Serve a newest-first list in fixed server-page slices, the way `/record/list?page=N` does. */
function pagedRoute(items: readonly Record<string, unknown>[], perPage: number) {
  return (url: URL): Response => {
    const page = Number(url.searchParams.get('page') ?? '1');
    return jsonResponse(
      pagePayload(items.slice((page - 1) * perPage, page * perPage), { perPage, count: items.length }),
    );
  };
}

function pageOf(h: HttpHarness, index: number): string | null {
  return new URL(h.requests[index]!.url).searchParams.get('page');
}

/** A 200 JSON response whose body stream fails with `message` on the first read. */
function erroringBodyResponse(message: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error(message));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * A 200 JSON response that delivers `prefix` and then fails, so the failure happens after the
 * transport has already consumed part of the body — a real disconnect, not a refused request.
 */
function disconnectingBodyResponse(prefix: string, message: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix));
    },
    pull(controller) {
      controller.error(new Error(message));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * A real {@link PlatformError} whose runtime fields are then forged through a cast: the class
 * validates neither `code` nor `retryable`, so a broken or hostile injected boundary can hand the
 * reader a typed error carrying an arbitrary code and secret text.
 */
function forgedPlatformError(overrides: Readonly<Record<string, unknown>>): PlatformError {
  const base = new PlatformError({
    code: 'unavailable',
    operation: 'submissions',
    retryable: true,
    detail: 'forged base',
  });
  Object.assign(base, overrides);
  return base;
}

// ---------------------------------------------------------------------------------------
// Paging: exact limit, no loss, no duplication, pacing, cookie attachment
// ---------------------------------------------------------------------------------------

test('an exact limit pages across server pages without loss or duplication and keeps a 2s floor', async () => {
  const items = history(7, { status: (index) => (index % 3 === 0 ? 12 : 6) });
  const h = harness({ '/record/list': pagedRoute(items, 3) });
  const reader = readerFor(h);
  const token = createCancellationSource().token;

  const collected: Submission[] = [];
  const pages: number[] = [];
  let cursor: string | null = null;
  for (let round = 0; round < 8; round += 1) {
    const page = await reader.listSubmissions({ account: ACCOUNT, cursor, limit: 2, token, limits: LIMITS });
    pages.push(page.items.length);
    collected.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) {
      break;
    }
  }

  assert.equal(cursor, null);
  assert.deepEqual(pages, [2, 2, 2, 1]);
  assert.deepEqual(
    collected.map((submission) => submission.externalId),
    ['9000', '8999', '8998', '8997', '8996', '8995', '8994'],
  );
  assert.equal(new Set(collected.map((submission) => submission.id)).size, 7);
  assert.ok(collected.every((submission) => submission.accountId === ACCOUNT.id));
  assert.deepEqual(
    collected.map((submission) => submission.verdict),
    ['accepted', 'wrong_answer', 'wrong_answer', 'accepted', 'wrong_answer', 'wrong_answer', 'accepted'],
  );
  // True synthetic timestamps are imported verbatim, and the problem identity is the platform's.
  assert.equal(collected[0]?.submittedAt, new Date(START_SECONDS * 1000).toISOString());
  assert.equal(collected[0]?.ref.externalKey, 'P1000');
  assert.deepEqual(
    h.requests.map((_, index) => pageOf(h, index)),
    ['1', '1', '2', '2', '2', '3'],
  );
  // Two seconds between requests is a floor of the authenticated transport, not a caller setting:
  // LIMITS asks for no pacing at all.
  assert.deepEqual(h.waits, [2000, 2000, 2000, 2000, 2000]);
  for (const request of h.requests) {
    assert.equal(new URL(request.url).searchParams.get('user'), UID);
    // The session is normalized: exactly the two required cookies travel, and the unrelated
    // `__session` secret never leaves the process.
    assert.equal(request.init.headers.cookie, CANONICAL_COOKIE);
    assert.equal(request.init.headers.cookie?.includes(SESSION_SECRET), false);
    assert.equal(request.init.headers['x-lentille-request'], 'content-only');
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.redirect, 'manual');
  }
});

test('an unknown page size terminates by probing the next empty page, and an empty history is complete', async () => {
  const items = history(3);
  const h = harness({
    '/record/list': (url: URL) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      return jsonResponse(pagePayload(items.slice((page - 1) * 2, page * 2)));
    },
  });
  const reader = readerFor(h);
  const page = await reader.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.deepEqual(
    page.items.map((submission) => submission.externalId),
    ['9000', '8999', '8998'],
  );
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    h.requests.map((_, index) => pageOf(h, index)),
    ['1', '2', '3'],
  );

  const empty = readerFor(harness({ '/record/list': () => jsonResponse(pagePayload([])) }));
  const emptyPage = await empty.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.deepEqual(emptyPage.items, []);
  assert.equal(emptyPage.nextCursor, null);
});

// ---------------------------------------------------------------------------------------
// Inclusive since bound
// ---------------------------------------------------------------------------------------

test('the since bound is inclusive and ends the window at the first older record', async () => {
  const items = history(5);
  const h = harness({ '/record/list': pagedRoute(items, 2) });
  const reader = readerFor(h);
  const since = new Date((START_SECONDS - 120) * 1000).toISOString();
  const page = await reader.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: LIMITS,
    since,
  });
  // The record whose submitTime equals the bound is included; everything older is not.
  assert.deepEqual(
    page.items.map((submission) => submission.externalId),
    ['9000', '8999', '8998'],
  );
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    page.items.map((submission) => submission.submittedAt),
    [0, 1, 2].map((offset) => new Date((START_SECONDS - offset * 60) * 1000).toISOString()),
  );

  const nothingNew = readerFor(harness({ '/record/list': pagedRoute(items, 2) }));
  const empty = await nothingNew.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: LIMITS,
    since: new Date((START_SECONDS + 3600) * 1000).toISOString(),
  });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
});

test('a resumed cursor is bound to its own since window and account scope', async () => {
  const items = history(6);
  const h = harness({ '/record/list': pagedRoute(items, 2) });
  const reader = readerFor(h);
  const token = createCancellationSource().token;
  const first = await reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS });
  const cursor = first.nextCursor;
  assert.notEqual(cursor, null);
  const requestsBefore = h.requests.length;

  const otherAccount = createLuoguAccount(SOURCE, OTHER_UID, null);
  await rejectsWithCode(
    reader.listSubmissions({ account: otherAccount, cursor, limit: 2, token, limits: LIMITS }),
    'invalid_input',
  );
  await rejectsWithCode(
    reader.listSubmissions({
      account: ACCOUNT,
      cursor,
      limit: 2,
      token,
      limits: LIMITS,
      since: new Date((START_SECONDS - 600) * 1000).toISOString(),
    }),
    'invalid_input',
  );
  assert.equal(h.requests.length, requestsBefore, 'scope failures are refused before any request');

  const resumed = await reader.listSubmissions({ account: ACCOUNT, cursor, limit: 2, token, limits: LIMITS });
  assert.deepEqual(
    resumed.items.map((submission) => submission.externalId),
    ['8998', '8997'],
  );
});

test('rejudging a record does not invalidate a resumable cursor, but changed identity does', async () => {
  const items = history(4);
  let rejudged = false;
  const h = harness({
    '/record/list': (url: URL) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = items.slice((page - 1) * 2, page * 2).map((item) => ({ ...item }));
      if (rejudged && page === 1 && slice[0]) {
        slice[0].status = 6;
      }
      return jsonResponse(pagePayload(slice, { perPage: 2, count: items.length }));
    },
  });
  const reader = readerFor(h);
  const token = createCancellationSource().token;
  const first = await reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS });
  assert.notEqual(first.nextCursor, null);

  rejudged = true;
  const second = await reader.listSubmissions({
    account: ACCOUNT,
    cursor: first.nextCursor,
    limit: 2,
    token,
    limits: LIMITS,
  });
  assert.deepEqual(
    second.items.map((submission) => submission.externalId),
    ['8998', '8997'],
  );
  assert.equal(second.nextCursor, null, 'the declared total of four records was delivered');

  // The rejudged verdict is what a re-read of that page reports, so a later overlap sync updates
  // the stored verdict instead of keeping the old one.
  const afterRejudge = await reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 1, token, limits: LIMITS });
  assert.equal(afterRejudge.items[0]?.externalId, '9000');
  assert.equal(afterRejudge.items[0]?.verdict, 'wrong_answer');

  // A rewritten identity (same ids, different problem) does change the page fingerprint.
  let rewritten = false;
  const mutated = harness({
    '/record/list': (url: URL) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = items.slice((page - 1) * 2, page * 2).map((item) => ({ ...item }));
      if (rewritten && page === 1 && slice[0]) {
        slice[0].problem = { pid: 'P9999' };
      }
      return jsonResponse(pagePayload(slice, { perPage: 2, count: items.length }));
    },
  });
  const mutatedReader = readerFor(mutated);
  const start = await mutatedReader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 1, token, limits: LIMITS });
  assert.notEqual(start.nextCursor, null);
  rewritten = true;
  const drift = await rejectsWithCode(
    mutatedReader.listSubmissions({ account: ACCOUNT, cursor: start.nextCursor, limit: 1, token, limits: LIMITS }),
    'changed_response',
  );
  assert.match(String(drift.detail), /content of server page 1 changed/);
  assert.match(String(drift.detail), /restart the submission listing/);
});

// ---------------------------------------------------------------------------------------
// Cursor integrity and drift
// ---------------------------------------------------------------------------------------

test('replaying the same cursor is idempotent: identical items and identical continuation', async () => {
  const items = history(5);
  const h = harness({ '/record/list': pagedRoute(items, 2) });
  const reader = readerFor(h);
  const token = createCancellationSource().token;
  const first = await reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 1, token, limits: LIMITS });
  assert.notEqual(first.nextCursor, null);
  const replay = async () =>
    reader.listSubmissions({ account: ACCOUNT, cursor: first.nextCursor, limit: 2, token, limits: LIMITS });
  const a = await replay();
  const b = await replay();
  assert.deepEqual(
    a.items.map((submission) => submission.id),
    b.items.map((submission) => submission.id),
  );
  assert.deepEqual(
    a.items.map((submission) => submission.externalId),
    ['8999', '8998'],
  );
  assert.equal(a.nextCursor, b.nextCursor);
  assert.notEqual(a.nextCursor, null);
});

test('foreign, stale, tampered and inconsistent cursors are refused before any request', async () => {
  const items = history(4);
  const h = harness({ '/record/list': pagedRoute(items, 2) });
  const reader = readerFor(h);
  const token = createCancellationSource().token;
  const fingerprint = luoguRecordPageFingerprint(1, parseRecordPage(pagePayload(items.slice(0, 2)), UID));
  const base = {
    sourceInstanceId: SOURCE.id,
    accountId: ACCOUNT.id,
    handle: UID,
    since: null,
    page: 1,
    offset: 1,
    perPage: 2,
    count: 4,
    delivered: 1,
    boundaryId: '9000',
    pageFingerprint: fingerprint,
  };
  const raw = (payload: unknown): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const valid = encodeLuoguRecordCursor(base);
  const stripped = JSON.parse(Buffer.from(valid, 'base64url').toString('utf8')) as Record<string, unknown>;

  const rejected: readonly string[] = [
    'not-base64url!!',
    raw({ ...stripped, version: 2 }),
    raw({ ...stripped, sourceInstanceId: 'luogu:example.com' }),
    raw({ ...stripped, accountId: createLuoguAccount(SOURCE, OTHER_UID, null).id }),
    raw({ ...stripped, handle: OTHER_UID }),
    raw({ ...stripped, since: '2026-01-01T00:00:00.000Z' }),
    raw({ ...stripped, checksum: 'f'.repeat(64) }),
    raw({ ...stripped, page: 0 }),
    raw({ ...stripped, offset: 3, delivered: 3 }),
    raw({ ...stripped, offset: 0 }),
    raw({ ...stripped, pageFingerprint: 'not-a-fingerprint' }),
    raw({ ...stripped, delivered: 5 }),
  ];
  const requestsBefore = h.requests.length;
  for (const cursor of rejected) {
    await rejectsWithCode(
      reader.listSubmissions({ account: ACCOUNT, cursor, limit: 2, token, limits: LIMITS }),
      'invalid_input',
    );
  }
  assert.equal(h.requests.length, requestsBefore, 'cursor validation happens before the provider or any request');

  const scope = { sourceInstanceId: SOURCE.id, accountId: ACCOUNT.id, handle: UID, since: null };
  const decoded = decodeLuoguRecordCursor(valid, scope);
  assert.equal(decoded.offset, 1);
  assert.equal(decoded.boundaryId, '9000');
});

test('a moved boundary, a changed total and a shifted next page are safe restart errors', async () => {
  const token = createCancellationSource().token;
  const items = history(6);

  // A cursor whose stored boundary does not match the re-read page position.
  const stable = harness({ '/record/list': pagedRoute(items, 2) });
  const reader = readerFor(stable);
  const fingerprint = luoguRecordPageFingerprint(1, parseRecordPage(pagePayload(items.slice(0, 2)), UID));
  const crafted = encodeLuoguRecordCursor({
    sourceInstanceId: SOURCE.id,
    accountId: ACCOUNT.id,
    handle: UID,
    since: null,
    page: 1,
    offset: 2,
    perPage: 2,
    count: 6,
    delivered: 2,
    boundaryId: '8000',
    pageFingerprint: fingerprint,
  });
  const boundaryError = await rejectsWithCode(
    reader.listSubmissions({ account: ACCOUNT, cursor: crafted, limit: 2, token, limits: LIMITS }),
    'changed_response',
  );
  assert.match(String(boundaryError.detail), /boundary record moved/);

  // A page that declares a different total on resume.
  let changed = false;
  const counting = harness({
    '/record/list': (url: URL) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      const total = changed ? 5 : 6;
      return jsonResponse(pagePayload(items.slice((page - 1) * 2, page * 2), { perPage: 2, count: total }));
    },
  });
  const countingReader = readerFor(counting);
  const first = await countingReader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS });
  assert.notEqual(first.nextCursor, null);
  changed = true;
  const totalError = await rejectsWithCode(
    countingReader.listSubmissions({ account: ACCOUNT, cursor: first.nextCursor, limit: 2, token, limits: LIMITS }),
    'changed_response',
  );
  assert.match(String(totalError.detail), /declared record total changed/);

  // A next page whose first record is not older than the last delivered one (the boundary shifted
  // under the reader). The page still satisfies the declared size and total, so only the
  // continuity check can catch it — and it must, instead of re-delivering record 8999.
  const shifted = harness({
    '/record/list': (url: URL) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = page === 1 ? items.slice(0, 2) : [items[1]!, items[2]!];
      return jsonResponse(pagePayload(slice, { perPage: 2, count: 6 }));
    },
  });
  const shiftedReader = readerFor(shifted);
  const shiftedError = await rejectsWithCode(
    shiftedReader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 6, token, limits: LIMITS }),
    'changed_response',
  );
  assert.match(String(shiftedError.detail), /does not continue after record/);
});

// ---------------------------------------------------------------------------------------
// Account and record identity
// ---------------------------------------------------------------------------------------

test('the session must belong to the selected account and never leaks into an error', async () => {
  const items = history(2);
  const h = harness({ '/record/list': pagedRoute(items, 2) });
  const token = createCancellationSource().token;

  const cases: readonly LuoguSession[] = [
    { uid: OTHER_UID, cookie: COOKIE },
    { uid: UID, cookie: `__client_id=${OTHER_CLIENT_ID}; _uid=${OTHER_UID}; __session=${SESSION_SECRET}` },
    { uid: UID, cookie: `_uid=${UID}; __session=${SESSION_SECRET}` },
    { uid: UID, cookie: `${COOKIE}\r\nx-injected: 1` },
    // The raw control check runs before trimming: a leading or trailing CR/LF/TAB is refused too.
    { uid: UID, cookie: `${COOKIE}\r\n` },
    { uid: UID, cookie: `\n${COOKIE}` },
    { uid: UID, cookie: `\t${COOKIE}` },
    { uid: UID, cookie: `__client_id=${CLIENT_ID}; _uid=${OTHER_UID}` },
    { uid: UID, cookie: `${COOKIE}; __client_id=${OTHER_CLIENT_ID}` },
    { uid: UID, cookie: `__client_id=${CLIENT_ID}; _uid=` },
    { uid: UID, cookie: `__client_id=${CLIENT_ID}; _uid=00123` },
  ];
  for (const session of cases) {
    const reader = readerFor(h, sessionProvider(session));
    const error = await rejectsWithCode(
      reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS }),
      'invalid_input',
    );
    assertNoSecret(error);
  }
  assert.equal(h.requests.length, 0, 'a foreign or unusable session is refused before any request');

  // Copying the whole request-header line is accepted: an outer space or a `Cookie:` name is
  // unwrapped, never pasted into the outgoing header.
  for (const cookie of [` ${COOKIE} `, `Cookie: ${COOKIE}`, `cookie:${COOKIE}`]) {
    const page = await readerFor(h, sessionProvider({ uid: UID, cookie })).listSubmissions({
      account: ACCOUNT,
      cursor: null,
      limit: 2,
      token,
      limits: LIMITS,
    });
    assert.equal(page.items.length, 2);
  }
  assert.ok(h.requests.every((request) => request.init.headers.cookie === CANONICAL_COOKIE));

  const failedProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      throw new Error(`credential read failed for ${COOKIE}`);
    },
  };
  const requestsBefore = h.requests.length;
  const providerError = await rejectsWithCode(
    readerFor(h, failedProvider).listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS }),
    'unavailable',
  );
  assertNoSecret(providerError);
  assert.equal(h.requests.length, requestsBefore, 'a failing provider dispatches nothing');
});

test('__client_id is opaque: normalization keeps exactly two cookies and binds through _uid', () => {
  assert.notEqual(CLIENT_ID, UID, 'the fixture client id must not be the UID');
  // The domain normalizer mirrors the adapter's canonical UID pattern; keep the two identical.
  assert.equal(LUOGU_SESSION_UID_PATTERN.source, LUOGU_UID_PATTERN.source);

  const accepted: readonly (readonly [string, string])[] = [
    [COOKIE, CANONICAL_COOKIE],
    [`_uid=${UID}; __client_id=${CLIENT_ID}`, CANONICAL_COOKIE],
    [`__client_id=${'f'.repeat(64)}; _uid=${UID}`, `__client_id=${'f'.repeat(64)}; _uid=${UID}`],
    [`Cookie: ${COOKIE}`, CANONICAL_COOKIE],
    [`  ${COOKIE}  `, CANONICAL_COOKIE],
    // An unrelated segment without `=` is not a required name, so it is discarded like any other
    // unrelated cookie instead of making a whole-header paste unusable.
    [`__client_id=${CLIENT_ID}; _uid=${UID}; not-a-pair`, CANONICAL_COOKIE],
    [`__client_id=${CLIENT_ID}; _uid=${UID}; theme=dark; __cf_bm=abc`, CANONICAL_COOKIE],
  ];
  for (const [cookie, canonical] of accepted) {
    assert.equal(
      requireLuoguSessionCookie({ uid: UID, cookie }, UID),
      canonical,
      'an opaque __client_id different from the UID is a valid session',
    );
  }

  const rejected: readonly string[] = [
    `_uid=${UID}`,
    `__client_id=${CLIENT_ID}`,
    `__client_id=; _uid=${UID}`,
    `__client_id=${CLIENT_ID}; __client_id=${OTHER_CLIENT_ID}; _uid=${UID}`,
    `__client_id=${CLIENT_ID}; _uid=${UID}; _uid=${UID}`,
    `__client_id=${CLIENT_ID}; _uid=`,
    `__client_id=${CLIENT_ID}; _uid=${OTHER_UID}`,
    `__client_id=${CLIENT_ID}; _uid=00123`,
    `__client_id=has space; _uid=${UID}`,
    `__client_id=${'a'.repeat(257)}; _uid=${UID}`,
    `__client_id=${CLIENT_ID}\r\nx-injected: 1; _uid=${UID}`,
    `__client_id=${CLIENT_ID}; _uid=${UID};${'x'.repeat(16 * 1024)}`,
  ];
  for (const cookie of rejected) {
    let error: unknown = null;
    try {
      requireLuoguSessionCookie({ uid: UID, cookie }, UID);
    } catch (cause) {
      error = cause;
    }
    assert.notEqual(error, null, `the ambiguous or unusable cookie must be refused: ${cookie.slice(0, 40)}`);
    assert.equal(codeOf(error), 'invalid_input');
    assertNoSecret(error);
  }
  assert.throws(
    () => requireLuoguSessionCookie({ uid: OTHER_UID, cookie: `__client_id=${CLIENT_ID}; _uid=${UID}` }, UID),
    (error: unknown) => codeOf(error) === 'invalid_input',
  );
});

test('a leading or trailing CR/LF/TAB is refused before trimming, while outer spaces still unwrap', () => {
  const canonical = `__client_id=${CLIENT_ID}; _uid=${UID}`;
  // The control check runs on the ORIGINAL raw text, before `trim()`: a pasted header line that
  // starts or ends with a control character is injection-shaped input and must be refused instead
  // of being silently trimmed into a valid pair.
  for (const control of ['\n', '\r', '\r\n', '\t', '\u000b', '\u0000']) {
    for (const raw of [`${control}${canonical}`, `${canonical}${control}`, `${control}${canonical}${control}`]) {
      const normalized = normalizeLuoguSessionCookie(raw, UID);
      assert.equal(normalized.ok, false, `a ${JSON.stringify(control)} edge must be refused`);
      assert.equal(normalized.ok ? null : normalized.problem, 'unsafe_characters');
      const inspected = inspectLuoguSessionCookie(raw);
      assert.equal(inspected.ok, false);
      assert.equal(inspected.ok ? null : inspected.problem, 'unsafe_characters');
      assert.ok(!(normalized.ok ? '' : normalized.detail).includes(CLIENT_ID), 'a refusal never echoes the value');
    }
  }
  // A control character *inside* the pair stays refused exactly as before.
  const inside = normalizeLuoguSessionCookie(`__client_id=${CLIENT_ID};\n_uid=${UID}`, UID);
  assert.equal(inside.ok, false);
  assert.equal(inside.ok ? null : inside.problem, 'unsafe_characters');

  // Outer spaces and a `Cookie:` prefix remain accepted, and are still unwrapped to the pair.
  assert.equal(normalizeLuoguSessionCookie(`  ${canonical}  `, UID).ok, true);
  assert.equal(normalizeLuoguSessionCookie(`Cookie: ${canonical}`, UID).ok, true);
  assert.equal(normalizeLuoguSessionCookie(`  Cookie:  ${canonical}  `, UID).ok, true);

  // The two-field mode takes the client id verbatim, so a control character was never trimmed there.
  const fromValue = luoguSessionCookieFromClientId(`\t${CLIENT_ID}`, UID);
  assert.equal(fromValue.ok, false);
  assert.equal(fromValue.ok ? null : fromValue.problem, 'unsafe_characters');
});

test('a dispatched session carries exactly the two cookies of the record request', async () => {
  const h = harness({ '/record/list': pagedRoute(history(2), 2) });
  const cookie = `Cookie: __cf_bm=abc; _uid=${UID}; theme=dark; __client_id=${CLIENT_ID}; __session=${SESSION_SECRET}`;
  const page = await readerFor(h, sessionProvider({ uid: UID, cookie })).listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 2,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.equal(page.items.length, 2);
  assert.equal(h.requests.length, 1, 'one server page answers the two requested rows');
  assert.equal(h.requests[0]!.init.headers.cookie, CANONICAL_COOKIE);
  const sent = h.requests[0]!.init.headers.cookie ?? '';
  assert.equal(sent.includes(SESSION_SECRET), false, 'the unrelated secret never travels');
  assert.equal(sent.includes('__cf_bm'), false, 'an unrelated cookie is discarded');
  assert.equal(sent.includes('theme'), false, 'an unrelated cookie is discarded');
});

test('account, limit, since and record-identity validation all happen before or atomically with a page', async () => {
  const items = history(2);
  const h = harness({ '/record/list': pagedRoute(items, 2) });
  const reader = readerFor(h);
  const token = createCancellationSource().token;

  const nonNumeric = createAccount({ sourceInstanceId: SOURCE.id, handle: 'alice' });
  await rejectsWithCode(
    reader.listSubmissions({ account: nonNumeric, cursor: null, limit: 2, token, limits: LIMITS }),
    'invalid_input',
  );
  const nonCanonical = createAccount({ sourceInstanceId: SOURCE.id, handle: '00123' });
  await rejectsWithCode(
    reader.listSubmissions({ account: nonCanonical, cursor: null, limit: 2, token, limits: LIMITS }),
    'invalid_input',
  );
  const foreignSource = createSourceInstance({ platform: 'luogu', baseUrl: 'https://example.com' });
  const foreignAccount = createAccount({ sourceInstanceId: foreignSource.id, handle: UID });
  await rejectsWithCode(
    reader.listSubmissions({ account: foreignAccount, cursor: null, limit: 2, token, limits: LIMITS }),
    'invalid_input',
  );
  await rejectsWithCode(
    reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 0, token, limits: LIMITS }),
    'invalid_input',
  );
  await rejectsWithCode(
    reader.listSubmissions({
      account: ACCOUNT,
      cursor: null,
      limit: LUOGU_MAX_SUBMISSION_LIMIT + 1,
      token,
      limits: LIMITS,
    }),
    'invalid_input',
  );
  await rejectsWithCode(
    reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: { ...LIMITS, pageSize: 1 } }),
    'invalid_input',
  );
  await rejectsWithCode(
    reader.listSubmissions({
      account: ACCOUNT,
      cursor: null,
      limit: 2,
      token,
      limits: { ...LIMITS, pageSize: Number.NaN },
    }),
    'invalid_input',
  );
  await rejectsWithCode(
    reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS, since: 'yesterday' }),
    'invalid_input',
  );
  assert.equal(h.requests.length, 0);

  // An account mismatch exposed by the payload itself: page-level and record-level evidence.
  const foreignEnvelope = readerFor(
    harness({ '/record/list': () => jsonResponse(pagePayload(items, { uid: OTHER_UID })) }),
  );
  await rejectsWithCode(
    foreignEnvelope.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS }),
    'changed_response',
  );
  const [first, second] = items;
  const foreignRecord = readerFor(
    harness({
      '/record/list': () =>
        jsonResponse(pagePayload([{ ...first!, user: { uid: OTHER_UID } }, second!], { perPage: 2, count: 2 })),
    }),
  );
  const recordError = await rejectsWithCode(
    foreignRecord.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS }),
    'changed_response',
  );
  assert.match(String(recordError.detail), /unexpected authenticated response/);

  const shuffled = readerFor(
    harness({ '/record/list': () => jsonResponse(pagePayload([second!, first!], { perPage: 2, count: 2 })) }),
  );
  await rejectsWithCode(
    shuffled.listSubmissions({ account: ACCOUNT, cursor: null, limit: 2, token, limits: LIMITS }),
    'changed_response',
  );
});

// ---------------------------------------------------------------------------------------
// Record shape and verdict mapping
// ---------------------------------------------------------------------------------------

test('record shape is strict: ids, statuses, timestamps, pids and order', () => {
  const [first, second] = history(2);
  assert.notEqual(first, undefined);
  assert.notEqual(second, undefined);

  const bad: readonly (readonly [readonly Record<string, unknown>[], RegExp])[] = [
    [[{ ...first!, id: 0 }, second!], /\.id must be an integer/],
    [[{ ...first!, id: '9000' }, second!], /\.id must be an integer/],
    [[{ ...first!, status: '12' }, second!], /\.status must be an integer/],
    [[{ ...first!, status: 12.5 }, second!], /\.status must be an integer/],
    [[{ ...first!, submitTime: 0 }, second!], /\.submitTime must be an integer/],
    [[{ ...first!, submitTime: null }, second!], /\.submitTime must be an integer/],
    [[{ ...first!, submitTime: 1_700_000_000.5 }, second!], /\.submitTime must be an integer/],
    [[{ ...first!, submitTime: '1700000000' }, second!], /\.submitTime must be an integer/],
    [[{ ...first!, problem: { pid: 'not a pid' } }, second!], /must be an official Luogu problem id/],
    [[{ ...first!, problem: null }, second!], /\.problem must be a JSON object/],
    [[{ ...first!, user: { name: 'nobody' } }, second!], /exposes an identity without a uid/],
    [[{ ...first!, user: 42 }, second!], /\.user must be a JSON object/],
    [[second!, first!], /descending id order/],
    [[first!, { ...second!, id: first!.id }], /descending id order/],
    [[first!, { ...second!, submitTime: Number(first!.submitTime) + 60 }], /descending submitTime order/],
  ];
  for (const [entries, pattern] of bad) {
    assert.throws(() => parseEntries(entries), pattern);
  }
  assert.throws(
    () => parseRecordPage({ data: { currentData: { records: [first] } } }, UID),
    /data\.records must be a JSON object/,
  );
  assert.throws(
    () => parseRecordPage({ data: { records: { result: [first, second], perPage: 1 } } }, UID),
    /perPage is 1/,
  );

  const parsed = parseEntries([first!, second!]);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0]?.language, null, 'a numeric/absent language never becomes a name');
  const withLanguage = parseEntries([{ ...first!, language: 7 }, { ...second!, language: ' C++14 ' }]);
  assert.equal(withLanguage.records[0]?.language, null);
  assert.equal(withLanguage.records[1]?.language, 'C++14');
});

test('pending and unknown statuses stay unknown and never become accepted', () => {
  const statuses = [0, 1, 3, 8, 12, 99, -3, 2, 4, 5, 6, 7];
  const entries = statuses.map((status, index) =>
    record({ id: 500 - index, status, at: new Date((START_SECONDS - index * 60) * 1000).toISOString() }),
  );
  const parsed = parseEntries(entries);
  assert.deepEqual(
    parsed.records.map((entry) => entry.status),
    statuses,
  );
  assert.deepEqual(
    statuses.map((status) => luoguStatusVerdict(status)),
    [
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'accepted',
      'unknown',
      'unknown',
      'compile_error',
      'memory_limit_exceeded',
      'time_limit_exceeded',
      'wrong_answer',
      'runtime_error',
    ],
  );
  const accepted = parsed.records.filter((entry) => luoguStatusVerdict(entry.status) === 'accepted');
  assert.deepEqual(
    accepted.map((entry) => entry.status),
    [12],
  );
});

// ---------------------------------------------------------------------------------------
// Typed failures: auth, HTML, 403, 429, timeout, oversize, redirects, fetch rejection
// ---------------------------------------------------------------------------------------

test('authentication, HTML challenge, 403, 429 and malformed JSON stay typed and sample-free', async () => {
  const cases: readonly (readonly [() => Response, string, RegExp])[] = [
    [() => jsonResponse({}, 401), 'auth_required', /session is no longer valid/],
    [
      () => jsonResponse({ data: { errorCode: 401, errorType: 'UserUnloginException' } }),
      'auth_required',
      /session is no longer valid/,
    ],
    [() => jsonResponse({}, 403), 'forbidden', /refused the authenticated request/],
    [
      () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' } }),
      'rate_limited',
      /rate-limited the authenticated request/,
    ],
    [() => htmlResponse('<html><body>unexpected challenge</body></html>'), 'changed_response', /HTML page/],
    [
      () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      'changed_response',
      /not valid JSON/,
    ],
    [
      () => jsonResponse({ data: { records: { result: 'nope' } } }),
      'changed_response',
      /unexpected authenticated response/,
    ],
  ];
  for (const [route, code, pattern] of cases) {
    const reader = readerFor(harness({ '/record/list': route }));
    const error = await rejectsWithCode(
      reader.listSubmissions({
        account: ACCOUNT,
        cursor: null,
        limit: 10,
        token: createCancellationSource().token,
        limits: LIMITS,
      }),
      code,
    );
    assert.match(String(error.detail ?? ''), pattern);
    assert.equal(error.sample ?? null, null, 'authenticated reader failures never carry a response sample');
    assertNoSecret(error);
  }

  const limited = readerFor(
    harness({
      '/record/list': () =>
        new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' } }),
    }),
  );
  const limitedError = await rejectsWithCode(
    limited.listSubmissions({
      account: ACCOUNT,
      cursor: null,
      limit: 10,
      token: createCancellationSource().token,
      limits: LIMITS,
    }),
    'rate_limited',
  );
  assert.equal(limitedError.retryAfterMs, 3000);
});

test('a login redirect is auth_required and the session is never dispatched to it', async () => {
  for (const loginPath of ['/auth/login', '/login']) {
    const h = harness({
      '/record/list': () =>
        new Response('', { status: 302, headers: { location: loginPath, 'content-type': 'text/html' } }),
      [loginPath]: () => htmlResponse('<!doctype html><html><body>log in</body></html>'),
    });
    const error = await rejectsWithCode(
      readerFor(h).listSubmissions({
        account: ACCOUNT,
        cursor: null,
        limit: 10,
        token: createCancellationSource().token,
        limits: LIMITS,
      }),
      'auth_required',
    );
    assert.match(String(error.detail), /no longer valid/);
    assertNoSecret(error);
    assert.deepEqual(
      h.requests.map((request) => new URL(request.url).pathname),
      ['/record/list'],
      `the login path ${loginPath} is classified, never fetched with the session`,
    );
  }
});

test('a same-origin redirect outside the exact expected record target is refused before dispatch', async () => {
  const locations: readonly string[] = [
    '/record/list-v2',
    `/record/list?user=${OTHER_UID}&page=1`,
    `/record/list?user=${UID}&page=2`,
    `/record/list?user=${UID}&page=1&extra=1`,
    `/record/list?user=${UID}&page=01`,
  ];
  for (const location of locations) {
    const h = harness({ '/record/list': () => new Response('', { status: 302, headers: { location } }) });
    const error = await rejectsWithCode(
      readerFor(h).listSubmissions({
        account: ACCOUNT,
        cursor: null,
        limit: 2,
        token: createCancellationSource().token,
        limits: LIMITS,
      }),
      'unavailable',
    );
    assertNoSecret(error);
    assert.equal(h.requests.length, 1, `no request is dispatched to ${location}`);
    assert.equal(new URL(h.requests[0]!.url).pathname, '/record/list');
  }
});

test('the authenticated fetch dispatches only the exact expected record target of one account', async () => {
  const dispatched: string[] = [];
  const inner: FetchLike = async (url) => {
    dispatched.push(url);
    return jsonResponse({ data: { records: { result: [] } } });
  };
  const guarded = createAuthenticatedLuoguFetch({
    cookie: () => COOKIE,
    expectedUid: UID,
    expectedTarget: () => ({ kind: 'record', page: 2 }),
    fetchImpl: inner,
  });
  const init: FetchInitLike = {
    method: 'GET',
    headers: {},
    redirect: 'manual',
    credentials: 'omit',
    signal: new AbortController().signal,
  };
  const exact = `https://www.luogu.com.cn/record/list?user=${UID}&page=2`;

  const accepted = await guarded(exact, init);
  assert.equal(accepted.status, 200);
  assert.deepEqual(dispatched, [exact]);

  const refused: readonly (readonly [string, string])[] = [
    [`https://www.luogu.com.cn/auth/login?user=${UID}&page=2`, 'auth_required'],
    ['https://www.luogu.com.cn/login', 'auth_required'],
    [`https://www.luogu.com.cn/record/list-v2?user=${UID}&page=2`, 'unavailable'],
    [`https://www.luogu.com.cn/record/list?user=${OTHER_UID}&page=2`, 'unavailable'],
    [`https://www.luogu.com.cn/record/list?user=${UID}&page=3`, 'unavailable'],
    [`https://www.luogu.com.cn/record/list?user=${UID}&page=2&extra=1`, 'unavailable'],
    [`https://www.luogu.com.cn/record/list?user=${UID}&page=02`, 'unavailable'],
    [`https://www.luogu.com.cn/record/list?user=${UID}&page=2#fragment`, 'unavailable'],
    [`https://evil.example/record/list?user=${UID}&page=2`, 'unavailable'],
    [`https://www.luogu.com.cn:8443/record/list?user=${UID}&page=2`, 'unavailable'],
    [`https://user:pass@www.luogu.com.cn/record/list?user=${UID}&page=2`, 'unavailable'],
  ];
  for (const [url, code] of refused) {
    const error = await rejectsWithCode(guarded(url, init), code);
    assertNoSecret(error);
  }
  assert.deepEqual(dispatched, [exact], 'only the exact expected target is ever dispatched');

  const unbound = createAuthenticatedLuoguFetch({
    cookie: () => null,
    expectedUid: UID,
    expectedTarget: () => ({ kind: 'record', page: 2 }),
    fetchImpl: inner,
  });
  await rejectsWithCode(unbound(exact, init), 'invalid_input');
  assert.deepEqual(dispatched, [exact]);
});

test('a cross-origin redirect is refused before the session could be sent elsewhere', async () => {
  const h = harness({
    '/record/list': () => new Response('', { status: 302, headers: { location: 'https://evil.example/record/list' } }),
  });
  const reader = readerFor(h);
  const error = await rejectsWithCode(
    reader.listSubmissions({
      account: ACCOUNT,
      cursor: null,
      limit: 10,
      token: createCancellationSource().token,
      limits: LIMITS,
    }),
    'unavailable',
  );
  assert.match(String(error.detail), /authenticated Luogu request failed/);
  assertNoSecret(error);
  assert.equal(h.requests.length, 1);
  assert.ok(h.requests.every((request) => request.url.startsWith('https://www.luogu.com.cn/')));
});

test('a timeout and an oversized body are typed failures, never a partial page', async () => {
  const hanging = harness({ '/record/list': hangUntilAbort });
  const timingOut = readerFor(hanging);
  const pending = timingOut.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: { ...LIMITS, requestTimeoutMs: 50 },
  });
  await tick();
  await tick();
  hanging.fireTimers();
  const timeout = await rejectsWithCode(pending, 'unavailable');
  assert.match(String(timeout.detail), /authenticated Luogu request failed/);
  assertNoSecret(timeout);
  assert.equal(hanging.requests.length, 1, 'the request was dispatched and then timed out, never answered');

  const oversize = readerFor(
    harness({ '/record/list': () => jsonResponse(pagePayload(history(50), { perPage: 50, count: 50 })) }),
    sessionProvider(),
    { maxResponseBytes: 1024 },
  );
  const oversizeError = await rejectsWithCode(
    oversize.listSubmissions({
      account: ACCOUNT,
      cursor: null,
      limit: 10,
      token: createCancellationSource().token,
      limits: LIMITS,
    }),
    'changed_response',
  );
  assert.match(String(oversizeError.detail), /unexpected authenticated response/);
  assertNoSecret(oversizeError);
});

test('a transient fetch rejection is retried under the configured budget and stays sanitized', async () => {
  const items = history(2);
  let attempts = 0;
  const transient = harness({
    '/record/list': () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError(`socket failed while sending cookie ${COOKIE}`);
      }
      return jsonResponse(pagePayload(items, { perPage: 2, count: 2 }));
    },
  });
  const page = await readerFor(transient).listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: { ...LIMITS, maxRetries: 1 },
  });
  assert.deepEqual(
    page.items.map((submission) => submission.externalId),
    ['9000', '8999'],
  );
  assert.equal(transient.requests.length, 2, 'the transient rejection was retried exactly once');
  assert.deepEqual(transient.waits, [2000], 'the authenticated pacing floor spaces the retry');
  for (const request of transient.requests) {
    assert.equal(request.init.headers.cookie, CANONICAL_COOKIE, 'the retry re-attaches the normalized session');
    assert.equal(request.url.includes(SESSION_SECRET), false, 'the session never enters the target');
  }

  const persistent = harness({
    '/record/list': () => {
      throw new TypeError(`socket failed while sending cookie ${COOKIE}`);
    },
  });
  const error = await rejectsWithCode(scanOnce(readerFor(persistent)), 'unavailable');
  assert.equal(error.retryable, true, 'a network failure stays retryable for automatic sync');
  assert.equal(persistent.requests.length, 1, 'a zero retry budget dispatches exactly once');
  assertNoSecret(error);
});

test('a mid-body disconnect is retried under the configured budget and stays sanitized', async () => {
  const items = history(2);
  let attempts = 0;
  const transient = harness({
    '/record/list': () => {
      attempts += 1;
      if (attempts === 1) {
        return disconnectingBodyResponse('{"data":{"records":{"result":[', `connection lost while sending ${COOKIE}`);
      }
      return jsonResponse(pagePayload(items, { perPage: 2, count: 2 }));
    },
  });
  const page = await readerFor(transient).listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: { ...LIMITS, maxRetries: 1 },
  });
  assert.deepEqual(
    page.items.map((submission) => submission.externalId),
    ['9000', '8999'],
  );
  assert.equal(transient.requests.length, 2, 'the interrupted body was re-requested');
  assert.deepEqual(transient.waits, [2000], 'the retry is paced by the authenticated floor');

  const persistent = harness({
    '/record/list': () => disconnectingBodyResponse('{"data":', `connection lost while sending ${COOKIE}`),
  });
  const error = await rejectsWithCode(scanOnce(readerFor(persistent)), 'unavailable');
  assert.equal(error.retryable, true, 'a body disconnect is transient for automatic sync');
  assert.equal(error.sample ?? null, null);
  assertNoSecret(error);
});

test('forged typed failures are allowlisted before rebuilding, so unknown codes cannot leak', async () => {
  const quiet = harness({ '/record/list': () => jsonResponse(pagePayload([])) });
  const providerCode = `code-${SESSION_SECRET}`;

  // Provider boundary: a cast PlatformError with an unknown code and a non-boolean `retryable`.
  const forgedProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      throw forgedPlatformError({
        code: providerCode,
        retryable: 'yes',
        retryAfterMs: -5,
        detail: `provider detail quoting ${COOKIE}`,
        sample: COOKIE,
        message: `forged message quoting ${COOKIE}`,
      });
    },
  };
  const providerFailure = await rejectsWithCode(scanOnce(readerFor(quiet, forgedProvider)), 'unavailable');
  assert.equal(providerFailure.retryable, false, 'an unusable credential-provider failure is terminal');
  assert.equal(providerFailure.retryAfterMs, null, 'a negative delay is dropped');
  assert.equal(providerFailure.sample ?? null, null);
  assert.equal(errorText(providerFailure).includes(providerCode), false);
  assert.equal(JSON.stringify(providerFailure).includes(providerCode), false);
  assert.equal(JSON.stringify(providerFailure).includes(COOKIE), false);
  assertNoSecret(providerFailure);
  assert.equal(quiet.requests.length, 0);

  // Fetch boundary: the same forgery crosses transient IO, so the retryable discriminant remains.
  const forgedFetch = harness({
    '/record/list': () => {
      throw forgedPlatformError({
        code: `fetch-${SESSION_SECRET}`,
        retryable: true,
        retryAfterMs: 2_500.4,
        detail: `fetch detail quoting ${COOKIE}`,
        sample: COOKIE,
        message: `forged fetch message quoting ${COOKIE}`,
      });
    },
  });
  const fetchFailure = await rejectsWithCode(scanOnce(readerFor(forgedFetch)), 'unavailable');
  assert.equal(fetchFailure.retryable, true, 'the fetch fallback stays eligible for retries');
  assert.equal(fetchFailure.retryAfterMs, 2500, 'a finite non-negative delay survives, normalized');
  assert.equal(fetchFailure.sample ?? null, null);
  assertNoSecret(fetchFailure);
  assert.equal(forgedFetch.requests.length, 1);

  // A known code with a non-boolean `retryable` is refused as well, never forwarded.
  const mixedProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      throw forgedPlatformError({ code: 'forbidden', retryable: 'no', detail: `mixed ${COOKIE}` });
    },
  };
  const mixedFailure = await rejectsWithCode(scanOnce(readerFor(quiet, mixedProvider)), 'unavailable');
  assert.equal(mixedFailure.retryable, false);
  assertNoSecret(mixedFailure);

  // A forged cancellation still keeps the cancellation discriminant and its fixed message.
  const forgedCancel: LuoguSessionProvider = {
    sessionFor: async () => {
      throw forgedPlatformError({ code: 'cancelled', retryable: false, message: `cancelled ${COOKIE}` });
    },
  };
  const cancelFailure = await rejectsWithCode(scanOnce(readerFor(quiet, forgedCancel)), 'cancelled');
  assertNoSecret(cancelFailure);
});

test('typed failures from the provider, fetch, body stream and payload are rebuilt without secrets', async () => {
  const items = history(2);
  const quiet = harness({ '/record/list': pagedRoute(items, 2) });

  // A typed provider error keeps its validated code and retry metadata, never its text.
  const typedProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      throw new PlatformError({
        code: 'rate_limited',
        operation: 'submissions',
        retryable: true,
        retryAfterMs: 4000,
        detail: `provider detail quoting ${COOKIE}`,
        sample: SESSION_SECRET,
      });
    },
  };
  const providerFailure = await rejectsWithCode(scanOnce(readerFor(quiet, typedProvider)), 'rate_limited');
  assert.equal(providerFailure.retryable, true);
  assert.equal(providerFailure.retryAfterMs, 4000);
  assert.equal(providerFailure.sample ?? null, null);
  assertNoSecret(providerFailure);
  assert.equal(quiet.requests.length, 0);

  // A non-cancellation DomainError becomes a fixed unavailable; cancelled keeps its discriminant.
  const domainProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      throw new DomainError('invalid_input', `provider detail quoting ${COOKIE}`);
    },
  };
  const domainFailure = await rejectsWithCode(scanOnce(readerFor(quiet, domainProvider)), 'unavailable');
  assertNoSecret(domainFailure);

  const cancelledProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      throw new DomainError('cancelled', `cancelled because of ${COOKIE}`);
    },
  };
  const cancelledError = await rejectsWithCode(scanOnce(readerFor(quiet, cancelledProvider)), 'cancelled');
  assertNoSecret(cancelledError);
  assert.equal(quiet.requests.length, 0);

  // A typed fetch rejection is rebuilt at the authenticated boundary.
  const typedFetch = harness({
    '/record/list': () => {
      throw new PlatformError({
        code: 'forbidden',
        operation: 'submissions',
        retryable: false,
        detail: `fetch rejected while sending ${COOKIE}`,
        sample: SESSION_SECRET,
      });
    },
  });
  const fetchFailure = await rejectsWithCode(scanOnce(readerFor(typedFetch)), 'forbidden');
  assert.equal(fetchFailure.sample ?? null, null);
  assertNoSecret(fetchFailure);
  assert.ok(typedFetch.requests.length >= 1);

  // A body-stream read failure never reaches the shared transport's message echoing.
  const streamFailure = harness({
    '/record/list': () => erroringBodyResponse(`stream read failed while sending ${COOKIE}`),
  });
  const bodyFailure = await rejectsWithCode(scanOnce(readerFor(streamFailure)), 'unavailable');
  assert.equal(bodyFailure.retryable, true);
  assert.equal(bodyFailure.sample ?? null, null);
  assertNoSecret(bodyFailure);

  // A payload `errorType` that quotes the session never reaches the surfaced error.
  const errorType = harness({
    '/record/list': () => jsonResponse({ data: { errorCode: 401, errorType: `secret ${COOKIE}` } }),
  });
  const parserFailure = await rejectsWithCode(scanOnce(readerFor(errorType)), 'auth_required');
  assert.equal(parserFailure.sample ?? null, null);
  assertNoSecret(parserFailure);
});

// ---------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------

test('cancellation is observed before dispatch, during IO and after the session resolves', async () => {
  const hanging = harness({ '/record/list': hangUntilAbort });
  const reader = readerFor(hanging);
  const pre = createCancellationSource();
  pre.cancel('before start');
  await rejectsWithCode(
    reader.listSubmissions({ account: ACCOUNT, cursor: null, limit: 10, token: pre.token, limits: LIMITS }),
    'cancelled',
  );
  assert.equal(hanging.requests.length, 0);

  const during = createCancellationSource();
  const pending = reader.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: during.token,
    limits: LIMITS,
  });
  await tick();
  during.cancel('mid flight');
  await rejectsWithCode(pending, 'cancelled');

  const afterSession = createCancellationSource();
  const cancellingProvider: LuoguSessionProvider = {
    sessionFor: async () => {
      afterSession.cancel('cancelled while the session resolved');
      return SESSION;
    },
  };
  const quiet = harness({ '/record/list': () => jsonResponse(pagePayload([])) });
  await rejectsWithCode(
    readerFor(quiet, cancellingProvider).listSubmissions({
      account: ACCOUNT,
      cursor: null,
      limit: 10,
      token: afterSession.token,
      limits: LIMITS,
    }),
    'cancelled',
  );
  assert.equal(quiet.requests.length, 0);
});

// ---------------------------------------------------------------------------------------
// Single-owner session binding
// ---------------------------------------------------------------------------------------

test('an overlapping same-account scan is refused before credentials and cannot disturb the active cookie', async () => {
  const items = history(5);
  let releasePageTwo: (() => void) | undefined;
  let providerCalls = 0;
  const sessions: LuoguSessionProvider = {
    sessionFor: async () => {
      providerCalls += 1;
      return SESSION;
    },
  };
  const h = harness({
    '/record/list': async (url: URL) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page === 2) {
        await new Promise<void>((resolve) => {
          releasePageTwo = resolve;
        });
      }
      return jsonResponse(pagePayload(items.slice((page - 1) * 2, page * 2), { perPage: 2, count: items.length }));
    },
  });
  const reader = readerFor(h, sessions);
  const active = reader.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 6,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  for (let attempt = 0; attempt < 20 && releasePageTwo === undefined; attempt += 1) {
    await tick();
  }
  const release = releasePageTwo;
  assert.ok(release !== undefined, 'the owning scan has a second page request in flight');

  const overlap = await rejectsWithCode(
    reader.listSubmissions({
      account: ACCOUNT,
      cursor: null,
      limit: 1,
      token: createCancellationSource().token,
      limits: LIMITS,
    }),
    'unavailable',
  );
  assert.match(String(overlap.detail), /already running/);
  assert.equal(providerCalls, 1, 'the overlapping call never resolves credentials');
  assert.equal(h.requests.length, 2, 'the overlapping call dispatches nothing');

  // Releasing the owning call's page proves the rejected overlap neither swapped nor cleared the
  // active cookie: every later request of that call still carries it.
  release();
  const page = await active;
  assert.deepEqual(
    page.items.map((submission) => submission.externalId),
    ['9000', '8999', '8998', '8997', '8996'],
  );
  assert.equal(page.nextCursor, null);
  assert.ok(h.requests.length >= 3, 'the owning scan continued past the rejected overlap');
  assert.ok(h.requests.every((request) => request.init.headers.cookie === CANONICAL_COOKIE));
});

test('a cancelled and a failed scan both release the account slot and their session', async () => {
  const items = history(3);
  const h = harness({
    '/record/list': (url: URL, init: FetchInitLike) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page === 2) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true });
        });
      }
      return jsonResponse(pagePayload(items.slice(0, 2), { perPage: 2, count: items.length }));
    },
  });
  let cookieValue = COOKIE;
  const sessions: LuoguSessionProvider = { sessionFor: async () => ({ uid: UID, cookie: cookieValue }) };
  const reader = readerFor(h, sessions);

  const source = createCancellationSource();
  const pending = reader.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: source.token,
    limits: LIMITS,
  });
  for (let attempt = 0; attempt < 20 && h.requests.length < 2; attempt += 1) {
    await tick();
  }
  assert.equal(h.requests.length, 2, 'the hanging second page request was dispatched');
  source.cancel('stop mid scan');
  await rejectsWithCode(pending, 'cancelled');

  const freshClientId = 'fresh-client-id-0123456789';
  cookieValue = `__client_id=${freshClientId}; _uid=${UID}; __session=fresh-${SESSION_SECRET}`;
  const resumed = await reader.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 2,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.deepEqual(
    resumed.items.map((submission) => submission.externalId),
    ['9000', '8999'],
  );
  assert.equal(
    h.requests[h.requests.length - 1]!.init.headers.cookie,
    `__client_id=${freshClientId}; _uid=${UID}`,
    'the next call binds its own session',
  );

  // An error path releases the slot too: the later identical call is not mistaken for an overlap.
  const failing = harness({ '/record/list': () => jsonResponse({}, 403) });
  const failingReader = readerFor(failing, sessionProvider());
  await rejectsWithCode(scanOnce(failingReader), 'forbidden');
  await rejectsWithCode(scanOnce(failingReader), 'forbidden');
  assert.equal(failing.requests.length, 2);
});

// ---------------------------------------------------------------------------------------
// Adapter integration and honest capabilities
// ---------------------------------------------------------------------------------------

test('a plain adapter stays honestly unavailable while an injected reader flips the capability', async () => {
  const plain = createLuoguAdapter({ sourceInstance: SOURCE });
  const capabilities = plain.capabilities();
  assert.equal(capabilities.submissions, false);
  assert.equal(capabilities.pagedSubmissions, false);
  assert.equal(capabilities.supportsAccountHistory, false);

  const h = harness({ '/record/list': pagedRoute(history(3), 3) });
  const reader = readerFor(h);
  const composed = createLuoguAdapter({ sourceInstance: SOURCE, sessionReader: reader });
  const composedCapabilities = composed.capabilities();
  assert.equal(composedCapabilities.submissions, true);
  assert.equal(composedCapabilities.pagedSubmissions, true);
  assert.equal(composedCapabilities.supportsAccountHistory, true);
  assert.match(composedCapabilities.notes.join(' '), /has not been verified against a live authenticated response/);

  const page = await composed.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 3,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.deepEqual(
    page.items.map((submission) => submission.externalId),
    ['9000', '8999', '8998'],
  );
  assert.equal(h.requests.length, 1);

  assert.throws(
    () => new LuoguAdapter({ sourceInstance: SOURCE, sessionReader: {} as unknown as LuoguSessionReader }),
    (error: unknown) => codeOf(error) === 'invalid_input',
  );

  const foreignInstance = createSourceInstance({ platform: 'luogu', baseUrl: 'https://example.com' });
  assert.throws(
    () => createLuoguSessionReader({ sourceInstance: foreignInstance, sessions: sessionProvider() }),
    (error: unknown) => codeOf(error) === 'invalid_input',
  );
  assert.throws(
    () => requireLuoguInstance({ ...SOURCE, domain: 'example.com' }, 'submissions'),
    (error: unknown) => codeOf(error) === 'invalid_input',
  );
});

test('the composed adapter delegates to the reader and re-checks cancellation after it settles', async () => {
  const calls: string[] = [];
  const source = createCancellationSource();
  const cancelling: LuoguSessionReader = {
    listSubmissions: async () => {
      calls.push('cancelling');
      source.cancel('cancelled while the reader settled');
      return { items: [], nextCursor: null, fetchedAt: AT };
    },
    fetchEditorial: async () => {
      throw new Error('unexpected fetchEditorial');
    },
  };
  const adapter = createLuoguAdapter({ sourceInstance: SOURCE, sessionReader: cancelling });
  await rejectsWithCode(
    adapter.listSubmissions({ account: ACCOUNT, cursor: null, limit: 10, token: source.token, limits: LIMITS }),
    'cancelled',
  );

  const delegating: LuoguSessionReader = {
    listSubmissions: async (request) => {
      calls.push(request.cursor ?? 'first');
      return { items: [], nextCursor: 'next', fetchedAt: AT };
    },
    fetchEditorial: async () => {
      throw new Error('unexpected fetchEditorial');
    },
  };
  const okAdapter = createLuoguAdapter({ sourceInstance: SOURCE, sessionReader: delegating });
  const page = await okAdapter.listSubmissions({
    account: ACCOUNT,
    cursor: null,
    limit: 10,
    token: createCancellationSource().token,
    limits: LIMITS,
  });
  assert.equal(page.nextCursor, 'next');
  assert.deepEqual(calls, ['cancelling', 'first']);
});
