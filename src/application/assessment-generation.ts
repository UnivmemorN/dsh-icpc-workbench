/**
 * AI ability-assessment generation port (Sprint 18d1).
 *
 * One `generate` call is exactly one audited assessment model call. The application layer owns the
 * request contract and its pure validation; the dsh adapter owns the assessment prompt and the
 * strict output parse. Nothing here reads a clock, a network or an environment variable, so a
 * request that fails validation is refused before any paid dispatch.
 *
 * What this module guarantees, and what it deliberately does not:
 *
 * - it guarantees request *coherence*: configured provider/model ids, bounded token and timeout
 *   budgets, the approved `max` effort, a well-formed cancellation token, a structurally re-validated
 *   identifier-free evidence payload and — when a method capture is present — an `assessment`-kind
 *   capture whose every method really carries assessment guidance;
 * - the evidence is **untrusted task data** for the prompt: the model may not invent an
 *   `evidenceRef`, an official score or a source URL. That is an instruction in the adapter's system
 *   prompt *and* a structural rule: the strict parser refuses a report that cites an unknown
 *   reference or that states a numeric range without an objective anchor;
 * - it never decides whether an assessment is acceptable. That is the parser's strict contract plus
 *   the domain's own validation, applied against the same capture.
 */
import {
  assessmentAnchorOf,
  invariant,
  validateGuidanceSnapshot,
  type AssessmentReport,
  type AssessmentReportContext,
  type CancellationToken,
  type GuidanceSnapshot,
} from '../domain/index.js';
import type { ModelCallResult } from './ports.js';
import {
  validateAssessmentModelEvidence,
  type AssessmentModelEvidence,
} from './assessment-capture.js';

/** Prompt identity this build records for assessment calls; the service reuses it when reserving. */
export const ASSESSMENT_PROMPT_VERSION = 'assessment-v1';

/** Approved reasoning effort of every assessment call; v1 never runs a lower effort. */
export const ASSESSMENT_EFFORT = 'max';

/**
 * One assessment request.
 *
 * `provider`, `model`, `maxOutputTokens` and `requestTimeoutMs` are configured values the calling
 * service passes explicitly (it reuses the stored analysis model and the global model timeout). The
 * request carries no account id, no handle and no raw evidence: `evidence` is the identifier-free
 * capture payload and `guidance` is the frozen method capture the assessment is attributed to.
 */
export interface AssessmentGenerationRequest {
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
  /** The identifier-free capture payload: the only evidence the model may reason from. */
  readonly evidence: AssessmentModelEvidence;
  /**
   * Frozen `assessment`-kind capture of the selected training methods, or omitted/`null` for the
   * unguided diagnostic baseline. The method text travels in the system prompt as trusted
   * instructional content, never inside the untrusted task JSON.
   */
  readonly guidance?: GuidanceSnapshot | null;
}

/** The strict, validated assessment answer: one bounded, labelled report. */
export interface AssessmentGenerationOutcome {
  readonly report: AssessmentReport;
}

/**
 * Ability-assessment model access.
 *
 * Callers own reservations, quota, retries and persistence; the generator owns one audited call and
 * its strict output contract, and never retries on its own.
 */
export interface AssessmentGenerator {
  generate(request: AssessmentGenerationRequest): Promise<ModelCallResult<AssessmentGenerationOutcome>>;
}

/**
 * Pure pre-dispatch check of one assessment request.
 *
 * Returns `null` when the request is coherent and a short human-readable reason otherwise. The
 * reason is local diagnostic material: an adapter maps it to a typed `unsupported` refusal with
 * known-zero usage and never dispatches. The checks are exactly the request-shape guarantees in the
 * module comment, so a generator that calls this once may trust every field it then reads.
 */
export function assessmentGenerationProblem(request: unknown): string | null {
  if (!isRecord(request)) {
    return 'assessment needs a generation request object';
  }
  for (const [label, value] of [
    ['provider', request['provider']],
    ['model', request['model']],
    ['attemptId', request['attemptId']],
    ['promptVersion', request['promptVersion']],
  ] as const) {
    if (!nonEmptyText(value)) {
      return `assessment ${label} must be a non-empty configured id`;
    }
  }
  const token = request['token'];
  if (!isRecord(token) || typeof token['cancelled'] !== 'boolean' || typeof token['onCancel'] !== 'function') {
    return 'assessment needs a cancellation token';
  }
  const maxOutputTokens = request['maxOutputTokens'];
  if (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    return 'assessment maxOutputTokens must be a positive integer';
  }
  const requestTimeoutMs = request['requestTimeoutMs'];
  if (typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    return 'assessment requestTimeoutMs must be a positive integer';
  }
  if (request['effort'] !== ASSESSMENT_EFFORT) {
    return `assessment effort must be '${ASSESSMENT_EFFORT}'`;
  }
  try {
    validateAssessmentModelEvidence(request['evidence']);
  } catch (error) {
    return `assessment evidence is not a valid capture payload: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (request['guidance'] !== undefined && request['guidance'] !== null) {
    // The capture is re-validated structurally at dispatch, and it must be an assessment-kind
    // capture whose every method actually carries assessment guidance: trusted method text, but a
    // rewritten or plan-only body must refuse the paid call instead of reaching the prompt.
    try {
      const snapshot = validateGuidanceSnapshot(request['guidance']);
      if (snapshot.kind !== 'assessment') {
        return 'assessment guidance must be an assessment-kind method capture';
      }
      for (const method of snapshot.methods) {
        if (method.assessmentGuidance === undefined) {
          return `assessment method ${method.methodId} carries no assessment guidance`;
        }
      }
    } catch (error) {
      return `assessment guidance is not a valid method capture: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

/** Assert one assessment request is coherent; used by adapters and tests alike. */
export function assertAssessmentGenerationRequest(request: AssessmentGenerationRequest): void {
  const problem = assessmentGenerationProblem(request);
  invariant(problem === null, 'invalid_input', problem ?? 'assessment request is not coherent', {});
}

/**
 * The closed citation set and anchor of one evidence payload.
 *
 * The adapter parses model output against exactly this context, so a report can only cite evidence
 * the capture published and can only estimate when the capture holds an objective anchor.
 */
export function assessmentReportContextOf(evidence: AssessmentModelEvidence): AssessmentReportContext {
  return {
    evidenceRefs: evidence.evidence.map((entry) => entry.evidenceRef),
    anchor: assessmentAnchorOf({
      officialRating: evidence.officialRating,
      virtualPerformance: evidence.virtualPerformance,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
