/**
 * Native difficulty partitions for knowledge evidence. These are display intervals, not
 * calibrated ability levels. Sources, Hydro domains and native dimensions never share a scale.
 */
import type { NormalizedProblem } from './problem.js';
import type { Submission } from './submission.js';

/** Stable, serializable identity of one native difficulty band. Upper bounds are exclusive. */
export interface KnowledgeDifficultyBand {
  readonly id: string;
  readonly sourceInstanceId: string;
  readonly domain: string | null;
  readonly dimension: string;
  readonly kind: 'interval' | 'value' | 'unknown';
  readonly value: number | string | null;
  readonly upperExclusive: number | null;
}

/** A partition's distinct problem membership, used only while reducing local evidence. */
export interface KnowledgeDifficultyPartition {
  readonly band: KnowledgeDifficultyBand;
  readonly problemKeys: ReadonlySet<string>;
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Partition attempted problems of one account. The first entry of a repeated dimension wins.
 * Each problem appears once per native dimension of its source/domain; absent values have an
 * explicit unknown band. CF ratings require positive integers; Luogu 0 means unclassified.
 * Other platforms' textual levels are kept verbatim (trimmed), without invented conversions.
 */
export function knowledgeDifficultyPartitions(
  accountId: string,
  problems: readonly NormalizedProblem[],
  submissions: readonly Submission[],
): readonly KnowledgeDifficultyPartition[] {
  const refs = new Map(submissions.filter(s => s.accountId === accountId).map(s => [s.key, s.ref]));
  const metadata = new Map(problems.filter(p => refs.has(p.key)).map(p => [p.key, p]));
  const scopes = new Map<string, { sourceInstanceId: string; domain: string | null; keys: string[]; dimensions: Set<string> }>();
  for (const [key, ref] of refs) {
    const id = JSON.stringify([ref.sourceInstanceId, ref.domain]);
    let scope = scopes.get(id);
    if (!scope) {
      const dimensions = new Set<string>();
      if (ref.sourceInstanceId.startsWith('codeforces:')) dimensions.add('rating');
      if (ref.sourceInstanceId.startsWith('luogu:')) dimensions.add('difficulty');
      scope = { sourceInstanceId: ref.sourceInstanceId, domain: ref.domain, keys: [], dimensions };
      scopes.set(id, scope);
    }
    scope.keys.push(key);
    for (const rating of metadata.get(key)?.ratings ?? []) {
      const dimension = rating.dimension.trim().toLowerCase();
      if (dimension) scope.dimensions.add(dimension);
    }
  }
  const partitions = new Map<string, { band: KnowledgeDifficultyBand; problemKeys: Set<string> }>();
  for (const scope of scopes.values()) {
    if (scope.dimensions.size === 0) scope.dimensions.add('difficulty');
    for (const key of scope.keys) {
      for (const dimension of scope.dimensions) {
        const raw = metadata.get(key)?.ratings.find(r => r.dimension.trim().toLowerCase() === dimension)?.value;
        const trimmed = typeof raw === 'string' ? raw.trim() : raw;
        let value: number | string | null = trimmed === undefined || trimmed === '' ? null : trimmed;
        if (typeof value === 'string' && Number.isFinite(Number(value))) value = Number(value);
        if (typeof value === 'number' && !Number.isFinite(value)) value = null;
        let kind: KnowledgeDifficultyBand['kind'] = value === null ? 'unknown' : 'value';
        let upperExclusive: number | null = null;
        if (scope.sourceInstanceId.startsWith('codeforces:') && dimension === 'rating') {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
            value = null; kind = 'unknown';
          } else {
            value = Math.floor(value / 200) * 200;
            upperExclusive = value + 200; kind = 'interval';
          }
        }
        if (scope.sourceInstanceId.startsWith('luogu:') && dimension === 'difficulty' &&
            (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 7)) {
          value = null; kind = 'unknown';
        }
        const id = JSON.stringify([scope.sourceInstanceId, scope.domain, dimension, kind, value, upperExclusive]);
        let partition = partitions.get(id);
        if (!partition) {
          partition = { band: { id, sourceInstanceId: scope.sourceInstanceId, domain: scope.domain, dimension, kind, value, upperExclusive }, problemKeys: new Set() };
          partitions.set(id, partition);
        }
        partition.problemKeys.add(key);
      }
    }
  }
  return [...partitions.values()].sort((a, b) => {
    const x = a.band, y = b.band;
    return compareText(x.sourceInstanceId, y.sourceInstanceId) || compareText(x.domain ?? '', y.domain ?? '') ||
      compareText(x.dimension, y.dimension) || Number(x.kind === 'unknown') - Number(y.kind === 'unknown') ||
      (typeof x.value === 'number' && typeof y.value === 'number' ? x.value - y.value : compareText(String(x.value), String(y.value)));
  });
}
