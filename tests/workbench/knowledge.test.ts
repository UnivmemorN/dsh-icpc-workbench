/**
 * Knowledge learning evidence through the real `WorkbenchService` (Sprint 09a).
 *
 * Every case drives the real service against a temporary `SqliteTrainingStore`; nothing reaches a
 * platform, a model or the network. The assertions cover externally meaningful behaviour: the
 * additive `knowledge` field exists while the formal report is byte-identical to a direct domain
 * reduction, stale AI output is dropped and the latest manual rejection wins, an AC alone never
 * confirms a method, the five-sample formal gate keeps steering plans, another account's history is
 * refused, the projection performs no extra evidence read, and cancellation still wins.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type { TrainingStore } from '../../src/application/ports.js';
import { WORKBENCH_MIN_WEAKNESS_SAMPLE, WorkbenchService } from '../../src/application/workbench-service.js';
import {
  DomainError,
  computeWeaknessReports,
  createCancellationSource,
  createNormalizedProblem,
  createTagDecision,
  createTaxonomy,
  createTaxonomyIndex,
  isDeeplyFrozen,
  reportForAccount,
  type KnowledgeEvidenceReport,
  type KnowledgeNodeEvidence,
  type NormalizedProblem,
  type PlatformRating,
  type TaxonomyNode,
  type TaxonomyNodeKind,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const TOKEN = createCancellationSource().token;

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

const TAXONOMY = createTaxonomyIndex(
  createTaxonomy({
    version: 'test.09a.1',
    nodes: [
      node('ds', null, 'category', 'Data structures', '数据结构'),
      node('ds.stack', 'ds', 'technique', 'Stack', '栈', ['stack', '栈']),
      node('ds.queue', 'ds', 'technique', 'Queue', '队列', ['queue']),
      node('ds.dsu', 'ds', 'technique', 'Disjoint set union', '并查集', ['dsu']),
    ],
  }),
);

/** Sprint 32 bridge catalog: the bundled Luogu dictionary names must resolve to these nodes. */
const BRIDGE_TAXONOMY = createTaxonomyIndex(
  createTaxonomy({
    version: 'test.32.bridge.1',
    nodes: [
      node('ds', null, 'category', 'Data structures', '数据结构'),
      node('ds.bit', 'ds', 'technique', 'Fenwick tree', '树状数组', ['fenwick', '树状数组']),
      node('dp', null, 'category', 'Dynamic programming', '动态规划'),
    ],
  }),
);

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly service: WorkbenchService;
}

async function withBench(
  run: (bench: Bench) => Promise<void>,
  wrap: (store: SqliteTrainingStore) => TrainingStore = (store) => store,
  taxonomy: typeof TAXONOMY = TAXONOMY,
): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  let minted = 0;
  const service = new WorkbenchService({
    store: wrap(store),
    taxonomy,
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

function rating(value: number, dimension = 'rating'): PlatformRating {
  return { dimension, value, scale: null, raw: String(value) };
}

/** A problem of the bench's source instance with explicitly chosen ratings/raw tags. */
function problem(
  scope: fx.Scope,
  externalKey: string,
  options: { readonly ratings?: readonly PlatformRating[]; readonly rawTags?: readonly string[] } = {},
): NormalizedProblem {
  return createNormalizedProblem({
    ref: { sourceInstanceId: scope.instance.id, domain: null, externalKey },
    title: `Problem ${externalKey}`,
    url: `https://codeforces.com/problemset/problem/${externalKey}`,
    statement: null,
    fetchedAt: AT,
    ratings: options.ratings ?? [],
    rawTags: options.rawTags ?? [],
  });
}

function nodeOf(knowledge: KnowledgeEvidenceReport, taxonomyId: string): KnowledgeNodeEvidence {
  const found = knowledge.nodes.find((entry) => entry.taxonomyId === taxonomyId);
  assert.ok(found, `taxonomy node ${taxonomyId} is missing from the knowledge report`);
  return found;
}

async function rejectsDomain(action: () => Promise<unknown>, code: string): Promise<DomainError> {
  let failure: unknown = null;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof DomainError, `expected a ${code} DomainError, got ${String(failure)}`);
  assert.equal(failure.code, code);
  return failure;
}

void test('weakness returns the knowledge report beside an unchanged formal report', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const p1 = problem(scope, 'P1', { ratings: [rating(1800)], rawTags: ['stack'] });
    const p2 = problem(scope, 'P2');
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([p1, p2]);
    const submissions = [
      fx.makeSubmission(scope.account, p1.ref, 'A1', 'accepted'),
      fx.makeSubmission(scope.account, p1.ref, 'A2', 'wrong_answer'),
      fx.makeSubmission(scope.account, p2.ref, 'B1', 'wrong_answer'),
    ];
    await store.upsertSubmissions(submissions);
    const decisions = [
      createTagDecision({
        problemKey: p1.key,
        taxonomyId: 'ds.stack',
        status: 'accepted',
        origin: 'manual',
        decidedAt: AT,
        reasons: ['manual_accept'],
      }),
    ];
    await store.saveTagDecisions(decisions);
    await service.recordRetrospective(
      { problemKey: p1.key, accountId: scope.account.id, mode: 'independent', taxonomyIds: ['ds.stack'] },
      TOKEN,
    );
    const retrospectives = await store.listRetrospectives(scope.account.id);

    const result = await service.weakness({ accountId: scope.account.id }, TOKEN);

    // The formal report is exactly what the pure domain reduction over the same stored evidence
    // produces: the additive knowledge field changes nothing about weakness or plan evidence.
    const direct = reportForAccount(
      computeWeaknessReports({
        problems: [p1, p2],
        submissions,
        decisions,
        retrospectives,
        settings: { minDistinctProblems: WORKBENCH_MIN_WEAKNESS_SAMPLE, ratingDimension: null },
        accountIds: [scope.account.id],
      }),
      scope.account.id,
    );
    assert.deepEqual(result.report, direct, 'the formal report is unchanged by the knowledge field');
    assert.equal(Object.hasOwn(result.report, 'knowledge'), false);

    assert.deepEqual(result.knowledge.difficultyBands.map(b => [b.band.value, b.coverage.attemptedDistinctTotal]), [[1800, 1], [null, 1]]);
    assert.equal(result.knowledge.difficultyBands[0]!.nodes.find(n => n.taxonomyId === 'ds.stack')!.retrospectiveIndependentDistinct, 1);
    assert.deepEqual(result.knowledge.difficultyBands[1]!.nodes, [], 'unknown attempted problem has no fabricated method evidence');
    assert.equal(result.knowledge.accountId, scope.account.id);
    assert.equal(result.knowledge.taxonomyVersion, 'test.09a.1');
    assert.equal(result.knowledge.minimumIndependentProblems, WORKBENCH_MIN_WEAKNESS_SAMPLE);
    assert.equal(result.knowledge.nodes.length, TAXONOMY.ids.length, 'every catalog node is reported');
    const stack = nodeOf(result.knowledge, 'ds.stack');
    assert.equal(stack.platformAttemptedDistinct, 1);
    assert.equal(stack.platformSolvedDistinct, 1);
    assert.equal(stack.verifiedAttemptedDistinct, 1);
    assert.equal(stack.verifiedSolvedDistinct, 1);
    assert.equal(stack.retrospectiveIndependentDistinct, 1);
    assert.equal(stack.status, 'practicing');
    assert.deepEqual(stack.independentRatingRanges, [
      { dimension: 'rating', count: 1, missing: 0, min: 1800, max: 1800 },
    ]);
    const ds = nodeOf(result.knowledge, 'ds');
    assert.equal(ds.status, 'category_summary');
    assert.equal(ds.descendantTechniqueNodes, 3);
    assert.equal(ds.descendantTechniqueNodesWithIndependentEvidence, 1);
    assert.equal(isDeeplyFrozen(result.knowledge), true);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the additive DTO stays JSON-serializable');
  });
});

void test('stale AI output is excluded at the service and the latest manual rejection wins', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const p1 = problem(scope, 'P1');
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([p1]);
    await store.upsertSubmissions([fx.makeSubmission(scope.account, p1.ref, 'A1', 'accepted')]);
    // An AI adoption pinned to a snapshot that is not this problem's stored head: dropped, so it
    // can never become verified knowledge evidence.
    await store.saveTagDecisions([
      createTagDecision({
        problemKey: p1.key,
        taxonomyId: 'ds.queue',
        status: 'auto_adopted',
        origin: 'ai',
        decidedAt: AT,
        reasons: ['evidence_verified'],
        snapshotId: `${p1.key}@deadbeef:v1`,
        snapshotVersion: 1,
      }),
    ]);

    const stale = await service.weakness({ accountId: scope.account.id }, TOKEN);
    assert.equal(stale.coverage.staleAiDecisionsExcluded, 1);
    assert.equal(nodeOf(stale.knowledge, 'ds.queue').verifiedAttemptedDistinct, 0);
    assert.equal(nodeOf(stale.knowledge, 'ds.queue').status, 'not_observed');

    await service.reviewTag({ problemKey: p1.key, taxonomyId: 'ds.queue', action: 'accept' }, TOKEN);
    const accepted = await service.weakness({ accountId: scope.account.id }, TOKEN);
    assert.equal(nodeOf(accepted.knowledge, 'ds.queue').verifiedAttemptedDistinct, 1);
    assert.equal(
      nodeOf(accepted.knowledge, 'ds.queue').status,
      'unconfirmed',
      'a verified tag alone is still not a recorded method',
    );

    await service.reviewTag({ problemKey: p1.key, taxonomyId: 'ds.queue', action: 'reject' }, TOKEN);
    const rejected = await service.weakness({ accountId: scope.account.id }, TOKEN);
    assert.equal(nodeOf(rejected.knowledge, 'ds.queue').verifiedAttemptedDistinct, 0);
    assert.equal(nodeOf(rejected.knowledge, 'ds.queue').status, 'not_observed');
  });
});

void test('AC alone never confirms a method and the five-sample formal gate keeps steering plans', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const problems = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((key) => problem(scope, key));
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems(problems);
    await store.upsertSubmissions(
      problems.map((entry, index) => fx.makeSubmission(scope.account, entry.ref, `S${index}`, 'accepted')),
    );
    for (const entry of problems.slice(0, 5)) {
      await service.recordRetrospective(
        { problemKey: entry.key, accountId: scope.account.id, mode: 'independent', taxonomyIds: ['ds.stack'] },
        TOKEN,
      );
    }

    const result = await service.weakness({ accountId: scope.account.id }, TOKEN);
    const stack = nodeOf(result.knowledge, 'ds.stack');
    assert.equal(stack.retrospectiveIndependentDistinct, 5);
    assert.equal(stack.platformAttemptedDistinct, 0);
    assert.equal(stack.verifiedAttemptedDistinct, 0);
    assert.equal(stack.status, 'independent_evidence');
    assert.equal(result.knowledge.coverage.retrospectiveProblemDistinct, 5);
    assert.equal(result.report.solvedDistinctTotal, 6, 'the sixth AC-only problem is solved, not mastered');
    assert.equal(result.report.taggedAttemptedDistinct, 0);
    assert.deepEqual(result.report.ranking, [], 'no effective tag exists, so the formal ranking stays empty');
    assert.deepEqual(result.report.insufficientEvidence, []);
  });
});

void test('knowledge stays inside the selected account and needs a real accepted submission', async () => {
  await withBench(async ({ store, service }) => {
    const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const bob = fx.makeAccount(alice.instance, 'bob');
    const aliceSolved = problem(alice, 'P1');
    const aliceRejected = problem(alice, 'P2');
    const bobSolved = problem(alice, 'B1');
    await store.upsertSourceInstances([alice.instance]);
    await store.upsertAccounts([alice.account, bob]);
    await store.upsertProblems([aliceSolved, aliceRejected, bobSolved]);
    await store.upsertSubmissions([
      fx.makeSubmission(alice.account, aliceSolved.ref, 'A1', 'accepted'),
      fx.makeSubmission(alice.account, aliceRejected.ref, 'A2', 'wrong_answer'),
      fx.makeSubmission(bob, bobSolved.ref, 'B1', 'accepted'),
    ]);
    await service.recordRetrospective(
      { problemKey: bobSolved.key, accountId: bob.id, mode: 'independent', taxonomyIds: ['ds.stack'] },
      TOKEN,
    );
    await service.recordRetrospective(
      { problemKey: aliceRejected.key, accountId: alice.account.id, mode: 'independent', taxonomyIds: ['ds.stack'] },
      TOKEN,
    );

    const aliceResult = await service.weakness({ accountId: alice.account.id }, TOKEN);
    assert.equal(aliceResult.knowledge.coverage.attemptedDistinctTotal, 2);
    assert.equal(aliceResult.knowledge.coverage.solvedDistinctTotal, 1);
    assert.equal(
      aliceResult.knowledge.coverage.retrospectiveProblemDistinct,
      0,
      'a retrospective on a problem without an AC is not skill evidence',
    );
    assert.equal(nodeOf(aliceResult.knowledge, 'ds.stack').retrospectiveIndependentDistinct, 0);
    assert.equal(nodeOf(aliceResult.knowledge, 'ds.stack').status, 'not_observed');

    const bobResult = await service.weakness({ accountId: bob.id }, TOKEN);
    assert.equal(bobResult.knowledge.coverage.attemptedDistinctTotal, 1);
    assert.equal(nodeOf(bobResult.knowledge, 'ds.stack').retrospectiveIndependentDistinct, 1);
    assert.equal(nodeOf(bobResult.knowledge, 'ds.stack').status, 'practicing');
  });
});

interface ReadCounts {
  listSubmissions: number;
  listProblems: number;
  getProblem: number;
  getSourceInstance: number;
}

/** A real store that counts the reads one weakness call performs. */
function countingStore(real: SqliteTrainingStore, counts: ReadCounts): TrainingStore {
  const counted = new Set<keyof ReadCounts>(['listSubmissions', 'listProblems', 'getProblem', 'getSourceInstance']);
  return new Proxy(real as TrainingStore, {
    get(target, property, receiver) {
      if (typeof property === 'string' && counted.has(property as keyof ReadCounts)) {
        const key = property as keyof ReadCounts;
        return async (...args: unknown[]) => {
          counts[key] += 1;
          const method = Reflect.get(target, property, receiver) as (...callArgs: unknown[]) => Promise<unknown>;
          return method.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TrainingStore;
}

/**
 * A real store proxy that records every mutating call. The knowledge projection only shapes a
 * report, so a `weakness` call must never write a problem row, a submission, a tag decision or a
 * retrospective — the assertion on the recorded names proves it instead of trusting the source.
 */
function noWriteStore(real: SqliteTrainingStore, writes: string[]): TrainingStore {
  const mutating = /^(upsert|save|delete|set|clear|remove|replace|put|write|mark|touch)/iu;
  return new Proxy(real as TrainingStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property === 'string' && typeof value === 'function') {
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (mutating.test(property)) {
          return async (...args: unknown[]) => {
            writes.push(property);
            return bound(...args);
          };
        }
        return bound;
      }
      return value;
    },
  }) as TrainingStore;
}

void test('the knowledge projection reuses the single evidence read and cancellation still wins', async () => {
  const counts: ReadCounts = { listSubmissions: 0, listProblems: 0, getProblem: 0, getSourceInstance: 0 };
  await withBench(
    async ({ store, service }) => {
      const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
      const problems = ['P1', 'P2', 'P3'].map((key) => problem(scope, key));
      await store.upsertSourceInstances([scope.instance]);
      await store.upsertAccounts([scope.account]);
      await store.upsertProblems(problems);
      await store.upsertSubmissions(
        problems.map((entry, index) => fx.makeSubmission(scope.account, entry.ref, `S${index}`, 'accepted')),
      );

      const result = await service.weakness({ accountId: scope.account.id }, TOKEN);
      assert.equal(result.knowledge.coverage.attemptedDistinctTotal, 3);
      assert.equal(result.knowledge.coverage.solvedDistinctTotal, 3);
      assert.equal(result.knowledge.nodes.length, TAXONOMY.ids.length);
    },
    (real) => countingStore(real, counts),
  );

  assert.equal(counts.listSubmissions, 1, 'one submission page walk feeds every projection');
  assert.equal(counts.listProblems, 0, 'knowledge never pages the bank');
  assert.equal(counts.getProblem, 3, 'one metadata read per distinct attempted problem');
  assert.equal(counts.getSourceInstance, 1, 'the source label read is not repeated');

  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([problem(scope, 'P1')]);
    const cancelled = createCancellationSource();
    cancelled.cancel();
    const failure = await rejectsDomain(
      () => service.weakness({ accountId: scope.account.id }, cancelled.token),
      'cancelled',
    );
    assert.equal(failure.details['reason'], null, 'no evidence is read for a cancelled call');
  });
});

void test('numeric-only Luogu records bridge provisionally and no stored input is written', async () => {
  const writes: string[] = [];
  await withBench(
    async ({ store, service }) => {
      const scope = fx.makeScope('luogu', 'www.luogu.com.cn', 'alice', 'L1');
      const luoguProblem = (externalKey: string, rawTags: readonly string[], difficulty: number): NormalizedProblem =>
        createNormalizedProblem({
          ref: { sourceInstanceId: scope.instance.id, domain: null, externalKey },
          title: `Problem ${externalKey}`,
          url: `https://www.luogu.com.cn/problem/${externalKey}`,
          statement: null,
          fetchedAt: AT,
          ratings: [rating(difficulty, 'difficulty')],
          rawTags,
        });
      // Old stored rows carry nothing but the numeric id; the second row also stores the official
      // name, and the third stores a category id. All three must reach the provisional channel.
      const p1 = luoguProblem('L1', ['luogu-tag:53'], 3);
      const p2 = luoguProblem('L2', ['luogu-tag:53', '树状数组'], 3);
      const p3 = luoguProblem('L3', ['luogu-tag:3'], 7);
      await store.upsertSourceInstances([scope.instance]);
      await store.upsertAccounts([scope.account]);
      await store.upsertProblems([p1, p2, p3]);
      await store.upsertSubmissions([
        fx.makeSubmission(scope.account, p1.ref, 'L1a', 'accepted'),
        fx.makeSubmission(scope.account, p1.ref, 'L1b', 'accepted'),
        fx.makeSubmission(scope.account, p2.ref, 'L2a', 'accepted'),
        fx.makeSubmission(scope.account, p3.ref, 'L3a', 'wrong_answer'),
      ]);

      const result = await service.weakness({ accountId: scope.account.id }, TOKEN);

      const bit = nodeOf(result.knowledge, 'ds.bit');
      assert.equal(bit.platformAttemptedDistinct, 2, 'the id and the stored name count the problem once');
      assert.equal(bit.platformSolvedDistinct, 2, 'a repeated accepted submission never inflates');
      assert.equal(bit.verifiedAttemptedDistinct, 0, 'a platform label never becomes a verified tag');
      assert.equal(bit.retrospectiveIndependentDistinct, 0, 'no retrospective was recorded');
      assert.equal(bit.status, 'unconfirmed');
      assert.equal(nodeOf(result.knowledge, 'dp').platformAttemptedDistinct, 1);
      assert.equal(nodeOf(result.knowledge, 'dp').platformSolvedDistinct, 0);
      assert.equal(result.knowledge.coverage.relatedAttemptedDistinct, 3);
      assert.equal(result.knowledge.coverage.verifiedAttemptedDistinct, 0);
      assert.deepEqual(result.knowledge.unmatchedAlgorithmLabels, [], 'the bridge leaves no coverage gap');

      const bridged = result.knowledge.sourceTagMappings.find((entry) => entry.raw === 'luogu-tag:53');
      assert.ok(bridged);
      assert.equal(bridged.relation, 'exact');
      assert.equal(bridged.ruleId, 'luogu.tag-id.53.shared.safe-exact');
      assert.equal(bridged.attemptedDistinct, 2);
      assert.equal(bridged.solvedDistinct, 2);
      const category = result.knowledge.sourceTagMappings.find((entry) => entry.raw === 'luogu-tag:3');
      assert.equal(category?.relation, 'broader');
      assert.deepEqual(category?.targetIds, ['dp']);

      // Native difficulty bands keep their own scoped counts and never borrow the total.
      const low = result.knowledge.difficultyBands.find((band) => band.band.value === 3);
      const high = result.knowledge.difficultyBands.find((band) => band.band.value === 7);
      assert.ok(low);
      assert.ok(high);
      assert.equal(low.nodes.find((entry) => entry.taxonomyId === 'ds.bit')?.platformAttemptedDistinct, 2);
      assert.equal(high.nodes.find((entry) => entry.taxonomyId === 'dp')?.platformAttemptedDistinct, 1);
      assert.equal(high.nodes.find((entry) => entry.taxonomyId === 'ds.bit') ?? null, null);

      // The projection shapes a report: the stored rows and every evidence channel stay untouched.
      assert.deepEqual(writes, [], 'weakness performs no write of any kind');
      assert.deepEqual(await store.getProblem(p1.key), p1, 'the stored id-only row is returned unchanged');
      assert.deepEqual(await store.listTagDecisions(p1.key), [], 'no tag decision was created');
      assert.deepEqual(await store.listRetrospectives(scope.account.id), [], 'no retrospective was created');
    },
    (real) => noWriteStore(real, writes),
    BRIDGE_TAXONOMY,
  );
});

void test('an unknown Codeforces raw label stays visible beside mapped tags and across bands', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'C1');
    const p1 = problem(scope, 'C1', { ratings: [rating(1600)], rawTags: ['stack', 'divide and conquer'] });
    const p2 = problem(scope, 'C2', { ratings: [rating(2200)], rawTags: ['divide and conquer'] });
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([p1, p2]);
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, p1.ref, 'C1a', 'accepted'),
      fx.makeSubmission(scope.account, p2.ref, 'C2a', 'wrong_answer'),
    ]);

    const result = await service.weakness({ accountId: scope.account.id }, TOKEN);

    const unknown = result.knowledge.sourceTagMappings.filter((entry) => entry.raw === 'divide and conquer');
    assert.equal(unknown.length, 1, 'one distinct raw label stays one diagnostic row');
    assert.equal(unknown[0]!.relation, 'unmapped');
    assert.equal(unknown[0]!.ruleId, 'codeforces.unmapped');
    assert.deepEqual(unknown[0]!.targetIds, []);
    assert.equal(unknown[0]!.attemptedDistinct, 2, 'both distinct problems carry the unknown label');
    assert.equal(unknown[0]!.solvedDistinct, 1, 'only the accepted problem counts as solved');
    assert.ok(unknown[0]!.explanation.length > 0, 'the diagnostic keeps its reason');

    const stack = nodeOf(result.knowledge, 'ds.stack');
    assert.equal(stack.platformAttemptedDistinct, 1, 'the unknown label blocks no mapped tag of the same problem');
    assert.equal(stack.platformSolvedDistinct, 1);
    assert.equal(stack.verifiedAttemptedDistinct, 0, 'no verified decision was provided');
    assert.equal(stack.retrospectiveIndependentDistinct, 0, 'no retrospective was provided');
    assert.equal(stack.status, 'unconfirmed');
    assert.deepEqual(result.knowledge.unmatchedAlgorithmLabels, ['divide and conquer']);
    assert.equal(result.knowledge.coverage.unmatchedAlgorithmProblemDistinct, 2);

    const low = result.knowledge.difficultyBands.find((band) => band.band.value === 1600);
    const high = result.knowledge.difficultyBands.find((band) => band.band.value === 2200);
    assert.ok(low);
    assert.ok(high);
    assert.equal(low.nodes.find((entry) => entry.taxonomyId === 'ds.stack')?.platformAttemptedDistinct, 1);
    assert.equal(
      high.nodes.find((entry) => entry.taxonomyId === 'ds.stack') ?? null,
      null,
      'the higher band has no mapped tag, so it fabricates no node evidence',
    );
  });
});
