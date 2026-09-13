/**
 * Merged-bank display rules (Sprint Contract 08c).
 *
 * These are the pure decisions `MergedBank.tsx` renders: which member leads a group (so the visible
 * ID agrees with the order the backend sorted by), which stored account represents which platform,
 * and how the combined banner and the per-member badges are phrased so a linked cross-site solve can
 * never be read as this platform's own verdict. No DOM and no API client is involved, so the UI
 * contract is exercised directly instead of through a string snapshot.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account, SourceInstance } from '../../src/domain/index.js';
import {
  DEFAULT_MERGED_SORT,
  accountLabelOf,
  commitDimensionDraft,
  detailKeyOf,
  evidenceHasLocalMetadata,
  evidenceTextOf,
  mappingText,
  memberBadgeText,
  memberOrder,
  mergedSolvedText,
  mergedSortDisabled,
  nativeSolvedText,
  normalizeMergedSort,
  platformRatingDimension,
  ratingTextOf,
  selectedAccountOfSource,
  setSourceAccount,
  sourceAccountOptions,
  sourceLabelOf,
  MERGED_DIMENSION_BLANK_WARNING,
  MERGED_DIMENSION_TOO_LONG_WARNING,
} from '../../src/ui/merged.js';

const CF: SourceInstance = {
  id: 'codeforces:codeforces.com',
  platform: 'codeforces',
  baseUrl: 'https://codeforces.com',
  domain: 'codeforces.com',
  displayName: 'Codeforces',
};
const LUOGU: SourceInstance = {
  id: 'luogu:www.luogu.com.cn',
  platform: 'luogu',
  baseUrl: 'https://www.luogu.com.cn',
  domain: 'www.luogu.com.cn',
  displayName: '洛谷',
};
const HYDRO: SourceInstance = {
  id: 'hydro:hydro.example.edu',
  platform: 'hydro',
  baseUrl: 'https://hydro.example.edu',
  domain: 'hydro.example.edu',
  displayName: 'HydroOJ (hydro.example.edu)',
};

function account(source: SourceInstance, handle: string, displayName: string | null = null): Account {
  return {
    id: source.id + '|' + handle,
    sourceInstanceId: source.id,
    handle,
    displayName,
    profileUrl: null,
  };
}

const ALICE = account(CF, 'alice');
const BOB = account(LUOGU, 'bob', 'Bob 洛谷');
const CAROL = account(LUOGU, 'carol');

/** One member shape the ordering rules accept; `problemKey` is the canonical key of that member. */
function member(source: SourceInstance, externalKey: string, problemKey = source.id + '|null|' + externalKey) {
  return {
    problem: {
      problemKey,
      sourceInstanceId: source.id,
      externalKey,
      title: externalKey + ' title',
      url: source.baseUrl + '/problem/' + externalKey,
      fetchedAt: '2024-05-01T00:00:00.000Z',
      domain: null,
      rawRatings: [] as readonly { dimension: string; value: number | string; scale: null; raw: string }[],
      solvedByAccount: false,
      pendingReview: null,
    },
    accountId: null as string | null,
  };
}

void test('a group lists the member the backend sorted by first', () => {
  const cf = member(CF, '1A');
  const luogu = member(LUOGU, 'CF1A');
  // Without a source filter the backend compares the least canonical problem key, which is the
  // Codeforces spelling of a recognized pair.
  assert.deepEqual(
    memberOrder([luogu, cf], null).map((entry) => entry.problem.externalKey),
    ['1A', 'CF1A'],
  );
  // With a source filter it compares that source's own member in BOTH sort directions, so a
  // descending title/ID order must still be read from the leading row the user sees.
  assert.deepEqual(
    memberOrder([luogu, cf], LUOGU.id).map((entry) => entry.problem.externalKey),
    ['CF1A', '1A'],
  );
  assert.deepEqual(
    memberOrder([cf, luogu], LUOGU.id).map((entry) => entry.problem.externalKey),
    ['CF1A', '1A'],
  );
  // Every member keeps its identity: nothing is dropped, renamed or collapsed into the other row.
  assert.equal(memberOrder([luogu, cf], null).length, 2);
});

void test('distinct canonical index suffixes stay distinct members', () => {
  // The domain recognizes `A0` and `A01` as exact, different identities; the display order must not
  // normalize, trim or deduplicate them.
  const a0 = member(CF, '1A0');
  const a01 = member(CF, '1A01');
  assert.deepEqual(
    memberOrder([a01, a0], null).map((entry) => entry.problem.externalKey),
    ['1A0', '1A01'],
  );
});

void test('the account scope is at most one account per source instance', () => {
  const stored = [ALICE, BOB, CAROL];
  assert.deepEqual(setSourceAccount([ALICE.id], stored, LUOGU.id, BOB.id), [ALICE.id, BOB.id]);
  // Selecting another account of the SAME source replaces it instead of double-counting one person.
  assert.deepEqual(setSourceAccount([ALICE.id, BOB.id], stored, LUOGU.id, CAROL.id), [ALICE.id, CAROL.id]);
  // `不参与统计` clears only that source.
  assert.deepEqual(setSourceAccount([ALICE.id, BOB.id], stored, LUOGU.id, null), [ALICE.id]);
  assert.deepEqual(setSourceAccount([ALICE.id], stored, LUOGU.id, CAROL.id), [ALICE.id, CAROL.id]);
  // An id no stored account explains is kept: the read refuses it, so dropping it here would
  // silently change the meaning of the query.
  assert.deepEqual(setSourceAccount(['stale-account'], stored, LUOGU.id, BOB.id), ['stale-account', BOB.id]);
  assert.equal(selectedAccountOfSource([ALICE.id, BOB.id], stored, LUOGU.id), BOB.id);
  assert.equal(selectedAccountOfSource([ALICE.id], stored, LUOGU.id), '');
});

void test('account options name every source, including one with no stored account', () => {
  const options = sourceAccountOptions([CF, LUOGU, HYDRO], [CAROL, ALICE, BOB]);
  assert.deepEqual(
    options.map((entry) => [entry.source.id, entry.accounts.map((item) => item.handle)]),
    [
      [CF.id, ['alice']],
      [LUOGU.id, ['bob', 'carol']],
      [HYDRO.id, []],
    ],
  );
  assert.equal(accountLabelOf(BOB.id, [ALICE, BOB], [CF, LUOGU]), '洛谷 · Bob 洛谷');
  assert.equal(accountLabelOf(ALICE.id, [ALICE, BOB], [CF, LUOGU]), 'Codeforces · alice');
  // An unknown account is named as unknown instead of being guessed or silently dropped.
  assert.match(accountLabelOf('missing', [ALICE], [CF]), /^未知账号/u);
  assert.equal(sourceLabelOf(LUOGU.id, [CF, LUOGU]), '洛谷');
  assert.match(sourceLabelOf('hydro:gone', [CF]), /^未知来源/u);
});

void test('the combined banner never impersonates a platform verdict', () => {
  assert.equal(mergedSolvedText(2, true), '已通过');
  assert.equal(mergedSolvedText(2, false), '所选账号未确认通过');
  assert.equal(mergedSolvedText(0, false), '未选择统计账号');
  // The native detail says `本平台`, so it cannot contradict a linked `关联题目已通过` badge.
  assert.equal(nativeSolvedText(true, ALICE.id), '本平台已通过');
  assert.equal(nativeSolvedText(false, ALICE.id), '本平台尚未确认通过');
  assert.equal(nativeSolvedText(false, null), '未选择本平台账号');
  assert.equal(memberBadgeText(true, true), '本平台已通过');
  assert.equal(memberBadgeText(false, true), '关联题目已通过');
  assert.equal(memberBadgeText(false, false), '本平台状态未知');
});

void test('a recognized one-member group never implies a second local row', () => {
  assert.equal(mappingText('luogu_cf_identifier', 1), '按 CF 原题编号关联（另一平台暂无本地记录）');
  assert.equal(mappingText('luogu_cf_identifier', 2), '按 CF 原题编号关联（两站各有一条本地记录）');
  assert.match(mappingText('single', 1), /^未识别到跨站对应/u);
});

void test('difficulty sorting needs a concrete source and falls back when it is cleared', () => {
  assert.equal(mergedSortDisabled('difficulty_asc', null), true);
  assert.equal(mergedSortDisabled('difficulty_desc', null), true);
  assert.equal(mergedSortDisabled('difficulty_asc', LUOGU.id), false);
  assert.equal(mergedSortDisabled('problem_asc', null), false);
  assert.equal(normalizeMergedSort('difficulty_desc', null), DEFAULT_MERGED_SORT);
  assert.equal(normalizeMergedSort('difficulty_desc', LUOGU.id), 'difficulty_desc');
  assert.equal(normalizeMergedSort('title_desc', null), 'title_desc');
  assert.equal(platformRatingDimension('codeforces'), 'rating');
  assert.equal(platformRatingDimension('luogu'), 'difficulty');
  assert.equal(platformRatingDimension('hydro'), null);
});

void test('a refused difficulty dimension keeps the previous committed value', () => {
  assert.deepEqual(commitDimensionDraft('  rating ', 'difficulty'), {
    dimension: 'rating',
    draft: 'rating',
    warning: null,
    changed: true,
  });
  assert.deepEqual(commitDimensionDraft('rating', 'rating'), {
    dimension: 'rating',
    draft: 'rating',
    warning: null,
    changed: false,
  });
  assert.deepEqual(commitDimensionDraft('   ', 'rating'), {
    dimension: 'rating',
    draft: 'rating',
    warning: MERGED_DIMENSION_BLANK_WARNING,
    changed: false,
  });
  assert.deepEqual(commitDimensionDraft('x'.repeat(101), 'rating'), {
    dimension: 'rating',
    draft: 'rating',
    warning: MERGED_DIMENSION_TOO_LONG_WARNING,
    changed: false,
  });
  assert.equal(commitDimensionDraft('x'.repeat(100), 'rating').changed, true);
});

void test('evidence is shown with its account, identifier and time, with or without local metadata', () => {
  const cf = member(CF, '1A');
  const evidence = {
    accountId: ALICE.id,
    problemKey: cf.problem.problemKey,
    sourceInstanceId: CF.id,
    externalKey: '1A',
    submissionId: 'submission-1',
    submittedAt: '2023-08-01T10:00:00.000Z',
  };
  assert.equal(
    evidenceTextOf(evidence, [ALICE], [CF]),
    'Codeforces · alice · 1A · 2023-08-01T10:00:00.000Z',
  );
  assert.equal(evidenceHasLocalMetadata([cf], evidence), true);
  // An accepted submission whose problem has no stored metadata row is still real evidence: the
  // caller shows it and explains that the local bank has no metadata for it.
  assert.equal(
    evidenceHasLocalMetadata([cf], { ...evidence, problemKey: 'codeforces:codeforces.com|null|9Z' }),
    false,
  );
});

void test('raw difficulty stays per dimension and per member', () => {
  assert.equal(
    ratingTextOf({
      ...member(CF, '1A').problem,
      rawRatings: [{ dimension: 'rating', value: 1500, scale: null, raw: '1500' }],
    }),
    'rating: 1500',
  );
  assert.equal(ratingTextOf(member(CF, '1A').problem), '未提供');
  // The detail key changes with the native account, so switching member or account remounts it.
  assert.equal(detailKeyOf('key', ALICE.id), 'key|' + ALICE.id);
  assert.equal(detailKeyOf('key', null), 'key|no-account');
});
