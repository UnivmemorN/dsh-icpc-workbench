/**
 * Workbench DTOs (Stage 4w1a): bank reads, manual review and retrospective projections.
 *
 * Every member is JSON-serializable and every DTO is built by explicit field projection, never by
 * spreading a storage row. Spoiler-bearing members are *optional and absent* while they are
 * withheld: `Object.hasOwn(dto, 'rawTags') === false` means "not part of this response", and an
 * empty array or `null` never stands in for redaction. `null` is reserved for genuinely nullable
 * members (`note`, `latestRetrospective`, `snapshot`), where it means "present but empty/unknown",
 * which is a different statement from absence.
 */
import type {
  AnalysisStatus,
  CompletionMode,
  DecisionReason,
  EditorialAvailability,
  EditorialSourceKind,
  ManualTagAction,
  ModelRole,
  ModelUsage,
  TagDecisionOrigin,
  TagDecisionStatus,
  VerificationVerdict,
} from '../domain/index.js';

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
