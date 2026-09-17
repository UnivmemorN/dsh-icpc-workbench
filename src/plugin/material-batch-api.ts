/**
 * Business API of durable bulk material refresh (Sprint 34A).
 *
 * Six exact `POST /api/icpc/v1/material.*` routes over one {@link MaterialRefreshBatchService}. The
 * accepted single-problem `material.refresh`/`material.supplement` routes live in `business-api.ts`
 * and are untouched: this module adds a separate durable aggregate with its own lifecycle, and its
 * names cannot collide with them.
 *
 * What each route is:
 *
 * - `material.prepare` writes one batch of 1..100 explicit items. It is local and free: no platform
 *   request, no model call, no budget.
 * - `material.start` moves `prepared`/`paused` to `running` durably and answers **202** promptly; the
 *   batch itself runs as the service's owned background work with a global platform concurrency of
 *   one. The answer is the durable batch view, so a caller may poll `material.detail` or
 *   `material.list`.
 * - `material.detail` and `material.list` are local reads.
 * - `material.cancel` and `material.retryFailed` are explicit state transitions; neither performs a
 *   platform request of its own.
 *
 * Three rules shape the module:
 *
 * - **The map is the contract.** Every route's request and response type is the shared
 *   {@link WorkbenchApiMap} entry, so the browser half and this boundary cannot drift.
 * - **Validation precedes side effects.** A strict validator runs in the route's `validate` step, so
 *   a malformed item list, an unknown field, a non-canonical key or a duplicate refuses before the
 *   service reads or writes anything.
 * - **Answers are projections.** The service already projects a batch onto metadata only — identity,
 *   statuses, attempts, retry metadata, snapshot descriptors and counts. Nothing here can add a
 *   statement, an editorial body, a raw tag, an account handle or a provider error text, because no
 *   field of those shapes exists in the response type.
 *
 * No socket, adapter or model is reachable from this file: it delegates to the injected service,
 * which owns every platform call through the accepted single-problem refresh path.
 */
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import type { CancellationToken } from '../domain/index.js';
import type { MaterialRefreshBatchService } from '../application/material-refresh-batch-service.js';
import {
  MATERIAL_BATCH_API_OPERATIONS,
  type WorkbenchApiInput,
  type WorkbenchApiOutput,
} from '../application/workbench-api.js';
import {
  mapBusinessError,
  validateMaterialBatchCancel,
  validateMaterialBatchDetail,
  validateMaterialBatchList,
  validateMaterialBatchPrepare,
  validateMaterialBatchRetryFailed,
  validateMaterialBatchStart,
} from './api-validation.js';
import {
  ApiTransportError,
  registerApiRoute,
  type ApiInternalErrorContext,
  type ApiRouteOptions,
} from './api-transport.js';
import {
  attachCleanupFailures,
  releaseAll,
  releaseOwned,
  reportDisposeFailure,
  type ApiRegistrationOptions,
} from './business-api.js';

/** The six operations this module owns; every one is a real {@link WorkbenchApiMap} key. */
export type MaterialBatchApiOperation =
  | 'material.prepare'
  | 'material.start'
  | 'material.detail'
  | 'material.list'
  | 'material.cancel'
  | 'material.retryFailed';

/** One diagnostics hook, matching the transport's own observer shape. */
export type MaterialBatchApiInternalErrorHook = (error: unknown, context: ApiInternalErrorContext) => void;

export interface RegisterMaterialBatchApiOptions {
  /** Connection Fetch registry the exact routes are registered on. */
  readonly registry: HostConnectionFetch;
  /** The durable bulk material-refresh service; this module never reaches a platform directly. */
  readonly service: MaterialRefreshBatchService;
  /** Observer for failures that are sanitized into a 500; never changes the response. */
  readonly onInternalError?: MaterialBatchApiInternalErrorHook;
  /** Observer for cleanup failures while a partially completed registration rolls back. */
  readonly onDisposeError?: MaterialBatchApiInternalErrorHook;
}

/** One wrapped handler: exact input and exact output of one operation. */
type MaterialBatchHandler<K extends MaterialBatchApiOperation> = (
  input: WorkbenchApiInput<K>,
  token: CancellationToken,
) => Promise<WorkbenchApiOutput<K>>;

/** A validator of one operation, accepting exactly the transport's `unknown` root. */
type MaterialBatchValidator<K extends MaterialBatchApiOperation> = (value: unknown) => WorkbenchApiInput<K>;

/**
 * One runnable route entry.
 *
 * `negotiate` is a non-generic closure that keeps `K` of one operation: the registration loop can
 * only treat the entries uniformly, and re-stating the generic there is what keeps every handler's
 * input exact instead of widening it to "every request".
 */
interface MaterialBatchRouteEntry {
  negotiate(registry: HostConnectionFetch, options: ApiRouteOptions): () => Promise<void>;
}

/**
 * Typed constructor; the operation key is explicit because only that pins `K` at the call site.
 *
 * `successStatus` is 202 for `material.start`: the durable transition is committed before the answer
 * and the platform work continues in the background, which is exactly what a 202 promises.
 */
function batchRoute<K extends MaterialBatchApiOperation>(
  operation: K,
  route: {
    readonly validate: MaterialBatchValidator<K>;
    readonly handle: MaterialBatchHandler<K>;
    readonly successStatus?: 200 | 202;
  },
): MaterialBatchRouteEntry {
  const validate = route.validate;
  const handle = route.handle;
  return {
    negotiate: (registry, options) =>
      registerApiRoute<WorkbenchApiInput<K>, WorkbenchApiOutput<K>>(
        registry,
        {
          operation,
          method: 'POST',
          validate: (value: unknown): WorkbenchApiInput<K> => {
            try {
              return validate(value);
            } catch (error) {
              throw toTransportFailure(error);
            }
          },
          handle: async (input, token): Promise<WorkbenchApiOutput<K>> => {
            try {
              return await handle(input, token);
            } catch (error) {
              throw toTransportFailure(error);
            }
          },
          ...(route.successStatus === undefined ? {} : { successStatus: route.successStatus }),
        },
        options,
      ),
  };
}

/**
 * Convert one thrown value this module may safely describe.
 *
 * A `DomainError` maps by `code` to a fixed message through {@link mapBusinessError}; anything else
 * is rethrown unchanged, so a programming error still reaches the transport's sanitized 500 and its
 * `onInternalError` observer instead of being disguised as a request refusal.
 */
function toTransportFailure(error: unknown): never {
  if (error instanceof ApiTransportError) {
    throw error;
  }
  throw mapBusinessError(error);
}

/**
 * Register the six bulk material-refresh endpoints and return one owned asynchronous disposer.
 *
 * All-or-nothing, exactly like {@link import('./business-api.js').registerBusinessApi}: a route that
 * cannot be registered releases every route registered before it (reverse order, every disposer
 * attempted) before the original failure is rethrown, and the returned disposer is memoized and
 * rejects with one aggregate error when a release could not complete.
 */
export async function registerMaterialBatchApi(
  options: RegisterMaterialBatchApiOptions,
): Promise<() => Promise<void>> {
  const service = requireService(options);
  const routeOptions: ApiRouteOptions =
    options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError };
  const disposers: (() => Promise<void>)[] = [];
  try {
    for (const entry of materialBatchRoutes(service)) {
      disposers.push(entry.negotiate(options.registry, routeOptions));
    }
  } catch (error) {
    const cleanupFailures = await releaseAll(disposers);
    for (const failure of cleanupFailures) {
      reportDisposeFailure(options, failure, true);
    }
    throw attachCleanupFailures(error, cleanupFailures);
  }

  let pending: Promise<void> | null = null;
  return (): Promise<void> => {
    pending ??= releaseOwned(options as ApiRegistrationOptions, disposers);
    return pending;
  };
}

/** Every route of this stage, in registration order; each one names its operation literally. */
function materialBatchRoutes(
  service: MaterialRefreshBatchService,
): readonly MaterialBatchRouteEntry[] {
  return [
    batchRoute(MATERIAL_BATCH_API_OPERATIONS.materialBatchPrepare, {
      validate: validateMaterialBatchPrepare,
      handle: async (input, token) => service.prepare(input, token),
    }),
    batchRoute(MATERIAL_BATCH_API_OPERATIONS.materialBatchStart, {
      successStatus: 202,
      validate: validateMaterialBatchStart,
      handle: async (input, token) => service.start(input.batchId, token),
    }),
    batchRoute(MATERIAL_BATCH_API_OPERATIONS.materialBatchDetail, {
      validate: validateMaterialBatchDetail,
      handle: async (input, token) => service.detail(input.batchId, token),
    }),
    batchRoute(MATERIAL_BATCH_API_OPERATIONS.materialBatchList, {
      validate: validateMaterialBatchList,
      handle: async (input, token) => service.list(input, token),
    }),
    batchRoute(MATERIAL_BATCH_API_OPERATIONS.materialBatchCancel, {
      validate: validateMaterialBatchCancel,
      handle: async (input, token) => service.cancel(input.batchId, token),
    }),
    batchRoute(MATERIAL_BATCH_API_OPERATIONS.materialBatchRetryFailed, {
      validate: validateMaterialBatchRetryFailed,
      handle: async (input, token) => service.retryFailed(input.batchId, token),
    }),
  ];
}

/** Prove the injected registry and service really are the two objects this module needs. */
function requireService(options: RegisterMaterialBatchApiOptions): MaterialRefreshBatchService {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('registerMaterialBatchApi needs an options object');
  }
  if (
    options.registry === null ||
    typeof options.registry !== 'object' ||
    typeof options.registry.register !== 'function'
  ) {
    throw new TypeError('registerMaterialBatchApi needs the connection Fetch registry');
  }
  const service = options.service as Partial<MaterialRefreshBatchService> | null | undefined;
  if (service === null || typeof service !== 'object') {
    throw new TypeError('registerMaterialBatchApi needs a MaterialRefreshBatchService');
  }
  for (const method of ['prepare', 'start', 'detail', 'list', 'cancel', 'retryFailed'] as const) {
    if (typeof service[method] !== 'function') {
      throw new TypeError(`registerMaterialBatchApi needs MaterialRefreshBatchService.${method}()`);
    }
  }
  return service as MaterialRefreshBatchService;
}
