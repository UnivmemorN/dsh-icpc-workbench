/**
 * Synthetic assessment fixtures (Sprint 18d1).
 *
 * Every record is built through the real domain/application factories over fixed evidence: no
 * platform, store or model is contacted, and the values are chosen so the privacy assertions of the
 * tests have something to look for (a handle, a contest name, a note, a problem link, a statement).
 */
import {
  aggregateAbilityForPlanning,
  contentHashOf,
  captureGuidanceSnapshot,
  competitionSummary,
  computeAbilityAssessment,
  createAssessmentReportRecord,
  createCancellationSource,
  createModelUsage,
  validateOfficialRating,
  virtualPerformancePlanningSummary,
  type AssessmentReportRecord,
  type CompetitionSummary,
  type GuidanceSnapshot,
  type NormalizedProblem,
  type OfficialRatingSnapshot,
  type Retrospective,
  type Submission,
  type VirtualPerformanceLedger,
} from '../src/domain/index.js';
import {
  createAssessmentCapture,
  type AssessmentCapture,
  type AssessmentKnowledgeRow,
  type AssessmentSourceSnapshot,
} from '../src/application/assessment-capture.js';
import {
  ASSESSMENT_PROMPT_VERSION,
  type AssessmentGenerationRequest,
} from '../src/application/assessment-generation.js';
import { reportContextOf, type AssessmentAttempt } from '../src/application/assessment-types.js';

export const AT = '2026-11-01T08:00:00.000Z';
export const LATER = '2026-11-01T09:00:00.000Z';
export const EARLIER = '2026-09-01T08:00:00.000Z';
export const ACCOUNT_ID = 'codeforces:codeforces.com|alice';
export const SOURCE_ID = 'codeforces:codeforces.com';
export const HANDLE = 'alice';
export const PROBLEM_URL = 'https://codeforces.com/problemset/problem/1/A';
export const PROBLEM_STATEMENT = 'Given an array of n integers, support range add and range sum queries online.';
export const RETRO_NOTE = '我看了题解才想到懒标记的不变量。';
export const CONTEST_NAME = 'Codeforces Round 999 (Div. 1)';
export const FIXED_USAGE = createModelUsage({ calls: 1, promptTokens: 120, completionTokens: 40 });
export const ZERO_USAGE = createModelUsage({ calls: 0 });
export const TOKEN = createCancellationSource().token;

/** One exact official rating snapshot of {@link ACCOUNT_ID}; the only objective numeric anchor. */
export function officialRatingSnapshot(rating = 1500): OfficialRatingSnapshot {
  return validateOfficialRating({
    accountId: ACCOUNT_ID,
    revision: 1,
    fetchedAt: AT,
    source: 'codeforces_api',
    rating,
    maxRating: rating + 100,
    history: [
      { contestId: 1, contestName: CONTEST_NAME, rank: 100, ratedAt: EARLIER, oldRating: rating - 100, newRating: rating + 100 },
      { contestId: 2, contestName: CONTEST_NAME, rank: 200, ratedAt: EARLIER, oldRating: rating + 100, newRating: rating },
    ],
  });
}

/** The official competition summary of one capture; `rated` only when a snapshot is supplied. */
export function officialSummary(snapshot: OfficialRatingSnapshot | null): CompetitionSummary {
  return competitionSummary(snapshot, AT);
}

export interface CaptureOptions {
  readonly accountId?: string;
  readonly officialRating?: OfficialRatingSnapshot | null;
  readonly submissions?: readonly Submission[];
  readonly problems?: readonly NormalizedProblem[];
  readonly retrospectives?: readonly Retrospective[];
  readonly knowledge?: readonly AssessmentKnowledgeRow[];
  readonly virtualPerformance?: VirtualPerformanceLedger | null;
  /** Frozen assessment-method capture; defaults to the honest unguided baseline. */
  readonly guidance?: GuidanceSnapshot;
  readonly at?: string;
}

/** One whole, valid capture over the supplied (already domain-validated) evidence. */
export function makeCapture(options: CaptureOptions = {}): AssessmentCapture {
  const accountId = options.accountId ?? ACCOUNT_ID;
  const at = options.at ?? AT;
  const official = options.officialRating === undefined ? null : options.officialRating;
  const ability = aggregateAbilityForPlanning(
    computeAbilityAssessment({
      officialRating: official,
      accountId,
      sourceInstanceId: SOURCE_ID,
      platform: 'codeforces',
      problems: options.problems ?? [],
      submissions: options.submissions ?? [],
      retrospectives: options.retrospectives ?? [],
      now: at,
    }),
  );
  const trainingReference = ability.trainingReference;
  if (trainingReference === undefined) {
    throw new Error('assessment fixture ability aggregate carries no training reference');
  }
  const knowledge = options.knowledge ?? [];
  const snapshot: AssessmentSourceSnapshot = {
    sourceEvidenceHash:contentHashOf({accountId,official,problems:options.problems??[],submissions:options.submissions??[],retrospectives:options.retrospectives??[],virtual:options.virtualPerformance??null}),
    platform: 'codeforces',
    taxonomyVersion: 'v2',
    officialRating: competitionSummary(official, at),
    trainingReference,
    calibration: null,
    ability,
    knowledge,
    knowledgeTotalRows: knowledge.length,
    knowledgeOmittedRows: 0,
    virtualPerformance: virtualPerformancePlanningSummary(options.virtualPerformance ?? null, at),
    guidance: options.guidance ?? captureGuidanceSnapshot('assessment', []),
  };
  return createAssessmentCapture({ capturedAt: at, accountId, sourceInstanceId: SOURCE_ID, snapshot });
}

/** One well-formed model answer; every reference exists for both the anchored and bare fixtures. */
export function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: '官方比赛分为当前水平提供了客观锚点，练习样本支持以模板题巩固、以建模题扩展。',
    estimatedRange: { min: 1400, max: 1600 },
    confidence: 'medium',
    confidenceReasons: ['存在精确的官方比赛 rating 作为锚点', '练习样本覆盖两个难度分带'],
    confidenceEvidenceRefs: ['ev-official-rating', 'ev-practice-all_time'],
    thinking: {
      assessment: '建模与不变量推导证据较少，独立完成的题集中在同一分带。',
      evidenceRefs: ['ev-practice-all_time', 'ev-coverage'],
      uncertainties: ['缺少更早记录的复盘'],
    },
    templates: {
      assessment: '模板与实现证据较充分，可通过难度递增巩固。',
      evidenceRefs: ['ev-knowledge-summary'],
      uncertainties: [],
    },
    priority: 'thinking',
    bottleneckReason: '当前瓶颈在建模与证明，而不是模板实现。',
    readinessCheck: '当独立完成的建模题覆盖两个以上难度分带时重新评估。',
    nextSteps: ['每周安排两道需要写出不变量的题', '复盘时记录独立完成程度'],
    ...overrides,
  };
}

/** One stored report record for a capture (anchored fixtures only). */
export function makeReportRecord(capture: AssessmentCapture, report = makeReport()): AssessmentReportRecord {
  return createAssessmentReportRecord({
    report,
    context: reportContextOf(capture),
    evidenceHash: capture.evidenceHash,
  });
}

/** One valid `prepared` attempt over a capture. */
export function makeAttempt(capture: AssessmentCapture, overrides: Partial<AssessmentAttempt> = {}): AssessmentAttempt {
  return {
    id: 'attempt-1',
    accountId: capture.accountId,
    sourceInstanceId: capture.sourceInstanceId,
    status: 'prepared',
    requestedAt: AT,
    expiresAt: LATER,
    finishedAt: null,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    promptVersion: ASSESSMENT_PROMPT_VERSION,
    settingsRevision: null,
    inputHash: 'a'.repeat(64),
    revision: 1,
    preparation: { preparedAt: AT, capture },
    hostSessionId: null,
    hostCallId: null,
    usage: null,
    report: null,
    error: null,
    ...overrides,
  };
}

/** One valid assessment generation request over a capture's identifier-free payload. */
export function makeRequest(
  capture: AssessmentCapture,
  overrides: Partial<AssessmentGenerationRequest> = {},
): AssessmentGenerationRequest {
  return {
    provider: 'fake-provider',
    model: 'assessment-model',
    maxOutputTokens: 4096,
    requestTimeoutMs: 5_000,
    effort: 'max',
    attemptId: 'attempt-1',
    promptVersion: ASSESSMENT_PROMPT_VERSION,
    token: TOKEN,
    evidence: capture.prompt,
    ...overrides,
  };
}

export { FIXED_USAGE as USAGE, ZERO_USAGE as ZERO };
