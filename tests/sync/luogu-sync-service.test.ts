/**
 * Luogu synchronization service (Sprint 17c2).
 *
 * Every case drives the real service against a real temporary SQLite store, the real Sprint 17c1
 * state/settings/connection rows, the real Sprint 17a authenticated reader over a synthetic
 * `/record/list` feed and an in-memory credential vault. The assertions describe externally
 * meaningful consequences: what was imported, which durable instant the next attempt is derived
 * from, which keys the backlog still holds, who owns the lease, and what a cancellation or a
 * failure leaves behind.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLuoguAccount } from '../../src/adapters/luogu/account.js';
import {
  createLuoguConnectionManager,
  createStoredSubmissionsSource,
  type LuoguConnectionAdapter,
} from '../../src/adapters/luogu/connection.js';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import { createLuoguSourceGate, type LuoguSourceGate } from '../../src/application/luogu-source-gate.js';
import { LuoguSyncError, LuoguSyncService } from '../../src/application/luogu-sync-service.js';
import {
  LUOGU_SYNC_MAX_METADATA_BACKLOG,
  LUOGU_SYNC_OVERLAP_MS,
  emptyLuoguSyncState,
} from '../../src/application/luogu-sync-types.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformLimits } from '../../src/application/ports.js';
import {
  createCancellationSource,
  type Account,
  type CancellationToken,
  type SourceInstance,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';
import {
  buildProblemKeys,
  buildRecords,
  cookieFor,
  createClock,
  createMemoryVault,
  createMetadataAdapter,
  createRecordFeed,
  createWait,
  neverFireTimer,
  officialInstance,
  problemKeyOf,
  toPages,
  until,
  type MetadataHarness,
  type MemoryVault,
  type RecordFeed,
  type TestClock,
  type Waits,
} from './fixtures.js';

/** Deterministic, retry-free transport limits. */
const LIMITS = {
  ...DEFAULT_PLATFORM_LIMITS,
  minRequestIntervalMs: 0,
  requestTimeoutMs: 5_000,
  maxRetries: 0,
  pageSize: 50,
  maxConcurrency: 1,
};

/** Real delay used to let an asynchronous control method (cancel/close) reach its await point. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface AccountPlan {
  readonly total: number;
  readonly pids: readonly string[];
}

interface World {
  readonly store: SqliteTrainingStore;
  readonly paths: { readonly path: string; readonly dir: string };
  readonly clock: TestClock;
  readonly waits: Waits;
  readonly vault: MemoryVault;
  readonly feed: RecordFeed;
  readonly metadata: MetadataHarness;
  readonly instance: SourceInstance;
  readonly alice: Account;
  readonly bob: Account;
  readonly connections: LuoguConnectionAdapter;
  readonly gate: LuoguSourceGate;
  readonly token: CancellationToken;
  makeService(ownerId: string, limits?: PlatformLimits): LuoguSyncService;
  dispose(): Promise<void>;
}

async function createWorld(
  options: { readonly alice?: AccountPlan; readonly bob?: AccountPlan } = {},
): Promise<World> {
  const paths = fx.tempDatabase();
  const clock = createClock();
  const waits = createWait();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock.now() });
  const instance = officialInstance();
  await store.upsertSourceInstances([instance]);
  const alice = createLuoguAccount(instance, '100001');
  const bob = createLuoguAccount(instance, '100002');
  await store.upsertAccounts([alice, bob]);
  const vault = createMemoryVault();
  const feed = createRecordFeed();
  if (options.alice !== undefined) {
    feed.pages.set(alice.handle, toPages(buildRecords(options.alice.total, options.alice.pids)));
  }
  if (options.bob !== undefined) {
    feed.pages.set(bob.handle, toPages(buildRecords(options.bob.total, options.bob.pids, { startId: 800_000 })));
  }
  const metadata = createMetadataAdapter(instance, () => clock.now());
  const gate = createLuoguSourceGate({
    now: () => clock.nowMs(),
    wait: waits.wait,
    minRequestIntervalMs: LIMITS.minRequestIntervalMs,
  });
  let references = 0;
  const connections = createLuoguConnectionManager({
    store,
    vault,
    sourceInstance: instance,
    now: () => clock.now(),
    newReference: () => `luogu.session.${(references += 1)}`,
    limits: LIMITS,
    gate,
    transport: { fetchImpl: feed.fetchImpl, clock: () => clock.nowMs(), wait: waits.wait, setTimer: neverFireTimer },
  });
  const services: LuoguSyncService[] = [];
  return {
    store,
    paths,
    clock,
    waits,
    vault,
    feed,
    metadata,
    instance,
    alice,
    bob,
    connections,
    gate,
    token: createCancellationSource().token,
    makeService(ownerId: string, limits: PlatformLimits = LIMITS) {
      const submissionsFor = createStoredSubmissionsSource({
        store,
        vault,
        sourceInstance: instance,
        transport: { fetchImpl: feed.fetchImpl, clock: () => clock.nowMs(), wait: waits.wait, setTimer: neverFireTimer },
      });
      const service = new LuoguSyncService({
        store,
        imports: new ImportService({ store, now: () => clock.now() }),
        connections,
        sourceInstance: instance,
        submissionsFor,
        metadataSource: metadata.adapter,
        ownerId,
        now: () => clock.now(),
        wait: waits.wait,
        gate,
        limits,
      });
      services.push(service);
      return service;
    },
    async dispose() {
      for (const service of services) {
        await service.close();
      }
      await store.close();
      fx.removeDirectory(paths.dir);
    },
  };
}

async function countSubmissions(store: SqliteTrainingStore, accountId: string): Promise<number> {
  let cursor: string | null = null;
  let total = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await store.listSubmissions(accountId, { cursor, limit: 500 });
    total += page.items.length;
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }
  return total;
}

async function submissionIds(store: SqliteTrainingStore, accountId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await store.listSubmissions(accountId, { cursor, limit: 500 });
    for (const item of page.items) {
      ids.add(item.id);
    }
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }
  return ids;
}

function checkpointOf(world: World, accountId: string): Promise<unknown> {
  return world.store.getSyncCheckpoint({
    sourceInstanceId: world.instance.id,
    accountId,
    resource: 'submissions',
  });
}

void test('connect, backfill, checkpoint, incremental resume, AC projection and reconnect persistence', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000', 'P1001', 'P1002'] } });
  try {
    const service = world.makeService('svc-a');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.configure(world.alice.id, null, { automaticEnabled: true });

    const started = await service.start(world.alice.id, 'resume');
    assert.equal(started.outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.historyComplete, true);
    assert.equal(status.phase, 'incremental');
    assert.equal(status.totalPages, 2);
    assert.equal(status.submissionsSeen, 60);
    assert.equal(status.resumePending, false);
    assert.equal(status.metadataBacklog, 0);
    assert.equal(status.running, false);
    assert.equal(status.leaseOwner, null);

    const stored = await world.store.listSubmissions(world.alice.id, { cursor: null, limit: 100 });
    assert.equal(stored.items.length, 60);
    assert.ok(stored.items.some((item) => item.verdict === 'accepted'), 'the accepted verdict is projected');
    assert.ok(stored.items.some((item) => item.verdict === 'wrong_answer'));
    for (const pid of ['P1000', 'P1001', 'P1002']) {
      assert.notEqual(
        await world.store.getProblem(problemKeyOf(world.instance, pid)),
        null,
        `${pid} metadata was repaired`,
      );
    }
    assert.equal(world.metadata.editorialCalls(), 0, 'the sync never requests editorial material');

    // Reconnecting persists a fresh reference and drops the previous secret.
    const before = await service.status(world.alice.id);
    const oldReference = before.connection?.reference ?? '';
    await service.connect(world.alice.id, cookieFor('100001', 'rotated'), world.token);
    const after = await service.status(world.alice.id);
    assert.notEqual(after.connection?.reference, oldReference);
    assert.equal(after.connection?.staleReference, null);
    assert.equal(world.vault.secrets.has(oldReference), false);
    assert.equal(world.vault.secrets.has(after.connection?.reference ?? ''), true);
    const reopened = new SqliteTrainingStore({ path: world.paths.path });
    try {
      assert.equal(
        (await reopened.getLuoguConnection(world.alice.id))?.value.reference,
        after.connection?.reference,
      );
    } finally {
      await reopened.close();
    }

    // An incremental pass starts at the last successful scan start minus the overlap.
    const expectedSince = new Date(Date.parse(after.lastScanStartedAt ?? '') - LUOGU_SYNC_OVERLAP_MS).toISOString();
    const again = await service.start(world.alice.id, 'resume');
    assert.equal(again.outcome, 'started');
    await service.settle();
    const incremental = await service.status(world.alice.id);
    assert.equal(incremental.scanSince, expectedSince);
    assert.equal(incremental.historyComplete, true);
    assert.equal(incremental.totalPages, before.totalPages + 2);
    // The overlapping re-scan upserts the same submissions instead of duplicating them.
    assert.equal(await countSubmissions(world.store, world.alice.id), 60);

    // Cancelling a queued duplicate is not needed; an identical start while one runs coalesces.
    world.feed.holdNext = 1;
    await service.start(world.alice.id, 'resume');
    const duplicate = await service.start(world.alice.id, 'resume');
    assert.equal(duplicate.outcome, 'coalesced');
    world.feed.release();
    await service.settle();
  } finally {
    await world.dispose();
  }
});

void test('a 20-page pass keeps its continuation and a >7-day interruption resumes the same whole scan', async () => {
  const world = await createWorld({ alice: { total: 1050, pids: ['P2000', 'P2001'] } });
  try {
    const service = world.makeService('svc-a');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);

    await service.start(world.alice.id, 'resume');
    await service.settle();
    const partial = await service.status(world.alice.id);
    assert.equal(partial.totalPages, 20, 'the pass stopped at its page bound');
    assert.equal(partial.pagesInPass, 0);
    assert.equal(partial.historyComplete, false);
    assert.equal(partial.resumePending, true, 'the continuation is durable');
    assert.equal(partial.phase, 'backfill');
    assert.equal(partial.submissionsSeen, 1000);
    const scanStart = partial.scanStartedAt;
    assert.notEqual(scanStart, null);

    // A week-long interruption must not silently skip the records the scan had not reached.
    world.clock.advance(10 * 24 * 60 * 60 * 1000);
    await service.start(world.alice.id, 'resume');
    await service.settle();
    const done = await service.status(world.alice.id);
    assert.equal(done.historyComplete, true);
    assert.equal(done.totalPages, 21);
    assert.equal(done.submissionsSeen, 1050);
    assert.equal(done.lastScanStartedAt, scanStart, 'the whole-scan start is preserved across the interruption');
    assert.equal(done.resumePending, false);
    assert.equal(done.scanSince, null);
    assert.equal(await countSubmissions(world.store, world.alice.id), 1050);
    assert.equal((await submissionIds(world.store, world.alice.id)).size, 1050, 'no record was duplicated or lost');
  } finally {
    await world.dispose();
  }
});

void test('a manual full reconciliation resets historyComplete without deleting stored rows', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-a');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.start(world.alice.id, 'resume');
    await service.settle();
    const before = await service.status(world.alice.id);
    assert.equal(before.historyComplete, true);

    world.feed.holdNext = 1;
    const full = await service.start(world.alice.id, 'full');
    assert.equal(full.outcome, 'started');
    await until(() => world.feed.heldCount() === 1, 'the reconciliation page is held');
    const during = await service.status(world.alice.id);
    assert.equal(during.phase, 'reconcile');
    assert.equal(during.historyComplete, false, 'a reconciliation honestly reports an incomplete history');
    assert.notEqual(during.scanStartedAt, before.scanStartedAt);
    assert.equal(await countSubmissions(world.store, world.alice.id), 60, 'stored rows are never deleted');

    world.feed.release();
    await service.settle();
    const after = await service.status(world.alice.id);
    assert.equal(after.historyComplete, true);
    assert.equal(after.phase, 'incremental');
    assert.equal(after.scanSince, null, 'a reconciliation scans the full window');
    assert.equal(await countSubmissions(world.store, world.alice.id), 60);
  } finally {
    await world.dispose();
  }
});

void test('a nearly full metadata backlog blocks paging before the fetch and never drops a key', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-a');
    const seededKeys = Array.from({ length: 1951 }, (_, index) => `Q${index + 1}`);
    await world.store.saveLuoguSyncState(
      {
        ...emptyLuoguSyncState(world.alice.id, world.instance.id, fx.AT),
        missingMetadata: buildProblemKeys(world.instance, seededKeys),
        updatedAt: fx.AT,
      },
      null,
    );
    await service.connect(world.alice.id, cookieFor('100001'), world.token);

    const callsBefore = world.feed.calls.length;
    await service.start(world.alice.id, 'resume');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(world.feed.calls.length, callsBefore, 'no history page was requested at all');
    assert.equal(status.totalPages, 0);
    assert.equal(status.pagesInPass, 0);
    assert.equal(status.historyComplete, false);
    assert.equal(status.lastScanStartedAt, null, 'a metadata-only pass does not advance history watermarks');
    assert.equal(status.resumePending, false);
    assert.equal(status.metadataResolved, 10);
    assert.equal(status.metadataFailed, 0);
    assert.equal(status.metadataBacklog, 1951 - 10);
    assert.equal(status.metadataBacklogFull, false);
    assert.equal(status.backlogDropped, 0);

    const record = await world.store.getLuoguSyncState(world.alice.id);
    const backlog = record?.value.missingMetadata ?? [];
    assert.equal(backlog.length, 1941);
    assert.equal(new Set(backlog).size, 1941, 'every remaining key is distinct and still recorded');
    for (const key of buildProblemKeys(
      world.instance,
      seededKeys.slice(0, 10),
    )) {
      assert.equal(backlog.includes(key), false, `the resolved key ${key} left the backlog`);
    }
    assert.ok(LUOGU_SYNC_MAX_METADATA_BACKLOG > backlog.length);
  } finally {
    await world.dispose();
  }
});

void test('metadata repair is bounded, fair, never editorial and retries durably', async () => {
  const world = await createWorld({ alice: { total: 3, pids: ['P1000', 'P1001', 'P1002'] } });
  try {
    const service = world.makeService('svc-a');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.configure(world.alice.id, null, { automaticEnabled: true });
    world.metadata.fail.set(
      'P1001',
      new PlatformError({
        code: 'unavailable',
        operation: 'problem',
        retryable: true,
        detail: 'the problem page is unavailable',
      }),
    );

    await service.start(world.alice.id, 'resume');
    await service.settle();
    const status = await service.status(world.alice.id);
    // The failing first key did not starve the others: all three were attempted in one pass.
    assert.deepEqual([...world.metadata.calls].sort(), ['P1000', 'P1001', 'P1002']);
    assert.equal(world.metadata.editorialCalls(), 0, 'only metadata is fetched, never an editorial');
    assert.equal(status.metadataResolved, 2);
    assert.equal(status.metadataFailed, 1);
    assert.equal(status.metadataBacklog, 1);
    assert.equal(status.failure?.code, 'unavailable');
    assert.equal(status.paused, false);
    assert.equal(
      Date.parse(status.failure?.retryAt ?? '') - Date.parse(status.failure?.at ?? ''),
      2_000,
      'the bounded backoff starts at the contract minimum',
    );
    // The already fetched records were imported and are not blocked by the metadata failure.
    assert.notEqual(await checkpointOf(world, world.alice.id), null);
    assert.equal(await countSubmissions(world.store, world.alice.id), 3);

    const early = await service.tick(world.token);
    assert.deepEqual(early.started, []);
    assert.ok(early.skipped.some((entry) => entry.accountId === world.alice.id && entry.reason === 'not_due'));

    world.metadata.fail.clear();
    world.clock.advance(2_500);
    const retry = await service.tick(world.token);
    assert.deepEqual(retry.started, [world.alice.id]);
    await service.settle();
    const after = await service.status(world.alice.id);
    assert.equal(after.metadataBacklog, 0);
    assert.equal(after.metadataResolved, 3);
    assert.equal(after.failure, null);
    assert.equal(await countSubmissions(world.store, world.alice.id), 3);
  } finally {
    await world.dispose();
  }
});

void test('automation is per account, off by default, opt-in at startup and never loops on restart', async () => {
  const world = await createWorld({
    alice: { total: 3, pids: ['P1000'] },
    bob: { total: 1, pids: ['P2000'] },
  });
  try {
    const service = world.makeService('svc-a');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.connect(world.bob.id, cookieFor('100002'), world.token);

    // Automation is off by default: no settings row means no eligible account.
    const idle = await service.tick(world.token);
    assert.deepEqual(idle.started, []);
    assert.ok(idle.skipped.every((entry) => entry.reason === 'automation_disabled'));

    await service.configure(world.alice.id, null, { automaticEnabled: true });
    await service.configure(world.bob.id, null, { automaticEnabled: true, runOnStartup: false });
    assert.equal((await service.status(world.bob.id)).settings.automaticEnabled, true);
    assert.equal((await service.status(world.alice.id)).settings.automaticEnabled, true);

    const startup = await service.startup(world.token);
    assert.deepEqual(startup.started, [world.alice.id]);
    assert.ok(
      startup.skipped.some((entry) => entry.accountId === world.bob.id && entry.reason === 'startup_disabled'),
      'startup synchronization is opt-in per account',
    );
    await service.settle();

    // Bob is due at the next sweep; Alice just succeeded, so her interval has not elapsed.
    const tick = await service.tick(world.token);
    assert.deepEqual(tick.started, [world.bob.id]);
    assert.ok(tick.skipped.some((entry) => entry.accountId === world.alice.id && entry.reason === 'not_due'));
    await service.settle();

    // Restarting the host within the interval does not loop: the due instants are durable.
    const again = await service.tick(world.token);
    assert.deepEqual(again.started, []);
    assert.equal(again.skipped.filter((entry) => entry.reason === 'not_due').length, 2);
  } finally {
    await world.dispose();
  }
});

void test('a live foreign lease is refused, an expired one is recovered and a stolen lease rolls the page back', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const ownerA = world.makeService('svc-a');
    const ownerB = world.makeService('svc-b');
    await ownerA.connect(world.alice.id, cookieFor('100001'), world.token);
    world.feed.holdNext = 1;
    const started = await ownerA.start(world.alice.id, 'resume');
    assert.equal(started.outcome, 'started');
    await until(() => world.feed.heldCount() === 1, 'the first pass is parked inside its page');

    await assert.rejects(
      ownerB.start(world.alice.id, 'resume'),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'busy',
      'a live foreign lease is refused',
    );

    // Once the lease expired, the second instance recovers it and resumes the same account.
    world.clock.advance(10 * 60_000);
    const recovered = await ownerB.start(world.alice.id, 'resume');
    assert.equal(recovered.outcome, 'started');
    world.feed.release();
    await ownerA.settle();
    await ownerB.settle();

    const status = await ownerB.status(world.alice.id);
    assert.equal(status.running, false);
    assert.equal(status.leaseOwner, null);
    // Only the recovering owner committed: the first pass lost its lease inside the page
    // transaction and its page rolled back instead of overwriting the new owner.
    assert.equal(status.totalPages, 2);
    assert.equal(await countSubmissions(world.store, world.alice.id), 60);
  } finally {
    await world.dispose();
  }
});

void test('disconnect drains the pass, disables only that account and removes only its credential', async () => {
  const world = await createWorld({
    alice: { total: 60, pids: ['P1000'] },
    bob: { total: 1, pids: ['P2000'] },
  });
  try {
    const service = world.makeService('svc-a');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.connect(world.bob.id, cookieFor('100002'), world.token);
    await service.configure(world.alice.id, null, { automaticEnabled: true });
    await service.configure(world.bob.id, null, { automaticEnabled: true });
    const aliceReference = (await service.status(world.alice.id)).connection?.reference ?? '';
    const bobReference = (await service.status(world.bob.id)).connection?.reference ?? '';

    world.feed.holdNext = 1;
    await service.start(world.alice.id, 'resume');
    await until(() => world.feed.heldCount() === 1, 'the pass is parked inside its first page');
    const disconnecting = service.disconnect(world.alice.id, world.token);
    await sleep(5);
    world.feed.release();
    const status = await disconnecting;

    assert.equal(status.connection, null);
    assert.equal(status.settings.automaticEnabled, false);
    assert.equal(world.vault.secrets.has(aliceReference), false, "the account's credential was removed");
    assert.equal(world.vault.secrets.has(bobReference), true, "another account's credential is untouched");
    assert.equal((await service.status(world.bob.id)).connection?.status, 'connected');
    assert.equal((await service.status(world.bob.id)).settings.automaticEnabled, true);

    const after = await service.status(world.alice.id);
    assert.equal(after.running, false);
    assert.equal(after.failure, null, 'a cancellation is not a failure');
    assert.equal(after.totalPages, 0);
    assert.equal(after.resumePending, false);
    assert.equal(await countSubmissions(world.store, world.alice.id), 0, 'the cancelled page was never committed');
  } finally {
    await world.dispose();
  }
});

void test('429 Retry-After produces a durable backoff and authentication failures pause until the user acts', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-a');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.configure(world.alice.id, null, { automaticEnabled: true });

    world.feed.override = () => {
      throw new PlatformError({
        code: 'rate_limited',
        operation: 'submissions',
        retryable: true,
        retryAfterMs: 120_000,
        detail: 'slow down',
      });
    };
    await service.start(world.alice.id, 'resume');
    await service.settle();
    const throttled = await service.status(world.alice.id);
    assert.equal(throttled.failure?.code, 'rate_limited');
    assert.equal(throttled.paused, false, 'a rate limit resumes by itself');
    assert.equal(
      Date.parse(throttled.failure?.retryAt ?? '') - Date.parse(throttled.failure?.at ?? ''),
      120_000,
      'Retry-After is honored exactly',
    );
    assert.equal(throttled.nextRunAt, throttled.failure?.retryAt);
    const early = await service.tick(world.token);
    assert.deepEqual(early.started, []);
    assert.ok(early.skipped.some((entry) => entry.reason === 'not_due'), 'the retry instant is durable');

    world.clock.advance(121_000);
    world.feed.override = () => {
      throw new PlatformError({
        code: 'auth_required',
        operation: 'submissions',
        retryable: false,
        detail: 'the session is gone',
      });
    };
    const second = await service.tick(world.token);
    assert.deepEqual(second.started, [world.alice.id]);
    await service.settle();
    const paused = await service.status(world.alice.id);
    assert.equal(paused.failure?.code, 'auth_required');
    assert.equal(paused.paused, true);
    assert.equal(paused.nextRunAt, null);
    assert.equal(paused.historyComplete, false, 'a failure never claims a complete history');
    const blocked = await service.tick(world.token);
    assert.deepEqual(blocked.started, []);
    assert.ok(blocked.skipped.some((entry) => entry.reason === 'paused'));

    // Only an explicit user action resumes a pausing failure.
    world.feed.override = null;
    const resumed = await service.start(world.alice.id, 'resume');
    assert.equal(resumed.outcome, 'started');
    await service.settle();
    const healthy = await service.status(world.alice.id);
    assert.equal(healthy.failure, null);
    assert.equal(healthy.historyComplete, true);
    assert.equal(await countSubmissions(world.store, world.alice.id), 60);

    // No session material ever appears in a status.
    const serialized = JSON.stringify(healthy);
    assert.equal(serialized.includes(cookieFor('100001')), false);
    assert.equal(serialized.includes('__client_id'), false);
  } finally {
    await world.dispose();
  }
});

void test('close cancels and drains in-flight work and refuses later operations', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-a');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    world.feed.holdNext = 1;
    await service.start(world.alice.id, 'resume');
    await until(() => world.feed.heldCount() === 1, 'the pass is parked inside its first page');
    const callsBefore = world.feed.calls.length;

    const closing = service.close();
    await sleep(5);
    world.feed.release();
    await closing;

    assert.equal(world.feed.calls.length, callsBefore, 'no platform request is detached after close');
    assert.equal(await countSubmissions(world.store, world.alice.id), 0);
    assert.equal((await service.status(world.alice.id)).running, false);
    await assert.rejects(
      service.start(world.alice.id, 'resume'),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'closing',
    );
    await assert.rejects(
      service.connect(world.alice.id, cookieFor('100001'), world.token),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'closing',
    );
    await service.close();
    assert.equal((await service.status(world.alice.id)).closing, true);
  } finally {
    await world.dispose();
  }
});

void test('a configured page size below the 50-row cap is honored instead of failing the pass', async () => {
  const single = await createWorld({ alice: { total: 3, pids: ['P1000'] } });
  try {
    const service = single.makeService('svc-page-1', { ...LIMITS, pageSize: 1 });
    await service.connect(single.alice.id, cookieFor('100001'), single.token);
    assert.equal((await service.start(single.alice.id, 'resume')).outcome, 'started');
    await service.settle();
    const status = await service.status(single.alice.id);
    assert.equal(status.failure, null, 'a page size of 1 is valid and does not fail the pass');
    assert.equal(status.historyComplete, true);
    assert.equal(status.submissionsSeen, 3);
    assert.equal(status.totalPages, 3, 'each history page carried exactly the configured single row');
    assert.equal(await countSubmissions(single.store, single.alice.id), 3);
  } finally {
    await single.dispose();
  }

  const twenty = await createWorld({ alice: { total: 60, pids: ['P1000', 'P1001'] } });
  try {
    const service = twenty.makeService('svc-page-20', { ...LIMITS, pageSize: 20 });
    await service.connect(twenty.alice.id, cookieFor('100001'), twenty.token);
    await service.start(twenty.alice.id, 'resume');
    await service.settle();
    const status = await service.status(twenty.alice.id);
    assert.equal(status.failure, null);
    assert.equal(status.historyComplete, true);
    assert.equal(status.submissionsSeen, 60);
    assert.equal(status.totalPages, 3, '60 rows at 20 per page is three pages');
    assert.equal(await countSubmissions(twenty.store, twenty.alice.id), 60);
  } finally {
    await twenty.dispose();
  }
});

void test('an invalid_input failure pauses automatic retries until an explicit action', async () => {
  const world = await createWorld({ alice: { total: 3, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-invalid');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.configure(world.alice.id, null, { automaticEnabled: true });

    world.feed.override = () => {
      throw new PlatformError({
        code: 'invalid_input',
        operation: 'submissions',
        retryable: false,
        detail: 'the request was rejected',
      });
    };
    await service.start(world.alice.id, 'resume');
    await service.settle();
    const paused = await service.status(world.alice.id);
    assert.equal(paused.failure?.code, 'invalid_input');
    assert.equal(paused.paused, true, 'a deterministic refusal waits for the user instead of looping');
    assert.equal(paused.failure?.retryAt, null);
    assert.equal(paused.nextRunAt, null);

    const blocked = await service.tick(world.token);
    assert.deepEqual(blocked.started, []);
    assert.ok(
      blocked.skipped.some((entry) => entry.accountId === world.alice.id && entry.reason === 'paused'),
      'no automatic sweep retries a paused invalid request',
    );

    // Only an explicit action resumes it.
    world.feed.override = null;
    assert.equal((await service.start(world.alice.id, 'resume')).outcome, 'started');
    await service.settle();
    const healthy = await service.status(world.alice.id);
    assert.equal(healthy.failure, null);
    assert.equal(healthy.historyComplete, true);
  } finally {
    await world.dispose();
  }

  // A deterministic refusal raised as a domain error (a malformed page limit) pauses the same way.
  const broken = await createWorld({ alice: { total: 3, pids: ['P1000'] } });
  try {
    const service = broken.makeService('svc-invalid-limit', { ...LIMITS, pageSize: 0 });
    await service.connect(broken.alice.id, cookieFor('100001'), broken.token);
    await service.configure(broken.alice.id, null, { automaticEnabled: true });
    await service.start(broken.alice.id, 'resume');
    await service.settle();
    const status = await service.status(broken.alice.id);
    assert.equal(status.failure?.code, 'invalid_input');
    assert.equal(status.paused, true);
    const blocked = await service.tick(broken.token);
    assert.deepEqual(blocked.started, []);
    assert.ok(blocked.skipped.some((entry) => entry.reason === 'paused'));
  } finally {
    await broken.dispose();
  }
});

void test('two simultaneous starts of one account reserve exactly one pass and one platform scan', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-simultaneous');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);

    // Park the first reservation inside its durable account scan. Both starts are issued while it is
    // parked, so the second one cannot see the first's committed lease — the exact window the review
    // named. It must observe the in-memory reservation instead of taking the source a second time.
    const gate = deferred();
    const original = world.store.listAccounts.bind(world.store);
    let scans = 0;
    world.store.listAccounts = (async (...args: Parameters<SqliteTrainingStore['listAccounts']>) => {
      scans += 1;
      if (scans === 1) {
        await gate.promise;
      }
      return original(...args);
    }) as SqliteTrainingStore['listAccounts'];

    const first = service.start(world.alice.id, 'resume').then(
      (result) => result.outcome as unknown,
      (error: unknown) => error,
    );
    const second = service.start(world.alice.id, 'resume').then(
      (result) => result.outcome as unknown,
      (error: unknown) => error,
    );
    await until(() => scans === 1, 'the first start to reach its deferred reservation scan');
    gate.release();
    const [a, b] = await Promise.all([first, second]);

    const outcomes = [a, b].filter((entry): entry is string => typeof entry === 'string');
    assert.deepEqual(
      outcomes.filter((outcome) => outcome === 'started'),
      ['started'],
      'exactly one call may reserve the account, however the two calls interleave',
    );
    const other = [a, b].find((entry) => entry !== 'started');
    assert.ok(
      (other instanceof LuoguSyncError && other.code === 'busy') || other === 'coalesced',
      'the other call is refused as busy or coalesces with the launched pass — never started again',
    );

    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.totalPages, 2, 'one pass committed the two pages of this account exactly once');
    assert.equal(status.submissionsSeen, 60);
    assert.equal(status.pagesInPass, 0);
    assert.equal(status.running, false);
    assert.equal(status.leaseOwner, null, 'the single pass released its own lease');
    assert.equal(status.resumePending, false);
    assert.equal(await countSubmissions(world.store, world.alice.id), 60);
  } finally {
    await world.dispose();
  }
});

void test('a sweep and a manual start never run two passes for the same due account', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-sweep-start');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.configure(world.alice.id, null, { automaticEnabled: true });

    const gate = deferred();
    const original = world.store.listAccounts.bind(world.store);
    let scans = 0;
    world.store.listAccounts = (async (...args: Parameters<SqliteTrainingStore['listAccounts']>) => {
      scans += 1;
      if (scans === 1) {
        await gate.promise;
      }
      return original(...args);
    }) as SqliteTrainingStore['listAccounts'];

    const manual = service.start(world.alice.id, 'resume').then(
      (result) => result.outcome as unknown,
      (error: unknown) => error,
    );
    await until(() => scans === 1, 'the manual start to reach its deferred reservation scan');
    const sweeping = service.tick(world.token);
    gate.release();
    const [manualOutcome, sweep] = await Promise.all([manual, sweeping]);

    const swept = sweep.started.filter((accountId) => accountId === world.alice.id).length;
    assert.equal(
      (manualOutcome === 'started' ? 1 : 0) + swept,
      1,
      'exactly one of the sweep and the manual start reserves the account',
    );
    if (manualOutcome !== 'started') {
      assert.ok(
        (manualOutcome instanceof LuoguSyncError && manualOutcome.code === 'busy') || manualOutcome === 'coalesced',
        'the manual start is refused as busy or coalesces instead of starting a second pass',
      );
    }

    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.totalPages, 2, 'the account was scanned once, not once per caller');
    assert.equal(status.submissionsSeen, 60);
    assert.equal(status.running, false);
    assert.equal(status.leaseOwner, null);
    assert.equal(await countSubmissions(world.store, world.alice.id), 60);
  } finally {
    await world.dispose();
  }
});

void test('a close during the queued reconciliation reservation launches nothing and leaves no lease', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-close-queued');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);

    world.feed.holdNext = 1;
    await service.start(world.alice.id, 'resume');
    await until(() => world.feed.heldCount() === 1, 'the first pass to park inside its page');
    const queued = await service.start(world.alice.id, 'full');
    assert.equal(queued.outcome, 'queued', 'the reconciliation waits behind the running pass');

    // Defer the queued pass's own reservation scan, so the close lands while that reservation is
    // still being written — the window that used to leave an orphaned lease or detached work.
    const gate = deferred();
    const original = world.store.listAccounts.bind(world.store);
    let scans = 0;
    world.store.listAccounts = (async (...args: Parameters<SqliteTrainingStore['listAccounts']>) => {
      scans += 1;
      await gate.promise;
      return original(...args);
    }) as SqliteTrainingStore['listAccounts'];

    world.feed.release();
    await until(() => scans === 1, 'the queued reconciliation to reach its deferred reservation scan');
    const callsAtClose = world.feed.calls.length;
    const closing = service.close();
    gate.release();
    await closing;

    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(record?.value.owner, null, 'the refused reservation left no lease behind');
    assert.equal(record?.value.leaseExpiresAt, null);
    assert.equal((await service.status(world.alice.id)).running, false);
    assert.equal(world.feed.calls.length, callsAtClose, 'no platform work was detached after the close');
    assert.equal(await countSubmissions(world.store, world.alice.id), 60, 'the finished pass stays committed');
  } finally {
    await world.dispose();
  }
});

void test('a start is refused while a connection operation holds the same-owner source lease', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-connect-start');
    const adapter = world.connections;
    const originalConnect = adapter.connect.bind(adapter);
    const gate = deferred();
    let entered = false;
    adapter.connect = async (input: Parameters<typeof originalConnect>[0]) => {
      entered = true;
      await gate.promise;
      return originalConnect(input);
    };

    const connecting = service.connect(world.alice.id, cookieFor('100001'), world.token);
    await until(() => entered, 'the connection lease to be published and committed');
    const refused = await service.start(world.alice.id, 'resume').then(
      (result) => result.outcome as unknown,
      (error: unknown) => error,
    );
    assert.ok(
      refused instanceof LuoguSyncError && refused.code === 'busy',
      'a start cannot claim the source while the same owner holds a connection lease',
    );
    gate.release();
    await connecting;
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(record?.value.owner, null, 'the connection released only its own lease');

    // The refused start changed nothing: the account still syncs normally afterwards.
    assert.equal((await service.start(world.alice.id, 'resume')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.totalPages, 2);
    assert.equal(await countSubmissions(world.store, world.alice.id), 60);
  } finally {
    await world.dispose();
  }
});

/** A manually released gate used to park one store call inside a close race window. */
function deferred(): { readonly promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

void test('a close that lands inside a start reservation leaves no lease and launches nothing', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-start-race');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    const callsBefore = world.feed.calls.length;

    const gate = deferred();
    const original = world.store.listAccounts.bind(world.store);
    let reads = 0;
    world.store.listAccounts = (async (...args: Parameters<SqliteTrainingStore['listAccounts']>) => {
      reads += 1;
      await gate.promise;
      return original(...args);
    }) as SqliteTrainingStore['listAccounts'];

    const starting = service.start(world.alice.id, 'resume').then(
      () => null,
      (error: unknown) => error,
    );
    await until(() => reads === 1, 'the start to reach the deferred reservation read');
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await sleep(5);
    assert.equal(closed, false, 'close waits for the in-flight start attempt');

    gate.release();
    const failure = await starting;
    assert.ok(failure instanceof LuoguSyncError, 'the raced start is refused instead of launching');
    assert.equal(failure.code, 'closing');
    await closing;

    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(record?.value.owner, null, 'the refused reservation left no lease behind');
    assert.equal(record?.value.leaseExpiresAt, null);
    assert.equal((await service.status(world.alice.id)).running, false);
    assert.equal(await countSubmissions(world.store, world.alice.id), 0);
    assert.equal(world.feed.calls.length, callsBefore, 'no platform request was made');
  } finally {
    await world.dispose();
  }
});

void test('a close that lands after the reservation committed releases that reservation', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-commit-race');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);

    // Closing from inside the durable write deterministically lands the close *after* the
    // reservation committed but before the caller could launch the pass.
    const original = world.store.saveLuoguSyncState.bind(world.store);
    let closing: Promise<void> | null = null;
    world.store.saveLuoguSyncState = (async (...args: Parameters<SqliteTrainingStore['saveLuoguSyncState']>) => {
      const saved = await original(...args);
      if (closing === null) {
        closing = service.close();
      }
      return saved;
    }) as SqliteTrainingStore['saveLuoguSyncState'];

    const outcome = await service.start(world.alice.id, 'resume').then(
      () => 'started' as const,
      (error: unknown) => error,
    );
    assert.ok(outcome instanceof LuoguSyncError, 'the raced start is refused instead of launching');
    assert.equal(outcome.code, 'closing');
    if (closing === null) {
      assert.fail('the durable-write hook must have started the close');
    }
    await closing;

    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(record?.value.owner, null, 'the committed reservation was released');
    assert.equal(record?.value.leaseExpiresAt, null);
    assert.equal((await service.status(world.alice.id)).running, false);
    assert.equal(await countSubmissions(world.store, world.alice.id), 0, 'no pass was launched after the close');
  } finally {
    await world.dispose();
  }
});

void test('a close that lands inside a sweep stops it before any reservation', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-sweep-race');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.configure(world.alice.id, null, { automaticEnabled: true });

    const gate = deferred();
    const original = world.store.listAccounts.bind(world.store);
    let reads = 0;
    world.store.listAccounts = (async (...args: Parameters<SqliteTrainingStore['listAccounts']>) => {
      reads += 1;
      await gate.promise;
      return original(...args);
    }) as SqliteTrainingStore['listAccounts'];

    const sweeping = service.tick(world.token);
    await until(() => reads === 1, 'the sweep to reach the deferred store read');
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await sleep(5);
    assert.equal(closed, false, 'close waits for the interrupted sweep');

    gate.release();
    const result = await sweeping;
    assert.deepEqual(result.started, [], 'an interrupted sweep starts nothing');
    await closing;

    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(record?.value.owner, null, 'the interrupted sweep left no reservation');
    assert.equal((await service.status(world.alice.id)).running, false);
    await assert.rejects(
      service.start(world.alice.id, 'resume'),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'closing',
    );
  } finally {
    await world.dispose();
  }
});

void test('a failed lease release still retires the refused pass and keeps the lease for its expiry', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-release-failure');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    const callsBefore = world.feed.calls.length;

    // The lease release write fails for every de-lease save, while the reservation itself commits:
    // the hook closes the service from inside that very write, so the close lands *after* the claim —
    // the window where `reservePass` owns a durable lease but has no launched work.
    const releaseFailure = new Error('the durable lease release write failed');
    const original = world.store.saveLuoguSyncState.bind(world.store);
    let closing: Promise<void> | null = null;
    let releaseAttempts = 0;
    world.store.saveLuoguSyncState = (async (...args: Parameters<SqliteTrainingStore['saveLuoguSyncState']>) => {
      const [state] = args;
      if (state.owner === null) {
        releaseAttempts += 1;
        throw releaseFailure;
      }
      const saved = await original(...args);
      if (closing === null) {
        closing = service.close();
      }
      return saved;
    }) as SqliteTrainingStore['saveLuoguSyncState'];

    const outcome = await service.start(world.alice.id, 'resume').then(
      () => 'started' as const,
      (error: unknown) => error,
    );
    assert.ok(outcome instanceof LuoguSyncError, 'the raced start is refused instead of launching');
    assert.equal(outcome.code, 'closing');
    if (closing === null) {
      assert.fail('the durable-write hook must have started the close');
    }
    // The close must settle — here by rejecting with the original storage failure — instead of
    // waiting forever on a published pass that nothing would ever finish.
    await assert.rejects(
      closing,
      (error: unknown) => error === releaseFailure,
      'close reports the original release failure instead of hanging',
    );
    assert.equal(releaseAttempts, 1, 'the failed release is attempted exactly once');

    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(record?.value.owner, 'svc-release-failure', 'the durable lease is retained for its own expiry');
    assert.notEqual(record?.value.leaseExpiresAt, null, 'the un-released lease still has its durable deadline');
    const status = await service.status(world.alice.id);
    assert.equal(status.running, false, 'the published pass was retired despite the failed release');
    assert.equal(status.leaseOwner, 'svc-release-failure');
    assert.equal(world.feed.calls.length, callsBefore, 'no platform request was made');
    assert.equal(await countSubmissions(world.store, world.alice.id), 0);
  } finally {
    await world.dispose();
  }
});

void test('a metadata auth refusal is recorded as metadata, keeps history coverage and the backlog, and survives a successful probe', async () => {
  const world = await createWorld({ alice: { total: 3, pids: ['P1000', 'P1001'] } });
  try {
    const service = world.makeService('svc-stage-metadata');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await service.configure(world.alice.id, null, { automaticEnabled: true });
    // The anonymous problem-metadata read answers `auth_required`, the same code an authenticated
    // history read uses. The stage is what keeps the two apart.
    world.metadata.fail.set(
      'P1001',
      new PlatformError({
        code: 'auth_required',
        operation: 'problem',
        retryable: false,
        detail: 'the anonymous metadata read was asked to log in',
      }),
    );

    await service.start(world.alice.id, 'resume');
    await service.settle();
    const afterMetadata = await service.status(world.alice.id);
    assert.equal(afterMetadata.historyComplete, true, 'the metadata refusal never clears history coverage');
    assert.equal(afterMetadata.phase, 'incremental');
    assert.equal(afterMetadata.totalPages, 1);
    assert.equal(afterMetadata.submissionsSeen, 3);
    assert.equal(afterMetadata.metadataBacklog, 1, 'the failing key stays queued');
    assert.equal(afterMetadata.metadataFailed, 1);
    assert.equal(afterMetadata.paused, true);
    assert.equal(afterMetadata.failure?.code, 'auth_required');
    assert.equal(afterMetadata.failure?.stage, 'metadata');
    assert.equal(await countSubmissions(world.store, world.alice.id), 3, 'metadata failures discard no submissions');

    // A probe only proves the session works right now; it must not clear the sync failure or unpause.
    await service.probe(world.alice.id, world.token);
    const probed = await service.status(world.alice.id);
    assert.equal(probed.connection?.status, 'connected', 'the probe really succeeded');
    assert.equal(probed.failure?.code, 'auth_required');
    assert.equal(probed.failure?.stage, 'metadata', 'the recorded stage is untouched by the probe');
    assert.equal(probed.failure?.at, afterMetadata.failure?.at, 'the same durable failure is still reported');
    assert.equal(probed.paused, true);
    const blocked = await service.tick(world.token);
    assert.deepEqual(blocked.started, []);
    assert.ok(blocked.skipped.some((entry) => entry.accountId === world.alice.id && entry.reason === 'paused'));

    // A genuine history refusal is recorded as a history failure and erases neither coverage nor keys.
    world.metadata.fail.clear();
    world.feed.override = () => {
      throw new PlatformError({
        code: 'auth_required',
        operation: 'submissions',
        retryable: false,
        detail: 'the session is gone',
      });
    };
    assert.equal((await service.start(world.alice.id, 'resume')).outcome, 'started');
    await service.settle();
    const afterHistory = await service.status(world.alice.id);
    assert.equal(afterHistory.failure?.code, 'auth_required');
    assert.equal(afterHistory.failure?.stage, 'history');
    assert.equal(afterHistory.paused, true);
    assert.equal(afterHistory.historyComplete, true, 'a failed incremental scan never clears coverage');
    assert.equal(afterHistory.metadataBacklog, 1, 'the metadata backlog is preserved');
    assert.equal(await countSubmissions(world.store, world.alice.id), 3);
  } finally {
    await world.dispose();
  }
});

void test('an exception thrown while repairing metadata is recorded as a metadata failure', async () => {
  const world = await createWorld({ alice: { total: 3, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-stage-metadata-throw');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    // `invalid_input` from the metadata adapter is re-thrown by the import service instead of being
    // returned as a report, so the pass observes a real exception raised while doing metadata work.
    world.metadata.fail.set(
      'P1000',
      new PlatformError({
        code: 'invalid_input',
        operation: 'problem',
        retryable: false,
        detail: 'the metadata request was rejected',
      }),
    );

    await service.start(world.alice.id, 'resume');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.historyComplete, true, 'the history half already completed and stays complete');
    assert.equal(status.failure?.code, 'invalid_input');
    assert.equal(status.failure?.stage, 'metadata');
    assert.equal(status.paused, true);
    assert.equal(status.metadataBacklog, 1);
    assert.equal(await countSubmissions(world.store, world.alice.id), 3);
  } finally {
    await world.dispose();
  }
});
