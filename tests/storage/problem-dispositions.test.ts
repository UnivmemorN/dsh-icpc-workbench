import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { migrateToSchemaV9, STORE_TABLES_V9, STORE_TABLES_V11 } from '../../src/adapters/sqlite/schema.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import { CURRENT_TAXONOMY, createTaxonomyIndex, createCancellationSource } from '../../src/domain/index.js';
import * as fx from './fixtures.js';

const TOKEN = createCancellationSource().token;
void test('skip retains evidence; trash excludes native/merged bank, statistics, ability and current snapshots; restore preserves newer imports', async () => {
  const paths = fx.tempDatabase();
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
  try {
    const scope = fx.makeScope('luogu', 'www.luogu.com.cn', '800001', 'P1001');
    const other = fx.makeAccount(scope.instance, '800002');
    await store.upsertSourceInstances([scope.instance]); await store.upsertAccounts([scope.account, other]);
    await store.upsertProblems([scope.problem]);
    const submission = fx.makeSubmission(scope.account, scope.problem.ref, '100', 'accepted');
    await store.upsertSubmissions([submission, fx.makeSubmission(other, scope.problem.ref, '101', 'accepted')]);
    const snapshot = fx.makeSnapshot(scope.problem); await store.saveSnapshot(snapshot);
    const retro = fx.makeRetrospective(scope.problem, scope.account.id); await store.saveRetrospective(retro);
    const change = (action: 'skip' | 'trash' | 'restore', expectedState: null | 'skipped' | 'trashed') => store.applyProblemDispositions({ accountId: scope.account.id, action, items: [{ problemKey: scope.problem.key, expectedState }] });
    const assessment = async () => new WorkbenchService({ store, taxonomy: createTaxonomyIndex(CURRENT_TAXONOMY), now: () => fx.LATER, uniqueId: () => 'unused' }).weakness({ accountId: scope.account.id }, TOKEN);
    assert.equal((await assessment()).ability.counts.solvedDistinct, 1);
    await change('skip', null);
    assert.ok(await store.getProblem(scope.problem.key));
    assert.equal((await assessment()).solvedDistribution.totalSolved, 1);
    assert.equal((await store.listRetrospectives(scope.account.id)).length, 1);
    await change('trash', 'skipped');
    await store.close(); store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
    assert.equal(await store.getProblem(scope.problem.key), null);
    assert.equal(await store.getSnapshot(snapshot.snapshotId), null);
    assert.equal(await store.getCurrentSnapshotHead(scope.problem.ref), null);
    assert.equal(await store.getSubmission(submission.id), null);
    assert.equal((await store.listSubmissions(other.id, { limit: 50, cursor: null })).items.length, 0, 'same native key affects all local accounts');
    assert.equal((await store.listProblems({ limit: 20, cursor: null })).items.length, 0);
    assert.equal((await store.browseProblems({ accountId: scope.account.id, page: 1, limit: 20 })).totalItems, 0);
    assert.equal((await store.browseMergedProblems({ accountIds: [scope.account.id], page: 1, limit: 20 })).totalItems, 0);
    assert.equal((await store.listRetrospectives(scope.account.id)).length, 0);
    const hidden = await assessment();
    assert.equal(hidden.solvedDistribution.totalSolved, 0);
    assert.equal(hidden.ability.counts.solvedDistinct, 0);
    assert.equal(hidden.report.solvedDistinctTotal, 0);
    const updated = fx.makeProblem(scope.problem.ref, { title: 'Newer imported title', fetchedAt: fx.LATER });
    await store.upsertProblems([updated]); await store.upsertSubmissions([submission, fx.makeSubmission(scope.account, scope.problem.ref, '102', 'accepted', fx.LATER)]);
    assert.equal(await store.getProblem(updated.key), null, 'upsert must not clear tombstone');
    assert.equal((await assessment()).ability.counts.solvedDistinct, 0);
    const managed = await store.listProblemDispositions({ sourceInstanceId: scope.instance.id, state: 'trashed', page: 99, limit: 20 });
    assert.equal(managed.page, 1); assert.equal(managed.totalItems, 1); assert.equal(managed.items[0]?.title, updated.title);
    await change('restore', 'trashed');
    assert.deepEqual(await store.getProblem(updated.key), updated);
    assert.deepEqual(await store.getSnapshot(snapshot.snapshotId), snapshot);
    assert.deepEqual(await store.listRetrospectives(scope.account.id), [retro]);
    assert.equal((await store.listSubmissions(scope.account.id, { limit: 50, cursor: null })).items.length, 2);
    assert.equal((await assessment()).ability.counts.solvedDistinct, 1);
  } finally { await store.close(); fx.removeDirectory(paths.dir); }
});

void test('trash removes only native mirror member and its AC evidence; batches and pages are atomic and bounded', async () => {
  const paths = fx.tempDatabase(), store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
  try {
    const cf = fx.makeScope('codeforces', 'codeforces.com', 'fixture', '1A');
    const lg = fx.makeScope('luogu', 'www.luogu.com.cn', '800001', 'CF1A');
    await store.upsertSourceInstances([cf.instance, lg.instance]); await store.upsertAccounts([cf.account, lg.account]);
    await store.upsertProblems([cf.problem, lg.problem]);
    await store.upsertSubmissions([fx.makeSubmission(lg.account, lg.problem.ref, '100', 'accepted')]);
    const query = { accountIds: [cf.account.id, lg.account.id], page: 1, limit: 20 };
    assert.equal((await store.browseMergedProblems(query)).items[0]?.solved, true);
    await store.applyProblemDispositions({ accountId: lg.account.id, action: 'trash', items: [{ problemKey: lg.problem.key, expectedState: null }] });
    const page = await store.browseMergedProblems(query);
    assert.equal(page.totalItems, 1); assert.equal(page.items[0]?.members.length, 1);
    assert.equal(page.items[0]?.members[0]?.problem.key, cf.problem.key);
    assert.equal(page.items[0]?.solved, false); assert.deepEqual(page.items[0]?.acceptedEvidence, []);
    assert.equal((await store.browseMergedProblems({ ...query, status: 'solved' })).totalItems, 0);
    assert.ok(await store.getProblem(cf.problem.key), 'another native platform key is independently retained');
    const extra = Array.from({ length: 25 }, (_, i) => fx.makeProblem(fx.makeRef(lg.instance, `P${1000 + i}`)));
    await store.upsertProblems(extra);
    const items = extra.map(problem => ({ problemKey: problem.key, expectedState: null }));
    await assert.rejects(store.applyProblemDispositions({ accountId: lg.account.id, action: 'trash', items: [items[0]!, { problemKey: lg.problem.key, expectedState: null }] }));
    assert.equal(await store.getProblemDisposition(items[0]!.problemKey), null, 'stale last item rolls back first');
    await assert.rejects(store.applyProblemDispositions({ accountId: lg.account.id, action: 'skip', items: [items[0]!, items[0]!] }));
    await assert.rejects(store.applyProblemDispositions({ accountId: lg.account.id, action: 'skip', items: [{ problemKey: cf.problem.key, expectedState: null }] }));
    await assert.rejects(store.applyProblemDispositions({ accountId: lg.account.id, action: 'skip', items: [{ problemKey: fx.makeProblem(fx.makeRef(lg.instance, 'U999999')).key, expectedState: null }] }));
    await store.applyProblemDispositions({ accountId: lg.account.id, action: 'skip', items });
    const first = await store.listProblemDispositions({ sourceInstanceId: lg.instance.id, state: 'skipped', limit: 20, page: 1 });
    const last = await store.listProblemDispositions({ sourceInstanceId: lg.instance.id, state: 'skipped', limit: 20, page: 99 });
    assert.equal(first.totalItems, 25); assert.equal(first.items.length, 20); assert.equal(last.page, 2); assert.equal(last.items.length, 5);
    assert.equal(new Set([...first.items, ...last.items].map(item => item.problemKey)).size, 25);
    await assert.rejects(store.listProblemDispositions({ sourceInstanceId: lg.instance.id, state: 'skipped', limit: 51, page: 1 }));
  } finally { await store.close(); fx.removeDirectory(paths.dir); }
});

void test('genuine v9 gets a verified v9 backup and additive current-schema migration without rewriting any old row', async () => {
  const paths = fx.tempDatabase();
  const db = new DatabaseSync(paths.path);
  migrateToSchemaV9(db, 0);
  assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 9, 'historical helper stays frozen');
  const scope = fx.makeScope('luogu', 'www.luogu.com.cn', '800001', 'U100001');
  db.prepare('INSERT INTO problems (key,source_instance_id,domain,external_key,title,fetched_at,body) VALUES (?,?,?,?,?,?,?)').run(scope.problem.key, scope.instance.id, null, 'U100001', scope.problem.title, scope.problem.fetchedAt, JSON.stringify(scope.problem));
  const fingerprint = (connection: DatabaseSync, tables: readonly string[]) => Object.fromEntries(tables.map(table => [table, connection.prepare(`SELECT * FROM "${table}"`).all()]));
  const before = fingerprint(db, STORE_TABLES_V9); db.close();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER }); await store.close();
  const migrated = new DatabaseSync(paths.path, { readOnly: true });
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get()?.['user_version'], 11, 'the store migrates to the current schema');
    assert.deepEqual(fingerprint(migrated, STORE_TABLES_V9), before);
    assert.deepEqual(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row['name']), [...STORE_TABLES_V11].sort());
    assert.equal(migrated.prepare('SELECT count(*) AS n FROM problem_dispositions').get()?.['n'], 0);
    assert.equal(migrated.prepare('SELECT count(*) AS n FROM material_refresh_batches').get()?.['n'], 0);
  } finally { migrated.close(); }
  const backups = readdirSync(paths.dir).filter(name => name.includes('.backup-v9-'));
  assert.equal(backups.length, 1);
  const copy = new DatabaseSync(join(paths.dir, backups[0]!), { readOnly: true });
  try { assert.equal(copy.prepare('PRAGMA user_version').get()?.['user_version'], 9); assert.deepEqual(fingerprint(copy, STORE_TABLES_V9), before); } finally { copy.close(); fx.removeDirectory(paths.dir); }
});
