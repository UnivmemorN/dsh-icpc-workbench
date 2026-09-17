/**
 * Reading rules of the tag-review page (Sprint 33A).
 *
 * These cases drive the pure helpers of `review-view.ts` directly: no DOM, no React, no store, no
 * clock and no network. They pin the guarantees the page depends on — every blocked reason has its
 * own Chinese explanation that says nothing was created and no model will run, a batch without
 * runnable jobs offers no start, a batch that carries its own material blocker offers neither start
 * nor resume, the raw English code stays in the diagnostic area, and the recovery action is never
 * described as a way to fix material.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MATERIALS_BLOCKED_CODE,
  MATERIALS_BLOCKED_TEXT,
  MATERIAL_ACTION_HINT_TEXT,
  MATERIAL_ACTION_TEXT,
  MATERIAL_BLOCKED_ACTIONS,
  MATERIAL_BLOCKED_REASONS,
  MATERIAL_BLOCKED_REASON_TEXT,
  MATERIAL_BLOCKS_NOTICE_TEXT,
  NO_RUNNABLE_BATCH_TEXT,
  PREPARED_BLOCKED_ELSEWHERE_TEXT,
  RECOVER_HINT_TEXT,
  REVIEW_SCOPE_LOADING_TEXT,
  batchStartState,
  blockedCountText,
  blockedProblemRows,
  blockedRows,
  diagnosticText,
  failureCodeOf,
  materialActionText,
  materialBlockedText,
  materialBlocksOf,
  prepareSummary,
  preparedBlockedRows,
  preparedStartState,
  problemLabel,
  reviewMaterialScope,
} from '../../src/ui/review-view.js';
import { refreshMaterialProblemKeys } from '../../src/ui/material-batch-view.js';
import type {
  ModelBatchBlockedProblemView,
  ModelBatchDetailResult,
  ModelBatchPrepareResult,
} from '../../src/application/model-operation-types.js';

/** Minimal prepare answer; every member the page reads is real, nothing else is invented. */
function prepareResult(
  overrides: {
    readonly batchId?: string | null;
    readonly jobs?: readonly { readonly jobId: string; readonly snapshotId: string; readonly problemKey: string }[];
    readonly alreadyDone?: number;
    readonly reruns?: number;
    readonly blocked?: readonly ModelBatchBlockedProblemView[];
    readonly availability?: { readonly ready: number; readonly absent: number; readonly error: number };
    readonly upperBoundCalls?: { readonly analysisCalls: number; readonly reasoningCalls: number; readonly blocked: number };
  } = {},
): ModelBatchPrepareResult {
  const jobs = overrides.jobs ?? [];
  const blocked = overrides.blocked ?? [];
  return {
    batchId: overrides.batchId === undefined ? (jobs.length > 0 ? 'batch-1' : null) : overrides.batchId,
    settingsRevision: 1,
    provider: 'deepseek-official',
    models: { analysis: 'deepseek-flash', verification: 'deepseek-flash', reasoning: 'deepseek-flash' },
    limits: { maxAnalysisCalls: 50, maxReasoningCalls: 5, concurrency: 2 },
    upperBoundCalls: overrides.upperBoundCalls ?? {
      analysisCalls: jobs.length > 0 ? 50 : 0,
      reasoningCalls: jobs.length > 0 ? 5 : 0,
      blocked: blocked.length,
    },
    availability: overrides.availability ?? {
      ready: jobs.length,
      absent: 0,
      error: blocked.length,
    },
    jobs,
    alreadyDone: Array.from({ length: overrides.alreadyDone ?? 0 }, (_, index) => ({
      jobId: `job-${index}`,
      snapshotId: `snapshot-${index}`,
      status: 'succeeded' as const,
      analysisId: null,
      completeness: 'current' as const,
    })),
    reruns: Array.from({ length: overrides.reruns ?? 0 }, (_, index) => ({
      jobId: `rerun-${index}`,
      snapshotId: `snapshot-${index}`,
      previousJobId: `previous-${index}`,
      previousStatus: 'succeeded' as const,
      reason: 'reanalyze_requested' as const,
    })),
    blocked,
  };
}

function detailResult(
  materialBlocks: readonly ModelBatchBlockedProblemView[],
  status = 'pending',
): ModelBatchDetailResult {
  return {
    batch: {
      batchId: 'batch-1',
      status: status as ModelBatchDetailResult['batch']['status'],
      createdAt: '2027-01-05T08:00:00.000Z',
      updatedAt: '2027-01-05T08:00:00.000Z',
      maxJobs: 20,
      limits: { maxAnalysisCalls: 50, maxReasoningCalls: 5, concurrency: 2 },
      counters: { analysisCalls: 0, reasoningCalls: 0, retries: 0 },
      uncertainAttempts: 0,
      lastErrorCode: null,
      materialBlocks,
      jobs: [],
    },
    operation: null,
  };
}

const materialMissing: ModelBatchBlockedProblemView = {
  problemKey: 'codeforces%3Acodeforces.com||1234A',
  reason: 'material_missing',
  action: 'refresh_materials',
};

const editorialUnknown: ModelBatchBlockedProblemView = {
  problemKey: 'codeforces%3Acodeforces.com||1234B',
  reason: 'editorial_unknown',
  action: 'refresh_materials',
};

/** One stored detail whose own batch id is explicit, so a stale answer is representable. */
function detailOf(
  batchId: string,
  materialBlocks: readonly ModelBatchBlockedProblemView[],
): ModelBatchDetailResult {
  const detail = detailResult(materialBlocks);
  return { ...detail, batch: { ...detail.batch, batchId } };
}

// ---------------------------------------------------------------------------------------
// The Chinese explanations
// ---------------------------------------------------------------------------------------

void test('every blocked reason has its own Chinese explanation that promises no task and no call', () => {
  assert.equal(MATERIAL_BLOCKED_REASONS.length, 6);
  const texts = new Set<string>();
  for (const reason of MATERIAL_BLOCKED_REASONS) {
    const text = MATERIAL_BLOCKED_REASON_TEXT[reason];
    assert.equal(typeof text, 'string');
    // Each sentence states the free outcome explicitly, in Chinese, with no English code.
    assert.ok(text.includes('未建立任务'), `${reason} must say no task was created`);
    assert.ok(text.includes('不会调用模型'), `${reason} must say no model will be called`);
    assert.equal(/[a-z_]{4,}/.test(text), false, `${reason} must not expose an English code`);
    texts.add(text);
  }
  // Six distinct explanations: "unknown" and "empty" must never be described the same way.
  assert.equal(texts.size, MATERIAL_BLOCKED_REASONS.length);
  assert.equal(MATERIAL_BLOCKED_REASON_TEXT.editorial_unknown.includes('无法判断题解是否存在'), true);
  assert.equal(MATERIAL_BLOCKED_REASON_TEXT.editorial_empty.includes('没有可供分析的题解正文'), true);
  assert.equal(MATERIAL_BLOCKED_REASON_TEXT.source_unavailable.includes('不能据此认定没有题解'), true);
  assert.equal(MATERIAL_BLOCKED_REASON_TEXT.missing_statement.includes('题面为空'), true);
  assert.equal(MATERIAL_BLOCKED_REASON_TEXT.snapshot_unreadable.includes('无法读取'), true);
});

void test('an unknown reason code still renders a real Chinese instruction', () => {
  for (const reason of ['brand_new_reason', '']) {
    const text = materialBlockedText(reason);
    assert.equal(text, MATERIALS_BLOCKED_TEXT);
    assert.ok(text.includes('重新免费准备批次'));
  }
  for (const action of MATERIAL_BLOCKED_ACTIONS) {
    assert.ok(MATERIAL_ACTION_TEXT[action].includes('不调用 AI'), `${action} must be advertised as free`);
  }
  assert.equal(materialActionText('brand_new_action'), MATERIAL_ACTION_TEXT.refresh_materials);
});

// ---------------------------------------------------------------------------------------
// Start and resume
// ---------------------------------------------------------------------------------------

void test('no prepared batch means nothing can be started', () => {
  assert.deepEqual(preparedStartState(null), {
    canStart: false,
    canResume: false,
    materialReasons: [],
    needsNewBatch: false,
  });
  // A batch id without a job (or a job list without a batch id) is never startable.
  assert.equal(preparedStartState(prepareResult({ batchId: 'batch-empty', jobs: [] })).canStart, false);
  assert.equal(preparedStartState(prepareResult({ batchId: null })).canStart, false);
  assert.equal(preparedStartState(prepareResult({ jobs: [{ jobId: 'j', snapshotId: 's', problemKey: 'k' }] })).canStart, true);
});

void test('a batch that carries its own material blocker can be neither started nor continued', () => {
  const detail = detailResult([editorialUnknown]);
  const pending = batchStartState(detail.batch, false);
  assert.equal(pending.canStart, false);
  assert.equal(pending.canResume, false);
  assert.equal(pending.needsNewBatch, true);
  assert.deepEqual(pending.materialReasons, ['editorial_unknown']);

  // The same blocker on a paused and on a failed batch: the resume button is refused as well.
  for (const status of ['paused', 'failed']) {
    const state = batchStartState(detailResult([editorialUnknown], status).batch, false);
    assert.equal(state.canResume, false, `${status} must not be resumable while material is blocked`);
    assert.equal(state.needsNewBatch, true);
  }
});

void test('a normal pending batch with no blocker can be started, and a paused one continued', () => {
  const pending = batchStartState(detailResult([], 'pending').batch, false);
  assert.equal(pending.canStart, true);
  assert.equal(pending.canResume, false);
  assert.deepEqual(pending.materialReasons, []);
  assert.equal(pending.needsNewBatch, false);

  for (const status of ['paused', 'failed']) {
    const state = batchStartState(detailResult([], status).batch, false);
    assert.equal(state.canStart, false);
    assert.equal(state.canResume, true);
  }
  // A live run, a finished batch and a missing batch are not startable either.
  assert.equal(batchStartState(detailResult([], 'pending').batch, true).canStart, false);
  assert.equal(batchStartState(detailResult([], 'running').batch, false).canStart, false);
  assert.equal(batchStartState(detailResult([], 'completed').batch, false).canStart, false);
  assert.equal(batchStartState(detailResult([], 'cancelled').batch, false).canResume, false);
  assert.equal(batchStartState(null, false).canStart, false);
});

void test('a batch answer without the material preflight field is treated as having no blocks', () => {
  const legacy = detailResult([]);
  const withoutField = { ...legacy, batch: { ...legacy.batch } };
  delete (withoutField.batch as { materialBlocks?: unknown }).materialBlocks;
  assert.deepEqual(materialBlocksOf(withoutField.batch), []);
  assert.equal(batchStartState(withoutField.batch, false).canStart, true);
});

// ---------------------------------------------------------------------------------------
// The preparation summary
// ---------------------------------------------------------------------------------------

void test('the summary keeps runnable jobs, skips, reruns and blocked material as four numbers', () => {
  const summary = prepareSummary(
    prepareResult({
      jobs: [{ jobId: 'j1', snapshotId: 's1', problemKey: 'k1' }],
      alreadyDone: 2,
      reruns: 1,
      blocked: [materialMissing, editorialUnknown],
      availability: { ready: 1, absent: 0, error: 2 },
      upperBoundCalls: { analysisCalls: 50, reasoningCalls: 5, blocked: 2 },
    }),
  );
  assert.deepEqual(summary, {
    runnableJobs: 1,
    alreadyDone: 2,
    reruns: 1,
    blocked: 2,
    ready: 1,
    absent: 0,
    error: 2,
    analysisCalls: 50,
    reasoningCalls: 5,
    empty: false,
  });
  // A blocked problem is never counted as new work, and the bound covers only real jobs.
  assert.equal(summary.blocked !== summary.runnableJobs, true);
  assert.ok(blockedCountText(2).includes('材料待处理 2'));
  assert.ok(blockedCountText(2).includes('不占用调用上限'));
});

void test('an entirely blocked preparation is reported as creating no runnable batch', () => {
  const summary = prepareSummary(prepareResult({ blocked: [materialMissing, editorialUnknown] }));
  assert.equal(summary.empty, true);
  assert.equal(summary.runnableJobs, 0);
  assert.equal(summary.analysisCalls, 0);
  assert.equal(summary.reasoningCalls, 0);
  assert.ok(NO_RUNNABLE_BATCH_TEXT.includes('未创建可运行批次'));
  assert.ok(NO_RUNNABLE_BATCH_TEXT.includes('不会产生费用'));
  assert.equal(preparedStartState(prepareResult({ blocked: [materialMissing] })).canStart, false);
});

// ---------------------------------------------------------------------------------------
// Wording boundaries
// ---------------------------------------------------------------------------------------

void test('the recovery action is never described as a material repair', () => {
  assert.ok(RECOVER_HINT_TEXT.includes('只处理'));
  assert.ok(RECOVER_HINT_TEXT.includes('不会刷新、补充或修复任何材料'));
  // The blocked notice tells the user to prepare a *new* batch, never to continue the old one.
  assert.ok(MATERIAL_BLOCKS_NOTICE_TEXT.includes('重新免费准备批次'));
  assert.ok(MATERIAL_BLOCKS_NOTICE_TEXT.includes('不能被原地修复'));
  assert.equal(/继续(付费分析|该批次|旧批次)/.test(MATERIAL_BLOCKS_NOTICE_TEXT), false);
  assert.ok(MATERIAL_ACTION_HINT_TEXT.includes('刷新或补充材料'));
  assert.ok(MATERIAL_ACTION_HINT_TEXT.includes('重新免费准备批次'));
});

void test('the raw platform error code is only ever framed as diagnostic information', () => {
  const diagnostic = diagnosticText(MATERIALS_BLOCKED_CODE);
  assert.ok(diagnostic.includes('诊断信息'));
  assert.ok(diagnostic.includes(MATERIALS_BLOCKED_CODE));
  // The primary sentence is Chinese and code-free.
  assert.equal(MATERIALS_BLOCKED_TEXT.includes(MATERIALS_BLOCKED_CODE), false);
  assert.ok(MATERIALS_BLOCKED_TEXT.includes('重新免费准备批次'));
  assert.ok(MATERIALS_BLOCKED_TEXT.includes('旧批次不会产生新的模型调用'));
});

void test('blocked rows carry the problem label, the Chinese text and its free action', () => {
  const rows = blockedRows(detailResult([materialMissing, editorialUnknown]));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => ({ reason: row.reason, action: row.action })),
    [
      { reason: 'material_missing', action: 'refresh_materials' },
      { reason: 'editorial_unknown', action: 'refresh_materials' },
    ],
  );
  assert.equal(rows[0]?.text, MATERIAL_BLOCKED_REASON_TEXT.material_missing);
  assert.equal(rows[0]?.actionText, MATERIAL_ACTION_TEXT.refresh_materials);
  assert.equal(problemLabel(rows[0]!.problemKey), '1234A');
  assert.equal(problemLabel('plain-key'), 'plain-key');
  assert.deepEqual(blockedRows(null), []);
  assert.deepEqual(blockedRows({ batch: { ...detailResult([]).batch, materialBlocks: [] }, operation: null }), []);
});

void test('a failed request exposes its code without becoming the page message', () => {
  assert.equal(failureCodeOf({ code: 'materials_blocked', status: 409 }), 'materials_blocked');
  assert.equal(failureCodeOf(new Error('boom')), null);
  assert.equal(failureCodeOf(null), null);
  assert.equal(failureCodeOf({ code: 42 }), null);
  assert.equal(MATERIALS_BLOCKED_CODE, 'materials_blocked');
});

// ---------------------------------------------------------------------------------------
// Blocked rows belong to exactly one batch (Sprint 34B1)
// ---------------------------------------------------------------------------------------

void test('only the selected batch contributes blocked rows, even while a changed detail loads', () => {
  const preparedA = prepareResult({ batchId: 'batch-A', blocked: [materialMissing] });
  const detailA = detailOf('batch-A', [materialMissing, editorialUnknown]);
  const detailB = detailOf('batch-B', [editorialUnknown]);

  // Matching A: preparation and stored detail describe the same batch, so both sources are used and
  // the row they share is de-duplicated instead of being listed twice.
  const matching = reviewMaterialScope({
    selectedBatchId: 'batch-A',
    prepared: preparedA,
    detail: detailA,
    detailPending: false,
  });
  assert.deepEqual(
    { fromPrepared: matching.fromPrepared, fromStored: matching.fromStored, loading: matching.loading },
    { fromPrepared: true, fromStored: true, loading: false },
  );
  assert.deepEqual(matching.rows.map((row) => row.problemKey), [
    materialMissing.problemKey,
    editorialUnknown.problemKey,
  ]);
  assert.equal(matching.rows.length, 2, 'the shared row is de-duplicated, never listed twice');
  assert.deepEqual(refreshMaterialProblemKeys(matching.rows).keys, [
    materialMissing.problemKey,
    editorialUnknown.problemKey,
  ]);

  // Prepare A, then select B: only B's own stored rows remain; A's prepared row is never merged in.
  const selectedB = reviewMaterialScope({
    selectedBatchId: 'batch-B',
    prepared: preparedA,
    detail: detailB,
    detailPending: false,
  });
  assert.equal(selectedB.fromPrepared, false);
  assert.equal(selectedB.fromStored, true);
  assert.deepEqual(selectedB.rows.map((row) => row.problemKey), [editorialUnknown.problemKey]);
  assert.deepEqual(refreshMaterialProblemKeys(selectedB.rows).keys, [editorialUnknown.problemKey]);

  // While B's detail is still loading the page may still hold A's detail: it contributes nothing, so
  // no row of the previous selection stays displayed or actionable under B.
  const loadingB = reviewMaterialScope({
    selectedBatchId: 'batch-B',
    prepared: preparedA,
    detail: detailA,
    detailPending: true,
  });
  assert.equal(loadingB.loading, true);
  assert.equal(loadingB.fromPrepared, false);
  assert.equal(loadingB.fromStored, false);
  assert.deepEqual(loadingB.rows, []);
  assert.equal(refreshMaterialProblemKeys(loadingB.rows).ready, false);
  assert.match(REVIEW_SCOPE_LOADING_TEXT, /不会显示上一个批次的行/);

  // Nothing selected: nothing is shown, whatever the page still holds.
  const none = reviewMaterialScope({
    selectedBatchId: null,
    prepared: preparedA,
    detail: detailA,
    detailPending: false,
  });
  assert.deepEqual(
    { rows: none.rows, loading: none.loading, fromPrepared: none.fromPrepared, fromStored: none.fromStored },
    { rows: [], loading: false, fromPrepared: false, fromStored: false },
  );

  // A preparation that created no batch has no batch identity to match, so its rows are never used
  // for a selected batch and cannot replace or remove that batch's own rows.
  const noBatch = prepareResult({ batchId: null, blocked: [materialMissing] });
  const notPrepared = reviewMaterialScope({
    selectedBatchId: 'batch-A',
    prepared: noBatch,
    detail: detailA,
    detailPending: false,
  });
  assert.equal(notPrepared.fromPrepared, false);
  assert.equal(notPrepared.fromStored, true);
  assert.deepEqual(notPrepared.rows.map((row) => row.problemKey), [
    materialMissing.problemKey,
    editorialUnknown.problemKey,
  ]);
});

void test('a row from another batch never supplies the reason or action of the selected one', () => {
  // The same problem key is blocked in both batches, for different reasons: only the selected batch's
  // own reason may reach the page, so two batches cannot be conflated by their keys alone.
  const preparedA = prepareResult({ batchId: 'batch-A', blocked: [{ ...materialMissing, reason: 'material_missing' }] });
  const detailB = detailOf('batch-B', [{ ...materialMissing, reason: 'editorial_unknown' }]);
  const selectedB = reviewMaterialScope({
    selectedBatchId: 'batch-B',
    prepared: preparedA,
    detail: detailB,
    detailPending: false,
  });
  assert.equal(selectedB.rows.length, 1);
  assert.equal(selectedB.rows[0]?.reason, 'editorial_unknown');
  assert.equal(selectedB.rows[0]?.text, MATERIAL_BLOCKED_REASON_TEXT.editorial_unknown);

  // A hand-supplied row is a local write, so it is displayed but never becomes a platform refresh.
  const supplementOnly: ModelBatchBlockedProblemView = {
    problemKey: 'codeforces%3Acodeforces.com||9Z',
    reason: 'editorial_empty',
    action: 'supplement_editorial',
  };
  const scope = reviewMaterialScope({
    selectedBatchId: 'batch-B',
    prepared: null,
    detail: detailOf('batch-B', [supplementOnly]),
    detailPending: false,
  });
  assert.equal(scope.rows.length, 1);
  assert.equal(scope.rows[0]?.actionText, MATERIAL_ACTION_TEXT.supplement_editorial);
  assert.deepEqual(refreshMaterialProblemKeys(scope.rows).keys, []);
  assert.equal(refreshMaterialProblemKeys(scope.rows).ready, false);
});

void test('the preparation result rows show only while that preparation own batch is selected', () => {
  const preparedA = prepareResult({ batchId: 'batch-A', blocked: [materialMissing] });
  assert.deepEqual(preparedBlockedRows(preparedA, 'batch-A').map((row) => row.problemKey), [
    materialMissing.problemKey,
  ]);
  // Selecting another stored batch hides them instead of lending them to it.
  assert.deepEqual(preparedBlockedRows(preparedA, 'batch-B'), []);
  assert.deepEqual(preparedBlockedRows(preparedA, null), []);
  assert.match(PREPARED_BLOCKED_ELSEWHERE_TEXT, /属于另一个批次/);
  assert.match(PREPARED_BLOCKED_ELSEWHERE_TEXT, /重新免费准备/);

  // A preparation that created no batch is shown exactly while no batch is selected; with a stored
  // batch selected it stays hidden, because its rows belong to no selected batch.
  const allBlocked = prepareResult({ batchId: null, blocked: [materialMissing] });
  assert.equal(preparedBlockedRows(allBlocked, null).length, 1);
  assert.deepEqual(preparedBlockedRows(allBlocked, 'batch-B'), []);
  assert.deepEqual(preparedBlockedRows(null, 'batch-A'), []);
  assert.deepEqual(preparedBlockedRows(undefined, null), []);
  assert.deepEqual(blockedProblemRows(undefined), []);
  assert.deepEqual(blockedProblemRows(null), []);
  assert.equal(blockedProblemRows([materialMissing])[0]?.text, MATERIAL_BLOCKED_REASON_TEXT.material_missing);
});

void test('Review and the bank pin the material panel to one scope identity and mix no batch rows', () => {
  const compact = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, '');
  const review = compact('../../src/ui/Review.tsx');
  // One pure helper decides the rows; the page never recombines two batches' sources by hand.
  assert.equal(
    review.includes(
      'reviewMaterialScope({selectedBatchId:batchId,prepared,detail:detail.data,detailPending:detail.pending})',
    ),
    true,
  );
  assert.equal(review.includes('preparedBlockedRows(prepared,batchId)'), true);
  assert.equal(/prepared\?\.blocked/.test(review), false);
  assert.equal(review.includes('materialBlocksOf(detail.data'), false);
  assert.equal(review.includes('blockedRows(detail.data)'), false);
  assert.equal(review.includes('prepared.blocked.map'), false);
  // The panel is keyed by the analysis batch plus the canonical ordered refresh keys, so a changed
  // scope closes/remounts it instead of letting a prior material batch stay startable under new text.
  assert.equal(review.includes('materialScopeIdentity(batchId,refreshScope.keys)'), true);
  assert.equal(
    review.includes('constpanelOpen=materialScopeOpen!==null&&materialScopeOpen===panelScope&&refreshScope.ready;'),
    true,
  );
  assert.equal(review.includes('<BulkMaterialRefreshkey={panelScope}problemKeys={refreshScope.keys}'), true);
  assert.equal(review.includes('onClick={()=>setMaterialScopeOpen(panelScope)}'), true);
  assert.equal(review.includes('onClick={()=>setMaterialScopeOpen(null)}'), true);
  // The bank panel keeps its deliberately captured scope and is keyed by that same identity.
  const bank = compact('../../src/ui/Bank.tsx');
  assert.equal(bank.includes('key={materialScopeIdentity(null,materialScope)}'), true);
});

// ---------------------------------------------------------------------------------------
// A fully blocked preparation owns the empty selection (Sprint 34B2)
// ---------------------------------------------------------------------------------------

void test('a fully blocked preparation that created no batch feeds the refresh scope of the empty selection', () => {
  // `batch.prepare` legitimately answers `batchId: null` with no jobs and a non-empty `blocked` list.
  const allBlocked = prepareResult({ batchId: null, blocked: [materialMissing, editorialUnknown] });
  const scope = reviewMaterialScope({
    selectedBatchId: null,
    prepared: allBlocked,
    detail: null,
    detailPending: false,
  });
  // The `null === null` ownership rule is what keeps this preparation usable: it is owned by the
  // empty selection the preparation itself left behind, not dropped for having no batch id.
  assert.equal(scope.fromPrepared, true);
  assert.equal(scope.fromStored, false);
  assert.equal(scope.loading, false);
  assert.deepEqual(scope.rows.map((row) => row.problemKey), [
    materialMissing.problemKey,
    editorialUnknown.problemKey,
  ]);
  // The same rows fill the platform-refresh aggregation, so the free panel stays openable.
  const refresh = refreshMaterialProblemKeys(scope.rows);
  assert.deepEqual(refresh.keys, [materialMissing.problemKey, editorialUnknown.problemKey]);
  assert.equal(refresh.total, 2);
  assert.equal(refresh.overflow, false);
  assert.equal(refresh.ready, true);
  // Only `refresh_materials` rows take part: a hand-supplied editorial or statement stays excluded.
  assert.deepEqual(
    refreshMaterialProblemKeys([
      ...scope.rows,
      { problemKey: 'codeforces%3Acodeforces.com||9Z', action: 'supplement_editorial' },
      { problemKey: 'codeforces%3Acodeforces.com||9Y', action: 'supplement_statement' },
    ]).keys,
    [materialMissing.problemKey, editorialUnknown.problemKey],
  );
  // And the page still lists those rows as belonging to the current preparation.
  assert.deepEqual(preparedBlockedRows(allBlocked, null).map((row) => row.problemKey), [
    materialMissing.problemKey,
    editorialUnknown.problemKey,
  ]);
});

void test('the null-batch preparation stays isolated from stored selections and the other way round', () => {
  const allBlocked = prepareResult({ batchId: null, blocked: [materialMissing] });
  const storedDetail = detailOf('batch-B', [editorialUnknown]);

  // Selecting a stored batch: a preparation that created no batch owns no stored selection, so it
  // contributes nothing and cannot add or remove a row of that batch's own preflight.
  const selectedStored = reviewMaterialScope({
    selectedBatchId: 'batch-B',
    prepared: allBlocked,
    detail: storedDetail,
    detailPending: false,
  });
  assert.equal(selectedStored.fromPrepared, false);
  assert.equal(selectedStored.fromStored, true);
  assert.deepEqual(selectedStored.rows.map((row) => row.problemKey), [editorialUnknown.problemKey]);
  assert.deepEqual(preparedBlockedRows(allBlocked, 'batch-B'), []);
  assert.deepEqual(refreshMaterialProblemKeys(selectedStored.rows).keys, [editorialUnknown.problemKey]);

  // A preparation that did create a batch owns no empty selection either.
  const preparedA = prepareResult({ batchId: 'batch-A', blocked: [materialMissing] });
  const none = reviewMaterialScope({
    selectedBatchId: null,
    prepared: preparedA,
    detail: null,
    detailPending: false,
  });
  assert.equal(none.fromPrepared, false);
  assert.equal(none.fromStored, false);
  assert.deepEqual(none.rows, []);
  assert.equal(refreshMaterialProblemKeys(none.rows).ready, false);

  // A null-batch preparation never lends its rows to a loading selection, and the loading sentence
  // still covers exactly that state.
  const loadingStored = reviewMaterialScope({
    selectedBatchId: 'batch-B',
    prepared: allBlocked,
    detail: null,
    detailPending: true,
  });
  assert.equal(loadingStored.loading, true);
  assert.equal(loadingStored.fromPrepared, false);
  assert.deepEqual(loadingStored.rows, []);
  assert.match(REVIEW_SCOPE_LOADING_TEXT, /不会显示上一个批次的行/);
});
