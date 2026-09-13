import { useState } from 'react';
import type { AbilityAssessment } from '../domain/index.js';
import { api } from './api.js';
import { ErrorNotice, useAction } from './common.js';
import { abilityPoolText } from './ability-view.js';

/** Per-account editor. Parent keys it by account and revision, so stale responses cannot leak between accounts. */
export function AbilityCalibrationEditor({ ability, onSaved }: { ability: AbilityAssessment; onSaved: () => void }) {
  const reference = ability.trainingReference;
  const [min, setMin] = useState(reference.range ? String(reference.range.min) : '');
  const [max, setMax] = useState(reference.range ? String(reference.range.max) : '');
  const action = useAction();
  const valid = /^\d+$/u.test(min) && /^\d+$/u.test(max) && Number.isSafeInteger(Number(min)) && Number.isSafeInteger(Number(max)) && Number(min) > 0 && Number(min) <= Number(max);
  async function save(clear: boolean) {
    const result = await action.run(signal => api.request('ability.calibrate', { accountId: ability.accountId, expectedRevision: reference.revision, range: clear ? null : { min: Number(min), max: Number(max) } }, signal));
    if (result) onSaved();
  }
  if (ability.platform !== 'codeforces') return null;
  return <section aria-label="个人水平校准">
    <h3>个人水平校准</h3>
    <p><strong>{reference.range ? 'CF 水平参考 ' + abilityPoolText(reference.range) + '（用户自评）' : '个人水平待校准'}</strong></p>
    <p className="icpc-muted">填写你根据比赛或训练表现判断的 CF 水平范围。保存后作为新 AI 训练计划的主要选题参考；练习中位数不再决定水平。自评按当前账号保存，可修改或清除。</p>
    <form onSubmit={event => { event.preventDefault(); if (valid) void save(false); }}>
      <div className="icpc-form-grid">
        <label>水平下限<input aria-label="水平下限" inputMode="numeric" value={min} onChange={event => setMin(event.target.value)} disabled={action.busy} placeholder="填写正整数" /></label>
        <label>水平上限<input aria-label="水平上限" inputMode="numeric" value={max} onChange={event => setMax(event.target.value)} disabled={action.busy} placeholder="不小于下限" /></label>
      </div>
      <div className="icpc-actions">
        <button type="submit" disabled={action.busy || !valid}>保存水平校准</button>
        <button type="button" disabled={action.busy || !reference.range} onClick={() => void save(true)}>清除自评</button>
      </div>
    </form>
    <ErrorNotice error={action.error} />
    {ability.calibration && <p className="icpc-muted">来源：用户自评 · 版本 {ability.calibration.revision} · 保存时间 {new Date(ability.calibration.recordedAt).toLocaleString()}。这不是官方 rating；历史版本保留在本地。</p>}
  </section>;
}
