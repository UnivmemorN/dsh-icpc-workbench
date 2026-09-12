/**
 * Import orchestration: manual document application, paged platform sync and material
 * refresh.
 *
 * The service is pure application code: it depends on the domain, on the persistence port and
 * on a platform adapter port, never on an adapter implementation, an HTTP client or a model.
 * `now()` is injected, so every persisted timestamp is explicit and a replay is deterministic.
 *
 * ## What each operation guarantees
 *
 * - **`applyManual`** writes one validated document in **one** transaction (source, accounts,
 *   problems, submissions, material and snapshots). A cancellation observed after any write
 *   await aborts the callback, and the store rolls the whole document back. Referenced-only
 *   submissions are rejected rather than given an invented title.
 * - **`syncPage`** performs exactly one adapter page; the UI drives continuation with an
 *   explicit mode. The checkpoint is read *before* the fetch and re-read inside the commit
 *   transaction, where the whole previous checkpoint (or its absence) is compared, so two
 *   writers on the same cursor cannot both commit. A canceled or failed page, or a page that
 *   reports the cursor it was given, writes nothing at all. No bound is ever derived from the
 *   newest stored submission: a new scan without an explicit `since` is a conservative full
 *   scan, because a verdict can change long after its submission time. An invalid adapter
 *   page (bad `fetchedAt`, oversized page, empty next cursor) is refused before any write.
 *   A catalog page also re-snapshots every merged problem in the same transaction, keeping
 *   stored statement and editorial material while advancing the head when metadata changed.
 * - **`refreshMaterial`** keeps the statement and the editorial outcome distinct, never
 *   fetches inside a transaction, and compares the snapshot head captured *before* the
 *   network call with the head inside the commit transaction: material fetched against a
 *   superseded head is rejected instead of overwriting a newer manual import.
 *
 * ## Material merge rules
 *
 * The editorial state of a problem is a *set of sources plus their solutions*, not a single
 * blob. A `found` answer replaces exactly the sources it names (by stable source id) and only
 * those sources' solutions, so separately imported articles survive. A non-`found` answer
 * records the check outcome under a target-derived id, but never discards cached successful
 * material: the caller gets the fresh status *and* the cached availability separately.
 * An empty array is never read as "no editorial exists".
 */
import {
  DomainError,
  accountIdOf,
  assertHttpUrl,
  assertIsoTimestamp,
  createEditorialSource,
  createNormalizedProblem,
  createProblemSnapshot,
  encodeIdPart,
  invariant,
  problemKey,
  sourceInstanceIdOf,
  submissionKey,
  throwIfCancelled,
  type Account,
  type CancellationToken,
  type EditorialAvailability,
  type EditorialSolution,
  type EditorialSource,
  type NormalizedProblem,
  type ProblemRef,
  type ProblemSnapshot,
  type SnapshotHead,
  type SourceInstance,
  type Submission,
} from '../domain/index.js';
import { describePlatformError, editorialFailureFromPlatformError } from './platform-errors.js';
import type { EditorialFetchResult, Page, PlatformAdapter, TrainingStore } from './ports.js';
import type { SyncCheckpoint, SyncCheckpointRef } from './storage-types.js';
import {
  IMPORT_PAGE_LIMITS,
  MISSING_PROBLEM_KEY_LIMIT,
  editorialSourceIdOf,
  type EditorialRefreshOutcome,
  type ManualImportBundle,
  type ManualImportReport,
  type ManualMaterialInput,
  type MaterialOutcome,
  type MaterialReport,
  type ProblemPageCounts,
  type RefreshMaterialReport,
  type RefreshMaterialRequest,
  type SnapshotWrite,
  type StatementRefreshOutcome,
  type SubmissionPageCounts,
  type SyncPageCounts,
  type SyncPageReport,
  type SyncPageRequest,
} from './import-types.js';

export interface ImportServiceOptions {
  readonly store: TrainingStore;
  /** Injected clock; every persisted timestamp (`capturedAt`, `retrievedAt`, `updatedAt`) comes from here. */
  readonly now: () => string;
}

/**
 * Application use cases for getting platform data into the store.
 *
 * Construct once per plugin with the shared store and clock and call one operation per user
 * action; the service holds no cache and no cursor state of its own — every position lives in
 * the store's sync checkpoints.
 */
export class ImportService {
  private readonly store: TrainingStore;
  private readonly now: () => string;

  constructor(options: ImportServiceOptions) {
    invariant(
      options !== null && typeof options === 'object' && options.store !== null && typeof options.store === 'object',
      'unfilled_settings',
      'ImportService requires an explicit store',
    );
    invariant(typeof options.now === 'function', 'unfilled_settings', 'ImportService requires an explicit now() clock');
    this.store = options.store;
    this.now = options.now;
  }

  /**
   * Apply one validated manual document.
   *
   * Everything — source instance, accounts, problems, submissions, material declarations and
   * the resulting snapshots — is written in a single transaction. The service rechecks the
   * identities and references the parser already validated (canonical ids, same source
   * instance, duplicated keys/ids, submissions and materials pointing at a problem the
   * document defines), so a hand-built bundle cannot corrupt persisted identity.
   */
  async applyManual(bundle: ManualImportBundle, token: CancellationToken): Promise<ManualImportReport> {
    throwIfCancelled(token);
    const validated = validateManualBundle(bundle);
    const retrievedAt = assertIsoTimestamp('retrievedAt', this.now());

    return this.store.transaction(async () => {
      throwIfCancelled(token);
      await this.store.upsertSourceInstances([validated.source]);
      throwIfCancelled(token);
      if (validated.accounts.length > 0) {
        await this.store.upsertAccounts(validated.accounts);
        throwIfCancelled(token);
      }

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      const snapshots: SnapshotWrite[] = [];
      const materials: MaterialReport[] = [];

      for (const problem of validated.problems) {
        // A `null` statement in the document never erases a non-empty stored statement: the
        // standalone body and the snapshot statement must agree after the merge.
        const stored = await this.store.getProblem(problem.key);
        throwIfCancelled(token);
        const merged = mergeProblemMetadata(stored, problem);
        await this.store.upsertProblems([merged]);
        throwIfCancelled(token);
        if (stored === null) {
          inserted += 1;
        } else if (sameProblemMetadata(stored, merged)) {
          unchanged += 1;
        } else {
          updated += 1;
        }

        const previous = await this.readCurrentSnapshot(merged.ref, token);
        const declaration = validated.materials.get(problem.key) ?? null;
        const result = declaration === null ? null : declaredMaterialResult(declaration);
        const editorial = mergeEditorialMaterial({
          problem: merged,
          previous,
          result,
          attribution: declaration,
          target: declaration === null || declaration.url === null ? null : assertHttpUrl('material url', declaration.url),
          retrievedAt,
        });
        if (declaration !== null) {
          materials.push(editorial.report);
        }
        snapshots.push(
          await this.persistSnapshot({
            problem: merged,
            sources: editorial.sources,
            solutions: editorial.solutions,
            previous,
            token,
          }),
        );
      }

      if (validated.submissions.length > 0) {
        await this.store.upsertSubmissions(validated.submissions);
        throwIfCancelled(token);
      }
      throwIfCancelled(token);

      return {
        sourceInstanceId: validated.source.id,
        accountsProcessed: validated.accounts.length,
        problems: { inserted, updated, unchanged },
        submissionsProcessed: validated.submissions.length,
        materials,
        snapshots,
        changedSnapshots: snapshots.filter((snapshot) => snapshot.changed).length,
      } satisfies ManualImportReport;
    });
  }

  /**
   * Fetch and commit exactly one adapter page, then persist the page data and the checkpoint
   * together.
   *
   * Modes: `start` begins a new scan and refuses an in-progress checkpoint; `continue` resumes
   * the stored cursor and requires the stored `since`; `restart` explicitly returns to the
   * first page (the caller/UI has already confirmed the user action) and keeps the bound of
   * the interrupted scan unless an explicit one is given.
   */
  async syncPage(adapter: PlatformAdapter, request: SyncPageRequest): Promise<SyncPageReport> {
    const token = request.token;
    throwIfCancelled(token);
    const sourceInstance = adapter.sourceInstance;
    invariant(
      sourceInstance !== null && typeof sourceInstance === 'object' && typeof sourceInstance.id === 'string',
      'invalid_input',
      'syncPage requires an adapter bound to a source instance',
    );
    invariant(
      request.resource === 'problems' || request.resource === 'submissions',
      'invalid_input',
      `unknown sync resource ${String(request.resource)}`,
    );
    invariant(
      request.mode === 'start' || request.mode === 'continue' || request.mode === 'restart',
      'invalid_input',
      `unknown sync mode ${String(request.mode)}`,
    );
    invariant(
      Number.isInteger(request.limit) &&
        request.limit >= IMPORT_PAGE_LIMITS.minPageSize &&
        request.limit <= IMPORT_PAGE_LIMITS.maxPageSize,
      'invalid_input',
      `sync page limit must be an integer in [${IMPORT_PAGE_LIMITS.minPageSize}, ${IMPORT_PAGE_LIMITS.maxPageSize}]`,
      { limit: request.limit },
    );
    invariant(
      request.limits !== null && typeof request.limits === 'object',
      'unfilled_settings',
      'syncPage requires explicit platform limits',
    );

    const account = request.account ?? null;
    if (request.resource === 'submissions') {
      invariant(account !== null, 'missing_reference', 'submission sync requires an account');
    }
    if (account !== null) {
      // A foreign account would bind a checkpoint (and a history) to the wrong instance.
      invariant(
        account.sourceInstanceId === sourceInstance.id,
        'missing_reference',
        `account ${account.id} belongs to ${account.sourceInstanceId}, not ${sourceInstance.id}`,
        { accountId: account.id, adapter: sourceInstance.id },
      );
      invariant(
        account.id === accountIdOf(sourceInstance.id, account.handle),
        'invalid_input',
        `account id ${account.id} is not canonical for handle ${JSON.stringify(account.handle)}`,
      );
    }

    const ref: SyncCheckpointRef = {
      sourceInstanceId: sourceInstance.id,
      accountId: account === null ? null : account.id,
      resource: request.resource,
    };

    // Read before the fetch: this snapshot is the concurrency token rechecked at commit time.
    const before = await this.store.getSyncCheckpoint(ref);
    throwIfCancelled(token);

    const requestedSince = resolveRequestedSince(request.since);
    const { cursor, since } = resolveScanPosition(request.mode, requestedSince, before);

    const limit = request.limit;
    const limits = request.limits;
    let problemItems: readonly NormalizedProblem[] = [];
    let submissionItems: readonly Submission[] = [];
    let nextCursor: string | null;
    let pageFetchedAt: string;
    if (request.resource === 'problems') {
      const page = validatePage(await adapter.listProblems({ cursor, limit, token, limits, account }), limit);
      problemItems = page.items;
      nextCursor = page.nextCursor;
      pageFetchedAt = page.fetchedAt;
    } else {
      invariant(account !== null, 'missing_reference', 'submission sync requires an account');
      const page = validatePage(await adapter.listSubmissions({ cursor, limit, token, limits, account, since }), limit);
      submissionItems = page.items;
      nextCursor = page.nextCursor;
      pageFetchedAt = page.fetchedAt;
    }
    throwIfCancelled(token);

    if (nextCursor !== null && nextCursor === cursor) {
      // Retrying such a page would loop forever and re-fetch the same rows; surfacing it is the
      // only honest option, and it must not reset the cursor either.
      throw new DomainError('invalid_transition', 'adapter page returned the cursor it was given; refusing a zero-progress loop', {
        cursor,
      });
    }
    for (const item of problemItems) {
      invariant(
        item.ref.sourceInstanceId === sourceInstance.id,
        'missing_reference',
        `catalog page contains a problem of ${item.ref.sourceInstanceId}`,
        { problemKey: item.key },
      );
    }
    for (const item of submissionItems) {
      invariant(
        item.accountId === ref.accountId,
        'missing_reference',
        `submission page contains a submission of ${item.accountId}`,
        { submissionId: item.id },
      );
    }
    const storedAt = assertIsoTimestamp('checkpoint updatedAt', this.now());

    const committed = await this.store.transaction(async () => {
      throwIfCancelled(token);
      const current = await this.store.getSyncCheckpoint(ref);
      throwIfCancelled(token);
      if (!sameCheckpoint(current, before)) {
        throw new DomainError(
          'invalid_transition',
          'sync checkpoint changed while the page was being fetched; another writer committed progress',
          { expected: before === null ? null : before.cursor, current: current === null ? null : current.cursor },
        );
      }
      // Source/account are persisted only now, together with the page they belong to.
      await this.store.upsertSourceInstances([sourceInstance]);
      throwIfCancelled(token);
      if (account !== null) {
        await this.store.upsertAccounts([account]);
        throwIfCancelled(token);
      }

      const counts: SyncPageCounts =
        request.resource === 'problems'
          ? await this.writeProblems(problemItems, token)
          : await this.writeSubmissions(submissionItems, token);

      const checkpoint: SyncCheckpoint = { ...ref, cursor: nextCursor, since, updatedAt: storedAt };
      await this.store.saveSyncCheckpoint(checkpoint);
      throwIfCancelled(token);
      return { counts, checkpoint };
    });

    return {
      resource: request.resource,
      mode: request.mode,
      sourceInstanceId: sourceInstance.id,
      accountId: ref.accountId,
      since,
      cursor,
      nextCursor,
      complete: nextCursor === null,
      counts: committed.counts,
      checkpoint: committed.checkpoint,
      pageFetchedAt,
    };
  }

  /**
   * Refresh one problem's statement and editorial material.
   *
   * The two fetches are independent: a blocked statement fetch still allows an explicitly
   * supplied official tutorial to be fetched and stored, and a failed editorial fetch is
   * reported without discarding good cached material. Nothing is fetched inside the commit
   * transaction, and material fetched against a snapshot head that changed in the meantime is
   * rejected instead of overwriting newer content.
   */
  async refreshMaterial(adapter: PlatformAdapter, request: RefreshMaterialRequest): Promise<RefreshMaterialReport> {
    const token = request.token;
    const problemRef = request.problemRef;
    const key = problemKey(problemRef);
    throwIfCancelled(token);
    invariant(
      typeof request.fetchStatement === 'boolean',
      'invalid_input',
      'refreshMaterial requires an explicit fetchStatement flag',
    );
    invariant(
      problemRef.sourceInstanceId === adapter.sourceInstance.id,
      'missing_reference',
      `problem ref belongs to ${problemRef.sourceInstanceId}, not adapter source ${adapter.sourceInstance.id}`,
      { problemKey: key, adapter: adapter.sourceInstance.id },
    );
    const officialTutorialUrl =
      request.officialTutorialUrl === undefined || request.officialTutorialUrl === null
        ? null
        : assertHttpUrl('officialTutorialUrl', request.officialTutorialUrl);

    // Captured before any IO: the commit transaction refuses to write material that was
    // fetched against a head which has since been superseded.
    const capturedHead = await this.store.getCurrentSnapshotHead(problemRef);
    throwIfCancelled(token);
    const storedBefore = await this.store.getProblem(key);
    throwIfCancelled(token);

    let statement: StatementRefreshOutcome = { status: 'not_requested', fetchedProblem: null, error: null };
    if (request.fetchStatement) {
      try {
        const fetched = await adapter.fetchProblem({ problemRef, token, limits: request.limits });
        throwIfCancelled(token);
        statement = { status: 'fetched', fetchedProblem: fetched, error: null };
      } catch (error) {
        const failure = describePlatformError(error, 'problem');
        if (failure.code === 'cancelled' || failure.code === 'invalid_input') {
          throw failure;
        }
        statement = { status: 'failed', fetchedProblem: null, error: failure };
      }
    }

    const knownBefore =
      statement.fetchedProblem === null ? storedBefore : mergeProblemMetadata(storedBefore, statement.fetchedProblem);
    if (knownBefore === null) {
      // No stored metadata and no fetched metadata: a snapshot cannot be built, and inventing
      // a title or URL is forbidden. Report both outcomes instead of starting a fetch whose
      // answer could not be persisted.
      return {
        problemKey: key,
        problem: null,
        statement,
        editorial: { attempted: false, result: null, error: null, skippedReason: 'problem_metadata_missing' },
        material: null,
        snapshot: null,
      };
    }

    let editorialResult: EditorialFetchResult;
    let editorial: EditorialRefreshOutcome;
    try {
      editorialResult = await adapter.fetchEditorial({
        problemRef,
        token,
        limits: request.limits,
        officialTutorialUrl,
      });
      throwIfCancelled(token);
      editorial = { attempted: true, result: editorialResult, error: null, skippedReason: null };
    } catch (error) {
      const failure = describePlatformError(error, 'editorial');
      if (failure.code === 'cancelled' || failure.code === 'invalid_input') {
        throw failure;
      }
      editorialResult = editorialFailureFromPlatformError(failure);
      editorial = { attempted: true, result: editorialResult, error: failure, skippedReason: null };
    }

    const retrievedAt = assertIsoTimestamp('retrievedAt', this.now());
    const committed = await this.store.transaction(async () => {
      throwIfCancelled(token);
      const currentHead = await this.store.getCurrentSnapshotHead(problemRef);
      throwIfCancelled(token);
      if (!sameHead(capturedHead, currentHead)) {
        throw new DomainError(
          'invalid_transition',
          'material refresh is stale: the snapshot head changed while the material was being fetched',
          { captured: capturedHead === null ? null : capturedHead.snapshotId, current: currentHead === null ? null : currentHead.snapshotId },
        );
      }

      // Re-read inside the transaction so a concurrent manual import's statement is merged
      // rather than overwritten by the older fetch input.
      const latestStored = await this.store.getProblem(key);
      throwIfCancelled(token);
      const problem =
        statement.fetchedProblem === null ? latestStored : mergeProblemMetadata(latestStored, statement.fetchedProblem);
      if (problem === null) {
        throw new DomainError('missing_reference', 'problem metadata disappeared during the material refresh', {
          problemKey: key,
        });
      }
      await this.store.upsertProblems([problem]);
      throwIfCancelled(token);

      const previous = await this.readCurrentSnapshot(problemRef, token);
      const merged = mergeEditorialMaterial({
        problem,
        previous,
        result: editorialResult,
        attribution: null,
        target: officialTutorialUrl,
        retrievedAt,
      });
      const snapshot = await this.persistSnapshot({
        problem,
        sources: merged.sources,
        solutions: merged.solutions,
        previous,
        token,
      });
      throwIfCancelled(token);
      return { problem, material: merged.report, snapshot };
    });

    return {
      problemKey: key,
      problem: committed.problem,
      statement,
      editorial,
      material: committed.material,
      snapshot: committed.snapshot,
    };
  }

  /** Read the current snapshot body of a problem inside the caller's transaction. */
  private async readCurrentSnapshot(ref: ProblemRef, token: CancellationToken): Promise<ProblemSnapshot | null> {
    const head = await this.store.getCurrentSnapshotHead(ref);
    throwIfCancelled(token);
    if (head === null) {
      return null;
    }
    const snapshot = await this.store.getSnapshot(head.snapshotId);
    throwIfCancelled(token);
    if (snapshot === null) {
      throw new DomainError('missing_reference', `snapshot head ${head.snapshotId} has no stored body`, { ref });
    }
    invariant(
      snapshot.problem.key === problemKey(ref),
      'invalid_input',
      'stored snapshot belongs to a different problem',
      { expected: problemKey(ref), stored: snapshot.problem.key },
    );
    return snapshot;
  }

  /**
   * Create the next snapshot of `problem` and save it only when its semantic content changed.
   *
   * `previous` must have been read inside the caller's transaction. The content hash excludes
   * observation timestamps, so a refetch that changed nothing reuses the stored snapshot
   * object exactly — same id, same version, no save — which is what keeps immutable ids from
   * colliding on `fetchedAt`/`capturedAt` differences alone.
   */
  private async persistSnapshot(args: {
    readonly problem: NormalizedProblem;
    readonly sources: readonly EditorialSource[];
    readonly solutions: readonly EditorialSolution[];
    readonly previous: ProblemSnapshot | null;
    readonly token: CancellationToken;
  }): Promise<SnapshotWrite> {
    throwIfCancelled(args.token);
    const candidate = createProblemSnapshot({
      problem: args.problem,
      sources: args.sources,
      solutions: args.solutions,
      capturedAt: assertIsoTimestamp('capturedAt', this.now()),
      previous: args.previous,
    });
    if (args.previous !== null && candidate.version === args.previous.version) {
      return snapshotWrite(args.previous, false);
    }
    await this.store.saveSnapshot(candidate);
    throwIfCancelled(args.token);
    return snapshotWrite(candidate, true);
  }

  /**
   * Upsert one catalog page, preserving stored statements the page does not carry.
   *
   * Every merged problem is re-snapshotted inside the same transaction: the previous
   * snapshot is read first and its sources and solutions are carried over, so a metadata
   * change advances the head (which stales an in-flight analysis) while a page whose
   * semantic content did not change reuses the exact previous snapshot and saves nothing.
   */
  private async writeProblems(
    items: readonly NormalizedProblem[],
    token: CancellationToken,
  ): Promise<ProblemPageCounts> {
    const unique = new Map<string, NormalizedProblem>();
    for (const item of items) {
      unique.set(item.key, item);
    }
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const bodies: NormalizedProblem[] = [];
    const snapshots: SnapshotWrite[] = [];
    for (const item of unique.values()) {
      const stored = await this.store.getProblem(item.key);
      throwIfCancelled(token);
      const body = mergeProblemMetadata(stored, item);
      if (stored === null) {
        inserted += 1;
      } else if (sameProblemMetadata(stored, body)) {
        unchanged += 1;
      } else {
        updated += 1;
      }
      bodies.push(body);

      // A catalog page carries no editorial material: the head is re-derived from the merged
      // metadata plus the previous sources/solutions, so the page can never discard imported
      // editorial while still staling analyses of changed titles, tags or ratings.
      const previous = await this.readCurrentSnapshot(body.ref, token);
      snapshots.push(
        await this.persistSnapshot({
          problem: body,
          sources: previous === null ? [] : previous.sources,
          solutions: previous === null ? [] : previous.solutions,
          previous,
          token,
        }),
      );
    }
    if (bodies.length > 0) {
      await this.store.upsertProblems(bodies);
      throwIfCancelled(token);
    }
    return { kind: 'problems', fetched: items.length, inserted, updated, unchanged };
  }

  /**
   * Upsert one submission page and report referenced problems whose metadata is not stored.
   *
   * History pages legitimately arrive before a catalog sync, so the rows are retained exactly
   * as the platform reported them and the gap is counted instead of being filled with a
   * fabricated problem.
   */
  private async writeSubmissions(
    items: readonly Submission[],
    token: CancellationToken,
  ): Promise<SubmissionPageCounts> {
    const checked = new Set<string>();
    const missingProblemKeys: string[] = [];
    let missingProblemMetadata = 0;
    for (const item of items) {
      if (checked.has(item.key)) {
        continue;
      }
      checked.add(item.key);
      const problem = await this.store.getProblem(item.key);
      throwIfCancelled(token);
      if (problem === null) {
        missingProblemMetadata += 1;
        if (missingProblemKeys.length < MISSING_PROBLEM_KEY_LIMIT) {
          missingProblemKeys.push(item.key);
        }
      }
    }
    if (items.length > 0) {
      await this.store.upsertSubmissions(items);
      throwIfCancelled(token);
    }
    return {
      kind: 'submissions',
      fetched: items.length,
      processed: items.length,
      missingProblemMetadata,
      missingProblemKeys,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Manual bundle validation
// ---------------------------------------------------------------------------------------

interface ValidatedManualBundle {
  readonly source: SourceInstance;
  readonly accounts: readonly Account[];
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  readonly materials: ReadonlyMap<string, ManualMaterialInput>;
}

/**
 * Recheck a hand-built bundle before any write.
 *
 * The strict parser already rejects malformed documents; this second pass protects the store
 * from a caller that bypassed it, and it runs before the transaction so a rejection never
 * leaves partial state.
 */
function validateManualBundle(bundle: ManualImportBundle): ValidatedManualBundle {
  invariant(bundle !== null && typeof bundle === 'object', 'invalid_input', 'manual bundle must be an object');
  const source = bundle.source;
  invariant(source !== null && typeof source === 'object', 'invalid_input', 'manual bundle requires a source instance');
  const baseUrl = assertHttpUrl('manual source baseUrl', source.baseUrl);
  const domain = (source.domain ?? new URL(baseUrl).host).trim().toLowerCase();
  invariant(domain.length > 0, 'invalid_input', 'manual source domain must not be empty');
  const derivedSourceId = sourceInstanceIdOf(source.platform, domain);
  invariant(
    source.id === derivedSourceId,
    'invalid_input',
    `manual source id ${source.id} is not canonical for ${source.platform}:${domain}`,
    { declared: source.id, derived: derivedSourceId },
  );

  const accounts: Account[] = [];
  const accountIds = new Set<string>();
  for (const account of bundle.accounts ?? []) {
    invariant(
      account.sourceInstanceId === source.id,
      'missing_reference',
      `manual account ${account.id} belongs to another source instance`,
      { accountId: account.id, sourceInstanceId: source.id },
    );
    invariant(
      account.id === accountIdOf(source.id, account.handle),
      'invalid_input',
      `manual account id ${account.id} is not canonical for handle ${JSON.stringify(account.handle)}`,
    );
    invariant(!accountIds.has(account.id), 'duplicate_id', `duplicate manual account ${account.id}`);
    accountIds.add(account.id);
    accounts.push(account);
  }

  const problems: NormalizedProblem[] = [];
  const problemKeys = new Set<string>();
  for (const problem of bundle.problems ?? []) {
    invariant(
      problem.key === problemKey(problem.ref),
      'invalid_input',
      `manual problem key ${problem.key} does not match its reference`,
      { declared: problem.key, derived: problemKey(problem.ref) },
    );
    invariant(
      problem.ref.sourceInstanceId === source.id,
      'missing_reference',
      `manual problem ${problem.key} belongs to another source instance`,
    );
    invariant(!problemKeys.has(problem.key), 'duplicate_id', `duplicate manual problem ${problem.key}`);
    problemKeys.add(problem.key);
    problems.push(problem);
  }

  const submissions: Submission[] = [];
  const submissionIds = new Set<string>();
  for (const submission of bundle.submissions ?? []) {
    invariant(
      submission.key === problemKey(submission.ref),
      'invalid_input',
      `manual submission ${submission.id} has a key that does not match its reference`,
    );
    invariant(
      problemKeys.has(submission.key),
      'missing_reference',
      `manual submission ${submission.id} references problem ${submission.key} that the document does not define`,
      { submissionId: submission.id, problemKey: submission.key },
    );
    invariant(
      accountIds.has(submission.accountId),
      'missing_reference',
      `manual submission ${submission.id} references account ${submission.accountId} that the document does not define`,
    );
    const derivedSubmissionId = [
      submissionKey({ ...submission.ref, accountId: submission.accountId }),
      encodeIdPart(submission.externalId),
    ].join('|');
    invariant(
      submission.id === derivedSubmissionId,
      'invalid_input',
      `manual submission id ${submission.id} is not canonical`,
      { declared: submission.id, derived: derivedSubmissionId },
    );
    invariant(!submissionIds.has(submission.id), 'duplicate_id', `duplicate manual submission ${submission.id}`);
    submissionIds.add(submission.id);
    submissions.push(submission);
  }

  const materials = new Map<string, ManualMaterialInput>();
  for (const material of bundle.materials ?? []) {
    invariant(
      problemKeys.has(material.problemKey),
      'missing_reference',
      `manual material references problem ${material.problemKey} that the document does not define`,
    );
    invariant(
      !materials.has(material.problemKey),
      'duplicate_id',
      `duplicate manual material for problem ${material.problemKey}`,
    );
    materials.set(material.problemKey, material);
  }

  return { source, accounts, problems, submissions, materials };
}

/**
 * Interpret one manual material entry.
 *
 * `found` and `absent` are declarations; `unavailable` is the parser's placeholder for a
 * problem the document said nothing about and must not touch stored editorial state.
 */
function declaredMaterialResult(material: ManualMaterialInput): EditorialFetchResult | null {
  const result = material.result;
  if (result.status === 'found') {
    const rawSources: unknown = result.sources;
    const rawSolutions: unknown = result.solutions;
    invariant(
      Array.isArray(rawSources) && Array.isArray(rawSolutions),
      'invalid_input',
      `manual material for ${material.problemKey} must carry sources and solutions`,
    );
    const sources = rawSources as readonly EditorialSource[];
    const solutions = rawSolutions as readonly EditorialSolution[];
    const sourceIds = new Set(sources.map((source) => source.id));
    for (const solution of solutions) {
      invariant(
        sourceIds.has(solution.sourceId),
        'missing_reference',
        `manual solution ${solution.solutionId} references unknown source ${solution.sourceId}`,
      );
    }
    return result;
  }
  if (result.status === 'absent') {
    return result;
  }
  if (result.status === 'unavailable') {
    return null;
  }
  throw new DomainError(
    'invalid_input',
    `manual material for ${material.problemKey} carries the operational status ${result.status}; a manual document declares found, absent or nothing`,
    { status: result.status },
  );
}

// ---------------------------------------------------------------------------------------
// Metadata merge
// ---------------------------------------------------------------------------------------

/**
 * Merge freshly observed metadata over the stored body.
 *
 * A `null` statement never erases a stored non-empty one: catalog pages do not carry
 * statements, so treating `null` as "deleted" would destroy retrieved text. A non-empty
 * incoming statement always wins, because that is what a statement refresh is for.
 */
function mergeProblemMetadata(stored: NormalizedProblem | null, incoming: NormalizedProblem): NormalizedProblem {
  if (stored === null || stored.statement === null || incoming.statement !== null) {
    return incoming;
  }
  return createNormalizedProblem({
    ref: incoming.ref,
    title: incoming.title,
    url: incoming.url,
    statement: stored.statement,
    fetchedAt: incoming.fetchedAt,
    ratings: incoming.ratings.map((rating) => ({
      dimension: rating.dimension,
      value: rating.value,
      scale: rating.scale === null ? null : { min: rating.scale.min, max: rating.scale.max },
      raw: rating.raw,
    })),
    rawTags: incoming.rawTags.map((tag) => tag.raw),
  });
}

/** Structural comparison of every stored problem field, including the observation timestamp. */
function sameProblemMetadata(left: NormalizedProblem, right: NormalizedProblem): boolean {
  return (
    left.key === right.key &&
    left.title === right.title &&
    left.url === right.url &&
    left.statement === right.statement &&
    left.fetchedAt === right.fetchedAt &&
    sameRatings(left.ratings, right.ratings) &&
    sameRawTags(left.rawTags, right.rawTags)
  );
}

function sameRatings(
  left: NormalizedProblem['ratings'],
  right: NormalizedProblem['ratings'],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((rating, index) => {
    const other = right[index];
    if (other === undefined) {
      return false;
    }
    const sameScale =
      rating.scale === null
        ? other.scale === null
        : other.scale !== null && rating.scale.min === other.scale.min && rating.scale.max === other.scale.max;
    return rating.dimension === other.dimension && rating.value === other.value && rating.raw === other.raw && sameScale;
  });
}

function sameRawTags(left: NormalizedProblem['rawTags'], right: NormalizedProblem['rawTags']): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((tag, index) => {
    const other = right[index];
    return other !== undefined && tag.raw === other.raw && tag.sourceInstanceId === other.sourceInstanceId;
  });
}

// ---------------------------------------------------------------------------------------
// Editorial merge
// ---------------------------------------------------------------------------------------

interface EditorialMergeArgs {
  readonly problem: NormalizedProblem;
  readonly previous: ProblemSnapshot | null;
  /** `null` declares nothing and leaves the previous material untouched. */
  readonly result: EditorialFetchResult | null;
  /** Attribution of an explicit manual declaration; ignored for a `found` answer. */
  readonly attribution: { readonly url: string | null; readonly title: string | null; readonly note: string | null } | null;
  /** Refetch target honoured by the adapter, else the problem URL. */
  readonly target: string | null;
  readonly retrievedAt: string;
}

interface EditorialMergeResult {
  readonly sources: readonly EditorialSource[];
  readonly solutions: readonly EditorialSolution[];
  readonly report: MaterialReport;
}

/**
 * Merge one material answer into the stored editorial state.
 *
 * Sources are addressed by their stable id, so:
 * - a `found` answer replaces exactly the sources it names — and only those sources'
 *   solutions — while separately imported articles and their solutions survive;
 * - a non-`found` answer records the check under the target-derived "material check" id but
 *   never replaces a source of that id that already holds successful material;
 * - an empty source array never means "no editorial exists", it only means this answer
 *   carried no material.
 *
 * The result is sorted by stable id, so the same material always produces the same snapshot
 * content hash regardless of the order the adapter reported it in.
 */
function mergeEditorialMaterial(args: EditorialMergeArgs): EditorialMergeResult {
  const previousSources = args.previous === null ? [] : args.previous.sources;
  const previousSolutions = args.previous === null ? [] : args.previous.solutions;
  const key = args.problem.key;
  const result = args.result;
  if (result === null) {
    return {
      sources: previousSources,
      solutions: previousSolutions,
      report: materialReport(key, 'ignored', null, false, null, previousSources.length, previousSolutions.length),
    };
  }

  const target = args.target === null || args.target.length === 0 ? args.problem.url : args.target;
  const checkId = editorialSourceIdOf(args.problem.ref, target);

  if (result.status === 'found') {
    // A `found` answer names the pages it found; an empty source list is a malformed answer,
    // not evidence that no editorial exists, and must never be reported as fresh material.
    invariant(
      result.sources.length > 0,
      'invalid_input',
      'a found editorial result must name at least one source',
      { problemKey: key },
    );
    const incomingIds = new Set(result.sources.map((source) => source.id));
    const keptSources = previousSources.filter((source) => !incomingIds.has(source.id) && source.id !== checkId);
    const keptSolutions = previousSolutions.filter((solution) => !incomingIds.has(solution.sourceId));
    const sources = sortSources([...keptSources, ...result.sources]);
    const solutions = sortSolutions([...keptSolutions, ...result.solutions]);
    return {
      sources,
      solutions,
      report: materialReport(key, 'applied', 'found', true, null, sources.length, solutions.length),
    };
  }

  const cached = previousSources.find((source) => source.id === checkId) ?? null;
  if (cached !== null && cached.availability === 'found') {
    // Operational failures and explicit absence never discard good cached material; the
    // caller sees the cached availability separately instead of a fabricated "fresh" state.
    return {
      sources: previousSources,
      solutions: previousSolutions,
      report: materialReport(
        key,
        'preserved',
        null,
        false,
        cached.availability,
        previousSources.length,
        previousSolutions.length,
      ),
    };
  }

  const placeholder = createEditorialSource({
    id: checkId,
    kind: 'editorial',
    url: target,
    title: args.attribution?.title?.trim() || `Editorial check for ${args.problem.title}`,
    availability: result.status,
    retrievedAt: args.retrievedAt,
    note: materialNote(result, args.attribution?.note ?? null),
  });
  const sources = sortSources([...previousSources.filter((source) => source.id !== checkId), placeholder]);
  const solutions = sortSolutions(previousSolutions.filter((solution) => solution.sourceId !== checkId));
  const cachedFound = sources.some((source) => source.availability === 'found');
  return {
    sources,
    solutions,
    report: materialReport(key, 'applied', result.status, false, cachedFound ? 'found' : null, sources.length, solutions.length),
  };
}

/** Human-readable note of a non-`found` check: declaration note, sanitized detail, retry hint. */
function materialNote(
  result: Exclude<EditorialFetchResult, { status: 'found' }>,
  attributionNote: string | null,
): string | null {
  const parts: string[] = [];
  const declared = attributionNote === null ? '' : attributionNote.trim();
  if (declared.length > 0) {
    parts.push(declared);
  }
  if (result.detail.trim().length > 0) {
    parts.push(result.detail.trim());
  }
  if (result.status === 'rate_limited' && result.retryAfterMs !== null) {
    parts.push(`retry after ${result.retryAfterMs} ms`);
  }
  return parts.length === 0 ? null : parts.join(' | ');
}

function materialReport(
  problemKeyValue: string,
  outcome: MaterialOutcome,
  availability: EditorialAvailability | null,
  freshFound: boolean,
  staleCachedAvailability: EditorialAvailability | null,
  sources: number,
  solutions: number,
): MaterialReport {
  return { problemKey: problemKeyValue, outcome, availability, freshFound, staleCachedAvailability, sources, solutions };
}

function sortSources(sources: readonly EditorialSource[]): EditorialSource[] {
  return [...sources].sort((left, right) => compareStrings(left.id, right.id));
}

function sortSolutions(solutions: readonly EditorialSolution[]): EditorialSolution[] {
  return [...solutions].sort(
    (left, right) =>
      compareStrings(left.sourceId, right.sourceId) ||
      left.ordinal - right.ordinal ||
      compareStrings(left.solutionId, right.solutionId),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------------------
// Adapter page validation
// ---------------------------------------------------------------------------------------

/**
 * Validate one adapter page before anything is written.
 *
 * A page that exceeds the requested limit, carries an unparseable `fetchedAt` or reports an
 * empty next cursor is refused during the fetch phase, so the source instance, the page data
 * and the checkpoint all stay untouched instead of recording progress the adapter never made.
 */
function validatePage<T>(page: Page<T>, limit: number): Page<T> {
  invariant(page !== null && typeof page === 'object', 'invalid_input', 'adapter page must be an object');
  invariant(Array.isArray(page.items), 'invalid_input', 'adapter page items must be an array');
  invariant(
    page.items.length <= limit,
    'invalid_input',
    `adapter page returned ${page.items.length} items for a limit of ${limit}`,
    { limit },
  );
  invariant(
    page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0),
    'invalid_input',
    'adapter page next cursor must be a non-empty string or null',
  );
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    fetchedAt: assertIsoTimestamp('page fetchedAt', page.fetchedAt),
  };
}

// ---------------------------------------------------------------------------------------
// Sync position
// ---------------------------------------------------------------------------------------

/** Normalize the caller's `since`: `undefined` means "no explicit bound", `null` a full scan. */
function resolveRequestedSince(since: string | null | undefined): string | null | undefined {
  if (since === undefined || since === null) {
    return since;
  }
  return assertIsoTimestamp('since', since);
}

/**
 * Decide the page cursor and the scan bound from the mode and the stored checkpoint.
 *
 * `start` with no explicit bound is a conservative full scan: deriving a bound from the
 * newest stored submission would silently skip older rows whose verdict changed later.
 * `restart` reuses the interrupted scan's bound unless the caller overrides it.
 */
function resolveScanPosition(
  mode: SyncPageRequest['mode'],
  requestedSince: string | null | undefined,
  before: SyncCheckpoint | null,
): { readonly cursor: string | null; readonly since: string | null } {
  if (mode === 'continue') {
    if (before === null || before.cursor === null) {
      throw new DomainError('invalid_transition', 'continue requires an in-progress checkpoint; use start', {
        cursor: before === null ? null : before.cursor,
      });
    }
    if (requestedSince !== undefined && requestedSince !== before.since) {
      throw new DomainError('invalid_input', 'continue must keep the since bound of the in-progress scan', {
        requested: requestedSince,
        bound: before.since,
      });
    }
    return { cursor: before.cursor, since: before.since };
  }
  if (mode === 'start') {
    if (before !== null && before.cursor !== null) {
      throw new DomainError('invalid_transition', 'start refuses an in-progress checkpoint; use continue or restart', {
        cursor: before.cursor,
      });
    }
    return { cursor: null, since: requestedSince === undefined ? null : requestedSince };
  }
  return { cursor: null, since: requestedSince === undefined ? (before === null ? null : before.since) : requestedSince };
}

/** Whole-checkpoint comparison, used as the optimistic-concurrency token of one page. */
function sameCheckpoint(left: SyncCheckpoint | null, right: SyncCheckpoint | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.sourceInstanceId === right.sourceInstanceId &&
    left.accountId === right.accountId &&
    left.resource === right.resource &&
    left.cursor === right.cursor &&
    left.since === right.since &&
    left.updatedAt === right.updatedAt
  );
}

/** Head comparison: id already embeds hash and version, all three are compared for clarity. */
function sameHead(left: SnapshotHead | null, right: SnapshotHead | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.snapshotId === right.snapshotId && left.contentHash === right.contentHash && left.version === right.version
  );
}

function snapshotWrite(snapshot: ProblemSnapshot, changed: boolean): SnapshotWrite {
  return {
    problemKey: snapshot.problem.key,
    snapshotId: snapshot.snapshotId,
    version: snapshot.version,
    contentHash: snapshot.contentHash,
    capturedAt: snapshot.capturedAt,
    changed,
  };
}
