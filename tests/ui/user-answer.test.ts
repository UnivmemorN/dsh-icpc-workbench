/**
 * Reading rules of the pasted-answer panel (Sprint 12).
 *
 * These cases drive the pure helpers of `user-answer-view.ts` directly: no DOM, no React, no store,
 * no clock and no network. They pin the externally meaningful guarantees the panel relies on — the
 * editable default attribution, the exact-body request the boundary receives, the refusal of a blank
 * or oversized field and of every unsafe citation, the deterministic identity that makes an
 * identical paste reuse its snapshot while a different paste creates a new source, and the honest
 * reading of a stored provenance note (user-provided, correctness not certified, and whether the
 * linked URL is the answer's origin or only the associated problem page).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_USER_ANSWER_LABEL_CHARS,
  MAX_USER_ANSWER_TEXT_CHARS,
  USER_ANSWER_SOURCE_ID_PREFIX,
} from '../../src/application/workbench-api.js';
import { userAnswerSourceIdOf, userAnswerProvenanceNote } from '../../src/plugin/business-api.js';
import {
  DEFAULT_USER_ANSWER_SOURCE_LABEL,
  USER_ANSWER_ANALYSIS_NOTE,
  USER_ANSWER_LOCAL_ONLY_NOTE,
  USER_ANSWER_SOURCE_EXAMPLES,
  defaultUserAnswerDraft,
  isUserAnswerSource,
  safeUserAnswerUrl,
  userAnswerProvenance,
  userAnswerRequest,
  userAnswerSourceHeading,
  validateUserAnswerDraft,
} from '../../src/ui/user-answer-view.js';

const REF = { sourceInstanceId: 'codeforces:codeforces.com', domain: null, externalKey: '1234A' };
const TEXT = '先二分答案，再用前缀和 O(n) 验证。\n\n```cpp\nint main(){}\n```';
const URL = 'https://codeforces.com/blog/entry/9001';

void test('the panel starts from an editable attribution and names its examples', () => {
  assert.equal(defaultUserAnswerDraft().sourceLabel, DEFAULT_USER_ANSWER_SOURCE_LABEL);
  assert.equal(defaultUserAnswerDraft().url, '');
  assert.equal(defaultUserAnswerDraft().text, '');
  assert.deepEqual(USER_ANSWER_SOURCE_EXAMPLES, ['GPT6', '教师解析', '自己整理']);
  assert.match(USER_ANSWER_LOCAL_ONLY_NOTE, /不会调用任何模型/);
  assert.match(USER_ANSWER_LOCAL_ONLY_NOTE, /不会自动采用任何算法标签/);
  assert.match(USER_ANSWER_ANALYSIS_NOTE, /DeepSeek/);
});

void test('only an absolute http(s) URL without credentials is an accepted citation', () => {
  assert.equal(safeUserAnswerUrl(''), undefined, 'blank means no URL was declared at all');
  assert.equal(safeUserAnswerUrl('   '), undefined);
  assert.equal(safeUserAnswerUrl(undefined), undefined);
  assert.equal(safeUserAnswerUrl(URL), URL);
  assert.equal(safeUserAnswerUrl(` ${URL} `), URL, 'surrounding whitespace is not part of the link');
  assert.equal(safeUserAnswerUrl('https://codeforces.com/blog/entry/9?x=1#y'), 'https://codeforces.com/blog/entry/9?x=1#y');
  for (const unsafe of [
    'ftp://codeforces.com/blog/entry/1',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url',
    'codeforces.com/blog/entry/1',
    'https://user:pass@codeforces.com/blog/entry/1',
    'https://user@codeforces.com/blog/entry/1',
  ]) {
    assert.equal(safeUserAnswerUrl(unsafe), null, `${unsafe} must be refused`);
  }
});

void test('a draft must carry a non-blank label and body within the boundary bounds', () => {
  assert.equal(validateUserAnswerDraft(defaultUserAnswerDraft()).valid, false, 'an untouched panel cannot save');
  assert.match(validateUserAnswerDraft(defaultUserAnswerDraft()).message ?? '', /粘贴答案正文/);

  assert.equal(validateUserAnswerDraft({ ...defaultUserAnswerDraft(), text: TEXT }).valid, true);
  assert.equal(validateUserAnswerDraft({ ...defaultUserAnswerDraft(), text: TEXT, url: URL }).valid, true);

  const blankLabel = validateUserAnswerDraft({ sourceLabel: '   ', url: '', text: TEXT });
  assert.equal(blankLabel.valid, false);
  assert.match(blankLabel.message ?? '', /来源标注/);

  const longLabel = validateUserAnswerDraft({ sourceLabel: 'x'.repeat(MAX_USER_ANSWER_LABEL_CHARS + 1), url: '', text: TEXT });
  assert.equal(longLabel.valid, false);
  assert.match(longLabel.message ?? '', new RegExp(String(MAX_USER_ANSWER_LABEL_CHARS)));

  const longText = validateUserAnswerDraft({ ...defaultUserAnswerDraft(), text: 'x'.repeat(MAX_USER_ANSWER_TEXT_CHARS + 1) });
  assert.equal(longText.valid, false);
  assert.match(longText.message ?? '', new RegExp(String(MAX_USER_ANSWER_TEXT_CHARS)));

  const unsafe = validateUserAnswerDraft({ ...defaultUserAnswerDraft(), text: TEXT, url: 'javascript:alert(1)' });
  assert.equal(unsafe.valid, false);
  assert.match(unsafe.message ?? '', /http\(s\)/);
});

void test('the request body keeps the exact text, the trimmed label and only a real citation', () => {
  const withCitation = userAnswerRequest({ sourceLabel: ' GPT6 ', url: ` ${URL} `, text: TEXT });
  assert.deepEqual(withCitation, { sourceLabel: 'GPT6', text: TEXT, url: URL });

  const withoutCitation = userAnswerRequest({ sourceLabel: '教师解析', url: '   ', text: TEXT });
  assert.deepEqual(withoutCitation, { sourceLabel: '教师解析', text: TEXT });
  assert.equal(Object.hasOwn(withoutCitation ?? {}, 'url'), false, 'no URL is never replaced by the problem link here');

  const exact = userAnswerRequest({ sourceLabel: '自己整理', url: '', text: `  ${TEXT}\n` });
  assert.equal(exact?.text, `  ${TEXT}\n`, 'the body is sent verbatim, not reformatted by the panel');

  assert.equal(userAnswerRequest(defaultUserAnswerDraft()), null, 'an invalid draft produces no request at all');
  assert.equal(userAnswerRequest({ ...defaultUserAnswerDraft(), text: TEXT, url: 'data:text/html,x' }), null);
});

void test('an identical paste keeps its source identity while a different one creates a new source', () => {
  const first = userAnswerSourceIdOf(REF, 'GPT6', TEXT, URL);
  assert.equal(userAnswerSourceIdOf(REF, 'GPT6', TEXT, URL), first, 'the same content addresses the same source');
  assert.match(first, new RegExp(`^${USER_ANSWER_SOURCE_ID_PREFIX}[0-9a-f]{32}$`));
  assert.equal(isUserAnswerSource({ sourceId: first }), true);
  assert.equal(isUserAnswerSource({ sourceId: 'editorial-1' }), false);

  const variants: readonly (readonly [string, string, string | null])[] = [
    ['教师解析', TEXT, URL],
    ['GPT6', `${TEXT} `, URL],
    ['GPT6', TEXT, null],
    ['GPT6', TEXT, 'https://codeforces.com/blog/entry/9002'],
  ];
  for (const [label, text, citation] of variants) {
    assert.notEqual(userAnswerSourceIdOf(REF, label, text, citation), first, `${label} must not overwrite the first paste`);
  }
  const otherProblem = { sourceInstanceId: REF.sourceInstanceId, domain: null, externalKey: '9999Z' };
  assert.notEqual(userAnswerSourceIdOf(otherProblem, 'GPT6', TEXT, URL), first, 'identity is scoped to the problem');
});

void test('a revealed paste reports its provenance and what its link really is', () => {
  const associated = {
    sourceId: `${USER_ANSWER_SOURCE_ID_PREFIX}${'0'.repeat(32)}`,
    title: '用户提供解析（GPT6）',
    note: userAnswerProvenanceNote('GPT6',true),
  };
  const provenance = userAnswerProvenance(associated);
  assert.equal(provenance.userProvided, true);
  assert.equal(provenance.origin, 'problem', 'no supplied citation means the link is the associated problem');
  assert.match(userAnswerSourceHeading(associated), /用户提供/);
  assert.match(userAnswerSourceHeading(associated), /非官方题解/);
  assert.match(userAnswerSourceHeading(associated), /正确性未经本插件核验/);

  const cited = userAnswerProvenance({ ...associated, note: userAnswerProvenanceNote('教师解析',false) });
  assert.equal(cited.origin, 'source');
  assert.equal(userAnswerProvenance({...associated,note:userAnswerProvenanceNote('用户未提供答案出处链接',false)}).origin,'source');

  const platform = userAnswerProvenance({ sourceId: 'cf-blog-9001', note: null });
  assert.deepEqual(platform, { userProvided: false, note: null, origin: null });
  assert.equal(userAnswerSourceHeading({ sourceId: 'cf-blog-9001', title: 'Editorial 9001', note: null }), 'Editorial 9001');
});
