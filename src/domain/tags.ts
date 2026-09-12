/**
 * Tag provenance: original platform tags, AI suggestions, manual decisions, resolved decisions.
 *
 * The three sources stay permanently distinguishable:
 * - raw platform tags live on the problem (`NormalizedProblem.rawTags`);
 * - model output lives in {@link AiTagSuggestion} inside an analysis result;
 * - human choices live in {@link ManualTagDecision} and always win.
 *
 * {@link TagDecision} is the resolved view consumed by statistics and the UI. Only
 * `auto_adopted` and `accepted` decisions are *effective*; `needs_review` is recorded but
 * never counted, which is what keeps unverified model output out of weakness statistics.
 * Because decisions accumulate as history, the effective view is the *current* decision per
 * (problem, tag) — see {@link effectiveTagIdsByProblem} — where a manual accept/reject
 * outranks model output and an older adoption can never resurrect a rejected tag.
 */
import { invariant } from './errors.js';
import { assertIsoTimestamp, normalizeKeyPart, problemKey, type ProblemRef } from './ids.js';
import { deepFreeze } from './immutable.js';
import { contentHashOf } from './hash.js';
import { createEvidenceRef, type EvidenceRef } from './editorial.js';

export { createEvidenceRef, type EvidenceRef } from './editorial.js';

/** Which model role produced a piece of output. Reasoning output always needs review. */
export type ModelRole = 'analysis' | 'verification' | 'reasoning';

/** One AI-proposed taxonomy tag for one problem, with per-solution evidence. */
export interface AiTagSuggestion {
  readonly suggestionId: string;
  readonly problemKey: string;
  /** Snapshot the model actually saw. */
  readonly snapshotId: string;
  readonly taxonomyId: string;
  readonly role: ModelRole;
  readonly rationale: string;
  readonly evidence: readonly EvidenceRef[];
  readonly createdAt: string;
}

export interface CreateAiTagSuggestionInput {
  readonly problemRef: ProblemRef;
  readonly snapshotId: string;
  readonly taxonomyId: string;
  readonly role: ModelRole;
  readonly rationale: string;
  readonly evidence: readonly EvidenceRef[];
  readonly createdAt: string;
}

/** Build a validated, frozen AI suggestion. Unknown taxonomy ids are *recorded*, not thrown. */
export function createAiTagSuggestion(input: CreateAiTagSuggestionInput): AiTagSuggestion {
  const taxonomyId = input.taxonomyId.trim();
  invariant(taxonomyId.length > 0, 'invalid_input', 'suggestion taxonomyId must not be empty', { input });
  const problem = problemKey(input.problemRef);
  const createdAt = assertIsoTimestamp('createdAt', input.createdAt);
  const suggestionId = `suggestion|${contentHashOf({
    problem,
    snapshotId: input.snapshotId,
    taxonomyId,
    role: input.role,
    createdAt,
  }).slice(0, 32)}`;
  return deepFreeze({
    suggestionId,
    problemKey: problem,
    snapshotId: input.snapshotId,
    taxonomyId,
    role: input.role,
    rationale: input.rationale.trim(),
    evidence: input.evidence.map((evidence) => createEvidenceRef(evidence)),
    createdAt,
  });
}

export type ManualTagAction = 'accept' | 'reject';

/** A human accept/reject of one taxonomy tag on one problem. Takes precedence over AI. */
export interface ManualTagDecision {
  readonly decisionId: string;
  readonly problemKey: string;
  readonly taxonomyId: string;
  readonly action: ManualTagAction;
  readonly decidedAt: string;
  readonly note: string | null;
  /** Analysis that was on screen when the human decided (audit only; never a gate). */
  readonly supersedesAnalysisId: string | null;
}

export interface CreateManualTagDecisionInput {
  readonly problemRef: ProblemRef;
  readonly taxonomyId: string;
  readonly action: ManualTagAction;
  readonly decidedAt: string;
  readonly note?: string | null;
  readonly supersedesAnalysisId?: string | null;
}

/** Build a validated, frozen manual decision. */
export function createManualTagDecision(input: CreateManualTagDecisionInput): ManualTagDecision {
  const taxonomyId = input.taxonomyId.trim();
  invariant(taxonomyId.length > 0, 'invalid_input', 'manual decision taxonomyId must not be empty', { input });
  invariant(
    input.action === 'accept' || input.action === 'reject',
    'invalid_input',
    `manual action must be accept|reject (got ${String(input.action)})`,
    { action: input.action },
  );
  const problem = problemKey(input.problemRef);
  const decidedAt = assertIsoTimestamp('decidedAt', input.decidedAt);
  return deepFreeze({
    decisionId: `manual|${contentHashOf({ problem, taxonomyId, action: input.action, decidedAt }).slice(0, 32)}`,
    problemKey: problem,
    taxonomyId,
    action: input.action,
    decidedAt,
    note: input.note?.trim() || null,
    supersedesAnalysisId: input.supersedesAnalysisId ?? null,
  });
}

export type TagDecisionStatus = 'auto_adopted' | 'needs_review' | 'accepted' | 'rejected';
export type TagDecisionOrigin = 'ai' | 'manual' | 'rule';

/** Machine-readable reasons attached to a resolved decision. */
export type DecisionReason =
  | 'evidence_verified'
  | 'verification_support'
  | 'manual_precedence'
  | 'manual_accept'
  | 'manual_reject'
  | 'unknown_taxonomy_id'
  | 'missing_evidence'
  | 'missing_source'
  | 'source_unavailable'
  | 'evidence_source_mismatch'
  | 'missing_solution'
  | 'evidence_not_in_solution'
  | 'evidence_excerpt_too_short'
  | 'duplicate_solution_evidence'
  | 'missing_verification'
  | 'verification_insufficient'
  | 'verification_conflict'
  | 'verification_mismatch'
  | 'reasoning_requires_review'
  | 'analysis_incomplete'
  | 'stale_snapshot'
  | 'stale_analysis'
  | 'no_snapshot_head';

/** Resolved tag decision: the only shape statistics and plans read. */
export interface TagDecision {
  readonly decisionId: string;
  readonly problemKey: string;
  readonly taxonomyId: string;
  readonly status: TagDecisionStatus;
  readonly origin: TagDecisionOrigin;
  readonly analysisId: string | null;
  readonly suggestionId: string | null;
  readonly snapshotId: string | null;
  readonly snapshotVersion: number | null;
  readonly decidedAt: string;
  readonly reasons: readonly DecisionReason[];
  readonly evidence: readonly EvidenceRef[];
}

export interface CreateTagDecisionInput {
  readonly problemKey: string;
  readonly taxonomyId: string;
  readonly status: TagDecisionStatus;
  readonly origin: TagDecisionOrigin;
  readonly decidedAt: string;
  readonly reasons: readonly DecisionReason[];
  readonly analysisId?: string | null;
  readonly suggestionId?: string | null;
  readonly snapshotId?: string | null;
  readonly snapshotVersion?: number | null;
  readonly evidence?: readonly EvidenceRef[];
}

/** Build a validated, frozen resolved decision. */
export function createTagDecision(input: CreateTagDecisionInput): TagDecision {
  const decidedAt = assertIsoTimestamp('decidedAt', input.decidedAt);
  const analysisId = input.analysisId ?? null;
  return deepFreeze({
    decisionId: `tagdecision|${contentHashOf({
      problemKey: input.problemKey,
      taxonomyId: input.taxonomyId,
      status: input.status,
      origin: input.origin,
      analysisId,
      decidedAt,
    }).slice(0, 32)}`,
    problemKey: input.problemKey,
    taxonomyId: input.taxonomyId,
    status: input.status,
    origin: input.origin,
    analysisId,
    suggestionId: input.suggestionId ?? null,
    snapshotId: input.snapshotId ?? null,
    snapshotVersion: input.snapshotVersion ?? null,
    decidedAt,
    reasons: [...new Set(input.reasons)],
    evidence: input.evidence ?? [],
  });
}

/** A decision counts towards statistics only when adopted automatically or accepted manually. */
export function decisionIsEffective(decision: Pick<TagDecision, 'status'>): boolean {
  return decision.status === 'auto_adopted' || decision.status === 'accepted';
}

/**
 * True when `candidate` describes the same (problem, tag) more recently than `current`.
 *
 * A human decision always outranks model/rule output — a re-analysis must never undo an
 * explicit accept/reject — and among decisions of equal standing the later `decidedAt`
 * wins. Decisions are an append-only history, so the list order is irrelevant; a tie on
 * timestamp is resolved in favour of the later entry, keeping the result deterministic.
 */
function decisionSupersedes(current: TagDecision, candidate: TagDecision): boolean {
  const currentManual = current.origin === 'manual';
  const candidateManual = candidate.origin === 'manual';
  if (currentManual !== candidateManual) {
    return candidateManual;
  }
  return Date.parse(candidate.decidedAt) >= Date.parse(current.decidedAt);
}

/** The one decision that currently describes each taxonomy id of a problem. */
export function currentDecisionPerTag(decisions: readonly TagDecision[]): ReadonlyMap<string, TagDecision> {
  const byTag = new Map<string, TagDecision>();
  for (const decision of decisions) {
    const current = byTag.get(decision.taxonomyId);
    if (!current || decisionSupersedes(current, decision)) {
      byTag.set(decision.taxonomyId, decision);
    }
  }
  return byTag;
}

/**
 * Effective taxonomy ids per problem key.
 *
 * Only the *current* decision per (problem, tag) is read: an earlier `auto_adopted` entry
 * must not keep a tag in the statistics after a human rejected it, so the historical list
 * is deduplicated instead of unioned. Ids are sorted for deterministic output.
 */
export function effectiveTagIdsByProblem(
  decisions: readonly TagDecision[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, TagDecision[]>();
  for (const decision of decisions) {
    const bucket = grouped.get(decision.problemKey);
    if (bucket) {
      bucket.push(decision);
    } else {
      grouped.set(decision.problemKey, [decision]);
    }
  }
  const result = new Map<string, readonly string[]>();
  for (const [key, bucket] of grouped) {
    result.set(
      key,
      [...currentDecisionPerTag(bucket).values()]
        .filter((decision) => decisionIsEffective(decision))
        .map((decision) => decision.taxonomyId)
        .sort(),
    );
  }
  return result;
}

/** Effective taxonomy ids of one problem, deduplicated, current-decision-only and ordered. */
export function effectiveTagIdsForProblem(decisions: readonly TagDecision[], key: string): readonly string[] {
  return effectiveTagIdsByProblem(decisions).get(key) ?? [];
}

/** Current manual decision per taxonomy id for one problem (latest wins). */
export function manualDecisionsForProblem(
  decisions: readonly ManualTagDecision[],
  key: string,
): ReadonlyMap<string, ManualTagDecision> {
  const byTag = new Map<string, ManualTagDecision>();
  for (const decision of decisions) {
    if (decision.problemKey !== key) {
      continue;
    }
    const current = byTag.get(decision.taxonomyId);
    if (!current || Date.parse(decision.decidedAt) >= Date.parse(current.decidedAt)) {
      byTag.set(decision.taxonomyId, decision);
    }
  }
  return byTag;
}

/** Validate a taxonomy id string used in suggestions/decisions. */
export function assertTaxonomyIdShape(taxonomyId: string): string {
  return normalizeKeyPart(taxonomyId);
}
