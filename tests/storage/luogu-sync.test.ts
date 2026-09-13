/**
 * Durable Luogu synchronization storage (Sprint 17c1).
 *
 * These cases drive the real SQLite store and state externally meaningful consequences: automatic
 * settings are per account (enabling one never enables another), every save is a compare-and-set a
 * stale writer loses, a disconnect prepared against an older revision cannot delete a replaced
 * session, a corrupted or identity-swapped row is reported instead of served, and every supported
 * older layout — empty/v0 through a genuine v6 — migrates to v7 after exactly one pre-migration
 * backup with every existing row retained.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { StorageError } from '../../src/adapters/sqlite/index.js';
import {
  META_TABLE,
  STORE_MARKER,
  STORE_SCHEMA_VERSION,
  STORE_TABLES_V7,
  applySchemaV1,
  initializeSchemaV2,
  initializeSchemaV3,
  initializeSchemaV4,
  migrateToSchemaV5,
  migrateToSchemaV6,
  readUserVersion,
  tableNames,
} from '../../src/adapters/sqlite/schema.js';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/store.js';
import {
  defaultLuoguSyncSettings,
  emptyLuoguSyncState,
  luoguLeaseExpired,
  luoguLeaseHeldByAnother,
  luoguLeaseLive,
  validateLuoguConnectionJournalEntry,
  validateLuoguConnectionState,
  validateLuoguSyncSettings,
  validateLuoguSyncState,
  type LuoguConnectionState,
  type LuoguSyncState,
} from '../../src/application/luogu-sync-types.js';
import { DomainError, canonicalJson, type Account } from '../../src/domain/index.js';
import { officialFixture } from '../official-rating-fixtures.js';
import * as fx from './fixtures.js';

const OFFICIAL_DOMAIN = 'www.luogu.com.cn';

/** One official Luogu instance + account + problem scope. */
function luoguScope(handle: string): fx.Scope {
  return fx.makeScope('luogu', OFFICIAL_DOMAIN, handle, `P${handle}`);
}

/** One stored connection record; the reference is opaque, never a secret. */
function connectionFor(account: Account, overrides: Partial<LuoguConnectionState> = {}): LuoguConnectionState {
  return {
    accountId: account.id,
    sourceInstanceId: account.sourceInstanceId,
    reference: 'credential:luogu:session-a',
    status: 'connected',
    connectedAt: fx.AT,
    checkedAt: fx.AT,
    failureCode: null,
    staleReference: null,
    ...overrides,
  };
}

function isDomain(code: DomainError['code']): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

function isStorage(code: string): (error: unknown) => boolean {
  return (error) => error instanceof StorageError && error.code === code;
}

/** Run one raw statement against a closed database file; used to corrupt rows on purpose. */
function rawMutate(path: string, sql: string, params: readonly (string | number | null)[]): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

void test('Luogu automatic-sync settings are per account, CAS-guarded and survive a restart', async () => {
  const paths = fx.tempDatabase();
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const alice = luoguScope('100001');
    const bob = luoguScope('100002');
    await store.upsertSourceInstances([alice.instance]);
    await store.upsertAccounts([alice.account, bob.account]);

    // Settings belong to a stored account on the official instance, never to an unknown or foreign one.
    await assert.rejects(
      store.saveLuoguSyncSettings(defaultLuoguSyncSettings('luogu:www.luogu.com.cn:999999', fx.AT), null),
      isDomain('missing_reference'),
    );
    const cf = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await store.upsertSourceInstances([cf.instance]);
    await store.upsertAccounts([cf.account]);
    await assert.rejects(
      store.saveLuoguSyncSettings(defaultLuoguSyncSettings(cf.account.id, fx.AT), null),
      isDomain('invalid_input'),
    );

    assert.equal(await store.getLuoguSyncSettings(alice.account.id), null);
    assert.equal(await store.saveLuoguSyncSettings(defaultLuoguSyncSettings(alice.account.id, fx.AT), null), 1);
    assert.equal(
      await store.saveLuoguSyncSettings(
        { ...defaultLuoguSyncSettings(bob.account.id, fx.AT), automaticEnabled: true },
        null,
      ),
      1,
    );

    // Enabling Bob's automation did not enable Alice's: the rows are independent.
    const aliceStored = await store.getLuoguSyncSettings(alice.account.id);
    assert.equal(aliceStored?.revision, 1);
    assert.equal(aliceStored?.value.automaticEnabled, false);
    assert.equal((await store.getLuoguSyncSettings(bob.account.id))?.value.automaticEnabled, true);

    // A stale writer rejects before any write: neither a null nor a wrong revision can enable her sync.
    await assert.rejects(
      store.saveLuoguSyncSettings(
        { ...defaultLuoguSyncSettings(alice.account.id, fx.LEASE_UNTIL), automaticEnabled: true },
        null,
      ),
      isDomain('duplicate_id'),
    );
    await assert.rejects(
      store.saveLuoguSyncSettings(
        { ...defaultLuoguSyncSettings(alice.account.id, fx.LEASE_UNTIL), automaticEnabled: true },
        7,
      ),
      isDomain('invalid_transition'),
    );
    assert.equal((await store.getLuoguSyncSettings(alice.account.id))?.value.automaticEnabled, false);
    assert.equal(
      await store.saveLuoguSyncSettings(
        { ...defaultLuoguSyncSettings(alice.account.id, fx.LEASE_UNTIL), automaticEnabled: true },
        1,
      ),
      2,
    );

    await store.close();
    store = new SqliteTrainingStore({ path: paths.path });
    assert.deepEqual(await store.getLuoguSyncSettings(alice.account.id), {
      revision: 2,
      value: { ...defaultLuoguSyncSettings(alice.account.id, fx.LEASE_UNTIL), automaticEnabled: true },
    });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('Luogu sync state is account-scoped, revision-guarded and rolled back with its transaction', async () => {
  const paths = fx.tempDatabase();
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const alice = luoguScope('200001');
    await store.upsertSourceInstances([alice.instance]);
    await store.upsertAccounts([alice.account]);

    const initial = emptyLuoguSyncState(alice.account.id, alice.instance.id, fx.AT);
    assert.equal(await store.saveLuoguSyncState(initial, null), 1);
    assert.deepEqual(await store.getLuoguSyncState(alice.account.id), { revision: 1, value: initial });

    // A state naming another source instance, a foreign account or an unknown account is refused.
    const cf = fx.makeScope('codeforces', 'codeforces.com', 'bob', '2B');
    await store.upsertSourceInstances([cf.instance]);
    await store.upsertAccounts([cf.account]);
    await assert.rejects(
      store.saveLuoguSyncState(emptyLuoguSyncState(alice.account.id, cf.instance.id, fx.AT), 1),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      store.saveLuoguSyncState(emptyLuoguSyncState(cf.account.id, cf.instance.id, fx.AT), null),
      isDomain('invalid_input'),
    );
    await assert.rejects(
      store.saveLuoguSyncState(emptyLuoguSyncState('luogu:www.luogu.com.cn:999999', alice.instance.id, fx.AT), null),
      isDomain('missing_reference'),
    );

    const advanced: LuoguSyncState = {
      ...initial,
      phase: 'incremental',
      historyComplete: true,
      historyCompletedAt: fx.LATER,
      lastScanStartedAt: fx.LATER,
      lastSuccessAt: fx.LATER,
      totalPages: 3,
      updatedAt: fx.LATER,
    };
    assert.equal(await store.saveLuoguSyncState(advanced, 1), 2);
    await assert.rejects(
      store.saveLuoguSyncState({ ...advanced, updatedAt: fx.LEASE_UNTIL }, 1),
      isDomain('invalid_transition'),
    );
    await assert.rejects(
      store.saveLuoguSyncState({ ...advanced, updatedAt: fx.LEASE_UNTIL }, null),
      isDomain('duplicate_id'),
    );
    assert.equal((await store.getLuoguSyncState(alice.account.id))?.value.totalPages, 3);

    // One transaction writes progress and a connection reference; a throw rolls both back.
    await assert.rejects(
      store.transaction(async () => {
        await store.saveLuoguSyncState({ ...advanced, totalPages: 9, updatedAt: fx.LEASE_UNTIL }, 2);
        await store.saveLuoguConnection(connectionFor(alice.account), null);
        throw new DomainError('invalid_transition', 'abort the pass');
      }),
      isDomain('invalid_transition'),
    );
    assert.equal((await store.getLuoguSyncState(alice.account.id))?.value.totalPages, 3);
    assert.equal(await store.getLuoguConnection(alice.account.id), null);

    await store.close();
    store = new SqliteTrainingStore({ path: paths.path });
    const reopened = await store.getLuoguSyncState(alice.account.id);
    assert.equal(reopened?.revision, 2);
    assert.equal(reopened?.value.phase, 'incremental');
    assert.equal(reopened?.value.historyComplete, true);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('connection references are CAS-guarded, listed by account and never deleted by a stale disconnect', async () => {
  const paths = fx.tempDatabase();
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const alice = luoguScope('300001');
    const bob = luoguScope('300002');
    await store.upsertSourceInstances([alice.instance]);
    await store.upsertAccounts([alice.account, bob.account]);

    assert.equal(
      await store.saveLuoguConnection(connectionFor(alice.account, { reference: 'credential:luogu:a1' }), null),
      1,
    );
    assert.equal(
      await store.saveLuoguConnection(
        connectionFor(bob.account, {
          reference: 'credential:luogu:b1',
          status: 'session_expired',
          failureCode: 'auth_required',
        }),
        null,
      ),
      1,
    );
    const listed = await store.listLuoguConnections();
    assert.deepEqual(
      listed.map((state) => state.accountId),
      [alice.account.id, bob.account.id].sort(),
    );

    // Reconnecting replaces the session at revision 2; a disconnect prepared against revision 1 loses.
    assert.equal(
      await store.saveLuoguConnection(
        connectionFor(alice.account, { reference: 'credential:luogu:a2', checkedAt: fx.LATER }),
        1,
      ),
      2,
    );
    await assert.rejects(store.deleteLuoguConnection(alice.account.id, 1), isDomain('invalid_transition'));
    await assert.rejects(store.deleteLuoguConnection(alice.account.id, null), isDomain('invalid_transition'));
    assert.equal((await store.getLuoguConnection(alice.account.id))?.value.reference, 'credential:luogu:a2');

    // The current revision disconnects, and repeating the delete is an idempotent no-op.
    await store.deleteLuoguConnection(alice.account.id, 2);
    assert.equal(await store.getLuoguConnection(alice.account.id), null);
    await store.deleteLuoguConnection(alice.account.id, null);
    await store.deleteLuoguConnection(alice.account.id, 5);
    await store.deleteLuoguConnection('luogu:www.luogu.com.cn:404404', 3);

    await store.close();
    store = new SqliteTrainingStore({ path: paths.path });
    const afterRestart = await store.listLuoguConnections();
    assert.equal(afterRestart.length, 1);
    assert.equal(afterRestart[0]?.accountId, bob.account.id);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('validators refuse credential-shaped, foreign and lossy records, and the lease predicates are explicit', async () => {
  const scope = luoguScope('400001');
  const state = emptyLuoguSyncState(scope.account.id, scope.instance.id, fx.AT);

  // A credential-shaped key never validates, and the store refuses it before writing anything.
  assert.throws(
    () => validateLuoguConnectionState({ ...connectionFor(scope.account), cookie: 'sessionid=secret' }),
    isDomain('invalid_input'),
  );
  assert.throws(
    () => validateLuoguSyncSettings({ ...defaultLuoguSyncSettings(scope.account.id, fx.AT), session: 'secret' }),
    isDomain('invalid_input'),
  );
  // A backlog key of another platform and a non-zero drop counter are both refused.
  assert.throws(
    () => validateLuoguSyncState({ ...state, missingMetadata: ['codeforces:codeforces.com:1A'] }),
    isDomain('invalid_input'),
  );
  assert.throws(() => validateLuoguSyncState({ ...state, backlogDropped: 1 }), isDomain('invalid_input'));

  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await assert.rejects(
      store.saveLuoguConnection(
        { ...connectionFor(scope.account), cookie: 'sessionid=secret' } as unknown as LuoguConnectionState,
        null,
      ),
      isDomain('invalid_input'),
    );
    assert.equal(await store.getLuoguConnection(scope.account.id), null);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }

  // The lease predicates answer "running and mine?", "running at all?" and "running for someone else?".
  assert.equal(luoguLeaseLive(state, null, fx.AT), false);
  assert.equal(luoguLeaseExpired(state, fx.AT), true);
  assert.equal(luoguLeaseHeldByAnother(state, 'worker-a', fx.AT), false);
  const leased: LuoguSyncState = { ...state, owner: 'worker-a', leaseExpiresAt: fx.LATER };
  assert.equal(luoguLeaseLive(leased, 'worker-a', fx.AT), true);
  assert.equal(luoguLeaseLive(leased, null, fx.AT), true);
  assert.equal(luoguLeaseLive(leased, 'worker-b', fx.AT), false);
  assert.equal(luoguLeaseHeldByAnother(leased, 'worker-b', fx.AT), true);
  assert.equal(luoguLeaseHeldByAnother(leased, 'worker-a', fx.AT), false);
  assert.equal(luoguLeaseExpired(leased, fx.AT), false);
  assert.equal(luoguLeaseLive(leased, 'worker-a', fx.LATER), false, 'the deadline itself is expired');
  assert.throws(() => luoguLeaseLive(leased, null, 'yesterday'), isDomain('invalid_timestamp'));
});

void test('a corrupted or identity-swapped Luogu row is reported as corrupt instead of being served', async () => {
  const paths = fx.tempDatabase();
  const alice = luoguScope('500001');
  const bob = luoguScope('500002');
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  await store.upsertSourceInstances([alice.instance]);
  await store.upsertAccounts([alice.account, bob.account]);
  await store.saveLuoguSyncState(emptyLuoguSyncState(alice.account.id, alice.instance.id, fx.AT), null);
  await store.saveLuoguSyncSettings(defaultLuoguSyncSettings(alice.account.id, fx.AT), null);
  await store.saveLuoguConnection(connectionFor(alice.account), null);
  await store.close();
  try {
    rawMutate(paths.path, 'UPDATE luogu_sync_states SET body = ? WHERE account_id = ?', ['{', alice.account.id]);
    store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
    await assert.rejects(store.getLuoguSyncState(alice.account.id), isStorage('corrupt_row'));
    await store.close();

    // A well-formed body for another account under Alice's row is refused as a borrowed identity.
    rawMutate(paths.path, 'UPDATE luogu_sync_states SET body = ? WHERE account_id = ?', [
      canonicalJson(emptyLuoguSyncState(bob.account.id, bob.instance.id, fx.AT)),
      alice.account.id,
    ]);
    store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
    await assert.rejects(store.getLuoguSyncState(alice.account.id), isStorage('corrupt_row'));
    await store.close();

    // A credential-shaped settings body written around the store is refused on read.
    rawMutate(paths.path, 'UPDATE luogu_sync_settings SET body = ? WHERE account_id = ?', [
      canonicalJson({ ...defaultLuoguSyncSettings(alice.account.id, fx.AT), cookie: 'sessionid=secret' }),
      alice.account.id,
    ]);
    store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
    await assert.rejects(store.getLuoguSyncSettings(alice.account.id), isStorage('corrupt_row'));
    await store.close();

    // A connection body whose reference disagrees with its own column is refused by both reads.
    rawMutate(paths.path, 'UPDATE luogu_connections SET body = ? WHERE account_id = ?', [
      canonicalJson(connectionFor(alice.account, { reference: 'credential:luogu:other' })),
      alice.account.id,
    ]);
    store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
    await assert.rejects(store.getLuoguConnection(alice.account.id), isStorage('corrupt_row'));
    await assert.rejects(store.listLuoguConnections(), isStorage('corrupt_row'));
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('a genuine v6 database is copied and migrated to v7 with its rows preserved', async () => {
  const paths = fx.tempDatabase();
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const rating = officialFixture(scope.account.id);
  const db = new DatabaseSync(paths.path);
  try {
    migrateToSchemaV6(db, 0);
    assert.equal(readUserVersion(db), 6, 'the fixture is a real v6 database');
    assert.equal(tableNames(db).includes('luogu_connections'), false, 'v6 has no Luogu tables');
    db.prepare(
      `INSERT INTO source_instances (id, platform, base_url, domain, display_name, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      scope.instance.id,
      scope.instance.platform,
      scope.instance.baseUrl,
      scope.instance.domain,
      scope.instance.displayName,
      canonicalJson(scope.instance),
    );
    db.prepare(
      `INSERT INTO accounts (id, source_instance_id, handle, display_name, profile_url, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      scope.account.id,
      scope.account.sourceInstanceId,
      scope.account.handle,
      scope.account.displayName,
      scope.account.profileUrl,
      canonicalJson(scope.account),
    );
    db.prepare(
      `INSERT INTO problems (key, source_instance_id, domain, external_key, title, fetched_at, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scope.problem.key,
      scope.problem.ref.sourceInstanceId,
      scope.problem.ref.domain,
      scope.problem.ref.externalKey,
      scope.problem.title,
      scope.problem.fetchedAt,
      canonicalJson(scope.problem),
    );
    db.prepare('INSERT INTO official_rating_snapshots (account_id, revision, body) VALUES (?, ?, ?)').run(
      scope.account.id,
      rating.revision,
      canonicalJson(rating),
    );
  } finally {
    db.close();
  }

  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
  try {
    assert.equal(store.capabilities().schemaVersion, STORE_SCHEMA_VERSION);
    assert.deepEqual(await store.getProblem(scope.problem.key), scope.problem, 'the v6 problem body survived');
    assert.deepEqual(await store.getOfficialRating(scope.account.id), rating, 'the v6 rating history survived');
    const luogu = luoguScope('600001');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertAccounts([luogu.account]);
    assert.equal(await store.saveLuoguSyncSettings(defaultLuoguSyncSettings(luogu.account.id, fx.LATER), null), 1);
  } finally {
    await store.close();
  }

  const backups = readdirSync(paths.dir).filter((name) => name.includes('.backup-v6-') && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1, 'exactly one pre-migration copy at the literal v6 is kept');
  const backup = new DatabaseSync(join(paths.dir, backups[0]!), { readOnly: true });
  try {
    assert.equal(readUserVersion(backup), 6, 'the copy is the database as found');
    assert.equal(tableNames(backup).includes('luogu_sync_states'), false);
    assert.equal(backup.prepare('SELECT count(*) AS total FROM problems').get()?.['total'], 1);
    assert.equal(backup.prepare('SELECT count(*) AS total FROM official_rating_snapshots').get()?.['total'], 1);
  } finally {
    backup.close();
  }

  const migrated = new DatabaseSync(paths.path, { readOnly: true });
  try {
    assert.equal(readUserVersion(migrated), STORE_SCHEMA_VERSION);
    for (const table of STORE_TABLES_V7) {
      assert.ok(tableNames(migrated).includes(table), `migrated schema is missing ${table}`);
    }
    assert.equal(migrated.prepare('SELECT count(*) AS total FROM problems').get()?.['total'], 1);
  } finally {
    migrated.close();
  }
  fx.removeDirectory(paths.dir);
});

void test('empty, v0 and every recognized version through v6 migrate to exactly v7 with one backup at its own version', async () => {
  interface Case {
    readonly label: string;
    readonly from: number;
    readonly build: (db: DatabaseSync) => void;
    readonly expectBackup: boolean;
  }
  const cases: readonly Case[] = [
    { label: 'empty', from: 0, expectBackup: false, build: () => {} },
    {
      label: 'marker-only v0',
      from: 0,
      expectBackup: true,
      build: (db) => {
        db.exec(`CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
        db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES ('store_marker', ?)`).run(STORE_MARKER);
      },
    },
    { label: 'v1', from: 1, expectBackup: true, build: (db) => applySchemaV1(db) },
    { label: 'v2', from: 2, expectBackup: true, build: (db) => initializeSchemaV2(db) },
    { label: 'v3', from: 3, expectBackup: true, build: (db) => initializeSchemaV3(db) },
    { label: 'v4', from: 4, expectBackup: true, build: (db) => initializeSchemaV4(db) },
    { label: 'v5', from: 5, expectBackup: true, build: (db) => migrateToSchemaV5(db, 0) },
    { label: 'v6', from: 6, expectBackup: true, build: (db) => migrateToSchemaV6(db, 0) },
  ];
  const paths = fx.tempDatabase();
  try {
    for (const [index, entry] of cases.entries()) {
      const dir = join(paths.dir, `case-${index}-${entry.label.replace(/\s+/gu, '-')}`);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'store.sqlite');
      const fixture = new DatabaseSync(path);
      try {
        entry.build(fixture);
        assert.equal(readUserVersion(fixture), entry.from, `${entry.label} fixture is version ${entry.from}`);
      } finally {
        fixture.close();
      }

      const store = new SqliteTrainingStore({ path, now: () => fx.AT });
      try {
        assert.equal(store.capabilities().schemaVersion, STORE_SCHEMA_VERSION, `${entry.label} opens at the current schema`);
      } finally {
        await store.close();
      }

      const after = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(readUserVersion(after), STORE_SCHEMA_VERSION, `${entry.label} ends at v7`);
        for (const table of STORE_TABLES_V7) {
          assert.ok(tableNames(after).includes(table), `${entry.label} is missing ${table}`);
        }
      } finally {
        after.close();
      }

      const backups = readdirSync(dir).filter((name) => name.includes('.backup-v') && name.endsWith('.sqlite'));
      assert.equal(backups.length, entry.expectBackup ? 1 : 0, `${entry.label} backup count`);
      if (entry.expectBackup) {
        const backup = new DatabaseSync(join(dir, backups[0]!), { readOnly: true });
        try {
          assert.equal(readUserVersion(backup), entry.from, `${entry.label} backup is the file as found`);
        } finally {
          backup.close();
        }
      }
    }
  } finally {
    fx.removeDirectory(paths.dir);
  }
});

void test('a database from a newer schema than v7 is refused before any byte, backup or journal change', () => {
  const paths = fx.tempDatabase();
  const db = new DatabaseSync(paths.path);
  try {
    migrateToSchemaV6(db, 0);
    db.exec('PRAGMA user_version = 8');
  } finally {
    db.close();
  }
  const before = readFileSync(paths.path);
  assert.throws(() => new SqliteTrainingStore({ path: paths.path }), isStorage('schema_too_new'));
  assert.deepEqual(readFileSync(paths.path), before, 'not one byte of the newer database changed');
  assert.deepEqual(readdirSync(paths.dir), ['store.sqlite'], 'no backup and no WAL side file was written');
  fx.removeDirectory(paths.dir);
});

void test('a disconnected account never reissues a connection revision, so a stale writer cannot touch the next session', async () => {
  const paths = fx.tempDatabase();
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const alice = luoguScope('700001');
    const bob = luoguScope('700002');
    await store.upsertSourceInstances([alice.instance]);
    await store.upsertAccounts([alice.account, bob.account]);

    assert.equal(
      await store.saveLuoguConnection(connectionFor(alice.account, { reference: 'credential:luogu:a1' }), null),
      1,
    );
    await store.deleteLuoguConnection(alice.account.id, 1);
    assert.equal(await store.getLuoguConnection(alice.account.id), null);

    // The recreation continues the sequence: revision 1 is gone for good.
    assert.equal(
      await store.saveLuoguConnection(connectionFor(alice.account, { reference: 'credential:luogu:a2' }), null),
      2,
    );
    // A writer that read revision 1 can neither update nor delete the recreated row.
    await assert.rejects(
      store.saveLuoguConnection(connectionFor(alice.account, { reference: 'credential:luogu:a3' }), 1),
      isDomain('invalid_transition'),
    );
    await assert.rejects(store.deleteLuoguConnection(alice.account.id, 1), isDomain('invalid_transition'));
    assert.equal((await store.getLuoguConnection(alice.account.id))?.value.reference, 'credential:luogu:a2');

    // Generations are per account: Bob's first connection still starts at revision 1.
    assert.equal(
      await store.saveLuoguConnection(connectionFor(bob.account, { reference: 'credential:luogu:b1' }), null),
      1,
    );

    // The counter is durable: a restart keeps refusing the old revision.
    await store.close();
    store = new SqliteTrainingStore({ path: paths.path });
    await assert.rejects(
      store.saveLuoguConnection(connectionFor(alice.account, { reference: 'credential:luogu:a4' }), 1),
      isDomain('invalid_transition'),
    );
    await assert.rejects(store.deleteLuoguConnection(alice.account.id, 1), isDomain('invalid_transition'));
    assert.equal((await store.getLuoguConnection(alice.account.id))?.revision, 2);

    // A second deletion and recreation still grows the revision.
    await store.deleteLuoguConnection(alice.account.id, 2);
    assert.equal(
      await store.saveLuoguConnection(connectionFor(alice.account, { reference: 'credential:luogu:a5' }), null),
      3,
    );
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('unlinked credential references are journaled durably, per account, and carry no secret', async () => {
  const paths = fx.tempDatabase();
  // Declared before the try so the corrupted-row check below addresses the *same* canonical
  // `luoguScope('800001').account.id` the writes used: a hand-written id literal is a different
  // string (the compound id escapes its instance part), and reading it would find no row at all.
  const alice = luoguScope('800001');
  const bob = luoguScope('800002');
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await store.upsertSourceInstances([alice.instance]);
    await store.upsertAccounts([alice.account, bob.account]);

    // Only a stored official account may be journaled, and only an opaque reference may be stored.
    await assert.rejects(
      store.appendLuoguConnectionJournal('luogu:www.luogu.com.cn:999999', 'credential:luogu:x'),
      isDomain('missing_reference'),
    );
    await assert.rejects(
      store.appendLuoguConnectionJournal(alice.account.id, 'sessionid=secret'),
      isDomain('invalid_input'),
    );
    assert.throws(
      () =>
        validateLuoguConnectionJournalEntry({
          accountId: alice.account.id,
          reference: 'credential:luogu:p1',
          recordedAt: fx.AT,
          cookie: 'sessionid=secret',
        }),
      isDomain('invalid_input'),
      'a credential-shaped journal body never validates',
    );
    assert.throws(
      () =>
        validateLuoguConnectionJournalEntry({
          accountId: alice.account.id,
          reference: 'sessionid=secret',
          recordedAt: fx.AT,
        }),
      isDomain('invalid_input'),
    );
    const cf = fx.makeScope('codeforces', 'codeforces.com', 'carol', '1A');
    await store.upsertSourceInstances([cf.instance]);
    await store.upsertAccounts([cf.account]);
    await assert.rejects(
      store.appendLuoguConnectionJournal(cf.account.id, 'credential:luogu:x'),
      isDomain('invalid_input'),
    );

    await store.appendLuoguConnectionJournal(alice.account.id, 'credential:luogu:p1');
    await store.appendLuoguConnectionJournal(alice.account.id, 'credential:luogu:p2');
    await store.appendLuoguConnectionJournal(alice.account.id, 'credential:luogu:p1');
    await store.appendLuoguConnectionJournal(bob.account.id, 'credential:luogu:q1');

    assert.deepEqual(
      (await store.listLuoguConnectionJournal(alice.account.id)).map((entry) => entry.reference),
      ['credential:luogu:p1', 'credential:luogu:p2'],
      'a repeated write-ahead step is idempotent',
    );
    assert.deepEqual(
      (await store.listLuoguConnectionJournal(bob.account.id)).map((entry) => entry.reference),
      ['credential:luogu:q1'],
    );
    for (const entry of await store.listLuoguConnectionJournal(alice.account.id)) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['accountId', 'recordedAt', 'reference'],
        'a journal entry is an account, an opaque reference and an instant',
      );
      assert.equal(entry.accountId, alice.account.id);
      assert.equal(entry.recordedAt, fx.AT);
    }

    await store.removeLuoguConnectionJournalEntry(alice.account.id, 'credential:luogu:p1');
    await store.removeLuoguConnectionJournalEntry(alice.account.id, 'credential:luogu:p1');

    await store.close();
    store = new SqliteTrainingStore({ path: paths.path });
    assert.deepEqual(
      (await store.listLuoguConnectionJournal(alice.account.id)).map((entry) => entry.reference),
      ['credential:luogu:p2'],
      'the journal survives a restart',
    );
    assert.deepEqual(
      (await store.listLuoguConnectionJournal(bob.account.id)).map((entry) => entry.reference),
      ['credential:luogu:q1'],
      "another account's journal is untouched",
    );
  } finally {
    await store.close();
  }

  const raw = new DatabaseSync(paths.path, { readOnly: true });
  try {
    const columns = (raw.prepare('PRAGMA table_info(luogu_connection_journal)').all() as readonly Record<string, unknown>[])
      .map((row) => String(row['name']))
      .sort();
    assert.deepEqual(
      columns,
      ['account_id', 'recorded_at', 'reference'],
      'the journal has no column a session cookie could live in',
    );
    const references = (raw.prepare('SELECT reference FROM luogu_connection_journal ORDER BY reference').all() as readonly Record<string, unknown>[])
      .map((row) => String(row['reference']));
    assert.deepEqual(references, ['credential:luogu:p2', 'credential:luogu:q1']);
  } finally {
    raw.close();
  }

  // A hand-edited journal reference is refused on read instead of being served as a reference.
  rawMutate(paths.path, 'UPDATE luogu_connection_journal SET reference = ? WHERE reference = ?', [
    'sessionid=secret',
    'credential:luogu:p2',
  ]);
  // Prove the corrupted row really is this account's journal entry, so the rejection below is the
  // corruption and not an empty read of a misspelled or non-canonical account id.
  const corruptTarget = new DatabaseSync(paths.path, { readOnly: true });
  try {
    const rows = corruptTarget
      .prepare('SELECT reference FROM luogu_connection_journal WHERE account_id = ?')
      .all(alice.account.id) as readonly Record<string, unknown>[];
    assert.deepEqual(
      rows.map((row) => String(row['reference'])),
      ['sessionid=secret'],
      'the hand-edited row is the journal entry of the account under test',
    );
  } finally {
    corruptTarget.close();
  }
  const corrupted = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await assert.rejects(corrupted.listLuoguConnectionJournal(alice.account.id), isStorage('corrupt_row'));
  } finally {
    await corrupted.close();
    fx.removeDirectory(paths.dir);
  }
});
