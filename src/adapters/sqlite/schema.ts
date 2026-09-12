/**
 * Database schema, versioning and migration.
 *
 * The store owns its own file layout and marker; it must never adopt or "repair" a database
 * it does not recognize. The rules are:
 *
 * - `PRAGMA user_version` carries the schema version and a `store_meta` row carries the
 *   {@link STORE_MARKER} identity, checked together.
 * - **Newer than this build** → reject before any write (no silent downgrade or reset).
 * - **v0** means "no store tables yet": an empty file is initialized transactionally, a file
 *   with our marker table but no data tables is migrated after a consistent backup, and any
 *   other v0 layout is rejected instead of being migrated.
 * - A failure while initializing rolls back, so the original file stays readable.
 *
 * All metadata the adapter writes are immutable JSON bodies plus indexed identity columns;
 * full DDL for the current version lives in {@link SCHEMA_DDL_V1}.
 */
import type { DatabaseSync } from 'node:sqlite';
import { StorageError } from './errors.js';

/** Identity row written into `store_meta`; a foreign v1 database must not be adopted. */
export const STORE_MARKER = 'dsh-icpc-workbench/training-store';

/** Schema version this build reads and writes. */
export const STORE_SCHEMA_VERSION = 1;

/** Version of an uninitialized or pre-store database. */
export const SCHEMA_VERSION_EMPTY = 0;

export const META_TABLE = 'store_meta';
export const META_MARKER_KEY = 'store_marker';

/** Tables that must exist for a database to be accepted as schema v1. */
export const STORE_TABLES_V1: readonly string[] = [
  META_TABLE,
  'source_instances',
  'accounts',
  'problems',
  'submissions',
  'snapshots',
  'snapshot_heads',
  'analyses',
  'jobs',
  'tag_decisions',
  'manual_decisions',
  'manual_revisions',
  'retrospectives',
  'plans',
  'sync_checkpoints',
];

/**
 * Schema v1.
 *
 * Identity columns are the domain's canonical ids, so every scope (source instance, domain,
 * account, problem, submission, snapshot version) is independently indexed. Bodies are the
 * immutable canonical JSON of the domain object; they are the source of truth for reads
 * while the columns exist for scoping, ordering and staleness checks.
 */
export const SCHEMA_DDL_V1: readonly string[] = [
  // `IF NOT EXISTS` only here: a v0 database carrying our marker already has this table,
  // and re-declaring it is what distinguishes "migrate our own metadata" from a reset.
  `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE source_instances (
     id TEXT PRIMARY KEY NOT NULL,
     platform TEXT NOT NULL,
     base_url TEXT NOT NULL,
     domain TEXT,
     display_name TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY NOT NULL,
     source_instance_id TEXT NOT NULL,
     handle TEXT NOT NULL,
     display_name TEXT,
     profile_url TEXT,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX accounts_by_instance ON accounts (source_instance_id, handle, id)`,
  `CREATE TABLE problems (
     key TEXT PRIMARY KEY NOT NULL,
     source_instance_id TEXT NOT NULL,
     domain TEXT,
     external_key TEXT NOT NULL,
     title TEXT NOT NULL,
     fetched_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX problems_by_scope ON problems (source_instance_id, domain, key)`,
  `CREATE TABLE submissions (
     id TEXT PRIMARY KEY NOT NULL,
     account_id TEXT NOT NULL,
     problem_key TEXT NOT NULL,
     source_instance_id TEXT NOT NULL,
     domain TEXT,
     external_key TEXT NOT NULL,
     external_id TEXT NOT NULL,
     verdict TEXT NOT NULL,
     submitted_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX submissions_by_account ON submissions (account_id, problem_key, submitted_at, id)`,
  `CREATE INDEX submissions_by_problem ON submissions (problem_key, account_id)`,
  `CREATE TABLE snapshots (
     snapshot_id TEXT PRIMARY KEY NOT NULL,
     problem_key TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     version INTEGER NOT NULL,
     schema_version INTEGER NOT NULL,
     captured_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX snapshots_by_problem ON snapshots (problem_key, version)`,
  `CREATE TABLE snapshot_heads (
     problem_key TEXT PRIMARY KEY NOT NULL,
     snapshot_id TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     version INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE analyses (
     analysis_id TEXT PRIMARY KEY NOT NULL,
     problem_key TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     snapshot_version INTEGER NOT NULL,
     taxonomy_version TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX analyses_by_problem ON analyses (problem_key, created_at, analysis_id)`,
  `CREATE TABLE jobs (
     job_id TEXT PRIMARY KEY NOT NULL,
     problem_key TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     status TEXT NOT NULL,
     attempts INTEGER NOT NULL,
     analysis_calls INTEGER NOT NULL,
     reasoning_calls INTEGER NOT NULL,
     retries INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     lease_owner TEXT,
     lease_expires_at TEXT,
     analysis_id TEXT,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX jobs_by_status ON jobs (status, updated_at, job_id)`,
  `CREATE INDEX jobs_by_problem ON jobs (problem_key, snapshot_id)`,
  `CREATE TABLE tag_decisions (
     decision_id TEXT PRIMARY KEY NOT NULL,
     problem_key TEXT NOT NULL,
     taxonomy_id TEXT NOT NULL,
     status TEXT NOT NULL,
     origin TEXT NOT NULL,
     analysis_id TEXT,
     decided_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX tag_decisions_by_problem ON tag_decisions (problem_key, decided_at, decision_id)`,
  `CREATE TABLE manual_decisions (
     decision_id TEXT PRIMARY KEY NOT NULL,
     problem_key TEXT NOT NULL,
     taxonomy_id TEXT NOT NULL,
     action TEXT NOT NULL,
     decided_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX manual_decisions_by_problem ON manual_decisions (problem_key, decided_at, decision_id)`,
  `CREATE TABLE manual_revisions (
     problem_key TEXT PRIMARY KEY NOT NULL,
     revision INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE retrospectives (
     retrospective_id TEXT PRIMARY KEY NOT NULL,
     problem_key TEXT NOT NULL,
     account_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX retrospectives_by_account ON retrospectives (account_id, recorded_at, retrospective_id)`,
  `CREATE TABLE plans (
     plan_id TEXT PRIMARY KEY NOT NULL,
     account_id TEXT,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     adopted_at TEXT,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX plans_by_account ON plans (account_id, created_at, plan_id)`,
  `CREATE TABLE sync_checkpoints (
     checkpoint_key TEXT PRIMARY KEY NOT NULL,
     source_instance_id TEXT NOT NULL,
     account_id TEXT,
     resource TEXT NOT NULL,
     cursor TEXT,
     since TEXT,
     updated_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX sync_checkpoints_by_scope ON sync_checkpoints (source_instance_id, account_id, resource)`,
];

/** What a database file looks like before this build touches it. */
export type SchemaState = 'empty' | 'legacy_v0' | 'current';

function pragmaRow(db: DatabaseSync, sql: string): Record<string, unknown> | undefined {
  return db.prepare(sql).get() as Record<string, unknown> | undefined;
}

/** `PRAGMA user_version` as a number. */
export function readUserVersion(db: DatabaseSync): number {
  const row = pragmaRow(db, 'PRAGMA user_version');
  const value = row?.['user_version'];
  return typeof value === 'number' ? value : 0;
}

/** User tables (SQLite internal tables excluded). */
export function tableNames(db: DatabaseSync): readonly string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as readonly Record<string, unknown>[];
  return rows.map((row) => String(row['name']));
}

/** The stored marker value, or `null` when the meta table/row is absent. */
export function readMarker(db: DatabaseSync): string | null {
  if (!tableNames(db).includes(META_TABLE)) {
    return null;
  }
  const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(META_MARKER_KEY) as
    | Record<string, unknown>
    | undefined;
  const value = row?.['value'];
  return typeof value === 'string' ? value : null;
}

/**
 * Classify the database before any write.
 *
 * Throws {@link StorageError} with `schema_too_new` for a database from a newer build and
 * `unsupported_schema` for anything this build must not migrate.
 */
export function detectSchemaState(db: DatabaseSync): SchemaState {
  const version = readUserVersion(db);
  if (!Number.isInteger(version) || version < 0) {
    throw new StorageError('unsupported_schema', `database reports an invalid user_version ${String(version)}`, {
      version,
    });
  }
  if (version > STORE_SCHEMA_VERSION) {
    throw new StorageError(
      'schema_too_new',
      `database schema v${version} is newer than this build supports (v${STORE_SCHEMA_VERSION})`,
      { version, supported: STORE_SCHEMA_VERSION },
    );
  }
  const tables = tableNames(db);
  if (version === STORE_SCHEMA_VERSION) {
    if (readMarker(db) !== STORE_MARKER) {
      throw new StorageError('unsupported_schema', 'database reports schema v1 but does not carry the store marker', {
        marker: readMarker(db),
      });
    }
    const missing = STORE_TABLES_V1.filter((table) => !tables.includes(table));
    if (missing.length > 0) {
      throw new StorageError('unsupported_schema', `database schema v1 is missing tables: ${missing.join(', ')}`, {
        missing,
      });
    }
    return 'current';
  }
  if (tables.length === 0) {
    return 'empty';
  }
  if (tables.length === 1 && tables[0] === META_TABLE && readMarker(db) === STORE_MARKER) {
    return 'legacy_v0';
  }
  throw new StorageError(
    'unsupported_schema',
    'database contains tables this build does not recognize and was not created by it',
    { version, tables },
  );
}

/** Apply the v1 DDL (no transaction management; the caller owns the transaction). */
export function applySchemaV1(db: DatabaseSync): void {
  for (const statement of SCHEMA_DDL_V1) {
    db.exec(statement);
  }
  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(META_MARKER_KEY, STORE_MARKER);
  db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
}

/**
 * Initialize or migrate a database to v1 inside one transaction.
 *
 * On failure the transaction is rolled back and the original error is rethrown, so the file
 * stays exactly as it was found (an unreadable rollback is reported as `rollback_failed`).
 */
export function initializeSchemaV1(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    applySchemaV1(db);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new StorageError('rollback_failed', 'schema initialization failed and could not be rolled back', {
        cause: String(rollbackError),
        original: String(error),
      });
    }
    throw error;
  }
}

/** Configure the connection: wait instead of failing on a busy file, and use WAL for files. */
export function configureConnection(db: DatabaseSync, inMemory: boolean): void {
  db.exec('PRAGMA busy_timeout = 5000');
  const row = pragmaRow(db, 'PRAGMA journal_mode = WAL');
  const mode = row?.['journal_mode'];
  if (!inMemory && mode !== 'wal') {
    throw new StorageError('open_failed', 'database did not enter WAL journal mode', { journalMode: mode ?? null });
  }
  db.exec('PRAGMA synchronous = NORMAL');
}

/** Consistent single-file backup name (`<db>.backup-v<version>-<timestamp>.sqlite`). */
export function backupFileName(dbPath: string, version: number, at: string): string {
  const base = dbPath.replace(/\.sqlite$/u, '').replace(/\.db$/u, '');
  return `${base}.backup-v${version}-${at.replace(/[:.]/gu, '-')}.sqlite`;
}
