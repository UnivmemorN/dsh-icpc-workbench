/**
 * Manual import interchange: schema constants, limits and public shapes.
 *
 * The manual import is a *file* interchange format, not a platform download: a user exports a
 * versioned JSON document (or one CSV table per kind) and the parser turns it into an immutable
 * {@link ManualDocument}. Everything the parser accepts is declared here, so the strict runtime
 * validation in `./parse.ts` and the adapter in `./adapter.ts` share one contract.
 *
 * Deliberate properties:
 * - **Identity is imported, never rewritten.** A document declares exactly one source instance
 *   (`manual`, `codeforces`, `luogu` or `hydro`), and every problem/account keeps that source's
 *   domain/handle identity. A Codeforces supplemental import therefore stays Codeforces; the
 *   adapter never relabels it as manual.
 * - **No credentials are representable.** Every record is validated against an exact field set;
 *   an unknown field is an error, and a credential-looking name is reported as such.
 * - **Text is data.** Statements and editorial solutions are stored verbatim as plain text and
 *   are never rendered as HTML.
 * - **URLs are attribution only.** Every `http(s)` URL is validated (no userinfo, no other
 *   protocol) and is never fetched.
 */
import type {
  Account,
  CreateSourceInstanceInput,
  EditorialSolution,
  EditorialSourceKind,
  NormalizedProblem,
  ProblemRef,
  SourceInstance,
  Submission,
  SubmissionVerdict,
} from '../../domain/index.js';
import type { EditorialFetchResult } from '../../application/ports.js';

/** Version of the JSON interchange document accepted by {@link parseManualJson}. */
export const MANUAL_SCHEMA_VERSION = 1 as const;

/** Maximum UTF-8 size of one input text (JSON document or CSV table). */
export const MANUAL_MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** Maximum rows per array/table (accounts, problems, submissions, editorials). */
export const MANUAL_MAX_ROWS = 10_000;
/** Maximum characters for long text fields (problem statement, editorial solution text). */
export const MANUAL_MAX_TEXT_CHARS = 200_000;
/** Maximum characters for every other string field. */
export const MANUAL_MAX_FIELD_CHARS = 2_000;
/** Maximum `limit` accepted by the manual adapter's paged reads. */
export const MANUAL_MAX_PAGE_LIMIT = 500;

/** CSV table kinds. Editorials are JSON-only (a deliberate user declaration needs a note). */
export const MANUAL_CSV_KINDS = ['problems', 'submissions'] as const;
export type ManualCsvKind = (typeof MANUAL_CSV_KINDS)[number];

/** Editorial source kinds accepted in an interchange record. */
export const MANUAL_EDITORIAL_KINDS: readonly EditorialSourceKind[] = [
  'editorial',
  'solution',
  'discussion',
  'video',
  'other',
];

/** Editorial statuses a manual record may declare; omission means "unavailable", never "absent". */
export const MANUAL_EDITORIAL_STATUSES = ['found', 'absent'] as const;
export type ManualEditorialStatus = (typeof MANUAL_EDITORIAL_STATUSES)[number];

/**
 * Exact CSV columns per kind. Order is free, names are exact (surrounding whitespace is
 * trimmed) and every listed column must be present. `rawTags`/`ratings` cells hold the JSON
 * form of the corresponding JSON-document field; an empty cell means the field is absent.
 */
export const MANUAL_CSV_COLUMNS: Readonly<Record<ManualCsvKind, readonly string[]>> = {
  problems: ['domain', 'externalKey', 'title', 'url', 'statement', 'rawTags', 'ratings'],
  submissions: [
    'accountHandle',
    'domain',
    'externalKey',
    'externalId',
    'verdict',
    'submittedAt',
    'language',
    'timeMs',
    'memoryKiB',
  ],
};

// ---------------------------------------------------------------------------------------
// JSON input schema (version 1)
// ---------------------------------------------------------------------------------------

/**
 * Source declaration. `id` is optional but, when present, must equal the id derived from
 * `platform` + `domain` (`createSourceInstance` semantics); this is how a producer can assert
 * which instance it exported without the parser inventing one.
 */
export interface ManualSourceInput extends CreateSourceInstanceInput {
  readonly id?: string;
}

export interface ManualAccountInput {
  readonly handle: string;
  readonly displayName?: string | null;
  readonly profileUrl?: string | null;
}

export interface ManualRatingInput {
  readonly dimension: string;
  /** Raw platform value: a finite number or the platform's textual form. */
  readonly value: number | string;
  /** Original textual form, preserved exactly. */
  readonly raw: string;
  readonly scale?: { readonly min: number; readonly max: number } | null;
}

/** Problem record. The source instance is implicit (the document's `source`). */
export interface ManualProblemInput {
  /** Optional platform sub-domain; `null`/absent for the instance's default domain. */
  readonly domain?: string | null;
  readonly externalKey: string;
  readonly title: string;
  readonly url: string;
  readonly statement?: string | null;
  readonly rawTags?: readonly string[];
  readonly ratings?: readonly ManualRatingInput[];
}

/** Submission record. Account and problem are referenced by handle and domain/externalKey. */
export interface ManualSubmissionInput {
  readonly accountHandle: string;
  readonly domain?: string | null;
  readonly externalKey: string;
  readonly externalId: string;
  readonly verdict: SubmissionVerdict;
  readonly submittedAt: string;
  readonly language?: string | null;
  /** CPU time in whole milliseconds. */
  readonly timeMs?: number;
  /**
   * Peak memory in KiB. Fractional values are valid and preserved exactly: Codeforces reports
   * bytes/1024, so `1.0009765625` is real data, never rounded to an integer.
   */
  readonly memoryKiB?: number;
}

export interface ManualEditorialSolutionInput {
  readonly title: string;
  readonly text: string;
  readonly language?: string | null;
}

/**
 * Editorial record.
 *
 * `found` requires `url`, `title` and one-or-more solutions. `absent` is only a *deliberate
 * user declaration*: it requires a non-empty `note` describing how absence was established and
 * must not carry solutions. A problem without a record stays `unavailable` — an empty field
 * never proves that no editorial exists.
 */
export interface ManualEditorialInput {
  readonly domain?: string | null;
  readonly externalKey: string;
  readonly status: ManualEditorialStatus;
  readonly url: string;
  readonly title: string;
  readonly note?: string | null;
  readonly kind?: EditorialSourceKind;
  readonly language?: string | null;
  readonly solutions?: readonly ManualEditorialSolutionInput[];
}

/** Shape of the version 1 JSON interchange document. */
export interface ManualJsonDocumentInput {
  readonly schemaVersion: typeof MANUAL_SCHEMA_VERSION;
  readonly source: ManualSourceInput;
  readonly accounts: readonly ManualAccountInput[];
  readonly problems: readonly ManualProblemInput[];
  readonly submissions: readonly ManualSubmissionInput[];
  readonly editorials: readonly ManualEditorialInput[];
}

// ---------------------------------------------------------------------------------------
// Issues and results
// ---------------------------------------------------------------------------------------

/** Why a manual import was rejected. One code per distinguishable failure. */
export type ManualIssueCode =
  | 'invalid_input'
  | 'invalid_json'
  | 'invalid_csv'
  | 'unknown_field'
  | 'secret_field'
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_number'
  | 'invalid_date'
  | 'invalid_url'
  | 'invalid_enum'
  | 'duplicate_id'
  | 'duplicate_row'
  | 'duplicate_conflict'
  | 'duplicate_value'
  | 'unknown_reference'
  | 'source_mismatch'
  | 'too_large'
  | 'too_many_rows';

/**
 * One rejection with a precise location: `path` is the hierarchical JSON/record path, `row` the
 * 1-based row inside its array/table (header excluded for CSV), `line` the physical CSV line and
 * `field` the offending field name.
 */
export interface ManualImportIssue {
  readonly code: ManualIssueCode;
  readonly message: string;
  readonly path: string;
  readonly row: number | null;
  readonly line: number | null;
  readonly field: string | null;
}

/** Parse outcome: a complete validated document, or the explicit list of rejections. */
export type ManualParseOutcome =
  | { readonly ok: true; readonly document: ManualDocument }
  | { readonly ok: false; readonly errors: readonly ManualImportIssue[] };

/** Counts a UI can preview before any application service persists the document. */
export interface ManualPreview {
  readonly accounts: number;
  readonly problems: number;
  readonly submissions: number;
  readonly editorialsFound: number;
  readonly editorialsAbsent: number;
  readonly editorialsUnavailable: number;
  /** Input records read (JSON) / data rows read (CSV). */
  readonly rows: number;
  /** UTF-8 size of the input text. */
  readonly bytes: number;
}

/**
 * Per-problem editorial outcome. `url`/`title`/`note` repeat the declaration so an absent entry
 * keeps the evidence of the deliberate check, while `result` is the port-shaped answer.
 */
export interface ManualEditorialEntry {
  readonly problemKey: string;
  readonly ref: ProblemRef;
  readonly status: 'found' | 'absent' | 'unavailable';
  readonly url: string | null;
  readonly title: string | null;
  readonly note: string | null;
  readonly result: EditorialFetchResult;
}

/** Validated, immutable manual import. Every array is owned, frozen and dependency-ordered. */
export interface ManualDocument {
  readonly schemaVersion: typeof MANUAL_SCHEMA_VERSION;
  readonly source: SourceInstance;
  readonly accounts: readonly Account[];
  readonly problems: readonly NormalizedProblem[];
  readonly submissions: readonly Submission[];
  /** One entry per problem, in `problems` order: found, explicitly absent, or unavailable. */
  readonly editorials: readonly ManualEditorialEntry[];
  /** Hash binding cursors and duplicate checks to this exact content (timestamps excluded). */
  readonly contentHash: string;
  /** Parse time used as `fetchedAt`/`retrievedAt` for imported records. */
  readonly importedAt: string;
  readonly preview: ManualPreview;
}

export interface ManualJsonOptions {
  /** ISO timestamp recorded as `fetchedAt`/`retrievedAt`; defaults to the parse time. */
  readonly importedAt?: string;
}

/** Untouched JSON input or an already normalised domain account. */
export type ManualAccountContext = ManualAccountInput | Account;
/** Untouched JSON input or an already normalised domain problem. */
export type ManualProblemContext = ManualProblemInput | NormalizedProblem;

export interface ManualCsvOptions {
  readonly kind: ManualCsvKind;
  readonly source: ManualSourceInput;
  /** Accounts referenced by submission rows (always required for `kind: 'submissions'`). */
  readonly accounts?: readonly ManualAccountContext[];
  /**
   * Problems used as reference context. For `kind: 'problems'` they are merged with the parsed
   * rows (duplicates reject); for `kind: 'submissions'` they are the document's problems.
   */
  readonly problems?: readonly ManualProblemContext[];
  /** Editorial records, validated exactly like the JSON `editorials` array. */
  readonly editorials?: readonly ManualEditorialInput[];
  /** ISO timestamp recorded as `fetchedAt`/`retrievedAt`; defaults to the parse time. */
  readonly importedAt?: string;
}

/** Per-problem material exposed to a later import application service (no storage here). */
export interface ManualProblemMaterial {
  readonly problem: NormalizedProblem;
  readonly editorial: ManualEditorialEntry;
  readonly submissions: readonly Submission[];
}

/** Immutable single-solution editorial, kept for callers that only need the solutions. */
export type ManualEditorialSolutions = readonly EditorialSolution[];
