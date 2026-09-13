import { useState } from 'react';
import type { AbilityAssessment } from '../domain/index.js';
import { api } from './api.js';
import { ErrorNotice, ExternalLink, Stats, useAction } from './common.js';
/** Official result and history remain visibly separate from self-report and practice statistics. */
export function OfficialRating({ ability, onSaved }: { ability: AbilityAssessment; onSaved: () => void }) {
  const action = useAction();
  const [visible, setVisible] = useState(20);
  if (ability.platform !== 'codeforces') return null;
  const official = ability.officialRating;
  const history = [...official.history].reverse();
  async function refresh() {
    const result = await action.run(signal => api.request('ability.syncRating', { accountId: ability.accountId }, signal));
    if (result) onSaved();
  }
  return <section aria-label="官方比赛评分">
    <h3>自动评分 · Codeforces 官方比赛分</h3>
    <Stats items={[
      { label: '官方当前 rating', value: official.rating ?? (official.status === 'unrated' ? '未评级' : '未同步') },
      { label: '官方历史最高', value: official.maxRating ?? '暂无' },
      { label: 'Rated 比赛', value: official.status === 'not_loaded' ? '未同步' : official.ratedContests + ' 场' },
      { label: '最近评分日期', value: history[0]?.ratedAt.slice(0, 10) ?? '暂无' },
    ]} />
    <p>{official.note}</p>
    <p className="icpc-muted">自动分采用 CF 官网当前 rating，不把练习中位数、最高 AC 题目或历史最高 rating 换算成当前实力。个人自评单独保存；已保存的自评优先用于训练计划。</p>
    <button type="button" onClick={() => void refresh()} disabled={action.busy}>{action.busy ? '正在同步评分与比赛历史…' : '同步 CF 评分'}</button>
    <span className="icpc-muted"> 免费读取 CF 公开 API，不调用 AI。</span>
    <ErrorNotice error={action.error} />
    {official.fetchedAt && <p className="icpc-muted">最近成功同步：{new Date(official.fetchedAt).toLocaleString()} · 快照版本 {official.revision}</p>}
    {history.length > 0 && <details><summary>比赛评分历史（{history.length} 场）</summary>
      <div className="icpc-table-wrap"><table><thead><tr><th>比赛</th><th>评分日期</th><th>名次</th><th>赛前</th><th>赛后</th><th>变化</th></tr></thead>
        <tbody>{history.slice(0, visible).map(row => <tr key={row.contestId}>
          <td><ExternalLink href={'https://codeforces.com/contest/' + row.contestId}>{row.contestName}</ExternalLink></td>
          <td>{row.ratedAt.slice(0, 10)}</td><td>{row.rank}</td><td>{row.oldRating}</td><td>{row.newRating}</td><td>{row.newRating - row.oldRating > 0 ? '+' : ''}{row.newRating - row.oldRating}</td>
        </tr>)}</tbody></table></div>
      {visible < history.length && <button type="button" onClick={() => setVisible(n => n + 20)}>显示更早 20 场</button>}
    </details>}
    <details><summary>评分方法与思路来源</summary>
      <p>CF 题目 rating 的概率解释以比赛为前提。平时练习缺少统一时间限制，且可能参考题解，因此本项目不把最终 AC 当成 Elo 胜负。</p>
      <p>参考原工作台对个人校准与练习证据的分开展示；其近 60 天 AC 中位数算法只适合描述选题，本项目不将它作为能力分。</p>
      <p><ExternalLink href="https://codeforces.com/apiHelp/methods#user.rating">CF 官方评分 API</ExternalLink> · <ExternalLink href="https://codeforces.com/blog/entry/62865">CF 题目难度说明</ExternalLink> · <ExternalLink href="https://github.com/ZF3373/icpc-workbench/blob/ac4a2e0920e07a9d5abde8cee54ac8aa8a3a5fa7/server/src/today/ability.ts">原工作台评估实现（MIT）</ExternalLink></p>
    </details>
  </section>;
}
