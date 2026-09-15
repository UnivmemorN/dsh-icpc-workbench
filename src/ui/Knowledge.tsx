import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiWeaknessResult } from '../application/workbench-api.js';
import {
  KNOWLEDGE_ATTRIBUTION_COPYRIGHT_URL,
  KNOWLEDGE_ATTRIBUTION_NOTES,
  KNOWLEDGE_ATTRIBUTION_SOURCES,
  KNOWLEDGE_RESOURCES_CHECKED_DATE,
  knowledgeResourcesFor,
} from '../domain/knowledge-resources.js';
import { Empty, ExternalLink, Notice, Panel, useWorkbench } from './common.js';
import { rawTagLabel, rawTagSourceOf } from './raw-tag-view.js';
import {
  LUOGU_TAG_DICTIONARY_RETRIEVED_AT,
  LUOGU_TAG_DICTIONARY_SOURCE_URL,
} from './luogu-tag-dictionary.js';
import { TAG_MAPPING_RELATIONS, type SourceTagMappingDiagnostic } from '../domain/index.js';
import { barWidthPercent } from './histogram.js';
import {
  KNOWLEDGE_AC_NOTE,
  KNOWLEDGE_CATALOG_DRIFT_NOTE,
  KNOWLEDGE_CATEGORY_SUMMARY_NOTE,
  KNOWLEDGE_NO_OBSERVATION_NOTE,
  KNOWLEDGE_OVERLAP_NOTE,
  KNOWLEDGE_PENDING_TAG_MAPPING_NOTE,
  KNOWLEDGE_SELF_REPORT_NOTE,
  KNOWLEDGE_SORTS,
  KNOWLEDGE_SORT_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  KNOWLEDGE_TAG_MAPPING_NOTE,
  KNOWLEDGE_TECHNIQUE_STATUSES,
  TAG_MAPPING_RELATION_LABELS,
  TAG_VOCABULARY_LABELS,
  changeKnowledgeFilter,
  changeTagMappingFilter,
  initialKnowledgeViewState,
  initialTagMappingViewState,
  knowledgeCategoryOptions,
  knowledgeCategorySummary,
  knowledgePage,
  knowledgeRatingText,
  knowledgeRelationLabel,
  knowledgeStatusCounts,
  knowledgeStatusHint,
  knowledgeTechniqueCoverage,
  knowledgeUnknownCatalogIds,
  moveKnowledgePage,
  moveTagMappingPage,
  openPendingTagMappings,
  pendingTagMappingSummary,
  reconcileKnowledgeCategory,
  reconcileTagMappingSource,
  selectKnowledgeTechniques,
  selectSourceTagMappings,
  sourceTagMappingCandidateText,
  sourceTagMappingKey,
  sourceTagMappingReferenceTitle,
  sourceTagMappingTargetText,
  tagMappingPage,
  tagMappingSourceOptions,
  type KnowledgeTechniqueRow,
  type KnowledgeViewState,
  type TagMappingViewState,
} from './knowledge-view.js';
import { knowledgeAtDifficulty, knowledgeDifficultyLabel } from './knowledge-difficulty-view.js';
import { jumpHint, pageNumbers, pagerDisplay, parseJumpPage } from './pager.js';

/** The knowledge report as the business API returns it; the UI invents no second model. */
export type KnowledgeViewData = ApiWeaknessResult['knowledge'];

/** Coverage of the same weakness read, reused for the missing-metadata part of the gap list. */
export type KnowledgeOuterCoverage = ApiWeaknessResult['coverage'];

/**
 * Knowledge view: what the imported evidence says per technique node.
 *
 * The view reuses the weakness read the page already made — filtering, sorting, paging and the
 * status distribution are local state over that one confirmed response, so opening or filtering
 * this view never starts an API or model call. It presents the domain's transparent status and
 * distinct-problem counters instead of a mastery percentage: an empty node is "unknown", an AC alone
 * confirms nothing, retrospectives are self-reports, evidence channels overlap and are never summed,
 * and a selected category is a catalog summary of its subtree, never mastery of the category.
 *
 * Every filter change resets to page 1, an account change resets the whole view, a shrinking result
 * clamps the page to the last one that exists, and a category a refreshed catalog dropped falls back
 * to all categories. A compact action beside the heading opens the one existing source-label table on
 * its unresolved rows (all difficulty bands) without a second table or an extra request, and an
 * account change closes that opened state again. Technique rows carry their verified OI Wiki links, a
 * selected category shows its own links beside its subtree summary, and the footer credits the
 * presentation and learning references without implying that any external page certifies the user's
 * knowledge.
 */
export function Knowledge({ knowledge, coverage }: { knowledge: KnowledgeViewData; coverage: KnowledgeOuterCoverage }) {
  const { boot, navigate } = useWorkbench();
  const [state, setState] = useState<KnowledgeViewState>(initialKnowledgeViewState);
  const [mappingState, setMappingState] = useState<TagMappingViewState>(initialTagMappingViewState);
  const [jump, setJump] = useState('');
  const results = useRef<HTMLDivElement | null>(null);
  const mappingDetails = useRef<HTMLDetailsElement | null>(null);

  // A new account shows its own default view state instead of the previous account's filters; the
  // source-label filters, their page and the opened pending-mapping state belong to the account too.
  useEffect(() => {
    setState(initialKnowledgeViewState());
    setMappingState(initialTagMappingViewState());
    setJump('');
    if (mappingDetails.current !== null) {
      mappingDetails.current.open = false;
    }
  }, [knowledge.accountId]);

  const catalog = boot.taxonomy.nodes;

  // A refreshed catalog can drop the selected category (or turn it into a technique); fall back to
  // “all categories” on page 1. The helper returns the identical state while the selection is still
  // offered, so this effect settles instead of re-rendering in a loop.
  useEffect(() => {
    setState((previous) => reconcileKnowledgeCategory(previous, catalog));
  }, [catalog]);

  useEffect(() => {
    setState(previous => previous.difficultyId !== null &&
      !knowledge.difficultyBands.some(entry => entry.band.id === previous.difficultyId)
      ? changeKnowledgeFilter(previous, { difficultyId: null }) : previous);
  }, [knowledge.difficultyBands]);
  const scoped = knowledgeAtDifficulty(knowledge, state.difficultyId);
  const rows = selectKnowledgeTechniques(scoped.nodes, catalog, state);
  const page = knowledgePage(rows, state.page);
  const pagerState = pagerDisplay(
    page.totalPages === 0
      ? { page: 1, totalItems: 0, totalPages: 0 }
      : { page: page.page, totalItems: page.totalItems, totalPages: page.totalPages },
    state.page,
  );

  // A refresh (or a filter that removed the current page) may shrink the result set; mirror the
  // clamped page back into state so the next request starts from the page actually served.
  useEffect(() => {
    if (page.totalPages > 0 && state.page > page.totalPages) {
      setState((previous) => moveKnowledgePage(previous, page.totalPages, page.totalPages));
    }
  }, [page.totalPages, state.page]);

  // Source-label diagnostics use the same local-filter rules as the technique table: filtering and
  // paging are pure helpers over the one confirmed report, and a shrinking result clamps the page.
  const mappingRows = selectSourceTagMappings(knowledge.sourceTagMappings, mappingState);
  const mappingPage = tagMappingPage(mappingRows, mappingState.page);
  const mappingSources = tagMappingSourceOptions(knowledge.sourceTagMappings);
  // Pending labels are counted over the report's total mapping list (all difficulty bands), never
  // over a scoped band and never by summing the per-label problem counters.
  const pendingMappings = pendingTagMappingSummary(knowledge.sourceTagMappings);
  // Readable display form of one mapping row. A name resolves only through that row's own source
  // instance, looked up in the boot catalog: an absent/unknown instance or a non-Luogu host keeps the
  // exact stored raw text, and the mapping result, filters and evidence never change.
  const mappingRawView = (mapping: SourceTagMappingDiagnostic) =>
    rawTagLabel(mapping.raw, rawTagSourceOf(mapping.sourceInstanceId, boot.sources));
  const mappingShowsLuoguIds = mappingPage.items.some((mapping) => mappingRawView(mapping).luoguTagId !== null);
  const relationCountOf = (relation: (typeof TAG_MAPPING_RELATIONS)[number]): number =>
    knowledge.sourceTagMappings.filter((mapping) => mapping.relation === relation).length;
  useEffect(() => {
    if (mappingPage.totalPages > 0 && mappingState.page > mappingPage.totalPages) {
      setMappingState((previous) => moveTagMappingPage(previous, mappingPage.totalPages, mappingPage.totalPages));
    }
  }, [mappingPage.totalPages, mappingState.page]);

  // A refreshed report can also drop the selected source instance; fall back to all sources on
  // page 1, exactly like the category selector. The helper returns the identical state while the
  // selection is still offered, so this effect settles instead of re-rendering in a loop.
  useEffect(() => {
    setMappingState((previous) => reconcileTagMappingSource(previous, knowledge.sourceTagMappings));
  }, [knowledge.sourceTagMappings]);

  const counts = knowledgeStatusCounts(scoped.nodes);
  const peak = Math.max(1, ...counts.map((entry) => entry.count));
  const techniqueCoverage = knowledgeTechniqueCoverage(scoped.nodes, knowledge.minimumIndependentProblems);
  const categories = knowledgeCategoryOptions(catalog);
  const categorySummary =
    state.categoryId === null ? null : knowledgeCategorySummary(scoped.nodes, catalog, state.categoryId);
  // Resource metadata covers every catalog node, categories included, so the selected category can
  // show its own OI Wiki references beside its subtree summary.
  const categoryResources = categorySummary === null ? [] : knowledgeResourcesFor(categorySummary.taxonomyId);
  const unknownCatalogIds = knowledgeUnknownCatalogIds(knowledge.nodes, catalog);
  const catalogDrift = knowledge.taxonomyVersion !== boot.taxonomy.version || unknownCatalogIds.length > 0;
  const statusCountOf = (status: (typeof KNOWLEDGE_TECHNIQUE_STATUSES)[number]): number =>
    counts.find((entry) => entry.status === status)?.count ?? 0;

  function goTo(target: number, from: 'top' | 'bottom'): void {
    setState((previous) => moveKnowledgePage(previous, target, page.totalPages));
    if (from === 'bottom') {
      // Keep long filtered lists usable: the bottom pager returns the reader to the table instead
      // of forcing a scroll back to the top.
      results.current?.scrollIntoView({ block: 'start' });
      results.current?.focus();
    }
  }

  /**
   * Open the one existing source-label table on its unresolved rows.
   *
   * This only changes local view state and the DOM open state: it clears the conflicting source and
   * relation filters, returns to page 1, scrolls the very same `<details>` into view and never
   * issues an API read, a model call or a second table.
   */
  function showPendingMappings(): void {
    setMappingState((previous) => openPendingTagMappings(previous));
    const details = mappingDetails.current;
    if (details !== null) {
      details.open = true;
      details.scrollIntoView({ block: 'start' });
      details.focus();
    }
  }

  function submitJump(event: FormEvent<HTMLFormElement>, from: 'top' | 'bottom'): void {
    event.preventDefault();
    const target = parseJumpPage(jump);
    if (target === null) {
      // Blank or malformed text is a no-op; the value stays beside its inline hint.
      return;
    }
    goTo(target, from);
    setJump('');
  }

  /** One pager; top and bottom share it but carry distinct accessible labels. */
  function pager(where: 'top' | 'bottom') {
    const label = where === 'top' ? '知识点分页（顶部）' : '知识点分页（底部）';
    const locked = !pagerState.navigable;
    const counter = pagerState.hasData
      ? `筛选后 ${pagerState.totalItems} 个知识点 · 第 ${pagerState.currentPage} / ${pagerState.totalPages} 页`
      : '暂无结果';
    const jumpId = `icpc-knowledge-jump-${where}`;
    const hintId = `icpc-knowledge-jump-hint-${where}`;
    const warning = jumpHint(jump);
    return (
      <nav className="icpc-pager" aria-label={label}>
        <button type="button" disabled={locked || pagerState.currentPage <= 1} onClick={() => goTo(1, where)}>
          « 首页
        </button>
        <button
          type="button"
          disabled={locked || pagerState.currentPage <= 1}
          onClick={() => goTo(pagerState.currentPage - 1, where)}
        >
          ‹ 上一页
        </button>
        {pageNumbers(pagerState.currentPage, pagerState.totalPages).map((entry, index) =>
          entry === null ? (
            <span key={`gap-${index}`} className="icpc-pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              className={entry === pagerState.currentPage ? 'icpc-page-current' : undefined}
              aria-current={entry === pagerState.currentPage ? 'page' : undefined}
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
          disabled={locked || pagerState.currentPage >= pagerState.totalPages}
          onClick={() => goTo(pagerState.currentPage + 1, where)}
        >
          下一页 ›
        </button>
        <button
          type="button"
          disabled={locked || pagerState.currentPage >= pagerState.totalPages}
          onClick={() => goTo(pagerState.totalPages, where)}
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
    <Panel title="按知识点汇总学习证据">
      <div className="icpc-toolbar">
        <label>
          难度范围
          <select value={state.difficultyId ?? ''} onChange={event =>
            setState(previous => changeKnowledgeFilter(previous, { difficultyId: event.target.value || null }))
          }>
            <option value="">全部难度（汇总）</option>
            {knowledge.difficultyBands.map(entry => (
              <option key={entry.band.id} value={entry.band.id}>
                {knowledgeDifficultyLabel(entry.band)} · 通过 {entry.coverage.solvedDistinctTotal} / 尝试 {entry.coverage.attemptedDistinctTotal}
              </option>
            ))}
          </select>
        </label>
        <span role="status">
          当前范围：{scoped.label} · 通过 {scoped.coverage.solvedDistinctTotal} / 尝试 {scoped.coverage.attemptedDistinctTotal} 题
        </span>
      </div>
      <p className="icpc-muted">
        选择难度后，下方状态分布、分类汇总与知识点计数只统计该档。CF 按 200 分一档；洛谷按原生等级；其他来源保留原生数值。
        未知难度单列。不同来源与难度维度不换算，多维度计数不能相加。每档独立判断是否达到证据阈值，低难度记录不能证明高难度能力。
      </p>
      {pendingMappings.pending > 0 && (
        <p className="icpc-muted">
          待核对来源标签（全部难度）：<strong>{pendingMappings.pending}</strong> 个，来自{' '}
          {pendingMappings.sources} 个来源实例。{KNOWLEDGE_PENDING_TAG_MAPPING_NOTE}{' '}
          <button type="button" onClick={showPendingMappings}>
            查看待核对标签
          </button>
        </p>
      )}
      <div className="icpc-knowledge-summary">
        <div>
          <span>知识点总数</span>
          <strong>{techniqueCoverage.techniques}</strong>
          <small className="icpc-muted">当前词表中的算法与技巧，不含分类目录。</small>
        </div>
        <div>
          <span>已有独立完成题目的知识点</span>
          <strong>
            {techniqueCoverage.withIndependentEvidence} / {techniqueCoverage.techniques}
          </strong>
          <small className="icpc-muted">至少 1 道独立完成题目，是计数覆盖，不是“掌握率”。</small>
        </div>
        <div>
          <span>独立证据阈值</span>
          <strong>≥ {techniqueCoverage.minimumIndependentProblems} 题</strong>
          <small className="icpc-muted">在当前范围达到阈值才标记“已有独立证据”；汇总状态不代表所有难度。</small>
        </div>
      </div>

      <div className="icpc-knowledge-dist" role="group" aria-label="知识点状态分布（点击筛选）">
        {counts.map((entry) => (
          <button
            key={entry.status}
            type="button"
            aria-pressed={state.status === entry.status}
            title={knowledgeStatusHint(entry.status, knowledge.minimumIndependentProblems)}
            onClick={() =>
              setState((previous) =>
                changeKnowledgeFilter(previous, { status: previous.status === entry.status ? 'all' : entry.status }),
              )
            }
          >
            <span className="icpc-knowledge-dist-label">{entry.label}</span>
            <strong>{entry.count}</strong>
            <span className="icpc-knowledge-meter" aria-hidden="true">
              <span style={{ width: barWidthPercent(entry.count, peak) + '%' }} />
            </span>
          </button>
        ))}
      </div>
      <p className="icpc-muted">
        {KNOWLEDGE_NO_OBSERVATION_NOTE} {KNOWLEDGE_AC_NOTE}
      </p>

      {catalogDrift && (
        <Notice>
          {KNOWLEDGE_CATALOG_DRIFT_NOTE} 报告目录版本 {knowledge.taxonomyVersion}，当前目录版本{' '}
          {boot.taxonomy.version}
          {unknownCatalogIds.length > 0
            ? `；报告中有 ${unknownCatalogIds.length} 个知识点不在当前目录：${unknownCatalogIds.slice(0, 8).join('、')}${
                unknownCatalogIds.length > 8 ? ' 等' : ''
              }`
            : ''}
          。
        </Notice>
      )}

      <div className="icpc-toolbar">
        <label>
          搜索知识点
          <input
            value={state.query}
            placeholder="中文 / English / 别名 / id"
            onChange={(event) =>
              setState((previous) => changeKnowledgeFilter(previous, { query: event.target.value }))
            }
          />
        </label>
        <label>
          分类
          <select
            value={state.categoryId ?? ''}
            onChange={(event) =>
              setState((previous) =>
                changeKnowledgeFilter(previous, { categoryId: event.target.value === '' ? null : event.target.value }),
              )
            }
          >
            <option value="">全部分类</option>
            {categories.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}（{option.techniqueCount} 个知识点）
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select
            value={state.status}
            onChange={(event) =>
              setState((previous) =>
                changeKnowledgeFilter(previous, {
                  status: event.target.value as KnowledgeViewState['status'],
                }),
              )
            }
          >
            <option value="all">全部状态</option>
            {KNOWLEDGE_TECHNIQUE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {KNOWLEDGE_STATUS_LABELS[status]}（{statusCountOf(status)}）
              </option>
            ))}
          </select>
        </label>
        <label>
          排序
          <select
            value={state.sort}
            onChange={(event) =>
              setState((previous) =>
                changeKnowledgeFilter(previous, { sort: event.target.value as KnowledgeViewState['sort'] }),
              )
            }
          >
            {KNOWLEDGE_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {KNOWLEDGE_SORT_LABELS[sort]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            setState(initialKnowledgeViewState());
            setJump('');
          }}
        >
          重置筛选
        </button>
      </div>

      {categorySummary !== null && (
        <Notice>
          分类“{categorySummary.nameZh}”：该分类相关题目 <strong>{categorySummary.relatedProblems}</strong> 道；有独立证据的知识点{' '}
          <strong>
            {categorySummary.descendantsWithIndependentEvidence} / {categorySummary.descendantTechniques}
          </strong>{' '}
          个。{KNOWLEDGE_CATEGORY_SUMMARY_NOTE}（分类计数按去重题集合并，不累加子项。）
          {categoryResources.length > 0 && (
            <span>
              {' '}
              分类学习资料：
              {categoryResources.map((resource) => (
                <span key={resource.url}>
                  <ExternalLink href={resource.url}>
                    {resource.provider} · {resource.title}
                  </ExternalLink>
                  <span className="icpc-muted">（{knowledgeRelationLabel(resource.relation)}）</span>
                </span>
              ))}
            </span>
          )}
        </Notice>
      )}

      {pager('top')}
      {page.totalItems === 0 ? (
        <Empty>
          当前筛选下没有知识点。可以清空搜索、分类或状态条件；分类目录与零记录知识点都在目录内，仍然可以被搜索到。
        </Empty>
      ) : (
        <>
          <div
            className="icpc-table-wrap icpc-knowledge-table"
            ref={results}
            tabIndex={-1}
            aria-label="知识点结果"
          >
            <table>
              <thead>
                <tr>
                  <th>知识点</th>
                  <th>状态</th>
                  <th>相关题目结果</th>
                  <th>实际解法（复盘）</th>
                  <th>难度分层</th>
                  <th>详情 / 学习链接</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((row) => (
                  <KnowledgeRow
                    key={row.taxonomyId}
                    row={row}
                    difficultyBands={knowledge.difficultyBands}
                    difficultyId={state.difficultyId}
                    onDifficulty={id => setState(previous => changeKnowledgeFilter(previous, { difficultyId: id }))}
                    minimumIndependentProblems={knowledge.minimumIndependentProblems}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="icpc-muted">
            {KNOWLEDGE_OVERLAP_NOTE} {KNOWLEDGE_SELF_REPORT_NOTE} 每题只取最新一次复盘。
          </p>
        </>
      )}
      {pager('bottom')}

      <details className="icpc-coverage">
        <summary>
          证据覆盖与未匹配标签（全部难度）：未匹配原始标签 {knowledge.unmatchedAlgorithmLabels.length} 个 · 缺少题目元数据{' '}
          {coverage.metadataMissing} / {coverage.distinctProblems} 题
        </summary>
        <div className="icpc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>口径</th>
                <th>题目数（同一题只算一次）</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>已尝试</td>
                <td>{knowledge.coverage.attemptedDistinctTotal}</td>
              </tr>
              <tr>
                <td>已通过</td>
                <td>{knowledge.coverage.solvedDistinctTotal}</td>
              </tr>
              <tr>
                <td>有已知分类标签的相关题</td>
                <td>{knowledge.coverage.relatedAttemptedDistinct}</td>
              </tr>
              <tr>
                <td>有有效复核标签的题</td>
                <td>{knowledge.coverage.verifiedAttemptedDistinct}</td>
              </tr>
              <tr>
                <td>有复盘的已通过题</td>
                <td>{knowledge.coverage.retrospectiveProblemDistinct}</td>
              </tr>
              <tr>
                <td>带未匹配原始标签的题</td>
                <td>{knowledge.coverage.unmatchedAlgorithmProblemDistinct}</td>
              </tr>
              <tr>
                <td>缺少本地题目元数据</td>
                <td>
                  {coverage.metadataMissing} / {coverage.distinctProblems}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>未匹配的原始标签不会被强行归入某个知识点：</p>
        {knowledge.unmatchedAlgorithmLabels.length === 0 ? (
          <p className="icpc-muted">当前没有未匹配的原始算法标签。</p>
        ) : (
          <div className="icpc-tags">
            {knowledge.unmatchedAlgorithmLabels.map((label) => (
              <span key={label} className="icpc-tag">
                {label}
              </span>
            ))}
          </div>
        )}
        <p className="icpc-muted">
          缺少的本地题目元数据仍计入分母，但带不上标签或难度，可以在 账号与同步 &gt; 导入与同步 &gt; 题目目录 补齐。
        </p>
      </details>

      <details className="icpc-tag-mapping" ref={mappingDetails} tabIndex={-1}>
        <summary>
          来源标签对照（试行）：{knowledge.sourceTagMappings.length} 条映射 · 对照版本{' '}
          {knowledge.tagMappingVersion}
        </summary>
        <p className="icpc-muted">{KNOWLEDGE_TAG_MAPPING_NOTE}</p>
        <div className="icpc-toolbar">
          <label>
            来源实例
            <select
              value={mappingState.sourceInstanceId ?? ''}
              onChange={(event) =>
                setMappingState((previous) =>
                  changeTagMappingFilter(previous, {
                    sourceInstanceId: event.target.value === '' ? null : event.target.value,
                  }),
                )
              }
            >
              <option value="">全部来源</option>
              {mappingSources.map((option) => (
                <option key={option.sourceInstanceId} value={option.sourceInstanceId}>
                  {option.label}（{option.count} 条）
                </option>
              ))}
            </select>
          </label>
          <label>
            对照结果
            <select
              value={mappingState.relation}
              onChange={(event) =>
                setMappingState((previous) =>
                  changeTagMappingFilter(previous, {
                    relation: event.target.value as TagMappingViewState['relation'],
                  }),
                )
              }
            >
              <option value="all">全部结果</option>
              {TAG_MAPPING_RELATIONS.map((relation) => (
                <option key={relation} value={relation}>
                  {TAG_MAPPING_RELATION_LABELS[relation]}（{relationCountOf(relation)}）
                </option>
              ))}
            </select>
          </label>
          <label className="icpc-check">
            <input
              type="checkbox"
              checked={mappingState.issuesOnly}
              onChange={(event) =>
                setMappingState((previous) =>
                  changeTagMappingFilter(previous, { issuesOnly: event.target.checked }),
                )
              }
            />
            只看待核对
          </label>
          <button type="button" onClick={() => setMappingState(initialTagMappingViewState())}>
            重置对照筛选
          </button>
        </div>
        {mappingPage.totalItems === 0 ? (
          <Empty>
            当前筛选下没有来源标签映射。可以清空来源或对照结果条件；未匹配的原始标签仍然保留在题目记录里。
          </Empty>
        ) : (
          <>
            <div className="icpc-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>来源</th>
                    <th>原始标签</th>
                    <th>对照结果</th>
                    <th>对应知识点</th>
                    <th>题目数</th>
                    <th>说明 / 参考</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingPage.items.map((mapping) => {
                    const raw = mappingRawView(mapping);
                    return (
                      <tr key={sourceTagMappingKey(mapping)}>
                        <td>
                          <span className="icpc-knowledge-name">{TAG_VOCABULARY_LABELS[mapping.vocabulary]}</span>
                          <span className="icpc-muted">{mapping.sourceInstanceId}</span>
                        </td>
                        <td>
                          <span>{raw.label}</span>
                          {raw.label !== mapping.raw && <small className="icpc-muted" style={{display:'block'}}>{mapping.raw}</small>}
                        </td>
                        <td>{TAG_MAPPING_RELATION_LABELS[mapping.relation]}</td>
                        <td>
                          <span>{sourceTagMappingTargetText(mapping, catalog)}</span>
                          {sourceTagMappingCandidateText(mapping, catalog) !== '' && (
                            <span className="icpc-muted">{sourceTagMappingCandidateText(mapping, catalog)}</span>
                          )}
                        </td>
                        <td>
                          <span>
                            通过 {mapping.solvedDistinct} / 尝试 {mapping.attemptedDistinct}
                          </span>
                        </td>
                        <td>
                          <span>{mapping.explanation}</span>
                          {mapping.referenceUrls.length > 0 && (
                            <span className="icpc-tag-mapping-refs">
                              {mapping.referenceUrls.map((url) => (
                                <ExternalLink key={url} href={url}>
                                  {sourceTagMappingReferenceTitle(url)}
                                </ExternalLink>
                              ))}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {mappingPage.totalPages > 1 && (
              <nav className="icpc-pager" aria-label="来源标签对照分页">
                <button
                  type="button"
                  disabled={mappingPage.page <= 1}
                  onClick={() =>
                    setMappingState((previous) =>
                      moveTagMappingPage(previous, mappingPage.page - 1, mappingPage.totalPages),
                    )
                  }
                >
                  ‹ 上一页
                </button>
                {pageNumbers(mappingPage.page, mappingPage.totalPages).map((entry, index) =>
                  entry === null ? (
                    <span key={`mapping-gap-${index}`} className="icpc-pager-gap" aria-hidden="true">
                      …
                    </span>
                  ) : (
                    <button
                      key={entry}
                      type="button"
                      className={entry === mappingPage.page ? 'icpc-page-current' : undefined}
                      aria-current={entry === mappingPage.page ? 'page' : undefined}
                      onClick={() =>
                        setMappingState((previous) => moveTagMappingPage(previous, entry, mappingPage.totalPages))
                      }
                    >
                      {entry}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  disabled={mappingPage.page >= mappingPage.totalPages}
                  onClick={() =>
                    setMappingState((previous) =>
                      moveTagMappingPage(previous, mappingPage.page + 1, mappingPage.totalPages),
                    )
                  }
                >
                  下一页 ›
                </button>
              </nav>
            )}
            {mappingShowsLuoguIds && (
              <p className="icpc-muted">
                洛谷数字编号的显示名来自官方标签字典快照（
                <ExternalLink href={LUOGU_TAG_DICTIONARY_SOURCE_URL}>官方标签数据</ExternalLink>
                ，核对日期 {LUOGU_TAG_DICTIONARY_RETRIEVED_AT}）；官方编号先解析为平台名称，再按保守规则对照知识点；未匹配或有歧义时仍待核对，不构成掌握证明。
              </p>
            )}
            <p className="icpc-muted" aria-live="polite">
              筛选后 {mappingPage.totalItems} 条映射 · 第 {mappingPage.page} / {mappingPage.totalPages}{' '}
              页；同一标签来自不同来源时分别列出，不按显示名合并。该表是全部难度的汇总，同一道题可以带多个标签，
              各行“通过 / 尝试”只统计该标签自己的去重题数，不能相加当作题目总数。
            </p>
          </>
        )}
      </details>

      <Notice>
        想让某个知识点的证据更完整：去 <strong>题库</strong> 并选择 <strong>已通过</strong> 筛选，打开题目填写 <strong>复盘</strong>，记录实际用到的解法与
        <strong>完成方式</strong>（独立完成 / 提示辅助 / 参考题解）。只有复盘中的“独立完成”会累计独立证据。
      </Notice>
      <div className="icpc-actions">
        <button onClick={() => navigate('bank')}>去题库记录复盘</button>
      </div>

      <footer className="icpc-knowledge-sources">
        <p>
          知识点分类、筛选与练习呈现方式参考{' '}
          <ExternalLink href={KNOWLEDGE_ATTRIBUTION_SOURCES.nowcoder.url}>
            {KNOWLEDGE_ATTRIBUTION_SOURCES.nowcoder.provider}
          </ExternalLink>
          ；知识点学习资料参考{' '}
          <ExternalLink href={KNOWLEDGE_ATTRIBUTION_SOURCES.oiWiki.url}>
            {KNOWLEDGE_ATTRIBUTION_SOURCES.oiWiki.provider}
          </ExternalLink>
          （<ExternalLink href={KNOWLEDGE_ATTRIBUTION_COPYRIGHT_URL}>版权声明</ExternalLink>）。资料链接核对日期：
          {KNOWLEDGE_RESOURCES_CHECKED_DATE}。
        </p>
        {KNOWLEDGE_ATTRIBUTION_NOTES.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </footer>
    </Panel>
  );
}

/** One technique row; the expanded detail carries the honest reading and the verified links. */
function KnowledgeRow({
  row,
  difficultyBands, difficultyId, onDifficulty,
  minimumIndependentProblems,
}: {
  row: KnowledgeTechniqueRow;
  difficultyBands: KnowledgeViewData['difficultyBands'];
  difficultyId: string | null;
  onDifficulty: (id: string) => void;
  minimumIndependentProblems: number;
}) {
  const evidence = row.evidence;
  const resources = knowledgeResourcesFor(row.taxonomyId);
  const bands = difficultyBands.flatMap(entry => {
    const node = entry.nodes.find(n => n.taxonomyId === row.taxonomyId);
    return node ? [{ band: entry.band, node }] : [];
  });
  return (
    <tr>
      <td>
        <span className="icpc-knowledge-name">{row.nameZh}</span>
        <span className="icpc-muted">{row.nameEn}</span>
        <span className="icpc-muted">
          {row.categoryPath}
        </span>
      </td>
      <td>
        <span
          className={
            evidence.status === 'not_observed'
              ? 'icpc-knowledge-status icpc-knowledge-status-none'
              : 'icpc-knowledge-status'
          }
        >
          {KNOWLEDGE_STATUS_LABELS[evidence.status]}
        </span>
      </td>
      <td>
        <span>
          平台原始（未复核）：通过 {evidence.platformSolvedDistinct} / 尝试 {evidence.platformAttemptedDistinct}
        </span>
        <span>
          已复核标签：通过 {evidence.verifiedSolvedDistinct} / 尝试 {evidence.verifiedAttemptedDistinct}
        </span>
        <span className="icpc-muted">相关去重题目 {evidence.observedRelatedDistinct}</span>
      </td>
      <td>
        <span>
          独立 {evidence.retrospectiveIndependentDistinct} · 提示辅助 {evidence.retrospectiveAssistedDistinct} · 参考题解{' '}
          {evidence.retrospectiveSolutionUsedDistinct}
        </span>

      </td>
      <td>
        {bands.length === 0 ? <span className="icpc-muted">各难度暂无记录</span> : (
          <details className="icpc-knowledge-detail">
            <summary>各难度证据（{bands.length} 档）</summary>
            <small className="icpc-muted">全难度对照；点击档位可筛选整页。</small>
            {bands.map(({ band, node }) => (
              <div key={band.id} className="icpc-knowledge-band">
                <button type="button" aria-pressed={difficultyId === band.id} onClick={() => onDifficulty(band.id)}>
                  {knowledgeDifficultyLabel(band)}
                </button>
                <span>{KNOWLEDGE_STATUS_LABELS[node.status]} · 独立 {node.retrospectiveIndependentDistinct}</span>
                <span>提示辅助 {node.retrospectiveAssistedDistinct} · 参考题解 {node.retrospectiveSolutionUsedDistinct}</span>
                <small className="icpc-muted">
                  平台通过 {node.platformSolvedDistinct} / 尝试 {node.platformAttemptedDistinct}；
                  复核通过 {node.verifiedSolvedDistinct} / 尝试 {node.verifiedAttemptedDistinct}
                </small>
              </div>
            ))}
          </details>
        )}
      </td>
      <td>
        <details className="icpc-knowledge-detail">
          <summary>详情与学习链接</summary>
          <p>{knowledgeRatingText(evidence.independentRatingRanges, evidence.retrospectiveIndependentDistinct)}</p>
          <p className="icpc-muted">{knowledgeStatusHint(evidence.status, minimumIndependentProblems)}</p>
          {resources.length === 0 ? (
            <p className="icpc-muted">当前目录还没有为该知识点登记学习资料。</p>
          ) : (
            <ul className="icpc-knowledge-links">
              {resources.map((resource) => (
                <li key={resource.url}>
                  <ExternalLink href={resource.url}>
                    {resource.provider} · {resource.title}
                  </ExternalLink>{' '}
                  <span className="icpc-muted">（{knowledgeRelationLabel(resource.relation)}）</span>
                </li>
              ))}
            </ul>
          )}
          <p className="icpc-muted">外部资料只是普通学习链接，不参与状态判定，也不证明掌握。</p>
        </details>
      </td>
    </tr>
  );
}
