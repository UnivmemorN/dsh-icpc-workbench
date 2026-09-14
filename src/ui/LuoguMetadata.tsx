import { useEffect, useRef, useState } from 'react';
import type {
  ApiLuoguMetadataBacklogItem,
  ApiLuoguRetryMetadataResult,
  ApiLuoguStatusView,
} from '../application/workbench-api.js';
import { api, ApiClientError } from './api.js';
import { LuoguManagedProblems, useLuoguManagement, type ManagementTarget } from './LuoguManagedProblems.js';
import { Empty, ErrorNotice, ExternalLink, useRequest } from './common.js';
import {
  LUOGU_METADATA_BACKLOG_PAGE_SIZE,
  LUOGU_METADATA_MANUAL_NOTE,
  LUOGU_METADATA_PAGE_SIZE_OPTIONS,
  LUOGU_SUPPLEMENT_AI_NOTE,
  LUOGU_SUPPLEMENT_AUDIT_NOTE,
  clampLuoguMetadataPage,
  luoguMetadataBacklogRequest,
  luoguMetadataCounts,
  luoguMetadataHostFailureLine,
  luoguMetadataIssueText,
  luoguMetadataMutationReason,
  luoguMetadataPageCount,
  luoguMetadataPageLabel,
  luoguMetadataRetryErrorText,
  luoguMetadataRetryText,
  luoguSupplementErrorText,
  luoguSupplementValidation,
  luoguSupplementTargetChanged,
} from './luogu-metadata-view.js';

/**
 * The two typed operations this panel drives, and nothing else.
 *
 * `luogu.metadataBacklog` is the only read: it is issued by {@link LuoguMetadataPanel} while the
 * disclosure is open, one bounded page at a time, and never for the whole durable queue. The two
 * mutations are item-scoped — `luogu.retryMetadata` for exactly the one clicked key and
 * `luogu.supplementMetadata` for the one open form — and neither can start a whole pass, change a
 * checkpoint or reach a model.
 */
interface LuoguMetadataPanelProps {
  /** Account whose backlog is shown; every request names exactly this account. */
  readonly accountId: string;
  /** Latest durable status of the same account, used only for the mutation gate and failure line. */
  readonly status: ApiLuoguStatusView;
  /** Re-read `luogu.status` after a mutation, so the compact card shows the updated backlog. */
  readonly onStatusRefresh: () => void;
  /** Called when local problem material changed, so the bank and bootstrap re-read their data. */
  readonly onBankChange: () => void;
}

/**
 * One page of the durable metadata backlog, with per-item retry and manual supplement (Sprint 25b).
 *
 * The panel exists only while its disclosure is open (the parent mounts it then and unmounts it on
 * close), which is what makes "no network while closed" and "closing clears every draft" structural
 * rather than best-effort. Its rules:
 *
 * - **One bounded page.** The page size is 20 (or 25) — far below the endpoint's own bound — and the
 *   page is clamped against the last known total *before* the request, so an out-of-range page is
 *   never sent and a backlog of thousands never renders thousands of rows.
 * - **One form at a time.** `openKey` names the single row whose supplement form is mounted; opening
 *   another row (or closing the disclosure, switching accounts or a successful submit) unmounts it,
 *   and the draft lives only in that component's state — never in storage.
 * - **One mutation at a time.** Retry and supplement are both disabled by
 *   {@link luoguMetadataMutationReason} while a pass runs, another instance holds the lease, the
 *   plugin closes, or a local action is still in flight, so a per-item write can never race the
 *   durable pass that owns the account.
 * - **Honest outcomes.** Every settle refreshes the backlog and the durable status; a resolved retry
 *   and a successful supplement additionally refresh the bank, while a deferred/failed retry or a
 *   conflict keeps the item queued and says so.
 */
export function LuoguMetadataPanel(props: LuoguMetadataPanelProps) {
  const [tab, setTab] = useState<'pending' | 'skipped' | 'trashed'>('pending');
  return <>
    <div className="icpc-actions" aria-label="题目处理分类">
      {(['pending', 'skipped', 'trashed'] as const).map(value => <button type="button" key={value} className={tab === value ? 'icpc-primary' : undefined} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === 'pending' ? '待补题目' : value === 'skipped' ? '已跳过' : '回收站'}</button>)}
    </div>
    {tab === 'pending' ? <LuoguPendingMetadataPanel key={props.accountId} {...props} /> : <LuoguManagedProblems key={`${props.accountId}:${tab}`} accountId={props.accountId} state={tab} status={props.status} onChange={() => { props.onStatusRefresh(); props.onBankChange(); }} />}
  </>;
}

function LuoguPendingMetadataPanel({
  accountId,
  status,
  onStatusRefresh,
  onBankChange,
}: LuoguMetadataPanelProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(LUOGU_METADATA_BACKLOG_PAGE_SIZE);
  const [knownTotal, setKnownTotal] = useState<number | null>(null);
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [notice, setNotice] = useState<{ readonly key: string; readonly text: string } | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const alive = useRef(true);
  const retryController = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      retryController.current?.abort();
    };
  }, []);

  // A page, a total and an open form belong to one account: switching accounts drops all three so no
  // draft or page position can be carried into another backlog.
  useEffect(() => {
    setPage(1);
    setKnownTotal(null);
    setRetryKey(null);
    setNotice(null);
    setOpenKey(null);
    setFormBusy(false);
  }, [accountId]);

  // The request is built from the last known total, so a page that no longer exists is clamped before
  // it is sent. `useRequest` keys on the serialized request, so a plain re-render re-reads nothing.
  const backlog = useRequest(
    'luogu.metadataBacklog',
    luoguMetadataBacklogRequest(accountId, page, pageSize, knownTotal),
  );
  const view = backlog.data;
  const [selected, setSelected] = useState<string[]>([]);
  const management = useLuoguManagement(accountId, luoguMetadataMutationReason(status, retryKey !== null || formBusy) !== null, () => {
    setSelected([]); backlog.refresh(); onStatusRefresh(); onBankChange();
  });
  useEffect(() => { setSelected([]); }, [view, page, pageSize, accountId]);
  const chosen = (view?.items ?? []).filter(item => selected.includes(item.problemKey));
  const targets = (items: readonly ApiLuoguMetadataBacklogItem[]): ManagementTarget[] => items.map(item => ({ problemKey: item.problemKey, externalKey: item.externalKey, expectedState: 'active' }));

  // Adopt the answer's total and pull the page back into range when items were resolved meanwhile.
  useEffect(() => {
    if (view === null) {
      return;
    }
    setKnownTotal(view.total);
    const clamped = clampLuoguMetadataPage(page, view.total, pageSize);
    if (clamped !== page) {
      setPage(clamped);
    }
  }, [view, page, pageSize]);

  const progressSignature = JSON.stringify([status.metadataBacklog, status.metadataFailed, status.metadataResolved, status.failure?.at]);
  const observedProgress = useRef(progressSignature);
  useEffect(() => {
    if (observedProgress.current !== progressSignature) {
      observedProgress.current = progressSignature;
      setKnownTotal(status.metadataBacklog);
      backlog.refresh();
    }
  }, [progressSignature, status.metadataBacklog, backlog.refresh]);

  const gate = luoguMetadataMutationReason(status, retryKey !== null || formBusy || management.busy);
  const hostFailure = luoguMetadataHostFailureLine(status);
  const pages = view === null ? 1 : luoguMetadataPageCount(view.total, pageSize);
  const first = page <= 1;
  const last = page >= pages;

  /** Retry exactly the clicked key, then refresh the backlog, the status and — if it resolved — the bank. */
  async function retryItem(item: ApiLuoguMetadataBacklogItem): Promise<void> {
    if (gate !== null) {
      return;
    }
    setRetryKey(item.problemKey);
    setNotice(null);
    const controller = new AbortController();
    retryController.current = controller;
    try {
      let result: ApiLuoguRetryMetadataResult | { readonly failed: true };
      try {
        result = await api.request(
          'luogu.retryMetadata',
          { accountId, problemKey: item.problemKey },
          controller.signal,
        );
      } catch (error) {
        result = { failed: true };
        if (alive.current && !controller.signal.aborted) {
          setNotice({
            key: item.problemKey,
            text: luoguMetadataRetryErrorText(error instanceof ApiClientError ? error.code : null),
          });
        }
      }
      if (!alive.current || controller.signal.aborted || 'failed' in result) {
        if (alive.current && 'failed' in result) {
          onStatusRefresh();
        }
        return;
      }
      setNotice({ key: item.problemKey, text: luoguMetadataRetryText(result) });
      backlog.refresh();
      onStatusRefresh();
      if (result.outcome === 'resolved') {
        onBankChange();
      }
    } finally {
      if (alive.current) {
        setRetryKey(null);
      }
    }
  }

  return (
    <>
      <p className="icpc-muted">{LUOGU_METADATA_MANUAL_NOTE}</p>
      <p className="icpc-muted">出题测试等没有题面的题目，可以跳过补齐，或移入可恢复的回收站。不会按题号自动删除。</p>
      {management.confirmation}
      {hostFailure !== null && (
        <p className="icpc-luogu-alert" role="status">
          {hostFailure}
        </p>
      )}
      <ErrorNotice error={backlog.error} />
      {gate !== null && (
        <small className="icpc-muted" role="status">
          {gate}
        </small>
      )}
      {notice !== null && (
        <p className="icpc-muted" role="status">
          {notice.text}
        </p>
      )}
      <p className="icpc-muted">{luoguMetadataCounts(view)}</p>
      {view === null ? (
        backlog.error === null ? (
          <Empty>{backlog.pending ? '正在读取待补列表（只读取一页）…' : '暂时没有读到待补列表，请重试。'}</Empty>
        ) : (
          <div className="icpc-actions">
            <button type="button" onClick={backlog.refresh}>
              重试读取待补列表
            </button>
          </div>
        )
      ) : view.items.length === 0 ? (
        view.total === 0 ? (
          <Empty>
            当前没有待补题目：积压为 0 时这里不会发起任何补齐请求；上面的历史失败尝试次数是累计值，不代表现在还有失败题目。
          </Empty>
        ) : (
          <Empty>这一页已经没有待补题目了：正在回到有效的页码，不会显示成「积压为空」。</Empty>
        )
      ) : (
        <>
          <div className="icpc-actions">
            <label className="icpc-check"><input type="checkbox" aria-label="选择本页全部待补题目" checked={view.items.length > 0 && chosen.length === view.items.length} disabled={gate !== null} onChange={event => setSelected(event.target.checked ? view.items.map(item => item.problemKey) : [])} />选择本页</label>
            <span>已选 {chosen.length} 题</span>
            <button type="button" disabled={gate !== null || chosen.length === 0} onClick={() => management.begin('skip', targets(chosen))}>跳过选中题目</button>
            <button type="button" disabled={gate !== null || chosen.length === 0} onClick={() => management.begin('trash', targets(chosen))}>选中题目移入回收站</button>
          </div>
          <ul className="icpc-luogu-backlog">
            {view.items.map((item) => (
              <li key={item.problemKey}>
                <label className="icpc-check"><input type="checkbox" aria-label={`选择 ${item.externalKey}`} checked={selected.includes(item.problemKey)} disabled={gate !== null} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.problemKey] : previous.filter(key => key !== item.problemKey))} /> {item.externalKey}</label>
                <div className="icpc-luogu-backlog-title">
                  {item.title !== null ? item.title : '（本地还没有标题）'}
                </div>
                <div className="icpc-luogu-backlog-meta">
                  <ExternalLink href={item.url}>{item.externalKey}</ExternalLink>
                </div>
                <p className="icpc-luogu-backlog-issue">
                  {luoguMetadataIssueText(item.issue, view.unknownIssueLabel)}
                </p>
                <div className="icpc-luogu-backlog-row-actions">
                  <button type="button" disabled={gate !== null} onClick={() => management.begin('skip', targets([item]))}>跳过此题</button>
                  <button type="button" disabled={gate !== null} onClick={() => management.begin('trash', targets([item]))}>移入回收站</button>
                  <button
                    type="button"
                    disabled={gate !== null || retryKey === item.problemKey}
                    aria-busy={retryKey === item.problemKey}
                    onClick={() => void retryItem(item)}
                  >
                    {retryKey === item.problemKey ? '重试中…' : '重试此题'}
                  </button>
                  <button
                    type="button"
                    disabled={gate !== null || retryKey !== null}
                    aria-expanded={openKey === item.problemKey}
                    onClick={() => setOpenKey(openKey === item.problemKey ? null : item.problemKey)}
                  >
                    {openKey === item.problemKey ? '收起手工补充' : '手工补充'}
                  </button>
                </div>
                {openKey === item.problemKey && (
                  <LuoguSupplementForm
                    accountId={accountId}
                    item={item}
                    disabledReason={gate}
                    onBusyChange={setFormBusy}
                    onClose={() => setOpenKey(null)}
                    onSettled={(result) => {
                      setNotice({ key: item.problemKey, text: result.message });
                      if (result.ok) {
                        setOpenKey(null);
                        onBankChange();
                      }
                      backlog.refresh();
                      onStatusRefresh();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
          <div className="icpc-luogu-backlog-pager">
            <button type="button" disabled={first} onClick={() => setPage(1)}>
              首页
            </button>
            <button
              type="button"
              disabled={first}
              onClick={() => setPage(clampLuoguMetadataPage(page - 1, view.total, pageSize))}
            >
              上一页
            </button>
            <button
              type="button"
              disabled={last}
              onClick={() => setPage(clampLuoguMetadataPage(page + 1, view.total, pageSize))}
            >
              下一页
            </button>
            <button type="button" disabled={last} onClick={() => setPage(pages)}>
              末页
            </button>
            <label className="icpc-page-jump">
              每页
              <select
                value={pageSize}
                disabled={retryKey !== null}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {LUOGU_METADATA_PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <span className="icpc-muted">{luoguMetadataPageLabel(page, view.total, pageSize)}</span>
            <button type="button" disabled={backlog.pending} onClick={() => {
              backlog.refresh();
              onStatusRefresh();
            }}>
              刷新待补列表
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** The validated outcome of one supplement submit, as the panel needs to hear it. */
interface LuoguSupplementSettled {
  readonly message: string;
  /** `true` only when the server committed the user-supplied material. */
  readonly ok: boolean;
}

/**
 * The one open manual-supplement form.
 *
 * The draft is component state only — no `localStorage`, no URL, no parent copy — so closing the
 * form, switching the open row, switching accounts or unmounting the disclosure clears it by
 * construction. On submit it validates through {@link luoguSupplementValidation} (the same rule the
 * server enforces), sends exactly one typed request carrying the `expectedSnapshotId` the caller saw,
 * and reports a fixed sentence back. It never clears a draft on failure: a refused write keeps what
 * the user typed, and a snapshot conflict explicitly asks for a backlog refresh before re-submitting.
 * The mounted `AbortController` is aborted on unmount, so a late answer cannot touch a closed form.
 */
function LuoguSupplementForm({
  accountId,
  item,
  disabledReason,
  onBusyChange,
  onClose,
  onSettled,
}: {
  readonly accountId: string;
  readonly item: ApiLuoguMetadataBacklogItem;
  /** Non-null while any mutation is refused; the form disables itself with the same sentence. */
  readonly disabledReason: string | null;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
  readonly onSettled: (result: LuoguSupplementSettled) => void;
}) {
  const openedTarget = useRef({ ...item }).current;
  const staleTarget = luoguSupplementTargetChanged(openedTarget, item);
  const [title, setTitle] = useState('');
  const [statement, setStatement] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [statementError, setStatementError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      onBusyChange(false);
    };
  }, [onBusyChange]);

  const needsTitle = openedTarget.title === null;
  const fieldId = `icpc-luogu-supplement-${item.externalKey}`;
  const blocked = pending || disabledReason !== null;

  async function submit(): Promise<void> {
    if (blocked || staleTarget) {
      return;
    }
    const check = luoguSupplementValidation({ accountId, item: openedTarget, draft: { title, statement } });
    if (!check.ok) {
      setTitleError(check.titleError);
      setStatementError(check.statementError);
      return;
    }
    setTitleError(null);
    setStatementError(null);
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    onBusyChange(true);
    try {
      await api.request('luogu.supplementMetadata', check.request, abort.signal);
      if (!alive.current) {
        return;
      }
      onSettled({
        ok: true,
        message:
          '已保存用户提供的本地题面，并从待补列表移除此题。通过记录保持不变；标签仍需复核。',
      });
    } catch (error) {
      if (!alive.current || abort.signal.aborted) {
        return;
      }
      const failure = luoguSupplementErrorText(error instanceof ApiClientError ? error.code : null);
      // The draft stays exactly as typed: `keepDraft` is true for every refusal, and nothing here
      // resets `title`/`statement`.
      onSettled({ ok: false, message: failure.message });
    } finally {
      if (alive.current) {
        setPending(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <section className="icpc-luogu-supplement" aria-label="手工补充题目资料">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {needsTitle ? (
          <>
            <label htmlFor={`${fieldId}-title`}>标题（本地还没有标题，必填）</label>
            <input
              id={`${fieldId}-title`}
              type="text"
              value={title}
              disabled={blocked}
              aria-invalid={titleError !== null ? true : undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
          </>
        ) : (
          <>
            <label htmlFor={`${fieldId}-title`}>标题（本地已保存，只读，不会被覆盖）</label>
            <input id={`${fieldId}-title`} type="text" value={openedTarget.title ?? ''} readOnly />
          </>
        )}
        {titleError !== null && (
          <small className="icpc-field-error" role="alert">
            {titleError}
          </small>
        )}
        <label htmlFor={`${fieldId}-statement`}>题面（Markdown，必填：请填写真实的题目描述）</label>
        <textarea
          id={`${fieldId}-statement`}
          value={statement}
          rows={8}
          disabled={blocked}
          aria-invalid={statementError !== null ? true : undefined}
          onChange={(event) => setStatement(event.target.value)}
        />
        {statementError !== null && (
          <small className="icpc-field-error" role="alert">
            {statementError}
          </small>
        )}
        <p className="icpc-muted">{LUOGU_SUPPLEMENT_AUDIT_NOTE}</p>
        <p className="icpc-muted">{LUOGU_SUPPLEMENT_AI_NOTE}</p>
        <p className="icpc-muted">
          保存会检查打开表单时的资料版本；如果资料已经变化，请先保留草稿，再收起并重新打开表单。
        </p>
        {staleTarget && <p role="alert">题目资料已更新，草稿仍保留。请先复制草稿，再收起并重新打开补充表单。</p>}
        <div className="icpc-actions">
          <button type="submit" className="icpc-primary" disabled={blocked || staleTarget} aria-busy={pending}>
            {pending ? '保存中…' : '保存到本地'}
          </button>
          <button type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
        </div>
        {disabledReason !== null && (
          <small className="icpc-muted" role="status">
            {disabledReason}
          </small>
        )}
      </form>
    </section>
  );
}
