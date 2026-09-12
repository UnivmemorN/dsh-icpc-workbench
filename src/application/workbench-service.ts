/**
 * Workbench read/review service (Stage 4w1a): `listProblems`, `getProblem`, `reviewTag`,
 * `recordRetrospective`.
 *
 * The service owns policy — paging, whole-bank search, the review queue, spoiler discipline,
 * manual precedence and retrospective validation — while the injected store owns durability and
 * the injected taxonomy owns tag identity. It never reads a clock directly (every timestamp comes
 * from `now()`), never fabricates a title, URL or solution body, and never spreads a stored
 * snapshot into a response: every DTO is built field by field, so a withheld spoiler field is an
 * *absent* own property instead of a `null` that a caller could read as "empty".
 * Weakness ranking and training plans are deliberately absent.
 *
 * Failures are typed: `missing_reference` for an unknown problem/account/solution, `invalid_input`
 * for malformed or foreign-scope arguments (with a machine-readable `reason`), `unknown_taxonomy_id`
 * for an unknown tag, and `cancelled` on cancellation. Cancellation is checked after every awaited
 * write, so a cancelled review rolls its transaction back instead of leaving a half-recorded one.
 */
import {
  COMPLETION_MODES,
  DomainError,
  analysisIsStale,
  assertIsoTimestamp,
  assertKnownTag,
  contentHashOf,
  createManualTagDecision,
  createRetrospective,
  createTagDecision,
  decisionIsEffective,
  invariant,
  isAccepted,
  latestRetrospectiveByProblem,
  manualDecisionsForProblem,
  verificationFor,
  type Account,
  type AnalysisResult,
  type CancellationToken,
  type CompletionMode,
  type ManualTagAction,
  type ManualTagDecision,
  type NormalizedProblem,
  type ProblemSnapshot,
  type Retrospective,
  type SnapshotHead,
  type Submission,
  type SuggestionVerification,
  type TagDecision,
  type TaxonomyIndex,
} from '../domain/index.js';
import { currentDecisionPerTag } from '../domain/tags.js';
import type { TrainingStore } from './ports.js';
import { STORAGE_PAGE_LIMITS } from './storage-types.js';
import type {
  WorkbenchAnalysisView,
  WorkbenchEditorialSourceView,
  WorkbenchEvidenceView,
  WorkbenchManualDecisionView,
  WorkbenchProblemDetail,
  WorkbenchProblemPage,
  WorkbenchProblemSummary,
  WorkbenchRatingView,
  WorkbenchReasoningDraftView,
  WorkbenchRetrospectiveResult,
  WorkbenchRetrospectiveView,
  WorkbenchSnapshotView,
  WorkbenchSolutionView,
  WorkbenchSuggestionView,
  WorkbenchTagDecisionView,
  WorkbenchTagReviewResult,
  WorkbenchVerificationView,
} from './workbench-types.js';

/** Store rows read per internal walk of one account's submission history. */
export const WORKBENCH_SUBMISSION_PAGE_SIZE = 500;

/** Hard bound of one submission-history walk; exceeding it is an explicit refusal, not truncation. */
export const MAX_ACCOUNT_SUBMISSIONS = 50_000;

/** Maximum accepted `query` length; longer input is rejected instead of being truncated. */
export const MAX_PROBLEM_QUERY_CHARS = 200;

/** Maximum accepted review note length. */
export const MAX_REVIEW_NOTE_CHARS = 2000;

/**
 * Maximum accepted entries in one `taxonomyIds`/`solutionIds` list.
 *
 * The bound is enforced before any per-entry work, so a caller cannot force an unbounded scan (or
 * an unbounded dedup) with a huge array; a longer list is refused rather than truncated.
 */
export const MAX_RETROSPECTIVE_IDS = 500;

const CURSOR_PREFIX = 'workbench-problems.v1';

/** Injected dependencies. Every timestamp and id this service produces comes from `now`/`uniqueId`. */
export interface WorkbenchServiceOptions {
  readonly store: TrainingStore;
  /** Built from the current vocabulary; manual review only accepts ids this index knows. */
  readonly taxonomy: TaxonomyIndex;
  readonly now: () => string;
  readonly uniqueId: () => string;
}

/** Bank page request. `accountId` is a solved/spoiler context, not an implicit attempt filter. */
export interface WorkbenchListRequest {
  readonly sourceInstanceId?: string | null;
  readonly accountId?: string | null;
  /** Restrict the bank to problems this account submitted to; requires an explicit account. */
  readonly onlyAttempted?: boolean;
  /** Literal case-insensitive substring over title and external key, across the whole bank. */
  readonly query?: string | null;
  readonly limit: number;
  readonly cursor?: string | null;
  readonly reveal?: boolean;
  /** Keep only problems with an unresolved item at the current snapshot head. */
  readonly needsReviewOnly?: boolean;
}

export interface WorkbenchGetProblemRequest {
  readonly problemKey: string;
  readonly accountId: string | null;
  /** Explicitly show tags/analyses/editorial bodies of a problem this account has not solved. */
  readonly reveal?: boolean;
}

export interface WorkbenchReviewTagRequest {
  readonly problemKey: string;
  readonly taxonomyId: string;
  readonly action: ManualTagAction;
  readonly note?: string | null;
}

export interface WorkbenchRetrospectiveRequest {
  readonly problemKey: string;
  readonly accountId: string;
  readonly mode: CompletionMode;
  readonly taxonomyIds?: readonly string[];
  readonly solutionIds?: readonly string[];
  readonly note?: string | null;
}

interface ListFilters {
  readonly sourceInstanceId: string | null;
  readonly accountId: string | null;
  readonly onlyAttempted: boolean;
  readonly query: string | null;
  readonly needsReviewOnly: boolean;
  readonly reveal: boolean;
  readonly limit: number;
  readonly cursor: string | null;
}

/**
 * Workbench read/review use case. One instance may serve concurrent callers; all mutations run in
 * one store transaction that re-reads the state it decides on, so a stale caller cannot overwrite a
 * newer manual decision or reorder the append-only history.
 */
export class WorkbenchService {
  private readonly store: TrainingStore;
  private readonly taxonomy: TaxonomyIndex;
  private readonly now: () => string;
  private readonly uniqueId: () => string;

  constructor(options: WorkbenchServiceOptions) {
    if (options === null || typeof options !== 'object') {
      throw new DomainError('unfilled_settings', 'workbench service needs an options object', {});
    }
    if (options.store === null || typeof options.store !== 'object') {
      throw new DomainError('unfilled_settings', 'workbench service needs a TrainingStore', {});
    }
    if (
      options.taxonomy === null ||
      typeof options.taxonomy !== 'object' ||
      typeof options.taxonomy.has !== 'function'
    ) {
      throw new DomainError('unfilled_settings', 'workbench service needs a TaxonomyIndex', {});
    }
    if (typeof options.now !== 'function' || typeof options.uniqueId !== 'function') {
      throw new DomainError('unfilled_settings', 'workbench service needs injected now() and uniqueId()', {});
    }
    this.store = options.store;
    this.taxonomy = options.taxonomy;
    this.now = options.now;
    this.uniqueId = options.uniqueId;
  }

  // -------------------------------------------------------------------------------------
  // listProblems
  // -------------------------------------------------------------------------------------

  /**
   * One page of the problem bank.
   *
   * `accountId` never restricts the bank unless `onlyAttempted` is explicit; it only decides which
   * rows count as solved and therefore whether their tag material is visible. Search and the
   * review-queue filter run inside SQL before pagination, and the returned cursor is bound to the
   * whole filter set, so changing a filter mid-pagination is rejected instead of silently paging a
   * different query.
   */
  async listProblems(request: WorkbenchListRequest, token: CancellationToken): Promise<WorkbenchProblemPage> {
    requireToken(token);
    token.throwIfCancelled();
    const filters = parseListRequest(request);
    const fingerprint = listFingerprint(filters);
    const cursor = filters.cursor === null ? null : decodeProblemCursor(filters.cursor, fingerprint);
    // Every read behind one page — the account, the bank rows, the accepted-submission walk and the
    // per-row tag material — joins ONE store transaction, so the rows and the head they are
    // projected against are a single serialized read: a concurrent head move can never pair an old
    // head with newer decisions (or the reverse) inside the same response.
    const stored = await this.store.transaction(async () => {
      token.throwIfCancelled();
      const account = filters.accountId === null ? null : await this.requireAccount(filters.accountId, token);
      if (account !== null && filters.sourceInstanceId !== null && account.sourceInstanceId !== filters.sourceInstanceId) {
        throw sourceMismatch(account, filters.sourceInstanceId);
      }
      invariant(
        !filters.onlyAttempted || account !== null,
        'invalid_input',
        'onlyAttempted needs an explicit account id; there is no account whose attempts could be listed',
        { reason: 'only_attempted_without_account' },
      );
      const page = await this.store.listProblems({
        sourceInstanceId: filters.sourceInstanceId,
        accountId: filters.onlyAttempted && account !== null ? account.id : null,
        limit: filters.limit,
        cursor,
        query: filters.query,
        needsReviewOnly: filters.needsReviewOnly,
      });
      token.throwIfCancelled();

      // Solved status is derived from this account's own accepted submissions only; a missing
      // account context means no row is solved and no tag material is revealed by default.
      const solvedKeys = account === null || page.items.length === 0 ? null : await this.solvedKeys(account.id, token);
      const items: WorkbenchProblemSummary[] = [];
      for (const problem of page.items) {
        const solved = solvedKeys?.has(problem.key) ?? false;
        const visible = solved || filters.reveal;
        items.push(await this.projectSummary(problem, solved, visible, filters.needsReviewOnly, token));
      }
      return { items, nextCursor: page.nextCursor, fetchedAt: page.fetchedAt };
    });
    return {
      pageId: this.mintId(),
      items: stored.items,
      nextCursor: stored.nextCursor === null ? null : encodeProblemCursor(fingerprint, stored.nextCursor),
      reveal: filters.reveal,
      pendingReviewOnly: filters.needsReviewOnly,
      fetchedAt: stored.fetchedAt,
    };
  }

  // -------------------------------------------------------------------------------------
  // getProblem
  // -------------------------------------------------------------------------------------

  /**
   * Full detail of one problem.
   *
   * Raw tags, effective taxonomy ids, analyses, manual decisions and editorial bodies are withheld
   * unless the selected account solved the problem or `reveal` is explicit. The statement, ratings
   * and counts are always returned; nothing withheld is present anywhere in the response object. A
   * retrospective of the selected account keeps its completion mode and date but loses the confirmed
   * skills, consulted solutions and note while spoilers are withheld.
   */
  async getProblem(request: WorkbenchGetProblemRequest, token: CancellationToken): Promise<WorkbenchProblemDetail> {
    requireToken(token);
    token.throwIfCancelled();
    const problemKey = requireProblemKeyInput(request === null || typeof request !== 'object' ? undefined : request.problemKey);
    const reveal = optionalFlag('reveal', request.reveal);
    const accountId = optionalId('accountId', request.accountId);
    // One transaction for the whole detail: the problem, the account, the histories, the solved
    // verdict, the retrospective, the head and its snapshot form a single serialized read, so the
    // staleness flags and the effective ids always describe the head returned in the same object.
    return this.store.transaction(async (): Promise<WorkbenchProblemDetail> => {
      token.throwIfCancelled();
      const problem = await this.store.getProblem(problemKey);
      token.throwIfCancelled();
      if (problem === null) {
        throw new DomainError('missing_reference', `problem ${problemKey} is not stored`, { problemKey });
      }
      const account = accountId === null ? null : await this.requireAccount(accountId, token);
      if (account !== null && account.sourceInstanceId !== problem.ref.sourceInstanceId) {
        throw sourceMismatch(account, problem.ref.sourceInstanceId);
      }
      const analyses = await this.store.listAnalyses(problemKey);
      token.throwIfCancelled();
      const decisions = await this.store.listTagDecisions(problemKey);
      token.throwIfCancelled();
      const manualDecisions = await this.store.listManualDecisions(problemKey);
      token.throwIfCancelled();
      const solved = account === null ? false : await this.isSolvedBy(account.id, problemKey, token);
      const retrospective =
        account === null ? null : await this.latestRetrospectiveOf(account.id, problemKey, token);
      // The head is the staleness authority and is read after every history: a projection that
      // started before a head move still reports the moved head, never an old head beside fresher
      // rows, so stale AI output can never be marked current by the order of reads.
      const head = await this.store.getCurrentSnapshotHead(problem.ref);
      token.throwIfCancelled();
      const snapshot = head === null ? null : await this.store.getSnapshot(head.snapshotId);
      token.throwIfCancelled();
      const visible = solved || reveal;
      const detail: WorkbenchProblemDetail = {
        problemKey: problem.key,
        sourceInstanceId: problem.ref.sourceInstanceId,
        domain: problem.ref.domain,
        externalKey: problem.ref.externalKey,
        title: problem.title,
        url: problem.url,
        statement: problem.statement,
        fetchedAt: problem.fetchedAt,
        rawRatings: problem.ratings.map(ratingView),
        accountId,
        solvedByAccount: solved,
        spoilersVisible: visible,
        snapshot: snapshot === null ? null : snapshotView(snapshot, visible),
        staleAnalysisCount: analyses.filter((analysis) => analysisIsStale(analysis, head)).length,
        latestRetrospective: retrospective === null ? null : retrospectiveView(retrospective, visible),
      };
      if (!visible) {
        // Withheld material stays out of the object entirely: `null` would read as "present but
        // empty" and every future field addition would become a silent leak.
        return detail;
      }
      return {
        ...detail,
        rawTags: problem.rawTags.map((tag) => tag.raw),
        effectiveTaxonomyIds: effectiveCurrentTaxonomyIds(decisions, head),
        analyses: analyses.map((analysis) => analysisView(analysis, head)),
        manualDecisions: manualDecisions.map(manualDecisionView),
        currentTagDecisions: currentTagDecisionViews(decisions, head),
      };
    });
  }

  // -------------------------------------------------------------------------------------
  // reviewTag
  // -------------------------------------------------------------------------------------

  /**
   * Record one manual accept/reject and its resolved manual decision in one transaction.
   *
   * A manual decision always outranks model output, so the resolved decision is written with
   * `origin: 'manual'` and the AI history is left untouched. When `now()` repeats, the timestamp is
   * derived strictly after the last decision of this problem; an identical intent (same action and
   * note for the same tag) is idempotent and does not advance the manual revision again.
   */
  async reviewTag(request: WorkbenchReviewTagRequest, token: CancellationToken): Promise<WorkbenchTagReviewResult> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(request !== null && typeof request === 'object', 'invalid_input', 'reviewTag needs a request object', {});
    const problemKey = requireProblemKeyInput(request.problemKey);
    const taxonomyId = requireTaxonomyId(request.taxonomyId);
    assertKnownTag(this.taxonomy, taxonomyId);
    const action = request.action;
    invariant(
      action === 'accept' || action === 'reject',
      'invalid_input',
      `manual action must be accept|reject (got ${String(action)})`,
      { action },
    );
    const note = optionalNote(request.note);
    const problem = await this.store.getProblem(problemKey);
    token.throwIfCancelled();
    if (problem === null) {
      throw new DomainError('missing_reference', `problem ${problemKey} is not stored`, { problemKey });
    }
    const status = action === 'accept' ? 'accepted' : 'rejected';
    const reason = action === 'accept' ? 'manual_accept' : 'manual_reject';

    return this.store.transaction(async (): Promise<WorkbenchTagReviewResult> => {
      token.throwIfCancelled();
      const manuals = await this.store.listManualDecisions(problemKey);
      token.throwIfCancelled();
      const current = manualDecisionsForProblem(manuals, problemKey).get(taxonomyId) ?? null;
      if (current !== null && current.action === action && (current.note ?? null) === note) {
        const revision = await this.store.getManualRevision(problemKey);
        token.throwIfCancelled();
        return {
          problemKey,
          taxonomyId,
          action,
          decisionId: current.decisionId,
          decidedAt: current.decidedAt,
          note: current.note,
          manualRevision: revision,
          outcome: 'already_recorded',
          status,
        };
      }
      const decidedAt = monotonicInstant(latestDecidedAt(manuals), this.now());
      const supersedesAnalysisId = await this.currentAnalysisId(problem, token);
      const manual = createManualTagDecision({
        problemRef: problem.ref,
        taxonomyId,
        action,
        decidedAt,
        note,
        supersedesAnalysisId,
      });
      const resolved = createTagDecision({
        problemKey,
        taxonomyId,
        status,
        origin: 'manual',
        decidedAt,
        reasons: [reason],
        analysisId: supersedesAnalysisId,
        evidence: [],
      });
      // Both writes join this transaction, so a cancelled or failed second write rolls the first back.
      await this.store.saveManualDecision(manual);
      token.throwIfCancelled();
      await this.store.saveTagDecisions([resolved]);
      token.throwIfCancelled();
      const revision = await this.store.getManualRevision(problemKey);
      token.throwIfCancelled();
      return {
        problemKey,
        taxonomyId,
        action,
        decisionId: manual.decisionId,
        decidedAt,
        note: manual.note,
        manualRevision: revision,
        outcome: 'recorded',
        status,
      };
    });
  }

  // -------------------------------------------------------------------------------------
  // recordRetrospective
  // -------------------------------------------------------------------------------------

  /**
   * Record how the solver actually finished one problem for one account.
   *
   * This is the only place a completion becomes a confirmed skill: an AC submission alone never
   * records one. The problem/account must share a source instance, every taxonomy id must exist in
   * the current vocabulary, and every consulted solution id must come from the *current* snapshot;
   * `independent` explicitly forbids consulted solutions. All of those reads — problem, account,
   * head, snapshot and solution membership — happen inside the write transaction, so a snapshot
   * replaced between the request and the insert is observed before anything is written. A repeated
   * `now()` is ordered strictly after the previous record of this (account, problem), so the
   * append-only history stays ordered.
   */
  async recordRetrospective(
    request: WorkbenchRetrospectiveRequest,
    token: CancellationToken,
  ): Promise<WorkbenchRetrospectiveResult> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(
      request !== null && typeof request === 'object',
      'invalid_input',
      'recordRetrospective needs a request object',
      {},
    );
    const problemKey = requireProblemKeyInput(request.problemKey);
    const accountId = optionalId('accountId', request.accountId);
    invariant(accountId !== null, 'invalid_input', 'a retrospective belongs to one account', { problemKey });
    const mode = request.mode;
    invariant(
      COMPLETION_MODES.includes(mode),
      'invalid_input',
      `unknown completion mode ${String(mode)}`,
      { mode },
    );
    const taxonomyIds = requireTaxonomyIds(this.taxonomy, request.taxonomyIds);
    const solutionIds = requireIdList('solutionIds', request.solutionIds);
    invariant(
      mode !== 'independent' || solutionIds.length === 0,
      'invalid_input',
      'an independent retrospective forbids consulted solution ids',
      { reason: 'independent_with_solutions', solutionIds },
    );
    const note = optionalNote(request.note);

    // Everything the write depends on is read inside the write transaction: a concurrent snapshot
    // replacement that drops a consulted solution between a pre-transaction read and the insert is
    // observed here, so an obsolete solution id is refused instead of being recorded against the
    // new head. A refusal writes nothing.
    return this.store.transaction(async (): Promise<WorkbenchRetrospectiveResult> => {
      token.throwIfCancelled();
      const problem = await this.store.getProblem(problemKey);
      token.throwIfCancelled();
      if (problem === null) {
        throw new DomainError('missing_reference', `problem ${problemKey} is not stored`, { problemKey });
      }
      const account = await this.requireAccount(accountId, token);
      if (account.sourceInstanceId !== problem.ref.sourceInstanceId) {
        throw sourceMismatch(account, problem.ref.sourceInstanceId);
      }
      const head = await this.store.getCurrentSnapshotHead(problem.ref);
      token.throwIfCancelled();
      const snapshot = head === null ? null : await this.store.getSnapshot(head.snapshotId);
      token.throwIfCancelled();
      const knownSolutions = new Set((snapshot?.solutions ?? []).map((solution) => solution.solutionId));
      for (const solutionId of solutionIds) {
        invariant(
          knownSolutions.has(solutionId),
          'missing_reference',
          `solution ${solutionId} is not part of the current snapshot of ${problemKey}`,
          { reason: 'unknown_solution', solutionId, problemKey, snapshotId: head?.snapshotId ?? null },
        );
      }
      const history = await this.store.listRetrospectives(account.id);
      token.throwIfCancelled();
      const previous = history
        .filter((entry) => entry.problemKey === problemKey)
        .reduce<string | null>(
          (latest, entry) => (latest === null || Date.parse(entry.recordedAt) > Date.parse(latest) ? entry.recordedAt : latest),
          null,
        );
      const retrospective = createRetrospective({
        problemRef: problem.ref,
        accountId: account.id,
        mode,
        recordedAt: monotonicInstant(previous, this.now()),
        taxonomyIds,
        solutionIds,
        note,
      });
      await this.store.saveRetrospective(retrospective);
      token.throwIfCancelled();
      return {
        problemKey,
        accountId: account.id,
        retrospectiveId: retrospective.retrospectiveId,
        mode: retrospective.mode,
        taxonomyIds: retrospective.taxonomyIds,
        solutionIds: retrospective.solutionIds,
        recordedAt: retrospective.recordedAt,
        note: retrospective.note,
        recorded: true,
      };
    });
  }

  // -------------------------------------------------------------------------------------
  // Internal reads
  // -------------------------------------------------------------------------------------

  private async requireAccount(accountId: string, token: CancellationToken): Promise<Account> {
    const account = await this.store.getAccount(accountId);
    token.throwIfCancelled();
    if (account === null) {
      throw new DomainError('missing_reference', `account ${accountId} is not stored`, { accountId });
    }
    return account;
  }

  /** Latest analysis that still targets the stored head; used only as audit context. */
  private async currentAnalysisId(problem: NormalizedProblem, token: CancellationToken): Promise<string | null> {
    const head = await this.store.getCurrentSnapshotHead(problem.ref);
    token.throwIfCancelled();
    if (head === null) {
      return null;
    }
    const analyses = await this.store.listAnalyses(problem.key);
    token.throwIfCancelled();
    const current = analyses
      .filter((analysis) => !analysisIsStale(analysis, head))
      .sort((left, right) => {
        const instant = Date.parse(left.createdAt) - Date.parse(right.createdAt);
        return instant !== 0 ? instant : left.analysisId.localeCompare(right.analysisId);
      });
    return current.at(-1)?.analysisId ?? null;
  }

  private async latestRetrospectiveOf(
    accountId: string,
    problemKey: string,
    token: CancellationToken,
  ): Promise<Retrospective | null> {
    const history = await this.store.listRetrospectives(accountId);
    token.throwIfCancelled();
    return latestRetrospectiveByProblem(history).get(`${accountId}|${problemKey}`) ?? null;
  }

  private async projectSummary(
    problem: NormalizedProblem,
    solved: boolean,
    visible: boolean,
    pendingReview: boolean,
    token: CancellationToken,
  ): Promise<WorkbenchProblemSummary> {
    const summary: WorkbenchProblemSummary = {
      problemKey: problem.key,
      sourceInstanceId: problem.ref.sourceInstanceId,
      domain: problem.ref.domain,
      externalKey: problem.ref.externalKey,
      title: problem.title,
      url: problem.url,
      fetchedAt: problem.fetchedAt,
      rawRatings: problem.ratings.map(ratingView),
      solvedByAccount: solved,
      pendingReview: pendingReview ? true : null,
    };
    if (!visible) {
      // A withheld row carries no tag fields at all: `rawTags: null` would read as "this problem
      // has no tags" and would have to be re-checked by every consumer.
      return summary;
    }
    return {
      ...summary,
      rawTags: problem.rawTags.map((tag) => tag.raw),
      effectiveTaxonomyIds: await this.tagMaterialOf(problem, token),
    };
  }

  /** Effective ids of one problem; decisions first, head last (inside the caller's read transaction). */
  private async tagMaterialOf(problem: NormalizedProblem, token: CancellationToken): Promise<readonly string[]> {
    const decisions = await this.store.listTagDecisions(problem.key);
    token.throwIfCancelled();
    // The head read after the decisions is the final authority inside the read transaction, so a
    // head that already moved can never leave stale AI output effective in this projection.
    const head = await this.store.getCurrentSnapshotHead(problem.ref);
    token.throwIfCancelled();
    return effectiveCurrentTaxonomyIds(decisions, head);
  }

  /** Distinct problems this account solved, from its own accepted submissions (bounded walk). */
  private async solvedKeys(accountId: string, token: CancellationToken): Promise<ReadonlySet<string>> {
    const solved = new Set<string>();
    for await (const submissions of this.submissionPages(accountId, token)) {
      for (const submission of submissions) {
        if (isAccepted(submission)) {
          solved.add(submission.key);
        }
      }
    }
    return solved;
  }

  /** True when this account has an accepted submission for this problem (bounded walk). */
  private async isSolvedBy(accountId: string, problemKey: string, token: CancellationToken): Promise<boolean> {
    for await (const submissions of this.submissionPages(accountId, token)) {
      if (submissions.some((submission) => submission.key === problemKey && isAccepted(submission))) {
        return true;
      }
    }
    return false;
  }

  /**
   * One bounded page walk over an account's submission history.
   *
   * The running count is incremented and checked **before** a page is yielded and before a terminal
   * `null` cursor returns, so more than {@link MAX_ACCOUNT_SUBMISSIONS} stored submissions is a
   * typed refusal in every case — including a 50,001st row on the final page, which an
   * after-the-yield check used to wave through. A truncated history could hide the one AC that
   * decides whether a problem counts as solved.
   */
  private async *submissionPages(
    accountId: string,
    token: CancellationToken,
  ): AsyncGenerator<readonly Submission[], void, void> {
    let cursor: string | null = null;
    let scanned = 0;
    for (;;) {
      const page = await this.store.listSubmissions(accountId, { limit: WORKBENCH_SUBMISSION_PAGE_SIZE, cursor });
      token.throwIfCancelled();
      scanned += page.items.length;
      invariant(
        scanned <= MAX_ACCOUNT_SUBMISSIONS,
        'invalid_input',
        `account ${accountId} has more than ${MAX_ACCOUNT_SUBMISSIONS} stored submissions; solved status cannot be decided from a truncated history`,
        { reason: 'submission_history_overflow', accountId, scanned, bound: MAX_ACCOUNT_SUBMISSIONS },
      );
      yield page.items;
      cursor = page.nextCursor;
      if (cursor === null) {
        return;
      }
    }
  }

  private mintId(): string {
    const value = this.uniqueId();
    invariant(
      typeof value === 'string' && value.trim().length > 0,
      'invalid_input',
      'uniqueId() must return a non-empty string',
      { value },
    );
    return value;
  }
}

// ---------------------------------------------------------------------------------------
// Pure projection helpers
// ---------------------------------------------------------------------------------------

/**
 * Stored decisions that still count for the effective view.
 *
 * Manual and rule decisions are not snapshot-scoped and always count; a model decision counts only
 * while it still targets the stored head, so stale AI output can never keep a tag effective.
 */
function currentStoredDecisions(decisions: readonly TagDecision[], head: SnapshotHead | null): readonly TagDecision[] {
  return decisions.filter((decision) => {
    if (decision.origin !== 'ai') {
      return true;
    }
    return head !== null && decision.snapshotId === head.snapshotId && decision.snapshotVersion === head.version;
  });
}

/** Effective taxonomy ids of a problem after dropping stale AI decisions (sorted, deduplicated). */
export function effectiveCurrentTaxonomyIds(
  decisions: readonly TagDecision[],
  head: SnapshotHead | null,
): readonly string[] {
  return [...currentDecisionPerTag(currentStoredDecisions(decisions, head)).values()]
    .filter((decision) => decisionIsEffective(decision))
    .map((decision) => decision.taxonomyId)
    .sort();
}

/** The one current decision per taxonomy id, with stale AI decisions excluded (sorted by tag). */
export function currentTagDecisionViews(
  decisions: readonly TagDecision[],
  head: SnapshotHead | null,
): readonly WorkbenchTagDecisionView[] {
  return [...currentDecisionPerTag(currentStoredDecisions(decisions, head)).values()]
    .sort((left, right) => left.taxonomyId.localeCompare(right.taxonomyId))
    .map((decision) => ({
      decisionId: decision.decisionId,
      taxonomyId: decision.taxonomyId,
      status: decision.status,
      origin: decision.origin,
      analysisId: decision.analysisId,
      decidedAt: decision.decidedAt,
      reasons: [...decision.reasons],
      evidence: decision.evidence.map(evidenceView),
    }));
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

function requireToken(token: CancellationToken | null | undefined): CancellationToken {
  invariant(
    token !== null && token !== undefined && typeof token.throwIfCancelled === 'function',
    'unfilled_settings',
    'a cancellation token is required',
    {},
  );
  return token;
}

function parseListRequest(request: WorkbenchListRequest): ListFilters {
  invariant(request !== null && typeof request === 'object', 'invalid_input', 'listProblems needs a request object', {});
  return {
    sourceInstanceId: optionalId('sourceInstanceId', request.sourceInstanceId),
    accountId: optionalId('accountId', request.accountId),
    onlyAttempted: optionalFlag('onlyAttempted', request.onlyAttempted),
    query: normalizeProblemQuery(request.query),
    needsReviewOnly: optionalFlag('needsReviewOnly', request.needsReviewOnly),
    reveal: optionalFlag('reveal', request.reveal),
    limit: requirePageLimit(request.limit),
    cursor: optionalCursor(request.cursor),
  };
}

/** Optional opaque id: omitted/`null` means "no scope", a non-empty string is passed through. */
function optionalId(name: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string' && value.length > 0, 'invalid_input', `${name} must be a non-empty string`, {
    name,
    value,
  });
  return value;
}

/** Optional flag: omitted/`null` is `false`, anything that is not a boolean is rejected. */
function optionalFlag(name: string, value: boolean | null | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  invariant(typeof value === 'boolean', 'invalid_input', `${name} must be a boolean when present`, { name, value });
  return value;
}

function optionalCursor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string' && value.length > 0, 'invalid_input', 'cursor must be a non-empty string', {
    value,
  });
  return value;
}

function requirePageLimit(limit: number): number {
  invariant(
    Number.isInteger(limit) && limit >= STORAGE_PAGE_LIMITS.minPageSize && limit <= STORAGE_PAGE_LIMITS.maxPageSize,
    'invalid_input',
    `page limit must be an integer within ${STORAGE_PAGE_LIMITS.minPageSize}..${STORAGE_PAGE_LIMITS.maxPageSize}`,
    { limit },
  );
  return limit;
}

/**
 * Whole-bank search term.
 *
 * The term is trimmed, bounded and matched literally (never as a pattern), so `%`, `_` and quotes
 * are ordinary characters and an over-long term is refused instead of being silently truncated.
 */
export function normalizeProblemQuery(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string', 'invalid_input', 'query must be a string', { value });
  const trimmed = value.trim();
  invariant(
    trimmed.length > 0 && trimmed.length <= MAX_PROBLEM_QUERY_CHARS,
    'invalid_input',
    `query must be 1..${MAX_PROBLEM_QUERY_CHARS} characters`,
    { length: trimmed.length },
  );
  return trimmed;
}

function requireProblemKeyInput(value: string | null | undefined): string {
  invariant(typeof value === 'string' && value.trim().length > 0, 'invalid_input', 'problemKey is required', { value });
  return value.trim();
}

function requireTaxonomyId(value: string): string {
  invariant(typeof value === 'string' && value.trim().length > 0, 'invalid_input', 'taxonomyId is required', { value });
  return value.trim();
}

function optionalNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string', 'invalid_input', 'note must be a string when present', { value });
  const trimmed = value.trim();
  invariant(trimmed.length <= MAX_REVIEW_NOTE_CHARS, 'invalid_input', `note must be at most ${MAX_REVIEW_NOTE_CHARS} characters`, {
    length: trimmed.length,
  });
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Validate a list of opaque ids (no lookup yet); duplicates are removed, order preserved.
 *
 * The array bound is checked before the loop, so a huge list cannot force an unbounded validation
 * or dedup pass; duplicates are tracked in a set, which keeps the pass linear within the bound.
 */
function requireIdList(name: string, value: readonly string[] | null | undefined): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  invariant(Array.isArray(value), 'invalid_input', `${name} must be an array of ids`, { name, value });
  invariant(
    value.length <= MAX_RETROSPECTIVE_IDS,
    'invalid_input',
    `${name} must hold at most ${MAX_RETROSPECTIVE_IDS} ids`,
    { name, length: value.length, bound: MAX_RETROSPECTIVE_IDS, reason: 'id_list_too_long' },
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    invariant(typeof entry === 'string' && entry.trim().length > 0, 'invalid_input', `${name} entries must be non-empty strings`, {
      name,
      entry,
    });
    const trimmed = entry.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/** Validate taxonomy ids against the injected vocabulary; unknown ids are a hard error. */
function requireTaxonomyIds(taxonomy: TaxonomyIndex, value: readonly string[] | null | undefined): readonly string[] {
  return requireIdList('taxonomyIds', value).map((taxonomyId) => assertKnownTag(taxonomy, taxonomyId));
}

/** `now()`, or one millisecond after the previous record when the clock repeats. */
function monotonicInstant(previous: string | null, now: string): string {
  const at = assertIsoTimestamp('now', now);
  if (previous === null) {
    return at;
  }
  const previousMs = Date.parse(previous);
  return Date.parse(at) > previousMs ? at : new Date(previousMs + 1).toISOString();
}

function latestDecidedAt(decisions: readonly ManualTagDecision[]): string | null {
  return decisions.reduce<string | null>(
    (latest, decision) => (latest === null || Date.parse(decision.decidedAt) > Date.parse(latest) ? decision.decidedAt : latest),
    null,
  );
}

function sourceMismatch(account: Account, sourceInstanceId: string): DomainError {
  return new DomainError(
    'invalid_input',
    `account ${account.id} belongs to ${account.sourceInstanceId}, not to ${sourceInstanceId}`,
    { reason: 'account_source_mismatch', accountId: account.id, accountSource: account.sourceInstanceId, sourceInstanceId },
  );
}

/** Fingerprint binding a cursor to the complete filter set that produced it. */
function listFingerprint(filters: ListFilters): string {
  const accountId = filters.accountId === null ? { scope: 'none' } : { scope: 'account', id: filters.accountId };
  return contentHashOf({
    sourceInstanceId: filters.sourceInstanceId,
    accountId,
    onlyAttempted: filters.onlyAttempted,
    query: filters.query,
    needsReviewOnly: filters.needsReviewOnly,
    reveal: filters.reveal,
  }).slice(0, 32);
}

function encodeProblemCursor(fingerprint: string, storeCursor: string): string {
  return `${CURSOR_PREFIX}:${fingerprint}:${storeCursor}`;
}

/** Decode a workbench cursor, refusing one minted for a different filter set. */
function decodeProblemCursor(cursor: string, fingerprint: string): string {
  const prefix = `${CURSOR_PREFIX}:`;
  invariant(
    cursor.startsWith(prefix),
    'invalid_input',
    'cursor is not a workbench problem cursor',
    { cursor },
  );
  const rest = cursor.slice(prefix.length);
  const separator = rest.indexOf(':');
  invariant(separator > 0, 'invalid_input', 'workbench problem cursor is malformed', { cursor });
  const bound = rest.slice(0, separator);
  const storeCursor = rest.slice(separator + 1);
  invariant(
    bound === fingerprint,
    'invalid_input',
    'workbench problem cursor belongs to a different filter set; re-read the first page',
    { cursor, reason: 'cursor_filter_mismatch' },
  );
  invariant(storeCursor.length > 0, 'invalid_input', 'workbench problem cursor holds no store cursor', { cursor });
  return storeCursor;
}

// ---------------------------------------------------------------------------------------
// Pure DTO projections
// ---------------------------------------------------------------------------------------

function ratingView(rating: NormalizedProblem['ratings'][number]): WorkbenchRatingView {
  return {
    dimension: rating.dimension,
    value: rating.value,
    scale: rating.scale === null ? null : { min: rating.scale.min, max: rating.scale.max },
    raw: rating.raw,
  };
}

function evidenceView(evidence: { sourceId: string; solutionId: string; excerpt: string; note?: string | null }): WorkbenchEvidenceView {
  return {
    sourceId: evidence.sourceId,
    solutionId: evidence.solutionId,
    excerpt: evidence.excerpt,
    note: evidence.note ?? null,
  };
}

function sourceView(source: ProblemSnapshot['sources'][number]): WorkbenchEditorialSourceView {
  return {
    sourceId: source.id,
    kind: source.kind,
    url: source.url,
    title: source.title,
    author: source.author,
    language: source.language,
    publishedAt: source.publishedAt,
    availability: source.availability,
    contentHash: source.contentHash,
  };
}

function solutionView(solution: ProblemSnapshot['solutions'][number]): WorkbenchSolutionView {
  return {
    solutionId: solution.solutionId,
    sourceId: solution.sourceId,
    ordinal: solution.ordinal,
    title: solution.title,
    text: solution.text,
    language: solution.language,
  };
}

/** Snapshot head plus counts; bodies are added only when `visible`. */
function snapshotView(snapshot: ProblemSnapshot, visible: boolean): WorkbenchSnapshotView {
  const view: WorkbenchSnapshotView = {
    snapshotId: snapshot.snapshotId,
    version: snapshot.version,
    contentHash: snapshot.contentHash,
    capturedAt: snapshot.capturedAt,
    sourceCount: snapshot.sources.length,
    solutionCount: snapshot.solutions.length,
  };
  if (!visible) {
    // The counts stay (they are metadata); the bodies are absent, never nulled.
    return view;
  }
  return {
    ...view,
    sources: snapshot.sources.map(sourceView),
    solutions: snapshot.solutions.map(solutionView),
  };
}

function verificationView(verification: SuggestionVerification): WorkbenchVerificationView {
  return {
    verificationId: verification.verificationId,
    verdict: verification.verdict,
    verifierRole: verification.verifierRole,
    evidenceOk: verification.evidenceOk,
    conflictingSolutionIds: [...verification.conflictingSolutionIds],
    note: verification.note,
    checkedAt: verification.checkedAt,
  };
}

function suggestionViews(analysis: AnalysisResult): readonly WorkbenchSuggestionView[] {
  return analysis.suggestions.map((suggestion) => {
    const verification = verificationFor(analysis, suggestion.suggestionId);
    return {
      suggestionId: suggestion.suggestionId,
      taxonomyId: suggestion.taxonomyId,
      role: suggestion.role,
      rationale: suggestion.rationale,
      evidence: suggestion.evidence.map(evidenceView),
      createdAt: suggestion.createdAt,
      verification: verification === null ? null : verificationView(verification),
    };
  });
}

function draftViews(analysis: AnalysisResult): readonly WorkbenchReasoningDraftView[] {
  return analysis.reasoningDrafts.map((draft) => ({
    draftId: draft.draftId,
    taxonomyIds: [...draft.taxonomyIds],
    rationale: draft.rationale,
    evidence: draft.evidence.map(evidenceView),
    createdAt: draft.createdAt,
  }));
}

/** One analysis with an explicit current-vs-stale indicator against the stored head. */
function analysisView(analysis: AnalysisResult, head: SnapshotHead | null): WorkbenchAnalysisView {
  const stale = analysisIsStale(analysis, head);
  return {
    analysisId: analysis.analysisId,
    snapshotId: analysis.snapshotId,
    snapshotVersion: analysis.snapshotVersion,
    taxonomyVersion: analysis.taxonomyVersion,
    createdAt: analysis.createdAt,
    status: analysis.status,
    current: !stale,
    stale,
    suggestions: suggestionViews(analysis),
    reasoningDrafts: draftViews(analysis),
    failure:
      analysis.failure === null
        ? null
        : { code: analysis.failure.code, message: analysis.failure.message, retryable: analysis.failure.retryable },
    usage: analysis.usage,
  };
}

function manualDecisionView(decision: ManualTagDecision): WorkbenchManualDecisionView {
  return {
    decisionId: decision.decisionId,
    taxonomyId: decision.taxonomyId,
    action: decision.action,
    decidedAt: decision.decidedAt,
    note: decision.note,
    supersedesAnalysisId: decision.supersedesAnalysisId,
  };
}

/**
 * Retrospective metadata, plus the solved-work fields only when `visible`.
 *
 * While withheld, `taxonomyIds`, `solutionIds` and `note` are absent own properties: the note can
 * describe an algorithm, so a `null` placeholder would be indistinguishable from "no note".
 */
function retrospectiveView(retrospective: Retrospective, visible: boolean): WorkbenchRetrospectiveView {
  const view: WorkbenchRetrospectiveView = {
    retrospectiveId: retrospective.retrospectiveId,
    problemKey: retrospective.problemKey,
    accountId: retrospective.accountId,
    mode: retrospective.mode,
    recordedAt: retrospective.recordedAt,
  };
  if (!visible) {
    return view;
  }
  return {
    ...view,
    taxonomyIds: [...retrospective.taxonomyIds],
    solutionIds: [...retrospective.solutionIds],
    note: retrospective.note,
  };
}
