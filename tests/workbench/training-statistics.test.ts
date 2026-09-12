/**
 * Provisional training statistics over a real SQLite store (Stage 07b).
 *
 * Every case drives the real `WorkbenchService` against a temporary `SqliteTrainingStore`; nothing
 * reaches a platform, a model or the network. The assertions cover externally meaningful behaviour:
 * a raw-label reference that exists while the formal ranking is empty, the exact per-dimension
 * totals against the formal solved count, metadata-missing history, account/source/domain
 * isolation, the single-evidence-read guard, and the guarantee that provisional numbers never
 * change the formal report or a plan.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type { TrainingStore } from '../../src/application/ports.js';
import { WORKBENCH_MIN_WEAKNESS_SAMPLE, WorkbenchService } from '../../src/application/workbench-service.js';
import type { WorkbenchWeaknessResult } from '../../src/application/workbench-types.js';
import {
  CURRENT_TAXONOMY,
  DomainError,
  createCancellationSource,
  createNormalizedProblem,
  createTagDecision,
  createTaxonomyIndex,
  type NormalizedProblem,
  type PlatformRating,
  type ProblemRef,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** An id that exists in the shipped vocabulary. */
const STACK = 'data-structure.stack';

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly service: WorkbenchService;
}

async function withBench(
  run: (bench: Bench) => Promise<void>,
  wrap: (store: SqliteTrainingStore) => TrainingStore = (store) => store,
): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  let minted = 0;
  const service = new WorkbenchService({
    store: wrap(store),
    taxonomy: TAXONOMY,
    now: () => AT,
    uniqueId: () => `id-${(minted += 1)}`,
  });
  try {
    await run({ store, service });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

function rating(value: number | string, dimension = 'rating'): PlatformRating {
  return { dimension, value, scale: null, raw: String(value) };
}

/** A problem with explicitly chosen ratings/tags; the fixtures always ship both. */
function problem(
  ref: ProblemRef,
  options: { readonly ratings?: readonly PlatformRating[]; readonly rawTags?: readonly string[] } = {},
): NormalizedProblem {
  return createNormalizedProblem({
    ref,
    title: `Problem ${ref.externalKey}`,
    url: `https://${ref.sourceInstanceId.split(':')[1] ?? 'example.org'}/problem/${ref.externalKey}`,
    statement: null,
    fetchedAt: AT,
    ratings: options.ratings ?? [],
    rawTags: options.rawTags ?? [],
  });
}

void test('raw labels and the solved distribution exist while the formal ranking stays empty', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const p2 = problem(fx.makeRef(scope.instance, 'P2'), { ratings: [rating(1200)], rawTags: ['Segment Tree', 'greedy'] });
    const p3 = problem(fx.makeRef(scope.instance, 'P3'), { ratings: [rating('unrated')], rawTags: ['segment tree'] });
    const p4 = problem(fx.makeRef(scope.instance, 'P4'), { ratings: [], rawTags: ['dp'] });
    const ghost = { sourceInstanceId: scope.instance.id, domain: null, externalKey: 'GHOST' };
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([scope.problem, p2, p3, p4]);
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, scope.problem.ref, 'A1', 'accepted'),
      fx.makeSubmission(scope.account, scope.problem.ref, 'A2', 'wrong_answer'),
      fx.makeSubmission(scope.account, p2.ref, 'B1', 'wrong_answer'),
      fx.makeSubmission(scope.account, p3.ref, 'C1', 'accepted'),
      fx.makeSubmission(scope.account, p4.ref, 'D1', 'wrong_answer'),
      fx.makeSubmission(scope.account, ghost, 'E1', 'accepted'),
    ]);

    const result = await service.weakness({ accountId: scope.account.id }, TOKEN);

    // Formal evidence is untouched: no adopted tag exists, so nothing is ranked, gated or hidden.
    assert.equal(result.report.attemptedDistinctTotal, 5);
    assert.equal(result.report.solvedDistinctTotal, 3);
    assert.equal(result.report.taggedAttemptedDistinct, 0);
    assert.deepEqual(result.report.ranking, []);
    assert.deepEqual(result.report.insufficientEvidence, []);

    // Provisional reference: distinct problems, case-insensitive labels, deterministic order.
    assert.equal(result.platformTagStats.verified, false);
    assert.equal(result.platformTagStats.minimumSampleSize, WORKBENCH_MIN_WEAKNESS_SAMPLE);
    assert.equal(result.platformTagStats.minimumSampleSize, 5);
    assert.equal(result.platformTagStats.attemptedTaggedDistinct, 4, 'a metadata-missing problem carries no label');
    assert.equal(result.platformTagStats.solvedTaggedDistinct, 2);
    assert.deepEqual(
      result.platformTagStats.tags.map((entry) => entry.rawTag),
      ['dp', 'greedy', 'segment tree', 'data structures'],
    );
    const segment = result.platformTagStats.tags.find((entry) => entry.rawTag === 'segment tree');
    assert.ok(segment);
    assert.equal(segment.attemptedDistinct, 3);
    assert.equal(segment.solvedDistinct, 2);
    assert.equal(segment.unconfirmedDistinct, 1);
    assert.equal(segment.solveRate, 2 / 3);
    assert.equal(segment.sufficientEvidence, false, 'a three-problem sample is marked insufficient, not hidden');
    assert.equal(result.platformTagStats.tags.every((entry) => entry.attemptedDistinct > 0), true);
    assert.deepEqual(
      Object.keys(segment).sort(),
      ['attemptedDistinct', 'rawTag', 'solveRate', 'solvedDistinct', 'sufficientEvidence', 'unconfirmedDistinct'],
      'a label row carries no per-problem mapping',
    );

    // Solved distribution: P1 1800, P3 unrated, GHOST without local metadata.
    const distribution = result.solvedDistribution;
    assert.equal(distribution.totalSolved, 3);
    assert.equal(distribution.totalSolved, result.report.solvedDistinctTotal);
    assert.equal(distribution.metadataMissingSolved, 1);
    assert.deepEqual(distribution.dimensions, [
      { dimension: 'rating', buckets: [{ value: 1800, count: 1 }], knownCount: 1, unknownCount: 2 },
    ]);
    for (const dimension of distribution.dimensions) {
      assert.equal(
        dimension.buckets.reduce((sum, bucket) => sum + bucket.count, 0) + dimension.unknownCount,
        result.report.solvedDistinctTotal,
        'every dimension accounts for every solved problem, missing metadata included',
      );
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the additive DTO is JSON-serializable as-is');
  });
});

void test('raw platform labels never enter the formal report, the ranking or a plan', async () => {
  interface Captured {
    readonly result: WorkbenchWeaknessResult;
    readonly sufficientTagIds: readonly string[];
  }
  const read = async (rawTags: readonly string[]): Promise<Captured> => {
    const captured: Captured[] = [];
    await withBench(async ({ store, service }) => {
      const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
      const p1 = problem(fx.makeRef(scope.instance, 'P1'), { ratings: [rating(1800)], rawTags });
      const p2 = problem(fx.makeRef(scope.instance, 'P2'), { ratings: [rating(1200)], rawTags: [] });
      await store.upsertSourceInstances([scope.instance]);
      await store.upsertAccounts([scope.account]);
      await store.upsertProblems([p1, p2]);
      await store.saveTagDecisions([
        createTagDecision({
          problemKey: p1.key,
          taxonomyId: STACK,
          status: 'accepted',
          origin: 'manual',
          decidedAt: AT,
          reasons: ['manual_accept'],
        }),
      ]);
      await store.upsertSubmissions([
        fx.makeSubmission(scope.account, p1.ref, 'A1', 'accepted'),
        fx.makeSubmission(scope.account, p2.ref, 'B1', 'wrong_answer'),
      ]);
      const result = await service.weakness({ accountId: scope.account.id }, TOKEN);
      const preview = await service.previewPlan(
        { accountId: scope.account.id, candidateProblemKeys: [p1.key] },
        TOKEN,
      );
      const sufficientTagIds = preview.outcome === 'draft' ? preview.plan.evidence.sufficientTagIds : preview.evidence.sufficientTagIds;
      captured.push({ result, sufficientTagIds });
    });
    const [only] = captured;
    assert.ok(only);
    return only;
  };

  const withTags = await read(['segment tree']);
  const withoutTags = await read([]);

  assert.equal(withTags.result.report.taggedAttemptedDistinct, 1, 'the manual decision is the formal evidence');
  assert.deepEqual(withTags.result.report, withoutTags.result.report, 'raw labels cannot change the formal report');
  assert.deepEqual(withTags.result.platformTagStats.tags.map((entry) => entry.rawTag), ['segment tree']);
  assert.deepEqual(withoutTags.result.platformTagStats.tags, []);
  assert.deepEqual(withTags.sufficientTagIds, withTags.result.report.ranking.map((tag) => tag.taxonomyId));
  assert.deepEqual(withTags.sufficientTagIds, [], 'the plan evidence still follows the five-sample formal gate');
});

void test('statistics stay inside one account, one source instance and one domain', async () => {
  await withBench(async ({ store, service }) => {
    const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const carol = fx.makeScope('codeforces', 'codeforces.com', 'carol', 'P7');
    const bob = fx.makeScope('luogu', 'luogu.com.cn', 'bob', 'Q1');
    // Same source instance, different domain: a distinct problem, never merged with P1.
    const aliceDiv2 = problem(fx.makeRef(alice.instance, 'P2', 'div2'), { ratings: [rating(2000)], rawTags: ['graphs'] });
    await store.upsertSourceInstances([alice.instance, bob.instance]);
    await store.upsertAccounts([alice.account, carol.account, bob.account]);
    await store.upsertProblems([alice.problem, aliceDiv2, carol.problem, bob.problem]);
    await store.upsertSubmissions([
      fx.makeSubmission(alice.account, alice.problem.ref, 'AL1', 'accepted'),
      fx.makeSubmission(alice.account, aliceDiv2.ref, 'AL2', 'accepted'),
      fx.makeSubmission(carol.account, carol.problem.ref, 'CA1', 'wrong_answer'),
      fx.makeSubmission(bob.account, bob.problem.ref, 'BO1', 'accepted'),
    ]);

    const aliceResult = await service.weakness({ accountId: alice.account.id }, TOKEN);
    const carolResult = await service.weakness({ accountId: carol.account.id }, TOKEN);
    const bobResult = await service.weakness({ accountId: bob.account.id }, TOKEN);

    assert.equal(aliceResult.report.attemptedDistinctTotal, 2);
    assert.equal(aliceResult.solvedDistribution.totalSolved, 2);
    assert.deepEqual(aliceResult.solvedDistribution.dimensions, [
      { dimension: 'rating', buckets: [{ value: 1800, count: 1 }, { value: 2000, count: 1 }], knownCount: 2, unknownCount: 0 },
    ]);
    assert.equal(carolResult.solvedDistribution.totalSolved, 0);
    assert.equal(aliceResult.platformTagStats.tags.some((entry) => entry.rawTag === 'graphs'), true);
    assert.equal(carolResult.platformTagStats.tags.some((entry) => entry.rawTag === 'graphs'), false);
    assert.equal(
      carolResult.platformTagStats.tags.some((entry) => entry.rawTag === 'segment tree'),
      true,
      'carol has her own raw labels',
    );

    // Luogu's expected dimension is `difficulty`; the fixture problem reports `rating`, so the
    // expected series must still exist as all-unknown while the observed one keeps the value.
    assert.equal(bobResult.solvedDistribution.totalSolved, 1);
    assert.deepEqual(bobResult.solvedDistribution.dimensions, [
      { dimension: 'difficulty', buckets: [], knownCount: 0, unknownCount: 1 },
      { dimension: 'rating', buckets: [{ value: 1800, count: 1 }], knownCount: 1, unknownCount: 0 },
    ]);
  });
});

interface ReadCounts {
  listSubmissions: number;
  listProblems: number;
  browseProblems: number;
  getProblem: number;
  getSourceInstance: number;
  readonly cursors: (string | null)[];
}

/** A real store that counts the reads one weakness call performs. */
function countingStore(real: SqliteTrainingStore, counts: ReadCounts): TrainingStore {
  return new Proxy(real as TrainingStore, {
    get(target, property, receiver) {
      if (property === 'listSubmissions') {
        return async (accountId: string, query: Parameters<TrainingStore['listSubmissions']>[1]) => {
          counts.listSubmissions += 1;
          counts.cursors.push(query.cursor);
          return target.listSubmissions(accountId, query);
        };
      }
      if (property === 'listProblems') {
        return async (...args: Parameters<TrainingStore['listProblems']>) => {
          counts.listProblems += 1;
          return target.listProblems(...args);
        };
      }
      if (property === 'browseProblems') {
        return async (...args: Parameters<TrainingStore['browseProblems']>) => {
          counts.browseProblems += 1;
          return target.browseProblems(...args);
        };
      }
      if (property === 'getProblem') {
        return async (...args: Parameters<TrainingStore['getProblem']>) => {
          counts.getProblem += 1;
          return target.getProblem(...args);
        };
      }
      if (property === 'getSourceInstance') {
        return async (...args: Parameters<TrainingStore['getSourceInstance']>) => {
          counts.getSourceInstance += 1;
          return target.getSourceInstance(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TrainingStore;
}

void test('the provisional statistics reuse the single evidence read and never walk the bank', async () => {
  const counts: ReadCounts = {
    listSubmissions: 0,
    listProblems: 0,
    browseProblems: 0,
    getProblem: 0,
    getSourceInstance: 0,
    cursors: [],
  };
  await withBench(
    async ({ store, service }) => {
      const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
      const p2 = problem(fx.makeRef(scope.instance, 'P2'), { ratings: [rating(1200)], rawTags: ['dp'] });
      const p3 = problem(fx.makeRef(scope.instance, 'P3'), { ratings: [rating('unrated')], rawTags: ['dp'] });
      await store.upsertSourceInstances([scope.instance]);
      await store.upsertAccounts([scope.account]);
      await store.upsertProblems([scope.problem, p2, p3]);
      await store.upsertSubmissions([
        fx.makeSubmission(scope.account, scope.problem.ref, 'A1', 'accepted'),
        fx.makeSubmission(scope.account, p2.ref, 'B1', 'wrong_answer'),
        fx.makeSubmission(scope.account, p3.ref, 'C1', 'wrong_answer'),
      ]);

      const result = await service.weakness({ accountId: scope.account.id }, TOKEN);
      assert.equal(result.solvedDistribution.totalSolved, 1);
      assert.equal(result.platformTagStats.tags.length > 0, true);
    },
    (real) => countingStore(real, counts),
  );

  assert.equal(counts.listSubmissions, 1, 'one submission page walk feeds every projection');
  assert.deepEqual(counts.cursors, [null]);
  assert.equal(counts.listProblems, 0, 'statistics never page the bank');
  assert.equal(counts.browseProblems, 0);
  assert.equal(counts.getProblem, 3, 'one metadata read per distinct attempted problem');
  assert.equal(counts.getSourceInstance, 1, 'one source read decides the raw dimension label');
});

void test('an account whose source instance row is gone is refused instead of guessing a dimension', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    // The account and its history exist, but the instance row the account names does not.
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([scope.problem]);
    await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'A1', 'accepted')]);

    let failure: DomainError | null = null;
    try {
      await service.weakness({ accountId: scope.account.id }, TOKEN);
    } catch (error) {
      failure = error instanceof DomainError ? error : null;
    }
    assert.ok(failure, 'a missing source instance must fail closed');
    assert.equal(failure.code, 'invalid_input');
    assert.equal(failure.details['reason'], 'source_instance_missing');
  });
});
