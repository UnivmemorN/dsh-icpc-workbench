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
 * - **v1** … **v6** (the previous versions of this build) are recognized exactly — marker
 *   plus their own table set — copied consistently and then migrated to the current version in one
 *   transaction that only adds tables. Existing rows are retained.
 * - A failure while initializing or migrating rolls back, so the original file stays readable.
 *
 * Historical DDL is frozen: {@link SCHEMA_DDL_V1}/{@link applySchemaV1},
 * {@link SCHEMA_DDL_V2}/{@link applySchemaV2} and {@link SCHEMA_DDL_V3}/{@link applySchemaV3} keep
 * creating exactly their own version's tables **and write exactly their own literal
 * `user_version`**, so a fixture built with them is a real older database and the migration under
 * test is the real one. The current version adds {@link SCHEMA_DDL_V7} on top.
 *
 * All metadata the adapter writes are immutable JSON bodies plus indexed identity columns.
 */
import type { DatabaseSync } from 'node:sqlite';
import { StorageError } from './errors.js';

/** Identity row written into `store_meta`; a foreign database must not be adopted. */
export const STORE_MARKER = 'dsh-icpc-workbench/training-store';

/** Schema version this build reads and writes. */
export const STORE_SCHEMA_VERSION = 7;
export const SCHEMA_VERSION_V6 = 6;
export const SCHEMA_VERSION_V5 = 5;
export const SCHEMA_VERSION_V4 = 4;

/** Version of an uninitialized or pre-store database. */
export const SCHEMA_VERSION_EMPTY = 0;

/** Version of the first store schema this build recognizes and migrates from. */
export const SCHEMA_VERSION_V1 = 1;

/** Version of the second store schema this build recognizes and migrates from. */
export const SCHEMA_VERSION_V2 = 2;

/** Version of the third store schema this build recognizes and migrates from. */
export const SCHEMA_VERSION_V3 = 3;

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

/** Tables a schema-v3 database must have: the v2 set plus settings and coaching attempts. */
export const STORE_TABLES_V3: readonly string[] = [
  ...STORE_TABLES_V2,
  'workbench_settings',
  'coaching_attempts',
];

/** Tables a schema-v4 database must have: the v3 set plus the durable AI planning attempts. */
export const STORE_TABLES_V4: readonly string[] = [...STORE_TABLES_V3, 'plan_attempts'];

/**
 * Schema v1 — frozen historical DDL.
 *
 * Do not change these statements: they are what a pre-v2 database (and the migration backup
 * taken from it) actually contains. Schemas v2 and v3 are applied on top through
 * {@link SCHEMA_DDL_V2} and {@link SCHEMA_DDL_V3}.
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
 * Schema v3 — workbench settings and the reserved coaching-attempt table.
 *
 * `workbench_settings` is a singleton (`CHECK (id = 1)`): `revision` drives the CAS write and
 * `body` holds the validated canonical configuration. `coaching_attempts` is created empty and
 * has **no access methods yet** — it is the schema half of the next stage, not a capability
 * this build implements. Its indexes match the planned reads: history/lease ordering on
 * `requested_at`, deadline recovery on `status, expires_at`, and per-account history.
 */
export const SCHEMA_DDL_V3: readonly string[] = [
  `CREATE TABLE workbench_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision INTEGER NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE TABLE coaching_attempts (
     id TEXT PRIMARY KEY,
     account_id TEXT,
     problem_key TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     requested_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     status TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX coaching_attempts_by_requested ON coaching_attempts (requested_at, id)`,
  `CREATE INDEX coaching_attempts_by_status ON coaching_attempts (status, expires_at, id)`,
  `CREATE INDEX coaching_attempts_by_account ON coaching_attempts (account_id, problem_key, requested_at, id)`,
];

/**
 * Schema v4 — durable AI training-plan attempts.
 *
 * One row is the audit of one AI planning request: `prepared` rows are the free, durable
 * preparation (no dispatch happened), `reserved` rows are the single in-flight paid call with its
 * recovery deadline, and `settled`/`uncertain` rows are terminal. Identity columns exist for the
 * account scope, the rolling-24h quota count and lease recovery; the canonical JSON body stays the
 * source of truth for reads (immutable preparation, model identity, usage and the stored plan).
 */
export const SCHEMA_DDL_V4: readonly string[] = [
  `CREATE TABLE plan_attempts (
     id TEXT PRIMARY KEY NOT NULL,
     account_id TEXT NOT NULL,
     source_instance_id TEXT NOT NULL,
     status TEXT NOT NULL,
     requested_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     finished_at TEXT,
     plan_id TEXT,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX plan_attempts_by_requested ON plan_attempts (requested_at, id)`,
  `CREATE INDEX plan_attempts_by_status ON plan_attempts (status, expires_at, id)`,
  `CREATE INDEX plan_attempts_by_account ON plan_attempts (account_id, requested_at, id)`,
];

/**
 * What a database file looks like before this build touches it.
 *
 * `v1`/`v2`/`v3` are recognizable older stores that must be copied and migrated; `current` is
 * this build's own version. Anything else is refused.
 */
export const STORE_TABLES_V5: readonly string[] = [...STORE_TABLES_V4, 'ability_calibrations'];
/** Append-only account self-assessment history. No existing row is rewritten. */
export const SCHEMA_DDL_V5: readonly string[] = [
  'CREATE TABLE ability_calibrations (account_id TEXT NOT NULL REFERENCES accounts(id), revision INTEGER NOT NULL CHECK(revision > 0), body TEXT NOT NULL, PRIMARY KEY(account_id, revision))',
];
export const STORE_TABLES_V6: readonly string[] = [...STORE_TABLES_V5, 'official_rating_snapshots'];
export const SCHEMA_DDL_V6 = [`CREATE TABLE official_rating_snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id), revision INTEGER NOT NULL CHECK(revision > 0),
  body TEXT NOT NULL, PRIMARY KEY(account_id, revision)
)`];

/**
 * Schema v7 — durable Luogu synchronization state (Sprint 17c).
 *
 * Five additive tables, none of which has any secret column: `luogu_connections` stores one
 * account's **opaque credential reference**, its connection status and the check instants;
 * `luogu_connection_generations` is the per-account tombstone counter that keeps connection
 * revisions monotonic across a deletion, so a revision is never reissued after the row is removed;
 * `luogu_connection_journal` holds the opaque reference of a credential written *before* it could
 * be linked (the write-ahead half of `connect`); `luogu_sync_states` stores the revision-guarded
 * durable progress of one account; and `luogu_sync_settings` stores one account's automatic-sync
 * configuration. Settings are **per account**, not a singleton: enabling automation for one
 * account never enables another, and disconnecting an account only turns off that account's own
 * automation. Every table is keyed by `account_id`; the state/settings/connection rows are guarded
 * by a revision, so a stale writer can never resurrect a disconnected job or overwrite newer
 * progress. No cookie, session value or credential blob is representable here — the session itself
 * lives only in the OS-protected credential store.
 *
 * v7 was never shipped, so the generation counter and the journal were added **to v7** instead of a
 * new version; every recognized schema through v6 is byte-for-byte unchanged. A v7 file created by
 * an earlier unshipped build of this same work-in-progress lacks those two tables and is therefore
 * refused as an unrecognized layout rather than silently adopted (the store never repairs a
 * database it does not recognize).
 */
export const STORE_TABLES_V7: readonly string[] = [
  ...STORE_TABLES_V6,
  'luogu_connection_generations',
  'luogu_connection_journal',
  'luogu_connections',
  'luogu_sync_states',
  'luogu_sync_settings',
];
export const SCHEMA_DDL_V7: readonly string[] = [
  `CREATE TABLE luogu_connections (
     account_id TEXT PRIMARY KEY NOT NULL,
     source_instance_id TEXT NOT NULL,
     reference TEXT NOT NULL,
     status TEXT NOT NULL,
     revision INTEGER NOT NULL,
     checked_at TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX luogu_connections_by_instance ON luogu_connections (source_instance_id, account_id)`,
  `CREATE TABLE luogu_connection_generations (
     account_id TEXT PRIMARY KEY NOT NULL,
     revision INTEGER NOT NULL CHECK (revision > 0)
   )`,
  `CREATE TABLE luogu_connection_journal (
     account_id TEXT NOT NULL,
     reference TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     PRIMARY KEY (account_id, reference)
   )`,
  `CREATE TABLE luogu_sync_states (
     account_id TEXT PRIMARY KEY NOT NULL,
     source_instance_id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX luogu_sync_states_by_instance ON luogu_sync_states (source_instance_id, account_id)`,
  `CREATE TABLE luogu_sync_settings (
     account_id TEXT PRIMARY KEY NOT NULL,
     revision INTEGER NOT NULL,
     body TEXT NOT NULL
   )`,
];
export type SchemaState = 'empty' | 'legacy_v0' | 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6' | 'current';

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
    requireTables(tables, STORE_TABLES_V7, version);
    return 'current';
  }
  if (version === SCHEMA_VERSION_V6) {
    requireStoreMarker(db, version);
    requireTables(tables, STORE_TABLES_V6, version);
    return 'v6';
  }
  if (version === SCHEMA_VERSION_V5) {
    requireStoreMarker(db, version);
    requireTables(tables, STORE_TABLES_V5, version);
    return 'v5';
  }
  if (version === SCHEMA_VERSION_V4) {
    requireStoreMarker(db, version);
    requireTables(tables, STORE_TABLES_V4, version);
    return 'v4';
  }
  if (version === SCHEMA_VERSION_V3) {
    requireStoreMarker(db, version);
    requireTables(tables, STORE_TABLES_V3, version);
    return 'v3';
  }
  if (version === SCHEMA_VERSION_V2) {
    requireStoreMarker(db, version);
    requireTables(tables, STORE_TABLES_V2, version);
    return 'v2';
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
 * Apply the v2 additions and move `user_version` to **v2**.
 *
 * Frozen historical helper: v2 is no longer this build's current version, so it must keep
 * writing 2. The v1 tables and every row in them are untouched; only the two v2 tables and
 * their indexes are created. The marker row is already present (written by v1).
 */
export function applySchemaV2(db: DatabaseSync): void {
  for (const statement of SCHEMA_DDL_V2) {
    db.exec(statement);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V2}`);
}

/**
 * Apply the v3 additions and move `user_version` to **v3**.
 *
 * Frozen historical helper: v3 is no longer this build's current version, so it must keep writing
 * 3. Additive only: the two v3 tables and their indexes are created. `workbench_settings` starts
 * empty (the store writes revision 1 on the first save) and `coaching_attempts` is created empty.
 */
export function applySchemaV3(db: DatabaseSync): void {
  for (const statement of SCHEMA_DDL_V3) {
    db.exec(statement);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V3}`);
}

/**
 * Apply the frozen v4 additions and write exactly user_version 4.
 *
 * Additive only: `plan_attempts` and its indexes are created empty. No existing table is
 * rewritten and no existing row is touched.
 */
export function applySchemaV4(db: DatabaseSync): void {
  for (const statement of SCHEMA_DDL_V4) {
    db.exec(statement);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V4}`);
}

/**
 * Initialize an empty or metadata-only (v0) database straight to the current version.
 *
 * The v1, v2, v3 and v4 DDL runs in the **same** transaction, so a metadata-only database never
 * exists in an intermediate v1/v2/v3 state that a later open would have to migrate.
 */
export function initializeSchemaV4(db: DatabaseSync): void {
  inTransaction(
    db,
    () => {
      applySchemaV1(db);
      applySchemaV2(db);
      applySchemaV3(db);
      applySchemaV4(db);
    },
    'schema initialization',
  );
}

/** Migrate a recognized v1 database to the current version: one transaction, additive only. */
export function migrateSchemaV1ToV4(db: DatabaseSync): void {
  inTransaction(
    db,
    () => {
      applySchemaV2(db);
      applySchemaV3(db);
      applySchemaV4(db);
    },
    'schema migration',
  );
}

/** Migrate a recognized v2 database to the current version: one transaction, additive only. */
export function migrateSchemaV2ToV4(db: DatabaseSync): void {
  inTransaction(
    db,
    () => {
      applySchemaV3(db);
      applySchemaV4(db);
    },
    'schema migration',
  );
}

/** Migrate a recognized v3 database to the current version: one transaction, additive only. */
export function migrateSchemaV3ToV4(db: DatabaseSync): void {
  inTransaction(db, () => applySchemaV4(db), 'schema migration');
}

/**
 * Initialize an empty database to v3 inside one transaction (historical helper).
 *
 * Kept so tests and tooling can build a genuine v3 database: `applySchemaV3` keeps writing
 * version 3, and the store migrates such a file to the current version on open.
 */
export function initializeSchemaV3(db: DatabaseSync): void {
  inTransaction(
    db,
    () => {
      applySchemaV1(db);
      applySchemaV2(db);
      applySchemaV3(db);
    },
    'schema initialization',
  );
}

/**
 * Migrate a recognized v1 database to v3 (historical helper): one transaction, additive only.
 *
 * v3 is a real older version this build still recognizes, so this helper keeps ending at v3
 * instead of jumping to the current version.
 */
export function migrateSchemaV1ToV3(db: DatabaseSync): void {
  inTransaction(
    db,
    () => {
      applySchemaV2(db);
      applySchemaV3(db);
    },
    'schema migration',
  );
}

/** Migrate a recognized v2 database to v3 (historical helper): one transaction, additive only. */
export function migrateSchemaV2ToV3(db: DatabaseSync): void {
  inTransaction(db, () => applySchemaV3(db), 'schema migration');
}

/**
 * Initialize an empty database to v2 inside one transaction (historical helper).
 *
 * Kept so tests and tooling can build a genuine v2 database: `applySchemaV2` keeps writing
 * version 2, and the store migrates such a file to the current version on open.
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

/** Migrate a recognized v1 database to v2 (historical helper): one transaction, additive only. */
export function migrateSchemaV1ToV2(db: DatabaseSync): void {
  inTransaction(db, () => applySchemaV2(db), 'schema migration');
}

/**
 * Initialize a database to v1 inside one transaction.
 *
 * Kept for building and testing v1 fixtures; the store itself initializes to the current
 * version. On failure the transaction is rolled back and the original error is rethrown, so the
 * file stays exactly as it was found (an unreadable rollback is reported as `rollback_failed`).
 */
export function initializeSchemaV1(db: DatabaseSync): void {
  inTransaction(db, () => applySchemaV1(db), 'schema initialization');
}

/** Add schema v5 while keeping all historical DDL and helpers frozen. Caller already backed up. */
export function migrateToSchemaV5(db: DatabaseSync, from: number): void {
  inTransaction(db, () => {
    if (from < 1) applySchemaV1(db);
    if (from < 2) applySchemaV2(db);
    if (from < 3) applySchemaV3(db);
    if (from < 4) applySchemaV4(db);
    for (const statement of SCHEMA_DDL_V5) db.exec(statement);
    db.exec('PRAGMA user_version = 5');
  }, 'schema v5 migration');
}

/**
 * Add only missing versions and end at **v6**, whatever this build's current version is.
 *
 * Frozen historical helper: this is the step a real v6 file already went through, and the
 * v6 -> v7 migration below calls it for a file older than v6, so it must keep writing the literal
 * `user_version = 6` rather than {@link STORE_SCHEMA_VERSION} (which now names v7).
 */
export function migrateToSchemaV6(db: DatabaseSync, from: number): void {
  inTransaction(db, () => {
    if (from < 1) applySchemaV1(db);
    if (from < 2) applySchemaV2(db);
    if (from < 3) applySchemaV3(db);
    if (from < 4) applySchemaV4(db);
    if (from < 5) for (const statement of SCHEMA_DDL_V5) db.exec(statement);
    for (const statement of SCHEMA_DDL_V6) db.exec(statement);
    db.exec('PRAGMA user_version = 6');
  }, 'schema v6 migration');
}

/**
 * Add exactly the missing versions and end at the current schema, in one transaction.
 *
 * The caller has already taken (and verified) the pre-migration backup. Every historical DDL helper
 * keeps writing **its own** literal version, so a v6 fixture stays a genuine v6 database; only this
 * function moves a file to the version this build writes.
 */
export function migrateToSchemaV7(db: DatabaseSync, from: number): void {
  inTransaction(db, () => {
    if (from < 1) applySchemaV1(db);
    if (from < 2) applySchemaV2(db);
    if (from < 3) applySchemaV3(db);
    if (from < 4) applySchemaV4(db);
    if (from < 5) for (const statement of SCHEMA_DDL_V5) db.exec(statement);
    if (from < 6) for (const statement of SCHEMA_DDL_V6) db.exec(statement);
    for (const statement of SCHEMA_DDL_V7) db.exec(statement);
    db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
  }, 'schema v7 migration');
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
