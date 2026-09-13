import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/store.js';
import { CodeforcesAdapter } from '../../src/adapters/codeforces/adapter.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import { DEFAULT_PLATFORM_LIMITS } from '../../src/application/ports.js';
import { CURRENT_TAXONOMY, createTaxonomyIndex, createCancellationSource } from '../../src/domain/index.js';
import { officialFixture } from '../official-rating-fixtures.js';
import * as fx from '../storage/fixtures.js';

test('rating sync commits only complete non-cancelled current revisions and preserves prior evidence on failures', async () => {
  const paths = fx.tempDatabase(), store = new SqliteTrainingStore({ path: paths.path });
  const adapter = new CodeforcesAdapter(), account = adapter.account('alice'), bob = adapter.account('bob');
  const service = new WorkbenchService({ store, taxonomy: createTaxonomyIndex(CURRENT_TAXONOMY), now: () => fx.AT, uniqueId: () => 'synthetic' });
  const token = createCancellationSource().token;
  const sync = (t = token) => service.syncOfficialRating(account.id, adapter, DEFAULT_PLATFORM_LIMITS, t);
  try {
    await store.upsertSourceInstances([adapter.sourceInstance]); await store.upsertAccounts([account, bob]);
    const { revision: _revision, ...data } = officialFixture(account.id);
    adapter.fetchOfficialRating = async () => data;
    assert.equal((await sync()).revision, 1);
    assert.equal((await service.weakness({ accountId: account.id }, token)).ability.trainingReference.source, 'official_rating');
    assert.equal((await service.weakness({ accountId: bob.id }, token)).ability.officialRating.status, 'not_loaded');
    const before = await store.getOfficialRating(account.id);
    adapter.fetchOfficialRating = async () => { throw Error('synthetic outage'); };
    await assert.rejects(sync(), /synthetic outage/);
    assert.deepEqual(await store.getOfficialRating(account.id), before);
    adapter.fetchOfficialRating = async () => ({ ...data, accountId: bob.id });
    await assert.rejects(sync()); assert.deepEqual(await store.getOfficialRating(account.id), before);
    const cancel = createCancellationSource();
    adapter.fetchOfficialRating = async () => { cancel.cancel(); return data; };
    await assert.rejects(sync(cancel.token)); assert.deepEqual(await store.getOfficialRating(account.id), before);
    let ready!: () => void, calls = 0;
    const bothFetched = new Promise<void>(resolve => { ready = resolve; });
    adapter.fetchOfficialRating = async () => { if (++calls === 2) ready(); await bothFetched; return data; };
    const races = await Promise.allSettled([sync(), sync()]);
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(races.filter(r => r.status === 'rejected').length, 1);
    assert.equal((await store.getOfficialRating(account.id))?.revision, 2);
  } finally { await store.close(); fx.removeDirectory(paths.dir); }
});
