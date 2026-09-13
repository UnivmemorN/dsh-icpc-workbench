import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeAbilityAssessment, aggregateAbilityForPlanning, createNormalizedProblem, createSubmission, validateTrainingReference, validateOfficialRating, validateCompetitionSummary } from '../../src/domain/index.js';
import { officialFixture } from '../official-rating-fixtures.js';
import { abilityStatValue } from '../../src/ui/ability-view.js';
import { planningAbilitySummary } from '../../src/ui/planning-view.js';
const now = '2026-09-12T08:00:00.000Z', accountId = 'synthetic-alice', sourceInstanceId = 'codeforces:codeforces.com';
const official = officialFixture(accountId, now);
const base = { accountId, sourceInstanceId, platform: 'codeforces' as const, now, problems: [], submissions: [], retrospectives: [] };

test('automatic score uses exact official current rating; practice quantity and peaks cannot change it', () => {
  const problems = Array.from({ length: 101 }, (_, i) => createNormalizedProblem({ ref: { sourceInstanceId, domain: null, externalKey: 'P' + i }, title: 'Synthetic practice', url: 'https://codeforces.com/problemset/problem/1/A', statement: null, fetchedAt: now, ratings: [{ dimension: 'rating', value: i === 100 ? 3500 : 800, raw: '', scale: null }] }));
  const submissions = problems.map((p, i) => createSubmission({ accountId, ref: p.ref, externalId: String(i), verdict: 'accepted', submittedAt: now }));
  for (const data of [{ problems: [], submissions: [] }, { problems, submissions }]) {
    const report = computeAbilityAssessment({ ...base, ...data, officialRating: official });
    assert.equal(report.trainingReference.source, 'official_rating');
    assert.deepEqual(report.trainingReference.range, { min: 1642, max: 1642 });
    assert.equal(report.officialRating.maxRating, 1830);
    assert.equal(abilityStatValue(report), '1642（CF 官方 rating）');
    assert.equal(planningAbilitySummary(aggregateAbilityForPlanning(report)).headline, 'CF 官方 rating 1642');
    assert.equal(report.reasonCodes.includes('official_rating_not_loaded'), false);
    const aggregate = aggregateAbilityForPlanning(report);
    assert.equal(aggregate.competition?.ratedContests, 2);
    assert.equal(aggregate.competition?.activity, 'recent');
    assert.equal(JSON.stringify(aggregate).includes(accountId), false);
    assert.equal(JSON.stringify(aggregate).includes('Synthetic rated round'), false);
    assert.equal(JSON.stringify(aggregate).includes('2026-08-01'), false);
    assert.deepEqual(validateCompetitionSummary(aggregate.competition), aggregate.competition);
    assert.deepEqual(validateTrainingReference(aggregate.trainingReference), aggregate.trainingReference);
  }
});

test('self-report remains separate; withdrawal returns to official score and old contests are labelled', () => {
  const calibration = { accountId, revision: 1, recordedAt: now, source: 'self_report' as const, scale: 'codeforces' as const, range: { min: 1800, max: 2100 } };
  const report = computeAbilityAssessment({ ...base, officialRating: official, calibration });
  assert.equal(report.trainingReference.source, 'self_report');
  assert.equal(report.officialRating.rating, 1642);
  const cleared = computeAbilityAssessment({ ...base, officialRating: official, calibration: { ...calibration, revision: 2, range: null }, now: '2027-01-01T00:00:00.000Z' });
  assert.equal(cleared.trainingReference.source, 'official_rating');
  assert.equal(cleared.trainingReference.revision, 2);
  assert.equal(cleared.officialRating.activity, 'historical');
  assert.equal(cleared.officialRating.rating, 1642, 'age is not an invented rating penalty');
});

test('unrated is distinct from unloaded and genuine zero or negative official ratings', () => {
  assert.equal(computeAbilityAssessment(base).officialRating.status, 'not_loaded');
  const unrated = validateOfficialRating({ ...official, rating: null, maxRating: null, history: [] });
  assert.equal(computeAbilityAssessment({ ...base, officialRating: unrated }).officialRating.status, 'unrated');
  for (const rating of [0, -20]) {
    const value = validateOfficialRating({ ...official, rating, maxRating: rating, history: [{ ...official.history[0], newRating: rating }] });
    const report = computeAbilityAssessment({ ...base, officialRating: value });
    assert.equal(report.officialRating.status, 'rated');
    assert.equal(validateTrainingReference(report.trainingReference).range?.min, rating);
  }
});

test('rating boundaries reject inconsistent, foreign, future and identity-bearing projections', () => {
  for (const change of [{ rating: 9999 }, { maxRating: 1642 }, { rating: '1642' }, { history: [...official.history, official.history[0]] }, { source: 'self_report' }, { history: [{ ...official.history[0], ratedAt: '2099-01-01T00:00:00.000Z' }] }]) assert.throws(() => validateOfficialRating({ ...official, ...change }));
  assert.throws(() => computeAbilityAssessment({ ...base, officialRating: { ...official, accountId: 'bob' } }));
  assert.throws(() => computeAbilityAssessment({ ...base, platform: 'luogu', officialRating: official }));
  assert.throws(() => computeAbilityAssessment({ ...base, now: '2026-09-11T00:00:00.000Z', officialRating: official }));
  const aggregate = aggregateAbilityForPlanning(computeAbilityAssessment({ ...base, officialRating: official }));
  assert.throws(() => validateCompetitionSummary({ ...aggregate.competition, handle: 'private' }));
  assert.throws(() => validateCompetitionSummary({ ...aggregate.competition, activity: 'unknown' }));
});
