import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import type { ApiRequest, ApiResponse, WorkbenchApiMap } from '../application/workbench-api.js';
import { ModelOperationError } from '../application/model-operation-types.js';
import { CoachingServiceError } from '../application/coaching-service.js';
import {
  MAX_PLANNING_HISTORY_LIMIT,
  PLANNING_MAX_ESTIMATED_MINUTES,
  PLANNING_MAX_HORIZON_DAYS,
  PLANNING_MAX_MINUTES_PER_DAY,
  PLANNING_MAX_TASKS_PER_DAY,
  PlanningServiceError,
} from '../application/planning-service.js';
import { MAX_PLANNING_CANDIDATES } from '../application/planning-types.js';
import { validateWorkbenchSettings } from '../application/workbench-settings.js';
import { parseProblemKey, problemKey, type CancellationToken } from '../domain/index.js';
import { ModelOperations } from './model-operations.js';
import { ApiTransportError, registerApiRoute, type ApiRouteOptions } from './api-transport.js';
import { mapBusinessError } from './api-validation.js';
import { disposeAll, rollback } from './lifecycle.js';

type Check = (value: unknown) => void;
const bad = (): never => { throw new ApiTransportError('invalid_input'); };
const text: Check = (v) => { if (typeof v !== 'string' || !v.trim() || v.length > 4096 || /[\x00-\x1f]/.test(v)) bad(); };
const bool: Check = (v) => { if (typeof v !== 'boolean') bad(); };
const integer = (min: number, max: number): Check => (v) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) bad(); };
const revision = integer(1, Number.MAX_SAFE_INTEGER);
const nullable = (check: Check): Check => (v) => { if (v !== null) check(v); };
const key: Check = (v) => { text(v); if (problemKey(parseProblemKey(v as string)) !== v) bad(); };
const level: Check = (v) => { if (v !== 1 && v !== 2 && v !== 3 && v !== 'full') bad(); };
/**
 * Optional AI plan scheduling settings.
 *
 * Each supplied scheduling field is bounded by the service's approved maxima. The caller's
 * maxTasksPerDay is preserved in preparation and output validation, with three as the default.
 */
const planSettings: Check = (v) => {
  if (v === null) return;
  if (typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) bad();
  const object = v as Record<string, unknown>;
  for (const field of Object.keys(object)) {
    if (!['horizonDays', 'minutesPerDay', 'estimatedMinutes', 'maxTasksPerDay'].includes(field)) bad();
  }
  if (Object.hasOwn(object, 'horizonDays')) integer(1, PLANNING_MAX_HORIZON_DAYS)(object['horizonDays']);
  if (Object.hasOwn(object, 'minutesPerDay')) integer(1, PLANNING_MAX_MINUTES_PER_DAY)(object['minutesPerDay']);
  if (Object.hasOwn(object, 'estimatedMinutes')) integer(1, PLANNING_MAX_ESTIMATED_MINUTES)(object['estimatedMinutes']);
  if (Object.hasOwn(object, 'maxTasksPerDay')) integer(1, PLANNING_MAX_TASKS_PER_DAY)(object['maxTasksPerDay']);
};
/** Explicit candidate selection: `null`/absent is the automatic pool, `[]` an explicit empty pool. */
const guidanceIds: Check = (v) => { if (!Array.isArray(v) || v.length < 1 || v.length > 4 || new Set(v).size !== v.length) bad(); for (const id of v as unknown[]) { text(id); if ((id as string).length > 80) bad(); } };
const planCandidates: Check = (v) => {
  if (v === null) return;
  if (!Array.isArray(v) || v.length > MAX_PLANNING_CANDIDATES || new Set(v).size !== v.length) bad();
  (v as unknown[]).forEach(key);
};
/** Closed JSON request validation. Services retain semantic identity and transaction checks. */
export function requestShape<T>(required: Record<string, Check>, optional: Record<string, Check> = {}): (value: unknown) => T {
  return (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad();
    const object = value as Record<string, unknown>;
    for (const field of Object.keys(required)) if (!Object.hasOwn(object, field)) bad();
    for (const field of Object.keys(object)) {
      const check = Object.hasOwn(required, field) ? required[field] : Object.hasOwn(optional, field) ? optional[field] : undefined;
      if (!check) bad();
      check!(object[field]);
    }
    return value as T;
  };
}
/** Translate only known application failures; unexpected errors reach the transport observer. */
export function modelApiFailure(error: unknown): ApiTransportError {
  if (error instanceof ModelOperationError) {
    switch (error.code) {
      case 'invalid_input': case 'not_found': case 'conflict': case 'settings_changed':
      case 'model_busy': case 'model_invalid': case 'cancelled': return new ApiTransportError(error.code);
      case 'history_overflow': return new ApiTransportError('conflict', 'stored history exceeds the supported bound');
      // AI planning is intentionally absent from this composition (an old isolated fixture): the
      // caller gets a stable refusal instead of a retried request or a fabricated success.
      case 'unavailable': return new ApiTransportError('conflict', 'AI planning is not available in this host composition');
      default: throw error;
    }
  }
  if (error instanceof CoachingServiceError) {
    if (error.code === 'invalid_request') return new ApiTransportError('invalid_input');
    if (error.code === 'request_conflict') return new ApiTransportError('conflict');
    throw error;
  }
  if (error instanceof PlanningServiceError) {
    switch (error.code) {
      case 'invalid_request': return new ApiTransportError('invalid_input');
      case 'request_conflict': return new ApiTransportError('conflict');
      case 'unknown_request': return new ApiTransportError('not_found');
      case 'history_overflow': return new ApiTransportError('conflict', 'stored history exceeds the supported bound');
      default: throw error;
    }
  }
  return mapBusinessError(error);
}

export interface ModelApiOptions extends ApiRouteOptions {
  readonly registry: HostConnectionFetch;
  readonly controller: ModelOperations;
}
/** Register the model HTTP boundary atomically; acknowledged work uses controller-owned tokens. */
export async function registerModelApi({ registry, controller: c, ...options }: ModelApiOptions): Promise<() => Promise<void>> {
  const disposers: (() => Promise<void>)[] = [];
  function add<K extends keyof WorkbenchApiMap>(operation: K, required: Record<string, Check>, optional: Record<string, Check>,
    handle: (input: ApiRequest<K>, token: CancellationToken) => Promise<ApiResponse<K>>, successStatus: 200 | 202 = 200): void {
    const validate = requestShape<ApiRequest<K>>(required, optional);
    disposers.push(registerApiRoute(registry, { operation, method: 'POST', successStatus,
      validate: (v) => { try { return validate(v); } catch (e) { throw modelApiFailure(e); } },
      handle: async (v, t) => { try { return await handle(v, t); } catch (e) { throw modelApiFailure(e); } },
    }, options));
  }
  const batch = { batchId: text }, guardedBatch = { ...batch, expectedSettingsRevision: revision };
  const identity = { requestId: text, accountId: nullable(text), problemKey: key };
  const reveals = { includeResponseText: bool, includeStale: bool };
  try {
    add('batch.prepare', { problemKeys: (v) => { if (!Array.isArray(v) || v.length < 1 || v.length > 100 || new Set(v).size !== v.length) bad(); (v as unknown[]).forEach(key); } }, { maxJobs: integer(1, 100), reanalyze: bool }, (v,t) => c.prepareBatch(v,t));
    add('batch.run', guardedBatch, {}, (v,t) => c.runBatch(v,t), 202);
    add('batch.resume', guardedBatch, {}, (v,t) => c.resumeBatch(v,t), 202);
    add('batch.pause', batch, {}, (v,t) => c.pauseBatch(v,t));
    add('batch.cancel', batch, {}, (v,t) => c.cancelBatch(v,t));
    add('batch.recover', {}, { batchId: nullable(text) }, (v,t) => c.recoverBatches(v,t));
    add('batch.detail', batch, {}, (v,t) => c.batchDetail(v,t));
    add('batch.list', {}, { limit: integer(1, 100) }, (v,t) => c.batchList(v,t));
    add('coaching.ask', { ...identity, level, expectedSettingsRevision: revision }, { explicitFullSolution: bool }, (v,t) => { if (v.level === 'full' && v.explicitFullSolution !== true) bad(); return c.coachingAsk(v,t); }, 202);
    add('coaching.status', identity, reveals, (v,t) => c.coachingStatus(v,t));
    add('coaching.history', { accountId: nullable(text), problemKey: key }, { ...reveals, level: nullable(level), limit: integer(1,500), cursor: nullable(text) }, (v,t) => c.coachingHistory(v,t));
    add('coaching.cancel', { ...identity, level }, {}, (v,t) => c.coachingCancel(v,t));
    add('plan.aiPrepare', { requestId: text, accountId: text }, { settings: planSettings, candidateLimit: nullable(integer(1, MAX_PLANNING_CANDIDATES)), candidateProblemKeys: planCandidates, guidanceMethodIds: guidanceIds, reveal: bool }, (v,t) => c.planPrepare(v,t));
    add('plan.aiRun', { requestId: text, accountId: text, expectedSettingsRevision: revision }, {}, (v,t) => c.planRun(v,t), 202);
    add('plan.aiStatus', { requestId: text, accountId: text }, { reveal: bool }, (v,t) => c.planStatus(v,t));
    add('plan.aiCancel', { requestId: text, accountId: text }, {}, (v,t) => c.planCancel(v,t));
    add('plan.aiHistory', { accountId: text }, { limit: nullable(integer(1, MAX_PLANNING_HISTORY_LIMIT)) }, (v,t) => c.planHistory(v,t));
    add('settings.save', { expectedRevision: nullable(revision), value: (v) => { validateWorkbenchSettings(v); } }, {}, (v,t) => c.saveSettings(v,t));
    return disposeAll(disposers);
  } catch (error) { return rollback(error, disposers); }
}
