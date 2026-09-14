/**
 * Per-problem completion record and advanced retrospective form (Sprint Contract 23b).
 *
 * The visible summary always states the latest recorded mode — or `未标注`, which is *not*
 * independence — and offers the reusable {@link CompletionEditor} for a mode change. That path
 * previews before writing and preserves every note, confirmed skill and consulted solution it does
 * not explicitly change, so it works even while spoilers are withheld.
 *
 * The advanced form below is the full editor for skills, consulted solutions and the note. It is
 * prefilled from the latest record and resets on problem, account, latest record id or the
 * availability of the withheld fields, so an unrelated parent render cannot discard a draft while a
 * record that moved re-prefills. A withheld field is never rendered as an empty editable value:
 * while spoilers are hidden the form shows the reveal instruction and only the mode editor stays
 * usable. Every save names `expectedRetrospectiveId`, so a record appended while the form was open is
 * refused instead of being overwritten.
 */
import { useEffect, useRef, useState } from 'react';
import type { WorkbenchProblemDetail } from '../application/workbench-types.js';
import { api } from './api.js';
import { CompletionEditor } from './CompletionEditor.js';
import {
  COMPLETION_MODE_LABELS,
  COMPLETION_MODE_ORDER,
  COMPLETION_PREFILL_HIDDEN_NOTE,
  completionModeText,
  isCompletionConflict,
  parseCompletionMode,
  retrospectiveFormKey,
  retrospectiveFormState,
  type RetrospectiveFormState,
} from './completion-view.js';
import { Notice, ErrorNotice, useAction, useWorkbench } from './common.js';

/** One problem's completion summary plus the advanced form; `onReveal` reveals withheld spoilers. */
export function Retrospective({
  problem,
  onChange,
  onReveal,
}: {
  problem: WorkbenchProblemDetail;
  onChange: () => void;
  onReveal?: () => void;
}) {
  const { accountId, boot } = useWorkbench();
  const action = useAction();
  const latestId = problem.latestRetrospective?.retrospectiveId ?? null;
  const [form, setForm] = useState<RetrospectiveFormState>(() => retrospectiveFormState(problem));
  const [editorOpen, setEditorOpen] = useState(false);
  /** Bumped by 重新载入最新记录 to prefill again from the record the parent currently holds. */
  const [prefillVersion, setPrefillVersion] = useState(0);
  /** Save acknowledgement; it survives its own refresh and clears when another record takes over. */
  const [saved, setSaved] = useState<{ retrospectiveId: string | null } | null>(null);
  const formKey = retrospectiveFormKey(problem.problemKey, accountId, latestId);
  const advancedKnown = retrospectiveFormState(problem).advancedKnown;
  /** Problem + account identity: a scope change drops both the draft and any acknowledgement. */
  const scopeKey = problem.problemKey + '\u0000' + (accountId ?? '');
  const seenScope = useRef(scopeKey);
  const seenLatestId = useRef(latestId);

  // Prefill again when the problem, the account, the latest record id, the availability of the
  // withheld fields or an explicit reload moves; an unrelated parent render leaves the draft alone.
  useEffect(() => {
    setForm(retrospectiveFormState(problem));
  }, [formKey, advancedKnown, prefillVersion]);

  // The acknowledgement names the record this form saved. The parent refresh is asynchronous, so a
  // `latestId` that has not moved yet keeps it visible; only a different record arriving, a scope
  // change or a draft edit (in `edit` below) clears it.
  useEffect(() => {
    const scopeMoved = seenScope.current !== scopeKey;
    const latestMoved = seenLatestId.current !== latestId;
    seenScope.current = scopeKey;
    seenLatestId.current = latestId;
    if (saved === null) {
      return;
    }
    if (scopeMoved || (latestMoved && latestId !== saved.retrospectiveId)) {
      setSaved(null);
    }
  }, [scopeKey, latestId, saved]);

  /** One field change clears the banners: a stale success or failure text must not survive an edit. */
  function edit<K extends keyof RetrospectiveFormState>(key: K, value: RetrospectiveFormState[K]): void {
    setForm((previous) => ({ ...previous, [key]: value }));
    setSaved(null);
    action.clear();
  }

  /**
   * Explicit conflict recovery: discard the current draft, prefill from the record the parent already
   * holds and ask it (`onChange`) to read the latest one. Nothing is written and nothing is
   * overwritten silently; when the refreshed record arrives, the prefill effect runs again.
   */
  function reloadLatest(): void {
    setSaved(null);
    action.clear();
    setPrefillVersion((value) => value + 1);
    onChange();
  }

  const independentClears = form.mode === 'independent' && form.solutionIds.length > 0;
  const formProblem =
    form.mode === null
      ? '请选择完成方式：没有记录时不会默认按“独立完成”。'
      : !form.advancedKnown
        ? '显示算法标签与题解后才能编辑完整复盘；现在可以只用上面的“修改完成方式”。'
        : independentClears
          ? `独立完成会清除已勾选的 ${form.solutionIds.length} 条参考题解；请取消勾选，或改用“修改完成方式”的预览（会显示清除数量）。`
          : null;

  function save(): void {
    const mode = form.mode;
    if (!accountId || mode === null || formProblem !== null) {
      return;
    }
    void action.run(async (signal) => {
      const result = await api.request(
        'retro.record',
        {
          problemKey: problem.problemKey,
          accountId,
          mode,
          taxonomyIds: [...form.taxonomyIds],
          // An independent record forbids consulted solutions; the guard above makes the wipe explicit.
          solutionIds: mode === 'independent' ? [] : [...form.solutionIds],
          note: form.note.trim().length > 0 ? form.note : null,
          // Compare-and-set against the record this form was actually prefilled from: a newer prop
          // record that arrived before the form reset must never be silently overwritten.
          expectedRetrospectiveId: form.retrospectiveId,
        },
        signal,
      );
      if (signal.aborted) {
        return;
      }
      setSaved({ retrospectiveId: result.retrospectiveId });
      onChange();
      return result;
    });
  }

  if (!accountId) {
    return <Notice>选择账号后，可以记录这道题实际使用的解法。</Notice>;
  }

  return (
    <>
      <section className="icpc-completion-summary" aria-label="完成方式记录">
        <h3>完成方式</h3>
        <p>
          {problem.latestRetrospective !== null ? (
            <>
              当前记录：<strong>{completionModeText(problem.latestRetrospective.mode)}</strong> ·{' '}
              {new Date(problem.latestRetrospective.recordedAt).toLocaleString()}
            </>
          ) : (
            <>这道题还没有完成方式记录，统计中记为“未标注”（独立性未知）。</>
          )}
        </p>
        <p className="icpc-muted">
          通过（AC）不等于独立完成；这里只修改完成方式，不改动已确认知识点、备注或已咨询题解（“独立完成”会在预览中列出将清除的题解引用数量）。
        </p>
        <div className="icpc-actions">
          <button type="button" className="icpc-primary" disabled={editorOpen} onClick={() => setEditorOpen(true)}>
            {editorOpen ? '完成方式编辑器已打开' : '修改完成方式'}
          </button>
        </div>
        {editorOpen && (
          <CompletionEditor
            key={problem.problemKey + '|' + accountId}
            accountId={accountId}
            problemKeys={[problem.problemKey]}
            title="修改这道题的完成方式"
            onClose={() => setEditorOpen(false)}
            onApplied={() => onChange()}
          />
        )}
      </section>
      <details className="icpc-retro-form">
        <summary>记录完成方式与实际解法（完整表单）</summary>
        <ErrorNotice error={action.error} />
        {isCompletionConflict(action.error) && (
          <>
            <p className="icpc-muted">这道题的完成记录在你编辑期间发生了变化：本次没有写入，请按最新记录重新确认。</p>
            <button type="button" disabled={action.busy} onClick={reloadLatest}>
              重新载入最新记录（放弃当前草稿）
            </button>
          </>
        )}
        {!form.advancedKnown ? (
          <Notice>
            {COMPLETION_PREFILL_HIDDEN_NOTE}{' '}
            {onReveal !== undefined ? (
              <button type="button" onClick={onReveal}>
                显示算法标签与题解
              </button>
            ) : (
              '请先在上方点击“显示算法标签与题解”。'
            )}
          </Notice>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <label>
              完成方式
              <select
                value={form.mode ?? ''}
                disabled={action.busy}
                onChange={(event) => edit('mode', parseCompletionMode(event.target.value))}
              >
                <option value="">请选择</option>
                {COMPLETION_MODE_ORDER.map((id) => (
                  <option key={id} value={id}>
                    {COMPLETION_MODE_LABELS[id]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              实际使用的算法（可多选，Ctrl / Command 选择）
              <select
                multiple
                size={6}
                value={[...form.taxonomyIds]}
                disabled={action.busy}
                onChange={(event) =>
                  edit(
                    'taxonomyIds',
                    Array.from(event.target.selectedOptions, (option) => option.value),
                  )
                }
              >
                {boot.taxonomy.nodes
                  .filter((node) => node.kind !== 'category')
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.names.zh}
                    </option>
                  ))}
              </select>
            </label>
            {problem.snapshot?.solutions && problem.snapshot.solutions.length > 0 && (
              <label>
                参考过的已保存解法（可多选）
                <select
                  multiple
                  value={[...form.solutionIds]}
                  disabled={action.busy}
                  onChange={(event) =>
                    edit(
                      'solutionIds',
                      Array.from(event.target.selectedOptions, (option) => option.value),
                    )
                  }
                >
                  {problem.snapshot.solutions.map((solution) => (
                    <option key={solution.solutionId} value={solution.solutionId}>
                      {solution.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              复盘备注
              <textarea
                value={form.note}
                disabled={action.busy}
                onChange={(event) => edit('note', event.target.value)}
              />
            </label>
            {formProblem !== null && (
              <p className="icpc-plan-invalid" role="status">
                {formProblem}
              </p>
            )}
            <button className="icpc-primary" disabled={action.busy || formProblem !== null}>
              保存本次复盘
            </button>
            <p className="icpc-muted">
              保存前会核对这道题是否仍是最新记录：如果记录在此期间变化，本次保存会被拒绝而不是覆盖。
            </p>
          </form>
        )}
        {saved !== null && <Notice>复盘已保存；统计使用这道题最新的一次记录。</Notice>}
      </details>
    </>
  );
}
