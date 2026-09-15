/**
 * Luogu numeric-tag dictionary bridge (Sprint 32).
 *
 * The factual snapshot now lives in the domain taxonomy layer (`src/domain/taxonomy/
 * luogu-tag-dictionary.ts`) and the historical UI module is only a re-export of it, so the pure
 * crosswalk and every UI surface share ONE table. These cases drive the real snapshot against the
 * built-in taxonomy: the id/name pairs are unchanged, a strict official numeric id resolves through
 * exactly the same conservative name rules as its textual form, an id the snapshot does not name is
 * explicit unmapped coverage, and a mirror, a lookalike host, a foreign source or an explicit
 * vocabulary override never borrows the dictionary.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_TAXONOMY,
  TAG_MAPPING_VERSION,
  createTaxonomyIndex,
  isCountedTagRelation,
  isDeeplyFrozen,
  mapSourceTag,
  type SourceTagMapping,
} from '../../src/domain/index.js';
import {
  LUOGU_TAG_DICTIONARY,
  LUOGU_TAG_DICTIONARY_ENTRY_COUNT,
  LUOGU_TAG_DICTIONARY_RETRIEVED_AT,
  LUOGU_TAG_DICTIONARY_SOURCE_URL,
  LUOGU_TAG_NAME_BY_ID,
} from '../../src/domain/taxonomy/luogu-tag-dictionary.js';
import * as uiDictionary from '../../src/ui/luogu-tag-dictionary.js';

const INDEX = createTaxonomyIndex(CURRENT_TAXONOMY);
const LUOGU = 'luogu:www.luogu.com.cn';
const LUOGU_BARE = 'luogu:luogu.com.cn';
const CF = 'codeforces:codeforces.com';
const DICTIONARY_URL = 'https://www.luogu.com.cn/_lfe/tags';

function map(
  raw: string,
  sourceInstanceId: string = LUOGU,
  vocabulary?: SourceTagMapping['vocabulary'],
): SourceTagMapping {
  return vocabulary === undefined
    ? mapSourceTag(INDEX, { raw, sourceInstanceId })
    : mapSourceTag(INDEX, { raw, sourceInstanceId, vocabulary });
}

void test('the factual snapshot is unchanged and the UI module re-exports the very same table', () => {
  assert.equal(LUOGU_TAG_DICTIONARY_ENTRY_COUNT, 505);
  assert.equal(LUOGU_TAG_DICTIONARY.length, LUOGU_TAG_DICTIONARY_ENTRY_COUNT);
  assert.equal(LUOGU_TAG_NAME_BY_ID.size, LUOGU_TAG_DICTIONARY_ENTRY_COUNT);
  assert.equal(LUOGU_TAG_DICTIONARY_SOURCE_URL, DICTIONARY_URL);
  assert.equal(LUOGU_TAG_DICTIONARY_RETRIEVED_AT, '2026-09-14');

  const ids = new Set<number>();
  for (const [id, name] of LUOGU_TAG_DICTIONARY) {
    assert.equal(Number.isSafeInteger(id), true, `entry id ${String(id)} must be a safe integer`);
    assert.equal(ids.has(id), false, `id ${id} appears twice`);
    ids.add(id);
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0, `id ${id} needs a platform name`);
    assert.equal(LUOGU_TAG_NAME_BY_ID.get(id), name, 'the lookup form mirrors the pair table');
  }
  assert.equal(LUOGU_TAG_NAME_BY_ID.get(-2), '语言入门', 'negative platform ids are preserved');
  assert.equal(LUOGU_TAG_NAME_BY_ID.get(3), '动态规划 DP');
  assert.equal(LUOGU_TAG_NAME_BY_ID.get(53), '树状数组');
  assert.equal(LUOGU_TAG_NAME_BY_ID.get(110), '\uFEFF基础算法', 'entry 110 keeps the payload U+FEFF verbatim');
  assert.equal(LUOGU_TAG_NAME_BY_ID.get(542), '入门赛');

  // The UI path is the same binding, not a second copy: one table feeds the crosswalk and the view.
  assert.equal(uiDictionary.LUOGU_TAG_DICTIONARY, LUOGU_TAG_DICTIONARY);
  assert.equal(uiDictionary.LUOGU_TAG_NAME_BY_ID, LUOGU_TAG_NAME_BY_ID);
  assert.equal(uiDictionary.LUOGU_TAG_DICTIONARY_SOURCE_URL, LUOGU_TAG_DICTIONARY_SOURCE_URL);
  assert.equal(uiDictionary.LUOGU_TAG_DICTIONARY_RETRIEVED_AT, LUOGU_TAG_DICTIONARY_RETRIEVED_AT);
  assert.equal(uiDictionary.LUOGU_TAG_DICTIONARY_ENTRY_COUNT, LUOGU_TAG_DICTIONARY_ENTRY_COUNT);
});

void test('every dictionary entry bridges to exactly the rules its textual name gets', () => {
  for (const [id, name] of LUOGU_TAG_DICTIONARY) {
    const raw = `luogu-tag:${id}`;
    const bridged = map(raw, LUOGU);
    const direct = map(name, LUOGU);
    assert.equal(bridged.vocabulary, 'luogu');
    assert.notEqual(bridged.relation, 'reference', `${raw} must not stay a silent platform reference`);
    assert.equal(bridged.relation, direct.relation, `${raw} (${name}) relation differs from its text form`);
    assert.deepEqual(bridged.targetIds, direct.targetIds, `${raw} (${name}) targets differ from its text form`);
    assert.deepEqual(bridged.candidateIds, direct.candidateIds, `${raw} (${name}) candidates differ`);
    assert.equal(
      bridged.ruleId === `luogu.tag-id.${id}.${direct.ruleId}` ||
        bridged.ruleId === `luogu.tag-id.${id}.${direct.ruleId}.missing-target`,
      true,
      `${raw} rule id must chain the dictionary resolution and the name rule (${bridged.ruleId})`,
    );
    assert.equal(bridged.explanation.includes(raw), true, `${raw} keeps its raw id in the explanation`);
    assert.equal(bridged.explanation.includes(name), true, `${raw} keeps its platform name in the explanation`);
    assert.equal(bridged.referenceUrls.includes(DICTIONARY_URL), true, `${raw} cites the official dictionary`);
    assert.equal(bridged.mappingVersion, TAG_MAPPING_VERSION);
    assert.equal(bridged.raw, raw, 'the exact raw label is preserved');
    assert.equal(bridged.sourceInstanceId, LUOGU);
    assert.equal(isDeeplyFrozen(bridged), true);
    for (const taxonomyId of [...bridged.targetIds, ...bridged.candidateIds]) {
      assert.equal(INDEX.has(taxonomyId), true, `${raw} produced an unknown node ${taxonomyId}`);
    }
    if (isCountedTagRelation(bridged.relation)) {
      assert.ok(bridged.targetIds.length > 0, `${raw} is counted and therefore needs a live target`);
    }
  }
});

void test('known techniques and categories resolve to their own node, unknown names stay unmapped', () => {
  const bit = map('luogu-tag:53', LUOGU);
  assert.equal(bit.relation, 'exact');
  assert.deepEqual(bit.targetIds, ['data-structure.bit']);

  const dp = map('luogu-tag:3', LUOGU);
  assert.equal(dp.relation, 'broader');
  assert.deepEqual(dp.targetIds, ['dp'], 'the dictionary category name only counts to the dp category');
  assert.deepEqual(dp.candidateIds, []);

  // A platform name no existing conservative rule maps stays an honest gap, never a guessed node.
  const unmappedName = map('luogu-tag:133', LUOGU);
  assert.equal(unmappedName.relation, 'unmapped');
  assert.equal(unmappedName.explanation.includes('Dancing Links'), true);
  assert.equal(unmappedName.ruleId.startsWith('luogu.tag-id.133.'), true, 'the dictionary step is named');

  // The resolution is one step: a rule id is an ordinary label, never a numeric id again.
  assert.equal(map(unmappedName.ruleId, LUOGU).relation, 'unmapped');
  for (const [id, name] of LUOGU_TAG_DICTIONARY) {
    assert.doesNotMatch(name, /^luogu-tag:-?\d+$/u, `entry ${id} must not itself look like a numeric id`);
  }
});

void test('mirrors, lookalike hosts, foreign sources and explicit vocabulary borrow nothing', () => {
  const mirror = map('luogu-tag:53', 'luogu:m.luogu.com.cn');
  assert.equal(mirror.vocabulary, 'luogu', 'a Luogu mirror still has the Luogu vocabulary');
  assert.equal(mirror.relation, 'reference', 'but its numeric ids keep the unchanged platform reference');
  assert.equal(mirror.ruleId, 'luogu.numeric-tag-id');
  assert.deepEqual(mirror.targetIds, []);
  assert.equal(mirror.explanation.includes('树状数组'), false, 'a mirror never borrows an official name');
  assert.equal(mirror.referenceUrls.includes(DICTIONARY_URL), false);

  const alternatePort = map('luogu-tag:53', 'luogu:www.luogu.com.cn%3A8443');
  assert.equal(alternatePort.vocabulary, 'luogu');
  assert.equal(alternatePort.relation, 'reference', 'an alternate deployment does not borrow the official dictionary');
  assert.deepEqual(alternatePort.targetIds, []);
  assert.equal(alternatePort.explanation.includes('树状数组'), false);

  const lookalike = map('luogu-tag:53', 'luogu:www.luogu.com.cn.evil.example');
  assert.equal(lookalike.vocabulary, 'unknown', 'a lookalike host fails closed before every rule');
  assert.deepEqual(lookalike.targetIds, []);
  assert.deepEqual(lookalike.candidateIds, []);
  assert.equal(lookalike.explanation.includes('树状数组'), false);
  assert.deepEqual(lookalike.referenceUrls, []);

  const explicit = map('luogu-tag:53', CF, 'luogu');
  assert.equal(explicit.vocabulary, 'luogu', 'the explicit vocabulary still selects the Luogu rules');
  assert.equal(explicit.relation, 'reference', 'but a foreign source instance borrows no dictionary name');
  assert.deepEqual(explicit.targetIds, []);
  assert.equal(explicit.explanation.includes('树状数组'), false);
  assert.equal(explicit.referenceUrls.includes(DICTIONARY_URL), false);

  const foreign = map('luogu-tag:53', CF);
  assert.equal(foreign.vocabulary, 'codeforces');
  assert.equal(foreign.relation, 'unmapped');
  assert.deepEqual(foreign.targetIds, []);
  assert.equal(foreign.explanation.includes('树状数组'), false);

  // Both official instance ids bridge; nothing else does.
  assert.deepEqual(map('luogu-tag:53', LUOGU).targetIds, ['data-structure.bit']);
  assert.deepEqual(map('luogu-tag:53', LUOGU_BARE).targetIds, ['data-structure.bit']);
});

void test('the bridge is deterministic, frozen and keeps platform data distinguishable', () => {
  const first = map('luogu-tag:53', LUOGU);
  assert.deepEqual(map('luogu-tag:53', LUOGU), first);
  assert.equal(isDeeplyFrozen(first), true);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'the mapping stays JSON-serializable');
  assert.equal(first.explanation.includes('“树状数组”'), true, 'the platform name is quoted as platform data');
});
