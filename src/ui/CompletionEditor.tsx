/**
 * Reusable per-problem / bulk completion editor (Sprint Contract 23b).
 *
 * One mounted editor owns exactly one captured scope — an account id and 1..100 problem keys — and
 * every request it sends names that scope. The parent mounts it with a key derived from the scope,
 * so a selection or account change unmounts it and {@link useAction} aborts the in-flight HTTP
 * request; a late answer can therefore never write into, or clear the selection of, a newer screen.
 *
 * Flow: one batched `retro.list` (never one detail request per row) → an explicit mode plus an
 * optional, manually checked knowledge union → `retro.editPreview` → `retro.editApply` with the hash
 * of that exact preview. Editing the draft changes the intent key, which invalidates the preview, so
 * an old hash can never be sent with a new draft. Applying uses the intent captured at preview time.
 * No platform request, no model call and no AC mutation happens anywhere in this file.
 *
 * Presentation only (Sprint 29c): the current-record table and the preview's per-problem table are
 * native `details`/`summary` disclosures. A bulk scope (up to 100 keys) starts collapsed so the mode
 * select and the preview/apply/close buttons stay reachable; a one-problem scope opens its single
 * row. Collapsing changes no state, no request and no preview hash.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  RetrospectiveEditApplyResult,
  RetrospectiveEditPreviewResult,
} from '../application/retrospective-edit.js';
import type { CompletionMode } from '../domain/retrospective.js';
import { api } from './api.js';
import {
  COMPLETION_AC_NOTE,
  COMPLETION_DRAFT_INVALIDATED_NOTE,
  COMPLETION_EDIT_NOTICE,
  COMPLETION_INDEPENDENT_NOTE,
  COMPLETION_MODE_LABELS,
  COMPLETION_MODE_ORDER,
  COMPLETION_PRESERVE_NOTE,
  COMPLETION_SCOPE_NOTE,
  COMPLETION_STALE_PREVIEW_NOTE,
  applyButtonText,
  completionApplyFields,
  completionDraftProblem,
  completionEditFields,
  completionIntentKey,
  completionIntentOf,
  completionModeText,
  completionPreviewIsFresh,
  completionPreviewTotals,
  completionRequestStillCurrent,
  isCompletionConflict,
  knowledgeApplySummary,
  knowledgeNames,
  knowledgeOptions,
  parseCompletionMode,
  type CompletionDraft,
  type CompletionIntent,
} from './completion-view.js';
import { ErrorNotice, Notice, useAction, useRequest, useWorkbench } from './common.js';
import { accountLabelOf } from './merged.js';

/** The preview this editor currently trusts, with the exact intent it was computed from. */
interface HeldPreview {
  readonly accountId: string;
  readonly hash: string;
  readonly intentKey: string;
  readonly intent: CompletionIntent;
  readonly result: RetrospectiveEditPreviewResult;
}

/** How many matching knowledge nodes are rendered at once; search narrows the list. */
const KNOWLEDGE_RENDER_LIMIT = 200;

/**
 * Completion editor for one captured scope.
 *
 * `problemKeys` is captured on the first render: the component is meant to be keyed by the scope,
 * and all later requests keep using the captured copy so a stale answer cannot land on a scope that
 * moved underneath it. `onApplied` lets the owner refresh its read surfaces; it is called after a
 * successful apply, never on preview.
 */
export function CompletionEditor({
  accountId,
  problemKeys,
  onClose,
  onApplied,
  title,
}: {
  accountId: string;
  problemKeys: readonly string[];
  onClose: () => void;
  onApplied?: (result: RetrospectiveEditApplyResult) => void;
  title?: string;
}) {
  const { boot } = useWorkbench();
  const action = useAction();
  // Captured scope: the account and the keys every request of this editor instance names.
  const scope = useRef({ accountId, problemKeys: [...problemKeys] }).current;
  const [mode, setMode] = useState<CompletionMode | null>(null);
  const [addKnowledge, setAddKnowledge] = useState(false);
  const [taxonomyIds, setTaxonomyIds] = useState<readonly string[]>([]);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [preview, setPreview] = useState<HeldPreview | null>(null);
  const [applied, setApplied] = useState<RetrospectiveEditApplyResult | null>(null);
  /** True once the user picked a mode themselves: the single-problem prefill must not override it. */
  const modeTouched = useRef(false);

  const read = useRequest('retro.list', { accountId: scope.accountId, problemKeys: scope.problemKeys });

  // A single-problem opener prefills the one existing mode; a missing record stays on the explicit
  // `请选择` placeholder instead of defaulting to independent.
  const onlyKey = scope.problemKeys.length === 1 ? scope.problemKeys[0] ?? null : null;
  useEffect(() => {
    if (modeTouched.current || onlyKey === null) {
      return;
    }
    const entry = read.data?.items.find((item) => item.problemKey === onlyKey);
    if (entry !== undefined && entry.mode !== null) {
      setMode(entry.mode);
    }
  }, [read.data, onlyKey]);

  const draft: CompletionDraft = { mode, addKnowledge, taxonomyIds };
  const draftProblem = completionDraftProblem(draft);
  const intent = completionIntentOf(draft);
  const fresh = completionPreviewIsFresh(preview, scope.accountId, intent);
  const totals = preview !== null && fresh ? completionPreviewTotals(preview.result) : null;
  const applyLabel = applyButtonText(totals !== null && preview !== null ? preview.result : null);

  const nodes = boot.taxonomy.nodes;
  const options = knowledgeOptions(nodes, knowledgeQuery);
  const shown = options.slice(0, KNOWLEDGE_RENDER_LIMIT);
  const selectedNames = knowledgeNames(taxonomyIds, nodes);

  function changeMode(value: string): void {
    modeTouched.current = true;
    setMode(parseCompletionMode(value));
  }

  function toggleSkill(id: string): void {
    setTaxonomyIds((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id],
    );
  }

  /**
   * Read one preview of the current draft.
   *
   * The intent is normalized before the request and stored with its own key, so the apply path can
   * send exactly the intent the user saw even if the form changed afterwards.
   */
  function previewEdits(): void {
    if (intent === null || draftProblem !== null) {
      return;
    }
    void action.run(async (signal) => {
      const value = await api.request(
        'retro.editPreview',
        completionEditFields(scope.accountId, scope.problemKeys, intent),
        signal,
      );
      if (!completionRequestStillCurrent(signal)) {
        return;
      }
      setApplied(null);
      setPreview({
        accountId: scope.accountId,
        hash: value.previewHash,
        intentKey: completionIntentKey(intent),
        intent,
        result: value,
      });
      return value;
    });
  }

  /**
   * Apply the previewed edit.
   *
   * The hash and the intent come from the held preview, never from the live draft; a draft change
   * only disables this button. A compare-and-set conflict drops the stale preview so the old hash
   * cannot be resent, while the selection and the draft survive for a re-preview.
   */
  function applyEdits(): void {
    if (preview === null || !fresh || preview.result.changedCount === 0) {
      return;
    }
    void action.run(async (signal) => {
      try {
        const value = await api.request(
          'retro.editApply',
          completionApplyFields(scope.accountId, scope.problemKeys, preview),
          signal,
        );
        if (!completionRequestStillCurrent(signal)) {
          return;
        }
        setPreview(null);
        setApplied(value);
        read.refresh();
        onApplied?.(value);
        return value;
      } catch (error) {
        if (!completionRequestStillCurrent(signal)) {
          return;
        }
        if (isCompletionConflict(error)) {
          setPreview(null);
        }
        throw error;
      }
    });
  }

  const accountLabel = accountLabelOf(scope.accountId, boot.accounts, boot.sources);
  const listPending = read.pending && read.data === null;
  /**
   * Presentation only (Sprint 29c): a one-problem scope opens its single-row disclosures, while a
   * bulk scope keeps them collapsed so 100 rows cannot push the controls out of reach. Nothing here
   * touches the draft, the preview or the apply hash.
   */
  const singleProblem = scope.problemKeys.length === 1;

  return (
    <section className="icpc-completion-editor" aria-label="完成方式编辑器">
      <h3>{title ?? (scope.problemKeys.length === 1 ? '修改完成方式' : `批量修改完成方式（${scope.problemKeys.length} 题）`)}</h3>
      <p className="icpc-muted">{COMPLETION_SCOPE_NOTE}</p>
      <p className="icpc-muted">
        账号范围：{accountLabel} · 已选 {scope.problemKeys.length} 题（写入只针对这些题目）。
      </p>
      <ErrorNotice error={read.error} />
      {read.error !== null && (
        <button type="button" onClick={read.refresh}>
          重试读取完成方式
        </button>
      )}
      {listPending ? (
        <p className="icpc-muted" role="status">
          正在读取所选题目的最新完成方式…
        </p>
      ) : read.data === null ? (
        <p className="icpc-muted">未能读取这些题目的完成方式；仍可直接预览，但看不到当前值。</p>
      ) : (
        <details className="icpc-completion-records" open={singleProblem}>
          <summary>当前完成方式（共 {read.data.items.length} 题）· 可展开逐题核对</summary>
          <div className="icpc-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>题目</th>
                  <th>当前完成方式</th>
                  <th>最近记录</th>
                </tr>
              </thead>
              <tbody>
                {read.data.items.map((entry) => (
                  <tr key={entry.problemKey}>
                    <td>{entry.title}</td>
                    <td>{completionModeText(entry.mode)}</td>
                    <td className="icpc-muted">
                      {entry.recordedAt === null ? '无记录' : new Date(entry.recordedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <label>
        完成方式（必选）
        <select value={mode ?? ''} disabled={action.busy} onChange={(event) => changeMode(event.target.value)}>
          <option value="">请选择（未标注不会默认按“独立完成”记录）</option>
          {COMPLETION_MODE_ORDER.map((id) => (
            <option key={id} value={id}>
              {COMPLETION_MODE_LABELS[id]}
            </option>
          ))}
        </select>
      </label>
      <p className="icpc-muted">{COMPLETION_INDEPENDENT_NOTE}</p>
      <label className="icpc-check">
        <input
          type="checkbox"
          checked={addKnowledge}
          disabled={action.busy}
          onChange={(event) => setAddKnowledge(event.target.checked)}
        />
        同时补充实际使用的知识点（可选，仅手动选择；不使用平台标签或 AI 建议）
      </label>
      {addKnowledge && (
        <fieldset className="icpc-knowledge-picker">
          <legend>知识点（已选 {taxonomyIds.length} 个）</legend>
          <label>
            搜索知识点名称或编号
            <input value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} />
          </label>
          {selectedNames.length > 0 && <p className="icpc-muted">已选：{selectedNames.join('、')}</p>}
          <div className="icpc-knowledge-list">
            {shown.map((node) => (
              <label key={node.id} className="icpc-check">
                <input
                  type="checkbox"
                  checked={taxonomyIds.includes(node.id)}
                  disabled={action.busy}
                  onChange={() => toggleSkill(node.id)}
                />
                {node.names.zh}
              </label>
            ))}
          </div>
          {options.length > KNOWLEDGE_RENDER_LIMIT && (
            <p className="icpc-muted">
              匹配 {options.length} 个知识点，这里只显示前 {KNOWLEDGE_RENDER_LIMIT} 个；已选项在上方单独列出，请用搜索缩小范围。
            </p>
          )}
          <p className="icpc-muted">{knowledgeApplySummary(scope.problemKeys.length, taxonomyIds, nodes)}</p>
        </fieldset>
      )}

      {draftProblem !== null && (
        <p className="icpc-plan-invalid" role="status">
          {draftProblem}
        </p>
      )}
      <div className="icpc-actions">
        <button
          type="button"
          className="icpc-primary"
          disabled={action.busy || draftProblem !== null || intent === null}
          onClick={previewEdits}
        >
          {action.busy ? '正在处理…' : '预览修改'}
        </button>
        <button
          type="button"
          className="icpc-primary"
          disabled={action.busy || !fresh || preview === null || preview.result.changedCount === 0}
          onClick={applyEdits}
        >
          {applyLabel ?? '修改'}
        </button>
        <button type="button" disabled={action.busy} onClick={onClose}>
          关闭编辑器
        </button>
      </div>

      <ErrorNotice error={action.error} />
      {isCompletionConflict(action.error) && <p className="icpc-muted">{COMPLETION_STALE_PREVIEW_NOTE}</p>}
      {preview !== null && !fresh && (
        <p className="icpc-plan-invalid" role="status">
          {COMPLETION_DRAFT_INVALIDATED_NOTE}
        </p>
      )}

      {preview !== null && fresh && totals !== null && (
        <div className="icpc-completion-preview">
          <h4>修改预览（账号：{accountLabel}）</h4>
          <p className="icpc-muted">{COMPLETION_PRESERVE_NOTE}</p>
          <p>
            共 {preview.result.items.length} 题：{totals.changedCount} 题会改变，{totals.unchangedCount} 题无变化。
          </p>
          {totals.addedSkillCount > 0 && (
            <p>
              共同选择的知识点逐题补齐；已存在的不重复添加。本次补充涉及 {totals.addedSkillCount} 个知识点、共{' '}
              {totals.addedSkillTotal} 处（逐题明细见下）：
              {knowledgeNames(
                [...new Set(preview.result.items.flatMap((item) => item.addedTaxonomyIds))],
                nodes,
              ).join('、')}
              。
            </p>
          )}
          {totals.clearedSolutionTotal > 0 && (
            <p>选择“独立完成”会清除 {totals.clearedSolutionTotal} 条已咨询题解引用（逐题明细见下）。</p>
          )}
          <details className="icpc-completion-preview-rows" open={singleProblem}>
            <summary>
              逐题明细（共 {preview.result.items.length} 题：{totals.changedCount} 题会改变、{totals.unchangedCount} 题无变化）
            </summary>
            <div className="icpc-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>题目</th>
                    <th>原完成方式</th>
                    <th>新完成方式</th>
                    <th>已有知识点</th>
                    <th>本次补充</th>
                    <th>清除题解引用</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.result.items.map((item) => (
                    <tr key={item.problemKey}>
                      <td>
                        {item.title}
                        {!item.changed && <span className="icpc-tag">无变化</span>}
                      </td>
                      <td>{completionModeText(item.previousMode)}</td>
                      <td>{completionModeText(item.nextMode)}</td>
                      <td>{item.existingTaxonomyCount}</td>
                      <td>{knowledgeNames(item.addedTaxonomyIds, nodes).join('、') || '—'}</td>
                      <td>{item.clearedSolutionCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="icpc-muted">{COMPLETION_AC_NOTE}</p>
        </div>
      )}

      {applied !== null && (
        <Notice>
          {COMPLETION_EDIT_NOTICE} 本次改变 {applied.changedCount} 题、{applied.unchangedCount} 题无变化。
        </Notice>
      )}
    </section>
  );
}
