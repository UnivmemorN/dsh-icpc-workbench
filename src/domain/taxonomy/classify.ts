/**
 * Raw-tag classification.
 *
 * Platform tags mix algorithms with provenance noise (source, contest, year, difficulty,
 * language). Algorithm statistics must only see the former. Three outcomes are possible
 * and deliberately distinct:
 *
 * - `taxonomy`     — the tag is a known algorithm/technique; canonical id is returned.
 * - `non_algorithm`— recognised as source/event/year/difficulty/language/noise; the reason
 *                    is recorded and the raw text is still preserved on the problem.
 * - `unknown`      — no mapping exists. It stays unknown: we never fabricate an id.
 */
import { normalizeTagText, type TaxonomyIndex } from './types.js';

export type NonAlgorithmReason = 'source' | 'event' | 'year' | 'difficulty' | 'language' | 'noise';

export interface NonAlgorithmTagRule {
  readonly reason: NonAlgorithmReason;
  readonly patterns: readonly RegExp[];
  readonly description: string;
}

/**
 * Ordered rules for non-algorithm tags. Order matters: a tag matching several rules gets
 * the first reason, and year-specific handling precedes the numeric difficulty rule so
 * `2021` is reported as a year rather than a rating.
 */
export const NON_ALGORITHM_TAG_RULES: readonly NonAlgorithmTagRule[] = [
  {
    reason: 'source',
    description: 'Platform or judge name — provenance, not knowledge.',
    patterns: [
      /^(codeforces|cf|luogu|hydro|atcoder|nowcoder|vjudge|uoj|loj|codechef|topcoder|洛谷|牛客|一本通|hdu|poj)$/iu,
    ],
  },
  {
    reason: 'event',
    description: 'Contest, series, division or round label.',
    patterns: [
      /icpc|ccpc|noip|noi|usaco|省选|国赛|联赛|邀请赛|区域赛|网络赛|多校|总决赛|world finals|ec-?final/iu,
      /div\.?\s*[1-4]/iu,
      /^(abc|arc|agc)\s*\d+/iu,
      /^gym\b/iu,
      /round\s*\d+/iu,
      /^cf\s*#?\s*\d+/iu,
    ],
  },
  {
    reason: 'year',
    description: 'Calendar year or year range.',
    patterns: [/^(19|20)\d{2}(\s*[-–~]\s*(19|20)\d{2})?$/u],
  },
  {
    reason: 'difficulty',
    description: 'Platform rating/difficulty label, kept as a raw rating dimension instead.',
    patterns: [/^\*?\d{1,4}$/u, /^(入门|普及|提高|省选|noi|ctsc)[+-]?$/iu, /^(easy|medium|hard|very hard|beginner|expert)$/iu],
  },
  {
    reason: 'language',
    description: 'Programming language label.',
    patterns: [/^(c|c\+\+|cpp|cxx|java|python|py|pascal|go|rust|kotlin|javascript|typescript)$/iu],
  },
  {
    reason: 'noise',
    description: 'Placeholder or punctuation-only tag with no semantics.',
    patterns: [/^\*special$/iu, /^\*+$/u, /^[^\p{L}\p{N}]+$/u, /^(untagged|other|others|misc|其它|其他|无)$/iu],
  },
];

/** Classification of one raw tag. */
export type TagClassification =
  | {
      readonly kind: 'taxonomy';
      readonly raw: string;
      readonly taxonomyId: string;
      readonly matchedAlias: string;
    }
  | { readonly kind: 'non_algorithm'; readonly raw: string; readonly reason: NonAlgorithmReason }
  | { readonly kind: 'unknown'; readonly raw: string };

function matchNonAlgorithmRule(raw: string): NonAlgorithmReason | null {
  for (const rule of NON_ALGORITHM_TAG_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(raw))) {
      return rule.reason;
    }
  }
  return null;
}

/**
 * Classify one raw platform tag.
 * Taxonomy aliases win over noise rules (a platform may tag `hash` or `flow` directly).
 */
export function classifyRawTag(index: TaxonomyIndex, raw: string): TagClassification {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: 'non_algorithm', raw, reason: 'noise' };
  }
  const resolved = index.resolveAlias(trimmed);
  if (resolved) {
    return { kind: 'taxonomy', raw: trimmed, taxonomyId: resolved.taxonomyId, matchedAlias: resolved.matchedAlias };
  }
  const reason = matchNonAlgorithmRule(trimmed);
  if (reason) {
    return { kind: 'non_algorithm', raw: trimmed, reason };
  }
  return { kind: 'unknown', raw: trimmed };
}

/** Classify a list of raw tags, preserving input order. */
export function classifyRawTags(index: TaxonomyIndex, rawTags: readonly string[]): readonly TagClassification[] {
  return rawTags.map((raw) => classifyRawTag(index, raw));
}

/**
 * Canonical taxonomy ids implied by raw tags (deduplicated, first-seen order).
 * Non-algorithm and unknown tags never contribute.
 */
export function algorithmTagIds(index: TaxonomyIndex, rawTags: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const classification of classifyRawTags(index, rawTags)) {
    if (classification.kind !== 'taxonomy' || seen.has(classification.taxonomyId)) {
      continue;
    }
    seen.add(classification.taxonomyId);
    ids.push(classification.taxonomyId);
  }
  return ids;
}

/** Raw tags that classify as algorithm/technique knowledge. */
export function algorithmRawTags(index: TaxonomyIndex, rawTags: readonly string[]): readonly string[] {
  return classifyRawTags(index, rawTags)
    .filter((classification) => classification.kind === 'taxonomy')
    .map((classification) => classification.raw);
}

/** Raw tags preserved as unknown (used for UI "unmapped tag" review queues). */
export function unknownRawTags(index: TaxonomyIndex, rawTags: readonly string[]): readonly string[] {
  return classifyRawTags(index, rawTags)
    .filter((classification) => classification.kind === 'unknown')
    .map((classification) => classification.raw);
}

/** True when the classification may contribute to algorithm statistics. */
export function isAlgorithmRelevant(classification: TagClassification): boolean {
  return classification.kind === 'taxonomy';
}

/** Normalised comparison key for a raw tag (exposed for dedupe/diagnostics). */
export function tagLookupKey(raw: string): string {
  return normalizeTagText(raw);
}
