import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeKnowledgeEvidence, createNormalizedProblem, createSubmission, createRetrospective,
  createTaxonomy, createTaxonomyIndex } from '../../src/domain/index.js';
import { knowledgeAtDifficulty, knowledgeDifficultyLabel } from '../../src/ui/knowledge-difficulty-view.js';
import { initialKnowledgeViewState, changeKnowledgeFilter, knowledgeStatusCounts,
  knowledgeCategorySummary, selectKnowledgeTechniques, knowledgePage } from '../../src/ui/knowledge-view.js';

void test('difficulty selection changes status/filter/sort/category evidence and retains unobserved catalog nodes', () => {
  const taxonomy = createTaxonomyIndex(createTaxonomy({ version: 'test.13', nodes: [
    { id: 'ds', parentId: null, kind: 'category', names: { en: 'Data structures', zh: '数据结构' }, aliases: [], description: '' },
    ...['stack', 'queue'].map(name => ({ id: 'ds.' + name, parentId: 'ds', kind: 'technique' as const,
      names: { en: name, zh: name }, aliases: [], description: '' })),
  ] }));
  const at = '2026-09-13T00:00:00.000Z', account = 'codeforces:codeforces.com|test';
  const ps = [800, 1800].map((rating, i) => createNormalizedProblem({
    ref: { sourceInstanceId: 'codeforces:codeforces.com', domain: null, externalKey: String(i) },
    title: 'fixture', url: 'https://example.test/' + i, fetchedAt: at, ratings: [{ dimension: 'rating', value: rating, scale: null, raw: String(rating) }],
  }));
  const report = computeKnowledgeEvidence({ taxonomy, accountId: account, problems: ps, decisions: [],
    submissions: ps.map((p, i) => createSubmission({ ref: p.ref, accountId: account, externalId: String(i), verdict: 'accepted', submittedAt: at })),
    retrospectives: ps.map((p, i) => createRetrospective({ problemRef: p.ref, accountId: account,
      mode: i === 0 ? 'independent' : 'solution_used', taxonomyIds: ['ds.stack'], recordedAt: at })),
  });
  const base = { ...initialKnowledgeViewState(), page: 8 };
  const high = report.difficultyBands[1]!;
  const state = changeKnowledgeFilter(base, { difficultyId: high.band.id });
  assert.equal(state.page, 1);
  const selected = knowledgeAtDifficulty(report, state.difficultyId);
  assert.equal(selected.label, 'CF · rating 1800–1999');
  assert.equal(selected.coverage.attemptedDistinctTotal, 1);
  assert.equal(selected.nodes.find(n => n.taxonomyId === 'ds.stack')!.status, 'needs_practice');
  const zero = selected.nodes.find(n => n.taxonomyId === 'ds.queue')!;
  assert.equal(zero.status, 'not_observed');
  assert.equal(zero.retrospectiveIndependentDistinct, 0);
  assert.deepEqual(zero.independentRatingRanges, []);
  assert.equal(knowledgeCategorySummary(selected.nodes, taxonomy.taxonomy.nodes, 'ds')!.descendantsWithIndependentEvidence, 0);
  assert.equal(knowledgeStatusCounts(selected.nodes).find(c => c.status === 'needs_practice')!.count, 1);
  const filtered = selectKnowledgeTechniques(selected.nodes, taxonomy.taxonomy.nodes,
    { ...state, status: 'needs_practice', sort: 'independent-desc' });
  assert.deepEqual(knowledgePage(filtered, state.page).items.map(r => r.taxonomyId), ['ds.stack']);
  assert.equal(knowledgeAtDifficulty(report, 'obsolete').nodes, report.nodes);
  assert.equal(knowledgeAtDifficulty(report, null).nodes, report.nodes);
  assert.equal(initialKnowledgeViewState().difficultyId, null);
  assert.match(knowledgeDifficultyLabel({ ...high.band, kind: 'unknown', value: null, upperExclusive: null }), /未知/);
  assert.equal(knowledgeDifficultyLabel({ ...high.band, sourceInstanceId: 'manual:school.test', domain: 'class-a', dimension: 'level', kind: 'value', value: 'Hard' }), 'manual:school.test / class-a · level Hard');
});
