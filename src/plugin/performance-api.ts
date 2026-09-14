/**
 * Typed HTTP boundary of the virtual-contest performance ledger (Sprint 18c).
 *
 * Three routes — `performance.list`, `performance.save`, `performance.delete` — registered through
 * the same authenticated Connection Fetch envelope as every other operation, and delegated to the
 * accepted {@link VirtualPerformanceService}. This module owns only the boundary: a closed request
 * shape (an unknown own key is refused, never dropped), the documented numeric bounds, and the
 * mapping of typed domain refusals onto stable transport codes. It never validates semantics the
 * service or the domain validator own (URL credentials, past dates, duplicate contests, revision
 * CAS), so those refusals keep their single implementation.
 *
 * Two product rules show up here as shape:
 *
 * - **No client-supplied provenance.** The request has no `source` field at all: the server injects
 *   `user_import`, and the official rating path is a different operation entirely.
 * - **No paid work.** Every handler is a local store read or write; nothing in this file contacts a
 *   model, a platform or the network, so CRUD can never trigger an unsolicited inference.
 */
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import type { ApiRequest, WorkbenchApiMap } from '../application/workbench-api.js';
import type { VirtualPerformanceService } from '../application/virtual-performance-service.js';
import {
  MAX_VIRTUAL_PERFORMANCE_EVIDENCE_ID_CHARS,
  MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS,
  MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS,
  MAX_VIRTUAL_PERFORMANCE_URL_CHARS,
  VIRTUAL_PERFORMANCE_INDEPENDENCE,
  VIRTUAL_PERFORMANCE_MAX,
  VIRTUAL_PERFORMANCE_MIN,
  type CancellationToken,
  type VirtualPerformanceIndependence,
} from '../domain/index.js';
import { ApiTransportError, registerApiRoute, type ApiRouteOptions } from './api-transport.js';
import { mapBusinessError } from './api-validation.js';
import { disposeAll, rollback } from './lifecycle.js';

type Check = (value: unknown) => void;
const bad = (): never => {
  throw new ApiTransportError('invalid_input');
};
/** Longest accepted account/id text at this boundary; the store's own ids are far shorter. */
const MAX_API_ID_TEXT = 512;
/**
 * A non-empty string within `max` characters.
 *
 * Horizontal tabs and line breaks stay legal (a pasted note may contain them), while NUL and the
 * other control characters are refused before any store write.
 */
const text = (max: number): Check => (value) => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  ) {
    bad();
  }
};
const bool: Check = (value) => {
  if (typeof value !== 'boolean') bad();
};
const integer = (min: number, max: number): Check => (value) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) bad();
};
const nullable = (check: Check): Check => (value) => {
  if (value !== null) check(value);
};
const independence: Check = (value) => {
  if (!VIRTUAL_PERFORMANCE_INDEPENDENCE.includes(value as VirtualPerformanceIndependence)) bad();
};

/** Closed JSON request validation; the service and the domain re-validate every semantic field. */
function requestShape<T>(required: Record<string, Check>, optional: Record<string, Check> = {}): (value: unknown) => T {
  return (value) => {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      bad();
    }
    const object = value as Record<string, unknown>;
    for (const field of Object.keys(required)) {
      if (!Object.hasOwn(object, field)) bad();
    }
    for (const field of Object.keys(object)) {
      const fieldCheck = Object.hasOwn(required, field) ? required[field] : Object.hasOwn(optional, field) ? optional[field] : undefined;
      if (!fieldCheck) bad();
      fieldCheck!(object[field]);
    }
    return value as T;
  };
}

export interface PerformanceApiOptions extends ApiRouteOptions {
  readonly registry: HostConnectionFetch;
  readonly service: VirtualPerformanceService;
}

/**
 * Register the three performance routes atomically.
 *
 * A failure while registering disposes everything already registered, so a partially wired boundary
 * never serves a request. The returned disposer releases exactly this module's contributions.
 */
export async function registerPerformanceApi({
  registry,
  service,
  ...options
}: PerformanceApiOptions): Promise<() => Promise<void>> {
  const disposers: (() => Promise<void>)[] = [];
  function add<K extends keyof WorkbenchApiMap>(
    operation: K,
    required: Record<string, Check>,
    optional: Record<string, Check>,
    handle: (input: ApiRequest<K>, token: CancellationToken) => Promise<unknown>,
  ): void {
    const validate = requestShape<ApiRequest<K>>(required, optional);
    disposers.push(
      registerApiRoute(
        registry,
        {
          operation,
          method: 'POST',
          validate,
          handle: async (input, token) => {
            try {
              return await handle(input, token);
            } catch (error) {
              throw mapBusinessError(error);
            }
          },
        },
        options,
      ),
    );
  }
  const accountId = text(MAX_API_ID_TEXT);
  const revision = integer(0, Number.MAX_SAFE_INTEGER);
  const evidenceId = text(MAX_VIRTUAL_PERFORMANCE_EVIDENCE_ID_CHARS);
  try {
    add('performance.list', { accountId }, {}, (input, token) => service.list(input, token));
    add(
      'performance.save',
      {
        accountId,
        expectedRevision: revision,
        contestId: integer(1, Number.MAX_SAFE_INTEGER),
        participatedAt: text(64),
        performance: integer(VIRTUAL_PERFORMANCE_MIN, VIRTUAL_PERFORMANCE_MAX),
        calculationMethod: text(MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS),
        sourceUrl: text(MAX_VIRTUAL_PERFORMANCE_URL_CHARS),
        independence,
        priorExposure: bool,
      },
      {
        evidenceId: nullable(evidenceId),
        rank: nullable(integer(1, Number.MAX_SAFE_INTEGER)),
        note: nullable(text(MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS)),
      },
      (input, token) => service.save(input, token),
    );
    add('performance.delete', { accountId, expectedRevision: revision, evidenceId }, {}, (input, token) =>
      service.delete(input, token),
    );
    return disposeAll(disposers);
  } catch (error) {
    return rollback(error, disposers);
  }
}
