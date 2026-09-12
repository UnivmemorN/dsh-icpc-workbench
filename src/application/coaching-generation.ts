/**
 * Coaching generation port (Stage 4s2a).
 *
 * One `generate` call is exactly one audited progressive-hint model call. The application layer
 * owns the request contract and its pure validation; the dsh adapter owns the tutor prompt and the
 * strict output parse. Nothing here reads a clock, network or environment variable, so a request
 * that fails validation is refused before any paid dispatch.
 *
 * What this module guarantees, and what it deliberately does not:
 *
 * - It guarantees request *coherence*: a known level, a full non-empty statement, a well-formed
 *   cancellation token, configured provider/model ids, bounded limits, `full` only with an explicit
 *   full-solution request, and earlier hints strictly below the requested level (at most one per
 *   level, at most {@link MAX_COACHING_PREVIOUS_HINTS} in total).
 * - It never infers semantic level discipline from an answer. "A level-1 hint must not contain an
 *   algorithm recipe" is a prompt obligation stated in the adapter's system prompt; a regex cannot
 *   enforce it, so this module does not pretend to.
 * - It never decides level progression eligibility (whether the learner has earned the next level).
 *   That is coaching-service policy for the next stage, so no fake production success is produced
 *   here.
 */
import { COACHING_LEVELS, MAX_COACHING_RESPONSE_CHARS, type CoachingLevel } from './coaching-types.js';
import type { CancellationToken, ProblemSnapshot } from '../domain/index.js';
import type { ModelCallResult } from './ports.js';

/** Prompt identity this build records for coaching calls; the service reuses it when reserving. */
export const COACHING_PROMPT_VERSION = 'coaching-v1';

/** Approved reasoning effort of every coaching call; v1 never runs a lower effort. */
export const COACHING_EFFORT = 'max';

/** At most one earlier hint per level, so a request can never replay more than the three hints. */
export const MAX_COACHING_PREVIOUS_HINTS = 3;

/** One earlier hint the learner already received; strictly below the requested level. */
export interface CoachingPreviousHint {
  readonly level: 1 | 2 | 3;
  readonly text: string;
}

/**
 * One progressive-hint request.
 *
 * `provider`, `model`, `maxOutputTokens` and `requestTimeoutMs` are configured values the calling
 * service passes explicitly (the settings module owns their defaults); the audited client
 * re-validates its own final input, context and timeout caps. `explicitFullSolution` is defence in
 * depth: a `full` request is only dispatched when the user explicitly asked for the full
 * explanation, and a hint request must keep the flag false.
 */
export interface CoachingGenerationRequest {
  readonly snapshot: ProblemSnapshot;
  readonly level: CoachingLevel;
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
  /** Hints already shown, in order; the request is refused when one is not strictly lower. */
  readonly previousHints: readonly CoachingPreviousHint[];
  readonly explicitFullSolution: boolean;
}

/** One coaching answer: plain text or Markdown, trimmed, never interpreted as HTML or code. */
export interface CoachingGenerationOutcome {
  readonly text: string;
}

/**
 * Progressive-hint model access.
 *
 * Callers own reservations, quota, retries and persistence; the generator owns one audited call
 * and its strict output contract, and never retries on its own.
 */
export interface CoachingGenerator {
  generate(request: CoachingGenerationRequest): Promise<ModelCallResult<CoachingGenerationOutcome>>;
}

/**
 * Pure pre-dispatch check of one coaching request.
 *
 * Returns `null` when the request is coherent and a short human-readable reason otherwise. The
 * reason is local diagnostic material: an adapter maps it to a typed `unsupported` refusal with
 * known-zero usage and never dispatches. The checks are exactly the request-shape guarantees in the
 * module comment, so a generator that calls this once may trust every field it then reads.
 */
export function coachingGenerationProblem(request: unknown): string | null {
  if (!isRecord(request)) {
    return 'coaching needs a generation request object';
  }
  const snapshot = request['snapshot'];
  if (!isRecord(snapshot)) {
    return 'coaching needs a problem snapshot';
  }
  const problem = snapshot['problem'];
  if (!isRecord(problem)) {
    return 'coaching needs a problem snapshot carrying its problem';
  }
  const statement = problem['statement'];
  if (typeof statement !== 'string' || statement.trim().length === 0) {
    return 'coaching needs the full non-empty problem statement at every level';
  }
  if (!Array.isArray(snapshot['sources']) || !Array.isArray(snapshot['solutions'])) {
    return 'coaching needs the snapshot editorial sources and solutions';
  }
  if (!nonEmptyText(snapshot['snapshotId'])) {
    return 'coaching needs a non-empty snapshotId';
  }

  const level = request['level'];
  if (!COACHING_LEVELS.includes(level as CoachingLevel)) {
    return `unknown coaching level ${String(level)}`;
  }

  for (const [label, value] of [
    ['provider', request['provider']],
    ['model', request['model']],
    ['attemptId', request['attemptId']],
    ['promptVersion', request['promptVersion']],
  ] as const) {
    if (!nonEmptyText(value)) {
      return `coaching ${label} must be a non-empty configured id`;
    }
  }

  const token = request['token'];
  if (!isRecord(token) || typeof token['cancelled'] !== 'boolean' || typeof token['onCancel'] !== 'function') {
    return 'coaching needs a cancellation token';
  }

  const maxOutputTokens = request['maxOutputTokens'];
  if (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    return 'coaching maxOutputTokens must be a positive integer';
  }
  const requestTimeoutMs = request['requestTimeoutMs'];
  if (typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    return 'coaching requestTimeoutMs must be a positive integer';
  }
  if (request['effort'] !== COACHING_EFFORT) {
    return `coaching effort must be '${COACHING_EFFORT}'`;
  }

  const explicitFullSolution = request['explicitFullSolution'];
  if (typeof explicitFullSolution !== 'boolean') {
    return 'coaching explicitFullSolution must be boolean';
  }
  if (level === 'full') {
    if (!explicitFullSolution) {
      return "coaching level 'full' requires explicitFullSolution true";
    }
  } else if (explicitFullSolution) {
    return `coaching level ${String(level)} must not request the full solution`;
  }

  const previousHints = request['previousHints'];
  if (!Array.isArray(previousHints)) {
    return 'coaching previousHints must be an array';
  }
  if (previousHints.length > MAX_COACHING_PREVIOUS_HINTS) {
    return `coaching accepts at most ${MAX_COACHING_PREVIOUS_HINTS} earlier hints`;
  }
  const seenLevels = new Set<number>();
  for (const hint of previousHints as readonly unknown[]) {
    if (!isRecord(hint)) {
      return 'every earlier hint must be an object with a level and text';
    }
    const hintLevel = hint['level'];
    if (hintLevel !== 1 && hintLevel !== 2 && hintLevel !== 3) {
      return `unknown earlier hint level ${String(hintLevel)}`;
    }
    if (seenLevels.has(hintLevel)) {
      return `earlier hints repeat level ${hintLevel}`;
    }
    seenLevels.add(hintLevel);
    const hintText = hint['text'];
    if (
      typeof hintText !== 'string' ||
      hintText.trim().length === 0 ||
      hintText.length > MAX_COACHING_RESPONSE_CHARS
    ) {
      return `earlier hint level ${hintLevel} text must be a non-empty string of at most ${MAX_COACHING_RESPONSE_CHARS} characters`;
    }
    if (typeof level === 'number' && hintLevel >= level) {
      return `earlier hint level ${hintLevel} is not below the requested level ${level}`;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
