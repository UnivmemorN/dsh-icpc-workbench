/**
 * Durable bulk platform-material refresh orchestration (Sprint Contract 34A; lifecycle, cooldown and
 * schema corrected by 34A2).
 *
 * The service turns the pure batch records of `./material-refresh-batch-types.js` into a durable
 * operation: prepare is local and free, start claims a run and performs **platform IO only** through
 * the accepted single-problem `ImportService.refreshMaterial` path, and cancel/retry are explicit
 * state transitions. Nothing in this module can name a model, a budget or a model attempt — a bulk
 * material refresh never becomes a paid tag analysis.
 *
 * ## What each operation guarantees
 *
 * - **`prepare`** proves every item against the store and then writes one batch in one transaction.
 *   A problem that is not stored under its canonical key, and a named account that is missing or
 *   belongs to another source instance, are refused with `missing_reference` before the row exists, so
 *   no refusal can leave a batch behind or reach a platform. No platform request happens, and the
 *   caller supplies 1..100 explicit items.
 * - **`start`** moves `prepared`/`paused` to `running` durably and returns promptly, then runs the
 *   batch as owned background work with a **global concurrency of one**. Ownership of the run is
 *   claimed inside the very same serialized critical section as the durable `running` compare-and-set,
 *   before the start request can return, so a disposal that begins meanwhile always sees the run it
 *   must cancel. A `running` batch this process does **not** own is a dead process's remnant: `start`
 *   durably pauses it with its in-flight item retryable and returns it, and makes **no** network
 *   request — only an explicit retry plus a second start continues that work. Every item resolves its
 *   adapter and its account *before* the first request of that item: a named account must exist in
 *   the store and belong to the problem's own source instance, so an invalid or foreign account is a
 *   recorded failure and never a silent anonymous read.
 * - **`cancel`** reaches the active platform token, durably marks every non-completed item
 *   `cancelled`, keeps completed items exactly as they were, and is idempotent. It never waits for a
 *   non-cooperative platform read: a read that had already committed its snapshot when the cancel
 *   landed restores that item to `completed` from its own attempt, because the material really exists
 *   and a retry must not repeat committed IO.
 * - **`retryFailed`** resets only non-completed attention/cancelled items to `pending`; completed
 *   items are never repeated and a completed batch is returned unchanged. A batch cancelled before
 *   its first start returns to `prepared`, one cancelled after a start to `paused`, and the caller
 *   then explicitly starts again.
 * - **`recoverInterrupted`** is the activation hook: a batch left `running` by a dead process becomes
 *   `paused` with its in-flight item recorded as retryable `interrupted` attention, and **no network
 *   request is made**.
 * - **`close`** begins with a synchronous closing barrier — once it ran, no prepare/start/retry/
 *   cancel/recover may claim new work — drains the mutation claims that were already queued, cancels
 *   every registered run and waits **one shared finite deadline** for them. A run that outlives that
 *   deadline is detached: it can no longer write through this service or touch a store the
 *   composition is closing, and its batch is durably interrupted as paused/attention. `close` never
 *   rejects and never leaks an unhandled rejection.
 *
 * ## Failure discipline
 *
 * Every failure is sanitized into the item: a stable code, `retryable`, the declared retry delay and
 * the attempt count. No `detail`, `sample`, exception text, response body, statement, raw tag or
 * editorial body is persisted or returned. A successful `absent` editorial observation is a
 * **completed** item; an operational failure is retryable attention and is never reinterpreted as
 * absence. Each attempt calls the refresh service exactly once, so the accepted adapter gates — the
 * Luogu source FIFO/pacing gate, Codeforces transport pacing and the optimistic snapshot-head check —
 * are preserved per item, and the batch layer adds no hidden retry.
 */
import {
  DomainError,
  assertIsoTimestamp,
  canonicalJson,
  createCancellationSource,
  invariant,
  parseProblemKey,
  problemKey,
  throwIfCancelled,
  type Account,
  type CancellationToken,
} from '../domain/index.js';
import { isPlatformError } from './platform-errors.js';
import type { MirrorEditorialPort } from './cf-mirror-editorial.js';
import type { PlatformAdapter, PlatformLimits, TrainingStore } from './ports.js';
import type { ImportService } from './import-service.js';
import {
  DEFAULT_MATERIAL_REFRESH_BATCH_LIST_LIMIT,
  MAX_MATERIAL_REFRESH_BATCH_LIST_LIMIT,
  beginMaterialRefreshItem,
  cancelMaterialRefreshBatch,
  classifyMaterialRefreshReport,
  completeCancelledMaterialRefreshItem,
  completeMaterialRefreshItem,
  createMaterialRefreshBatch,
  failMaterialRefreshItem,
  failureOf,
  fromPlatformError,
  interruptMaterialRefreshBatch,
  materialRefreshBatchSummaryView,
  materialRefreshBatchView,
  retryFailedMaterialRefreshBatch,
  settleMaterialRefreshBatchRun,
  startMaterialRefreshBatch,
  type MaterialRefreshBatch,
  type MaterialRefreshBatchItem,
  type MaterialRefreshBatchItemInput,
  type MaterialRefreshItemResult,
  type MaterialRefreshBatchListView,
  type MaterialRefreshBatchStatus,
  type MaterialRefreshBatchView,
} from './material-refresh-batch-types.js';
import type { RefreshMaterialReport } from './import-types.js';

/** Default grace period disposal waits for owned work before reporting it outstanding. */
export const DEFAULT_MATERIAL_BATCH_CLOSE_WAIT_MS = 5000;

/** Upper bound of {@link MaterialRefreshBatchServiceOptions.closeWaitMs}. */
export const MAX_MATERIAL_BATCH_CLOSE_WAIT_MS = 60_000;

export interface MaterialRefreshBatchServiceOptions {
  readonly store: TrainingStore;
  /** The accepted single-problem refresh path; the batch never duplicates its merge or gate logic. */
  readonly imports: ImportService;
  /**
   * Resolve the official adapter of one source instance.
   *
   * Composition supplies this. The service proves the returned adapter is bound to the requested
   * instance before any request, and the caller of this module never names a URL.
   */
  readonly adapterFor: (sourceInstanceId: string) => Promise<PlatformAdapter>;
  /** Explicit platform limits for this activation; read per attempt so a settings change is honoured. */
  readonly limits: () => Promise<PlatformLimits>;
  /**
   * The exact-equivalent-Codeforces editorial port of one source instance, or `null` when this
   * composition has none. It is passed straight to the refresh service, which derives the equivalent
   * reference from the target's own stored identity — a request can never choose a source.
   */
  readonly mirrorEditorialFor?: (sourceInstanceId: string) => Promise<MirrorEditorialPort | null>;
  readonly now: () => string;
  /** Injected id source, called with a prefix (`material-batch`). */
  readonly uniqueId: (prefix: string) => string;
  /** Bounded grace period {@link MaterialRefreshBatchService.close} waits; defaults to 5s. */
  readonly closeWaitMs?: number;
  /** Observer for failures that are sanitized into an item; never changes the durable outcome. */
  readonly onInternalError?: (error: unknown) => void;
}

/** What one batch's durable state is; the caller may see exactly this. */
export type MaterialRefreshBatchControlResult = MaterialRefreshBatchView;

/** Request of one list read; both fields are bounded and optional. */
export interface MaterialRefreshBatchListRequest {
  /** Keep only batches in this status; `null`/absent reads every status. */
  readonly status?: MaterialRefreshBatchStatus | null;
  /** Page size within `1..50`; defaults to 20. */
  readonly limit?: number;
}

/** Outcome of one close/whenSettled call: which owned runs ended and which are still in flight. */
export interface MaterialRefreshBatchCloseReport {
  readonly settled: readonly string[];
  readonly outstanding: readonly string[];
}

/** One owned background run. `settled` is set when its promise ends, however it ended. */
interface OwnedRun {
  readonly source: ReturnType<typeof createCancellationSource>;
  promise: Promise<void>;
  settled: boolean;
  /**
   * Set once {@link MaterialRefreshBatchService.close} gave up waiting for this run (its one shared
   * deadline passed). A detached run performs no further store read or write, so a late platform
   * promise can neither resurrect work nor touch a store the composition is about to close.
   */
  detached: boolean;
}

/** Result of one item attempt; `cancelled` is a status, not a failure. */
type ItemOutcome =
  | { readonly kind: 'completed'; readonly result: MaterialRefreshItemResult }
  | {
      readonly kind: 'failed';
      readonly failure: ReturnType<typeof failureOf>;
      readonly result: MaterialRefreshItemResult | null;
    }
  | { readonly kind: 'cancelled' };

/**
 * Durable bulk material-refresh batches over one store.
 *
 * Construct once per plugin with the shared store, the shared refresh service and the composition's
 * adapter resolver, then call one operation per user action. The service keeps no batch cache: every
 * durable value is read back from the store, and its two in-process queues exist only to serialize
 * durable read-modify-write steps and to hold the global platform concurrency at one.
 */
export class MaterialRefreshBatchService {
  private readonly store: TrainingStore;
  private readonly imports: ImportService;
  private readonly adapterFor: (sourceInstanceId: string) => Promise<PlatformAdapter>;
  private readonly limits: () => Promise<PlatformLimits>;
  private readonly mirrorEditorialFor: ((sourceInstanceId: string) => Promise<MirrorEditorialPort | null>) | null;
  private readonly now: () => string;
  private readonly uniqueId: (prefix: string) => string;
  private readonly closeWaitMs: number;
  private readonly onInternalError: ((error: unknown) => void) | null;

  /** Serializes every durable read-modify-write of this service, so a CAS can never race itself. */
  private mutations: Promise<unknown> = Promise.resolve();
  /** Global platform concurrency of one: one batch's run at a time, FIFO. */
  private runs: Promise<void> = Promise.resolve();
  private readonly owned = new Map<string, OwnedRun>();
  /**
   * Set synchronously by the first statement of {@link MaterialRefreshBatchService.close}. Every
   * mutation checks it both before queueing and inside its serialized critical section, so a claim
   * that was already queued when disposal began refuses instead of claiming work behind it.
   */
  private closing = false;

  constructor(options: MaterialRefreshBatchServiceOptions) {
    invariant(
      options !== null && typeof options === 'object' && options.store !== null && typeof options.store === 'object',
      'unfilled_settings',
      'MaterialRefreshBatchService requires an explicit store',
    );
    invariant(
      options.imports !== null &&
        typeof options.imports === 'object' &&
        typeof options.imports.refreshMaterial === 'function',
      'unfilled_settings',
      'MaterialRefreshBatchService requires the accepted ImportService',
    );
    invariant(
      typeof options.adapterFor === 'function',
      'unfilled_settings',
      'MaterialRefreshBatchService requires an adapterFor(sourceInstanceId) resolver',
    );
    invariant(
      typeof options.limits === 'function',
      'unfilled_settings',
      'MaterialRefreshBatchService requires explicit platform limits',
    );
    invariant(
      typeof options.now === 'function' && typeof options.uniqueId === 'function',
      'unfilled_settings',
      'MaterialRefreshBatchService requires an injected clock and id source',
    );
    const closeWaitMs = options.closeWaitMs ?? DEFAULT_MATERIAL_BATCH_CLOSE_WAIT_MS;
    invariant(
      Number.isInteger(closeWaitMs) && closeWaitMs >= 0 && closeWaitMs <= MAX_MATERIAL_BATCH_CLOSE_WAIT_MS,
      'invalid_input',
      `closeWaitMs must be an integer within 0..${MAX_MATERIAL_BATCH_CLOSE_WAIT_MS}`,
      { closeWaitMs },
    );
    this.store = options.store;
    this.imports = options.imports;
    this.adapterFor = options.adapterFor;
    this.limits = options.limits;
    this.mirrorEditorialFor = options.mirrorEditorialFor ?? null;
    this.now = options.now;
    this.uniqueId = options.uniqueId;
    this.closeWaitMs = closeWaitMs;
    this.onInternalError = options.onInternalError ?? null;
  }

  /**
   * Prepare one batch: local, free and durable.
   *
   * The request is only a list of explicit items — there is deliberately no "all filtered results"
   * query, so one request can never turn into an unbounded selection. Duplicate keys, an unknown
   * credential-like field, a non-canonical problem key, a non-http tutorial URL and a URL carrying
   * embedded credentials are refused by the aggregate before anything is written. Then, still before
   * the batch row exists, every item is resolved against the store: a problem that is not stored (or
   * whose stored reference does not match its canonical key) and a named account that is missing or
   * belongs to another source instance are refused with `missing_reference`. A refusal therefore
   * writes no batch and can start no platform request — this feature refreshes stored material, it is
   * not an importer of arbitrary remote problems.
   */
  async prepare(
    request: { readonly items: readonly MaterialRefreshBatchItemInput[] },
    token: CancellationToken,
  ): Promise<MaterialRefreshBatchView> {
    throwIfCancelled(token);
    this.requireOpen();
    invariant(
      request !== null && typeof request === 'object' && !Array.isArray(request),
      'invalid_input',
      'material batch prepare requires a request object',
    );
    invariant(Array.isArray(request.items), 'invalid_input', 'material batch prepare requires an items array');
    const batch = createMaterialRefreshBatch({
      batchId: this.uniqueId('material-batch'),
      items: request.items,
      createdAt: assertIsoTimestamp('preparedAt', this.now()),
    });
    throwIfCancelled(token);
    return this.exclusive(async () => {
      this.requireOpen();
      await this.assertPreparable(batch, token);
      throwIfCancelled(token);
      // Recheck inside the critical section: a close that began while the store was being read must
      // not end up with a batch written behind its own drain.
      this.requireOpen();
      const revision = await this.store.saveMaterialRefreshBatch(batch, null);
      return materialRefreshBatchView({ ...batch, revision });
    });
  }

  /**
   * Prove every item names a stored problem and, when it names an account, a stored account of that
   * problem's own source instance.
   *
   * Runs before the batch row is written, so a refusal leaves nothing durable and no run can ever be
   * claimed for it. The same proofs run again per attempt, because a row may be removed after the
   * batch was prepared. A refusal never names an account id — that id encodes a handle.
   */
  private async assertPreparable(batch: MaterialRefreshBatch, token: CancellationToken): Promise<void> {
    for (const item of batch.items) {
      token.throwIfCancelled();
      const ref = parseProblemKey(item.problemKey);
      const stored = await this.store.getProblem(item.problemKey);
      token.throwIfCancelled();
      invariant(
        stored !== null && problemKey(stored.ref) === item.problemKey,
        'missing_reference',
        `material batch problem is not stored under its canonical key (${ref.sourceInstanceId})`,
        { problemKey: item.problemKey },
      );
      if (item.accountId === null) {
        continue;
      }
      const account: Account | null = await this.store.getAccount(item.accountId);
      token.throwIfCancelled();
      invariant(
        account !== null && account.sourceInstanceId === ref.sourceInstanceId,
        'missing_reference',
        `material batch account is not stored for the problem's own source instance (${ref.sourceInstanceId})`,
        { problemKey: item.problemKey },
      );
    }
  }

  /**
   * Start or resume one batch and return promptly.
   *
   * The durable transition to `running` happens inside the caller's request; the actual work is owned
   * background work, serialized with every other batch so the global platform concurrency stays at
   * one. Ownership is installed **inside the same serialized critical section as that compare-and-set**
   * and before this request can return, so a disposal that begins meanwhile observes the run and
   * cancels it instead of leaving a durably `running` batch nobody owns.
   *
   * A batch that is `running` but is not owned by this process (a remnant of a dead process this
   * plugin instance never recovered) is made truthful first: its in-flight item becomes retryable
   * `interrupted` attention, the batch becomes `paused`, and the paused view is returned **without any
   * network request**. Continuing that work is an explicit caller decision — retry, then start again.
   */
  async start(batchId: string, token: CancellationToken): Promise<MaterialRefreshBatchView> {
    throwIfCancelled(token);
    this.requireOpen();
    const claim = await this.exclusive(async () => {
      this.requireOpen();
      const batch = await this.requireBatch(batchId);
      if (batch.status === 'completed' || batch.status === 'cancelled') {
        // Terminal: no run may be claimed for a settled view, so a start can never resurrect work.
        return { view: materialRefreshBatchView(batch), started: false };
      }
      if (batch.status === 'running') {
        if (this.isOwned(batchId)) {
          // This process already runs it; a second start claims nothing.
          return { view: materialRefreshBatchView(batch), started: false };
        }
        const interrupted = interruptMaterialRefreshBatch(batch, this.now());
        const revision = await this.store.saveMaterialRefreshBatch(interrupted, batch.revision);
        return { view: materialRefreshBatchView({ ...interrupted, revision }), started: false };
      }
      // Recheck before the durable claim, so a close that began while the row was read refuses here.
      this.requireOpen();
      const running = startMaterialRefreshBatch(batch, this.now());
      const revision = await this.store.saveMaterialRefreshBatch(running, batch.revision);
      // Ownership is claimed in this same critical section, immediately after the durable `running`
      // CAS: close() drains the queued claims before it looks at the owned runs, so a run installed
      // here can never slip past the cancellation.
      this.ensureRun(batchId);
      return { view: materialRefreshBatchView({ ...running, revision }), started: true };
    });
    if (claim.started) {
      const run = this.owned.get(batchId);
      if (token.cancelled) {
        // A start whose request was cancelled does not keep platform work running behind a failed
        // answer: the run just claimed is stopped and the batch is left truthfully `paused`, exactly
        // like a disposal, so the caller may resume or retry explicitly.
        run?.source.cancel('material refresh batch start cancelled');
        if (run !== undefined) {
          await this.interruptOwned(run, batchId);
        }
      }
    }
    throwIfCancelled(token);
    return claim.view;
  }

  /** Read one batch: a local read, never a platform request. */
  async detail(batchId: string, token: CancellationToken): Promise<MaterialRefreshBatchView> {
    throwIfCancelled(token);
    return materialRefreshBatchView(await this.requireBatch(batchId));
  }

  /**
   * Read a bounded page of batch summaries, newest first.
   *
   * The item list is deliberately absent: a caller that needs the items names one batch through
   * {@link MaterialRefreshBatchService.detail}. `total` is the number of stored batches matching the
   * filter, so a caller can tell a page from the whole set.
   */
  async list(request: MaterialRefreshBatchListRequest, token: CancellationToken): Promise<MaterialRefreshBatchListView> {
    throwIfCancelled(token);
    invariant(
      request === null || request === undefined || (typeof request === 'object' && !Array.isArray(request)),
      'invalid_input',
      'material batch list requires a request object',
    );
    const status = request?.status ?? null;
    const limit = request?.limit ?? DEFAULT_MATERIAL_REFRESH_BATCH_LIST_LIMIT;
    invariant(
      Number.isInteger(limit) && limit >= 1 && limit <= MAX_MATERIAL_REFRESH_BATCH_LIST_LIMIT,
      'invalid_input',
      `material batch list limit must be an integer within 1..${MAX_MATERIAL_REFRESH_BATCH_LIST_LIMIT}`,
      { limit },
    );
    const stored = await this.store.listMaterialRefreshBatches(status);
    throwIfCancelled(token);
    const newestFirst = [...stored].reverse();
    return {
      batches: newestFirst.slice(0, limit).map(materialRefreshBatchSummaryView),
      total: stored.length,
      limit,
    };
  }

  /**
   * Cancel one batch: reach the active platform token, then durably stop.
   *
   * Every item that is not completed becomes `cancelled`, completed items are preserved exactly, and
   * no pending item can start afterwards. The durable transition is written **without** waiting for
   * the in-flight platform read — a non-cooperative adapter must never hold a user's cancel open —
   * which is exactly why the worker restores a committed success afterwards: a read whose snapshot was
   * already written when the cancel landed comes back as `completed`, so retry never repeats committed
   * platform IO. Repeated cancel is idempotent — a second call finds the batch already cancelled and
   * advances nothing. A `completed` batch is returned unchanged.
   */
  async cancel(batchId: string, token: CancellationToken): Promise<MaterialRefreshBatchView> {
    throwIfCancelled(token);
    this.requireOpen();
    const owned = this.owned.get(batchId);
    // Reaching the live token first is what stops the in-flight platform request (and therefore every
    // later one): the adapter bridges this token to its own abort signal.
    owned?.source.cancel('material refresh batch cancelled');
    return this.exclusive(async () => {
      this.requireOpen();
      const batch = await this.requireBatch(batchId);
      if (batch.status === 'completed') {
        return materialRefreshBatchView(batch);
      }
      const cancelled = cancelMaterialRefreshBatch(batch, this.now());
      if (canonicalJson(cancelled) === canonicalJson(batch)) {
        return materialRefreshBatchView(batch);
      }
      const revision = await this.store.saveMaterialRefreshBatch(cancelled, batch.revision);
      return materialRefreshBatchView({ ...cancelled, revision });
    });
  }

  /**
   * Reset the non-completed attention/cancelled items of one batch to `pending`.
   *
   * Completed items are never repeated, a completed batch is returned unchanged, and the caller must
   * explicitly start the batch again — retry never resumes work on its own.
   */
  async retryFailed(batchId: string, token: CancellationToken): Promise<MaterialRefreshBatchView> {
    throwIfCancelled(token);
    this.requireOpen();
    const owned = this.owned.get(batchId);
    invariant(
      owned === undefined || owned.settled,
      'invalid_transition',
      `material batch ${batchId} is still running; cancel or wait before retrying failures`,
      { batchId },
    );
    return this.exclusive(async () => {
      this.requireOpen();
      const batch = await this.requireBatch(batchId);
      const retried = retryFailedMaterialRefreshBatch(batch, this.now());
      if (canonicalJson(retried) === canonicalJson(batch)) {
        return materialRefreshBatchView(batch);
      }
      const revision = await this.store.saveMaterialRefreshBatch(retried, batch.revision);
      return materialRefreshBatchView({ ...retried, revision });
    });
  }

  /**
   * Activation recovery: make every `running` batch of a dead process truthful, without any request.
   *
   * A batch owned by this process is left alone (an activation that recovers its own live run would
   * interrupt work that is still making progress). Returns the recovered batch ids so the composition
   * can log them without exposing any stored body.
   */
  async recoverInterrupted(token: CancellationToken): Promise<readonly string[]> {
    throwIfCancelled(token);
    this.requireOpen();
    return this.exclusive(async () => {
      this.requireOpen();
      const running = await this.store.listMaterialRefreshBatches('running');
      throwIfCancelled(token);
      const recovered: string[] = [];
      for (const batch of running) {
        if (this.isOwned(batch.batchId)) {
          continue;
        }
        const interrupted = interruptMaterialRefreshBatch(batch, this.now());
        await this.store.saveMaterialRefreshBatch(interrupted, batch.revision);
        recovered.push(batch.batchId);
      }
      return recovered;
    });
  }

  /** Number of batches this process currently owns; diagnostics only. */
  get activeRuns(): number {
    return [...this.owned.values()].filter((run) => !run.settled).length;
  }

  /**
   * Close the service: establish the barrier, cancel every owned run, wait one shared deadline, then
   * leave truthful durable state and detach whatever outlived it.
   *
   * The closing flag is set by the **first synchronous statement**, so a prepare/start/retry/cancel/
   * recover that arrives after that instant is refused before it can claim anything; the drain that
   * follows makes a claim already queued observe the flag too, and therefore also sees the run this
   * service installed with its durable `running` CAS. Every registered run is then cancelled and
   * waited for against **one shared finite deadline** (not one per run), so disposal is bounded by
   * `closeWaitMs` however many runs are outstanding. A run that did not settle inside the deadline is
   * detached and its batch is interrupted durably (an in-flight item becomes retryable `attention`,
   * the batch becomes `paused`): the late promise can never write through this service or touch a
   * store the composition is about to close, and it can never surface as an unhandled rejection
   * because every owned promise is observed. `close` itself never rejects.
   */
  async close(): Promise<MaterialRefreshBatchCloseReport> {
    if (this.closing) {
      // A repeated close waits once more on the runs it already cancelled.
      return this.awaitRuns([...this.owned.entries()], this.closeWaitMs);
    }
    this.closing = true;
    // Drain the mutation claims that were already queued: a start that committed its durable
    // `running` CAS installs its run inside that same critical section, so after this await no
    // registered run can appear behind the cancellation below.
    await this.exclusive(async () => undefined);
    const owned = [...this.owned.entries()];
    for (const [, run] of owned) {
      run.source.cancel('plugin disposal');
    }
    const report = await this.awaitRuns(owned, this.closeWaitMs);
    for (const [batchId, run] of owned) {
      if (run.settled) {
        continue;
      }
      // Detach first, then interrupt durably: from here the late promise is inert, and the durable
      // state is written by this service, which is the only writer still allowed to touch the store.
      run.detached = true;
      await this.interruptDurably(batchId);
    }
    return report;
  }

  /** Wait for every currently owned run to settle, however long it takes. */
  async whenSettled(): Promise<MaterialRefreshBatchCloseReport> {
    return this.awaitRuns([...this.owned.entries()], null);
  }

  // -------------------------------------------------------------------------------------
  // Owned background work
  // -------------------------------------------------------------------------------------

  /**
   * Queue one batch's run behind every earlier run (global concurrency one) and track it.
   *
   * Called inside the serialized critical section that performed the durable `running` CAS, so the
   * ownership it records cannot race that claim. A settled entry is removed, so the map holds exactly
   * the live runs: it can never grow without bound over a long activation, `activeRuns`/`close`/
   * `whenSettled` observe only real work, and a later start of the same batch claims a fresh run
   * instead of inheriting a finished one.
   */
  private ensureRun(batchId: string): void {
    if (this.owned.has(batchId)) {
      return;
    }
    const source = createCancellationSource();
    const run: OwnedRun = { source, promise: Promise.resolve(), settled: false, detached: false };
    run.promise = this.sequence(() => this.runBatch(run, batchId, source.token));
    this.owned.set(batchId, run);
    void run.promise.then(
      () => {
        run.settled = true;
        this.releaseRun(batchId, run);
      },
      (error: unknown) => {
        run.settled = true;
        this.releaseRun(batchId, run);
        this.report(error);
      },
    );
  }

  /** Drop one finished run; a newer run of the same batch (if any) is never removed. */
  private releaseRun(batchId: string, run: OwnedRun): void {
    if (this.owned.get(batchId) === run) {
      this.owned.delete(batchId);
    }
  }

  /** Append one run to the global FIFO; a finished run never blocks the next one. */
  private sequence(work: () => Promise<void>): Promise<void> {
    const next = this.runs.then(work, work);
    this.runs = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Run one batch to its next stopping point.
   *
   * The loop resolves the next pending item, records the attempt durably, performs exactly one
   * platform refresh outside the mutation queue (so cancel can always write) and settles the item. It
   * never throws: an unexpected failure is reported and converted into an interruption so the durable
   * state stays readable. A detached run (disposal gave up waiting) stops before its next store touch.
   */
  private async runBatch(run: OwnedRun, batchId: string, token: CancellationToken): Promise<void> {
    try {
      for (;;) {
        if (run.detached) {
          return;
        }
        if (token.cancelled) {
          await this.interruptOwned(run, batchId);
          return;
        }
        const step = await this.exclusive(async () => {
          if (run.detached) {
            return null;
          }
          const batch = await this.store.getMaterialRefreshBatch(batchId);
          if (batch === null || batch.status !== 'running') {
            return null;
          }
          const index = batch.items.findIndex((item) => item.status === 'pending');
          if (index < 0) {
            const settled = settleMaterialRefreshBatchRun(batch, this.now());
            if (canonicalJson(settled) !== canonicalJson(batch)) {
              await this.store.saveMaterialRefreshBatch(settled, batch.revision);
            }
            return null;
          }
          const begun = beginMaterialRefreshItem(batch, index, this.now());
          await this.store.saveMaterialRefreshBatch(begun, batch.revision);
          const item = begun.items[index];
          invariant(item !== undefined, 'missing_reference', 'material batch item disappeared', { batchId, index });
          return { index, item };
        });
        if (step === null) {
          return;
        }
        const outcome = await this.runItem(run, step.item);
        if (run.detached) {
          return;
        }
        await this.exclusive(async () => {
          if (run.detached) {
            return;
          }
          const batch = await this.store.getMaterialRefreshBatch(batchId);
          if (batch === null) {
            return;
          }
          const at = this.now();
          if (batch.status === 'cancelled') {
            // The caller cancelled while this attempt was in flight. `refreshMaterial` only returns
            // after the material was committed (or reused), so a completed outcome is the truth the
            // snapshot already wrote and must win as `completed`; every other outcome stays exactly
            // as the cancel transition recorded it, and no pending sibling is started.
            if (outcome.kind === 'completed' && batch.items[step.index]?.status === 'cancelled') {
              const restored = completeCancelledMaterialRefreshItem(batch, step.index, outcome.result, at);
              await this.store.saveMaterialRefreshBatch(restored, batch.revision);
            }
            return;
          }
          if (batch.status !== 'running') {
            return;
          }
          const next =
            outcome.kind === 'completed'
              ? completeMaterialRefreshItem(batch, step.index, outcome.result, at)
              : outcome.kind === 'failed'
                ? failMaterialRefreshItem(batch, step.index, outcome.failure, at, outcome.result)
                : interruptMaterialRefreshBatch(batch, at);
          if (canonicalJson(next) === canonicalJson(batch)) {
            return;
          }
          await this.store.saveMaterialRefreshBatch(next, batch.revision);
        });
        if (outcome.kind === 'cancelled') {
          return;
        }
      }
    } catch (error) {
      this.report(error);
      await this.interruptOwned(run, batchId);
    }
  }

  /** Durably pause one owned batch and mark its in-flight item retryable; skipped once detached. */
  private async interruptOwned(run: OwnedRun, batchId: string): Promise<void> {
    if (run.detached) {
      return;
    }
    await this.interruptDurably(batchId, run);
  }

  /**
   * Write the truthful interruption of one batch, best effort and never throwing.
   *
   * `close` calls this without a run after detaching it; a run calls it through
   * {@link MaterialRefreshBatchService.interruptOwned}, which is a no-op once that run is detached.
   */
  private async interruptDurably(batchId: string, run?: OwnedRun): Promise<void> {
    try {
      await this.exclusive(async () => {
        if (run !== undefined && run.detached) {
          return;
        }
        const batch = await this.store.getMaterialRefreshBatch(batchId);
        if (batch === null || batch.status !== 'running') {
          return;
        }
        const interrupted = interruptMaterialRefreshBatch(batch, this.now());
        await this.store.saveMaterialRefreshBatch(interrupted, batch.revision);
      });
    } catch (error) {
      // The store itself refused the interruption (it is the only writer that could): report it and
      // keep the original outcome, which is already the honest one.
      this.report(error);
    }
  }

  /**
   * Perform one item's refresh exactly once.
   *
   * Ownership is proven before the request: the problem must still be stored under its canonical key,
   * the adapter must be bound to that problem's own source instance, and a named account must be
   * stored **and** belong to that instance. A refusal is a recorded item failure, never a silent
   * anonymous fallback. The refresh service is called exactly once per attempt, and a report that came
   * back is classified as what it is — there is deliberately no cancellation check after it, because
   * `refreshMaterial` only returns once the material was committed, and reinterpreting that committed
   * success as cancelled is what made a retry repeat platform IO.
   */
  private async runItem(run: OwnedRun, item: MaterialRefreshBatchItem): Promise<ItemOutcome> {
    const token = run.source.token;
    try {
      if (run.detached) {
        return { kind: 'cancelled' };
      }
      token.throwIfCancelled();
      const ref = parseProblemKey(item.problemKey);
      const stored = await this.store.getProblem(item.problemKey);
      if (run.detached) {
        return { kind: 'cancelled' };
      }
      token.throwIfCancelled();
      if (stored === null || problemKey(stored.ref) !== item.problemKey) {
        // The row was removed or rewritten after this batch was prepared: a batch refreshes stored
        // material, so nothing may be fetched for a problem the store no longer holds. The failure
        // stays retryable for a later sync, and no adapter request is made.
        return { kind: 'failed', failure: failureOf('missing_reference', true, null, 1), result: null };
      }
      const adapter = await this.adapterFor(ref.sourceInstanceId);
      if (run.detached) {
        return { kind: 'cancelled' };
      }
      token.throwIfCancelled();
      if (
        adapter === null ||
        typeof adapter !== 'object' ||
        adapter.sourceInstance?.id !== ref.sourceInstanceId ||
        typeof adapter.fetchEditorial !== 'function'
      ) {
        return {
          kind: 'failed',
          failure: failureOf('unavailable', true, null, 1),
          result: null,
        };
      }
      let account: Account | null = null;
      if (item.accountId !== null) {
        const stored = await this.store.getAccount(item.accountId);
        if (run.detached) {
          return { kind: 'cancelled' };
        }
        token.throwIfCancelled();
        if (stored === null || stored.sourceInstanceId !== ref.sourceInstanceId) {
          // Never fall back to anonymous: a named account that is missing or foreign is a refusal.
          return { kind: 'failed', failure: failureOf('missing_reference', false, null, 1), result: null };
        }
        account = stored;
      }
      const limits = await this.limits();
      if (run.detached) {
        return { kind: 'cancelled' };
      }
      token.throwIfCancelled();
      const mirror = await this.mirrorFor(ref.sourceInstanceId);
      if (run.detached) {
        return { kind: 'cancelled' };
      }
      token.throwIfCancelled();
      const report: RefreshMaterialReport = await this.imports.refreshMaterial(adapter, {
        problemRef: ref,
        fetchStatement: item.fetchStatement,
        ...(item.officialTutorialUrl === null ? {} : { officialTutorialUrl: item.officialTutorialUrl }),
        mirrorEditorial: mirror,
        ...(account === null ? {} : { account }),
        token,
        limits,
      });
      // No cancellation check here on purpose: `refreshMaterial` returns only after it committed (or
      // reused) the snapshot, so this report is a success that must be classified as one even when the
      // token was cancelled while it returned. A detached run stops here instead, without writing.
      if (run.detached) {
        return { kind: 'cancelled' };
      }
      return classifyMaterialRefreshReport(report);
    } catch (error) {
      return this.itemFailure(error);
    }
  }

  /** Convert one thrown value into a cancellation status or a sanitized, retryable item failure. */
  private itemFailure(error: unknown): ItemOutcome {
    if (error instanceof DomainError) {
      switch (error.code) {
        case 'cancelled':
          return { kind: 'cancelled' };
        case 'invalid_transition':
          // The refresh service's own optimistic snapshot-head refusal: material fetched against a
          // superseded head was rejected instead of overwriting newer content.
          return { kind: 'failed', failure: failureOf('stale_head', true, null, 1), result: null };
        case 'missing_reference':
          return { kind: 'failed', failure: failureOf('missing_reference', true, null, 1), result: null };
        case 'invalid_input':
        case 'invalid_id_part':
        case 'invalid_url':
          return { kind: 'failed', failure: failureOf('invalid_reference', false, null, 1), result: null };
        default:
          this.report(error);
          return { kind: 'failed', failure: failureOf('unexpected', true, null, 1), result: null };
      }
    }
    if (isPlatformError(error)) {
      if (error.code === 'cancelled') {
        return { kind: 'cancelled' };
      }
      return { kind: 'failed', failure: fromPlatformError(error), result: null };
    }
    this.report(error);
    return { kind: 'failed', failure: failureOf('unexpected', true, null, 1), result: null };
  }

  /** The mirror port of one source instance; a composition without one is a real answer, not a failure. */
  private async mirrorFor(sourceInstanceId: string): Promise<MirrorEditorialPort | null> {
    return this.mirrorEditorialFor === null ? null : await this.mirrorEditorialFor(sourceInstanceId);
  }

  // -------------------------------------------------------------------------------------
  // Durable helpers
  // -------------------------------------------------------------------------------------

  /**
   * Refuse a mutation that would claim work once {@link MaterialRefreshBatchService.close} began.
   *
   * Called synchronously by every mutating operation **and** again inside its serialized critical
   * section, so a claim that was already queued when disposal started refuses instead of running
   * behind the close's own drain.
   */
  private requireOpen(): void {
    invariant(!this.closing, 'invalid_transition', 'material batch service is closing and accepts no new work');
  }

  /** One stored batch, or a typed not-found; never an invented or empty record. */
  private async requireBatch(batchId: string): Promise<MaterialRefreshBatch> {
    invariant(
      typeof batchId === 'string' && batchId.trim().length > 0,
      'invalid_input',
      'material batch id is required',
      { batchId },
    );
    const batch = await this.store.getMaterialRefreshBatch(batchId);
    invariant(batch !== null, 'missing_reference', `material batch ${batchId} is not stored`, { batchId });
    return batch;
  }

  /** True when this process still owns an unfinished run of one batch. */
  private isOwned(batchId: string): boolean {
    const run = this.owned.get(batchId);
    return run !== undefined && !run.settled;
  }

  /** Serialize one durable read-modify-write; the previous task's outcome never blocks the next. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(work, work);
    this.mutations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Wait for the given runs against **one** shared deadline; never rejects.
   *
   * The bound is a property of the close operation, not of each run: N runs are raced against a
   * single expiry, so disposal is over after at most `timeoutMs` instead of N times the configured
   * grace period, and a run that already settled is reported settled even at a zero bound.
   * `timeoutMs === null` waits without a bound.
   */
  private async awaitRuns(
    owned: readonly (readonly [string, OwnedRun])[],
    timeoutMs: number | null,
  ): Promise<MaterialRefreshBatchCloseReport> {
    if (owned.length === 0) {
      return { settled: [], outstanding: [] };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const expiry =
      timeoutMs === null
        ? null
        : new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
          });
    const outcomes = await Promise.all(
      owned.map(async ([batchId, run]) => ({
        batchId,
        settled: expiry === null ? await settles(run.promise) : await Promise.race([settles(run.promise), expiry]),
      })),
    );
    if (timer !== null) {
      clearTimeout(timer);
    }
    return {
      settled: outcomes.filter((outcome) => outcome.settled).map((outcome) => outcome.batchId),
      outstanding: outcomes.filter((outcome) => !outcome.settled).map((outcome) => outcome.batchId),
    };
  }

  /** Report one sanitized failure; a broken observer can never change the durable outcome. */
  private report(error: unknown): void {
    if (this.onInternalError === null) {
      return;
    }
    try {
      this.onInternalError(error);
    } catch (observerFailure) {
      // Diagnostics only: the failure was already sanitized into the item, so a broken observer is
      // dropped here rather than being allowed to replace that outcome.
      void observerFailure;
    }
  }
}

/** Await a promise that never rejects, reporting whether it settled. */
async function settles(promise: Promise<void>): Promise<boolean> {
  try {
    await promise;
    return true;
  } catch {
    // `runBatch` converts its own failures into durable state, so reaching this is a defensive path;
    // the run is still settled either way.
    return true;
  }
}
