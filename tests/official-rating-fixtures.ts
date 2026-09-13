import { validateOfficialRating } from '../src/domain/official-rating.js';
export function officialFixture(accountId: string, fetchedAt = '2026-09-12T08:00:00.000Z') {
  return validateOfficialRating({ accountId, revision: 1, fetchedAt, source: 'codeforces_api', rating: 1642, maxRating: 1830, history: [
    { contestId: 1, contestName: 'Synthetic rated round 1', rank: 12, ratedAt: '2026-01-01T00:00:00.000Z', oldRating: 0, newRating: 1830 },
    { contestId: 2, contestName: 'Synthetic rated round 2', rank: 85, ratedAt: '2026-08-01T00:00:00.000Z', oldRating: 1830, newRating: 1642 },
  ] });
}
