/**
 * Account ability assessment.
 *
 * Since ability.3, trainingReference is the sole player-level reference: self-report, official contest rating or
 * uncalibrated. The legacy estimate below is retained for API readers as descriptive practice
 * data only; its median-derived pools are withheld from new planning inputs.
 *
 * This module answers exactly one bounded question: "which Codeforces **training** difficulty band
 * does the imported solving history support?" It is deliberately not an official-rating estimate:
 * official rating is supplied separately by the application, no provider is called, no clock is read (the caller passes `now`), and the result
 * is a transparent local heuristic that carries its version, its sample and its caveats.
 *
 * The counting rules are the conservative ones the rest of the product already uses:
 *
 * - the unit is the **distinct problem** per account; repeated submissions never inflate a count;
 * - a problem is *solved* when this account has an accepted submission, and it counts as a **new
 *   solve** only while its **first** AC falls inside the recent window — a later AC of an old solve
 *   is reported separately as `repeatedAcDistinct` and never refreshes it;
 * - submissions with a timestamp after the explicit `now` are excluded, never clamped;
 * - submissions of another account are ignored (account isolation) and counted in the coverage; a
 *   submission that claims the selected account for a different source instance is refused, because
 *   one account cannot span source instances;
 * - a completion mode comes exclusively from the **latest** retrospective of that (account,
 *   problem); a missing retrospective is the explicit `unknown` mode, never "independent";
 * - known `assisted` / `solution_used` problems are excluded from the estimate and counted
 *   separately;
 * - native difficulty is reported per raw dimension and never converted between platforms; a value
 *   that is absent, blank or non-numeric is missing, never a fabricated `0`.
 *
 * The additive history comparison always assesses all-time, recent and earlier solves in parallel,
 * independent of the near-term tier choice. Every valid non-assisted solve in that period is used,
 * and missing independence remains explicit. It never blends a historic score into a current Elo.
 *
 * The estimate itself exists for Codeforces only and needs at least
 * {@link ABILITY_MIN_ESTIMATE_SAMPLES} valid distinct rated solved problems. A value is valid
 * estimate evidence only when it is a positive finite safe integer: `0`, negative and fractional
 * entries stay visible in the raw descriptive distribution but never satisfy the sample gate.
 * Sample priority is recent independently confirmed, then recent observed AC (unknown independence,
 * provisional and low confidence), then historical samples with an explicit stale caveat. The
 * supported sample's median rounded to the nearest 100 is the baseline; `quartileBand` is the
 * sample's own P25–P75 range, a descriptive spread of these solves rather than a calibrated
 * uncertainty or confidence interval; and a baseline pool and a stretch pool are derived around the
 * baseline. Suggested pool bounds are raised to {@link CF_TRAINING_POOL_FLOOR}, the explicitly
 * chosen training-recommendation floor — observed medians, baselines and quartiles below it are
 * never rewritten — and no upper bound is invented, because the official CF problem rating has no
 * documented maximum. An insufficient sample yields `unknown` — never `0` and never "newbie".
 */
import { validateOfficialRating, competitionSummary, type CompetitionSummary, type OfficialRatingSnapshot, type OfficialRatingChange } from './official-rating.js';
import { validateAbilityCalibration, type AbilityCalibration, type AbilityTrainingReference } from './ability-calibration.js';
import { invariant, requireFiniteInt } from './errors.js';
import { assertIsoTimestamp, type SourcePlatform } from './ids.js';
import { deepFreeze } from './immutable.js';
import type { NormalizedProblem, PlatformRating } from './problem.js';
import type { CompletionMode, Retrospective } from './retrospective.js';
import { numericText } from './sorting.js';
import { isAccepted, type Submission } from './submission.js';
import { expectedRatingDimension } from './training-stats.js';

const DAY_MS = 86_400_000;

/** Version of the assessment shape and its counting rules; bump when an exported meaning changes. */
export const ABILITY_ASSESSMENT_VERSION = 'ability.4';

/** Version of the Codeforces training-band heuristic alone; the numbers below belong to it. */
export const CF_TRAINING_BAND_HEURISTIC_VERSION = 'cf-rating-band.1';

/** Default recent window in days: `first AC` inside it makes a solve "new". */
export const ABILITY_RECENT_WINDOW_DAYS = 90;

/** Minimum valid distinct rated solved problems before a training band is offered at all. */
export const ABILITY_MIN_ESTIMATE_SAMPLES = 5;

/** Codeforces problem-rating dimension (never the user rating). */
export const CF_RATING_DIMENSION = 'rating';

/**
 * Explicitly chosen floor of a **suggested** training pool — never a claim about an official
 * Codeforces rating range. The official problem `rating` is an integer difficulty with no
 * documented upper bound, so this constant only raises `baselinePool` / `stretchPool` bounds:
 * observed medians, baselines and quartiles below it are reported unchanged.
 */
export const CF_TRAINING_POOL_FLOOR = 800;

/** Official help page that explains user rating vs. problem rating. */
export const CF_OFFICIAL_RATING_API_HELP_URL = 'https://codeforces.com/apiHelp/objects#User';

/** Default explanation until an official rating snapshot has been synchronized. */
export const ABILITY_OFFICIAL_RATING_NOTE =
  '尚未同步官方评分；可在能力评估中同步 CF 评分与比赛历史。';

/** Stable, ordered vocabulary of the evidence caveats one assessment can carry. */
export const ABILITY_EVIDENCE_REASONS = [
  'heuristic_unvalidated',
  'selection_bias_practice_vs_contest',
  'incomplete_imports',
  'unknown_independent_status',
  'stale_data',
  'assisted_excluded',
  'missing_rating_values',
  'insufficient_samples',
  'no_data',
  'non_cf_native_scale_only',
  'official_rating_not_loaded',
] as const;

export type AbilityEvidenceReasonCode = (typeof ABILITY_EVIDENCE_REASONS)[number];

/**
 * Chinese display text of every caveat.
 *
 * The UI renders these strings verbatim, so the explanation a user reads is the same text the
 * domain attached to the number — a view cannot quietly soften "未经验证的启发式" into a claim.
 */
export const ABILITY_REASON_TEXT: Readonly<Record<AbilityEvidenceReasonCode, string>> = {
  heuristic_unvalidated:
    '练习难度中位数与 P25–P75 只描述选过的题，不能作为选手实力或能力区间。个人水平使用有来源的自评或官方比赛分；两者都没有时保持未知，不把基础题的数量当成低水平证据。',
  selection_bias_practice_vs_contest:
    '样本来自平时练习而不是正式比赛：练习环境、题面提示与时间压力都和比赛不同，练习表现可能高估或低估比赛表现。',
  incomplete_imports: '导入不完整：有尝试题缺少本地元数据或难度数值，可用样本可能不完整。',
  unknown_independent_status:
    '部分样本没有复盘记录，无法确认是否独立完成；这些样本只能给出低置信度的临时估计，不代表已掌握。',
  stale_data: '样本主要来自最近窗口之外的历史记录，当前水平可能已经变化，请结合最近的练习记录判断。',
  assisted_excluded: '已知为“提示辅助”或“参考题解”的题目已从难度估计中排除，只单独计数，不参与训练难度带。',
  missing_rating_values: '有已通过题目缺少可用的原生难度数值，无法进入估计样本。',
  insufficient_samples: '有效样本不足 5 道，暂不给出难度带；数据不足时返回“未知”，而不是零基础。',
  no_data: '该账号还没有可用的提交记录，无法评估能力。',
  non_cf_native_scale_only:
    '该平台不是 Codeforces：只展示它自己的原生难度分位数与分布，不换算成 CF rating，也不给出 CF 训练难度带。',
  official_rating_not_loaded:
    '尚未同步官方账号 rating；用户 rating 与题目 rating 是两件事，练习统计不能替代比赛评分。',
};

/** Explicit settings; both bounds are validated integers. */
export interface AbilityAssessmentSettings {
  /** Minimum valid distinct rated solved problems before an estimate is offered. */
  readonly minimumEstimateSamples: number;
  /** Recent window in days; a first AC inside it counts as a new solve. */
  readonly recentWindowDays: number;
}

export const DEFAULT_ABILITY_SETTINGS: AbilityAssessmentSettings = {
  minimumEstimateSamples: ABILITY_MIN_ESTIMATE_SAMPLES,
  recentWindowDays: ABILITY_RECENT_WINDOW_DAYS,
};

/** `estimated` only when the sample gate is met; otherwise the honest `unknown`. */
export type AbilityEstimateStatus = 'estimated' | 'unknown';

/**
 * Which sample tier produced the estimate.
 *
 * `recent_independent` (recent, latest retrospective says independent) is the strongest evidence
 * available here; `recent_observed` is a recent AC whose independence is unknown; `historical`
 * means the sample lives outside the recent window and carries an explicit staleness caveat.
 */
export type AbilityEstimateBasis = 'recent_independent' | 'recent_observed' | 'historical';

/** Confidence is never `high`: the heuristic itself is unvalidated. */
export type AbilityConfidence = 'low' | 'medium';

/** Completion mode of one solved problem; `unknown` means "no retrospective was recorded". */
export type AbilityCompletionMode = CompletionMode | 'unknown';

/** One inclusive numeric rating range. */
export interface AbilityRatingRange {
  readonly min: number;
  readonly max: number;
}

/** Distinct-problem totals of the whole (non-future) history. */
export interface AbilityCounts {
  readonly attemptedDistinct: number;
  readonly solvedDistinct: number;
  readonly unsolvedDistinct: number;
}

/**
 * Recent-window counts.
 *
 * `newSolvedDistinct` counts problems whose **first** AC falls inside the window, so an old solve
 * that was accepted again inside it never counts as new; those refreshed problems are reported
 * separately as `repeatedAcDistinct`.
 */
export interface AbilityWindowCounts {
  readonly attemptedDistinct: number;
  readonly newSolvedDistinct: number;
  readonly repeatedAcDistinct: number;
}

/** Distinct solved problems per latest completion mode. */
export interface AbilityCompletionModeCounts {
  readonly independent: number;
  readonly assisted: number;
  readonly solutionUsed: number;
  readonly unknown: number;
  /** Always the number of solved problems the counts describe. */
  readonly total: number;
}

/** Completion modes for the whole history and for the recent window. */
export interface AbilityCompletionModes {
  readonly allTime: AbilityCompletionModeCounts;
  readonly last90Days: AbilityCompletionModeCounts;
}

/** One numeric value of one raw dimension and how many distinct solved problems carry it. */
export interface AbilityBucket {
  readonly value: number;
  readonly count: number;
}

/**
 * Descriptive quantiles of one raw platform dimension over the distinct solved problems.
 *
 * `count` is the numeric sample, `missing` the solved problems without a usable value (missing
 * metadata included), so `count + missing` is always the distinct solved total. Quantiles are
 * `null` only when `count` is `0`.
 */
export interface AbilityNativeDistribution {
  /** Original platform dimension label (`rating`, `difficulty`, …), never a merged scale. */
  readonly dimension: string;
  readonly count: number;
  readonly missing: number;
  readonly min: number | null;
  readonly p25: number | null;
  readonly median: number | null;
  readonly p75: number | null;
  readonly max: number | null;
  /** Every observed value with its distinct-problem count, ascending. */
  readonly buckets: readonly AbilityBucket[];
  /** True from `minimumEstimateSamples` numeric samples; descriptive only. */
  readonly sufficientSamples: boolean;
}

/**
 * The versioned Codeforces training-band estimate.
 *
 * `baselineTrainingLevel` is the supported sample median rounded to 100 and is reported as observed,
 * never floored and never capped. `quartileBand` is the sample's own P25–P75 range rounded outward
 * to 100 — a descriptive spread of these solves, not a calibrated uncertainty or confidence
 * interval. `baselinePool`/`stretchPool` are the suggested practice ranges around the baseline;
 * their bounds are raised to the explicitly chosen {@link CF_TRAINING_POOL_FLOOR}
 * training-recommendation floor and are never capped, because the official problem rating has no
 * documented upper bound. All of them are `null` while `status` is `unknown`.
 */
export interface AbilityTrainingEstimate {
  readonly status: AbilityEstimateStatus;
  readonly heuristicVersion: string;
  readonly basis: AbilityEstimateBasis | null;
  /** Samples actually used (estimated) or the eligible count that missed the gate (unknown). */
  readonly sampleSize: number;
  readonly minimumSampleSize: number;
  /** Raw sample median before rounding; `null` while unknown. */
  readonly medianRating: number | null;
  readonly baselineTrainingLevel: number | null;
  readonly quartileBand: AbilityRatingRange | null;
  readonly baselinePool: AbilityRatingRange | null;
  readonly stretchPool: AbilityRatingRange | null;
  readonly confidence: AbilityConfidence | null;
  /** True while unknown independence or stale history is part of the sample; never mastery. */
  readonly provisional: boolean;
  /** True only for the historical tier. */
  readonly stale: boolean;
  readonly reasonCodes: readonly AbilityEvidenceReasonCode[];
  readonly reasons: readonly string[];
}

/** Official contest evidence loaded by the explicit sync operation; practice statistics stay separate. */
export interface AbilityOfficialRatingStatus extends CompetitionSummary {
  readonly fetchedAt: string | null;
  readonly history: readonly OfficialRatingChange[];
  readonly apiHelpUrl: string;
  readonly note: string;
}

/** Problems excluded from the estimate because their latest retrospective names a non-independent mode. */
export interface AbilityExcludedSamples {
  readonly assistedDistinct: number;
  readonly solutionUsedDistinct: number;
  readonly total: number;
}

/**
 * Explicit bounds and gaps of one assessment.
 *
 * `metadataMissing` counts attempted problems without a local metadata row; `solvedWithoutNativeValue`
 * counts solved problems without a usable value in the source's own expected dimension. Both are
 * reported instead of silently shrinking the sample.
 */
export interface AbilityCoverage {
  readonly submissionRows: number;
  readonly futureSubmissionsExcluded: number;
  /** Rows of another account, ignored so they can never describe this account. */
  readonly foreignSubmissionsExcluded: number;
  readonly futureRetrospectivesExcluded: number;
  readonly distinctAttempted: number;
  readonly distinctSolved: number;
  readonly metadataMissing: number;
  readonly metadataMissingKeys: readonly string[];
  readonly solvedWithNativeValue: number;
  readonly solvedWithoutNativeValue: number;
  readonly solvedWithoutRetrospective: number;
  readonly recentWindowDays: number;
  readonly recentAttemptedDistinct: number;
  readonly recentEligibleDistinct: number;
  readonly recentIndependentDistinct: number;
  readonly allTimeEligibleDistinct: number;
  /** Native dimension the source is expected to report (`rating` on CF, `difficulty` elsewhere). */
  readonly nativeDimension: string;
}

/** Parallel periods defined by a problem's FIRST known AC, never by its latest re-submission. */
export type AbilityHistoryPeriod = 'all_time' | 'recent' | 'earlier';

/** Identifier-free assessment of one period. All eligible solves participate; no recency fallback. */
export interface AbilityPeriodAssessment {
  readonly period: AbilityHistoryPeriod;
  readonly solvedDistinct: number;
  /** Known assisted/solution-used excluded first; remaining missing/invalid values excluded next. */
  readonly excludedDistinct: number;
  readonly missingOrInvalidRatingDistinct: number;
  readonly eligibleDistinct: number;
  readonly independentEligibleDistinct: number;
  readonly completionModes: AbilityCompletionModeCounts;
  readonly minimumSampleSize: number;
  readonly estimateStatus: AbilityEstimateStatus;
  /** Null below the gate or on non-CF platforms. */
  readonly baselineTrainingLevel: number | null;
  readonly quartileBand: AbilityRatingRange | null;
  /** True only when every eligible problem has an independent retrospective. */
  readonly independentlyConfirmed: boolean;
  readonly confidence: AbilityConfidence | null;
  /** Historical achievements are visible without claiming they prove current form. */
  readonly includesEarlierSolves: boolean;
  readonly nativeDifficulty: readonly {
    readonly dimension: string;
    readonly count: number;
    readonly missing: number;
    readonly median: number | null;
    readonly p25: number | null;
    readonly p75: number | null;
  }[];
}

/** Stable aggregates only: no account/row identifiers, notes, or clock-dependent timestamps. */
export interface AbilityHistoryComparison {
  readonly recentWindowDays: number;
  readonly periods: readonly AbilityPeriodAssessment[];
}

/** One account's complete ability assessment. */
export interface AbilityAssessment {
  readonly calibration: AbilityCalibration | null;
  /** Player-level reference is never derived from a practice median. */
  readonly trainingReference: AbilityTrainingReference;
  readonly version: string;
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly platform: SourcePlatform;
  readonly computedAt: string;
  readonly counts: AbilityCounts;
  readonly last90Days: AbilityWindowCounts;
  readonly completionModes: AbilityCompletionModes;
  readonly nativeDifficulty: readonly AbilityNativeDistribution[];
  /** @deprecated Legacy practice summary; median and pools are not player ability. Use trainingReference. */
  readonly estimate: AbilityTrainingEstimate;
  /** Always evaluates all-time, recent and earlier solves independently. */
  readonly history: AbilityHistoryComparison;
  readonly officialRating: AbilityOfficialRatingStatus;
  readonly excludedFromEstimate: AbilityExcludedSamples;
  readonly coverage: AbilityCoverage;
  readonly reasonCodes: readonly AbilityEvidenceReasonCode[];
  /** Chinese caveat texts, in {@link ABILITY_EVIDENCE_REASONS} order. */
  readonly reasons: readonly string[];
}

export interface ComputeAbilityAssessmentInput {
  readonly officialRating?: OfficialRatingSnapshot | null;
  readonly calibration?: AbilityCalibration | null;
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly platform: SourcePlatform;
  /** Local metadata rows; a problem without one is still counted as attempted/solved. */
  readonly problems: readonly NormalizedProblem[];
  /** Submission rows of one weakness read; rows of other accounts are isolated and counted. */
  readonly submissions: readonly Submission[];
  readonly retrospectives: readonly Retrospective[];
  /** Explicit observation instant; this function never reads a real clock. */
  readonly now: string;
  readonly settings?: Partial<AbilityAssessmentSettings>;
}

/**
 * Identifier-free aggregate of one assessment for future planning/model summaries.
 *
 * It carries only aggregate quantities, the estimate and its caveats: no account id, no handle, no
 * source instance id, no problem key, no submission id and no retrospective note. Because the shape
 * is closed, a later caller cannot accidentally forward raw rows to a model.
 */
export interface AbilityPlanningAggregate {
  /** Absent only in legacy immutable preparations. */
  readonly competition?: CompetitionSummary;
  /** Absent only in legacy immutable preparations; never synthesize it when reading those. */
  readonly trainingReference?: AbilityTrainingReference;
  /** Absent in legacy immutable preparations; present in newly prepared plans. */
  readonly history?: AbilityHistoryComparison;
  readonly version: string;
  readonly platform: SourcePlatform;
  readonly estimateStatus: AbilityEstimateStatus;
  readonly estimateBasis: AbilityEstimateBasis | null;
  readonly heuristicVersion: string;
  readonly confidence: AbilityConfidence | null;
  readonly sampleSize: number;
  readonly minimumSampleSize: number;
  readonly baselineTrainingLevel: number | null;
  readonly quartileBand: AbilityRatingRange | null;
  readonly baselinePool: AbilityRatingRange | null;
  readonly stretchPool: AbilityRatingRange | null;
  readonly counts: AbilityCounts;
  readonly last90Days: AbilityWindowCounts;
  readonly completionModesAllTime: AbilityCompletionModeCounts;
  readonly completionModesLast90Days: AbilityCompletionModeCounts;
  readonly excludedFromEstimate: AbilityExcludedSamples;
  readonly nativeDifficulty: readonly {
    readonly dimension: string;
    readonly count: number;
    readonly missing: number;
    readonly median: number | null;
  }[];
  readonly coverage: {
    readonly metadataMissing: number;
    readonly solvedWithoutNativeValue: number;
    readonly futureSubmissionsExcluded: number;
  };
  readonly reasonCodes: readonly AbilityEvidenceReasonCode[];
  readonly caveats: readonly string[];
}

/** One solved problem with its resolve facts, as the estimate tiers use them. */
interface SolvedRecord {
  readonly key: string;
  readonly firstAcceptedAt: string;
  readonly firstAcceptedMs: number;
  readonly recent: boolean;
  readonly mode: AbilityCompletionMode;
  readonly problem: NormalizedProblem | null;
}


/** Compute one period from the same resolved, account-isolated records as the near-term estimate. */
function assessPeriod(
  period: AbilityHistoryPeriod,
  records: readonly SolvedRecord[],
  platform: SourcePlatform,
  expectedDimension: string,
  minimumSampleSize: number,
): AbilityPeriodAssessment {
  const completionModes = modeCountsOf(records);
  const excludedDistinct = completionModes.assisted + completionModes.solutionUsed;
  const eligible = records.filter(record => {
    if (record.mode === 'assisted' || record.mode === 'solution_used' || record.problem === null) return false;
    const value = numericDimensionValue(record.problem, expectedDimension);
    if (value === null) return false;
    if (platform === 'codeforces') return Number.isSafeInteger(value) && value > 0;
    if (platform === 'luogu') return Number.isInteger(value) && value >= 1 && value <= 7;
    return true;
  });
  const values = eligible.map(r => numericDimensionValue(r.problem as NormalizedProblem, expectedDimension) as number).sort((a, b) => a - b);
  const estimated = platform === 'codeforces' && values.length >= minimumSampleSize;
  const independentEligibleDistinct = eligible.filter(r => r.mode === 'independent').length;
  const independentlyConfirmed = eligible.length > 0 && independentEligibleDistinct === eligible.length;
  const includesEarlierSolves = records.some(r => !r.recent);
  const nativeDifficulty = nativeDimensionLabels(records, expectedDimension).map(({ key, label }) => {
    const ratings = records.flatMap(r => {
      const value = r.problem === null ? null : numericDimensionValue(r.problem, key);
      return value === null ? [] : [value];
    }).sort((a, b) => a - b);
    return { dimension: label, count: ratings.length, missing: records.length - ratings.length,
      median: quantileOf(ratings, 0.5), p25: quantileOf(ratings, 0.25), p75: quantileOf(ratings, 0.75) };
  });
  return {
    period, solvedDistinct: records.length, excludedDistinct,
    missingOrInvalidRatingDistinct: records.length - excludedDistinct - eligible.length,
    eligibleDistinct: eligible.length, independentEligibleDistinct, completionModes, minimumSampleSize,
    estimateStatus: estimated ? 'estimated' : 'unknown',
    baselineTrainingLevel: estimated ? roundTo100(quantileOf(values, 0.5) as number) : null,
    quartileBand: estimated ? { min: floorTo100(quantileOf(values, 0.25) as number), max: ceilTo100(quantileOf(values, 0.75) as number) } : null,
    independentlyConfirmed,
    confidence: estimated ? independentlyConfirmed && !includesEarlierSolves ? 'medium' : 'low' : null,
    includesEarlierSolves,
    nativeDifficulty,
  };
}

/** One eligible estimate sample: a rated solved problem that is neither assisted nor solution-used. */
interface EstimateSample {
  readonly rating: number;
  readonly mode: AbilityCompletionMode;
  readonly recent: boolean;
}

/** Strict numeric value of one raw rating entry; `null` for blank/text/non-finite values. */
function numericRatingValue(value: PlatformRating['value']): number | null {
  return typeof value === 'number' ? (Number.isFinite(value) ? value : null) : numericText(value);
}

/** First numeric value of one dimension (case-insensitive), or `null` when it has none. */
function numericDimensionValue(problem: NormalizedProblem, dimension: string): number | null {
  const wanted = dimension.trim().toLowerCase();
  for (const rating of problem.ratings) {
    if (rating.dimension.trim().toLowerCase() !== wanted) {
      continue;
    }
    return numericRatingValue(rating.value);
  }
  return null;
}

/** Linear-interpolation quantile over an ascending value list; `null` for an empty sample. */
function quantileOf(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const single = sorted[0] as number;
  if (sorted.length === 1) {
    return single;
  }
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] as number;
  const upper = sorted[upperIndex] as number;
  return lowerIndex === upperIndex ? lower : lower + (upper - lower) * (position - lowerIndex);
}

function roundTo100(value: number): number {
  return Math.round(value / 100) * 100;
}

function floorTo100(value: number): number {
  return Math.floor(value / 100) * 100;
}

function ceilTo100(value: number): number {
  return Math.ceil(value / 100) * 100;
}

/**
 * Raise one **suggested** pool bound to the chosen training floor. This is the only place the floor
 * is applied: it never touches observed values (median, baseline, quartile band) and it never caps
 * a rating, because the official problem rating has no documented upper bound.
 */
function applyTrainingFloor(value: number): number {
  return Math.max(CF_TRAINING_POOL_FLOOR, value);
}

/** Suggested pool range with the training floor applied and `min <= max` preserved. */
function poolRangeOf(min: number, max: number): AbilityRatingRange {
  const lower = applyTrainingFloor(min);
  return { min: lower, max: Math.max(lower, applyTrainingFloor(max)) };
}

function requireId(name: string, value: string): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `ability assessment needs a non-empty ${name}`,
    { name, value },
  );
  return value.trim();
}

const REASON_ORDER: ReadonlyMap<AbilityEvidenceReasonCode, number> = new Map(
  ABILITY_EVIDENCE_REASONS.map((code, index) => [code, index]),
);

/** Deduplicate and order caveat codes by the stable vocabulary order. */
function orderedReasons(codes: Iterable<AbilityEvidenceReasonCode>): readonly AbilityEvidenceReasonCode[] {
  return [...new Set(codes)].sort(
    (left, right) => (REASON_ORDER.get(left) ?? 0) - (REASON_ORDER.get(right) ?? 0),
  );
}

function reasonTexts(codes: readonly AbilityEvidenceReasonCode[]): readonly string[] {
  return codes.map((code) => ABILITY_REASON_TEXT[code]);
}

function emptyModeCounts(): {
  independent: number;
  assisted: number;
  solutionUsed: number;
  unknown: number;
} {
  return { independent: 0, assisted: 0, solutionUsed: 0, unknown: 0 };
}

/** Count the latest completion mode of every record; `total` is the record count. */
function modeCountsOf(records: readonly SolvedRecord[]): AbilityCompletionModeCounts {
  const counts = emptyModeCounts();
  for (const record of records) {
    if (record.mode === 'independent') {
      counts.independent += 1;
    } else if (record.mode === 'assisted') {
      counts.assisted += 1;
    } else if (record.mode === 'solution_used') {
      counts.solutionUsed += 1;
    } else {
      counts.unknown += 1;
    }
  }
  return { ...counts, total: records.length };
}

/**
 * Raw native dimension labels in output order: the source's expected dimension first, then every
 * other dimension the solved problems report, deduplicated case-insensitively and sorted by
 * code-point order (never `localeCompare`, so the order is machine-independent).
 */
function nativeDimensionLabels(
  records: readonly SolvedRecord[],
  expectedDimension: string,
): readonly { readonly key: string; readonly label: string }[] {
  const expectedKey = expectedDimension.trim().toLowerCase();
  const labels = new Map<string, string>();
  for (const record of [...records].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))) {
    for (const rating of record.problem?.ratings ?? []) {
      const label = rating.dimension.trim();
      const key = label.toLowerCase();
      if (key.length === 0 || key === expectedKey || labels.has(key)) {
        continue;
      }
      labels.set(key, label);
    }
  }
  return [
    { key: expectedKey, label: expectedDimension },
    ...[...labels.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, label]) => ({ key, label })),
  ];
}

/**
 * Compute the bounded ability assessment of ONE account over ONE source instance.
 *
 * Pure, deterministic and idempotent: the same evidence and the same `now` always produce the same
 * frozen report, and nothing here reads a store, a clock, a platform or a model.
 */
export function computeAbilityAssessment(input: ComputeAbilityAssessmentInput): AbilityAssessment {
  invariant(
    input !== null && typeof input === 'object',
    'invalid_input',
    'computeAbilityAssessment needs an input object',
    {},
  );
  const accountId = requireId('accountId', input.accountId);
  const sourceInstanceId = requireId('sourceInstanceId', input.sourceInstanceId);
  const now = assertIsoTimestamp('now', input.now);
  const nowMs = Date.parse(now);
  const minimumSampleSize = requireFiniteInt(
    input.settings?.minimumEstimateSamples ?? DEFAULT_ABILITY_SETTINGS.minimumEstimateSamples,
    'minimumEstimateSamples',
    1,
  );
  const recentWindowDays = requireFiniteInt(
    input.settings?.recentWindowDays ?? DEFAULT_ABILITY_SETTINGS.recentWindowDays,
    'recentWindowDays',
    1,
  );
  const windowStartMs = nowMs - recentWindowDays * DAY_MS;
  const expectedDimension = expectedRatingDimension(input.platform);
  const expectedKey = expectedDimension.trim().toLowerCase();
  const isCodeforces = input.platform === 'codeforces';

  // ---- submissions: one pass, distinct problems, first AC, future rows excluded -------------
  const problemByKey = new Map(input.problems.map((problem) => [problem.key, problem]));
  const attempted = new Set<string>();
  const solved = new Set<string>();
  const attemptedInWindow = new Set<string>();
  const acceptedInWindow = new Set<string>();
  const firstAcceptedAt = new Map<string, string>();
  let submissionRows = 0;
  let futureSubmissionsExcluded = 0;
  let foreignSubmissionsExcluded = 0;

  for (const submission of input.submissions) {
    if (submission.accountId !== accountId) {
      // Another account's history can never describe this account; it is counted, not counted in.
      foreignSubmissionsExcluded += 1;
      continue;
    }
    invariant(
      submission.ref.sourceInstanceId === sourceInstanceId,
      'invalid_input',
      `submission ${submission.id} belongs to ${submission.ref.sourceInstanceId}, not to account ${accountId} of ${sourceInstanceId}`,
      {
        reason: 'ability_source_mismatch',
        submissionId: submission.id,
        accountId,
        accountSource: sourceInstanceId,
        rowSource: submission.ref.sourceInstanceId,
      },
    );
    submissionRows += 1;
    const submittedMs = Date.parse(submission.submittedAt);
    if (submittedMs > nowMs) {
      // A timestamp after the explicit observation instant is not evidence yet.
      futureSubmissionsExcluded += 1;
      continue;
    }
    attempted.add(submission.key);
    if (submittedMs >= windowStartMs) {
      attemptedInWindow.add(submission.key);
    }
    if (!isAccepted(submission)) {
      continue;
    }
    solved.add(submission.key);
    const currentFirst = firstAcceptedAt.get(submission.key);
    if (currentFirst === undefined || submittedMs < Date.parse(currentFirst)) {
      firstAcceptedAt.set(submission.key, submission.submittedAt);
    }
    if (submittedMs >= windowStartMs) {
      acceptedInWindow.add(submission.key);
    }
  }

  // ---- latest retrospective per (account, problem): the only source of a completion mode -----
  const latestModeAt = new Map<string, number>();
  const latestMode = new Map<string, CompletionMode>();
  let futureRetrospectivesExcluded = 0;
  for (const retrospective of input.retrospectives) {
    if (retrospective.accountId !== accountId) {
      continue;
    }
    const recordedMs = Date.parse(retrospective.recordedAt);
    if (recordedMs > nowMs) {
      futureRetrospectivesExcluded += 1;
      continue;
    }
    const previous = latestModeAt.get(retrospective.problemKey);
    if (previous === undefined || recordedMs >= previous) {
      latestModeAt.set(retrospective.problemKey, recordedMs);
      latestMode.set(retrospective.problemKey, retrospective.mode);
    }
  }

  const solvedKeys = [...solved].sort();
  const solvedRecords: SolvedRecord[] = solvedKeys.map((key) => {
    const first = firstAcceptedAt.get(key) as string;
    const firstMs = Date.parse(first);
    return {
      key,
      firstAcceptedAt: first,
      firstAcceptedMs: firstMs,
      recent: firstMs >= windowStartMs,
      mode: latestMode.get(key) ?? 'unknown',
      problem: problemByKey.get(key) ?? null,
    };
  });

  // ---- native difficulty: per raw dimension, quantities plus an honest missing count ---------
  const labels = nativeDimensionLabels(solvedRecords, expectedDimension);
  const accumulators = new Map<string, { label: string; counts: Map<number, number>; known: number }>(
    labels.map(({ key, label }) => [key, { label, counts: new Map<number, number>(), known: 0 }]),
  );
  let metadataMissingSolved = 0;
  let solvedWithNativeValue = 0;
  for (const record of solvedRecords) {
    if (record.problem === null) {
      metadataMissingSolved += 1;
      continue;
    }
    const seen = new Set<string>();
    let hasNativeValue = false;
    for (const rating of record.problem.ratings) {
      const key = rating.dimension.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) {
        continue;
      }
      const accumulator = accumulators.get(key);
      if (accumulator === undefined) {
        continue;
      }
      seen.add(key);
      const value = numericRatingValue(rating.value);
      if (value === null) {
        continue;
      }
      accumulator.counts.set(value, (accumulator.counts.get(value) ?? 0) + 1);
      accumulator.known += 1;
      if (key === expectedKey) {
        hasNativeValue = true;
      }
    }
    if (hasNativeValue) {
      solvedWithNativeValue += 1;
    }
  }

  const nativeDifficulty: AbilityNativeDistribution[] = [...accumulators.values()].map((accumulator) => {
    const values = [...accumulator.counts.keys()].sort((left, right) => left - right);
    const expanded: number[] = [];
    for (const value of values) {
      const count = accumulator.counts.get(value) as number;
      for (let index = 0; index < count; index += 1) {
        expanded.push(value);
      }
    }
    return {
      dimension: accumulator.label,
      count: accumulator.known,
      // A solved problem contributes at most one value or one missing entry to this dimension.
      missing: solved.size - accumulator.known,
      min: expanded.length === 0 ? null : (expanded[0] as number),
      p25: quantileOf(expanded, 0.25),
      median: quantileOf(expanded, 0.5),
      p75: quantileOf(expanded, 0.75),
      max: expanded.length === 0 ? null : (expanded[expanded.length - 1] as number),
      buckets: values.map((value) => ({ value, count: accumulator.counts.get(value) as number })),
      sufficientSamples: accumulator.known >= minimumSampleSize,
    };
  });

  // ---- estimate tiers: recent independent, then recent observed, then historical -------------
  const eligible: EstimateSample[] = [];
  let assistedDistinct = 0;
  let solutionUsedDistinct = 0;
  for (const record of solvedRecords) {
    if (record.mode === 'assisted') {
      assistedDistinct += 1;
      continue;
    }
    if (record.mode === 'solution_used') {
      solutionUsedDistinct += 1;
      continue;
    }
    if (!isCodeforces || record.problem === null) {
      continue;
    }
    const rating = numericDimensionValue(record.problem, CF_RATING_DIMENSION);
    // Estimate evidence must be a positive finite safe integer. Raw `0`, negative and fractional
    // values stay in the descriptive distribution but can never satisfy the sample gate.
    if (rating === null || !Number.isSafeInteger(rating) || rating <= 0) {
      continue;
    }
    eligible.push({ rating, mode: record.mode, recent: record.recent });
  }

  const recentIndependent = eligible.filter((sample) => sample.recent && sample.mode === 'independent');
  const recentEligible = eligible.filter((sample) => sample.recent);
  let basis: AbilityEstimateBasis | null = null;
  let pool: readonly EstimateSample[] = [];
  if (recentIndependent.length >= minimumSampleSize) {
    basis = 'recent_independent';
    pool = recentIndependent;
  } else if (recentEligible.length >= minimumSampleSize) {
    basis = 'recent_observed';
    pool = recentEligible;
  } else if (eligible.length >= minimumSampleSize) {
    basis = 'historical';
    pool = eligible;
  }

  const excludedFromEstimate: AbilityExcludedSamples = {
    assistedDistinct,
    solutionUsedDistinct,
    total: assistedDistinct + solutionUsedDistinct,
  };

  const coverage: AbilityCoverage = {
    submissionRows,
    futureSubmissionsExcluded,
    foreignSubmissionsExcluded,
    futureRetrospectivesExcluded,
    distinctAttempted: attempted.size,
    distinctSolved: solved.size,
    metadataMissing: attempted.size - [...attempted].filter((key) => problemByKey.has(key)).length,
    metadataMissingKeys: [...attempted].filter((key) => !problemByKey.has(key)).sort(),
    solvedWithNativeValue,
    solvedWithoutNativeValue: solved.size - solvedWithNativeValue,
    solvedWithoutRetrospective: solvedRecords.filter((record) => record.mode === 'unknown').length,
    recentWindowDays,
    recentAttemptedDistinct: attemptedInWindow.size,
    recentEligibleDistinct: recentEligible.length,
    recentIndependentDistinct: recentIndependent.length,
    allTimeEligibleDistinct: eligible.length,
    nativeDimension: expectedDimension,
  };

  const reportReasons = new Set<AbilityEvidenceReasonCode>();
  let estimate: AbilityTrainingEstimate;
  if (basis === null) {
    // Insufficient data is `unknown`, never a fabricated zero or a "newbie" band.
    if (submissionRows === 0) {
      reportReasons.add('no_data');
    } else {
      reportReasons.add('insufficient_samples');
    }
    if (!isCodeforces) {
      reportReasons.add('non_cf_native_scale_only');
    }
    if (solved.size > 0 && solvedWithNativeValue < solved.size) {
      reportReasons.add('missing_rating_values');
    }
    if (coverage.metadataMissing > 0) {
      reportReasons.add('incomplete_imports');
    }
    if (excludedFromEstimate.total > 0) {
      reportReasons.add('assisted_excluded');
    }
    reportReasons.add('official_rating_not_loaded');
    const codes = orderedReasons(reportReasons);
    estimate = {
      status: 'unknown',
      heuristicVersion: CF_TRAINING_BAND_HEURISTIC_VERSION,
      basis: null,
      sampleSize: eligible.length,
      minimumSampleSize,
      medianRating: null,
      baselineTrainingLevel: null,
      quartileBand: null,
      baselinePool: null,
      stretchPool: null,
      confidence: null,
      provisional: false,
      stale: false,
      reasonCodes: codes,
      reasons: reasonTexts(codes),
    };
  } else {
    const ratings = pool.map((sample) => sample.rating).sort((left, right) => left - right);
    const median = quantileOf(ratings, 0.5) as number;
    const p25 = quantileOf(ratings, 0.25) as number;
    const p75 = quantileOf(ratings, 0.75) as number;
    const baseline = roundTo100(median);
    const provisional = basis !== 'recent_independent';
    reportReasons.add('heuristic_unvalidated');
    reportReasons.add('selection_bias_practice_vs_contest');
    if (!isCodeforces) {
      reportReasons.add('non_cf_native_scale_only');
    }
    if (pool.some((sample) => sample.mode === 'unknown')) {
      reportReasons.add('unknown_independent_status');
    }
    if (basis === 'historical') {
      reportReasons.add('stale_data');
    }
    if (coverage.metadataMissing > 0 || coverage.solvedWithoutNativeValue > 0) {
      reportReasons.add('incomplete_imports');
    }
    if (coverage.solvedWithoutNativeValue > 0) {
      reportReasons.add('missing_rating_values');
    }
    if (excludedFromEstimate.total > 0) {
      reportReasons.add('assisted_excluded');
    }
    reportReasons.add('official_rating_not_loaded');
    const codes = orderedReasons(reportReasons);
    estimate = {
      status: 'estimated',
      heuristicVersion: CF_TRAINING_BAND_HEURISTIC_VERSION,
      basis,
      sampleSize: pool.length,
      minimumSampleSize,
      medianRating: median,
      baselineTrainingLevel: baseline,
      // Descriptive sample P25–P75, not a calibrated uncertainty or confidence interval.
      quartileBand: { min: floorTo100(p25), max: ceilTo100(p75) },
      baselinePool: poolRangeOf(baseline - 100, baseline + 100),
      stretchPool: poolRangeOf(baseline + 100, baseline + 300),
      confidence: basis === 'recent_independent' ? 'medium' : 'low',
      provisional,
      stale: basis === 'historical',
      reasonCodes: codes,
      reasons: reasonTexts(codes),
    };
  }

  const allTimeModes = modeCountsOf(solvedRecords);
  const windowModes = modeCountsOf(solvedRecords.filter((record) => record.recent));
  const repeatedAcDistinct = [...acceptedInWindow].filter(
    (key) => (firstAcceptedAt.get(key) as string | undefined) !== undefined && Date.parse(firstAcceptedAt.get(key) as string) < windowStartMs,
  ).length;
  const official = input.officialRating == null ? null : validateOfficialRating(input.officialRating);
  invariant(official === null || official.accountId === accountId && input.platform === 'codeforces', 'invalid_input', 'official rating belongs to another account or platform');
  invariant(official === null || Date.parse(official.fetchedAt) <= Date.parse(now), 'invalid_input', 'official rating snapshot is from the future');
  const competition = competitionSummary(official, now);
  if (official !== null) reportReasons.delete('official_rating_not_loaded');
  const codes = orderedReasons(reportReasons);

  const calibration = input.calibration == null ? null : validateAbilityCalibration(input.calibration);
  invariant(calibration === null || calibration.accountId === accountId, 'invalid_input', 'calibration belongs to another account');
  invariant(calibration === null || input.platform === 'codeforces', 'invalid_input', 'CF self-assessment belongs to a Codeforces account');
  const trainingReference: AbilityTrainingReference = {
    source: calibration?.range ? 'self_report' : official?.rating != null ? 'official_rating' : 'uncalibrated',
    scale: 'codeforces', range: calibration?.range ?? (official?.rating == null ? null : { min: official.rating, max: official.rating }), revision: calibration?.revision ?? 0,
  };
  return deepFreeze({
    calibration, trainingReference,
    version: ABILITY_ASSESSMENT_VERSION,
    accountId,
    sourceInstanceId,
    platform: input.platform,
    computedAt: now,
    counts: {
      attemptedDistinct: attempted.size,
      solvedDistinct: solved.size,
      unsolvedDistinct: attempted.size - solved.size,
    },
    last90Days: {
      attemptedDistinct: attemptedInWindow.size,
      newSolvedDistinct: solvedRecords.filter((record) => record.recent).length,
      repeatedAcDistinct,
    },
    completionModes: { allTime: allTimeModes, last90Days: windowModes },
    history: {
      recentWindowDays,
      periods: [
        assessPeriod('all_time', solvedRecords, input.platform, expectedDimension, minimumSampleSize),
        assessPeriod('recent', solvedRecords.filter(r => r.recent), input.platform, expectedDimension, minimumSampleSize),
        assessPeriod('earlier', solvedRecords.filter(r => !r.recent), input.platform, expectedDimension, minimumSampleSize),
      ],
    },
    nativeDifficulty,
    estimate,
    officialRating: {
      ...competition, fetchedAt: official?.fetchedAt ?? null, history: official?.history ?? [],
      apiHelpUrl: CF_OFFICIAL_RATING_API_HELP_URL,
      note: official === null ? ABILITY_OFFICIAL_RATING_NOTE : competition.status === 'unrated' ? '官方账号没有 rated 比赛记录，不以零分代替未评级。' : competition.activity === 'historical' ? '官方当前 rating 来自 90 天以前的比赛，可能不能反映近期状态；历史最高分也不等于当前实力。' : '自动分直接采用官方当前 rating；它描述比赛表现，历史最高分与练习难度分布分别展示。',
    },
    excludedFromEstimate,
    coverage,
    reasonCodes: codes,
    reasons: reasonTexts(codes),
  });
}

/**
 * Reduce one assessment to the identifier-free aggregate a future plan/model summary may carry.
 *
 * Only aggregate quantities, the estimate and its caveats survive: account ids, handles, source
 * instance ids, problem keys, submission ids, retrospective notes and per-row rows are not part of
 * the returned shape at all, so they cannot be forwarded by accident.
 */
export function aggregateAbilityForPlanning(report: AbilityAssessment): AbilityPlanningAggregate {
  const estimate = report.estimate;
  return deepFreeze({
    version: report.version,
    history: report.history,
    platform: report.platform,
    trainingReference: report.trainingReference,
    competition: competitionSummary(report.officialRating.status === 'not_loaded' ? null : { accountId: report.accountId, source: 'codeforces_api', revision: report.officialRating.revision, fetchedAt: report.officialRating.fetchedAt!, rating: report.officialRating.rating, maxRating: report.officialRating.maxRating, history: report.officialRating.history }, report.computedAt),
    estimateStatus: 'unknown',
    estimateBasis: null,
    heuristicVersion: estimate.heuristicVersion,
    confidence: null,
    sampleSize: estimate.sampleSize,
    minimumSampleSize: estimate.minimumSampleSize,
    baselineTrainingLevel: null,
    quartileBand: estimate.quartileBand,
    baselinePool: null,
    stretchPool: null,
    counts: report.counts,
    last90Days: report.last90Days,
    completionModesAllTime: report.completionModes.allTime,
    completionModesLast90Days: report.completionModes.last90Days,
    excludedFromEstimate: report.excludedFromEstimate,
    nativeDifficulty: report.nativeDifficulty.map((dimension) => ({
      dimension: dimension.dimension,
      count: dimension.count,
      missing: dimension.missing,
      median: dimension.median,
    })),
    coverage: {
      metadataMissing: report.coverage.metadataMissing,
      solvedWithoutNativeValue: report.coverage.solvedWithoutNativeValue,
      futureSubmissionsExcluded: report.coverage.futureSubmissionsExcluded,
    },
    reasonCodes: report.reasonCodes,
    caveats: report.reasons,
  });
}
