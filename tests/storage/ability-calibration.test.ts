import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/store.js';
import { initializeSchemaV4, readUserVersion, tableNames, STORE_TABLES_V4 } from '../../src/adapters/sqlite/schema.js';
import { validateAbilityCalibration, validateTrainingReference } from '../../src/domain/ability-calibration.js';
import { validateAbilityCalibrate } from '../../src/plugin/api-validation.js';
import * as fx from './fixtures.js';
const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
const bob = fx.makeScope('codeforces', 'codeforces.com', 'bob', '1A');
const value = { accountId: alice.account.id, revision: 1, recordedAt: fx.AT, source: 'self_report' as const, scale: 'codeforces' as const, range: { min: 1700, max: 2200 } };

test('schema v4 is backed up intact; calibration survives import and restart with immutable CAS revisions', async () => {
  const paths = fx.tempDatabase();
  let db = new DatabaseSync(paths.path);
  initializeSchemaV4(db);
  assert.equal(readUserVersion(db), 4);
  assert.deepEqual(tableNames(db), [...STORE_TABLES_V4].sort());
  db.close();
  let store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const backups = readdirSync(paths.dir).filter(n => n.includes('.backup-v4-'));
    assert.equal(backups.length, 1);
    db = new DatabaseSync(join(paths.dir, backups[0]!), { readOnly: true });
    assert.equal(readUserVersion(db), 4);
    assert.equal(tableNames(db).includes('ability_calibrations'), false);
    db.close();
    await store.upsertSourceInstances([alice.instance]);
    await store.upsertAccounts([alice.account, bob.account]);
    assert.equal(await store.getAbilityCalibration(alice.account.id), null);
    const races = await Promise.allSettled([store.saveAbilityCalibration(value, 0), store.saveAbilityCalibration({ ...value, range: { min: 1800, max: 2300 } }, 0)]);
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(races.filter(r => r.status === 'rejected').length, 1);
    assert.deepEqual(await store.getAbilityCalibration(alice.account.id), value);
    assert.equal(await store.getAbilityCalibration(bob.account.id), null);
    await store.upsertAccounts([{ ...alice.account, displayName: 'Imported again' }]);
    assert.deepEqual(await store.getAbilityCalibration(alice.account.id), value);
    await store.close();
    store = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
    assert.deepEqual(await store.getAbilityCalibration(alice.account.id), value);
    await store.saveAbilityCalibration({ ...value, revision: 2, range: null, recordedAt: fx.LATER }, 1);
    assert.equal((await store.getAbilityCalibration(alice.account.id))!.range, null);
    db = new DatabaseSync(paths.path, { readOnly: true });
    const rows = db.prepare('SELECT body FROM ability_calibrations ORDER BY revision').all();
    assert.equal(rows.length, 2);
    assert.deepEqual(JSON.parse(rows[0]!['body'] as string), value);
    assert.equal(readUserVersion(db), 6);
    db.close();
  } finally { await store.close(); fx.removeDirectory(paths.dir); }
});

test('calibration boundary rejects coercion, wrong provenance, reversed ranges and identifier leaks', () => {
  assert.deepEqual(validateAbilityCalibration(value), value);
  for (const range of [{ min: 2200, max: 1700 }, { min: '1700', max: 2200 }, { min: 0, max: 2200 }, { min: 1.2, max: 2200 }, { min: 1700, max: Infinity }, { min: 1700, max: 2200, note: 'private' }]) {
    assert.throws(() => validateAbilityCalibration({ ...value, range }));
  }
  assert.throws(() => validateAbilityCalibration({ ...value, source: 'official' }));
  const request = { accountId: alice.account.id, expectedRevision: 0, range: value.range };
  assert.deepEqual(validateAbilityCalibrate(request), request);
  assert.throws(() => validateAbilityCalibrate({ ...request, source: 'official' }));
  assert.throws(() => validateAbilityCalibrate({ ...request, expectedRevision: '0' }));
  assert.throws(() => validateTrainingReference({ source: 'self_report', scale: 'codeforces', range: value.range, revision: 1, accountId: alice.account.id }));
  assert.throws(() => validateTrainingReference({ source: 'uncalibrated', scale: 'codeforces', range: value.range, revision: 1 }));
});
