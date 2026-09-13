/**
 * Reading rules of the AI planning page (Sprint 11e).
 *
 * These cases drive the pure helpers of `planning-view.ts` directly: no DOM, no React, no store, no
 * clock and no network. They pin the externally meaningful guarantees the plan page relies on — the
 * default AI mode, the approved AI scheduling bounds against the legacy rule bounds, the explicit
 * candidate scope (an empty selection stays an explicit `[]`, an oversized one is refused instead
 * of truncated), the input signature that discards a late preparation answer, the poll gate that
 * follows an owned or durably reserved call and stops at a terminal attempt, account-scoped
 * tracking, and the honest rendering of a known versus unknown cost.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_PLAN_DEFAULTS,
  DEFAULT_PLANNING_MODE,
  MAX_AI_CANDIDATES,
  PLANNING_MODE_LABELS,
  PLANNING_PREPARE_FREE_NOTE,
  adoptPreparation,
  candidateScopeNotice,
  candidateScopeValidation,
  defaultCandidateScope,
  isTerminalAttempt,
  planningAbilitySummary,
  planningCancelText,
  planningCandidateRequest,
  planningErrorText,
  planningInputSignature,
  planningRetryText,
  planningRunNote,
  planningStatusLabel,
  planningUsageText,
  shouldPollPlanning,
  trackedForAccount,
  validateAiDraft,
  validateRuleDraft,
  type PlanningAbilityView,
  type PlanningDraft,
} from '../../src/ui/planning-view.js';

void test('the page defaults to AI mode and keeps the rule mode explicit', () => {
  assert.equal(DEFAULT_PLANNING_MODE, 'ai');
  assert.match(PLANNING_MODE_LABELS.ai, /AI.*默认/);
  assert.match(PLANNING_PREPARE_FREE_NOTE, /付费调用/);
  assert.match(PLANNING_MODE_LABELS.rule, /规则/);
  assert.deepEqual(AI_PLAN_DEFAULTS, {
    horizonDays: 7,
    minutesPerDay: 60,
    estimatedMinutes: 30,
    maxTasksPerDay: 3,
  });
});

void test('AI bounds are the approved ones while the rule path keeps its old limits', () => {
  assert.equal(validateAiDraft({ ...AI_PLAN_DEFAULTS }).valid, true);
  const invalidAi: readonly PlanningDraft[] = [
    { ...AI_PLAN_DEFAULTS, horizonDays: 0 },
    { ...AI_PLAN_DEFAULTS, horizonDays: 31 },
    { ...AI_PLAN_DEFAULTS, horizonDays: 7.5 },
    { ...AI_PLAN_DEFAULTS, minutesPerDay: 0 },
    { ...AI_PLAN_DEFAULTS, minutesPerDay: 481 },
    { ...AI_PLAN_DEFAULTS, maxTasksPerDay: 0 },
    { ...AI_PLAN_DEFAULTS, maxTasksPerDay: 4 },
    { ...AI_PLAN_DEFAULTS, estimatedMinutes: 0 },
    { ...AI_PLAN_DEFAULTS, estimatedMinutes: 61 },
    { ...AI_PLAN_DEFAULTS, minutesPerDay: Number.NaN },
  ];
  for (const draft of invalidAi) {
    const check = validateAiDraft(draft);
    assert.equal(check.valid, false, `${JSON.stringify(draft)} must be refused`);
    assert.ok((check.message ?? '').length > 0, 'every refusal needs a helpful label');
  }
  assert.match(validateAiDraft({ ...AI_PLAN_DEFAULTS, minutesPerDay: 481 }).message ?? '', /480/);
  assert.match(validateAiDraft({ ...AI_PLAN_DEFAULTS, maxTasksPerDay: 4 }).message ?? '', /1–3/);
  assert.match(validateAiDraft({ ...AI_PLAN_DEFAULTS, estimatedMinutes: 61 }).message ?? '', /每天分钟/);

  // The legacy rule path still accepts the old 1440-minute day, keeps its title contract and
  // refuses an estimate above the day.
  assert.equal(validateRuleDraft({ title: '计划', horizonDays: 30, minutesPerDay: 1440, estimatedMinutes: 1440 }).valid, true);
  assert.equal(validateRuleDraft({ title: '  ', horizonDays: 7, minutesPerDay: 60, estimatedMinutes: 30 }).valid, false);
  assert.match(validateRuleDraft({ title: '计划', horizonDays: 7, minutesPerDay: 1441, estimatedMinutes: 30 }).message ?? '', /1440/);
  assert.equal(validateRuleDraft({ title: '计划', horizonDays: 7, minutesPerDay: 60, estimatedMinutes: 61 }).valid, false);
  assert.equal(validateRuleDraft({ title: '计划', horizonDays: 0, minutesPerDay: 60, estimatedMinutes: 30 }).valid, false);
});

void test('candidate scope sends the exact selection, including an empty one, and refuses an oversized one', () => {
  assert.equal(defaultCandidateScope(['k1']), 'selected');
  assert.equal(defaultCandidateScope([]), 'auto', 'no selection falls back to the visible automatic pool');

  assert.deepEqual(planningCandidateRequest('selected', ['k1', 'k2']), {
    candidateProblemKeys: ['k1', 'k2'],
    candidateLimit: MAX_AI_CANDIDATES,
    overLimit: false,
  });
  const empty = planningCandidateRequest('selected', []);
  assert.deepEqual(empty.candidateProblemKeys, [], 'an explicit empty selection stays an explicit empty list');
  assert.notEqual(empty.candidateProblemKeys, null, 'it is never omitted into the automatic pool');
  assert.equal(empty.candidateLimit, MAX_AI_CANDIDATES, 'the cap is always sufficient, so it never truncates');
  assert.equal(planningCandidateRequest('auto', ['k1']).candidateProblemKeys, null);

  const hundred = Array.from({ length: 100 }, (_, index) => `k${String(index)}`);
  assert.equal(planningCandidateRequest('selected', hundred).overLimit, false);
  assert.equal(candidateScopeValidation('selected', hundred).valid, true);
  const hundredOne = [...hundred, 'k100'];
  assert.equal(planningCandidateRequest('selected', hundredOne).overLimit, true);
  assert.equal(candidateScopeValidation('selected', hundredOne).valid, false);
  assert.match(candidateScopeValidation('selected', hundredOne).message ?? '', /超过 100 道上限/);
  assert.match(candidateScopeValidation('selected', hundredOne).message ?? '', /减少候选题/);
  assert.equal(candidateScopeValidation('selected', []).valid, false);
  assert.match(candidateScopeValidation('selected', []).message ?? '', /回退到自动池/);
  assert.equal(candidateScopeValidation('auto', []).valid, true);

  assert.match(candidateScopeNotice('auto', []), /当前账号所在平台的本地题库/);
  assert.match(candidateScopeNotice('selected', ['k1', 'k2']), /2 道/);
  assert.match(candidateScopeNotice('selected', ['k1']), /勾选的题目/);
});

void test('the input signature changes with every preparation input and rejects a late answer', () => {
  const base = {
    accountId: 'a1',
    settingsRevision: 1,
    scope: 'selected' as const,
    selectedKeys: ['k1', 'k2'],
    draft: { ...AI_PLAN_DEFAULTS },
    reveal: false,
  };
  const signature = planningInputSignature(base);
  assert.equal(planningInputSignature({ ...base, selectedKeys: ['k1', 'k2'] }), signature);
  const variants = [
    { ...base, accountId: 'a2' },
    { ...base, settingsRevision: 2 },
    { ...base, settingsRevision: null },
    { ...base, scope: 'auto' as const },
    { ...base, selectedKeys: ['k2', 'k1'] },
    { ...base, draft: { ...AI_PLAN_DEFAULTS, horizonDays: 8 } },
    { ...base, draft: { ...AI_PLAN_DEFAULTS, minutesPerDay: 90 } },
    { ...base, draft: { ...AI_PLAN_DEFAULTS, estimatedMinutes: 45 } },
    { ...base, draft: { ...AI_PLAN_DEFAULTS, maxTasksPerDay: 1 } },
    { ...base, reveal: true },
  ];
  for (const variant of variants) {
    assert.notEqual(planningInputSignature(variant), signature, `${JSON.stringify(variant)} must invalidate the snapshot`);
  }

  const answer = { outcome: 'prepared' as const };
  assert.equal(adoptPreparation(answer, signature, signature), answer, 'the current snapshot is adopted');
  assert.equal(
    adoptPreparation(answer, signature, planningInputSignature(variants[0]!)),
    null,
    'a late answer of a changed form is ignored instead of being adopted',
  );
});

void test('polling follows an owned or durably reserved call and stops at a terminal attempt', () => {
  assert.equal(shouldPollPlanning({ status: 'reserved', operationState: null, ownedRunning: false }), true);
  assert.equal(shouldPollPlanning({ status: 'prepared', operationState: 'running', ownedRunning: false }), true);
  assert.equal(
    shouldPollPlanning({ status: 'prepared', operationState: null, ownedRunning: true }),
    true,
    'an acknowledgement can arrive before the reservation, so the owned flag keeps the first poll alive',
  );
  assert.equal(
    shouldPollPlanning({ status: 'prepared', operationState: 'settled', ownedRunning: false }),
    false,
    'a free preparation does not dispatch by itself',
  );
  assert.equal(shouldPollPlanning({ status: 'unknown', operationState: null, ownedRunning: false }), false);
  assert.equal(shouldPollPlanning({ status: null, operationState: null, ownedRunning: false }), false);

  assert.equal(isTerminalAttempt('prepared'), false);
  assert.equal(isTerminalAttempt('reserved'), false);
  for (const status of ['settled', 'uncertain', 'cancelled'] as const) {
    assert.equal(isTerminalAttempt(status), true);
    assert.equal(
      shouldPollPlanning({ status, operationState: 'settled', ownedRunning: false }),
      false,
      `${status} is terminal and is never polled or auto-resent`,
    );
  }
});

void test('a tracked request is only followed for the account it belongs to', () => {
  const tracked = { requestId: 'r1', accountId: 'a1', ownedRunning: true };
  assert.equal(trackedForAccount(tracked, 'a1'), tracked);
  assert.equal(trackedForAccount(tracked, 'a2'), null);
  assert.equal(trackedForAccount(tracked, null), null);
  assert.equal(trackedForAccount(null, 'a1'), null);
});

void test('a known cost prints its tokens while an unknown one is never zero', () => {
  const known = planningUsageText({
    status: 'settled',
    usage: { calls: 1, promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  });
  assert.match(known, /调用 1 次/);
  assert.match(known, /合计 30 tokens/);

  const prepared = planningUsageText({ status: 'prepared', usage: null });
  assert.match(prepared, /未调用模型/);
  assert.equal(prepared.includes('tokens'), false);
  assert.match(planningUsageText({ status: 'cancelled', usage: null }), /零调用、零计费/);

  const pending = planningUsageText({ status: 'reserved', usage: null });
  assert.match(pending, /尚未结算/);
  assert.equal(/合计 \d+ tokens/.test(pending), false);

  const uncertain = planningUsageText({ status: 'uncertain', usage: null });
  assert.match(uncertain, /用量未知/);
  assert.match(uncertain, /可能已计费/);
  assert.match(uncertain, /不会按 0 处理/);
  assert.equal(/合计 \d+ tokens/.test(uncertain), false);
});

void test('stable codes keep Chinese messages that never hide a paid or unknown outcome', () => {
  const codes = [
    'planning_quota_exhausted',
    'settings_changed',
    'stale_preparation',
    'invalid_output',
    'provider_error',
    'timeout',
    'cancelled',
    'uncertain',
  ];
  for (const code of codes) {
    const text = planningErrorText(code, '回退');
    assert.notEqual(text, '回退', `${code} needs its own stable message`);
    assert.ok(text.length > 0);
  }
  assert.match(planningErrorText('planning_quota_exhausted', '回退'), /24 小时/);
  assert.match(planningErrorText('planning_quota_exhausted', '回退'), /各自独立/);
  assert.match(planningErrorText('invalid_output', '回退'), /费用已保留/);
  assert.match(planningErrorText('provider_error', '回退'), /不会自动重试/);
  assert.match(planningErrorText('uncertain', '回退'), /可能已计费/);
  assert.match(planningErrorText('stale_preparation', '回退'), /重新免费准备/);
  assert.equal(planningErrorText('a_new_code', '回退'), '回退');
  assert.equal(planningErrorText(null, '回退'), '回退');
  assert.equal(planningErrorText(undefined, '回退'), '回退');

  assert.match(planningRetryText(true), /不会自动重试/);
  assert.equal(planningRetryText(false), '不可重试');
  assert.match(planningStatusLabel('uncertain'), /可能已计费/);
  assert.equal(planningStatusLabel('unknown'), '未找到记录');
});

void test('run and cancel answers describe only what was observed', () => {
  assert.match(planningRunNote({ operation: { state: 'running' }, attempt: null }), /后台运行/);
  assert.match(
    planningRunNote({ operation: { state: 'settled' }, attempt: { status: 'reserved', planId: null } }),
    /正在结算/,
  );
  assert.match(
    planningRunNote({ operation: { state: 'settled' }, attempt: { status: 'settled', planId: 'plan-1' } }),
    /已保存计划/,
  );
  assert.match(planningRunNote({ operation: null, attempt: null }), /没有可读取的结算记录/);
  assert.match(
    planningRunNote({ operation: { state: 'settled' }, attempt: { status: 'uncertain', planId: null } }),
    /结果未知/,
  );

  assert.match(planningCancelText({ cancelled: true, status: 'reserved' }), /实际费用仍以结算记录为准/);
  assert.match(planningCancelText({ cancelled: false, status: 'reserved' }), /可能仍会产生费用/);
  assert.match(planningCancelText({ cancelled: false, status: 'cancelled' }), /未产生费用/);
  assert.match(planningCancelText({ cancelled: false, status: 'unknown' }), /未找到/);
  assert.match(planningCancelText({ cancelled: false, status: 'settled' }), /无法再取消/);
});

void test('the compact ability summary stays honest for unknown, estimated and non-CF reports', () => {
  const base: PlanningAbilityView = {
    platform: 'codeforces',
    estimateStatus: 'unknown',
    estimateBasis: null,
    confidence: null,
    sampleSize: 2,
    minimumSampleSize: 5,
    baselineTrainingLevel: null,
    quartileBand: null,
    baselinePool: null,
    stretchPool: null,
    nativeDifficulty: [],
    caveats: [],
  };
  const unknown = planningAbilitySummary(base);
  assert.match(unknown.headline, /个人水平待校准/);
  assert.equal(unknown.sample, '2 / 5 题（描述性练习样本）');
  assert.equal(unknown.band, '未给出');
  assert.equal(unknown.confidence, '未校准');
  assert.deepEqual(unknown.native, []);

  const estimated = planningAbilitySummary({
    ...base,
    estimateStatus: 'estimated',
    estimateBasis: 'recent_independent',
    confidence: 'medium',
    sampleSize: 6,
    baselineTrainingLevel: 1600,
    quartileBand: { min: 1400, max: 1800 },
  });
  assert.match(estimated.headline, /个人水平待校准/);
  assert.equal(estimated.band, '1400 – 1800');
  assert.equal(estimated.confidence, '未校准');
  const calibrated = planningAbilitySummary({ ...base, trainingReference: { source: 'self_report', scale: 'codeforces', range: { min: 1700, max: 2200 }, revision: 1 } });
  assert.equal(calibrated.headline, 'CF 水平 1700 – 2200（用户自评）');

  const luogu = planningAbilitySummary({
    ...base,
    platform: 'luogu',
    nativeDifficulty: [{ dimension: 'difficulty', count: 3, missing: 1, median: 3 }],
  });
  assert.match(luogu.headline, /原生刻度评估（CF 估计不适用）/);
  assert.deepEqual(luogu.native, ['difficulty：中位数 3（3 题有数值，1 题缺失）']);
  assert.equal(planningAbilitySummary({ ...base, platform: 'luogu' }).headline, unknown.headline);
});
