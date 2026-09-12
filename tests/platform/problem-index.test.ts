/**
 * Codeforces problem identity: index shape, key canonicalization, padding-sensitive numeric
 * indexes and the two official href spellings. All inputs are synthetic.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CF_PROBLEM_INDEX,
  cfProblemExternalKey,
  isOfficialCodeforcesHref,
  officialProblemPaths,
  parseCfProblemKey,
  parseOfficialProblemPath,
} from '../../src/adapters/codeforces/index.js';

test('a single letter without a numeric suffix is a valid index', () => {
  for (const index of ['A', 'a', 'Z', 'B2', 'D10', '01', '14']) {
    assert.equal(CF_PROBLEM_INDEX.test(index), true, index);
  }
  for (const index of ['', 'AA', 'A0', '92114', '1A4']) {
    assert.equal(CF_PROBLEM_INDEX.test(index), false, index);
  }
  assert.equal(cfProblemExternalKey(455, 'a'), '455A');
  assert.equal(cfProblemExternalKey(20, 'C'), '20C');
});

test('numeric index padding is preserved and never merged into the contest id', () => {
  assert.equal(cfProblemExternalKey(921, '01'), '921/01');
  assert.equal(cfProblemExternalKey(921, '14'), '921/14');
  assert.notEqual(cfProblemExternalKey(921, '01'), cfProblemExternalKey(921, '1'));
  assert.throws(() => cfProblemExternalKey(921, '92114'));
  assert.deepEqual(parseCfProblemKey('921/01'), { contestId: 921, index: '01' });
  assert.deepEqual(parseCfProblemKey('921/14'), { contestId: 921, index: '14' });
  assert.deepEqual(parseCfProblemKey('20C'), { contestId: 20, index: 'C' });
  assert.equal(parseCfProblemKey('92114'), null);
  assert.equal(parseCfProblemKey('A'), null);
});

test('official problem hrefs are exactly the four-segment official paths', () => {
  assert.deepEqual(parseOfficialProblemPath('/contest/455/problem/A'), { contestId: 455, index: 'A' });
  assert.deepEqual(parseOfficialProblemPath('/problemset/problem/921/01'), { contestId: 921, index: '01' });
  assert.deepEqual(parseOfficialProblemPath('https://codeforces.com/problemset/problem/455/A'), {
    contestId: 455,
    index: 'A',
  });
  // Legacy `http://`/`www.` spellings name the same problem (identity only).
  assert.deepEqual(parseOfficialProblemPath('http://www.codeforces.com/contest/455/problem/A'), {
    contestId: 455,
    index: 'A',
  });
  assert.equal(isOfficialCodeforcesHref('/contest/455/problem/A'), true);
  for (const bad of [
    '/contest/455/problem/A/',
    '/contest/455/problem/A/submission/1',
    '/contest/455',
    'https://codeforces.com/contest/455',
    'https://codeforces.com:8443/contest/455/problem/A',
    'https://user:secret@codeforces.com/contest/455/problem/A',
    'ftp://codeforces.com/contest/455/problem/A',
    'https://codeforces.org/contest/455/problem/A',
    'https://evil.example/contest/455/problem/A',
    '/blog/entry/455',
    '',
  ]) {
    assert.equal(parseOfficialProblemPath(bad), null, bad);
    assert.equal(isOfficialCodeforcesHref(bad), false, bad);
  }
});

test('official paths keep the numeric padding', () => {
  assert.deepEqual(officialProblemPaths(921, '01'), ['/contest/921/problem/01', '/problemset/problem/921/01']);
  assert.deepEqual(officialProblemPaths(455, 'c'), ['/contest/455/problem/C', '/problemset/problem/455/C']);
});
