/**
 * Synthetic fixtures for the Sprint 17c2 synchronization-service and connection tests.
 *
 * Everything is generated in-process: an in-memory credential vault, a deterministic clock, a
 * synthetic `/record/list` feed the **real** Sprint 17a reader parses, and a metadata adapter that
 * records what the sync service asks for. No real credential, no network and no native OS call is
 * involved, and every timestamp is explicit.
 */
import {
  createNormalizedProblem,
  createSourceInstance,
  problemKey,
  type SourceInstance,
} from '../../src/domain/index.js';
import {
  LocalCredentialVaultError,
  type LocalCredentialVault,
  type LocalCredentialVaultCapabilities,
} from '../../src/application/local-credential-vault.js';
import { PlatformError } from '../../src/application/platform-errors.js';
import type {
  FetchProblemRequest,
  PlatformAdapter,
  PlatformCapabilities,
} from '../../src/application/ports.js';
import type { FetchInitLike, FetchLike, FetchResponseLike, SetTimerFn } from '../../src/adapters/platform/http.js';
import type { CancellationToken } from '../../src/domain/index.js';

/** Fixed start instant of every fixture clock. */
export const START = '2026-09-12T08:00:00.000Z';
export const START_MS = Date.parse(START);
/** Official Luogu domain the adapters insist on. */
export const OFFICIAL_DOMAIN = 'www.luogu.com.cn';

/** One synthetic record as the Lentille envelope reports it. */
export interface SyntheticRecord {
  readonly id: number;
  readonly pid: string;
  readonly status: number;
  readonly submitTimeSeconds: number;
  readonly language: string | null;
}

/**
 * Newest-first record list: strictly decreasing ids and non-increasing times, so the real reader's
 * drift checks accept it. Timestamps start at the fixture clock start, so an incremental scan of a
 * seven-day window still sees every record.
 */
export function buildRecords(
  total: number,
  pids: readonly string[],
  options: { readonly startId?: number; readonly baseSeconds?: number; readonly stepSeconds?: number } = {},
): SyntheticRecord[] {
  if (pids.length === 0) {
    throw new Error('buildRecords requires at least one problem id');
  }
  const startId = options.startId ?? 900_000;
  const baseSeconds = options.baseSeconds ?? Math.floor(START_MS / 1000);
  const stepSeconds = options.stepSeconds ?? 60;
  const records: SyntheticRecord[] = [];
  for (let index = 0; index < total; index += 1) {
    records.push({
      id: startId - index,
      pid: pids[index % pids.length]!,
      status: index % 7 === 0 ? 12 : 6,
      submitTimeSeconds: baseSeconds - index * stepSeconds,
      language: 'C++17',
    });
  }
  return records;
}

/** Split a newest-first record list into declared server pages of `perPage` rows. */
export function toPages(records: readonly SyntheticRecord[], perPage = 50): SyntheticRecord[][] {
  const pages: SyntheticRecord[][] = [];
  for (let offset = 0; offset < records.length; offset += perPage) {
    pages.push(records.slice(offset, offset + perPage));
  }
  return pages.length === 0 ? [[]] : pages;
}

/** One observed fetch, so tests can assert what was requested and which cookie travelled. */
export interface FeedCall {
  readonly uid: string;
  readonly page: number;
  readonly cookie: string | null;
}

export interface RecordFeed {
  readonly fetchImpl: FetchLike;
  readonly calls: FeedCall[];
  /** Per-account server pages; the reader re-reads a page, so the content must be stable. */
  readonly pages: Map<string, SyntheticRecord[][]>;
  /** Replaces the answer of every request; may throw a typed error to simulate a failure. */
  override: ((url: URL, init: FetchInitLike) => FetchResponseLike) | null;
  /** Number of upcoming requests to park until `release()`. */
  holdNext: number;
  release(): void;
  heldCount(): number;
}

function rawRecord(record: SyntheticRecord): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    submitTime: record.submitTimeSeconds,
    problem: { pid: record.pid },
    language: record.language,
  };
}

/** Bytes for one synthetic response body. */
export function bodyOf(text: string): FetchResponseLike['body'] {
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return {
    getReader() {
      return {
        async read() {
          if (done) {
            return { done: true, value: undefined };
          }
          done = true;
          return { done: false, value: bytes };
        },
        async cancel() {},
      };
    },
  };
}

export function jsonResponse(value: unknown, status = 200): FetchResponseLike {
  return {
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
    },
    body: bodyOf(JSON.stringify(value)),
  };
}

export function htmlResponse(text: string, status = 200): FetchResponseLike {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    body: bodyOf(text),
  };
}

/** One synthetic `/record/list` feed the real authenticated reader can parse. */
export function createRecordFeed(pages: Map<string, SyntheticRecord[][]> = new Map()): RecordFeed {
  const calls: FeedCall[] = [];
  const held: Array<() => void> = [];
  const state: RecordFeed = {
    calls,
    pages,
    override: null,
    holdNext: 0,
    release() {
      for (const resolve of held.splice(0)) {
        resolve();
      }
    },
    heldCount: () => held.length,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      const uid = parsed.searchParams.get('user') ?? '';
      const page = Number(parsed.searchParams.get('page') ?? '0');
      calls.push({ uid, page, cookie: init.headers['cookie'] ?? null });
      const forced = state.override;
      if (forced !== null) {
        return forced(parsed, init);
      }
      if (state.holdNext > 0) {
        state.holdNext -= 1;
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
      }
      const plan = state.pages.get(uid) ?? [];
      const records = plan[page - 1] ?? [];
      const count = plan.reduce((total, entry) => total + entry.length, 0);
      return jsonResponse({ data: { records: { result: records.map(rawRecord), perPage: 50, count } } });
    },
  };
  return state;
}

/** Deterministic clock: `now()` is the ISO form, `nowMs()` the epoch form. */
export interface TestClock {
  now(): string;
  nowMs(): number;
  advance(ms: number): void;
  set(iso: string): void;
}

export function createClock(startIso: string = START): TestClock {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms).toISOString(),
    nowMs: () => ms,
    advance: (delta) => {
      ms += delta;
    },
    set: (iso) => {
      ms = Date.parse(iso);
    },
  };
}

/** Cancellation-aware wait that records the requested delays instead of sleeping. */
export interface Waits {
  readonly wait: (ms: number, token: CancellationToken) => Promise<void>;
  readonly delays: number[];
}

export function createWait(): Waits {
  const delays: number[] = [];
  return {
    delays,
    wait: async (ms, token) => {
      token.throwIfCancelled();
      delays.push(ms);
    },
  };
}

/** A timer seam that never fires: timeouts stay deterministic and cannot abort a synthetic fetch. */
export const neverFireTimer: SetTimerFn = () => () => {};

/** In-memory OS-vault stand-in with observable writes, removals and injectable failures. */
export interface MemoryVault extends LocalCredentialVault {
  readonly secrets: Map<string, string>;
  readonly writes: string[];
  readonly removals: string[];
  implemented: boolean;
  platform: string;
  readonly failRemove: Set<string>;
  readonly failWrite: Set<string>;
  beforeWrite: ((reference: string, secret: string) => void | Promise<void>) | null;
  beforeRemove: ((reference: string) => void | Promise<void>) | null;
}

export function createMemoryVault(
  options: { readonly implemented?: boolean; readonly platform?: string; readonly records?: Record<string, string> } = {},
): MemoryVault {
  const secrets = new Map<string, string>(Object.entries(options.records ?? {}));
  const writes: string[] = [];
  const removals: string[] = [];
  const failRemove = new Set<string>();
  const failWrite = new Set<string>();
  const state: MemoryVault = {
    secrets,
    writes,
    removals,
    failRemove,
    failWrite,
    implemented: options.implemented ?? true,
    platform: options.platform ?? 'win32',
    beforeWrite: null,
    beforeRemove: null,
    capabilities(): LocalCredentialVaultCapabilities {
      return { implemented: state.implemented, platform: state.platform, notes: [] };
    },
    async read(reference, token) {
      token.throwIfCancelled();
      if (!state.implemented) {
        throw new LocalCredentialVaultError('unsupported');
      }
      return secrets.get(reference) ?? null;
    },
    async write(reference, secret, token) {
      token.throwIfCancelled();
      if (!state.implemented) {
        throw new LocalCredentialVaultError('unsupported');
      }
      if (state.beforeWrite !== null) {
        await state.beforeWrite(reference, secret);
      }
      if (failWrite.has(reference)) {
        throw new LocalCredentialVaultError('unavailable');
      }
      writes.push(reference);
      secrets.set(reference, secret);
    },
    async remove(reference, token) {
      token.throwIfCancelled();
      if (!state.implemented) {
        throw new LocalCredentialVaultError('unsupported');
      }
      if (state.beforeRemove !== null) {
        await state.beforeRemove(reference);
      }
      if (failRemove.has(reference)) {
        throw new LocalCredentialVaultError('unavailable');
      }
      removals.push(reference);
      secrets.delete(reference);
    },
  };
  return state;
}

/** Canonical official Luogu source instance. */
export function officialInstance(): SourceInstance {
  return createSourceInstance({
    platform: 'luogu',
    baseUrl: 'https://www.luogu.com.cn',
    domain: OFFICIAL_DOMAIN,
    displayName: 'Luogu',
  });
}

/** One synthetic session cookie carrying the account's own UID and an opaque client id. */
export function cookieFor(uid: string, marker = 'opaque-client-id'): string {
  return `_uid=${uid}; __client_id=${marker}`;
}

/** The canonical form {@link cookieFor} normalizes to: `__client_id` first, then `_uid`. */
export function canonicalCookieFor(uid: string, marker = 'opaque-client-id'): string {
  return `__client_id=${marker}; _uid=${uid}`;
}

/** Canonical stored problem key of one external id of `instance`. */
export function problemKeyOf(instance: SourceInstance, externalKey: string): string {
  return problemKey({ sourceInstanceId: instance.id, domain: null, externalKey });
}

/** Distinct canonical backlog keys; used to seed a nearly full metadata backlog. */
export function buildProblemKeys(instance: SourceInstance, keys: readonly string[]): string[] {
  return keys.map((key) => problemKeyOf(instance, key));
}

/** What the sync service asked the metadata source for. */
export interface MetadataHarness {
  readonly adapter: PlatformAdapter;
  readonly calls: string[];
  readonly fail: Map<string, PlatformError>;
  editorialCalls(): number;
}

/** Anonymous metadata source that answers only `fetchProblem` and never an editorial request. */
export function createMetadataAdapter(instance: SourceInstance, now: () => string): MetadataHarness {
  const calls: string[] = [];
  const fail = new Map<string, PlatformError>();
  let editorial = 0;
  const adapter: PlatformAdapter = {
    sourceInstance: instance,
    capabilities(): PlatformCapabilities {
      return {
        platform: 'luogu',
        implemented: true,
        problems: true,
        submissions: false,
        editorial: false,
        pagedProblems: true,
        pagedSubmissions: false,
        requiresAuth: false,
        supportsAccountHistory: false,
        minRequestIntervalMs: null,
        notes: [],
      };
    },
    async listProblems() {
      throw new Error('the sync service must not list problems through the metadata source');
    },
    async listSubmissions() {
      throw new Error('the sync service must not list submissions through the metadata source');
    },
    async fetchProblem(request: FetchProblemRequest) {
      const pid = request.problemRef.externalKey;
      calls.push(pid);
      const failure = fail.get(pid);
      if (failure !== undefined) {
        throw failure;
      }
      return createNormalizedProblem({
        ref: request.problemRef,
        title: `Problem ${pid}`,
        url: `https://${instance.domain}/problem/${pid}`,
        statement: null,
        fetchedAt: now(),
        ratings: [{ dimension: 'rating', value: 1800, scale: { min: 800, max: 3500 }, raw: '1800' }],
        rawTags: ['dp'],
      });
    },
    async fetchEditorial() {
      editorial += 1;
      return { status: 'absent', detail: 'the sync service must never request editorial material' };
    },
  };
  return { adapter, calls, fail, editorialCalls: () => editorial };
}

/** Let pending microtasks and one macrotask run until `predicate` holds. */
export async function until(predicate: () => boolean, label: string, limit = 5_000): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`condition was not reached: ${label}`);
}
