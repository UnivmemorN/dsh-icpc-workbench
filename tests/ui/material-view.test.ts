/**
 * Reading rules of one problem's material refresh (Sprint 33B).
 *
 * These cases drive the pure helpers of `material-view.ts` directly: no DOM, no React, no store, no
 * clock and no network. They pin the guarantee the material panel depends on — a *skipped*
 * equivalent-problem reuse is explained as a decision of this run and never as "the other site has
 * no editorial", and a real reuse names the exact Codeforces problem it was based on so the pairing
 * can be checked instead of believed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIRROR_SKIP_REASON_TEXT,
  MIRROR_SKIP_UNKNOWN_TEXT,
  materialAliasLinks,
  materialAliasSummary,
  mirrorReuseView,
  parseMaterialAliasEvidence,
} from '../../src/ui/material-view.js';

void test('a fetched reuse names the exact equivalent problem and says the statement stayed put', () => {
  const view = mirrorReuseView({ status: 'fetched', skippedReason: null, key: '1900A' }, 'found');
  assert.equal(view.reused, true);
  assert.equal(view.key, '1900A');
  assert.ok(view.text.includes('1900A'));
  assert.ok(view.text.includes('官方 tutorial'));
  // The statement's own source never changes, and the sentence must say so.
  assert.ok(view.text.includes('题面仍来自洛谷'));
});

void test('a consulted mirror with an operational failure never claims tutorial reuse', () => {
  for (const status of ['unavailable', 'rate_limited', 'changed_response', 'auth_required', 'forbidden']) {
    const view = mirrorReuseView({ status: 'fetched', skippedReason: null, key: '1900A' }, status);
    assert.equal(view.reused, false);
    assert.equal(view.key, '1900A');
    assert.ok(view.text.includes('已请求'));
    assert.ok(view.text.includes('本次未获得可用题解'));
    assert.equal(view.text.includes('作为本题的题解材料'), false);
  }
});

void test('every skip reason has its own Chinese explanation that claims nothing about the other site', () => {
  for (const reason of Object.keys(MIRROR_SKIP_REASON_TEXT)) {
    const view = mirrorReuseView({ status: 'skipped', skippedReason: reason, key: null });
    assert.equal(view.reused, false);
    assert.equal(view.text, MIRROR_SKIP_REASON_TEXT[reason]);
    // None of them may assert that Codeforces has no editorial.
    assert.equal(/没有题解(?!，)/.test(view.text) && !view.text.includes('不代表'), false, `${reason} must not conclude absence`);
  }
  assert.equal(MIRROR_SKIP_REASON_TEXT.mirror_not_applicable?.includes('不是官方洛谷 CF 镜像题'), true);
  assert.equal(MIRROR_SKIP_REASON_TEXT.cf_source_unavailable?.includes('没有可用的官方 Codeforces 来源'), true);
  assert.equal(MIRROR_SKIP_REASON_TEXT.existing_editorial_reusable?.includes('没有请求 Codeforces'), true);
});

void test('an unknown or absent reuse member still renders a real explanation', () => {
  const unknownReason = mirrorReuseView({ status: 'skipped', skippedReason: 'brand_new_reason', key: null });
  assert.equal(unknownReason.reused, false);
  assert.equal(unknownReason.text, MIRROR_SKIP_UNKNOWN_TEXT);
  assert.ok(unknownReason.text.includes('不代表 Codeforces 没有题解'));

  for (const missing of [null, undefined]) {
    const view = mirrorReuseView(missing);
    assert.equal(view.reused, false);
    assert.equal(view.key, null);
    assert.ok(view.text.length > 0, 'a missing member must still explain itself');
  }
});

void test('a fetched reuse without a key still reads as a reuse rather than as a skip', () => {
  const view = mirrorReuseView({ status: 'fetched', skippedReason: null, key: null }, 'found');
  assert.equal(view.reused, true);
  assert.equal(view.key, null);
  assert.ok(view.text.includes('官方 tutorial'));
});

// ---------------------------------------------------------------------------------------
// Shared-round evidence (Sprint 33B1)
// ---------------------------------------------------------------------------------------

/** The note the Codeforces adapter writes for one shared-round redirect. */
const ALIAS_NOTE = 'cf-editorial-alias-v1; requested=879E; section=878C; blog=55435; method=official_division_pair';

void test('the shared-round evidence is read from the stored note and says which problem answered', () => {
  const evidence = parseMaterialAliasEvidence(ALIAS_NOTE);
  assert.ok(evidence);
  assert.equal(evidence.requestedKey, '879E');
  assert.equal(evidence.sectionKey, '878C');
  assert.equal(evidence.blogId, 55435);
  assert.equal(evidence.method, 'official_division_pair');
  // The page states the mapping as the requested problem's own claim, in one line.
  assert.equal(materialAliasSummary(evidence), '已按官方共享赛题映射：879E → 878C');
});

void test('the expandable evidence links both official problems and the official blog', () => {
  const evidence = parseMaterialAliasEvidence(ALIAS_NOTE);
  assert.ok(evidence);
  assert.deepEqual(materialAliasLinks(evidence), {
    requestedUrl: 'https://codeforces.com/problemset/problem/879/E',
    sectionUrl: 'https://codeforces.com/problemset/problem/878/C',
    blogUrl: 'https://codeforces.com/blog/entry/55435',
  });
  // A numeric index keeps its `/` separator, so the URL addresses the padded problem it names.
  const padded = materialAliasLinks({
    requestedKey: '921/01',
    sectionKey: '922/02',
    blogId: 7,
    method: 'official_division_pair',
  });
  assert.equal(padded.requestedUrl, 'https://codeforces.com/problemset/problem/921/01');
  assert.equal(padded.sectionUrl, 'https://codeforces.com/problemset/problem/922/02');
});

void test('an ordinary or malformed note never claims a shared-round mapping', () => {
  // An ordinary section note: no marker, so the page shows the source without an alias claim.
  assert.equal(parseMaterialAliasEvidence('section 455A of blog 9001'), null);
  assert.equal(parseMaterialAliasEvidence(null), null);
  assert.equal(parseMaterialAliasEvidence(undefined), null);
  assert.equal(parseMaterialAliasEvidence(''), null);
  // A marker without the fields it needs is treated as absent, never half-parsed.
  assert.equal(parseMaterialAliasEvidence('cf-editorial-alias-v1; requested=879E'), null);
  assert.equal(parseMaterialAliasEvidence('cf-editorial-alias-v1; requested=879E; section=878C; blog=abc'), null);
  // A note that also carries an adapter suffix still parses: the fields are read by name.
  const withSuffix = parseMaterialAliasEvidence(`${ALIAS_NOTE} | section 878C of blog 55435`);
  assert.equal(withSuffix?.sectionKey, '878C');
  // A note from a *later* rule version is still read, so an old page keeps explaining itself.
  assert.equal(parseMaterialAliasEvidence('cf-editorial-alias-v1; requested=1A; section=1B; blog=1; method=x')?.method, 'x');
});

void test('the mirror sentence and the shared-round sentence are separate claims', () => {
  // A Luogu target can carry both, and neither may be dropped or merged into the other.
  const mirror = mirrorReuseView({ status: 'fetched', skippedReason: null, key: '879E' }, 'found');
  const evidence = parseMaterialAliasEvidence(ALIAS_NOTE);
  assert.ok(evidence);
  assert.ok(mirror.text.includes('879E'));
  assert.ok(mirror.text.includes('题面仍来自洛谷'));
  assert.ok(materialAliasSummary(evidence).includes('879E → 878C'));
  assert.equal(mirror.text.includes('878C'), false, 'the mirror claim must not absorb the section mapping');
});
