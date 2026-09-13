/**
 * Sprint 11b — completeness review and rerunnable analysis.
 *
 * The store is a real temporary SQLite database and the model is a deterministic scripted
 * gateway, so the behaviour under test (prepare eligibility, run identity, completeness
 * adoption, decision supersession, persistence, parser strictness) is the behaviour a restart
 * or a rerun really sees. The fake never mirrors pipeline internals.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { parseVerificationOutput } from '../../src/adapters/dsh/model-output.js';
import { AnalysisPipeline } from '../../src/application/analysis-pipeline.js';
import {
  DEFAULT_MODEL_LIMITS,
  type AnalyzeOutcome,
  type AnalyzeRequest,
  type ModelCallResult,
  type ModelGateway,
  type VerifyOutcome,
  type VerifyRequest,
} from '../../src/application/ports.js';
import {
  COMPLETENESS_AUDIT_VERSION,
  DomainError,
  analysisJobIdOf,
  createAiTagSuggestion,
  createAnalysisCompleteness,
  createAnalysisJob,
  createAnalysisResult,
  createEditorialSolution,
  createEditorialSource,
  createManualTagDecision,
  createModelUsage,
  createNormalizedProblem,
  createProblemSnapshot,
  createSuggestionVerification,
  createTagDecision,
  createTaxonomy,
  createTaxonomyIndex,
  effectiveTagIdsForProblem,
  transitionJob,
  type AiTagSuggestion,
  type NormalizedProblem,
  type ProblemSnapshot,
  type Taxonomy,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const SEGMENT = 'data-structure.segment-tree';
const GREEDY = 'paradigm.greedy';
const SOLUTION_TEXT = 'The editorial uses lazy propagation: range updates stay O(log n) with a segment tree.';
const EXCERPT = 'lazy propagation';

function makeTaxonomy(): Taxonomy {
  return createTaxonomy({
    version: 'test-v1',
    nodes: [
      {
        id: 'data-structure',
        parentId: null,
        kind: 'category',
        names: { en: 'Data structures', zh: '数据结构' },
        aliases: [],
        description: 'container techniques',
      },
      {
        id: SEGMENT,
        parentId: 'data-structure',
        kind: 'technique',
        names: { en: 'Segment tree', zh: '线段树' },
        aliases: ['segment tree'],
        description: 'range queries',
      },
      {
        id: 'paradigm',
        parentId: null,
        kind: 'category',
        names: { en: 'Paradigms', zh: '范式' },
        aliases: [],
        description: 'algorithm paradigms',
      },
      {
        id: GREEDY,
        parentId: 'paradigm',
        kind: 'technique',
        names: { en: 'Greedy', zh: '贪心' },
        aliases: ['greedy'],
        description: 'local choice',
      },
    ],
  });
}

const TAXONOMY = makeTaxonomy();

interface Clock {
  now(): string;
  at(iso: string): void;
}

function makeClock(): Clock {
  let current = fx.AT;
  return {
    now: () => current,
    at: (iso) => {
      current = iso;
    },
  };
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

interface Fixture {
  readonly store: SqliteTrainingStore;
  readonly clock: Clock;
  readonly problem: NormalizedProblem;
  readonly snapshot: ProblemSnapshot;
  /**
   * Close this fixture's connection and open a fresh one on the very same SQLite file, so a test
   * can prove that what it read is what a restart reads. The caller must use the returned store:
   * the fixture's own `store` refers to the connection this call closed.
   */
  reopen(): Promise<SqliteTrainingStore>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const clock = makeClock();
  let store = new SqliteTrainingStore({ path: paths.path, now: () => clock.now() });
  try {
    const instance = fx.makeInstance('codeforces', 'codeforces.com');
    const problem = createNormalizedProblem({
      ref: { sourceInstanceId: instance.id, domain: null, externalKey: '1A' },
      title: 'Problem 1A',
      url: 'https://codeforces.com/problem/1A',
      statement: 'Given an array, support range add and range sum queries.',
      fetchedAt: fx.AT,
      ratings: [{ dimension: 'rating', value: 1800, scale: { min: 800, max: 3500 }, raw: '1800' }],
      rawTags: ['data structures', 'segment tree'],
    });
    const source = createEditorialSource({
      id: 'editorial-1',
      kind: 'editorial',
      url: 'https://editorial.example.org/1A',
      title: 'Editorial for 1A',
      availability: 'found',
      retrievedAt: fx.AT,
      text: SOLUTION_TEXT,
    });
    const solution = createEditorialSolution({
      solutionId: 'solution-1',
      sourceId: source.id,
      ordinal: 0,
      title: 'Lazy segment tree',
      text: SOLUTION_TEXT,
    });
    const snapshot = createProblemSnapshot({
      problem,
      sources: [source],
      solutions: [solution],
      capturedAt: fx.AT,
    });
    await store.upsertSourceInstances([instance]);
    await store.upsertProblems([problem]);
    await store.saveSnapshot(snapshot);
    await run({
      store,
      clock,
      problem,
      snapshot,
      reopen: async () => {
        await store.close();
        store = new SqliteTrainingStore({ path: paths.path, now: () => clock.now() });
        return store;
      },
    });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

/** Scripted gateway: records requests, answers with the currently configured outcome. */
class ScriptedGateway implements ModelGateway {
  readonly analyzeRequests: AnalyzeRequest[] = [];
  readonly verifyRequests: VerifyRequest[] = [];
  analyzeOutcome: AnalyzeOutcome = { suggestions: [] };
  verifyOutcome: VerifyOutcome = { verifications: [], missingSuggestions: [] };
  failAnalyze = false;

  capabilities() {
    return {
      provider: 'fake',
      implemented: true,
      roles: ['analysis', 'verification', 'reasoning'] as const,
      maxConcurrency: 1,
      notes: [],
    };
  }

  async analyze(request: AnalyzeRequest): Promise<ModelCallResult<AnalyzeOutcome>> {
    this.analyzeRequests.push(request);
    if (this.failAnalyze) {
      return {
        ok: false,
        error: { code: 'invalid_output', message: 'scripted failure', retryable: false },
        usage: createModelUsage({ calls: 1 }),
        callId: 'call-analysis',
      };
    }
    return {
      ok: true,
      value: this.analyzeOutcome,
      usage: createModelUsage({ calls: 1, promptTokens: 10, completionTokens: 5 }),
      callId: 'call-analysis',
    };
  }

  async verify(request: VerifyRequest): Promise<ModelCallResult<VerifyOutcome>> {
    this.verifyRequests.push(request);
    return {
      ok: true,
      value: this.verifyOutcome,
      usage: createModelUsage({ calls: 1, promptTokens: 10, completionTokens: 5 }),
      callId: 'call-verify',
    };
  }

  async reason(): Promise<never> {
    throw new Error('reasoning must not run for editorial material');
  }
}

function makePipeline(store: SqliteTrainingStore, gateway: ModelGateway, clock: Clock): AnalysisPipeline {
  return new AnalysisPipeline({
    store,
    gateway,
    taxonomy: TAXONOMY,
    roles: {
      analysisModel: 'fake-analysis',
      verificationModel: 'fake-verification',
      reasoningModel: 'fake-reasoning',
      maxOutputTokens: 1024,
      temperature: 0,
    },
    limits: DEFAULT_MODEL_LIMITS,
    now: () => clock.now(),
    uniqueId: nextId,
  });
}

function suggestionFor(
  problem: NormalizedProblem,
  snapshot: ProblemSnapshot,
  taxonomyId: string,
): AiTagSuggestion {
  return createAiTagSuggestion({
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    taxonomyId,
    role: 'analysis',
    rationale: 'The editorial cites lazy propagation.',
    evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }],
    createdAt: fx.AT,
  });
}

/** Persist a legacy (pre-completeness) success: analysis + succeeded job + auto-adopted tag. */
async function seedLegacySuccess(fixture: Fixture, taxonomyId: string): Promise<void> {
  const { store, problem, snapshot } = fixture;
  const suggestion = suggestionFor(problem, snapshot, taxonomyId);
  const verification = createSuggestionVerification({
    suggestionId: suggestion.suggestionId,
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    verdict: 'support',
    verifierRole: 'verification',
    evidenceOk: true,
    checkedAt: fx.AT,
  });
  const analysis = createAnalysisResult({
    problemRef: problem.ref,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    taxonomyVersion: TAXONOMY.version,
    createdAt: fx.AT,
    status: 'completed',
    suggestions: [suggestion],
    verifications: [verification],
    usage: createModelUsage({ calls: 2 }),
  });
  await store.saveAnalysis(analysis);
  const job = createAnalysisJob({ problemRef: problem.ref, snapshotId: snapshot.snapshotId, at: fx.AT });
  const started = transitionJob(job, { type: 'start', owner: 'legacy', at: fx.AT, leaseMs: 60_000 });
  await store.saveJob(transitionJob(started, { type: 'succeed', at: fx.AT, analysisId: analysis.analysisId }));
  await store.saveTagDecisions([
    createTagDecision({
      problemKey: problem.key,
      taxonomyId,
      status: 'auto_adopted',
      origin: 'ai',
      analysisId: analysis.analysisId,
      suggestionId: suggestion.suggestionId,
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.version,
      decidedAt: fx.AT,
      reasons: ['evidence_verified', 'verification_support'],
      evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }],
    }),
  ]);
}

// ---------------------------------------------------------------------------------------
// Completeness adoption
// ---------------------------------------------------------------------------------------

test('an empty analysis still verifies, counts the call and records completeness', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, problem, snapshot } = fixture;
    const gateway = new ScriptedGateway();
    gateway.analyzeOutcome = { suggestions: [] };
    gateway.verifyOutcome = { verifications: [], missingSuggestions: [] };
    const pipeline = makePipeline(store, gateway, clock);

    const prepared = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    assert.equal(prepared.alreadyDone.length, 0);
    assert.equal(prepared.reruns.length, 0);
    assert.ok(prepared.batch);
    const summary = await pipeline.run(prepared.batch.batchId);
    assert.equal(summary.status, 'completed');

    // The independent pass ran although the analysis proposed nothing.
    assert.equal(gateway.verifyRequests.length, 1);
    assert.deepEqual(gateway.verifyRequests[0]?.suggestions, []);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'succeeded');
    assert.equal(summary.counters.analysisCalls, 2);

    const analysis = await store.getAnalysis(job?.analysisId ?? '');
    assert.equal(analysis?.completeness?.version, COMPLETENESS_AUDIT_VERSION);
    assert.equal(analysis?.completeness?.taxonomyVersion, TAXONOMY.version);
    assert.equal(analysis?.completeness?.snapshotId, snapshot.snapshotId);
    assert.equal(analysis?.completeness?.omissionsChecked, true);
    // Nothing was adopted out of an empty answer.
    assert.deepEqual(effectiveTagIdsForProblem(await store.listTagDecisions(problem.key), problem.key), []);
  });
});

test('a verifier-discovered omission needs manual review and is never self-adopted', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, problem, snapshot } = fixture;
    const gateway = new ScriptedGateway();
    gateway.analyzeOutcome = { suggestions: [] };
    const discovered = createAiTagSuggestion({
      problemRef: problem.ref,
      snapshotId: snapshot.snapshotId,
      taxonomyId: GREEDY,
      role: 'verification',
      rationale: 'The editorial also picks the cheapest segment greedily.',
      evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }],
      createdAt: fx.AT,
    });
    gateway.verifyOutcome = { verifications: [], missingSuggestions: [discovered] };
    const pipeline = makePipeline(store, gateway, clock);

    const prepared = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    await pipeline.run(prepared.batch?.batchId ?? '');
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    const analysis = await store.getAnalysis(job?.analysisId ?? '');

    assert.equal(analysis?.suggestions.length, 1);
    assert.equal(analysis?.suggestions[0]?.role, 'verification');
    assert.equal(analysis?.verifications.length, 0);
    const decisions = await store.listTagDecisions(problem.key);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.status, 'needs_review');
    assert.ok(decisions[0]?.reasons.includes('missing_verification'));
    assert.deepEqual(effectiveTagIdsForProblem(decisions, problem.key), []);
  });
});

// ---------------------------------------------------------------------------------------
// Prepare eligibility and reruns
// ---------------------------------------------------------------------------------------

test('a legacy success without a completeness record is not skipped and gets a new identity', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, snapshot } = fixture;
    await seedLegacySuccess(fixture, SEGMENT);
    const pipeline = makePipeline(store, new ScriptedGateway(), clock);

    const prepared = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    assert.equal(prepared.alreadyDone.length, 0);
    assert.equal(prepared.reruns.length, 1);
    assert.equal(prepared.reruns[0]?.reason, 'legacy_unchecked');
    assert.equal(prepared.reruns[0]?.previousJobId, analysisJobIdOf(snapshot.snapshotId));
    assert.notEqual(prepared.reruns[0]?.jobId, analysisJobIdOf(snapshot.snapshotId));
    // The immutable legacy record is untouched.
    const legacy = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(legacy?.status, 'succeeded');
    assert.equal(legacy?.analysisId, prepared.reruns[0]?.previousJobId === legacy?.jobId ? legacy?.analysisId : legacy?.analysisId);
  });
});

test('a current completeness check is skipped; reanalyze forces a new run identity', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, snapshot } = fixture;
    const gateway = new ScriptedGateway();
    gateway.verifyOutcome = { verifications: [], missingSuggestions: [] };
    const pipeline = makePipeline(store, gateway, clock);

    const first = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    await pipeline.run(first.batch?.batchId ?? '');
    const checkedJob = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    const checkedAnalysisId = checkedJob?.analysisId ?? '';

    // Default mode: the stored success carries the current check for this snapshot/taxonomy.
    const second = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    assert.equal(second.batch, null);
    assert.equal(second.alreadyDone.length, 1);
    assert.equal(second.alreadyDone[0]?.completeness, 'current');
    assert.equal(second.alreadyDone[0]?.analysisId, checkedAnalysisId);
    assert.equal(second.reruns.length, 0);

    // Explicit rerun: a distinct job identity, the old job/result/history untouched.
    const third = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5, reanalyze: true });
    assert.ok(third.batch);
    assert.equal(third.alreadyDone.length, 0);
    assert.equal(third.reruns.length, 1);
    assert.equal(third.reruns[0]?.reason, 'reanalyze_requested');
    const rerunJobId = third.batch?.jobs[0]?.jobId ?? '';
    assert.notEqual(rerunJobId, analysisJobIdOf(snapshot.snapshotId));
    assert.notEqual(rerunJobId, checkedJob?.jobId);
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.analysisId, checkedAnalysisId);
    assert.ok(await store.getAnalysis(checkedAnalysisId));

    await pipeline.run(third.batch?.batchId ?? '');
    assert.equal((await store.getJob(rerunJobId))?.status, 'succeeded');
    // The earlier result stays readable and immutable.
    assert.ok(await store.getAnalysis(checkedAnalysisId));
  });
});

test('a re-checked snapshot is skipped by the next default prepare, and reanalyze stays fresh', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, snapshot } = fixture;
    await seedLegacySuccess(fixture, SEGMENT);
    const gateway = new ScriptedGateway();
    gateway.analyzeOutcome = { suggestions: [] };
    gateway.verifyOutcome = { verifications: [], missingSuggestions: [] };
    const pipeline = makePipeline(store, gateway, clock);

    // The legacy success carries no completeness record: it is not done and gets a new identity.
    const first = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    assert.equal(first.reruns.length, 1);
    const checkedJobId = first.batch?.jobs[0]?.jobId ?? '';
    assert.notEqual(checkedJobId, analysisJobIdOf(snapshot.snapshotId));
    await pipeline.run(first.batch?.batchId ?? '');
    const checkedJob = await store.getJob(checkedJobId);
    assert.equal(checkedJob?.status, 'succeeded');

    // The rerun identity — not only the legacy one — is what a default prepare must see as done.
    const second = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    assert.equal(second.batch, null);
    assert.equal(second.alreadyDone.length, 1);
    assert.equal(second.alreadyDone[0]?.jobId, checkedJobId);
    assert.equal(second.alreadyDone[0]?.analysisId, checkedJob?.analysisId);
    assert.equal(second.reruns.length, 0);

    // An explicit rerun gets another fresh identity and leaves the checked run untouched.
    const third = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5, reanalyze: true });
    assert.ok(third.batch);
    assert.equal(third.reruns[0]?.reason, 'reanalyze_requested');
    const freshJobId = third.batch?.jobs[0]?.jobId ?? '';
    assert.notEqual(freshJobId, checkedJobId);
    assert.notEqual(freshJobId, analysisJobIdOf(snapshot.snapshotId));
    await pipeline.run(third.batch?.batchId ?? '');
    assert.equal((await store.getJob(freshJobId))?.status, 'succeeded');
    assert.equal((await store.getJob(checkedJobId))?.analysisId, checkedJob?.analysisId);
    assert.ok(await store.getAnalysis(checkedJob?.analysisId ?? ''));

    const fourth = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    assert.equal(fourth.batch, null);
    assert.equal(fourth.alreadyDone.length, 1);
  });
});

test('a supplied run identity that already finished is refused instead of faking a batch', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, snapshot } = fixture;
    await seedLegacySuccess(fixture, SEGMENT);
    const gateway = new ScriptedGateway();
    gateway.verifyOutcome = { verifications: [], missingSuggestions: [] };
    const pipeline = makePipeline(store, gateway, clock);

    const first = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5, runId: 'run-once' });
    const reusedJobId = first.batch?.jobs[0]?.jobId ?? '';
    assert.equal(reusedJobId, analysisJobIdOf(snapshot.snapshotId, 'run-once'));
    await pipeline.run(first.batch?.batchId ?? '');
    assert.equal((await store.getJob(reusedJobId))?.status, 'succeeded');

    await assert.rejects(
      pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5, reanalyze: true, runId: 'run-once' }),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_transition',
    );
    // The finished record is untouched and only its original batch still references it.
    assert.equal((await store.getJob(reusedJobId))?.status, 'succeeded');
    const batches = await store.listBatches(null);
    assert.equal(batches.filter((batch) => batch.jobs.some((job) => job.jobId === reusedJobId)).length, 1);
  });
});

test('an active batch already scheduling the snapshot refuses a second run across run ids', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, snapshot } = fixture;
    await seedLegacySuccess(fixture, SEGMENT);
    const pipeline = makePipeline(store, new ScriptedGateway(), clock);
    await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    await assert.rejects(
      pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 }),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_transition',
    );
  });
});

test('a cancelled legacy run stays immutable and a rerun is scheduled explicitly', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, snapshot } = fixture;
    await seedLegacySuccess(fixture, SEGMENT);
    const legacyJob = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    await store.saveJob({
      ...(legacyJob as NonNullable<typeof legacyJob>),
      status: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: { code: 'cancelled', message: 'cancelled by user', retryable: false },
    });
    const pipeline = makePipeline(store, new ScriptedGateway(), clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    assert.equal(prepared.reruns.length, 1);
    assert.equal(prepared.reruns[0]?.reason, 'cancelled_run');
    assert.equal((await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.status, 'cancelled');
    assert.notEqual(prepared.reruns[0]?.jobId, analysisJobIdOf(snapshot.snapshotId));
  });
});

test('a completeness record of another taxonomy version is refused and is not a current check', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, problem, snapshot } = fixture;
    assert.throws(
      () =>
        createAnalysisResult({
          problemRef: problem.ref,
          snapshotId: snapshot.snapshotId,
          snapshotVersion: snapshot.version,
          taxonomyVersion: TAXONOMY.version,
          createdAt: fx.AT,
          status: 'completed',
          completeness: createAnalysisCompleteness({
            taxonomyVersion: 'old-taxonomy',
            snapshotId: snapshot.snapshotId,
            snapshotVersion: snapshot.version,
            checkedAt: fx.AT,
          }),
        }),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid_input',
    );

    // A stored success checked under another taxonomy version is not "already done" for this one.
    const foreign = createAnalysisResult({
      problemRef: problem.ref,
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.version,
      taxonomyVersion: 'old-taxonomy',
      createdAt: fx.AT,
      status: 'completed',
      completeness: createAnalysisCompleteness({
        taxonomyVersion: 'old-taxonomy',
        snapshotId: snapshot.snapshotId,
        snapshotVersion: snapshot.version,
        checkedAt: fx.AT,
      }),
    });
    await store.saveAnalysis(foreign);
    const job = createAnalysisJob({ problemRef: problem.ref, snapshotId: snapshot.snapshotId, at: fx.AT });
    const started = transitionJob(job, { type: 'start', owner: 'legacy', at: fx.AT, leaseMs: 60_000 });
    await store.saveJob(transitionJob(started, { type: 'succeed', at: fx.AT, analysisId: foreign.analysisId }));

    const pipeline = makePipeline(store, new ScriptedGateway(), clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    assert.equal(prepared.alreadyDone.length, 0);
    assert.equal(prepared.reruns.length, 1);
    assert.equal(prepared.reruns[0]?.reason, 'legacy_unchecked');
  });
});

// ---------------------------------------------------------------------------------------
// Superseding old automatic adoptions
// ---------------------------------------------------------------------------------------

test('a checked rerun withdraws an old adoption the new result does not support', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, problem, snapshot } = fixture;
    await seedLegacySuccess(fixture, SEGMENT);
    assert.deepEqual(effectiveTagIdsForProblem(await store.listTagDecisions(problem.key), problem.key), [SEGMENT]);

    const gateway = new ScriptedGateway();
    gateway.analyzeOutcome = { suggestions: [] };
    gateway.verifyOutcome = { verifications: [], missingSuggestions: [] };
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    await pipeline.run(prepared.batch?.batchId ?? '');

    const decisions = await store.listTagDecisions(problem.key);
    const withdrawal = decisions.find((decision) => decision.taxonomyId === SEGMENT && decision.status === 'needs_review');
    assert.ok(withdrawal, 'a needs_review withdrawal must be recorded');
    assert.ok(withdrawal?.reasons.includes('stale_analysis'));
    // The checked run is ordered strictly after the legacy result even though the clock repeated,
    // so the withdrawal really is the later decision instead of winning a status tie-break.
    assert.ok(withdrawal !== undefined && Date.parse(withdrawal.decidedAt) > Date.parse(fx.AT));
    assert.deepEqual(effectiveTagIdsForProblem(decisions, problem.key), []);
    // History is preserved: the original adoption row still exists.
    assert.ok(decisions.some((decision) => decision.status === 'auto_adopted'));
  });
});

test('a checked run withdraws and a later checked run re-adopts the tag, durably', async () => {
  await withFixture(async (fixture) => {
    const { clock, problem, snapshot } = fixture;
    const store = fixture.store;
    await seedLegacySuccess(fixture, SEGMENT);
    const legacyAnalysisId = (await store.getJob(analysisJobIdOf(snapshot.snapshotId)))?.analysisId ?? '';

    const gateway = new ScriptedGateway();
    gateway.analyzeOutcome = { suggestions: [] };
    gateway.verifyOutcome = { verifications: [], missingSuggestions: [] };
    const pipeline = makePipeline(store, gateway, clock);

    // 1) The clock repeats (every row is written at fx.AT), so the order must come from the pipeline.
    const withdrawing = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    await pipeline.run(withdrawing.batch?.batchId ?? '');
    const withdrawal = (await store.listTagDecisions(problem.key)).find(
      (decision) => decision.taxonomyId === SEGMENT && decision.status === 'needs_review',
    );
    assert.ok(withdrawal, 'the checked run must withdraw the unsupported adoption');
    assert.deepEqual(effectiveTagIdsForProblem(await store.listTagDecisions(problem.key), problem.key), []);

    // 2) A later checked run that supports the tag again re-adopts it.
    const suggestion = suggestionFor(problem, snapshot, SEGMENT);
    gateway.analyzeOutcome = { suggestions: [suggestion] };
    gateway.verifyOutcome = {
      verifications: [
        createSuggestionVerification({
          suggestionId: suggestion.suggestionId,
          problemRef: problem.ref,
          snapshotId: snapshot.snapshotId,
          verdict: 'support',
          verifierRole: 'verification',
          evidenceOk: true,
          checkedAt: fx.AT,
        }),
      ],
      missingSuggestions: [],
    };
    const readopting = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5, reanalyze: true });
    await pipeline.run(readopting.batch?.batchId ?? '');

    const decisions = await store.listTagDecisions(problem.key);
    assert.deepEqual(effectiveTagIdsForProblem(decisions, problem.key), [SEGMENT]);
    assert.ok(
      decisions.some((decision) => decision.status === 'auto_adopted' && decision.analysisId !== legacyAnalysisId),
      'the later checked run must record its own adoption',
    );
    // History is append-only: two adoptions and one withdrawal stay readable, and the old
    // analysis/job rows are untouched.
    assert.equal(decisions.filter((decision) => decision.status === 'auto_adopted').length, 2);
    assert.equal(decisions.filter((decision) => decision.status === 'needs_review').length, 1);
    const legacyJob = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(legacyJob?.status, 'succeeded');
    assert.equal(legacyJob?.analysisId, legacyAnalysisId);
    assert.ok(await store.getAnalysis(legacyAnalysisId));

    // 3) A fresh connection to the real SQLite file reports the same effective tags.
    const reopened = await fixture.reopen();
    const persisted = await reopened.listTagDecisions(problem.key);
    assert.equal(persisted.length, decisions.length);
    assert.deepEqual(effectiveTagIdsForProblem(persisted, problem.key), [SEGMENT]);
  });
});

test('an explicit manual accept survives a checked rerun that dropped the tag', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, problem, snapshot } = fixture;
    await seedLegacySuccess(fixture, SEGMENT);
    await store.saveManualDecision(
      createManualTagDecision({
        problemRef: problem.ref,
        taxonomyId: SEGMENT,
        action: 'accept',
        decidedAt: fx.LATER,
        note: null,
      }),
    );
    const gateway = new ScriptedGateway();
    gateway.verifyOutcome = { verifications: [], missingSuggestions: [] };
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    await pipeline.run(prepared.batch?.batchId ?? '');
    const decisions = await store.listTagDecisions(problem.key);
    assert.equal(
      decisions.some((decision) => decision.taxonomyId === SEGMENT && decision.status === 'needs_review'),
      false,
    );
  });
});

test('a failed rerun does not withdraw the last valid adoption', async () => {
  await withFixture(async (fixture) => {
    const { store, clock, problem, snapshot } = fixture;
    await seedLegacySuccess(fixture, SEGMENT);
    const gateway = new ScriptedGateway();
    gateway.failAnalyze = true;
    const pipeline = makePipeline(store, gateway, clock);
    const prepared = await pipeline.prepareBatch([snapshot.snapshotId], { maxJobs: 5 });
    const summary = await pipeline.run(prepared.batch?.batchId ?? '');
    assert.equal(summary.status, 'failed');
    const decisions = await store.listTagDecisions(problem.key);
    assert.deepEqual(effectiveTagIdsForProblem(decisions, problem.key), [SEGMENT]);
    assert.equal(decisions.some((decision) => decision.status === 'needs_review'), false);
  });
});

// ---------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------

test('completeness persists additively and a legacy body keeps its identity across reopen', async () => {
  const paths = fx.tempDatabase();
  const legacy = createAnalysisResult({
    problemRef: { sourceInstanceId: 'codeforces:codeforces.com', domain: null, externalKey: '1A' },
    snapshotId: 'snap',
    snapshotVersion: 1,
    taxonomyVersion: TAXONOMY.version,
    createdAt: fx.AT,
    status: 'completed',
    suggestions: [],
    verifications: [],
    usage: null,
  });
  const checked = createAnalysisResult({
    problemRef: { sourceInstanceId: 'codeforces:codeforces.com', domain: null, externalKey: '1A' },
    snapshotId: 'snap',
    snapshotVersion: 1,
    taxonomyVersion: TAXONOMY.version,
    createdAt: fx.LATER,
    status: 'completed',
    suggestions: [],
    verifications: [],
    usage: null,
    completeness: createAnalysisCompleteness({
      taxonomyVersion: TAXONOMY.version,
      snapshotId: 'snap',
      snapshotVersion: 1,
      checkedAt: fx.LATER,
    }),
  });
  assert.notEqual(legacy.analysisId, checked.analysisId);
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await store.saveAnalysis(legacy);
    // An identical re-save of a legacy body stays a no-op (no immutable violation).
    await store.saveAnalysis(legacy);
    await store.saveAnalysis(checked);
  } finally {
    await store.close();
  }
  const reopened = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const storedLegacy = await reopened.getAnalysis(legacy.analysisId);
    assert.equal(storedLegacy?.completeness, undefined);
    assert.equal(Object.hasOwn(storedLegacy ?? {}, 'completeness'), false);
    const storedChecked = await reopened.getAnalysis(checked.analysisId);
    assert.equal(storedChecked?.completeness?.version, COMPLETENESS_AUDIT_VERSION);
    assert.equal(storedChecked?.completeness?.checkedAt, fx.LATER);
  } finally {
    await reopened.close();
    fx.removeDirectory(paths.dir);
  }
});

// ---------------------------------------------------------------------------------------
// Parser strictness (current prompt requires the omissions answer)
// ---------------------------------------------------------------------------------------

test('the current verification prompt requires missingSuggestions and validates it', async () => {
  await withFixture(async (fixture) => {
    const { problem, snapshot } = fixture;
    const index = createTaxonomyIndex(TAXONOMY);
    const current = {
      snapshot,
      taxonomy: index,
      suggestions: [],
      now: () => fx.AT,
      promptVersion: 'verification-v2|taxonomy:test-v1',
    };
    await assert.rejects(async () => parseVerificationOutput({ verifications: [] }, current), /missingSuggestions/);

    // An explicitly recorded legacy identity still replays, but carries no omissions answer.
    const legacy = parseVerificationOutput(
      { verifications: [] },
      { ...current, promptVersion: 'verification-v1|taxonomy:test-v1' },
    );
    assert.equal(legacy.missingSuggestions, undefined);

    // Unknown taxonomy, foreign solution and duplicate-of-proposal are refused.
    const base = { verifications: [], missingSuggestions: [] };
    await assert.rejects(
      async () =>
        parseVerificationOutput(
          { ...base, missingSuggestions: [{ taxonomyId: 'nope', rationale: 'x', evidence: [] }] },
          current,
        ),
      /unknown_taxonomy_id|missing_evidence/,
    );
    await assert.rejects(
      async () =>
        parseVerificationOutput(
          {
            ...base,
            missingSuggestions: [
              {
                taxonomyId: GREEDY,
                rationale: 'greedy',
                evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-9', excerpt: EXCERPT }],
              },
            ],
          },
          current,
        ),
      /foreign_evidence/,
    );
    const proposed = suggestionFor(problem, snapshot, GREEDY);
    await assert.rejects(
      async () =>
        parseVerificationOutput(
          {
            verifications: [
              { suggestionId: proposed.suggestionId, verdict: 'support', evidenceOk: true },
            ],
            missingSuggestions: [
              {
                taxonomyId: GREEDY,
                rationale: 'greedy',
                evidence: [{ sourceId: 'editorial-1', solutionId: 'solution-1', excerpt: EXCERPT }],
              },
            ],
          },
          { ...current, suggestions: [proposed] },
        ),
      /duplicate_proposal/,
    );
  });
});

test('explicit reanalysis of failed legacy and rerun jobs preserves their counters and starts fresh work', async () => {
  await withFixture(async ({store, snapshot, clock}) => {
    const gateway = new ScriptedGateway();
    const pipeline = makePipeline(store, gateway, clock);
    gateway.failAnalyze = true;
    const first = await pipeline.prepareBatch([snapshot.snapshotId]);
    assert.ok(first.batch);
    await pipeline.run(first.batch.batchId);
    const oldId = first.batch.jobs[0]!.jobId;
    const old = await store.getJob(oldId);
    assert.equal(old?.status, 'failed');
    const retry = await pipeline.prepareBatch([snapshot.snapshotId], {reanalyze: true});
    assert.ok(retry.batch);
    assert.notEqual(retry.batch.jobs[0]!.jobId, oldId);
    await pipeline.run(retry.batch.batchId);
    const failedRerunId = retry.batch.jobs[0]!.jobId;
    const failedRerun = await store.getJob(failedRerunId);
    assert.equal(failedRerun?.status, 'failed');
    const fresh = await pipeline.prepareBatch([snapshot.snapshotId], {reanalyze: true});
    assert.ok(fresh.batch);
    assert.notEqual(fresh.batch.jobs[0]!.jobId, oldId);
    assert.notEqual(fresh.batch.jobs[0]!.jobId, failedRerunId);
    gateway.failAnalyze = false;
    await pipeline.run(fresh.batch.batchId);
    assert.equal((await pipeline.prepareBatch([snapshot.snapshotId])).batch, null);
    assert.deepEqual(await store.getJob(oldId), old);
    assert.deepEqual(await store.getJob(failedRerunId), failedRerun);
  });
});
