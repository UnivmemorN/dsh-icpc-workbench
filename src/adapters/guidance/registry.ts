/**
 * In-memory guidance method registry (Sprint 18b).
 *
 * One registry instance is owned by the host plugin fibre; every companion package registers its
 * method into it and gets back a disposer. The registry is deliberately the only mutable state of
 * this feature and it is **not** persisted: methods are installed packages, not user data, so a
 * restart re-registers them from the packages that are actually installed instead of restoring a
 * stale catalogue from the database.
 *
 * Invariants this type owns:
 *
 * - an id is unique while installed; re-registering the same id is refused as `duplicate_id`, so two
 *   companion packages can never silently shadow each other and an upgrade must uninstall first;
 * - the catalogue order is registration order and only changes on register/unregister;
 * - a disposer releases exactly the version it registered: unloading a package after an upgrade
 *   attempt can never remove a newer registration it does not own;
 * - the catalogue handed out is a detached, deeply frozen copy, so a caller cannot mutate the live
 *   registry through an array it received.
 */
import {
  GuidanceMethodError,
  deepFreeze,
  guidanceMethodHash,
  validateGuidanceMethodRegistration,
  type GuidanceMethodDefinition,
  type InstalledGuidanceMethod,
} from '../../domain/index.js';
import type { GuidanceCatalog } from '../../application/guidance-catalog.js';

interface Registration {
  readonly definition: GuidanceMethodDefinition;
  readonly methodHash: string;
  readonly order: number;
}

export interface GuidanceMethodRegistryOptions {
  /**
   * Maximum number of methods one host may have installed at once.
   *
   * A bound rather than a policy: the catalogue travels to the UI and a bounded number keeps a
   * selector usable. An installation that exceeds it is refused with a clear error instead of
   * producing a catalogue nobody can render.
   */
  readonly maxMethods?: number;
}

/** Hard maximum of simultaneously installed methods, independent of options. */
export const MAX_INSTALLED_GUIDANCE_METHODS = 16;

/**
 * Mutable, host-owned registry of installed guidance methods.
 *
 * It implements the application's {@link GuidanceCatalog} port directly, so the planning service can
 * be given the same object the companion packages register into.
 */
export class GuidanceMethodRegistry implements GuidanceCatalog {
  private readonly methods = new Map<string, Registration>();
  private readonly maxMethods: number;
  private counter = 0;

  constructor(options: GuidanceMethodRegistryOptions = {}) {
    const max = options.maxMethods ?? MAX_INSTALLED_GUIDANCE_METHODS;
    if (!Number.isSafeInteger(max) || max < 1 || max > MAX_INSTALLED_GUIDANCE_METHODS) {
      throw new TypeError(`guidance registry maxMethods must be an integer within 1..${MAX_INSTALLED_GUIDANCE_METHODS}`);
    }
    this.maxMethods = max;
  }

  /** Number of currently installed methods; used by diagnostics and tests only. */
  get size(): number {
    return this.methods.size;
  }

  /**
   * Validate and install one companion-supplied method.
   *
   * Throws a typed {@link GuidanceMethodError} — never a silent skip — when the definition is
   * malformed, when the id is already installed, or when the host bound is reached. The returned
   * disposer unregisters exactly this registration and is idempotent.
   */
  register(value: unknown): () => void {
    const definition = validateGuidanceMethodRegistration(value);
    if (this.methods.has(definition.methodId)) {
      throw new GuidanceMethodError(
        'duplicate_id',
        `guidance method ${definition.methodId} is already installed; uninstall the other version before registering it again`,
        { methodId: definition.methodId },
      );
    }
    if (this.methods.size >= this.maxMethods) {
      throw new GuidanceMethodError(
        'too_many_methods',
        `this host accepts at most ${this.maxMethods} installed guidance methods`,
        { methodId: definition.methodId, maxMethods: this.maxMethods },
      );
    }
    this.counter += 1;
    const registration: Registration = {
      definition,
      methodHash: guidanceMethodHash(definition),
      order: this.counter,
    };
    this.methods.set(definition.methodId, registration);
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      // Only this exact registration may be removed: an unload that races an upgrade must not
      // delete the newer definition that replaced it.
      if (this.methods.get(definition.methodId) === registration) {
        this.methods.delete(definition.methodId);
      }
    };
  }

  /** The live catalogue as a detached frozen list, in registration order. */
  async catalog(): Promise<readonly InstalledGuidanceMethod[]> {
    return this.snapshot();
  }

  /** Synchronous form of {@link catalog}; the host service uses it while composing a response. */
  snapshot(): readonly InstalledGuidanceMethod[] {
    const entries = [...this.methods.values()]
      .sort((left, right) => left.order - right.order)
      .map((entry) =>
        deepFreeze({
          definition: entry.definition,
          methodHash: entry.methodHash,
          installedOrder: entry.order,
        }),
      );
    return deepFreeze(entries);
  }

  /**
   * Drop every registration.
   *
   * The owning service calls this when its fibre unloads: the catalogue is in-memory host state, so
   * a reload re-registers exactly the packages that are installed. Outstanding companion disposers
   * stay safe — they are idempotent and can only remove the exact registration they created.
   */
  clear(): void {
    this.methods.clear();
  }

  /** One installed method by id, or `null`; the definition is the frozen registered copy. */
  get(methodId: string): InstalledGuidanceMethod | null {
    const entry = this.methods.get(methodId);
    if (!entry) {
      return null;
    }
    return deepFreeze({ definition: entry.definition, methodHash: entry.methodHash, installedOrder: entry.order });
  }
}
