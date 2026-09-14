/**
 * Host-owned Cordis service exposing the detachable training-method seam (Sprint 18b1).
 *
 * `icpcGuidance` is the one documented extension point a companion package uses: it injects the
 * service, calls `register(definition)` once per method and binds the returned disposer to its own
 * `ctx.effect`, so installing and uninstalling a method package is ordinary Cordis lifecycle.
 *
 * Why a plugin-owned service instead of a harness facility: the pinned harness checkout does ship
 * its own skill registry (`source/packages/skill/skill/src/index.ts`), but a method is *textual
 * training philosophy* with a versioned capture contract. Owning a narrow service keeps that
 * contract stable across harness upgrades and keeps a companion package free of host internals;
 * {@link GUIDANCE_SEAM_VERSION} is the compatibility boundary, not the harness version.
 *
 * Ownership: the `Service` constructor provides the value on the constructing fibre's context, so it
 * disappears when that fibre unloads. The service additionally owns an effect that empties its
 * in-memory catalogue on unload, so a reload re-registers exactly the packages that are installed.
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { GUIDANCE_SEAM_VERSION } from '../domain/index.js';
import { GuidanceMethodRegistry, type GuidanceMethodRegistryOptions } from '../adapters/guidance/index.js';

/** Cordis service name of the documented companion seam. */
export const GUIDANCE_SERVICE_NAME = 'icpcGuidance';

/**
 * Public API of `ctx.icpcGuidance`.
 *
 * - `version` — the seam version this host implements; a companion checks it before registering.
 * - `catalog` — the live catalogue, which implements the application's `GuidanceCatalog` port and
 *   also offers the synchronous `snapshot()`/`get()` a host composing a response needs.
 * - `register` — validate and install one companion definition; returns the exact disposer.
 */
export interface GuidanceServiceApi {
  readonly version: string;
  readonly catalog: GuidanceMethodRegistry;
  readonly size: number;
  register(definition: unknown): () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Installed training-method catalogue (seam {@link GUIDANCE_SEAM_VERSION}).
     *
     * Present only while the workbench plugin is active: a companion package declares
     * `inject: ['icpcGuidance']` instead of probing for it.
     */
    readonly icpcGuidance: GuidanceServiceApi;
  }
}

/** Construction seam: a caller may hand over the exact registry the host runtime already reads. */
export interface GuidanceServiceOptions {
  readonly registry?: GuidanceMethodRegistry;
  readonly registryOptions?: GuidanceMethodRegistryOptions;
}

/**
 * The `icpcGuidance` Cordis service.
 *
 * It holds no timers, files or provider clients: the catalogue is in-memory host state rebuilt from
 * installed packages on every load, and registering a method never dispatches anything.
 */
export class GuidanceService extends Service implements GuidanceServiceApi {
  /** Seam version a companion package targets; see {@link GUIDANCE_SEAM_VERSION}. */
  readonly version = GUIDANCE_SEAM_VERSION;
  readonly catalog: GuidanceMethodRegistry;

  constructor(ctx: Context, options: GuidanceServiceOptions = {}) {
    super(ctx, GUIDANCE_SERVICE_NAME);
    this.catalog = options.registry ?? new GuidanceMethodRegistry(options.registryOptions);
    // Registered methods are package contributions, never user data: unloading the fibre that owns
    // this service must leave no method behind, whether or not the registry was injected.
    ctx.effect(() => () => this.catalog.clear(), 'icpc-guidance: method catalogue');
  }

  /** Number of currently installed methods; used by diagnostics and selector bounds. */
  get size(): number {
    return this.catalog.size;
  }

  /**
   * Validate and install one companion-supplied method.
   *
   * Throws a typed `GuidanceMethodError` on a malformed definition, a duplicate id or an exceeded
   * host bound — never a silent skip. The disposer is idempotent and releases exactly this
   * registration.
   */
  register(definition: unknown): () => void {
    return this.catalog.register(definition);
  }
}

/** Construct the documented service on `ctx`; the returned instance is already provided. */
export function applyGuidanceService(ctx: Context, options: GuidanceServiceOptions = {}): GuidanceService {
  return new GuidanceService(ctx, options);
}
