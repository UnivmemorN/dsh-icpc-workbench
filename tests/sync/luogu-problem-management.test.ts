/**
 * Local problem management over the real durable stack (Sprint 27b).
 *
 * Drives the real `LuoguSyncService`, the real `ImportService` and real SQLite: a user skips, trashes
 * and restores canonical native keys **while disconnected**, and the assertions cover externally
 * meaningful behaviour — the durable tombstone, queue cleanup on every account of the source,
 * evidence hidden by a trash, no resurrection by a later raw import, no fetching or re-queueing of a
 * disposed key, atomic CAS rollback, restore capacity rollback, foreign-lease protection and a
 * cancellation after the CAS write. The connection manager always throws and the source gate counts
 * its calls, so a successful local mutation proves that no credential and no platform operation was
 * touched.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLuoguAccount } from '../../src/adapters/luogu/index.js';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import type { SyncPageSource } from '../../src/application/import-types.js';
import type { LuoguConnectionManager } from '../../src/application/luogu-connection.js';
import { LuoguSyncError, LuoguSyncService } from '../../src/application/luogu-sync-service.js';
import type { LuoguSourceGate } from '../../src/application/luogu-source-gate.js';
import {
  LUOGU_SYNC_MAX_METADATA_BACKLOG,
  emptyLuoguSyncState,
  type LuoguSyncState,
  type LuoguSyncStore,
} from '../../src/application/luogu-sync-types.js';
import type { ProblemDispositionChangeRequest, TrainingStore } from '../../src/application/ports.js';
import {
  DomainError,
  createCancellationSource,
  parseProblemKey,
  type Account,
  type CancellationToken,
  type SourceInstance,
  type Submission,
} from '../../src/domain/index.js';
import * as sfx from './fixtures.js';
import * as fx from '../storage/fixtures.js';

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

/** Injection points the race tests need; each fires at most once. */
interface Hooks {
  /** Fired right after the store's disposition CAS returned, still inside the transaction. */
  afterDispositionApply: (() => void) | null;
  /** Fired right after a problem read returned, still inside the caller's transaction. */
  afterProblemRead: (() => void) | null;
}

type ObservedStore = TrainingStore & LuoguSyncStore;

/** Delegate every call to the real store, observing the writes the race tests need. */
function instrument(store: SqliteTrainingStore, hooks: Hooks): ObservedStore {
  return new Proxy(store as ObservedStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === 'applyProblemDispositions' && typeof value === 'function') {
        const apply = value as (request: ProblemDispositionChangeRequest) => Promise<number>;
        return async (request: ProblemDispositionChangeRequest): Promise<number> => {
          const changed = await apply.call(target, request);
          const hook = hooks.afterDispositionApply;
          if (hook !== null) {
            hooks.afterDispositionApply = null;
            hook();
          }
          return changed;
        };
      }
      if (property === 'getProblem' && typeof value === 'function') {
        const read = value as (key: string) => Promise<unknown>;
        return async (key: string): Promise<unknown> => {
          const problem = await read.call(target, key);
          const hook = hooks.afterProblemRead;
          if (hook !== null) {
            hooks.afterProblemRead = null;
            hook();
          }
          return problem;
        };
      }
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ObservedStore;
}

interface Harness {
  readonly real: SqliteTrainingStore;
  readonly service: LuoguSyncService;
  readonly instance: SourceInstance;
  readonly account: Account;
  /** A second account of the same instance, for cross-account queue and lease assertions. */
  readonly other: Account;
  readonly clock: sfx.TestClock;
  readonly metadata: sfx.MetadataHarness;
  readonly hooks: Hooks;
  /** Every source-gate entry; a local mutation must leave it at zero. */
  readonly gate: { count: number };
  /** What the synthetic submissions source answers; each test replaces it as needed. */
  readonly submissions: { items: readonly Submission[] };
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
  const hooks: Hooks = { afterDispositionApply: null, afterProblemRead: null };
  const observed = instrument(real, hooks);
  const metadata = sfx.createMetadataAdapter(instance, () => clock.now());
  const gate = { count: 0 };
  const gatePort = {
    run: async (_token: CancellationToken, work: () => Promise<unknown>): Promise<unknown> => {
      gate.count += 1;
      return work();
    },
  } as unknown as LuoguSourceGate;
  const connections = {
    connect: async () => {
      throw new Error('local management must not touch the credential backend');
    },
    probe: async () => {
      throw new Error('local management must not touch the credential backend');
    },
    forget: async () => {
      throw new Error('local management must not touch the credential backend');
    },
  } as unknown as LuoguConnectionManager;
  const submissions: { items: readonly Submission[] } = { items: [] };
  const submissionsFor = (): SyncPageSource => ({
    sourceInstance: instance,
    listSubmissions: async () => ({ items: submissions.items, nextCursor: null, fetchedAt: sfx.START }),
  });
  const service = new LuoguSyncService({
    store: observed,
    imports: new ImportService({ store: observed, now: () => clock.now() }),
    connections,
    sourceInstance: instance,
    submissionsFor,
    metadataSource: metadata.adapter,
    ownerId: 'disposition-owner',
    now: () => clock.now(),
    wait: sfx.createWait().wait,
    gate: gatePort,
    leaseMs: 60_000,
  });
  const harness: Harness = { real, service, instance, account, other, clock, metadata, hooks, gate, submissions };
  try {
    await run(harness);
  } finally {
    await service.close();
    await real.close();
    fx.removeDirectory(temp.dir);
  }
}

function keyOf(harness: Harness, externalKey: string): string {
  return sfx.problemKeyOf(harness.instance, externalKey);
}

/** Store one raw problem row; the returned key is the canonical native key. */
async function seedProblem(harness: Harness, externalKey: string): Promise<string> {
  const key = keyOf(harness, externalKey);
  await harness.real.upsertProblems([
    fx.makeProblem(parseProblemKey(key), { title: '已存题目', statement: '已有题面' }),
  ]);
  return key;
}

/** Save one durable state of `accountId`, merged over the stored row (or a fresh empty state). */
async function saveState(
  harness: Harness,
  accountId: string,
  overrides: Partial<LuoguSyncState> = {},
): Promise<void> {
  const record = await harness.real.getLuoguSyncState(accountId);
  const base = record?.value ?? emptyLuoguSyncState(accountId, harness.instance.id, sfx.START);
  await harness.real.saveLuoguSyncState({ ...base, ...overrides }, record?.revision ?? null);
}

async function stateOf(harness: Harness, accountId: string): Promise<LuoguSyncState> {
  const record = await harness.real.getLuoguSyncState(accountId);
  assert.ok(record !== null, 'the account has a durable state row');
  return record.value;
}

async function dispositionStateOf(harness: Harness, key: string): Promise<string | null> {
  return (await harness.real.getProblemDisposition(key))?.state ?? null;
}

const isDomain = (code: string, reason?: string) => (error: unknown): boolean =>
  error instanceof DomainError && error.code === code && (reason === undefined || error.details['reason'] === reason);

const isSyncError = (code: LuoguSyncError['code']) => (error: unknown): boolean =>
  error instanceof LuoguSyncError && error.code === code;

// ---------------------------------------------------------------------------------------
// Local mutation and the managed read
// ---------------------------------------------------------------------------------------

void test('disconnected skip, trash and restore keep raw evidence and touch no credential or gate', async () => {
  await withHarness(async (h) => {
    const key = await seedProblem(h, 'P7001');
    assert.equal(await h.real.getLuoguConnection(h.account.id), null, 'the account is disconnected');

    const skipped = await h.service.manageProblems(
      { accountId: h.account.id, action: 'skip', items: [{ problemKey: key, expectedState: null }] },
      createCancellationSource().token,
    );
    assert.equal(skipped.changed, 1);
    assert.equal(await dispositionStateOf(h, key), 'skipped');
    assert.equal((await h.real.getProblem(key))?.statement, '已有题面', 'skip keeps the bank intact');

    const skippedPage = await h.service.managedProblems(h.account.id, 'skipped', 1, 20);
    assert.deepEqual(
      skippedPage.items.map((item) => [item.externalKey, item.title, item.state]),
      [['P7001', '已存题目', 'skipped']],
    );
    assert.equal(skippedPage.total, 1);
    assert.equal(skippedPage.page, 1);
    assert.equal(skippedPage.pageSize, 20);
    await assert.rejects(h.service.managedProblems(h.account.id, 'skipped', 1, 51), isDomain('invalid_input'));

    const trashed = await h.service.manageProblems(
      { accountId: h.account.id, action: 'trash', items: [{ problemKey: key, expectedState: 'skipped' }] },
      createCancellationSource().token,
    );
    assert.equal(trashed.changed, 1);
    assert.equal(await dispositionStateOf(h, key), 'trashed');
    assert.equal(await h.real.getProblem(key), null, 'a trashed problem is hidden');
    assert.deepEqual((await h.service.managedProblems(h.account.id, 'skipped', 1, 20)).items, []);
    assert.equal(
      (await h.service.managedProblems(h.account.id, 'trashed', 1, 20)).items[0]?.title,
      '已存题目',
      'the explicit recovery read still shows the raw title',
    );

    const restored = await h.service.manageProblems(
      { accountId: h.account.id, action: 'restore', items: [{ problemKey: key, expectedState: 'trashed' }] },
      createCancellationSource().token,
    );
    assert.equal(restored.changed, 1);
    assert.equal(await dispositionStateOf(h, key), null);
    assert.equal((await h.real.getProblem(key))?.statement, '已有题面', 'restore exposes the retained raw row');

    const state = await stateOf(h, h.account.id);
    assert.equal(state.owner, null, 'the lease is released');
    assert.deepEqual(state.missingMetadata, [], 'a stored problem needs no metadata repair');
    assert.deepEqual(h.metadata.calls, []);
    assert.equal(h.gate.count, 0, 'local management uses neither the gate nor any platform read');
  });
});

void test('one disposition cleans every account queue of the source, touching only the affected keys', async () => {
  await withHarness(async (h) => {
    const trashedKey = await seedProblem(h, 'P7002');
    const keepKey = await seedProblem(h, 'P7003');
    await saveState(h, h.account.id, {
      phase: 'incremental',
      historyComplete: true,
      historyCompletedAt: sfx.START,
      missingMetadata: [trashedKey, keepKey],
      metadataIssues: [
        { problemKey: trashedKey, code: 'internal', reason: null, at: sfx.START, attempts: 1 },
        { problemKey: keepKey, code: 'internal', reason: null, at: sfx.START, attempts: 2 },
      ],
      metadataResolved: 5,
      metadataFailed: 3,
      totalPages: 7,
      failure: {
        code: 'internal',
        at: sfx.START,
        retryAt: '2026-09-12T08:00:02.000Z',
        paused: false,
        stage: 'metadata',
        problemKey: trashedKey,
      },
    });
    const otherFailure = {
      code: 'internal' as const,
      at: sfx.START,
      retryAt: '2026-09-12T08:00:02.000Z',
      paused: false,
      stage: 'metadata' as const,
      problemKey: keepKey,
    };
    await saveState(h, h.other.id, {
      missingMetadata: [trashedKey, keepKey],
      metadataIssues: [
        { problemKey: trashedKey, code: 'internal', reason: null, at: sfx.START, attempts: 1 },
        { problemKey: keepKey, code: 'internal', reason: null, at: sfx.START, attempts: 1 },
      ],
      metadataResolved: 1,
      failure: otherFailure,
    });

    await h.service.manageProblems(
      { accountId: h.account.id, action: 'trash', items: [{ problemKey: trashedKey, expectedState: null }] },
      createCancellationSource().token,
    );

    const mine = await stateOf(h, h.account.id);
    assert.deepEqual(mine.missingMetadata, [keepKey], 'only the affected key left this queue');
    assert.deepEqual(mine.metadataIssues?.map((issue) => issue.problemKey), [keepKey]);
    assert.equal(mine.failure, null, 'a failure naming the trashed key is cleared');
    assert.equal(mine.metadataResolved, 5, 'counters are preserved');
    assert.equal(mine.metadataFailed, 3);
    assert.equal(mine.totalPages, 7);
    assert.equal(mine.phase, 'incremental');
    assert.equal(mine.historyComplete, true);
    assert.equal(mine.owner, null, 'the lease is released');

    const theirs = await stateOf(h, h.other.id);
    assert.deepEqual(theirs.missingMetadata, [keepKey], 'the other account of the source is cleaned too');
    assert.deepEqual(theirs.metadataIssues?.map((issue) => issue.problemKey), [keepKey]);
    assert.deepEqual(theirs.failure, otherFailure, 'a failure naming another key survives');
    assert.equal(theirs.metadataResolved, 1);
  });
});

void test('a trashed problem is hidden everywhere and an incoming raw import cannot resurrect it', async () => {
  await withHarness(async (h) => {
    const key = await seedProblem(h, 'P7004');
    const ref = parseProblemKey(key);
    const problem = await h.real.getProblem(key);
    assert.ok(problem !== null);
    await h.real.upsertSubmissions([fx.makeSubmission(h.account, ref, 's-1', 'accepted', sfx.START)]);
    await h.real.saveRetrospective(fx.makeRetrospective(problem, h.account.id, { recordedAt: sfx.START }));
    assert.equal((await h.real.listSubmissions(h.account.id, { cursor: null, limit: 10 })).items.length, 1);
    assert.equal((await h.real.browseProblems({ page: 1, limit: 10 })).items.length, 1);

    await h.service.manageProblems(
      { accountId: h.account.id, action: 'trash', items: [{ problemKey: key, expectedState: null }] },
      createCancellationSource().token,
    );
    assert.equal(await h.real.getProblem(key), null);
    assert.equal(
      (await h.real.listSubmissions(h.account.id, { cursor: null, limit: 10 })).items.length,
      0,
      'trashed evidence is excluded from the submission read',
    );
    assert.equal(
      (await h.real.listRetrospectives(h.account.id)).length,
      0,
      'trashed completions are excluded from the statistics and ability input',
    );
    assert.equal((await h.real.browseProblems({ page: 1, limit: 10 })).items.length, 0, 'the bank hides it');

    // A later raw import updates evidence but can never clear the tombstone or recreate a visible row.
    await h.real.upsertProblems([fx.makeProblem(ref, { title: '重新导入的题目', statement: '重新导入的题面' })]);
    await h.real.upsertSubmissions([fx.makeSubmission(h.account, ref, 's-2', 'accepted', sfx.START)]);
    assert.equal(await h.real.getProblem(key), null, 'raw imports cannot resurrect a trashed problem');
    assert.equal(await dispositionStateOf(h, key), 'trashed');

    await h.service.manageProblems(
      { accountId: h.account.id, action: 'restore', items: [{ problemKey: key, expectedState: 'trashed' }] },
      createCancellationSource().token,
    );
    assert.equal((await h.real.getProblem(key))?.title, '重新导入的题目', 'restore exposes the newest raw row');
    assert.equal((await h.real.listSubmissions(h.account.id, { cursor: null, limit: 10 })).items.length, 2);
    assert.equal((await h.real.listRetrospectives(h.account.id)).length, 1);
  });
});

// ---------------------------------------------------------------------------------------
// Refusals and rollback
// ---------------------------------------------------------------------------------------

void test('a batch is all-or-none: stale state, unknown key, duplicate and foreign key change nothing', async () => {
  await withHarness(async (h) => {
    const first = await seedProblem(h, 'P7005');
    const second = await seedProblem(h, 'P7006');
    const token = createCancellationSource().token;

    await assert.rejects(
      h.service.manageProblems(
        {
          accountId: h.account.id,
          action: 'skip',
          items: [
            { problemKey: first, expectedState: null },
            { problemKey: second, expectedState: 'skipped' },
          ],
        },
        token,
      ),
      isDomain('invalid_transition', 'disposition_conflict'),
    );
    assert.equal(await dispositionStateOf(h, first), null, 'the valid first item rolled back with the stale one');
    assert.equal(await dispositionStateOf(h, second), null);

    await assert.rejects(
      h.service.manageProblems(
        { accountId: h.account.id, action: 'skip', items: [{ problemKey: keyOf(h, 'P7999'), expectedState: null }] },
        token,
      ),
      isDomain('invalid_input'),
    );

    await assert.rejects(
      h.service.manageProblems(
        {
          accountId: h.account.id,
          action: 'skip',
          items: [
            { problemKey: first, expectedState: null },
            { problemKey: first, expectedState: null },
          ],
        },
        token,
      ),
      isDomain('invalid_input'),
    );

    const foreign = fx.keyOf(fx.makeRef(fx.makeInstance('codeforces', 'codeforces.com'), '1234A'));
    await assert.rejects(
      h.service.manageProblems(
        { accountId: h.account.id, action: 'skip', items: [{ problemKey: foreign, expectedState: null }] },
        token,
      ),
      isSyncError('account_foreign'),
    );

    assert.equal(await dispositionStateOf(h, first), null);
    assert.equal(await stateOf(h, h.account.id).then((state) => state.owner), null, 'no lease is left behind');
    assert.deepEqual(h.metadata.calls, []);
  });
});

void test('a restore that would overflow the metadata backlog rolls the tombstone back', async () => {
  await withHarness(async (h) => {
    const key = keyOf(h, 'P7007');
    const filler = Array.from({ length: LUOGU_SYNC_MAX_METADATA_BACKLOG - 1 }, (_, index) =>
      keyOf(h, 'P' + String(700000 + index)),
    );
    await saveState(h, h.account.id, { missingMetadata: [key, ...filler] });

    await h.service.manageProblems(
      { accountId: h.account.id, action: 'trash', items: [{ problemKey: key, expectedState: null }] },
      createCancellationSource().token,
    );
    assert.equal(await dispositionStateOf(h, key), 'trashed');
    const afterTrash = await stateOf(h, h.account.id);
    assert.equal(afterTrash.missingMetadata.length, LUOGU_SYNC_MAX_METADATA_BACKLOG - 1);

    // Another key fills the queue again, so restoring the still-unstored problem cannot fit.
    await saveState(h, h.account.id, {
      missingMetadata: [...afterTrash.missingMetadata, keyOf(h, 'P799999')],
    });
    assert.equal((await stateOf(h, h.account.id)).missingMetadata.length, LUOGU_SYNC_MAX_METADATA_BACKLOG);

    await assert.rejects(
      h.service.manageProblems(
        { accountId: h.account.id, action: 'restore', items: [{ problemKey: key, expectedState: 'trashed' }] },
        createCancellationSource().token,
      ),
      isDomain('invalid_transition', 'metadata_backlog_full'),
    );
    assert.equal(await dispositionStateOf(h, key), 'trashed', 'the tombstone rolled back with the failed restore');
    const state = await stateOf(h, h.account.id);
    assert.equal(state.missingMetadata.length, LUOGU_SYNC_MAX_METADATA_BACKLOG);
    assert.equal(state.owner, null, 'the lease is released after the rollback');
  });
});

void test('a live foreign lease is refused and a cancellation after the CAS rolls the batch back', async () => {
  await withHarness(async (h) => {
    const first = await seedProblem(h, 'P7008');
    const second = await seedProblem(h, 'P7009');

    await saveState(h, h.other.id, { owner: 'another-owner', leaseExpiresAt: '2099-01-01T00:00:00.000Z' });
    await assert.rejects(
      h.service.manageProblems(
        { accountId: h.account.id, action: 'trash', items: [{ problemKey: first, expectedState: null }] },
        createCancellationSource().token,
      ),
      isSyncError('busy'),
    );
    assert.equal(await dispositionStateOf(h, first), null, 'a foreign lease refuses before any write');
    const refusedState = await h.real.getLuoguSyncState(h.account.id);
    assert.equal(refusedState?.value.owner ?? null, null, 'a refused call takes no lease');

    await saveState(h, h.other.id, { owner: null, leaseExpiresAt: null });

    const cancellation = createCancellationSource();
    h.hooks.afterDispositionApply = () => cancellation.cancel('test cancellation');
    await assert.rejects(
      h.service.manageProblems(
        { accountId: h.account.id, action: 'trash', items: [{ problemKey: second, expectedState: null }] },
        cancellation.token,
      ),
      (error: unknown) => error instanceof DomainError && error.code === 'cancelled',
    );
    assert.equal(await dispositionStateOf(h, second), null, 'the CAS write rolled back with the transaction');
    assert.equal((await stateOf(h, h.account.id)).owner, null, 'the lease is released after the rollback');
  });
});

// ---------------------------------------------------------------------------------------
// Authoritative suppression at later sync work
// ---------------------------------------------------------------------------------------

void test('a disposed key is never fetched or requeued, and a later history page cannot resurrect it', async () => {
  await withHarness(async (h) => {
    const trashedKey = await seedProblem(h, 'P7010');
    const freshKey = keyOf(h, 'P7011');
    await saveState(h, h.account.id, { missingMetadata: [trashedKey, freshKey] });

    await h.service.manageProblems(
      { accountId: h.account.id, action: 'trash', items: [{ problemKey: trashedKey, expectedState: null }] },
      createCancellationSource().token,
    );
    // A stale queue entry may survive in a row the disposition cleanup has not seen (another
    // instance wrote it): the metadata loop must dequeue it without one request.
    await saveState(h, h.account.id, { missingMetadata: [trashedKey, freshKey] });

    await h.service.start(h.account.id, 'metadata', createCancellationSource().token);
    await h.service.settle();
    assert.deepEqual(h.metadata.calls, ['P7011'], 'only the live key was fetched');
    assert.deepEqual((await stateOf(h, h.account.id)).missingMetadata, [], 'the disposed key was dequeued');
    assert.equal(await h.real.getProblem(trashedKey), null, 'the disposed problem was not recreated');

    // A later history page that references the trashed key stores its evidence but never requeues it.
    h.submissions.items = [fx.makeSubmission(h.account, parseProblemKey(trashedKey), 'sub-77', 'accepted', sfx.START)];
    await h.service.start(h.account.id, 'resume', createCancellationSource().token);
    await h.service.settle();
    const afterResume = await stateOf(h, h.account.id);
    assert.deepEqual(afterResume.missingMetadata, [], 'a history page never requeues a disposed key');
    assert.equal(afterResume.metadataResolved, 1, 'only the live key was repaired');
    assert.equal(
      (await h.real.listSubmissions(h.account.id, { cursor: null, limit: 10 })).items.length,
      0,
      'evidence of a trashed problem stays hidden while the tombstone lasts',
    );
    assert.equal(await h.real.getProblem(trashedKey), null, 'a history page cannot resurrect the trashed problem');
    assert.equal(await dispositionStateOf(h, trashedKey), 'trashed');
    assert.equal(h.metadata.calls.filter((pid) => pid === 'P7010').length, 0);

    // The only way to make the retained evidence visible again is an explicit restore.
    await h.service.manageProblems(
      { accountId: h.account.id, action: 'restore', items: [{ problemKey: trashedKey, expectedState: 'trashed' }] },
      createCancellationSource().token,
    );
    assert.equal(
      (await h.real.listSubmissions(h.account.id, { cursor: null, limit: 10 })).items.length,
      1,
      'the submission the history page stored is retained and exposed after the restore',
    );
  });
});

// ---------------------------------------------------------------------------------------
// Fresh lease at the transaction's write boundary
// ---------------------------------------------------------------------------------------

void test('a lease that expires after the CAS write rolls the tombstone and the queue cleanup back', async () => {
  await withHarness(async (h) => {
    const key = await seedProblem(h, 'P7012');
    await saveState(h, h.account.id, { missingMetadata: [key] });

    // The lease is valid when the batch starts; it expires while the queue cleanup awaits its
    // per-account reads, so the write boundary must refuse the commit instead of trusting the
    // reading taken before the CAS.
    h.hooks.afterDispositionApply = () => h.clock.advance(120_000);
    await assert.rejects(
      h.service.manageProblems(
        { accountId: h.account.id, action: 'trash', items: [{ problemKey: key, expectedState: null }] },
        createCancellationSource().token,
      ),
      isSyncError('lease_lost'),
    );

    assert.equal(await dispositionStateOf(h, key), null, 'the tombstone rolled back with the transaction');
    const state = await stateOf(h, h.account.id);
    assert.deepEqual(state.missingMetadata, [key], 'the queue cleanup rolled back too');
    assert.equal(state.owner, null, 'the expired lease is released after the rollback');
  });
});

void test('a lease that expires while the restore reads its problem row rolls the restore back', async () => {
  await withHarness(async (h) => {
    const key = await seedProblem(h, 'P7013');
    await h.service.manageProblems(
      { accountId: h.account.id, action: 'trash', items: [{ problemKey: key, expectedState: null }] },
      createCancellationSource().token,
    );
    // A stale queue entry may survive in a row the disposition cleanup has not seen; the restore
    // would normally dequeue it. The lease expires during the per-key problem read.
    await saveState(h, h.account.id, { missingMetadata: [key] });
    h.hooks.afterProblemRead = () => h.clock.advance(120_000);

    await assert.rejects(
      h.service.manageProblems(
        { accountId: h.account.id, action: 'restore', items: [{ problemKey: key, expectedState: 'trashed' }] },
        createCancellationSource().token,
      ),
      isSyncError('lease_lost'),
    );

    assert.equal(await dispositionStateOf(h, key), 'trashed', 'the tombstone survived the rolled-back restore');
    const state = await stateOf(h, h.account.id);
    assert.deepEqual(state.missingMetadata, [key], 'the queue cleanup rolled back with the tombstone');
    assert.equal(state.owner, null, 'the expired lease is released after the rollback');
    assert.equal(await h.real.getProblem(key), null, 'the problem stays hidden by the surviving tombstone');
  });
});

// ---------------------------------------------------------------------------------------
// A restore queues stored problems without a usable statement
// ---------------------------------------------------------------------------------------

void test('a restore requeues problems without a usable statement and keeps a complete one out', async () => {
  await withHarness(async (h) => {
    const nullKey = keyOf(h, 'P7014');
    const blankKey = keyOf(h, 'P7015');
    const validKey = await seedProblem(h, 'P7016');
    const blankSeed = fx.makeProblem(parseProblemKey(blankKey), { title: '空题面题目', statement: '占位题面' });
    await h.real.upsertProblems([
      // The domain factory normalizes a blank statement to `null`: the user's empty testcase row.
      fx.makeProblem(parseProblemKey(nullKey), { title: '无题面题目', statement: '   ' }),
      // A row written with a raw blank body (an older row): still no usable statement.
      { ...blankSeed, statement: '   ' },
    ]);
    assert.equal((await h.real.getProblem(nullKey))?.statement, null, 'the seeded row really has no statement');
    assert.equal((await h.real.getProblem(blankKey))?.statement, '   ', 'the seeded row really carries a blank body');

    const token = createCancellationSource().token;
    await h.service.manageProblems(
      {
        accountId: h.account.id,
        action: 'trash',
        items: [nullKey, blankKey, validKey].map((problemKey) => ({ problemKey, expectedState: null })),
      },
      token,
    );
    await h.service.manageProblems(
      {
        accountId: h.account.id,
        action: 'restore',
        items: [nullKey, blankKey, validKey].map((problemKey) => ({ problemKey, expectedState: 'trashed' as const })),
      },
      token,
    );

    const state = await stateOf(h, h.account.id);
    assert.deepEqual(
      state.missingMetadata,
      [nullKey, blankKey],
      'exactly the problems without a usable statement are queued for repair',
    );
    assert.deepEqual(state.metadataIssues, [], 'a restore records no diagnostic');
    assert.equal(await dispositionStateOf(h, nullKey), null);
    assert.equal(await dispositionStateOf(h, blankKey), null);
    assert.equal(await dispositionStateOf(h, validKey), null);
    assert.equal((await h.real.getProblem(validKey))?.statement, '已有题面', 'a retained statement is untouched');
    assert.equal(
      (await h.real.getProblem(blankKey))?.title,
      '空题面题目',
      'the raw row is retained and visible again',
    );
    assert.equal(h.gate.count, 0, 'the restore itself performs no platform read');
  });
});
