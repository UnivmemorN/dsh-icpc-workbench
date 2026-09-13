import { OfficialRating } from './OfficialRating.js';
import { AbilityCalibrationEditor } from './AbilityCalibration.js';
import { AbilityHistory } from './AbilityHistory.js';
import type { ApiWeaknessResult } from '../application/workbench-api.js';
import { Empty, Notice, Panel, Stats } from './common.js';
import {
  ABILITY_MODE_LABELS,
  ABILITY_NO_CONVERSION_NOTE,
  abilityCoverageLines,
  abilityEstimateHeadline,
  abilityExcludedText,
  abilityModeText,
  abilityNativeText,
  abilityPoolText,
  abilitySampleText,
} from './ability-view.js';

/** The ability assessment as the business API returns it; the UI invents no second model. */
export type AbilityViewData = ApiWeaknessResult['ability'];

/** Personal calibration and descriptive evidence, projected from the typed weakness response. */
export function Ability({ ability, onSaved }: { ability: AbilityViewData; onSaved: () => void }) {
  const estimate = ability.estimate;
  const estimated = estimate.status === 'estimated';
  return (
    <Panel title="能力评估与练习记录">
      <Notice>
        个人水平与练习选题是两个不同的量：基础题练得多、近期题目变简单，都不能据此降低能力评价。
        自动分使用官方比赛 rating，已保存的自评可作为计划的主要水平参考。{ABILITY_NO_CONVERSION_NOTE}
      </Notice>
      <OfficialRating key={ability.accountId} ability={ability} onSaved={onSaved} />
      <AbilityCalibrationEditor key={ability.accountId + ':' + ability.trainingReference.revision} ability={ability} onSaved={onSaved} />
      <AbilityHistory history={ability.history} platform={ability.platform} />
      <details>
        <summary>近期练习样本统计（描述性，不是实力评分）</summary>
        {estimated ? <>
          <Stats items={[
            { label: '练习难度中位数（取整）', value: estimate.baselineTrainingLevel },
            { label: '有效样本', value: estimate.sampleSize + ' 题' },
            { label: '练习样本 P25–P75', value: abilityPoolText(estimate.quartileBand) },
          ]} />
          <p className="icpc-muted">样本口径：{abilitySampleText(ability)}。此数值不作为计划的水平上限或下限。</p>
        </> : <Empty>{abilityEstimateHeadline(ability)}</Empty>}
      </details>

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
        。训练计划使用个人水平校准、聚合练习统计与真实候选题：发给模型的摘要只含聚合量，不含账号标识、提交明细或复盘笔记。
      </p>
    </Panel>
  );
}
