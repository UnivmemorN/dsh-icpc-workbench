/**
 * Storage behaviour through the public `TrainingStore` surface.
 *
 * Each case states a consequence the product depends on: which records survive a restart,
 * which identities stay separate, which write is refused, which revision the pipeline will
 * later capture. Databases live in per-test temp directories and are removed afterwards.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { StorageError } from '../../src/adapters/sqlite/errors.js';
import { syncCheckpointKey, type SyncCheckpoint } from '../../src/application/storage-types.js';
import {
  DomainError,
  transitionJob,
  type AnalysisJobLimits,
  type AnalysisJobState,
  type AnalysisResult,
  type ProblemSnapshot,
  type Retrospective,
  type TagDecision,
} from '../../src/domain/index.js';
import * as fx from './fixtures.js';

const LIMITS: AnalysisJobLimits = {
  maxAnalysisCalls: 50,
  maxReasoningCalls: 5,
  maxAttempts: 2,
  leaseMs: 120_000,
};

type Paths = { readonly path: string; readonly dir: string };

async function withStore(run: (store: SqliteTrainingStore, paths: Paths) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await run(store, paths);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

void test('every record type survives close and reopen', async () => {
  const paths = fx.tempDatabase();
  const scope = fx.makeScope('hydro', 'hydro.example.edu', 'alice', 'P100');
  const submission = fx.makeSubmission(scope.account, scope.problem.ref, 'S1', 'accepted');
  const snapshot = fx.makeSnapshot(scope.problem);
  const analysis = fx.makeAnalysis(scope.problem, snapshot);
  const job = fx.makeJob(scope.problem, snapshot);
  const tagDecision = fx.makeTagDecision(scope.problem, {
    analysisId: analysis.analysisId,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
  });
  const manualDecision = fx.makeManualDecision(scope.problem, fx.GREEDY_TAG, 'reject', fx.AT, 'not greedy');
  const retrospective = fx.makeRetrospective(scope.problem, scope.account.id, { note: 'solved alone' });
  const plan = fx.makePlan(scope.account.id, scope.problem);
  const checkpoint: SyncCheckpoint = {
    sourceInstanceId: scope.instance.id,
    accountId: scope.account.id,
    resource: 'submissions',
    cursor: 'page-2',
    since: fx.AT,
    updatedAt: fx.AT,
  };
  const problemQuery = { limit: 10, cursor: null } as const;

  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  await store.upsertSourceInstances([scope.instance]);
  await store.upsertAccounts([scope.account]);
  await store.upsertProblems([scope.problem]);
  await store.upsertSubmissions([submission]);
  await store.saveSnapshot(snapshot);
  await store.saveAnalysis(analysis);
  await store.saveJob(job);
  await store.saveTagDecisions([tagDecision]);
  await store.saveManualDecision(manualDecision);
  await store.saveRetrospective(retrospective);
  await store.savePlan(plan);
  await store.saveSyncCheckpoint(checkpoint);

  assert.deepEqual(store.capabilities(), {
    implemented: true,
    schemaVersion: 1,
    transactional: true,
    notes: store.capabilities().notes,
  });
  await store.close();

  const reopened = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    assert.deepEqual(await reopened.getSourceInstance(scope.instance.id), scope.instance);
    assert.deepEqual(await reopened.getAccount(scope.account.id), scope.account);
    assert.deepEqual((await reopened.listSourceInstances()).length, 1);
    assert.deepEqual(await reopened.listAccounts(scope.instance.id), [scope.account]);
    assert.deepEqual((await reopened.listProblems(problemQuery)).items, [scope.problem]);
    assert.equal((await reopened.listSubmissions(scope.account.id, problemQuery)).items[0]?.id, submission.id);
    assert.deepEqual(await reopened.getSnapshot(snapshot.snapshotId), snapshot);
    assert.deepEqual(await reopened.getCurrentSnapshotHead(scope.problem.ref), {
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      version: snapshot.version,
    });
    assert.deepEqual(await reopened.getAnalysis(analysis.analysisId), analysis);
    assert.deepEqual(await reopened.listAnalyses(scope.problem.key), [analysis]);
    assert.deepEqual(await reopened.getJob(job.jobId), job);
    assert.deepEqual(await reopened.listJobs('pending'), [job]);
    assert.deepEqual(await reopened.listTagDecisions(scope.problem.key), [tagDecision]);
    assert.deepEqual(await reopened.listManualDecisions(scope.problem.key), [manualDecision]);
    assert.equal(await reopened.getManualRevision(scope.problem.key), 1);
    assert.deepEqual(await reopened.listRetrospectives(scope.account.id), [retrospective]);
    assert.deepEqual(await reopened.getPlan(plan.planId), plan);
    assert.deepEqual(await reopened.listPlans(scope.account.id), [plan]);
    assert.deepEqual(await reopened.getSyncCheckpoint(checkpoint), checkpoint);
    assert.equal(await reopened.getSyncCheckpoint({ ...checkpoint, resource: 'problems' }), null);
  } finally {
    await reopened.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('a closed store refuses reads and writes instead of reporting empty results', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  await store.upsertProblems([scope.problem]);
  await store.close();
  await store.close();
  await assert.rejects(store.listProblems({ limit: 10, cursor: null }), (error) => {
    return error instanceof StorageError && error.code === 'closed';
  });
  await assert.rejects(store.upsertProblems([scope.problem]), (error) => {
    return error instanceof StorageError && error.code === 'closed';
  });
  fx.removeDirectory(paths.dir);
});

void test('instance, domain and account scopes never collapse', async () => {
  await withStore(async (store) => {
    const first = fx.makeScope('hydro', 'hydro.example.edu', 'alice', 'P1');
    const second = fx.makeScope('hydro', 'hydro2.example.edu', 'alice', 'P1');
    const sameInstanceOtherDomain = fx.makeProblem(fx.makeRef(first.instance, 'P1', 'training'));
    const bob = fx.makeAccount(first.instance, 'bob');

    await store.upsertProblems([first.problem, second.problem, sameInstanceOtherDomain]);
    assert.equal(new Set([first.problem.key, second.problem.key, sameInstanceOtherDomain.key]).size, 3);

    const aliceSubmission = fx.makeSubmission(first.account, first.problem.ref, 'S1', 'accepted');
    const bobSubmission = fx.makeSubmission(bob, first.problem.ref, 'S1', 'wrong_answer');
    const remoteSubmission = fx.makeSubmission(second.account, second.problem.ref, 'S1', 'accepted');
    assert.notEqual(aliceSubmission.id, bobSubmission.id);
    assert.notEqual(aliceSubmission.id, remoteSubmission.id);
    await store.upsertSubmissions([aliceSubmission, bobSubmission, remoteSubmission]);

    const all = await store.listProblems({ limit: 10, cursor: null });
    assert.equal(all.items.length, 3);
    const aliceScope = await store.listProblems({ accountId: first.account.id, limit: 10, cursor: null });
    assert.deepEqual(
      aliceScope.items.map((problem) => problem.key),
      [first.problem.key],
    );
    const bobScope = await store.listProblems({ accountId: bob.id, limit: 10, cursor: null });
    assert.deepEqual(
      bobScope.items.map((problem) => problem.key),
      [first.problem.key],
    );
    const remoteScope = await store.listProblems({ accountId: second.account.id, limit: 10, cursor: null });
    assert.deepEqual(
      remoteScope.items.map((problem) => problem.key),
      [second.problem.key],
    );
    const instanceScope = await store.listProblems({
      sourceInstanceId: first.instance.id,
      limit: 10,
      cursor: null,
    });
    assert.equal(instanceScope.items.length, 2);
    assert.deepEqual(
      (await store.listSubmissions(first.account.id, { limit: 10, cursor: null })).items.map((item) => item.id),
      [aliceSubmission.id],
    );
  });
});

void test('repeated imports, checkpoints and identical snapshot saves are idempotent', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const submission = fx.makeSubmission(scope.account, scope.problem.ref, '1000', 'wrong_answer');
    const snapshot = fx.makeSnapshot(scope.problem);

    await store.upsertProblems([scope.problem]);
    await store.upsertProblems([scope.problem]);
    await store.upsertSubmissions([submission]);
    await store.upsertSubmissions([submission]);
    await store.saveSnapshot(snapshot);
    await store.saveSnapshot(snapshot);
    // Same content-addressed id, later observation timestamps: still the same snapshot.
    await store.saveSnapshot({ ...snapshot, capturedAt: fx.LATER, problem: { ...scope.problem, fetchedAt: fx.LATER } });

    assert.equal((await store.listProblems({ limit: 50, cursor: null })).items.length, 1);
    assert.equal((await store.listSubmissions(scope.account.id, { limit: 50, cursor: null })).items.length, 1);
    const stored = await store.getSnapshot(snapshot.snapshotId);
    assert.equal(stored?.capturedAt, fx.AT);
    assert.equal(stored?.problem.fetchedAt, fx.AT);
    assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.snapshotId, snapshot.snapshotId);

    const ref = { sourceInstanceId: scope.instance.id, accountId: scope.account.id, resource: 'problems' } as const;
    const first = { ...ref, cursor: 'cursor-1', since: null, updatedAt: fx.AT };
    const second = { ...ref, cursor: 'cursor-2', since: fx.LATER, updatedAt: fx.LATER };
    await store.saveSyncCheckpoint(first);
    await store.saveSyncCheckpoint(first);
    assert.deepEqual(await store.getSyncCheckpoint(ref), first);
    await store.saveSyncCheckpoint(second);
    assert.deepEqual(await store.getSyncCheckpoint(ref), second);
    assert.equal(syncCheckpointKey(ref).includes(scope.account.id), false, 'account ids are escaped in checkpoint keys');

    // A newer title is a legitimate metadata update, not a duplicate row.
    const renamed = fx.makeProblem(scope.problem.ref, { title: 'Problem A (renamed)' });
    await store.upsertProblems([renamed]);
    assert.equal((await store.listProblems({ limit: 50, cursor: null })).items[0]?.title, 'Problem A (renamed)');
  });
});

void test('saveSnapshot never rolls the head backward and keeps newer data', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const version1 = fx.makeSnapshot(scope.problem);
    const changed = fx.makeProblem(scope.problem.ref, { statement: 'Now also supports range assignment.' });
    const version2 = fx.makeSnapshot(changed, { previous: version1, capturedAt: fx.LATER });
    const changedAgain = fx.makeProblem(scope.problem.ref, { statement: 'Now also supports range minimum.' });
    const version3 = fx.makeSnapshot(changedAgain, { previous: version2, capturedAt: fx.LATER });
    assert.deepEqual([version1.version, version2.version, version3.version], [1, 2, 3]);

    await store.saveSnapshot(version1);
    await store.saveSnapshot(version3);
    // Unchanged/current saves are no-ops and must not touch the newer head.
    await store.saveSnapshot(version3);
    await store.saveSnapshot(version1);

    assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.snapshotId, version3.snapshotId);
    assert.equal((await store.getSnapshot(version3.snapshotId))?.problem.statement, changedAgain.statement);

    // version2 was never stored: writing it now would move the head backward.
    await assert.rejects(store.saveSnapshot(version2), (error) => {
      return error instanceof DomainError && error.code === 'invalid_transition';
    });
    assert.equal(await store.getSnapshot(version2.snapshotId), null);
    assert.equal((await store.getCurrentSnapshotHead(scope.problem.ref))?.snapshotId, version3.snapshotId);
    assert.equal((await store.getSnapshot(version3.snapshotId))?.contentHash, version3.contentHash);
    assert.equal((await store.getSnapshot(version1.snapshotId))?.version, 1);
  });
});

void test('an immutable id with a different body is rejected, not overwritten', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('luogu', 'luogu.com.cn', 'alice', 'P1001');
    const snapshot = fx.makeSnapshot(scope.problem);
    const analysis = fx.makeAnalysis(scope.problem, snapshot);
    const tagDecision = fx.makeTagDecision(scope.problem);
    const retrospective = fx.makeRetrospective(scope.problem, scope.account.id, { note: 'first note' });

    await store.saveSnapshot(snapshot);
    await store.saveAnalysis(analysis);
    await store.saveTagDecisions([tagDecision]);
    await store.saveRetrospective(retrospective);
    // Identical re-saves are no-ops.
    await store.saveSnapshot(snapshot);
    await store.saveAnalysis(analysis);
    await store.saveTagDecisions([tagDecision]);
    await store.saveRetrospective(retrospective);

    const tamperedSnapshot: ProblemSnapshot = {
      ...snapshot,
      problem: { ...snapshot.problem, statement: 'tampered statement' },
    };
    await assert.rejects(store.saveSnapshot(tamperedSnapshot), (error) => {
      return error instanceof DomainError && error.code === 'immutable_violation';
    });
    const storedSnapshot = await store.getSnapshot(snapshot.snapshotId);
    assert.equal(storedSnapshot?.problem.statement, scope.problem.statement);

    const suggestion = analysis.suggestions[0];
    assert.ok(suggestion);
    const tamperedAnalysis: AnalysisResult = {
      ...analysis,
      suggestions: [{ ...suggestion, rationale: 'rewritten rationale' }],
    };
    await assert.rejects(store.saveAnalysis(tamperedAnalysis), (error) => {
      return error instanceof DomainError && error.code === 'immutable_violation';
    });
    assert.equal((await store.getAnalysis(analysis.analysisId))?.suggestions[0]?.rationale, suggestion.rationale);

    const tamperedDecision: TagDecision = { ...tagDecision, status: 'rejected' };
    await assert.rejects(store.saveTagDecisions([tamperedDecision]), (error) => {
      return error instanceof DomainError && error.code === 'immutable_violation';
    });
    assert.equal((await store.listTagDecisions(scope.problem.key))[0]?.status, tagDecision.status);

    const tamperedRetrospective: Retrospective = { ...retrospective, note: 'rewritten note' };
    await assert.rejects(store.saveRetrospective(tamperedRetrospective), (error) => {
      return error instanceof DomainError && error.code === 'immutable_violation';
    });
    assert.equal((await store.listRetrospectives(scope.account.id))[0]?.note, 'first note');
  });
});

void test('manual decisions stay independent from AI decisions and advance a revision', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    const analysis = fx.makeAnalysis(scope.problem, snapshot);
    const aiDecision = fx.makeTagDecision(scope.problem, {
      analysisId: analysis.analysisId,
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.version,
    });
    await store.saveSnapshot(snapshot);
    await store.saveAnalysis(analysis);

    await store.saveTagDecisions([aiDecision]);
    assert.equal(await store.getManualRevision(scope.problem.key), 0, 'AI decisions do not move the manual revision');

    const reject = fx.makeManualDecision(scope.problem, fx.SEGMENT_TREE_TAG, 'reject', fx.AT, 'too easy');
    const accept = fx.makeManualDecision(scope.problem, fx.GREEDY_TAG, 'accept', fx.LATER, 'used greedy');
    await store.saveManualDecision(reject);
    assert.equal(await store.getManualRevision(scope.problem.key), 1);
    await store.saveManualDecision(reject);
    assert.equal(await store.getManualRevision(scope.problem.key), 1, 'a repeated save is not a new decision');
    await store.saveManualDecision(accept);
    assert.equal(await store.getManualRevision(scope.problem.key), 2);

    assert.deepEqual(await store.listManualDecisions(scope.problem.key), [reject, accept]);
    assert.deepEqual(await store.listTagDecisions(scope.problem.key), [aiDecision]);
    assert.deepEqual(await store.getAnalysis(analysis.analysisId), analysis);
    assert.equal(await store.getManualRevision(fx.makeScope('codeforces', 'codeforces.com', 'bob', '1B').problem.key), 0);
  });
});

void test('pagination is bounded, deterministic and account-scoped', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('hydro', 'hydro.example.edu', 'alice', 'P1');
    const bob = fx.makeAccount(scope.instance, 'bob');
    const problems = [1, 2, 3, 4, 5, 6].map((index) =>
      fx.makeProblem(fx.makeRef(scope.instance, `P${index}`)),
    );
    await store.upsertProblems(problems);
    const aliceProblems = problems.slice(0, 3);
    const bobProblems = problems.slice(3);
    await store.upsertSubmissions(
      aliceProblems.map((problem, index) =>
        fx.makeSubmission(scope.account, problem.ref, `A${index}`, 'accepted'),
      ),
    );
    await store.upsertSubmissions(
      bobProblems.map((problem, index) => fx.makeSubmission(bob, problem.ref, `B${index}`, 'wrong_answer')),
    );

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await store.listProblems({ accountId: scope.account.id, limit: 2, cursor });
      assert.ok(page.items.length <= 2);
      collected.push(...page.items.map((problem) => problem.key));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages <= 5, 'pagination must terminate');
    } while (cursor !== null);
    assert.equal(collected.length, 3);
    assert.equal(new Set(collected).size, 3);
    assert.deepEqual(collected, [...collected].sort());
    assert.equal(pages, 2);

    const submissionIds: string[] = [];
    let submissionCursor: string | null = null;
    do {
      const page = await store.listSubmissions(scope.account.id, { limit: 2, cursor: submissionCursor });
      submissionIds.push(...page.items.map((item) => item.id));
      submissionCursor = page.nextCursor;
    } while (submissionCursor !== null);
    assert.deepEqual(submissionIds, [...submissionIds].sort());
    assert.equal(submissionIds.length, 3);

    assert.equal((await store.listProblems({ limit: 500, cursor: null })).items.length, 6);
    await assert.rejects(store.listProblems({ limit: 0, cursor: null }), (error) => {
      return error instanceof DomainError && error.code === 'invalid_input';
    });
    await assert.rejects(store.listProblems({ limit: 501, cursor: null }), (error) => {
      return error instanceof DomainError && error.code === 'invalid_input';
    });
    await assert.rejects(store.listProblems({ limit: 10, cursor: 'not-a-cursor' }), (error) => {
      return error instanceof DomainError && error.code === 'invalid_input';
    });
    await assert.rejects(
      store.listSubmissions(scope.account.id, { limit: 10, cursor: 'problem:AAAA' }),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );
  });
});

void test('job leases are claimed atomically and counters survive recovery', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    const job = fx.makeJob(scope.problem, snapshot);
    await store.saveJob(job);

    const claimed = await store.claimJob({ jobId: job.jobId, owner: 'worker-a', at: fx.AT, leaseMs: 60_000 });
    assert.ok(claimed);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.leaseOwner, 'worker-a');
    assert.equal(claimed.leaseExpiresAt, new Date(Date.parse(fx.AT) + 60_000).toISOString());
    assert.equal(
      await store.claimJob({ jobId: job.jobId, owner: 'worker-b', at: fx.AT, leaseMs: 60_000 }),
      null,
      'a live lease cannot be stolen',
    );

    const consumed = transitionJob(claimed, {
      type: 'consume_call',
      kind: 'analysis',
      at: fx.LATER,
      limits: LIMITS,
    });
    await store.saveJob(consumed);

    const reclaimed = await store.claimJob({ jobId: job.jobId, owner: 'worker-b', at: fx.EXPIRED, leaseMs: 60_000 });
    assert.ok(reclaimed);
    assert.equal(reclaimed.attempts, 2);
    assert.equal(reclaimed.counters.analysisCalls, 1, 'a reclaim keeps the spent budget');

    assert.equal(await store.recoverExpiredJobs(new Date(Date.parse(fx.EXPIRED) + 60_000).toISOString()), 1);
    const recovered = await store.getJob(job.jobId);
    assert.ok(recovered);
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.leaseOwner, null);
    assert.equal(recovered.counters.analysisCalls, 1);

    const regressed: AnalysisJobState = { ...recovered, counters: { analysisCalls: 0, reasoningCalls: 0, retries: 0 } };
    await assert.rejects(store.saveJob(regressed), (error) => {
      return error instanceof DomainError && error.code === 'invalid_transition';
    });
    assert.equal((await store.getJob(job.jobId))?.counters.analysisCalls, 1);

    const otherProblem = fx.makeProblem(fx.makeRef(scope.instance, 'P2'));
    const otherSnapshot = fx.makeSnapshot(otherProblem);
    const pausedJob = fx.makeJob(otherProblem, otherSnapshot);
    await store.saveJob(transitionJob(pausedJob, { type: 'pause_for_quota', at: fx.AT, reason: 'analysis budget' }));
    assert.equal(
      await store.claimJob({ jobId: pausedJob.jobId, owner: 'worker-a', at: fx.EXPIRED, leaseMs: 1000 }),
      null,
      'a quota-paused job waits for an explicit resume',
    );
    assert.equal(await store.recoverExpiredJobs(fx.EXPIRED), 0);
  });
});

void test('re-saving a job under a different identity is rejected and keeps its counters', async () => {
  await withStore(async (store) => {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    const job = fx.makeJob(scope.problem, snapshot);
    await store.saveJob(job);

    const claimed = await store.claimJob({ jobId: job.jobId, owner: 'worker-a', at: fx.AT, leaseMs: 60_000 });
    assert.ok(claimed);
    const consumed = transitionJob(claimed, { type: 'consume_call', kind: 'analysis', at: fx.LATER, limits: LIMITS });
    await store.saveJob(consumed);

    const otherProblem = fx.makeProblem(fx.makeRef(scope.instance, 'P2'));
    const otherSnapshot = fx.makeSnapshot(otherProblem);

    // Same job id, different identity: the job must not be silently repointed at another
    // problem/snapshot, or have its creation time rewritten, because the stored body would
    // then disagree with the identity columns the pipeline reads.
    const repointed: AnalysisJobState = {
      ...consumed,
      problemKey: otherProblem.key,
      snapshotId: otherSnapshot.snapshotId,
    };
    await assert.rejects(store.saveJob(repointed), (error) => {
      return error instanceof DomainError && error.code === 'immutable_violation';
    });
    await assert.rejects(store.saveJob({ ...consumed, createdAt: fx.LATER }), (error) => {
      return error instanceof DomainError && error.code === 'immutable_violation';
    });

    const stored = await store.getJob(job.jobId);
    assert.ok(stored);
    assert.equal(stored.problemKey, job.problemKey);
    assert.equal(stored.snapshotId, job.snapshotId);
    assert.equal(stored.createdAt, job.createdAt);
    assert.equal(stored.counters.analysisCalls, 1, 'the accepted counter is kept, not reset');

    // The original identity still works, and claim/recover remain standalone operations.
    assert.equal(await store.recoverExpiredJobs(fx.EXPIRED), 1);
    assert.equal((await store.getJob(job.jobId))?.status, 'pending');
  });
});

void test('stored bodies that are not JSON objects are refused as corrupt rows', async () => {
  await withStore(async (store, paths) => {
    const raw = new DatabaseSync(paths.path);
    try {
      const insert = raw.prepare(
        `INSERT INTO problems (key, source_instance_id, domain, external_key, title, fetched_at, body)
         VALUES (?, 'instance-a', NULL, ?, 'corrupt', ?, ?)`,
      );
      const remove = raw.prepare('DELETE FROM problems WHERE key = ?');
      const bodies: readonly (readonly [string, string])[] = [
        ['null', 'null'],
        ['array', '[]'],
        ['string', '"a bare string"'],
        ['number', '42'],
        ['boolean', 'false'],
      ];
      for (const [label, body] of bodies) {
        const key = `corrupt-${label}`;
        insert.run(key, key, fx.AT, body);
        await assert.rejects(
          store.listProblems({ limit: 10, cursor: null }),
          (error) => {
            assert.ok(error instanceof StorageError, `expected a storage error for stored body ${body}`);
            return error.code === 'corrupt_row';
          },
        );
        remove.run(key);
      }
      assert.equal((await store.listProblems({ limit: 10, cursor: null })).items.length, 0);
    } finally {
      raw.close();
    }
  });
});
