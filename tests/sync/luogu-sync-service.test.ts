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
  LUOGU_SYNC_METADATA_PER_PASS,
  LUOGU_SYNC_OVERLAP_MS,
  emptyLuoguSyncState,
  type LuoguSyncFailure,
  type LuoguSyncState,
} from '../../src/application/luogu-sync-types.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformLimits } from '../../src/application/ports.js';
import {
  DomainError,
  accountIdOf,
  createCancellationSource,
  createSourceInstance,
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

/** Seed one account's durable state with a distinct missing-metadata backlog and no history work. */
async function seedBacklog(
  world: World,
  accountId: string,
  externalKeys: readonly string[],
  overrides: Partial<LuoguSyncState> = {},
): Promise<void> {
  await world.store.saveLuoguSyncState(
    {
      ...emptyLuoguSyncState(accountId, world.instance.id, fx.AT),
      missingMetadata: buildProblemKeys(world.instance, externalKeys),
      ...overrides,
      updatedAt: fx.AT,
    },
    null,
  );
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
    assert.equal(status.metadataResolved, LUOGU_SYNC_METADATA_PER_PASS);
    assert.equal(status.metadataFailed, 0);
    assert.equal(status.metadataBacklog, 1951 - LUOGU_SYNC_METADATA_PER_PASS);
    assert.equal(status.metadataBacklogFull, false);
    assert.equal(status.backlogDropped, 0);

    const record = await world.store.getLuoguSyncState(world.alice.id);
    const backlog = record?.value.missingMetadata ?? [];
    assert.equal(backlog.length, 1951 - LUOGU_SYNC_METADATA_PER_PASS);
    assert.equal(
      new Set(backlog).size,
      1951 - LUOGU_SYNC_METADATA_PER_PASS,
      'every remaining key is distinct and still recorded',
    );
    for (const key of buildProblemKeys(
      world.instance,
      seededKeys.slice(0, LUOGU_SYNC_METADATA_PER_PASS),
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

// ---------------------------------------------------------------------------------------
// Sprint 22a: the raised ordinary metadata batch and the explicit backlog-drain action
// ---------------------------------------------------------------------------------------

void test('an ordinary pass repairs exactly the raised 100-item metadata batch and leaves the rest queued', async () => {
  const world = await createWorld({ alice: { total: 3, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-batch-100');
    const keys = ['P1000', ...Array.from({ length: 104 }, (_, index) => `R${index + 1}`)];
    await seedBacklog(world, world.alice.id, keys, {
      phase: 'incremental',
      historyComplete: true,
      historyCompletedAt: fx.AT,
      lastScanStartedAt: fx.AT,
      lastSuccessAt: fx.AT,
    });
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    assert.equal(LUOGU_SYNC_METADATA_PER_PASS, 100, 'Sprint 22a raised the ordinary per-pass batch');

    assert.equal((await service.start(world.alice.id, 'resume')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.metadataResolved, 100, 'an ordinary pass repairs exactly one raised batch');
    assert.equal(status.metadataFailed, 0);
    assert.equal(status.metadataBacklog, keys.length - 100);
    assert.equal(world.metadata.calls.length, 100, 'the ordinary batch is never exceeded');
    assert.equal(status.historyComplete, true, 'the history half still completed normally');
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(record?.value.missingMetadata.length, keys.length - 100, 'the rest stays queued, never dropped');
    assert.equal(record?.value.backlogDropped, 0);
  } finally {
    await world.dispose();
  }
});

void test('the metadata-only action drains a backlog larger than one ordinary pass without reading history', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-metadata-drain');
    const keys = Array.from({ length: 105 }, (_, index) => `M${index + 1}`);
    await seedBacklog(world, world.alice.id, keys);
    const feedCallsBefore = world.feed.calls.length;

    const started = await service.start(world.alice.id, 'metadata');
    assert.equal(started.mode, 'metadata');
    assert.equal(started.outcome, 'started');
    await service.settle();

    const status = await service.status(world.alice.id);
    assert.deepEqual([...world.metadata.calls].sort(), [...keys].sort(), 'every key was attempted');
    assert.equal(new Set(world.metadata.calls).size, 105, 'one attempt per key, never an infinite retry');
    assert.equal(world.feed.calls.length, feedCallsBefore, 'the metadata-only action never reads a history page');
    assert.equal(status.metadataResolved, 105);
    assert.equal(status.metadataFailed, 0);
    assert.equal(status.metadataBacklog, 0);
    assert.equal(status.phase, 'backfill', 'no history phase was invented');
    assert.equal(status.historyComplete, false, 'a metadata-only action never claims history coverage');
    assert.equal(status.scanStartedAt, null);
    assert.equal(status.lastScanStartedAt, null, 'the last successful history scan is untouched');
    assert.equal(status.lastSuccessAt, null);
    assert.equal(status.resumePending, false, 'no checkpoint continuation was created');
    assert.equal(await checkpointOf(world, world.alice.id), null);
    assert.equal(status.totalPages, 0);
    assert.equal(status.running, false);
    assert.equal(status.leaseOwner, null, 'the metadata-only pass released its lease');
  } finally {
    await world.dispose();
  }
});

void test('metadata progress is committed per item, is visible mid-run and survives a pause', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-metadata-progress');
    const keys = Array.from({ length: 30 }, (_, index) => `D${index + 1}`);
    await seedBacklog(world, world.alice.id, keys);
    const originalFetch = world.metadata.adapter.fetchProblem.bind(world.metadata.adapter);
    const gate = deferred();
    let served = 0;
    world.metadata.adapter.fetchProblem = async (request) => {
      served += 1;
      if (served === 3) {
        await gate.promise;
      }
      return originalFetch(request);
    };

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await until(() => served >= 3, 'the third request is held after two items were committed');
    const during = await service.status(world.alice.id);
    assert.equal(during.running, true, 'the pass is still running while progress is already visible');
    assert.equal(during.metadataResolved, 2, 'finished items are durable before the pass ends');
    assert.equal(during.metadataBacklog, 28);

    const cancelled = service.cancel(world.alice.id);
    await sleep(20);
    gate.release();
    await cancelled;

    const after = await service.status(world.alice.id);
    assert.equal(after.running, false);
    assert.equal(after.metadataResolved, 2, 'pausing keeps every item committed before the pause');
    assert.equal(
      after.metadataBacklog,
      28,
      'the remaining queue is kept, including the key whose in-flight answer the cancellation discarded',
    );
    assert.equal(after.metadataFailed, 0);
    assert.equal(after.leaseOwner, null, 'the paused pass released its lease');
    assert.equal(world.metadata.calls.length, 3, 'no further request is issued after the pause');
    assert.equal(await checkpointOf(world, world.alice.id), null, 'a metadata pause writes no checkpoint');
  } finally {
    await world.dispose();
  }
});

void test('a metadata drain renews its lease and keeps working past the former lease duration', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-metadata-lease');
    const keys = Array.from({ length: 5 }, (_, index) => `L${index + 1}`);
    await seedBacklog(world, world.alice.id, keys);
    const startedAt = world.clock.nowMs();
    const originalFetch = world.metadata.adapter.fetchProblem.bind(world.metadata.adapter);
    world.metadata.adapter.fetchProblem = async (request) => {
      // Each synthetic request takes 30 seconds, so the run outlives the initial 120-second lease.
      world.clock.advance(30_000);
      return originalFetch(request);
    };

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(world.metadata.calls.length, 5);
    assert.equal(status.metadataResolved, 5, 'renewal keeps the whole drain alive');
    assert.equal(status.metadataBacklog, 0);
    assert.equal(status.failure, null, 'no lease_lost failure is recorded while the lease is renewed');
    assert.ok(world.clock.nowMs() - startedAt >= 150_000, 'the run really outlived the original lease');
  } finally {
    await world.dispose();
  }
});

void test('a takeover during a metadata drain stops it without clobbering the new owner', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-metadata-takeover');
    const keys = Array.from({ length: 12 }, (_, index) => `T${index + 1}`);
    await seedBacklog(world, world.alice.id, keys);
    const originalFetch = world.metadata.adapter.fetchProblem.bind(world.metadata.adapter);
    const gate = deferred();
    let served = 0;
    world.metadata.adapter.fetchProblem = async (request) => {
      served += 1;
      if (served === 3) {
        await gate.promise;
      }
      return originalFetch(request);
    };

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await until(() => served >= 3, 'the third request is in flight after two items were committed');

    // Another instance takes the source over while the third request of this pass is still running.
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.ok(record !== null);
    await world.store.saveLuoguSyncState(
      {
        ...record.value,
        owner: 'svc-other',
        leaseExpiresAt: new Date(world.clock.nowMs() + 120_000).toISOString(),
        updatedAt: world.clock.now(),
      },
      record.revision,
    );
    gate.release();
    await service.settle();

    const after = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(after?.value.owner, 'svc-other', 'the losing pass never clobbers the new owner');
    assert.equal(after?.value.missingMetadata.length, 10, 'the two committed keys stay committed');
    assert.equal(after?.value.failure, null, 'the losing pass writes no failure over the new owner');
    assert.equal(world.metadata.calls.length, 3, 'no further request is issued after the lease is lost');
    assert.equal((await service.status(world.alice.id)).running, false, 'the pass itself stopped');
  } finally {
    await world.dispose();
  }
});

void test('a metadata action coalesces with itself and refuses an incompatible history action', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-metadata-modes');
    const keys = Array.from({ length: 6 }, (_, index) => `C${index + 1}`);
    await seedBacklog(world, world.alice.id, keys);
    const originalFetch = world.metadata.adapter.fetchProblem.bind(world.metadata.adapter);
    const gate = deferred();
    let served = 0;
    world.metadata.adapter.fetchProblem = async (request) => {
      served += 1;
      if (served === 2) {
        await gate.promise;
      }
      return originalFetch(request);
    };

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await until(() => served >= 2, 'the first item is committed and the second request is held');
    const [first, second] = await Promise.all([
      service.start(world.alice.id, 'metadata'),
      service.start(world.alice.id, 'metadata'),
    ]);
    assert.equal(first.outcome, 'coalesced');
    assert.equal(second.outcome, 'coalesced');
    for (const mode of ['resume', 'full'] as const) {
      await assert.rejects(
        service.start(world.alice.id, mode),
        (error: unknown) => error instanceof LuoguSyncError && error.code === 'busy',
        `an incompatible ${mode} action is refused instead of being queued`,
      );
    }

    gate.release();
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.metadataResolved, 6, 'the metadata pass alone drained the backlog');
    assert.equal(status.metadataBacklog, 0);
    assert.equal(status.totalPages, 0, 'no history page was committed');
    assert.equal(status.historyComplete, false, 'the refused history action queued nothing');
    assert.equal(world.feed.calls.length, 0, 'the refused history action never touched the platform');
    assert.equal(world.metadata.calls.length, 6);
  } finally {
    await world.dispose();
  }
});

void test('closing the service drains a held metadata pass and keeps its committed progress', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-metadata-close');
    const keys = Array.from({ length: 8 }, (_, index) => `H${index + 1}`);
    await seedBacklog(world, world.alice.id, keys);
    const originalFetch = world.metadata.adapter.fetchProblem.bind(world.metadata.adapter);
    const gate = deferred();
    let served = 0;
    world.metadata.adapter.fetchProblem = async (request) => {
      served += 1;
      if (served === 2) {
        await gate.promise;
      }
      return originalFetch(request);
    };

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await until(() => served >= 2, 'the first item is committed and the second request is held');
    const closing = service.close();
    await sleep(20);
    gate.release();
    await closing;

    const status = await service.status(world.alice.id);
    assert.equal(status.running, false);
    assert.equal(status.metadataResolved, 1, 'the close keeps every item committed before it drained the pass');
    assert.equal(
      status.metadataBacklog,
      7,
      'the whole remaining queue is kept, including the key whose in-flight answer the cancellation discarded',
    );
    await assert.rejects(
      service.start(world.alice.id, 'metadata'),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'closing',
    );
    assert.equal(world.metadata.calls.length, 2, 'the close issued no further platform request');
  } finally {
    await world.dispose();
  }
});

void test('a metadata action is refused as busy while a history pass owns the source', async () => {
  const world = await createWorld({ alice: { total: 60, pids: ['P1000'] } });
  try {
    const service = world.makeService('svc-metadata-busy');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    world.feed.holdNext = 1;
    assert.equal((await service.start(world.alice.id, 'resume')).outcome, 'started');
    await until(() => world.feed.heldCount() === 1, 'the history pass is parked inside its first page');
    await assert.rejects(
      service.start(world.alice.id, 'metadata'),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'busy',
      'a metadata action never queues behind a history pass',
    );
    world.feed.release();
    await service.settle();
    assert.equal(await countSubmissions(world.store, world.alice.id), 60);
  } finally {
    await world.dispose();
  }
});

void test('a rate-limited metadata item is rotated once and stops the phase with its retry instant', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-metadata-rate-limited');
    await seedBacklog(world, world.alice.id, ['P3001', 'P3002', 'P3003', 'P3004']);
    world.metadata.fail.set(
      'P3002',
      new PlatformError({
        code: 'rate_limited',
        operation: 'problem',
        retryable: true,
        retryAfterMs: 30_000,
        detail: 'the metadata read was rate limited',
      }),
    );

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.deepEqual(world.metadata.calls, ['P3001', 'P3002'], 'a rate limit stops the phase instead of hammering it');
    assert.equal(status.metadataResolved, 1);
    assert.equal(status.metadataFailed, 1);
    assert.equal(status.failure?.code, 'rate_limited');
    assert.equal(status.failure?.stage, 'metadata');
    assert.equal(status.paused, false);
    assert.equal(
      Date.parse(status.failure?.retryAt ?? '') - Date.parse(status.failure?.at ?? ''),
      30_000,
      'the declared Retry-After is honored',
    );
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(record?.value.missingMetadata.length, 3, 'the failed key stays queued');
    assert.equal(
      record?.value.missingMetadata[2],
      problemKeyOf(world.instance, 'P3002'),
      'the failed key is rotated to the end instead of being dropped',
    );
  } finally {
    await world.dispose();
  }
});

void test('a successful metadata-only drain keeps a stored history failure and still records a new metadata failure', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-meta-keep-history');
    const historyFailure: LuoguSyncFailure = {
      code: 'auth_required',
      at: fx.AT,
      retryAt: null,
      paused: true,
      stage: 'history',
    };
    await seedBacklog(world, world.alice.id, ['K1', 'K2'], { failure: historyFailure });

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const drained = await service.status(world.alice.id);
    assert.equal(drained.metadataResolved, 2, 'the whole backlog was drained');
    assert.equal(drained.metadataBacklog, 0);
    assert.deepEqual(
      drained.failure,
      historyFailure,
      'a metadata-only run clears no failure whose half it never retried',
    );
    assert.equal(drained.paused, true, 'the account stays paused until the user acts');

    // A new metadata failure is still recorded normally, over the history failure it did not repair.
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.ok(record !== null);
    await world.store.saveLuoguSyncState(
      {
        ...record.value,
        missingMetadata: buildProblemKeys(world.instance, ['K3']),
        failure: historyFailure,
        updatedAt: world.clock.now(),
      },
      record.revision,
    );
    world.metadata.fail.set(
      'K3',
      new PlatformError({
        code: 'unavailable',
        operation: 'problem',
        retryable: true,
        detail: 'the problem page is unavailable',
      }),
    );
    world.clock.advance(1_000);

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const failed = await service.status(world.alice.id);
    assert.equal(failed.failure?.code, 'unavailable', 'a new metadata failure is recorded normally');
    assert.equal(failed.failure?.stage, 'metadata');
    assert.equal(failed.metadataFailed, 1);
    assert.equal(failed.metadataBacklog, 1, 'the failed key stays queued');
  } finally {
    await world.dispose();
  }
});

void test('an empty metadata action keeps a legacy stage-less failure untouched', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-meta-keep-legacy');
    const legacyFailure: LuoguSyncFailure = {
      code: 'unavailable',
      at: fx.AT,
      retryAt: new Date(Date.parse(fx.AT) + 2_000).toISOString(),
      paused: false,
    };
    await world.store.saveLuoguSyncState(
      {
        ...emptyLuoguSyncState(world.alice.id, world.instance.id, fx.AT),
        failure: legacyFailure,
        updatedAt: fx.AT,
      },
      null,
    );

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.deepEqual(status.failure, legacyFailure, 'no history was read, so the stored failure is untouched');
    assert.equal(status.failure?.stage, undefined, 'no stage is invented for a legacy record');
    assert.equal(status.metadataBacklog, 0);
    assert.equal(status.metadataResolved, 0);
    assert.equal(status.metadataFailed, 0);
    assert.equal(world.metadata.calls.length, 0, 'an empty drain requests no metadata');
  } finally {
    await world.dispose();
  }
});

void test('a successful metadata retry clears the metadata failure it repaired', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-meta-clear');
    const metadataFailure: LuoguSyncFailure = {
      code: 'unavailable',
      at: fx.AT,
      retryAt: new Date(Date.parse(fx.AT) + 2_000).toISOString(),
      paused: false,
      stage: 'metadata',
    };
    await seedBacklog(world, world.alice.id, ['C1', 'C2'], { failure: metadataFailure });
    world.clock.advance(2_500);

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.metadataResolved, 2);
    assert.equal(status.metadataBacklog, 0);
    assert.equal(status.failure, null, 'the repaired metadata failure is cleared by the successful retry');
    assert.equal(status.paused, false);
  } finally {
    await world.dispose();
  }
});

void test('a cancel during a metadata drain keeps the failure an earlier item committed', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-meta-cancel-failure');
    await seedBacklog(world, world.alice.id, ['X1', 'X2', 'X3']);
    world.metadata.fail.set(
      'X1',
      new PlatformError({
        code: 'unavailable',
        operation: 'problem',
        retryable: true,
        detail: 'the first problem page is unavailable',
      }),
    );
    const originalFetch = world.metadata.adapter.fetchProblem.bind(world.metadata.adapter);
    const gate = deferred();
    let served = 0;
    world.metadata.adapter.fetchProblem = async (request) => {
      served += 1;
      if (served === 2) {
        await gate.promise;
      }
      return originalFetch(request);
    };

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await until(() => served >= 2, 'the second item is in flight after the first one failed');
    const during = await service.status(world.alice.id);
    assert.equal(during.failure?.code, 'unavailable', 'the failed item was committed durably');
    assert.equal(during.failure?.stage, 'metadata');
    assert.equal(during.metadataFailed, 1);

    const cancelled = service.cancel(world.alice.id);
    await sleep(20);
    gate.release();
    await cancelled;

    const after = await service.status(world.alice.id);
    assert.equal(after.running, false);
    assert.equal(after.failure?.code, 'unavailable', 'the cancellation keeps that item failure instead of wiping it');
    assert.equal(after.failure?.stage, 'metadata');
    assert.equal(after.metadataFailed, 1);
    assert.equal(after.metadataBacklog, 3, 'the whole queue, including the discarded in-flight key, is kept');
    assert.equal(after.leaseOwner, null, 'the cancelled pass released its lease');
    assert.equal(world.metadata.calls.length, 2, 'no further request is issued after the pause');
  } finally {
    await world.dispose();
  }
});

void test('a lease lost while the metadata gate waits dispatches no request and clobbers no foreign row', async () => {
  // A foreign takeover during the wait: the pass must not touch the new owner's row at all.
  const takeover = await createWorld();
  try {
    const service = takeover.makeService('svc-gate-takeover');
    await seedBacklog(takeover, takeover.alice.id, ['G1', 'G2']);
    const gate = parkGate(takeover);

    assert.equal((await service.start(takeover.alice.id, 'metadata')).outcome, 'started');
    await until(() => gate.parked() >= 1, 'the metadata operation to park inside the source gate');
    const record = await takeover.store.getLuoguSyncState(takeover.alice.id);
    assert.ok(record !== null);
    await takeover.store.saveLuoguSyncState(
      {
        ...record.value,
        owner: 'svc-other',
        leaseExpiresAt: new Date(takeover.clock.nowMs() + 120_000).toISOString(),
        updatedAt: takeover.clock.now(),
      },
      record.revision,
    );
    gate.release();
    await service.settle();

    assert.equal(takeover.metadata.calls.length, 0, 'no metadata request is dispatched on a stale claim');
    const after = await takeover.store.getLuoguSyncState(takeover.alice.id);
    assert.equal(after?.value.owner, 'svc-other', 'the losing pass never overwrites the new owner');
    assert.equal(after?.value.failure, null, 'nor writes its own failure over that row');
    assert.equal(after?.value.missingMetadata.length, 2, 'the backlog is left exactly as the new owner has it');
    assert.equal((await service.status(takeover.alice.id)).running, false);
  } finally {
    await takeover.dispose();
  }

  // Without a takeover, a lease that expired during the wait is refused the same way and recorded.
  const expiry = await createWorld();
  try {
    const service = expiry.makeService('svc-gate-expiry');
    await seedBacklog(expiry, expiry.alice.id, ['G1', 'G2']);
    const gate = parkGate(expiry);

    assert.equal((await service.start(expiry.alice.id, 'metadata')).outcome, 'started');
    await until(() => gate.parked() >= 1, 'the metadata operation to park inside the source gate');
    expiry.clock.advance(130_000);
    gate.release();
    await service.settle();

    assert.equal(expiry.metadata.calls.length, 0, 'an expired lease dispatches no request either');
    const status = await service.status(expiry.alice.id);
    assert.equal(status.failure?.code, 'lease_lost');
    assert.equal(status.failure?.stage, 'metadata');
    assert.equal(status.metadataBacklog, 2, 'the backlog is untouched');
    assert.equal(status.leaseOwner, null, 'the expired pass still releases its own row');
    assert.equal(status.running, false);
  } finally {
    await expiry.dispose();
  }
});

/** Park every source-gate operation before its work callback, so a test can race the durable lease. */
function parkGate(world: World): { readonly release: () => void; readonly parked: () => number } {
  const gate = deferred();
  const originalRun = world.gate.run.bind(world.gate);
  let parked = 0;
  const run = async (
    token: CancellationToken,
    work: (token: CancellationToken) => Promise<unknown>,
  ): Promise<unknown> => {
    parked += 1;
    await gate.promise;
    return originalRun(token, work);
  };
  world.gate.run = run as LuoguSourceGate['run'];
  return { release: gate.release, parked: () => parked };
}

// ---------------------------------------------------------------------------------------
// Public nickname refresh (Sprint 22b)
// ---------------------------------------------------------------------------------------

void test('refreshProfile stores only the validated data.user nickname and preserves identity', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile');
    await world.store.upsertAccounts([{ ...world.alice, displayName: '旧昵称' }]);
    await seedBacklog(world, world.alice.id, ['P1000'], {
      failure: { code: 'unavailable', at: fx.AT, retryAt: null, paused: true, stage: 'metadata' },
    });
    world.metadata.profiles.set('100001', {
      sourceInstanceId: world.instance.id,
      uid: '100001',
      displayName: '示例选手',
    });

    const updated = await service.refreshProfile(world.alice.id, world.token);
    assert.deepEqual(updated, {
      id: world.alice.id,
      sourceInstanceId: world.instance.id,
      handle: '100001',
      displayName: '示例选手',
      profileUrl: world.alice.profileUrl,
    });
    const stored = await world.store.getAccount(world.alice.id);
    assert.equal(stored?.displayName, '示例选手');
    assert.equal(stored?.profileUrl, world.alice.profileUrl);
    assert.deepEqual(world.metadata.profileCalls, ['100001']);
    assert.deepEqual(world.metadata.calls, [], 'no problem metadata was requested');
    assert.equal(world.metadata.editorialCalls(), 0);
    assert.equal(world.vault.writes.length, 0, 'no credential was written');
    assert.equal(world.feed.calls.length, 0, 'no history request was made');
    // The durable records a profile refresh must not touch survive it unchanged.
    const state = (await world.store.getLuoguSyncState(world.alice.id))?.value;
    assert.deepEqual(state?.missingMetadata, buildProblemKeys(world.instance, ['P1000']));
    assert.equal(state?.failure?.code, 'unavailable');
    assert.equal(state?.failure?.paused, true);
    assert.equal(state?.owner, null, 'the profile lease is released');
    assert.equal(await checkpointOf(world, world.alice.id), null);
    assert.equal((await service.status(world.alice.id)).connection, null, 'no connection is required');
  } finally {
    await world.dispose();
  }
});

void test('a mismatched or missing profile answer keeps the previous nickname and releases the lease', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile-fail');
    // The anonymous source answers a profile of a *different* uid; the service re-validates it.
    world.metadata.profiles.set('100001', {
      sourceInstanceId: world.instance.id,
      uid: '100002',
      displayName: '冒名昵称',
    });
    await assert.rejects(
      service.refreshProfile(world.alice.id, world.token),
      (error: unknown) =>
        error instanceof PlatformError && error.code === 'changed_response' && error.operation === 'profile',
    );
    assert.equal((await world.store.getAccount(world.alice.id))?.displayName, null);
    const refused = await service.status(world.alice.id);
    assert.equal(refused.leaseOwner, null, 'a refused lookup releases its lease');
    assert.equal(refused.running, false);

    // The synthetic source has no profile for this uid at all; the nickname stays untouched too.
    await assert.rejects(
      service.refreshProfile(world.bob.id, world.token),
      (error: unknown) => error instanceof PlatformError && error.code === 'changed_response',
    );
    assert.equal((await world.store.getAccount(world.bob.id))?.displayName, null);
    assert.equal((await service.status(world.bob.id)).leaseOwner, null);
  } finally {
    await world.dispose();
  }
});

void test('a cancelled profile refresh keeps the previous nickname and releases the source', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile-cancel');
    const source = createCancellationSource();
    let entered = false;
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.metadata.adapter.fetchAccountProfile = async (request) => {
      entered = true;
      await blocked;
      request.token.throwIfCancelled();
      return { sourceInstanceId: world.instance.id, uid: request.account.handle, displayName: '示例选手' };
    };
    const pending = service.refreshProfile(world.alice.id, source.token);
    await until(() => entered, 'the profile request to start');
    source.cancel('cancelled by the test');
    release();
    await assert.rejects(pending, (error: unknown) => error instanceof DomainError && error.code === 'cancelled');
    assert.equal((await world.store.getAccount(world.alice.id))?.displayName, null);
    const status = await service.status(world.alice.id);
    assert.equal(status.leaseOwner, null);
    assert.equal(status.running, false);
  } finally {
    await world.dispose();
  }
});

void test('a profile refresh holds the one source slot and refuses a concurrent operation', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile-busy');
    // The synthetic source must actually own a profile for the pinned uid: the answering port is
    // parked first, and an unseeded map would refuse the answer as `changed_response` instead.
    world.metadata.profiles.set('100001', {
      sourceInstanceId: world.instance.id,
      uid: '100001',
      displayName: '示例选手',
    });
    const original = world.metadata.adapter.fetchAccountProfile!.bind(world.metadata.adapter);
    let entered = false;
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.metadata.adapter.fetchAccountProfile = async (request) => {
      entered = true;
      await blocked;
      return original(request);
    };
    const first = service.refreshProfile(world.alice.id, world.token);
    await until(() => entered, 'the first profile request to start');
    // The same account and another account of the same source are both refused while it runs.
    await assert.rejects(
      service.refreshProfile(world.alice.id, world.token),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'busy',
    );
    await assert.rejects(
      service.refreshProfile(world.bob.id, world.token),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'busy',
    );
    release();
    const updated = await first;
    assert.equal(updated.displayName, '示例选手');
    assert.equal((await world.store.getAccount(world.bob.id))?.displayName, null, 'another account is untouched');
  } finally {
    await world.dispose();
  }
});

void test('a profile answer that arrives after cancellation is discarded and never stored', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile-late');
    const source = createCancellationSource();
    let entered = false;
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A deliberately non-cooperating port: it neither observes the token nor fails, it just answers.
    world.metadata.adapter.fetchAccountProfile = async () => {
      entered = true;
      await blocked;
      return { sourceInstanceId: world.instance.id, uid: '100001', displayName: '迟到的昵称' };
    };
    const pending = service.refreshProfile(world.alice.id, source.token);
    await until(() => entered, 'the non-cooperating profile request to start');
    source.cancel('cancelled while the port was answering');
    release();
    await assert.rejects(pending, (error: unknown) => error instanceof DomainError && error.code === 'cancelled');
    assert.equal((await world.store.getAccount(world.alice.id))?.displayName, null, 'the late answer is discarded');
    assert.equal((await service.status(world.alice.id)).leaseOwner, null);
  } finally {
    await world.dispose();
  }
});

void test('a cancellation while the nickname transaction waits on its account read saves nothing', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile-store-read');
    world.metadata.profiles.set('100001', {
      sourceInstanceId: world.instance.id,
      uid: '100001',
      displayName: '示例选手',
    });
    const source = createCancellationSource();
    const store = world.store;
    const realGetAccount = store.getAccount.bind(store);
    const realFetch = world.metadata.adapter.fetchAccountProfile!.bind(world.metadata.adapter);
    let answered = false;
    let entered = false;
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.metadata.adapter.fetchAccountProfile = async (request) => {
      const profile = await realFetch(request);
      answered = true;
      return profile;
    };
    store.getAccount = async (id: string) => {
      // The first read after the answer is the transaction's own re-read; park it.
      if (answered && !entered) {
        entered = true;
        await blocked;
      }
      return realGetAccount(id);
    };
    const pending = service.refreshProfile(world.alice.id, source.token);
    await until(() => entered, 'the nickname transaction read to start');
    source.cancel('cancelled while the transaction waited');
    release();
    await assert.rejects(pending, (error: unknown) => error instanceof DomainError && error.code === 'cancelled');
    assert.equal((await store.getAccount(world.alice.id))?.displayName, null);
    assert.equal((await service.status(world.alice.id)).leaseOwner, null);
  } finally {
    await world.dispose();
  }
});

void test('a cancellation that lands while the nickname write runs rolls the write back', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile-store-write');
    world.metadata.profiles.set('100001', {
      sourceInstanceId: world.instance.id,
      uid: '100001',
      displayName: '示例选手',
    });
    const source = createCancellationSource();
    const store = world.store;
    const realUpsert = store.upsertAccounts.bind(store);
    let entered = false;
    let writes = 0;
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.upsertAccounts = async (accounts) => {
      writes += 1;
      entered = true;
      await blocked;
      return realUpsert(accounts);
    };
    const pending = service.refreshProfile(world.alice.id, source.token);
    await until(() => entered, 'the nickname write to start');
    source.cancel('cancelled while the transaction wrote');
    release();
    await assert.rejects(pending, (error: unknown) => error instanceof DomainError && error.code === 'cancelled');
    assert.equal(writes, 1, 'the write was reached');
    const stored = await store.getAccount(world.alice.id);
    assert.equal(stored?.displayName, null, 'the write was rolled back');
    assert.equal(stored?.profileUrl, world.alice.profileUrl, 'the stored account row survived');
    assert.equal((await service.status(world.alice.id)).leaseOwner, null);
  } finally {
    await world.dispose();
  }
});

void test('refreshProfile refuses a source without the optional capability as unsupported', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile-unsupported');
    (world.metadata.adapter as { fetchAccountProfile?: unknown }).fetchAccountProfile = undefined;
    await assert.rejects(
      service.refreshProfile(world.alice.id, world.token),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'unsupported',
    );
    assert.deepEqual(world.metadata.profileCalls, [], 'a capability gap touches no platform');
    assert.equal((await service.status(world.alice.id)).leaseOwner, null);
  } finally {
    await world.dispose();
  }
});

void test('a lease lost while the profile gate waits dispatches no request and clobbers no foreign row', async () => {
  // A foreign takeover during the wait: the profile operation must not touch the new owner's row.
  const takeover = await createWorld();
  try {
    const service = takeover.makeService('svc-profile-gate-takeover');
    const gate = parkGate(takeover);
    const pending = service.refreshProfile(takeover.alice.id, takeover.token);
    await until(() => gate.parked() >= 1, 'the profile operation to park inside the source gate');
    const record = await takeover.store.getLuoguSyncState(takeover.alice.id);
    assert.ok(record !== null, 'the claim is durable while the gate waits');
    await takeover.store.saveLuoguSyncState(
      {
        ...record.value,
        owner: 'foreign-owner',
        leaseExpiresAt: new Date(takeover.clock.nowMs() + 120_000).toISOString(),
        updatedAt: takeover.clock.now(),
      },
      record.revision,
    );
    gate.release();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_transition',
    );
    assert.deepEqual(takeover.metadata.profileCalls, [], 'no public request is dispatched on a stale claim');
    assert.equal((await takeover.store.getLuoguSyncState(takeover.alice.id))?.value.owner, 'foreign-owner');
    assert.equal((await takeover.store.getAccount(takeover.alice.id))?.displayName, null);
    assert.equal((await service.status(takeover.alice.id)).running, false);
  } finally {
    await takeover.dispose();
  }

  // Without a takeover, a lease that expired during the wait is refused the same way.
  const expiry = await createWorld();
  try {
    const service = expiry.makeService('svc-profile-gate-expiry');
    const gate = parkGate(expiry);
    const pending = service.refreshProfile(expiry.alice.id, expiry.token);
    await until(() => gate.parked() >= 1, 'the profile operation to park inside the source gate');
    const record = await expiry.store.getLuoguSyncState(expiry.alice.id);
    assert.ok(record !== null);
    await expiry.store.saveLuoguSyncState(
      {
        ...record.value,
        leaseExpiresAt: new Date(expiry.clock.nowMs() - 1_000).toISOString(),
        updatedAt: expiry.clock.now(),
      },
      record.revision,
    );
    gate.release();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_transition',
    );
    assert.deepEqual(expiry.metadata.profileCalls, [], 'an expired claim issues no public request');
    const after = await expiry.store.getLuoguSyncState(expiry.alice.id);
    assert.equal(after?.value.owner, null, 'the expired claim releases instead of being resurrected');
    assert.equal((await expiry.store.getAccount(expiry.alice.id))?.displayName, null);
  } finally {
    await expiry.dispose();
  }
});

void test('refreshProfile refuses a foreign or unknown account before touching the platform', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-profile-scope');
    const mirror = createSourceInstance({
      platform: 'luogu',
      baseUrl: 'https://www.luogu.com.cn',
      domain: 'mirror.example',
      displayName: 'Mirror',
    });
    const foreign = createLuoguAccount(mirror, '100001');
    await world.store.upsertSourceInstances([mirror]);
    await world.store.upsertAccounts([foreign]);
    await assert.rejects(
      service.refreshProfile(foreign.id, world.token),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'account_foreign',
    );
    await assert.rejects(
      service.refreshProfile(accountIdOf(world.instance.id, '999999'), world.token),
      (error: unknown) => error instanceof LuoguSyncError && error.code === 'account_missing',
    );
    assert.deepEqual(world.metadata.profileCalls, []);
  } finally {
    await world.dispose();
  }
});

// ---------------------------------------------------------------------------------------
// Sprint 22c: a private (U-prefixed) problem refusal is an item failure, not a session stop
// ---------------------------------------------------------------------------------------

for (const [pid, code] of [['U700001', 'auth_required'], ['U700001', 'forbidden'], ['T700001', 'auth_required'], ['T700001', 'forbidden']] as const) {
  void test(`a ${code} refusal of ${pid} is remembered per item and the drain continues`, async () => {
    const world = await createWorld();
    try {
      const service = world.makeService(`svc-meta-private-${code}`);
      await seedBacklog(world, world.alice.id, [pid, 'P1001']);
      const feedCallsBefore = world.feed.calls.length;
      world.metadata.fail.set(
        pid,
        new PlatformError({
          code,
          operation: 'problem',
          retryable: false,
          detail: 'synthetic private refusal',
        }),
      );

      assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
      await service.settle();
      const status = await service.status(world.alice.id);
      assert.deepEqual(
        world.metadata.calls,
        [pid, 'P1001'],
        'the refused private key never stops the keys behind it',
      );
      assert.equal(status.metadataResolved, 1, 'the public key after the refusal was still fetched');
      assert.equal(status.metadataFailed, 1, 'the refused key counts as one failed item');
      assert.equal(status.failure?.code, code, 'the item refusal is remembered as the durable failure');
      assert.equal(status.failure?.stage, 'metadata');
      assert.equal(status.metadataBacklog, 1, 'the refused key stays queued instead of being dropped');
      assert.equal(world.feed.calls.length, feedCallsBefore, 'a metadata drain never reads a history page');
      const record = await world.store.getLuoguSyncState(world.alice.id);
      assert.equal(record?.value.missingMetadata.length, 1);
      assert.equal(
        record?.value.missingMetadata[0],
        problemKeyOf(world.instance, pid),
        'the refused key is rotated to the end of the durable backlog',
      );
    } finally {
      await world.dispose();
    }
  });
}

void test('a rate limit after a deferred private refusal stops the drain and replaces the failure', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-meta-private-then-rate-limited');
    await seedBacklog(world, world.alice.id, ['U700002', 'P2002', 'P2003']);
    world.metadata.fail.set(
      'U700002',
      new PlatformError({
        code: 'auth_required',
        operation: 'problem',
        retryable: false,
        detail: 'synthetic private refusal',
      }),
    );
    world.metadata.fail.set(
      'P2002',
      new PlatformError({
        code: 'rate_limited',
        operation: 'problem',
        retryable: true,
        retryAfterMs: 30_000,
        detail: 'synthetic 429',
      }),
    );

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.deepEqual(world.metadata.calls, ['U700002', 'P2002'], 'the 429 stops the pass before P2003');
    assert.equal(status.failure?.code, 'rate_limited', 'a session-level stop replaces the deferred item refusal');
    assert.equal(status.failure?.stage, 'metadata');
    assert.equal(status.metadataResolved, 0);
    assert.equal(status.metadataFailed, 2);
    assert.equal(status.metadataBacklog, 3, 'no queued key is dropped when the pass stops');
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(
      record?.value.missingMetadata[2],
      problemKeyOf(world.instance, 'P2002'),
      'the stopped key is rotated to the end',
    );
  } finally {
    await world.dispose();
  }
});

void test('a changed_response after a deferred private refusal still stops the drain', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-meta-private-then-changed');
    await seedBacklog(world, world.alice.id, ['U700003', 'P3002', 'P3003']);
    world.metadata.fail.set(
      'U700003',
      new PlatformError({
        code: 'forbidden',
        operation: 'problem',
        retryable: false,
        detail: 'synthetic private refusal',
      }),
    );
    world.metadata.fail.set(
      'P3002',
      new PlatformError({
        code: 'changed_response',
        operation: 'problem',
        retryable: false,
        detail: 'synthetic unexpected page',
      }),
    );

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.deepEqual(world.metadata.calls, ['U700003', 'P3002'], 'an unexpected page stops the pass before P3003');
    assert.equal(status.failure?.code, 'changed_response', 'a session-level stop replaces the deferred item refusal');
    assert.equal(status.failure?.stage, 'metadata');
    assert.equal(status.metadataResolved, 0);
    assert.equal(status.metadataFailed, 2);
    assert.equal(status.metadataBacklog, 3, 'no queued key is dropped when the pass stops');
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(
      record?.value.missingMetadata[2],
      problemKeyOf(world.instance, 'P3002'),
      'the stopped key is rotated to the end',
    );
  } finally {
    await world.dispose();
  }
});

void test('a cancel after a deferred private refusal keeps the refusal and the rotation', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-meta-private-cancel');
    await seedBacklog(world, world.alice.id, ['U700004', 'P4002', 'P4003']);
    world.metadata.fail.set(
      'U700004',
      new PlatformError({
        code: 'auth_required',
        operation: 'problem',
        retryable: false,
        detail: 'synthetic private refusal',
      }),
    );
    const originalFetch = world.metadata.adapter.fetchProblem.bind(world.metadata.adapter);
    const gate = deferred();
    let served = 0;
    world.metadata.adapter.fetchProblem = async (request) => {
      served += 1;
      if (served === 2) {
        await gate.promise;
      }
      return originalFetch(request);
    };

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await until(() => served >= 2, 'the second key is in flight after the private refusal was committed');
    const during = await service.status(world.alice.id);
    assert.equal(during.failure?.code, 'auth_required', 'the refused item was committed durably');
    assert.equal(during.failure?.stage, 'metadata');
    assert.equal(during.metadataFailed, 1);

    const cancelled = service.cancel(world.alice.id);
    await sleep(20);
    gate.release();
    await cancelled;

    const after = await service.status(world.alice.id);
    assert.equal(after.running, false);
    assert.equal(after.failure?.code, 'auth_required', 'the cancel keeps the item refusal instead of wiping it');
    assert.equal(after.failure?.stage, 'metadata');
    assert.equal(after.metadataFailed, 1);
    assert.equal(after.metadataBacklog, 3, 'the whole queue, including the discarded in-flight key, is kept');
    assert.equal(after.leaseOwner, null, 'the cancelled pass released its lease');
    assert.equal(world.metadata.calls.length, 2, 'no further request is issued after the pause');
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(
      record?.value.missingMetadata[2],
      problemKeyOf(world.instance, 'U700004'),
      'the rotated private key stays at the end of the durable backlog',
    );
  } finally {
    await world.dispose();
  }
});

void test('a backlog of only private U keys attempts every key at most once per pass', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('svc-meta-private-once');
    await seedBacklog(world, world.alice.id, ['U700005', 'U700006']);
    for (const pid of ['U700005', 'U700006']) {
      world.metadata.fail.set(
        pid,
        new PlatformError({
          code: 'auth_required',
          operation: 'problem',
          retryable: false,
          detail: 'synthetic private refusal',
        }),
      );
    }

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(new Set(world.metadata.calls).size, 2, 'the rotation never retries a key inside the same pass');
    assert.deepEqual(
      world.metadata.calls,
      ['U700005', 'U700006'],
      'every private key is attempted exactly once and the pass ends',
    );
    assert.equal(status.metadataFailed, 2);
    assert.equal(status.metadataResolved, 0);
    assert.equal(status.metadataBacklog, 2, 'both refused keys stay queued for a later pass');
    assert.equal(status.failure?.code, 'auth_required');
    assert.equal(status.failure?.stage, 'metadata');
  } finally {
    await world.dispose();
  }
});

// Stage25 recovery regressions use the real SQLite transaction boundary and only synthetic data.
void test('metadata recovery defers an empty statement, imports the next item, and persists honest paged diagnostics', async () => {
  const world = await createWorld();
  try {
    const service = world.makeService('recovery-batch');
    await seedBacklog(world, world.alice.id, ['U900000001', 'P900000001']);
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    const historyReads = world.feed.calls.length;
    world.metadata.fail.set('U900000001', new PlatformError({code:'changed_response',operation:'problem',reason:'missing_statement',detail:'synthetic incomplete problem'}));
    await service.start(world.alice.id, 'metadata'); await service.settle();
    assert.deepEqual(world.metadata.calls, ['U900000001','P900000001']);
    const state=(await world.store.getLuoguSyncState(world.alice.id))!.value;
    assert.deepEqual(state.missingMetadata,[problemKeyOf(world.instance,'U900000001')]);
    assert.equal(state.metadataResolved,1); assert.equal(state.metadataFailed,1);
    assert.equal(state.metadataIssues?.[0]?.reason,'missing_statement');
    assert.ok(await world.store.getProblem(problemKeyOf(world.instance,'P900000001')));
    const reopened=new SqliteTrainingStore({path:world.paths.path});
    try {assert.deepEqual((await reopened.getLuoguSyncState(world.alice.id))!.value.metadataIssues,state.metadataIssues);} finally {await reopened.close();}
    const list=await service.metadataBacklog(world.alice.id,1,1);
    assert.equal(list.total,1); assert.equal(list.items[0]?.issue?.reason,'missing_statement');
    assert.equal(list.historicalFailedAttempts,1); assert.equal(list.knownIssues,1);
    assert.equal(world.feed.calls.length,historyReads);
  } finally {await world.dispose();}
});

void test('metadata recovery keeps HTML responses source-pausing and leaves later items unattempted',async()=>{
 const w=await createWorld();try{const s=w.makeService('recovery-html');
 await seedBacklog(w,w.alice.id,['P900000001','P900000002']);await s.connect(w.alice.id,cookieFor('100001'),w.token);w.metadata.fail.set('P900000001',new PlatformError({code:'changed_response',operation:'problem',reason:'html_response',detail:'synthetic challenge'}));
 await s.start(w.alice.id,'metadata');await s.settle();assert.deepEqual(w.metadata.calls,['P900000001']);const status=await s.status(w.alice.id);assert.equal(status.paused,true);
 const list=await s.metadataBacklog(w.alice.id,1,1);assert.equal(list.items[0]?.externalKey,'P900000001');assert.equal(list.items[0]?.issue?.reason,'html_response');
 const second=await s.metadataBacklog(w.alice.id,2,1);assert.equal(second.items[0]?.externalKey,'P900000002');assert.equal(second.items[0]?.issue,null);assert.equal(second.unknownIssueLabel,'尚无逐题失败记录');
 }finally{await w.dispose();}
});

void test('successful exact-one retry commits its snapshot without a nested transaction and preserves history plus siblings',async()=>{
 const w=await createWorld();try{const s=w.makeService('recovery-one');const keys=buildProblemKeys(w.instance,['P900000001','P900000002']);
 const historyFailure:LuoguSyncFailure={code:'timeout',at:fx.AT,retryAt:fx.LATER,paused:false,stage:'history'};
 await seedBacklog(w,w.alice.id,['P900000001','P900000002'],{historyComplete:true,historyCompletedAt:fx.AT,phase:'incremental',lastSuccessAt:fx.AT,lastScanStartedAt:fx.AT,scanStartedAt:fx.AT,totalPages:3,submissionsSeen:42,failure:historyFailure,metadataIssues:[{problemKey:keys[0]!,code:'changed_response',reason:'missing_statement',at:fx.AT,attempts:2},{problemKey:keys[1]!,code:'forbidden',reason:null,at:fx.AT,attempts:1}]});
 const before=(await w.store.getLuoguSyncState(w.alice.id))!.value,checkpoint=await checkpointOf(w,w.alice.id);
 const r=await s.retryMetadata(w.alice.id,keys[0]!,w.token);assert.equal(r.outcome,'resolved');assert.deepEqual(w.metadata.calls,['P900000001']);
 const after=(await w.store.getLuoguSyncState(w.alice.id))!.value;assert.deepEqual(after.missingMetadata,[keys[1]]);assert.deepEqual(after.metadataIssues,[before.metadataIssues![1]]);assert.equal(after.metadataResolved,1);assert.deepEqual(after.failure,historyFailure);
 for(const k of ['historyComplete','historyCompletedAt','phase','lastSuccessAt','lastScanStartedAt','scanStartedAt','totalPages','submissionsSeen'] as const)assert.deepEqual(after[k],before[k],k);
 assert.deepEqual(await checkpointOf(w,w.alice.id),checkpoint);assert.equal(await countSubmissions(w.store,w.alice.id),0);assert.equal(w.metadata.editorialCalls(),0);
 const p=await w.store.getProblem(keys[0]!);assert.ok(p);assert.ok(await w.store.getCurrentSnapshotHead(p.ref));assert.equal(after.owner,null);
 }finally{await w.dispose();}
});

void test('failed exact-one retry preserves history failure and queue order while saturating its issue attempts',async()=>{
 const w=await createWorld();try{const s=w.makeService('recovery-failed');const keys=buildProblemKeys(w.instance,['U900000001','P900000002']);
 const failure:LuoguSyncFailure={code:'auth_required',stage:'history',at:fx.AT,retryAt:null,paused:true};
 await seedBacklog(w,w.alice.id,['U900000001','P900000002'],{failure,metadataIssues:[{problemKey:keys[0]!,code:'changed_response',reason:'missing_statement',at:fx.AT,attempts:1000000}]});
 w.metadata.fail.set('U900000001',new PlatformError({code:'changed_response',operation:'problem',reason:'missing_statement',detail:'synthetic'}));
 const r=await s.retryMetadata(w.alice.id,keys[0]!,w.token);assert.equal(r.outcome,'deferred');const after=(await w.store.getLuoguSyncState(w.alice.id))!.value;
 assert.deepEqual(after.missingMetadata,keys);assert.deepEqual(after.failure,failure);assert.equal(after.metadataIssues?.[0]?.attempts,1000000);assert.equal(after.metadataFailed,1);assert.equal(await w.store.getProblem(keys[0]!),null);
 }finally{await w.dispose();}
});

for(const race of ['cancel','takeover','expiry'] as const)void test(`retry ${race} after HTTP commits no problem, snapshot, or dequeue`,async()=>{
 const w=await createWorld();try{const s=w.makeService('recovery-race');const key=problemKeyOf(w.instance,'P900000001');await seedBacklog(w,w.alice.id,['P900000001']);
 const cancellation=createCancellationSource();const original=w.metadata.adapter.fetchProblem.bind(w.metadata.adapter);
 w.metadata.adapter.fetchProblem=async request=>{const answer=await original(request);if(race==='cancel')cancellation.cancel();else if(race==='expiry')w.clock.advance(150000);else{const row=(await w.store.getLuoguSyncState(w.alice.id))!;await w.store.saveLuoguSyncState({...row.value,owner:'foreign-recovery-owner'},row.revision);}return answer;};
 await assert.rejects(s.retryMetadata(w.alice.id,key,cancellation.token));assert.equal(await w.store.getProblem(key),null);assert.equal(await w.store.getCurrentSnapshotHead({sourceInstanceId:w.instance.id,domain:null,externalKey:'P900000001'}),null);
 const state=(await w.store.getLuoguSyncState(w.alice.id))!.value;assert.deepEqual(state.missingMetadata,[key]);assert.equal(state.metadataResolved,0);assert.equal(state.metadataFailed,0);if(race==='takeover')assert.equal(state.owner,'foreign-recovery-owner');
 }finally{await w.dispose();}
});

void test('retry refuses same and other account live leases before dispatch',async()=>{
 for(const other of [false,true]){const w=await createWorld();try{const s=w.makeService('recovery-busy');const key=problemKeyOf(w.instance,'P900000001');await seedBacklog(w,w.alice.id,['P900000001'],other?{}:{owner:'other-owner',leaseExpiresAt:new Date(w.clock.nowMs()+120000).toISOString()});if(other)await seedBacklog(w,w.bob.id,[],{owner:'other-owner',leaseExpiresAt:new Date(w.clock.nowMs()+120000).toISOString()});
 await assert.rejects(s.retryMetadata(w.alice.id,key,w.token),e=>e instanceof LuoguSyncError&&e.code==='busy');assert.deepEqual(w.metadata.calls,[]);
 }finally{await w.dispose();}}
});

void test('retry rechecks queued membership after the source gate wait',async()=>{
 const w=await createWorld();try{const s=w.makeService('recovery-queued');const key=problemKeyOf(w.instance,'P900000001');await seedBacklog(w,w.alice.id,['P900000001']);const parked=parkGate(w);const pending=s.retryMetadata(w.alice.id,key,w.token);await until(()=>parked.parked()===1,'retry to wait');const row=(await w.store.getLuoguSyncState(w.alice.id))!;await w.store.saveLuoguSyncState({...row.value,missingMetadata:[]},row.revision);parked.release();await assert.rejects(pending);assert.deepEqual(w.metadata.calls,[]);assert.equal(await w.store.getProblem(key),null);
 }finally{await w.dispose();}
});

void test('a batch failure whose lease expires while its state read waits does not commit diagnostics or rotate the queue',async()=>{
 const w=await createWorld();try{const s=w.makeService('recovery-failed-commit-clock');const keys=buildProblemKeys(w.instance,['U900000001','P900000002']);await seedBacklog(w,w.alice.id,['U900000001','P900000002']);await s.connect(w.alice.id,cookieFor('100001'),w.token);
 w.metadata.fail.set('U900000001',new PlatformError({code:'changed_response',operation:'problem',reason:'missing_statement',detail:'synthetic'}));
 let answered=false,expired=false;const fetch=w.metadata.adapter.fetchProblem.bind(w.metadata.adapter);w.metadata.adapter.fetchProblem=async request=>{try{return await fetch(request);}finally{answered=true;}};
 const get=w.store.getLuoguSyncState.bind(w.store);w.store.getLuoguSyncState=async id=>{const row=await get(id);if(answered&&!expired&&row?.value.owner==='recovery-failed-commit-clock'){expired=true;w.clock.advance(150000);}return row;};
 await s.start(w.alice.id,'metadata');await s.settle();assert.equal(expired,true);const state=(await get(w.alice.id))!.value;assert.equal(state.metadataFailed,0);assert.deepEqual(state.metadataIssues??[],[]);assert.deepEqual(state.missingMetadata,keys);assert.deepEqual(w.metadata.calls,['U900000001']);
 }finally{await w.dispose();}
});
