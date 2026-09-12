/**
 * Public surface of the manual import adapter.
 *
 * The pure parsers are exported next to the adapter so a caller can validate and preview a
 * document before it builds an adapter or hands the material to an import service.
 */
export { MANUAL_CURSOR_VERSION, ManualPlatformAdapter, createManualPlatformAdapter } from './adapter.js';

export { manualAttributionUrl, normalizeManualTimestamp, parseManualCsv, parseManualJson } from './parse.js';

export {
  MANUAL_CSV_COLUMNS,
  MANUAL_CSV_KINDS,
  MANUAL_EDITORIAL_KINDS,
  MANUAL_EDITORIAL_STATUSES,
  MANUAL_MAX_FIELD_CHARS,
  MANUAL_MAX_PAGE_LIMIT,
  MANUAL_MAX_ROWS,
  MANUAL_MAX_TEXT_BYTES,
  MANUAL_MAX_TEXT_CHARS,
  MANUAL_SCHEMA_VERSION,
  type ManualAccountContext,
  type ManualAccountInput,
  type ManualCsvKind,
  type ManualCsvOptions,
  type ManualDocument,
  type ManualEditorialEntry,
  type ManualEditorialInput,
  type ManualEditorialSolutionInput,
  type ManualEditorialStatus,
  type ManualImportIssue,
  type ManualIssueCode,
  type ManualJsonDocumentInput,
  type ManualJsonOptions,
  type ManualParseOutcome,
  type ManualPreview,
  type ManualProblemContext,
  type ManualProblemInput,
  type ManualProblemMaterial,
  type ManualRatingInput,
  type ManualSourceInput,
  type ManualSubmissionInput,
} from './types.js';
