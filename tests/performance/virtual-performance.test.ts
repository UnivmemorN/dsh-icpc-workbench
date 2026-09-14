/**
 * Sprint 18c: the virtual-contest performance ledger at the backend boundary.
 *
 * Every case drives real code — the domain validator, the real `VirtualPerformanceService`, the real
 * SQLite adapter (including the real v7 -> v8 migration) and, where the transport contract matters,
 * the real `registerPerformanceApi` boundary. Nothing here reaches a platform, a model or the
 * network. The cases assert externally meaningful behaviour:
 *
 * - full CRUD with CAS, dedup by contest and monotonic revisions (including a delete that empties
 *   the ledger, which is what prevents ABA);
 * - account isolation and a hard refusal of foreign platforms, missing accounts, malformed values,
 *   future dates and credentialed/non-http URLs;
 * - the real v7 database is backed up, migrated to v8 and keeps every existing row, while the
 *   reserved `ability_evaluation_attempts` table stays empty and unimplemented;
 * - an official rating snapshot is byte-identical after ledger CRUD;
 * - the planning summary is identifier-free, keeps assisted/prior-exposed evidence in its own
 *   groups, and its ledger hash changes on any mutation or deletion while staying clock-free;
 * - a prepared AI plan goes stale exactly when virtual evidence changes, and a legacy preparation
 *   without the capture stays valid with its original evidence hash.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection';
import {
  SqliteTrainingStore,
  STORE_MARKER,
  STORE_SCHEMA_VERSION,
} from '../../src/adapters/sqlite/index.js';
import { migrateToSchemaV7, readUserVersion, tableNames } from '../../src/adapters/sqlite/schema.js';
import type { PlanGenerationRequest } from '../../src/application/planning-generation.js';
import {
  planPreparationEvidenceHash,
  validatePlanAttempt,
  type PlanAttemptPreparation,
} from '../../src/application/planning-types.js';
import { PlanningService } from '../../src/application/planning-service.js';
import { VirtualPerformanceService } from '../../src/application/virtual-performance-service.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import { PERFORMANCE_API_OPERATIONS } from '../../src/application/workbench-api.js';
import {
  CURRENT_TAXONOMY,
  canonicalJson,
  createCancellationSource,
  createModelUsage,
  createTaxonomyIndex,
  validateVirtualPerformanceEvidence,
  validateVirtualPerformanceLedger,
  validateVirtualPerformancePlanningSummary,
  virtualPerformanceLedgerHash,
  virtualPerformancePlanningSummary,
  type CancellationToken,
} from '../../src/domain/index.js';
import { API_PREFIX } from '../../src/plugin/api-transport.js';
import { registerPerformanceApi } from '../../src/plugin/performance-api.js';
import { officialFixture } from '../official-rating-fixtures.js';
import * as fx from '../storage/fixtures.js';

const AT = fx.AT;
const LATER = fx.LATER;
/** A clearly past contest instant relative to `AT`. */
const PAST = '2026-08-01T12:00:00.000Z';
const TOKEN: CancellationToken = createCancellationSource().token;

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly scope: fx.Scope;
  readonly service: VirtualPerformanceService;
}

/** One real store, one real service, one Codeforces account; nothing reaches the network. */
async function withBench(run: (bench: Bench) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  let minted = 0;
  const service = new VirtualPerformanceService({
    store,
    now: () => AT,
    // A prefix deliberately unlike the summary's synthetic `vp-N` references, so the privacy case
    // can prove that a stored evidence id never leaks into the model-facing summary.
    uniqueId: () => `evidence-${(minted += 1)}`,
  });
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  try {
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await run({ store, scope, service });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

/** One structurally complete save request; `accountId`/`expectedRevision` are filled by the caller. */
function saveRequest(
  accountId: string,
  expectedRevision: number,
  overrides: Record<string, unknown> = {},
): Parameters<VirtualPerformanceService['save']>[0] {
  return {
    accountId,
    expectedRevision,
    contestId: 1000,
    participatedAt: PAST,
    performance: 1720,
    calculationMethod: 'carrot',
    sourceUrl: 'https://codeforces.com/contest/1000',
    independence: 'independent',
    priorExposure: false,
    ...overrides,
  } as Parameters<VirtualPerformanceService['save']>[0];
}

/** One fully valid domain row, used for the direct validator cases. */
function domainRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidenceId: 'e1',
    contestId: 1000,
    participatedAt: PAST,
    performance: 1500,
    calculationMethod: 'carrot',
    sourceUrl: 'https://codeforces.com/contest/1000',
    independence: 'independent',
    priorExposure: false,
    rank: null,
    note: null,
    ...overrides,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => (error as { code?: unknown }).code === code;
}

function hasReason(code: string, reason: string): (error: unknown) => boolean {
  return (error) =>
    (error as { code?: unknown }).code === code &&
    (error as { details?: { reason?: unknown } }).details?.reason === reason;
}

void test('one row is stored, replaced and read back under CAS with a monotonic revision', async () => {
  await withBench(async ({ store, scope, service }) => {
    const empty = await service.list({ accountId: scope.account.id }, TOKEN);
    assert.deepEqual(empty.entries, [], 'an untouched account reads an explicit empty ledger');
    assert.equal(empty.revision, 0);
    assert.equal(empty.official, false, 'user-entered evidence never claims to be official');
    assert.equal(empty.counts.total, 0, 'no rows is a count of zero, not a zero score');
    assert.equal(await store.getVirtualPerformanceLedger(scope.account.id), null);

    const created = await service.save(saveRequest(scope.account.id, 0), TOKEN);
    assert.equal(created.revision, 1);
    assert.equal(created.entries.length, 1);
    assert.equal(created.counts.eligibleIndependent, 1);
    const first = created.entries[0];
    assert.ok(first !== undefined);
    assert.equal(first.contestId, 1000);
    assert.equal(first.performance, 1720);
    assert.equal(first.calculationMethod, 'carrot');
    assert.equal(first.participatedAt, PAST, 'the entered instant is stored normalized and unchanged');
    assert.equal(first.note, null);
    assert.equal(first.rank, null);

    // The same contest cannot be added twice; the caller must name the row it replaces.
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 1, { performance: 1600 }), TOKEN),
      hasReason('duplicate_id', 'duplicate_contest'),
    );
    // A stale revision is refused before any write.
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 0, { evidenceId: first.evidenceId, performance: 1800 }), TOKEN),
      hasReason('invalid_transition', 'stale_revision'),
    );
    // An explicit update replaces the row and advances the revision.
    const updated = await service.save(
      saveRequest(scope.account.id, 1, { evidenceId: first.evidenceId, performance: 1800, note: 'local note' }),
      TOKEN,
    );
    assert.equal(updated.revision, 2);
    assert.equal(updated.entries.length, 1, 'replacing a row never duplicates it');
    assert.equal(updated.entries[0]?.performance, 1800);
    assert.equal(updated.entries[0]?.note, 'local note');
    assert.equal(updated.entries[0]?.evidenceId, first.evidenceId, 'the row keeps its stable identity');

    const stored = await store.getVirtualPerformanceLedger(scope.account.id);
    assert.equal(stored?.revision, 2);
    assert.deepEqual(stored?.entries, updated.entries);
  });
});

void test('account ledgers are isolated and a repeated contest is always an explicit update', async () => {
  await withBench(async ({ store, scope, service }) => {
    const bob = fx.makeAccount(scope.instance, 'bob');
    await store.upsertAccounts([bob]);

    await service.save(saveRequest(scope.account.id, 0), TOKEN);
    await service.save(saveRequest(scope.account.id, 1, { contestId: 1001, participatedAt: '2026-07-01T12:00:00.000Z' }), TOKEN);
    assert.equal((await service.list({ accountId: scope.account.id }, TOKEN)).entries.length, 2);

    const bobView = await service.list({ accountId: bob.id }, TOKEN);
    assert.equal(bobView.revision, 0, 'another account has its own revision');
    assert.deepEqual(bobView.entries, [], 'another account never sees a foreign row');
    await service.save(saveRequest(bob.id, 0), TOKEN);
    assert.equal((await store.getVirtualPerformanceLedger(bob.id))?.entries.length, 1);
    assert.equal((await store.getVirtualPerformanceLedger(scope.account.id))?.entries.length, 2, 'alice keeps her rows');

    // Two contests may share a performance value but never a contest identity.
    const before = await service.list({ accountId: scope.account.id }, TOKEN);
    const second = before.entries.find((row) => row.contestId === 1001);
    assert.ok(second !== undefined);
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 2, { contestId: 1001 }), TOKEN),
      hasReason('duplicate_id', 'duplicate_contest'),
    );
    const replaced = await service.save(
      saveRequest(scope.account.id, 2, { evidenceId: second.evidenceId, contestId: 1001, performance: 1900 }),
      TOKEN,
    );
    assert.equal(replaced.revision, 3);
    const listed = await service.list({ accountId: scope.account.id }, TOKEN);
    assert.equal(listed.entries.length, 2, 'the explicit update kept one row per contest');
    assert.equal(listed.entries.find((row) => row.contestId === 1001)?.performance, 1900);
  });
});

void test('deleting the only row still advances the revision, so a stale writer cannot resurrect it', async () => {
  await withBench(async ({ store, scope, service }) => {
    const created = await service.save(saveRequest(scope.account.id, 0), TOKEN);
    const evidenceId = created.entries[0]?.evidenceId ?? '';
    assert.notEqual(evidenceId, '');

    const deleted = await service.delete({ accountId: scope.account.id, expectedRevision: 1, evidenceId }, TOKEN);
    assert.equal(deleted.revision, 2, 'a delete advances the revision even when it empties the ledger');
    assert.deepEqual(deleted.entries, []);

    const stored = await store.getVirtualPerformanceLedger(scope.account.id);
    assert.equal(stored?.revision, 2, 'the emptied ledger keeps its row and revision');
    assert.deepEqual(stored?.entries, []);

    // ABA: a writer that read revision 1 can neither re-add nor delete against it.
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 1, { contestId: 2000 }), TOKEN),
      hasReason('invalid_transition', 'stale_revision'),
    );
    await assert.rejects(
      service.delete({ accountId: scope.account.id, expectedRevision: 1, evidenceId }, TOKEN),
      hasReason('invalid_transition', 'stale_revision'),
    );
    // The store enforces the same CAS directly, not only through the service: the record itself is
    // well formed, but its `expectedRevision` no longer matches the stored ledger.
    await assert.rejects(
      store.saveVirtualPerformanceLedger({ ...stored!, revision: stored!.revision }, 1),
      hasCode('invalid_transition'),
    );
    // An unknown row is a typed reference failure, not a silent no-op.
    await assert.rejects(
      service.delete({ accountId: scope.account.id, expectedRevision: 2, evidenceId: 'absent' }, TOKEN),
      hasReason('missing_reference', 'unknown_evidence'),
    );
    // Re-adding the contest at the stored revision is a new, monotonic revision.
    const readded = await service.save(saveRequest(scope.account.id, 2, { contestId: 1000 }), TOKEN);
    assert.equal(readded.revision, 3);
    assert.equal(readded.entries.length, 1);
  });
});

void test('invalid values, dates and URLs are refused before anything is written', async () => {
  await withBench(async ({ store, scope, service }) => {
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 0, { participatedAt: '2027-01-01T00:00:00.000Z' }), TOKEN),
      hasReason('invalid_input', 'future_participation'),
    );
    for (const performance of [5001, -1001, 1.5, Number.NaN]) {
      await assert.rejects(
        service.save(saveRequest(scope.account.id, 0, { performance }), TOKEN),
        hasCode('invalid_input'),
      );
    }
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 0, { calculationMethod: '   ' }), TOKEN),
      hasCode('invalid_input'),
    );
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 0, { calculationMethod: 'm'.repeat(201) }), TOKEN),
      hasCode('invalid_input'),
    );
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 0, { note: 'n'.repeat(1001) }), TOKEN),
      hasCode('invalid_input'),
    );
    await assert.rejects(service.save(saveRequest(scope.account.id, 0, { rank: 0 }), TOKEN), hasCode('invalid_input'));
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 0, { sourceUrl: 'ftp://codeforces.com/x' }), TOKEN),
      hasCode('invalid_url'),
    );
    assert.equal(await store.getVirtualPerformanceLedger(scope.account.id), null, 'every refusal wrote nothing');

    // The domain validator owns the URL rules; the service reaches it through the same path.
    for (const sourceUrl of ['javascript:alert(1)', 'https://user:secret@codeforces.com/contest/1', 'not a url']) {
      assert.throws(() => validateVirtualPerformanceEvidence(domainRow({ sourceUrl })), hasCode('invalid_url'));
    }
    assert.throws(
      () => validateVirtualPerformanceEvidence(domainRow({ sourceUrl: `https://example.com/${'x'.repeat(2000)}` })),
      hasCode('invalid_input'),
    );
    assert.throws(
      () => validateVirtualPerformanceEvidence(domainRow({ participatedAt: 'yesterday' })),
      hasCode('invalid_timestamp'),
    );
    // A credentialed URL never becomes a stored row even when it is otherwise well formed.
    await assert.rejects(
      service.save(saveRequest(scope.account.id, 0, { sourceUrl: 'https://u:p@codeforces.com/contest/1000' }), TOKEN),
      hasCode('invalid_url'),
    );
  });
});

void test('a ledger is bounded to 200 unique contests and refuses a foreign or missing account', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => domainRow({ evidenceId: `e${index}`, contestId: 1000 + index }));
  assert.throws(
    () => validateVirtualPerformanceLedger({ accountId: 'a', revision: 1, updatedAt: PAST, source: 'user_import', entries: rows }),
    hasCode('invalid_input'),
  );
  assert.throws(
    () =>
      validateVirtualPerformanceLedger({
        accountId: 'a',
        revision: 1,
        updatedAt: PAST,
        source: 'user_import',
        entries: [domainRow(), domainRow({ evidenceId: 'e2' })],
      }),
    hasReason('duplicate_id', 'duplicate_contest'),
  );
  assert.throws(
    () =>
      validateVirtualPerformanceLedger({
        accountId: 'a',
        revision: 1,
        updatedAt: PAST,
        source: 'official_api',
        entries: [],
      }),
    hasCode('invalid_input'),
  );

  await withBench(async ({ store, scope, service }) => {
    await assert.rejects(service.list({ accountId: 'missing' }, TOKEN), hasCode('missing_reference'));
    await assert.rejects(service.save(saveRequest('missing', 0), TOKEN), hasCode('missing_reference'));

    const luogu = fx.makeScope('luogu', 'www.luogu.com.cn', '100200', 'P1001');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertAccounts([luogu.account]);
    await assert.rejects(
      service.save(saveRequest(luogu.account.id, 0), TOKEN),
      hasReason('invalid_input', 'not_codeforces'),
    );
    await assert.rejects(service.list({ accountId: luogu.account.id }, TOKEN), hasReason('invalid_input', 'not_codeforces'));
    assert.equal(await store.getVirtualPerformanceLedger(luogu.account.id), null);
    assert.equal(await store.getVirtualPerformanceLedger(scope.account.id), null);
  });
});

void test('a v7 database is backed up, migrated to v8 and keeps every existing row', async () => {
  const paths = fx.tempDatabase();
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const rating = officialFixture(scope.account.id, fx.AT);
  const fixture = new DatabaseSync(paths.path);
  try {
    migrateToSchemaV7(fixture, 0);
    fixture
      .prepare(
        `INSERT INTO source_instances (id, platform, base_url, domain, display_name, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.instance.id,
        scope.instance.platform,
        scope.instance.baseUrl,
        scope.instance.domain,
        scope.instance.displayName,
        canonicalJson(scope.instance),
      );
    fixture
      .prepare(
        `INSERT INTO accounts (id, source_instance_id, handle, display_name, profile_url, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.account.id,
        scope.account.sourceInstanceId,
        scope.account.handle,
        scope.account.displayName,
        scope.account.profileUrl,
        canonicalJson(scope.account),
      );
    fixture
      .prepare(
        `INSERT INTO problems (key, source_instance_id, domain, external_key, title, fetched_at, body)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.problem.key,
        scope.problem.ref.sourceInstanceId,
        scope.problem.ref.domain,
        scope.problem.ref.externalKey,
        scope.problem.title,
        scope.problem.fetchedAt,
        canonicalJson(scope.problem),
      );
    fixture
      .prepare('INSERT INTO official_rating_snapshots (account_id, revision, body) VALUES (?, ?, ?)')
      .run(scope.account.id, rating.revision, canonicalJson(rating));
  } finally {
    fixture.close();
  }
  const v7 = new DatabaseSync(paths.path, { readOnly: true });
  try {
    assert.equal(readUserVersion(v7), 7, 'the fixture is a genuine v7 database');
  } finally {
    v7.close();
  }

  let store = new SqliteTrainingStore({ path: paths.path, now: () => LATER });
  try {
    assert.equal(store.capabilities().schemaVersion, STORE_SCHEMA_VERSION);
    assert.deepEqual(await store.getProblem(scope.problem.key), scope.problem, 'the v7 problem body survived');
    assert.deepEqual(await store.getOfficialRating(scope.account.id), rating, 'the v7 official rating survived');
    assert.equal((await store.listAccounts(null)).length, 1);
    assert.equal(await store.getVirtualPerformanceLedger(scope.account.id), null, 'v8 tables start empty');
  } finally {
    await store.close();
  }

  const migrated = new DatabaseSync(paths.path, { readOnly: true });
  try {
    assert.equal(readUserVersion(migrated), STORE_SCHEMA_VERSION);
    for (const table of ['virtual_performance_ledgers', 'ability_evaluation_attempts']) {
      assert.ok(tableNames(migrated).includes(table), `migrated schema is missing ${table}`);
    }
    assert.equal(migrated.prepare('SELECT count(*) AS total FROM virtual_performance_ledgers').get()?.['total'], 0);
    assert.equal(
      migrated.prepare('SELECT count(*) AS total FROM ability_evaluation_attempts').get()?.['total'],
      0,
      'the reserved ability-evaluation table is created empty',
    );
    assert.equal(migrated.prepare('SELECT count(*) AS total FROM problems').get()?.['total'], 1);
    assert.equal(migrated.prepare('SELECT count(*) AS total FROM official_rating_snapshots').get()?.['total'], 1);
  } finally {
    migrated.close();
  }

  const backups = readdirSync(paths.dir).filter((name) => name.includes('.backup-v7-') && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1, 'exactly one pre-migration copy at the literal v7 is kept');
  const backup = new DatabaseSync(join(paths.dir, backups[0]!), { readOnly: true });
  try {
    assert.equal(readUserVersion(backup), 7, 'the copy is the database as found');
    assert.equal(tableNames(backup).includes('virtual_performance_ledgers'), false);
    assert.equal(
      backup.prepare(`SELECT value FROM store_meta WHERE key = 'store_marker'`).get()?.['value'],
      STORE_MARKER,
    );
    assert.equal(backup.prepare('SELECT count(*) AS total FROM problems').get()?.['total'], 1);
    assert.equal(backup.prepare('SELECT count(*) AS total FROM official_rating_snapshots').get()?.['total'], 1);
  } finally {
    backup.close();
  }

  // Opening the migrated file again is not a migration: no second backup appears.
  store = new SqliteTrainingStore({ path: paths.path, now: () => LATER });
  await store.close();
  assert.equal(
    readdirSync(paths.dir).filter((name) => name.includes('.backup-') && name.endsWith('.sqlite')).length,
    1,
    'a current database is never backed up again',
  );
  fx.removeDirectory(paths.dir);
});

void test('an official rating snapshot stays byte-identical through ledger CRUD', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  let minted = 0;
  const service = new VirtualPerformanceService({ store, now: () => AT, uniqueId: () => `vp-${(minted += 1)}` });
  const rating = officialFixture(scope.account.id, fx.AT);
  try {
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.saveOfficialRating(rating, 0);
    const before = await store.getOfficialRating(scope.account.id);

    const created = await service.save(saveRequest(scope.account.id, 0), TOKEN);
    const evidenceId = created.entries[0]?.evidenceId ?? '';
    await service.save(saveRequest(scope.account.id, 1, { contestId: 1001 }), TOKEN);
    await service.delete({ accountId: scope.account.id, expectedRevision: 2, evidenceId }, TOKEN);

    assert.deepEqual(await store.getOfficialRating(scope.account.id), before, 'the official snapshot is unchanged');
  } finally {
    await store.close();
  }
  const raw = new DatabaseSync(paths.path, { readOnly: true });
  try {
    assert.equal(raw.prepare('SELECT count(*) AS total FROM official_rating_snapshots').get()?.['total'], 1);
    assert.equal(
      raw.prepare('SELECT body FROM official_rating_snapshots WHERE account_id = ?').get(scope.account.id)?.['body'],
      canonicalJson(rating),
      'the stored official body is byte-identical',
    );
    assert.equal(
      raw.prepare('SELECT revision FROM virtual_performance_ledgers WHERE account_id = ?').get(scope.account.id)?.['revision'],
      3,
      'the ledger advanced without touching the rating table',
    );
  } finally {
    raw.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('the planning summary is identifier-free, separates known assisted evidence and hashes every semantic field', async () => {
  await withBench(async ({ store, scope, service }) => {
    await service.save(
      saveRequest(scope.account.id, 0, {
        contestId: 987654321,
        performance: 1234,
        participatedAt: '2026-08-01T12:00:00.000Z',
        calculationMethod: 'carrot',
        sourceUrl: 'https://example.invalid/PRIVATE_URL_MARKER',
        note: 'PRIVATE_NOTE_MARKER',
        rank: 424242,
      }),
      TOKEN,
    );
    await service.save(
      saveRequest(scope.account.id, 1, {
        contestId: 987654322,
        performance: 1400,
        independence: 'assisted',
        calculationMethod: 'other-tool',
      }),
      TOKEN,
    );
    await service.save(
      saveRequest(scope.account.id, 2, {
        contestId: 987654323,
        performance: 1500,
        participatedAt: '2024-01-01T00:00:00.000Z',
        priorExposure: true,
      }),
      TOKEN,
    );
    const ledger = await store.getVirtualPerformanceLedger(scope.account.id);
    assert.ok(ledger !== null);

    const summary = virtualPerformancePlanningSummary(ledger, AT);
    assert.deepEqual(summary.counts, {
      total: 3,
      eligibleIndependent: 1,
      assisted: 1,
      unknownIndependence: 0,
      priorExposed: 1,
    });
    assert.equal(summary.eligible.length, 1, 'only independent, unseen-contest evidence is eligible');
    assert.equal(
      summary.knownAssistedOrPriorExposed.length,
      2,
      'known assisted and prior-exposed runs stay in their own group',
    );
    assert.equal(summary.unknownIndependence.length, 0);
    assert.equal(summary.estimation, 'not_estimated', 'this stage performs no numeric estimation');
    assert.equal(summary.ledgerPresent, true);
    assert.equal(summary.ledgerRevision, ledger.revision);
    // The age bucket is coarse and relative to the explicit instant, never an exact timestamp.
    assert.equal(summary.eligible[0]?.ageBucket, 'last_90_days');
    assert.equal(summary.eligible[0]?.recent, true);
    const priorExposed = summary.knownAssistedOrPriorExposed.find((entry) => entry.performance === 1500);
    assert.equal(priorExposed?.ageBucket, 'older');
    assert.equal(priorExposed?.priorExposure, true);
    assert.equal(summary.eligible[0]?.evidenceRef, 'vp-1', 'the reference is synthetic');

    const text = JSON.stringify(summary);
    for (const secret of [
      scope.account.id,
      scope.account.handle,
      '987654321',
      '987654322',
      '987654323',
      'PRIVATE_NOTE_MARKER',
      'PRIVATE_URL_MARKER',
      '424242',
      '2026-08-01T12:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
    ]) {
      assert.equal(text.includes(secret), false, `the summary must not carry ${secret}`);
    }
    assert.equal(text.includes(ledger.entries[0]?.evidenceId ?? 'never'), false, 'stored evidence ids never travel');

    // The summary round-trips through its own strict validator; a rewritten body is refused.
    assert.deepEqual(validateVirtualPerformancePlanningSummary(summary), summary);
    assert.throws(() => validateVirtualPerformancePlanningSummary({ ...summary, ledgerHash: 'nope' }), hasCode('invalid_input'));
    assert.throws(
      () => validateVirtualPerformancePlanningSummary({ ...summary, accountId: scope.account.id }),
      hasCode('invalid_input'),
    );

    // The hash covers every stored semantic field and is clock-free.
    const hash = virtualPerformanceLedgerHash(ledger);
    assert.equal(virtualPerformanceLedgerHash(ledger), hash);
    assert.equal(virtualPerformancePlanningSummary(ledger, LATER).ledgerHash, hash, 'a moved clock is not a change');
    assert.notEqual(hash, virtualPerformanceLedgerHash(null), 'an absent ledger is its own statement');

    await service.save(
      saveRequest(scope.account.id, 3, { evidenceId: ledger.entries.find((row) => row.contestId === 987654321)?.evidenceId ?? null, contestId: 987654321, performance: 1300 }),
      TOKEN,
    );
    const changed = await store.getVirtualPerformanceLedger(scope.account.id);
    const changedHash = virtualPerformanceLedgerHash(changed);
    assert.notEqual(changedHash, hash, 'an edit through the API changes the ledger hash');

    await service.delete(
      { accountId: scope.account.id, expectedRevision: 4, evidenceId: changed?.entries[0]?.evidenceId ?? '' },
      TOKEN,
    );
    const afterDelete = await store.getVirtualPerformanceLedger(scope.account.id);
    assert.notEqual(virtualPerformanceLedgerHash(afterDelete), changedHash, 'a deletion changes the ledger hash');

    // An account without a ledger always summarizes as an explicit absence, never as zero evidence.
    const absent = virtualPerformancePlanningSummary(null, AT);
    assert.equal(absent.ledgerPresent, false);
    assert.equal(absent.counts.total, 0);
    assert.deepEqual(absent.eligible, []);
    assert.equal(absent.disclosure.length > 0, true);
  });
});

void test('saving or deleting virtual evidence invalidates a prepared plan while a legacy preparation stays valid', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  let ids = 0;
  const workbench = new WorkbenchService({
    store,
    taxonomy: createTaxonomyIndex(CURRENT_TAXONOMY),
    now: () => AT,
    uniqueId: () => `wb-${(ids += 1)}`,
  });
  const service = new VirtualPerformanceService({ store, now: () => AT, uniqueId: () => `vp-${(ids += 1)}` });
  const calls: PlanGenerationRequest[] = [];
  const planning = new PlanningService({
    store,
    now: () => AT,
    generator: {
      async generate(request: PlanGenerationRequest) {
        calls.push(request);
        const first = request.candidates[0];
        if (first === undefined) throw new Error('the preparation carried no candidate');
        return {
          ok: true,
          value: { draft: { title: 'plan', tasks: [{ candidateId: first.candidateId, day: 1, minutes: 30, kind: 'solve' }] } },
          usage: createModelUsage({ calls: 1, promptTokens: 10, completionTokens: 10 }),
          callId: 'call-1',
          sessionId: null,
        };
      },
    },
    preparation: {
      prepare: workbench.preparePlanInput.bind(workbench),
      revalidate: workbench.revalidatePlanInput.bind(workbench),
      savePlan: workbench.saveModelPlan.bind(workbench),
    },
  });
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const solved = fx.makeScope('codeforces', 'codeforces.com', 'alice', '9Z');
  try {
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([
      scope.problem,
      fx.makeProblem(fx.makeRef(scope.instance, '2B')),
      fx.makeProblem(fx.makeRef(scope.instance, '3C')),
      solved.problem,
    ]);
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, solved.problem.ref, 'sub-solved', 'accepted', AT),
    ]);

    const first = await planning.prepare({ requestId: 'vp-prep-1', accountId: scope.account.id }, TOKEN);
    assert.equal(first.outcome, 'prepared');
    if (first.outcome !== 'prepared') return;
    const firstRow = await store.getPlanAttempt('vp-prep-1');
    assert.ok(firstRow !== null);
    assert.equal(firstRow.preparation.virtualPerformance?.ledgerPresent, false, 'an absent ledger is captured explicitly');
    assert.equal(firstRow.preparation.virtualPerformance?.entryCount, 0);

    // An unrelated read alone never invalidates the preparation.
    const clean = await workbench.revalidatePlanInput(firstRow.preparation, TOKEN);
    assert.equal(clean.ok, true);

    const created = await service.save(saveRequest(scope.account.id, 0), TOKEN);
    const evidenceId = created.entries[0]?.evidenceId ?? '';
    const afterSave = await workbench.revalidatePlanInput(firstRow.preparation, TOKEN);
    assert.equal(afterSave.ok, false);
    if (!afterSave.ok) assert.equal(afterSave.staleness.reason, 'virtual_performance_changed');
    const refused = await planning.run({ requestId: 'vp-prep-1', accountId: scope.account.id }, TOKEN);
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.error?.code, 'stale_preparation');
    assert.equal(calls.length, 0, 'no paid call is dispatched against stale virtual evidence');

    // A fresh preparation carries the new evidence and really sends it to the model request.
    const second = await planning.prepare({ requestId: 'vp-prep-2', accountId: scope.account.id }, TOKEN);
    assert.equal(second.outcome, 'prepared');
    const run = await planning.run({ requestId: 'vp-prep-2', accountId: scope.account.id }, TOKEN);
    assert.equal(run.outcome, 'planned');
    assert.equal(calls.length, 1);
    const dispatch = calls[0];
    assert.equal(dispatch?.virtualPerformance?.entryCount, 1);
    assert.equal(dispatch?.virtualPerformance?.eligible[0]?.evidenceRef, 'vp-1');
    assert.equal(
      JSON.stringify(dispatch?.virtualPerformance ?? {}).includes(scope.account.id),
      false,
      'the dispatched summary carries no account identifier',
    );

    // Deleting the row invalidates the second preparation too.
    await service.delete({ accountId: scope.account.id, expectedRevision: 1, evidenceId }, TOKEN);
    const secondRow = await store.getPlanAttempt('vp-prep-2');
    assert.ok(secondRow !== null);
    const afterDelete = await workbench.revalidatePlanInput(secondRow.preparation, TOKEN);
    assert.equal(afterDelete.ok, false);
    if (!afterDelete.ok) assert.equal(afterDelete.staleness.reason, 'virtual_performance_changed');

    // A legacy preparation without the capture keeps its pre-18c evidence hash and stays valid.
    const { virtualPerformance: _capture, ...legacyBase } = secondRow.preparation;
    const legacyPreparation: PlanAttemptPreparation = {
      ...legacyBase,
      evidenceHash: planPreparationEvidenceHash(legacyBase),
    };
    assert.notEqual(legacyPreparation.evidenceHash, secondRow.preparation.evidenceHash, 'the capture participates in the hash');
    const legacyValidated = validatePlanAttempt({ ...secondRow, preparation: legacyPreparation });
    assert.equal(Object.hasOwn(legacyValidated.preparation, 'virtualPerformance'), false);
    const legacyRevalidated = await workbench.revalidatePlanInput(legacyPreparation, TOKEN);
    assert.equal(legacyRevalidated.ok, true, 'a legacy preparation ignores evidence it never captured');
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

/** Minimal Connection Fetch registry, identical in shape to the other API fixtures. */
class Registry {
  readonly routes = new Map<string, ConnectionFetchRoute>();
  register(route: ConnectionFetchRoute): () => Promise<void> {
    this.routes.set(route.path, route);
    return async () => {
      await Promise.resolve();
      this.routes.delete(route.path);
    };
  }
  async call(
    operation: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly status: number; readonly body: { readonly value?: any; readonly error?: any } }> {
    const route = this.routes.get(`${API_PREFIX}${operation}`);
    assert.ok(route, `registered route ${operation}`);
    const response = await route.fetch(
      new Request(`http://localhost${API_PREFIX}${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    return { status: response.status, body: (await response.json()) as { value?: any; error?: any } };
  }
}

void test('the typed API registers exact routes, serves CRUD and maps typed refusals', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  let minted = 0;
  const service = new VirtualPerformanceService({ store, now: () => AT, uniqueId: () => `vp-${(minted += 1)}` });
  const registry = new Registry();
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  let dispose: (() => Promise<void>) | undefined;
  try {
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    dispose = await registerPerformanceApi({ registry, service });
    assert.deepEqual(
      [...registry.routes.keys()].sort(),
      Object.values(PERFORMANCE_API_OPERATIONS).map((operation) => `${API_PREFIX}${operation}`).sort(),
      'exactly the three performance routes are registered',
    );

    const empty = await registry.call('performance.list', { accountId: scope.account.id });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.value.revision, 0);
    assert.equal(empty.body.value.official, false);
    assert.deepEqual(empty.body.value.entries, []);

    const saved = await registry.call(
      'performance.save',
      saveRequest(scope.account.id, 0, { note: 'line one\nline two' }),
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.value.revision, 1);
    assert.equal(saved.body.value.entries[0].note, 'line one\nline two');
    const evidenceId = saved.body.value.entries[0].evidenceId as string;

    // Closed request shapes: an unknown key, an out-of-range value and a malformed field are 400.
    assert.equal((await registry.call('performance.save', { ...saveRequest(scope.account.id, 1), extra: true })).status, 400);
    assert.equal(
      (await registry.call('performance.save', saveRequest(scope.account.id, 1, { performance: 5001 }))).status,
      400,
    );
    assert.equal(
      (await registry.call('performance.save', saveRequest(scope.account.id, 1, { independence: 'guessed' }))).status,
      400,
    );
    assert.equal((await registry.call('performance.save', saveRequest(scope.account.id, 1, { source: 'official' }))).status, 400);
    // A stale revision and a foreign account keep their own stable codes.
    assert.equal((await registry.call('performance.save', saveRequest(scope.account.id, 0))).status, 409);
    assert.equal((await registry.call('performance.list', { accountId: 'missing' })).status, 404);
    assert.equal(
      (await registry.call('performance.save', saveRequest(scope.account.id, 1, { sourceUrl: 'ftp://x' }))).status,
      400,
    );

    const deleted = await registry.call('performance.delete', {
      accountId: scope.account.id,
      expectedRevision: 1,
      evidenceId,
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.value.revision, 2);
    assert.deepEqual(deleted.body.value.entries, []);

    // The client's abort cancels the request before the handler can answer.
    const controller = new AbortController();
    controller.abort();
    const aborted = await registry.call('performance.list', { accountId: scope.account.id }, controller.signal);
    assert.equal(aborted.status, 499);
  } finally {
    if (dispose !== undefined) await dispose();
    assert.equal(registry.routes.size, 0, 'disposal removes every registered route');
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});
