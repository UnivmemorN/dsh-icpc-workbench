/**
 * Merged cross-site problem bank (Sprint Contract 08c): the read-only `problem.mergedBrowse` view.
 *
 * The view answers one question the single-platform bank cannot: which stored problems are the same
 * problem on two sites, and whether any of *the selected accounts* really passed one of them. It is
 * display-only. Everything that writes — importing, syncing, tag review, plan candidates, paid
 * coaching — stays in the original per-platform bank, which is why this screen offers an explicit
 * `导入 / 同步各平台数据` button back to it instead of reimplementing any of those flows.
 *
 * The rules it renders are deliberately narrow:
 *
 * - the account scope is at most one stored account per source instance, and it starts as *only* the
 *   account selected in the header. Every other platform stays `不参与统计` until the user chooses an
 *   account for it; nothing is ever unioned in from other accounts;
 * - `已通过` is the group banner and means "one of the selected accounts has an accepted submission
 *   for an equivalent identity". It never reveals a member's tags, and each member keeps its own
 *   `本平台已通过` / `关联题目已通过` / `本平台状态未知` badge;
 * - every member shows its own canonical id, title, source, original URL and raw platform difficulty.
 *   Rows of different platforms never share a native identifier;
 * - the inline detail opens one member's own canonical `problemKey` with **that member's** matching
 *   selected account (or no account). The header's account of another platform is never passed into a
 *   native read: the detail renders under a cloned workbench context, so coaching and the
 *   retrospective record the same native account the detail was opened for.
 *
 * Reads go through `useRequest`, so a changed filter aborts the in-flight request and a stale answer
 * cannot overwrite a newer one. The counters come only from a confirmed response: without one the
 * pager reports the request state and disables every control instead of fabricating zero groups.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  WorkbenchMergedProblemGroup,
  WorkbenchMergedProblemMember,
} from '../application/workbench-types.js';
import {
  Empty,
  ErrorNotice,
  ExternalLink,
  Notice,
  Panel,
  WorkbenchContext,
  useRequest,
  useWorkbench,
} from './common.js';
import { jumpHint, pageNumbers, pagerDisplay, parseJumpPage } from './pager.js';
import { ProblemView } from './Problem.js';
import {
  DEFAULT_MERGED_SORT,
  MERGED_ACCOUNT_SCOPE_NOTE,
  MERGED_DIFFICULTY_HINT,
  MERGED_FALLBACK_DIMENSION,
  MAX_MERGED_DIMENSION_CHARS,
  MERGED_PAGE_SIZES,
  MERGED_READONLY_NOTE,
  MERGED_SORT_OPTIONS,
  MERGED_STATUS_HINT,
  MERGED_STATUS_OPTIONS,
  MERGED_VIEW_NOTE,
  NOT_PARTICIPATING,
  NO_ACCOUNT_FOR_SOURCE,
  accountLabelOf,
  accountOptionText,
  commitDimensionDraft,
  detailKeyOf,
  dimensionForSource,
  evidenceHasLocalMetadata,
  evidenceTextOf,
  mappingText,
  memberBadgeText,
  memberOrder,
  mergedSolvedText,
  mergedSortDisabled,
  nativeSolvedText,
  normalizeMergedSort,
  platformRatingDimension,
  ratingTextOf,
  selectedAccountOfSource,
  setSourceAccount,
  sourceAccountOptions,
  sourceLabelOf,
  type MergedSolvedFilter,
  type MergedSort,
} from './merged.js';

/** The member detail currently expanded below the group table. */
interface OpenDetail {
  readonly groupKey: string;
  readonly problemKey: string;
  readonly accountId: string | null;
}

/** Merged cross-site bank; `onSwitchToPlatform` is the explicit way back to the original bank. */
export function MergedBank({ onSwitchToPlatform }: { onSwitchToPlatform: () => void }) {
  const workbench = useWorkbench();
  const { boot, accountId } = workbench;
  const headerAccount = boot.accounts.find((entry) => entry.id === accountId) ?? null;
  // Default scope: ONLY the account the header currently selects. Other platforms stay out until the
  // user chooses an account for them.
  const [selectedAccounts, setSelectedAccounts] = useState<readonly string[]>(() =>
    headerAccount === null ? [] : [headerAccount.id],
  );
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<MergedSolvedFilter>('all');
  const [attempted, setAttempted] = useState(false);
  const [sort, setSort] = useState<MergedSort>(DEFAULT_MERGED_SORT);
  const [dimension, setDimension] = useState(MERGED_FALLBACK_DIMENSION);
  const [dimensionDraft, setDimensionDraft] = useState(MERGED_FALLBACK_DIMENSION);
  const [dimensionWarning, setDimensionWarning] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<number>(MERGED_PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const [jump, setJump] = useState('');
  const [detail, setDetail] = useState<OpenDetail | null>(null);
  const results = useRef<HTMLDivElement | null>(null);
  /** Set as soon as the user picks accounts themselves: the header default must then never override it. */
  const choseAccounts = useRef(false);

  // `account.create` selects the new account before a refreshed bootstrap can contain it, so the
  // first render may not see it yet. Adopt the header account once it appears — but only while the
  // user has not chosen accounts, so an explicit `不参与统计` is never silently undone.
  useEffect(() => {
    if (choseAccounts.current || headerAccount === null) {
      return;
    }
    setSelectedAccounts((previous) =>
      previous.length === 1 && previous[0] === headerAccount.id ? previous : [headerAccount.id],
    );
  }, [headerAccount?.id]);

  const hasAccounts = selectedAccounts.length > 0;
  const needsDimension = sort === 'difficulty_asc' || sort === 'difficulty_desc';
  const filteredSource = boot.sources.find((entry) => entry.id === sourceFilter) ?? null;
  // The raw dimension label the filtered platform publishes, or `null` when the user must name one.
  const platformDimension = filteredSource === null ? null : platformRatingDimension(filteredSource.platform);

  const read = useRequest('problem.mergedBrowse', {
    accountIds: selectedAccounts,
    sourceInstanceId: sourceFilter,
    // Solved state and attempts are statements about the selected accounts, so they are only sent
    // with at least one; without one the selectors are disabled and reset to their neutral values.
    ...(hasAccounts && status !== 'all' ? { status } : {}),
    ...(search.trim() ? { query: search.trim() } : {}),
    sort,
    ...(needsDimension ? { ratingDimension: dimension } : {}),
    limit: pageSize,
    page,
    onlyAttempted: attempted,
  });
  const data = read.data;

  // The store clamps an out-of-range page to the last valid page; mirror that answer back so the next
  // request starts where the server actually served from.
  const servedPage = data?.page;
  useEffect(() => {
    if (servedPage !== undefined && servedPage !== page) {
      setPage(servedPage);
    }
  }, [servedPage, page]);

  // Single source of truth for the counters: without a confirmed response there is no honest total.
  const view = pagerDisplay(data, page);

  // The open detail is looked up in the current response instead of being duplicated in state, so it
  // can never describe a group the visible page no longer contains.
  const openDetail =
    detail === null
      ? null
      : { ...detail, group: data?.items.find((group) => group.groupKey === detail.groupKey) ?? null };

  /** Every filter change clears the open member detail and returns to page 1. */
  function resetView(): void {
    setDetail(null);
    setPage(1);
  }

  function changeAccounts(next: readonly string[]): void {
    choseAccounts.current = true;
    setSelectedAccounts(next);
    if (next.length === 0) {
      // Without an account there is nothing whose solved state could be filtered or listed.
      setStatus('all');
      setAttempted(false);
    }
    resetView();
  }

  function changeSource(next: string | null): void {
    setSourceFilter(next);
    // A difficulty order compares one raw dimension of one instance, so switching back to all sources
    // falls back to the natural 题号升序 order instead of sending an unanswerable request.
    setSort((previous) => normalizeMergedSort(previous, next));
    const nextDimension = dimensionForSource(boot.sources.find((entry) => entry.id === next));
    setDimension(nextDimension);
    setDimensionDraft(nextDimension);
    setDimensionWarning(null);
    resetView();
  }

  function changeSearch(): void {
    setSearch(query);
    resetView();
  }

  /** Move to one page, bounding it locally; the bottom pager returns focus to the results. */
  function goTo(target: number, from: 'top' | 'bottom'): void {
    const bounded = view.totalPages === 0 ? 1 : Math.min(Math.max(1, Math.trunc(target)), view.totalPages);
    setDetail(null);
    setPage(bounded);
    if (from === 'bottom') {
      results.current?.scrollIntoView({ block: 'start' });
      results.current?.focus();
    }
  }

  function submitJump(event: FormEvent<HTMLFormElement>, from: 'top' | 'bottom'): void {
    event.preventDefault();
    const target = parseJumpPage(jump);
    if (target === null) {
      // Blank or malformed text is a no-op: the value stays beside its inline hint for correction
      // instead of being coerced to 0 and jumping to the first page.
      return;
    }
    goTo(target, from);
    setJump('');
  }

  /**
   * Commit an edited difficulty dimension.
   *
   * A blank or over-long draft keeps the previous committed dimension and explains itself inline; a
   * valid change resets the page to 1. Nothing else about the view moves, and the open member detail
   * is left untouched: editing a dimension is not a filter change.
   */
  function commitDimension(): void {
    const result = commitDimensionDraft(dimensionDraft, dimension);
    setDimension(result.dimension);
    setDimensionDraft(result.draft);
    setDimensionWarning(result.warning);
    if (result.changed) {
      setDetail(null);
      setPage(1);
    }
  }

  /**
   * Open one member's own detail.
   *
   * The canonical key is the member's own `problemKey` and the account is that member's own selected
   * account (or `null`) — the global header account is never passed into a foreign platform's read.
   * Opening or closing the detail preserves the filters and the current page.
   */
  function openDetailFor(group: WorkbenchMergedProblemGroup, member: WorkbenchMergedProblemMember): void {
    setDetail({ groupKey: group.groupKey, problemKey: member.problem.problemKey, accountId: member.accountId });
  }

  /** One pager; top and bottom share it but carry distinct accessible labels. */
  function pager(where: 'top' | 'bottom') {
    const label = where === 'top' ? '合并题库分页（顶部）' : '合并题库分页（底部）';
    const busy = read.pending;
    const locked = busy || !view.navigable;
    const counter = view.hasData
      ? `共 ${view.totalItems} 组 · 第 ${view.currentPage} / ${view.totalPages} 页`
      : busy
        ? '正在读取…'
        : '暂无结果';
    const jumpId = `icpc-merged-jump-${where}`;
    const hintId = `icpc-merged-jump-hint-${where}`;
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

  const accountOptions = sourceAccountOptions(boot.sources, boot.accounts);

  return (
    <>
      <div className="icpc-page-heading">
        <div>
          <p className="icpc-eyebrow">MERGED BANK</p>
          <h1>合并题库（跨站去重）</h1>
          <p>各平台题目统一浏览，CF 镜像题自动去重并联动 AC。</p>
        </div>
      </div>
      <Panel
        title="统计账号（每个平台至多一个）"
        tools={
          <button type="button" onClick={onSwitchToPlatform}>
            导入 / 同步各平台数据
          </button>
        }
      >
        <p className="icpc-muted">{MERGED_ACCOUNT_SCOPE_NOTE}</p>
        <div className="icpc-merged-accounts">
          {accountOptions.map(({ source, accounts }, index) => (
            <label key={source.id} className="icpc-merged-account">
              {source.displayName}
              <select
                aria-label={`合并题库：${source.displayName} 的统计账号`}
                value={selectedAccountOfSource(selectedAccounts, boot.accounts, source.id)}
                disabled={accounts.length === 0}
                title={accounts.length === 0 ? NO_ACCOUNT_FOR_SOURCE : undefined}
                aria-describedby={accounts.length === 0 ? `icpc-merged-account-note-${index}` : undefined}
                onChange={(event) =>
                  changeAccounts(
                    setSourceAccount(selectedAccounts, boot.accounts, source.id, event.target.value || null),
                  )
                }
              >
                <option value="">{NOT_PARTICIPATING}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountOptionText(account, source)}
                  </option>
                ))}
              </select>
              {accounts.length === 0 && (
                <small className="icpc-muted" id={`icpc-merged-account-note-${index}`}>
                  {NO_ACCOUNT_FOR_SOURCE}
                </small>
              )}
            </label>
          ))}
        </div>


        <p className="icpc-muted" aria-live="polite">
          已选择 {selectedAccounts.length} 个平台的统计账号。
        </p>
      </Panel>
      <div className="icpc-toolbar">
        <label>
          来源
          <select value={sourceFilter ?? ''} onChange={(event) => changeSource(event.target.value || null)}>
            <option value="">全部来源</option>
            {boot.sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          搜索成员题号或标题
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                changeSearch();
              }
            }}
          />
        </label>
        <button type="button" onClick={changeSearch}>
          搜索
        </button>
        <label>
          排序
          <select
            value={sort}
            aria-describedby={sourceFilter === null ? 'icpc-merged-sort-hint' : undefined}
            onChange={(event) => {
              setSort(event.target.value as MergedSort);
              resetView();
            }}
          >
            {MERGED_SORT_OPTIONS.map(([value, text]) => (
              <option key={value} value={value} disabled={mergedSortDisabled(value, sourceFilter)}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select
            value={status}
            disabled={!hasAccounts}
            title={hasAccounts ? undefined : MERGED_STATUS_HINT}
            aria-describedby={hasAccounts ? undefined : 'icpc-merged-status-hint'}
            onChange={(event) => {
              setStatus(event.target.value as MergedSolvedFilter);
              resetView();
            }}
          >
            {MERGED_STATUS_OPTIONS.map(([value, text]) => (
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
              resetView();
            }}
          >
            {MERGED_PAGE_SIZES.map((size) => (
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
      {sourceFilter === null && (
        <p className="icpc-muted" id="icpc-merged-sort-hint">
          难度排序需先选择具体平台，各平台保留自己的难度刻度。
        </p>
      )}
      {!hasAccounts && (
        <p className="icpc-muted" id="icpc-merged-status-hint">
          {MERGED_STATUS_HINT}
        </p>
      )}
      <div className="icpc-toolbar">
        <label className="icpc-check">
          <input
            type="checkbox"
            checked={attempted}
            disabled={!hasAccounts}
            onChange={(event) => {
              setAttempted(event.target.checked);
              resetView();
            }}
          />
          仅看所选账号尝试过的题
        </label>
      </div>
      {needsDimension && (
        <div className="icpc-toolbar">
          {platformDimension === null ? (
            <label>
              难度维度
              <input
                value={dimensionDraft}
                maxLength={MAX_MERGED_DIMENSION_CHARS}
                aria-invalid={dimensionWarning === null ? undefined : true}
                aria-describedby={
                  dimensionWarning === null
                    ? 'icpc-merged-dimension-hint'
                    : 'icpc-merged-dimension-hint icpc-merged-dimension-warning'
                }
                onChange={(event) => setDimensionDraft(event.target.value)}
                onBlur={commitDimension}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitDimension();
                  }
                }}
              />
            </label>
          ) : (
            <span className="icpc-muted">
              难度维度：{dimension}（{filteredSource?.displayName ?? '所选来源'} 的原始难度）
            </span>
          )}
          {dimensionWarning !== null && (
            <small className="icpc-muted" id="icpc-merged-dimension-warning" role="status">
              {dimensionWarning}
            </small>
          )}
          <small className="icpc-muted" id="icpc-merged-dimension-hint">
            {MERGED_DIFFICULTY_HINT}
          </small>
        </div>
      )}
      <Panel
        title="合并题库（跨站去重）"
        tools={
          <span className="icpc-muted">
            {data === null ? (read.pending ? '正在读取…' : '暂无结果') : `共 ${data.totalItems} 组`}
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
          <Empty>当前筛选下没有题目组。可以放宽筛选，或回到原平台题库同步更多平台数据。</Empty>
        )}
        <div
          className="icpc-table-wrap icpc-bank-table"
          ref={results}
          tabIndex={-1}
          aria-label="合并题库结果"
          aria-busy={read.pending}
        >
          <table>
            <thead>
              <tr>
                <th>题目</th>
                <th>各平台题目</th>
                <th>合并状态</th>
                <th>平台原始难度</th>

              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((group) => {
                // Members are rendered in the order the backend sorted the group by, so the leading
                // visible ID/title is the value the requested order actually compared.
                const ordered = memberOrder(group.members, sourceFilter);
                const lead = ordered[0] ?? null;
                return (
                  <tr key={group.groupKey}>
                    <td>
                      {lead === null ? (
                        <span className="icpc-muted">该组没有成员</span>
                      ) : (
                        <>
                          <button type="button" onClick={() => openDetailFor(group, lead)}>
                            {lead.problem.externalKey} · {lead.problem.title}
                          </button>
                          {ordered.length > 1 && <small className="icpc-muted">{mappingText(group.mappingKind, ordered.length)}</small>}
                        </>
                      )}
                    </td>
                    <td>
                      <ul className="icpc-merged-members">
                        {ordered.map((member) => (
                          <li key={member.problem.problemKey}>
                            <span className="icpc-tag">
                              {sourceLabelOf(member.problem.sourceInstanceId, boot.sources)}
                            </span>
                            <span>
                              {member.problem.externalKey}{member !== lead ? ` · ${member.problem.title}` : ''}
                            </span>
                            <ExternalLink href={member.problem.url}>原题</ExternalLink>
                            <button type="button" aria-label={`查看 ${sourceLabelOf(member.problem.sourceInstanceId, boot.sources)} ${member.problem.externalKey} 详情`} onClick={() => openDetailFor(group, member)}>详情</button>
                            <small className="icpc-muted">
                              {memberBadgeText(member.problem.solvedByAccount, group.solved)}
                              {member.accountId === null && !group.solved ? ' · 未选择本平台账号' : ''}
                            </small>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <strong>{mergedSolvedText(selectedAccounts.length, group.solved)}</strong>
                      {group.attempted && !group.solved && (
                        <small className="icpc-muted">已尝试，尚无 AC 记录</small>
                      )}
                      {group.acceptedEvidence.length > 0 && (
                        <details>
                          <summary>通过证据（{group.acceptedEvidence.length}）</summary>
                          <ul className="icpc-merged-evidence">
                            {group.acceptedEvidence.map((entry) => (
                              <li key={entry.submissionId}>
                                <span>{evidenceTextOf(entry, boot.accounts, boot.sources)}</span>
                                {!evidenceHasLocalMetadata(ordered, entry) && (
                                  <small className="icpc-muted">
                                    该 AC 对应的题目信息尚未导入，通过依据来自已保存的提交记录。
                                  </small>
                                )}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td>
                      {ordered.map((member) => (
                        <div key={member.problem.problemKey}>
                          <small className="icpc-muted">
                            {sourceLabelOf(member.problem.sourceInstanceId, boot.sources)}：
                          </small>{' '}
                          {ratingTextOf(member.problem)}
                        </div>
                      ))}
                    </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {read.error === null && pager('bottom')}
        <p className="icpc-muted">{MERGED_VIEW_NOTE}</p>
        <details className="icpc-merged-rules">
          <summary>合并规则说明（只识别 CF 原题编号）</summary>
          <p className="icpc-muted">
            只按已知的 Codeforces ↔ 洛谷 CF 前缀镜像编号规则关联，并且要求两边都是官方站点、题号写法规范；标题、标签、难度或题面相似都不会触发合并。只有一条本地记录的已识别题目会写明“按 CF 原题编号关联”，因此不会暗示本地存在两条记录。
          </p>
          {(data?.equivalenceRules ?? []).map((rule) => (
            <p key={rule.ruleId}>
              <ExternalLink href={rule.referenceExampleUrl}>官方规则示例</ExternalLink>
            </p>
          ))}
          {data === null && <p className="icpc-muted">规则说明随第一次成功读取一起返回。</p>}
        </details>
      </Panel>
      {openDetail !== null ? (
        <div className="icpc-merged-detail">
          <Panel
            title="题目详情与通过来源"
            tools={
              <button type="button" onClick={() => setDetail(null)}>
                收起成员详情
              </button>
            }
          >
            <p>
              {openDetail.group === null
                ? '该成员所属的合并组已不在当前筛选结果中；下面的详情仍按这道题自己的平台记录读取。'
                : `该合并组的通过状态：${mergedSolvedText(selectedAccounts.length, openDetail.group.solved)}` +
                  (openDetail.group.acceptedEvidence.length > 0
                    ? `（来自 ${openDetail.group.acceptedEvidence
                        .map((entry) => accountLabelOf(entry.accountId, boot.accounts, boot.sources))
                        .join('、')} 在等价题目上的真实通过提交）`
                    : '')}
            </p>
            <p className="icpc-muted">
              当前详情使用{' '}
              {openDetail.accountId === null
                ? '未选择本平台账号'
                : accountLabelOf(openDetail.accountId, boot.accounts, boot.sources)}{' '}
              读取，通过状态会显示为
              {nativeSolvedText(
                openDetail.group?.members.find(
                  (member) => member.problem.problemKey === openDetail.problemKey,
                )?.problem.solvedByAccount ?? false,
                openDetail.accountId,
              )}
              。本平台的判定、原始标签和标签历史始终只属于该平台，不会因为另一个平台的通过记录而显示。
            </p>
          </Panel>
          <WorkbenchContext.Provider value={{ ...workbench, accountId: openDetail.accountId }}>
            <ProblemView
              key={detailKeyOf(openDetail.problemKey, openDetail.accountId)}
              problemKey={openDetail.problemKey}
              onChange={read.refresh}
            />
          </WorkbenchContext.Provider>
        </div>
      ) : (
        <Notice>
          点击题目或“查看详情”会在本页展开该成员自己的题目详情；详情只使用该成员所属平台的账号，不会带入其他平台的账号。
          {MERGED_READONLY_NOTE}
        </Notice>
      )}
    </>
  );
}
