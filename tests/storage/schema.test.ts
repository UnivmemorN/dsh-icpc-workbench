/**
 * Schema versioning, migration and backup.
 *
 * These cases are about what the adapter refuses to do. A database from a newer build, a
 * database with tables this build does not know, and a migration that cannot finish must all
 * leave the original file exactly as it was — byte for byte, journal mode included; a
 * supported older database must be copied consistently *before* it is migrated, so the copy is
 * the file as found rather than a reconfigured one; and a verified copy must be usable as a
 * replacement. Connection configuration (WAL, synchronous) happens only after the database is
 * known to be current or has been migrated successfully.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  SCHEMA_VERSION_V2,
  SqliteTrainingStore,
  StorageError,
  STORE_MARKER,
  STORE_SCHEMA_VERSION,
  STORE_TABLES_V1,
  STORE_TABLES_V2,
  STORE_TABLES_V3,
} from '../../src/adapters/sqlite/index.js';
import {
  SCHEMA_VERSION_V3,
  SCHEMA_VERSION_V8,
  STORE_TABLES_V4,
  STORE_TABLES_V8,
  STORE_TABLES_V11,
  applySchemaV1,
  applySchemaV3,
  initializeSchemaV2,
  initializeSchemaV3,
  migrateSchemaV1ToV2,
  migrateToSchemaV8,
} from '../../src/adapters/sqlite/schema.js';
import { createAnalysisBatch } from '../../src/application/batch-types.js';
import { defaultWorkbenchSettings } from '../../src/application/workbench-settings.js';
import {
  canonicalJson,
  type AnalysisJobState,
  type ManualTagDecision,
  type ProblemSnapshot,
} from '../../src/domain/index.js';
import * as fx from './fixtures.js';

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
    const integrity = typeof integrityRow?.['integrity_check'] === 'string' ? String(integrityRow['integrity_check']) : 'unknown';
    return { userVersion: typeof version === 'number' ? version : -1, tables, marker, integrity };
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

function rawScalar(path: string, sql: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(sql).get();
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    db.close();
  }
}

/**
 * Build a real schema-v1 database with rows, using the frozen v1 DDL.
 *
 * `applySchemaV1` must keep producing exactly what the previous build wrote, so this fixture
 * is a genuine older database rather than a v2 shape carrying a lower version number.
 */
function seedV1(path: string, scope: fx.Scope, job: AnalysisJobState, manual: ManualTagDecision): void {
  const db = new DatabaseSync(path);
  try {
    applySchemaV1(db);
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
    db.prepare(
      `INSERT INTO jobs (job_id, problem_key, snapshot_id, status, attempts, analysis_calls, reasoning_calls,
         retries, created_at, updated_at, lease_owner, lease_expires_at, analysis_id, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.jobId,
      job.problemKey,
      job.snapshotId,
      job.status,
      job.attempts,
      job.counters.analysisCalls,
      job.counters.reasoningCalls,
      job.counters.retries,
      job.createdAt,
      job.updatedAt,
      job.leaseOwner,
      job.leaseExpiresAt,
      job.analysisId,
      canonicalJson(job),
    );
    db.prepare(
      `INSERT INTO manual_decisions (decision_id, problem_key, taxonomy_id, action, decided_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(manual.decisionId, manual.problemKey, manual.taxonomyId, manual.action, manual.decidedAt, canonicalJson(manual));
    db.prepare(`INSERT INTO manual_revisions (problem_key, revision, updated_at) VALUES (?, 1, ?)`).run(
      scope.problem.key,
      fx.AT,
    );
  } finally {
    db.close();
  }
  assert.equal(rawScalar(path, 'PRAGMA user_version'), 1, 'the fixture is a schema-v1 database');
}

interface V1World {
  readonly scope: fx.Scope;
  readonly snapshot: ProblemSnapshot;
  readonly job: AnalysisJobState;
  readonly manual: ManualTagDecision;
}

/** One real v1 database: a problem, its job, one manual decision and the manual revision. */
function seedV1World(path: string): V1World {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const snapshot = fx.makeSnapshot(scope.problem);
  const job = fx.makeJob(scope.problem, snapshot);
  const manual = fx.makeManualDecision(scope.problem, fx.SEGMENT_TREE_TAG, 'accept', fx.AT, 'manual note');
  seedV1(path, scope, job, manual);
  return { scope, snapshot, job, manual };
}

interface V2World {
  readonly scope: fx.Scope;
  readonly batch: ReturnType<typeof createAnalysisBatch>;
}

/**
 * Build a real schema-v2 database with rows using the frozen v1+v2 DDL.
 *
 * `initializeSchemaV2` must keep producing exactly the v2 shape (no v3 tables), so this is a
 * genuine older database rather than a v3 file carrying a lower version number.
 */
function seedV2World(path: string): V2World {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'bob', '2B');
  const snapshot = fx.makeSnapshot(scope.problem);
  const job = fx.makeJob(scope.problem, snapshot);
  const batch = createAnalysisBatch({
    batchId: 'batch-in-v2',
    jobs: [{ jobId: job.jobId, snapshotId: snapshot.snapshotId }],
    createdAt: fx.AT,
  });
  const db = new DatabaseSync(path);
  try {
    initializeSchemaV2(db);
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
    db.prepare(
      `INSERT INTO analysis_batches (batch_id, status, revision, created_at, updated_at, lease_owner,
         lease_expires_at, analysis_calls, reasoning_calls, retries, job_count, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      batch.batchId,
      batch.status,
      1,
      batch.createdAt,
      batch.updatedAt,
      batch.owner,
      batch.leaseExpiresAt,
      batch.counters.analysisCalls,
      batch.counters.reasoningCalls,
      batch.counters.retries,
      batch.jobs.length,
      canonicalJson({ ...batch, revision: 1 }),
    );
  } finally {
    db.close();
  }
  assert.equal(rawScalar(path, 'PRAGMA user_version'), SCHEMA_VERSION_V2, 'the fixture is a schema-v2 database');
  assert.equal(
    rawScalar(path, `SELECT count(*) FROM sqlite_master WHERE name IN ('workbench_settings', 'coaching_attempts')`),
    0,
    'a v2 database has no v3 tables',
  );
  return { scope, batch };
}

void test('a fresh path is initialized with the marker, the current schema and its parent directory', async () => {
  const paths = fx.tempDatabase();
  const nested = join(paths.dir, 'data', 'nested', 'store.sqlite');
  assert.equal(existsSync(nested), false);
  const store = new SqliteTrainingStore({ path: nested, now: () => fx.AT });
  await store.close();

  const state = fingerprint(nested);
  assert.equal(state.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(state.marker, STORE_MARKER);
  assert.equal(state.integrity, 'ok');
  for (const table of [
    'ability_evaluation_attempts',
    'accounts',
    'analyses',
    'coaching_attempts',
    'jobs',
    'luogu_connection_generations',
    'luogu_connection_journal',
    'luogu_connections',
    'luogu_sync_settings',
    'luogu_sync_states',
    'manual_decisions',
    'manual_revisions',
    'material_refresh_batches',
    'plan_attempts',
    'plans',
    'problems',
    'retrospectives',
    'snapshot_heads',
    'snapshots',
    'source_instances',
    'store_meta',
    'submissions',
    'sync_checkpoints',
    'tag_decisions',
    'virtual_performance_ledgers',
    'workbench_settings',
  ]) {
    assert.ok(state.tables.includes(table), `schema is missing ${table}`);
  }
  assert.equal(rawScalar(nested, 'SELECT count(*) FROM coaching_attempts'), 0, 'the reserved coaching table starts empty');
  assert.equal(rawScalar(nested, 'SELECT count(*) FROM plan_attempts'), 0, 'the planning table starts empty');
  assert.equal(rawScalar(nested, 'SELECT count(*) FROM workbench_settings'), 0, 'settings are written only by a save');
  assert.equal(
    rawScalar(nested, 'SELECT count(*) FROM virtual_performance_ledgers'),
    0,
    'no account has a virtual-contest ledger before a save',
  );
  assert.equal(
    rawScalar(nested, 'SELECT count(*) FROM ability_evaluation_attempts'),
    0,
    'the reserved ability-evaluation table starts empty',
  );
  assert.equal(
    rawScalar(nested, 'SELECT count(*) FROM material_refresh_batches'),
    0,
    'no bulk material-refresh batch exists before a prepare',
  );
  fx.removeDirectory(paths.dir);
});

void test('a database from a newer schema is rejected before anything is written', () => {
  const paths = fx.tempDatabase();
  rawExec(paths.path, [
    'CREATE TABLE problems (x TEXT)',
    `INSERT INTO problems (x) VALUES ('foreign data')`,
    // Explicitly verify a v12 database is refused by this build's v11 store before any write.
    `PRAGMA user_version = ${STORE_SCHEMA_VERSION + 1}`,
  ]);
  assert.equal(STORE_SCHEMA_VERSION, 11);
  assert.equal(rawScalar(paths.path, 'PRAGMA user_version'), 12);
  const before = fingerprint(paths.path);
  const beforeBytes = readFileSync(paths.path);
  assert.equal(rawScalar(paths.path, 'PRAGMA journal_mode'), 'delete', 'the fixture starts in rollback journal mode');

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    (error) => error instanceof StorageError && error.code === 'schema_too_new',
  );

  const after = fingerprint(paths.path);
  assert.deepEqual(after, before, 'the newer database is not migrated, reset or re-versioned');
  assert.deepEqual(readFileSync(paths.path), beforeBytes, 'not one byte of the file changed');
  assert.equal(
    rawScalar(paths.path, 'PRAGMA journal_mode'),
    'delete',
    'the connection was never reconfigured (no WAL switch) for a database this build refuses',
  );
  assert.equal(rawScalar(paths.path, 'SELECT x FROM problems'), 'foreign data');
  assert.equal(after.tables.includes('store_meta'), false, 'no store metadata was added');
  fx.removeDirectory(paths.dir);
});

/**
 * A genuine v8 database, built with the frozen v8 helper, is the compatibility boundary of v9.
 *
 * v9 changes no table, so the only difference between the two shapes is the version marker and the
 * JSON contract inside `luogu_sync_states.body`. This fixture therefore proves both halves: the
 * frozen helper still writes the literal `user_version = 8` with exactly the v8 table set, and the
 * current store copies that file at v8 before migrating it to v9 without rewriting a row.
 */
void test('a genuine v8 database is backed up at v8 and migrated to the current schema with every row kept', async () => {
  const paths = fx.tempDatabase();
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'carol', '3C');
  const db = new DatabaseSync(paths.path);
  try {
    migrateToSchemaV8(db, 0);
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
  } finally {
    db.close();
  }
  const before = fingerprint(paths.path);
  assert.equal(before.userVersion, SCHEMA_VERSION_V8, 'the fixture is a schema-v8 database');
  assert.deepEqual(before.tables, [...STORE_TABLES_V8].sort(), 'the fixture is exactly a v8 store');

  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
  try {
    assert.equal(store.capabilities().schemaVersion, STORE_SCHEMA_VERSION);
    assert.deepEqual(await store.getProblem(scope.problem.key), scope.problem, 'the v8 problem body survived');
  } finally {
    await store.close();
  }

  const migrated = fingerprint(paths.path);
  assert.equal(migrated.userVersion, STORE_SCHEMA_VERSION, 'the genuine v8 file ends at the current schema');
  assert.equal(migrated.marker, STORE_MARKER);
  assert.equal(migrated.integrity, 'ok');
  assert.deepEqual(migrated.tables, [...STORE_TABLES_V11].sort(), 'current schema adds the bulk material-refresh table');
  assert.equal(rawScalar(paths.path, 'SELECT body FROM problems'), canonicalJson(scope.problem));

  const backups = readdirSync(paths.dir).filter((name) => name.includes('.backup-v8-') && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1, 'exactly one pre-migration copy at the literal v8 is kept');
  const backup = fingerprint(join(paths.dir, backups[0]!));
  assert.equal(backup.userVersion, SCHEMA_VERSION_V8, 'the copy is the database as found');
  assert.equal(backup.marker, STORE_MARKER);
  assert.equal(backup.integrity, 'ok');
  assert.deepEqual(backup.tables, [...STORE_TABLES_V8].sort());
  assert.equal(rawScalar(join(paths.dir, backups[0]!), 'SELECT body FROM problems'), canonicalJson(scope.problem));
  fx.removeDirectory(paths.dir);
});

void test('a v0 database with unrecognized tables is rejected instead of migrated', () => {
  const paths = fx.tempDatabase();
  rawExec(paths.path, ['CREATE TABLE foreign_table (id TEXT PRIMARY KEY, payload TEXT)', `INSERT INTO foreign_table VALUES ('a', 'b')`]);
  const before = fingerprint(paths.path);

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    (error) => error instanceof StorageError && error.code === 'unsupported_schema',
  );

  assert.deepEqual(fingerprint(paths.path), before);
  assert.equal(rawScalar(paths.path, 'SELECT payload FROM foreign_table'), 'b');
  fx.removeDirectory(paths.dir);
});

void test('a supported v0 database is backed up before it is migrated', async () => {
  const paths = fx.tempDatabase();
  rawExec(paths.path, [
    'CREATE TABLE store_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
    `INSERT INTO store_meta (key, value) VALUES ('store_marker', '${STORE_MARKER}')`,
  ]);

  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  await store.upsertProblems([scope.problem]);
  await store.close();

  const backupNames = readdirSync(paths.dir).filter((name) => name.includes('.backup-v0-') && name.endsWith('.sqlite'));
  assert.equal(backupNames.length, 1, 'exactly one pre-migration backup is kept');
  const [backupName] = backupNames;
  assert.ok(backupName);
  const backupPath = join(paths.dir, backupName);
  const backup = fingerprint(backupPath);
  assert.equal(backup.userVersion, 0, 'the backup is the pre-migration database');
  assert.equal(backup.marker, STORE_MARKER);
  assert.equal(backup.integrity, 'ok');
  assert.deepEqual(backup.tables, ['store_meta']);
  assert.equal(
    rawScalar(backupPath, 'PRAGMA journal_mode'),
    'delete',
    'the backup was taken before the connection was configured for WAL',
  );

  const migrated = fingerprint(paths.path);
  assert.equal(migrated.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(migrated.marker, STORE_MARKER);
  assert.ok(migrated.tables.includes('problems'));
  assert.equal(rawScalar(paths.path, 'PRAGMA journal_mode'), 'wal', 'the migrated database is configured afterwards');
  fx.removeDirectory(paths.dir);
});

void test('a v1 database is copied, then migrated to v3 with every row kept', async () => {
  const paths = fx.tempDatabase();
  const world = seedV1World(paths.path);
  const before = fingerprint(paths.path);
  assert.equal(before.userVersion, 1);
  assert.deepEqual(before.tables, [...STORE_TABLES_V1].sort(), 'the fixture is exactly a v1 store');

  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
  try {
    assert.deepEqual(await store.getProblem(world.scope.problem.key), world.scope.problem, 'the problem body survived');
    assert.deepEqual(await store.getJob(world.job.jobId), world.job, 'job status and counters survived');
    assert.equal(await store.getManualRevision(world.scope.problem.key), 1, 'the manual revision survived');
    assert.deepEqual(await store.listManualDecisions(world.scope.problem.key), [world.manual]);
    const batch = createAnalysisBatch({
      batchId: 'batch-after-v1-migration',
      jobs: [{ jobId: world.job.jobId, snapshotId: world.snapshot.snapshotId }],
      createdAt: fx.LATER,
    });
    assert.equal(await store.saveBatch(batch, null), 1, 'the added v2 tables are usable on the migrated file');
    assert.equal(
      await store.saveWorkbenchSettings(defaultWorkbenchSettings(), null),
      1,
      'the v3 settings table is usable too',
    );
  } finally {
    await store.close();
  }

  const migrated = fingerprint(paths.path);
  assert.equal(migrated.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(migrated.marker, STORE_MARKER);
  assert.equal(migrated.integrity, 'ok');
  for (const table of STORE_TABLES_V4) {
    assert.ok(migrated.tables.includes(table), `migrated schema is missing ${table}`);
  }
  assert.equal(
    rawScalar(paths.path, 'PRAGMA journal_mode'),
    'wal',
    'the migrated database is configured after a successful migration',
  );
  assert.equal(rawScalar(paths.path, 'SELECT revision FROM workbench_settings'), 1);
  assert.equal(
    rawScalar(paths.path, 'SELECT count(*) FROM coaching_attempts'),
    0,
    'the reserved coaching table stays empty',
  );
  assert.equal(rawScalar(paths.path, 'SELECT count(*) FROM plan_attempts'), 0, 'the planning table is created empty');

  const backupNames = readdirSync(paths.dir).filter((name) => name.includes('.backup-v1-') && name.endsWith('.sqlite'));
  assert.equal(backupNames.length, 1, 'exactly one pre-migration copy of the v1 database is kept');
  const [backupName] = backupNames;
  assert.ok(backupName);
  const backupPath = join(paths.dir, backupName);
  const backup = fingerprint(backupPath);
  assert.equal(backup.userVersion, 1, 'the copy is the pre-migration v1 database');
  assert.equal(backup.marker, STORE_MARKER);
  assert.equal(backup.integrity, 'ok');
  assert.deepEqual(backup.tables, [...STORE_TABLES_V1].sort());
  assert.equal(rawScalar(backupPath, 'PRAGMA journal_mode'), 'delete', 'the copy predates the WAL switch');
  assert.equal(rawScalar(backupPath, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(rawScalar(backupPath, 'SELECT analysis_calls FROM jobs'), world.job.counters.analysisCalls);
  assert.equal(rawScalar(backupPath, 'SELECT revision FROM manual_revisions'), 1);
  fx.removeDirectory(paths.dir);
});

void test('a v1 migration that cannot finish leaves the v1 tables and the pre-migration copy readable', () => {
  const paths = fx.tempDatabase();
  const world = seedV1World(paths.path);
  // A view named `analysis_batches` makes the first v2 DDL statement of the migration fail.
  rawExec(paths.path, ['CREATE VIEW analysis_batches AS SELECT 1 AS batch_id']);
  assert.equal(rawScalar(paths.path, 'PRAGMA journal_mode'), 'delete', 'the fixture starts in rollback journal mode');

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    (error) => error instanceof StorageError && error.code === 'migration_failed',
  );

  const after = fingerprint(paths.path);
  assert.equal(after.userVersion, 1, 'the failed migration was rolled back to v1');
  assert.equal(after.marker, STORE_MARKER, 'the original metadata is intact');
  assert.equal(after.integrity, 'ok');
  assert.deepEqual(after.tables, [...STORE_TABLES_V1].sort(), 'no v2 table replaced the conflicting view');
  assert.equal(
    rawScalar(paths.path, 'PRAGMA journal_mode'),
    'delete',
    'configuration only happens after a successful migration, so the original journal mode is kept',
  );
  assert.equal(rawScalar(paths.path, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(rawScalar(paths.path, 'SELECT analysis_calls FROM jobs'), world.job.counters.analysisCalls);
  assert.equal(rawScalar(paths.path, 'SELECT revision FROM manual_revisions'), 1);
  assert.equal(
    rawScalar(
      paths.path,
      `SELECT count(*) FROM sqlite_master WHERE type = 'view' AND name = 'analysis_batches'`,
    ),
    1,
    'the conflicting object is still there, not silently dropped',
  );

  const backupNames = readdirSync(paths.dir).filter((name) => name.includes('.backup-v1-') && name.endsWith('.sqlite'));
  assert.equal(backupNames.length, 1, 'the pre-migration copy survives the failed migration');
  const [backupName] = backupNames;
  assert.ok(backupName);
  const backupPath = join(paths.dir, backupName);
  const backup = fingerprint(backupPath);
  assert.equal(backup.userVersion, 1);
  assert.equal(backup.marker, STORE_MARKER);
  assert.equal(backup.integrity, 'ok');
  assert.deepEqual(backup.tables, [...STORE_TABLES_V1].sort());
  assert.equal(rawScalar(backupPath, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  fx.removeDirectory(paths.dir);
});

void test('historical v2 helpers keep writing exactly schema v2', () => {
  const paths = fx.tempDatabase();
  const initializedPath = join(paths.dir, 'initialized.sqlite');
  let db = new DatabaseSync(initializedPath);
  try {
    initializeSchemaV2(db);
  } finally {
    db.close();
  }
  assert.equal(rawScalar(initializedPath, 'PRAGMA user_version'), SCHEMA_VERSION_V2, 'initializeSchemaV2 stops at 2');
  assert.equal(
    rawScalar(
      initializedPath,
      `SELECT count(*) FROM sqlite_master WHERE name IN ('workbench_settings', 'coaching_attempts')`,
    ),
    0,
  );

  const migratedPath = join(paths.dir, 'migrated.sqlite');
  seedV1World(migratedPath);
  db = new DatabaseSync(migratedPath);
  try {
    migrateSchemaV1ToV2(db);
  } finally {
    db.close();
  }
  assert.equal(rawScalar(migratedPath, 'PRAGMA user_version'), SCHEMA_VERSION_V2, 'migrateSchemaV1ToV2 stops at 2');
  assert.equal(
    rawScalar(migratedPath, 'SELECT count(*) FROM problems'),
    1,
    'the v1 rows survive the historical migration',
  );
  assert.equal(
    rawScalar(
      migratedPath,
      `SELECT count(*) FROM sqlite_master WHERE name IN ('workbench_settings', 'coaching_attempts')`,
    ),
    0,
  );
  fx.removeDirectory(paths.dir);
});

void test('historical v3 helpers keep writing exactly schema v3 while the current store adds v4', async () => {
  const paths = fx.tempDatabase();
  const v3Path = join(paths.dir, 'v3.sqlite');
  let db = new DatabaseSync(v3Path);
  try {
    initializeSchemaV3(db);
  } finally {
    db.close();
  }
  assert.equal(rawScalar(v3Path, 'PRAGMA user_version'), SCHEMA_VERSION_V3, 'initializeSchemaV3 stops at 3');
  assert.deepEqual(
    fingerprint(v3Path).tables,
    [...STORE_TABLES_V3].sort(),
    'the fixture is exactly a v3 store',
  );
  assert.equal(
    rawScalar(v3Path, `SELECT count(*) FROM sqlite_master WHERE name = 'plan_attempts'`),
    0,
    'a v3 database has no v4 table',
  );

  // A bare `applySchemaV3` must also keep its own literal version, so a fixture stays a real v3 file.
  const appliedPath = join(paths.dir, 'applied-v3.sqlite');
  db = new DatabaseSync(appliedPath);
  try {
    applySchemaV1(db);
    applySchemaV3(db);
  } finally {
    db.close();
  }
  assert.equal(rawScalar(appliedPath, 'PRAGMA user_version'), 3, 'applySchemaV3 writes the literal 3');

  const store = new SqliteTrainingStore({ path: v3Path, now: () => fx.AT });
  try {
    const migrated = fingerprint(v3Path);
    assert.equal(migrated.userVersion, STORE_SCHEMA_VERSION);
    for (const table of STORE_TABLES_V4) {
      assert.ok(migrated.tables.includes(table), `migrated v3 schema is missing ${table}`);
    }
  } finally {
    await store.close();
  }
  assert.equal(
    readdirSync(paths.dir).filter((name) => name.includes('.backup-v3-') && name.endsWith('.sqlite')).length,
    1,
    'the real v3 file is copied before it is migrated',
  );
  fx.removeDirectory(paths.dir);
});

void test('a v2 database is copied, then migrated to v3 with every row kept', async () => {
  const paths = fx.tempDatabase();
  const world = seedV2World(paths.path);
  const expectedBatch = { ...world.batch, revision: 1 };
  const before = fingerprint(paths.path);
  assert.equal(before.userVersion, SCHEMA_VERSION_V2);
  assert.deepEqual(before.tables, [...STORE_TABLES_V2].sort(), 'the fixture is exactly a v2 store');

  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
  try {
    assert.deepEqual(await store.getProblem(world.scope.problem.key), world.scope.problem, 'the problem body survived');
    assert.deepEqual(await store.getBatch(world.batch.batchId), expectedBatch, 'the batch body survived');
    assert.equal(
      await store.saveWorkbenchSettings(defaultWorkbenchSettings(), null),
      1,
      'the v3 tables are usable on the migrated file',
    );
  } finally {
    await store.close();
  }

  const migrated = fingerprint(paths.path);
  assert.equal(migrated.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(migrated.marker, STORE_MARKER);
  assert.equal(migrated.integrity, 'ok');
  for (const table of STORE_TABLES_V4) {
    assert.ok(migrated.tables.includes(table), `migrated schema is missing ${table}`);
  }
  assert.equal(
    rawScalar(paths.path, 'PRAGMA journal_mode'),
    'wal',
    'the migrated database is configured after a successful migration',
  );
  assert.equal(rawScalar(paths.path, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(rawScalar(paths.path, 'SELECT body FROM analysis_batches'), canonicalJson(expectedBatch));
  assert.equal(rawScalar(paths.path, 'SELECT revision FROM workbench_settings'), 1);
  assert.equal(
    rawScalar(paths.path, 'SELECT count(*) FROM coaching_attempts'),
    0,
    'the reserved coaching table is created empty',
  );
  assert.equal(rawScalar(paths.path, 'SELECT count(*) FROM plan_attempts'), 0, 'the planning table is created empty');

  const backupNames = readdirSync(paths.dir).filter((name) => name.includes('.backup-v2-') && name.endsWith('.sqlite'));
  assert.equal(backupNames.length, 1, 'exactly one pre-migration copy of the v2 database is kept');
  const [backupName] = backupNames;
  assert.ok(backupName);
  const backupPath = join(paths.dir, backupName);
  const backup = fingerprint(backupPath);
  assert.equal(backup.userVersion, SCHEMA_VERSION_V2, 'the copy is the pre-migration v2 database');
  assert.equal(backup.marker, STORE_MARKER);
  assert.equal(backup.integrity, 'ok');
  assert.deepEqual(backup.tables, [...STORE_TABLES_V2].sort());
  assert.equal(rawScalar(backupPath, 'PRAGMA journal_mode'), 'delete', 'the copy predates the WAL switch');
  assert.equal(rawScalar(backupPath, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(rawScalar(backupPath, 'SELECT body FROM analysis_batches'), canonicalJson(expectedBatch));
  assert.equal(
    rawScalar(
      backupPath,
      `SELECT count(*) FROM sqlite_master WHERE name IN ('workbench_settings', 'coaching_attempts')`,
    ),
    0,
    'the copy contains no v3 tables',
  );
  fx.removeDirectory(paths.dir);
});

void test('a v3 migration that cannot finish leaves the v2 tables and the pre-migration copy readable', () => {
  const paths = fx.tempDatabase();
  const world = seedV2World(paths.path);
  // A view named `coaching_attempts` makes the second v3 DDL statement, after the settings table was created of the migration fail.
  rawExec(paths.path, ['CREATE VIEW coaching_attempts AS SELECT 1 AS id']);
  assert.equal(rawScalar(paths.path, 'PRAGMA journal_mode'), 'delete', 'the fixture starts in rollback journal mode');

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    (error) => error instanceof StorageError && error.code === 'migration_failed',
  );

  const after = fingerprint(paths.path);
  assert.equal(after.userVersion, SCHEMA_VERSION_V2, 'the failed migration was rolled back to v2');
  assert.equal(after.marker, STORE_MARKER, 'the original metadata is intact');
  assert.equal(after.integrity, 'ok');
  assert.deepEqual(after.tables, [...STORE_TABLES_V2].sort(), 'no v3 table replaced the conflicting view');
  assert.equal(
    rawScalar(paths.path, 'PRAGMA journal_mode'),
    'delete',
    'configuration only happens after a successful migration, so the original journal mode is kept',
  );
  assert.equal(rawScalar(paths.path, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  assert.equal(
    rawScalar(paths.path, `SELECT count(*) FROM sqlite_master WHERE type = 'view' AND name = 'coaching_attempts'`),
    1,
    'the conflicting object is still there, not silently dropped',
  );

  const backupNames = readdirSync(paths.dir).filter((name) => name.includes('.backup-v2-') && name.endsWith('.sqlite'));
  assert.equal(backupNames.length, 1, 'the pre-migration copy survives the failed migration');
  const [backupName] = backupNames;
  assert.ok(backupName);
  const backupPath = join(paths.dir, backupName);
  const backup = fingerprint(backupPath);
  assert.equal(backup.userVersion, SCHEMA_VERSION_V2);
  assert.equal(backup.marker, STORE_MARKER);
  assert.equal(backup.integrity, 'ok');
  assert.deepEqual(backup.tables, [...STORE_TABLES_V2].sort());
  assert.equal(rawScalar(backupPath, 'SELECT body FROM problems'), canonicalJson(world.scope.problem));
  fx.removeDirectory(paths.dir);
});

void test('a migration that cannot finish leaves the original database readable', () => {
  const paths = fx.tempDatabase();
  rawExec(paths.path, [
    'CREATE TABLE store_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
    `INSERT INTO store_meta (key, value) VALUES ('store_marker', '${STORE_MARKER}')`,
    // A view named `problems` makes the first DDL statement of the migration fail.
    'CREATE VIEW problems AS SELECT 1 AS key',
  ]);
  assert.equal(rawScalar(paths.path, 'PRAGMA journal_mode'), 'delete', 'the fixture starts in rollback journal mode');

  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    (error) => error instanceof StorageError && error.code === 'migration_failed',
  );

  const after = fingerprint(paths.path);
  assert.equal(after.userVersion, 0, 'the failed migration was rolled back');
  assert.equal(after.marker, STORE_MARKER, 'the original metadata is intact');
  assert.equal(after.integrity, 'ok');
  assert.deepEqual(after.tables, ['store_meta'], 'no partial store tables were left behind');
  assert.equal(
    rawScalar(paths.path, 'PRAGMA journal_mode'),
    'delete',
    'configuration only happens after a successful migration, so the original journal mode is kept',
  );
  fx.removeDirectory(paths.dir);
});

void test('backupTo writes a consistent copy, refuses to overwrite and supports recovery', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const snapshot = fx.makeSnapshot(scope.problem);
  await store.upsertSourceInstances([scope.instance]);
  await store.upsertProblems([scope.problem]);
  await store.saveSnapshot(snapshot);

  const backupPath = join(paths.dir, 'accepted.sqlite');
  const recoveredPath = join(paths.dir, 'recovered.sqlite');
  // The store is still open, so recent rows live in the WAL: a file copy would miss them.
  await store.backupTo(backupPath);
  const backup = fingerprint(backupPath);
  assert.equal(backup.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(backup.marker, STORE_MARKER);
  assert.equal(backup.integrity, 'ok');
  assert.equal(rawScalar(backupPath, 'SELECT count(*) FROM problems'), 1);
  assert.equal(rawScalar(backupPath, 'SELECT count(*) FROM snapshots'), 1);
  await store.backupTo(recoveredPath);

  await assert.rejects(store.backupTo(backupPath), (error) => {
    return error instanceof StorageError && error.code === 'backup_exists';
  });
  await assert.rejects(store.backupTo(join(paths.dir, 'absent', 'copy.sqlite')), (error) => {
    return error instanceof StorageError && error.code === 'invalid_path';
  });
  await assert.rejects(store.backupTo(paths.path), (error) => {
    return error instanceof StorageError && error.code === 'invalid_path';
  });
  await store.close();

  // Recovery: the live file is unusable, the verified backup is opened as the store.
  writeFileSync(paths.path, 'this is not a sqlite database');
  assert.throws(
    () => new SqliteTrainingStore({ path: paths.path }),
    (error) => error instanceof StorageError && error.code === 'open_failed',
  );
  const recovered = new SqliteTrainingStore({ path: recoveredPath, now: () => fx.AT });
  try {
    assert.deepEqual((await recovered.listProblems({ limit: 10, cursor: null })).items, [scope.problem]);
    assert.deepEqual(await recovered.getSnapshot(snapshot.snapshotId), snapshot);
  } finally {
    await recovered.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('unusable paths fail loudly instead of creating a database somewhere else', () => {
  const paths = fx.tempDatabase();
  assert.throws(
    () => new SqliteTrainingStore({ path: '   ' }),
    (error) => error instanceof StorageError && error.code === 'invalid_path',
  );
  assert.throws(
    () => new SqliteTrainingStore({ path: paths.dir }),
    (error) => error instanceof StorageError && error.code === 'open_failed',
  );
  fx.removeDirectory(paths.dir);
});
