/**
 * Refresh transitions of the Luogu panel (Sprint 17d2 integration repair).
 *
 * `luoguSyncProgressStep` is the pure rule that decides when the panel must ask the bank and the
 * bootstrap to re-read their data. These cases pin the two behaviours the integration repair fixed:
 * a first successful sync is not mistaken for an already-seen instant (the baseline is adopted even
 * while `lastSuccessAt` is still null), and a pass that ends by cancellation or failure after it
 * committed pages still refreshes exactly once — while unchanged polling, a first read and an
 * account switch refresh nothing at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  luoguSyncProgressStep,
  type LuoguSyncProgress,
  type LuoguSyncProgressState,
} from '../../src/ui/luogu-view.js';

const ACCOUNT = 'luogu:www.luogu.com.cn:800001';
const OTHER = 'luogu:www.luogu.com.cn:800002';
const AT = '2026-03-01T10:00:00.000Z';

/** One observation of committed progress; every field is stated so a case reads as a scenario. */
function observation(overrides: Partial<LuoguSyncProgress> = {}): LuoguSyncProgress {
  return {
    accountId: ACCOUNT,
    lastSuccessAt: null,
    totalPages: 0,
    submissionsSeen: 0,
    running: false,
    leaseActive: false,
    ...overrides,
  };
}

/** Fold a whole sequence of observations, returning only the refresh decisions in order. */
function fold(observations: readonly LuoguSyncProgress[]): readonly boolean[] {
  let state: LuoguSyncProgressState | null = null;
  return observations.map((next) => {
    const step = luoguSyncProgressStep(state, next);
    state = step.state;
    return step.refresh;
  });
}

void test('a first read is adopted even while lastSuccessAt is still null', () => {
  const first = luoguSyncProgressStep(null, observation());
  assert.equal(first.refresh, false);
  assert.equal(first.state.lastSuccessAt, null, 'the baseline exists before the first success');
  assert.equal(first.state.pendingRefresh, false);
  assert.equal(first.state.accountId, ACCOUNT);
});

void test('the first successful sync of a never-synced account refreshes exactly once', () => {
  const refreshed = fold([
    observation(),
    observation({ totalPages: 2, submissionsSeen: 60, running: true }),
    observation({ totalPages: 2, submissionsSeen: 60, lastSuccessAt: AT }),
    observation({ totalPages: 2, submissionsSeen: 60, lastSuccessAt: AT }),
  ]);
  assert.deepEqual(refreshed, [false, false, true, false]);
});

void test('a pass that ends by cancellation still refreshes the pages it committed', () => {
  const refreshed = fold([
    observation(),
    observation({ totalPages: 1, submissionsSeen: 50, running: true }),
    observation({ totalPages: 1, submissionsSeen: 50 }),
    observation({ totalPages: 1, submissionsSeen: 50 }),
  ]);
  assert.deepEqual(refreshed, [false, false, true, false], 'a partial pass is a committed change, not a silent one');
});

void test('a committed page seen only while running refreshes when the pass is observed to end', () => {
  const refreshed = fold([
    observation(),
    observation({ totalPages: 1, submissionsSeen: 50, running: true }),
    observation({ totalPages: 1, submissionsSeen: 50, running: true }),
    observation({ totalPages: 1, submissionsSeen: 50 }),
  ]);
  assert.deepEqual(refreshed, [false, false, false, true]);
});

void test('one committed change causes one refresh, never a poll refresh storm', () => {
  const refreshed = fold([
    observation({ lastSuccessAt: AT, totalPages: 1, submissionsSeen: 50 }),
    observation({ lastSuccessAt: AT, totalPages: 2, submissionsSeen: 100, running: true }),
    observation({ lastSuccessAt: AT, totalPages: 2, submissionsSeen: 100 }),
    observation({ lastSuccessAt: AT, totalPages: 2, submissionsSeen: 100 }),
    observation({ lastSuccessAt: AT, totalPages: 2, submissionsSeen: 100 }),
  ]);
  assert.deepEqual(refreshed, [false, false, true, false, false]);
});

void test('unchanged polling, another instance and an account switch refresh nothing', () => {
  const refreshed = fold([
    observation({ lastSuccessAt: AT, totalPages: 3, submissionsSeen: 120 }),
    observation({ lastSuccessAt: AT, totalPages: 3, submissionsSeen: 120 }),
    // Another dsh instance holds the lease and commits a page: the panel waits for the observed end.
    observation({ lastSuccessAt: AT, totalPages: 4, submissionsSeen: 170, leaseActive: true }),
    observation({ lastSuccessAt: AT, totalPages: 4, submissionsSeen: 170 }),
    // Switching accounts adopts a fresh baseline: the other account's instant is never "new".
    observation({ accountId: OTHER, lastSuccessAt: AT, totalPages: 9, submissionsSeen: 400 }),
    observation({ accountId: OTHER, lastSuccessAt: AT, totalPages: 9, submissionsSeen: 400 }),
  ]);
  assert.deepEqual(refreshed, [false, false, false, true, false, false]);
});
