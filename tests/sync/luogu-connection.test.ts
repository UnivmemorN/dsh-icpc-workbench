/**
 * Luogu connection manager adapter (Sprint 17c2).
 *
 * These cases drive the real Sprint 17c1 SQLite connection store, the real Sprint 17a
 * authenticated reader (over a synthetic `/record/list` feed) and an in-memory credential vault.
 * They pin the behaviour that matters externally: a session is tested before anything is replaced,
 * a fresh reference is persisted before the previous secret is deleted, a failure never discards
 * the previous usable connection, cleanup failures stay visible and recoverable, `probe` records
 * only a safe observed status, `forget` is CAS-guarded and account-scoped, and an unsupported
 * platform stays honest instead of pretending to work.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { createLuoguAccount } from '../../src/adapters/luogu/account.js';
import {
  createLuoguConnectionManager,
  createStoredLuoguSessionProvider,
  type LuoguConnectionAdapter,
} from '../../src/adapters/luogu/connection.js';
import { LuoguConnectionError } from '../../src/application/luogu-connection.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import { DEFAULT_PLATFORM_LIMITS } from '../../src/application/ports.js';
import { createCancellationSource, DomainError, type Account, type CancellationToken, type SourceInstance } from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';
import {
  buildRecords,
  cookieFor,
  createClock,
  createMemoryVault,
  createRecordFeed,
  createWait,
  htmlResponse,
  neverFireTimer,
  officialInstance,
  toPages,
  type MemoryVault,
  type RecordFeed,
  type TestClock,
  type Waits,
} from './fixtures.js';

/** Limits that keep the synthetic transport deterministic and retry-free. */
const LIMITS = {
  ...DEFAULT_PLATFORM_LIMITS,
  minRequestIntervalMs: 0,
  requestTimeoutMs: 5_000,
  maxRetries: 0,
  pageSize: 50,
  maxConcurrency: 1,
};

interface World {
  readonly store: SqliteTrainingStore;
  readonly paths: { readonly path: string; readonly dir: string };
  readonly clock: TestClock;
  readonly waits: Waits;
  readonly vault: MemoryVault;
  readonly feed: RecordFeed;
  readonly instance: SourceInstance;
  readonly alice: Account;
  readonly bob: Account;
  readonly connections: LuoguConnectionAdapter;
  /** Build a fresh adapter over the same store and vault: the in-process equivalent of a restart. */
  restartConnections(): LuoguConnectionAdapter;
  readonly token: CancellationToken;
  dispose(): Promise<void>;
}

async function createWorld(options: { readonly implemented?: boolean } = {}): Promise<World> {
  const paths = fx.tempDatabase();
  const clock = createClock();
  const waits = createWait();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock.now() });
  const instance = officialInstance();
  await store.upsertSourceInstances([instance]);
  const alice = createLuoguAccount(instance, '100001');
  const bob = createLuoguAccount(instance, '100002');
  await store.upsertAccounts([alice, bob]);
  const vault = createMemoryVault(options.implemented === undefined ? {} : { implemented: options.implemented });
  const feed = createRecordFeed();
  feed.pages.set(alice.handle, toPages(buildRecords(3, ['P1000', 'P1001'])));
  let references = 0;
  const makeConnections = (): LuoguConnectionAdapter =>
    createLuoguConnectionManager({
      store,
      vault,
      sourceInstance: instance,
      now: () => clock.now(),
      newReference: () => `luogu.session.${(references += 1)}`,
      limits: LIMITS,
      transport: { fetchImpl: feed.fetchImpl, clock: () => clock.nowMs(), wait: waits.wait, setTimer: neverFireTimer },
    });
  const connections = makeConnections();
  return {
    store,
    paths,
    clock,
    waits,
    vault,
    feed,
    instance,
    alice,
    bob,
    connections,
    restartConnections: makeConnections,
    token: createCancellationSource().token,
    async dispose() {
      await store.close();
      fx.removeDirectory(paths.dir);
    },
  };
}

function isConnectionError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof LuoguConnectionError && error.code === code;
}

void test('connect tests the session through a real reader page, stores a fresh reference and survives a restart', async () => {
  const world = await createWorld();
  try {
    const first = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'first-client'),
      token: world.token,
    });
    assert.equal(first.state.status, 'connected');
    assert.equal(first.state.failureCode, null);
    assert.equal(first.state.staleReference, null);
    assert.ok(first.state.reference.startsWith('luogu.session.'));
    assert.equal(world.vault.secrets.get(first.state.reference), cookieFor('100001', 'first-client'));
    // The validation page really travelled with the supplied cookie.
    assert.ok(world.feed.calls.length >= 1);
    assert.match(world.feed.calls[0]?.cookie ?? '', /_uid=100001/);
    assert.match(world.feed.calls[0]?.cookie ?? '', /__client_id=first-client/);

    const second = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'second-client'),
      token: world.token,
    });
    assert.notEqual(second.state.reference, first.state.reference);
    assert.equal(second.state.staleReference, null);
    assert.equal(world.vault.secrets.has(first.state.reference), false, 'the previous secret was deleted');
    assert.equal(world.vault.secrets.size, 1);
    // Two writes: the new reference is persisted first (with the old one marked stale) and the
    // clearing write follows the successful removal.
    const storedConnection = await world.store.getLuoguConnection(world.alice.id);
    assert.equal(storedConnection?.value.reference, second.state.reference);
    assert.equal(storedConnection?.value.staleReference, null);
    assert.equal(storedConnection?.revision, 3);

    // A second store opened on the same file sees the persisted reference.
    const reopened = new SqliteTrainingStore({ path: world.paths.path });
    try {
      assert.equal(
        (await reopened.getLuoguConnection(world.alice.id))?.value.reference,
        second.state.reference,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await world.dispose();
  }
});

void test('a rejected session leaves the previous connection and its credential untouched', async () => {
  const world = await createWorld();
  try {
    const good = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001'),
      token: world.token,
    });
    const writesBefore = world.vault.writes.length;
    await assert.rejects(
      world.connections.connect({
        accountId: world.alice.id,
        // A cookie of another account must never replace this account's session.
        sessionCookie: cookieFor('100002'),
        token: world.token,
      }),
      (error: unknown) =>
        error instanceof LuoguConnectionError &&
        error.code === 'not_connected' &&
        error.details['failureCode'] === 'invalid_input',
    );
    assert.equal((await world.store.getLuoguConnection(world.alice.id))?.value.reference, good.state.reference);
    assert.equal(world.vault.writes.length, writesBefore, 'nothing was written to the vault');
    assert.equal(world.vault.secrets.size, 1);
  } finally {
    await world.dispose();
  }
});

void test('a compare-and-set loss keeps the old connection and removes only the fresh reference', async () => {
  const world = await createWorld();
  try {
    const good = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'first-client'),
      token: world.token,
    });
    world.vault.beforeWrite = async () => {
      world.vault.beforeWrite = null;
      // Another writer replaces the row while this connect is validating its cookie.
      const current = await world.store.getLuoguConnection(world.alice.id);
      await world.store.saveLuoguConnection(
        { ...current!.value, checkedAt: '2026-09-12T08:05:00.000Z' },
        current!.revision,
      );
    };
    await assert.rejects(
      world.connections.connect({
        accountId: world.alice.id,
        sessionCookie: cookieFor('100001', 'second-client'),
        token: world.token,
      }),
      isConnectionError('busy'),
    );
    const stored = await world.store.getLuoguConnection(world.alice.id);
    assert.equal(stored?.value.reference, good.state.reference, 'the previous connection stayed');
    assert.equal(stored?.value.checkedAt, '2026-09-12T08:05:00.000Z');
    assert.equal(world.vault.secrets.size, 1);
    assert.equal(world.vault.secrets.has(good.state.reference), true);
    assert.equal(world.vault.writes.length, 2, 'the fresh reference was written');
    assert.equal(world.vault.removals.length, 1, 'and cleaned up again');
  } finally {
    await world.dispose();
  }
});

void test('a failed previous-secret cleanup keeps the new connection usable and visible until a probe retries it', async () => {
  const world = await createWorld();
  try {
    const first = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'first-client'),
      token: world.token,
    });
    world.vault.failRemove.add(first.state.reference);
    const second = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'second-client'),
      token: world.token,
    });
    assert.equal(second.state.status, 'connected');
    assert.equal(second.state.staleReference, first.state.reference);
    assert.equal(world.vault.secrets.has(first.state.reference), true, 'the leftover is still present');
    assert.equal(world.vault.secrets.has(second.state.reference), true);
    assert.equal(
      (await world.store.getLuoguConnection(world.alice.id))?.value.staleReference,
      first.state.reference,
      'the leftover is recorded durably',
    );

    world.vault.failRemove.clear();
    const probed = await world.connections.probe(world.alice.id, world.token);
    assert.equal(probed.state.status, 'connected');
    assert.equal(probed.state.staleReference, null, 'the retry cleared the marker');
    assert.equal(world.vault.secrets.has(first.state.reference), false);
    assert.equal(world.vault.secrets.size, 1);
  } finally {
    await world.dispose();
  }
});

void test('probe persists only safe observed statuses and never echoes provider text', async () => {
  const world = await createWorld();
  try {
    const connected = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001'),
      token: world.token,
    });

    // A session that vanished from the vault is an authentication wall, without any request.
    world.vault.secrets.delete(connected.state.reference);
    const expired = await world.connections.probe(world.alice.id, world.token);
    assert.equal(expired.state.status, 'session_expired');
    assert.equal(expired.state.failureCode, 'auth_required');
    assert.equal(expired.state.reference, connected.state.reference, 'the reference is kept so it can be replaced');

    // An HTML answer this build no longer understands is a shape problem, not an empty history.
    world.vault.secrets.set(connected.state.reference, cookieFor('100001'));
    world.feed.override = () => htmlResponse('<html><body>not a record list</body></html>');
    const changed = await world.connections.probe(world.alice.id, world.token);
    assert.equal(changed.state.status, 'schema_changed');
    assert.equal(changed.state.failureCode, 'changed_response');

    // A hostile provider error carrying the cookie must not surface anywhere.
    world.feed.override = () => {
      throw new Error(`a hostile transport said ${cookieFor('100001', 'SECRETMARKER')}`);
    };
    const failed = await world.connections.probe(world.alice.id, world.token);
    assert.equal(failed.state.status, 'unavailable');
    assert.equal(failed.state.failureCode, 'unavailable');
    assert.equal(JSON.stringify(failed.state).includes('SECRETMARKER'), false);
    assert.equal(JSON.stringify(failed).includes('SECRETMARKER'), false);
  } finally {
    await world.dispose();
  }
});

void test('forget is CAS-guarded, account-scoped and idempotent', async () => {
  const world = await createWorld();
  try {
    const alice = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001'),
      token: world.token,
    });
    const bob = await world.connections.connect({
      accountId: world.bob.id,
      sessionCookie: cookieFor('100002'),
      token: world.token,
    });

    await world.connections.forget(world.alice.id, world.token);
    assert.equal(await world.store.getLuoguConnection(world.alice.id), null);
    assert.equal(world.vault.secrets.has(alice.state.reference), false);
    assert.equal(world.vault.secrets.has(bob.state.reference), true, "another account's secret is untouched");
    assert.equal((await world.store.getLuoguConnection(world.bob.id))?.value.reference, bob.state.reference);
    // Forgetting again is a successful no-op.
    await world.connections.forget(world.alice.id, world.token);

    // A row replaced between the read and the delete is refused, and the retry then succeeds.
    await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001'),
      token: world.token,
    });
    world.vault.beforeRemove = async () => {
      world.vault.beforeRemove = null;
      const current = await world.store.getLuoguConnection(world.alice.id);
      await world.store.saveLuoguConnection(
        { ...current!.value, checkedAt: '2026-09-12T08:09:00.000Z' },
        current!.revision,
      );
    };
    await assert.rejects(world.connections.forget(world.alice.id, world.token), isConnectionError('busy'));
    assert.notEqual(await world.store.getLuoguConnection(world.alice.id), null, 'the replaced row stayed');
    await world.connections.forget(world.alice.id, world.token);
    assert.equal(await world.store.getLuoguConnection(world.alice.id), null);
  } finally {
    await world.dispose();
  }
});

void test('an unsupported platform stays honest and constructible', async () => {
  const world = await createWorld({ implemented: false });
  try {
    assert.equal(world.connections.capabilities().implemented, false);
    assert.equal(world.connections.capabilities().platform, 'win32');
    await assert.rejects(
      world.connections.connect({
        accountId: world.alice.id,
        sessionCookie: cookieFor('100001'),
        token: world.token,
      }),
      isConnectionError('unsupported'),
    );
    await assert.rejects(world.connections.probe(world.alice.id, world.token), isConnectionError('unsupported'));
    await assert.rejects(world.connections.forget(world.alice.id, world.token), isConnectionError('unsupported'));

    // The stored-session provider answers with a fixed typed authentication error.
    const provider = createStoredLuoguSessionProvider({ store: world.store, vault: world.vault });
    await assert.rejects(
      provider.sessionFor(world.alice, world.token),
      (error: unknown) => error instanceof PlatformError && error.code === 'auth_required',
    );
  } finally {
    await world.dispose();
  }
});

void test('the stored-session provider re-reads the current connection and vault on every call', async () => {
  const world = await createWorld();
  try {
    const connected = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001'),
      token: world.token,
    });
    const provider = createStoredLuoguSessionProvider({ store: world.store, vault: world.vault });
    assert.deepEqual(await provider.sessionFor(world.alice, world.token), {
      uid: '100001',
      cookie: cookieFor('100001'),
    });

    // A rotation outside this provider is observed on the next call.
    world.vault.secrets.set(connected.state.reference, 'rotated-cookie');
    assert.deepEqual(await provider.sessionFor(world.alice, world.token), { uid: '100001', cookie: 'rotated-cookie' });

    // A vanished secret is an authentication wall.
    world.vault.secrets.delete(connected.state.reference);
    await assert.rejects(
      provider.sessionFor(world.alice, world.token),
      (error: unknown) => error instanceof PlatformError && error.code === 'auth_required',
    );

    // A connection already observed as non-connected is refused before the vault is consulted.
    world.vault.secrets.set(connected.state.reference, cookieFor('100001'));
    const record = await world.store.getLuoguConnection(world.alice.id);
    await world.store.saveLuoguConnection(
      { ...record!.value, status: 'session_expired', failureCode: 'auth_required' },
      record!.revision,
    );
    await assert.rejects(
      provider.sessionFor(world.alice, world.token),
      (error: unknown) => error instanceof PlatformError && error.code === 'auth_required',
    );
  } finally {
    await world.dispose();
  }
});

void test('a crash between the vault write and the link leaves a journaled reference the next operation cleans', async () => {
  const world = await createWorld();
  try {
    const first = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001'),
      token: world.token,
    });
    // Exactly what a process death after the vault write and before the link leaves behind: the
    // write-ahead journal entry is durable, the credential exists, and no row points at it.
    await world.store.appendLuoguConnectionJournal(world.alice.id, 'luogu.session.orphan');
    world.vault.secrets.set('luogu.session.orphan', cookieFor('100001'));
    assert.equal((await world.store.listLuoguConnectionJournal(world.alice.id)).length, 1);

    const restarted = world.restartConnections();
    const probed = await restarted.probe(world.alice.id, world.token);
    assert.equal(probed.state.status, 'connected', 'the previous usable connection survived the crash');
    assert.equal(probed.state.reference, first.state.reference);
    assert.equal(world.vault.secrets.has('luogu.session.orphan'), false, 'the orphaned credential was removed');
    assert.deepEqual(
      await world.store.listLuoguConnectionJournal(world.alice.id),
      [],
      'the journal entry was retired after the removal',
    );
  } finally {
    await world.dispose();
  }
});

void test('journal recovery never deletes a credential the connection row already adopted', async () => {
  const world = await createWorld();
  try {
    const connected = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001'),
      token: world.token,
    });
    // The other crash boundary: the row was saved but its journal entry was never retired.
    await world.store.appendLuoguConnectionJournal(world.alice.id, connected.state.reference);

    const restarted = world.restartConnections();
    const probed = await restarted.probe(world.alice.id, world.token);
    assert.equal(probed.state.status, 'connected');
    assert.equal(
      world.vault.secrets.has(connected.state.reference),
      true,
      'recovery must never remove the credential of the current connection',
    );
    assert.deepEqual(await world.store.listLuoguConnectionJournal(world.alice.id), []);
  } finally {
    await world.dispose();
  }
});

void test('a vault write that commits and then fails is compensated, leaving no unreachable credential', async () => {
  const world = await createWorld();
  try {
    const good = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'first-client'),
      token: world.token,
    });
    let committed: string | null = null;
    world.vault.beforeWrite = (reference, secret) => {
      world.vault.beforeWrite = null;
      committed = reference;
      // The credential store persisted the entry and only then reported a failure.
      world.vault.secrets.set(reference, secret);
      world.vault.writes.push(reference);
      throw new Error('the credential store committed and then failed');
    };

    await assert.rejects(
      world.connections.connect({
        accountId: world.alice.id,
        sessionCookie: cookieFor('100001', 'second-client'),
        token: world.token,
      }),
      isConnectionError('not_connected'),
    );
    assert.notEqual(committed, null);
    assert.equal(world.vault.secrets.has(committed!), false, 'the possibly-committed secret was removed again');
    assert.deepEqual(
      await world.store.listLuoguConnectionJournal(world.alice.id),
      [],
      'the journal entry was retired after the compensation',
    );
    const stored = await world.store.getLuoguConnection(world.alice.id);
    assert.equal(stored?.value.reference, good.state.reference, 'the previous usable connection is untouched');
    assert.equal((await world.connections.probe(world.alice.id, world.token)).state.status, 'connected');
  } finally {
    await world.dispose();
  }
});

void test('a CAS loss whose cleanup also fails keeps the orphan journaled and recoverable', async () => {
  const world = await createWorld();
  try {
    const good = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'first-client'),
      token: world.token,
    });
    let fresh: string | null = null;
    world.vault.beforeWrite = async (reference) => {
      world.vault.beforeWrite = null;
      fresh = reference;
      // Nothing can remove this reference during the compensation either.
      world.vault.failRemove.add(reference);
      // Another writer replaces the row while this connect is storing its fresh credential.
      const current = await world.store.getLuoguConnection(world.alice.id);
      await world.store.saveLuoguConnection(
        { ...current!.value, checkedAt: '2026-09-12T08:05:00.000Z' },
        current!.revision,
      );
    };

    await assert.rejects(
      world.connections.connect({
        accountId: world.alice.id,
        sessionCookie: cookieFor('100001', 'second-client'),
        token: world.token,
      }),
      isConnectionError('busy'),
    );
    assert.notEqual(fresh, null);
    assert.equal(world.vault.secrets.has(fresh!), true, 'the fresh secret could not be removed');
    assert.deepEqual(
      (await world.store.listLuoguConnectionJournal(world.alice.id)).map((entry) => entry.reference),
      [fresh!],
      'and it stays journaled, so it is still tracked after the failed cleanup',
    );
    const stored = await world.store.getLuoguConnection(world.alice.id);
    assert.equal(stored?.value.reference, good.state.reference, 'the previous connection row is untouched');
    assert.equal(stored?.value.checkedAt, '2026-09-12T08:05:00.000Z');

    // Once the vault lets go, the next operation recovers the orphan without touching the current
    // connection's own credential.
    world.vault.failRemove.clear();
    const restarted = world.restartConnections();
    const probed = await restarted.probe(world.alice.id, world.token);
    assert.equal(probed.state.status, 'connected');
    assert.equal(world.vault.secrets.has(fresh!), false, 'the orphan was removed');
    assert.equal(world.vault.secrets.has(good.state.reference), true, 'the current credential was never touched');
    assert.deepEqual(await world.store.listLuoguConnectionJournal(world.alice.id), []);
  } finally {
    await world.dispose();
  }
});

void test('connect refuses to report a connected session when the stored row was removed or replaced', async () => {
  const world = await createWorld();
  try {
    await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001'),
      token: world.token,
    });

    // Removed between the successful save and the final read.
    world.vault.beforeRemove = async () => {
      world.vault.beforeRemove = null;
      const current = await world.store.getLuoguConnection(world.alice.id);
      await world.store.deleteLuoguConnection(world.alice.id, current!.revision);
    };
    await assert.rejects(
      world.connections.connect({
        accountId: world.alice.id,
        sessionCookie: cookieFor('100001', 'second-client'),
        token: world.token,
      }),
      isConnectionError('busy'),
      'a removed row must be refused instead of answered from memory',
    );
    assert.equal(await world.store.getLuoguConnection(world.alice.id), null);
    const orphaned = await world.store.listLuoguConnectionJournal(world.alice.id);
    assert.equal(orphaned.length, 1, 'the unlinked credential stays journaled for recovery');
    assert.equal(world.vault.secrets.has(orphaned[0]!.reference), true);

    // Replaced between the successful save and the final read: the other session must stay.
    await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'third-client'),
      token: world.token,
    });
    world.vault.beforeRemove = async () => {
      world.vault.beforeRemove = null;
      const current = await world.store.getLuoguConnection(world.alice.id);
      await world.store.saveLuoguConnection(
        { ...current!.value, reference: 'luogu.session.replacement' },
        current!.revision,
      );
    };
    await assert.rejects(
      world.connections.connect({
        accountId: world.alice.id,
        sessionCookie: cookieFor('100001', 'fourth-client'),
        token: world.token,
      }),
      isConnectionError('busy'),
      'a replaced row must be refused instead of answered from memory',
    );
    const stored = await world.store.getLuoguConnection(world.alice.id);
    assert.equal(stored?.value.reference, 'luogu.session.replacement', 'the concurrent replacement stayed');
    const tracked = await world.store.listLuoguConnectionJournal(world.alice.id);
    assert.equal(tracked.length, 1, 'the credential that no row addresses is journaled again');
    assert.equal(world.vault.secrets.has(tracked[0]!.reference), true);
  } finally {
    await world.dispose();
  }
});

void test('forget also removes journaled references and never reissues a deleted connection revision', async () => {
  const world = await createWorld();
  try {
    await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'first-client'),
      token: world.token,
    });
    const firstRecord = await world.store.getLuoguConnection(world.alice.id);
    // An orphan left by an interrupted connect is addressed by forget as well.
    await world.store.appendLuoguConnectionJournal(world.alice.id, 'luogu.session.orphan');
    world.vault.secrets.set('luogu.session.orphan', cookieFor('100001'));

    await world.connections.forget(world.alice.id, world.token);
    assert.equal(await world.store.getLuoguConnection(world.alice.id), null);
    assert.deepEqual(await world.store.listLuoguConnectionJournal(world.alice.id), []);
    assert.equal(world.vault.secrets.size, 0, 'both the row credential and the orphan were removed');

    // The next connection continues the revision sequence, so a disconnect prepared against
    // revision 1 can neither update nor delete it.
    const reconnected = await world.connections.connect({
      accountId: world.alice.id,
      sessionCookie: cookieFor('100001', 'second-client'),
      token: world.token,
    });
    const recreated = await world.store.getLuoguConnection(world.alice.id);
    assert.ok(recreated!.revision > firstRecord!.revision, 'the revision grew across the delete');
    await assert.rejects(
      world.store.saveLuoguConnection({ ...recreated!.value, checkedAt: '2026-09-12T08:09:00.000Z' }, firstRecord!.revision),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_transition',
    );
    await assert.rejects(
      world.store.deleteLuoguConnection(world.alice.id, firstRecord!.revision),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_transition',
    );
    assert.equal((await world.store.getLuoguConnection(world.alice.id))?.value.reference, reconnected.state.reference);
    await world.connections.forget(world.alice.id, world.token);
    assert.equal(await world.store.getLuoguConnection(world.alice.id), null);
  } finally {
    await world.dispose();
  }
});
