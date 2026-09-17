/**
 * Reusable bulk platform-material refresh panel (Sprint Contract 34B).
 *
 * One component serves all three entry points: the problem bank prepares the current cross-page
 * selection, the tag-review page prepares the `refresh_materials` rows of the batch it is showing,
 * and the bank's history opener reopens a stored batch with no preparation scope at all. It performs
 * no decision of its own — status labels, counters, action gates, polling and the request bodies all
 * come from `material-batch-view.ts` — and it owns exactly four typed calls:
 *
 * - `material.prepare` (local, free, creates a durable batch and starts nothing),
 * - `material.start` (the explicit platform request; the only action that performs platform IO),
 * - `material.cancel` / `material.retryFailed` (explicit state transitions),
 * - plus the `material.detail` read, polled **only** while the batch is `running`, through the
 *   settle-aware helper so two reads never overlap.
 *
 * The panel never names a model, a `batch.*` operation or a budget: it cannot prepare, start or
 * resume a tag analysis, and it says so before any button. Closing it hides the surface only; the
 * durable batch stays readable from `material.list`, and a stored paused batch never resumes by
 * itself.
 *
 * It serves two surfaces of the same component: a **prepare** surface with a captured scope (the bank
 * selection or the review aggregation), and the bank's always-available **history/recovery** surface,
 * which opens on an empty scope. The empty scope only disables `material.prepare`: `material.list`,
 * selecting a stored batch and that batch's own state-valid start/cancel/retry actions all remain
 * available, and opening, loading or selecting performs no platform IO. The scope block is worded by
 * `materialScopeCopy`, so a batch selected from durable history is described by its own id, creation
 * instant and status — never by the current selection or the current account.
 */
import { type ReactNode, useState } from 'react';
import type { ApiMaterialBatchView } from '../application/workbench-api.js';
import { api } from './api.js';
import { ErrorNotice, Notice, Panel, useAction, usePollAfterSettle, useRequest } from './common.js';
import {
  MATERIAL_BATCH_LIST_LIMIT,
  MATERIAL_CANCEL_NOTE,
  MATERIAL_CLOSE_NOTE,
  MATERIAL_FAILURE_DISCLAIMER,
  MATERIAL_LOCAL_PREPARE_TEXT,
  MATERIAL_NO_MODEL_TEXT,
  MATERIAL_PLATFORM_START_TEXT,
  MATERIAL_PREPARE_AGAIN_NOTE,
  MATERIAL_RETRY_NOTE,
  displayKey,
  failureExplanation,
  itemAttemptsText,
  itemEditorialText,
  itemFailureCode,
  itemSnapshotText,
  itemStatementText,
  itemStatusText,
  localMaterialView,
  materialBatchStateNote,
  materialCancelGate,
  materialPollingActive,
  materialPrepareGate,
  materialPrepareRequest,
  materialProgressText,
  materialRetryGate,
  materialScopeCopy,
  materialStartGate,
  materialSummaryText,
  newestBatchView,
} from './material-batch-view.js';

/** Everything the panel needs from its host page; it loads and mutates nothing else. */
export interface BulkMaterialRefreshProps {
  /** Canonical problem keys in the caller's preserved order; the prepare gate refuses 0 or >100. */
  readonly problemKeys: readonly string[];
  /** Current account applied to every prepared item; `null` reads anonymously. */
  readonly accountId: string | null;
  readonly title?: string;
  /**
   * Where this preparation scope came from; a default sentence replaces it. It describes a *possible
   * new preparation*, so it is shown only while no batch — or only the batch this panel prepared — is
   * displayed, never over a stored batch selected from history.
   */
  readonly scopeNote?: string;
  /** Extra boundary wording inside the free/platform notice (for example the old-batch sentence). */
  readonly boundaryNote?: ReactNode;
  /** Hides the panel without touching durable work. */
  readonly onClose?: () => void;
}

/**
 * The bulk refresh surface: boundary first, then the free prepare, then the explicit start.
 *
 * Opening it sends one read-only `material.list`; it never prepares or starts anything by itself.
 */
export function BulkMaterialRefresh({
  problemKeys,
  accountId,
  title = '批量刷新平台材料（不调用 AI）',
  scopeNote,
  boundaryNote,
  onClose,
}: BulkMaterialRefreshProps) {
  const action = useAction();
  const [batchId, setBatchId] = useState<string | null>(null);
  /** The last mutation answer for the batch it belongs to; the durable read may be newer. */
  const [local, setLocal] = useState<ApiMaterialBatchView | null>(null);
  /**
   * The batch this panel session prepared from its captured scope, if any.
   *
   * It is the only thing that distinguishes "the batch I just prepared from this scope" from "a
   * stored batch I reopened": the scope block is worded from this identity, so a historical batch can
   * never borrow the current selection's or the current account's wording.
   */
  const [preparedBatchId, setPreparedBatchId] = useState<string | null>(null);
  const detail = useRequest('material.detail', batchId === null ? null : { batchId });
  const list = useRequest('material.list', { limit: MATERIAL_BATCH_LIST_LIMIT });
  // Only the selected batch's own loaded detail and its own mutation answer may render.
  const view = newestBatchView(detail.data, localMaterialView(batchId, local));
  // The one place that decides whether the captured scope and the current account may be shown.
  const copy = materialScopeCopy({
    view,
    preparedBatchId,
    problemKeys,
    accountId,
    ...(scopeNote === undefined ? {} : { scopeNote }),
  });
  // Polling is active in exactly one state; every other state stops it.
  usePollAfterSettle(materialPollingActive(view), detail.pending, detail.refresh);

  const prepareGate = materialPrepareGate(problemKeys);
  const startGate = materialStartGate(view);
  const cancelGate = materialCancelGate(view);
  const retryGate = materialRetryGate(view);
  const busy = action.busy;

  /** Create one durable batch from the captured scope; local only, and it starts nothing. */
  async function prepare(): Promise<void> {
    if (busy || !prepareGate.allowed) {
      return;
    }
    const value = await action.run((signal) =>
      api.request('material.prepare', materialPrepareRequest(problemKeys, accountId), signal),
    );
    if (value !== undefined) {
      setLocal(value);
      setPreparedBatchId(value.batchId);
      setBatchId(value.batchId);
      list.refresh();
    }
  }

  /** The explicit platform start/resume; the only action in this panel that performs platform IO. */
  async function start(): Promise<void> {
    if (busy || batchId === null || !startGate.allowed) {
      return;
    }
    const value = await action.run((signal) => api.request('material.start', { batchId }, signal));
    if (value !== undefined) {
      setLocal(value);
      detail.refresh();
      list.refresh();
    }
  }

  /** Cancel the unfinished items only; completed siblings are preserved by the durable record. */
  async function cancelBatch(): Promise<void> {
    if (busy || batchId === null || !cancelGate.allowed) {
      return;
    }
    const value = await action.run((signal) => api.request('material.cancel', { batchId }, signal));
    if (value !== undefined) {
      setLocal(value);
      detail.refresh();
      list.refresh();
    }
  }

  /** Reset exactly the attention/cancelled items; the following start stays a separate click. */
  async function retryFailed(): Promise<void> {
    if (busy || batchId === null || !retryGate.allowed) {
      return;
    }
    const value = await action.run((signal) => api.request('material.retryFailed', { batchId }, signal));
    if (value !== undefined) {
      setLocal(value);
      detail.refresh();
      list.refresh();
    }
  }

  return (
    <Panel title={title} tools={onClose === undefined ? undefined : <button type="button" onClick={onClose}>关闭面板</button>}>
      <div className="icpc-material-batch">
        <Notice>
          <p>{MATERIAL_LOCAL_PREPARE_TEXT}</p>
          <p>{MATERIAL_PLATFORM_START_TEXT}</p>
          <p>{MATERIAL_NO_MODEL_TEXT}</p>
          {boundaryNote}
        </Notice>
        {copy.scopeText !== null && (
          <p className="icpc-muted icpc-material-batch-scope">{copy.scopeText}</p>
        )}
        {copy.batchText !== null && <p className="icpc-muted icpc-material-batch-origin">{copy.batchText}</p>}
        {copy.accountText !== null && <p className="icpc-muted">{copy.accountText}</p>}
        <div className="icpc-actions icpc-material-batch-actions">
          <button
            type="button"
            className="icpc-primary"
            disabled={busy || !prepareGate.allowed}
            title={prepareGate.reason ?? undefined}
            onClick={() => void prepare()}
          >
            免费准备刷新批次
          </button>
          <button
            type="button"
            disabled={busy || !startGate.allowed}
            title={startGate.reason ?? undefined}
            onClick={() => void start()}
          >
            {startGate.label}
          </button>
          <button
            type="button"
            disabled={busy || !cancelGate.allowed}
            title={cancelGate.reason ?? undefined}
            onClick={() => void cancelBatch()}
          >
            取消批次
          </button>
          <button
            type="button"
            disabled={busy || !retryGate.allowed}
            title={retryGate.reason ?? undefined}
            onClick={() => void retryFailed()}
          >
            仅重试失败/已取消项
          </button>
          <button type="button" disabled={detail.pending || batchId === null} onClick={detail.refresh}>
            刷新状态
          </button>
          <button type="button" disabled={list.pending} onClick={list.refresh}>
            刷新批次列表
          </button>
        </div>
        {!prepareGate.allowed && prepareGate.reason !== null && (
          <p className="icpc-muted" role="status">
            {prepareGate.reason}
          </p>
        )}
        {view !== null && !startGate.allowed && startGate.reason !== null && (
          <p className="icpc-muted" role="status">
            {startGate.reason}
          </p>
        )}
        {batchId !== null && view === null && detail.pending && <p className="icpc-muted">正在读取批次…</p>}
        <ErrorNotice error={action.error} />
        <ErrorNotice error={detail.error} />
        {view !== null && (
          <>
            <p className="icpc-material-batch-counters">{materialProgressText(view)}</p>
            <p className="icpc-muted">{materialBatchStateNote(view)}</p>
            <p className="icpc-muted">{MATERIAL_CANCEL_NOTE}</p>
            <p className="icpc-muted">{MATERIAL_RETRY_NOTE}</p>
            <p className="icpc-muted">{MATERIAL_PREPARE_AGAIN_NOTE}</p>
            {view.counts.attention > 0 && <p className="icpc-muted">{MATERIAL_FAILURE_DISCLAIMER}</p>}
            <div className="icpc-table-wrap icpc-material-batch-table">
              <table>
                <thead>
                  <tr>
                    <th>题目</th>
                    <th>状态</th>
                    <th>尝试</th>
                    <th>题面 / 题解</th>
                    <th>快照</th>
                    <th>失败原因（原始码在诊断区）</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((item) => (
                    <tr key={item.problemKey}>
                      <td>{displayKey(item.problemKey)}</td>
                      <td>{itemStatusText(item)}</td>
                      <td>{itemAttemptsText(item)}</td>
                      <td>
                        {itemStatementText(item)} · {itemEditorialText(item)}
                      </td>
                      <td>{itemSnapshotText(item)}</td>
                      <td>
                        {item.failure === null ? (
                          <span className="icpc-muted">—</span>
                        ) : (
                          <div className="icpc-material-batch-failure">
                            <span>{failureExplanation(item.failure.code)}</span>
                            <details>
                              <summary>诊断信息</summary>
                              <code>{itemFailureCode(item)}</code>
                            </details>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="icpc-material-batch-list">
          <label>
            查看已保存批次
            <select
              value={batchId ?? ''}
              onChange={(event) => {
                // A changed selection drops the previous batch's local mutation answer and any error
                // it left behind, before the newly selected batch's detail is rendered.
                setLocal(null);
                action.clear();
                setBatchId(event.target.value === '' ? null : event.target.value);
              }}
            >
              <option value="">请选择</option>
              {(list.data?.batches ?? []).map((summary) => (
                <option key={summary.batchId} value={summary.batchId}>
                  {materialSummaryText(summary)}
                </option>
              ))}
            </select>
          </label>
          {list.data !== null && list.data.batches.length === 0 && !list.pending && (
            <span className="icpc-muted">暂时没有已保存的刷新批次。</span>
          )}
        </div>
        <ErrorNotice error={list.error} />
        <p className="icpc-muted">{view === null ? materialBatchStateNote(null) : MATERIAL_CLOSE_NOTE}</p>
      </div>
    </Panel>
  );
}
