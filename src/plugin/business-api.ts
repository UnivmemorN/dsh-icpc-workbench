/**
 * Business API of the workbench (Stage 4h1): the non-model endpoints.
 *
 * This module registers one exact `POST /api/icpc/v1/<operation>` route per entry of
 * {@link WorkbenchApiMap} on the host Connection Fetch registry and delegates every operation to an
 * already accepted application service. It builds no adapter, opens no socket and touches no model:
 * platform access arrives as an injected `adapterFor(sourceInstanceId)`, so the composition (a later
 * stage) owns which official sources exist and this module stays testable with a fake.
 *
 * Four rules shape every handler:
 *
 * - **The map is the contract.** Each route's request type is the map's own, so a handler cannot
 *   accept a field the browser half does not type or answer with a value it does not expect. The
 *   registered set is exactly {@link WORKBENCH_API_OPERATIONS}: an operation this stage does not own
 *   has no route, not an empty one.
 * - **Side effects come after validation.** Validation runs in the route's `validate` step, before
 *   the handler: canonical problem keys, enums and bounds are checked, and only then does a handler
 *   read the store or call a service, so a refusal cannot leave a created account or a half-applied
 *   import behind.
 * - **Configuration owns identity.** A request names a configured source instance id, never a base
 *   URL or a domain; an id no configured source declares is refused before any read, and the adapter
 *   must prove it is bound to that same instance.
 * - **Answers are projections, never stored rows.** The accepted services already redact spoiler
 *   material, and this module's own writes answer with descriptors built field by field. No handler
 *   returns a `RefreshMaterialReport`, a fetched problem or a parsed document, because those carry
 *   raw platform tags and editorial bodies that a write endpoint must not become a way to read.
 */
import { randomUUID } from 'node:crypto';
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import {
  DomainError,
  assertIsoTimestamp,
  createEditorialSolution,
  createEditorialSource,
  problemKey as canonicalProblemKey,
  type CancellationToken,
  type ProblemRef,
  type SourceInstance,
  type SourcePlatform,
} from '../domain/index.js';
import {
  editorialSourceIdOf,
  type ManualImportBundle,
  type ManualMaterialInput,
  type MaterialReport,
  type RefreshMaterialReport,
  type SupplementMaterialReport,
  type SyncPageReport,
} from '../application/import-types.js';
import { ImportService } from '../application/import-service.js';
import { PlatformError, describePlatformError, isPlatformError } from '../application/platform-errors.js';
import type { PlatformAdapter, PlatformLimits } from '../application/ports.js';
import type { SyncCheckpoint, SyncResource } from '../application/storage-types.js';
import type { TrainingStore } from '../application/ports.js';
import { WorkbenchService } from '../application/workbench-service.js';
import type {
  SettingsStore,
  WorkbenchSettingsRecord,
} from '../application/workbench-settings.js';
import {
  WORKBENCH_API_OPERATIONS,
  type ApiAccountCreateResult,
  type ApiAccountView,
  type ApiEditorialStatusView,
  type ApiImportApplyResult,
  type ApiImportContentSummary,
  type ApiImportIssueView,
  type ApiImportPreviewResult,
  type ApiImportRequest,
  type ApiMaterialDeclarationView,
  type ApiMaterialRefreshResult,
  type ApiMaterialSnapshotView,
  type ApiMaterialSupplementRequest,
  type ApiMaterialSupplementResult,
  type ApiSnapshotWriteView,
  type ApiSourceView,
  type ApiStatementStatusView,
  type ApiSyncCheckpointView,
  type ApiSyncPageRequest,
  type ApiSyncPageResult,
  type WorkbenchApiInput,
  type WorkbenchApiMap,
  type WorkbenchApiOperation,
  type WorkbenchApiOutput,
} from '../application/workbench-api.js';
import {
  mapBusinessError,
  mapPlatformFailure,
  requireCallToken,
  validateAccountCreate,
  validateImportApply,
  validateImportPreview,
  validateMaterialRefresh,
  validateMaterialSupplement,
  validatePlanAdopt,
  validatePlanCheckoff,
  validatePlanDetail,
  validatePlanEdit,
  validatePlanList,
  validatePlanPreview,
  validateProblemDetail,
  validateProblemList,
  validateRetroRecord,
  validateReviewTag,
  validateSyncPage,
  validateWeakness,
} from './api-validation.js';
import {
  ApiTransportError,
  registerApiRoute,
  type ApiInternalErrorContext,
} from './api-transport.js';
import { manualAttributionUrl, parseManualCsv, parseManualJson } from '../adapters/manual/index.js';
import { createCodeforcesAccount } from '../adapters/codeforces/index.js';
import { createLuoguAccount } from '../adapters/luogu/index.js';

/** Full path of one API route, so a caller never repeats the prefix by hand. */
export type BusinessApiPath<K extends WorkbenchApiOperation> = `/api/icpc/v1/${K}`;

/**
 * One official platform instance the workbench may address.
 *
 * The configured instance — never a request field — is the authority for base URL and domain, so a
 * caller cannot point an adapter at another host. `manual` and `hydro` are deliberately not
 * addressable here: v1 has no official adapter for them, and manual records arrive through
 * `import.*` instead.
 */
export interface BusinessSourceConfig {
  readonly instance: SourceInstance;
}

/** One diagnostics hook, matching the transport's own observer shape. */
export type BusinessApiInternalErrorHook = (error: unknown, context: ApiInternalErrorContext) => void;

export interface RegisterBusinessApiOptions {
  /** Connection Fetch registry the exact routes are registered on. */
  readonly registry: HostConnectionFetch;
  /** Persistence: the account write of `account.create` plus every read the services make. */
  readonly store: TrainingStore;
  readonly imports: ImportService;
  readonly workbench: WorkbenchService;
  /**
   * Resolve the official adapter of one configured source instance.
   *
   * Composition supplies this; the plugin never constructs an adapter itself. The returned adapter
   * must be bound to the requested instance — a mismatch is refused rather than used.
   */
  readonly adapterFor: (sourceInstanceId: string) => Promise<PlatformAdapter>;
  /** Official source instances this workbench may address (Codeforces and Luogu in v1). */
  readonly sources: readonly BusinessSourceConfig[];
  /** Current stored settings; defaults to the store's own reader when it implements {@link SettingsStore}. */
  readonly settings?: () => Promise<WorkbenchSettingsRecord | null>;
  /** Injected clock for persisted timestamps and import provenance. */
  readonly now?: () => string;
  /** Injected id source for page/preview ids; defaults to random UUIDs. */
  readonly uniqueId?: () => string;
  /** Observer for failures that are sanitized into a 500; never changes the response. */
  readonly onInternalError?: BusinessApiInternalErrorHook;
  /** Observer for cleanup failures while a partially completed registration rolls back. */
  readonly onDisposeError?: BusinessApiInternalErrorHook;
}

/** Operation keys of the map, needed to index it generically. */
type BusinessOperation = keyof WorkbenchApiMap;

/** One wrapped handler: exact input and exact output of one operation. */
type BusinessHandler<K extends BusinessOperation> = (
  input: WorkbenchApiInput<K>,
  token: CancellationToken,
) => Promise<WorkbenchApiOutput<K>>;

/** A validator of one operation, accepting exactly the transport's `unknown` root. */
type BusinessValidator<K extends BusinessOperation> = (value: unknown) => WorkbenchApiInput<K>;

/**
 * One runnable route entry.
 *
 * `negotiate` is a non-generic closure that keeps `K` of one operation: the loop that registers the
 * routes can only treat them uniformly, and re-stating the generic there is what makes the register
 * call itself type-safe without widening any handler's input to "every request".
 */
interface BusinessRouteEntry {
  readonly operation: BusinessOperation;
  negotiate(registry: HostConnectionFetch, options: { readonly onInternalError?: BusinessApiInternalErrorHook }): () => Promise<void>;
}

/**
 * Typed constructor.
 *
 * The operation key is explicit, because only that pins `K` at the call site: inside a heterogeneous
 * array a contextual element type would widen `K` to every operation, and one handler's request would
 * have to satisfy all of them.
 */
function businessRoute<K extends BusinessOperation>(
  operation: K,
  route: { readonly method: 'POST'; readonly validate: BusinessValidator<K>; readonly handle: BusinessHandler<K> },
): BusinessRouteEntry {
  const validate = route.validate;
  const handle = route.handle;
  return {
    operation,
    negotiate: (registry, options) =>
      registerApiRoute<WorkbenchApiInput<K>, WorkbenchApiOutput<K>>(
        registry,
        {
          operation,
          method: route.method,
          // Both steps pass through one guard: the services refuse bad input with a `DomainError`,
          // which the transport would sanitize into a 500. An unknown failure is rethrown unchanged,
          // so the transport's sanitized 500 still reaches its observer.
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
        },
        options,
      ),
  };
}

/**
 * Convert one thrown value a route may safely describe.
 *
 * A `DomainError` maps by `code` to a fixed message. A `PlatformError` with `invalid_input` means
 * an official account factory refused the caller's own handle, so that is the caller's 400; every
 * other operational platform code belongs in a handler's own report and stays an unexpected 500.
 * Anything else is rethrown as-is — {@link mapBusinessError} never invents a transport failure, so
 * the transport's sanitized 500 and its `onInternalError` observer still see the real error.
 */
function toTransportFailure(error: unknown): never {
  if (error instanceof ApiTransportError) {
    throw error;
  }
  if (error instanceof PlatformError && error.code === 'invalid_input') {
    throw new ApiTransportError('invalid_input', 'the request is invalid');
  }
  throw mapBusinessError(error);
}

/**
 * Register every business endpoint and return one owned asynchronous disposer.
 *
 * Registration is all-or-nothing: when one route cannot be registered, every route registered before
 * it is released again — in reverse order, with every disposer attempted — before the original
 * failure is rethrown. A cleanup that itself fails is reported through `onDisposeError` (or one
 * fixed, detail-free process warning) and attached to the rethrown failure, so neither failure is
 * lost.
 *
 * The returned disposer is memoized: repeated and concurrent calls await the same promise. A release
 * that could not complete every step rejects with one aggregate error after reporting every failure,
 * so a caller cannot mistake a leaked registration for a clean shutdown.
 */
export async function registerBusinessApi(options: RegisterBusinessApiOptions): Promise<() => Promise<void>> {
  const context = apiContext(options);
  const routeOptions: { readonly onInternalError?: BusinessApiInternalErrorHook } =
    options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError };
  const disposers: (() => Promise<void>)[] = [];
  try {
    for (const route of businessRoutes(context)) {
      disposers.push(route.negotiate(options.registry, routeOptions));
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
    pending ??= releaseOwned(options, disposers);
    return pending;
  };
}

/** Release registrations in reverse order, collecting failures instead of stopping at the first. */
async function releaseAll(disposers: readonly (() => Promise<void>)[]): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    const dispose = disposers[index];
    if (dispose === undefined) {
      continue;
    }
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** Release the owned registrations, report every failure and reject when any step failed. */
async function releaseOwned(
  options: RegisterBusinessApiOptions,
  disposers: readonly (() => Promise<void>)[],
): Promise<void> {
  const failures = await releaseAll(disposers);
  for (const failure of failures) {
    reportDisposeFailure(options, failure, false);
  }
  if (failures.length > 0) {
    throw cleanupError(failures);
  }
}

/** One aggregate failure of a release; every individual failure was already reported. */
interface CleanupError extends Error {
  cleanupFailures: readonly unknown[];
}

function cleanupError(failures: readonly unknown[]): CleanupError {
  const error = new Error(
    `the business API could not be released: ${failures.length} registration disposer(s) failed`,
  ) as CleanupError;
  error.name = 'BusinessApiCleanupError';
  error.cleanupFailures = failures;
  return error;
}

/** Attach cleanup failures to the original registration failure without replacing it. */
function attachCleanupFailures(error: unknown, failures: readonly unknown[]): unknown {
  if (failures.length === 0 || error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return error;
  }
  try {
    Object.defineProperty(error, 'cleanupFailures', { value: failures, enumerable: false, configurable: true });
  } catch (attachFailure) {
    // A frozen or exotic error still reaches the caller unchanged; the failures were reported above.
    void attachFailure;
  }
  return error;
}

/** Report one cleanup failure without ever replacing the failure that caused the rollback. */
function reportDisposeFailure(
  options: RegisterBusinessApiOptions,
  failure: unknown,
  rollingBack: boolean,
): void {
  const context: ApiInternalErrorContext = { operation: 'registration.cleanup', method: 'POST' };
  if (options.onDisposeError !== undefined) {
    try {
      options.onDisposeError(failure, context);
      return;
    } catch (observerFailure) {
      // The hook is diagnostics only; its own failure cannot be reported twice, so one fixed warning
      // stands in for it and prints neither failure.
      void observerFailure;
      emitDisposeWarning(rollingBack);
      return;
    }
  }
  emitDisposeWarning(rollingBack);
}

/** One fixed, detail-free process warning; a cleanup failure can quote a path or a provider string. */
function emitDisposeWarning(rollingBack: boolean): void {
  try {
    process.emitWarning(
      `dsh-icpc-workbench: a business-api registration could not be released${
        rollingBack ? ' while rolling back a failed registration' : ''
      }`,
      { code: 'ICPC_API_DISPOSE_FAILED' },
    );
  } catch (warningFailure) {
    // A host without process warnings still keeps the original failure; there is no other channel.
    void warningFailure;
  }
}

// ---------------------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------------------

/**
 * Every route of this stage, in registration order.
 *
 * Each entry names its operation literally next to its strict validator and one handler. The
 * literal key is what pins that entry's request and response types: inside a heterogeneous array a
 * contextual element type would widen them to "every operation", and one handler's request would
 * have to satisfy all of them. Nothing else is registered — a later stage appends its own entries
 * (batch, coaching, model catalog, settings, bootstrap) instead of extending these.
 */
function businessRoutes(context: ApiContext): readonly BusinessRouteEntry[] {
  return [
    businessRoute(WORKBENCH_API_OPERATIONS.accountCreate, {
      method: 'POST',
      validate: validateAccountCreate,
      handle: async (input, token) => createAccount(context, input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.syncPage, {
      method: 'POST',
      validate: validateSyncPage,
      handle: async (input, token) => syncPage(context, input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.importPreview, {
      method: 'POST',
      validate: validateImportPreview,
      handle: async (input) => previewImport(context, input),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.importApply, {
      method: 'POST',
      validate: validateImportApply,
      handle: async (input, token) => applyImport(context, input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.materialRefresh, {
      method: 'POST',
      validate: validateMaterialRefresh,
      handle: async (input, token) => refreshMaterial(context, input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.materialSupplement, {
      method: 'POST',
      validate: validateMaterialSupplement,
      handle: async (input, token) => supplementMaterial(context, input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.problemList, {
      method: 'POST',
      validate: validateProblemList,
      handle: async (input, token) => context.workbench.listProblems(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.problemDetail, {
      method: 'POST',
      validate: validateProblemDetail,
      handle: async (input, token) => context.workbench.getProblem(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.reviewTag, {
      method: 'POST',
      validate: validateReviewTag,
      handle: async (input, token) => context.workbench.reviewTag(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.retroRecord, {
      method: 'POST',
      validate: validateRetroRecord,
      handle: async (input, token) => context.workbench.recordRetrospective(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.weakness, {
      method: 'POST',
      validate: validateWeakness,
      handle: async (input, token) => context.workbench.weakness(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.planPreview, {
      method: 'POST',
      validate: validatePlanPreview,
      handle: async (input, token) => context.workbench.previewPlan(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.planList, {
      method: 'POST',
      validate: validatePlanList,
      handle: async (input, token) => context.workbench.listPlans(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.planDetail, {
      method: 'POST',
      validate: validatePlanDetail,
      handle: async (input, token) => context.workbench.getPlan(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.planAdopt, {
      method: 'POST',
      validate: validatePlanAdopt,
      handle: async (input, token) => context.workbench.adoptPlan(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.planEdit, {
      method: 'POST',
      validate: validatePlanEdit,
      handle: async (input, token) => context.workbench.editPlanTask(input, token),
    }),
    businessRoute(WORKBENCH_API_OPERATIONS.planCheckoff, {
      method: 'POST',
      validate: validatePlanCheckoff,
      handle: async (input, token) => context.workbench.checkOffTask(input, token),
    }),
  ];
}

// ---------------------------------------------------------------------------------------
// Handler context and dependencies
// ---------------------------------------------------------------------------------------

/** Validated dependencies every handler closes over. */
interface ApiContext {
  readonly store: TrainingStore;
  readonly imports: ImportService;
  readonly workbench: WorkbenchService;
  readonly adapterFor: (sourceInstanceId: string) => Promise<PlatformAdapter>;
  readonly sources: readonly BusinessSourceConfig[];
  readonly settings: () => Promise<WorkbenchSettingsRecord | null>;
  readonly now: () => string;
  readonly uniqueId: () => string;
}

function apiContext(options: RegisterBusinessApiOptions): ApiContext {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('registerBusinessApi needs an options object');
  }
  if (options.store === null || typeof options.store !== 'object' || typeof options.store.transaction !== 'function') {
    throw new TypeError('registerBusinessApi needs a store implementing TrainingStore.transaction()');
  }
  if (
    options.imports === null ||
    typeof options.imports !== 'object' ||
    typeof options.imports.syncPage !== 'function' ||
    typeof options.imports.applyManual !== 'function'
  ) {
    throw new TypeError('registerBusinessApi needs an ImportService');
  }
  if (options.workbench === null || typeof options.workbench !== 'object') {
    throw new TypeError('registerBusinessApi needs a WorkbenchService');
  }
  if (typeof options.adapterFor !== 'function') {
    throw new TypeError('registerBusinessApi needs an injected adapterFor(sourceInstanceId)');
  }
  if (!Array.isArray(options.sources)) {
    throw new TypeError('registerBusinessApi needs the configured official sources');
  }
  const settings = options.settings ?? settingsReader(options.store);
  return {
    store: options.store,
    imports: options.imports,
    workbench: options.workbench,
    adapterFor: options.adapterFor,
    sources: options.sources,
    settings,
    now: options.now ?? ((): string => new Date().toISOString()),
    uniqueId: options.uniqueId ?? ((): string => randomUUID()),
  };
}

/** Settings read through the store itself when the composition does not inject a reader. */
function settingsReader(store: TrainingStore): () => Promise<WorkbenchSettingsRecord | null> {
  const candidate = store as Partial<SettingsStore>;
  if (typeof candidate.getWorkbenchSettings !== 'function') {
    throw new TypeError('registerBusinessApi needs settings() or a store implementing getWorkbenchSettings()');
  }
  const read = candidate.getWorkbenchSettings.bind(candidate);
  return async () => read();
}

/** Current platform limits; a workbench without validated settings cannot sync or refresh. */
async function platformLimits(context: ApiContext): Promise<PlatformLimits> {
  const record = await context.settings();
  if (record === null || record === undefined || record.value === null || typeof record.value !== 'object') {
    throw new DomainError('unfilled_settings', 'the workbench settings are not configured', {});
  }
  return record.value.platformLimits;
}

/**
 * The configured source instance of one id.
 *
 * The configuration — not the request — owns the identity, so a caller cannot substitute a base URL
 * or a domain. An id that no configured source declares is refused before any read.
 */
function configuredSource(context: ApiContext, sourceInstanceId: string): SourceInstance {
  const match = context.sources.find((source) => source.instance.id === sourceInstanceId);
  if (match === undefined) {
    throw new DomainError('missing_reference', `source instance ${sourceInstanceId} is not configured`, {
      sourceInstanceId,
    });
  }
  return match.instance;
}

/** The configured official instance of one platform; v1 configures exactly one per platform. */
function sourceOfPlatform(context: ApiContext, platform: SourcePlatform): SourceInstance {
  const matches = context.sources.filter((source) => source.instance.platform === platform);
  if (matches.length === 0) {
    throw new DomainError('unfilled_settings', `no ${platform} source instance is configured`, { platform });
  }
  if (matches.length > 1) {
    throw new DomainError('unfilled_settings', `${platform} has more than one configured source instance`, {
      platform,
      count: matches.length,
    });
  }
  const match = matches[0];
  if (match === undefined) {
    throw new DomainError('unfilled_settings', `no ${platform} source instance is configured`, { platform });
  }
  return match.instance;
}

/** Resolve the official adapter and prove it is bound to the instance that was asked for. */
async function adapterOf(context: ApiContext, instance: SourceInstance): Promise<PlatformAdapter> {
  const adapter = await context.adapterFor(instance.id);
  if (!isPlatformAdapter(adapter)) {
    throw new DomainError('unfilled_settings', `the adapter for ${instance.id} is not a platform adapter`, {
      sourceInstanceId: instance.id,
    });
  }
  if (adapter.sourceInstance?.id !== instance.id) {
    throw new DomainError(
      'invalid_input',
      `the adapter for ${instance.id} is bound to ${String(adapter.sourceInstance?.id)}`,
      { reason: 'adapter_source_mismatch', sourceInstanceId: instance.id },
    );
  }
  return adapter;
}

/** Structural check of one injected value against the platform adapter contract. */
export function isPlatformAdapter(value: unknown): value is PlatformAdapter {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PlatformAdapter).listProblems === 'function' &&
    typeof (value as PlatformAdapter).fetchEditorial === 'function' &&
    typeof (value as PlatformAdapter).capabilities === 'function'
  );
}

// ---------------------------------------------------------------------------------------
// account.create
// ---------------------------------------------------------------------------------------

/** Persist one official account (and its instance) in one transaction. */
async function createAccount(
  context: ApiContext,
  input: WorkbenchApiInput<'account.create'>,
  token: CancellationToken,
): Promise<ApiAccountCreateResult> {
  requireCallToken(token);
  const platform: SourcePlatform = input.platform;
  const instance = sourceOfPlatform(context, platform);
  // Identity comes from the official factory only: a handle is canonicalized there (Codeforces
  // lowercases its own handle space, Luogu requires a canonical decimal UID), so this endpoint can
  // never create two accounts for one person by accepting a second spelling.
  const account =
    platform === 'codeforces'
      ? createCodeforcesAccount(instance, input.handle, input.displayName ?? null)
      : platform === 'luogu'
        ? createLuoguAccount(instance, input.handle, input.displayName ?? null)
        : neverPlatform(platform);
  // Source and account are written together: an account whose instance row is missing could not be
  // used for any later sync, and a half-written pair would stay invisible until then.
  const stored = await context.store.transaction(async () => {
    token.throwIfCancelled();
    await context.store.upsertSourceInstances([instance]);
    token.throwIfCancelled();
    await context.store.upsertAccounts([account]);
    token.throwIfCancelled();
    return await context.store.getAccount(account.id);
  });
  if (stored === null) {
    throw new DomainError('invalid_transition', `account ${account.id} was not stored`, { accountId: account.id });
  }
  return { account: accountView(stored), source: sourceView(instance) };
}

/** Unreachable through the validator; reported as a typed refusal rather than a cast. */
function neverPlatform(platform: SourcePlatform): never {
  throw new DomainError('invalid_input', `platform ${platform} has no official account factory`, { platform });
}

function accountView(account: {
  readonly id: string;
  readonly sourceInstanceId: string;
  readonly handle: string;
  readonly displayName: string | null;
  readonly profileUrl: string | null;
}): ApiAccountView {
  return {
    id: account.id,
    sourceInstanceId: account.sourceInstanceId,
    handle: account.handle,
    displayName: account.displayName,
    profileUrl: account.profileUrl,
  };
}

function sourceView(instance: SourceInstance): ApiSourceView {
  return {
    id: instance.id,
    platform: instance.platform,
    domain: instance.domain,
    displayName: instance.displayName,
  };
}

// ---------------------------------------------------------------------------------------
// sync.page
// ---------------------------------------------------------------------------------------

/** One adapter page; an operational failure is reported as data, not as a thrown body. */
async function syncPage(
  context: ApiContext,
  input: ApiSyncPageRequest,
  token: CancellationToken,
): Promise<ApiSyncPageResult> {
  requireCallToken(token);
  const configured = configuredSource(context, input.sourceInstanceId);
  const storedSource = await context.store.getSourceInstance(configured.id);
  token.throwIfCancelled();
  if (storedSource === null) {
    throw new DomainError('missing_reference', `source instance ${configured.id} is not stored yet`, {
      sourceInstanceId: configured.id,
    });
  }

  const resource: SyncResource = input.resource;
  let account: Awaited<ReturnType<TrainingStore['getAccount']>> = null;
  if (input.accountId !== null) {
    account = await context.store.getAccount(input.accountId);
    token.throwIfCancelled();
    if (account === null) {
      throw new DomainError('missing_reference', `account ${input.accountId} is not stored`, {
        accountId: input.accountId,
      });
    }
    if (account.sourceInstanceId !== storedSource.id) {
      // A foreign account would bind a checkpoint (and a history) to the wrong instance.
      throw new DomainError(
        'missing_reference',
        `account ${account.id} belongs to ${account.sourceInstanceId}, not ${storedSource.id}`,
        { reason: 'account_source_mismatch', accountId: account.id, sourceInstanceId: storedSource.id },
      );
    }
  }
  if (resource === 'submissions' && account === null) {
    throw new DomainError('invalid_input', 'submission sync requires an account id', { resource });
  }

  // Capabilities are checked before any request, so an unsupported operation is an explicit refusal
  // instead of a page that silently returns nothing.
  const adapter = await adapterOf(context, storedSource);
  token.throwIfCancelled();
  const capabilities = adapter.capabilities();
  const supported = resource === 'submissions' ? capabilities.submissions : capabilities.problems;
  if (!capabilities.implemented || !supported) {
    return unavailableSyncResult(input, storedSource, account, `unsupported:${resource}`);
  }
  const limits = await platformLimits(context);
  token.throwIfCancelled();

  let report: SyncPageReport;
  try {
    report = await context.imports.syncPage(adapter, {
      resource,
      account,
      mode: input.mode,
      ...(input.since === undefined ? {} : { since: input.since }),
      limit: input.limit,
      limits,
      token,
    });
  } catch (error) {
    if (!isPlatformError(error)) {
      throw error;
    }
    const failure = describePlatformError(error, resource === 'submissions' ? 'submissions' : 'catalog');
    if (failure.code === 'cancelled') {
      token.throwIfCancelled();
    }
    return {
      ...unavailableSyncResult(input, storedSource, account, null),
      failure: mapPlatformFailure(failure),
    };
  }
  token.throwIfCancelled();
  return {
    ok: true,
    resource: report.resource,
    mode: report.mode,
    sourceInstanceId: report.sourceInstanceId,
    accountId: report.accountId,
    since: report.since,
    cursor: report.cursor,
    nextCursor: report.nextCursor,
    complete: report.complete,
    counts: report.counts,
    checkpoint: checkpointView(report.checkpoint),
    pageFetchedAt: report.pageFetchedAt,
    failure: null,
    unavailableReason: null,
  };
}

/** A page that did not commit: no cursor moved, no count invented. */
function unavailableSyncResult(
  input: ApiSyncPageRequest,
  source: SourceInstance,
  account: { readonly id: string } | null,
  reason: string | null,
): ApiSyncPageResult {
  return {
    ok: false,
    resource: input.resource,
    mode: input.mode,
    sourceInstanceId: source.id,
    accountId: account === null ? null : account.id,
    since: input.since ?? null,
    cursor: null,
    nextCursor: null,
    complete: false,
    counts: null,
    checkpoint: null,
    pageFetchedAt: null,
    failure: null,
    unavailableReason: reason,
  };
}

function checkpointView(checkpoint: SyncCheckpoint): ApiSyncCheckpointView {
  return {
    sourceInstanceId: checkpoint.sourceInstanceId,
    accountId: checkpoint.accountId,
    resource: checkpoint.resource,
    cursor: checkpoint.cursor,
    since: checkpoint.since,
    updatedAt: checkpoint.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------
// import.preview / import.apply
// ---------------------------------------------------------------------------------------

/** Parse and report; this operation writes nothing and returns no parsed row. */
function previewImport(context: ApiContext, input: ApiImportRequest): ApiImportPreviewResult {
  const outcome = parseManualDocument(context, input);
  if (!outcome.ok) {
    return { parsed: false, issues: issueViews(outcome.errors) };
  }
  const document = outcome.document;
  return {
    parsed: true,
    counts: contentSummary(document.preview),
    contentHash: document.contentHash,
    source: sourceView(document.source),
  };
}

/**
 * Apply one validated document.
 *
 * The document is parsed again here, at the server's own clock, and the caller's `expectedHash` is
 * compared with the freshly parsed content hash: a document that changed between preview and apply is
 * refused explicitly instead of being applied silently. The hash covers semantic content and excludes
 * observation timestamps, so a preview stays valid across a clock tick.
 */
async function applyImport(
  context: ApiContext,
  input: ApiImportRequest,
  token: CancellationToken,
): Promise<ApiImportApplyResult> {
  requireCallToken(token);
  if (input.expectedHash === undefined) {
    throw new ApiTransportError('invalid_input', 'import.apply requires the expectedHash of a previewed document');
  }
  const outcome = parseManualDocument(context, input);
  if (!outcome.ok) {
    // The parser's own rejections are the honest answer; the caller re-previews instead of applying
    // a partially valid document.
    throw new ApiTransportError('invalid_input', 'the manual document is invalid; preview it for the issues');
  }
  if (outcome.document.contentHash !== input.expectedHash) {
    throw new DomainError('invalid_transition', 'the manual document changed since it was previewed', {
      expected: input.expectedHash,
      actual: outcome.document.contentHash,
    });
  }
  const report = await context.imports.applyManual(toImportBundle(outcome.document), token);
  return {
    sourceInstanceId: report.sourceInstanceId,
    accountsProcessed: report.accountsProcessed,
    problems: {
      inserted: report.problems.inserted,
      updated: report.problems.updated,
      unchanged: report.problems.unchanged,
    },
    submissionsProcessed: report.submissionsProcessed,
    materials: report.materials.map(materialView),
    snapshots: report.snapshots.map(snapshotWriteView),
    changedSnapshots: report.changedSnapshots,
  };
}

/** One parse with the injected clock; the JSON and CSV shapes share the whole pipeline. */
function parseManualDocument(context: ApiContext, input: ApiImportRequest) {
  const importedAt = assertIsoTimestamp('now', context.now());
  if (input.format === 'json') {
    return parseManualJson(input.text, { importedAt });
  }
  const csv = input.csv;
  if (csv === undefined) {
    // Unreachable through the validator, which requires the context for `format: 'csv'`; kept as a
    // typed refusal so the helper is safe if it is ever called from another path.
    throw new ApiTransportError('invalid_input', 'a CSV import requires the csv reference context');
  }
  return parseManualCsv(input.text, {
    kind: csv.kind,
    source: csv.source,
    ...(csv.accounts === undefined ? {} : { accounts: csv.accounts }),
    ...(csv.problems === undefined ? {} : { problems: csv.problems }),
    ...(csv.editorials === undefined ? {} : { editorials: csv.editorials }),
    importedAt,
  });
}

/**
 * Reduce one parsed document to the application's own bundle.
 *
 * Only the editorial records the document declares become material entries; every other problem keeps
 * whatever material is already stored, exactly as the parser's `unavailable` placeholder means. A
 * `found` record already carries the page's real source and solution objects, so nothing is rebuilt
 * here — the adapter's citation (kind, URL, title, retrieval time, content hash) is preserved.
 */
function toImportBundle(document: {
  readonly source: SourceInstance;
  readonly accounts: ManualImportBundle['accounts'];
  readonly problems: ManualImportBundle['problems'];
  readonly submissions: ManualImportBundle['submissions'];
  readonly editorials: readonly {
    readonly problemKey: string;
    readonly url: string | null;
    readonly title: string | null;
    readonly note: string | null;
    readonly result: ManualMaterialInput['result'];
  }[];
}): ManualImportBundle {
  const materials: ManualMaterialInput[] = document.editorials.map((entry) => ({
    problemKey: entry.problemKey,
    result: entry.result,
    url: entry.url,
    title: entry.title,
    note: entry.note,
  }));
  return {
    source: document.source,
    accounts: document.accounts,
    problems: document.problems,
    submissions: document.submissions,
    materials,
  };
}

function issueViews(issues: readonly ApiImportIssueView[]): readonly ApiImportIssueView[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path,
    row: issue.row,
    line: issue.line,
    field: issue.field,
  }));
}

function contentSummary(preview: ApiImportContentSummary): ApiImportContentSummary {
  return {
    accounts: preview.accounts,
    problems: preview.problems,
    submissions: preview.submissions,
    editorialsFound: preview.editorialsFound,
    editorialsAbsent: preview.editorialsAbsent,
    editorialsUnavailable: preview.editorialsUnavailable,
    rows: preview.rows,
    bytes: preview.bytes,
  };
}

function materialView(report: MaterialReport): ApiMaterialDeclarationView {
  return {
    problemKey: report.problemKey,
    outcome: report.outcome,
    availability: report.availability,
    freshFound: report.freshFound,
    staleCachedAvailability: report.staleCachedAvailability,
    sources: report.sources,
    solutions: report.solutions,
  };
}

function snapshotWriteView(write: {
  readonly problemKey: string;
  readonly snapshotId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly changed: boolean;
}): ApiSnapshotWriteView {
  return {
    problemKey: write.problemKey,
    snapshotId: write.snapshotId,
    version: write.version,
    contentHash: write.contentHash,
    capturedAt: write.capturedAt,
    changed: write.changed,
  };
}

// ---------------------------------------------------------------------------------------
// material.refresh
// ---------------------------------------------------------------------------------------

/**
 * Refresh one stored problem's statement and editorial material through its official adapter.
 *
 * The answer is this module's own projection, never the service's report: a
 * {@link RefreshMaterialReport} carries the merged problem (raw platform tags), the fetched problem
 * and the editorial result (source list and solution bodies). Those are spoilers, and a write endpoint
 * must not become a way to read them, so only identity, statuses, counts and retry metadata return.
 */
async function refreshMaterial(
  context: ApiContext,
  input: WorkbenchApiInput<'material.refresh'>,
  token: CancellationToken,
): Promise<ApiMaterialRefreshResult> {
  requireCallToken(token);
  const ref = await storedRef(context, input.problemKey, token);
  const adapter = await adapterOf(context, configuredSource(context, ref.sourceInstanceId));
  token.throwIfCancelled();
  const limits = await platformLimits(context);
  token.throwIfCancelled();

  const report = await context.imports.refreshMaterial(adapter, {
    problemRef: ref,
    fetchStatement: input.fetchStatement,
    ...(input.officialTutorialUrl === undefined ? {} : { officialTutorialUrl: input.officialTutorialUrl }),
    token,
    limits,
  });
  token.throwIfCancelled();
  return {
    problemKey: report.problemKey,
    snapshot: report.snapshot === null ? null : materialSnapshotView(report.snapshot, report.material),
    statement: statementStatusView(report),
    editorial: editorialStatusView(report),
    material: report.material === null ? null : materialView(report.material),
  };
}

/** Head metadata after a refresh: the snapshot descriptor plus the material counts it holds. */
function materialSnapshotView(
  write: ApiSnapshotWriteView,
  material: MaterialReport | null,
): ApiMaterialSnapshotView {
  return {
    snapshotId: write.snapshotId,
    version: write.version,
    contentHash: write.contentHash,
    capturedAt: write.capturedAt,
    sourceCount: material === null ? 0 : material.sources,
    solutionCount: material === null ? 0 : material.solutions,
  };
}

/** Statement outcome: identity and observation time of a real fetch, never a body. */
function statementStatusView(report: RefreshMaterialReport): ApiStatementStatusView {
  const fetched = report.statement.fetchedProblem;
  return {
    status: report.statement.status,
    title: fetched === null ? null : fetched.title,
    url: fetched === null ? null : fetched.url,
    fetchedAt: fetched === null ? null : fetched.fetchedAt,
    failure: report.statement.error === null ? null : mapPlatformFailure(report.statement.error),
  };
}

/** Editorial outcome: the availability discriminant and counts, never a source or solution body. */
function editorialStatusView(report: RefreshMaterialReport): ApiEditorialStatusView {
  const result = report.editorial.result;
  const found = result !== null && result.status === 'found' ? result : null;
  return {
    attempted: report.editorial.attempted,
    status: result === null ? null : result.status,
    sourceCount: found === null ? 0 : found.sources.length,
    solutionCount: found === null ? 0 : found.solutions.length,
    failure: report.editorial.error === null ? null : mapPlatformFailure(report.editorial.error),
    skippedReason: report.editorial.skippedReason,
  };
}

/** The stored reference of one problem key; an unknown key is a not-found, never an empty row. */
async function storedRef(context: ApiContext, problemKey: string, token: CancellationToken): Promise<ProblemRef> {
  const problem = await context.store.getProblem(problemKey);
  token.throwIfCancelled();
  if (problem === null) {
    throw new DomainError('missing_reference', `problem ${problemKey} is not stored`, { problemKey });
  }
  const canonical = canonicalProblemKey(problem.ref);
  if (canonical !== problemKey || problem.key !== problemKey) {
    throw new DomainError('invalid_input', `stored problem ${problem.key} does not match the requested key`, {
      reason: 'problem_key_mismatch',
      requested: problemKey,
      stored: problem.key,
    });
  }
  return problem.ref;
}

// ---------------------------------------------------------------------------------------
// material.supplement
// ---------------------------------------------------------------------------------------

/**
 * Add a manually supplied statement and/or editorial declaration to a stored problem.
 *
 * The client never re-imports the problem: the stored row keeps its title, URL, ratings and raw
 * platform tags, and only the fields this request names are replaced. A supplied article becomes one
 * `solution` source addressed by the stable id derived from the problem and its URL, so editing the
 * same URL replaces exactly that source and leaves other articles intact.
 */
async function supplementMaterial(
  context: ApiContext,
  input: ApiMaterialSupplementRequest,
  token: CancellationToken,
): Promise<ApiMaterialSupplementResult> {
  requireCallToken(token);
  const ref = await storedRef(context, input.problemKey, token);
  const material = input.editorial === undefined ? null : supplementInput(context, ref, input.editorial);
  const report: SupplementMaterialReport = await context.imports.supplementMaterial(
    {
      problemKey: input.problemKey,
      expectedSnapshotId: input.expectedSnapshotId,
      ...(input.statement === undefined ? {} : { statement: input.statement }),
      ...(material === null ? {} : { material }),
    },
    token,
  );
  token.throwIfCancelled();
  return {
    problemKey: report.problemKey,
    expectedSnapshotId: input.expectedSnapshotId,
    snapshot: snapshotWriteView(report.snapshot),
    material: report.material === null ? null : materialView(report.material),
  };
}

/**
 * Build the application's material declaration from one supplied editorial.
 *
 * The URL is attribution and is validated by the manual parser's own URL rule (absolute http(s), no
 * userinfo); it is never fetched. A `found` record carries exactly one write-up, so the solution
 * ordinal is always 0 in v1, and the source keeps the caller's citation through its kind, title and
 * URL. Both records are built through the domain factories, which derive the sha256 content hashes
 * the service re-validates — a hand-built record with a `null` or empty hash would be rejected there.
 */
function supplementInput(
  context: ApiContext,
  ref: ProblemRef,
  editorial: NonNullable<ApiMaterialSupplementRequest['editorial']>,
): ManualMaterialInput {
  const url = manualAttributionUrl(editorial.url);
  if (url === null) {
    throw new ApiTransportError('invalid_input', 'editorial.url must be an absolute http(s) URL without credentials');
  }
  // Identity comes from the domain's own key function, never from a second encoding maintained here.
  const problemKey = canonicalProblemKey(ref);
  const retrievedAt = assertIsoTimestamp('now', context.now());
  if (editorial.status === 'absent') {
    // An explicit absence is a decision, not the result of a failed fetch: it keeps the note that
    // explains how absence was established.
    return {
      problemKey,
      result: { status: 'absent', detail: editorial.note },
      url,
      title: editorial.title,
      note: editorial.note,
    };
  }
  const sourceId = editorialSourceIdOf(ref, url);
  const language = editorial.language ?? null;
  const source = createEditorialSource({
    id: sourceId,
    kind: 'solution',
    url,
    title: editorial.title,
    availability: 'found',
    retrievedAt,
    text: editorial.text,
    language,
  });
  const solution = createEditorialSolution({
    solutionId: `${sourceId}-solution-0`,
    sourceId,
    ordinal: 0,
    title: editorial.title,
    text: editorial.text,
    language,
  });
  return {
    problemKey,
    result: { status: 'found', sources: [source], solutions: [solution], retrievedAt },
    url: null,
    title: null,
    note: null,
  };
}

/** A `PlatformError` that escaped a service call keeps its own code when it is reported. */
export function platformErrorCode(error: unknown): PlatformError['code'] | null {
  return isPlatformError(error) ? error.code : null;
}
