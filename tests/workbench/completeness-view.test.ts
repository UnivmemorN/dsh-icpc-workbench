/**
 * Repair2 (Sprint 11b): the `problem.detail` projection must report a stored completeness check as
 * `current` only when it belongs to the reader's current taxonomy and to the analysis's own
 * snapshot. A check recorded under another taxonomy version stays visible history, but it never
 * looks like a passed check: the state is `outdated`.
 *
 * The store is the real SQLite adapter, so the projection is exercised over stored rows exactly as
 * a restarted workbench reads them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import {
  createAnalysisCompleteness,
  createAnalysisResult,
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  createProblemSnapshot,
  createTaxonomy,
  createTaxonomyIndex,
  type NormalizedProblem,
  type ProblemSnapshot,
  type Taxonomy,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const SEGMENT = 'data-structure.segment-tree';
const SOLUTION_TEXT = 'The editorial uses lazy propagation: range updates stay O(log n) with a segment tree.';

function makeTaxonomy(): Taxonomy {
  return createTaxonomy({
    version: 'test-v1',
    nodes: [
      {
        id: 'data-structure',
        parentId: null,
        kind: 'category',
        names: { en: 'Data structures', zh: '数据结构' },
        aliases: [],
        description: 'container techniques',
      },
      {
        id: SEGMENT,
        parentId: 'data-structure',
        kind: 'technique',
        names: { en: 'Segment tree', zh: '线段树' },
        aliases: ['segment tree'],
        description: 'range queries',
      },
    ],
  });
}

const TAXONOMY = makeTaxonomy();

interface ViewFixture {
  readonly store: SqliteTrainingStore;
  readonly service: WorkbenchService;
  readonly problem: NormalizedProblem;
  readonly snapshot: ProblemSnapshot;
}

async function withProblem(run: (fixture: ViewFixture) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const problem = createNormalizedProblem({
      ref: { sourceInstanceId: instance.id, domain: null, externalKey: '1A' },
      title: 'Problem 1A',
      url: 'https://codeforces.com/problem/1A',
      statement: 'Given an array, support range add and range sum queries.',
      fetchedAt: fx.AT,
      ratings: [{ dimension: 'rating', value: 1800, scale: { min: 800, max: 3500 }, raw: '1800' }],
      rawTags: ['data structures'],
    });
    const source = createEditorialSource({
      id: 'editorial-1',
      kind: 'editorial',
      url: 'https://editorial.example.org/1A',
      title: 'Editorial for 1A',
      availability: 'found',
      retrievedAt: fx.AT,
      text: SOLUTION_TEXT,
    });
    const solution = createEditorialSolution({
      solutionId: 'solution-1',
      sourceId: source.id,
      ordinal: 0,
      title: 'Lazy segment tree',
      text: SOLUTION_TEXT,
    });
    const snapshot = createProblemSnapshot({
      problem,
      sources: [source],
      solutions: [solution],
      capturedAt: fx.AT,
    });
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems([problem]);
    await store.saveSnapshot(snapshot);
    const service = new WorkbenchService({
      store,
      taxonomy: createTaxonomyIndex(TAXONOMY),
      now: () => fx.AT,
      uniqueId: () => 'view-1',
    });
    await run({ store, service, problem, snapshot });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

test('a completeness check of another taxonomy version is outdated, the current one is current', async () => {
  await withProblem(async ({ store, service, problem, snapshot }) => {
    const current = createAnalysisResult({
      problemRef: problem.ref,
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.version,
      taxonomyVersion: TAXONOMY.version,
      createdAt: fx.AT,
      status: 'completed',
      completeness: createAnalysisCompleteness({
        taxonomyVersion: TAXONOMY.version,
        snapshotId: snapshot.snapshotId,
        snapshotVersion: snapshot.version,
        checkedAt: fx.AT,
      }),
    });
    const foreign = createAnalysisResult({
      problemRef: problem.ref,
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.version,
      taxonomyVersion: 'old-taxonomy',
      createdAt: fx.LATER,
      status: 'completed',
      completeness: createAnalysisCompleteness({
        taxonomyVersion: 'old-taxonomy',
        snapshotId: snapshot.snapshotId,
        snapshotVersion: snapshot.version,
        checkedAt: fx.LATER,
      }),
    });
    await store.saveAnalysis(current);
    await store.saveAnalysis(foreign);

    const detail = await service.getProblem(
      { problemKey: problem.key, accountId: null, reveal: true },
      createCancellationSource().token,
    );
    const views = new Map((detail.analyses ?? []).map((analysis) => [analysis.analysisId, analysis]));
    assert.equal(views.get(current.analysisId)?.completeness?.state, 'current');
    assert.equal(views.get(foreign.analysisId)?.completeness?.state, 'outdated');
    // The foreign check is outdated by taxonomy version, not by staleness: it targets the head.
    assert.equal(views.get(foreign.analysisId)?.stale, false);
    assert.equal(views.get(foreign.analysisId)?.current, true);
  });
});
