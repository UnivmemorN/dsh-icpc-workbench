/**
 * The six durable bulk material-refresh routes (Sprint Contract 34A) over a real SQLite store, the
 * real `ImportService` refresh path and a synthetic platform adapter.
 *
 * Each case drives the registered Fetch route with a real `Request`, so the assertions cover the
 * externally meaningful contract: strict request validation (bounds, duplicates and credential-like
 * extra fields), the 202 start that commits before its owned background work, ordered found/absent/
 * unchanged/changed outcomes, per-item account ownership proven before any request with no anonymous
 * fallback, partial failures that later items progress past, cancellation that stops later items and
 * preserves completed siblings, retry-failed that never repeats a completed item, activation recovery
 * with no network, disposal and redaction. Nothing here opens a socket, calls a model or touches a
 * credential.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { SqliteTrainingStore } from '../../src/adapters/sqlite/index.js';
import { ImportService } from '../../src/application/import-service.js';
import type { ManualImportBundle } from '../../src/application/import-types.js';
import {
  beginMaterialRefreshItem,
  completeMaterialRefreshItem,
  createMaterialRefreshBatch,
  startMaterialRefreshBatch,
  type MaterialRefreshBatchView,
} from '../../src/application/material-refresh-batch-types.js';
import { MaterialRefreshBatchService } from '../../src/application/material-refresh-batch-service.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import type {
  EditorialFetchResult,
  FetchEditorialRequest,
  FetchProblemRequest,
  ListProblemsRequest,
  ListSubmissionsRequest,
  Page,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformLimits,
} from '../../src/application/ports.js';
import { MATERIAL_BATCH_API_OPERATIONS, WORKBENCH_API_OPERATIONS } from '../../src/application/workbench-api.js';
import {
  accountIdOf,
  canonicalJson,
  createCancellationSource,
  createEditorialSolution,
  createEditorialSource,
  createSourceInstance,
  DomainError,
  problemKey,
  type NormalizedProblem,
  type SourceInstance,
  type Submission,
} from '../../src/domain/index.js';
import { validateMaterialBatchPrepare } from '../../src/plugin/api-validation.js';
import { API_PREFIX, ApiTransportError, type ApiEnvelope, type ApiErrorBody } from '../../src/plugin/api-transport.js';
import { registerMaterialBatchApi } from '../../src/plugin/material-batch-api.js';
import * as materialBatchApiModule from '../../src/plugin/material-batch-api.js';
import * as fx from '../storage/fixtures.js';

const BATCH_AT = '2026-11-20T08:00:00.000Z';
const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 1000,
  maxRetries: 0,
  pageSize: 100,
  maxConcurrency: 1,
};
const SECRET_BODY = 'SECRET-MATERIAL-BODY-SENTINEL';
const SECRET_DETAIL = 'SECRET-PROVIDER-DETAIL-SENTINEL';
const SECRET_URL = 'https://codeforces.com/blog/entry/9001?note=SECRET-URL-SENTINEL';

const CF = createSourceInstance({
  platform: 'codeforces',
  baseUrl: 'https://codeforces.com',
  displayName: 'Codeforces',
});

// ---------------------------------------------------------------------------------------
// Synthetic adapter
// ---------------------------------------------------------------------------------------

interface AdapterCall {
  readonly operation: 'fetchProblem' | 'fetchEditorial';
  readonly externalKey: string;
  readonly accountId: string | null;
  readonly hasAccount: boolean;
  readonly officialTutorialUrl: string | null;
  tokenCancelled: boolean;
}

function take<T>(queue: Array<T | Error>, label: string): T {
  const next = queue.shift();
  if (next === undefined) {
    throw new Error(`synthetic adapter: unexpected ${label} request`);
  }
  if (next instanceof Error) {
    throw next;
  }
  return next;
}

/** Scripted platform adapter: queued answers, recorded requests, optional per-key gate and hook. */
class SyntheticAdapter implements PlatformAdapter {
  readonly sourceInstance: SourceInstance;
  readonly calls: AdapterCall[] = [];
  readonly problems: Array<NormalizedProblem | Error> = [];
  readonly editorials: Array<EditorialFetchResult | Error> = [];
  readonly gates = new Map<string, Promise<void>>();
  readonly hooks = new Map<string, () => Promise<void>>();

  constructor(sourceInstance: SourceInstance) {
    this.sourceInstance = sourceInstance;
  }

  capabilities(): PlatformCapabilities {
    return {
      platform: this.sourceInstance.platform,
      implemented: true,
      problems: true,
      submissions: true,
      editorial: true,
      pagedProblems: true,
      pagedSubmissions: true,
      requiresAuth: false,
      supportsAccountHistory: true,
      minRequestIntervalMs: null,
      notes: [],
    };
  }

  async listProblems(_request: ListProblemsRequest): Promise<Page<NormalizedProblem>> {
    return { items: [], nextCursor: null, fetchedAt: BATCH_AT };
  }

  async listSubmissions(_request: ListSubmissionsRequest): Promise<Page<Submission>> {
    return { items: [], nextCursor: null, fetchedAt: BATCH_AT };
  }

  async fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem> {
    this.calls.push({
      operation: 'fetchProblem',
      externalKey: request.problemRef.externalKey,
      accountId: null,
      hasAccount: false,
      officialTutorialUrl: null,
      tokenCancelled: request.token.cancelled,
    });
    return take(this.problems, `problem ${request.problemRef.externalKey}`);
  }

  async fetchEditorial(request: FetchEditorialRequest): Promise<EditorialFetchResult> {
    const call: AdapterCall = {
      operation: 'fetchEditorial',
      externalKey: request.problemRef.externalKey,
      accountId: request.account?.id ?? null,
      hasAccount: request.account !== undefined && request.account !== null,
      officialTutorialUrl: request.officialTutorialUrl ?? null,
      tokenCancelled: false,
    };
    this.calls.push(call);
    const gate = this.gates.get(request.problemRef.externalKey);
    if (gate !== undefined) {
      await gate;
    }
    call.tokenCancelled = request.token.cancelled;
    const hook = this.hooks.get(request.problemRef.externalKey);
    if (hook !== undefined) {
      await hook();
    }
    return take(this.editorials, `editorial ${request.problemRef.externalKey}`);
  }

  /** Editorial requests for one problem; a statement fetch is counted separately. */
  callsFor(externalKey: string): number {
    return this.calls.filter((call) => call.operation === 'fetchEditorial' && call.externalKey === externalKey).length;
  }
}

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

interface Bench {
  readonly store: SqliteTrainingStore;
  readonly service: MaterialRefreshBatchService;
  readonly imports: ImportService;
  readonly adapters: Map<string, SyntheticAdapter>;
  readonly routes: Map<string, ConnectionFetchRoute>;
  readonly clock: { value: string };
  readonly internalErrors: unknown[];
  adapter(instance: SourceInstance): SyntheticAdapter;
  newService(): MaterialRefreshBatchService;
  post(operation: string, body: unknown, signal?: AbortSignal): Promise<Response>;
  dispose(): Promise<void>;
}

function createRegistry(): {
  readonly registry: HostConnectionFetch;
  readonly routes: Map<string, ConnectionFetchRoute>;
} {
  const routes = new Map<string, ConnectionFetchRoute>();
  const registry: HostConnectionFetch = {
    register(route) {
      routes.set(route.path, route);
      return async () => {
        routes.delete(route.path);
      };
    },
  };
  return { registry, routes };
}

async function withBench(scopes: readonly fx.Scope[], run: (bench: Bench) => Promise<void>): Promise<void> {
  const paths = fx.tempDatabase();
  const clock = { value: BATCH_AT };
  const store = new SqliteTrainingStore({ path: paths.path, now: () => clock.value });
  const imports = new ImportService({ store, now: () => clock.value });
  const adapters = new Map<string, SyntheticAdapter>();
  const internalErrors: unknown[] = [];
  const adapter = (instance: SourceInstance): SyntheticAdapter => {
    const existing = adapters.get(instance.id);
    if (existing !== undefined) {
      return existing;
    }
    const created = new SyntheticAdapter(instance);
    adapters.set(instance.id, created);
    return created;
  };
  let minted = 0;
  const createService = (): MaterialRefreshBatchService =>
    new MaterialRefreshBatchService({
      store,
      imports,
      adapterFor: async (sourceInstanceId) => {
        const scopeInstance = scopes.find((scope) => scope.instance.id === sourceInstanceId)?.instance;
        if (scopeInstance === undefined) {
          throw new Error(`no synthetic source for ${sourceInstanceId}`);
        }
        return adapter(scopeInstance);
      },
      limits: async () => LIMITS,
      now: () => clock.value,
      uniqueId: (prefix) => `${prefix}-${(minted += 1)}`,
      closeWaitMs: 200,
      onInternalError: (error) => {
        internalErrors.push(error);
      },
    });
  const service = createService();
  await service.recoverInterrupted(createCancellationSource().token);
  const { registry, routes } = createRegistry();
  const dispose = await registerMaterialBatchApi({
    registry,
    service,
    onInternalError: (error) => {
      internalErrors.push(error);
    },
    onDisposeError: (error) => {
      internalErrors.push(error);
    },
  });
  const post = async (operation: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const route = routes.get(`${API_PREFIX}${operation}`);
    assert.ok(route, `route ${operation} must be registered`);
    return route.fetch(
      new Request(`http://localhost${API_PREFIX}${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  };
  try {
    await run({ store, service, imports, adapters, routes, clock, internalErrors, adapter, newService: createService, post, dispose });
  } finally {
    await dispose();
    await service.close();
    // Bounded shutdown: a test that failed while a synthetic gate was still closed must not be able
    // to hang the whole suite on a run that will never settle.
    await Promise.race([service.whenSettled(), sleep(1000)]);
    await store.close();
    fx.removeDirectory(paths.dir);
  }
}

async function envelope(response: Response): Promise<ApiEnvelope<unknown>> {
  return (await response.json()) as ApiEnvelope<unknown>;
}

function failureOf(body: ApiEnvelope<unknown>): ApiErrorBody {
  if (body.ok) {
    assert.fail(`expected a failed envelope, received ${JSON.stringify(body)}`);
  }
  return body.error;
}

async function refused(bench: Bench, operation: string, body: unknown, status: number): Promise<ApiEnvelope<unknown>> {
  const response = await bench.post(operation, body);
  const parsed = await envelope(response);
  assert.equal(response.status, status, `${operation} should answer ${status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

async function okValue<T>(
  bench: Bench,
  operation: string,
  body: unknown,
  status = 200,
): Promise<T> {
  const response = await bench.post(operation, body);
  const parsed = await envelope(response);
  assert.equal(response.status, status, `${operation} should answer ${status}: ${JSON.stringify(parsed)}`);
  if (!parsed.ok) {
    assert.fail(`${operation} answered a failed envelope`);
  }
  return parsed.value as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBatch(
  bench: Bench,
  batchId: string,
  done: (view: MaterialRefreshBatchView) => boolean,
  label: string,
): Promise<MaterialRefreshBatchView> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const view = await okValue<MaterialRefreshBatchView>(bench, 'material.detail', { batchId });
    if (done(view)) {
      return view;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}: ${JSON.stringify(view.counts)}`);
    }
    await sleep(5);
  }
}

async function seedScope(store: SqliteTrainingStore, scope: fx.Scope): Promise<void> {
  await store.upsertSourceInstances([scope.instance]);
  await store.upsertAccounts([scope.account]);
  await store.upsertProblems([scope.problem]);
}

function foundResult(id: string, url: string, text: string): EditorialFetchResult {
  const source = createEditorialSource({
    id,
    kind: 'editorial',
    url,
    title: `Editorial ${id}`,
    availability: 'found',
    retrievedAt: BATCH_AT,
    text,
  });
  const solution = createEditorialSolution({
    solutionId: `${id}-s0`,
    sourceId: id,
    ordinal: 0,
    title: 'Main idea',
    text,
  });
  return { status: 'found', sources: [source], solutions: [solution], retrievedAt: BATCH_AT };
}

function manualBundle(scope: fx.Scope, statement: string, at: string): ManualImportBundle {
  return {
    source: scope.instance,
    accounts: [scope.account],
    problems: [fx.makeProblem(scope.problem.ref, { statement, fetchedAt: at })],
    submissions: [],
    materials: [],
  };
}

// ---------------------------------------------------------------------------------------
// Registration and route shape
// ---------------------------------------------------------------------------------------

void test('the six exact routes are registered, start answers 202 and every answer is a durable view', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  await withBench([scope], async (bench) => {
    await seedScope(bench.store, scope);
    const operations = Object.values(MATERIAL_BATCH_API_OPERATIONS);
    assert.deepEqual(
      [...operations].sort(),
      ['material.cancel', 'material.detail', 'material.list', 'material.prepare', 'material.retryFailed', 'material.start'],
    );
    assert.equal(MATERIAL_BATCH_API_OPERATIONS.materialBatchStart, 'material.start');
    const legacy = new Set<string>(Object.values(WORKBENCH_API_OPERATIONS));
    for (const operation of operations) {
      assert.equal(
        legacy.has(operation),
        false,
        `${operation} is declared by this module's own operation map, not the accepted business map`,
      );
    }
    assert.equal(legacy.has('material.refresh'), true, 'the accepted single-problem route keeps its registration');
    assert.equal(legacy.has('material.supplement'), true);
    assert.deepEqual(
      [...bench.routes.keys()].sort(),
      operations.map((operation) => `${API_PREFIX}${operation}`).sort(),
    );
    for (const route of bench.routes.values()) {
      assert.deepEqual(route.methods, ['POST']);
    }
    assert.equal(
      operations.some((operation) => operation.includes('model') || operation.includes('plan.') || operation.includes('batch.')),
      false,
      'a bulk material refresh reaches no model, planning or analysis route',
    );

    const adapter = bench.adapter(scope.instance);
    adapter.editorials.push({ status: 'absent', detail: 'no editorial' });
    const prepared = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [{ problemKey: scope.problem.key, fetchStatement: false }],
    });
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.revision, 1);

    const started = await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: prepared.batchId }, 202);
    assert.equal(started.status, 'running');
    const completed = await waitForBatch(bench, prepared.batchId, (view) => view.status !== 'running', 'the batch to settle');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.items[0]?.result?.editorial, 'absent');

    const detail = await okValue<MaterialRefreshBatchView>(bench, 'material.detail', { batchId: prepared.batchId });
    assert.equal(detail.batchId, prepared.batchId);
    const list = await okValue<{ batches: readonly { batchId: string }[]; total: number; limit: number }>(
      bench,
      'material.list',
      {},
    );
    assert.equal(list.total, 1);
    assert.equal(list.batches[0]?.batchId, prepared.batchId);
    const cancelled = await okValue<MaterialRefreshBatchView>(bench, 'material.cancel', { batchId: prepared.batchId });
    assert.equal(cancelled.status, 'completed', 'cancelling a completed batch changes nothing');
    const retried = await okValue<MaterialRefreshBatchView>(bench, 'material.retryFailed', { batchId: prepared.batchId });
    assert.equal(retried.status, 'completed');
    assert.deepEqual(bench.internalErrors, []);
  });
});

void test('material.prepare is strict about bounds, duplicates and credential-like extra fields', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  await withBench([scope], async (bench) => {
    await seedScope(bench.store, scope);
    const key = scope.problem.key;
    // The 100-item case refreshes **stored** problems, so the synthetic bank really holds them.
    const bulkRefs = Array.from({ length: 100 }, (_, index) => ({
      sourceInstanceId: CF.id,
      domain: null,
      externalKey: `BULK${index}`,
    }));
    await bench.store.upsertProblems(bulkRefs.map((ref) => fx.makeProblem(ref)));
    const bulkKey = (index: number): string =>
      problemKey({ sourceInstanceId: CF.id, domain: null, externalKey: `BULK${index}` });
    const items = (count: number): readonly { readonly problemKey: string }[] =>
      Array.from({ length: count }, (_, index) => ({ problemKey: bulkKey(index) }));

    const cases: readonly (readonly [string, unknown])[] = [
      ['a missing items member', {}],
      ['a null list', { items: null }],
      ['a scalar list', { items: 'all' }],
      ['an empty list', { items: [] }],
      ['101 items', { items: items(101) }],
      ['a duplicate canonical key', { items: [{ problemKey: key }, { problemKey: key }] }],
      ['a null item', { items: [null] }],
      ['an item without a key', { items: [{ accountId: null }] }],
      ['a non-string key', { items: [{ problemKey: 42 }] }],
      ['a non-canonical key', { items: [{ problemKey: 'not a canonical key' }] }],
      ['a non-canonical account id', { items: [{ problemKey: key, accountId: 'not-an-account-id' }] }],
      ['a non-http tutorial URL', { items: [{ problemKey: key, officialTutorialUrl: 'ftp://example.org/x' }] }],
      ['a non-boolean statement flag', { items: [{ problemKey: key, fetchStatement: 'true' }] }],
      ['an unknown item field', { items: [{ problemKey: key, mirrorEditorial: true }] }],
      ['a cookie field', { items: [{ problemKey: key, cookie: 'session=1' }] }],
      ['a session field', { items: [{ problemKey: key, session: 'abc' }] }],
      ['a credential field', { items: [{ problemKey: key, credential: 'vault://x' }] }],
      ['a password field', { items: [{ problemKey: key, password: 'hunter2' }] }],
      ['a token field', { items: [{ problemKey: key, token: 'api-token' }] }],
      ['an apiKey field', { items: [{ problemKey: key, apiKey: 'key' }] }],
      ['a top-level credential field', { items: [{ problemKey: key }], cookie: 'session=1' }],
      ['a top-level unknown field', { items: [{ problemKey: key }], all: true }],
    ];
    for (const [label, body] of cases) {
      const parsed = await refused(bench, 'material.prepare', body, 400);
      assert.equal(failureOf(parsed).code, 'invalid_input', `${label} must be refused`);
    }
    assert.deepEqual(
      await bench.store.listMaterialRefreshBatches(null),
      [],
      'a refused prepare writes nothing',
    );

    const single = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [{ problemKey: key, fetchStatement: false }],
    });
    assert.equal(single.itemCount, 1);
    const hundred = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', { items: items(100) });
    assert.equal(hundred.itemCount, 100);
    assert.equal(hundred.items.length, 100);
    assert.deepEqual(
      hundred.items.map((item) => item.problemKey),
      items(100).map((item) => item.problemKey),
      'the prepared order is the caller order',
    );
  });
});

void test('material.prepare rejects malformed ids and unsafe URLs before any service is called', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  await withBench([scope], async (bench) => {
    await seedScope(bench.store, scope);
    const key = scope.problem.key;
    const credentialUrl = 'https://alice:SECRET_PASSWORD@codeforces.com/blog/entry/1';
    const rejected: readonly (readonly [string, unknown])[] = [
      ['a bare handle as an account id', { items: [{ problemKey: key, accountId: 'alice' }] }],
      ['a three-part account id', { items: [{ problemKey: key, accountId: 'a|b|c' }] }],
      ['a blank handle part', { items: [{ problemKey: key, accountId: 'codeforces:codeforces.com|' }] }],
      ['an ftp tutorial URL', { items: [{ problemKey: key, officialTutorialUrl: 'ftp://example.org/x' }] }],
      ['a relative tutorial URL', { items: [{ problemKey: key, officialTutorialUrl: '/blog/entry/1' }] }],
      ['a credential-bearing tutorial URL', { items: [{ problemKey: key, officialTutorialUrl: credentialUrl }] }],
      ['an unknown item field', { items: [{ problemKey: key, cookie: 'session=1' }] }],
    ];
    // Shape refusals surface as a DomainError, parser refusals as the transport's own error; both are
    // `invalid_input` and both happen inside the validator, before any service exists to call.
    const refusedByValidator = (error: unknown): boolean =>
      (error instanceof ApiTransportError || error instanceof DomainError) && error.code === 'invalid_input';
    for (const [label, body] of rejected) {
      assert.throws(
        () => validateMaterialBatchPrepare(body),
        refusedByValidator,
        `${label} must be refused by the validator itself`,
      );
    }

    // The same refusals over the real route are answered with 400 and reach no service method at all.
    const calls: string[] = [];
    const stub = {
      prepare: async (): Promise<unknown> => {
        calls.push('prepare');
        return { batchId: 'material-batch-stub' };
      },
      start: async (): Promise<unknown> => {
        calls.push('start');
        return {};
      },
      detail: async (): Promise<unknown> => {
        calls.push('detail');
        return {};
      },
      list: async (): Promise<unknown> => {
        calls.push('list');
        return {};
      },
      cancel: async (): Promise<unknown> => {
        calls.push('cancel');
        return {};
      },
      retryFailed: async (): Promise<unknown> => {
        calls.push('retryFailed');
        return {};
      },
    } as unknown as MaterialRefreshBatchService;
    const { registry, routes } = createRegistry();
    const dispose = await registerMaterialBatchApi({ registry, service: stub });
    const prepareRoute = routes.get(`${API_PREFIX}material.prepare`);
    assert.ok(prepareRoute);
    const invoke = (body: unknown): Promise<Response> =>
      prepareRoute.fetch(
        new Request(`http://localhost${API_PREFIX}material.prepare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    try {
      for (const [label, body] of rejected) {
        const response = await invoke(body);
        assert.equal(response.status, 400, `${label} must answer 400`);
      }
      assert.deepEqual(calls, [], 'a refused request never reaches the service');
      // A well-formed request does reach it, proving the route and the stub are really wired.
      const accepted = await invoke({ items: [{ problemKey: key }] });
      assert.equal(accepted.status, 200);
      assert.deepEqual(calls, ['prepare']);
    } finally {
      await dispose();
    }

    // Nothing above wrote a batch, touched an adapter, or let the sentinel password reach the store.
    const credentialRefusal = await refused(
      bench,
      'material.prepare',
      { items: [{ problemKey: key, officialTutorialUrl: credentialUrl }] },
      400,
    );
    assert.equal(
      JSON.stringify(credentialRefusal).includes('SECRET_PASSWORD'),
      false,
      'a refusal answer never echoes the credential it refused',
    );
    assert.deepEqual(await bench.store.listMaterialRefreshBatches(null), []);
    assert.equal(bench.adapter(scope.instance).calls.length, 0);
    const absentKey = problemKey({ sourceInstanceId: CF.id, domain: null, externalKey: 'NOTSTORED' });
    const absent = await refused(bench, 'material.prepare', { items: [{ problemKey: absentKey }] }, 404);
    assert.equal(failureOf(absent).code, 'not_found', 'a batch refreshes stored problems, it does not import');
    assert.deepEqual(await bench.store.listMaterialRefreshBatches(null), []);
    assert.equal(
      JSON.stringify(await bench.store.listMaterialRefreshBatches(null)).includes('SECRET_PASSWORD'),
      false,
    );
  });
});

void test('detail, list, start, cancel and retryFailed validate their inputs and refuse unknown batches', async () => {
  const scope = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  await withBench([scope], async (bench) => {
    await seedScope(bench.store, scope);
    for (const operation of ['material.detail', 'material.start', 'material.cancel', 'material.retryFailed']) {
      const missing = await refused(bench, operation, {}, 400);
      assert.equal(failureOf(missing).code, 'invalid_input');
      const blank = await refused(bench, operation, { batchId: '   ' }, 400);
      assert.equal(failureOf(blank).code, 'invalid_input');
      const extra = await refused(bench, operation, { batchId: 'x', force: true }, 400);
      assert.equal(failureOf(extra).code, 'invalid_input');
      const unknown = await refused(bench, operation, { batchId: 'material-batch-missing' }, 404);
      assert.equal(failureOf(unknown).code, 'not_found');
    }

    const first = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [{ problemKey: scope.problem.key, fetchStatement: false }],
    });
    bench.clock.value = '2026-11-20T08:01:00.000Z';
    const second = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [{ problemKey: scope.problem.key, fetchStatement: false }],
    });

    const page = await okValue<{ batches: readonly { batchId: string }[]; total: number; limit: number }>(
      bench,
      'material.list',
      { limit: 1 },
    );
    assert.equal(page.total, 2, 'total counts the filtered set before the page slice');
    assert.equal(page.batches.length, 1);
    assert.equal(page.batches[0]?.batchId, second.batchId, 'the newest batch is first');
    const filtered = await okValue<{ batches: readonly { batchId: string }[]; total: number }>(bench, 'material.list', {
      status: 'prepared',
    });
    assert.deepEqual(
      filtered.batches.map((batch) => batch.batchId),
      [second.batchId, first.batchId],
    );
    const empty = await okValue<{ total: number }>(bench, 'material.list', { status: 'completed' });
    assert.equal(empty.total, 0);

    for (const body of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { status: 'done' },
      { limit: 20, extra: true },
    ]) {
      const parsed = await refused(bench, 'material.list', body, 400);
      assert.equal(failureOf(parsed).code, 'invalid_input', `${JSON.stringify(body)} must be refused`);
    }
    const nullStatus = await okValue<{ total: number }>(bench, 'material.list', { status: null, limit: 50 });
    assert.equal(nullStatus.total, 2);
  });
});

// ---------------------------------------------------------------------------------------
// Ordered outcomes through the real refresh path
// ---------------------------------------------------------------------------------------

void test('a run reports found, absence, an unchanged snapshot and a changed snapshot in caller order', async () => {
  const found = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const absent = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const unchanged = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900C');
  const changed = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900D');
  const scopes = [found, absent, unchanged, changed];
  await withBench(scopes, async (bench) => {
    for (const scope of scopes) {
      await seedScope(bench.store, scope);
    }
    const adapter = bench.adapter(found.instance);
    const material = foundResult('cf-blog-1900a', 'https://codeforces.com/blog/entry/1900a', 'editorial body A');

    // Seed two problems with the same material the batch will fetch again, so one item sees an
    // unchanged snapshot: the version is reused and the semantic content did not change.
    for (const scope of [unchanged, changed]) {
      adapter.editorials.push(material);
      const seeded = await bench.imports.refreshMaterial(adapter, {
        problemRef: scope.problem.ref,
        fetchStatement: false,
        token: createCancellationSource().token,
        limits: LIMITS,
      });
      assert.equal(seeded.snapshot?.changed, true);
      assert.equal(seeded.snapshot?.version, 1);
    }

    adapter.problems.push(fx.makeProblem(found.problem.ref, { statement: `fetched statement ${SECRET_BODY}` }));
    adapter.editorials.push(material);
    adapter.editorials.push({ status: 'absent', detail: 'the catalogue lists no editorial' });
    adapter.editorials.push(material);
    adapter.editorials.push(foundResult('cf-blog-1900d', 'https://codeforces.com/blog/entry/1900d', 'editorial body D'));

    const prepared = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [
        { problemKey: found.problem.key, fetchStatement: true },
        { problemKey: absent.problem.key, fetchStatement: false },
        { problemKey: unchanged.problem.key, fetchStatement: false },
        { problemKey: changed.problem.key, fetchStatement: false },
      ],
    });
    await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: prepared.batchId }, 202);
    const view = await waitForBatch(bench, prepared.batchId, (current) => current.status !== 'running', 'the run to complete');

    assert.equal(view.status, 'completed');
    assert.deepEqual(
      view.items.map((item) => item.problemKey),
      scopes.map((scope) => scope.problem.key),
      'the durable order is the requested order',
    );
    assert.deepEqual(
      view.items.map((item) => item.status),
      ['completed', 'completed', 'completed', 'completed'],
    );
    const [firstItem, secondItem, thirdItem, fourthItem] = view.items;
    assert.ok(firstItem && secondItem && thirdItem && fourthItem);
    assert.equal(firstItem.result?.statement, 'fetched');
    assert.equal(firstItem.result?.editorial, 'found');
    assert.equal(firstItem.result?.sourceCount, 1);
    assert.equal(firstItem.result?.solutionCount, 1);
    assert.equal(firstItem.result?.snapshot?.changed, true);
    assert.equal(firstItem.result?.snapshot?.version, 1);

    assert.equal(secondItem.result?.editorial, 'absent', 'absence is a completed observation');
    assert.equal(secondItem.result?.sourceCount, 0);
    assert.equal(secondItem.result?.solutionCount, 0);

    assert.equal(thirdItem.result?.snapshot?.changed, false, 'identical material reuses the stored snapshot');
    assert.equal(thirdItem.result?.snapshot?.version, 1);

    assert.equal(fourthItem.result?.snapshot?.changed, true);
    assert.equal(fourthItem.result?.snapshot?.version, 2, 'changed material advances the snapshot version');
    assert.notEqual(fourthItem.result?.snapshot?.snapshotId, thirdItem.result?.snapshot?.snapshotId);
    assert.equal(view.counts.completed, 4);
    assert.equal(view.counts.changedSnapshots, 3);
    assert.equal(view.finishedAt !== null, true);

    // The rows really landed in the store the analysis reads, and no body travelled in the answer.
    const head = await bench.store.getCurrentSnapshotHead(found.problem.ref);
    const snapshot = await bench.store.getSnapshot(head?.snapshotId ?? '');
    assert.equal(snapshot?.solutions.length, 1);
    assert.equal(snapshot?.problem.statement, `fetched statement ${SECRET_BODY}`);
    assert.equal(JSON.stringify(view).includes(SECRET_BODY), false, 'a statement body must never travel');
    assert.equal(JSON.stringify(view).includes('editorial body'), false);
    assert.deepEqual(bench.internalErrors, []);
  });
});

void test('a named account is resolved at prepare and never becomes an anonymous read', async () => {
  const target = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const second = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const foreign = fx.makeScope('luogu', 'www.luogu.com.cn', '123456', 'P1000');
  await withBench([target, second, foreign], async (bench) => {
    await seedScope(bench.store, target);
    await seedScope(bench.store, second);
    const adapter = bench.adapter(target.instance);

    // A foreign account and an id the store never held are refused at prepare: no batch row, no IO.
    const foreignRefusal = await refused(
      bench,
      'material.prepare',
      { items: [{ problemKey: target.problem.key, accountId: foreign.account.id, fetchStatement: false }] },
      404,
    );
    assert.equal(failureOf(foreignRefusal).code, 'not_found');
    const unknownRefusal = await refused(
      bench,
      'material.prepare',
      { items: [{ problemKey: second.problem.key, accountId: accountIdOf(CF.id, 'ghost'), fetchStatement: false }] },
      404,
    );
    assert.equal(failureOf(unknownRefusal).code, 'not_found');
    assert.deepEqual(await bench.store.listMaterialRefreshBatches(null), [], 'a refused prepare writes no row');
    assert.equal(adapter.calls.length, 0, 'a refused prepare makes no adapter request');

    adapter.editorials.push(foundResult('cf-blog-a', 'https://codeforces.com/blog/entry/1', 'body a'));
    adapter.editorials.push(foundResult('cf-blog-b', 'https://codeforces.com/blog/entry/2', 'body b'));
    const authenticated = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [
        { problemKey: target.problem.key, accountId: target.account.id, fetchStatement: false },
        { problemKey: second.problem.key, accountId: null, fetchStatement: false },
      ],
    });
    await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: authenticated.batchId }, 202);
    const run = await waitForBatch(bench, authenticated.batchId, (current) => current.status !== 'running', 'the run');
    assert.equal(run.status, 'completed');
    const authenticatedCall = adapter.calls.find((call) => call.externalKey === target.problem.ref.externalKey);
    const anonymousCall = adapter.calls.find((call) => call.externalKey === second.problem.ref.externalKey);
    assert.ok(authenticatedCall && anonymousCall);
    assert.equal(authenticatedCall.accountId, target.account.id);
    assert.equal(authenticatedCall.hasAccount, true);
    assert.equal(anonymousCall.accountId, null);
    assert.equal(anonymousCall.hasAccount, false, 'an omitted account stays an explicit anonymous read');

    // The account id encodes its handle, so no answer may carry the id, a handle field or a name.
    const view = await okValue<MaterialRefreshBatchView>(bench, 'material.detail', { batchId: authenticated.batchId });
    assert.equal(Object.prototype.hasOwnProperty.call(view.items[0], 'accountId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(view.items[0], 'handle'), false);
    const serialized = JSON.stringify({ prepared: authenticated, view });
    assert.equal(serialized.includes(target.account.id), false, 'the account id must not travel');
    const displayName = target.account.displayName;
    assert.ok(displayName !== null);
    assert.equal(serialized.includes(displayName), false, 'no display name may travel');
  });
});

// ---------------------------------------------------------------------------------------
// Partial failure, cancellation, recovery
// ---------------------------------------------------------------------------------------

void test('auth, forbidden, rate limit, stale head, changed response and unavailability stay per item and later items progress', async () => {
  const suffixes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
  const scopes = suffixes.map((suffix) => fx.makeScope('codeforces', 'codeforces.com', 'alice', `1900${suffix}`));
  await withBench(scopes, async (bench) => {
    for (const scope of scopes) {
      await seedScope(bench.store, scope);
    }
    const adapter = bench.adapter(scopes[0]!.instance);
    const [ok, auth, rate, stale, changed, unavailable, forbidden] = scopes;
    assert.ok(ok && auth && rate && stale && changed && unavailable && forbidden);
    const material = foundResult('cf-blog-ok', 'https://codeforces.com/blog/entry/1', 'body');

    adapter.editorials.push(material);
    adapter.editorials.push(new PlatformError({ code: 'auth_required', operation: 'editorial', detail: SECRET_DETAIL }));
    adapter.editorials.push(new PlatformError({ code: 'rate_limited', operation: 'editorial', detail: 'slow down', retryAfterMs: 4000 }));
    // The stale-head item's answer is fetched and then refused at commit time, so it is a placeholder.
    adapter.editorials.push({ status: 'absent', detail: 'discarded when the head moved' });
    adapter.editorials.push({ status: 'changed_response', detail: 'layout changed', sample: SECRET_BODY });
    adapter.editorials.push({ status: 'unavailable', detail: '503', retryable: true });
    adapter.editorials.push(new PlatformError({ code: 'forbidden', operation: 'editorial', detail: 'denied' }));
    // The stale-head item: a concurrent manual import commits newer content while the read is in
    // flight, exactly the refusal the accepted single-problem refresh already implements.
    adapter.hooks.set(stale.problem.ref.externalKey, async () => {
      await bench.imports.applyManual(
        manualBundle(stale, 'a concurrently rewritten statement', bench.clock.value),
        createCancellationSource().token,
      );
    });

    const prepared = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [
        { problemKey: ok.problem.key, fetchStatement: false },
        { problemKey: auth.problem.key, fetchStatement: false },
        { problemKey: rate.problem.key, fetchStatement: false },
        { problemKey: stale.problem.key, fetchStatement: false },
        { problemKey: changed.problem.key, fetchStatement: false },
        { problemKey: unavailable.problem.key, fetchStatement: false },
        { problemKey: forbidden.problem.key, fetchStatement: false },
      ],
    });
    await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: prepared.batchId }, 202);
    const paused = await waitForBatch(bench, prepared.batchId, (current) => current.status !== 'running', 'the partial run');

    assert.equal(paused.status, 'paused');
    assert.deepEqual(
      paused.items.map((item) => item.failure?.code ?? null),
      [null, 'auth_required', 'rate_limited', 'stale_head', 'changed_response', 'unavailable', 'forbidden'],
      'each failure keeps its own sanitized code, and a stale head stays retryable',
    );
    assert.deepEqual(
      paused.items.map((item) => item.attempts),
      [1, 1, 1, 1, 1, 1, 1],
      'the batch layer adds no hidden retry',
    );
    const rateItem = paused.items[2];
    assert.ok(rateItem);
    assert.equal(rateItem.failure?.retryAfterMs, 4000);
    assert.equal(rateItem.failure?.retryable, true);
    const staleItem = paused.items[3];
    assert.ok(staleItem);
    assert.equal(staleItem.failure?.retryable, true);
    assert.equal(staleItem.result, null);
    assert.equal(paused.counts.completed, 1);
    assert.equal(paused.counts.attention, 6);
    assert.equal(JSON.stringify(paused).includes(SECRET_DETAIL), false);
    assert.equal(JSON.stringify(paused).includes(SECRET_BODY), false);
    assert.equal(adapter.callsFor(forbidden.problem.ref.externalKey), 1, 'an item after every failure still ran');

    // Retry-failed resets exactly the attention items, and a second start repeats only those.
    const completedBefore = paused.items[0];
    assert.ok(completedBefore);
    const retried = await okValue<MaterialRefreshBatchView>(bench, 'material.retryFailed', { batchId: prepared.batchId });
    assert.deepEqual(retried.items[0], completedBefore, 'the completed item is not reset');
    assert.equal(retried.status, 'paused', 'retry never resumes work on its own');
    assert.deepEqual(
      retried.items.slice(1).map((item) => item.status),
      ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'],
    );

    adapter.hooks.delete(stale.problem.ref.externalKey);
    for (let index = 0; index < 6; index += 1) {
      adapter.editorials.push(material);
    }
    await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: prepared.batchId }, 202);
    const completed = await waitForBatch(
      bench,
      prepared.batchId,
      (current) => current.status !== 'running',
      'the retried run',
    );
    assert.equal(completed.status, 'completed');
    assert.equal(adapter.callsFor(ok.problem.ref.externalKey), 1, 'the completed item is never fetched again');
    assert.deepEqual(completed.items[0], completedBefore);
  });
});

void test('a cancel before the first start retries to prepared, while a started cancel returns to paused', async () => {
  const target = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  await withBench([target], async (bench) => {
    await seedScope(bench.store, target);
    const adapter = bench.adapter(target.instance);

    // prepare → cancel → retry → explicit start: no platform read happened, so retry is `prepared`.
    const prepared = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [{ problemKey: target.problem.key, fetchStatement: false }],
    });
    const cancelled = await okValue<MaterialRefreshBatchView>(bench, 'material.cancel', { batchId: prepared.batchId });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.startedAt, null, 'cancel before the first start records no start instant');
    const retried = await okValue<MaterialRefreshBatchView>(bench, 'material.retryFailed', {
      batchId: prepared.batchId,
    });
    assert.equal(retried.status, 'prepared', 'retry must not claim a run that never happened');
    assert.equal(retried.cancelledAt, null);
    assert.deepEqual(
      retried.items.map((item) => item.status),
      ['pending'],
    );
    assert.equal(adapter.calls.length, 0, 'cancel and retry perform no platform request');
    adapter.editorials.push({ status: 'absent', detail: 'no editorial' });
    await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: prepared.batchId }, 202);
    const completed = await waitForBatch(
      bench,
      prepared.batchId,
      (current) => current.status !== 'running',
      'the restarted batch',
    );
    assert.equal(completed.status, 'completed');

    // started → cancel → retry → paused: a real run happened, so the resume target is `paused`.
    const secondBatch = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [{ problemKey: target.problem.key, fetchStatement: false }],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.gates.set(target.problem.ref.externalKey, gate);
    adapter.editorials.push(foundResult('cf-blog-a', 'https://codeforces.com/blog/entry/1', 'body'));
    await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: secondBatch.batchId }, 202);
    await waitForBatch(
      bench,
      secondBatch.batchId,
      (current) => current.items[0]?.status === 'running',
      'the item to be in flight',
    );
    const stopped = await okValue<MaterialRefreshBatchView>(bench, 'material.cancel', { batchId: secondBatch.batchId });
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.startedAt !== null, true, 'the start instant survives the cancel');
    release();
    await bench.service.whenSettled();
    adapter.gates.delete(target.problem.ref.externalKey);
    const paused = await okValue<MaterialRefreshBatchView>(bench, 'material.retryFailed', {
      batchId: secondBatch.batchId,
    });
    assert.equal(paused.status, 'paused', 'a batch that really ran returns to paused');
    assert.equal(paused.startedAt, stopped.startedAt);
    assert.deepEqual(
      paused.items.map((item) => item.status),
      ['pending'],
    );
    adapter.editorials.push(foundResult('cf-blog-a', 'https://codeforces.com/blog/entry/1', 'body'));
    await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: secondBatch.batchId }, 202);
    const resumed = await waitForBatch(
      bench,
      secondBatch.batchId,
      (current) => current.status !== 'running',
      'the resumed batch',
    );
    assert.equal(resumed.status, 'completed');
  });
});

void test('cancellation stops later items, reaches the active request and keeps the completed sibling', async () => {
  const first = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const active = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const never = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900C');
  await withBench([first, active, never], async (bench) => {
    for (const scope of [first, active, never]) {
      await seedScope(bench.store, scope);
    }
    const adapter = bench.adapter(first.instance);
    const material = foundResult('cf-blog-a', 'https://codeforces.com/blog/entry/1', 'body');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.gates.set(active.problem.ref.externalKey, gate);
    adapter.editorials.push(material);
    adapter.editorials.push(material);
    adapter.editorials.push(material);

    const prepared = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [
        { problemKey: first.problem.key, fetchStatement: false },
        { problemKey: active.problem.key, fetchStatement: false },
        { problemKey: never.problem.key, fetchStatement: false },
      ],
    });
    await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: prepared.batchId }, 202);
    const inFlight = await waitForBatch(
      bench,
      prepared.batchId,
      (current) => current.items[1]?.status === 'running',
      'the second item to be in flight',
    );
    assert.equal(inFlight.items[0]?.status, 'completed');

    const cancelled = await okValue<MaterialRefreshBatchView>(bench, 'material.cancel', { batchId: prepared.batchId });
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(
      cancelled.items.map((item) => item.status),
      ['completed', 'cancelled', 'cancelled'],
    );
    assert.equal(cancelled.items[0]?.result?.editorial, 'found', 'the completed sibling keeps its outcome');
    release();
    await bench.service.whenSettled();
    const activeCall = adapter.calls.find((call) => call.externalKey === active.problem.ref.externalKey);
    assert.ok(activeCall);
    assert.equal(activeCall.tokenCancelled, true, 'cancellation reached the token the platform read holds');
    assert.equal(adapter.callsFor(never.problem.ref.externalKey), 0, 'a pending item never starts after a cancel');

    const repeated = await okValue<MaterialRefreshBatchView>(bench, 'material.cancel', { batchId: prepared.batchId });
    assert.equal(canonicalJson(repeated), canonicalJson(cancelled), 'a repeated cancel is idempotent');
  });
});

void test('activation recovery pauses a dead process run, performs no request and requires an explicit resume', async () => {
  const target = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900A');
  const sibling = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900B');
  const pending = fx.makeScope('codeforces', 'codeforces.com', 'alice', '1900C');
  await withBench([target, sibling, pending], async (bench) => {
    for (const scope of [target, sibling, pending]) {
      await seedScope(bench.store, scope);
    }
    const adapter = bench.adapter(target.instance);
    // The durable state a dead process left behind: one in-flight item, one completed, one pending.
    let crashed = createMaterialRefreshBatch({
      batchId: 'material-batch-crashed',
      createdAt: BATCH_AT,
      items: [
        { problemKey: target.problem.key, fetchStatement: false },
        { problemKey: sibling.problem.key, fetchStatement: false },
        { problemKey: pending.problem.key, fetchStatement: false },
      ],
    });
    crashed = startMaterialRefreshBatch(crashed, BATCH_AT);
    crashed = completeMaterialRefreshItem(
      beginMaterialRefreshItem(crashed, 1, BATCH_AT),
      1,
      {
        statement: 'not_requested',
        editorial: 'found',
        mirror: 'skipped',
        sourceCount: 1,
        solutionCount: 1,
        snapshot: { snapshotId: 'snapshot-done', version: 1, contentHash: 'd'.repeat(64), changed: true },
      },
      BATCH_AT,
    );
    crashed = beginMaterialRefreshItem(crashed, 0, BATCH_AT);
    await bench.store.saveMaterialRefreshBatch(crashed, null);

    const fresh = bench.newService();
    try {
      const recovered = await fresh.recoverInterrupted(createCancellationSource().token);
      assert.deepEqual(recovered, ['material-batch-crashed']);
      assert.equal(adapter.calls.length, 0, 'recovery performs no platform request');
      assert.equal(fresh.activeRuns, 0);

      const view = await okValue<MaterialRefreshBatchView>(bench, 'material.detail', { batchId: 'material-batch-crashed' });
      assert.equal(view.status, 'paused');
      assert.deepEqual(
        view.items.map((item) => item.status),
        ['attention', 'completed', 'pending'],
      );
      assert.equal(view.items[0]?.failure?.code, 'interrupted');
      assert.equal(view.items[0]?.failure?.retryable, true);
      assert.equal(view.items[1]?.result?.editorial, 'found', 'the completed sibling survives recovery');
      assert.deepEqual(await fresh.recoverInterrupted(createCancellationSource().token), []);

      adapter.editorials.push(foundResult('cf-blog-a', 'https://codeforces.com/blog/entry/1', 'body'));
      adapter.editorials.push(foundResult('cf-blog-a', 'https://codeforces.com/blog/entry/1', 'body'));
      const retried = await okValue<MaterialRefreshBatchView>(bench, 'material.retryFailed', {
        batchId: 'material-batch-crashed',
      });
      assert.equal(retried.items[0]?.status, 'pending');
      await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: 'material-batch-crashed' }, 202);
      const completed = await waitForBatch(
        bench,
        'material-batch-crashed',
        (current) => current.status !== 'running',
        'the resumed batch',
      );
      assert.equal(completed.status, 'completed');
      assert.equal(adapter.callsFor(sibling.problem.ref.externalKey), 0, 'the completed item was never repeated');
    } finally {
      await fresh.close();
      await fresh.whenSettled();
    }
  });
});

// ---------------------------------------------------------------------------------------
// Redaction, surface and registration lifecycle
// ---------------------------------------------------------------------------------------

void test('every answer is recursively redacted, closed and free of a model surface', async () => {
  const sentinelHandle = 'HANDLESENTINEL42';
  const target = fx.makeScope('codeforces', 'codeforces.com', sentinelHandle, '1900A');
  const failing = fx.makeScope('codeforces', 'codeforces.com', sentinelHandle, '1900B');
  await withBench([target, failing], async (bench) => {
    await seedScope(bench.store, target);
    await seedScope(bench.store, failing);
    const adapter = bench.adapter(target.instance);
    adapter.editorials.push(foundResult('cf-blog-secret', `https://codeforces.com/blog/entry/7?x=${SECRET_URL}`, `solution ${SECRET_BODY}`));
    adapter.editorials.push(new PlatformError({ code: 'auth_required', operation: 'editorial', detail: SECRET_DETAIL, sample: SECRET_BODY }));
    const displayName = target.account.displayName;
    assert.ok(displayName !== null, 'the fixture account carries a display name to leak');

    const prepared = await okValue<MaterialRefreshBatchView>(bench, 'material.prepare', {
      items: [
        {
          problemKey: target.problem.key,
          accountId: target.account.id,
          fetchStatement: false,
          officialTutorialUrl: `https://codeforces.com/blog/entry/9?x=${SECRET_URL}`,
        },
        { problemKey: failing.problem.key, fetchStatement: false },
      ],
    });
    const started = await okValue<MaterialRefreshBatchView>(bench, 'material.start', { batchId: prepared.batchId }, 202);
    const view = await waitForBatch(bench, prepared.batchId, (current) => current.status !== 'running', 'the redacted run');
    const detail = await okValue<unknown>(bench, 'material.detail', { batchId: prepared.batchId });
    const list = await okValue<unknown>(bench, 'material.list', {});
    const cancelled = await okValue<unknown>(bench, 'material.cancel', { batchId: prepared.batchId });
    const retried = await okValue<unknown>(bench, 'material.retryFailed', { batchId: prepared.batchId });
    // All six routes — prepare, start, detail, list, cancel and retry — are one redaction surface.
    const serialized = JSON.stringify({ prepared, started, view, detail, list, cancelled, retried });
    for (const secret of [
      SECRET_BODY,
      SECRET_DETAIL,
      SECRET_URL,
      sentinelHandle,
      target.account.id,
      displayName,
      'cf-blog-secret',
      'solution ',
    ]) {
      assert.equal(serialized.includes(secret), false, `an answer must not carry ${secret}`);
    }
    assert.equal(view.items[0]?.hasOfficialTutorial, true, 'the URL is represented by a flag only');
    assert.equal(Object.prototype.hasOwnProperty.call(view.items[0], 'officialTutorialUrl'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(view.items[0], 'accountId'), false);

    const allowed = new Set([
      'batchId', 'status', 'revision', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'cancelledAt',
      'itemCount', 'counts', 'items', 'batches', 'total', 'limit', 'pending', 'running', 'completed',
      'attention', 'cancelled', 'changedSnapshots', 'problemKey', 'fetchStatement',
      'hasOfficialTutorial', 'attempts', 'failure', 'result', 'code', 'retryable', 'retryAfterMs',
      'statement', 'editorial', 'mirror', 'sourceCount', 'solutionCount', 'snapshot', 'snapshotId',
      'version', 'contentHash', 'changed',
    ]);
    const forbidden = /^(model|provider|prompt|promptVersion|usage|tokens|budget|cost|cookie|session|credential|vault|apiKey|password|secret|detail|sample|rawTags|title|displayName|handle|text|body)$/iu;
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (value === null || typeof value !== 'object') {
        return;
      }
      for (const [key, entry] of Object.entries(value)) {
        assert.ok(allowed.has(key), `${path}.${key} is not part of the bulk material-refresh contract`);
        assert.equal(forbidden.test(key), false, `${path}.${key} names a forbidden surface`);
        walk(entry, `${path}.${key}`);
      }
    };
    walk(view, 'view');
    walk(list, 'list');
    assert.deepEqual(bench.internalErrors, [], 'a sanitized platform failure is data, not an internal error');
    assert.deepEqual(
      Object.keys(materialBatchApiModule).filter((name) => /model|llm|prompt|budget|analysis|reasoning/iu.test(name)),
      [],
      'the route module must not export a model surface',
    );
  });
});

/** A service stub that satisfies registration without doing any work. */
function stubService(): MaterialRefreshBatchService {
  const noop = async (): Promise<never> => {
    throw new Error('not used by registration');
  };
  return {
    prepare: noop,
    start: noop,
    detail: noop,
    list: noop,
    cancel: noop,
    retryFailed: noop,
  } as unknown as MaterialRefreshBatchService;
}

void test('registration is all-or-nothing, disposal is memoized and a bad service is refused', async () => {
  await assert.rejects(
    registerMaterialBatchApi({
      registry: { register: () => async () => undefined },
      service: {} as unknown as MaterialRefreshBatchService,
    }),
    (error: unknown) => error instanceof TypeError && /prepare/u.test(error.message),
  );

  const released: string[] = [];
  const reported: unknown[] = [];
  const failingRegistry: HostConnectionFetch = {
    register(route) {
      if (route.path.endsWith('material.detail')) {
        throw new Error('the registry refused this route');
      }
      return async () => {
        released.push(route.path);
        if (route.path.endsWith('material.start')) {
          throw new Error('the start route could not be released');
        }
      };
    },
  };
  await assert.rejects(
    registerMaterialBatchApi({
      registry: failingRegistry,
      service: stubService(),
      onDisposeError: (error) => {
        reported.push(error);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'the registry refused this route', 'the original failure is retained');
      const failures = (error as { cleanupFailures?: readonly unknown[] }).cleanupFailures;
      assert.equal(failures?.length, 1, 'cleanup failures travel with the original failure');
      return true;
    },
  );
  assert.deepEqual(released, [`${API_PREFIX}material.start`, `${API_PREFIX}material.prepare`]);
  assert.equal(reported.length, 1);

  const releases = new Map<string, number>();
  const countingRegistry: HostConnectionFetch = {
    register(route) {
      return async () => {
        releases.set(route.path, (releases.get(route.path) ?? 0) + 1);
      };
    },
  };
  const dispose = await registerMaterialBatchApi({ registry: countingRegistry, service: stubService() });
  const first = dispose();
  const second = dispose();
  assert.equal(first, second, 'repeated disposal shares one memoized promise');
  await first;
  assert.equal(releases.size, 6);
  assert.deepEqual([...releases.values()], [1, 1, 1, 1, 1, 1]);
});
