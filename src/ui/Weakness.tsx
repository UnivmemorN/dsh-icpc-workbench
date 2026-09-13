import { useEffect, useState } from 'react';
import { Panel, Notice, Empty, ErrorNotice, useRequest, useWorkbench, Stats, tagName } from './common.js';
import { Ability } from './Ability.js';
import { abilityStatValue } from './ability-view.js';
import { Knowledge } from './Knowledge.js';
import { SolvedDistribution, shareText } from './SolvedDistribution.js';

/**
 * Four explicit readings of the same evidence: the local ability heuristic, per technique node,
 * raw platform labels and the reviewed analysis.
 */
type WeaknessView = 'ability' | 'knowledge' | 'platform' | 'verified';

/**
 * Weakness page. The reading order is deliberate: heading → summary Stats → view switch (with the
 * collapsed coverage diagnosis beside it) → the selected content → the full solved-problem
 * histogram. The default view is the ability assessment, because "which training difficulty does my
 * history support?" is the first question the evidence should answer; it is a transparent local
 * heuristic with its own sample and caveats, never an official rating. The knowledge view (same
 * evidence per technique node), the platform reference and the reviewed analysis keep their previous
 * content one click away, so the ranking that answers "where am I weak" is never lost. Provisional
 * numbers never replace formal evidence, and the view switch is local and costs no request.
 */
export function Weakness() {
  const { accountId, boot, navigate } = useWorkbench();
  const read = useRequest('weakness', accountId ? { accountId } : null);
  const data = read.data;
  const [picked, setPicked] = useState<WeaknessView | null>(null);
  // A new account starts from its own default view instead of the previous account's selection.
  useEffect(() => setPicked(null), [accountId]);
  const platformTags = data?.platformTagStats.tags ?? [];
  const attempted = data?.report.attemptedDistinctTotal ?? 0;
  const platformTagged = data?.platformTagStats.attemptedTaggedDistinct ?? 0;
  const formalTagged = data?.report.taggedAttemptedDistinct ?? 0;
  // The ability assessment is the landing view: it reuses this read and gives the transparent
  // training-difficulty reference; the three previous views stay one click away with unchanged
  // content.
  const view: WeaknessView = picked ?? 'ability';
  const tagless = Math.max(0, (data?.coverage.metadataPresent ?? 0) - platformTagged);
  const diagnosis: string[] = [];
  if (data) {
    if (data.coverage.submissionRows === 0) {
      diagnosis.push('该账号还没有提交记录：任何统计都无法开始，请先到题库 > 导入与同步导入提交。');
    } else {
      if (data.coverage.metadataMissing > 0) {
        diagnosis.push(
          `${data.coverage.metadataMissing} / ${data.coverage.distinctProblems} 道尝试题缺少本地题目元数据：它们仍计入分母，但带不上标签或难度。`,
        );
      }
      if (tagless > 0) {
        diagnosis.push(`${tagless} / ${data.coverage.metadataPresent} 道有元数据的尝试题没有平台原始标签。`);
      }
      if (platformTagged === 0) {
        diagnosis.push('所有尝试题都没有平台原始标签，平台标签参考为空，不能据此推断任何方向。');
      }
      if (formalTagged === 0) {
        diagnosis.push('还没有任何已复核（有效）标签，所以已复核排名为空。');
      } else if (data.report.ranking.length === 0) {
        diagnosis.push(
          `已有 ${formalTagged} 道题带有效标签，但每个标签的尝试题都少于 ${data.platformTagStats.minimumSampleSize} 道，暂不进入已复核排名。`,
        );
      }
      if (data.report.insufficientEvidence.length > 0) {
        diagnosis.push(
          `${data.report.insufficientEvidence.length} 个标签的样本仍不足 ${data.platformTagStats.minimumSampleSize} 道，见“样本仍不足的方向”。`,
        );
      }
    }
  }
  return (
    <>
      <div className="icpc-page-heading">
        <div>
          <p className="icpc-eyebrow">LEARNING EVIDENCE</p>
          <h1>知识点与薄弱项</h1>
          <p>
            同一道题的多次提交只算一道；每个标签至少 5 道尝试题才进入已复核排名。平台原始标签只作参考，不算已接受标签。
            个人水平参考来自已同步的官方比赛分或用户自评；做题难度只描述练习分布，不能当作选手实力。
          </p>
        </div>
      </div>
      {!accountId ? (
        <Empty>请先选择账号，再导入该账号的提交记录。</Empty>
      ) : (
        <>
          <ErrorNotice error={read.error} />
          <button onClick={read.refresh}>刷新统计</button>
          {read.pending && <p>正在计算本地记录…</p>}
          {data && (
            <>
              <Stats
                items={[
                  { label: '个人水平参考', value: abilityStatValue(data.ability) },
                  { label: '尝试过的不同题目', value: attempted },
                  { label: '已通过题目', value: data.report.solvedDistinctTotal },
                  { label: '已复核标签覆盖（占尝试题）', value: `${formalTagged} / ${attempted}` },
                  { label: '平台原始标签覆盖（占尝试题）', value: `${platformTagged} / ${attempted}` },
                ]}
              />
              <div className="icpc-viewswitch" role="group" aria-label="统计视图">
                <button type="button" aria-pressed={view === 'ability'} onClick={() => setPicked('ability')}>
                  能力评估
                </button>
                <button type="button" aria-pressed={view === 'knowledge'} onClick={() => setPicked('knowledge')}>
                  知识点掌握情况
                </button>
                <button type="button" aria-pressed={view === 'platform'} onClick={() => setPicked('platform')}>
                  平台标签参考（未复核）
                </button>
                <button type="button" aria-pressed={view === 'verified'} onClick={() => setPicked('verified')}>
                  已复核分析
                </button>
              </div>
              <details className="icpc-coverage">
                <summary>
                  覆盖率诊断：已复核标签 {formalTagged} / {attempted}（{shareText(formalTagged, attempted)}）· 平台原始标签{' '}
                  {platformTagged} / {attempted}（{shareText(platformTagged, attempted)}）
                </summary>
                <div className="icpc-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>口径</th>
                        <th>有标签题目 / 尝试题</th>
                        <th>占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>已复核（有效标签）</td>
                        <td>
                          {formalTagged} / {attempted}
                        </td>
                        <td>{shareText(formalTagged, attempted)}</td>
                      </tr>
                      <tr>
                        <td>平台原始标签（未复核）</td>
                        <td>
                          {platformTagged} / {attempted}
                        </td>
                        <td>{shareText(platformTagged, attempted)}</td>
                      </tr>
                      <tr>
                        <td>缺少本地题目元数据</td>
                        <td>
                          {data.coverage.metadataMissing} / {data.coverage.distinctProblems}
                        </td>
                        <td>{shareText(data.coverage.metadataMissing, data.coverage.distinctProblems)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {diagnosis.length > 0 && (
                  <ul className="icpc-diagnosis">
                    {diagnosis.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                <p>
                  缺少的本地题目元数据可以在 <strong>题库 &gt; 导入与同步 &gt; 题目目录</strong> 补齐；部分题目仍然需要手工材料。
                </p>
                <p>
                  先在题库选择候选题，再到 <strong>标签审核</strong> 准备和复核标签。本页只做跳转，不会自动准备标签，也不会自动运行模型。
                </p>
                <div className="icpc-actions">
                  <button onClick={() => navigate('bank')}>去题库导入与同步</button>
                  <button onClick={() => navigate('review')}>去标签审核</button>
                </div>
              </details>
              {view === 'ability' ? (
                <Ability ability={data.ability} onSaved={read.refresh} />
              ) : view === 'knowledge' ? (
                <Knowledge knowledge={data.knowledge} coverage={data.coverage} />
              ) : view === 'platform' ? (
                <Panel title="平台标签参考（未复核）">
                  <Notice>
                    这些标签是平台原始数据，未经复核，也不是已接受的标签。原始标签可能不完整、口径不同或与训练方向不一致，据此判断薄弱项可能失真；它们不会成为正式标签，也不改变“已复核分析”。AI 计划只会在候选题里把它们当作临时参考一并发送，而且需要显式开启剧透才会显示。
                  </Notice>
                  {platformTags.length === 0 ? (
                    <Empty>
                      该账号的尝试题还没有平台原始标签。可以到题库导入与同步补齐题目目录；平台本身缺标签的题目只能等平台或手工材料补充。
                    </Empty>
                  ) : (
                    <div className="icpc-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>平台原始标签</th>
                            <th>通过 / 尝试</th>
                            <th>未确认通过</th>
                            <th>通过率</th>
                            <th>样本</th>
                          </tr>
                        </thead>
                        <tbody>
                          {platformTags.map((tag) => (
                            <tr key={tag.rawTag}>
                              <td>{tag.rawTag}</td>
                              <td>
                                {tag.solvedDistinct} / {tag.attemptedDistinct}
                              </td>
                              <td>{tag.unconfirmedDistinct}</td>
                              <td>{shareText(tag.solvedDistinct, tag.attemptedDistinct)}</td>
                              <td>
                                {tag.sufficientEvidence
                                  ? `≥ ${data.platformTagStats.minimumSampleSize} 题`
                                  : `不足 ${data.platformTagStats.minimumSampleSize} 题`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="icpc-muted">
                    同一道题可以带多个平台标签，因此各标签的尝试数之和会大于尝试题总数；这不是“一道题只属于一个方向”的划分，平台标签也不代表你已掌握该方向。
                  </p>
                </Panel>
              ) : (
                <>
                  <Panel title="需要优先练习的方向">
                    {data.report.ranking.length === 0 ? (
                      <Empty>当前还没有达到样本门槛的已复核标签，暂不排列薄弱项。</Empty>
                    ) : (
                      <div className="icpc-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>方向</th>
                              <th>通过 / 尝试</th>
                              <th>通过率</th>
                              <th>平台原始难度</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.report.ranking.map((tag) => (
                              <tr key={tag.taxonomyId}>
                                <td>{tagName(tag.taxonomyId, boot)}</td>
                                <td>
                                  {tag.solvedDistinct} / {tag.sampleSize}
                                </td>
                                <td>
                                  <meter min="0" max="1" value={tag.solveRate} />
                                  <span> {shareText(tag.solvedDistinct, tag.sampleSize)}</span>
                                </td>
                                <td>
                                  {tag.ratingSummary
                                    .map(
                                      (entry) =>
                                        entry.dimension +
                                        ' 中位数 ' +
                                        entry.median +
                                        '（' +
                                        entry.min +
                                        '–' +
                                        entry.max +
                                        '，' +
                                        entry.sampleSize +
                                        ' 题）',
                                    )
                                    .join('；') || '未提供'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>
                  <Panel title="样本仍不足的方向">
                    {data.report.insufficientEvidence.length === 0 ? (
                      <Empty>暂无此类样本。</Empty>
                    ) : (
                      <div className="icpc-tags">
                        {data.report.insufficientEvidence.map((tag) => (
                          <span key={tag.taxonomyId} className="icpc-tag">
                            {tagName(tag.taxonomyId, boot)} · {tag.sampleSize} / {tag.minimumSampleSize} 题
                          </span>
                        ))}
                      </div>
                    )}
                  </Panel>
                  <Panel title="自己记录的完成方式">
                    <Stats
                      items={[
                        { label: '独立完成', value: data.report.confirmedSkills.independent },
                        { label: '提示辅助', value: data.report.confirmedSkills.assisted },
                        { label: '参考题解', value: data.report.confirmedSkills.solutionUsed },
                        { label: '复盘题数', value: data.report.confirmedSkills.total },
                      ]}
                    />
                    <p>这些记录来自你填写的复盘。通过一道题不会自动确认掌握它的所有解法。</p>
                    <div className="icpc-tags">
                      {data.report.confirmedSkills.taxonomyIds.map((id) => (
                        <span key={id} className="icpc-tag">
                          {tagName(id, boot)}
                        </span>
                      ))}
                    </div>
                  </Panel>
                </>
              )}
              <SolvedDistribution distribution={data.solvedDistribution} />
              <Notice>
                提交 {data.coverage.submissionRows} 条；缺失题目元数据 {data.coverage.metadataMissing} 题；已排除过期 AI 标签{' '}
                {data.coverage.staleAiDecisionsExcluded} 条。通过题数只来自已导入的 AC 记录（同一题多次提交去重）；平台标签与平台难度数值是平台未复核数据，仅作参考。
              </Notice>
              <div className="icpc-actions">
                <button onClick={() => navigate('bank')}>补充记录与选择候选题</button>
                <button className="icpc-primary" onClick={() => navigate('plans')}>
                  制定训练计划
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
