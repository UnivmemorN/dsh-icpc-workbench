/**
 * Owned Luogu host runtime (Sprint 17d1).
 *
 * One runtime instance composes everything the authenticated Luogu slice needs, from public
 * extension points only: the workspace-scoped OS credential vault, the shared source-wide pacing
 * gate, the connection manager, the stored-session submissions source, the anonymous metadata
 * adapter, the account-bound authenticated metadata fallback and the durable `LuoguSyncService` —
 * plus the single interval timer that drives the per-account due instants.
 *
 * ## One credential path
 *
 * `submissionsFor` owns one authenticated reader per account, and the runtime republishes it as
 * {@link LuoguHostRuntime.sessionReader}. The submission sync and the editorial read therefore share
 * that account's transport, its >= 2 s pacing state, its cookie lifecycle and its session provider;
 * composition injects the same function into the business adapter, so no second credential path can
 * exist. The cookie still travels only from the vault into one authenticated reader call.
 *
 * ## Order of operations
 *
 * `start()` first runs {@link recoverDurableSync}, which materializes the contract defaults of every
 * stored Luogu account (per-account settings and sync state) and clears only a lease whose durable
 * deadline is already in the past, and then runs the one `startup()` sweep. Composition calls it
 * **before** any route is registered, so no request can observe a half-initialized account.
 *
 * `dispose()` stops the timer first, cancels the tick token, drains the tick and the `start()`
 * attempt it may have raced, and only then lets the service drain the running pass, every launch
 * attempt and every connection operation. Disposal is idempotent, every caller shares one disposal
 * promise, and a disposal that races `start()` wins: `start()` re-checks disposal after every await,
 * so no timer can be created after the close and no store read survives it. A throwing
 * `onInternalError` observer is itself a failure: it is recorded and rethrown by `dispose()` after
 * the drain instead of becoming an unhandled rejection. Composition registers this disposer before
 * the API disposer in its own list, so reverse-order disposal removes the routes before the service
 * is asked to drain — no request can start after the close began.
 *
 * ## Restart scope
 *
 * `options.limits` (the workspace's global `platformLimits`) is snapshotted when the runtime is
 * constructed: the shared gate's floor and this source's request budget are fixed for the lifetime
 * of the host, so a change to the global platform limits takes effect only after the plugin
 * restarts. Per-account synchronization settings are read from the durable rows on every decision
 * and stay live.
 *
 * ## Honesty and secrecy
 *
 * The vault is constructed for this workspace's `dataDir`; on a platform without a supported
 * credential backend the runtime stays constructible, `connectionAvailable` is `false`, and every
 * credential operation is refused with an explicit typed error instead of a fabricated success. A
 * session cookie never appears in this module: it travels from `luogu.connect` into the connection
 * adapter's vault write and from the vault into exactly one authenticated reader call.
 *
 * ## Injected environment
 *
 * Every ambient dependency is a seam (vault, platform, clock, wait, timer, transport, metadata
 * source) so the whole lifecycle — recovery, startup sweep, periodic tick, drain — can be driven
 * deterministically in tests without a real credential, socket or OS timer.
 */
import {
  createLuoguConnectionManager,
  createLuoguProblemSessionSource,
  createStoredLuoguSessionProvider,
  createStoredSubmissionsSource,
} from '../adapters/luogu/index.js';
import { WindowsCredentialVault } from '../adapters/windows/index.js';
import type { ClockFn, FetchLike, SetTimerFn, WaitFn } from '../adapters/platform/http.js';
import { LuoguSyncService } from '../application/luogu-sync-service.js';
import { createLuoguSourceGate, type LuoguSourceGate } from '../application/luogu-source-gate.js';
import {
  defaultLuoguSyncSettings,
  emptyLuoguSyncState,
  luoguLeaseExpired,
  type LuoguSyncStore,
} from '../application/luogu-sync-types.js';
import type { LocalCredentialVault } from '../application/local-credential-vault.js';
import type { ImportService } from '../application/import-service.js';
import type { LuoguSessionReader } from '../application/luogu-session.js';
import type { PlatformAdapter, PlatformLimits, ProblemMetadataSource, TrainingStore } from '../application/ports.js';
import {
  DomainError,
  createCancellationSource,
  throwIfCancelled,
  type Account,
  type CancellationToken,
  type SourceInstance,
} from '../domain/index.js';

/** Default periodic sweep cadence; per-account intervals are honored by the durable due instants. */
export const LUOGU_TICK_INTERVAL_MS = 60_000;

/** A stoppable timer seam; the returned function cancels the schedule. */
export type IntervalFn = (callback: () => void, ms: number) => () => void;

/**
 * Injectable environment of the Luogu host.
 *
 * Production supplies none of these fields and gets the real Windows credential vault, the process
 * clock and OS timers. Tests inject a synthetic vault, clock, wait, timer and transport so the whole
 * lifecycle runs offline and deterministically.
 */
export interface LuoguHostSeam {
  readonly vault?: LocalCredentialVault;
  /** Platform the default vault resolves; ignored when `vault` is supplied. */
  readonly platform?: string;
  /** ISO-8601 clock of the service and the connection records. */
  readonly now?: () => string;
  /** Epoch-millisecond clock of the pacing gate. */
  readonly nowMs?: () => number;
  /** Cancellation-aware wait used by the gate and the sync service. */
  readonly wait?: WaitFn;
  /** Interval seam of the periodic sweep. */
  readonly setInterval?: IntervalFn;
  /** Periodic sweep cadence in milliseconds; defaults to {@link LUOGU_TICK_INTERVAL_MS}. */
  readonly tickIntervalMs?: number;
  /** Transport wiring of the authenticated reader (synthetic fetch in tests). */
  readonly transport?: Parameters<typeof createStoredSubmissionsSource>[0]['transport'];
  /**
   * Transport wiring of the **anonymous** metadata reader.
   *
   * Composition uses this to hand the business adapter the same synthetic fetch the rest of the slice
   * runs on: an offline activation must not leave one adapter on the real network. Production supplies
   * nothing here and the adapter builds its own official-origin transport.
   */
  readonly anonymousTransport?: LuoguAnonymousTransport;
  /** Anonymous metadata source; defaults to the composition's official Luogu adapter. */
  readonly metadataSource?: PlatformAdapter;
}

/** Transport wiring of an anonymous Luogu adapter (the fields `LuoguAdapterOptions` accepts). */
export interface LuoguAnonymousTransport {
  readonly fetchImpl?: FetchLike;
  readonly clock?: ClockFn;
  readonly wait?: WaitFn;
  readonly setTimer?: SetTimerFn;
}

export interface LuoguHostOptions {
  readonly store: TrainingStore & LuoguSyncStore;
  readonly imports: ImportService;
  readonly sourceInstance: SourceInstance;
  /** Anonymous, unauthenticated metadata adapter of the same instance (never used for submissions). */
  readonly metadataSource: PlatformAdapter;
  /** Workspace data directory that namespaces every stored credential. */
  readonly dataDir: string;
  readonly limits: PlatformLimits;
  /** Unique lease-owner identity of this running service instance. */
  readonly ownerId: string;
  /** Observer for a failed periodic sweep; never changes the retained status. */
  readonly onInternalError: (error: unknown) => void;
  readonly seam?: LuoguHostSeam;
}

/** What composition needs from the runtime. */
export interface LuoguHostRuntime {
  readonly service: LuoguSyncService;
  /** Honest capability of the credential backend. */
  readonly connectionAvailable: boolean;
  /** Resolved platform of the credential backend, disclosed even when unavailable. */
  readonly connectionPlatform: string;
  /**
   * The account-bound authenticated reader of this host: the **same** `LuoguSessionReader` instance
   * the submission sync drives, one per account.
   *
   * Composition injects this into the business `LuoguAdapter`, so an editorial read runs on the
   * account's existing transport — one credential path, one >= 2 s source pacing state and one cookie
   * lifecycle per account — instead of a second session mechanism. It exposes only the two normalized
   * reader operations; no cookie, vault reference or connection record is reachable through it.
   */
  readonly sessionReader: (account: Account) => LuoguSessionReader;
  /**
   * The one source-wide gate this host owns.
   *
   * The sync service and the connection manager already run their own operations through it, so
   * composition must wrap every *additional* Luogu HTTP path (the business adapter's anonymous and
   * authenticated reads) in this same instance: one gate per source instance is what makes the >= 2 s
   * quiet time hold across transports and accounts. Wrapping a path the host already gates would nest
   * two floors, so the wrapper belongs around the business adapter only.
   */
  readonly gate: LuoguSourceGate;
  /** Recover durable state, run the startup sweep and start the periodic tick. */
  start(token: CancellationToken): Promise<void>;
  /** Stop the timer and drain the service; idempotent. */
  dispose(): Promise<void>;
}

/** Cancellation-aware wait used when no seam supplies one; the timer is the only ambient resource. */
const defaultWait: WaitFn = (ms, token) => {
  token.throwIfCancelled();
  return new Promise<void>((resolve, reject) => {
    let off: () => void = () => {};
    const timer = setTimeout(() => {
      off();
      resolve();
    }, ms);
    off = token.onCancel(() => {
      clearTimeout(timer);
      reject(new DomainError('cancelled', 'operation cancelled'));
    });
  });
};

/**
 * Production interval seam.
 *
 * The timer is unref'd so a periodic sweep never keeps a standalone process alive; a host that owns
 * the runtime keeps running for its own reasons. Cancellation is synchronous and idempotent.
 */
const defaultInterval: IntervalFn = (callback, ms) => {
  const timer = setInterval(callback, ms);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};

/** What one recovery pass changed, for assertions and diagnostics. */
export interface LuoguRecoveryReport {
  readonly settingsCreated: number;
  readonly statesCreated: number;
  readonly expiredLeasesCleared: number;
}

/**
 * Materialize the durable defaults of every stored Luogu account and recover a dead owner's lease.
 *
 * Idempotent. Only a lease whose persisted deadline is at or before `now()` is cleared; a live lease
 * of another instance is left untouched (and the sync service refuses to start over it). Clearing an
 * expired lease changes no scheduling decision — the service already treats an expired lease as free
 * — it only stops a dead process from being displayed as an active one.
 */
export async function recoverDurableSync(
  store: TrainingStore & LuoguSyncStore,
  sourceInstance: SourceInstance,
  now: () => string,
  token: CancellationToken,
): Promise<LuoguRecoveryReport> {
  return store.transaction(async () => {
    const accounts = await store.listAccounts(sourceInstance.id);
    let settingsCreated = 0;
    let statesCreated = 0;
    let expiredLeasesCleared = 0;
    for (const account of accounts) {
      throwIfCancelled(token);
      const at = now();
      if ((await store.getLuoguSyncSettings(account.id)) === null) {
        await store.saveLuoguSyncSettings(defaultLuoguSyncSettings(account.id, at), null);
        settingsCreated += 1;
      }
      const state = await store.getLuoguSyncState(account.id);
      if (state === null) {
        await store.saveLuoguSyncState(emptyLuoguSyncState(account.id, sourceInstance.id, at), null);
        statesCreated += 1;
        continue;
      }
      if (state.value.owner !== null && luoguLeaseExpired(state.value, at)) {
        await store.saveLuoguSyncState(
          { ...state.value, owner: null, leaseExpiresAt: null, pagesInPass: 0, updatedAt: at },
          state.revision,
        );
        expiredLeasesCleared += 1;
      }
    }
    return { settingsCreated, statesCreated, expiredLeasesCleared };
  });
}

/** Build the owned Luogu host runtime; construction performs no IO and no network request. */
export function createLuoguHost(options: LuoguHostOptions): LuoguHostRuntime {
  const seam = options.seam ?? {};
  const now = seam.now ?? ((): string => new Date().toISOString());
  const nowMs = seam.nowMs ?? ((): number => Date.now());
  const wait = seam.wait ?? defaultWait;
  const interval = seam.setInterval ?? defaultInterval;
  const tickIntervalMs = seam.tickIntervalMs ?? LUOGU_TICK_INTERVAL_MS;
  if (!Number.isSafeInteger(tickIntervalMs) || tickIntervalMs <= 0) {
    throw new TypeError('luogu tickIntervalMs must be a positive safe integer');
  }
  const vault =
    seam.vault ??
    new WindowsCredentialVault({
      dataDir: options.dataDir,
      ...(seam.platform === undefined ? {} : { platform: seam.platform }),
    });
  const capabilities = vault.capabilities();
  // One gate per source instance, shared by the connection adapter and the sync service, so the
  // 2-second source-wide floor is measured across whole operations of every transport.
  const gate = createLuoguSourceGate({
    now: nowMs,
    wait,
    minRequestIntervalMs: options.limits.minRequestIntervalMs,
  });
  const connections = createLuoguConnectionManager({
    store: options.store,
    vault,
    sourceInstance: options.sourceInstance,
    now,
    limits: options.limits,
    gate,
    ...(seam.transport === undefined ? {} : { transport: seam.transport }),
  });
  const submissionsFor = createStoredSubmissionsSource({
    store: options.store,
    vault,
    sourceInstance: options.sourceInstance,
    ...(seam.transport === undefined ? {} : { transport: seam.transport }),
  });
  // The account-bound metadata fallback. The anonymous metadata read is always tried first, and only
  // its `auth_required` refusal reaches this factory; one source per account is cached, so the
  // reader's own >= 2 s pacing survives across calls, while the stored-session provider under it
  // re-reads the connection row and the vault on every call — a reconnected session is observed
  // immediately and a removed one stops working. The cookie therefore travels only into the problem
  // request of the account it belongs to, and never through the anonymous metadata adapter.
  const sessions = createStoredLuoguSessionProvider({ store: options.store, vault });
  const problemSources = new Map<string, ProblemMetadataSource>();
  const authenticatedMetadataFor = (account: Account): ProblemMetadataSource => {
    const existing = problemSources.get(account.id);
    if (existing !== undefined) {
      return existing;
    }
    const transport = seam.transport;
    const source = createLuoguProblemSessionSource({
      sourceInstance: options.sourceInstance,
      account,
      sessions,
      fetchImpl: transport?.fetchImpl,
      clock: transport?.clock,
      wait: transport?.wait,
      setTimer: transport?.setTimer,
      maxResponseBytes: transport?.maxResponseBytes,
      maxRedirects: transport?.maxRedirects,
    });
    problemSources.set(account.id, source);
    return source;
  };
  const service = new LuoguSyncService({
    store: options.store,
    imports: options.imports,
    connections,
    sourceInstance: options.sourceInstance,
    submissionsFor,
    metadataSource: seam.metadataSource ?? options.metadataSource,
    authenticatedMetadataFor,
    ownerId: options.ownerId,
    now,
    wait,
    gate,
    limits: options.limits,
  });

  const life = createCancellationSource();
  let stopTimer: (() => void) | null = null;
  let ticking: Promise<void> | null = null;
  let starting: Promise<void> | null = null;
  let disposal: Promise<void> | null = null;
  let started = false;
  let disposed = false;
  const observerFailures: unknown[] = [];

  /**
   * Report one background failure to the host observer.
   *
   * A tick failure is reported and retained in the durable status; it must never become an unhandled
   * rejection, and the next tick retries on its own schedule. An observer that throws is itself a
   * failure: it is recorded and rethrown by `dispose()` after the drain, which is the only error
   * channel a detached tick has.
   */
  const report = (error: unknown): void => {
    try {
      options.onInternalError(error);
    } catch (observerError) {
      observerFailures.push(observerError);
    }
  };

  const onTick = (): void => {
    if (ticking !== null || disposed) {
      return;
    }
    const task = service.tick(life.token).then(
      () => undefined,
      (error: unknown) => {
        report(error);
      },
    );
    ticking = task;
    void task.then(() => {
      if (ticking === task) {
        ticking = null;
      }
    });
  };

  /** Wait until the tick that was in flight when the close began settled; new ticks are refused. */
  const drainTick = async (): Promise<void> => {
    while (ticking !== null) {
      // `onTick` already reports every rejection, so this only waits for the sweep to settle.
      await ticking;
    }
  };

  /** Wait for a raced `start()` attempt; its own caller observes the rejection. */
  const drainStart = async (): Promise<void> => {
    const pending = starting;
    if (pending !== null) {
      await pending.then(
        () => undefined,
        () => undefined,
      );
    }
  };

  return {
    service,
    connectionAvailable: capabilities.implemented,
    connectionPlatform: capabilities.platform,
    sessionReader: (account: Account): LuoguSessionReader => submissionsFor.readerFor(account),
    gate,
    async start(token: CancellationToken): Promise<void> {
      if (started || disposed) {
        return;
      }
      started = true;
      const task = (async (): Promise<void> => {
        await recoverDurableSync(options.store, options.sourceInstance, now, token);
        if (disposed) {
          return;
        }
        await service.startup(token);
        // Re-checked after the sweep: a disposal that landed while recovery or the sweep was running
        // must leave no timer behind that would query the store after the runtime resolved its close.
        if (disposed) {
          return;
        }
        stopTimer = interval(onTick, tickIntervalMs);
      })();
      starting = task;
      try {
        await task;
      } finally {
        if (starting === task) {
          starting = null;
        }
      }
    },
    async dispose(): Promise<void> {
      if (disposal !== null) {
        return disposal;
      }
      const task = (async (): Promise<void> => {
        disposed = true;
        if (stopTimer !== null) {
          stopTimer();
          stopTimer = null;
        }
        life.cancel('the Luogu host is closing');
        // Started synchronously, so the service begins refusing new work while the tick and the
        // startup attempt that are already in flight are still draining.
        const closeService = service.close();
        const results = await Promise.allSettled([closeService, drainTick(), drainStart()]);
        const failures: unknown[] = [...observerFailures];
        for (const result of results) {
          if (result.status === 'rejected') {
            failures.push(result.reason);
          }
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, 'ICPC Luogu host cleanup failed');
        }
      })();
      disposal = task;
      return task;
    },
  };
}
