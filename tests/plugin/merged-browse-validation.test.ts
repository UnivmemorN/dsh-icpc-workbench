/**
 * `problem.mergedBrowse` boundary and route (Sprint Contract 08b).
 *
 * Shape checks on the strict API validator plus the additive registration itself: the new route is
 * exactly one operation on top of the unchanged ones, an unknown field or an unrepresentable value is
 * refused before any read, and a valid body reaches the workbench service unchanged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { MAX_MERGED_BANK_ACCOUNTS } from '../../src/application/ports.js';
import { WORKBENCH_API_OPERATIONS } from '../../src/application/workbench-api.js';
import type { ImportService } from '../../src/application/import-service.js';
import type { TrainingStore } from '../../src/application/ports.js';
import type { WorkbenchService } from '../../src/application/workbench-service.js';
import { DomainError } from '../../src/domain/index.js';
import { registerBusinessApi } from '../../src/plugin/business-api.js';
import { validateProblemMergedBrowse } from '../../src/plugin/api-validation.js';

const AT = '2026-11-01T08:00:00.000Z';

function refusal(body: unknown): DomainError {
  try {
    validateProblemMergedBrowse(body);
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    return error;
  }
  assert.fail(`problem.mergedBrowse should refuse ${JSON.stringify(body)}`);
}

void test('problem.mergedBrowse accepts exactly the declared fields', () => {
  assert.equal(WORKBENCH_API_OPERATIONS.problemMergedBrowse, 'problem.mergedBrowse');

  const minimal = validateProblemMergedBrowse({ page: 1, limit: 25 });
  assert.deepEqual(minimal, { page: 1, limit: 25 });
  assert.equal(Object.hasOwn(minimal, 'accountIds'), false, 'an omitted selection stays absent');

  const full = validateProblemMergedBrowse({
    accountIds: [],
    sourceInstanceId: null,
    status: 'unconfirmed',
    onlyAttempted: true,
    query: null,
    sort: 'title_asc',
    ratingDimension: null,
    page: 3,
    limit: 100,
    reveal: true,
  });
  assert.deepEqual(full, {
    accountIds: [],
    sourceInstanceId: null,
    status: 'unconfirmed',
    onlyAttempted: true,
    query: null,
    sort: 'title_asc',
    ratingDimension: null,
    page: 3,
    limit: 100,
    reveal: true,
  });

  for (const status of ['all', 'solved', 'unconfirmed'] as const) {
    assert.equal(validateProblemMergedBrowse({ page: 1, limit: 1, status }).status, status);
  }
  for (const sort of ['default', 'problem_asc', 'problem_desc', 'title_asc', 'title_desc', 'difficulty_asc', 'difficulty_desc'] as const) {
    assert.equal(
      validateProblemMergedBrowse({ page: 1, limit: 1, sort, ratingDimension: 'rating' }).sort,
      sort,
    );
  }
  assert.equal(validateProblemMergedBrowse({ page: 1, limit: 1, query: '1A' }).query, '1A');
  assert.equal(
    validateProblemMergedBrowse({ page: 1, limit: 1, accountIds: ['a', 'b'] }).accountIds?.length,
    2,
  );
});

void test('problem.mergedBrowse refuses unknown fields, unrepresentable values and out-of-range bounds', () => {
  assert.equal(refusal({ page: 1, limit: 25, cursor: null }).details['reason'], 'unknown_field');
  assert.equal(refusal({ page: 1, limit: 25, accountId: 'x' }).details['reason'], 'unknown_field');
  assert.equal(refusal({ page: 1, limit: 25, status: null }).details['reason'], 'invalid_enum');
  assert.equal(refusal({ page: 1, limit: 25, sort: null }).details['reason'], 'invalid_enum');
  assert.equal(refusal({ page: 1, limit: 25, status: 'maybe' }).details['reason'], 'invalid_enum');
  assert.equal(refusal({ page: 1, limit: 25, sort: 'by_vibes' }).details['reason'], 'invalid_enum');
  assert.equal(refusal({ limit: 25 }).details['reason'], 'missing_field');
  assert.equal(refusal({ page: 0, limit: 25 }).details['reason'], 'out_of_range');
  assert.equal(refusal({ page: 1, limit: 101 }).details['reason'], 'out_of_range');
  assert.equal(refusal({ page: 1, limit: 0 }).details['reason'], 'out_of_range');
  assert.equal(refusal({ page: 1, limit: 25, accountIds: 'alice' }).details['reason'], 'not_an_array');
  assert.equal(
    refusal({ page: 1, limit: 25, accountIds: ['  '] }).details['reason'],
    'blank_string',
  );
  assert.deepEqual(
    validateProblemMergedBrowse({ page: 1, limit: 25, accountIds: ['a', 'a'] }).accountIds,
    ['a', 'a'],
    "a repeated id is the service's rule, not a shape rule",
  );
  assert.equal(
    refusal({
      page: 1,
      limit: 25,
      accountIds: Array.from({ length: MAX_MERGED_BANK_ACCOUNTS + 1 }, (_, index) => `a${index}`),
    }).details['reason'],
    'array_too_long',
  );
  assert.equal(refusal({ page: 1, limit: 25, query: '   ' }).details['reason'], 'blank_string');
  assert.equal(refusal({ page: 1, limit: 25, query: 'x'.repeat(201) }).details['reason'], 'string_too_long');
  assert.equal(refusal({ page: 1, limit: 25, reveal: 'true' }).details['reason'], 'not_a_boolean');
  assert.equal(refusal({ page: 1, limit: 25, onlyAttempted: 1 }).details['reason'], 'not_a_boolean');
});

void test('the merged route is registered additively and delegates the validated request', async () => {
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const registry: HostConnectionFetch = {
    register(route) {
      routes.set(route.path, route as unknown as { fetch(request: Request): Promise<Response> });
      return async () => undefined;
    },
  };
  const calls: unknown[] = [];
  const page = {
    pageId: 'page-1',
    items: [],
    page: 1,
    pageSize: 25,
    totalItems: 0,
    totalPages: 0,
    fetchedAt: AT,
    reveal: false,
    equivalenceRules: [],
  };
  const dispose = await registerBusinessApi({
    registry,
    store: {
      transaction: async (work: () => Promise<unknown>) => work(),
    } as unknown as TrainingStore,
    imports: {
      syncPage: async () => {
        throw new Error('not used by this test');
      },
      applyManual: async () => {
        throw new Error('not used by this test');
      },
    } as unknown as ImportService,
    workbench: {
      browseMergedProblems: async (input: unknown) => {
        calls.push(input);
        return page;
      },
    } as unknown as WorkbenchService,
    adapterFor: async () => {
      throw new Error('not used by this test');
    },
    sources: [],
    settings: async () => null,
  });
  try {
    const route = routes.get('/api/icpc/v1/problem.mergedBrowse');
    assert.ok(route, 'the additive merged route must be registered');
    const answer = await route.fetch(
      new Request('http://localhost/api/icpc/v1/problem.mergedBrowse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountIds: ['account-1'],
          sourceInstanceId: null,
          status: 'solved',
          onlyAttempted: true,
          query: null,
          sort: 'title_asc',
          ratingDimension: null,
          page: 2,
          limit: 50,
          reveal: true,
        }),
      }),
    );
    assert.equal(answer.status, 200);
    assert.deepEqual(calls, [
      {
        accountIds: ['account-1'],
        sourceInstanceId: null,
        status: 'solved',
        onlyAttempted: true,
        query: null,
        sort: 'title_asc',
        ratingDimension: null,
        page: 2,
        limit: 50,
        reveal: true,
      },
    ]);

    calls.length = 0;
    const refused = await route.fetch(
      new Request('http://localhost/api/icpc/v1/problem.mergedBrowse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: 1, limit: 25, cursor: null }),
      }),
    );
    assert.equal(refused.status, 400);
    assert.deepEqual(calls, [], 'a refused request never reaches the service');
  } finally {
    await dispose();
  }
});
