/**
 * Rule-based training plan generation and model-plan validation.
 *
 * The generator is deterministic and model-free: it schedules **real candidates with real
 * URLs**, prioritising the weakest sufficient tags, and never schedules the same candidate
 * twice. When there is no usable history it says so (`insufficient_history`) and offers
 * candidate-driven / beginner recommendations instead of inventing statistics.
 *
 * Model-produced plans are treated as untrusted input: only `candidateId` and `day` are
 * read from model output, everything else (URL, title, problem identity) is taken from the
 * validated candidate pool, so a hallucinated id or link can never reach a plan.
 */
import { invariant, requireFiniteInt } from './errors.js';
import { assertIsoTimestamp } from './ids.js';
import { deepFreeze } from './immutable.js';
import type { AccountWeaknessReport } from './weakness.js';
import type { TaxonomyIndex } from './taxonomy/types.js';
import {
  TRAINING_TASK_KINDS,
  createTrainingTask,
  lowestNumericRating,
  recalcUnmetMinutes,
  trainingPlanIdOf,
  type TrainingCandidate,
  type TrainingEvidence,
  type TrainingPlan,
  type TrainingTask,
  type TrainingTaskKind,
  type UnmetMinutes,
} from './training.js';

/** Explicit plan settings. Defaults are provided as constants, never applied implicitly. */
export interface TrainingPlanSettings {
  readonly horizonDays: number;
  readonly minutesPerDay: number;
  readonly maxTasksPerDay: number;
}

export const DEFAULT_TRAINING_PLAN_SETTINGS: TrainingPlanSettings = {
  horizonDays: 7,
  minutesPerDay: 60,
  maxTasksPerDay: 3,
};

export type CandidateRejectionReason =
  | 'missing_candidate_id'
  | 'invalid_source_url'
  | 'invalid_minutes'
  | 'duplicate_candidate_id'
  | 'duplicate_problem';

export interface RejectedCandidate {
  readonly candidateId: string | null;
  readonly reason: CandidateRejectionReason;
  readonly detail: string;
}

/** Beginner recommendation with no personal statistics attached. */
export interface BeginnerRecommendation {
  readonly taxonomyId: string;
  readonly nameEn: string;
  readonly nameZh: string;
  readonly basis: 'taxonomy_default';
  readonly rationale: string;
}

export interface PlanGenerationInput {
  readonly candidates: readonly TrainingCandidate[];
  readonly weaknessReports: readonly AccountWeaknessReport[];
  readonly settings: TrainingPlanSettings;
  readonly now: string;
  readonly accountId?: string | null;
  readonly taxonomy?: TaxonomyIndex | null;
  readonly title?: string;
  readonly planId?: string;
}

export type PlanGenerationResult =
  | {
      readonly ok: true;
      readonly plan: TrainingPlan;
      readonly rejectedCandidates: readonly RejectedCandidate[];
    }
  | {
      readonly ok: false;
      readonly reason: 'insufficient_evidence';
      readonly evidence: TrainingEvidence;
      readonly beginnerRecommendations: readonly BeginnerRecommendation[];
      readonly rejectedCandidates: readonly RejectedCandidate[];
    };

/** Starter techniques used when there is no history at all (order is pedagogical, not statistical). */
export const BEGINNER_TAG_IDS: readonly string[] = [
  'implementation.simulation',
  'implementation.brute-force',
  'greedy',
  'search.binary',
  'data-structure.prefix-sum',
  'dp.knapsack',
  'graph.shortest-path',
  'math.number-theory.gcd',
];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Defensively re-validate a candidate (candidates may come from persistence or a model). */
export function checkCandidate(candidate: TrainingCandidate): CandidateRejectionReason | null {
  if (typeof candidate.candidateId !== 'string' || candidate.candidateId.trim().length === 0) {
    return 'missing_candidate_id';
  }
  if (typeof candidate.sourceUrl !== 'string' || !isHttpUrl(candidate.sourceUrl)) {
    return 'invalid_source_url';
  }
  if (!Number.isInteger(candidate.estimatedMinutes) || candidate.estimatedMinutes <= 0) {
    return 'invalid_minutes';
  }
  return null;
}

interface CandidatePool {
  readonly valid: readonly TrainingCandidate[];
  readonly rejected: readonly RejectedCandidate[];
}

/** Filter invalid and duplicate candidates, recording an explicit reason for each rejection. */
export function prepareCandidatePool(candidates: readonly TrainingCandidate[]): CandidatePool {
  const valid: TrainingCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const seenCandidateIds = new Set<string>();
  const seenProblems = new Set<string>();

  for (const candidate of candidates) {
    const problem = checkCandidate(candidate);
    if (problem) {
      rejected.push({
        candidateId: typeof candidate.candidateId === 'string' ? candidate.candidateId : null,
        reason: problem,
        detail: `candidate failed validation (${problem})`,
      });
      continue;
    }
    if (seenCandidateIds.has(candidate.candidateId)) {
      rejected.push({
        candidateId: candidate.candidateId,
        reason: 'duplicate_candidate_id',
        detail: 'candidate id already present in the pool',
      });
      continue;
    }
    if (seenProblems.has(candidate.problemKey)) {
      rejected.push({
        candidateId: candidate.candidateId,
        reason: 'duplicate_problem',
        detail: `another candidate already covers ${candidate.problemKey}`,
      });
      continue;
    }
    seenCandidateIds.add(candidate.candidateId);
    seenProblems.add(candidate.problemKey);
    valid.push(candidate);
  }

  return { valid, rejected };
}

interface EvidenceAnalysis {
  readonly evidence: TrainingEvidence;
  /** Weakest (lowest solve rate) sufficient tags first. */
  readonly weakTagOrder: readonly string[];
  readonly attemptedDistinctTotal: number;
}

function analyseEvidence(
  reports: readonly AccountWeaknessReport[],
  accountId: string | null,
  hasCandidates: boolean,
): EvidenceAnalysis {
  const relevant = accountId === null ? reports : reports.filter((report) => report.accountId === accountId);
  const attemptedDistinctTotal = relevant.reduce((total, report) => total + report.attemptedDistinctTotal, 0);
  const tagCount = relevant.reduce((total, report) => total + report.tags.length, 0);
  const weakTagOrder = relevant
    .flatMap((report) => report.ranking)
    .sort((left, right) => left.solveRate - right.solveRate || left.taxonomyId.localeCompare(right.taxonomyId))
    .map((tag) => tag.taxonomyId);
  const sufficientTagIds = [...new Set(relevant.flatMap((report) => report.ranking.map((tag) => tag.taxonomyId)))].sort();

  const reasons: TrainingEvidence['reasons'][number][] = [];
  if (attemptedDistinctTotal === 0) {
    reasons.push('no_submission_records');
  }
  if (sufficientTagIds.length === 0) {
    reasons.push('no_sufficient_tag_samples');
  }
  if (tagCount === 0) {
    reasons.push('no_taxonomy_tags');
  }
  if (!hasCandidates) {
    reasons.push('no_candidates');
  }
  const level = attemptedDistinctTotal > 0 && sufficientTagIds.length > 0 ? 'personal_history' : 'insufficient_history';

  return {
    evidence: deepFreeze({ level, reasons, attemptedDistinctTotal, sufficientTagIds }),
    weakTagOrder,
    attemptedDistinctTotal,
  };
}

function beginnerRecommendations(index: TaxonomyIndex | null | undefined): readonly BeginnerRecommendation[] {
  if (!index) {
    return [];
  }
  return BEGINNER_TAG_IDS.filter((id) => index.has(id)).map((id) => {
    const node = index.node(id);
    return {
      taxonomyId: id,
      nameEn: node?.names.en ?? id,
      nameZh: node?.names.zh ?? id,
      basis: 'taxonomy_default' as const,
      rationale: 'Starter technique from the taxonomy; no personal statistics exist for this account yet.',
    };
  });
}

/** Priority score: lower sorts first. Weak-tag matches beat everything else. */
function candidatePriority(candidate: TrainingCandidate, weakTagOrder: readonly string[]): number {
  const weakIndex = candidate.taxonomyIds.reduce((best, taxonomyId) => {
    const index = weakTagOrder.indexOf(taxonomyId);
    return index >= 0 && index < best ? index : best;
  }, Number.POSITIVE_INFINITY);
  if (Number.isFinite(weakIndex)) {
    return weakIndex;
  }
  if (candidate.taxonomyIds.length > 0) {
    return weakTagOrder.length + 1;
  }
  return weakTagOrder.length + 2;
}

function kindFor(candidate: TrainingCandidate, weakTagOrder: readonly string[]): TrainingTaskKind {
  if (candidate.origin === 'manual') {
    return 'review';
  }
  if (candidate.origin === 'beginner') {
    return 'upskill';
  }
  return candidate.taxonomyIds.some((taxonomyId) => weakTagOrder.includes(taxonomyId)) ? 'solve' : 'upskill';
}

/**
 * Generate a rule-based draft plan.
 * Returns `ok: false` when no valid candidate exists — never a plan with invented problems.
 */
export function generateRulePlan(input: PlanGenerationInput): PlanGenerationResult {
  const horizonDays = requireFiniteInt(input.settings.horizonDays, 'horizonDays', 1);
  const minutesPerDay = requireFiniteInt(input.settings.minutesPerDay, 'minutesPerDay', 1);
  const maxTasksPerDay = requireFiniteInt(input.settings.maxTasksPerDay, 'maxTasksPerDay', 1);
  const now = assertIsoTimestamp('now', input.now);
  const accountId = input.accountId ?? null;

  const pool = prepareCandidatePool(input.candidates);
  const analysis = analyseEvidence(input.weaknessReports, accountId, pool.valid.length > 0);

  if (pool.valid.length === 0) {
    return {
      ok: false,
      reason: 'insufficient_evidence',
      evidence: analysis.evidence,
      beginnerRecommendations: beginnerRecommendations(input.taxonomy),
      rejectedCandidates: pool.rejected,
    };
  }

  const ordered = [...pool.valid].sort((left, right) => {
    const priority = candidatePriority(left, analysis.weakTagOrder) - candidatePriority(right, analysis.weakTagOrder);
    if (priority !== 0) {
      return priority;
    }
    const leftRating = lowestNumericRating(left.ratings) ?? Number.POSITIVE_INFINITY;
    const rightRating = lowestNumericRating(right.ratings) ?? Number.POSITIVE_INFINITY;
    if (leftRating !== rightRating) {
      return leftRating - rightRating;
    }
    return left.candidateId.localeCompare(right.candidateId);
  });

  const planId =
    input.planId ??
    trainingPlanIdOf({
      accountId,
      now,
      horizonDays,
      minutesPerDay,
      candidateIds: ordered.map((candidate) => candidate.candidateId),
    });

  const tasks: TrainingTask[] = [];
  const unmet: UnmetMinutes[] = [];
  const remainingPool = [...ordered];

  for (let day = 1; day <= horizonDays; day += 1) {
    let remainingMinutes = minutesPerDay;
    let order = 0;
    while (order < maxTasksPerDay) {
      // Pick the highest-priority candidate that still fits into today's budget and remove
      // it from the pool: a candidate can therefore never be scheduled twice.
      const fitIndex = remainingPool.findIndex((candidate) => candidate.estimatedMinutes <= remainingMinutes);
      if (fitIndex < 0) {
        break;
      }
      const candidate = remainingPool.splice(fitIndex, 1)[0] as TrainingCandidate;
      tasks.push(
        createTrainingTask({
          planId,
          candidate,
          day,
          order,
          minutes: candidate.estimatedMinutes,
          kind: kindFor(candidate, analysis.weakTagOrder),
          rationale:
            candidate.taxonomyIds.length > 0
              ? `Targets ${candidate.taxonomyIds.join(', ')}`
              : 'Broad practice candidate',
        }),
      );
      remainingMinutes -= candidate.estimatedMinutes;
      order += 1;
    }
    if (remainingMinutes > 0) {
      unmet.push({ day, minutes: remainingMinutes });
    }
    if (remainingPool.length === 0) {
      for (let rest = day + 1; rest <= horizonDays; rest += 1) {
        unmet.push({ day: rest, minutes: minutesPerDay });
      }
      break;
    }
  }

  const evidence: TrainingEvidence = deepFreeze({
    ...analysis.evidence,
    reasons: analysis.evidence.reasons.filter((reason) => reason !== 'no_candidates'),
  });

  const plan: TrainingPlan = deepFreeze({
    planId,
    title: input.title?.trim() || `${horizonDays}-day plan · ${minutesPerDay} min/day`,
    source: 'rule' as const,
    status: 'draft' as const,
    createdAt: now,
    adoptedAt: null,
    accountId,
    horizonDays,
    minutesPerDay,
    tasks: tasks.sort((left, right) => left.day - right.day || left.order - right.order),
    evidence,
    unmetMinutes: unmet,
  });

  return { ok: true, plan, rejectedCandidates: pool.rejected };
}

// ---------------------------------------------------------------------------------------
// Model-produced plan validation
// ---------------------------------------------------------------------------------------

export type PlanValidationCode =
  | 'invalid_shape'
  | 'no_tasks'
  | 'invalid_day'
  | 'day_out_of_range'
  | 'invalid_minutes'
  | 'invalid_kind'
  | 'unknown_candidate_id'
  | 'duplicate_candidate'
  | 'candidate_problem_mismatch'
  | 'source_url_mismatch'
  | 'invalid_source_url'
  | 'minutes_exceeded'
  | 'tasks_per_day_exceeded';

export interface PlanValidationError {
  readonly code: PlanValidationCode;
  readonly message: string;
  readonly taskIndex: number | null;
}

interface ModelPlanTaskDraft {
  readonly index: number;
  readonly day: number | null;
  readonly candidateId: string | null;
  readonly minutes: number | null;
  readonly kind: string | null;
  readonly problemKey: string | null;
  readonly sourceUrl: string | null;
  readonly title: string | null;
}

interface ModelPlanDraft {
  readonly title: string | null;
  readonly tasks: readonly ModelPlanTaskDraft[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Runtime parser for untrusted model output (external boundary). */
export function parseModelPlanDraft(raw: unknown): { readonly draft: ModelPlanDraft | null; readonly errors: readonly PlanValidationError[] } {
  const errors: PlanValidationError[] = [];
  const record = asRecord(raw);
  if (!record) {
    return { draft: null, errors: [{ code: 'invalid_shape', message: 'plan must be an object', taskIndex: null }] };
  }
  const rawTasks = record.tasks;
  if (!Array.isArray(rawTasks)) {
    return {
      draft: null,
      errors: [{ code: 'invalid_shape', message: 'plan.tasks must be an array', taskIndex: null }],
    };
  }
  if (rawTasks.length === 0) {
    return { draft: null, errors: [{ code: 'no_tasks', message: 'plan has no tasks', taskIndex: null }] };
  }
  const tasks: ModelPlanTaskDraft[] = [];
  rawTasks.forEach((entry, index) => {
    const task = asRecord(entry);
    if (!task) {
      errors.push({ code: 'invalid_shape', message: 'task must be an object', taskIndex: index });
      return;
    }
    tasks.push({
      index,
      day: typeof task.day === 'number' ? task.day : null,
      candidateId: typeof task.candidateId === 'string' ? task.candidateId : null,
      minutes: typeof task.minutes === 'number' ? task.minutes : null,
      kind: typeof task.kind === 'string' ? task.kind : null,
      problemKey: typeof task.problemKey === 'string' ? task.problemKey : null,
      sourceUrl: typeof task.sourceUrl === 'string' ? task.sourceUrl : null,
      title: typeof task.title === 'string' ? task.title : null,
    });
  });
  return {
    draft: { title: typeof record.title === 'string' ? record.title : null, tasks },
    errors,
  };
}

export interface ValidateModelPlanInput {
  readonly raw: unknown;
  readonly candidates: readonly TrainingCandidate[];
  readonly settings: TrainingPlanSettings;
  readonly now: string;
  readonly accountId?: string | null;
  readonly planId?: string;
}

export interface ModelPlanValidation {
  readonly ok: boolean;
  readonly errors: readonly PlanValidationError[];
  /** Present only when validation succeeded; always built from validated candidates. */
  readonly plan: TrainingPlan | null;
}

/**
 * Validate a model-produced plan against the selected candidates and the plan settings.
 * Hallucinated candidate ids, mismatched problem identities/links, invalid days, duplicate
 * candidates and minute overruns are all reported as errors; nothing is silently repaired.
 */
export function validateModelPlan(input: ValidateModelPlanInput): ModelPlanValidation {
  const horizonDays = requireFiniteInt(input.settings.horizonDays, 'horizonDays', 1);
  const minutesPerDay = requireFiniteInt(input.settings.minutesPerDay, 'minutesPerDay', 1);
  const maxTasksPerDay = requireFiniteInt(input.settings.maxTasksPerDay, 'maxTasksPerDay', 1);
  const now = assertIsoTimestamp('now', input.now);

  const parsed = parseModelPlanDraft(input.raw);
  const errors: PlanValidationError[] = [...parsed.errors];
  if (!parsed.draft) {
    return { ok: false, errors: deepFreeze(errors), plan: null };
  }
  const pool = prepareCandidatePool(input.candidates);
  if (pool.valid.length === 0) {
    errors.push({ code: 'unknown_candidate_id', message: 'no valid candidates were selected', taskIndex: null });
  }
  const byCandidateId = new Map(pool.valid.map((candidate) => [candidate.candidateId, candidate]));

  const perDayMinutes = new Map<number, number>();
  const perDayTasks = new Map<number, number>();
  const seenCandidates = new Set<string>();
  const tasks: TrainingTask[] = [];
  const planId =
    input.planId ??
    trainingPlanIdOf({
      accountId: input.accountId ?? null,
      now,
      horizonDays,
      minutesPerDay,
      candidateIds: parsed.draft.tasks.map((task) => task.candidateId ?? ''),
    });

  for (const draftTask of parsed.draft.tasks) {
    const { index } = draftTask;
    if (draftTask.day === null || !Number.isInteger(draftTask.day)) {
      errors.push({ code: 'invalid_day', message: 'task day must be an integer', taskIndex: index });
      continue;
    }
    if (draftTask.day < 1 || draftTask.day > horizonDays) {
      errors.push({
        code: 'day_out_of_range',
        message: `task day ${draftTask.day} is outside 1..${horizonDays}`,
        taskIndex: index,
      });
      continue;
    }
    if (draftTask.candidateId === null) {
      errors.push({ code: 'unknown_candidate_id', message: 'task has no candidateId', taskIndex: index });
      continue;
    }
    const candidate = byCandidateId.get(draftTask.candidateId);
    if (!candidate) {
      errors.push({
        code: 'unknown_candidate_id',
        message: `candidate ${draftTask.candidateId} is not in the selected candidate set`,
        taskIndex: index,
      });
      continue;
    }
    if (seenCandidates.has(candidate.candidateId)) {
      errors.push({
        code: 'duplicate_candidate',
        message: `candidate ${candidate.candidateId} appears more than once`,
        taskIndex: index,
      });
      continue;
    }
    if (draftTask.problemKey !== null && draftTask.problemKey !== candidate.problemKey) {
      errors.push({
        code: 'candidate_problem_mismatch',
        message: `task problemKey does not match candidate ${candidate.candidateId}`,
        taskIndex: index,
      });
      continue;
    }
    if (draftTask.sourceUrl !== null && draftTask.sourceUrl !== candidate.sourceUrl) {
      errors.push({
        code: 'source_url_mismatch',
        message: `task sourceUrl does not match candidate ${candidate.candidateId}`,
        taskIndex: index,
      });
      continue;
    }
    if (draftTask.kind !== null && !TRAINING_TASK_KINDS.includes(draftTask.kind as TrainingTaskKind)) {
      errors.push({ code: 'invalid_kind', message: `unknown task kind ${draftTask.kind}`, taskIndex: index });
      continue;
    }
    const minutes = draftTask.minutes ?? candidate.estimatedMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > minutesPerDay) {
      errors.push({
        code: 'invalid_minutes',
        message: `task minutes must be within 1..${minutesPerDay}`,
        taskIndex: index,
      });
      continue;
    }
    const dayMinutes = (perDayMinutes.get(draftTask.day) ?? 0) + minutes;
    if (dayMinutes > minutesPerDay) {
      errors.push({
        code: 'minutes_exceeded',
        message: `day ${draftTask.day} would exceed ${minutesPerDay} minutes`,
        taskIndex: index,
      });
      continue;
    }
    const dayTasks = (perDayTasks.get(draftTask.day) ?? 0) + 1;
    if (dayTasks > maxTasksPerDay) {
      errors.push({
        code: 'tasks_per_day_exceeded',
        message: `day ${draftTask.day} would exceed ${maxTasksPerDay} tasks`,
        taskIndex: index,
      });
      continue;
    }

    perDayMinutes.set(draftTask.day, dayMinutes);
    perDayTasks.set(draftTask.day, dayTasks);
    seenCandidates.add(candidate.candidateId);
    tasks.push(
      createTrainingTask({
        planId,
        candidate,
        day: draftTask.day,
        order: dayTasks - 1,
        minutes,
        kind: (draftTask.kind as TrainingTaskKind | null) ?? kindFor(candidate, []),
        rationale: 'Selected by the model from the approved candidate set',
      }),
    );
  }

  if (tasks.length === 0) {
    errors.push({ code: 'no_tasks', message: 'no valid task survived validation', taskIndex: null });
  }
  if (errors.length > 0) {
    return { ok: false, errors: deepFreeze(errors), plan: null };
  }

  const plan: TrainingPlan = deepFreeze({
    planId,
    title: parsed.draft.title?.trim() || `${horizonDays}-day plan · ${minutesPerDay} min/day`,
    source: 'model' as const,
    status: 'draft' as const,
    createdAt: now,
    adoptedAt: null,
    accountId: input.accountId ?? null,
    horizonDays,
    minutesPerDay,
    tasks: tasks.sort((left, right) => left.day - right.day || left.order - right.order),
    evidence: {
      level: 'personal_history',
      reasons: [],
      attemptedDistinctTotal: 0,
      sufficientTagIds: [],
    },
    unmetMinutes: recalcUnmetMinutes(tasks, horizonDays, minutesPerDay),
  });

  return { ok: true, errors: deepFreeze([]), plan };
}

/** Guard used by callers that must never schedule a hallucinated candidate. */
export function assertCandidateExists(candidateId: string, candidates: readonly TrainingCandidate[]): TrainingCandidate {
  const candidate = candidates.find((entry) => entry.candidateId === candidateId);
  invariant(candidate !== undefined, 'missing_reference', `unknown candidate ${candidateId}`, { candidateId });
  return candidate;
}
