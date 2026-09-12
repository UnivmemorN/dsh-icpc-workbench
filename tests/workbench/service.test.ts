/**
 * Workbench read/review service over a real SQLite store.
 *
 * Every case drives the real `WorkbenchService` against a temporary `SqliteTrainingStore`; nothing
 * reaches a platform, a model or the network. The assertions cover the externally meaningful
 * behaviour: whole-bank literal search, the review queue filtering in SQL before pagination,
 * cursor/filter binding, spoiler redaction in the serialized response, manual precedence with
 * monotonic ordering, retrospective validation, strict source/account isolation and cancellation
 * rollback.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type { TrainingStore } from '../../src/application/ports.js';
import {
  MAX_ACCOUNT_SUBMISSIONS,
  MAX_RETROSPECTIVE_IDS,
  WORKBENCH_SUBMISSION_PAGE_SIZE,
  WorkbenchService,
  type WorkbenchServiceOptions,
} from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  DomainError,
  createAnalysisResult,
  createCancellationSource,
  createProblemSnapshot,
  createReasoningDraft,
  createTagDecision,
  createTaxonomyIndex,
  type AnalysisResult,
  type DomainErrorCode,
  type NormalizedProblem,
  type ProblemSnapshot,
  type Submission,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const LATER = '2026-11-01T09:00:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** Two ids that really exist in the shipped vocabulary; reviewTag only accepts known tags. */
const STACK = 'data-structure.stack';
const QUEUE = 'data-structure.queue';
const SEGMENT_TREE = fx.SEGMENT_TREE_TAG;

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly service: WorkbenchService;
  readonly clock: { value: string };
}

async function withBench(
  run: (bench: Bench) => Promise<void>,
  wrap: (store: SqliteTrainingStore) => TrainingStore = (store) => store,
): Promise<void> {
  const paths = fx.tempDatabase();
  const clock = { value: AT };
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
  let minted = 0;
  const serviceOptions: WorkbenchServiceOptions = {
    store: wrap(store),
    taxonomy: TAXONOMY,
    now: () => clock.value,
    uniqueId: () => `page-${(minted += 1)}`,
  };
  const service = new WorkbenchService(serviceOptions);
  try {
    await run({ store, service, clock });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

async function seed(store: SqliteTrainingStore, scope: fx.Scope): Promise<void> {
  await store.upsertSourceInstances([scope.instance]);
  await store.upsertAccounts([scope.account]);
  await store.upsertProblems([scope.problem]);
}

/**
 * Assert that a withheld spoiler member is a missing own property.
 *
 * `undefined` alone would also pass for a member explicitly present with an `undefined` value, so
 * the own-property check is the real assertion; the read check catches a value that leaks through
 * a prototype or a getter.
 */
function assertAbsent(owner: object | null, key: string, label: string): void {
  assert.ok(owner !== null, `${label} must exist`);
  assert.equal(Object.hasOwn(owner, key), false, `${label}.${key} must be absent while withheld`);
  assert.equal((owner as Record<string, unknown>)[key], undefined, `${label}.${key} must not read as a value`);
}

/** Every own key and own string value reachable from `value`, for a recursive sentinel scan. */
function ownStrings(value: unknown, found: string[] = []): readonly string[] {
  if (typeof value === 'string') {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      ownStrings(entry, found);
    }
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      found.push(key);
      ownStrings((value as Record<string, unknown>)[key], found);
    }
  }
  return found;
}

/**
 * A real store whose submission history is a scripted sequence of pages.
 *
 * The bounded walk is exercised against exact page shapes without a 50,000-row database fixture:
 * a `null` cursor starts at the first page, each cursor names the next page (so every walk starts
 * over deterministically), and the last page reports a `null` cursor. `calls` counts page reads,
 * which is how the tests observe an early proof and a full walk.
 */
function scriptedHistoryStore(
  realStore: SqliteTrainingStore,
  pages: readonly (readonly Submission[])[],
): { readonly store: TrainingStore; readonly calls: { count: number } } {
  const calls = { count: 0 };
  const store = new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === 'listSubmissions') {
        return async (_accountId: string, query: { readonly cursor: string | null }) => {
          calls.count += 1;
          const index = query.cursor === null ? 0 : Number.parseInt(query.cursor.slice('submission-cursor-'.length), 10);
          return {
            items: pages[index] ?? [],
            nextCursor: index >= pages.length - 1 ? null : `submission-cursor-${index + 1}`,
            fetchedAt: AT,
          };
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TrainingStore;
  return { store, calls };
}

/**
 * A real store whose submission pages are replaced by `rows`.
 *
 * This reproduces a port that returns a row the caller never asked for — another account's
 * submission, or one whose key no longer matches its reference — without corrupting the database:
 * every write still goes to the real store, and only `listSubmissions` is scripted.
 */
function rowsReturningStore(realStore: SqliteTrainingStore, rows: readonly Submission[]): TrainingStore {
  return new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === 'listSubmissions') {
        return async () => ({ items: rows, nextCursor: null, fetchedAt: AT });
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TrainingStore;
}

/**
 * A real store whose first `listTagDecisions` call installs `replacement` as the current head.
 *
 * The install runs in the caller's async context, i.e. *inside* the service's read transaction, so
 * it deterministically reproduces "the head advances before the projection".
 */
function headAdvancingStore(realStore: SqliteTrainingStore, replacement: ProblemSnapshot): TrainingStore {
  let advanced = false;
  return new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === 'listTagDecisions') {
        return async (problemKeyValue: string) => {
          if (!advanced) {
            advanced = true;
            await target.saveSnapshot(replacement);
          }
          return target.listTagDecisions(problemKeyValue);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TrainingStore;
}

async function rejectsDomain(
  promise: Promise<unknown>,
  code: DomainErrorCode,
  reason?: string,
): Promise<DomainError> {
  let captured: DomainError | null = null;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (reason !== undefined) {
      assert.equal(error.details['reason'], reason);
    }
    captured = error;
    return true;
  });
  assert.ok(captured !== null);
  return captured;
}

function draftAnalysis(
  problem: NormalizedProblem,
  snapshot: ProblemSnapshot,
  taxonomyIds: readonly string[],
  createdAt: string = AT,
): AnalysisResult {
  return createAnalysisResult({
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    taxonomyVersion: fx.TAXONOMY_VERSION,
    createdAt,
    status: 'completed',
    reasoningDrafts: [
      createReasoningDraft({
        problemRef: problem.ref,
        snapshotId: snapshot.snapshotId,
        taxonomyIds,
        rationale: 'reasoning draft without an editorial',
        createdAt,
      }),
    ],
  });
}

function pendingDecision(
  problem: NormalizedProblem,
  snapshot: ProblemSnapshot,
  taxonomyId: string = SEGMENT_TREE,
  decidedAt: string = AT,
) {
  return fx.makeTagDecision(problem, {
    taxonomyId,
    status: 'needs_review',
    origin: 'ai',
    decidedAt,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
  });
}

// ---------------------------------------------------------------------------------------
// Spoiler discipline
// ---------------------------------------------------------------------------------------

void test('detail withholds raw tags, taxonomy ids, analyses and editorial bodies until solved or revealed', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    const analysis = fx.makeAnalysis(scope.problem, snapshot);
    await seed(store, scope);
    await store.saveSnapshot(snapshot);
    await store.saveAnalysis(analysis);
    await store.saveManualDecision(fx.makeManualDecision(scope.problem, STACK, 'accept', AT, 'stack after all'));
    await store.saveTagDecisions([
      createTagDecision({
        problemKey: scope.problem.key,
        taxonomyId: STACK,
        status: 'accepted',
        origin: 'manual',
        decidedAt: AT,
        reasons: ['manual_accept'],
      }),
    ]);
    await store.saveRetrospective(fx.makeRetrospective(scope.problem, scope.account.id, { note: 'solved alone' }));

    const hidden = await service.getProblem({ problemKey: scope.problem.key, accountId: scope.account.id }, TOKEN);
    const secrets = [
      'lazy propagation',
      'segment tree',
      'data structures',
      'data-structure/segment-tree',
      'The editorial solution cites',
      'stack after all',
      'solved alone',
    ];
    const json = JSON.stringify(hidden);
    for (const secret of secrets) {
      assert.equal(json.includes(secret), false, `hidden detail leaked ${JSON.stringify(secret)}`);
    }
    // Recursive scan over own keys and own string values: nothing withheld is reachable anywhere,
    // including the nested snapshot and the retrospective that stays visible as metadata.
    const reachable = ownStrings(hidden);
    for (const secret of secrets) {
      assert.equal(reachable.some((value) => value.includes(secret)), false, `own member leaked ${JSON.stringify(secret)}`);
    }
    assertAbsent(hidden, 'rawTags', 'detail');
    assertAbsent(hidden, 'effectiveTaxonomyIds', 'detail');
    assertAbsent(hidden, 'analyses', 'detail');
    assertAbsent(hidden, 'manualDecisions', 'detail');
    assertAbsent(hidden, 'currentTagDecisions', 'detail');
    assert.ok(hidden.snapshot !== null);
    assertAbsent(hidden.snapshot, 'sources', 'snapshot');
    assertAbsent(hidden.snapshot, 'solutions', 'snapshot');
    assert.equal(hidden.solvedByAccount, false);
    assert.equal(hidden.spoilersVisible, false);
    assert.equal(hidden.title, scope.problem.title);
    assert.equal(hidden.statement, scope.problem.statement);
    assert.deepEqual(hidden.rawRatings, scope.problem.ratings);
    assert.equal(hidden.snapshot.solutionCount, 1);
    assert.equal(hidden.staleAnalysisCount, 0);
    assert.ok(hidden.latestRetrospective !== null);
    assert.equal(hidden.latestRetrospective.mode, 'independent');
    assertAbsent(hidden.latestRetrospective, 'taxonomyIds', 'latestRetrospective');
    assertAbsent(hidden.latestRetrospective, 'solutionIds', 'latestRetrospective');
    assertAbsent(hidden.latestRetrospective, 'note', 'latestRetrospective');

    const revealed = await service.getProblem(
      { problemKey: scope.problem.key, accountId: scope.account.id, reveal: true },
      TOKEN,
    );
    assert.deepEqual(revealed.rawTags, ['data structures', 'segment tree']);
    assert.deepEqual(revealed.effectiveTaxonomyIds, [STACK]);
    assert.equal(revealed.analyses?.length, 1);
    assert.equal(revealed.analyses?.[0]?.current, true);
    assert.equal(revealed.analyses?.[0]?.stale, false);
    assert.equal(revealed.analyses?.[0]?.suggestions[0]?.rationale, analysis.suggestions[0]?.rationale);
    assert.equal(revealed.snapshot?.solutions?.[0]?.text, snapshot.solutions[0]?.text);
    assert.equal(revealed.snapshot?.sources?.[0]?.title, snapshot.sources[0]?.title);
    assert.equal(revealed.manualDecisions?.[0]?.note, 'stack after all');
    assert.equal(revealed.latestRetrospective?.note, 'solved alone');
    assert.deepEqual(revealed.latestRetrospective?.taxonomyIds, [SEGMENT_TREE]);
  });
});

void test('an accepted submission of the selected account reveals its own problem without reveal', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const other = fx.makeProblem(fx.makeRef(scope.instance, '1B'));
    await seed(store, scope);
    await store.upsertProblems([other]);
    await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted')]);

    const solved = await service.getProblem({ problemKey: scope.problem.key, accountId: scope.account.id }, TOKEN);
    assert.equal(solved.solvedByAccount, true);
    assert.equal(solved.spoilersVisible, true);
    assert.deepEqual(solved.rawTags, ['data structures', 'segment tree']);

    const unsolved = await service.getProblem({ problemKey: other.key, accountId: scope.account.id }, TOKEN);
    assert.equal(unsolved.solvedByAccount, false);
    assertAbsent(unsolved, 'rawTags', 'unsolved detail');

    const noAccount = await service.getProblem({ problemKey: scope.problem.key, accountId: null }, TOKEN);
    assert.equal(noAccount.solvedByAccount, false);
    assertAbsent(noAccount, 'rawTags', 'anonymous detail');
    assertAbsent(noAccount, 'analyses', 'anonymous detail');
  });
});

// ---------------------------------------------------------------------------------------
// Bank list: paging, search, solved context
// ---------------------------------------------------------------------------------------

void test('bank search is literal, case-insensitive and runs over the whole bank before paging', async () => {
  await withBench(async ({ store, service }) => {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const percent = fx.makeProblem(fx.makeRef(instance, 'P1'), { title: 'Percent 100%_literal' });
    const decoy = fx.makeProblem(fx.makeRef(instance, 'P2'), { title: 'Percent 100XYliteral' });
    const alpha = ['P3', 'P4', 'P5', 'P6'].map((key) =>
      fx.makeProblem(fx.makeRef(instance, key), { title: `Alpha routine ${key}` }),
    );
    const nebula = fx.makeProblem(fx.makeRef(instance, 'P9'), { title: 'Nebula folding' });
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems([percent, decoy, ...alpha, nebula]);

    const literal = await service.listProblems({ limit: 10, cursor: null, query: '100%_' }, TOKEN);
    assert.deepEqual(literal.items.map((item) => item.problemKey), [percent.key]);
    const underscore = await service.listProblems({ limit: 10, cursor: null, query: '_' }, TOKEN);
    assert.deepEqual(underscore.items.map((item) => item.problemKey), [percent.key]);

    // The match sorts beyond the first unfiltered page: only SQL-side filtering can find it.
    const unfiltered = await service.listProblems({ limit: 2, cursor: null }, TOKEN);
    assert.equal(unfiltered.items.some((item) => item.problemKey === nebula.key), false);
    const found = await service.listProblems({ limit: 2, cursor: null, query: 'NEBULA' }, TOKEN);
    assert.deepEqual(found.items.map((item) => item.problemKey), [nebula.key]);
    assert.equal(found.nextCursor, null);
    assert.match(found.pageId, /^page-\d+$/, 'the injected uniqueId mints the page correlation id');

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await service.listProblems({ limit: 2, cursor, query: 'alpha' }, TOKEN);
      collected.push(...page.items.map((item) => item.problemKey));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages <= 5, 'paging must terminate');
      if (cursor !== null) {
        // A cursor is bound to the whole filter set; reusing it for another query is refused.
        await rejectsDomain(
          service.listProblems({ limit: 2, cursor, query: 'alpha routine P6' }, TOKEN),
          'invalid_input',
          'cursor_filter_mismatch',
        );
      }
    } while (cursor !== null);
    assert.equal(collected.length, 4);
    assert.equal(new Set(collected).size, 4);
  });
});

void test('the bank list uses the selected account only as solved/spoiler context', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const unsolved = fx.makeProblem(fx.makeRef(scope.instance, '1B'));
    await seed(store, scope);
    await store.upsertProblems([unsolved]);
    await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted')]);
    await store.saveSnapshot(fx.makeSnapshot(scope.problem));
    await store.saveTagDecisions([
      createTagDecision({
        problemKey: scope.problem.key,
        taxonomyId: STACK,
        status: 'auto_adopted',
        origin: 'ai',
        decidedAt: AT,
        reasons: ['evidence_verified'],
        snapshotId: fx.makeSnapshot(scope.problem).snapshotId,
        snapshotVersion: 1,
      }),
    ]);

    const all = await service.listProblems({ accountId: scope.account.id, limit: 10, cursor: null }, TOKEN);
    assert.equal(all.items.length, 2, 'the account context never restricts the bank by itself');
    const solvedRow = all.items.find((item) => item.problemKey === scope.problem.key);
    const unsolvedRow = all.items.find((item) => item.problemKey === unsolved.key);
    assert.equal(solvedRow?.solvedByAccount, true);
    assert.deepEqual(solvedRow?.effectiveTaxonomyIds, [STACK]);
    assert.ok(unsolvedRow);
    assert.equal(unsolvedRow.solvedByAccount, false);
    assertAbsent(unsolvedRow, 'rawTags', 'unsolved row');
    assertAbsent(unsolvedRow, 'effectiveTaxonomyIds', 'unsolved row');

    const attempted = await service.listProblems(
      { accountId: scope.account.id, onlyAttempted: true, limit: 10, cursor: null },
      TOKEN,
    );
    assert.deepEqual(attempted.items.map((item) => item.problemKey), [scope.problem.key]);
    assert.equal(attempted.pendingReviewOnly, false);
    assert.equal(attempted.items[0]?.pendingReview, null);
  });
});

// ---------------------------------------------------------------------------------------
// Review queue (needsReviewOnly)
// ---------------------------------------------------------------------------------------

void test('review queue returns draft-only problems and one beyond the first unfiltered page', async () => {
  await withBench(async ({ store, service }) => {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const plain = ['P1', 'P2', 'P3', 'P4'].map((key) => fx.makeProblem(fx.makeRef(instance, key)));
    const pending = fx.makeProblem(fx.makeRef(instance, 'P9'));
    const snapshot = fx.makeSnapshot(pending);
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems([...plain, pending]);
    await store.saveSnapshot(snapshot);
    await store.saveAnalysis(draftAnalysis(pending, snapshot, [STACK]));

    const unfiltered = await service.listProblems({ limit: 2, cursor: null }, TOKEN);
    assert.deepEqual(
      unfiltered.items.map((item) => item.problemKey),
      plain.slice(0, 2).map((problem) => problem.key),
    );

    const queue = await service.listProblems({ limit: 2, cursor: null, needsReviewOnly: true }, TOKEN);
    assert.deepEqual(queue.items.map((item) => item.problemKey), [pending.key]);
    const queued = queue.items[0];
    assert.ok(queued);
    assert.equal(queued.pendingReview, true);
    assertAbsent(queued, 'rawTags', 'queued row');
    assert.equal(queue.pendingReviewOnly, true);
    assert.equal(queue.nextCursor, null);
  });
});

void test('review queue drops manual resolutions, superseded AI decisions and stale snapshots', async () => {
  await withBench(async ({ store, service }) => {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const manualCase = fx.makeProblem(fx.makeRef(instance, 'P1'));
    const superseded = fx.makeProblem(fx.makeRef(instance, 'P2'));
    const staleHead = fx.makeProblem(fx.makeRef(instance, 'P3'));
    const draftManual = fx.makeProblem(fx.makeRef(instance, 'P4'));
    const draftStale = fx.makeProblem(fx.makeRef(instance, 'P5'));
    const problems = [manualCase, superseded, staleHead, draftManual, draftStale];
    const snapshots = problems.map((problem) => fx.makeSnapshot(problem));
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems(problems);
    for (const snapshot of snapshots) {
      await store.saveSnapshot(snapshot);
    }

    // P1: current AI needs_review, resolved by a manual reject.
    await store.saveAnalysis(fx.makeAnalysis(manualCase, snapshots[0] as ProblemSnapshot));
    await store.saveTagDecisions([pendingDecision(manualCase, snapshots[0] as ProblemSnapshot, SEGMENT_TREE)]);
    await store.saveManualDecision(fx.makeManualDecision(manualCase, SEGMENT_TREE, 'reject', LATER));

    // P2: needs_review superseded by a newer decision on the same tag.
    await store.saveTagDecisions([
      pendingDecision(superseded, snapshots[1] as ProblemSnapshot, SEGMENT_TREE, AT),
      fx.makeTagDecision(superseded, {
        taxonomyId: SEGMENT_TREE,
        status: 'auto_adopted',
        origin: 'ai',
        decidedAt: LATER,
        snapshotId: (snapshots[1] as ProblemSnapshot).snapshotId,
        snapshotVersion: (snapshots[1] as ProblemSnapshot).version,
      }),
    ]);

    // P3: needs_review written for a snapshot that is no longer the head.
    await store.saveTagDecisions([pendingDecision(staleHead, snapshots[2] as ProblemSnapshot, SEGMENT_TREE)]);
    const movedHead = fx.makeSnapshot(fx.makeProblem(staleHead.ref, { statement: 'changed statement' }), {
      previous: snapshots[2],
      capturedAt: LATER,
    });
    await store.saveSnapshot(movedHead);

    // P4: reasoning draft whose tag a human already rejected.
    await store.saveAnalysis(draftAnalysis(draftManual, snapshots[3] as ProblemSnapshot, [STACK]));
    await store.saveManualDecision(fx.makeManualDecision(draftManual, STACK, 'reject', LATER));

    // P5: reasoning draft of an analysis that is stale against the current head.
    await store.saveAnalysis(draftAnalysis(draftStale, snapshots[4] as ProblemSnapshot, [QUEUE]));
    await store.saveSnapshot(
      fx.makeSnapshot(fx.makeProblem(draftStale.ref, { statement: 'changed statement' }), {
        previous: snapshots[4],
        capturedAt: LATER,
      }),
    );

    const queue = await service.listProblems({ limit: 10, cursor: null, needsReviewOnly: true }, TOKEN);
    assert.deepEqual(queue.items, [], 'every remaining item is resolved or stale');
  });
});

void test('an unresolved AI needs_review decision at the current head stays queued', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    await seed(store, scope);
    await store.saveSnapshot(snapshot);
    await store.saveTagDecisions([pendingDecision(scope.problem, snapshot, STACK)]);

    const queue = await service.listProblems({ limit: 10, cursor: null, needsReviewOnly: true }, TOKEN);
    assert.deepEqual(queue.items.map((item) => item.problemKey), [scope.problem.key]);

    await service.reviewTag({ problemKey: scope.problem.key, taxonomyId: STACK, action: 'accept' }, TOKEN);
    const resolved = await service.listProblems({ limit: 10, cursor: null, needsReviewOnly: true }, TOKEN);
    assert.deepEqual(resolved.items, []);
  });
});

// ---------------------------------------------------------------------------------------
// Manual review
// ---------------------------------------------------------------------------------------

void test('manual review wins over AI, orders repeated clocks and is idempotent for identical intent', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    const analysis = fx.makeAnalysis(scope.problem, snapshot);
    await seed(store, scope);
    await store.saveSnapshot(snapshot);
    await store.saveAnalysis(analysis);
    await store.saveTagDecisions([pendingDecision(scope.problem, snapshot, STACK)]);

    const accepted = await service.reviewTag(
      { problemKey: scope.problem.key, taxonomyId: STACK, action: 'accept', note: 'used a stack' },
      TOKEN,
    );
    assert.equal(accepted.outcome, 'recorded');
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.manualRevision, 1);
    assert.equal(accepted.decidedAt, AT);
    const stored = await store.listTagDecisions(scope.problem.key);
    const manual = stored.find((decision) => decision.origin === 'manual');
    assert.ok(manual);
    assert.equal(manual.status, 'accepted');
    assert.deepEqual(manual.reasons, ['manual_accept']);
    assert.equal(manual.analysisId, analysis.analysisId, 'the on-screen analysis is kept as audit context');

    const repeat = await service.reviewTag(
      { problemKey: scope.problem.key, taxonomyId: STACK, action: 'accept', note: 'used a stack' },
      TOKEN,
    );
    assert.equal(repeat.outcome, 'already_recorded');
    assert.equal(repeat.decisionId, accepted.decisionId);
    assert.equal(repeat.manualRevision, 1, 'an identical intent does not advance the revision again');

    const rejected = await service.reviewTag(
      { problemKey: scope.problem.key, taxonomyId: STACK, action: 'reject' },
      TOKEN,
    );
    assert.equal(rejected.outcome, 'recorded');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.manualRevision, 2);
    assert.ok(Date.parse(rejected.decidedAt) > Date.parse(accepted.decidedAt), 'a repeated clock is ordered');

    const detail = await service.getProblem(
      { problemKey: scope.problem.key, accountId: scope.account.id, reveal: true },
      TOKEN,
    );
    assert.equal(detail.effectiveTaxonomyIds?.includes(STACK), false, 'the manual reject wins over AI');
    assert.deepEqual(detail.manualDecisions?.map((decision) => decision.action), ['accept', 'reject']);
    assert.equal(detail.currentTagDecisions?.[0]?.origin, 'manual');
  });
});

void test('reviewTag rejects unknown problems and unknown taxonomy ids', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(store, scope);
    await rejectsDomain(
      service.reviewTag({ problemKey: scope.problem.key, taxonomyId: 'data-structure.nope', action: 'accept' }, TOKEN),
      'unknown_taxonomy_id',
    );
    await rejectsDomain(
      service.reviewTag({ problemKey: fx.makeProblem(fx.makeRef(scope.instance, 'ZZ')).key, taxonomyId: STACK, action: 'accept' }, TOKEN),
      'missing_reference',
    );
    await rejectsDomain(
      service.reviewTag({ problemKey: scope.problem.key, taxonomyId: STACK, action: 'maybe' as 'accept' }, TOKEN),
      'invalid_input',
    );
    assert.equal(await store.getManualRevision(scope.problem.key), 0);
  });
});

void test('stale AI decisions leave the effective taxonomy while manual decisions survive a head change', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const version1 = fx.makeSnapshot(scope.problem);
    const analysis1 = fx.makeAnalysis(scope.problem, version1);
    await seed(store, scope);
    await store.saveSnapshot(version1);
    await store.saveAnalysis(analysis1);
    await store.saveTagDecisions([
      createTagDecision({
        problemKey: scope.problem.key,
        taxonomyId: STACK,
        status: 'auto_adopted',
        origin: 'ai',
        decidedAt: AT,
        reasons: ['evidence_verified', 'verification_support'],
        analysisId: analysis1.analysisId,
        snapshotId: version1.snapshotId,
        snapshotVersion: version1.version,
      }),
    ]);
    await service.reviewTag({ problemKey: scope.problem.key, taxonomyId: QUEUE, action: 'accept' }, TOKEN);

    const before = await service.getProblem(
      { problemKey: scope.problem.key, accountId: scope.account.id, reveal: true },
      TOKEN,
    );
    assert.deepEqual(before.effectiveTaxonomyIds, [STACK, QUEUE].sort());
    assert.equal(before.staleAnalysisCount, 0);

    const version2 = fx.makeSnapshot(fx.makeProblem(scope.problem.ref, { statement: 'rewritten statement' }), {
      previous: version1,
      capturedAt: LATER,
    });
    await store.saveSnapshot(version2);
    const analysis2 = fx.makeAnalysis(scope.problem, version2, { createdAt: LATER });
    await store.saveAnalysis(analysis2);

    const after = await service.getProblem(
      { problemKey: scope.problem.key, accountId: scope.account.id, reveal: true },
      TOKEN,
    );
    assert.deepEqual(after.effectiveTaxonomyIds, [QUEUE], 'stale AI stops counting, manual accept survives');
    assert.equal(after.staleAnalysisCount, 1);
    assert.deepEqual(after.analyses?.map((entry) => entry.stale), [true, false]);
    assert.deepEqual(after.currentTagDecisions?.map((entry) => entry.taxonomyId), [QUEUE]);
  });
});

// ---------------------------------------------------------------------------------------
// Retrospectives
// ---------------------------------------------------------------------------------------

void test('retrospectives validate their references and keep an ordered append-only history', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    const otherInstance = fx.makeInstance('luogu', 'luogu.com.cn');
    const foreign = fx.makeAccount(otherInstance, 'alice');
    await seed(store, scope);
    await store.upsertSourceInstances([otherInstance]);
    await store.upsertAccounts([foreign]);
    await store.saveSnapshot(snapshot);

    await rejectsDomain(
      service.recordRetrospective(
        { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'assisted', taxonomyIds: ['nope.tag'] },
        TOKEN,
      ),
      'unknown_taxonomy_id',
    );
    await rejectsDomain(
      service.recordRetrospective(
        {
          problemKey: scope.problem.key,
          accountId: scope.account.id,
          mode: 'solution_used',
          solutionIds: ['solution-404'],
        },
        TOKEN,
      ),
      'missing_reference',
      'unknown_solution',
    );
    await rejectsDomain(
      service.recordRetrospective(
        {
          problemKey: scope.problem.key,
          accountId: scope.account.id,
          mode: 'independent',
          solutionIds: ['solution-1'],
        },
        TOKEN,
      ),
      'invalid_input',
      'independent_with_solutions',
    );
    await rejectsDomain(
      service.recordRetrospective(
        { problemKey: scope.problem.key, accountId: foreign.id, mode: 'assisted', taxonomyIds: [STACK] },
        TOKEN,
      ),
      'invalid_input',
      'account_source_mismatch',
    );
    assert.deepEqual(await store.listRetrospectives(scope.account.id), []);

    const first = await service.recordRetrospective(
      {
        problemKey: scope.problem.key,
        accountId: scope.account.id,
        mode: 'solution_used',
        taxonomyIds: [STACK, STACK],
        solutionIds: ['solution-1'],
        note: 'read the editorial',
      },
      TOKEN,
    );
    assert.equal(first.recorded, true);
    assert.deepEqual(first.taxonomyIds, [STACK]);
    assert.equal(first.recordedAt, AT);

    const second = await service.recordRetrospective(
      {
        problemKey: scope.problem.key,
        accountId: scope.account.id,
        mode: 'assisted',
        taxonomyIds: [QUEUE],
        note: 'second pass alone',
      },
      TOKEN,
    );
    assert.ok(Date.parse(second.recordedAt) > Date.parse(first.recordedAt), 'a repeated clock is ordered');
    assert.equal((await store.listRetrospectives(scope.account.id)).length, 2, 'history is append-only');

    const detail = await service.getProblem({ problemKey: scope.problem.key, accountId: scope.account.id }, TOKEN);
    assert.equal(detail.latestRetrospective?.retrospectiveId, second.retrospectiveId);
    assert.equal(detail.latestRetrospective?.mode, 'assisted');
  });
});

// ---------------------------------------------------------------------------------------
// Isolation, validation and cancellation
// ---------------------------------------------------------------------------------------

void test('foreign scopes, unknown references and malformed arguments are rejected', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const otherInstance = fx.makeInstance('luogu', 'luogu.com.cn');
    const foreign = fx.makeAccount(otherInstance, 'bob');
    await seed(store, scope);
    await store.upsertSourceInstances([otherInstance]);
    await store.upsertAccounts([foreign]);

    await rejectsDomain(
      service.getProblem({ problemKey: scope.problem.key, accountId: foreign.id }, TOKEN),
      'invalid_input',
      'account_source_mismatch',
    );
    await rejectsDomain(
      service.listProblems({ accountId: foreign.id, sourceInstanceId: scope.instance.id, limit: 10, cursor: null }, TOKEN),
      'invalid_input',
      'account_source_mismatch',
    );
    await rejectsDomain(service.listProblems({ accountId: 'nobody', limit: 10, cursor: null }, TOKEN), 'missing_reference');
    await rejectsDomain(service.listProblems({ onlyAttempted: true, limit: 10, cursor: null }, TOKEN), 'invalid_input', 'only_attempted_without_account');
    await rejectsDomain(
      service.getProblem({ problemKey: fx.makeProblem(fx.makeRef(scope.instance, 'MISSING')).key, accountId: null }, TOKEN),
      'missing_reference',
    );
    for (const limit of [0, 501, 2.5]) {
      await rejectsDomain(service.listProblems({ limit, cursor: null }, TOKEN), 'invalid_input');
    }
    for (const query of ['', '   ', 'q'.repeat(201)]) {
      await rejectsDomain(service.listProblems({ limit: 10, cursor: null, query }, TOKEN), 'invalid_input');
    }
    await rejectsDomain(
      service.listProblems({ limit: 10, cursor: null, needsReviewOnly: 'yes' as unknown as boolean }, TOKEN),
      'invalid_input',
    );
    await rejectsDomain(service.listProblems({ limit: 10, cursor: 'not-a-cursor' }, TOKEN), 'invalid_input');
    assert.equal(
      (await service.listProblems({ sourceInstanceId: scope.instance.id, limit: 10, cursor: null }, TOKEN)).items.length,
      1,
    );
  });
});

void test('a cancelled token stops every operation before any read or write', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(store, scope);
    const cancelled = createCancellationSource();
    cancelled.cancel('test');
    const token = cancelled.token;
    await rejectsDomain(service.listProblems({ limit: 10, cursor: null }, token), 'cancelled');
    await rejectsDomain(service.getProblem({ problemKey: scope.problem.key, accountId: null }, token), 'cancelled');
    await rejectsDomain(
      service.reviewTag({ problemKey: scope.problem.key, taxonomyId: STACK, action: 'accept' }, token),
      'cancelled',
    );
    await rejectsDomain(
      service.recordRetrospective(
        { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'assisted' },
        token,
      ),
      'cancelled',
    );
    assert.deepEqual(await store.listManualDecisions(scope.problem.key), []);
  });
});

/**
 * Cancellation landing between the two writes of one review: the awaited `saveTagDecisions` is
 * preceded by a token check, so the transaction rolls the already-inserted manual decision back.
 */
void test('a cancellation between the manual decision and its resolved decision rolls both back', async () => {
  const paths = fx.tempDatabase();
  const clock = { value: AT };
  const realStore = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
  const source = createCancellationSource();
  try {
    const proxy = new Proxy(realStore, {
      get(target, property, receiver) {
        if (property === 'saveManualDecision') {
          return async (decision: Parameters<SqliteTrainingStore['saveManualDecision']>[0]) => {
            await target.saveManualDecision(decision);
            source.cancel('cancelled between the two manual writes');
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as TrainingStore;
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(realStore, scope);
    const service = new WorkbenchService({
      store: proxy,
      taxonomy: TAXONOMY,
      now: () => clock.value,
      uniqueId: () => 'page-1',
    });
    await rejectsDomain(
      service.reviewTag({ problemKey: scope.problem.key, taxonomyId: STACK, action: 'accept' }, source.token),
      'cancelled',
    );
    assert.deepEqual(await realStore.listManualDecisions(scope.problem.key), [], 'the manual insert is rolled back');
    assert.deepEqual(await realStore.listTagDecisions(scope.problem.key), []);
    assert.equal(await realStore.getManualRevision(scope.problem.key), 0);
  } finally {
    await realStore.close();
    fx.removeDirectory(paths.dir);
  }
});

// ---------------------------------------------------------------------------------------
// Store-level query extension
// ---------------------------------------------------------------------------------------

void test('SqliteTrainingStore.listProblems applies the search term literally and validates the query', async () => {
  await withBench(async ({ store }) => {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const percent = fx.makeProblem(fx.makeRef(instance, 'K1'), { title: 'Percent 100%_literal' });
    const decoy = fx.makeProblem(fx.makeRef(instance, 'K2'), { title: 'Percent 100XYliteral' });
    const externalMatch = fx.makeProblem(fx.makeRef(instance, 'Nebula-77'), { title: 'Routine' });
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems([percent, decoy, externalMatch]);

    const byTitle = await store.listProblems({ limit: 10, cursor: null, query: '100%_' });
    assert.deepEqual(byTitle.items.map((item) => item.key), [percent.key]);
    const byKey = await store.listProblems({ limit: 10, cursor: null, query: 'nebula' });
    assert.deepEqual(byKey.items.map((item) => item.key), [externalMatch.key]);

    for (const query of ['', '   ', 'x'.repeat(201)]) {
      await rejectsDomain(store.listProblems({ limit: 10, cursor: null, query }), 'invalid_input');
    }
    await rejectsDomain(
      store.listProblems({ limit: 10, cursor: null, needsReviewOnly: 1 as unknown as boolean }),
      'invalid_input',
    );
    const unfiltered = await store.listProblems({ limit: 10, cursor: null, needsReviewOnly: false });
    assert.equal(unfiltered.items.length, 3);
  });
});

// ---------------------------------------------------------------------------------------
// Write-transaction revalidation, serialized read projections and strict history bounds
// ---------------------------------------------------------------------------------------

void test('recordRetrospective revalidates the current snapshot inside its write transaction', async () => {
  const paths = fx.tempDatabase();
  const clock = { value: AT };
  const realStore = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
  try {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(realStore, scope);
    const version1 = fx.makeSnapshot(scope.problem);
    await realStore.saveSnapshot(version1);
    // A concurrent replacement that drops the editorial solutions the caller consulted.
    const replacement = createProblemSnapshot({ problem: scope.problem, capturedAt: LATER, previous: version1 });
    let advanced = false;
    const proxy = new Proxy(realStore, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (work: () => Promise<unknown>) => {
            if (!advanced) {
              advanced = true;
              // Committed before the write transaction begins, exactly like a replacement that
              // wins the race between a pre-transaction read and the insert.
              await target.saveSnapshot(replacement);
            }
            return target.transaction(work);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as TrainingStore;
    const service = new WorkbenchService({
      store: proxy,
      taxonomy: TAXONOMY,
      now: () => clock.value,
      uniqueId: () => 'page-1',
    });

    await rejectsDomain(
      service.recordRetrospective(
        {
          problemKey: scope.problem.key,
          accountId: scope.account.id,
          mode: 'solution_used',
          solutionIds: ['solution-1'],
        },
        TOKEN,
      ),
      'missing_reference',
      'unknown_solution',
    );
    assert.deepEqual(await realStore.listRetrospectives(scope.account.id), [], 'an obsolete solution writes nothing');
    assert.equal(
      (await realStore.getCurrentSnapshotHead(scope.problem.ref))?.version,
      2,
      'the replacement really is the head',
    );

    const independent = await service.recordRetrospective(
      { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'independent' },
      TOKEN,
    );
    assert.equal(independent.recorded, true, 'a retrospective without solutions still records after the head move');
    assert.equal(independent.recordedAt, AT);
  } finally {
    await realStore.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('a head that advances before the tag projection cannot leave stale AI current in the bank list', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const version1 = fx.makeSnapshot(scope.problem);
  const version2 = fx.makeSnapshot(fx.makeProblem(scope.problem.ref, { statement: 'rewritten statement' }), {
    previous: version1,
    capturedAt: LATER,
  });
  await withBench(
    async ({ store, service }) => {
      const analysis1 = fx.makeAnalysis(scope.problem, version1);
      await seed(store, scope);
      await store.saveSnapshot(version1);
      await store.saveAnalysis(analysis1);
      await store.saveTagDecisions([
        createTagDecision({
          problemKey: scope.problem.key,
          taxonomyId: STACK,
          status: 'auto_adopted',
          origin: 'ai',
          decidedAt: AT,
          reasons: ['evidence_verified'],
          analysisId: analysis1.analysisId,
          snapshotId: version1.snapshotId,
          snapshotVersion: version1.version,
        }),
      ]);
      await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted')]);

      const page = await service.listProblems({ accountId: scope.account.id, limit: 10, cursor: null }, TOKEN);
      const row = page.items.find((item) => item.problemKey === scope.problem.key);
      assert.ok(row);
      assert.equal(row.solvedByAccount, true);
      assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.version, 2, 'the head really advanced');
      assert.deepEqual(row.effectiveTaxonomyIds, [], 'AI output written for the old head is no longer current');
      assert.deepEqual(row.rawTags, ['data structures', 'segment tree'], 'visibility itself is unchanged');
    },
    (realStore) => headAdvancingStore(realStore, version2),
  );
});

void test('a head that advances before the detail projection marks the old analysis stale', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const version1 = fx.makeSnapshot(scope.problem);
  const version2 = fx.makeSnapshot(fx.makeProblem(scope.problem.ref, { statement: 'rewritten statement' }), {
    previous: version1,
    capturedAt: LATER,
  });
  await withBench(
    async ({ store, service }) => {
      const analysis1 = fx.makeAnalysis(scope.problem, version1);
      await seed(store, scope);
      await store.saveSnapshot(version1);
      await store.saveAnalysis(analysis1);
      await store.saveTagDecisions([
        createTagDecision({
          problemKey: scope.problem.key,
          taxonomyId: STACK,
          status: 'auto_adopted',
          origin: 'ai',
          decidedAt: AT,
          reasons: ['evidence_verified'],
          analysisId: analysis1.analysisId,
          snapshotId: version1.snapshotId,
          snapshotVersion: version1.version,
        }),
      ]);

      const detail = await service.getProblem(
        { problemKey: scope.problem.key, accountId: scope.account.id, reveal: true },
        TOKEN,
      );
      assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.version, 2, 'the head really advanced');
      assert.equal(detail.snapshot?.version, 2, 'the detail projects against the head it reports');
      assert.deepEqual(detail.effectiveTaxonomyIds, []);
      assert.deepEqual(detail.analyses?.map((entry) => entry.current), [false]);
      assert.equal(detail.staleAnalysisCount, 1);
      assert.deepEqual(detail.currentTagDecisions, []);
    },
    (realStore) => headAdvancingStore(realStore, version2),
  );
});

void test('the submission walk allows exactly 50000 rows and refuses a 50001st terminal page', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const rejected = fx.makeSubmission(scope.account, scope.problem.ref, 'S-WA', 'wrong_answer');
  const fullPage = Array.from({ length: WORKBENCH_SUBMISSION_PAGE_SIZE }, () => rejected);
  const fullPages = Array.from(
    { length: MAX_ACCOUNT_SUBMISSIONS / WORKBENCH_SUBMISSION_PAGE_SIZE },
    () => fullPage,
  );
  assert.equal(fullPages.length * WORKBENCH_SUBMISSION_PAGE_SIZE, MAX_ACCOUNT_SUBMISSIONS);

  let allowedCalls = { count: 0 };
  await withBench(
    async ({ store, service }) => {
      await seed(store, scope);
      const allowed = await service.listProblems({ accountId: scope.account.id, limit: 10, cursor: null }, TOKEN);
      assert.equal(allowed.items[0]?.solvedByAccount, false);
      assert.equal(allowedCalls.count, fullPages.length, 'the bound itself is walked, not refused');
    },
    (store) => {
      const made = scriptedHistoryStore(store, fullPages);
      allowedCalls = made.calls;
      return made.store;
    },
  );

  let overflowCalls = { count: 0 };
  await withBench(
    async ({ store, service }) => {
      await seed(store, scope);
      await rejectsDomain(
        service.listProblems({ accountId: scope.account.id, limit: 10, cursor: null }, TOKEN),
        'invalid_input',
        'submission_history_overflow',
      );
      assert.equal(
        overflowCalls.count,
        fullPages.length + 1,
        'the overflowing terminal page is counted before it is refused',
      );
    },
    (store) => {
      const made = scriptedHistoryStore(store, [...fullPages, [rejected]]);
      overflowCalls = made.calls;
      return made.store;
    },
  );
});

void test('an accepted proof stops the submission walk early while a miss walks every page', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const other = fx.makeProblem(fx.makeRef(scope.instance, '1B'));
  const accepted = fx.makeSubmission(scope.account, scope.problem.ref, 'S-AC', 'accepted');
  const missed = fx.makeSubmission(scope.account, other.ref, 'S-WA', 'wrong_answer');

  let proofCalls = { count: 0 };
  await withBench(
    async ({ store, service }) => {
      await seed(store, scope);
      await store.upsertProblems([other]);
      const solved = await service.getProblem({ problemKey: scope.problem.key, accountId: scope.account.id }, TOKEN);
      assert.equal(solved.solvedByAccount, true);
      assert.equal(proofCalls.count, 1, 'the accepted proof stops the walk without reading the next page');
    },
    (store) => {
      const made = scriptedHistoryStore(store, [[accepted], [missed]]);
      proofCalls = made.calls;
      return made.store;
    },
  );

  let missCalls = { count: 0 };
  await withBench(
    async ({ store, service }) => {
      await seed(store, scope);
      await store.upsertProblems([other]);
      const unsolved = await service.getProblem({ problemKey: other.key, accountId: scope.account.id }, TOKEN);
      assert.equal(unsolved.solvedByAccount, false);
      assert.equal(missCalls.count, 2, 'a miss walks the whole history');
      const page = await service.listProblems({ accountId: scope.account.id, limit: 10, cursor: null }, TOKEN);
      assert.equal(page.items.find((item) => item.problemKey === scope.problem.key)?.solvedByAccount, true);
      assert.equal(page.items.find((item) => item.problemKey === other.key)?.solvedByAccount, false);
      assert.equal(missCalls.count, 4, 'the bank projection walks the full history too');
    },
    (store) => {
      const made = scriptedHistoryStore(store, [[accepted], [missed]]);
      missCalls = made.calls;
      return made.store;
    },
  );
});

void test('retrospective id lists are bounded before any validation work', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(store, scope);
    const oversized = Array.from({ length: MAX_RETROSPECTIVE_IDS + 1 }, (_, index) => `entry-${index}`);
    await rejectsDomain(
      service.recordRetrospective(
        { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'assisted', taxonomyIds: oversized },
        TOKEN,
      ),
      'invalid_input',
      'id_list_too_long',
    );
    await rejectsDomain(
      service.recordRetrospective(
        { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'solution_used', solutionIds: oversized },
        TOKEN,
      ),
      'invalid_input',
      'id_list_too_long',
    );
    assert.deepEqual(await store.listRetrospectives(scope.account.id), []);
  });
});

void test('a later-dated AI decision for another head never resolves a current needs_review item', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    await seed(store, scope);
    await store.saveSnapshot(snapshot);
    await store.saveTagDecisions([pendingDecision(scope.problem, snapshot, SEGMENT_TREE, AT)]);
    // Later-dated AI output on the same tag, but written for a snapshot that is not the head: it
    // must not silently resolve the current item.
    await store.saveTagDecisions([
      createTagDecision({
        problemKey: scope.problem.key,
        taxonomyId: SEGMENT_TREE,
        status: 'auto_adopted',
        origin: 'ai',
        decidedAt: LATER,
        reasons: ['evidence_verified'],
        snapshotId: 'snapshot|obsolete',
        snapshotVersion: 99,
      }),
    ]);

    const queue = await service.listProblems({ limit: 10, cursor: null, needsReviewOnly: true }, TOKEN);
    assert.deepEqual(queue.items.map((item) => item.problemKey), [scope.problem.key]);
  });
});

void test('review-queue tie-breaking follows the deterministic store decision order', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    await seed(store, scope);
    await store.saveSnapshot(snapshot);
    const tied = (status: 'needs_review' | 'auto_adopted') =>
      createTagDecision({
        problemKey: scope.problem.key,
        taxonomyId: SEGMENT_TREE,
        status,
        origin: 'ai',
        decidedAt: AT,
        reasons: status === 'needs_review' ? ['reasoning_requires_review'] : ['evidence_verified'],
        snapshotId: snapshot.snapshotId,
        snapshotVersion: snapshot.version,
      });
    await store.saveTagDecisions([tied('needs_review'), tied('auto_adopted')]);

    const stored = await store.listTagDecisions(scope.problem.key);
    const newest = stored[stored.length - 1];
    assert.ok(newest);
    assert.equal(newest.decidedAt, AT, 'the tie is real');
    const queue = await service.listProblems({ limit: 10, cursor: null, needsReviewOnly: true }, TOKEN);
    const detail = await service.getProblem(
      { problemKey: scope.problem.key, accountId: scope.account.id, reveal: true },
      TOKEN,
    );
    const currentStatus = detail.currentTagDecisions?.[0]?.status ?? null;
    assert.equal(
      queue.items.length,
      currentStatus === 'needs_review' ? 1 : 0,
      'the SQL tie-break agrees with the effective view',
    );
    assert.equal(queue.items.length, newest.status === 'needs_review' ? 1 : 0, 'and with the stored decision order');
  });
});

// ---------------------------------------------------------------------------------------
// Stored-row coherence (account + source instance + canonical key)
// ---------------------------------------------------------------------------------------

void test('a stored submission that names another source instance is refused, not counted as a solve', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const foreignInstance = fx.makeInstance('luogu', 'luogu.com.cn');
    const foreign = fx.makeProblem(fx.makeRef(foreignInstance, 'P1000'));
    await store.upsertSourceInstances([scope.instance, foreignInstance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([scope.problem, foreign]);
    // The real adapter accepts this row: its key and ref agree with each other, and only the
    // account/source pair is incoherent.
    await store.upsertSubmissions([fx.makeSubmission(scope.account, foreign.ref, 'X1', 'accepted')]);

    await rejectsDomain(
      service.listProblems({ accountId: scope.account.id, limit: 10, cursor: null }, TOKEN),
      'invalid_input',
      'submission_source_mismatch',
    );
    await rejectsDomain(
      service.getProblem({ problemKey: scope.problem.key, accountId: scope.account.id }, TOKEN),
      'invalid_input',
      'submission_source_mismatch',
    );

    // Without an account context nothing is solved, so the foreign AC reveals no tag material.
    const anonymous = await service.listProblems({ limit: 10, cursor: null }, TOKEN);
    const row = anonymous.items.find((item) => item.problemKey === foreign.key);
    assert.ok(row, 'the foreign problem itself stays listable');
    assert.equal(row.solvedByAccount, false);
    assertAbsent(row, 'rawTags', 'anonymous bank row');
  });
});

void test('another subdomain of the same instance stays valid solved evidence', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const gym = fx.makeProblem(fx.makeRef(scope.instance, '100001', 'gym'));
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([scope.problem, gym]);
    await store.upsertSubmissions([fx.makeSubmission(scope.account, gym.ref, 'G1', 'accepted')]);

    const detail = await service.getProblem({ problemKey: gym.key, accountId: scope.account.id }, TOKEN);
    assert.equal(detail.solvedByAccount, true, 'the source instance matches, the problem domain may differ');
    assert.deepEqual(detail.rawTags, ['data structures', 'segment tree']);
    const page = await service.listProblems({ accountId: scope.account.id, limit: 10, cursor: null }, TOKEN);
    assert.equal(page.items.find((item) => item.problemKey === gym.key)?.solvedByAccount, true);
    assert.equal(page.items.find((item) => item.problemKey === scope.problem.key)?.solvedByAccount, false);
  });
});

void test('a port returning another account or a re-keyed submission is refused, not counted', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const bob = fx.makeAccount(scope.instance, 'bob');
  const foreignRow = fx.makeSubmission(bob, scope.problem.ref, 'B1', 'accepted');
  await withBench(
    async ({ store, service }) => {
      await seed(store, scope);
      await rejectsDomain(
        service.listProblems({ accountId: scope.account.id, limit: 10, cursor: null }, TOKEN),
        'invalid_input',
        'submission_account_mismatch',
      );
    },
    (store) => rowsReturningStore(store, [foreignRow]),
  );

  const coherent = fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted');
  const rekeyed: Submission = { ...coherent, key: fx.makeProblem(fx.makeRef(scope.instance, 'OTHER')).key };
  await withBench(
    async ({ store, service }) => {
      await seed(store, scope);
      await rejectsDomain(
        service.getProblem({ problemKey: scope.problem.key, accountId: scope.account.id }, TOKEN),
        'invalid_input',
        'submission_key_mismatch',
      );
    },
    (store) => rowsReturningStore(store, [rekeyed]),
  );
});
