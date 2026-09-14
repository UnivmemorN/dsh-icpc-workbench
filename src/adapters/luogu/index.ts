/**
 * Public surface of the Luogu adapter.
 *
 * Pure parsers and cursor helpers are exported next to the adapter so the observed Lentille
 * payload shapes can be checked and debugged without any network access.
 */
export {
  LUOGU_BASE_URL,
  LUOGU_DOMAIN,
  LUOGU_MAX_LIST_LIMIT,
  LuoguAdapter,
  createLuoguAdapter,
  luoguSourceInstance,
  requireLuoguInstance,
  type LuoguAdapterOptions,
  type LuoguProblemDetailResult,
} from './adapter.js';

export {
  LUOGU_CURSOR_VERSION,
  decodeLuoguListCursor,
  encodeLuoguListCursor,
  luoguCursorFingerprint,
  type LuoguCursorScope,
  type LuoguListCursor,
  type LuoguListCursorInput,
} from './cursors.js';

export { LUOGU_UID_PATTERN, canonicalLuoguUid, createLuoguAccount, requireLuoguUid } from './account.js';

export {
  LUOGU_MAX_RECORD_COUNT,
  LUOGU_MAX_SERVER_PAGE_SIZE,
  LUOGU_MIN_SUBMIT_TIME_SECONDS,
  LUOGU_MAX_SUBMIT_TIME_SECONDS,
  LUOGU_STATUS_VERDICTS,
  luoguStatusVerdict,
  parseRecordPage,
  type LuoguRecord,
  type LuoguRecordPage,
} from './records.js';

export {
  LUOGU_RECORD_CURSOR_VERSION,
  decodeLuoguRecordCursor,
  encodeLuoguRecordCursor,
  luoguRecordCursorFingerprint,
  luoguRecordPageFingerprint,
  type LuoguRecordCursor,
  type LuoguRecordCursorInput,
  type LuoguRecordCursorScope,
} from './record-cursors.js';

export {
  LUOGU_MAX_SUBMISSION_LIMIT,
  LUOGU_MIN_REQUEST_INTERVAL_MS,
  LuoguSessionReaderAdapter,
  createAuthenticatedLuoguFetch,
  createLuoguSessionReader,
  requireLuoguSessionCookie,
  type AuthenticatedLuoguFetchOptions,
  type LuoguSession,
  type LuoguSessionProvider,
  type LuoguSessionReaderOptions,
} from './session-reader.js';

export {
  LUOGU_PROBLEM_PATH_PREFIX,
  LuoguProblemSessionSourceAdapter,
  createLuoguProblemSessionSource,
  type LuoguProblemSessionSource,
  type LuoguProblemSessionSourceOptions,
} from './problem-session-reader.js';

export {
  LUOGU_PID_PATTERN,
  LUOGU_TAG_RAW_PREFIX,
  MAX_LUOGU_DISPLAY_NAME_CHARS,
  MAX_STATEMENT_CHARS,
  bodySnippet,
  buildLuoguStatement,
  isHtmlResponse,
  isJsonRecord,
  luoguData,
  luoguTagRaws,
  parseAccountProfile,
  parseProblemDetail,
  parseProblemList,
  parseTagDictionary,
  payloadError,
  requirePid,
  type LuoguAccountProfile,
  type LuoguProblemDetail,
  type LuoguProblemPage,
  type LuoguProblemSummary,
  type LuoguSample,
  type LuoguStatementSections,
  type LuoguTag,
} from './parsers.js';

export {
  LuoguConnectionAdapter,
  createLuoguConnectionManager,
  createStoredLuoguSessionProvider,
  createStoredSubmissionsSource,
  type LuoguBoundSessionReader,
  type LuoguConnectionAdapterOptions,
  type LuoguConnectionStore,
  type LuoguReaderTransportOptions,
  type StoredLuoguSessionProviderOptions,
  type StoredSubmissionsSourceOptions,
} from './connection.js';
