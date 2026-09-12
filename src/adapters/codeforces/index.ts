/**
 * Public surface of the Codeforces adapter.
 *
 * The pure helpers are exported next to the adapter so live bodies (for example downloaded
 * blogs kept outside Git) can be checked independently:
 * `extractEditorialSection(html, { contestId, index })` runs without any network access.
 */
export {
  CODEFORCES_BASE_URL,
  CODEFORCES_MIN_REQUEST_INTERVAL_MS,
  CodeforcesAdapter,
  codeforcesSourceInstance,
  createCodeforcesAdapter,
  mapCodeforcesVerdict,
  memoryBytesToKib,
  type CodeforcesAdapterOptions,
} from './adapter.js';

export { canonicalCodeforcesHandle, createCodeforcesAccount, requireCodeforcesHandle } from './account.js';

export {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  requireCatalogCursor,
  requireCatalogOffset,
  requireSubmissionCursor,
  type AdapterCursor,
  type CatalogCursor,
  type CursorResource,
  type CursorScope,
  type SubmissionCursor,
} from './cursors.js';

export {
  extractEditorialSection,
  parseCodeforcesBlogUrl,
  problemReferenceFromHref,
  type EditorialSection,
  type EditorialSectionFailure,
  type EditorialSectionFailureReason,
  type EditorialSectionResult,
  type EditorialTarget,
  type HeadingRef,
} from './editorial.js';

export {
  CF_PROBLEM_INDEX,
  cfProblemExternalKey,
  cfProblemKeyFromParts,
  cfSubmissionExternalKey,
  isOfficialCodeforcesHref,
  officialProblemPaths,
  parseCfProblemKey,
  parseOfficialProblemPath,
  type CfProblemIdentity,
  type CfProblemKeyParts,
} from './problem-index.js';

export {
  BLOCK_TAGS,
  SKIPPED_TEXT_TAGS,
  blogIdFromHref,
  detectChallengePage,
  extractProblemPage,
  findTutorialBlogId,
  hasClass,
  htmlToPlainText,
  labelTextOf,
  normalizePlainText,
  parseHtml,
  type ProblemPageContent,
  type ProblemPageResult,
} from './html.js';
