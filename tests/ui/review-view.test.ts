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
  RECOVER_HINT_TEXT,
  batchStartState,
  blockedCountText,
  blockedRows,
  diagnosticText,
  failureCodeOf,
  materialActionText,
  materialBlockedText,
  materialBlocksOf,
  prepareSummary,
  preparedStartState,
  problemLabel,
} from '../../src/ui/review-view.js';
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
