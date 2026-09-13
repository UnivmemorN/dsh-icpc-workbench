/**
 * Cross-site equivalence rule (Sprint Contract 08b): pure domain behaviour.
 *
 * These cases pin the *identity* rule itself — what is recognized, what is deliberately not, and
 * that the grouping is total and stable — because every later projection (the merged page, the
 * accepted evidence, the spoiler banner) trusts it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CF_MIRROR_GROUP_KEY_PREFIX,
  CF_MIRROR_REFERENCE_EXAMPLE_URL,
  CF_MIRROR_RULE_ID,
  CODEFORCES_MAIN_INSTANCE_ID,
  LUOGU_OFFICIAL_INSTANCE_ID,
  cfMirrorIdentity,
  cfMirrorProblemKeys,
  DomainError,
  mergedGroupKeyOf,
  mergedGroupMemberKeys,
  parseMergedGroupKey,
  problemGroupingOf,
  problemKey,
  type ProblemRef,
} from '../../src/domain/index.js';

const CF = CODEFORCES_MAIN_INSTANCE_ID;
const LUOGU = LUOGU_OFFICIAL_INSTANCE_ID;

function ref(sourceInstanceId: string, externalKey: string, domain: string | null = null): ProblemRef {
  return { sourceInstanceId, domain, externalKey };
}

void test('the official Codeforces and Luogu spellings of one problem share a stable group key', () => {
  assert.equal(CF_MIRROR_REFERENCE_EXAMPLE_URL, 'https://www.luogu.com.cn/problem/CF1A');
  for (const [key, contestId, index] of [
    ['1A', 1, 'A'],
    ['2A', 2, 'A'],
    ['20C', 20, 'C'],
    ['1000F', 1000, 'F'],
    ['1B2', 1, 'B2'],
    ['1D10', 1, 'D10'],
    ['99999Z', 99999, 'Z'],
  ] as const) {
    const cf = cfMirrorIdentity(ref(CF, key));
    const luogu = cfMirrorIdentity(ref(LUOGU, `CF${key}`));
    assert.ok(cf, `${key} must be recognized`);
    assert.ok(luogu, `CF${key} must be recognized`);
    assert.equal(cf.ruleId, CF_MIRROR_RULE_ID);
    assert.equal(cf.contestId, contestId);
    assert.equal(cf.index, index);
    assert.equal(cf.cfExternalKey, key);
    assert.equal(cf.luoguExternalKey, `CF${key}`);
    assert.equal(cf.groupKey, `${CF_MIRROR_GROUP_KEY_PREFIX}${key}`);
    assert.deepEqual(luogu, cf, 'both spellings produce one identity object');
    assert.equal(mergedGroupKeyOf(ref(CF, key)), mergedGroupKeyOf(ref(LUOGU, `CF${key}`)));
    assert.equal(problemGroupingOf(ref(CF, key)).kind, CF_MIRROR_RULE_ID);
    assert.equal(problemGroupingOf(ref(LUOGU, `CF${key}`)).kind, CF_MIRROR_RULE_ID);
  }
});

void test('the identity is recognized only on the exact official instances without a domain', () => {
  for (const sourceInstanceId of [
    'codeforces:www.codeforces.com',
    'codeforces:codeforces.com:443',
    'luogu:luogu.com.cn',
    'luogu:www.luogu.com.cn.evil.example',
    'manual:codeforces.com',
    'hydro:codeforces.com',
  ]) {
    assert.equal(cfMirrorIdentity(ref(sourceInstanceId, '1A')), null, sourceInstanceId);
    assert.equal(cfMirrorIdentity(ref(sourceInstanceId, 'CF1A')), null, sourceInstanceId);
  }
  // A domain names another scope of the same instance (a gym set, a mirror namespace).
  for (const domain of ['gym', 'acmsguru', 'main']) {
    assert.equal(cfMirrorIdentity(ref(CF, '1A', domain)), null, domain);
    assert.equal(cfMirrorIdentity(ref(LUOGU, 'CF1A', domain)), null, domain);
  }
});

void test('non-canonical, numeric and foreign identifiers are never merged', () => {
  const unrecognized: readonly (readonly [string, string])[] = [
    // Case variants: never normalized into a match.
    [CF, '1a'],
    [LUOGU, 'cf1a'],
    [LUOGU, 'Cf1a'],
    // Leading zeros in the contest id.
    [CF, '01A'],
    [LUOGU, 'CF01A'],
    [CF, '0A'],
    [LUOGU, 'CF0A'],
    // Contest id out of range.
    [CF, '100000A'],
    [LUOGU, 'CF100000A'],
    // A numeric Codeforces index is a different identifier family.
    [CF, '921/01'],
    [CF, '14'],
    [LUOGU, 'CF921/01'],
    // An index needs at least one uppercase letter: a bare number is never an index.
    [CF, '1'],
    [LUOGU, 'CF1'],
    // Ordinary platform identifiers.
    [LUOGU, 'P1000'],
    [LUOGU, 'AT_abc123_a'],
    [CF, 'GYM100001A'],
    [CF, ''],
    [LUOGU, 'CF'],
  ];
  for (const [sourceInstanceId, externalKey] of unrecognized) {
    assert.equal(
      cfMirrorIdentity(ref(sourceInstanceId, externalKey)),
      null,
      `${sourceInstanceId} ${JSON.stringify(externalKey)} must not be recognized`,
    );
  }
});

void test('E1/E2 and F1/F2 stay distinct groups with their own Luogu mirrors', () => {
  const keys = ['1E1', '1E2', '1F1', '1F2'];
  const groupKeys = keys.map((key) => mergedGroupKeyOf(ref(CF, key)));
  assert.equal(new Set(groupKeys).size, keys.length, 'each index is its own group');
  for (const key of keys) {
    assert.equal(mergedGroupKeyOf(ref(LUOGU, `CF${key}`)), mergedGroupKeyOf(ref(CF, key)));
  }
  assert.notEqual(mergedGroupKeyOf(ref(CF, '1E1')), mergedGroupKeyOf(ref(LUOGU, 'CF1E2')));
});

void test('a zero-padded index suffix is its own exact identity and is never normalized', () => {
  for (const [key, index] of [
    ['1A', 'A'],
    ['1A1', 'A1'],
    ['1A0', 'A0'],
    ['1A01', 'A01'],
    ['1B0', 'B0'],
  ] as const) {
    const cf = cfMirrorIdentity(ref(CF, key));
    const luogu = cfMirrorIdentity(ref(LUOGU, `CF${key}`));
    assert.ok(cf, `${key} must be recognized`);
    assert.equal(cf.index, index, 'the suffix is preserved exactly, zeros included');
    assert.ok(luogu, `CF${key} must be recognized`);
    assert.deepEqual(luogu, cf);
    assert.equal(mergedGroupKeyOf(ref(LUOGU, `CF${key}`)), `${CF_MIRROR_GROUP_KEY_PREFIX}${key}`);
  }
  const groups = ['1A', '1A0', '1A01', '1A1', '1B0'].map((key) => mergedGroupKeyOf(ref(CF, key)));
  assert.equal(new Set(groups).size, groups.length, 'padding is part of the index, not a spelling variant');
  // Parsing keeps the exact suffix too, so a stored `merged:cf:` key round-trips.
  const parsed = parseMergedGroupKey('merged:cf:1A01');
  assert.equal(parsed.kind, CF_MIRROR_RULE_ID);
  assert.equal(parsed.kind === CF_MIRROR_RULE_ID ? parsed.identity.index : null, 'A01');
  // Case and contest-id padding are still never normalized.
  assert.equal(cfMirrorIdentity(ref(CF, '1a0')), null);
  assert.equal(cfMirrorIdentity(ref(LUOGU, 'CF1a0')), null);
  assert.equal(cfMirrorIdentity(ref(CF, '01A0')), null);
  assert.equal(cfMirrorIdentity(ref(LUOGU, 'CF01A0')), null);
});

void test('every unrecognized reference becomes its own canonical-key group', () => {
  const single = ref(LUOGU, 'P1000');
  const grouping = problemGroupingOf(single);
  assert.equal(grouping.kind, 'single');
  assert.equal(grouping.groupKey, problemKey(single));
  assert.equal(grouping.identity, null);
  // Two unrelated problems with the same title are still two groups: nothing matches by title.
  assert.notEqual(problemGroupingOf(ref(LUOGU, 'P1001')).groupKey, grouping.groupKey);
  // A recognized reference never falls back to its own key.
  assert.notEqual(problemGroupingOf(ref(CF, '1A')).groupKey, problemKey(ref(CF, '1A')));
});

void test('a group key names exactly the member keys it can have', () => {
  const cfRef = ref(CF, '1A');
  const luoguRef = ref(LUOGU, 'CF1A');
  const identity = cfMirrorIdentity(cfRef);
  assert.ok(identity);
  assert.deepEqual(cfMirrorProblemKeys(identity), [problemKey(cfRef), problemKey(luoguRef)]);
  assert.deepEqual(mergedGroupMemberKeys(identity.groupKey), [problemKey(cfRef), problemKey(luoguRef)]);

  const singleRef = ref(LUOGU, 'P1000');
  assert.deepEqual(mergedGroupMemberKeys(problemKey(singleRef)), [problemKey(singleRef)]);

  const parsed = parseMergedGroupKey(identity.groupKey);
  assert.equal(parsed.kind, CF_MIRROR_RULE_ID);
  assert.deepEqual(parsed.kind === CF_MIRROR_RULE_ID ? parsed.identity : null, identity);

  const parsedSingle = parseMergedGroupKey(problemKey(singleRef));
  assert.deepEqual(parsedSingle, { kind: 'single', problemKey: problemKey(singleRef) });
});

void test('a group key that cannot name a recognized group or a stored problem is refused', () => {
  for (const groupKey of [
    'merged:cf:1a',
    'merged:cf:01A',
    'merged:cf:100000A',
    'merged:cf:921/01',
    'merged:unknown:1A',
    'not-a-key',
    '',
  ]) {
    assert.throws(
      () => parseMergedGroupKey(groupKey),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'invalid_input');
        assert.equal(error.details['reason'], 'unknown_group_key');
        return true;
      },
      `group key ${JSON.stringify(groupKey)} must be refused`,
    );
  }
  // A canonical key of a reference the rule recognizes must be grouped by its mirror identity.
  assert.throws(
    () => parseMergedGroupKey(problemKey(ref(LUOGU, 'CF1A'))),
    (error: unknown) => error instanceof DomainError && error.details['reason'] === 'unknown_group_key',
  );
});
