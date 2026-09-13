/**
 * Pure eligibility / adoption rules.
 *
 * An AI tag may be adopted without human review only when *all* of the following hold:
 *  1. the taxonomy id exists in the current vocabulary;
 *  2. every evidence reference names a source and a solution that exist in this snapshot,
 *     and the solution belongs to that source;
 *  3. the quoted excerpt really occurs inside that specific solution's text;
 *  4. a dedicated second verification pass supports the suggestion, with `evidenceOk`, and
 *     no verification reports a conflict;
 *  5. the suggestion did not come from the reasoning role (reasoning output always needs
 *     review, because it exists precisely when no editorial could be cited).
 *
 * Independent of the above, two hard precedence rules apply:
 *  - a manual accept/reject always wins over model output;
 *  - an analysis produced against a stale snapshot may not write any decision at all.
 */
import { DomainError, invariant } from './errors.js';
import { deepFreeze } from './immutable.js';
import {
  MIN_EVIDENCE_EXCERPT_CHARS,
  verifyExcerptInSolution,
  type EvidenceRef,
} from './editorial.js';
import type { ProblemSnapshot, SnapshotHead } from './snapshot.js';
import { findSolution, findSource } from './snapshot.js';
import type { TaxonomyIndex } from './taxonomy/types.js';
import {
  createTagDecision,
  currentDecisionPerTag,
  decisionIsEffective,
  manualDecisionsForProblem,
  type AiTagSuggestion,
  type DecisionReason,
  type ManualTagDecision,
  type TagDecision,
} from './tags.js';
import {
  analysisIsStale,
  type AnalysisResult,
  type SuggestionVerification,
} from './analysis.js';

/** Explicit settings for eligibility evaluation. */
export interface EligibilitySettings {
  /** Minimum evidence excerpt length; guards against trivially forgeable quotes. */
  readonly minExcerptChars: number;
}

export const DEFAULT_ELIGIBILITY_SETTINGS: EligibilitySettings = {
  minExcerptChars: MIN_EVIDENCE_EXCERPT_CHARS,
};

export interface EvaluateSuggestionContext {
  readonly index: TaxonomyIndex;
  readonly snapshot: ProblemSnapshot;
  readonly analysis: AnalysisResult;
  /** Snapshot currently stored for this problem; `null` when nothing is stored. */
  readonly currentHead: SnapshotHead | null;
  readonly manualDecisions: readonly ManualTagDecision[];
  readonly settings: EligibilitySettings;
  /**
   * Decisions already stored for this problem, in the store's own order.
   *
   * They are consulted only by a *checked* analysis (one carrying a completeness record): an
   * effective non-manual AI tag that the new check no longer supports is then explicitly
   * withdrawn with a current `needs_review` decision. Failed, cancelled and reasoning-only
   * runs must not pass this context, so they can never withdraw the last valid adoption.
   */
  readonly previousDecisions?: readonly TagDecision[];
}

export type EligibilityDecision =
  | 'auto_adopted'
  | 'needs_review'
  | 'rejected'
  | 'accepted_manual'
  | 'rejected_manual'
  | 'stale_analysis';

export interface EligibilityOutcome {
  readonly suggestionId: string;
  readonly problemKey: string;
  readonly taxonomyId: string;
  readonly role: AiTagSuggestion['role'];
  readonly decision: EligibilityDecision;
  readonly reasons: readonly DecisionReason[];
  readonly evidenceOk: boolean;
  readonly evidence: readonly EvidenceRef[];
  readonly verifications: readonly SuggestionVerification[];
  readonly stale: boolean;
}

function outcome(
  suggestion: AiTagSuggestion,
  decision: EligibilityDecision,
  reasons: readonly DecisionReason[],
  evidenceOk: boolean,
  verifications: readonly SuggestionVerification[],
  stale: boolean,
): EligibilityOutcome {
  return deepFreeze({
    suggestionId: suggestion.suggestionId,
    problemKey: suggestion.problemKey,
    taxonomyId: suggestion.taxonomyId,
    role: suggestion.role,
    decision,
    reasons: [...new Set(reasons)],
    evidenceOk,
    evidence: suggestion.evidence,
    verifications,
    stale,
  });
}

/**
 * Evaluate one suggestion against the snapshot, taxonomy, verification and manual decisions.
 *
 * Only verification records that describe *this* analysis pass are considered: same
 * suggestion, same problem, same snapshot. A verification produced for another snapshot (or
 * another problem's analysis) must not be able to push a suggestion into auto-adoption.
 */
export function evaluateSuggestion(
  suggestion: AiTagSuggestion,
  context: EvaluateSuggestionContext,
): EligibilityOutcome {
  const { analysis, currentHead, snapshot, index, settings } = context;
  const mismatched = analysis.verifications.filter(
    (entry) =>
      entry.suggestionId === suggestion.suggestionId &&
      (entry.problemKey !== analysis.problemKey || entry.snapshotId !== analysis.snapshotId),
  );
  if (mismatched.length > 0) {
    throw new DomainError('invalid_input', 'verification does not belong to this analysis', {
      suggestionId: suggestion.suggestionId,
      analysis: analysis.analysisId,
      verification: mismatched[0]?.verificationId ?? null,
    });
  }
  const verifications = analysis.verifications.filter((entry) => entry.suggestionId === suggestion.suggestionId);

  if (analysisIsStale(analysis, currentHead)) {
    return outcome(
      suggestion,
      'stale_analysis',
      [currentHead ? 'stale_analysis' : 'no_snapshot_head'],
      false,
      verifications,
      true,
    );
  }
  if (analysis.problemKey !== suggestion.problemKey) {
    throw new DomainError('invalid_input', 'suggestion does not belong to the analysis problem', {
      suggestionId: suggestion.suggestionId,
      analysisProblem: analysis.problemKey,
      suggestionProblem: suggestion.problemKey,
    });
  }

  const manual = manualDecisionsForProblem(context.manualDecisions, suggestion.problemKey).get(suggestion.taxonomyId);
  if (manual) {
    const accept = manual.action === 'accept';
    return outcome(
      suggestion,
      accept ? 'accepted_manual' : 'rejected_manual',
      ['manual_precedence', accept ? 'manual_accept' : 'manual_reject'],
      true,
      verifications,
      false,
    );
  }

  // Only a fully completed analysis may auto-adopt. Partial/failed/cancelled runs are
  // recorded for the human, never trusted as verified knowledge.
  if (analysis.status !== 'completed') {
    return outcome(suggestion, 'needs_review', ['analysis_incomplete'], false, verifications, false);
  }

  if (!index.has(suggestion.taxonomyId)) {
    return outcome(suggestion, 'rejected', ['unknown_taxonomy_id'], false, verifications, false);
  }

  if (suggestion.evidence.length === 0) {
    return outcome(suggestion, 'needs_review', ['missing_evidence'], false, verifications, false);
  }

  const evidenceReasons: DecisionReason[] = [];
  const seenSolutions = new Set<string>();
  for (const evidence of suggestion.evidence) {
    if (seenSolutions.has(evidence.solutionId)) {
      evidenceReasons.push('duplicate_solution_evidence');
      continue;
    }
    seenSolutions.add(evidence.solutionId);

    const source = findSource(snapshot, evidence.sourceId);
    if (!source) {
      evidenceReasons.push('missing_source');
      continue;
    }
    if (source.availability !== 'found') {
      evidenceReasons.push('source_unavailable');
      continue;
    }
    const solution = findSolution(snapshot, evidence.solutionId);
    if (!solution) {
      evidenceReasons.push('missing_solution');
      continue;
    }
    if (solution.sourceId !== evidence.sourceId) {
      evidenceReasons.push('evidence_source_mismatch');
      continue;
    }
    const check = verifyExcerptInSolution(solution, evidence.excerpt, settings.minExcerptChars);
    if (!check.ok) {
      if (check.reason === 'excerpt_too_short') {
        evidenceReasons.push('evidence_excerpt_too_short');
      } else if (check.reason === 'empty_excerpt') {
        evidenceReasons.push('missing_evidence');
      } else {
        evidenceReasons.push('evidence_not_in_solution');
      }
    }
  }
  if (evidenceReasons.length > 0) {
    return outcome(suggestion, 'rejected', evidenceReasons, false, verifications, false);
  }

  if (verifications.length === 0) {
    return outcome(
      suggestion,
      'needs_review',
      suggestion.role === 'reasoning' ? ['missing_verification', 'reasoning_requires_review'] : ['missing_verification'],
      true,
      verifications,
      false,
    );
  }

  const conflicting = verifications.filter(
    (entry) => entry.verdict === 'conflict' || entry.conflictingSolutionIds.length > 0,
  );
  if (conflicting.length > 0) {
    return outcome(suggestion, 'needs_review', ['verification_conflict'], true, verifications, false);
  }
  const insufficient = verifications.filter((entry) => entry.verdict === 'insufficient' || !entry.evidenceOk);
  if (insufficient.length > 0) {
    return outcome(suggestion, 'needs_review', ['verification_insufficient'], true, verifications, false);
  }

  const secondPassSupport = verifications.filter(
    (entry) =>
      entry.verdict === 'support' &&
      entry.evidenceOk &&
      entry.verifierRole === 'verification' &&
      entry.snapshotId === snapshot.snapshotId,
  );
  if (secondPassSupport.length === 0) {
    return outcome(suggestion, 'needs_review', ['verification_mismatch'], true, verifications, false);
  }

  if (suggestion.role === 'reasoning') {
    return outcome(suggestion, 'needs_review', ['reasoning_requires_review'], true, verifications, false);
  }

  return outcome(suggestion, 'auto_adopted', ['evidence_verified', 'verification_support'], true, verifications, false);
}

/** Evaluate every suggestion of an analysis. */
export function evaluateAnalysis(context: EvaluateSuggestionContext): readonly EligibilityOutcome[] {
  invariant(
    context.analysis.snapshotId === context.snapshot.snapshotId,
    'invalid_input',
    'analysis and snapshot do not match',
    { analysis: context.analysis.analysisId, snapshot: context.snapshot.snapshotId },
  );
  invariant(
    context.analysis.problemKey === context.snapshot.problem.key,
    'invalid_input',
    'analysis and snapshot describe different problems',
    { analysis: context.analysis.analysisId, problemKey: context.analysis.problemKey },
  );
  return context.analysis.suggestions.map((suggestion) => evaluateSuggestion(suggestion, context));
}

export interface ResolvedAnalysis {
  /** True when the analysis targets an outdated snapshot; no decisions were produced. */
  readonly stale: boolean;
  readonly outcomes: readonly EligibilityOutcome[];
  readonly decisions: readonly TagDecision[];
}

const STATUS_BY_DECISION: Record<
  Exclude<EligibilityDecision, 'stale_analysis'>,
  TagDecision['status']
> = {
  auto_adopted: 'auto_adopted',
  needs_review: 'needs_review',
  rejected: 'rejected',
  accepted_manual: 'accepted',
  rejected_manual: 'rejected',
};

/**
 * Resolve an analysis into decisions.
 * A stale analysis produces *no* decisions, so it can never overwrite current state; this
 * holds even when the analysis contains no suggestions at all (`stale` is a property of the
 * analysis/snapshot pairing, not of its suggestion list).
 */
export function resolveTagDecisions(context: EvaluateSuggestionContext): ResolvedAnalysis {
  const outcomes = evaluateAnalysis(context);
  const stale = analysisIsStale(context.analysis, context.currentHead);
  const manualByTag = manualDecisionsForProblem(context.manualDecisions, context.analysis.problemKey);
  const decisions: TagDecision[] = [];

  for (const entry of outcomes) {
    if (entry.decision === 'stale_analysis') {
      continue;
    }
    const manual = manualByTag.get(entry.taxonomyId);
    const decidedAt = manual ? manual.decidedAt : context.analysis.createdAt;
    decisions.push(
      createTagDecision({
        problemKey: entry.problemKey,
        taxonomyId: entry.taxonomyId,
        status: STATUS_BY_DECISION[entry.decision],
        origin: entry.decision === 'accepted_manual' || entry.decision === 'rejected_manual' ? 'manual' : 'ai',
        analysisId: context.analysis.analysisId,
        suggestionId: entry.suggestionId,
        snapshotId: context.analysis.snapshotId,
        snapshotVersion: context.analysis.snapshotVersion,
        decidedAt,
        reasons: entry.reasons,
        evidence: entry.evidence,
      }),
    );
  }

  decisions.push(...withdrawnAdoptions(context, decisions, manualByTag));

  return deepFreeze({
    stale,
    outcomes,
    decisions,
  });
}

/**
 * Withdraw old automatic adoptions that the current, checked analysis no longer supports.
 *
 * The store's decision history only ever *adds* rows, and the effective view is the current
 * decision per (problem, tag). Merely omitting an old tag from a new result therefore leaves
 * it wrongly effective; a completed check that dropped it must record a current
 * `needs_review` decision (`stale_analysis`). Rules:
 *
 * - only a checked analysis may withdraw (a completeness record must be present), so failed,
 *   cancelled and reasoning-only runs never undo the last valid adoption;
 * - manual accept/reject always wins: a tag with any manual decision is left untouched;
 * - a tag the new analysis already decided (adopted, rejected or sent to review) needs no
 *   withdrawal — that fresh decision is the correction;
 * - original raw platform tags are never touched: this only ever appends decisions.
 */
function withdrawnAdoptions(
  context: EvaluateSuggestionContext,
  fresh: readonly TagDecision[],
  manualByTag: ReadonlyMap<string, ManualTagDecision>,
): TagDecision[] {
  const previous = context.previousDecisions ?? [];
  if (previous.length === 0 || context.analysis.completeness === undefined) {
    return [];
  }
  if (analysisIsStale(context.analysis, context.currentHead)) {
    return [];
  }
  const decidedTags = new Set(fresh.map((decision) => decision.taxonomyId));
  const withdrawn: TagDecision[] = [];
  for (const [taxonomyId, decision] of currentDecisionPerTag(previous)) {
    if (decision.origin !== 'ai' || !decisionIsEffective(decision)) {
      continue;
    }
    if (manualByTag.has(taxonomyId) || decidedTags.has(taxonomyId)) {
      continue;
    }
    withdrawn.push(
      createTagDecision({
        problemKey: context.analysis.problemKey,
        taxonomyId,
        status: 'needs_review',
        origin: 'ai',
        analysisId: context.analysis.analysisId,
        suggestionId: null,
        snapshotId: context.analysis.snapshotId,
        snapshotVersion: context.analysis.snapshotVersion,
        decidedAt: context.analysis.createdAt,
        reasons: ['stale_analysis'],
        evidence: [],
      }),
    );
  }
  return withdrawn.sort((left, right) => left.taxonomyId.localeCompare(right.taxonomyId));
}

/** Outcomes a human must look at (needs review or was rejected), in stable order. */
export function outcomesRequiringReview(outcomes: readonly EligibilityOutcome[]): readonly EligibilityOutcome[] {
  return outcomes.filter((entry) => entry.decision === 'needs_review' || entry.decision === 'rejected');
}
