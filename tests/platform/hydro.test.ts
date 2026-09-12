/**
 * The fake Hydro double keeps the additive platform contract satisfied without advertising an
 * implementation that does not exist.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PLATFORM_LIMITS } from '../../src/application/ports.js';
import { createAccount, createCancellationSource } from '../../src/domain/index.js';
import { createFakeHydroAdapter } from './fake-hydro.js';

test('the fake Hydro adapter implements the port but never advertises support', async () => {
  const adapter = createFakeHydroAdapter();
  const capabilities = adapter.capabilities();
  assert.equal(capabilities.platform, 'hydro');
  assert.equal(capabilities.implemented, false);
  assert.match(capabilities.notes.join(' '), /test double/i);

  const token = createCancellationSource().token;
  const problemRef = { sourceInstanceId: adapter.sourceInstance.id, domain: null, externalKey: 'P1001' };
  const problem = await adapter.fetchProblem({ problemRef, token, limits: DEFAULT_PLATFORM_LIMITS });
  assert.match(problem.statement ?? '', /Given n/);
  assert.equal(problem.ref.sourceInstanceId, adapter.sourceInstance.id);

  const account = createAccount({ sourceInstanceId: adapter.sourceInstance.id, handle: 'pupil' });
  const page = await adapter.listSubmissions({ account, cursor: null, limit: 10, token, limits: DEFAULT_PLATFORM_LIMITS });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.accountId, account.id);

  const otherInstance = createAccount({ sourceInstanceId: 'hydro:other.example', handle: 'pupil' });
  const scoped = await adapter.listSubmissions({
    account: otherInstance,
    cursor: null,
    limit: 10,
    token,
    limits: DEFAULT_PLATFORM_LIMITS,
  });
  assert.equal(scoped.items.length, 0);

  const editorial = await adapter.fetchEditorial({ problemRef, token, limits: DEFAULT_PLATFORM_LIMITS });
  assert.equal(editorial.status, 'unavailable');
  assert.notEqual(editorial.status, 'absent');
});
