/** Labels over the domain's three independent assessments, never a client-side rating estimate. */
import type { AbilityHistoryPeriod, AbilityPeriodAssessment, SourcePlatform } from '../domain/index.js';

/** Window wording follows the configured number of days, not a hard-coded display label. */
export function abilityHistoryLabel(period: AbilityHistoryPeriod, days: number): string {
  return period === 'all_time' ? '全部做题记录' : period === 'recent' ? '最近 ' + days + ' 天新通过' : days + ' 天以前通过';
}

/** Unknown and non-CF periods remain explicit instead of borrowing another period's estimate. */
export function abilityPeriodValue(period: AbilityPeriodAssessment, platform: SourcePlatform): string {
  if (period.solvedDistinct === 0) return '暂无通过记录';
  if (platform !== 'codeforces') return '原生难度参考（不换算 CF）';
  return period.baselineTrainingLevel === null ? '样本不足（' + period.eligibleDistinct + ' / ' + period.minimumSampleSize + '）'
    : '难度参考 ' + period.baselineTrainingLevel + ' 左右';
}
