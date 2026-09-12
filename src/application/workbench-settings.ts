/**
 * Workbench settings: strict validation, defaults and the persistence port.
 *
 * One typed object owns every runtime limit the workbench passes to adapters — model
 * roles/limits, platform IO limits and the not-yet-implemented coaching block. Model ids are
 * opaque configured names: provider availability is settled by later host configuration, and
 * no field here (and therefore no stored body) can carry a credential or an endpoint.
 */
import { invariant } from '../domain/index.js';
import {
  DEFAULT_MODEL_LIMITS,
  DEFAULT_PLATFORM_LIMITS,
  type ModelLimits,
  type ModelRoleSettings,
  type PlatformLimits,
} from './ports.js';

/** Version of the settings body written by this build. */
export const WORKBENCH_SETTINGS_SCHEMA_VERSION = 1;

/** Hard bounds every accepted settings value must satisfy; wider values are configuration errors. */
export const WORKBENCH_SETTINGS_BOUNDS = {
  stringLength: 200,
  calls: { min: 0, max: 1000 },
  retries: { min: 0, max: 5 },
  concurrency: { min: 1, max: 8 },
  timeoutMs: { min: 1000, max: 600_000 },
  outputTokens: { min: 1, max: 65_536 },
  temperature: { min: 0, max: 2 },
  pageSize: { min: 1, max: 500 },
  platformIntervalMs: { min: 0, max: 3_600_000 },
  jobAttempts: { min: 1, max: 10 },
  jobLeaseMs: { min: 1, max: 1_200_000 },
} as const;

/** Current public model ids used by the v1 defaults (opaque names, never probed here). */
export const DEFAULT_WORKBENCH_MODELS = {
  provider: 'deepseek-official',
  analysis: 'deepseek-flash',
  verification: 'deepseek-flash',
  reasoning: 'deepseek-v4-pro',
  coaching: 'deepseek-flash',
} as const;

/**
 * Coaching configuration.
 *
 * v1 fixes one concurrent call and `max` effort; the coaching service itself is a later stage,
 * so this block is configuration only and no call is made from constructing defaults.
 */
export interface CoachingSettings {
  readonly model: string;
  readonly maxCallsPer24Hours: number;
  readonly maxConcurrent: 1;
  readonly maxOutputTokens: number;
  readonly requestTimeoutMs: number;
  readonly effort: 'max';
}

/** Complete validated workbench configuration. */
export interface WorkbenchSettings {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly roles: ModelRoleSettings;
  readonly modelLimits: ModelLimits;
  readonly platformLimits: PlatformLimits;
  readonly coaching: CoachingSettings;
}

/**
 * Fresh default settings, detached on every call.
 *
 * Nothing here contacts a provider: the defaults are values, and whether the configured
 * provider really offers these model ids is checked by host configuration later.
 */
export function defaultWorkbenchSettings(): WorkbenchSettings {
  return {
    schemaVersion: WORKBENCH_SETTINGS_SCHEMA_VERSION,
    provider: DEFAULT_WORKBENCH_MODELS.provider,
    roles: {
      analysisModel: DEFAULT_WORKBENCH_MODELS.analysis,
      verificationModel: DEFAULT_WORKBENCH_MODELS.verification,
      reasoningModel: DEFAULT_WORKBENCH_MODELS.reasoning,
      maxOutputTokens: 65_536,
      temperature: 0.2,
    },
    modelLimits: {
      ...DEFAULT_MODEL_LIMITS,
      requestTimeoutMs: 180_000,
      job: { ...DEFAULT_MODEL_LIMITS.job, leaseMs: 240_000 },
    },
    platformLimits: { ...DEFAULT_PLATFORM_LIMITS },
    coaching: {
      model: DEFAULT_WORKBENCH_MODELS.coaching,
      maxCallsPer24Hours: 10,
      maxConcurrent: 1,
      maxOutputTokens: 65_536,
      requestTimeoutMs: 180_000,
      effort: 'max',
    },
  };
}

type JsonObject = Record<string, unknown>;

function requireObject(label: string, value: unknown): JsonObject {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `${label} must be a JSON object`,
    { label, valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value },
  );
  return value as JsonObject;
}

/** Strict shape check: an undeclared key (apiKey, url, typo) is rejected at every level. */
function requireExactKeys(label: string, value: JsonObject, keys: readonly string[]): void {
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  invariant(unknownKeys.length === 0, 'invalid_input', `${label} has unknown keys: ${unknownKeys.join(', ')}`, {
    label,
    unknownKeys,
  });
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  invariant(missing.length === 0, 'invalid_input', `${label} is missing keys: ${missing.join(', ')}`, {
    label,
    missing,
  });
}

function requireText(label: string, value: unknown): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0 && value.length <= WORKBENCH_SETTINGS_BOUNDS.stringLength,
    'invalid_input',
    `${label} must be a non-empty string of at most ${WORKBENCH_SETTINGS_BOUNDS.stringLength} characters`,
    { label, valueType: typeof value, length: typeof value === 'string' ? value.length : null },
  );
  return value;
}

function requireBounded(
  label: string,
  value: unknown,
  min: number,
  max: number,
  options: { readonly integer?: boolean } = {},
): number {
  const integer = options.integer ?? true;
  invariant(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max &&
      (!integer || Number.isInteger(value)),
    'invalid_input',
    `${label} must be a finite ${integer ? 'integer' : 'number'} within ${min}..${max}`,
    { label, value, min, max },
  );
  return value;
}

const ROOT_KEYS = ['schemaVersion', 'provider', 'roles', 'modelLimits', 'platformLimits', 'coaching'] as const;
const ROLE_KEYS = ['analysisModel', 'verificationModel', 'reasoningModel', 'maxOutputTokens', 'temperature'] as const;
const MODEL_LIMIT_KEYS = [
  'maxAnalysisCalls',
  'maxReasoningCalls',
  'concurrency',
  'requestTimeoutMs',
  'maxRetries',
  'job',
] as const;
const JOB_LIMIT_KEYS = ['maxAnalysisCalls', 'maxReasoningCalls', 'maxAttempts', 'leaseMs'] as const;
const PLATFORM_LIMIT_KEYS = [
  'minRequestIntervalMs',
  'requestTimeoutMs',
  'maxRetries',
  'pageSize',
  'maxConcurrency',
] as const;
const COACHING_KEYS = [
  'model',
  'maxCallsPer24Hours',
  'maxConcurrent',
  'maxOutputTokens',
  'requestTimeoutMs',
  'effort',
] as const;

/**
 * Strictly validate one settings value and return a detached copy.
 *
 * Unknown keys at any depth, missing keys, non-finite numbers, out-of-range limits, over-long
 * strings and the wrong fixed literals all raise `invalid_input`; the returned object is built
 * field by field, so a caller cannot smuggle an undeclared member into storage.
 */
export function validateWorkbenchSettings(value: unknown): WorkbenchSettings {
  const bounds = WORKBENCH_SETTINGS_BOUNDS;
  const root = requireObject('workbench settings', value);
  requireExactKeys('workbench settings', root, ROOT_KEYS);
  invariant(
    root['schemaVersion'] === WORKBENCH_SETTINGS_SCHEMA_VERSION,
    'invalid_input',
    `workbench settings schemaVersion must be ${WORKBENCH_SETTINGS_SCHEMA_VERSION}`,
    { schemaVersion: root['schemaVersion'] },
  );
  const provider = requireText('provider', root['provider']);

  const roles = requireObject('roles', root['roles']);
  requireExactKeys('roles', roles, ROLE_KEYS);
  const roleValue: ModelRoleSettings = {
    analysisModel: requireText('roles.analysisModel', roles['analysisModel']),
    verificationModel: requireText('roles.verificationModel', roles['verificationModel']),
    reasoningModel: requireText('roles.reasoningModel', roles['reasoningModel']),
    maxOutputTokens: requireBounded(
      'roles.maxOutputTokens',
      roles['maxOutputTokens'],
      bounds.outputTokens.min,
      bounds.outputTokens.max,
    ),
    temperature: requireBounded(
      'roles.temperature',
      roles['temperature'],
      bounds.temperature.min,
      bounds.temperature.max,
      { integer: false },
    ),
  };

  const limits = requireObject('modelLimits', root['modelLimits']);
  requireExactKeys('modelLimits', limits, MODEL_LIMIT_KEYS);
  const requestTimeoutMs = requireBounded(
    'modelLimits.requestTimeoutMs',
    limits['requestTimeoutMs'],
    bounds.timeoutMs.min,
    bounds.timeoutMs.max,
  );
  const job = requireObject('modelLimits.job', limits['job']);
  requireExactKeys('modelLimits.job', job, JOB_LIMIT_KEYS);
  const leaseMs = requireBounded(
    'modelLimits.job.leaseMs',
    job['leaseMs'],
    bounds.jobLeaseMs.min,
    bounds.jobLeaseMs.max,
  );
  invariant(
    leaseMs > requestTimeoutMs,
    'invalid_input',
    'modelLimits.job.leaseMs must exceed modelLimits.requestTimeoutMs',
    { leaseMs, requestTimeoutMs },
  );
  const modelLimitValue: ModelLimits = {
    maxAnalysisCalls: requireBounded(
      'modelLimits.maxAnalysisCalls',
      limits['maxAnalysisCalls'],
      bounds.calls.min,
      bounds.calls.max,
    ),
    maxReasoningCalls: requireBounded(
      'modelLimits.maxReasoningCalls',
      limits['maxReasoningCalls'],
      bounds.calls.min,
      bounds.calls.max,
    ),
    concurrency: requireBounded(
      'modelLimits.concurrency',
      limits['concurrency'],
      bounds.concurrency.min,
      bounds.concurrency.max,
    ),
    requestTimeoutMs,
    maxRetries: requireBounded('modelLimits.maxRetries', limits['maxRetries'], bounds.retries.min, bounds.retries.max),
    job: {
      maxAnalysisCalls: requireBounded(
        'modelLimits.job.maxAnalysisCalls',
        job['maxAnalysisCalls'],
        bounds.calls.min,
        bounds.calls.max,
      ),
      maxReasoningCalls: requireBounded(
        'modelLimits.job.maxReasoningCalls',
        job['maxReasoningCalls'],
        bounds.calls.min,
        bounds.calls.max,
      ),
      maxAttempts: requireBounded(
        'modelLimits.job.maxAttempts',
        job['maxAttempts'],
        bounds.jobAttempts.min,
        bounds.jobAttempts.max,
      ),
      leaseMs,
    },
  };

  const platform = requireObject('platformLimits', root['platformLimits']);
  requireExactKeys('platformLimits', platform, PLATFORM_LIMIT_KEYS);
  const platformValue: PlatformLimits = {
    minRequestIntervalMs: requireBounded(
      'platformLimits.minRequestIntervalMs',
      platform['minRequestIntervalMs'],
      bounds.platformIntervalMs.min,
      bounds.platformIntervalMs.max,
    ),
    requestTimeoutMs: requireBounded(
      'platformLimits.requestTimeoutMs',
      platform['requestTimeoutMs'],
      bounds.timeoutMs.min,
      bounds.timeoutMs.max,
    ),
    maxRetries: requireBounded(
      'platformLimits.maxRetries',
      platform['maxRetries'],
      bounds.retries.min,
      bounds.retries.max,
    ),
    pageSize: requireBounded('platformLimits.pageSize', platform['pageSize'], bounds.pageSize.min, bounds.pageSize.max),
    maxConcurrency: requireBounded(
      'platformLimits.maxConcurrency',
      platform['maxConcurrency'],
      bounds.concurrency.min,
      bounds.concurrency.max,
    ),
  };

  const coaching = requireObject('coaching', root['coaching']);
  requireExactKeys('coaching', coaching, COACHING_KEYS);
  invariant(
    coaching['maxConcurrent'] === 1,
    'invalid_input',
    'coaching.maxConcurrent must be 1 in settings v1',
    { maxConcurrent: coaching['maxConcurrent'] },
  );
  invariant(coaching['effort'] === 'max', 'invalid_input', "coaching.effort must be 'max'", {
    effort: coaching['effort'],
  });
  const coachingValue: CoachingSettings = {
    model: requireText('coaching.model', coaching['model']),
    maxCallsPer24Hours: requireBounded(
      'coaching.maxCallsPer24Hours',
      coaching['maxCallsPer24Hours'],
      bounds.calls.min,
      bounds.calls.max,
    ),
    maxConcurrent: 1,
    maxOutputTokens: requireBounded(
      'coaching.maxOutputTokens',
      coaching['maxOutputTokens'],
      bounds.outputTokens.min,
      bounds.outputTokens.max,
    ),
    requestTimeoutMs: requireBounded(
      'coaching.requestTimeoutMs',
      coaching['requestTimeoutMs'],
      bounds.timeoutMs.min,
      bounds.timeoutMs.max,
    ),
    effort: 'max',
  };

  return {
    schemaVersion: WORKBENCH_SETTINGS_SCHEMA_VERSION,
    provider,
    roles: roleValue,
    modelLimits: modelLimitValue,
    platformLimits: platformValue,
    coaching: coachingValue,
  };
}

/** One stored settings row: the CAS revision plus the validated value. */
export interface WorkbenchSettingsRecord {
  readonly revision: number;
  readonly value: WorkbenchSettings;
}

/**
 * Persistence port for the singleton workbench-settings row.
 *
 * Separate from the main training port so a store is not forced to implement unrelated
 * operations; the SQLite adapter implements both. `expectedRevision` is `null` only for the
 * first save (stored as revision 1) and the previously read revision for every update, so a
 * stale caller rejects before writing instead of overwriting a newer configuration.
 */
export interface SettingsStore {
  getWorkbenchSettings(): Promise<WorkbenchSettingsRecord | null>;
  saveWorkbenchSettings(value: WorkbenchSettings, expectedRevision: number | null): Promise<number>;
}
