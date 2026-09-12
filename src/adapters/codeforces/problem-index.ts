/**
 * Shared Codeforces problem identity: index normalization, canonical keys and official URLs.
 *
 * One place owns the three shapes the adapter has to keep in sync — the catalog's `index`
 * field, the domain `externalKey`, and the official problem URL:
 *
 * - an alphabetic index is a single letter with an optional numeric suffix (`A`, `B2`, `D10`;
 *   `20C` is contest `20`, problem `C`) and is upper-cased;
 * - a numeric index (`01`…`14`, `D10`-family gym sets) keeps its padding exactly, because `01`
 *   and `1` are different problems, and is joined with an explicit `/`, so `921/01` can never
 *   be confused with contest `92101`. Splitting an all-digit key is never guessed;
 * - an official href is exactly the four path segments of `/contest/<id>/problem/<index>` or
 *   `/problemset/problem/<id>/<index>`; `http://` and `www.` spellings are accepted as identity
 *   references only and are never used as a transport target.
 */

/** Official problem index: one letter with an optional numeric suffix, or 1–3 digits (padding kept). */
export const CF_PROBLEM_INDEX = /^(?:[A-Za-z](?:[1-9][0-9]*)?|[0-9]{1,3})$/u;

const NUMERIC_INDEX = /^[0-9]{1,3}$/u;
const KEY_WITH_SEPARATOR = /^(\d{1,7})\/([0-9]{1,3})$/u;
const KEY_WITHOUT_SEPARATOR = /^(\d{1,7})([A-Za-z](?:[1-9][0-9]*)?)$/u;
const OFFICIAL_HOSTS: ReadonlySet<string> = new Set(['codeforces.com', 'www.codeforces.com']);

export interface CfProblemKeyParts {
  readonly contestId: number;
  /** Canonical index: `A`, `B2`, `D10` or the numeric form `01`, `14` with its padding kept. */
  readonly index: string;
}

/** One official problem identity, normalized and ready to build a canonical key or URL. */
export interface CfProblemIdentity extends CfProblemKeyParts {
  /** `gym` for gym contests, `null` for the main problemset. */
  readonly domain: string | null;
  /** Canonical domain key: `20C`, `A`, `D10`, `921/01`. */
  readonly externalKey: string;
  /** Official URL on the adapter's own origin; safe to fetch. */
  readonly url: string;
  readonly path: string;
}

/** Normalize one raw Codeforces index, or `null` when it is not a valid index. */
export function normalizeCfProblemIndex(raw: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const upper = trimmed.toUpperCase();
  // A numeric index keeps its padding: `01` and `1` address different problems.
  return CF_PROBLEM_INDEX.test(upper) ? upper : null;
}

/** Canonical `<contestId><index>` (alphabetic) or `<contestId>/<index>` (numeric) external key. */
export function cfProblemExternalKey(contestId: number, index: string): string {
  const normalized = normalizeCfProblemIndex(index);
  if (normalized === null) {
    throw new TypeError(`invalid Codeforces problem index ${JSON.stringify(index)}`);
  }
  if (!Number.isSafeInteger(contestId) || contestId <= 0) {
    throw new TypeError(`invalid Codeforces contest id ${String(contestId)}`);
  }
  return NUMERIC_INDEX.test(normalized) ? `${contestId}/${normalized}` : `${contestId}${normalized}`;
}

/** Alias of {@link cfProblemExternalKey} that reads better at call sites holding parts. */
export function cfProblemKeyFromParts(parts: CfProblemKeyParts): string {
  return cfProblemExternalKey(parts.contestId, parts.index);
}

/** Canonical problem key of one submission, which names a problem the same way. */
export function cfSubmissionExternalKey(contestId: number, index: string): string {
  return cfProblemExternalKey(contestId, index);
}

/**
 * Parse a canonical external key.
 *
 * A numeric index is only accepted with its explicit `/` separator, so `92114` stays an
 * invalid key instead of being guessed as contest `9211` problem `4`.
 */
export function parseCfProblemKey(key: string): CfProblemKeyParts | null {
  if (typeof key !== 'string') {
    return null;
  }
  const trimmed = key.trim();
  const separated = KEY_WITH_SEPARATOR.exec(trimmed);
  if (separated !== null) {
    return acceptParts(separated[1], separated[2]);
  }
  const joined = KEY_WITHOUT_SEPARATOR.exec(trimmed);
  if (joined !== null) {
    return acceptParts(joined[1], joined[2]);
  }
  return null;
}

function acceptParts(contestText: string | undefined, indexText: string | undefined): CfProblemKeyParts | null {
  const contestId = Number(contestText);
  const index = indexText === undefined ? null : normalizeCfProblemIndex(indexText);
  if (index === null || !Number.isSafeInteger(contestId) || contestId <= 0) {
    return null;
  }
  return { contestId, index };
}

/** `true` when `hostname` is the official Codeforces host, with or without `www.`. */
export function isOfficialCodeforcesHost(hostname: string): boolean {
  return OFFICIAL_HOSTS.has(hostname.trim().toLowerCase());
}

/**
 * True for an official Codeforces problem href.
 *
 * `www.`/`http:` legacy spellings are accepted as *identity references* only: they name the
 * same problem, but they are never used as a transport target (see {@link officialProblemPaths}).
 */
export function isOfficialCodeforcesHref(href: string): boolean {
  return parseProblemUrl(href) !== null;
}

/**
 * Official paths of one problem identity.
 *
 * A call site fetches the path it needs; hrefs found in third-party HTML only ever supply the
 * two numeric/letter components through {@link parseOfficialProblemPath}.
 */
export function officialProblemPaths(contestId: number, index: string): readonly string[] {
  const normalized = normalizeCfProblemIndex(index);
  if (normalized === null) {
    throw new TypeError(`invalid Codeforces problem index ${JSON.stringify(index)}`);
  }
  return [
    `/contest/${contestId}/problem/${normalized}`,
    `/problemset/problem/${contestId}/${normalized}`,
  ];
}

/**
 * Parse a *relative or absolute* official problem path from a link href, or `null`.
 *
 * Only the exact four-segment official paths are accepted: credentials, a non-default port, a
 * foreign protocol/host, a trailing slash or any extra path segment are refused, so a link is
 * never trusted for more than the two identity components.
 */
export function parseOfficialProblemPath(href: string): CfProblemKeyParts | null {
  return parseProblemUrl(href);
}

function parseProblemUrl(href: string): CfProblemKeyParts | null {
  if (typeof href !== 'string' || href.trim().length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(href.trim(), 'https://codeforces.com');
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
  const segments = parsed.pathname.split('/');
  // `/contest/<id>/problem/<index>` or `/problemset/problem/<id>/<index>`, nothing else: the
  // leading empty segment is the only empty part, so a trailing slash is refused as well.
  if (segments.length !== 5 || segments[0] !== '') {
    return null;
  }
  const [, first, second, third, fourth] = segments;
  if (first === 'contest' && third === 'problem') {
    return acceptParts(second, fourth);
  }
  if (first === 'problemset' && second === 'problem') {
    return acceptParts(third, fourth);
  }
  return null;
}
