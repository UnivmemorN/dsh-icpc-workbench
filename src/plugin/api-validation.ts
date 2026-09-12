/**
 * Strict boundary validation of the business API (Stage 4h1).
 *
 * Every endpoint's request is validated here, **before** any read, write or network call: the JSON
 * root must be a plain object, every declared field is checked against its own type and bound, and
 * an unknown own key is refused with the caller's own `reason` instead of being ignored. A silently
 * dropped field would let a UI believe it saved something it did not, and a permissive coercion
 * (`"5"` as a page size, `" true "` as a flag) would let a browser and this boundary disagree.
 *
 * Shape-only checks live here; semantic identity stays where it already belongs — canonical problem
 * keys through the domain's parser, account ids through the store, taxonomy ids through the injected
 * vocabulary and import documents through the manual parser. Several services re-validate the same
 * fields and their refusals are converted by {@link mapBusinessError}, so a value that reaches a
 * service is never trusted merely because it passed this file.
 *
 * All limits the API applies itself are declared here and are at least as tight as the layer below
 * (page limits are the store's own, manual text is the parser's own), so a boundary refusal happens
 * before an unbounded read, an oversized paste or a partially applied document.
 */
import {
  COMPLETION_MODES,
  TRAINING_TASK_KINDS,
  assertIsoTimestamp,
  invariant,
  parseAccountId,
  parseProblemKey,
  problemKey,
  type CancellationToken,
  type DomainError,
} from '../domain/index.js';
import { PlatformError } from '../application/platform-errors.js';
import { STORAGE_PAGE_LIMITS } from '../application/storage-types.js';
import {
  MAX_PLAN_CANDIDATES,
  MAX_PLAN_HORIZON_DAYS,
  MAX_PLAN_MINUTES_PER_DAY,
  MAX_PLAN_ESTIMATED_MINUTES,
  MAX_PLAN_TITLE_CHARS,
  MAX_PROBLEM_QUERY_CHARS,
  MAX_RETROSPECTIVE_IDS,
  MAX_REVIEW_NOTE_CHARS,
} from '../application/workbench-service.js';
import {
  MAX_SUPPLEMENT_STATEMENT_CHARS,
} from '../application/import-types.js';
import {
  WORKBENCH_API_ORIGINS,
  type ApiAccountCreateRequest,
  type ApiImportRequest,
  type ApiManualAccountContext,
  type ApiManualEditorialInput,
  type ApiManualProblemContext,
  type ApiMaterialRefreshRequest,
  type ApiMaterialSupplementRequest,
  type ApiPlanAdoptRequest,
  type ApiPlanCheckoffRequest,
  type ApiPlanDetailRequest,
  type ApiPlanEditRequest,
  type ApiPlanListRequest,
  type ApiPlanPreviewRequest,
  type ApiProblemDetailRequest,
  type ApiProblemListRequest,
  type ApiRetroRecordRequest,
  type ApiReviewTagRequest,
  type ApiSupplementEditorial,
  type ApiSyncPageRequest,
  type ApiWeaknessRequest,
} from '../application/workbench-api.js';
import { ApiTransportError, type ApiErrorCode } from './api-transport.js';

// ---------------------------------------------------------------------------------------
// Limits enforced at the HTTP boundary
// ---------------------------------------------------------------------------------------

/** Longest accepted platform handle (a Luogu UID is at most 20 digits). */
export const MAX_API_HANDLE_CHARS = 64;
/** Longest accepted display name. */
export const MAX_API_DISPLAY_NAME_CHARS = 200;
/** Longest accepted opaque id (account, source instance, plan, task, snapshot). */
export const MAX_API_ID_CHARS = 512;
/** Longest accepted single-line string (title, URL, title-like field). */
export const MAX_API_TEXT_CHARS = 2000;
/** Longest accepted free-text note (supplement note, review note). */
export const MAX_API_NOTE_CHARS = 10_000;
/** Longest accepted `problemKey`; a canonical key is short, so this is a generous hard bound. */
export const MAX_API_PROBLEM_KEY_CHARS = 1024;
/** Largest accepted manual import text, matching the parser's own 8 MiB body bound. */
export const MAX_API_IMPORT_TEXT_CHARS = 8 * 1024 * 1024;
/** Largest accepted `import.csv.accounts`/`import.csv.problems` array. */
export const MAX_API_IMPORT_ROWS = 10_000;
/** Entries of one CSV problem context's `rawTags`. */
export const MAX_API_RAW_TAGS = 200;
/** Entries of one CSV problem context's `ratings`. */
export const MAX_API_RATINGS = 50;
/** Longest accepted statement of a manual import problem context. */
export const MAX_API_MANUAL_STATEMENT_CHARS = MAX_SUPPLEMENT_STATEMENT_CHARS;
/** Largest accepted `problem.list` page. */
export const API_PAGE_LIMITS = STORAGE_PAGE_LIMITS;

/** Curated fixed message per domain code: safe to show, never the service's own detail. */
const DOMAIN_ERROR_MESSAGES: Readonly<Partial<Record<DomainError['code'], string>>> = {
  invalid_input: 'the request is invalid',
  invalid_id_part: 'an identifier in the request is malformed',
  invalid_url: 'a URL in the request is not an absolute http(s) URL',
  invalid_timestamp: 'a timestamp in the request is malformed',
  duplicate_id: 'the request contradicts already stored data',
  missing_reference: 'the request references something that does not exist',
  unknown_taxonomy_id: 'the request names an unknown taxonomy tag',
  non_serializable_content: 'the request carries content the store cannot persist',
  immutable_violation: 'the request contradicts already stored data',
  invalid_transition: 'the request conflicts with the current state',
  cancelled: 'the request was cancelled',
  unfilled_settings: 'the workbench is not configured for this operation',
};

/** Stable transport code each domain code maps to. */
const DOMAIN_ERROR_CODES: Readonly<Partial<Record<DomainError['code'], ApiErrorCode>>> = {
  invalid_input: 'invalid_input',
  invalid_id_part: 'invalid_input',
  invalid_url: 'invalid_input',
  invalid_timestamp: 'invalid_input',
  duplicate_id: 'conflict',
  missing_reference: 'not_found',
  unknown_taxonomy_id: 'invalid_input',
  non_serializable_content: 'conflict',
  immutable_violation: 'conflict',
  invalid_transition: 'conflict',
  cancelled: 'cancelled',
  unfilled_settings: 'internal',
};

/**
 * Reusable mapping of an application failure onto the transport's fixed vocabulary.
 *
 * It exists in one place so later stages (batch/coaching/model work) refuse a request exactly the
 * way this stage does: a {@link DomainError} maps by `code` to a fixed message — its own message and
 * `details` never travel, because they can quote stored rows, prompts or file paths — and anything
 * else becomes the sanitized `internal` failure that the transport reports through its
 * `onInternalError` observer.
 */
export function mapBusinessError(error: unknown): ApiTransportError {
  if (error instanceof ApiTransportError) {
    return error;
  }
  if (isDomainError(error)) {
    const code = DOMAIN_ERROR_CODES[error.code] ?? 'internal';
    return new ApiTransportError(code, DOMAIN_ERROR_MESSAGES[error.code] ?? 'the request failed');
  }
  // Rethrown unchanged: fabricating a transport failure here would hide a programmer bug from the
  // transport's sanitized 500 and from the `onInternalError` observer that diagnoses it.
  throw error;
}

/** Structural `DomainError` check; the class is re-exported by the domain index under one name. */
function isDomainError(error: unknown): error is DomainError {
  return (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { name?: unknown }).name === 'DomainError'
  );
}

/**
 * Safe projection of one **known** operational platform failure.
 *
 * Only the stable code, the retry metadata and the attempt count are kept: `detail` and `sample` may
 * quote the platform's own page and are dropped, while every operational code (auth, forbidden, rate
 * limit, unavailable, changed response) stays distinguishable instead of collapsing into one state.
 *
 * `invalid_input` is not an operational answer but this plugin's own request being refused, and the
 * API vocabulary cannot represent it; it is rethrown so the transport sanitizes it and the observer
 * sees it. An arbitrary exception is not accepted at all — the caller proves it has a real platform
 * failure first, and a programming error is never fabricated into `unavailable`.
 */
export interface PlatformFailureDescriptor {
  readonly code: PlatformError['code'];
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly attempts: number;
}

export function mapPlatformFailure(failure: PlatformError | PlatformFailureDescriptor): {
  readonly code: Exclude<PlatformError['code'], 'invalid_input'>;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly attempts: number;
} {
  if (failure.code === 'invalid_input') {
    throw failure instanceof PlatformError
      ? failure
      : new TypeError('a platform failure descriptor cannot carry invalid_input');
  }
  return {
    code: failure.code,
    retryable: failure.retryable,
    retryAfterMs: failure.retryAfterMs,
    attempts: failure.attempts,
  };
}

// ---------------------------------------------------------------------------------------
// account.create / sync.page
// ---------------------------------------------------------------------------------------

export function validateAccountCreate(value: unknown): ApiAccountCreateRequest {
  const object = plainObject('account.create', value);
  requireKeys('account.create', object, ['platform', 'handle'], ['displayName']);
  const platform = enumValue('platform', object['platform'], WORKBENCH_API_ORIGINS);
  const handle = requiredString('handle', object['handle'], MAX_API_HANDLE_CHARS);
  const displayName =
    object['displayName'] === undefined
      ? undefined
      : optionalString('displayName', object['displayName'], MAX_API_DISPLAY_NAME_CHARS) ?? undefined;
  return displayName === undefined ? { platform, handle } : { platform, handle, displayName };
}

export function validateSyncPage(value: unknown): ApiSyncPageRequest {
  const object = plainObject('sync.page', value);
  requireKeys('sync.page', object, ['sourceInstanceId', 'accountId', 'resource', 'mode', 'limit'], ['since']);
  return {
    sourceInstanceId: requiredString('sourceInstanceId', object['sourceInstanceId'], MAX_API_ID_CHARS),
    accountId: nullableAccountId('accountId', object['accountId']),
    resource: enumValue('resource', object['resource'], ['problems', 'submissions'] as const),
    mode: enumValue('mode', object['mode'], ['start', 'continue', 'restart'] as const),
    ...(object['since'] === undefined ? {} : { since: nullableTimestamp('since', object['since']) }),
    limit: boundedInteger('limit', object['limit'], API_PAGE_LIMITS.minPageSize, API_PAGE_LIMITS.maxPageSize),
  };
}

// ---------------------------------------------------------------------------------------
// import.preview / import.apply
// ---------------------------------------------------------------------------------------

/**
 * `import.preview` request.
 *
 * The confirmation hash belongs to `apply` alone: a preview that carried one would look like it had
 * already been checked, so an unexpected `expectedHash` is refused instead of ignored.
 */
export function validateImportPreview(value: unknown): ApiImportRequest {
  const object = plainObject('import.preview', value);
  requireKeys('import.preview', object, ['format', 'text'], ['csv']);
  return importRequest(object, 'import.preview');
}

/** `import.apply` request: applying without the hash of a previewed document is refused up front. */
export function validateImportApply(value: unknown): ApiImportRequest {
  const object = plainObject('import.apply', value);
  requireKeys('import.apply', object, ['format', 'text', 'expectedHash'], ['csv']);
  return importRequest(object, 'import.apply');
}

/** Shared body of both import operations; `label` only names the origin of a refusal. */
function importRequest(object: Record<string, unknown>, label: string): ApiImportRequest {
  const format = enumValue(`${label}.format`, object['format'], ['json', 'csv'] as const);
  const text = requiredString(`${label}.text`, object['text'], MAX_API_IMPORT_TEXT_CHARS, { allowEmpty: true });
  const csv = object['csv'] === undefined ? undefined : validateCsvContext(object['csv'], format);
  const expectedHash =
    object['expectedHash'] === undefined
      ? undefined
      : requiredString(`${label}.expectedHash`, object['expectedHash'], 64, { exactPattern: /^[0-9a-f]{64}$/u });
  return {
    format,
    text,
    ...(csv === undefined ? {} : { csv }),
    ...(expectedHash === undefined ? {} : { expectedHash }),
  };
}

/** CSV reference context: only untouched interchange records, never a normalized store row. */
function validateCsvContext(value: unknown, format: string): ApiImportRequest['csv'] {
  const object = plainObject('csv', value);
  requireKeys('csv', object, ['kind', 'source'], ['accounts', 'problems', 'editorials']);
  invariant(
    format === 'csv',
    'invalid_input',
    'csv context is only accepted with format "csv"',
    { reason: 'csv_context_without_csv_format' },
  );
  const kind = enumValue('csv.kind', object['kind'], ['problems', 'submissions'] as const);
  const source = validateManualSource(object['source']);
  const accounts =
    object['accounts'] === undefined
      ? undefined
      : arrayValue('csv.accounts', object['accounts'], MAX_API_IMPORT_ROWS, validateManualAccountContext, {
          allowEmpty: true,
        });
  const problems =
    object['problems'] === undefined
      ? undefined
      : arrayValue('csv.problems', object['problems'], MAX_API_IMPORT_ROWS, validateManualProblemContext, {
          allowEmpty: true,
        });
  const editorials =
    object['editorials'] === undefined
      ? undefined
      : arrayValue('csv.editorials', object['editorials'], MAX_API_IMPORT_ROWS, validateManualEditorial, {
          allowEmpty: true,
        });
  return {
    kind,
    source,
    ...(accounts === undefined ? {} : { accounts }),
    ...(problems === undefined ? {} : { problems }),
    ...(editorials === undefined ? {} : { editorials }),
  };
}

function validateManualSource(value: unknown): NonNullable<ApiImportRequest['csv']>['source'] {
  const object = plainObject('csv.source', value);
  requireKeys('csv.source', object, ['platform', 'baseUrl'], ['id', 'domain', 'displayName']);
  const platform = enumValue('csv.source.platform', object['platform'], [
    'manual',
    'codeforces',
    'luogu',
    'hydro',
  ] as const);
  const baseUrl = requiredString('csv.source.baseUrl', object['baseUrl'], MAX_API_TEXT_CHARS);
  // A declared instance id is passed through untouched: the manual parser derives the id from
  // platform plus domain and verifies the declaration itself, so identity is not checked twice.
  const id = object['id'] === undefined ? undefined : requiredString('csv.source.id', object['id'], MAX_API_ID_CHARS);
  const domain =
    object['domain'] === undefined ? undefined : nullableString('csv.source.domain', object['domain'], MAX_API_TEXT_CHARS);
  const displayName =
    object['displayName'] === undefined
      ? undefined
      : requiredString('csv.source.displayName', object['displayName'], MAX_API_DISPLAY_NAME_CHARS);
  return {
    platform,
    baseUrl,
    ...(id === undefined ? {} : { id }),
    ...(domain === undefined ? {} : { domain }),
    ...(displayName === undefined ? {} : { displayName }),
  };
}

function validateManualAccountContext(value: unknown): ApiManualAccountContext {
  const object = plainObject('csv.accounts entry', value);
  requireKeys('csv.accounts entry', object, ['handle'], ['displayName', 'profileUrl']);
  const handle = requiredString('csv.accounts.handle', object['handle'], MAX_API_HANDLE_CHARS);
  const displayName =
    object['displayName'] === undefined
      ? undefined
      : nullableString('csv.accounts.displayName', object['displayName'], MAX_API_DISPLAY_NAME_CHARS);
  const profileUrl =
    object['profileUrl'] === undefined
      ? undefined
      : nullableString('csv.accounts.profileUrl', object['profileUrl'], MAX_API_TEXT_CHARS);
  return {
    handle,
    ...(displayName === undefined ? {} : { displayName }),
    ...(profileUrl === undefined ? {} : { profileUrl }),
  };
}

function validateManualProblemContext(value: unknown): ApiManualProblemContext {
  const object = plainObject('csv.problems entry', value);
  requireKeys(
    'csv.problems entry',
    object,
    ['externalKey', 'title', 'url'],
    ['domain', 'statement', 'rawTags', 'ratings'],
  );
  return {
    ...(object['domain'] === undefined
      ? {}
      : { domain: nullableString('csv.problems.domain', object['domain'], MAX_API_TEXT_CHARS) }),
    externalKey: requiredString('csv.problems.externalKey', object['externalKey'], MAX_API_TEXT_CHARS),
    title: requiredString('csv.problems.title', object['title'], MAX_API_TEXT_CHARS),
    url: requiredString('csv.problems.url', object['url'], MAX_API_TEXT_CHARS),
    ...(object['statement'] === undefined
      ? {}
      : {
          statement: nullableString(
            'csv.problems.statement',
            object['statement'],
            MAX_API_MANUAL_STATEMENT_CHARS,
          ),
        }),
    ...(object['rawTags'] === undefined
      ? {}
      : {
          rawTags: arrayValue(
            'csv.problems.rawTags',
            object['rawTags'],
            MAX_API_RAW_TAGS,
            (entry, path) => requiredString(path, entry, MAX_API_TEXT_CHARS),
            { allowEmpty: true },
          ),
        }),
    ...(object['ratings'] === undefined
      ? {}
      : {
          ratings: arrayValue('csv.problems.ratings', object['ratings'], MAX_API_RATINGS, validateManualRating, {
            allowEmpty: true,
          }),
        }),
  };
}

function validateManualRating(value: unknown): NonNullable<ApiManualProblemContext['ratings']>[number] {
  const object = plainObject('csv.problems.ratings entry', value);
  requireKeys('csv.problems.ratings entry', object, ['dimension', 'value', 'raw'], ['scale']);
  const raw = object['value'];
  invariant(
    (typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'string',
    'invalid_input',
    'csv.problems.ratings.value must be a finite number or a string',
    { reason: 'invalid_rating_value' },
  );
  let scale: { readonly min: number; readonly max: number } | null | undefined;
  if (object['scale'] === undefined) {
    scale = undefined;
  } else if (object['scale'] === null) {
    scale = null;
  } else {
    const scaleObject = plainObject('csv.problems.ratings.scale', object['scale']);
    requireKeys('csv.problems.ratings.scale', scaleObject, ['min', 'max']);
    scale = {
      min: finiteNumber('csv.problems.ratings.scale.min', scaleObject['min']),
      max: finiteNumber('csv.problems.ratings.scale.max', scaleObject['max']),
    };
  }
  return {
    dimension: requiredString('csv.problems.ratings.dimension', object['dimension'], MAX_API_TEXT_CHARS),
    value: raw as number | string,
    raw: requiredString('csv.problems.ratings.raw', object['raw'], MAX_API_TEXT_CHARS),
    ...(scale === undefined ? {} : { scale }),
  };
}

/** Editorial record of a JSON manual document, validated to the parser's own declared shape. */
function validateManualEditorial(value: unknown): ApiManualEditorialInput {
  const object = plainObject('editorials entry', value);
  requireKeys(
    'editorials entry',
    object,
    ['externalKey', 'status', 'url', 'title'],
    ['domain', 'note', 'kind', 'solutions'],
  );
  const status = enumValue('editorials.status', object['status'], ['found', 'absent'] as const);
  const solutions =
    object['solutions'] === undefined
      ? undefined
      : arrayValue('editorials.solutions', object['solutions'], MAX_API_IMPORT_ROWS, (entry) => {
          const solution = plainObject('editorials.solutions entry', entry);
          requireKeys('editorials.solutions entry', solution, ['title', 'text'], ['language']);
          return {
            title: requiredString('editorials.solutions.title', solution['title'], MAX_API_TEXT_CHARS),
            text: requiredString('editorials.solutions.text', solution['text'], MAX_API_MANUAL_STATEMENT_CHARS, {
              allowEmpty: true,
            }),
            ...(solution['language'] === undefined
              ? {}
              : {
                  language: nullableString(
                    'editorials.solutions.language',
                    solution['language'],
                    MAX_API_TEXT_CHARS,
                  ),
                }),
          };
        }, { allowEmpty: status !== 'found' });
  return {
    ...(object['domain'] === undefined
      ? {}
      : { domain: nullableString('editorials.domain', object['domain'], MAX_API_TEXT_CHARS) }),
    externalKey: requiredString('editorials.externalKey', object['externalKey'], MAX_API_TEXT_CHARS),
    status,
    url: requiredString('editorials.url', object['url'], MAX_API_TEXT_CHARS),
    title: requiredString('editorials.title', object['title'], MAX_API_TEXT_CHARS),
    ...(object['note'] === undefined
      ? {}
      : { note: nullableString('editorials.note', object['note'], MAX_API_NOTE_CHARS) }),
    ...(object['kind'] === undefined
      ? {}
      : {
          kind: enumValue('editorials.kind', object['kind'], [
            'editorial',
            'solution',
            'discussion',
            'video',
            'other',
          ] as const),
        }),
    ...(solutions === undefined ? {} : { solutions }),
  };
}

// ---------------------------------------------------------------------------------------
// material.refresh / material.supplement
// ---------------------------------------------------------------------------------------

export function validateMaterialRefresh(value: unknown): ApiMaterialRefreshRequest {
  const object = plainObject('material.refresh', value);
  requireKeys('material.refresh', object, ['problemKey', 'fetchStatement'], ['officialTutorialUrl']);
  return {
    problemKey: problemKeyInput('problemKey', object['problemKey']),
    fetchStatement: booleanValue('fetchStatement', object['fetchStatement']),
    ...(object['officialTutorialUrl'] === undefined
      ? {}
      : {
          officialTutorialUrl: nullableString(
            'officialTutorialUrl',
            object['officialTutorialUrl'],
            MAX_API_TEXT_CHARS,
          ),
        }),
  };
}

export function validateMaterialSupplement(value: unknown): ApiMaterialSupplementRequest {
  const object = plainObject('material.supplement', value);
  requireKeys('material.supplement', object, ['problemKey', 'expectedSnapshotId'], ['statement', 'editorial']);
  const declaration = object['editorial'] === undefined ? undefined : validateSupplementEditorial(object['editorial']);
  let statement: string | undefined;
  if (object['statement'] !== undefined) {
    statement = requiredString('statement', object['statement'], MAX_API_MANUAL_STATEMENT_CHARS, {
      allowEmpty: false,
    });
  }
  invariant(
    statement !== undefined || declaration !== undefined,
    'invalid_input',
    'a supplement needs a statement, an editorial declaration or both',
    { reason: 'empty_supplement' },
  );
  return {
    problemKey: problemKeyInput('problemKey', object['problemKey']),
    expectedSnapshotId: nullableString('expectedSnapshotId', object['expectedSnapshotId'], MAX_API_ID_CHARS),
    ...(statement === undefined ? {} : { statement }),
    ...(declaration === undefined ? {} : { editorial: declaration }),
  };
}

/**
 * One supplied editorial.
 *
 * `found` carries a real body and `absent` an explanation; an operational status is not a
 * declaration and has no place here. The URL is attribution only: it is validated as an absolute
 * http(s) URL and is never fetched by this plugin.
 */
function validateSupplementEditorial(value: unknown): ApiSupplementEditorial {
  const object = plainObject('editorial', value);
  const status = enumValue('editorial.status', object['status'], ['found', 'absent'] as const);
  if (status === 'found') {
    requireKeys('editorial', object, ['status', 'url', 'title', 'text'], ['language']);
    return {
      status,
      url: requiredString('editorial.url', object['url'], MAX_API_TEXT_CHARS),
      title: requiredString('editorial.title', object['title'], MAX_API_TEXT_CHARS),
      text: requiredString('editorial.text', object['text'], MAX_API_MANUAL_STATEMENT_CHARS),
      ...(object['language'] === undefined
        ? {}
        : { language: nullableString('editorial.language', object['language'], MAX_API_TEXT_CHARS) }),
    };
  }
  requireKeys('editorial', object, ['status', 'url', 'title', 'note']);
  return {
    status,
    url: requiredString('editorial.url', object['url'], MAX_API_TEXT_CHARS),
    title: requiredString('editorial.title', object['title'], MAX_API_TEXT_CHARS),
    note: requiredString('editorial.note', object['note'], MAX_API_NOTE_CHARS),
  };
}

// ---------------------------------------------------------------------------------------
// Bank / review / retrospective / weakness
// ---------------------------------------------------------------------------------------

export function validateProblemList(value: unknown): ApiProblemListRequest {
  const object = plainObject('problem.list', value);
  requireKeys('problem.list', object, ['limit'], [
    'sourceInstanceId',
    'accountId',
    'onlyAttempted',
    'query',
    'cursor',
    'reveal',
    'needsReviewOnly',
  ]);
  return {
    ...(object['sourceInstanceId'] === undefined
      ? {}
      : { sourceInstanceId: nullableString('sourceInstanceId', object['sourceInstanceId'], MAX_API_ID_CHARS) }),
    ...(object['accountId'] === undefined
      ? {}
      : { accountId: nullableAccountId('accountId', object['accountId']) }),
    ...(object['onlyAttempted'] === undefined
      ? {}
      : { onlyAttempted: booleanValue('onlyAttempted', object['onlyAttempted']) }),
    ...(object['query'] === undefined
      ? {}
      : { query: nullableString('query', object['query'], MAX_PROBLEM_QUERY_CHARS) }),
    limit: boundedInteger('limit', object['limit'], API_PAGE_LIMITS.minPageSize, API_PAGE_LIMITS.maxPageSize),
    ...(object['cursor'] === undefined
      ? {}
      : { cursor: nullableString('cursor', object['cursor'], MAX_API_ID_CHARS) }),
    ...(object['reveal'] === undefined ? {} : { reveal: booleanValue('reveal', object['reveal']) }),
    ...(object['needsReviewOnly'] === undefined
      ? {}
      : { needsReviewOnly: booleanValue('needsReviewOnly', object['needsReviewOnly']) }),
  };
}

export function validateProblemDetail(value: unknown): ApiProblemDetailRequest {
  const object = plainObject('problem.detail', value);
  requireKeys('problem.detail', object, ['problemKey', 'accountId'], ['reveal']);
  return {
    problemKey: problemKeyInput('problemKey', object['problemKey']),
    accountId: nullableAccountId('accountId', object['accountId']),
    ...(object['reveal'] === undefined ? {} : { reveal: booleanValue('reveal', object['reveal']) }),
  };
}

export function validateReviewTag(value: unknown): ApiReviewTagRequest {
  const object = plainObject('review.tag', value);
  requireKeys('review.tag', object, ['problemKey', 'taxonomyId', 'action'], ['note']);
  return {
    problemKey: problemKeyInput('problemKey', object['problemKey']),
    taxonomyId: requiredString('taxonomyId', object['taxonomyId'], MAX_API_TEXT_CHARS),
    action: enumValue('action', object['action'], ['accept', 'reject'] as const),
    ...(object['note'] === undefined
      ? {}
      : { note: nullableString('note', object['note'], MAX_REVIEW_NOTE_CHARS) }),
  };
}

export function validateRetroRecord(value: unknown): ApiRetroRecordRequest {
  const object = plainObject('retro.record', value);
  requireKeys('retro.record', object, ['problemKey', 'accountId', 'mode'], ['taxonomyIds', 'solutionIds', 'note']);
  return {
    problemKey: problemKeyInput('problemKey', object['problemKey']),
    accountId: accountIdInput('accountId', object['accountId']),
    mode: enumValue('mode', object['mode'], COMPLETION_MODES),
    ...(object['taxonomyIds'] === undefined
      ? {}
      : {
          taxonomyIds: arrayValue(
            'taxonomyIds',
            object['taxonomyIds'],
            MAX_RETROSPECTIVE_IDS,
            (entry, path) => requiredString(path, entry, MAX_API_TEXT_CHARS),
            { allowEmpty: true },
          ),
        }),
    ...(object['solutionIds'] === undefined
      ? {}
      : {
          solutionIds: arrayValue(
            'solutionIds',
            object['solutionIds'],
            MAX_RETROSPECTIVE_IDS,
            (entry, path) => requiredString(path, entry, MAX_API_TEXT_CHARS),
            { allowEmpty: true },
          ),
        }),
    ...(object['note'] === undefined
      ? {}
      : { note: nullableString('note', object['note'], MAX_REVIEW_NOTE_CHARS) }),
  };
}

export function validateWeakness(value: unknown): ApiWeaknessRequest {
  const object = plainObject('weakness', value);
  requireKeys('weakness', object, ['accountId']);
  return { accountId: requiredString('accountId', object['accountId'], MAX_API_ID_CHARS) };
}

// ---------------------------------------------------------------------------------------
// Training plans
// ---------------------------------------------------------------------------------------

export function validatePlanPreview(value: unknown): ApiPlanPreviewRequest {
  const object = plainObject('plan.preview', value);
  requireKeys('plan.preview', object, ['accountId', 'candidateProblemKeys'], [
    'estimatedMinutes',
    'horizonDays',
    'minutesPerDay',
    'title',
    'reveal',
  ]);
  return {
    accountId: accountIdInput('accountId', object['accountId']),
    candidateProblemKeys: arrayValue(
      'candidateProblemKeys',
      object['candidateProblemKeys'],
      MAX_PLAN_CANDIDATES,
      (entry, path) => problemKeyInput(path, entry),
      { allowEmpty: true },
    ),
    ...(object['estimatedMinutes'] === undefined
      ? {}
      : {
          estimatedMinutes: boundedInteger(
            'estimatedMinutes',
            object['estimatedMinutes'],
            1,
            MAX_PLAN_ESTIMATED_MINUTES,
          ),
        }),
    ...(object['horizonDays'] === undefined
      ? {}
      : { horizonDays: boundedInteger('horizonDays', object['horizonDays'], 1, MAX_PLAN_HORIZON_DAYS) }),
    ...(object['minutesPerDay'] === undefined
      ? {}
      : { minutesPerDay: boundedInteger('minutesPerDay', object['minutesPerDay'], 1, MAX_PLAN_MINUTES_PER_DAY) }),
    ...(object['title'] === undefined
      ? {}
      : { title: nullableString('title', object['title'], MAX_PLAN_TITLE_CHARS) }),
    ...(object['reveal'] === undefined ? {} : { reveal: booleanValue('reveal', object['reveal']) }),
  };
}

export function validatePlanList(value: unknown): ApiPlanListRequest {
  const object = plainObject('plan.list', value);
  requireKeys('plan.list', object, ['accountId'], ['reveal']);
  return {
    accountId: accountIdInput('accountId', object['accountId']),
    ...(object['reveal'] === undefined ? {} : { reveal: booleanValue('reveal', object['reveal']) }),
  };
}

export function validatePlanDetail(value: unknown): ApiPlanDetailRequest {
  const object = plainObject('plan.detail', value);
  requireKeys('plan.detail', object, ['planId', 'accountId'], ['reveal']);
  return {
    planId: requiredString('planId', object['planId'], MAX_API_ID_CHARS),
    accountId: accountIdInput('accountId', object['accountId']),
    ...(object['reveal'] === undefined ? {} : { reveal: booleanValue('reveal', object['reveal']) }),
  };
}

/** Expected plan hash is the full sha256 content hash; a prefix or a screen id is not accepted. */
function expectedPlanHash(value: unknown): string {
  return requiredString('expectedHash', value, 64, { exactPattern: /^[0-9a-f]{64}$/u });
}

export function validatePlanAdopt(value: unknown): ApiPlanAdoptRequest {
  const object = plainObject('plan.adopt', value);
  requireKeys('plan.adopt', object, ['planId', 'accountId', 'expectedHash']);
  return {
    planId: requiredString('planId', object['planId'], MAX_API_ID_CHARS),
    accountId: accountIdInput('accountId', object['accountId']),
    expectedHash: expectedPlanHash(object['expectedHash']),
  };
}

export function validatePlanEdit(value: unknown): ApiPlanEditRequest {
  const object = plainObject('plan.edit', value);
  requireKeys('plan.edit', object, ['planId', 'accountId', 'expectedHash', 'taskId', 'patch']);
  return {
    planId: requiredString('planId', object['planId'], MAX_API_ID_CHARS),
    accountId: accountIdInput('accountId', object['accountId']),
    expectedHash: expectedPlanHash(object['expectedHash']),
    taskId: requiredString('taskId', object['taskId'], MAX_API_ID_CHARS),
    patch: validateTaskPatch(object['patch']),
  };
}

/** Only `day`, `minutes` and `kind` are editable; any other field is refused with its own reason. */
function validateTaskPatch(value: unknown): ApiPlanEditRequest['patch'] {
  const object = plainObject('patch', value);
  requireKeys('patch', object, [], ['day', 'minutes', 'kind']);
  invariant(
    object['day'] !== undefined || object['minutes'] !== undefined || object['kind'] !== undefined,
    'invalid_input',
    'a task edit needs at least one of day, minutes or kind',
    { reason: 'empty_patch' },
  );
  return {
    ...(object['day'] === undefined ? {} : { day: integerValue('day', object['day']) }),
    ...(object['minutes'] === undefined ? {} : { minutes: integerValue('minutes', object['minutes']) }),
    ...(object['kind'] === undefined
      ? {}
      : { kind: enumValue('kind', object['kind'], TRAINING_TASK_KINDS) }),
  };
}

export function validatePlanCheckoff(value: unknown): ApiPlanCheckoffRequest {
  const object = plainObject('plan.checkoff', value);
  requireKeys('plan.checkoff', object, ['planId', 'accountId', 'expectedHash', 'taskId', 'status']);
  return {
    planId: requiredString('planId', object['planId'], MAX_API_ID_CHARS),
    accountId: accountIdInput('accountId', object['accountId']),
    expectedHash: expectedPlanHash(object['expectedHash']),
    taskId: requiredString('taskId', object['taskId'], MAX_API_ID_CHARS),
    status: enumValue('status', object['status'], ['done', 'skipped'] as const),
  };
}

// ---------------------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------------------

/**
 * One JSON object with a plain prototype.
 *
 * A JSON body can only produce `Object.prototype`/`null` prototypes, so anything else means the
 * value did not come from the transport; accepting it would let an accessor or a class instance
 * reach a handler and be re-serialized under different data.
 */
function plainObject(label: string, value: unknown): Record<string, unknown> {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `${label} must be a JSON object`,
    { reason: 'not_an_object' },
  );
  const prototype: unknown = Object.getPrototypeOf(value);
  invariant(
    prototype === Object.prototype || prototype === null,
    'invalid_input',
    `${label} must be a plain JSON object`,
    { reason: 'not_a_plain_object' },
  );
  return value as Record<string, unknown>;
}

/** Closed contract: every required key present, no unknown own key accepted. */
function requireKeys(
  label: string,
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const unknown = Object.keys(object).filter((key) => !required.includes(key) && !optional.includes(key));
  invariant(
    unknown.length === 0,
    'invalid_input',
    `${label} carries unknown field(s): ${unknown.join(', ')}`,
    { reason: 'unknown_field', fields: unknown },
  );
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(object, key));
  invariant(
    missing.length === 0,
    'invalid_input',
    `${label} is missing required field(s): ${missing.join(', ')}`,
    { reason: 'missing_field', fields: missing },
  );
}

function requiredString(
  label: string,
  value: unknown,
  maxChars: number,
  options: { readonly allowEmpty?: boolean; readonly exactPattern?: RegExp } = {},
): string {
  invariant(typeof value === 'string', 'invalid_input', `${label} must be a string`, {
    reason: 'not_a_string',
    field: label,
  });
  if (options.allowEmpty !== true) {
    invariant(value.trim().length > 0, 'invalid_input', `${label} must not be blank`, {
      reason: 'blank_string',
      field: label,
    });
  }
  invariant(
    value.length <= maxChars,
    'invalid_input',
    `${label} must be at most ${maxChars} characters`,
    { reason: 'string_too_long', field: label, length: value.length, bound: maxChars },
  );
  if (options.exactPattern !== undefined) {
    invariant(
      options.exactPattern.test(value),
      'invalid_input',
      `${label} has an unexpected shape`,
      { reason: 'unexpected_shape', field: label },
    );
  }
  return value;
}

function nullableString(label: string, value: unknown, maxChars: number): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(label, value, maxChars);
}

function optionalString(label: string, value: unknown, maxChars: number): string | null {
  return nullableString(label, value, maxChars);
}

function booleanValue(label: string, value: unknown): boolean {
  invariant(typeof value === 'boolean', 'invalid_input', `${label} must be a boolean`, {
    reason: 'not_a_boolean',
    field: label,
  });
  return value;
}

function finiteNumber(label: string, value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isFinite(value),
    'invalid_input',
    `${label} must be a finite number`,
    { reason: 'not_a_number', field: label },
  );
  return value;
}

function integerValue(label: string, value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isInteger(value),
    'invalid_input',
    `${label} must be an integer`,
    { reason: 'not_an_integer', field: label },
  );
  return value;
}

function boundedInteger(label: string, value: unknown, min: number, max: number): number {
  const integer = integerValue(label, value);
  invariant(
    integer >= min && integer <= max,
    'invalid_input',
    `${label} must be an integer within ${min}..${max}`,
    { reason: 'out_of_range', field: label, value: integer, min, max },
  );
  return integer;
}

function enumValue<T extends string>(label: string, value: unknown, allowed: readonly T[]): T {
  invariant(
    typeof value === 'string' && allowed.includes(value as T),
    'invalid_input',
    `${label} must be one of: ${allowed.join(', ')}`,
    { reason: 'invalid_enum', field: label, allowed },
  );
  return value as T;
}

/** Bounded array; every entry is validated by `item` so an entry failure names its own index. */
function arrayValue<T>(
  label: string,
  value: unknown,
  maxItems: number,
  item: (entry: unknown, path: string) => T,
  options: { readonly allowEmpty?: boolean } = {},
): readonly T[] {
  invariant(Array.isArray(value), 'invalid_input', `${label} must be an array`, {
    reason: 'not_an_array',
    field: label,
  });
  if (options.allowEmpty !== true) {
    invariant(value.length > 0, 'invalid_input', `${label} must not be empty`, {
      reason: 'empty_array',
      field: label,
    });
  }
  invariant(
    value.length <= maxItems,
    'invalid_input',
    `${label} must hold at most ${maxItems} entries`,
    { reason: 'array_too_long', field: label, length: value.length, bound: maxItems },
  );
  return value.map((entry, index) => item(entry, `${label}[${index}]`));
}

function nullableTimestamp(label: string, value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const text = requiredString(label, value, MAX_API_TEXT_CHARS);
  try {
    return assertIsoTimestamp(label, text);
  } catch (error) {
    if (isDomainError(error)) {
      throw new ApiTransportError('invalid_input', `${label} must be a parseable ISO timestamp`);
    }
    throw error;
  }
}

/**
 * Canonical problem key through the domain's own identity functions.
 *
 * {@link parseProblemKey} proves the key is canonically encoded and {@link problemKey} re-derives it,
 * so this file maintains no second encoding: a key that survived both is exactly the stored identity.
 */
function problemKeyInput(label: string, value: unknown): string {
  const text = requiredString(label, value, MAX_API_PROBLEM_KEY_CHARS);
  try {
    return problemKey(parseProblemKey(text));
  } catch (error) {
    if (isDomainError(error)) {
      throw new ApiTransportError('invalid_input', `${label} is not a canonical problem key`);
    }
    throw error;
  }
}

/** Canonical account id through the domain's own parser, refused before any store lookup or write. */
function accountIdInput(label: string, value: unknown): string {
  const text = requiredString(label, value, MAX_API_ID_CHARS);
  try {
    parseAccountId(text);
    return text;
  } catch (error) {
    if (isDomainError(error)) {
      throw new ApiTransportError('invalid_input', `${label} is not a canonical account id`);
    }
    throw error;
  }
}

/** Nullable variant of {@link accountIdInput}; `null` stays "no account scope". */
function nullableAccountId(label: string, value: unknown): string | null {
  return value === null ? null : accountIdInput(label, value);
}

/**
 * Cancellation is not validation, but every handler starts by proving it has a real token: a
 * handler that received no token could not observe a client abort at all, and "no token" would
 * silently become "never cancelled".
 */
export function requireCallToken(token: CancellationToken | null | undefined): CancellationToken {
  invariant(
    token !== null && token !== undefined && typeof token.throwIfCancelled === 'function',
    'unfilled_settings',
    'the API transport must supply a cancellation token',
  );
  token.throwIfCancelled();
  return token;
}
