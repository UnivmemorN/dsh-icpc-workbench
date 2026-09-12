/**
 * Unknown-cost settlement regression, against the real SQLite store.
 *
 * A dispatch whose failure reports `usage: null` must stay on the books as `uncertain` with its
 * host call/session correlation intact, must not be adopted, and must not be retried — spending
 * another call for a cost that was never accounted for. Only the model gateway is faked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { AnalysisPipeline } from '../../src/application/analysis-pipeline.js';
import { DEFAULT_MODEL_LIMITS } from '../../src/application/ports.js';
import type {
  AnalyzeOutcome,
  AnalyzeRequest,
  ModelCallResult,
  ModelCapabilities,
  ModelGateway,
  ReasonOutcome,
  ReasonRequest,
  VerifyOutcome,
  VerifyRequest,
} from '../../src/application/ports.js';
import { analysisJobIdOf, createTaxonomy, type Taxonomy } from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const TAXONOMY: Taxonomy = createTaxonomy({
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
      id: 'data-structure.segment-tree',
      parentId: 'data-structure',
      kind: 'technique',
      names: { en: 'Segment tree', zh: '线段树' },
      aliases: ['segment tree'],
      description: 'range queries',
    },
  ],
});

/** Reports a retryable provider failure with unknown cost, exactly once. */
class UnknownCostGateway implements ModelGateway {
  readonly analyzeRequests: AnalyzeRequest[] = [];

  capabilities(): ModelCapabilities {
    return {
      provider: 'fake-provider',
      implemented: true,
      roles: ['analysis', 'verification', 'reasoning'],
      maxConcurrency: 4,
      notes: [],
    };
  }

  async analyze(request: AnalyzeRequest): Promise<ModelCallResult<AnalyzeOutcome>> {
    this.analyzeRequests.push(request);
    return {
      ok: false,
      error: { code: 'provider_error', message: 'connection reset before usage was reported', retryable: true },
      usage: null,
      callId: 'host-call-9',
      sessionId: 'host-session-9',
    };
  }

  async verify(_request: VerifyRequest): Promise<ModelCallResult<VerifyOutcome>> {
    throw new Error('an uncertain analysis call must not proceed to verification');
  }

  async reason(_request: ReasonRequest): Promise<ModelCallResult<ReasonOutcome>> {
    throw new Error('an uncertain analysis call must not proceed to reasoning');
  }
}

/** Reports a typed quota stop with unknown cost, exactly once. */
class QuotaStopGateway implements ModelGateway {
  readonly analyzeRequests: AnalyzeRequest[] = [];

  capabilities(): ModelCapabilities {
    return {
      provider: 'fake-provider',
      implemented: true,
      roles: ['analysis', 'verification', 'reasoning'],
      maxConcurrency: 4,
      notes: [],
    };
  }

  async analyze(request: AnalyzeRequest): Promise<ModelCallResult<AnalyzeOutcome>> {
    this.analyzeRequests.push(request);
    return {
      ok: false,
      error: { code: 'quota_exhausted', message: 'the model provider quota is exhausted', retryable: false },
      usage: null,
      callId: 'host-call-quota',
      sessionId: 'host-session-quota',
    };
  }

  async verify(_request: VerifyRequest): Promise<ModelCallResult<VerifyOutcome>> {
    throw new Error('a quota-stopped analysis call must not proceed to verification');
  }

  async reason(_request: ReasonRequest): Promise<ModelCallResult<ReasonOutcome>> {
    throw new Error('a quota-stopped analysis call must not proceed to reasoning');
  }
}

void test('an unknown-cost failure stays uncertain with correlation and is never retried', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertProblems([scope.problem]);
    await store.saveSnapshot(snapshot);

    const gateway = new UnknownCostGateway();
    let sequence = 0;
    const pipeline = new AnalysisPipeline({
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
      now: () => fx.AT,
      uniqueId: (prefix) => {
        sequence += 1;
        return `${prefix}-${sequence}`;
      },
    });

    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);

    // No hidden retry: one dispatch, one counted analysis call, no retry registered.
    assert.equal(gateway.analyzeRequests.length, 1);
    assert.equal(summary.counters.analysisCalls, 1);
    assert.equal(summary.counters.retries, 0);
    assert.equal(summary.uncertainAttempts, 1);
    assert.equal(summary.jobs[0]?.status, 'failed');

    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 1);
    const attempt = attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.status, 'uncertain');
    assert.equal(attempt.usage, null);
    assert.equal(attempt.outcome, null);
    assert.equal(attempt.error?.code, 'provider_error');
    assert.equal(attempt.hostCallId, 'host-call-9');
    assert.equal(attempt.hostSessionId, 'host-session-9');
    assert.equal(attempt.role, 'analysis');
    assert.equal(attempt.snapshotId, snapshot.snapshotId);
    assert.equal(gateway.analyzeRequests[0]?.attemptId, attempt.attemptId);

    // No adoption: neither an analysis result nor an automatic tag decision may exist.
    assert.deepEqual(await store.listAnalyses(scope.problem.key), []);
    assert.deepEqual(await store.listTagDecisions(scope.problem.key), []);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'failed');
    assert.equal(job?.analysisId, null);
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('a typed quota stop pauses the real batch, is never retried and keeps uncertain ids', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const scope = fx.makeScope('codeforces', 'codeforces.com', 'tourist', '1A');
    const snapshot = fx.makeSnapshot(scope.problem);
    await store.upsertSourceInstances([scope.instance]);
    await store.upsertProblems([scope.problem]);
    await store.saveSnapshot(snapshot);

    const gateway = new QuotaStopGateway();
    let sequence = 0;
    const pipeline = new AnalysisPipeline({
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
      now: () => fx.AT,
      uniqueId: (prefix) => {
        sequence += 1;
        return `${prefix}-${sequence}`;
      },
    });

    const prepared = await pipeline.prepareBatch([snapshot.snapshotId]);
    const batch = prepared.batch;
    assert.ok(batch);

    const summary = await pipeline.run(batch.batchId);

    // A provider quota stop pauses the batch instead of retrying or failing it.
    assert.equal(gateway.analyzeRequests.length, 1);
    assert.equal(summary.counters.analysisCalls, 1);
    assert.equal(summary.counters.retries, 0);
    assert.equal(summary.pausedForQuota, true);
    assert.equal(summary.status, 'paused');
    assert.equal(summary.jobs[0]?.status, 'paused_quota');
    assert.equal(summary.uncertainAttempts, 1);

    // The paid call was dispatched once and stays visible: uncertain cost, correlation intact.
    const attempts = await store.listModelCallAttempts({ batchId: batch.batchId });
    assert.equal(attempts.length, 1);
    const attempt = attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.status, 'uncertain');
    assert.equal(attempt.usage, null);
    assert.equal(attempt.error?.code, 'quota_exhausted');
    assert.equal(attempt.hostCallId, 'host-call-quota');
    assert.equal(attempt.hostSessionId, 'host-session-quota');
    assert.equal(attempt.role, 'analysis');
    assert.equal(attempt.snapshotId, snapshot.snapshotId);
    assert.equal(gateway.analyzeRequests[0]?.attemptId, attempt.attemptId);

    // No adoption: neither an analysis result nor an automatic tag decision may exist.
    assert.deepEqual(await store.listAnalyses(scope.problem.key), []);
    assert.deepEqual(await store.listTagDecisions(scope.problem.key), []);
    const job = await store.getJob(analysisJobIdOf(snapshot.snapshotId));
    assert.equal(job?.status, 'paused_quota');
    assert.equal(job?.analysisId, null);
    assert.equal((await store.getBatch(batch.batchId))?.status, 'paused');
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});
