/**
 * Codeforces adapter tests: catalog paging and cursor scopes, direct statement fetch, submission
 * normalization/paging/boundary drift, and editorial discovery and section extraction. Every
 * response is a synthetic in-process payload; no network is used. Two optional checks read the
 * private captured public payloads under `.local/` and publish only derived counts, never bodies.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CodeforcesAdapter,
  CURSOR_VERSION,
  codeforcesSourceInstance,
  createCodeforcesAdapter,
  decodeCursor,
  encodeCursor,
  memoryBytesToKib,
  parseCfProblemKey,
  requireCatalogCursor,
} from '../../src/adapters/codeforces/index.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformLimits } from '../../src/application/ports.js';
import { isPlatformError } from '../../src/application/platform-errors.js';
import { HttpTransport } from '../../src/adapters/platform/http.js';
import { createAccount, createCancellationSource, createSourceInstance, numericRating } from '../../src/domain/index.js';
import {
  ambiguousBlogHtml,
  blogContentHtml,
  blogEntryPayload,
  catalogPayload,
  catalogProblem,
  challengeHtml,
  cfSubmissionItem,
  createHttpHarness,
  defaultCatalog,
  defaultSubmissions,
  failedBlogEntryPayload,
  failedUserStatusPayload,
  htmlResponse,
  jsonResponse,
  layoutChangedHtml,
  missingSectionBlogHtml,
  problemPageHtml,
  statusSlice,
} from './fixtures.js';

const instance = codeforcesSourceInstance();
const limits: PlatformLimits = { ...DEFAULT_PLATFORM_LIMITS, maxRetries: 0 };

function token() {
  return createCancellationSource().token;
}

function ref(externalKey: string, domain: string | null = null) {
  return { sourceInstanceId: instance.id, domain, externalKey };
}

function expectInvalid(error: unknown): boolean {
  return isPlatformError(error) && error.code === 'invalid_input';
}

function expectCancelled(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'cancelled';
}

/** A cursor token built by hand, for legacy/malformed-token regressions. */
function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Private captured public payloads: read at runtime, never copied into the repository. */
const CAPTURED_CATALOG = new URL('../../.local/cf-api.response', import.meta.url);
const CAPTURED_RECORDS = new URL('../../.local/cf-records.response', import.meta.url);

test('the catalog pages locally, keeps raw ratings/tags and leaves statements absent', async () => {
  const harness = createHttpHarness({ routes: { '/api/problemset.problems': () => jsonResponse(defaultCatalog()) } });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });

  const first = await adapter.listProblems({ cursor: null, limit: 2, token: token(), limits });
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0]?.statement, null);
  assert.equal(numericRating(first.items[0]!, 'rating'), 800);
  assert.deepEqual(
    first.items[0]?.rawTags.map((tag) => tag.raw),
    ['math', 'brute force'],
  );
  assert.equal(first.items[0]?.url, 'https://codeforces.com/problemset/problem/1234/A');
  assert.equal(numericRating(first.items[1]!, 'rating'), 2400);
  assert.ok(first.nextCursor);
  assert.equal(harness.requests.length, 1);

  const second = await adapter.listProblems({ cursor: first.nextCursor, limit: 2, token: token(), limits });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]?.title, 'No Rating Here');
  assert.equal(second.items[0]?.ratings.length, 0);
  assert.deepEqual(
    second.items[0]?.rawTags.map((tag) => tag.raw),
    ['unknown tag'],
  );
  assert.equal(second.nextCursor, null);
  // The catalog snapshot is cached, so resuming a page does not re-fetch it.
  assert.equal(harness.requests.length, 1);
});

test('catalog cursors carry their scope and a foreign or out-of-range cursor is rejected', async () => {
  const harness = createHttpHarness({ routes: { '/api/problemset.problems': () => jsonResponse(defaultCatalog()) } });
  const adapter = new CodeforcesAdapter({ transport: harness.transport });
  const alice = adapter.account('Alice');
  const bob = adapter.account('Bob');
  const page = await adapter.listProblems({ cursor: null, limit: 1, token: token(), limits, account: alice });
  const nextCursor = page.nextCursor;
  assert.ok(nextCursor);

  await assert.rejects(
    adapter.listProblems({ cursor: nextCursor, limit: 1, token: token(), limits, account: bob }),
    expectInvalid,
  );

  const decoded = requireCatalogCursor(decodeCursor(nextCursor), {
    sourceInstanceId: instance.id,
    accountId: alice.id,
  });
  await assert.rejects(
    adapter.listProblems({
      cursor: encodeCursor({ ...decoded, sourceInstanceId: 'codeforces:mirror.example' }),
      limit: 1,
      token: token(),
      limits,
      account: alice,
    }),
    expectInvalid,
  );
  await assert.rejects(
    adapter.listProblems({ cursor: encodeCursor({ ...decoded, offset: 99 }), limit: 1, token: token(), limits, account: alice }),
    expectInvalid,
  );
});

test('a cursor issued against a changed catalog is refused instead of skipping records', async () => {
  const first = createHttpHarness({ routes: { '/api/problemset.problems': () => jsonResponse(defaultCatalog()) } });
  const firstAdapter = createCodeforcesAdapter({ transport: first.transport });
  const page = await firstAdapter.listProblems({ cursor: null, limit: 1, token: token(), limits });
  const nextCursor = page.nextCursor;
  assert.ok(nextCursor);

  const changed = createHttpHarness({
    routes: {
      '/api/problemset.problems': () =>
        jsonResponse(
          catalogPayload([
            { contestId: 2000, index: 'A', name: 'Inserted first', rating: 1500, tags: ['new'] },
            { contestId: 1234, index: 'A', name: 'Watermelon', rating: 800, tags: ['math', 'brute force'] },
            { contestId: 1234, index: 'B', name: 'Two Buttons', rating: 2400, tags: ['dp', 'trees'] },
          ]),
        ),
    },
  });
  const restarted = createCodeforcesAdapter({ transport: changed.transport });
  await assert.rejects(
    restarted.listProblems({ cursor: nextCursor, limit: 1, token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'changed_response' && /restart from the first page/.test(error.detail),
  );
});

test('the CF account factory canonicalizes handle case and coherence is checked', async () => {
  const adapter = new CodeforcesAdapter({ transport: createHttpHarness({ routes: {} }).transport });
  const account = adapter.account('Tourist');
  assert.equal(account.handle, 'tourist');
  assert.equal(account.displayName, 'Tourist');
  assert.equal(account.profileUrl, 'https://codeforces.com/profile/tourist');

  const harness = createHttpHarness({ routes: { '/api/user.status': (url) => statusSlice([], url) } });
  const scoped = createCodeforcesAdapter({ transport: harness.transport });
  const notCanonical = createAccount({ sourceInstanceId: instance.id, handle: 'Tourist' });
  await assert.rejects(
    scoped.listSubmissions({ account: notCanonical, cursor: null, limit: 5, token: token(), limits }),
    expectInvalid,
  );
  const otherInstance = createAccount({ sourceInstanceId: 'codeforces:mirror.example', handle: 'alice' });
  await assert.rejects(
    scoped.listSubmissions({ account: otherInstance, cursor: null, limit: 5, token: token(), limits }),
    expectInvalid,
  );
  assert.equal(harness.requests.length, 0);
});

test('submissions page with a verified boundary and normalizes verdict, memory and time', async () => {
  const items = defaultSubmissions();
  const harness = createHttpHarness({ routes: { '/api/user.status': (url) => statusSlice(items, url) } });
  const adapter = new CodeforcesAdapter({ transport: harness.transport });
  const account = adapter.account('alice');

  const first = await adapter.listSubmissions({ account, cursor: null, limit: 2, token: token(), limits });
  assert.deepEqual(
    first.items.map((submission) => submission.externalId),
    ['40', '39'],
  );
  assert.equal(first.items[0]?.verdict, 'accepted');
  assert.equal(first.items[0]?.memoryKb, 256);
  assert.equal(first.items[0]?.timeMs, 0);
  assert.equal(first.items[0]?.language, 'GNU G++17');
  assert.equal(first.items[1]?.verdict, 'unknown');
  assert.equal(first.items[1]?.memoryKb, 1);
  assert.ok(first.nextCursor);

  const second = await adapter.listSubmissions({ account, cursor: first.nextCursor, limit: 2, token: token(), limits });
  assert.deepEqual(
    second.items.map((submission) => submission.externalId),
    ['38', '37'],
  );
  assert.equal(second.items[0]?.verdict, 'wrong_answer');
  assert.equal(second.items[0]?.memoryKb, 0);
  assert.ok(second.nextCursor);

  const third = await adapter.listSubmissions({ account, cursor: second.nextCursor, limit: 2, token: token(), limits });
  assert.deepEqual(
    third.items.map((submission) => submission.externalId),
    ['36'],
  );
  assert.equal(third.items[0]?.verdict, 'runtime_error');
  assert.equal(third.items[0]?.memoryKb, null);
  assert.equal(third.nextCursor, null);
});

test('resuming a submission cursor detects offset drift from a new submission', async () => {
  const items = defaultSubmissions();
  const stable = createHttpHarness({ routes: { '/api/user.status': (url) => statusSlice(items, url) } });
  const stableAdapter = new CodeforcesAdapter({ transport: stable.transport });
  const account = stableAdapter.account('alice');
  const first = await stableAdapter.listSubmissions({ account, cursor: null, limit: 2, token: token(), limits });
  assert.ok(first.nextCursor);

  const drifted = createHttpHarness({
    routes: {
      '/api/user.status': (url) =>
        statusSlice([cfSubmissionItem({ id: 41, at: '2026-09-11T11:00:00.000Z', verdict: 'OK' }), ...items], url),
    },
  });
  const driftAdapter = new CodeforcesAdapter({ transport: drifted.transport });
  const driftAccount = driftAdapter.account('alice');
  await assert.rejects(
    driftAdapter.listSubmissions({ account: driftAccount, cursor: first.nextCursor, limit: 2, token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'changed_response' && /restart from the first page/.test(error.detail),
  );

  const foreign = createHttpHarness({ routes: { '/api/user.status': (url) => statusSlice(items, url) } });
  const foreignAdapter = new CodeforcesAdapter({ transport: foreign.transport });
  await assert.rejects(
    foreignAdapter.listSubmissions({
      account: foreignAdapter.account('bob'),
      cursor: first.nextCursor,
      limit: 2,
      token: token(),
      limits,
    }),
    expectInvalid,
  );
});

test('since is validated as ISO and applied inclusively', async () => {
  const items = defaultSubmissions();
  const harness = createHttpHarness({ routes: { '/api/user.status': (url) => statusSlice(items, url) } });
  const adapter = new CodeforcesAdapter({ transport: harness.transport });
  const account = adapter.account('alice');
  const page = await adapter.listSubmissions({
    account,
    cursor: null,
    limit: 5,
    since: '2026-09-09T10:00:00.000Z',
    token: token(),
    limits,
  });
  assert.deepEqual(
    page.items.map((submission) => submission.externalId),
    ['40', '39', '38'],
  );
  assert.equal(page.nextCursor, null);

  await assert.rejects(
    adapter.listSubmissions({ account, cursor: null, limit: 5, since: 'yesterday', token: token(), limits }),
    expectInvalid,
  );
  assert.equal(harness.requests.length, 1);
});

test('a FAILED or mismatched user.status payload stays an operational failure', async () => {
  const transportFailure = createHttpHarness({
    routes: { '/api/user.status': () => jsonResponse(failedUserStatusPayload('handle: User with handle ghost not found'), 400) },
  });
  await assert.rejects(
    createCodeforcesAdapter({ transport: transportFailure.transport }).listSubmissions({
      account: createAccount({ sourceInstanceId: instance.id, handle: 'ghost' }),
      cursor: null,
      limit: 5,
      token: token(),
      limits,
    }),
    (error) => isPlatformError(error) && error.code === 'unavailable',
  );

  const apiFailure = createHttpHarness({
    routes: { '/api/user.status': () => jsonResponse(failedUserStatusPayload('handle: not found')) },
  });
  await assert.rejects(
    createCodeforcesAdapter({ transport: apiFailure.transport }).listSubmissions({
      account: createAccount({ sourceInstanceId: instance.id, handle: 'ghost' }),
      cursor: null,
      limit: 5,
      token: token(),
      limits,
    }),
    (error) => isPlatformError(error) && error.code === 'unavailable',
  );

  const wrongAuthor = createHttpHarness({
    routes: {
      '/api/user.status': (url) =>
        statusSlice([cfSubmissionItem({ id: 1, at: '2026-09-09T10:00:00.000Z', verdict: 'OK', author: 'mallory' })], url),
    },
  });
  const wrongAdapter = new CodeforcesAdapter({ transport: wrongAuthor.transport });
  await assert.rejects(
    wrongAdapter.listSubmissions({ account: wrongAdapter.account('alice'), cursor: null, limit: 5, token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'changed_response',
  );
});

test('the statement is parsed only from the identified .problem-statement node', async () => {
  const harness = createHttpHarness({ routes: { '/problemset/problem/1234/A': () => htmlResponse(problemPageHtml()) } });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  const problem = await adapter.fetchProblem({ problemRef: ref('1234A'), token: token(), limits });
  assert.equal(problem.title, 'Watermelon');
  const statement = problem.statement ?? '';
  assert.match(statement, /w <= 100 & w > 2/);
  // `htmlToPlainText` renders sup/sub as `^`/`_`, so the formula and the figure alt text survive
  // as text (the assertion predates that accepted rendering and only tracked the marker shape).
  assert.match(statement, /x\^2 \+ y_1/);
  assert.match(statement, /diagram of the split/);
  assert.match(statement, /n \\le 100/);
  assert.equal(statement.includes('tracking()'), false);
  assert.equal(statement.includes('window.analytics'), false);
  assert.equal(statement.includes('.hidden'), false);
  assert.equal(numericRating(problem, 'rating'), 800);
  assert.deepEqual(
    problem.rawTags.map((tag) => tag.raw),
    ['math', 'brute force'],
  );
  assert.equal(problem.ref.externalKey, '1234A');
});

test('a challenge page or a changed layout is refused instead of parsed', async () => {
  const challenge = createHttpHarness({
    routes: { '/problemset/problem/1234/A': () => htmlResponse(challengeHtml(), 403) },
  });
  await assert.rejects(
    createCodeforcesAdapter({ transport: challenge.transport }).fetchProblem({ problemRef: ref('1234A'), token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'auth_required',
  );

  const changed = createHttpHarness({
    routes: { '/problemset/problem/1234/A': () => htmlResponse(layoutChangedHtml()) },
  });
  await assert.rejects(
    createCodeforcesAdapter({ transport: changed.transport }).fetchProblem({ problemRef: ref('1234A'), token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'changed_response' && error.operation === 'statement',
  );
});

test('problem references are validated against the official instance', async () => {
  const harness = createHttpHarness({ routes: {} });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  await assert.rejects(
    adapter.fetchProblem({ problemRef: { sourceInstanceId: 'codeforces:mirror.example', domain: null, externalKey: '1234A' }, token: token(), limits }),
    expectInvalid,
  );
  await assert.rejects(adapter.fetchProblem({ problemRef: ref('not-a-key'), token: token(), limits }), expectInvalid);
  await assert.rejects(
    adapter.fetchProblem({ problemRef: { sourceInstanceId: instance.id, domain: 'group', externalKey: '1234A' }, token: token(), limits }),
    expectInvalid,
  );
  assert.throws(
    () =>
      createCodeforcesAdapter({
        transport: harness.transport,
        sourceInstance: createSourceInstance({ platform: 'codeforces', baseUrl: 'https://codeforces.org' }),
      }),
    expectInvalid,
  );
  assert.throws(
    () =>
      createCodeforcesAdapter({
        transport: harness.transport,
        sourceInstance: createSourceInstance({ platform: 'luogu', baseUrl: 'https://codeforces.com' }),
      }),
    expectInvalid,
  );
  assert.equal(harness.requests.length, 0);
});

test('a supplied official blog URL is used directly and only its target section is emitted', async () => {
  const harness = createHttpHarness({
    routes: { '/api/blogEntry.view': () => jsonResponse(blogEntryPayload({ id: 9001, content: blogContentHtml() })) },
  });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  const result = await adapter.fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/9001',
  });
  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.equal(result.sources[0]?.url, 'https://codeforces.com/blog/entry/9001');
  assert.equal(result.sources[0]?.availability, 'found');
  assert.equal(result.solutions[0]?.sourceId, 'cf-blog-9001');
  const text = result.solutions[0]?.text ?? '';
  assert.match(text, /dynamic programming over values/);
  assert.match(text, /this reference is embedded in explanation text/);
  assert.equal(text.includes('Both problems share'), false);
  assert.equal(text.includes('must not leak'), false);
  assert.equal(harness.requests.length, 1);
  assert.match(harness.requests[0]?.url ?? '', /blogEntryId=9001/);

  const paired = await adapter.fetchEditorial({
    problemRef: ref('456C'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/9001',
  });
  assert.equal(paired.status, 'found');
  if (paired.status === 'found') {
    assert.match(paired.solutions[0]?.text ?? '', /Both problems share a greedy write-up/);
    assert.equal((paired.solutions[0]?.text ?? '').includes('must not leak'), false);
  }
});

test('a caller-supplied tutorial URL cannot become an arbitrary fetch target', async () => {
  const harness = createHttpHarness({ routes: { '/api/blogEntry.view': () => jsonResponse(blogEntryPayload({ id: 1 })) } });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  const rejected = [
    'https://evil.example/blog/entry/1',
    'http://codeforces.com/blog/entry/1',
    'https://codeforces.com/problemset/problem/1/A',
    'https://codeforces.com/blog/entry/1/edit',
  ];
  for (const url of rejected) {
    await assert.rejects(
      adapter.fetchEditorial({ problemRef: ref('455A'), token: token(), limits, officialTutorialUrl: url }),
      expectInvalid,
    );
  }
  assert.equal(harness.requests.length, 0);
});

test('without a supplied URL the Tutorial link is discovered, and its absence is unavailable', async () => {
  const discovered = createHttpHarness({
    routes: {
      '/problemset/problem/455/A': () => htmlResponse(problemPageHtml({ index: 'A', title: 'Boredom', tutorialBlogId: 9002 })),
      '/api/blogEntry.view': () => jsonResponse(blogEntryPayload({ id: 9002, content: blogContentHtml() })),
    },
  });
  const adapter = createCodeforcesAdapter({ transport: discovered.transport });
  const found = await adapter.fetchEditorial({ problemRef: ref('455A'), token: token(), limits });
  assert.equal(found.status, 'found');
  assert.equal(discovered.requests.length, 2);
  assert.match(discovered.requests[1]?.url ?? '', /blogEntryId=9002/);

  const none = createHttpHarness({
    routes: { '/problemset/problem/455/A': () => htmlResponse(problemPageHtml({ index: 'A', title: 'Boredom' })) },
  });
  const missing = await createCodeforcesAdapter({ transport: none.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
  });
  assert.equal(missing.status, 'unavailable');
  assert.notEqual(missing.status, 'absent');
  if (missing.status === 'unavailable') {
    assert.equal(missing.retryable, false);
    assert.match(missing.detail, /discovery is incomplete/);
  }
});

test('a dead blog reference and an unusable section stay operational failures', async () => {
  const dead = createHttpHarness({
    routes: {
      '/api/blogEntry.view': () =>
        jsonResponse(failedBlogEntryPayload('Blog entry with id 4634 not found'), 400),
    },
  });
  const deadResult = await createCodeforcesAdapter({ transport: dead.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/4634',
  });
  assert.equal(deadResult.status, 'unavailable');
  assert.notEqual(deadResult.status, 'absent');

  const missing = createHttpHarness({
    routes: {
      '/api/blogEntry.view': () => jsonResponse(blogEntryPayload({ id: 9005, content: missingSectionBlogHtml() })),
    },
  });
  const missingResult = await createCodeforcesAdapter({ transport: missing.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/9005',
  });
  assert.equal(missingResult.status, 'changed_response');

  const ambiguous = createHttpHarness({
    routes: { '/api/blogEntry.view': () => jsonResponse(blogEntryPayload({ id: 9006, content: ambiguousBlogHtml() })) },
  });
  const ambiguousResult = await createCodeforcesAdapter({ transport: ambiguous.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/9006',
  });
  assert.equal(ambiguousResult.status, 'changed_response');
  if (ambiguousResult.status === 'changed_response') {
    assert.match(ambiguousResult.sample ?? '', /455A/);
  }
});

test('capabilities advertise only what the adapter does', () => {
  const adapter = createCodeforcesAdapter({ transport: createHttpHarness({ routes: {} }).transport });
  const capabilities = adapter.capabilities();
  assert.equal(capabilities.implemented, true);
  assert.equal(capabilities.requiresAuth, false);
  assert.equal(capabilities.minRequestIntervalMs, 2000);
  assert.ok(capabilities.notes.length > 0);
});

test('the adapter rejects invalid limit numbers before any request', async () => {
  const harness = createHttpHarness({ routes: {} });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  await assert.rejects(
    adapter.listProblems({ cursor: null, limit: 0, token: token(), limits }),
    expectInvalid,
  );
  await assert.rejects(
    adapter.listProblems({ cursor: null, limit: 5, token: token(), limits: { ...limits, pageSize: 0 } }),
    expectInvalid,
  );
  await assert.rejects(
    adapter.listProblems({ cursor: null, limit: 5, token: token(), limits: { ...limits, maxConcurrency: 0 } }),
    expectInvalid,
  );
  assert.equal(harness.requests.length, 0);
});

test('the documented 2000 ms floor survives a zero constructor override and a floor-zero shared transport', async () => {
  const routes = { '/problemset/problem/1234/A': () => htmlResponse(problemPageHtml()) };
  const perRequest: PlatformLimits = { ...limits, minRequestIntervalMs: 0 };
  const paced = async (adapter: CodeforcesAdapter, harness: ReturnType<typeof createHttpHarness>) => {
    await adapter.fetchProblem({ problemRef: ref('1234A'), token: token(), limits: perRequest });
    await adapter.fetchProblem({ problemRef: ref('1234A'), token: token(), limits: perRequest });
    assert.deepEqual(
      harness.requests.map((request) => request.at),
      [0, 2000],
    );
  };

  // `http` may tune transport options, never the documented floor.
  const own = createHttpHarness({ routes });
  await paced(
    new CodeforcesAdapter({ http: { ...own.impl, minRequestIntervalMs: 0, platformMinRequestIntervalMs: 0 } }),
    own,
  );

  // A shared transport that declares its own floor of 0 is still driven by per-request limits.
  const shared = createHttpHarness({ routes });
  await paced(new CodeforcesAdapter({ transport: shared.transport }), shared);
});

test('a shared transport bound to another origin is refused before any request', () => {
  assert.throws(
    () => new CodeforcesAdapter({ transport: new HttpTransport({ origin: 'https://evil.example' }) }),
    expectInvalid,
  );
});

test('catalog indexes keep alphabetic suffixes and numeric padding apart', async () => {
  const harness = createHttpHarness({
    routes: {
      '/api/problemset.problems': () =>
        jsonResponse(
          catalogPayload([
            catalogProblem({ contestId: 20, index: 'C', name: 'Alpha', rating: 1500, tags: ['math'] }),
            catalogProblem({ contestId: 921, index: '01', name: 'Padded one' }),
            catalogProblem({ contestId: 921, index: '14', name: 'Padded fourteen' }),
            catalogProblem({ contestId: 921, index: 'd10', name: 'Letter ten' }),
          ]),
        ),
    },
  });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  const page = await adapter.listProblems({ cursor: null, limit: 10, token: token(), limits });

  assert.deepEqual(
    page.items.map((item) => item.ref.externalKey),
    ['20C', '921/01', '921/14', '921D10'],
  );
  assert.deepEqual(
    page.items.map((item) => item.url),
    [
      'https://codeforces.com/problemset/problem/20/C',
      'https://codeforces.com/problemset/problem/921/01',
      'https://codeforces.com/problemset/problem/921/14',
      'https://codeforces.com/problemset/problem/921/D10',
    ],
  );
  assert.deepEqual(
    page.items.map((item) => item.ref.domain),
    [null, null, null, null],
  );
  // An all-digit key is never split into a contest and an index.
  assert.equal(parseCfProblemKey('92114'), null);
  assert.equal(harness.requests.length, 1);
});

test('a gym problemset entry or an unusable catalog index is refused, not imported', async () => {
  const gymEntry = {
    ...catalogProblem({ contestId: 1000, index: 'A', name: 'Gym problem' }),
    problemsetName: 'Codeforces Gym',
  };
  const gym = createHttpHarness({ routes: { '/api/problemset.problems': () => jsonResponse(catalogPayload([gymEntry])) } });
  await assert.rejects(
    createCodeforcesAdapter({ transport: gym.transport }).listProblems({ cursor: null, limit: 5, token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'changed_response' && /main Codeforces problemset/.test(error.detail),
  );

  for (const index of ['A1B', '1234', '']) {
    const harness = createHttpHarness({
      routes: {
        '/api/problemset.problems': () => jsonResponse(catalogPayload([catalogProblem({ contestId: 1, index, name: 'Broken' })])),
      },
    });
    await assert.rejects(
      createCodeforcesAdapter({ transport: harness.transport }).listProblems({ cursor: null, limit: 5, token: token(), limits }),
      (error) => isPlatformError(error) && error.code === 'changed_response',
    );
  }
});

test('the first page always refreshes metadata and a continuation reuses only a fresh snapshot', async () => {
  let clock = 0;
  let problems = [
    catalogProblem({ contestId: 1234, index: 'A', name: 'Watermelon', rating: 800 }),
    catalogProblem({ contestId: 1234, index: 'B', name: 'Two Buttons', rating: 2400 }),
  ];
  const harness = createHttpHarness({
    routes: { '/api/problemset.problems': () => jsonResponse(catalogPayload(problems)) },
  });
  const adapter = new CodeforcesAdapter({
    transport: harness.transport,
    clock: () => clock,
    catalogSnapshotTtlMs: 1000,
  });

  const first = await adapter.listProblems({ cursor: null, limit: 1, token: token(), limits });
  assert.ok(first.nextCursor);
  assert.equal(harness.requests.length, 1);
  await adapter.listProblems({ cursor: null, limit: 1, token: token(), limits });
  assert.equal(harness.requests.length, 2, 'cursor === null refreshes the metadata');

  const resumed = await adapter.listProblems({ cursor: first.nextCursor, limit: 1, token: token(), limits });
  assert.equal(harness.requests.length, 2, 'a fresh cached snapshot serves the continuation');
  assert.equal(resumed.items[0]?.ref.externalKey, '1234B');

  clock += 1001;
  const refetched = await adapter.listProblems({ cursor: first.nextCursor, limit: 1, token: token(), limits });
  assert.equal(harness.requests.length, 3, 'an expired snapshot is re-fetched and re-checked');
  assert.equal(refetched.items[0]?.ref.externalKey, '1234B');

  clock += 1001;
  problems = [catalogProblem({ contestId: 2000, index: 'A', name: 'Inserted', rating: 1500 }), ...problems];
  await assert.rejects(
    adapter.listProblems({ cursor: first.nextCursor, limit: 1, token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'changed_response' && /restart from the first page/.test(error.detail),
  );
});

test('cancellation is observed even when a cached snapshot would serve the page', async () => {
  const harness = createHttpHarness({ routes: { '/api/problemset.problems': () => jsonResponse(defaultCatalog()) } });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  const first = await adapter.listProblems({ cursor: null, limit: 1, token: token(), limits });
  assert.ok(first.nextCursor);

  const source = createCancellationSource();
  source.cancel('test cancellation');
  await assert.rejects(
    adapter.listProblems({ cursor: first.nextCursor, limit: 1, token: source.token, limits }),
    expectCancelled,
  );
  assert.equal(harness.requests.length, 1);
});

test('an optional catalog account must be canonical for this instance', async () => {
  const harness = createHttpHarness({ routes: { '/api/problemset.problems': () => jsonResponse(defaultCatalog()) } });
  const adapter = new CodeforcesAdapter({ transport: harness.transport });
  await assert.rejects(
    adapter.listProblems({
      cursor: null,
      limit: 1,
      token: token(),
      limits,
      account: createAccount({ sourceInstanceId: instance.id, handle: 'Alice' }),
    }),
    expectInvalid,
  );
  await assert.rejects(
    adapter.listProblems({
      cursor: null,
      limit: 1,
      token: token(),
      limits,
      account: createAccount({ sourceInstanceId: 'codeforces:mirror.example', handle: 'alice' }),
    }),
    expectInvalid,
  );
  assert.equal(harness.requests.length, 0);
});

test('problem targets accept canonical keys and official hrefs but never guess a numeric split', async () => {
  const harness = createHttpHarness({
    routes: {
      '/problemset/problem/921/01': () => htmlResponse(problemPageHtml({ index: '01', title: 'Padded' })),
      '/problemset/problem/20/C': () => htmlResponse(problemPageHtml({ index: 'C', title: 'Alpha' })),
    },
  });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });

  const padded = await adapter.fetchProblem({ problemRef: ref('921/01'), token: token(), limits });
  assert.equal(padded.ref.externalKey, '921/01');
  assert.equal(padded.url, 'https://codeforces.com/problemset/problem/921/01');

  // An official href is an identity reference only: the target is rebuilt on our own origin.
  const href = await adapter.fetchProblem({
    problemRef: ref('http://www.codeforces.com/contest/20/problem/C'),
    token: token(),
    limits,
  });
  assert.equal(href.ref.externalKey, '20C');

  const mainAlias = await adapter.fetchProblem({ problemRef: ref('921/01', 'problemset'), token: token(), limits });
  assert.equal(mainAlias.ref.domain, null);

  await assert.rejects(adapter.fetchProblem({ problemRef: ref('92114'), token: token(), limits }), expectInvalid);
  await assert.rejects(
    adapter.fetchProblem({ problemRef: ref('https://evil.example/contest/1/problem/A'), token: token(), limits }),
    expectInvalid,
  );
  assert.equal(harness.requests.length, 3);
});

test('gym references are refused with an actionable message instead of being guessed', async () => {
  const harness = createHttpHarness({ routes: {} });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  for (const externalKey of ['1000A', 'https://codeforces.com/gym/1000/problem/A']) {
    await assert.rejects(
      adapter.fetchProblem({ problemRef: ref(externalKey, 'gym'), token: token(), limits }),
      (error) => isPlatformError(error) && error.code === 'invalid_input' && /gym problemset is not supported/.test(error.detail),
    );
  }
  await assert.rejects(adapter.fetchEditorial({ problemRef: ref('1000A', 'gym'), token: token(), limits }), expectInvalid);
  assert.match(adapter.capabilities().notes.join(' '), /gym problemset reference is refused/);
  assert.equal(harness.requests.length, 0);
});

test('cursor tokens are version-locked, carry since, and bound their numeric fields', async () => {
  const harness = createHttpHarness({ routes: { '/api/user.status': (url) => statusSlice(defaultSubmissions(), url) } });
  const adapter = new CodeforcesAdapter({ transport: harness.transport });
  const account = adapter.account('alice');
  const scope = {
    version: CURSOR_VERSION,
    sourceInstanceId: instance.id,
    resource: 'submissions',
    accountId: account.id,
    handle: 'alice',
    returned: 2,
    boundaryId: '39',
    since: null,
  };
  const resume = (cursor: string) => adapter.listSubmissions({ account, cursor, limit: 2, token: token(), limits });

  // A version-1 token, and a version-2 token that lost its `since` field, must restart.
  await assert.rejects(resume(rawCursor({ ...scope, version: 1 })), expectInvalid);
  await assert.rejects(resume(rawCursor({ ...scope, since: undefined })), expectInvalid);
  await assert.rejects(resume(rawCursor({ ...scope, since: 'yesterday' })), expectInvalid);
  await assert.rejects(resume(rawCursor({ ...scope, returned: 2 ** 53 })), expectInvalid);
  assert.equal(harness.requests.length, 0);
});

test('a catalog cursor with an unbounded offset or a legacy version is refused', async () => {
  const harness = createHttpHarness({ routes: { '/api/problemset.problems': () => jsonResponse(defaultCatalog()) } });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  const page = await adapter.listProblems({ cursor: null, limit: 1, token: token(), limits });
  assert.ok(page.nextCursor);
  const decoded = requireCatalogCursor(decodeCursor(page.nextCursor), { sourceInstanceId: instance.id, accountId: null });

  await assert.rejects(
    adapter.listProblems({ cursor: encodeCursor({ ...decoded, offset: 2 ** 53 }), limit: 1, token: token(), limits }),
    expectInvalid,
  );
  await assert.rejects(
    adapter.listProblems({ cursor: rawCursor({ ...decoded, version: 1 }), limit: 1, token: token(), limits }),
    expectInvalid,
  );
  assert.equal(harness.requests.length, 1);
});

test('a submission cursor binds its since bound and refuses a different one', async () => {
  const harness = createHttpHarness({ routes: { '/api/user.status': (url) => statusSlice(defaultSubmissions(), url) } });
  const adapter = new CodeforcesAdapter({ transport: harness.transport });
  const account = adapter.account('alice');

  const first = await adapter.listSubmissions({
    account,
    cursor: null,
    limit: 2,
    since: '2026-09-07T10:00:00Z',
    token: token(),
    limits,
  });
  assert.ok(first.nextCursor);
  const decoded = decodeCursor(first.nextCursor);
  if (decoded.resource !== 'submissions') {
    assert.fail('expected a submission cursor');
  }
  assert.equal(decoded.since, '2026-09-07T10:00:00.000Z');

  const second = await adapter.listSubmissions({
    account,
    cursor: first.nextCursor,
    limit: 2,
    since: '2026-09-07T10:00:00.000Z',
    token: token(),
    limits,
  });
  assert.deepEqual(
    second.items.map((item) => item.externalId),
    ['38', '37'],
  );

  await assert.rejects(
    adapter.listSubmissions({
      account,
      cursor: first.nextCursor,
      limit: 2,
      since: '2026-09-08T10:00:00.000Z',
      token: token(),
      limits,
    }),
    expectInvalid,
  );
  await assert.rejects(
    adapter.listSubmissions({ account, cursor: first.nextCursor, limit: 2, token: token(), limits }),
    expectInvalid,
  );
});

test('a submission is imported only when the requested handle is one of its authors', async () => {
  const at = '2026-09-09T10:00:00.000Z';
  const team = createHttpHarness({
    routes: {
      '/api/user.status': (url) => statusSlice([cfSubmissionItem({ id: 7, at, verdict: 'OK', members: ['Bob', 'Alice'] })], url),
    },
  });
  const teamAdapter = new CodeforcesAdapter({ transport: team.transport });
  const page = await teamAdapter.listSubmissions({
    account: teamAdapter.account('alice'),
    cursor: null,
    limit: 5,
    token: token(),
    limits,
  });
  assert.deepEqual(
    page.items.map((item) => item.externalId),
    ['7'],
  );

  const malformed: readonly unknown[] = [
    'alice',
    null,
    { members: [] },
    { members: 'alice' },
    { members: [{ handle: 42 }] },
    { members: [{ handle: '   ' }] },
  ];
  for (const authorOverride of malformed) {
    const harness = createHttpHarness({
      routes: {
        '/api/user.status': (url) => statusSlice([cfSubmissionItem({ id: 8, at, verdict: 'OK', authorOverride })], url),
      },
    });
    const adapter = new CodeforcesAdapter({ transport: harness.transport });
    await assert.rejects(
      adapter.listSubmissions({ account: adapter.account('alice'), cursor: null, limit: 5, token: token(), limits }),
      (error) => isPlatformError(error) && error.code === 'changed_response',
    );
  }
});

test('memory is exact KiB and malformed numbers are refused', async () => {
  const at = '2026-09-09T10:00:00.000Z';
  const harness = createHttpHarness({
    routes: {
      '/api/user.status': (url) =>
        statusSlice(
          [
            cfSubmissionItem({ id: 1, at, verdict: 'OK', memoryBytes: 1536, timeConsumedMillis: 15 }),
            cfSubmissionItem({ id: 2, at, verdict: 'OK', memoryConsumedBytes: 1 }),
          ],
          url,
        ),
    },
  });
  const adapter = new CodeforcesAdapter({ transport: harness.transport });
  const page = await adapter.listSubmissions({
    account: adapter.account('alice'),
    cursor: null,
    limit: 5,
    token: token(),
    limits,
  });
  assert.equal(page.items[0]?.memoryKb, 1.5);
  assert.equal(page.items[1]?.memoryKb, 1 / 1024);
  assert.equal(memoryBytesToKib(1536), 1.5);

  const invalid: readonly Record<string, unknown>[] = [
    { creationTimeSeconds: -1 },
    { creationTimeSeconds: 1.5 },
    { creationTimeSeconds: 9e12 },
    { creationTimeSeconds: 2 ** 53 },
    { creationTimeSeconds: null },
    { timeConsumedMillis: 1.5 },
    { timeConsumedMillis: -1 },
    { memoryBytes: -1 },
    { memoryBytes: 2 ** 53 },
    { id: 1.5 },
  ];
  for (const override of invalid) {
    const broken = createHttpHarness({
      routes: {
        '/api/user.status': (url) => statusSlice([cfSubmissionItem({ id: 9, at, verdict: 'OK', ...override })], url),
      },
    });
    const brokenAdapter = new CodeforcesAdapter({ transport: broken.transport });
    await assert.rejects(
      brokenAdapter.listSubmissions({ account: brokenAdapter.account('alice'), cursor: null, limit: 5, token: token(), limits }),
      (error) => isPlatformError(error) && error.code === 'changed_response',
    );
  }
});

test('a blog entry id must match the request and its title/author/locale are recorded', async () => {
  const mismatch = createHttpHarness({
    routes: { '/api/blogEntry.view': () => jsonResponse(blogEntryPayload({ id: 9100, resultId: 42 })) },
  });
  const mismatched = await createCodeforcesAdapter({ transport: mismatch.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/9100',
  });
  assert.equal(mismatched.status, 'changed_response');
  if (mismatched.status === 'changed_response') {
    assert.match(mismatched.detail, /answered blog 42/);
  }

  const harness = createHttpHarness({
    routes: {
      '/api/blogEntry.view': () =>
        jsonResponse(
          blogEntryPayload({
            id: 9101,
            title: '<p>Round <b>455</b> Editorial</p>',
            author: null,
            authorHandle: 'Bidhan',
            locale: 'en',
            content: blogContentHtml(),
          }),
        ),
    },
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/9101',
  });
  assert.equal(result.status, 'found');
  if (result.status === 'found') {
    const source = result.sources[0];
    assert.ok(source);
    assert.equal(source.author, 'Bidhan');
    assert.equal(source.language, 'en');
    assert.equal(source.title.includes('<'), false);
    assert.match(source.title, /Round 455 Editorial/);
  }

  const htmlTitle = createHttpHarness({
    routes: {
      '/api/blogEntry.view': () =>
        jsonResponse(blogEntryPayload({ id: 9102, title: 'ignored', titleHTML: '<b>HTML</b> title', content: blogContentHtml() })),
    },
  });
  const preferred = await createCodeforcesAdapter({ transport: htmlTitle.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/9102',
  });
  assert.equal(preferred.status, 'found');
  if (preferred.status === 'found') {
    assert.match(preferred.sources[0]?.title ?? '', /HTML title/);
  }
});

test('a body-declared call limit stays rate_limited for catalog, submissions and editorial', async () => {
  const limited = () => jsonResponse({ status: 'FAILED', comment: 'Call limit exceeded' }, 400);

  const catalogHarness = createHttpHarness({ routes: { '/api/problemset.problems': limited } });
  await assert.rejects(
    createCodeforcesAdapter({ transport: catalogHarness.transport }).listProblems({ cursor: null, limit: 5, token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'rate_limited' && error.retryable && error.retryAfterMs === 2000,
  );

  const statusHarness = createHttpHarness({ routes: { '/api/user.status': limited } });
  const statusAdapter = new CodeforcesAdapter({ transport: statusHarness.transport });
  await assert.rejects(
    statusAdapter.listSubmissions({ account: statusAdapter.account('alice'), cursor: null, limit: 5, token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'rate_limited' && error.retryAfterMs === 2000,
  );

  const blogHarness = createHttpHarness({ routes: { '/api/blogEntry.view': limited } });
  const editorial = await createCodeforcesAdapter({ transport: blogHarness.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
    officialTutorialUrl: 'https://codeforces.com/blog/entry/4634',
  });
  assert.equal(editorial.status, 'rate_limited');
  assert.notEqual(editorial.status, 'absent');
  assert.notEqual(editorial.status, 'unavailable');
  if (editorial.status === 'rate_limited') {
    assert.equal(editorial.retryAfterMs, 2000);
  }
});

test('an unknown API failure body is a changed response, never a missing editorial', async () => {
  const fetchWith = (harness: ReturnType<typeof createHttpHarness>, blogId: number) =>
    createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
      problemRef: ref('455A'),
      token: token(),
      limits,
      officialTutorialUrl: `https://codeforces.com/blog/entry/${String(blogId)}`,
    });

  const unknown = createHttpHarness({
    routes: { '/api/blogEntry.view': () => jsonResponse({ status: 'FAILED', comment: 'Something new happened' }) },
  });
  const unknownResult = await fetchWith(unknown, 9200);
  assert.equal(unknownResult.status, 'changed_response');
  assert.notEqual(unknownResult.status, 'absent');
  assert.notEqual(unknownResult.status, 'unavailable');

  const html400 = createHttpHarness({
    routes: { '/api/blogEntry.view': () => htmlResponse('<html><body>Bad Request</body></html>', 400) },
  });
  assert.equal((await fetchWith(html400, 9201)).status, 'changed_response');

  const missing404 = createHttpHarness({
    routes: { '/api/blogEntry.view': () => jsonResponse({ status: 'FAILED', comment: 'not found' }, 404) },
  });
  assert.equal((await fetchWith(missing404, 9202)).status, 'unavailable');

  const submissions = createHttpHarness({
    routes: { '/api/user.status': () => jsonResponse({ status: 'FAILED', comment: 'Something new happened' }) },
  });
  const adapter = new CodeforcesAdapter({ transport: submissions.transport });
  await assert.rejects(
    adapter.listSubmissions({ account: adapter.account('alice'), cursor: null, limit: 5, token: token(), limits }),
    (error) => isPlatformError(error) && error.code === 'changed_response',
  );
});

test('the source instance id must stay coherent with its platform and domain', () => {
  const transport = createHttpHarness({ routes: {} }).transport;
  const strayDomain = createSourceInstance({
    platform: 'codeforces',
    baseUrl: 'https://codeforces.com',
    domain: 'mirror.example',
  });
  assert.throws(() => createCodeforcesAdapter({ transport, sourceInstance: strayDomain }), expectInvalid);
  assert.throws(
    () => createCodeforcesAdapter({ transport, sourceInstance: { ...instance, id: 'codeforces:elsewhere' } }),
    expectInvalid,
  );
});

test('the whole captured public catalog parses through the adapter', async (t) => {
  if (!existsSync(CAPTURED_CATALOG)) {
    t.skip('private captured catalog is not present');
    return;
  }
  const body = readFileSync(CAPTURED_CATALOG, 'utf8');
  const expected = (JSON.parse(body) as { result: { problems: readonly unknown[] } }).result.problems.length;
  const harness = createHttpHarness({
    routes: {
      '/api/problemset.problems': () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    },
  });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  const captureLimits: PlatformLimits = { ...DEFAULT_PLATFORM_LIMITS, maxRetries: 0, pageSize: 10_000 };
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await adapter.listProblems({ cursor, limit: 10_000, token: token(), limits: captureLimits });
    for (const item of page.items) {
      keys.push(item.ref.externalKey);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  assert.equal(keys.length, expected);
  const numeric = keys.filter((key) => key.includes('/'));
  assert.ok(numeric.length > 0);
  for (const key of numeric) {
    const parts = parseCfProblemKey(key);
    assert.ok(parts, `numeric key ${key} must parse`);
    assert.equal(parseCfProblemKey(`${String(parts.contestId)}${parts.index}`), null, 'an all-digit key is never split');
  }
  assert.equal(harness.requests.length, 1, 'the continuation reuses the fresh snapshot');
  // Only the derived count is printed; the payload itself is never published.
  console.log(`captured catalog: ${String(keys.length)} problems parsed, ${String(numeric.length)} numeric indexes`);
});

test('captured public submission records normalize through the adapter', async (t) => {
  if (!existsSync(CAPTURED_RECORDS)) {
    t.skip('private captured records are not present');
    return;
  }
  const captured = (JSON.parse(readFileSync(CAPTURED_RECORDS, 'utf8')) as { result: readonly Record<string, unknown>[] }).result;
  const first = captured[0];
  if (first === undefined) {
    t.skip('private captured records are empty');
    return;
  }
  const author = first.author as { members: readonly { handle: string }[] };
  const handle = author.members[0]?.handle ?? '';
  const problem = first.problem as { contestId: number; index: string };
  const problemIndex = problem.index;
  const expectedKey = /^[0-9]+$/u.test(problemIndex)
    ? `${String(problem.contestId)}/${problemIndex}`
    : `${String(problem.contestId)}${problemIndex.toUpperCase()}`;
  const rawMemory = (first.memoryBytes ?? first.memoryConsumedBytes) as number;

  const harness = createHttpHarness({ routes: { '/api/user.status': (url) => statusSlice(captured, url) } });
  const adapter = new CodeforcesAdapter({ transport: harness.transport });
  const page = await adapter.listSubmissions({
    account: adapter.account(handle),
    cursor: null,
    limit: 10,
    token: token(),
    limits,
  });

  assert.equal(page.items.length, captured.length);
  assert.equal(page.items[0]?.ref.externalKey, expectedKey);
  assert.equal(page.items[0]?.memoryKb, rawMemory / 1024);
  assert.equal(page.items[0]?.timeMs, first.timeConsumedMillis);
  assert.equal(page.items[0]?.verdict, 'accepted');
  console.log(`captured submissions: ${String(page.items.length)} records normalized`);
});

test('reject zero resume offsets, non-main submission identities and non-root source URLs', async () => {
  assert.throws(() => decodeCursor(rawCursor({version:CURSOR_VERSION,resource:'submissions',sourceInstanceId:instance.id,accountId:'alice',handle:'alice',returned:0,boundaryId:null,since:null})), expectInvalid);
  for (const suffix of ['/path', '/?query=yes', '/#fragment']) {
    assert.throws(() => createCodeforcesAdapter({sourceInstance:codeforcesSourceInstance('https://codeforces.com'+suffix)}), expectInvalid);
  }
  for (const bad of [
    cfSubmissionItem({id:0,at:'2026-09-12T00:00:00Z'}),
    {...cfSubmissionItem({id:1,at:'2026-09-12T00:00:00Z'}),problem:{contestId:1234,index:'A',problemsetName:'gym'}},
  ]) {
    const harness=createHttpHarness({routes:{'/api/user.status':()=>jsonResponse({status:'OK',result:[bad]})}});
    const adapter=new CodeforcesAdapter({transport:harness.transport});
    await assert.rejects(adapter.listSubmissions({account:adapter.account('alice'),cursor:null,limit:10,limits,token:token()}),error=>isPlatformError(error)&&error.code==='changed_response');
  }
});

test('official rating validates account and profile/history consistency with shared 2-second pacing', async () => {
  const rows = [{ contestId: 1, contestName: 'Synthetic round', handle: 'Alice', rank: 12, ratingUpdateTimeSeconds: 1767225600, oldRating: 0, newRating: 1642 }];
  let rating: unknown = 1642, handle = 'Alice';
  const h = createHttpHarness({ routes: {
    '/api/user.info': url => { assert.equal(url.searchParams.get('checkHistoricHandles'), 'false'); return jsonResponse({ status: 'OK', result: [{ handle, rating, maxRating: rating }] }); },
    '/api/user.rating': () => jsonResponse({ status: 'OK', result: rows }),
  } });
  const adapter = new CodeforcesAdapter({ transport: h.transport, clock: () => Date.parse('2026-09-12T08:00:00.000Z') });
  const request = { account: adapter.account('alice'), limits, token: token() };
  assert.equal((await adapter.fetchOfficialRating(request)).rating, 1642);
  assert.equal(h.requests[1]!.at - h.requests[0]!.at, 2000);
  rating = 1700; await assert.rejects(adapter.fetchOfficialRating(request), e => isPlatformError(e) && e.code === 'changed_response');
  rating = '1642'; await assert.rejects(adapter.fetchOfficialRating(request), e => isPlatformError(e) && e.code === 'changed_response');
  handle = 'Bob'; const count = h.requests.length;
  await assert.rejects(adapter.fetchOfficialRating(request), e => isPlatformError(e) && e.code === 'changed_response');
  assert.equal(h.requests.length, count + 1, 'foreign profile stops before history fetch');
  const cancelled = createCancellationSource(); cancelled.cancel();
  await assert.rejects(adapter.fetchOfficialRating({ ...request, token: cancelled.token }), expectCancelled);
});

test('official rating distinguishes unrated, rate-limit and unavailable responses', async () => {
  let status = 200;
  const h = createHttpHarness({ routes: {
    '/api/user.info': () => status === 200 ? jsonResponse({ status: 'OK', result: [{ handle: 'alice' }] }) : jsonResponse({ status: 'FAILED', comment: status === 400 ? 'Call limit exceeded' : 'unavailable' }, status),
    '/api/user.rating': () => jsonResponse({ status: 'OK', result: [] }),
  } });
  const adapter = new CodeforcesAdapter({ transport: h.transport });
  const request = { account: adapter.account('alice'), limits, token: token() };
  const unrated = await adapter.fetchOfficialRating(request); assert.equal(unrated.rating, null); assert.deepEqual(unrated.history, []);
  status = 400; await assert.rejects(adapter.fetchOfficialRating(request), e => isPlatformError(e) && e.code === 'rate_limited');
  status = 503; await assert.rejects(adapter.fetchOfficialRating(request), e => isPlatformError(e) && e.code === 'unavailable');
});
