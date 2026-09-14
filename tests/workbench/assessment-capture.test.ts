/**
 * Real `WorkbenchService` assessment source capture over SQLite (Sprint 18d1 repair).
 *
 * Every case drives the real `captureAssessmentInput` against a temporary `SqliteTrainingStore`:
 * nothing reaches a platform, a model or the network. The assertions cover the externally
 * meaningful capture contract — a free capture that needs no unsolved plan candidate, an
 * identifier-free model-facing prompt, recapture stability under a moved clock, and a source hash
 * that changes for every semantic mutation of the account's own evidence.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import {
  CURRENT_TAXONOMY,
  createTaxonomyIndex,
  createVirtualPerformanceLedger,
  guidanceMethodHash,
  validateGuidanceMethodRegistration,
  validateOfficialRating,
  type GuidanceMethodDefinition,
  type InstalledGuidanceMethod,
  type VirtualPerformanceLedger,
} from '../../src/domain/index.js';
import * as balanced from '../../packages/dsh-icpc-method-balanced/index.js';
import {
  AT,
  CONTEST_NAME,
  EARLIER,
  HANDLE,
  LATER,
  PROBLEM_STATEMENT,
  RETRO_NOTE,
  TOKEN,
  officialRatingSnapshot,
} from '../assessment-fixtures.js';
import * as fx from '../storage/fixtures.js';

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly service: WorkbenchService;
  /** Mutable installed catalogue: replacing an entry simulates updating the method text. */
  readonly installed: InstalledGuidanceMethod[];
}

/** One installed catalogue entry exactly as the registry publishes it. */
function install(definition: GuidanceMethodDefinition, installedOrder: number): InstalledGuidanceMethod {
  return { definition, methodHash: guidanceMethodHash(definition), installedOrder };
}

/** One real store, one real catalogue and one real service; the catalogue can be replaced per case. */
async function withBench(run: (bench: Bench) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const installed: InstalledGuidanceMethod[] = [
    install(validateGuidanceMethodRegistration(balanced.balancedMethod), 1),
  ];
  const store = new SqliteTrainingStore({ path: paths.path, now: () => AT });
  let minted = 0;
  const service = new WorkbenchService({
    store,
    taxonomy: createTaxonomyIndex(CURRENT_TAXONOMY),
    now: () => AT,
    uniqueId: () => `capture-${(minted += 1)}`,
    guidance: { catalog: async () => installed },
  });
  try {
    await run({ store, service, installed });
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

/** One capture request; the observation instant and the explicit method selection are the inputs. */
function request(
  accountId: string,
  capturedAt: string,
  guidanceMethodIds?: readonly string[],
): { accountId: string; capturedAt: string; guidanceMethodIds?: readonly string[] } {
  return guidanceMethodIds === undefined ? { accountId, capturedAt } : { accountId, capturedAt, guidanceMethodIds };
}

/** One user-entered virtual run: independent and unseen before the contest, so it is an anchor. */
function ledgerOf(accountId: string): VirtualPerformanceLedger {
  return createVirtualPerformanceLedger({
    accountId,
    revision: 1,
    updatedAt: fx.AT,
    entries: [
      {
        evidenceId: 'evidence-secret-1',
        contestId: 987654,
        participatedAt: '2026-10-03T12:13:14.000Z',
        performance: 1720,
        calculationMethod: 'carrot',
        sourceUrl: 'https://example.org/private-ledger-entry',
        independence: 'independent',
        priorExposure: false,
        rank: 37,
        note: 'private participation note',
      },
    ],
  });
}

test('a free capture needs no unsolved candidate and survives a moved clock with identical hashes', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A', { statement: PROBLEM_STATEMENT });
    await seed(store, scope);

    const first = await service.captureAssessmentInput(request(scope.account.id, AT), TOKEN);
    assert.equal(first.accountId, scope.account.id);
    assert.equal(first.sourceInstanceId, scope.instance.id);
    assert.equal(first.capturedAt, AT);
    assert.equal(first.prompt.anchor.kind, 'none', 'no official rating and no eligible virtual run is no anchor');
    assert.equal(first.prompt.anchor.evidenceRef, null);
    assert.ok(first.prompt.evidence.some((entry) => entry.evidenceRef === 'ev-self-assessment'));
    // A capture is evidence, not a plan pool: it neither reads nor requires an unsolved candidate.
    assert.equal(Object.hasOwn(first.prompt, 'candidates'), false);
    assert.equal(first.prompt.knowledgeTotalRows, first.prompt.knowledge.length);

    // Only the observation instant moved; the store is untouched, so both clock-free hashes stay.
    const later = await service.captureAssessmentInput(request(scope.account.id, LATER), TOKEN);
    assert.equal(later.capturedAt, LATER);
    assert.equal(later.evidenceHash, first.evidenceHash);
    assert.equal(later.sourceHash, first.sourceHash);
  });
});

test('private evidence never reaches the model-facing prompt while identity still binds the source hash', async () => {
  await withBench(async ({ store, service }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A', { statement: PROBLEM_STATEMENT });
    await seed(store, scope);
    await store.upsertSubmissions([
      fx.makeSubmission(scope.account, scope.problem.ref, 'submission-secret-77', 'wrong_answer', fx.AT),
    ]);
    await store.saveRetrospective(
      fx.makeRetrospective(scope.problem, scope.account.id, { recordedAt: fx.AT, note: RETRO_NOTE }),
    );
    // The official snapshot belongs to the stored account, whatever the canonical id spelling is.
    await store.saveOfficialRating(
      validateOfficialRating({ ...officialRatingSnapshot(), accountId: scope.account.id }),
      0,
    );
    await store.saveVirtualPerformanceLedger(ledgerOf(scope.account.id), 0);

    const capture = await service.captureAssessmentInput(request(scope.account.id, AT), TOKEN);
    assert.equal(capture.prompt.anchor.kind, 'official_rating');
    const statement = scope.problem.statement;
    assert.ok(statement !== null, 'the storage fixture carries a statement');
    const serialized = JSON.stringify(capture.prompt);
    for (const privateValue of [
      scope.account.id,
      HANDLE,
      scope.instance.id,
      scope.problem.title,
      statement,
      scope.problem.url,
      'submission-secret-77',
      RETRO_NOTE,
      CONTEST_NAME,
      'evidence-secret-1',
      '987654',
      'https://example.org/private-ledger-entry',
      'private participation note',
      'data structures',
      'segment tree',
      AT,
      EARLIER,
    ]) {
      assert.equal(serialized.includes(privateValue), false, `the prompt must not carry ${privateValue}`);
    }

    // Two accounts with byte-identical (empty) evidence: the evidence hash agrees, the identity does not.
    const left = fx.makeScope('codeforces', 'codeforces.com', 'left', '1A');
    const right = fx.makeScope('codeforces', 'codeforces.com', 'right', '1A');
    await store.upsertAccounts([left.account, right.account]);
    const leftCapture = await service.captureAssessmentInput(request(left.account.id, AT), TOKEN);
    const rightCapture = await service.captureAssessmentInput(request(right.account.id, AT), TOKEN);
    assert.equal(leftCapture.evidenceHash, rightCapture.evidenceHash);
    assert.notEqual(leftCapture.sourceHash, rightCapture.sourceHash);
  });
});

test('every semantic source mutation invalidates the source hash', async () => {
  await withBench(async ({ store, service, installed }) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A', { statement: PROBLEM_STATEMENT });
    await seed(store, scope);
    const capture = (guidanceMethodIds?: readonly string[]): Promise<Awaited<ReturnType<WorkbenchService['captureAssessmentInput']>>> =>
      service.captureAssessmentInput(request(scope.account.id, AT, guidanceMethodIds), TOKEN);

    const base = await capture();
    assert.equal(base.prompt.anchor.kind, 'none');

    // A solve exists, so there is no unsolved candidate left; the capture still works.
    await store.upsertSubmissions([fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted', fx.AT)]);
    const practice = await capture();
    assert.notEqual(practice.sourceHash, base.sourceHash);
    assert.notEqual(practice.evidenceHash, base.evidenceHash);

    await store.saveRetrospective(
      fx.makeRetrospective(scope.problem, scope.account.id, { recordedAt: fx.LATER, note: RETRO_NOTE }),
    );
    const retrospective = await capture();
    assert.notEqual(retrospective.sourceHash, practice.sourceHash);
    assert.notEqual(retrospective.evidenceHash, practice.evidenceHash);

    await store.saveVirtualPerformanceLedger(ledgerOf(scope.account.id), 0);
    const virtual = await capture();
    assert.notEqual(virtual.sourceHash, retrospective.sourceHash);
    assert.equal(virtual.prompt.anchor.kind, 'virtual_performance');

    // The official snapshot belongs to the stored account, whatever the canonical id spelling is.
    await store.saveOfficialRating(
      validateOfficialRating({ ...officialRatingSnapshot(), accountId: scope.account.id }),
      0,
    );
    const official = await capture();
    assert.notEqual(official.sourceHash, virtual.sourceHash);
    assert.equal(official.prompt.anchor.kind, 'official_rating', 'the exact official rating outranks the virtual anchor');

    const methodId = installed[0]!.definition.methodId;
    const guided = await capture([methodId]);
    assert.notEqual(guided.sourceHash, official.sourceHash);
    assert.equal(guided.snapshot.guidance.kind, 'assessment');
    assert.ok(guided.prompt.evidence.some((entry) => entry.evidenceRef === `ev-method-${methodId}`));

    const previous = installed[0]!;
    installed[0] = install(
      { ...previous.definition, summary: `${previous.definition.summary}（本地修订版）` },
      previous.installedOrder,
    );
    const replaced = await capture([methodId]);
    assert.notEqual(replaced.sourceHash, guided.sourceHash, 'replacing the installed method text invalidates the capture');

    // The source instance is part of the identity as well as the account.
    const luogu = fx.makeScope('luogu', 'luogu.com.cn', 'alice', 'P1');
    await store.upsertSourceInstances([luogu.instance]);
    await store.upsertAccounts([luogu.account]);
    const foreign = await service.captureAssessmentInput(request(luogu.account.id, AT), TOKEN);
    assert.equal(foreign.prompt.anchor.kind, 'none');
    assert.notEqual(foreign.sourceHash, base.sourceHash);
  });
});
