/**
 * Numbered problem-bank paging (Sprint Contract 06a) over a real SQLite store.
 *
 * Every case drives the real `WorkbenchService` and `SqliteTrainingStore`; no platform, model or
 * network is involved. The assertions cover the externally meaningful behaviour the contract asks
 * for: exact filtered totals over a bank larger than one page, a solved match beyond the first
 * unfiltered page, duplicate-AC de-duplication, account/source/domain isolation including an
 * incoherent cross-source stored row, filter intersections, literal wildcard search, empty and
 * clamped pages, hostile projections, malformed input and cancellation. A probe store proves the numbered path decides solved status in SQL — it never
 * walks submission history and never iterates cursor pages — and that the count and the selected
 * page come from one transaction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type { TrainingStore } from '../../src/application/ports.js';
import { WorkbenchService, type WorkbenchServiceOptions } from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  DomainError,
  createCancellationSource,
  createTaxonomyIndex,
  type DomainErrorCode,
  type NormalizedProblem,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** An id that exists in the shipped vocabulary; review-queue fixtures only store known tags. */
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
  const options: WorkbenchServiceOptions = {
    store: wrap(store),
    taxonomy: TAXONOMY,
    now: () => AT,
    uniqueId: () => `page-${(minted += 1)}`,
  };
  try {
    await run({ store, service: new WorkbenchService(options) });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

async function rejectsDomain(promise: Promise<unknown>, code: DomainErrorCode, reason?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (reason !== undefined) {
      assert.equal(error.details['reason'], reason);
    }
    return true;
  });
}

/** One source instance, two accounts and `count` problems whose canonical keys sort by index. */
function bank(count: number): {
  readonly instance: ReturnType<typeof fx.makeInstance>;
  readonly alice: ReturnType<typeof fx.makeAccount>;
  readonly bob: ReturnType<typeof fx.makeAccount>;
  readonly problems: readonly NormalizedProblem[];
} {
  const instance = fx.makeInstance('codeforces', 'codeforces.com');
  return {
    instance,
    alice: fx.makeAccount(instance, 'alice'),
    bob: fx.makeAccount(instance, 'bob'),
    problems: Array.from({ length: count }, (_, index) =>
      fx.makeProblem(fx.makeRef(instance, `P${String(index).padStart(3, '0')}`)),
    ),
  };
}

void test('numbered paging counts filtered unique problems and decides solved status in SQL', async () => {
  const { instance, alice, bob, problems } = bank(130);
  const solvedIndexes = [3, 50, 120];
  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([instance]);
    await store.upsertAccounts([alice, bob]);
    await store.upsertProblems(problems);
    await store.upsertSubmissions([
      // Duplicate AC and a later WA for the same problem: still exactly one solved problem.
      fx.makeSubmission(alice, (problems[3] as NormalizedProblem).ref, 'A1', 'accepted'),
      fx.makeSubmission(alice, (problems[3] as NormalizedProblem).ref, 'A2', 'accepted'),
      fx.makeSubmission(alice, (problems[3] as NormalizedProblem).ref, 'A3', 'wrong_answer', fx.LATER),
      fx.makeSubmission(alice, (problems[50] as NormalizedProblem).ref, 'A4', 'accepted'),
      fx.makeSubmission(alice, (problems[120] as NormalizedProblem).ref, 'A5', 'accepted'),
      fx.makeSubmission(bob, (problems[7] as NormalizedProblem).ref, 'B1', 'accepted'),
    ]);

    const first = await service.browseProblems({ sourceInstanceId: instance.id, page: 1, limit: 25 }, TOKEN);
    assert.equal(first.totalItems, 130);
    assert.equal(first.totalPages, 6);
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 25);
    assert.match(first.pageId, /^page-\d+$/, 'the injected uniqueId mints the page correlation id');
    assert.deepEqual(
      first.items.map((item) => item.problemKey),
      problems.slice(0, 25).map((problem) => problem.key),
      'rows are the first LIMIT keys in ascending key order',
    );
    assert.equal(
      first.items.some((item) => item.problemKey === (problems[120] as NormalizedProblem).key),
      false,
      'the solved match lies beyond the first unfiltered page, so only SQL filtering can find it',
    );

    const solved = await service.browseProblems(
      { sourceInstanceId: instance.id, accountId: alice.id, status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(solved.totalItems, 3, 'duplicate AC and the later WA still count one problem');
    assert.equal(solved.totalPages, 1);
    assert.deepEqual(
      solved.items.map((item) => item.problemKey),
      solvedIndexes.map((index) => (problems[index] as NormalizedProblem).key),
    );
    assert.deepEqual(solved.items.map((item) => item.solvedByAccount), [true, true, true]);
    assert.deepEqual(
      solved.items[0]?.rawTags,
      (problems[3] as NormalizedProblem).rawTags.map((tag) => tag.raw),
      'a solved row reveals its own tag material without an explicit reveal',
    );

    const bobSolved = await service.browseProblems(
      { sourceInstanceId: instance.id, accountId: bob.id, status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(bobSolved.totalItems, 1, 'solved status is never shared between accounts');
    assert.deepEqual(
      bobSolved.items.map((item) => item.problemKey),
      [(problems[7] as NormalizedProblem).key],
    );

    const unconfirmed = await service.browseProblems(
      { sourceInstanceId: instance.id, accountId: alice.id, status: 'unconfirmed', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(unconfirmed.totalItems, 127, 'unconfirmed is the exact complement of this account solves');
    assert.equal(unconfirmed.totalPages, 6);
    const solvedKeys = new Set(solvedIndexes.map((index) => (problems[index] as NormalizedProblem).key));
    assert.equal(
      unconfirmed.items.some((item) => solvedKeys.has(item.problemKey)),
      false,
    );
    const hiddenRow = unconfirmed.items[0];
    assert.ok(hiddenRow);
    assert.equal(Object.hasOwn(hiddenRow, 'rawTags'), false, 'unsolved spoilers stay absent');
    assert.equal(Object.hasOwn(hiddenRow, 'effectiveTaxonomyIds'), false);

    const last = await service.browseProblems({ sourceInstanceId: instance.id, page: 6, limit: 25 }, TOKEN);
    assert.equal(last.page, 6);
    assert.equal(last.items.length, 5);
    assert.deepEqual(
      last.items.map((item) => item.problemKey),
      problems.slice(125).map((problem) => problem.key),
    );
  });
});

void test('solved status is scoped to the account, the source instance and the problem domain', async () => {
  await withBench(async ({ store, service }) => {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const other = fx.makeInstance('luogu', 'luogu.com.cn');
    const alice = fx.makeAccount(instance, 'alice');
    const bob = fx.makeAccount(instance, 'bob');
    const aliceLuogu = fx.makeAccount(other, 'alice');
    const main = fx.makeProblem(fx.makeRef(instance, 'P100'));
    const gym = fx.makeProblem(fx.makeRef(instance, 'P100', 'gym'));
    const luogu = fx.makeProblem(fx.makeRef(other, 'P100'));
    await store.upsertSourceInstances([instance, other]);
    await store.upsertAccounts([alice, bob, aliceLuogu]);
    await store.upsertProblems([main, gym, luogu]);
    await store.upsertSubmissions([
      fx.makeSubmission(alice, gym.ref, 'G1', 'accepted'),
      fx.makeSubmission(bob, main.ref, 'B1', 'accepted'),
      fx.makeSubmission(aliceLuogu, luogu.ref, 'L1', 'accepted'),
    ]);

    const cfSolved = await service.browseProblems(
      { sourceInstanceId: instance.id, accountId: alice.id, status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      cfSolved.items.map((item) => item.problemKey),
      [gym.key],
      'the same external key in another domain is a different problem',
    );

    const aliceUnconfirmed = await service.browseProblems(
      { sourceInstanceId: instance.id, accountId: alice.id, status: 'unconfirmed', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      aliceUnconfirmed.items.map((item) => item.problemKey),
      [main.key],
      "bob's AC and the gym-domain AC cannot confirm the main-domain problem",
    );

    const sourceScoped = await service.browseProblems({ sourceInstanceId: instance.id, page: 1, limit: 25 }, TOKEN);
    assert.deepEqual(
      sourceScoped.items.map((item) => item.problemKey).sort(),
      [gym.key, main.key].sort(),
      'the bank is scoped to the requested source instance',
    );

    const luoguSolved = await service.browseProblems(
      { sourceInstanceId: other.id, accountId: aliceLuogu.id, status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      luoguSolved.items.map((item) => item.problemKey),
      [luogu.key],
    );

    await rejectsDomain(
      service.browseProblems({ accountId: alice.id, sourceInstanceId: other.id, page: 1, limit: 25 }, TOKEN),
      'invalid_input',
      'account_source_mismatch',
    );
  });
});

void test('an incoherent cross-source submission never solves, attempts or spoils a bank row', async () => {
  await withBench(async ({ store, service }) => {
    const cf = fx.makeInstance('codeforces', 'codeforces.com');
    const luogu = fx.makeInstance('luogu', 'luogu.com.cn');
    const cfAlice = fx.makeAccount(cf, 'alice');
    const luoguAlice = fx.makeAccount(luogu, 'alice');
    const cfMain = fx.makeProblem(fx.makeRef(cf, 'P100'));
    const cfGym = fx.makeProblem(fx.makeRef(cf, 'P100', 'gym'));
    const luoguProblem = fx.makeProblem(fx.makeRef(luogu, 'P100'));
    await store.upsertSourceInstances([cf, luogu]);
    await store.upsertAccounts([cfAlice, luoguAlice]);
    await store.upsertProblems([cfMain, cfGym, luoguProblem]);
    await store.upsertSubmissions([
      // A legacy database may hold this incoherent row: it names the CF account but the Luogu
      // problem, and its own source matches that problem, so only the account's stored source can
      // prove it foreign. The legacy service refuses such a row; the indexed path must not use it.
      fx.makeSubmission(cfAlice, luoguProblem.ref, 'bad-cross-source', 'accepted'),
      // The legitimate same-instance AC in another domain must keep working.
      fx.makeSubmission(cfAlice, cfGym.ref, 'G1', 'accepted'),
      fx.makeSubmission(luoguAlice, luoguProblem.ref, 'L1', 'accepted'),
    ]);

    // No source filter: the whole bank, solved relative to the CF account.
    const solved = await service.browseProblems({ accountId: cfAlice.id, status: 'solved', page: 1, limit: 25 }, TOKEN);
    assert.equal(solved.totalItems, 1, 'the foreign row is not part of the solved count');
    assert.deepEqual(
      solved.items.map((item) => item.problemKey),
      [cfGym.key],
      'a foreign-source row cannot make the Luogu problem solved for the CF account',
    );
    assert.deepEqual(
      solved.items[0]?.rawTags,
      cfGym.rawTags.map((tag) => tag.raw),
      'the legitimate same-instance other-domain AC keeps its spoiler material',
    );

    const unconfirmed = await service.browseProblems(
      { accountId: cfAlice.id, status: 'unconfirmed', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(unconfirmed.totalItems, 2, 'the foreign row is unconfirmed, never solved');
    const foreignRow = unconfirmed.items.find((item) => item.problemKey === luoguProblem.key);
    assert.ok(foreignRow, 'the Luogu row stays an ordinary bank row');
    assert.equal(foreignRow.solvedByAccount, false);
    assert.equal(Object.hasOwn(foreignRow, 'rawTags'), false, 'its spoilers stay withheld');
    assert.equal(Object.hasOwn(foreignRow, 'effectiveTaxonomyIds'), false);

    const attempted = await service.browseProblems(
      { accountId: cfAlice.id, onlyAttempted: true, page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      attempted.items.map((item) => item.problemKey),
      [cfGym.key],
      'the incoherent row is not an attempt of this account either',
    );

    // The account that actually owns the Luogu problem still sees it solved.
    const luoguSolved = await service.browseProblems(
      { accountId: luoguAlice.id, status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(luoguSolved.items.map((item) => item.problemKey), [luoguProblem.key]);

    // The unfiltered bank still lists the row, just never as this account's solve.
    const all = await service.browseProblems({ accountId: cfAlice.id, page: 1, limit: 25 }, TOKEN);
    assert.equal(all.totalItems, 3);
    const flags = new Map(all.items.map((item) => [item.problemKey, item.solvedByAccount]));
    assert.equal(flags.get(cfGym.key), true);
    assert.equal(flags.get(cfMain.key), false);
    assert.equal(flags.get(luoguProblem.key), false);
  });
});

void test('a store claiming a solve without an account or for a foreign source is refused', async () => {
  const { instance, alice, problems } = bank(2);
  const foreign = fx.makeProblem(fx.makeRef(fx.makeInstance('luogu', 'luogu.com.cn'), 'P100'));
  await withBench(
    async ({ store, service }) => {
      await store.upsertSourceInstances([instance]);
      await store.upsertAccounts([alice]);
      await store.upsertProblems(problems);

      await rejectsDomain(
        service.browseProblems({ page: 1, limit: 25 }, TOKEN),
        'invalid_input',
        'solved_projection_without_account',
      );
      await rejectsDomain(
        service.browseProblems({ accountId: alice.id, page: 1, limit: 25 }, TOKEN),
        'invalid_input',
        'solved_projection_foreign_source',
      );
    },
    (real) =>
      new Proxy(real as TrainingStore, {
        get(target, property, receiver) {
          if (property === 'browseProblems') {
            // A broken/hostile port: a foreign row projected as solved, with and without an account.
            return async () => ({
              items: [{ problem: foreign, solvedByAccount: true }],
              page: 1,
              pageSize: 25,
              totalItems: 1,
              totalPages: 1,
              fetchedAt: AT,
            });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }),
  );
});

void test('browse clamps out-of-range pages, reports an empty page coherently and validates every field', async () => {
  const { instance, alice, problems } = bank(30);
  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([instance]);
    await store.upsertAccounts([alice]);
    await store.upsertProblems(problems);

    const clamped = await service.browseProblems({ sourceInstanceId: instance.id, page: 99, limit: 25 }, TOKEN);
    assert.equal(clamped.page, 2, 'a page beyond the last match clamps to the last valid page');
    assert.equal(clamped.totalPages, 2);
    assert.equal(clamped.items.length, 5);
    assert.deepEqual(
      clamped.items.map((item) => item.problemKey),
      problems.slice(25).map((problem) => problem.key),
    );

    const empty = await service.browseProblems({ sourceInstanceId: instance.id, query: 'nothing-matches-this', page: 4, limit: 25 }, TOKEN);
    assert.equal(empty.totalItems, 0);
    assert.equal(empty.totalPages, 0);
    assert.equal(empty.page, 1);
    assert.deepEqual(empty.items, []);

    for (const limit of [0, 101, 2.5]) {
      await rejectsDomain(service.browseProblems({ page: 1, limit }, TOKEN), 'invalid_input');
    }
    for (const page of [0, -1, 1.5]) {
      await rejectsDomain(service.browseProblems({ page, limit: 25 }, TOKEN), 'invalid_input');
    }
    await rejectsDomain(
      service.browseProblems({ page: 1, limit: 25, status: 'maybe' as 'solved' }, TOKEN),
      'invalid_input',
    );
    await rejectsDomain(
      service.browseProblems({ page: 1, limit: 25, status: 'solved' }, TOKEN),
      'invalid_input',
      'status_without_account',
    );
    await rejectsDomain(
      service.browseProblems({ page: 1, limit: 25, onlyAttempted: true }, TOKEN),
      'invalid_input',
      'only_attempted_without_account',
    );
    await rejectsDomain(
      service.browseProblems({ page: 1, limit: 25, accountId: 'no-such-account' }, TOKEN),
      'missing_reference',
    );
    await rejectsDomain(
      service.browseProblems({ page: 1, limit: 25, query: '   ' }, TOKEN),
      'invalid_input',
    );

    // An explicit `all` status is the default and needs no account context.
    const anonymous = await service.browseProblems({ page: 1, limit: 25, status: 'all' }, TOKEN);
    assert.equal(anonymous.totalItems, 30);
  });
});

void test('status, attempted, review and search filters intersect before both the count and the page', async () => {
  const { instance, alice, problems } = bank(20);
  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([instance]);
    await store.upsertAccounts([alice]);
    await store.upsertProblems(problems);
    await store.upsertSubmissions([
      fx.makeSubmission(alice, (problems[0] as NormalizedProblem).ref, 'A1', 'accepted'),
      fx.makeSubmission(alice, (problems[5] as NormalizedProblem).ref, 'A2', 'wrong_answer'),
      fx.makeSubmission(alice, (problems[9] as NormalizedProblem).ref, 'A3', 'wrong_answer'),
    ]);
    const snapshot = fx.makeSnapshot(problems[9] as NormalizedProblem);
    await store.saveSnapshot(snapshot);
    await store.saveTagDecisions([
      fx.makeTagDecision(problems[9] as NormalizedProblem, {
        taxonomyId: STACK,
        status: 'needs_review',
        origin: 'ai',
        decidedAt: AT,
        snapshotId: snapshot.snapshotId,
        snapshotVersion: snapshot.version,
      }),
    ]);

    const attempted = await service.browseProblems({ accountId: alice.id, onlyAttempted: true, page: 1, limit: 25 }, TOKEN);
    assert.equal(attempted.totalItems, 3, 'onlyAttempted intersects the bank with this account history');

    const attemptedUnsolved = await service.browseProblems(
      { accountId: alice.id, onlyAttempted: true, status: 'unconfirmed', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(attemptedUnsolved.totalItems, 2);

    const attemptedSolved = await service.browseProblems(
      { accountId: alice.id, onlyAttempted: true, status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      attemptedSolved.items.map((item) => item.problemKey),
      [(problems[0] as NormalizedProblem).key],
    );

    const review = await service.browseProblems({ needsReviewOnly: true, page: 1, limit: 25 }, TOKEN);
    assert.equal(review.pendingReviewOnly, true);
    assert.equal(review.totalItems, 1);
    const queued = review.items[0];
    assert.ok(queued);
    assert.equal(queued.pendingReview, true);
    assert.equal(Object.hasOwn(queued, 'rawTags'), false, 'a queued row still withholds its spoilers');

    const reviewIntersection = await service.browseProblems(
      { accountId: alice.id, onlyAttempted: true, status: 'unconfirmed', needsReviewOnly: true, page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      reviewIntersection.items.map((item) => item.problemKey),
      [(problems[9] as NormalizedProblem).key],
    );

    const searchIntersection = await service.browseProblems(
      { accountId: alice.id, onlyAttempted: true, query: (problems[9] as NormalizedProblem).ref.externalKey, page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(searchIntersection.totalItems, 1);
  });
});

void test('numbered browse keeps literal search semantics and pages the whole matching set', async () => {
  await withBench(async ({ store, service }) => {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const alice = fx.makeAccount(instance, 'alice');
    const percent = fx.makeProblem(fx.makeRef(instance, 'K1'), { title: 'Percent 100%_literal' });
    const decoy = fx.makeProblem(fx.makeRef(instance, 'K2'), { title: 'Percent 100XYliteral' });
    const alpha = Array.from({ length: 30 }, (_, index) =>
      fx.makeProblem(fx.makeRef(instance, `Q${String(index).padStart(2, '0')}`), { title: 'Alpha routine' }),
    );
    await store.upsertSourceInstances([instance]);
    await store.upsertAccounts([alice]);
    await store.upsertProblems([percent, decoy, ...alpha]);
    await store.upsertSubmissions([fx.makeSubmission(alice, percent.ref, 'A1', 'wrong_answer')]);

    const literal = await service.browseProblems({ query: '100%_', page: 1, limit: 25 }, TOKEN);
    assert.equal(literal.totalItems, 1, '`%` and `_` are ordinary characters, never wildcards');
    assert.deepEqual(
      literal.items.map((item) => item.problemKey),
      [percent.key],
    );

    const alphaPage = await service.browseProblems({ query: 'alpha', page: 2, limit: 25 }, TOKEN);
    assert.equal(alphaPage.totalItems, 30);
    assert.equal(alphaPage.totalPages, 2);
    assert.equal(alphaPage.items.length, 5);

    const intersection = await service.browseProblems(
      { accountId: alice.id, query: 'percent', onlyAttempted: true, status: 'unconfirmed', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      intersection.items.map((item) => item.problemKey),
      [percent.key],
    );
    assert.equal(intersection.items[0]?.solvedByAccount, false);
  });
});

void test('numbered browse never walks submission history and reads count plus page in one transaction', async () => {
  const { instance, alice, problems } = bank(30);
  const calls = { transactions: 0, browses: 0 };
  await withBench(
    async ({ store, service }) => {
      await store.upsertSourceInstances([instance]);
      await store.upsertAccounts([alice]);
      await store.upsertProblems(problems);
      await store.upsertSubmissions([fx.makeSubmission(alice, (problems[0] as NormalizedProblem).ref, 'A1', 'accepted')]);

      const page = await service.browseProblems(
        { sourceInstanceId: instance.id, accountId: alice.id, status: 'solved', page: 1, limit: 25 },
        TOKEN,
      );
      assert.equal(page.totalItems, 1);
      assert.deepEqual(
        page.items.map((item) => item.problemKey),
        [(problems[0] as NormalizedProblem).key],
      );
      assert.equal(calls.transactions, 1, 'count, page and projection share one store transaction');
      assert.equal(calls.browses, 1, 'the store answers the whole numbered page in one call');

      const cancelled = createCancellationSource();
      cancelled.cancel('test');
      await rejectsDomain(
        service.browseProblems({ page: 1, limit: 25 }, cancelled.token),
        'cancelled',
      );
    },
    (real) =>
      new Proxy(real as TrainingStore, {
        get(target, property, receiver) {
          if (property === 'listSubmissions' || property === 'listProblems') {
            return async () => {
              throw new Error(`numbered browse must not call ${String(property)}`);
            };
          }
          if (property === 'transaction') {
            return async (work: () => Promise<unknown>) => {
              calls.transactions += 1;
              return target.transaction(work);
            };
          }
          if (property === 'browseProblems') {
            return async (query: unknown) => {
              calls.browses += 1;
              return (target as SqliteTrainingStore).browseProblems(query as never);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }),
  );
});

void test('a store row whose body key disagrees with its key column is refused, not paged', async () => {
  const { instance, problems } = bank(3);
  await withBench(
    async ({ store, service }) => {
      await store.upsertSourceInstances([instance]);
      await store.upsertProblems(problems);
      await rejectsDomain(
        service.browseProblems({ page: 1, limit: 25 }, TOKEN),
        'invalid_input',
        'problem_key_mismatch',
      );
    },
    (real) =>
      new Proxy(real as TrainingStore, {
        get(target, property, receiver) {
          if (property === 'browseProblems') {
            return async () => ({
              items: [
                {
                  problem: { ...(problems[1] as NormalizedProblem), key: (problems[2] as NormalizedProblem).key },
                  solvedByAccount: false,
                },
              ],
              page: 1,
              pageSize: 25,
              totalItems: 1,
              totalPages: 1,
              fetchedAt: AT,
            });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }),
  );
});
