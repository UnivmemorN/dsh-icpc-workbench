/**
 * Luogu authenticated editorial payloads (Sprint 33C), over the observed sanitized schema.
 *
 * Every fixture here is **synthetic**: it reproduces the *field names, types and optionality* recorded
 * in `.local/observations/luogu-editorial-shape.v1.json` and nothing else. No captured value, cookie,
 * viewer identity, author value, problem title, solution body or error message is copied or
 * reconstructed — the identifiers and bodies below are invented placeholders, which is also why they
 * are safe to keep in the repository.
 *
 * The cases pin the capture's own implementation constraints, above all the one that matters most:
 * **only `count === 0` together with `result: []` from a recognized successful payload may become
 * `absent`.** Everything else that cannot be read is a failure kind, and no failure path may leak a
 * value into its message.
 *
 * The revision added the *paged* reader, so this file also pins the single-page consequences of that
 * change: a page must be a recognized success envelope (`status === 200`, a `data.problem` object whose
 * `pid` is the requested one, a bounded `count`, a bounded positive `perPage`), a page's declared
 * `count` is the *total* and not its own length, and one stored `EditorialSource` is created **per
 * write-up** — with that write-up's title, its public author name and its own `lid`-bearing identity —
 * while the retrieved body exists exactly once, in the paired `EditorialSolution.text`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LENTILLE_CONTEXT_ELEMENT_ID,
  MAX_EDITORIAL_WRITE_UPS,
  lentilleContextPayload,
  parseLuoguEditorialPage,
  parseLuoguEditorialPayload,
  type LuoguEditorialParseResult,
} from '../../src/adapters/luogu/editorial-parser.js';

const PID = 'P1001';
const AT = '2026-09-15T00:00:00.000Z';
/** A value that must never travel out of a failure of any kind. */
const LID_SENTINEL = 'LID_SECRET_SENTINEL';

// ---------------------------------------------------------------------------------------
// Sanitized-shape fixtures (types and structure only; every value is a placeholder)
// ---------------------------------------------------------------------------------------

/** One `data.solutions.result[]` entry in the observed shape. */
function solutionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lid: 'lid-1',
    title: 'PLACEHOLDER_TITLE',
    category: 1,
    time: 1_700_000_000,
    author: author(),
    upvote: 3,
    replyCount: 0,
    favorCount: 1,
    status: 2,
    solutionFor: problemSummary(),
    promoteStatus: 0,
    collection: null,
    content: 'PLACEHOLDER_BODY',
    contentFull: true,
    adminNote: null,
    voted: null,
    canReply: false,
    canEdit: false,
    ...overrides,
  };
}

/** The observed `author` object; `badge` is `string|null` and `isRoot` is optional. */
function author(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: 1,
    avatar: 'https://example.invalid/avatar.png',
    name: 'PLACEHOLDER_AUTHOR',
    slogan: '',
    badge: null,
    isAdmin: false,
    isBanned: false,
    color: 'Gray',
    ccfLevel: 0,
    xcpcLevel: 0,
    background: '',
    ...overrides,
  };
}

function problemSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: PID,
    type: 'P',
    name: 'PLACEHOLDER_PROBLEM_NAME',
    difficulty: 1,
    fullScore: 100,
    submitted: false,
    accepted: false,
    ...overrides,
  };
}

/** One positive payload with the observed top-level envelope. */
function positivePayload(
  result: readonly unknown[],
  options: { readonly count?: number; readonly viewer?: unknown } = {},
): Record<string, unknown> {
  return {
    instance: 'PLACEHOLDER',
    template: 'PLACEHOLDER',
    status: 200,
    locale: 'zh-CN',
    data: {
      solutions: {
        perPage: 10,
        count: options.count ?? result.length,
        result,
      },
      problem: problemSummary(),
      acceptSolution: false,
    },
    user: options.viewer === undefined ? { uid: 1, name: 'PLACEHOLDER_VIEWER' } : options.viewer,
    time: 1_700_000_000,
  };
}

/**
 * One page of a paginated answer, exactly as the capture recorded it.
 *
 * `count` is the *total* number of write-ups for the problem; a page carries the slice its own number
 * addresses. This is the fixture the paged reader is driven with, and the single-page wrapper is
 * deliberately *not* given it: that wrapper keeps its own whole-payload meaning (`count` equals the
 * length of `result`).
 */
function pagePayload(options: {
  readonly result: readonly unknown[];
  readonly count: number;
  readonly perPage?: number;
  readonly problem?: unknown;
  readonly status?: unknown;
  /** Omits the whole `status` member, which is different from carrying an unusable one. */
  readonly withoutStatus?: boolean;
  /** Omits the whole `problem` member, which is different from carrying an unusable one. */
  readonly withoutProblem?: boolean;
}): Record<string, unknown> {
  return {
    instance: 'PLACEHOLDER',
    template: 'PLACEHOLDER',
    ...(options.withoutStatus === true ? {} : { status: options.status === undefined ? 200 : options.status }),
    locale: 'zh-CN',
    data: {
      solutions: { perPage: options.perPage ?? 10, count: options.count, result: options.result },
      ...(options.withoutProblem === true ? {} : { problem: options.problem === undefined ? problemSummary() : options.problem }),
      acceptSolution: false,
    },
    user: { uid: 1, name: 'PLACEHOLDER_VIEWER' },
    time: 1_700_000_000,
  };
}

/** One error payload in the observed shape. */
function errorPayload(errorCode: number, status: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance: 'PLACEHOLDER',
    template: 'PLACEHOLDER',
    status,
    locale: 'zh-CN',
    data: {
      errorCode,
      errorType: 'PLACEHOLDER_ERROR_TYPE',
      errorMessage: 'PLACEHOLDER_ERROR_MESSAGE',
      errorData: { needLogin: errorCode === 401 ? 1 : 0 },
      ...extra,
    },
    user: null,
    time: 1_700_000_000,
  };
}

/** One authenticated solution page whose hydration element carries `payload`. */
function solutionPage(payload: unknown): string {
  return (
    '<!doctype html><html><head><title>PLACEHOLDER</title></head><body>' +
    '<div id="app"></div>' +
    `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">${JSON.stringify(payload)}</script>` +
    '</body></html>'
  );
}

function expectFailure(result: LuoguEditorialParseResult): Extract<LuoguEditorialParseResult, { ok: false }> {
  if (result.ok) {
    assert.fail(`expected an unreadable payload, got ${result.status}`);
  }
  return result;
}

function expectFound(
  result: LuoguEditorialParseResult,
): Extract<LuoguEditorialParseResult, { ok: true; status: 'found' }> {
  if (!result.ok || result.status !== 'found') {
    assert.fail(`expected found material, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** Read one page fixture through the paged API, failing the test if it is unreadable. */
function expectPage(payload: unknown, pid = PID): Extract<ReturnType<typeof parseLuoguEditorialPage>, { status: 'page' }> {
  const result = parseLuoguEditorialPage(payload, pid);
  if (!result.ok || result.status !== 'page') {
    assert.fail(`expected a readable page, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** Assert one page fixture is the named closed failure kind. */
function assertPageFailure(label: string, payload: unknown, kind: string): void {
  const result = parseLuoguEditorialPage(payload, PID);
  if (result.ok) {
    assert.fail(`${label}: expected an unreadable page, got ${result.status}`);
  }
  assert.equal(result.kind, kind, label);
}

// ---------------------------------------------------------------------------------------
// Positive payloads and the stored identity
// ---------------------------------------------------------------------------------------

void test('a single-write-up payload becomes one source and one write-up', () => {
  const result = expectFound(parseLuoguEditorialPayload(positivePayload([solutionItem()]), PID, AT));
  assert.equal(result.sources.length, 1);
  assert.equal(result.solutions.length, 1);
  const source = result.sources[0];
  const solution = result.solutions[0];
  assert.ok(source && solution);
  // The source is this one write-up: the problem's own solution list, addressed by pid and by the
  // write-up's own observed string id, carrying that write-up's title and its public author name.
  assert.equal(source.kind, 'solution');
  assert.equal(source.availability, 'found');
  assert.equal(source.url, `https://www.luogu.com.cn/problem/solution/${PID}`);
  assert.equal(source.retrievedAt, AT);
  assert.equal(source.title, 'PLACEHOLDER_TITLE');
  assert.equal(source.author, 'PLACEHOLDER_AUTHOR');
  // The capture did not verify a `time` unit or a language field, so neither is claimed.
  assert.equal(source.publishedAt, null);
  assert.equal(source.language, null);
  assert.match(source.id, /^luogu-solution-P1001-lid-1$/u);
  assert.equal(solution.sourceId, source.id);
  assert.equal(solution.text, 'PLACEHOLDER_BODY');
  assert.equal(solution.title, 'PLACEHOLDER_TITLE');
  assert.equal(solution.language, null);
  assert.equal(solution.ordinal, 0);
  // The write-up is addressed by its own observed string id, so two problems can never share it.
  assert.match(solution.solutionId, /lid-1$/);
  // Content hashes are derived by the domain factory, never trusted from a payload.
  assert.match(solution.contentHash, /^[0-9a-f]{64}$/u);
  // The note describes the observation by structure and numbers only — no name, title or body.
  const note = source.note ?? '';
  assert.match(note, /authenticated Luogu write-up/);
  assert.match(note, /author attributed/);
  assert.match(note, /time member 1700000000 \(unit unverified\)/);
  assert.equal(note.includes('PLACEHOLDER_AUTHOR'), false);
  assert.equal(note.includes('PLACEHOLDER_TITLE'), false);
  assert.equal(note.includes('PLACEHOLDER_BODY'), false);
  assert.equal(note.includes('PLACEHOLDER_PROBLEM_NAME'), false);
  // The retrieved body lives in exactly one place: the paired solution. The source carries the
  // write-up's *identity* (its id, title and public author), which is what a `found` source has to
  // report, and its digest therefore depends on that identity rather than on the body.
  assert.match(source.contentHash ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(source).includes('PLACEHOLDER_BODY'), false);
  const otherBody = expectFound(
    parseLuoguEditorialPayload(positivePayload([solutionItem({ content: 'OTHER_BODY' })]), PID, AT),
  ).sources[0]?.contentHash;
  assert.equal(otherBody, source.contentHash, 'the source identity must not depend on the body');
  const otherLid = expectFound(
    parseLuoguEditorialPayload(positivePayload([solutionItem({ lid: 'lid-2' })]), PID, AT),
  ).sources[0]?.contentHash;
  assert.notEqual(otherLid, source.contentHash, 'a different write-up id must hash differently');
  const otherAuthor = expectFound(
    parseLuoguEditorialPayload(
      positivePayload([solutionItem({ author: author({ name: 'PLACEHOLDER_AUTHOR_2' }) })]),
      PID,
      AT,
    ),
  ).sources[0];
  assert.equal(otherAuthor?.author, 'PLACEHOLDER_AUTHOR_2');
  assert.notEqual(otherAuthor?.contentHash, source.contentHash, 'the attributed author is part of the identity');
});

void test('every write-up of a payload becomes its own attributed source, in platform order', () => {
  const items = [solutionItem({ lid: 'lid-a' }), solutionItem({ lid: 'lid-b' }), solutionItem({ lid: 'lid-c' })];
  const result = expectFound(parseLuoguEditorialPayload(positivePayload(items, { count: 3 }), PID, AT));
  assert.equal(result.sources.length, 3);
  assert.equal(result.solutions.length, 3);
  assert.deepEqual(
    result.solutions.map((solution) => solution.ordinal),
    [0, 1, 2],
  );
  assert.deepEqual(
    result.solutions.map((solution) => solution.solutionId.replace(/^.*lid-/u, 'lid-')),
    ['lid-a', 'lid-b', 'lid-c'],
  );
  // Every write-up is paired with exactly one source of its own, and that source is the one the
  // write-up references.
  for (const [index, solution] of result.solutions.entries()) {
    assert.equal(solution.sourceId, result.sources[index]?.id);
    assert.match(result.sources[index]?.id ?? '', new RegExp(`lid-${String.fromCharCode(97 + index)}$`, 'u'));
  }
});

void test('a body-level 429 is a rate limit, not a plain refusal', () => {
  // Lentille declares some failures in an HTTP 200 envelope; a declared rate limit keeps its own
  // meaning there instead of being folded into a refusal.
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(429, 429), PID, AT)).kind, 'rate_limited');
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(429, 200), PID, AT)).kind, 'rate_limited');
  assert.equal(
    expectFailure(parseLuoguEditorialPayload({ status: 200, data: { errorCode: 429 } }, PID, AT)).kind,
    'rate_limited',
  );
  // `404`, `401` and a refusal keep their own kinds.
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(404, 200), PID, AT)).kind, 'not_found');
  assert.equal(
    expectFailure(parseLuoguEditorialPayload(errorPayload(401, 200), PID, AT)).kind,
    'authentication_required',
  );
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(403, 200), PID, AT)).kind, 'refused');
  // None of them can become an absence.
  for (const payload of [errorPayload(429, 200), errorPayload(404, 200), errorPayload(401, 200)]) {
    const failure = expectFailure(parseLuoguEditorialPayload(payload, PID, AT));
    assert.notEqual(failure.kind, 'not_an_object');
    assert.equal(failure.path.includes('PLACEHOLDER'), false);
  }
});

void test('a body-level 5xx is a server outage, never a permission problem', () => {
  // A declared server failure must keep the meaning the same status has as a real HTTP answer: an
  // outage (`unavailable`), not `forbidden`.
  for (const code of [500, 502, 503, 504]) {
    assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(code, 200), PID, AT)).kind, 'server_error', String(code));
    assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(code, code), PID, AT)).kind, 'server_error', String(code));
  }
  // The envelope `status` alone can identify it too, when `errorCode` is unreadable.
  assert.equal(
    expectFailure(parseLuoguEditorialPayload({ status: 500, data: { errorType: 'x' } }, PID, AT)).kind,
    'server_error',
  );
  // A genuine refusal is still a refusal.
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(403, 200), PID, AT)).kind, 'refused');
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(418, 200), PID, AT)).kind, 'refused');
});

void test('the hydration element must declare the observed type and is read as raw text', () => {
  // The capture recorded `type="application/json"`: a same-id script of another type is not the
  // payload this build was written against.
  const payload = { status: 200, data: { solutions: { count: 0, result: [], perPage: 10 } } };
  const json = JSON.stringify(payload);
  const cases: readonly { readonly label: string; readonly html: string; readonly expected: unknown }[] = [
    {
      label: 'double-quoted type',
      html: `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">${json}</script>`,
      expected: payload,
    },
    {
      label: 'single-quoted type',
      html: `<script id='${LENTILLE_CONTEXT_ELEMENT_ID}' type='application/json'>${json}</script>`,
      expected: payload,
    },
    {
      label: 'type after other attributes',
      html: `<script nonce="x" type="application/json" id="${LENTILLE_CONTEXT_ELEMENT_ID}">${json}</script>`,
      expected: payload,
    },
    {
      label: 'type differing only in case and padding',
      html: `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type=" Application/JSON ">${json}</script>`,
      expected: payload,
    },
    {
      label: 'type missing',
      html: `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}">${json}</script>`,
      expected: null,
    },
    {
      label: 'type is javascript',
      html: `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="text/javascript">${json}</script>`,
      expected: null,
    },
    {
      label: 'type is json but not application/json',
      html: `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/ld+json">${json}</script>`,
      expected: null,
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(lentilleContextPayload(entry.html), entry.expected, entry.label);
  }

  // A script body is raw text: HTML entities in it are literal characters of the JSON string, so
  // decoding them would silently rewrite the write-up it describes.
  const literal = { status: 200, data: { solutions: { count: 1, result: [{ content: 'a &amp;&amp; b &lt;x&gt; &quot;q&quot;' }] } } };
  const literalHtml = `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">${JSON.stringify(literal)}</script>`;
  const extracted = lentilleContextPayload(literalHtml);
  assert.deepEqual(extracted, literal);
  assert.equal(
    (extracted as typeof literal).data.solutions.result[0]?.content,
    'a &amp;&amp; b &lt;x&gt; &quot;q&quot;',
    'the raw text must not be entity-decoded',
  );
  // A numeric entity is literal text too.
  const numeric = `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">{"a":"&#34;x&#34;"}</script>`;
  assert.deepEqual(lentilleContextPayload(numeric), { a: '&#34;x&#34;' });
});

void test('a data-* attribute cannot impersonate the hydration id or type', () => {
  // An attribute name must begin at the start of the attribute text or after whitespace, so
  // `data-id`/`data-type` are not `id`/`type`: reading them would let unrelated markup stand in for the
  // observed hydration element.
  const payload = { status: 200, data: { solutions: { count: 0, result: [], perPage: 10 } } };
  const json = JSON.stringify(payload);
  const impostors: readonly { readonly label: string; readonly html: string }[] = [
    {
      label: 'both data- attributes',
      html: `<script data-id="${LENTILLE_CONTEXT_ELEMENT_ID}" data-type="application/json">${json}</script>`,
    },
    {
      label: 'data-id only, real type',
      html: `<script data-id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">${json}</script>`,
    },
    {
      label: 'real id, data-type only',
      html: `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" data-type="application/json">${json}</script>`,
    },
    {
      label: 'single-quoted data- attributes',
      html: `<script data-id='${LENTILLE_CONTEXT_ELEMENT_ID}' data-type='application/json'>${json}</script>`,
    },
    {
      label: 'aria-id and data-type',
      html: `<script aria-id="${LENTILLE_CONTEXT_ELEMENT_ID}" data-type="application/json">${json}</script>`,
    },
    {
      label: 'data-id before a real id of another element',
      html: `<script data-id="${LENTILLE_CONTEXT_ELEMENT_ID}" data-type="application/json"></script><script id="other" type="application/json">${json}</script>`,
    },
  ];
  for (const entry of impostors) {
    assert.equal(lentilleContextPayload(entry.html), null, entry.label);
  }
  // The real attributes still work, in either quote style and in any order.
  const accepted: readonly string[] = [
    `<script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">${json}</script>`,
    `<script type="application/json" id="${LENTILLE_CONTEXT_ELEMENT_ID}">${json}</script>`,
    `<script id='${LENTILLE_CONTEXT_ELEMENT_ID}' type='application/json'>${json}</script>`,
    `<script nonce="x" ID="${LENTILLE_CONTEXT_ELEMENT_ID}" TYPE="application/json">${json}</script>`,
    // A data- attribute next to the real one must not disturb it.
    `<script data-id="decoy" id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">${json}</script>`,
  ];
  for (const html of accepted) {
    assert.deepEqual(lentilleContextPayload(html), payload, html);
  }
});

void test('the recorded optional variations are accepted', () => {
  // `categoryOld` present as a string; `author.isRoot` present; `badge` a string.
  const variant = solutionItem({
    categoryOld: 'PLACEHOLDER_CATEGORY_OLD',
    author: author({ isRoot: false, badge: 'PLACEHOLDER_BADGE' }),
  });
  const result = expectFound(parseLuoguEditorialPayload(positivePayload([variant]), PID, AT));
  assert.equal(result.solutions.length, 1);

  // The same payload without any of them, and with `badge: null`, is equally valid: the capture
  // recorded exactly those variations, and nothing here reads the members that vary.
  const minimal = solutionItem({ author: author({ badge: null }) });
  assert.equal(expectFound(parseLuoguEditorialPayload(positivePayload([minimal]), PID, AT)).solutions.length, 1);
  const withoutOptional = solutionItem();
  delete (withoutOptional.author as Record<string, unknown>).isRoot;
  delete withoutOptional.categoryOld;
  assert.equal(
    expectFound(parseLuoguEditorialPayload(positivePayload([withoutOptional]), PID, AT)).solutions.length,
    1,
  );
});

void test('a write-up whose stored provenance cannot be read is refused whole', () => {
  // Every member this build stores is required by the observed shape. A missing or wrongly typed one is
  // an unreadable item — never a successful write-up with a fabricated `null` author, an empty title or
  // a zeroed counter, because that would misstate the attribution the product keeps.
  const unreadable: readonly { readonly label: string; readonly item: Record<string, unknown>; readonly kind: string }[] = [
    { label: 'author missing', item: solutionItem({ author: undefined }), kind: 'item_unreadable' },
    { label: 'author null', item: solutionItem({ author: null }), kind: 'item_unreadable' },
    { label: 'author a string', item: solutionItem({ author: 'PLACEHOLDER_AUTHOR' }), kind: 'item_unreadable' },
    { label: 'author.name missing', item: solutionItem({ author: author({ name: undefined }) }), kind: 'item_unreadable' },
    { label: 'author.name blank', item: solutionItem({ author: author({ name: '   ' }) }), kind: 'item_unreadable' },
    { label: 'author.name a number', item: solutionItem({ author: author({ name: 7 }) }), kind: 'item_unreadable' },
    { label: 'title empty', item: solutionItem({ title: '' }), kind: 'item_unreadable' },
    { label: 'title blank', item: solutionItem({ title: '   ' }), kind: 'item_unreadable' },
    { label: 'category missing', item: solutionItem({ category: undefined }), kind: 'item_unreadable' },
    { label: 'category a string', item: solutionItem({ category: '1' }), kind: 'item_unreadable' },
    { label: 'status missing', item: solutionItem({ status: undefined }), kind: 'item_unreadable' },
    { label: 'status a fraction', item: solutionItem({ status: 1.5 }), kind: 'item_unreadable' },
    { label: 'time missing', item: solutionItem({ time: undefined }), kind: 'item_unreadable' },
    { label: 'time null', item: solutionItem({ time: null }), kind: 'item_unreadable' },
    { label: 'upvote missing', item: solutionItem({ upvote: undefined }), kind: 'item_unreadable' },
    { label: 'upvote an unsafe integer', item: solutionItem({ upvote: Number.MAX_VALUE }), kind: 'item_unreadable' },
    { label: 'replyCount missing', item: solutionItem({ replyCount: undefined }), kind: 'item_unreadable' },
    { label: 'replyCount a string', item: solutionItem({ replyCount: '0' }), kind: 'item_unreadable' },
    { label: 'favorCount missing', item: solutionItem({ favorCount: undefined }), kind: 'item_unreadable' },
    { label: 'favorCount null', item: solutionItem({ favorCount: null }), kind: 'item_unreadable' },
  ];
  for (const entry of unreadable) {
    const failure = expectFailure(parseLuoguEditorialPayload(positivePayload([solutionItem(), entry.item]), PID, AT));
    assert.equal(failure.kind, entry.kind, entry.label);
    // The path names the member that failed and never its value.
    assert.equal(failure.path.includes('PLACEHOLDER'), false, entry.label);
    assert.equal(failure.path.startsWith('data.solutions.result[1].'), true, `${entry.label}: ${failure.path}`);
  }
});

void test('a write-up id is stored in one canonical Unicode form', () => {
  // `é` as one code point and as `e` + U+0301 are different JavaScript strings but the same text. Only
  // the canonical (NFC) spelling may reach a stored id, or one write-up could exist twice.
  const precomposed = solutionItem({ lid: 'caf\u00e9-1' });
  const decomposed = solutionItem({ lid: 'cafe\u0301-1' });
  const first = expectFound(parseLuoguEditorialPayload(positivePayload([precomposed]), PID, AT));
  const second = expectFound(parseLuoguEditorialPayload(positivePayload([decomposed]), PID, AT));
  const canonicalId = `luogu-solution-${PID}-${encodeURIComponent('caf\u00e9-1')}`;
  assert.equal(first.sources[0]?.id, canonicalId);
  assert.equal(second.sources[0]?.id, canonicalId, 'the decomposed spelling is canonicalised before it becomes an id');
  assert.equal(first.solutions[0]?.solutionId, second.solutions[0]?.solutionId);
  assert.equal(first.sources[0]?.contentHash, second.sources[0]?.contentHash);
  assert.equal(first.solutions[0]?.contentHash, second.solutions[0]?.contentHash);
  // The stored record carries the composed text, never the decomposed one: the ids hold the canonical
  // percent-encoding, and the combining code point appears nowhere.
  const serialized = JSON.stringify({ sources: second.sources, solutions: second.solutions });
  assert.equal(serialized.includes('\u0301'), false);
  assert.equal(serialized.includes(encodeURIComponent('caf\u00e9-1')), true);
  assert.equal(serialized.includes(encodeURIComponent('cafe\u0301-1')), false);
  assert.equal(serialized.includes('%CC%81'), false);
});

void test('two spellings of one write-up id inside one payload are refused', () => {
  // The whole-payload wrapper is the compatibility entry point; it must refuse a payload that would
  // store one write-up twice under two spellings of one identity.
  const payload = positivePayload([
    solutionItem({ lid: 'caf\u00e9-1' }),
    solutionItem({ lid: 'cafe\u0301-1' }),
  ]);
  const failure = expectFailure(parseLuoguEditorialPayload(payload, PID, AT));
  assert.equal(failure.kind, 'item_unreadable');
  assert.equal(failure.path, 'data.solutions.result[1].lid');
});

void test('the answered problem id must be byte-for-byte the requested one', () => {
  // A padded spelling is a different string, so it is a mismatch — never "the same problem" and never
  // a reason to conclude anything about the material.
  const padded = pagePayload({ result: [solutionItem()], count: 1, problem: problemSummary({ pid: ` ${PID} ` }) });
  assertPageFailure('padded pid (page)', padded, 'problem_pid_mismatch');
  const whole = parseLuoguEditorialPayload(padded, PID, AT);
  assert.notEqual(whole.ok && whole.status, 'absent');
  assert.notEqual(whole.ok && whole.status, 'found');
  // The exact spelling is accepted, in both APIs.
  assert.equal(expectPage(pagePayload({ result: [solutionItem()], count: 1 })).page.items.length, 1);
  assert.equal(expectFound(parseLuoguEditorialPayload(positivePayload([solutionItem()]), PID, AT)).solutions.length, 1);
});

void test('the viewer identity is never read into the material', () => {
  // The observed `user` member is viewer identity. It must not reach a stored record or a note, and it
  // must not be required either: the positive payload is complete without one.
  const withViewer = expectFound(parseLuoguEditorialPayload(positivePayload([solutionItem()]), PID, AT));
  const withoutViewer = expectFound(
    parseLuoguEditorialPayload(positivePayload([solutionItem()], { viewer: null }), PID, AT),
  );
  for (const result of [withViewer, withoutViewer]) {
    const serialized = JSON.stringify({ sources: result.sources, solutions: result.solutions });
    assert.equal(serialized.includes('PLACEHOLDER_VIEWER'), false);
    assert.equal(serialized.includes('avatar.png'), false);
  }
});

// ---------------------------------------------------------------------------------------
// The paged API: one server page at a time
// ---------------------------------------------------------------------------------------

void test('one server page reports its declared total and page size next to its own items', () => {
  // The recorded shape of the real multi-page answer: 56 write-ups at 10 per page, where page 1
  // carries ten of them and `count` is the total.
  const page = expectPage(
    pagePayload({ result: Array.from({ length: 10 }, (_, index) => solutionItem({ lid: `lid-${String(index)}` })), count: 56 }),
  );
  assert.equal(page.page.count, 56);
  assert.equal(page.page.perPage, 10);
  assert.equal(page.page.items.length, 10);
  assert.deepEqual(
    page.page.items.map((item) => item.lid),
    Array.from({ length: 10 }, (_, index) => `lid-${String(index)}`),
  );
  // The observed numeric members are carried through as numbers, with no interpretation.
  assert.equal(page.page.items[0]?.time, 1_700_000_000);
  assert.equal(page.page.items[0]?.category, 1);
  assert.equal(page.page.items[0]?.status, 2);
  assert.equal(page.page.items[0]?.authorName, 'PLACEHOLDER_AUTHOR');
});

void test('a page larger than the declared total is readable as a page and refused by its caller', () => {
  // This module deliberately does not know the page number, so a page whose content cannot belong to
  // the declared total is still *read*; refusing it is the reader's check (`min(perPage, …)`).
  const page = expectPage(pagePayload({ result: [solutionItem(), solutionItem()], count: 0 }));
  assert.equal(page.page.count, 0);
  assert.equal(page.page.items.length, 2);
});

void test('a success envelope must be status 200, carry the requested pid and bounded pagination', () => {
  const unreadable: readonly { readonly label: string; readonly payload: unknown; readonly kind: string }[] = [
    {
      label: 'status 201',
      payload: pagePayload({ result: [solutionItem()], count: 1, status: 201 }),
      kind: 'envelope_status',
    },
    {
      label: 'status missing',
      payload: pagePayload({ result: [solutionItem()], count: 1, withoutStatus: true }),
      kind: 'envelope_status',
    },
    {
      label: 'problem block missing',
      payload: pagePayload({ result: [solutionItem()], count: 1, withoutProblem: true }),
      kind: 'no_problem_block',
    },
    {
      label: 'problem is not an object',
      payload: pagePayload({ result: [solutionItem()], count: 1, problem: 'PLACEHOLDER' }),
      kind: 'no_problem_block',
    },
    {
      label: 'problem pid missing',
      payload: pagePayload({ result: [solutionItem()], count: 1, problem: { type: 'P' } }),
      kind: 'no_problem_block',
    },
    {
      label: 'problem pid is another problem',
      payload: pagePayload({ result: [solutionItem()], count: 1, problem: problemSummary({ pid: 'P9999' }) }),
      kind: 'problem_pid_mismatch',
    },
    {
      label: 'count missing',
      payload: { status: 200, data: { solutions: { perPage: 10, result: [] }, problem: problemSummary() } },
      kind: 'count_unreadable',
    },
    {
      label: 'count a string',
      payload: { status: 200, data: { solutions: { perPage: 10, count: '0', result: [] }, problem: problemSummary() } },
      kind: 'count_unreadable',
    },
    {
      label: 'count a fraction',
      payload: { status: 200, data: { solutions: { perPage: 10, count: 0.5, result: [] }, problem: problemSummary() } },
      kind: 'count_unreadable',
    },
    {
      label: 'count negative',
      payload: { status: 200, data: { solutions: { perPage: 10, count: -1, result: [] }, problem: problemSummary() } },
      kind: 'count_unreadable',
    },
    {
      label: 'count beyond the bound',
      payload: {
        status: 200,
        data: { solutions: { perPage: 10, count: MAX_EDITORIAL_WRITE_UPS + 1, result: [] }, problem: problemSummary() },
      },
      kind: 'count_unreadable',
    },
    {
      label: 'perPage missing',
      payload: { status: 200, data: { solutions: { count: 0, result: [] }, problem: problemSummary() } },
      kind: 'per_page_unreadable',
    },
    {
      label: 'perPage zero',
      payload: { status: 200, data: { solutions: { perPage: 0, count: 0, result: [] }, problem: problemSummary() } },
      kind: 'per_page_unreadable',
    },
    {
      label: 'perPage a string',
      payload: { status: 200, data: { solutions: { perPage: '10', count: 0, result: [] }, problem: problemSummary() } },
      kind: 'per_page_unreadable',
    },
    {
      label: 'perPage beyond the bound',
      payload: { status: 200, data: { solutions: { perPage: 10_000_000, count: 0, result: [] }, problem: problemSummary() } },
      kind: 'per_page_unreadable',
    },
  ];
  for (const entry of unreadable) {
    assertPageFailure(entry.label, entry.payload, entry.kind);
  }
});

// ---------------------------------------------------------------------------------------
// Absence: only an explicit zero with an empty list
// ---------------------------------------------------------------------------------------

void test('an explicit count of zero with an empty result list is the only absence', () => {
  const payload = positivePayload([], { count: 0 });
  const result = parseLuoguEditorialPayload(payload, PID, AT);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, 'absent');
  if (result.status === 'absent') {
    assert.match(result.detail, /count 0/);
    // The sentence explains the observation, not a value from the platform.
    assert.equal(result.detail.includes('PLACEHOLDER'), false);
  }
  // The paged API reports the same payload as a page, and it is the *reader* that fixes the meaning of
  // page 1: only there, and only for exactly this signal, an absence may be concluded.
  const page = parseLuoguEditorialPage(payload, PID);
  assert.equal(page.ok, true);
  if (page.ok && page.status === 'page') {
    assert.equal(page.page.count, 0);
    assert.equal(page.page.items.length, 0);
  }
});

void test('every unreadable variation of the empty case is a failure, never an absence', () => {
  const unreadable: readonly { readonly label: string; readonly payload: unknown }[] = [
    { label: 'no solutions block', payload: { status: 200, data: { problem: problemSummary(), acceptSolution: false } } },
    { label: 'solutions not an object', payload: { status: 200, data: { solutions: [] } } },
    { label: 'count missing', payload: { status: 200, data: { solutions: { perPage: 10, result: [] } } } },
    { label: 'count not a number', payload: { status: 200, data: { solutions: { count: '0', result: [] } } } },
    { label: 'count is a fraction', payload: { status: 200, data: { solutions: { count: 0.5, result: [] } } } },
    { label: 'count negative', payload: { status: 200, data: { solutions: { count: -1, result: [] } } } },
    { label: 'result missing', payload: { status: 200, data: { solutions: { perPage: 10, count: 0 } } } },
    { label: 'result not an array', payload: { status: 200, data: { solutions: { count: 0, result: null } } } },
    { label: 'count disagrees with result', payload: positivePayload([], { count: 3 }) },
    { label: 'data missing', payload: { status: 200 } },
    { label: 'payload not an object', payload: [] },
    { label: 'payload null', payload: null },
  ];
  for (const entry of unreadable) {
    const result = parseLuoguEditorialPayload(entry.payload, PID, AT);
    const failure = expectFailure(result);
    assert.notEqual(failure.kind, undefined);
    // The failure explains the structure, and `path` never carries a value.
    assert.equal(failure.path.includes('PLACEHOLDER'), false, `${entry.label}: path must be structural`);
  }
  // Specifically: a payload whose only defect is a disagreement must be reported as such.
  assert.equal(
    expectFailure(parseLuoguEditorialPayload(positivePayload([], { count: 3 }), PID, AT)).kind,
    'count_result_mismatch',
  );
  assert.equal(
    expectFailure(parseLuoguEditorialPayload({ status: 200, data: { solutions: [] } }, PID, AT)).kind,
    'solutions_unreadable',
  );
  assert.equal(
    expectFailure(parseLuoguEditorialPayload({ status: 200, data: {} }, PID, AT)).kind,
    'no_solutions_block',
  );
});

void test('a non-empty count whose items cannot be read is a failure, never a partial success', () => {
  const broken: readonly { readonly label: string; readonly item: Record<string, unknown>; readonly kind: string }[] = [
    { label: 'lid is a number', item: solutionItem({ lid: 42 }), kind: 'lid_unreadable' },
    { label: 'lid blank', item: solutionItem({ lid: '  ' }), kind: 'lid_unreadable' },
    { label: 'lid over-long', item: solutionItem({ lid: 'x'.repeat(201) }), kind: 'lid_unreadable' },
    { label: 'lid with a control character', item: solutionItem({ lid: 'lid\u0000x' }), kind: 'lid_unreadable' },
    { label: 'title a number', item: solutionItem({ title: 7 }), kind: 'item_unreadable' },
    { label: 'content missing', item: solutionItem({ content: undefined }), kind: 'item_unreadable' },
    { label: 'content blank', item: solutionItem({ content: '   ' }), kind: 'empty_content' },
    {
      label: 'contentFull false',
      item: solutionItem({ contentFull: false }),
      kind: 'content_truncated',
    },
    {
      label: 'contentFull missing',
      item: solutionItem({ contentFull: undefined }),
      kind: 'content_truncated',
    },
    { label: 'item not an object', item: 'PLACEHOLDER' as unknown as Record<string, unknown>, kind: 'item_unreadable' },
  ];
  for (const entry of broken) {
    const result = parseLuoguEditorialPayload(positivePayload([solutionItem(), entry.item]), PID, AT);
    const failure = expectFailure(result);
    assert.equal(failure.kind, entry.kind, entry.label);
    // The path names the member that failed and never its value.
    assert.equal(failure.path.includes('PLACEHOLDER'), false);
  }
});

void test('an unreadable lid is refused without carrying the value anywhere', () => {
  // The sensitive shape: an id this build cannot store, holding a value that must not travel. `lid` is
  // validated before anything else in the item, so every one of these is the same closed failure.
  const variants: readonly { readonly label: string; readonly lid: unknown }[] = [
    { label: 'surrogate pair half', lid: `lid-\ud800-${LID_SENTINEL}` },
    { label: 'control character', lid: `${LID_SENTINEL}\u0007` },
    { label: 'empty', lid: '' },
    { label: 'whitespace only', lid: '   ' },
    { label: 'not a string', lid: 12345 },
    { label: 'over-long', lid: LID_SENTINEL.repeat(50) },
  ];
  for (const variant of variants) {
    const failure = expectFailure(
      parseLuoguEditorialPayload(positivePayload([solutionItem({ lid: variant.lid })]), PID, AT),
    );
    assert.equal(failure.kind, 'lid_unreadable', variant.label);
    assert.deepEqual(Object.keys(failure).sort(), ['kind', 'ok', 'path'], variant.label);
    const serialized = JSON.stringify(failure);
    assert.equal(serialized.includes(LID_SENTINEL), false, `${variant.label}: the failure must not carry the id`);
    assert.equal(serialized.includes('12345'), false, `${variant.label}: the failure must not carry the value`);
    // The path is structural only.
    assert.equal(failure.path, 'data.solutions.result[0].lid');
  }
});

// ---------------------------------------------------------------------------------------
// Error envelopes
// ---------------------------------------------------------------------------------------

void test('a 404 envelope is unavailable and explicitly never an absence', () => {
  for (const payload of [errorPayload(404, 404), errorPayload(404, 200)]) {
    const failure = expectFailure(parseLuoguEditorialPayload(payload, PID, AT));
    assert.equal(failure.kind, 'not_found');
  }
});

void test('an authentication envelope is recognized without reading its message', () => {
  const failure = expectFailure(parseLuoguEditorialPayload(errorPayload(401, 401), PID, AT));
  assert.equal(failure.kind, 'authentication_required');
  // The classification reads `errorCode` only: the message and type are not consulted, so no
  // server-provided text can influence the result or reach a diagnostic.
  const withoutMessage = expectFailure(
    parseLuoguEditorialPayload({ status: 401, data: { errorCode: 401 }, user: null }, PID, AT),
  );
  assert.equal(withoutMessage.kind, 'authentication_required');
  // A 403 is a refusal, not an authentication wall, and still not an absence.
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(403, 403), PID, AT)).kind, 'refused');
  // An unrecognized error code is a refusal too; a server failure keeps its own kind.
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(418, 418), PID, AT)).kind, 'refused');
  assert.equal(expectFailure(parseLuoguEditorialPayload(errorPayload(500, 500), PID, AT)).kind, 'server_error');
  // The status member alone can still identify a 404 when `errorCode` is unreadable.
  assert.equal(
    expectFailure(parseLuoguEditorialPayload({ status: 404, data: { errorType: 'x' } }, PID, AT)).kind,
    'not_found',
  );
});

void test('an error envelope carrying a fake empty solution block is never an absence', () => {
  // The failure mode this exists for: a refused request whose payload still carries a shaped, empty
  // `solutions` object. The envelope's own error members decide, in both APIs and at every status.
  const fakes: readonly { readonly label: string; readonly payload: unknown }[] = [
    {
      label: '401 with an empty block',
      payload: errorPayload(401, 401, { solutions: { perPage: 10, count: 0, result: [] } }),
    },
    {
      label: '403 with an empty block',
      payload: errorPayload(403, 403, { solutions: { perPage: 10, count: 0, result: [] } }),
    },
    {
      label: '404 with an empty block',
      payload: errorPayload(404, 404, { solutions: { perPage: 10, count: 0, result: [] } }),
    },
    {
      label: 'errorType only, status 200, with an empty block',
      payload: { status: 200, data: { errorType: 'x', solutions: { perPage: 10, count: 0, result: [] } } },
    },
    {
      label: 'errorMessage only, status 200, with an empty block',
      payload: { status: 200, data: { errorMessage: 'x', solutions: { perPage: 10, count: 0, result: [] } } },
    },
  ];
  for (const entry of fakes) {
    const whole = parseLuoguEditorialPayload(entry.payload, PID, AT);
    assert.notEqual(whole.ok && whole.status, 'absent', `${entry.label}: whole payload`);
    const page = parseLuoguEditorialPage(entry.payload, PID);
    assert.notEqual(page.ok && page.status, 'absent', `${entry.label}: page`);
    assert.notEqual(page.ok && page.status, 'page', `${entry.label}: a fake block is not a page`);
  }
});

void test('no failure message or path carries a server-provided value', () => {
  const payload = errorPayload(500, 500, { errorData: { secret: 'PLACEHOLDER_SECRET' } });
  const failure = expectFailure(parseLuoguEditorialPayload(payload, PID, AT));
  const serialized = JSON.stringify(failure);
  for (const leak of ['PLACEHOLDER_SECRET', 'PLACEHOLDER_ERROR_MESSAGE', 'PLACEHOLDER_ERROR_TYPE']) {
    assert.equal(serialized.includes(leak), false, `the failure must not carry ${leak}`);
  }
  // The failure is a closed kind plus a structural path — nothing else.
  assert.deepEqual(Object.keys(failure).sort(), ['kind', 'ok', 'path']);
});

// ---------------------------------------------------------------------------------------
// Page hydration extraction
// ---------------------------------------------------------------------------------------

void test('the hydration element of an authenticated page is read and parsed', () => {
  const payload = positivePayload([solutionItem()]);
  const extracted = lentilleContextPayload(solutionPage(payload));
  assert.deepEqual(extracted, payload);
  // The extracted payload parses exactly like a direct body would.
  assert.equal(expectFound(parseLuoguEditorialPayload(extracted, PID, AT)).solutions.length, 1);
});

void test('a page without the hydration element yields nothing instead of an empty payload', () => {
  // Each of these must be `null`, so the caller classifies it as unreadable rather than concluding
  // anything about the editorial — and certainly not that there is none.
  const pages: readonly { readonly label: string; readonly html: string }[] = [
    { label: 'no scripts', html: '<html><body><div id="app"></div></body></html>' },
    { label: 'unrelated scripts', html: '<html><body><script type="application/json">{"a":1}</script></body></html>' },
    {
      label: 'element present but empty',
      html: `<html><body><script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json"></script></body></html>`,
    },
    {
      label: 'element present but unparsable',
      html: `<html><body><script id="${LENTILLE_CONTEXT_ELEMENT_ID}" type="application/json">{not json</script></body></html>`,
    },
    { label: 'empty document', html: '' },
    { label: 'login page', html: '<html><body><form id="login-form"></form></body></html>' },
  ];
  for (const entry of pages) {
    assert.equal(lentilleContextPayload(entry.html), null, entry.label);
  }
});

void test('the hydration element is read with either quote style and after other scripts', () => {
  const payload = { status: 200, data: { solutions: { count: 0, result: [], perPage: 10 } } };
  const singleQuoted = `<html><body><script type="text/javascript">var a = 1;</script><script id='${LENTILLE_CONTEXT_ELEMENT_ID}' type='application/json'>${JSON.stringify(payload)}</script></body></html>`;
  assert.deepEqual(lentilleContextPayload(singleQuoted), payload);
});

// ---------------------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------------------

void test('the sanitized fixtures carry no captured value', () => {
  // A guard on this file: if a future edit pastes a real capture in, the placeholders disappear.
  const fixtures = JSON.stringify([
    positivePayload([solutionItem()]),
    pagePayload({ result: [solutionItem()], count: 56 }),
    errorPayload(401, 401),
    errorPayload(404, 404),
    solutionPage(positivePayload([solutionItem()])),
  ]);
  // Cookies and credentials never appear at all.
  for (const forbidden of ['__client_id', '_uid', 'Cookie', 'Set-Cookie', 'Authorization']) {
    assert.equal(fixtures.includes(forbidden), false, `fixtures must not carry ${forbidden}`);
  }
  // Every value is an obvious placeholder, so a real one would be conspicuous in review.
  assert.match(fixtures, /PLACEHOLDER/);
});
