/**
 * Typed Luogu API over the real durable stack (Sprint 17d1).
 *
 * Each case drives a registered Fetch route with a real `Request`/`Response` through the in-process
 * host registry double, so the assertions cover externally meaningful behaviour: the exact route
 * map and versioned envelope, the one-shot session cookie that is stored but never echoed, strict
 * validation before any side effect, account/CAS isolation, the status projection of a real
 * backfill (including a partial pass resumed after a restart), the honest unsupported-platform
 * refusal and route disposal. The store is real SQLite, the credential vault is a synthetic
 * in-memory stand-in, and the platform is a synthetic `/record/list` feed the **real** Sprint 17a
 * reader parses: no real credential, socket, model or paid API is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { createCodeforcesAccount } from '../../src/adapters/codeforces/index.js';
import {
  createLuoguAccount,
  createLuoguConnectionManager,
  createStoredSubmissionsSource,
} from '../../src/adapters/luogu/index.js';
import { ImportService } from '../../src/application/import-service.js';
import { MAX_SUPPLEMENT_STATEMENT_CHARS, MAX_SUPPLEMENT_TITLE_CHARS } from '../../src/application/import-types.js';
import { createLuoguSourceGate } from '../../src/application/luogu-source-gate.js';
import { LuoguSyncService } from '../../src/application/luogu-sync-service.js';
import { emptyLuoguSyncState } from '../../src/application/luogu-sync-types.js';
import { DEFAULT_PLATFORM_LIMITS } from '../../src/application/ports.js';
import { LUOGU_API_OPERATIONS } from '../../src/application/workbench-api.js';
import { accountIdOf, createSourceInstance, type Account, type SourceInstance } from '../../src/domain/index.js';
import { API_PREFIX, type ApiEnvelope, type ApiErrorBody } from '../../src/plugin/api-transport.js';
import { registerLuoguApi } from '../../src/plugin/luogu-api.js';
import * as sfx from '../sync/fixtures.js';
import * as fx from '../storage/fixtures.js';

const AT = sfx.START;

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly instance: SourceInstance;
  readonly account: Account;
  /** A second stored Luogu account of the same instance, used for isolation assertions. */
  readonly other: Account;
  readonly clock: sfx.TestClock;
  readonly vault: sfx.MemoryVault;
  readonly feed: sfx.RecordFeed;
  readonly metadataCalls: string[];
  readonly metadata: sfx.MetadataHarness;
  readonly service: LuoguSyncService;
  readonly routes: Map<string, ConnectionFetchRoute>;
  post(operation: string, body: unknown): Promise<Response>;
  ok(operation: string, body: unknown, status?: number): Promise<any>;
  refused(operation: string, body: unknown, status: number): Promise<ApiErrorBody>;
  disposeApi(): Promise<void>;
  /** Simulate a host restart: close the service and register a fresh one over the same rows. */
  rebind(): Promise<void>;
}

function createRegistry(): {
  readonly registry: HostConnectionFetch;
  readonly routes: Map<string, ConnectionFetchRoute>;
} {
  const routes = new Map<string, ConnectionFetchRoute>();
  const registry: HostConnectionFetch = {
    register(route) {
      routes.set(route.path, route);
      return async () => {
        routes.delete(route.path);
      };
    },
  };
  return { registry, routes };
}

async function withBench(
  options: { readonly implemented?: boolean; readonly pages?: Map<string, sfx.SyntheticRecord[][]> },
  run: (bench: Bench) => Promise<void>,
): Promise<void> {
  const temp = fx.tempDatabase();
  const clock = sfx.createClock();
  const waits = sfx.createWait();
  const vault = sfx.createMemoryVault({ implemented: options.implemented ?? true });
  const feed = sfx.createRecordFeed(options.pages ?? new Map());
  const store = new SqliteTrainingStore({ path: temp.path, now: () => clock.now() });
  const instance = sfx.officialInstance();
  await store.upsertSourceInstances([instance]);
  const account = createLuoguAccount(instance, '800001');
  const other = createLuoguAccount(instance, '800002');
  await store.upsertAccounts([account, other]);
  const gate = createLuoguSourceGate({
    now: clock.nowMs,
    wait: waits.wait,
    minRequestIntervalMs: DEFAULT_PLATFORM_LIMITS.minRequestIntervalMs,
  });
  const transport = {
    fetchImpl: feed.fetchImpl,
    clock: clock.nowMs,
    wait: waits.wait,
    setTimer: sfx.neverFireTimer,
  };
  const metadata = sfx.createMetadataAdapter(instance, clock.now);
  const buildService = (ownerId: string): LuoguSyncService =>
    new LuoguSyncService({
      store,
      imports: new ImportService({ store, now: clock.now }),
      connections: createLuoguConnectionManager({
        store,
        vault,
        sourceInstance: instance,
        now: clock.now,
        limits: DEFAULT_PLATFORM_LIMITS,
        gate,
        transport,
      }),
      sourceInstance: instance,
      submissionsFor: createStoredSubmissionsSource({ store, vault, sourceInstance: instance, transport }),
      metadataSource: metadata.adapter,
      ownerId,
      now: clock.now,
      wait: waits.wait,
      gate,
      limits: DEFAULT_PLATFORM_LIMITS,
    });
  const { registry, routes } = createRegistry();
  let service = buildService('test-owner-1');
  let ownerSeq = 1;
  const register = (): Promise<() => Promise<void>> =>
    registerLuoguApi({
      registry,
      store,
      service,
      sourceInstance: instance,
      connectionAvailable: vault.capabilities().implemented,
      connectionPlatform: vault.capabilities().platform,
      now: clock.now,
    });
  let disposeApi = await register();
  const post = async (operation: string, body: unknown): Promise<Response> => {
    const route = routes.get(`${API_PREFIX}${operation}`);
    assert.ok(route, `route ${operation} must be registered`);
    return route.fetch(
      new Request(`http://localhost${API_PREFIX}${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  };
  const envelopeOf = async (response: Response): Promise<ApiEnvelope<unknown>> =>
    (await response.json()) as ApiEnvelope<unknown>;
  const bench: Bench = {
    store,
    instance,
    account,
    other,
    clock,
    vault,
    feed,
    metadataCalls: metadata.calls,
    metadata,
    get service() {
      return service;
    },
    routes,
    post,
    async ok(operation, body, status = 200) {
      const response = await post(operation, body);
      const parsed = await envelopeOf(response);
      assert.equal(response.status, status, `${operation} should answer ${status}: ${JSON.stringify(parsed)}`);
      if (!parsed.ok) {
        assert.fail(`${operation} answered a failed envelope`);
      }
      return parsed.value;
    },
    async refused(operation, body, status) {
      const response = await post(operation, body);
      const parsed = await envelopeOf(response);
      assert.equal(response.status, status, `${operation} should be refused with ${status}: ${JSON.stringify(parsed)}`);
      if (parsed.ok) {
        assert.fail(`${operation} should not succeed`);
      }
      return parsed.error;
    },
    async disposeApi() {
      await disposeApi();
    },
    async rebind() {
      const previous = disposeApi;
      disposeApi = async () => {};
      await previous();
      await service.close();
      ownerSeq += 1;
      service = buildService(`test-owner-${ownerSeq}`);
      disposeApi = await register();
    },
  };
  try {
    await run(bench);
  } finally {
    await disposeApi();
    await service.close();
    await store.close();
    fx.removeDirectory(temp.dir);
  }
}

const ALL_OPERATIONS = Object.values(LUOGU_API_OPERATIONS);

void test('the Luogu route map is exact and every answer uses the versioned envelope', async () => {
  await withBench({}, async (bench) => {
    assert.equal(ALL_OPERATIONS.length, 11);
    assert.deepEqual(
      [...bench.routes.keys()].sort(),
      ALL_OPERATIONS.map((operation) => `${API_PREFIX}${operation}`).sort(),
    );
    assert.equal(bench.routes.has(`${API_PREFIX}luogu.unknown`), false);
    for (const route of bench.routes.values()) {
      assert.deepEqual(route.methods, ['POST']);
      assert.equal(route.requestBody, 'streaming');
    }

    const response = await bench.post('luogu.status', { accountId: bench.account.id });
    const body = (await response.json()) as ApiEnvelope<any>;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.apiVersion, 1);
    assert.equal(body.ok, true);
    const view = body.value;
    assert.equal(view.accountId, bench.account.id);
    assert.equal(view.uid, '800001');
    assert.equal(view.sourceInstanceId, bench.instance.id);
    assert.equal(view.connectionAvailable, true);
    assert.equal(view.connectionPlatform, 'win32');
    assert.equal(view.connection, null);
    assert.equal(view.settings.automaticEnabled, false);
    assert.equal(view.settings.runOnStartup, true);
    assert.equal(view.settings.intervalMinutes, 30);
    assert.equal(view.settingsRevision, null, 'no settings row exists before the first configure');
    assert.equal(view.phase, 'backfill');
    assert.equal(view.historyComplete, false);
    assert.equal(view.historyCompletedAt, null);
    assert.equal(view.resumePending, false);
    assert.equal(view.running, false);
    assert.equal(view.leaseActive, false);
    assert.equal(view.metadataBacklog, 0);
    assert.equal(view.metadataBacklogFull, false);
    assert.equal(view.backlogDropped, 0);
    assert.equal(view.closing, false);
  });
});

void test('connect stores the session in the vault without echoing it or any reference', async () => {
  await withBench({}, async (bench) => {
    const cookie = sfx.cookieFor('800001', 'client-marker-17d1');
    const canonical = sfx.canonicalCookieFor('800001', 'client-marker-17d1');
    const connected = await bench.ok('luogu.connect', { accountId: bench.account.id, sessionCookie: cookie });
    assert.equal(connected.connection.status, 'connected');
    assert.equal(connected.connection.failureCode, null);
    assert.equal(connected.connection.cleanupPending, false);
    assert.equal(connected.connection.checkedAt, AT);

    const status = await bench.ok('luogu.status', { accountId: bench.account.id });
    const serialized = `${JSON.stringify(connected)}${JSON.stringify(status)}`;
    for (const marker of [cookie, canonical, 'client-marker-17d1', 'sessionCookie', 'reference', 'staleReference', 'leaseOwner', 'cookie', '_uid']) {
      assert.equal(serialized.includes(marker), false, `the answer must not carry ${marker}`);
    }
    assert.equal(bench.vault.writes.length, 1);
    const reference = bench.vault.writes[0]!;
    assert.equal(bench.vault.secrets.get(reference), canonical, 'only the normalized pair is stored');
    assert.ok(bench.feed.calls.length >= 1, 'the session is validated through a real reader call');
    assert.equal(bench.feed.calls[0]?.cookie, canonical, 'only the normalized pair is sent');
    assert.equal(bench.feed.calls[0]?.uid, '800001');

    const forgotten = await bench.ok('luogu.disconnect', { accountId: bench.account.id });
    assert.equal(forgotten.connection, null);
    assert.equal((await bench.store.getLuoguConnection(bench.account.id)), null);
    assert.equal(bench.vault.secrets.size, 0);
    assert.equal(forgotten.settings.automaticEnabled, false, 'disconnect only disables that account');
  });
});

void test('a whole-Cookie paste is normalized to the two required cookies before storage or dispatch', async () => {
  await withBench({}, async (bench) => {
    const bulky = `__cf_bm=abc; _uid=800001; theme=dark; __client_id=bulky-marker; __session=${'x'.repeat(3_000)}`;
    assert.ok(new TextEncoder().encode(bulky).length > 2_560, 'the raw header exceeds the blob limit on purpose');
    const connected = await bench.ok('luogu.connect', { accountId: bench.account.id, sessionCookie: bulky });
    assert.equal(connected.connection.status, 'connected');

    const canonical = sfx.canonicalCookieFor('800001', 'bulky-marker');
    assert.equal(bench.vault.writes.length, 1);
    assert.equal(bench.vault.secrets.get(bench.vault.writes[0]!), canonical, 'only the two cookies are stored');
    assert.equal(bench.feed.calls.length, 1);
    assert.equal(bench.feed.calls[0]?.cookie, canonical, 'only the two cookies are sent');
    const serialized = JSON.stringify(connected);
    for (const marker of ['bulky-marker', '__cf_bm', 'theme', 'x'.repeat(64)]) {
      assert.equal(serialized.includes(marker), false, `the answer must not carry ${marker}`);
    }
  });
});

void test('a session of another account is refused with a fixed sentence and no side effect', async () => {
  await withBench({}, async (bench) => {
    const error = await bench.refused(
      'luogu.connect',
      { accountId: bench.account.id, sessionCookie: `__client_id=abc; _uid=${bench.other.handle}` },
      400,
    );
    assert.equal(error.code, 'invalid_input');
    assert.match(error.message, /_uid/);
    assert.equal(error.message.includes(bench.other.handle), false, 'the refusal must not echo the uid');
    assert.equal(bench.vault.writes.length, 0);
    assert.equal(bench.feed.calls.length, 0, 'a foreign session never reaches the platform');
  });
});

void test('malformed input is refused before any store, vault or platform side effect', async () => {
  await withBench({}, async (bench) => {
    const accountId = bench.account.id;
    const cookie = sfx.cookieFor('800001');
    const cases: readonly (readonly [string, unknown])[] = [
      ['luogu.status', { accountId, extra: 1 }],
      ['luogu.status', {}],
      ['luogu.status', { accountId: 42 }],
      ['luogu.status', { accountId: 'not-an-account-id' }],
      ['luogu.connect', { accountId, sessionCookie: cookie, extra: true }],
      ['luogu.connect', { accountId }],
      ['luogu.connect', { accountId, sessionCookie: '   ' }],
      ['luogu.connect', { accountId, sessionCookie: 'x'.repeat(16 * 1024 + 1) }],
      ['luogu.connect', { accountId, sessionCookie: 'a\u0000b' }],
      ['luogu.connect', { accountId, sessionCookie: '_uid=800001; __session=abc' }],
      ['luogu.connect', { accountId, sessionCookie: '__client_id=; _uid=800001' }],
      ['luogu.connect', { accountId, sessionCookie: '__client_id=abc; __client_id=def; _uid=800001' }],
      ['luogu.connect', { accountId, sessionCookie: '__client_id=abc; _uid=800001\r\nx-injected: 1' }],
      ['luogu.connect', { accountId, sessionCookie: '__client_id=has space; _uid=800001' }],
      ['luogu.connect', { accountId, sessionCookie: '__client_id=abc; _uid=not-a-uid' }],
      ['luogu.configure', { accountId, expectedRevision: null }],
      ['luogu.configure', { accountId, expectedRevision: 0, automaticEnabled: true }],
      ['luogu.configure', { accountId, expectedRevision: null, automaticEnabled: 'yes' }],
      ['luogu.configure', { accountId, expectedRevision: null, runOnStartup: false, intervalMinutes: 4 }],
      ['luogu.configure', { accountId, expectedRevision: null, intervalMinutes: 1441 }],
      ['luogu.configure', { accountId, expectedRevision: null, automaticEnabled: true, unknown: 1 }],
      ['luogu.start', { accountId, mode: 'restart' }],
      ['luogu.start', { accountId, mode: 'metadata', extra: true }],
      ['luogu.start', { accountId }],
      ['luogu.probe', { accountId, mode: 'resume' }],
      ['luogu.disconnect', { accountId: '' }],
      ['luogu.cancel', { accountId: null }],
      // A smuggled-in session cookie (and any other undeclared field) is refused, not dropped.
      [
        'luogu.supplementMetadata',
        {
          accountId,
          problemKey: sfx.problemKeyOf(bench.instance, 'P9101'),
          title: '本地补全',
          statement: '用户题面。',
          expectedSnapshotId: null,
          sessionCookie: cookie,
        },
      ],
      [
        'luogu.supplementMetadata',
        {
          accountId,
          problemKey: sfx.problemKeyOf(bench.instance, 'P9101'),
          title: '本地补全',
          statement: '用户题面。',
        },
      ],
      [
        'luogu.supplementMetadata',
        {
          accountId,
          problemKey: sfx.problemKeyOf(bench.instance, 'P9101'),
          title: '   ',
          statement: '用户题面。',
          expectedSnapshotId: null,
        },
      ],
      [
        'luogu.supplementMetadata',
        {
          accountId,
          problemKey: sfx.problemKeyOf(bench.instance, 'P9101'),
          title: '本地补全',
          statement: '\n\t ',
          expectedSnapshotId: null,
        },
      ],
      [
        'luogu.supplementMetadata',
        {
          accountId,
          problemKey: sfx.problemKeyOf(bench.instance, 'P9101'),
          title: '本地补全',
          statement: 'x'.repeat(MAX_SUPPLEMENT_STATEMENT_CHARS + 1),
          expectedSnapshotId: null,
        },
      ],
      [
        'luogu.supplementMetadata',
        {
          accountId,
          problemKey: sfx.problemKeyOf(bench.instance, 'P9101'),
          title: '标'.repeat(MAX_SUPPLEMENT_TITLE_CHARS + 1),
          statement: '用户题面。',
          expectedSnapshotId: null,
        },
      ],
      [
        'luogu.supplementMetadata',
        {
          accountId,
          problemKey: sfx.problemKeyOf(bench.instance, 'P9101'),
          title: '本地补全',
          statement: '用户题面。',
          expectedSnapshotId: 7,
        },
      ],
      [
        'luogu.supplementMetadata',
        {
          accountId,
          problemKey: sfx.problemKeyOf(bench.instance, 'P9101'),
          title: '本地补全',
          statement: '用户题面。',
          expectedSnapshotId: 'x'.repeat(600),
        },
      ],
      [
        'luogu.supplementMetadata',
        { accountId, problemKey: 'not-a-canonical-key', title: '本地补全', statement: '用户题面。', expectedSnapshotId: null },
      ],
    ];
    for (const [operation, body] of cases) {
      const error = await bench.refused(operation, body, 400);
      assert.equal(error.code, 'invalid_input', `${operation} ${JSON.stringify(body).slice(0, 60)}`);
    }
    assert.equal(bench.vault.writes.length, 0, 'no credential write may happen for a refused request');
    assert.equal(bench.feed.calls.length, 0, 'no platform request may happen for a refused request');
    assert.equal(await bench.store.getLuoguSyncSettings(accountId), null);
    assert.equal(await bench.store.getLuoguSyncState(accountId), null);
  });
});

void test('a foreign or unknown account is refused before any credential or platform work', async () => {
  const codeforces = createSourceInstance({
    platform: 'codeforces',
    baseUrl: 'https://codeforces.com',
    displayName: 'Codeforces',
  });
  const foreign = createCodeforcesAccount(codeforces, 'alice');
  await withBench({}, async (bench) => {
    await bench.store.upsertSourceInstances([codeforces]);
    await bench.store.upsertAccounts([foreign]);

    const refusedForeign = await bench.refused(
      'luogu.connect',
      { accountId: foreign.id, sessionCookie: sfx.cookieFor('alice') },
      400,
    );
    assert.equal(refusedForeign.code, 'invalid_input');
    assert.match(refusedForeign.message, /洛谷来源/);

    const refusedUnknown = await bench.refused(
      'luogu.status',
      { accountId: accountIdOf(bench.instance.id, '999999') },
      404,
    );
    assert.equal(refusedUnknown.code, 'not_found');

    const refusedStoredForeign = await bench.refused('luogu.probe', { accountId: foreign.id }, 400);
    assert.equal(refusedStoredForeign.code, 'invalid_input');
    assert.equal(bench.vault.writes.length, 0);
    assert.equal(bench.feed.calls.length, 0);
  });
});

void test('luogu.profile resolves a public nickname with no vault, session or connection', async () => {
  // `implemented: false` is a host whose credential backend is unsupported: the anonymous nickname
  // lookup must still work, before any connection exists, and echo nothing secret.
  await withBench({ implemented: false }, async (bench) => {
    bench.metadata.profiles.set('800001', {
      sourceInstanceId: bench.instance.id,
      uid: '800001',
      displayName: '示例选手',
    });
    const result = await bench.ok('luogu.profile', { accountId: bench.account.id });
    assert.deepEqual(result, {
      account: {
        id: bench.account.id,
        sourceInstanceId: bench.instance.id,
        handle: '800001',
        displayName: '示例选手',
        profileUrl: bench.account.profileUrl,
      },
    });
    assert.deepEqual(bench.metadata.profileCalls, ['800001']);
    assert.equal(bench.vault.writes.length, 0, 'no credential was written');
    assert.equal(bench.feed.calls.length, 0, 'no history request was made');
    assert.equal((await bench.store.getAccount(bench.other.id))?.displayName, null, 'another account is untouched');
    assert.equal(JSON.stringify(result).includes('luogu.session'), false, 'no vault reference is echoed');

    const unknown = await bench.post('luogu.profile', { accountId: accountIdOf(bench.instance.id, '999999') });
    const parsed = (await unknown.json()) as ApiEnvelope<unknown>;
    assert.equal(unknown.status, 404);
    assert.equal(parsed.ok, false);
    assert.deepEqual(bench.metadata.profileCalls, ['800001'], 'a refused account dispatches no lookup');
  });
});

void test('a captured luogu.profile route is refused after disposal without any lookup', async () => {
  await withBench({}, async (bench) => {
    bench.metadata.profiles.set('800001', {
      sourceInstanceId: bench.instance.id,
      uid: '800001',
      displayName: '示例选手',
    });
    const route = bench.routes.get(`${API_PREFIX}${LUOGU_API_OPERATIONS.profile}`);
    assert.ok(route, 'luogu.profile must be registered');
    await bench.disposeApi();
    const late = await route.fetch(
      new Request(`http://localhost${API_PREFIX}${LUOGU_API_OPERATIONS.profile}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: bench.account.id }),
      }),
    );
    const lateBody = (await late.json()) as ApiEnvelope<unknown>;
    assert.equal(late.status, 409, 'a captured route reference is refused after disposal');
    if (lateBody.ok) {
      assert.fail('a late handler must not answer a successful envelope');
    }
    assert.equal(lateBody.error.code, 'conflict');
    assert.deepEqual(bench.metadata.profileCalls, [], 'a closed request performs no lookup');
    assert.equal(bench.vault.writes.length, 0);
    assert.equal(bench.feed.calls.length, 0);
  });
});

void test('configure is a per-account revision CAS and a mismatch changes nothing', async () => {
  await withBench({}, async (bench) => {
    const first = await bench.ok('luogu.configure', {
      accountId: bench.account.id,
      expectedRevision: null,
      automaticEnabled: true,
      intervalMinutes: 15,
    });
    assert.equal(first.settings.automaticEnabled, true);
    assert.equal(first.settings.intervalMinutes, 15);
    assert.equal(first.settingsRevision, 1);

    const stale = await bench.refused(
      'luogu.configure',
      { accountId: bench.account.id, expectedRevision: null, runOnStartup: false },
      409,
    );
    assert.equal(stale.code, 'conflict');
    const unchanged = await bench.store.getLuoguSyncSettings(bench.account.id);
    assert.equal(unchanged?.revision, 1);
    assert.equal(unchanged?.value.runOnStartup, true, 'a stale write must change nothing');

    const next = await bench.ok('luogu.configure', {
      accountId: bench.account.id,
      expectedRevision: 1,
      runOnStartup: false,
    });
    assert.equal(next.settingsRevision, 2);
    assert.equal(next.settings.runOnStartup, false);
    assert.equal(next.settings.automaticEnabled, true, 'an unpatched field keeps its stored value');

    const isolated = await bench.ok('luogu.configure', {
      accountId: bench.other.id,
      expectedRevision: null,
      automaticEnabled: true,
    });
    assert.equal(isolated.settingsRevision, 1);
    assert.equal(isolated.settings.intervalMinutes, 30);
    assert.equal((await bench.store.getLuoguSyncSettings(bench.account.id))?.revision, 2);
    assert.equal((await bench.store.getLuoguSyncSettings(bench.account.id))?.value.runOnStartup, false);
  });
});

void test('start, progress, completion and cancel answer the safe status projection', async () => {
  const records = sfx.buildRecords(60, ['P1001', 'P1002']);
  await withBench({ pages: new Map([['800001', sfx.toPages(records, 50)]]) }, async (bench) => {
    await bench.ok('luogu.connect', { accountId: bench.account.id, sessionCookie: sfx.cookieFor('800001') });
    const started = await bench.ok('luogu.start', { accountId: bench.account.id, mode: 'resume' }, 202);
    assert.equal(started.accountId, bench.account.id);
    assert.equal(started.mode, 'resume');
    assert.equal(started.outcome, 'started');
    assert.equal(started.status.phase, 'backfill');

    await bench.service.settle();
    const view = await bench.ok('luogu.status', { accountId: bench.account.id });
    assert.equal(view.phase, 'incremental');
    assert.equal(view.historyComplete, true);
    assert.equal(view.historyCompletedAt, AT);
    assert.equal(view.running, false);
    assert.equal(view.leaseActive, false);
    assert.equal(view.resumePending, false);
    assert.equal(view.totalPages, 2);
    assert.equal(view.submissionsSeen, 60);
    assert.equal(view.metadataBacklog, 0);
    assert.equal(view.metadataResolved, 2, 'the two referenced problems are repaired through the metadata source');
    assert.deepEqual(bench.metadataCalls.sort(), ['P1001', 'P1002']);
    assert.equal(view.lastSuccessAt, AT);
    assert.equal(view.nextRunAt, new Date(Date.parse(AT) + 30 * 60_000).toISOString());
    assert.equal(view.connection.status, 'connected');

    const cancelled = await bench.ok('luogu.cancel', { accountId: bench.account.id });
    assert.equal(cancelled.running, false);
    assert.equal(cancelled.closing, false);
  });
});

void test('luogu.start accepts the metadata-only mode and drains the backlog without a history read', async () => {
  await withBench({}, async (bench) => {
    await bench.store.saveLuoguSyncState(
      {
        ...emptyLuoguSyncState(bench.account.id, bench.instance.id, AT),
        missingMetadata: sfx.buildProblemKeys(bench.instance, ['P4001', 'P4002', 'P4003']),
        updatedAt: AT,
      },
      null,
    );
    await bench.ok('luogu.connect', { accountId: bench.account.id, sessionCookie: sfx.cookieFor('800001') });
    const feedCallsBefore = bench.feed.calls.length;

    const started = await bench.ok('luogu.start', { accountId: bench.account.id, mode: 'metadata' }, 202);
    assert.equal(started.accountId, bench.account.id);
    assert.equal(started.mode, 'metadata');
    assert.equal(started.outcome, 'started');
    await bench.service.settle();

    const view = await bench.ok('luogu.status', { accountId: bench.account.id });
    assert.equal(view.metadataBacklog, 0);
    assert.equal(view.metadataResolved, 3);
    assert.equal(view.historyComplete, false, 'a metadata-only action never claims a history scan');
    assert.equal(view.totalPages, 0);
    assert.equal(bench.feed.calls.length, feedCallsBefore, 'no history page was requested');
    assert.deepEqual(bench.metadataCalls, ['P4001', 'P4002', 'P4003']);
  });
});

void test('a partial backfill keeps its checkpoint and resumes after a restart', async () => {
  // 25 server pages of 50 rows: one pass commits at most 20 pages, so the rest stays durable.
  const records = sfx.buildRecords(1_250, ['P2001']);
  await withBench({ pages: new Map([['800001', sfx.toPages(records, 50)]]) }, async (bench) => {
    await bench.ok('luogu.connect', { accountId: bench.account.id, sessionCookie: sfx.cookieFor('800001') });
    await bench.ok('luogu.start', { accountId: bench.account.id, mode: 'resume' }, 202);
    await bench.service.settle();

    const partial = await bench.ok('luogu.status', { accountId: bench.account.id });
    assert.equal(partial.totalPages, 20);
    assert.equal(partial.submissionsSeen, 1_000);
    assert.equal(partial.resumePending, true);
    assert.equal(partial.historyComplete, false);
    assert.equal(partial.phase, 'backfill');
    assert.ok(partial.scanStartedAt !== null, 'the whole-scan start instant stays frozen');

    await bench.rebind();
    const resumed = await bench.ok('luogu.status', { accountId: bench.account.id });
    assert.equal(resumed.totalPages, 20, 'committed pages survive a restart');
    assert.equal(resumed.submissionsSeen, 1_000);
    assert.equal(resumed.resumePending, true);
    assert.equal(resumed.scanStartedAt, partial.scanStartedAt);

    await bench.ok('luogu.start', { accountId: bench.account.id, mode: 'resume' }, 202);
    await bench.service.settle();
    const complete = await bench.ok('luogu.status', { accountId: bench.account.id });
    assert.equal(complete.totalPages, 25);
    assert.equal(complete.submissionsSeen, 1_250);
    assert.equal(complete.resumePending, false);
    assert.equal(complete.historyComplete, true);
    assert.equal(complete.phase, 'incremental');
  });
});

void test('an unsupported credential platform refuses connection work and keeps the rest alive', async () => {
  await withBench({ implemented: false }, async (bench) => {
    const status = await bench.ok('luogu.status', { accountId: bench.account.id });
    assert.equal(status.connectionAvailable, false);
    assert.equal(status.connectionPlatform, 'win32');
    assert.equal(status.connection, null);

    for (const [operation, body] of [
      ['luogu.connect', { accountId: bench.account.id, sessionCookie: sfx.cookieFor('800001') }],
      ['luogu.probe', { accountId: bench.account.id }],
      ['luogu.disconnect', { accountId: bench.account.id }],
    ] as const) {
      const error = await bench.refused(operation, body, 409);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /安全凭据存储/);
    }
    assert.equal(bench.vault.writes.length, 0);
    assert.equal(bench.feed.calls.length, 0);

    // Configuration and status never needed the vault, so they keep working.
    const configured = await bench.ok('luogu.configure', {
      accountId: bench.account.id,
      expectedRevision: null,
      automaticEnabled: true,
    });
    assert.equal(configured.settings.automaticEnabled, true);
    const started = await bench.ok('luogu.start', { accountId: bench.account.id, mode: 'resume' }, 202);
    assert.equal(started.outcome, 'started');
    await bench.service.settle();
    const after = await bench.ok('luogu.status', { accountId: bench.account.id });
    assert.ok(after.failure !== null, 'a missing session is recorded as a durable failure');
    assert.equal(after.running, false);
    assert.equal(after.connectionAvailable, false);
  });
});

void test('disposal removes every Luogu route and drains the pass that was running', async () => {
  const records = sfx.buildRecords(600, ['P3001']);
  await withBench({ pages: new Map([['800001', sfx.toPages(records, 50)]]) }, async (bench) => {
    await bench.ok('luogu.connect', { accountId: bench.account.id, sessionCookie: sfx.cookieFor('800001') });
    bench.feed.holdNext = 1;
    await bench.ok('luogu.start', { accountId: bench.account.id, mode: 'resume' }, 202);
    await sfx.until(() => bench.feed.heldCount() > 0, 'the pass to reach the platform');
    await bench.disposeApi();
    assert.equal(bench.routes.size, 0, 'routes are removed while the pass is still in flight');
    bench.feed.release();
    await bench.service.close();
    const state = await bench.store.getLuoguSyncState(bench.account.id);
    assert.equal(state?.value.owner, null, 'the drained pass released its durable lease');
    assert.equal(state?.value.leaseExpiresAt, null);
    assert.equal(state?.value.failure, null, 'a cancelled pass records no failure');
    await assert.rejects(
      () => bench.service.start(bench.account.id, 'resume'),
      (error: unknown) => (error as { code?: string }).code === 'closing',
    );
  });
});

/** A manually released gate used to park one store call inside a disposal race window. */
function deferred(): { readonly promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

void test('disposal drains an in-flight status request and refuses a late captured handler without IO', async () => {
  await withBench({}, async (bench) => {
    const route = bench.routes.get(`${API_PREFIX}luogu.status`);
    assert.ok(route, 'luogu.status must be registered');
    const gate = deferred();
    const original = bench.store.getLuoguSyncSettings.bind(bench.store);
    let reads = 0;
    bench.store.getLuoguSyncSettings = (async (...args: Parameters<SqliteTrainingStore['getLuoguSyncSettings']>) => {
      reads += 1;
      await gate.promise;
      return original(...args);
    }) as SqliteTrainingStore['getLuoguSyncSettings'];

    const request = route.fetch(
      new Request(`http://localhost${API_PREFIX}luogu.status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: bench.account.id }),
      }),
    );
    await sfx.until(() => reads === 1, 'the status handler to reach the deferred store read');

    let disposed = false;
    const disposal = bench.disposeApi().then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(disposed, false, 'disposal waits for the handler it already accepted');
    gate.release();
    await disposal;
    const response = await request;
    assert.equal(response.status, 200, 'the drained request still answers its own caller');

    // The route object was captured before disposal; invoking it afterwards must fail safe.
    const readsAfterDrain = reads;
    const late = await route.fetch(
      new Request(`http://localhost${API_PREFIX}luogu.status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: bench.account.id }),
      }),
    );
    const lateBody = (await late.json()) as ApiEnvelope<unknown>;
    assert.equal(late.status, 409, 'a captured route reference is refused after disposal');
    if (lateBody.ok) {
      assert.fail('a late handler must not answer a successful envelope');
    }
    assert.equal(lateBody.error.code, 'conflict');
    assert.equal(reads, readsAfterDrain, 'a late handler performs no store read at all');
    assert.equal(bench.vault.writes.length, 0);
    assert.equal(bench.feed.calls.length, 0);
  });
});

void test('disposal cancels an in-flight connect instead of hanging and touches no credential', async () => {
  await withBench({}, async (bench) => {
    const route = bench.routes.get(`${API_PREFIX}luogu.connect`);
    assert.ok(route, 'luogu.connect must be registered');
    const gate = deferred();
    const original = bench.store.getAccount.bind(bench.store);
    let reads = 0;
    bench.store.getAccount = (async (...args: Parameters<SqliteTrainingStore['getAccount']>) => {
      reads += 1;
      await gate.promise;
      return original(...args);
    }) as SqliteTrainingStore['getAccount'];

    const request = route.fetch(
      new Request(`http://localhost${API_PREFIX}luogu.connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: bench.account.id, sessionCookie: sfx.cookieFor('800001') }),
      }),
    );
    await sfx.until(() => reads === 1, 'connect to reach the deferred store read');

    const disposal = bench.disposeApi();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    gate.release();
    await disposal;
    const response = await request;
    const body = (await response.json()) as ApiEnvelope<unknown>;
    assert.equal(response.status, 409, 'a connect interrupted by disposal is refused');
    if (body.ok) {
      assert.fail('an interrupted connect must not succeed');
    }
    assert.equal(body.error.code, 'conflict');
    assert.equal(bench.vault.writes.length, 0, 'no credential was written');
    assert.equal(bench.feed.calls.length, 0, 'no platform request was made');
  });
});

void test('disposal removes every route even when one disposer throws and retains the failure', async () => {
  await withBench({}, async (bench) => {
    const routes = new Map<string, ConnectionFetchRoute>();
    const registry: HostConnectionFetch = {
      register(route) {
        routes.set(route.path, route);
        return async () => {
          routes.delete(route.path);
          if (route.path === `${API_PREFIX}luogu.probe`) {
            throw new Error('probe disposer exploded');
          }
        };
      },
    };
    const dispose = await registerLuoguApi({
      registry,
      store: bench.store,
      service: bench.service,
      sourceInstance: bench.instance,
      connectionAvailable: true,
      connectionPlatform: 'win32',
      now: bench.clock.now,
    });
    assert.equal(routes.size, ALL_OPERATIONS.length);
    await assert.rejects(() => dispose(), /probe disposer exploded/);
    assert.equal(routes.size, 0, 'every route was disposed despite the one failure');
    await assert.rejects(() => dispose(), /probe disposer exploded/, 'the cached disposal keeps the failure');
  });
});

void test('luogu.supplementMetadata commits locally supplied material and refuses a stale head', async () => {
  await withBench({}, async (bench) => {
    const key = sfx.problemKeyOf(bench.instance, 'P5001');
    const sibling = sfx.problemKeyOf(bench.instance, 'P5002');
    await bench.store.saveLuoguSyncState(
      {
        ...emptyLuoguSyncState(bench.account.id, bench.instance.id, AT),
        missingMetadata: [sibling, key],
      },
      null,
    );

    // A disconnected account: no session, no vault entry and still a successful local recovery.
    assert.equal(await bench.store.getLuoguConnection(bench.account.id), null);
    const view = await bench.ok('luogu.supplementMetadata', {
      accountId: bench.account.id,
      problemKey: key,
      title: '本地补全的题目',
      statement: '用户手写的完整题面。',
      expectedSnapshotId: null,
    });
    assert.equal(view.outcome, 'supplemented');
    assert.equal(view.accountId, bench.account.id);
    assert.equal(view.problemKey, key);
    assert.equal(view.snapshot.changed, true);
    assert.equal(view.snapshot.version, 1);
    assert.equal(view.status.metadataBacklog, 1, 'only the selected key left the backlog');
    assert.equal(view.status.metadataResolved, 1);
    assert.equal(view.status.connection, null);
    assert.equal(view.status.running, false);
    assert.equal(JSON.stringify(view).includes('用户手写的完整题面。'), false, 'the answer never echoes the statement');

    const problem = await bench.store.getProblem(key);
    assert.ok(problem !== null);
    assert.equal(problem.title, '本地补全的题目');
    assert.equal(problem.statement, '用户手写的完整题面。');
    assert.equal(problem.url, `https://${sfx.OFFICIAL_DOMAIN}/problem/P5001`);
    assert.deepEqual(problem.rawTags, [], 'no platform tag is invented');
    assert.deepEqual(problem.ratings, [], 'no platform rating is invented');
    const snapshot = await bench.store.getSnapshot(view.snapshot.snapshotId);
    assert.deepEqual(snapshot?.sources, [], 'a local recovery declares no editorial material');
    assert.deepEqual(snapshot?.solutions, []);
    const state = await bench.store.getLuoguSyncState(bench.account.id);
    assert.deepEqual(state?.value.missingMetadata, [sibling]);
    assert.equal(state?.value.metadataResolved, 1);
    assert.equal(state?.value.owner, null, 'the durable lease is released');

    // No platform, history, credential or model work happened anywhere in this call.
    assert.deepEqual(bench.metadata.calls, []);
    assert.deepEqual(bench.metadata.profileCalls, []);
    assert.equal(bench.metadata.editorialCalls(), 0);
    assert.equal(bench.feed.calls.length, 0);
    assert.equal(bench.vault.writes.length, 0);

    // The head moved with the recovery: a form that still claims "no snapshot" is refused with the
    // fixed refresh sentence and changes nothing.
    await bench.store.saveLuoguSyncState({ ...state!.value, missingMetadata: [key, sibling] }, state!.revision);
    const stale = await bench.refused(
      'luogu.supplementMetadata',
      {
        accountId: bench.account.id,
        problemKey: key,
        title: '另一个标题',
        statement: '另一份题面。',
        expectedSnapshotId: null,
      },
      409,
    );
    assert.equal(stale.code, 'conflict');
    assert.match(stale.message, /刷新/);
    assert.equal(stale.message.includes('同步设置'), false, 'a stale snapshot is not a settings error');
    assert.equal((await bench.store.getProblem(key))?.statement, '用户手写的完整题面。');
    const after = await bench.store.getLuoguSyncState(bench.account.id);
    assert.deepEqual(after?.value.missingMetadata, [key, sibling], 'a refused recovery leaves the key queued');
    assert.equal(after?.value.metadataResolved, 1);
    assert.deepEqual(bench.metadata.calls, []);
    assert.equal(bench.feed.calls.length, 0);
  });
});
