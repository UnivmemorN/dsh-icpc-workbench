/**
 * Weakness reports and training plans over a real SQLite store (Stage 4w1b).
 *
 * Every case drives the real `WorkbenchService` against a temporary `SqliteTrainingStore`; nothing
 * reaches a platform, a model or the network. The assertions cover the externally meaningful
 * behaviour: the five-distinct-problem gate, duplicate-AC collapsing, account isolation, stale AI
 * exclusion, missing metadata coverage, real-candidate preview → adopt → edit → check-off with
 * content-hash CAS, spoiler redaction in the serialized plan DTO, honest empty-pool results and
 * rollback of a cancelled preview.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type { TrainingStore } from '../../src/application/ports.js';
import {
  MAX_PLAN_CANDIDATES,
  MAX_WEAKNESS_DECISIONS,
  MAX_WEAKNESS_RETROSPECTIVES,
  WORKBENCH_MIN_WEAKNESS_SAMPLE,
  WorkbenchService,
  type WorkbenchServiceOptions,
} from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  DomainError,
  contentHashOf,
  createCancellationSource,
  createTagDecision,
  createTaxonomyIndex,
  problemKey,
  type DomainErrorCode,
  type NormalizedProblem,
  type ProblemSnapshot,
  type Retrospective,
  type TagDecision,
} from '../../src/domain/index.js';
import type { WorkbenchPlanTaskPatch } from '../../src/application/workbench-types.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const LATER = '2026-11-01T09:00:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** Two ids that exist in the shipped vocabulary. */
const STACK = 'data-structure.stack';
const QUEUE = 'data-structure.queue';

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
  const options: WorkbenchServiceOptions = {
    store: wrap(store),
    taxonomy: TAXONOMY,
    now: () => clock.value,
    uniqueId: () => `plan-${(minted += 1)}`,
  };
  const service = new WorkbenchService(options);
  try {
    await run({ store, service, clock });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

async function seedScope(store: SqliteTrainingStore, scope: fx.Scope): Promise<void> {
  await store.upsertSourceInstances([scope.instance]);
  await store.upsertAccounts([scope.account]);
  await store.upsertProblems([scope.problem]);
}

/** One current-head AI adoption of `taxonomyId` on `problem`, with its snapshot already saved. */
function autoTag(
  problem: NormalizedProblem,
  snapshot: ProblemSnapshot,
  taxonomyId: string,
  decidedAt: string = AT,
): TagDecision {
  return createTagDecision({
    problemKey: problem.key,
    taxonomyId,
    status: 'auto_adopted',
    origin: 'ai',
    decidedAt,
    reasons: ['evidence_verified'],
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
  });
}

/** A real store whose tag-decision reads return `rows`, so a 50 001-row history needs no inserts. */
function decisionsReturningStore(realStore: SqliteTrainingStore, rows: readonly TagDecision[]): TrainingStore {
  return new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === 'listTagDecisions') {
        return async () => rows;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TrainingStore;
}

/** A real store whose retrospective reads return `rows`, so a 50 001-row history needs no inserts. */
function retrospectivesReturningStore(realStore: SqliteTrainingStore, rows: readonly Retrospective[]): TrainingStore {
  return new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === 'listRetrospectives') {
        return async () => rows;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TrainingStore;
}

/** Assert that a withheld spoiler member is a missing own property. */
function assertAbsent(owner: object | null, key: string, label: string): void {
  assert.ok(owner !== null, `${label} must exist`);
  assert.equal(Object.hasOwn(owner, key), false, `${label}.${key} must be absent while withheld`);
  assert.equal((owner as Record<string, unknown>)[key], undefined, `${label}.${key} must not read as a value`);
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

// ---------------------------------------------------------------------------------------
// Weakness statistics
// ---------------------------------------------------------------------------------------

void test('weakness counts distinct problems, gates on five samples and reports missing metadata', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const extras = ['P2', 'P3', 'P4', 'P5'].map((key) => fx.makeProblem(fx.makeRef(scope.instance, key)));
    const problems = [scope.problem, ...extras];
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems(problems);
    for (const [index, problem] of problems.entries()) {
      const snapshot = fx.makeSnapshot(problem);
      await store.saveSnapshot(snapshot);
      const decisions = [autoTag(problem, snapshot, STACK)];
      if (index < WORKBENCH_MIN_WEAKNESS_SAMPLE - 1) {
        // The same four problems also carry a second tag that stays below the gate.
        decisions.push(autoTag(problem, snapshot, QUEUE));
      }
      await store.saveTagDecisions(decisions);
    }
    const ghostRef = fx.makeRef(scope.instance, 'GHOST');
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, scope.problem.ref, 'S-AC-1', 'accepted'),
      fx.makeSubmission(scope.account, scope.problem.ref, 'S-AC-2', 'accepted'),
      ...extras.map((problem, index) => fx.makeSubmission(scope.account, problem.ref, `S-WA-${index}`, 'wrong_answer')),
      // A submission whose problem metadata was never stored: it must still count as attempted.
      fx.makeSubmission(scope.account, ghostRef, 'S-GHOST', 'wrong_answer'),
    ]);

    const bob = fx.makeScope('luogu', 'luogu.com.cn', 'bob', 'Q1');
    const bobExtra = fx.makeProblem(fx.makeRef(bob.instance, 'Q2'));
    await store.upsertSourceInstances([bob.instance]);
    await store.upsertAccounts([bob.account]);
    await store.upsertProblems([bob.problem, bobExtra]);
    const bobSnapshot = fx.makeSnapshot(bob.problem);
    await store.saveSnapshot(bobSnapshot);
    await store.saveTagDecisions([autoTag(bob.problem, bobSnapshot, STACK)]);
    await store.upsertSubmissions([
      fx.makeSubmission(bob.account, bob.problem.ref, 'B1', 'wrong_answer'),
      fx.makeSubmission(bob.account, bobExtra.ref, 'B2', 'wrong_answer'),
    ]);

    const result = await service.weakness({ accountId: scope.account.id }, TOKEN);
    assert.equal(result.coverage.submissionRows, 7);
    assert.equal(result.coverage.distinctProblems, 6);
    assert.equal(result.coverage.metadataPresent, 5);
    assert.equal(result.coverage.metadataMissing, 1);
    assert.deepEqual(result.coverage.metadataMissingKeys, [problemKey(ghostRef)]);
    assert.equal(result.coverage.staleAiDecisionsExcluded, 0);
    assert.equal(result.report.attemptedDistinctTotal, 6);
    assert.equal(result.report.solvedDistinctTotal, 1, 'two ACs on one problem count once');
    assert.equal(result.report.taggedAttemptedDistinct, 5);
    assert.equal(result.report.notes.includes('ac_does_not_imply_solution_mastery'), true);
    assert.equal(result.report.tags.every((tag) => tag.accountId === scope.account.id), true);

    const stack = result.report.ranking.find((tag) => tag.taxonomyId === STACK);
    assert.ok(stack, 'a tag with five distinct attempts is ranked');
    assert.equal(stack.sampleSize, 5);
    assert.equal(stack.sufficient, true);
    assert.equal(stack.attemptedDistinct, 5);
    assert.equal(stack.solvedDistinct, 1);

    const queue = result.report.insufficientEvidence.find((tag) => tag.taxonomyId === QUEUE);
    assert.ok(queue, 'a four-sample tag is reported but not ranked');
    assert.equal(queue.sampleSize, 4);
    assert.equal(result.report.ranking.some((tag) => tag.taxonomyId === QUEUE), false);

    assert.equal(result.rawTagProvenance.verified, false);
    assert.equal(result.rawTagProvenance.problemsWithRawTags, 5);
    assert.ok(result.rawTagProvenance.distinctRawTags.includes('segment tree'));

    const bobResult = await service.weakness({ accountId: bob.account.id }, TOKEN);
    assert.equal(bobResult.report.attemptedDistinctTotal, 2, 'the other account is read as its own history');
    assert.equal(bobResult.report.tags.find((tag) => tag.taxonomyId === STACK)?.attemptedDistinct, 1);
  });
});

void test('weakness drops AI decisions written for an old head while manual decisions survive', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const other = fx.makeProblem(fx.makeRef(scope.instance, 'P2'));
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([scope.problem, other]);

    const version1 = fx.makeSnapshot(scope.problem);
    await store.saveSnapshot(version1);
    await store.saveTagDecisions([autoTag(scope.problem, version1, STACK)]);
    // A manual accept is not snapshot-scoped: it stays true when the snapshot is replaced.
    await store.saveTagDecisions([
      createTagDecision({
        problemKey: other.key,
        taxonomyId: QUEUE,
        status: 'accepted',
        origin: 'manual',
        decidedAt: AT,
        reasons: ['manual_accept'],
      }),
    ]);
    const version2 = fx.makeSnapshot(fx.makeProblem(scope.problem.ref, { statement: 'rewritten statement' }), {
      previous: version1,
      capturedAt: LATER,
    });
    await store.saveSnapshot(version2);
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'wrong_answer'),
      fx.makeSubmission(scope.account, other.ref, 'S2', 'wrong_answer'),
    ]);

    const result = await service.weakness({ accountId: scope.account.id }, TOKEN);
    assert.equal(result.coverage.staleAiDecisionsExcluded, 1);
    assert.equal(
      result.report.tags.some((tag) => tag.taxonomyId === STACK),
      false,
      'AI output for a superseded snapshot never counts',
    );
    const manual = result.report.tags.find((tag) => tag.taxonomyId === QUEUE);
    assert.ok(manual, 'the manual decision stays effective after the head move');
    assert.equal(manual.attemptedDistinct, 1);
    assert.equal(result.report.attemptedDistinctTotal, 2);
  });
});

// ---------------------------------------------------------------------------------------
// Plan lifecycle
// ---------------------------------------------------------------------------------------

void test('a real candidate pool previews, adopts, edits and checks off under content-hash CAS', async () => {
  const paths = fx.tempDatabase();
  const clock = { value: AT };
  let minted = 0;
  const options = (store: TrainingStore): WorkbenchServiceOptions => ({
    store,
    taxonomy: TAXONOMY,
    now: () => clock.value,
    uniqueId: () => `plan-${(minted += 1)}`,
  });
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
  try {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const pool = ['P2', 'P3', 'P4', 'P5'].map((key) => fx.makeProblem(fx.makeRef(scope.instance, key)));
    const problems = [scope.problem, ...pool];
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems(problems);
    for (const problem of problems) {
      const snapshot = fx.makeSnapshot(problem);
      await store.saveSnapshot(snapshot);
      await store.saveTagDecisions([autoTag(problem, snapshot, STACK)]);
    }
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, scope.problem.ref, 'S-AC', 'accepted'),
      ...pool.map((problem, index) => fx.makeSubmission(scope.account, problem.ref, `S-${index}`, 'wrong_answer')),
    ]);

    const service = new WorkbenchService(options(store));
    const preview = await service.previewPlan(
      {
        accountId: scope.account.id,
        candidateProblemKeys: pool.slice(0, 3).map((problem) => problem.key),
        estimatedMinutes: 30,
        horizonDays: 3,
        minutesPerDay: 60,
      },
      TOKEN,
    );
    assert.equal(preview.outcome, 'draft');
    if (preview.outcome !== 'draft') {
      return;
    }
    const plan = preview.plan;
    assert.deepEqual(preview.settings, { estimatedMinutes: 30, horizonDays: 3, minutesPerDay: 60 });
    assert.equal(plan.status, 'draft');
    assert.equal(plan.source, 'rule');
    assert.equal(plan.adoptedAt, null);
    assert.equal(plan.tasks.length, 3);
    assert.equal(plan.contentHash.length, 64);
    for (const task of plan.tasks) {
      const source = problems.find((problem) => problem.key === task.problemKey);
      assert.ok(source, `task ${task.taskId} points at a stored problem`);
      assert.equal(task.title, source.title);
      assert.equal(task.sourceUrl, source.url);
      assertAbsent(task, 'taxonomyIds', 'unsolved draft task');
      assertAbsent(task, 'rationale', 'unsolved draft task');
    }
    assertAbsent(plan, 'targetedTagIds', 'draft plan');
    assert.equal(plan.evidence.sufficientTagIds.includes(STACK), true);

    const storedDraft = await store.getPlan(plan.planId);
    assert.ok(storedDraft);
    assert.equal(plan.contentHash, contentHashOf(storedDraft), 'the token hashes the stored plan');

    const revealed = await service.getPlan({ planId: plan.planId, accountId: scope.account.id, reveal: true }, TOKEN);
    assert.deepEqual(revealed.targetedTagIds, [STACK]);
    assert.equal(revealed.tasks.every((task) => Array.isArray(task.taxonomyIds)), true);

    const adopted = await service.adoptPlan(
      { planId: plan.planId, accountId: scope.account.id, expectedHash: plan.contentHash },
      TOKEN,
    );
    assert.equal(adopted.status, 'adopted');
    assert.ok(adopted.adoptedAt !== null);
    assert.notEqual(adopted.contentHash, plan.contentHash);
    const [first, second, third] = adopted.tasks;
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);

    // A token from before the adoption must not overwrite the adopted plan.
    await rejectsDomain(
      service.editPlanTask(
        {
          planId: plan.planId,
          accountId: scope.account.id,
          expectedHash: plan.contentHash,
          taskId: first.taskId,
          patch: { day: 2 },
        },
        TOKEN,
      ),
      'invalid_transition',
      'stale_plan_hash',
    );
    const afterConflict = await store.getPlan(plan.planId);
    assert.ok(afterConflict);
    assert.equal(contentHashOf(afterConflict), adopted.contentHash, 'a stale hash never rewrites the plan');

    // Day 2 holds one 30-minute task, so a second 30-minute task still fits the 60-minute budget.
    const edited = await service.editPlanTask(
      {
        planId: plan.planId,
        accountId: scope.account.id,
        expectedHash: adopted.contentHash,
        taskId: first.taskId,
        patch: { day: 2, minutes: 30, kind: 'review' },
      },
      TOKEN,
    );
    const moved = edited.tasks.find((task) => task.taskId === first.taskId);
    assert.ok(moved);
    assert.equal(moved.day, 2);
    assert.equal(moved.kind, 'review');
    assert.equal(moved.problemKey, first.problemKey, 'identity and links are never replaced');
    assert.equal(moved.sourceUrl, first.sourceUrl);

    // Day 2 would reach 90 minutes: the domain refuses the overfilled edit.
    await rejectsDomain(
      service.editPlanTask(
        {
          planId: plan.planId,
          accountId: scope.account.id,
          expectedHash: edited.contentHash,
          taskId: second.taskId,
          patch: { day: 2 },
        },
        TOKEN,
      ),
      'invalid_input',
    );
    await rejectsDomain(
      service.editPlanTask(
        {
          planId: plan.planId,
          accountId: scope.account.id,
          expectedHash: edited.contentHash,
          taskId: second.taskId,
          patch: { title: 'renamed' } as unknown as WorkbenchPlanTaskPatch,
        },
        TOKEN,
      ),
      'invalid_input',
      'unsupported_patch_field',
    );
    await rejectsDomain(
      service.editPlanTask(
        { planId: plan.planId, accountId: scope.account.id, expectedHash: edited.contentHash, taskId: second.taskId, patch: {} },
        TOKEN,
      ),
      'invalid_input',
      'empty_patch',
    );

    const done = await service.checkOffTask(
      {
        planId: plan.planId,
        accountId: scope.account.id,
        expectedHash: edited.contentHash,
        taskId: second.taskId,
        status: 'done',
      },
      TOKEN,
    );
    const completed = done.tasks.find((task) => task.taskId === second.taskId);
    assert.ok(completed);
    assert.equal(completed.status, 'done');
    assert.ok(completed.checkedAt !== null, 'a check-off records when it happened');
    assert.equal(done.tasks.find((task) => task.taskId === third.taskId)?.status, 'planned');

    // A check-off is a user record: it never fabricates a submission.
    const submissions = await store.listSubmissions(scope.account.id, { limit: 500, cursor: null });
    assert.equal(submissions.items.filter((submission) => submission.key === second.problemKey).length, 1);
    // A completed task cannot be rescheduled.
    await rejectsDomain(
      service.editPlanTask(
        { planId: plan.planId, accountId: scope.account.id, expectedHash: done.contentHash, taskId: second.taskId, patch: { day: 1 } },
        TOKEN,
      ),
      'invalid_transition',
    );

    // Reload from disk: the adopted plan with its completed task survives a restart.
    await store.close();
    const reopened = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
    try {
      const reloadedService = new WorkbenchService(options(reopened));
      const list = await reloadedService.listPlans({ accountId: scope.account.id }, TOKEN);
      assert.equal(list.plans.length, 1);
      assert.equal(list.plans[0]?.contentHash, done.contentHash);
      const reloaded = await reloadedService.getPlan({ planId: plan.planId, accountId: scope.account.id }, TOKEN);
      assert.equal(reloaded.status, 'adopted');
      assert.equal(reloaded.tasks.find((task) => task.taskId === second.taskId)?.status, 'done');
      assert.equal(reloaded.contentHash, done.contentHash);
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('plan projections withhold unsolved task algorithms but keep aggregate weakness', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const hidden = ['P2', 'P3'].map((key) => fx.makeProblem(fx.makeRef(scope.instance, key)));
    const filler = ['P4', 'P5'].map((key) => fx.makeProblem(fx.makeRef(scope.instance, key)));
    const problems = [scope.problem, ...hidden, ...filler];
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems(problems);
    for (const [index, problem] of problems.entries()) {
      const snapshot = fx.makeSnapshot(problem);
      await store.saveSnapshot(snapshot);
      const decisions = [autoTag(problem, snapshot, STACK)];
      if (index > 0 && index <= hidden.length) {
        decisions.push(autoTag(problem, snapshot, QUEUE));
      }
      await store.saveTagDecisions(decisions);
    }
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, scope.problem.ref, 'S-AC', 'accepted'),
      ...problems.slice(1).map((problem, index) => fx.makeSubmission(scope.account, problem.ref, `S-${index}`, 'wrong_answer')),
    ]);

    const preview = await service.previewPlan(
      { accountId: scope.account.id, candidateProblemKeys: hidden.map((problem) => problem.key) },
      TOKEN,
    );
    assert.equal(preview.outcome, 'draft');
    if (preview.outcome !== 'draft') {
      return;
    }
    const json = JSON.stringify(preview.plan);
    assert.equal(json.includes('"taxonomyIds"'), false, 'no withheld task tag list reaches the wire');
    assert.equal(json.includes('"rationale"'), false, 'no withheld rationale reaches the wire');
    assert.equal(json.includes('Targets '), false, 'the generator rationale never leaks');
    for (const task of preview.plan.tasks) {
      assertAbsent(task, 'taxonomyIds', 'unsolved task');
      assertAbsent(task, 'rationale', 'unsolved task');
    }
    assertAbsent(preview.plan, 'targetedTagIds', 'plan preview');
    assert.equal(
      preview.plan.evidence.sufficientTagIds.includes(STACK),
      true,
      'aggregate account weakness is not a per-problem mapping and stays visible',
    );

    const revealed = await service.getPlan({ planId: preview.plan.planId, accountId: scope.account.id, reveal: true }, TOKEN);
    assert.deepEqual(revealed.targetedTagIds, [QUEUE, STACK]);
    assert.equal(revealed.tasks.every((task) => task.taxonomyIds?.includes(QUEUE)), true);
    assert.equal(revealed.tasks.every((task) => (task.rationale ?? '').length > 0), true);
  });
});

// ---------------------------------------------------------------------------------------
// Rejections, honest insufficiency and cancellation
// ---------------------------------------------------------------------------------------

void test('preview and plan reads refuse unknown, foreign and oversized scopes without writing', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const candidate = fx.makeProblem(fx.makeRef(scope.instance, 'P2'));
    await seedScope(store, scope);
    await store.upsertProblems([candidate]);

    const bob = fx.makeScope('luogu', 'luogu.com.cn', 'bob', 'Q1');
    await seedScope(store, bob);

    await rejectsDomain(service.weakness({ accountId: 'nobody' }, TOKEN), 'missing_reference');
    await rejectsDomain(
      service.previewPlan({ accountId: scope.account.id, candidateProblemKeys: ['not-a-real-key'] }, TOKEN),
      'invalid_input',
      'malformed_candidate_key',
    );
    await rejectsDomain(
      service.previewPlan(
        { accountId: scope.account.id, candidateProblemKeys: [problemKey(fx.makeRef(scope.instance, 'NOPE'))] },
        TOKEN,
      ),
      'missing_reference',
      'unknown_candidate',
    );
    await rejectsDomain(
      service.previewPlan({ accountId: scope.account.id, candidateProblemKeys: [bob.problem.key] }, TOKEN),
      'invalid_input',
      'candidate_source_mismatch',
    );
    await rejectsDomain(
      service.previewPlan(
        {
          accountId: scope.account.id,
          candidateProblemKeys: Array.from({ length: MAX_PLAN_CANDIDATES + 1 }, (_, index) => `key-${index}`),
        },
        TOKEN,
      ),
      'invalid_input',
      'too_many_candidates',
    );
    await rejectsDomain(
      service.previewPlan({ accountId: scope.account.id, candidateProblemKeys: [candidate.key], horizonDays: 31 }, TOKEN),
      'invalid_input',
    );
    await rejectsDomain(
      service.previewPlan({ accountId: scope.account.id, candidateProblemKeys: [candidate.key], minutesPerDay: 0 }, TOKEN),
      'invalid_input',
    );
    assert.deepEqual(await store.listPlans(scope.account.id), [], 'a refused preview writes nothing');

    const preview = await service.previewPlan(
      { accountId: scope.account.id, candidateProblemKeys: [candidate.key] },
      TOKEN,
    );
    assert.equal(preview.outcome, 'draft');
    if (preview.outcome !== 'draft') {
      return;
    }
    await rejectsDomain(
      service.getPlan({ planId: preview.plan.planId, accountId: bob.account.id }, TOKEN),
      'invalid_input',
      'plan_account_mismatch',
    );
    await rejectsDomain(
      service.adoptPlan({ planId: preview.plan.planId, accountId: scope.account.id, expectedHash: '0'.repeat(64) }, TOKEN),
      'invalid_transition',
      'stale_plan_hash',
    );
    await rejectsDomain(
      service.checkOffTask(
        {
          planId: preview.plan.planId,
          accountId: scope.account.id,
          expectedHash: preview.plan.contentHash,
          taskId: preview.plan.tasks[0]?.taskId ?? 'missing',
          status: 'done',
        },
        TOKEN,
      ),
      'invalid_transition',
    );
    await rejectsDomain(service.getPlan({ planId: 'plan|missing', accountId: scope.account.id }, TOKEN), 'missing_reference');
    const stored = await store.getPlan(preview.plan.planId);
    assert.ok(stored);
    assert.equal(stored.status, 'draft', 'refused mutations leave the draft untouched');
  });
});

void test('an empty pool and a history-less account stay honest instead of inventing a plan', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);

    const empty = await service.previewPlan({ accountId: scope.account.id, candidateProblemKeys: [] }, TOKEN);
    assert.equal(empty.outcome, 'insufficient_evidence');
    if (empty.outcome !== 'insufficient_evidence') {
      return;
    }
    assert.equal(empty.reason, 'insufficient_evidence');
    assert.equal(empty.evidence.reasons.includes('no_candidates'), true);
    assert.equal(empty.evidence.reasons.includes('no_submission_records'), true);
    assert.ok(empty.beginnerRecommendations.length > 0, 'real starter techniques come from the vocabulary');
    assert.equal(empty.beginnerRecommendations.every((entry) => entry.basis === 'taxonomy_default'), true);
    assert.deepEqual(await store.listPlans(scope.account.id), [], 'nothing is stored when no plan can be built');

    await store.upsertProblems([scope.problem]);
    const drafted = await service.previewPlan(
      { accountId: scope.account.id, candidateProblemKeys: [scope.problem.key] },
      TOKEN,
    );
    assert.equal(drafted.outcome, 'draft');
    if (drafted.outcome !== 'draft') {
      return;
    }
    assert.equal(drafted.plan.evidence.level, 'insufficient_history');
    assert.equal(drafted.plan.evidence.reasons.includes('no_submission_records'), true);
    assert.deepEqual(drafted.plan.evidence.sufficientTagIds, []);
    assert.equal(drafted.plan.tasks.length, 1);
    assert.equal(drafted.plan.tasks[0]?.title, scope.problem.title);
    assert.equal(drafted.plan.tasks[0]?.sourceUrl, scope.problem.url);
  });
});

void test('cancellation stops the operation and a cancelled preview rolls its draft back', async () => {
  const paths = fx.tempDatabase();
  const clock = { value: AT };
  const realStore = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
  const source = createCancellationSource();
  try {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    await seedScope(realStore, scope);

    const proxy = new Proxy(realStore, {
      get(target, property, receiver) {
        if (property === 'savePlan') {
          return async (plan: Parameters<SqliteTrainingStore['savePlan']>[0]) => {
            await target.savePlan(plan);
            source.cancel('cancelled after the plan write');
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
      uniqueId: () => 'plan-1',
    });

    const preCancelled = createCancellationSource();
    preCancelled.cancel('cancelled before the call');
    await rejectsDomain(service.weakness({ accountId: scope.account.id }, preCancelled.token), 'cancelled');
    await rejectsDomain(service.listPlans({ accountId: scope.account.id }, preCancelled.token), 'cancelled');

    await rejectsDomain(
      service.previewPlan({ accountId: scope.account.id, candidateProblemKeys: [scope.problem.key] }, source.token),
      'cancelled',
    );
    assert.deepEqual(await realStore.listPlans(scope.account.id), [], 'the draft is rolled back with its transaction');
  } finally {
    await realStore.close();
    fx.removeDirectory(paths.dir);
  }
});

// ---------------------------------------------------------------------------------------
// Incoherent stored rows and bounded evidence
// ---------------------------------------------------------------------------------------

void test('weakness refuses a stored submission that names another source instance', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    const foreignInstance = fx.makeInstance('luogu', 'luogu.com.cn');
    const foreign = fx.makeProblem(fx.makeRef(foreignInstance, 'P1000'));
    await store.upsertSourceInstances([scope.instance, foreignInstance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([scope.problem, foreign]);
    // The adapter accepts the row: its key and ref agree; only the account/source pair is incoherent.
    await store.upsertSubmissions([fx.makeSubmission(scope.account, foreign.ref, 'X1', 'accepted')]);

    await rejectsDomain(
      service.weakness({ accountId: scope.account.id }, TOKEN),
      'invalid_input',
      'submission_source_mismatch',
    );
  });
});

void test('incoherent stored problem metadata is refused before it can tag the report', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
  const foreign = fx.makeProblem(fx.makeRef(fx.makeInstance('luogu', 'luogu.com.cn'), 'Q1'));
  await withBench(
    async ({ store, service }) => {
      await seedScope(store, scope);
      await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'wrong_answer')]);
      await rejectsDomain(
        service.weakness({ accountId: scope.account.id }, TOKEN),
        'invalid_input',
        'problem_key_mismatch',
      );
    },
    (store) =>
      new Proxy(store, {
        get(target, property, receiver) {
          if (property === 'getProblem') {
            return async (key: string) => {
              const found = await target.getProblem(key);
              return found === null ? null : { ...found, ref: foreign.ref };
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as TrainingStore,
  );
});

void test('a same-source retrospective without a submission stays valid history', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
    await seedScope(store, scope);
    await service.recordRetrospective(
      { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'independent' },
      TOKEN,
    );

    const result = await service.weakness({ accountId: scope.account.id }, TOKEN);
    assert.equal(result.coverage.retrospectivesRead, 1);
    assert.equal(result.report.attemptedDistinctTotal, 0, 'no submission is claimed for the account');
  });
});

void test('retrospective rows naming another account, source or non-canonical key are refused', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
  const foreign = fx.makeProblem(fx.makeRef(fx.makeInstance('luogu', 'luogu.com.cn'), 'Q1'));

  await withBench(
    async ({ store, service }) => {
      await seedScope(store, scope);
      await rejectsDomain(
        service.weakness({ accountId: scope.account.id }, TOKEN),
        'invalid_input',
        'retrospective_source_mismatch',
      );
    },
    (store) => retrospectivesReturningStore(store, [fx.makeRetrospective(foreign, scope.account.id)]),
  );

  await withBench(
    async ({ store, service }) => {
      await seedScope(store, scope);
      await rejectsDomain(
        service.weakness({ accountId: scope.account.id }, TOKEN),
        'invalid_input',
        'retrospective_account_mismatch',
      );
    },
    (store) =>
      retrospectivesReturningStore(store, [fx.makeRetrospective(scope.problem, fx.makeAccount(scope.instance, 'bob').id)]),
  );

  const malformed: Retrospective = { ...fx.makeRetrospective(scope.problem, scope.account.id), problemKey: 'not-a-key' };
  await withBench(
    async ({ store, service }) => {
      await seedScope(store, scope);
      await rejectsDomain(
        service.weakness({ accountId: scope.account.id }, TOKEN),
        'invalid_input',
        'retrospective_key_mismatch',
      );
    },
    (store) => retrospectivesReturningStore(store, [malformed]),
  );
});

void test('an overfull decision history is refused and a preview writes no plan', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
  const decision = fx.makeTagDecision(scope.problem);
  await withBench(
    async ({ store, service }) => {
      await seedScope(store, scope);
      await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'wrong_answer')]);
      await rejectsDomain(
        service.weakness({ accountId: scope.account.id }, TOKEN),
        'invalid_input',
        'decision_history_overflow',
      );
      await rejectsDomain(
        service.previewPlan({ accountId: scope.account.id, candidateProblemKeys: [scope.problem.key] }, TOKEN),
        'invalid_input',
        'decision_history_overflow',
      );
      assert.deepEqual(await store.listPlans(scope.account.id), [], 'overflowing evidence never writes a plan');
    },
    (store) => decisionsReturningStore(store, Array.from({ length: MAX_WEAKNESS_DECISIONS + 1 }, () => decision)),
  );
});

void test('an overfull retrospective history is refused and a preview writes no plan', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', 'P1');
  const retrospective = fx.makeRetrospective(scope.problem, scope.account.id);
  await withBench(
    async ({ store, service }) => {
      await seedScope(store, scope);
      await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'wrong_answer')]);
      await rejectsDomain(
        service.weakness({ accountId: scope.account.id }, TOKEN),
        'invalid_input',
        'retrospective_history_overflow',
      );
      await rejectsDomain(
        service.previewPlan({ accountId: scope.account.id, candidateProblemKeys: [scope.problem.key] }, TOKEN),
        'invalid_input',
        'retrospective_history_overflow',
      );
      assert.deepEqual(await store.listPlans(scope.account.id), [], 'overflowing evidence never writes a plan');
    },
    (store) =>
      retrospectivesReturningStore(store, Array.from({ length: MAX_WEAKNESS_RETROSPECTIVES + 1 }, () => retrospective)),
  );
});
