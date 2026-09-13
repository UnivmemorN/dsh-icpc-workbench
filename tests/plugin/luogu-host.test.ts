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
import { ImportService } from '../../src/application/import-service.js';
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
