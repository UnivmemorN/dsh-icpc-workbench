import { AbilityHistory } from './AbilityHistory.js';
import type { ApiWeaknessResult } from '../application/workbench-api.js';
import { Empty, ExternalLink, Notice, Panel, Stats } from './common.js';
import {
  ABILITY_CONFIDENCE_LABELS,
  ABILITY_MODE_LABELS,
  ABILITY_NO_CONVERSION_NOTE,
  ABILITY_OFFICIAL_RATING_LINK_TEXT,
  abilityCoverageLines,
  abilityEstimateHeadline,
  abilityExcludedText,
  abilityModeText,
  abilityNativeScaleOnly,
  abilityNativeText,
  abilityPoolText,
  abilitySampleText,
} from './ability-view.js';

/** The ability assessment as the business API returns it; the UI invents no second model. */
export type AbilityViewData = ApiWeaknessResult['ability'];

/**
 * Ability-assessment panel: the transparent local training-difficulty reference.
 *
 * The panel renders the domain report as-is — baseline, quartile band and pools, the sample and its
 * tier, the completion modes, the native difficulty distribution, the coverage gaps and the Chinese
 * caveats. Nothing here calls the network, a store or a model: the panel is a pure projection of the
 * `weakness` response the page already holds. A missing estimate is shown as "数据不足" with the
 * sample that missed the gate, never as a zero band, and the official account rating is stated to be
 * not loaded, with the platform page that explains user rating vs. problem rating.
 */
export function Ability({ ability }: { ability: AbilityViewData }) {
  const estimate = ability.estimate;
  const estimated = estimate.status === 'estimated';
  return (
    <Panel title="能力评估（本地启发式，非官方 rating）">
      <Notice>
        该评估只使用本地导入的题目难度与复盘记录：有效样本（已通过、带原生难度数值且非已知辅助/参考题解）达到{' '}
        {estimate.minimumSampleSize} 道才给出训练难度带；数据不足时显示“未知”，不会给出 0 分或“新手”结论。
        {ABILITY_NO_CONVERSION_NOTE} 官方账号 rating 未加载（
        <ExternalLink href={ability.officialRating.apiHelpUrl}>{ABILITY_OFFICIAL_RATING_LINK_TEXT}</ExternalLink>
        ）。
      </Notice>
      <AbilityHistory history={ability.history} platform={ability.platform} />
      <h3>近期训练建议（近期不足时参考历史）</h3>
      {estimated ? (
        <>
        <Stats
          items={[
            { label: '训练难度基线', value: `${estimate.baselineTrainingLevel} 左右` },
            { label: '有效样本', value: `${estimate.sampleSize} 题` },
            { label: '基线练习区间', value: abilityPoolText(estimate.baselinePool) },
            { label: '拔高练习区间', value: abilityPoolText(estimate.stretchPool) },
            { label: '四分位区间', value: abilityPoolText(estimate.quartileBand) },
            {
              label: '置信度',
              value: estimate.confidence === null ? '未知' : estimate.confidence === 'medium' ? '中低' : '低',
            },
          ]}
        />
        <p className="icpc-muted">依据：{abilitySampleText(ability)}；置信度：{estimate.confidence === null ? '未知' : ABILITY_CONFIDENCE_LABELS[estimate.confidence]}。</p>
        </>
      ) : (
        <>
          <Empty>{abilityEstimateHeadline(ability)}</Empty>
          {abilityNativeScaleOnly(ability) ? (
            <p className="icpc-muted">
              该平台只提供自己的原生难度刻度：请以下方的“原生难度分布”分位数为准，CF 训练难度带不适用于该平台；
              官方账号 rating 仍未加载。
            </p>
          ) : (
            <p className="icpc-muted">
              当前有效样本 {estimate.sampleSize} / {estimate.minimumSampleSize} 道：补齐题目元数据、难度数值与复盘后可以重新评估。
            </p>
          )}
        </>
      )}

      <h3>已通过题的完成方式（每题只取最新复盘）</h3>
      <Stats
        items={[
          { label: ABILITY_MODE_LABELS.independent, value: ability.completionModes.allTime.independent },
          { label: ABILITY_MODE_LABELS.assisted, value: ability.completionModes.allTime.assisted },
          { label: ABILITY_MODE_LABELS.solution_used, value: ability.completionModes.allTime.solutionUsed },
          { label: ABILITY_MODE_LABELS.unknown, value: ability.completionModes.allTime.unknown },
        ]}
      />
      <p className="icpc-muted">
        {abilityModeText(ability.completionModes.allTime)}；最近 {ability.coverage.recentWindowDays} 天新通过{' '}
        {ability.last90Days.newSolvedDistinct} 题（旧题重复 AC {ability.last90Days.repeatedAcDistinct} 题不计入新通过）。通过（AC）不等于独立完成，只有复盘能说明完成方式。
      </p>
      <p>{abilityExcludedText(ability)}</p>

      <h3>原生难度分布（描述性，不做跨平台换算）</h3>
      {ability.nativeDifficulty.length === 0 ? (
        <Empty>还没有已通过题，暂无可展示的原生难度分布。</Empty>
      ) : (
        <>
          <div className="icpc-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>维度</th>
                  <th>数值样本</th>
                  <th>缺失</th>
                  <th>最小</th>
                  <th>P25</th>
                  <th>中位数</th>
                  <th>P75</th>
                  <th>最大</th>
                </tr>
              </thead>
              <tbody>
                {ability.nativeDifficulty.map((row) => (
                  <tr key={row.dimension}>
                    <td>{row.dimension}</td>
                    <td>{row.count}</td>
                    <td>{row.missing}</td>
                    <td>{row.min ?? '缺失'}</td>
                    <td>{row.p25 ?? '缺失'}</td>
                    <td>{row.median ?? '缺失'}</td>
                    <td>{row.p75 ?? '缺失'}</td>
                    <td>{row.max ?? '缺失'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="icpc-diagnosis">
            {ability.nativeDifficulty.map((row) => (
              <li key={row.dimension}>{abilityNativeText(row)}</li>
            ))}
          </ul>
        </>
      )}

      <h3>覆盖与数据缺口</h3>
      <ul className="icpc-diagnosis">
        {abilityCoverageLines(ability).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <details className="icpc-coverage">
        <summary>证据说明与已知限制（{ability.reasons.length} 条）</summary>
        <ul className="icpc-diagnosis">
          {ability.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </details>
      <p className="icpc-muted">
        报告版本 {ability.version} · 启发式版本 {estimate.heuristicVersion} · 计算时间 {ability.computedAt}
        。训练计划使用这里的聚合能力统计与真实候选题：发给模型的摘要只含聚合量，不含账号标识、提交明细或复盘笔记。
      </p>
    </Panel>
  );
}
