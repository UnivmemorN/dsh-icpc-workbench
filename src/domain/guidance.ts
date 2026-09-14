/**
 * Detachable training-method guidance (Sprint 18b).
 *
 * A **method** is an *instructional* document a user can install as a separate companion package: a
 * named dual-axis training philosophy, plus the plan/assessment checklists that go with it. A method
 * is not a model role, not a stored plan setting and not an executable hook: it is bounded trusted
 * text plus public source links, and this module is the pure vocabulary the whole feature shares —
 * validation, the public registration shape and the **immutable capture** that binds one training
 * plan to exactly the method text it was generated from.
 *
 * Three rules shape everything here:
 *
 * - **Bounded and inert.** Every string is length-bounded and every list is count-bounded, so a
 *   companion package cannot flood a prompt or a stored row. A source link must be a public
 *   `http(s)` URL with no userinfo; a fragment or an explicit port is harmless in an inert
 *   citation. Nothing here fetches anything, and a method can never run code or carry a credential.
 * - **Immutable capture.** A stored plan/history row never points at "the current method". It stores
 *   {@link GuidanceMethodSnapshot}s — id, version, hash and the exact text — so uninstalling or
 *   upgrading a companion package leaves every earlier plan readable and byte-identical.
 * - **Advisory text, fixed policy.** Method text is *selected trusted instructional content*. It may
 *   shape training philosophy; it may not override the host's fixed model output contract, usage
 *   accounting, privacy rules or the requirement that unrevealed UI carries no solution hints.
 *
 * Nothing in this module reads a clock, a file, a network or an environment variable.
 */
import { DomainError, invariant } from './errors.js';
import { contentHashOf } from './hash.js';
import { deepFreeze } from './immutable.js';

// ---------------------------------------------------------------------------------------
// Version and bounds
// ---------------------------------------------------------------------------------------

/**
 * Version of the public companion seam (`ctx.icpcGuidance`).
 *
 * A companion package declares the seam version it was written against. The host refuses a method
 * whose seam version it does not implement, so a host upgrade can never silently reinterpret an
 * installed method, and a new companion fails loudly against an old host.
 */
export const GUIDANCE_SEAM_VERSION = 'icpc-guidance-v1';

/** Versions of {@link GUIDANCE_SEAM_VERSION} this build implements; a method must name one. */
export const SUPPORTED_GUIDANCE_SEAM_VERSIONS: readonly string[] = [GUIDANCE_SEAM_VERSION];

/** Which document of a method the caller is about to use. */
export const GUIDANCE_KINDS = ['plan', 'assessment'] as const;
export type GuidanceKind = (typeof GUIDANCE_KINDS)[number];

/** Largest accepted method id, version and display-name length. */
export const MAX_GUIDANCE_ID_CHARS = 80;
export const MAX_GUIDANCE_NAME_CHARS = 80;
/** Largest accepted instruction section / training-step text. */
export const MAX_GUIDANCE_TEXT_CHARS = 4000;
/** Largest accepted one-line reason, readiness check or objective. */
export const MAX_GUIDANCE_SHORT_CHARS = 400;
/** Count bounds: sections and steps per kind, sources, capabilities and selections. */
export const MAX_GUIDANCE_SECTIONS = 12;
export const MAX_GUIDANCE_SOURCES = 8;
export const MAX_GUIDANCE_CAPABILITIES = 12;
export const MAX_GUIDANCE_SELECTION = 4;

/** Longest accepted source title, and the only licences a declared source may carry. */
export const MAX_GUIDANCE_SOURCE_TITLE_CHARS = 160;

/**
 * The two training axes a method and a plan diagnose.
 *
 * They are deliberately **not** alternatives: the approved user direction is that thinking
 * (modelling and proofs) and templates (algorithms and implementation) support each other, so a
 * diagnosis names which one is currently the bottleneck, and a plan trains both.
 */
export const GUIDANCE_AXES = ['thinking', 'templates'] as const;
export type GuidanceAxis = (typeof GUIDANCE_AXES)[number];

/**
 * Diagnosis of the prerequisite bottleneck.
 *
 * `thinking`/`templates` name the axis that currently blocks the other; `balanced` means neither
 * blocks the other and both are reinforced; `diagnostic` is the honest answer when the available
 * evidence is insufficient to name a bottleneck at all.
 */
export const GUIDANCE_DIAGNOSIS_PRIORITIES = ['thinking', 'templates', 'balanced', 'diagnostic'] as const;
export type GuidanceDiagnosisPriority = (typeof GUIDANCE_DIAGNOSIS_PRIORITIES)[number];

/** How confident a diagnosis is; two honest levels, never a fabricated numeric score. */
export const GUIDANCE_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type GuidanceConfidence = (typeof GUIDANCE_CONFIDENCES)[number];

/**
 * Documented kind-independent "no method text was involved" hash.
 *
 * A stored row that predates this feature has no guidance field at all and keeps its own
 * `evidenceHash` byte-for-byte, so an absence is never re-hashed into this value. A *kind-specific*
 * empty capture hashes as `guidanceSnapshotHash(kind, [])` instead, which is a different, equally
 * stable value; this constant is the marker a caller stores or compares when it has no capture.
 */
export const EMPTY_GUIDANCE_HASH = contentHashOf({ methods: [], kind: 'none' });

// ---------------------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------------------

/** One public reference a method paraphrases or points at. Never fetched, never a credential. */
export interface GuidanceSource {
  readonly title: string;
  readonly url: string;
  /** Optional `SPDX`-style licence id of the referenced work, e.g. `CC BY-SA 4.0`. */
  readonly license: string | null;
}

/**
 * Capabilities a method says it supports.
 *
 * These are **declarations, not hooks**: nothing here is executed, and the host never dispatches
 * through them. They exist so the catalogue can show what a method is for, and so a caller that
 * needs plan guidance can tell a planning method from an assessment-only one.
 */
export interface GuidanceMethodCapabilities {
  readonly plan: boolean;
  readonly assessment: boolean;
}

/** One titled instructional section of a method document. */
export interface GuidanceInstructiveSection {
  readonly title: string;
  readonly text: string;
}

/** The plan checklist(s) and training steps of one method. */
export interface GuidancePlanGuidance {
  readonly summary: string;
  readonly sections: readonly GuidanceInstructiveSection[];
  /** The ordered axis discipline the plan prompt must follow. */
  readonly trainingSteps: readonly string[];
}

/** The self-assessment checklist of one method, used when a caller asks how to judge work. */
export interface GuidanceAssessmentGuidance {
  readonly summary: string;
  readonly sections: readonly GuidanceInstructiveSection[];
}

/**
 * One method as its companion package declares it.
 *
 * This is the **public companion seam**: a package built outside this repository constructs this
 * plain object and hands it to `ctx.icpcGuidance.register(...)`. It contains data only, so a
 * companion never needs a host type, a host build step or a harness checkout.
 */
export interface GuidanceMethodDefinition {
  /** Stable id, e.g. `balanced-dual-axis`; unique across every installed method. */
  readonly methodId: string;
  /** Method revision, e.g. `1.0.0`. A new revision is a new capture, never a silent edit. */
  readonly version: string;
  /** Seam version this method was written against; see {@link GUIDANCE_SEAM_VERSION}. */
  readonly seamVersion: string;
  readonly name: string;
  /** One-line statement of the method's stance, shown in the catalogue. */
  readonly summary: string;
  /** What the method claims it can guide; at least one of the two must be `true`. */
  readonly capabilities: GuidanceMethodCapabilities;
  readonly planGuidance: GuidancePlanGuidance;
  /** `null` when the method offers no assessment checklist at all. */
  readonly assessmentGuidance: GuidanceAssessmentGuidance | null;
  readonly sources: readonly GuidanceSource[];
}

/**
 * The registration shape a companion package passes to `ctx.icpcGuidance.register`.
 *
 * It is structurally the definition plus two declarations the host must be able to check before it
 * accepts the method: the seam version it targets and whether the text is the package author's own
 * original summary. `originalText` is a claim the host records and reports, not a verification.
 */
export interface GuidanceMethodRegistration extends GuidanceMethodDefinition {
  readonly kind: GuidanceKind[];
}

// ---------------------------------------------------------------------------------------
// Immutable capture
// ---------------------------------------------------------------------------------------

/** One source as captured, with the hash that fixes the exact link a plan was generated from. */
export interface GuidanceSourceSnapshot extends GuidanceSource {
  /** `sha256` of the canonical `{title,url,license}` triple. */
  readonly sourceHash: string;
}

/**
 * One method exactly as it was at capture time.
 *
 * The text travels **inside** the stored row on purpose: a plan must stay readable and provably
 * unchanged after the companion package that produced it was upgraded or uninstalled, and a hash
 * alone could not prove *what* the model was shown.
 */
export interface GuidanceMethodSnapshot {
  readonly methodId: string;
  readonly version: string;
  readonly seamVersion: string;
  readonly name: string;
  readonly summary: string;
  /** Documented hash of {@link GuidanceMethodDefinition} content; see {@link guidanceMethodHash}. */
  readonly methodHash: string;
  readonly capabilities: GuidanceMethodCapabilities;
  readonly planGuidance: GuidancePlanGuidance;
  /** Absent (not `null`) when the method carries no assessment guidance, so old rows stay small. */
  readonly assessmentGuidance?: GuidanceAssessmentGuidance;
  readonly sources: readonly GuidanceSourceSnapshot[];
  /** Fixed advisory-scope statement; see {@link GUIDANCE_ACTIVATION_SCOPE}. */
  readonly activationScope: string;
}

/**
 * The frozen selection one plan/assessment attempt was prepared under.
 *
 * `selectedMethodIds` is the caller's explicit ordered selection — `[]` means "no method, free
 * baseline plan" and is a real, honest choice, never a silent substitution.
 */
export interface GuidanceSnapshot {
  readonly kind: GuidanceKind;
  readonly selectedMethodIds: readonly string[];
  readonly methods: readonly GuidanceMethodSnapshot[];
  /** Hash over `{kind, methods}`; see {@link guidanceSnapshotHash}. */
  readonly hash: string;
}

/**
 * Fixed statement of what method text may and may not do.
 *
 * It travels with every capture so a later reader can prove the boundary was stated, not merely
 * assumed: the text is selected trusted instructional content, and it can never override the host's
 * fixed model output contract, usage accounting, privacy rules or unrevealed-content policy.
 */
export const GUIDANCE_ACTIVATION_SCOPE =
  '方法文本是用户显式选择的、受信任的教学内容：它只影响训练理念（诊断瓶颈、双轴安排、练习节奏）。它不能覆盖固定的模型输出契约、用量与配额记账、隐私边界，也不能让未揭示的界面出现解法级提示或题库外题目。';

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

const METHOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION = /^[0-9]+(?:\.[0-9]+)*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
/** Control characters that never belong in instructional text (newlines and tabs are allowed). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** One validation failure of a companion-supplied method; the reason is stable for tests and UI. */
export class GuidanceMethodError extends DomainError {
  /** Stable refusal reason; also carried in `details.reason` for generic error handling. */
  readonly reason: GuidanceMethodErrorCode;

  constructor(code: GuidanceMethodErrorCode, message: string, details: Record<string, unknown> = {}) {
    super('invalid_input', message, { reason: code, ...details });
    this.name = 'GuidanceMethodError';
    this.reason = code;
  }
}

export type GuidanceMethodErrorCode =
  | 'invalid_shape'
  | 'invalid_id'
  | 'invalid_version'
  | 'unsupported_seam'
  | 'invalid_text'
  | 'text_too_long'
  | 'too_many_sections'
  | 'too_many_sources'
  | 'too_many_capabilities'
  | 'invalid_url'
  | 'invalid_license'
  | 'no_capability'
  | 'duplicate_id'
  | 'too_many_methods'
  | 'unknown_method'
  | 'selection_too_long'
  | 'duplicate_selection';

/**
 * Validate one companion-supplied method and return a detached, deeply frozen copy.
 *
 * Every declared field is required and must be bounded; unknown keys are rejected so a companion
 * cannot smuggle extra state into the capture, and an undeclared `undefined` member is refused
 * instead of being dropped silently. The returned value is frozen, so the host never shares mutable
 * structure with a plugin that may later be unloaded.
 */
export function validateGuidanceMethodDefinition(value: unknown): GuidanceMethodDefinition {
  const record = requireObject('guidance method', value);
  requireExactKeys('guidance method', record, [
    'methodId',
    'version',
    'seamVersion',
    'name',
    'summary',
    'capabilities',
    'planGuidance',
    'assessmentGuidance',
    'sources',
  ]);

  const methodId = requirePattern('guidance method methodId', record['methodId'], METHOD_ID, MAX_GUIDANCE_ID_CHARS);
  const version = requirePattern('guidance method version', record['version'], VERSION, MAX_GUIDANCE_ID_CHARS);
  const seamVersion = requireText('guidance method seamVersion', record['seamVersion'], MAX_GUIDANCE_ID_CHARS);
  invariant(
    SUPPORTED_GUIDANCE_SEAM_VERSIONS.includes(seamVersion),
    'invalid_input',
    `guidance method ${methodId} targets unsupported seam ${seamVersion}; this build implements ${SUPPORTED_GUIDANCE_SEAM_VERSIONS.join(', ')}`,
    { reason: 'unsupported_seam', methodId, seamVersion },
  );
  const name = requireText('guidance method name', record['name'], MAX_GUIDANCE_NAME_CHARS);
  const summary = requireText('guidance method summary', record['summary'], MAX_GUIDANCE_SHORT_CHARS);

  const capabilities = requireCapabilities(methodId, record['capabilities']);
  const planGuidance = requirePlanGuidance(methodId, record['planGuidance']);
  const assessmentGuidance =
    record['assessmentGuidance'] === null ? null : requireAssessmentGuidance(methodId, record['assessmentGuidance']);
  invariant(
    !(capabilities.assessment && assessmentGuidance === null),
    'invalid_input',
    `guidance method ${methodId} declares assessment capability without assessment guidance`,
    { reason: 'invalid_shape', methodId, capability: 'assessment' },
  );
  const sources = requireSources(methodId, record['sources']);

  return deepFreeze({
    methodId,
    version,
    seamVersion,
    name,
    summary,
    capabilities,
    planGuidance,
    assessmentGuidance,
    sources,
  });
}

/**
 * Validate a registration (definition + declared kinds) and return the frozen definition.
 *
 * The declared kinds must be exactly the capabilities the definition advertises, so a method cannot
 * claim an assessment checklist in the catalogue and then be unavailable to the assessment path.
 */
export function validateGuidanceMethodRegistration(value: unknown): GuidanceMethodDefinition {
  const record = requireObject('guidance method registration', value);
  requireExactKeys('guidance method registration', record, [
    'methodId',
    'version',
    'seamVersion',
    'name',
    'summary',
    'capabilities',
    'planGuidance',
    'assessmentGuidance',
    'sources',
    'kind',
  ]);
  const definition = validateGuidanceMethodDefinition(
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'kind')),
  );
  const rawKinds = record['kind'];
  invariant(Array.isArray(rawKinds), 'invalid_input', 'guidance method kind must be an array', {
    reason: 'invalid_shape',
    methodId: definition.methodId,
  });
  const kinds = rawKinds.map((entry) => requireEnum('guidance method kind', entry, GUIDANCE_KINDS));
  invariant(
    new Set(kinds).size === kinds.length,
    'invalid_input',
    `guidance method ${definition.methodId} repeats a kind`,
    { reason: 'invalid_shape', methodId: definition.methodId },
  );
  const claimedPlan = kinds.includes('plan');
  const claimedAssessment = kinds.includes('assessment');
  invariant(
    claimedPlan === definition.capabilities.plan && claimedAssessment === definition.capabilities.assessment,
    'invalid_input',
    `guidance method ${definition.methodId} kind does not match its declared capabilities`,
    { reason: 'invalid_shape', methodId: definition.methodId, kinds },
  );
  return definition;
}

/**
 * Documented hash of one method's content.
 *
 * It covers the *instructive* content, the declared capabilities and the sources, and deliberately
 * excludes the seam version: a seam bump for the same text is not a new method revision.
 */
export function guidanceMethodHash(definition: GuidanceMethodDefinition): string {
  return contentHashOf({
    methodId: definition.methodId,
    version: definition.version,
    name: definition.name,
    summary: definition.summary,
    capabilities: definition.capabilities,
    planGuidance: definition.planGuidance,
    assessmentGuidance: definition.assessmentGuidance,
    sources: definition.sources,
  });
}

/** Documented hash of one captured source triple. */
export function guidanceSourceHash(source: GuidanceSource): string {
  return contentHashOf({ title: source.title, url: source.url, license: source.license });
}

/**
 * Freeze installed definitions into the immutable capture a plan is bound to.
 *
 * The order of `definitions` is the caller's selection order and is preserved, because a method's
 * own training steps are ordered. An empty list is valid and captures the free baseline: see
 * {@link EMPTY_GUIDANCE_HASH}.
 */
export function captureGuidanceSnapshot(
  kind: GuidanceKind,
  definitions: readonly GuidanceMethodDefinition[],
): GuidanceSnapshot {
  invariant(GUIDANCE_KINDS.includes(kind), 'invalid_input', `unknown guidance kind ${String(kind)}`, { kind });
  invariant(
    definitions.length <= MAX_GUIDANCE_SELECTION,
    'invalid_input',
    `a guidance selection holds at most ${MAX_GUIDANCE_SELECTION} methods`,
    { reason: 'selection_too_long', length: definitions.length },
  );
  const methods = definitions.map((entry) => snapshotOf(entry));
  const seen = new Set<string>();
  for (const method of methods) {
    invariant(!seen.has(method.methodId), 'invalid_input', `guidance selection repeats method ${method.methodId}`, {
      reason: 'duplicate_selection',
      methodId: method.methodId,
    });
    seen.add(method.methodId);
  }
  const selectedMethodIds = methods.map((method) => method.methodId);
  return deepFreeze({ kind, selectedMethodIds, methods, hash: guidanceSnapshotHash(kind, methods) });
}

/** Hash over one capture. It is the value folded into a plan's evidence hash. */
export function guidanceSnapshotHash(kind: GuidanceKind, methods: readonly GuidanceMethodSnapshot[]): string {
  return contentHashOf({ kind, methods });
}

/** One frozen single-method snapshot, used by the capture above. */
export function snapshotOf(definition: GuidanceMethodDefinition): GuidanceMethodSnapshot {
  const validated = validateGuidanceMethodDefinition(definition);
  const sources = validated.sources.map((source) => ({ ...source, sourceHash: guidanceSourceHash(source) }));
  return deepFreeze({
    methodId: validated.methodId,
    version: validated.version,
    seamVersion: validated.seamVersion,
    name: validated.name,
    summary: validated.summary,
    methodHash: guidanceMethodHash(validated),
    capabilities: validated.capabilities,
    planGuidance: validated.planGuidance,
    ...(validated.assessmentGuidance === null ? {} : { assessmentGuidance: validated.assessmentGuidance }),
    sources,
    activationScope: GUIDANCE_ACTIVATION_SCOPE,
  });
}

/**
 * Validate one stored capture and prove it is internally consistent.
 *
 * It re-derives the method and source hashes from the stored text, so a rewritten row is refused
 * rather than rendered as if it were the original capture.
 */
export function validateGuidanceSnapshot(value: unknown): GuidanceSnapshot {
  const record = requireObject('guidance snapshot', value);
  requireExactKeys('guidance snapshot', record, ['kind', 'selectedMethodIds', 'methods', 'hash']);
  const kind = requireEnum('guidance snapshot kind', record['kind'], GUIDANCE_KINDS);
  const rawMethods = record['methods'];
  invariant(Array.isArray(rawMethods), 'invalid_input', 'guidance snapshot methods must be an array', {
    reason: 'invalid_shape',
  });
  invariant(
    rawMethods.length <= MAX_GUIDANCE_SELECTION,
    'invalid_input',
    `guidance snapshot holds at most ${MAX_GUIDANCE_SELECTION} methods`,
    { reason: 'selection_too_long', length: rawMethods.length },
  );
  const methods = rawMethods.map((entry) => requireSnapshot(entry));
  const rawIds = record['selectedMethodIds'];
  invariant(Array.isArray(rawIds), 'invalid_input', 'guidance snapshot selectedMethodIds must be an array', {
    reason: 'invalid_shape',
  });
  const selectedMethodIds = rawIds.map((entry) => requireText('guidance snapshot selectedMethodIds entry', entry, MAX_GUIDANCE_ID_CHARS));
  const derivedIds = methods.map((method) => method.methodId);
  invariant(
    selectedMethodIds.length === derivedIds.length && selectedMethodIds.every((id, index) => id === derivedIds[index]),
    'invalid_input',
    'guidance snapshot selectedMethodIds does not match its captured methods',
    { reason: 'invalid_shape', declared: selectedMethodIds, derived: derivedIds },
  );
  const hash = requireHash('guidance snapshot hash', record['hash']);
  const derived = guidanceSnapshotHash(kind, methods);
  invariant(derived === hash, 'invalid_input', 'guidance snapshot hash does not match its own content', {
    reason: 'invalid_shape',
    declared: hash,
    derived,
  });
  return deepFreeze({ kind, selectedMethodIds, methods, hash });
}

/** The definition embedded in a snapshot, re-validated so a caller can re-register or render it. */
export function definitionOfSnapshot(snapshot: GuidanceMethodSnapshot): GuidanceMethodDefinition {
  return validateGuidanceMethodDefinition({
    methodId: snapshot.methodId,
    version: snapshot.version,
    seamVersion: snapshot.seamVersion,
    name: snapshot.name,
    summary: snapshot.summary,
    capabilities: snapshot.capabilities,
    planGuidance: snapshot.planGuidance,
    assessmentGuidance: snapshot.assessmentGuidance ?? null,
    sources: snapshot.sources.map((source) => ({ title: source.title, url: source.url, license: source.license })),
  });
}

// ---------------------------------------------------------------------------------------
// Selection arithmetic (pure)
// ---------------------------------------------------------------------------------------

/** One installed definition as the live catalogue sees it. */
export interface InstalledGuidanceMethod {
  readonly definition: GuidanceMethodDefinition;
  readonly methodHash: string;
  /** Ordinal of registration; used only to keep the catalogue order stable, never as identity. */
  readonly installedOrder: number;
}

/** Outcome of resolving a selection against the live registry. */
export type GuidanceResolution =
  | {
      readonly ok: true;
      readonly snapshot: GuidanceSnapshot;
      /** Ids of the selection that are installed; `[]` for the free baseline. */
      readonly availableMethodIds: readonly string[];
      /** Method ids that were selected and are still installed with the same version. */
      readonly unchangedMethodIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown_method' | 'version_changed' | 'not_supported_here';
      readonly methodId: string;
      readonly detail: string;
    };

/**
 * Resolve an explicit selection against the installed catalogue, purely.
 *
 * Three refusals are possible and each is a *typed* answer, never a silent substitution:
 * `unknown_method` (the id was never installed or its package was removed), `version_changed` (the
 * id is installed at a different version than the capture recorded, so the capture is no longer the
 * method that would run) and `not_supported_here` (a plan-only method used for assessment, or the
 * reverse). The caller decides whether to refuse the work; this function only decides facts.
 */
export function resolveGuidanceSelection(input: {
  readonly kind: GuidanceKind;
  readonly selectedMethodIds: readonly string[];
  readonly installed: readonly InstalledGuidanceMethod[];
  /** Capture to compare against, when one is already stored. */
  readonly captured?: GuidanceSnapshot | null;
}): GuidanceResolution {
  const { kind, installed } = input;
  const selected = [...input.selectedMethodIds];
  if (selected.length > MAX_GUIDANCE_SELECTION) {
    return {
      ok: false,
      reason: 'unknown_method',
      methodId: selected[MAX_GUIDANCE_SELECTION] ?? '',
      detail: `a guidance selection holds at most ${MAX_GUIDANCE_SELECTION} methods`,
    };
  }
  const seen = new Set<string>();
  for (const id of selected) {
    if (seen.has(id)) {
      return { ok: false, reason: 'unknown_method', methodId: id, detail: `method ${id} was selected twice` };
    }
    seen.add(id);
  }
  const byId = new Map(installed.map((entry) => [entry.definition.methodId, entry]));
  const definitions: GuidanceMethodDefinition[] = [];
  const unchanged: string[] = [];
  const capturedById = new Map((input.captured?.methods ?? []).map((method) => [method.methodId, method]));
  for (const id of selected) {
    const entry = byId.get(id);
    if (!entry) {
      return {
        ok: false,
        reason: 'unknown_method',
        methodId: id,
        detail: `method ${id} is not installed in this host; install its companion package or choose another method`,
      };
    }
    if (kind === 'assessment' && !entry.definition.capabilities.assessment) {
      return {
        ok: false,
        reason: 'not_supported_here',
        methodId: id,
        detail: `method ${id} offers no assessment guidance`,
      };
    }
    if (kind === 'plan' && !entry.definition.capabilities.plan) {
      return { ok: false, reason: 'not_supported_here', methodId: id, detail: `method ${id} offers no plan guidance` };
    }
    const previous = capturedById.get(id);
    if (previous !== undefined && previous.version !== entry.definition.version) {
      return {
        ok: false,
        reason: 'version_changed',
        methodId: id,
        detail: `method ${id} is installed at ${entry.definition.version} but this capture recorded ${previous.version}; re-prepare instead of reusing the old capture`,
      };
    }
    if (input.captured != null && previous === undefined) {
      return {
        ok: false,
        reason: 'version_changed',
        methodId: id,
        detail: `method ${id} is not part of the stored capture`,
      };
    }
    if (previous !== undefined) {
      unchanged.push(id);
    }
    definitions.push(entry.definition);
  }
  return {
    ok: true,
    snapshot: captureGuidanceSnapshot(kind, definitions),
    availableMethodIds: selected,
    unchangedMethodIds: unchanged,
  };
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

function requireExactKeys(label: string, value: JsonObject, keys: readonly string[]): void {
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  invariant(unknownKeys.length === 0, 'invalid_input', `${label} has unknown keys: ${unknownKeys.join(', ')}`, {
    reason: 'invalid_shape',
    label,
    unknownKeys,
  });
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  invariant(missing.length === 0, 'invalid_input', `${label} is missing keys: ${missing.join(', ')}`, {
    reason: 'invalid_shape',
    label,
    missing,
  });
}

function requireText(label: string, value: unknown, bound: number): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} must be a non-empty string`,
    { reason: 'invalid_text', label },
  );
  const text = value as string;
  invariant(text.length <= bound, 'invalid_input', `${label} is ${text.length} characters, above ${bound}`, {
    reason: 'text_too_long',
    label,
    length: text.length,
    bound,
  });
  invariant(!CONTROL_CHARS.test(text), 'invalid_input', `${label} contains control characters`, {
    reason: 'invalid_text',
    label,
  });
  return text;
}

function requirePattern(label: string, value: unknown, pattern: RegExp, bound: number): string {
  const text = requireText(label, value, bound);
  invariant(pattern.test(text), 'invalid_input', `${label} must match its identifier pattern`, {
    reason: label.includes('version') ? 'invalid_version' : 'invalid_id',
    label,
  });
  return text;
}

function requireArray(label: string, value: unknown): readonly unknown[] {
  invariant(Array.isArray(value), 'invalid_input', `${label} must be an array`, { reason: 'invalid_shape', label });
  return value as readonly unknown[];
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

function requireHash(label: string, value: unknown): string {
  invariant(typeof value === 'string' && SHA256.test(value), 'invalid_input', `${label} must be a sha256 digest`, {
    reason: 'invalid_shape',
    label,
  });
  return value as string;
}

function requireCapabilities(methodId: string, value: unknown): GuidanceMethodCapabilities {
  const record = requireObject('guidance method capabilities', value);
  requireExactKeys('guidance method capabilities', record, ['plan', 'assessment']);
  for (const key of ['plan', 'assessment'] as const) {
    invariant(
      typeof record[key] === 'boolean',
      'invalid_input',
      `guidance method capabilities.${key} must be boolean`,
      { reason: 'invalid_shape', methodId, key },
    );
  }
  const capabilities = { plan: record['plan'] as boolean, assessment: record['assessment'] as boolean };
  invariant(
    capabilities.plan || capabilities.assessment,
    'invalid_input',
    `guidance method ${methodId} declares no capability at all`,
    { reason: 'no_capability', methodId },
  );
  return capabilities;
}

function requireSections(methodId: string, value: unknown): readonly GuidanceInstructiveSection[] {
  invariant(Array.isArray(value), 'invalid_input', 'guidance sections must be an array', {
    reason: 'invalid_shape',
    methodId,
  });
  const raw = value as readonly unknown[];
  invariant(
    raw.length > 0,
    'invalid_input',
    `guidance method ${methodId} needs at least one instructive section`,
    { reason: 'invalid_shape', methodId },
  );
  invariant(
    raw.length <= MAX_GUIDANCE_SECTIONS,
    'invalid_input',
    `guidance method ${methodId} holds at most ${MAX_GUIDANCE_SECTIONS} sections`,
    { reason: 'too_many_sections', methodId, length: raw.length },
  );
  const titles = new Set<string>();
  return raw.map((entry) => {
    const record = requireObject('guidance section', entry);
    requireExactKeys('guidance section', record, ['title', 'text']);
    const title = requireText('guidance section title', record['title'], MAX_GUIDANCE_NAME_CHARS);
    invariant(!titles.has(title), 'invalid_input', `guidance method ${methodId} repeats section ${title}`, {
      reason: 'invalid_shape',
      methodId,
      title,
    });
    titles.add(title);
    return {
      title,
      text: requireText('guidance section text', record['text'], MAX_GUIDANCE_TEXT_CHARS),
    };
  });
}

function requirePlanGuidance(methodId: string, value: unknown): GuidancePlanGuidance {
  const record = requireObject('guidance method planGuidance', value);
  requireExactKeys('guidance method planGuidance', record, ['summary', 'sections', 'trainingSteps']);
  const summary = requireText('guidance planGuidance summary', record['summary'], MAX_GUIDANCE_SHORT_CHARS);
  const sections = requireSections(methodId, record['sections']);
  const rawSteps = record['trainingSteps'];
  invariant(Array.isArray(rawSteps), 'invalid_input', 'guidance planGuidance trainingSteps must be an array', {
    reason: 'invalid_shape',
    methodId,
  });
  invariant(
    rawSteps.length > 0,
    'invalid_input',
    `guidance method ${methodId} needs at least one training step`,
    { reason: 'invalid_shape', methodId },
  );
  invariant(
    rawSteps.length <= MAX_GUIDANCE_SECTIONS,
    'invalid_input',
    `guidance method ${methodId} holds at most ${MAX_GUIDANCE_SECTIONS} training steps`,
    { reason: 'too_many_sections', methodId, length: rawSteps.length },
  );
  const trainingSteps = rawSteps.map((entry) => requireText('guidance training step', entry, MAX_GUIDANCE_SHORT_CHARS));
  return { summary, sections, trainingSteps };
}

function requireAssessmentGuidance(methodId: string, value: unknown): GuidanceAssessmentGuidance {
  const record = requireObject('guidance method assessmentGuidance', value);
  requireExactKeys('guidance method assessmentGuidance', record, ['summary', 'sections']);
  return {
    summary: requireText('guidance assessmentGuidance summary', record['summary'], MAX_GUIDANCE_SHORT_CHARS),
    sections: requireSections(methodId, record['sections']),
  };
}

function requireSources(methodId: string, value: unknown): readonly GuidanceSource[] {
  invariant(Array.isArray(value), 'invalid_input', 'guidance method sources must be an array', {
    reason: 'invalid_shape',
    methodId,
  });
  const raw = value as readonly unknown[];
  invariant(
    raw.length <= MAX_GUIDANCE_SOURCES,
    'invalid_input',
    `guidance method ${methodId} declares at most ${MAX_GUIDANCE_SOURCES} sources`,
    { reason: 'too_many_sources', methodId, length: raw.length },
  );
  const urls = new Set<string>();
  return raw.map((entry) => {
    const record = requireObject('guidance source', entry);
    requireExactKeys('guidance source', record, ['title', 'url', 'license']);
    const title = requireText('guidance source title', record['title'], MAX_GUIDANCE_SOURCE_TITLE_CHARS);
    const url = requirePublicHttpUrl(methodId, record['url']);
    invariant(!urls.has(url), 'invalid_input', `guidance method ${methodId} repeats source ${url}`, {
      reason: 'invalid_url',
      methodId,
      url,
    });
    urls.add(url);
    const license =
      record['license'] === null ? null : requireText('guidance source license', record['license'], MAX_GUIDANCE_NAME_CHARS);
    return { title, url, license };
  });
}

/**
 * A source link must be a public `http(s)` URL without credentials.
 *
 * This is a *link* rule, not a fetch rule: nothing in this feature downloads a source, so a
 * harmless fragment or an explicit port is allowed. Embedded userinfo is the only part that would
 * turn a stored citation into a secret.
 */
function requirePublicHttpUrl(methodId: string, value: unknown): string {
  invariant(typeof value === 'string' && value.trim().length > 0, 'invalid_input', 'guidance source url must be a non-empty string', {
    reason: 'invalid_url',
    methodId,
  });
  const raw = (value as string).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GuidanceMethodError('invalid_url', `guidance source ${raw} is not an absolute URL`, { methodId, url: raw });
  }
  const scheme = parsed.protocol;
  invariant(
    (scheme === 'https:' || scheme === 'http:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hostname.length > 0,
    'invalid_input',
    `guidance source ${raw} must be a public http(s) link without credentials`,
    { reason: 'invalid_url', methodId, url: raw },
  );
  return raw;
}

function requireSnapshot(value: unknown): GuidanceMethodSnapshot {
  const record = requireObject('guidance method snapshot', value);
  requireExactKeys('guidance method snapshot', record, [
    'methodId',
    'version',
    'seamVersion',
    'name',
    'summary',
    'methodHash',
    'capabilities',
    'planGuidance',
    ...(Object.hasOwn(record, 'assessmentGuidance') ? ['assessmentGuidance'] : []),
    'sources',
    'activationScope',
  ]);
  const rawSources = requireArray('guidance method snapshot sources', record['sources']);
  invariant(
    rawSources.length <= MAX_GUIDANCE_SOURCES,
    'invalid_input',
    `guidance method snapshot declares at most ${MAX_GUIDANCE_SOURCES} sources`,
    { reason: 'too_many_sources', length: rawSources.length },
  );
  // Each captured source is re-derived from its own stored triple, so a rewritten link, title or
  // licence is refused instead of being rendered as the capture the plan was generated from.
  const sources = rawSources.map((entry) => {
    const source = requireObject('guidance source snapshot', entry);
    requireExactKeys('guidance source snapshot', source, ['title', 'url', 'license', 'sourceHash']);
    const declared = requireHash('guidance source snapshot sourceHash', source['sourceHash']);
    const plain: GuidanceSource = {
      title: requireText('guidance source title', source['title'], MAX_GUIDANCE_SOURCE_TITLE_CHARS),
      url: requirePublicHttpUrl('snapshot', source['url']),
      license:
        source['license'] === null
          ? null
          : requireText('guidance source license', source['license'], MAX_GUIDANCE_NAME_CHARS),
    };
    const derived = guidanceSourceHash(plain);
    invariant(
      derived === declared,
      'invalid_input',
      `guidance source ${plain.url} hash does not match its content`,
      { reason: 'invalid_shape', url: plain.url, declared, derived },
    );
    return { ...plain, sourceHash: declared };
  });
  const definition = validateGuidanceMethodDefinition({
    methodId: record['methodId'],
    version: record['version'],
    seamVersion: record['seamVersion'],
    name: record['name'],
    summary: record['summary'],
    capabilities: record['capabilities'],
    planGuidance: record['planGuidance'],
    assessmentGuidance: record['assessmentGuidance'] ?? null,
    sources: sources.map((source) => ({ title: source.title, url: source.url, license: source.license })),
  });
  const methodHash = requireHash('guidance method snapshot methodHash', record['methodHash']);
  const derivedMethodHash = guidanceMethodHash(definition);
  invariant(
    derivedMethodHash === methodHash,
    'invalid_input',
    `guidance method snapshot ${definition.methodId} hash does not match its own content`,
    { reason: 'invalid_shape', methodId: definition.methodId, declared: methodHash, derived: derivedMethodHash },
  );
  const activationScope = requireText(
    'guidance method snapshot activationScope',
    record['activationScope'],
    MAX_GUIDANCE_TEXT_CHARS,
  );
  invariant(
    activationScope === GUIDANCE_ACTIVATION_SCOPE,
    'invalid_input',
    'guidance method snapshot activationScope is not the documented advisory scope',
    { reason: 'invalid_shape' },
  );
  return deepFreeze({
    methodId: definition.methodId,
    version: definition.version,
    seamVersion: definition.seamVersion,
    name: definition.name,
    summary: definition.summary,
    methodHash,
    capabilities: definition.capabilities,
    planGuidance: definition.planGuidance,
    ...(definition.assessmentGuidance === null ? {} : { assessmentGuidance: definition.assessmentGuidance }),
    sources,
    activationScope,
  });
}
