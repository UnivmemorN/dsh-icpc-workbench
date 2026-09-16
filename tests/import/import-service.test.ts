/**
 * Import service behaviour through the public application API.
 *
 * Every case drives the *real* SQLite store and a scripted platform double, and states a
 * consequence the product depends on: an idempotent manual import, snapshots that only change
 * when content changes, a checkpoint that no failed or concurrent page can corrupt, material
 * that survives a failed refresh, and cancellation that leaves no partial document behind.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import {
  editorialSourceIdOf,
  type ManualImportBundle,
  type ManualMaterialInput,
} from '../../src/application/import-types.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import { emptyLuoguSyncState } from '../../src/application/luogu-sync-types.js';
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
  TrainingStore,
} from '../../src/application/ports.js';
import type { SyncCheckpointRef } from '../../src/application/storage-types.js';
import {
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  DomainError,
  type EditorialSolution,
  type EditorialSource,
  type NormalizedProblem,
  type ProblemSnapshot,
  type SourceInstance,
  type Submission,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const SERVICE_NOW = '2026-09-12T10:00:00.000Z';
const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 1000,
  maxRetries: 0,
  pageSize: 100,
  maxConcurrency: 1,
};
const SOLUTION_TEXT = 'Maintain a lazy segment tree: range add is O(log n) with a pending value per node.';

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

function serviceFor(store: TrainingStore): ImportService {
  return new ImportService({ store, now: () => SERVICE_NOW });
}

function isDomain(code: DomainError['code']): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

/**
 * Wrap the store to observe snapshot saves and to run hooks right after a problem write or a
 * snapshot save. The proxy delegates every call to the real store, so private state and the
 * transaction scope keep working.
 */
function instrumentStore(
  store: SqliteTrainingStore,
  hooks: { readonly afterUpsertProblems?: () => void; readonly afterSaveSnapshot?: () => void } = {},
): { readonly store: TrainingStore; readonly savedSnapshots: string[] } {
  const savedSnapshots: string[] = [];
  const proxy = new Proxy(store as TrainingStore, {
    get(target, property, receiver) {
      if (property === 'saveSnapshot') {
        const afterSaveSnapshot = hooks.afterSaveSnapshot;
        return async (snapshot: ProblemSnapshot): Promise<void> => {
          savedSnapshots.push(snapshot.snapshotId);
          await target.saveSnapshot(snapshot);
          if (afterSaveSnapshot !== undefined) {
            afterSaveSnapshot();
          }
        };
      }
      if (property === 'upsertProblems' && hooks.afterUpsertProblems !== undefined) {
        const hook = hooks.afterUpsertProblems;
        return async (problems: readonly NormalizedProblem[]): Promise<void> => {
          await target.upsertProblems(problems);
          hook();
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { store: proxy, savedSnapshots };
}

interface ScriptedPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  /** Overrides the page timestamp; a malformed value drives the page validator's failure path. */
  readonly fetchedAt?: string;
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

/** Platform double: scripted answers, recorded requests, optional in-flight hooks. */
class FakeAdapter implements PlatformAdapter {
  readonly sourceInstance: SourceInstance;
  readonly problemPages: Array<ScriptedPage<NormalizedProblem> | Error> = [];
  readonly submissionPages: Array<ScriptedPage<Submission> | Error> = [];
  readonly problemResults: Array<NormalizedProblem | Error> = [];
  readonly editorialResults: Array<EditorialFetchResult | Error> = [];
  readonly calls: Array<{ readonly operation: string; readonly request: unknown }> = [];
  afterListSubmissions: (() => Promise<void>) | null = null;
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
    return pageOf(take(this.problemPages, 'problem page'));
  }

  async listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>> {
    this.calls.push({ operation: 'listSubmissions', request });
    const scripted = take(this.submissionPages, 'submission page');
    if (this.afterListSubmissions !== null) {
      await this.afterListSubmissions();
    }
    return pageOf(scripted);
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

function pageOf<T>(scripted: ScriptedPage<T>): Page<T> {
  return { items: scripted.items, nextCursor: scripted.nextCursor, fetchedAt: scripted.fetchedAt ?? SERVICE_NOW };
}

function lastRequest<T>(adapter: FakeAdapter, operation: string): T {
  const call = [...adapter.calls].reverse().find((entry) => entry.operation === operation);
  assert.ok(call, `expected a ${operation} request`);
  return call.request as T;
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

function found(
  id: string,
  url: string,
  text: string = SOLUTION_TEXT,
): { readonly source: EditorialSource; readonly solution: EditorialSolution } {
  const source = createEditorialSource({
    id,
    kind: 'editorial',
    url,
    title: `Editorial ${id}`,
    availability: 'found',
    retrievedAt: fx.AT,
    text,
  });
  const solution = createEditorialSolution({ solutionId: `${id}-s1`, sourceId: id, ordinal: 0, title: 'Main idea', text });
  return { source, solution };
}

function foundMaterial(
  problemKey: string,
  entries: readonly { readonly source: EditorialSource; readonly solution: EditorialSolution }[],
  url: string,
): ManualMaterialInput {
  return {
    problemKey,
    result: {
      status: 'found',
      sources: entries.map((entry) => entry.source),
      solutions: entries.map((entry) => entry.solution),
      retrievedAt: fx.AT,
    },
    url,
    title: 'Imported editorial',
    note: null,
  };
}

function manualBundle(scope: fx.Scope, materials: readonly ManualMaterialInput[] = []): ManualImportBundle {
  return {
    source: scope.instance,
    accounts: [scope.account],
    problems: [scope.problem],
    submissions: [fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted')],
    materials,
  };
}

// ---------------------------------------------------------------------------------------
// Manual import
// ---------------------------------------------------------------------------------------

void test('repeated manual import is idempotent against the real store', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('manual', 'local.example.org', 'alice', 'P1');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const entry = found('manual-editorial-p1', 'https://blog.example.org/p1');
    const bundle = manualBundle(scope, [foundMaterial(scope.problem.key, [entry], 'https://blog.example.org/p1')]);

    const first = await service.applyManual(bundle, token);
    assert.deepEqual(first.problems, { inserted: 1, updated: 0, unchanged: 0 });
    assert.equal(first.submissionsProcessed, 1);
    assert.equal(first.changedSnapshots, 1);
    assert.equal(first.materials[0]?.outcome, 'applied');
    assert.equal(first.materials[0]?.freshFound, true);

    const head = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(head);
    const stored = await store.getSnapshot(head.snapshotId);
    assert.ok(stored);
    assert.equal(stored.sources.length, 1);
    assert.equal(stored.solutions.length, 1);

    const second = await service.applyManual(bundle, token);
    assert.deepEqual(second.problems, { inserted: 0, updated: 0, unchanged: 1 });
    assert.equal(second.changedSnapshots, 0);
    assert.equal(second.snapshots[0]?.snapshotId, stored.snapshotId);
    assert.equal(second.materials[0]?.outcome, 'applied');
    assert.equal((await store.listSubmissions(scope.account.id, { limit: 10, cursor: null })).items.length, 1);
    assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.snapshotId, stored.snapshotId);
  });
});

void test('a manual import rejects a submission whose problem the document does not define', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('manual', 'local.example.org', 'alice', 'P1');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const bundle: ManualImportBundle = { ...manualBundle(scope), problems: [], materials: [] };

    await assert.rejects(() => service.applyManual(bundle, token), isDomain('missing_reference'));
    assert.equal(await store.getProblem(scope.problem.key), null);
    assert.equal((await store.listAccounts(scope.instance.id)).length, 0);
    assert.equal((await store.listSourceInstances()).length, 0);
  });
});

void test('a refetch that only changed observation timestamps reuses the stored snapshot without saving', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('manual', 'local.example.org', 'alice', 'P1');
    const token = createCancellationSource().token;
    await serviceFor(store).applyManual(manualBundle(scope), token);
    const first = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(first);

    const instrumented = instrumentStore(store);
    const report = await serviceFor(instrumented.store).applyManual(
      { ...manualBundle(scope), problems: [fx.makeProblem(scope.problem.ref, { fetchedAt: fx.LATER })] },
      token,
    );

    assert.equal(report.problems.updated, 1, 'fetchedAt is stored metadata, so the body did change');
    assert.equal(report.snapshots[0]?.changed, false);
    assert.equal(report.snapshots[0]?.snapshotId, first.snapshotId);
    assert.deepEqual(instrumented.savedSnapshots, [], 'unchanged content must not call saveSnapshot');
    assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.snapshotId, first.snapshotId);
  });
});

void test('an explicit absent declaration is recorded, a synthesized unavailable entry is ignored', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('manual', 'local.example.org', 'alice', 'P1');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const declaration: ManualMaterialInput = {
      problemKey: scope.problem.key,
      result: { status: 'absent', detail: 'checked by hand' },
      url: 'https://blog.example.org/none',
      title: 'Checked page',
      note: 'user checked the blog index',
    };

    const first = await service.applyManual(manualBundle(scope, [declaration]), token);
    assert.equal(first.materials[0]?.outcome, 'applied');
    assert.equal(first.materials[0]?.availability, 'absent');
    assert.equal(first.materials[0]?.freshFound, false);
    const snapshot = await store.getSnapshot(first.snapshots[0]?.snapshotId ?? '');
    assert.ok(snapshot);
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.sources[0]?.availability, 'absent');
    assert.equal(snapshot.sources[0]?.url, 'https://blog.example.org/none');
    assert.equal(snapshot.sources[0]?.note, 'user checked the blog index | checked by hand');

    const omitted = await service.applyManual(
      manualBundle(scope, [
        { ...declaration, result: { status: 'unavailable', detail: 'the document said nothing', retryable: false } },
      ]),
      token,
    );
    assert.equal(omitted.materials[0]?.outcome, 'ignored');
    assert.equal(omitted.snapshots[0]?.changed, false);
    assert.equal(omitted.snapshots[0]?.snapshotId, snapshot.snapshotId);
  });
});

void test('a declaration note equal to its detail is stored once while different ones keep both', async () => {
  await withStore(async (store) => {
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const sentence = '已核实没有题解：官方题解列表为空';
    const declaration = (scope: fx.Scope, note: string, detail: string): ManualMaterialInput => ({
      problemKey: scope.problem.key,
      result: { status: 'absent', detail },
      url: 'https://blog.example.org/none',
      title: 'Checked page',
      note,
    });

    // One input in both fields — what an explicit absence declaration produces — with surrounding
    // whitespace that must not defeat the comparison: the sentence is stored once.
    const same = fx.makeScope('manual', 'local.example.org', 'alice', 'P3');
    const one = await service.applyManual(manualBundle(same, [declaration(same, `  ${sentence}  `, sentence)]), token);
    const oneSnapshot = await store.getSnapshot(one.snapshots[0]?.snapshotId ?? '');
    assert.ok(oneSnapshot);
    assert.equal(oneSnapshot.sources.length, 1);
    assert.equal(oneSnapshot.sources[0]?.note, sentence, 'the repeated sentence is stored once');

    // Two genuinely different fragments keep the existing format and their order.
    const different = fx.makeScope('manual', 'local.example.org', 'alice', 'P4');
    const two = await service.applyManual(
      manualBundle(different, [declaration(different, 'user checked the blog index', 'checked by hand')]),
      token,
    );
    const twoSnapshot = await store.getSnapshot(two.snapshots[0]?.snapshotId ?? '');
    assert.ok(twoSnapshot);
    assert.equal(twoSnapshot.sources[0]?.note, 'user checked the blog index | checked by hand');
    assert.notEqual(twoSnapshot.snapshotId, oneSnapshot.snapshotId);
  });
});

void test('a canceled final write rolls the whole manual document back', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('manual', 'local.example.org', 'alice', 'P1');
    const cancellation = createCancellationSource();
    const instrumented = instrumentStore(store, { afterUpsertProblems: () => cancellation.cancel('user aborted') });

    await assert.rejects(
      () => serviceFor(instrumented.store).applyManual(manualBundle(scope), cancellation.token),
      isDomain('cancelled'),
    );

    assert.equal(await store.getProblem(scope.problem.key), null);
    assert.equal((await store.listAccounts(scope.instance.id)).length, 0);
    assert.equal((await store.listSourceInstances()).length, 0);
    assert.equal((await store.listSubmissions(scope.account.id, { limit: 10, cursor: null })).items.length, 0);
    assert.equal(await store.getCurrentSnapshotHead(scope.problem.ref), null);
  });
});

// ---------------------------------------------------------------------------------------
// Paged sync
// ---------------------------------------------------------------------------------------

void test('a failed page leaves the checkpoint, the source and the history untouched', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    adapter.submissionPages.push(new PlatformError({ code: 'unavailable', operation: 'submissions', detail: '503' }));
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: scope.account.id,
      resource: 'submissions',
    };

    await assert.rejects(
      () =>
        serviceFor(store).syncPage(adapter, {
          resource: 'submissions',
          account: scope.account,
          mode: 'start',
          limit: 50,
          limits: LIMITS,
          token: createCancellationSource().token,
        }),
      (error) => error instanceof PlatformError && error.code === 'unavailable',
    );

    assert.equal(await store.getSyncCheckpoint(ref), null);
    assert.equal((await store.listSubmissions(scope.account.id, { limit: 10, cursor: null })).items.length, 0);
    assert.equal((await store.listSourceInstances()).length, 0, 'source is persisted only with a committed page');
  });
});

void test('a concurrent writer on the same cursor prevents the commit instead of being overwritten', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: scope.account.id,
      resource: 'submissions',
    };
    adapter.submissionPages.push({ items: [fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted')], nextCursor: 'page-2' });
    adapter.afterListSubmissions = async () => {
      await store.saveSyncCheckpoint({ ...ref, cursor: 'other-writer', since: null, updatedAt: fx.LATER });
    };

    await assert.rejects(
      () => service.syncPage(adapter, { resource: 'submissions', account: scope.account, mode: 'start', limit: 50, limits: LIMITS, token }),
      isDomain('invalid_transition'),
    );

    assert.equal((await store.getSyncCheckpoint(ref))?.cursor, 'other-writer');
    assert.equal((await store.listSubmissions(scope.account.id, { limit: 10, cursor: null })).items.length, 0);
  });
});

void test('sync modes enforce resume rules and restart returns to the first page', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: scope.account.id,
      resource: 'submissions',
    };
    const request = (mode: 'start' | 'continue' | 'restart', since?: string | null) => ({
      resource: 'submissions' as const,
      account: scope.account,
      mode,
      ...(since === undefined ? {} : { since }),
      limit: 50,
      limits: LIMITS,
      token,
    });

    await assert.rejects(() => service.syncPage(adapter, request('continue')), isDomain('invalid_transition'));

    await store.saveSyncCheckpoint({ ...ref, cursor: 'page-2', since: fx.AT, updatedAt: fx.AT });
    await assert.rejects(() => service.syncPage(adapter, request('start')), isDomain('invalid_transition'));
    await assert.rejects(() => service.syncPage(adapter, request('continue', fx.LATER)), isDomain('invalid_input'));

    adapter.submissionPages.push({ items: [], nextCursor: null });
    const resumed = await service.syncPage(adapter, request('continue'));
    const resumedCall = lastRequest<ListSubmissionsRequest>(adapter, 'listSubmissions');
    assert.equal(resumedCall.cursor, 'page-2');
    assert.equal(resumedCall.since, fx.AT);
    assert.equal(resumed.complete, true);
    assert.equal(resumed.checkpoint.since, fx.AT, 'the bound survives a completed scan');
    assert.equal(resumed.checkpoint.cursor, null);

    await store.saveSyncCheckpoint({ ...ref, cursor: 'page-2', since: fx.AT, updatedAt: fx.AT });
    adapter.submissionPages.push({ items: [], nextCursor: 'page-9' });
    const restarted = await service.syncPage(adapter, request('restart'));
    assert.equal(lastRequest<ListSubmissionsRequest>(adapter, 'listSubmissions').cursor, null);
    assert.equal(restarted.checkpoint.cursor, 'page-9');
    assert.equal(restarted.checkpoint.since, fx.AT, 'restart keeps the interrupted scan bound');
  });
});

void test('a new scan without an explicit bound is a full scan, never the newest submission time', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted', fx.LATER)]);

    adapter.submissionPages.push({ items: [], nextCursor: null });
    const fresh = await service.syncPage(adapter, {
      resource: 'submissions',
      account: scope.account,
      mode: 'start',
      limit: 50,
      limits: LIMITS,
      token,
    });
    assert.equal(fresh.since, null);
    assert.equal(lastRequest<ListSubmissionsRequest>(adapter, 'listSubmissions').since, null);

    adapter.submissionPages.push({ items: [], nextCursor: null });
    const bounded = await service.syncPage(adapter, {
      resource: 'submissions',
      account: scope.account,
      mode: 'restart',
      since: '2026-09-01T00:00:00Z',
      limit: 50,
      limits: LIMITS,
      token,
    });
    assert.equal(bounded.since, '2026-09-01T00:00:00.000Z');
    assert.equal(lastRequest<ListSubmissionsRequest>(adapter, 'listSubmissions').since, '2026-09-01T00:00:00.000Z');
  });
});

void test('a foreign account and an out-of-range page limit are rejected before any request', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const foreign = fx.makeScope('luogu', 'luogu.com.cn', 'alice', 'P1000');
    const service = serviceFor(store);
    const token = createCancellationSource().token;

    await assert.rejects(
      () =>
        service.syncPage(adapter, {
          resource: 'submissions',
          account: foreign.account,
          mode: 'start',
          limit: 50,
          limits: LIMITS,
          token,
        }),
      isDomain('missing_reference'),
    );
    await assert.rejects(
      () =>
        service.syncPage(adapter, {
          resource: 'submissions',
          account: scope.account,
          mode: 'start',
          limit: 501,
          limits: LIMITS,
          token,
        }),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      () =>
        service.syncPage(adapter, {
          resource: 'problems',
          mode: 'start',
          limit: 0,
          limits: LIMITS,
          token,
        }),
      isDomain('invalid_input'),
    );
    assert.equal(adapter.calls.length, 0);
  });
});

void test('submissions whose problem metadata is missing are retained and reported, not fabricated', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const other = fx.makeProblem(
      { sourceInstanceId: scope.instance.id, domain: null, externalKey: '1901B' },
      { title: 'Problem 1901B' },
    );
    const adapter = new FakeAdapter(scope.instance);
    adapter.submissionPages.push({
      items: [
        fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted'),
        fx.makeSubmission(scope.account, other.ref, 'S2', 'wrong_answer'),
      ],
      nextCursor: null,
    });

    const report = await serviceFor(store).syncPage(adapter, {
      resource: 'submissions',
      account: scope.account,
      mode: 'start',
      limit: 50,
      limits: LIMITS,
      token: createCancellationSource().token,
    });
    assert.equal(report.counts.kind, 'submissions');
    if (report.counts.kind !== 'submissions') {
      return;
    }
    assert.equal(report.counts.fetched, 2);
    assert.equal(report.counts.processed, 2);
    assert.equal(report.counts.missingProblemMetadata, 2);
    assert.deepEqual([...report.counts.missingProblemKeys].sort(), [scope.problem.key, other.key].sort());
    assert.equal(await store.getProblem(other.key), null, 'no problem row may be invented');
    assert.equal((await store.listSubmissions(scope.account.id, { limit: 10, cursor: null })).items.length, 2);
  });
});

void test('a page that returns the cursor it was given is refused and writes nothing', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: scope.account.id,
      resource: 'submissions',
    };
    await store.saveSyncCheckpoint({ ...ref, cursor: 'page-2', since: null, updatedAt: fx.AT });
    adapter.submissionPages.push({ items: [], nextCursor: 'page-2' });

    await assert.rejects(
      () =>
        serviceFor(store).syncPage(adapter, {
          resource: 'submissions',
          account: scope.account,
          mode: 'continue',
          limit: 50,
          limits: LIMITS,
          token: createCancellationSource().token,
        }),
      isDomain('invalid_transition'),
    );
    assert.equal((await store.getSyncCheckpoint(ref))?.cursor, 'page-2');
    assert.equal((await store.getSyncCheckpoint(ref))?.updatedAt, fx.AT);
  });
});

void test('a page whose fetchedAt is not a timestamp is refused before any write', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: null,
      resource: 'problems',
    };
    adapter.problemPages.push({
      items: [fx.makeProblem(scope.problem.ref)],
      nextCursor: null,
      fetchedAt: 'yesterday',
    });

    await assert.rejects(
      () =>
        serviceFor(store).syncPage(adapter, {
          resource: 'problems',
          mode: 'start',
          limit: 50,
          limits: LIMITS,
          token: createCancellationSource().token,
        }),
      isDomain('invalid_timestamp'),
    );

    assert.equal(await store.getProblem(scope.problem.key), null);
    assert.equal(await store.getCurrentSnapshotHead(scope.problem.ref), null);
    assert.equal(await store.getSyncCheckpoint(ref), null);
    assert.equal((await store.listSourceInstances()).length, 0);
  });
});

void test('a page that exceeds the requested limit is refused before any write', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: null,
      resource: 'problems',
    };
    adapter.problemPages.push({
      items: [
        fx.makeProblem(scope.problem.ref),
        fx.makeProblem({ ...scope.problem.ref, externalKey: '1901B' }),
      ],
      nextCursor: null,
    });

    await assert.rejects(
      () =>
        serviceFor(store).syncPage(adapter, {
          resource: 'problems',
          mode: 'start',
          limit: 1,
          limits: LIMITS,
          token: createCancellationSource().token,
        }),
      isDomain('invalid_input'),
    );

    assert.equal(await store.getProblem(scope.problem.key), null);
    assert.equal(await store.getCurrentSnapshotHead(scope.problem.ref), null);
    assert.equal(await store.getSyncCheckpoint(ref), null);
    assert.equal((await store.listSourceInstances()).length, 0);
  });
});

// ---------------------------------------------------------------------------------------
// Material refresh and snapshots
// ---------------------------------------------------------------------------------------

void test('a catalog page without a statement cannot erase retrieved text or imported editorial', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const entry = found('manual-editorial-1900a', 'https://blog.example.org/1900a');
    const imported = await service.applyManual(
      { ...manualBundle(scope, [foundMaterial(scope.problem.key, [entry], 'https://blog.example.org/1900a')]), submissions: [] },
      token,
    );
    const head = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(head);

    const adapter = new FakeAdapter(scope.instance);
    adapter.problemPages.push({ items: [fx.makeProblem(scope.problem.ref, { statement: '' })], nextCursor: null });
    const synced = await service.syncPage(adapter, {
      resource: 'problems',
      mode: 'start',
      limit: 50,
      limits: LIMITS,
      token,
    });

    assert.equal(synced.counts.kind, 'problems');
    if (synced.counts.kind === 'problems') {
      assert.deepEqual(
        { inserted: synced.counts.inserted, updated: synced.counts.updated, unchanged: synced.counts.unchanged },
        { inserted: 0, updated: 0, unchanged: 1 },
      );
    }
    const stored = await store.getProblem(scope.problem.key);
    assert.equal(stored?.statement, scope.problem.statement, 'a null statement never erases stored text');
    assert.equal(imported.changedSnapshots, 1);
    assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.snapshotId, head.snapshotId);
    const snapshot = await store.getSnapshot(head.snapshotId);
    assert.equal(snapshot?.sources[0]?.id, 'manual-editorial-1900a');
  });
});

void test('a first catalog page creates an analyzable snapshot head for every problem it writes', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const other = fx.makeProblem({ sourceInstanceId: scope.instance.id, domain: null, externalKey: '1901B' });
    const adapter = new FakeAdapter(scope.instance);
    const instrumented = instrumentStore(store);
    adapter.problemPages.push({ items: [scope.problem, other], nextCursor: null });

    await serviceFor(instrumented.store).syncPage(adapter, {
      resource: 'problems',
      mode: 'start',
      limit: 50,
      limits: LIMITS,
      token: createCancellationSource().token,
    });

    assert.equal(instrumented.savedSnapshots.length, 2);
    for (const problem of [scope.problem, other]) {
      const head = await store.getCurrentSnapshotHead(problem.ref);
      assert.ok(head, `catalog sync must give ${problem.key} a head to analyze`);
      assert.equal(head.version, 1);
      const snapshot = await store.getSnapshot(head.snapshotId);
      assert.equal(snapshot?.problem.title, problem.title);
      assert.equal(snapshot?.problem.statement, problem.statement);
      assert.deepEqual(snapshot?.sources, []);
    }
  });
});

void test('a catalog metadata change advances the head while preserving editorial and the stored statement', async () => {
  await withStore(async (store) => {
    const statement = 'Retrieved statement: range add and range sum.';
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A', { statement });
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const entry = found('cf-blog-1900a', 'https://blog.example.org/1900a');
    await service.applyManual(
      {
        ...manualBundle(scope, [foundMaterial(scope.problem.key, [entry], 'https://blog.example.org/1900a')]),
        submissions: [],
      },
      token,
    );
    const first = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(first);

    const adapter = new FakeAdapter(scope.instance);
    adapter.problemPages.push({
      items: [fx.makeProblem(scope.problem.ref, { title: 'Renamed problem', statement: '' })],
      nextCursor: null,
    });
    const report = await service.syncPage(adapter, {
      resource: 'problems',
      mode: 'start',
      limit: 50,
      limits: LIMITS,
      token,
    });

    assert.equal(report.counts.kind, 'problems');
    if (report.counts.kind === 'problems') {
      assert.equal(report.counts.updated, 1);
    }
    const stored = await store.getProblem(scope.problem.key);
    assert.equal(stored?.title, 'Renamed problem');
    assert.equal(stored?.statement, statement);

    const head = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(head);
    assert.equal(head.version, 2, 'changed metadata must advance the head');
    assert.notEqual(head.snapshotId, first.snapshotId);
    const snapshot = await store.getSnapshot(head.snapshotId);
    assert.equal(snapshot?.problem.title, 'Renamed problem');
    assert.equal(snapshot?.problem.statement, statement);
    assert.deepEqual(snapshot?.sources.map((source) => source.id), ['cf-blog-1900a']);
    assert.equal(snapshot?.solutions.length, 1);
  });
});

void test('a catalog page that only changed observation timestamps reuses the exact stored snapshot', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const token = createCancellationSource().token;
    const instrumented = instrumentStore(store);
    const service = serviceFor(instrumented.store);
    const request = { resource: 'problems' as const, mode: 'start' as const, limit: 50, limits: LIMITS, token };

    adapter.problemPages.push({ items: [fx.makeProblem(scope.problem.ref)], nextCursor: null });
    await service.syncPage(adapter, request);
    const first = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(first);
    assert.deepEqual(instrumented.savedSnapshots, [first.snapshotId]);

    adapter.problemPages.push({
      items: [fx.makeProblem(scope.problem.ref, { fetchedAt: fx.LATER })],
      nextCursor: null,
    });
    const second = await service.syncPage(adapter, request);

    assert.equal(second.counts.kind, 'problems');
    if (second.counts.kind === 'problems') {
      assert.equal(second.counts.updated, 1, 'fetchedAt is stored metadata, so the body changed');
    }
    const head = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.equal(head?.snapshotId, first.snapshotId);
    assert.equal(head?.version, 1);
    assert.deepEqual(instrumented.savedSnapshots, [first.snapshotId], 'unchanged content must not save a snapshot');
  });
});

void test('a catalog metadata cycle A to B to A increments the snapshot version every time', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const token = createCancellationSource().token;
    const service = serviceFor(store);
    const sync = async (title: string) => {
      adapter.problemPages.push({ items: [fx.makeProblem(scope.problem.ref, { title })], nextCursor: null });
      await service.syncPage(adapter, { resource: 'problems', mode: 'start', limit: 50, limits: LIMITS, token });
      const head = await store.getCurrentSnapshotHead(scope.problem.ref);
      assert.ok(head);
      return head;
    };

    const first = await sync('Problem A');
    const second = await sync('Problem B');
    const third = await sync('Problem A');

    assert.deepEqual([first.version, second.version, third.version], [1, 2, 3]);
    assert.equal(third.contentHash, first.contentHash);
    assert.notEqual(third.snapshotId, first.snapshotId);
  });
});

void test('a cancellation observed while writing the page snapshot rolls back the page and the checkpoint', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const adapter = new FakeAdapter(scope.instance);
    const cancellation = createCancellationSource();
    const instrumented = instrumentStore(store, {
      afterSaveSnapshot: () => cancellation.cancel('user aborted'),
    });
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: null,
      resource: 'problems',
    };
    adapter.problemPages.push({ items: [fx.makeProblem(scope.problem.ref)], nextCursor: null });

    await assert.rejects(
      () =>
        serviceFor(instrumented.store).syncPage(adapter, {
          resource: 'problems',
          mode: 'start',
          limit: 50,
          limits: LIMITS,
          token: cancellation.token,
        }),
      isDomain('cancelled'),
    );

    assert.equal(instrumented.savedSnapshots.length, 1, 'the snapshot write was reached before the cancel');
    assert.equal(await store.getProblem(scope.problem.key), null);
    assert.equal(await store.getCurrentSnapshotHead(scope.problem.ref), null);
    assert.equal(await store.getSyncCheckpoint(ref), null);
    assert.equal((await store.listSourceInstances()).length, 0);
  });
});

void test('a found refresh replaces only its own source and preserves separately imported sources', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const first = found('imported-a', 'https://blog.example.org/a');
    const second = found('imported-b', 'https://blog.example.org/b');
    await service.applyManual(
      {
        ...manualBundle(scope, [foundMaterial(scope.problem.key, [first, second], 'https://blog.example.org/a')]),
        submissions: [],
      },
      token,
    );

    const updated = found('imported-a', 'https://blog.example.org/a', 'A rewritten editorial with a different proof.');
    const adapter = new FakeAdapter(scope.instance);
    adapter.editorialResults.push({
      status: 'found',
      sources: [updated.source],
      solutions: [updated.solution],
      retrievedAt: fx.LATER,
    });
    const report = await service.refreshMaterial(adapter, {
      problemRef: scope.problem.ref,
      fetchStatement: false,
      token,
      limits: LIMITS,
    });

    assert.equal(report.material?.outcome, 'applied');
    assert.equal(report.material?.freshFound, true);
    assert.equal(report.material?.staleCachedAvailability, null);
    const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
    assert.ok(snapshot);
    assert.deepEqual(snapshot.sources.map((source) => source.id), ['imported-a', 'imported-b']);
    assert.equal(snapshot.sources.find((source) => source.id === 'imported-a')?.contentHash, updated.source.contentHash);
    assert.equal(snapshot.sources.find((source) => source.id === 'imported-b')?.contentHash, second.source.contentHash);
    assert.equal(snapshot.solutions.length, 2);
    assert.equal(snapshot.solutions.filter((solution) => solution.sourceId === 'imported-a').length, 1);
    assert.equal(
      snapshot.solutions.find((solution) => solution.sourceId === 'imported-b')?.contentHash,
      second.solution.contentHash,
    );
  });
});

void test('a blocked statement still allows an explicitly supplied official tutorial to be fetched', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    await service.applyManual({ ...manualBundle(scope), submissions: [] }, token);

    const official = 'https://codeforces.com/blog/entry/12345';
    const tutorial = found('cf-blog-12345', official);
    const adapter = new FakeAdapter(scope.instance);
    adapter.problemResults.push(new PlatformError({ code: 'forbidden', operation: 'problem', detail: 'login required' }));
    adapter.editorialResults.push({
      status: 'found',
      sources: [tutorial.source],
      solutions: [tutorial.solution],
      retrievedAt: fx.LATER,
    });

    const report = await service.refreshMaterial(adapter, {
      problemRef: scope.problem.ref,
      fetchStatement: true,
      officialTutorialUrl: official,
      token,
      limits: LIMITS,
    });

    assert.equal(report.statement.status, 'failed');
    assert.equal(report.statement.error?.code, 'forbidden');
    assert.equal(report.editorial.attempted, true);
    assert.equal(report.material?.freshFound, true);
    assert.equal(lastRequest<FetchEditorialRequest>(adapter, 'fetchEditorial').officialTutorialUrl, official);
    assert.ok(adapter.calls.some((call) => call.operation === 'fetchProblem'));
    const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
    assert.equal(snapshot?.sources.find((source) => source.id === 'cf-blog-12345')?.url, official);
    assert.equal(snapshot?.problem.statement, scope.problem.statement, 'the failed fetch did not erase the statement');
  });
});

void test('a failed refresh reports the cached availability instead of discarding good material', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const official = 'https://codeforces.com/blog/entry/12345';
    const tutorial = found('cf-blog-12345', official);
    await service.applyManual(
      { ...manualBundle(scope, [foundMaterial(scope.problem.key, [tutorial], official)]), submissions: [] },
      token,
    );

    const adapter = new FakeAdapter(scope.instance);
    adapter.editorialResults.push({ status: 'absent', detail: 'the problem page has no editorial link' });
    const report = await service.refreshMaterial(adapter, {
      problemRef: scope.problem.ref,
      fetchStatement: false,
      token,
      limits: LIMITS,
    });

    assert.equal(report.material?.outcome, 'applied');
    assert.equal(report.material?.availability, 'absent');
    assert.equal(report.material?.freshFound, false);
    assert.equal(report.material?.staleCachedAvailability, 'found');
    const snapshot = await store.getSnapshot(report.snapshot?.snapshotId ?? '');
    assert.ok(snapshot);
    assert.equal(snapshot.sources.find((source) => source.id === 'cf-blog-12345')?.availability, 'found');
    const checkId = editorialSourceIdOf(scope.problem.ref, scope.problem.url);
    assert.equal(snapshot.sources.find((source) => source.id === checkId)?.url, scope.problem.url);
    assert.equal(snapshot.sources.find((source) => source.id === checkId)?.availability, 'absent');
  });
});

void test('a version cycle A to B to A increments the version every time', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    const adapter = new FakeAdapter(scope.instance);
    const statementA = 'Statement A: range add, range sum.';
    const statementB = 'Statement B: point update, range minimum.';
    const refresh = async (statement: string) => {
      adapter.problemResults.push(fx.makeProblem(scope.problem.ref, { statement, fetchedAt: fx.AT }));
      adapter.editorialResults.push({ status: 'absent', detail: 'no editorial' });
      return service.refreshMaterial(adapter, {
        problemRef: scope.problem.ref,
        fetchStatement: true,
        token,
        limits: LIMITS,
      });
    };

    const first = await refresh(statementA);
    const second = await refresh(statementB);
    const third = await refresh(statementA);

    assert.deepEqual(
      [first.snapshot?.version, second.snapshot?.version, third.snapshot?.version],
      [1, 2, 3],
    );
    assert.equal(third.snapshot?.contentHash, first.snapshot?.contentHash);
    assert.notEqual(third.snapshot?.snapshotId, first.snapshot?.snapshotId);
    assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.snapshotId, third.snapshot?.snapshotId);
  });
});

void test('material fetched against a superseded snapshot head is rejected, not written', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1900A');
    const service = serviceFor(store);
    const token = createCancellationSource().token;
    await service.applyManual({ ...manualBundle(scope), submissions: [] }, token);
    const captured = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(captured);

    const entry = found('cf-blog-12345', 'https://codeforces.com/blog/entry/12345');
    const adapter = new FakeAdapter(scope.instance);
    adapter.editorialResults.push({
      status: 'found',
      sources: [entry.source],
      solutions: [entry.solution],
      retrievedAt: fx.LATER,
    });
    adapter.afterFetchEditorial = async () => {
      // A concurrent manual import commits newer content while the refresh is in flight.
      await service.applyManual(
        {
          ...manualBundle(scope),
          problems: [fx.makeProblem(scope.problem.ref, { statement: 'New manual statement.', fetchedAt: fx.LATER })],
          submissions: [],
        },
        token,
      );
    };

    await assert.rejects(
      () =>
        service.refreshMaterial(adapter, {
          problemRef: scope.problem.ref,
          fetchStatement: false,
          token,
          limits: LIMITS,
        }),
      isDomain('invalid_transition'),
    );

    const head = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(head);
    assert.notEqual(head.snapshotId, captured.snapshotId);
    const stored = await store.getSnapshot(head.snapshotId);
    assert.equal(stored?.problem.statement, 'New manual statement.');
    assert.equal(stored?.sources.length, 0, 'stale material must not be written');
  });
});

void test('a failing commit hook rolls back the page rows, the checkpoint and the hook own writes', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('luogu', 'www.luogu.com.cn', '123456', 'P1001');
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: scope.account.id,
      resource: 'submissions',
    };
    const adapter = new FakeAdapter(scope.instance);
    adapter.submissionPages.push({
      items: [fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted')],
      nextCursor: null,
    });

    await assert.rejects(
      serviceFor(store).syncPage(adapter, {
        resource: 'submissions',
        account: scope.account,
        mode: 'start',
        limit: 10,
        limits: LIMITS,
        token: createCancellationSource().token,
        onPageCommitted: async () => {
          await store.saveLuoguSyncState(
            emptyLuoguSyncState(scope.account.id, scope.instance.id, SERVICE_NOW),
            null,
          );
          throw new Error('progress commit refused');
        },
      }),
      /progress commit refused/u,
    );

    assert.equal(await store.getSyncCheckpoint(ref), null, 'the checkpoint rolled back with the hook');
    assert.deepEqual((await store.listSubmissions(scope.account.id, { limit: 10, cursor: null })).items, []);
    assert.equal(await store.getLuoguSyncState(scope.account.id), null, 'the hook own progress rolled back too');
  });
});

void test('a cancellation observed after the commit hook rolls the page and the hook own writes back', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('luogu', 'www.luogu.com.cn', '654321', 'P1002');
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    const ref: SyncCheckpointRef = {
      sourceInstanceId: scope.instance.id,
      accountId: scope.account.id,
      resource: 'submissions',
    };
    const adapter = new FakeAdapter(scope.instance);
    adapter.submissionPages.push({
      items: [fx.makeSubmission(scope.account, scope.problem.ref, 'S2', 'wrong_answer')],
      nextCursor: null,
    });
    const source = createCancellationSource();

    await assert.rejects(
      serviceFor(store).syncPage(adapter, {
        resource: 'submissions',
        account: scope.account,
        mode: 'start',
        limit: 10,
        limits: LIMITS,
        token: source.token,
        onPageCommitted: async () => {
          await store.saveLuoguSyncState(
            emptyLuoguSyncState(scope.account.id, scope.instance.id, SERVICE_NOW),
            null,
          );
          source.cancel('the user left the page');
        },
      }),
      isDomain('cancelled'),
    );

    assert.equal(await store.getSyncCheckpoint(ref), null, 'a late cancellation discards the committed page');
    assert.deepEqual((await store.listSubmissions(scope.account.id, { limit: 10, cursor: null })).items, []);
    assert.equal(await store.getLuoguSyncState(scope.account.id), null);
  });
});

void test('metadata-only refresh never fetches editorial and preserves the stored statement and material', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('manual', 'local.example.org', 'alice', 'P1');
    const service = serviceFor(store);
    await service.applyManual(
      manualBundle(scope, [
        foundMaterial(
          scope.problem.key,
          [found('editorial-1', 'https://editorial.example.org/P1')],
          'https://editorial.example.org/P1',
        ),
      ]),
      createCancellationSource().token,
    );
    const imported = await store.getCurrentSnapshotHead(scope.problem.ref);
    assert.ok(imported);

    const adapter = new FakeAdapter(scope.instance);
    adapter.problemResults.push(
      createNormalizedProblem({
        ref: scope.problem.ref,
        title: 'Renamed by the catalog',
        url: scope.problem.url,
        statement: null,
        fetchedAt: SERVICE_NOW,
        ratings: [{ dimension: 'rating', value: 2000, scale: { min: 800, max: 3500 }, raw: '2000' }],
        rawTags: ['data structures'],
      }),
    );
    const report = await service.refreshProblemMetadata(adapter, {
      problemRef: scope.problem.ref,
      token: createCancellationSource().token,
      limits: LIMITS,
    });

    assert.equal(report.status, 'fetched');
    assert.equal(report.problem?.title, 'Renamed by the catalog');
    assert.equal(
      report.problem?.statement,
      scope.problem.statement,
      'a metadata-only fetch never erases the stored statement',
    );
    assert.equal(
      adapter.calls.some((call) => call.operation === 'fetchEditorial'),
      false,
      'a metadata-only refresh never requests editorial material',
    );
    assert.notEqual(report.snapshot?.snapshotId, imported.snapshotId);
    const stored = await store.getSnapshot(report.snapshot!.snapshotId);
    assert.equal(stored?.sources.length, 1, 'imported editorial material survives the metadata refresh');
    assert.equal(stored?.solutions.length, 1);

    // A body whose identity does not match the request is refused before anything is written.
    const head = await store.getCurrentSnapshotHead(scope.problem.ref);
    const other = fx.makeScope('manual', 'local.example.org', 'alice', 'P2');
    adapter.problemResults.push(fx.makeProblem(other.problem.ref));
    await assert.rejects(
      service.refreshProblemMetadata(adapter, {
        problemRef: scope.problem.ref,
        token: createCancellationSource().token,
        limits: LIMITS,
      }),
      isDomain('invalid_input'),
    );
    assert.deepEqual(await store.getCurrentSnapshotHead(scope.problem.ref), head, 'a mismatched body writes nothing');

    // An operational failure is a typed report, never a fabricated problem.
    adapter.problemResults.push(new PlatformError({ code: 'unavailable', operation: 'problem', detail: '503' }));
    const failed = await service.refreshProblemMetadata(adapter, {
      problemRef: scope.problem.ref,
      token: createCancellationSource().token,
      limits: LIMITS,
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.problem, null);
    assert.equal(failed.snapshot, null);
    assert.equal((await store.getProblem(scope.problem.key))?.title, 'Renamed by the catalog');
  });
});
