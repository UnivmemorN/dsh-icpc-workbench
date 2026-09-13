/**
 * Merged cross-site bank (Sprint Contract 08b) over a real SQLite store.
 *
 * Every case drives the real `WorkbenchService` and `SqliteTrainingStore`; no platform, model or
 * network is involved. The assertions cover the externally meaningful behaviour the contract asks
 * for: a pair collapsed once across pages, a linked AC from either site, duplicate AC and later WA,
 * isolation of an unselected student, mixed source filters and member search, missing original
 * metadata, gym/non-canonical/numeric boundaries, sorting and clamping, typed refusals, cancellation,
 * hostile store claims and the fact that the merged read writes nothing and leaves the legacy bank
 * exactly as it was.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type {
  MergedProblemBrowsePage,
  MergedProblemBrowseQuery,
  MergedProblemEvidenceRow,
  MergedProblemGroupRow,
  TrainingStore,
} from '../../src/application/ports.js';
import { WorkbenchService, type WorkbenchServiceOptions } from '../../src/application/workbench-service.js';
import type { WorkbenchMergedBrowsePage, WorkbenchMergedProblemGroup } from '../../src/application/workbench-types.js';
import {
  CODEFORCES_MAIN_INSTANCE_ID,
  CURRENT_TAXONOMY,
  LUOGU_OFFICIAL_INSTANCE_ID,
  createCancellationSource,
  createNormalizedProblem,
  createTaxonomyIndex,
  problemKey,
  type Account,
  type DomainErrorCode,
  type NormalizedProblem,
  type ProblemRef,
  type SourceInstance,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const LATER = '2026-11-01T09:00:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
const MIRROR_1A = 'merged:cf:1A';

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

async function rejectsDomain(
  promise: Promise<unknown>,
  code: DomainErrorCode,
  reason?: string,
  label?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof Error && error.name === 'DomainError',
      `${label ?? 'request'}: expected a DomainError, got ${String(error)}`,
    );
    const details = (error as { details?: Record<string, unknown> }).details ?? {};
    assert.equal((error as { code?: string }).code, code, label);
    if (reason !== undefined) {
      assert.equal(details['reason'], reason, `${label ?? 'request'}: expected reason ${reason}`);
    }
    return true;
  });
}

interface World {
  readonly cf: SourceInstance;
  readonly luogu: SourceInstance;
  readonly cfAccount: Account;
  readonly luoguAccount: Account;
  readonly otherStudent: Account;
}

/** Two official instances and three accounts; the second Luogu student is never selected by default. */
async function seedWorld(store: SqliteTrainingStore): Promise<World> {
  const cf = fx.makeInstance('codeforces', 'codeforces.com');
  const luogu = fx.makeInstance('luogu', 'www.luogu.com.cn');
  assert.equal(cf.id, CODEFORCES_MAIN_INSTANCE_ID);
  assert.equal(luogu.id, LUOGU_OFFICIAL_INSTANCE_ID);
  const world: World = {
    cf,
    luogu,
    cfAccount: fx.makeAccount(cf, 'alice'),
    luoguAccount: fx.makeAccount(luogu, '123456'),
    otherStudent: fx.makeAccount(luogu, '654321'),
  };
  await store.upsertSourceInstances([cf, luogu]);
  await store.upsertAccounts([world.cfAccount, world.luoguAccount, world.otherStudent]);
  return world;
}

function groupOf(page: WorkbenchMergedBrowsePage, groupKey: string): WorkbenchMergedProblemGroup {
  const group = page.items.find((item) => item.groupKey === groupKey);
  assert.ok(group, `merged page must contain group ${groupKey}; got ${page.items.map((i) => i.groupKey).join(', ')}`);
  return group;
}

function memberOf(group: WorkbenchMergedProblemGroup, sourceInstanceId: string) {
  const member = group.members.find((entry) => entry.problem.sourceInstanceId === sourceInstanceId);
  assert.ok(member, `group ${group.groupKey} must contain a member of ${sourceInstanceId}`);
  return member;
}

/** One problem with a raw `difficulty` rating, or none at all. */
function rated(ref: ProblemRef, difficulty: number | null, title: string): NormalizedProblem {
  return createNormalizedProblem({
    ref,
    title,
    url: `https://${ref.sourceInstanceId.split(':')[1] ?? 'example.org'}/problem/${ref.externalKey}`,
    fetchedAt: AT,
    ratings:
      difficulty === null
        ? []
        : [{ dimension: 'difficulty', value: difficulty, scale: { min: 1, max: 7 }, raw: String(difficulty) }],
    rawTags: ['implementation'],
  });
}

// ---------------------------------------------------------------------------------------
// Linked solved state
// ---------------------------------------------------------------------------------------

void test('a mirror pair collapses into one group and a CF AC solves the Luogu mirror', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    const cfProblem = fx.makeProblem(fx.makeRef(world.cf, '1A'), { title: 'Theatre Square' });
    const luoguProblem = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'), { title: 'A+B Problem' });
    const solo = fx.makeProblem(fx.makeRef(world.cf, '4A'), { title: 'Watermelon' });
    await store.upsertProblems([cfProblem, luoguProblem, solo]);
    const firstAc = fx.makeSubmission(world.cfAccount, cfProblem.ref, 'S1', 'accepted', AT);
    await store.upsertSubmissions([
      firstAc,
      // A duplicate AC and a LATER wrong answer: still exactly one solved problem.
      fx.makeSubmission(world.cfAccount, cfProblem.ref, 'S2', 'accepted', LATER),
      fx.makeSubmission(world.cfAccount, cfProblem.ref, 'S3', 'wrong_answer', LATER),
      // Another student solved the Luogu side; selecting a different account must ignore it.
      fx.makeSubmission(world.otherStudent, luoguProblem.ref, 'S4', 'accepted', AT),
    ]);

    const page = await service.browseMergedProblems({ accountIds: [world.cfAccount.id], page: 1, limit: 25 }, TOKEN);
    assert.equal(page.pageId, 'page-1');
    assert.equal(page.totalItems, 2, 'the pair is one group, the unrelated problem is another');
    assert.equal(page.totalPages, 1);
    assert.equal(page.page, 1);
    assert.equal(page.pageSize, 25);
    assert.equal(page.reveal, false);
    assert.deepEqual(page.equivalenceRules.map((rule) => rule.ruleId), ['luogu_cf_identifier']);
    assert.equal(page.equivalenceRules[0]?.referenceExampleUrl, 'https://www.luogu.com.cn/problem/CF1A');

    const group = groupOf(page, MIRROR_1A);
    assert.equal(group.mappingKind, 'luogu_cf_identifier');
    assert.equal(group.members.length, 2);
    assert.equal(group.solved, true, 'a later WA never revokes the earlier AC');
    assert.equal(group.attempted, true);
    assert.deepEqual(group.acceptedEvidence, [
      {
        accountId: world.cfAccount.id,
        problemKey: cfProblem.key,
        sourceInstanceId: world.cf.id,
        externalKey: '1A',
        submissionId: firstAc.id,
        submittedAt: AT,
      },
    ]);

    const cfMember = memberOf(group, world.cf.id);
    assert.equal(cfMember.accountId, world.cfAccount.id);
    assert.equal(cfMember.problem.solvedByAccount, true, "the account's own AC marks its own member solved");
    assert.equal(cfMember.problem.pendingReview, null);
    assert.deepEqual(cfMember.problem.rawTags, cfProblem.rawTags.map((tag) => tag.raw));
    assert.equal(cfMember.problem.problemKey, cfProblem.key);
    assert.equal(cfMember.problem.url, cfProblem.url);

    const luoguMember = memberOf(group, world.luogu.id);
    assert.equal(luoguMember.accountId, null, 'no Luogu account of that instance was selected');
    assert.equal(luoguMember.problem.solvedByAccount, false, 'a linked AC never becomes a direct solve');
    assert.equal(Object.hasOwn(luoguMember.problem, 'rawTags'), false, 'linked evidence must not reveal tags');
    assert.equal(Object.hasOwn(luoguMember.problem, 'effectiveTaxonomyIds'), false);
    assert.equal(luoguMember.problem.problemKey, luoguProblem.key);

    // The same data with the other Luogu account selected: the pair is unconfirmed, because the
    // student who solved it is not part of the selection.
    const isolated = await service.browseMergedProblems(
      { accountIds: [world.luoguAccount.id], status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(isolated.totalItems, 0, 'an unselected account can never confer solved status');
    const unconfirmed = await service.browseMergedProblems(
      { accountIds: [world.luoguAccount.id], status: 'unconfirmed', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(unconfirmed.totalItems, 2);
    assert.equal(groupOf(unconfirmed, MIRROR_1A).attempted, false, 'the other student never attempted it');
  });
});

void test('a Luogu AC for CF1A solves the Codeforces member row and flips with the selection', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    const cfProblem = fx.makeProblem(fx.makeRef(world.cf, '1A'), { title: 'Theatre Square' });
    const luoguProblem = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'), { title: 'A+B Problem' });
    await store.upsertProblems([cfProblem, luoguProblem]);
    const luoguAc = fx.makeSubmission(world.luoguAccount, luoguProblem.ref, 'L1', 'accepted', AT);
    await store.upsertSubmissions([luoguAc]);

    const page = await service.browseMergedProblems(
      { accountIds: [world.luoguAccount.id], page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(page.totalItems, 1);
    const group = groupOf(page, MIRROR_1A);
    assert.deepEqual(group.acceptedEvidence, [
      {
        accountId: world.luoguAccount.id,
        problemKey: luoguProblem.key,
        sourceInstanceId: world.luogu.id,
        externalKey: 'CF1A',
        submissionId: luoguAc.id,
        submittedAt: AT,
      },
    ]);
    assert.equal(memberOf(group, world.cf.id).problem.solvedByAccount, false);
    assert.equal(Object.hasOwn(memberOf(group, world.cf.id).problem, 'rawTags'), false);
    assert.equal(memberOf(group, world.luogu.id).problem.solvedByAccount, true);

    // The Codeforces member exists, so a Codeforces source filter still finds the solved group even
    // though the AC came from the Luogu account.
    const cfFiltered = await service.browseMergedProblems(
      { accountIds: [world.luoguAccount.id], sourceInstanceId: world.cf.id, status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(cfFiltered.totalItems, 1);
    assert.equal(groupOf(cfFiltered, MIRROR_1A).members.length, 2);

    // Changing the selection changes the verdict for exactly the same stored data.
    const otherSelection = await service.browseMergedProblems(
      { accountIds: [world.cfAccount.id], status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(otherSelection.totalItems, 0);
    const otherUnconfirmed = await service.browseMergedProblems(
      { accountIds: [world.cfAccount.id], status: 'unconfirmed', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(otherUnconfirmed.totalItems, 1);
    assert.equal(groupOf(otherUnconfirmed, MIRROR_1A).solved, false);
  });
});

void test('linked evidence works when the accepted problem has no stored metadata row', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    // Only the local Luogu mirror row exists; the Codeforces 1A metadata was never fetched.
    const luoguProblem = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'), { title: 'A+B Problem' });
    const cfRef = fx.makeRef(world.cf, '1A');
    const cfAc = fx.makeSubmission(world.cfAccount, cfRef, 'S1', 'accepted', AT);
    await store.upsertProblems([luoguProblem]);
    await store.upsertSubmissions([cfAc]);

    const page = await service.browseMergedProblems({ accountIds: [world.cfAccount.id], page: 1, limit: 25 }, TOKEN);
    assert.equal(page.totalItems, 1);
    const group = groupOf(page, MIRROR_1A);
    assert.equal(group.members.length, 1, 'no metadata is invented for the missing side');
    assert.equal(group.members[0]?.problem.problemKey, luoguProblem.key);
    assert.equal(group.solved, true, 'the canonical submission identity is enough');
    assert.deepEqual(group.acceptedEvidence, [
      {
        accountId: world.cfAccount.id,
        problemKey: problemKey(cfRef),
        sourceInstanceId: world.cf.id,
        externalKey: '1A',
        submissionId: cfAc.id,
        submittedAt: AT,
      },
    ]);
    assert.equal(memberOf(group, world.luogu.id).problem.solvedByAccount, false);

    // The source filter follows member composition, not evidence: there is no Codeforces member row.
    const cfOnly = await service.browseMergedProblems(
      { accountIds: [world.cfAccount.id], sourceInstanceId: world.cf.id, page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(cfOnly.totalItems, 0);
    const luoguOnly = await service.browseMergedProblems(
      { accountIds: [world.cfAccount.id], sourceInstanceId: world.luogu.id, status: 'solved', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(luoguOnly.totalItems, 1);
    // Member search finds the pair through the Luogu spelling of the Codeforces identity.
    const searched = await service.browseMergedProblems(
      { accountIds: [world.cfAccount.id], query: '1A', page: 1, limit: 25 },
      TOKEN,
    );
    assert.equal(searched.totalItems, 1);
  });
});

// ---------------------------------------------------------------------------------------
// Grouping boundaries
// ---------------------------------------------------------------------------------------

void test('the source filter is about member composition and member search finds either spelling', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    const cfProblem = fx.makeProblem(fx.makeRef(world.cf, '1A'), { title: 'Theatre Square' });
    const luoguProblem = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'), { title: 'A+B Problem' });
    const luoguSolo = fx.makeProblem(fx.makeRef(world.luogu, 'P1000'), { title: 'A+B Problem (easy)' });
    const cfSolo = fx.makeProblem(fx.makeRef(world.cf, '4A'), { title: 'Watermelon' });
    await store.upsertProblems([cfProblem, luoguProblem, luoguSolo, cfSolo]);

    const all = await service.browseMergedProblems({ page: 1, limit: 25 }, TOKEN);
    assert.equal(all.totalItems, 3, 'an empty selection lists every group');
    assert.equal(all.items.every((item) => item.solved === false), true);
    assert.equal(all.items.every((item) => item.attempted === false), true);

    const cfSource = await service.browseMergedProblems({ sourceInstanceId: world.cf.id, page: 1, limit: 25 }, TOKEN);
    assert.deepEqual(
      cfSource.items.map((item) => item.groupKey).sort(),
      [MIRROR_1A, 'merged:cf:4A'].sort(),
      'a Codeforces main-problemset problem is a recognized identity even with one member',
    );
    const luoguSource = await service.browseMergedProblems(
      { sourceInstanceId: world.luogu.id, page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      luoguSource.items.map((item) => item.groupKey).sort(),
      [MIRROR_1A, luoguSolo.key].sort(),
    );

    // A mixed filter: the group is selected by its Codeforces member while the search term comes
    // from the Luogu spelling of the same identity.
    const mixed = await service.browseMergedProblems(
      { sourceInstanceId: world.cf.id, query: 'CF1A', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(mixed.items.map((item) => item.groupKey), [MIRROR_1A]);
    assert.deepEqual(
      (await service.browseMergedProblems({ query: 'Watermelon', page: 1, limit: 25 }, TOKEN)).items.map(
        (item) => item.groupKey,
      ),
      ['merged:cf:4A'],
    );
    assert.equal((await service.browseMergedProblems({ query: 'nothing-matches', page: 1, limit: 25 }, TOKEN)).totalItems, 0);
  });
});

void test('gym, non-canonical and numeric references stay separate while zero-padded indices stay exact', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    const otherCf = fx.makeInstance('codeforces', 'www.codeforces.com');
    await store.upsertSourceInstances([otherCf]);

    const pairCf = fx.makeProblem(fx.makeRef(world.cf, '1A'));
    const pairLuogu = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'));
    const gym = fx.makeProblem(fx.makeRef(world.cf, '1A', 'gym'));
    const lowerCase = fx.makeProblem(fx.makeRef(world.luogu, 'cf1a'));
    const leadingZero = fx.makeProblem(fx.makeRef(world.luogu, 'CF01A'));
    const numeric = fx.makeProblem(fx.makeRef(world.cf, '921/01'));
    const tooLarge = fx.makeProblem(fx.makeRef(world.cf, '100000A'));
    const suffixCf = fx.makeProblem(fx.makeRef(world.cf, '1D10'));
    const suffixLuogu = fx.makeProblem(fx.makeRef(world.luogu, 'CF1D10'));
    const zeroSuffixCf = fx.makeProblem(fx.makeRef(world.cf, '1A0'));
    const zeroSuffixLuogu = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A0'));
    const paddedSuffixCf = fx.makeProblem(fx.makeRef(world.cf, '1A01'));
    const paddedSuffixLuogu = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A01'));
    const e1Cf = fx.makeProblem(fx.makeRef(world.cf, '1E1'));
    const e1Luogu = fx.makeProblem(fx.makeRef(world.luogu, 'CF1E1'));
    const e2Cf = fx.makeProblem(fx.makeRef(world.cf, '1E2'));
    const e2Luogu = fx.makeProblem(fx.makeRef(world.luogu, 'CF1E2'));
    const sameTitleLuogu = fx.makeProblem(fx.makeRef(world.luogu, 'P1000'), { title: 'Watermelon' });
    const sameTitleCf = fx.makeProblem(fx.makeRef(world.cf, '4A'), { title: 'Watermelon' });
    const otherInstance = fx.makeProblem(fx.makeRef(otherCf, '1A'));
    const problems = [
      pairCf,
      pairLuogu,
      gym,
      lowerCase,
      leadingZero,
      numeric,
      tooLarge,
      suffixCf,
      suffixLuogu,
      zeroSuffixCf,
      zeroSuffixLuogu,
      paddedSuffixCf,
      paddedSuffixLuogu,
      e1Cf,
      e1Luogu,
      e2Cf,
      e2Luogu,
      sameTitleLuogu,
      sameTitleCf,
      otherInstance,
    ];
    await store.upsertProblems(problems);

    const page = await service.browseMergedProblems({ page: 1, limit: 100 }, TOKEN);
    const mirrorKeys = page.items.filter((item) => item.mappingKind === 'luogu_cf_identifier').map((item) => item.groupKey);
    const singleKeys = page.items.filter((item) => item.mappingKind === 'single').map((item) => item.groupKey);
    assert.equal(page.totalItems, 14, 'each zero-padded index is a distinct identity');
    assert.deepEqual(
      mirrorKeys.sort(),
      // `4A` is a canonical main-problemset identity too, so it is a recognized group with one
      // member; a zero-padded suffix is an exact identity of its own, never normalized to `1A`/`1A1`.
      [
        'merged:cf:1A',
        'merged:cf:1A0',
        'merged:cf:1A01',
        'merged:cf:1D10',
        'merged:cf:1E1',
        'merged:cf:1E2',
        'merged:cf:4A',
      ].sort(),
    );
    assert.equal(singleKeys.length, 7);
    assert.notEqual(groupOf(page, 'merged:cf:1E1').groupKey, groupOf(page, 'merged:cf:1E2').groupKey);
    assert.equal(groupOf(page, 'merged:cf:1E1').members.length, 2);
    assert.equal(groupOf(page, 'merged:cf:1E2').members.length, 2);
    for (const groupKey of ['merged:cf:1A0', 'merged:cf:1A01']) {
      assert.equal(groupOf(page, groupKey).members.length, 2, `${groupKey} pairs both spellings`);
      assert.notEqual(groupOf(page, groupKey).groupKey, MIRROR_1A);
    }
    assert.notEqual(groupOf(page, 'merged:cf:1A0').groupKey, groupOf(page, 'merged:cf:1A01').groupKey);

    // Every unrecognized reference keeps its own canonical key as its group (and gym stays separate
    // from the main-problemset problem with the same external key).
    for (const problem of [gym, lowerCase, leadingZero, numeric, tooLarge, sameTitleLuogu, otherInstance]) {
      assert.equal(groupOf(page, problem.key).mappingKind, 'single');
      assert.equal(groupOf(page, problem.key).members.length, 1);
      assert.equal(groupOf(page, problem.key).members[0]?.problem.problemKey, problem.key);
    }
    // A recognized Codeforces identity is never presented under its own canonical key, and a title it
    // shares with an unrelated Luogu row never merges the two: `4A` stays ONE member.
    const cf4a = groupOf(page, 'merged:cf:4A');
    assert.equal(cf4a.mappingKind, 'luogu_cf_identifier');
    assert.equal(cf4a.members.length, 1);
    assert.equal(cf4a.members[0]?.problem.problemKey, sameTitleCf.key);
    assert.equal(cf4a.members[0]?.problem.title, 'Watermelon');
    assert.equal(groupOf(page, sameTitleLuogu.key).members[0]?.problem.title, 'Watermelon');
    assert.notEqual(groupOf(page, sameTitleLuogu.key).groupKey, cf4a.groupKey);
  });
});

// ---------------------------------------------------------------------------------------
// Order, paging and sorting
// ---------------------------------------------------------------------------------------

void test('grouping happens before counting and paging, and an out-of-range page clamps', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    const pairCf = fx.makeProblem(fx.makeRef(world.cf, '1A'));
    const pairLuogu = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'));
    const singles = Array.from({ length: 29 }, (_, index) =>
      fx.makeProblem(fx.makeRef(world.luogu, `Q${String(index).padStart(3, '0')}`), { title: 'Ranked routine' }),
    );
    await store.upsertProblems([pairCf, pairLuogu, ...singles]);

    const first = await service.browseMergedProblems({ page: 1, limit: 25 }, TOKEN);
    assert.equal(first.totalItems, 30, 'the pair counts once');
    assert.equal(first.totalPages, 2);
    assert.equal(first.items.length, 25);

    const second = await service.browseMergedProblems({ page: 2, limit: 25 }, TOKEN);
    assert.equal(second.page, 2);
    assert.equal(second.items.length, 5);
    const clamped = await service.browseMergedProblems({ page: 99, limit: 25 }, TOKEN);
    assert.equal(clamped.page, 2, 'a page beyond the last group clamps to the last valid page');
    assert.deepEqual(
      clamped.items.map((item) => item.groupKey),
      second.items.map((item) => item.groupKey),
    );

    // No group is ever skipped or repeated across the two pages.
    const all = [...first.items, ...second.items].map((item) => item.groupKey);
    assert.equal(new Set(all).size, 30);
    assert.equal(all.includes(MIRROR_1A), true);

    // Deterministic ties: two identical requests return exactly the same order.
    const again = await service.browseMergedProblems({ page: 1, limit: 25 }, TOKEN);
    assert.deepEqual(
      again.items.map((item) => item.groupKey),
      first.items.map((item) => item.groupKey),
    );

    // Title order falls back to the group key when every title is equal.
    const byTitle = await service.browseMergedProblems({ sort: 'title_asc', page: 1, limit: 100 }, TOKEN);
    const tiedKeys = byTitle.items.filter((item) => item.members.every((m) => m.problem.title === 'Ranked routine')).map((item) => item.groupKey);
    assert.deepEqual(tiedKeys, [...tiedKeys].sort(), 'a title tie is broken by the canonical group key');
    const titles = byTitle.items.map((item) => [...item.members.map((m) => m.problem.title)].sort()[0] ?? '');
    assert.deepEqual(titles, [...titles].sort(), 'titles are returned in a sorted order');

    // Natural problem order: P2 before P10 before P100 whatever their key lengths.
    const naturalRefs = ['P2', 'P10', 'P100'].map((key) => fx.makeProblem(fx.makeRef(world.luogu, key)));
    await store.upsertProblems(naturalRefs);
    const natural = await service.browseMergedProblems({ sort: 'problem_asc', page: 1, limit: 100 }, TOKEN);
    const positions = naturalRefs.map((problem) => natural.items.findIndex((item) => item.groupKey === problem.key));
    assert.equal(positions[0]! < positions[1]! && positions[1]! < positions[2]!, true, 'natural key order');

    const empty = await service.browseMergedProblems({ query: 'nothing-matches-this', page: 4, limit: 25 }, TOKEN);
    assert.equal(empty.totalItems, 0);
    assert.equal(empty.totalPages, 0);
    assert.equal(empty.page, 1);
    assert.deepEqual(empty.items, []);
  });
});

void test('a difficulty sort reads the requested source member and puts an unknown value last', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    const easy = rated(fx.makeRef(world.luogu, 'P1'), 1, 'Easy');
    const medium = rated(fx.makeRef(world.luogu, 'P2'), 3, 'Medium');
    const hard = rated(fx.makeRef(world.luogu, 'P3'), 7, 'Hard');
    const unrated = rated(fx.makeRef(world.luogu, 'P4'), null, 'Unrated');
    // The mirror pair is rated on the Luogu side only: the Codeforces member carries `rating`.
    const pairLuogu = rated(fx.makeRef(world.luogu, 'CF1A'), 2, 'Mirror');
    const pairCf = fx.makeProblem(fx.makeRef(world.cf, '1A'), { title: 'Theatre Square' });
    await store.upsertProblems([easy, medium, hard, unrated, pairLuogu, pairCf]);

    const ascending = await service.browseMergedProblems(
      { sourceInstanceId: world.luogu.id, sort: 'difficulty_asc', ratingDimension: 'difficulty', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      ascending.items.map((item) => item.groupKey),
      [easy.key, MIRROR_1A, medium.key, hard.key, unrated.key],
      'the unknown value sorts last even though its group is otherwise lowest',
    );
    const descending = await service.browseMergedProblems(
      { sourceInstanceId: world.luogu.id, sort: 'difficulty_desc', ratingDimension: 'difficulty', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      descending.items.map((item) => item.groupKey),
      [hard.key, medium.key, MIRROR_1A, easy.key, unrated.key],
      'unknown stays last in both directions',
    );

    await rejectsDomain(
      service.browseMergedProblems({ sort: 'difficulty_asc', ratingDimension: 'difficulty', page: 1, limit: 25 }, TOKEN),
      'invalid_input',
      'rating_source_required',
    );
    await rejectsDomain(
      service.browseMergedProblems({ sourceInstanceId: world.luogu.id, sort: 'difficulty_asc', page: 1, limit: 25 }, TOKEN),
      'invalid_input',
      'rating_dimension_required',
    );
  });
});

void test('a descending sort reverses the same display member instead of switching members', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    // The pair's two spellings sit on opposite sides of the standalone Luogu keys (`1A` before `A1`,
    // `CF1A` after `B1`) and carry different translations of one title. A sort that read MIN
    // ascending and MAX descending — of the keys or of the two titles — would move the pair when only
    // the direction changed.
    const pairCf = fx.makeProblem(fx.makeRef(world.cf, '1A'), { title: 'Alpha' });
    const pairLuogu = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'), { title: 'Zulu' });
    const first = fx.makeProblem(fx.makeRef(world.luogu, 'A1'), { title: 'Bravo' });
    const second = fx.makeProblem(fx.makeRef(world.luogu, 'B1'), { title: 'Mike' });
    await store.upsertProblems([pairCf, pairLuogu, first, second]);

    const ascending = await service.browseMergedProblems(
      { sourceInstanceId: world.luogu.id, sort: 'problem_asc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      ascending.items.map((item) => item.groupKey),
      [first.key, second.key, MIRROR_1A],
      "a Luogu source filter sorts the pair by its Luogu member's own canonical key (CF1A)",
    );
    const descending = await service.browseMergedProblems(
      { sourceInstanceId: world.luogu.id, sort: 'problem_desc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      descending.items.map((item) => item.groupKey),
      [...ascending.items.map((item) => item.groupKey)].reverse(),
      'a descending sort only reverses the same display member',
    );

    // Without a source filter the display member is the least canonical key of the group (`1A`), so
    // the pair leads; the direction still reverses that one value.
    const unfiltered = await service.browseMergedProblems({ sort: 'problem_asc', page: 1, limit: 25 }, TOKEN);
    assert.deepEqual(
      unfiltered.items.map((item) => item.groupKey),
      [MIRROR_1A, first.key, second.key],
    );
    const unfilteredDesc = await service.browseMergedProblems({ sort: 'problem_desc', page: 1, limit: 25 }, TOKEN);
    assert.deepEqual(
      unfilteredDesc.items.map((item) => item.groupKey),
      [second.key, first.key, MIRROR_1A],
    );

    // The same rule for titles: the pair is sorted by its Luogu member's translated title (`Zulu`),
    // not by the Codeforces title (`Alpha`), and the descending order reverses that same choice.
    const titles = await service.browseMergedProblems(
      { sourceInstanceId: world.luogu.id, sort: 'title_asc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      titles.items.map((item) => item.groupKey),
      [first.key, second.key, MIRROR_1A],
      "the title sort reads the requested source member's own title",
    );
    const paired = groupOf(titles, MIRROR_1A);
    assert.equal(memberOf(paired, world.cf.id).problem.title, 'Alpha');
    assert.equal(memberOf(paired, world.luogu.id).problem.title, 'Zulu');
    const titlesDesc = await service.browseMergedProblems(
      { sourceInstanceId: world.luogu.id, sort: 'title_desc', page: 1, limit: 25 },
      TOKEN,
    );
    assert.deepEqual(
      titlesDesc.items.map((item) => item.groupKey),
      [...titles.items.map((item) => item.groupKey)].reverse(),
      'a descending title sort reverses the same member',
    );
  });
});

// ---------------------------------------------------------------------------------------
// Refusals, cancellation and hostile stores
// ---------------------------------------------------------------------------------------

void test('merged browse validates every field, needs accounts for solved filters and observes cancellation', async () => {
  await withBench(async ({ store, service }) => {
    const world = await seedWorld(store);
    await store.upsertProblems([fx.makeProblem(fx.makeRef(world.cf, '1A'))]);

    for (const limit of [0, 101, 2.5]) {
      await rejectsDomain(service.browseMergedProblems({ page: 1, limit }, TOKEN), 'invalid_input');
    }
    for (const page of [0, -1, 1.5]) {
      await rejectsDomain(service.browseMergedProblems({ page, limit: 25 }, TOKEN), 'invalid_input');
    }
    await rejectsDomain(
      service.browseMergedProblems({ page: 1, limit: 25, status: 'maybe' as 'solved' }, TOKEN),
      'invalid_input',
    );
    await rejectsDomain(
      service.browseMergedProblems({ page: 1, limit: 25, sort: 'by_vibes' as 'default' }, TOKEN),
      'invalid_input',
    );
    await rejectsDomain(
      service.browseMergedProblems({ page: 1, limit: 25, status: 'solved' }, TOKEN),
      'invalid_input',
      'status_without_account',
    );
    await rejectsDomain(
      service.browseMergedProblems({ page: 1, limit: 25, onlyAttempted: true }, TOKEN),
      'invalid_input',
      'only_attempted_without_account',
    );
    await rejectsDomain(
      service.browseMergedProblems({ accountIds: ['no-such-account'], page: 1, limit: 25 }, TOKEN),
      'missing_reference',
    );
    await rejectsDomain(
      service.browseMergedProblems(
        { accountIds: [world.luoguAccount.id, world.luoguAccount.id], page: 1, limit: 25 },
        TOKEN,
      ),
      'invalid_input',
      'duplicate_account',
    );
    await rejectsDomain(
      service.browseMergedProblems(
        { accountIds: [world.luoguAccount.id, world.otherStudent.id], page: 1, limit: 25 },
        TOKEN,
      ),
      'invalid_input',
      'duplicate_account_source',
    );
    await rejectsDomain(
      service.browseMergedProblems(
        { accountIds: Array.from({ length: 33 }, (_, index) => `account-${index}`), page: 1, limit: 25 },
        TOKEN,
      ),
      'invalid_input',
      'too_many_accounts',
    );
    await rejectsDomain(
      service.browseMergedProblems({ page: 1, limit: 25, query: '   ' }, TOKEN),
      'invalid_input',
    );
    await rejectsDomain(
      service.browseMergedProblems({ page: 1, limit: 25, query: 'x'.repeat(201) }, TOKEN),
      'invalid_input',
    );
    await rejectsDomain(
      service.browseMergedProblems({ page: 1, limit: 25, accountIds: 'alice' as unknown as readonly string[] }, TOKEN),
      'invalid_input',
    );

    const cancelled = createCancellationSource();
    cancelled.cancel('test');
    await rejectsDomain(service.browseMergedProblems({ page: 1, limit: 25 }, cancelled.token), 'cancelled');
  });
});

void test('a hostile store cannot fabricate a solve, borrow an account or reveal spoilers', async () => {
  let hostile: (() => Promise<MergedProblemBrowsePage>) | null = null;
  await withBench(
    async ({ store, service }) => {
      const world = await seedWorld(store);
      const cfProblem = fx.makeProblem(fx.makeRef(world.cf, '1A'));
      const luoguProblem = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'));
      const otherProblem = fx.makeProblem(fx.makeRef(world.cf, '4A'));
      await store.upsertProblems([cfProblem, luoguProblem, otherProblem]);
      const accepted = fx.makeSubmission(world.cfAccount, cfProblem.ref, 'S1', 'accepted', AT);
      const foreignAccepted = fx.makeSubmission(world.luoguAccount, luoguProblem.ref, 'S2', 'accepted', AT);
      const rejected = fx.makeSubmission(world.cfAccount, cfProblem.ref, 'S3', 'wrong_answer', AT);
      const otherAccepted = fx.makeSubmission(world.cfAccount, otherProblem.ref, 'S4', 'accepted', AT);
      await store.upsertSubmissions([accepted, foreignAccepted, rejected, otherAccepted]);

      // The real page is the template every hostile claim is a mutation of.
      const real = await store.browseMergedProblems({ accountIds: [world.cfAccount.id], page: 1, limit: 25 });
      const realGroup = real.items.find((item) => item.groupKey === MIRROR_1A);
      assert.ok(realGroup);
      const member = (sourceInstanceId: string) => {
        const found = realGroup.members.find((entry) => entry.problem.ref.sourceInstanceId === sourceInstanceId);
        assert.ok(found);
        return { ...found };
      };
      const evidence = (overrides: Partial<MergedProblemEvidenceRow>): MergedProblemEvidenceRow => ({
        accountId: world.cfAccount.id,
        problemKey: cfProblem.key,
        sourceInstanceId: world.cf.id,
        externalKey: '1A',
        submissionId: accepted.id,
        submittedAt: AT,
        ...overrides,
      });
      const group = (overrides: Partial<MergedProblemGroupRow>): MergedProblemGroupRow => ({
        ...realGroup,
        ...overrides,
      });
      const cases: readonly (readonly [string, MergedProblemGroupRow, string])[] = [
        ['a solved flag with no evidence', group({ solved: true, acceptedEvidence: [] }), 'merged_solved_without_evidence'],
        [
          'evidence that is not stored',
          group({ solved: true, acceptedEvidence: [evidence({ submissionId: 'submission-not-stored' })] }),
          'merged_evidence_missing',
        ],
        [
          'evidence that is not accepted',
          group({ solved: true, acceptedEvidence: [evidence({ submissionId: rejected.id })] }),
          'merged_evidence_not_accepted',
        ],
        [
          'evidence of an unselected account',
          group({
            solved: true,
            acceptedEvidence: [evidence({ accountId: world.luoguAccount.id, submissionId: foreignAccepted.id })],
          }),
          'merged_evidence_foreign_account',
        ],
        [
          'evidence of another group',
          group({
            solved: true,
            acceptedEvidence: [
              evidence({ problemKey: otherProblem.key, externalKey: '4A', submissionId: otherAccepted.id }),
            ],
          }),
          'merged_evidence_foreign_group',
        ],
        [
          'evidence with a wrong problem key',
          group({ solved: true, acceptedEvidence: [evidence({ problemKey: otherProblem.key })] }),
          'merged_evidence_key_mismatch',
        ],
        [
          'evidence with a wrong timestamp',
          group({ solved: true, acceptedEvidence: [evidence({ submittedAt: LATER })] }),
          'merged_evidence_timestamp_mismatch',
        ],
        [
          'a duplicate evidence row',
          group({ solved: true, acceptedEvidence: [evidence({}), evidence({})] }),
          'duplicate_merged_evidence',
        ],
        [
          'a member solved without an account',
          group({ members: [{ ...member(world.cf.id), accountId: null, solvedByAccount: true }, member(world.luogu.id)] }),
          'merged_member_solved_without_account',
        ],
        [
          'a member claiming a direct solve without evidence',
          group({
            members: [{ ...member(world.cf.id), solvedByAccount: true }, member(world.luogu.id)],
            solved: false,
            acceptedEvidence: [],
          }),
          'merged_member_solved_without_evidence',
        ],
        [
          'a member borrowed from another group',
          group({ members: [member(world.cf.id), { ...member(world.cf.id), problem: otherProblem }] }),
          'merged_member_foreign_group',
        ],
        [
          'a duplicated member',
          group({ members: [member(world.luogu.id), member(world.luogu.id)] }),
          'duplicate_merged_member',
        ],
        [
          'a member of a foreign account',
          group({ members: [{ ...member(world.cf.id), accountId: world.otherStudent.id }, member(world.luogu.id)] }),
          'merged_member_foreign_account',
        ],
        [
          'a single group with two members',
          group({
            mappingKind: 'single',
            groupKey: otherProblem.key,
            members: [member(world.cf.id), member(world.luogu.id)],
            solved: false,
            acceptedEvidence: [],
          }),
          'merged_group_member_count',
        ],
        [
          'an unknown mapping kind',
          group({ mappingKind: 'guess' as 'single' }),
          'merged_mapping_kind_unknown',
        ],
      ];
      for (const [name, crafted, reason] of cases) {
        hostile = async () => ({
          items: [crafted],
          page: 1,
          pageSize: 25,
          totalItems: 1,
          totalPages: 1,
          fetchedAt: AT,
        });
        await rejectsDomain(
          service.browseMergedProblems({ accountIds: [world.cfAccount.id], page: 1, limit: 25 }, TOKEN),
          'invalid_input',
          reason,
          name,
        );
      }

      // The same proxy passes a genuine store page through untouched.
      hostile = null;
      const genuine = await service.browseMergedProblems({ accountIds: [world.cfAccount.id], page: 1, limit: 25 }, TOKEN);
      assert.equal(groupOf(genuine, MIRROR_1A).solved, true);
    },
    (real) =>
      new Proxy(real as TrainingStore, {
        get(target, property, receiver) {
          if (property === 'browseMergedProblems') {
            return async (query: MergedProblemBrowseQuery) =>
              hostile === null ? target.browseMergedProblems(query) : hostile();
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }),
  );
});

void test('a merged read writes nothing and leaves the legacy bank endpoints exactly as they were', async () => {
  const writes: string[] = [];
  await withBench(
    async ({ store, service }) => {
      const world = await seedWorld(store);
      const cfProblem = fx.makeProblem(fx.makeRef(world.cf, '1A'), { title: 'Theatre Square' });
      const luoguProblem = fx.makeProblem(fx.makeRef(world.luogu, 'CF1A'), { title: 'A+B Problem' });
      await store.upsertProblems([cfProblem, luoguProblem]);
      await store.upsertSubmissions([fx.makeSubmission(world.cfAccount, cfProblem.ref, 'S1', 'accepted', AT)]);

      const legacyBefore = await service.browseProblems({ page: 1, limit: 25 }, TOKEN);
      const legacySolved = await service.browseProblems(
        { accountId: world.cfAccount.id, status: 'solved', page: 1, limit: 25 },
        TOKEN,
      );
      const listed = await service.listProblems({ limit: 25 }, TOKEN);

      const merged = await service.browseMergedProblems({ accountIds: [world.cfAccount.id], page: 1, limit: 25 }, TOKEN);
      assert.equal(merged.totalItems, 1);
      assert.equal(groupOf(merged, MIRROR_1A).solved, true);

      assert.deepEqual(writes, [], 'a merged read performs no write at all');

      const legacyAfter = await service.browseProblems({ page: 1, limit: 25 }, TOKEN);
      assert.equal(legacyBefore.totalItems, 2, 'the legacy numbered bank still lists both mirror rows');
      assert.deepEqual(
        legacyAfter.items.map((item) => item.problemKey),
        legacyBefore.items.map((item) => item.problemKey),
      );
      assert.deepEqual(
        legacySolved.items.map((item) => item.problemKey),
        [cfProblem.key],
        'the legacy solved filter never merges the other site record',
      );
      assert.deepEqual(
        listed.items.map((item) => item.problemKey),
        [...listed.items.map((item) => item.problemKey)].sort(),
        'the cursor bank is unchanged',
      );
      const legacyRow = legacyAfter.items.find((item) => item.problemKey === luoguProblem.key);
      assert.ok(legacyRow);
      assert.equal(legacyRow.solvedByAccount, false);
      assert.equal(Object.hasOwn(legacyRow, 'mappingKind'), false, 'the legacy rows carry no merged members');
      assert.equal(merged.items[0]?.members[0]?.problem.problemKey, cfProblem.key);
    },
    (real) =>
      new Proxy(real as TrainingStore, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function') {
            return value;
          }
          return (...args: unknown[]) => {
            const name = String(property);
            if (name.startsWith('upsert') || name.startsWith('save')) {
              writes.push(name);
            }
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        },
      }),
  );
});
