import { useState } from 'react';
import type { ApiWeaknessResult } from '../application/workbench-api.js';
import { Empty, Notice, Panel } from './common.js';
import { barWidthPercent, histogramPeak, pickHistogramSeries } from './histogram.js';

/** Solved distribution as the business API returns it; no separate UI model is invented. */
export type SolvedDistributionData = ApiWeaknessResult['solvedDistribution'];

/**
 * Share text that never rounds a present sample down to a plain `0%`.
 *
 * Counts are always shown next to it, so a tiny nonzero share stays visible as `<0.1%` instead of
 * reading as "nothing".
 */
export function shareText(part: number, total: number): string {
  if (total <= 0) {
    return '—';
  }
  if (part <= 0) {
    return '0%';
  }
  const share = (part / total) * 100;
  if (share < 0.1) {
    return '<0.1%';
  }
  return share.toFixed(share < 10 ? 1 : 0) + '%';
}

/**
 * Shared solved-problem distribution (Today + Weakness).
 *
 * One horizontal bar row per numeric bucket plus an explicit unknown row: bars are CSS only, every
 * count is printed verbatim, and the same numbers are readable as a table. The original dimension
 * label is always shown; when a source reports several dimensions the caller can switch series and
 * no series is ever merged into a shared scale. The bar length is exactly `count / peak * 100`, so
 * a small bucket stays visibly small instead of being inflated to a readable minimum, and the
 * unknown row always carries its own class. Counts are accepted submissions imported for this
 * account (one per distinct problem); only the dimension value itself is unreviewed platform data.
 */
export function SolvedDistribution({ distribution }: { distribution: SolvedDistributionData }) {
  const [picked, setPicked] = useState<string | null>(null);
  const dimensions = distribution.dimensions;
  const active = pickHistogramSeries(dimensions, picked);
  const total = distribution.totalSolved;
  const unknown = active?.unknownCount ?? 0;
  const rated = active?.knownCount ?? 0;
  const peak = active === null ? 1 : histogramPeak(active);
  const bar = (count: number) => (
    <span className="icpc-hist-bar" aria-hidden="true">
      <span className="icpc-hist-fill" style={{ width: barWidthPercent(count, peak) + '%' }} />
    </span>
  );
  const picker =
    dimensions.length > 1 ? (
      <label className="icpc-hist-pick">
        原始难度维度
        <select value={active?.dimension ?? ''} onChange={(event) => setPicked(event.target.value)}>
          {dimensions.map((entry) => (
            <option key={entry.dimension} value={entry.dimension}>
              {entry.dimension}
            </option>
          ))}
        </select>
      </label>
    ) : undefined;
  return (
    <Panel title="已通过题目分布" tools={picker}>
      <p className="icpc-hist-summary">
        共通过 <strong>{total}</strong> 道不同题目（按已导入的 AC 记录去重）；维度{' '}
        <strong>{active?.dimension ?? '—'}</strong> 有数值 <strong>{rated}</strong> 道，未知 <strong>{unknown}</strong>{' '}
        道。（未知含本地题目元数据缺失。）
      </p>
      {total === 0 ? (
        <Empty>还没有通过记录，暂时无法绘制难度分布。</Empty>
      ) : active === null ? (
        <Empty>这个来源没有报告可用的难度维度。</Empty>
      ) : (
        <>
          {rated === 0 && (
            <Notice>当前维度的通过题目全部没有可用数值，只能全部记为未知；柱状图仍如实显示样本大小。</Notice>
          )}
          {distribution.metadataMissingSolved > 0 && (
            <Notice>
              其中 {distribution.metadataMissingSolved} 道通过题目缺少本地题目元数据，无法读取任何平台难度。
            </Notice>
          )}
          <div className="icpc-table-wrap">
            <table className="icpc-hist-table">
              <thead>
                <tr>
                  <th>难度值（{active.dimension}）</th>
                  <th>通过题数</th>
                  <th>占通过题数</th>
                </tr>
              </thead>
              <tbody>
                {active.buckets.map((bucket) => (
                  <tr key={bucket.value}>
                    <td>{bucket.value}</td>
                    <td>
                      {bar(bucket.count)}
                      {bucket.count}
                    </td>
                    <td>{shareText(bucket.count, total)}</td>
                  </tr>
                ))}
                <tr className="icpc-hist-unknown">
                  <td>未知</td>
                  <td>
                    {bar(unknown)}
                    {unknown}
                  </td>
                  <td>{shareText(unknown, total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="icpc-muted">
            柱长表示通过题目数，按平台原始难度统计；不同平台的刻度不合并。
          </p>
        </>
      )}
    </Panel>
  );
}
