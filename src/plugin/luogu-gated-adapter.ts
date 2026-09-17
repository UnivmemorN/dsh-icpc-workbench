/**
 * Source-gated business view of one Luogu adapter (Sprint 33C revision).
 *
 * The plugin has exactly one source-wide pacing gate per Luogu source instance
 * ({@link import('../application/luogu-source-gate.js').LuoguSourceGate}), owned by the Luogu host
 * runtime. The sync service and the connection manager already run their **own** operations through it.
 * Every other Luogu HTTP path the business API can reach — an anonymous statement read, an anonymous
 * public-profile read, a catalog page, an authenticated submission page or an authenticated editorial
 * read — would otherwise pace only its own transport and could fire immediately after a gated
 * operation of the same source (a different transport has its own quiet-time window).
 *
 * This module closes that hole with one thin wrapper: every operation that may issue HTTP is run as
 * **one whole operation** through the shared gate, with the same raw adapter underneath. It
 * deliberately does *not* gate the host's own paths (the sync service, the connection manager) — they
 * are gated at their call site, and nesting a second `run` would double the floor and could serialize
 * a call against itself.
 *
 * What the wrapper must not change: the adapter identity (`sourceInstance`), its capabilities, its
 * error behaviour, its cancellation behaviour and its optional methods. A method the wrapped adapter
 * does not have stays absent, so a caller's own capability check keeps deciding.
 *
 * The gate's `run` receives the caller's token, so a queued operation whose request is cancelled
 * before it starts never dispatches anything. An editorial answer may carry a provider-declared
 * Retry-After (`rate_limited`, or an `unavailable` outage that declared one); the wrapper hands the
 * gate a typed extractor so that delay becomes the **source-wide** not-before instant, which every
 * later operation of this source — of whichever transport — observes.
 */
import type { LuoguSourceGate } from '../application/luogu-source-gate.js';
import type {
  AccountProfile,
  EditorialFetchResult,
  FetchAccountProfileRequest,
  FetchEditorialRequest,
  FetchProblemRequest,
  ListProblemsRequest,
  ListSubmissionsRequest,
  Page,
  PlatformAdapter,
  PlatformCapabilities,
} from '../application/ports.js';
import type { NormalizedProblem, Submission } from '../domain/index.js';

/**
 * The optional per-problem detail read a Luogu adapter may expose next to `fetchProblem`.
 *
 * It is not part of {@link PlatformAdapter}; the wrapper forwards it (gated, like every other
 * operation) exactly when the wrapped adapter has it, so a caller that knows the concrete adapter
 * keeps working while a caller that only knows the port is unaffected.
 */
export interface GatedProblemDetailAdapter {
  fetchProblemDetail?(request: FetchProblemRequest): Promise<unknown>;
}

export interface GatedLuoguAdapterOptions {
  /** The raw adapter: the same instance the composition would otherwise expose directly. */
  readonly adapter: PlatformAdapter;
  /** The host runtime's own source gate for this instance. */
  readonly gate: LuoguSourceGate;
}

function requireGate(gate: LuoguSourceGate): LuoguSourceGate {
  if (gate === null || typeof gate !== 'object' || typeof gate.run !== 'function') {
    throw new TypeError('the gated Luogu adapter requires the host source gate');
  }
  return gate;
}

/**
 * The declared Retry-After of one editorial answer, or `null` when it declared none.
 *
 * Both failure variants that can declare a delay are read: `rate_limited` always carries the member
 * (possibly `null`), `unavailable` carries it only when the provider declared one, and `found`,
 * `absent`, `auth_required`, `forbidden` and `changed_response` never do. The value is handed to the
 * gate unchanged; the gate itself validates it, so a `null`, a zero and a negative value are all
 * "no declaration" and can never move the shared deadline backwards.
 */
function editorialRetryAfterOf(result: EditorialFetchResult): number | null {
  if (result.status === 'rate_limited' || result.status === 'unavailable') {
    return result.retryAfterMs ?? null;
  }
  return null;
}

/**
 * Wrap one adapter so each of its operations is one whole gated operation.
 *
 * `capabilities()` and `sourceInstance` pass through untouched: the wrapper must never make an adapter
 * look more (or less) capable than it is. Every other member that can reach the platform runs inside
 * `gate.run`, and the returned value or failure is exactly the wrapped adapter's.
 */
export function createGatedLuoguAdapter(
  options: GatedLuoguAdapterOptions,
): PlatformAdapter & GatedProblemDetailAdapter {
  const adapter = options.adapter;
  if (adapter === null || typeof adapter !== 'object') {
    throw new TypeError('the gated Luogu adapter requires an adapter to wrap');
  }
  const gate = requireGate(options.gate);
  const gated = {
    sourceInstance: adapter.sourceInstance,
    capabilities(): PlatformCapabilities {
      return adapter.capabilities();
    },
    listProblems(request: ListProblemsRequest): Promise<Page<NormalizedProblem>> {
      return gate.run(request.token, () => adapter.listProblems(request));
    },
    listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>> {
      return gate.run(request.token, () => adapter.listSubmissions(request));
    },
    fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem> {
      return gate.run(request.token, () => adapter.fetchProblem(request));
    },
    fetchEditorial(request: FetchEditorialRequest): Promise<EditorialFetchResult> {
      // The extractor runs while this call still owns the FIFO slot, so a queued operation of the
      // same source — including one of another account's transport — already observes the delay.
      return gate.run(request.token, () => adapter.fetchEditorial(request), editorialRetryAfterOf);
    },
    ...(typeof adapter.fetchAccountProfile === 'function'
      ? {
          fetchAccountProfile(request: FetchAccountProfileRequest): Promise<AccountProfile> {
            const read = adapter.fetchAccountProfile;
            if (read === undefined) {
              throw new TypeError('the wrapped adapter lost its profile read');
            }
            return gate.run(request.token, () => read.call(adapter, request));
          },
        }
      : {}),
    ...(typeof (adapter as GatedProblemDetailAdapter).fetchProblemDetail === 'function'
      ? {
          fetchProblemDetail(request: FetchProblemRequest): Promise<unknown> {
            const read = (adapter as GatedProblemDetailAdapter).fetchProblemDetail;
            if (read === undefined) {
              throw new TypeError('the wrapped adapter lost its problem detail read');
            }
            return gate.run(request.token, () => read.call(adapter, request));
          },
        }
      : {}),
  } satisfies PlatformAdapter & GatedProblemDetailAdapter;
  return gated;
}
