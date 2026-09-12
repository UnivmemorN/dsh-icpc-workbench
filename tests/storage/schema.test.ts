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
import { SqliteTrainingStore, StorageError, STORE_MARKER, STORE_SCHEMA_VERSION } from '../../src/adapters/sqlite/index.js';
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
    'accounts',
    'analyses',
    'jobs',
    'manual_decisions',
    'manual_revisions',
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
  ]) {
    assert.ok(state.tables.includes(table), `schema is missing ${table}`);
  }
  fx.removeDirectory(paths.dir);
});

void test('a database from a newer schema is rejected before anything is written', () => {
  const paths = fx.tempDatabase();
  rawExec(paths.path, [
    'CREATE TABLE problems (x TEXT)',
    `INSERT INTO problems (x) VALUES ('foreign data')`,
    `PRAGMA user_version = ${STORE_SCHEMA_VERSION + 1}`,
  ]);
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
