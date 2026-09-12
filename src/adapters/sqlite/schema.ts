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
 * - **v1** (this build's previous version) is recognized exactly — marker plus
 *   {@link STORE_TABLES_V1} — copied consistently and then migrated to v2 in one transaction
 *   that only adds the new tables. Existing rows are retained.
 * - A failure while initializing or migrating rolls back, so the original file stays readable.
 *
 * Historical DDL is frozen: {@link SCHEMA_DDL_V1}/{@link applySchemaV1} keep creating exactly
 * the v1 tables they always created, so a v1 fixture built with them is a real v1 database.
 * The current version adds {@link SCHEMA_DDL_V2} on top.
 *
 * All metadata the adapter writes are immutable JSON bodies plus indexed identity columns.
 */
import type { DatabaseSync } from 'node:sqlite';
import { StorageError } from './errors.js';

/** Identity row written into `store_meta`; a foreign database must not be adopted. */
export const STORE_MARKER = 'dsh-icpc-workbench/training-store';

/** Schema version this build reads and writes. */
export const STORE_SCHEMA_VERSION = 2;

/** Version of an uninitialized or pre-store database. */
export const SCHEMA_VERSION_EMPTY = 0;

/** Version of the previous store schema this build recognizes and migrates from. */
export const SCHEMA_VERSION_V1 = 1;

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

/** Tables a schema-v2 database must have: the v1 set plus the batch/call audit tables. */
export const STORE_TABLES_V2: readonly string[] = [
  ...STORE_TABLES_V1,
  'analysis_batches',
  'model_call_attempts',
];

/**
 * Schema v1 — frozen historical DDL.
 *
 * Do not change these statements: they are what a pre-v2 database (and the migration backup
 * taken from it) actually contains. Schema v2 is applied on top through {@link SCHEMA_DDL_V2}.
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

/**
 * Schema v2 — durable analysis batches and model-call attempts.
 *
 * Identity columns exist for scoping, ordering and monotonic checks; the canonical JSON body
 * stays the source of truth for reads (it carries the immutable job mapping and the typed
 * attempt outcome). `analysis_batches` is indexed by status for queue reads, and
 * `model_call_attempts` by batch, job and status so recovery can find the reserved/uncertain
 * calls of one batch or job without a scan.
 */
export const SCHEMA_DDL_V2: readonly string[] = [
  `CREATE TABLE analysis_batches (
     batch_id TEXT PRIMARY KEY NOT NULL,
     status TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     lease_owner TEXT,
     lease_expires_at TEXT,
     analysis_calls INTEGER NOT NULL,
     reasoning_calls INTEGER NOT NULL,
     retries INTEGER NOT NULL,
     job_count INTEGER NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX analysis_batches_by_status ON analysis_batches (status, created_at, batch_id)`,
  `CREATE TABLE model_call_attempts (
     attempt_id TEXT PRIMARY KEY NOT NULL,
     batch_id TEXT NOT NULL,
     job_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     role TEXT NOT NULL,
     status TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     prompt_version TEXT NOT NULL,
     requested_at TEXT NOT NULL,
     finished_at TEXT,
     host_session_id TEXT,
     host_call_id TEXT,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX model_call_attempts_by_batch ON model_call_attempts (batch_id, requested_at, attempt_id)`,
  `CREATE INDEX model_call_attempts_by_job ON model_call_attempts (job_id, requested_at, attempt_id)`,
  `CREATE INDEX model_call_attempts_by_status ON model_call_attempts (status, requested_at, attempt_id)`,
];

/**
 * What a database file looks like before this build touches it.
 *
 * `v1` is a recognizable older store that must be copied and migrated; `current` is this
 * build's own version. Anything else is refused.
 */
export type SchemaState = 'empty' | 'legacy_v0' | 'v1' | 'current';

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
 * Throws {@link StorageError} with `schema_too_new` for a database from a newer build (before
 * any journal-mode switch or byte change) and `unsupported_schema` for anything this build
 * must not migrate: a foreign database, a store version whose marker or expected table set is
 * incomplete, or an unreadable version.
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
    requireStoreMarker(db, version);
    requireTables(tables, STORE_TABLES_V2, version);
    return 'current';
  }
  if (version === SCHEMA_VERSION_V1) {
    requireStoreMarker(db, version);
    requireTables(tables, STORE_TABLES_V1, version);
    return 'v1';
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

function requireStoreMarker(db: DatabaseSync, version: number): void {
  const marker = readMarker(db);
  if (marker !== STORE_MARKER) {
    throw new StorageError(
      'unsupported_schema',
      `database reports schema v${version} but does not carry the store marker`,
      { marker, version },
    );
  }
}

function requireTables(tables: readonly string[], expected: readonly string[], version: number): void {
  const missing = expected.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new StorageError(
      'unsupported_schema',
      `database schema v${version} is missing tables: ${missing.join(', ')}`,
      { missing, version },
    );
  }
}

/** Apply the v1 DDL exactly as v1 defined it (no transaction management; caller owns it). */
export function applySchemaV1(db: DatabaseSync): void {
  for (const statement of SCHEMA_DDL_V1) {
    db.exec(statement);
  }
  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(META_MARKER_KEY, STORE_MARKER);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V1}`);
}

/**
 * Apply the v2 additions and move `user_version` to this build's current version.
 *
 * The v1 tables and every row in them are untouched; only the two new tables and their
 * indexes are created. The marker row is already present (written by v1).
 */
export function applySchemaV2(db: DatabaseSync): void {
  for (const statement of SCHEMA_DDL_V2) {
    db.exec(statement);
  }
  db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
}

/**
 * Initialize an empty or metadata-only (v0) database straight to v2.
 *
 * The v1 DDL and the v2 additions run in the **same** transaction, so a metadata-only
 * database never exists in an intermediate v1 state that a later open would have to migrate.
 */
export function initializeSchemaV2(db: DatabaseSync): void {
  inTransaction(
    db,
    () => {
      applySchemaV1(db);
      applySchemaV2(db);
    },
    'schema initialization',
  );
}

/** Migrate a recognized v1 database to v2: one transaction, additive only. */
export function migrateSchemaV1ToV2(db: DatabaseSync): void {
  inTransaction(db, () => applySchemaV2(db), 'schema migration');
}

/**
 * Initialize a database to v1 inside one transaction.
 *
 * Kept for building and testing v1 fixtures; the store itself initializes to v2. On failure
 * the transaction is rolled back and the original error is rethrown, so the file stays exactly
 * as it was found (an unreadable rollback is reported as `rollback_failed`).
 */
export function initializeSchemaV1(db: DatabaseSync): void {
  inTransaction(db, () => applySchemaV1(db), 'schema initialization');
}

function inTransaction(db: DatabaseSync, work: () => void, label: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new StorageError('rollback_failed', `${label} failed and could not be rolled back`, {
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
