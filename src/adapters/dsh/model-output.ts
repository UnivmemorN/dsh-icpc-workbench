/**
 * Strict model-output contract of the dsh tag gateway (Stage 4a2).
 *
 * Every validator is total over `unknown` and rejects the *whole* call on the first malformed
 * entry: nothing is skipped, repaired or invented. Ids must exist in the exact snapshot the model
 * was shown, excerpts are matched literally against the named solution, and each domain object is
 * built through a public factory with locally derived identity and time — the model never picks
 * problem, snapshot, suggestion or verification ids.
 */
import {
  MIN_EVIDENCE_EXCERPT_CHARS,
  createAiTagSuggestion,
  createReasoningDraft,
  createSuggestionVerification,
  verifyExcerptInSolution,
  type AiTagSuggestion,
  type EditorialSolution,
  type EvidenceRef,
  type ProblemSnapshot,
  type SuggestionVerification,
  type TaxonomyIndex,
  type VerificationVerdict,
} from '../../domain/index.js';
import type { AnalyzeOutcome, ReasonOutcome, VerifyOutcome } from '../../application/ports.js';

/** One analyze call may propose at most this many tags. */
export const MAX_ANALYSIS_SUGGESTIONS = 50;
/** Evidence entries accepted per suggestion, including entries merged across solutions. */
export const MAX_EVIDENCE_PER_SUGGESTION = 8;
/** Solutions a single verification may name as conflicting. */
export const MAX_CONFLICTING_SOLUTIONS = 8;
/** Drafts produced by one reasoning call (the approved reasoning cap). */
export const MAX_REASON_DRAFTS = 10;
/** Taxonomy ids one reasoning draft may carry. */
export const MAX_TAXONOMY_IDS_PER_DRAFT = 8;
/** Plain-text bounds; rationale and note are informational, so they stay short and readable. */
export const MAX_RATIONALE_CHARS = 2_000;
export const MAX_NOTE_CHARS = 500;
export const MAX_EXCERPT_CHARS = 4_000;

const MAX_ID_CHARS = 300;
const VERDICTS: readonly VerificationVerdict[] = ['support', 'conflict', 'insufficient'];

/**
 * Malformed model output.
 *
 * The audited client maps a thrown parser to `invalid_output`, so the message is a diagnostic for
 * local use (tests, direct parsing) and never reaches a caller of the gateway.
 */
export class ModelOutputError extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'ModelOutputError';
    this.reason = reason;
  }
}

function fail(reason: string, detail: string): never {
  throw new ModelOutputError(reason, detail);
}

/** Everything the analyze validator needs to check ids and derive identity locally. */
export interface AnalyzeOutputContext {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: TaxonomyIndex;
  /** Injected clock; every `createdAt` comes from here. */
  readonly now: () => string;
}

/** Everything the verification validator needs, including the suggestions it must cover. */
export interface VerifyOutputContext {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: TaxonomyIndex;
  readonly suggestions: readonly AiTagSuggestion[];
  /** Injected clock; every `checkedAt` comes from here. */
  readonly now: () => string;
  /**
   * Prompt identity the answer was produced under.
   *
   * New dispatches use the completeness-aware prompt and therefore **must** answer
   * `missingSuggestions`. Only an explicitly recorded legacy identity may omit it, which keeps
   * recorded old fixtures replayable without ever letting a new run silently pass the old
   * schema off as an omissions answer.
   */
  readonly promptVersion?: string;
}

/** Prompt identity prefix of the verification role that predates the omissions question. */
export const LEGACY_VERIFICATION_PROMPT_PREFIX = 'verification-v1';

/** True when the recorded prompt identity is the legacy one without the omissions question. */
export function isLegacyVerificationPrompt(promptVersion: string | undefined): boolean {
  return typeof promptVersion === 'string' && promptVersion.startsWith(LEGACY_VERIFICATION_PROMPT_PREFIX);
}

/** Everything the reasoning validator needs; no editorial material exists by contract. */
export interface ReasonOutputContext {
  readonly snapshot: ProblemSnapshot;
  readonly taxonomy: TaxonomyIndex;
  /** Injected clock; every draft `createdAt` comes from here. */
  readonly now: () => string;
}

/** A solution the model was actually shown: it exists and its source reported `found`. */
export function shownSolution(
  snapshot: ProblemSnapshot,
  sourceId: string,
  solutionId: string,
): EditorialSolution | null {
  const source = snapshot.sources.find((entry) => entry.id === sourceId);
  if (!source || source.availability !== 'found') {
    return null;
  }
  return snapshot.solutions.find((entry) => entry.solutionId === solutionId && entry.sourceId === sourceId) ?? null;
}

function isShownSolutionId(snapshot: ProblemSnapshot, solutionId: string): boolean {
  return snapshot.solutions.some(
    (solution) =>
      solution.solutionId === solutionId &&
      snapshot.sources.some((source) => source.id === solution.sourceId && source.availability === 'found'),
  );
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('not_an_object', `${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Exact-key check: an unexpected key is malformed output, never an ignored extra. */
function requireKeys(
  record: Record<string, unknown>,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail('unknown_key', `${where} has unknown key ${JSON.stringify(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail('missing_key', `${where} is missing key ${JSON.stringify(key)}`);
    }
  }
}

function requireString(record: Record<string, unknown>, key: string, where: string, maxChars: number): string {
  const value = record[key];
  if (typeof value !== 'string') {
    fail('invalid_type', `${where}.${key} must be a string`);
  }
  if (value.length > maxChars) {
    fail('too_long', `${where}.${key} is ${value.length} characters, above ${maxChars}`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail('invalid_text', `${where}.${key} contains control characters`);
  }
  return value;
}

/** Required non-empty plain text (a trimmed copy is returned). */
function requireText(record: Record<string, unknown>, key: string, where: string, maxChars: number): string {
  const value = requireString(record, key, where, maxChars).trim();
  if (value.length === 0) {
    fail('empty_text', `${where}.${key} must not be empty`);
  }
  return value;
}

/** Optional informational string; a missing or null note stays null. */
function optionalNote(record: Record<string, unknown>, where: string): string | null {
  const value = record.note;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail('invalid_type', `${where}.note must be a string or null`);
  }
  return requireString(record, 'note', where, MAX_NOTE_CHARS);
}

function requireArray(record: Record<string, unknown>, key: string, where: string, maxItems: number): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    fail('invalid_type', `${where}.${key} must be an array`);
  }
  if (value.length > maxItems) {
    fail('too_many', `${where}.${key} has ${value.length} entries, above ${maxItems}`);
  }
  return value;
}

/**
 * One evidence entry: the named source must be a `found` source of this snapshot and the excerpt
 * must occur literally (>= 12 chars) in the named solution of that source.
 */
function parseEvidence(where: string, raw: unknown, context: AnalyzeOutputContext): EvidenceRef {
  const entry = asRecord(raw, where);
  requireKeys(entry, where, ['sourceId', 'solutionId', 'excerpt'], ['note']);
  const sourceId = requireText(entry, 'sourceId', where, MAX_ID_CHARS);
  const solutionId = requireText(entry, 'solutionId', where, MAX_ID_CHARS);
  const solution = shownSolution(context.snapshot, sourceId, solutionId);
  if (!solution) {
    fail('foreign_evidence', `${where} does not name a solution of a found source of snapshot ${context.snapshot.snapshotId}`);
  }
  const excerpt = requireString(entry, 'excerpt', where, MAX_EXCERPT_CHARS);
  const check = verifyExcerptInSolution(solution, excerpt, MIN_EVIDENCE_EXCERPT_CHARS);
  if (!check.ok) {
    fail(
      'unverifiable_excerpt',
      `${where}.excerpt is not a literal ${MIN_EVIDENCE_EXCERPT_CHARS}+ character quote of solution ${solutionId} (${check.reason ?? 'unknown'})`,
    );
  }
  return { sourceId, solutionId, excerpt, note: optionalNote(entry, where) };
}

/** Evidence list of one analyze entry; a suggestion without a citation is not accepted. */
function parseEvidenceList(where: string, entry: Record<string, unknown>, context: AnalyzeOutputContext): EvidenceRef[] {
  const items = requireArray(entry, 'evidence', where, MAX_EVIDENCE_PER_SUGGESTION);
  if (items.length === 0) {
    fail('missing_evidence', `${where}.evidence must cite at least one solution excerpt`);
  }
  const refs: EvidenceRef[] = [];
  const pairs = new Set<string>();
  for (const [index, item] of items.entries()) {
    const ref = parseEvidence(`${where}.evidence[${index}]`, item, context);
    const pair = `${ref.sourceId}\u0000${ref.solutionId}`;
    if (pairs.has(pair)) {
      fail('duplicate_evidence', `${where}.evidence cites ${ref.sourceId}/${ref.solutionId} twice`);
    }
    pairs.add(pair);
    refs.push(ref);
  }
  return refs;
}

interface MergedAnalyzeEntry {
  readonly taxonomyId: string;
  /** Distinct rationales in encounter order; the suggestion stores them newline-separated. */
  readonly rationales: string[];
  readonly evidence: EvidenceRef[];
}

/**
 * Parse one analyze answer.
 *
 * The same taxonomy id may appear again only with evidence from *distinct* solutions; those entries
 * describe alternative valid methods, so their evidence is combined into one suggestion and every
 * distinct rationale is preserved in encounter order, joined with newlines. The joined text must
 * stay within {@link MAX_RATIONALE_CHARS}. Repeating a tag with an already-cited solution (or with
 * no citation) is a duplicate semantic entry and fails the call instead of being dropped.
 */
export function parseAnalyzeOutput(value: unknown, context: AnalyzeOutputContext): AnalyzeOutcome {
  const root = asRecord(value, 'analyze output');
  requireKeys(root, 'analyze output', ['suggestions']);
  const entries = requireArray(root, 'suggestions', 'analyze output', MAX_ANALYSIS_SUGGESTIONS);
  const merged = new Map<string, MergedAnalyzeEntry>();
  for (const [index, raw] of entries.entries()) {
    const where = `suggestions[${index}]`;
    const entry = asRecord(raw, where);
    requireKeys(entry, where, ['taxonomyId', 'rationale', 'evidence']);
    const taxonomyId = requireText(entry, 'taxonomyId', where, MAX_ID_CHARS);
    if (!context.taxonomy.has(taxonomyId)) {
      fail('unknown_taxonomy_id', `${where}.taxonomyId is not in taxonomy ${context.taxonomy.taxonomy.version}`);
    }
    const rationale = requireText(entry, 'rationale', where, MAX_RATIONALE_CHARS);
    const evidence = parseEvidenceList(where, entry, context);
    const existing = merged.get(taxonomyId);
    if (!existing) {
      merged.set(taxonomyId, { taxonomyId, rationales: [rationale], evidence });
      continue;
    }
    const shared = evidence.some((ref) =>
      existing.evidence.some((prior) => prior.sourceId === ref.sourceId && prior.solutionId === ref.solutionId),
    );
    if (shared) {
      fail('duplicate_entry', `${where} repeats taxonomyId ${taxonomyId} for a solution already cited`);
    }
    if (existing.evidence.length + evidence.length > MAX_EVIDENCE_PER_SUGGESTION) {
      fail('too_many', `${where} pushes taxonomyId ${taxonomyId} above ${MAX_EVIDENCE_PER_SUGGESTION} evidence entries`);
    }
    if (!existing.rationales.includes(rationale)) {
      existing.rationales.push(rationale);
    }
    if (existing.rationales.join('\n').length > MAX_RATIONALE_CHARS) {
      fail('too_long', `${where} pushes taxonomyId ${taxonomyId} above ${MAX_RATIONALE_CHARS} combined rationale characters`);
    }
    existing.evidence.push(...evidence);
  }
  const suggestions = [...merged.values()].map((entry) =>
    createAiTagSuggestion({
      problemRef: context.snapshot.problem.ref,
      snapshotId: context.snapshot.snapshotId,
      taxonomyId: entry.taxonomyId,
      role: 'analysis',
      rationale: entry.rationales.join('\n'),
      evidence: entry.evidence,
      createdAt: context.now(),
    }),
  );
  return { suggestions };
}

/** Conflicting solution ids: known, shown solutions only, no repeats. */
function parseConflicts(where: string, raw: unknown, context: VerifyOutputContext): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail('invalid_type', `${where}.conflictingSolutionIds must be an array`);
  }
  if (raw.length > MAX_CONFLICTING_SOLUTIONS) {
    fail('too_many', `${where}.conflictingSolutionIds has ${raw.length} entries, above ${MAX_CONFLICTING_SOLUTIONS}`);
  }
  const ids: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      fail('invalid_type', `${where}.conflictingSolutionIds[${index}] must be a non-empty string`);
    }
    const solutionId = item.trim();
    if (!isShownSolutionId(context.snapshot, solutionId)) {
      fail('foreign_solution', `${where}.conflictingSolutionIds[${index}] is not a shown solution of this snapshot`);
    }
    if (ids.includes(solutionId)) {
      fail('duplicate_id', `${where}.conflictingSolutionIds names ${solutionId} twice`);
    }
    ids.push(solutionId);
  }
  return ids;
}

/** A `support` verdict is only credible when the cited excerpts really occur in their solutions. */
function requireLocalEvidence(suggestion: AiTagSuggestion, where: string, context: VerifyOutputContext): void {
  if (suggestion.evidence.length === 0) {
    fail('unsupported_support', `${where} claims support for a suggestion that cites no solution excerpt`);
  }
  for (const ref of suggestion.evidence) {
    const solution = shownSolution(context.snapshot, ref.sourceId, ref.solutionId);
    if (!solution) {
      fail('foreign_evidence', `${where} claims support citing a solution outside this snapshot`);
    }
    const check = verifyExcerptInSolution(solution, ref.excerpt, MIN_EVIDENCE_EXCERPT_CHARS);
    if (!check.ok) {
      fail('unverified_support', `${where} claims support but solution ${ref.solutionId} does not contain the cited excerpt`);
    }
  }
}

/**
 * Parse one verification answer: exactly one verification per suggestion sent, no foreign,
 * missing or duplicated ids, plus the **required** omissions answer of the current prompt.
 *
 * Verifications are returned in the input suggestion order so the resulting analysis identity
 * stays deterministic. An empty suggestion list is legal: `verifications` must then be empty
 * and only `missingSuggestions` may carry content, because the independent pass still had to
 * scan the whole material.
 *
 * `missingSuggestions` uses exactly the analysis evidence/taxonomy rules (known taxonomy id,
 * a literal excerpt of at least {@link MIN_EVIDENCE_EXCERPT_CHARS} characters from a shown
 * solution), refuses malformed entries, refuses a tag the analysis already proposed (that
 * suggestion must be verified instead) and refuses repeats. The entries are returned as
 * `role: 'verification'` suggestions: they were invented by this pass, so they are never
 * self-verified and always require manual review.
 */
export function parseVerificationOutput(value: unknown, context: VerifyOutputContext): VerifyOutcome {
  const root = asRecord(value, 'verification output');
  const legacy = isLegacyVerificationPrompt(context.promptVersion);
  if (legacy) {
    requireKeys(root, 'verification output', ['verifications'], ['missingSuggestions']);
  } else {
    // No silent legacy success under the current prompt: the omissions answer is mandatory.
    requireKeys(root, 'verification output', ['verifications', 'missingSuggestions']);
  }
  const entries = requireArray(root, 'verifications', 'verification output', context.suggestions.length);
  const byId = new Map(context.suggestions.map((suggestion) => [suggestion.suggestionId, suggestion]));
  const verified = new Map<string, SuggestionVerification>();
  for (const [index, raw] of entries.entries()) {
    const where = `verifications[${index}]`;
    const entry = asRecord(raw, where);
    requireKeys(entry, where, ['suggestionId', 'verdict', 'evidenceOk'], ['conflictingSolutionIds', 'note']);
    const suggestionId = requireText(entry, 'suggestionId', where, MAX_ID_CHARS);
    const suggestion = byId.get(suggestionId);
    if (!suggestion) {
      fail('unknown_suggestion', `${where}.suggestionId is not one of the ${context.suggestions.length} suggestions sent`);
    }
    if (verified.has(suggestionId)) {
      fail('duplicate_verification', `${where} verifies ${suggestionId} more than once`);
    }
    const verdict = entry.verdict;
    if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as VerificationVerdict)) {
      fail('unknown_verdict', `${where}.verdict must be one of ${VERDICTS.join('|')}`);
    }
    const evidenceOk = entry.evidenceOk;
    if (typeof evidenceOk !== 'boolean') {
      fail('invalid_type', `${where}.evidenceOk must be a boolean`);
    }
    const conflictingSolutionIds = parseConflicts(where, entry.conflictingSolutionIds, context);
    const note = optionalNote(entry, where);
    if (verdict === 'support') {
      if (!evidenceOk) {
        fail('contradictory_verification', `${where} claims support with evidenceOk false`);
      }
      if (conflictingSolutionIds.length > 0) {
        fail('contradictory_verification', `${where} claims support and names conflicting solutions`);
      }
      requireLocalEvidence(suggestion, where, context);
    }
    if (verdict === 'conflict' && conflictingSolutionIds.length === 0) {
      fail('contradictory_verification', `${where} claims conflict without naming a conflicting solution`);
    }
    const verification = createSuggestionVerification({
      suggestionId,
      problemRef: context.snapshot.problem.ref,
      snapshotId: context.snapshot.snapshotId,
      verdict: verdict as VerificationVerdict,
      verifierRole: 'verification',
      evidenceOk,
      checkedAt: context.now(),
      conflictingSolutionIds,
      note,
    });
    verified.set(suggestionId, verification);
  }
  const ordered: SuggestionVerification[] = [];
  for (const suggestion of context.suggestions) {
    const verification = verified.get(suggestion.suggestionId);
    if (!verification) {
      fail('missing_verification', `verification output has no entry for suggestion ${suggestion.suggestionId}`);
    }
    ordered.push(verification);
  }
  if (legacy && root.missingSuggestions === undefined) {
    // A recorded legacy answer is replayed exactly as it was: no omissions answer exists, so
    // the outcome carries no `missingSuggestions` and can never mark a run complete.
    return { verifications: ordered };
  }
  return { verifications: ordered, missingSuggestions: parseMissingSuggestions(root, context) };
}

/**
 * Parse the verifier's omissions list.
 *
 * Each entry follows the analyze contract (known taxonomy id, rationale, at least one literal
 * excerpt from a shown solution). A tag the analysis already proposed is refused: it must be
 * verified through the ordinary verification entry instead, so the two answers stay
 * distinguishable. Repeats inside the list are refused rather than merged, because an
 * omission repeated with different evidence is ambiguous about which citation is meant.
 */
function parseMissingSuggestions(root: Record<string, unknown>, context: VerifyOutputContext): AiTagSuggestion[] {
  const entries = requireArray(root, 'missingSuggestions', 'verification output', MAX_ANALYSIS_SUGGESTIONS);
  const proposed = new Set(context.suggestions.map((suggestion) => suggestion.taxonomyId));
  const seen = new Set<string>();
  const missing: AiTagSuggestion[] = [];
  for (const [index, raw] of entries.entries()) {
    const where = `missingSuggestions[${index}]`;
    const entry = asRecord(raw, where);
    requireKeys(entry, where, ['taxonomyId', 'rationale', 'evidence']);
    const taxonomyId = requireText(entry, 'taxonomyId', where, MAX_ID_CHARS);
    if (!context.taxonomy.has(taxonomyId)) {
      fail('unknown_taxonomy_id', `${where}.taxonomyId is not in taxonomy ${context.taxonomy.taxonomy.version}`);
    }
    if (proposed.has(taxonomyId)) {
      fail('duplicate_proposal', `${where}.taxonomyId ${taxonomyId} was already proposed by the analysis pass`);
    }
    if (seen.has(taxonomyId)) {
      fail('duplicate_entry', `${where} repeats missing taxonomyId ${taxonomyId}`);
    }
    seen.add(taxonomyId);
    const rationale = requireText(entry, 'rationale', where, MAX_RATIONALE_CHARS);
    const evidence = parseEvidenceList(where, entry, context);
    missing.push(
      createAiTagSuggestion({
        problemRef: context.snapshot.problem.ref,
        snapshotId: context.snapshot.snapshotId,
        taxonomyId,
        // The pass that invented the tag never verifies it: `verification` output without a
        // matching verification record always resolves to "needs manual review".
        role: 'verification',
        rationale,
        evidence,
        createdAt: context.now(),
      }),
    );
  }
  return missing;
}

/**
 * Parse one reasoning answer: drafts over the statement only, at most 10, each with known taxonomy
 * ids and no evidence (the model has no solution to quote). Two drafts for the same tag set are a
 * duplicate entry and fail the call.
 */
export function parseReasoningOutput(value: unknown, context: ReasonOutputContext): ReasonOutcome {
  const root = asRecord(value, 'reasoning output');
  requireKeys(root, 'reasoning output', ['drafts']);
  const entries = requireArray(root, 'drafts', 'reasoning output', MAX_REASON_DRAFTS);
  const seenTags = new Map<string, number>();
  const drafts = entries.map((raw, index) => {
    const where = `drafts[${index}]`;
    const entry = asRecord(raw, where);
    requireKeys(entry, where, ['taxonomyIds', 'rationale']);
    const taxonomyIds = requireArray(entry, 'taxonomyIds', where, MAX_TAXONOMY_IDS_PER_DRAFT);
    if (taxonomyIds.length === 0) {
      fail('missing_taxonomy_ids', `${where}.taxonomyIds must name at least one tag`);
    }
    const ids: string[] = [];
    for (const [position, item] of taxonomyIds.entries()) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        fail('invalid_type', `${where}.taxonomyIds[${position}] must be a non-empty string`);
      }
      const taxonomyId = item.trim();
      if (!context.taxonomy.has(taxonomyId)) {
        fail('unknown_taxonomy_id', `${where}.taxonomyIds[${position}] is not in taxonomy ${context.taxonomy.taxonomy.version}`);
      }
      if (ids.includes(taxonomyId)) {
        fail('duplicate_id', `${where}.taxonomyIds names ${taxonomyId} twice`);
      }
      ids.push(taxonomyId);
    }
    const rationale = requireText(entry, 'rationale', where, MAX_RATIONALE_CHARS);
    const key = [...ids].sort().join('\u0000');
    const prior = seenTags.get(key);
    if (prior !== undefined) {
      fail('duplicate_entry', `${where} repeats the tag set of drafts[${prior}]`);
    }
    seenTags.set(key, index);
    return createReasoningDraft({
      problemRef: context.snapshot.problem.ref,
      snapshotId: context.snapshot.snapshotId,
      taxonomyIds: ids,
      rationale,
      createdAt: context.now(),
    });
  });
  return { drafts };
}
