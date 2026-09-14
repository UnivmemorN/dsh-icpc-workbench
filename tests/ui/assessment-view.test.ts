/**
 * AI assessment reading rules (Sprint 18e).
 *
 * The page must never turn an unknown into a zero, must never present a model inference as an
 * official rating, and must never spend a paid call on a preparation whose frozen method selection
 * or settings revision has moved. These cases pin exactly those decisions in the pure helpers, so
 * the component cannot drift from them by accident. No DOM, no API, no clock and no model.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssessmentModelEvidence } from '../../src/application/assessment-capture.js';
import type { CompetitionSummary } from '../../src/domain/official-rating.js';
import {
  ASSESSMENT_GENERATE_LABEL,
  ASSESSMENT_STATUS_LABELS,
  assessmentAnchorText,
  assessmentCancelText,
  assessmentErrorText,
  assessmentEvidenceRefText,
  assessmentPrepareProblem,
  assessmentRangeText,
  assessmentRunNote,
  assessmentRunProblem,
  assessmentStatusLabel,
  assessmentUsageBrief,
  assessmentUsageText,
  isAssessmentTerminal,
  officialRatingText,
  shouldPollAssessment,
  type AssessmentMethodIdentity,
} from '../../src/ui/assessment-view.js';

/** One complete competition summary; a case overrides only the field it is about. */
function summary(overrides: Partial<CompetitionSummary> = {}): CompetitionSummary {
  return {
    status: 'rated',
    rating: 1500,
    maxRating: 1600,
    ratedContests: 12,
    activity: 'recent',
    revision: 3,
    ...overrides,
  };
}

const METHOD: AssessmentMethodIdentity = { methodId: 'balanced-dual-axis', version: '1.0.0', methodHash: 'hash-a' };

function runCheck(overrides: Partial<Parameters<typeof assessmentRunProblem>[0]> = {}) {
  return assessmentRunProblem({
    viewMethodIds: [METHOD.methodId],
    viewMethods: [METHOD],
    selectedMethodIds: [METHOD.methodId],
    catalog: [METHOD],
    viewSettingsRevision: 7,
    currentSettingsRevision: 7,
    settingsUnread: false,
    ...overrides,
  });
}

void test('an unknown cost is never rendered as zero while a free preparation says so', () => {
  assert.equal(assessmentUsageText({ status: 'prepared', usage: null }), '未调用模型：免费准备，尚未产生费用。');
  assert.match(assessmentUsageText({ status: 'cancelled', usage: null }), /零调用、零计费/);
  const unknown = assessmentUsageText({ status: 'uncertain', usage: null });
  assert.match(unknown, /用量未知/);
  assert.equal(unknown.includes('合计'), false, 'an unreported usage has no token total');
  assert.match(unknown, /不会自动重试/);
  const reserved = assessmentUsageText({ status: 'reserved', usage: null });
  assert.match(reserved, /尚未结算/);
  assert.equal(reserved.includes('合计 0'), false);
  assert.match(
    assessmentUsageText({ status: 'settled', usage: { calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
    /合计 15 tokens/,
  );
  assert.match(assessmentUsageBrief({ status: 'uncertain', usage: null }), /可能已计费/);
  assert.equal(assessmentUsageBrief({ status: 'reserved', usage: null }), '待结算（费用未知）');
  assert.equal(assessmentUsageBrief({ status: 'prepared', usage: null }), '未调用模型');
  assert.equal(assessmentUsageBrief({ status: 'cancelled', usage: null }), '零调用、零计费');
});

void test('an official zero or negative rating stays a value while a missing one stays missing', () => {
  assert.match(officialRatingText(summary({ rating: 0, maxRating: 0 })), /官方当前 rating 0/);
  assert.match(officialRatingText(summary({ rating: -12, maxRating: 100 })), /官方当前 rating -12/);
  const unrated = officialRatingText(summary({ status: 'unrated', rating: null, maxRating: null, ratedContests: 0, activity: 'unknown' }));
  const notLoaded = officialRatingText(
    summary({ status: 'not_loaded', rating: null, maxRating: null, ratedContests: 0, activity: 'unknown', revision: 0 }),
  );
  assert.match(unrated, /没有 rated 比赛记录/);
  assert.match(notLoaded, /尚未同步官方 rating/);
  assert.notEqual(unrated, notLoaded);
  for (const text of [unrated, notLoaded, officialRatingText(null)]) {
    assert.equal(text.includes('rating 0'), false, 'a missing official rating is not a zero');
  }
});

void test('a report without a numeric estimate explains the anchor instead of inventing a range', () => {
  const none = assessmentRangeText({ range: null, anchor: { kind: 'none', officialRating: null, eligibleVirtualRuns: 0 } });
  assert.match(none, /没有客观数值锚点/);
  assert.equal(none.includes(' – '), false, 'no interval is fabricated');
  const anchored = assessmentRangeText({
    range: null,
    anchor: { kind: 'official_rating', officialRating: 0, eligibleVirtualRuns: 0 },
  });
  assert.match(anchored, /未给出数值区间/);
  assert.equal(anchored.includes('0 – '), false);
  assert.match(
    assessmentRangeText({ range: { min: 1630, max: 1780 }, anchor: { kind: 'official_rating', officialRating: 1650, eligibleVirtualRuns: 0 } }),
    /1630 – 1780/,
  );
  assert.match(assessmentRangeText({ range: null, anchor: { kind: 'virtual_performance', officialRating: null, eligibleVirtualRuns: 2 } }), /2 条独立虚拟赛记录/);
  assert.match(assessmentRangeText({ range: null, anchor: null }), /不按 0 处理/);
  assert.match(assessmentAnchorText({ kind: 'official_rating', officialRating: 0, eligibleVirtualRuns: 0 }), /rating 0/);
  assert.match(assessmentAnchorText({ kind: 'virtual_performance', officialRating: null, eligibleVirtualRuns: 2 }), /2 条独立且赛前未见题/);
  assert.match(assessmentAnchorText({ kind: 'none', officialRating: null, eligibleVirtualRuns: 0 }), /没有客观数值锚点/);
});

void test('a paid run is blocked by a changed selection, a missing or upgraded method and moved settings', () => {
  assert.deepEqual(runCheck(), { blocked: false, message: null });
  const deselected = runCheck({ selectedMethodIds: [] });
  assert.equal(deselected.blocked, true);
  assert.match(deselected.message ?? '', /必须重新免费准备/);
  const removed = runCheck({ catalog: [] });
  assert.match(removed.message ?? '', /已不在已安装列表中/);
  assert.match(removed.message ?? '', /不会自动替换方法/);
  const upgraded = runCheck({ catalog: [{ ...METHOD, version: '2.0.0', methodHash: 'hash-b' }] });
  assert.match(upgraded.message ?? '', /已变化/);
  assert.match(upgraded.message ?? '', /不会用新版本继续/);
  const moved = runCheck({ currentSettingsRevision: 8 });
  assert.match(moved.message ?? '', /第 7 版变为第 8 版/);
  assert.match(runCheck({ settingsUnread: true }).message ?? '', /无法确认设置版本/);
  assert.match(runCheck({ viewSettingsRevision: null }).message ?? '', /没有冻结设置版本/);
});

void test('the prepare button explains every reason it cannot prepare', () => {
  assert.match(
    assessmentPrepareProblem({ readPending: false, readFailed: false, methodCount: 2, selectedCount: 1, missing: ['gone'] }) ?? '',
    /已卸载或不可用/,
  );
  assert.match(
    assessmentPrepareProblem({ readPending: false, readFailed: true, methodCount: 2, selectedCount: 1, missing: [] }) ?? '',
    /读取失败/,
  );
  assert.match(
    assessmentPrepareProblem({ readPending: false, readFailed: false, methodCount: 0, selectedCount: 0, missing: [] }) ?? '',
    /没有可用的评估方法/,
  );
  assert.match(
    assessmentPrepareProblem({ readPending: false, readFailed: false, methodCount: 2, selectedCount: 0, missing: [] }) ?? '',
    /至少选择一个/,
  );
  assert.equal(assessmentPrepareProblem({ readPending: true, readFailed: false, methodCount: 0, selectedCount: 0, missing: [] }), null);
});

void test('report citations resolve to the captured human label, never to a guess', () => {
  const evidence = {
    evidence: [
      {
        evidenceRef: 'ev-official-rating',
        category: 'official_rating',
        label: '官方比赛评分（客观来源）',
        detail: '官方当前 rating 1650',
      },
    ],
  } as unknown as AssessmentModelEvidence;
  assert.match(assessmentEvidenceRefText('ev-official-rating', evidence), /官方比赛评分（客观来源）/);
  assert.match(assessmentEvidenceRefText('ev-missing', evidence), /不在本次采集的证据清单中/);
  assert.match(assessmentEvidenceRefText('ev-missing', null), /不在本次采集的证据清单中/);
});

void test('only a reserved attempt is polled and every acknowledgement states the real cost', () => {
  assert.equal(shouldPollAssessment('reserved'), true);
  for (const status of ['prepared', 'settled', 'uncertain', 'cancelled'] as const) {
    assert.equal(shouldPollAssessment(status), false, status);
    assert.ok(ASSESSMENT_STATUS_LABELS[status].length > 0);
  }
  assert.equal(isAssessmentTerminal('reserved'), false);
  assert.equal(isAssessmentTerminal('settled'), true);
  assert.equal(assessmentStatusLabel('prepared'), ASSESSMENT_STATUS_LABELS.prepared);
  assert.match(assessmentRunNote({ started: false, status: 'reserved', hasReport: false }), /没有重复扣费/);
  assert.match(assessmentRunNote({ started: true, status: 'reserved', hasReport: false }), /不会自动重试/);
  assert.match(assessmentRunNote({ started: true, status: 'settled', hasReport: true }), /保存了报告/);
  assert.match(assessmentRunNote({ started: true, status: 'uncertain', hasReport: false }), /可能已经计费/);
  assert.match(assessmentCancelText('reserved'), /结算记录为准/);
  assert.match(assessmentCancelText('cancelled'), /未产生费用/);
  assert.match(assessmentCancelText('settled'), /不能再取消/);
  assert.match(assessmentErrorText('conflict', 'fallback'), /重新免费准备/);
  assert.match(assessmentErrorText('settings_changed', 'fallback'), /只使用准备记录冻结的版本/);
  assert.match(assessmentErrorText('model_busy', 'fallback'), /取消/);
  assert.match(assessmentErrorText('timeout', 'fallback'), /结果未知/);
  assert.equal(assessmentErrorText('some_unknown_code', '回退文案'), '回退文案');
  assert.match(ASSESSMENT_GENERATE_LABEL, /调用模型一次/);
});
