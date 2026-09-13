/**
 * Workbench service (Stages 4w1a–4w1b): `listProblems`, `getProblem`, `reviewTag`,
 * `recordRetrospective`, `weakness` and the training-plan operations (`previewPlan`, `listPlans`,
 * `getPlan`, `adoptPlan`, `editPlanTask`, `checkOffTask`).
 *
 * The service owns policy — paging, whole-bank search, the review queue, spoiler discipline,
 * manual precedence, retrospective validation, bounded statistics and plan CAS — while the
 * injected store owns durability and the injected taxonomy owns tag identity. It never reads a
 * clock directly (every timestamp comes from `now()`), never fabricates a title, URL, candidate or
 * solution body, and never spreads a stored snapshot or plan into a response: every DTO is built
 * field by field, so a withheld spoiler field is an *absent* own property instead of a `null` that
 * a caller could read as "empty". Plan mutations re-read the stored plan inside their transaction
 * and compare the caller's full content hash before transitioning, so a stale screen can never
 * overwrite a newer edit.
 *
 * Failures are typed: `missing_reference` for an unknown problem/account/solution/plan, `invalid_input`
 * for malformed or foreign-scope arguments and for persisted rows that are incoherent with the scope
 * they are read for (each with a machine-readable `reason`), `invalid_transition` for a stale plan
 * hash or a refused domain transition, `unknown_taxonomy_id` for an unknown tag, and `cancelled` on
 * cancellation. A stored row that names another account or source instance is refused instead of
 * filtered: a silently smaller history would describe a different account. Cancellation is checked
 * after every awaited write, so a cancelled review or preview rolls its transaction back instead of
 * leaving a half-recorded one.
 */
import { validateAbilityCalibration, validateCalibrationRange, type AbilityCalibration, type AbilityCalibrationRange } from '../domain/ability-calibration.js';
import {
  COMPLETION_MODES,
  DomainError,
  TRAINING_TASK_KINDS,
  adoptPlan as adoptTrainingPlan,
  aggregateAbilityForPlanning,
  analysisIsStale,
  assertIsoTimestamp,
  assertKnownTag,
  checkOffTask as checkOffTrainingTask,
  completenessIsCurrent,
  computeAbilityAssessment,
  computeKnowledgeEvidence,
  computeTrainingStatistics,
  computeWeaknessReports,
  contentHashOf,
  createManualTagDecision,
  createRetrospective,
  createTagDecision,
  createTrainingCandidate,
  decisionIsEffective,
  editPlanTask as editTrainingTask,
  expectedRatingDimension,
  generateRulePlan,
  invariant,
  isAccepted,
  latestRetrospectiveByProblem,
  manualDecisionsForProblem,
  mergedGroupKeyOf,
  parseProblemKey,
  previewPlan as summariseTrainingPlan,
  problemKey,
  reportForAccount,
  verificationFor,
  type Account,
  type AccountWeaknessReport,
  COMPLETENESS_AUDIT_VERSION,
  type AnalysisResult,
  type BeginnerRecommendation,
  type CancellationToken,
  type CompletionMode,
  type ManualTagAction,
  type ManualTagDecision,
  type NormalizedProblem,
  type PlanTaskPatch,
  type ProblemRef,
  type ProblemSnapshot,
  type RejectedCandidate,
  type Retrospective,
  type SnapshotHead,
  type Submission,
  type SuggestionVerification,
  type TagDecision,
  type TaxonomyIndex,
  type TrainingCandidate,
  type TrainingEvidence,
  type TrainingPlan,
  type TrainingTask,
  type TrainingTaskKind,
} from '../domain/index.js';
import { currentDecisionPerTag } from '../domain/tags.js';
import { MergedBankService, type MergedBankBrowseRequest } from './merged-bank-service.js';
import {
  BROWSE_PAGE_LIMITS,
  MAX_RATING_DIMENSION_CHARS,
  PROBLEM_SOLVED_FILTERS,
  PROBLEM_SORTS,
  RATING_SORTS,
  type ProblemSolvedFilter,
  type ProblemSort,
  type TrainingStore,
} from './ports.js';
import { STORAGE_PAGE_LIMITS } from './storage-types.js';
import {
  MAX_PLANNING_CANDIDATES,
  planPreparationEvidenceHash,
  type PlanAttemptCandidate,
  type PlanAttemptExclusions,
  type PlanAttemptPreparation,
  type PlanPreparationBundle,
  type PlanPreparationRequest,
  type PlanRevalidationResult,
  type PlanStalenessReason,
} from './planning-types.js';
import type {
  WorkbenchAnalysisView,
  WorkbenchEditorialSourceView,
  WorkbenchEvidenceView,
  WorkbenchManualDecisionView,
  WorkbenchPlanEvidenceView,
  WorkbenchPlanBeginnerRecommendationView,
  WorkbenchPlanListResult,
  WorkbenchPlanPreviewResult,
  WorkbenchPlanRejectedCandidateView,
  WorkbenchPlanSettingsView,
  WorkbenchPlanTaskPatch,
  WorkbenchPlanTaskView,
  WorkbenchPlanView,
  WorkbenchPlatformTagStatsView,
  WorkbenchMergedBrowsePage,
  WorkbenchProblemBrowsePage,
  WorkbenchProblemDetail,
  WorkbenchProblemPage,
  WorkbenchProblemSummary,
  WorkbenchRatingView,
  WorkbenchReasoningDraftView,
  WorkbenchRetrospectiveResult,
  WorkbenchRetrospectiveView,
  WorkbenchSnapshotView,
  WorkbenchSolutionView,
  WorkbenchSolvedDistributionView,
  WorkbenchSuggestionView,
  WorkbenchTagDecisionView,
  WorkbenchTagReviewResult,
  WorkbenchVerificationView,
  WorkbenchWeaknessCoverage,
  WorkbenchWeaknessResult,
} from './workbench-types.js';

/** Store rows read per internal walk of one account's submission history. */
export const WORKBENCH_SUBMISSION_PAGE_SIZE = 500;

/** Hard bound of one submission-history walk; exceeding it is an explicit refusal, not truncation. */
export const MAX_ACCOUNT_SUBMISSIONS = 50_000;

/** Maximum accepted `query` length; longer input is rejected instead of being truncated. */
export const MAX_PROBLEM_QUERY_CHARS = 200;

/** Maximum page size of one numbered bank page (`browseProblems`); the UI offers 25/50/100. */
export const MAX_BROWSE_PAGE_SIZE = BROWSE_PAGE_LIMITS.maxPageSize;

/** Maximum accepted review note length. */
export const MAX_REVIEW_NOTE_CHARS = 2000;

/**
 * Maximum accepted entries in one `taxonomyIds`/`solutionIds` list.
 *
 * The bound is enforced before any per-entry work, so a caller cannot force an unbounded scan (or
 * an unbounded dedup) with a huge array; a longer list is refused rather than truncated.
 */
export const MAX_RETROSPECTIVE_IDS = 500;

/** Minimum distinct attempted problems before a tag enters the weakness ranking (domain gate). */
export const WORKBENCH_MIN_WEAKNESS_SAMPLE = 5;

/** Distinct attempted problems one weakness read accepts; more is an explicit refusal. */
export const MAX_WEAKNESS_DISTINCT_PROBLEMS = 20_000;

/** Tag-decision rows one weakness read accepts across all attempted problems. */
export const MAX_WEAKNESS_DECISIONS = 50_000;

/** Retrospective rows one weakness read accepts for the selected account. */
export const MAX_WEAKNESS_RETROSPECTIVES = 50_000;

/** Maximum distinct candidate problems one plan preview accepts. */
export const MAX_PLAN_CANDIDATES = 500;

/** Approved bounds of the plan settings (defaults: 7 days, 60 minutes/day, 30 minutes/problem). */
export const MAX_PLAN_HORIZON_DAYS = 30;
export const MAX_PLAN_MINUTES_PER_DAY = 480;
export const MAX_PLAN_ESTIMATED_MINUTES = 480;
export const DEFAULT_PLAN_HORIZON_DAYS = 7;
export const DEFAULT_PLAN_MINUTES_PER_DAY = 60;
export const DEFAULT_PLAN_ESTIMATED_MINUTES = 30;

/** Maximum scheduled tasks per day in a rule-generated plan. */
export const PLAN_MAX_TASKS_PER_DAY = 3;

/**
 * Pages of the unsolved bank one AI plan preparation may walk.
 *
 * A preparation asks for at most {@link MAX_PLANNING_CANDIDATES} candidates, so one page normally
 * suffices; the extra pages only absorb canonical-duplicate collapses. The bound makes the walk
 * finite even against a store that keeps answering the same page.
 */
export const MAX_PLAN_CANDIDATE_PAGES = 5;

/** Maximum accepted plan title length. */
export const MAX_PLAN_TITLE_CHARS = 200;

/** Explains why raw platform tags are reported next to, never inside, the weakness report. */
const RAW_TAG_PROVENANCE_NOTE =
  'Raw platform tags are original, unverified provenance; they are not effective taxonomy tags and never count as accepted.';

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

/**
 * Numbered bank page request (`browseProblems`).
 *
 * `status` and `onlyAttempted` are solved filters relative to `accountId` and are refused without
 * one; `page` is the 1-based page number that replaces the cursor contract of
 * {@link WorkbenchListRequest} for this operation.
 *
 * `sort` defaults to the legacy canonical-key ascending order, so an existing caller that omits it
 * (or sends `null`) keeps exactly the order it had. A difficulty sort additionally requires
 * `sourceInstanceId` and a non-empty `ratingDimension`: comparing ratings of two source instances,
 * or two platforms' dimensions, would invent a scale the platforms never agreed on. Changing the
 * sort is the caller's business — the service simply orders the whole filtered set before paging,
 * so `page: 1` is what a UI sends after the user picks a different order.
 */
export interface WorkbenchBrowseRequest {
  readonly sourceInstanceId?: string | null;
  readonly accountId?: string | null;
  /** Solved-state filter relative to the selected account; omitted/`null` means `all`. */
  readonly status?: ProblemSolvedFilter | null;
  /** Restrict the bank to problems this account submitted to; requires an explicit account. */
  readonly onlyAttempted?: boolean;
  /** Literal case-insensitive substring over title and external key, across the whole bank. */
  readonly query?: string | null;
  readonly reveal?: boolean;
  /** Keep only problems with an unresolved item at the current snapshot head. */
  readonly needsReviewOnly?: boolean;
  /** Ordering of the whole filtered set; omitted/`null` is the legacy canonical-key ascending order. */
  readonly sort?: ProblemSort | null;
  /** Raw rating dimension of a difficulty sort; required exactly for the difficulty sorts. */
  readonly ratingDimension?: string | null;
  /** 1-based page number. */
  readonly page: number;
  /** Page size within `1..MAX_BROWSE_PAGE_SIZE`. */
  readonly limit: number;
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

/** One account's weakness statistics. Training mutations always need an explicit account. */
export interface WorkbenchWeaknessRequest {
  readonly accountId: string;
}

/** Build one rule-based draft plan from an explicit, real candidate pool. */
export interface WorkbenchPlanPreviewRequest {
  readonly accountId: string;
  /** Stored problem keys to schedule; duplicates are collapsed, the first occurrence wins. */
  readonly candidateProblemKeys: readonly string[];
  readonly estimatedMinutes?: number | null;
  readonly horizonDays?: number | null;
  readonly minutesPerDay?: number | null;
  readonly title?: string | null;
  /** Show candidate tags/targets of problems this account has not solved. */
  readonly reveal?: boolean;
}

export interface WorkbenchPlanListRequest {
  readonly accountId: string;
  readonly reveal?: boolean;
}

export interface WorkbenchGetPlanRequest {
  readonly planId: string;
  readonly accountId: string;
  readonly reveal?: boolean;
}

/** Optimistic-concurrency request: `expectedHash` is the last returned full plan content hash. */
export interface WorkbenchPlanCasRequest {
  readonly planId: string;
  readonly accountId: string;
  readonly expectedHash: string;
}

export interface WorkbenchEditPlanTaskRequest extends WorkbenchPlanCasRequest {
  readonly taskId: string;
  /** Only the scheduling fields are accepted; identity, links and tags stay untouched. */
  readonly patch: WorkbenchPlanTaskPatch;
}

export interface WorkbenchCheckOffTaskRequest extends WorkbenchPlanCasRequest {
  readonly taskId: string;
  readonly status: 'done' | 'skipped';
}

/** Everything one weakness read collects, before the pure domain reduction runs. */
interface WeaknessEvidence {
  readonly submissions: readonly Submission[];
  readonly problems: readonly NormalizedProblem[];
  readonly decisions: readonly TagDecision[];
  readonly retrospectives: readonly Retrospective[];
  readonly coverage: WorkbenchWeaknessCoverage;
  readonly rawTags: readonly string[];
  readonly problemsWithRawTags: number;
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

/** Normalized numbered-page filter set; `status` and `sort` are always resolved to concrete values. */
interface BrowseFilters {
  readonly sourceInstanceId: string | null;
  readonly accountId: string | null;
  readonly status: ProblemSolvedFilter;
  readonly onlyAttempted: boolean;
  readonly query: string | null;
  readonly needsReviewOnly: boolean;
  readonly reveal: boolean;
  readonly sort: ProblemSort;
  /** Bound raw rating dimension of a difficulty sort; `null` for every other sort. */
  readonly ratingDimension: string | null;
  readonly page: number;
  readonly limit: number;
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
  /** Merged cross-site bank; it borrows this service's own summary projection. */
  private readonly merged: MergedBankService;

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
    // The merged bank is composed here, with this service's own summary projection as a callback: a
    // merged member row therefore applies exactly the same spoiler rule as a `problem.browse` row,
    // and the merged service stays a small delegate instead of a second spoiler implementation.
    this.merged = new MergedBankService({
      store: this.store,
      uniqueId: this.uniqueId,
      projectSummary: (problem, solved, visible, pendingReview, token) =>
        this.projectSummary(problem, solved, visible, pendingReview, token),
    });
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
      const solvedKeys = account === null || page.items.length === 0 ? null : await this.solvedKeys(account, token);
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
  // browseProblems
  // -------------------------------------------------------------------------------------

  /**
   * One numbered page of the problem bank, with the totals of exactly this filter set.
   *
   * This is the paging contract the bank UI uses: the store counts the filtered unique problems and
   * selects one `LIMIT/OFFSET` page inside the SAME transaction, so `totalItems`/`totalPages` can
   * never describe a different query than `items`, and no page is assembled by filtering a previous
   * one in the client. `status` and `onlyAttempted` are relative to the selected account and are
   * refused without one; `status: 'unconfirmed'` means "this account has no accepted submission",
   * which includes problems never attempted, while `onlyAttempted` stays an independent
   * intersection. Solved status is decided by SQL against this account's own accepted submissions
   * for the problem's full stored identity, and only when the account's stored source instance
   * matches the problem's, so another account, source instance or domain can never mark a row
   * solved. The store-reported verdict is re-checked here: a claim made without an account or for a
   * foreign source instance is refused, so a hostile port cannot reveal spoilers. Withheld spoiler
   * material stays absent unless a row is solved or `reveal` is
   * explicit, exactly like {@link WorkbenchService.listProblems}.
   */
  async browseProblems(request: WorkbenchBrowseRequest, token: CancellationToken): Promise<WorkbenchProblemBrowsePage> {
    requireToken(token);
    token.throwIfCancelled();
    const filters = parseBrowseRequest(request);
    // Count, selected page and projection share ONE store transaction: the totals and the rows they
    // describe are a single serialized read, so a concurrent write can never pair a fresh count with
    // a stale page (or the reverse) inside the same response.
    const stored = await this.store.transaction(async () => {
      token.throwIfCancelled();
      const account = filters.accountId === null ? null : await this.requireAccount(filters.accountId, token);
      if (account !== null && filters.sourceInstanceId !== null && account.sourceInstanceId !== filters.sourceInstanceId) {
        throw sourceMismatch(account, filters.sourceInstanceId);
      }
      // Both filters are statements about one account's own submission history; without an account
      // neither has an answer, so they are refused instead of being silently dropped.
      invariant(
        !filters.onlyAttempted || account !== null,
        'invalid_input',
        'onlyAttempted needs an explicit account id; there is no account whose attempts could be listed',
        { reason: 'only_attempted_without_account' },
      );
      invariant(
        filters.status === 'all' || account !== null,
        'invalid_input',
        'a solved-state filter needs an explicit account id; solved status is relative to one account',
        { reason: 'status_without_account', status: filters.status },
      );
      const page = await this.store.browseProblems({
        sourceInstanceId: filters.sourceInstanceId,
        accountId: account === null ? null : account.id,
        status: filters.status,
        onlyAttempted: filters.onlyAttempted,
        query: filters.query,
        needsReviewOnly: filters.needsReviewOnly,
        sort: filters.sort,
        ratingDimension: filters.ratingDimension,
        page: filters.page,
        limit: filters.limit,
      });
      token.throwIfCancelled();
      const items: WorkbenchProblemSummary[] = [];
      for (const row of page.items) {
        assertBrowsedProblemCoherent(row.problem, filters.sourceInstanceId);
        assertSolvedProjectionCoherent(row.problem, row.solvedByAccount, account);
        const visible = row.solvedByAccount || filters.reveal;
        items.push(
          await this.projectSummary(row.problem, row.solvedByAccount, visible, filters.needsReviewOnly, token),
        );
      }
      return {
        items,
        page: page.page,
        pageSize: page.pageSize,
        totalItems: page.totalItems,
        totalPages: page.totalPages,
        fetchedAt: page.fetchedAt,
      };
    });
    return {
      pageId: this.mintId(),
      ...stored,
      reveal: filters.reveal,
      pendingReviewOnly: filters.needsReviewOnly,
    };
  }

  // -------------------------------------------------------------------------------------
  // browseMergedProblems
  // -------------------------------------------------------------------------------------

  /**
   * One numbered page of the merged cross-site bank (Sprint Contract 08b).
   *
   * A thin delegate: {@link MergedBankService} owns the grouped read, the re-validation of every
   * store claim and the linked-evidence projection, and borrows this service's own summary
   * projection, so a member row is byte-identical to a `problem.browse` row and a linked solve can
   * never reveal a member's tags on its own. `problem.browse`/`problem.list` and their solved-state
   * semantics are untouched by this operation.
   */
  async browseMergedProblems(
    request: MergedBankBrowseRequest,
    token: CancellationToken,
  ): Promise<WorkbenchMergedBrowsePage> {
    return this.merged.browse(request, token);
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
      const solved = account === null ? false : await this.isSolvedBy(account, problemKey, token);
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
        analyses: analyses.map((analysis) => analysisView(analysis, head, this.taxonomy.taxonomy.version)),
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
  // weakness
  // -------------------------------------------------------------------------------------

  /** Save an explicit user range without touching platform records, retrospectives or earlier revisions. */
  async calibrateAbility(request: { readonly accountId: string; readonly expectedRevision: number; readonly range: AbilityCalibrationRange | null }, token: CancellationToken): Promise<AbilityCalibration> {
    requireToken(token); token.throwIfCancelled();
    const accountId = requireRequiredId('accountId', request.accountId);
    invariant(Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0, 'invalid_input', 'calibration expectedRevision must be nonnegative');
    const range = validateCalibrationRange(request.range);
    return this.store.transaction(async () => {
      const account = await this.requireAccount(accountId, token);
      const source = await this.store.getSourceInstance(account.sourceInstanceId);
      invariant(source?.platform === 'codeforces', 'invalid_input', 'CF self-assessment requires a Codeforces account');
      const record = validateAbilityCalibration({ accountId, revision: request.expectedRevision + 1, recordedAt: this.now(), source: 'self_report', scale: 'codeforces', range });
      token.throwIfCancelled();
      await this.store.saveAbilityCalibration(record, request.expectedRevision);
      token.throwIfCancelled();
      return record;
    });
  }

  /**
   * Distinct-problem weakness statistics for one account.
   *
   * The whole read is one serialized transaction over bounded data: the account's submissions are
   * walked once (<= {@link MAX_ACCOUNT_SUBMISSIONS} rows and <= {@link MAX_WEAKNESS_DISTINCT_PROBLEMS}
   * distinct problems), every attempted problem's decisions are read together with its stored head
   * so that only current AI decisions count, and the retrospective history is bounded as well. Any
   * overflow is a typed refusal — statistics computed from a silently truncated history would
   * describe a different sample. Raw platform tags come back separately as unverified provenance;
   * they never enter the report. Accounts are never mixed: only the selected account's rows are read.
   *
   * The same one evidence read also feeds the two additive, explicitly provisional projections: the
   * solved-problem distribution over this source's own raw difficulty dimension, and the raw
   * platform-label reference. Neither is formal evidence and neither reaches the weakness ranking or
   * a plan, which keeps using only effective/adopted tags.
   *
   * `knowledge` (Stage 09a) is the third additive projection over that same read: per-taxonomy-node
   * learning evidence whose raw, verified and retrospective channels stay distinguishable. It adds no
   * store read and leaves the formal report untouched.
   *
   * `ability` (Sprint 11a) is the fourth additive projection over that same read: a versioned local
   * practice summary plus a separately stored, account-scoped self-assessment. One additional
   * calibration read is performed; no platform or model is called.
   */
  async weakness(request: WorkbenchWeaknessRequest, token: CancellationToken): Promise<WorkbenchWeaknessResult> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(request !== null && typeof request === 'object', 'invalid_input', 'weakness needs a request object', {});
    const accountId = requireRequiredId('accountId', request.accountId);
    return this.store.transaction(async (): Promise<WorkbenchWeaknessResult> => {
      token.throwIfCancelled();
      const account = await this.requireAccount(accountId, token);
      const evidence = await this.collectWeaknessEvidence(account, token);
      // The source instance is the only extra read: it says which raw dimension this platform
      // reports, which the UI must always be able to render. The reduction itself reuses the
      // evidence above and never walks submissions, problems or the bank again.
      const source = await this.store.getSourceInstance(account.sourceInstanceId);
      token.throwIfCancelled();
      invariant(
        source !== null,
        'invalid_input',
        `account ${account.id} names source instance ${account.sourceInstanceId}, which is not stored`,
        { reason: 'source_instance_missing', accountId: account.id, sourceInstanceId: account.sourceInstanceId },
      );
      const statistics = computeTrainingStatistics({
        problems: evidence.problems,
        submissions: evidence.submissions,
        expectedDimension: expectedRatingDimension(source.platform),
        minimumSampleSize: WORKBENCH_MIN_WEAKNESS_SAMPLE,
      });
      // The knowledge reduction reuses exactly the evidence above: no additional storage,
      // platform or model read, and no change to the formal report beside it.
      const knowledge = computeKnowledgeEvidence({
        taxonomy: this.taxonomy,
        accountId: account.id,
        problems: evidence.problems,
        submissions: evidence.submissions,
        decisions: evidence.decisions,
        retrospectives: evidence.retrospectives,
        minimumIndependentProblems: WORKBENCH_MIN_WEAKNESS_SAMPLE,
      });
      // The ability assessment is a fourth pure projection over the very same evidence and the
      // injected clock. The account calibration is loaded separately; it never rewrites practice
      // evidence or turns an imported AC into an independently completed solve.
      const ability = computeAbilityAssessment({
        calibration: await this.store.getAbilityCalibration(account.id),
        accountId: account.id,
        sourceInstanceId: account.sourceInstanceId,
        platform: source.platform,
        problems: evidence.problems,
        submissions: evidence.submissions,
        retrospectives: evidence.retrospectives,
        now: this.now(),
      });
      return {
        report: this.weaknessReportOf(account, evidence),
        knowledge,
        ability,
        solvedDistribution: solvedDistributionView(statistics.solvedDistribution),
        platformTagStats: platformTagStatsView(statistics.platformTagStats),
        coverage: evidence.coverage,
        rawTagProvenance: {
          problemsWithRawTags: evidence.problemsWithRawTags,
          distinctRawTags: evidence.rawTags,
          verified: false,
          note: RAW_TAG_PROVENANCE_NOTE,
        },
      };
    });
  }

  // -------------------------------------------------------------------------------------
  // previewPlan
  // -------------------------------------------------------------------------------------

  /**
   * Generate and store one rule-based draft plan from an explicit candidate pool.
   *
   * Candidates are looked up in the store — never taken from the request body — and must belong to
   * the account's source instance; their effective tags are resolved at the current head, so stale
   * AI decisions cannot steer the schedule. Generation is pure and model-free (`generateRulePlan`);
   * an empty or unusable pool returns the domain's honest `insufficient_evidence` with starter
   * recommendations and stores nothing. A successful draft is written in one transaction, and the
   * returned `contentHash` is the full hash of the *stored* plan, which later mutations must present.
   */
  async previewPlan(request: WorkbenchPlanPreviewRequest, token: CancellationToken): Promise<WorkbenchPlanPreviewResult> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(request !== null && typeof request === 'object', 'invalid_input', 'previewPlan needs a request object', {});
    const accountId = requireRequiredId('accountId', request.accountId);
    const candidateProblemKeys = requireCandidateKeys(request.candidateProblemKeys);
    const settings: WorkbenchPlanSettingsView = {
      estimatedMinutes: boundedInt(
        'estimatedMinutes',
        request.estimatedMinutes,
        DEFAULT_PLAN_ESTIMATED_MINUTES,
        1,
        MAX_PLAN_ESTIMATED_MINUTES,
      ),
      horizonDays: boundedInt('horizonDays', request.horizonDays, DEFAULT_PLAN_HORIZON_DAYS, 1, MAX_PLAN_HORIZON_DAYS),
      minutesPerDay: boundedInt(
        'minutesPerDay',
        request.minutesPerDay,
        DEFAULT_PLAN_MINUTES_PER_DAY,
        1,
        MAX_PLAN_MINUTES_PER_DAY,
      ),
    };
    const reveal = optionalFlag('reveal', request.reveal);
    const title = optionalPlanTitle(request.title);

    return this.store.transaction(async (): Promise<WorkbenchPlanPreviewResult> => {
      token.throwIfCancelled();
      const account = await this.requireAccount(accountId, token);
      const evidence = await this.collectWeaknessEvidence(account, token);
      const report = this.weaknessReportOf(account, evidence);
      const weakTagIds = new Set(report.ranking.map((tag) => tag.taxonomyId));

      const candidates: TrainingCandidate[] = [];
      for (const candidateKey of candidateProblemKeys) {
        const problem = await this.store.getProblem(candidateKey);
        token.throwIfCancelled();
        if (problem === null) {
          throw new DomainError('missing_reference', `candidate problem ${candidateKey} is not stored`, {
            reason: 'unknown_candidate',
            problemKey: candidateKey,
          });
        }
        invariant(
          problem.ref.sourceInstanceId === account.sourceInstanceId,
          'invalid_input',
          `candidate ${candidateKey} belongs to ${problem.ref.sourceInstanceId}, not to account ${account.id}`,
          {
            reason: 'candidate_source_mismatch',
            problemKey: candidateKey,
            accountId: account.id,
            candidateSource: problem.ref.sourceInstanceId,
            accountSource: account.sourceInstanceId,
          },
        );
        const decisions = await this.store.listTagDecisions(candidateKey);
        token.throwIfCancelled();
        const head = await this.store.getCurrentSnapshotHead(problem.ref);
        token.throwIfCancelled();
        const taxonomyIds = effectiveCurrentTaxonomyIds(decisions, head);
        candidates.push(
          createTrainingCandidate({
            candidateId: this.mintCandidateId(),
            problemRef: problem.ref,
            title: problem.title,
            sourceUrl: problem.url,
            estimatedMinutes: settings.estimatedMinutes,
            taxonomyIds,
            ratings: problem.ratings,
            origin: taxonomyIds.some((taxonomyId) => weakTagIds.has(taxonomyId)) ? 'weakness' : 'unsolved_pool',
          }),
        );
      }

      // Permission and cancellation are re-checked immediately before the write: a plan must never
      // be stored for an account that was removed or repointed while the preview was being built.
      token.throwIfCancelled();
      const confirmed = await this.store.getAccount(account.id);
      token.throwIfCancelled();
      invariant(
        confirmed !== null && confirmed.sourceInstanceId === account.sourceInstanceId,
        'invalid_transition',
        `account ${account.id} changed before the plan was written`,
        { reason: 'account_changed', accountId: account.id },
      );

      const generated = generateRulePlan({
        candidates,
        weaknessReports: [report],
        settings: { horizonDays: settings.horizonDays, minutesPerDay: settings.minutesPerDay, maxTasksPerDay: PLAN_MAX_TASKS_PER_DAY },
        now: this.now(),
        accountId: account.id,
        taxonomy: this.taxonomy,
        title: title ?? undefined,
      });
      if (!generated.ok) {
        return {
          outcome: 'insufficient_evidence',
          reason: 'insufficient_evidence',
          evidence: planEvidenceView(generated.evidence),
          beginnerRecommendations: generated.beginnerRecommendations.map(beginnerRecommendationView),
          rejectedCandidates: generated.rejectedCandidates.map(rejectedCandidateView),
          settings,
        };
      }
      await this.store.savePlan(generated.plan);
      token.throwIfCancelled();
      const written = await this.rereadPlan(generated.plan.planId, generated.plan, token);
      return {
        outcome: 'draft',
        plan: this.projectPlan(written, solvedKeysOf(evidence.submissions), reveal),
        settings,
        rejectedCandidates: generated.rejectedCandidates.map(rejectedCandidateView),
      };
    });
  }

  // -------------------------------------------------------------------------------------
  // listPlans / getPlan / adoptPlan / editPlanTask / checkOffTask
  // -------------------------------------------------------------------------------------

  /**
   * Plans of one account, projected with the same spoiler rule as the bank.
   *
   * The account's submission history is walked exactly once for the whole list; solved status is
   * account-wide, so a per-plan walk would repeat the same bounded read.
   */
  async listPlans(request: WorkbenchPlanListRequest, token: CancellationToken): Promise<WorkbenchPlanListResult> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(request !== null && typeof request === 'object', 'invalid_input', 'listPlans needs a request object', {});
    const accountId = requireRequiredId('accountId', request.accountId);
    const reveal = optionalFlag('reveal', request.reveal);
    return this.store.transaction(async (): Promise<WorkbenchPlanListResult> => {
      token.throwIfCancelled();
      const account = await this.requireAccount(accountId, token);
      const solved = await this.solvedKeys(account, token);
      const plans = await this.store.listPlans(account.id);
      token.throwIfCancelled();
      return { accountId: account.id, plans: plans.map((plan) => this.projectPlan(plan, solved, reveal)) };
    });
  }

  /** One plan of one account, projected with the same spoiler rule as the bank. */
  async getPlan(request: WorkbenchGetPlanRequest, token: CancellationToken): Promise<WorkbenchPlanView> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(request !== null && typeof request === 'object', 'invalid_input', 'getPlan needs a request object', {});
    const planId = requireRequiredId('planId', request.planId);
    const accountId = requireRequiredId('accountId', request.accountId);
    const reveal = optionalFlag('reveal', request.reveal);
    return this.store.transaction(async (): Promise<WorkbenchPlanView> => {
      token.throwIfCancelled();
      const account = await this.requireAccount(accountId, token);
      const plan = await this.requireOwnedPlan(planId, account.id, token);
      const solved = await this.solvedKeys(account, token);
      return this.projectPlan(plan, solved, reveal);
    });
  }

  /**
   * Adopt a draft plan after the human confirmed its preview.
   *
   * `expectedHash` must equal the full content hash of the stored plan; the stored plan is re-read
   * inside the transaction and compared before the domain transition runs, so a caller holding a
   * stale screen gets a typed conflict and no write. The returned view is the fresh stored plan.
   */
  async adoptPlan(request: WorkbenchPlanCasRequest, token: CancellationToken): Promise<WorkbenchPlanView> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(request !== null && typeof request === 'object', 'invalid_input', 'adoptPlan needs a request object', {});
    const planId = requireRequiredId('planId', request.planId);
    const accountId = requireRequiredId('accountId', request.accountId);
    const expectedHash = requirePlanHashInput(request.expectedHash);
    return this.store.transaction(async (): Promise<WorkbenchPlanView> => {
      token.throwIfCancelled();
      const account = await this.requireAccount(accountId, token);
      const stored = await this.requireOwnedPlan(planId, account.id, token);
      requirePlanHash(stored, expectedHash, planId);
      const updated = adoptTrainingPlan(stored, { adoptedAt: this.now() });
      await this.store.savePlan(updated);
      token.throwIfCancelled();
      const written = await this.rereadPlan(planId, updated, token);
      const solved = await this.solvedKeys(account, token);
      return this.projectPlan(written, solved, false);
    });
  }

  /**
   * Reschedule one planned task (`day`, `minutes`, `kind` only).
   *
   * Identity, title, link, tags and rationale cannot be replaced by the client; the domain refuses
   * a day/minute outside the plan's bounds, an overfilled day and a task that is already completed
   * or skipped. As with adoption, the stored plan is re-read and hash-checked before the edit.
   */
  async editPlanTask(request: WorkbenchEditPlanTaskRequest, token: CancellationToken): Promise<WorkbenchPlanView> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(request !== null && typeof request === 'object', 'invalid_input', 'editPlanTask needs a request object', {});
    const planId = requireRequiredId('planId', request.planId);
    const accountId = requireRequiredId('accountId', request.accountId);
    const expectedHash = requirePlanHashInput(request.expectedHash);
    const taskId = requireRequiredId('taskId', request.taskId);
    const patch = parseTaskPatch(request.patch);
    return this.store.transaction(async (): Promise<WorkbenchPlanView> => {
      token.throwIfCancelled();
      const account = await this.requireAccount(accountId, token);
      const stored = await this.requireOwnedPlan(planId, account.id, token);
      requirePlanHash(stored, expectedHash, planId);
      const updated = editTrainingTask(stored, taskId, patch, { at: this.now() });
      await this.store.savePlan(updated);
      token.throwIfCancelled();
      const written = await this.rereadPlan(planId, updated, token);
      const solved = await this.solvedKeys(account, token);
      return this.projectPlan(written, solved, false);
    });
  }

  /**
   * Record that a task was done or skipped.
   *
   * This is a user record only: it creates no submission and claims no judge verdict, and only an
   * adopted plan accepts one. The CAS check is identical to adoption and editing.
   */
  async checkOffTask(request: WorkbenchCheckOffTaskRequest, token: CancellationToken): Promise<WorkbenchPlanView> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(request !== null && typeof request === 'object', 'invalid_input', 'checkOffTask needs a request object', {});
    const planId = requireRequiredId('planId', request.planId);
    const accountId = requireRequiredId('accountId', request.accountId);
    const expectedHash = requirePlanHashInput(request.expectedHash);
    const taskId = requireRequiredId('taskId', request.taskId);
    const status = request.status;
    invariant(
      status === 'done' || status === 'skipped',
      'invalid_input',
      `checkOff status must be done|skipped (got ${String(status)})`,
      { status },
    );
    return this.store.transaction(async (): Promise<WorkbenchPlanView> => {
      token.throwIfCancelled();
      const account = await this.requireAccount(accountId, token);
      const stored = await this.requireOwnedPlan(planId, account.id, token);
      requirePlanHash(stored, expectedHash, planId);
      const updated = checkOffTrainingTask(stored, taskId, { at: this.now(), status });
      await this.store.savePlan(updated);
      token.throwIfCancelled();
      const written = await this.rereadPlan(planId, updated, token);
      const solved = await this.solvedKeys(account, token);
      return this.projectPlan(written, solved, false);
    });
  }

  // -------------------------------------------------------------------------------------
  // AI plan preparation (Sprint 11c)
  // -------------------------------------------------------------------------------------

  /**
   * Free, durable preparation input of one AI training plan.
   *
   * This is the application-facing method the planning service injects as its
   * `PlanningDataPort.prepare`: it collects, in one serialized read transaction, the account's own
   * evidence (submissions, retrospectives, decisions), the aggregate weakness report, the
   * identifier-free 11a ability aggregate and a bounded pool of **real** candidate problems of the
   * account's own source instance. Nothing is written by this call, no model is contacted, and no
   * problem, title, rating or link is ever invented: every candidate is a stored problem row.
   *
   * The pool defaults to the account's own native AC exclusions (`status: 'unconfirmed'`), collapses
   * canonical duplicate identities (a Codeforces problem and its Luogu mirror are one training
   * candidate), and stays inside the selected source instance, so no foreign account or source can
   * enter a plan. Raw platform labels travel with a candidate as explicitly provisional provenance;
   * they never become effective tags.
   *
   * When the request carries an explicit `candidateProblemKeys` selection, exactly those stored
   * problems are read instead of the automatic pool: an unknown key is a `missing_reference`, a key
   * of another source instance is refused, the ones this account already accepted are excluded and
   * counted, and the list is never truncated. The requested scope is stored on the preparation, so
   * a re-prepare under the same request id with a different selection is a typed conflict.
   */
  async preparePlanInput(request: PlanPreparationRequest, token: CancellationToken): Promise<PlanPreparationBundle> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(
      request !== null && typeof request === 'object',
      'invalid_input',
      'plan preparation needs a request object',
      {},
    );
    // One transaction for the whole preparation: submissions, retrospectives, decisions, effective
    // tags, solved status and the candidate pool are a single serialized read, so the ability
    // summary and the candidates that travel with it always describe the same store state.
    return this.store.transaction(async (): Promise<PlanPreparationBundle> => {
      token.throwIfCancelled();
      const account = await this.requireAccount(request.accountId, token);
      const source = await this.store.getSourceInstance(account.sourceInstanceId);
      token.throwIfCancelled();
      invariant(
        source !== null,
        'invalid_input',
        `account ${account.id} names source instance ${account.sourceInstanceId}, which is not stored`,
        { reason: 'source_instance_missing', accountId: account.id, sourceInstanceId: account.sourceInstanceId },
      );
      const evidence = await this.collectWeaknessEvidence(account, token);
      const report = this.weaknessReportOf(account, evidence);
      const ability = aggregateAbilityForPlanning(
        computeAbilityAssessment({
          calibration: await this.store.getAbilityCalibration(account.id),
          accountId: account.id,
          sourceInstanceId: account.sourceInstanceId,
          platform: source.platform,
          problems: evidence.problems,
          submissions: evidence.submissions,
          retrospectives: evidence.retrospectives,
          now: request.preparedAt,
        }),
      );
      const weakTagIds = report.ranking.map((tag) => tag.taxonomyId);
      const requestedCandidateKeys = request.candidateProblemKeys ?? null;
      const pool = await this.readPlanCandidatePool(
        account,
        request.candidateLimit,
        request.settings.estimatedMinutes,
        weakTagIds,
        evidence,
        requestedCandidateKeys,
        token,
      );
      const preparation: PlanAttemptPreparation = {
        preparedAt: request.preparedAt,
        accountId: account.id,
        sourceInstanceId: account.sourceInstanceId,
        requestedCandidateKeys,
        settings: request.settings,
        candidates: pool.candidates,
        exclusions: pool.exclusions,
        weakness: {
          attemptedDistinctTotal: report.attemptedDistinctTotal,
          sufficientTagIds: [...weakTagIds].sort(),
          ranking: report.ranking.map((tag) => ({ taxonomyId: tag.taxonomyId, solveRate: tag.solveRate })),
        },
        ability,
        evidenceHash: '',
      };
      token.throwIfCancelled();
      return {
        preparation: { ...preparation, evidenceHash: planPreparationEvidenceHash(preparation) },
        candidates: pool.trainingCandidates,
      };
    });
  }

  /**
   * Prove a stored preparation still describes the store, and rebuild its candidates.
   *
   * Called by the planning service inside its reservation and settlement transactions, so this
   * method is read-only and never opens a transaction of its own (the store rejects a nested one).
   * Every check is a typed `stale_preparation` finding instead of a silently repaired plan: the
   * account, its source instance, every candidate's stored metadata, own AC state and effective
   * tags, and the aggregate weakness and ability evidence must still match the preparation. The
   * returned candidates are rebuilt through the domain factory with the **same** candidate ids, so
   * the model's answer can only ever name a candidate the user actually saw.
   */
  async revalidatePlanInput(
    preparation: PlanAttemptPreparation,
    token: CancellationToken,
  ): Promise<PlanRevalidationResult> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(
      preparation !== null && typeof preparation === 'object',
      'invalid_input',
      'plan revalidation needs a stored preparation',
      {},
    );
    const account = await this.store.getAccount(preparation.accountId);
    token.throwIfCancelled();
    if (account === null) {
      return stalePreparation('account_missing', `account ${preparation.accountId} is no longer stored`, null);
    }
    if (account.sourceInstanceId !== preparation.sourceInstanceId) {
      return stalePreparation(
        'account_changed',
        `account ${account.id} now belongs to ${account.sourceInstanceId}, not to ${preparation.sourceInstanceId}`,
        null,
      );
    }
    const source = await this.store.getSourceInstance(account.sourceInstanceId);
    token.throwIfCancelled();
    if (source === null) {
      return stalePreparation(
        'source_missing',
        `source instance ${account.sourceInstanceId} is no longer stored`,
        null,
      );
    }
    const evidence = await this.collectWeaknessEvidence(account, token);
    const report = this.weaknessReportOf(account, evidence);
    const weakTagIds = report.ranking.map((tag) => tag.taxonomyId);
    if (
      contentHashOf({
        attemptedDistinctTotal: report.attemptedDistinctTotal,
        sufficientTagIds: [...weakTagIds].sort(),
        ranking: report.ranking.map((tag) => ({ taxonomyId: tag.taxonomyId, solveRate: tag.solveRate })),
      }) !== contentHashOf(preparation.weakness)
    ) {
      return stalePreparation('weakness_changed', `the weakness evidence of account ${account.id} changed`, null);
    }
    // The ability assessment is recomputed at the CURRENT injected instant on purpose: the
    // identifier-free aggregate carries no observation timestamp, so a moved clock alone cannot
    // make it differ, while a submission or retrospective recorded after the preparation on a
    // problem that is not itself a candidate (an already attempted, untagged problem whose first AC
    // arrives, for example) does change it. Recomputing at `preparedAt` would hide exactly those
    // rows behind the future-submission filter; recomputing at `now()` makes them a real staleness
    // finding. Evidence that merely aged out of the rolling 90-day window is a real change too and
    // is deliberately not ignored.
    const ability = aggregateAbilityForPlanning(
      computeAbilityAssessment({
        calibration: await this.store.getAbilityCalibration(account.id),
        accountId: account.id,
        sourceInstanceId: account.sourceInstanceId,
        platform: source.platform,
        problems: evidence.problems,
        submissions: evidence.submissions,
        retrospectives: evidence.retrospectives,
        now: this.now(),
      }),
    );
    if (contentHashOf(ability) !== contentHashOf(preparation.ability)) {
      return stalePreparation('ability_changed', `the ability evidence of account ${account.id} changed`, null);
    }

    // An explicit selection is part of the scope this plan was prepared under. A selected problem
    // that was excluded as already solved never became a candidate, so it is re-proved here to
    // still exist in the same source instance: a deleted or repointed row must not leave the stored
    // scope silently incomplete.
    if (preparation.requestedCandidateKeys !== null) {
      const inPool = new Set(preparation.candidates.map((candidate) => candidate.problemKey));
      for (const selectedKey of preparation.requestedCandidateKeys) {
        if (inPool.has(selectedKey)) {
          continue;
        }
        const selected = await this.store.getProblem(selectedKey);
        token.throwIfCancelled();
        if (selected === null) {
          return stalePreparation(
            'candidate_missing',
            `selected problem ${selectedKey} is no longer stored`,
            selectedKey,
          );
        }
        if (selected.ref.sourceInstanceId !== preparation.sourceInstanceId) {
          return stalePreparation(
            'scope_changed',
            `selected problem ${selectedKey} now belongs to ${selected.ref.sourceInstanceId}, not to ${preparation.sourceInstanceId}`,
            selectedKey,
          );
        }
      }
    }

    const candidates: TrainingCandidate[] = [];
    for (const stored of preparation.candidates) {
      const problem = await this.store.getProblem(stored.problemKey);
      token.throwIfCancelled();
      if (problem === null) {
        return stalePreparation(
          'candidate_missing',
          `candidate problem ${stored.problemKey} is no longer stored`,
          stored.problemKey,
        );
      }
      if (
        problem.key !== stored.problemKey ||
        problem.ref.externalKey !== stored.externalKey ||
        problem.title !== stored.title ||
        problem.url !== stored.url ||
        contentHashOf(problem.ratings) !== contentHashOf(stored.ratings) ||
        contentHashOf(problem.rawTags.map((tag) => tag.raw)) !== contentHashOf(stored.provisionalRawTags)
      ) {
        return stalePreparation(
          'candidate_metadata_changed',
          `candidate problem ${stored.problemKey} metadata changed since the plan was prepared`,
          stored.problemKey,
        );
      }
      const solved = await this.isSolvedBy(account, stored.problemKey, token);
      if (solved) {
        return stalePreparation(
          'candidate_solved',
          `candidate problem ${stored.problemKey} was accepted by this account since the plan was prepared`,
          stored.problemKey,
        );
      }
      const taxonomyIds = await this.tagMaterialOf(problem, token);
      if (contentHashOf([...taxonomyIds]) !== contentHashOf([...stored.effectiveTaxonomyIds])) {
        return stalePreparation(
          'candidate_tags_changed',
          `effective tags of candidate problem ${stored.problemKey} changed since the plan was prepared`,
          stored.problemKey,
        );
      }
      candidates.push(
        createTrainingCandidate({
          candidateId: stored.candidateId,
          problemRef: problem.ref,
          title: problem.title,
          sourceUrl: problem.url,
          estimatedMinutes: stored.estimatedMinutes,
          taxonomyIds,
          ratings: problem.ratings,
          origin: stored.origin,
        }),
      );
    }
    token.throwIfCancelled();
    return { ok: true, candidates };
  }

  /**
   * Persist one already-validated model plan and return its id plus full content hash.
   *
   * The planning service calls this from inside its settlement transaction, so this method joins
   * that transaction instead of opening one: the plan row and the settled attempt then commit or
   * roll back together, and a plan can never exist without the audit row that paid for it. The
   * stored plan is read back and its full content hash compared before the hash is reported, so a
   * caller can never record a hash of something that was not written.
   */
  async saveModelPlan(
    plan: TrainingPlan,
    attemptId: string,
    token: CancellationToken,
  ): Promise<{ readonly planId: string; readonly planHash: string }> {
    requireToken(token);
    token.throwIfCancelled();
    invariant(
      plan !== null && typeof plan === 'object',
      'invalid_input',
      'a model plan save needs a validated plan',
      { attemptId },
    );
    invariant(
      plan.source === 'model',
      'invalid_input',
      'only a model-sourced plan can be saved by the AI planning path',
      { attemptId, planId: plan.planId, source: plan.source },
    );
    await this.store.savePlan(plan);
    token.throwIfCancelled();
    const written = await this.store.getPlan(plan.planId);
    token.throwIfCancelled();
    invariant(
      written !== null,
      'invalid_transition',
      `plan ${plan.planId} of AI planning attempt ${attemptId} was not stored`,
      { planId: plan.planId, attemptId },
    );
    const hash = planContentHash(written);
    invariant(
      hash === planContentHash(plan),
      'invalid_transition',
      `stored plan ${plan.planId} does not match the validated plan of attempt ${attemptId}`,
      { planId: plan.planId, attemptId },
    );
    return { planId: written.planId, planHash: hash };
  }

  // -------------------------------------------------------------------------------------
  // Weakness & plan internals (always called inside the caller's transaction)
  // -------------------------------------------------------------------------------------

  /**
   * The bounded real candidate pool of one AI plan preparation.
   *
   * The read is an unsolved-filtered numbered bank page of the account's **own** source instance,
   * so an accepted problem never enters the pool and no foreign source instance is ever consulted.
   * A candidate is collapsed when its canonical merged group was already taken, which is what keeps
   * a Codeforces problem and its Luogu mirror from becoming two training tasks; the effective tags
   * of every kept candidate are resolved at its stored head, so stale AI decisions cannot steer a
   * plan. Every row is re-proved coherent with the requested scope before it is projected — a store
   * claim that contradicts the account is refused instead of silently dropped.
   */
  private async readPlanCandidatePool(
    account: Account,
    limit: number,
    estimatedMinutes: number,
    weakTagIds: readonly string[],
    evidence: WeaknessEvidence,
    selection: readonly string[] | null,
    token: CancellationToken,
  ): Promise<{
    readonly candidates: readonly PlanAttemptCandidate[];
    readonly trainingCandidates: readonly TrainingCandidate[];
    readonly exclusions: PlanAttemptExclusions;
  }> {
    if (selection !== null) {
      return this.readSelectedCandidatePool(account, selection, limit, estimatedMinutes, weakTagIds, evidence, token);
    }
    const solved = solvedKeysOf(evidence.submissions);
    const pageSize = Math.min(limit, MAX_BROWSE_PAGE_SIZE);
    const candidates: PlanAttemptCandidate[] = [];
    const training: TrainingCandidate[] = [];
    const groups = new Set<string>();
    let duplicateExcluded = 0;
    let considered = 0;
    let page = 1;
    let totalPages = 1;
    while (candidates.length < limit && page <= totalPages && page <= MAX_PLAN_CANDIDATE_PAGES) {
      const browsed = await this.store.browseProblems({
        sourceInstanceId: account.sourceInstanceId,
        accountId: account.id,
        status: 'unconfirmed',
        onlyAttempted: false,
        query: null,
        needsReviewOnly: false,
        sort: 'default',
        ratingDimension: null,
        page,
        limit: pageSize,
      });
      token.throwIfCancelled();
      totalPages = Math.max(1, browsed.totalPages);
      if (browsed.items.length === 0) {
        break;
      }
      for (const row of browsed.items) {
        if (candidates.length >= limit) {
          break;
        }
        considered += 1;
        assertBrowsedProblemCoherent(row.problem, account.sourceInstanceId);
        assertSolvedProjectionCoherent(row.problem, row.solvedByAccount, account);
        invariant(
          !row.solvedByAccount && !solved.has(row.problem.key),
          'invalid_input',
          `browsed problem ${row.problem.key} is reported unsolved although this account has an accepted submission for it`,
          { reason: 'pool_filter_inconsistent', problemKey: row.problem.key, accountId: account.id },
        );
        const groupKey = mergedGroupKeyOf(row.problem.ref);
        if (groups.has(groupKey)) {
          duplicateExcluded += 1;
          continue;
        }
        groups.add(groupKey);
        const taxonomyIds = await this.tagMaterialOf(row.problem, token);
        const candidateId = this.mintCandidateId();
        const origin = taxonomyIds.some((taxonomyId) => weakTagIds.includes(taxonomyId))
          ? ('weakness' as const)
          : ('unsolved_pool' as const);
        candidates.push({
          candidateId,
          problemKey: row.problem.key,
          externalKey: row.problem.ref.externalKey,
          title: row.problem.title,
          url: row.problem.url,
          estimatedMinutes,
          effectiveTaxonomyIds: [...taxonomyIds],
          provisionalRawTags: row.problem.rawTags.map((tag) => tag.raw),
          ratings: row.problem.ratings.map(ratingView),
          origin,
        });
        training.push(
          createTrainingCandidate({
            candidateId,
            problemRef: row.problem.ref,
            title: row.problem.title,
            sourceUrl: row.problem.url,
            estimatedMinutes,
            taxonomyIds,
            ratings: row.problem.ratings,
            origin,
          }),
        );
      }
      page += 1;
    }
    token.throwIfCancelled();
    return {
      candidates,
      trainingCandidates: training,
      exclusions: {
        nativeSolvedExcluded: solved.size,
        duplicateExcluded,
        // The pool read is scoped to the account's own source instance, so a foreign row is never
        // seen; the field stays so a future multi-source pool must state its own number.
        foreignExcluded: 0,
        candidateLimit: limit,
        considered,
      },
    };
  }

  /**
   * The explicit candidate pool of one AI plan preparation.
   *
   * Exactly the selected stored problems, in the caller's order: an unknown key is a typed
   * `missing_reference` and a key of another source instance is refused, so a selection can never
   * be silently replaced or borrowed from elsewhere. A selected problem this account already
   * accepted is excluded and counted in `nativeSolvedExcluded` — it cannot become training work —
   * and the list is never truncated, which is why a `candidateLimit` below the selection is refused
   * instead of applied. Canonical duplicates are deliberately **not** collapsed here: a caller who
   * named both a problem and its mirror asked for both, and dropping one would silently change the
   * selection the model is shown.
   */
  private async readSelectedCandidatePool(
    account: Account,
    selection: readonly string[],
    limit: number,
    estimatedMinutes: number,
    weakTagIds: readonly string[],
    evidence: WeaknessEvidence,
    token: CancellationToken,
  ): Promise<{
    readonly candidates: readonly PlanAttemptCandidate[];
    readonly trainingCandidates: readonly TrainingCandidate[];
    readonly exclusions: PlanAttemptExclusions;
  }> {
    invariant(
      selection.length <= MAX_PLANNING_CANDIDATES,
      'invalid_input',
      `an explicit candidate selection holds at most ${MAX_PLANNING_CANDIDATES} problems`,
      { reason: 'too_many_candidates', length: selection.length, bound: MAX_PLANNING_CANDIDATES },
    );
    invariant(
      selection.length <= limit,
      'invalid_input',
      `an explicit selection of ${selection.length} candidate problems exceeds candidateLimit ${limit}; an explicit selection is never truncated`,
      { reason: 'candidate_limit_below_selection', selection: selection.length, candidateLimit: limit },
    );
    const solved = solvedKeysOf(evidence.submissions);
    const candidates: PlanAttemptCandidate[] = [];
    const training: TrainingCandidate[] = [];
    let nativeSolvedExcluded = 0;
    for (const key of selection) {
      const problem = await this.store.getProblem(key);
      token.throwIfCancelled();
      if (problem === null) {
        throw new DomainError('missing_reference', `selected candidate problem ${key} is not stored`, {
          reason: 'unknown_candidate',
          problemKey: key,
          accountId: account.id,
        });
      }
      // A selected problem of another source instance is refused before anything is projected; a
      // foreign row can never be borrowed into this account's plan.
      invariant(
        problem.ref.sourceInstanceId === account.sourceInstanceId,
        'invalid_input',
        `selected candidate ${key} belongs to ${problem.ref.sourceInstanceId}, not to account ${account.id} of ${account.sourceInstanceId}`,
        {
          reason: 'candidate_source_mismatch',
          problemKey: key,
          accountId: account.id,
          candidateSource: problem.ref.sourceInstanceId,
          accountSource: account.sourceInstanceId,
        },
      );
      // Coherence (canonical key and own source instance) is re-proved before anything is
      // projected, so a foreign or incoherent stored row is refused instead of entering a plan.
      assertProblemMetadataCoherent(problem, key, account);
      if (solved.has(key)) {
        nativeSolvedExcluded += 1;
        continue;
      }
      const taxonomyIds = await this.tagMaterialOf(problem, token);
      const candidateId = this.mintCandidateId();
      const origin = taxonomyIds.some((taxonomyId) => weakTagIds.includes(taxonomyId))
        ? ('weakness' as const)
        : ('unsolved_pool' as const);
      candidates.push({
        candidateId,
        problemKey: problem.key,
        externalKey: problem.ref.externalKey,
        title: problem.title,
        url: problem.url,
        estimatedMinutes,
        effectiveTaxonomyIds: [...taxonomyIds],
        provisionalRawTags: problem.rawTags.map((tag) => tag.raw),
        ratings: problem.ratings.map(ratingView),
        origin,
      });
      training.push(
        createTrainingCandidate({
          candidateId,
          problemRef: problem.ref,
          title: problem.title,
          sourceUrl: problem.url,
          estimatedMinutes,
          taxonomyIds,
          ratings: problem.ratings,
          origin,
        }),
      );
    }
    token.throwIfCancelled();
    return {
      candidates,
      trainingCandidates: training,
      exclusions: {
        nativeSolvedExcluded,
        duplicateExcluded: 0,
        foreignExcluded: 0,
        candidateLimit: limit,
        considered: selection.length,
      },
    };
  }

  /**
   * Collect every bounded input the weakness reduction needs.
   *
   * Decisions are read per attempted problem together with that problem's stored head, because an
   * AI decision only counts while it targets the current head; the submission ref survives even
   * when the problem metadata row is gone, so a missing problem is still counted as attempted and
   * reported in the coverage instead of disappearing. Every collected row is additionally proved
   * coherent with the selected account before it reaches the reduction: the submission walk refuses
   * a row belonging to another account/source, and a *present* problem metadata or retrospective row
   * that names another scope is refused instead of being counted for this account.
   */
  private async collectWeaknessEvidence(account: Account, token: CancellationToken): Promise<WeaknessEvidence> {
    const submissions: Submission[] = [];
    for await (const page of this.submissionPages(account, token)) {
      submissions.push(...page);
    }
    const refByProblem = new Map<string, ProblemRef>();
    for (const submission of submissions) {
      if (!refByProblem.has(submission.key)) {
        refByProblem.set(submission.key, submission.ref);
      }
    }
    invariant(
      refByProblem.size <= MAX_WEAKNESS_DISTINCT_PROBLEMS,
      'invalid_input',
      `account ${account.id} has more than ${MAX_WEAKNESS_DISTINCT_PROBLEMS} distinct attempted problems; statistics cannot be computed from a truncated history`,
      {
        reason: 'distinct_problem_overflow',
        accountId: account.id,
        distinct: refByProblem.size,
        bound: MAX_WEAKNESS_DISTINCT_PROBLEMS,
      },
    );

    const problems: NormalizedProblem[] = [];
    const decisions: TagDecision[] = [];
    const metadataMissingKeys: string[] = [];
    const rawTags = new Set<string>();
    let problemsWithRawTags = 0;
    let decisionsRead = 0;
    let staleAiDecisionsExcluded = 0;

    for (const [key, ref] of [...refByProblem.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const problem = await this.store.getProblem(key);
      token.throwIfCancelled();
      if (problem === null) {
        // Missing metadata is a different statement from incoherent metadata: the reference is the
        // account's own (it came from a validated submission row) and simply has no stored row, so
        // the problem stays counted as attempted and reported in the coverage.
        metadataMissingKeys.push(key);
      } else {
        assertProblemMetadataCoherent(problem, key, account);
        problems.push(problem);
        if (problem.rawTags.length > 0) {
          problemsWithRawTags += 1;
        }
        for (const rawTag of problem.rawTags) {
          rawTags.add(rawTag.raw);
        }
      }
      const head = await this.store.getCurrentSnapshotHead(ref);
      token.throwIfCancelled();
      const stored = await this.store.listTagDecisions(key);
      token.throwIfCancelled();
      decisionsRead += stored.length;
      invariant(
        decisionsRead <= MAX_WEAKNESS_DECISIONS,
        'invalid_input',
        `account ${account.id} has more than ${MAX_WEAKNESS_DECISIONS} stored tag decisions; statistics cannot be computed from a truncated history`,
        { reason: 'decision_history_overflow', accountId: account.id, decisionsRead, bound: MAX_WEAKNESS_DECISIONS },
      );
      const kept = currentStoredDecisions(stored, head);
      staleAiDecisionsExcluded += stored.length - kept.length;
      decisions.push(...kept);
    }

    const retrospectives = await this.store.listRetrospectives(account.id);
    token.throwIfCancelled();
    invariant(
      retrospectives.length <= MAX_WEAKNESS_RETROSPECTIVES,
      'invalid_input',
      `account ${account.id} has more than ${MAX_WEAKNESS_RETROSPECTIVES} stored retrospectives; statistics cannot be computed from a truncated history`,
      {
        reason: 'retrospective_history_overflow',
        accountId: account.id,
        retrospectives: retrospectives.length,
        bound: MAX_WEAKNESS_RETROSPECTIVES,
      },
    );
    for (const retrospective of retrospectives) {
      assertRetrospectiveCoherent(retrospective, account);
    }

    return {
      submissions,
      problems,
      decisions,
      retrospectives,
      coverage: {
        submissionRows: submissions.length,
        distinctProblems: refByProblem.size,
        metadataPresent: problems.length,
        metadataMissing: metadataMissingKeys.length,
        metadataMissingKeys,
        decisionsRead,
        staleAiDecisionsExcluded,
        retrospectivesRead: retrospectives.length,
        submissionRowBound: MAX_ACCOUNT_SUBMISSIONS,
        distinctProblemBound: MAX_WEAKNESS_DISTINCT_PROBLEMS,
        decisionRowBound: MAX_WEAKNESS_DECISIONS,
        retrospectiveRowBound: MAX_WEAKNESS_RETROSPECTIVES,
      },
      rawTags: [...rawTags].sort(),
      problemsWithRawTags,
    };
  }

  /** Pure domain reduction of the collected evidence; the minimum-sample gate lives in the domain. */
  private weaknessReportOf(account: Account, evidence: WeaknessEvidence): AccountWeaknessReport {
    const reports = computeWeaknessReports({
      problems: evidence.problems,
      submissions: evidence.submissions,
      decisions: evidence.decisions,
      retrospectives: evidence.retrospectives,
      settings: { minDistinctProblems: WORKBENCH_MIN_WEAKNESS_SAMPLE, ratingDimension: null },
      accountIds: [account.id],
    });
    const report = reportForAccount(reports, account.id);
    invariant(report !== null, 'invalid_input', `no weakness report was produced for account ${account.id}`, {
      accountId: account.id,
    });
    return report;
  }

  /** One plan of the selected account; a plan of another account is refused before it is projected. */
  private async requireOwnedPlan(planId: string, accountId: string, token: CancellationToken): Promise<TrainingPlan> {
    const plan = await this.store.getPlan(planId);
    token.throwIfCancelled();
    if (plan === null) {
      throw new DomainError('missing_reference', `plan ${planId} is not stored`, { planId });
    }
    invariant(
      plan.accountId === accountId,
      'invalid_input',
      `plan ${planId} does not belong to account ${accountId}`,
      { reason: 'plan_account_mismatch', planId, accountId, planAccountId: plan.accountId },
    );
    return plan;
  }

  /** Read back what was written and prove it is the transition that was saved before projecting it. */
  private async rereadPlan(planId: string, expected: TrainingPlan, token: CancellationToken): Promise<TrainingPlan> {
    const written = await this.store.getPlan(planId);
    token.throwIfCancelled();
    invariant(written !== null, 'invalid_transition', `plan ${planId} was not stored`, { planId });
    invariant(
      planContentHash(written) === planContentHash(expected),
      'invalid_transition',
      `stored plan ${planId} does not match the transition that was saved`,
      { planId },
    );
    return written;
  }

  /** One plan projected field by field; per-task tags follow each task problem's spoiler rule. */
  private projectPlan(plan: TrainingPlan, solvedKeys: ReadonlySet<string>, reveal: boolean): WorkbenchPlanView {
    const summary = summariseTrainingPlan(plan);
    const view: WorkbenchPlanView = {
      planId: plan.planId,
      // A model may name the solution algorithm in its title, even when task tags are withheld.
      title: plan.source === 'model' && !reveal && plan.tasks.some(task => !solvedKeys.has(task.problemKey))
        ? 'AI 训练计划' : plan.title,
      source: plan.source,
      status: plan.status,
      createdAt: plan.createdAt,
      adoptedAt: plan.adoptedAt,
      accountId: plan.accountId,
      horizonDays: plan.horizonDays,
      minutesPerDay: plan.minutesPerDay,
      totalPlannedMinutes: summary.totalPlannedMinutes,
      totalUnmetMinutes: summary.totalUnmetMinutes,
      taskCount: summary.taskCount,
      distinctCandidates: summary.distinctCandidates,
      hasDuplicateCandidates: summary.hasDuplicateCandidates,
      days: summary.days.map((day) => ({
        day: day.day,
        taskCount: day.taskCount,
        minutes: day.minutes,
        unmetMinutes: day.unmetMinutes,
      })),
      tasks: plan.tasks.map((task) => projectPlanTask(task, reveal || solvedKeys.has(task.problemKey))),
      unmetMinutes: plan.unmetMinutes.map((entry) => ({ day: entry.day, minutes: entry.minutes })),
      evidence: planEvidenceView(plan.evidence),
      contentHash: planContentHash(plan),
    };
    if (!reveal) {
      // The plan-wide target list aggregates per-task tags, so for withheld tasks it would leak
      // their algorithms. It exists only in an explicit reveal; per-task fields follow the task.
      return view;
    }
    return { ...view, targetedTagIds: [...summary.targetedTagIds] };
  }

  private mintCandidateId(): string {
    return `candidate-${this.mintId()}`;
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
  private async solvedKeys(account: Account, token: CancellationToken): Promise<ReadonlySet<string>> {
    const solved = new Set<string>();
    for await (const submissions of this.submissionPages(account, token)) {
      for (const submission of submissions) {
        if (isAccepted(submission)) {
          solved.add(submission.key);
        }
      }
    }
    return solved;
  }

  /** True when this account has an accepted submission for this problem (bounded walk). */
  private async isSolvedBy(account: Account, problemKey: string, token: CancellationToken): Promise<boolean> {
    for await (const submissions of this.submissionPages(account, token)) {
      if (submissions.some((submission) => submission.key === problemKey && isAccepted(submission))) {
        return true;
      }
    }
    return false;
  }

  /**
   * One bounded page walk over one account's submission history.
   *
   * The running count is incremented and checked **before** a page is yielded and before a terminal
   * `null` cursor returns, so more than {@link MAX_ACCOUNT_SUBMISSIONS} stored submissions is a
   * typed refusal in every case — including a 50,001st row on the final page, which an
   * after-the-yield check used to wave through. A truncated history could hide the one AC that
   * decides whether a problem counts as solved.
   *
   * Every row is also proved to belong to `account` before its page is yielded: the store keeps a
   * submission's key and ref consistent with each other, but it does not enforce that the row
   * belongs to the account whose history was asked for, so a foreign row could otherwise let
   * another account's (or another source instance's) AC decide this account's solved status and
   * spoiler visibility. An incoherent row is a typed refusal, never a silent filter — dropping it
   * would describe a different history. The account is the one the caller already loaded, so the
   * walk performs no per-row lookup.
   */
  private async *submissionPages(
    account: Account,
    token: CancellationToken,
  ): AsyncGenerator<readonly Submission[], void, void> {
    let cursor: string | null = null;
    let scanned = 0;
    for (;;) {
      const page = await this.store.listSubmissions(account.id, { limit: WORKBENCH_SUBMISSION_PAGE_SIZE, cursor });
      token.throwIfCancelled();
      scanned += page.items.length;
      invariant(
        scanned <= MAX_ACCOUNT_SUBMISSIONS,
        'invalid_input',
        `account ${account.id} has more than ${MAX_ACCOUNT_SUBMISSIONS} stored submissions; solved status cannot be decided from a truncated history`,
        { reason: 'submission_history_overflow', accountId: account.id, scanned, bound: MAX_ACCOUNT_SUBMISSIONS },
      );
      for (const submission of page.items) {
        assertSubmissionBelongsToAccount(submission, account);
      }
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

/**
 * One numbered bank page request; every member is validated here, never coerced.
 *
 * `page`/`limit` are required (a page number is the whole point of this operation), `status` is
 * resolved to a concrete filter, and the same literal search term as `listProblems` is reused so
 * both bank operations cannot drift apart. `sort` is resolved to a concrete order, and a difficulty
 * order additionally demands an explicit source instance and a non-empty raw rating dimension, so
 * one difficulty comparison can never mix source instances or platforms; every other order ignores
 * the dimension and forwards `null`.
 */
function parseBrowseRequest(request: WorkbenchBrowseRequest): BrowseFilters {
  invariant(request !== null && typeof request === 'object', 'invalid_input', 'browseProblems needs a request object', {});
  const sourceInstanceId = optionalId('sourceInstanceId', request.sourceInstanceId);
  const sort = requireBrowseSort(request.sort);
  const ratingDimension = requireRatingDimension(request.ratingDimension);
  if (RATING_SORTS.includes(sort)) {
    invariant(
      sourceInstanceId !== null,
      'invalid_input',
      'a difficulty sort needs an explicit source instance id; a rating is only comparable inside one',
      { reason: 'rating_source_required', sort },
    );
    invariant(
      ratingDimension !== null,
      'invalid_input',
      `a difficulty sort needs a rating dimension of 1..${MAX_RATING_DIMENSION_CHARS} characters`,
      { reason: 'rating_dimension_required', sort },
    );
  }
  return {
    sourceInstanceId,
    accountId: optionalId('accountId', request.accountId),
    status: requireSolvedFilter(request.status),
    onlyAttempted: optionalFlag('onlyAttempted', request.onlyAttempted),
    query: normalizeProblemQuery(request.query),
    needsReviewOnly: optionalFlag('needsReviewOnly', request.needsReviewOnly),
    reveal: optionalFlag('reveal', request.reveal),
    sort,
    ratingDimension: RATING_SORTS.includes(sort) ? ratingDimension : null,
    page: requireBrowsePage(request.page),
    limit: requireBrowseLimit(request.limit),
  };
}

/** Bank sort: omitted/`null` is the legacy canonical-key ascending order of every existing caller. */
function requireBrowseSort(value: ProblemSort | null | undefined): ProblemSort {
  if (value === undefined || value === null) {
    return 'default';
  }
  invariant(PROBLEM_SORTS.includes(value), 'invalid_input', `sort must be one of: ${PROBLEM_SORTS.join(', ')}`, {
    sort: value,
  });
  return value;
}

/** Raw rating dimension of a difficulty sort: a non-blank bounded label, or `null` when omitted. */
function requireRatingDimension(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string', 'invalid_input', 'ratingDimension must be a string when present', {
    reason: 'invalid_rating_dimension',
  });
  const trimmed = value.trim();
  invariant(
    trimmed.length > 0 && trimmed.length <= MAX_RATING_DIMENSION_CHARS,
    'invalid_input',
    `ratingDimension must be 1..${MAX_RATING_DIMENSION_CHARS} characters`,
    { reason: 'invalid_rating_dimension' },
  );
  return trimmed;
}

/** Solved-state filter: omitted/`null` means `all`; an unknown value is refused, never coerced. */
function requireSolvedFilter(value: ProblemSolvedFilter | null | undefined): ProblemSolvedFilter {
  if (value === undefined || value === null) {
    return 'all';
  }
  invariant(
    PROBLEM_SOLVED_FILTERS.includes(value),
    'invalid_input',
    `status must be one of: ${PROBLEM_SOLVED_FILTERS.join(', ')}`,
    { status: value },
  );
  return value;
}

/**
 * 1-based page number.
 *
 * There is deliberately no upper bound: an out-of-range page is clamped to the last valid page by
 * the store, so refusing a large number would reject a request the contract defines as legal.
 */
function requireBrowsePage(value: number): number {
  invariant(Number.isInteger(value) && value >= 1, 'invalid_input', 'page must be an integer >= 1', { page: value });
  return value;
}

/** Page size of one numbered bank page: any integer within `1..MAX_BROWSE_PAGE_SIZE`. */
function requireBrowseLimit(value: number): number {
  invariant(
    Number.isInteger(value) && value >= 1 && value <= MAX_BROWSE_PAGE_SIZE,
    'invalid_input',
    `page limit must be an integer within 1..${MAX_BROWSE_PAGE_SIZE}`,
    { limit: value },
  );
  return value;
}

/**
 * Prove one browsed row is a coherent bank row of the requested scope.
 *
 * The row's own canonical key is re-derived from its reference, so a store that returned a body
 * whose key no longer matches its identity is refused instead of being projected under a borrowed
 * key; and a row of another source instance is refused instead of being counted for this page
 * (a silently different bank would describe a different query than the totals beside it).
 */
function assertBrowsedProblemCoherent(problem: NormalizedProblem, sourceInstanceId: string | null): void {
  const canonical = canonicalKeyOfStoredRef(`browsed problem ${problem.key}`, problem.ref, {
    reason: 'problem_key_mismatch',
    problemKey: problem.key,
  });
  invariant(
    canonical === problem.key,
    'invalid_input',
    `browsed problem ${problem.key} does not match its own reference ${canonical}`,
    { reason: 'problem_key_mismatch', problemKey: problem.key, canonicalKey: canonical },
  );
  if (sourceInstanceId === null) {
    return;
  }
  invariant(
    problem.ref.sourceInstanceId === sourceInstanceId,
    'invalid_input',
    `stored problem ${problem.key} belongs to ${problem.ref.sourceInstanceId}, not to ${sourceInstanceId}`,
    {
      reason: 'problem_source_mismatch',
      problemKey: problem.key,
      sourceInstanceId,
      rowSource: problem.ref.sourceInstanceId,
    },
  );
}

/**
 * Prove a store-reported solve can only belong to the account that asked for it.
 *
 * Solved status is answered by the store port, but it authorises withheld spoiler material here, so
 * a broken or hostile implementation must not be able to claim it for an anonymous request or for a
 * problem of another source instance. Such a claim is refused instead of being projected (and never
 * silently downgraded): producing no result is honest, while revealing a spoiler on an unverifiable
 * claim is not. A legitimate solve of the same source instance, including another domain of it, is
 * untouched.
 */
function assertSolvedProjectionCoherent(
  problem: NormalizedProblem,
  solvedByAccount: boolean,
  account: Account | null,
): void {
  if (!solvedByAccount) {
    return;
  }
  invariant(
    account !== null,
    'invalid_input',
    `browsed problem ${problem.key} is reported solved without an account context`,
    { reason: 'solved_projection_without_account', problemKey: problem.key },
  );
  invariant(
    problem.ref.sourceInstanceId === account.sourceInstanceId,
    'invalid_input',
    `browsed problem ${problem.key} belongs to ${problem.ref.sourceInstanceId}, not to account ${account.id} of ${account.sourceInstanceId}`,
    {
      reason: 'solved_projection_foreign_source',
      problemKey: problem.key,
      accountId: account.id,
      rowSource: problem.ref.sourceInstanceId,
      accountSource: account.sourceInstanceId,
    },
  );
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

/** Source mismatch is the same typed failure whether it is found on a read or on a plan candidate. */
function stalePreparation(reason: PlanStalenessReason, detail: string, problemKey: string | null): PlanRevalidationResult {
  return { ok: false, staleness: { reason, detail, problemKey } };
}

function sourceMismatch(account: Account, sourceInstanceId: string): DomainError {
  return new DomainError(
    'invalid_input',
    `account ${account.id} belongs to ${account.sourceInstanceId}, not to ${sourceInstanceId}`,
    { reason: 'account_source_mismatch', accountId: account.id, accountSource: account.sourceInstanceId, sourceInstanceId },
  );
}

/**
 * Re-derive the canonical key of one stored reference.
 *
 * Identity parsing belongs to the domain, so this composes {@link problemKey} instead of matching
 * an id string with a local pattern. A reference the domain refuses is reported as bad input with
 * the caller's own stable `reason`, so an incoherent row never escapes as a raw `invalid_id_part`.
 */
function canonicalKeyOfStoredRef(label: string, ref: ProblemRef, details: Record<string, unknown>): string {
  try {
    return problemKey(ref);
  } catch (error) {
    throw new DomainError('invalid_input', `${label} is not a canonical problem reference`, {
      ...details,
      cause: String(error),
    });
  }
}

/** Parse a stored retrospective's problem key through the domain helper, as typed bad input. */
function parseStoredRetrospectiveRef(retrospective: Retrospective): ProblemRef {
  try {
    return parseProblemKey(retrospective.problemKey);
  } catch (error) {
    throw new DomainError(
      'invalid_input',
      `stored retrospective ${retrospective.retrospectiveId} carries a malformed problem key`,
      {
        reason: 'retrospective_key_mismatch',
        retrospectiveId: retrospective.retrospectiveId,
        problemKey: retrospective.problemKey,
        cause: String(error),
      },
    );
  }
}

/**
 * Prove one stored submission row belongs to the account whose history is being walked.
 *
 * The store keeps a submission's `key` and `ref` consistent with each other, but a persisted row
 * can still name another account or another source instance. Counting such a row would attribute a
 * foreign AC — and with it the foreign problem's spoiler reveal — to the selected account, so the
 * row is refused with a typed `invalid_input` rather than filtered out: a silently smaller history
 * would describe a different account. The account is the one the caller already loaded, so this
 * check needs no per-row lookup.
 */
function assertSubmissionBelongsToAccount(submission: Submission, account: Account): void {
  invariant(
    submission.accountId === account.id,
    'invalid_input',
    `stored submission ${submission.id} belongs to account ${submission.accountId}, not to ${account.id}`,
    {
      reason: 'submission_account_mismatch',
      submissionId: submission.id,
      accountId: account.id,
      rowAccountId: submission.accountId,
    },
  );
  invariant(
    submission.ref.sourceInstanceId === account.sourceInstanceId,
    'invalid_input',
    `stored submission ${submission.id} belongs to ${submission.ref.sourceInstanceId}, not to account ${account.id}`,
    {
      reason: 'submission_source_mismatch',
      submissionId: submission.id,
      accountId: account.id,
      accountSource: account.sourceInstanceId,
      rowSource: submission.ref.sourceInstanceId,
    },
  );
  const canonical = canonicalKeyOfStoredRef(`stored submission ${submission.id}`, submission.ref, {
    reason: 'submission_key_mismatch',
    submissionId: submission.id,
    accountId: account.id,
    rowKey: submission.key,
  });
  invariant(
    canonical === submission.key,
    'invalid_input',
    `stored submission ${submission.id} carries key ${submission.key} but its reference names ${canonical}`,
    {
      reason: 'submission_key_mismatch',
      submissionId: submission.id,
      accountId: account.id,
      rowKey: submission.key,
      canonicalKey: canonical,
    },
  );
}

/**
 * Prove one stored problem row really describes the problem the submission walk asked for.
 *
 * The row is the only source of a problem's tags and ratings in the weakness reduction, so an
 * incoherent key/ref/source would let one problem's material count for another. `null` metadata is
 * a different statement ("this attempted problem is not stored") and stays counted as attempted;
 * only a *present* but incoherent row is refused. The reference is re-derived through the domain's
 * {@link problemKey} so a non-canonical key is caught by identity parsing, not by a local pattern.
 */
function assertProblemMetadataCoherent(problem: NormalizedProblem, expectedKey: string, account: Account): void {
  invariant(
    problem.key === expectedKey,
    'invalid_input',
    `stored problem metadata for ${expectedKey} reports key ${problem.key}`,
    { reason: 'problem_key_mismatch', accountId: account.id, expectedKey, storedKey: problem.key },
  );
  const canonical = canonicalKeyOfStoredRef(`stored problem metadata ${problem.key}`, problem.ref, {
    reason: 'problem_key_mismatch',
    accountId: account.id,
    problemKey: problem.key,
  });
  invariant(
    canonical === problem.key,
    'invalid_input',
    `stored problem metadata ${problem.key} does not match its own reference ${canonical}`,
    { reason: 'problem_key_mismatch', accountId: account.id, problemKey: problem.key, canonicalKey: canonical },
  );
  invariant(
    problem.ref.sourceInstanceId === account.sourceInstanceId,
    'invalid_input',
    `stored problem metadata ${problem.key} belongs to ${problem.ref.sourceInstanceId}, not to account ${account.id}`,
    {
      reason: 'problem_source_mismatch',
      accountId: account.id,
      accountSource: account.sourceInstanceId,
      problemSource: problem.ref.sourceInstanceId,
    },
  );
}

/**
 * Prove one stored retrospective belongs to the selected account and source instance.
 *
 * A retrospective for a same-source problem the account never submitted to is legitimate history
 * (it may describe work outside the stored submission window), so a matching submission is never
 * required; only account, source instance and canonical-key coherence are enforced.
 */
function assertRetrospectiveCoherent(retrospective: Retrospective, account: Account): void {
  invariant(
    retrospective.accountId === account.id,
    'invalid_input',
    `stored retrospective ${retrospective.retrospectiveId} belongs to account ${retrospective.accountId}, not to ${account.id}`,
    {
      reason: 'retrospective_account_mismatch',
      retrospectiveId: retrospective.retrospectiveId,
      accountId: account.id,
      rowAccountId: retrospective.accountId,
    },
  );
  const ref = parseStoredRetrospectiveRef(retrospective);
  const canonical = canonicalKeyOfStoredRef(`stored retrospective ${retrospective.retrospectiveId}`, ref, {
    reason: 'retrospective_key_mismatch',
    retrospectiveId: retrospective.retrospectiveId,
    problemKey: retrospective.problemKey,
  });
  invariant(
    canonical === retrospective.problemKey,
    'invalid_input',
    `stored retrospective ${retrospective.retrospectiveId} carries key ${retrospective.problemKey} but its reference names ${canonical}`,
    {
      reason: 'retrospective_key_mismatch',
      retrospectiveId: retrospective.retrospectiveId,
      problemKey: retrospective.problemKey,
      canonicalKey: canonical,
    },
  );
  invariant(
    ref.sourceInstanceId === account.sourceInstanceId,
    'invalid_input',
    `stored retrospective ${retrospective.retrospectiveId} belongs to ${ref.sourceInstanceId}, not to account ${account.id}`,
    {
      reason: 'retrospective_source_mismatch',
      retrospectiveId: retrospective.retrospectiveId,
      accountId: account.id,
      accountSource: account.sourceInstanceId,
      rowSource: ref.sourceInstanceId,
    },
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
    note: source.note,
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

/**
 * One analysis with an explicit current-vs-stale indicator against the stored head.
 *
 * The completeness *state* is the answer to "does this result satisfy the current check for the
 * snapshot and taxonomy the reader is looking at right now?" — so it is `current` only when the
 * analysis completed, is not stale against the head, was produced under the reader's taxonomy
 * version, and its completeness metadata matches the current audit version, the same taxonomy
 * version and the analysis's own snapshot. Anything else is `outdated`, never silently treated as
 * a passed check: a result checked under another taxonomy or version stays readable history.
 */
function analysisView(analysis: AnalysisResult, head: SnapshotHead | null, taxonomyVersion: string): WorkbenchAnalysisView {
  const stale = analysisIsStale(analysis, head);
  const completenessCurrent =
    analysis.completeness !== undefined &&
    !stale &&
    analysis.status === 'completed' &&
    analysis.taxonomyVersion === taxonomyVersion &&
    completenessIsCurrent(analysis.completeness, {
      version: COMPLETENESS_AUDIT_VERSION,
      taxonomyVersion,
      snapshotId: analysis.snapshotId,
      snapshotVersion: analysis.snapshotVersion,
    });
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
    // Unchecked stays `null` on purpose: a legacy result, a reasoning-only draft or a failed
    // run must never look like a passed completeness check. The audit version is exposed so
    // the UI can distinguish "checked under the current version" from "older check".
    completeness:
      analysis.completeness === undefined
        ? null
        : {
            version: analysis.completeness.version,
            taxonomyVersion: analysis.completeness.taxonomyVersion,
            snapshotId: analysis.completeness.snapshotId,
            snapshotVersion: analysis.completeness.snapshotVersion,
            checkedAt: analysis.completeness.checkedAt,
            state: completenessCurrent ? 'current' : 'outdated',
          },
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

// ---------------------------------------------------------------------------------------
// Plan & weakness helpers
// ---------------------------------------------------------------------------------------

/**
 * Full sha256 content hash of one stored plan.
 *
 * This is the optimistic-concurrency token every plan mutation requires; it is computed from the
 * complete stored plan (never from a redacted DTO), so two different plan bodies can never share a
 * token and a withheld field cannot change it.
 */
export function planContentHash(plan: TrainingPlan): string {
  return contentHashOf(plan);
}

/** An expected plan hash must be a complete sha256 digest, never a prefix or an opaque screen id. */
function requirePlanHashInput(value: string | null | undefined): string {
  invariant(
    typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value),
    'invalid_input',
    'expectedHash must be the full sha256 content hash of the stored plan',
    { value },
  );
  return value;
}

/** Refuse a stale caller before any transition; the plan really is re-read inside the transaction. */
function requirePlanHash(plan: TrainingPlan, expectedHash: string, planId: string): void {
  const actualHash = planContentHash(plan);
  invariant(
    actualHash === expectedHash,
    'invalid_transition',
    `plan ${planId} changed since it was read; re-read it before saving`,
    { reason: 'stale_plan_hash', planId, expectedHash, actualHash },
  );
}

/** A required opaque id (plan/task/account): omitted or empty input is refused, never defaulted. */
function requireRequiredId(name: string, value: string | null | undefined): string {
  const id = optionalId(name, value);
  invariant(id !== null, 'invalid_input', `${name} is required`, { name, value });
  return id;
}

/** Optional bounded integer with an explicit default; a value outside the bound is refused. */
function boundedInt(
  name: string,
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max,
    'invalid_input',
    `${name} must be an integer within ${min}..${max}`,
    { name, value, min, max },
  );
  return value;
}

/**
 * Distinct, non-empty stored problem keys; duplicates collapse to the first occurrence and the
 * whole list is bounded before any lookup, so a huge array cannot force an unbounded scan.
 */
function requireCandidateKeys(value: readonly string[] | null | undefined): readonly string[] {
  invariant(Array.isArray(value), 'invalid_input', 'candidateProblemKeys must be an array of problem keys', {
    value,
  });
  invariant(
    value.length <= MAX_PLAN_CANDIDATES,
    'invalid_input',
    `candidateProblemKeys must hold at most ${MAX_PLAN_CANDIDATES} keys`,
    { reason: 'too_many_candidates', length: value.length, bound: MAX_PLAN_CANDIDATES },
  );
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const entry of value) {
    const key = requireProblemKeyInput(entry);
    try {
      parseProblemKey(key);
    } catch (error) {
      // A key that is not canonical cannot name a stored problem; report it as bad input with a
      // stable reason instead of leaking the identity parser's own code to the caller.
      if (error instanceof DomainError && error.code === 'invalid_id_part') {
        throw new DomainError('invalid_input', `candidate key ${key} is not a canonical problem key`, {
          reason: 'malformed_candidate_key',
          problemKey: key,
          cause: String(error),
        });
      }
      throw error;
    }
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Optional plan title: trimmed, bounded, and `null` when absent or blank. */
function optionalPlanTitle(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(typeof value === 'string', 'invalid_input', 'title must be a string when present', { value });
  const trimmed = value.trim();
  invariant(
    trimmed.length <= MAX_PLAN_TITLE_CHARS,
    'invalid_input',
    `title must be at most ${MAX_PLAN_TITLE_CHARS} characters`,
    { length: trimmed.length },
  );
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The only task fields a client may change: `day`, `minutes` and `kind`.
 *
 * Identity, title, link, tags and rationale are refused with an explicit reason instead of being
 * ignored, so a UI cannot believe it renamed or repointed a task when it did not. The domain still
 * validates the day/minute bounds, the daily budget and the task state.
 */
function parseTaskPatch(value: WorkbenchPlanTaskPatch | null | undefined): PlanTaskPatch {
  invariant(
    value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    'editPlanTask needs a patch object',
    { value },
  );
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((key) => key !== 'day' && key !== 'minutes' && key !== 'kind');
  invariant(
    unsupported.length === 0,
    'invalid_input',
    `a task edit may only change day, minutes or kind (got ${unsupported.join(', ')})`,
    { reason: 'unsupported_patch_field', fields: unsupported },
  );
  const patch: { day?: number; minutes?: number; kind?: TrainingTaskKind } = {};
  if (record['day'] !== undefined) {
    invariant(Number.isInteger(record['day']), 'invalid_input', 'day must be an integer', { day: record['day'] });
    patch.day = record['day'] as number;
  }
  if (record['minutes'] !== undefined) {
    invariant(
      Number.isInteger(record['minutes']),
      'invalid_input',
      'minutes must be an integer',
      { minutes: record['minutes'] },
    );
    patch.minutes = record['minutes'] as number;
  }
  if (record['kind'] !== undefined) {
    invariant(
      TRAINING_TASK_KINDS.includes(record['kind'] as TrainingTaskKind),
      'invalid_input',
      `unknown task kind ${String(record['kind'])}`,
      { kind: record['kind'] },
    );
    patch.kind = record['kind'] as TrainingTaskKind;
  }
  invariant(
    Object.keys(patch).length > 0,
    'invalid_input',
    'editPlanTask needs at least one of day, minutes or kind',
    { reason: 'empty_patch' },
  );
  return patch;
}

/** One task: identity and links always, tags/rationale only when `visible`. */
function projectPlanTask(task: TrainingTask, visible: boolean): WorkbenchPlanTaskView {
  const view: WorkbenchPlanTaskView = {
    taskId: task.taskId,
    planId: task.planId,
    day: task.day,
    order: task.order,
    candidateId: task.candidateId,
    problemKey: task.problemKey,
    title: task.title,
    sourceUrl: task.sourceUrl,
    minutes: task.minutes,
    kind: task.kind,
    status: task.status,
    checkedAt: task.checkedAt,
  };
  if (!visible) {
    return view;
  }
  return { ...view, taxonomyIds: [...task.taxonomyIds], rationale: task.rationale };
}

function planEvidenceView(evidence: TrainingEvidence): WorkbenchPlanEvidenceView {
  return {
    level: evidence.level,
    reasons: [...evidence.reasons],
    attemptedDistinctTotal: evidence.attemptedDistinctTotal,
    sufficientTagIds: [...evidence.sufficientTagIds],
  };
}

function rejectedCandidateView(candidate: RejectedCandidate): WorkbenchPlanRejectedCandidateView {
  return { candidateId: candidate.candidateId, reason: candidate.reason, detail: candidate.detail };
}

function beginnerRecommendationView(recommendation: BeginnerRecommendation): WorkbenchPlanBeginnerRecommendationView {
  return {
    taxonomyId: recommendation.taxonomyId,
    nameEn: recommendation.nameEn,
    nameZh: recommendation.nameZh,
    basis: recommendation.basis,
    rationale: recommendation.rationale,
  };
}

/**
 * Explicit projection of the pure solved distribution.
 *
 * Only the members the UI renders are copied, so a later domain addition cannot silently appear in
 * the response and a bucket never carries anything but its numeric value and count.
 */
function solvedDistributionView(
  distribution: ReturnType<typeof computeTrainingStatistics>['solvedDistribution'],
): WorkbenchSolvedDistributionView {
  return {
    totalSolved: distribution.totalSolved,
    metadataMissingSolved: distribution.metadataMissingSolved,
    dimensions: distribution.dimensions.map((dimension) => ({
      dimension: dimension.dimension,
      buckets: dimension.buckets.map((bucket) => ({ value: bucket.value, count: bucket.count })),
      knownCount: dimension.knownCount,
      unknownCount: dimension.unknownCount,
    })),
  };
}

/**
 * Explicit projection of the raw platform-label reference.
 *
 * `verified` is written as the literal `false` the DTO demands, so no code path can present a
 * platform label as accepted evidence. Tag rows keep only the label and its distinct-problem
 * counts: a per-problem label mapping would be spoiler-bearing and is not part of this projection.
 */
function platformTagStatsView(
  stats: ReturnType<typeof computeTrainingStatistics>['platformTagStats'],
): WorkbenchPlatformTagStatsView {
  return {
    verified: false,
    attemptedTaggedDistinct: stats.attemptedTaggedDistinct,
    solvedTaggedDistinct: stats.solvedTaggedDistinct,
    minimumSampleSize: stats.minimumSampleSize,
    tags: stats.tags.map((tag) => ({
      rawTag: tag.rawTag,
      attemptedDistinct: tag.attemptedDistinct,
      solvedDistinct: tag.solvedDistinct,
      unconfirmedDistinct: tag.unconfirmedDistinct,
      solveRate: tag.solveRate,
      sufficientEvidence: tag.sufficientEvidence,
    })),
  };
}

/** Distinct problems this account solved, from already-collected accepted submissions. */
function solvedKeysOf(submissions: readonly Submission[]): ReadonlySet<string> {
  const solved = new Set<string>();
  for (const submission of submissions) {
    if (isAccepted(submission)) {
      solved.add(submission.key);
    }
  }
  return solved;
}
