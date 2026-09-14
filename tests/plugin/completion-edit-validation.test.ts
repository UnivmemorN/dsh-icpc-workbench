/**
 * Boundary contract of the batch completion-edit API (Sprint 23a).
 *
 * The validators are the only gate between a browser body and the service, so these cases assert the
 * closed DTO shape, the 1..100 problem-key bound, the closed `preserve`/`add` knowledge intent, the
 * required preview hash and the new `retro.record` compare-and-set field. The registration case
 * pins the exact route names and the free-business route count.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORKBENCH_API_OPERATIONS } from '../../src/application/workbench-api.js';
import {
  validateRetroEditApply,
  validateRetroEditPreview,
  validateRetroList,
  validateRetroRecord,
} from '../../src/plugin/api-validation.js';
import * as fx from '../storage/fixtures.js';

const instance = fx.makeInstance('codeforces', 'codeforces.com');
const account = fx.makeAccount(instance, 'alice');
const problem = fx.makeProblem(fx.makeRef(instance, '1A'));
const secondProblem = fx.makeProblem(fx.makeRef(instance, '2B'));

function errorReason(error: unknown): string | null {
  const details = (error as { details?: Record<string, unknown> }).details;
  const reason = details?.['reason'];
  return typeof reason === 'string' ? reason : null;
}

async function rejects(run: () => unknown, reason?: string): Promise<void> {
  await assert.rejects(
    async () => {
      run();
    },
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'invalid_input', `expected invalid_input, got ${String(error)}`);
      if (reason !== undefined) {
        assert.equal(errorReason(error), reason);
      }
      return true;
    },
  );
}

void test('the composition registers exactly the three new batch edit routes', () => {
  assert.equal(WORKBENCH_API_OPERATIONS.retroRecord, 'retro.record');
  assert.equal(WORKBENCH_API_OPERATIONS.retroList, 'retro.list');
  assert.equal(WORKBENCH_API_OPERATIONS.retroEditPreview, 'retro.editPreview');
  assert.equal(WORKBENCH_API_OPERATIONS.retroEditApply, 'retro.editApply');
  assert.equal(
    Object.keys(WORKBENCH_API_OPERATIONS).length,
    24,
    'the free business registry now owns 24 routes, three of them new',
  );
});

void test('retro.list accepts 1..100 canonical keys and refuses everything else at the boundary', async () => {
  const parsed = validateRetroList({ accountId: account.id, problemKeys: [problem.key, secondProblem.key] });
  assert.deepEqual(parsed, { accountId: account.id, problemKeys: [problem.key, secondProblem.key] });

  await rejects(() => validateRetroList({ accountId: account.id, problemKeys: [] }), 'empty_array');
  await rejects(
    () =>
      validateRetroList({
        accountId: account.id,
        problemKeys: Array.from({ length: 101 }, (_, index) => `key-${index}`),
      }),
    'array_too_long',
  );
  await rejects(() => validateRetroList({ accountId: account.id, problemKeys: ['not a key'] }));
  await rejects(() => validateRetroList({ accountId: account.id, problemKeys: [problem.key], extra: true }), 'unknown_field');
  await rejects(() => validateRetroList({ accountId: account.id, problemKeys: [problem.key], account: account.id }));
});

void test('the knowledge intent is closed: preserve carries nothing, add needs a bounded non-empty list', async () => {
  const base = { accountId: account.id, problemKeys: [problem.key], mode: 'assisted' as const };
  const defaulted = validateRetroEditPreview(base);
  assert.equal(Object.hasOwn(defaulted, 'knowledge'), false, 'the default is applied by the service');

  assert.deepEqual(validateRetroEditPreview({ ...base, knowledge: { kind: 'preserve' } }).knowledge, {
    kind: 'preserve',
  });
  assert.deepEqual(
    validateRetroEditPreview({ ...base, knowledge: { kind: 'add', taxonomyIds: ['data-structure.stack'] } }).knowledge,
    { kind: 'add', taxonomyIds: ['data-structure.stack'] },
  );

  await rejects(
    () => validateRetroEditPreview({ ...base, knowledge: { kind: 'preserve', taxonomyIds: ['data-structure.stack'] } }),
    'unknown_field',
  );
  await rejects(() => validateRetroEditPreview({ ...base, knowledge: { kind: 'add', taxonomyIds: [] } }), 'empty_array');
  await rejects(
    () =>
      validateRetroEditPreview({
        ...base,
        knowledge: { kind: 'add', taxonomyIds: Array.from({ length: 501 }, (_, index) => `tag-${index}`) },
      }),
    'array_too_long',
  );
  await rejects(() => validateRetroEditPreview({ ...base, knowledge: { kind: 'replace', taxonomyIds: ['x'] } }));
  await rejects(() => validateRetroEditPreview({ ...base, mode: 'guessed' }));
  await rejects(() => validateRetroEditPreview({ ...base, knowledge: { kind: 'add' } }), 'missing_field');
});

void test('retro.editApply requires the preview hash it must compare against', async () => {
  const parsed = validateRetroEditApply({
    accountId: account.id,
    problemKeys: [problem.key],
    mode: 'independent',
    expectedPreviewHash: 'a'.repeat(64),
  });
  assert.equal(parsed.expectedPreviewHash, 'a'.repeat(64));
  assert.equal(parsed.mode, 'independent');

  await rejects(
    () => validateRetroEditApply({ accountId: account.id, problemKeys: [problem.key], mode: 'independent' }),
    'missing_field',
  );
  await rejects(() =>
    validateRetroEditApply({
      accountId: account.id,
      problemKeys: [problem.key],
      mode: 'independent',
      expectedPreviewHash: '   ',
    }),
  );
  await rejects(() =>
    validateRetroEditApply({
      accountId: account.id,
      problemKeys: [problem.key],
      mode: 'independent',
      expectedPreviewHash: 'a'.repeat(64),
      account: account.id,
    }),
  );
});

void test('retro.record accepts an explicit compare-and-set id or null and rejects other types', () => {
  const base = { problemKey: problem.key, accountId: account.id, mode: 'assisted' as const };
  assert.equal(validateRetroRecord({ ...base, expectedRetrospectiveId: null }).expectedRetrospectiveId, null);
  assert.equal(
    validateRetroRecord({ ...base, expectedRetrospectiveId: 'retro|abc' }).expectedRetrospectiveId,
    'retro|abc',
  );
  assert.equal(
    Object.hasOwn(validateRetroRecord(base), 'expectedRetrospectiveId'),
    false,
    'omitting the field keeps the legacy append shape',
  );
  assert.throws(
    () => validateRetroRecord({ ...base, expectedRetrospectiveId: 7 }),
    (error: unknown) => (error as { code?: unknown }).code === 'invalid_input',
  );
});
