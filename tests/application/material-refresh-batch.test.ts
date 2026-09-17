/**
 * Durable bulk platform-material refresh batches (Sprint Contract 34A): pure records, orchestration
 * and disposal.
 *
 * Every case here is offline and deterministic. The store is a synthetic in-process double that
 * enforces the same compare-and-set and transition rules as the SQLite adapter (the real one is
 * covered by `tests/storage/material-refresh-batch.test.ts`), and the platform path is a scripted
 * gateway recording exactly what the batch layer asked the accepted single-problem refresh service
 * to do. Nothing reaches a socket, a model or a credential.
 *
 * What the cases pin down:
 *
 * - the pure rules: a closed 1..100 record, ordered items, honest transitions and immutable
 *   completed items;
 * - report classification: `found` and `absent` are both completed observations, while every
 *   operational failure is retryable attention and is never rewritten as an absence;
 * - orchestration: one refresh call per attempt, ordered progress, partial failure with later
 *   progress, global concurrency of one, account ownership proven before the request with no
 *   anonymous fallback, cancellation that reaches the live token and keeps completed siblings,
 *   retry-failed that never repeats a completed item, and restart recovery that performs no request;
 * - disposal: one shared close deadline and truthful durable state without an unhandled rejection;
 * - surface: the aggregate and its projections carry no model, secret or material body.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImportService } from '../../src/application/import-service.js';
import type {
  RefreshMaterialReport,
  RefreshMaterialRequest,
  StatementRefreshStatus,
} from '../../src/application/import-types.js';
import { MaterialRefreshBatchService } from '../../src/application/material-refresh-batch-service.js';
import * as batchServiceModule from '../../src/application/material-refresh-batch-service.js';
import {
  MAX_MATERIAL_REFRESH_BATCH_ITEMS,
  beginMaterialRefreshItem,
  cancelMaterialRefreshBatch,
  classifyMaterialRefreshReport,
  completeMaterialRefreshItem,
  createMaterialRefreshBatch,
  failMaterialRefreshItem,
  fromPlatformError,
  interruptMaterialRefreshBatch,
  materialRefreshBatchSummaryView,
  materialRefreshBatchView,
  retryFailedMaterialRefreshBatch,
  settleMaterialRefreshBatchRun,
  startMaterialRefreshBatch,
  validateMaterialRefreshBatch,
  validateMaterialRefreshBatchTransition,
  type MaterialRefreshBatch,
  type MaterialRefreshBatchItemInput,
  type MaterialRefreshBatchStatus,
  type MaterialRefreshItemResult,
} from '../../src/application/material-refresh-batch-types.js';
import * as batchTypesModule from '../../src/application/material-refresh-batch-types.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import type { EditorialFetchResult, PlatformAdapter, PlatformLimits, TrainingStore } from '../../src/application/ports.js';
import {
  DomainError,
  accountIdOf,
  canonicalJson,
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  problemKey,
  type Account,
  type CancellationToken,
  type NormalizedProblem,
  type ProblemRef,
  type SourceInstance,
} from '../../src/domain/index.js';
import * as fx from '../storage/fixtures.js';

const AT = '2026-10-01T08:00:00.000Z';
const LATER = '2026-10-01T08:05:00.000Z';
const CONTENT_HASH = 'b'.repeat(64);
const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 1000,
  maxRetries: 0,
  pageSize: 100,
  maxConcurrency: 1,
};

const SECRET_BODY = 'SECRET-MATERIAL-BODY-SENTINEL';
const SECRET_URL = 'https://codeforces.com/blog/entry/1?token=SECRET-URL-SENTINEL';
const SECRET_DETAIL = 'SECRET-PROVIDER-DETAIL-SENTINEL';
/** A handle that must never appear in a public answer; an account id encodes it verbatim. */
const SECRET_HANDLE = 'SENTINELHANDLE42';

function isDomain(code: DomainError['code']): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

function token(): CancellationToken {
  return createCancellationSource().token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => Promise<T | null>, label: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await sleep(5);
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------------------
// Records, reports and scripted doubles
// ---------------------------------------------------------------------------------------

function itemInput(problemKeyValue: string, extra: Partial<MaterialRefreshBatchItemInput> = {}): MaterialRefreshBatchItemInput {
  return { problemKey: problemKeyValue, ...extra };
}

function batchOf(
  items: readonly MaterialRefreshBatchItemInput[],
  createdAt: string = AT,
  batchId = 'batch-1',
): MaterialRefreshBatch {
  return createMaterialRefreshBatch({ batchId, items, createdAt });
}

function resultOf(editorial: 'found' | 'absent', changed = true): MaterialRefreshItemResult {
  return {
    statement: 'not_requested',
    editorial,
    mirror: 'skipped',
    sourceCount: editorial === 'found' ? 1 : 0,
    solutionCount: editorial === 'found' ? 1 : 0,
    snapshot: {
      snapshotId: `snapshot-${editorial}-${changed ? 'changed' : 'reused'}`,
      version: 1,
      contentHash: CONTENT_HASH,
      changed,
    },
  };
}

function foundResult(id: string, url: string, text: string): EditorialFetchResult {
  const source = createEditorialSource({
    id,
    kind: 'editorial',
    url,
    title: `Editorial ${id}`,
    availability: 'found',
    retrievedAt: AT,
    text,
  });
  const solution = createEditorialSolution({
    solutionId: `${id}-s0`,
    sourceId: id,
    ordinal: 0,
    title: 'Main idea',
    text,
  });
  return { status: 'found', sources: [source], solutions: [solution], retrievedAt: AT };
}

interface ReportOptions {
  readonly problem?: NormalizedProblem | null;
  readonly statement?: StatementRefreshStatus;
  readonly statementError?: PlatformError | null;
  readonly changed?: boolean;
  readonly version?: number;
}

let snapshotSequence = 0;

function materialReport(
  ref: ProblemRef,
  editorial: EditorialFetchResult,
  options: ReportOptions = {},
): RefreshMaterialReport {
  const key = problemKey(ref);
  const problem = options.problem === undefined ? fx.makeProblem(ref) : options.problem;
  const statement = options.statement ?? 'not_requested';
  snapshotSequence += 1;
  return {
    problemKey: key,
    problem,
    statement: {
      status: statement,
      fetchedProblem: statement === 'fetched' ? problem : null,
      error: statement === 'failed' ? (options.statementError ?? new PlatformError({ code: 'forbidden', operation: 'problem', detail: 'blocked' })) : null,
    },
    editorial: { attempted: true, result: editorial, error: null, skippedReason: null },
    mirror: { status: 'skipped', skippedReason: 'mirror_not_applicable', key: null },
    material: null,
    snapshot: {
      problemKey: key,
      snapshotId: `snapshot-${snapshotSequence}`,
      version: options.version ?? 1,
      contentHash: CONTENT_HASH,
      capturedAt: AT,
      changed: options.changed ?? true,
    },
  };
}

type ScriptedAnswer =
  | { readonly kind: 'report'; readonly report: RefreshMaterialReport }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'gate'; readonly gate: Promise<void>; readonly report: RefreshMaterialReport }
  /**
   * A committed snapshot whose *report return* is still held: the answer ignores cancellation, exactly
   * the window in which a cancel used to reinterpret a finished platform read as cancelled.
   */
  | { readonly kind: 'heldReport'; readonly gate: Promise<void>; readonly report: RefreshMaterialReport }
  /** A non-cooperative read: it ignores cancellation entirely and answers whenever its gate opens. */
  | { readonly kind: 'stubborn'; readonly gate: Promise<void>; readonly report: RefreshMaterialReport };

interface RefreshCallRecord {
  readonly problemKey: string;
  readonly fetchStatement: boolean;
  readonly accountId: string | null;
  readonly hasAccountKey: boolean;
  readonly officialTutorialUrl: string | null;
  readonly token: CancellationToken;
}

/** Scripted single-problem refresh path: records every call, answers in order, tracks concurrency. */
class ScriptedRefreshGateway {
  readonly calls: RefreshCallRecord[] = [];
  private readonly answers = new Map<string, ScriptedAnswer[]>();
  active = 0;
  peak = 0;

  script(key: string, ...answers: readonly ScriptedAnswer[]): void {
    const queue = this.answers.get(key) ?? [];
    queue.push(...answers);
    this.answers.set(key, queue);
  }

  async refreshMaterial(_adapter: PlatformAdapter, request: RefreshMaterialRequest): Promise<RefreshMaterialReport> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    const record: RefreshCallRecord = {
      problemKey: problemKey(request.problemRef),
      fetchStatement: request.fetchStatement,
      accountId: request.account?.id ?? null,
      hasAccountKey: Object.prototype.hasOwnProperty.call(request, 'account'),
      officialTutorialUrl: request.officialTutorialUrl ?? null,
      token: request.token,
    };
    this.calls.push(record);
    try {
      const answer = this.answers.get(record.problemKey)?.shift();
      if (answer === undefined) {
        throw new Error(`no scripted refresh answer for ${record.problemKey}`);
      }
      if (answer.kind === 'error') {
        throw answer.error;
      }
      if (answer.kind === 'gate') {
        await answer.gate;
        request.token.throwIfCancelled();
      }
      if (answer.kind === 'heldReport' || answer.kind === 'stubborn') {
        // Deliberately no cancellation check: `heldReport` models a committed snapshot whose report
        // return is still held, and `stubborn` models an adapter that ignores cancellation entirely.
        await answer.gate;
      }
      return answer.report;
    } finally {
      this.active -= 1;
    }
  }

  callsFor(key: string): number {
    return this.calls.filter((call) => call.problemKey === key).length;
  }
}

/** Synthetic store enforcing the same revision CAS and transition rules as the SQLite adapter. */
class FakeBatchStore {
  readonly batches = new Map<string, MaterialRefreshBatch>();
  readonly accounts = new Map<string, Account>();
  readonly problems = new Map<string, NormalizedProblem>();
  readonly saves: number[] = [];
  /** Set by a test to prove that a detached late run never touches a store that was already closed. */
  closed = false;
  /** Every access a closed store refused, so a test can assert the list stayed empty. */
  readonly callsAfterClose: string[] = [];
  /** Optional hook consulted while a save is in flight, so a test can hold a durable CAS open. */
  onSave: ((batch: MaterialRefreshBatch) => Promise<void> | void) | null = null;

  private assertOpen(label: string): void {
    if (this.closed) {
      this.callsAfterClose.push(label);
      throw new Error(`the synthetic store was used after it was closed (${label})`);
    }
  }

  async getAccount(id: string): Promise<Account | null> {
    this.assertOpen('getAccount');
    return this.accounts.get(id) ?? null;
  }

  async getProblem(key: string): Promise<NormalizedProblem | null> {
    this.assertOpen('getProblem');
    return this.problems.get(key) ?? null;
  }

  async getMaterialRefreshBatch(batchId: string): Promise<MaterialRefreshBatch | null> {
    this.assertOpen('getMaterialRefreshBatch');
    return this.batches.get(batchId) ?? null;
  }

  async listMaterialRefreshBatches(status: MaterialRefreshBatchStatus | null): Promise<readonly MaterialRefreshBatch[]> {
    this.assertOpen('listMaterialRefreshBatches');
    return [...this.batches.values()]
      .filter((batch) => status === null || batch.status === status)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.batchId.localeCompare(right.batchId)
          : left.createdAt.localeCompare(right.createdAt),
      );
  }

  async saveMaterialRefreshBatch(batch: MaterialRefreshBatch, expectedRevision: number | null): Promise<number> {
    this.assertOpen('saveMaterialRefreshBatch');
    if (this.onSave !== null) {
      await this.onSave(batch);
    }
    const stored = this.batches.get(batch.batchId);
    if (stored === undefined) {
      assert.equal(expectedRevision, null, 'a create must pass expectedRevision null');
      this.batches.set(batch.batchId, { ...batch, revision: 1 });
      this.saves.push(1);
      return 1;
    }
    assert.notEqual(expectedRevision, null, 'an update must name the revision it read');
    assert.equal(expectedRevision, stored.revision, `stale revision for ${batch.batchId}`);
    validateMaterialRefreshBatchTransition(stored, batch);
    const revision = stored.revision + 1;
    this.batches.set(batch.batchId, { ...batch, revision });
    this.saves.push(revision);
    return revision;
  }
}

function syntheticAdapter(instance: SourceInstance): PlatformAdapter {
  return {
    sourceInstance: instance,
    capabilities: () => ({
      platform: instance.platform,
      implemented: true,
      problems: true,
      submissions: true,
      editorial: true,
      pagedProblems: true,
      pagedSubmissions: true,
      requiresAuth: false,
      supportsAccountHistory: true,
      minRequestIntervalMs: null,
      notes: [],
    }),
    listProblems: async () => ({ items: [], nextCursor: null, fetchedAt: AT }),
    listSubmissions: async () => ({ items: [], nextCursor: null, fetchedAt: AT }),
    fetchProblem: async () => {
      throw new Error('the batch layer must not call fetchProblem directly');
    },
    fetchEditorial: async () => {
      throw new Error('the batch layer must not call fetchEditorial directly');
    },
  };
}

interface MaterialHarness {
  readonly store: FakeBatchStore;
  readonly gateway: ScriptedRefreshGateway;
  readonly adapters: Map<string, PlatformAdapter>;
  readonly now: { value: string };
  readonly service: MaterialRefreshBatchService;
  makeService(): MaterialRefreshBatchService;
}

function harness(scopes: readonly fx.Scope[], options: { readonly closeWaitMs?: number } = {}): MaterialHarness {
  const store = new FakeBatchStore();
  const gateway = new ScriptedRefreshGateway();
  const adapters = new Map<string, PlatformAdapter>();
  for (const scope of scopes) {
    store.accounts.set(scope.account.id, scope.account);
    store.problems.set(scope.problem.key, scope.problem);
    adapters.set(scope.instance.id, syntheticAdapter(scope.instance));
  }
  const now = { value: AT };
  let minted = 0;
  const makeService = (): MaterialRefreshBatchService =>
    new MaterialRefreshBatchService({
      store: store as unknown as TrainingStore,
      imports: gateway as unknown as ImportService,
      adapterFor: async (sourceInstanceId) => {
        const adapter = adapters.get(sourceInstanceId);
        if (adapter === undefined) {
          throw new Error(`no synthetic adapter for ${sourceInstanceId}`);
        }
        return adapter;
      },
      limits: async () => LIMITS,
      now: () => now.value,
      uniqueId: (prefix) => `${prefix}-${(minted += 1)}`,
      ...(options.closeWaitMs === undefined ? {} : { closeWaitMs: options.closeWaitMs }),
    });
  return { store, gateway, adapters, now, service: makeService(), makeService };
}

// ---------------------------------------------------------------------------------------
// Pure record rules
// ---------------------------------------------------------------------------------------

void test('a prepared batch is a closed, ordered, frozen 1..100 record that implies no work', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '2B');
  const batch = batchOf([
    itemInput(second.problem.key),
    itemInput(alice.problem.key, {
      accountId: alice.account.id,
      officialTutorialUrl: 'https://codeforces.com/blog/entry/1',
      fetchStatement: false,
    }),
  ]);

  assert.equal(batch.status, 'prepared');
  assert.equal(batch.revision, 0);
  assert.equal(batch.startedAt, null);
  assert.equal(batch.finishedAt, null);
  assert.equal(batch.cancelledAt, null);
  assert.deepEqual(
    batch.items.map((item) => item.problemKey),
    [second.problem.key, alice.problem.key],
    'caller order is the batch order',
  );
  const [first, described] = batch.items;
  assert.ok(first);
  assert.ok(described);
  assert.deepEqual(first, {
    problemKey: second.problem.key,
    accountId: null,
    officialTutorialUrl: null,
    fetchStatement: true,
    status: 'pending',
    attempts: 0,
    failure: null,
    result: null,
    startedAt: null,
    finishedAt: null,
  });
  assert.equal(described.accountId, alice.account.id);
  assert.equal(described.fetchStatement, false);
  assert.equal(Object.isFrozen(batch), true);
  assert.equal(Object.isFrozen(batch.items), true);
  assert.equal(Object.isFrozen(first), true);

  // Boundary and shape refusals; nothing here may be repaired into a batch.
  const keys = (count: number): readonly string[] =>
    Array.from({ length: count }, (_, index) =>
      problemKey({ sourceInstanceId: alice.instance.id, domain: null, externalKey: `BULK${index}` }),
    );
  assert.equal(batchOf(keys(1).map((key) => itemInput(key))).items.length, 1);
  assert.equal(
    batchOf(keys(MAX_MATERIAL_REFRESH_BATCH_ITEMS).map((key) => itemInput(key))).items.length,
    MAX_MATERIAL_REFRESH_BATCH_ITEMS,
  );
  assert.throws(() => batchOf([]), isDomain('invalid_input'));
  assert.throws(
    () => batchOf(keys(MAX_MATERIAL_REFRESH_BATCH_ITEMS + 1).map((key) => itemInput(key))),
    isDomain('invalid_input'),
  );
  assert.throws(
    () => batchOf([itemInput(alice.problem.key), itemInput(alice.problem.key)]),
    isDomain('duplicate_id'),
  );
  // A typed input cannot smuggle an undeclared member into the durable record: the prepared item is
  // exactly the declared shape (the API boundary refuses the extra field before this layer sees it,
  // and the closed-record validation below refuses a stored record that carries one).
  const smuggled = createMaterialRefreshBatch({
    batchId: 'batch-extra',
    items: [{ problemKey: alice.problem.key, cookie: 'session=1' } as unknown as MaterialRefreshBatchItemInput],
    createdAt: AT,
  });
  assert.deepEqual(
    Object.keys(smuggled.items[0] as object).sort(),
    ['accountId', 'attempts', 'failure', 'fetchStatement', 'finishedAt', 'officialTutorialUrl', 'problemKey', 'result', 'startedAt', 'status'],
    'a prepared item has exactly the declared fields',
  );
  assert.equal(canonicalJson(smuggled).includes('cookie'), false);
  assert.throws(() => batchOf([itemInput('not a canonical key')]), (error: unknown) => error instanceof DomainError);
  assert.throws(
    () => batchOf([itemInput(alice.problem.key, { accountId: 'Codeforces:codeforces.com|1' })]),
    (error: unknown) => error instanceof DomainError,
  );
  assert.throws(
    () => batchOf([itemInput(alice.problem.key, { officialTutorialUrl: 'ftp://example.org/x' })]),
    isDomain('invalid_url'),
  );
  assert.throws(
    () =>
      batchOf([
        itemInput(alice.problem.key, {
          officialTutorialUrl: 'https://alice:SECRET_PASSWORD@codeforces.com/blog/entry/1',
        }),
      ]),
    isDomain('invalid_url'),
    'a tutorial URL carrying credentials is unrepresentable',
  );
  assert.throws(
    () => batchOf([itemInput(alice.problem.key, { fetchStatement: 'yes' as unknown as boolean })]),
    isDomain('invalid_input'),
  );
});

void test('a canonical record body is closed at every level, so a hand-edited secret cannot be accepted', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  let batch = batchOf([itemInput(alice.problem.key)]);
  batch = startMaterialRefreshBatch(batch, LATER);
  batch = beginMaterialRefreshItem(batch, 0, LATER);
  batch = completeMaterialRefreshItem(batch, 0, resultOf('found'), LATER);
  validateMaterialRefreshBatch(batch);

  const withUndeclaredBatchField = { ...batch, cookie: 'session=1' } as unknown as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatch(withUndeclaredBatchField), isDomain('invalid_input'));

  const item = batch.items[0];
  assert.ok(item);
  const withUndeclaredItemField = {
    ...batch,
    items: [{ ...item, statement: SECRET_BODY }],
  } as unknown as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatch(withUndeclaredItemField), isDomain('invalid_input'));

  const withUndeclaredResultField = {
    ...batch,
    items: [{ ...item, result: { ...item.result, rawTag: SECRET_BODY } }],
  } as unknown as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatch(withUndeclaredResultField), isDomain('invalid_input'));

  const withUndeclaredSnapshotField = {
    ...batch,
    items: [{ ...item, result: { ...item.result, snapshot: { ...item.result?.snapshot, body: SECRET_BODY } } }],
  } as unknown as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatch(withUndeclaredSnapshotField), isDomain('invalid_input'));

  const withUndeclaredFailureField = {
    ...batch,
    items: [
      {
        ...item,
        status: 'attention',
        finishedAt: LATER,
        result: null,
        failure: { code: 'unavailable', retryable: true, retryAfterMs: null, attempts: 1, detail: SECRET_DETAIL },
      },
    ],
  } as unknown as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatch(withUndeclaredFailureField), isDomain('invalid_input'));

  // A hand-edited body that smuggled a credential-bearing URL into the stored record is refused by
  // the row validator instead of being re-served or handed to an adapter.
  const withCredentialUrl = {
    ...batch,
    items: [{ ...item, officialTutorialUrl: 'https://alice:SECRET_PASSWORD@codeforces.com/blog/entry/1' }],
  } as unknown as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatch(withCredentialUrl), isDomain('invalid_url'));
});

void test('pure transitions move a batch honestly and settle only when every item completed', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '2B');
  let batch = batchOf([itemInput(alice.problem.key), itemInput(second.problem.key)]);

  assert.throws(() => completeMaterialRefreshItem(batch, 0, resultOf('found'), LATER), isDomain('invalid_transition'));
  assert.throws(() => beginMaterialRefreshItem(batch, 0, LATER), isDomain('invalid_transition'));

  batch = startMaterialRefreshBatch(batch, LATER);
  assert.equal(batch.status, 'running');
  assert.equal(batch.startedAt, LATER);
  assert.throws(() => startMaterialRefreshBatch(batch, LATER), isDomain('invalid_transition'));

  batch = beginMaterialRefreshItem(batch, 0, LATER);
  const first = batch.items[0];
  assert.ok(first);
  assert.equal(first.status, 'running');
  assert.equal(first.attempts, 1);
  assert.equal(first.startedAt, LATER);
  assert.throws(() => beginMaterialRefreshItem(batch, 0, LATER), isDomain('invalid_transition'));
  assert.throws(() => beginMaterialRefreshItem(batch, 5, LATER), isDomain('invalid_input'));

  batch = completeMaterialRefreshItem(batch, 0, resultOf('found'), LATER);
  const settledPartial = settleMaterialRefreshBatchRun(batch, LATER);
  assert.equal(settledPartial.status, 'paused', 'one pending item leaves the batch resumable, not completed');
  assert.equal(settledPartial.finishedAt, null);

  const resumed = startMaterialRefreshBatch(settledPartial, LATER);
  const completed = completeMaterialRefreshItem(
    beginMaterialRefreshItem(resumed, 1, LATER),
    1,
    resultOf('absent'),
    LATER,
  );
  assert.equal(
    completed.status,
    'completed',
    'recording the last outcome settles the run in the same write, so no running record is left without work',
  );
  assert.equal(completed.finishedAt, LATER);
  assert.deepEqual(
    completed.items.map((item) => item.status),
    ['completed', 'completed'],
    'a successful absence is a completed item',
  );
  assert.throws(() => settleMaterialRefreshBatchRun(completed, LATER), isDomain('invalid_transition'));
  assert.throws(() => startMaterialRefreshBatch(completed, LATER), isDomain('invalid_transition'));
  assert.throws(() => cancelMaterialRefreshBatch(completed, LATER), isDomain('invalid_transition'));
  assert.equal(retryFailedMaterialRefreshBatch(completed, LATER), completed, 'a completed batch is terminal');

  // The same automatic settle applies to the last item of a run that ends in attention: the batch
  // becomes paused (retryable), never a running record with no work.
  const failedLast = failMaterialRefreshItem(
    beginMaterialRefreshItem(startMaterialRefreshBatch(settledPartial, LATER), 1, LATER),
    1,
    fromPlatformError(new PlatformError({ code: 'unavailable', operation: 'editorial', detail: '503' })),
    LATER,
  );
  assert.equal(failedLast.status, 'paused');
  assert.equal(failedLast.finishedAt, null);
  assert.equal(retryFailedMaterialRefreshBatch(failedLast, LATER).status, 'paused');
});

void test('cancel keeps completed siblings, is idempotent, and never starts a pending item', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '2B');
  let batch = batchOf([itemInput(alice.problem.key), itemInput(second.problem.key)]);
  batch = startMaterialRefreshBatch(batch, LATER);
  batch = completeMaterialRefreshItem(beginMaterialRefreshItem(batch, 0, LATER), 0, resultOf('found'), LATER);
  batch = beginMaterialRefreshItem(batch, 1, LATER);

  const cancelled = cancelMaterialRefreshBatch(batch, LATER);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelledAt, LATER);
  assert.deepEqual(
    cancelled.items.map((item) => item.status),
    ['completed', 'cancelled'],
  );
  const preserved = cancelled.items[0];
  const inFlight = cancelled.items[1];
  assert.ok(preserved);
  assert.ok(inFlight);
  assert.deepEqual(preserved, batch.items[0], 'a completed sibling is preserved byte for byte');
  assert.equal(inFlight.finishedAt, LATER, 'a stopped in-flight item records when it stopped');

  const repeated = cancelMaterialRefreshBatch(cancelled, '2026-10-01T09:00:00.000Z');
  assert.equal(repeated, cancelled, 'a repeated cancel changes nothing');
  assert.equal(canonicalJson(repeated), canonicalJson(cancelled));
});

void test('retry-failed resets only non-completed items and never repeats a completed one', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '2B');
  const third = fx.makeScope('codeforces', 'codeforces.com', 'alice', '3C');
  let batch = batchOf([itemInput(alice.problem.key), itemInput(second.problem.key), itemInput(third.problem.key)]);
  batch = startMaterialRefreshBatch(batch, LATER);
  batch = completeMaterialRefreshItem(beginMaterialRefreshItem(batch, 0, LATER), 0, resultOf('found'), LATER);
  batch = failMaterialRefreshItem(
    beginMaterialRefreshItem(batch, 1, LATER),
    1,
    fromPlatformError(new PlatformError({ code: 'unavailable', operation: 'editorial', detail: '503' })),
    LATER,
  );

  assert.throws(() => retryFailedMaterialRefreshBatch(batch, LATER), isDomain('invalid_transition'));
  const paused = settleMaterialRefreshBatchRun(batch, LATER);
  assert.equal(paused.status, 'paused');

  const retried = retryFailedMaterialRefreshBatch(paused, LATER);
  assert.equal(retried.status, 'paused', 'retry never resumes work on its own');
  assert.deepEqual(
    retried.items.map((item) => item.status),
    ['completed', 'pending', 'pending'],
  );
  assert.deepEqual(retried.items[0], paused.items[0], 'the completed item is untouched, snapshot included');
  const retriedFailure = retried.items[1];
  assert.ok(retriedFailure);
  assert.equal(retriedFailure.failure, null);
  assert.equal(retriedFailure.attempts, 1, 'retry preserves the recorded attempt count');
  assert.notEqual(retried, paused);
  assert.equal(retryFailedMaterialRefreshBatch(retried, LATER), retried, 'nothing left to retry changes nothing');
});

void test('retry returns a cancelled batch to the state that truthfully describes it', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '2B');
  const fresh = batchOf([itemInput(alice.problem.key), itemInput(second.problem.key)]);

  // Cancelled before its first start: no platform read happened, so retry restores `prepared`, and
  // the following start is still an explicit caller decision.
  const cancelled = cancelMaterialRefreshBatch(fresh, LATER);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.startedAt, null);
  const backToPrepared = retryFailedMaterialRefreshBatch(cancelled, LATER);
  assert.equal(backToPrepared.status, 'prepared');
  assert.equal(backToPrepared.startedAt, null, 'a batch that never ran records no start instant');
  assert.equal(backToPrepared.cancelledAt, null);
  assert.deepEqual(
    backToPrepared.items.map((item) => item.status),
    ['pending', 'pending'],
  );
  validateMaterialRefreshBatchTransition(cancelled, backToPrepared);
  assert.equal(startMaterialRefreshBatch(backToPrepared, LATER).status, 'running');

  // Cancelled after a run started: retry returns to `paused` and keeps the original start instant.
  let ran = startMaterialRefreshBatch(fresh, LATER);
  ran = completeMaterialRefreshItem(beginMaterialRefreshItem(ran, 0, LATER), 0, resultOf('found'), LATER);
  ran = beginMaterialRefreshItem(ran, 1, LATER);
  const stopped = cancelMaterialRefreshBatch(ran, LATER);
  const paused = retryFailedMaterialRefreshBatch(stopped, LATER);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.startedAt, LATER, 'the batch really started, so its start instant is preserved');
  assert.deepEqual(
    paused.items.map((item) => [item.status, item.attempts]),
    [
      ['completed', 1],
      ['pending', 1],
    ],
  );
  assert.deepEqual(paused.items[0], stopped.items[0], 'the completed item is never rewritten');
  validateMaterialRefreshBatchTransition(stopped, paused);
  // A started batch can never pretend it was merely prepared: the start instant is part of the shape.
  const pretendingPrepared = { ...stopped, status: 'prepared' as const, updatedAt: LATER };
  assert.throws(
    () => validateMaterialRefreshBatch(pretendingPrepared),
    isDomain('invalid_input'),
    'a started batch cannot claim to be merely prepared',
  );
});

void test('interrupt recovery is a truthful pause that performs no platform work', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '2B');
  let batch = batchOf([itemInput(alice.problem.key), itemInput(second.problem.key)]);
  batch = startMaterialRefreshBatch(batch, LATER);
  batch = completeMaterialRefreshItem(beginMaterialRefreshItem(batch, 0, LATER), 0, resultOf('found'), LATER);
  batch = beginMaterialRefreshItem(batch, 1, LATER);
  batch = { ...batch, items: [batch.items[0] as MaterialRefreshBatch['items'][number], { ...(batch.items[1] as MaterialRefreshBatch['items'][number]), attempts: 2 }] };

  const recovered = interruptMaterialRefreshBatch(batch, LATER);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.finishedAt, null);
  const interrupted = recovered.items[1];
  assert.ok(interrupted);
  assert.equal(interrupted.status, 'attention');
  assert.deepEqual(interrupted.failure, { code: 'interrupted', retryable: true, retryAfterMs: null, attempts: 2 });
  assert.deepEqual(recovered.items[0], batch.items[0]);
  assert.throws(() => interruptMaterialRefreshBatch(recovered, LATER), isDomain('invalid_transition'));
});

void test('completed items and fixed identities are immutable, and attempts only move forward', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const other = fx.makeScope('codeforces', 'codeforces.com', 'alice', '9Z');
  const third = fx.makeScope('codeforces', 'codeforces.com', 'alice', '8Y');
  let batch = batchOf([itemInput(alice.problem.key), itemInput(other.problem.key)]);
  batch = startMaterialRefreshBatch(batch, LATER);
  batch = completeMaterialRefreshItem(beginMaterialRefreshItem(batch, 0, LATER), 0, resultOf('found'), LATER);
  const completedItem = batch.items[0];
  assert.ok(completedItem);

  const rewritten = {
    ...batch,
    items: [
      { ...completedItem, result: { ...(completedItem.result as MaterialRefreshItemResult), solutionCount: 99 } },
      batch.items[1],
    ],
  } as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatchTransition(batch, rewritten), isDomain('immutable_violation'));

  const renamed = {
    ...batch,
    items: [{ ...completedItem, problemKey: third.problem.key }, batch.items[1]],
  } as unknown as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatchTransition(batch, renamed), isDomain('immutable_violation'));

  const recreated = { ...batch, createdAt: '2026-10-01T07:00:00.000Z', updatedAt: LATER } as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatchTransition(batch, recreated), isDomain('immutable_violation'));

  // A second attempt is legal; a record that loses one is refused even though it is otherwise valid.
  let retried = settleMaterialRefreshBatchRun(batch, LATER);
  retried = retryFailedMaterialRefreshBatch(
    cancelMaterialRefreshBatch(startMaterialRefreshBatch(retried, LATER), LATER),
    LATER,
  );
  retried = startMaterialRefreshBatch(retried, LATER);
  retried = beginMaterialRefreshItem(retried, 1, LATER);
  retried = failMaterialRefreshItem(retried, 1, fromPlatformError(new PlatformError({ code: 'unavailable', operation: 'editorial', detail: 'x' })), LATER);
  retried = retryFailedMaterialRefreshBatch(retried, LATER);
  retried = startMaterialRefreshBatch(retried, LATER);
  retried = beginMaterialRefreshItem(retried, 1, LATER);
  const secondAttempt = retried.items[1];
  assert.ok(secondAttempt);
  assert.equal(secondAttempt.attempts, 2);
  const losingAttempt = { ...retried, items: [retried.items[0], { ...secondAttempt, attempts: 1 }] } as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatchTransition(retried, losingAttempt), isDomain('invalid_transition'));

  // An illegal status step is refused with the transition vocabulary, not repaired.
  const pending = batchOf([itemInput(alice.problem.key)]);
  const illegalItemStep = {
    ...pending,
    updatedAt: LATER,
    items: [
      {
        ...(pending.items[0] as MaterialRefreshBatch['items'][number]),
        status: 'completed',
        attempts: 1,
        startedAt: LATER,
        finishedAt: LATER,
        result: resultOf('found'),
      },
    ],
  } as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatchTransition(pending, illegalItemStep), isDomain('invalid_transition'));

  const illegalBatchStep = { ...pending, status: 'paused', startedAt: LATER, updatedAt: LATER } as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatchTransition(pending, illegalBatchStep), isDomain('invalid_transition'));

  const backwards = { ...batch, updatedAt: AT } as MaterialRefreshBatch;
  assert.throws(() => validateMaterialRefreshBatchTransition(batch, backwards), isDomain('invalid_transition'));
});

// ---------------------------------------------------------------------------------------
// Report classification
// ---------------------------------------------------------------------------------------

void test('found and absent are both completed observations while every failure stays retryable attention', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const ref = alice.problem.ref;

  const found = classifyMaterialRefreshReport(
    materialReport(ref, foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', SECRET_BODY), {
      statement: 'fetched',
    }),
  );
  assert.equal(found.kind, 'completed');
  if (found.kind === 'completed') {
    assert.equal(found.result.editorial, 'found');
    assert.equal(found.result.sourceCount, 1);
    assert.equal(found.result.solutionCount, 1);
    assert.equal(found.result.statement, 'fetched');
    assert.equal(found.result.mirror, 'skipped');
  }

  const absent = classifyMaterialRefreshReport(
    materialReport(ref, { status: 'absent', detail: 'the catalogue lists no editorial' }),
  );
  assert.equal(absent.kind, 'completed', 'a successful absence is a completed result');
  if (absent.kind === 'completed') {
    assert.equal(absent.result.editorial, 'absent');
    assert.equal(absent.result.sourceCount, 0);
    assert.equal(absent.result.solutionCount, 0);
  }

  const operational: readonly { readonly label: string; readonly editorial: EditorialFetchResult; readonly code: string; readonly retryable: boolean; readonly retryAfterMs: number | null }[] = [
    { label: 'auth_required', editorial: { status: 'auth_required', detail: 'login' }, code: 'auth_required', retryable: false, retryAfterMs: null },
    { label: 'forbidden', editorial: { status: 'forbidden', detail: 'no' }, code: 'forbidden', retryable: false, retryAfterMs: null },
    { label: 'rate_limited', editorial: { status: 'rate_limited', detail: 'slow', retryAfterMs: 4000 }, code: 'rate_limited', retryable: true, retryAfterMs: 4000 },
    { label: 'unavailable', editorial: { status: 'unavailable', detail: '503', retryable: true }, code: 'unavailable', retryable: true, retryAfterMs: null },
    // A temporary outage may declare Retry-After as well; the item keeps the provider's own deadline
    // instead of dropping it, and an answer that declared none still says `null`.
    { label: 'unavailable with Retry-After', editorial: { status: 'unavailable', detail: '503', retryable: true, retryAfterMs: 7000 }, code: 'unavailable', retryable: true, retryAfterMs: 7000 },
    { label: 'changed_response', editorial: { status: 'changed_response', detail: 'layout', sample: SECRET_BODY }, code: 'changed_response', retryable: false, retryAfterMs: null },
  ];
  for (const entry of operational) {
    const outcome = classifyMaterialRefreshReport(materialReport(ref, entry.editorial));
    assert.equal(outcome.kind, 'failed', `${entry.label} is not a completed observation`);
    if (outcome.kind === 'failed') {
      assert.equal(outcome.failure.code, entry.code);
      assert.equal(outcome.failure.retryable, entry.retryable);
      assert.equal(outcome.failure.retryAfterMs, entry.retryAfterMs);
      assert.notEqual(outcome.result?.editorial, 'absent', `${entry.label} must never be read as absence`);
      assert.equal(JSON.stringify(outcome).includes(SECRET_BODY), false, `${entry.label} must not carry a sample`);
    }
  }

  const thrown = materialReport(ref, foundResult('editorial-2', 'https://codeforces.com/blog/entry/2', 'body'));
  const withEditorialError: RefreshMaterialReport = {
    ...thrown,
    editorial: {
      attempted: true,
      result: null,
      error: new PlatformError({ code: 'rate_limited', operation: 'editorial', detail: SECRET_DETAIL, retryAfterMs: 2500 }),
      skippedReason: null,
    },
  };
  const failed = classifyMaterialRefreshReport(withEditorialError);
  assert.equal(failed.kind, 'failed');
  if (failed.kind === 'failed') {
    assert.equal(failed.failure.code, 'rate_limited');
    assert.equal(failed.failure.retryAfterMs, 2500);
    assert.equal(JSON.stringify(failed).includes(SECRET_DETAIL), false);
  }

  const statementFailed = classifyMaterialRefreshReport(
    materialReport(ref, foundResult('editorial-3', 'https://codeforces.com/blog/entry/3', 'body'), {
      statement: 'failed',
      statementError: new PlatformError({ code: 'forbidden', operation: 'problem', detail: SECRET_DETAIL }),
    }),
  );
  assert.equal(statementFailed.kind, 'failed');
  if (statementFailed.kind === 'failed') {
    assert.equal(statementFailed.failure.code, 'forbidden');
    assert.equal(statementFailed.result?.statement, 'failed');
  }

  const noMetadata = classifyMaterialRefreshReport(
    materialReport(ref, foundResult('editorial-4', 'https://codeforces.com/blog/entry/4', 'body'), { problem: null }),
  );
  assert.equal(noMetadata.kind, 'failed');
  if (noMetadata.kind === 'failed') {
    assert.equal(noMetadata.failure.code, 'missing_reference');
    assert.equal(noMetadata.failure.retryable, true);
  }

  assert.equal(fromPlatformError(new PlatformError({ code: 'invalid_input', operation: 'editorial', detail: 'bad ref' })).code, 'invalid_reference');
  assert.equal(fromPlatformError(new PlatformError({ code: 'cancelled', operation: 'editorial', detail: 'aborted' })).code, 'interrupted');
});

void test('the public projection is metadata only, ordered and closed, even when the record carried secrets', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', SECRET_HANDLE, '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', SECRET_HANDLE, '2B');
  const secretProblem = fx.makeProblem(alice.problem.ref, {
    title: `title ${SECRET_BODY}`,
    statement: `statement ${SECRET_BODY}`,
  });
  const rich = classifyMaterialRefreshReport(
    materialReport(alice.problem.ref, foundResult('editorial-secret', SECRET_URL, `solution ${SECRET_BODY}`), {
      problem: secretProblem,
      statement: 'fetched',
    }),
  );
  assert.equal(rich.kind, 'completed');
  if (rich.kind !== 'completed') {
    return;
  }

  let batch = batchOf([
    itemInput(alice.problem.key, { officialTutorialUrl: SECRET_URL, accountId: alice.account.id }),
    itemInput(second.problem.key),
  ]);
  batch = startMaterialRefreshBatch(batch, LATER);
  batch = completeMaterialRefreshItem(beginMaterialRefreshItem(batch, 0, LATER), 0, rich.result, LATER);
  batch = failMaterialRefreshItem(
    beginMaterialRefreshItem(batch, 1, LATER),
    1,
    fromPlatformError(
      new PlatformError({ code: 'auth_required', operation: 'editorial', detail: SECRET_DETAIL, sample: SECRET_BODY }),
    ),
    LATER,
  );

  const view = materialRefreshBatchView(batch);
  const summary = materialRefreshBatchSummaryView(batch);
  const serialized = JSON.stringify({ view, summary });
  // The account id encodes its handle, so neither the id nor the handle may travel; the sentinel
  // handle is what makes a reintroduced `accountId` field fail this case rather than pass silently.
  for (const secret of [
    SECRET_BODY,
    SECRET_URL,
    SECRET_DETAIL,
    SECRET_HANDLE,
    alice.account.id,
    'title ',
    'solution ',
  ]) {
    assert.equal(serialized.includes(secret), false, `the projection must not carry ${secret}`);
  }
  assert.deepEqual(
    view.items.map((item) => item.problemKey),
    [alice.problem.key, second.problem.key],
    'the projection preserves caller order',
  );
  const [firstItem, secondItem] = view.items;
  assert.ok(firstItem);
  assert.ok(secondItem);
  assert.equal(firstItem.hasOfficialTutorial, true);
  assert.equal(Object.prototype.hasOwnProperty.call(firstItem, 'officialTutorialUrl'), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(firstItem, 'accountId'),
    false,
    'no account identity is exposed, not even the opaque id',
  );
  assert.equal(secondItem.failure?.code, 'auth_required');
  assert.equal(secondItem.failure?.attempts, 1);
  assert.equal(view.counts.completed, 1);
  assert.equal(view.counts.attention, 1);
  assert.equal(view.itemCount, 2);
  assert.equal(summary.itemCount, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'items'), false);

  // Closed recursively: no undeclared key may appear anywhere in the boundary shape.
  const allowed = new Set([
    'batchId', 'status', 'revision', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'cancelledAt',
    'itemCount', 'counts', 'items', 'pending', 'running', 'completed', 'attention', 'cancelled',
    'changedSnapshots', 'problemKey', 'fetchStatement', 'hasOfficialTutorial', 'attempts',
    'failure', 'result', 'code', 'retryable', 'retryAfterMs', 'statement', 'editorial', 'mirror',
    'sourceCount', 'solutionCount', 'snapshot', 'snapshotId', 'version', 'contentHash', 'changed',
  ]);
  const forbidden = /^(model|provider|prompt|promptVersion|usage|tokens|budget|cost|analysisId|cookie|session|credential|vault|apiKey|password|secret|detail|sample|rawTags|title|displayName|handle|text|body)$/iu;
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      assert.ok(allowed.has(key), `${path}.${key} is not part of the bulk material-refresh contract`);
      assert.equal(forbidden.test(key), false, `${path}.${key} names a forbidden surface`);
      walk(entry, `${path}.${key}`);
    }
  };
  walk(view, 'view');
  walk(summary, 'summary');
});

// ---------------------------------------------------------------------------------------
// Service orchestration
// ---------------------------------------------------------------------------------------

void test('the service requires its explicit collaborators and a bounded close wait', () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const h = harness([alice]);
  const base = {
    store: h.store as unknown as TrainingStore,
    imports: h.gateway as unknown as ImportService,
    adapterFor: async () => syntheticAdapter(alice.instance),
    limits: async () => LIMITS,
    now: () => AT,
    uniqueId: () => 'id',
  };
  assert.throws(() => new MaterialRefreshBatchService({ ...base, store: null as unknown as TrainingStore }), isDomain('unfilled_settings'));
  assert.throws(
    () => new MaterialRefreshBatchService({ ...base, imports: {} as unknown as ImportService }),
    isDomain('unfilled_settings'),
  );
  assert.throws(
    () => new MaterialRefreshBatchService({ ...base, adapterFor: 'nope' as unknown as (id: string) => Promise<PlatformAdapter> }),
    isDomain('unfilled_settings'),
  );
  assert.throws(
    () => new MaterialRefreshBatchService({ ...base, limits: undefined as unknown as () => Promise<PlatformLimits> }),
    isDomain('unfilled_settings'),
  );
  assert.throws(
    () => new MaterialRefreshBatchService({ ...base, uniqueId: undefined as unknown as (prefix: string) => string }),
    isDomain('unfilled_settings'),
  );
  assert.throws(() => new MaterialRefreshBatchService({ ...base, closeWaitMs: 60_001 }), isDomain('invalid_input'));
  assert.throws(() => new MaterialRefreshBatchService({ ...base, closeWaitMs: 1.5 }), isDomain('invalid_input'));
});

void test('a run processes items in order with one platform call each and a global concurrency of one', async () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '2B');
  const h = harness([alice, second]);
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');
  h.gateway.script(alice.problem.key, { kind: 'report', report: materialReport(alice.problem.ref, found, { statement: 'fetched' }) });
  h.gateway.script(second.problem.key, { kind: 'report', report: materialReport(second.problem.ref, { status: 'absent', detail: 'none' }) });

  const prepared = await h.service.prepare({ items: [itemInput(alice.problem.key), itemInput(second.problem.key)] }, token());
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.itemCount, 2);
  assert.equal(h.gateway.calls.length, 0, 'prepare is local and free');

  const started = await h.service.start(prepared.batchId, token());
  assert.equal(started.status, 'running');

  const detail = await waitFor(
    async () => {
      const view = await h.service.detail(prepared.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the batch to settle',
  );
  assert.equal(detail.status, 'completed');
  assert.deepEqual(
    detail.items.map((item) => item.status),
    ['completed', 'completed'],
    'items stay in caller order',
  );
  const first = detail.items[0];
  const secondItem = detail.items[1];
  assert.ok(first);
  assert.ok(secondItem);
  assert.equal(first.failure, null);
  assert.equal(first.attempts, 1);
  assert.equal(first.result?.statement, 'fetched');
  assert.equal(secondItem.result?.editorial, 'absent');
  assert.equal(detail.counts.completed, 2);
  assert.equal(h.gateway.calls.map((call) => call.problemKey).join(','), `${alice.problem.key},${second.problem.key}`);
  assert.equal(h.gateway.peak, 1, 'the batch layer adds no second platform read');
  assert.equal(detail.finishedAt !== null, true);

  const list = await h.service.list({}, token());
  assert.equal(list.total, 1);
  assert.equal(list.limit, 20);
  assert.equal(list.batches[0]?.status, 'completed');
});

void test('a second batch waits for the first, so global platform concurrency stays one', async () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '2B');
  const h = harness([alice, second]);
  const delay = (): Promise<void> => sleep(10);
  for (const scope of [alice, second]) {
    h.gateway.script(
      scope.problem.key,
      { kind: 'gate', gate: delay(), report: materialReport(scope.problem.ref, foundResult(`e-${scope.problem.ref.externalKey}`, 'https://codeforces.com/blog/entry/2', 'a')) },
      { kind: 'gate', gate: delay(), report: materialReport(scope.problem.ref, foundResult(`e-${scope.problem.ref.externalKey}`, 'https://codeforces.com/blog/entry/2', 'a')) },
    );
  }
  const first = await h.service.prepare({ items: [itemInput(alice.problem.key)] }, token());
  const secondBatch = await h.service.prepare({ items: [itemInput(second.problem.key)] }, token());
  await h.service.start(first.batchId, token());
  await h.service.start(secondBatch.batchId, token());
  await h.service.whenSettled();

  assert.equal(h.gateway.peak, 1);
  assert.deepEqual(
    h.gateway.calls.map((call) => call.problemKey),
    [alice.problem.key, second.problem.key],
    'the queued batch starts only after the first run finished',
  );
  assert.equal((await h.service.detail(first.batchId, token())).status, 'completed');
  assert.equal((await h.service.detail(secondBatch.batchId, token())).status, 'completed');
});

void test('partial failures are sanitized per item and later items still progress', async () => {
  const scopes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((suffix) =>
    fx.makeScope('codeforces', 'codeforces.com', 'alice', `1900${suffix}`),
  );
  const h = harness(scopes);
  const [ok, auth, rate, stale, changed, unavailable, forbidden] = scopes;
  assert.ok(ok && auth && rate && stale && changed && unavailable && forbidden);
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');
  h.gateway.script(ok.problem.key, {
    kind: 'report',
    report: materialReport(ok.problem.ref, found, { statement: 'fetched' }),
  });
  h.gateway.script(auth.problem.key, { kind: 'error', error: new PlatformError({ code: 'auth_required', operation: 'editorial', detail: SECRET_DETAIL }) });
  h.gateway.script(rate.problem.key, { kind: 'error', error: new PlatformError({ code: 'rate_limited', operation: 'editorial', detail: 'slow down', retryAfterMs: 4000 }) });
  // The stale-head item: a concurrent manual import supersedes the captured head while the platform
  // read is in flight, exactly the refusal the accepted single-problem path already implements.
  h.gateway.script(stale.problem.key, {
    kind: 'error',
    error: new DomainError('invalid_transition', 'material refresh is stale', { reason: 'head_changed' }),
  });
  h.gateway.script(changed.problem.key, {
    kind: 'report',
    report: materialReport(changed.problem.ref, { status: 'changed_response', detail: 'layout', sample: SECRET_BODY }),
  });
  h.gateway.script(unavailable.problem.key, {
    kind: 'report',
    report: materialReport(unavailable.problem.ref, {
      status: 'unavailable',
      detail: '503',
      retryable: true,
      retryAfterMs: 6_000,
    }),
  });
  h.gateway.script(forbidden.problem.key, { kind: 'error', error: new PlatformError({ code: 'forbidden', operation: 'editorial', detail: 'denied' }) });

  const prepared = await h.service.prepare(
    { items: scopes.map((scope) => itemInput(scope.problem.key)) },
    token(),
  );
  await h.service.start(prepared.batchId, token());
  const paused = await waitFor(
    async () => {
      const view = await h.service.detail(prepared.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the batch to pause after the partial failures',
  );

  assert.equal(paused.status, 'paused');
  assert.equal(paused.counts.completed, 1);
  assert.equal(paused.counts.attention, 6);
  assert.deepEqual(
    paused.items.map((item) => item.failure?.code ?? null),
    [null, 'auth_required', 'rate_limited', 'stale_head', 'changed_response', 'unavailable', 'forbidden'],
    'every operational family keeps its own sanitized code, and a stale head is retryable',
  );
  assert.equal(
    paused.items.every((item) => item.attempts === 1),
    true,
    'the batch layer adds no hidden retry',
  );
  const rateItem = paused.items[2];
  assert.ok(rateItem);
  assert.equal(rateItem.failure?.retryAfterMs, 4000);
  assert.equal(rateItem.failure?.retryable, true);
  const unavailableItem = paused.items[5];
  assert.ok(unavailableItem);
  assert.equal(
    unavailableItem.failure?.retryAfterMs,
    6_000,
    'an unavailable answer keeps the Retry-After it declared instead of dropping it',
  );
  assert.equal(unavailableItem.failure?.retryable, true);
  const staleItem = paused.items[3];
  assert.ok(staleItem);
  assert.equal(staleItem.failure?.retryable, true);
  assert.equal(JSON.stringify(paused).includes(SECRET_DETAIL), false);
  assert.equal(JSON.stringify(paused).includes(SECRET_BODY), false);
  assert.equal(h.gateway.calls.length, 7, 'every item after a failure was still attempted');

  // Retry resets exactly the attention items, then an explicit start repeats only those.
  const completedBefore = paused.items[0];
  assert.ok(completedBefore);
  const retried = await h.service.retryFailed(prepared.batchId, token());
  assert.deepEqual(retried.items[0], completedBefore, 'the completed item is never reset');
  assert.deepEqual(
    retried.items.slice(1).map((item) => item.status),
    ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'],
  );
  assert.equal(retried.status, 'paused');

  for (const scope of [auth, rate, stale, changed, unavailable, forbidden]) {
    h.gateway.script(scope.problem.key, {
      kind: 'report',
      report: materialReport(scope.problem.ref, found, { statement: 'fetched' }),
    });
  }
  await h.service.start(prepared.batchId, token());
  const completed = await waitFor(
    async () => {
      const view = await h.service.detail(prepared.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the retried batch to complete',
  );
  assert.equal(completed.status, 'completed');
  assert.equal(
    h.gateway.callsFor(ok.problem.key),
    1,
    'a completed item is never fetched a second time',
  );
  assert.deepEqual(completed.items[0], completedBefore, 'the completed item is byte-for-byte preserved');
});

void test('a named account is proven at prepare and again at run time, and never falls back to anonymous', async () => {
  const target = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const foreign = fx.makeScope('luogu', 'www.luogu.com.cn', '123456', 'P1000');
  const h = harness([target, second, foreign]);
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');
  const unknownAccountId = accountIdOf(target.instance.id, 'ghost');

  // Prepare refuses a foreign account (stored, but owned by another source instance) and an id the
  // store never held. Nothing is written and no platform work is implied.
  await assert.rejects(
    h.service.prepare({ items: [itemInput(target.problem.key, { accountId: foreign.account.id })] }, token()),
    isDomain('missing_reference'),
  );
  await assert.rejects(
    h.service.prepare({ items: [itemInput(second.problem.key, { accountId: unknownAccountId })] }, token()),
    isDomain('missing_reference'),
  );
  assert.equal(h.store.batches.size, 0, 'a refused prepare writes no batch row');
  assert.equal(h.store.saves.length, 0, 'a refused prepare never reaches the store');
  assert.equal(h.gateway.calls.length, 0, 'a refused prepare performs no platform IO');

  // A stored account of the problem's own source is accepted, and an omitted account stays anonymous.
  h.gateway.script(target.problem.key, { kind: 'report', report: materialReport(target.problem.ref, found) });
  h.gateway.script(second.problem.key, { kind: 'report', report: materialReport(second.problem.ref, found) });
  const allowed = await h.service.prepare(
    {
      items: [
        itemInput(target.problem.key, { accountId: target.account.id }),
        itemInput(second.problem.key, { accountId: null }),
      ],
    },
    token(),
  );
  await h.service.start(allowed.batchId, token());
  const completed = await waitFor(
    async () => {
      const view = await h.service.detail(allowed.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the authenticated and anonymous items to settle',
  );
  assert.equal(completed.status, 'completed');
  assert.equal(h.gateway.calls[0]?.accountId, target.account.id);
  assert.equal(h.gateway.calls[0]?.hasAccountKey, true);
  assert.equal(h.gateway.calls[1]?.accountId, null);
  assert.equal(h.gateway.calls[1]?.hasAccountKey, false, 'an anonymous read carries no account member at all');

  // The account is re-checked per attempt: a row removed after prepare fails the item before any read.
  const removed = await h.service.prepare(
    { items: [itemInput(target.problem.key, { accountId: target.account.id })] },
    token(),
  );
  h.store.accounts.delete(target.account.id);
  await h.service.start(removed.batchId, token());
  const missingAccount = await waitFor(
    async () => {
      const view = await h.service.detail(removed.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the removed account to be refused',
  );
  assert.equal(missingAccount.status, 'paused');
  assert.equal(missingAccount.items[0]?.failure?.code, 'missing_reference');
  assert.equal(missingAccount.items[0]?.result, null, 'a refused item records no fabricated observation');
  assert.equal(
    h.gateway.callsFor(target.problem.key),
    1,
    'only the earlier, still-owned attempt reached the refresh path',
  );

  // An adapter bound to another instance is refused as unavailable, again before any request.
  const wrongWorld = harness([target]);
  wrongWorld.gateway.script(target.problem.key, { kind: 'report', report: materialReport(target.problem.ref, found) });
  wrongWorld.adapters.set(target.instance.id, syntheticAdapter(foreign.instance));
  const wrongAdapter = await wrongWorld.service.prepare({ items: [itemInput(target.problem.key)] }, token());
  await wrongWorld.service.start(wrongAdapter.batchId, token());
  const refusedAdapter = await waitFor(
    async () => {
      const view = await wrongWorld.service.detail(wrongAdapter.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the adapter mismatch to settle',
  );
  assert.equal(refusedAdapter.items[0]?.failure?.code, 'unavailable');
  assert.equal(wrongWorld.gateway.calls.length, 0);
});

void test('prepare refuses an absent problem and an unsafe tutorial URL, writing nothing either time', async () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const h = harness([alice]);
  const unknownKey = problemKey({ sourceInstanceId: alice.instance.id, domain: null, externalKey: '1900Z' });

  await assert.rejects(
    h.service.prepare({ items: [itemInput(unknownKey)] }, token()),
    isDomain('missing_reference'),
    'a batch refreshes stored material, so an absent problem is refused, not imported',
  );
  // A stored row whose own reference does not recompose to the requested canonical key is refused too:
  // the problem's source instance is part of what "stored" means.
  const foreignRef = { sourceInstanceId: 'luogu:www.luogu.com.cn', domain: null, externalKey: 'P1000' };
  h.store.problems.set(alice.problem.key, fx.makeProblem(foreignRef));
  await assert.rejects(
    h.service.prepare({ items: [itemInput(alice.problem.key)] }, token()),
    isDomain('missing_reference'),
    'the stored problem must recompose to the requested canonical key',
  );
  h.store.problems.set(alice.problem.key, alice.problem);
  await assert.rejects(
    h.service.prepare(
      {
        items: [
          itemInput(alice.problem.key, {
            officialTutorialUrl: 'https://alice:SECRET_PASSWORD@codeforces.com/blog/entry/1',
          }),
        ],
      },
      token(),
    ),
    isDomain('invalid_url'),
    'a tutorial URL carrying credentials is refused before persistence',
  );
  assert.equal(h.store.saves.length, 0, 'no refusal writes a batch');
  assert.equal(h.store.batches.size, 0);
  assert.equal(h.gateway.calls.length, 0);
  assert.equal(JSON.stringify([...h.store.batches.values()]).includes('SECRET_PASSWORD'), false);

  // A stored problem whose row is removed after prepare is refused at run time, before any request.
  const prepared = await h.service.prepare({ items: [itemInput(alice.problem.key)] }, token());
  h.store.problems.delete(alice.problem.key);
  await h.service.start(prepared.batchId, token());
  const view = await waitFor(
    async () => {
      const current = await h.service.detail(prepared.batchId, token());
      return current.status === 'running' ? null : current;
    },
    'the removed problem to be refused',
  );
  assert.equal(view.status, 'paused');
  assert.equal(view.items[0]?.failure?.code, 'missing_reference');
  assert.equal(h.gateway.calls.length, 0, 'no refresh call for a problem the store no longer holds');
});

void test('a cancel before the first start retries to prepared and a started cancel returns to paused', async () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const h = harness([alice, second]);
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');

  // prepare → cancel → retry → explicit start.
  const prepared = await h.service.prepare({ items: [itemInput(alice.problem.key)] }, token());
  const cancelled = await h.service.cancel(prepared.batchId, token());
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.startedAt, null, 'cancel before the first start records no start instant');
  const retried = await h.service.retryFailed(prepared.batchId, token());
  assert.equal(retried.status, 'prepared', 'no platform read happened, so the batch is prepared again');
  assert.equal(retried.cancelledAt, null);
  assert.deepEqual(
    retried.items.map((item) => item.status),
    ['pending'],
  );
  h.gateway.script(alice.problem.key, {
    kind: 'report',
    report: materialReport(alice.problem.ref, { status: 'absent', detail: 'none' }),
  });
  await h.service.start(prepared.batchId, token());
  const completed = await waitFor(
    async () => {
      const view = await h.service.detail(prepared.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the retried prepared batch to complete',
  );
  assert.equal(completed.status, 'completed');
  assert.equal(completed.startedAt !== null, true, 'the explicit start records the instant it happened');

  // started → cancel → retry → paused (a real run happened), then an explicit resume.
  const secondBatch = await h.service.prepare({ items: [itemInput(second.problem.key)] }, token());
  const gate = deferred();
  h.gateway.script(second.problem.key, {
    kind: 'gate',
    gate: gate.promise,
    report: materialReport(second.problem.ref, found),
  });
  await h.service.start(secondBatch.batchId, token());
  const running = await waitFor(
    async () => {
      const view = await h.service.detail(secondBatch.batchId, token());
      return view.items[0]?.status === 'running' ? view : null;
    },
    'the resumed item to be in flight',
  );
  assert.equal(running.startedAt !== null, true);
  const stopped = await h.service.cancel(secondBatch.batchId, token());
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.startedAt !== null, true, 'the start instant survives the cancel');
  gate.resolve();
  await h.service.whenSettled();
  const paused = await h.service.retryFailed(secondBatch.batchId, token());
  assert.equal(paused.status, 'paused', 'a batch that really ran returns to paused');
  assert.equal(paused.startedAt, stopped.startedAt);
  assert.deepEqual(
    paused.items.map((item) => item.status),
    ['pending'],
  );
  h.gateway.script(second.problem.key, { kind: 'report', report: materialReport(second.problem.ref, found) });
  await h.service.start(secondBatch.batchId, token());
  const resumed = await waitFor(
    async () => {
      const view = await h.service.detail(secondBatch.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the resumed batch to complete',
  );
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.items[0]?.result?.editorial, 'found');
});

void test('cancellation reaches the live token, keeps the completed sibling and prevents later items', async () => {
  const scopes = ['A', 'B', 'C'].map((suffix) => fx.makeScope('codeforces', 'codeforces.com', 'alice', `1900${suffix}`));
  const h = harness(scopes);
  const [first, gated, never] = scopes;
  assert.ok(first && gated && never);
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');
  h.gateway.script(first.problem.key, { kind: 'report', report: materialReport(first.problem.ref, found) });
  const gate = deferred();
  h.gateway.script(gated.problem.key, { kind: 'gate', gate: gate.promise, report: materialReport(gated.problem.ref, found) });
  h.gateway.script(never.problem.key, { kind: 'report', report: materialReport(never.problem.ref, found) });

  const prepared = await h.service.prepare({ items: scopes.map((scope) => itemInput(scope.problem.key)) }, token());
  await h.service.start(prepared.batchId, token());
  const inFlight = await waitFor(
    async () => {
      const view = await h.service.detail(prepared.batchId, token());
      const secondItem = view.items[1];
      return secondItem?.status === 'running' ? view : null;
    },
    'the second item to be in flight',
  );
  assert.equal(inFlight.items[0]?.status, 'completed');
  assert.deepEqual(await h.service.recoverInterrupted(token()), [], 'a live owned run is not interrupted by recovery');

  const cancelled = await h.service.cancel(prepared.batchId, token());
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(
    cancelled.items.map((item) => item.status),
    ['completed', 'cancelled', 'cancelled'],
  );
  assert.equal(cancelled.items[0]?.result?.editorial, 'found', 'the completed sibling keeps its outcome');
  gate.resolve();
  await h.service.whenSettled();
  const gatedCall = h.gateway.calls.find((call) => call.problemKey === gated.problem.key);
  assert.ok(gatedCall);
  assert.equal(gatedCall.token.cancelled, true, 'cancellation reached the token the platform read holds');
  assert.equal(h.gateway.callsFor(never.problem.key), 0, 'a pending item never starts after a cancel');

  const before = await h.service.detail(prepared.batchId, token());
  const repeated = await h.service.cancel(prepared.batchId, token());
  assert.equal(canonicalJson(repeated), canonicalJson(before), 'a repeated cancel is idempotent');
  assert.equal(repeated.revision, before.revision);
});

void test('restart recovery pauses a dead process run without any request, and resume is explicit', async () => {
  const target = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const third = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900C');
  const h = harness([target, second, third]);

  // A durable record left `running` by a process that no longer exists.
  let stored = batchOf([
    itemInput(third.problem.key),
    itemInput(target.problem.key),
    itemInput(second.problem.key),
  ], AT, 'material-batch-crashed');
  stored = startMaterialRefreshBatch(stored, LATER);
  stored = completeMaterialRefreshItem(beginMaterialRefreshItem(stored, 1, LATER), 1, resultOf('found'), LATER);
  stored = beginMaterialRefreshItem(stored, 0, LATER);
  await h.store.saveMaterialRefreshBatch(stored, null);
  // Recovery runs at activation time, which is necessarily after the crashed run's own last write.
  h.now.value = '2026-10-01T09:00:00.000Z';

  const fresh = h.makeService();
  const recovered = await fresh.recoverInterrupted(token());
  assert.deepEqual(recovered, ['material-batch-crashed']);
  assert.equal(h.gateway.calls.length, 0, 'recovery performs no platform work');

  const view = await fresh.detail('material-batch-crashed', token());
  assert.equal(view.status, 'paused');
  assert.deepEqual(
    view.items.map((item) => item.status),
    ['attention', 'completed', 'pending'],
  );
  assert.equal(view.items[0]?.failure?.code, 'interrupted');
  assert.equal(view.items[0]?.failure?.retryable, true);
  assert.equal(view.items[1]?.result?.editorial, 'found', 'the completed sibling survives recovery');
  assert.deepEqual(await fresh.recoverInterrupted(token()), [], 'a paused batch is not recovered twice');
  assert.equal(fresh.activeRuns, 0);

  // Only the two outstanding items run again: the interrupted one (index 0) and the pending one.
  h.gateway.script(third.problem.key, {
    kind: 'report',
    report: materialReport(third.problem.ref, foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body')),
  });
  h.gateway.script(second.problem.key, {
    kind: 'report',
    report: materialReport(second.problem.ref, foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body')),
  });
  const retried = await fresh.retryFailed('material-batch-crashed', token());
  assert.equal(retried.items[0]?.status, 'pending');
  await fresh.start('material-batch-crashed', token());
  const completed = await waitFor(
    async () => {
      const current = await fresh.detail('material-batch-crashed', token());
      return current.status === 'running' ? null : current;
    },
    'the recovered batch to complete after an explicit resume',
  );
  assert.equal(completed.status, 'completed');
  assert.equal(h.gateway.callsFor(target.problem.key), 0, 'the completed item was never repeated');
});

void test('close uses one shared deadline, leaves truthful state and never leaks a rejection', async () => {
  const scopes = ['A', 'B', 'C', 'D'].map((suffix) => fx.makeScope('codeforces', 'codeforces.com', 'alice', `1900${suffix}`));
  const h = harness(scopes, { closeWaitMs: 200 });
  const gates = scopes.map(() => deferred());
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');
  for (const [index, scope] of scopes.entries()) {
    const gate = gates[index];
    assert.ok(gate);
    h.gateway.script(scope.problem.key, { kind: 'gate', gate: gate.promise, report: materialReport(scope.problem.ref, found) });
  }
  const batchIds: string[] = [];
  for (const scope of scopes) {
    const prepared = await h.service.prepare({ items: [itemInput(scope.problem.key)] }, token());
    batchIds.push(prepared.batchId);
    await h.service.start(prepared.batchId, token());
  }
  await waitFor(
    async () => (h.gateway.calls.length === 1 ? true : null),
    'the first platform read to start',
  );

  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  let report: { readonly settled: readonly string[]; readonly outstanding: readonly string[] } | null = null;
  const startedAt = Date.now();
  try {
    report = await h.service.close();
    await sleep(20);
  } finally {
    process.off('unhandledRejection', listener);
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(report);
  assert.deepEqual(seen, [], 'disposal must not leak an unhandled rejection');
  assert.deepEqual(
    report.settled,
    [],
    'a queued run is chained behind the in-flight one, so it settles only after that run does',
  );
  assert.equal(report.outstanding.length, 4, 'the in-flight and queued runs are reported instead of abandoned');
  assert.equal(
    elapsed < 600,
    true,
    `close must be bounded by one shared deadline, not one per run (waited ${elapsed}ms)`,
  );
  assert.equal(h.gateway.calls.length, 1);

  for (const gate of gates) {
    gate.resolve();
  }
  const settled = await h.service.whenSettled();
  assert.deepEqual(settled.outstanding, []);
  const running = await h.service.detail(batchIds[0] as string, token());
  assert.equal(running.status, 'paused', 'an interrupted run leaves a resumable paused batch');
  assert.equal(running.items[0]?.failure?.code, 'interrupted');
  for (const batchId of batchIds.slice(1)) {
    const queued = await h.service.detail(batchId, token());
    assert.equal(queued.status, 'paused');
    assert.equal(queued.items[0]?.status, 'pending', 'a queued item that never started stays pending');
  }
});

// ---------------------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------------------

void test('the aggregate and its projections expose no model, analysis or budget surface', () => {
  const forbiddenExport = /model|llm|prompt|budget|analysis|reasoning|coaching|assess/iu;
  for (const [label, module] of [
    ['types', batchTypesModule],
    ['service', batchServiceModule],
  ] as const) {
    const names = Object.keys(module).filter((name) => forbiddenExport.test(name));
    assert.deepEqual(names, [], `the ${label} module must not export a model surface`);
  }
  const methods = Object.getOwnPropertyNames(MaterialRefreshBatchService.prototype).filter((name) =>
    forbiddenExport.test(name),
  );
  assert.deepEqual(methods, [], 'the service must not expose a model surface');

  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1A');
  const batch = batchOf([itemInput(alice.problem.key)]);
  const serialized = canonicalJson(batch);
  for (const key of ['"model"', '"provider"', '"prompt"', '"budget"', '"cookie"', '"statement"', '"rawTags"']) {
    assert.equal(serialized.includes(key), false, `a durable record must not be able to carry ${key}`);
  }
});

// ---------------------------------------------------------------------------------------
// Lifecycle: cancel linearization, the close barrier and detached late work
// ---------------------------------------------------------------------------------------

void test('a cancel during an in-flight item keeps its committed success completed and retries only the rest', async () => {
  const first = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const h = harness([first, second]);
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');
  const gate = deferred();
  // The platform read has already committed its snapshot and only its *report return* is held: the
  // exact window in which a cancel used to reinterpret a finished read as cancelled.
  h.gateway.script(first.problem.key, {
    kind: 'heldReport',
    gate: gate.promise,
    report: materialReport(first.problem.ref, found),
  });
  h.gateway.script(second.problem.key, { kind: 'report', report: materialReport(second.problem.ref, found) });

  const prepared = await h.service.prepare(
    { items: [itemInput(first.problem.key), itemInput(second.problem.key)] },
    token(),
  );
  await h.service.start(prepared.batchId, token());
  await waitFor(async () => (h.gateway.callsFor(first.problem.key) === 1 ? true : null), 'the first read to be in flight');

  const cancelled = await h.service.cancel(prepared.batchId, token());
  assert.equal(cancelled.status, 'cancelled', 'cancel answers without waiting for the platform read');
  assert.deepEqual(
    cancelled.items.map((item) => item.status),
    ['cancelled', 'cancelled'],
    'the durable cancel transition stops the in-flight item and every pending sibling',
  );
  gate.resolve();
  await h.service.whenSettled();

  const settled = await h.service.detail(prepared.batchId, token());
  assert.equal(settled.status, 'cancelled');
  assert.deepEqual(
    settled.items.map((item) => item.status),
    ['completed', 'cancelled'],
    'the committed success wins as completed; the never-started sibling stays cancelled',
  );
  assert.equal(settled.items[0]?.result?.editorial, 'found');
  assert.equal(h.gateway.callsFor(first.problem.key), 1);
  assert.equal(h.gateway.callsFor(second.problem.key), 0, 'a sibling that never started is never fetched');

  const retried = await h.service.retryFailed(prepared.batchId, token());
  assert.equal(retried.status, 'paused');
  assert.deepEqual(
    retried.items.map((item) => item.status),
    ['completed', 'pending'],
    'retry resets only the cancelled sibling',
  );
  await h.service.start(prepared.batchId, token());
  const done = await waitFor(
    async () => {
      const view = await h.service.detail(prepared.batchId, token());
      return view.status === 'running' ? null : view;
    },
    'the retried batch to complete',
  );
  assert.equal(done.status, 'completed');
  assert.equal(h.gateway.callsFor(first.problem.key), 1, 'the committed item is never fetched again');
  assert.equal(h.gateway.callsFor(second.problem.key), 1);
});

void test('close is a synchronous barrier that refuses every later mutation', async () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const h = harness([alice, second], { closeWaitMs: 50 });
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');
  const gate = deferred();
  h.gateway.script(alice.problem.key, {
    kind: 'gate',
    gate: gate.promise,
    report: materialReport(alice.problem.ref, found),
  });
  h.gateway.script(second.problem.key, { kind: 'report', report: materialReport(second.problem.ref, found) });

  const prepared = await h.service.prepare({ items: [itemInput(alice.problem.key)] }, token());
  await h.service.start(prepared.batchId, token());
  await waitFor(async () => (h.gateway.calls.length === 1 ? true : null), 'the owned read to start');

  const closing = h.service.close();
  // The barrier is up from the first synchronous statement of close: none of these can claim work,
  // read the store or reach a platform.
  await assert.rejects(
    h.service.prepare({ items: [itemInput(second.problem.key)] }, token()),
    isDomain('invalid_transition'),
  );
  await assert.rejects(h.service.start(prepared.batchId, token()), isDomain('invalid_transition'));
  await assert.rejects(h.service.retryFailed(prepared.batchId, token()), isDomain('invalid_transition'));
  await assert.rejects(h.service.cancel(prepared.batchId, token()), isDomain('invalid_transition'));
  await assert.rejects(h.service.recoverInterrupted(token()), isDomain('invalid_transition'));

  gate.resolve();
  const report = await closing;
  await h.service.whenSettled();
  assert.equal(h.store.batches.size, 1, 'a refused prepare wrote no second batch');
  assert.deepEqual(report.outstanding, []);
  assert.equal(h.gateway.callsFor(second.problem.key), 0, 'no refused mutation reached a platform');
  const durable = await h.service.detail(prepared.batchId, token());
  assert.equal(durable.status, 'paused');
  assert.equal(durable.items[0]?.failure?.code, 'interrupted', 'the cancelled read is recorded as interrupted');
  assert.equal(durable.items[0]?.failure?.retryable, true);
});

void test('a start that is mid-CAS when close begins is owned before it returns, so close stops it', async () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const h = harness([alice], { closeWaitMs: 50 });
  const prepared = await h.service.prepare({ items: [itemInput(alice.problem.key)] }, token());

  let releaseCas!: () => void;
  const heldCas = new Promise<void>((resolve) => {
    releaseCas = resolve;
  });
  let enteredCas!: () => void;
  const casEntered = new Promise<void>((resolve) => {
    enteredCas = resolve;
  });
  h.store.onSave = async (batch) => {
    if (batch.status === 'running') {
      enteredCas();
      await heldCas;
    }
  };

  const starting = h.service.start(prepared.batchId, token());
  await casEntered;
  // close() begins while the durable `running` CAS is still in flight. Ownership is installed inside
  // that same serialized critical section, so close's drain observes the run and cancels it instead
  // of letting platform work start behind the disposal.
  const closing = h.service.close();
  releaseCas();
  const view = await starting;
  assert.equal(view.status, 'running');
  const report = await closing;
  assert.deepEqual(report.outstanding, [], 'the run close cancelled settled inside the deadline');
  assert.deepEqual(report.settled, [prepared.batchId]);
  assert.equal(h.gateway.calls.length, 0, 'the run close cancelled never reached a platform');
  assert.equal(h.service.activeRuns, 0);
  const durable = await h.store.getMaterialRefreshBatch(prepared.batchId);
  assert.equal(durable?.status, 'paused', 'the cancelled run left a truthful paused batch');
  // The run had already claimed its first item when the cancellation reached its token, so the
  // truthful record is a retryable interruption — never a running item, and never platform IO.
  assert.equal(durable?.items[0]?.status, 'attention');
  assert.equal(durable?.items[0]?.failure?.code, 'interrupted');
  assert.equal(durable?.items[0]?.failure?.retryable, true);
});

void test('close detaches a refresh that ignores cancellation without touching a closed store', async () => {
  const alice = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const h = harness([alice], { closeWaitMs: 50 });
  const found = foundResult('editorial-1', 'https://codeforces.com/blog/entry/1', 'body');
  const gate = deferred();
  h.gateway.script(alice.problem.key, {
    kind: 'stubborn',
    gate: gate.promise,
    report: materialReport(alice.problem.ref, found),
  });

  const prepared = await h.service.prepare({ items: [itemInput(alice.problem.key)] }, token());
  await h.service.start(prepared.batchId, token());
  await waitFor(
    async () => (h.gateway.callsFor(alice.problem.key) === 1 ? true : null),
    'the stubborn read to start',
  );

  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    const startedAt = Date.now();
    const report = await h.service.close();
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(report.outstanding, [prepared.batchId], 'the non-cooperative read is reported, not awaited');
    assert.ok(elapsed < 1000, `close must be bounded by its one shared deadline (waited ${elapsed}ms)`);
    const interrupted = await h.service.detail(prepared.batchId, token());
    assert.equal(interrupted.status, 'paused', 'the durable state is truthful before the late answer arrives');
    assert.equal(interrupted.items[0]?.failure?.code, 'interrupted');
    assert.equal(interrupted.items[0]?.failure?.retryable, true);

    const saves = h.store.saves.length;
    h.store.closed = true;
    gate.resolve();
    await h.service.whenSettled();
    assert.equal(h.store.saves.length, saves, 'a detached late outcome writes nothing');
    assert.deepEqual(h.store.callsAfterClose, [], 'a detached run never touches the closed store');
    assert.deepEqual(seen, [], 'disposal leaks no unhandled rejection');
  } finally {
    process.off('unhandledRejection', listener);
  }
});

void test('a direct start of a stale unowned running batch pauses it and makes no request', async () => {
  const target = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const h = harness([target]);
  let stale = batchOf([itemInput(target.problem.key)], AT, 'material-batch-stale');
  stale = startMaterialRefreshBatch(stale, LATER);
  stale = beginMaterialRefreshItem(stale, 0, LATER);
  await h.store.saveMaterialRefreshBatch(stale, null);
  // Recovery happens after the crashed run's last write, so the clock moves forward past it.
  h.now.value = '2026-10-01T09:00:00.000Z';

  const fresh = h.makeService();
  const view = await fresh.start('material-batch-stale', token());
  assert.equal(view.status, 'paused', 'start never resumes a dead process run in the same action');
  assert.equal(view.items[0]?.status, 'attention');
  assert.equal(view.items[0]?.failure?.code, 'interrupted');
  assert.equal(view.items[0]?.failure?.retryable, true);
  assert.equal(h.gateway.calls.length, 0, 'recovering a stale run makes no network request');
  assert.equal(fresh.activeRuns, 0, 'no run was claimed for the paused view');
  const durable = await h.store.getMaterialRefreshBatch('material-batch-stale');
  assert.equal(durable?.status, 'paused');
  assert.notEqual(durable?.status, 'running', 'a stale running row can never remain running');

  // A second direct start cannot claim the interrupted work either: the row is paused with nothing
  // pending, and the pure rules refuse to represent a running batch with no work left, so the start
  // is refused instead of inventing a run for an interrupted item.
  await assert.rejects(fresh.start('material-batch-stale', token()), isDomain('invalid_input'));
  assert.equal(h.gateway.calls.length, 0);
  const stillPaused = await fresh.detail('material-batch-stale', token());
  assert.equal(stillPaused.status, 'paused', 'the refused start changed nothing');

  // Only an explicit retry plus a start performs the read.
  h.gateway.script(target.problem.key, {
    kind: 'report',
    report: materialReport(target.problem.ref, foundResult('e-1', 'https://codeforces.com/blog/entry/1', 'body')),
  });
  const retried = await fresh.retryFailed('material-batch-stale', token());
  assert.deepEqual(
    retried.items.map((item) => item.status),
    ['pending'],
  );
  await fresh.start('material-batch-stale', token());
  const completed = await waitFor(
    async () => {
      const current = await fresh.detail('material-batch-stale', token());
      return current.status === 'running' ? null : current;
    },
    'the explicitly resumed batch to complete',
  );
  assert.equal(completed.status, 'completed');
  assert.equal(h.gateway.callsFor(target.problem.key), 1);
});
