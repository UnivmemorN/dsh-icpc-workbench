/**
 * Workbench DTOs (Stages 4w1a–4w1b): bank reads, manual review, retrospectives, weakness
 * statistics and training-plan projections.
 *
 * Every member is JSON-serializable and every DTO is built by explicit field projection, never by
 * spreading a storage row. Spoiler-bearing members are *optional and absent* while they are
 * withheld: `Object.hasOwn(dto, 'rawTags') === false` means "not part of this response", and an
 * empty array or `null` never stands in for redaction. `null` is reserved for genuinely nullable
 * members (`note`, `latestRetrospective`, `snapshot`), where it means "present but empty/unknown",
 * which is a different statement from absence.
 */
import type {
  AccountWeaknessReport,
  AnalysisStatus,
  CandidateRejectionReason,
  CF_MIRROR_RULE_ID,
  CompletionMode,
  DecisionReason,
  EditorialAvailability,
  EditorialSourceKind,
  ManualTagAction,
  ModelRole,
  ModelUsage,
  ProblemMappingKind,
  TagDecisionOrigin,
  TagDecisionStatus,
  TrainingEvidenceLevel,
  TrainingPlanStatus,
  TrainingTaskKind,
  TrainingTaskStatus,
  UnmetMinutes,
  VerificationVerdict,
} from '../domain/index.js';
import type { PlanEvidenceReason } from '../domain/training.js';

/** One raw platform rating dimension, preserved exactly as the platform reported it. */
export interface WorkbenchRatingView {
  readonly dimension: string;
  readonly value: number | string;
  readonly scale: { readonly min: number; readonly max: number } | null;
  readonly raw: string;
}

/** Bank-list row. Tag material is present only when the row's spoilers are visible. */
export interface WorkbenchProblemSummary {
  readonly problemKey: string;
  readonly sourceInstanceId: string;
  readonly domain: string | null;
  readonly externalKey: string;
  readonly title: string;
  readonly url: string;
  readonly fetchedAt: string;
  readonly rawRatings: readonly WorkbenchRatingView[];
  /** True when the selected account has an accepted submission for this problem. */
  readonly solvedByAccount: boolean;
  /** Original platform tags; absent while withheld (never an empty array, never `null`). */
  readonly rawTags?: readonly string[];
  /** Current effective taxonomy ids (stale AI decisions excluded); absent while withheld. */
  readonly effectiveTaxonomyIds?: readonly string[];
  /** `true` when the review-queue filter selected this row, `null` when that filter was not used. */
  readonly pendingReview: boolean | null;
}

/** One cursor page of bank rows; `nextCursor` is bound to the whole filter set that produced it. */
export interface WorkbenchProblemPage {
  readonly pageId: string;
  readonly items: readonly WorkbenchProblemSummary[];
  readonly nextCursor: string | null;
  /** True when this page was projected with spoilers visible (`reveal` or solved rows). */
  readonly reveal: boolean;
  readonly pendingReviewOnly: boolean;
  readonly fetchedAt: string;
}

/**
 * One numbered page of the bank: the redacted rows plus the totals of exactly this filter set.
 *
 * `page`, `pageSize`, `totalItems` and `totalPages` describe the same serialized read as `items`.
 * The store clamps an out-of-range `page` to the last valid page, so `page <= totalPages` whenever
 * `totalPages > 0`, while an empty filter set reports `totalItems: 0`, `totalPages: 0`, `page: 1`
 * and no items at all.
 */
export interface WorkbenchProblemBrowsePage {
  readonly pageId: string;
  readonly items: readonly WorkbenchProblemSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  /** True when this page was projected with spoilers visible (`reveal` or solved rows). */
  readonly reveal: boolean;
  readonly pendingReviewOnly: boolean;
  readonly fetchedAt: string;
}

// ---------------------------------------------------------------------------------------
// Merged bank (Stage 08b)
// ---------------------------------------------------------------------------------------

/** One member of a merged group: the bank summary plus the selected account it belongs to. */
export interface WorkbenchMergedProblemMember {
  /**
   * Bank summary of this member's own stored record.
   *
   * `problem.solvedByAccount` is this member's **own** direct accepted submission and is never
   * overwritten with a linked cross-site solve; that link lives on the group's `solved`/evidence.
   */
  readonly problem: WorkbenchProblemSummary;
  /** Selected account of this member's source instance, or `null` when none is selected. */
  readonly accountId: string | null;
}

/**
 * Safe metadata of one accepted submission behind a group's solved state.
 *
 * Identity and time only: no verdict body, no source code and no score. `problemKey`,
 * `sourceInstanceId` and `externalKey` name the exact problem the accepted submission belongs to,
 * which may have no stored metadata row of its own.
 */
export interface WorkbenchAcceptedEvidenceView {
  readonly accountId: string;
  readonly problemKey: string;
  readonly sourceInstanceId: string;
  readonly externalKey: string;
  readonly submissionId: string;
  readonly submittedAt: string;
}

/** How one group was formed; a `single` group is never merged with anything. */
export type WorkbenchMergedMappingKind = ProblemMappingKind;

/**
 * One merged group of the bank.
 *
 * `solved` means at least one **selected** account has an accepted submission for an equivalent
 * problem identity ({@link WorkbenchAcceptedEvidenceView}), which may be the other site's record; it
 * is therefore a banner and never reveals a member's tags on its own. `attempted` means a selected
 * account submitted to an equivalent identity without necessarily being accepted.
 */
export interface WorkbenchMergedProblemGroup {
  readonly groupKey: string;
  readonly members: readonly WorkbenchMergedProblemMember[];
  readonly solved: boolean;
  readonly attempted: boolean;
  readonly acceptedEvidence: readonly WorkbenchAcceptedEvidenceView[];
  readonly mappingKind: WorkbenchMergedMappingKind;
}

/** One known equivalence rule, so a response can explain how its groups were formed. */
export interface WorkbenchMergedEquivalenceRuleView {
  readonly ruleId: typeof CF_MIRROR_RULE_ID;
  readonly explanation: string;
  readonly referenceExampleUrl: string;
}

/**
 * One numbered page of the merged bank.
 *
 * `equivalenceRules` states the recognized rules once for the whole page; a group's `mappingKind`
 * names the rule that formed it, and every member carries its own exact original URL and identifiers.
 */
export interface WorkbenchMergedBrowsePage {
  readonly pageId: string;
  readonly items: readonly WorkbenchMergedProblemGroup[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly fetchedAt: string;
  /** True when the caller asked for spoilers explicitly; a member's own AC reveals independently. */
  readonly reveal: boolean;
  readonly equivalenceRules: readonly WorkbenchMergedEquivalenceRuleView[];
}

/** One editorial source; `contentHash` is a digest, never the body. */
export interface WorkbenchEditorialSourceView {
  readonly sourceId: string;
  readonly kind: EditorialSourceKind;
  readonly url: string;
  readonly title: string;
  readonly author: string | null;
  readonly language: string | null;
  readonly publishedAt: string | null;
  readonly availability: EditorialAvailability;
  readonly contentHash: string | null;
}

/** One editorial solution including its body; only projected when spoilers are visible. */
export interface WorkbenchSolutionView {
  readonly solutionId: string;
  readonly sourceId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly text: string;
  readonly language: string | null;
}

/** Snapshot head plus material counts; `sources`/`solutions` bodies are absent while withheld. */
export interface WorkbenchSnapshotView {
  readonly snapshotId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly sourceCount: number;
  readonly solutionCount: number;
  /** Editorial sources; absent while withheld. */
  readonly sources?: readonly WorkbenchEditorialSourceView[];
  /** Editorial solutions, bodies included; absent while withheld. */
  readonly solutions?: readonly WorkbenchSolutionView[];
}

/** One cited evidence excerpt (source + solution + quoted text). */
export interface WorkbenchEvidenceView {
  readonly sourceId: string;
  readonly solutionId: string;
  readonly excerpt: string;
  readonly note: string | null;
}

/** Second-pass verdict attached to one suggestion, when that pass ran. */
export interface WorkbenchVerificationView {
  readonly verificationId: string;
  readonly verdict: VerificationVerdict;
  readonly verifierRole: 'verification' | 'reasoning';
  readonly evidenceOk: boolean;
  readonly conflictingSolutionIds: readonly string[];
  readonly note: string | null;
  readonly checkedAt: string;
}

/** One model tag suggestion with its rationale and evidence. */
export interface WorkbenchSuggestionView {
  readonly suggestionId: string;
  readonly taxonomyId: string;
  readonly role: ModelRole;
  readonly rationale: string;
  readonly evidence: readonly WorkbenchEvidenceView[];
  readonly createdAt: string;
  readonly verification: WorkbenchVerificationView | null;
}

/** One reasoning draft; reasoning output never becomes an automatic decision. */
export interface WorkbenchReasoningDraftView {
  readonly draftId: string;
  readonly taxonomyIds: readonly string[];
  readonly rationale: string;
  readonly evidence: readonly WorkbenchEvidenceView[];
  readonly createdAt: string;
}

export interface WorkbenchFailureView {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** One stored analysis with an explicit current-vs-stale indicator. */
export interface WorkbenchAnalysisView {
  readonly analysisId: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly taxonomyVersion: string;
  readonly createdAt: string;
  readonly status: AnalysisStatus;
  /** True when this analysis still targets the stored snapshot head. */
  readonly current: boolean;
  readonly stale: boolean;
  readonly suggestions: readonly WorkbenchSuggestionView[];
  readonly reasoningDrafts: readonly WorkbenchReasoningDraftView[];
  readonly failure: WorkbenchFailureView | null;
  readonly usage: ModelUsage | null;
}

/** One manual accept/reject, in recorded order. */
export interface WorkbenchManualDecisionView {
  readonly decisionId: string;
  readonly taxonomyId: string;
  readonly action: ManualTagAction;
  readonly decidedAt: string;
  readonly note: string | null;
  readonly supersedesAnalysisId: string | null;
}

/** The current resolved decision of one taxonomy id (manual decisions always win). */
export interface WorkbenchTagDecisionView {
  readonly decisionId: string;
  readonly taxonomyId: string;
  readonly status: TagDecisionStatus;
  readonly origin: TagDecisionOrigin;
  readonly analysisId: string | null;
  readonly decidedAt: string;
  readonly reasons: readonly DecisionReason[];
  readonly evidence: readonly WorkbenchEvidenceView[];
}

/**
 * A self-reported completion record; never an inference from an AC verdict.
 *
 * The completion mode and date are metadata, but the confirmed skills, the consulted solutions and
 * the free-text note (which can describe an algorithm) are solved-work material: while the
 * problem's spoilers are withheld they are **absent** own properties, not `null` and not an empty
 * array, so a caller cannot mistake redaction for "nothing recorded". `latestRetrospective` itself
 * stays visible for the selected account.
 */
export interface WorkbenchRetrospectiveView {
  readonly retrospectiveId: string;
  readonly problemKey: string;
  readonly accountId: string;
  readonly mode: CompletionMode;
  /** Confirmed skills; absent while withheld. */
  readonly taxonomyIds?: readonly string[];
  /** Consulted editorial solutions; absent while withheld. */
  readonly solutionIds?: readonly string[];
  /** The note: `null` means "no note", absent means "withheld". */
  readonly note?: string | null;
  readonly recordedAt: string;
}

/**
 * Full problem detail.
 *
 * Withheld spoiler material is absent from the object (`Object.hasOwn` is `false`); `null` is
 * reserved for genuinely absent records (`snapshot`, `latestRetrospective`).
 */
export interface WorkbenchProblemDetail {
  readonly problemKey: string;
  readonly sourceInstanceId: string;
  readonly domain: string | null;
  readonly externalKey: string;
  readonly title: string;
  readonly url: string;
  /** The statement is never withheld: reading it is the task, not a spoiler. */
  readonly statement: string | null;
  readonly fetchedAt: string;
  readonly rawRatings: readonly WorkbenchRatingView[];
  readonly accountId: string | null;
  readonly solvedByAccount: boolean;
  /** True when tags, decisions and editorial bodies are part of this response. */
  readonly spoilersVisible: boolean;
  /** Original platform tags; absent while withheld. */
  readonly rawTags?: readonly string[];
  /** Effective taxonomy ids at the head; absent while withheld. */
  readonly effectiveTaxonomyIds?: readonly string[];
  readonly snapshot: WorkbenchSnapshotView | null;
  readonly staleAnalysisCount: number;
  /** Stored analyses; absent while withheld. */
  readonly analyses?: readonly WorkbenchAnalysisView[];
  /** Manual decision history; absent while withheld. */
  readonly manualDecisions?: readonly WorkbenchManualDecisionView[];
  /** Current resolved decision per taxonomy id; absent while withheld. */
  readonly currentTagDecisions?: readonly WorkbenchTagDecisionView[];
  /** Latest retrospective of the selected account for this problem, when one exists. */
  readonly latestRetrospective: WorkbenchRetrospectiveView | null;
}

/** Result of one manual accept/reject. */
export interface WorkbenchTagReviewResult {
  readonly problemKey: string;
  readonly taxonomyId: string;
  readonly action: ManualTagAction;
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly note: string | null;
  /** Manual revision of this problem after the call; advances only for a new decision. */
  readonly manualRevision: number;
  /** `already_recorded` when the identical intent was already the current manual decision. */
  readonly outcome: 'recorded' | 'already_recorded';
  readonly status: Extract<TagDecisionStatus, 'accepted' | 'rejected'>;
}

/** Result of one recorded retrospective; history is append-only, so this is always new. */
export interface WorkbenchRetrospectiveResult {
  readonly problemKey: string;
  readonly accountId: string;
  readonly retrospectiveId: string;
  readonly mode: CompletionMode;
  readonly taxonomyIds: readonly string[];
  readonly solutionIds: readonly string[];
  readonly recordedAt: string;
  readonly note: string | null;
  readonly recorded: true;
}

// ---------------------------------------------------------------------------------------
// Weakness statistics (Stage 4w1b)
// ---------------------------------------------------------------------------------------

/**
 * Explicit bounds and provenance of one weakness read.
 *
 * `metadataMissingKeys` are attempted problems whose metadata row is absent: they still count as
 * attempted (distinct-problem counting is submission-driven), but they carry no tags or ratings, so
 * the caller sees exactly which part of the sample the statistics could not describe instead of
 * getting a silently smaller report.
 */
export interface WorkbenchWeaknessCoverage {
  readonly submissionRows: number;
  readonly distinctProblems: number;
  readonly metadataPresent: number;
  readonly metadataMissing: number;
  readonly metadataMissingKeys: readonly string[];
  readonly decisionsRead: number;
  /** AI decisions dropped because they no longer target the stored snapshot head. */
  readonly staleAiDecisionsExcluded: number;
  readonly retrospectivesRead: number;
  readonly submissionRowBound: number;
  readonly distinctProblemBound: number;
  readonly decisionRowBound: number;
  readonly retrospectiveRowBound: number;
}

/** Original platform tags, kept next to the report as unverified provenance. */
export interface WorkbenchRawTagProvenance {
  readonly problemsWithRawTags: number;
  readonly distinctRawTags: readonly string[];
  /** Always `false`: a raw platform tag is never an accepted/effective taxonomy tag. */
  readonly verified: false;
  readonly note: string;
}

/** One numeric value of one raw dimension and how many distinct solved problems carry it. */
export interface WorkbenchSolvedBucketView {
  readonly value: number;
  readonly count: number;
}

/**
 * One raw platform dimension of the solved distribution.
 *
 * `knownCount + unknownCount` is always the number of distinct solved problems, so an
 * all-unknown or empty series is renderable and never silently smaller than the real sample.
 */
export interface WorkbenchSolvedDimensionView {
  /** Original platform dimension name (`rating`, `difficulty`, …), never a merged scale. */
  readonly dimension: string;
  /** Numeric buckets sorted ascending; `sum(count)` equals `knownCount`. */
  readonly buckets: readonly WorkbenchSolvedBucketView[];
  readonly knownCount: number;
  readonly unknownCount: number;
}

/**
 * Difficulty distribution of every distinct accepted problem, one series per raw platform
 * dimension. `metadataMissingSolved` names the part of the sample that carries no local metadata
 * and therefore cannot appear in any bucket.
 */
export interface WorkbenchSolvedDistributionView {
  readonly totalSolved: number;
  readonly metadataMissingSolved: number;
  /** At least the dimension the source is expected to report, even when it has no usable value. */
  readonly dimensions: readonly WorkbenchSolvedDimensionView[];
}

/** One raw platform label with its distinct-problem sample; never an accepted tag. */
export interface WorkbenchPlatformTagStatView {
  readonly rawTag: string;
  readonly attemptedDistinct: number;
  readonly solvedDistinct: number;
  readonly unconfirmedDistinct: number;
  readonly solveRate: number;
  /** True from `minimumSampleSize` distinct attempts; insufficient samples stay listed. */
  readonly sufficientEvidence: boolean;
}

/**
 * Descriptive reference over raw platform labels of one account.
 *
 * `verified: false` is the whole point: these labels are platform claims, so they are displayed
 * next to the formal report and never counted as accepted tags. Counts are per distinct problem
 * and per distinct label, they overlap across labels, and they therefore do not sum to the
 * attempted total.
 */
export interface WorkbenchPlatformTagStatsView {
  /** Always `false`: a raw platform label is not an accepted/effective taxonomy tag. */
  readonly verified: false;
  readonly attemptedTaggedDistinct: number;
  readonly solvedTaggedDistinct: number;
  readonly minimumSampleSize: number;
  readonly tags: readonly WorkbenchPlatformTagStatView[];
}

/** One account's weakness statistics plus the coverage they were computed from. */
export interface WorkbenchWeaknessResult {
  /** Pure domain report: distinct problems, minimum-sample gate, latest retrospective wins. */
  readonly report: AccountWeaknessReport;
  /** Every distinct accepted problem over its own raw platform dimensions (provisional). */
  readonly solvedDistribution: WorkbenchSolvedDistributionView;
  /** Unverified platform-label reference; descriptive only, never formal weakness evidence. */
  readonly platformTagStats: WorkbenchPlatformTagStatsView;
  readonly coverage: WorkbenchWeaknessCoverage;
  readonly rawTagProvenance: WorkbenchRawTagProvenance;
}

// ---------------------------------------------------------------------------------------
// Training plans (Stage 4w1b)
// ---------------------------------------------------------------------------------------

/** Editable scheduling fields of one task; identity, links, tags and rationale are not editable. */
export interface WorkbenchPlanTaskPatch {
  readonly day?: number;
  readonly minutes?: number;
  readonly kind?: TrainingTaskKind;
}

/**
 * One scheduled task.
 *
 * `taxonomyIds` and `rationale` are spoiler material (they name the technique to use): while the
 * selected account has not solved the task's problem and no explicit reveal was requested they are
 * **absent** own properties, exactly like the bank/detail projections.
 */
export interface WorkbenchPlanTaskView {
  readonly taskId: string;
  readonly planId: string;
  readonly day: number;
  readonly order: number;
  readonly candidateId: string;
  readonly problemKey: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly minutes: number;
  readonly kind: TrainingTaskKind;
  readonly status: TrainingTaskStatus;
  readonly checkedAt: string | null;
  /** Candidate tags; absent while this task's problem is unsolved and not revealed. */
  readonly taxonomyIds?: readonly string[];
  /** Why the generator scheduled this candidate; absent while withheld. */
  readonly rationale?: string;
}

/** Per-day totals of one plan. */
export interface WorkbenchPlanDayView {
  readonly day: number;
  readonly taskCount: number;
  readonly minutes: number;
  readonly unmetMinutes: number;
}

/**
 * Plan-level evidence.
 *
 * `sufficientTagIds` is aggregate account weakness (tags with a sufficient sample), not a
 * per-problem mapping, so it stays visible while individual task tags are withheld.
 */
export interface WorkbenchPlanEvidenceView {
  readonly level: TrainingEvidenceLevel;
  readonly reasons: readonly PlanEvidenceReason[];
  readonly attemptedDistinctTotal: number;
  readonly sufficientTagIds: readonly string[];
}

/** One stored plan, projected field by field (no stored plan is ever spread into a response). */
export interface WorkbenchPlanView {
  readonly planId: string;
  readonly title: string;
  readonly source: 'rule' | 'model';
  readonly status: TrainingPlanStatus;
  readonly createdAt: string;
  readonly adoptedAt: string | null;
  readonly accountId: string | null;
  readonly horizonDays: number;
  readonly minutesPerDay: number;
  readonly totalPlannedMinutes: number;
  readonly totalUnmetMinutes: number;
  readonly taskCount: number;
  readonly distinctCandidates: number;
  readonly hasDuplicateCandidates: boolean;
  readonly days: readonly WorkbenchPlanDayView[];
  readonly tasks: readonly WorkbenchPlanTaskView[];
  readonly unmetMinutes: readonly UnmetMinutes[];
  readonly evidence: WorkbenchPlanEvidenceView;
  /** Full sha256 of the stored plan; the CAS token `adoptPlan`/`editPlanTask`/`checkOffTask` take. */
  readonly contentHash: string;
  /** Target tags of the whole plan; absent unless spoilers are explicitly revealed. */
  readonly targetedTagIds?: readonly string[];
}

/** Plans of one account; every plan belongs to the requested account. */
export interface WorkbenchPlanListResult {
  readonly accountId: string;
  readonly plans: readonly WorkbenchPlanView[];
}

/** Effective settings of one preview, echoed so the caller can reason about the draft. */
export interface WorkbenchPlanSettingsView {
  readonly estimatedMinutes: number;
  readonly horizonDays: number;
  readonly minutesPerDay: number;
}

/** One candidate the rule generator refused, with the domain's machine-readable reason. */
export interface WorkbenchPlanRejectedCandidateView {
  readonly candidateId: string | null;
  readonly reason: CandidateRejectionReason;
  readonly detail: string;
}

/** One starter technique offered when no valid candidate exists. */
export interface WorkbenchPlanBeginnerRecommendationView {
  readonly taxonomyId: string;
  readonly nameEn: string;
  readonly nameZh: string;
  readonly basis: 'taxonomy_default';
  readonly rationale: string;
}

/** A draft plan was generated and stored; `plan.contentHash` is the token for the next mutation. */
export interface WorkbenchPlanPreviewDraft {
  readonly outcome: 'draft';
  readonly plan: WorkbenchPlanView;
  readonly settings: WorkbenchPlanSettingsView;
  readonly rejectedCandidates: readonly WorkbenchPlanRejectedCandidateView[];
}

/** No valid candidate existed; nothing was stored and no problem was invented. */
export interface WorkbenchPlanPreviewInsufficient {
  readonly outcome: 'insufficient_evidence';
  readonly reason: 'insufficient_evidence';
  readonly evidence: WorkbenchPlanEvidenceView;
  readonly beginnerRecommendations: readonly WorkbenchPlanBeginnerRecommendationView[];
  readonly rejectedCandidates: readonly WorkbenchPlanRejectedCandidateView[];
  readonly settings: WorkbenchPlanSettingsView;
}

export type WorkbenchPlanPreviewResult = WorkbenchPlanPreviewDraft | WorkbenchPlanPreviewInsufficient;
