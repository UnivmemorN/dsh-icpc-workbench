/**
 * Pure natural-key and raw-rating rules (Sprint Contract 07a).
 *
 * These cases pin the domain behaviour independently of SQLite: the natural order is a literal list,
 * the encoding is collision-safe for punctuation, prefixes, leading zeros and 40-digit runs, and the
 * rating rule accepts finite numeric strings (with surrounding whitespace) while answering `null`
 * for every value that cannot be compared.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareNaturalKeys,
  naturalSortKey,
  numericRatingValue,
  numericText,
  type PlatformRating,
} from '../../src/domain/index.js';

const BIG_LOW = `${'9'.repeat(39)}7`;
const BIG_HIGH = `${'9'.repeat(39)}8`;

void test('natural keys order digit runs as integers and keep code point order elsewhere', () => {
  const ascending = ['2A', '10A', BIG_LOW, BIG_HIGH, 'A#', 'A2', 'A9', 'A10', 'E1', 'E2', 'P2', 'P10', 'Z', 'a'];
  for (let index = 0; index + 1 < ascending.length; index += 1) {
    const left = ascending[index] as string;
    const right = ascending[index + 1] as string;
    assert.ok(compareNaturalKeys(left, right) < 0, `${left} must sort before ${right}`);
    assert.ok(compareNaturalKeys(right, left) > 0, `the comparison must be antisymmetric for ${right}/${left}`);
  }
  assert.deepEqual([...ascending].reverse().sort(compareNaturalKeys), ascending);
  for (const zeroKey of ['007', '7']) {
    assert.ok(compareNaturalKeys('2A', zeroKey) < 0, `${zeroKey} is the number 7, after 2A`);
    assert.ok(compareNaturalKeys(zeroKey, '10A') < 0, `${zeroKey} is the number 7, before 10A`);
  }
  assert.equal(compareNaturalKeys('007', '7'), 0, 'leading zeros are ordering-insignificant');
  assert.equal(compareNaturalKeys('P2', 'P2'), 0);
  assert.equal(compareNaturalKeys('', '0'), -1, 'the empty key sorts first');
});

void test('the sortable encoding is collision-safe and lossless for the order it defines', () => {
  assert.notEqual(naturalSortKey('A2'), naturalSortKey('A#'));
  assert.equal(naturalSortKey('007'), naturalSortKey('7'), 'only ordering-equal keys share an encoding');
  assert.notEqual(naturalSortKey('2'), naturalSortKey('2A'));
  assert.ok(naturalSortKey(BIG_LOW) < naturalSortKey(BIG_HIGH), '40-digit runs compare exactly');
  assert.ok(naturalSortKey('2A') < naturalSortKey('10A'));
  assert.ok(naturalSortKey('A#') < naturalSortKey('A2'), 'punctuation keeps its text position beside digits');
  assert.ok(naturalSortKey('2') < naturalSortKey('2A'), 'a prefix sorts first');
  assert.equal(naturalSortKey(''), '');
  for (const key of ['2A', '10A', 'A#', 'A2', BIG_LOW, '题目']) {
    assert.equal(naturalSortKey(key), naturalSortKey(key), 'the encoding is deterministic');
  }
});

void test('raw rating values accept finite numeric strings and answer null for the rest', () => {
  assert.equal(numericText('1800'), 1800);
  assert.equal(numericText(' 1800 '), 1800, 'surrounding whitespace is not part of the number');
  assert.equal(numericText('1e3'), 1000);
  assert.equal(numericText(''), null);
  assert.equal(numericText('   '), null, 'blank is not zero');
  assert.equal(numericText('unrated'), null);
  assert.equal(numericText('Infinity'), null, 'only finite values are comparable');

  const ratings: readonly PlatformRating[] = [
    { dimension: 'Rating', value: ' 1800 ', scale: null, raw: ' 1800 ' },
    { dimension: 'difficulty', value: 7, scale: null, raw: '7' },
  ];
  assert.equal(numericRatingValue(ratings, 'rating'), 1800, 'dimension text is matched case-insensitively');
  assert.equal(numericRatingValue(ratings, ' difficulty '), 7);
  assert.equal(numericRatingValue(ratings, 'missing'), null);
  assert.equal(numericRatingValue(ratings, '   '), null);
  assert.equal(numericRatingValue(null, 'rating'), null);
  assert.equal(numericRatingValue([{ dimension: 'rating', value: Number.NaN, scale: null, raw: '' }], 'rating'), null);
  assert.equal(numericRatingValue([{ dimension: 'rating', value: 'unrated', scale: null, raw: 'unrated' }], 'rating'), null);
});
