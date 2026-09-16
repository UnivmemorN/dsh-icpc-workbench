/**
 * Shared-round editorial aliases (Sprint 33B1), over the real `CodeforcesAdapter`.
 *
 * A Div.1/Div.2 round shares one official tutorial blog, and the section a request needs may be
 * labelled only in relative form (`Div. 1 D`) or under the other division's key. The adapter may
 * follow that redirect **only** on official evidence: the same blog on both problem pages, one
 * verified Div.1/Div.2 contest pair of the same round, identical official titles, identical
 * normalized statements, and a unique re-extraction under the alias key.
 *
 * Every case here is synthetic and offline: a synthetic blog, synthetic problem pages and synthetic
 * contest metadata. The tests pin what must *not* happen as carefully as what must: no letter-offset
 * arithmetic (a fixture deliberately maps Div.2 E to Div.1 A), no acceptance of a weaker comparison
 * than exact title equality and an exact statement fingerprint, no `absent` on any failure, and no
 * attempt at all on `ambiguous` or `empty`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeforcesSourceInstance, createCodeforcesAdapter } from '../../src/adapters/codeforces/index.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformLimits } from '../../src/application/ports.js';
import { createCancellationSource } from '../../src/domain/index.js';
import { createHttpHarness, htmlResponse, jsonResponse, problemPageHtml } from './fixtures.js';

const instance = codeforcesSourceInstance();
const limits: PlatformLimits = { ...DEFAULT_PLATFORM_LIMITS, maxRetries: 0 };

function token() {
  return createCancellationSource().token;
}

function ref(externalKey: string) {
  return { sourceInstanceId: instance.id, domain: null, externalKey };
}

const BLOG_ID = 55435;
const START_SECONDS = 1_650_000_000;
const DIV1_CONTEST = 878;
const DIV2_CONTEST = 879;

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

interface ProblemFacts {
  readonly title: string;
  readonly statement?: string;
  readonly tutorialBlogId?: number | null;
}

/**
 * Official `contest.standings` metadata for one contest of the shared round.
 *
 * `result` is the API's own shape — an object with a nested `contest` plus `problems` and `rows` —
 * so the fixture exercises the same path the live endpoint does. Only the four contest fields the
 * pairing rules read are populated.
 */
function standingsPayload(options: {
  readonly contestId: number;
  readonly name: string;
  readonly startTimeSeconds?: number;
  readonly durationSeconds?: number;
}): unknown {
  return {
    status: 'OK',
    result: {
      contest: {
        id: options.contestId,
        name: options.name,
        startTimeSeconds: options.startTimeSeconds ?? START_SECONDS,
        durationSeconds: options.durationSeconds ?? 7200,
      },
      problems: [],
      rows: [],
    },
  };
}

/** A tutorial blog whose body is the given sections, with optional official contest links. */
function blogEntryPayload(options: {
  readonly sections: string;
  readonly contestIds?: readonly number[];
  readonly id?: number;
}): unknown {
  const links = (options.contestIds ?? []).map((contestId) => `<p><a href="/contest/${contestId}">contest ${contestId}</a></p>`);
  return {
    status: 'OK',
    result: {
      id: options.id ?? BLOG_ID,
      title: 'Codeforces Round editorial',
      content: `<div class="content">${links.join('')}${options.sections}</div>`,
      creationTimeSeconds: START_SECONDS,
    },
  };
}

/**
 * A full adapter over one shared round.
 *
 * `pages` maps `<contestId><index>` to the facts of that problem's page; a fact with
 * `tutorialBlogId: null` models a page that links no tutorial. Contest metadata is served for the
 * two contests of the pair unless `contests` overrides it.
 */
function sharedRound(options: {
  readonly pages: Readonly<Record<string, ProblemFacts>>;
  readonly blog: unknown;
  readonly contests?: readonly unknown[];
  readonly extraRoutes?: Readonly<Record<string, (url: URL) => Response>>;
}) {
  const routes: Record<string, (url: URL) => Response> = {
    '/api/blogEntry.view': () => jsonResponse(options.blog),
    ...options.extraRoutes,
  };
  for (const [key, facts] of Object.entries(options.pages)) {
    routes[`/problemset/problem/${key.slice(0, -1)}/${key.slice(-1)}`] = () =>
      htmlResponse(
        problemPageHtml({
          index: key.slice(-1),
          title: facts.title,
          ...(facts.statement === undefined ? {} : { statementHtml: facts.statement }),
          ...(facts.tutorialBlogId === undefined ? { tutorialBlogId: BLOG_ID } : { tutorialBlogId: facts.tutorialBlogId }),
        }),
      );
  }
  const contests =
    options.contests ??
    [
      standingsPayload({ contestId: DIV1_CONTEST, name: 'Codeforces Round 878 (Div. 1)' }),
      standingsPayload({ contestId: DIV2_CONTEST, name: 'Codeforces Round 878 (Div. 2)' }),
    ];
  // Answered by the requested contest id, exactly as the real endpoint does: a fixture that ignored
  // the query would silently make every candidate look like the same contest. An `extraRoutes` entry
  // for this path wins, so a case can model an unreadable or refused metadata answer.
  const override = options.extraRoutes?.['/api/contest.standings'];
  routes['/api/contest.standings'] =
    override ??
    ((url) => {
      const requestedId = Number(url.searchParams.get('contestId'));
      assert.equal(
        url.search,
        `?contestId=${String(requestedId)}&from=1&count=1&showUnofficial=false`,
        'contest metadata must request only the first official standings row',
      );
      const payload = contests.find((entry) => contestIdOf(entry) === requestedId);
      return payload === undefined
        ? jsonResponse({ status: 'FAILED', comment: `contest ${String(requestedId)} not found` }, 400)
        : jsonResponse(payload);
    });
  return createHttpHarness({ routes });
}

/** Contest id of one synthetic `contest.standings` payload, or `null` when it is not one. */
function contestIdOf(payload: unknown): number | null {
  const result = (payload as { readonly result?: { readonly contest?: { readonly id?: unknown } } } | null)?.result;
  const id = result?.contest?.id;
  return typeof id === 'number' ? id : null;
}

/** The statement body both divisions share, and a variant that differs in exactly one constraint. */
const SHARED_STATEMENT = 'Given n up to 100000, output the minimal number of moves.';
const SHARED_STATEMENT_OTHER = 'Given n up to 200000, output the minimal number of moves.';

/** Direct alias: the heading names both official keys, so no evidence gathering is needed. */
const DIRECT_SECTIONS = '<h3>878C / 879E - Shared problem</h3><p>The shared write-up.</p>';
/**
 * Relative alias: the shared round gives the same index to both divisions' spelling of the problem
 * (Div. 2 `E` is Div. 1 `E` *as the requested index*, and only the contest id differs), and the
 * heading names it the way the platform writes it — by division, not by absolute key.
 */
const DIVISION_SECTIONS = '<h3>Div. 1 E</h3><p>The shared write-up.</p>';

// ---------------------------------------------------------------------------------------
// A. explicit_reference: unchanged behaviour, and no extra requests
// ---------------------------------------------------------------------------------------

void test('a heading that names both official keys is accepted without any evidence request', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIRECT_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  const adapter = createCodeforcesAdapter({ transport: harness.transport });
  const result = await adapter.fetchEditorial({ problemRef: ref('879E'), token: token(), limits });

  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.match(result.solutions[0]?.text ?? '', /shared write-up/);
  // The requested problem keeps its identity: the solution id is bound to `879E`, not to `878C`.
  assert.equal(result.solutions[0]?.solutionId, `cf-blog-${BLOG_ID}-879E`);
  assert.equal(result.sources[0]?.url, `https://codeforces.com/blog/entry/${BLOG_ID}`);
  // Nothing beyond the two requests the direct path always makes.
  assert.deepEqual(
    harness.requests.map((request) => request.url.replace('https://codeforces.com', '')),
    ['/problemset/problem/879/E', `/api/blogEntry.view?blogEntryId=${BLOG_ID}`],
  );
});

void test('a heading that links both official problems is accepted the same way', async () => {
  const harness = sharedRound({
    pages: { '879E': { title: 'Shared problem' } },
    blog: blogEntryPayload({
      sections:
        '<h3><a href="/contest/878/problem/C">878C</a> / <a href="/contest/879/problem/E">879E</a></h3>' +
        '<p>The shared write-up.</p>',
      contestIds: [DIV1_CONTEST, DIV2_CONTEST],
    }),
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });
  assert.equal(result.status, 'found');
  assert.equal(harness.requests.length, 2);
});

// ---------------------------------------------------------------------------------------
// B. official_division_pair: the verified redirect
// ---------------------------------------------------------------------------------------

void test('a Div.1-only heading resolves to the verified equivalent problem of the shared round', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });

  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.match(result.solutions[0]?.text ?? '', /shared write-up/);
  // The provenance note records both identities in a fixed, machine-readable form.
  const note = result.sources[0]?.note ?? '';
  assert.match(note, /cf-editorial-alias-v1/);
  assert.match(note, /requested=879E/);
  assert.match(note, /section=878E/);
  assert.match(note, new RegExp(`blog=${BLOG_ID}`));
  assert.match(note, /method=official_division_pair/);
  // The stored identity is still the requested problem.
  assert.equal(result.solutions[0]?.solutionId, `cf-blog-${BLOG_ID}-879E`);
  assert.equal(result.sources[0]?.url, `https://codeforces.com/blog/entry/${BLOG_ID}`);
});

for (const sameSide of [
  { problemKey: '878E', division: 1 },
  { problemKey: '879E', division: 2 },
] as const) {
  void test(`a Div.${String(sameSide.division)} relative heading resolves on the requested side without refetching it`, async () => {
    const harness = sharedRound({
      pages: { [sameSide.problemKey]: { title: 'Shared problem' } },
      blog: blogEntryPayload({
        sections: `<h3>Div. ${String(sameSide.division)} E</h3><p>The same-side write-up.</p>`,
        contestIds: [DIV1_CONTEST, DIV2_CONTEST],
      }),
    });
    const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
      problemRef: ref(sameSide.problemKey),
      token: token(),
      limits,
    });
    assert.equal(result.status, 'found');
    const pagePath = `/problemset/problem/${sameSide.problemKey.slice(0, -1)}/${sameSide.problemKey.slice(-1)}`;
    assert.equal(
      harness.requests.filter((request) => request.url.endsWith(pagePath)).length,
      1,
      'the already-proven requested page must be reused',
    );
    assert.equal(
      harness.requests.filter((request) => request.url.includes('/problemset/problem/')).length,
      1,
      'same-side resolution must not fetch the other division',
    );
  });
}

void test('the redirect follows verified placement, never a fixed letter offset', async () => {
  // The shared problem sits at a different *letter* in each division: on the Div. 2 side the round
  // places it at `A` (contest 700), on the Div. 1 side at `E` (contest 701). An implementation that
  // assumed any fixed offset between Div. 2 and Div. 1 letters would look for the wrong candidate;
  // this one finds the problem by the division the *verified* contest metadata declares.
  const harness = sharedRound({
    pages: {
      '700A': { title: 'Offset-free problem' },
      '701E': { title: 'Offset-free problem' },
    },
    blog: blogEntryPayload({ sections: '<h3>Div. 1 E</h3><p>Offset-free write-up.</p>', contestIds: [700, 701] }),
    contests: [
      standingsPayload({ contestId: 700, name: 'Codeforces Round 700 (Div. 2)' }),
      standingsPayload({ contestId: 701, name: 'Codeforces Round 700 (Div. 1)' }),
    ],
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('700A'),
    token: token(),
    limits,
  });
  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.match(result.sources[0]?.note ?? '', /section=701E/);
  assert.equal(result.solutions[0]?.solutionId, `cf-blog-${BLOG_ID}-700A`);
});

void test('one unique requested pair is accepted when all three referenced contests are readable', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, 880, DIV2_CONTEST] }),
    contests: [
      standingsPayload({ contestId: DIV1_CONTEST, name: 'Codeforces Round 878 (Div. 1)' }),
      standingsPayload({ contestId: 880, name: 'Educational Codeforces Round 50' }),
      standingsPayload({ contestId: DIV2_CONTEST, name: 'Codeforces Round 878 (Div. 2)' }),
    ],
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });
  assert.equal(result.status, 'found');
  assert.equal(
    harness.requests.filter((request) => request.url.includes('/api/contest.standings')).length,
    3,
  );
});

void test('one unique requested pair is accepted when all four referenced contests are readable', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({
      sections: DIVISION_SECTIONS,
      contestIds: [880, DIV1_CONTEST, 881, DIV2_CONTEST],
    }),
    contests: [
      standingsPayload({ contestId: 880, name: 'Educational Codeforces Round 50' }),
      standingsPayload({ contestId: DIV1_CONTEST, name: 'Codeforces Round 878 (Div. 1)' }),
      standingsPayload({ contestId: 881, name: 'Codeforces Global Round 25', startTimeSeconds: START_SECONDS + 1 }),
      standingsPayload({ contestId: DIV2_CONTEST, name: 'Codeforces Round 878 (Div. 2)' }),
    ],
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });
  assert.equal(result.status, 'found');
  assert.equal(
    harness.requests.filter((request) => request.url.includes('/api/contest.standings')).length,
    4,
  );
});

void test('an explicit tutorial URL still proves the blog link before any alias is tried', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
    officialTutorialUrl: `https://codeforces.com/blog/entry/${BLOG_ID}`,
  });
  assert.equal(result.status, 'found');
  if (result.status !== 'found') {
    return;
  }
  assert.match(result.sources[0]?.note ?? '', /method=official_division_pair/);
  // The requested page was never fetched for discovery (the caller supplied the blog), so the alias
  // check fetched it — and it had to link this very blog before anything else was consulted.
  assert.equal(
    harness.requests.some((request) => request.url === 'https://codeforces.com/problemset/problem/879/E'),
    true,
  );
  const pageIndex = harness.requests.findIndex((request) => request.url.endsWith('/problemset/problem/879/E'));
  const candidateIndex = harness.requests.findIndex((request) => request.url.endsWith('/problemset/problem/878/E'));
  assert.equal(pageIndex < candidateIndex, true, 'the requested page must be proven before a candidate');
});

void test('a later matching relative heading is considered after an earlier non-target heading', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878F': { title: 'Different problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({
      sections:
        '<h3>Div. 1 F</h3><p>Another write-up.</p>' +
        '<h3>Div. 1 E</h3><p>The requested shared write-up.</p>',
      contestIds: [DIV1_CONTEST, DIV2_CONTEST],
    }),
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });
  assert.equal(result.status, 'found');
  if (result.status === 'found') {
    assert.match(result.solutions[0]?.text ?? '', /requested shared write-up/);
    assert.match(result.sources[0]?.note ?? '', /section=878E/);
  }
});

void test('three unique relative references are refused before any candidate page is fetched', async () => {
  const harness = sharedRound({
    pages: { '879E': { title: 'Shared problem' } },
    blog: blogEntryPayload({
      sections:
        '<h3>Div. 1 C</h3><p>C.</p>' +
        '<h3>Div. 1 D</h3><p>D.</p>' +
        '<h3>Div. 1 E</h3><p>E.</p>',
      contestIds: [DIV1_CONTEST, DIV2_CONTEST],
    }),
  });
  await expectRefused(harness);
  assert.equal(
    harness.requests.some((request) => request.url.includes('/problemset/problem/878/')),
    false,
    'candidate-count refusal must happen before candidate I/O',
  );
});

// ---------------------------------------------------------------------------------------
// C. Every refusal: never `absent`, never a wrong section
// ---------------------------------------------------------------------------------------

/** Accepted refusals: a shared-round alias may fail as `changed_response` or `unavailable` only. */
async function expectRefused(
  harness: ReturnType<typeof sharedRound>,
  problemKey = '879E',
  options: { readonly officialTutorialUrl?: string } = {},
): Promise<void> {
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref(problemKey),
    token: token(),
    limits,
    ...options,
  });
  assert.notEqual(result.status, 'absent', 'a missing alias must never be reported as an absence');
  assert.equal(result.status === 'found', false, 'no section may be adopted when the evidence is short');
}

void test('identical titles are not enough when the statements differ', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem', statement: SHARED_STATEMENT },
      '878E': { title: 'Shared problem', statement: SHARED_STATEMENT_OTHER },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a one-word constraint change is enough to refuse the redirect', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem', statement: SHARED_STATEMENT },
      '878E': { title: 'Shared problem', statement: SHARED_STATEMENT.replace('100000', '100001') },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a differing sample refuses the redirect', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem', statement: `${SHARED_STATEMENT}<p>Sample: 3</p>` },
      '878E': { title: 'Shared problem', statement: `${SHARED_STATEMENT}<p>Sample: 4</p>` },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a differing official title refuses the redirect', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem (hard version)' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a title that differs only in case is not a match', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared Problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a candidate page that links a different blog refuses the redirect', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem', tutorialBlogId: 999 },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a requested page that does not link the blog refuses the redirect', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem', tutorialBlogId: 777 },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness, '879E', { officialTutorialUrl: `https://codeforces.com/blog/entry/${BLOG_ID}` });
});

void test('contests of the same round but different start times refuse the redirect', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
    contests: [
      standingsPayload({ contestId: DIV1_CONTEST, name: 'Codeforces Round 878 (Div. 1)' }),
      standingsPayload({ contestId: DIV2_CONTEST, name: 'Codeforces Round 878 (Div. 2)', startTimeSeconds: START_SECONDS + 60 }),
    ],
  });
  await expectRefused(harness);
});

void test('contests of the same round but different durations refuse the redirect', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
    contests: [
      standingsPayload({ contestId: DIV1_CONTEST, name: 'Codeforces Round 878 (Div. 1)' }),
      standingsPayload({ contestId: DIV2_CONTEST, name: 'Codeforces Round 878 (Div. 2)', durationSeconds: 9000 }),
    ],
  });
  await expectRefused(harness);
});

void test('contests of different core names refuse the redirect', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
    contests: [
      standingsPayload({ contestId: DIV1_CONTEST, name: 'Codeforces Round 878 (Div. 1)' }),
      standingsPayload({ contestId: DIV2_CONTEST, name: 'Codeforces Round 999 (Div. 2)' }),
    ],
  });
  await expectRefused(harness);
});

void test('two complete Div.1/Div.2 pairs are ambiguous and are refused', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({
      sections: DIVISION_SECTIONS,
      contestIds: [DIV1_CONTEST, DIV2_CONTEST, 880, 881],
    }),
    contests: [
      standingsPayload({ contestId: DIV1_CONTEST, name: 'Codeforces Round 878 (Div. 1)' }),
      standingsPayload({ contestId: DIV2_CONTEST, name: 'Codeforces Round 878 (Div. 2)' }),
      standingsPayload({
        contestId: 880,
        name: 'Codeforces Round 880 (Div. 1)',
        startTimeSeconds: START_SECONDS + 10_000,
      }),
      standingsPayload({
        contestId: 881,
        name: 'Codeforces Round 880 (Div. 2)',
        startTimeSeconds: START_SECONDS + 10_000,
      }),
    ],
  });
  await expectRefused(harness);
  assert.equal(
    harness.requests.filter((request) => request.url.includes('/api/contest.standings')).length,
    4,
  );
});

void test('a unique pair that does not contain the requested contest is refused', async () => {
  const harness = sharedRound({
    pages: { '879E': { title: 'Shared problem' } },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV2_CONTEST, 880, 881] }),
    contests: [
      standingsPayload({ contestId: DIV2_CONTEST, name: 'Codeforces Round 879 (Div. 3)' }),
      standingsPayload({ contestId: 880, name: 'Codeforces Round 880 (Div. 1)' }),
      standingsPayload({ contestId: 881, name: 'Codeforces Round 880 (Div. 2)' }),
    ],
  });
  await expectRefused(harness);
  assert.equal(
    harness.requests.filter((request) => request.url.includes('/api/contest.standings')).length,
    3,
  );
});

void test('a blog that names more contests than the bound cannot form a unique pair', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({
      sections: DIVISION_SECTIONS,
      contestIds: [DIV1_CONTEST, DIV2_CONTEST, 880, 881],
    }),
  });
  await expectRefused(harness);
});

void test('a foreign link in the blog is never an identity source', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({
      sections: `<h3>Div. 1 C</h3><p><a href="https://evil.example/contest/878/problem/C">C</a> write-up.</p>`,
      contestIds: [],
    }),
    extraRoutes: {},
  });
  await expectRefused(harness);
});

void test('two headings that both select the alias are ambiguous and are refused', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({
      sections: '<h3>Div. 1 C</h3><p>First.</p><h3>Div. 1 C</h3><p>Second.</p>',
      contestIds: [DIV1_CONTEST, DIV2_CONTEST],
    }),
  });
  await expectRefused(harness);
});

void test('an empty alias section is refused and never reaches the alias path', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: '<h3>Div. 1 C</h3>', contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a section that names neither problem leaves the request unresolved', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: '<h3>879F - Some other problem</h3><p>Other write-up.</p>', contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a division heading with no problem index never selects a section', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: '<h3>Div. 1</h3><p>Body without an index.</p>', contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await expectRefused(harness);
});

void test('a prose heading that merely mentions a division does not select a section', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({
      sections: '<h3>Notes on Div. 1 C and other things</h3><p>Prose, not a section label.</p>',
      contestIds: [DIV1_CONTEST, DIV2_CONTEST],
    }),
  });
  await expectRefused(harness);
});

void test('a problem page without a Tutorial link stays unavailable, never absent', async () => {
  const harness = sharedRound({
    pages: { '879E': { title: 'Shared problem', tutorialBlogId: null } },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });
  assert.equal(result.status, 'unavailable');
  assert.notEqual(result.status, 'absent');
  if (result.status === 'unavailable') {
    assert.match(result.detail, /discovery is incomplete/);
  }
});

void test('contest metadata that cannot be read makes the alias unverifiable, not accepted', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
    extraRoutes: {
      '/api/contest.standings': () => jsonResponse({ status: 'FAILED', comment: 'contest not found' }, 400),
    },
  });
  await expectRefused(harness);
});

void test('a rate-limited contest metadata request keeps its operational result', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
    extraRoutes: {
      '/api/contest.standings': () =>
        new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
    },
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });
  assert.equal(result.status, 'rate_limited');
  if (result.status === 'rate_limited') {
    assert.equal(result.retryAfterMs, 3000);
  }
});

void test('a candidate-page server failure stays unavailable', async () => {
  const harness = sharedRound({
    pages: { '879E': { title: 'Shared problem' } },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
    extraRoutes: {
      '/problemset/problem/878/E': () => new Response('server outage', { status: 503 }),
    },
  });
  const result = await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') {
    assert.equal(result.retryable, true);
  }
});

void test('cancellation during contest metadata lookup propagates as cancellation', async () => {
  const source = createCancellationSource();
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
    extraRoutes: {
      '/api/contest.standings': () => {
        source.cancel('alias lookup cancelled');
        return jsonResponse(standingsPayload({ contestId: DIV1_CONTEST, name: 'Codeforces Round 878 (Div. 1)' }));
      },
    },
  });
  await assert.rejects(
    () =>
      createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
        problemRef: ref('879E'),
        token: source.token,
        limits,
      }),
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'cancelled',
  );
});

void test('a non-object contest.standings result is conservatively refused', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
    extraRoutes: {
      '/api/contest.standings': (url) => {
        assert.equal(
          url.search,
          `?contestId=${url.searchParams.get('contestId') ?? ''}&from=1&count=1&showUnofficial=false`,
        );
        return jsonResponse({
          status: 'OK',
          result: [
            {
              contest: {
                id: Number(url.searchParams.get('contestId')),
                name: 'Codeforces Round 878 (Div. 1)',
                startTimeSeconds: START_SECONDS,
                durationSeconds: 7200,
              },
            },
          ],
        });
      },
    },
  });
  await expectRefused(harness);
});

// ---------------------------------------------------------------------------------------
// D. Existing behaviour that must not regress
// ---------------------------------------------------------------------------------------

void test('ambiguous and empty sections are still reported directly, without the alias path', async () => {
  const ambiguousHarness = createHttpHarness({
    routes: {
      '/problemset/problem/455/A': () => htmlResponse(problemPageHtml({ index: 'A', title: 'Boredom', tutorialBlogId: 9006 })),
      '/api/blogEntry.view': () =>
        jsonResponse(
          blogEntryPayload({
            id: 9006,
            sections: '<h3>455A - First</h3><p>One.</p><h3>455A - Second</h3><p>Two.</p>',
          }),
        ),
    },
  });
  const ambiguous = await createCodeforcesAdapter({ transport: ambiguousHarness.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
  });
  assert.equal(ambiguous.status, 'changed_response');
  // `ambiguous` must not trigger any alias request: the only two reads are the page and the blog.
  assert.equal(ambiguousHarness.requests.length, 2);

  const emptyHarness = createHttpHarness({
    routes: {
      '/problemset/problem/455/A': () => htmlResponse(problemPageHtml({ index: 'A', title: 'Boredom', tutorialBlogId: 9006 })),
      '/api/blogEntry.view': () => jsonResponse(blogEntryPayload({ id: 9006, sections: '<h3>455A - Empty</h3>' })),
    },
  });
  const empty = await createCodeforcesAdapter({ transport: emptyHarness.transport }).fetchEditorial({
    problemRef: ref('455A'),
    token: token(),
    limits,
  });
  assert.equal(empty.status, 'changed_response');
  assert.equal(emptyHarness.requests.length, 2);
});

void test('the requested page is fetched once and cached for the alias check', async () => {
  const harness = sharedRound({
    pages: {
      '879E': { title: 'Shared problem' },
      '878E': { title: 'Shared problem' },
    },
    blog: blogEntryPayload({ sections: DIVISION_SECTIONS, contestIds: [DIV1_CONTEST, DIV2_CONTEST] }),
  });
  await createCodeforcesAdapter({ transport: harness.transport }).fetchEditorial({
    problemRef: ref('879E'),
    token: token(),
    limits,
  });
  const urls = harness.requests.map((request) => request.url);
  assert.equal(urls.filter((url) => url.includes('/problemset/problem/879/E')).length, 1);
  assert.equal(urls.filter((url) => url.includes('/problemset/problem/878/E')).length, 1);
  // The whole attempt stays inside the fixed budget: the requested page, the blog, the candidate page
  // and one contest-metadata read per contest of the pair.
  assert.equal(urls.length <= 5, true, `expected at most 5 requests, saw ${String(urls.length)}`);
  // The requested page is read once: the alias check reuses the page discovery already fetched.
  assert.equal(urls.filter((url) => url.includes('/problemset/problem/879/E')).length, 1);
});
