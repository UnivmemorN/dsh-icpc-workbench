/**
 * Knowledge learning evidence (Sprint 09a).
 *
 * One pure reduction over the evidence a weakness read already collected: it answers "which
 * taxonomy nodes has this account actually shown work on, and how independent was that work?"
 * without a second storage, platform or model read.
 *
 * Counting rules (all deliberately conservative):
 * - the unit is the **distinct problem** of the selected account; a submission row of another
 *   account is never counted and repeated ACs never inflate anything;
 * - four evidence channels stay permanently distinguishable and are never promoted into one
 *   another: `platform*` (raw tags resolved through the taxonomy alias index — provisional),
 *   `verified*` (current effective tag decisions), `retrospective*` (the latest self-reported
 *   completion per account+problem) and `observedRelated*` (their set union, each problem once);
 * - an accepted submission alone confirms **no** method: only a retrospective can produce
 *   `practicing`/`independent_evidence`, and only on a problem this account actually got accepted;
 * - only the **latest** retrospective per (account, problem) counts, so a re-recorded weaker
 *   statement correctly downgrades earlier stronger evidence;
 * - direct evidence propagates **up** to ancestors by distinct-problem sets (a parent therefore
 *   counts a shared child problem once) and never **down** to children;
 * - unknown taxonomy ids are ignored, never fabricated; unknown raw algorithm labels are exposed
 *   as an honest coverage gap instead of being forced into a node;
 * - category rows always carry status `category_summary` plus the number of descendant technique
 *   nodes that hold independent evidence, out of all descendant technique nodes. A technique
 *   status ({@link KnowledgeNodeStatus}) is a transparent product heuristic, **not** a validated
 *   mastery probability: no synthetic mastery percentage, score or ranking is produced anywhere.
 *
 * Every output order is code-point order or the taxonomy's own catalog order, never
 * `localeCompare`, so the same evidence reports identically on every machine and locale.
 */
import { invariant, requireFiniteInt } from './errors.js';
import { deepFreeze } from './immutable.js';
import { numericRating, type NormalizedProblem } from './problem.js';
import { latestRetrospectiveByProblem, type CompletionMode, type Retrospective } from './retrospective.js';
import { reduceSubmissionsByAccount, type Submission } from './submission.js';
import { classifyRawTag } from './taxonomy/classify.js';
import type { TaxonomyIndex, TaxonomyNodeKind } from './taxonomy/types.js';
import { effectiveTagIdsByProblem, type TagDecision } from './tags.js';

/** Independent problems required before a technique reaches `independent_evidence` by default. */
export const DEFAULT_MINIMUM_INDEPENDENT_PROBLEMS = 5;

/**
 * Learning status of one taxonomy node.
 *
 * - `not_observed` — no related problem at all: the node is reported, never hidden;
 * - `unconfirmed` — some related problems, but no retrospective records what was actually done;
 * - `needs_practice` — retrospectives exist, but every one of them used assistance or a solution;
 * - `practicing` — 1..`minimumIndependentProblems - 1` independent problems;
 * - `independent_evidence` — at least `minimumIndependentProblems` independent problems;
 * - `category_summary` — a category row: it summarises its descendants and never claims mastery.
 */
export type KnowledgeNodeStatus =
  | 'not_observed'
  | 'unconfirmed'
  | 'needs_practice'
  | 'practicing'
  | 'independent_evidence'
  | 'category_summary';

/**
 * Rating range of the independently confirmed problems of one node, in one raw platform
 * dimension (never a merged cross-platform scale).
 *
 * `count` problems carry a usable numeric value; `missing` problems of the same independent set
 * do not (absent dimension, blank/text value, non-finite value or no local metadata row at all).
 * `count + missing` is therefore always the node's `retrospectiveIndependentDistinct`.
 */
export interface KnowledgeRatingRange {
  /** Original platform dimension name (`rating`, `difficulty`, …), exactly as reported. */
  readonly dimension: string;
  readonly count: number;
  readonly missing: number;
  /** Smallest numeric value, or `null` when no independent problem carries one. */
  readonly min: number | null;
  /** Largest numeric value, or `null` when no independent problem carries one. */
  readonly max: number | null;
}

/**
 * Learning evidence of one taxonomy node.
 *
 * Every count is a number of **distinct problems**. `platform*` is provisional raw-tag evidence,
 * `verified*` is effective tag-decision evidence, `retrospective*` is self-reported completion
 * evidence and `observedRelatedDistinct` is the union of the three (it is never their sum).
 * Ancestor rows include their descendants' problems, so a category aggregates its subtree.
 */
export interface KnowledgeNodeEvidence {
  readonly taxonomyId: string;
  readonly parentId: string | null;
  readonly kind: TaxonomyNodeKind;
  /** Distinct attempted/solved problems whose raw tags resolve to this node (provisional). */
  readonly platformAttemptedDistinct: number;
  readonly platformSolvedDistinct: number;
  /** Distinct attempted/solved problems with an effective tag decision on this node. */
  readonly verifiedAttemptedDistinct: number;
  readonly verifiedSolvedDistinct: number;
  /** Distinct problems whose LATEST retrospective used this node independently. */
  readonly retrospectiveIndependentDistinct: number;
  /** Distinct problems whose LATEST retrospective used this node with assistance. */
  readonly retrospectiveAssistedDistinct: number;
  /** Distinct problems whose LATEST retrospective used this node via a consulted solution. */
  readonly retrospectiveSolutionUsedDistinct: number;
  /** Union of the raw, verified and retrospective problem sets — each problem counted once. */
  readonly observedRelatedDistinct: number;
  /** Native-dimension ranges over independently confirmed problems only; `[]` when none. */
  readonly independentRatingRanges: readonly KnowledgeRatingRange[];
  readonly status: KnowledgeNodeStatus;
  /** Category rows: descendant technique nodes in this subtree (0 on technique rows). */
  readonly descendantTechniqueNodes: number;
  /** Category rows: those descendants with at least one independent problem (0 on techniques). */
  readonly descendantTechniqueNodesWithIndependentEvidence: number;
}

/** What one knowledge read could describe, so an empty or partly unknown sample stays honest. */
export interface KnowledgeCoverage {
  readonly attemptedDistinctTotal: number;
  readonly solvedDistinctTotal: number;
  /** Attempted problems with at least one known taxonomy id in any evidence channel. */
  readonly relatedAttemptedDistinct: number;
  /** Attempted problems with at least one effective verified taxonomy id. */
  readonly verifiedAttemptedDistinct: number;
  /** Solved problems with a latest retrospective for the selected account. */
  readonly retrospectiveProblemDistinct: number;
  /** Attempted problems carrying at least one raw label that maps to no taxonomy node. */
  readonly unmatchedAlgorithmProblemDistinct: number;
}

/** One account's per-taxonomy-node learning evidence. */
export interface KnowledgeEvidenceReport {
  readonly accountId: string;
  readonly taxonomyVersion: string;
  /** Independent problems required for `independent_evidence` (echoed, never implicit). */
  readonly minimumIndependentProblems: number;
  readonly coverage: KnowledgeCoverage;
  /** Every taxonomy node, in the taxonomy's own catalog order, zero-evidence nodes included. */
  readonly nodes: readonly KnowledgeNodeEvidence[];
  /**
   * Distinct raw labels that are neither a known taxonomy alias nor recognised non-algorithm
   * provenance. They stay unmapped: the product never fabricates a taxonomy id for them.
   */
  readonly unmatchedAlgorithmLabels: readonly string[];
  /** Machine-readable disclaimers; the status is a heuristic, not a mastery probability. */
  readonly notes: readonly string[];
}

/** Disclaimers that must travel with every knowledge report. */
export const KNOWLEDGE_NOTES: readonly string[] = [
  'status_is_a_transparent_heuristic_not_a_mastery_probability',
  'accepted_submission_alone_confirms_no_method',
  'unknown_labels_are_not_forced_into_a_taxonomy_node',
];

export interface ComputeKnowledgeEvidenceInput {
  /** Current vocabulary; it decides node identity, aliases and catalog order. */
  readonly taxonomy: TaxonomyIndex;
  /** The one account every count describes; foreign rows are ignored, never merged. */
  readonly accountId: string;
  /** Metadata rows of the attempted problems; a metadata-missing problem is simply absent. */
  readonly problems: readonly NormalizedProblem[];
  /** Submissions of the account (foreign-account rows are ignored by the account reduction). */
  readonly submissions: readonly Submission[];
  /** Effective-eligible tag decisions; the caller already dropped stale AI decisions. */
  readonly decisions: readonly TagDecision[];
  /** Retrospective history of the account; only the latest per problem counts. */
  readonly retrospectives: readonly Retrospective[];
  /** Independent-problem threshold; defaults to {@link DEFAULT_MINIMUM_INDEPENDENT_PROBLEMS}. */
  readonly minimumIndependentProblems?: number;
}

/** Shared immutable empty set, so a zero-evidence node allocates nothing. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/** Locale-independent UTF-16 text order; `0` only for equal text. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Deterministic iteration order for a key set. */
function sortedKeys(keys: Iterable<string>): string[] {
  return [...keys].sort(compareText);
}

/** Add one problem to a node's set and to every ancestor's set (never to a child's). */
function addEvidence(
  index: TaxonomyIndex,
  buckets: Map<string, Set<string>>,
  taxonomyId: string,
  problemKey: string,
): void {
  const direct = buckets.get(taxonomyId);
  if (direct) {
    direct.add(problemKey);
  } else {
    buckets.set(taxonomyId, new Set([problemKey]));
  }
  for (const ancestor of index.ancestors(taxonomyId)) {
    const bucket = buckets.get(ancestor.id);
    if (bucket) {
      bucket.add(problemKey);
    } else {
      buckets.set(ancestor.id, new Set([problemKey]));
    }
  }
}

/** Size of one node's problem set; `0` for a node that never received evidence. */
function sizeOf(buckets: ReadonlyMap<string, ReadonlySet<string>>, taxonomyId: string): number {
  return buckets.get(taxonomyId)?.size ?? 0;
}

/**
 * Native-dimension rating ranges of one node's independently confirmed problems.
 *
 * Dimensions are the ones actually observed on those problems (sorted by their case-insensitive
 * key, original spelling preserved), and a problem contributes at most once per dimension: a
 * repeated dimension entry is decided by its first value, exactly as `numericRating` defines it.
 * A problem with no metadata row carries no rating and is counted as `missing`.
 */
function independentRatingRanges(
  problemByKey: ReadonlyMap<string, NormalizedProblem>,
  independentKeys: ReadonlySet<string>,
): readonly KnowledgeRatingRange[] {
  const keys = sortedKeys(independentKeys);
  const dimensions = new Map<string, string>();
  for (const key of keys) {
    const problem = problemByKey.get(key);
    if (problem === undefined) {
      continue;
    }
    for (const rating of problem.ratings) {
      const label = rating.dimension.trim();
      const alias = label.toLowerCase();
      if (alias.length === 0 || dimensions.has(alias)) {
        continue;
      }
      dimensions.set(alias, label);
    }
  }
  return [...dimensions.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([alias, label]) => {
      const values: number[] = [];
      for (const key of keys) {
        const problem = problemByKey.get(key);
        if (problem === undefined) {
          continue;
        }
        const value = numericRating(problem, alias);
        if (value !== null) {
          values.push(value);
        }
      }
      return {
        dimension: label,
        count: values.length,
        missing: keys.length - values.length,
        min: values.length === 0 ? null : Math.min(...values),
        max: values.length === 0 ? null : Math.max(...values),
      };
    });
}

/** Technique status from its three disjoint retrospective sets and the configured threshold. */
function techniqueStatus(
  observedRelatedDistinct: number,
  independent: number,
  assisted: number,
  solutionUsed: number,
  minimumIndependentProblems: number,
): KnowledgeNodeStatus {
  if (observedRelatedDistinct === 0) {
    return 'not_observed';
  }
  if (independent + assisted + solutionUsed === 0) {
    return 'unconfirmed';
  }
  if (independent === 0) {
    return 'needs_practice';
  }
  return independent >= minimumIndependentProblems ? 'independent_evidence' : 'practicing';
}

/**
 * Reduce the collected evidence of ONE account to per-taxonomy-node learning evidence.
 *
 * Pure and total: it reads no clock, store or model, never throws for missing evidence (an absent
 * problem row simply contributes no tags or ratings), and returns every node of the taxonomy so a
 * caller can render "not observed" instead of an empty screen.
 */
export function computeKnowledgeEvidence(input: ComputeKnowledgeEvidenceInput): KnowledgeEvidenceReport {
  const index = input.taxonomy;
  invariant(
    index !== null &&
      typeof index === 'object' &&
      typeof index.has === 'function' &&
      typeof index.ancestors === 'function',
    'invalid_input',
    'knowledge evidence needs a taxonomy index',
    {},
  );
  invariant(
    typeof input.accountId === 'string' && input.accountId.trim().length > 0,
    'invalid_input',
    'knowledge evidence needs a selected account id',
    { accountId: input.accountId },
  );
  const accountId = input.accountId.trim();
  const minimumIndependentProblems = requireFiniteInt(
    input.minimumIndependentProblems ?? DEFAULT_MINIMUM_INDEPENDENT_PROBLEMS,
    'minimumIndependentProblems',
    1,
  );

  // One account reduction decides "attempted" and "solved"; rows of every other account are
  // ignored rather than merged, so the report can never describe a different solver.
  const tally = reduceSubmissionsByAccount(input.submissions).get(accountId);
  const attempted = tally?.attemptedProblems ?? EMPTY;
  const solved = tally?.solvedProblems ?? EMPTY;
  const problemByKey = new Map<string, NormalizedProblem>();
  for (const problem of input.problems) {
    if (attempted.has(problem.key)) {
      problemByKey.set(problem.key, problem);
    }
  }

  const platformAttempted = new Map<string, Set<string>>();
  const platformSolved = new Map<string, Set<string>>();
  const verifiedAttempted = new Map<string, Set<string>>();
  const verifiedSolved = new Map<string, Set<string>>();
  const retrospectiveBuckets: Record<CompletionMode, Map<string, Set<string>>> = {
    independent: new Map(),
    assisted: new Map(),
    solution_used: new Map(),
  };
  const relatedKeys = new Set<string>();
  const unmatchedLabels = new Set<string>();
  let unmatchedAlgorithmProblems = 0;
  let verifiedProblems = 0;
  let retrospectiveProblems = 0;

  // Channel 1 — raw platform tags, resolved through the same alias index the rest of the product
  // uses. They stay provisional: a platform label is not an accepted tag.
  for (const key of sortedKeys(attempted)) {
    const problem = problemByKey.get(key);
    if (problem === undefined) {
      continue;
    }
    const direct = new Set<string>();
    let unmatched = false;
    for (const tag of problem.rawTags) {
      const classification = classifyRawTag(index, tag.raw);
      if (classification.kind === 'taxonomy') {
        direct.add(classification.taxonomyId);
      } else if (classification.kind === 'unknown') {
        // Unknown labels are reported as a coverage gap; only recognised non-algorithm provenance
        // (source, event, year, difficulty, language, noise) is deliberately not listed.
        unmatchedLabels.add(classification.raw);
        unmatched = true;
      }
    }
    if (unmatched) {
      unmatchedAlgorithmProblems += 1;
    }
    if (direct.size === 0) {
      continue;
    }
    relatedKeys.add(key);
    const isSolved = solved.has(key);
    for (const taxonomyId of direct) {
      addEvidence(index, platformAttempted, taxonomyId, key);
      if (isSolved) {
        addEvidence(index, platformSolved, taxonomyId, key);
      }
    }
  }

  // Channel 2 — effective verified decisions. Only the current decision per (problem, tag) is
  // read (a later manual rejection removes a tag again), and an id the vocabulary does not know is
  // ignored instead of being counted under a fabricated node.
  const effectiveTags = effectiveTagIdsByProblem(input.decisions);
  for (const key of sortedKeys(attempted)) {
    const known = (effectiveTags.get(key) ?? []).filter((taxonomyId) => index.has(taxonomyId));
    if (known.length === 0) {
      continue;
    }
    verifiedProblems += 1;
    relatedKeys.add(key);
    const isSolved = solved.has(key);
    for (const taxonomyId of known) {
      addEvidence(index, verifiedAttempted, taxonomyId, key);
      if (isSolved) {
        addEvidence(index, verifiedSolved, taxonomyId, key);
      }
    }
  }

  // Channel 3 — the latest retrospective per (account, problem). Only a problem this account
  // actually got accepted can carry retrospective evidence, and only the latest record counts.
  const latestRetrospectives = [...latestRetrospectiveByProblem(input.retrospectives).values()]
    .filter((retrospective) => retrospective.accountId === accountId)
    .sort((left, right) => compareText(left.problemKey, right.problemKey));
  for (const retrospective of latestRetrospectives) {
    if (!solved.has(retrospective.problemKey)) {
      continue;
    }
    retrospectiveProblems += 1;
    const known = [...new Set(retrospective.taxonomyIds)].filter((taxonomyId) => index.has(taxonomyId));
    if (known.length === 0) {
      continue;
    }
    relatedKeys.add(retrospective.problemKey);
    for (const taxonomyId of known) {
      addEvidence(index, retrospectiveBuckets[retrospective.mode], taxonomyId, retrospective.problemKey);
    }
  }

  // Category summaries: every technique node reports itself to each of its category ancestors, so
  // an outer category counts a nested category's techniques too.
  const descendantTechniques = new Map<string, number>();
  const descendantTechniquesWithIndependentEvidence = new Map<string, number>();
  for (const node of index.taxonomy.nodes) {
    if (node.kind !== 'technique') {
      continue;
    }
    const hasIndependentEvidence = sizeOf(retrospectiveBuckets.independent, node.id) > 0;
    for (const ancestor of index.ancestors(node.id)) {
      if (ancestor.kind !== 'category') {
        continue;
      }
      descendantTechniques.set(ancestor.id, (descendantTechniques.get(ancestor.id) ?? 0) + 1);
      if (hasIndependentEvidence) {
        descendantTechniquesWithIndependentEvidence.set(
          ancestor.id,
          (descendantTechniquesWithIndependentEvidence.get(ancestor.id) ?? 0) + 1,
        );
      }
    }
  }

  const nodes = index.taxonomy.nodes.map((node): KnowledgeNodeEvidence => {
    const platformAttemptedForNode = platformAttempted.get(node.id) ?? EMPTY;
    const verifiedAttemptedForNode = verifiedAttempted.get(node.id) ?? EMPTY;
    const independent = retrospectiveBuckets.independent.get(node.id) ?? EMPTY;
    const assisted = retrospectiveBuckets.assisted.get(node.id) ?? EMPTY;
    const solutionUsed = retrospectiveBuckets.solution_used.get(node.id) ?? EMPTY;
    const related = new Set<string>([
      ...platformAttemptedForNode,
      ...verifiedAttemptedForNode,
      ...independent,
      ...assisted,
      ...solutionUsed,
    ]);
    return {
      taxonomyId: node.id,
      parentId: node.parentId,
      kind: node.kind,
      platformAttemptedDistinct: platformAttemptedForNode.size,
      platformSolvedDistinct: sizeOf(platformSolved, node.id),
      verifiedAttemptedDistinct: verifiedAttemptedForNode.size,
      verifiedSolvedDistinct: sizeOf(verifiedSolved, node.id),
      retrospectiveIndependentDistinct: independent.size,
      retrospectiveAssistedDistinct: assisted.size,
      retrospectiveSolutionUsedDistinct: solutionUsed.size,
      observedRelatedDistinct: related.size,
      independentRatingRanges: independent.size === 0 ? [] : independentRatingRanges(problemByKey, independent),
      status:
        node.kind === 'category'
          ? 'category_summary'
          : techniqueStatus(
              related.size,
              independent.size,
              assisted.size,
              solutionUsed.size,
              minimumIndependentProblems,
            ),
      descendantTechniqueNodes: node.kind === 'category' ? (descendantTechniques.get(node.id) ?? 0) : 0,
      descendantTechniqueNodesWithIndependentEvidence:
        node.kind === 'category' ? (descendantTechniquesWithIndependentEvidence.get(node.id) ?? 0) : 0,
    };
  });

  return deepFreeze({
    accountId,
    taxonomyVersion: index.taxonomy.version,
    minimumIndependentProblems,
    coverage: {
      attemptedDistinctTotal: attempted.size,
      solvedDistinctTotal: solved.size,
      relatedAttemptedDistinct: relatedKeys.size,
      verifiedAttemptedDistinct: verifiedProblems,
      retrospectiveProblemDistinct: retrospectiveProblems,
      unmatchedAlgorithmProblemDistinct: unmatchedAlgorithmProblems,
    },
    nodes,
    unmatchedAlgorithmLabels: sortedKeys(unmatchedLabels),
    notes: [...KNOWLEDGE_NOTES],
  });
}
