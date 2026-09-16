/**
 * Codeforces platform adapter.
 *
 * Official HTTPS `codeforces.com` only, one shared transport per source instance:
 * - `listProblems` reads the official problemset catalog (`/api/problemset.problems`) and pages
 *   it locally with a fingerprinted cursor, so a changed catalog is refused instead of silently
 *   skipping records. `cursor === null` always refreshes the metadata; a continuation reuses the
 *   cached snapshot only while it is fresh (bounded TTL) and otherwise re-fetches and re-checks
 *   the fingerprint. Catalog entries never carry a statement, and every index goes through the
 *   shared identity helpers (`20C`, `921D10`, numeric `921/01`), so an all-digit `92114` is never
 *   guessed apart.
 * - `fetchProblem` fetches the problem page and accepts only the identified `.problem-statement`
 *   node; a challenge page or a changed layout is `auth_required`/`changed_response`, never an
 *   empty statement. Only the main problemset is served: a gym reference is refused explicitly
 *   instead of being guessed into a main-problemset URL.
 * - `listSubmissions` reads `user.status` for one canonicalized public handle, requires the
 *   requested handle to appear in the author's member list, preserves missing or unknown verdicts
 *   as `unknown`, converts memory bytes to exact KiB, binds the `since` bound into the cursor, and
 *   re-checks its paging boundary on resume so offset drift from new submissions is detected
 *   instead of producing a gap.
 * - `fetchEditorial` uses a strictly validated Codeforces blog URL when the caller supplies one,
 *   otherwise the Tutorial link found on the problem page, and extracts only the target problem's
 *   section of a multi-problem blog. A missing or dead reference is `unavailable`; a body-declared
 *   call limit is `rate_limited`; an unrecognized API body is `changed_response`; this adapter
 *   never reports a proven editorial absence, because one page cannot prove it.
 */
import {
  validateOfficialRating,
  type OfficialRatingData,
  assertIsoTimestamp,
  contentHashOf,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  createSourceInstance,
  createSubmission,
  sha256Hex,
  sourceInstanceIdOf,
  type Account,
  type CancellationToken,
  type NormalizedProblem,
  type ProblemRef,
  type SourceInstance,
  type Submission,
  type SubmissionVerdict,
} from '../../domain/index.js';
import {
  DEFAULT_PLATFORM_LIMITS,
  type EditorialFetchResult,
  type FetchEditorialRequest,
  type FetchProblemRequest,
  type ListProblemsRequest,
  type ListSubmissionsRequest,
  type Page,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformLimits,
} from '../../application/ports.js';
import {
  PlatformError,
  editorialFailureFromPlatformError,
  isPlatformError,
  type PlatformOperation,
} from '../../application/platform-errors.js';
import { HttpTransport, type HttpLimits, type HttpTransportOptions } from '../platform/http.js';
import { createCodeforcesAccount, requireCodeforcesHandle } from './account.js';
import {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  requireCatalogCursor,
  requireCatalogOffset,
  requireSubmissionCursor,
} from './cursors.js';
import {
  extractDivisionHeadingReferences,
  extractEditorialSection,
  parseCodeforcesBlogUrl,
  type EditorialSection,
} from './editorial.js';
import { detectChallengePage, extractProblemPage, findTutorialBlogId, htmlToPlainText, parseHtml } from './html.js';
import { isTag, type AnyNode } from 'domhandler';
import {
  CF_EDITORIAL_ALIAS_RULE_VERSION,
  contestIdForDivision,
  contestsFormDivisionPair,
  divisionOfContestName,
  divisionReferenceKey,
  headingSpellingsFor,
  normalizeOfficialTitle,
  orderedContestIds,
  type CfContestFacts,
  type CfEditorialAlias,
} from './editorial-alias.js';
import {
  cfProblemExternalKey,
  cfSubmissionExternalKey,
  isOfficialCodeforcesHost,
  normalizeCfProblemIndex,
  officialProblemPaths,
  parseCfProblemKey,
  parseOfficialProblemPath,
} from './problem-index.js';

export const CODEFORCES_BASE_URL = 'https://codeforces.com';
/** Documented official minimum: at most one API request every two seconds. */
export const CODEFORCES_MIN_REQUEST_INTERVAL_MS = 2000;

const CATALOG_PATH = '/api/problemset.problems';
const USER_STATUS_PATH = '/api/user.status';
const BLOG_ENTRY_PATH = '/api/blogEntry.view';
const CONTEST_STANDINGS_PATH = '/api/contest.standings';
const CATALOG_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_LIMIT_VALUE = 10_000;
/**
 * Fixed request budget of one shared-round alias check.
 *
 * The check is strict on purpose: the blog may name at most {@link MAX_ALIAS_BLOG_CONTESTS} contests,
 * and at most {@link MAX_ALIAS_CONTEST_LOOKUPS} contest-metadata reads may happen before the attempt
 * is abandoned as an operational failure instead of continuing to spend the documented two-second
 * request interval. Reaching either bound is reported, never silently truncated into a weaker check.
 */
const MAX_ALIAS_BLOG_CONTESTS = 4;
const MAX_ALIAS_CONTEST_LOOKUPS = 4;
/** Candidate budget: a Div.1/Div.2 pair has exactly two divisions, so two candidates is the bound. */
const MAX_ALIAS_CANDIDATES = 2;
/** One contest metadata answer is small; the bound keeps a broken endpoint from streaming forever. */
const ALIAS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Official contest page paths that name a contest in a tutorial blog, bounded to the main set. */
const OFFICIAL_CONTEST_HREF = /^\/(?:contest|gym)\/(\d{1,7})(?:\/|$)/u;
/**
 * How long a catalog snapshot may serve a cursor continuation before it is re-fetched and its
 * fingerprint re-checked. Freshness is read from the injectable adapter clock.
 */
const CATALOG_SNAPSHOT_TTL_MS = 5 * 60_000;
/**
 * Bounded retry hint for a body-declared `Call limit exceeded` refusal. The body carries no
 * delay, so the documented minimum interval is reported instead of an invented wait.
 */
const RATE_LIMIT_RETRY_AFTER_MS = CODEFORCES_MIN_REQUEST_INTERVAL_MS;
const CALL_LIMIT_EXCEEDED = /call limit exceeded/iu;
const NOT_FOUND = /not found/iu;
/** Domains that address the main problemset (`main`/`problemset` are aliases of no domain). */
const MAIN_PROBLEM_DOMAINS: ReadonlySet<string> = new Set(['', 'main', 'problemset']);
const GYM_PROBLEM_DOMAIN = 'gym';

/**
 * One resolved editorial target: the section that was extracted, the problem it belongs to, and the
 * alias that justified the redirect (or `null` for a direct hit).
 */
interface ResolvedEditorialTarget {
  readonly section: EditorialSection;
  readonly target: ProblemTarget;
  readonly alias: CfEditorialAlias | null;
}

/** Canonical fetch target of one already-validated contest/index pair on this instance. */
function targetOf(contestId: number, index: string): ProblemTarget {
  const [contestPath, problemsetPath] = officialProblemPaths(contestId, index);
  return {
    contestId,
    index,
    domain: null,
    externalKey: cfProblemExternalKey(contestId, index),
    url: new URL(problemsetPath ?? contestPath ?? '', CODEFORCES_BASE_URL).toString(),
  };
}

/**
 * Stable provenance note of one shared-round redirect.
 *
 * It is written in a fixed `key=value;` form so the mapping can be audited (and later migrated)
 * without parsing prose, and it records *both* identities: what the user asked for and which section
 * actually answered. `statementHash` is deliberately absent — the fingerprint is verification
 * evidence, not something to persist.
 */
function aliasNote(alias: CfEditorialAlias, blogId: number, sectionKey: string): string {
  return (
    `${CF_EDITORIAL_ALIAS_RULE_VERSION}; requested=${alias.requestedKey}; section=${sectionKey}; ` +
    `blog=${blogId}; method=${alias.method}`
  );
}

/**
 * Official contest ids one tutorial blog names, or `null` when the answer is not a bounded pair.
 *
 * Only official `codeforces.com/contest/<id>` links are read, and the whole blog must name at most
 * {@link MAX_ALIAS_BLOG_CONTESTS} distinct main-problemset contests. A blog that names more contests
 * than that cannot yield the unique pair the rule requires, so the caller reports it instead of
 * pairing two of them. A foreign link is ignored entirely: it is never an identity source.
 */
function referencedContestIds(blogHtml: string): readonly number[] | null {
  const document = parseHtml(blogHtml);
  const ids: number[] = [];
  const walk = (nodes: readonly AnyNode[]): void => {
    for (const node of nodes) {
      if (!isTag(node)) {
        continue;
      }
      if (node.name.toLowerCase() === 'a') {
        const id = contestIdFromHref(node.attribs.href ?? '');
        if (id !== null && !ids.includes(id)) {
          ids.push(id);
        }
      }
      walk(node.children);
    }
  };
  walk(document.children);
  if (ids.length < 2 || ids.length > MAX_ALIAS_BLOG_CONTESTS) {
    return null;
  }
  return ids;
}

/** Contest id of one official `codeforces.com/contest/<id>` link, or `null` for anything else. */
function contestIdFromHref(href: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(href, CODEFORCES_BASE_URL);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.port !== '') {
    return null;
  }
  if (!isOfficialCodeforcesHost(parsed.hostname)) {
    return null;
  }
  const match = OFFICIAL_CONTEST_HREF.exec(parsed.pathname);
  if (match === null) {
    return null;
  }
  const contestId = Number(match[1]);
  return Number.isSafeInteger(contestId) && contestId > 0 ? contestId : null;
}

/**
 * The accepted heading spellings of one candidate, derived only from verified contest placement.
 *
 * `div. 1 D` is accepted for the candidate exactly when the *official name of the candidate's own
 * contest* declares Div. 1; the division is read, never computed from a letter offset. When both
 * contestants of the pair happen to declare the same division the heading is not unique, so it is
 * refused instead of being resolved by position.
 */
function aliasHeadingsFor(
  candidate: { readonly key: string; readonly index: string; readonly contestId: number },
  orderedPair: readonly CfContestFacts[],
  allContestFacts: readonly CfContestFacts[],
): readonly string[] {
  const declared = allContestFacts
    .filter((contest) => contest.contestId === candidate.contestId)
    .map((contest) => divisionOfContestName(contest.name))
    .filter((division): division is 1 | 2 => division !== null);
  if (declared.length !== 1) {
    return [];
  }
  const division = declared[0] as 1 | 2;
  const contestIds = orderedPair
    .filter((contest) => divisionOfContestName(contest.name) === division)
    .map((contest) => contest.contestId);
  if (contestIds.length !== 1 || contestIds[0] !== candidate.contestId) {
    return [];
  }
  return headingSpellingsFor({ division, index: candidate.index });
}

const VERDICT_MAP: Readonly<Record<string, SubmissionVerdict>> = {
  OK: 'accepted',
  WRONG_ANSWER: 'wrong_answer',
  TIME_LIMIT_EXCEEDED: 'time_limit_exceeded',
  MEMORY_LIMIT_EXCEEDED: 'memory_limit_exceeded',
  COMPILATION_ERROR: 'compile_error',
  PRESENTATION_ERROR: 'presentation_error',
  PARTIAL: 'partial',
  SKIPPED: 'skipped',
};

/** Map a CF verdict string; anything missing or unrecognized stays `unknown`. */
export function mapCodeforcesVerdict(value: unknown): SubmissionVerdict {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const key = value.trim().toUpperCase();
  if (key.startsWith('RUNTIME_ERROR')) {
    return 'runtime_error';
  }
  return VERDICT_MAP[key] ?? 'unknown';
}

/**
 * Exact bytes → KiB conversion (1 KiB = 1024 B), never rounded: a truncated memory figure would
 * silently misreport the submission. `null` when the platform did not report memory.
 */
export function memoryBytesToKib(value: number | null): number | null {
  return value === null ? null : value / 1024;
}

interface CatalogEntry {
  readonly contestId: number;
  readonly index: string;
  readonly name: string;
  readonly rating: number | null;
  readonly tags: readonly string[];
}

interface CatalogSnapshot {
  readonly fingerprint: string;
  readonly entries: readonly CatalogEntry[];
  readonly fetchedAt: string;
  /** Adapter-clock reading when this snapshot was fetched; drives the freshness TTL. */
  readonly fetchedAtMs: number;
}

interface ProblemTarget {
  readonly contestId: number;
  readonly index: string;
  readonly domain: string | null;
  readonly externalKey: string;
  readonly url: string;
}

interface CfSubmission {
  readonly externalId: string;
  readonly contestId: number;
  readonly problemIndex: string;
  readonly verdict: SubmissionVerdict;
  readonly submittedAt: string;
  readonly language: string | null;
  readonly timeMs: number | null;
  readonly memoryKb: number | null;
}

interface BlogEntry {
  readonly id: number;
  readonly title: string;
  readonly content: string;
  readonly authorHandle: string | null;
  readonly locale: string | null;
  readonly publishedAt: string | null;
}

function invalidInput(operation: PlatformOperation, detail: string): PlatformError {
  return new PlatformError({ code: 'invalid_input', operation, retryable: false, detail });
}

function payloadError(operation: PlatformOperation, detail: string): PlatformError {
  return new PlatformError({ code: 'changed_response', operation, retryable: false, detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string, operation: PlatformOperation): Record<string, unknown> {
  if (!isRecord(value)) {
    throw payloadError(operation, `${label} must be a JSON object`);
  }
  return value;
}

function requireArray(value: unknown, label: string, operation: PlatformOperation): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw payloadError(operation, `${label} must be a JSON array`);
  }
  return value;
}

function requireString(value: unknown, label: string, operation: PlatformOperation): string {
  if (typeof value !== 'string') {
    throw payloadError(operation, `${label} must be a string`);
  }
  return value;
}

function requireNumber(value: unknown, label: string, operation: PlatformOperation): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw payloadError(operation, `${label} must be a finite number`);
  }
  return value;
}

/**
 * A counter/byte/timestamp field: rejects a numeric string, a fraction, `NaN`/`Infinity` and a
 * value beyond `Number.MAX_SAFE_INTEGER` instead of coercing it into a plausible-looking number.
 */
function requireSafeCount(value: unknown, label: string, operation: PlatformOperation): number {
  const number = requireNumber(value, label, operation);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw payloadError(operation, `${label} must be a non-negative safe integer`);
  }
  return number;
}

function parseJson(body: string, operation: PlatformOperation, label: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    throw payloadError(operation, `${label} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}

/** Best-effort JSON object, for bodies of accepted error statuses that may not be JSON at all. */
function parseJsonRecordOrNull(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    // Tolerated here only to classify an already-failed request; the caller never treats the
    // result as success.
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** The `comment` field of an API body, trimmed; empty when absent or not a string. */
function apiComment(root: Record<string, unknown>): string {
  const comment = root.comment;
  return typeof comment === 'string' ? comment.trim() : '';
}

/**
 * Classify a failed Codeforces API body (HTTP 400 or `status !== "OK"`).
 *
 * Codeforces reuses HTTP 400 for a caller-quota refusal and for a missing resource, so the
 * `comment` is the only signal available: a quota refusal stays `rate_limited` (never `absent` or
 * a plain `unavailable`), a proven missing reference stays `unavailable`, and an unrecognized or
 * unparseable body is `changed_response` rather than a guess. Only the sanitized comment reaches
 * the error, never the body.
 */
function apiFailure(
  operation: PlatformOperation,
  context: string,
  httpStatus: number,
  root: Record<string, unknown> | null,
): PlatformError {
  const comment = root === null ? '' : apiComment(root);
  const status = root !== null && typeof root.status === 'string' ? root.status : `HTTP ${httpStatus}`;
  const detail = `${context} answered ${status}${comment.length > 0 ? ` (${comment})` : ''}`;
  if (CALL_LIMIT_EXCEEDED.test(comment)) {
    return new PlatformError({
      code: 'rate_limited',
      operation,
      retryable: true,
      retryAfterMs: RATE_LIMIT_RETRY_AFTER_MS,
      detail,
    });
  }
  if (NOT_FOUND.test(comment)) {
    return new PlatformError({ code: 'unavailable', operation, retryable: false, detail });
  }
  return new PlatformError({
    code: 'changed_response',
    operation,
    retryable: false,
    detail,
    sample: comment.length > 0 ? comment : `HTTP ${httpStatus}`,
  });
}

function requireLimit(value: number, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidInput('catalog', `${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requirePageLimit(limit: number, limits: PlatformLimits, operation: PlatformOperation): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limits.pageSize < limit) {
    throw invalidInput(operation, `limit must be an integer in [1, ${limits.pageSize}]`);
  }
  return limit;
}

/** Unix seconds → normalized ISO; a fraction, a negative or an unrepresentable value is refused. */
function isoFromSeconds(value: unknown, label: string, operation: PlatformOperation): string {
  const seconds = requireSafeCount(value, label, operation);
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw payloadError(operation, `${label} is not a valid unix timestamp`);
  }
  return date.toISOString();
}

/**
 * True when a reference names a gym problemset, either through its explicit domain or through an
 * official gym URL. Gym support is a v1 non-goal, and guessing a main-problemset URL for a gym
 * problem would silently import the wrong problem, so the reference is refused instead.
 */
function isGymReference(rawKey: string, domain: string): boolean {
  if (domain === GYM_PROBLEM_DOMAIN) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawKey, CODEFORCES_BASE_URL);
  } catch {
    // Not a URL at all: the canonical-key path reports it.
    return false;
  }
  return isOfficialCodeforcesHost(parsed.hostname) && parsed.pathname.startsWith('/gym/');
}

/**
 * Resolve one problem reference into its canonical identity and official fetch target.
 *
 * The reference may name the problem with the canonical key (`20C`, `921D10`, numeric `921/01`)
 * or with an official Codeforces problem href/path, which is accepted as an *identity reference*
 * only: the fetch target is always rebuilt from the two identity components on this adapter's own
 * origin, so a caller-supplied URL never becomes a transport target. Gym references are refused
 * with an actionable message instead of being guessed into a main-problemset URL.
 */
function parseProblemTarget(ref: ProblemRef, instance: SourceInstance, operation: PlatformOperation): ProblemTarget {
  if (ref.sourceInstanceId !== instance.id) {
    throw invalidInput(operation, 'the problem reference belongs to another source instance');
  }
  const rawKey = typeof ref.externalKey === 'string' ? ref.externalKey.trim() : '';
  const domain = (ref.domain ?? '').trim().toLowerCase();
  if (isGymReference(rawKey, domain)) {
    throw invalidInput(
      operation,
      'this v1 adapter serves only the main Codeforces problemset; a gym problemset is not supported, ' +
        'so the reference was refused instead of being fetched from a guessed URL',
    );
  }
  if (!MAIN_PROBLEM_DOMAINS.has(domain)) {
    throw invalidInput(
      operation,
      `unsupported Codeforces problem domain ${JSON.stringify(ref.domain)}; only the main problemset is supported`,
    );
  }
  const parts = parseCfProblemKey(rawKey) ?? parseOfficialProblemPath(rawKey);
  if (parts === null) {
    throw invalidInput(
      operation,
      'Codeforces problem key must be <contestId><index> (a letter with an optional numeric suffix, ' +
        'or 1-3 digits, e.g. 20C, 921D10, 921/01) or an official codeforces.com problem URL, ' +
        `got ${JSON.stringify(ref.externalKey)}`,
    );
  }
  const index = normalizeCfProblemIndex(parts.index);
  if (index === null) {
    throw invalidInput(operation, `Codeforces problem index ${JSON.stringify(parts.index)} is not usable`);
  }
  const [contestPath, problemsetPath] = officialProblemPaths(parts.contestId, index);
  return {
    contestId: parts.contestId,
    index,
    domain: null,
    externalKey: cfProblemExternalKey(parts.contestId, index),
    url: new URL(problemsetPath ?? contestPath ?? '', instance.baseUrl).toString(),
  };
}

/** Normalize the optional `since` bound; `null` when absent. */
function parseSince(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return assertIsoTimestamp('since', value);
  } catch (cause) {
    throw invalidInput(
      'submissions',
      `since must be an ISO timestamp (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
}

/**
 * Localized lowercase handles of a submission author, or `null` for a malformed author.
 *
 * A submission belongs to an account only when the requested handle is one of the members, so a
 * team submission counts while a foreign or anonymous record never does.
 */
function authorHandles(author: unknown): readonly string[] | null {
  if (!isRecord(author)) {
    return null;
  }
  const members = author.members;
  if (!Array.isArray(members) || members.length === 0) {
    return null;
  }
  const handles: string[] = [];
  for (const member of members) {
    if (!isRecord(member) || typeof member.handle !== 'string' || member.handle.trim().length === 0) {
      return null;
    }
    handles.push(member.handle.trim().toLowerCase());
  }
  return handles;
}

/** Author handle of a blog entry: `author.handle`, a plain string `author`, or `authorHandle`. */
function authorOf(result: Record<string, unknown>): string | null {
  const author = result.author;
  if (typeof author === 'string' && author.trim().length > 0) {
    return author.trim();
  }
  if (isRecord(author) && typeof author.handle === 'string' && author.handle.trim().length > 0) {
    return author.handle.trim();
  }
  const handle = result.authorHandle;
  return typeof handle === 'string' && handle.trim().length > 0 ? handle.trim() : null;
}

/**
 * Blog title as plain text.
 *
 * Codeforces returns the title as an HTML fragment (`<p>Round #244 Editorial</p>`), so it is
 * converted with the shared {@link htmlToPlainText} helper instead of being stored with markup; an
 * explicit `titleHTML` field wins over `title` when both are present. A blog without a usable
 * title is a changed response, never a fabricated placeholder.
 */
function blogTitleOf(result: Record<string, unknown>, blogId: number): string {
  const htmlTitle = result.titleHTML;
  const raw = typeof htmlTitle === 'string' && htmlTitle.trim().length > 0 ? htmlTitle : result.title;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw payloadError('editorial', `blog ${blogId} has no usable title`);
  }
  const title = htmlToPlainText(raw).trim();
  if (title.length === 0) {
    throw payloadError('editorial', `blog ${blogId} has an empty title`);
  }
  return title;
}

/** Blog locale as reported by the API, or `null`. */
function localeOf(result: Record<string, unknown>): string | null {
  const locale = result.locale;
  return typeof locale === 'string' && locale.trim().length > 0 ? locale.trim() : null;
}

/**
 * Validate an account with the adapter's own canonical factory and re-label the failure with the
 * operation that was actually attempted.
 */
function requireAccountHandle(instance: SourceInstance, account: Account, operation: PlatformOperation): string {
  try {
    return requireCodeforcesHandle(instance, account);
  } catch (error) {
    if (isPlatformError(error) && error.code === 'invalid_input') {
      throw invalidInput(operation, error.detail);
    }
    throw error;
  }
}

export interface CodeforcesAdapterOptions {
  /** Defaults to the official `https://codeforces.com` instance. */
  readonly sourceInstance?: SourceInstance;
  /** Composition defaults; every request still carries its own explicit limits. */
  readonly limits?: PlatformLimits;
  /** A pre-built transport, shared by every operation of this adapter. */
  readonly transport?: HttpTransport;
  /** Transport options; `origin` and the documented 2000 ms floor are always enforced. */
  readonly http?: Omit<HttpTransportOptions, 'origin'>;
  /** Injectable millisecond clock for catalog freshness; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Catalog snapshot lifetime in milliseconds; defaults to {@link CATALOG_SNAPSHOT_TTL_MS}. */
  readonly catalogSnapshotTtlMs?: number;
}

/** The official Codeforces source instance. */
export function codeforcesSourceInstance(baseUrl: string = CODEFORCES_BASE_URL): SourceInstance {
  return createSourceInstance({ platform: 'codeforces', baseUrl, displayName: 'Codeforces' });
}

/** Build a Codeforces adapter; the returned instance owns exactly one shared transport. */
export function createCodeforcesAdapter(options: CodeforcesAdapterOptions = {}): PlatformAdapter {
  return new CodeforcesAdapter(options);
}

export class CodeforcesAdapter implements PlatformAdapter {
  readonly sourceInstance: SourceInstance;
  private readonly limits: PlatformLimits;
  private readonly transport: HttpTransport;
  private readonly clock: () => number;
  private readonly catalogSnapshotTtlMs: number;
  private catalogSnapshot: CatalogSnapshot | null = null;

  constructor(options: CodeforcesAdapterOptions = {}) {
    this.sourceInstance = options.sourceInstance ?? codeforcesSourceInstance();
    const base = new URL(this.sourceInstance.baseUrl);
    if (this.sourceInstance.platform !== 'codeforces') {
      throw invalidInput('catalog', `source instance platform must be codeforces, got ${this.sourceInstance.platform}`);
    }
    if (
      base.protocol !== 'https:' ||
      base.hostname !== 'codeforces.com' ||
      base.port !== '' ||
      base.pathname !== '/' ||
      base.search !== '' ||
      base.hash !== '' ||
      base.username.length > 0 ||
      base.password.length > 0
    ) {
      throw invalidInput('catalog', `the Codeforces adapter only serves https://codeforces.com, got ${base.origin}`);
    }
    // The instance id must be the one its own platform and domain derive, and the domain must be
    // the host actually fetched: otherwise a cursor or problem reference could be scoped to an
    // instance that no longer names this origin.
    const domain = this.sourceInstance.domain;
    if (
      typeof domain !== 'string' ||
      domain.length === 0 ||
      domain !== base.hostname.toLowerCase() ||
      sourceInstanceIdOf('codeforces', domain) !== this.sourceInstance.id
    ) {
      throw invalidInput(
        'catalog',
        `the source instance id ${JSON.stringify(this.sourceInstance.id)} is not coherent with its platform ` +
          `and domain ${JSON.stringify(this.sourceInstance.domain)} for ${base.origin}`,
      );
    }
    // Detached copy: a caller that later mutates the object it passed cannot change this
    // adapter's defaults.
    this.limits = { ...(options.limits ?? DEFAULT_PLATFORM_LIMITS) };
    this.requireLimits(this.limits);
    this.clock = options.clock ?? Date.now;
    this.catalogSnapshotTtlMs = options.catalogSnapshotTtlMs ?? CATALOG_SNAPSHOT_TTL_MS;
    if (!Number.isFinite(this.catalogSnapshotTtlMs) || this.catalogSnapshotTtlMs < 0) {
      throw invalidInput('catalog', 'catalogSnapshotTtlMs must be a non-negative finite number of milliseconds');
    }
    if (options.transport !== undefined && options.transport.origin !== CODEFORCES_BASE_URL) {
      throw invalidInput(
        'catalog',
        `the shared transport must be bound to ${CODEFORCES_BASE_URL}, got ${options.transport.origin}`,
      );
    }
    this.transport =
      options.transport ??
      new HttpTransport({
        // `http` may tune the transport, but never the official origin or the documented floor.
        ...options.http,
        origin: CODEFORCES_BASE_URL,
        minRequestIntervalMs: this.limits.minRequestIntervalMs,
        requestTimeoutMs: this.limits.requestTimeoutMs,
        maxRetries: this.limits.maxRetries,
        platformMinRequestIntervalMs: Math.max(
          options.http?.platformMinRequestIntervalMs ?? 0,
          CODEFORCES_MIN_REQUEST_INTERVAL_MS,
        ),
      });
  }

  capabilities(): PlatformCapabilities {
    return {
      platform: 'codeforces',
      implemented: true,
      problems: true,
      submissions: true,
      editorial: true,
      pagedProblems: true,
      pagedSubmissions: true,
      requiresAuth: false,
      supportsAccountHistory: true,
      minRequestIntervalMs: CODEFORCES_MIN_REQUEST_INTERVAL_MS,
      notes: [
        'Statements come from the official problem page; the JSON catalog never contains one.',
        'Editorials come from blogEntry.view for a Tutorial link; a missing or dead reference is unavailable, never a proven absence.',
        'One request per two seconds, retries included, shared by every operation of this instance.',
        'Only the main problemset is served: numeric indexes keep their separator (921/01 is not 92114) and a gym problemset reference is refused explicitly instead of being guessed.',
      ],
    };
  }

  /** Build the canonical account for a public handle (case-insensitive identity). */
  account(handle: string, displayName?: string | null): Account {
    return createCodeforcesAccount(this.sourceInstance, handle, displayName);
  }

  async listProblems(request: ListProblemsRequest): Promise<Page<NormalizedProblem>> {
    const limits = this.requireLimits(request.limits);
    const limit = requirePageLimit(request.limit, limits, 'catalog');
    const account = request.account ?? null;
    if (account !== null) {
      // The optional catalog scope must be a canonical account of this very instance; a foreign
      // or hand-built one would silently produce cursors no other call can resume.
      requireAccountHandle(this.sourceInstance, account, 'catalog');
    }
    const accountId = account?.id ?? null;
    const cursor = request.cursor === null ? null : requireCatalogCursor(decodeCursor(request.cursor), {
      sourceInstanceId: this.sourceInstance.id,
      accountId,
    });
    const snapshot = await this.loadCatalog(request.token, limits, cursor?.fingerprint ?? null);
    if (cursor !== null && cursor.fingerprint !== snapshot.fingerprint) {
      throw new PlatformError({
        code: 'changed_response',
        operation: 'catalog',
        retryable: false,
        detail: 'the Codeforces catalog changed since this cursor was issued; restart from the first page',
        sample: `cursor ${cursor.fingerprint.slice(0, 12)}..., now ${snapshot.fingerprint.slice(0, 12)}...`,
      });
    }
    let offset = 0;
    if (cursor !== null) {
      requireCatalogOffset(cursor, snapshot.entries.length);
      offset = cursor.offset;
    }
    const items = snapshot.entries.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor =
      nextOffset < snapshot.entries.length
        ? encodeCursor({
            version: CURSOR_VERSION,
            sourceInstanceId: this.sourceInstance.id,
            resource: 'catalog',
            accountId,
            fingerprint: snapshot.fingerprint,
            offset: nextOffset,
          })
        : null;
    request.token.throwIfCancelled();
    return {
      items: items.map((entry) => this.normalizeCatalogEntry(entry, snapshot.fetchedAt)),
      nextCursor,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async fetchProblem(request: FetchProblemRequest): Promise<NormalizedProblem> {
    request.token.throwIfCancelled();
    const limits = this.requireLimits(request.limits);
    const target = parseProblemTarget(request.problemRef, this.sourceInstance, 'statement');
    const html = await this.fetchOfficialHtml(target.url, request.token, limits, 'statement');
    const parsed = extractProblemPage(html);
    if (!parsed.ok) {
      throw new PlatformError({
        code: 'changed_response',
        operation: 'statement',
        retryable: false,
        detail: parsed.detail,
        sample: parsed.sample,
      });
    }
    request.token.throwIfCancelled();
    return createNormalizedProblem({
      ref: { sourceInstanceId: this.sourceInstance.id, domain: target.domain, externalKey: target.externalKey },
      title: parsed.page.title,
      url: target.url,
      statement: parsed.page.statement,
      ratings: this.ratingOf(parsed.page.rating),
      rawTags: parsed.page.rawTags,
      fetchedAt: new Date().toISOString(),
    });
  }

  /** Fetch a coherent official profile and complete contest history using the shared limiter. */
  async fetchOfficialRating(request: { readonly account: Account; readonly token: CancellationToken; readonly limits: PlatformLimits }): Promise<OfficialRatingData> {
    const limits = this.requireLimits(request.limits);
    const handle = requireAccountHandle(this.sourceInstance, request.account, 'rating');
    const fetchRows = async (path: string) => {
      const response = await this.transport.request(path, { token: request.token, operation: 'rating', acceptStatuses: [400], limits: this.httpLimits(limits) });
      if (response.status === 400) throw apiFailure('rating', 'official rating', response.status, parseJsonRecordOrNull(response.body));
      const root = requireRecord(parseJson(response.body, 'rating', 'official rating'), 'official rating', 'rating');
      if (root.status !== 'OK') throw apiFailure('rating', 'official rating', response.status, root);
      return requireArray(root.result, 'rating result', 'rating');
    };
    const profiles = await fetchRows('/api/user.info?' + new URLSearchParams({ handles: handle, checkHistoricHandles: 'false' }).toString());
    if (profiles.length !== 1) throw payloadError('rating', 'expected one account profile');
    const profile = requireRecord(profiles[0], 'profile', 'rating');
    const checkHandle = (value: unknown) => {
      if (typeof value !== 'string' || value.toLowerCase() !== handle.toLowerCase()) throw payloadError('rating', 'official response belongs to another handle');
    };
    checkHandle(profile.handle);
    const rows = await fetchRows('/api/user.rating?' + new URLSearchParams({ handle }).toString());
    if (rows.length > 10000) throw payloadError('rating', 'rating history exceeds the supported bound');
    const history = rows.map(raw => {
      const row = requireRecord(raw, 'rating change', 'rating'); checkHandle(row.handle);
      const seconds = requireSafeCount(row.ratingUpdateTimeSeconds, 'rating timestamp', 'rating');
      if (!Number.isFinite(new Date(seconds * 1000).getTime())) throw payloadError('rating', 'invalid rating timestamp');
      return { contestId: row.contestId, contestName: row.contestName, rank: row.rank, ratedAt: new Date(seconds * 1000).toISOString(), oldRating: row.oldRating, newRating: row.newRating };
    });
    request.token.throwIfCancelled();
    try {
      const { revision: _revision, ...data } = validateOfficialRating({ accountId: request.account.id, revision: 1, source: 'codeforces_api', fetchedAt: new Date(this.clock()).toISOString(), rating: profile.rating ?? null, maxRating: profile.maxRating ?? null, history });
      return data;
    } catch { throw payloadError('rating', 'invalid or inconsistent profile/rating history; refresh again'); }
  }

  async listSubmissions(request: ListSubmissionsRequest): Promise<Page<Submission>> {
    const limits = this.requireLimits(request.limits);
    const limit = requirePageLimit(request.limit, limits, 'submissions');
    const handle = requireAccountHandle(this.sourceInstance, request.account, 'submissions');
    const since = parseSince(request.since);
    const cursor = request.cursor === null ? null : requireSubmissionCursor(decodeCursor(request.cursor), {
      sourceInstanceId: this.sourceInstance.id,
      accountId: request.account.id,
    });
    if (cursor !== null) {
      if (cursor.handle !== handle) {
        throw invalidInput('submissions', 'cursor belongs to another handle');
      }
      if (cursor.since !== since) {
        // The delivered window depends on the bound, so resuming with another one would silently
        // change which submissions the page was supposed to contain.
        throw invalidInput('submissions', 'cursor was issued for a different since bound; restart from the first page');
      }
    }
    // A resume starts *at* the previously delivered boundary, so the boundary can be verified
    // before any new record is accepted. New submissions shift plain offsets; the check turns
    // that drift into an explicit restart instead of a gap.
    const fromIndex = cursor === null ? 1 : cursor.returned;
    // On resume the first fetched record is the boundary itself, so one extra record is needed
    // to decide whether more pages exist beyond this one.
    const fetchCount = cursor === null ? limit + 1 : limit + 2;
    const fetched = await this.fetchUserStatus(handle, fromIndex, fetchCount, request.token, limits);
    let items = fetched;
    if (cursor !== null) {
      const boundary = fetched[0];
      if (boundary === undefined || boundary.externalId !== cursor.boundaryId) {
        throw new PlatformError({
          code: 'changed_response',
          operation: 'submissions',
          retryable: false,
          detail: 'the submission list shifted since this cursor was issued; restart from the first page',
          sample:
            boundary === undefined
              ? `boundary submission ${cursor.boundaryId ?? '?'} is gone`
              : `expected ${cursor.boundaryId ?? '?'}, found ${boundary.externalId}`,
        });
      }
      items = fetched.slice(1);
    }
    let hasMore = items.length > limit;
    let selected = items.slice(0, limit);
    if (since !== null) {
      const sinceMs = Date.parse(since);
      const kept: CfSubmission[] = [];
      for (const item of selected) {
        if (Date.parse(item.submittedAt) >= sinceMs) {
          kept.push(item);
        } else {
          hasMore = false;
          break;
        }
      }
      selected = kept;
    }
    const last = selected[selected.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor({
            version: CURSOR_VERSION,
            sourceInstanceId: this.sourceInstance.id,
            resource: 'submissions',
            accountId: request.account.id,
            handle,
            returned: (cursor?.returned ?? 0) + selected.length,
            boundaryId: last.externalId,
            since,
          })
        : null;
    request.token.throwIfCancelled();
    return {
      items: selected.map((item) => this.normalizeSubmission(item, request.account)),
      nextCursor,
      fetchedAt: new Date().toISOString(),
    };
  }

  async fetchEditorial(request: FetchEditorialRequest): Promise<EditorialFetchResult> {
    try {
      request.token.throwIfCancelled();
      const limits = this.requireLimits(request.limits);
      const target = parseProblemTarget(request.problemRef, this.sourceInstance, 'editorial');
      const supplied = request.officialTutorialUrl ?? null;
      let blogId: number;
      let problemPageHtml: string | null = null;
      if (supplied !== null) {
        // Strictly validated before any request, so a caller-supplied URL never becomes an
        // arbitrary fetch target.
        blogId = parseCodeforcesBlogUrl(supplied);
      } else {
        problemPageHtml = await this.fetchOfficialHtml(target.url, request.token, limits, 'editorial');
        const discovered = findTutorialBlogId(problemPageHtml);
        if (discovered === null) {
          // The problem page simply does not link a tutorial: discovery is incomplete, which is
          // not proof that no editorial exists anywhere.
          request.token.throwIfCancelled();
          return {
            status: 'unavailable',
            detail: 'the problem page has no Tutorial link; editorial discovery is incomplete, so absence is not proven',
            retryable: false,
          };
        }
        blogId = discovered;
      }
      const blog = await this.fetchBlogEntry(blogId, request.token, limits);
      const section = extractEditorialSection(blog.content, target);

      if (!section.ok && section.reason === 'missing') {
        // The section that was asked for is not in the blog at all. A shared Div.1/Div.2 round may
        // still hold it under the other division's key, so the alias path runs: it is a bounded,
        // evidence-only redirect, and every clause below must hold before anything is accepted.
        // `ambiguous` and `empty` deliberately never reach it — those describe a section that *was*
        // found, and a redirect must not paper over them.
        const aliased = await this.resolveSharedRoundAlias({
          requested: target,
          blogId,
          blogIdContent: blog.content,
          problemPageHtml,
          token: request.token,
          limits,
        });
        if (aliased !== null) {
          return this.adoptedEditorial(blog, aliased, target);
        }
      }

      if (!section.ok) {
        throw new PlatformError({
          code: 'changed_response',
          operation: 'editorial',
          retryable: false,
          detail: `blog ${blog.id}: ${section.detail} (${section.reason})`,
          sample: section.sample,
        });
      }
      return this.adoptedEditorial(blog, { section, target, alias: null }, target);
    } catch (error) {
      if (isPlatformError(error)) {
        return editorialFailureFromPlatformError(error);
      }
      throw error;
    }
  }

  /**
   * One optional shared-round alias: the verified redirect plus the target it resolves to.
   *
   * The evidence is kept only long enough to describe the source that is stored; the statement hash
   * never leaves this adapter (it is compared, then dropped), and the alias object itself is not
   * projected to any API, log or UI.
   */
  private async resolveSharedRoundAlias(args: {
    readonly requested: ProblemTarget;
    readonly blogId: number;
    readonly blogIdContent: string;
    /** The requested problem's page, when the blog was discovered from it rather than supplied. */
    readonly problemPageHtml: string | null;
    readonly token: CancellationToken;
    readonly limits: PlatformLimits;
  }): Promise<ResolvedEditorialTarget | null> {
    const { requested, blogId, token, limits } = args;
    try {
      // (1) The requested problem's own page must link this blog. When the caller supplied the
      // tutorial URL, the page was never fetched, so it is fetched here and the link is proven
      // before anything else is consulted.
      let requestedPageHtml = args.problemPageHtml;
      if (requestedPageHtml === null) {
        requestedPageHtml = await this.fetchOfficialHtml(requested.url, token, limits, 'editorial');
      }
      const requestedTutorial = findTutorialBlogId(requestedPageHtml);
      token.throwIfCancelled();
      if (requestedTutorial !== blogId) {
        return null;
      }
      const requestedPage = extractProblemPage(requestedPageHtml);
      if (!requestedPage.ok) {
        return null;
      }

      // (2) The tutorial blog must name exactly one official Div.1/Div.2 contest pair.
      const referenced = referencedContestIds(args.blogIdContent);
      if (referenced === null) {
        return null;
      }
      const contestFacts: CfContestFacts[] = [];
      for (const contestId of referenced) {
        const facts = await this.fetchContestFacts(contestId, token, limits);
        if (facts === null) {
          return null;
        }
        contestFacts.push(facts);
      }
      token.throwIfCancelled();

      // (3) and (4) One round, two divisions: identical start time and duration, and the same core
      // name once the canonical `(Div. N)` marker is removed. Inspect every bounded combination:
      // choosing the first match would silently accept an ambiguous blog that names two shared
      // rounds. The one proven pair must also contain the problem the caller actually requested.
      const pairs: Array<readonly [CfContestFacts, CfContestFacts]> = [];
      for (let left = 0; left < contestFacts.length; left += 1) {
        for (let right = left + 1; right < contestFacts.length; right += 1) {
          const first = contestFacts[left] as CfContestFacts;
          const second = contestFacts[right] as CfContestFacts;
          if (contestsFormDivisionPair(first, second)) {
            pairs.push([first, second]);
          }
        }
      }
      if (pairs.length !== 1) {
        return null;
      }
      const orderedPair: readonly CfContestFacts[] = pairs[0] as readonly CfContestFacts[];
      const pairDivisions = new Set(orderedPair.map((contest) => divisionOfContestName(contest.name)));
      if (
        pairDivisions.size !== 2 ||
        pairDivisions.has(null) ||
        !orderedPair.some((contest) => contest.contestId === requested.contestId)
      ) {
        return null;
      }

      // The heading is the only source of the candidate's identity. A relative heading names the
      // contest *by division* and the problem *by its own index*, so the candidate is that division's
      // contest with that index — carrying the requested index across divisions would be the very
      // letter-offset assumption this rule forbids, and it would look for a problem that need not
      // exist. Every reference the heading lists is tried, and the count is bounded.
      const headingReferences = extractDivisionHeadingReferences(args.blogIdContent);
      if (headingReferences === null) {
        return null;
      }
      interface Candidate {
        readonly key: string;
        readonly index: string;
        readonly contestId: number;
      }
      const candidates: Candidate[] = [];
      const seenKeys = new Set<string>();
      for (const reference of headingReferences) {
        const contestId = contestIdForDivision(orderedPair, reference.division);
        if (contestId === null) {
          continue;
        }
        const key = divisionReferenceKey(reference, contestId);
        // A relative heading on the requested contest can identify only the requested index. A
        // different index in that same contest is a different problem, not a cross-division alias.
        if (
          key === null ||
          (contestId === requested.contestId && reference.index !== requested.index) ||
          seenKeys.has(key)
        ) {
          continue;
        }
        seenKeys.add(key);
        candidates.push({ key, index: reference.index, contestId });
      }
      if (candidates.length === 0 || candidates.length > MAX_ALIAS_CANDIDATES) {
        return null;
      }

      const requestedTitle = normalizeOfficialTitle(requestedPage.page.title);
      const requestedHash = this.statementFingerprint(requestedPage.page.intrinsicStatement);
      const accepted: { readonly candidate: Candidate; readonly section: EditorialSection }[] = [];
      for (const candidate of candidates) {
        const acceptedCandidate = await this.verifyAliasCandidate({
          candidate,
          requested,
          blogId,
          orderedPair,
          requestedTitle,
          requestedHash,
          allContestFacts: contestFacts,
          blogContent: args.blogIdContent,
          token,
          limits,
        });
        if (acceptedCandidate !== null) {
          accepted.push({ candidate, section: acceptedCandidate });
        }
      }
      token.throwIfCancelled();
      // (9) Exactly one candidate may hold.
      if (accepted.length !== 1) {
        return null;
      }
      const winner = accepted[0] as { readonly candidate: Candidate; readonly section: EditorialSection };
      return {
        section: winner.section,
        target: targetOf(winner.candidate.contestId, winner.candidate.index),
        alias: {
          requestedKey: cfProblemExternalKey(requested.contestId, requested.index),
          sectionKey: winner.candidate.key,
          blogId,
          pairedContestIds: orderedContestIds(orderedPair),
          method: 'official_division_pair',
          ruleVersion: CF_EDITORIAL_ALIAS_RULE_VERSION,
          evidenceHash: requestedHash,
        },
      };
    } catch (error) {
      // Evidence that does not prove the mapping returns `null` at the clause that rejected it.
      // A thrown error is operational (transport, parsing, cancellation, or invalid input) and must
      // keep its typed meaning; rewriting it as a later "missing section" would give the caller the
      // wrong recovery action and would make cancellation look like a platform response.
      throw error;
    }
  }

  /**
   * Verify one candidate of a shared round, or refuse it.
   *
   * Every clause is official evidence; the candidate is accepted only when all of them hold:
   * its page links the same tutorial blog, its official title equals the requested title exactly
   * (NFC plus whitespace folding — never a fuzzy or case-insensitive comparison), its normalized
   * statement fingerprint equals the requested one, and re-extracting the section under the
   * candidate's own key yields exactly one non-empty section.
   */
  private async verifyAliasCandidate(args: {
    readonly candidate: { readonly key: string; readonly index: string; readonly contestId: number };
    readonly requested: ProblemTarget;
    readonly blogId: number;
    readonly orderedPair: readonly CfContestFacts[];
    readonly requestedTitle: string;
    readonly requestedHash: string;
    readonly allContestFacts: readonly CfContestFacts[];
    readonly blogContent: string;
    readonly token: CancellationToken;
    readonly limits: PlatformLimits;
  }): Promise<EditorialSection | null> {
    const { candidate, token, limits } = args;
    const candidateTarget = targetOf(candidate.contestId, candidate.index);
    const isRequested =
      candidate.contestId === args.requested.contestId && candidate.index === args.requested.index;
    if (!isRequested) {
      const candidateHtml = await this.fetchOfficialHtml(candidateTarget.url, token, limits, 'editorial');
      token.throwIfCancelled();
      const candidatePage = extractProblemPage(candidateHtml);
      if (!candidatePage.ok) {
        return null;
      }
      // (8) The candidate must link the same blog.
      if (candidatePage.page.tutorialBlogId !== args.blogId) {
        return null;
      }
      // (6) Identical official titles under the same language, exactly.
      if (normalizeOfficialTitle(candidatePage.page.title) !== args.requestedTitle) {
        return null;
      }
      // (7) Identical normalized statements. A round whose divisions really do differ in a
      // constraint or a sample produces a different fingerprint here and is refused.
      if (this.statementFingerprint(candidatePage.page.intrinsicStatement) !== args.requestedHash) {
        return null;
      }
    }
    // (5) The division pair must place the candidate's *contest* at the division the heading names;
    // the accepted heading spellings are derived from that verified placement only.
    const headings = aliasHeadingsFor(candidate, args.orderedPair, args.allContestFacts);
    if (headings.length === 0) {
      return null;
    }
    // (10) Re-extract under the candidate's own key through the verified headings. It must be unique
    // and carry body text; anything else leaves the request as `missing`.
    const section = extractEditorialSection(args.blogContent, candidateTarget, [
      { contestId: candidate.contestId, index: candidate.index, externalKey: candidate.key, headings },
    ]);
    return section.ok && section.sectionKey === candidate.key ? section : null;
  }

  /**
   * Normalized fingerprint of one statement, for internal comparison only.
   *
   * NFC plus whitespace folding of the statement *body* — the title, limits and tags were already
   * removed while the page was parsed, so the shell cannot contribute. Nothing else is normalized:
   * a differing constraint or sample must change the hash, which is exactly what makes the hash
   * usable as evidence. The value is compared inside this adapter and never stored or returned.
   */
  private statementFingerprint(statement: string): string {
    return sha256Hex(statement.normalize('NFC').replace(/\s+/gu, ' ').trim());
  }

  /**
   * Official contest metadata of one contest id, or `null` when it cannot be read.
   *
   * `contest.standings` is used because it answers for a *finished* round as well as a running one,
   * and only the four fields the pairing rules need are read. A refusal (a missing contest, a rate
   * limit, an unrecognized envelope) is `null`: it makes the alias unverifiable, never accepted.
   */
  private async fetchContestFacts(
    contestId: number,
    token: CancellationToken,
    limits: PlatformLimits,
  ): Promise<CfContestFacts | null> {
    const query = new URLSearchParams({
      contestId: String(contestId),
      from: '1',
      count: '1',
      showUnofficial: 'false',
    });
    const response = await this.transport.request(`${CONTEST_STANDINGS_PATH}?${query.toString()}`, {
      token,
      operation: 'editorial',
      // 400 is accepted so a refused contest is classified instead of becoming a transport failure.
      acceptStatuses: [400],
      limits: { ...this.httpLimits(limits), maxResponseBytes: ALIAS_MAX_RESPONSE_BYTES },
    });
    if (response.status === 400) {
      return null;
    }
    const root = requireRecord(parseJson(response.body, 'editorial', 'contest.standings response'), 'contest.standings response', 'editorial');
    if (root.status !== 'OK') {
      return null;
    }
    // The API answers `result` as an object whose `contest` field owns the identity and timing
    // fields. Anything else is an unrecognized envelope, which makes the alias unverifiable rather
    // than accepted. `problems` and `rows` are intentionally ignored after the request limits them.
    const answered = this.contestFactsFromResult(root.result);
    if (answered === null || answered.contestId !== contestId) {
      return null;
    }
    return answered;
  }

  /** The four pairing facts of one `contest.standings` result, or `null` for an unknown shape. */
  private contestFactsFromResult(result: unknown): CfContestFacts | null {
    if (!isRecord(result) || !isRecord(result.contest)) {
      return null;
    }
    const contest = result.contest;
    try {
      return {
        contestId: requireSafeCount(contest.id, 'contest id', 'editorial'),
        name: requireString(contest.name, 'contest name', 'editorial'),
        startTimeSeconds: requireSafeCount(contest.startTimeSeconds, 'contest startTimeSeconds', 'editorial'),
        durationSeconds: requireSafeCount(contest.durationSeconds, 'contest durationSeconds', 'editorial'),
      };
    } catch {
      // An unreadable row cannot verify anything; the caller treats the alias as unverifiable, so a
      // malformed metadata answer never becomes an accepted redirect.
      return null;
    }
  }

  /** The stored source/solution pair of one accepted section, stamped with its provenance. */
  private adoptedEditorial(
    blog: BlogEntry,
    resolved: ResolvedEditorialTarget,
    requested: ProblemTarget,
  ): EditorialFetchResult {
    const { section, alias } = resolved;
    // The identity is always the *requested* problem: a shared-round alias changes which section the
    // text came from, never which problem the analysis is about. `requested` is passed separately
    // from the resolved section for exactly that reason, so the two can never be confused.
    const requestedKey = requested.externalKey;
    const retrievedAt = new Date().toISOString();
    const sourceId = `cf-blog-${blog.id}`;
    const sources = [
      createEditorialSource({
        id: sourceId,
        kind: 'editorial',
        url: this.blogUrl(blog.id),
        title: blog.title,
        author: blog.authorHandle,
        language: blog.locale,
        publishedAt: blog.publishedAt,
        retrievedAt,
        availability: 'found',
        text: section.text,
        note:
          alias === null
            ? `section ${section.sectionKey} of blog ${blog.id}`
            : aliasNote(alias, blog.id, section.sectionKey),
      }),
    ];
    const solutions = [
      createEditorialSolution({
        // Bound to the requested problem, so two problems can never share a task identity.
        solutionId: `${sourceId}-${requestedKey}`,
        sourceId,
        ordinal: 0,
        title: section.headingText.length > 0 ? section.headingText : blog.title,
        text: section.text,
      }),
    ];
    return { status: 'found', sources, solutions, retrievedAt };
  }

  private requireLimits(limits: PlatformLimits): PlatformLimits {
    requireLimit(limits.minRequestIntervalMs, 'minRequestIntervalMs', 0, 600_000);
    requireLimit(limits.requestTimeoutMs, 'requestTimeoutMs', 1, 600_000);
    requireLimit(limits.maxRetries, 'maxRetries', 0, 10);
    requireLimit(limits.pageSize, 'pageSize', 1, MAX_LIMIT_VALUE);
    requireLimit(limits.maxConcurrency, 'maxConcurrency', 1, 8);
    return limits;
  }

  /**
   * Per-request limits. The documented floor is applied here as well as in the transport's own
   * configuration, so even an injected shared transport that declares a zero or lower floor
   * cannot be driven below two seconds.
   */
  private httpLimits(limits: PlatformLimits): Partial<HttpLimits> {
    return {
      minRequestIntervalMs: Math.max(limits.minRequestIntervalMs, CODEFORCES_MIN_REQUEST_INTERVAL_MS),
      requestTimeoutMs: limits.requestTimeoutMs,
      maxRetries: limits.maxRetries,
    };
  }

  /**
   * Adapter-clock reading in milliseconds.
   *
   * A missing, non-finite or unrepresentable reading falls back to wall time, so a broken injected
   * clock can never make a snapshot look permanently fresh or produce an invalid ISO timestamp.
   */
  private clockMs(): number {
    const value = this.clock();
    return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : Date.now();
  }

  /**
   * The catalog snapshot for one request.
   *
   * `cursor === null` always refreshes the metadata. A continuation names the fingerprint it was
   * issued against and may reuse the cached snapshot only while it is still fresh; otherwise the
   * catalog is re-fetched so the caller's fingerprint check sees the current state. A cache hit
   * still observes cancellation.
   */
  private async loadCatalog(
    token: CancellationToken,
    limits: PlatformLimits,
    expectedFingerprint: string | null,
  ): Promise<CatalogSnapshot> {
    const cached = this.catalogSnapshot;
    if (cached !== null && expectedFingerprint !== null && cached.fingerprint === expectedFingerprint) {
      token.throwIfCancelled();
      const age = this.clockMs() - cached.fetchedAtMs;
      if (age >= 0 && age <= this.catalogSnapshotTtlMs) {
        return cached;
      }
    }
    const snapshot = await this.fetchCatalog(token, limits);
    this.catalogSnapshot = snapshot;
    return snapshot;
  }

  private async fetchCatalog(token: CancellationToken, limits: PlatformLimits): Promise<CatalogSnapshot> {
    const response = await this.transport.request(CATALOG_PATH, {
      token,
      operation: 'catalog',
      // HTTP 400 is accepted so the body can be classified: it carries both quota refusals and
      // missing-resource answers.
      acceptStatuses: [400],
      limits: { ...this.httpLimits(limits), maxResponseBytes: CATALOG_MAX_RESPONSE_BYTES },
    });
    if (response.status === 400) {
      throw apiFailure('catalog', 'problemset.problems', response.status, parseJsonRecordOrNull(response.body));
    }
    const root = requireRecord(
      parseJson(response.body, 'catalog', 'problemset.problems response'),
      'problemset.problems response',
      'catalog',
    );
    const status = requireString(root.status, 'response.status', 'catalog');
    if (status !== 'OK') {
      throw apiFailure('catalog', 'problemset.problems', response.status, root);
    }
    const result = requireRecord(root.result, 'response.result', 'catalog');
    const entries = requireArray(result.problems, 'result.problems', 'catalog').map((raw, index) =>
      this.parseCatalogEntry(raw, index),
    );
    const fetchedAtMs = this.clockMs();
    return {
      fingerprint: contentHashOf(entries.map((entry) => [entry.contestId, entry.index, entry.name, entry.rating, [...entry.tags]])),
      entries,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      fetchedAtMs,
    };
  }

  private parseCatalogEntry(raw: unknown, index: number): CatalogEntry {
    const label = `result.problems[${index}]`;
    const record = requireRecord(raw, label, 'catalog');
    const contestId = requireSafeCount(record.contestId, `${label}.contestId`, 'catalog');
    if (contestId <= 0) {
      throw payloadError('catalog', `${label}.contestId must be a positive safe integer`);
    }
    // The shared helper owns the index vocabulary: `A`/`B2`/`D10`/`20C` keep their letter form
    // and `01`…`14` keep their padding, so an all-digit catalog index is never split by hand.
    const problemIndex = normalizeCfProblemIndex(requireString(record.index, `${label}.index`, 'catalog'));
    if (problemIndex === null) {
      throw payloadError('catalog', `${label}.index is not a Codeforces problem index`);
    }
    const foreignProblemset = record.problemsetName;
    if (foreignProblemset !== undefined && foreignProblemset !== null && String(foreignProblemset).trim().length > 0) {
      // A gym/foreign problemset entry cannot be addressed on the main problemset, so it is
      // refused explicitly instead of being imported under a URL that names a different problem.
      throw payloadError(
        'catalog',
        `${label} belongs to problemset ${JSON.stringify(String(foreignProblemset).trim())}; this adapter serves only the main Codeforces problemset`,
      );
    }
    const name = requireString(record.name, `${label}.name`, 'catalog').trim();
    if (name.length === 0) {
      throw payloadError('catalog', `${label}.name must not be empty`);
    }
    let rating: number | null = null;
    if (record.rating !== undefined && record.rating !== null) {
      const value = requireSafeCount(record.rating, `${label}.rating`, 'catalog');
      rating = value;
    }
    const tags: string[] = [];
    if (record.tags !== undefined && record.tags !== null) {
      for (const tag of requireArray(record.tags, `${label}.tags`, 'catalog')) {
        const text = requireString(tag, `${label}.tags[]`, 'catalog').trim();
        if (text.length > 0) {
          tags.push(text);
        }
      }
    }
    return { contestId, index: problemIndex, name, rating, tags };
  }

  private ratingOf(rating: number | null): readonly { dimension: string; value: number; scale: null; raw: string }[] {
    return rating === null ? [] : [{ dimension: 'rating', value: rating, scale: null, raw: String(rating) }];
  }

  private normalizeCatalogEntry(entry: CatalogEntry, fetchedAt: string): NormalizedProblem {
    return createNormalizedProblem({
      ref: {
        sourceInstanceId: this.sourceInstance.id,
        // Catalog metadata is the main problemset; a foreign problemset is refused at parse time.
        domain: null,
        externalKey: cfProblemExternalKey(entry.contestId, entry.index),
      },
      title: entry.name,
      url: this.problemUrl(entry.contestId, entry.index),
      statement: null,
      ratings: this.ratingOf(entry.rating),
      rawTags: entry.tags,
      fetchedAt,
    });
  }

  private async fetchOfficialHtml(
    url: string,
    token: CancellationToken,
    limits: PlatformLimits,
    operation: PlatformOperation,
  ): Promise<string> {
    const response = await this.transport.request(url, {
      token,
      operation,
      acceptStatuses: [403],
      limits: this.httpLimits(limits),
    });
    const challenge = detectChallengePage(response.body);
    if (challenge !== null) {
      throw new PlatformError({
        code: 'auth_required',
        operation,
        retryable: false,
        detail: `Codeforces answered with an anti-bot challenge page (${challenge}) instead of the requested page`,
      });
    }
    if (response.status === 403) {
      throw new PlatformError({
        code: 'forbidden',
        operation,
        retryable: false,
        detail: 'HTTP 403 from the Codeforces page',
      });
    }
    return response.body;
  }

  private async fetchUserStatus(
    handle: string,
    from: number,
    count: number,
    token: CancellationToken,
    limits: PlatformLimits,
  ): Promise<CfSubmission[]> {
    const query = new URLSearchParams({ handle, from: String(from), count: String(count) });
    const response = await this.transport.request(`${USER_STATUS_PATH}?${query.toString()}`, {
      token,
      operation: 'submissions',
      // HTTP 400 is accepted so the body can be classified (quota refusal vs. unknown handle).
      acceptStatuses: [400],
      limits: this.httpLimits(limits),
    });
    const context = `user.status for ${handle}`;
    if (response.status === 400) {
      throw apiFailure('submissions', context, response.status, parseJsonRecordOrNull(response.body));
    }
    const root = requireRecord(parseJson(response.body, 'submissions', 'user.status response'), 'user.status response', 'submissions');
    const status = requireString(root.status, 'response.status', 'submissions');
    if (status !== 'OK') {
      throw apiFailure('submissions', context, response.status, root);
    }
    const items = requireArray(root.result, 'response.result', 'submissions');
    return items.map((raw, index) => this.parseSubmission(raw, index, handle));
  }

  private parseSubmission(raw: unknown, index: number, handle: string): CfSubmission {
    const label = `result[${index}]`;
    const record = requireRecord(raw, label, 'submissions');
    const id = requireSafeCount(record.id, `${label}.id`, 'submissions');
    if (id <= 0) throw payloadError('submissions', `${label}.id must be positive`);
    const problem = requireRecord(record.problem, `${label}.problem`, 'submissions');
    if (problem.problemsetName !== undefined && problem.problemsetName !== null && String(problem.problemsetName).trim() !== '') {
      throw payloadError('submissions', `${label} belongs to a named problemset; only the main Codeforces problemset is supported`);
    }
    const contestId = requireSafeCount(problem.contestId, `${label}.problem.contestId`, 'submissions');
    const problemIndex = normalizeCfProblemIndex(
      requireString(problem.index, `${label}.problem.index`, 'submissions'),
    );
    if (contestId <= 0 || problemIndex === null) {
      throw payloadError('submissions', `${label}.problem is not a usable problem identity`);
    }
    // A record is only accepted when the requested handle really is one of its authors, so a
    // foreign or malformed record can never be imported into this account's history.
    const handles = authorHandles(record.author);
    if (handles === null) {
      throw payloadError('submissions', `${label}.author must name at least one member handle`);
    }
    if (!handles.includes(handle)) {
      throw payloadError(
        'submissions',
        `${label} belongs to ${handles.join(', ')}, which does not include ${handle}`,
      );
    }
    const submittedAt = isoFromSeconds(
      record.creationTimeSeconds,
      `${label}.creationTimeSeconds`,
      'submissions',
    );
    let timeMs: number | null = null;
    if (record.timeConsumedMillis !== undefined && record.timeConsumedMillis !== null) {
      timeMs = requireSafeCount(record.timeConsumedMillis, `${label}.timeConsumedMillis`, 'submissions');
    }
    const rawMemory = record.memoryBytes ?? record.memoryConsumedBytes;
    let memoryKb: number | null = null;
    if (rawMemory !== undefined && rawMemory !== null) {
      memoryKb = memoryBytesToKib(requireSafeCount(rawMemory, `${label}.memoryBytes`, 'submissions'));
    }
    const language = typeof record.programmingLanguage === 'string' ? record.programmingLanguage.trim() || null : null;
    return {
      externalId: String(id),
      contestId,
      problemIndex,
      verdict: mapCodeforcesVerdict(record.verdict),
      submittedAt,
      language,
      timeMs,
      memoryKb,
    };
  }

  private normalizeSubmission(item: CfSubmission, account: Account): Submission {
    return createSubmission({
      accountId: account.id,
      // Main-problemset submissions keep the existing `domain: null`; the problem identity stays
      // unambiguous because a numeric index keeps its `/` separator.
      ref: {
        sourceInstanceId: this.sourceInstance.id,
        domain: null,
        externalKey: cfSubmissionExternalKey(item.contestId, item.problemIndex),
      },
      externalId: item.externalId,
      verdict: item.verdict,
      submittedAt: item.submittedAt,
      language: item.language,
      timeMs: item.timeMs,
      memoryKb: item.memoryKb,
    });
  }

  private async fetchBlogEntry(blogId: number, token: CancellationToken, limits: PlatformLimits): Promise<BlogEntry> {
    const response = await this.transport.request(`${BLOG_ENTRY_PATH}?blogEntryId=${blogId}`, {
      token,
      operation: 'editorial',
      // 400/404 are accepted so the body decides between a dead reference, a quota refusal and a
      // genuinely unrecognized answer.
      acceptStatuses: [400, 404],
      limits: this.httpLimits(limits),
    });
    const context = `blogEntry.view for blog ${blogId}`;
    if (response.status === 404) {
      throw new PlatformError({
        code: 'unavailable',
        operation: 'editorial',
        retryable: false,
        detail: `the referenced editorial blog ${blogId} is not available (HTTP 404)`,
      });
    }
    if (response.status === 400) {
      throw apiFailure('editorial', context, response.status, parseJsonRecordOrNull(response.body));
    }
    const root = requireRecord(parseJson(response.body, 'editorial', 'blogEntry.view response'), 'blogEntry.view response', 'editorial');
    const status = requireString(root.status, 'response.status', 'editorial');
    if (status !== 'OK') {
      throw apiFailure('editorial', context, response.status, root);
    }
    const result = requireRecord(root.result, 'response.result', 'editorial');
    const answeredId = requireSafeCount(result.id, 'blog id', 'editorial');
    if (answeredId !== blogId) {
      throw payloadError('editorial', `${context} answered blog ${answeredId} instead`);
    }
    const content = requireString(result.content, 'blog content', 'editorial');
    if (content.trim().length === 0) {
      throw payloadError('editorial', `blog ${blogId} has no content`);
    }
    let publishedAt: string | null = null;
    if (result.creationTimeSeconds !== undefined && result.creationTimeSeconds !== null) {
      publishedAt = isoFromSeconds(result.creationTimeSeconds, 'blog creationTimeSeconds', 'editorial');
    }
    return {
      id: answeredId,
      title: blogTitleOf(result, blogId),
      content,
      authorHandle: authorOf(result),
      locale: localeOf(result),
      publishedAt,
    };
  }

  /** Official main-problemset URL of one problem; a numeric index keeps its `/` separator. */
  private problemUrl(contestId: number, index: string): string {
    const [contestPath, problemsetPath] = officialProblemPaths(contestId, index);
    return new URL(problemsetPath ?? contestPath ?? '', this.sourceInstance.baseUrl).toString();
  }

  private blogUrl(blogId: number): string {
    return new URL(`/blog/entry/${blogId}`, this.sourceInstance.baseUrl).toString();
  }
}
