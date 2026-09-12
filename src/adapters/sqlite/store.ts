/**
 * SQLite implementation of the {@link TrainingStore} port, built on the built-in
 * `node:sqlite` `DatabaseSync` (no dependency, no separate driver process).
 *
 * Shape of the implementation:
 *
 * - **One connection, serialized.** Every operation goes through a FIFO mutex and an
 *   `AsyncLocalStorage` transaction scope ({@link concurrency}), so an `await` inside a
 *   `transaction()` callback can never let an unrelated operation join — or be rolled back
 *   with — that transaction. Operations invoked *inside* the callback reuse the connection
 *   directly, which is why there is no deadlock and why they observe their own uncommitted
 *   writes (the manual-decision revision is meant to be captured that way).
 * - **Immutable records are content identities.** Snapshots, analyses, tag decisions and
 *   retrospectives are inserted once; re-saving the same id with a different body throws
 *   `immutable_violation` instead of overwriting history, and an identical re-save is a
 *   no-op. Mutable records (problems, submissions, jobs, plans, checkpoints) are upserted,
 *   with monotonic guards where losing data would corrupt accounting.
 * - **Batches are revision-guarded and attempts are append-only audits.** `saveBatch` refuses
 *   a stale `expectedRevision` before writing anything and never lets counters or a terminal
 *   state go backwards. A model-call attempt is inserted `reserved` before dispatch and only
 *   moves forward (`reserved → uncertain | settled`); a settled row can never be rewritten.
 * - **Coaching attempts are append-only audits of their own.** A reservation records the
 *   `expiresAt` recovery compares, moves only forward, keeps a host correlation once known, and
 *   a settled row is immutable; its quota count is global (never per account). Reads re-validate
 *   every stored body (valid JSON that is not a valid attempt is `corrupt_row`), and the account
 *   filter is three-valued: omitted = all accounts, explicit `null` = anonymous only.
 * - **Settings are one CAS-guarded singleton row.** The value is validated and detached on the
 *   way in and re-validated on the way out; a save only advances the stored revision when its
 *   `expectedRevision` matches, so a stale caller rejects before any write.
 * - **The head only moves forward.** `saveSnapshot` refuses to install an older version than
 *   the stored head, so an analysis of a newer snapshot can never be reverted by a late
 *   write of an old one.
 * - **Explicit paths.** The adapter creates the parent directory of the configured database
 *   path only; it never guesses a data directory and never copies a database file with the
 *   filesystem (backups go through `VACUUM INTO`, which includes WAL content).
 * - **Bounded reads.** List methods enforce the port's `1..500` page bound and return an
 *   opaque cursor; ordering is by the domain's stable ids, so paging is deterministic.
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  DomainError,
  assertIsoTimestamp,
  canonicalJson,
  contentHashOf,
  invariant,
  isLeaseExpired,
  naturalSortKey,
  problemKey,
  recoverAfterRestart,
  transitionJob,
  type Account,
  type AnalysisJobState,
  type AnalysisJobStatus,
  type AnalysisResult,
  type ManualTagDecision,
  type NormalizedProblem,
  type ProblemRef,
  type ProblemSnapshot,
  type Retrospective,
  type SnapshotHead,
  type SourceInstance,
  type Submission,
  type TagDecision,
  type TrainingPlan,
} from '../../domain/index.js';
import {
  BROWSE_PAGE_LIMITS,
  MAX_RATING_DIMENSION_CHARS,
  PROBLEM_SOLVED_FILTERS,
  PROBLEM_SORTS,
  RATING_SORTS,
  type Page,
  type PageRequest,
  type ProblemBrowsePage,
  type ProblemBrowseQuery,
  type ProblemQuery,
  type ProblemSolvedFilter,
  type ProblemSort,
  type StoreCapabilities,
  type TrainingStore,
} from '../../application/ports.js';
import {
  validateWorkbenchSettings,
  type SettingsStore,
  type WorkbenchSettings,
  type WorkbenchSettingsRecord,
} from '../../application/workbench-settings.js';
import {
  ANALYSIS_BATCH_STATUSES,
  MODEL_CALL_STATUSES,
  validateAnalysisBatch,
  validateAnalysisBatchTransition,
  validateModelCallAttempt,
  validateModelCallAttemptTransition,
  type AnalysisBatch,
  type AnalysisBatchStatus,
  type ModelCallAttempt,
  type ModelCallAttemptQuery,
} from '../../application/batch-types.js';
import {
  COACHING_STATUSES,
  validateCoachingAttempt,
  validateCoachingAttemptTransition,
  type CoachingAttempt,
  type CoachingAttemptCountQuery,
  type CoachingAttemptQuery,
  type CoachingStatus,
  type CoachingStore,
} from '../../application/coaching-types.js';
import {
  STORAGE_PAGE_LIMITS,
  SYNC_RESOURCES,
  syncCheckpointKey,
  type JobLeaseRequest,
  type SyncCheckpoint,
  type SyncCheckpointRef,
  type SyncResource,
} from '../../application/storage-types.js';
import { FifoMutex, TransactionScopes, type TransactionScope } from './concurrency.js';
import { StorageError } from './errors.js';
import {
  ACCOUNT_FIELDS,
  ANALYSIS_FIELDS,
  BATCH_FIELDS,
  COACHING_ATTEMPT_FIELDS,
  JOB_FIELDS,
  MANUAL_DECISION_FIELDS,
  MODEL_CALL_ATTEMPT_FIELDS,
  PLAN_FIELDS,
  PROBLEM_FIELDS,
  RETROSPECTIVE_FIELDS,
  SNAPSHOT_FIELDS,
  SOURCE_INSTANCE_FIELDS,
  SUBMISSION_FIELDS,
  TAG_DECISION_FIELDS,
  bodyOf,
  decodeCursor,
  encodeCursor,
  entityFromRow,
  intColumn,
  jobCounterRow,
  jobCounters,
  nullableTextColumn,
  parseBody,
  requireProblemKey,
  requireSameBody,
  requireValidSnapshot,
  snapshotIdentity,
  textColumn,
  type Row,
} from './entities.js';
import {
  SCHEMA_VERSION_EMPTY,
  SCHEMA_VERSION_V1,
  SCHEMA_VERSION_V2,
  STORE_MARKER,
  STORE_SCHEMA_VERSION,
  backupFileName,
  configureConnection,
  detectSchemaState,
  initializeSchemaV3,
  migrateSchemaV1ToV3,
  migrateSchemaV2ToV3,
  readMarker,
  readUserVersion,
} from './schema.js';
import { NATURAL_KEY_FUNCTION, RATING_VALUE_FUNCTION, ratingValueFromBody } from './sorting.js';

/** Values this adapter binds into prepared statements. */
type SqlValue = null | number | string;

const JOB_STATUSES: readonly AnalysisJobStatus[] = [
  'pending',
  'running',
  'paused_quota',
  'succeeded',
  'failed',
  'cancelled',
];

const SYNC_RESOURCE_VALUES: readonly string[] = SYNC_RESOURCES;

/** Terminal or deliberately paused states a lease claim must not touch. */
const UNCLAIMABLE: readonly AnalysisJobStatus[] = ['paused_quota', 'succeeded', 'failed', 'cancelled'];

export interface SqliteTrainingStoreOptions {
  /** Explicit database path. The parent directory is created when missing. */
  readonly path: string;
  /** Clock for store-maintained metadata (read timestamps, head version time). */
  readonly now?: () => string;
}

function requireId(label: string, value: string): string {
  invariant(typeof value === 'string' && value.length > 0, 'invalid_input', `${label} is required`, {
    label,
    value,
  });
  return value;
}

export class SqliteTrainingStore implements TrainingStore, SettingsStore, CoachingStore {
  readonly path: string;

  private readonly connection: DatabaseSync;
  private readonly clock: () => string;
  private readonly mutex = new FifoMutex();
  private readonly scopes = new TransactionScopes();
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(options: SqliteTrainingStoreOptions) {
    const path = options.path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new StorageError('invalid_path', 'database path must be a non-empty string', { path });
    }
    this.path = path;
    this.clock = options.now ?? (() => new Date().toISOString());
    const inMemory = path === ':memory:';
    if (!inMemory) {
      const parent = dirname(resolve(path));
      try {
        mkdirSync(parent, { recursive: true });
      } catch (error) {
        throw new StorageError('invalid_path', `database directory could not be created: ${parent}`, {
          path,
          cause: String(error),
        });
      }
    }
    let connection: DatabaseSync;
    try {
      connection = new DatabaseSync(path);
    } catch (error) {
      throw new StorageError('open_failed', `database could not be opened: ${path}`, {
        path,
        cause: String(error),
      });
    }
    this.connection = connection;
    try {
      this.openSchema(inMemory);
      this.registerSortFunctions();
    } catch (error) {
      // A half-opened store must not leak its file handle.
      let closeCause: string | null = null;
      try {
        connection.close();
      } catch (closeError) {
        closeCause = String(closeError);
      }
      if (closeCause !== null) {
        throw new StorageError('open_failed', 'store initialization failed and the database could not be closed', {
          path,
          cause: String(error),
          closeCause,
        });
      }
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError('open_failed', `store could not be opened: ${path}`, { path, cause: String(error) });
    }
  }

  // -------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------

  capabilities(): StoreCapabilities {
    return {
      implemented: true,
      schemaVersion: STORE_SCHEMA_VERSION,
      transactional: true,
      notes: [
        `node:sqlite DatabaseSync; schema marker ${STORE_MARKER}; one serialized connection`,
        'Databases from a newer schema are rejected before any write; v0, v1 and v2 databases are migrated after a verified consistent backup',
        'Snapshot/analysis/tag-decision/retrospective ids are immutable; jobs keep counters and leases',
        'Batches are revision-guarded with monotonic counters; model-call attempts move reserved -> uncertain|settled and settled rows are immutable',
        'Workbench settings are a singleton row saved under revision CAS',
        'Coaching attempts are indexed audits: reserved -> uncertain|settled, settled rows immutable, bodies re-validated on read, bounded cursor pages over a three-valued account scope, global count',
      ],
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.scopes.isActiveOwner(this)) {
      throw new StorageError('close_in_transaction', 'store cannot be closed from inside its own transaction', {
        path: this.path,
      });
    }
    await this.mutex.run(async () => {
      if (this.closed) {
        return;
      }
      this.statements.clear();
      this.connection.close();
      this.closed = true;
    });
  }

  /**
   * Write a consistent single-file copy of this database (WAL content included).
   *
   * The call rejects *before* queueing when it arrives inside this store's own transaction:
   * the transaction already owns the connection, so waiting for it would deadlock forever.
   * An operation left over from a transaction that already finished is rejected as
   * `transaction_scope_escaped`, like every other escaped operation.
   */
  async backupTo(path: string): Promise<void> {
    this.rejectOwnScope('backupTo');
    // Everything that touches the connection — including the open/closed check — happens
    // after the mutex is held, so a queued backup observes the store's real state.
    await this.mutex.run(async () => {
      this.assertOpen();
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw new StorageError('invalid_path', 'backup path must be a non-empty string', { path });
      }
      const target = resolve(path);
      if (target === resolve(this.path)) {
        throw new StorageError('invalid_path', 'backup target must differ from the database path', { path: target });
      }
      const parent = dirname(target);
      if (!existsSync(parent)) {
        throw new StorageError('invalid_path', `backup directory does not exist: ${parent}`, { path: target });
      }
      if (existsSync(target)) {
        throw new StorageError('backup_exists', `backup target already exists: ${target}`, { path: target });
      }
      this.vacuumInto(target);
      try {
        this.verifyBackup(target, STORE_SCHEMA_VERSION, true);
      } catch (error) {
        this.removeUnverifiedBackup(target, error);
      }
    });
  }

  // -------------------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------------------

  /**
   * Run `work` inside one store transaction; a throw rolls every write back.
   *
   * Nested transactions are **not** supported: the store owns one connection, so two
   * savepoint-backed callbacks could release or roll back each other's work. A nested
   * `transaction()` call is therefore rejected with `nested_transaction` before its callback
   * runs. Operations invoked inside the callback (reads and writes) still reuse the owned
   * connection, so they see the transaction's own uncommitted writes.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (typeof work !== 'function') {
      throw new DomainError('invalid_input', 'transaction requires a callback', {});
    }
    this.rejectOwnScope('transaction');
    this.assertOpen();
    return this.mutex.run(async () => {
      // A call that queued behind another operation may have outlived a close().
      this.assertOpen();
      const scope: TransactionScope = { store: this, active: true };
      this.connection.exec('BEGIN IMMEDIATE');
      let value: T;
      try {
        value = await this.scopes.run(scope, work);
      } catch (error) {
        scope.active = false;
        this.rollback(error);
        throw error;
      }
      scope.active = false;
      try {
        this.connection.exec('COMMIT');
      } catch (error) {
        this.rollback(error);
        throw error;
      }
      return value;
    });
  }

  /**
   * Reject a call that arrives inside this store's own transaction scope, before it queues.
   *
   * An *active* scope already owns the connection, so `transaction()` and `backupTo()` would
   * wait on a mutex only their own caller can release: the first is an unsupported nested
   * transaction, the second a guaranteed deadlock. An *inactive* scope means the call was
   * started inside a transaction that has since finished; letting it proceed would run
   * outside the transaction it belongs to, so it is reported like any other escaped operation.
   */
  private rejectOwnScope(operation: 'transaction' | 'backupTo'): void {
    const scope = this.scopes.current();
    if (scope === undefined || scope.store !== this) {
      return;
    }
    if (!scope.active) {
      throw new StorageError(
        'transaction_scope_escaped',
        `${operation} ran after its owning transaction finished`,
        { path: this.path, operation },
      );
    }
    if (operation === 'transaction') {
      throw new StorageError(
        'nested_transaction',
        'nested transactions are not supported; run the work in the outer transaction instead',
        { path: this.path },
      );
    }
    throw new StorageError(
      'backup_in_transaction',
      'backupTo cannot run inside a transaction of the same store',
      { path: this.path },
    );
  }

  private rollback(original: unknown): void {
    try {
      this.connection.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new StorageError('rollback_failed', 'transaction rollback failed', {
        path: this.path,
        cause: String(rollbackError),
        original: String(original),
      });
    }
  }

  // -------------------------------------------------------------------------------------
  // Sources, accounts & sync checkpoints
  // -------------------------------------------------------------------------------------

  async upsertSourceInstances(instances: readonly SourceInstance[]): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      for (const instance of instances) {
        this.write(
          `INSERT INTO source_instances (id, platform, base_url, domain, display_name, body)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, base_url = excluded.base_url,
             domain = excluded.domain, display_name = excluded.display_name, body = excluded.body`,
          [
            requireId('source instance id', instance.id),
            instance.platform,
            instance.baseUrl,
            instance.domain,
            instance.displayName,
            bodyOf(instance, SOURCE_INSTANCE_FIELDS),
          ],
        );
      }
    });
  }

  async getSourceInstance(id: string): Promise<SourceInstance | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM source_instances WHERE id = ?', [requireId('source instance id', id)]);
      return row === null ? null : entityFromRow<SourceInstance>('source_instances.body', row);
    });
  }

  async listSourceInstances(): Promise<readonly SourceInstance[]> {
    this.assertOpen();
    return this.withRead(() =>
      this.all('SELECT body FROM source_instances ORDER BY id ASC').map((row) =>
        entityFromRow<SourceInstance>('source_instances.body', row),
      ),
    );
  }

  async upsertAccounts(accounts: readonly Account[]): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      for (const account of accounts) {
        this.write(
          `INSERT INTO accounts (id, source_instance_id, handle, display_name, profile_url, body)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET source_instance_id = excluded.source_instance_id,
             handle = excluded.handle, display_name = excluded.display_name,
             profile_url = excluded.profile_url, body = excluded.body`,
          [
            requireId('account id', account.id),
            account.sourceInstanceId,
            account.handle,
            account.displayName,
            account.profileUrl,
            bodyOf(account, ACCOUNT_FIELDS),
          ],
        );
      }
    });
  }

  async getAccount(id: string): Promise<Account | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM accounts WHERE id = ?', [requireId('account id', id)]);
      return row === null ? null : entityFromRow<Account>('accounts.body', row);
    });
  }

  async listAccounts(sourceInstanceId: string | null): Promise<readonly Account[]> {
    this.assertOpen();
    return this.withRead(() => {
      const rows =
        sourceInstanceId === null
          ? this.all('SELECT body FROM accounts ORDER BY id ASC')
          : this.all('SELECT body FROM accounts WHERE source_instance_id = ? ORDER BY id ASC', [sourceInstanceId]);
      return rows.map((row) => entityFromRow<Account>('accounts.body', row));
    });
  }

  async getSyncCheckpoint(ref: SyncCheckpointRef): Promise<SyncCheckpoint | null> {
    this.assertOpen();
    return this.withRead(() => {
      requireSyncResource(ref.resource);
      const row = this.find('SELECT body FROM sync_checkpoints WHERE checkpoint_key = ?', [syncCheckpointKey(ref)]);
      return row === null ? null : entityFromRow<SyncCheckpoint>('sync_checkpoints.body', row);
    });
  }

  async saveSyncCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      requireSyncResource(checkpoint.resource);
      assertIsoTimestamp('checkpoint updatedAt', checkpoint.updatedAt);
      const body = canonicalJson({
        sourceInstanceId: checkpoint.sourceInstanceId,
        accountId: checkpoint.accountId,
        resource: checkpoint.resource,
        cursor: checkpoint.cursor,
        since: checkpoint.since,
        updatedAt: checkpoint.updatedAt,
      });
      this.write(
        `INSERT INTO sync_checkpoints (checkpoint_key, source_instance_id, account_id, resource, cursor, since, updated_at, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checkpoint_key) DO UPDATE SET cursor = excluded.cursor, since = excluded.since,
           updated_at = excluded.updated_at, body = excluded.body`,
        [
          syncCheckpointKey(checkpoint),
          checkpoint.sourceInstanceId,
          checkpoint.accountId,
          checkpoint.resource,
          checkpoint.cursor,
          checkpoint.since,
          checkpoint.updatedAt,
          body,
        ],
      );
    });
  }

  // -------------------------------------------------------------------------------------
  // Problems & submissions
  // -------------------------------------------------------------------------------------

  async upsertProblems(problems: readonly NormalizedProblem[]): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      for (const problem of problems) {
        this.writeProblem(problem);
      }
    });
  }

  async listProblems(query: ProblemQuery): Promise<Page<NormalizedProblem>> {
    this.assertOpen();
    return this.withRead(() => {
      const limit = pageLimit(query.limit);
      const cursor = query.cursor === null ? null : decodeCursor('problem', query.cursor);
      const filters: string[] = [];
      const params: SqlValue[] = [];
      if (query.sourceInstanceId !== undefined && query.sourceInstanceId !== null) {
        filters.push('source_instance_id = ?');
        params.push(query.sourceInstanceId);
      }
      if (query.accountId !== undefined && query.accountId !== null) {
        // Account scope = the problems this account actually submitted to, never the whole bank.
        filters.push(
          'EXISTS (SELECT 1 FROM submissions s WHERE s.problem_key = problems.key AND s.account_id = ?)',
        );
        params.push(query.accountId);
      }
      const search = problemSearchTerm(query.query);
      if (search !== null) {
        // Literal substring match (`instr`, never `LIKE`), so `%`, `_` and quotes are ordinary
        // characters; both the title and the platform external key are searched in SQL.
        filters.push('(instr(lower(title), lower(?)) > 0 OR instr(lower(external_key), lower(?)) > 0)');
        params.push(search, search);
      }
      if (reviewOnlyFlag(query.needsReviewOnly)) {
        filters.push(PENDING_REVIEW_PREDICATE);
      }
      if (cursor !== null) {
        filters.push('key > ?');
        params.push(cursor);
      }
      const where = filters.length === 0 ? '' : ` WHERE ${filters.join(' AND ')}`;
      const rows = this.all(`SELECT key, body FROM problems${where} ORDER BY key ASC LIMIT ?`, [
        ...params,
        limit + 1,
      ]);
      const items = rows
        .slice(0, limit)
        .map((row) => entityFromRow<NormalizedProblem>('problems.body', row));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor('problem', last.key) : null,
        fetchedAt: this.clock(),
      };
    });
  }

  /**
   * One numbered page of the filtered bank, with the total of the SAME predicate set.
   *
   * The `COUNT(*)` and the `LIMIT/OFFSET` selection run in one serialized read, so `totalItems` can
   * never describe a different query than `items`. Solved status is decided per row by an indexed
   * `EXISTS` over `submissions_by_problem`, scoped to the account, to the account's own stored source
   * instance AND to the problem's full stored identity (canonical key plus source instance, domain
   * and external key), so a submission that is foreign to the problem's instance — or an incoherent
   * stored row that borrows this account id for another instance — can never confer a solve; no
   * submission history is walked, so the legacy 50k-row history cap does not
   * apply here. A page beyond the last match is clamped to the last valid page, and an empty filter
   * set reports `page: 1` with `totalPages: 0`.
   */
  async browseProblems(query: ProblemBrowseQuery): Promise<ProblemBrowsePage> {
    this.assertOpen();
    return this.withRead(() => {
      const limit = browsePageLimit(query.limit);
      const requestedPage = browsePageNumber(query.page);
      const accountId = browseAccountId(query.accountId);
      const status = browseStatus(query.status);
      const onlyAttempted = browseAttemptedFlag(query.onlyAttempted);
      // Both predicates are answered from one account's own submissions; without an account they
      // have no meaning, so the adapter refuses them instead of quietly dropping the filter.
      invariant(
        status === 'all' || accountId !== null,
        'invalid_input',
        'a solved-state filter needs an explicit account id',
        { status },
      );
      invariant(
        !onlyAttempted || accountId !== null,
        'invalid_input',
        'an attempt filter needs an explicit account id',
        {},
      );
      const filters: string[] = [];
      const params: SqlValue[] = [];
      if (query.sourceInstanceId !== undefined && query.sourceInstanceId !== null) {
        filters.push('problems.source_instance_id = ?');
        params.push(requireId('source instance id', query.sourceInstanceId));
      }
      if (accountId !== null) {
        if (status === 'solved') {
          filters.push(ACCEPTED_SUBMISSION_EXISTS);
          params.push(accountId);
        } else if (status === 'unconfirmed') {
          filters.push(`NOT ${ACCEPTED_SUBMISSION_EXISTS}`);
          params.push(accountId);
        }
        if (onlyAttempted) {
          filters.push(ATTEMPTED_SUBMISSION_EXISTS);
          params.push(accountId);
        }
      }
      const search = problemSearchTerm(query.query);
      if (search !== null) {
        // The same literal `instr` match as `listProblems`: `%`, `_` and quotes stay ordinary
        // characters, and the term is always a bound parameter, never interpolated.
        filters.push(
          '(instr(lower(problems.title), lower(?)) > 0 OR instr(lower(problems.external_key), lower(?)) > 0)',
        );
        params.push(search, search);
      }
      if (reviewOnlyFlag(query.needsReviewOnly)) {
        filters.push(PENDING_REVIEW_PREDICATE);
      }
      const where = filters.length === 0 ? '' : ` WHERE ${filters.join(' AND ')}`;
      // The ordering — and, for a difficulty sort, its explicit source instance and raw dimension —
      // is resolved before the first read, so an unsupported order never reaches the count.
      const ordering = browseOrdering(query.sort, query.ratingDimension, query.sourceInstanceId);
      const counted = this.find(`SELECT COUNT(*) AS total FROM problems${where}`, params);
      const totalItems = counted === null ? 0 : intColumn(counted, 'total');
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
      const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
      // The solved expression stands in the SELECT list, i.e. BEFORE the WHERE clause, so its bound
      // account parameter precedes every filter parameter.
      const solvedSelect = accountId === null ? '0' : ACCEPTED_SUBMISSION_EXISTS;
      const solvedParams: SqlValue[] = accountId === null ? [] : [accountId];
      const rows = this.all(
        `SELECT problems.key, problems.body, ${solvedSelect} AS solved
           FROM problems${where}
          ORDER BY ${ordering.clause}
          LIMIT ? OFFSET ?`,
        [...solvedParams, ...params, ...ordering.params, limit, (page - 1) * limit],
      );
      const items = rows.map((row) => {
        const key = textColumn(row, 'key');
        const problem = entityFromRow<NormalizedProblem>('problems.body', row);
        invariant(
          problem.key === key,
          'invalid_input',
          `stored problem row ${key} carries a body for ${problem.key}`,
          { reason: 'problem_key_mismatch', rowKey: key, bodyKey: problem.key },
        );
        return { problem, solvedByAccount: intColumn(row, 'solved') === 1 };
      });
      return { items, page, pageSize: limit, totalItems, totalPages, fetchedAt: this.clock() };
    });
  }

  /** One problem by canonical key; the deterministic lookup the pipeline and adapters use. */
  async getProblem(problemKeyValue: string): Promise<NormalizedProblem | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM problems WHERE key = ?', [requireProblemKey(problemKeyValue)]);
      return row === null ? null : entityFromRow<NormalizedProblem>('problems.body', row);
    });
  }

  /**
   * Register the two deterministic scalar functions the bank sorts use.
   *
   * Both are `deterministic: true`, so SQLite may evaluate them inside an `ORDER BY` (and would let
   * them appear in an index expression). They take only bound values — never a SQL fragment — and
   * are pure: the same input always produces the same output, which is what makes a page built from
   * them repeatable. They live as long as the connection; `close()` releases the connection (and
   * with it the function table) and clears the prepared-statement cache that referenced them.
   *
   * A host whose `DatabaseSync` predates `function()` cannot serve a sorted bank, and that is
   * reported here as a typed refusal instead of letting the first sorted request fail with a raw
   * `no such function` error.
   */
  private registerSortFunctions(): void {
    const register = (this.connection as { function?: unknown }).function;
    if (typeof register !== 'function') {
      throw new StorageError(
        'open_failed',
        'this node:sqlite build cannot register the deterministic sort functions the bank needs',
        { path: this.path, node: process.version },
      );
    }
    this.connection.function(NATURAL_KEY_FUNCTION, { deterministic: true }, (value: unknown) =>
      typeof value === 'string' ? naturalSortKey(value) : null,
    );
    this.connection.function(RATING_VALUE_FUNCTION, { deterministic: true }, (body: unknown, dimension: unknown) =>
      ratingValueFromBody(body, dimension),
    );
  }

  async upsertSubmissions(submissions: readonly Submission[]): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      for (const submission of submissions) {
        this.writeSubmission(submission);
      }
    });
  }

  async listSubmissions(accountId: string, query: PageRequest): Promise<Page<Submission>> {
    this.assertOpen();
    return this.withRead(() => {
      requireId('account id', accountId);
      const limit = pageLimit(query.limit);
      const cursor = query.cursor === null ? null : decodeCursor('submission', query.cursor);
      const params: SqlValue[] = [accountId];
      let where = ' WHERE account_id = ?';
      if (cursor !== null) {
        where += ' AND id > ?';
        params.push(cursor);
      }
      const rows = this.all(`SELECT body FROM submissions${where} ORDER BY id ASC LIMIT ?`, [...params, limit + 1]);
      const items = rows.slice(0, limit).map((row) => entityFromRow<Submission>('submissions.body', row));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor('submission', last.id) : null,
        fetchedAt: this.clock(),
      };
    });
  }

  // -------------------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------------------

  async getCurrentSnapshotHead(ref: ProblemRef): Promise<SnapshotHead | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT snapshot_id, content_hash, version FROM snapshot_heads WHERE problem_key = ?', [
        problemKey(ref),
      ]);
      if (row === null) {
        return null;
      }
      return {
        snapshotId: textColumn(row, 'snapshot_id'),
        contentHash: textColumn(row, 'content_hash'),
        version: intColumn(row, 'version'),
      };
    });
  }

  async getSnapshot(snapshotId: string): Promise<ProblemSnapshot | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM snapshots WHERE snapshot_id = ?', [
        requireId('snapshot id', snapshotId),
      ]);
      return row === null ? null : entityFromRow<ProblemSnapshot>('snapshots.body', row);
    });
  }

  async saveSnapshot(snapshot: ProblemSnapshot): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      this.writeSnapshot(snapshot);
    });
  }

  // -------------------------------------------------------------------------------------
  // Analyses & jobs
  // -------------------------------------------------------------------------------------

  async getAnalysis(analysisId: string): Promise<AnalysisResult | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM analyses WHERE analysis_id = ?', [
        requireId('analysis id', analysisId),
      ]);
      return row === null ? null : entityFromRow<AnalysisResult>('analyses.body', row);
    });
  }

  async listAnalyses(problemKeyValue: string): Promise<readonly AnalysisResult[]> {
    this.assertOpen();
    return this.withRead(() =>
      this.all('SELECT body FROM analyses WHERE problem_key = ? ORDER BY created_at ASC, analysis_id ASC', [
        requireProblemKey(problemKeyValue),
      ]).map((row) => entityFromRow<AnalysisResult>('analyses.body', row)),
    );
  }

  async saveAnalysis(result: AnalysisResult): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      requireProblemKey(result.problemKey);
      const body = bodyOf(result, ANALYSIS_FIELDS);
      const existing = this.find('SELECT body FROM analyses WHERE analysis_id = ?', [result.analysisId]);
      if (existing !== null) {
        requireSameBody('analysis', result.analysisId, textColumn(existing, 'body'), body);
        return;
      }
      this.write(
        `INSERT INTO analyses (analysis_id, problem_key, snapshot_id, snapshot_version, taxonomy_version, status, created_at, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.analysisId,
          result.problemKey,
          result.snapshotId,
          result.snapshotVersion,
          result.taxonomyVersion,
          result.status,
          result.createdAt,
          body,
        ],
      );
    });
  }

  async getJob(jobId: string): Promise<AnalysisJobState | null> {
    this.assertOpen();
    return this.withRead(() => this.readJob(requireId('job id', jobId)));
  }

  async listJobs(status: AnalysisJobStatus | null): Promise<readonly AnalysisJobState[]> {
    this.assertOpen();
    return this.withRead(() => {
      if (status !== null && !JOB_STATUSES.includes(status)) {
        throw new DomainError('invalid_input', `unknown job status ${String(status)}`, { status });
      }
      const rows =
        status === null
          ? this.all('SELECT body FROM jobs ORDER BY updated_at DESC, job_id ASC')
          : this.all('SELECT body FROM jobs WHERE status = ? ORDER BY updated_at DESC, job_id ASC', [status]);
      return rows.map((row) => entityFromRow<AnalysisJobState>('jobs.body', row));
    });
  }

  async saveJob(state: AnalysisJobState): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => this.writeJob(state));
  }

  async claimJob(request: JobLeaseRequest): Promise<AnalysisJobState | null> {
    this.assertOpen();
    const owner = requireId('lease owner', request.owner);
    assertIsoTimestamp('lease at', request.at);
    invariant(
      Number.isInteger(request.leaseMs) && request.leaseMs > 0,
      'invalid_input',
      'leaseMs must be a positive integer',
      { leaseMs: request.leaseMs },
    );
    return this.transaction(async () => {
      const state = this.readJob(requireId('job id', request.jobId));
      if (state === null || UNCLAIMABLE.includes(state.status)) {
        return null;
      }
      if (state.status === 'running' && !isLeaseExpired(state, request.at)) {
        return null;
      }
      const claimable =
        state.status === 'running' ? transitionJob(state, { type: 'requeue', at: request.at }) : state;
      const claimed = transitionJob(claimable, {
        type: 'start',
        owner,
        at: request.at,
        leaseMs: request.leaseMs,
      });
      this.writeJob(claimed);
      return claimed;
    });
  }

  async recoverExpiredJobs(now: string): Promise<number> {
    this.assertOpen();
    assertIsoTimestamp('now', now);
    return this.transaction(async () => {
      const rows = this.all(`SELECT body FROM jobs WHERE status = 'running' ORDER BY job_id ASC`);
      let recovered = 0;
      for (const row of rows) {
        const state = entityFromRow<AnalysisJobState>('jobs.body', row);
        if (!isLeaseExpired(state, now)) {
          continue;
        }
        this.writeJob(recoverAfterRestart(state, now));
        recovered += 1;
      }
      return recovered;
    });
  }

  // -------------------------------------------------------------------------------------
  // Analysis batches & model-call attempts
  // -------------------------------------------------------------------------------------

  async getBatch(batchId: string): Promise<AnalysisBatch | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM analysis_batches WHERE batch_id = ?', [
        requireId('batch id', batchId),
      ]);
      return row === null ? null : entityFromRow<AnalysisBatch>('analysis_batches.body', row);
    });
  }

  async listBatches(status: AnalysisBatchStatus | null): Promise<readonly AnalysisBatch[]> {
    this.assertOpen();
    return this.withRead(() => {
      if (status !== null && !ANALYSIS_BATCH_STATUSES.includes(status)) {
        throw new DomainError('invalid_input', `unknown batch status ${String(status)}`, { status });
      }
      const rows =
        status === null
          ? this.all('SELECT body FROM analysis_batches ORDER BY created_at ASC, batch_id ASC')
          : this.all('SELECT body FROM analysis_batches WHERE status = ? ORDER BY created_at ASC, batch_id ASC', [
              status,
            ]);
      return rows.map((row) => entityFromRow<AnalysisBatch>('analysis_batches.body', row));
    });
  }

  async saveBatch(batch: AnalysisBatch, expectedRevision: number | null): Promise<number> {
    this.assertOpen();
    return this.withWrite(() => this.writeBatch(batch, expectedRevision));
  }

  async getModelCallAttempt(attemptId: string): Promise<ModelCallAttempt | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM model_call_attempts WHERE attempt_id = ?', [
        requireId('attempt id', attemptId),
      ]);
      return row === null ? null : entityFromRow<ModelCallAttempt>('model_call_attempts.body', row);
    });
  }

  async listModelCallAttempts(query: ModelCallAttemptQuery): Promise<readonly ModelCallAttempt[]> {
    this.assertOpen();
    return this.withRead(() => {
      const filters: string[] = [];
      const params: SqlValue[] = [];
      if (query.batchId !== undefined && query.batchId !== null) {
        filters.push('batch_id = ?');
        params.push(requireId('batch id', query.batchId));
      }
      if (query.jobId !== undefined && query.jobId !== null) {
        filters.push('job_id = ?');
        params.push(requireId('job id', query.jobId));
      }
      if (query.status !== undefined && query.status !== null) {
        if (!MODEL_CALL_STATUSES.includes(query.status)) {
          throw new DomainError('invalid_input', `unknown model call status ${String(query.status)}`, {
            status: query.status,
          });
        }
        filters.push('status = ?');
        params.push(query.status);
      }
      const where = filters.length === 0 ? '' : ` WHERE ${filters.join(' AND ')}`;
      return this.all(
        `SELECT body FROM model_call_attempts${where} ORDER BY requested_at ASC, attempt_id ASC`,
        params,
      ).map((row) => entityFromRow<ModelCallAttempt>('model_call_attempts.body', row));
    });
  }

  async saveModelCallAttempt(attempt: ModelCallAttempt): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => this.writeModelCallAttempt(attempt));
  }

  // -------------------------------------------------------------------------------------
  // Tag decisions
  // -------------------------------------------------------------------------------------

  async listTagDecisions(problemKeyValue: string): Promise<readonly TagDecision[]> {
    this.assertOpen();
    return this.withRead(() =>
      this.all('SELECT body FROM tag_decisions WHERE problem_key = ? ORDER BY decided_at ASC, decision_id ASC', [
        requireProblemKey(problemKeyValue),
      ]).map((row) => entityFromRow<TagDecision>('tag_decisions.body', row)),
    );
  }

  async saveTagDecisions(decisions: readonly TagDecision[]): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      for (const decision of decisions) {
        requireProblemKey(decision.problemKey);
        const body = bodyOf(decision, TAG_DECISION_FIELDS);
        const existing = this.find('SELECT body FROM tag_decisions WHERE decision_id = ?', [decision.decisionId]);
        if (existing !== null) {
          requireSameBody('tag decision', decision.decisionId, textColumn(existing, 'body'), body);
          continue;
        }
        this.write(
          `INSERT INTO tag_decisions (decision_id, problem_key, taxonomy_id, status, origin, analysis_id, decided_at, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            decision.decisionId,
            decision.problemKey,
            decision.taxonomyId,
            decision.status,
            decision.origin,
            decision.analysisId,
            decision.decidedAt,
            body,
          ],
        );
      }
    });
  }

  async listManualDecisions(problemKeyValue: string): Promise<readonly ManualTagDecision[]> {
    this.assertOpen();
    return this.withRead(() =>
      this.all('SELECT body FROM manual_decisions WHERE problem_key = ? ORDER BY decided_at ASC, decision_id ASC', [
        requireProblemKey(problemKeyValue),
      ]).map((row) => entityFromRow<ManualTagDecision>('manual_decisions.body', row)),
    );
  }

  async saveManualDecision(decision: ManualTagDecision): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => this.writeManualDecision(decision));
  }

  async getManualRevision(problemKeyValue: string): Promise<number> {
    this.assertOpen();
    return this.withRead(() => this.readManualRevision(requireProblemKey(problemKeyValue)));
  }

  // -------------------------------------------------------------------------------------
  // Training
  // -------------------------------------------------------------------------------------

  async saveRetrospective(retrospective: Retrospective): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => {
      requireProblemKey(retrospective.problemKey);
      const body = bodyOf(retrospective, RETROSPECTIVE_FIELDS);
      const existing = this.find('SELECT body FROM retrospectives WHERE retrospective_id = ?', [
        retrospective.retrospectiveId,
      ]);
      if (existing !== null) {
        requireSameBody(
          'retrospective',
          retrospective.retrospectiveId,
          textColumn(existing, 'body'),
          body,
        );
        return;
      }
      this.write(
        `INSERT INTO retrospectives (retrospective_id, problem_key, account_id, mode, recorded_at, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          retrospective.retrospectiveId,
          retrospective.problemKey,
          retrospective.accountId,
          retrospective.mode,
          retrospective.recordedAt,
          body,
        ],
      );
    });
  }

  async listRetrospectives(accountId: string): Promise<readonly Retrospective[]> {
    this.assertOpen();
    return this.withRead(() =>
      this.all('SELECT body FROM retrospectives WHERE account_id = ? ORDER BY recorded_at ASC, retrospective_id ASC', [
        requireId('account id', accountId),
      ]).map((row) => entityFromRow<Retrospective>('retrospectives.body', row)),
    );
  }

  async savePlan(plan: TrainingPlan): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => this.writePlan(plan));
  }

  async getPlan(planId: string): Promise<TrainingPlan | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM plans WHERE plan_id = ?', [requireId('plan id', planId)]);
      return row === null ? null : entityFromRow<TrainingPlan>('plans.body', row);
    });
  }

  async listPlans(accountId: string | null): Promise<readonly TrainingPlan[]> {
    this.assertOpen();
    return this.withRead(() => {
      const rows =
        accountId === null
          ? this.all('SELECT body FROM plans ORDER BY created_at ASC, plan_id ASC')
          : this.all('SELECT body FROM plans WHERE account_id = ? ORDER BY created_at ASC, plan_id ASC', [accountId]);
      return rows.map((row) => entityFromRow<TrainingPlan>('plans.body', row));
    });
  }

  // -------------------------------------------------------------------------------------
  // Workbench settings (SettingsStore)
  // -------------------------------------------------------------------------------------

  /**
   * The singleton settings row, or `null` before the first save.
   *
   * The stored body is re-validated on read, so a hand-edited or truncated row is reported as
   * `corrupt_row` instead of being handed out as a valid configuration.
   */
  async getWorkbenchSettings(): Promise<WorkbenchSettingsRecord | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT revision, body FROM workbench_settings WHERE id = 1');
      if (row === null) {
        return null;
      }
      const revision = intColumn(row, 'revision');
      const parsed = parseBody<unknown>('workbench_settings.body', textColumn(row, 'body'));
      try {
        return { revision, value: validateWorkbenchSettings(parsed) };
      } catch (error) {
        throw new StorageError('corrupt_row', 'stored workbench settings are not a valid configuration', {
          revision,
          cause: String(error),
        });
      }
    });
  }

  /** Save under revision CAS; see {@link SettingsStore.saveWorkbenchSettings}. */
  async saveWorkbenchSettings(value: WorkbenchSettings, expectedRevision: number | null): Promise<number> {
    this.assertOpen();
    return this.withWrite(() => this.writeWorkbenchSettings(value, expectedRevision));
  }

  // -------------------------------------------------------------------------------------
  // Coaching attempts (CoachingStore)
  // -------------------------------------------------------------------------------------

  /**
   * One attempt by id, or `null`.
   *
   * The stored canonical body is the record and is re-validated on read, so a hand-edited or
   * otherwise malformed body is reported as `corrupt_row` instead of being cast to an attempt.
   */
  async getCoachingAttempt(id: string): Promise<CoachingAttempt | null> {
    this.assertOpen();
    return this.withRead(() => {
      const row = this.find('SELECT body FROM coaching_attempts WHERE id = ?', [
        requireId('coaching attempt id', id),
      ]);
      return row === null ? null : this.readCoachingAttempt(row);
    });
  }

  /** Insert a reservation or advance it; see {@link CoachingStore.saveCoachingAttempt}. */
  async saveCoachingAttempt(attempt: CoachingAttempt): Promise<void> {
    this.assertOpen();
    return this.withWrite(() => this.writeCoachingAttempt(attempt));
  }

  /**
   * One page of attempts in deterministic `requestedAt, id` order.
   *
   * The cursor is opaque and bound to the effective filter set — including the three-valued
   * account scope (`undefined` = all accounts, `null` = anonymous only): a cursor produced by
   * another query is rejected (`reason: 'cursor_filter_mismatch'`) instead of silently paging a
   * different history, and continuation is keyset-based, never `OFFSET`. Every returned body is
   * re-validated like {@link getCoachingAttempt}.
   */
  async listCoachingAttempts(query: CoachingAttemptQuery): Promise<Page<CoachingAttempt>> {
    this.assertOpen();
    return this.withRead(() => {
      const limit = pageLimit(query.limit);
      const filters = coachingFilters(query);
      const fingerprint = coachingFingerprint(filters);
      const cursor = query.cursor === null ? null : decodeCoachingCursor(query.cursor, fingerprint);
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      // Omitted means every account; an explicit `null` is the anonymous-only scope.
      if (filters.accountId === null) {
        clauses.push('account_id IS NULL');
      } else if (filters.accountId !== undefined) {
        clauses.push('account_id = ?');
        params.push(filters.accountId);
      }
      if (filters.problemKey !== null) {
        clauses.push('problem_key = ?');
        params.push(filters.problemKey);
      }
      if (filters.since !== null) {
        clauses.push('requested_at >= ?');
        params.push(filters.since);
      }
      if (filters.status !== null) {
        clauses.push('status = ?');
        params.push(filters.status);
      }
      if (cursor !== null) {
        // Keyset continuation on the stable order: later instants, then later ids at the same instant.
        clauses.push('(requested_at > ? OR (requested_at = ? AND id > ?))');
        params.push(cursor.requestedAt, cursor.requestedAt, cursor.id);
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      const rows = this.all(
        `SELECT body FROM coaching_attempts${where} ORDER BY requested_at ASC, id ASC LIMIT ?`,
        [...params, limit + 1],
      );
      const items = rows.slice(0, limit).map((row) => this.readCoachingAttempt(row));
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor('coaching', JSON.stringify({ f: fingerprint, t: last.requestedAt, i: last.id }))
            : null,
        fetchedAt: this.clock(),
      };
    });
  }

  /**
   * Count attempts for the global coaching quota.
   *
   * A single `COUNT(*)` resolves through the v3 indexes (status and `requestedAt`), so the
   * total never loads attempt bodies and never becomes a per-account loophole: there is no
   * account scope here on purpose.
   */
  async countCoachingAttempts(query: CoachingAttemptCountQuery): Promise<number> {
    this.assertOpen();
    return this.withRead(() => {
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      if (query.since !== undefined && query.since !== null) {
        clauses.push('requested_at >= ?');
        params.push(assertIsoTimestamp('coaching since', query.since));
      }
      if (query.status !== undefined && query.status !== null) {
        clauses.push('status = ?');
        params.push(requireCoachingStatus(query.status));
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      const row = this.find(`SELECT COUNT(*) AS total FROM coaching_attempts${where}`, params);
      return row === null ? 0 : intColumn(row, 'total');
    });
  }

  // -------------------------------------------------------------------------------------
  // Write helpers (always called inside a serialized write scope)
  // -------------------------------------------------------------------------------------

  private writeProblem(problem: NormalizedProblem): void {
    const derived = problemKey(problem.ref);
    if (derived !== problem.key) {
      throw new DomainError('invalid_input', 'problem key does not match its reference', {
        declared: problem.key,
        derived,
      });
    }
    this.write(
      `INSERT INTO problems (key, source_instance_id, domain, external_key, title, fetched_at, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET source_instance_id = excluded.source_instance_id,
         domain = excluded.domain, external_key = excluded.external_key, title = excluded.title,
         fetched_at = excluded.fetched_at, body = excluded.body`,
      [
        problem.key,
        problem.ref.sourceInstanceId,
        problem.ref.domain,
        problem.ref.externalKey,
        problem.title,
        problem.fetchedAt,
        bodyOf(problem, PROBLEM_FIELDS),
      ],
    );
  }

  private writeSubmission(submission: Submission): void {
    const derived = problemKey(submission.ref);
    if (derived !== submission.key) {
      throw new DomainError('invalid_input', 'submission key does not match its reference', {
        declared: submission.key,
        derived,
      });
    }
    requireId('submission account id', submission.accountId);
    this.write(
      `INSERT INTO submissions (id, account_id, problem_key, source_instance_id, domain, external_key, external_id, verdict, submitted_at, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, problem_key = excluded.problem_key,
         source_instance_id = excluded.source_instance_id, domain = excluded.domain,
         external_key = excluded.external_key, external_id = excluded.external_id,
         verdict = excluded.verdict, submitted_at = excluded.submitted_at, body = excluded.body`,
      [
        submission.id,
        submission.accountId,
        submission.key,
        submission.ref.sourceInstanceId,
        submission.ref.domain,
        submission.ref.externalKey,
        submission.externalId,
        submission.verdict,
        submission.submittedAt,
        bodyOf(submission, SUBMISSION_FIELDS),
      ],
    );
  }

  private writeSnapshot(snapshot: ProblemSnapshot): void {
    const key = requireValidSnapshot(snapshot);
    const existing = this.find('SELECT body FROM snapshots WHERE snapshot_id = ?', [snapshot.snapshotId]);
    if (existing !== null) {
      // Same content-addressed id: only observation timestamps may differ, and the first
      // capture is kept. Any semantic difference means a body that does not match its id.
      const stored = parseBody<ProblemSnapshot>('snapshots.body', textColumn(existing, 'body'));
      if (canonicalJson(snapshotIdentity(stored)) !== canonicalJson(snapshotIdentity(snapshot))) {
        throw new DomainError('immutable_violation', `snapshot ${snapshot.snapshotId} already exists with different content`, {
          snapshotId: snapshot.snapshotId,
        });
      }
      return;
    }
    const head = this.find('SELECT version FROM snapshot_heads WHERE problem_key = ?', [key]);
    if (head !== null) {
      const headVersion = intColumn(head, 'version');
      if (snapshot.version < headVersion) {
        throw new DomainError(
          'invalid_transition',
          `snapshot v${snapshot.version} cannot replace the current head v${headVersion}`,
          { problemKey: key, snapshotId: snapshot.snapshotId, version: snapshot.version, headVersion },
        );
      }
      if (snapshot.version === headVersion) {
        throw new DomainError(
          'duplicate_id',
          `snapshot version v${headVersion} already exists with a different snapshot id`,
          { problemKey: key, snapshotId: snapshot.snapshotId, version: snapshot.version },
        );
      }
    }
    this.write(
      `INSERT INTO snapshots (snapshot_id, problem_key, content_hash, version, schema_version, captured_at, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.snapshotId,
        key,
        snapshot.contentHash,
        snapshot.version,
        snapshot.schemaVersion,
        snapshot.capturedAt,
        bodyOf(snapshot, SNAPSHOT_FIELDS),
      ],
    );
    this.write(
      `INSERT INTO snapshot_heads (problem_key, snapshot_id, content_hash, version, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(problem_key) DO UPDATE SET snapshot_id = excluded.snapshot_id,
         content_hash = excluded.content_hash, version = excluded.version, updated_at = excluded.updated_at`,
      [key, snapshot.snapshotId, snapshot.contentHash, snapshot.version, this.clock()],
    );
  }

  /**
   * Upsert one job row.
   *
   * A job's identity — `problemKey`, `snapshotId`, `createdAt` — is fixed by its first save.
   * Re-saving the same `jobId` under a different identity is rejected instead of silently
   * repointing the job at another problem/snapshot or rewriting the record's creation time
   * (the stored body would otherwise disagree with the identity columns). Counters stay
   * monotonic as before. Status/lease transitions are *not* constrained here: the later
   * pipeline reads the current row and checks the lease and status transactionally.
   */
  private writeJob(state: AnalysisJobState): void {
    requireProblemKey(state.problemKey);
    const existing = this.find(
      'SELECT attempts, analysis_calls, reasoning_calls, retries, problem_key, snapshot_id, created_at FROM jobs WHERE job_id = ?',
      [state.jobId],
    );
    if (existing !== null) {
      const conflicts = (
        [
          ['problemKey', textColumn(existing, 'problem_key'), state.problemKey],
          ['snapshotId', textColumn(existing, 'snapshot_id'), state.snapshotId],
          ['createdAt', textColumn(existing, 'created_at'), state.createdAt],
        ] as const
      )
        .filter(([, stored, incoming]) => stored !== incoming)
        .map(([name]) => name);
      if (conflicts.length > 0) {
        throw new DomainError(
          'immutable_violation',
          `job ${state.jobId} already exists with a different ${conflicts.join(', ')}`,
          {
            jobId: state.jobId,
            conflicts,
            stored: {
              problemKey: textColumn(existing, 'problem_key'),
              snapshotId: textColumn(existing, 'snapshot_id'),
              createdAt: textColumn(existing, 'created_at'),
            },
            incoming: {
              problemKey: state.problemKey,
              snapshotId: state.snapshotId,
              createdAt: state.createdAt,
            },
          },
        );
      }
      const previous = jobCounterRow(existing);
      const next = jobCounters(state);
      const regressions = (['attempts', 'analysisCalls', 'reasoningCalls', 'retries'] as const).filter(
        (name) => next[name] < previous[name],
      );
      if (regressions.length > 0) {
        throw new DomainError(
          'invalid_transition',
          `job ${state.jobId} would decrease ${regressions.join(', ')}`,
          { jobId: state.jobId, regressions, previous, next },
        );
      }
    }
    this.write(
      `INSERT INTO jobs (job_id, problem_key, snapshot_id, status, attempts, analysis_calls, reasoning_calls, retries,
         created_at, updated_at, lease_owner, lease_expires_at, analysis_id, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET problem_key = excluded.problem_key, snapshot_id = excluded.snapshot_id,
         status = excluded.status, attempts = excluded.attempts, analysis_calls = excluded.analysis_calls,
         reasoning_calls = excluded.reasoning_calls, retries = excluded.retries, updated_at = excluded.updated_at,
         lease_owner = excluded.lease_owner, lease_expires_at = excluded.lease_expires_at,
         analysis_id = excluded.analysis_id, body = excluded.body`,
      [
        state.jobId,
        state.problemKey,
        state.snapshotId,
        state.status,
        state.attempts,
        state.counters.analysisCalls,
        state.counters.reasoningCalls,
        state.counters.retries,
        state.createdAt,
        state.updatedAt,
        state.leaseOwner,
        state.leaseExpiresAt,
        state.analysisId,
        bodyOf(state, JOB_FIELDS),
      ],
    );
  }

  private writeManualDecision(decision: ManualTagDecision): void {
    requireProblemKey(decision.problemKey);
    const body = bodyOf(decision, MANUAL_DECISION_FIELDS);
    const existing = this.find('SELECT body FROM manual_decisions WHERE decision_id = ?', [decision.decisionId]);
    if (existing !== null) {
      requireSameBody('manual decision', decision.decisionId, textColumn(existing, 'body'), body);
      return;
    }
    this.write(
      `INSERT INTO manual_decisions (decision_id, problem_key, taxonomy_id, action, decided_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        decision.decisionId,
        decision.problemKey,
        decision.taxonomyId,
        decision.action,
        decision.decidedAt,
        body,
      ],
    );
    // Revision advances in the same transaction as the insert, only for a new decision id.
    this.write(
      `INSERT INTO manual_revisions (problem_key, revision, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(problem_key) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
      [decision.problemKey, decision.decidedAt],
    );
  }

  private writePlan(plan: TrainingPlan): void {
    const existing = this.find('SELECT status, adopted_at FROM plans WHERE plan_id = ?', [plan.planId]);
    if (existing !== null) {
      const previousStatus = textColumn(existing, 'status');
      if (previousStatus === 'adopted' && plan.status !== 'adopted') {
        throw new DomainError('invalid_transition', `plan ${plan.planId} cannot return to ${plan.status} after adoption`, {
          planId: plan.planId,
          previousStatus,
          status: plan.status,
        });
      }
      const previousAdoptedAt = nullableTextColumn(existing, 'adopted_at');
      if (previousAdoptedAt !== null && plan.adoptedAt === null) {
        throw new DomainError('invalid_transition', `plan ${plan.planId} cannot clear its adoption time`, {
          planId: plan.planId,
        });
      }
    }
    this.write(
      `INSERT INTO plans (plan_id, account_id, status, created_at, adopted_at, body)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET account_id = excluded.account_id, status = excluded.status,
         created_at = excluded.created_at, adopted_at = excluded.adopted_at, body = excluded.body`,
      [plan.planId, plan.accountId, plan.status, plan.createdAt, plan.adoptedAt, bodyOf(plan, PLAN_FIELDS)],
    );
  }

  /**
   * Persist a batch under optimistic concurrency control.
   *
   * The stored revision is the authority: `expectedRevision === null` means "this is a
   * create" and a number must equal the stored revision. A mismatch rejects before any write,
   * so a stale caller can never overwrite a newer state (or resurrect a deleted one). The
   * application validators own identity/counter/end-state rules, so they cannot drift from the
   * pure records other callers use.
   */
  private writeBatch(batch: AnalysisBatch, expectedRevision: number | null): number {
    validateAnalysisBatch(batch);
    invariant(
      expectedRevision === null || (Number.isInteger(expectedRevision) && expectedRevision >= 1),
      'invalid_input',
      'expectedRevision must be null (create) or an integer >= 1 (update)',
      { batchId: batch.batchId, expectedRevision },
    );
    const existing = this.find('SELECT revision, body FROM analysis_batches WHERE batch_id = ?', [batch.batchId]);
    if (existing === null) {
      invariant(
        expectedRevision === null,
        'invalid_transition',
        `batch ${batch.batchId} does not exist; a create must pass expectedRevision null`,
        { batchId: batch.batchId, expectedRevision },
      );
      this.upsertBatch(batch, 1);
      return 1;
    }
    const storedRevision = intColumn(existing, 'revision');
    invariant(
      expectedRevision !== null,
      'duplicate_id',
      `batch ${batch.batchId} already exists at revision ${storedRevision}`,
      { batchId: batch.batchId, storedRevision },
    );
    invariant(
      expectedRevision === storedRevision,
      'invalid_transition',
      `batch ${batch.batchId} is at revision ${storedRevision}, not ${expectedRevision}; re-read before saving`,
      { batchId: batch.batchId, expectedRevision, storedRevision, reason: 'stale_revision' },
    );
    const stored = entityFromRow<AnalysisBatch>('analysis_batches.body', existing);
    validateAnalysisBatchTransition(stored, batch);
    const next = storedRevision + 1;
    this.upsertBatch(batch, next);
    return next;
  }

  /**
   * Insert or update one batch row; `revision` is always the store-assigned token.
   *
   * Identity columns (`created_at`, `job_count`) are written once and never updated, so the
   * indexed columns cannot disagree with the immutable body.
   */
  private upsertBatch(batch: AnalysisBatch, revision: number): void {
    this.write(
      `INSERT INTO analysis_batches (batch_id, status, revision, created_at, updated_at, lease_owner,
         lease_expires_at, analysis_calls, reasoning_calls, retries, job_count, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(batch_id) DO UPDATE SET status = excluded.status, revision = excluded.revision,
         updated_at = excluded.updated_at, lease_owner = excluded.lease_owner,
         lease_expires_at = excluded.lease_expires_at, analysis_calls = excluded.analysis_calls,
         reasoning_calls = excluded.reasoning_calls, retries = excluded.retries, body = excluded.body`,
      [
        batch.batchId,
        batch.status,
        revision,
        batch.createdAt,
        batch.updatedAt,
        batch.owner,
        batch.leaseExpiresAt,
        batch.counters.analysisCalls,
        batch.counters.reasoningCalls,
        batch.counters.retries,
        batch.jobs.length,
        bodyOf({ ...batch, revision }, BATCH_FIELDS),
      ],
    );
  }

  /**
   * Insert one reserved attempt, or advance an existing one.
   *
   * A new attempt must be `reserved`: reservation is what makes an in-flight call visible, so
   * a caller cannot record a finished call first. An identical re-save is a no-op (recovery may
   * replay the same record); a different body on a settled row is refused. The caller owns the
   * surrounding transaction, so the insert and the job/batch counter bump roll back together.
   */
  private writeModelCallAttempt(attempt: ModelCallAttempt): void {
    validateModelCallAttempt(attempt);
    const body = bodyOf(attempt, MODEL_CALL_ATTEMPT_FIELDS);
    const existing = this.find('SELECT body FROM model_call_attempts WHERE attempt_id = ?', [attempt.attemptId]);
    if (existing === null) {
      invariant(
        attempt.status === 'reserved',
        'invalid_transition',
        `attempt ${attempt.attemptId} must be inserted as reserved before dispatch`,
        { attemptId: attempt.attemptId, status: attempt.status },
      );
      this.write(
        `INSERT INTO model_call_attempts (attempt_id, batch_id, job_id, snapshot_id, role, status, provider,
           model, prompt_version, requested_at, finished_at, host_session_id, host_call_id, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.attemptId,
          attempt.batchId,
          attempt.jobId,
          attempt.snapshotId,
          attempt.role,
          attempt.status,
          attempt.provider,
          attempt.model,
          attempt.promptVersion,
          attempt.requestedAt,
          attempt.finishedAt,
          attempt.hostSessionId,
          attempt.hostCallId,
          body,
        ],
      );
      return;
    }
    if (textColumn(existing, 'body') === body) {
      return;
    }
    const stored = entityFromRow<ModelCallAttempt>('model_call_attempts.body', existing);
    validateModelCallAttemptTransition(stored, attempt);
    this.write(
      `UPDATE model_call_attempts SET status = ?, finished_at = ?, host_session_id = ?, host_call_id = ?,
         body = ? WHERE attempt_id = ?`,
      [attempt.status, attempt.finishedAt, attempt.hostSessionId, attempt.hostCallId, body, attempt.attemptId],
    );
  }

  /**
   * Create or update the singleton settings row under revision CAS.
   *
   * Validation and canonical encoding happen first, so an invalid value is never written and an
   * undeclared member cannot reach the body. A create stores revision 1; an update requires the
   * stored revision and rejects a stale one before any write. Body and revision move together in
   * one statement, so no reader sees a new body under an old revision.
   */
  private writeWorkbenchSettings(value: WorkbenchSettings, expectedRevision: number | null): number {
    const body = canonicalJson(validateWorkbenchSettings(value));
    invariant(
      expectedRevision === null || (Number.isInteger(expectedRevision) && expectedRevision >= 1),
      'invalid_input',
      'expectedRevision must be null (create) or an integer >= 1 (update)',
      { expectedRevision },
    );
    const existing = this.find('SELECT revision FROM workbench_settings WHERE id = 1');
    if (existing === null) {
      invariant(
        expectedRevision === null,
        'invalid_transition',
        'workbench settings do not exist; a create must pass expectedRevision null',
        { expectedRevision },
      );
      this.write('INSERT INTO workbench_settings (id, revision, body) VALUES (1, 1, ?)', [body]);
      return 1;
    }
    const storedRevision = intColumn(existing, 'revision');
    invariant(
      expectedRevision !== null,
      'duplicate_id',
      `workbench settings already exist at revision ${storedRevision}`,
      { storedRevision },
    );
    invariant(
      expectedRevision === storedRevision,
      'invalid_transition',
      `workbench settings are at revision ${storedRevision}, not ${expectedRevision}; re-read before saving`,
      { expectedRevision, storedRevision, reason: 'stale_revision' },
    );
    const next = storedRevision + 1;
    this.write('UPDATE workbench_settings SET revision = ?, body = ? WHERE id = 1', [next, body]);
    return next;
  }

  /**
   * Insert one reserved coaching attempt, or advance an existing one.
   *
   * A new attempt must be `reserved`: the reservation is what puts the call on the quota books
   * before it is dispatched, so a finished call can never be recorded first (and a duplicate id
   * cannot overwrite a charged attempt). An identical re-save is a no-op so recovery may replay
   * a record. Identity columns are written once; later saves only move `status` and the body,
   * and the application validator refuses a changed `expiresAt`, a rewritten settled row or a
   * cleared/reassigned host correlation.
   */
  private writeCoachingAttempt(value: CoachingAttempt): void {
    const attempt = validateCoachingAttempt(value);
    const body = bodyOf(attempt, COACHING_ATTEMPT_FIELDS);
    const existing = this.find('SELECT body FROM coaching_attempts WHERE id = ?', [attempt.id]);
    if (existing === null) {
      invariant(
        attempt.status === 'reserved',
        'invalid_transition',
        `coaching attempt ${attempt.id} must be inserted as reserved before dispatch`,
        { id: attempt.id, status: attempt.status },
      );
      this.write(
        `INSERT INTO coaching_attempts (id, account_id, problem_key, snapshot_id, requested_at, expires_at, status, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.id,
          attempt.accountId,
          attempt.problemKey,
          attempt.snapshotId,
          attempt.requestedAt,
          attempt.expiresAt,
          attempt.status,
          body,
        ],
      );
      return;
    }
    if (textColumn(existing, 'body') === body) {
      return;
    }
    const stored = this.readCoachingAttempt(existing);
    validateCoachingAttemptTransition(stored, attempt);
    this.write('UPDATE coaching_attempts SET status = ?, body = ? WHERE id = ?', [
      attempt.status,
      body,
      attempt.id,
    ]);
  }

  // -------------------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------------------

  /**
   * Decode one coaching attempt from its stored canonical body.
   *
   * Coaching rows are the only entities re-validated on read: a body that parses as JSON but
   * is not a well-formed attempt (hand-edited, or written by a buggy build) is reported as
   * `corrupt_row` instead of being cast into the domain. Narrow by design — every other entity
   * keeps its existing structural-only row decoding.
   */
  private readCoachingAttempt(row: Row): CoachingAttempt {
    const parsed = parseBody<unknown>('coaching_attempts.body', textColumn(row, 'body'));
    try {
      return validateCoachingAttempt(parsed);
    } catch (error) {
      throw new StorageError('corrupt_row', 'stored coaching attempt is not a valid attempt', {
        cause: String(error),
      });
    }
  }

  private readJob(jobId: string): AnalysisJobState | null {
    const row = this.find('SELECT body FROM jobs WHERE job_id = ?', [jobId]);
    return row === null ? null : entityFromRow<AnalysisJobState>('jobs.body', row);
  }

  private readManualRevision(problemKeyValue: string): number {
    const row = this.find('SELECT revision FROM manual_revisions WHERE problem_key = ?', [problemKeyValue]);
    return row === null ? 0 : intColumn(row, 'revision');
  }

  // -------------------------------------------------------------------------------------
  // Connection plumbing
  // -------------------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', 'store is closed', { path: this.path });
    }
  }

  /**
   * Run `work` with exclusive ownership of the connection.
   *
   * Inside an active transaction of this store the connection is already owned, so `work`
   * runs directly (this is what keeps `transaction()` callbacks from deadlocking). A call
   * that arrives after its owning transaction finished is rejected instead of silently
   * writing outside it.
   *
   * The open/closed check is repeated *inside* the mutex: a call that queued behind another
   * operation can reach the connection only after a `close()` that was queued in between, and
   * it must then report `closed` rather than a raw `node:sqlite` error.
   */
  private runExclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const scope = this.scopes.current();
    if (scope !== undefined && scope.store === this) {
      if (!scope.active) {
        throw new StorageError(
          'transaction_scope_escaped',
          'operation ran after its owning transaction finished',
          { path: this.path },
        );
      }
      return Promise.resolve(work());
    }
    return this.mutex.run(async () => {
      this.assertOpen();
      return work();
    });
  }

  private withRead<T>(work: () => T): Promise<T> {
    return this.runExclusive(work);
  }

  /** A write batch: one atomic transaction unless a transaction already owns the connection. */
  private withWrite<T>(work: () => T): Promise<T> {
    return this.runExclusive(() => {
      if (this.scopes.isActiveOwner(this)) {
        return work();
      }
      return this.atomic(work);
    });
  }

  private atomic<T>(work: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    let value: T;
    try {
      value = work();
    } catch (error) {
      this.rollback(error);
      throw error;
    }
    try {
      this.connection.exec('COMMIT');
    } catch (error) {
      this.rollback(error);
      throw error;
    }
    return value;
  }

  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (prepared === undefined) {
      prepared = this.connection.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  private all(sql: string, params: readonly SqlValue[] = []): Row[] {
    return this.statement(sql).all(...params) as Row[];
  }

  private find(sql: string, params: readonly SqlValue[] = []): Row | null {
    return (this.statement(sql).get(...params) as Row | undefined) ?? null;
  }

  private write(sql: string, params: readonly SqlValue[]): void {
    this.statement(sql).run(...params);
  }

  // -------------------------------------------------------------------------------------
  // Schema & backups
  // -------------------------------------------------------------------------------------

  /**
   * Classify, back up and migrate a database, and only then configure the connection.
   *
   * Ordering is load-bearing:
   *
   * 1. `detectSchemaState` runs first — a database this build must refuse is only read, never
   *    switched into another journal mode or otherwise touched.
   * 2. A supported older database (v0, v1 or v2) is backed up **before** `configureConnection`,
   *    so the backup is the database as it was found and switching the journal mode is not part
   *    of the pre-migration state. The copy is verified before migration starts.
   * 3. Migration adds tables only and runs in one transaction: `initializeSchemaV3` applies
   *    v1+v2+v3 for an empty or metadata-only database, `migrateSchemaV1ToV3` applies v2+v3 to a
   *    real v1 store and `migrateSchemaV2ToV3` adds v3 to a v2 store; every row is kept and
   *    exactly one pre-migration backup is taken.
   * 4. `configureConnection` (busy timeout, WAL, synchronous) runs only after initialization
   *    succeeded, so a failed migration leaves the original file — including its original
   *    journal mode — untouched.
   */
  private openSchema(inMemory: boolean): void {
    const state = detectSchemaState(this.connection);
    if (state === 'legacy_v0' || state === 'v1' || state === 'v2') {
      // Keep a consistent copy of the database as found before any migration writes to it.
      const from =
        state === 'legacy_v0' ? SCHEMA_VERSION_EMPTY : state === 'v1' ? SCHEMA_VERSION_V1 : SCHEMA_VERSION_V2;
      const target = this.uniquePath(backupFileName(this.path, from, this.clock()));
      this.vacuumInto(target);
      this.verifyBackup(target, from, from >= SCHEMA_VERSION_V1);
    }
    if (state !== 'current') {
      try {
        if (state === 'v2') {
          migrateSchemaV2ToV3(this.connection);
        } else if (state === 'v1') {
          migrateSchemaV1ToV3(this.connection);
        } else {
          initializeSchemaV3(this.connection);
        }
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        throw new StorageError(
          'migration_failed',
          `database could not be initialized to schema v${STORE_SCHEMA_VERSION}`,
          { path: this.path, cause: String(error) },
        );
      }
      if (detectSchemaState(this.connection) !== 'current') {
        throw new StorageError('migration_failed', `database did not reach schema v${STORE_SCHEMA_VERSION}`, {
          path: this.path,
        });
      }
    }
    configureConnection(this.connection, inMemory);
  }

  private uniquePath(candidate: string): string {
    if (!existsSync(candidate)) {
      return candidate;
    }
    for (let index = 1; index <= 100; index += 1) {
      const next = candidate.replace(/\.sqlite$/u, `-${index}.sqlite`);
      if (!existsSync(next)) {
        return next;
      }
    }
    throw new StorageError('backup_exists', `no free backup name next to ${candidate}`, { candidate });
  }

  private vacuumInto(target: string): void {
    try {
      this.connection.prepare('VACUUM INTO ?').run(target);
    } catch (error) {
      throw new StorageError('backup_failed', `consistent backup could not be written: ${target}`, {
        path: target,
        cause: String(error),
      });
    }
  }

  private verifyBackup(path: string, expectedVersion: number, requireMarker: boolean): void {
    let backup: DatabaseSync;
    try {
      backup = new DatabaseSync(path);
    } catch (error) {
      throw new StorageError('backup_failed', `backup could not be opened: ${path}`, {
        path,
        cause: String(error),
      });
    }
    let integrity: unknown = null;
    let version = -1;
    let marker: string | null = null;
    try {
      const row = backup.prepare('PRAGMA integrity_check').get() as Row | undefined;
      integrity = row?.['integrity_check'] ?? null;
      version = readUserVersion(backup);
      marker = requireMarker ? readMarker(backup) : null;
    } finally {
      backup.close();
    }
    if (integrity !== 'ok') {
      throw new StorageError('backup_failed', `backup failed its integrity check: ${path}`, { path, integrity });
    }
    if (version !== expectedVersion) {
      throw new StorageError('backup_failed', `backup has schema v${version}, expected v${expectedVersion}`, {
        path,
        version,
        expectedVersion,
      });
    }
    if (requireMarker && marker !== STORE_MARKER) {
      throw new StorageError('backup_failed', `backup does not carry the store marker: ${path}`, { path, marker });
    }
  }

  /** Delete an untrusted partial backup and rethrow the verification failure. */
  private removeUnverifiedBackup(path: string, original: unknown): never {
    try {
      unlinkSync(path);
    } catch (cleanupError) {
      throw new StorageError('backup_failed', `unverified backup could not be removed: ${path}`, {
        path,
        cause: String(cleanupError),
        original: String(original),
      });
    }
    throw original;
  }
}

/** Maximum accepted whole-bank search term; longer input is rejected, never truncated. */
const MAX_PROBLEM_SEARCH_CHARS = 200;

/**
 * Review-queue predicate: this problem still holds at least one unresolved item at its head.
 *
 * (a) an AI `needs_review` decision that is still the current decision of its (problem, tag) and has
 *     no manual accept/reject, targeting exactly the stored head id and version. A decision only
 *     supersedes it when it is a manual/rule decision (always in scope) or an AI decision targeting
 *     the SAME current head, mirroring the effective view: a later-dated AI decision written for
 *     another snapshot must not silently resolve a current item. Ties are broken by `decision_id`,
 *     the same `decided_at ASC, decision_id ASC` order the store returns decisions in; or
 * (b) a taxonomy id of a reasoning draft inside an analysis that targets the stored head and has no
 *     manual decision (reasoning drafts never become automatic decisions).
 *
 * Only indexed columns and the canonical JSON bodies are read (`json_extract`/`json_each` with
 * `json_valid` guards), the filter runs before `LIMIT`, and no caller input is interpolated.
 */
const PENDING_REVIEW_PREDICATE = `(
  EXISTS (
    SELECT 1
      FROM tag_decisions d
      JOIN snapshot_heads h
        ON h.problem_key = d.problem_key
       AND h.snapshot_id = json_extract(d.body, '$.snapshotId')
       AND h.version = json_extract(d.body, '$.snapshotVersion')
     WHERE d.problem_key = problems.key
       AND d.status = 'needs_review'
       AND d.origin = 'ai'
       AND json_valid(d.body)
       AND NOT EXISTS (
         SELECT 1 FROM manual_decisions m
          WHERE m.problem_key = d.problem_key AND m.taxonomy_id = d.taxonomy_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM tag_decisions newer
          WHERE newer.problem_key = d.problem_key
            AND newer.taxonomy_id = d.taxonomy_id
            AND (newer.decided_at > d.decided_at
                 OR (newer.decided_at = d.decided_at AND newer.decision_id > d.decision_id))
            AND (
              newer.origin IN ('manual', 'rule')
              OR (
                newer.origin = 'ai'
                AND json_valid(newer.body)
                AND json_extract(newer.body, '$.snapshotId') = h.snapshot_id
                AND json_extract(newer.body, '$.snapshotVersion') = h.version
              )
            )
       )
  )
  OR EXISTS (
    SELECT 1
      FROM analyses a
      JOIN snapshot_heads h2
        ON h2.problem_key = a.problem_key
       AND h2.snapshot_id = a.snapshot_id
       AND h2.version = a.snapshot_version
      JOIN json_each(a.body, '$.reasoningDrafts') AS draft
      JOIN json_each(draft.value, '$.taxonomyIds') AS tag
     WHERE a.problem_key = problems.key
       AND json_valid(a.body)
       AND NOT EXISTS (
         SELECT 1 FROM manual_decisions m2
          WHERE m2.problem_key = a.problem_key
            AND m2.taxonomy_id = CAST(tag.value AS TEXT)
       )
  )
)`;

/**
 * Indexed `EXISTS` proving the requested account solved the row's problem.
 *
 * Scoped to the full problem identity — canonical key plus the stored source instance, domain and
 * external key — to the account, and to the account's own stored source instance: the submission's
 * `accounts` row must itself belong to the problem's source instance, so an incoherent stored row
 * that borrows this account id for a problem of another instance (a legacy database may contain one)
 * can never confer a solve. The `accounts` lookup is its primary key and `submissions_by_problem`
 * serves the rest, so nothing walks submission history. It binds exactly one parameter (the account
 * id) and is used both as a `solved`/`unconfirmed` filter and as the projected `solved` column.
 */
const ACCEPTED_SUBMISSION_EXISTS = `EXISTS (
  SELECT 1 FROM submissions s
    JOIN accounts a ON a.id = s.account_id
   WHERE s.problem_key = problems.key
     AND s.account_id = ?
     AND s.source_instance_id = problems.source_instance_id
     AND s.external_key = problems.external_key
     AND s.domain IS problems.domain
     AND a.source_instance_id = problems.source_instance_id
     AND s.verdict = 'accepted'
)`;

/** Indexed `EXISTS` proving the account attempted the row's problem, with the same identity scope. */
const ATTEMPTED_SUBMISSION_EXISTS = `EXISTS (
  SELECT 1 FROM submissions s
    JOIN accounts a ON a.id = s.account_id
   WHERE s.problem_key = problems.key
     AND s.account_id = ?
     AND s.source_instance_id = problems.source_instance_id
     AND s.external_key = problems.external_key
     AND s.domain IS problems.domain
     AND a.source_instance_id = problems.source_instance_id
)`;

/** Validate the optional literal search term of {@link ProblemQuery.query}. */
function problemSearchTerm(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string', 'invalid_input', 'problem query must be a string', { value });
  const trimmed = value.trim();
  invariant(
    trimmed.length > 0 && trimmed.length <= MAX_PROBLEM_SEARCH_CHARS,
    'invalid_input',
    `problem query must be 1..${MAX_PROBLEM_SEARCH_CHARS} characters`,
    { length: trimmed.length },
  );
  return trimmed;
}

/** Validate the optional review-queue flag of {@link ProblemQuery.needsReviewOnly}. */
function reviewOnlyFlag(value: boolean | null | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  invariant(typeof value === 'boolean', 'invalid_input', 'needsReviewOnly must be a boolean when present', { value });
  return value;
}

function pageLimit(limit: number): number {
  invariant(
    Number.isInteger(limit) && limit >= STORAGE_PAGE_LIMITS.minPageSize && limit <= STORAGE_PAGE_LIMITS.maxPageSize,
    'invalid_input',
    `page limit must be an integer within ${STORAGE_PAGE_LIMITS.minPageSize}..${STORAGE_PAGE_LIMITS.maxPageSize}`,
    { limit },
  );
  return limit;
}

/** Validate the page size of one numbered bank page; the port's own `1..100` bound. */
function browsePageLimit(limit: number): number {
  invariant(
    Number.isInteger(limit) && limit >= BROWSE_PAGE_LIMITS.minPageSize && limit <= BROWSE_PAGE_LIMITS.maxPageSize,
    'invalid_input',
    `page limit must be an integer within ${BROWSE_PAGE_LIMITS.minPageSize}..${BROWSE_PAGE_LIMITS.maxPageSize}`,
    { limit },
  );
  return limit;
}

/** Validate the 1-based page number of one numbered bank page (no upper bound: it clamps). */
function browsePageNumber(page: number): number {
  invariant(Number.isInteger(page) && page >= 1, 'invalid_input', 'page must be an integer >= 1', { page });
  return page;
}

/** The solved/attempted scope of one numbered page; omitted/`null` means "no account context". */
function browseAccountId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireId('account id', value);
}

/** Validate the optional solved-state filter of {@link ProblemBrowseQuery.status}. */
function browseStatus(value: ProblemSolvedFilter | null | undefined): ProblemSolvedFilter {
  if (value === undefined || value === null) {
    return 'all';
  }
  invariant(
    PROBLEM_SOLVED_FILTERS.includes(value),
    'invalid_input',
    `unknown solved-state filter ${String(value)}`,
    { status: value },
  );
  return value;
}

/** Validate the optional attempt filter of {@link ProblemBrowseQuery.onlyAttempted}. */
function browseAttemptedFlag(value: boolean | null | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  invariant(typeof value === 'boolean', 'invalid_input', 'onlyAttempted must be a boolean when present', { value });
  return value;
}

/**
 * Static `ORDER BY` fragments of one bank page, keyed by the accepted sort names.
 *
 * Two properties matter here:
 *
 * - **Allowlisted, never interpolated.** A request only selects a key of this table; the fragment
 *   itself is a literal, so no caller input ever reaches the SQL text. The one variable value — the
 *   rating dimension — is a bound parameter, so even a hostile dimension (quotes, `--`, `;`) is
 *   matched as literal data by `json_extract` and can neither change the statement nor inject one.
 * - **Total and deterministic.** Every fragment ends in `problems.key ASC`, the canonical key, so
 *   rows that compare equal under the requested order (the same title, the same difficulty, keys
 *   that differ only in leading zeros) still have exactly one order and a `LIMIT/OFFSET` page can
 *   neither omit nor repeat a row.
 *
 * Natural problem order compares the encoded natural key (digit runs as integers, other characters
 * by code point). Title order uses SQLite's `NOCASE` collation: it is **ASCII** case-insensitive
 * only, so `Zebra` and `apple` order as `apple` then `Zebra`, while a title that differs only in
 * ASCII case compares equal and falls through to the canonical key; non-ASCII text keeps code point
 * order (SQLite folds no non-ASCII case). Difficulty order reads the raw dimension from the stored
 * body with {@link RATING_VALUE_FUNCTION}; `IS NULL ASC` puts a missing, blank or non-numeric value
 * before the value comparison in BOTH directions, i.e. always last, because a problem without a
 * comparable rating is not "the easiest" one.
 */
const BROWSE_ORDERINGS: Readonly<Record<ProblemSort, string>> = {
  default: 'problems.key ASC',
  problem_asc: `${NATURAL_KEY_FUNCTION}(problems.external_key) ASC, problems.key ASC`,
  problem_desc: `${NATURAL_KEY_FUNCTION}(problems.external_key) DESC, problems.key ASC`,
  title_asc: 'problems.title COLLATE NOCASE ASC, problems.key ASC',
  title_desc: 'problems.title COLLATE NOCASE DESC, problems.key ASC',
  difficulty_asc: `${RATING_VALUE_FUNCTION}(problems.body, ?) IS NULL ASC, ${RATING_VALUE_FUNCTION}(problems.body, ?) ASC, problems.key ASC`,
  difficulty_desc: `${RATING_VALUE_FUNCTION}(problems.body, ?) IS NULL ASC, ${RATING_VALUE_FUNCTION}(problems.body, ?) DESC, problems.key ASC`,
};

/**
 * Resolve one requested sort into a static SQL fragment plus its bound parameters.
 *
 * The sort name is validated against the allowlist, the optional dimension against its own type and
 * bound, and a difficulty sort demands an explicit source instance and a non-empty dimension: a
 * difficulty compared across two source instances, or across two platforms' dimensions, would be
 * this adapter inventing a scale the platforms never agreed on. The adapter repeats checks the
 * service already makes, so a direct caller of the port cannot bypass them.
 */
function browseOrdering(
  sort: ProblemSort | null | undefined,
  ratingDimension: string | null | undefined,
  sourceInstanceId: string | null | undefined,
): { readonly clause: string; readonly params: readonly SqlValue[] } {
  const resolved = sort === undefined || sort === null ? 'default' : sort;
  invariant(
    typeof resolved === 'string' && PROBLEM_SORTS.includes(resolved),
    'invalid_input',
    `unknown bank sort ${String(resolved)}`,
    { sort: resolved },
  );
  const dimension = optionalRatingDimension(ratingDimension);
  if (!RATING_SORTS.includes(resolved)) {
    // The clause is a literal allowlisted fragment, so no caller input reaches the SQL text.
    return { clause: BROWSE_ORDERINGS[resolved], params: [] };
  }
  invariant(
    dimension !== null,
    'invalid_input',
    `a difficulty sort needs a rating dimension of 1..${MAX_RATING_DIMENSION_CHARS} characters`,
    { sort: resolved, reason: 'rating_dimension_required' },
  );
  invariant(
    typeof sourceInstanceId === 'string' && sourceInstanceId.length > 0,
    'invalid_input',
    'a difficulty sort needs an explicit source instance id; a rating is only comparable inside one',
    { sort: resolved, reason: 'rating_source_required' },
  );
  // The fragment uses the dimension twice (null test and value), so it is bound twice.
  return { clause: BROWSE_ORDERINGS[resolved], params: [dimension, dimension] };
}

/** Bound the optional rating dimension: absent means `null`, present means a non-blank bounded label. */
function optionalRatingDimension(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string', 'invalid_input', 'ratingDimension must be a string when present', {
    reason: 'invalid_rating_dimension',
    value,
  });
  const trimmed = value.trim();
  invariant(
    trimmed.length > 0 && trimmed.length <= MAX_RATING_DIMENSION_CHARS,
    'invalid_input',
    `ratingDimension must be 1..${MAX_RATING_DIMENSION_CHARS} characters`,
    { reason: 'invalid_rating_dimension' },
  );
  return trimmed;
}

function requireSyncResource(resource: SyncResource): SyncResource {
  invariant(
    SYNC_RESOURCE_VALUES.includes(resource),
    'invalid_input',
    `unknown sync resource ${String(resource)}`,
    { resource },
  );
  return resource;
}

// ---------------------------------------------------------------------------------------
// Coaching query helpers
// ---------------------------------------------------------------------------------------

/**
 * Normalized coaching filter set.
 *
 * `accountId` stays three-valued on purpose: `undefined` = every account, `null` = anonymous
 * attempts only, a string = that account. The other members use `null` as "no restriction".
 */
interface CoachingFilters {
  readonly accountId: string | null | undefined;
  readonly problemKey: string | null;
  readonly since: string | null;
  readonly status: CoachingStatus | null;
}

function coachingFilters(query: CoachingAttemptQuery): CoachingFilters {
  return {
    accountId: coachingAccountScope(query.accountId),
    problemKey:
      query.problemKey === undefined || query.problemKey === null ? null : requireProblemKey(query.problemKey),
    since: query.since === undefined || query.since === null ? null : assertIsoTimestamp('coaching since', query.since),
    status: query.status === undefined || query.status === null ? null : requireCoachingStatus(query.status),
  };
}

/**
 * Normalize the account scope without collapsing its three cases: an omitted member means
 * "every account" and an explicit `null` means "anonymous only", while a string must be a
 * non-empty account id. Collapsing the first two is exactly what would mix anonymous history
 * into an account history.
 */
function coachingAccountScope(value: string | null | undefined): string | null | undefined {
  return value === undefined || value === null ? value : requireId('account id', value);
}

function requireCoachingStatus(status: CoachingStatus): CoachingStatus {
  invariant(
    COACHING_STATUSES.includes(status),
    'invalid_input',
    `unknown coaching status ${String(status)}`,
    { status },
  );
  return status;
}

/**
 * Fingerprint binding a cursor to the filter set that produced it.
 *
 * The account scope is encoded as an explicit object so "every account" and "anonymous only"
 * cannot hash alike (`undefined` members are simply dropped from canonical JSON).
 */
function coachingFingerprint(filters: CoachingFilters): string {
  const accountId =
    filters.accountId === undefined
      ? { scope: 'all' }
      : filters.accountId === null
        ? { scope: 'anonymous' }
        : { scope: 'account', id: filters.accountId };
  return contentHashOf({
    accountId,
    problemKey: filters.problemKey,
    since: filters.since,
    status: filters.status,
  }).slice(0, 32);
}

const COACHING_CURSOR_KEYS: readonly string[] = ['f', 't', 'i'];

/**
 * Decode a coaching cursor and refuse one produced under different filters.
 *
 * The payload is the filter fingerprint plus the last returned `(requestedAt, id)`. Both are
 * checked before the keyset condition runs, so a tampered or re-used cursor cannot skip,
 * duplicate or reorder rows.
 */
function decodeCoachingCursor(cursor: string, fingerprint: string): { requestedAt: string; id: string } {
  const payload = decodeCursor('coaching', cursor);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new DomainError('invalid_input', 'coaching cursor payload is not valid JSON', {
      cursor,
      cause: String(cause),
    });
  }
  invariant(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'invalid_input',
    'coaching cursor payload must be an object',
    { cursor },
  );
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  invariant(
    keys.length === COACHING_CURSOR_KEYS.length && keys.every((key) => COACHING_CURSOR_KEYS.includes(key)),
    'invalid_input',
    'coaching cursor payload has an unexpected shape',
    { cursor, keys },
  );
  const filterKey = record['f'];
  const requestedAt = record['t'];
  const id = record['i'];
  invariant(
    typeof filterKey === 'string' && typeof requestedAt === 'string' && typeof id === 'string' && id.length > 0,
    'invalid_input',
    'coaching cursor payload fields must be strings',
    { cursor },
  );
  invariant(
    filterKey === fingerprint,
    'invalid_input',
    'coaching cursor belongs to a different filter set; re-read the first page',
    { cursor, reason: 'cursor_filter_mismatch' },
  );
  const instant = Date.parse(requestedAt);
  invariant(Number.isFinite(instant), 'invalid_input', 'coaching cursor timestamp is not parseable', {
    cursor,
    reason: 'cursor_time',
  });
  return { requestedAt: new Date(instant).toISOString(), id };
}
