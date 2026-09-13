/**
 * Reading rules of the ability view (Sprint 11a).
 *
 * These cases drive the pure helpers of `ability-view.ts` over real domain reports: no DOM, no
 * store, no clock and no network. They pin the externally meaningful guarantees the panel relies on
 * — a band is labelled as a heuristic (never an official rating), a missing estimate prints the
 * sample that missed the gate instead of `0`, every native quantile stays native and named, and the
 * "no conversion" / "official rating not loaded" statements stay explicit.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CF_OFFICIAL_RATING_API_HELP_URL,
  computeAbilityAssessment,
  createNormalizedProblem,
  createRetrospective,
  createSubmission,
  type AbilityAssessment,
  type NormalizedProblem,
  type PlatformRating,
  type Submission,
  type Retrospective,
} from '../../src/domain/index.js';
import {
  ABILITY_BASIS_LABELS,
  ABILITY_CONFIDENCE_LABELS,
  ABILITY_MODE_LABELS,
  ABILITY_NO_CONVERSION_NOTE,
  ABILITY_OFFICIAL_RATING_LINK_TEXT,
  abilityBasisLabel,
  abilityCoverageLines,
  abilityEstimateHeadline,
  abilityExcludedText,
  abilityModeText,
  abilityNativeText,
  abilityPoolText,
  abilitySampleText,
  abilityStatValue,
} from '../../src/ui/ability-view.js';

const NOW = '2026-11-01T08:00:00.000Z';
const RECENT = '2026-10-01T08:00:00.000Z';
const OLD = '2025-06-01T08:00:00.000Z';
const SOURCE = 'codeforces:codeforces.com';
const ALICE = 'account:alice';

function rating(value: number): PlatformRating {
  return { dimension: 'rating', value, scale: null, raw: String(value) };
}

function problem(externalKey: string, ratings: readonly PlatformRating[]): NormalizedProblem {
  return createNormalizedProblem({
    ref: { sourceInstanceId: SOURCE, domain: null, externalKey },
    title: `Problem ${externalKey}`,
    url: `https://codeforces.com/problemset/problem/${externalKey}`,
    statement: null,
    fetchedAt: NOW,
    ratings,
  });
}

function solved(
  problems: readonly NormalizedProblem[],
  options: { readonly at: string; readonly independent?: boolean } = { at: RECENT, independent: true },
): { readonly submissions: readonly Submission[]; readonly retrospectives: readonly Retrospective[] } {
  const submissions = problems.map((entry, index) =>
    createSubmission({
      accountId: ALICE,
      ref: entry.ref,
      externalId: `S${index + 1}`,
      verdict: 'accepted',
      submittedAt: options.at,
    }),
  );
  const retrospectives =
    options.independent === false
      ? []
      : problems.map((entry) =>
          createRetrospective({
            problemRef: entry.ref,
            accountId: ALICE,
            mode: 'independent',
            recordedAt: options.at,
          }),
        );
  return { submissions, retrospectives };
}

function assess(
  problems: readonly NormalizedProblem[],
  options: { readonly noRetrospectives?: boolean; readonly at?: string } = {},
): AbilityAssessment {
  const derived = solved(problems, {
    at: options.at ?? RECENT,
    independent: options.noRetrospectives !== true,
  });
  return computeAbilityAssessment({
    accountId: ALICE,
    sourceInstanceId: SOURCE,
    platform: 'codeforces',
    problems,
    submissions: derived.submissions,
    retrospectives: derived.retrospectives,
    now: NOW,
  });
}

/** Five recent independently confirmed samples with ratings 1200..2000. */
function estimatedReport(): AbilityAssessment {
  return assess([1200, 1400, 1600, 1800, 2000].map((value, index) => problem(`P${index + 1}`, [rating(value)])));
}

/** Five old samples without retrospectives: the historical, stale tier. */
function historicalReport(): AbilityAssessment {
  return assess(
    [1400, 1600, 1800, 2000, 2200].map((value, index) => problem(`H${index + 1}`, [rating(value)])),
    { noRetrospectives: true, at: OLD },
  );
}

/** Two solved problems whose stored metadata carries no usable rating at all. */
function noRatingsReport(): AbilityAssessment {
  return assess([problem('N1', []), problem('N2', [])]);
}

void test('estimate labels state the band, the sample and the heuristic caveat', () => {
  const ability = estimatedReport();
  assert.equal(abilityStatValue(ability), '个人水平待校准');
  assert.match(abilityEstimateHeadline(ability), /练习难度中位数 1600（不是实力评分）/);
  assert.match(abilityEstimateHeadline(ability), /1400 – 1800/);
  assert.equal(abilityPoolText(ability.estimate.baselinePool), '1500 – 1700');
  assert.equal(abilityPoolText(ability.estimate.stretchPool), '1700 – 1900');
  assert.equal(abilityPoolText(null), '未给出', 'a missing range is never printed as 0 – 0');
  assert.equal(abilityBasisLabel(ability.estimate.basis), ABILITY_BASIS_LABELS.recent_independent);
  assert.equal(abilitySampleText(ability), '5 / 5 题（最近 90 天独立完成）');
  assert.match(ABILITY_CONFIDENCE_LABELS.medium, /未经验证/);
  assert.equal(ABILITY_OFFICIAL_RATING_LINK_TEXT.includes('题目 rating'), true);
  assert.match(abilityExcludedText(ability), /没有被排除/);
  assert.match(abilityCoverageLines(ability).join('\n'), /旧题重复 AC 0 题/);
});

void test('missing data prints unknown and named gaps instead of numbers', () => {
  const ability = assess([problem('E1', [rating(1500)])]);
  // One solved problem with metadata: the sample gate is missed, so no band exists.
  const empty = computeAbilityAssessment({
    accountId: ALICE,
    sourceInstanceId: SOURCE,
    platform: 'codeforces',
    problems: [],
    submissions: [],
    retrospectives: [],
    now: NOW,
  });
  assert.equal(abilityStatValue(empty), '个人水平待校准');
  assert.match(abilityEstimateHeadline(empty), /有效样本 0 \/ 5/);
  assert.equal(abilityEstimateHeadline(empty).includes('训练难度参考 0'), false);
  assert.equal(abilityBasisLabel(null), '无可用样本');
  assert.equal(abilityPoolText(null), '未给出');

  const noRating = noRatingsReport();
  assert.equal(noRating.nativeDifficulty[0]?.count, 0);
  assert.match(abilityNativeText(noRating.nativeDifficulty[0]!), /2 道已通过题都没有可用的数值/);
  assert.equal(abilityNativeText(noRating.nativeDifficulty[0]!).includes('中位数 0'), false);

  const noSolved = computeAbilityAssessment({
    accountId: ALICE,
    sourceInstanceId: SOURCE,
    platform: 'codeforces',
    problems: [],
    submissions: [],
    retrospectives: [],
    now: NOW,
  });
  assert.match(abilityNativeText(noSolved.nativeDifficulty[0]!), /还没有已通过题/);

  // A real but below-gate report still names its own sample size.
  assert.equal(ability.estimate.status, 'unknown');
  assert.match(abilityEstimateHeadline(ability), /有效样本 1 \/ 5/);
  const lines = abilityCoverageLines(ability);
  assert.equal(lines[0], '尝试 1 题，通过 1 题。');
  assert.match(lines.join('\n'), /缺少本地题目元数据 0 题/);
});

void test('historical samples are labelled as possibly stale and modes stay explicit', () => {
  const ability = historicalReport();
  assert.equal(ability.estimate.basis, 'historical');
  assert.match(abilitySampleText(ability), /可能过时/);
  assert.match(abilityEstimateHeadline(ability), /练习难度中位数 1800/);
  assert.equal(abilityModeText(ability.completionModes.allTime), '独立完成 0 · 提示辅助 0 · 参考题解 0 · 无复盘（独立状态未知） 5');
  assert.equal(ABILITY_MODE_LABELS.unknown.includes('未知'), true);
  assert.equal(ABILITY_MODE_LABELS.assisted, '提示辅助');
  assert.equal(ABILITY_MODE_LABELS.solution_used, '参考题解');
});

void test('native quantiles stay native and the no-conversion statement stays explicit', () => {
  const ability = estimatedReport();
  const row = ability.nativeDifficulty[0]!;
  assert.match(abilityNativeText(row), /rating：5 题有数值、0 题缺失/);
  assert.match(abilityNativeText(row), /中位数 1600/);
  assert.match(ABILITY_NO_CONVERSION_NOTE, /不做换算/);
  assert.match(ABILITY_NO_CONVERSION_NOTE, /非 Codeforces/);
  assert.equal(ability.officialRating.status, 'not_loaded');
  assert.equal(ability.officialRating.apiHelpUrl, CF_OFFICIAL_RATING_API_HELP_URL);
  assert.match(ability.officialRating.note, /尚未同步官方评分/);
  assert.ok(ability.reasons.some((reason) => reason.includes('不能作为选手实力')));
});

void test('a non-Codeforces report with real native values says native-scale-only, never "insufficient data"', () => {
  const ref = { sourceInstanceId: 'luogu:www.luogu.com.cn', domain: null, externalKey: 'P1001' };
  const entry = createNormalizedProblem({
    ref,
    title: 'A+B Problem',
    url: 'https://www.luogu.com.cn/problem/P1001',
    statement: null,
    fetchedAt: NOW,
    ratings: [{ dimension: 'difficulty', value: 3, scale: null, raw: '3' }],
  });
  const report = computeAbilityAssessment({
    accountId: ALICE,
    sourceInstanceId: ref.sourceInstanceId,
    platform: 'luogu',
    problems: [entry],
    submissions: [
      createSubmission({ accountId: ALICE, ref, externalId: 'L1', verdict: 'accepted', submittedAt: RECENT }),
    ],
    retrospectives: [
      createRetrospective({ problemRef: ref, accountId: ALICE, mode: 'independent', recordedAt: RECENT }),
    ],
    now: NOW,
  });
  assert.equal(report.estimate.status, 'unknown', 'there is no CF band on another platform');
  assert.ok(report.nativeDifficulty.some((row) => row.count > 0), 'the native sample is real');
  assert.equal(abilityStatValue(report), '原生刻度评估（CF 估计不适用）');
  assert.match(abilityEstimateHeadline(report), /原生刻度评估/);
  assert.match(abilityEstimateHeadline(report), /CF 训练难度估计不适用/);
  assert.equal(abilityEstimateHeadline(report).includes('数据不足'), false);

  // A Codeforces report with no eligible sample keeps the honest missing-sample wording.
  const empty = computeAbilityAssessment({
    accountId: ALICE,
    sourceInstanceId: SOURCE,
    platform: 'codeforces',
    problems: [],
    submissions: [],
    retrospectives: [],
    now: NOW,
  });
  assert.equal(abilityStatValue(empty), '个人水平待校准');
  assert.match(abilityEstimateHeadline(empty), /有效样本 0 \/ 5/);
});
