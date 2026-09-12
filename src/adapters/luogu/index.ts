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

export {
  LUOGU_PID_PATTERN,
  LUOGU_TAG_RAW_PREFIX,
  MAX_STATEMENT_CHARS,
  bodySnippet,
  buildLuoguStatement,
  isHtmlResponse,
  isJsonRecord,
  luoguData,
  luoguTagRaws,
  parseProblemDetail,
  parseProblemList,
  parseTagDictionary,
  payloadError,
  requirePid,
  type LuoguProblemDetail,
  type LuoguProblemPage,
  type LuoguProblemSummary,
  type LuoguSample,
  type LuoguStatementSections,
  type LuoguTag,
} from './parsers.js';
