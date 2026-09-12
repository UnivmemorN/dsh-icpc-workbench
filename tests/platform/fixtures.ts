/**
 * Synthetic fixtures and a deterministic HTTP harness for the platform adapter tests.
 *
 * Nothing here contacts the network: every response is an in-process `Response`, the clock is a
 * counter and the pacing wait advances that counter. Fixtures are original, tiny payloads in the
 * observed official shapes; no downloaded blog or benchmark body is included.
 */
import {
  HttpTransport,
  type ClockFn,
  type FetchInitLike,
  type FetchLike,
  type SetTimerFn,
  type WaitFn,
} from '../../src/adapters/platform/http.js';
import type { CancellationToken } from '../../src/domain/index.js';

export const AT = '2026-09-12T00:00:00.000Z';

export interface HarnessRequest {
  readonly url: string;
  readonly init: FetchInitLike;
  /** Fake clock value when fetch was invoked. */
  readonly at: number;
}

export interface HttpHarnessOptions {
  readonly routes: Readonly<Record<string, (url: URL, init: FetchInitLike) => Response | Promise<Response>>>;
  readonly origin?: string;
  readonly minRequestIntervalMs?: number;
  readonly platformMinRequestIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxResponseBytes?: number;
  readonly maxRetryAfterMs?: number;
}

/** Injectable wiring behind a harness; reused by adapters that build their own transport. */
export interface HttpHarnessImpl {
  readonly fetchImpl: FetchLike;
  readonly clock: ClockFn;
  readonly wait: WaitFn;
  readonly setTimer: SetTimerFn;
}

export interface HttpHarness {
  readonly transport: HttpTransport;
  readonly requests: HarnessRequest[];
  readonly waits: number[];
  readonly timers: (() => void)[];
  /** The same fake fetch/clock/wait/timer wiring the harness transport was built with. */
  readonly impl: HttpHarnessImpl;
  now(): number;
  advance(ms: number): void;
  fireTimers(): void;
}

/** Build a transport whose fetch, clock, pacing wait and timeout timer are all injectable. */
export function createHttpHarness(options: HttpHarnessOptions): HttpHarness {
  let now = 0;
  const requests: HarnessRequest[] = [];
  const waits: number[] = [];
  const timers: (() => void)[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, init, at: now });
    const parsed = new URL(url);
    const responder = options.routes[parsed.pathname];
    if (responder === undefined) {
      return jsonResponse({ status: 'FAILED', comment: 'route not stubbed' }, 404);
    }
    return responder(parsed, init);
  };
  const impl: HttpHarnessImpl = {
    fetchImpl,
    clock: () => now,
    wait: async (ms: number, token: CancellationToken) => {
      waits.push(ms);
      now += ms;
      token.throwIfCancelled();
    },
    setTimer: (callback: () => void) => {
      timers.push(callback);
      return () => {};
    },
  };
  const transport = new HttpTransport({
    origin: options.origin ?? 'https://codeforces.com',
    minRequestIntervalMs: options.minRequestIntervalMs ?? 0,
    platformMinRequestIntervalMs: options.platformMinRequestIntervalMs ?? 0,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 0,
    maxResponseBytes: options.maxResponseBytes,
    maxRetryAfterMs: options.maxRetryAfterMs,
    ...impl,
  });
  return {
    transport,
    requests,
    waits,
    timers,
    impl,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    fireTimers: () => {
      for (const timer of [...timers]) {
        timer();
      }
    },
  };
}

/** Let queued microtasks (and the queue) progress without real time. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

/** A response that never settles until the request signal aborts. */
export function hangUntilAbort(url: URL, init: FetchInitLike): Promise<Response> {
  void url;
  return new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true });
  });
}

/** A 200 response whose body never finishes. */
export function stalledBodyResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // Intentionally never enqueues: only cancellation/timeout can end this body.
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
}

/** A 200 response that exceeds any small cap and whose `cancel()` never settles. */
export function unstoppableBodyResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4096));
    },
    cancel() {
      // Intentionally never settles: a transport that awaits body teardown would hang here.
      return new Promise<void>(() => {});
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
}

export function catalogProblem(options: {
  contestId: number;
  index: string;
  name: string;
  rating?: number | null;
  tags?: readonly string[];
}): Record<string, unknown> {
  const problem: Record<string, unknown> = {
    contestId: options.contestId,
    index: options.index,
    name: options.name,
    type: 'PROGRAMMING',
  };
  if (options.rating !== undefined && options.rating !== null) {
    problem.rating = options.rating;
  }
  problem.tags = [...(options.tags ?? [])];
  return problem;
}

export function catalogPayload(problems: readonly Record<string, unknown>[]): unknown {
  return { status: 'OK', result: { problems: [...problems], problemStatistics: [] } };
}

/** Default catalog: three problems, the third without a rating. */
export function defaultCatalog(): unknown {
  return catalogPayload([
    catalogProblem({ contestId: 1234, index: 'A', name: 'Watermelon', rating: 800, tags: ['math', 'brute force'] }),
    catalogProblem({ contestId: 1234, index: 'B', name: 'Two Buttons', rating: 2400, tags: ['dp', 'trees'] }),
    catalogProblem({ contestId: 1235, index: 'C', name: 'No Rating Here', tags: ['unknown tag'] }),
  ]);
}

export interface ProblemPageOptions {
  contestId?: number;
  index?: string;
  title?: string;
  statementHtml?: string;
  tags?: readonly string[];
  /** `null` omits the rating tag box entirely. */
  rating?: number | null;
  tutorialBlogId?: number | null;
}

const DEFAULT_STATEMENT_HTML =
  '<p>Split <span class="tex-span">w</span> into two even parts with w &lt;= 100 &amp; w &gt; 2.</p>' +
  '<p>Formula x<sup>2</sup> + y<sub>1</sub> and a figure <img src="split.png" alt="diagram of the split">.</p>' +
  '<p>Bound <script type="math/tex">n \\le 100</script> applies.</p>' +
  '<script>tracking()</script>';

export function problemPageHtml(options: ProblemPageOptions = {}): string {
  const index = options.index ?? 'A';
  const rating = options.rating === undefined ? 800 : options.rating;
  const tags = options.tags ?? ['math', 'brute force'];
  const ratingBox = rating === null ? '' : `<span class="tag-box" title="Difficulty">*${rating}</span>`;
  const tagBoxes = `${ratingBox}${tags.map((tag) => `<span class="tag-box">${tag}</span>`).join('')}`;
  const tutorial =
    options.tutorialBlogId === undefined || options.tutorialBlogId === null
      ? ''
      : `<div class="roundbox"><a href="/blog/entry/${options.tutorialBlogId}">Tutorial</a></div>`;
  return (
    '<!doctype html><html><head><title>Problem</title>' +
    '<script>window.analytics = "tracking";</script><style>.hidden { color: red; }</style></head><body>' +
    `${tutorial}<div class="problem-statement"><div class="header"><div class="title">${index}. ${
      options.title ?? 'Watermelon'
    }</div><div class="time-limit">1 second</div></div>` +
    `<div class="tags">${tagBoxes}</div><div>${options.statementHtml ?? DEFAULT_STATEMENT_HTML}</div></div>` +
    '</body></html>'
  );
}

/** Anti-bot challenge page in the shape observed for anonymous Codeforces requests. */
export function challengeHtml(): string {
  return (
    '<!doctype html><html><head><title>Just a moment...</title></head><body>' +
    '<div id="cf-challenge"><form id="challenge-form" action="/cdn-cgi/challenge-platform/h/b">' +
    '<p>Enable JavaScript and cookies to continue</p></form></div></body></html>'
  );
}

/** A page with no `.problem-statement` node at all. */
export function layoutChangedHtml(): string {
  return '<!doctype html><html><body><div class="new-layout"><h1>Something else</h1></div></body></html>';
}

export interface SubmissionItemOptions {
  id: number;
  at: string;
  verdict?: string;
  contestId?: number;
  index?: string;
  memoryBytes?: number | null;
  memoryConsumedBytes?: number | null;
  timeConsumedMillis?: number | null;
  language?: string | null;
  /** Author handle of a single-member author (defaults to `alice`). */
  author?: string;
  /** Member handles of the author; a team submission lists the requested handle among them. */
  members?: readonly string[];
  /** Full author value, for malformed/foreign-shape regressions (wins over `author`/`members`). */
  authorOverride?: unknown;
  /** Overrides the derived unix seconds, including invalid/null values for time regressions. */
  creationTimeSeconds?: number | null;
}

export function cfSubmissionItem(options: SubmissionItemOptions): Record<string, unknown> {
  const members = [...(options.members ?? [options.author ?? 'alice'])];
  const author =
    options.authorOverride !== undefined
      ? options.authorOverride
      : { participantType: members.length > 1 ? 'TEAM' : 'CONTESTANT', members: members.map((handle) => ({ handle })) };
  const item: Record<string, unknown> = {
    id: options.id,
    creationTimeSeconds:
      options.creationTimeSeconds !== undefined
        ? options.creationTimeSeconds
        : Math.floor(Date.parse(options.at) / 1000),
    problem: {
      contestId: options.contestId ?? 1234,
      index: options.index ?? 'A',
      name: 'Watermelon',
    },
    author,
  };
  if (options.verdict !== undefined) {
    item.verdict = options.verdict;
  }
  if (options.memoryBytes !== undefined && options.memoryBytes !== null) {
    item.memoryBytes = options.memoryBytes;
  }
  if (options.memoryConsumedBytes !== undefined && options.memoryConsumedBytes !== null) {
    item.memoryConsumedBytes = options.memoryConsumedBytes;
  }
  if (options.timeConsumedMillis !== undefined && options.timeConsumedMillis !== null) {
    item.timeConsumedMillis = options.timeConsumedMillis;
  }
  if (options.language !== undefined && options.language !== null) {
    item.programmingLanguage = options.language;
  }
  return item;
}

export function userStatusPayload(items: readonly Record<string, unknown>[]): unknown {
  return { status: 'OK', result: [...items] };
}

export function failedUserStatusPayload(comment: string): unknown {
  return { status: 'FAILED', comment };
}

/** Newest-first submissions used by the paging tests. */
export function defaultSubmissions(): Record<string, unknown>[] {
  return [
    cfSubmissionItem({
      id: 40,
      at: '2026-09-11T10:00:00.000Z',
      verdict: 'OK',
      memoryBytes: 262144,
      timeConsumedMillis: 0,
      language: 'GNU G++17',
    }),
    cfSubmissionItem({ id: 39, at: '2026-09-10T10:00:00.000Z', verdict: 'TESTING', memoryBytes: 1024, timeConsumedMillis: 15 }),
    cfSubmissionItem({ id: 38, at: '2026-09-09T10:00:00.000Z', verdict: 'WRONG_ANSWER', memoryBytes: 0, timeConsumedMillis: 31 }),
    cfSubmissionItem({ id: 37, at: '2026-09-08T10:00:00.000Z', verdict: 'COMPILATION_ERROR' }),
    cfSubmissionItem({ id: 36, at: '2026-09-07T10:00:00.000Z', verdict: 'RUNTIME_ERROR_MEMORY_LIMIT_EXCEEDED' }),
  ];
}

/** Slice the newest-first list the way the official `from`/`count` parameters address it. */
export function statusSlice(items: readonly Record<string, unknown>[], url: URL): Response {
  const from = Number(url.searchParams.get('from') ?? '1');
  const count = Number(url.searchParams.get('count') ?? '100');
  return jsonResponse(userStatusPayload(items.slice(from - 1, from - 1 + count)));
}

export interface BlogEntryPayloadOptions {
  id: number;
  /** Result id the server answers with; defaults to `id`, so only an explicit mismatch differs. */
  resultId?: number;
  /** Plain title; the observed official payload sends an HTML fragment here instead. */
  title?: string;
  /** Explicit HTML title field, preferred by the adapter when present. */
  titleHTML?: string;
  content?: string;
  creationTimeSeconds?: number | null;
  /** `null` omits the field entirely, as in the observed `authorHandle`-only payload. */
  author?: unknown;
  authorHandle?: string;
  locale?: string;
}

export function blogEntryPayload(options: BlogEntryPayloadOptions): unknown {
  const result: Record<string, unknown> = {
    id: options.resultId ?? options.id,
    title: options.title ?? 'Codeforces Round 455 editorial',
    content: options.content ?? blogContentHtml(),
    creationTimeSeconds: options.creationTimeSeconds === undefined ? 1_700_000_000 : options.creationTimeSeconds,
  };
  if (options.titleHTML !== undefined) {
    result.titleHTML = options.titleHTML;
  }
  if (options.author !== null) {
    result.author = options.author ?? 'editorialist';
  }
  if (options.authorHandle !== undefined) {
    result.authorHandle = options.authorHandle;
  }
  if (options.locale !== undefined) {
    result.locale = options.locale;
  }
  return { status: 'OK', result };
}

export function failedBlogEntryPayload(comment: string): unknown {
  return { status: 'FAILED', comment };
}

/** A three-problem editorial with an embedded cross-reference and a paired-alias heading. */
export function blogContentHtml(): string {
  return (
    '<div class="content"><p>Editorial for the round.</p>' +
    '<h3>455A - Boredom</h3>' +
    '<p>Problem A is solved with dynamic programming over values: dp[x] = x * count[x] + dp[x + 2].</p>' +
    '<p>Recall that <a href="/contest/455/problem/B">problem B</a> uses a different idea, and this reference is embedded in explanation text.</p>' +
    '<h3>455B/456C - Paired aliases</h3>' +
    '<p>Both problems share a greedy write-up with sorting.</p>' +
    '<h3>455C - Another problem</h3>' +
    '<p>Problem C text that must not leak into other sections.</p></div>'
  );
}

/** Two headings that both name the same problem. */
export function ambiguousBlogHtml(): string {
  return (
    '<div><h3>455A - First write-up</h3><p>First write-up body.</p>' +
    '<h3>455A - Second write-up</h3><p>Second write-up body.</p></div>'
  );
}

/** Only problem B is covered. */
export function missingSectionBlogHtml(): string {
  return '<div><h3>455B - Only B</h3><p>Only problem B is written up here.</p></div>';
}
