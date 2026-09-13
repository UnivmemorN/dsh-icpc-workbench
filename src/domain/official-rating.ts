/** Official contest ratings, never inferred from practice AC difficulty. */
import { invariant } from './errors.js';
import { assertIsoTimestamp } from './ids.js';
import { deepFreeze } from './immutable.js';

export interface OfficialRatingChange {
  readonly contestId: number;
  readonly contestName: string;
  readonly rank: number;
  readonly ratedAt: string;
  readonly oldRating: number;
  readonly newRating: number;
}
export interface OfficialRatingData {
  readonly accountId: string;
  readonly fetchedAt: string;
  readonly source: 'codeforces_api';
  readonly rating: number | null;
  readonly maxRating: number | null;
  readonly history: readonly OfficialRatingChange[];
}
export interface OfficialRatingSnapshot extends OfficialRatingData { readonly revision: number; }
/** Closed model projection: no account, handle, contest identity or timestamps. */
export interface CompetitionSummary {
  readonly status: 'not_loaded' | 'unrated' | 'rated';
  readonly rating: number | null;
  readonly maxRating: number | null;
  readonly ratedContests: number;
  readonly activity: 'recent' | 'historical' | 'unknown';
  readonly revision: number;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  invariant(typeof value === 'object' && value !== null && !Array.isArray(value), 'invalid_input', 'official rating object required');
  const r = value as Record<string, unknown>;
  invariant(Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k)), 'invalid_input', 'invalid official rating fields');
  return r;
}
function integer(value: unknown, minimum = Number.MIN_SAFE_INTEGER): number {
  invariant(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum, 'invalid_input', 'invalid official rating integer');
  return value;
}
/** Validates and detaches an entire consistent fetch, including signed user ratings. */
export function validateOfficialRating(value: unknown): OfficialRatingSnapshot {
  const r = object(value, ['accountId', 'revision', 'fetchedAt', 'source', 'rating', 'maxRating', 'history']);
  invariant(typeof r['accountId'] === 'string' && r['accountId'].trim().length > 0, 'invalid_input', 'official rating account required');
  invariant(r['source'] === 'codeforces_api', 'invalid_input', 'unsupported rating source');
  const fetchedAt = assertIsoTimestamp('rating fetchedAt', r['fetchedAt'] as string);
  invariant(Array.isArray(r['history']) && r['history'].length <= 10000, 'invalid_input', 'bounded rating history required');
  const seen = new Set<number>();
  const history = r['history'].map((raw: unknown) => {
    const h = object(raw, ['contestId', 'contestName', 'rank', 'ratedAt', 'oldRating', 'newRating']);
    const contestId = integer(h['contestId'], 1);
    invariant(!seen.has(contestId), 'invalid_input', 'duplicate rating contest'); seen.add(contestId);
    invariant(typeof h['contestName'] === 'string' && h['contestName'].trim().length > 0 && h['contestName'].length <= 500, 'invalid_input', 'invalid contest name');
    const ratedAt = assertIsoTimestamp('contest ratedAt', h['ratedAt'] as string);
    invariant(Date.parse(ratedAt) <= Date.parse(fetchedAt), 'invalid_input', 'future rating change');
    return { contestId, contestName: h['contestName'], rank: integer(h['rank'], 1), ratedAt, oldRating: integer(h['oldRating']), newRating: integer(h['newRating']) };
  }).sort((a, b) => Date.parse(a.ratedAt) - Date.parse(b.ratedAt) || a.contestId - b.contestId);
  const rating = r['rating'] === null ? null : integer(r['rating']);
  const maxRating = r['maxRating'] === null ? null : integer(r['maxRating']);
  invariant(history.length === 0 ? rating === null && maxRating === null : rating !== null && maxRating !== null && history.at(-1)?.newRating === rating && Math.max(...history.map(h => h.newRating)) === maxRating, 'invalid_input', 'profile and rating history disagree; refresh again');
  return deepFreeze({ accountId: r['accountId'], revision: integer(r['revision'], 1), fetchedAt, source: 'codeforces_api', rating, maxRating, history });
}
/** Derive freshness without lowering or blending the official number. */
export function competitionSummary(snapshot: OfficialRatingSnapshot | null, now: string): CompetitionSummary {
  if (snapshot === null) return deepFreeze({ status: 'not_loaded', rating: null, maxRating: null, ratedContests: 0, activity: 'unknown', revision: 0 });
  const last = snapshot.history.at(-1);
  return deepFreeze({ status: snapshot.rating === null ? 'unrated' : 'rated', rating: snapshot.rating, maxRating: snapshot.maxRating, ratedContests: snapshot.history.length,
    activity: last ? Date.parse(now) - Date.parse(last.ratedAt) <= 90 * 86400000 ? 'recent' : 'historical' : 'unknown', revision: snapshot.revision });
}
/** Exact legacy-compatible boundary for identifier-free model inputs. */
export function validateCompetitionSummary(value: unknown): CompetitionSummary {
  const r = object(value, ['status', 'rating', 'maxRating', 'ratedContests', 'activity', 'revision']);
  const ratedContests = integer(r['ratedContests'], 0), revision = integer(r['revision'], 0);
  const rating = r['rating'] === null ? null : integer(r['rating']);
  const maxRating = r['maxRating'] === null ? null : integer(r['maxRating']);
  invariant(['not_loaded', 'unrated', 'rated'].includes(r['status'] as string), 'invalid_input', 'invalid competition status');
  invariant(r['status'] === 'rated' ? rating !== null && maxRating !== null && maxRating >= rating && ratedContests > 0 && revision > 0 && ['recent', 'historical'].includes(r['activity'] as string)
    : rating === null && maxRating === null && ratedContests === 0 && r['activity'] === 'unknown' && (r['status'] === 'not_loaded' ? revision === 0 : revision > 0), 'invalid_input', 'inconsistent competition summary');
  return deepFreeze({ status: r['status'] as CompetitionSummary['status'], rating, maxRating, ratedContests, revision, activity: r['activity'] as CompetitionSummary['activity'] });
}
