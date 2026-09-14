/**
 * Pure Luogu Lentille payload parsing and statement assembly.
 *
 * Every field the workbench relies on is validated at runtime here (never in the domain).
 * Raw platform identity is preserved: difficulty stays the numeric value Luogu reports and tag
 * ids stay numeric (`luogu-tag:<id>`), including negative or otherwise unknown ids, so a
 * dictionary can only *add* names. A payload that does not match the observed shape becomes a
 * `changed_response` instead of a plausible-looking empty problem, and a `data.errorCode`
 * answers with its typed platform error rather than being mistaken for data.
 */
import { PlatformError, type PlatformOperation } from '../../application/platform-errors.js';
import { LUOGU_UID_PATTERN } from './account.js';

/** Official Luogu problem ids: `P1000`, `CF20C`, `AT_abc123_a`, `SP1234`, ... */
export const LUOGU_PID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/u;
/** Raw-tag prefix that keeps the numeric platform tag identity visible next to any name. */
export const LUOGU_TAG_RAW_PREFIX = 'luogu-tag:';
/** Bounded assembled statement size; a larger statement is a changed response, not truncated data. */
export const MAX_STATEMENT_CHARS = 400_000;
const MAX_TAG_ENTRIES = 100_000;
const MAX_PER_PAGE = 5_000;

export interface LuoguProblemSummary {
  readonly pid: string;
  readonly title: string;
  /** Raw `difficulty` exactly as reported; `null` when the payload omitted it. */
  readonly difficulty: number | null;
  /** Raw numeric tag ids; negative ids such as `-2` are legal. */
  readonly tagIds: readonly number[];
}

export interface LuoguProblemPage {
  readonly perPage: number;
  readonly count: number;
  readonly items: readonly LuoguProblemSummary[];
}

export interface LuoguStatementSections {
  readonly background: string | null;
  readonly description: string | null;
  readonly formatI: string | null;
  readonly formatO: string | null;
  readonly hint: string | null;
}

export interface LuoguSample {
  readonly input: string;
  readonly output: string;
}

export interface LuoguProblemDetail {
  readonly summary: LuoguProblemSummary;
  readonly statement: string;
  readonly timeLimitsMs: readonly number[];
  readonly memoryLimitsKib: readonly number[];
}

export interface LuoguTag {
  readonly id: number;
  readonly name: string;
  readonly type: number | null;
  readonly parent: number | null;
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build a sanitized `changed_response` for a payload the adapter no longer understands. */
export function payloadError(operation: PlatformOperation, detail: string, sample?: string | null): PlatformError {
  return new PlatformError({ code: 'changed_response', operation, retryable: false, detail, sample: sample ?? null });
}

function requireRecord(value: unknown, label: string, operation: PlatformOperation): Record<string, unknown> {
  if (!isJsonRecord(value)) {
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

function requireNonEmptyString(value: unknown, label: string, operation: PlatformOperation): string {
  const text = requireString(value, label, operation).trim();
  if (text.length === 0) {
    throw payloadError(operation, `${label} must not be empty`);
  }
  return text;
}

function requireInteger(
  value: unknown,
  label: string,
  operation: PlatformOperation,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw payloadError(operation, `${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** A pid that will only ever address one official problem page. */
export function requirePid(value: unknown, label: string, operation: PlatformOperation): string {
  if (typeof value !== 'string' || !LUOGU_PID_PATTERN.test(value.trim())) {
    throw payloadError(operation, `${label} must be an official Luogu problem id`);
  }
  return value.trim();
}

/** Longest accepted Luogu profile nickname; a longer name is a changed response, not truncated data. */
export const MAX_LUOGU_DISPLAY_NAME_CHARS = 256;
/** Control characters are never part of a display name and would corrupt a single-line answer. */
const UNSAFE_DISPLAY_NAME = /[\u0000-\u001f\u007f]/u;

/** Validated public profile of one Luogu account: the requested uid and its own nickname. */
export interface LuoguAccountProfile {
  readonly uid: string;
  readonly displayName: string;
}

/**
 * Parse one `GET /user/<uid>` answer.
 *
 * Only `data.user` is the requested profile. `root.user` is the **viewer** identity Lentille
 * attaches to the anonymous request itself, so a payload that carries only the viewer (or a
 * `data.user` of a different uid) is refused instead of showing one account's name on another.
 * The answered uid must equal the requested canonical UID, accepted as a positive safe integer or
 * as the canonical decimal string; the nickname must be a non-blank string within
 * {@link MAX_LUOGU_DISPLAY_NAME_CHARS} characters and without control characters. Every other
 * profile field is deliberately not read.
 */
export function parseAccountProfile(
  root: Record<string, unknown>,
  expectedUid: string,
  operation: PlatformOperation = 'profile',
): LuoguAccountProfile {
  const data = luoguData(root, operation);
  const user = requireRecord(data.user, 'data.user', operation);
  const uid = requireProfileUid(user.uid, expectedUid, operation);
  const displayName = requireNonEmptyString(user.name, 'data.user.name', operation);
  if (displayName.length > MAX_LUOGU_DISPLAY_NAME_CHARS) {
    throw payloadError(operation, `data.user.name exceeds ${MAX_LUOGU_DISPLAY_NAME_CHARS} characters`);
  }
  if (UNSAFE_DISPLAY_NAME.test(displayName)) {
    throw payloadError(operation, 'data.user.name contains control characters');
  }
  return { uid, displayName };
}

/** The answered uid, canonicalized and proven to be exactly the requested account's uid. */
function requireProfileUid(value: unknown, expectedUid: string, operation: PlatformOperation): string {
  let uid: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw payloadError(operation, 'data.user.uid must be a positive safe integer or a canonical decimal string');
    }
    uid = String(value);
  } else if (typeof value === 'string' && LUOGU_UID_PATTERN.test(value)) {
    uid = value;
  } else {
    throw payloadError(operation, 'data.user.uid must be a positive safe integer or a canonical decimal string');
  }
  if (uid !== expectedUid) {
    throw payloadError(operation, `data.user.uid ${uid} does not match the requested account ${expectedUid}`);
  }
  return uid;
}

/**
 * Extract `data` and translate a declared `data.errorCode` into a typed platform error.
 *
 * Lentille answers some failures with HTTP 200 and a body-level error code, so the code is
 * checked before any field access: 401/403/429 keep their own discriminants instead of being
 * misread as an empty catalog.
 */
export function luoguData(root: Record<string, unknown>, operation: PlatformOperation): Record<string, unknown> {
  const data = root.data;
  if (!isJsonRecord(data)) {
    throw payloadError(operation, 'the Luogu payload has no data object');
  }
  const code = data.errorCode;
  if (code !== undefined && code !== null) {
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
      throw payloadError(operation, 'the Luogu data.errorCode is not an integer');
    }
    if (code !== 200) {
      throw luoguErrorCode(code, data, operation);
    }
  }
  return data;
}

function luoguErrorCode(code: number, data: Record<string, unknown>, operation: PlatformOperation): PlatformError {
  const kind = typeof data.errorType === 'string' && data.errorType.trim().length > 0 ? data.errorType.trim() : null;
  const detail = `Luogu answered errorCode ${code}${kind === null ? '' : ` (${kind})`}`;
  if (code === 401) {
    return new PlatformError({ code: 'auth_required', operation, retryable: false, detail });
  }
  if (code === 403) {
    return new PlatformError({ code: 'forbidden', operation, retryable: false, detail });
  }
  if (code === 429) {
    return new PlatformError({ code: 'rate_limited', operation, retryable: true, retryAfterMs: null, detail });
  }
  if (code === 404) {
    return new PlatformError({ code: 'unavailable', operation, retryable: false, detail });
  }
  if (code >= 500) {
    return new PlatformError({ code: 'unavailable', operation, retryable: true, detail });
  }
  return new PlatformError({ code: 'changed_response', operation, retryable: false, detail });
}

function parseDifficulty(value: unknown, label: string, operation: PlatformOperation): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw payloadError(operation, `${label} must be a finite number or null`);
  }
  return value;
}

function parseTagIds(value: unknown, label: string, operation: PlatformOperation): readonly number[] {
  return requireArray(value, label, operation).map((tag, index) =>
    requireInteger(tag, `${label}[${index}]`, operation, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  );
}

function parseSummary(value: unknown, label: string, operation: PlatformOperation): LuoguProblemSummary {
  const record = requireRecord(value, label, operation);
  return {
    pid: requirePid(record.pid, `${label}.pid`, operation),
    title: requireNonEmptyString(record.name, `${label}.name`, operation),
    difficulty: parseDifficulty(record.difficulty, `${label}.difficulty`, operation),
    tagIds: parseTagIds(record.tags, `${label}.tags`, operation),
  };
}

/** Parse one `/problem/list` page. `perPage`/`count` drive the pagination contract. */
export function parseProblemList(root: Record<string, unknown>, operation: PlatformOperation = 'catalog'): LuoguProblemPage {
  const data = luoguData(root, operation);
  const problems = requireRecord(data.problems, 'data.problems', operation);
  const perPage = requireInteger(problems.perPage, 'data.problems.perPage', operation, 1, MAX_PER_PAGE);
  const count = requireInteger(problems.count, 'data.problems.count', operation, 0, 1_000_000_000);
  const result = requireArray(problems.result, 'data.problems.result', operation);
  if (result.length > perPage) {
    throw payloadError(operation, `data.problems.result has ${result.length} entries but perPage is ${perPage}`);
  }
  return {
    perPage,
    count,
    items: result.map((entry, index) => parseSummary(entry, `data.problems.result[${index}]`, operation)),
  };
}

/** Parse `/problem/<pid>`; the answered pid must match the requested one. */
export function parseProblemDetail(
  root: Record<string, unknown>,
  expectedPid: string,
  operation: PlatformOperation = 'problem',
): LuoguProblemDetail {
  const data = luoguData(root, operation);
  const problem = requireRecord(data.problem, 'data.problem', operation);
  const pid = requirePid(problem.pid, 'data.problem.pid', operation);
  // Identity check against the request: Luogu canonicalises pid case (`cf20c` for `CF20C`), so the
  // comparison ignores case and the answered canonical pid is the identity the caller receives.
  if (pid.toUpperCase() !== expectedPid.trim().toUpperCase()) {
    throw payloadError(operation, `data.problem.pid ${pid} does not match the requested problem ${expectedPid}`);
  }
  const content = requireRecord(problem.content, 'data.problem.content', operation);
  const title = requireNonEmptyString(content.name, 'data.problem.content.name', operation);
  const sections: LuoguStatementSections = {
    background: optionalSection(content.background, 'data.problem.content.background', operation),
    description: optionalSection(content.description, 'data.problem.content.description', operation),
    formatI: optionalSection(content.formatI, 'data.problem.content.formatI', operation),
    formatO: optionalSection(content.formatO, 'data.problem.content.formatO', operation),
    hint: optionalSection(content.hint, 'data.problem.content.hint', operation),
  };
  // A statement is only a statement when it carries the problem description: an input/output
  // format alone is never promoted to a full statement. `background`, both formats and `hint`
  // stay legitimately optional (`null`), and every present section is kept verbatim.
  if (sections.description === null || sections.description.trim().length === 0) {
    throw payloadError(
      operation,
      'data.problem.content.description is missing or blank; refusing an input/output-only statement',
    );
  }
  const samples = parseSamples(problem.samples, operation);
  const statement = buildLuoguStatement(sections, samples);
  if (statement.length > MAX_STATEMENT_CHARS) {
    throw payloadError(operation, `the assembled statement exceeds ${MAX_STATEMENT_CHARS} characters`);
  }
  const limits = requireRecord(problem.limits, 'data.problem.limits', operation);
  return {
    summary: {
      pid,
      title,
      difficulty: parseDifficulty(problem.difficulty, 'data.problem.difficulty', operation),
      tagIds: parseTagIds(problem.tags, 'data.problem.tags', operation),
    },
    statement,
    timeLimitsMs: parseLimitArray(limits.time, 'data.problem.limits.time', operation),
    memoryLimitsKib: parseLimitArray(limits.memory, 'data.problem.limits.memory', operation),
  };
}

function optionalSection(value: unknown, label: string, operation: PlatformOperation): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, label, operation);
}

function parseSamples(value: unknown, operation: PlatformOperation): readonly LuoguSample[] {
  return requireArray(value, 'data.problem.samples', operation).map((entry, index) => {
    const pair = requireArray(entry, `data.problem.samples[${index}]`, operation);
    if (pair.length !== 2) {
      throw payloadError(operation, `data.problem.samples[${index}] must be [input, output]`);
    }
    return {
      input: requireString(pair[0], `data.problem.samples[${index}][0]`, operation),
      output: requireString(pair[1], `data.problem.samples[${index}][1]`, operation),
    };
  });
}

/** Luogu never declares an absent limit: a missing or invalid value is a changed response. */
function parseLimitArray(value: unknown, label: string, operation: PlatformOperation): readonly number[] {
  const entries = requireArray(value, label, operation);
  if (entries.length === 0) {
    throw payloadError(operation, `${label} must not be empty`);
  }
  return entries.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) {
      throw payloadError(operation, `${label}[${index}] must be a positive finite number`);
    }
    return entry;
  });
}

/** Assemble every available section plus the samples, preserving Markdown and math verbatim. */
export function buildLuoguStatement(
  sections: LuoguStatementSections,
  samples: readonly LuoguSample[] = [],
): string {
  const parts: string[] = [];
  const push = (label: string, text: string | null): void => {
    if (typeof text === 'string' && text.trim().length > 0) {
      parts.push(`## ${label}\n\n${text.trim()}`);
    }
  };
  push('题目背景', sections.background);
  push('题目描述', sections.description);
  push('输入格式', sections.formatI);
  push('输出格式', sections.formatO);
  samples.forEach((sample, index) => {
    parts.push(`## 样例 #${index + 1}\n\n输入:\n\n${sample.input}\n\n输出:\n\n${sample.output}`);
  });
  push('提示', sections.hint);
  return parts.join('\n\n');
}

/**
 * Parse `/_lfe/tags` into an id→name dictionary.
 *
 * An empty dictionary is refused: reporting zero tags would hide a broken dictionary behind a
 * successful-looking problem. Negative ids, `type` and `parent` (including `null`) are legal.
 */
export function parseTagDictionary(
  root: Record<string, unknown>,
  operation: PlatformOperation = 'catalog',
): ReadonlyMap<number, string> {
  const container = isJsonRecord(root.data) ? root.data : root;
  const tags = requireArray(container.tags, 'tags', operation);
  if (tags.length === 0) {
    throw payloadError(operation, 'the tag dictionary is empty; refusing to report zero tags as success');
  }
  if (tags.length > MAX_TAG_ENTRIES) {
    throw payloadError(operation, `the tag dictionary has more than ${MAX_TAG_ENTRIES} entries`);
  }
  const dictionary = new Map<number, string>();
  tags.forEach((entry, index) => {
    const record = requireRecord(entry, `tags[${index}]`, operation);
    const id = requireInteger(record.id, `tags[${index}].id`, operation, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const name = requireNonEmptyString(record.name, `tags[${index}].name`, operation);
    optionalTagNumber(record.type, `tags[${index}].type`, operation);
    optionalTagNumber(record.parent, `tags[${index}].parent`, operation);
    if (!dictionary.has(id)) {
      dictionary.set(id, name);
    }
  });
  return dictionary;
}

function optionalTagNumber(value: unknown, label: string, operation: PlatformOperation): void {
  if (value !== undefined && value !== null) {
    requireInteger(value, label, operation, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  }
}

/** Raw tags for one problem: the numeric id always stays, dictionary names are added after it. */
export function luoguTagRaws(tagIds: readonly number[], dictionary: ReadonlyMap<number, string> | null): string[] {
  const raws: string[] = [];
  for (const id of tagIds) {
    raws.push(`${LUOGU_TAG_RAW_PREFIX}${id}`);
    const name = dictionary?.get(id);
    if (name !== undefined) {
      raws.push(name);
    }
  }
  return raws;
}

/** True when a body is a challenge/login HTML page rather than the expected JSON. */
export function isHtmlResponse(contentType: string | null, body: string): boolean {
  if (contentType !== null && /text\/html/iu.test(contentType)) {
    return true;
  }
  return /^\s*<(?:!doctype|html|head|body|\?xml)/iu.test(body);
}

/** Short, control-character-free snippet for a `changed_response` sample; never a full body. */
export function bodySnippet(body: string): string {
  const text = body.slice(0, 512).replace(/\s+/gu, ' ').trim();
  return text.length <= 200 ? text : `${text.slice(0, 200)}...`;
}
