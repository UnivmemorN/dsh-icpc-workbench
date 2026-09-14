/**
 * Training plans and tasks.
 *
 * A plan is immutable data with pure transition helpers: `preview → adopt → edit → check
 * off`. Every task points at a **real** candidate (a real problem with a real URL); tasks
 * are never invented, and a candidate appears at most once in a plan so "no accidental
 * duplicates" is structural rather than a UI convention. Adoption is a gate: checkoffs are
 * only accepted from an adopted plan, and an edit may never push a day over its budget.
 *
 * Gaps are explicit: when the weakest-tag pool cannot fill a day, the plan records the
 * unfilled minutes instead of silently shrinking the plan.
 */
import { DomainError, invariant, requireFiniteInt } from './errors.js';
import { assertHttpUrl, assertIsoTimestamp, assertIdPart, problemKey, type ProblemRef } from './ids.js';
import { deepFreeze } from './immutable.js';
import { contentHashOf } from './hash.js';
import {
  GUIDANCE_AXES,
  GUIDANCE_CONFIDENCES,
  GUIDANCE_DIAGNOSIS_PRIORITIES,
  MAX_GUIDANCE_SHORT_CHARS,
  type GuidanceAxis,
  type GuidanceConfidence,
  type GuidanceDiagnosisPriority,
  type GuidanceSnapshot,
} from './guidance.js';
import type { PlatformRating } from './problem.js';

export type TrainingTaskKind = 'solve' | 'review' | 'upskill';
export type TrainingTaskStatus = 'planned' | 'done' | 'skipped';
export type TrainingPlanStatus = 'draft' | 'adopted';
export type TrainingCandidateOrigin = 'weakness' | 'unsolved_pool' | 'manual' | 'beginner';

export const TRAINING_TASK_KINDS: readonly TrainingTaskKind[] = ['solve', 'review', 'upskill'];

/**
 * The dual axis one guided task trains (Sprint 18b).
 *
 * A task of a plan generated under a selected training method is deliberately labelled with the
 * axis it exercises, so a guided plan can be shown to cover both thinking (modelling, proofs) and
 * templates (algorithms, implementation). A rule or legacy plan carries no axis at all.
 */
export type TrainingTaskAxis = GuidanceAxis;

/** Axes a guided task may name; exported so generator, validator and tests share one list. */
export const TRAINING_TASK_AXES: readonly TrainingTaskAxis[] = GUIDANCE_AXES;

/** Longest accepted per-task training objective and diagnosis sentence. */
export const MAX_PLAN_OBJECTIVE_CHARS = MAX_GUIDANCE_SHORT_CHARS;

/**
 * Dual-axis diagnosis of one guided plan.
 *
 * `priority` names the axis that currently blocks the other (`balanced` when neither does,
 * `diagnostic` when the available evidence cannot name one), while `reason`, `readinessCheck` and
 * `confidence` carry the bounded explanation a human reads before adopting the plan. The diagnosis
 * is candidate-specific material: the unrevealed plan projection withholds its free-form text.
 */
export interface PlanDiagnosis {
  readonly priority: GuidanceDiagnosisPriority;
  readonly reason: string;
  readonly readinessCheck: string;
  readonly confidence: GuidanceConfidence;
}

/** Why one diagnosis value is not usable, or `null` when it is. */
export function planDiagnosisProblem(value: unknown): string | null {
  if (value === null || value === undefined) {
    return 'a guided plan needs a dual-axis diagnosis';
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'plan diagnosis must be a JSON object';
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => key !== 'priority' && key !== 'reason' && key !== 'readinessCheck' && key !== 'confidence',
  );
  if (unknown.length > 0) {
    return `plan diagnosis has unknown keys: ${unknown.join(', ')}`;
  }
  if (!GUIDANCE_DIAGNOSIS_PRIORITIES.includes(record['priority'] as GuidanceDiagnosisPriority)) {
    return `unknown plan diagnosis priority ${String(record['priority'])}`;
  }
  if (!GUIDANCE_CONFIDENCES.includes(record['confidence'] as GuidanceConfidence)) {
    return `unknown plan diagnosis confidence ${String(record['confidence'])}`;
  }
  for (const key of ['reason', 'readinessCheck'] as const) {
    const text = record[key];
    if (typeof text !== 'string' || text.trim().length === 0) {
      return `plan diagnosis ${key} must be a non-empty string`;
    }
    if (text.length > MAX_GUIDANCE_SHORT_CHARS) {
      return `plan diagnosis ${key} is ${text.length} characters, above ${MAX_GUIDANCE_SHORT_CHARS}`;
    }
  }
  return null;
}

/** Build one validated, frozen plan diagnosis; a malformed value is refused, never coerced. */
export function validatePlanDiagnosis(value: unknown): PlanDiagnosis {
  const problem = planDiagnosisProblem(value);
  invariant(problem === null, 'invalid_input', problem ?? 'plan diagnosis is not valid', { value });
  const record = value as Record<string, unknown>;
  return deepFreeze({
    priority: record['priority'] as GuidanceDiagnosisPriority,
    reason: (record['reason'] as string).trim(),
    readinessCheck: (record['readinessCheck'] as string).trim(),
    confidence: record['confidence'] as GuidanceConfidence,
  });
}

/** A real, addressable problem that may be scheduled. */
export interface TrainingCandidate {
  readonly candidateId: string;
  readonly problemKey: string;
  readonly ref: ProblemRef;
  readonly title: string;
  readonly sourceUrl: string;
  readonly taxonomyIds: readonly string[];
  readonly estimatedMinutes: number;
  readonly ratings: readonly PlatformRating[];
  readonly origin: TrainingCandidateOrigin;
}

export interface CreateTrainingCandidateInput {
  readonly candidateId: string;
  readonly problemRef: ProblemRef;
  readonly title: string;
  readonly sourceUrl: string;
  readonly estimatedMinutes: number;
  readonly taxonomyIds?: readonly string[];
  readonly ratings?: readonly PlatformRating[];
  readonly origin?: TrainingCandidateOrigin;
}

/** Build a validated, frozen candidate. Invalid URLs/ids fail here, not in the generator. */
export function createTrainingCandidate(input: CreateTrainingCandidateInput): TrainingCandidate {
  assertIdPart('candidateId', input.candidateId);
  const title = input.title.trim();
  invariant(title.length > 0, 'invalid_input', 'candidate title must not be empty', { candidateId: input.candidateId });
  return deepFreeze({
    candidateId: input.candidateId,
    problemKey: problemKey(input.problemRef),
    ref: input.problemRef,
    title,
    sourceUrl: assertHttpUrl('candidate sourceUrl', input.sourceUrl),
    taxonomyIds: [...new Set(input.taxonomyIds ?? [])],
    estimatedMinutes: requireFiniteInt(input.estimatedMinutes, 'estimatedMinutes', 1),
    ratings: input.ratings ?? [],
    origin: input.origin ?? 'unsolved_pool',
  });
}

export type PlanEvidenceReason =
  | 'no_submission_records'
  | 'no_sufficient_tag_samples'
  | 'no_taxonomy_tags'
  | 'no_candidates';

export type TrainingEvidenceLevel = 'personal_history' | 'insufficient_history';

/** Why a plan looks the way it does — always explicit, never implied. */
export interface TrainingEvidence {
  readonly level: TrainingEvidenceLevel;
  readonly reasons: readonly PlanEvidenceReason[];
  readonly attemptedDistinctTotal: number;
  readonly sufficientTagIds: readonly string[];
}

export interface TrainingTask {
  /** Stable id: `planId|candidateId` (identity does not change when the task moves day). */
  readonly taskId: string;
  readonly planId: string;
  readonly day: number;
  readonly order: number;
  readonly candidateId: string;
  readonly problemKey: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly minutes: number;
  readonly kind: TrainingTaskKind;
  readonly taxonomyIds: readonly string[];
  readonly status: TrainingTaskStatus;
  readonly checkedAt: string | null;
  readonly rationale: string;
  /**
   * Dual axis this task trains under a selected training method (Sprint 18b).
   *
   * **Absent, not `null`, on a rule or legacy plan**: a stored row that predates guided planning
   * keeps hashing and rendering exactly as it did, and the field can only be set by a validated
   * guided model draft. Together with {@link TrainingTask.objective} it keeps the plan's training
   * philosophy distinguishable from the AI's scheduling answer.
   */
  readonly axis?: TrainingTaskAxis;
  /** Bounded training objective of this task; absent on a rule or legacy plan. */
  readonly objective?: string;
}

export interface UnmetMinutes {
  readonly day: number;
  readonly minutes: number;
}

export interface TrainingPlan {
  readonly planId: string;
  readonly title: string;
  readonly source: 'rule' | 'model';
  readonly status: TrainingPlanStatus;
  readonly createdAt: string;
  readonly adoptedAt: string | null;
  readonly accountId: string | null;
  readonly horizonDays: number;
  readonly minutesPerDay: number;
  readonly tasks: readonly TrainingTask[];
  readonly evidence: TrainingEvidence;
  readonly unmetMinutes: readonly UnmetMinutes[];
  /**
   * Dual-axis diagnosis of a plan generated under a selected training method (Sprint 18b).
   *
   * **Absent, not `null`, on a rule or legacy plan**: a stored row that predates guided planning
   * keeps its content hash byte-for-byte, and only a validated guided model draft can set it.
   */
  readonly diagnosis?: PlanDiagnosis;
  /**
   * Immutable capture of the training methods this plan was generated under (Sprint 18b).
   *
   * **Absent, not `null`, on a rule or legacy plan.** The capture names the selected method ids and
   * carries their exact names, versions, hashes and source citations, so a plan's method
   * attribution stays readable after the planning-attempt view is unloaded — and stays provably the
   * text the model was shown after a companion package was upgraded or removed. It is the same
   * frozen capture the preparation stored; nothing here is re-derived from "the current method".
   */
  readonly guidanceSnapshot?: GuidanceSnapshot;
}

/** Summarised plan for the preview step. */
export interface PlanPreview {
  readonly planId: string;
  readonly status: TrainingPlanStatus;
  readonly title: string;
  readonly horizonDays: number;
  readonly minutesPerDay: number;
  readonly totalPlannedMinutes: number;
  readonly totalUnmetMinutes: number;
  readonly taskCount: number;
  readonly distinctCandidates: number;
  readonly days: readonly {
    readonly day: number;
    readonly taskCount: number;
    readonly minutes: number;
    readonly unmetMinutes: number;
  }[];
  readonly targetedTagIds: readonly string[];
  readonly evidenceLevel: TrainingEvidenceLevel;
  readonly evidenceReasons: readonly PlanEvidenceReason[];
  readonly hasDuplicateCandidates: boolean;
}

/** Build a task (internal helper; keeps id/URL/candidate wiring consistent). */
export function createTrainingTask(input: {
  readonly planId: string;
  readonly candidate: TrainingCandidate;
  readonly day: number;
  readonly order: number;
  readonly minutes: number;
  readonly kind: TrainingTaskKind;
  readonly rationale: string;
  readonly status?: TrainingTaskStatus;
  readonly checkedAt?: string | null;
  /** Guided plans only; both are omitted (not `null`) for a rule or legacy task. */
  readonly axis?: TrainingTaskAxis;
  readonly objective?: string;
}): TrainingTask {
  invariant(Number.isInteger(input.day) && input.day >= 1, 'invalid_input', 'task day must be >= 1', {
    day: input.day,
  });
  invariant(Number.isInteger(input.order) && input.order >= 0, 'invalid_input', 'task order must be >= 0', {
    order: input.order,
  });
  if (input.axis !== undefined) {
    invariant(
      TRAINING_TASK_AXES.includes(input.axis),
      'invalid_input',
      `unknown training task axis ${String(input.axis)}`,
      { axis: input.axis },
    );
  }
  const objective = input.objective?.trim();
  if (objective !== undefined) {
    invariant(
      objective.length > 0 && objective.length <= MAX_PLAN_OBJECTIVE_CHARS,
      'invalid_input',
      `task objective must be 1..${MAX_PLAN_OBJECTIVE_CHARS} characters`,
      { length: objective.length },
    );
  }
  return deepFreeze({
    taskId: `${input.planId}|${input.candidate.candidateId}`,
    planId: input.planId,
    day: input.day,
    order: input.order,
    candidateId: input.candidate.candidateId,
    problemKey: input.candidate.problemKey,
    title: input.candidate.title,
    sourceUrl: input.candidate.sourceUrl,
    minutes: requireFiniteInt(input.minutes, 'minutes', 1),
    kind: input.kind,
    taxonomyIds: input.candidate.taxonomyIds,
    status: input.status ?? 'planned',
    checkedAt: input.checkedAt ?? null,
    rationale: input.rationale,
    ...(input.axis === undefined ? {} : { axis: input.axis }),
    ...(objective === undefined ? {} : { objective }),
  });
}

/** Deterministic plan id from its inputs (same inputs → same plan, safe to retry). */
export function trainingPlanIdOf(input: {
  readonly accountId: string | null;
  readonly now: string;
  readonly horizonDays: number;
  readonly minutesPerDay: number;
  readonly candidateIds: readonly string[];
}): string {
  return `plan|${contentHashOf({
    accountId: input.accountId,
    now: input.now,
    horizonDays: input.horizonDays,
    minutesPerDay: input.minutesPerDay,
    candidateIds: [...input.candidateIds],
  }).slice(0, 24)}`;
}

/** Duplicate detection: candidate identities that occur more than once. */
export function duplicateCandidateIds(tasks: readonly TrainingTask[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.candidateId)) {
      duplicates.add(task.candidateId);
    }
    seen.add(task.candidateId);
  }
  return [...duplicates].sort();
}

/** Summarise a plan for preview. */
export function previewPlan(plan: TrainingPlan): PlanPreview {
  const days = Array.from({ length: plan.horizonDays }, (_, index) => {
    const day = index + 1;
    const tasks = plan.tasks.filter((task) => task.day === day);
    return {
      day,
      taskCount: tasks.length,
      minutes: tasks.reduce((total, task) => total + task.minutes, 0),
      unmetMinutes: plan.unmetMinutes.find((entry) => entry.day === day)?.minutes ?? 0,
    };
  });
  const targeted = [...new Set(plan.tasks.flatMap((task) => task.taxonomyIds))].sort();
  return deepFreeze({
    planId: plan.planId,
    status: plan.status,
    title: plan.title,
    horizonDays: plan.horizonDays,
    minutesPerDay: plan.minutesPerDay,
    totalPlannedMinutes: plan.tasks.reduce((total, task) => total + task.minutes, 0),
    totalUnmetMinutes: plan.unmetMinutes.reduce((total, entry) => total + entry.minutes, 0),
    taskCount: plan.tasks.length,
    distinctCandidates: new Set(plan.tasks.map((task) => task.candidateId)).size,
    days,
    targetedTagIds: targeted,
    evidenceLevel: plan.evidence.level,
    evidenceReasons: plan.evidence.reasons,
    hasDuplicateCandidates: duplicateCandidateIds(plan.tasks).length > 0,
  });
}

/** Adopt a draft plan (the human checked the preview and accepts it). */
export function adoptPlan(plan: TrainingPlan, input: { readonly adoptedAt: string; readonly title?: string }): TrainingPlan {
  invariant(plan.status === 'draft', 'invalid_transition', 'only a draft plan can be adopted', { planId: plan.planId });
  invariant(plan.tasks.length > 0, 'invalid_input', 'cannot adopt an empty plan', { planId: plan.planId });
  return deepFreeze({
    ...plan,
    status: 'adopted' as const,
    adoptedAt: assertIsoTimestamp('adoptedAt', input.adoptedAt),
    title: input.title?.trim() || plan.title,
  });
}

export interface PlanTaskPatch {
  readonly day?: number;
  readonly minutes?: number;
  readonly kind?: TrainingTaskKind;
  readonly title?: string;
}

/**
 * Edit one task. Scheduling fields of an already checked-off task are frozen so that
 * completion records stay truthful; renaming such a task is still allowed.
 */
export function editPlanTask(
  plan: TrainingPlan,
  taskId: string,
  patch: PlanTaskPatch,
  input: { readonly at: string },
): TrainingPlan {
  // The caller-supplied timestamp is still validated even though a patch stores no timestamp.
  assertIsoTimestamp('at', input.at);
  const index = plan.tasks.findIndex((task) => task.taskId === taskId);
  if (index < 0) {
    throw new DomainError('missing_reference', `unknown task ${taskId}`, { planId: plan.planId, taskId });
  }
  const task = plan.tasks[index] as TrainingTask;
  const changesSchedule = patch.day !== undefined || patch.minutes !== undefined || patch.kind !== undefined;
  invariant(
    !(changesSchedule && task.status !== 'planned'),
    'invalid_transition',
    'a completed or skipped task cannot be rescheduled',
    { taskId, status: task.status },
  );
  if (patch.day !== undefined) {
    invariant(
      Number.isInteger(patch.day) && patch.day >= 1 && patch.day <= plan.horizonDays,
      'invalid_input',
      `day must be within 1..${plan.horizonDays}`,
      { day: patch.day, horizonDays: plan.horizonDays },
    );
  }
  if (patch.minutes !== undefined) {
    invariant(
      Number.isInteger(patch.minutes) && patch.minutes >= 1 && patch.minutes <= plan.minutesPerDay,
      'invalid_input',
      `minutes must be within 1..${plan.minutesPerDay}`,
      { minutes: patch.minutes, minutesPerDay: plan.minutesPerDay },
    );
  }
  if (patch.kind !== undefined) {
    invariant(
      TRAINING_TASK_KINDS.includes(patch.kind),
      'invalid_input',
      `unknown task kind ${String(patch.kind)}`,
      { kind: patch.kind },
    );
  }
  const updated: TrainingTask = deepFreeze({
    ...task,
    day: patch.day ?? task.day,
    minutes: patch.minutes ?? task.minutes,
    kind: patch.kind ?? task.kind,
    title: patch.title?.trim() || task.title,
  });
  const tasks = plan.tasks.map((entry, entryIndex) => (entryIndex === index ? updated : entry));
  const perDayMinutes = new Map<number, number>();
  for (const entry of tasks) {
    perDayMinutes.set(entry.day, (perDayMinutes.get(entry.day) ?? 0) + entry.minutes);
  }
  const unmetMinutes = [...perDayMinutes.entries()]
    .filter(([, minutes]) => minutes > plan.minutesPerDay)
    .map(([day, minutes]) => ({ day, minutes: minutes - plan.minutesPerDay }));
  invariant(
    unmetMinutes.length === 0,
    'invalid_input',
    `edited plan exceeds ${plan.minutesPerDay} minutes on some day`,
    { over: unmetMinutes },
  );
  return deepFreeze({ ...plan, tasks, unmetMinutes: recalcUnmetMinutes(tasks, plan.horizonDays, plan.minutesPerDay) });
}

/** Unfilled minutes per day: the explicit gap between the plan and the requested daily budget. */
export function recalcUnmetMinutes(
  tasks: readonly TrainingTask[],
  horizonDays: number,
  minutesPerDay: number,
): readonly UnmetMinutes[] {
  const unmet: UnmetMinutes[] = [];
  for (let day = 1; day <= horizonDays; day += 1) {
    const minutes = tasks.filter((task) => task.day === day).reduce((total, task) => total + task.minutes, 0);
    if (minutes < minutesPerDay) {
      unmet.push({ day, minutes: minutesPerDay - minutes });
    }
  }
  return unmet;
}

/**
 * Check a task off (or mark it skipped) inside an **adopted** plan.
 *
 * Adoption is the human confirmation step; a draft may still be regenerated or discarded,
 * so recording progress against it would create completion history for a plan nobody
 * agreed to. The recorded timestamp is the only thing a checkoff writes.
 */
export function checkOffTask(
  plan: TrainingPlan,
  taskId: string,
  input: { readonly at: string; readonly status: Extract<TrainingTaskStatus, 'done' | 'skipped'> },
): TrainingPlan {
  invariant(
    plan.status === 'adopted',
    'invalid_transition',
    'only an adopted plan can record task completion',
    { planId: plan.planId, status: plan.status },
  );
  const at = assertIsoTimestamp('at', input.at);
  const task = plan.tasks.find((entry) => entry.taskId === taskId);
  if (!task) {
    throw new DomainError('missing_reference', `unknown task ${taskId}`, { planId: plan.planId, taskId });
  }
  invariant(task.status !== input.status, 'invalid_transition', `task is already ${input.status}`, { taskId });
  const tasks = plan.tasks.map((entry) =>
    entry.taskId === taskId ? deepFreeze({ ...entry, status: input.status, checkedAt: at }) : entry,
  );
  return deepFreeze({ ...plan, tasks });
}

/** Median numeric rating across the given dimensions (used for ordering candidates). */
export function lowestNumericRating(ratings: readonly PlatformRating[]): number | null {
  const values = ratings
    .map((rating) => (typeof rating.value === 'number' ? rating.value : Number(rating.value)))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    return null;
  }
  return Math.min(...values);
}
