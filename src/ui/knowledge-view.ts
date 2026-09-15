/**
 * Pure reading rules of the knowledge view (Sprint 09b).
 *
 * `Knowledge.tsx` owns React state and markup only; every externally meaningful decision lives here
 * so it can be checked without a DOM: which technique rows a filter set selects, how search and the
 * nested-category match work, how the deterministic order is derived, how one page is sliced and
 * clamped, and how a status, rating range or resource relation is phrased. Nothing in this module
 * reads a store, a clock, a model or the network, so the same report and catalog always render the
 * same rows.
 *
 * The vocabulary is deliberately the domain's: a status is a transparent heuristic over distinct
 * problems, and every helper says "count"/"evidence" rather than "mastery". No helper here produces
 * a percentage, a score or a sum of overlapping evidence channels.
 */
import type {
  KnowledgeNodeEvidence,
  KnowledgeNodeStatus,
  KnowledgeRatingRange,
  SourceTagMappingDiagnostic,
  TagMappingRelation,
  TagVocabulary,
  TaxonomyNode,
} from '../domain/index.js';
import type { KnowledgeResourceRelation } from '../domain/knowledge-resources.js';

/** Technique rows per page; the view contract fixes the page size at 25. */
export const KNOWLEDGE_PAGE_SIZE = 25;

/** Technique statuses in the order the distribution summary renders them. */
export const KNOWLEDGE_TECHNIQUE_STATUSES = [
  'not_observed',
  'unconfirmed',
  'needs_practice',
  'practicing',
  'independent_evidence',
] as const satisfies readonly KnowledgeNodeStatus[];

/** A technique status; `category_summary` belongs to category rows and never to a technique row. */
export type KnowledgeTechniqueStatus = (typeof KNOWLEDGE_TECHNIQUE_STATUSES)[number];

/** Chinese labels of every status, exactly as the view contract names them. */
export const KNOWLEDGE_STATUS_LABELS = {
  not_observed: '暂无记录',
  unconfirmed: '待确认解法',
  needs_practice: '需要独立练习',
  practicing: '独立练习中',
  independent_evidence: '已有独立证据',
  category_summary: '目录汇总',
} as const satisfies Readonly<Record<KnowledgeNodeStatus, string>>;

/** One status filter value; `all` keeps every technique status. */
export type KnowledgeStatusFilter = KnowledgeTechniqueStatus | 'all';

/** Sorting choices of the technique table, in selector order. */
export const KNOWLEDGE_SORTS = ['catalog', 'independent-asc', 'independent-desc', 'related-desc'] as const;

export type KnowledgeSort = (typeof KNOWLEDGE_SORTS)[number];

/** Chinese labels of the sorting choices. */
export const KNOWLEDGE_SORT_LABELS = {
  catalog: '目录顺序',
  'independent-asc': '独立完成题数升序',
  'independent-desc': '独立完成题数降序',
  'related-desc': '相关题目数降序',
} as const satisfies Readonly<Record<KnowledgeSort, string>>;

/** Honest copy that must travel with the knowledge table. */
export const KNOWLEDGE_NO_OBSERVATION_NOTE = '没有相关记录表示“未知”，不等于 0% 掌握。';
export const KNOWLEDGE_AC_NOTE = '通过一道题只说明它被接受了，不会自动确认用到了哪些知识点。';
export const KNOWLEDGE_SELF_REPORT_NOTE = '复盘是你自己填写的记录，属于自述；平台数据与外部资料都不为它背书。';
export const KNOWLEDGE_OVERLAP_NOTE =
  '同一道题可以同时出现在多个证据渠道和多个知识点下，各计数会重叠，不能相加当作总数。';
export const KNOWLEDGE_CATEGORY_SUMMARY_NOTE = '目录汇总，不代表掌握整个分类。';
export const KNOWLEDGE_CATALOG_DRIFT_NOTE =
  '统计报告基于的目录版本与当前目录不一致：未出现在当前目录中的知识点不会显示，请刷新统计。';

/** One status of the summary distribution with its technique-node count. */
export interface KnowledgeStatusCount {
  readonly status: KnowledgeTechniqueStatus;
  readonly label: string;
  readonly count: number;
}

/**
 * Technique nodes per status, in {@link KNOWLEDGE_TECHNIQUE_STATUSES} order (zero counts included).
 *
 * Category rows are excluded and their `category_summary` status never appears: the distribution
 * describes methods, not folders, and its counts are counts of techniques — never a mastery rate.
 */
export function knowledgeStatusCounts(nodes: readonly KnowledgeNodeEvidence[]): readonly KnowledgeStatusCount[] {
  const counts = new Map<KnowledgeTechniqueStatus, number>();
  for (const node of nodes) {
    if (node.kind !== 'technique' || node.status === 'category_summary') {
      continue;
    }
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  return KNOWLEDGE_TECHNIQUE_STATUSES.map((status) => ({
    status,
    label: KNOWLEDGE_STATUS_LABELS[status],
    count: counts.get(status) ?? 0,
  }));
}

/** Technique count with at least one independent problem, against all technique nodes. */
export interface KnowledgeTechniqueCoverage {
  readonly techniques: number;
  /** Techniques whose latest retrospectives include at least one independent problem. */
  readonly withIndependentEvidence: number;
  /** Threshold the domain used for `independent_evidence`, echoed for the copy. */
  readonly minimumIndependentProblems: number;
}

/**
 * Count coverage of independent evidence over technique nodes.
 *
 * `withIndependentEvidence` counts techniques with **at least one** independent problem (the same
 * rule the domain uses for a category's descendant counter), not the stricter
 * `independent_evidence` status. It is a count, never a percentage and never "掌握率".
 */
export function knowledgeTechniqueCoverage(
  nodes: readonly KnowledgeNodeEvidence[],
  minimumIndependentProblems: number,
): KnowledgeTechniqueCoverage {
  let techniques = 0;
  let withIndependentEvidence = 0;
  for (const node of nodes) {
    if (node.kind !== 'technique') {
      continue;
    }
    techniques += 1;
    if (node.retrospectiveIndependentDistinct > 0) {
      withIndependentEvidence += 1;
    }
  }
  return { techniques, withIndependentEvidence, minimumIndependentProblems };
}

/** One-line explanation of a status, using the report's own independence threshold. */
export function knowledgeStatusHint(status: KnowledgeNodeStatus, minimumIndependentProblems: number): string {
  switch (status) {
    case 'not_observed':
      return `${KNOWLEDGE_NO_OBSERVATION_NOTE} 当前还没有任何相关题目记录。`;
    case 'unconfirmed':
      return `有相关题目，但还没有复盘记录实际解法。${KNOWLEDGE_AC_NOTE}`;
    case 'needs_practice':
      return '已有复盘记录，但都使用了提示或参考题解，建议先独立重做并重新记录。';
    case 'practicing': {
      const upper = minimumIndependentProblems - 1;
      const range = upper <= 1 ? '1' : `1–${upper}`;
      return `已有 ${range} 道独立完成的题目，还没达到 ${minimumIndependentProblems} 道的独立证据阈值。`;
    }
    case 'independent_evidence':
      return `已有至少 ${minimumIndependentProblems} 道独立完成的题目，达到本项目的独立证据阈值；这是启发式标记，不是掌握证明。`;
    case 'category_summary':
      return KNOWLEDGE_CATEGORY_SUMMARY_NOTE;
  }
}

/** Searchable view of one catalog node: id plus every name and alias it publishes. */
export type KnowledgeSearchable = Pick<TaxonomyNode, 'id' | 'names' | 'aliases'>;

/** Case/width-insensitive search form; separators (`-`, `_`, `/`) collapse to a space. */
function normalizeKnowledgeSearch(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s_\u2010-\u2015/\\]+/gu, ' ')
    .trim();
}

/** All text one catalog node is searchable by: Chinese name, English name, aliases and id. */
export function knowledgeSearchText(node: KnowledgeSearchable): string {
  return normalizeKnowledgeSearch([node.id, node.names.zh, node.names.en, ...node.aliases].join(' '));
}

/** True when the query is empty or appears in the node's id, Chinese/English name or aliases. */
export function matchesKnowledgeQuery(node: KnowledgeSearchable, query: string): boolean {
  const needle = normalizeKnowledgeSearch(query);
  return needle.length === 0 || knowledgeSearchText(node).includes(needle);
}

/** Ids from one node up to its root (node first), following only explicit `parentId` links. */
function knowledgeLineageIds(byId: ReadonlyMap<string, TaxonomyNode>, startId: string): readonly string[] {
  const lineage: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = startId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    lineage.push(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return lineage;
}

/**
 * True when `taxonomyId` is `categoryId` itself or one of its descendants.
 *
 * Membership is walked over the catalog's explicit `parentId` links, never guessed from the dotted
 * id text: stable taxonomy identifiers may be reorganised (a node can move under another parent, or
 * keep an old id prefix after a rename), so only the supplied catalog decides a subtree. An unknown
 * id falls back to plain equality, and a parent cycle ends the walk instead of looping forever.
 */
export function knowledgeIdInCategory(
  catalog: readonly TaxonomyNode[],
  taxonomyId: string,
  categoryId: string,
): boolean {
  const byId = new Map(catalog.map((node) => [node.id, node]));
  return knowledgeLineageIds(byId, taxonomyId).includes(categoryId);
}

/** One selectable category of the catalog, in catalog order. */
export interface KnowledgeCategoryOption {
  readonly id: string;
  /** Depth-indented Chinese name; `— ` repeats once per nesting level. */
  readonly label: string;
  /** Nesting depth: 0 for a top-level category. */
  readonly depth: number;
  /** Catalog technique nodes in this subtree, whether or not they carry evidence. */
  readonly techniqueCount: number;
}

/**
 * Every category (nested ones included) as a selector option, in catalog order.
 *
 * Depth and subtree technique counts come from the same explicit `parentId` walk as
 * {@link knowledgeIdInCategory}, so a category whose dotted id disagrees with its real parent is
 * indented and counted by its real position. Each technique is walked up once, keeping the option
 * list linear in the catalog instead of re-walking every subtree per category.
 */
export function knowledgeCategoryOptions(catalog: readonly TaxonomyNode[]): readonly KnowledgeCategoryOption[] {
  const byId = new Map(catalog.map((node) => [node.id, node]));
  const techniquesByCategory = new Map<string, number>();
  for (const node of catalog) {
    if (node.kind !== 'technique') {
      continue;
    }
    for (const ancestorId of knowledgeLineageIds(byId, node.id)) {
      techniquesByCategory.set(ancestorId, (techniquesByCategory.get(ancestorId) ?? 0) + 1);
    }
  }
  const options: KnowledgeCategoryOption[] = [];
  for (const node of catalog) {
    if (node.kind !== 'category') {
      continue;
    }
    const depth = knowledgeLineageIds(byId, node.id).length - 1;
    options.push({
      id: node.id,
      label: '— '.repeat(depth) + node.names.zh,
      depth,
      techniqueCount: techniquesByCategory.get(node.id) ?? 0,
    });
  }
  return options;
}

/** One technique row: the domain evidence joined to its current catalog node. */
export interface KnowledgeTechniqueRow {
  readonly taxonomyId: string;
  readonly nameZh: string;
  readonly nameEn: string;
  /** Chinese category path root-first (`数学 › 数论`); empty when no category ancestor exists. */
  readonly categoryPath: string;
  /** Normalised searchable text of the catalog node (id, names, aliases). */
  readonly searchText: string;
  /** Catalog position, so every sort can break ties deterministically. */
  readonly catalogIndex: number;
  /** The domain evidence row, unmodified. */
  readonly evidence: KnowledgeNodeEvidence;
}

interface CatalogEntry {
  readonly node: TaxonomyNode;
  readonly index: number;
}

/** Chinese category path of one node, walking up its parent chain. */
function categoryPathOf(node: TaxonomyNode, byId: ReadonlyMap<string, CatalogEntry>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor = node.parentId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (entry === undefined) {
      break;
    }
    if (entry.node.kind === 'category') {
      names.unshift(entry.node.names.zh);
    }
    cursor = entry.node.parentId;
  }
  return names.join(' › ');
}

/**
 * Technique rows in catalog order.
 *
 * Only evidence rows of kind `technique` whose id still exists as a technique in the current
 * catalog become rows: an unknown or moved id is left out instead of being rendered with a
 * fabricated name (the view reports the drift separately through {@link knowledgeUnknownCatalogIds}).
 */
export function knowledgeTechniqueRows(
  nodes: readonly KnowledgeNodeEvidence[],
  catalog: readonly TaxonomyNode[],
): readonly KnowledgeTechniqueRow[] {
  const byId = new Map<string, CatalogEntry>();
  catalog.forEach((node, index) => byId.set(node.id, { node, index }));
  const rows: KnowledgeTechniqueRow[] = [];
  for (const evidence of nodes) {
    if (evidence.kind !== 'technique') {
      continue;
    }
    const entry = byId.get(evidence.taxonomyId);
    if (entry === undefined || entry.node.kind !== 'technique') {
      continue;
    }
    rows.push({
      taxonomyId: evidence.taxonomyId,
      nameZh: entry.node.names.zh,
      nameEn: entry.node.names.en,
      categoryPath: categoryPathOf(entry.node, byId),
      searchText: knowledgeSearchText(entry.node),
      catalogIndex: entry.index,
      evidence,
    });
  }
  rows.sort((left, right) => left.catalogIndex - right.catalogIndex);
  return rows;
}

/** The local filter set of the knowledge view; it never triggers an API request. */
export interface KnowledgeFilter {
  /** Native difficulty band id, or null for totals. */
  readonly difficultyId: string | null;
  readonly query: string;
  /** Selected category id, or `null` for every category. */
  readonly categoryId: string | null;
  readonly status: KnowledgeStatusFilter;
  readonly sort: KnowledgeSort;
}

/** Filter set plus the current page; one immutable value the component replaces on every action. */
export interface KnowledgeViewState extends KnowledgeFilter {
  readonly page: number;
}

/** Fresh view state: no filter, catalog order, first page. */
export function initialKnowledgeViewState(): KnowledgeViewState {
  return { query: '', categoryId: null, difficultyId: null, status: 'all', sort: 'catalog', page: 1 };
}

/** Apply a filter patch; **any** filter change returns to page 1 (a stale page is never kept). */
export function changeKnowledgeFilter(
  state: KnowledgeViewState,
  patch: Partial<KnowledgeFilter>,
): KnowledgeViewState {
  return { ...state, ...patch, page: 1 };
}

/**
 * Move to another page, clamped into `1..totalPages`.
 *
 * A confirmed empty result (`totalPages === 0`) keeps the stored page at 1; the pager itself
 * reports page 0 from {@link knowledgePage}, exactly like the numbered bank.
 */
export function moveKnowledgePage(
  state: KnowledgeViewState,
  target: number,
  totalPages: number,
): KnowledgeViewState {
  if (totalPages <= 0) {
    return { ...state, page: 1 };
  }
  const wanted = Number.isSafeInteger(target) && target >= 1 ? target : 1;
  return { ...state, page: Math.min(wanted, totalPages) };
}

/**
 * Repair a category selection that the supplied catalog no longer offers.
 *
 * The selector stores only a category id. After a catalog refresh that id can disappear, or it can
 * still exist as a technique; in both cases the filter would silently keep matching a subtree that
 * no longer exists, so the selection falls back to all categories and to page 1 (the stored page
 * belonged to the old, narrower result). A still-valid selection returns the same state object, so a
 * caller may run this on every catalog change inside an effect without causing a render loop.
 */
export function reconcileKnowledgeCategory(
  state: KnowledgeViewState,
  catalog: readonly TaxonomyNode[],
): KnowledgeViewState {
  if (state.categoryId === null) {
    return state;
  }
  const selected = catalog.find((node) => node.id === state.categoryId);
  if (selected !== undefined && selected.kind === 'category') {
    return state;
  }
  return { ...state, categoryId: null, page: 1 };
}

/** One served page of filtered rows. */
export interface KnowledgePage {
  readonly items: readonly KnowledgeTechniqueRow[];
  readonly totalItems: number;
  readonly totalPages: number;
  /** Served page; `0` for an empty filtered result, so no page is ever fabricated. */
  readonly page: number;
}

/** Slice the filtered rows into one clamped page of {@link KNOWLEDGE_PAGE_SIZE} rows. */
export function knowledgePage(
  rows: readonly KnowledgeTechniqueRow[],
  requestedPage: number,
): KnowledgePage {
  const totalItems = rows.length;
  const totalPages = Math.ceil(totalItems / KNOWLEDGE_PAGE_SIZE);
  if (totalPages === 0) {
    return { items: [], totalItems: 0, totalPages: 0, page: 0 };
  }
  const wanted = Number.isSafeInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
  const page = Math.min(wanted, totalPages);
  const start = (page - 1) * KNOWLEDGE_PAGE_SIZE;
  return { items: rows.slice(start, start + KNOWLEDGE_PAGE_SIZE), totalItems, totalPages, page };
}

/** Deterministic row order; equal keys always keep catalog order. */
function compareKnowledgeRows(
  left: KnowledgeTechniqueRow,
  right: KnowledgeTechniqueRow,
  sort: KnowledgeSort,
): number {
  const byCatalog = left.catalogIndex - right.catalogIndex;
  switch (sort) {
    case 'catalog':
      return byCatalog;
    case 'independent-asc':
      return left.evidence.retrospectiveIndependentDistinct - right.evidence.retrospectiveIndependentDistinct || byCatalog;
    case 'independent-desc':
      return right.evidence.retrospectiveIndependentDistinct - left.evidence.retrospectiveIndependentDistinct || byCatalog;
    case 'related-desc':
      return right.evidence.observedRelatedDistinct - left.evidence.observedRelatedDistinct || byCatalog;
  }
}

/**
 * Technique rows selected by one filter set, in the requested deterministic order.
 *
 * The input arrays are never mutated: rows are rebuilt and a copied array is sorted. Categories are
 * excluded by construction, so the table and its counters describe methods only.
 */
export function selectKnowledgeTechniques(
  nodes: readonly KnowledgeNodeEvidence[],
  catalog: readonly TaxonomyNode[],
  filter: KnowledgeFilter,
): readonly KnowledgeTechniqueRow[] {
  const needle = normalizeKnowledgeSearch(filter.query);
  const selected = knowledgeTechniqueRows(nodes, catalog).filter(
    (row) =>
      (filter.categoryId === null || knowledgeIdInCategory(catalog, row.taxonomyId, filter.categoryId)) &&
      (filter.status === 'all' || row.evidence.status === filter.status) &&
      (needle.length === 0 || row.searchText.includes(needle)),
  );
  return selected.sort((left, right) => compareKnowledgeRows(left, right, filter.sort));
}

/** Precomputed summary of one selected category; never a sum of child counters. */
export interface KnowledgeCategorySummary {
  readonly taxonomyId: string;
  readonly nameZh: string;
  /** Distinct related problems of the whole subtree (the category node's own union count). */
  readonly relatedProblems: number;
  /** Descendant technique nodes with at least one independent problem. */
  readonly descendantsWithIndependentEvidence: number;
  /** All descendant technique nodes of the subtree. */
  readonly descendantTechniques: number;
}

/**
 * Summary of one selected category, or `null` when the id is not a category of the catalog or has no
 * evidence row.
 *
 * `relatedProblems` is the category's own distinct-problem union: the domain already folds every
 * descendant problem into its ancestors and counts a shared problem once, so this helper neither
 * sums child rows nor double-counts a problem that carries several descendant techniques.
 */
export function knowledgeCategorySummary(
  nodes: readonly KnowledgeNodeEvidence[],
  catalog: readonly TaxonomyNode[],
  categoryId: string,
): KnowledgeCategorySummary | null {
  const catalogNode = catalog.find((node) => node.id === categoryId);
  if (catalogNode === undefined || catalogNode.kind !== 'category') {
    return null;
  }
  const evidence = nodes.find((node) => node.taxonomyId === categoryId);
  if (evidence === undefined) {
    return null;
  }
  return {
    taxonomyId: categoryId,
    nameZh: catalogNode.names.zh,
    relatedProblems: evidence.observedRelatedDistinct,
    descendantsWithIndependentEvidence: evidence.descendantTechniqueNodesWithIndependentEvidence,
    descendantTechniques: evidence.descendantTechniqueNodes,
  };
}

/** Evidence ids of the report that the current catalog no longer knows, in report order. */
export function knowledgeUnknownCatalogIds(
  nodes: readonly KnowledgeNodeEvidence[],
  catalog: readonly TaxonomyNode[],
): readonly string[] {
  const known = new Set(catalog.map((node) => node.id));
  return nodes.filter((node) => !known.has(node.taxonomyId)).map((node) => node.taxonomyId);
}

/**
 * Human text of the independent native-rating ranges of one technique.
 *
 * Every independent problem is accounted for: a dimension prints how many problems carry a value
 * and how many are missing, and a node with independent problems but no usable dimension says so
 * explicitly instead of showing an empty range.
 */
export function knowledgeRatingText(
  ranges: readonly KnowledgeRatingRange[],
  independentCount: number,
): string {
  if (independentCount <= 0) {
    return '还没有独立完成的题目，因此没有独立难度范围可展示。';
  }
  if (ranges.length === 0) {
    return `已有 ${independentCount} 道独立完成的题目，但都没有可用的平台原生难度数值，全部缺失。`;
  }
  const parts = ranges.map((range) => {
    if (range.count === 0 || range.min === null) {
      return `${range.dimension}：全部 ${range.missing} 题缺失数值`;
    }
    const span = range.min === range.max ? String(range.min) : `${range.min}–${range.max}`;
    return `${range.dimension} ${span}（${range.count} 题有数值，${range.missing} 题缺失）`;
  });
  return `独立完成 ${independentCount} 道题的平台原生难度：${parts.join('；')}。`;
}

/** Chinese label of a resource relation; `overview` is explicitly only a broad reference. */
export function knowledgeRelationLabel(relation: KnowledgeResourceRelation): string {
  return relation === 'overview' ? '参考概述' : '主题条目';
}

/** Mapping rows per page; the 来源标签对照 section stays a bounded table on large imports. */
export const TAG_MAPPING_PAGE_SIZE = 20;

/** Chinese labels of every relation the crosswalk can report. */
export const TAG_MAPPING_RELATION_LABELS = {
  exact: '精确对应',
  broader: '上级类别',
  narrower: '大类中的单项',
  ambiguous: '含义待核对',
  composite: '组合标签',
  unmapped: '未匹配',
  non_algorithm: '来源信息',
  reference: '仅作资料',
} as const satisfies Readonly<Record<TagMappingRelation, string>>;

/** Chinese labels of every tag vocabulary; the instance id is always shown beside it. */
export const TAG_VOCABULARY_LABELS = {
  codeforces: 'Codeforces',
  luogu: '洛谷',
  nowcoder: '牛客',
  'oi-wiki': 'OI Wiki',
  manual: '手动录入',
  unknown: '未识别来源',
} as const satisfies Readonly<Record<TagVocabulary, string>>;

/**
 * Honest caveat that must travel with the 来源标签对照 table: the crosswalk is provisional platform
 * evidence, never a record of the method actually used, and older combined nodes stay coarse.
 */
export const KNOWLEDGE_TAG_MAPPING_NOTE =
  '来源标签对照是试行规则：它只说明平台原始标签大致对应哪个知识点，不代表你实际用过该方法，也不构成掌握证明；较早的合并知识点仍然只概括一个粗粒度大类，不能据此认为其中每一项都已掌握。';

/**
 * Copy of the compact pending-mapping action (Sprint 32). It is deliberately explicit about three
 * things a reader could otherwise misread: the original labels and records are retained, the mapping
 * is still pending manual review, and the per-label problem counters are not verified mastery.
 */
export const KNOWLEDGE_PENDING_TAG_MAPPING_NOTE =
  '这些平台原始标签与对应题目记录都按原样保留，只是尚未确定可计入的知识点，对照仍待人工核对，标签上的题目计数是平台原始记录，不是已复核的掌握程度。';

/** Relations a reader should review by hand: nothing here is counted as an exact match. */
export const TAG_MAPPING_ISSUE_RELATIONS: readonly TagMappingRelation[] = [
  'ambiguous',
  'composite',
  'narrower',
  'unmapped',
];

/** True when a mapping stayed unresolved and therefore deserves manual review. */
export function isTagMappingIssue(mapping: SourceTagMappingDiagnostic): boolean {
  return TAG_MAPPING_ISSUE_RELATIONS.includes(mapping.relation);
}

/** Pending source labels of one whole report, as the compact heading action reports them. */
export interface PendingTagMappingSummary {
  /** Unresolved mapping rows (`ambiguous`/`composite`/`narrower`/`unmapped`) of the whole report. */
  readonly pending: number;
  /** Distinct source instances those rows came from. */
  readonly sources: number;
}

/**
 * Summary of the unresolved source labels that wait for manual review.
 *
 * It counts **label rows**, never the per-label problem counters: several labels can sit on the same
 * problem, so those counters overlap and must not be summed into a "pending problems" total. The
 * input is the report's total (all difficulty bands) mapping list, which is what the action copy
 * says; a scoped difficulty band never replaces it.
 */
export function pendingTagMappingSummary(
  mappings: readonly SourceTagMappingDiagnostic[],
): PendingTagMappingSummary {
  let pending = 0;
  const sources = new Set<string>();
  for (const mapping of mappings) {
    if (!isTagMappingIssue(mapping)) {
      continue;
    }
    pending += 1;
    sources.add(mapping.sourceInstanceId);
  }
  return { pending, sources: sources.size };
}

/**
 * Mapping view state of the pending-mapping action: only unresolved rows, every conflicting source
 * and relation filter cleared, page 1.
 *
 * It is a pure state transition over the one confirmed report, so the action opens the existing
 * table in place — no second table, no API read and no model call.
 */
export function openPendingTagMappings(state: TagMappingViewState): TagMappingViewState {
  return changeTagMappingFilter(state, { sourceInstanceId: null, relation: 'all', issuesOnly: true });
}

/** Stable React key of one mapping row: source + exact raw + relation + rule, never the display name. */
export function sourceTagMappingKey(mapping: SourceTagMappingDiagnostic): string {
  return JSON.stringify([mapping.sourceInstanceId, mapping.raw, mapping.relation, mapping.ruleId]);
}

/** Local filter set of the 来源标签对照 section; it never triggers an API or model call. */
export interface TagMappingFilter {
  /** Selected source instance id, or `null` for every source. */
  readonly sourceInstanceId: string | null;
  readonly relation: TagMappingRelation | 'all';
  /** Keep only unresolved (`ambiguous`/`composite`/`narrower`/`unmapped`) mappings. */
  readonly issuesOnly: boolean;
}

/** Filter set plus the current page; one immutable value the component replaces on every action. */
export interface TagMappingViewState extends TagMappingFilter {
  readonly page: number;
}

/** Fresh mapping view state: every source, every relation, first page. */
export function initialTagMappingViewState(): TagMappingViewState {
  return { sourceInstanceId: null, relation: 'all', issuesOnly: false, page: 1 };
}

/** Apply a filter patch; **any** filter change returns to page 1, exactly like the technique table. */
export function changeTagMappingFilter(
  state: TagMappingViewState,
  patch: Partial<TagMappingFilter>,
): TagMappingViewState {
  return { ...state, ...patch, page: 1 };
}

/** Move to another mapping page, clamped into `1..totalPages` (`0` pages keeps page 1). */
export function moveTagMappingPage(
  state: TagMappingViewState,
  target: number,
  totalPages: number,
): TagMappingViewState {
  if (totalPages <= 0) {
    return { ...state, page: 1 };
  }
  const wanted = Number.isSafeInteger(target) && target >= 1 ? target : 1;
  return { ...state, page: Math.min(wanted, totalPages) };
}

/**
 * Repair a source-instance selection the refreshed report no longer offers.
 *
 * The mapping selector stores only a source instance id. A refresh can drop that instance entirely,
 * and the filter would then keep matching nothing while the selector shows a source that no longer
 * exists; the selection therefore falls back to all sources and to page 1 (the stored page belonged
 * to the old, narrower result). A still-offered selection returns the same state object, so a caller
 * may run this on every report change inside an effect without causing a render loop.
 */
export function reconcileTagMappingSource(
  state: TagMappingViewState,
  mappings: readonly SourceTagMappingDiagnostic[],
): TagMappingViewState {
  if (state.sourceInstanceId === null) {
    return state;
  }
  return mappings.some((mapping) => mapping.sourceInstanceId === state.sourceInstanceId)
    ? state
    : { ...state, sourceInstanceId: null, page: 1 };
}

/** One selectable source of the mapping table, in report order. */
export interface TagMappingSourceOption {
  readonly sourceInstanceId: string;
  readonly vocabulary: TagVocabulary;
  /** Mappings reported for this instance. */
  readonly count: number;
  /** Vocabulary label plus the exact instance id, so two instances never merge by name. */
  readonly label: string;
}

/** Every source instance that reported at least one mapping, in first-seen report order. */
export function tagMappingSourceOptions(
  mappings: readonly SourceTagMappingDiagnostic[],
): readonly TagMappingSourceOption[] {
  const bySource = new Map<string, { readonly vocabulary: TagVocabulary; count: number }>();
  for (const mapping of mappings) {
    const existing = bySource.get(mapping.sourceInstanceId);
    if (existing === undefined) {
      bySource.set(mapping.sourceInstanceId, { vocabulary: mapping.vocabulary, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  return [...bySource.entries()].map(([sourceInstanceId, entry]) => ({
    sourceInstanceId,
    vocabulary: entry.vocabulary,
    count: entry.count,
    label: `${TAG_VOCABULARY_LABELS[entry.vocabulary]} · ${sourceInstanceId}`,
  }));
}

/** Code-point text order; `0` only for equal text (never `localeCompare`). */
function compareMappingText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Mapping rows selected by one filter set, in the deterministic order of the report itself.
 *
 * Rows are re-sorted defensively by source instance, exact raw label, relation and rule, so paging
 * and React keys stay stable regardless of the order a caller passes in. The same raw text from two
 * sources therefore remains two rows; nothing is merged by display name.
 */
export function selectSourceTagMappings(
  mappings: readonly SourceTagMappingDiagnostic[],
  filter: TagMappingFilter,
): readonly SourceTagMappingDiagnostic[] {
  return mappings
    .filter(
      (mapping) =>
        (filter.sourceInstanceId === null || mapping.sourceInstanceId === filter.sourceInstanceId) &&
        (filter.relation === 'all' || mapping.relation === filter.relation) &&
        (!filter.issuesOnly || isTagMappingIssue(mapping)),
    )
    .sort(
      (left, right) =>
        compareMappingText(left.sourceInstanceId, right.sourceInstanceId) ||
        compareMappingText(left.raw, right.raw) ||
        compareMappingText(left.relation, right.relation) ||
        compareMappingText(left.ruleId, right.ruleId),
    );
}

/** One served page of filtered mapping rows. */
export interface TagMappingPage {
  readonly items: readonly SourceTagMappingDiagnostic[];
  readonly totalItems: number;
  readonly totalPages: number;
  /** Served page; `0` for an empty filtered result, so no page is ever fabricated. */
  readonly page: number;
}

/** Slice filtered mappings into one clamped page of {@link TAG_MAPPING_PAGE_SIZE} rows. */
export function tagMappingPage(
  rows: readonly SourceTagMappingDiagnostic[],
  requestedPage: number,
): TagMappingPage {
  const totalItems = rows.length;
  const totalPages = Math.ceil(totalItems / TAG_MAPPING_PAGE_SIZE);
  if (totalPages === 0) {
    return { items: [], totalItems: 0, totalPages: 0, page: 0 };
  }
  const wanted = Number.isSafeInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
  const page = Math.min(wanted, totalPages);
  const start = (page - 1) * TAG_MAPPING_PAGE_SIZE;
  return { items: rows.slice(start, start + TAG_MAPPING_PAGE_SIZE), totalItems, totalPages, page };
}

/** Chinese names of the counted targets, or the honest fallback for a mapping that counted nothing. */
export function sourceTagMappingTargetText(
  mapping: SourceTagMappingDiagnostic,
  catalog: readonly TaxonomyNode[],
): string {
  if (mapping.targetIds.length > 0) {
    return mapping.targetIds.map((id) => catalog.find((node) => node.id === id)?.names.zh ?? id).join('、');
  }
  if (mapping.relation === 'reference') {
    return '仅作资料';
  }
  if (mapping.relation === 'non_algorithm') {
    return '来源信息，不计入知识点';
  }
  return '待核对';
}

/** Candidate names kept for review; empty text when the mapping has no candidate. */
export function sourceTagMappingCandidateText(
  mapping: SourceTagMappingDiagnostic,
  catalog: readonly TaxonomyNode[],
): string {
  if (mapping.candidateIds.length === 0) {
    return '';
  }
  const names = mapping.candidateIds.map((id) => catalog.find((node) => node.id === id)?.names.zh ?? id);
  return `候选：${names.join('、')}`;
}

/**
 * Visible title of one external reference of a mapping row.
 *
 * The table shows what a link *is* — `平台标签说明` for a platform's own terminology page,
 * `知识点参考` for an OI Wiki definition — while the URL stays in the anchor's `href`; no
 * implementation prose is rendered in the cell. Anything outside `oi-wiki.org` counts as a platform
 * page, and a non-URL string still gets a title instead of throwing.
 */
export function sourceTagMappingReferenceTitle(url: string): string {
  return /^https?:\/\/(?:[a-z0-9-]+\.)*oi-wiki\.org(?:\/|$)/iu.test(url) ? '知识点参考' : '平台标签说明';
}
