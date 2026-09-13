/**
 * Typed Luogu API (Sprint 17d1): connection, settings and synchronization over the durable service.
 *
 * This module registers one exact authenticated `POST /api/icpc/v1/<operation>` route per entry of
 * {@link LUOGU_API_OPERATIONS} and delegates every operation to the application-level
 * `LuoguSyncService`. It builds no transport, opens no socket, touches no model and never reads a
 * credential: the OS vault and the authenticated reader live behind the injected connection manager
 * and submissions source, and no operation here can make a paid call.
 *
 * Four rules shape every handler:
 *
 * - **The map is the contract.** Each route's request and response types are the shared
 *   {@link WorkbenchApiMap} entries, so the browser half and this boundary cannot drift.
 * - **Validation precedes every side effect.** Unknown fields, malformed revisions, an out-of-range
 *   interval, an empty settings patch and an oversized or control-character cookie are refused in
 *   the route's `validate` step, before the handler reads the store. Account identity is proved next
 *   — the account id itself must name this configured Luogu instance — and only then does the
 *   handler reach the service, which performs credential or platform work.
 * - **Answers are sanitized projections, never internal records.** The `LuoguSyncStatus` this module
 *   receives carries the stored connection record (an opaque vault reference, its `staleReference`
 *   and a cross-instance lease owner); none of those is representable in {@link ApiLuoguStatusView},
 *   which names only the canonical uid, an honest `cleanupPending` boolean and safe instants.
 * - **Failures are translated, never echoed.** A typed `LuoguSyncError`, `LuoguConnectionError`,
 *   `DomainError` or `PlatformError` becomes a stable transport code plus one fixed Chinese sentence.
 *   The adapter's own message (which may quote a vault backend or a provider body) is never used.
 */
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import {
  DomainError,
  createCancellationSource,
  parseAccountId,
  type Account,
  type CancellationToken,
  type SourceInstance,
} from '../domain/index.js';
import { MAX_CREDENTIAL_SECRET_BYTES } from '../application/local-credential-vault.js';
import { LuoguConnectionError } from '../application/luogu-connection.js';
import { LuoguSyncError, LuoguSyncService, combineTokens } from '../application/luogu-sync-service.js';
import {
  LUOGU_SYNC_INTERVAL_MAX_MINUTES,
  LUOGU_SYNC_INTERVAL_MIN_MINUTES,
  luoguLeaseLive,
  type LuoguSyncStore,
} from '../application/luogu-sync-types.js';
import { isPlatformError, type PlatformErrorCode } from '../application/platform-errors.js';
import type { TrainingStore } from '../application/ports.js';
import {
  LUOGU_API_OPERATIONS,
  type ApiLuoguAccountRequest,
  type ApiLuoguConfigureRequest,
  type ApiLuoguConnectRequest,
  type ApiLuoguStartRequest,
  type ApiLuoguStartResult,
  type ApiLuoguStatusView,
  type WorkbenchApiInput,
  type WorkbenchApiMap,
  type WorkbenchApiOutput,
} from '../application/workbench-api.js';
import { requireLuoguUid } from '../adapters/luogu/index.js';
import { ApiTransportError, registerApiRoute, type ApiErrorCode, type ApiRouteOptions } from './api-transport.js';
import { rollback } from './lifecycle.js';

/** Longest accepted account id; a canonical compound id is far shorter. */
export const MAX_LUOGU_ACCOUNT_ID_CHARS = 512;

/** Fixed refusal of every operation that needs the OS credential backend on an unsupported host. */
export const LUOGU_CONNECTION_UNAVAILABLE_MESSAGE =
  '当前操作系统没有可用的安全凭据存储，洛谷账号连接功能不可用；其余工作台功能不受影响。';

/** Fixed, sanitized Chinese sentence per stable Luogu failure code. */
const LUOGU_MESSAGES = {
  account_missing: '该账号未存储在本机工作台中。',
  account_foreign: '该账号不属于已配置的洛谷来源。',
  account_not_canonical: '该账号不是规范的洛谷 UID 账号。',
  not_connected: '该账号尚未连接洛谷，或已保存的会话已不可用。',
  busy: '该洛谷来源上已有同步或连接操作在运行，请稍后重试。',
  closing: '洛谷同步服务正在关闭，暂时无法处理新的请求。',
  invalid_input: '洛谷同步请求无效。',
  stale_revision: '洛谷同步设置已在别处修改，请重新读取状态后再试。',
  unsupported: LUOGU_CONNECTION_UNAVAILABLE_MESSAGE,
  cleanup_failed: '已保存的洛谷凭据无法删除，连接记录已保留以便重试。',
  lease_lost: '本次同步的租约已失效，请重新开始同步。',
  internal: '洛谷同步操作失败。',
  unauthorized: '洛谷会话已失效，请重新连接洛谷账号。',
  forbidden: '洛谷拒绝了本次请求。',
  rate_limited: '洛谷限流，请稍后重试。',
  changed_response: '洛谷返回了本版本无法识别的数据，请更新插件或稍后重试。',
  unavailable: '洛谷暂时不可用，请稍后重试。',
  cancelled: '请求已取消。',
} as const;

type LuoguMessageKey = keyof typeof LUOGU_MESSAGES;

/** Transport code of one stable Luogu synchronization failure. */
function transportCodeOf(code: LuoguSyncError['code']): ApiErrorCode {
  switch (code) {
    case 'account_missing':
      return 'not_found';
    case 'account_foreign':
    case 'invalid_input':
      return 'invalid_input';
    case 'not_connected':
    case 'busy':
    case 'closing':
    case 'stale_revision':
    case 'unsupported':
    case 'cleanup_failed':
    case 'lease_lost':
      return 'conflict';
    case 'internal':
      return 'internal';
  }
}

/** Transport code of one operational platform failure code. */
function platformCodeOf(code: PlatformErrorCode): ApiErrorCode {
  switch (code) {
    case 'auth_required':
      return 'conflict';
    case 'forbidden':
      return 'conflict';
    case 'rate_limited':
      return 'conflict';
    case 'changed_response':
      return 'conflict';
    case 'invalid_input':
      return 'invalid_input';
    case 'unavailable':
      return 'conflict';
    case 'cancelled':
      return 'cancelled';
  }
}

/** Message key of one operational platform failure code. */
function platformMessageOf(code: PlatformErrorCode): LuoguMessageKey {
  switch (code) {
    case 'auth_required':
      return 'unauthorized';
    case 'forbidden':
      return 'forbidden';
    case 'rate_limited':
      return 'rate_limited';
    case 'changed_response':
      return 'changed_response';
    case 'invalid_input':
      return 'invalid_input';
    case 'unavailable':
      return 'unavailable';
    case 'cancelled':
      return 'cancelled';
  }
}

/**
 * Convert one thrown value into the sanitized transport refusal that describes it.
 *
 * Only failures this module (and the layers below) documents are translated; anything unexpected is
 * rethrown unchanged so the transport keeps its sanitized 500 and reports the real error to the
 * route observer. No branch reads `error.message`.
 */
function toTransportFailure(error: unknown): never {
  if (error instanceof ApiTransportError) {
    throw error;
  }
  if (error instanceof LuoguSyncError) {
    throw new ApiTransportError(transportCodeOf(error.code), LUOGU_MESSAGES[error.code]);
  }
  if (error instanceof LuoguConnectionError) {
    switch (error.code) {
      case 'unsupported':
        throw new ApiTransportError('conflict', LUOGU_MESSAGES.unsupported);
      case 'account_missing':
        throw new ApiTransportError('not_found', LUOGU_MESSAGES.account_missing);
      case 'account_mismatch':
        throw new ApiTransportError('invalid_input', LUOGU_MESSAGES.account_foreign);
      case 'invalid_input':
        throw new ApiTransportError('invalid_input', LUOGU_MESSAGES.invalid_input);
      case 'not_connected':
      case 'busy':
      case 'cleanup_failed':
        throw new ApiTransportError('conflict', LUOGU_MESSAGES[error.code]);
    }
  }
  if (error instanceof DomainError) {
    if (error.code === 'cancelled') {
      throw new ApiTransportError('cancelled', LUOGU_MESSAGES.cancelled);
    }
    if (error.code === 'invalid_input' || error.code === 'invalid_id_part' || error.code === 'invalid_timestamp') {
      throw new ApiTransportError('invalid_input', LUOGU_MESSAGES.invalid_input);
    }
    throw new ApiTransportError('conflict', LUOGU_MESSAGES.internal);
  }
  if (isPlatformError(error)) {
    throw new ApiTransportError(platformCodeOf(error.code), LUOGU_MESSAGES[platformMessageOf(error.code)]);
  }
  throw error;
}

// ---------------------------------------------------------------------------------------
// Boundary validation (no IO)
// ---------------------------------------------------------------------------------------

const UNSAFE_TEXT = /[\u0000-\u001f\u007f]/u;

function refuse(message: string): never {
  throw new ApiTransportError('invalid_input', message);
}

/** Exact-key JSON object; an undeclared own key is a refusal, never a silently dropped field. */
function requireObject(label: string, value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`${label} 请求体必须是 JSON 对象。`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    refuse(`${label} 请求体必须是普通 JSON 对象。`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    refuse(`${label} 请求包含未知字段。`);
  }
  return record;
}

/**
 * Validate one account id **without IO**: it must be a canonical compound id of this instance.
 *
 * The account id itself carries the source instance, so a request for a Codeforces account (or a
 * malformed id) is refused here, before the handler reads the store or reaches the vault.
 */
function requireAccountId(instance: SourceInstance, value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_LUOGU_ACCOUNT_ID_CHARS ||
    UNSAFE_TEXT.test(value)
  ) {
    refuse('accountId 无效。');
  }
  let sourceInstanceId: string;
  try {
    sourceInstanceId = parseAccountId(value).sourceInstanceId;
  } catch {
    refuse('accountId 不是规范的账号标识。');
  }
  if (sourceInstanceId !== instance.id) {
    refuse(LUOGU_MESSAGES.account_foreign);
  }
  return value;
}

/**
 * Validate one session cookie for exactly one connect action.
 *
 * Bounded by the OS credential store's own 2560-byte capacity (actual UTF-8 bytes, not character
 * count), non-empty and free of control characters. The value is never stored by this module, never
 * echoed and never compared here; the connection adapter validates and stores it.
 */
function requireSessionCookie(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    refuse('sessionCookie 必须是非空的洛谷会话 Cookie。');
  }
  if (UNSAFE_TEXT.test(value)) {
    refuse('sessionCookie 含有控制字符。');
  }
  if (new TextEncoder().encode(value).length > MAX_CREDENTIAL_SECRET_BYTES) {
    refuse(`sessionCookie 超过 ${MAX_CREDENTIAL_SECRET_BYTES} 字节的凭据存储上限。`);
  }
  return value;
}

function validateAccountRequest(instance: SourceInstance) {
  return (value: unknown): ApiLuoguAccountRequest => {
    const record = requireObject('luogu', value, ['accountId']);
    return { accountId: requireAccountId(instance, record['accountId']) };
  };
}

function validateConnectRequest(instance: SourceInstance) {
  return (value: unknown): ApiLuoguConnectRequest => {
    const record = requireObject('luogu.connect', value, ['accountId', 'sessionCookie']);
    return {
      accountId: requireAccountId(instance, record['accountId']),
      sessionCookie: requireSessionCookie(record['sessionCookie']),
    };
  };
}

function validateStartRequest(instance: SourceInstance) {
  return (value: unknown): ApiLuoguStartRequest => {
    const record = requireObject('luogu.start', value, ['accountId', 'mode']);
    const mode = record['mode'];
    if (mode !== 'resume' && mode !== 'full') {
      refuse('mode 必须是 resume 或 full。');
    }
    return { accountId: requireAccountId(instance, record['accountId']), mode };
  };
}

function validateConfigureRequest(instance: SourceInstance) {
  return (value: unknown): ApiLuoguConfigureRequest => {
    const record = requireObject('luogu.configure', value, [
      'accountId',
      'expectedRevision',
      'automaticEnabled',
      'runOnStartup',
      'intervalMinutes',
    ]);
    const accountId = requireAccountId(instance, record['accountId']);
    const expectedRevision = record['expectedRevision'];
    if (
      expectedRevision !== null &&
      !(typeof expectedRevision === 'number' && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)
    ) {
      refuse('expectedRevision 必须是 null 或正整数。');
    }
    const automaticEnabled = record['automaticEnabled'];
    if (automaticEnabled !== undefined && typeof automaticEnabled !== 'boolean') {
      refuse('automaticEnabled 必须是布尔值。');
    }
    const runOnStartup = record['runOnStartup'];
    if (runOnStartup !== undefined && typeof runOnStartup !== 'boolean') {
      refuse('runOnStartup 必须是布尔值。');
    }
    const intervalMinutes = record['intervalMinutes'];
    if (
      intervalMinutes !== undefined &&
      !(
        typeof intervalMinutes === 'number' &&
        Number.isSafeInteger(intervalMinutes) &&
        intervalMinutes >= LUOGU_SYNC_INTERVAL_MIN_MINUTES &&
        intervalMinutes <= LUOGU_SYNC_INTERVAL_MAX_MINUTES
      )
    ) {
      refuse(`intervalMinutes 必须是 ${LUOGU_SYNC_INTERVAL_MIN_MINUTES}..${LUOGU_SYNC_INTERVAL_MAX_MINUTES} 的整数。`);
    }
    if (automaticEnabled === undefined && runOnStartup === undefined && intervalMinutes === undefined) {
      refuse('luogu.configure 至少需要一个配置字段。');
    }
    return {
      accountId,
      expectedRevision: expectedRevision === undefined ? null : expectedRevision,
      ...(automaticEnabled === undefined ? {} : { automaticEnabled }),
      ...(runOnStartup === undefined ? {} : { runOnStartup }),
      ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
    };
  };
}

// ---------------------------------------------------------------------------------------
// Handler context and projection
// ---------------------------------------------------------------------------------------

/** Validated dependencies every handler closes over. */
interface LuoguApiContext {
  readonly store: TrainingStore & LuoguSyncStore;
  readonly service: LuoguSyncService;
  readonly sourceInstance: SourceInstance;
  readonly connectionAvailable: boolean;
  readonly connectionPlatform: string;
  readonly now: () => string;
  /**
   * Refuse the operation once this route lifetime is closing.
   *
   * Called at every store boundary, so a handler whose route reference was captured but invoked
   * after disposal — and a handler that was already in flight when disposal began — can never reach
   * the store, the vault or the service again.
   */
  readonly assertOpen: () => void;
}

/** Resolve the stored canonical account of this instance; a foreign or missing account is refused. */
async function requireStoredAccount(context: LuoguApiContext, accountId: string): Promise<Account> {
  context.assertOpen();
  const account = await context.store.getAccount(accountId);
  context.assertOpen();
  if (account === null) {
    throw new ApiTransportError('not_found', LUOGU_MESSAGES.account_missing);
  }
  if (account.sourceInstanceId !== context.sourceInstance.id) {
    throw new ApiTransportError('invalid_input', LUOGU_MESSAGES.account_foreign);
  }
  try {
    requireLuoguUid(context.sourceInstance, account);
  } catch {
    throw new ApiTransportError('invalid_input', LUOGU_MESSAGES.account_not_canonical);
  }
  return account;
}

/** Refuse a credential operation on a host without a supported OS credential backend. */
function requireConnectionBackend(context: LuoguApiContext): void {
  if (!context.connectionAvailable) {
    throw new ApiTransportError('conflict', LUOGU_CONNECTION_UNAVAILABLE_MESSAGE);
  }
}

/**
 * Project the service status plus the durable revision/history facts into the public view.
 *
 * Built field by field so an added internal field of the service can never leak into an answer: the
 * vault reference, the `staleReference` of a pending cleanup and the lease owner are deliberately
 * reduced to a boolean (`cleanupPending`) or dropped entirely.
 */
async function projectStatus(context: LuoguApiContext, account: Account): Promise<ApiLuoguStatusView> {
  context.assertOpen();
  const status = await context.service.status(account.id);
  const settings = await context.store.getLuoguSyncSettings(account.id);
  const state = await context.store.getLuoguSyncState(account.id);
  const at = context.now();
  const connection = status.connection;
  return {
    accountId: account.id,
    uid: account.handle,
    sourceInstanceId: context.sourceInstance.id,
    connectionAvailable: context.connectionAvailable,
    connectionPlatform: context.connectionPlatform,
    connection:
      connection === null
        ? null
        : {
            status: connection.status,
            connectedAt: connection.connectedAt,
            checkedAt: connection.checkedAt,
            failureCode: connection.failureCode,
            cleanupPending: connection.staleReference !== null,
          },
    settings: status.settings,
    settingsRevision: settings === null ? null : settings.revision,
    phase: status.phase,
    historyComplete: status.historyComplete,
    historyCompletedAt: state === null ? null : state.value.historyCompletedAt,
    resumePending: status.resumePending,
    scanSince: status.scanSince,
    running: status.running,
    leaseActive: state !== null && luoguLeaseLive(state.value, null, at),
    paused: status.paused,
    failure: status.failure,
    nextRunAt: status.nextRunAt,
    scanStartedAt: status.scanStartedAt,
    lastScanStartedAt: status.lastScanStartedAt,
    lastSuccessAt: status.lastSuccessAt,
    pagesInPass: status.pagesInPass,
    totalPages: status.totalPages,
    submissionsSeen: status.submissionsSeen,
    metadataBacklog: status.metadataBacklog,
    metadataBacklogFull: status.metadataBacklogFull,
    metadataResolved: status.metadataResolved,
    metadataFailed: status.metadataFailed,
    backlogDropped: status.backlogDropped,
    closing: status.closing,
  };
}

// ---------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------

/** Operation keys this module owns, derived from the shared operation table. */
type LuoguOperation = (typeof LUOGU_API_OPERATIONS)[keyof typeof LUOGU_API_OPERATIONS];

export interface RegisterLuoguApiOptions extends ApiRouteOptions {
  /** Connection Fetch registry the exact routes are registered on. */
  readonly registry: HostConnectionFetch;
  /** Persistence: the account/settings/state reads of the projection plus the service's own rows. */
  readonly store: TrainingStore & LuoguSyncStore;
  /** The durable, already-initialized Luogu synchronization service. */
  readonly service: LuoguSyncService;
  /** The official Luogu instance every request is checked against. */
  readonly sourceInstance: SourceInstance;
  /** Honest capability of the credential backend; `false` on an unsupported platform. */
  readonly connectionAvailable: boolean;
  /** Resolved platform of the credential backend, disclosed even when it is unavailable. */
  readonly connectionPlatform: string;
  /** Injected clock used only for the live-lease projection. */
  readonly now: () => string;
}

/**
 * Register the Luogu routes atomically and return one owned disposer.
 *
 * Registration is all-or-nothing: a failure releases every route registered before it through
 * {@link rollback} before the original failure is rethrown, so a half-registered Luogu surface can
 * never serve a request.
 *
 * The returned disposer owns a route lifetime, not just the registrations: it marks the surface
 * closing, cancels the token of every handler it accepted, removes every route even when one
 * disposer throws, and resolves only after the in-flight handlers drained.
 */
export async function registerLuoguApi(options: RegisterLuoguApiOptions): Promise<() => Promise<void>> {
  /** Route lifetime: cancelled by the disposer so an in-flight connect/probe is interrupted. */
  const life = createCancellationSource();
  const inFlight = new Set<Promise<unknown>>();
  let closing = false;
  const context: LuoguApiContext = {
    store: options.store,
    service: options.service,
    sourceInstance: options.sourceInstance,
    connectionAvailable: options.connectionAvailable,
    connectionPlatform: options.connectionPlatform,
    now: options.now,
    assertOpen: () => {
      if (closing) {
        throw new LuoguSyncError('closing', 'the Luogu API is closing');
      }
    },
  };
  const disposers: (() => Promise<void>)[] = [];
  const add = <K extends LuoguOperation>(
    operation: K,
    validate: (value: unknown) => WorkbenchApiInput<K>,
    handle: (input: WorkbenchApiInput<K>, token: CancellationToken) => Promise<WorkbenchApiOutput<K>>,
    successStatus: 200 | 202 = 200,
  ): void => {
    disposers.push(
      registerApiRoute<WorkbenchApiInput<K>, WorkbenchApiOutput<K>>(
        options.registry,
        {
          operation,
          method: 'POST',
          successStatus,
          validate: (value: unknown): WorkbenchApiInput<K> => {
            try {
              return validate(value);
            } catch (error) {
              throw toTransportFailure(error);
            }
          },
          handle: async (input, token): Promise<WorkbenchApiOutput<K>> => {
            // The request token is linked to the route lifetime, so disposal cancels the platform
            // call this handler is waiting on instead of waiting for it to finish on its own. The
            // accepted handler is tracked until it settles, and a handler invoked after the close
            // is refused here, before any store or credential work.
            const run = (async (): Promise<WorkbenchApiOutput<K>> => {
              try {
                context.assertOpen();
                return await handle(input, combineTokens(token, life.token));
              } catch (error) {
                throw toTransportFailure(error);
              }
            })();
            inFlight.add(run);
            try {
              return await run;
            } finally {
              inFlight.delete(run);
            }
          },
        },
        options,
      ),
    );
  };
  /**
   * Dispose the route lifetime exactly once, for the success path and for registration rollback.
   *
   * The closing flag and the lifetime cancellation are set synchronously, before anything is
   * awaited, so no late call can begin work. Every route disposer runs even when one of them throws;
   * the collected failures are rethrown only after the handlers that were already accepted drained.
   */
  let disposal: Promise<void> | null = null;
  const disposeLifetime = (): Promise<void> => {
    if (disposal !== null) {
      return disposal;
    }
    const task = (async (): Promise<void> => {
      closing = true;
      life.cancel('the Luogu API is closing');
      const failures: unknown[] = [];
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'ICPC Luogu API cleanup failed');
      }
    })();
    disposal = task;
    return task;
  };
  try {
    add(
      LUOGU_API_OPERATIONS.status,
      validateAccountRequest(options.sourceInstance),
      async (input) => projectStatus(context, await requireStoredAccount(context, input.accountId)),
    );
    add(
      LUOGU_API_OPERATIONS.connect,
      validateConnectRequest(options.sourceInstance),
      async (input, token) => {
        requireConnectionBackend(context);
        const account = await requireStoredAccount(context, input.accountId);
        await context.service.connect(account.id, input.sessionCookie, token);
        return projectStatus(context, account);
      },
    );
    add(
      LUOGU_API_OPERATIONS.probe,
      validateAccountRequest(options.sourceInstance),
      async (input, token) => {
        requireConnectionBackend(context);
        const account = await requireStoredAccount(context, input.accountId);
        await context.service.probe(account.id, token);
        return projectStatus(context, account);
      },
    );
    add(
      LUOGU_API_OPERATIONS.disconnect,
      validateAccountRequest(options.sourceInstance),
      async (input, token) => {
        requireConnectionBackend(context);
        const account = await requireStoredAccount(context, input.accountId);
        await context.service.disconnect(account.id, token);
        return projectStatus(context, account);
      },
    );
    add(
      LUOGU_API_OPERATIONS.configure,
      validateConfigureRequest(options.sourceInstance),
      async (input, token) => {
        const account = await requireStoredAccount(context, input.accountId);
        await context.service.configure(account.id, input.expectedRevision, settingsPatchOf(input), token);
        return projectStatus(context, account);
      },
    );
    add(
      LUOGU_API_OPERATIONS.start,
      validateStartRequest(options.sourceInstance),
      async (input, token): Promise<ApiLuoguStartResult> => {
        const account = await requireStoredAccount(context, input.accountId);
        const result = await context.service.start(account.id, input.mode, token);
        return {
          accountId: result.accountId,
          mode: result.mode,
          outcome: result.outcome,
          status: await projectStatus(context, account),
        };
      },
      202,
    );
    add(
      LUOGU_API_OPERATIONS.cancel,
      validateAccountRequest(options.sourceInstance),
      async (input) => {
        const account = await requireStoredAccount(context, input.accountId);
        await context.service.cancel(account.id);
        return projectStatus(context, account);
      },
    );
    return disposeLifetime;
  } catch (error) {
    return rollback(error, [disposeLifetime]);
  }
}

/** The closed settings patch of one validated configure request, without its account/revision. */
function settingsPatchOf(input: ApiLuoguConfigureRequest): {
  readonly automaticEnabled?: boolean;
  readonly runOnStartup?: boolean;
  readonly intervalMinutes?: number;
} {
  return {
    ...(input.automaticEnabled === undefined ? {} : { automaticEnabled: input.automaticEnabled }),
    ...(input.runOnStartup === undefined ? {} : { runOnStartup: input.runOnStartup }),
    ...(input.intervalMinutes === undefined ? {} : { intervalMinutes: input.intervalMinutes }),
  };
}

/** Unused type anchor kept explicit so the map entries and this module cannot drift. */
export type LuoguApiEntry = WorkbenchApiMap['luogu.status'];
