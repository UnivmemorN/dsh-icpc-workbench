/**
 * Manual recovery of one queued Luogu problem (Sprint 25a4) over the real durable stack.
 *
 * Every case drives the real `LuoguSyncService`, the real `ImportService` and real SQLite: a queued
 * key the platform will not serve is completed with the title and statement a **user** typed, with
 * no platform request, no credential and no model. The assertions cover externally meaningful
 * behaviour: the exact identity a missing problem is created with, the metadata an existing row
 * keeps, the one atomic transaction (problem + snapshot + dequeue + diagnostic + counter), stale or
 * premature snapshot claims, cancellation, lease expiry and takeover, unqueued/foreign keys, and
 * the rejection of malformed input. The connection manager, the source gate and the submissions
 * source all throw if touched, so a successful recovery proves the operation is local.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLuoguAccount } from '../../src/adapters/luogu/index.js';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import {
  MAX_SUPPLEMENT_STATEMENT_CHARS,
  MAX_SUPPLEMENT_TITLE_CHARS,
} from '../../src/application/import-types.js';
import type { LuoguConnectionManager } from '../../src/application/luogu-connection.js';
import { LuoguSyncError, LuoguSyncService } from '../../src/application/luogu-sync-service.js';
import type { LuoguSourceGate } from '../../src/application/luogu-source-gate.js';
import {
  emptyLuoguSyncState,
  type LuoguSyncState,
  type LuoguSyncStore,
} from '../../src/application/luogu-sync-types.js';
import type { TrainingStore } from '../../src/application/ports.js';
import {
  DomainError,
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  createProblemSnapshot,
  parseProblemKey,
  type Account,
  type NormalizedProblem,
  type ProblemSnapshot,
  type SourceInstance,
} from '../../src/domain/index.js';
import * as sfx from './fixtures.js';
import * as fx from '../storage/fixtures.js';

const SEEDED_STATEMENT = '原有的完整题面（来自平台导入）。';
const SEEDED_SOLUTION = '官方题解正文，补充题面后必须保留。';

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

/** One-shot instrumentation of the store reads the recovery performs inside its transaction. */
interface Instrumentation {
  /** Fired right after the next `getProblem` read returns; used to cancel, expire or take over. */
  afterProblemRead: (() => void) | null;
  /** When true, the next state read reports another live owner (a durable lease takeover). */
  takeover: boolean;
  /** Number of durable state reads, for assertions about what the operation touched. */
  stateReads: number;
}

interface Harness {
  readonly real: SqliteTrainingStore;
  readonly service: LuoguSyncService;
  readonly instance: SourceInstance;
  readonly account: Account;
  /** A second account of the same instance, used for the cross-account lease assertion. */
  readonly other: Account;
  readonly clock: sfx.TestClock;
  readonly metadata: sfx.MetadataHarness;
  readonly instrumentation: Instrumentation;
}

type ObservedStore = TrainingStore & LuoguSyncStore;

/**
 * Proxy that delegates every call to the real store and adds the two observations the recovery
 * race tests need: a hook fired after one problem read, and a single doctored state read that
 * reports another live owner.
 */
function instrument(store: SqliteTrainingStore, instrumentation: Instrumentation): ObservedStore {
  return new Proxy(store as ObservedStore, {
    get(target, property, receiver) {
      if (property === 'getProblem') {
        return async (key: string): Promise<NormalizedProblem | null> => {
          const value = await target.getProblem(key);
          const hook = instrumentation.afterProblemRead;
          if (hook !== null) {
            instrumentation.afterProblemRead = null;
            hook();
          }
          return value;
        };
      }
      if (property === 'getLuoguSyncState') {
        return async (accountId: string) => {
          instrumentation.stateReads += 1;
          const record = await target.getLuoguSyncState(accountId);
          if (instrumentation.takeover && record !== null) {
            instrumentation.takeover = false;
            return {
              ...record,
              value: { ...record.value, owner: 'another-owner', leaseExpiresAt: '2099-01-01T00:00:00.000Z' },
            };
          }
          return record;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ObservedStore;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const temp = fx.tempDatabase();
  const clock = sfx.createClock(sfx.START);
  const real = new SqliteTrainingStore({ path: temp.path, now: () => clock.now() });
  const instance = sfx.officialInstance();
  const account = createLuoguAccount(instance, '800001');
  const other = createLuoguAccount(instance, '800002');
  await real.upsertSourceInstances([instance]);
  await real.upsertAccounts([account, other]);
  const instrumentation: Instrumentation = { afterProblemRead: null, takeover: false, stateReads: 0 };
  const observed = instrument(real, instrumentation);
  const metadata = sfx.createMetadataAdapter(instance, () => clock.now());
  const connections = {
    connect: async () => {
      throw new Error('manual recovery must not touch the credential backend');
    },
    probe: async () => {
      throw new Error('manual recovery must not touch the credential backend');
    },
    forget: async () => {
      throw new Error('manual recovery must not touch the credential backend');
    },
  } as unknown as LuoguConnectionManager;
  const gate = {
    run: async () => {
      throw new Error('manual recovery must not use the source gate');
    },
  } as unknown as LuoguSourceGate;
  const service = new LuoguSyncService({
    store: observed,
    imports: new ImportService({ store: observed, now: () => clock.now() }),
    connections,
    sourceInstance: instance,
    submissionsFor: () => {
      throw new Error('manual recovery must not read submissions');
    },
    metadataSource: metadata.adapter,
    ownerId: 'recovery-owner',
    now: () => clock.now(),
    wait: sfx.createWait().wait,
    gate,
    leaseMs: 60_000,
  });
  const harness: Harness = { real, service, instance, account, other, clock, metadata, instrumentation };
  try {
    await run(harness);
  } finally {
    await service.close();
    await real.close();
    fx.removeDirectory(temp.dir);
  }
}

/** Queue the given keys in a fresh durable state row of `account`. */
async function queueKeys(
  harness: Harness,
  keys: readonly string[],
  overrides: Partial<LuoguSyncState> = {},
): Promise<void> {
  const state: LuoguSyncState = {
    ...emptyLuoguSyncState(harness.account.id, harness.instance.id, sfx.START),
    missingMetadata: [...keys],
    ...overrides,
  };
  await harness.real.saveLuoguSyncState(state, null);
}

/** Store one platform-imported problem with ratings, raw tags and a found editorial article. */
async function seedStoredProblem(
  harness: Harness,
  key: string,
): Promise<{ readonly problem: NormalizedProblem; readonly snapshot: ProblemSnapshot }> {
  const ref = parseProblemKey(key);
  const problem = createNormalizedProblem({
    ref,
    title: '已存题目标题',
    url: `https://${sfx.OFFICIAL_DOMAIN}/problem/${ref.externalKey}`,
    statement: SEEDED_STATEMENT,
    fetchedAt: sfx.START,
    ratings: [{ dimension: 'difficulty', value: 3, scale: { min: 0, max: 7 }, raw: '普及+/提高' }],
    rawTags: ['动态规划', '图论'],
  });
  const source = createEditorialSource({
    id: 'editorial-1',
    kind: 'editorial',
    url: `https://${sfx.OFFICIAL_DOMAIN}/blog/x/solution-${ref.externalKey}`,
    title: '官方题解',
    availability: 'found',
    retrievedAt: sfx.START,
    text: SEEDED_SOLUTION,
  });
  const solution = createEditorialSolution({
    solutionId: 'solution-1',
    sourceId: 'editorial-1',
    ordinal: 0,
    title: '官方题解',
    text: SEEDED_SOLUTION,
  });
  const snapshot = createProblemSnapshot({
    problem,
    sources: [source],
    solutions: [solution],
    capturedAt: sfx.START,
    previous: null,
  });
  await harness.real.upsertProblems([problem]);
  await harness.real.saveSnapshot(snapshot);
  await harness.real.saveManualDecision(fx.makeManualDecision(problem, fx.SEGMENT_TREE_TAG, 'accept', sfx.START));
  await harness.real.saveRetrospective(fx.makeRetrospective(problem, harness.account.id, { recordedAt: sfx.START }));
  return { problem, snapshot };
}

const isStaleSnapshot = (error: unknown): boolean =>
  error instanceof DomainError && error.details['reason'] === 'stale_snapshot';

const isSyncError = (code: LuoguSyncError['code']) => (error: unknown): boolean =>
  error instanceof LuoguSyncError && error.code === code;

// ---------------------------------------------------------------------------------------
// Creating a missing problem
// ---------------------------------------------------------------------------------------

void test('a manual recovery creates the exact canonical problem, keeps metadata unknown and dequeues only its key', async () => {
  await withHarness(async (h) => {
    const sibling = sfx.problemKeyOf(h.instance, 'P5002');
    const key = sfx.problemKeyOf(h.instance, 'P5001');
    await queueKeys(h, [sibling, key]);
    assert.equal(await h.real.getLuoguConnection(h.account.id), null, 'the account is disconnected');

    const result = await h.service.supplementMetadata(
      {
        accountId: h.account.id,
        problemKey: key,
        title: '  本地补全的题目  ',
        statement: '  用户手写的完整题面。  ',
        expectedSnapshotId: null,
      },
      createCancellationSource().token,
    );

    assert.equal(result.outcome, 'supplemented');
    assert.equal(result.accountId, h.account.id);
    assert.equal(result.problemKey, key);
    assert.equal(result.snapshot.changed, true);
    assert.equal(result.snapshot.version, 1);

    const ref = parseProblemKey(key);
    const problem = await h.real.getProblem(key);
    assert.ok(problem !== null);
    assert.equal(problem.key, key);
    assert.equal(problem.ref.sourceInstanceId, h.instance.id);
    assert.equal(problem.ref.domain, ref.domain);
    assert.equal(problem.ref.externalKey, ref.externalKey);
    assert.equal(problem.title, '本地补全的题目');
    assert.equal(problem.url, `https://${sfx.OFFICIAL_DOMAIN}/problem/${ref.externalKey}`);
    assert.equal(problem.statement, '用户手写的完整题面。');
    assert.equal(problem.fetchedAt, sfx.START);
    assert.deepEqual(problem.ratings, [], 'a locally recovered problem has no invented rating');
    assert.deepEqual(problem.rawTags, [], 'a locally recovered problem has no invented platform tag');

    const snapshot = await h.real.getSnapshot(result.snapshot.snapshotId);
    assert.ok(snapshot !== null);
    assert.equal(snapshot.capturedAt, sfx.START);
    assert.equal(snapshot.problem.statement, '用户手写的完整题面。');
    assert.deepEqual(snapshot.sources, [], 'a recovery never declares editorial material');
    assert.deepEqual(snapshot.solutions, []);
    assert.equal(await h.real.getProblem(sibling), null, 'the sibling key is untouched');

    const state = await h.real.getLuoguSyncState(h.account.id);
    assert.ok(state !== null);
    assert.deepEqual(state.value.missingMetadata, [sibling], 'only the selected key left the backlog');
    assert.equal(state.value.metadataResolved, 1);
    assert.equal(state.value.metadataFailed, 0);
    assert.equal(state.value.owner, null, 'the lease is released');
    assert.equal(state.value.leaseExpiresAt, null);

    // No platform read, no history request, no credential and no model anywhere in this call.
    assert.deepEqual(h.metadata.calls, []);
    assert.deepEqual(h.metadata.profileCalls, []);
    assert.equal(h.metadata.editorialCalls(), 0);
  });
});

void test('a manual recovery of an existing row preserves its platform metadata, editorial and decisions', async () => {
  await withHarness(async (h) => {
    const key = sfx.problemKeyOf(h.instance, 'P5003');
    const { problem: seeded, snapshot: previous } = await seedStoredProblem(h, key);
    await queueKeys(h, [key]);
    const manualBefore = await h.real.listManualDecisions(key);
    const retroBefore = await h.real.listRetrospectives(h.account.id);
    assert.equal(manualBefore.length, 1);
    assert.equal(retroBefore.length, 1);

    const result = await h.service.supplementMetadata(
      {
        accountId: h.account.id,
        problemKey: key,
        title: '这个标题必须被忽略',
        statement: '用户补全后的新题面。',
        expectedSnapshotId: previous.snapshotId,
      },
      createCancellationSource().token,
    );
    assert.equal(result.snapshot.changed, true);
    assert.equal(result.snapshot.version, previous.version + 1);
    assert.notEqual(result.snapshot.snapshotId, previous.snapshotId);

    const stored = await h.real.getProblem(key);
    assert.ok(stored !== null);
    assert.equal(stored.title, seeded.title, 'an existing title is preserved, never overwritten by the form');
    assert.equal(stored.url, seeded.url);
    assert.equal(stored.statement, '用户补全后的新题面。');
    assert.deepEqual(
      stored.rawTags.map((tag) => tag.raw),
      ['动态规划', '图论'],
    );
    assert.deepEqual(
      stored.ratings.map((rating) => rating.value),
      [3],
    );
    assert.equal(stored.fetchedAt, sfx.START);

    const head = await h.real.getCurrentSnapshotHead(stored.ref);
    assert.equal(head?.snapshotId, result.snapshot.snapshotId);
    const snapshot = await h.real.getSnapshot(result.snapshot.snapshotId);
    assert.ok(snapshot !== null);
    assert.equal(snapshot.sources.length, 1, 'imported editorial material survives');
    assert.equal(snapshot.solutions.length, 1);
    assert.equal(snapshot.solutions[0]?.text, SEEDED_SOLUTION);
    assert.deepEqual(
      snapshot.problem.rawTags.map((tag) => tag.raw),
      ['动态规划', '图论'],
    );
    // History is immutable: the previous version keeps its own body and timestamp.
    const previousBody = await h.real.getSnapshot(previous.snapshotId);
    assert.ok(previousBody !== null);
    assert.equal(previousBody.problem.statement, SEEDED_STATEMENT);
    assert.equal(previousBody.capturedAt, sfx.START);
    assert.deepEqual(await h.real.listManualDecisions(key), manualBefore, 'manual decisions are untouched');
    assert.deepEqual(await h.real.listRetrospectives(h.account.id), retroBefore, 'completions are untouched');

    const state = await h.real.getLuoguSyncState(h.account.id);
    assert.deepEqual(state?.value.missingMetadata, []);
    assert.equal(state?.value.metadataResolved, 1);
    assert.deepEqual(h.metadata.calls, []);
    assert.equal(h.metadata.editorialCalls(), 0);
  });
});

// ---------------------------------------------------------------------------------------
// Snapshot CAS
// ---------------------------------------------------------------------------------------

void test('a wrong, absent or premature snapshot claim is refused before any write', async () => {
  await withHarness(async (h) => {
    const storedKey = sfx.problemKeyOf(h.instance, 'P5004');
    const missingKey = sfx.problemKeyOf(h.instance, 'P5005');
    const { problem: seeded, snapshot: previous } = await seedStoredProblem(h, storedKey);
    await queueKeys(h, [storedKey, missingKey]);
    const token = createCancellationSource().token;
    const base = { accountId: h.account.id, title: '标题', statement: '用户补全的题面。' };

    // A stored problem exists, but the form claims it saw no snapshot.
    await assert.rejects(
      h.service.supplementMetadata({ ...base, problemKey: storedKey, expectedSnapshotId: null }, token),
      isStaleSnapshot,
    );
    // A snapshot id with the right shape but not this problem's head.
    await assert.rejects(
      h.service.supplementMetadata(
        { ...base, problemKey: storedKey, expectedSnapshotId: `${storedKey}@deadbeef:v9` },
        token,
      ),
      isStaleSnapshot,
    );
    // No problem row at all, but the form claims a snapshot: nothing may be created.
    await assert.rejects(
      h.service.supplementMetadata(
        { ...base, problemKey: missingKey, expectedSnapshotId: `${missingKey}@deadbeef:v1` },
        token,
      ),
      isStaleSnapshot,
    );

    assert.equal(await h.real.getProblem(missingKey), null, 'no problem row was created');
    const stored = await h.real.getProblem(storedKey);
    assert.equal(stored?.statement, seeded.statement, 'the stored statement did not change');
    assert.equal(stored?.fetchedAt, sfx.START);
    const head = await h.real.getCurrentSnapshotHead(seeded.ref);
    assert.equal(head?.snapshotId, previous.snapshotId, 'the head did not move');
    const state = await h.real.getLuoguSyncState(h.account.id);
    assert.deepEqual(state?.value.missingMetadata, [storedKey, missingKey], 'no key was dequeued');
    assert.equal(state?.value.metadataResolved, 0);
    assert.equal(state?.value.owner, null, 'the lease was released after each refusal');
  });
});

// ---------------------------------------------------------------------------------------
// Cancellation, expiry and takeover
// ---------------------------------------------------------------------------------------

void test('a cancellation observed inside the transaction writes nothing and keeps the key queued', async () => {
  await withHarness(async (h) => {
    const key = sfx.problemKeyOf(h.instance, 'P5006');
    await queueKeys(h, [key]);
    const cancellation = createCancellationSource();
    h.instrumentation.afterProblemRead = () => cancellation.cancel('test cancellation');

    await assert.rejects(
      h.service.supplementMetadata(
        { accountId: h.account.id, problemKey: key, title: '标题', statement: '题面。', expectedSnapshotId: null },
        cancellation.token,
      ),
      (error: unknown) => error instanceof DomainError && error.code === 'cancelled',
    );

    assert.equal(await h.real.getProblem(key), null, 'the problem row rolled back');
    const state = await h.real.getLuoguSyncState(h.account.id);
    assert.deepEqual(state?.value.missingMetadata, [key], 'the key stays queued');
    assert.equal(state?.value.metadataResolved, 0);
    assert.equal(state?.value.owner, null, 'the lease is released even when the recovery is cancelled');
  });
});

void test('a lease that expires during the recovery rolls the problem, snapshot and dequeue back', async () => {
  await withHarness(async (h) => {
    const key = sfx.problemKeyOf(h.instance, 'P5007');
    await queueKeys(h, [key]);
    // The clock jumps past the 60s lease right after the problem read, inside the transaction.
    h.instrumentation.afterProblemRead = () => h.clock.advance(120_000);

    await assert.rejects(
      h.service.supplementMetadata(
        { accountId: h.account.id, problemKey: key, title: '标题', statement: '题面。', expectedSnapshotId: null },
        createCancellationSource().token,
      ),
      isSyncError('lease_lost'),
    );

    assert.equal(await h.real.getProblem(key), null, 'nothing was persisted');
    const state = await h.real.getLuoguSyncState(h.account.id);
    assert.deepEqual(state?.value.missingMetadata, [key], 'the key stays queued');
    assert.equal(state?.value.metadataResolved, 0, 'the resolved counter did not increment');
    assert.equal(state?.value.owner, null, 'the expired own lease is released');
  });
});

void test('a lease taken over during the recovery rolls the problem, snapshot and dequeue back', async () => {
  await withHarness(async (h) => {
    const key = sfx.problemKeyOf(h.instance, 'P5008');
    await queueKeys(h, [key]);
    h.instrumentation.afterProblemRead = () => {
      h.instrumentation.takeover = true;
    };

    await assert.rejects(
      h.service.supplementMetadata(
        { accountId: h.account.id, problemKey: key, title: '标题', statement: '题面。', expectedSnapshotId: null },
        createCancellationSource().token,
      ),
      isSyncError('lease_lost'),
    );

    assert.equal(await h.real.getProblem(key), null, 'nothing was persisted for the stale owner');
    const state = await h.real.getLuoguSyncState(h.account.id);
    assert.deepEqual(state?.value.missingMetadata, [key], 'the key stays queued for the new owner');
    assert.equal(state?.value.metadataResolved, 0);
    assert.equal(state?.value.owner, null, 'only the own lease is released');
  });
});

// ---------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------

void test('an unqueued key, a foreign key and a live foreign lease are refused with no write', async () => {
  await withHarness(async (h) => {
    const queued = sfx.problemKeyOf(h.instance, 'P5009');
    const unqueued = sfx.problemKeyOf(h.instance, 'P5010');
    await queueKeys(h, [queued]);
    const token = createCancellationSource().token;
    const base = { accountId: h.account.id, title: '标题', statement: '用户补全的题面。', expectedSnapshotId: null };

    await assert.rejects(
      h.service.supplementMetadata({ ...base, problemKey: unqueued }, token),
      isSyncError('invalid_input'),
    );

    const foreignInstance = fx.makeInstance('codeforces', 'codeforces.com');
    const foreignKey = fx.keyOf(fx.makeRef(foreignInstance, '1234A'));
    await assert.rejects(
      h.service.supplementMetadata({ ...base, problemKey: foreignKey }, token),
      isSyncError('account_foreign'),
    );

    // Another account of the same instance holds a live lease: the source slot is taken.
    await h.real.saveLuoguSyncState(
      {
        ...emptyLuoguSyncState(h.other.id, h.instance.id, sfx.START),
        owner: 'another-owner',
        leaseExpiresAt: fx.LEASE_UNTIL,
      },
      null,
    );
    await assert.rejects(
      h.service.supplementMetadata({ ...base, problemKey: queued }, token),
      isSyncError('busy'),
    );

    assert.equal(await h.real.getProblem(queued), null, 'nothing was written');
    assert.equal(await h.real.getProblem(unqueued), null);
    const state = await h.real.getLuoguSyncState(h.account.id);
    assert.deepEqual(state?.value.missingMetadata, [queued]);
    assert.equal(state?.value.metadataResolved, 0);
    assert.equal(state?.value.owner, null, 'a refused call never took the account lease');
    assert.deepEqual(h.metadata.calls, []);
  });
});

void test('blank, oversized or non-canonical recovery input is refused before any write', async () => {
  await withHarness(async (h) => {
    const key = sfx.problemKeyOf(h.instance, 'P5011');
    await queueKeys(h, [key]);
    const token = createCancellationSource().token;
    const base = {
      accountId: h.account.id,
      problemKey: key,
      title: '标题',
      statement: '用户补全的题面。',
      expectedSnapshotId: null,
    };
    const refused = (error: unknown): boolean =>
      (error instanceof DomainError &&
        (error.code === 'invalid_input' || error.code === 'invalid_id_part' || error.code === 'invalid_timestamp')) ||
      (error instanceof LuoguSyncError && (error.code === 'invalid_input' || error.code === 'account_foreign'));
    const cases: readonly unknown[] = [
      { ...base, title: '   ' },
      { ...base, title: '标'.repeat(MAX_SUPPLEMENT_TITLE_CHARS + 1) },
      { ...base, statement: '\n\t ' },
      { ...base, statement: 'x'.repeat(MAX_SUPPLEMENT_STATEMENT_CHARS + 1) },
      { ...base, statement: undefined },
      { ...base, problemKey: 'not-a-canonical-key' },
      { ...base, expectedSnapshotId: 7 },
    ];
    for (const request of cases) {
      await assert.rejects(h.service.supplementMetadata(request as never, token), refused);
    }

    assert.equal(await h.real.getProblem(key), null, 'no malformed request created a problem');
    const state = await h.real.getLuoguSyncState(h.account.id);
    assert.deepEqual(state?.value.missingMetadata, [key], 'the key stays queued');
    assert.equal(state?.value.metadataResolved, 0);
    assert.equal(state?.value.owner, null);
    assert.deepEqual(h.metadata.calls, []);
  });
});
