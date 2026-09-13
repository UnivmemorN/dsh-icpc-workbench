/**
 * Reading rules of the knowledge view (Sprint 09b).
 *
 * These cases drive the pure helpers of `knowledge-view.ts` directly: no DOM, no store, no clock and
 * no network. They pin the externally meaningful guarantees the page relies on — Chinese/English/
 * alias/id search, subtree selection over the catalog's explicit parent links (never dotted id
 * prefixes), deterministic numeric sorts that keep catalog order on ties and never mutate their
 * inputs, paging and filter resets, parent-union category summaries, threshold-aware status copy,
 * all-missing native-rating ranges, and catalog drift that is reported instead of fabricated.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  KnowledgeNodeEvidence,
  KnowledgeRatingRange,
  SourceTagMappingDiagnostic,
  TaxonomyNode,
  TaxonomyNodeKind,
} from '../../src/domain/index.js';
import {
  KNOWLEDGE_AC_NOTE,
  KNOWLEDGE_CATEGORY_SUMMARY_NOTE,
  KNOWLEDGE_NO_OBSERVATION_NOTE,
  KNOWLEDGE_PAGE_SIZE,
  KNOWLEDGE_SORTS,
  KNOWLEDGE_SORT_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  KNOWLEDGE_TAG_MAPPING_NOTE,
  KNOWLEDGE_TECHNIQUE_STATUSES,
  TAG_MAPPING_PAGE_SIZE,
  TAG_MAPPING_RELATION_LABELS,
  TAG_VOCABULARY_LABELS,
  changeKnowledgeFilter,
  changeTagMappingFilter,
  initialKnowledgeViewState,
  initialTagMappingViewState,
  isTagMappingIssue,
  knowledgeCategoryOptions,
  knowledgeCategorySummary,
  knowledgeIdInCategory,
  knowledgePage,
  knowledgeRatingText,
  knowledgeRelationLabel,
  knowledgeSearchText,
  knowledgeStatusCounts,
  knowledgeStatusHint,
  knowledgeTechniqueCoverage,
  knowledgeTechniqueRows,
  knowledgeUnknownCatalogIds,
  matchesKnowledgeQuery,
  moveKnowledgePage,
  moveTagMappingPage,
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
  type KnowledgeViewState,
  type TagMappingViewState,
} from '../../src/ui/knowledge-view.js';

/** Independence threshold used by these cases; the report echoes its own value. */
const THRESHOLD = 5;

function node(
  id: string,
  parentId: string | null,
  kind: TaxonomyNodeKind,
  en: string,
  zh: string,
  aliases: readonly string[] = [],
): TaxonomyNode {
  return { id, parentId, kind, names: { en, zh }, aliases, description: `${en} (ui test node)` };
}

function evidence(
  taxonomyId: string,
  parentId: string | null,
  kind: TaxonomyNodeKind,
  overrides: Partial<KnowledgeNodeEvidence> = {},
): KnowledgeNodeEvidence {
  return {
    taxonomyId,
    parentId,
    kind,
    platformAttemptedDistinct: 0,
    platformSolvedDistinct: 0,
    verifiedAttemptedDistinct: 0,
    verifiedSolvedDistinct: 0,
    retrospectiveIndependentDistinct: 0,
    retrospectiveAssistedDistinct: 0,
    retrospectiveSolutionUsedDistinct: 0,
    observedRelatedDistinct: 0,
    independentRatingRanges: [],
    status: kind === 'category' ? 'category_summary' : 'not_observed',
    descendantTechniqueNodes: 0,
    descendantTechniqueNodesWithIndependentEvidence: 0,
    ...overrides,
  };
}

/**
 * Catalog whose explicit parent links deliberately disagree with its dotted ids:
 * `archive.old.number` sits under `math` (depth 1, not the 2 its id suggests), and both
 * `math.number-theory.prime` and `misc.gcd` hang under it although their ids point elsewhere.
 */
const CATALOG: readonly TaxonomyNode[] = [
  node('math', null, 'category', 'Mathematics', '数学'),
  node('math.number-theory', 'math', 'category', 'Number theory', '数论'),
  node('archive.old.number', 'math', 'category', 'Archived number theory', '归档数论'),
  node('math.number-theory.gcd', 'math.number-theory', 'technique', 'Greatest common divisor', '最大公约数', [
    'gcd',
    '欧几里得',
  ]),
  node('math.number-theory.prime', 'archive.old.number', 'technique', 'Prime sieve', '素数筛', ['sieve', '筛法']),
  node('misc.gcd', 'archive.old.number', 'technique', 'Misc gcd', '杂项最大公约数', ['misc gcd']),
];

/** One evidence row per catalog node; category counters are the domain's folded subtree values. */
const NODES: readonly KnowledgeNodeEvidence[] = [
  evidence('math', null, 'category', {
    status: 'category_summary',
    observedRelatedDistinct: 7,
    descendantTechniqueNodes: 3,
    descendantTechniqueNodesWithIndependentEvidence: 2,
  }),
  evidence('math.number-theory', 'math', 'category', {
    status: 'category_summary',
    observedRelatedDistinct: 4,
    descendantTechniqueNodes: 1,
    descendantTechniqueNodesWithIndependentEvidence: 1,
  }),
  evidence('archive.old.number', 'math', 'category', {
    status: 'category_summary',
    observedRelatedDistinct: 5,
    descendantTechniqueNodes: 2,
    descendantTechniqueNodesWithIndependentEvidence: 1,
  }),
  evidence('math.number-theory.gcd', 'math.number-theory', 'technique', {
    status: 'independent_evidence',
    retrospectiveIndependentDistinct: 5,
    observedRelatedDistinct: 6,
  }),
  evidence('math.number-theory.prime', 'archive.old.number', 'technique', {
    status: 'practicing',
    retrospectiveIndependentDistinct: 2,
    observedRelatedDistinct: 3,
  }),
  evidence('misc.gcd', 'archive.old.number', 'technique', {
    status: 'practicing',
    retrospectiveIndependentDistinct: 2,
    observedRelatedDistinct: 3,
  }),
];

/** Generator for a catalog large enough to need more than one page. */
function generated(count: number): { readonly catalog: readonly TaxonomyNode[]; readonly nodes: readonly KnowledgeNodeEvidence[] } {
  const catalog: TaxonomyNode[] = [node('gen', null, 'category', 'Generated', '生成')];
  const nodes: KnowledgeNodeEvidence[] = [
    evidence('gen', null, 'category', { status: 'category_summary', descendantTechniqueNodes: count }),
  ];
  for (let index = 0; index < count; index += 1) {
    const id = `gen.t${String(index).padStart(2, '0')}`;
    catalog.push(node(id, 'gen', 'technique', `Technique ${index}`, `技术 ${index}`));
    nodes.push(
      evidence(id, 'gen', 'technique', {
        retrospectiveIndependentDistinct: index % 3,
        observedRelatedDistinct: index,
      }),
    );
  }
  return { catalog, nodes };
}

void test('search matches Chinese name, English name, aliases and id', () => {
  const gcd = CATALOG[3]!;
  const misc = CATALOG[5]!;
  assert.ok(matchesKnowledgeQuery(gcd, '最大公约数'), 'Chinese name');
  assert.ok(matchesKnowledgeQuery(gcd, 'Greatest Common Divisor'), 'English name');
  assert.ok(matchesKnowledgeQuery(gcd, 'MATH.NUMBER-THEORY.GCD'), 'id, case-insensitive');
  assert.ok(matchesKnowledgeQuery(gcd, '欧几里得'), 'alias');
  assert.ok(matchesKnowledgeQuery(gcd, ''), 'empty query keeps everything');
  assert.ok(!matchesKnowledgeQuery(gcd, '素数筛'), 'no cross-node match');
  assert.ok(matchesKnowledgeQuery(CATALOG[1]!, 'number theory'), 'English name with a space');
  assert.ok(matchesKnowledgeQuery(CATALOG[1]!, 'number-theory'), 'id with a hyphen');
  assert.ok(matchesKnowledgeQuery(misc, 'misc_gcd'), 'underscore collapses to a space');
  assert.ok(matchesKnowledgeQuery(misc, 'misc/gcd'), 'slash collapses to a space');
  assert.ok(knowledgeSearchText(gcd).includes('gcd'), 'search text exposes id, names and aliases');
});

void test('subtree membership follows explicit parent links, not dotted id prefixes', () => {
  assert.ok(knowledgeIdInCategory(CATALOG, 'math', 'math'), 'the category includes itself');
  assert.ok(knowledgeIdInCategory(CATALOG, 'math.number-theory.gcd', 'math'), 'grandchild via the chain');
  assert.ok(
    knowledgeIdInCategory(CATALOG, 'misc.gcd', 'math'),
    'misc.gcd has no math id prefix but its parent chain reaches math',
  );
  assert.ok(
    knowledgeIdInCategory(CATALOG, 'math.number-theory.prime', 'archive.old.number'),
    'prime hangs under archive by parentId, not under its number-theory prefix',
  );
  // Sibling isolation: prime's id prefix points at number-theory, but its real parent does not.
  assert.ok(!knowledgeIdInCategory(CATALOG, 'math.number-theory.prime', 'math.number-theory'));
  assert.ok(!knowledgeIdInCategory(CATALOG, 'math.number-theory.gcd', 'archive.old.number'));
  assert.ok(!knowledgeIdInCategory(CATALOG, 'math.number-theory.gcd', 'math.number-theory.prime'));
  assert.ok(!knowledgeIdInCategory(CATALOG, 'unknown.node', 'math'));
});

void test('a parent cycle ends the walk instead of looping', () => {
  const cyclic: readonly TaxonomyNode[] = [
    node('a', 'b', 'category', 'A', '甲'),
    node('b', 'a', 'category', 'B', '乙'),
  ];
  assert.equal(knowledgeIdInCategory(cyclic, 'a', 'c'), false);
  assert.equal(knowledgeIdInCategory(cyclic, 'a', 'b'), true);
});

void test('category options nest by parent chain and count their whole subtree', () => {
  assert.deepEqual(
    knowledgeCategoryOptions(CATALOG).map((option) => [option.id, option.depth, option.label, option.techniqueCount]),
    [
      ['math', 0, '数学', 3],
      ['math.number-theory', 1, '— 数论', 1],
      // Depth 1 via parentId, even though the dotted id `archive.old.number` suggests depth 2.
      ['archive.old.number', 1, '— 归档数论', 2],
    ],
  );
});

void test('technique rows join the catalog and unknown ids are reported, never rendered', () => {
  const rows = knowledgeTechniqueRows(NODES, CATALOG);
  assert.deepEqual(
    rows.map((row) => row.taxonomyId),
    ['math.number-theory.gcd', 'math.number-theory.prime', 'misc.gcd'],
  );
  assert.equal(rows[0]!.categoryPath, '数学 › 数论');
  // Parent chain, not the `math.number-theory` prefix the id would suggest.
  assert.equal(rows[1]!.categoryPath, '数学 › 归档数论');
  assert.equal(rows[2]!.categoryPath, '数学 › 归档数论');

  const drifted: readonly KnowledgeNodeEvidence[] = [
    ...NODES,
    evidence('ghost.one', null, 'technique'),
    evidence('ghost.two', 'ghost.one', 'technique'),
  ];
  assert.deepEqual(knowledgeUnknownCatalogIds(drifted, CATALOG), ['ghost.one', 'ghost.two']);
  assert.deepEqual(
    knowledgeTechniqueRows(drifted, CATALOG).map((row) => row.taxonomyId),
    ['math.number-theory.gcd', 'math.number-theory.prime', 'misc.gcd'],
    'a row the catalog no longer knows is left out instead of being fabricated',
  );
});

void test('status counts describe techniques only, in the fixed distribution order', () => {
  const report: readonly KnowledgeNodeEvidence[] = [
    ...NODES,
    // A category row must not leak into the technique distribution, whatever status it carries.
    evidence('cat.lying', null, 'category', { status: 'independent_evidence' }),
    evidence('tech.a', null, 'technique', { status: 'unconfirmed' }),
    evidence('tech.b', null, 'technique', { status: 'needs_practice' }),
    evidence('tech.c', null, 'technique', { status: 'not_observed' }),
  ];
  const counts = knowledgeStatusCounts(report);
  assert.deepEqual(
    counts.map((entry) => entry.status),
    [...KNOWLEDGE_TECHNIQUE_STATUSES],
  );
  assert.deepEqual(
    counts.map((entry) => entry.count),
    [1, 1, 1, 2, 1],
  );
  for (const entry of counts) {
    assert.equal(entry.label, KNOWLEDGE_STATUS_LABELS[entry.status]);
  }
  assert.deepEqual(
    knowledgeStatusCounts([]).map((entry) => entry.count),
    [0, 0, 0, 0, 0],
    'zero counts stay visible',
  );

  const coverage = knowledgeTechniqueCoverage(report, THRESHOLD);
  assert.equal(coverage.techniques, 6, 'category rows do not count as techniques');
  assert.equal(coverage.withIndependentEvidence, 3, 'at least one independent problem, not the full threshold');
  assert.equal(coverage.minimumIndependentProblems, THRESHOLD);
});

void test('sorts are deterministic, keep catalog order on ties, and never mutate inputs', () => {
  const beforeNodes = structuredClone(NODES);
  const beforeCatalog = structuredClone(CATALOG);
  const base = initialKnowledgeViewState();

  const catalogOrder = selectKnowledgeTechniques(NODES, CATALOG, base);
  assert.deepEqual(
    catalogOrder.map((row) => row.taxonomyId),
    ['math.number-theory.gcd', 'math.number-theory.prime', 'misc.gcd'],
  );
  assert.ok(catalogOrder.every((row) => row.evidence.kind === 'technique'), 'category rows stay out of the table');

  const ascending = selectKnowledgeTechniques(NODES, CATALOG, { ...base, sort: 'independent-asc' });
  assert.deepEqual(
    ascending.map((row) => row.taxonomyId),
    // prime and misc tie at 2 independent problems; catalog order breaks the tie.
    ['math.number-theory.prime', 'misc.gcd', 'math.number-theory.gcd'],
  );
  const descending = selectKnowledgeTechniques(NODES, CATALOG, { ...base, sort: 'independent-desc' });
  assert.deepEqual(
    descending.map((row) => row.taxonomyId),
    ['math.number-theory.gcd', 'math.number-theory.prime', 'misc.gcd'],
  );
  const related = selectKnowledgeTechniques(NODES, CATALOG, { ...base, sort: 'related-desc' });
  assert.deepEqual(
    related.map((row) => row.taxonomyId),
    // prime and misc tie at 3 related problems; catalog order breaks the tie.
    ['math.number-theory.gcd', 'math.number-theory.prime', 'misc.gcd'],
  );

  assert.deepEqual(NODES, beforeNodes, 'the evidence array is not reordered');
  assert.deepEqual(CATALOG, beforeCatalog, 'the catalog array is not reordered');
});

void test('category, status and search filters combine locally over one report', () => {
  const base = initialKnowledgeViewState();
  assert.deepEqual(
    selectKnowledgeTechniques(NODES, CATALOG, { ...base, categoryId: 'math' }).map((row) => row.taxonomyId),
    ['math.number-theory.gcd', 'math.number-theory.prime', 'misc.gcd'],
    'the parent category includes every subtree technique',
  );
  assert.deepEqual(
    selectKnowledgeTechniques(NODES, CATALOG, { ...base, categoryId: 'math.number-theory' }).map(
      (row) => row.taxonomyId,
    ),
    ['math.number-theory.gcd'],
  );
  assert.deepEqual(
    selectKnowledgeTechniques(NODES, CATALOG, { ...base, categoryId: 'archive.old.number' }).map(
      (row) => row.taxonomyId,
    ),
    ['math.number-theory.prime', 'misc.gcd'],
  );
  assert.deepEqual(
    selectKnowledgeTechniques(NODES, CATALOG, { ...base, status: 'practicing' }).map((row) => row.taxonomyId),
    ['math.number-theory.prime', 'misc.gcd'],
  );
  assert.deepEqual(
    selectKnowledgeTechniques(NODES, CATALOG, { ...base, query: '欧几里得' }).map((row) => row.taxonomyId),
    ['math.number-theory.gcd'],
  );
  assert.deepEqual(
    selectKnowledgeTechniques(NODES, CATALOG, {
      ...base,
      categoryId: 'math',
      status: 'practicing',
      query: '筛',
    }).map((row) => row.taxonomyId),
    ['math.number-theory.prime'],
  );
});

void test('paging slices, clamps and reports an empty result as page 0', () => {
  const big = generated(KNOWLEDGE_PAGE_SIZE + 5);
  const rows = selectKnowledgeTechniques(big.nodes, big.catalog, initialKnowledgeViewState());
  assert.equal(rows.length, KNOWLEDGE_PAGE_SIZE + 5);

  const first = knowledgePage(rows, 1);
  assert.equal(first.items.length, KNOWLEDGE_PAGE_SIZE);
  assert.equal(first.totalItems, KNOWLEDGE_PAGE_SIZE + 5);
  assert.equal(first.totalPages, 2);
  assert.equal(first.page, 1);

  const second = knowledgePage(rows, 2);
  assert.equal(second.items.length, 5);
  assert.equal(second.items[0]!.taxonomyId, `gen.t${String(KNOWLEDGE_PAGE_SIZE).padStart(2, '0')}`);

  assert.equal(knowledgePage(rows, 99).page, 2, 'a page past the end is clamped');
  assert.equal(knowledgePage(rows, 0).page, 1, 'a page below the start is clamped');
  assert.equal(knowledgePage(rows, Number.NaN).page, 1);

  assert.deepEqual(
    knowledgePage([], 3),
    { items: [], totalItems: 0, totalPages: 0, page: 0 },
    'an empty filter result has no fabricated page',
  );

  const paged: KnowledgeViewState = { ...initialKnowledgeViewState(), page: 2 };
  assert.equal(moveKnowledgePage(paged, 5, 0).page, 1);
  assert.equal(moveKnowledgePage(paged, 5, 2).page, 2);
  assert.equal(moveKnowledgePage(paged, 1, 2).page, 1);
  assert.equal(moveKnowledgePage(paged, Number.NaN, 2).page, 1);
});

void test('every filter change clears the page, and a vanished category falls back to all', () => {
  const paged: KnowledgeViewState = {
    query: 'x',
    categoryId: 'math',
    status: 'practicing',
    sort: 'related-desc',
    page: 3,
  };
  assert.equal(changeKnowledgeFilter(paged, { query: '筛' }).page, 1);
  assert.equal(changeKnowledgeFilter(paged, { status: 'all' }).page, 1);
  assert.equal(changeKnowledgeFilter(paged, { sort: 'catalog' }).page, 1);
  assert.equal(changeKnowledgeFilter(paged, { categoryId: null }).page, 1);
  const patched = changeKnowledgeFilter(paged, { query: 'gcd' });
  assert.equal(patched.categoryId, 'math', 'an untouched filter field survives the patch');
  assert.equal(patched.status, 'practicing');
  assert.equal(patched.page, 1);

  // Still offered: the very same object is returned, so an effect calling this settles.
  assert.equal(reconcileKnowledgeCategory(paged, CATALOG), paged);
  assert.equal(reconcileKnowledgeCategory(initialKnowledgeViewState(), CATALOG).categoryId, null);

  const repaired = reconcileKnowledgeCategory(
    paged,
    CATALOG.filter((entry) => entry.id !== 'math'),
  );
  assert.equal(repaired.categoryId, null);
  assert.equal(repaired.page, 1, 'the old page belonged to the old, narrower result set');
  assert.equal(repaired.query, 'x', 'only the category and page are repaired');

  const noLongerACategory = reconcileKnowledgeCategory({ ...paged, categoryId: 'math.number-theory.gcd' }, CATALOG);
  assert.equal(noLongerACategory.categoryId, null);
  assert.equal(noLongerACategory.page, 1);
});

void test('category summaries keep the parent union instead of re-summing child counters', () => {
  assert.deepEqual(knowledgeCategorySummary(NODES, CATALOG, 'math'), {
    taxonomyId: 'math',
    nameZh: '数学',
    relatedProblems: 7,
    descendantsWithIndependentEvidence: 2,
    descendantTechniques: 3,
  });
  assert.notEqual(
    knowledgeCategorySummary(NODES, CATALOG, 'math')!.relatedProblems,
    4 + 5,
    'the shared problem is counted once, not as the sum of the child rows',
  );
  assert.equal(knowledgeCategorySummary(NODES, CATALOG, 'math.number-theory')!.relatedProblems, 4);
  assert.equal(knowledgeCategorySummary(NODES, CATALOG, 'archive.old.number')!.descendantTechniques, 2);

  assert.equal(knowledgeCategorySummary(NODES, CATALOG, 'ghost.category'), null, 'unknown id');
  assert.equal(
    knowledgeCategorySummary(NODES, CATALOG, 'math.number-theory.gcd'),
    null,
    'a technique id is not a category summary',
  );
  const catalogWithEmpty = [...CATALOG, node('empty.category', null, 'category', 'Empty category', '空分类')];
  assert.equal(
    knowledgeCategorySummary(NODES, catalogWithEmpty, 'empty.category'),
    null,
    'a catalog category without an evidence row has no summary to show',
  );
});

void test('status explanations state the report threshold instead of a mastery claim', () => {
  assert.ok(knowledgeStatusHint('not_observed', THRESHOLD).includes(KNOWLEDGE_NO_OBSERVATION_NOTE));
  assert.ok(knowledgeStatusHint('unconfirmed', THRESHOLD).includes(KNOWLEDGE_AC_NOTE));
  assert.match(knowledgeStatusHint('needs_practice', THRESHOLD), /提示或参考题解/);
  assert.match(knowledgeStatusHint('needs_practice', THRESHOLD), /独立重做/);
  assert.match(knowledgeStatusHint('practicing', THRESHOLD), /已有 1–4 道独立完成的题目/);
  assert.match(knowledgeStatusHint('practicing', THRESHOLD), /5 道的独立证据阈值/);
  assert.match(knowledgeStatusHint('practicing', 2), /已有 1 道独立完成的题目/);
  assert.doesNotMatch(knowledgeStatusHint('practicing', 2), /1–1/);
  assert.match(knowledgeStatusHint('independent_evidence', 3), /至少 3 道独立完成的题目/);
  assert.match(knowledgeStatusHint('independent_evidence', THRESHOLD), /不是掌握证明/);
  assert.equal(knowledgeStatusHint('category_summary', THRESHOLD), KNOWLEDGE_CATEGORY_SUMMARY_NOTE);
});

void test('rating text accounts for every independent problem, including missing values', () => {
  assert.equal(knowledgeRatingText([], 0), '还没有独立完成的题目，因此没有独立难度范围可展示。');
  assert.match(knowledgeRatingText([], 2), /已有 2 道独立完成的题目/);
  assert.match(knowledgeRatingText([], 2), /都没有可用的平台原生难度数值，全部缺失/);

  const ranges: readonly KnowledgeRatingRange[] = [
    { dimension: 'rating', count: 2, missing: 1, min: 1200, max: 1600 },
    { dimension: 'difficulty', count: 0, missing: 3, min: null, max: null },
  ];
  const text = knowledgeRatingText(ranges, 3);
  assert.match(text, /独立完成 3 道题/);
  assert.match(text, /rating 1200–1600（2 题有数值，1 题缺失）/);
  assert.match(text, /difficulty：全部 3 题缺失数值/);

  assert.match(
    knowledgeRatingText([{ dimension: 'rating', count: 1, missing: 0, min: 1500, max: 1500 }], 1),
    /rating 1500（1 题有数值，0 题缺失）/,
    'a single value prints once instead of as a range',
  );
});

void test('sort choices and resource relations stay distinguishable', () => {
  assert.equal(KNOWLEDGE_SORTS.length, 4);
  for (const sort of KNOWLEDGE_SORTS) {
    assert.ok(KNOWLEDGE_SORT_LABELS[sort].trim().length > 0, `${sort} needs a label`);
  }
  assert.equal(knowledgeRelationLabel('topic'), '主题条目');
  assert.equal(knowledgeRelationLabel('overview'), '参考概述');
});

/** One source-label diagnostic row; every field is overridable so each case stays explicit. */
function mapping(raw: string, overrides: Partial<SourceTagMappingDiagnostic> = {}): SourceTagMappingDiagnostic {
  return {
    mappingVersion: '2026.09.13.1',
    taxonomyVersion: 'test.10.1',
    raw,
    sourceInstanceId: 'codeforces:codeforces.com',
    vocabulary: 'codeforces',
    relation: 'exact',
    targetIds: [],
    candidateIds: [],
    ruleId: 'test.rule',
    explanation: '测试说明',
    referenceUrls: [],
    attemptedDistinct: 1,
    solvedDistinct: 0,
    ...overrides,
  };
}

void test('source-label diagnostics filter locally by source, relation and issues only', () => {
  const rows: readonly SourceTagMappingDiagnostic[] = [
    mapping('栈', { targetIds: ['math.number-theory.gcd'], attemptedDistinct: 2, solvedDistinct: 1 }),
    mapping('hash', { relation: 'ambiguous', candidateIds: ['math.number-theory.gcd'], attemptedDistinct: 1 }),
    mapping('luogu-tag:42', {
      sourceInstanceId: 'luogu:www.luogu.com.cn',
      vocabulary: 'luogu',
      relation: 'reference',
    }),
    mapping('tarjan', { sourceInstanceId: 'luogu:www.luogu.com.cn', vocabulary: 'luogu', relation: 'ambiguous' }),
  ];
  const base = initialTagMappingViewState();
  assert.equal(selectSourceTagMappings(rows, base).length, 4);
  assert.deepEqual(
    selectSourceTagMappings(rows, { ...base, sourceInstanceId: 'luogu:www.luogu.com.cn' }).map((row) => row.raw),
    ['luogu-tag:42', 'tarjan'],
    'a source filter keeps only that instance',
  );
  assert.deepEqual(
    selectSourceTagMappings(rows, { ...base, relation: 'ambiguous' }).map((row) => row.raw),
    ['hash', 'tarjan'],
  );
  assert.deepEqual(
    selectSourceTagMappings(rows, { ...base, issuesOnly: true }).map((row) => row.raw),
    ['hash', 'tarjan'],
    'issues-only keeps every unresolved relation',
  );
  assert.deepEqual(
    selectSourceTagMappings(rows, { ...base, issuesOnly: true, sourceInstanceId: 'codeforces:codeforces.com' }).map(
      (row) => row.raw,
    ),
    ['hash'],
    'source and issue filters combine',
  );
  assert.equal(isTagMappingIssue(rows[0]!), false);
  assert.equal(isTagMappingIssue(rows[1]!), true);

  const before = structuredClone(rows);
  selectSourceTagMappings(rows, { ...base, issuesOnly: true });
  assert.deepEqual(rows, before, 'filtering never reorders or mutates the report rows');
});

void test('source-label diagnostics page with a bounded table and clamped pages', () => {
  const rows = Array.from({ length: TAG_MAPPING_PAGE_SIZE + 3 }, (_, index) =>
    mapping(`raw-${String(index).padStart(2, '0')}`, { relation: 'unmapped', attemptedDistinct: index + 1 }),
  );
  const pageOne = tagMappingPage(selectSourceTagMappings(rows, initialTagMappingViewState()), 1);
  assert.equal(pageOne.items.length, TAG_MAPPING_PAGE_SIZE, 'a large import never renders one unbounded table');
  assert.equal(pageOne.totalItems, TAG_MAPPING_PAGE_SIZE + 3);
  assert.equal(pageOne.totalPages, 2);
  assert.equal(tagMappingPage(rows, 99).page, 2, 'a page past the end is clamped');
  assert.equal(tagMappingPage(rows, Number.NaN).page, 1);
  assert.deepEqual(
    tagMappingPage([], 5),
    { items: [], totalItems: 0, totalPages: 0, page: 0 },
    'an empty filter result has no fabricated page',
  );

  const paged: TagMappingViewState = {
    ...initialTagMappingViewState(),
    sourceInstanceId: 'luogu:www.luogu.com.cn',
    relation: 'ambiguous',
    issuesOnly: true,
    page: 3,
  };
  const cleared = changeTagMappingFilter(paged, { relation: 'all' });
  assert.equal(cleared.page, 1, 'a filter change clears the page');
  assert.equal(cleared.sourceInstanceId, 'luogu:www.luogu.com.cn', 'untouched fields survive the patch');
  assert.equal(cleared.issuesOnly, true);
  assert.equal(moveTagMappingPage(paged, 5, 0).page, 1);
  assert.equal(moveTagMappingPage(paged, 5, 2).page, 2);
  assert.equal(moveTagMappingPage(paged, 1, 2).page, 1);
  assert.equal(moveTagMappingPage(paged, Number.NaN, 2).page, 1);
  assert.equal(
    initialTagMappingViewState().page,
    1,
    'the state an account change resets to has no filters and page 1',
  );
});

void test('mapping identity stays per source and target text never fabricates a name', () => {
  const cf = mapping('栈', { targetIds: ['math.number-theory.gcd'] });
  const luogu = mapping('栈', {
    sourceInstanceId: 'luogu:www.luogu.com.cn',
    vocabulary: 'luogu',
    targetIds: ['math.number-theory.gcd'],
  });
  assert.notEqual(sourceTagMappingKey(cf), sourceTagMappingKey(luogu), 'same raw text from two sources stays distinct');
  assert.equal(sourceTagMappingKey(cf), sourceTagMappingKey(mapping('栈', { targetIds: ['math.number-theory.gcd'] })));

  assert.equal(sourceTagMappingTargetText(cf, CATALOG), '最大公约数', 'counted targets show their Chinese name');
  assert.equal(
    sourceTagMappingTargetText(mapping('hash', { relation: 'ambiguous', candidateIds: ['math.number-theory.gcd'] }), CATALOG),
    '待核对',
  );
  assert.equal(
    sourceTagMappingCandidateText(
      mapping('hash', { relation: 'ambiguous', candidateIds: ['math.number-theory.gcd'] }),
      CATALOG,
    ),
    '候选：最大公约数',
  );
  assert.equal(sourceTagMappingTargetText(mapping('luogu-tag:42', { relation: 'reference' }), CATALOG), '仅作资料');
  assert.equal(
    sourceTagMappingTargetText(mapping('2021', { relation: 'non_algorithm' }), CATALOG),
    '来源信息，不计入知识点',
  );
  assert.equal(sourceTagMappingCandidateText(cf, CATALOG), '', 'a counted mapping has no candidate line');

  const options = tagMappingSourceOptions([cf, luogu, mapping('hash')]);
  assert.deepEqual(
    options.map((option) => option.sourceInstanceId),
    ['codeforces:codeforces.com', 'luogu:www.luogu.com.cn'],
  );
  assert.deepEqual(
    options.map((option) => option.count),
    [2, 1],
  );
  assert.equal(
    options[0]!.label.includes('Codeforces') && options[0]!.label.includes('codeforces:codeforces.com'),
    true,
    'a source option shows its vocabulary and exact instance id',
  );
  assert.equal(TAG_MAPPING_RELATION_LABELS.exact, '精确对应');
  for (const label of Object.values(TAG_MAPPING_RELATION_LABELS)) {
    assert.ok(label.trim().length > 0, 'every relation needs a label');
  }
  assert.equal(TAG_VOCABULARY_LABELS['oi-wiki'], 'OI Wiki');
  assert.ok(KNOWLEDGE_TAG_MAPPING_NOTE.includes('不代表你实际用过该方法'));
});

void test('a vanished source instance falls back to all sources on page 1', () => {
  const rows: readonly SourceTagMappingDiagnostic[] = [
    mapping('栈', { targetIds: ['math.number-theory.gcd'] }),
    mapping('luogu-tag:42', {
      sourceInstanceId: 'luogu:www.luogu.com.cn',
      vocabulary: 'luogu',
      relation: 'reference',
    }),
  ];
  const paged: TagMappingViewState = {
    ...initialTagMappingViewState(),
    sourceInstanceId: 'luogu:www.luogu.com.cn',
    relation: 'reference',
    page: 2,
  };
  assert.equal(reconcileTagMappingSource(paged, rows), paged, 'a still-offered source keeps the identical state');
  assert.equal(reconcileTagMappingSource(initialTagMappingViewState(), rows).sourceInstanceId, null);

  const repaired = reconcileTagMappingSource(
    paged,
    rows.filter((row) => row.sourceInstanceId !== 'luogu:www.luogu.com.cn'),
  );
  assert.equal(repaired.sourceInstanceId, null);
  assert.equal(repaired.page, 1, 'the old page belonged to the old, narrower result set');
  assert.equal(repaired.relation, 'reference', 'only the source and page are repaired');
  assert.equal(
    reconcileTagMappingSource(paged, []).sourceInstanceId,
    null,
    'an empty refreshed report cannot keep a source selection',
  );
});

void test('reference links carry short visible titles, never raw URLs', () => {
  assert.equal(sourceTagMappingReferenceTitle('https://codeforces.com/apiHelp/objects#Problem'), '平台标签说明');
  assert.equal(sourceTagMappingReferenceTitle('https://www.luogu.com.cn/problem/list'), '平台标签说明');
  assert.equal(sourceTagMappingReferenceTitle('https://ac.nowcoder.com/acm/skill/acm'), '平台标签说明');
  assert.equal(sourceTagMappingReferenceTitle('https://oi-wiki.org/ds/stack/'), '知识点参考');
  assert.equal(
    sourceTagMappingReferenceTitle('https://m.oi-wiki.org/'),
    '知识点参考',
    'the host check is not a bare substring match',
  );
  assert.equal(
    sourceTagMappingReferenceTitle('https://evil.example/?next=https://oi-wiki.org/'),
    '平台标签说明',
    'a URL that merely mentions oi-wiki.org stays a platform page',
  );
  assert.equal(sourceTagMappingReferenceTitle('not a url'), '平台标签说明', 'a malformed URL still gets a title');
});
