/**
 * Knowledge learning evidence (Sprint 09a): pure domain reduction.
 *
 * The reduction is driven directly — no store, no clock, no model. Every case pins an externally
 * meaningful rule: every catalog node is reported, raw/adopted/retrospective channels never promote
 * each other, AC alone confirms nothing, only the latest retrospective counts, evidence propagates
 * up but never down, the independent threshold is explicit, unknown ids/labels are never fabricated,
 * and ratings stay in their native dimensions with missing values counted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TAG_MAPPING_VERSION,
  computeKnowledgeEvidence,
  createNormalizedProblem,
  createRetrospective,
  createSubmission,
  createTagDecision,
  createTaxonomy,
  createTaxonomyIndex,
  isDeeplyFrozen,
  type CompletionMode,
  type KnowledgeEvidenceReport,
  type KnowledgeNodeEvidence,
  type NormalizedProblem,
  type PlatformRating,
  type ProblemRef,
  type Retrospective,
  type Submission,
  type TagDecision,
  type TaxonomyNode,
  type TaxonomyNodeKind,
} from '../../src/domain/index.js';

const AT = '2026-11-01T08:00:00.000Z';
const LATER = '2026-11-02T08:00:00.000Z';
const INSTANCE = 'codeforces:codeforces.com';
const ACCOUNT = `${INSTANCE}|alice`;
const OTHER_ACCOUNT = `${INSTANCE}|bob`;

function node(
  id: string,
  parentId: string | null,
  kind: TaxonomyNodeKind,
  en: string,
  zh: string,
  aliases: readonly string[] = [],
): TaxonomyNode {
  return { id, parentId, kind, names: { en, zh }, aliases, description: `${en} (test node)` };
}

const CATALOG: readonly TaxonomyNode[] = [
  node('ds', null, 'category', 'Data structures', '数据结构'),
  node('ds.stack', 'ds', 'technique', 'Stack', '栈', ['stack', '栈']),
  node('ds.queue', 'ds', 'technique', 'Queue', '队列', ['queue']),
  node('ds.dsu', 'ds', 'technique', 'Disjoint set union', '并查集', ['dsu', 'union find']),
  node('graph', null, 'category', 'Graphs', '图论'),
  node('graph.mst', 'graph', 'technique', 'Minimum spanning tree', '最小生成树', ['mst']),
  node('math', null, 'category', 'Math', '数学'),
  node('math.number-theory', 'math', 'category', 'Number theory', '数论'),
  node('math.number-theory.fast-power', 'math.number-theory', 'technique', 'Fast power', '快速幂', ['fast power']),
];

const INDEX = createTaxonomyIndex(createTaxonomy({ version: 'test.09a.1', nodes: CATALOG }));

function rating(value: number | string, dimension = 'rating'): PlatformRating {
  return { dimension, value, scale: null, raw: String(value) };
}

function problem(
  externalKey: string,
  options: { readonly ratings?: readonly PlatformRating[]; readonly rawTags?: readonly string[] } = {},
): NormalizedProblem {
  return createNormalizedProblem({
    ref: { sourceInstanceId: INSTANCE, domain: null, externalKey },
    title: `Problem ${externalKey}`,
    url: `https://codeforces.com/problemset/problem/${externalKey}`,
    statement: null,
    fetchedAt: AT,
    ratings: options.ratings ?? [],
    rawTags: options.rawTags ?? [],
  });
}

function submission(
  ref: ProblemRef,
  externalId: string,
  verdict: 'accepted' | 'wrong_answer',
  accountId = ACCOUNT,
): Submission {
  return createSubmission({ accountId, ref, externalId, verdict, submittedAt: AT });
}

function retrospective(
  ref: ProblemRef,
  mode: CompletionMode,
  taxonomyIds: readonly string[],
  recordedAt: string,
  accountId = ACCOUNT,
): Retrospective {
  return createRetrospective({ problemRef: ref, accountId, mode, recordedAt, taxonomyIds });
}

function tagDecision(entry: NormalizedProblem, taxonomyId: string): TagDecision {
  return createTagDecision({
    problemKey: entry.key,
    taxonomyId,
    status: 'auto_adopted',
    origin: 'ai',
    decidedAt: AT,
    reasons: ['evidence_verified'],
  });
}

interface RunOptions {
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  readonly decisions?: readonly TagDecision[];
  readonly retrospectives?: readonly Retrospective[];
  readonly accountId?: string;
  readonly minimumIndependentProblems?: number;
}

function run(options: RunOptions): KnowledgeEvidenceReport {
  return computeKnowledgeEvidence({
    taxonomy: INDEX,
    accountId: options.accountId ?? ACCOUNT,
    problems: options.problems,
    submissions: options.submissions,
    decisions: options.decisions ?? [],
    retrospectives: options.retrospectives ?? [],
    minimumIndependentProblems: options.minimumIndependentProblems,
  });
}

function nodeOf(report: KnowledgeEvidenceReport, taxonomyId: string): KnowledgeNodeEvidence {
  const found = report.nodes.find((entry) => entry.taxonomyId === taxonomyId);
  assert.ok(found, `taxonomy node ${taxonomyId} is missing from the report`);
  return found;
}

void test('every catalog node is reported in catalog order and empty evidence stays explicit', () => {
  const report = run({ problems: [], submissions: [] });

  assert.equal(report.accountId, ACCOUNT);
  assert.equal(report.taxonomyVersion, 'test.09a.1');
  assert.equal(report.minimumIndependentProblems, 5);
  assert.deepEqual(
    report.nodes.map((entry) => entry.taxonomyId),
    CATALOG.map((entry) => entry.id),
    'the taxonomy catalog order is preserved',
  );
  assert.deepEqual(report.nodes.map((entry) => entry.taxonomyId), [...INDEX.ids]);
  for (const entry of report.nodes) {
    assert.equal(entry.platformAttemptedDistinct, 0);
    assert.equal(entry.platformSolvedDistinct, 0);
    assert.equal(entry.verifiedAttemptedDistinct, 0);
    assert.equal(entry.verifiedSolvedDistinct, 0);
    assert.equal(entry.retrospectiveIndependentDistinct, 0);
    assert.equal(entry.retrospectiveAssistedDistinct, 0);
    assert.equal(entry.retrospectiveSolutionUsedDistinct, 0);
    assert.equal(entry.observedRelatedDistinct, 0);
    assert.deepEqual(entry.independentRatingRanges, []);
    assert.equal(entry.status, entry.kind === 'category' ? 'category_summary' : 'not_observed');
  }
  assert.deepEqual(report.coverage, {
    attemptedDistinctTotal: 0,
    solvedDistinctTotal: 0,
    relatedAttemptedDistinct: 0,
    verifiedAttemptedDistinct: 0,
    retrospectiveProblemDistinct: 0,
    unmatchedAlgorithmProblemDistinct: 0,
  });
  assert.deepEqual(report.unmatchedAlgorithmLabels, []);
  assert.equal(report.notes.includes('accepted_submission_alone_confirms_no_method'), true);

  assert.equal(nodeOf(report, 'ds').descendantTechniqueNodes, 3);
  assert.equal(nodeOf(report, 'ds').descendantTechniqueNodesWithIndependentEvidence, 0);
  assert.equal(nodeOf(report, 'math').descendantTechniqueNodes, 1, 'a nested category reports its whole subtree');
  assert.equal(nodeOf(report, 'math.number-theory').descendantTechniqueNodes, 1);
  assert.equal(nodeOf(report, 'ds.stack').descendantTechniqueNodes, 0, 'technique rows carry no category summary');

  assert.equal(isDeeplyFrozen(report), true);
  assert.deepEqual(run({ problems: [], submissions: [] }), report, 'the reduction is deterministic');
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, 'the report is JSON-serializable as-is');
});

void test('raw tags and adopted tags are related evidence but never a mastery status', () => {
  const p1 = problem('P1', { rawTags: ['stack', '栈'] });
  const p2 = problem('P2', { rawTags: ['codeforces', '2021', 'C++', '**'] });
  const report = run({
    problems: [p1, p2],
    submissions: [submission(p1.ref, 'a1', 'accepted'), submission(p1.ref, 'a2', 'accepted'), submission(p2.ref, 'b1', 'accepted')],
    decisions: [tagDecision(p2, 'ds.queue')],
  });

  const stack = nodeOf(report, 'ds.stack');
  assert.equal(stack.platformAttemptedDistinct, 1, 'two aliases of one problem count once');
  assert.equal(stack.platformSolvedDistinct, 1);
  assert.equal(stack.retrospectiveIndependentDistinct, 0);
  assert.equal(stack.status, 'unconfirmed');

  const queue = nodeOf(report, 'ds.queue');
  assert.equal(queue.platformAttemptedDistinct, 0);
  assert.equal(queue.verifiedAttemptedDistinct, 1);
  assert.equal(queue.verifiedSolvedDistinct, 1);
  assert.equal(queue.status, 'unconfirmed', 'an adopted tag alone is still not a recorded method');
  assert.equal(nodeOf(report, 'ds.dsu').status, 'not_observed');

  const ds = nodeOf(report, 'ds');
  assert.equal(ds.platformAttemptedDistinct, 1);
  assert.equal(ds.verifiedAttemptedDistinct, 1);
  assert.equal(ds.observedRelatedDistinct, 2, 'the category unions its children once per problem');
  assert.equal(ds.status, 'category_summary');

  assert.equal(report.coverage.relatedAttemptedDistinct, 2);
  assert.equal(report.coverage.verifiedAttemptedDistinct, 1);
  assert.deepEqual(report.unmatchedAlgorithmLabels, [], 'recognised provenance labels are not algorithm gaps');
});

void test('parents union their subtree once and never propagate evidence down to children', () => {
  const p1 = problem('P1', { rawTags: ['stack'] });
  const p2 = problem('P2', { rawTags: ['queue'] });
  const p3 = problem('P3', { rawTags: ['stack', 'queue'] });
  const report = run({
    problems: [p1, p2, p3],
    submissions: [
      submission(p1.ref, 'a1', 'accepted'),
      submission(p2.ref, 'b1', 'accepted'),
      submission(p3.ref, 'c1', 'accepted'),
    ],
  });

  assert.equal(nodeOf(report, 'ds').platformAttemptedDistinct, 3);
  assert.equal(nodeOf(report, 'ds.stack').platformAttemptedDistinct, 2);
  assert.equal(nodeOf(report, 'ds.queue').platformAttemptedDistinct, 2);
  assert.equal(nodeOf(report, 'ds.dsu').platformAttemptedDistinct, 0, 'evidence never travels down');
  assert.equal(nodeOf(report, 'graph').platformAttemptedDistinct, 0);
  assert.equal(nodeOf(report, 'graph.mst').platformAttemptedDistinct, 0);
});

void test('the latest retrospective replaces an earlier stronger statement', () => {
  const p1 = problem('P1', { ratings: [rating(1800)] });
  const report = run({
    problems: [p1],
    submissions: [submission(p1.ref, 'a1', 'accepted')],
    retrospectives: [
      retrospective(p1.ref, 'independent', ['ds.stack'], AT),
      retrospective(p1.ref, 'solution_used', ['ds.stack'], LATER),
    ],
  });

  const stack = nodeOf(report, 'ds.stack');
  assert.equal(stack.retrospectiveIndependentDistinct, 0);
  assert.equal(stack.retrospectiveAssistedDistinct, 0);
  assert.equal(stack.retrospectiveSolutionUsedDistinct, 1);
  assert.equal(stack.status, 'needs_practice');
  assert.deepEqual(stack.independentRatingRanges, [], 'only independent work feeds the rating range');
  assert.equal(nodeOf(report, 'ds').retrospectiveSolutionUsedDistinct, 1);
  assert.equal(report.coverage.retrospectiveProblemDistinct, 1);
});

void test('assisted and solution-used retrospectives count separately and both need practice', () => {
  const p1 = problem('P1');
  const p2 = problem('P2');
  const report = run({
    problems: [p1, p2],
    submissions: [submission(p1.ref, 'a1', 'accepted'), submission(p2.ref, 'b1', 'accepted')],
    retrospectives: [
      retrospective(p1.ref, 'assisted', ['ds.queue'], AT),
      retrospective(p2.ref, 'solution_used', ['ds.queue'], AT),
    ],
  });

  const queue = nodeOf(report, 'ds.queue');
  assert.equal(queue.retrospectiveIndependentDistinct, 0);
  assert.equal(queue.retrospectiveAssistedDistinct, 1);
  assert.equal(queue.retrospectiveSolutionUsedDistinct, 1);
  assert.equal(queue.observedRelatedDistinct, 2);
  assert.equal(queue.status, 'needs_practice');
});

void test('the independence threshold moves exactly at the configured boundary', () => {
  const problems = ['P1', 'P2', 'P3', 'P4', 'P5'].map((key) => problem(key));
  const submissions = problems.map((entry, index) => submission(entry.ref, `s${index}`, 'accepted'));
  const independents = problems.map((entry) => retrospective(entry.ref, 'independent', ['ds.stack'], AT));

  const four = run({ problems, submissions, retrospectives: independents.slice(0, 4) });
  assert.equal(nodeOf(four, 'ds.stack').retrospectiveIndependentDistinct, 4);
  assert.equal(nodeOf(four, 'ds.stack').status, 'practicing');
  assert.equal(nodeOf(four, 'ds.stack').observedRelatedDistinct, 4);
  assert.equal(nodeOf(four, 'ds').descendantTechniqueNodesWithIndependentEvidence, 1);

  const five = run({ problems, submissions, retrospectives: independents });
  assert.equal(nodeOf(five, 'ds.stack').retrospectiveIndependentDistinct, 5);
  assert.equal(nodeOf(five, 'ds.stack').status, 'independent_evidence');
  assert.equal(nodeOf(five, 'ds').descendantTechniqueNodesWithIndependentEvidence, 1);
  assert.equal(nodeOf(five, 'ds').descendantTechniqueNodes, 3);

  const custom = run({
    problems,
    submissions,
    retrospectives: independents.slice(0, 4),
    minimumIndependentProblems: 4,
  });
  assert.equal(custom.minimumIndependentProblems, 4);
  assert.equal(nodeOf(custom, 'ds.stack').status, 'independent_evidence', 'the threshold is an explicit input');

  const strict = run({ problems, submissions, retrospectives: independents, minimumIndependentProblems: 6 });
  assert.equal(nodeOf(strict, 'ds.stack').status, 'practicing');
});

void test('a retrospective confirms a method with no adopted tag at all', () => {
  const p1 = problem('P1', { rawTags: ['codeforces'] });
  const report = run({
    problems: [p1],
    submissions: [submission(p1.ref, 'a1', 'accepted')],
    retrospectives: [retrospective(p1.ref, 'independent', ['ds.dsu'], AT)],
  });

  const dsu = nodeOf(report, 'ds.dsu');
  assert.equal(dsu.platformAttemptedDistinct, 0);
  assert.equal(dsu.verifiedAttemptedDistinct, 0);
  assert.equal(dsu.retrospectiveIndependentDistinct, 1);
  assert.equal(dsu.observedRelatedDistinct, 1);
  assert.equal(dsu.status, 'practicing');
  assert.equal(nodeOf(report, 'ds').retrospectiveIndependentDistinct, 1);
  assert.equal(nodeOf(report, 'ds').platformAttemptedDistinct, 0);
});

void test('foreign rows and problems without an accepted submission are refused by the skill counts', () => {
  const p1 = problem('P1');
  const p2 = problem('P2');
  const p3 = problem('P3');
  const report = run({
    problems: [p1, p2, p3],
    submissions: [
      submission(p1.ref, 'a1', 'accepted'),
      // Bob shares the source instance; his accepted problem must not enter Alice's evidence.
      submission(p2.ref, 'b1', 'accepted', OTHER_ACCOUNT),
      submission(p3.ref, 'c1', 'wrong_answer'),
    ],
    decisions: [tagDecision(p1, 'ds.stack')],
    retrospectives: [
      retrospective(p2.ref, 'independent', ['ds.stack'], AT, OTHER_ACCOUNT),
      retrospective(p3.ref, 'independent', ['ds.stack'], AT),
      retrospective(p1.ref, 'independent', ['ds.queue'], AT),
    ],
  });

  assert.equal(
    report.coverage.attemptedDistinctTotal,
    2,
    'the foreign accepted submission is not one of this account attempts',
  );
  assert.equal(report.coverage.solvedDistinctTotal, 1);
  assert.equal(report.coverage.relatedAttemptedDistinct, 1, 'only the problem with real evidence is related');
  assert.equal(nodeOf(report, 'ds.stack').verifiedAttemptedDistinct, 1);
  assert.equal(
    nodeOf(report, 'ds.stack').retrospectiveIndependentDistinct,
    0,
    'another account AC plus another account retrospective is not this account evidence',
  );
  assert.equal(nodeOf(report, 'ds.queue').retrospectiveIndependentDistinct, 1);
  assert.equal(report.coverage.retrospectiveProblemDistinct, 1, 'a retrospective on a non-AC problem is no evidence');
  assert.equal(nodeOf(report, 'ds.stack').status, 'unconfirmed');
  assert.equal(nodeOf(report, 'ds.queue').status, 'practicing');
  assert.equal(JSON.stringify(report).includes(OTHER_ACCOUNT), false, 'a foreign account never appears in the report');
});

void test('unknown ids and unknown labels are reported honestly, never fabricated', () => {
  const p1 = problem('P1', { rawTags: ['splay tree', 'codeforces', '2021', 'C++', '**'] });
  const p2 = problem('P2', { rawTags: ['splay tree', 'dynamic programming?'] });
  const report = run({
    problems: [p1, p2],
    submissions: [submission(p1.ref, 'a1', 'accepted'), submission(p2.ref, 'b1', 'wrong_answer')],
    decisions: [tagDecision(p1, 'not.a.real.id')],
    retrospectives: [retrospective(p1.ref, 'independent', ['also.unknown'], AT)],
  });

  assert.deepEqual(report.unmatchedAlgorithmLabels, ['dynamic programming?', 'splay tree']);
  assert.equal(report.coverage.unmatchedAlgorithmProblemDistinct, 2);
  assert.equal(report.nodes.every((entry) => entry.observedRelatedDistinct === 0), true);
  assert.equal(report.nodes.some((entry) => entry.taxonomyId.includes('unknown')), false);
  assert.equal(
    report.coverage.retrospectiveProblemDistinct,
    1,
    'a recorded retrospective is still counted in coverage even when its ids are unknown',
  );
  assert.equal(report.unmatchedAlgorithmLabels.includes('codeforces'), false);
  assert.equal(report.unmatchedAlgorithmLabels.includes('2021'), false);
  assert.equal(report.unmatchedAlgorithmLabels.includes('C++'), false);
  assert.equal(report.unmatchedAlgorithmLabels.includes('**'), false);
});

void test('ratings stay in native dimensions and every independent problem is accounted for', () => {
  const p1 = problem('P1', { ratings: [rating(1800), rating(2400)] });
  const p2 = problem('P2', { ratings: [rating(7, 'difficulty')] });
  // A GHOST problem has an accepted submission and a retrospective but no metadata row at all.
  const ghost: ProblemRef = { sourceInstanceId: INSTANCE, domain: null, externalKey: 'GHOST' };
  const report = run({
    problems: [p1, p2],
    submissions: [
      submission(p1.ref, 'a1', 'accepted'),
      submission(p2.ref, 'b1', 'accepted'),
      submission(ghost, 'g1', 'accepted'),
    ],
    retrospectives: [
      retrospective(p1.ref, 'independent', ['ds.stack'], AT),
      retrospective(p2.ref, 'independent', ['ds.stack'], AT),
      retrospective(ghost, 'independent', ['ds.stack'], AT),
    ],
  });

  const stack = nodeOf(report, 'ds.stack');
  assert.equal(stack.retrospectiveIndependentDistinct, 3);
  assert.deepEqual(stack.independentRatingRanges, [
    { dimension: 'difficulty', count: 1, missing: 2, min: 7, max: 7 },
    { dimension: 'rating', count: 1, missing: 2, min: 1800, max: 1800 },
  ]);
  for (const range of stack.independentRatingRanges) {
    assert.equal(
      range.count + range.missing,
      stack.retrospectiveIndependentDistinct,
      'each dimension accounts for every independently confirmed problem',
    );
  }
  assert.equal(stack.platformAttemptedDistinct, 0, 'no raw tag was reported');
  assert.equal(stack.status, 'practicing');
});

void test('raw-tag resolution is source-aware and reports every distinct mapping', () => {
  const p1 = problem('K1', { rawTags: ['栈', 'hash', 'codeforces', '2021', '**'] });
  const report = run({ problems: [p1], submissions: [submission(p1.ref, 'k1', 'accepted')] });

  assert.equal(report.tagMappingVersion, TAG_MAPPING_VERSION);
  const byRaw = new Map(report.sourceTagMappings.map((entry) => [entry.raw, entry]));
  assert.equal(byRaw.size, 5);

  const stack = byRaw.get('栈');
  assert.ok(stack);
  assert.equal(stack.sourceInstanceId, INSTANCE);
  assert.equal(stack.vocabulary, 'codeforces');
  assert.equal(stack.relation, 'exact');
  assert.deepEqual(stack.targetIds, ['ds.stack']);
  assert.equal(stack.attemptedDistinct, 1);
  assert.equal(stack.solvedDistinct, 1);
  assert.equal(stack.mappingVersion, TAG_MAPPING_VERSION);
  assert.equal(stack.taxonomyVersion, 'test.09a.1');

  const hash = byRaw.get('hash');
  assert.ok(hash);
  assert.equal(hash.relation, 'ambiguous', 'hash is not counted as string hashing');
  assert.deepEqual(hash.targetIds, []);
  assert.deepEqual(report.unmatchedAlgorithmLabels, ['hash'], 'only an unresolved algorithm label is a gap');
  assert.equal(report.coverage.unmatchedAlgorithmProblemDistinct, 1);

  assert.equal(byRaw.get('codeforces')?.relation, 'non_algorithm');
  assert.equal(byRaw.get('2021')?.relation, 'non_algorithm');
  assert.equal(byRaw.get('**')?.relation, 'non_algorithm');

  const stackNode = nodeOf(report, 'ds.stack');
  assert.equal(stackNode.platformAttemptedDistinct, 1);
  assert.equal(stackNode.platformSolvedDistinct, 1);
  assert.equal(isDeeplyFrozen(report.sourceTagMappings), true);
  assert.equal(
    report.notes.includes('source_label_mapping_is_provisional_platform_evidence_not_a_recorded_method'),
    true,
  );
});

void test('diagnostic counts dedupe per source label and per distinct problem', () => {
  const p1 = problem('P1', { rawTags: ['栈', 'stack'] });
  const p2 = problem('P2', { rawTags: ['栈'] });
  const report = run({
    problems: [p1, p2],
    submissions: [
      submission(p1.ref, 'a1', 'accepted'),
      submission(p1.ref, 'a2', 'accepted'),
      submission(p2.ref, 'b1', 'wrong_answer'),
    ],
  });

  const stackMappings = report.sourceTagMappings.filter((entry) => entry.targetIds.includes('ds.stack'));
  assert.deepEqual(
    stackMappings.map((entry) => entry.raw),
    ['stack', '栈'],
    'two different labels stay two rows even when they share a target',
  );
  assert.deepEqual(
    stackMappings.map((entry) => [entry.raw, entry.attemptedDistinct, entry.solvedDistinct]),
    [
      ['stack', 1, 1],
      ['栈', 2, 1],
    ],
  );

  const stack = nodeOf(report, 'ds.stack');
  assert.equal(stack.platformAttemptedDistinct, 2, 'repeated submissions of one problem never inflate a count');
  assert.equal(stack.platformSolvedDistinct, 1);
  assert.equal(stack.observedRelatedDistinct, 2);
});

void test('the same raw text from two source instances stays two mappings', () => {
  const cfProblem = problem('C1', { rawTags: ['栈'] });
  const luoguRef: ProblemRef = { sourceInstanceId: 'luogu:www.luogu.com.cn', domain: null, externalKey: 'L1' };
  const luoguProblem = createNormalizedProblem({
    ref: luoguRef,
    title: 'Luogu L1',
    url: 'https://www.luogu.com.cn/problem/L1',
    statement: null,
    fetchedAt: AT,
    rawTags: ['栈', 'luogu-tag:42'],
  });
  const report = run({
    problems: [cfProblem, luoguProblem],
    submissions: [submission(cfProblem.ref, 'c1', 'accepted'), submission(luoguRef, 'l1', 'accepted')],
  });

  const sameRaw = report.sourceTagMappings.filter((entry) => entry.raw === '栈');
  assert.equal(sameRaw.length, 2, 'one raw text from two instances stays two mappings');
  assert.deepEqual(
    sameRaw.map((entry) => entry.sourceInstanceId),
    ['codeforces:codeforces.com', 'luogu:www.luogu.com.cn'],
  );
  assert.deepEqual(
    sameRaw.map((entry) => entry.vocabulary),
    ['codeforces', 'luogu'],
  );
  assert.deepEqual(
    sameRaw.map((entry) => [entry.attemptedDistinct, entry.solvedDistinct]),
    [
      [1, 1],
      [1, 1],
    ],
  );

  const numeric = report.sourceTagMappings.find((entry) => entry.raw === 'luogu-tag:42');
  assert.ok(numeric);
  assert.equal(numeric.relation, 'reference');
  assert.equal(numeric.vocabulary, 'luogu');
  assert.equal(report.unmatchedAlgorithmLabels.includes('luogu-tag:42'), false, 'a platform id is no algorithm gap');

  const stack = nodeOf(report, 'ds.stack');
  assert.equal(stack.platformAttemptedDistinct, 2);
  assert.equal(stack.platformSolvedDistinct, 2);
  assert.equal(stack.verifiedAttemptedDistinct, 0, 'a raw mapping never becomes a verified decision');
  assert.equal(stack.retrospectiveIndependentDistinct, 0, 'a raw mapping never becomes self-reported method evidence');
  assert.equal(stack.status, 'unconfirmed');
  assert.equal(isDeeplyFrozen(report), true);
});

void test('composite constituents and platform references are honest coverage gaps', () => {
  const luoguRef: ProblemRef = { sourceInstanceId: 'luogu:www.luogu.com.cn', domain: null, externalKey: 'L2' };
  const entry = createNormalizedProblem({
    ref: luoguRef,
    title: 'Luogu L2',
    url: 'https://www.luogu.com.cn/problem/L2',
    statement: null,
    fetchedAt: AT,
    rawTags: ['并查集', '单调队列', 'luogu-tag:7'],
  });
  const report = run({ problems: [entry], submissions: [submission(luoguRef, 'l2', 'accepted')] });

  assert.equal(nodeOf(report, 'ds.dsu').platformAttemptedDistinct, 1, 'a plain synonym still counts');
  assert.deepEqual(
    report.unmatchedAlgorithmLabels,
    ['单调队列'],
    'a constituent of the frozen monotonic stack/queue node is not silently counted',
  );
  assert.equal(report.coverage.unmatchedAlgorithmProblemDistinct, 1);
  assert.equal(report.sourceTagMappings.find((mapping) => mapping.raw === 'luogu-tag:7')?.relation, 'reference');
  assert.equal(
    report.nodes.some((node) => node.taxonomyId.includes('monotonic')),
    false,
    'no taxonomy node was invented for the constituent',
  );
});

void test('an empty report still carries the crosswalk version with zero mappings', () => {
  const report = run({ problems: [], submissions: [] });
  assert.equal(report.tagMappingVersion, TAG_MAPPING_VERSION);
  assert.deepEqual(report.sourceTagMappings, []);
});
