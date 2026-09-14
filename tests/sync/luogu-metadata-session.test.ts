/**
 * Account-scoped authenticated metadata fallback (Sprint 30b).
 *
 * Every case drives the real synchronization service against a real temporary SQLite store, the real
 * Sprint 17c1 state rows, the real connection manager/vault, the **real** Sprint 30a authenticated
 * problem reader (`createLuoguProblemSessionSource`) over a synthetic `/problem/<pid>` feed and the
 * real stored-session provider. The assertions describe externally meaningful consequences: which
 * request was dispatched with which account's session, whether the factory was consulted at all,
 * exactly which key left the durable backlog, what the per-key diagnostic records, and what a
 * cancellation or a lease takeover leaves behind. No real credential, socket, model or paid API is
 * involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLuoguAccount,
  createLuoguConnectionManager,
  createLuoguProblemSessionSource,
  createStoredLuoguSessionProvider,
  createStoredSubmissionsSource,
  type LuoguConnectionAdapter,
} from '../../src/adapters/luogu/index.js';
import type { FetchInitLike, FetchLike, FetchResponseLike } from '../../src/adapters/platform/http.js';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import { createLuoguSourceGate, type LuoguSourceGate } from '../../src/application/luogu-source-gate.js';
import { LuoguSyncService } from '../../src/application/luogu-sync-service.js';
import { emptyLuoguSyncState } from '../../src/application/luogu-sync-types.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformLimits, type ProblemMetadataSource } from '../../src/application/ports.js';
import {
  DomainError,
  createCancellationSource,
  type Account,
  type CancellationToken,
  type SourceInstance,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';
import {
  buildProblemKeys,
  cookieFor,
  createClock,
  createMemoryVault,
  createMetadataAdapter,
  createRecordFeed,
  createWait,
  jsonResponse,
  neverFireTimer,
  officialInstance,
  problemKeyOf,
  until,
  type MetadataHarness,
  type MemoryVault,
  type TestClock,
  type Waits,
} from './fixtures.js';

/** Deterministic, retry-free transport limits. */
const LIMITS: PlatformLimits = {
  ...DEFAULT_PLATFORM_LIMITS,
  minRequestIntervalMs: 0,
  requestTimeoutMs: 5_000,
  maxRetries: 0,
  pageSize: 50,
  maxConcurrency: 1,
};

/** One observed authenticated problem request: the pid it addressed and the cookie it carried. */
interface AuthFeedCall {
  readonly pid: string;
  readonly cookie: string | null;
}

/** Synthetic `/problem/<pid>` feed of the authenticated reader. */
interface AuthFeed {
  readonly fetchImpl: FetchLike;
  readonly calls: AuthFeedCall[];
  /** Pids whose authenticated answer is the platform's body-level 401 (the session is not accepted). */
  readonly refuse: Set<string>;
}

/** A valid problem detail payload the real parser accepts. */
function problemPayload(pid: string): unknown {
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

function createAuthFeed(): AuthFeed {
  const calls: AuthFeedCall[] = [];
  const refuse = new Set<string>();
  const fetchImpl: FetchLike = async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    const parsed = new URL(url);
    const pid = decodeURIComponent(parsed.pathname.replace('/problem/', ''));
    calls.push({ pid, cookie: init.headers['cookie'] ?? null });
    if (refuse.has(pid)) {
      return jsonResponse({ data: { errorCode: 401, errorType: 'Unauthorized' } });
    }
    return jsonResponse(problemPayload(pid));
  };
  return { fetchImpl, calls, refuse };
}

/** The one anonymous metadata refusal every fallback case starts from. */
function authWall(detail: string): PlatformError {
  return new PlatformError({ code: 'auth_required', operation: 'problem', retryable: false, detail });
}

interface FallbackWorld {
  readonly store: SqliteTrainingStore;
  readonly paths: { readonly path: string; readonly dir: string };
  readonly clock: TestClock;
  readonly waits: Waits;
  readonly vault: MemoryVault;
  readonly metadata: MetadataHarness;
  readonly auth: AuthFeed;
  readonly instance: SourceInstance;
  readonly alice: Account;
  readonly bob: Account;
  readonly connections: LuoguConnectionAdapter;
  readonly gate: LuoguSourceGate;
  readonly token: CancellationToken;
  readonly factoryCalls: () => readonly Account[];
  makeService(ownerId: string, options?: { readonly authenticated?: boolean; readonly factory?: (account: Account) => ProblemMetadataSource }): LuoguSyncService;
  dispose(): Promise<void>;
}

async function createFallbackWorld(): Promise<FallbackWorld> {
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
  const metadata = createMetadataAdapter(instance, () => clock.now());
  const auth = createAuthFeed();
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
  const sessions = createStoredLuoguSessionProvider({ store, vault });
  const sources = new Map<string, ProblemMetadataSource>();
  const factoryCalls: Account[] = [];
  /** Same composition discipline as the host: one cached source per account, session re-read per call. */
  const sourceFor = (account: Account): ProblemMetadataSource => {
    factoryCalls.push(account);
    const existing = sources.get(account.id);
    if (existing !== undefined) {
      return existing;
    }
    const source = createLuoguProblemSessionSource({
      sourceInstance: instance,
      account,
      sessions,
      fetchImpl: auth.fetchImpl,
      clock: () => clock.nowMs(),
      wait: waits.wait,
      setTimer: neverFireTimer,
    });
    sources.set(account.id, source);
    return source;
  };
  const services: LuoguSyncService[] = [];
  return {
    store,
    paths,
    clock,
    waits,
    vault,
    metadata,
    auth,
    instance,
    alice,
    bob,
    connections,
    gate,
    token: createCancellationSource().token,
    factoryCalls: () => factoryCalls,
    makeService(ownerId: string, options: { readonly authenticated?: boolean; readonly factory?: (account: Account) => ProblemMetadataSource } = {}) {
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
        ...(options.authenticated === false ? {} : { authenticatedMetadataFor: options.factory ?? sourceFor }),
        ownerId,
        now: () => clock.now(),
        wait: waits.wait,
        gate,
        limits: LIMITS,
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

/** Seed one account's backlog, preserving every other durable field and its revision. */
async function seedBacklog(world: FallbackWorld, accountId: string, externalKeys: readonly string[]): Promise<void> {
  const existing = await world.store.getLuoguSyncState(accountId);
  const base = existing?.value ?? emptyLuoguSyncState(accountId, world.instance.id, fx.AT);
  await world.store.saveLuoguSyncState(
    {
      ...base,
      missingMetadata: buildProblemKeys(world.instance, externalKeys),
      updatedAt: fx.AT,
    },
    existing?.revision ?? null,
  );
}

/** A manually released gate, used to park one gate operation before its work callback. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Park the `nth` source-gate operation before it runs, so a test can race its durable claim. */
function parkNthGate(
  world: FallbackWorld,
  nth: number,
): { readonly release: () => void; readonly parked: () => number } {
  const gate = deferred();
  const originalRun = world.gate.run.bind(world.gate);
  let parked = 0;
  const run = async (
    token: CancellationToken,
    work: (token: CancellationToken) => Promise<unknown>,
  ): Promise<unknown> => {
    parked += 1;
    if (parked === nth) {
      await gate.promise;
    }
    return originalRun(token, work);
  };
  world.gate.run = run as LuoguSourceGate['run'];
  return { release: gate.release, parked: () => parked };
}

void test('an anonymous success never consults the authenticated factory', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-anon-ok');
    await seedBacklog(world, world.alice.id, ['P900000001']);
    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.equal(status.metadataResolved, 1);
    assert.equal(status.metadataBacklog, 0);
    assert.equal(status.failure, null);
    assert.deepEqual(world.factoryCalls(), [], 'the factory is not even consulted for a success');
    assert.deepEqual(world.auth.calls, [], 'no authenticated request is dispatched');
  } finally {
    await world.dispose();
  }
});

void test('an auth_required retry falls back once to the same account and pid and commits one dequeue', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-retry-fallback');
    await service.connect(world.alice.id, cookieFor('100001', 'alice-client'), world.token);
    const key = problemKeyOf(world.instance, 'P900000001');
    const sibling = problemKeyOf(world.instance, 'P900000002');
    await seedBacklog(world, world.alice.id, ['P900000001', 'P900000002']);
    world.metadata.fail.set('P900000001', authWall('the anonymous metadata read was asked to log in'));

    const result = await service.retryMetadata(world.alice.id, key, world.token);
    assert.equal(result.outcome, 'resolved');
    assert.equal(result.failureCode, null);
    assert.equal(result.reason, null);
    assert.deepEqual(world.metadata.calls, ['P900000001'], 'the anonymous read is attempted exactly once');
    assert.equal(world.auth.calls.length, 1, 'exactly one authenticated attempt is made');
    assert.equal(world.auth.calls[0]?.pid, 'P900000001', 'the same problem id is requested');
    assert.equal(
      world.auth.calls[0]?.cookie,
      '__client_id=alice-client; _uid=100001',
      "only the account's own session travels",
    );
    assert.deepEqual(
      world.factoryCalls().map((account) => account.id),
      [world.alice.id],
      'the factory is consulted for exactly this account',
    );
    const after = (await world.store.getLuoguSyncState(world.alice.id))!.value;
    assert.deepEqual(after.missingMetadata, [sibling], 'only the addressed key leaves the queue');
    assert.equal(after.metadataResolved, 1, 'the final outcome counts exactly once');
    assert.equal(after.metadataFailed, 0, 'the intermediate anonymous refusal is not stored as a failure');
    assert.equal(after.failure, null);
    assert.equal(after.owner, null, 'the retry released its lease');
    const stored = await world.store.getProblem(key);
    assert.ok(stored, 'the authenticated answer is stored as the problem row');
    assert.equal(stored?.statement !== null, true);
    assert.equal(world.metadata.editorialCalls(), 0, 'no editorial material is ever requested');
  } finally {
    await world.dispose();
  }
});

void test('the bulk drain uses the same fallback for a T key and resolves it once', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-bulk-fallback');
    await service.connect(world.alice.id, cookieFor('100001', 'bulk-client'), world.token);
    await seedBacklog(world, world.alice.id, ['T900000001', 'P900000002']);
    world.metadata.fail.set('T900000001', authWall('the anonymous metadata read was asked to log in'));

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.deepEqual(world.metadata.calls, ['T900000001', 'P900000002'], 'the refused T key does not stop the drain');
    assert.deepEqual(
      world.auth.calls.map((call) => call.pid),
      ['T900000001'],
      'the fallback is bounded to one attempt for the refused key',
    );
    assert.equal(world.auth.calls[0]?.cookie, '__client_id=bulk-client; _uid=100001');
    assert.equal(status.metadataResolved, 2, 'both keys are resolved exactly once');
    assert.equal(status.metadataFailed, 0);
    assert.equal(status.metadataBacklog, 0);
    assert.equal(status.failure, null);
    assert.equal(status.paused, false);
    assert.ok(await world.store.getProblem(problemKeyOf(world.instance, 'T900000001')));
  } finally {
    await world.dispose();
  }
});

void test('a final auth refusal of a T key is a failure with an honest per-key issue, not a deferral', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-final-auth-retry');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    const key = problemKeyOf(world.instance, 'T900000003');
    await seedBacklog(world, world.alice.id, ['T900000003', 'P900000004']);
    world.metadata.fail.set('T900000003', authWall('the anonymous metadata read was asked to log in'));
    world.auth.refuse.add('T900000003');

    const result = await service.retryMetadata(world.alice.id, key, world.token);
    assert.equal(result.outcome, 'failed', 'an auth wall that survives the fallback is not a deferred item');
    assert.equal(result.failureCode, 'auth_required');
    assert.equal(result.reason, null);
    assert.equal(world.auth.calls.length, 1, 'the final refusal is the fallback attempt itself');
    const after = (await world.store.getLuoguSyncState(world.alice.id))!.value;
    assert.deepEqual(after.missingMetadata, [key, problemKeyOf(world.instance, 'P900000004')]);
    assert.equal(after.metadataResolved, 0);
    assert.equal(after.metadataFailed, 1, 'the refused key counts exactly one failed attempt');
    assert.equal(after.failure?.code, 'auth_required');
    assert.equal(after.failure?.paused, true, 'automatic attempts pause as the auth code requires');
    assert.equal(after.failure?.problemKey, key);
    assert.equal(after.metadataIssues?.[0]?.code, 'auth_required');
    assert.equal(after.metadataIssues?.[0]?.reason, null, 'no reason is invented for a code-only refusal');
    assert.equal(await world.store.getProblem(key), null);
  } finally {
    await world.dispose();
  }
});

void test('a bulk drain stops at a final auth refusal for a U key and keeps every queued key', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-final-auth-bulk');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    await seedBacklog(world, world.alice.id, ['U900000005', 'P900000006']);
    world.metadata.fail.set('U900000005', authWall('the anonymous metadata read was asked to log in'));
    world.auth.refuse.add('U900000005');

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await service.settle();
    const status = await service.status(world.alice.id);
    assert.deepEqual(world.metadata.calls, ['U900000005'], 'the pass stops instead of deferring the key');
    assert.deepEqual(world.auth.calls.map((call) => call.pid), ['U900000005']);
    assert.equal(status.metadataResolved, 0);
    assert.equal(status.metadataFailed, 1);
    assert.equal(status.metadataBacklog, 2, 'no queued key is dropped when the pass stops');
    assert.equal(status.failure?.code, 'auth_required');
    assert.equal(status.failure?.stage, 'metadata');
    assert.equal(status.paused, true);
    const state = (await world.store.getLuoguSyncState(world.alice.id))!.value;
    assert.equal(state.metadataIssues?.[0]?.code, 'auth_required');
    assert.equal(state.metadataIssues?.[0]?.reason, null);
  } finally {
    await world.dispose();
  }
});

void test('a forbidden refusal is item-scoped, continues the drain and never consults the factory', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-forbidden');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    const key = problemKeyOf(world.instance, 'U900000007');
    await seedBacklog(world, world.alice.id, ['U900000007', 'P900000008']);
    world.metadata.fail.set(
      'U900000007',
      new PlatformError({ code: 'forbidden', operation: 'problem', retryable: false, detail: 'private problem' }),
    );

    const result = await service.retryMetadata(world.alice.id, key, world.token);
    assert.equal(result.outcome, 'deferred', 'a 403 of a private key stays an item-scoped deferral');
    assert.equal(result.failureCode, 'forbidden');
    assert.equal(result.reason, null);
    assert.deepEqual(world.factoryCalls(), [], 'a 403 never triggers the authenticated fallback');
    assert.deepEqual(world.auth.calls, []);
    const after = (await world.store.getLuoguSyncState(world.alice.id))!.value;
    assert.deepEqual(after.missingMetadata, [key, problemKeyOf(world.instance, 'P900000008')]);
    assert.equal(after.metadataFailed, 1);
    assert.equal(after.metadataIssues?.[0]?.code, 'forbidden');
  } finally {
    await world.dispose();
  }
});

void test('an incomplete statement, an HTML challenge and a rate limit never trigger the fallback', async () => {
  const cases = [
    {
      label: 'an incomplete statement',
      error: new PlatformError({
        code: 'changed_response',
        operation: 'problem',
        retryable: false,
        reason: 'missing_statement',
        detail: 'description is blank',
      }),
      outcome: 'deferred' as const,
    },
    {
      label: 'an HTML challenge',
      error: new PlatformError({
        code: 'changed_response',
        operation: 'problem',
        retryable: false,
        reason: 'html_response',
        detail: 'a challenge page answered',
      }),
      outcome: 'failed' as const,
    },
    {
      label: 'a rate limit',
      error: new PlatformError({
        code: 'rate_limited',
        operation: 'problem',
        retryable: true,
        retryAfterMs: 30_000,
        detail: 'slow down',
      }),
      outcome: 'failed' as const,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const world = await createFallbackWorld();
    try {
      const service = world.makeService(`svc-no-fallback-${index}`);
      await service.connect(world.alice.id, cookieFor('100001'), world.token);
      const key = problemKeyOf(world.instance, 'P900000009');
      await seedBacklog(world, world.alice.id, ['P900000009']);
      world.metadata.fail.set('P900000009', entry.error);

      const result = await service.retryMetadata(world.alice.id, key, world.token);
      assert.equal(result.outcome, entry.outcome, `${entry.label} must keep its own outcome`);
      assert.deepEqual(world.factoryCalls(), [], `${entry.label} must not consult the factory`);
      assert.deepEqual(world.auth.calls, [], `${entry.label} must not dispatch an authenticated request`);
      const after = (await world.store.getLuoguSyncState(world.alice.id))!.value;
      assert.deepEqual(after.missingMetadata, [key], `${entry.label} keeps the key queued`);
      assert.equal(after.metadataFailed, 1);
    } finally {
      await world.dispose();
    }
  }
});

void test('the fallback resolves the account of the key and a session-less account stays auth_required', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-account-scope');
    await service.connect(world.alice.id, cookieFor('100001', 'alice-client'), world.token);
    const aliceKey = problemKeyOf(world.instance, 'P900000010');
    const bobKey = problemKeyOf(world.instance, 'P900000011');
    await seedBacklog(world, world.alice.id, ['P900000010']);
    await seedBacklog(world, world.bob.id, ['P900000011']);
    world.metadata.fail.set('P900000010', authWall('login wall for alice'));
    world.metadata.fail.set('P900000011', authWall('login wall for bob'));

    const aliceResult = await service.retryMetadata(world.alice.id, aliceKey, world.token);
    assert.equal(aliceResult.outcome, 'resolved');
    const bobResult = await service.retryMetadata(world.bob.id, bobKey, world.token);
    assert.equal(bobResult.outcome, 'failed', 'bob has no stored session, so the fallback cannot succeed');
    assert.equal(bobResult.failureCode, 'auth_required');
    assert.equal(world.auth.calls.length, 1, 'only the account with a stored session issued a request');
    assert.equal(world.auth.calls[0]?.cookie, '__client_id=alice-client; _uid=100001');
    assert.deepEqual(
      world.factoryCalls().map((account) => account.id),
      [world.alice.id, world.bob.id],
      'each account resolves its own source',
    );
    assert.equal(await world.store.getProblem(bobKey), null);
  } finally {
    await world.dispose();
  }
});

void test('a cancellation while the fallback waits for the gate commits nothing and keeps the queue', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-fallback-cancel');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    const key = problemKeyOf(world.instance, 'P900000012');
    await seedBacklog(world, world.alice.id, ['P900000012']);
    world.metadata.fail.set('P900000012', authWall('the anonymous metadata read was asked to log in'));
    const parked = parkNthGate(world, 2);
    const source = createCancellationSource();
    const pending = service.retryMetadata(world.alice.id, key, source.token);
    await until(() => parked.parked() >= 2, 'the authenticated fallback to wait for the source floor');
    source.cancel('cancelled while the fallback waited');
    parked.release();
    await assert.rejects(pending, (error: unknown) => error instanceof DomainError && error.code === 'cancelled');

    assert.deepEqual(world.auth.calls, [], 'no authenticated request is dispatched after the cancellation');
    assert.deepEqual(world.factoryCalls(), [], 'a cancelled fallback cannot consult its factory');
    assert.equal(await world.store.getProblem(key), null);
    const state = (await world.store.getLuoguSyncState(world.alice.id))!.value;
    assert.deepEqual(state.missingMetadata, [key]);
    assert.equal(state.metadataResolved, 0);
    assert.equal(state.metadataFailed, 0);
    assert.equal(state.owner, null, 'the cancelled retry releases its lease');
  } finally {
    await world.dispose();
  }
});

void test('a takeover while the bulk fallback waits leaves the foreign row and the backlog untouched', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-fallback-takeover');
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    const key = problemKeyOf(world.instance, 'P900000013');
    await seedBacklog(world, world.alice.id, ['P900000013']);
    world.metadata.fail.set('P900000013', authWall('the anonymous metadata read was asked to log in'));
    const parked = parkNthGate(world, 2);

    assert.equal((await service.start(world.alice.id, 'metadata')).outcome, 'started');
    await until(() => parked.parked() >= 2, 'the authenticated fallback to wait for the source floor');
    const record = await world.store.getLuoguSyncState(world.alice.id);
    assert.ok(record !== null);
    await world.store.saveLuoguSyncState(
      {
        ...record.value,
        owner: 'foreign-owner',
        leaseExpiresAt: new Date(world.clock.nowMs() + 120_000).toISOString(),
        updatedAt: world.clock.now(),
      },
      record.revision,
    );
    parked.release();
    await service.settle();

    assert.deepEqual(world.auth.calls, [], 'a stale claim dispatches no authenticated request');
    assert.equal(await world.store.getProblem(key), null);
    const after = await world.store.getLuoguSyncState(world.alice.id);
    assert.equal(after?.value.owner, 'foreign-owner', 'the losing pass never overwrites the new owner');
    assert.equal(after?.value.failure, null, 'nor writes its own failure over that row');
    assert.deepEqual(after?.value.missingMetadata, [key], 'the backlog is left exactly as the new owner has it');
    assert.deepEqual(world.factoryCalls(), [], 'a lost lease cannot consult the fallback factory');
    assert.equal(after?.value.metadataResolved, 0);
    assert.equal(after?.value.metadataFailed, 0);
  } finally {
    await world.dispose();
  }
});

void test('a service without the optional factory keeps the anonymous auth refusal as its outcome', async () => {
  const world = await createFallbackWorld();
  try {
    const service = world.makeService('svc-no-factory', { authenticated: false });
    await service.connect(world.alice.id, cookieFor('100001'), world.token);
    const key = problemKeyOf(world.instance, 'P900000014');
    await seedBacklog(world, world.alice.id, ['P900000014']);
    world.metadata.fail.set('P900000014', authWall('the anonymous metadata read was asked to log in'));

    const result = await service.retryMetadata(world.alice.id, key, world.token);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failureCode, 'auth_required');
    assert.deepEqual(world.factoryCalls(), []);
    assert.deepEqual(world.auth.calls, []);
    const after = (await world.store.getLuoguSyncState(world.alice.id))!.value;
    assert.deepEqual(after.missingMetadata, [key]);
    assert.equal(after.failure?.paused, true, 'without a fallback the auth refusal pauses as before');
  } finally {
    await world.dispose();
  }
});

for (const kind of ['throw', 'malformed', 'foreign', 'cancelled'] as const) {
  void test('a configured metadata factory ' + kind + ' failure is visible and cannot write', async () => {
    const world = await createFallbackWorld();
    try {
      let dispatches = 0;
      const marker = 'synthetic-factory-private-marker';
      const service = world.makeService('svc-factory-failure', { factory: () => {
        if (kind === 'throw') throw new Error(marker);
        if (kind === 'cancelled') throw new DomainError('cancelled', marker);
        if (kind === 'malformed') return {} as ProblemMetadataSource;
        return { sourceInstance: { ...world.instance, id: 'foreign-source' }, fetchProblem: async () => { dispatches++; throw new Error(marker); } };
      } });
      await service.connect(world.alice.id, cookieFor('100001'), world.token);
      const key = problemKeyOf(world.instance, 'T900000015');
      await seedBacklog(world, world.alice.id, ['T900000015']);
      world.metadata.fail.set('T900000015', authWall('anonymous auth wall'));
      await assert.rejects(service.retryMetadata(world.alice.id, key, world.token), (error: unknown) => {
        assert.ok(error instanceof PlatformError || error instanceof DomainError);
        assert.equal(error.code, kind === 'throw' ? 'unavailable' : kind === 'cancelled' ? 'cancelled' : 'invalid_input');
        assert.ok(!String(error).includes(marker));
        assert.ok(!JSON.stringify(error).includes(marker));
        return true;
      });
      assert.equal(dispatches, 0);
      assert.deepEqual(world.auth.calls, []);
      assert.equal(await world.store.getProblem(key), null);
      const after = (await world.store.getLuoguSyncState(world.alice.id))!.value;
      assert.deepEqual(after.missingMetadata, [key]);
      assert.equal(after.metadataResolved, 0);
      assert.equal(after.metadataFailed, 0);
      assert.equal(after.owner, null);
    } finally { await world.dispose(); }
  });
}
