/**
 * Manual import parsers: version 1 JSON documents and CSV tables.
 *
 * Both entry points are pure: they read text, validate it strictly and return either one complete
 * immutable {@link ManualDocument} or the explicit list of rejections. There is no partial
 * result, no silently dropped row and no IO — a URL in the payload is attribution only and is
 * never requested.
 *
 * Validation order is deliberate:
 * 1. text shape and size (8 MiB), then JSON syntax / CSV syntax;
 * 2. `source`, then accounts, problems, submissions and editorials — each level is only read
 *    after the previous one is clean, so a broken row cannot cascade into bogus
 *    "unknown reference" noise;
 * 3. cross-record coherence (duplicate identities, duplicate/conflicting rows);
 * 4. domain constructors, whose errors are caught back into the same row/field report.
 *
 * Every rule is runtime validation: unknown fields are rejected recursively, numbers must be
 * finite, dates must be ISO-8601 with a timezone, verdicts/statuses/kinds must be known values,
 * references must resolve inside the same document, and a Codeforces handle is canonicalised
 * case-insensitively through the Codeforces adapter's own helper so an imported account keeps
 * exactly the identity the live adapter would derive.
 */
import { parse as parseCsv } from 'csv-parse/sync';
import {
  SOURCE_PLATFORMS,
  SUBMISSION_VERDICTS,
  accountIdOf,
  contentHashOf,
  createAccount,
  createEditorialSolution,
  createEditorialSource,
  createNormalizedProblem,
  createSourceInstance,
  createSubmission,
  deepFreeze,
  problemKey,
  utf8Bytes,
  type Account,
  type EditorialSolution,
  type NormalizedProblem,
  type PlatformRating,
  type ProblemRef,
  type RawTag,
  type SourceInstance,
  type SourcePlatform,
  type Submission,
  type SubmissionVerdict,
} from '../../domain/index.js';
import type { EditorialFetchResult } from '../../application/ports.js';
import { canonicalCodeforcesHandle } from '../codeforces/account.js';
import {
  MANUAL_CSV_COLUMNS,
  MANUAL_CSV_KINDS,
  MANUAL_EDITORIAL_KINDS,
  MANUAL_EDITORIAL_STATUSES,
  MANUAL_MAX_FIELD_CHARS,
  MANUAL_MAX_ROWS,
  MANUAL_MAX_TEXT_BYTES,
  MANUAL_MAX_TEXT_CHARS,
  MANUAL_SCHEMA_VERSION,
  type ManualCsvKind,
  type ManualCsvOptions,
  type ManualDocument,
  type ManualEditorialEntry,
  type ManualImportIssue,
  type ManualIssueCode,
  type ManualJsonOptions,
  type ManualParseOutcome,
  type ManualPreview,
} from './types.js';

// ---------------------------------------------------------------------------------------
// Shared validation helpers (also used by the adapter)
// ---------------------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
/**
 * Strict ISO-8601 date-time with an explicit timezone. `Date.parse` alone accepts too much
 * (`2024/05/01`, text dates), so the shape is matched here and the calendar is checked below.
 */
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/u;
/** Field names that would carry credentials if the schema accepted them. */
const SECRET_LIKE_FIELD = /(secret|token|password|passwd|cookie|credential|session|authorization|api[-_]?key)/iu;

/**
 * Normalise a strict ISO-8601 timestamp; `null` when the value is not one.
 *
 * Unlike `Date.parse`, an impossible calendar date (`2024-02-30`, month 13, hour 25) is rejected
 * instead of rolling over, so a submission time can never silently move to another day.
 */
export function normalizeManualTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) {
    return null;
  }
  const year = match[1];
  const month = match[2];
  const day = match[3];
  const hour = match[4];
  const minute = match[5];
  const zone = match[8];
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || zone === undefined) {
    return null;
  }
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7];
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
  const fields = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), second] as const;
  const base = Date.UTC(fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], millis);
  const rolloverCheck = new Date(base);
  if (
    rolloverCheck.getUTCFullYear() !== fields[0] ||
    rolloverCheck.getUTCMonth() !== fields[1] ||
    rolloverCheck.getUTCDate() !== fields[2] ||
    rolloverCheck.getUTCHours() !== fields[3] ||
    rolloverCheck.getUTCMinutes() !== fields[4] ||
    rolloverCheck.getUTCSeconds() !== fields[5]
  ) {
    return null; // impossible calendar date or clock time
  }
  if (zone === 'Z') {
    return new Date(base).toISOString();
  }
  const offsetHours = Number(zone.slice(1, 3));
  const offsetMinutes = Number(zone.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) {
    return null;
  }
  const direction = zone.startsWith('+') ? 1 : -1;
  const instant = base - direction * (offsetHours * 60 + offsetMinutes) * 60_000;
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

/**
 * Normalise an absolute `http(s)` attribution URL; `null` for anything else (another protocol,
 * a relative URL, userinfo, or an over-long value). The result is only ever stored or shown —
 * the manual import never fetches it.
 */
export function manualAttributionUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MANUAL_MAX_FIELD_CHARS) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null; // not an absolute URL
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return null;
  }
  return parsed.toString();
}

// ---------------------------------------------------------------------------------------
// Issue plumbing
// ---------------------------------------------------------------------------------------

interface Loc {
  readonly path: string;
  readonly row?: number | null;
  readonly line?: number | null;
  readonly field?: string | null;
}

interface ParseContext {
  readonly issues: ManualImportIssue[];
  readonly row: number | null;
  readonly line: number | null;
}

function fail(issues: ManualImportIssue[], code: ManualIssueCode, message: string, at: Loc): void {
  issues.push({
    code,
    message,
    path: at.path,
    row: at.row ?? null,
    line: at.line ?? null,
    field: at.field ?? null,
  });
}

function loc(path: string, field: string | null, ctx: ParseContext): Loc {
  return { path: field === null ? path : `${path}.${field}`, field, row: ctx.row, line: ctx.line };
}

function messageOf(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.length <= 300 ? message : `${message.slice(0, 300)}...`;
}

function failure(issues: readonly ManualImportIssue[]): ManualParseOutcome {
  return { ok: false, errors: deepFreeze(issues.map((issue) => ({ ...issue }))) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject every field outside the exact schema; credential-looking names get their own code. */
function assertKnownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  ctx: ParseContext,
): void {
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) {
      continue;
    }
    if (SECRET_LIKE_FIELD.test(key)) {
      fail(ctx.issues, 'secret_field', `field "${key}" looks like credential configuration and is never accepted`, {
        path: `${path}.${key}`,
        field: key,
        row: ctx.row,
        line: ctx.line,
      });
    } else {
      fail(ctx.issues, 'unknown_field', `field "${key}" is not part of the manual import schema`, {
        path: `${path}.${key}`,
        field: key,
        row: ctx.row,
        line: ctx.line,
      });
    }
  }
}

/** Run a domain constructor, converting its rejection into the same row/field report. */
function build<T>(ctx: ParseContext, path: string, field: string, make: () => T): T | null {
  try {
    return make();
  } catch (cause) {
    fail(ctx.issues, 'invalid_field', `${field}: ${messageOf(cause)}`, loc(path, field, ctx));
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Scalar readers
// ---------------------------------------------------------------------------------------

function requireText(
  record: Record<string, unknown>,
  key: string,
  path: string,
  ctx: ParseContext,
  maxChars: number = MANUAL_MAX_FIELD_CHARS,
): string | null {
  const value = record[key];
  if (value === undefined) {
    fail(ctx.issues, 'missing_field', `field "${key}" is required`, loc(path, key, ctx));
    return null;
  }
  if (typeof value !== 'string') {
    fail(ctx.issues, 'invalid_field', `field "${key}" must be a string`, loc(path, key, ctx));
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must not be empty`, loc(path, key, ctx));
    return null;
  }
  if (trimmed.length > maxChars) {
    fail(ctx.issues, 'too_large', `field "${key}" must be at most ${maxChars} characters`, loc(path, key, ctx));
    return null;
  }
  if (CONTROL_CHARS.test(trimmed)) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must not contain control characters`, loc(path, key, ctx));
    return null;
  }
  return trimmed;
}

/** Optional short text: absent or explicit `null` mean "not set"; a present value must be usable. */
function nullableText(
  record: Record<string, unknown>,
  key: string,
  path: string,
  ctx: ParseContext,
  maxChars: number = MANUAL_MAX_FIELD_CHARS,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail(ctx.issues, 'invalid_field', `field "${key}" must be a string or null`, loc(path, key, ctx));
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must not be empty when present`, loc(path, key, ctx));
    return null;
  }
  if (trimmed.length > maxChars) {
    fail(ctx.issues, 'too_large', `field "${key}" must be at most ${maxChars} characters`, loc(path, key, ctx));
    return null;
  }
  if (CONTROL_CHARS.test(trimmed)) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must not contain control characters`, loc(path, key, ctx));
    return null;
  }
  return trimmed;
}

/** Long text (statement, solution body) keeps newlines verbatim; blank means "not supplied". */
function longText(
  record: Record<string, unknown>,
  key: string,
  path: string,
  ctx: ParseContext,
  required: boolean,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    if (required) {
      fail(ctx.issues, 'missing_field', `field "${key}" is required`, loc(path, key, ctx));
    }
    return null;
  }
  if (typeof value !== 'string') {
    fail(ctx.issues, 'invalid_field', `field "${key}" must be a string`, loc(path, key, ctx));
    return null;
  }
  if (value.length > MANUAL_MAX_TEXT_CHARS) {
    fail(ctx.issues, 'too_large', `field "${key}" must be at most ${MANUAL_MAX_TEXT_CHARS} characters`, loc(path, key, ctx));
    return null;
  }
  if (value.trim().length === 0) {
    if (required) {
      fail(ctx.issues, 'invalid_field', `field "${key}" must not be empty`, loc(path, key, ctx));
      return null;
    }
    return null;
  }
  return value;
}

function requiredTimestamp(record: Record<string, unknown>, key: string, path: string, ctx: ParseContext): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    fail(ctx.issues, 'missing_field', `field "${key}" is required`, loc(path, key, ctx));
    return null;
  }
  const normalized = normalizeManualTimestamp(value);
  if (normalized === null) {
    fail(
      ctx.issues,
      'invalid_date',
      `field "${key}" must be an ISO-8601 timestamp with a timezone (e.g. 2024-05-06T07:08:09Z)`,
      loc(path, key, ctx),
    );
    return null;
  }
  return normalized;
}

function optionalInteger(record: Record<string, unknown>, key: string, path: string, ctx: ParseContext): number | null {
  const value = record[key];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(ctx.issues, 'invalid_number', `field "${key}" must be a non-negative safe integer when present`, loc(path, key, ctx));
    return null;
  }
  return value;
}

/**
 * Optional non-negative finite number.
 *
 * `memoryKiB` is a fractional quantity in practice (Codeforces reports bytes/1024, e.g.
 * `1.0009765625`), so it must not be coerced to an integer: the exact value is preserved.
 * `null`, negative, `NaN` and infinite values are rejected rather than clamped or rounded.
 */
function optionalNonNegativeNumber(record: Record<string, unknown>, key: string, path: string, ctx: ParseContext): number | null {
  const value = record[key];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(ctx.issues, 'invalid_number', `field "${key}" must be a non-negative finite number when present`, loc(path, key, ctx));
    return null;
  }
  return value;
}

function finiteNumber(record: Record<string, unknown>, key: string, path: string, ctx: ParseContext): number | null {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ctx.issues, 'invalid_number', `field "${key}" must be a finite number`, loc(path, key, ctx));
    return null;
  }
  return value;
}

function readScale(
  record: Record<string, unknown>,
  key: string,
  path: string,
  ctx: ParseContext,
): { min: number; max: number } | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must be an object with finite min/max`, loc(path, key, ctx));
    return null;
  }
  const scalePath = `${path}.${key}`;
  assertKnownFields(value, SCALE_FIELDS, scalePath, ctx);
  const min = finiteNumber(value, 'min', scalePath, ctx);
  const max = finiteNumber(value, 'max', scalePath, ctx);
  if (min === null || max === null) {
    return null;
  }
  if (min > max) {
    fail(ctx.issues, 'invalid_number', 'scale.min must be <= scale.max', loc(scalePath, 'scale', ctx));
    return null;
  }
  return { min, max };
}

function readRatings(
  record: Record<string, unknown>,
  key: string,
  path: string,
  ctx: ParseContext,
): PlatformRating[] | null {
  const value = record[key];
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must be an array of rating objects`, loc(path, key, ctx));
    return null;
  }
  if (value.length > MANUAL_MAX_ROWS) {
    fail(ctx.issues, 'too_many_rows', `field "${key}" has ${value.length} rows; the limit is ${MANUAL_MAX_ROWS}`, loc(path, key, ctx));
    return null;
  }
  const ratings: PlatformRating[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}.${key}[${index}]`;
    const field = `${key}[${index}]`;
    if (!isRecord(entry)) {
      fail(ctx.issues, 'invalid_field', 'a rating must be an object', { path: entryPath, field, row: ctx.row, line: ctx.line });
      return;
    }
    assertKnownFields(entry, RATING_FIELDS, entryPath, ctx);
    const dimension = requireText(entry, 'dimension', entryPath, ctx);
    const raw = requireText(entry, 'raw', entryPath, ctx);
    const rawValue = entry.value;
    let ratingValue: number | string | null = null;
    if (typeof rawValue === 'number') {
      if (Number.isFinite(rawValue)) {
        ratingValue = rawValue;
      } else {
        fail(ctx.issues, 'invalid_number', 'field "value" must be finite', loc(entryPath, 'value', ctx));
      }
    } else if (typeof rawValue === 'string') {
      const text = rawValue.trim();
      if (text.length === 0) {
        fail(ctx.issues, 'invalid_field', 'field "value" must not be empty', loc(entryPath, 'value', ctx));
      } else if (text.length > MANUAL_MAX_FIELD_CHARS) {
        fail(ctx.issues, 'too_large', `field "value" must be at most ${MANUAL_MAX_FIELD_CHARS} characters`, loc(entryPath, 'value', ctx));
      } else {
        ratingValue = text;
      }
    } else {
      fail(
        ctx.issues,
        'invalid_number',
        'field "value" must be a finite number or the platform\'s textual value',
        loc(entryPath, 'value', ctx),
      );
    }
    const scale = readScale(entry, 'scale', entryPath, ctx);
    if (dimension === null || raw === null || ratingValue === null) {
      return;
    }
    ratings.push({ dimension, value: ratingValue, raw, scale });
  });
  return ratings;
}

function readRawTagTexts(record: Record<string, unknown>, key: string, path: string, ctx: ParseContext): string[] | null {
  const value = record[key];
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must be an array of strings`, loc(path, key, ctx));
    return null;
  }
  if (value.length > MANUAL_MAX_ROWS) {
    fail(ctx.issues, 'too_many_rows', `field "${key}" has ${value.length} rows; the limit is ${MANUAL_MAX_ROWS}`, loc(path, key, ctx));
    return null;
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}.${key}[${index}]`;
    const field = `${key}[${index}]`;
    if (typeof entry !== 'string') {
      fail(ctx.issues, 'invalid_field', 'a raw tag must be a string', { path: entryPath, field, row: ctx.row, line: ctx.line });
      return;
    }
    const raw = entry.trim();
    if (raw.length === 0) {
      fail(ctx.issues, 'invalid_field', 'a raw tag must not be empty', { path: entryPath, field, row: ctx.row, line: ctx.line });
      return;
    }
    if (raw.length > MANUAL_MAX_FIELD_CHARS) {
      fail(ctx.issues, 'too_large', `a raw tag must be at most ${MANUAL_MAX_FIELD_CHARS} characters`, {
        path: entryPath,
        field,
        row: ctx.row,
        line: ctx.line,
      });
      return;
    }
    const dedupe = raw.toLowerCase();
    if (seen.has(dedupe)) {
      fail(ctx.issues, 'duplicate_value', `raw tag ${JSON.stringify(raw)} appears more than once`, {
        path: entryPath,
        field,
        row: ctx.row,
        line: ctx.line,
      });
      return;
    }
    seen.add(dedupe);
    tags.push(raw);
  });
  return tags;
}

function readRawTagObjects(
  record: Record<string, unknown>,
  key: string,
  path: string,
  ctx: ParseContext,
  source: SourceInstance,
): RawTag[] | null {
  const value = record[key];
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must be an array of raw tag objects`, loc(path, key, ctx));
    return null;
  }
  const tags: RawTag[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}.${key}[${index}]`;
    const field = `${key}[${index}]`;
    if (!isRecord(entry)) {
      fail(ctx.issues, 'invalid_field', 'a raw tag must be an object', { path: entryPath, field, row: ctx.row, line: ctx.line });
      return;
    }
    assertKnownFields(entry, RAW_TAG_FIELDS, entryPath, ctx);
    const raw = requireText(entry, 'raw', entryPath, ctx);
    const instanceId = requireText(entry, 'sourceInstanceId', entryPath, ctx);
    if (instanceId !== null && instanceId !== source.id) {
      fail(ctx.issues, 'source_mismatch', `raw tag belongs to ${instanceId}, not ${source.id}`, {
        path: entryPath,
        field: 'sourceInstanceId',
        row: ctx.row,
        line: ctx.line,
      });
      return;
    }
    if (raw === null) {
      return;
    }
    const dedupe = raw.toLowerCase();
    if (seen.has(dedupe)) {
      fail(ctx.issues, 'duplicate_value', `raw tag ${JSON.stringify(raw)} appears more than once`, {
        path: entryPath,
        field,
        row: ctx.row,
        line: ctx.line,
      });
      return;
    }
    seen.add(dedupe);
    tags.push({ raw, sourceInstanceId: source.id });
  });
  return tags;
}

// ---------------------------------------------------------------------------------------
// Source, accounts, problems
// ---------------------------------------------------------------------------------------

function readSource(value: unknown, path: string, ctx: ParseContext): SourceInstance | null {
  if (!isRecord(value)) {
    fail(ctx.issues, 'invalid_field', 'source must be an object', { path, row: ctx.row, line: ctx.line });
    return null;
  }
  assertKnownFields(value, SOURCE_FIELDS, path, ctx);
  const platformRaw = value.platform;
  const platform: SourcePlatform | null =
    typeof platformRaw === 'string' ? SOURCE_PLATFORMS.find((candidate) => candidate === platformRaw) ?? null : null;
  if (platform === null) {
    fail(ctx.issues, 'invalid_enum', `field "platform" must be one of: ${SOURCE_PLATFORMS.join(', ')}`, loc(path, 'platform', ctx));
  }
  const baseUrlRaw = requireText(value, 'baseUrl', path, ctx);
  const baseUrl = baseUrlRaw === null ? null : manualAttributionUrl(baseUrlRaw);
  if (baseUrlRaw !== null && baseUrl === null) {
    fail(ctx.issues, 'invalid_url', 'field "baseUrl" must be an absolute http(s) URL without credentials', loc(path, 'baseUrl', ctx));
  }
  const domain = nullableText(value, 'domain', path, ctx);
  const displayName = nullableText(value, 'displayName', path, ctx);
  if (platform === null || baseUrl === null) {
    return null;
  }
  const instance = build(ctx, path, 'source', () =>
    createSourceInstance({ platform, baseUrl, domain, displayName: displayName ?? undefined }),
  );
  if (instance === null) {
    return null;
  }
  const declaredId = value.id;
  if (declaredId !== undefined) {
    if (typeof declaredId !== 'string' || declaredId !== instance.id) {
      fail(
        ctx.issues,
        'invalid_field',
        `field "id" must equal the source id derived from platform and domain (${instance.id})`,
        loc(path, 'id', ctx),
      );
      return null;
    }
  }
  return instance;
}

function codeforcesHandle(handle: string): string | null {
  try {
    return canonicalCodeforcesHandle(handle);
  } catch {
    return null; // reported by the caller with its own field location
  }
}

function readAccountInput(value: unknown, path: string, ctx: ParseContext, source: SourceInstance): Account | null {
  if (!isRecord(value)) {
    fail(ctx.issues, 'invalid_field', 'an account record must be an object', { path, row: ctx.row, line: ctx.line });
    return null;
  }
  const mark = ctx.issues.length;
  assertKnownFields(value, ACCOUNT_FIELDS, path, ctx);
  const handle = requireText(value, 'handle', path, ctx);
  const displayName = nullableText(value, 'displayName', path, ctx);
  const profileUrl = readProfileUrl(value, path, ctx);
  if (ctx.issues.length > mark || handle === null) {
    return null;
  }
  let canonical = handle;
  let originalName: string | null = null;
  if (source.platform === 'codeforces') {
    const canonicalHandle = codeforcesHandle(handle);
    if (canonicalHandle === null) {
      fail(ctx.issues, 'invalid_field', 'field "handle" is not a valid Codeforces handle', loc(path, 'handle', ctx));
      return null;
    }
    canonical = canonicalHandle;
    originalName = canonical === handle ? null : handle;
  }
  return build(ctx, path, 'handle', () =>
    createAccount({
      sourceInstanceId: source.id,
      handle: canonical,
      displayName: displayName ?? originalName,
      profileUrl,
    }),
  );
}

function readNormalizedAccount(
  value: Record<string, unknown>,
  path: string,
  ctx: ParseContext,
  source: SourceInstance,
): Account | null {
  const mark = ctx.issues.length;
  assertKnownFields(value, NORMALIZED_ACCOUNT_FIELDS, path, ctx);
  const id = requireText(value, 'id', path, ctx);
  const instanceId = requireText(value, 'sourceInstanceId', path, ctx);
  const handle = requireText(value, 'handle', path, ctx);
  const displayName = nullableText(value, 'displayName', path, ctx);
  const profileUrl = readProfileUrl(value, path, ctx);
  if (instanceId !== null && instanceId !== source.id) {
    fail(ctx.issues, 'source_mismatch', `normalised account belongs to ${instanceId}, not ${source.id}`, {
      path,
      field: 'sourceInstanceId',
      row: ctx.row,
      line: ctx.line,
    });
  }
  if (handle !== null && source.platform === 'codeforces' && codeforcesHandle(handle) !== handle) {
    fail(ctx.issues, 'invalid_field', 'field "handle" is not the canonical Codeforces form', loc(path, 'handle', ctx));
  }
  let expectedId: string | null = null;
  if (handle !== null) {
    expectedId = build(ctx, path, 'id', () => accountIdOf(source.id, handle));
  }
  if (ctx.issues.length > mark || id === null || handle === null || expectedId === null) {
    return null;
  }
  if (id !== expectedId) {
    fail(ctx.issues, 'invalid_field', 'field "id" does not match sourceInstanceId and handle', loc(path, 'id', ctx));
    return null;
  }
  return deepFreeze({ id: expectedId, sourceInstanceId: source.id, handle, displayName, profileUrl });
}

function readProfileUrl(record: Record<string, unknown>, path: string, ctx: ParseContext): string | null {
  const raw = nullableText(record, 'profileUrl', path, ctx);
  if (raw === null) {
    return null;
  }
  const url = manualAttributionUrl(raw);
  if (url === null) {
    fail(ctx.issues, 'invalid_url', 'field "profileUrl" must be an absolute http(s) URL without credentials', loc(path, 'profileUrl', ctx));
    return null;
  }
  return url;
}

function readProblem(
  value: unknown,
  path: string,
  ctx: ParseContext,
  source: SourceInstance,
  importedAt: string,
): NormalizedProblem | null {
  if (!isRecord(value)) {
    fail(ctx.issues, 'invalid_field', 'a problem record must be an object', { path, row: ctx.row, line: ctx.line });
    return null;
  }
  const mark = ctx.issues.length;
  assertKnownFields(value, PROBLEM_FIELDS, path, ctx);
  const domain = nullableText(value, 'domain', path, ctx);
  const externalKey = requireText(value, 'externalKey', path, ctx);
  const title = requireText(value, 'title', path, ctx);
  const urlRaw = requireText(value, 'url', path, ctx);
  const url = urlRaw === null ? null : manualAttributionUrl(urlRaw);
  if (urlRaw !== null && url === null) {
    fail(ctx.issues, 'invalid_url', 'field "url" must be an absolute http(s) URL without credentials', loc(path, 'url', ctx));
  }
  const statement = longText(value, 'statement', path, ctx, false);
  const rawTags = readRawTagTexts(value, 'rawTags', path, ctx);
  const ratings = readRatings(value, 'ratings', path, ctx);
  if (ctx.issues.length > mark || externalKey === null || title === null || url === null) {
    return null;
  }
  return build(ctx, path, 'problem', () =>
    createNormalizedProblem({
      ref: { sourceInstanceId: source.id, domain, externalKey },
      title,
      url,
      statement,
      fetchedAt: importedAt,
      ratings: ratings ?? [],
      rawTags: rawTags ?? [],
    }),
  );
}

function readNormalizedProblem(
  value: Record<string, unknown>,
  path: string,
  ctx: ParseContext,
  source: SourceInstance,
): NormalizedProblem | null {
  const mark = ctx.issues.length;
  assertKnownFields(value, NORMALIZED_PROBLEM_FIELDS, path, ctx);
  const refValue = value.ref;
  let ref: ProblemRef | null = null;
  if (!isRecord(refValue)) {
    fail(ctx.issues, 'invalid_field', 'normalised problem "ref" must be an object', {
      path: `${path}.ref`,
      field: 'ref',
      row: ctx.row,
      line: ctx.line,
    });
  } else {
    const refPath = `${path}.ref`;
    assertKnownFields(refValue, REF_FIELDS, refPath, ctx);
    const instanceId = requireText(refValue, 'sourceInstanceId', refPath, ctx);
    const refDomain = nullableText(refValue, 'domain', refPath, ctx);
    const externalKey = requireText(refValue, 'externalKey', refPath, ctx);
    if (instanceId !== null && instanceId !== source.id) {
      fail(ctx.issues, 'source_mismatch', `normalised problem belongs to ${instanceId}, not ${source.id}`, {
        path: refPath,
        field: 'sourceInstanceId',
        row: ctx.row,
        line: ctx.line,
      });
    }
    if (externalKey !== null) {
      ref = { sourceInstanceId: source.id, domain: refDomain, externalKey };
    }
  }
  const key = requireText(value, 'key', path, ctx);
  const title = requireText(value, 'title', path, ctx);
  const urlRaw = requireText(value, 'url', path, ctx);
  const url = urlRaw === null ? null : manualAttributionUrl(urlRaw);
  if (urlRaw !== null && url === null) {
    fail(ctx.issues, 'invalid_url', 'field "url" must be an absolute http(s) URL without credentials', loc(path, 'url', ctx));
  }
  const statement = longText(value, 'statement', path, ctx, false);
  const fetchedAt = requiredTimestamp(value, 'fetchedAt', path, ctx);
  const ratings = readRatings(value, 'ratings', path, ctx);
  const rawTags = readRawTagObjects(value, 'rawTags', path, ctx, source);
  if (ctx.issues.length > mark || ref === null || key === null || title === null || url === null || fetchedAt === null) {
    return null;
  }
  const expectedKey = build(ctx, path, 'ref', () => problemKey(ref));
  if (expectedKey === null) {
    return null;
  }
  if (key !== expectedKey) {
    fail(ctx.issues, 'invalid_field', `field "key" must equal the key derived from ref (${expectedKey})`, loc(path, 'key', ctx));
    return null;
  }
  return deepFreeze({
    ref,
    key: expectedKey,
    title,
    url,
    statement,
    ratings: ratings ?? [],
    rawTags: rawTags ?? [],
    fetchedAt,
  });
}

// ---------------------------------------------------------------------------------------
// Submissions and editorials
// ---------------------------------------------------------------------------------------

interface Lookups {
  readonly accounts: ReadonlyMap<string, Account>;
  readonly problems: ReadonlyMap<string, NormalizedProblem>;
}

function accountLookupKey(platform: SourcePlatform, handle: string): string | null {
  return platform === 'codeforces' ? codeforcesHandle(handle) : handle;
}

function problemLookupKey(domain: string | null, externalKey: string): string {
  return `${domain ?? ''}\u0000${externalKey}`;
}

function readVerdict(record: Record<string, unknown>, path: string, ctx: ParseContext): SubmissionVerdict | null {
  const raw = record.verdict;
  const verdict = typeof raw === 'string' ? SUBMISSION_VERDICTS.find((candidate) => candidate === raw) ?? null : null;
  if (verdict === null) {
    fail(ctx.issues, 'invalid_enum', `field "verdict" must be one of: ${SUBMISSION_VERDICTS.join(', ')}`, loc(path, 'verdict', ctx));
  }
  return verdict;
}

function readSubmission(
  value: unknown,
  path: string,
  ctx: ParseContext,
  source: SourceInstance,
  lookups: Lookups,
): Submission | null {
  if (!isRecord(value)) {
    fail(ctx.issues, 'invalid_field', 'a submission record must be an object', { path, row: ctx.row, line: ctx.line });
    return null;
  }
  const mark = ctx.issues.length;
  assertKnownFields(value, SUBMISSION_FIELDS, path, ctx);
  const accountHandle = requireText(value, 'accountHandle', path, ctx);
  const domain = nullableText(value, 'domain', path, ctx);
  const externalKey = requireText(value, 'externalKey', path, ctx);
  const externalId = requireText(value, 'externalId', path, ctx);
  const verdict = readVerdict(value, path, ctx);
  const submittedAt = requiredTimestamp(value, 'submittedAt', path, ctx);
  const language = nullableText(value, 'language', path, ctx);
  const timeMs = optionalInteger(value, 'timeMs', path, ctx);
  const memoryKiB = optionalNonNegativeNumber(value, 'memoryKiB', path, ctx);
  if (ctx.issues.length > mark || accountHandle === null || externalKey === null || externalId === null) {
    return null;
  }
  const lookupKey = accountLookupKey(source.platform, accountHandle);
  if (lookupKey === null) {
    fail(ctx.issues, 'invalid_field', 'field "accountHandle" is not a valid Codeforces handle', loc(path, 'accountHandle', ctx));
    return null;
  }
  const account = lookups.accounts.get(lookupKey);
  if (account === undefined) {
    fail(ctx.issues, 'unknown_reference', `field "accountHandle" does not match any account of ${source.id}`, loc(path, 'accountHandle', ctx));
    return null;
  }
  const problem = lookups.problems.get(problemLookupKey(domain, externalKey));
  if (problem === undefined) {
    fail(
      ctx.issues,
      'unknown_reference',
      `no problem with domain ${JSON.stringify(domain)} and externalKey ${JSON.stringify(externalKey)} exists in this document`,
      loc(path, 'externalKey', ctx),
    );
    return null;
  }
  if (verdict === null || submittedAt === null) {
    return null;
  }
  return build(ctx, path, 'submission', () =>
    createSubmission({
      accountId: account.id,
      ref: problem.ref,
      externalId,
      verdict,
      submittedAt,
      language,
      timeMs,
      memoryKb: memoryKiB,
    }),
  );
}

function readSolutions(
  record: Record<string, unknown>,
  key: string,
  path: string,
  ctx: ParseContext,
  sourceId: string,
): EditorialSolution[] | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    fail(ctx.issues, 'invalid_field', `field "${key}" must be an array of solutions`, loc(path, key, ctx));
    return null;
  }
  if (value.length > MANUAL_MAX_ROWS) {
    fail(ctx.issues, 'too_many_rows', `field "${key}" has ${value.length} rows; the limit is ${MANUAL_MAX_ROWS}`, loc(path, key, ctx));
    return null;
  }
  const solutions: EditorialSolution[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}.${key}[${index}]`;
    const field = `${key}[${index}]`;
    if (!isRecord(entry)) {
      fail(ctx.issues, 'invalid_field', 'a solution must be an object', { path: entryPath, field, row: ctx.row, line: ctx.line });
      return;
    }
    assertKnownFields(entry, EDITORIAL_SOLUTION_FIELDS, entryPath, ctx);
    const title = requireText(entry, 'title', entryPath, ctx);
    const text = longText(entry, 'text', entryPath, ctx, true);
    const language = nullableText(entry, 'language', entryPath, ctx);
    if (title === null || text === null) {
      return;
    }
    const solution = build(ctx, entryPath, 'text', () =>
      createEditorialSolution({
        solutionId: `${sourceId}-s${index + 1}`,
        sourceId,
        ordinal: index,
        title,
        text,
        language,
      }),
    );
    if (solution !== null) {
      solutions.push(solution);
    }
  });
  return solutions;
}

function readEditorial(
  value: unknown,
  path: string,
  ctx: ParseContext,
  lookups: Lookups,
  importedAt: string,
): ManualEditorialEntry | null {
  if (!isRecord(value)) {
    fail(ctx.issues, 'invalid_field', 'an editorial record must be an object', { path, row: ctx.row, line: ctx.line });
    return null;
  }
  const mark = ctx.issues.length;
  assertKnownFields(value, EDITORIAL_FIELDS, path, ctx);
  const domain = nullableText(value, 'domain', path, ctx);
  const externalKey = requireText(value, 'externalKey', path, ctx);
  const statusRaw = value.status;
  const status = typeof statusRaw === 'string' ? MANUAL_EDITORIAL_STATUSES.find((candidate) => candidate === statusRaw) ?? null : null;
  if (status === null) {
    fail(ctx.issues, 'invalid_enum', `field "status" must be one of: ${MANUAL_EDITORIAL_STATUSES.join(', ')}`, loc(path, 'status', ctx));
  }
  const urlRaw = requireText(value, 'url', path, ctx);
  const url = urlRaw === null ? null : manualAttributionUrl(urlRaw);
  if (urlRaw !== null && url === null) {
    fail(ctx.issues, 'invalid_url', 'field "url" must be an absolute http(s) URL without credentials', loc(path, 'url', ctx));
  }
  const title = requireText(value, 'title', path, ctx);
  const note = nullableText(value, 'note', path, ctx);
  const kindRaw = value.kind;
  const kind =
    kindRaw === undefined || kindRaw === null
      ? 'editorial'
      : typeof kindRaw === 'string'
        ? MANUAL_EDITORIAL_KINDS.find((candidate) => candidate === kindRaw) ?? null
        : null;
  if (kind === null) {
    fail(ctx.issues, 'invalid_enum', `field "kind" must be one of: ${MANUAL_EDITORIAL_KINDS.join(', ')}`, loc(path, 'kind', ctx));
  }
  const language = nullableText(value, 'language', path, ctx);
  if (ctx.issues.length > mark || status === null || kind === null || url === null || title === null || externalKey === null) {
    return null;
  }
  const problem = lookups.problems.get(problemLookupKey(domain, externalKey));
  if (problem === undefined) {
    fail(
      ctx.issues,
      'unknown_reference',
      `no problem with domain ${JSON.stringify(domain)} and externalKey ${JSON.stringify(externalKey)} exists in this document`,
      loc(path, 'externalKey', ctx),
    );
    return null;
  }
  const sourceId = `manual-editorial-${contentHashOf({ problemKey: problem.key, url })}`;
  const solutions = readSolutions(value, 'solutions', path, ctx, sourceId);
  if (ctx.issues.length > mark) {
    return null;
  }
  if (status === 'absent') {
    if (note === null) {
      fail(ctx.issues, 'invalid_field', 'an absent editorial requires a non-empty "note" recording the deliberate declaration', loc(path, 'note', ctx));
      return null;
    }
    if (solutions !== null && solutions.length > 0) {
      fail(ctx.issues, 'invalid_field', 'an absent editorial must not carry solutions', loc(path, 'solutions', ctx));
      return null;
    }
    return deepFreeze({
      problemKey: problem.key,
      ref: problem.ref,
      status,
      url,
      title,
      note,
      result: { status: 'absent', detail: note } satisfies EditorialFetchResult,
    });
  }
  if (solutions === null || solutions.length === 0) {
    fail(ctx.issues, 'missing_field', 'a found editorial requires at least one solution', loc(path, 'solutions', ctx));
    return null;
  }
  // The source body is exactly the declared solution texts; the hash is derived from them, and
  // every solution keeps its own verbatim text and hash.
  const editorialSource = build(ctx, path, 'solutions', () =>
    createEditorialSource({
      id: sourceId,
      kind,
      url,
      title,
      availability: 'found',
      retrievedAt: importedAt,
      text: solutions.map((solution) => solution.text).join('\n\n'),
      language,
      note,
    }),
  );
  if (editorialSource === null) {
    return null;
  }
  return deepFreeze({
    problemKey: problem.key,
    ref: problem.ref,
    status,
    url,
    title,
    note,
    result: {
      status: 'found',
      sources: [editorialSource],
      solutions,
      retrievedAt: importedAt,
    } satisfies EditorialFetchResult,
  });
}

/** A problem without an editorial record stays explicitly unavailable, never "absent". */
function unavailableEditorial(problem: NormalizedProblem): ManualEditorialEntry {
  return deepFreeze({
    problemKey: problem.key,
    ref: problem.ref,
    status: 'unavailable',
    url: null,
    title: null,
    note: null,
    result: {
      status: 'unavailable',
      detail: 'no editorial record was supplied for this problem',
      retryable: false,
    } satisfies EditorialFetchResult,
  });
}

// ---------------------------------------------------------------------------------------
// Collection readers, duplicates and document assembly
// ---------------------------------------------------------------------------------------

function readAccountContexts(values: readonly unknown[], source: SourceInstance, ctx: ParseContext): Account[] {
  const accounts: Account[] = [];
  values.forEach((value, index) => {
    const path = `$.accounts[${index}]`;
    const rowCtx: ParseContext = { issues: ctx.issues, row: index + 1, line: null };
    const account =
      isRecord(value) && ('id' in value || 'sourceInstanceId' in value)
        ? readNormalizedAccount(value, path, rowCtx, source)
        : readAccountInput(value, path, rowCtx, source);
    if (account !== null) {
      accounts.push(account);
    }
  });
  return accounts;
}

function readProblemContexts(values: readonly unknown[], source: SourceInstance, importedAt: string, ctx: ParseContext): NormalizedProblem[] {
  const problems: NormalizedProblem[] = [];
  values.forEach((value, index) => {
    const path = `$.problems[${index}]`;
    const rowCtx: ParseContext = { issues: ctx.issues, row: index + 1, line: null };
    const problem =
      isRecord(value) && ('key' in value || 'ref' in value)
        ? readNormalizedProblem(value, path, rowCtx, source)
        : readProblem(value, path, rowCtx, source, importedAt);
    if (problem !== null) {
      problems.push(problem);
    }
  });
  return problems;
}

function readProblems(values: readonly unknown[], source: SourceInstance, importedAt: string, ctx: ParseContext): NormalizedProblem[] {
  const problems: NormalizedProblem[] = [];
  values.forEach((value, index) => {
    const problem = readProblem(value, `$.problems[${index}]`, { issues: ctx.issues, row: index + 1, line: null }, source, importedAt);
    if (problem !== null) {
      problems.push(problem);
    }
  });
  return problems;
}

function readSubmissions(values: readonly unknown[], source: SourceInstance, lookups: Lookups, ctx: ParseContext): Submission[] {
  const submissions: Submission[] = [];
  values.forEach((value, index) => {
    const submission = readSubmission(value, `$.submissions[${index}]`, { issues: ctx.issues, row: index + 1, line: null }, source, lookups);
    if (submission !== null) {
      submissions.push(submission);
    }
  });
  return submissions;
}

function readEditorials(
  values: readonly unknown[],
  lookups: Lookups,
  importedAt: string,
  ctx: ParseContext,
): ManualEditorialEntry[] {
  const byProblem = new Map<string, ManualEditorialEntry>();
  values.forEach((value, index) => {
    const entry = readEditorial(value, `$.editorials[${index}]`, { issues: ctx.issues, row: index + 1, line: null }, lookups, importedAt);
    if (entry === null) {
      return;
    }
    if (byProblem.has(entry.problemKey)) {
      fail(ctx.issues, 'duplicate_id', `row ${index + 1} declares a second editorial for problem ${entry.problemKey}`, {
        path: `$.editorials[${index}]`,
        row: index + 1,
      });
      return;
    }
    byProblem.set(entry.problemKey, entry);
  });
  return [...lookups.problems.values()].map((problem) => byProblem.get(problem.key) ?? unavailableEditorial(problem));
}

function accountIndex(accounts: readonly Account[], platform: SourcePlatform): ReadonlyMap<string, Account> {
  const index = new Map<string, Account>();
  for (const account of accounts) {
    const key = accountLookupKey(platform, account.handle);
    if (key !== null) {
      index.set(key, account);
    }
  }
  return index;
}

function problemIndex(problems: readonly NormalizedProblem[]): ReadonlyMap<string, NormalizedProblem> {
  const index = new Map<string, NormalizedProblem>();
  for (const problem of problems) {
    index.set(problemLookupKey(problem.ref.domain, problem.ref.externalKey), problem);
  }
  return index;
}

/** Reject duplicate identities outright: identical rows are reported, never silently merged. */
function detectDuplicates<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  pathPrefix: string,
  ctx: ParseContext,
  submissions: boolean,
): void {
  const seen = new Map<string, T>();
  items.forEach((item, index) => {
    const key = keyOf(item);
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, item);
      return;
    }
    if (submissions && contentHashOf(previous) === contentHashOf(item)) {
      fail(ctx.issues, 'duplicate_row', `row ${index + 1} repeats an identical submission; remove the duplicate`, {
        path: `${pathPrefix}[${index}]`,
        row: index + 1,
      });
    } else if (submissions) {
      fail(ctx.issues, 'duplicate_conflict', `row ${index + 1} repeats submission identity ${key} with different content`, {
        path: `${pathPrefix}[${index}]`,
        row: index + 1,
      });
    } else {
      fail(ctx.issues, 'duplicate_id', `row ${index + 1} repeats identity ${key}`, {
        path: `${pathPrefix}[${index}]`,
        row: index + 1,
      });
    }
  });
}

interface DocumentParts {
  readonly source: SourceInstance;
  readonly accounts: readonly Account[];
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  readonly editorials: readonly ManualEditorialEntry[];
  readonly importedAt: string;
  readonly rows: number;
  readonly bytes: number;
}

/**
 * Canonical content projection used for the document hash.
 *
 * Every *semantic* field of the parsed document is covered — the whole source instance (including
 * `displayName` and `baseUrl`, which can change while the derived id stays the same), accounts,
 * problems, submissions and each editorial entry with its source/solution ids, kinds, titles,
 * languages, availability, notes and derived content hashes. Only observation timestamps
 * (`importedAt`, `fetchedAt`, `retrievedAt`) are excluded, so re-parsing the same text at another
 * time yields the same hash while any metadata or content change yields a different one.
 *
 * Large bodies are represented by their derived hashes (`EditorialSource.contentHash`,
 * `EditorialSolution.contentHash`, submissions' own text is not stored), so the projection stays
 * cheap without losing the ability to detect a text edit.
 */
function fingerprintOf(parts: DocumentParts): unknown {
  return {
    schemaVersion: MANUAL_SCHEMA_VERSION,
    source: { ...parts.source },
    accounts: parts.accounts.map((account) => ({ ...account })),
    problems: parts.problems.map((problem) => ({
      ref: { ...problem.ref },
      key: problem.key,
      title: problem.title,
      url: problem.url,
      statement: problem.statement,
      ratings: problem.ratings.map((rating) => ({ ...rating })),
      rawTags: problem.rawTags.map((tag) => ({ ...tag })),
    })),
    submissions: parts.submissions.map((submission) => ({
      id: submission.id,
      accountId: submission.accountId,
      ref: { ...submission.ref },
      key: submission.key,
      externalId: submission.externalId,
      verdict: submission.verdict,
      submittedAt: submission.submittedAt,
      language: submission.language,
      timeMs: submission.timeMs,
      memoryKb: submission.memoryKb,
    })),
    editorials: parts.editorials.map((entry) => ({
      problemKey: entry.problemKey,
      ref: { ...entry.ref },
      status: entry.status,
      url: entry.url,
      title: entry.title,
      note: entry.note,
      result: editorialResultFingerprint(entry.result),
    })),
  };
}

/** Editorial result projection: source/solution metadata and derived hashes, without `retrievedAt`. */
function editorialResultFingerprint(result: EditorialFetchResult): unknown {
  if (result.status !== 'found') {
    return { ...result };
  }
  return {
    status: 'found',
    sources: result.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      url: source.url,
      title: source.title,
      author: source.author,
      language: source.language,
      publishedAt: source.publishedAt,
      availability: source.availability,
      contentHash: source.contentHash,
      note: source.note,
    })),
    solutions: result.solutions.map((solution) => ({
      solutionId: solution.solutionId,
      sourceId: solution.sourceId,
      ordinal: solution.ordinal,
      title: solution.title,
      contentHash: solution.contentHash,
      language: solution.language,
    })),
  };
}

function buildDocument(parts: DocumentParts): ManualDocument {
  const preview: ManualPreview = deepFreeze({
    accounts: parts.accounts.length,
    problems: parts.problems.length,
    submissions: parts.submissions.length,
    editorialsFound: parts.editorials.filter((entry) => entry.status === 'found').length,
    editorialsAbsent: parts.editorials.filter((entry) => entry.status === 'absent').length,
    editorialsUnavailable: parts.editorials.filter((entry) => entry.status === 'unavailable').length,
    rows: parts.rows,
    bytes: parts.bytes,
  });
  return deepFreeze({
    schemaVersion: MANUAL_SCHEMA_VERSION,
    source: parts.source,
    accounts: parts.accounts,
    problems: parts.problems,
    submissions: parts.submissions,
    editorials: parts.editorials,
    contentHash: contentHashOf(fingerprintOf(parts)),
    importedAt: parts.importedAt,
    preview,
  });
}

function readImportedAt(options: { readonly importedAt?: unknown }, ctx: ParseContext): string | null {
  if (options.importedAt === undefined) {
    return new Date().toISOString();
  }
  const normalized = normalizeManualTimestamp(options.importedAt);
  if (normalized === null) {
    fail(ctx.issues, 'invalid_date', 'importedAt must be an ISO-8601 timestamp with a timezone (e.g. 2024-05-06T07:08:09Z)', {
      path: '$.importedAt',
      field: 'importedAt',
    });
    return null;
  }
  return normalized;
}

function readArray(value: unknown, path: string, ctx: ParseContext): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    if (value === undefined) {
      fail(ctx.issues, 'missing_field', `${path} is required`, { path });
    } else {
      fail(ctx.issues, 'invalid_field', `${path} must be an array`, { path });
    }
    return null;
  }
  if (value.length > MANUAL_MAX_ROWS) {
    fail(ctx.issues, 'too_many_rows', `${path} has ${value.length} rows; the limit is ${MANUAL_MAX_ROWS}`, { path });
    return null;
  }
  return value;
}

function jsonErrorLine(text: string, cause: unknown): number | null {
  const message = messageOf(cause);
  const lineMatch = /line (\d+)/u.exec(message);
  if (lineMatch?.[1] !== undefined) {
    return Number(lineMatch[1]);
  }
  const positionMatch = /position (\d+)/u.exec(message);
  if (positionMatch?.[1] === undefined) {
    return null;
  }
  const position = Number(positionMatch[1]);
  let line = 1;
  for (let index = 0; index < position && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

// ---------------------------------------------------------------------------------------
// JSON entry point
// ---------------------------------------------------------------------------------------

/**
 * Parse a version 1 JSON interchange document.
 *
 * Returns `{ ok: true, document }` only when every record validated; otherwise `{ ok: false,
 * errors }` with one entry per rejection carrying `path`/`row`/`field`. Nothing is ever written
 * or partially applied.
 */
export function parseManualJson(text: string, options: ManualJsonOptions = {}): ManualParseOutcome {
  const ctx: ParseContext = { issues: [], row: null, line: null };
  if (typeof text !== 'string') {
    fail(ctx.issues, 'invalid_input', 'the JSON input must be a string', { path: '$' });
    return failure(ctx.issues);
  }
  const bytes = utf8Bytes(text).length;
  if (bytes > MANUAL_MAX_TEXT_BYTES) {
    fail(ctx.issues, 'too_large', `the input is ${bytes} bytes; the limit is ${MANUAL_MAX_TEXT_BYTES}`, { path: '$' });
    return failure(ctx.issues);
  }
  if (!isRecord(options)) {
    fail(ctx.issues, 'invalid_input', 'options must be an object', { path: '$' });
    return failure(ctx.issues);
  }
  const importedAt = readImportedAt(options, ctx);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    fail(ctx.issues, 'invalid_json', `the input is not valid JSON: ${messageOf(cause)}`, {
      path: '$',
      line: jsonErrorLine(text, cause),
    });
    return failure(ctx.issues);
  }
  if (importedAt === null || ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  const document = readJsonRoot(raw, importedAt, bytes, ctx);
  return document === null ? failure(ctx.issues) : { ok: true, document };
}

function readJsonRoot(raw: unknown, importedAt: string, bytes: number, ctx: ParseContext): ManualDocument | null {
  if (!isRecord(raw)) {
    fail(ctx.issues, 'invalid_json', 'the JSON document must be an object', { path: '$' });
    return null;
  }
  assertKnownFields(raw, ROOT_FIELDS, '$', ctx);
  if (raw.schemaVersion !== MANUAL_SCHEMA_VERSION) {
    fail(ctx.issues, 'invalid_input', `field "schemaVersion" must be the number ${MANUAL_SCHEMA_VERSION}`, {
      path: '$.schemaVersion',
      field: 'schemaVersion',
    });
  }
  const source = readSource(raw.source, '$.source', ctx);
  const accountsRaw = readArray(raw.accounts, '$.accounts', ctx);
  if (source === null || accountsRaw === null) {
    return null;
  }
  // Each phase may only be stopped by its *own* rejections; a root-level unknown field (for
  // example) must not hide row errors that are still worth reporting.
  let mark = ctx.issues.length;
  const accounts = readAccountContexts(accountsRaw, source, ctx);
  detectDuplicates(accounts, (account) => account.id, '$.accounts', ctx, false);
  if (ctx.issues.length > mark) {
    return null;
  }
  const problemsRaw = readArray(raw.problems, '$.problems', ctx);
  if (problemsRaw === null) {
    return null;
  }
  mark = ctx.issues.length;
  const problems = readProblems(problemsRaw, source, importedAt, ctx);
  detectDuplicates(problems, (problem) => problem.key, '$.problems', ctx, false);
  if (ctx.issues.length > mark) {
    return null;
  }
  const lookups: Lookups = { accounts: accountIndex(accounts, source.platform), problems: problemIndex(problems) };
  const submissionsRaw = readArray(raw.submissions, '$.submissions', ctx);
  if (submissionsRaw === null) {
    return null;
  }
  mark = ctx.issues.length;
  const submissions = readSubmissions(submissionsRaw, source, lookups, ctx);
  detectDuplicates(submissions, (submission) => submission.id, '$.submissions', ctx, true);
  if (ctx.issues.length > mark) {
    return null;
  }
  const editorialsRaw = readArray(raw.editorials, '$.editorials', ctx);
  if (editorialsRaw === null) {
    return null;
  }
  mark = ctx.issues.length;
  const editorials = readEditorials(editorialsRaw, lookups, importedAt, ctx);
  if (ctx.issues.length > 0) {
    return null;
  }
  return buildDocument({
    source,
    accounts,
    problems,
    submissions,
    editorials,
    importedAt,
    rows: accountsRaw.length + problemsRaw.length + submissionsRaw.length + editorialsRaw.length,
    bytes,
  });
}

// ---------------------------------------------------------------------------------------
// CSV entry point
// ---------------------------------------------------------------------------------------

interface CsvRow {
  /** 1-based record number including the header (header is record 1). */
  readonly record: number;
  /** 1-based data row, header excluded. */
  readonly row: number;
  /** Physical first line of the record. */
  readonly line: number;
  readonly cells: readonly string[];
}

const INVALID_CELL = Symbol('invalid-json-cell');

/**
 * Parse the physical records of one CSV table.
 *
 * Materialisation is bounded: `to` stops the parser after the header, the row limit and one
 * overflow record, so a table of millions of tiny records is never fully materialised; the
 * caller turns that overflow into an explicit rejection instead of truncating silently.
 *
 * Line numbers come from the parser's own counters. `info.lines` is the cumulative number of
 * physical lines processed (including skipped blanks and the inner lines of a quoted cell) and
 * `info.empty_lines` the cumulative number of skipped blank lines, so a record starts on
 * `previousLines + emptyLinesDelta + 1`. That stays correct for a BOM, CRLF, leading or
 * interspersed blank lines and multiline quoted records, where `line += span` does not.
 */
function parseCsvRows(text: string, ctx: ParseContext): CsvRow[] | null {
  let parsed: unknown;
  try {
    parsed = parseCsv(text, {
      bom: true,
      columns: false,
      info: true,
      skip_empty_lines: true,
      to: MANUAL_MAX_ROWS + 2,
    });
  } catch (cause) {
    fail(ctx.issues, 'invalid_csv', `the CSV text is malformed: ${messageOf(cause)}`, {
      path: '$',
      line: csvErrorLine(cause),
    });
    return null;
  }
  if (!Array.isArray(parsed)) {
    fail(ctx.issues, 'invalid_csv', 'the CSV parser returned an unexpected shape', { path: '$' });
    return null;
  }
  const rows: CsvRow[] = [];
  let previousLines = 0;
  let previousEmptyLines = 0;
  parsed.forEach((element) => {
    let cells: unknown[];
    let rawInfo: unknown;
    if (Array.isArray(element)) {
      cells = element;
      rawInfo = null;
    } else if (isRecord(element) && Array.isArray(element.record)) {
      cells = element.record;
      rawInfo = element.info;
    } else {
      fail(ctx.issues, 'invalid_csv', 'the CSV parser returned a record without cells', { path: '$', line: previousLines + 1 });
      return;
    }
    const info = isRecord(rawInfo) ? rawInfo : null;
    const lines =
      typeof info?.lines === 'number' && Number.isInteger(info.lines) && info.lines >= previousLines
        ? info.lines
        : previousLines + 1;
    const emptyLines =
      typeof info?.empty_lines === 'number' && Number.isInteger(info.empty_lines) && info.empty_lines >= previousEmptyLines
        ? info.empty_lines
        : previousEmptyLines;
    const line = previousLines + (emptyLines - previousEmptyLines) + 1;
    const rowCells: string[] = [];
    for (const cell of cells) {
      if (typeof cell !== 'string') {
        fail(ctx.issues, 'invalid_csv', 'a CSV cell is not text', { path: '$', line, field: String(rowCells.length + 1) });
        return;
      }
      rowCells.push(cell);
    }
    rows.push({ record: rows.length + 1, row: rows.length, line, cells: rowCells });
    previousLines = lines;
    previousEmptyLines = emptyLines;
  });
  return ctx.issues.length > 0 ? null : rows;
}

function csvErrorLine(cause: unknown): number | null {
  if (typeof cause === 'object' && cause !== null && 'lines' in cause && typeof cause.lines === 'number') {
    return Number.isInteger(cause.lines) && cause.lines >= 1 ? cause.lines : null;
  }
  return null;
}

/** Exact header validation: no unknown, no duplicated and no missing column. */
function readHeader(header: CsvRow, expected: readonly string[], ctx: ParseContext): ReadonlyMap<string, number> | null {
  const indexByColumn = new Map<string, number>();
  header.cells.forEach((cell, index) => {
    const name = cell.trim();
    if (name.length === 0) {
      fail(ctx.issues, 'invalid_csv', 'header column names must not be empty', { path: '$', line: header.line, field: String(index + 1) });
      return;
    }
    if (indexByColumn.has(name)) {
      fail(ctx.issues, 'invalid_csv', `header column "${name}" appears more than once`, { path: '$', line: header.line, field: name });
      return;
    }
    indexByColumn.set(name, index);
  });
  const missing = expected.filter((column) => !indexByColumn.has(column));
  const unknown = [...indexByColumn.keys()].filter((column) => !expected.includes(column));
  if (missing.length > 0) {
    fail(ctx.issues, 'invalid_csv', `the header is missing required column(s): ${missing.join(', ')}`, {
      path: '$',
      line: header.line,
    });
  }
  if (unknown.length > 0) {
    fail(ctx.issues, 'invalid_csv', `the header has unknown column(s): ${unknown.join(', ')} (allowed: ${expected.join(', ')})`, {
      path: '$',
      line: header.line,
    });
  }
  return missing.length === 0 && unknown.length === 0 ? indexByColumn : null;
}

function parseJsonCell(cell: string, field: string, row: CsvRow, ctx: ParseContext): unknown | typeof INVALID_CELL {
  try {
    return JSON.parse(cell) as unknown;
  } catch (cause) {
    fail(ctx.issues, 'invalid_json', `cell "${field}" must contain JSON: ${messageOf(cause)}`, {
      path: `$.${field}`,
      field,
      row: row.row,
      line: row.line,
    });
    return INVALID_CELL;
  }
}

/** CSV integers stay raw strings when they are not integers, so the reader reports them. */
function cellIntegerOrRaw(cell: string): number | string {
  const trimmed = cell.trim();
  return /^[+-]?\d+$/u.test(trimmed) ? Number(trimmed) : cell;
}

/** CSV numbers (fractions included) become numbers; other or non-finite text stays raw to be reported. */
function cellNumberOrRaw(cell: string): number | string {
  const trimmed = cell.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    return cell;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : cell;
}

function problemCellsToRecord(
  row: CsvRow,
  columnIndex: ReadonlyMap<string, number>,
  ctx: ParseContext,
): Record<string, unknown> | null {
  const cell = (name: string): string | undefined => {
    const index = columnIndex.get(name);
    return index === undefined ? undefined : row.cells[index];
  };
  const record: Record<string, unknown> = {};
  const domain = cell('domain');
  record.domain = domain === undefined || domain.trim() === '' ? null : domain;
  record.externalKey = cell('externalKey') ?? '';
  record.title = cell('title') ?? '';
  record.url = cell('url') ?? '';
  const statement = cell('statement');
  record.statement = statement === undefined || statement.trim() === '' ? null : statement;
  for (const field of ['rawTags', 'ratings'] as const) {
    const raw = cell(field);
    if (raw === undefined || raw.trim() === '') {
      continue;
    }
    const parsed = parseJsonCell(raw, field, row, ctx);
    if (parsed === INVALID_CELL) {
      return null;
    }
    record[field] = parsed;
  }
  return record;
}

function submissionCellsToRecord(row: CsvRow, columnIndex: ReadonlyMap<string, number>): Record<string, unknown> {
  const cell = (name: string): string | undefined => {
    const index = columnIndex.get(name);
    return index === undefined ? undefined : row.cells[index];
  };
  const record: Record<string, unknown> = {};
  record.accountHandle = cell('accountHandle') ?? '';
  const domain = cell('domain');
  record.domain = domain === undefined || domain.trim() === '' ? null : domain;
  record.externalKey = cell('externalKey') ?? '';
  record.externalId = cell('externalId') ?? '';
  record.verdict = cell('verdict') ?? '';
  record.submittedAt = cell('submittedAt') ?? '';
  const language = cell('language');
  if (language !== undefined && language.trim() !== '') {
    record.language = language;
  }
  const timeMs = cell('timeMs');
  if (timeMs !== undefined && timeMs.trim() !== '') {
    record.timeMs = cellIntegerOrRaw(timeMs);
  }
  const memoryKiB = cell('memoryKiB');
  if (memoryKiB !== undefined && memoryKiB.trim() !== '') {
    record.memoryKiB = cellNumberOrRaw(memoryKiB);
  }
  return record;
}

function readValueArray(value: unknown, path: string, ctx: ParseContext): readonly unknown[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(ctx.issues, 'invalid_field', `${path} must be an array when provided`, { path });
    return null;
  }
  if (value.length > MANUAL_MAX_ROWS) {
    fail(ctx.issues, 'too_many_rows', `${path} has ${value.length} rows; the limit is ${MANUAL_MAX_ROWS}`, { path });
    return null;
  }
  return value;
}

/**
 * Parse one CSV table (`problems` or `submissions`).
 *
 * The table carries no source/account declarations of its own: `options.source` supplies the
 * instance (validated exactly like the JSON `source`), `options.accounts`/`options.problems`
 * supply the reference context, and `options.editorials` may attach editorial records. Quoted
 * commas, doubled quotes, multiline cells, a UTF-8 BOM and empty lines are supported; the header
 * must name exactly the columns documented for the kind, in any order.
 */
export function parseManualCsv(text: string, options: ManualCsvOptions): ManualParseOutcome {
  const ctx: ParseContext = { issues: [], row: null, line: null };
  if (typeof text !== 'string') {
    fail(ctx.issues, 'invalid_input', 'the CSV input must be a string', { path: '$' });
    return failure(ctx.issues);
  }
  const bytes = utf8Bytes(text).length;
  if (bytes > MANUAL_MAX_TEXT_BYTES) {
    fail(ctx.issues, 'too_large', `the input is ${bytes} bytes; the limit is ${MANUAL_MAX_TEXT_BYTES}`, { path: '$' });
    return failure(ctx.issues);
  }
  if (!isRecord(options)) {
    fail(ctx.issues, 'invalid_input', 'CSV options are required', { path: '$' });
    return failure(ctx.issues);
  }
  const kindRaw = options.kind;
  const kind: ManualCsvKind | null = typeof kindRaw === 'string' ? MANUAL_CSV_KINDS.find((candidate) => candidate === kindRaw) ?? null : null;
  if (kind === null) {
    fail(ctx.issues, 'invalid_enum', `field "kind" must be one of: ${MANUAL_CSV_KINDS.join(', ')}`, {
      path: '$.kind',
      field: 'kind',
    });
    return failure(ctx.issues);
  }
  const importedAt = readImportedAt(options, ctx);
  const source = readSource(options.source, '$.source', ctx);
  if (importedAt === null || source === null || ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  const rows = parseCsvRows(text, ctx);
  if (rows === null || ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  // `parseCsvRows` capped the parser at header + limit + one overflow record: a full cap means the
  // table really has more rows than allowed, and the import is rejected instead of truncated.
  if (rows.length > MANUAL_MAX_ROWS + 1) {
    fail(ctx.issues, 'too_many_rows', `the CSV table has more than ${MANUAL_MAX_ROWS} data rows; the limit is ${MANUAL_MAX_ROWS}`, {
      path: '$',
    });
    return failure(ctx.issues);
  }
  const header = rows[0];
  if (header === undefined) {
    fail(ctx.issues, 'invalid_csv', 'the CSV text needs a header row', { path: '$', line: 1 });
    return failure(ctx.issues);
  }
  const columns = MANUAL_CSV_COLUMNS[kind];
  const columnIndex = readHeader(header, columns, ctx);
  if (columnIndex === null || ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  const dataRows = rows.slice(1);

  const accountsRaw = readValueArray(options.accounts, '$.accounts', ctx);
  const problemsRaw = readValueArray(options.problems, '$.problems', ctx);
  const editorialsRaw = readValueArray(options.editorials, '$.editorials', ctx);
  if (accountsRaw === null || problemsRaw === null || editorialsRaw === null) {
    return failure(ctx.issues);
  }
  const accounts = readAccountContexts(accountsRaw, source, ctx);
  if (ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  detectDuplicates(accounts, (account) => account.id, '$.accounts', ctx, false);
  if (ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  const contextProblems = readProblemContexts(problemsRaw, source, importedAt, ctx);
  if (ctx.issues.length > 0) {
    return failure(ctx.issues);
  }

  const rowProblems: NormalizedProblem[] = [];
  const submissions: Submission[] = [];
  if (kind === 'problems') {
    dataRows.forEach((row) => {
      const record = problemCellsToRecord(row, columnIndex, ctx);
      if (record === null) {
        return;
      }
      const problem = readProblem(
        record,
        `$.problems[${contextProblems.length + row.row - 1}]`,
        { issues: ctx.issues, row: row.row, line: row.line },
        source,
        importedAt,
      );
      if (problem !== null) {
        rowProblems.push(problem);
      }
    });
  } else {
    const accountIdx = accountIndex(accounts, source.platform);
    const problemIdx = problemIndex(contextProblems);
    if (contextProblems.length > MANUAL_MAX_ROWS) {
      fail(ctx.issues, 'too_many_rows', `$.problems has ${contextProblems.length} rows; the limit is ${MANUAL_MAX_ROWS}`, { path: '$.problems' });
      return failure(ctx.issues);
    }
    dataRows.forEach((row) => {
      const record = submissionCellsToRecord(row, columnIndex);
      const submission = readSubmission(
        record,
        `$.submissions[${row.row - 1}]`,
        { issues: ctx.issues, row: row.row, line: row.line },
        source,
        { accounts: accountIdx, problems: problemIdx },
      );
      if (submission !== null) {
        submissions.push(submission);
      }
    });
  }
  if (ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  const problems = [...contextProblems, ...rowProblems];
  if (problems.length > MANUAL_MAX_ROWS) {
    fail(ctx.issues, 'too_many_rows', `$.problems has ${problems.length} rows; the limit is ${MANUAL_MAX_ROWS}`, { path: '$.problems' });
    return failure(ctx.issues);
  }
  detectDuplicates(problems, (problem) => problem.key, '$.problems', ctx, false);
  if (ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  if (kind === 'submissions') {
    detectDuplicates(submissions, (submission) => submission.id, '$.submissions', ctx, true);
    if (ctx.issues.length > 0) {
      return failure(ctx.issues);
    }
  }
  const lookups: Lookups = { accounts: accountIndex(accounts, source.platform), problems: problemIndex(problems) };
  const editorials = readEditorials(editorialsRaw, lookups, importedAt, ctx);
  if (ctx.issues.length > 0) {
    return failure(ctx.issues);
  }
  return {
    ok: true,
    document: buildDocument({
      source,
      accounts,
      problems,
      submissions,
      editorials,
      importedAt,
      rows: dataRows.length,
      bytes,
    }),
  };
}

// ---------------------------------------------------------------------------------------
// Exact field sets
// ---------------------------------------------------------------------------------------

const ROOT_FIELDS: ReadonlySet<string> = new Set(['schemaVersion', 'source', 'accounts', 'problems', 'submissions', 'editorials']);
const SOURCE_FIELDS: ReadonlySet<string> = new Set(['id', 'platform', 'baseUrl', 'domain', 'displayName']);
const ACCOUNT_FIELDS: ReadonlySet<string> = new Set(['handle', 'displayName', 'profileUrl']);
const NORMALIZED_ACCOUNT_FIELDS: ReadonlySet<string> = new Set(['id', 'sourceInstanceId', 'handle', 'displayName', 'profileUrl']);
const PROBLEM_FIELDS: ReadonlySet<string> = new Set(['domain', 'externalKey', 'title', 'url', 'statement', 'rawTags', 'ratings']);
const NORMALIZED_PROBLEM_FIELDS: ReadonlySet<string> = new Set(['ref', 'key', 'title', 'url', 'statement', 'ratings', 'rawTags', 'fetchedAt']);
const REF_FIELDS: ReadonlySet<string> = new Set(['sourceInstanceId', 'domain', 'externalKey']);
const RATING_FIELDS: ReadonlySet<string> = new Set(['dimension', 'value', 'raw', 'scale']);
const SCALE_FIELDS: ReadonlySet<string> = new Set(['min', 'max']);
const RAW_TAG_FIELDS: ReadonlySet<string> = new Set(['raw', 'sourceInstanceId']);
const SUBMISSION_FIELDS: ReadonlySet<string> = new Set([
  'accountHandle',
  'domain',
  'externalKey',
  'externalId',
  'verdict',
  'submittedAt',
  'language',
  'timeMs',
  'memoryKiB',
]);
const EDITORIAL_FIELDS: ReadonlySet<string> = new Set([
  'domain',
  'externalKey',
  'status',
  'url',
  'title',
  'note',
  'kind',
  'language',
  'solutions',
]);
const EDITORIAL_SOLUTION_FIELDS: ReadonlySet<string> = new Set(['title', 'text', 'language']);
