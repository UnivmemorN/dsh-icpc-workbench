import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/store.js';
import { migrateToSchemaV5, readUserVersion, STORE_SCHEMA_VERSION, STORE_TABLES_V5, tableNames } from '../../src/adapters/sqlite/schema.js';
import { officialFixture } from '../official-rating-fixtures.js';
import * as fx from './fixtures.js';

test('v5 migration backs up old tables; official snapshots use append-only CAS and survive restart', async () => {
  const paths = fx.tempDatabase();
  let db = new DatabaseSync(paths.path); migrateToSchemaV5(db, 0);
  assert.equal(readUserVersion(db), 5); assert.deepEqual(tableNames(db), [...STORE_TABLES_V5].sort()); db.close();
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  const a = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A'), b = fx.makeScope('codeforces', 'codeforces.com', 'bob', '1A');
  try {
    const backup = readdirSync(paths.dir).find(n => n.includes('.backup-v5-')); assert.ok(backup);
    db = new DatabaseSync(join(paths.dir, backup), { readOnly: true }); assert.equal(readUserVersion(db), 5); assert.equal(tableNames(db).includes('official_rating_snapshots'), false); db.close();
    await store.upsertSourceInstances([a.instance]); await store.upsertAccounts([a.account, b.account]);
    const snapshot = officialFixture(a.account.id);
    const writes = await Promise.allSettled([store.saveOfficialRating(snapshot, 0), store.saveOfficialRating(snapshot, 0)]);
    assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(await store.getOfficialRating(b.account.id), null);
    await store.upsertAccounts([{ ...a.account, displayName: 're-imported' }]);
    await store.close(); store = new SqliteTrainingStore({ path: paths.path });
    assert.deepEqual(await store.getOfficialRating(a.account.id), snapshot);
    await store.saveOfficialRating({ ...snapshot, revision: 2, fetchedAt: fx.LATER }, 1);
    await assert.rejects(store.saveOfficialRating({ ...snapshot, revision: 3, rating: 9999 }, 2));
    assert.equal((await store.getOfficialRating(a.account.id))?.revision, 2);
    db = new DatabaseSync(paths.path, { readOnly: true }); assert.equal(readUserVersion(db), STORE_SCHEMA_VERSION);
    const rows = db.prepare('SELECT body FROM official_rating_snapshots ORDER BY revision').all(); assert.equal(rows.length, 2); assert.deepEqual(JSON.parse(rows[0]!['body'] as string), snapshot); db.close();
    await store.close(); db = new DatabaseSync(paths.path); db.exec("UPDATE official_rating_snapshots SET body = '{}' WHERE revision = 2"); db.close();
    store = new SqliteTrainingStore({ path: paths.path }); await assert.rejects(store.getOfficialRating(a.account.id), { code: 'corrupt_row' });
  } finally { await store.close(); fx.removeDirectory(paths.dir); }
});

test('a foreign v5 marker is refused before backup, journal changes or migration', () => {
  const paths = fx.tempDatabase();
  try {
    const db = new DatabaseSync(paths.path); migrateToSchemaV5(db, 0);
    db.exec("UPDATE store_meta SET value = 'foreign-store'"); db.close();
    const before = readFileSync(paths.path), names = readdirSync(paths.dir);
    assert.throws(() => new SqliteTrainingStore({ path: paths.path }), { code: 'unsupported_schema' });
    assert.deepEqual(readFileSync(paths.path), before);
    assert.deepEqual(readdirSync(paths.dir), names);
  } finally { fx.removeDirectory(paths.dir); }
});
