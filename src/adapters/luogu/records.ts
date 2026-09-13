/**
 * Strict Luogu `/record/list` payload parsing.
 *
 * Everything the workbench relies on is validated at runtime here, before any record becomes a
 * domain submission:
 *
 * - the envelope must be the Lentille `data.records.result` list (the `data.errorCode` path is
 *   translated into its typed platform error by {@link luoguData}), and any user identity the
 *   payload exposes — envelope level or per record — must name the account the request was
 *   scoped to;
 * - a record must carry a positive integer `id`, an integer `status`, an integer `submitTime`
 *   in Unix **seconds** inside a sane era, and a `problem.pid` that is an official Luogu id;
 * - records must be in stable descending order (strictly decreasing `id`, non-increasing
 *   `submitTime`), so a page that was reordered or shifted is refused instead of delivered out
 *   of order;
 * - an invalid record refuses the **whole page atomically**: a partial page is never returned.
 *
 * ## Honesty limits (unverified live shape)
 *
 * The authenticated record shape has **not** been observed against a live session; the fixtures
 * in the test suite are synthetic. Consequences kept deliberately conservative:
 *
 * - only the Lentille `data.records.result` envelope is supported; the older `currentData`
 *   envelope is refused as a changed response rather than guessed at;
 * - `perPage`/`count` are parsed only when the payload declares usable integers, and the
 *   adapter treats them as a drift signal, never as permission to skip records;
 * - a numeric `status` maps to a domain verdict only for the documented status constants below.
 *   Every other code — including pending/judging codes — stays `unknown`, so a pending record
 *   can never masquerade as accepted;
 * - `language` is imported only when the payload itself sends a string label; numeric language
 *   ids are left `null` rather than converted into invented names. `time`/`memory` are not read
 *   at all, because their units are unverified.
 */
import type { SubmissionVerdict } from '../../domain/index.js';
import { PlatformError, type PlatformOperation } from '../../application/platform-errors.js';
import { LUOGU_UID_PATTERN } from './account.js';
import { isJsonRecord, luoguData, payloadError, requirePid } from './parsers.js';

/** Upper bound of one server page; a larger declared page is a changed response. */
export const LUOGU_MAX_SERVER_PAGE_SIZE = 5_000;
/** 2000-01-01T00:00:00Z: no Luogu record predates the site, and a `0`/absent time is refused. */
export const LUOGU_MIN_SUBMIT_TIME_SECONDS = 946_684_800;
/** 2100-01-01T00:00:00Z: a "timestamp" beyond this is a unit/shape error, not a date. */
export const LUOGU_MAX_SUBMIT_TIME_SECONDS = 4_102_444_800;
/** One record's declared total, as the shared drift bound of the paging contract. */
export const LUOGU_MAX_RECORD_COUNT = 1_000_000_000;

const MIN_STATUS = -2_147_483_648;
const MAX_STATUS = 2_147_483_647;
const MAX_LANGUAGE_CHARS = 120;

/**
 * Numeric Luogu status codes with an established meaning, mapped onto the domain's verdicts.
 *
 * Anything not listed — including `0`/`1` (waiting/judging), negative codes and future codes —
 * resolves to `unknown`. That is the point: an unrecognised status is preserved as unknown
 * instead of being bent into `accepted` or any other concrete verdict.
 */
export const LUOGU_STATUS_VERDICTS: ReadonlyMap<number, SubmissionVerdict> = new Map<number, SubmissionVerdict>([
  [2, 'compile_error'],
  [4, 'memory_limit_exceeded'],
  [5, 'time_limit_exceeded'],
  [6, 'wrong_answer'],
  [7, 'runtime_error'],
  [12, 'accepted'],
]);

/** Map one raw numeric status onto a verdict; unknown codes become `unknown`. */
export function luoguStatusVerdict(status: number): SubmissionVerdict {
  return LUOGU_STATUS_VERDICTS.get(status) ?? 'unknown';
}

/** One validated record, still carrying the platform's raw identity and raw numeric status. */
export interface LuoguRecord {
  /** Canonical decimal record id; the platform's own identity, never derived or renumbered. */
  readonly id: string;
  /** Official Luogu problem id (`P1000`, `CF20C`, ...). */
  readonly pid: string;
  /** Raw numeric status exactly as reported. */
  readonly status: number;
  readonly submitTimeSeconds: number;
  /** `submitTimeSeconds` as an exact ISO-8601 UTC timestamp; no fallback date is ever invented. */
  readonly submittedAt: string;
  /** Only a string label the platform itself sent; numeric language ids stay `null`. */
  readonly language: string | null;
}

/** One parsed page plus the pagination metadata the payload declared (or `null`). */
export interface LuoguRecordPage {
  readonly records: readonly LuoguRecord[];
  /** Declared server page size, when the payload exposes a usable one. */
  readonly perPage: number | null;
  /** Declared record total, when the payload exposes a usable one; a drift signal only. */
  readonly count: number | null;
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

/** `null` for an absent/`null` field, a validated integer otherwise; never a silent default. */
function optionalInteger(
  value: unknown,
  label: string,
  operation: PlatformOperation,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireInteger(value, label, operation, min, max);
}

/** Canonical decimal record id: a positive safe integer, stringified without reformatting. */
function requireRecordId(value: unknown, label: string, operation: PlatformOperation): string {
  return String(requireInteger(value, label, operation, 1, Number.MAX_SAFE_INTEGER));
}

/** True Unix seconds inside the accepted era; anything else is refused (never defaulted). */
function requireSubmitTime(
  value: unknown,
  label: string,
  operation: PlatformOperation,
): { readonly seconds: number; readonly iso: string } {
  const seconds = requireInteger(value, label, operation, LUOGU_MIN_SUBMIT_TIME_SECONDS, LUOGU_MAX_SUBMIT_TIME_SECONDS);
  return { seconds, iso: new Date(seconds * 1000).toISOString() };
}

/**
 * Read one exposed user id: a positive integer or the canonical decimal spelling of one.
 *
 * `null` means "not exposed"; a present value with any other shape is a changed response, so an
 * unattributable identity is never silently ignored.
 */
function readUid(value: unknown, label: string, operation: PlatformOperation): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) {
    return String(value);
  }
  if (typeof value === 'string' && LUOGU_UID_PATTERN.test(value)) {
    return value;
  }
  throw payloadError(operation, `${label} is not a Luogu UID`);
}

/** Validate one optional identity field against the account the request was scoped to. */
function assertUidEvidence(value: unknown, label: string, expectedUid: string, operation: PlatformOperation): void {
  const uid = readUid(value, label, operation);
  if (uid !== null && uid !== expectedUid) {
    throw payloadError(operation, `${label} belongs to account ${uid}, not the requested ${expectedUid}`);
  }
}

/** Envelope-level account evidence: `data.uid`, `data.user.uid`, `data.filter.user`/`uid`. */
function assertEnvelopeIdentity(
  data: Record<string, unknown>,
  expectedUid: string,
  operation: PlatformOperation,
): void {
  assertUidEvidence(data.uid, 'data.uid', expectedUid, operation);
  const user = data.user;
  if (user !== undefined && user !== null) {
    const record = requireRecord(user, 'data.user', operation);
    const uid = readUid(record.uid, 'data.user.uid', operation);
    if (uid === null) {
      throw payloadError(operation, 'data.user exposes an identity without a uid');
    }
    if (uid !== expectedUid) {
      throw payloadError(operation, `data.user.uid belongs to account ${uid}, not the requested ${expectedUid}`);
    }
  }
  const filter = data.filter;
  if (filter !== undefined && filter !== null) {
    const record = requireRecord(filter, 'data.filter', operation);
    assertUidEvidence(record.user, 'data.filter.user', expectedUid, operation);
    assertUidEvidence(record.uid, 'data.filter.uid', expectedUid, operation);
  }
}

/** One record's optional `user.uid` evidence. */
function assertRecordIdentity(
  record: Record<string, unknown>,
  label: string,
  expectedUid: string,
  operation: PlatformOperation,
): void {
  const user = record.user;
  if (user === undefined || user === null) {
    return;
  }
  const author = requireRecord(user, `${label}.user`, operation);
  const uid = readUid(author.uid, `${label}.user.uid`, operation);
  if (uid === null) {
    throw payloadError(operation, `${label}.user exposes an identity without a uid`);
  }
  if (uid !== expectedUid) {
    throw payloadError(operation, `${label}.user.uid belongs to account ${uid}, not the requested ${expectedUid}`);
  }
}

/**
 * A string language label is kept verbatim (trimmed); every other shape — including the numeric
 * language ids Luogu also uses — becomes `null` instead of an invented name.
 */
function optionalLanguage(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LANGUAGE_CHARS || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseRecord(
  entry: unknown,
  index: number,
  expectedUid: string,
  operation: PlatformOperation,
): LuoguRecord {
  const label = `data.records.result[${index}]`;
  const record = requireRecord(entry, label, operation);
  const id = requireRecordId(record.id, `${label}.id`, operation);
  const status = requireInteger(record.status, `${label}.status`, operation, MIN_STATUS, MAX_STATUS);
  const submitted = requireSubmitTime(record.submitTime, `${label}.submitTime`, operation);
  const problem = requireRecord(record.problem, `${label}.problem`, operation);
  const pid = requirePid(problem.pid, `${label}.problem.pid`, operation);
  assertRecordIdentity(record, label, expectedUid, operation);
  return {
    id,
    pid,
    status,
    submitTimeSeconds: submitted.seconds,
    submittedAt: submitted.iso,
    language: optionalLanguage(record.language),
  };
}

/** Strictly descending ids, non-increasing submit times: the observed newest-first order. */
function assertDescending(records: readonly LuoguRecord[], operation: PlatformOperation): void {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!;
    const current = records[index]!;
    if (Number(current.id) >= Number(previous.id)) {
      throw payloadError(operation, `data.records.result is not in stable descending id order at index ${index}`);
    }
    if (current.submitTimeSeconds > previous.submitTimeSeconds) {
      throw payloadError(operation, `data.records.result is not in descending submitTime order at index ${index}`);
    }
  }
}

/**
 * Parse one `/record/list` page for `expectedUid`.
 *
 * The whole page is validated before anything is returned: a single malformed, foreign or
 * out-of-order record rejects the page instead of yielding a partial history.
 */
export function parseRecordPage(
  root: Record<string, unknown>,
  expectedUid: string,
  operation: PlatformOperation = 'submissions',
): LuoguRecordPage {
  if (typeof expectedUid !== 'string' || !LUOGU_UID_PATTERN.test(expectedUid)) {
    throw new PlatformError({
      code: 'invalid_input',
      operation,
      retryable: false,
      detail: 'record parsing requires a canonical Luogu UID',
    });
  }
  const data = luoguData(root, operation);
  const container = requireRecord(data.records, 'data.records', operation);
  assertEnvelopeIdentity(data, expectedUid, operation);
  const result = requireArray(container.result, 'data.records.result', operation);
  if (result.length > LUOGU_MAX_SERVER_PAGE_SIZE) {
    throw payloadError(
      operation,
      `data.records.result has more than ${LUOGU_MAX_SERVER_PAGE_SIZE} entries`,
    );
  }
  const perPage = optionalInteger(container.perPage, 'data.records.perPage', operation, 1, LUOGU_MAX_SERVER_PAGE_SIZE);
  const count = optionalInteger(container.count, 'data.records.count', operation, 0, LUOGU_MAX_RECORD_COUNT);
  if (perPage !== null && result.length > perPage) {
    throw payloadError(operation, `data.records.result has ${result.length} entries but perPage is ${perPage}`);
  }
  const records = result.map((entry, index) => parseRecord(entry, index, expectedUid, operation));
  assertDescending(records, operation);
  return { records, perPage, count };
}
