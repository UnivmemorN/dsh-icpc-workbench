import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeAbilityAssessment } from '../../src/domain/index.js';
import { abilityHistoryLabel, abilityPeriodValue } from '../../src/ui/ability-history-view.js';

void test('history display names configured periods and never substitutes another period score', () => {
  const report = computeAbilityAssessment({ accountId: 'account:test', sourceInstanceId: 'codeforces:codeforces.com', platform: 'codeforces',
    problems: [], submissions: [], retrospectives: [], now: '2026-09-13T00:00:00.000Z' });
  const empty = report.history.periods[1]!;
  assert.equal(abilityHistoryLabel('all_time', 30), '全部做题记录');
  assert.equal(abilityHistoryLabel('recent', 30), '最近 30 天新通过');
  assert.equal(abilityHistoryLabel('earlier', 30), '30 天以前通过');
  assert.equal(abilityPeriodValue(empty, 'codeforces'), '暂无通过记录');
  assert.equal(abilityPeriodValue({ ...empty, solvedDistinct: 4, eligibleDistinct: 4 }, 'codeforces'), '样本不足（4 / 5）');
  assert.equal(abilityPeriodValue({ ...empty, solvedDistinct: 5, eligibleDistinct: 5, baselineTrainingLevel: 1700 }, 'codeforces'), '练习中位数 1700 左右');
  assert.equal(abilityPeriodValue({ ...empty, solvedDistinct: 5, eligibleDistinct: 5 }, 'luogu'), '原生难度参考（不换算 CF）');
});
