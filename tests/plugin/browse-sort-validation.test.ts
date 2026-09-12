/**
 * `problem.browse` sort boundary (Sprint Contract 07a).
 *
 * Pure shape checks on the strict API validator: the accepted sort names are a closed enum, `null`
 * stays compatible with the legacy order, and the rating dimension is a bounded non-blank string.
 * The semantic rules (a difficulty sort needs a source instance and a dimension, and the dimension
 * must match one raw platform dimension) belong to the service and are covered there.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBLEM_SORTS } from '../../src/application/ports.js';
import { DomainError } from '../../src/domain/index.js';
import { validateProblemBrowse } from '../../src/plugin/api-validation.js';

function refusal(body: unknown): DomainError {
  try {
    validateProblemBrowse(body);
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    return error;
  }
  assert.fail(`problem.browse should refuse ${JSON.stringify(body)}`);
}

void test('problem.browse accepts exactly the declared sorts and keeps null compatibility', () => {
  assert.deepEqual(
    [...PROBLEM_SORTS],
    ['default', 'problem_asc', 'problem_desc', 'title_asc', 'title_desc', 'difficulty_asc', 'difficulty_desc'],
  );
  for (const sort of PROBLEM_SORTS) {
    assert.equal(validateProblemBrowse({ page: 1, limit: 25, sort }).sort, sort);
  }
  assert.equal(
    Object.hasOwn(validateProblemBrowse({ page: 1, limit: 25 }), 'sort'),
    false,
    'an omitted sort is absent, not coerced',
  );
  assert.equal(validateProblemBrowse({ page: 1, limit: 25, sort: null }).sort, null);
  assert.equal(
    validateProblemBrowse({ page: 1, limit: 25, sort: 'difficulty_desc', ratingDimension: 'rating' }).ratingDimension,
    'rating',
  );
  assert.equal(
    validateProblemBrowse({ page: 1, limit: 25, sort: 'problem_asc', ratingDimension: null }).ratingDimension,
    null,
  );
  assert.equal(
    validateProblemBrowse({ page: 1, limit: 25, sort: 'difficulty_asc', ratingDimension: 'x'.repeat(100) })
      .ratingDimension,
    'x'.repeat(100),
  );
});

void test('problem.browse refuses unknown sorts, malformed dimensions and unknown fields', () => {
  assert.equal(refusal({ page: 1, limit: 25, sort: 'by_vibes' }).details['reason'], 'invalid_enum');
  assert.equal(refusal({ page: 1, limit: 25, sort: 3 }).details['reason'], 'invalid_enum');
  assert.equal(refusal({ page: 1, limit: 25, sort: 'problem_asc', ratingDimension: '   ' }).details['reason'], 'blank_string');
  assert.equal(
    refusal({ page: 1, limit: 25, sort: 'problem_asc', ratingDimension: 'x'.repeat(101) }).details['reason'],
    'string_too_long',
  );
  assert.equal(refusal({ page: 1, limit: 25, sort: 'problem_asc', ratingDimension: 7 }).details['reason'], 'not_a_string');
  assert.equal(refusal({ page: 1, limit: 25, sort: 'problem_asc', cursor: null }).details['reason'], 'unknown_field');
});
