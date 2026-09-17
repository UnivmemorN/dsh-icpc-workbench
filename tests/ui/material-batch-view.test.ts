/**
 * Bulk platform-material refresh UI rules (Sprint Contract 34B).
 *
 * These cases drive the pure helpers of `material-batch-view.ts` and the typed browser transport
 * directly: no DOM, no React, no store, no clock and no live platform read. They pin the guarantees
 * the reusable panel depends on — every batch/item status and every failure code has its own Chinese
 * wording that never claims an absence, a confirmed completed `absent` stays distinguishable from an
 * operational failure, the start/cancel/retry/poll gates are honest in all five batch states, the
 * `refresh_materials` aggregation filters and refuses to overflow silently, the bank preparation
 * keeps the selection order with `fetchStatement: true`, and the review wording demands a new free
 * analysis preparation instead of any automatic paid action.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MAX_MATERIAL_REFRESH_BATCH_ITEMS,
  MATERIAL_REFRESH_FAILURE_CODES,
  type MaterialRefreshBatchCounts,
  type MaterialRefreshBatchStatus,
} from '../../src/application/material-refresh-batch-types.js';
import type {
  ApiMaterialBatchItemView,
  ApiMaterialBatchSummaryView,
  ApiMaterialBatchView,
} from '../../src/application/workbench-api.js';
import { ApiClient, ApiClientError } from '../../src/ui/api.js';
import {
  MAX_BULK_MATERIAL_ITEMS,
  MATERIAL_BATCH_LIST_LIMIT,
  MATERIAL_BATCH_STATUS_TEXT,
  MATERIAL_CANCEL_NOTE,
  MATERIAL_CLOSE_NOTE,
  MATERIAL_EDITORIAL_TEXT,
  MATERIAL_FAILURE_CODES,
  MATERIAL_FAILURE_DISCLAIMER,
  MATERIAL_FAILURE_TEXT,
  MATERIAL_HISTORY_ENTRY_LABEL,
  MATERIAL_HISTORY_SCOPE_NOTE,
  MATERIAL_HISTORY_TITLE,
  MATERIAL_ITEM_STATUS_TEXT,
  MATERIAL_LOCAL_PREPARE_TEXT,
  MATERIAL_NO_MODEL_TEXT,
  MATERIAL_PAUSED_NOTE,
  MATERIAL_PLATFORM_START_TEXT,
  MATERIAL_PREPARE_AGAIN_NOTE,
  MATERIAL_RECOVER_NOTE,
  MATERIAL_RETRY_NOTE,
  MATERIAL_START_LABEL,
  MATERIAL_RESUME_LABEL,
  MATERIAL_UNKNOWN_FAILURE_TEXT,
  OLD_ANALYSIS_BATCH_TEXT,
  REFRESH_MATERIALS_ACTION,
  batchStatusText,
  displayKey,
  editorialAvailabilityText,
  failureExplanation,
  itemAttemptsText,
  itemEditorialText,
  itemFailureCode,
  itemSnapshotText,
  itemStatementText,
  itemStatusText,
  localMaterialView,
  materialAccountText,
  materialBatchOrigin,
  materialBatchStateNote,
  materialCancelGate,
  materialCountsText,
  materialMoment,
  materialPollingActive,
  materialPrepareGate,
  materialPrepareItems,
  materialPrepareRequest,
  materialPreparedNowText,
  materialProgressText,
  materialRetryGate,
  materialScopeCopy,
  materialScopeIdentity,
  materialStartGate,
  materialStoredBatchText,
  materialSummaryText,
  newestBatchView,
  refreshMaterialProblemKeys,
  refreshMaterialScopeText,
  retryableItemCount,
  unfinishedItemCount,
} from '../../src/ui/material-batch-view.js';

// ---------------------------------------------------------------------------------------
// Minimal typed fixtures
// ---------------------------------------------------------------------------------------

function emptyCounts(overrides: Partial<MaterialRefreshBatchCounts> = {}): MaterialRefreshBatchCounts {
  return { pending: 0, running: 0, completed: 0, attention: 0, cancelled: 0, changedSnapshots: 0, ...overrides };
}

/** One batch answer with exactly the counters a case states, so totals cannot be fabricated. */
function batchView(
  status: MaterialRefreshBatchStatus,
  counters: Partial<MaterialRefreshBatchCounts> = {},
  items: readonly ApiMaterialBatchItemView[] = [],
) {
  const counts = emptyCounts(counters);
  return {
    batchId: 'material-batch-1',
    status,
    revision: 1,
    createdAt: '2027-03-01T08:00:00.000Z',
    updatedAt: '2027-03-01T08:05:00.000Z',
    startedAt: status === 'prepared' ? null : '2027-03-01T08:00:00.000Z',
    finishedAt: status === 'completed' ? '2027-03-01T08:05:00.000Z' : null,
    cancelledAt: status === 'cancelled' ? '2027-03-01T08:05:00.000Z' : null,
    itemCount: counts.pending + counts.running + counts.completed + counts.attention + counts.cancelled,
    counts,
    items,
  };
}

function itemView(overrides: Partial<ApiMaterialBatchItemView> = {}): ApiMaterialBatchItemView {
  return {
    problemKey: 'codeforces%3Acodeforces.com||1A',
    fetchStatement: true,
    hasOfficialTutorial: false,
    status: 'pending',
    attempts: 0,
    failure: null,
    result: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function resultView(
  editorial: NonNullable<ApiMaterialBatchItemView['result']>['editorial'],
  changed = true,
): NonNullable<ApiMaterialBatchItemView['result']> {
  return {
    statement: 'fetched',
    editorial,
    mirror: 'skipped',
    sourceCount: editorial === 'found' ? 2 : 0,
    solutionCount: editorial === 'found' ? 1 : 0,
    snapshot: {
      snapshotId: 'snapshot-1',
      version: 3,
      contentHash: 'a'.repeat(64),
      changed,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

void test('every batch and item status has its own Chinese label', () => {
  const statuses = Object.keys(MATERIAL_BATCH_STATUS_TEXT);
  assert.equal(statuses.length, 5);
  const labels = new Set<string>();
  for (const status of statuses) {
    const label = batchStatusText(status);
    assert.ok(label.length > 0);
    assert.equal(/[a-z_]{4,}/.test(label), false, `${status} must not render an English code`);
    labels.add(label);
  }
  // The five states stay distinguishable: "prepared" is explicitly not yet a platform request and
  // "paused" explicitly asks for retry or continuation.
  assert.equal(labels.size, statuses.length);
  assert.match(MATERIAL_BATCH_STATUS_TEXT.prepared, /尚未发起平台请求/);
  assert.match(MATERIAL_BATCH_STATUS_TEXT.paused, /重试或继续/);
  assert.equal(batchStatusText('brand_new_state'), '未知批次状态');

  const itemStatuses = Object.keys(MATERIAL_ITEM_STATUS_TEXT);
  assert.equal(itemStatuses.length, 5);
  const itemLabels = new Set<string>();
  for (const status of itemStatuses) {
    const label = itemStatusText(itemView({ status: status as ApiMaterialBatchItemView['status'] }));
    assert.ok(label.length > 0);
    assert.equal(/[a-z_]{4,}/.test(label), false, `${status} must not render an English code`);
    itemLabels.add(label);
  }
  assert.equal(itemLabels.size, itemStatuses.length);
  assert.equal(itemStatusText(itemView({ status: 'attention' })), MATERIAL_ITEM_STATUS_TEXT.attention);
  assert.equal(itemStatusText({ ...itemView(), status: 'mystery' as ApiMaterialBatchItemView['status'] }), '未知项目状态');
});

void test('every stable failure code has its own Chinese explanation that never claims an absence', () => {
  // The UI bound and the failure vocabulary mirror the accepted application contract exactly.
  assert.equal(MAX_BULK_MATERIAL_ITEMS, MAX_MATERIAL_REFRESH_BATCH_ITEMS);
  assert.deepEqual([...MATERIAL_FAILURE_CODES].sort(), [...MATERIAL_REFRESH_FAILURE_CODES].sort());
  assert.equal(MATERIAL_FAILURE_CODES.length, 10);

  const texts = new Set<string>();
  for (const code of MATERIAL_FAILURE_CODES) {
    const text = failureExplanation(code);
    assert.ok(text.length > 0);
    assert.equal(/[a-z_]{4,}/.test(text), false, `${code} must keep its raw code out of the primary text`);
    assert.equal(/没有题解|无题解|题解不存在/.test(text), false, `${code} must not read as a confirmed absence`);
    assert.match(text, /重试|检查|等待|确认|开始/, `${code} must state what the user can do`);
    texts.add(text);
  }
  // Ten distinct explanations: auth, permission, throttling and a changed response never blur.
  assert.equal(texts.size, MATERIAL_FAILURE_CODES.length);
  assert.match(MATERIAL_FAILURE_TEXT.auth_required, /账号/);
  assert.match(MATERIAL_FAILURE_TEXT.forbidden, /拒绝/);
  assert.match(MATERIAL_FAILURE_TEXT.rate_limited, /限流/);
  assert.match(MATERIAL_FAILURE_TEXT.unavailable, /暂时不可用/);
  assert.match(MATERIAL_FAILURE_TEXT.changed_response, /人机验证|结构发生变化/);
  assert.match(MATERIAL_FAILURE_TEXT.invalid_reference, /本地引用无效/);
  assert.match(MATERIAL_FAILURE_TEXT.missing_reference, /本地缺少/);
  assert.match(MATERIAL_FAILURE_TEXT.stale_head, /快照已被更新/);
  assert.match(MATERIAL_FAILURE_TEXT.interrupted, /中断/);
  assert.match(MATERIAL_FAILURE_TEXT.unexpected, /重试/);

  // An unknown code from a newer host still renders a real sentence instead of a blank instruction.
  assert.equal(failureExplanation('brand_new_code'), MATERIAL_UNKNOWN_FAILURE_TEXT);
  assert.match(MATERIAL_UNKNOWN_FAILURE_TEXT, /重试/);
});

void test('a confirmed completed absent stays distinguishable from an operational failure', () => {
  const absent = itemView({
    status: 'completed',
    attempts: 1,
    startedAt: '2027-03-01T08:00:00.000Z',
    finishedAt: '2027-03-01T08:01:00.000Z',
    result: resultView('absent', false),
  });
  const failed = itemView({
    problemKey: 'codeforces%3Acodeforces.com||1B',
    status: 'attention',
    attempts: 2,
    startedAt: '2027-03-01T08:00:00.000Z',
    finishedAt: '2027-03-01T08:01:00.000Z',
    failure: { code: 'unavailable', retryable: true, retryAfterMs: null, attempts: 2 },
    result: resultView(null, false),
  });
  assert.equal(itemEditorialText(absent), MATERIAL_EDITORIAL_TEXT.absent);
  assert.match(itemEditorialText(absent), /已确认无题解/);
  assert.equal(itemEditorialText(failed), failureExplanation('unavailable'));
  assert.notEqual(itemEditorialText(absent), itemEditorialText(failed));
  assert.equal(/无题解/.test(itemEditorialText(failed)), false, 'a failure never renders as an absence');
  assert.equal(itemStatusText(absent), MATERIAL_ITEM_STATUS_TEXT.completed);
  assert.equal(itemStatusText(failed), MATERIAL_ITEM_STATUS_TEXT.attention);
  assert.equal(itemFailureCode(failed), 'unavailable');
  assert.equal(itemFailureCode(absent), null);
  // A completed item that never asked for an editorial is neither found nor absent.
  assert.equal(itemEditorialText(itemView({ status: 'completed', result: resultView(null) })), '本次未读取题解');
  assert.equal(editorialAvailabilityText('found'), '已找到题解');
  assert.equal(editorialAvailabilityText('brand_new'), '未知题解状态');

  // The shared disclaimer is what keeps every failure sentence honest.
  assert.match(MATERIAL_FAILURE_DISCLAIMER, /不代表平台没有题解/);
  assert.match(MATERIAL_FAILURE_DISCLAIMER, /只有“已完成”/);
});

void test('the item row states statement, snapshot and attempt facts without inventing any', () => {
  const running = itemView({ status: 'running', attempts: 1, startedAt: '2027-03-01T08:00:00.000Z' });
  assert.equal(itemStatementText(running), '未记录题面状态');
  assert.equal(itemSnapshotText(running), '未提交快照');
  assert.equal(itemAttemptsText(running), '已尝试 1 次');
  assert.equal(itemAttemptsText(itemView()), '尚未尝试');
  const completed = itemView({ status: 'completed', result: resultView('found', false) });
  assert.equal(itemStatementText(completed), '题面已获取');
  assert.equal(itemSnapshotText(completed), '快照未变化（复用 v3）');
  const changed = itemView({ status: 'completed', result: resultView('found', true) });
  assert.equal(itemSnapshotText(changed), '快照已更新（v3）');
});

// ---------------------------------------------------------------------------------------
// Counts and gates
// ---------------------------------------------------------------------------------------

void test('the counter line reports every number deterministically', () => {
  const view = batchView('paused', { pending: 2, completed: 3, attention: 4, cancelled: 1, changedSnapshots: 2 });
  assert.equal(view.itemCount, 10);
  assert.equal(
    materialCountsText(view),
    '共 10 题 · 待刷新 2 · 刷新中 0 · 已完成 3 · 需处理 4 · 已取消 1 · 快照变更 2',
  );
  assert.equal(
    materialProgressText(view),
    '已暂停（需重试或继续） · 共 10 题 · 待刷新 2 · 刷新中 0 · 已完成 3 · 需处理 4 · 已取消 1 · 快照变更 2',
  );
  assert.equal(materialProgressText(null), '尚未准备或选择批次。');
  assert.equal(unfinishedItemCount(view.counts), 6);
  assert.equal(retryableItemCount(view.counts), 5);
});

void test('start, cancel, retry and polling gates are honest in every batch state', () => {
  const prepared = batchView('prepared', { pending: 3 });
  assert.deepEqual(materialStartGate(prepared), { allowed: true, reason: null, label: MATERIAL_START_LABEL });
  assert.equal(materialCancelGate(prepared).allowed, true);
  assert.equal(materialRetryGate(prepared).allowed, false);
  assert.match(materialRetryGate(prepared).reason ?? '', /没有失败或已取消/);
  assert.equal(materialPollingActive(prepared), false);

  const running = batchView('running', { pending: 1, running: 1 });
  assert.equal(materialStartGate(running).allowed, false);
  assert.match(materialStartGate(running).reason ?? '', /正在刷新中/);
  assert.equal(materialCancelGate(running).allowed, true);
  assert.equal(materialRetryGate(running).allowed, false);
  assert.match(materialRetryGate(running).reason ?? '', /正在刷新中/);
  assert.equal(materialPollingActive(running), true);

  const pausedWithPending = batchView('paused', { pending: 2, attention: 1, completed: 1 });
  assert.equal(materialStartGate(pausedWithPending).label, MATERIAL_RESUME_LABEL);
  assert.equal(materialStartGate(pausedWithPending).allowed, true);
  assert.equal(materialRetryGate(pausedWithPending).allowed, true);
  assert.equal(materialCancelGate(pausedWithPending).allowed, true);
  assert.equal(materialPollingActive(pausedWithPending), false);

  // A paused batch whose only remaining work is failed/cancelled needs the explicit retry first.
  const pausedFailuresOnly = batchView('paused', { completed: 2, attention: 1, cancelled: 1 });
  assert.equal(materialStartGate(pausedFailuresOnly).allowed, false);
  assert.match(materialStartGate(pausedFailuresOnly).reason ?? '', /仅重试失败\/已取消项/);
  assert.equal(materialRetryGate(pausedFailuresOnly).allowed, true);
  // Attention rows are unfinished work, so cancel still has something truthful to dispose of.
  assert.equal(materialCancelGate(pausedFailuresOnly).allowed, true);

  const completed = batchView('completed', { completed: 3 });
  for (const gate of [materialStartGate(completed), materialCancelGate(completed), materialRetryGate(completed)]) {
    assert.equal(gate.allowed, false);
    assert.ok((gate.reason ?? '').length > 0);
  }
  assert.equal(materialPollingActive(completed), false);

  const cancelled = batchView('cancelled', { completed: 1, cancelled: 2 });
  assert.equal(materialStartGate(cancelled).allowed, false);
  assert.match(materialStartGate(cancelled).reason ?? '', /仅重试失败\/已取消项/);
  assert.equal(materialCancelGate(cancelled).allowed, false);
  // A cancelled batch is recoverable only through the explicit retry, which resets exactly the
  // cancelled items to pending and still requires a separate start click; completed work is kept.
  assert.equal(retryableItemCount(cancelled.counts), 2);
  assert.equal(materialRetryGate(cancelled).allowed, true);
  assert.equal(materialPollingActive(cancelled), false);

  // Without a selected batch nothing is offered, and every refusal carries a reason.
  for (const gate of [materialStartGate(null), materialCancelGate(null), materialRetryGate(null)]) {
    assert.equal(gate.allowed, false);
    assert.ok((gate.reason ?? '').length > 0);
  }
  assert.equal(materialPollingActive(null), false);
});

void test('the prepare gate refuses zero and over-limit scopes without truncating', () => {
  assert.equal(materialPrepareGate([]).allowed, false);
  assert.match(materialPrepareGate([]).reason ?? '', /至少 1 道题/);
  assert.equal(materialPrepareGate(['k1']).allowed, true);
  assert.equal(materialPrepareGate(Array.from({ length: 100 }, (_, index) => 'k' + index)).allowed, true);
  const over = materialPrepareGate(Array.from({ length: 101 }, (_, index) => 'k' + index));
  assert.equal(over.allowed, false);
  assert.match(over.reason ?? '', /最多 100 题/);
  assert.match(over.reason ?? '', /不会静默截断/);
  assert.equal(materialPrepareGate(Array.from({ length: 101 }, (_, index) => 'k' + index)).allowed, false);
});

void test('each batch state has its own explanation and a paused batch never resumes itself', () => {
  for (const status of ['prepared', 'running', 'paused', 'completed', 'cancelled'] as MaterialRefreshBatchStatus[]) {
    const note = materialBatchStateNote(batchView(status, { pending: status === 'running' ? 1 : 0 }));
    assert.ok(note.length > 0, status + ' needs an explanation');
  }
  assert.equal(materialBatchStateNote(null), MATERIAL_RECOVER_NOTE);
  assert.match(materialBatchStateNote(batchView('paused', { attention: 1 })), /不会自动继续/);
  assert.match(materialBatchStateNote(batchView('prepared', { pending: 1 })), /开始平台刷新/);
  assert.match(materialBatchStateNote(batchView('running', { running: 1 })), /运行状态/);
  assert.match(materialBatchStateNote(batchView('completed', { completed: 1 })), /不会被重复刷新/);
});

// ---------------------------------------------------------------------------------------
// Review aggregation and bank inputs
// ---------------------------------------------------------------------------------------

void test('refresh-material aggregation keeps only refresh_materials, first-seen order and no duplicates', () => {
  const rows = [
    { problemKey: 'k1', action: 'refresh_materials' },
    { problemKey: 'k2', action: 'supplement_editorial' },
    { problemKey: 'k1', action: 'refresh_materials' },
    { problemKey: 'k3', action: REFRESH_MATERIALS_ACTION },
    { problemKey: 'k2', action: 'supplement_statement' },
    { problemKey: 'k4', action: 'refresh_materials' },
  ];
  const scope = refreshMaterialProblemKeys(rows);
  assert.deepEqual(scope.keys, ['k1', 'k3', 'k4']);
  assert.equal(scope.total, 3);
  assert.equal(scope.overflow, false);
  assert.equal(scope.ready, true);
  assert.match(refreshMaterialScopeText(scope), /仅 refresh_materials，不含补题解与补题面/);

  // The other two blocked actions can never enter a platform refresh.
  assert.deepEqual(refreshMaterialProblemKeys(rows.filter((row) => row.action !== 'refresh_materials')).keys, []);
  assert.equal(refreshMaterialProblemKeys([]).ready, false);
  assert.equal(refreshMaterialProblemKeys([]).total, 0);
  assert.match(refreshMaterialScopeText(refreshMaterialProblemKeys([])), /没有需要刷新/);
});

void test('more than one batch worth of refresh_materials rows is refused instead of silently truncated', () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ problemKey: 'k' + index, action: 'refresh_materials' }));
  const scope = refreshMaterialProblemKeys(rows);
  assert.equal(scope.total, 101);
  assert.equal(scope.keys.length, 101, 'the whole scope is reported, never a truncated head');
  assert.equal(scope.overflow, true);
  assert.equal(scope.ready, false);
  assert.match(refreshMaterialScopeText(scope), /超过单批上限 100 题/);
  assert.match(refreshMaterialScopeText(scope), /不会静默截断/);
});

void test('bank preparation keeps the selection order, the current account and fetchStatement true', () => {
  const items = materialPrepareItems(['codeforces%3Acodeforces.com||2A', 'codeforces%3Acodeforces.com||1A'], 'acc-1');
  assert.deepEqual(items, [
    { problemKey: 'codeforces%3Acodeforces.com||2A', accountId: 'acc-1', fetchStatement: true },
    { problemKey: 'codeforces%3Acodeforces.com||1A', accountId: 'acc-1', fetchStatement: true },
  ]);
  // The bulk bank flow never solicits a tutorial URL (or a cookie, statement or editorial body).
  for (const item of items) {
    assert.equal(Object.hasOwn(item, 'officialTutorialUrl'), false);
  }
  // A missing account is prepared explicitly as an anonymous read, never as a fabricated account.
  assert.deepEqual(materialPrepareItems(['k1'], null), [{ problemKey: 'k1', accountId: null, fetchStatement: true }]);
  assert.deepEqual(materialPrepareRequest(['k1'], null), { items: [{ problemKey: 'k1', accountId: null, fetchStatement: true }] });
  assert.equal(materialAccountText(null), '当前未选择账号：按匿名读取准备（匿名读取可能无法确认题解状态）。');
  // The account sentence states exactly what this record does with credentials: it never claims that
  // no Cookie exists anywhere, and it never echoes a credential value.
  const account = materialAccountText('acc-1');
  assert.match(account, /当前选择的账号/);
  assert.match(account, /不会复制、显示或单独保存 Cookie 值/);
  assert.match(account, /账号连接流程/);
  assert.match(account, /Windows 凭据管理器/);
  assert.match(account, /可能使用/);
  assert.equal(/不保存任何 Cookie|不会保存任何 Cookie|不会复制、显示或保存任何 Cookie/.test(account), false);
  assert.equal(/密码|token|authorization|__client_id|_uid/i.test(account), false);
});

void test('the material panel scope identity is a pure function of the analysis batch and ordered keys', () => {
  const keys = ['codeforces%3Acodeforces.com||1A', 'codeforces%3Acodeforces.com||2B'];
  const base = materialScopeIdentity('analysis-batch-1', keys);
  // Stable: the same scope always yields the same identity, so a re-render never remounts the panel
  // and no clock or randomness takes part in it.
  assert.equal(materialScopeIdentity('analysis-batch-1', [...keys]), base);
  assert.equal(materialScopeIdentity('analysis-batch-1', keys), base);
  // A different analysis batch, a different order, a different membership or an empty scope must all
  // produce a different identity, because each one is a different scope for the reusable panel.
  for (const other of [
    materialScopeIdentity('analysis-batch-2', keys),
    materialScopeIdentity(null, keys),
    materialScopeIdentity('analysis-batch-1', [...keys].reverse()),
    materialScopeIdentity('analysis-batch-1', keys.slice(0, 1)),
    materialScopeIdentity('analysis-batch-1', [...keys, 'codeforces%3Acodeforces.com||3C']),
    materialScopeIdentity('analysis-batch-1', []),
  ]) {
    assert.notEqual(other, base);
  }
  // Length prefixes keep the encoding unambiguous: no key content can forge another scope, and the
  // "no analysis batch" marker can never be confused with a real batch id.
  assert.notEqual(materialScopeIdentity(null, ['a|1:b']), materialScopeIdentity(null, ['a', 'b']));
  assert.notEqual(materialScopeIdentity(null, ['ab']), materialScopeIdentity(null, ['a', 'b']));
  assert.notEqual(materialScopeIdentity(null, ['1:a']), materialScopeIdentity(null, ['a']));
  assert.notEqual(materialScopeIdentity(null, []), materialScopeIdentity('none', []));
  // The identity is built from canonical keys, never from the display label.
  assert.notEqual(materialScopeIdentity(null, [displayKey(keys[0]!)]), materialScopeIdentity(null, [keys[0]!]));
});

// ---------------------------------------------------------------------------------------
// Wording boundaries
// ---------------------------------------------------------------------------------------

void test('the panel states the local/platform boundary before either action', () => {
  assert.match(MATERIAL_LOCAL_PREPARE_TEXT, /只在本地/);
  assert.match(MATERIAL_LOCAL_PREPARE_TEXT, /不调用 AI/);
  assert.match(MATERIAL_LOCAL_PREPARE_TEXT, /不消耗 DeepSeek 额度/);
  assert.match(MATERIAL_PLATFORM_START_TEXT, /只有点击/);
  assert.match(MATERIAL_PLATFORM_START_TEXT, /不调用 AI/);
  assert.match(MATERIAL_NO_MODEL_TEXT, /不会创建模型调用/);
});

void test('cancel, retry and close wording keeps completed work and explicit starts intact', () => {
  assert.match(MATERIAL_CANCEL_NOTE, /已完成的项目保留/);
  assert.match(MATERIAL_CANCEL_NOTE, /不会被撤销/);
  assert.match(MATERIAL_RETRY_NOTE, /仅重试失败\/已取消项/);
  assert.match(MATERIAL_RETRY_NOTE, /不会重复刷新/);
  assert.match(MATERIAL_RETRY_NOTE, /不会自动开始/);
  assert.match(MATERIAL_CLOSE_NOTE, /不会取消已开始的后台平台刷新/);
  assert.match(MATERIAL_PREPARE_AGAIN_NOTE, /不会覆盖或修改已存在的批次/);
  // A stored or recovered paused batch states that it will not continue by itself.
  assert.match(MATERIAL_PAUSED_NOTE, /已暂停批次不会自动继续/);
});

void test('review wording requires a new free analysis preparation and denies any automatic paid action', () => {
  assert.match(OLD_ANALYSIS_BATCH_TEXT, /不可变旧快照/);
  assert.match(OLD_ANALYSIS_BATCH_TEXT, /免费准备批次/);
  assert.match(OLD_ANALYSIS_BATCH_TEXT, /明确点击开始付费分析/);
  // The refusal is explicit, so no reader can expect an automatic prepare, start or resume.
  assert.match(OLD_ANALYSIS_BATCH_TEXT, /不会自动准备/);
  assert.match(OLD_ANALYSIS_BATCH_TEXT, /不会自动开始或恢复任何付费分析/);
  assert.equal(/将自动|自动帮你|自动为你/.test(OLD_ANALYSIS_BATCH_TEXT), false);
});

void test('the reusable panel cannot reach an AI operation and does reach the material batch one', () => {
  const source = readFileSync(new URL('../../src/ui/BulkMaterialRefresh.tsx', import.meta.url), 'utf8');
  // No paid route is nameable from this surface: it may only call the six material.* operations.
  assert.equal(/'batch\.(prepare|run|resume|pause|cancel|recover|detail|list)'/.test(source), false);
  assert.equal(/'plan\.ai/.test(source), false);
  assert.equal(/'assessment\./.test(source), false);
  assert.equal(source.includes("'material.prepare'"), true);
  assert.equal(source.includes("'material.start'"), true);
  assert.equal(source.includes("'material.cancel'"), true);
  assert.equal(source.includes("'material.retryFailed'"), true);
  assert.equal(source.includes("'material.detail'"), true);
  assert.equal(source.includes("'material.list'"), true);
});

// ---------------------------------------------------------------------------------------
// Batches list, display keys and transport
// ---------------------------------------------------------------------------------------

void test('the batch list line labels time, size, status and the two decisive counts', () => {
  const summary: ApiMaterialBatchSummaryView = {
    batchId: 'material-batch-1',
    status: 'paused',
    revision: 4,
    createdAt: '2027-03-01T08:00:00.000Z',
    updatedAt: '2027-03-01T08:05:00.000Z',
    finishedAt: null,
    cancelledAt: null,
    itemCount: 5,
    counts: emptyCounts({ completed: 3, attention: 2 }),
  };
  const line = materialSummaryText(summary);
  assert.match(line, /5 题/);
  assert.match(line, /已暂停（需重试或继续）/);
  assert.match(line, /已完成 3/);
  assert.match(line, /需处理 2/);
  assert.equal(materialMoment(null), '—');
  assert.ok(materialMoment('2027-03-01T08:00:00.000Z').length > 0);
  // A malformed instant is never replaced by a fabricated local time.
  assert.equal(materialMoment('not-a-time'), 'not-a-time');
});

void test('a display label is the external key suffix while the canonical key is preserved', () => {
  const canonical = 'codeforces%3Acodeforces.com||1234A';
  assert.equal(displayKey(canonical), '1234A');
  assert.equal(displayKey('plain-key'), 'plain-key');
  assert.equal(materialPrepareItems([canonical], null)[0]?.problemKey, canonical);
});

void test('the durable read wins only when it is at least as new as the last mutation answer', () => {
  const loaded = batchView('running', { running: 1 });
  const newer = { ...batchView('completed', { completed: 1 }), revision: 3 };
  const older = { ...batchView('prepared', { pending: 1 }), revision: 0 };
  assert.equal(newestBatchView(loaded, null), loaded);
  assert.equal(newestBatchView(null, newer), newer);
  // A different batch id never leaks into the panel.
  assert.equal(newestBatchView(loaded, { ...newer, batchId: 'other-batch' }), loaded);
  assert.equal(newestBatchView(loaded, older), loaded);
  assert.equal(newestBatchView(loaded, newer), newer);
  assert.equal(newestBatchView(loaded, { ...loaded, revision: loaded.revision }), loaded);
});

void test('the six material batch operations stay typed and reachable through the browser client', async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const client = new ApiClient(async (input, init) => {
    calls.push({ input, init });
    return Response.json({ apiVersion: 1, ok: true, value: { batchId: 'material-batch-1' } });
  });
  const controller = new AbortController();
  const prepared = materialPrepareRequest(['codeforces%3Acodeforces.com||1A'], null);
  await client.request('material.prepare', prepared, controller.signal);
  await client.request('material.start', { batchId: 'material-batch-1' });
  await client.request('material.detail', { batchId: 'material-batch-1' });
  await client.request('material.list', { limit: MATERIAL_BATCH_LIST_LIMIT });
  await client.request('material.cancel', { batchId: 'material-batch-1' });
  await client.request('material.retryFailed', { batchId: 'material-batch-1' });
  assert.deepEqual(
    calls.map((call) => call.input),
    ['material.prepare', 'material.start', 'material.detail', 'material.list', 'material.cancel', 'material.retryFailed'].map(
      (operation) => '/api/icpc/v1/' + operation,
    ),
  );
  for (const call of calls) {
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.credentials, 'same-origin');
  }
  assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    items: [{ problemKey: 'codeforces%3Acodeforces.com||1A', accountId: null, fetchStatement: true }],
  });
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { limit: MATERIAL_BATCH_LIST_LIMIT });
  // An operation that does not exist is still refused before any request is sent.
  await assert.rejects(
    () => client.request('material.unknown' as never, {} as never),
    (error: unknown) => error instanceof ApiClientError && error.code === 'invalid_operation',
  );
});

// ---------------------------------------------------------------------------------------
// History/recovery entry and stored-batch provenance (Sprint 34B2)
// ---------------------------------------------------------------------------------------

/** One durable batch view with an explicit id, so "prepared here" and "stored" stay distinguishable. */
function storedView(
  batchId: string,
  status: MaterialRefreshBatchStatus,
  counters: Partial<MaterialRefreshBatchCounts> = {},
): ApiMaterialBatchView {
  return { ...batchView(status, counters), batchId };
}

void test('the history entry opens with zero selected problems and can never prepare from there', () => {
  // The opener carries no problem keys at all, which is exactly the state after a reload.
  assert.equal(materialPrepareGate([]).allowed, false);
  assert.match(materialPrepareGate([]).reason ?? '', /至少 1 道题/);
  assert.ok(MATERIAL_HISTORY_ENTRY_LABEL.length > 0);
  assert.ok(MATERIAL_HISTORY_TITLE.length > 0);
  // It is a read-only entry: opening, loading and selecting are stated as starting nothing.
  assert.match(MATERIAL_HISTORY_SCOPE_NOTE, /没有新的准备范围/);
  assert.match(MATERIAL_HISTORY_SCOPE_NOTE, /不会发起平台请求/);
  assert.match(MATERIAL_HISTORY_SCOPE_NOTE, /也不会自动开始/);
});

void test('a batch chosen from the durable list is stored, never this panel preparation', () => {
  const stored = storedView('material-batch-7', 'paused', { pending: 2, completed: 1 });
  assert.equal(materialBatchOrigin(stored, null), 'stored');
  assert.equal(materialBatchOrigin(stored, 'material-batch-9'), 'stored');
  assert.equal(materialBatchOrigin(stored, 'material-batch-7'), 'prepared_now');
  assert.equal(materialBatchOrigin(null, 'material-batch-7'), 'none');
  assert.equal(materialBatchOrigin(null, null), 'none');
  // Its own state still decides which explicit actions exist, and those stay available from an entry
  // that prepared nothing; none of them runs by itself.
  assert.deepEqual(materialStartGate(stored), { allowed: true, reason: null, label: MATERIAL_RESUME_LABEL });
  assert.equal(materialCancelGate(stored).allowed, true);
  assert.equal(materialRetryGate(stored).allowed, false);
  assert.match(materialRetryGate(stored).reason ?? '', /没有失败或已取消/);
  assert.equal(materialPollingActive(stored), false);
  assert.equal(materialPollingActive(storedView('material-batch-8', 'running', { running: 1 })), true);
});

void test('a stored batch is worded by its own durable identity, never by the current scope or account', () => {
  const stored = storedView('material-batch-7', 'paused', { pending: 2, completed: 1 });
  const scopeNote = '本次范围：打开面板时选中的 2 题，保留当时的顺序。';
  const copy = materialScopeCopy({
    view: stored,
    preparedBatchId: null,
    problemKeys: ['k1', 'k2'],
    accountId: 'acc-1',
    scopeNote,
  });
  assert.equal(copy.origin, 'stored');
  // The capture scope and the current account describe only a possible new preparation, so neither is
  // rendered over the stored batch.
  assert.equal(copy.scopeText, null);
  assert.equal(copy.accountText, null);
  const text = copy.batchText ?? '';
  assert.ok(text.includes('material-batch-7'));
  assert.ok(text.includes(materialMoment(stored.createdAt)));
  assert.ok(text.includes(MATERIAL_BATCH_STATUS_TEXT.paused));
  assert.match(text, /共 3 题/);
  // It states the two facts a reader must not have to infer …
  assert.match(text, /当前题库选择/);
  assert.match(text, /当前账号都不会改变它/);
  // … and never guesses the account the public projection omits.
  assert.match(text, /不会显示或推测当时的账号/);
  assert.equal(text.includes(scopeNote), false);
  assert.equal(text.includes(materialAccountText('acc-1')), false);
  assert.equal(/acc-1/.test(text), false);
  assert.equal(materialStoredBatchText(stored), text);
});

void test('a batch this panel just prepared is named as the preparation result, not a history pick', () => {
  const fresh = storedView('material-batch-7', 'prepared', { pending: 2 });
  const scopeNote = '本次范围：1 题。';
  const copy = materialScopeCopy({
    view: fresh,
    preparedBatchId: 'material-batch-7',
    problemKeys: ['k1'],
    accountId: 'acc-1',
    scopeNote,
  });
  assert.equal(copy.origin, 'prepared_now');
  assert.equal(copy.scopeText, scopeNote);
  assert.equal(copy.accountText, materialAccountText('acc-1'));
  assert.ok((copy.batchText ?? '').includes('material-batch-7'));
  assert.match(copy.batchText ?? '', /本次免费准备建立/);
  assert.match(copy.batchText ?? '', /不是从历史记录中任意挑选的批次/);
  assert.equal(materialPreparedNowText(fresh), copy.batchText);

  // Nothing selected: the captured preparation scope and the current account read normally.
  const none = materialScopeCopy({
    view: null,
    preparedBatchId: null,
    problemKeys: ['k1'],
    accountId: 'acc-1',
    scopeNote,
  });
  assert.equal(none.origin, 'none');
  assert.equal(none.scopeText, scopeNote);
  assert.equal(none.batchText, null);
  assert.equal(none.accountText, materialAccountText('acc-1'));
  // Without a host sentence the default line still states the captured size and order.
  const fallback = materialScopeCopy({ view: null, preparedBatchId: null, problemKeys: ['k1', 'k2'], accountId: null });
  assert.equal(fallback.scopeText, '本次准备范围共 2 题（保持打开面板时的顺序）。');
  assert.equal(fallback.accountText, materialAccountText(null));
});

void test('a changed historical selection drops the previous batch local answer before detail renders', () => {
  const localA = { ...storedView('batch-A', 'prepared', { pending: 1 }), revision: 0 };
  assert.equal(localMaterialView('batch-A', localA), localA);
  // The previous batch's mutation answer is unreachable under a new selection …
  assert.equal(localMaterialView('batch-B', localA), null);
  // … and unreachable once the selection is cleared.
  assert.equal(localMaterialView(null, localA), null);
  // Only the newly loaded detail of the selected batch may render then.
  const loadedB = { ...storedView('batch-B', 'running', { running: 1 }), revision: 5 };
  assert.equal(newestBatchView(loadedB, localMaterialView('batch-B', localA)), loadedB);
  assert.equal(newestBatchView(null, localMaterialView('batch-B', localA)), null);
  // Its scope block describes stored batch B, not the panel's earlier preparation.
  const copy = materialScopeCopy({
    view: newestBatchView(loadedB, localMaterialView('batch-B', localA)),
    preparedBatchId: 'batch-A',
    problemKeys: ['k1'],
    accountId: 'acc-1',
  });
  assert.equal(copy.origin, 'stored');
  assert.equal(copy.scopeText, null);
  assert.equal(copy.accountText, null);
  assert.ok((copy.batchText ?? '').includes('batch-B'));
});

void test('the bank renders an always-enabled history opener and the panel clears stale local state', () => {
  const compact = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, '');
  const bank = compact('../../src/ui/Bank.tsx');
  // No `disabled` gate: after a reload the selection is empty and the entry must still work. It opens
  // the panel on an empty preparation scope, so only the durable list and explicit actions remain.
  assert.equal(
    bank.includes(
      '<buttontype="button"onClick={()=>{setMaterialScope(null);setMaterialHistoryOpen(true);}}>{MATERIAL_HISTORY_ENTRY_LABEL}</button>',
    ),
    true,
  );
  assert.equal(bank.includes('<BulkMaterialRefreshkey={materialScopeIdentity(null,[])}problemKeys={[]}'), true);
  assert.equal(bank.includes('title={MATERIAL_HISTORY_TITLE}'), true);
  assert.equal(bank.includes('scopeNote={MATERIAL_HISTORY_SCOPE_NOTE}'), true);

  const panel = compact('../../src/ui/BulkMaterialRefresh.tsx');
  // A changed selection drops the previous batch's local answer and any error it left behind.
  assert.equal(panel.includes('setLocal(null);action.clear();setBatchId('), true);
  assert.equal(panel.includes('newestBatchView(detail.data,localMaterialView(batchId,local))'), true);
  assert.equal(panel.includes('materialScopeCopy({'), true);
  // The prepare handler still refuses an empty scope before it can name `material.prepare`.
  assert.equal(panel.includes('if(busy||!prepareGate.allowed){return;}'), true);
});
