/**
 * Luogu authenticated editorial payloads (Sprint 33C; paged API added in the Sprint 33C revision).
 *
 * The shape this module reads was **observed** from a sanitized capture of the authenticated
 * `/problem/solution/<pid>` surface, recorded in
 * `.local/observations/luogu-editorial-shape.v1.json` (classification `sanitized-schema-only`). That
 * capture keeps field names, types and optionality and nothing else: no cookie, no viewer identity, no
 * author values, no titles, no bodies, no error-message text. Everything here is written against that
 * recorded schema, and the capture's own `implementationConstraints` are the rules this file enforces:
 *
 * - **only `count === 0` together with `result: []`, from a recognised successful payload, may become
 *   `absent`.** A missing field, an unreadable envelope, a `count`/`result` disagreement or an
 *   unrecognised error envelope is `changed_response`, never an absence. That distinction is what
 *   keeps the expensive statement-only reasoning path from running on a broken request.
 * - **a `404` error envelope is `unavailable`, and explicitly not `absent`.**
 * - **`contentFull` must be `true`.** A solution whose body the platform truncated is refused rather
 *   than stored as if it were complete material.
 * - **`categoryOld` and `author.isRoot` are optional, and `author.badge` is `string | null`** — the
 *   capture recorded each variation, so those members stay compatible. Nothing here reads them, which
 *   is exactly why the variations cannot break a read; every member this build *stores* (`lid`,
 *   `title`, `author.name`, `category`, `time`, `upvote`, `replyCount`, `favorCount`, `status`,
 *   `content`, `contentFull`) is required by the observed shape and a missing or wrongly typed one is
 *   an unreadable item, never a silently defaulted value.
 * - **`lid` is a string**, not a number.
 * - **no `content`, `title`, author value, viewer identity, cookie or raw response ever reaches a
 *   diagnostic, a sample or a fixture.** Failures are typed by a closed `kind`, and the caller
 *   rebuilds them as fixed sanitized platform errors.
 *
 * ## Paging
 *
 * The capture recorded `?page=2` answering the same top-level shape as the unparameterised first page
 * with a non-empty result, while `count` (56 for P1001) is the **total** number of write-ups, not the
 * length of one page. {@link parseLuoguEditorialPage} therefore reads exactly **one** server page and
 * reports its declared `count`/`perPage` next to the items it read; the reader walks the pages and is
 * the only place that knows how long a page must be, that the total must be reached and that no `lid`
 * may repeat. Composing the two answers into one record set is the reader's job, so this module stays
 * a pure, single-page payload reader.
 *
 * A successful page must be a recognised success envelope: root `status === 200`, a `data.problem`
 * object whose `pid` is **exactly** the requested problem id (padding is a mismatch, not the same
 * problem), a `data.solutions` object with a bounded safe integer `count`, a bounded positive safe
 * integer `perPage` and an array `result`. The `envelopeStatus`, `no_problem_block`,
 * `problem_pid_mismatch`, `count_unreadable` and `per_page_unreadable` kinds exist so a payload that is
 * *shaped* like an answer — including one that carries a fake empty `solutions` block next to an error,
 * a foreign pid or an unreadable page size — can never be read as "this problem has no editorial".
 *
 * ## Stored identity
 *
 * The stored `lid` is a server-provided string, so it is canonicalised at this boundary — trimmed and
 * NFC-normalised, so `é` and `e` + U+0301 are one identity and not two — and then validated
 * (non-empty, bounded, no control characters, UTF-8 encodable) and escaped with the domain's own
 * {@link encodeIdPart} before it becomes part of any id. A value this build cannot encode is a
 * `lid_unreadable` failure whose payload carries **no value at all** — see
 * {@link LuoguEditorialFailure}.
 *
 * The module is pure: no network, no clock, no session, no store, and no model.
 */
import type { EditorialSource, EditorialSolution } from '../../domain/index.js';
import { createEditorialSolution, createEditorialSource, encodeIdPart } from '../../domain/index.js';
import { isJsonRecord } from './parsers.js';

/**
 * Field path of the payload inside an authenticated solution page.
 *
 * The capture recorded the JSON as the `#lentille-context` element (`application/json`) of a
 * `text/html` document, i.e. the page's hydration payload. When the same shape arrives as the body of
 * a direct request instead, it is parsed from the root. Both paths converge on
 * {@link parseLuoguEditorialPage}.
 */
export const LENTILLE_CONTEXT_ELEMENT_ID = 'lentille-context';

/**
 * Closed classification of one unreadable payload.
 *
 * It is a fixed code rather than prose: a caller rebuilds it into a sanitized `PlatformError` with its
 * own safe detail, so a server-provided string (for example `data.errorType`) can never travel into a
 * diagnostic, a sample or a log line.
 */
export type LuoguEditorialFailureKind =
  | 'not_an_object'
  | 'envelope_unreadable'
  | 'envelope_status'
  | 'no_solutions_block'
  | 'solutions_unreadable'
  | 'count_unreadable'
  | 'per_page_unreadable'
  | 'count_result_mismatch'
  | 'no_problem_block'
  | 'problem_pid_mismatch'
  | 'item_unreadable'
  | 'lid_unreadable'
  | 'content_truncated'
  | 'empty_content'
  | 'not_found'
  | 'authentication_required'
  | 'rate_limited'
  | 'server_error'
  | 'refused';

/**
 * One unreadable payload: the closed kind plus the structural path that failed, **never a value**.
 *
 * The object deliberately has exactly these three members and no `message`, `detail` or `sample`, so a
 * caller cannot accidentally forward a value the payload carried. `path` is always a structural
 * member path such as `data.solutions.result[2].lid`.
 */
export interface LuoguEditorialFailure {
  readonly ok: false;
  readonly kind: LuoguEditorialFailureKind;
  /** Structural location of the failure (`data.solutions.result[2].lid`), never a value. */
  readonly path: string;
}

/** One readable payload: the material, or an explicit absence. */
export type LuoguEditorialParseResult =
  | {
      readonly ok: true;
      readonly status: 'found';
      readonly sources: readonly EditorialSource[];
      readonly solutions: readonly EditorialSolution[];
    }
  | { readonly ok: true; readonly status: 'absent'; readonly detail: string }
  | LuoguEditorialFailure;

/**
 * One write-up of one page, already validated and bounded.
 *
 * Every field here is **required by the observed shape**: the capture records `lid`, `title`,
 * `category`, `time`, `upvote`, `replyCount`, `favorCount`, `status`, `content` and `contentFull` as
 * present members of type `string`/`number`/`boolean`, and `author` as an object with a `string`
 * `name`. A missing or wrongly typed member is therefore *unreadable*, not a value to default: a
 * write-up whose provenance cannot be stated is refused whole rather than stored with a fabricated
 * `null` author or a zeroed counter.
 */
export interface ObservedSolution {
  /**
   * Canonical write-up id: trimmed and NFC-normalised, exactly the text the stored id is built from.
   *
   * NFC canonicalisation is not cosmetic. `é` (U+00E9) and `e` + U+0301 are different JavaScript
   * strings that `encodeIdPart` escapes differently, so storing the raw spelling would let one
   * write-up exist twice under two "different" ids; canonicalising here makes the id, the dedup key
   * and the rendered value the same text.
   */
  readonly lid: string;
  /** Write-up title; required and non-empty. */
  readonly title: string;
  /** Retrieved body; the only field that ever becomes an `EditorialSolution.text`. */
  readonly content: string;
  /** Public author name of this write-up; required and non-empty. */
  readonly authorName: string;
  readonly category: number;
  readonly status: number;
  /** Raw `time` member. Its unit is unverified, so it is recorded as a number and never converted. */
  readonly time: number;
  readonly upvote: number;
  readonly replyCount: number;
  readonly favorCount: number;
}

/** One readable server page: its declared pagination and the write-ups it carried, in order. */
export interface LuoguEditorialPage {
  /** Declared total number of write-ups for this problem (all pages, not this page's length). */
  readonly count: number;
  /** Declared server page size of one page. */
  readonly perPage: number;
  /** The write-ups of exactly this page, in platform order. */
  readonly items: readonly ObservedSolution[];
}

/** Result of reading one server page: a page, an explicit absence, or a closed failure. */
export type LuoguEditorialPageResult =
  | { readonly ok: true; readonly status: 'page'; readonly page: LuoguEditorialPage }
  | { readonly ok: true; readonly status: 'absent'; readonly detail: string }
  | LuoguEditorialFailure;

/**
 * Upper bound of the declared total; beyond it the payload is refused rather than walked.
 *
 * It bounds both the number of items this build will materialize from one payload and the page count
 * the reader derives from it, so a hostile or broken `count` cannot turn one read into an unbounded
 * number of requests.
 */
export const MAX_EDITORIAL_WRITE_UPS = 100_000;

/** Upper bound of the declared server page size of one solutions page. */
export const MAX_EDITORIAL_PAGE_SIZE = 1_000;

/** Upper bound of one `lid`, in UTF-16 code units, before it is refused as an id. */
export const MAX_EDITORIAL_LID_CHARS = 200;

/** Upper bound of the stored list index, so a pathological list cannot inflate a snapshot. */
export const MAX_SOLUTION_INDEX_CHARS = 20_000;

/** Fixed explanations of the two readable outcomes; neither quotes a payload value. */
const ABSENT_DETAIL = 'Luogu reported no solution for this problem (count 0 with an empty result list)';

function failure(kind: LuoguEditorialFailureKind, path: string): LuoguEditorialFailure {
  return { ok: false, kind, path };
}

/** True for a bounded, non-negative integer. */
function boundedCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_EDITORIAL_WRITE_UPS;
}

/** True for a bounded, strictly positive integer. A page size of zero cannot address anything. */
function boundedPerPage(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_EDITORIAL_PAGE_SIZE;
}

/**
 * The `pid` of the `data.problem` block, exactly as the platform spelled it, or `null` when the member
 * is not a usable problem id.
 *
 * The value is deliberately **not** trimmed: the answered identity must equal the requested identity
 * character for character, so `" P1001 "` is a mismatch rather than the same problem with padding. The
 * request's own pid was already trimmed and shape-checked before it became a request.
 */
function problemPidOf(problem: unknown): string | null {
  if (!isJsonRecord(problem)) {
    return null;
  }
  const pid = problem.pid;
  return typeof pid === 'string' && pid.length > 0 ? pid : null;
}

/**
 * Read exactly one server page of one problem's solution material.
 *
 * `pid` is the canonical problem id the request was made for. It is used to prove the answered payload
 * belongs to this problem (`data.problem.pid` must equal it) and, in
 * {@link buildEditorialMaterial}, to build the stored identity and the source URL. The upstream
 * problem summary is otherwise not read: its name, difficulty and score are never stored, and the
 * viewer identity (`user`) is never read at all.
 *
 * The returned page is *not* checked for a complete length: how long page *N* must be follows from
 * `count`, `perPage` and `N`, and only the caller walking the pages knows `N`.
 */
export function parseLuoguEditorialPage(payload: unknown, pid: string): LuoguEditorialPageResult {
  if (!isJsonRecord(payload)) {
    return failure('not_an_object', '$');
  }
  const status = payload.status;
  const data = payload.data;
  if (!isJsonRecord(data)) {
    return failure('envelope_unreadable', 'data');
  }
  // An error envelope is recognized by its own members, never by the absence of the positive block:
  // "this payload did not carry solutions" must not be what decides between failure and absence. It is
  // classified before the positive block, so an error answer carrying a fake empty `solutions` object
  // is a typed failure and never an absence — and before the envelope status, because an error payload
  // declares its own non-200 status.
  if ('errorCode' in data || 'errorType' in data || 'errorMessage' in data) {
    return classifyErrorEnvelope(data, status);
  }
  // A success envelope is recognised by its own status. The observed `status` is a hydration payload
  // field rather than an independently captured HTTP status (see the capture), so an unexpected value
  // is a payload this build cannot read — never evidence about the editorial.
  if (status !== 200) {
    return failure('envelope_status', 'status');
  }
  if (!('solutions' in data)) {
    return failure('no_solutions_block', 'data.solutions');
  }
  const solutions = data.solutions;
  if (!isJsonRecord(solutions)) {
    return failure('solutions_unreadable', 'data.solutions');
  }
  const count = solutions.count;
  if (!boundedCount(count)) {
    return failure('count_unreadable', 'data.solutions.count');
  }
  const perPage = solutions.perPage;
  if (!boundedPerPage(perPage)) {
    return failure('per_page_unreadable', 'data.solutions.perPage');
  }
  const result = solutions.result;
  if (!Array.isArray(result)) {
    return failure('solutions_unreadable', 'data.solutions.result');
  }
  // The answered payload must belong to the problem that was requested. A `problem` block is part of
  // the observed shape, so its absence or a different pid is an unreadable answer, not an absence.
  const problemPid = problemPidOf(data.problem);
  if (problemPid === null) {
    return failure('no_problem_block', 'data.problem');
  }
  if (problemPid !== pid) {
    return failure('problem_pid_mismatch', 'data.problem.pid');
  }
  const items: ObservedSolution[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const parsed = parseSolutionItem(result[index], `data.solutions.result[${String(index)}]`);
    if (!parsed.ok) {
      return parsed;
    }
    items.push(parsed.item);
  }
  return { ok: true, status: 'page', page: { count, perPage, items } };
}

/**
 * Read one whole-payload answer: the observed single-page shape where `count` is that page's length.
 *
 * This is the compatibility entry point for a payload that carries an entire result set in one page
 * (the sanitized captures recorded such payloads, and the shape tests drive them directly). It is
 * defined in terms of {@link parseLuoguEditorialPage}, so it enforces the same envelope, pid,
 * `perPage` and item rules, and it adds the one rule only a *complete* payload can enforce:
 * `count` must equal the length of `result`. An explicit `count: 0` with an empty list is the only
 * absence.
 *
 * A reader that walks pages must use {@link parseLuoguEditorialPage} instead: a real multi-page answer
 * legitimately carries a `count` larger than one page's `result` length.
 */
export function parseLuoguEditorialPayload(
  payload: unknown,
  pid: string,
  retrievedAt: string,
): LuoguEditorialParseResult {
  const parsed = parseLuoguEditorialPage(payload, pid);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.status === 'absent') {
    return parsed;
  }
  const { count, items } = parsed.page;
  // The two members must agree. Only the agreement of an explicit zero and an empty list is an
  // absence; anything else is a payload this build cannot read.
  if (count !== items.length) {
    return failure('count_result_mismatch', 'data.solutions.result');
  }
  if (count === 0) {
    return { ok: true, status: 'absent', detail: ABSENT_DETAIL };
  }
  return buildEditorialMaterial(items, pid, retrievedAt);
}

/**
 * Classify one error envelope by its own `errorCode` and the envelope status.
 *
 * The mapping mirrors what the same condition means as a real HTTP status, so a Lentille failure
 * declared inside an HTTP `200` envelope cannot change category: `404` is unavailable and can never be
 * an absence, `401` is the authentication wall the capture observed, `429` is a rate limit rather than a
 * plain refusal, and a `5xx` is a server-side outage (`unavailable`, and retryable) rather than
 * `forbidden` — a 500 must never be reported as a permission problem. A `403` and every unrecognized
 * code stay refusals; the caller maps that to a stable operational code and never to an absence.
 */
function classifyErrorEnvelope(data: Record<string, unknown>, status: unknown): LuoguEditorialFailure {
  const code = envelopeErrorCode(data);
  if (code !== null) {
    const classified = classifyErrorCode(code, 'data.errorCode');
    if (classified !== null) {
      return classified;
    }
  }
  if (typeof status === 'number' && Number.isInteger(status)) {
    const classified = classifyErrorCode(status, 'status');
    if (classified !== null) {
      return classified;
    }
  }
  return failure('refused', 'data.errorCode');
}

/** The declared integer `errorCode`, or `null` when the envelope does not declare a usable one. */
function envelopeErrorCode(data: Record<string, unknown>): number | null {
  const errorCode = data.errorCode;
  return typeof errorCode === 'number' && Number.isInteger(errorCode) ? errorCode : null;
}

/**
 * The closed kind of one status-like number, or `null` when it does not identify a failure by itself.
 *
 * Shared by the `errorCode` member and the envelope `status`, so both spell the same condition the same
 * way — the envelope's own code is tried first because it is the more specific statement — while `path`
 * still records which of the two carried it.
 */
function classifyErrorCode(code: number, path: string): LuoguEditorialFailure | null {
  if (code === 404) {
    return failure('not_found', path);
  }
  if (code === 401) {
    return failure('authentication_required', path);
  }
  if (code === 403) {
    return failure('refused', path);
  }
  if (code === 429) {
    return failure('rate_limited', path);
  }
  if (code >= 500) {
    // A server-side failure is an outage, not a permission problem: it keeps the meaning the same
    // status has as a real HTTP answer.
    return failure('server_error', path);
  }
  return null;
}

type ItemParse = { readonly ok: true; readonly item: ObservedSolution } | LuoguEditorialFailure;

/**
 * Read one solution item.
 *
 * Only the fields this build stores are read; `author.uid`, `avatar`, `slogan`, `badge`, `color`,
 * `ccfLevel`, `xcpcLevel`, `background`, `isAdmin`, `isBanned`, `categoryOld`, `isRoot` and the whole
 * `solutionFor` summary are deliberately not read, so no user value and no problem value can reach a
 * stored record. The capture records `categoryOld` and `author.isRoot` as optional and `badge` as
 * `string | null`, so those variations stay compatible precisely because nothing reads them.
 *
 * Every member this build *does* store is required by the observed shape, and a missing or wrongly
 * typed one is `item_unreadable`/`empty_content` rather than a silently defaulted value: a write-up
 * whose author, title or counters cannot be read is refused whole, because storing it with a
 * fabricated `null` author (or a zeroed counter) would misstate the provenance the product keeps.
 *
 * The `lid` is validated as a *stored id* here, at the platform boundary: it is trimmed and
 * NFC-normalised, then required to be non-empty, bounded, control-character-free text that the
 * domain's own encoder accepts. A value that fails is the closed `lid_unreadable` failure, which
 * carries the structural path only — not the offending value.
 */
function parseSolutionItem(value: unknown, path: string): ItemParse {
  if (!isJsonRecord(value)) {
    return failure('item_unreadable', path);
  }
  const canonicalLid = canonicalLidOf(value.lid);
  if (canonicalLid === null) {
    return failure('lid_unreadable', `${path}.lid`);
  }
  // `author` is an object with a required, non-empty string `name` in the observed shape; a write-up
  // without a readable public author is refused instead of being stored as unattributed.
  const author = value.author;
  if (!isJsonRecord(author)) {
    return failure('item_unreadable', `${path}.author`);
  }
  const authorName = nonEmptyText(author.name);
  if (authorName === null) {
    return failure('item_unreadable', `${path}.author.name`);
  }
  const title = nonEmptyText(value.title);
  if (title === null) {
    return failure('item_unreadable', `${path}.title`);
  }
  const category = observedSafeInteger(value.category);
  if (category === null) {
    return failure('item_unreadable', `${path}.category`);
  }
  const status = observedSafeInteger(value.status);
  if (status === null) {
    return failure('item_unreadable', `${path}.status`);
  }
  const time = observedSafeInteger(value.time);
  if (time === null) {
    return failure('item_unreadable', `${path}.time`);
  }
  const upvote = observedSafeInteger(value.upvote);
  if (upvote === null) {
    return failure('item_unreadable', `${path}.upvote`);
  }
  const replyCount = observedSafeInteger(value.replyCount);
  if (replyCount === null) {
    return failure('item_unreadable', `${path}.replyCount`);
  }
  const favorCount = observedSafeInteger(value.favorCount);
  if (favorCount === null) {
    return failure('item_unreadable', `${path}.favorCount`);
  }
  if (value.contentFull !== true) {
    return failure('content_truncated', `${path}.contentFull`);
  }
  const content = value.content;
  if (typeof content !== 'string') {
    return failure('item_unreadable', `${path}.content`);
  }
  if (content.trim().length === 0) {
    return failure('empty_content', `${path}.content`);
  }
  return {
    ok: true,
    item: { lid: canonicalLid, title, content, authorName, category, status, time, upvote, replyCount, favorCount },
  };
}

/**
 * The canonical stored form of one `lid`, or `null` when the value cannot be stored as an id.
 *
 * Canonical means trimmed and NFC-normalised, and it is the value that is both stored and escaped, so
 * two spellings of the same Unicode text can never become two write-ups. `null` (never a partially
 * fixed value) is the closed refusal described by {@link parseSolutionItem}; the value is not carried.
 */
function canonicalLidOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const canonical = value.trim().normalize('NFC');
  if (canonical.length === 0 || canonical.length > MAX_EDITORIAL_LID_CHARS) {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/u.test(canonical)) {
    return null;
  }
  if (!isEncodableIdPart(canonical)) {
    return null;
  }
  return canonical;
}

/** Trimmed non-empty text of a required string member, or `null` for a missing/blank/non-string one. */
function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  return text.length === 0 ? null : text;
}

/** The observed numeric member: a safe integer, or `null` when it is missing/misplaced in type. */
function observedSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/**
 * Whether the domain's id encoder accepts this value, without letting its refusal escape.
 *
 * `encodeIdPart` reports a rejected value by *carrying it in the error* — which is exactly what must
 * not happen to a server-provided id — so its refusal is reduced to a boolean here and the failure the
 * caller sees is the value-free {@link LuoguEditorialFailure}.
 */
function isEncodableIdPart(value: string): boolean {
  try {
    encodeIdPart(value);
    return true;
  } catch {
    return false;
  }
}

/** Official address of the problem's whole solution list; the attribution this material came from. */
export const SOLUTION_LIST_URL_PREFIX = 'https://www.luogu.com.cn/problem/solution/';

/** One stored source and its write-up; the id of the source is the id the write-up references. */
function sourceAndSolution(
  item: ObservedSolution,
  pid: string,
  ordinal: number,
  retrievedAt: string,
): { readonly source: EditorialSource; readonly solution: EditorialSolution } {
  const documentId = `${pid}-${encodeIdPart(item.lid)}`;
  const sourceId = `luogu-solution-${documentId}`;
  const source = createEditorialSource({
    id: sourceId,
    kind: 'solution',
    url: `${SOLUTION_LIST_URL_PREFIX}${encodeURIComponent(pid)}`,
    title: item.title,
    author: item.authorName,
    availability: 'found',
    // The read time is stamped into the record from the caller's single value, so every source of one
    // read carries the same instant and this module itself stays free of time.
    retrievedAt,
    publishedAt: null,
    language: null,
    text: sourceIndex(item),
    note: sourceNote(item),
  });
  const solution = createEditorialSolution({
    solutionId: `luogu-solution-doc-${documentId}`,
    sourceId,
    ordinal,
    title: item.title,
    // The retrieved body is stored exactly once, and only here.
    text: item.content,
    language: null,
  });
  return { source, solution };
}

/**
 * Build the domain material from the validated write-ups of one read.
 *
 * One `EditorialSource` is created **per write-up**, because each stored record carries its own
 * identity: the source id and the solution id contain the problem id and the safely encoded `lid`,
 * `title` is the write-up's title, `author` is the *public author name* of that write-up, the URL is
 * the problem's official solution list (the surface the read really used), `publishedAt` and
 * `language` are `null` because the capture did not verify a timestamp unit or a language field, and
 * `note` records only numeric platform fields. The viewer identity and the avatar are never read.
 *
 * A `found` source must carry retrieved text, and this source really did retrieve a write-up. Its body
 * is therefore a bounded **index** of that one write-up — its `lid`, title and public author, which is
 * the identity the read established — rather than a copy of the body: the body lives in the paired
 * `EditorialSolution.text`, and duplicating it here would store the same text twice under two hashes.
 *
 * `ordinal` is the write-up's position in the whole read (across every page), so the platform's order
 * is preserved exactly and a resumed read can never renumber a write-up.
 *
 * A value that cannot become a stored id — the only way this function can fail, since the domain
 * factories validate everything else — is reported as a `lid_unreadable` failure carrying no value.
 * A payload that names one write-up twice (including twice under two Unicode spellings of one id, which
 * canonicalisation folds together) is refused as well: the stored ids are derived from the canonical
 * `lid`, so letting both through would give one write-up two records under one identity.
 */
export function buildEditorialMaterial(
  items: readonly ObservedSolution[],
  pid: string,
  retrievedAt: string,
): LuoguEditorialParseResult {
  try {
    const sources: EditorialSource[] = [];
    const solutions: EditorialSolution[] = [];
    const seen = new Set<string>();
    for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
      const item = items[ordinal]!;
      if (seen.has(item.lid)) {
        return failure('item_unreadable', `data.solutions.result[${String(ordinal)}].lid`);
      }
      seen.add(item.lid);
      const built = sourceAndSolution(item, pid, ordinal, retrievedAt);
      sources.push(built.source);
      solutions.push(built.solution);
    }
    return { ok: true, status: 'found', sources, solutions };
  } catch {
    // The only reachable refusals here are domain id/url/timestamp validations of values this module
    // already validated — plus an id that cannot be encoded. None of them may carry a value out.
    return failure('lid_unreadable', 'data.solutions.result[].lid');
  }
}

/**
 * Provenance note of one write-up: observed numeric state only.
 *
 * No title, no author value, no body, no viewer identity and no derived meaning: the capture explicitly
 * lists the `time` unit and the `category`/`status` numeric semantics as unverified, so they are
 * recorded as the numbers the platform reported and never interpreted (in particular, `time` is never
 * converted into a `publishedAt`). The attribution itself lives in `EditorialSource.author`, so the
 * note states only *that* the write-up carried an attributed public author — never the name.
 *
 * Every numeric member is present because {@link parseSolutionItem} refuses a write-up without one, so
 * the note of a stored write-up always carries the same fields.
 */
function sourceNote(item: ObservedSolution): string {
  return [
    'authenticated Luogu write-up',
    'author attributed',
    `time member ${String(item.time)} (unit unverified)`,
    `category ${String(item.category)}`,
    `status ${String(item.status)}`,
    `upvote ${String(item.upvote)}`,
    `replyCount ${String(item.replyCount)}`,
    `favorCount ${String(item.favorCount)}`,
  ].join('; ');
}

/**
 * The bounded index stored as one source's body: this write-up's identity, never its body.
 *
 * It is a real record of what the read returned, which is what a `found` source has to carry, and it
 * contains no write-up body. A long title is never truncated silently: the line is dropped and its
 * absence is stated, so a shortened index can never look complete.
 */
function sourceIndex(item: ObservedSolution): string {
  const line = `${item.lid}\t${item.title}\t${item.authorName}`;
  if (line.length > MAX_SOLUTION_INDEX_CHARS) {
    return `(${String(line.length)} character index entry omitted: it exceeds the stored index bound)`;
  }
  return line;
}

/**
 * Extract the hydration payload of one authenticated solution page, or `null`.
 *
 * The capture recorded the payload as the `#lentille-context` element with
 * `type="application/json"`, so both the id **and** that declared type are required: a script with the
 * same id but another (or no) type is not the hydration payload this build was written against, and
 * reading it anyway would mean parsing something whose meaning is unknown.
 *
 * The element's text is a **raw text** script body, not HTML markup: `&amp;`, `&lt;` and `&quot;`
 * inside it are literal characters of the JSON string, and decoding them would silently rewrite a
 * write-up's body (`a &amp;&amp; b` becoming `a && b` is a different solution text). The text is
 * therefore parsed exactly as it appears. A page without the element, or with an unparsable payload,
 * yields `null` so the caller can classify it as an unreadable response instead of concluding anything
 * about the editorial.
 */
export function lentilleContextPayload(html: string): unknown | null {
  const document = parseLuoguHtml(html);
  const element = findElementById(document, LENTILLE_CONTEXT_ELEMENT_ID);
  if (element === null) {
    return null;
  }
  const text = element.text;
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The declared type of the hydration element, exactly as the capture recorded it. */
export const LENTILLE_CONTEXT_TYPE = 'application/json';

/** One element's text, id and declared type, as the minimal reading of a page needs. */
interface MinimalElement {
  readonly id: string;
  readonly type: string;
  /** Raw element text, exactly as the document spells it. */
  readonly text: string;
}

function parseLuoguHtml(html: string): readonly MinimalElement[] {
  const elements: MinimalElement[] = [];
  // A deliberately small scan: the only thing this build reads out of a Luogu page is the hydration
  // element's own text, so a full DOM is not needed and a malformed document cannot crash it.
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? '';
    const id = attributeValue(attributes, 'id');
    if (id === null || id.length === 0) {
      continue;
    }
    // A script body is raw text: it is taken verbatim, never entity-decoded.
    elements.push({ id, type: attributeValue(attributes, 'type') ?? '', text: match[2] ?? '' });
  }
  return elements;
}

/**
 * One attribute value with either quote style, or `null` when the attribute is absent.
 *
 * The name must begin at the start of the attribute text or after HTML whitespace — **not** at a word
 * boundary inside a longer name. `\b` would treat `data-id="lentille-context"` as an `id` and
 * `data-type="application/json"` as a `type`, which would let a `data-*` attribute impersonate the
 * observed hydration element; anchoring on `(?:^|\s)` keeps `data-id`/`data-type` out. Attribute names
 * are still matched case-insensitively and with either quote style.
 */
function attributeValue(attributes: string, name: string): string | null {
  const doubleQuoted = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'iu').exec(attributes)?.[1];
  if (doubleQuoted !== undefined) {
    return doubleQuoted;
  }
  const singleQuoted = new RegExp(`(?:^|\\s)${name}\\s*=\\s*'([^']*)'`, 'iu').exec(attributes)?.[1];
  return singleQuoted ?? null;
}

/**
 * The one hydration element, or `null`.
 *
 * The id must match **and** the element must declare {@link LENTILLE_CONTEXT_TYPE}: the observed
 * surface is addressed by that pair, so a same-id script of another type is not the payload.
 */
function findElementById(elements: readonly MinimalElement[], id: string): MinimalElement | null {
  return (
    elements.find(
      (element) => element.id === id && element.type.trim().toLowerCase() === LENTILLE_CONTEXT_TYPE,
    ) ?? null
  );
}
