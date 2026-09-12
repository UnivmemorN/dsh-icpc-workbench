/**
 * Bank sorting (Sprint Contract 07a) over a real SQLite store.
 *
 * Every case drives the real `WorkbenchService` and `SqliteTrainingStore`. The expectations are
 * written independently of the implementation: the whole-set orders are literal arrays, the paged
 * expectations come from the input rows' own values, and the difficulty expectations are plain
 * integer comparisons. The cases cover a bank larger than one page, natural multi-digit, punctuated,
 * prefixed and 40-digit keys, deterministic ties, title case handling, missing/blank/text ratings
 * last in both directions, raw dimension isolation, filter intersections, the unchanged legacy
 * order, refusals, a hostile dimension and the no-submission-walk guard.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type { ProblemSort, TrainingStore } from '../../src/application/ports.js';
import {
  WorkbenchService,
  type WorkbenchBrowseRequest,
  type WorkbenchServiceOptions,
} from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  DomainError,
  createCancellationSource,
  createNormalizedProblem,
  createTaxonomyIndex,
  type NormalizedProblem,
  type PlatformRating,
  type SourceInstance,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** An id that exists in the shipped vocabulary; review fixtures only store known tags. */
const STACK = 'data-structure.stack';
/** A label that would end the statement if it were ever interpolated instead of bound. */
const HOSTILE_DIMENSION = "rating') OR 1=1 --";

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
    uniqueId: () => `sort-${(minted += 1)}`,
  };
  try {
    await run({ store, service: new WorkbenchService(options) });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

/** One raw rating dimension exactly as a platform reports it. */
function rating(dimension: string, value: number | string): PlatformRating {
  return { dimension, value, scale: null, raw: String(value) };
}

/** One real normalized problem with explicit ratings; no platform or model is involved. */
function problem(
  instance: SourceInstance,
  externalKey: string,
  options: { readonly title?: string; readonly ratings?: readonly PlatformRating[] } = {},
): NormalizedProblem {
  return createNormalizedProblem({
    ref: fx.makeRef(instance, externalKey),
    title: options.title ?? `Problem ${externalKey}`,
    url: `https://${instance.domain}/problem/${externalKey}`,
    statement: 'Given an array, support range add and range sum queries.',
    fetchedAt: AT,
    ratings: options.ratings ?? [],
  });
}

/** Canonical-key lookup of the fixtures, so an expectation can never silently name a missing key. */
function keyLookup(problems: readonly NormalizedProblem[]): (externalKey: string) => string {
  const index = new Map(problems.map((entry) => [entry.ref.externalKey, entry.key]));
  return (externalKey) => {
    const key = index.get(externalKey);
    assert.ok(key !== undefined, `fixture ${externalKey} is missing`);
    return key;
  };
}

async function rejectsInvalid(promise: Promise<unknown>, reason?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, 'invalid_input');
    if (reason !== undefined) {
      assert.equal(error.details['reason'], reason);
    }
    return true;
  });
}

/** Walk every numbered page of one sorted query and return the concatenated keys plus page numbers. */
async function keyPages(
  service: WorkbenchService,
  request: Omit<WorkbenchBrowseRequest, 'page' | 'limit'>,
  limit = 25,
): Promise<{ readonly keys: readonly string[]; readonly pages: readonly number[] }> {
  const keys: string[] = [];
  const pages: number[] = [];
  let page = 1;
  for (;;) {
    const answer = await service.browseProblems({ ...request, page, limit }, TOKEN);
    pages.push(answer.page);
    keys.push(...answer.items.map((item) => item.problemKey));
    if (answer.totalPages === 0 || answer.page >= answer.totalPages) {
      return { keys, pages };
    }
    page = answer.page + 1;
  }
}

void test('natural problem order is exact over a whole bank larger than one page, in both directions', async () => {
  const instance = fx.makeInstance('codeforces', 'codeforces.com');
  const bigLow = `${'9'.repeat(39)}7`;
  const bigHigh = `${'9'.repeat(39)}8`;
  const generated = Array.from({ length: 114 }, (_, index) => `G${index}`);
  const problems = [
    ...['2A', '10A', 'P2', 'P10', 'E1', 'E2', 'A2', 'A#', 'A10', 'A9', '007', '7', 'Z', 'a', bigLow, bigHigh].map(
      (key) => problem(instance, key),
    ),
    ...generated.map((key) => problem(instance, key)),
  ];
  const key = keyLookup(problems);
  // The expected whole-set order, written out rather than derived from the implementation.
  const expectedAsc = [
    '2A',
    '007',
    '7',
    '10A',
    bigLow,
    bigHigh,
    'A#',
    'A2',
    'A9',
    'A10',
    'E1',
    'E2',
    ...generated,
    'P2',
    'P10',
    'Z',
    'a',
  ];
  // Descending reverses the order but keeps the canonical-key tie break ascending.
  const expectedDesc = [
    'a',
    'Z',
    'P10',
    'P2',
    ...[...generated].reverse(),
    'E2',
    'E1',
    'A10',
    'A9',
    'A2',
    'A#',
    bigHigh,
    bigLow,
    '10A',
    '007',
    '7',
    '2A',
  ];
  assert.equal(expectedAsc.length, 130);

  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems(problems);

    const asc = await keyPages(service, { sourceInstanceId: instance.id, sort: 'problem_asc' });
    assert.deepEqual(asc.pages, [1, 2, 3, 4, 5, 6], 'every page is served once, in order');
    assert.equal(asc.keys.length, 130);
    assert.equal(new Set(asc.keys).size, 130, 'no row is omitted or repeated across a page boundary');
    assert.deepEqual(asc.keys, expectedAsc.map(key));

    const firstPage = await service.browseProblems(
      { sourceInstanceId: instance.id, sort: 'problem_asc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(firstPage.totalItems, 130);
    assert.equal(firstPage.totalPages, 6);
    assert.deepEqual(
      firstPage.items.map((item) => item.problemKey),
      expectedAsc.slice(0, 25).map(key),
    );
    assert.deepEqual(
      asc.keys.slice(1, 3),
      [key('007'), key('7')],
      'leading zeros are ordering-insignificant, so the tie is broken by the canonical key',
    );

    const desc = await keyPages(service, { sourceInstanceId: instance.id, sort: 'problem_desc' });
    assert.deepEqual(desc.keys, expectedDesc.map(key));
    assert.equal(new Set(desc.keys).size, 130);

    // The legacy contract: an omitted, explicit `default` and explicit `null` sort are one order.
    const canonical = problems.map((entry) => entry.key).sort();
    for (const request of [
      { sourceInstanceId: instance.id },
      { sourceInstanceId: instance.id, sort: 'default' as ProblemSort },
      { sourceInstanceId: instance.id, sort: null },
    ]) {
      const answer = await service.browseProblems({ ...request, page: 1, limit: 25 }, TOKEN);
      assert.deepEqual(
        answer.items.map((item) => item.problemKey),
        canonical.slice(0, 25),
        'the legacy canonical-key order is unchanged',
      );
    }
    const legacyList = await service.listProblems({ sourceInstanceId: instance.id, limit: 25, cursor: null }, TOKEN);
    assert.deepEqual(
      legacyList.items.map((item) => item.problemKey),
      canonical.slice(0, 25),
      'problem.list keeps its own cursor order',
    );
  });
});

void test('title order is deterministic ASCII-case-insensitive with a canonical tie break', async () => {
  const instance = fx.makeInstance('codeforces', 'codeforces.com');
  const problems = [
    problem(instance, 'T1', { title: 'Zebra' }),
    problem(instance, 'T2', { title: 'apple' }),
    problem(instance, 'T3', { title: 'alpha' }),
    problem(instance, 'T4', { title: 'Alpha' }),
    problem(instance, 'T5', { title: 'beta' }),
    problem(instance, 'T6', { title: '题目一' }),
  ];
  const key = keyLookup(problems);
  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems(problems);

    const asc = await service.browseProblems(
      { sourceInstanceId: instance.id, sort: 'title_asc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      asc.items.map((item) => item.problemKey),
      ['T3', 'T4', 'T2', 'T5', 'T1', 'T6'].map(key),
      'NOCASE folds ASCII case, so alpha/apple/Zebra order case-insensitively',
    );
    const desc = await service.browseProblems(
      { sourceInstanceId: instance.id, sort: 'title_desc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      desc.items.map((item) => item.problemKey),
      ['T6', 'T1', 'T5', 'T2', 'T3', 'T4'].map(key),
      'the alpha/Alpha tie keeps the canonical key ascending in both directions',
    );
  });
});

void test('difficulty order reads one raw dimension, keeps missing values last in both directions', async () => {
  const cf = fx.makeInstance('codeforces', 'codeforces.com');
  const luogu = fx.makeInstance('luogu', 'luogu.com.cn');
  const problems = [
    problem(cf, 'D0800', { ratings: [rating('rating', 800)] }),
    problem(cf, 'D1200', { ratings: [rating('rating', 1200)] }),
    problem(cf, 'DBOTH', { ratings: [rating('rating', 1200), rating('difficulty', 9)] }),
    problem(cf, 'D1800', { ratings: [rating('rating', 1800)] }),
    problem(cf, 'DPAD', { ratings: [rating('rating', ' 1800 ')] }),
    problem(cf, 'DPAD2', { ratings: [rating('rating', 1800)] }),
    problem(cf, 'D2400', { ratings: [rating('rating', 2400)] }),
    problem(cf, 'D3500', { ratings: [rating('rating', 3500)] }),
    problem(cf, 'DBLANK', { ratings: [rating('rating', '')] }),
    problem(cf, 'DNONE'),
    problem(cf, 'DOTHER', { ratings: [rating('difficulty', 7)] }),
    problem(cf, 'DTEXT', { ratings: [rating('rating', 'unrated')] }),
    problem(cf, 'DWS', { ratings: [rating('rating', '   ')] }),
    problem(luogu, 'L1', { ratings: [rating('difficulty', '3')] }),
    problem(luogu, 'L2', { ratings: [rating('difficulty', '1')] }),
    problem(luogu, 'L3', { ratings: [rating('difficulty', 2)] }),
  ];
  const key = keyLookup(problems);
  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([cf, luogu]);
    await store.upsertProblems(problems);

    const ascending = await service.browseProblems(
      { sourceInstanceId: cf.id, sort: 'difficulty_asc', ratingDimension: 'rating', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      ascending.items.map((item) => item.problemKey),
      [
        'D0800',
        'D1200',
        'DBOTH',
        'D1800',
        'DPAD',
        'DPAD2',
        'D2400',
        'D3500',
        'DBLANK',
        'DNONE',
        'DOTHER',
        'DTEXT',
        'DWS',
      ].map(key),
      'padded numeric strings rate normally; blank/text/missing/other-dimension values are last',
    );
    const padded = ascending.items.find((item) => item.problemKey === key('DPAD'));
    assert.ok(padded);
    assert.equal(padded.rawRatings[0]?.value, ' 1800 ', 'the stored raw rating is never rewritten');

    const descending = await service.browseProblems(
      { sourceInstanceId: cf.id, sort: 'difficulty_desc', ratingDimension: 'rating', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      descending.items.map((item) => item.problemKey),
      [
        'D3500',
        'D2400',
        'D1800',
        'DPAD',
        'DPAD2',
        'D1200',
        'DBOTH',
        'D0800',
        'DBLANK',
        'DNONE',
        'DOTHER',
        'DTEXT',
        'DWS',
      ].map(key),
      'incomparable values stay last and equal values keep the canonical key ascending',
    );

    // One raw dimension at a time: only `DOTHER` (7) and `DBOTH` (9) carry `difficulty`, so the rest
    // fall back to canonical-key order.
    const byOtherDimension = await service.browseProblems(
      { sourceInstanceId: cf.id, sort: 'difficulty_asc', ratingDimension: 'difficulty', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      byOtherDimension.items.map((item) => item.problemKey),
      ['DOTHER', 'DBOTH', 'D0800', 'D1200', 'D1800', 'D2400', 'D3500', 'DBLANK', 'DNONE', 'DPAD', 'DPAD2', 'DTEXT', 'DWS'].map(
        key,
      ),
      'the `rating` values are invisible to a `difficulty` order',
    );

    // A second source instance has its own raw scale; ratings are never mixed across sources.
    const luoguAscending = await service.browseProblems(
      { sourceInstanceId: luogu.id, sort: 'difficulty_asc', ratingDimension: 'difficulty', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      luoguAscending.items.map((item) => item.problemKey),
      ['L2', 'L3', 'L1'].map(key),
      'raw values 1, 2 and "3" order as numbers without being normalised into another platform scale',
    );
  });
});

void test('difficulty order pages more than 100 rows without omission or repetition', async () => {
  const instance = fx.makeInstance('codeforces', 'codeforces.com');
  const rated = Array.from({ length: 110 }, (_, index) =>
    problem(instance, `A${String(index).padStart(3, '0')}`, { ratings: [rating('rating', 1000 + index)] }),
  );
  const unrated = Array.from({ length: 20 }, (_, index) => problem(instance, `B${String(index).padStart(3, '0')}`));
  const problems = [...rated, ...unrated];
  const key = keyLookup(problems);
  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems(problems);

    const ascending = await keyPages(service, {
      sourceInstanceId: instance.id,
      sort: 'difficulty_asc',
      ratingDimension: 'rating',
    });
    assert.deepEqual(ascending.pages, [1, 2, 3, 4, 5, 6]);
    assert.equal(new Set(ascending.keys).size, 130);
    assert.deepEqual(ascending.keys, [...rated, ...unrated].map((entry) => entry.ref.externalKey).map(key));

    const descending = await keyPages(service, {
      sourceInstanceId: instance.id,
      sort: 'difficulty_desc',
      ratingDimension: 'rating',
    });
    assert.deepEqual(
      descending.keys,
      [...rated].reverse().concat(unrated).map((entry) => entry.ref.externalKey).map(key),
      'unrated rows stay last while the rated rows reverse',
    );
    assert.deepEqual(
      descending.keys.slice(110),
      unrated.map((entry) => entry.key),
      'the unmatched rows are only reached on the later pages',
    );
    assert.equal(
      descending.keys.indexOf(key('A000')),
      109,
      'the lowest rating is beyond page 1 in a difficulty order',
    );
  });
});

void test('sorting intersects solved, status, attempted, search and review filters', async () => {
  const instance = fx.makeInstance('codeforces', 'codeforces.com');
  const alice = fx.makeAccount(instance, 'alice');
  const alphaOne = problem(instance, 'S1', { title: 'Alpha one', ratings: [rating('rating', 1900)] });
  const betaTwo = problem(instance, 'S2', { title: 'Beta two', ratings: [rating('rating', 1500)] });
  const alphaThree = problem(instance, 'S3', { title: 'Alpha three', ratings: [rating('rating', 1700)] });
  const gammaFour = problem(instance, 'S4', { title: 'Gamma four', ratings: [rating('rating', 1600)] });
  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([instance]);
    await store.upsertAccounts([alice]);
    await store.upsertProblems([alphaOne, betaTwo, alphaThree, gammaFour]);
    await store.upsertSubmissions([
      fx.makeSubmission(alice, alphaOne.ref, 'A1', 'accepted'),
      fx.makeSubmission(alice, alphaThree.ref, 'A2', 'wrong_answer'),
    ]);
    const snapshot = fx.makeSnapshot(alphaThree);
    await store.saveSnapshot(snapshot);
    await store.saveTagDecisions([
      fx.makeTagDecision(alphaThree, {
        taxonomyId: STACK,
        status: 'needs_review',
        origin: 'ai',
        decidedAt: AT,
        snapshotId: snapshot.snapshotId,
        snapshotVersion: snapshot.version,
      }),
    ]);

    const solved = await service.browseProblems(
      {
        sourceInstanceId: instance.id,
        accountId: alice.id,
        status: 'solved',
        sort: 'difficulty_desc',
        ratingDimension: 'rating',
        page: 1,
        limit: 25,
      },
      TOKEN,
    );
    assert.equal(solved.totalItems, 1);
    assert.deepEqual(
      solved.items.map((item) => item.problemKey),
      [alphaOne.key],
    );

    const attempted = await service.browseProblems(
      {
        sourceInstanceId: instance.id,
        accountId: alice.id,
        onlyAttempted: true,
        sort: 'difficulty_asc',
        ratingDimension: 'rating',
        page: 1,
        limit: 25,
      },
      TOKEN,
    );
    assert.deepEqual(
      attempted.items.map((item) => item.problemKey),
      [alphaThree.key, alphaOne.key],
      'attempted rows are ordered by their rating, not by key',
    );

    const unconfirmed = await service.browseProblems(
      { sourceInstanceId: instance.id, accountId: alice.id, status: 'unconfirmed', sort: 'title_asc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(unconfirmed.totalItems, 3, 'one solve leaves three rows unconfirmed');
    assert.deepEqual(
      unconfirmed.items.map((item) => item.problemKey),
      [alphaThree.key, betaTwo.key, gammaFour.key],
      'the unconfirmed set is titled-ordered, not key-ordered',
    );

    const search = await service.browseProblems(
      { sourceInstanceId: instance.id, query: 'alpha', sort: 'problem_desc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(search.totalItems, 2);
    assert.deepEqual(
      search.items.map((item) => item.problemKey),
      [alphaThree.key, alphaOne.key],
    );

    const review = await service.browseProblems(
      { sourceInstanceId: instance.id, needsReviewOnly: true, sort: 'problem_asc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      review.items.map((item) => item.problemKey),
      [alphaThree.key],
    );
    assert.equal(Object.hasOwn(review.items[0] as object, 'rawTags'), false, 'spoilers stay withheld');

    const combined = await service.browseProblems(
      {
        sourceInstanceId: instance.id,
        accountId: alice.id,
        onlyAttempted: true,
        status: 'unconfirmed',
        query: 'alpha',
        sort: 'problem_asc',
        page: 1,
        limit: 25,
      },
      TOKEN,
    );
    assert.deepEqual(
      combined.items.map((item) => item.problemKey),
      [alphaThree.key],
      'all filters still intersect before the sorted page',
    );
  });
});

void test('invalid sorts and dimensions are refused, and a hostile dimension stays literal data', async () => {
  const instance = fx.makeInstance('codeforces', 'codeforces.com');
  const hostileFive = problem(instance, 'H1', { ratings: [rating(HOSTILE_DIMENSION, 5)] });
  const hostileOne = problem(instance, 'H2', { ratings: [rating(HOSTILE_DIMENSION, 1)] });
  const plain = problem(instance, 'H3', { ratings: [rating('rating', 42)] });
  await withBench(async ({ store, service }) => {
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems([hostileFive, hostileOne, plain]);

    await rejectsInvalid(service.browseProblems({ page: 1, limit: 25, sort: 'by_vibes' as ProblemSort }, TOKEN));
    await rejectsInvalid(
      service.browseProblems({ page: 1, limit: 25, sort: 'difficulty_asc', ratingDimension: 'rating' }, TOKEN),
      'rating_source_required',
    );
    await rejectsInvalid(
      service.browseProblems({ page: 1, limit: 25, sourceInstanceId: instance.id, sort: 'difficulty_asc' }, TOKEN),
      'rating_dimension_required',
    );
    await rejectsInvalid(
      service.browseProblems(
        { page: 1, limit: 25, sourceInstanceId: instance.id, sort: 'difficulty_asc', ratingDimension: '   ' },
        TOKEN,
      ),
      'invalid_rating_dimension',
    );
    await rejectsInvalid(
      service.browseProblems(
        {
          page: 1,
          limit: 25,
          sourceInstanceId: instance.id,
          sort: 'difficulty_asc',
          ratingDimension: 'x'.repeat(101),
        },
        TOKEN,
      ),
      'invalid_rating_dimension',
    );
    await rejectsInvalid(
      service.browseProblems(
        {
          page: 1,
          limit: 25,
          sort: 'problem_asc',
          ratingDimension: 7 as unknown as string,
        },
        TOKEN,
      ),
      'invalid_rating_dimension',
    );

    // The port repeats the checks, so a direct store caller cannot bypass them either.
    await rejectsInvalid(
      store.browseProblems({ page: 1, limit: 25, sort: 'by_vibes' as ProblemSort }),
    );
    await rejectsInvalid(
      store.browseProblems({ page: 1, limit: 25, sort: 'difficulty_asc', ratingDimension: 'rating' }),
      'rating_source_required',
    );
    await rejectsInvalid(
      store.browseProblems({ page: 1, limit: 25, sourceInstanceId: instance.id, sort: 'difficulty_asc' }),
      'rating_dimension_required',
    );
    await rejectsInvalid(
      store.browseProblems({
        page: 1,
        limit: 25,
        sourceInstanceId: instance.id,
        sort: 'difficulty_asc',
        ratingDimension: 5 as unknown as string,
      }),
      'invalid_rating_dimension',
    );

    // The hostile label is bound as data: it matches exactly the rows that carry it, and the WHERE
    // clause and the count are untouched.
    const hostile = await service.browseProblems(
      {
        sourceInstanceId: instance.id,
        sort: 'difficulty_asc',
        ratingDimension: HOSTILE_DIMENSION,
        page: 1,
        limit: 25,
      },
      TOKEN,
    );
    assert.equal(hostile.totalItems, 3);
    assert.deepEqual(
      hostile.items.map((item) => item.problemKey),
      [hostileOne.key, hostileFive.key, plain.key],
      'a dimension that looks like SQL is compared as a literal label',
    );
    const filtered = await service.browseProblems(
      {
        sourceInstanceId: instance.id,
        query: 'H1',
        sort: 'difficulty_asc',
        ratingDimension: HOSTILE_DIMENSION,
        page: 1,
        limit: 25,
      },
      TOKEN,
    );
    assert.equal(filtered.totalItems, 1, 'the search predicate still applies after the sort');
    assert.deepEqual(
      filtered.items.map((item) => item.problemKey),
      [hostileFive.key],
    );
  });
});

void test('a sorted page never walks submission history or problem cursors and stays one transaction', async () => {
  const instance = fx.makeInstance('codeforces', 'codeforces.com');
  const alice = fx.makeAccount(instance, 'alice');
  const problems = Array.from({ length: 5 }, (_, index) =>
    problem(instance, `N${index}`, { ratings: [rating('rating', index)] }),
  );
  const calls = { transactions: 0, browses: 0 };
  await withBench(
    async ({ store, service }) => {
      await store.upsertSourceInstances([instance]);
      await store.upsertAccounts([alice]);
      await store.upsertProblems(problems);

      const page = await service.browseProblems(
        {
          sourceInstanceId: instance.id,
          accountId: alice.id,
          sort: 'difficulty_desc',
          ratingDimension: 'rating',
          page: 1,
          limit: 25,
        },
        TOKEN,
      );
      assert.equal(page.totalItems, 5);
      assert.deepEqual(
        page.items.map((item) => item.problemKey),
        [...problems].reverse().map((entry) => entry.key),
      );
      assert.equal(calls.transactions, 1, 'count, page and projection share one store transaction');
      assert.equal(calls.browses, 1, 'the store answers the whole sorted page in one call');

      const cancelled = createCancellationSource();
      cancelled.cancel('test');
      await assert.rejects(
        service.browseProblems({ sourceInstanceId: instance.id, sort: 'problem_asc', page: 1, limit: 25 }, cancelled.token),
        (error: unknown) => error instanceof DomainError && error.code === 'cancelled',
      );
    },
    (real) =>
      new Proxy(real as TrainingStore, {
        get(target, property, receiver) {
          if (property === 'listSubmissions' || property === 'listProblems') {
            return async () => {
              throw new Error(`a sorted page must not call ${String(property)}`);
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
