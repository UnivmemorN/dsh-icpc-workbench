/**
 * Batch completion editing over a real temporary SQLite store (Sprint 23a).
 *
 * These cases drive the real `WorkbenchService` and its new `retrospective-edit` module; nothing
 * reaches a platform, a model or the network. They assert the externally meaningful behaviour:
 * latest-wins listing with deduplicated keys, note/skill/solution preservation across edits, the
 * union of explicitly chosen skills, no-op and stale-preview writes, whole-batch rollback on a
 * missing/foreign item or a cancellation, the single-record compare-and-set, and the downstream
 * effect of an edit on the weakness/knowledge/ability/assessment-capture views.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import type { TrainingStore } from '../../src/application/ports.js';
import {
  MAX_RETROSPECTIVE_IDS,
  WorkbenchService,
  type WorkbenchServiceOptions,
} from '../../src/application/workbench-service.js';
import {
  MAX_RETROSPECTIVE_EDIT_IDS,
  MAX_RETROSPECTIVE_EDIT_KEYS,
  type RetrospectiveEditRequest,
} from '../../src/application/retrospective-edit.js';
import {
  CURRENT_TAXONOMY,
  DomainError,
  createCancellationSource,
  createTaxonomyIndex,
  type CancellationSource,
  type DomainErrorCode,
  type Retrospective,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-11-01T08:00:00.000Z';
const TOKEN = createCancellationSource().token;
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** Three real ids of the shipped vocabulary: two techniques and one category. */
const STACK = 'data-structure.stack';
const QUEUE = 'data-structure.queue';
const CATEGORY = 'data-structure';

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
    uniqueId: () => `edit-${(minted += 1)}`,
  };
  const service = new WorkbenchService(options);
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

/** Cancel the caller's token right after the first retrospective write commits inside a transaction. */
function cancelAfterFirstSave(realStore: SqliteTrainingStore, source: CancellationSource): TrainingStore {
  let saves = 0;
  return new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === 'saveRetrospective') {
        return async (retrospective: Retrospective) => {
          await target.saveRetrospective(retrospective);
          saves += 1;
          if (saves === 1) {
            source.cancel();
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TrainingStore;
}

void test('retro.list reports the latest record per deduplicated key and enforces its bounds', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const secondProblem = fx.makeProblem(fx.makeRef(scope.instance, '2B'));
    const missing = fx.makeProblem(fx.makeRef(scope.instance, 'MISSING'));
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account]);
    await store.upsertProblems([scope.problem, secondProblem]);

    await service.recordRetrospective(
      {
        problemKey: scope.problem.key,
        accountId: scope.account.id,
        mode: 'solution_used',
        taxonomyIds: [STACK],
        note: 'first pass',
      },
      TOKEN,
    );
    const latest = await service.recordRetrospective(
      { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'assisted', note: 'second pass' },
      TOKEN,
    );

    const page = await service.listRetrospectiveEdits(
      { accountId: scope.account.id, problemKeys: [scope.problem.key, secondProblem.key, scope.problem.key] },
      TOKEN,
    );
    assert.equal(page.accountId, scope.account.id);
    assert.deepEqual(
      page.items.map((item) => item.problemKey),
      [scope.problem.key, secondProblem.key],
      'duplicates collapse while order is preserved',
    );
    assert.equal(page.items[0]?.title, scope.problem.title);
    assert.equal(page.items[0]?.mode, 'assisted', 'the latest record wins');
    assert.equal(page.items[0]?.retrospectiveId, latest.retrospectiveId);
    assert.equal(page.items[0]?.recordedAt, latest.recordedAt);
    assert.equal(page.items[1]?.mode, null);
    assert.equal(page.items[1]?.retrospectiveId, null);
    assert.equal(page.items[1]?.recordedAt, null);
    assert.equal(Object.hasOwn(page.items[0]!, 'note'), false, 'the list never carries worked material');

    await rejectsDomain(
      service.listRetrospectiveEdits({ accountId: scope.account.id, problemKeys: [] }, TOKEN),
      'invalid_input',
    );
    await rejectsDomain(
      service.listRetrospectiveEdits({ accountId: scope.account.id, problemKeys: [missing.key] }, TOKEN),
      'missing_reference',
    );
    const oversized = Array.from({ length: MAX_RETROSPECTIVE_EDIT_KEYS + 1 }, (_, index) => `key-${index}`);
    await rejectsDomain(
      service.listRetrospectiveEdits({ accountId: scope.account.id, problemKeys: oversized }, TOKEN),
      'invalid_input',
      'problem_key_list_out_of_bounds',
    );
  });
});

void test('an edit preserves the note, skills and consulted solutions while unioning chosen skills', async () => {
  assert.equal(MAX_RETROSPECTIVE_EDIT_IDS, MAX_RETROSPECTIVE_IDS, 'the edit bound mirrors the record bound');
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(store, scope);
    await store.saveSnapshot(fx.makeSnapshot(scope.problem));
    const recorded = await service.recordRetrospective(
      {
        problemKey: scope.problem.key,
        accountId: scope.account.id,
        mode: 'solution_used',
        taxonomyIds: [STACK],
        solutionIds: ['solution-1'],
        note: 'read the editorial',
      },
      TOKEN,
    );

    const intent: RetrospectiveEditRequest = {
      accountId: scope.account.id,
      problemKeys: [scope.problem.key],
      mode: 'assisted',
      knowledge: { kind: 'add', taxonomyIds: [QUEUE, STACK] },
    };
    const preview = await service.previewRetrospectiveEdits(intent, TOKEN);
    assert.equal(preview.mode, 'assisted');
    assert.equal(preview.changedCount, 1);
    assert.equal(preview.unchangedCount, 0);
    assert.equal(preview.previewHash.length, 64);
    const entry = preview.items[0]!;
    assert.equal(entry.previousMode, 'solution_used');
    assert.equal(entry.nextMode, 'assisted');
    assert.equal(entry.changed, true);
    assert.equal(entry.existingTaxonomyCount, 1);
    assert.deepEqual(entry.addedTaxonomyIds, [QUEUE], 'only the genuinely new chosen skill is reported');
    assert.equal(entry.clearedSolutionCount, 0);
    for (const secret of ['taxonomyIds', 'solutionIds', 'note']) {
      assert.equal(Object.hasOwn(entry, secret), false, `the preview never exposes ${secret}`);
    }

    const applied = await service.applyRetrospectiveEdits(
      { ...intent, expectedPreviewHash: preview.previewHash },
      TOKEN,
    );
    assert.equal(applied.changedCount, 1);
    assert.equal(applied.unchangedCount, 0);
    assert.equal(applied.items[0]?.changed, true);

    const history = await store.listRetrospectives(scope.account.id);
    assert.equal(history.length, 2, 'history stays append-only');
    const latest = history[1]!;
    assert.equal(latest.mode, 'assisted');
    assert.deepEqual(latest.taxonomyIds, [STACK, QUEUE], 'add is a union, never a replacement');
    assert.deepEqual(latest.solutionIds, ['solution-1'], 'consulted solutions survive an assisted edit');
    assert.equal(latest.note, 'read the editorial', 'the note is preserved');
    assert.ok(Date.parse(latest.recordedAt) > Date.parse(recorded.recordedAt), 'a repeated clock stays ordered');

    // Repeating the identical intent is a no-op: no duplicate row, and the hash is stable.
    const repeat = await service.previewRetrospectiveEdits(intent, TOKEN);
    assert.equal(repeat.changedCount, 0);
    assert.equal(repeat.items[0]?.changed, false);
    assert.notEqual(repeat.previewHash, preview.previewHash, 'the hash follows the record the apply appended');
    const noop = await service.applyRetrospectiveEdits(
      { ...intent, expectedPreviewHash: repeat.previewHash },
      TOKEN,
    );
    assert.equal(noop.changedCount, 0);
    assert.equal(noop.items[0]?.changed, false);
    assert.equal((await store.listRetrospectives(scope.account.id)).length, 2, 'a no-op writes no duplicate');

    // Switching to independent clears the consulted solutions and keeps note and skills.
    const soloIntent: RetrospectiveEditRequest = {
      accountId: scope.account.id,
      problemKeys: [scope.problem.key],
      mode: 'independent',
    };
    const solo = await service.previewRetrospectiveEdits(soloIntent, TOKEN);
    assert.equal(solo.items[0]?.clearedSolutionCount, 1, 'the consultation to be cleared is announced');
    assert.deepEqual(solo.items[0]?.addedTaxonomyIds, [], 'preserve infers no skill from raw or AI tags');
    await service.applyRetrospectiveEdits({ ...soloIntent, expectedPreviewHash: solo.previewHash }, TOKEN);
    const detail = await service.getProblem(
      { problemKey: scope.problem.key, accountId: scope.account.id, reveal: true },
      TOKEN,
    );
    assert.equal(detail.latestRetrospective?.mode, 'independent');
    assert.deepEqual(detail.latestRetrospective?.solutionIds, []);
    assert.deepEqual(detail.latestRetrospective?.taxonomyIds, [STACK, QUEUE]);
    assert.equal(detail.latestRetrospective?.note, 'read the editorial');
  });
});

void test('a stale preview and a mixed missing/foreign batch write nothing', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const other = fx.makeScope('codeforces', 'codeforces.com', 'bob', '2B');
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertAccounts([scope.account, other.account]);
    await store.upsertProblems([scope.problem, other.problem]);

    const intent: RetrospectiveEditRequest = {
      accountId: scope.account.id,
      problemKeys: [scope.problem.key],
      mode: 'assisted',
    };
    const preview = await service.previewRetrospectiveEdits(intent, TOKEN);
    // A newer record lands after the preview was computed.
    await service.recordRetrospective(
      { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'independent' },
      TOKEN,
    );
    await rejectsDomain(
      service.applyRetrospectiveEdits({ ...intent, expectedPreviewHash: preview.previewHash }, TOKEN),
      'invalid_transition',
      'stale_preview',
    );
    assert.equal((await store.listRetrospectives(scope.account.id)).length, 1, 'a stale preview writes nothing');

    // Mixed batch: one foreign-source problem refuses the whole batch before any write.
    const foreignInstance = fx.makeInstance('luogu', 'luogu.com.cn');
    const foreignProblem = fx.makeProblem(fx.makeRef(foreignInstance, 'P1000'));
    await store.upsertSourceInstances([foreignInstance]);
    await store.upsertProblems([foreignProblem]);
    await rejectsDomain(
      service.previewRetrospectiveEdits(
        { accountId: scope.account.id, problemKeys: [scope.problem.key, foreignProblem.key], mode: 'assisted' },
        TOKEN,
      ),
      'invalid_input',
      'problem_source_mismatch',
    );
    const missingProblem = fx.makeProblem(fx.makeRef(scope.instance, 'MISSING'));
    const missingPreview = { ...intent, problemKeys: [scope.problem.key, missingProblem.key] };
    await rejectsDomain(service.previewRetrospectiveEdits(missingPreview, TOKEN), 'missing_reference');
    await rejectsDomain(
      service.applyRetrospectiveEdits({ ...missingPreview, expectedPreviewHash: preview.previewHash }, TOKEN),
      'missing_reference',
    );
    assert.equal((await store.listRetrospectives(scope.account.id)).length, 1, 'the batch wrote nothing');

    // Another account's completion never leaks into this account's batch view.
    await service.recordRetrospective(
      { problemKey: other.problem.key, accountId: other.account.id, mode: 'assisted' },
      TOKEN,
    );
    const mine = await service.listRetrospectiveEdits(
      { accountId: scope.account.id, problemKeys: [scope.problem.key] },
      TOKEN,
    );
    assert.equal(mine.items[0]?.mode, 'independent');
  });
});

void test('knowledge intents are validated before any read: unknown, category, oversized, malformed', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(store, scope);
    const base = { accountId: scope.account.id, problemKeys: [scope.problem.key], mode: 'assisted' as const };

    await rejectsDomain(
      service.previewRetrospectiveEdits({ ...base, knowledge: { kind: 'add', taxonomyIds: ['nope.tag'] } }, TOKEN),
      'unknown_taxonomy_id',
    );
    await rejectsDomain(
      service.previewRetrospectiveEdits({ ...base, knowledge: { kind: 'add', taxonomyIds: [CATEGORY] } }, TOKEN),
      'invalid_input',
      'category_taxonomy_id',
    );
    await rejectsDomain(
      service.previewRetrospectiveEdits({ ...base, knowledge: { kind: 'add', taxonomyIds: [] } }, TOKEN),
      'invalid_input',
      'empty_taxonomy_ids',
    );
    const oversized = Array.from({ length: MAX_RETROSPECTIVE_EDIT_IDS + 1 }, (_, index) => `tag-${index}`);
    await rejectsDomain(
      service.previewRetrospectiveEdits({ ...base, knowledge: { kind: 'add', taxonomyIds: oversized } }, TOKEN),
      'invalid_input',
      'id_list_too_long',
    );
    await rejectsDomain(
      service.previewRetrospectiveEdits(
        { ...base, knowledge: { kind: 'preserve', taxonomyIds: [STACK] } } as unknown as RetrospectiveEditRequest,
        TOKEN,
      ),
      'invalid_input',
      'preserve_with_taxonomy_ids',
    );
    assert.deepEqual(await store.listRetrospectives(scope.account.id), [], 'no invalid intent writes a row');
  });
});

void test('pre-write and mid-write cancellation roll the whole batch back', async () => {
  const source = createCancellationSource();
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeProblem(fx.makeRef(scope.instance, '2B'));
  await withBench(
    async ({ store, service }) => {
      await store.upsertSourceInstances([scope.instance]);
      await store.upsertAccounts([scope.account]);
      await store.upsertProblems([scope.problem, second]);
      const intent: RetrospectiveEditRequest = {
        accountId: scope.account.id,
        problemKeys: [scope.problem.key, second.key],
        mode: 'assisted',
      };
      const preview = await service.previewRetrospectiveEdits(intent, TOKEN);
      assert.equal(preview.changedCount, 2, 'a no-record problem needs a new record');
      const cancelled = createCancellationSource();
      cancelled.cancel();
      await rejectsDomain(service.previewRetrospectiveEdits(intent, cancelled.token), 'cancelled');

      await rejectsDomain(
        service.applyRetrospectiveEdits({ ...intent, expectedPreviewHash: preview.previewHash }, source.token),
        'cancelled',
      );
      assert.deepEqual(
        await store.listRetrospectives(scope.account.id),
        [],
        'the row committed before the cancellation is rolled back with the batch',
      );
    },
    (store) => cancelAfterFirstSave(store, source),
  );
});

void test('single full-record editing compares the expected retrospective id inside its transaction', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(store, scope);

    const first = await service.recordRetrospective(
      { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'independent', expectedRetrospectiveId: null },
      TOKEN,
    );
    assert.equal(first.recorded, true);
    await rejectsDomain(
      service.recordRetrospective(
        { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'assisted', expectedRetrospectiveId: null },
        TOKEN,
      ),
      'invalid_transition',
      'stale_retrospective',
    );
    await rejectsDomain(
      service.recordRetrospective(
        {
          problemKey: scope.problem.key,
          accountId: scope.account.id,
          mode: 'assisted',
          expectedRetrospectiveId: 'retro|someone-else',
        },
        TOKEN,
      ),
      'invalid_transition',
      'stale_retrospective',
    );
    assert.equal((await store.listRetrospectives(scope.account.id)).length, 1, 'a refused CAS writes nothing');

    await service.recordRetrospective(
      {
        problemKey: scope.problem.key,
        accountId: scope.account.id,
        mode: 'assisted',
        expectedRetrospectiveId: first.retrospectiveId,
      },
      TOKEN,
    );
    // Omitting the field keeps the legacy append behaviour for old clients.
    await service.recordRetrospective(
      { problemKey: scope.problem.key, accountId: scope.account.id, mode: 'solution_used' },
      TOKEN,
    );
    assert.equal((await store.listRetrospectives(scope.account.id)).length, 3);
  });
});

void test('an edited completion is what weakness, ability and assessment capture read next', async () => {
  await withBench(async ({ store, service, clock }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    await seed(store, scope);
    await store.saveSnapshot(fx.makeSnapshot(scope.problem));
    await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted')]);
    await service.recordRetrospective(
      {
        problemKey: scope.problem.key,
        accountId: scope.account.id,
        mode: 'independent',
        taxonomyIds: [STACK],
      },
      TOKEN,
    );

    const before = await service.weakness({ accountId: scope.account.id }, TOKEN);
    const nodeBefore = before.knowledge.nodes.find((node) => node.taxonomyId === STACK);
    assert.equal(nodeBefore?.retrospectiveIndependentDistinct, 1);
    assert.equal(nodeBefore?.retrospectiveAssistedDistinct, 0);
    assert.equal(before.ability.completionModes.allTime.independent, 1);
    const captureBefore = await service.captureAssessmentInput(
      { accountId: scope.account.id, capturedAt: AT },
      TOKEN,
    );
    const rowBefore = captureBefore.prompt.knowledge.find((row) => row.taxonomyId === STACK);
    assert.equal(rowBefore?.retrospectiveIndependentDistinct, 1, 'the capture reads the latest retrospective');

    const intent: RetrospectiveEditRequest = {
      accountId: scope.account.id,
      problemKeys: [scope.problem.key],
      mode: 'assisted',
    };
    const preview = await service.previewRetrospectiveEdits(intent, TOKEN);
    await service.applyRetrospectiveEdits({ ...intent, expectedPreviewHash: preview.previewHash }, TOKEN);

    // Advance the fixture clock beyond the monotonic append; ability excludes future evidence.
    clock.value = '2026-11-01T08:00:01.000Z';
    const after = await service.weakness({ accountId: scope.account.id }, TOKEN);
    const nodeAfter = after.knowledge.nodes.find((node) => node.taxonomyId === STACK);
    assert.equal(nodeAfter?.retrospectiveIndependentDistinct, 0);
    assert.equal(nodeAfter?.retrospectiveAssistedDistinct, 1);
    assert.equal(after.ability.completionModes.allTime.independent, 0);
    assert.equal(after.ability.completionModes.allTime.assisted, 1);
    const captureAfter = await service.captureAssessmentInput(
      { accountId: scope.account.id, capturedAt: clock.value },
      TOKEN,
    );
    const rowAfter = captureAfter.prompt.knowledge.find((row) => row.taxonomyId === STACK);
    assert.equal(rowAfter?.retrospectiveAssistedDistinct, 1);
    assert.equal(rowAfter?.retrospectiveIndependentDistinct, 0);
  });
});
