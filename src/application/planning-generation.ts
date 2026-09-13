/**
 * AI training-plan generation port (Sprint 11c).
 *
 * One `generate` call is exactly one audited planning model call. The application layer owns the
 * request contract and its pure validation; the dsh adapter owns the planner prompt and the strict
 * output parse. Nothing here reads a clock, a network or an environment variable, so a request that
 * fails validation is refused before any paid dispatch.
 *
 * What this module guarantees, and what it deliberately does not:
 *
 * - It guarantees request *coherence*: configured provider/model ids, bounded token and timeout
 *   budgets, the approved effort, a well-formed cancellation token, bounded plan settings, at most
 *   {@link MAX_PLANNING_CANDIDATES} real candidates with unique ids, an identifier-free ability
 *   aggregate, and no account identifier anywhere in the request.
 * - The request is **untrusted task data** for the prompt: the model may not invent candidate ids,
 *   ratings or mastery. That is an instruction in the adapter's system prompt plus the structural
 *   guarantee that the request only ever contains real prepared candidates; semantic obedience is
 *   not something this module pretends to verify.
 * - It never decides whether a plan is acceptable. The output is a normalized *draft* whose
 *   candidate ids, day numbers, minutes and kinds still have to pass the domain's
 *   `validateModelPlan` against the same candidate pool and settings, so a hallucinated id, a
 *   mismatched URL, a duplicate candidate or an out-of-range day is refused there and never
 *   silently repaired.
 */
import { invariant, type AbilityPlanningAggregate, type TrainingTaskKind } from '../domain/index.js';
import { TRAINING_TASK_KINDS } from '../domain/index.js';
import type { CancellationToken } from '../domain/index.js';
import type { ModelCallResult } from './ports.js';
import { MAX_PLANNING_CANDIDATES, type PlanAttemptSettings, type PlanAttemptWeakTag } from './planning-types.js';

/** Prompt identity this build records for planning calls; the service reuses it when reserving. */
export const PLANNING_PROMPT_VERSION = 'planning-v1';

/** Approved reasoning effort of every planning call; v1 never runs a lower effort. */
export const PLANNING_EFFORT = 'max';

/** Maximum accepted plan title length in model output; a longer title is a defect, not a plan. */
export const MAX_PLANNING_TITLE_CHARS = 200;

/** Maximum accepted tasks in one model draft; above this the answer is rejected, not truncated. */
export const MAX_PLANNING_DRAFT_TASKS = 200;

/** One real candidate as the planner sees it: no statement, no editorial, no account handle. */
export interface PlanGenerationCandidate {
  readonly candidateId: string;
  readonly title: string;
  readonly url: string;
  readonly estimatedMinutes: number;
  /** Effective taxonomy ids of this candidate at its stored snapshot head. */
  readonly taxonomyIds: readonly string[];
  readonly ratings: readonly {
    readonly dimension: string;
    readonly value: number | string;
    readonly raw: string;
  }[];
  /** Raw platform labels: explicitly provisional provenance, never accepted tags. */
  readonly provisionalRawTags: readonly string[];
}

/**
 * One planning request.
 *
 * `provider`, `model`, `maxOutputTokens` and `requestTimeoutMs` are configured values the calling
 * service passes explicitly (the settings module owns their defaults; 11c borrows the analysis
 * role's model and the global model timeout). The request carries no account id, no handle, no
 * problem-submission detail and no retrospective note: the ability aggregate is the
 * identifier-free 11a reduction and the candidates are public metadata plus effective tags.
 */
export interface PlanGenerationRequest {
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly requestTimeoutMs: number;
  readonly effort: 'max';
  /** Durable attempt this call was reserved as; echoed into the host's own logs. */
  readonly attemptId: string;
  /** Prompt identity shared with the persisted attempt. */
  readonly promptVersion: string;
  readonly token: CancellationToken;
  readonly settings: PlanAttemptSettings;
  /** 11a aggregate: estimate status/basis/confidence, sample and coverage, native dimensions. */
  readonly ability: AbilityPlanningAggregate;
  readonly candidates: readonly PlanGenerationCandidate[];
  /** Sufficient-sample weak tags of this account (aggregate only). */
  readonly weakTags: readonly PlanAttemptWeakTag[];
  readonly attemptedDistinctTotal: number;
}

/** One normalized task of a model draft; `minutes`/`kind` are `null` when the model omitted them. */
export interface PlanGenerationDraftTask {
  readonly candidateId: string;
  readonly day: number;
  readonly minutes: number | null;
  readonly kind: TrainingTaskKind | null;
}

/**
 * The strict, normalized model draft.
 *
 * This is the *only* shape a generator may hand back: exactly `title` and `tasks`, where every
 * task carries exactly a candidate id, a day and optionally minutes and a kind. A draft is still
 * untrusted — it is fed to `validateModelPlan` unchanged — but it can no longer carry a URL, a
 * problem key or arbitrary extra data into the plan.
 */
export interface PlanGenerationDraft {
  readonly title: string | null;
  readonly tasks: readonly PlanGenerationDraftTask[];
}

export interface PlanGenerationOutcome {
  readonly draft: PlanGenerationDraft;
}

/**
 * Training-plan model access.
 *
 * Callers own reservations, quota, retries and persistence; the generator owns one audited call and
 * its strict output contract, and never retries on its own.
 */
export interface PlanningGenerator {
  generate(request: PlanGenerationRequest): Promise<ModelCallResult<PlanGenerationOutcome>>;
}

/**
 * Pure pre-dispatch check of one planning request.
 *
 * Returns `null` when the request is coherent and a short human-readable reason otherwise. The
 * reason is local diagnostic material: an adapter maps it to a typed `unsupported` refusal with
 * known-zero usage and never dispatches. The checks are exactly the request-shape guarantees in the
 * module comment, so a generator that calls this once may trust every field it then reads.
 */
export function planningGenerationProblem(request: unknown): string | null {
  if (!isRecord(request)) {
    return 'planning needs a generation request object';
  }
  for (const [label, value] of [
    ['provider', request['provider']],
    ['model', request['model']],
    ['attemptId', request['attemptId']],
    ['promptVersion', request['promptVersion']],
  ] as const) {
    if (!nonEmptyText(value)) {
      return `planning ${label} must be a non-empty configured id`;
    }
  }
  const token = request['token'];
  if (!isRecord(token) || typeof token['cancelled'] !== 'boolean' || typeof token['onCancel'] !== 'function') {
    return 'planning needs a cancellation token';
  }
  const maxOutputTokens = request['maxOutputTokens'];
  if (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    return 'planning maxOutputTokens must be a positive integer';
  }
  const requestTimeoutMs = request['requestTimeoutMs'];
  if (typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    return 'planning requestTimeoutMs must be a positive integer';
  }
  if (request['effort'] !== PLANNING_EFFORT) {
    return `planning effort must be '${PLANNING_EFFORT}'`;
  }
  const settings = request['settings'];
  if (!isRecord(settings)) {
    return 'planning needs plan settings';
  }
  for (const key of ['horizonDays', 'minutesPerDay', 'maxTasksPerDay', 'estimatedMinutes'] as const) {
    const value = settings[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      return `planning settings.${key} must be a positive integer`;
    }
  }

  const candidates = request['candidates'];
  if (!Array.isArray(candidates)) {
    return 'planning needs an array of candidates';
  }
  if (candidates.length === 0) {
    return 'planning needs at least one prepared candidate';
  }
  if (candidates.length > MAX_PLANNING_CANDIDATES) {
    return `planning accepts at most ${MAX_PLANNING_CANDIDATES} candidates`;
  }
  const seen = new Set<string>();
  for (const candidate of candidates as readonly unknown[]) {
    if (!isRecord(candidate)) {
      return 'every planning candidate must be an object';
    }
    const candidateId = candidate['candidateId'];
    if (!nonEmptyText(candidateId)) {
      return 'every planning candidate needs a non-empty candidateId';
    }
    if (seen.has(candidateId as string)) {
      return `planning candidates repeat candidateId ${String(candidateId)}`;
    }
    seen.add(candidateId as string);
    if (!nonEmptyText(candidate['title'])) {
      return `planning candidate ${String(candidateId)} needs a non-empty title`;
    }
    if (typeof candidate['estimatedMinutes'] !== 'number' || !Number.isSafeInteger(candidate['estimatedMinutes'])) {
      return `planning candidate ${String(candidateId)} needs an integer estimatedMinutes`;
    }
    if (!Array.isArray(candidate['taxonomyIds']) || !Array.isArray(candidate['ratings'])) {
      return `planning candidate ${String(candidateId)} needs taxonomyIds and ratings arrays`;
    }
  }

  const ability = request['ability'];
  if (!isRecord(ability)) {
    return 'planning needs the identifier-free ability aggregate';
  }
  for (const forbidden of ['accountId', 'handle', 'sourceInstanceId', 'problemKey']) {
    if (Object.prototype.hasOwnProperty.call(ability, forbidden)) {
      return `planning ability aggregate must not carry ${forbidden}`;
    }
  }
  if (!nonEmptyText(ability['version']) || !nonEmptyText(ability['estimateStatus'])) {
    return 'planning ability aggregate needs its version and estimateStatus';
  }
  if (!Array.isArray(request['weakTags'])) {
    return 'planning weakTags must be an array';
  }
  const attempted = request['attemptedDistinctTotal'];
  if (typeof attempted !== 'number' || !Number.isSafeInteger(attempted) || attempted < 0) {
    return 'planning attemptedDistinctTotal must be a non-negative integer';
  }
  return null;
}

/** The kinds a model draft may name; exported so the adapter and its tests share one list. */
export const PLAN_DRAFT_KINDS: readonly TrainingTaskKind[] = TRAINING_TASK_KINDS;

/** Guard used by the adapter parser: a kind that is not part of the task vocabulary is refused. */
export function isDraftTaskKind(value: unknown): value is TrainingTaskKind {
  return TRAINING_TASK_KINDS.includes(value as TrainingTaskKind);
}

/** Assert one plan draft is internally coherent; used by adapters and tests alike. */
export function assertGenerationRequest(request: PlanGenerationRequest): void {
  const problem = planningGenerationProblem(request);
  invariant(problem === null, 'invalid_input', problem ?? 'planning request is not coherent', {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
