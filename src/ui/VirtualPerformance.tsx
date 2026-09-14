/**
 * Virtual-contest performance ledger editor (Sprint 18c2).
 *
 * One Codeforces account's **user-entered** virtual-contest results, read and written exclusively
 * through the typed business API (`performance.list` / `performance.save` / `performance.delete`).
 * The component holds no second model of the data: the stored ledger is the only source of entries,
 * `revision` is the caller-read compare-and-set token of the next write, and a missing ledger is an
 * explicit empty view rather than a zero score. CRUD is a free local operation — nothing here can
 * reach a model, a platform or a credential.
 *
 * Failure behaviour is deliberately conservative:
 *
 * - a refused save or delete keeps every typed value, so a stale revision or a duplicate contest id
 *   costs the user nothing but a refresh;
 * - the inputs are cleared only after a save that the server confirmed, and the parent `onSaved` runs
 *   after every confirmed save and delete;
 * - unmounting aborts the in-flight HTTP request (`useAction`/`useRequest`), while the durable write
 *   the server already acknowledged stays committed.
 *
 * Only Codeforces accounts have a virtual-performance ledger; another platform renders nothing.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { SourcePlatform, VirtualPerformanceEvidence } from '../domain/index.js';
import type { ApiPerformanceListResult } from '../application/workbench-api.js';
import { VIRTUAL_PERFORMANCE_INDEPENDENCE } from '../domain/index.js';
import { api, ApiClientError } from './api.js';
import { Empty, ErrorNotice, ExternalLink, Panel, Stats, useAction, useRequest } from './common.js';
import {
  EMPTY_VIRTUAL_PERFORMANCE_FORM,
  VIRTUAL_PERFORMANCE_DATE_RULE,
  VIRTUAL_PERFORMANCE_EMPTY_NOTE,
  VIRTUAL_PERFORMANCE_INDEPENDENCE_LABELS,
  VIRTUAL_PERFORMANCE_METHOD_NOTE,
  VIRTUAL_PERFORMANCE_SECTION_NOTE,
  VIRTUAL_PERFORMANCE_TITLE,
  parseVirtualPerformanceForm,
  virtualPerformanceCountsText,
  virtualPerformanceEntryText,
  virtualPerformanceLocalDateTime,
  virtualPerformanceWhenText,
  type VirtualPerformanceField,
  type VirtualPerformanceFormFields,
} from './virtual-performance-view.js';

/** One account's ledger panel; reads on mount and after every committed mutation. */
export function VirtualPerformance({
  accountId,
  platform,
  onSaved,
}: {
  accountId: string;
  platform: SourcePlatform;
  onSaved: () => void;
}) {
  const read = useRequest('performance.list', platform === 'codeforces' ? { accountId } : null);
  if (platform !== 'codeforces') return null;
  return (
    <Panel title={VIRTUAL_PERFORMANCE_TITLE}>
      <p className="icpc-muted">{VIRTUAL_PERFORMANCE_SECTION_NOTE}</p>
      <ErrorNotice error={read.error} />
      {read.error ? <button type="button" onClick={read.refresh}>重试读取</button> : null}
      {read.data === null
        ? read.pending && <p>正在读取虚拟参赛记录…</p>
        : <VirtualPerformanceLedger
            key={accountId}
            accountId={accountId}
            ledger={read.data}
            onCommitted={() => {
              read.refresh();
              onSaved();
            }}
          />}
    </Panel>
  );
}

/** Ledger list plus its editor; keyed by account so switching accounts never mixes form state. */
function VirtualPerformanceLedger({
  accountId,
  ledger,
  onCommitted,
}: {
  accountId: string;
  ledger: ApiPerformanceListResult;
  onCommitted: () => void;
}) {
  const [fields, setFields] = useState<VirtualPerformanceFormFields>(EMPTY_VIRTUAL_PERFORMANCE_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // The next write's compare-and-set token: the revision this screen last saw from the server.
  const [revision, setRevision] = useState(ledger.revision);
  const [submitted, setSubmitted] = useState(false);
  const action = useAction();
  useEffect(() => {
    setRevision(ledger.revision);
  }, [ledger.revision]);
  const check = parseVirtualPerformanceForm(fields, new Date());
  const conflict = action.error instanceof ApiClientError && action.error.code === 'conflict';
  const set = <K extends VirtualPerformanceField>(name: K, value: VirtualPerformanceFormFields[K]) =>
    setFields((previous) => ({ ...previous, [name]: value }));
  const err = (name: VirtualPerformanceField) => {
    if (check.state === 'valid') return null;
    const message = submitted || String(fields[name]).trim().length > 0 ? check.errors[name] : undefined;
    return message ? (
      <span className="icpc-error" role="alert">
        {message}
      </span>
    ) : null;
  };

  /** Load one stored row into the form; the row stays untouched until the user saves. */
  function beginEdit(entry: VirtualPerformanceEvidence) {
    action.clear();
    setSubmitted(false);
    setConfirmDeleteId(null);
    setEditingId(entry.evidenceId);
    setFields({
      contestId: String(entry.contestId),
      participatedAt: virtualPerformanceLocalDateTime(entry.participatedAt),
      performance: String(entry.performance),
      calculationMethod: entry.calculationMethod,
      sourceUrl: entry.sourceUrl,
      independence: entry.independence,
      priorExposure: entry.priorExposure,
      rank: entry.rank === null ? '' : String(entry.rank),
      note: entry.note ?? '',
    });
  }

  /** Clear the editor: only reached after a confirmed write, or by an explicit cancel. */
  function resetForm() {
    setFields(EMPTY_VIRTUAL_PERFORMANCE_FORM);
    setEditingId(null);
    setSubmitted(false);
    setConfirmDeleteId(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (check.state !== 'valid') return;
    const result = await action.run((signal) =>
      api.request(
        'performance.save',
        { accountId, expectedRevision: revision, evidenceId: editingId, ...check.values },
        signal,
      ),
    );
    if (!result) return;
    setRevision(result.revision);
    resetForm();
    onCommitted();
  }

  async function remove(evidenceId: string) {
    const result = await action.run((signal) =>
      api.request('performance.delete', { accountId, expectedRevision: revision, evidenceId }, signal),
    );
    if (!result) return;
    setRevision(result.revision);
    if (editingId === evidenceId) resetForm();
    else setConfirmDeleteId(null);
    onCommitted();
  }

  return (
    <section aria-label="虚拟参赛表现记录">
      <Stats
        items={[
          { label: '记录条数', value: ledger.counts.total },
          { label: '可作独立证据', value: ledger.counts.eligibleIndependent },
          { label: '有提示或参考题解', value: ledger.counts.assisted },
          { label: '独立性未知', value: ledger.counts.unknownIndependence },
          { label: '赛前见过题', value: ledger.counts.priorExposed },
        ]}
      />
      <p className="icpc-muted">{virtualPerformanceCountsText(ledger.counts)}</p>
      <p className="icpc-muted">
        {ledger.disclosure}（记录版本 {ledger.revision}
        {ledger.updatedAt ? ' · 更新时间 ' + virtualPerformanceWhenText(ledger.updatedAt) : ''}）
      </p>

      {ledger.entries.length === 0 ? (
        <Empty>{VIRTUAL_PERFORMANCE_EMPTY_NOTE}</Empty>
      ) : (
        <div className="icpc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>比赛编号</th>
                <th>你的虚拟参赛时间</th>
                <th>performance</th>
                <th>计算方法</th>
                <th>独立性与赛前</th>
                <th>名次</th>
                <th>备注</th>
                <th>参考链接</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((entry) => (
                <tr key={entry.evidenceId}>
                  <td>{entry.contestId}</td>
                  <td>{virtualPerformanceWhenText(entry.participatedAt)}</td>
                  <td>{entry.performance}</td>
                  <td>{entry.calculationMethod}</td>
                  <td>{virtualPerformanceEntryText(entry)}</td>
                  <td>{entry.rank ?? '未记录'}</td>
                  <td>{entry.note ?? '未记录'}</td>
                  <td><ExternalLink href={entry.sourceUrl}>查看出处</ExternalLink></td>
                  <td>
                    <button type="button" disabled={action.busy} onClick={() => beginEdit(entry)}>编辑</button>
                    {confirmDeleteId === entry.evidenceId ? (
                      <>
                        <button type="button" disabled={action.busy} onClick={() => void remove(entry.evidenceId)}>确认删除</button>
                        <button type="button" disabled={action.busy} onClick={() => setConfirmDeleteId(null)}>取消</button>
                      </>
                    ) : (
                      <button type="button" disabled={action.busy} onClick={() => setConfirmDeleteId(entry.evidenceId)}>删除</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>{editingId === null ? '新增一条虚拟参赛记录' : '修改这条记录（保存时按当前版本更新）'}</h4>
      <form onSubmit={(event) => void save(event)}>
        <div className="icpc-form-grid">
          <label>比赛编号<input aria-label="比赛编号" inputMode="numeric" value={fields.contestId} disabled={action.busy} onChange={(event) => set('contestId', event.target.value)} placeholder="例如 1942" />{err('contestId')}</label>
          <label>虚拟参赛时间<input aria-label="虚拟参赛时间" type="datetime-local" step={1} value={fields.participatedAt} disabled={action.busy} onChange={(event) => set('participatedAt', event.target.value)} />{err('participatedAt')}</label>
          <label>performance<input aria-label="performance" inputMode="numeric" value={fields.performance} disabled={action.busy} onChange={(event) => set('performance', event.target.value)} placeholder="可以是 0 或负数" />{err('performance')}</label>
          <label>计算方法 / 工具<input aria-label="计算方法" value={fields.calculationMethod} disabled={action.busy} onChange={(event) => set('calculationMethod', event.target.value)} placeholder="例如 carrot" />{err('calculationMethod')}</label>
          <label>参考链接<input aria-label="参考链接" value={fields.sourceUrl} disabled={action.busy} onChange={(event) => set('sourceUrl', event.target.value)} placeholder="https://codeforces.com/contest/1942" />{err('sourceUrl')}</label>
          <label>名次（可选）<input aria-label="名次" inputMode="numeric" value={fields.rank} disabled={action.busy} onChange={(event) => set('rank', event.target.value)} placeholder="留空表示未记录" />{err('rank')}</label>
          <label>独立完成情况<select aria-label="独立完成情况" value={fields.independence} disabled={action.busy} onChange={(event) => set('independence', event.target.value)}>
            <option value="">请选择</option>
            {VIRTUAL_PERFORMANCE_INDEPENDENCE.map((value) => (
              <option key={value} value={value}>{VIRTUAL_PERFORMANCE_INDEPENDENCE_LABELS[value]}</option>
            ))}
          </select>{err('independence')}</label>
        </div>
        <label style={{ display: 'block', margin: '8px 0' }}>
          <input type="checkbox" checked={fields.priorExposure} disabled={action.busy} onChange={(event) => set('priorExposure', event.target.checked)} />
          赛前我已经见过这些题（做过或看过题解）
        </label>
        <label>备注（可选，仅保存在本地，不会进入模型摘要）<textarea aria-label="备注" value={fields.note} disabled={action.busy} onChange={(event) => set('note', event.target.value)} />{err('note')}</label>
        <p className="icpc-muted">{VIRTUAL_PERFORMANCE_DATE_RULE}{VIRTUAL_PERFORMANCE_METHOD_NOTE}</p>
        {check.state === 'invalid' && submitted ? <p className="icpc-error" role="alert">还有未通过校验的字段（见下方各项提示）；已填写的内容会保留。</p> : null}
        <div className="icpc-actions">
          <button type="submit" disabled={action.busy}>{editingId === null ? '新增记录' : '保存修改'}</button>
          {editingId !== null ? <button type="button" disabled={action.busy} onClick={resetForm}>取消编辑</button> : null}
        </div>
      </form>
      <ErrorNotice error={action.error} />
      {conflict ? <p className="icpc-muted">这条记录可能已在别处更新，或比赛编号已经存在：请先刷新列表再重试。表单内容已保留，不会丢失。</p> : null}
    </section>
  );
}
