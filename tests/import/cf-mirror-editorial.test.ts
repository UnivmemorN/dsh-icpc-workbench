/**
 * Exact Codeforces-mirror editorial reuse (Sprint 33B), over the real `ImportService` and a real
 * SQLite store.
 *
 * Only the outer boundary is faked: the platform adapters are scripted local implementations and the
 * equivalent-problem port is a recording stub. Everything under test is production code, so the
 * assertions cover externally meaningful behaviour: the pairing is decided by the domain's own
 * `cf_mirror_identifier` rule (never by title, similarity or a model), the Codeforces reference is
 * derived server-side from the target's stored identity, the statement still comes from the target's
 * own platform, the official blog URL survives and the mapping provenance is recorded on the source,
 * a failure is preserved as a non-`absent` check without discarding good cached material, an
 * already usable editorial is reused instead of spending a request, the target head-CAS still
 * refuses a stale commit, cancellation propagates, and the projections carry no bodies. No model,
 * network, credential or private batch is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import { editorialSourceIdOf, type MaterialReport } from '../../src/application/import-types.js';
import {
  CF_MIRROR_EDITORIAL_NOTE_PREFIX,
  CF_MIRROR_EDITORIAL_RULE_TAG,
  hasReusableEditorial,
  mirrorEditorialNote,
  mirrorEditorialRequestOf,
  selectMirrorEditorial,
  withMirrorProvenance,
} from '../../src/application/cf-mirror-editorial.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import type {
  EditorialFetchResult,
  FetchEditorialRequest,
  FetchProblemRequest,
  ListProblemsRequest,
  ListSubmissionsRequest,
  Page,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformLimits,
} from '../../src/application/ports.js';
import {
  CODEFORCES_MAIN_INSTANCE_ID,
  LUOGU_OFFICIAL_INSTANCE_ID,
} from '../../src/domain/problem-equivalence.js';
import {
  DomainError,
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  createProblemSnapshot,
  createSourceInstance,
  type NormalizedProblem,
  type ProblemRef,
  type ProblemSnapshot,
  type SourceInstance,
  type Submission,
} from '../../src/domain/index.js';
import { createCodeforcesAdapter } from '../../src/adapters/codeforces/index.js';
import { createHttpHarness, htmlResponse, jsonResponse, problemPageHtml } from '../platform/fixtures.js';
import * as fx from '../storage/fixtures.js';

const SERVICE_NOW = '2026-09-12T10:00:00.000Z';
const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 1000,
  maxRetries: 0,
  pageSize: 100,
  maxConcurrency: 1,
};
const CF_SOLUTION_TEXT = 'Official tutorial: maintain a lazy segment tree; range add stays O(log n).';
const LUOGU_SOLUTION_TEXT = '洛谷本站题解：使用线段树维护区间和与懒标记。';
const OFFICIAL_BLOG_URL = 'https://codeforces.com/blog/entry/12345';

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

async function withStore(run: (store: SqliteTrainingStore) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => SERVICE_NOW });
  try {
    await run(store);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

function serviceFor(store: SqliteTrainingStore): ImportService {
  return new ImportService({ store, now: () => SERVICE_NOW });
}

/** The exact official instance of one platform, with the identity the equivalence rule recognizes. */
function officialInstance(id: string): SourceInstance {
  const [platform, domain] = id.split(':') as [string, string];
  return fx.makeInstance(platform as SourceInstance['platform'], domain);
}

/** One stored problem of an official instance, with its real canonical reference. */
function makeScopeFor(id: string, externalKey: string, title: string): fx.Scope {
  const instance = officialInstance(id);
  const problem = fx.makeProblem(fx.makeRef(instance, externalKey), { title });
  return { instance, account: fx.makeAccount(instance, 'alice'), problem };
}

/** A scripted adapter that records every request it received. */
class FakeAdapter implements PlatformAdapter {
  readonly sourceInstance: SourceInstance;
  readonly calls: Array<{ readonly operation: string; readonly request: unknown }> = [];
  problemResults: Array<NormalizedProblem | Error> = [];
  editorialResults: Array<EditorialFetchResult | Error> = [];
  afterFetchEditorial: (() => Promise<void>) | null = null;

  constructor(sourceInstance: SourceInstance) {
    this.sourceInstance = sourceInstance;
  }

  capabilities(): PlatformCapabilities {
    return {
      platform: this.sourceInstance.platform,
      implemented: true,
      problems: true,
      submissions: true,
      editorial: true,
      pagedProblems: true,
      pagedSubmissions: true,
      requiresAuth: false,
      supportsAccountHistory: true,
      minRequestIntervalMs: null,
      notes: [],
    };
  }

  async listProblems(request: ListProblemsRequest): Promise<Page<NormalizedProblem>> {
    this.calls.push({ operation: 'listProblems', request });
    throw new Error('unexpected listProblems request');
  }

  async listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>> {
    this.calls.push({ operation: 'listSubmissions', request });
    throw new Error('unexpected listSubmissions request');
  }

  async fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem> {
    this.calls.push({ operation: 'fetchProblem', request });
    return take(this.problemResults, 'problem');
  }

  async fetchEditorial(request: FetchEditorialRequest): Promise<EditorialFetchResult> {
    this.calls.push({ operation: 'fetchEditorial', request });
    const scripted = take(this.editorialResults, 'editorial');
    if (this.afterFetchEditorial !== null) {
      await this.afterFetchEditorial();
    }
    return scripted;
  }
}

function take<T>(scripted: Array<T | Error>, label: string): T {
  const next = scripted.shift();
  if (next === undefined) {
    throw new Error(`fake adapter: unexpected ${label} request`);
  }
  if (next instanceof Error) {
    throw next;
  }
  return next;
}

/**
 * Recording implementation of the equivalent-problem port.
 *
 * It records the *derived* Codeforces reference it was asked for, which is what proves the reference
 * came from the identity rule rather than from the caller.
 */
class RecordingMirrorPort {
  readonly requests: Array<{ readonly cfRef: ProblemRef; readonly target: ProblemRef }> = [];
  results: Array<EditorialFetchResult | Error> = [];
  afterFetch: (() => Promise<void>) | null = null;

  async fetchMirrorEditorial(request: {
    readonly cfRef: ProblemRef;
    readonly target: ProblemRef;
    readonly token: import('../../src/domain/index.js').CancellationToken;
    readonly limits: PlatformLimits;
  }): Promise<EditorialFetchResult> {
    this.requests.push({ cfRef: request.cfRef, target: request.target });
    const scripted = take(this.results, 'mirror editorial');
    if (this.afterFetch !== null) {
      await this.afterFetch();
    }
    return scripted;
  }
}

/** A `found` editorial answer with one source and one write-up. */
function foundEditorial(
  sourceId: string,
  url: string,
  text: string,
  options: { readonly note?: string | null } = {},
): EditorialFetchResult {
  const source = createEditorialSource({
    id: sourceId,
    kind: 'editorial',
    url,
    title: `Editorial ${sourceId}`,
    availability: 'found',
    retrievedAt: fx.LATER,
    text,
    ...(options.note === undefined ? {} : { note: options.note }),
  });
  const solution = createEditorialSolution({
    solutionId: `${sourceId}-s1`,
    sourceId,
    ordinal: 0,
    title: 'Main idea',
    text,
  });
  return { status: 'found', sources: [source], solutions: [solution], retrievedAt: fx.LATER };
}

/**
 * One persisted snapshot with a single found source, used for the reuse cases.
 *
 * `previous` chains the version the way every real writer does: the store refuses a snapshot that
 * would move its problem's head backwards, so a fixture that wants to publish a *newer* head has to
 * say which snapshot it supersedes. Snapshot identity is semantic content, so a caller that wants a
 * different snapshot must also change the problem (for example its statement).
 */
async function storeMaterial(
  store: SqliteTrainingStore,
  problem: NormalizedProblem,
  sourceId: string,
  text: string,
  url: string,
  options: { readonly previous?: ProblemSnapshot | null } = {},
): Promise<ProblemSnapshot> {
  const source = createEditorialSource({
    id: sourceId,
    kind: 'editorial',
    url,
    title: `Stored ${sourceId}`,
    availability: 'found',
    retrievedAt: fx.AT,
    text,
  });
  const solution = createEditorialSolution({ solutionId: `${sourceId}-s1`, sourceId, ordinal: 0, title: 'Stored', text });
  const snapshot = createProblemSnapshot({
    problem,
    sources: [source],
    solutions: [solution],
    capturedAt: fx.AT,
    previous: options.previous ?? null,
  });
  await store.upsertSourceInstances([officialInstance(problem.ref.sourceInstanceId)]);
  await store.upsertProblems([problem]);
  await store.saveSnapshot(snapshot);
  return snapshot;
}

const isDomain = (code: DomainError['code']) => (error: unknown): boolean =>
  error instanceof DomainError && error.code === code;

// ---------------------------------------------------------------------------------------
// The identity rule is the only pairing source
// ---------------------------------------------------------------------------------------

void test('the exact official Luogu CF mirror is the only accepted target', () => {
  const identity = mirrorEditorialRequestOf({
    sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID,
    domain: null,
    externalKey: 'CF1A',
  });
  assert.ok(identity, 'CF1A on the official Luogu instance must be recognized');
  assert.equal(identity.identity.cfExternalKey, '1A');
  assert.equal(identity.identity.luoguExternalKey, 'CF1A');
  // The Codeforces reference is *derived*, on the official instance, with no domain.
  assert.deepEqual(identity.cfRef, {
    sourceInstanceId: CODEFORCES_MAIN_INSTANCE_ID,
    domain: null,
    externalKey: '1A',
  });
  assert.equal(identity.luoguRef.externalKey, 'CF1A');
  // The suffix is part of the identity and is preserved exactly.
  assert.equal(
    mirrorEditorialRequestOf({ sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'CF1B01' })
      ?.cfRef.externalKey,
    '1B01',
  );

  // The rule is symmetric, so it also recognizes the Codeforces spelling — but reuse is
  // one-directional: a Codeforces record must never borrow from the Luogu mirror.
  assert.equal(
    mirrorEditorialRequestOf({ sourceInstanceId: CODEFORCES_MAIN_INSTANCE_ID, domain: null, externalKey: '1A' }),
    null,
  );
});

void test('every rejected boundary is refused by the rule itself', () => {
  const rejected: readonly { readonly label: string; readonly ref: ProblemRef }[] = [
    { label: 'a gym contest', ref: { sourceInstanceId: CODEFORCES_MAIN_INSTANCE_ID, domain: 'gym', externalKey: '1A' } },
    { label: 'a Luogu record with a domain', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: 'gym', externalKey: 'CF1A' } },
    {
      label: 'a non-official Luogu instance',
      ref: { sourceInstanceId: 'luogu:mirror.example.org', domain: null, externalKey: 'CF1A' },
    },
    {
      label: 'a non-official Codeforces instance',
      ref: { sourceInstanceId: 'codeforces:mirror.example.org', domain: null, externalKey: '1A' },
    },
    { label: 'a lowercase mirror key', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'cf1a' } },
    { label: 'a bare Codeforces spelling on Luogu', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: '1A' } },
    { label: 'a zero-padded contest', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'CF01A' } },
    { label: 'a contest id above the bound', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'CF100000A' } },
    { label: 'a numeric Codeforces index', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'CF92101' } },
    { label: 'a lowercase index', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'CF1a' } },
    { label: 'an unrelated Luogu problem', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'P1001' } },
    { label: 'a manual record', ref: { sourceInstanceId: 'manual:local.example.org', domain: null, externalKey: 'P1' } },
    { label: 'an empty key', ref: { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: '' } },
  ];
  for (const entry of rejected) {
    assert.equal(mirrorEditorialRequestOf(entry.ref), null, `${entry.label} must be refused`);
  }
});

// ---------------------------------------------------------------------------------------
// Selection: the free decisions come before any request
// ---------------------------------------------------------------------------------------

void test('selection refuses an unusable pair, a missing source and reusable material', () => {
  const mirror: ProblemRef = { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'CF1A' };
  const codeforces: ProblemRef = { sourceInstanceId: CODEFORCES_MAIN_INSTANCE_ID, domain: null, externalKey: '1A' };
  assert.deepEqual(selectMirrorEditorial({ target: codeforces, previous: null, hasMirrorPort: true, reuseExisting: true }), {
    kind: 'skip',
    reason: 'mirror_not_applicable',
  });
  assert.deepEqual(selectMirrorEditorial({ target: mirror, previous: null, hasMirrorPort: false, reuseExisting: true }), {
    kind: 'skip',
    reason: 'cf_source_unavailable',
  });
  assert.equal(selectMirrorEditorial({ target: mirror, previous: null, hasMirrorPort: true, reuseExisting: true }).kind, 'use');

  // Stored usable material wins over a new request — unless the caller explicitly asks for a refetch.
  const usable = snapshotWithFoundMaterial(codeforces, 'user-answer-1', 'A user-provided answer.');
  assert.deepEqual(selectMirrorEditorial({ target: mirror, previous: usable, hasMirrorPort: true, reuseExisting: true }), {
    kind: 'skip',
    reason: 'existing_editorial_reusable',
  });
  assert.equal(
    selectMirrorEditorial({ target: mirror, previous: usable, hasMirrorPort: true, reuseExisting: false }).kind,
    'use',
  );
});

void test('only a found source with a non-blank referenced body counts as reusable', () => {
  const ref: ProblemRef = { sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID, domain: null, externalKey: 'CF1A' };
  const blank = snapshotWithFoundSource(ref, 's', null, 'found');
  const whitespace = snapshotWithFoundSource(ref, 's', '   ', 'found');
  const notFound = snapshotWithFoundSource(ref, 's', 'real text', 'absent');
  const failed = snapshotWithFoundSource(ref, 's', 'real text', 'unavailable');
  const usable = snapshotWithFoundMaterial(ref, 's', 'real text');
  assert.deepEqual(
    {
      null: hasReusableEditorial(null),
      empty: hasReusableEditorial(
        createProblemSnapshot({ problem: fx.makeProblem(ref), sources: [], solutions: [], capturedAt: fx.AT }),
      ),
      blank: hasReusableEditorial(blank),
      whitespace: hasReusableEditorial(whitespace),
      notFound: hasReusableEditorial(notFound),
      failed: hasReusableEditorial(failed),
      usable: hasReusableEditorial(usable),
    },
    { null: false, empty: false, blank: false, whitespace: false, notFound: false, failed: false, usable: true },
  );
});

/**
 * One snapshot whose single source claims `found` and carries a placeholder body.
 *
 * The domain factory refuses a blank `found` body, so the "a reference exists but its text is empty"
 * observation is built by replacing the *solution* text on an otherwise valid frozen snapshot. That
 * is the real shape the pipeline has to survive, and the guard under test must not treat it as
 * usable material.
 */
function snapshotWithFoundSource(
  ref: ProblemRef,
  sourceId: string,
  text: string | null,
  availability: 'found' | 'absent' | 'unavailable',
): ProblemSnapshot {
  const source = createEditorialSource({
    id: sourceId,
    kind: 'editorial',
    url: 'https://www.luogu.com.cn/problem/CF1A',
    title: 'checked',
    availability,
    retrievedAt: fx.AT,
    ...(availability === 'found' && typeof text === 'string' && text.trim().length > 0 ? { text } : {}),
    ...(availability === 'found' && (text === null || text.trim().length === 0) ? { text: 'placeholder body' } : {}),
  });
  const solution =
    text === null
      ? []
      : [
          createEditorialSolution({
            solutionId: `${sourceId}-s1`,
            sourceId,
            ordinal: 0,
            title: 'body',
            text: text.trim().length === 0 ? 'placeholder' : text,
          }),
        ];
  const base = createProblemSnapshot({ problem: fx.makeProblem(ref), sources: [source], solutions: solution, capturedAt: fx.AT });
  if (text === null || text.trim().length > 0) {
    return base;
  }
  // The blank-body case: the reference is real, the body it points at is not.
  return Object.freeze({
    ...base,
    solutions: base.solutions.map((entry) => Object.freeze({ ...entry, text })),
  });
}

function snapshotWithFoundMaterial(ref: ProblemRef, sourceId: string, text: string): ProblemSnapshot {
  const source = createEditorialSource({
    id: sourceId,
    kind: 'editorial',
    url: 'https://example.org/answer',
    title: 'provided',
    availability: 'found',
    retrievedAt: fx.AT,
    text,
  });
  const solution = createEditorialSolution({ solutionId: `${sourceId}-s1`, sourceId, ordinal: 0, title: 'answer', text });
  return createProblemSnapshot({ problem: fx.makeProblem(ref), sources: [source], solutions: [solution], capturedAt: fx.AT });
}

// ---------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------

void test('a found mirror answer keeps its identity and gains the mapping provenance', () => {
  const identity = mirrorEditorialRequestOf({
    sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID,
    domain: null,
    externalKey: 'CF1A',
  });
  assert.ok(identity);
  const original = foundEditorial('cf-blog-12345', OFFICIAL_BLOG_URL, CF_SOLUTION_TEXT, {
    note: 'section 1A of blog 12345',
  });
  const stamped = withMirrorProvenance(original, identity.identity);
  assert.equal(stamped.status, 'found');
  assert.ok(stamped.status === 'found');
  const source = stamped.sources[0];
  assert.ok(source);
  // Identity, attribution and hash are untouched: only the note gained the mapping.
  assert.equal(source.id, 'cf-blog-12345');
  assert.equal(source.url, OFFICIAL_BLOG_URL);
  assert.equal(source.availability, 'found');
  assert.equal(source.contentHash, original.status === 'found' ? original.sources[0]?.contentHash : null);
  assert.ok(source.note?.includes(CF_MIRROR_EDITORIAL_RULE_TAG));
  assert.ok(source.note?.includes('1A'));
  assert.ok(source.note?.includes('CF1A'));
  assert.ok(source.note?.startsWith(CF_MIRROR_EDITORIAL_NOTE_PREFIX));
  // The adapter's own note survives, because it is what proves the body is one blog's section.
  assert.ok(source.note?.includes('section 1A of blog 12345'));
  assert.equal(stamped.solutions.length, 1);
  assert.equal(stamped.solutions[0]?.text, CF_SOLUTION_TEXT);

  // A note that carries no adapter detail is still self-describing.
  assert.equal(mirrorEditorialNote(identity.identity, null).includes(CF_MIRROR_EDITORIAL_RULE_TAG), true);
  assert.equal(mirrorEditorialNote(identity.identity, '  ').includes(' | '), false);
});

void test('a non-found answer is never rewritten by the provenance stamp', () => {
  const identity = mirrorEditorialRequestOf({
    sourceInstanceId: LUOGU_OFFICIAL_INSTANCE_ID,
    domain: null,
    externalKey: 'CF1A',
  });
  assert.ok(identity);
  for (const status of ['unavailable', 'rate_limited', 'changed_response', 'auth_required', 'forbidden', 'absent'] as const) {
    const result: EditorialFetchResult =
      status === 'rate_limited'
        ? { status, detail: 'slow down', retryAfterMs: 5000 }
        : status === 'unavailable'
          ? { status, detail: 'no tutorial link', retryable: false }
          : status === 'changed_response'
            ? { status, detail: 'no heading', sample: null }
            : { status, detail: 'detail' };
    const stamped = withMirrorProvenance(result, identity.identity);
    assert.deepEqual(stamped, result, `${status} must pass through unchanged`);
  }
});

// ---------------------------------------------------------------------------------------
// The service path
// ---------------------------------------------------------------------------------------

void test('a Luogu CF mirror borrows the editorial from the exact equivalent Codeforces problem', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    const codeforces = makeScopeFor(CODEFORCES_MAIN_INSTANCE_ID, '1900A', 'Original CF problem');
    await store.upsertSourceInstances([luogu.instance, codeforces.instance]);
    await store.upsertProblems([luogu.problem]);

    const luoguAdapter = new FakeAdapter(luogu.instance);
    // The statement still comes from Luogu...
    luoguAdapter.problemResults.push(fx.makeProblem(luogu.problem.ref, { statement: '洛谷题面', fetchedAt: fx.LATER }));
    // ...and Luogu's own editorial is never requested, because the mirror answered.
    const port = new RecordingMirrorPort();
    port.results.push(foundEditorial('cf-blog-12345', OFFICIAL_BLOG_URL, CF_SOLUTION_TEXT));

    const report = await service.refreshMaterial(luoguAdapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: true,
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });

    // The derived reference is exactly the equivalent Codeforces problem, built server-side.
    assert.equal(port.requests.length, 1);
    assert.deepEqual(port.requests[0]?.cfRef, {
      sourceInstanceId: CODEFORCES_MAIN_INSTANCE_ID,
      domain: null,
      externalKey: '1900A',
    });
    assert.deepEqual(port.requests[0]?.target, luogu.problem.ref);
    // The target's own adapter answered the statement and was never asked for an editorial.
    assert.deepEqual(
      luoguAdapter.calls.map((call) => call.operation),
      ['fetchProblem'],
    );
    assert.equal(report.statement.status, 'fetched');
    assert.equal(report.editorial.attempted, true);
    assert.equal(report.editorial.result?.status, 'found');
    assert.deepEqual(report.mirror, { status: 'fetched', skippedReason: null, key: '1900A' });

    // The write landed: statement from Luogu, editorial from the official Codeforces blog.
    const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
    assert.ok(snapshot);
    assert.equal(snapshot.problem.key, luogu.problem.key);
    assert.equal(snapshot.problem.statement, '洛谷题面');
    const source = snapshot.sources.find((entry) => entry.id === 'cf-blog-12345');
    assert.ok(source, 'the Codeforces blog source must be stored');
    assert.equal(source.url, OFFICIAL_BLOG_URL);
    assert.equal(source.availability, 'found');
    assert.ok(source.note?.includes(CF_MIRROR_EDITORIAL_RULE_TAG));
    assert.equal(snapshot.solutions.find((entry) => entry.sourceId === 'cf-blog-12345')?.text, CF_SOLUTION_TEXT);
    assert.equal(report.material?.freshFound, true);
  });
});

void test('nothing but the editorial crosses the mirror: tags, submissions and bank rows stay put', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    // The Codeforces record carries its own raw tags and an accepted submission; neither may travel.
    const codeforces = makeScopeFor(CODEFORCES_MAIN_INSTANCE_ID, '1900A', 'Original CF problem');
    await store.upsertSourceInstances([luogu.instance, codeforces.instance]);
    await store.upsertAccounts([codeforces.account]);
    await store.upsertProblems([luogu.problem, codeforces.problem]);
    await store.upsertSubmissions([
      fx.makeSubmission(codeforces.account, codeforces.problem.ref, 'CF-S1', 'accepted'),
    ]);
    const beforeTags = JSON.stringify(luogu.problem.rawTags);

    const luoguAdapter = new FakeAdapter(luogu.instance);
    const port = new RecordingMirrorPort();
    port.results.push(foundEditorial('cf-blog-12345', OFFICIAL_BLOG_URL, CF_SOLUTION_TEXT));
    const report = await service.refreshMaterial(luoguAdapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: false,
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });

    const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
    assert.ok(snapshot);
    // The target problem keeps its own identity, raw tags and url; no Codeforces problem row, tag,
    // submission or decision was created for it.
    assert.equal(snapshot.problem.key, luogu.problem.key);
    assert.equal(snapshot.problem.url, luogu.problem.url);
    assert.equal(JSON.stringify(snapshot.problem.rawTags), beforeTags);
    assert.deepEqual(await store.listTagDecisions(luogu.problem.key), []);
    assert.deepEqual(await store.listAnalyses(luogu.problem.key), []);
    assert.equal((await store.getProblem(luogu.problem.key))?.ref.externalKey, 'CF1900A');
    // The Codeforces side is untouched: its own submission is still exactly what it was.
    const cfSubmissions = await store.listSubmissions(codeforces.account.id, { cursor: null, limit: 10 });
    assert.equal(cfSubmissions.items.length, 1);
    assert.equal(cfSubmissions.items[0]?.verdict, 'accepted');
    assert.equal(cfSubmissions.items[0]?.ref.externalKey, '1900A');
  });
});

void test('a Codeforces problem never borrows from Luogu, and no port is asked', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const codeforces = makeScopeFor(CODEFORCES_MAIN_INSTANCE_ID, '1900A', 'Original CF problem');
    await store.upsertSourceInstances([codeforces.instance]);
    await store.upsertProblems([codeforces.problem]);

    const adapter = new FakeAdapter(codeforces.instance);
    adapter.editorialResults.push({ status: 'absent', detail: 'the problem page has no editorial link' });
    const port = new RecordingMirrorPort();
    const report = await service.refreshMaterial(adapter, {
      problemRef: codeforces.problem.ref,
      fetchStatement: false,
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });

    assert.equal(port.requests.length, 0, 'the port must not be called for a Codeforces target');
    assert.deepEqual(report.mirror, { status: 'skipped', skippedReason: 'mirror_not_applicable', key: null });
    assert.equal(report.editorial.result?.status, 'absent');
    assert.deepEqual(
      adapter.calls.map((call) => call.operation),
      ['fetchEditorial'],
    );
  });
});

void test('a non-mirror Luogu problem keeps its own editorial path', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'P1001', '普通洛谷题');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertProblems([luogu.problem]);

    const adapter = new FakeAdapter(luogu.instance);
    adapter.editorialResults.push(foundEditorial('luogu-solution-1', 'https://www.luogu.com.cn/problem/solution/P1001', LUOGU_SOLUTION_TEXT));
    const port = new RecordingMirrorPort();
    const report = await service.refreshMaterial(adapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: false,
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });

    assert.equal(port.requests.length, 0);
    assert.deepEqual(report.mirror, { status: 'skipped', skippedReason: 'mirror_not_applicable', key: null });
    const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
    assert.equal(snapshot?.solutions[0]?.text, LUOGU_SOLUTION_TEXT);
  });
});

void test('existing usable material is reused instead of spending a Codeforces request', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    await storeMaterial(store, luogu.problem, 'user-answer-aaaa', 'My own correct write-up.', 'https://example.org/mine');

    const adapter = new FakeAdapter(luogu.instance);
    // The target's own adapter is still consulted (its answer is what the refresh is about) …
    adapter.editorialResults.push({
      status: 'unavailable',
      detail: 'Luogu does not publish a usable solution',
      retryable: false,
    });
    const port = new RecordingMirrorPort();
    port.results.push(foundEditorial('cf-blog-12345', OFFICIAL_BLOG_URL, CF_SOLUTION_TEXT));

    const report = await service.refreshMaterial(adapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: false,
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });

    // … but no Codeforces request is made while a usable editorial is already stored.
    assert.equal(port.requests.length, 0);
    assert.deepEqual(report.mirror, { status: 'skipped', skippedReason: 'existing_editorial_reusable', key: null });
    assert.equal(report.material?.staleCachedAvailability, 'found');
    const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
    assert.equal(snapshot?.sources.find((entry) => entry.id === 'user-answer-aaaa')?.availability, 'found');
    assert.equal(snapshot?.solutions.find((entry) => entry.sourceId === 'user-answer-aaaa')?.text, 'My own correct write-up.');
  });
});

void test('an explicitly supplied official tutorial wins over the equivalent-problem path', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertProblems([luogu.problem]);

    const adapter = new FakeAdapter(luogu.instance);
    adapter.editorialResults.push(foundEditorial('cf-blog-999', 'https://codeforces.com/blog/entry/999', CF_SOLUTION_TEXT));
    const port = new RecordingMirrorPort();
    const report = await service.refreshMaterial(adapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: false,
      officialTutorialUrl: 'https://codeforces.com/blog/entry/999',
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });
    assert.equal(port.requests.length, 0);
    assert.deepEqual(report.mirror, { status: 'skipped', skippedReason: 'mirror_not_applicable', key: null });
    assert.equal(report.editorial.result?.status, 'found');
  });
});

void test('a missing Codeforces source is reported, never substituted', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertProblems([luogu.problem]);

    const adapter = new FakeAdapter(luogu.instance);
    adapter.editorialResults.push({ status: 'unavailable', detail: 'Luogu needs a session for this solution', retryable: false });
    const report = await service.refreshMaterial(adapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: false,
      mirrorEditorial: null,
      token,
      limits: LIMITS,
    });
    assert.deepEqual(report.mirror, { status: 'skipped', skippedReason: 'cf_source_unavailable', key: null });
    assert.equal(report.editorial.result?.status, 'unavailable');
  });
});

// ---------------------------------------------------------------------------------------
// Failures keep the old material, and are never turned into an absence
// ---------------------------------------------------------------------------------------

void test('a Codeforces operational failure is preserved verbatim and never becomes an absence', async () => {
  const failures: readonly { readonly result: EditorialFetchResult; readonly status: string }[] = [
    { result: { status: 'unavailable', detail: 'the problem page has no Tutorial link', retryable: false }, status: 'unavailable' },
    { result: { status: 'rate_limited', detail: 'too many requests', retryAfterMs: 2000 }, status: 'rate_limited' },
    { result: { status: 'changed_response', detail: 'the blog has no heading that names problem 1900A', sample: null }, status: 'changed_response' },
    { result: { status: 'auth_required', detail: 'login required' }, status: 'auth_required' },
    { result: { status: 'forbidden', detail: 'blocked' }, status: 'forbidden' },
  ];
  for (const entry of failures) {
    await withStore(async (store) => {
      const service = serviceFor(store);
      const token = createCancellationSource().token;
      const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
      await storeMaterial(store, luogu.problem, 'user-answer-bbbb', 'A user-provided answer that must survive.', 'https://example.org/keep');

      const adapter = new FakeAdapter(luogu.instance);
      const port = new RecordingMirrorPort();
      port.results.push(entry.result);
      const report = await service.refreshMaterial(adapter, {
        problemRef: luogu.problem.ref,
        fetchStatement: false,
        // The mirror path is forced so this case is about what a Codeforces answer does to the stored
        // material; the reuse default is covered by its own case below.
        reuseExistingEditorial: false,
        mirrorEditorial: port,
        token,
        limits: LIMITS,
      });

      // The declared availability is exactly what Codeforces said — and specifically not `absent`.
      assert.equal(report.editorial.result?.status, entry.status);
      assert.notEqual(report.editorial.result?.status, 'absent');
      assert.deepEqual(report.mirror, { status: 'fetched', skippedReason: null, key: '1900A' });
      assert.equal(report.material?.freshFound, false);
      assert.equal(report.material?.staleCachedAvailability, 'found');
      // The previously stored material is untouched: a failed refresh never discards good material.
      const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
      assert.equal(snapshot?.sources.find((source) => source.id === 'user-answer-bbbb')?.availability, 'found');
      assert.equal(
        snapshot?.solutions.find((solution) => solution.sourceId === 'user-answer-bbbb')?.text,
        'A user-provided answer that must survive.',
      );
      // The check record names the equivalent problem it belongs to and keeps the failure as a check,
      // never as an absence.
      const check = snapshot?.sources.find((source) => source.id === editorialSourceIdOf(luogu.problem.ref, luogu.problem.url));
      assert.ok(check, 'the material check record must be stored');
      assert.equal(check.availability, entry.status);
      assert.notEqual(check.availability, 'absent');
      assert.ok(check.note?.includes('1900A'), 'the check must say which equivalent problem answered');
    });
  }
});

void test('a thrown platform error from the equivalent problem is converted, not propagated', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertProblems([luogu.problem]);

    const adapter = new FakeAdapter(luogu.instance);
    const port = new RecordingMirrorPort();
    port.results.push(new PlatformError({ code: 'rate_limited', operation: 'editorial', retryable: true, detail: 'slow down' }));
    const report = await service.refreshMaterial(adapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: false,
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });
    assert.equal(report.editorial.result?.status, 'rate_limited');
    assert.equal(report.editorial.error?.code, 'rate_limited');
  });
});

void test('a found answer without a usable body is refused instead of stored as fresh material', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertProblems([luogu.problem]);

    const adapter = new FakeAdapter(luogu.instance);
    const port = new RecordingMirrorPort();
    port.results.push({ status: 'found', sources: [], solutions: [], retrievedAt: fx.LATER });
    const report = await service.refreshMaterial(adapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: false,
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });
    assert.equal(report.editorial.result?.status, 'changed_response');
    assert.equal(report.material?.freshFound, false);
  });
});

// ---------------------------------------------------------------------------------------
// Head-CAS, cancellation and redaction
// ---------------------------------------------------------------------------------------

/** The concurrent head-publishing write, awaited by the CAS case once it has run. */
function deferred(): { readonly promise: Promise<void>; readonly settle: () => void } {
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle: () => settle() };
}

void test('a head that changes during the equivalent-problem fetch refuses the commit', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    const first = await storeMaterial(store, luogu.problem, 'user-answer-cccc', 'First stored answer.', 'https://example.org/first');
    assert.ok(first.snapshotId.length > 0);

    // Another writer publishes a newer head while the equivalent-problem fetch is in flight. It must
    // differ in content, not only in timestamp: snapshot identity is its semantic content, and it
    // chains onto the snapshot it supersedes the way every real writer does.
    const concurrentSnapshot: { value: ProblemSnapshot | null } = { value: null };
    const published = deferred();
    const adapter = new FakeAdapter(luogu.instance);
    const port = new RecordingMirrorPort();
    port.results.push(foundEditorial('cf-blog-12345', OFFICIAL_BLOG_URL, CF_SOLUTION_TEXT));
    port.afterFetch = async () => {
      const changed = fx.makeProblem(luogu.problem.ref, { statement: '题面被同时改写', fetchedAt: fx.LATER });
      concurrentSnapshot.value = await storeMaterial(
        store,
        changed,
        'user-answer-dddd',
        'Second stored answer.',
        'https://example.org/second',
        { previous: first },
      );
      published.settle();
    };

    await assert.rejects(
      () =>
        service.refreshMaterial(adapter, {
          problemRef: luogu.problem.ref,
          fetchStatement: false,
          reuseExistingEditorial: false,
          mirrorEditorial: port,
          token,
          limits: LIMITS,
        }),
      isDomain('invalid_transition'),
    );
    // The race really happened: the writer published a new head, and the commit refused it.
    await Promise.race([published.promise, delay(2000).then(() => assert.fail('the concurrent writer never ran'))]);
    assert.equal(port.requests.length, 1);
    assert.ok(concurrentSnapshot.value, 'the concurrent writer must have published a newer head');

    // The stale write is rejected: the newer head is still current and holds its own material, and
    // the borrowed Codeforces source was never committed against it.
    const head = await store.getCurrentSnapshotHead(luogu.problem.ref);
    assert.equal(head?.snapshotId, concurrentSnapshot.value?.snapshotId);
    const snapshot = await store.getSnapshot(head?.snapshotId ?? '');
    assert.equal(snapshot?.sources.some((source) => source.id === 'cf-blog-12345'), false);
    assert.equal(snapshot?.sources.some((source) => source.id === 'user-answer-dddd'), true);
    assert.equal(snapshot?.sources.some((source) => source.id === 'user-answer-cccc'), false);
  });
});

void test('cancellation during the equivalent-problem fetch propagates and writes nothing', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const source = createCancellationSource();
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertProblems([luogu.problem]);

    const adapter = new FakeAdapter(luogu.instance);
    const port = new RecordingMirrorPort();
    port.results.push(foundEditorial('cf-blog-12345', OFFICIAL_BLOG_URL, CF_SOLUTION_TEXT));
    port.afterFetch = async () => {
      source.cancel('the user navigated away');
    };

    await assert.rejects(
      () =>
        service.refreshMaterial(adapter, {
          problemRef: luogu.problem.ref,
          fetchStatement: false,
          mirrorEditorial: port,
          token: source.token,
          limits: LIMITS,
        }),
      isDomain('cancelled'),
    );
    assert.equal(await store.getCurrentSnapshotHead(luogu.problem.ref), null);
  });
});

void test('the mirror member of the report carries identity only, never a body or a URL', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF1900A', '洛谷镜像题');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertProblems([luogu.problem]);

    const adapter = new FakeAdapter(luogu.instance);
    const port = new RecordingMirrorPort();
    port.results.push(foundEditorial('cf-blog-12345', OFFICIAL_BLOG_URL, CF_SOLUTION_TEXT));
    const report = await service.refreshMaterial(adapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: false,
      mirrorEditorial: port,
      token,
      limits: LIMITS,
    });

    const serialized = JSON.stringify({ mirror: report.mirror, editorial: editorialSummary(report.material) });
    for (const leak of [CF_SOLUTION_TEXT, OFFICIAL_BLOG_URL, 'cf-blog-12345', CF_MIRROR_EDITORIAL_RULE_TAG, 'section 1900A of blog']) {
      assert.equal(serialized.includes(leak), false, `the projection must not carry ${leak}`);
    }
    assert.deepEqual(report.mirror, { status: 'fetched', skippedReason: null, key: '1900A' });
  });
});

/** The metadata-only half of a material report, for the redaction assertion. */
function editorialSummary(material: MaterialReport | null): unknown {
  return material === null
    ? null
    : {
        outcome: material.outcome,
        availability: material.availability,
        freshFound: material.freshFound,
        sources: material.sources,
        solutions: material.solutions,
      };
}

// ---------------------------------------------------------------------------------------
// The two-level mapping: a Luogu mirror whose Codeforces problem is answered by a shared round
// ---------------------------------------------------------------------------------------

/**
 * The Luogu side of the two-level mapping.
 *
 * A real `LuoguAdapter` needs its own origin-bound transport, and the statement path is not what
 * this test is about; what matters here is that the *editorial* never goes through Luogu, so this
 * records whether Luogu's editorial method was reached at all.
 */
class RecordingLuoguAdapter implements PlatformAdapter {
  readonly sourceInstance = luoguOfficialInstance();
  readonly calls: string[] = [];

  capabilities(): PlatformCapabilities {
    return {
      platform: 'luogu',
      implemented: true,
      problems: true,
      submissions: false,
      editorial: false,
      pagedProblems: true,
      pagedSubmissions: false,
      requiresAuth: true,
      supportsAccountHistory: false,
      minRequestIntervalMs: null,
      notes: [],
    };
  }

  async listProblems(): Promise<never> {
    throw new Error('unexpected listProblems');
  }

  async listSubmissions(): Promise<never> {
    throw new Error('unexpected listSubmissions');
  }

  async fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem> {
    this.calls.push('fetchProblem');
    return createNormalizedProblem({
      ref: request.problemRef,
      title: '洛谷镜像题',
      url: 'https://www.luogu.com.cn/problem/CF879E',
      statement: '洛谷题面正文',
      fetchedAt: fx.LATER,
      ratings: [],
      rawTags: [],
    });
  }

  async fetchEditorial(): Promise<never> {
    this.calls.push('fetchEditorial');
    throw new Error('Luogu must not be asked for the editorial of a mirror');
  }
}

/** The canonical official Luogu instance, so the mirror rule recognizes the target. */
function luoguOfficialInstance(): SourceInstance {
  return createSourceInstance({ platform: 'luogu', baseUrl: 'https://www.luogu.com.cn', displayName: 'Luogu' });
}

/** The two-contest `contest.standings` payload of one shared round, answered by contest id. */
function sharedRoundRoute(): (url: URL) => Response {
  const contests: Record<number, unknown> = {
    878: {
      status: 'OK',
      result: {
        contest: {
          id: 878,
          name: 'Codeforces Round 878 (Div. 1)',
          startTimeSeconds: 1_650_000_000,
          durationSeconds: 7200,
        },
        problems: [],
        rows: [],
      },
    },
    879: {
      status: 'OK',
      result: {
        contest: {
          id: 879,
          name: 'Codeforces Round 878 (Div. 2)',
          startTimeSeconds: 1_650_000_000,
          durationSeconds: 7200,
        },
        problems: [],
        rows: [],
      },
    },
  };
  return (url) => {
    const id = Number(url.searchParams.get('contestId'));
    assert.equal(
      url.search,
      `?contestId=${String(id)}&from=1&count=1&showUnofficial=false`,
      'the shared-round lookup must request only one official standings row',
    );
    const payload = contests[id];
    return payload === undefined
      ? jsonResponse({ status: 'FAILED', comment: 'contest not found' }, 400)
      : jsonResponse(payload);
  };
}

/** One shared-round blog: the section is labelled only by division. */
function sharedRoundBlog(): unknown {
  return {
    status: 'OK',
    result: {
      id: 55435,
      title: 'Codeforces Round 878 editorial',
      content:
        '<div class="content"><p><a href="/contest/878">878</a> <a href="/contest/879">879</a></p>' +
        '<h3>Div. 1 E</h3><p>The shared write-up for both divisions.</p></div>',
      creationTimeSeconds: 1_650_000_000,
    },
  };
}

void test('a Luogu mirror reaches the shared-round section through both verified mappings', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF879E', '洛谷镜像题');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertProblems([luogu.problem]);

    // The real Codeforces adapter answers the equivalent problem. Its own shared-round rules apply,
    // so `879E` may legitimately be answered from `878E`'s section.
    const cfHarness = createHttpHarness({
      routes: {
        '/problemset/problem/879/E': () =>
          htmlResponse(problemPageHtml({ index: 'E', title: 'Shared problem', tutorialBlogId: 55435 })),
        '/problemset/problem/878/E': () =>
          htmlResponse(problemPageHtml({ index: 'E', title: 'Shared problem', tutorialBlogId: 55435 })),
        '/api/blogEntry.view': () => jsonResponse(sharedRoundBlog()),
        '/api/contest.standings': sharedRoundRoute(),
      },
    });
    const cfAdapter = createCodeforcesAdapter({ transport: cfHarness.transport });
    const luoguAdapter = new RecordingLuoguAdapter();

    const report = await service.refreshMaterial(luoguAdapter, {
      problemRef: luogu.problem.ref,
      fetchStatement: true,
      mirrorEditorial: {
        fetchMirrorEditorial: (request) =>
          cfAdapter.fetchEditorial({ problemRef: request.cfRef, token: request.token, limits: request.limits }),
      },
      token,
      limits: LIMITS,
    });

    assert.equal(report.statement.status, 'fetched');
    assert.equal(luoguAdapter.calls.includes('fetchEditorial'), false, 'Luogu must not answer the editorial');
    assert.deepEqual(luoguAdapter.calls, ['fetchProblem']);
    assert.equal(report.mirror.status, 'fetched');
    assert.equal(report.mirror.key, '879E');
    assert.equal(report.editorial.result?.status, 'found');

    const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
    const source = snapshot?.sources[0];
    assert.ok(source);
    const note = source.note ?? '';
    // Level 1: the Luogu mirror identity that selected the equivalent Codeforces problem.
    assert.match(note, /luogu_cf_identifier/);
    assert.match(note, /879E/);
    // Level 2: the shared-round identity that selected the section inside the shared blog.
    assert.match(note, /cf-editorial-alias-v1/);
    assert.match(note, /method=official_division_pair/);
    assert.match(note, /section=878E/);
    // The stored attribution is the official blog, and the solution belongs to the requested problem.
    assert.equal(source.url, 'https://codeforces.com/blog/entry/55435');
    assert.match(snapshot?.solutions[0]?.solutionId ?? '', /-879E$/);
    assert.match(snapshot?.solutions[0]?.text ?? '', /shared write-up for both divisions/);
    // The statement still came from Luogu.
    assert.equal(snapshot?.problem.statement, '洛谷题面正文');
    // The two-level mapping never guesses the Luogu key of the *other* division.
    assert.equal(note.includes('CF878E'), false);
  });
});

void test('the shared-round redirect still refuses to write when the target head moved', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const luogu = makeScopeFor(LUOGU_OFFICIAL_INSTANCE_ID, 'CF879E', '洛谷镜像题');
    const first = await storeMaterial(store, luogu.problem, 'user-answer-eeee', 'First stored answer.', 'https://example.org/first');

    const cfHarness = createHttpHarness({
      routes: {
        '/problemset/problem/879/E': () =>
          htmlResponse(problemPageHtml({ index: 'E', title: 'Shared problem', tutorialBlogId: 55435 })),
        '/problemset/problem/878/E': () =>
          htmlResponse(problemPageHtml({ index: 'E', title: 'Shared problem', tutorialBlogId: 55435 })),
        '/api/blogEntry.view': () => jsonResponse(sharedRoundBlog()),
        '/api/contest.standings': sharedRoundRoute(),
      },
    });
    const cfAdapter = createCodeforcesAdapter({ transport: cfHarness.transport });
    const published = deferred();
    const concurrent: { value: ProblemSnapshot | null } = { value: null };
    const port = {
      fetchMirrorEditorial: async (request: {
        readonly cfRef: ProblemRef;
        readonly token: Parameters<typeof cfAdapter.fetchEditorial>[0]['token'];
        readonly limits: PlatformLimits;
      }) => {
        const result = await cfAdapter.fetchEditorial({
          problemRef: request.cfRef,
          token: request.token,
          limits: request.limits,
        });
        const changed = fx.makeProblem(luogu.problem.ref, { statement: '题面被同时改写', fetchedAt: fx.LATER });
        concurrent.value = await storeMaterial(
          store,
          changed,
          'user-answer-ffff',
          'Second stored answer.',
          'https://example.org/second',
          { previous: first },
        );
        published.settle();
        return result;
      },
    };

    await assert.rejects(
      () =>
        service.refreshMaterial(new RecordingLuoguAdapter(), {
          problemRef: luogu.problem.ref,
          fetchStatement: false,
          reuseExistingEditorial: false,
          mirrorEditorial: port,
          token,
          limits: LIMITS,
        }),
      isDomain('invalid_transition'),
    );
    await Promise.race([published.promise, delay(2000).then(() => assert.fail('the concurrent writer never ran'))]);

    const head = await store.getCurrentSnapshotHead(luogu.problem.ref);
    assert.equal(head?.snapshotId, concurrent.value?.snapshotId);
    const snapshot = await store.getSnapshot(head?.snapshotId ?? '');
    assert.equal(snapshot?.sources.some((entry) => entry.id === 'cf-blog-55435'), false);
    assert.equal(snapshot?.sources.some((entry) => entry.id === 'user-answer-ffff'), true);
  });
});
