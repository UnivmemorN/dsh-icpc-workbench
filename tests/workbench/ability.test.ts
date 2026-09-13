/**
 * Ability assessment through the real `WorkbenchService` (Sprint 11a).
 *
 * Every case drives the real service against a temporary `SqliteTrainingStore`; nothing reaches a
 * platform, a model or the network. The assertions cover externally meaningful behaviour: the
 * additive `ability` field is exactly the pure domain reduction over the same evidence, another
 * account's accepted submissions never describe the selected account, the projection adds no store
 * read at all, and the response stays JSON-serializable.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type { TrainingStore } from '../../src/application/ports.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  computeAbilityAssessment,
  createCancellationSource,
  createNormalizedProblem,
  createTaxonomyIndex,
  type NormalizedProblem,
  type PlatformRating,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const NOW = '2026-11-01T08:00:00.000Z';
const RECENT = '2026-10-01T08:00:00.000Z';
const TOKEN = createCancellationSource().token;

const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);

/** A rated problem of the bench's source instance, with a controlled rating value. */
function problem(scope: fx.Scope, externalKey: string, value: number): NormalizedProblem {
  const rating: PlatformRating = { dimension: 'rating', value, scale: null, raw: String(value) };
  return createNormalizedProblem({
    ref: fx.makeRef(scope.instance, externalKey),
    title: `Problem ${externalKey}`,
    url: `https://codeforces.com/problemset/problem/${externalKey}`,
    statement: null,
    fetchedAt: NOW,
    ratings: [rating],
  });
}

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly service: WorkbenchService;
}

async function withBench(
  run: (bench: Bench) => Promise<void>,
  wrap: (store: SqliteTrainingStore) => TrainingStore = (store) => store,
): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => NOW });
  let minted = 0;
  const service = new WorkbenchService({
    store: wrap(store),
    taxonomy: TAXONOMY,
    now: () => NOW,
    uniqueId: () => `id-${(minted += 1)}`,
  });
  try {
    await run({ store, service });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

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

void test('weakness exposes the ability assessment of exactly the same evidence', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P0');
    const problems = [0, 1, 2, 3, 4].map((index) => problem(scope, `P${index + 1}`, 1200 + index * 100));
    const submissions = problems.map((entry, index) =>
      fx.makeSubmission(scope.account, entry.ref, `S${index + 1}`, 'accepted', RECENT),
    );
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems(problems);
    await store.upsertSubmissions(submissions);
    for (const entry of problems) {
      await service.recordRetrospective(
        { problemKey: entry.key, accountId: scope.account.id, mode: 'independent' },
        TOKEN,
      );
    }
    const retrospectives = await store.listRetrospectives(scope.account.id);

    const result = await service.weakness({ accountId: scope.account.id }, TOKEN);

    const direct = computeAbilityAssessment({
      accountId: scope.account.id,
      sourceInstanceId: scope.instance.id,
      platform: 'codeforces',
      problems,
      submissions,
      retrospectives,
      now: NOW,
    });
    assert.deepEqual(result.ability, direct, 'the service projects exactly the pure domain reduction');
    assert.equal(result.ability.accountId, scope.account.id);
    assert.equal(result.ability.sourceInstanceId, scope.instance.id);
    assert.equal(result.ability.estimate.status, 'estimated');
    assert.equal(result.ability.estimate.baselineTrainingLevel, 1400, 'median of 1200..1600 rounded to 100');
    assert.equal(result.ability.estimate.sampleSize, 5);
    assert.equal(Object.hasOwn(result.report, 'ability'), false, 'the formal report is untouched');
    assert.deepEqual(JSON.parse(JSON.stringify(result.ability)), result.ability);
  });
});

void test('another account is isolated and the ability projection adds no store read', async () => {
  const counts: ReadCounts = { listSubmissions: 0, listProblems: 0, getProblem: 0, getSourceInstance: 0 };
  await withBench(
    async ({ store, service }) => {
      const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P0');
      const bob = fx.makeAccount(scope.instance, 'bob');
      const aliceProblems = [0, 1, 2].map((index) => problem(scope, `A${index + 1}`, 1200 + index * 100));
      const bobProblem = problem(scope, 'B1', 2400);
      await store.upsertSourceInstances([scope.instance]);
      await store.upsertAccounts([scope.account, bob]);
      await store.upsertProblems([...aliceProblems, bobProblem]);
      await store.upsertSubmissions([
        ...aliceProblems.map((entry, index) =>
          fx.makeSubmission(scope.account, entry.ref, `A${index + 1}`, 'accepted', RECENT),
        ),
        fx.makeSubmission(bob, bobProblem.ref, 'B1', 'accepted', RECENT),
      ]);

      const aliceResult = await service.weakness({ accountId: scope.account.id }, TOKEN);
      assert.equal(aliceResult.ability.counts.solvedDistinct, 3, "bob's solve never describes alice");
      assert.equal(aliceResult.ability.estimate.status, 'unknown', 'three samples stay below the gate');

      const bobResult = await service.weakness({ accountId: bob.id }, TOKEN);
      assert.equal(bobResult.ability.counts.solvedDistinct, 1);
      assert.equal(bobResult.ability.estimate.status, 'unknown');
    },
    (real) => countingStore(real, counts),
  );

  assert.equal(counts.listSubmissions, 2, 'one bounded submission walk per weakness call');
  assert.equal(counts.listProblems, 0, 'the ability projection never pages the bank');
  assert.equal(counts.getProblem, 4, 'one metadata read per distinct attempted problem');
  assert.equal(counts.getSourceInstance, 2, 'the source label read is not repeated');
});
