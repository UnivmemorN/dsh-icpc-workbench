/**
 * Durable bulk material-refresh batches in the real SQLite store (Sprint Contract 34A).
 *
 * These cases are about what the adapter keeps and what it refuses. A batch round-trips through
 * schema v11 with its caller order, per-item selection and store-assigned revision; the compare-and-set
 * token is the only way to advance a row, so a stale writer cannot overwrite newer progress or
 * resurrect a cancelled batch; a completed item is immutable in storage; and a hand-edited or
 * inconsistent row is a `corrupt_row` refusal instead of a guessed batch. The migration half builds a
 * genuine v10 database with the frozen historical helper and proves the current store copies it at v10
 * before migrating, keeps every old row, and refuses a newer database before writing a byte.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteTrainingStore, StorageError, STORE_MARKER, STORE_SCHEMA_VERSION } from '../../src/adapters/sqlite/index.js';
import {
  SCHEMA_VERSION_V10,
  STORE_TABLES_V10,
  STORE_TABLES_V11,
  migrateToSchemaV10,
} from '../../src/adapters/sqlite/schema.js';
import {
  beginMaterialRefreshItem,
  completeMaterialRefreshItem,
  createMaterialRefreshBatch,
  startMaterialRefreshBatch,
  type MaterialRefreshBatch,
  type MaterialRefreshItemResult,
} from '../../src/application/material-refresh-batch-types.js';
import { defaultWorkbenchSettings } from '../../src/application/workbench-settings.js';
import { DomainError, canonicalJson } from '../../src/domain/index.js';
import * as fx from './fixtures.js';

const BATCH_AT = '2026-11-01T08:00:00.000Z';
const BATCH_LATER = '2026-11-01T08:05:00.000Z';
const CONTENT_HASH = 'c'.repeat(64);

interface Fingerprint {
  readonly userVersion: number;
  readonly tables: readonly string[];
  readonly marker: string | null;
  readonly integrity: string;
}

/** Read a database file with raw SQL, independent of the adapter's own readers. */
function fingerprint(path: string): Fingerprint {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const versionRow = db.prepare('PRAGMA user_version').get();
    const version = versionRow?.['user_version'];
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => String(row['name']));
    let marker: string | null = null;
    if (tables.includes('store_meta')) {
      const markerRow = db.prepare(`SELECT value FROM store_meta WHERE key = 'store_marker'`).get();
      marker = typeof markerRow?.['value'] === 'string' ? String(markerRow['value']) : null;
    }
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    const integrity =
      typeof integrityRow?.['integrity_check'] === 'string' ? String(integrityRow['integrity_check']) : 'unknown';
    return { userVersion: typeof version === 'number' ? version : -1, tables, marker, integrity };
  } finally {
    db.close();
  }
}

function rawScalar(path: string, sql: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(sql).get();
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    db.close();
  }
}

function rawExec(path: string, statements: readonly string[]): void {
  const db = new DatabaseSync(path);
  try {
    for (const statement of statements) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

/** Run one callback over a fresh real store and remove its directory afterwards. */
async function withStore(
  run: (store: SqliteTrainingStore, paths: { readonly path: string; readonly dir: string }) => Promise<void>,
): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => BATCH_AT });
  try {
    await run(store, paths);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

function isDomain(code: DomainError['code']): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

function isStorage(code: StorageError['code']): (error: unknown) => boolean {
  return (error) => error instanceof StorageError && error.code === code;
}

function itemResult(changed: boolean): MaterialRefreshItemResult {
  return {
    statement: 'not_requested',
    editorial: 'found',
    mirror: 'skipped',
    sourceCount: 1,
    solutionCount: 1,
    snapshot: { snapshotId: `snapshot-${changed ? 'changed' : 'reused'}`, version: 1, contentHash: CONTENT_HASH, changed },
  };
}

/** Prepare a two-item batch, run item 0 to completion and persist every step. */
async function seedRunningBatch(
  store: SqliteTrainingStore,
  keys: readonly [string, string],
): Promise<{ readonly batch: MaterialRefreshBatch; readonly revision: number }> {
  let batch = createMaterialRefreshBatch({
    batchId: 'material-batch-1',
    createdAt: BATCH_AT,
    items: [{ problemKey: keys[0] }, { problemKey: keys[1] }],
  });
  let revision = await store.saveMaterialRefreshBatch(batch, null);
  batch = startMaterialRefreshBatch(batch, BATCH_LATER);
  revision = await store.saveMaterialRefreshBatch(batch, revision);
  batch = beginMaterialRefreshItem(batch, 0, BATCH_LATER);
  revision = await store.saveMaterialRefreshBatch(batch, revision);
  batch = completeMaterialRefreshItem(batch, 0, itemResult(true), BATCH_LATER);
  revision = await store.saveMaterialRefreshBatch(batch, revision);
  return { batch, revision };
}

// ---------------------------------------------------------------------------------------
// Round-trip, ordering and compare-and-set
// ---------------------------------------------------------------------------------------

void test('a fresh database is a current v11 store whose batch table starts empty', async () => {
  await withStore(async (store, paths) => {
    assert.equal(STORE_SCHEMA_VERSION, 11, 'this stage owns the v10 to v11 bump');
    assert.equal(store.capabilities().schemaVersion, STORE_SCHEMA_VERSION);
    assert.equal(await store.getMaterialRefreshBatch('nothing'), null);
    assert.deepEqual(await store.listMaterialRefreshBatches(null), []);
    const state = fingerprint(paths.path);
    assert.equal(state.userVersion, 11);
    assert.equal(state.marker, STORE_MARKER);
    assert.equal(state.integrity, 'ok');
    assert.deepEqual(state.tables, [...STORE_TABLES_V11].sort());
    assert.equal(rawScalar(paths.path, 'SELECT count(*) FROM material_refresh_batches'), 0);
  });
});

void test('a batch round-trips with caller order, per-item selection and store-assigned revisions', async () => {
  await withStore(async (store) => {
    const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
    const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
    const batch = createMaterialRefreshBatch({
      batchId: 'material-batch-order',
      createdAt: BATCH_AT,
      items: [
        { problemKey: second.problem.key },
        {
          problemKey: alice.problem.key,
          accountId: alice.account.id,
          officialTutorialUrl: 'https://codeforces.com/blog/entry/1',
          fetchStatement: false,
        },
      ],
    });

    assert.equal(await store.saveMaterialRefreshBatch(batch, null), 1);
    const stored = await store.getMaterialRefreshBatch('material-batch-order');
    assert.deepEqual(stored, { ...batch, revision: 1 });
    assert.deepEqual(
      stored?.items.map((item) => item.problemKey),
      [second.problem.key, alice.problem.key],
      'the indexed item_count and the body keep the caller order',
    );
    assert.equal(
      await store.saveMaterialRefreshBatch(startMaterialRefreshBatch(stored as MaterialRefreshBatch, BATCH_LATER), 1),
      2,
    );
    const advanced = await store.getMaterialRefreshBatch('material-batch-order');
    assert.equal(advanced?.revision, 2);
    assert.equal(advanced?.status, 'running');
    assert.equal(advanced?.startedAt, BATCH_LATER);
    assert.deepEqual(advanced?.items, stored?.items, 'starting a batch never rewrites its items');

    const third = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900C');
    const earlier = createMaterialRefreshBatch({
      batchId: 'material-batch-earlier',
      createdAt: '2026-11-01T07:00:00.000Z',
      items: [{ problemKey: third.problem.key }],
    });
    assert.equal(await store.saveMaterialRefreshBatch(earlier, null), 1);
    assert.deepEqual(
      (await store.listMaterialRefreshBatches(null)).map((entry) => entry.batchId),
      ['material-batch-earlier', 'material-batch-order'],
      'the list read is ordered and complete',
    );
    assert.deepEqual(
      (await store.listMaterialRefreshBatches('running')).map((entry) => entry.batchId),
      ['material-batch-order'],
    );
    assert.deepEqual(await store.listMaterialRefreshBatches('completed'), []);
    await assert.rejects(store.listMaterialRefreshBatches('nope' as never), isDomain('invalid_input'));
  });
});

void test('the store enforces compare-and-set and refuses a create over an existing batch', async () => {
  await withStore(async (store) => {
    const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
    const batch = createMaterialRefreshBatch({
      batchId: 'material-batch-cas',
      createdAt: BATCH_AT,
      items: [{ problemKey: alice.problem.key }],
    });

    assert.equal(await store.saveMaterialRefreshBatch(batch, null), 1);
    // A create must pass `null`; naming the revision that was read is the only way to advance a row.
    await assert.rejects(store.saveMaterialRefreshBatch(batch, null), isDomain('duplicate_id'));
    assert.equal(await store.saveMaterialRefreshBatch(batch, 1), 2, 'a matching revision is a legal update');
    await assert.rejects(
      store.saveMaterialRefreshBatch(startMaterialRefreshBatch(batch, BATCH_LATER), 99),
      isDomain('invalid_transition'),
    );
    await assert.rejects(store.saveMaterialRefreshBatch(batch, 0), isDomain('invalid_input'));

    const absent = createMaterialRefreshBatch({
      batchId: 'material-batch-absent',
      createdAt: BATCH_AT,
      items: [{ problemKey: alice.problem.key }],
    });
    await assert.rejects(store.saveMaterialRefreshBatch(absent, 1), isDomain('invalid_transition'));

    const after = await store.getMaterialRefreshBatch('material-batch-cas');
    assert.equal(after?.revision, 2);
    assert.deepEqual(
      { ...(after as MaterialRefreshBatch), revision: 1 },
      { ...batch, revision: 1 },
      'a matching-revision save rewrote no part of the body',
    );
    assert.equal(await store.getMaterialRefreshBatch('material-batch-absent'), null);

    // A legal update moves both the body revision and the indexed column together.
    assert.equal(
      await store.saveMaterialRefreshBatch(startMaterialRefreshBatch(after as MaterialRefreshBatch, BATCH_LATER), 2),
      3,
    );
    assert.equal((await store.getMaterialRefreshBatch('material-batch-cas'))?.revision, 3);
  });
});

void test('a completed item is immutable in storage and a legal attempt step is persisted', async () => {
  await withStore(async (store) => {
    const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
    const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
    const third = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900C');
    const seeded = await seedRunningBatch(store, [alice.problem.key, second.problem.key]);
    const completedItem = seeded.batch.items[0];
    const pendingItem = seeded.batch.items[1];
    assert.ok(completedItem);
    assert.ok(pendingItem);
    assert.equal(seeded.revision, 4);

    const rewritten = {
      ...seeded.batch,
      items: [
        { ...completedItem, result: { ...(completedItem.result as MaterialRefreshItemResult), solutionCount: 42 } },
        pendingItem,
      ],
    } as MaterialRefreshBatch;
    await assert.rejects(store.saveMaterialRefreshBatch(rewritten, seeded.revision), isDomain('immutable_violation'));

    const renamed = {
      ...seeded.batch,
      items: [{ ...completedItem, problemKey: third.problem.key }, pendingItem],
    } as unknown as MaterialRefreshBatch;
    await assert.rejects(store.saveMaterialRefreshBatch(renamed, seeded.revision), isDomain('immutable_violation'));

    const begun = beginMaterialRefreshItem(seeded.batch, 1, BATCH_LATER);
    assert.equal(await store.saveMaterialRefreshBatch(begun, seeded.revision), 5);
    const stored = await store.getMaterialRefreshBatch('material-batch-1');
    assert.equal(stored?.items[1]?.status, 'running');
    assert.equal(stored?.items[1]?.attempts, 1);
    assert.deepEqual(stored?.items[0], completedItem, 'the completed item keeps its committed snapshot');

    // The same revision may not be reused once it was consumed.
    await assert.rejects(
      store.saveMaterialRefreshBatch(seeded.batch, seeded.revision),
      isDomain('invalid_transition'),
    );
  });
});

void test('a malformed, hand-edited or inconsistent row is a corrupt_row refusal, never repaired', async () => {
  const paths = fx.tempDatabase();
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const batch = createMaterialRefreshBatch({
    batchId: 'material-batch-corrupt',
    createdAt: BATCH_AT,
    items: [{ problemKey: alice.problem.key }],
  });
  const open = new SqliteTrainingStore({ path: paths.path, now: () => BATCH_AT });
  await open.saveMaterialRefreshBatch(batch, null);
  await open.close();

  const validBody = canonicalJson({ ...batch, revision: 1 });
  const corruptions: readonly { readonly label: string; readonly apply: (db: DatabaseSync) => void }[] = [
    {
      label: 'an undeclared credential-like member',
      apply: (db) =>
        db
          .prepare(`UPDATE material_refresh_batches SET body = ? WHERE batch_id = 'material-batch-corrupt'`)
          .run(JSON.stringify({ ...(JSON.parse(validBody) as Record<string, unknown>), cookie: 'session=1' })),
    },
    {
      label: 'a body that is not JSON at all',
      apply: (db) =>
        db
          .prepare(`UPDATE material_refresh_batches SET body = ? WHERE batch_id = 'material-batch-corrupt'`)
          .run('not a batch'),
    },
    {
      label: 'a status column disagreeing with the body',
      apply: (db) =>
        db.exec(`UPDATE material_refresh_batches SET status = 'paused' WHERE batch_id = 'material-batch-corrupt'`),
    },
    {
      label: 'an item_count column disagreeing with the body',
      apply: (db) =>
        db.exec(`UPDATE material_refresh_batches SET item_count = 99 WHERE batch_id = 'material-batch-corrupt'`),
    },
  ];

  for (const corruption of corruptions) {
    const db = new DatabaseSync(paths.path);
    try {
      db.prepare(
        `UPDATE material_refresh_batches SET body = ?, status = 'prepared', item_count = 1
          WHERE batch_id = 'material-batch-corrupt'`,
      ).run(validBody);
      corruption.apply(db);
    } finally {
      db.close();
    }

    const store = new SqliteTrainingStore({ path: paths.path, now: () => BATCH_AT });
    try {
      await assert.rejects(
        store.getMaterialRefreshBatch('material-batch-corrupt'),
        isStorage('corrupt_row'),
        `${corruption.label} must be refused`,
      );
      await assert.rejects(store.listMaterialRefreshBatches(null), isStorage('corrupt_row'));
      assert.equal(
        rawScalar(paths.path, 'SELECT count(*) FROM material_refresh_batches'),
        1,
        'the store never deletes or repairs the row it refuses',
      );
    } finally {
      await store.close();
    }
  }
  fx.removeDirectory(paths.dir);
});

// ---------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------

interface V10World {
  readonly scope: fx.Scope;
  readonly disposition: {
    readonly problemKey: string;
    readonly state: 'skipped';
    readonly sourceInstanceId: string;
    readonly initiatorAccountId: string;
    readonly updatedAt: string;
  };
}

/** Build a genuine v10 database with rows, using the frozen historical helper. */
function seedV10(path: string): V10World {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const disposition = {
    problemKey: scope.problem.key,
    state: 'skipped' as const,
    sourceInstanceId: scope.instance.id,
    initiatorAccountId: scope.account.id,
    updatedAt: fx.AT,
  };
  const db = new DatabaseSync(path);
  try {
    migrateToSchemaV10(db, 0);
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
    db.prepare(`INSERT INTO workbench_settings (id, revision, body) VALUES (1, 1, ?)`).run(
      canonicalJson(defaultWorkbenchSettings()),
    );
    db.prepare(
      `INSERT INTO problem_dispositions (problem_key, state, source_instance_id, initiator_account_id, updated_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      disposition.problemKey,
      disposition.state,
      disposition.sourceInstanceId,
      disposition.initiatorAccountId,
      disposition.updatedAt,
      canonicalJson(disposition),
    );
  } finally {
    db.close();
  }
  assert.equal(rawScalar(path, 'PRAGMA user_version'), SCHEMA_VERSION_V10, 'the fixture is a schema-v10 database');
  return { scope, disposition };
}

void test('a genuine v10 database is backed up at v10 and migrated to v11 with every row retained', async () => {
  const paths = fx.tempDatabase();
  const world = seedV10(paths.path);
  const before = fingerprint(paths.path);
  assert.equal(before.userVersion, SCHEMA_VERSION_V10);
  assert.deepEqual(before.tables, [...STORE_TABLES_V10].sort(), 'the fixture is exactly a v10 store');

  const store = new SqliteTrainingStore({ path: paths.path, now: () => BATCH_LATER });
  try {
    assert.equal(store.capabilities().schemaVersion, 11);
    assert.deepEqual(await store.getProblem(world.scope.problem.key), world.scope.problem, 'the v10 problem survived');
    const settings = await store.getWorkbenchSettings();
    assert.equal(settings?.revision, 1);
    assert.deepEqual(settings?.value, defaultWorkbenchSettings(), 'the v10 settings survived');
    assert.deepEqual(
      await store.getProblemDisposition(world.scope.problem.key),
      world.disposition,
      'the v10 disposition survived',
    );
    // The new table is usable on the migrated file, and no v10 row was rewritten by the migration.
    const batch = createMaterialRefreshBatch({
      batchId: 'material-batch-after-migration',
      createdAt: BATCH_LATER,
      items: [{ problemKey: world.scope.problem.key }],
    });
    assert.equal(await store.saveMaterialRefreshBatch(batch, null), 1);
  } finally {
    await store.close();
  }

  const migrated = fingerprint(paths.path);
  assert.equal(migrated.userVersion, 11);
  assert.equal(migrated.marker, STORE_MARKER);
  assert.equal(migrated.integrity, 'ok');
  assert.deepEqual(migrated.tables, [...STORE_TABLES_V11].sort(), 'v11 adds exactly the batch table');
  assert.equal(rawScalar(paths.path, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(rawScalar(paths.path, 'SELECT count(*) FROM problem_dispositions'), 1);
  assert.equal(rawScalar(paths.path, 'SELECT count(*) FROM material_refresh_batches'), 1);

  const backups = readdirSync(paths.dir).filter((name) => name.includes('.backup-v10-') && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1, 'exactly one pre-migration copy at the literal v10 is kept');
  const backupPath = join(paths.dir, backups[0] as string);
  const backup = fingerprint(backupPath);
  assert.equal(backup.userVersion, SCHEMA_VERSION_V10, 'the copy is the database as found');
  assert.equal(backup.marker, STORE_MARKER);
  assert.equal(backup.integrity, 'ok');
  assert.deepEqual(backup.tables, [...STORE_TABLES_V10].sort());
  assert.equal(rawScalar(backupPath, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(rawScalar(backupPath, 'SELECT count(*) FROM problem_dispositions'), 1);
  assert.equal(
    rawScalar(backupPath, `SELECT count(*) FROM sqlite_master WHERE name = 'material_refresh_batches'`),
    0,
    'the copy predates the v11 table',
  );
  fx.removeDirectory(paths.dir);
});

void test('a v10 migration that cannot finish rolls back and leaves the v10 file and its copy readable', () => {
  const paths = fx.tempDatabase();
  const world = seedV10(paths.path);
  // A view named `material_refresh_batches` makes the v11 DDL statement fail.
  rawExec(paths.path, ['CREATE VIEW material_refresh_batches AS SELECT 1 AS batch_id']);

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    (error) => error instanceof StorageError && error.code === 'migration_failed',
  );

  const after = fingerprint(paths.path);
  assert.equal(after.userVersion, SCHEMA_VERSION_V10, 'the failed migration was rolled back to v10');
  assert.equal(after.marker, STORE_MARKER);
  assert.equal(after.integrity, 'ok');
  assert.deepEqual(after.tables, [...STORE_TABLES_V10].sort(), 'no v11 table replaced the conflicting view');
  assert.equal(rawScalar(paths.path, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(
    rawScalar(paths.path, `SELECT count(*) FROM sqlite_master WHERE type = 'view' AND name = 'material_refresh_batches'`),
    1,
    'the conflicting object is still there, not silently dropped',
  );

  const backups = readdirSync(paths.dir).filter((name) => name.includes('.backup-v10-') && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1, 'the pre-migration copy survives the failed migration');
  const backup = fingerprint(join(paths.dir, backups[0] as string));
  assert.equal(backup.userVersion, SCHEMA_VERSION_V10);
  assert.equal(backup.integrity, 'ok');
  assert.deepEqual(backup.tables, [...STORE_TABLES_V10].sort());
  assert.equal(
    rawScalar(join(paths.dir, backups[0] as string), 'SELECT count(*) FROM problem_dispositions'),
    1,
  );
  fx.removeDirectory(paths.dir);
});

void test('a database newer than v11 is refused before anything is written', () => {
  const paths = fx.tempDatabase();
  rawExec(paths.path, [
    'CREATE TABLE problems (x TEXT)',
    `INSERT INTO problems (x) VALUES ('foreign data')`,
    `PRAGMA user_version = ${STORE_SCHEMA_VERSION + 1}`,
  ]);
  const before = fingerprint(paths.path);
  const beforeBytes = readFileSync(paths.path);
  assert.equal(before.userVersion, 12);

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    (error) => error instanceof StorageError && error.code === 'schema_too_new',
  );

  assert.deepEqual(fingerprint(paths.path), before, 'the newer database is not migrated, reset or re-versioned');
  assert.deepEqual(readFileSync(paths.path), beforeBytes, 'not one byte of the file changed');
  assert.equal(rawScalar(paths.path, 'SELECT x FROM problems'), 'foreign data');
  fx.removeDirectory(paths.dir);
});

void test('a current v11 database with an extra user table is refused before any write', async () => {
  const paths = fx.tempDatabase();
  const created = new SqliteTrainingStore({ path: paths.path, now: () => BATCH_AT });
  await created.close();
  rawExec(paths.path, [
    'CREATE TABLE extra_material_table (id TEXT PRIMARY KEY, payload TEXT)',
    `INSERT INTO extra_material_table (id, payload) VALUES ('a', 'kept')`,
  ]);
  const before = fingerprint(paths.path);
  assert.equal(before.userVersion, STORE_SCHEMA_VERSION);
  assert.ok(before.tables.includes('extra_material_table'), 'the fixture really carries an unexpected table');

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    isStorage('unsupported_schema'),
    'a recognized version with an unexpected table is not the database it claims to be',
  );

  const after = fingerprint(paths.path);
  assert.deepEqual(after, before, 'the refused database is not migrated, re-versioned or repaired');
  assert.equal(rawScalar(paths.path, 'SELECT payload FROM extra_material_table'), 'kept');
  assert.equal(
    readdirSync(paths.dir).filter((name) => name.includes('.backup-')).length,
    0,
    'a layout this build does not recognize is never backed up',
  );
  fx.removeDirectory(paths.dir);
});

void test('a current v11 database missing one of its tables is refused instead of completed', async () => {
  const paths = fx.tempDatabase();
  const created = new SqliteTrainingStore({ path: paths.path, now: () => BATCH_AT });
  await created.close();
  rawExec(paths.path, ['DROP TABLE material_refresh_batches']);
  assert.equal(rawScalar(paths.path, 'PRAGMA user_version'), STORE_SCHEMA_VERSION);

  assert.throws(() => new SqliteTrainingStore({ path: paths.path }), isStorage('unsupported_schema'));

  assert.equal(rawScalar(paths.path, 'PRAGMA user_version'), STORE_SCHEMA_VERSION, 'no version was rewritten');
  assert.equal(
    rawScalar(paths.path, `SELECT count(*) FROM sqlite_master WHERE name = 'material_refresh_batches'`),
    0,
    'the refused open does not re-create the missing table',
  );
  fx.removeDirectory(paths.dir);
});

void test('a migratable v10 database with an extra user table is refused before any backup or write', () => {
  const paths = fx.tempDatabase();
  const world = seedV10(paths.path);
  rawExec(paths.path, [
    'CREATE TABLE extra_v10_table (id TEXT PRIMARY KEY, payload TEXT)',
    `INSERT INTO extra_v10_table (id, payload) VALUES ('a', 'kept')`,
  ]);
  const before = fingerprint(paths.path);
  const beforeBytes = readFileSync(paths.path);
  assert.equal(before.userVersion, SCHEMA_VERSION_V10);
  assert.ok(before.tables.includes('extra_v10_table'));
  assert.equal(rawScalar(paths.path, 'PRAGMA journal_mode'), 'delete', 'the fixture is a genuine v10 file');

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    isStorage('unsupported_schema'),
    'a migratable version with an unexpected table must not be migrated',
  );

  assert.deepEqual(fingerprint(paths.path), before, 'the v10 database is left exactly as found');
  assert.deepEqual(readFileSync(paths.path), beforeBytes, 'not one byte of the v10 file changed');
  assert.equal(rawScalar(paths.path, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(rawScalar(paths.path, 'SELECT payload FROM extra_v10_table'), 'kept');
  assert.equal(
    rawScalar(paths.path, 'PRAGMA journal_mode'),
    'delete',
    'a refused database is never reconfigured for WAL',
  );
  assert.equal(
    readdirSync(paths.dir).filter((name) => name.includes('.backup-')).length,
    0,
    'no pre-migration backup is taken for a layout this build does not recognize',
  );
  fx.removeDirectory(paths.dir);
});
