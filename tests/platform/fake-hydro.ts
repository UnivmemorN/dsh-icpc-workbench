/**
 * Fake Hydro adapter (test double).
 *
 * Hydro is designed for but not implemented in v1, so this double exists to keep the platform
 * port fully implemented in tests (including the additive `fetchProblem` operation) and to let
 * instance/domain/account scoping be exercised. It advertises `implemented: false` and a note, so
 * nothing can mistake it for real Hydro support.
 */
import type {
  EditorialFetchResult,
  FetchEditorialRequest,
  FetchProblemRequest,
  ListProblemsRequest,
  ListSubmissionsRequest,
  Page,
  PlatformAdapter,
  PlatformCapabilities,
} from '../../src/application/ports.js';
import {
  accountIdOf,
  createNormalizedProblem,
  createSourceInstance,
  createSubmission,
  type NormalizedProblem,
  type Submission,
} from '../../src/domain/index.js';

export const FAKE_HYDRO_AT = '2026-09-12T00:00:00.000Z';

const FAKE_HYDRO_REF = { domain: null, externalKey: 'P1001' } as const;

export function createFakeHydroAdapter(): PlatformAdapter {
  const sourceInstance = createSourceInstance({
    platform: 'hydro',
    baseUrl: 'http://localhost:8080',
    displayName: 'Hydro (test double)',
  });
  const ref = { sourceInstanceId: sourceInstance.id, domain: null, externalKey: FAKE_HYDRO_REF.externalKey };
  const problem: NormalizedProblem = createNormalizedProblem({
    ref,
    title: 'Fake Hydro problem',
    url: 'http://localhost:8080/p/P1001',
    statement: 'Given n, print n.',
    fetchedAt: FAKE_HYDRO_AT,
  });
  const accountId = accountIdOf(sourceInstance.id, 'pupil');
  const submissions: readonly Submission[] = [
    createSubmission({
      accountId,
      ref,
      externalId: '9001',
      verdict: 'accepted',
      submittedAt: FAKE_HYDRO_AT,
      language: 'C++17',
      timeMs: 12,
      memoryKb: 2048,
    }),
  ];
  return {
    sourceInstance,
    capabilities(): PlatformCapabilities {
      return {
        platform: 'hydro',
        implemented: false,
        problems: true,
        submissions: true,
        editorial: false,
        pagedProblems: false,
        pagedSubmissions: false,
        requiresAuth: true,
        supportsAccountHistory: false,
        minRequestIntervalMs: null,
        notes: ['Test double only: no Hydro adapter is implemented in v1.'],
      };
    },
    async listProblems(_request: ListProblemsRequest): Promise<Page<NormalizedProblem>> {
      return { items: [problem], nextCursor: null, fetchedAt: FAKE_HYDRO_AT };
    },
    async fetchProblem(_request: FetchProblemRequest): Promise<NormalizedProblem> {
      return problem;
    },
    async listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>> {
      const items = request.account.sourceInstanceId === sourceInstance.id ? submissions : [];
      return { items, nextCursor: null, fetchedAt: FAKE_HYDRO_AT };
    },
    async fetchEditorial(_request: FetchEditorialRequest): Promise<EditorialFetchResult> {
      return {
        status: 'unavailable',
        detail: 'Hydro editorial retrieval is not implemented in v1',
        retryable: false,
      };
    },
  };
}
