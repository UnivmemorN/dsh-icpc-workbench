/**
 * Workbench settings: strict validation, defaults and SQLite persistence.
 *
 * The cases pin the two behaviours the rest of the plugin relies on: only a fully validated,
 * detached value can be stored (no credential or undeclared field has a way in), and the
 * singleton row only moves forward under revision CAS — surviving a reopen and rolling back
 * with its transaction.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteTrainingStore, StorageError } from '../../src/adapters/sqlite/index.js';
import { DEFAULT_PLATFORM_LIMITS } from '../../src/application/ports.js';
import {
  DEFAULT_WORKBENCH_MODELS,
  WORKBENCH_SETTINGS_SCHEMA_VERSION,
  defaultWorkbenchSettings,
  validateWorkbenchSettings,
  type WorkbenchSettings,
} from '../../src/application/workbench-settings.js';
import { DomainError } from '../../src/domain/index.js';
import * as fx from './fixtures.js';

function rejects(value: unknown, message: RegExp): void {
  assert.throws(
    () => validateWorkbenchSettings(value),
    (error) => error instanceof DomainError && error.code === 'invalid_input' && message.test(error.message),
    `expected invalid_input matching ${String(message)}`,
  );
}

void test('defaults are validated, concrete and detached on every call', () => {
  const first = defaultWorkbenchSettings();
  assert.equal(first.schemaVersion, WORKBENCH_SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(validateWorkbenchSettings(first), first);
  assert.equal(first.provider, DEFAULT_WORKBENCH_MODELS.provider);
  assert.equal(first.roles.analysisModel, 'deepseek-flash');
  assert.equal(first.roles.verificationModel, 'deepseek-flash');
  assert.equal(first.roles.reasoningModel, 'deepseek-flash');
  assert.equal(first.roles.maxOutputTokens, 65_536);
  assert.equal(first.modelLimits.maxAnalysisCalls, 50);
  assert.equal(first.modelLimits.maxReasoningCalls, 5);
  assert.equal(first.modelLimits.concurrency, 2);
  assert.equal(first.modelLimits.requestTimeoutMs, 180_000);
  assert.equal(first.modelLimits.job.leaseMs, 240_000);
  assert.deepEqual(first.platformLimits, DEFAULT_PLATFORM_LIMITS);
  assert.equal(first.coaching.model, 'deepseek-flash');
  assert.equal(first.coaching.maxCallsPer24Hours, 10);
  assert.equal(first.coaching.maxConcurrent, 1);
  assert.equal(first.coaching.maxOutputTokens, 65_536);
  assert.equal(first.coaching.requestTimeoutMs, 180_000);
  assert.equal(first.coaching.effort, 'max');

  const second = defaultWorkbenchSettings();
  assert.notEqual(first, second);
  assert.notEqual(first.roles, second.roles);
  assert.notEqual(first.modelLimits.job, second.modelLimits.job);
  assert.notEqual(first.platformLimits, second.platformLimits);
  assert.notEqual(first.coaching, second.coaching);
  (first as unknown as { provider: string }).provider = 'mutated';
  (first.modelLimits.job as unknown as { leaseMs: number }).leaseMs = 1;
  assert.equal(defaultWorkbenchSettings().provider, DEFAULT_WORKBENCH_MODELS.provider, 'a mutation cannot leak');
  assert.equal(defaultWorkbenchSettings().modelLimits.job.leaseMs, 240_000);
});

void test('validation rejects unknown keys, missing keys, empty and over-long strings', () => {
  const base = defaultWorkbenchSettings();
  rejects({ ...base, apiKey: 'secret' }, /unknown keys.*apiKey/);
  rejects({ ...base, baseUrl: 'https://provider.example' }, /unknown keys.*baseUrl/);
  rejects({ ...base, roles: { ...base.roles, apiKey: 'secret' } }, /roles has unknown keys/);
  rejects({ ...base, roles: { ...base.roles, baseUrl: 'https://provider.example' } }, /roles has unknown keys/);
  rejects(
    { ...base, modelLimits: { ...base.modelLimits, job: { ...base.modelLimits.job, extra: 1 } } },
    /modelLimits\.job has unknown keys/,
  );
  rejects({ ...base, platformLimits: { ...base.platformLimits, token: 'x' } }, /platformLimits has unknown keys/);
  rejects({ ...base, coaching: { ...base.coaching, apiKey: 'x' } }, /coaching has unknown keys/);

  const missing: Record<string, unknown> = { ...base };
  delete missing['coaching'];
  rejects(missing, /missing keys: coaching/);

  rejects(null, /must be a JSON object/);
  rejects([], /must be a JSON object/);
  rejects('settings', /must be a JSON object/);
  rejects(42, /must be a JSON object/);
  rejects({ ...base, provider: '' }, /provider must be a non-empty string/);
  rejects({ ...base, provider: '   ' }, /provider must be a non-empty string/);
  rejects({ ...base, coaching: { ...base.coaching, model: '   ' } }, /coaching.model must be a non-empty string/);
  rejects({ ...base, roles: { ...base.roles, reasoningModel: '' } }, /roles\.reasoningModel must be a non-empty string/);
  rejects(
    { ...base, coaching: { ...base.coaching, model: 'x'.repeat(201) } },
    /coaching\.model must be a non-empty string/,
  );
  assert.equal(validateWorkbenchSettings({ ...base, provider: 'p'.repeat(200) }).provider.length, 200);
});

void test('validation enforces every numeric bound, the fixed effort and the lease ordering', () => {
  const base = defaultWorkbenchSettings();
  const withModel = (patch: Partial<WorkbenchSettings['modelLimits']>): unknown => ({
    ...base,
    modelLimits: { ...base.modelLimits, ...patch },
  });
  const withJob = (patch: Partial<WorkbenchSettings['modelLimits']['job']>): unknown =>
    withModel({ job: { ...base.modelLimits.job, ...patch } });
  const withPlatform = (patch: Partial<WorkbenchSettings['platformLimits']>): unknown => ({
    ...base,
    platformLimits: { ...base.platformLimits, ...patch },
  });
  const withCoaching = (patch: Partial<WorkbenchSettings['coaching']>): unknown => ({
    ...base,
    coaching: { ...base.coaching, ...patch },
  });

  rejects({ ...base, schemaVersion: 2 }, /schemaVersion must be 1/);
  rejects(withModel({ maxAnalysisCalls: -1 }), /maxAnalysisCalls/);
  rejects(withModel({ maxAnalysisCalls: 1001 }), /maxAnalysisCalls/);
  rejects(withModel({ maxReasoningCalls: 1001 }), /maxReasoningCalls/);
  rejects(withModel({ concurrency: 0 }), /concurrency/);
  rejects(withModel({ concurrency: 9 }), /concurrency/);
  rejects(withModel({ concurrency: 2.5 }), /concurrency/);
  rejects(withModel({ requestTimeoutMs: 999 }), /requestTimeoutMs/);
  rejects(withModel({ requestTimeoutMs: 600_001 }), /requestTimeoutMs/);
  rejects(withModel({ maxRetries: 6 }), /maxRetries/);
  rejects({ ...base, roles: { ...base.roles, maxOutputTokens: 0 } }, /maxOutputTokens/);
  rejects({ ...base, roles: { ...base.roles, maxOutputTokens: 65_537 } }, /maxOutputTokens/);
  rejects({ ...base, roles: { ...base.roles, temperature: -0.1 } }, /temperature/);
  rejects({ ...base, roles: { ...base.roles, temperature: 2.1 } }, /temperature/);
  rejects({ ...base, roles: { ...base.roles, temperature: Number.NaN } }, /temperature/);
  rejects({ ...base, roles: { ...base.roles, temperature: Number.POSITIVE_INFINITY } }, /temperature/);
  rejects(withJob({ maxAttempts: 0 }), /maxAttempts/);
  rejects(withJob({ maxAttempts: 11 }), /maxAttempts/);
  rejects(withJob({ leaseMs: 180_000 }), /leaseMs must exceed/);
  rejects(withJob({ leaseMs: 1_200_001 }), /leaseMs/);
  rejects(withPlatform({ minRequestIntervalMs: -1 }), /minRequestIntervalMs/);
  rejects(withPlatform({ minRequestIntervalMs: 3_600_001 }), /minRequestIntervalMs/);
  rejects(withPlatform({ pageSize: 0 }), /pageSize/);
  rejects(withPlatform({ pageSize: 501 }), /pageSize/);
  rejects(withPlatform({ maxConcurrency: 0 }), /maxConcurrency/);
  rejects(withPlatform({ maxRetries: -1 }), /maxRetries/);
  rejects(withCoaching({ maxCallsPer24Hours: 1001 }), /maxCallsPer24Hours/);
  rejects(withCoaching({ maxConcurrent: 2 as unknown as 1 }), /maxConcurrent must be 1/);
  rejects(withCoaching({ effort: 'high' as unknown as 'max' }), /effort must be/);
  rejects(withCoaching({ maxOutputTokens: 0 }), /maxOutputTokens/);
  rejects(withCoaching({ requestTimeoutMs: 999 }), /requestTimeoutMs/);

  const maxed: WorkbenchSettings = {
    ...base,
    roles: { ...base.roles, maxOutputTokens: 65_536, temperature: 2 },
    modelLimits: {
      maxAnalysisCalls: 1000,
      maxReasoningCalls: 1000,
      concurrency: 8,
      requestTimeoutMs: 600_000,
      maxRetries: 5,
      job: { maxAnalysisCalls: 1000, maxReasoningCalls: 1000, maxAttempts: 10, leaseMs: 1_200_000 },
    },
    platformLimits: {
      minRequestIntervalMs: 3_600_000,
      requestTimeoutMs: 600_000,
      maxRetries: 5,
      pageSize: 500,
      maxConcurrency: 8,
    },
    coaching: {
      model: base.coaching.model,
      maxCallsPer24Hours: 1000,
      maxConcurrent: 1,
      maxOutputTokens: 65_536,
      requestTimeoutMs: 600_000,
      effort: 'max',
    },
  };
  assert.deepEqual(validateWorkbenchSettings(maxed), maxed, 'the upper bounds are inclusive');

  const minimums: WorkbenchSettings = {
    ...base,
    roles: { ...base.roles, maxOutputTokens: 1, temperature: 0 },
    modelLimits: {
      maxAnalysisCalls: 0,
      maxReasoningCalls: 0,
      concurrency: 1,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      job: { maxAnalysisCalls: 0, maxReasoningCalls: 0, maxAttempts: 1, leaseMs: 1001 },
    },
    platformLimits: {
      minRequestIntervalMs: 0,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      pageSize: 1,
      maxConcurrency: 1,
    },
    coaching: { ...base.coaching, maxCallsPer24Hours: 0, maxOutputTokens: 1, requestTimeoutMs: 1000 },
  };
  assert.deepEqual(validateWorkbenchSettings(minimums), minimums, 'the lower bounds are inclusive');
});

void test('settings persist under revision CAS and survive a reopen', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  assert.equal(await store.getWorkbenchSettings(), null, 'a fresh store has no settings row');
  const defaults = defaultWorkbenchSettings();
  assert.equal(await store.saveWorkbenchSettings(defaults, null), 1);
  const stored = await store.getWorkbenchSettings();
  assert.ok(stored);
  assert.equal(stored.revision, 1);
  assert.deepEqual(stored.value, defaults);

  const updated: WorkbenchSettings = {
    ...defaults,
    coaching: { ...defaults.coaching, maxCallsPer24Hours: 25 },
  };
  assert.equal(await store.saveWorkbenchSettings(updated, 1), 2);

  await assert.rejects(
    store.saveWorkbenchSettings(defaults, 1),
    (error) => error instanceof DomainError && error.code === 'invalid_transition',
    'a stale revision rejects',
  );
  await assert.rejects(
    store.saveWorkbenchSettings(defaults, null),
    (error) => error instanceof DomainError && error.code === 'duplicate_id',
    'a create against an existing row rejects',
  );
  await assert.rejects(
    store.saveWorkbenchSettings(defaults, 0),
    (error) => error instanceof DomainError && error.code === 'invalid_input',
    'revision 0 is not a CAS token',
  );

  const after = await store.getWorkbenchSettings();
  assert.deepEqual(after, { revision: 2, value: updated }, 'rejected saves wrote nothing');
  await store.close();

  const reopened = new SqliteTrainingStore({ path: paths.path, now: () => fx.LATER });
  try {
    assert.deepEqual(await reopened.getWorkbenchSettings(), { revision: 2, value: updated });
  } finally {
    await reopened.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('an invalid value is rejected before the stored row is created or replaced', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    const empty: WorkbenchSettings = { ...defaultWorkbenchSettings(), provider: '' };
    await assert.rejects(
      store.saveWorkbenchSettings(empty, null),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );
    assert.equal(await store.getWorkbenchSettings(), null, 'nothing was stored');

    const defaults = defaultWorkbenchSettings();
    assert.equal(await store.saveWorkbenchSettings(defaults, null), 1);
    const smuggled = { ...defaultWorkbenchSettings(), apiKey: 'secret' } as unknown as WorkbenchSettings;
    await assert.rejects(
      store.saveWorkbenchSettings(smuggled, 1),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );
    const outOfRange: WorkbenchSettings = {
      ...defaults,
      modelLimits: { ...defaults.modelLimits, concurrency: 9 },
    };
    await assert.rejects(
      store.saveWorkbenchSettings(outOfRange, 1),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );

    assert.deepEqual(await store.getWorkbenchSettings(), { revision: 1, value: defaults });
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('a rolled-back transaction leaves the settings row untouched', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await assert.rejects(
      store.transaction(async () => {
        await store.saveWorkbenchSettings(defaultWorkbenchSettings(), null);
        throw new Error('synthetic rollback');
      }),
      /synthetic rollback/,
    );
    assert.equal(await store.getWorkbenchSettings(), null, 'the rolled-back create is gone');

    const defaults = defaultWorkbenchSettings();
    await store.saveWorkbenchSettings(defaults, null);
    const changed: WorkbenchSettings = { ...defaults, provider: 'another-provider' };
    await assert.rejects(
      store.transaction(async () => {
        await store.saveWorkbenchSettings(changed, 1);
        throw new Error('synthetic rollback');
      }),
      /synthetic rollback/,
    );
    assert.deepEqual(
      await store.getWorkbenchSettings(),
      { revision: 1, value: defaults },
      'the rolled-back update is gone and the revision did not advance',
    );
  } finally {
    await store.close();
    fx.removeDirectory(paths.dir);
  }
});

void test('a tampered settings row is reported as corrupt and the row stays singular', async () => {
  const paths = fx.tempDatabase();
  const store = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  await store.saveWorkbenchSettings(defaultWorkbenchSettings(), null);
  await store.close();

  const tamper = new DatabaseSync(paths.path);
  try {
    assert.throws(
      () => tamper.exec(`INSERT INTO workbench_settings (id, revision, body) VALUES (2, 1, '{}')`),
      'the singleton CHECK refuses a second row',
    );
    tamper.prepare(`UPDATE workbench_settings SET body = ? WHERE id = 1`).run('{"schemaVersion":2}');
  } finally {
    tamper.close();
  }

  const invalidBody = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await assert.rejects(invalidBody.getWorkbenchSettings(), (error) => {
      return error instanceof StorageError && error.code === 'corrupt_row';
    });
  } finally {
    await invalidBody.close();
  }

  const malformed = new DatabaseSync(paths.path);
  try {
    malformed.prepare(`UPDATE workbench_settings SET body = ? WHERE id = 1`).run('not json');
    const countRow = malformed.prepare('SELECT count(*) AS n FROM workbench_settings').get() as
      | Record<string, unknown>
      | undefined;
    assert.equal(countRow?.['n'], 1);
  } finally {
    malformed.close();
  }

  const unparsable = new SqliteTrainingStore({ path: paths.path, now: () => fx.AT });
  try {
    await assert.rejects(unparsable.getWorkbenchSettings(), (error) => {
      return error instanceof StorageError && error.code === 'corrupt_row';
    });
  } finally {
    await unparsable.close();
    fx.removeDirectory(paths.dir);
  }
});
