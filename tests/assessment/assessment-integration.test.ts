/**
 * Real-chain ability-assessment integration (Stage 18f).
 *
 * Every case in this file drives the **production chain** rather than scripted ports:
 * the real {@link AssessmentService}, the real `WorkbenchService.captureAssessmentInput` over a real
 * temporary `SqliteTrainingStore`, and the real `GuidanceMethodRegistry` holding the installed
 * balanced companion method. Only the two boundaries that would leave the process are faked — the
 * `AssessmentGenerator` (one model call) and the clock — so the assertions cover behaviour that
 * scripted capture ports cannot: which SQLite transactions are actually opened, what a real
 * recapture hashes, and what really survives closing and reopening the store.
 *
 * Externally meaningful properties proven here:
 *
 * - a valid report (anchored and no-anchor) commits through the real capture: the reservation and
 *   the settlement re-proof *join* the service's own transaction and never open a nested one;
 * - real evidence movement before the run is refused before any cost, and a change that lands after
 *   the outer check is caught inside the reservation transaction, which rolls back with it;
 * - a mutation during the paid call keeps the provider's usage while the report is discarded;
 * - a provider that ignores the cancellation token still cannot turn a cancelled call into a report,
 *   and its usage stays recorded;
 * - `close()` waits for an admitted preparation/run, and the run it interrupts never dispatches the
 *   late paid call;
 * - settings/method staleness and a stored report (with its citations and its charged quota slot)
 *   survive an unload/reload of the store.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { GuidanceMethodRegistry } from '../../src/adapters/guidance/index.js';
import { WorkbenchService } from '../../src/application/workbench-service.js';
import { AssessmentService, AssessmentServiceError, type AssessmentAttemptView } from '../../src/application/assessment-service.js';
import type {
  AssessmentGenerationOutcome,
  AssessmentGenerationRequest,
  AssessmentGenerator,
} from '../../src/application/assessment-generation.js';
import type { AssessmentCaptureRequest, AssessmentDataPort } from '../../src/application/assessment-capture.js';
import { ASSESSMENT_ATTEMPT_CHARGED_STATUSES } from '../../src/application/assessment-types.js';
import { defaultWorkbenchSettings, validateWorkbenchSettings, type WorkbenchSettings } from '../../src/application/workbench-settings.js';
import type { ModelCallResult } from '../../src/application/ports.js';
import {
  CURRENT_TAXONOMY,
  createCancellationSource,
  createTaxonomyIndex,
  validateOfficialRating,
  type CancellationToken,
  type ModelUsage,
} from '../../src/domain/index.js';
import * as balanced from '../../packages/dsh-icpc-method-balanced/index.js';
import { AT, USAGE, makeReport, officialRatingSnapshot } from '../assessment-fixtures.js';
import * as fx from '../storage/fixtures.js';

/** The installed companion method this file registers and captures for real. */
const METHOD = String(balanced.balancedMethod.methodId);
const TAXONOMY = createTaxonomyIndex(CURRENT_TAXONOMY);
/** A token nobody cancels: the ordinary caller of most cases. */
const TOKEN = createCancellationSource().token;

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AssessmentServiceError && error.code === code;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  assert.fail(`timed out waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One successful model answer built from the *captured* evidence of the request.
 *
 * A real generator may only cite references the capture published, so this helper selects its
 * citations from `request.evidence` and drops the numeric estimate exactly when the capture carries
 * no anchor. That keeps the fixture honest for both the anchored and the no-anchor chain.
 */
function okFor(request: AssessmentGenerationRequest, usage: ModelUsage = USAGE): ModelCallResult<AssessmentGenerationOutcome> {
  const refs = new Set(request.evidence.evidence.map((entry) => entry.evidenceRef));
  const pick = (...candidates: readonly string[]): string[] => candidates.filter((ref) => refs.has(ref));
  const anchored = request.evidence.anchor.kind !== 'none';
  const report = makeReport({
    confidenceEvidenceRefs: pick('ev-official-rating', 'ev-virtual-ledger', 'ev-coverage'),
    thinking: {
      assessment: '建模与不变量推导的证据集中在一个难度分带，独立完成程度还需要更多样本。',
      evidenceRefs: pick('ev-self-assessment', 'ev-practice-all_time', 'ev-coverage'),
      uncertainties: [],
    },
    templates: {
      assessment: '模板与实现证据来自已通过的平台标签和知识分带统计。',
      evidenceRefs: pick('ev-knowledge-summary', 'ev-coverage'),
      uncertainties: [],
    },
    ...(anchored ? {} : { estimatedRange: null, priority: 'diagnostic' }),
  });
  assert.ok((report['confidenceEvidenceRefs'] as readonly unknown[]).length > 0, 'the fixture report must cite captured evidence');
  return { ok: true, value: { report } as unknown as AssessmentGenerationOutcome, usage, callId: 'call-1', sessionId: 'session-1' };
}

/**
 * The production chain over one temporary database: real store, real workbench capture, real
 * registry, real service; only the generator and the clock are injected.
 *
 * `captureCalls` records the transaction mode of every delegated capture, which is how the tests
 * prove the paid path *joins* the service transaction instead of opening a nested one (the store
 * rejects a nested `transaction()` outright).
 */
class RealChain {
  readonly paths = fx.tempDatabase();
  readonly scope: fx.Scope;
  readonly captureCalls: { readonly mode: 'own' | 'join' }[] = [];
  readonly generatorCalls: AssessmentGenerationRequest[] = [];
  clock: string;
  store!: SqliteTrainingStore;
  registry!: GuidanceMethodRegistry;
  workbench!: WorkbenchService;
  service!: AssessmentService;
  handler: (request: AssessmentGenerationRequest) => Promise<ModelCallResult<AssessmentGenerationOutcome>> = (request) =>
    Promise.resolve(okFor(request));
  private unregister!: () => void;
  private hook: { readonly mode: 'own' | 'join'; readonly run: () => Promise<void> } | null = null;
  private minted = 0;

  constructor(options: { readonly startClock?: string } = {}) {
    this.scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
    this.clock = options.startClock ?? AT;
    this.open();
  }

  /** Build one live chain over the current database path; used at construction and after reload. */
  private open(): void {
    const now = (): string => this.clock;
    this.store = new SqliteTrainingStore({ path: this.paths.path, now });
    this.registry = new GuidanceMethodRegistry();
    this.unregister = this.registry.register(balanced.balancedMethod);
    this.workbench = new WorkbenchService({
      store: this.store,
      taxonomy: TAXONOMY,
      now,
      uniqueId: () => `chain-${(this.minted += 1)}`,
      guidance: this.registry,
    });
    const capture: AssessmentDataPort = {
      captureAssessmentInput: (request, token, mode = 'own') => this.capture(request, token, mode),
    };
    const generator: AssessmentGenerator = {
      generate: (request) => {
        this.generatorCalls.push(request);
        return this.handler(request);
      },
    };
    this.service = new AssessmentService({ store: this.store, capture, generator, now });
  }

  /** Seed one account with real evidence and the approved Flash settings. */
  async seed(options: { readonly officialRating?: boolean; readonly maxCallsPer24Hours?: number } = {}): Promise<void> {
    await this.store.upsertSourceInstances([this.scope.instance]);
    await this.store.upsertAccounts([this.scope.account]);
    await this.store.upsertProblems([this.scope.problem]);
    await this.store.upsertSubmissions([
      fx.makeSubmission(this.scope.account, this.scope.problem.ref, 'sub-1', 'accepted', fx.AT),
    ]);
    if (options.officialRating === true) {
      await this.store.saveOfficialRating(
        validateOfficialRating({ ...officialRatingSnapshot(), accountId: this.scope.account.id }),
        0,
      );
    }
    await this.store.saveWorkbenchSettings(this.settings(options.maxCallsPer24Hours ?? 10), null);
  }

  settings(maxCallsPer24Hours: number): WorkbenchSettings {
    const defaults = defaultWorkbenchSettings();
    return validateWorkbenchSettings({ ...defaults, coaching: { ...defaults.coaching, maxCallsPer24Hours } });
  }

  /** Uninstall the companion method: the real catalogue stops publishing it. */
  uninstallMethod(): void {
    this.unregister();
  }

  /** Run `run` immediately before the next delegated capture of `mode` (one shot). */
  hookNextCapture(mode: 'own' | 'join', run: () => Promise<void>): void {
    this.hook = { mode, run };
  }

  private async capture(request: AssessmentCaptureRequest, token: CancellationToken, mode: 'own' | 'join') {
    this.captureCalls.push({ mode });
    const hook = this.hook;
    if (hook !== null && hook.mode === mode) {
      this.hook = null;
      await hook.run();
    }
    return this.workbench.captureAssessmentInput(request, token, mode);
  }

  accountId(): string {
    return this.scope.account.id;
  }

  async statusOf(requestId: string): Promise<AssessmentAttemptView | null> {
    return this.service.status({ requestId, accountId: this.accountId() }, TOKEN);
  }

  async charged(): Promise<number> {
    return this.store.countAssessmentAttempts({ statuses: ASSESSMENT_ATTEMPT_CHARGED_STATUSES });
  }

  async waitForTerminal(requestId: string): Promise<AssessmentAttemptView> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const view = await this.statusOf(requestId);
      if (view !== null && (view.status === 'settled' || view.status === 'uncertain' || view.status === 'cancelled')) {
        return view;
      }
      await sleep(2);
    }
    assert.fail(`assessment ${requestId} did not reach a terminal status`);
  }

  /** Close the service, close storage and re-open both over the same file: one plugin unload. */
  async reload(): Promise<void> {
    await this.service.close();
    await this.store.close();
    this.unregister();
    this.open();
  }

  async dispose(): Promise<void> {
    await this.service.close();
    await this.store.close();
    this.unregister();
    fx.removeDirectory(this.paths.dir);
  }
}

async function withChain(
  options: { readonly officialRating?: boolean; readonly maxCallsPer24Hours?: number },
  run: (chain: RealChain) => Promise<void>,
): Promise<void> {
  const chain = new RealChain();
  await chain.seed(options);
  try {
    await run(chain);
  } finally {
    await chain.dispose();
  }
}

// ---------------------------------------------------------------------------------------
// Report commitment through the real capture and real transactions
// ---------------------------------------------------------------------------------------

test('a valid anchored report commits through real capture and SQLite, joining the reservation transactions', async () => {
  await withChain({ officialRating: true }, async (chain) => {
    const requestId = 'req-real-anchored';
    const prepared = await chain.service.prepare(
      { requestId, accountId: chain.accountId(), methodIds: [METHOD] },
      TOKEN,
    );
    assert.equal(prepared.status, 'prepared');
    assert.deepEqual(prepared.methodIds, [METHOD]);
    assert.equal(prepared.provider, 'deepseek-official');
    assert.equal(prepared.model, 'deepseek-flash');
    assert.equal(chain.generatorCalls.length, 0, 'preparing is free');
    assert.equal(prepared.attempt.preparation.capture.prompt.anchor.kind, 'official_rating');
    const prompt = JSON.stringify(prepared.attempt.preparation.capture.prompt);
    assert.equal(prompt.includes(chain.accountId()), false, 'the model payload never carries the account');
    assert.equal(prompt.includes('alice'), false, 'the model payload never carries the handle');
    assert.equal(prompt.includes(chain.scope.problem.statement ?? '\u0000'), false, 'private material stays out of the prompt');
    // The frozen method text is the real registered companion method, not a substituted default.
    assert.equal(prepared.attempt.preparation.capture.snapshot.guidance.methods[0]?.methodId, METHOD);

    const started = await chain.service.run({ requestId, accountId: chain.accountId() }, TOKEN);
    assert.equal(started.started, true);
    assert.equal(started.attempt.status, 'reserved');
    const settled = await chain.waitForTerminal(requestId);
    assert.equal(settled.status, 'settled');
    assert.equal(settled.report?.source, 'ai_inferred');
    assert.equal(settled.report?.anchor, 'official_rating');
    assert.deepEqual(settled.usage, USAGE);
    assert.equal(settled.error, null);
    assert.equal(settled.settlementFailure, null);
    assert.equal(chain.generatorCalls.length, 1);

    const stored = await chain.store.getAssessmentAttempt(requestId);
    assert.ok(stored !== null, 'the settled row is durable');
    assert.ok(stored.report !== null, 'the report really was written');
    assert.equal(stored.report.evidenceHash, prepared.attempt.preparation.capture.evidenceHash);
    assert.equal(stored.hostCallId, 'call-1');
    assert.equal(stored.hostSessionId, 'session-1');
    const capturedRefs = new Set(
      stored.preparation.capture.prompt.evidence.map((entry) => entry.evidenceRef),
    );
    for (const ref of stored.report.report.confidenceEvidenceRefs) {
      assert.ok(capturedRefs.has(ref), `stored citation ${ref} belongs to the frozen capture`);
    }

    // prepare capture / outer run check / reservation re-proof / settlement re-proof. The last two
    // join the service's transaction: a nested `transaction()` would have been rejected by SQLite.
    assert.deepEqual(chain.captureCalls.map((call) => call.mode), ['own', 'own', 'join', 'join']);
    assert.equal(await chain.charged(), 1);
  });
});

test('a no-anchor account commits an honest diagnostic report instead of a masked settlement failure', async () => {
  await withChain({ officialRating: false }, async (chain) => {
    const requestId = 'req-real-bare';
    const prepared = await chain.service.prepare(
      { requestId, accountId: chain.accountId(), methodIds: [METHOD] },
      TOKEN,
    );
    assert.equal(prepared.attempt.preparation.capture.prompt.anchor.kind, 'none');
    assert.equal(prepared.attempt.preparation.capture.prompt.anchor.evidenceRef, null);

    await chain.service.run({ requestId, accountId: chain.accountId() }, TOKEN);
    const settled = await chain.waitForTerminal(requestId);
    // A settlement-capture nested transaction would be caught by `reportBasisProblem` and turned
    // into a sanitized `provider_error` with no report; this asserts the real chain commits instead.
    assert.equal(settled.status, 'settled');
    assert.ok(settled.report !== null, 'a valid no-anchor answer must be stored as a report');
    assert.equal(settled.report.anchor, 'none');
    assert.equal(settled.report.report.estimatedRange, null, 'no anchor means no numeric estimate');
    assert.equal(settled.report.report.priority, 'diagnostic');
    assert.equal(settled.error, null);
    assert.deepEqual(settled.usage, USAGE);
    assert.deepEqual(chain.captureCalls.map((call) => call.mode), ['own', 'own', 'join', 'join']);
  });
});

// ---------------------------------------------------------------------------------------
// Real evidence movement
// ---------------------------------------------------------------------------------------

test('a real source change between prepare and run is refused before any cost', async () => {
  await withChain({ officialRating: true }, async (chain) => {
    const requestId = 'req-real-stale';
    await chain.service.prepare({ requestId, accountId: chain.accountId(), methodIds: [METHOD] }, TOKEN);

    const extra = fx.makeProblem(fx.makeRef(chain.scope.instance, '2B'));
    await chain.store.upsertProblems([extra]);
    await chain.store.upsertSubmissions([
      fx.makeSubmission(chain.scope.account, extra.ref, 'sub-2', 'accepted', fx.AT),
    ]);

    await assert.rejects(chain.service.run({ requestId, accountId: chain.accountId() }, TOKEN), hasCode('stale'));
    assert.equal(chain.generatorCalls.length, 0, 'a stale preparation never reaches the paid boundary');
    assert.equal(chain.captureCalls.some((call) => call.mode === 'join'), false, 'the refusal happens before the reservation transaction');
    const still = await chain.statusOf(requestId);
    assert.equal(still?.status, 'prepared', 'the free preparation survives a refused run');
    assert.equal(await chain.charged(), 0);
  });
});

test('a change landing after the outer check is caught inside the reservation transaction and rolls back with it', async () => {
  await withChain({ officialRating: true }, async (chain) => {
    const requestId = 'req-real-window';
    await chain.service.prepare({ requestId, accountId: chain.accountId(), methodIds: [METHOD] }, TOKEN);

    // The mutation runs inside the reservation transaction's own scope: it joins that transaction
    // and is only visible to the re-proof capture, which is exactly the tiny interval under test.
    chain.hookNextCapture('join', async () => {
      await chain.store.upsertProblems([
        fx.makeProblem(chain.scope.problem.ref, { title: 'mutated inside the reservation transaction' }),
      ]);
    });
    await assert.rejects(chain.service.run({ requestId, accountId: chain.accountId() }, TOKEN), hasCode('stale'));

    assert.equal(chain.generatorCalls.length, 0);
    assert.deepEqual(chain.captureCalls.map((call) => call.mode), ['own', 'own', 'join']);
    // Both the mutation and the reservation were rolled back together: the store is as prepared.
    assert.equal((await chain.store.getProblem(chain.scope.problem.key))?.title, chain.scope.problem.title);
    assert.equal((await chain.statusOf(requestId))?.status, 'prepared');
    assert.equal(await chain.charged(), 0);
  });
});

test('a source mutation during the paid call keeps the reported usage but discards the report', async () => {
  await withChain({ officialRating: true }, async (chain) => {
    const requestId = 'req-real-inflight';
    await chain.service.prepare({ requestId, accountId: chain.accountId(), methodIds: [METHOD] }, TOKEN);
    const changed = 'mutated while the paid call was in flight';
    chain.handler = async (request) => {
      await chain.store.upsertProblems([fx.makeProblem(chain.scope.problem.ref, { title: changed })]);
      return okFor(request);
    };

    await chain.service.run({ requestId, accountId: chain.accountId() }, TOKEN);
    const settled = await chain.waitForTerminal(requestId);
    assert.equal(settled.status, 'settled');
    assert.equal(settled.report, null, 'an answer about moved evidence is never stored as a report');
    assert.equal(settled.error?.code, 'provider_error');
    assert.equal(settled.error === null ? true : 'message' in settled.error, false, 'the view carries no provider message');
    assert.deepEqual(settled.usage, USAGE, 'the provider really charged for this call');
    assert.equal((await chain.store.getProblem(chain.scope.problem.key))?.title, changed);
    assert.deepEqual(chain.captureCalls.map((call) => call.mode), ['own', 'own', 'join', 'join']);
    assert.equal(await chain.charged(), 1);
  });
});

// ---------------------------------------------------------------------------------------
// Cancellation and shutdown
// ---------------------------------------------------------------------------------------

test('a provider that ignores the cancellation token still cannot turn the cancelled call into a report', async () => {
  await withChain({ officialRating: true }, async (chain) => {
    const requestId = 'req-real-cancel';
    await chain.service.prepare({ requestId, accountId: chain.accountId(), methodIds: [METHOD] }, TOKEN);
    const gate = deferred();
    // Deliberately ignores `request.token`: the paid call answers successfully after cancellation.
    chain.handler = async (request) => {
      await gate.promise;
      return okFor(request);
    };

    const started = await chain.service.run({ requestId, accountId: chain.accountId() }, TOKEN);
    assert.equal(started.started, true);
    assert.equal(started.attempt.status, 'reserved');
    const cancelled = await chain.service.cancel({ requestId, accountId: chain.accountId() }, TOKEN);
    assert.equal(cancelled.status, 'reserved', 'a charged attempt is only signalled, never released for free');
    gate.resolve();

    const settled = await chain.waitForTerminal(requestId);
    assert.equal(settled.status, 'settled');
    assert.equal(settled.report, null);
    assert.equal(settled.error?.code, 'cancelled');
    assert.deepEqual(settled.usage, USAGE, 'the late answer still keeps the usage it reported');
    assert.equal(await chain.charged(), 1);
  });
});

test('close during a pending preparation waits for it and admits no later paid call', async () => {
  const chain = new RealChain();
  await chain.seed({ officialRating: true });
  try {
    const requestId = 'req-close-prepare';
    const gate = deferred();
    chain.hookNextCapture('own', () => gate.promise);
    const preparing = chain.service.prepare({ requestId, accountId: chain.accountId(), methodIds: [METHOD] }, TOKEN);
    await waitUntil(() => chain.captureCalls.length === 1, 'the preparation to reach its capture');

    const order: string[] = [];
    void preparing.then(() => order.push('prepared'));
    const closed = chain.service.close();
    void closed.then(() => order.push('closed'));
    gate.resolve();

    const prepared = await preparing;
    assert.equal(prepared.status, 'prepared');
    const report = await closed;
    assert.deepEqual(report.failures, []);
    assert.deepEqual(order, ['prepared', 'closed'], 'close waits for the admitted preparation');
    assert.equal(chain.generatorCalls.length, 0);

    // The durable row survived, but the service is closed: no late paid call can be admitted.
    assert.equal((await chain.statusOf(requestId))?.status, 'prepared', 'reads still work after close');
    await assert.rejects(chain.service.run({ requestId, accountId: chain.accountId() }, TOKEN), hasCode('closing'));
    assert.equal(chain.generatorCalls.length, 0);
    assert.equal(await chain.charged(), 0);
  } finally {
    await chain.dispose();
  }
});

test('close during a pending run prevents the late paid call and drains the admitted work', async () => {
  const chain = new RealChain();
  await chain.seed({ officialRating: true });
  try {
    const requestId = 'req-close-run';
    await chain.service.prepare({ requestId, accountId: chain.accountId(), methodIds: [METHOD] }, TOKEN);
    const gate = deferred();
    chain.hookNextCapture('own', () => gate.promise);
    const running = chain.service.run({ requestId, accountId: chain.accountId() }, TOKEN);
    await waitUntil(() => chain.captureCalls.length === 2, 'the run to reach its outer capture');

    const closed = chain.service.close();
    gate.resolve();
    await assert.rejects(running, hasCode('closing'));

    const report = await closed;
    assert.deepEqual(report.failures, []);
    assert.equal(chain.generatorCalls.length, 0, 'no paid call was dispatched after close');
    assert.equal((await chain.statusOf(requestId))?.status, 'prepared');
    assert.equal(await chain.charged(), 0);
  } finally {
    await chain.dispose();
  }
});

// ---------------------------------------------------------------------------------------
// Staleness and durability
// ---------------------------------------------------------------------------------------

test('settings and method staleness are refused before cost against the real capture', async () => {
  await withChain({ officialRating: true }, async (chain) => {
    const accountId = chain.accountId();
    await chain.service.prepare({ requestId: 'req-stale-settings', accountId, methodIds: [METHOD] }, TOKEN);
    await chain.store.saveWorkbenchSettings(chain.settings(5), 1);
    await assert.rejects(chain.service.run({ requestId: 'req-stale-settings', accountId }, TOKEN), hasCode('settings'));

    await chain.service.prepare({ requestId: 'req-stale-method', accountId, methodIds: [METHOD] }, TOKEN);
    chain.uninstallMethod();
    await assert.rejects(chain.service.run({ requestId: 'req-stale-method', accountId }, TOKEN), hasCode('stale'));

    assert.equal(chain.generatorCalls.length, 0);
    assert.equal(chain.captureCalls.some((call) => call.mode === 'join'), false, 'both refusals happen before the reservation transaction');
    assert.equal(await chain.charged(), 0);
    assert.equal((await chain.statusOf('req-stale-settings'))?.status, 'prepared');
    assert.equal((await chain.statusOf('req-stale-method'))?.status, 'prepared');
  });
});

test('a settled report, its citations and its charged slot survive unloading and reloading the store', async () => {
  const chain = new RealChain();
  try {
    await chain.seed({ officialRating: true, maxCallsPer24Hours: 1 });
    const accountId = chain.accountId();
    const requestId = 'req-durable';
    await chain.service.prepare({ requestId, accountId, methodIds: [METHOD] }, TOKEN);
    await chain.service.run({ requestId, accountId }, TOKEN);
    const settled = await chain.waitForTerminal(requestId);
    assert.ok(settled.report !== null);
    const evidenceHash = settled.report.evidenceHash;
    const callsBeforeReload = chain.generatorCalls.length;

    await chain.reload();
    assert.equal(chain.generatorCalls.length, callsBeforeReload, 'reloading dispatches nothing');

    const stored = await chain.store.getAssessmentAttempt(requestId);
    assert.ok(stored !== null, 'the settled row survived the unload');
    assert.ok(stored.report !== null, 'the report survived the unload');
    assert.equal(stored.status, 'settled');
    assert.equal(stored.report.evidenceHash, evidenceHash);

    const page = await chain.service.history({ accountId, limit: 10 }, TOKEN);
    assert.deepEqual(page.items.map((item) => item.requestId), [requestId]);
    const item = page.items[0];
    assert.ok(item !== undefined);
    assert.ok(item.report !== null);
    const capturedRefs = new Set(stored.preparation.capture.prompt.evidence.map((entry) => entry.evidenceRef));
    assert.ok(item.report.report.confidenceEvidenceRefs.length > 0, 'the citations are stored, not stripped');
    for (const ref of item.report.report.confidenceEvidenceRefs) {
      assert.ok(capturedRefs.has(ref), `reloaded citation ${ref} is still part of the frozen capture`);
    }
    for (const ref of item.report.report.thinking.evidenceRefs) {
      assert.ok(capturedRefs.has(ref));
    }

    // Quota is durable too: the charged slot survived, so a second paid call is still refused.
    await chain.service.prepare({ requestId: 'req-after-reload', accountId, methodIds: [METHOD] }, TOKEN);
    await assert.rejects(chain.service.run({ requestId: 'req-after-reload', accountId }, TOKEN), hasCode('quota'));
    assert.equal(chain.generatorCalls.length, callsBeforeReload);

    // A settled attempt is replayed after the reload, never dispatched a second time.
    const replay = await chain.service.run({ requestId, accountId }, TOKEN);
    assert.equal(replay.started, false);
    assert.equal(replay.attempt.status, 'settled');
    assert.equal(chain.generatorCalls.length, callsBeforeReload);
  } finally {
    await chain.dispose();
  }
});
