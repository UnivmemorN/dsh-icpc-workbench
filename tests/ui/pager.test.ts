/**
 * Numbered-bank pager rules (Sprint Contract 06a repair 1).
 *
 * These are the pure decisions `Bank.tsx` renders: what the jump field accepts and how the counters
 * behave before any confirmed response exists and for a confirmed empty page. No DOM is involved, so
 * the UI contract is exercised without weakening it to a string snapshot.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JUMP_HINT, jumpHint, pagerDisplay, parseJumpPage } from '../../src/ui/pager.js';

void test('the jump field accepts only a positive safe-integer page', () => {
  assert.equal(parseJumpPage('7'), 7);
  assert.equal(parseJumpPage(' 12 '), 12);
  assert.equal(parseJumpPage(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const invalid of ['', '   ', '0', '-1', '+3', '1.5', '2a', '1e3', '٣', '9007199254740992']) {
    assert.equal(parseJumpPage(invalid), null, `${JSON.stringify(invalid)} is not a positive integer page`);
  }

  assert.equal(jumpHint(''), null, 'an empty field is disabled, not an error');
  assert.equal(jumpHint('   '), null);
  assert.equal(jumpHint('4'), null);
  assert.equal(jumpHint('4.5'), JUMP_HINT);
  assert.equal(jumpHint('0'), JUMP_HINT);
  assert.equal(jumpHint('-2'), JUMP_HINT);
});

void test('the pager reports no totals until a confirmed response exists', () => {
  const pending = pagerDisplay(null, 5);
  assert.deepEqual(pending, {
    hasData: false,
    totalItems: 0,
    totalPages: 0,
    // The requested page is remembered, but `navigable` keeps every control disabled.
    currentPage: 5,
    navigable: false,
  });
  assert.equal(pagerDisplay(null, 1).navigable, false);
});

void test('a confirmed empty page displays 第 0 / 0 页 and stays non-navigable', () => {
  assert.deepEqual(pagerDisplay({ page: 1, totalItems: 0, totalPages: 0 }, 4), {
    hasData: true,
    totalItems: 0,
    totalPages: 0,
    currentPage: 0,
    navigable: false,
  });
  assert.deepEqual(pagerDisplay({ page: 3, totalItems: 60, totalPages: 3 }, 1), {
    hasData: true,
    totalItems: 60,
    totalPages: 3,
    currentPage: 3,
    navigable: true,
  });
});
