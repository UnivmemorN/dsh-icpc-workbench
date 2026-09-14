/**
 * Guidance catalogue port and resolution (Sprint 18b).
 *
 * The plugin owns one live catalogue of installed method definitions; this module is the narrow
 * application-side view of it. Nothing here imports Cordis, a store or an adapter: the registry that
 * implements {@link GuidanceCatalog} lives in `adapters/guidance`, and the host service that exposes
 * it to companion packages lives in `plugin/guidance-service`.
 *
 * Resolution is deliberately a *pure function of the live catalogue plus the explicit selection*.
 * It never falls back to "some installed method" when one is missing, because a plan must be bound
 * to exactly the method text the user selected or to nothing at all.
 */
import {
  GUIDANCE_KINDS,
  MAX_GUIDANCE_SELECTION,
  captureGuidanceSnapshot,
  resolveGuidanceSelection,
  type GuidanceKind,
  type GuidanceSnapshot,
  type InstalledGuidanceMethod,
} from '../domain/index.js';

/**
 * Live catalogue of installed guidance methods.
 *
 * `catalog()` returns one entry per **currently installed** method in registration order. The order
 * is stable for as long as the companion packages stay installed; a caller rendering a selector may
 * rely on it, but method identity is always the id, never the position.
 */
export interface GuidanceCatalog {
  catalog(): Promise<readonly InstalledGuidanceMethod[]>;
}

/** How many methods a caller may name in one selection. */
export const GUIDANCE_SELECTION_BOUND = MAX_GUIDANCE_SELECTION;

/**
 * Why one explicit selection could not be resolved to a capture.
 *
 * Every member is a *refusal*, never a warning: the caller must refuse the work instead of running
 * it under a substituted method.
 */
export type GuidanceRefusalReason =
  | 'missing_method'
  | 'unknown_method'
  | 'version_changed'
  | 'not_supported_here'
  | 'selection_too_long'
  | 'duplicate_selection';

/** One typed refusal with the method it is about (`null` when the selection itself was malformed). */
export interface GuidanceRefusal {
  readonly reason: GuidanceRefusalReason;
  readonly methodId: string | null;
  readonly detail: string;
}

/** Outcome of resolving one selection against the live catalogue. */
export type GuidanceResolution =
  | { readonly ok: true; readonly snapshot: GuidanceSnapshot }
  | { readonly ok: false; readonly refusal: GuidanceRefusal };

/**
 * Resolve an explicit ordered selection into the immutable capture a plan is bound to.
 *
 * `methodIds` empty is the free baseline and captures an empty snapshot: a free rule plan is allowed
 * to run with no method at all, and the constant `EMPTY_GUIDANCE_HASH` makes that capture
 * byte-stable. A non-empty selection is only satisfiable by the *currently installed* definitions,
 * and `captured` (when supplied) additionally requires every selected id to be present in the
 * stored capture at the same version — that is what makes "removal or replacement invalidates new
 * work, history still renders the prior snapshot" true rather than aspirational.
 *
 * `missing: true` is the caller saying "I require at least one method": the AI planning path sets
 * it, so an AI plan can never silently degrade into an unguided one.
 */
export async function resolveGuidance(
  catalog: GuidanceCatalog,
  input: {
    readonly kind: GuidanceKind;
    readonly methodIds: readonly string[];
    readonly missing: boolean;
    readonly captured?: GuidanceSnapshot | null;
  },
): Promise<GuidanceResolution> {
  if (!GUIDANCE_KINDS.includes(input.kind)) {
    return refusal('not_supported_here', null, `unknown guidance kind ${String(input.kind)}`);
  }
  if (input.methodIds.length > GUIDANCE_SELECTION_BOUND) {
    return refusal(
      'selection_too_long',
      null,
      `a method selection holds at most ${GUIDANCE_SELECTION_BOUND} methods`,
    );
  }
  if (input.missing && input.methodIds.length === 0) {
    return refusal(
      'missing_method',
      null,
      'an AI training plan requires at least one installed training method; install a companion method package and select it, or use the free rule plan',
    );
  }
  const installed = await catalog.catalog();
  if (input.methodIds.length === 0) {
    // The free baseline is computable without consulting the catalogue at all, so an empty
    // selection is stable even while companion packages are being installed or removed.
    return { ok: true, snapshot: captureGuidanceSnapshot(input.kind, []) };
  }
  const resolved = resolveGuidanceSelection({
    kind: input.kind,
    selectedMethodIds: input.methodIds,
    installed,
    captured: input.captured ?? null,
  });
  if (!resolved.ok) {
    return refusal(domainReason(resolved.reason), resolved.methodId, resolved.detail);
  }
  return { ok: true, snapshot: resolved.snapshot };
}

/** Capture the *current* definitions of one selection for a plan that is about to be prepared. */
export async function captureGuidance(
  catalog: GuidanceCatalog,
  kind: GuidanceKind,
  methodIds: readonly string[],
  options: { readonly required: boolean },
): Promise<GuidanceResolution> {
  return resolveGuidance(catalog, { kind, methodIds, missing: options.required });
}

/**
 * Re-check a stored capture against the live catalogue, without re-capturing.
 *
 * Used at reservation and at settlement: a method that was uninstalled or upgraded while a paid call
 * was in flight must not produce a plan that claims to follow text the model never saw. The returned
 * snapshot is the **stored** one, never a fresh capture.
 */
export async function revalidateGuidance(
  catalog: GuidanceCatalog,
  captured: GuidanceSnapshot,
): Promise<GuidanceResolution> {
  const installed = await catalog.catalog();
  const resolved = resolveGuidanceSelection({
    kind: captured.kind,
    selectedMethodIds: captured.selectedMethodIds,
    installed,
    captured,
  });
  if (!resolved.ok) {
    return refusal(domainReason(resolved.reason), resolved.methodId, resolved.detail);
  }
  return { ok: true, snapshot: captured };
}

function domainReason(reason: string): GuidanceRefusalReason {
  switch (reason) {
    case 'unknown_method':
      return 'missing_method';
    case 'version_changed':
      return 'version_changed';
    case 'not_supported_here':
      return 'not_supported_here';
    default:
      return 'unknown_method';
  }
}

function refusal(reason: GuidanceRefusalReason, methodId: string | null, detail: string): GuidanceResolution {
  return { ok: false, refusal: { reason, methodId, detail } };
}
