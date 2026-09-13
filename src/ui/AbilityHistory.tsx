import type { AbilityHistoryComparison, SourcePlatform } from '../domain/index.js';
import { abilityHistoryLabel, abilityPeriodValue } from './ability-history-view.js';

/** Always-visible whole-history/recent/earlier assessments; no period hides another period. */
export function AbilityHistory({ history, platform }: { history: AbilityHistoryComparison; platform: SourcePlatform }) {
  return (
    <section aria-label="历史与近期能力对照">
      <h3>历史与近期能力对照</h3>
      <p className="icpc-muted">
        全部记录会持续参与评估，即使近期样本已足够。按每题首次已知 AC 时间划分；
        旧题重复 AC 不会变成新题。各期所有有效题目均参与，已知使用提示或题解的题目排除。
      </p>
      <div className="icpc-history-grid">
        {history.periods.map(period => (
          <article className="icpc-history-card" key={period.period} aria-label={abilityHistoryLabel(period.period, history.recentWindowDays)}>
            <h3>{abilityHistoryLabel(period.period, history.recentWindowDays)}</h3>
            <strong className="icpc-history-value">{abilityPeriodValue(period, platform)}</strong>
            <p>已通过 {period.solvedDistinct} 题 · 有效难度样本 {period.eligibleDistinct} 题</p>
            <p>其中有效独立记录 {period.independentEligibleDistinct} 题</p>
            <p className="icpc-muted">已排除辅助 / 题解 {period.excludedDistinct} 题；其余缺少或无效难度 {period.missingOrInvalidRatingDistinct} 题。</p>
            {period.estimateStatus === 'estimated' && <p className="icpc-muted">
              估计样本四分位 {period.quartileBand?.min}–{period.quartileBand?.max}；
              {period.independentlyConfirmed ? '均有独立复盘' : '包含独立状态未知的 AC'}。
            </p>}
            <details>
              <summary>完成方式与原生难度</summary>
              <p>独立 {period.completionModes.independent} · 提示辅助 {period.completionModes.assisted} · 参考题解 {period.completionModes.solutionUsed} · 无复盘 {period.completionModes.unknown}</p>
              {period.nativeDifficulty.map(native => <p key={native.dimension} className="icpc-muted">
                {native.dimension}：{native.count} 题有值，{native.missing} 题缺失；
                P25 {native.p25 ?? '未知'} / 中位数 {native.median ?? '未知'} / P75 {native.p75 ?? '未知'}。
              </p>)}
            </details>
          </article>
        ))}
      </div>
      <p className="icpc-muted">
        CF 数值是这批练习难度的中位数取整，至少 5 道有效题才给出；全记录与更早记录反映历史积累，不等于当前比赛 rating。
        历史与近期差异也可能来自选题变化，不能直接判断进步或退步。没有复盘的 AC 不自动算独立完成。
      </p>
    </section>
  );
}
