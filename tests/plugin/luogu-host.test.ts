/**
 * Owned Luogu host runtime lifecycle (Sprint 17d1): close/drain races of the owned timer and start.
 *
 * Every case drives `createLuoguHost` itself against a real temporary SQLite store, the real Sprint
 * 17c1 recovery/state rows and the synthetic vault/clock/timer/transport seams. The assertions
 * describe externally meaningful close semantics: a tick parked inside the store keeps disposal
 * pending, no store read or platform request survives the close, a disposal that races `start()`
 * creates no timer afterwards, and a throwing error observer is reported by disposal instead of
 * becoming an unhandled rejection. No real credential, socket, model or paid API is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { createLuoguAccount, luoguSourceInstance } from '../../src/adapters/luogu/index.js';
import type { FetchInitLike, FetchLike, FetchResponseLike } from '../../src/adapters/platform/http.js';
import { ImportService } from '../../src/application/import-service.js';
import { emptyLuoguSyncState } from '../../src/application/luogu-sync-types.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import { DEFAULT_PLATFORM_LIMITS } from '../../src/application/ports.js';
import { createCancellationSource, type Account, type SourceInstance } from '../../src/domain/index.js';
import { createLuoguHost } from '../../src/plugin/luogu-host.js';
import * as sfx from '../sync/fixtures.js';
import * as fx from '../storage/fixtures.js';

/** A manually released gate used to park one store call inside a close race window. */
interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

function deferred(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Synthetic interval seam: records every schedule so a test can prove it was stopped. */
interface TimerSeam {
  readonly entries: Array<{
    readonly callback: () => void;
    readonly intervalMs: number;
    stopped: boolean;
    stop(): void;
  }>;
  readonly interval: (callback: () => void, ms: number) => () => void;
}

function timerSeam(): TimerSeam {
  const entries: Array<{
    callback: () => void;
    intervalMs: number;
    stopped: boolean;
    stop: () => void;
  }> = [];
  const interval = (callback: () => void, ms: number): (() => void) => {
    const entry = {
      callback,
      intervalMs: ms,
      stopped: false,
      stop: () => {
        entry.stopped = true;
      },
    };
    entries.push(entry);
    return entry.stop;
  };
  return { entries, interval };
}

interface HostWorld {
  readonly temp: { readonly path: string; readonly dir: string };
  readonly store: SqliteTrainingStore;
  readonly instance: SourceInstance;
  readonly account: Account;
  readonly host: ReturnType<typeof createLuoguHost>;
  readonly timers: TimerSeam;
  readonly feed: sfx.RecordFeed;
  disposeStore(): Promise<void>;
}

async function createHostWorld(
  onInternalError: (error: unknown) => void = () => {},
): Promise<HostWorld> {
  const temp = fx.tempDatabase();
  const clock = sfx.createClock();
  const waits = sfx.createWait();
  const vault = sfx.createMemoryVault();
  const feed = sfx.createRecordFeed();
  const timers = timerSeam();
  const store = new SqliteTrainingStore({ path: temp.path, now: () => clock.now() });
  const instance = luoguSourceInstance();
  await store.upsertSourceInstances([instance]);
  const account = createLuoguAccount(instance, '800001');
  await store.upsertAccounts([account]);
  const metadata = sfx.createMetadataAdapter(instance, clock.now);
  const host = createLuoguHost({
    store,
    imports: new ImportService({ store, now: clock.now }),
    sourceInstance: instance,
    metadataSource: metadata.adapter,
    dataDir: temp.dir,
    limits: DEFAULT_PLATFORM_LIMITS,
    ownerId: 'host-owner-1',
    onInternalError,
    seam: {
      vault,
      now: clock.now,
      nowMs: clock.nowMs,
      wait: waits.wait,
      tickIntervalMs: 1_000,
      setInterval: timers.interval,
      transport: { fetchImpl: feed.fetchImpl, clock: clock.nowMs, wait: waits.wait, setTimer: sfx.neverFireTimer },
    },
  });
  return {
    temp,
    store,
    instance,
    account,
    host,
    timers,
    feed,
    async disposeStore() {
      await store.close();
      fx.removeDirectory(temp.dir);
    },
  };
}

/** Park every `listAccounts` call on `gate` and count how often the store was asked. */
function parkListAccounts(store: SqliteTrainingStore, gate: Gate): () => number {
  const original = store.listAccounts.bind(store);
  let calls = 0;
  store.listAccounts = (async (...args: Parameters<SqliteTrainingStore['listAccounts']>) => {
    calls += 1;
    await gate.promise;
    return original(...args);
  }) as SqliteTrainingStore['listAccounts'];
  return () => calls;
}

void test('disposal drains a tick parked in the store and performs no store work afterwards', async () => {
  const world = await createHostWorld();
  try {
    await world.host.start(createCancellationSource().token);
    assert.equal(world.timers.entries.length, 1, 'start created exactly one periodic timer');
    assert.equal(world.timers.entries[0]?.intervalMs, 1_000);

    const gate = deferred();
    const calls = parkListAccounts(world.store, gate);
    world.timers.entries[0]!.callback();
    await sfx.until(() => calls() === 1, 'the tick to reach the deferred store read');

    let settled = false;
    const disposal = world.host.dispose().then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(settled, false, 'disposal waits for the tick that was already in flight');
    gate.release();
    await disposal;
    assert.equal(world.timers.entries[0]?.stopped, true, 'the owned timer was stopped');

    const afterClose = calls();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    assert.equal(calls(), afterClose, 'no store read happens after the disposal resolved');
    assert.equal(world.feed.calls.length, 0, 'no platform request is detached after the close');
    await assert.rejects(
      () => world.host.service.start(world.account.id, 'resume'),
      (error: unknown) => (error as { code?: string }).code === 'closing',
    );
  } finally {
    await world.disposeStore();
  }
});

void test('a disposal that races startup creates no timer and leaves no live tick', async () => {
  const world = await createHostWorld();
  try {
    const gate = deferred();
    const calls = parkListAccounts(world.store, gate);
    const starting = world.host.start(createCancellationSource().token).then(
      () => 'started' as const,
      (error: unknown) => error,
    );
    await sfx.until(() => calls() === 1, 'recovery to reach the deferred store read');

    const disposal = world.host.dispose();
    gate.release();
    await disposal;
    const outcome = await starting;
    assert.equal(outcome, 'started', 'the raced start settles as a no-op once disposal won');
    assert.equal(world.timers.entries.length, 0, 'no timer is created after disposal resolved');
    assert.equal(world.feed.calls.length, 0, 'the raced start never contacted the platform');
    await assert.rejects(
      () => world.host.service.start(world.account.id, 'resume'),
      (error: unknown) => (error as { code?: string }).code === 'closing',
    );
  } finally {
    await world.disposeStore();
  }
});

void test('a throwing error observer is reported by disposal instead of becoming an unhandled rejection', async () => {
  const observed: unknown[] = [];
  const world = await createHostWorld((error) => {
    observed.push(error);
    throw new Error('observer exploded');
  });
  try {
    await world.host.start(createCancellationSource().token);
    world.store.listAccounts = (async () => {
      throw new Error('sweep failed');
    }) as SqliteTrainingStore['listAccounts'];
    world.timers.entries[0]!.callback();
    await sfx.until(() => observed.length === 1, 'the failed sweep to reach the observer');
    await assert.rejects(() => world.host.dispose(), /observer exploded/);
  } finally {
    await world.disposeStore();
  }
});

// ---------------------------------------------------------------------------------------
// Sprint 30b: the host composes the account-bound authenticated metadata fallback
// ---------------------------------------------------------------------------------------

/** One observed authenticated problem request of the host's own fallback reader. */
interface HostProblemCall {
  readonly pid: string;
  readonly cookie: string | null;
}

interface HostProblemFeed {
  readonly fetchImpl: FetchLike;
  readonly calls: HostProblemCall[];
}

/** A valid `/problem/<pid>` answer the real parser accepts; nothing here talks to Luogu. */
function hostProblemPayload(pid: string): unknown {
  return {
    data: {
      problem: {
        pid,
        content: { name: `Problem ${pid}`, description: `Statement body of ${pid}` },
        samples: [],
        limits: { time: [1000], memory: [262_144] },
        difficulty: 3,
        tags: [1],
      },
    },
  };
}

function createHostProblemFeed(): HostProblemFeed {
  const calls: HostProblemCall[] = [];
  const fetchImpl: FetchLike = async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    const parsed = new URL(url);
    const pid = decodeURIComponent(parsed.pathname.replace('/problem/', ''));
    calls.push({ pid, cookie: init.headers['cookie'] ?? null });
    return sfx.jsonResponse(hostProblemPayload(pid));
  };
  return { fetchImpl, calls };
}

interface FallbackHostWorld {
  readonly temp: { readonly path: string; readonly dir: string };
  readonly store: SqliteTrainingStore;
  readonly instance: SourceInstance;
  readonly alice: Account;
  readonly bob: Account;
  readonly host: ReturnType<typeof createLuoguHost>;
  readonly metadata: sfx.MetadataHarness;
  readonly problems: HostProblemFeed;
  readonly token: ReturnType<typeof createCancellationSource>['token'];
  disposeStore(): Promise<void>;
}

/**
 * A host world whose transport answers both the authenticated `/record/list` validation page and the
 * authenticated `/problem/<pid>` fallback request, so `createLuoguHost` can be driven end to end.
 */
async function createFallbackHostWorld(): Promise<FallbackHostWorld> {
  const temp = fx.tempDatabase();
  const clock = sfx.createClock();
  const waits = sfx.createWait();
  const vault = sfx.createMemoryVault();
  const store = new SqliteTrainingStore({ path: temp.path, now: () => clock.now() });
  const instance = luoguSourceInstance();
  await store.upsertSourceInstances([instance]);
  const alice = createLuoguAccount(instance, '800001');
  const bob = createLuoguAccount(instance, '800002');
  await store.upsertAccounts([alice, bob]);
  const metadata = sfx.createMetadataAdapter(instance, clock.now);
  const problems = createHostProblemFeed();
  const records = sfx.createRecordFeed();
  const transport: FetchLike = async (url, init) => {
    return new URL(url).pathname.startsWith('/problem/')
      ? problems.fetchImpl(url, init)
      : records.fetchImpl(url, init);
  };
  const timers = timerSeam();
  const host = createLuoguHost({
    store,
    imports: new ImportService({ store, now: clock.now }),
    sourceInstance: instance,
    metadataSource: metadata.adapter,
    dataDir: temp.dir,
    limits: DEFAULT_PLATFORM_LIMITS,
    ownerId: 'host-fallback-owner',
    onInternalError: () => {},
    seam: {
      vault,
      now: clock.now,
      nowMs: clock.nowMs,
      wait: waits.wait,
      tickIntervalMs: 1_000,
      setInterval: timers.interval,
      transport: { fetchImpl: transport, clock: clock.nowMs, wait: waits.wait, setTimer: sfx.neverFireTimer },
    },
  });
  return {
    temp,
    store,
    instance,
    alice,
    bob,
    host,
    metadata,
    problems,
    token: createCancellationSource().token,
    async disposeStore() {
      await store.close();
      fx.removeDirectory(temp.dir);
    },
  };
}

/** Queue exactly `externalKeys` for one account, preserving every other durable field. */
async function seedHostBacklog(
  world: FallbackHostWorld,
  accountId: string,
  externalKeys: readonly string[],
): Promise<void> {
  const existing = await world.store.getLuoguSyncState(accountId);
  const base = existing?.value ?? emptyLuoguSyncState(accountId, world.instance.id, fx.AT);
  await world.store.saveLuoguSyncState(
    {
      ...base,
      missingMetadata: externalKeys.map((key) => sfx.problemKeyOf(world.instance, key)),
      updatedAt: fx.AT,
    },
    existing?.revision ?? null,
  );
}

/** The anonymous metadata refusal every fallback of this case starts from. */
function hostAuthWall(detail: string): PlatformError {
  return new PlatformError({ code: 'auth_required', operation: 'problem', retryable: false, detail });
}

void test('the host composes a per-account metadata fallback and re-reads the stored session', async () => {
  const world = await createFallbackHostWorld();
  try {
    await world.host.start(createCancellationSource().token);
    await world.host.service.connect(world.alice.id, sfx.cookieFor('800001', 'alice-first'), world.token);
    await world.host.service.connect(world.bob.id, sfx.cookieFor('800002', 'bob-client'), world.token);
    await seedHostBacklog(world, world.alice.id, ['P900000001']);
    await seedHostBacklog(world, world.bob.id, ['P900000002']);
    // Both anonymous reads are refused with the login wall; only then may the host use a session.
    world.metadata.fail.set('P900000001', hostAuthWall('synthetic login wall'));
    world.metadata.fail.set('P900000002', hostAuthWall('synthetic login wall'));

    assert.equal((await world.host.service.start(world.alice.id, 'metadata')).outcome, 'started');
    await world.host.service.settle();
    const alice = await world.host.service.status(world.alice.id);
    assert.equal(alice.metadataResolved, 1, 'the host fallback resolved the refused key');
    assert.equal(alice.failure, null);
    assert.deepEqual(
      world.problems.calls,
      [{ pid: 'P900000001', cookie: '__client_id=alice-first; _uid=800001' }],
      "the host's fallback reader requested the same pid with alice's own stored session",
    );
    assert.ok(await world.store.getProblem(sfx.problemKeyOf(world.instance, 'P900000001')));

    // Account isolation: bob's run uses bob's stored session for bob's pid, never alice's.
    assert.equal((await world.host.service.start(world.bob.id, 'metadata')).outcome, 'started');
    await world.host.service.settle();
    const bob = await world.host.service.status(world.bob.id);
    assert.equal(bob.metadataResolved, 1);
    assert.deepEqual(
      world.problems.calls.map((call) => call.cookie),
      ['__client_id=alice-first; _uid=800001', '__client_id=bob-client; _uid=800002'],
      'each account request carries exactly its own stored session',
    );
    assert.deepEqual(world.problems.calls.map((call) => call.pid), ['P900000001', 'P900000002']);

    // A reconnect is observed by the very next fallback: the source re-reads the connection row and
    // the vault on every call instead of caching the previous cookie.
    await world.host.service.connect(world.alice.id, sfx.cookieFor('800001', 'alice-second'), world.token);
    await seedHostBacklog(world, world.alice.id, ['P900000003']);
    world.metadata.fail.set('P900000003', hostAuthWall('synthetic login wall'));
    assert.equal((await world.host.service.start(world.alice.id, 'metadata')).outcome, 'started');
    await world.host.service.settle();
    assert.equal(
      world.problems.calls.at(-1)?.cookie,
      '__client_id=alice-second; _uid=800001',
      'the fresh stored session is used by the next fallback',
    );
    assert.ok(await world.store.getProblem(sfx.problemKeyOf(world.instance, 'P900000003')));
  } finally {
    await world.host.dispose();
    await world.disposeStore();
  }
});
