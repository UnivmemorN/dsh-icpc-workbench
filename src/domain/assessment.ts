/**
 * Bounded, AI-inferred ability assessment report (Sprint 18d1).
 *
 * This module is the *only* shape an assessment answer may have, and it is deliberately narrower
 * than "whatever the model returned":
 *
 * - every declared key is required and undeclared keys are refused, so a model cannot smuggle a
 *   candidate id, an `officialScore`, a URL or arbitrary extra data into a stored report;
 * - every string and every list is explicitly bounded;
 * - every `evidenceRefs` entry must exist in the captured evidence the report was produced from
 *   (the caller passes the closed reference set), so a citation cannot be invented;
 * - a non-null `estimatedRange` is refused unless the capture holds an **objective numeric
 *   anchor**: an exact official competition rating, or at least one independent, unexposed,
 *   user-entered virtual-contest run. Self-assessment (calibration) and practice AC counts are
 *   deliberately NOT anchors — they are the user's own claim or a selection of practice problems,
 *   not an externally produced number;
 * - no text field may contain a URL: this product never asks a model for sources and a fabricated
 *   link must not be storable.
 *
 * The report is always stored as {@link AssessmentReportRecord}, which labels it `ai_inferred`,
 * carries the fixed disclosure, records the anchor it was validated against and re-derives its own
 * content hash. Official rating snapshots and calibrations are never written by this path.
 *
 * Nothing here reads a clock, a store, a network or an environment variable.
 */
import { DomainError, invariant } from './errors.js';
import { contentHashOf } from './hash.js';
import { deepFreeze } from './immutable.js';
import type { CompetitionSummary } from './official-rating.js';
import type { VirtualPerformancePlanningSummary } from './virtual-performance.js';

/** Version of the report shape and its validation rules; bump when an exported meaning changes. */
export const ASSESSMENT_REPORT_VERSION = 'assessment-report.1';

/** Longest accepted `summary`. */
export const MAX_ASSESSMENT_SUMMARY_CHARS = 2000;
/** Longest accepted one reason / uncertainty / bottleneck / readiness / next-step sentence. */
export const MAX_ASSESSMENT_ITEM_CHARS = 400;
/** Count bounds of the report's lists. */
export const MAX_ASSESSMENT_CONFIDENCE_REASONS = 6;
export const MAX_ASSESSMENT_AXIS_UNCERTAINTIES = 6;
export const MAX_ASSESSMENT_EVIDENCE_REFS = 12;
export const MAX_ASSESSMENT_NEXT_STEPS = 8;

/** Documented inclusive bounds of an AI `estimatedRange`; a value outside it is a defect. */
export const ASSESSMENT_ESTIMATE_MIN = -1000;
export const ASSESSMENT_ESTIMATE_MAX = 5000;

export const ASSESSMENT_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type AssessmentConfidence = (typeof ASSESSMENT_CONFIDENCES)[number];

/** Which training axis currently blocks the other; `diagnostic` means the evidence cannot tell. */
export const ASSESSMENT_PRIORITIES = ['thinking', 'templates', 'balanced', 'diagnostic'] as const;
export type AssessmentPriority = (typeof ASSESSMENT_PRIORITIES)[number];

/** What allowed a numeric estimate at all; see {@link assessmentAnchorOf}. */
export const ASSESSMENT_ANCHOR_KINDS = ['official_rating', 'virtual_performance', 'none'] as const;
export type AssessmentAnchorKind = (typeof ASSESSMENT_ANCHOR_KINDS)[number];

/**
 * Fixed disclosure that travels with every stored report.
 *
 * It is part of the record, not of the model's answer: the label is the host's statement about the
 * value it stores, and a model can neither weaken nor omit it.
 */
export const ASSESSMENT_AI_DISCLOSURE =
  '本评估由 AI 依据已采集的证据推断，不是官方评分，也不会覆盖或改写官方 rating 与用户自评；estimatedRange 只是一个 AI 推断区间，confidence 只表示该推断的可靠程度。';

/** One inclusive AI-inferred rating range. */
export interface AssessmentRatingRange {
  readonly min: number;
  readonly max: number;
}

/** One training axis as the assessment sees it: a bounded judgement plus its citations. */
export interface AssessmentAxisAssessment {
  readonly assessment: string;
  readonly evidenceRefs: readonly string[];
  readonly uncertainties: readonly string[];
}

/**
 * The strict, validated assessment answer.
 *
 * Exactly the eleven declared keys, all present. `estimatedRange` is `null` whenever the capture
 * held no objective anchor, or when the model honestly declines to estimate.
 */
export interface AssessmentReport {
  readonly summary: string;
  readonly estimatedRange: AssessmentRatingRange | null;
  readonly confidence: AssessmentConfidence;
  readonly confidenceReasons: readonly string[];
  readonly confidenceEvidenceRefs: readonly string[];
  readonly thinking: AssessmentAxisAssessment;
  readonly templates: AssessmentAxisAssessment;
  readonly priority: AssessmentPriority;
  readonly bottleneckReason: string;
  readonly readinessCheck: string;
  readonly nextSteps: readonly string[];
}

/** Facts that decide whether a numeric estimate is allowed at all. */
export interface AssessmentAnchorFacts {
  readonly kind: AssessmentAnchorKind;
  /** Exact official competition rating of the anchor, or `null`. Never inferred from practice. */
  readonly officialRating: number | null;
  /** Independent, unexposed virtual-contest runs available as an anchor (`0` when none). */
  readonly eligibleVirtualRuns: number;
}

/**
 * Derive the objective numeric anchor of one capture.
 *
 * `official_rating` wins: an exact, externally produced competition rating is the strongest anchor
 * and is used as-is (never blended, never rounded). Otherwise at least one eligible virtual-contest
 * run — independent **and** without prior exposure (the 18c rule) — is an anchor. Everything else,
 * including a self-reported calibration range and any number of accepted practice problems, is not.
 */
export function assessmentAnchorOf(input: {
  readonly officialRating: CompetitionSummary;
  readonly virtualPerformance?: VirtualPerformancePlanningSummary | null;
}): AssessmentAnchorFacts {
  const virtual = input.virtualPerformance ?? null;
  const eligibleVirtualRuns = virtual === null ? 0 : virtual.counts.eligibleIndependent;
  if (input.officialRating.status === 'rated' && typeof input.officialRating.rating === 'number') {
    return deepFreeze({ kind: 'official_rating', officialRating: input.officialRating.rating, eligibleVirtualRuns });
  }
  if (eligibleVirtualRuns > 0) {
    return deepFreeze({ kind: 'virtual_performance', officialRating: null, eligibleVirtualRuns });
  }
  return deepFreeze({ kind: 'none', officialRating: null, eligibleVirtualRuns: 0 });
}

/** The closed evidence set one report may cite, plus the anchor it must respect. */
export interface AssessmentReportContext {
  /** Every evidence reference the captured material published; a citation outside it is refused. */
  readonly evidenceRefs: readonly string[];
  readonly anchor: AssessmentAnchorFacts;
}

/**
 * One stored report: the validated answer plus the host's own statement about it.
 *
 * `anchor` and `evidenceHash` record what the report was validated against, so a reader can prove
 * the label was derived from the same capture, and `reportHash` re-derives from the answer itself.
 */
export interface AssessmentReportRecord {
  readonly report: AssessmentReport;
  /** Fixed literal: this report is a model inference, never an official record. */
  readonly source: 'ai_inferred';
  /** Fixed literal {@link ASSESSMENT_AI_DISCLOSURE}. */
  readonly disclosure: string;
  readonly anchor: AssessmentAnchorKind;
  /** `evidenceHash` of the capture the report was validated against. */
  readonly evidenceHash: string;
  /** Full sha256 content hash of `report`. */
  readonly reportHash: string;
}

const REPORT_KEYS = [
  'summary',
  'estimatedRange',
  'confidence',
  'confidenceReasons',
  'confidenceEvidenceRefs',
  'thinking',
  'templates',
  'priority',
  'bottleneckReason',
  'readinessCheck',
  'nextSteps',
] as const;

const AXIS_KEYS = ['assessment', 'evidenceRefs', 'uncertainties'] as const;
const RANGE_KEYS = ['min', 'max'] as const;
const RECORD_KEYS = ['report', 'source', 'disclosure', 'anchor', 'evidenceHash', 'reportHash'] as const;

const SHA256 = /^[0-9a-f]{64}$/u;
/** Control characters that never belong in report text (newlines and tabs stay valid). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
/** A URL anywhere in report text means a fabricated source; this product asks for none. */
const URL_TEXT = /https?:\/\//iu;

/**
 * Pure pre-dispatch / pre-storage check of one assessment answer.
 *
 * Returns `null` when the answer is a valid report and a short human-readable reason otherwise. The
 * reason is stable diagnostic material: the generator maps it to a typed `invalid_output` refusal
 * with the usage the provider already reported, and the store maps it to `corrupt_row` on read.
 */
export function assessmentReportProblem(value: unknown, context: AssessmentReportContext): string | null {
  try {
    parseAssessmentReport(value, context);
    return null;
  } catch (error) {
    if (error instanceof DomainError) {
      // The stable reason code leads the diagnostic string the generator and the store surface, so a
      // refusal can be asserted and logged without parsing prose.
      const reason = (error.details as { readonly reason?: unknown }).reason;
      if (typeof reason === 'string' && reason.length > 0) {
        return `${reason}: ${error.message}`;
      }
    }
    return error instanceof Error ? error.message : String(error);
  }
}

/** Strictly validate one assessment answer and return a detached, frozen copy. */
export function validateAssessmentReport(value: unknown, context: AssessmentReportContext): AssessmentReport {
  return parseAssessmentReport(value, context);
}

/** Attach the host's own label, anchor and hashes to one validated answer. */
export function createAssessmentReportRecord(input: {
  readonly report: unknown;
  readonly context: AssessmentReportContext;
  readonly evidenceHash: string;
}): AssessmentReportRecord {
  const report = parseAssessmentReport(input.report, input.context);
  invariant(
    typeof input.evidenceHash === 'string' && SHA256.test(input.evidenceHash),
    'invalid_input',
    'assessment report evidenceHash must be a sha256 digest',
    { evidenceHash: input.evidenceHash },
  );
  return deepFreeze({
    report,
    source: 'ai_inferred' as const,
    disclosure: ASSESSMENT_AI_DISCLOSURE,
    anchor: input.context.anchor.kind,
    evidenceHash: input.evidenceHash,
    reportHash: contentHashOf(report),
  });
}

/**
 * Strictly validate one stored report record against the capture it belongs to.
 *
 * The stored answer is re-parsed against the closed citation set and the anchor facts, so a
 * hand-edited record — an invented reference, a range without an anchor, a rewritten label — is
 * refused instead of being served as the report the host once validated.
 */
export function validateAssessmentReportRecord(
  value: unknown,
  context: AssessmentReportContext,
): AssessmentReportRecord {
  const record = requireObject('assessment report record', value);
  requireExactKeys('assessment report record', record, RECORD_KEYS);
  invariant(
    record['source'] === 'ai_inferred',
    'invalid_input',
    'assessment report record must be labelled ai_inferred',
    { source: record['source'] },
  );
  invariant(
    record['disclosure'] === ASSESSMENT_AI_DISCLOSURE,
    'invalid_input',
    'assessment report record does not carry the documented AI-inference disclosure',
    { reason: 'disclosure_missing' },
  );
  const anchor = record['anchor'];
  invariant(
    ASSESSMENT_ANCHOR_KINDS.includes(anchor as AssessmentAnchorKind),
    'invalid_input',
    `unknown assessment anchor kind ${String(anchor)}`,
    { anchor },
  );
  invariant(
    anchor === context.anchor.kind,
    'invalid_input',
    `assessment report record claims anchor ${String(anchor)}, but its capture allows ${context.anchor.kind}`,
    { reason: 'anchor_mismatch', anchor, expected: context.anchor.kind },
  );
  const evidenceHash = record['evidenceHash'];
  invariant(
    typeof evidenceHash === 'string' && SHA256.test(evidenceHash),
    'invalid_input',
    'assessment report record evidenceHash must be a sha256 digest',
    { evidenceHash },
  );
  // The stored answer is re-parsed against its own citation set, so a rewritten record is refused
  // instead of being served as the report the host once validated.
  const report = parseAssessmentReport(record['report'], context);
  const declared = record['reportHash'];
  const derived = contentHashOf(report);
  invariant(
    typeof declared === 'string' && declared === derived,
    'invalid_input',
    'assessment report record hash does not match its own content',
    { reason: 'report_hash_mismatch', declared, derived },
  );
  return deepFreeze({
    report,
    source: 'ai_inferred' as const,
    disclosure: ASSESSMENT_AI_DISCLOSURE,
    anchor: anchor as AssessmentAnchorKind,
    evidenceHash,
    reportHash: derived,
  });
}

// ---------------------------------------------------------------------------------------
// Strict parsing
// ---------------------------------------------------------------------------------------

function parseAssessmentReport(value: unknown, context: AssessmentReportContext): AssessmentReport {
  const record = requireObject('assessment report', value);
  requireExactKeys('assessment report', record, REPORT_KEYS);
  const refs = new Set(context.evidenceRefs);
  const summary = requireText('assessment report summary', record['summary'], MAX_ASSESSMENT_SUMMARY_CHARS);
  const estimatedRange = parseRange(record['estimatedRange'], context.anchor);
  const confidence = requireEnum('assessment report confidence', record['confidence'], ASSESSMENT_CONFIDENCES);
  const confidenceReasons = requireTextList(
    'assessment report confidenceReasons',
    record['confidenceReasons'],
    MAX_ASSESSMENT_CONFIDENCE_REASONS,
    1,
  );
  const confidenceEvidenceRefs = requireRefs(
    'assessment report confidenceEvidenceRefs',
    record['confidenceEvidenceRefs'],
    refs,
    0,
  );
  const thinking = parseAxis('assessment report thinking', record['thinking'], refs);
  const templates = parseAxis('assessment report templates', record['templates'], refs);
  const priority = requireEnum('assessment report priority', record['priority'], ASSESSMENT_PRIORITIES);
  const bottleneckReason = requireText(
    'assessment report bottleneckReason',
    record['bottleneckReason'],
    MAX_ASSESSMENT_ITEM_CHARS,
  );
  const readinessCheck = requireText(
    'assessment report readinessCheck',
    record['readinessCheck'],
    MAX_ASSESSMENT_ITEM_CHARS,
  );
  const nextSteps = requireTextList(
    'assessment report nextSteps',
    record['nextSteps'],
    MAX_ASSESSMENT_NEXT_STEPS,
    0,
  );
  return deepFreeze({
    summary,
    estimatedRange,
    confidence,
    confidenceReasons,
    confidenceEvidenceRefs,
    thinking,
    templates,
    priority,
    bottleneckReason,
    readinessCheck,
    nextSteps,
  });
}

function parseRange(value: unknown, anchor: AssessmentAnchorFacts): AssessmentRatingRange | null {
  if (value === null) {
    return null;
  }
  const record = requireObject('assessment report estimatedRange', value);
  requireExactKeys('assessment report estimatedRange', record, RANGE_KEYS);
  for (const key of RANGE_KEYS) {
    const bound = record[key];
    invariant(
      typeof bound === 'number' &&
        Number.isSafeInteger(bound) &&
        bound >= ASSESSMENT_ESTIMATE_MIN &&
        bound <= ASSESSMENT_ESTIMATE_MAX,
      'invalid_input',
      `assessment report estimatedRange.${key} must be an integer within ${ASSESSMENT_ESTIMATE_MIN}..${ASSESSMENT_ESTIMATE_MAX}`,
      { reason: 'range_out_of_bounds', bound },
    );
  }
  const min = record['min'] as number;
  const max = record['max'] as number;
  invariant(
    min <= max,
    'invalid_input',
    'assessment report estimatedRange.min must not exceed max',
    { reason: 'range_inverted', min, max },
  );
  // No objective anchor (exact official rating or independent unexposed virtual run) means no
  // numeric estimate at all: a self-assessment range or practice AC counts are not anchors.
  invariant(
    anchor.kind !== 'none',
    'invalid_input',
    'assessment report estimatedRange is not allowed without an official rating or independent unexposed virtual performance anchor',
    { reason: 'no_numeric_anchor', kind: anchor.kind },
  );
  return deepFreeze({ min, max });
}

function parseAxis(label: string, value: unknown, refs: ReadonlySet<string>): AssessmentAxisAssessment {
  const record = requireObject(label, value);
  requireExactKeys(label, record, AXIS_KEYS);
  return deepFreeze({
    assessment: requireText(`${label} assessment`, record['assessment'], MAX_ASSESSMENT_ITEM_CHARS),
    evidenceRefs: requireRefs(`${label} evidenceRefs`, record['evidenceRefs'], refs, 0),
    uncertainties: requireTextList(
      `${label} uncertainties`,
      record['uncertainties'],
      MAX_ASSESSMENT_AXIS_UNCERTAINTIES,
      0,
    ),
  });
}

/** A non-empty bounded string with no control characters and no fabricated URL. */
function requireText(label: string, value: unknown, bound: number): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} must be a non-empty string`,
    { reason: 'invalid_text', label },
  );
  const text = (value as string).trim();
  invariant(text.length <= bound, 'invalid_input', `${label} is ${text.length} characters, above ${bound}`, {
    reason: 'text_too_long',
    label,
    bound,
  });
  invariant(!CONTROL_CHARS.test(text), 'invalid_input', `${label} contains control characters`, {
    reason: 'invalid_text',
    label,
  });
  invariant(!URL_TEXT.test(text), 'invalid_input', `${label} must not contain a URL`, {
    reason: 'url_in_report',
    label,
  });
  return text;
}

function requireTextList(
  label: string,
  value: unknown,
  bound: number,
  minimum: number,
): readonly string[] {
  invariant(Array.isArray(value), 'invalid_input', `${label} must be an array`, {
    reason: 'invalid_shape',
    label,
  });
  invariant(
    value.length >= minimum,
    'invalid_input',
    `${label} must hold at least ${minimum} entries`,
    { reason: 'invalid_shape', label, length: value.length },
  );
  invariant(value.length <= bound, 'invalid_input', `${label} holds at most ${bound} entries`, {
    reason: 'too_many_entries',
    label,
    length: value.length,
    bound,
  });
  return value.map((entry, index) => requireText(`${label}[${index}]`, entry, MAX_ASSESSMENT_ITEM_CHARS));
}

/** Bounded, unique citations, each of which must exist in the captured evidence. */
function requireRefs(label: string, value: unknown, refs: ReadonlySet<string>, minimum: number): readonly string[] {
  invariant(Array.isArray(value), 'invalid_input', `${label} must be an array`, {
    reason: 'invalid_shape',
    label,
  });
  invariant(value.length >= minimum, 'invalid_input', `${label} must hold at least ${minimum} entries`, {
    reason: 'invalid_shape',
    label,
  });
  invariant(value.length <= MAX_ASSESSMENT_EVIDENCE_REFS, 'invalid_input', `${label} holds at most ${MAX_ASSESSMENT_EVIDENCE_REFS} entries`, {
    reason: 'too_many_entries',
    label,
    length: value.length,
    bound: MAX_ASSESSMENT_EVIDENCE_REFS,
  });
  const seen = new Set<string>();
  return value.map((entry) => {
    const ref = requireText(`${label} entry`, entry, 120);
    invariant(!seen.has(ref), 'invalid_input', `${label} repeats reference ${ref}`, {
      reason: 'duplicate_evidence_ref',
      ref,
    });
    seen.add(ref);
    invariant(refs.has(ref), 'invalid_input', `${label} cites unknown evidence reference ${ref}`, {
      reason: 'unknown_evidence_ref',
      ref,
    });
    return ref;
  });
}

// ---------------------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function requireObject(label: string, value: unknown): JsonObject {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `${label} must be a JSON object`,
    { reason: 'invalid_shape', label },
  );
  return value as JsonObject;
}

/**
 * Strict shape check: an undeclared key, a missing declared key and a declared key explicitly set to
 * `undefined` are all rejected. `undefined` is not a JSON value, so a member carrying it is treated
 * as absent instead of being handed to the field check as "present but not a value".
 */
function requireExactKeys(label: string, value: JsonObject, keys: readonly string[]): void {
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  invariant(unknownKeys.length === 0, 'invalid_input', `${label} has unknown keys: ${unknownKeys.join(', ')}`, {
    reason: 'unknown_key',
    label,
    unknownKeys,
  });
  const missing = keys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined,
  );
  invariant(missing.length === 0, 'invalid_input', `${label} is missing keys: ${missing.join(', ')}`, {
    reason: 'missing_key',
    label,
    missing,
  });
}

function requireEnum<T extends string>(label: string, value: unknown, allowed: readonly T[]): T {
  invariant(
    typeof value === 'string' && (allowed as readonly string[]).includes(value),
    'invalid_input',
    `unknown ${label} ${String(value)}`,
    { reason: 'invalid_shape', label, value },
  );
  return value as T;
}

/** Typed refusal of a caller contract violation, raised instead of a silently different report. */
export function assessmentConflict(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError('invalid_input', message, { reason: 'assessment_conflict', ...details });
}
