/**
 * Completion-editing view rules (Sprint Contract 23b).
 *
 * These are the pure decisions the per-problem and bulk completion editor renders or sends: the
 * honest `未标注` reading, the bounded page-selection union, draft/intent validation, preview
 * invalidation, the conflict guard, the redaction-safe retrospective prefill and the knowledge
 * picker. No DOM and no API client is involved, so the UI contract is exercised directly instead of
 * through a rendered snapshot.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RetrospectiveEditPreviewResult } from '../../src/application/retrospective-edit.js';
import type { WorkbenchProblemDetail } from '../../src/application/workbench-types.js';
import { ApiClient, ApiClientError } from '../../src/ui/api.js';
import {
  MAX_COMPLETION_EDIT_KEYS,
  UNRECORDED_MODE_LABEL,
  applyButtonText,
  completionApplyFields,
  completionDraftProblem,
  completionEditFields,
  completionIntentKey,
  completionIntentOf,
  completionModeText,
  completionPreviewIsFresh,
  completionPreviewTotals,
  completionRequestStillCurrent,
  isCompletionConflict,
  knowledgeApplySummary,
  knowledgeNames,
  knowledgeOptions,
  pageSelectionNotice,
  parseCompletionMode,
  retrospectiveFormKey,
  retrospectiveFormState,
  unrecordedProblemKeys,
  unionPageSelection,
  type CompletionDraft,
} from '../../src/ui/completion-view.js';

test('a missing completion record is 未标注, never an implicit independent', () => {
  assert.equal(completionModeText(null), UNRECORDED_MODE_LABEL);
  assert.equal(completionModeText(undefined), UNRECORDED_MODE_LABEL);
  assert.equal(completionModeText('independent'), '独立完成');
  assert.equal(completionModeText('assisted'), '使用提示完成');
  assert.equal(completionModeText('solution_used'), '参考题解完成');
  // The select placeholder parses to `null`: no default mode is invented from an empty value.
  assert.equal(parseCompletionMode(''), null);
  assert.equal(parseCompletionMode('bogus'), null);
  assert.equal(parseCompletionMode('assisted'), 'assisted');
});

test('the draft needs an explicit mode and a non-empty knowledge list when 补充 is checked', () => {
  const empty: CompletionDraft = { mode: null, addKnowledge: false, taxonomyIds: [] };
  assert.match(completionDraftProblem(empty) ?? '', /请选择完成方式/);
  assert.equal(completionIntentOf(empty), null);

  const checkedWithoutSkills: CompletionDraft = { mode: 'assisted', addKnowledge: true, taxonomyIds: [] };
  assert.match(completionDraftProblem(checkedWithoutSkills) ?? '', /至少选择一个/);
  assert.equal(completionIntentOf(checkedWithoutSkills), null);

  assert.equal(completionDraftProblem({ mode: 'independent', addKnowledge: false, taxonomyIds: [] }), null);
});

test('knowledge is sent only as a non-empty add; preserve is sent by omission', () => {
  const preserve = completionIntentOf({ mode: 'assisted', addKnowledge: false, taxonomyIds: ['b', 'a'] });
  assert.deepEqual(preserve, { mode: 'assisted', knowledge: { kind: 'preserve' } });
  const preserveFields = completionEditFields('acc', ['k1'], preserve as NonNullable<typeof preserve>);
  // An unchecked box never submits an empty add list that could read as a requested replacement.
  assert.equal(Object.hasOwn(preserveFields, 'knowledge'), false);
  assert.deepEqual(preserveFields.problemKeys, ['k1']);

  const add = completionIntentOf({ mode: 'solution_used', addKnowledge: true, taxonomyIds: ['t2', 't1', 't2'] });
  assert.deepEqual(add?.knowledge, { kind: 'add', taxonomyIds: ['t2', 't1'] });
  const addFields = completionEditFields('acc', ['k1', 'k2'], add as NonNullable<typeof add>);
  assert.deepEqual(addFields.knowledge, { kind: 'add', taxonomyIds: ['t2', 't1'] });
});

test('a changed draft invalidates the preview so an old hash is never applied to a new intent', () => {
  const first = completionIntentOf({ mode: 'assisted', addKnowledge: false, taxonomyIds: [] });
  const second = completionIntentOf({ mode: 'independent', addKnowledge: false, taxonomyIds: [] });
  assert.ok(first !== null && second !== null);
  const preview = { accountId: 'acc', intentKey: completionIntentKey(first) };
  assert.equal(completionPreviewIsFresh(preview, 'acc', first), true);
  assert.equal(completionPreviewIsFresh(preview, 'acc', second), false);
  assert.equal(completionPreviewIsFresh(preview, 'acc', null), false);
  // A preview cannot survive a scope change either.
  assert.equal(completionPreviewIsFresh({ ...preview, accountId: 'other' }, 'acc', first), false);
  // Reordering the same checked list is not a draft change.
  const a = completionIntentOf({ mode: 'assisted', addKnowledge: true, taxonomyIds: ['t1', 't2'] });
  const b = completionIntentOf({ mode: 'assisted', addKnowledge: true, taxonomyIds: ['t2', 't1'] });
  assert.ok(a !== null && b !== null);
  assert.equal(completionIntentKey(a), completionIntentKey(b));
});

test('apply carries the previewed hash together with the intent that produced it', () => {
  const intent = completionIntentOf({ mode: 'independent', addKnowledge: false, taxonomyIds: [] });
  assert.ok(intent !== null);
  const fields = completionApplyFields('acc', ['k1', 'k2'], { hash: 'h1', intent });
  assert.equal(fields.expectedPreviewHash, 'h1');
  assert.equal(fields.mode, 'independent');
  assert.deepEqual(fields.problemKeys, ['k1', 'k2']);
  assert.equal(Object.hasOwn(fields, 'knowledge'), false);
});

test('a result is committed only while its request is still current', () => {
  assert.equal(completionRequestStillCurrent({ aborted: false }), true);
  assert.equal(completionRequestStillCurrent({ aborted: true }), false);
});

test('page selection unions under 100 and reports skipped rows instead of dropping them', () => {
  const selected = Array.from({ length: 99 }, (_, index) => 's' + index);
  const outcome = unionPageSelection(selected, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(outcome.keys.length, MAX_COMPLETION_EDIT_KEYS);
  assert.equal(outcome.added, 1);
  assert.equal(outcome.skipped, 3);
  assert.match(pageSelectionNotice(outcome) ?? '', /另有 3 题未加入选择/);

  const overlap = unionPageSelection(['p1', 'a'], ['p1', 'p2']);
  assert.deepEqual(overlap.keys, ['p1', 'a', 'p2']);
  assert.equal(overlap.added, 1);
  assert.equal(overlap.skipped, 0);
  assert.equal(pageSelectionNotice(overlap), null);
});

test('only records with a null mode count as 未标注 for the 选择本页未标注 action', () => {
  assert.deepEqual(
    unrecordedProblemKeys([
      { problemKey: 'a', mode: null },
      { problemKey: 'b', mode: 'independent' },
      { problemKey: 'c', mode: null },
    ]),
    ['a', 'c'],
  );
});

test('the preview states changed/no-op counts and how many solution references an independent edit clears', () => {
  const preview: RetrospectiveEditPreviewResult = {
    accountId: 'acc',
    mode: 'independent',
    previewHash: 'h',
    changedCount: 2,
    unchangedCount: 1,
    items: [
      {
        problemKey: 'a',
        title: 'A',
        previousMode: 'assisted',
        nextMode: 'independent',
        changed: true,
        existingTaxonomyCount: 1,
        addedTaxonomyIds: ['t1'],
        clearedSolutionCount: 2,
      },
      {
        problemKey: 'b',
        title: 'B',
        previousMode: null,
        nextMode: 'independent',
        changed: true,
        existingTaxonomyCount: 0,
        addedTaxonomyIds: ['t1', 't2'],
        clearedSolutionCount: 0,
      },
      {
        problemKey: 'c',
        title: 'C',
        previousMode: 'independent',
        nextMode: 'independent',
        changed: false,
        existingTaxonomyCount: 2,
        addedTaxonomyIds: [],
        clearedSolutionCount: 0,
      },
    ],
  };
  assert.deepEqual(completionPreviewTotals(preview), {
    changedCount: 2,
    unchangedCount: 1,
    clearedSolutionTotal: 2,
    // Two distinct knowledge points, added on three problem rows: `t1` is skipped on `b` because
    // that row already has it, so the union count alone would overstate the writes.
    addedSkillCount: 2,
    addedSkillTotal: 3,
  });
  assert.equal(applyButtonText(preview), '修改 2 题');
  assert.equal(applyButtonText({ ...preview, changedCount: 0, unchangedCount: 3 }), '无变化');
  assert.equal(applyButtonText(null), null);
});

test('a compare-and-set conflict from the real UI client drops the stale preview, other failures keep it', async () => {
  // The plugin maps the domain `invalid_transition` onto the transport code `conflict`; this is the
  // exact error `ui/api.ts` throws for a 409 conflict answer, not a fabricated mismatched code.
  const client = new ApiClient(async () =>
    Response.json(
      {
        apiVersion: 1,
        ok: false,
        error: { code: 'conflict', message: 'the request conflicts with the current state' },
      },
      { status: 409 },
    ),
  );
  const conflict = await client
    .request('retro.editApply', {
      accountId: 'acc',
      problemKeys: ['k1'],
      mode: 'assisted',
      expectedPreviewHash: 'h1',
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(conflict instanceof ApiClientError);
  assert.equal(conflict.code, 'conflict');
  assert.equal(conflict.status, 409);
  assert.equal(isCompletionConflict(conflict), true);

  // A raw domain error that never crossed the transport is still recognized as a conflict, and an
  // unrelated failure must leave the held preview alone so the user can retry it.
  assert.equal(isCompletionConflict({ code: 'invalid_transition' }), true);
  assert.equal(isCompletionConflict(new ApiClientError('invalid_input', 400, 'bad request')), false);
  assert.equal(isCompletionConflict(null), false);
  assert.equal(isCompletionConflict(new Error('conflict')), false);
});

/** Minimal problem detail; each test overrides only the fields it reads. */
function problemDetail(overrides: Partial<WorkbenchProblemDetail>): WorkbenchProblemDetail {
  return {
    problemKey: 'k',
    sourceInstanceId: 'src',
    domain: null,
    externalKey: '1A',
    title: 'T',
    url: 'https://example.test/1A',
    statement: null,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    rawRatings: [],
    accountId: 'acc',
    solvedByAccount: true,
    staleAnalysisCount: 0,
    snapshot: null,
    spoilersVisible: false,
    latestRetrospective: null,
    ...overrides,
  };
}

test('withheld spoiler fields stay unknown while a real empty record prefills as empty', () => {
  const withheld = retrospectiveFormState(
    problemDetail({
      spoilersVisible: false,
      latestRetrospective: {
        retrospectiveId: 'r1',
        problemKey: 'k',
        accountId: 'acc',
        mode: 'assisted',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  );
  // The record itself is known (id/mode), but the withheld fields are not turned into empty values.
  assert.equal(withheld.retrospectiveId, 'r1');
  assert.equal(withheld.mode, 'assisted');
  assert.equal(withheld.advancedKnown, false);
  assert.deepEqual(withheld.taxonomyIds, []);
  assert.deepEqual(withheld.solutionIds, []);
  assert.equal(withheld.note, '');

  const known = retrospectiveFormState(
    problemDetail({
      spoilersVisible: true,
      latestRetrospective: {
        retrospectiveId: 'r1',
        problemKey: 'k',
        accountId: 'acc',
        mode: 'assisted',
        taxonomyIds: [],
        solutionIds: [],
        note: null,
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  );
  // A genuinely empty record is editable, and it is distinguishable from "still withheld".
  assert.equal(known.advancedKnown, true);
  assert.deepEqual(known.taxonomyIds, []);
  assert.equal(known.note, '');
  assert.notEqual(withheld.advancedKnown, known.advancedKnown);
});

test('a no-record form is editable and empty once revealed, and stays behind the reveal notice when hidden', () => {
  const revealed = retrospectiveFormState(problemDetail({ spoilersVisible: true, latestRetrospective: null }));
  assert.equal(revealed.retrospectiveId, null);
  // No record keeps the explicit placeholder instead of defaulting to independent.
  assert.equal(revealed.mode, null);
  // Nothing is withheld, so the empty fields are real and can be saved.
  assert.equal(revealed.advancedKnown, true);
  assert.deepEqual(revealed.taxonomyIds, []);
  assert.deepEqual(revealed.solutionIds, []);
  assert.equal(revealed.note, '');

  const hidden = retrospectiveFormState(problemDetail({ spoilersVisible: false, latestRetrospective: null }));
  assert.equal(hidden.advancedKnown, false);
  assert.equal(hidden.mode, null);
});

test('one withheld field keeps the whole advanced prefill unknown instead of a partial editable form', () => {
  const partial = retrospectiveFormState(
    problemDetail({
      spoilersVisible: true,
      latestRetrospective: {
        retrospectiveId: 'r1',
        problemKey: 'k',
        accountId: 'acc',
        mode: 'solution_used',
        taxonomyIds: ['dp'],
        // `solutionIds` and `note` are absent: withheld, not empty.
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  );
  assert.equal(partial.retrospectiveId, 'r1');
  assert.equal(partial.mode, 'solution_used');
  assert.equal(partial.advancedKnown, false);
  // The visible half is not offered as a half-editable draft, and nothing withheld becomes empty.
  assert.deepEqual(partial.taxonomyIds, []);
  assert.deepEqual(partial.solutionIds, []);
  assert.equal(partial.note, '');
});

test('the form reset key covers problem, account and latest record id only', () => {
  assert.equal(retrospectiveFormKey('k', 'a', 'r1'), retrospectiveFormKey('k', 'a', 'r1'));
  assert.notEqual(retrospectiveFormKey('k', 'a', 'r1'), retrospectiveFormKey('k', 'a', 'r2'));
  assert.notEqual(retrospectiveFormKey('k', 'a', 'r1'), retrospectiveFormKey('k2', 'a', 'r1'));
  assert.notEqual(retrospectiveFormKey('k', 'a', 'r1'), retrospectiveFormKey('k', 'b', 'r1'));
  assert.notEqual(retrospectiveFormKey('k', 'a', 'r1'), retrospectiveFormKey('k', 'a', null));
});

test('the knowledge picker offers only non-category nodes and matches name or id', () => {
  const nodes = [
    { id: 'dp', kind: 'technique', names: { zh: '动态规划' } },
    { id: 'cat', kind: 'category', names: { zh: '算法' } },
    { id: 'greedy', kind: 'technique', names: { zh: '贪心' } },
  ];
  assert.deepEqual(
    knowledgeOptions(nodes, '').map((node) => node.id),
    ['dp', 'greedy'],
  );
  assert.deepEqual(
    knowledgeOptions(nodes, '贪').map((node) => node.id),
    ['greedy'],
  );
  assert.deepEqual(
    knowledgeOptions(nodes, 'DP').map((node) => node.id),
    ['dp'],
  );
  assert.deepEqual(knowledgeNames(['dp', 'missing'], nodes), ['动态规划', 'missing']);
  assert.equal(
    knowledgeApplySummary(3, ['dp', 'greedy'], nodes),
    '将对选中的 3 道题各补充 2 个知识点：动态规划、贪心。',
  );
  assert.equal(knowledgeApplySummary(2, [], nodes), '尚未选择知识点。');
});
