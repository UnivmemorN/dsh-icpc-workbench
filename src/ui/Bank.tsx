import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Panel, Empty, Notice, ErrorNotice, useWorkbench, useRequest, tagName } from './common.js';
import { ImportPanel } from './Imports.js';
import { jumpHint, pagerDisplay, parseJumpPage } from './pager.js';
import { ProblemView } from './Problem.js';

/** Page sizes the bank offers; the API accepts any size within 1..100. */
const PAGE_SIZES = [25, 50, 100] as const;

/** Solved-state choices, relative to the current account; the first one is the default. */
const STATUS_OPTIONS = [
  ['all', '全部'],
  ['solved', '已通过'],
  ['unconfirmed', '未确认通过'],
] as const;

type SolvedStatus = (typeof STATUS_OPTIONS)[number][0];

/** Why status filtering is unavailable, shown next to the disabled selector. */
const STATUS_HINT = '未选择当前账号：通过状态无法判断，请先在顶部选择账号。';

/**
 * Nearby numbered pages around `current`, with `null` marking an elided gap.
 *
 * Only the first page, the last page, the current page and two neighbours on each side are offered,
 * so a 500-page bank stays a handful of buttons instead of one control per page.
 */
function pageNumbers(current: number, total: number): readonly (number | null)[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const wanted = new Set<number>([1, total, current]);
  for (let offset = 1; offset <= 2; offset += 1) {
    wanted.add(current - offset);
    wanted.add(current + offset);
  }
  const pages = [...wanted].filter((page) => page >= 1 && page <= total).sort((left, right) => left - right);
  const out: (number | null)[] = [];
  let previous = 0;
  for (const page of pages) {
    if (page - previous > 1) {
      out.push(null);
    }
    out.push(page);
    previous = page;
  }
  return out;
}

/**
 * Problem bank (and the review queue when `reviewOnly`).
 *
 * The list is read through `problem.browse`: one numbered database page plus the filtered total, so
 * the counters and the rows always describe the same query. Every filter change resets the page to
 * 1; the account is changed in the header (which remounts this component), and revealing labels
 * keeps the current filter and page. Loading and failed requests render no rows at all, and an
 * in-flight request is aborted as soon as the filter set changes, so a stale answer cannot overwrite
 * a newer one. Counters come only from a confirmed response: with none, the pager reports
 * `正在读取…`/`暂无结果` and disables every control instead of fabricating zero pages, and a
 * confirmed empty page displays `第 0 / 0 页`. The jump field accepts only a positive safe-integer
 * page and explains a malformed value inline. The inline problem detail below the table never
 * disturbs this state.
 */
export function Bank({ reviewOnly = false }: { reviewOnly?: boolean }) {
  const { boot, accountId, problemKey, navigate, selectedKeys, setSelectedKeys } = useWorkbench();
  const account = boot.accounts.find((entry) => entry.id === accountId);
  const [sourceId, setSourceId] = useState(account?.sourceInstanceId ?? boot.sources[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [reveal, setReveal] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<SolvedStatus>('all');
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const [jump, setJump] = useState('');
  const results = useRef<HTMLDivElement | null>(null);

  const read = useRequest('problem.browse', {
    ...(sourceId ? { sourceInstanceId: sourceId } : {}),
    accountId,
    // Solved state is a statement about one account, so the filter is only sent with an account.
    ...(accountId ? { status } : {}),
    ...(search.trim() ? { query: search.trim() } : {}),
    limit: pageSize,
    page,
    reveal,
    onlyAttempted: attempted,
    needsReviewOnly: reviewOnly,
  });
  const data = read.data;

  // The store clamps an out-of-range page to the last valid page (for example after data changed
  // underneath this screen); mirror that answer back so the next request starts where the server
  // actually served from.
  const servedPage = data?.page;
  useEffect(() => {
    if (servedPage !== undefined && servedPage !== page) {
      setPage(servedPage);
    }
  }, [servedPage, page]);

  // Single source of truth for the counters: without a confirmed response there is no honest total,
  // so nothing is rendered as a fabricated zero (see `pager` below).
  const view = pagerDisplay(data, page);

  /** Move to one page, bounding it locally; the bottom pager also returns focus to the results. */
  function goTo(target: number, from: 'top' | 'bottom'): void {
    const bounded = view.totalPages === 0 ? 1 : Math.min(Math.max(1, Math.trunc(target)), view.totalPages);
    setPage(bounded);
    if (from === 'bottom') {
      // Long lists must not force a scroll back to the start: bring the results into view and put
      // focus on them, so keyboard navigation continues inside the table that just changed. The
      // scroll and focus happen with the click itself, never queued for a later response, so a
      // filter change cannot inherit a stale bottom-scroll action.
      results.current?.scrollIntoView({ block: 'start' });
      results.current?.focus();
    }
  }

  function toggle(key: string): void {
    setSelectedKeys(
      selectedKeys.includes(key) ? selectedKeys.filter((entry) => entry !== key) : [...selectedKeys, key],
    );
  }

  function submitJump(event: FormEvent<HTMLFormElement>, from: 'top' | 'bottom'): void {
    event.preventDefault();
    const target = parseJumpPage(jump);
    if (target === null) {
      // Blank or malformed text is a no-op: the value stays in the field beside its inline hint so it
      // can be corrected, instead of being coerced to 0 and jumping to the first page.
      return;
    }
    goTo(target, from);
    setJump('');
  }

  /** One pager; top and bottom share it but carry distinct accessible labels. */
  function pager(where: 'top' | 'bottom') {
    const label = where === 'top' ? '题库分页（顶部）' : '题库分页（底部）';
    const busy = read.pending;
    // Without a confirmed response there is no page to navigate to: every control is disabled and the
    // counter line reports the request state instead of a fabricated zero page.
    const locked = busy || !view.navigable;
    const counter = view.hasData
      ? `共 ${view.totalItems} 题 · 第 ${view.currentPage} / ${view.totalPages} 页`
      : busy
        ? '正在读取…'
        : '暂无结果';
    const jumpId = `icpc-bank-jump-${where}`;
    const hintId = `icpc-bank-jump-hint-${where}`;
    const warning = jumpHint(jump);
    return (
      <nav className="icpc-pager" aria-label={label}>
        <button type="button" disabled={locked || view.currentPage <= 1} onClick={() => goTo(1, where)}>
          « 首页
        </button>
        <button
          type="button"
          disabled={locked || view.currentPage <= 1}
          onClick={() => goTo(view.currentPage - 1, where)}
        >
          ‹ 上一页
        </button>
        {pageNumbers(view.currentPage, view.totalPages).map((entry, index) =>
          entry === null ? (
            <span key={`gap-${index}`} className="icpc-pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              className={entry === view.currentPage ? 'icpc-page-current' : undefined}
              aria-current={entry === view.currentPage ? 'page' : undefined}
              aria-label={`${label}：第 ${entry} 页`}
              disabled={locked}
              onClick={() => goTo(entry, where)}
            >
              {entry}
            </button>
          ),
        )}
        <button
          type="button"
          disabled={locked || view.currentPage >= view.totalPages}
          onClick={() => goTo(view.currentPage + 1, where)}
        >
          下一页 ›
        </button>
        <button
          type="button"
          disabled={locked || view.currentPage >= view.totalPages}
          onClick={() => goTo(view.totalPages, where)}
        >
          末页 »
        </button>
        <form className="icpc-page-jump" onSubmit={(event) => submitJump(event, where)}>
          <label htmlFor={jumpId}>跳至</label>
          <input
            id={jumpId}
            value={jump}
            inputMode="numeric"
            aria-label={`${label}：页码输入`}
            aria-invalid={warning === null ? undefined : true}
            aria-describedby={warning === null ? undefined : hintId}
            onChange={(event) => setJump(event.target.value)}
          />
          <button type="submit" disabled={locked || parseJumpPage(jump) === null}>
            跳转
          </button>
        </form>
        {warning !== null && (
          <small className="icpc-muted" id={hintId} role="status">
            {warning}
          </small>
        )}
        <span className="icpc-muted" aria-live="polite">
          {counter}
        </span>
      </nav>
    );
  }

  return (
    <>
      <div className="icpc-page-heading">
        <div>
          <p className="icpc-eyebrow">{reviewOnly ? 'REVIEW' : 'PROBLEM BANK'}</p>
          <h1>{reviewOnly ? '核对标签与真实解法' : '让每一道题都有完整来历'}</h1>
          <p>保留平台标签、题解证据和人工判断，材料更新会使旧分析失效。</p>
        </div>
      </div>
      <div className="icpc-toolbar">
        <label>
          来源
          <select
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setPage(1);
              navigate('bank', '');
            }}
          >
            {boot.sources.map((source) => (
              <option
                key={source.id}
                value={source.id}
                disabled={Boolean(account && source.id !== account.sourceInstanceId)}
              >
                {source.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          搜索题号或标题
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                setSearch(query);
                setPage(1);
              }
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setSearch(query);
            setPage(1);
          }}
        >
          搜索
        </button>
        <label>
          状态
          <select
            value={status}
            disabled={!accountId}
            title={accountId ? undefined : STATUS_HINT}
            aria-describedby={accountId ? undefined : 'icpc-bank-status-hint'}
            onChange={(event) => {
              setStatus(event.target.value as SolvedStatus);
              setPage(1);
            }}
          >
            {STATUS_OPTIONS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label>
          每页
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={read.refresh} disabled={read.pending}>
          刷新
        </button>
      </div>
      {!accountId && (
        <p className="icpc-muted" id="icpc-bank-status-hint">
          {STATUS_HINT}
        </p>
      )}
      <div className="icpc-toolbar">
        <label className="icpc-check">
          <input
            type="checkbox"
            checked={attempted}
            disabled={!accountId}
            onChange={(event) => {
              setAttempted(event.target.checked);
              setPage(1);
            }}
          />
          仅看该账号尝试过的题
        </label>
        <label className="icpc-check">
          <input type="checkbox" checked={reveal} onChange={(event) => setReveal(event.target.checked)} />
          显示列表中的算法标签
        </label>
      </div>
      <ImportPanel sourceId={sourceId} onChange={read.refresh} />
      <Panel
        title={reviewOnly ? '当前快照待审核题目' : '本地题库'}
        tools={
          <span className="icpc-muted">
            {data === null ? (read.pending ? '正在读取…' : '暂无结果') : `共 ${data.totalItems} 题`}
          </span>
        }
      >
        <ErrorNotice error={read.error} />
        {read.error === null && pager('top')}
        {read.pending && data !== null && (
          <p className="icpc-muted" role="status">
            正在刷新…
          </p>
        )}
        {read.error === null && data !== null && data.items.length === 0 && (
          <Empty>当前筛选下没有题目。可以同步公开目录，或使用手工导入。</Empty>
        )}
        <div
          className="icpc-table-wrap icpc-bank-table"
          ref={results}
          tabIndex={-1}
          aria-label="题库结果"
          aria-busy={read.pending}
        >
          <table>
            <thead>
              <tr>
                <th>选择</th>
                <th>题目</th>
                <th>平台难度</th>
                <th>状态 / 标签</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((problem) => (
                <tr key={problem.problemKey}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={'选择 ' + problem.externalKey}
                      checked={selectedKeys.includes(problem.problemKey)}
                      disabled={!selectedKeys.includes(problem.problemKey) && selectedKeys.length >= 100}
                      onChange={() => toggle(problem.problemKey)}
                    />
                  </td>
                  <td>
                    <button type="button" onClick={() => navigate('bank', problem.problemKey)}>
                      {problem.externalKey} · {problem.title}
                    </button>
                  </td>
                  <td>
                    {problem.rawRatings.map((rating) => rating.dimension + ': ' + (rating.raw ?? rating.value)).join(' / ') ||
                      '未提供'}
                  </td>
                  <td>
                    {problem.solvedByAccount ? '已通过' : '未确认通过'}
                    {problem.pendingReview && <span className="icpc-tag icpc-warning">待审核</span>}
                    {problem.effectiveTaxonomyIds?.map((id) => (
                      <span key={id} className="icpc-tag">
                        {tagName(id, boot)}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {read.error === null && pager('bottom')}
        <div className="icpc-actions">
          <span className="icpc-muted">已选择 {selectedKeys.length} / 100 题</span>
          <button type="button" disabled={!selectedKeys.length} onClick={() => setSelectedKeys([])}>
            清空选择
          </button>
          <button
            type="button"
            className="icpc-primary"
            disabled={!selectedKeys.length}
            onClick={() => navigate('review')}
          >
            准备标签分析
          </button>
          <button
            type="button"
            disabled={!accountId || !selectedKeys.length}
            onClick={() => navigate('plans')}
          >
            作为计划候选题
          </button>
        </div>
      </Panel>
      {problemKey ? (
        <ProblemView key={problemKey + '|' + accountId} problemKey={problemKey} onChange={read.refresh} />
      ) : (
        <Notice>点击题目查看题面；未完成题目的标签与题解保持隐藏，直到你明确选择查看。</Notice>
      )}
    </>
  );
}
