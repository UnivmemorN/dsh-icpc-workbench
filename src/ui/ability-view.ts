/**
 * Reading rules of the ability view (Sprint 11a).
 *
 * Pure label/format helpers over the one `weakness` response: no DOM, no store, no clock and no
 * network. They exist so the Chinese copy a user reads — including every "missing data" branch —
 * can be pinned by tests without rendering React, and so the panel cannot silently turn a missing
 * value into a number.
 */
import type { ApiWeaknessResult } from '../application/workbench-api.js';
import type { AbilityCompletionMode, AbilityEstimateBasis, AbilityConfidence } from '../domain/index.js';

export type AbilityViewData = ApiWeaknessResult['ability'];
export type AbilityEstimateView = AbilityViewData['estimate'];
export type AbilityNativeView = AbilityViewData['nativeDifficulty'][number];
export type AbilityModeCountsView = AbilityViewData['completionModes']['allTime'];

/** Sample-tier labels; an estimate only ever uses one of these three tiers. */
export const ABILITY_BASIS_LABELS: Readonly<Record<AbilityEstimateBasis, string>> = {
  recent_independent: '最近 90 天独立完成',
  recent_observed: '最近 90 天通过（是否独立未知）',
  historical: '更早的历史记录（可能过时）',
};

/** Confidence labels; the heuristic itself is unvalidated, so the top label is only "中低". */
export const ABILITY_CONFIDENCE_LABELS: Readonly<Record<AbilityConfidence, string>> = {
  low: '低（临时估计）',
  medium: '中低（未经验证的启发式）',
};

/** Completion-mode labels; `unknown` means "no retrospective was recorded". */
export const ABILITY_MODE_LABELS: Readonly<Record<AbilityCompletionMode, string>> = {
  independent: '独立完成',
  assisted: '提示辅助',
  solution_used: '参考题解',
  unknown: '无复盘（独立状态未知）',
};

export const ABILITY_NO_DATA_NOTE = '数据不足时返回“未知”，不会显示 0 分或“新手”结论。';
export const ABILITY_NO_CONVERSION_NOTE =
  '不同平台的难度是各自的原生刻度，本页不做换算；非 Codeforces 平台只展示原生分位数，不给出 CF 训练难度带。';
export const ABILITY_OFFICIAL_RATING_LINK_TEXT = 'Codeforces API：用户 rating 与题目 rating 的区别';

/**
 * `true` when a non-Codeforces report carries real native difficulty values.
 *
 * The CF training band does not apply to those platforms, so the page says "native scale only"
 * instead of the generic "insufficient data" — while a platform that really has no usable value
 * still falls through to the honest missing-sample wording.
 */
export function abilityNativeScaleOnly(ability: AbilityViewData): boolean {
  return ability.platform !== 'codeforces' && ability.nativeDifficulty.some((row) => row.count > 0);
}

/** Compact summary value for the page-level Stats row. */
export function abilityStatValue(ability: AbilityViewData): string {
  if (ability.trainingReference.source === 'official_rating') return String(ability.trainingReference.range?.min) + '（CF 官方 rating）';
  if (ability.trainingReference.range) return abilityPoolText(ability.trainingReference.range) + '（用户自评）';
  if (abilityNativeScaleOnly(ability)) return '原生刻度评估（CF 估计不适用）';
  return '个人水平待校准';
}

/** One headline; the unknown branch names the sample instead of inventing a band. */
export function abilityEstimateHeadline(ability: AbilityViewData): string {
  const estimate = ability.estimate;
  if (estimate.status === 'estimated' && estimate.baselineTrainingLevel !== null) {
    return `练习难度中位数 ${estimate.baselineTrainingLevel}（不是实力评分）（四分位区间 ${abilityPoolText(estimate.quartileBand)}）`;
  }
  if (abilityNativeScaleOnly(ability)) {
    const native = ability.nativeDifficulty.reduce((total, row) => total + row.count, 0);
    return `原生刻度评估：该平台不是 Codeforces，只展示它自己的原生难度分布（${native} 题有数值）；CF 训练难度估计不适用。`;
  }
  return `暂不给出训练难度带：有效样本 ${estimate.sampleSize} / ${estimate.minimumSampleSize}。${ABILITY_NO_DATA_NOTE}`;
}

/** One numeric range; `null` prints an explicit "未给出" instead of `0 – 0`. */
export function abilityPoolText(range: { readonly min: number; readonly max: number } | null): string {
  return range === null ? '未给出' : `${range.min} – ${range.max}`;
}

/** Basis label; `null` means no tier reached the sample gate. */
export function abilityBasisLabel(basis: AbilityEstimateBasis | null): string {
  return basis === null ? '无可用样本' : ABILITY_BASIS_LABELS[basis];
}

/** Sample line: used count, gate and the tier that produced it. */
export function abilitySampleText(ability: AbilityViewData): string {
  const estimate = ability.estimate;
  return `${estimate.sampleSize} / ${estimate.minimumSampleSize} 题（${abilityBasisLabel(estimate.basis)}）`;
}

/** One native-dimension line; every missing value is named instead of printed as a number. */
export function abilityNativeText(row: AbilityNativeView): string {
  if (row.count === 0 && row.missing === 0) {
    return `${row.dimension}：还没有已通过题，暂无可展示的原生难度分布。`;
  }
  if (row.count === 0) {
    return `${row.dimension}：${row.missing} 道已通过题都没有可用的数值，无法给出分位数。`;
  }
  const p25 = row.p25 === null ? '缺失' : String(row.p25);
  const median = row.median === null ? '缺失' : String(row.median);
  const p75 = row.p75 === null ? '缺失' : String(row.p75);
  const range = row.min === null || row.max === null ? '缺失' : `${row.min} – ${row.max}`;
  const sufficiency = row.sufficientSamples ? '' : '；样本不足，仅作描述';
  return `${row.dimension}：${row.count} 题有数值、${row.missing} 题缺失；范围 ${range}；P25 ${p25} / 中位数 ${median} / P75 ${p75}${sufficiency}`;
}

/** One line naming every completion mode, including the explicit unknown bucket. */
export function abilityModeText(counts: AbilityModeCountsView): string {
  return (
    `${ABILITY_MODE_LABELS.independent} ${counts.independent} · ` +
    `${ABILITY_MODE_LABELS.assisted} ${counts.assisted} · ` +
    `${ABILITY_MODE_LABELS.solution_used} ${counts.solutionUsed} · ` +
    `${ABILITY_MODE_LABELS.unknown} ${counts.unknown}`
  );
}

/** Exclusion line: known assisted / solution-used problems are counted, never silently dropped. */
export function abilityExcludedText(ability: AbilityViewData): string {
  const excluded = ability.excludedFromEstimate;
  if (excluded.total === 0) {
    return '没有被排除的已通过题：所有已记录完成方式的题目都按规则参与了样本筛选。';
  }
  return `已从难度估计中排除 ${excluded.total} 道已知非独立完成的题（提示辅助 ${excluded.assistedDistinct}、参考题解 ${excluded.solutionUsedDistinct}），它们只单独计数。`;
}

/** Coverage lines: counts, the first-AC recency rule and every excluded row. */
export function abilityCoverageLines(ability: AbilityViewData): readonly string[] {
  const coverage = ability.coverage;
  const lines = [
    `尝试 ${coverage.distinctAttempted} 题，通过 ${coverage.distinctSolved} 题。`,
    `最近 ${coverage.recentWindowDays} 天：新通过（首次 AC 在窗口内）${ability.last90Days.newSolvedDistinct} 题；旧题重复 AC ${ability.last90Days.repeatedAcDistinct} 题，不重复计入新通过。`,
    `缺少本地题目元数据 ${coverage.metadataMissing} 题；已通过题缺少可用原生难度数值 ${coverage.solvedWithoutNativeValue} 题。`,
    `没有复盘的已通过题 ${coverage.solvedWithoutRetrospective} 题（独立状态未知）。`,
    `已排除未来时间戳的提交 ${coverage.futureSubmissionsExcluded} 条、其他账号的提交 ${coverage.foreignSubmissionsExcluded} 条、未来复盘 ${coverage.futureRetrospectivesExcluded} 条。`,
  ];
  if (coverage.metadataMissing > 0 || coverage.solvedWithoutNativeValue > 0) {
    lines.push('缺少的元数据或难度数值可以到「账号与同步」补齐后再评估。');
  }
  return lines;
}
