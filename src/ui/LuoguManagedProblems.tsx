import { useEffect, useRef, useState } from 'react';
import type { ApiLuoguManageProblemsRequest, ApiLuoguStatusView } from '../application/workbench-api.js';
import { api, ApiClientError } from './api.js';
import { Empty, ErrorNotice, useRequest } from './common.js';
import { luoguMetadataMutationReason } from './luogu-metadata-view.js';

export type ManagementTarget = ApiLuoguManageProblemsRequest['items'][number] & { readonly externalKey: string };
const actionText = { skip: '跳过补题面', trash: '移入回收站', restore: '恢复题目' } as const;

/** One explicit, immutable selection per confirmation. Closing or switching accounts discards it. */
export function useLuoguManagement(accountId: string, disabled: boolean, onSettled: () => void) {
  const [draft, setDraft] = useState<{ action: ApiLuoguManageProblemsRequest['action']; items: readonly ManagementTarget[] } | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const alive = useRef(true), controller = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  function begin(action: ApiLuoguManageProblemsRequest['action'], items: readonly ManagementTarget[]) {
    if (disabled || draft || controller.current || items.length === 0 || items.length > 50) return;
    setDraft({ action, items: items.map(item => ({ ...item })) });
    setNotice(null); setFailure(null);
  }
  async function submit() {
    if (!draft || disabled || controller.current || failure) return;
    const abort = new AbortController(); controller.current = abort; setPending(true);
    try {
      const result = await api.request('luogu.manageProblems', {
        accountId, action: draft.action,
        items: draft.items.map(({ problemKey, expectedState }) => ({ problemKey, expectedState })),
      }, abort.signal);
      if (!alive.current || abort.signal.aborted) return;
      setNotice(`已${actionText[draft.action]}：${result.changed} 题。`);
      setDraft(null);
    } catch (error) {
      if (!alive.current || abort.signal.aborted) return;
      setFailure(error instanceof ApiClientError && ['conflict', 'invalid_input'].includes(error.code)
        ? `${error.message} 请取消并刷新列表，再重新选择。`
        : '操作未确认完成，请取消并刷新列表核对状态。同步运行时请先暂停；本操作无需登录或 AI。');
    } finally {
      controller.current = null;
      if (alive.current) { setPending(false); onSettled(); }
    }
  }
  const confirmation = <>
    {notice && <p role="status">{notice}</p>}
    {draft && <section className="icpc-notice" aria-label="确认题目管理操作">
      <strong>{actionText[draft.action]} · {draft.items.length} 题</strong>
      <p>{draft.action === 'trash'
        ? '移入可恢复的回收站，并从本地题库、做题统计及新的能力评估、训练选题中排除。后续同步不会让它重新出现。'
        : draft.action === 'skip'
          ? '停止自动补齐这些题目的题面，保留做题记录及统计。后续同步继续跳过，直到你手动恢复。'
          : '恢复为正常题目；缺少资料时重新进入待补队列，已有记录重新参与统计。'}</p>
      <p className="icpc-muted">作用于此本地洛谷来源的所有账号；其他平台的同题记录单独保留。不会删除洛谷网站上的题目或提交，不使用 AI。旧的评估报告是历史快照，请重新生成以反映变化。</p>
      <p aria-label="本次选中的题号">{draft.items.map(item => item.externalKey).join('、')}</p>
      {failure && <p role="alert">{failure}</p>}
      <div className="icpc-actions">
        <button type="button" className="icpc-primary" disabled={pending || disabled || failure !== null} onClick={() => void submit()}>{pending ? '处理中…' : `确认${actionText[draft.action]}`}</button>
        <button type="button" disabled={pending} onClick={() => { setDraft(null); setFailure(null); }}>取消</button>
      </div>
    </section>}
  </>;
  return { begin, busy: draft !== null || pending, confirmation };
}

/** Mounted only for the selected recovery tab, never reads the whole disposition table. */
export function LuoguManagedProblems({ accountId, state, status, onChange }: {
  accountId: string; state: 'skipped' | 'trashed'; status: ApiLuoguStatusView; onChange: () => void;
}) {
  const [page, setPage] = useState(1), [selected, setSelected] = useState<string[]>([]);
  const request = useRequest('luogu.managedProblems', { accountId, state, page, pageSize: 20 });
  const view = request.data;
  const gate = luoguMetadataMutationReason(status, false);
  const management = useLuoguManagement(accountId, gate !== null, () => { setSelected([]); request.refresh(); onChange(); });
  useEffect(() => { setSelected([]); if (view && view.page !== page) setPage(view.page); }, [view, page]);
  const rows = view?.items ?? [];
  const chosen = rows.filter(item => selected.includes(item.problemKey));
  const targets = (items: typeof rows): ManagementTarget[] => items.map(item => ({ problemKey: item.problemKey, externalKey: item.externalKey, expectedState: item.state }));
  const blocked = management.busy || gate !== null;
  const pages = Math.max(1, Math.ceil((view?.total ?? 0) / 20));
  function go(next: number) { setSelected([]); setPage(next); }
  return <>
    <p className="icpc-muted">{state === 'skipped' ? '已跳过的题目保留做题记录，不再自动补题面。' : '回收站中的题目不参与本地题库、统计和新的能力评估。原始记录仍保留，后续同步不会恢复显示。'} 同一本地洛谷来源的账号共用此列表。</p>
    <ErrorNotice error={request.error} />
    {gate && <p role="status">{gate}</p>}
    {management.confirmation}
    {view === null ? <Empty>{request.pending ? '读取中…' : '读取失败，请刷新。'}</Empty> : <>
      <div className="icpc-actions">
        <label className="icpc-check"><input type="checkbox" aria-label="选择本页全部已处理题目" checked={rows.length > 0 && chosen.length === rows.length} disabled={blocked || rows.length === 0} onChange={event => setSelected(event.target.checked ? rows.map(item => item.problemKey) : [])} />选择本页</label>
        <span>已选 {chosen.length} 题 · 共 {view.total} 题</span>
        <button type="button" disabled={blocked || chosen.length === 0} onClick={() => management.begin('restore', targets(chosen))}>恢复选中题目</button>
        {state === 'skipped' && <button type="button" disabled={blocked || chosen.length === 0} onClick={() => management.begin('trash', targets(chosen))}>选中题目移入回收站</button>}
      </div>
      {rows.length === 0 ? <Empty>{state === 'skipped' ? '没有已跳过的题目。' : '回收站为空。'}</Empty> : <ul className="icpc-luogu-backlog">
        {rows.map(item => <li key={item.problemKey}>
          <label className="icpc-check"><input type="checkbox" aria-label={`选择 ${item.externalKey}`} checked={selected.includes(item.problemKey)} disabled={blocked} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.problemKey] : previous.filter(key => key !== item.problemKey))} /> {item.externalKey} · {item.title ?? '（本地没有标题）'}</label>
          <div className="icpc-actions">
            <button type="button" disabled={blocked} onClick={() => management.begin('restore', targets([item]))}>恢复此题</button>
            {state === 'skipped' && <button type="button" disabled={blocked} onClick={() => management.begin('trash', targets([item]))}>移入回收站</button>}
          </div>
        </li>)}
      </ul>}
      <div className="icpc-actions">
        <button type="button" disabled={blocked || page <= 1} onClick={() => go(1)}>首页</button>
        <button type="button" disabled={blocked || page <= 1} onClick={() => go(page - 1)}>上一页</button>
        <span>第 {page} / {pages} 页</span>
        <button type="button" disabled={blocked || page >= pages} onClick={() => go(page + 1)}>下一页</button>
        <button type="button" disabled={blocked || page >= pages} onClick={() => go(pages)}>末页</button>
      </div>
    </>}
    <button type="button" disabled={request.pending || management.busy} onClick={() => { setSelected([]); request.refresh(); onChange(); }}>刷新列表</button>
  </>;
}
