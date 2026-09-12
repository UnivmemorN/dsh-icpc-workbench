/**
 * Manual supplementation through the public application API.
 *
 * The workbench's unsolved-problem form never sees raw platform tags, ratings or cached
 * editorial, so `supplementMaterial` must be able to add a statement or a material declaration
 * without a client copy of the problem. Every case drives the real SQLite store and states a
 * consequence the product depends on: hidden metadata survives, an unchanged supplement reuses
 * the exact snapshot, the request shape is closed (unknown fields and arrays are refused), a
 * superseded snapshot id is refused before any write, a cancellation rolls the whole call
 * back, and no material answer ever deletes known-good editorial.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import {
  MAX_SUPPLEMENT_STATEMENT_CHARS,
  editorialSourceIdOf,
  type ManualImportBundle,
  type ManualMaterialInput,
  type SupplementMaterialRequest,
} from '../../src/application/import-types.js';
import type { TrainingStore } from '../../src/application/ports.js';
import {
  DomainError,
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  type CancellationToken,
  type EditorialSolution,
  type EditorialSource,
  type NormalizedProblem,
  type ProblemSnapshot,
  type SnapshotHead,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = fx.AT;
const LATER = fx.LATER;
/** Third fixed observation time, so a reused snapshot's timestamp stays distinguishable. */
const LATER_STILL = '2026-09-12T09:30:00.000Z';
const SEED_STATEMENT = 'Given an array, support range add and range sum queries.';
const HIDDEN_TAGS = ['data structures', 'segment tree'];
const ARTICLE_TEXT = 'Lazy propagation keeps range updates at O(log n).';

interface Clock {
  value: string;
}

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

async function withStore(run: (store: SqliteTrainingStore) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  try {
    await run(store);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

function serviceFor(store: TrainingStore, clock: Clock): ImportService {
  return new ImportService({ store, now: () => clock.value });
}

function isDomain(code: DomainError['code']): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

/**
 * Wrap the store to observe snapshot saves and to run a hook right after a problem write or a
 * snapshot save. Every other call is delegated to the real store, so the open transaction and
 * the store's own state keep working.
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

/** One editorial source plus its solution, built through the domain factories. */
function article(
  id: string,
  text: string,
  title = `Article ${id}`,
): { readonly source: EditorialSource; readonly solution: EditorialSolution } {
  const source = createEditorialSource({
    id,
    kind: 'editorial',
    url: `https://codeforces.com/blog/entry/${id}`,
    title,
    availability: 'found',
    retrievedAt: AT,
    text,
  });
  const solution = createEditorialSolution({
    solutionId: `${id}-solution`,
    sourceId: id,
    ordinal: 0,
    title: `${title} write-up`,
    text,
  });
  return { source, solution };
}

function foundDeclaration(
  problemKeyValue: string,
  sources: readonly EditorialSource[],
  solutions: readonly EditorialSolution[],
): ManualMaterialInput {
  return {
    problemKey: problemKeyValue,
    result: { status: 'found', sources, solutions, retrievedAt: AT },
    url: null,
    title: null,
    note: null,
  };
}

interface Seed {
  readonly problem: NormalizedProblem;
}

/**
 * Import one real problem — with the raw tags and ratings an unsolved-problem DTO hides —
 * through `applyManual`, optionally with material declarations built from the seeded problem.
 */
async function seedProblem(
  service: ImportService,
  token: CancellationToken,
  materialsFor?: (problem: NormalizedProblem) => readonly ManualMaterialInput[],
): Promise<Seed> {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1234A', {
    title: 'Range Add, Range Sum',
    statement: SEED_STATEMENT,
  });
  const bundle: ManualImportBundle = {
    source: scope.instance,
    accounts: [scope.account],
    problems: [scope.problem],
    submissions: [],
    materials: materialsFor === undefined ? [] : materialsFor(scope.problem),
  };
  const report = await service.applyManual(bundle, token);
  assert.equal(report.changedSnapshots, 1);
  return { problem: scope.problem };
}

async function storedProblem(store: TrainingStore, key: string): Promise<NormalizedProblem> {
  const problem = await store.getProblem(key);
  if (problem === null) {
    throw new Error(`problem ${key} is not stored`);
  }
  return problem;
}

async function storedSnapshot(store: TrainingStore, snapshotId: string): Promise<ProblemSnapshot> {
  const snapshot = await store.getSnapshot(snapshotId);
  if (snapshot === null) {
    throw new Error(`snapshot ${snapshotId} is not stored`);
  }
  return snapshot;
}

async function headOf(store: TrainingStore, problem: NormalizedProblem): Promise<SnapshotHead> {
  const head = await store.getCurrentSnapshotHead(problem.ref);
  if (head === null) {
    throw new Error(`problem ${problem.key} has no snapshot head`);
  }
  return head;
}

// ---------------------------------------------------------------------------------------
// Hidden metadata
// ---------------------------------------------------------------------------------------

test('a statement-only supplement preserves stored tags, ratings, title and url', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const service = serviceFor(store, clock);
    const token = createCancellationSource().token;
    const { problem } = await seedProblem(service, token);
    const before = await storedProblem(store, problem.key);
    const head = await headOf(store, problem);

    clock.value = LATER;
    const report = await service.supplementMaterial(
      {
        problemKey: problem.key,
        expectedSnapshotId: head.snapshotId,
        statement: '  Range add, range sum, plus a twist.  ',
      },
      token,
    );

    assert.equal(report.problemKey, problem.key);
    assert.equal(report.material, null);
    assert.equal(report.snapshot.changed, true);
    assert.equal(report.snapshot.version, head.version + 1);

    // The standalone row and the snapshot both keep everything the request never mentioned.
    const stored = await storedProblem(store, problem.key);
    assert.equal(stored.title, before.title);
    assert.equal(stored.url, before.url);
    assert.equal(stored.statement, 'Range add, range sum, plus a twist.');
    assert.deepEqual(
      stored.rawTags.map((tag) => tag.raw),
      HIDDEN_TAGS,
    );
    assert.deepEqual(
      stored.ratings.map((rating) => rating.value),
      [1800],
    );
    assert.equal(stored.fetchedAt, LATER);

    const snapshot = await storedSnapshot(store, report.snapshot.snapshotId);
    assert.equal(snapshot.problem.title, before.title);
    assert.equal(snapshot.problem.url, before.url);
    assert.equal(snapshot.problem.statement, 'Range add, range sum, plus a twist.');
    assert.deepEqual(
      snapshot.problem.rawTags.map((tag) => tag.raw),
      HIDDEN_TAGS,
    );
    assert.deepEqual(
      snapshot.problem.ratings.map((rating) => rating.value),
      [1800],
    );
    assert.equal(snapshot.problem.fetchedAt, LATER);
    assert.equal(snapshot.sources.length, 0);
    assert.equal(snapshot.solutions.length, 0);
  });
});

test('a material-only supplement adds editorial and leaves the stored statement alone', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const service = serviceFor(store, clock);
    const token = createCancellationSource().token;
    const { problem } = await seedProblem(service, token);
    const head = await headOf(store, problem);

    const { source, solution } = article('article-1', ARTICLE_TEXT);
    clock.value = LATER;
    const report = await service.supplementMaterial(
      {
        problemKey: problem.key,
        expectedSnapshotId: head.snapshotId,
        material: foundDeclaration(problem.key, [source], [solution]),
      },
      token,
    );

    assert.ok(report.material !== null);
    assert.equal(report.material.outcome, 'applied');
    assert.equal(report.material.availability, 'found');
    assert.equal(report.material.freshFound, true);
    assert.equal(report.material.staleCachedAvailability, null);
    assert.equal(report.material.sources, 1);
    assert.equal(report.material.solutions, 1);

    const stored = await storedProblem(store, problem.key);
    assert.equal(stored.statement, SEED_STATEMENT);
    assert.deepEqual(
      stored.rawTags.map((tag) => tag.raw),
      HIDDEN_TAGS,
    );

    const snapshot = await storedSnapshot(store, report.snapshot.snapshotId);
    assert.equal(snapshot.problem.statement, SEED_STATEMENT);
    assert.deepEqual(
      snapshot.problem.rawTags.map((tag) => tag.raw),
      HIDDEN_TAGS,
    );
    assert.deepEqual(
      snapshot.sources.map((entry) => entry.id),
      ['article-1'],
    );
    assert.deepEqual(
      snapshot.solutions.map((entry) => entry.solutionId),
      ['article-1-solution'],
    );
    assert.equal(snapshot.sources[0]?.contentHash, source.contentHash);
  });
});

// ---------------------------------------------------------------------------------------
// Snapshot identity
// ---------------------------------------------------------------------------------------

test('an identical supplement reuses the exact snapshot without a new version', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const token = createCancellationSource().token;
    const service = serviceFor(store, clock);
    const { problem } = await seedProblem(service, token);
    const head = await headOf(store, problem);

    const { source, solution } = article('article-1', ARTICLE_TEXT);
    const declaration = foundDeclaration(problem.key, [source], [solution]);
    const instrumented = instrumentStore(store);
    const supplementService = serviceFor(instrumented.store, clock);

    clock.value = LATER;
    const first = await supplementService.supplementMaterial(
      {
        problemKey: problem.key,
        expectedSnapshotId: head.snapshotId,
        statement: 'Stable text.',
        material: declaration,
      },
      token,
    );
    assert.equal(first.snapshot.changed, true);
    assert.equal(instrumented.savedSnapshots.length, 1);

    // A later observation with the same semantic content must not create a new version.
    clock.value = LATER_STILL;
    const second = await supplementService.supplementMaterial(
      {
        problemKey: problem.key,
        expectedSnapshotId: first.snapshot.snapshotId,
        statement: 'Stable text.',
        material: declaration,
      },
      token,
    );

    assert.equal(second.snapshot.changed, false);
    assert.equal(second.snapshot.snapshotId, first.snapshot.snapshotId);
    assert.equal(second.snapshot.version, first.snapshot.version);
    assert.equal(second.snapshot.contentHash, first.snapshot.contentHash);
    assert.equal(second.snapshot.capturedAt, first.snapshot.capturedAt);
    assert.equal(instrumented.savedSnapshots.length, 1);

    // The observation time of the problem row does advance; the reused snapshot keeps its own.
    const stored = await storedProblem(store, problem.key);
    assert.equal(stored.fetchedAt, LATER_STILL);
    const snapshot = await storedSnapshot(store, second.snapshot.snapshotId);
    assert.equal(snapshot.capturedAt, first.snapshot.capturedAt);
  });
});

test('a superseded expectedSnapshotId is refused before any write', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const service = serviceFor(store, clock);
    const token = createCancellationSource().token;
    const { problem } = await seedProblem(service, token);
    const head = await headOf(store, problem);

    clock.value = LATER;
    const first = await service.supplementMaterial(
      { problemKey: problem.key, expectedSnapshotId: head.snapshotId, statement: 'First revision.' },
      token,
    );
    assert.equal((await headOf(store, problem)).snapshotId, first.snapshot.snapshotId);

    clock.value = LATER_STILL;
    await assert.rejects(
      service.supplementMaterial(
        { problemKey: problem.key, expectedSnapshotId: head.snapshotId, statement: 'Second revision.' },
        token,
      ),
      isDomain('invalid_transition'),
    );
    // A caller that saw no snapshot must also be refused once one exists.
    await assert.rejects(
      service.supplementMaterial(
        { problemKey: problem.key, expectedSnapshotId: null, statement: 'Third revision.' },
        token,
      ),
      isDomain('invalid_transition'),
    );

    const stored = await storedProblem(store, problem.key);
    assert.equal(stored.statement, 'First revision.');
    const headAfter = await headOf(store, problem);
    assert.equal(headAfter.snapshotId, first.snapshot.snapshotId);
    assert.equal(headAfter.version, first.snapshot.version);
  });
});

// ---------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------

test('cancellation after the problem write rolls the whole supplement back', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const token = createCancellationSource().token;
    const service = serviceFor(store, clock);
    const { problem } = await seedProblem(service, token);
    const head = await headOf(store, problem);

    const cancellation = createCancellationSource();
    const instrumented = instrumentStore(store, {
      afterUpsertProblems: () => cancellation.cancel('test cancellation'),
    });
    const supplementService = serviceFor(instrumented.store, clock);

    clock.value = LATER;
    await assert.rejects(
      supplementService.supplementMaterial(
        { problemKey: problem.key, expectedSnapshotId: head.snapshotId, statement: 'Should never persist.' },
        cancellation.token,
      ),
      isDomain('cancelled'),
    );

    const stored = await storedProblem(store, problem.key);
    assert.equal(stored.statement, SEED_STATEMENT);
    assert.equal(stored.fetchedAt, AT);
    assert.equal(instrumented.savedSnapshots.length, 0);
    assert.equal((await headOf(store, problem)).snapshotId, head.snapshotId);
  });
});

test('cancellation after the snapshot save leaves the previous head in place', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const token = createCancellationSource().token;
    const service = serviceFor(store, clock);
    const { problem } = await seedProblem(service, token);
    const head = await headOf(store, problem);

    const cancellation = createCancellationSource();
    const instrumented = instrumentStore(store, {
      afterSaveSnapshot: () => cancellation.cancel('test cancellation'),
    });
    const supplementService = serviceFor(instrumented.store, clock);

    clock.value = LATER;
    await assert.rejects(
      supplementService.supplementMaterial(
        { problemKey: problem.key, expectedSnapshotId: head.snapshotId, statement: 'Rolled back.' },
        cancellation.token,
      ),
      isDomain('cancelled'),
    );

    // The save really happened and was rolled back with the transaction, not skipped.
    assert.equal(instrumented.savedSnapshots.length, 1);
    const attempted = instrumented.savedSnapshots[0];
    assert.ok(attempted !== undefined && attempted !== head.snapshotId);
    assert.equal(await store.getSnapshot(attempted), null);

    assert.equal((await headOf(store, problem)).snapshotId, head.snapshotId);
    assert.equal((await storedProblem(store, problem.key)).statement, SEED_STATEMENT);
  });
});

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

test('supplement validation rejects incomplete, oversized, mismatched and undeliverable input', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const service = serviceFor(store, clock);
    const token = createCancellationSource().token;
    const { problem } = await seedProblem(service, token);
    const head = await headOf(store, problem);
    const base = { problemKey: problem.key, expectedSnapshotId: head.snapshotId };

    // Nothing to write at all.
    await assert.rejects(service.supplementMaterial({ ...base }, token), isDomain('invalid_input'));

    // A blank or oversized statement, and an explicit null that must not read as deletion.
    for (const statement of ['', '   ', '\n\t ']) {
      await assert.rejects(service.supplementMaterial({ ...base, statement }, token), isDomain('invalid_input'));
    }
    await assert.rejects(
      service.supplementMaterial({ ...base, statement: 'x'.repeat(MAX_SUPPLEMENT_STATEMENT_CHARS + 1) }, token),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      service.supplementMaterial({ ...base, statement: null } as unknown as SupplementMaterialRequest, token),
      isDomain('invalid_input'),
    );

    // The request is a closed contract: an unknown own field (a smuggled-in title, raw tags or
    // id) and an array in any of the three request positions are refused, not silently ignored.
    for (const extra of [{ rawTags: HIDDEN_TAGS }, { title: 'Smuggled title' }, { snapshotId: head.snapshotId }]) {
      await assert.rejects(
        service.supplementMaterial(
          { ...base, statement: 'Smuggled.', ...extra } as unknown as SupplementMaterialRequest,
          token,
        ),
        isDomain('invalid_input'),
      );
    }
    await assert.rejects(
      service.supplementMaterial([] as unknown as SupplementMaterialRequest, token),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      service.supplementMaterial(
        { ...base, statement: 'Array declaration.', material: [] } as unknown as SupplementMaterialRequest,
        token,
      ),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      service.supplementMaterial(
        {
          ...base,
          material: { problemKey: problem.key, result: [], url: null, title: null, note: null },
        } as unknown as SupplementMaterialRequest,
        token,
      ),
      isDomain('invalid_input'),
    );

    // A declaration for another problem, and one that declares nothing.
    const { source, solution } = article('article-1', ARTICLE_TEXT);
    await assert.rejects(
      service.supplementMaterial({ ...base, material: foundDeclaration('someone|else|key', [source], [solution]) }, token),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      service.supplementMaterial(
        {
          ...base,
          material: {
            problemKey: problem.key,
            result: { status: 'unavailable', detail: 'network down', retryable: true },
            url: null,
            title: null,
            note: null,
          },
        },
        token,
      ),
      isDomain('invalid_input'),
    );

    // A `found` declaration must carry real material, validated through the domain factories.
    await assert.rejects(
      service.supplementMaterial(
        {
          ...base,
          material: {
            problemKey: problem.key,
            result: { status: 'found', sources: [], solutions: [], retrievedAt: AT },
            url: null,
            title: null,
            note: null,
          },
        },
        token,
      ),
      isDomain('invalid_input'),
    );
    const emptyBody = { ...solution, text: '   ' } as unknown as EditorialSolution;
    await assert.rejects(
      service.supplementMaterial({ ...base, material: foundDeclaration(problem.key, [source], [emptyBody]) }, token),
      isDomain('invalid_input'),
    );
    const orphan = {
      ...solution,
      solutionId: 'orphan-solution',
      sourceId: 'unknown-source',
    } as unknown as EditorialSolution;
    await assert.rejects(
      service.supplementMaterial({ ...base, material: foundDeclaration(problem.key, [source], [orphan]) }, token),
      isDomain('missing_reference'),
    );

    // An explicit absence must keep the attribution of the page it refers to.
    const absent = {
      problemKey: problem.key,
      result: { status: 'absent', detail: 'the page has no editorial section' } as const,
      url: 'https://codeforces.com/blog/entry/42',
      title: 'Contest page',
      note: 'Checked by hand.',
    };
    await assert.rejects(
      service.supplementMaterial({ ...base, material: { ...absent, url: null } }, token),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      service.supplementMaterial({ ...base, material: { ...absent, title: null } }, token),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      service.supplementMaterial({ ...base, material: { ...absent, note: '  ' } }, token),
      isDomain('invalid_input'),
    );

    // A token that cannot be this problem's head, and a problem that is not stored at all.
    await assert.rejects(
      service.supplementMaterial(
        { problemKey: problem.key, expectedSnapshotId: 'other|problem|key@deadbeef:v1', statement: 'x' },
        token,
      ),
      isDomain('invalid_input'),
    );
    const other = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '9999Z');
    await assert.rejects(
      service.supplementMaterial({ problemKey: other.problem.key, expectedSnapshotId: null, statement: 'x' }, token),
      isDomain('missing_reference'),
    );

    // None of the rejected calls may have written anything.
    assert.equal((await storedProblem(store, problem.key)).statement, SEED_STATEMENT);
    assert.equal((await headOf(store, problem)).snapshotId, head.snapshotId);
  });
});

// ---------------------------------------------------------------------------------------
// Editorial merge
// ---------------------------------------------------------------------------------------

test('an absence declaration keeps independent articles and its own attribution', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const token = createCancellationSource().token;
    const service = serviceFor(store, clock);
    const first = article('article-1', ARTICLE_TEXT);
    const second = article('article-2', 'Offline queries with a Fenwick tree.');
    const { problem } = await seedProblem(service, token, (seeded) => [
      foundDeclaration(seeded.key, [first.source, second.source], [first.solution, second.solution]),
    ]);
    const head = await headOf(store, problem);

    const url = 'https://codeforces.com/blog/entry/999999';
    const checkId = editorialSourceIdOf(problem.ref, url);
    clock.value = LATER;
    const report = await service.supplementMaterial(
      {
        problemKey: problem.key,
        expectedSnapshotId: head.snapshotId,
        material: {
          problemKey: problem.key,
          result: { status: 'absent', detail: 'the page has no editorial section' },
          url,
          title: 'Contest announcement',
          note: 'Checked by hand on the contest page.',
        },
      },
      token,
    );

    assert.ok(report.material !== null);
    assert.equal(report.material.outcome, 'applied');
    assert.equal(report.material.availability, 'absent');
    assert.equal(report.material.freshFound, false);
    assert.equal(report.material.staleCachedAvailability, 'found');
    assert.equal(report.material.sources, 3);
    assert.equal(report.material.solutions, 2);

    const snapshot = await storedSnapshot(store, report.snapshot.snapshotId);
    const ids = new Set(snapshot.sources.map((entry) => entry.id));
    assert.equal(ids.size, 3);
    assert.ok(ids.has('article-1') && ids.has('article-2') && ids.has(checkId));
    assert.equal(snapshot.sources.filter((entry) => entry.availability === 'found').length, 2);
    assert.equal(snapshot.solutions.length, 2);
    assert.ok(snapshot.solutions.some((entry) => entry.solutionId === 'article-1-solution' && entry.text === ARTICLE_TEXT));

    const check = snapshot.sources.find((entry) => entry.id === checkId);
    assert.ok(check !== undefined);
    assert.equal(check.availability, 'absent');
    assert.equal(check.title, 'Contest announcement');
    assert.equal(check.url, url);
    assert.ok(check.note !== null && check.note.includes('Checked by hand on the contest page.'));
    assert.ok(check.note !== null && check.note.includes('the page has no editorial section'));
  });
});

test('an absence check for a target that already has material preserves it', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const token = createCancellationSource().token;
    const service = serviceFor(store, clock);
    const target = 'https://codeforces.com/blog/entry/777';
    const text = 'A cached body that must survive an absent re-check.';

    // Material previously retrieved for exactly this target carries its target-derived id.
    const { problem } = await seedProblem(service, token, (seeded) => {
      const source = createEditorialSource({
        id: editorialSourceIdOf(seeded.ref, target),
        kind: 'editorial',
        url: target,
        title: 'Editorial for the cached target',
        availability: 'found',
        retrievedAt: AT,
        text,
      });
      const solution = createEditorialSolution({
        solutionId: 'cached-solution',
        sourceId: source.id,
        ordinal: 0,
        title: 'Cached write-up',
        text,
      });
      return [foundDeclaration(seeded.key, [source], [solution])];
    });
    const head = await headOf(store, problem);
    const before = await storedSnapshot(store, head.snapshotId);
    assert.equal(before.sources.length, 1);

    clock.value = LATER;
    const report = await service.supplementMaterial(
      {
        problemKey: problem.key,
        expectedSnapshotId: head.snapshotId,
        material: {
          problemKey: problem.key,
          result: { status: 'absent', detail: 'the page is gone' },
          url: target,
          title: 'Editorial for the cached target',
          note: 'Re-checked manually.',
        },
      },
      token,
    );

    assert.ok(report.material !== null);
    assert.equal(report.material.outcome, 'preserved');
    assert.equal(report.material.availability, null);
    assert.equal(report.material.freshFound, false);
    assert.equal(report.material.staleCachedAvailability, 'found');
    assert.equal(report.snapshot.changed, false);

    const snapshot = await storedSnapshot(store, report.snapshot.snapshotId);
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.sources[0]?.availability, 'found');
    assert.equal(snapshot.sources[0]?.title, 'Editorial for the cached target');
    assert.equal(snapshot.sources[0]?.contentHash, before.sources[0]?.contentHash);
    assert.equal(snapshot.solutions[0]?.text, text);
  });
});

test('a found supplement keeps a successful source at the problem url it does not name', async () => {
  await withStore(async (store) => {
    const clock: Clock = { value: AT };
    const token = createCancellationSource().token;
    const service = serviceFor(store, clock);
    const pageText = 'The published editorial uses a Fenwick tree over the compressed values.';

    // The prior successful article is stored under the target-derived id of the problem URL —
    // exactly the id the next found answer derives when its own declaration URL is null.
    const { problem } = await seedProblem(service, token, (seeded) => {
      const source = createEditorialSource({
        id: editorialSourceIdOf(seeded.ref, seeded.url),
        kind: 'editorial',
        url: seeded.url,
        title: 'Editorial on the problem page',
        availability: 'found',
        retrievedAt: AT,
        text: pageText,
      });
      const solution = createEditorialSolution({
        solutionId: 'problem-page-solution',
        sourceId: source.id,
        ordinal: 0,
        title: 'Problem page write-up',
        text: pageText,
      });
      return [foundDeclaration(seeded.key, [source], [solution])];
    });
    const head = await headOf(store, problem);
    const before = await storedSnapshot(store, head.snapshotId);
    const survivingId = editorialSourceIdOf(problem.ref, problem.url);
    assert.deepEqual(
      before.sources.map((entry) => entry.id),
      [survivingId],
    );

    const independent = article('article-independent', 'An independent write-up with a different proof.');
    clock.value = LATER;
    const report = await service.supplementMaterial(
      {
        problemKey: problem.key,
        expectedSnapshotId: head.snapshotId,
        // A null declaration URL makes the service derive the check id from the problem URL,
        // which is the id the cached successful source already uses.
        material: foundDeclaration(problem.key, [independent.source], [independent.solution]),
      },
      token,
    );

    assert.ok(report.material !== null);
    assert.equal(report.material.outcome, 'applied');
    assert.equal(report.material.freshFound, true);
    assert.equal(report.material.sources, 2);
    assert.equal(report.material.solutions, 2);

    const snapshot = await storedSnapshot(store, report.snapshot.snapshotId);
    const sourceById = new Map(snapshot.sources.map((entry) => [entry.id, entry]));
    assert.deepEqual([...sourceById.keys()].sort(), [independent.source.id, survivingId].sort());
    assert.equal(sourceById.get(survivingId)?.availability, 'found');
    assert.equal(sourceById.get(survivingId)?.contentHash, before.sources[0]?.contentHash);

    // Both full articles survive with their own bodies, and no solution outlives its source.
    const solutionsBySource = new Map(snapshot.solutions.map((entry) => [entry.sourceId, entry]));
    assert.equal(solutionsBySource.get(survivingId)?.text, pageText);
    assert.equal(solutionsBySource.get(independent.source.id)?.text, independent.solution.text);
    assert.equal(snapshot.solutions.length, 2);
    for (const solution of snapshot.solutions) {
      assert.ok(sourceById.has(solution.sourceId), `solution ${solution.solutionId} lost its source`);
    }
  });
});
