/**
 * Business API endpoints over a real SQLite store, the real `ImportService` and the real
 * `WorkbenchService` (Stage 4h1 repair 1).
 *
 * Each case drives the registered Fetch route with a real `Request`/`Response`, so the assertions
 * cover externally meaningful behaviour: official account canonicalization and instance isolation,
 * cancellation rollback, operational platform failures as data (auth vs rate limit vs unsupported),
 * manual preview/apply with the hash gate, found/absent supplementation over hidden metadata,
 * recursively redacted refresh answers, real bank/review/retro/weakness/plan delegation, strict
 * refusal of unknown fields and sanitized 500s with an observer. The platform is a fake adapter and
 * the registry is an in-process double; nothing reaches a socket, a model or a paid API.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import { editorialSourceIdOf } from '../../src/application/import-types.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import type { PlatformAdapter, PlatformCapabilities, TrainingStore } from '../../src/application/ports.js';
import { defaultWorkbenchSettings } from '../../src/application/workbench-settings.js';
import { WORKBENCH_API_OPERATIONS, USER_ANSWER_SOURCE_ID_PREFIX } from '../../src/application/workbench-api.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  accountIdOf,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  createSourceInstance,
  createTaxonomyIndex,
  problemKey,
  type SourceInstance,
} from '../../src/domain/index.js';
import { API_PREFIX, type ApiEnvelope, type ApiErrorBody } from '../../src/plugin/api-transport.js';
import {
  registerBusinessApi,
  userAnswerProvenanceNote,
  userAnswerSourceIdOf,
  USER_ANSWER_SOURCE_TITLE,
  type BusinessSourceConfig,
  type RegisterBusinessApiOptions,
} from '../../src/plugin/business-api.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-12-01T08:00:00.000Z';
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** An id that exists in the shipped vocabulary; `review.tag` only accepts known tags. */
const STACK = 'data-structure.stack';
const SECRET = 'SECRET-ALGORITHM-SENTINEL';
const RAW_TAG_SENTINEL = 'RAW-PLATFORM-TAG-SENTINEL';

const CF = createSourceInstance({
  platform: 'codeforces',
  baseUrl: 'https://codeforces.com',
  displayName: 'Codeforces',
});
const LG = createSourceInstance({
  platform: 'luogu',
  baseUrl: 'https://www.luogu.com.cn',
  displayName: 'Luogu',
});
const SOURCES: readonly BusinessSourceConfig[] = [{ instance: CF }, { instance: LG }];
const SETTINGS = { revision: 1, value: defaultWorkbenchSettings() };

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly clock: { value: string };
  readonly registry: HostConnectionFetch;
  post(operation: string, body: unknown, signal?: AbortSignal): Promise<Response>;
  dispose(): Promise<void>;
}

interface BenchOptions {
  readonly sources?: readonly BusinessSourceConfig[];
  readonly store?: (real: SqliteTrainingStore) => TrainingStore;
  readonly adapter?: (instance: SourceInstance) => PlatformAdapter;
  readonly onInternalError?: (error: unknown, context: { readonly operation: string }) => void;
  readonly onDisposeError?: (error: unknown, context: { readonly operation: string }) => void;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Run `work` while watching for unhandled rejections; async cleanup must never leak one. */
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

async function envelope(response: Response): Promise<ApiEnvelope<unknown>> {
  return (await response.json()) as ApiEnvelope<unknown>;
}

function failureOf(body: ApiEnvelope<unknown>): ApiErrorBody {
  if (body.ok) {
    assert.fail(`expected a failed envelope, received ${JSON.stringify(body)}`);
  }
  return body.error;
}

/** Call one endpoint and require a successful envelope, returning its value. */
async function ok(bench: Bench, operation: string, body: unknown): Promise<any> {
  const response = await bench.post(operation, body);
  const parsed = await envelope(response);
  assert.equal(response.status, 200, `${operation} should succeed: ${JSON.stringify(parsed)}`);
  if (!parsed.ok) {
    assert.fail(`${operation} answered a failed envelope`);
  }
  return parsed.value;
}

/** Call one endpoint and require the given refusal status. */
async function refused(bench: Bench, operation: string, body: unknown, status: number): Promise<ApiEnvelope<unknown>> {
  const response = await bench.post(operation, body);
  const parsed = await envelope(response);
  assert.equal(response.status, status, `${operation} should be refused with ${status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

function createRegistry(): {
  readonly registry: HostConnectionFetch;
  readonly routes: Map<string, ConnectionFetchRoute>;
} {
  const routes = new Map<string, ConnectionFetchRoute>();
  const registry: HostConnectionFetch = {
    register(route) {
      routes.set(route.path, route);
      return async () => {
        routes.delete(route.path);
      };
    },
  };
  return { registry, routes };
}

async function withBench(options: BenchOptions, run: (bench: Bench) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const clock = { value: AT };
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
  let minted = 0;
  const imports = new ImportService({ store, now: () => clock.value });
  const workbench = new WorkbenchService({
    store,
    taxonomy: TAXONOMY,
    now: () => clock.value,
    uniqueId: () => `mint-${(minted += 1)}`,
  });
  const sources = options.sources ?? SOURCES;
  const { registry, routes } = createRegistry();
  const dispose = await registerBusinessApi({
    registry,
    store: options.store === undefined ? store : options.store(store),
    imports,
    workbench,
    adapterFor: async (sourceInstanceId) => {
      const instance = sources.find((source) => source.instance.id === sourceInstanceId)?.instance;
      assert.ok(instance, `adapterFor(${sourceInstanceId}) has no configured source`);
      assert.ok(options.adapter !== undefined, `no adapter is configured for ${sourceInstanceId}`);
      return options.adapter(instance);
    },
    sources,
    settings: async () => SETTINGS,
    now: () => clock.value,
    uniqueId: () => `id-${(minted += 1)}`,
    ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError }),
    ...(options.onDisposeError === undefined ? {} : { onDisposeError: options.onDisposeError }),
  });
  const post = async (operation: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const route = routes.get(`${API_PREFIX}${operation}`);
    assert.ok(route, `route ${operation} must be registered`);
    return route.fetch(
      new Request(`http://localhost${API_PREFIX}${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  };
  try {
    await run({ store, clock, registry, post, dispose });
  } finally {
    await dispose();
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

/** A real store whose transaction waits for `gate`, so cancellation can be observed mid-handler. */
function gatedStore(real: SqliteTrainingStore, gate: Promise<void>): TrainingStore {
  return new Proxy(real as TrainingStore, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async (work: () => Promise<unknown>) => {
          await gate;
          return target.transaction(work);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A real store whose `getProblem` fails, to prove an unexpected failure stays a sanitized 500. */
function throwingStore(real: SqliteTrainingStore, boom: Error): TrainingStore {
  return new Proxy(real as TrainingStore, {
    get(target, property, receiver) {
      if (property === 'getProblem') {
        return async () => {
          throw boom;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function capabilitiesOf(instance: SourceInstance, overrides: Partial<PlatformCapabilities> = {}): PlatformCapabilities {
  return {
    platform: instance.platform,
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
    ...overrides,
  };
}

/** Fake official platform adapter; every unset operation is an honest failure, not a fake answer. */
function fakeAdapter(
  instance: SourceInstance,
  parts: {
    readonly capabilities?: Partial<PlatformCapabilities>;
    readonly listProblems?: PlatformAdapter['listProblems'];
    readonly fetchProblem?: PlatformAdapter['fetchProblem'];
    readonly fetchEditorial?: PlatformAdapter['fetchEditorial'];
  } = {},
): PlatformAdapter {
  return {
    sourceInstance: instance,
    capabilities: () => capabilitiesOf(instance, parts.capabilities),
    listProblems: parts.listProblems ?? (async () => ({ items: [], nextCursor: null, fetchedAt: AT })),
    listSubmissions: async () => ({ items: [], nextCursor: null, fetchedAt: AT }),
    fetchProblem:
      parts.fetchProblem ??
      (async () => {
        throw new Error('fetchProblem is not part of this test');
      }),
    fetchEditorial: parts.fetchEditorial ?? (async () => ({ status: 'absent', detail: 'no editorial' })),
  };
}

async function seedScope(store: SqliteTrainingStore, scope: fx.Scope): Promise<void> {
  await store.upsertSourceInstances([scope.instance]);
  await store.upsertAccounts([scope.account]);
  await store.upsertProblems([scope.problem]);
}

// ---------------------------------------------------------------------------------------
// account.create
// ---------------------------------------------------------------------------------------

void test('account.create canonicalizes the handle and stores one instance+account pair', async () => {
  await withBench({}, async (bench) => {
    const created = await ok(bench, 'account.create', {
      platform: 'codeforces',
      handle: ' Alice ',
      displayName: 'Alice',
    });

    assert.deepEqual(created.account, {
      id: accountIdOf(CF.id, 'alice'),
      sourceInstanceId: CF.id,
      handle: 'alice',
      displayName: 'Alice',
      profileUrl: 'https://codeforces.com/profile/alice',
    });
    assert.deepEqual(created.source, {
      id: CF.id,
      platform: 'codeforces',
      domain: CF.domain,
      displayName: 'Codeforces',
    });
    assert.deepEqual((await bench.store.listSourceInstances()).map((instance) => instance.id), [CF.id]);
    assert.equal((await bench.store.listAccounts(CF.id)).length, 1);
    assert.deepEqual(await bench.store.listAccounts(LG.id), []);

    const luogu = await ok(bench, 'account.create', { platform: 'luogu', handle: '100001' });
    assert.equal(luogu.account.id, accountIdOf(LG.id, '100001'));
    assert.equal(luogu.account.profileUrl, 'https://www.luogu.com.cn/user/100001');
    assert.equal(luogu.account.displayName, null);
    assert.equal((await bench.store.listAccounts(CF.id)).length, 1, 'another instance must not be touched');
  });
});

void test('an official factory refusal is the caller 400, never a 500', async () => {
  await withBench({}, async (bench) => {
    for (const body of [
      { platform: 'luogu', handle: '007' },
      { platform: 'luogu', handle: '+7' },
      { platform: 'codeforces', handle: 'ab' },
    ]) {
      const parsed = await refused(bench, 'account.create', body, 400);
      assert.equal(failureOf(parsed).code, 'invalid_input');
    }
    assert.deepEqual(await bench.store.listAccounts(null), []);
  });
});

void test('a cancelled account.create rolls back before any write', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withBench({ store: (real) => gatedStore(real, gate) }, async (bench) => {
    const controller = new AbortController();
    const pending = bench.post('account.create', { platform: 'codeforces', handle: 'alice' }, controller.signal);
    await tick();
    controller.abort();

    const response = await pending;
    assert.equal(response.status, 499);
    release();
    await tick();
    await tick();
    assert.deepEqual(await bench.store.listAccounts(null), []);
  });
});

// ---------------------------------------------------------------------------------------
// sync.page
// ---------------------------------------------------------------------------------------

void test('sync.page commits one real page through the injected adapter', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const adapter = fakeAdapter(scope.instance, {
    listProblems: async () => ({ items: [scope.problem], nextCursor: 'cursor-2', fetchedAt: AT }),
  });
  await withBench({ sources: [{ instance: scope.instance }], adapter: () => adapter }, async (bench) => {
    await bench.store.upsertSourceInstances([scope.instance]);
    const value = await ok(bench, 'sync.page', {
      sourceInstanceId: scope.instance.id,
      accountId: null,
      resource: 'problems',
      mode: 'start',
      limit: 10,
    });

    assert.equal(value.ok, true);
    assert.equal(value.complete, false);
    assert.equal(value.nextCursor, 'cursor-2');
    assert.deepEqual(value.counts, { kind: 'problems', fetched: 1, inserted: 1, updated: 0, unchanged: 0 });
    assert.equal(value.checkpoint.cursor, 'cursor-2');
    assert.equal(value.pageFetchedAt, AT);
    assert.equal((await bench.store.getProblem(scope.problem.key))?.title, scope.problem.title);
  });
});

void test('sync.page keeps auth_required, rate_limited and unsupported distinct', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const call = {
    sourceInstanceId: scope.instance.id,
    accountId: null,
    resource: 'problems',
    mode: 'start',
    limit: 10,
  } as const;

  const auth = fakeAdapter(scope.instance, {
    listProblems: async () => {
      throw new PlatformError({ code: 'auth_required', operation: 'catalog', detail: 'log in first' });
    },
  });
  await withBench({ sources: [{ instance: scope.instance }], adapter: () => auth }, async (bench) => {
    await bench.store.upsertSourceInstances([scope.instance]);
    const value = await ok(bench, 'sync.page', call);
    assert.equal(value.ok, false);
    assert.deepEqual(value.failure, { code: 'auth_required', retryable: false, retryAfterMs: null, attempts: 1 });
    assert.equal(value.unavailableReason, null);
    assert.equal(
      await bench.store.getSyncCheckpoint({ sourceInstanceId: scope.instance.id, accountId: null, resource: 'problems' }),
      null,
    );
  });

  const limited = fakeAdapter(scope.instance, {
    listProblems: async () => {
      throw new PlatformError({ code: 'rate_limited', operation: 'catalog', detail: 'slow down', retryAfterMs: 4000 });
    },
  });
  await withBench({ sources: [{ instance: scope.instance }], adapter: () => limited }, async (bench) => {
    await bench.store.upsertSourceInstances([scope.instance]);
    const value = await ok(bench, 'sync.page', call);
    assert.deepEqual(value.failure, { code: 'rate_limited', retryable: true, retryAfterMs: 4000, attempts: 1 });
  });

  const unsupported = fakeAdapter(scope.instance, { capabilities: { implemented: false } });
  await withBench({ sources: [{ instance: scope.instance }], adapter: () => unsupported }, async (bench) => {
    await bench.store.upsertSourceInstances([scope.instance]);
    const value = await ok(bench, 'sync.page', call);
    assert.equal(value.ok, false);
    assert.equal(value.failure, null, 'an unimplemented capability is not an operational failure');
    assert.equal(value.unavailableReason, 'unsupported:problems');
    assert.equal((await bench.store.listProblems({ limit: 10, cursor: null })).items.length, 0);
  });
});

// ---------------------------------------------------------------------------------------
// import.preview / import.apply
// ---------------------------------------------------------------------------------------

function manualJsonDocument(): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: { platform: 'manual', baseUrl: 'https://manual.example.org' },
    accounts: [{ handle: 'alice' }],
    problems: [
      {
        externalKey: 'M-1',
        title: 'Manual problem',
        url: 'https://manual.example.org/p/M-1',
        statement: 'Given n, print n.',
        rawTags: [],
        ratings: [],
      },
    ],
    submissions: [
      { accountHandle: 'alice', externalKey: 'M-1', externalId: '1', verdict: 'accepted', submittedAt: AT },
    ],
    editorials: [],
  });
}

void test('import preview reports the parser issues and writes nothing', async () => {
  await withBench({}, async (bench) => {
    const text = JSON.stringify({ schemaVersion: 2 });
    const value = await ok(bench, 'import.preview', { format: 'json', text });

    assert.equal(value.parsed, false);
    assert.ok(value.issues.length > 0);
    assert.ok(value.issues.some((issue: { path: string }) => issue.path.includes('schemaVersion')));
    assert.deepEqual(await bench.store.listSourceInstances(), []);
    assert.equal((await bench.store.listProblems({ limit: 10, cursor: null })).items.length, 0);
  });
});

void test('import apply requires the previewed hash and refuses a changed document', async () => {
  const text = manualJsonDocument();
  await withBench({}, async (bench) => {
    const preview = await ok(bench, 'import.preview', { format: 'json', text });
    assert.equal(preview.parsed, true);
    assert.equal(preview.counts.problems, 1);
    assert.equal(preview.source.platform, 'manual');
    assert.match(preview.contentHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(await bench.store.listSourceInstances(), [], 'a preview writes nothing');

    const missing = await refused(bench, 'import.apply', { format: 'json', text }, 400);
    assert.equal(failureOf(missing).code, 'invalid_input');

    const conflict = await refused(
      bench,
      'import.apply',
      { format: 'json', text, expectedHash: '0'.repeat(64) },
      409,
    );
    assert.equal(failureOf(conflict).code, 'conflict');
    assert.deepEqual(await bench.store.listSourceInstances(), [], 'a mismatch writes nothing');

    const applied = await ok(bench, 'import.apply', { format: 'json', text, expectedHash: preview.contentHash });
    assert.equal(applied.problems.inserted, 1);
    assert.equal(applied.submissionsProcessed, 1);
    assert.equal(applied.changedSnapshots, 1);
    assert.equal((await bench.store.listProblems({ limit: 10, cursor: null })).items.length, 1);

    const again = await ok(bench, 'import.apply', { format: 'json', text, expectedHash: preview.contentHash });
    assert.deepEqual(again.problems, { inserted: 0, updated: 0, unchanged: 1 });
    assert.equal(again.changedSnapshots, 0);
  });
});

void test('a CSV document with empty context arrays keeps the public interchange shape', async () => {
  const text = ['externalKey,title,url,statement,rawTags,ratings,domain', 'CSV-1,Csv problem,https://manual.example.org/p/CSV-1,,,,'].join('\n');
  const csv = {
    kind: 'problems',
    source: { platform: 'manual', baseUrl: 'https://manual.example.org' },
    accounts: [],
    problems: [],
    editorials: [],
  };
  await withBench({}, async (bench) => {
    const preview = await ok(bench, 'import.preview', { format: 'csv', text, csv });
    assert.equal(preview.parsed, true);
    assert.equal(preview.counts.problems, 1);

    const applied = await ok(bench, 'import.apply', { format: 'csv', text, csv, expectedHash: preview.contentHash });
    assert.equal(applied.problems.inserted, 1);
    assert.equal((await bench.store.listProblems({ limit: 10, cursor: null })).items[0]?.ref.externalKey, 'CSV-1');

    const misplaced = await refused(bench, 'import.preview', { format: 'json', text: '{}', csv }, 400);
    assert.equal(failureOf(misplaced).code, 'invalid_input');
  });
});

// ---------------------------------------------------------------------------------------
// material.supplement
// ---------------------------------------------------------------------------------------

void test('material.supplement writes real found material, preserves hidden metadata and gates on the head', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const url = 'https://codeforces.com/blog/entry/9001';
  const sourceId = editorialSourceIdOf(scope.problem.ref, new URL(url).toString());
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);

    const found = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: null,
      editorial: { status: 'found', url, title: 'Editorial 9001', text: `lazy propagation ${SECRET}` },
    });
    assert.equal(found.material.freshFound, true);
    assert.equal(found.snapshot.changed, true);
    assert.equal(found.snapshot.version, 1);
    assert.equal(JSON.stringify(found).includes(SECRET), false, 'a write answer must not echo the body');

    const head = await bench.store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(head);
    const snapshot = await bench.store.getSnapshot(head.snapshotId);
    assert.ok(snapshot);
    const source = snapshot.sources.find((entry) => entry.id === sourceId);
    assert.ok(source, 'the supplied article uses its stable target-derived id');
    assert.equal(source.kind, 'solution');
    assert.equal(source.availability, 'found');
    assert.match(source.contentHash ?? '', /^[0-9a-f]{64}$/u);
    assert.equal(snapshot.solutions.length, 1);
    assert.match(snapshot.solutions[0]?.contentHash ?? '', /^[0-9a-f]{64}$/u);
    assert.equal(snapshot.solutions[0]?.ordinal, 0);

    // Editing the same URL replaces exactly that article; the hidden problem metadata is untouched.
    const edited = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: found.snapshot.snapshotId,
      editorial: { status: 'found', url, title: 'Editorial 9001 v2', text: 'a second write-up about binary lifting' },
    });
    assert.equal(edited.snapshot.version, 2);
    const stored = await bench.store.getProblem(scope.problem.key);
    assert.deepEqual(stored?.rawTags.map((tag) => tag.raw), ['data structures', 'segment tree']);
    assert.equal(stored?.ratings.length, 1);
    assert.equal(stored?.statement, scope.problem.statement);

    const stale = await refused(
      bench,
      'material.supplement',
      {
        problemKey: scope.problem.key,
        expectedSnapshotId: found.snapshot.snapshotId,
        editorial: { status: 'found', url, title: 'third', text: 'a third write-up' },
      },
      409,
    );
    assert.equal(failureOf(stale).code, 'conflict');
    const after = await bench.store.getCurrentSnapshotHead(scope.problem.ref);
    assert.equal(after?.snapshotId, edited.snapshot.snapshotId, 'a stale supplement must change nothing');
  });
});

void test('material.supplement records an explicit absence only with its note', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);

    const withoutNote = await refused(
      bench,
      'material.supplement',
      {
        problemKey: scope.problem.key,
        expectedSnapshotId: null,
        editorial: { status: 'absent', url: 'https://codeforces.com/blog/entry/1', title: 'Blog' },
      },
      400,
    );
    assert.equal(failureOf(withoutNote).code, 'invalid_input');

    const absent = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: null,
      editorial: {
        status: 'absent',
        url: 'https://codeforces.com/blog/entry/1',
        title: 'Blog',
        note: 'checked the official blog index; no entry for this problem',
      },
    });
    assert.equal(absent.material.outcome, 'applied');
    assert.equal(absent.material.availability, 'absent');
    assert.equal(absent.material.freshFound, false);
  });
});

// ---------------------------------------------------------------------------------------
// material.supplement — user-provided answers (Sprint 12)
// ---------------------------------------------------------------------------------------

/** The single source of one problem's current snapshot, addressed by the deterministic id rule. */
async function snapshotSourceOf(bench: Bench, scope: fx.Scope, sourceId: string) {
  const head = await bench.store.getCurrentSnapshotHead(scope.problem.ref);
  assert.ok(head, 'a stored snapshot head is required by this assertion');
  const snapshot = await bench.store.getSnapshot(head.snapshotId);
  assert.ok(snapshot);
  return { head, snapshot, source: snapshot.sources.find((entry) => entry.id === sourceId) ?? null };
}

void test('a pasted answer without a URL is stored as a user-provided source with an honest note', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const label = '教师解析';
  const text = `先二分答案，再用前缀和验证。\n\n\`\`\`cpp\nint main(){ return 0; }\n\`\`\`\n${SECRET}`;
  const sourceId = userAnswerSourceIdOf(scope.problem.ref, label, text, null);
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);

    const value = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: null,
      answer: { sourceLabel: ` ${label} `, text },
    });

    assert.equal(value.material.freshFound, true);
    assert.equal(value.snapshot.changed, true);
    assert.equal(value.snapshot.version, 1);
    assert.equal(
      JSON.stringify(value).includes(SECRET),
      false,
      'a write answer must not echo the pasted body',
    );
    assert.equal(JSON.stringify(value).includes(text), false);
    assert.match(sourceId, new RegExp(`^${USER_ANSWER_SOURCE_ID_PREFIX}[0-9a-f]{32}$`));

    const stored = await snapshotSourceOf(bench, scope, sourceId);
    const source = stored.source;
    assert.ok(source, 'the paste is stored under its deterministic user-answer id');
    assert.equal(source.kind, 'other', 'a paste is never an official editorial');
    assert.equal(source.availability, 'found');
    assert.equal(source.title, `${USER_ANSWER_SOURCE_TITLE}（${label}）`);
    assert.equal(
      source.url,
      scope.problem.url,
      'with no supplied URL the stored problem URL is used, and only as the associated problem link',
    );
    assert.equal(source.note, userAnswerProvenanceNote(label, true));
    assert.match(source.note ?? '', /用户提供解析/);
    assert.match(source.note ?? '', /非官方题解/);
    assert.match(source.note ?? '', /正确性未经核验/);
    assert.match(source.note ?? '', /用户未提供答案出处链接/);
    assert.match(source.note ?? '', /并非答案出处/);
    assert.equal(stored.snapshot.solutions.length, 1);
    assert.equal(stored.snapshot.solutions[0]?.text, text, 'the exact pasted text is the solution body');
    assert.equal(stored.snapshot.solutions[0]?.sourceId, sourceId);
    assert.equal(stored.snapshot.solutions[0]?.ordinal, 0);

    // The stored problem keeps its own hidden metadata; a paste is not a re-import.
    const problem = await bench.store.getProblem(scope.problem.key);
    assert.deepEqual(problem?.rawTags.map((tag) => tag.raw), ['data structures', 'segment tree']);
    assert.equal(problem?.title, scope.problem.title);
    assert.equal(problem?.statement, scope.problem.statement);
  });
});

void test('a pasted answer with a supplied URL stores that citation and never fetches it', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const label = 'GPT6';
  const citation = 'https://example.org/answers/1234A';
  const text = 'GPT6 的解析正文：用单调栈维护下降序列。';
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);

    const value = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: null,
      answer: { sourceLabel: label, url: `${citation} `, text },
    });

    const sourceId = userAnswerSourceIdOf(scope.problem.ref, label, text, citation);
    assert.equal(userAnswerSourceIdOf(scope.problem.ref, label, text, citation), sourceId);
    const stored = await snapshotSourceOf(bench, scope, sourceId);
    assert.ok(stored.source);
    assert.equal(stored.source.url, citation, 'the supplied citation is the stored link');
    assert.equal(stored.source.kind, 'other');
    assert.equal(stored.source.note, userAnswerProvenanceNote(label, false));
    assert.match(stored.source.note ?? '', /来源链接由用户提供，仅作标注/);
    assert.equal(
      (stored.source.note ?? '').includes('用户未提供答案出处链接'),
      false,
      'a supplied citation keeps the associated-problem wording out of the note',
    );
    assert.equal(value.snapshot.version, 1);
  });
});

void test('a repeated paste reuses its snapshot while a different answer creates a new one', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const firstLabel = 'GPT6';
  const firstText = '第一条粘贴内容：按右端点排序后贪心。';
  const secondLabel = '自己整理';
  const secondText = '第二条粘贴内容：把区间离散化后跑最短路。';
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);
    const platformUrl = 'https://codeforces.com/blog/entry/9001';
    const platformSourceId = editorialSourceIdOf(scope.problem.ref, new URL(platformUrl).toString());
    const platformSaved = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: null,
      editorial: { status: 'found', url: platformUrl, title: '平台题解', text: 'platform article body' },
    });
    await ok(bench, 'review.tag', {
      problemKey: scope.problem.key,
      taxonomyId: STACK,
      action: 'accept',
      note: 'manual decision before the paste',
    });
    const first = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: platformSaved.snapshot.snapshotId,
      answer: { sourceLabel: firstLabel, text: firstText },
    });
    const firstSourceId = userAnswerSourceIdOf(scope.problem.ref, firstLabel, firstText, null);

    // An identical paste (timestamps alone differ) is the same source: the semantic content did not
    // change, so the previous snapshot and its analyses stay valid and nothing is rewritten.
    bench.clock.value = new Date(Date.parse(bench.clock.value)+60_000).toISOString();
    const repeat = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: first.snapshot.snapshotId,
      answer: { sourceLabel: firstLabel, text: firstText },
    });
    assert.equal(repeat.snapshot.changed, false, 'an identical paste reuses the snapshot');
    assert.equal(repeat.snapshot.snapshotId, first.snapshot.snapshotId);
    assert.equal(repeat.snapshot.version, first.snapshot.version);
    assert.equal(repeat.snapshot.contentHash, first.snapshot.contentHash);

    const before = await snapshotSourceOf(bench, scope, firstSourceId);
    assert.equal(before.snapshot.solutions.length, 2, 'the platform article and the first paste both survive');

    const second = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: first.snapshot.snapshotId,
      answer: { sourceLabel: secondLabel, text: secondText },
    });
    const secondSourceId = userAnswerSourceIdOf(scope.problem.ref, secondLabel, secondText, null);
    assert.notEqual(secondSourceId, firstSourceId);
    assert.equal(second.snapshot.changed, true);
    assert.equal(second.snapshot.version, first.snapshot.version + 1);

    const after = await snapshotSourceOf(bench, scope, secondSourceId);
    assert.equal(after.source?.title, `${USER_ANSWER_SOURCE_TITLE}（${secondLabel}）`);
    assert.ok(after.snapshot.sources.some((entry) => entry.id === firstSourceId), 'the first paste is preserved');
    assert.ok(after.snapshot.sources.some((entry) => entry.id === platformSourceId), 'the platform source is preserved');
    assert.equal(after.snapshot.solutions.length, 3);
    assert.equal(after.snapshot.solutions.find((solution) => solution.sourceId === firstSourceId)?.text, firstText);
    assert.equal(after.snapshot.solutions.find((solution) => solution.sourceId === secondSourceId)?.text, secondText);

    // A stale head is refused atomically: neither the older nor the newer paste is rewritten.
    const stale = await refused(
      bench,
      'material.supplement',
      {
        problemKey: scope.problem.key,
        expectedSnapshotId: first.snapshot.snapshotId,
        answer: { sourceLabel: '过期粘贴', text: '第三条内容不会被写入。' },
      },
      409,
    );
    assert.equal(failureOf(stale).code, 'conflict');
    const unchanged = await snapshotSourceOf(bench, scope, secondSourceId);
    assert.equal(unchanged.head.snapshotId, second.snapshot.snapshotId);
    assert.ok(
      unchanged.snapshot.sources.every((entry) => entry.title !== `${USER_ANSWER_SOURCE_TITLE}（过期粘贴）`),
      'a stale paste writes nothing',
    );

    // A user paste is not an automatic tag adoption: the raw tags and the one manual decision stand.
    const problem = await bench.store.getProblem(scope.problem.key);
    assert.deepEqual(problem?.rawTags.map((tag) => tag.raw), ['data structures', 'segment tree']);
    const decisions = await bench.store.listTagDecisions(scope.problem.key);
    assert.deepEqual(decisions.filter((decision) => decision.taxonomyId === STACK).map((decision) => decision.status), ['accepted']);
    assert.deepEqual(
      decisions.map((decision) => (decision.taxonomyId === STACK ? decision.origin : null)).filter((origin) => origin !== null),
      ['manual'],
      'no AI decision was adopted by pasting',
    );
  });
});

void test('a paste refills the same snapshot instead of replacing an existing article of the same id', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const text = '同一条粘贴内容：先排序再去重。';
  const sourceId = userAnswerSourceIdOf(scope.problem.ref, 'GPT6', text, null);
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);

    await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: null,
      statement: '手工补充的题面。',
      answer: { sourceLabel: 'GPT6', text },
    });
    const once = await snapshotSourceOf(bench, scope, sourceId);
    assert.equal(once.snapshot.solutions.length, 1);
    assert.equal(once.snapshot.sources.filter((entry) => entry.id === sourceId).length, 1);
    assert.equal((await bench.store.getProblem(scope.problem.key))?.statement, '手工补充的题面。');

    // A statement may accompany a paste additively, and the merge stays keyed by the source id.
    const again = await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: once.head.snapshotId,
      statement: '手工补充的题面（第二版）。',
      answer: { sourceLabel: 'GPT6', text },
    });
    const twice = await snapshotSourceOf(bench, scope, sourceId);
    assert.equal(twice.snapshot.sources.filter((entry) => entry.id === sourceId).length, 1);
    assert.equal(twice.snapshot.solutions.length, 1, 'the same paste keeps exactly one solution');
    assert.equal(again.material.sources, 1);
    assert.equal((await bench.store.getProblem(scope.problem.key))?.statement, '手工补充的题面（第二版）。');
  });
});

void test('a malformed, blank, oversized or ambiguous answer is refused and writes nothing', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);
    const base = { problemKey: scope.problem.key, expectedSnapshotId: null };
    const editorial = { status: 'found', url: 'https://codeforces.com/blog/entry/1', title: 'T', text: 'body' };
    const cases: readonly unknown[] = [
      { ...base },
      { ...base, answer: { sourceLabel: '   ', text: '正文' } },
      { ...base, answer: { sourceLabel: 'GPT6', text: '   ' } },
      { ...base, answer: { sourceLabel: 'x'.repeat(201), text: '正文' } },
      { ...base, answer: { sourceLabel: 'GPT6', text: 'x'.repeat(200_001) } },
      { ...base, answer: { sourceLabel: 'GPT6', text: '正文', url: 'ftp://example.org/a' } },
      { ...base, answer: { sourceLabel: 'GPT6', text: '正文', url: 'https://user:pass@example.org/a' } },
      { ...base, answer: { sourceLabel: 'GPT6', text: '正文', unknown: true } },
      { ...base, answer: { text: '正文' } },
      { ...base, answer: { sourceLabel: 'GPT6', text: '正文' }, editorial },
      { ...base, answer: 'not an object' },
      { ...base, answer: { sourceLabel: 'GPT6', text: 42 } },
      { ...base, answer: { sourceLabel: 'GPT6', text: '正文' }, extra: 1 },
    ];
    for (const body of cases) {
      const parsed = await refused(bench, 'material.supplement', body, 400);
      assert.equal(failureOf(parsed).code, 'invalid_input', `${JSON.stringify(body).slice(0, 120)} must be refused`);
    }
    const head = await bench.store.getCurrentSnapshotHead(scope.problem.ref);
    assert.equal(head, null, 'a refused paste never creates a snapshot');
    assert.deepEqual(await bench.store.listTagDecisions(scope.problem.key), []);
  });
});

void test('a withheld spoiler response carries no pasted text and no provenance detail', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const text = `这段粘贴内容在未揭示时不得出现 ${SECRET}`;
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);
    await ok(bench, 'material.supplement', {
      problemKey: scope.problem.key,
      expectedSnapshotId: null,
      answer: { sourceLabel: '教师解析', text },
    });

    const hidden = await ok(bench, 'problem.detail', { problemKey: scope.problem.key, accountId: null });
    assert.equal(hidden.spoilersVisible, false);
    assert.ok(hidden.snapshot, 'the snapshot head metadata stays visible');
    const serialized = JSON.stringify(hidden);
    assert.equal(serialized.includes(SECRET), false, 'no pasted body may travel while withheld');
    assert.equal(serialized.includes('用户提供解析'), false, 'no provenance note may travel while withheld');
    assert.equal(serialized.includes('user-answer-'), false, 'no user-answer source id may travel while withheld');
    assert.equal(Object.hasOwn(hidden.snapshot, 'sources'), false);
    assert.equal(Object.hasOwn(hidden.snapshot, 'solutions'), false);

    const hiddenList = await ok(bench, 'problem.list', { limit: 10 });
    assert.equal(JSON.stringify(hiddenList).includes(SECRET), false);
  });
});

// ---------------------------------------------------------------------------------------
// material.refresh
// ---------------------------------------------------------------------------------------

void test('material.refresh answers a recursively redacted DTO and separates failure from absence', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const fetched = createNormalizedProblem({
    ref: scope.problem.ref,
    title: 'Fetched title',
    url: 'https://codeforces.com/problem/1234A',
    statement: `fetched statement ${SECRET}`,
    fetchedAt: AT,
    ratings: [{ dimension: 'rating', value: 1800, scale: { min: 800, max: 3500 }, raw: '1800' }],
    rawTags: [RAW_TAG_SENTINEL],
  });
  const editorialUrl = 'https://codeforces.com/blog/entry/77';
  const source = createEditorialSource({
    id: 'editorial-77',
    kind: 'editorial',
    url: editorialUrl,
    title: 'Round editorial',
    availability: 'found',
    retrievedAt: AT,
    text: `use a sparse table ${SECRET}`,
  });
  const solution = createEditorialSolution({
    solutionId: 'editorial-77-solution-0',
    sourceId: source.id,
    ordinal: 0,
    title: 'Round editorial',
    text: `use a sparse table ${SECRET}`,
  });

  let mode: 'found' | 'auth' | 'absent' = 'found';
  const adapter = fakeAdapter(scope.instance, {
    fetchProblem: async () => fetched,
    fetchEditorial: async () => {
      if (mode === 'auth') {
        throw new PlatformError({ code: 'auth_required', operation: 'editorial', detail: 'log in first' });
      }
      if (mode === 'absent') {
        return { status: 'absent', detail: 'no editorial was published' };
      }
      return { status: 'found', sources: [source], solutions: [solution], retrievedAt: AT };
    },
  });
  await withBench({ sources: [{ instance: scope.instance }], adapter: () => adapter }, async (bench) => {
    await seedScope(bench.store, scope);

    const value = await ok(bench, 'material.refresh', { problemKey: scope.problem.key, fetchStatement: true });
    assert.equal(value.statement.status, 'fetched');
    assert.equal(value.statement.title, 'Fetched title');
    assert.equal(value.editorial.status, 'found');
    assert.equal(value.editorial.sourceCount, 1);
    assert.equal(value.editorial.solutionCount, 1);
    assert.equal(value.material.freshFound, true);
    assert.equal(value.snapshot.version, 1);

    const text = JSON.stringify(value);
    assert.equal(text.includes(SECRET), false, 'no fetched statement or solution body may travel');
    assert.equal(text.includes(RAW_TAG_SENTINEL), false, 'no raw platform tag may travel');
    assert.equal(text.includes('sparse table'), false);

    mode = 'auth';
    const failed = await ok(bench, 'material.refresh', { problemKey: scope.problem.key, fetchStatement: false });
    assert.equal(failed.editorial.status, 'auth_required');
    assert.deepEqual(failed.editorial.failure, {
      code: 'auth_required',
      retryable: false,
      retryAfterMs: null,
      attempts: 1,
    });
    assert.equal(failed.material.freshFound, false, 'a failed fetch is never fresh material');
    assert.equal(failed.material.staleCachedAvailability, 'found', 'cached material survives a failed fetch');
    assert.equal(failed.statement.status, 'not_requested');

    mode = 'absent';
    const absentValue = await ok(bench, 'material.refresh', { problemKey: scope.problem.key, fetchStatement: false });
    assert.equal(absentValue.editorial.status, 'absent', 'absence is a distinct answer, not an auth failure');
    assert.equal(absentValue.editorial.failure, null);

    const unknownKey = problemKey({ sourceInstanceId: scope.instance.id, domain: null, externalKey: 'NOPE' });
    const missing = await refused(bench, 'material.refresh', { problemKey: unknownKey, fetchStatement: false }, 404);
    assert.equal(failureOf(missing).code, 'not_found');
  });
});

// ---------------------------------------------------------------------------------------
// Bank / review / retrospective / weakness / plans
// ---------------------------------------------------------------------------------------

void test('bank, review, retrospective, weakness and plan operations delegate the service DTOs', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const plan = fx.makePlan(scope.account.id, scope.problem);
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);
    await bench.store.upsertSubmissions([
      fx.makeSubmission(scope.account, scope.problem.ref, '9001', 'accepted', AT),
    ]);
    await bench.store.saveSnapshot(fx.makeSnapshot(scope.problem));
    await bench.store.savePlan(plan);

    const listed = await ok(bench, 'problem.list', { limit: 10, accountId: scope.account.id });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].solvedByAccount, true);
    assert.deepEqual(listed.items[0].rawTags, scope.problem.rawTags.map((tag) => tag.raw));

    const hidden = await ok(bench, 'problem.list', { limit: 10 });
    assert.equal(Object.hasOwn(hidden.items[0], 'rawTags'), false);
    assert.equal(Object.hasOwn(hidden.items[0], 'effectiveTaxonomyIds'), false);

    const detail = await ok(bench, 'problem.detail', { problemKey: scope.problem.key, accountId: null });
    assert.equal(detail.spoilersVisible, false);
    assert.equal(Object.hasOwn(detail, 'rawTags'), false);
    assert.ok(detail.snapshot);
    assert.equal(Object.hasOwn(detail.snapshot, 'solutions'), false);

    const review = await ok(bench, 'review.tag', {
      problemKey: scope.problem.key,
      taxonomyId: STACK,
      action: 'accept',
    });
    assert.equal(review.outcome, 'recorded');
    assert.equal(review.status, 'accepted');
    const repeat = await ok(bench, 'review.tag', {
      problemKey: scope.problem.key,
      taxonomyId: STACK,
      action: 'accept',
    });
    assert.equal(repeat.outcome, 'already_recorded');

    const retro = await ok(bench, 'retro.record', {
      problemKey: scope.problem.key,
      accountId: scope.account.id,
      mode: 'independent',
      taxonomyIds: [],
      solutionIds: [],
    });
    assert.equal(retro.recorded, true);
    assert.deepEqual(retro.taxonomyIds, []);

    const weakness = await ok(bench, 'weakness', { accountId: scope.account.id });
    assert.equal(weakness.coverage.submissionRows, 1);
    assert.equal(weakness.rawTagProvenance.verified, false);
    assert.ok(weakness.report);
    // The additive provisional projections travel over this same operation: one solved problem with
    // its raw Codeforces rating, and the unverified platform-label reference beside the formal report.
    assert.deepEqual(weakness.solvedDistribution, {
      totalSolved: 1,
      metadataMissingSolved: 0,
      dimensions: [{ dimension: 'rating', buckets: [{ value: 1800, count: 1 }], knownCount: 1, unknownCount: 0 }],
    });
    assert.equal(weakness.platformTagStats.verified, false);
    assert.equal(weakness.platformTagStats.minimumSampleSize, 5);
    assert.deepEqual(
      weakness.platformTagStats.tags.map((tag: { rawTag: string }) => tag.rawTag),
      ['data structures', 'segment tree'],
    );

    const plans = await ok(bench, 'plan.list', { accountId: scope.account.id });
    assert.equal(plans.plans.length, 1);
    const hash = plans.plans[0].contentHash;
    assert.match(hash, /^[0-9a-f]{64}$/u);
    const planDetail = await ok(bench, 'plan.detail', { planId: plan.planId, accountId: scope.account.id });
    assert.equal(planDetail.contentHash, hash);

    const adopted = await ok(bench, 'plan.adopt', {
      planId: plan.planId,
      accountId: scope.account.id,
      expectedHash: hash,
    });
    assert.equal(adopted.status, 'adopted');

    const badPatch = await refused(
      bench,
      'plan.edit',
      {
        planId: plan.planId,
        accountId: scope.account.id,
        expectedHash: adopted.contentHash,
        taskId: plan.tasks[0]?.taskId,
        patch: { title: 'renamed' },
      },
      400,
    );
    assert.equal(failureOf(badPatch).code, 'invalid_input');

    const edited = await ok(bench, 'plan.edit', {
      planId: plan.planId,
      accountId: scope.account.id,
      expectedHash: adopted.contentHash,
      taskId: plan.tasks[0]?.taskId,
      patch: { day: 2, minutes: 45 },
    });
    assert.equal(edited.tasks[0].day, 2);
    assert.equal(edited.tasks[0].minutes, 45);
    assert.notEqual(edited.contentHash, adopted.contentHash);

    const checked = await ok(bench, 'plan.checkoff', {
      planId: plan.planId,
      accountId: scope.account.id,
      expectedHash: edited.contentHash,
      taskId: plan.tasks[0]?.taskId,
      status: 'done',
    });
    assert.equal(checked.tasks[0].status, 'done');

    const preview = await ok(bench, 'plan.preview', { accountId: scope.account.id, candidateProblemKeys: [] });
    assert.equal(preview.outcome, 'insufficient_evidence');
    assert.equal((await bench.store.listPlans(scope.account.id)).length, 1, 'an empty pool stores nothing');
  });
});

void test('problem.browse pages by number, refuses a cursor and rejects anonymous solved filters', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  await withBench({ sources: [{ instance: scope.instance }] }, async (bench) => {
    await seedScope(bench.store, scope);
    // A solved match whose key sorts after the first page proves count/filter/page run in SQL.
    const later = fx.makeProblem(fx.makeRef(scope.instance, '9999Z'));
    await bench.store.upsertProblems([later]);
    await bench.store.upsertSubmissions([fx.makeSubmission(scope.account, later.ref, '9002', 'accepted', AT)]);

    assert.equal(WORKBENCH_API_OPERATIONS.problemBrowse, 'problem.browse');

    const solved = await ok(bench, 'problem.browse', {
      sourceInstanceId: scope.instance.id,
      accountId: scope.account.id,
      status: 'solved',
      page: 1,
      limit: 25,
    });
    assert.equal(solved.totalItems, 1);
    assert.equal(solved.totalPages, 1);
    assert.equal(solved.page, 1);
    assert.equal(solved.pageSize, 25);
    assert.equal(Object.hasOwn(solved, 'nextCursor'), false, 'the numbered contract has no cursor');
    assert.deepEqual(
      solved.items.map((item: { problemKey: string }) => item.problemKey),
      [later.key],
    );
    assert.equal(solved.items[0].solvedByAccount, true);

    const hidden = await ok(bench, 'problem.browse', { sourceInstanceId: scope.instance.id, page: 1, limit: 25 });
    assert.equal(hidden.totalItems, 2);
    assert.equal(Object.hasOwn(hidden.items[0], 'rawTags'), false);
    assert.equal(Object.hasOwn(hidden.items[0], 'effectiveTaxonomyIds'), false);

    // A requested order reaches the real store: `problem_desc` reverses the natural key order, and a
    // difficulty sort reads one raw dimension of the requested source instance.
    const sorted = await ok(bench, 'problem.browse', {
      sourceInstanceId: scope.instance.id,
      sort: 'problem_desc',
      page: 1,
      limit: 25,
    });
    assert.deepEqual(
      sorted.items.map((item: { problemKey: string }) => item.problemKey),
      [later.key, scope.problem.key],
      'the whole filtered set is ordered before the page is taken',
    );
    const byDifficulty = await ok(bench, 'problem.browse', {
      sourceInstanceId: scope.instance.id,
      sort: 'difficulty_asc',
      ratingDimension: 'rating',
      page: 1,
      limit: 25,
    });
    assert.deepEqual(
      byDifficulty.items.map((item: { problemKey: string }) => item.problemKey).sort(),
      [later.key, scope.problem.key].sort(),
      'both fixtures share one rating, so the canonical key decides the tie',
    );

    const cases: readonly unknown[] = [
      { page: 1, limit: 25, cursor: null },
      { page: 1, limit: 25, status: 'solved' },
      { page: 1, limit: 25, onlyAttempted: true },
      { page: 0, limit: 25 },
      { page: 1, limit: 101 },
      { page: 1, limit: 25, status: 'all', unknown: true },
      { page: 1, limit: 25, sort: 'by_vibes' },
      { page: 1, limit: 25, sourceInstanceId: scope.instance.id, sort: 'difficulty_asc' },
      { page: 1, limit: 25, sort: 'difficulty_asc', ratingDimension: 'rating' },
      { page: 1, limit: 25, sourceInstanceId: scope.instance.id, sort: 'difficulty_asc', ratingDimension: '  ' },
      { page: 1, limit: 25, sort: 'problem_asc', ratingDimension: 'x'.repeat(101) },
    ];
    for (const body of cases) {
      const parsed = await refused(bench, 'problem.browse', body, 400);
      assert.equal(failureOf(parsed).code, 'invalid_input', `${JSON.stringify(body)} must be refused`);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Strict boundary and unexpected failures
// ---------------------------------------------------------------------------------------

void test('unknown fields, nested unknown fields and malformed references are refused with 400', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  await withBench({ sources: [{ instance: scope.instance }], adapter: () => fakeAdapter(scope.instance) }, async (bench) => {
    await seedScope(bench.store, scope);
    const cases: readonly (readonly [string, unknown])[] = [
      ['account.create', { platform: 'codeforces', handle: 'alice', apiKey: 'not-accepted' }],
      ['problem.list', { limit: 10, extra: true }],
      ['problem.detail', { problemKey: scope.problem.key, accountId: 'not-a-canonical-account-id' }],
      ['material.supplement', { problemKey: scope.problem.key, expectedSnapshotId: null, statement: 'x', rawTags: [] }],
      [
        'material.supplement',
        {
          problemKey: scope.problem.key,
          expectedSnapshotId: null,
          editorial: {
            status: 'found',
            url: 'https://codeforces.com/blog/entry/1',
            title: 'T',
            text: 'body',
            kind: 'video',
          },
        },
      ],
      ['sync.page', { sourceInstanceId: scope.instance.id, accountId: null, resource: 'problems', mode: 'start', limit: 0 }],
      ['retro.record', { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'independent', taxonomyIds: 'nope' }],
    ];
    for (const [operation, body] of cases) {
      const parsed = await refused(bench, operation, body, 400);
      assert.equal(failureOf(parsed).code, 'invalid_input', `${operation} must refuse the request`);
    }
    assert.deepEqual(await bench.store.listTagDecisions(scope.problem.key), []);
  });
});

void test('an unexpected store failure is a sanitized 500 and reaches the observer', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1234A');
  const boom = new Error('SQLITE_ERROR at D:\\private\\training.sqlite');
  const reported: unknown[] = [];
  await withBench(
    {
      sources: [{ instance: scope.instance }],
      store: (real) => throwingStore(real, boom),
      onInternalError: (error) => {
        reported.push(error);
      },
    },
    async (bench) => {
      const parsed = await refused(bench, 'material.refresh', { problemKey: scope.problem.key, fetchStatement: false }, 500);
      assert.equal(failureOf(parsed).code, 'internal');
      const text = JSON.stringify(parsed);
      assert.equal(text.includes('SQLITE_ERROR'), false);
      assert.equal(text.includes('private'), false);
      assert.deepEqual(reported, [boom]);
    },
  );
});

// ---------------------------------------------------------------------------------------
// Registration lifecycle
// ---------------------------------------------------------------------------------------

/** Dependencies that satisfy registration without being used by it. */
function stubOptions(
  registry: HostConnectionFetch,
  extras: Partial<RegisterBusinessApiOptions> = {},
): RegisterBusinessApiOptions {
  const store = {
    transaction: async (work: () => Promise<unknown>) => work(),
  } as unknown as TrainingStore;
  const imports = {
    syncPage: async () => {
      throw new Error('not used by registration');
    },
    applyManual: async () => {
      throw new Error('not used by registration');
    },
  } as unknown as ImportService;
  return {
    registry,
    store,
    imports,
    workbench: {} as unknown as WorkbenchService,
    adapterFor: async () => {
      throw new Error('not used by registration');
    },
    sources: [],
    settings: async () => null,
    ...extras,
  };
}

const OPERATION_COUNT = Object.keys(WORKBENCH_API_OPERATIONS).length;

void test('disposal awaits every async disposer in reverse order and is memoized', async () => {
  const started: string[] = [];
  const finished: string[] = [];
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry: HostConnectionFetch = {
    register(route) {
      const operation = route.path.slice(API_PREFIX.length);
      return async () => {
        started.push(operation);
        await gate;
        finished.push(operation);
      };
    },
  };
  const dispose = await registerBusinessApi(stubOptions(registry));

  const first = dispose();
  const second = dispose();
  assert.equal(first, second, 'repeated calls must share one memoized promise');
  await tick();
  assert.deepEqual(started, ['plan.checkoff'], 'the last registration is released first');
  assert.deepEqual(finished, [], 'disposal must wait for the async disposer');

  release();
  await first;
  assert.equal(started.length, OPERATION_COUNT);
  assert.equal(finished.length, OPERATION_COUNT);
  assert.equal(started.at(-1), 'account.create', 'release order is the reverse of registration');
});

void test('a delayed disposer rejection is reported, aggregated and never unhandled', async () => {
  const reported: unknown[] = [];
  const registry: HostConnectionFetch = {
    register() {
      return async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('the registration could not be released');
      };
    },
  };
  const dispose = await registerBusinessApi(
    stubOptions(registry, {
      onDisposeError: (error) => {
        reported.push(error);
      },
    }),
  );

  await withoutUnhandledRejections(async () => {
    await assert.rejects(dispose(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'BusinessApiCleanupError');
      const failures = (error as { cleanupFailures?: readonly unknown[] }).cleanupFailures;
      assert.equal(failures?.length, OPERATION_COUNT);
      return true;
    });
  });
  assert.equal(reported.length, OPERATION_COUNT);
  await assert.rejects(dispose(), { name: 'BusinessApiCleanupError' });
  assert.equal(reported.length, OPERATION_COUNT, 'the memoized rejection reports nothing twice');
});

void test('a mid-registration failure releases earlier routes before rejecting', async () => {
  const released: string[] = [];
  const reported: unknown[] = [];
  const registry: HostConnectionFetch = {
    register(route) {
      if (route.path.endsWith('import.preview')) {
        throw new Error('the registry refused this route');
      }
      return async () => {
        released.push(route.path);
        if (route.path.endsWith('sync.page')) {
          throw new Error('the sync route could not be released');
        }
      };
    },
  };

  await withoutUnhandledRejections(async () => {
    await assert.rejects(
      registerBusinessApi(
        stubOptions(registry, {
          onDisposeError: (error) => {
            reported.push(error);
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'the registry refused this route', 'the original failure is retained');
        const failures = (error as { cleanupFailures?: readonly unknown[] }).cleanupFailures;
        assert.equal(failures?.length, 1, 'cleanup failures travel with the original failure');
        return true;
      },
    );
  });

  assert.deepEqual(released, [`${API_PREFIX}sync.page`, `${API_PREFIX}account.create`]);
  assert.equal(reported.length, 1);
});

void test('ability.calibrate saves honest per-account provenance and refuses stale, foreign-scale or cancelled writes', async () => {
  await withBench({}, async bench => {
    const account = (await ok(bench, 'account.create', { platform: 'codeforces', handle: 'alice' })).account;
    const request = { accountId: account.id, expectedRevision: 0, range: { min: 1700, max: 2200 } };
    const result = await ok(bench, 'ability.calibrate', request);
    assert.equal(result.source, 'self_report');
    assert.equal(result.revision, 1);
    assert.deepEqual((await ok(bench, 'weakness', { accountId: account.id })).ability.trainingReference.range, request.range);
    assert.equal((await bench.post('ability.calibrate', request)).status, 409);
    assert.equal((await bench.post('ability.calibrate', { ...request, expectedRevision: 1, source: 'official' })).status, 400);
    const luogu = (await ok(bench, 'account.create', { platform: 'luogu', handle: '123' })).account;
    assert.equal((await bench.post('ability.calibrate', { ...request, accountId: luogu.id })).status, 400);
    const abort = new AbortController(); abort.abort();
    await bench.post('ability.calibrate', { ...request, expectedRevision: 1, range: null }, abort.signal);
    assert.equal((await bench.store.getAbilityCalibration(account.id))!.revision, 1);
  });
});
