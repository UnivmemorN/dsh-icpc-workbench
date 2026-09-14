/**
 * Display rules for platform raw tags (Sprint 21a).
 *
 * These cases drive `raw-tag-view.ts` directly: no DOM, no store, no clock and no network. They pin
 * the externally meaningful guarantees the problem page, the plan candidates and the weakness and
 * knowledge diagnostics rely on:
 *
 * - a bundled display name is added only to a strict numeric `luogu-tag:<id>` of the official Luogu
 *   deployment, so an old stored record with nothing but ids renders without reimport or rewrite;
 * - every other platform, manual, missing, mirror or wrong-host source keeps its exact stored text,
 *   and malformed, unknown or unsafe ids stay honest instead of being guessed into a name;
 * - one visible row per platform identity: an id plus the platform's exact name for it become one row
 *   that remembers both raw strings, while two distinct ids with equal names stay two rows and an
 *   ambiguous text tag is never attributed to one of them, in either input order;
 * - absent input stays absent, empty input stays empty, and no caller input is mutated.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountRawTagSource,
  isOfficialLuoguSource,
  luoguTagIdOfRaw,
  rawTagLabel,
  rawTagListView,
  rawTagSourceOf,
  rawTagUnknownIdLabel,
  type RawTagSource,
  type RawTagSourceEntry,
} from '../../src/ui/raw-tag-view.js';

/** Official Luogu deployment, as the boot catalog presents it. */
const LUOGU: RawTagSource = { platform: 'luogu', domain: 'www.luogu.com.cn' };
const LUOGU_NO_WWW: RawTagSource = { platform: 'luogu', domain: 'luogu.com.cn' };
const CODEFORCES: RawTagSource = { platform: 'codeforces', domain: 'codeforces.com' };
const MANUAL: RawTagSource = { platform: 'manual', domain: 'manual.local' };
const LUOGU_MIRROR: RawTagSource = { platform: 'luogu', domain: 'mirror.example' };

/** Boot catalog used by the source and account switching cases. */
const SOURCES: readonly RawTagSourceEntry[] = [
  { id: 'luogu:www.luogu.com.cn', platform: 'luogu', domain: 'www.luogu.com.cn' },
  { id: 'codeforces:codeforces.com', platform: 'codeforces', domain: 'codeforces.com' },
  { id: 'luogu:mirror.example', platform: 'luogu', domain: 'mirror.example' },
];

/** Synthetic dictionary with two ids sharing one name and one uniquely named id. */
const AMBIGUOUS_NAMES: ReadonlyMap<number, string> = new Map([
  [10, '同名技巧'],
  [11, '同名技巧'],
  [12, '独特技巧'],
]);

test('known Luogu ids show the official platform names of the bundled snapshot', () => {
  const list = rawTagListView(['luogu-tag:3', 'luogu-tag:7', 'luogu-tag:53'], LUOGU);
  assert.ok(list);
  assert.deepEqual(list.items.map((item) => item.label), ['动态规划 DP', '贪心', '树状数组']);
  assert.deepEqual(list.items.map((item) => item.luoguTagId), [3, 7, 53]);
  assert.deepEqual(list.items.map((item) => item.dictionaryName), [true, true, true]);
  assert.deepEqual(list.items.map((item) => item.raws), [
    ['luogu-tag:3'],
    ['luogu-tag:7'],
    ['luogu-tag:53'],
  ]);
  assert.deepEqual(list.raws, ['luogu-tag:3', 'luogu-tag:7', 'luogu-tag:53']);
  assert.equal(list.luoguSource, true);
  assert.equal(list.namedCount, 3);
  assert.equal(list.unknownIdCount, 0);
});

test('an old record with only the numeric id renders without reimport or rewrite', () => {
  const view = rawTagLabel('luogu-tag:3', LUOGU);
  assert.equal(view.label, '动态规划 DP');
  assert.equal(view.luoguTagId, 3);
  assert.equal(view.dictionaryName, true);
  assert.equal(view.unknownDictionaryId, false);
  assert.deepEqual(view.raws, ['luogu-tag:3']);
});

test('platform text tags are never guessed into an id or a name', () => {
  const list = rawTagListView(['动态规划', '动态规划 DP', 'dp'], LUOGU);
  assert.ok(list);
  // '动态规划 DP' is the snapshot name of id 3, but without the id it stays its own raw row.
  assert.deepEqual(list.items.map((item) => item.label), ['动态规划', '动态规划 DP', 'dp']);
  assert.deepEqual(list.items.map((item) => item.luoguTagId), [null, null, null]);
  assert.deepEqual(list.items.map((item) => item.raws.length), [1, 1, 1]);
  assert.equal(list.namedCount, 0);
});

test('unknown ids keep an explicit fallback label plus the exact raw string', () => {
  const list = rawTagListView(['luogu-tag:999999'], LUOGU);
  assert.ok(list);
  const [item] = list.items;
  assert.ok(item);
  assert.equal(item.label, rawTagUnknownIdLabel(999999));
  assert.equal(item.label, '洛谷标签 #999999（名称未收录）');
  assert.equal(item.luoguTagId, 999999);
  assert.equal(item.dictionaryName, false);
  assert.equal(item.unknownDictionaryId, true);
  assert.deepEqual(item.raws, ['luogu-tag:999999']);
  assert.equal(list.namedCount, 0);
  assert.equal(list.unknownIdCount, 1);
});

test('negative ids resolve only when the snapshot names them', () => {
  assert.equal(rawTagLabel('luogu-tag:-2', LUOGU).label, '语言入门');
  const unknown = rawTagLabel('luogu-tag:-999', LUOGU);
  assert.equal(unknown.label, rawTagUnknownIdLabel(-999));
  assert.equal(unknown.luoguTagId, -999);
  assert.equal(unknown.dictionaryName, false);
  assert.equal(unknown.unknownDictionaryId, true);
});

test('malformed or hostile text is displayed verbatim, never guessed', () => {
  const raws = [
    'luogu-tag:abc',
    'luogu-tag:',
    'luogu-tag: 3',
    'luogu-tag:3 ',
    'luogu-tag:3.0',
    'luogu-tag:+3',
    'luogu-tag:--3',
    'luogu-tag:٣',
    'luogu-tag:9e2',
    'luogu-tag:0x3',
    'luogu-tag:3x',
    'xluogu-tag:3',
    'Luogu-tag:3',
    'LUOGU-TAG:3',
    '',
  ];
  for (const raw of raws) {
    assert.equal(luoguTagIdOfRaw(raw), null, raw);
    const view = rawTagLabel(raw, LUOGU);
    assert.equal(view.label, raw, raw);
    assert.equal(view.luoguTagId, null, raw);
    assert.equal(view.dictionaryName, false, raw);
    assert.equal(view.unknownDictionaryId, false, raw);
    assert.deepEqual(view.raws, [raw], raw);
  }
});

test('only a strict lowercase decimal id is recognised', () => {
  assert.equal(luoguTagIdOfRaw('luogu-tag:3'), 3);
  assert.equal(luoguTagIdOfRaw('luogu-tag:-2'), -2);
  assert.equal(luoguTagIdOfRaw('luogu-tag:03'), 3);
  assert.equal(luoguTagIdOfRaw('luogu-tag:0'), 0);
  assert.equal(luoguTagIdOfRaw('动态规划 DP'), null);
});

test('ids beyond safe integers are neither named nor reported as a known id', () => {
  assert.equal(luoguTagIdOfRaw('luogu-tag:9007199254740993'), null);
  assert.equal(luoguTagIdOfRaw('luogu-tag:99999999999999999999'), null);
  const view = rawTagLabel('luogu-tag:9007199254740993', LUOGU);
  assert.equal(view.label, 'luogu-tag:9007199254740993');
  assert.equal(view.luoguTagId, null);
  assert.equal(view.unknownDictionaryId, false);
});

test('names resolve only on the official Luogu deployment', () => {
  assert.equal(isOfficialLuoguSource(LUOGU), true);
  assert.equal(isOfficialLuoguSource(LUOGU_NO_WWW), true);
  assert.equal(isOfficialLuoguSource({ platform: 'luogu', domain: '  WWW.LUOGU.COM.CN ' }), true);
  assert.equal(isOfficialLuoguSource({ platform: 'luogu', domain: 'mirror.luogu.com.cn' }), false);
  assert.equal(isOfficialLuoguSource({ platform: 'luogu', domain: 'luogu.com.cn.evil.example' }), false);
  assert.equal(isOfficialLuoguSource({ platform: 'luogu', domain: 'www.luogu.com.cn.' }), false);
  assert.equal(isOfficialLuoguSource({ platform: 'luogu', domain: null }), false);
  assert.equal(isOfficialLuoguSource({ platform: 'codeforces', domain: 'luogu.com.cn' }), false);
  assert.equal(isOfficialLuoguSource(MANUAL), false);
  assert.equal(isOfficialLuoguSource(null), false);
  assert.equal(isOfficialLuoguSource(undefined), false);
});

test('a non-Luogu, manual or missing source keeps every raw string', () => {
  for (const source of [CODEFORCES, MANUAL, LUOGU_MIRROR, null, undefined] as const) {
    const view = rawTagLabel('luogu-tag:3', source);
    assert.equal(view.label, 'luogu-tag:3');
    assert.equal(view.luoguTagId, null);
    assert.equal(view.dictionaryName, false);
    assert.equal(view.unknownDictionaryId, false);
  }
  const list = rawTagListView(['luogu-tag:3'], CODEFORCES);
  assert.ok(list);
  assert.equal(list.luoguSource, false);
  assert.deepEqual(list.items.map((item) => item.label), ['luogu-tag:3']);
  assert.equal(list.namedCount, 0);
});

test('absent input stays absent and empty input stays empty', () => {
  assert.equal(rawTagListView(null, LUOGU), null);
  assert.equal(rawTagListView(undefined, LUOGU), null);
  const empty = rawTagListView([], LUOGU);
  assert.ok(empty);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.raws, []);
  assert.equal(empty.luoguSource, true);
  assert.equal(empty.namedCount, 0);
  assert.equal(empty.unknownIdCount, 0);
  const blanks = rawTagListView(['', '   ', '\t'], LUOGU);
  assert.ok(blanks);
  assert.deepEqual(blanks.items, []);
  assert.deepEqual(blanks.raws, []);
});

test('an id and the platform exact name become one row in either input order', () => {
  const idFirst = rawTagListView(['luogu-tag:3', '动态规划 DP'], LUOGU);
  assert.ok(idFirst);
  assert.equal(idFirst.items.length, 1);
  const [first] = idFirst.items;
  assert.ok(first);
  assert.equal(first.label, '动态规划 DP');
  assert.equal(first.luoguTagId, 3);
  assert.equal(first.dictionaryName, true);
  assert.deepEqual(first.raws, ['luogu-tag:3', '动态规划 DP']);
  assert.deepEqual(idFirst.raws, ['luogu-tag:3', '动态规划 DP']);

  const nameFirst = rawTagListView(['动态规划 DP', 'luogu-tag:3'], LUOGU);
  assert.ok(nameFirst);
  assert.equal(nameFirst.items.length, 1);
  const [second] = nameFirst.items;
  assert.ok(second);
  assert.equal(second.label, '动态规划 DP');
  assert.equal(second.luoguTagId, 3);
  assert.deepEqual(second.raws, ['动态规划 DP', 'luogu-tag:3']);
  assert.deepEqual(nameFirst.raws, ['动态规划 DP', 'luogu-tag:3']);
});

test('duplicate spellings of one identity stay one row with both raw strings', () => {
  const list = rawTagListView(['luogu-tag:3', 'luogu-tag:03', 'luogu-tag:3'], LUOGU);
  assert.ok(list);
  assert.equal(list.items.length, 1);
  const [item] = list.items;
  assert.ok(item);
  assert.equal(item.luoguTagId, 3);
  assert.deepEqual(item.raws, ['luogu-tag:3', 'luogu-tag:03']);
  assert.deepEqual(list.raws, ['luogu-tag:3', 'luogu-tag:03']);
});

test('a text tag is not merged into a name no row owns exactly', () => {
  const list = rawTagListView(['dp', 'luogu-tag:3'], LUOGU);
  assert.ok(list);
  assert.deepEqual(list.items.map((item) => item.label), ['dp', '动态规划 DP']);
  assert.deepEqual(list.items.map((item) => item.raws), [['dp'], ['luogu-tag:3']]);
});

test('two distinct ids with the same name keep their own identity', () => {
  const list = rawTagListView(['luogu-tag:10', 'luogu-tag:11'], LUOGU, AMBIGUOUS_NAMES);
  assert.ok(list);
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items.map((item) => item.label), ['同名技巧', '同名技巧']);
  assert.deepEqual(list.items.map((item) => item.luoguTagId), [10, 11]);
  assert.deepEqual(list.items.map((item) => item.raws), [['luogu-tag:10'], ['luogu-tag:11']]);
  assert.equal(list.namedCount, 2);
  assert.deepEqual(list.raws, ['luogu-tag:10', 'luogu-tag:11']);
});

test('an ambiguous text tag is never attributed to one of two equal names', () => {
  const orders = [
    ['同名技巧', 'luogu-tag:10', 'luogu-tag:11'],
    ['luogu-tag:10', 'luogu-tag:11', '同名技巧'],
    ['luogu-tag:10', '同名技巧', 'luogu-tag:11'],
  ] as const;
  for (const raws of orders) {
    const list = rawTagListView(raws, LUOGU, AMBIGUOUS_NAMES);
    assert.ok(list);
    assert.equal(list.items.length, 3, raws.join(','));
    assert.equal(list.items.filter((item) => item.luoguTagId === null).length, 1, raws.join(','));
    assert.equal(list.items.filter((item) => item.luoguTagId === 10).length, 1, raws.join(','));
    assert.equal(list.items.filter((item) => item.luoguTagId === 11).length, 1, raws.join(','));
    assert.deepEqual(list.items.map((item) => item.raws.length), [1, 1, 1], raws.join(','));
  }
});

test('a uniquely named id still merges with its exact text tag in the same map', () => {
  const idFirst = rawTagListView(['luogu-tag:12', '独特技巧'], LUOGU, AMBIGUOUS_NAMES);
  assert.ok(idFirst);
  assert.equal(idFirst.items.length, 1);
  const [row] = idFirst.items;
  assert.ok(row);
  assert.equal(row.luoguTagId, 12);
  assert.deepEqual(row.raws, ['luogu-tag:12', '独特技巧']);

  const nameFirst = rawTagListView(['独特技巧', 'luogu-tag:12'], LUOGU, AMBIGUOUS_NAMES);
  assert.ok(nameFirst);
  assert.equal(nameFirst.items.length, 1);
  assert.equal(nameFirst.items[0]?.luoguTagId, 12);
});

test('an injected names map fully replaces the bundled snapshot', () => {
  assert.equal(rawTagLabel('luogu-tag:10', LUOGU, AMBIGUOUS_NAMES).label, '同名技巧');
  const missing = rawTagLabel('luogu-tag:53', LUOGU, AMBIGUOUS_NAMES);
  assert.equal(missing.label, rawTagUnknownIdLabel(53));
  assert.equal(missing.unknownDictionaryId, true);
});

test('a source instance is looked up by its stable id only', () => {
  const entry = rawTagSourceOf('luogu:www.luogu.com.cn', SOURCES);
  assert.ok(entry);
  assert.equal(entry.platform, 'luogu');
  assert.equal(entry.domain, 'www.luogu.com.cn');
  assert.equal(isOfficialLuoguSource(entry), true);
  assert.equal(rawTagSourceOf('luogu:mirror.example', SOURCES)?.domain, 'mirror.example');
  assert.equal(rawTagSourceOf(null, SOURCES), null);
  assert.equal(rawTagSourceOf(undefined, SOURCES), null);
  assert.equal(rawTagSourceOf('', SOURCES), null);
  assert.equal(rawTagSourceOf('luogu:gone.example', SOURCES), null);
});

test('account switching scopes which platform dictionary may name rows', () => {
  const accounts = [
    { id: 'luogu-acct', sourceInstanceId: 'luogu:www.luogu.com.cn' },
    { id: 'cf-acct', sourceInstanceId: 'codeforces:codeforces.com' },
  ] as const;
  const luoguSource = accountRawTagSource('luogu-acct', accounts, SOURCES);
  assert.equal(luoguSource?.platform, 'luogu');
  assert.equal(luoguSource?.domain, 'www.luogu.com.cn');
  assert.equal(accountRawTagSource('cf-acct', accounts, SOURCES)?.platform, 'codeforces');
  assert.equal(accountRawTagSource(null, accounts, SOURCES), null);
  assert.equal(accountRawTagSource('', accounts, SOURCES), null);
  assert.equal(accountRawTagSource('nobody', accounts, SOURCES), null);
  assert.equal(
    accountRawTagSource('luogu-acct', [{ id: 'luogu-acct', sourceInstanceId: 'luogu:gone.example' }], SOURCES),
    null,
  );
  assert.equal(accountRawTagSource('luogu-acct', accounts, []), null);
  const mirrorOnly = accountRawTagSource(
    'luogu-acct',
    [{ id: 'luogu-acct', sourceInstanceId: 'luogu:mirror.example' }],
    SOURCES,
  );
  assert.equal(isOfficialLuoguSource(mirrorOnly), false);

  const underLuogu = rawTagListView(['luogu-tag:7'], luoguSource);
  const underCodes = rawTagListView(['luogu-tag:7'], accountRawTagSource('cf-acct', accounts, SOURCES));
  assert.ok(underLuogu);
  assert.deepEqual(underLuogu.items.map((item) => item.label), ['贪心']);
  assert.ok(underCodes);
  assert.deepEqual(underCodes.items.map((item) => item.label), ['luogu-tag:7']);
});

test('no caller input is mutated', () => {
  const raws = Object.freeze(['luogu-tag:3', '动态规划 DP', '', 'luogu-tag:3', 'luogu-tag:999999']);
  const before = [...raws];
  const injected = new Map<number, string>([
    [3, '动态规划 DP'],
    [999999, '注入名称'],
  ]);
  const injectedBefore = [...injected.entries()];
  const sources = Object.freeze(SOURCES.map((entry) => Object.freeze({ ...entry })));

  const list = rawTagListView(raws, LUOGU, injected);
  rawTagLabel('luogu-tag:3', LUOGU, injected);
  accountRawTagSource('luogu-acct', [{ id: 'luogu-acct', sourceInstanceId: 'luogu:www.luogu.com.cn' }], sources);

  assert.ok(list);
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.raws, ['luogu-tag:3', '动态规划 DP', 'luogu-tag:999999']);
  assert.deepEqual([...raws], before);
  assert.deepEqual([...injected.entries()], injectedBefore);
});
