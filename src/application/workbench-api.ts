import type { AbilityCalibration, AbilityCalibrationRange } from '../domain/ability-calibration.js';
import type {AssessmentPrepareRequest,AssessmentRunRequest,AssessmentStatusRequest,AssessmentHistoryRequest,AssessmentConfigView} from './assessment-service.js';
import type {ApiAssessmentView,ApiAssessmentHistory} from './assessment-api-types.js';
import type * as Bootstrap from './bootstrap-types.js';
import type * as Model from './model-operation-types.js';
/**
 * Business-API contract of the workbench (Stage 4h1): **types only**, shared by the browser half
 * and the plugin half.
 *
 * The browser half of the plugin derives every request and response type from this module, so the
 * HTTP contract and the TypeScript contract cannot drift. Two rules make that safe:
 *
 * - **No runtime dependency.** Everything here is type-only apart from pure constant data
 *   (`WORKBENCH_API_OPERATIONS`, `WORKBENCH_API_ORIGINS`), so importing this module pulls in no
 *   HTTP client, no adapter, no Node built-in and no host service — it is browser-safe by
 *   construction. The endpoint behaviour lives in `plugin/business-api.ts`, which is host-only.
 * - **Request DTOs are what a browser really sends.** Where an accepted application service already
 *   defines a browser-safe request shape, the API request is derived from it (`Omit<…, 'token'>`)
 *   instead of being restated, so a field a service accepts cannot be silently undocumented here.
 *   Response types reuse the accepted service DTOs verbatim; only the operations the services do
 *   not already shape (account creation, paging, import, material writes) define their own.
 *
 * The module also owns the honest-data rules of those new shapes: an import preview never carries
 * the parsed document, only counts plus a content hash; a material refresh answer reports status
 * and retry metadata instead of the fetched body; a supplement never echoes the stored problem. No
 * field here can carry a credential, a provider payload, an editorial body or a raw tag that the
 * caller is not allowed to see.
 */
import type {
  EditorialAvailability,
  EditorialSourceKind,
} from '../domain/index.js';
import type {
  LuoguConnectionStatus,
  LuoguMetadataIssue,
  LuoguSyncFailure,
  LuoguSyncFailureCode,
  LuoguSyncPhase,
  LuoguSyncSettings,
} from './luogu-sync-types.js';
import type {
  ProblemPageCounts,
  SubmissionPageCounts,
} from './import-types.js';
import type { PlatformErrorCode } from './platform-errors.js';
import type { SyncResource } from './storage-types.js';
import type {
  WorkbenchBrowseRequest,
  WorkbenchCheckOffTaskRequest,
  WorkbenchEditPlanTaskRequest,
  WorkbenchGetPlanRequest,
  WorkbenchGetProblemRequest,
  WorkbenchListRequest,
  WorkbenchPlanCasRequest,
  WorkbenchPlanListRequest,
  WorkbenchPlanPreviewRequest,
  WorkbenchReviewTagRequest,
  WorkbenchRetrospectiveRequest,
  WorkbenchWeaknessRequest,
} from './workbench-service.js';
import type {
  WorkbenchPlanListResult,
  WorkbenchPlanPreviewResult,
  WorkbenchPlanView,
  WorkbenchMergedBrowsePage,
  WorkbenchProblemBrowsePage,
  WorkbenchProblemDetail,
  WorkbenchProblemPage,
  WorkbenchRetrospectiveResult,
  WorkbenchTagReviewResult,
  WorkbenchWeaknessResult,
} from './workbench-types.js';
import type { MergedBankBrowseRequest } from './merged-bank-service.js';
import type {
  MaterialRefreshBatchItemView,
  MaterialRefreshBatchListView,
  MaterialRefreshBatchStatus,
  MaterialRefreshBatchSummaryView,
  MaterialRefreshBatchView,
} from './material-refresh-batch-types.js';
import type {
  VirtualPerformanceDeleteRequest,
  VirtualPerformanceLedgerView,
  VirtualPerformanceListRequest,
  VirtualPerformanceSaveRequest,
} from './virtual-performance-service.js';
import type {
  RetrospectiveEditApplyRequest,
  RetrospectiveEditApplyResult,
  RetrospectiveEditListRequest,
  RetrospectiveEditListResult,
  RetrospectiveEditPreviewResult,
  RetrospectiveEditRequest,
} from './retrospective-edit.js';

// ---------------------------------------------------------------------------------------
// Endpoint vocabulary
// ---------------------------------------------------------------------------------------

/**
 * A request frozen for one call: a token is never part of a JSON body, the transport owns it.
 *
 * Deriving from the accepted service request means every accepted field is represented here; the
 * only change is the removal of the injected `CancellationToken`.
 */
export type ApiRequestOf<ServiceRequest> = Omit<ServiceRequest, 'token'>;

/**
 * Static identity of one business endpoint.
 *
 * `request`/`response` are phantom type carriers: they exist so `WorkbenchApiMap` can be indexed by
 * operation name at compile time, and add no runtime member of their own.
 */
export interface ApiEndpoint<Request, Response> {
  /** Exact operation segment appended to `/api/icpc/v1/`. */
  readonly operation: string;
  readonly method: 'POST';
  /** Phantom: the validated input type of this endpoint. */
  readonly request?: Request;
  /** Phantom: the JSON value of a successful answer. */
  readonly response?: Response;
}

/** Validated request of one endpoint, derived from its {@link ApiEndpoint} entry. */
export type ApiRequest<K extends keyof WorkbenchApiMap> = NonNullable<WorkbenchApiMap[K]['request']>;
/** Successful value of one endpoint, derived from its {@link ApiEndpoint} entry. */
export type ApiResponse<K extends keyof WorkbenchApiMap> = NonNullable<WorkbenchApiMap[K]['response']>;

/** Official platform origins an account may be created on; the composition maps each to a source. */
export const WORKBENCH_API_ORIGINS: readonly ('codeforces' | 'luogu')[] = ['codeforces', 'luogu'];

/**
 * Longest accepted `answer.sourceLabel` (a short attribution such as `GPT6` or `教师解析`).
 *
 * Declared next to the request type so the HTTP boundary and the UI form enforce exactly the same
 * bound instead of each keeping a private copy.
 */
export const MAX_USER_ANSWER_LABEL_CHARS = 200;

/**
 * Longest accepted `answer.text` (the pasted answer body).
 *
 * Far above any real write-up, but bounded so one paste can never become an unbounded write.
 */
export const MAX_USER_ANSWER_TEXT_CHARS = 200_000;

/**
 * Stable id prefix of the "user-provided answer" editorial source namespace.
 *
 * A pasted answer is stored as a genuine `found` source with `kind: 'other'`, never as an official
 * editorial, and this prefix keeps its deterministic namespace disjoint from the platform importers'
 * ids and from the material-check namespace. The UI recognises such a source by this prefix to
 * render its provenance instead of presenting it as a platform article.
 */
export const USER_ANSWER_SOURCE_ID_PREFIX = 'user-answer-';

/** Fixed final provenance clause; caller labels cannot change the meaning of the link. */
export const USER_ANSWER_ASSOCIATED_LINK_NOTE = '用户未提供答案出处链接；此处关联的是题目链接（仅为关联题目，并非答案出处），本插件不会抓取任何外部链接。';

/**
 * Every operation this stage registers, in the order they are registered.
 *
 * `as const satisfies` proves statically that each name is a real {@link WorkbenchApiMap} key, so no
 * route can be registered for an operation the shared contract does not describe. An operation that
 * is not here has no route at all: a later stage adds its own entry instead of a placeholder.
 */
export const WORKBENCH_API_OPERATIONS = {
  accountCreate: 'account.create',
  abilityCalibrate: 'ability.calibrate',
  abilitySyncRating: 'ability.syncRating',
  syncPage: 'sync.page',
  importPreview: 'import.preview',
  importApply: 'import.apply',
  materialRefresh: 'material.refresh',
  materialSupplement: 'material.supplement',
  problemList: 'problem.list',
  problemBrowse: 'problem.browse',
  problemMergedBrowse: 'problem.mergedBrowse',
  problemDetail: 'problem.detail',
  reviewTag: 'review.tag',
  retroRecord: 'retro.record',
  retroList: 'retro.list',
  retroEditPreview: 'retro.editPreview',
  retroEditApply: 'retro.editApply',
  weakness: 'weakness',
  planPreview: 'plan.preview',
  planList: 'plan.list',
  planDetail: 'plan.detail',
  planAdopt: 'plan.adopt',
  planEdit: 'plan.edit',
  planCheckoff: 'plan.checkoff',
} as const satisfies Readonly<Record<string, WorkbenchApiOperation>>;

/** AI routes registered by the owned model API, separately from free business routes. */
export const PLANNING_API_OPERATIONS = {
  /**
   * Additive AI planning operations (Sprint 11d).
   *
   * They drive the owned planning host through the same authenticated envelope as every other
   * operation; `plan.preview` and the whole adopt/edit/checkoff/detail group stay the free rule-based
   * path and are unchanged.
   */
  planAiPrepare: 'plan.aiPrepare',
  planAiRun: 'plan.aiRun',
  planAiStatus: 'plan.aiStatus',
  planAiCancel: 'plan.aiCancel',
  planAiHistory: 'plan.aiHistory',
} as const satisfies Readonly<Record<string, WorkbenchApiOperation>>;

/**
 * Virtual-contest performance ledger routes registered by the owned performance API (Sprint 18c).
 *
 * They are registered separately from the free business routes and from every model route: the CRUD
 * is a free local write over user-entered evidence and never dispatches a paid call. The ledger is
 * Codeforces-only and user-entered; the request never carries a `source`, which the server always
 * injects as `user_import`.
 */
export const PERFORMANCE_API_OPERATIONS = {
  performanceList: 'performance.list',
  performanceSave: 'performance.save',
  performanceDelete: 'performance.delete',
} as const satisfies Readonly<Record<string, WorkbenchApiOperation>>;

/**
 * Durable bulk platform-material refresh operations (Sprint 34A).
 *
 * Registered separately from the accepted single-item `material.refresh`/`material.supplement`
 * routes, whose requests and semantics are unchanged. All six operations are platform-IO only: none
 * of them can name a model, create a model attempt or start a tag analysis, so preparing or starting
 * a bulk refresh can never spend model budget. `material.prepare`, `material.detail` and
 * `material.list` are local reads/writes; `material.start`, `material.cancel` and
 * `material.retryFailed` are explicit state transitions, and start returns before its owned background
 * work finishes.
 */
export const MATERIAL_BATCH_API_OPERATIONS = {
  materialBatchPrepare: 'material.prepare',
  materialBatchStart: 'material.start',
  materialBatchDetail: 'material.detail',
  materialBatchList: 'material.list',
  materialBatchCancel: 'material.cancel',
  materialBatchRetryFailed: 'material.retryFailed',
} as const satisfies Readonly<Record<string, WorkbenchApiOperation>>;

/**
 * Luogu connection/synchronization operations registered by the owned Luogu host (Sprint 17d1).
 *
 * They are registered separately from the free business routes because they drive the durable
 * authenticated synchronization service and the OS credential vault. `luogu.connect` is the single
 * operation of the whole API whose request carries secret material; every other operation names
 * only a stored account, an explicit action, a settings patch or a compare-and-set revision.
 * `luogu.profile` is the one public, anonymous read: it refreshes the account's own nickname from
 * the official profile endpoint, needs no stored session and touches no credential.
 */
export const LUOGU_API_OPERATIONS = {
  status: 'luogu.status',
  connect: 'luogu.connect',
  probe: 'luogu.probe',
  disconnect: 'luogu.disconnect',
  configure: 'luogu.configure',
  start: 'luogu.start',
  cancel: 'luogu.cancel',
  profile: 'luogu.profile',
  metadataBacklog: 'luogu.metadataBacklog',
  retryMetadata: 'luogu.retryMetadata',
  supplementMetadata: 'luogu.supplementMetadata',
  managedProblems: 'luogu.managedProblems',
  manageProblems: 'luogu.manageProblems',
} as const satisfies Readonly<Record<string, WorkbenchApiOperation>>;

// ---------------------------------------------------------------------------------------
// Account / sync / import / material DTOs
// ---------------------------------------------------------------------------------------

/** Request of `account.create`; the handle is canonicalized by the official platform factory. */
export interface ApiAccountCreateRequest {
  readonly platform: 'codeforces' | 'luogu';
  readonly handle: string;
  readonly displayName?: string;
}

/** The source instance one account belongs to; a small safe projection, never the stored row. */
export interface ApiSourceView {
  readonly id: string;
  readonly platform: string;
  readonly domain: string | null;
  readonly displayName: string;
}

/** The account that was created. Credentials are not representable anywhere in this API. */
export interface ApiAccountView {
  readonly id: string;
  readonly sourceInstanceId: string;
  readonly handle: string;
  readonly displayName: string | null;
  readonly profileUrl: string | null;
}

export interface ApiAccountCreateResult {
  readonly account: ApiAccountView;
  readonly source: ApiSourceView;
}

/** Request of `sync.page`: one page, one mode. The UI drives continuation explicitly. */
export interface ApiSyncPageRequest {
  readonly sourceInstanceId: string;
  readonly accountId: string | null;
  readonly resource: SyncResource;
  readonly mode: 'start' | 'continue' | 'restart';
  /** ISO time bound; omitted means "no explicit bound", `null` an explicit full scan. */
  readonly since?: string | null;
  readonly limit: number;
}

/** Platform failure answers this API reports without ever exposing a body or an exception text. */
export type ApiPlatformFailureCode = Exclude<PlatformErrorCode, 'invalid_input'>;

/**
 * Safe projection of a platform failure.
 *
 * Retry metadata is bounded and typed; `detail`, `sample`, response bodies and exception text never
 * appear, so a caller can react to the failure without receiving scraped content.
 */
export interface ApiPlatformFailureView {
  readonly code: ApiPlatformFailureCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly attempts: number;
}

/** Safe projection of one adapter page count block (identical to the service's own counts). */
export type ApiSyncPageCounts = ProblemPageCounts | SubmissionPageCounts;

/**
 * Exact position of the committed sync stream.
 *
 * A cursor is an opaque platform position and is returned as-is (the UI must present it back);
 * `since` and `updatedAt` are timestamps. No raw page body travels with it.
 */
export interface ApiSyncCheckpointView {
  readonly sourceInstanceId: string;
  readonly accountId: string | null;
  readonly resource: SyncResource;
  readonly cursor: string | null;
  readonly since: string | null;
  readonly updatedAt: string;
}

export interface ApiSyncPageResult {
  /** `true` when this page committed; `false` when `failure` explains why it did not. */
  readonly ok: boolean;
  readonly resource: SyncResource;
  readonly mode: 'start' | 'continue' | 'restart';
  readonly sourceInstanceId: string;
  readonly accountId: string | null;
  readonly since: string | null;
  readonly cursor: string | null;
  /** `null` means the scan is complete. */
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly counts: ApiSyncPageCounts | null;
  readonly checkpoint: ApiSyncCheckpointView | null;
  /** Observation time of the committed page. */
  readonly pageFetchedAt: string | null;
  /** Present (and `ok === false`) only for an operational platform failure. */
  readonly failure: ApiPlatformFailureView | null;
  /** Present (and `ok === false`) only when no request was made, e.g. `unsupported`. */
  readonly unavailableReason: string | null;
}

/**
 * API-owned rating input, structurally identical to the manual interchange record.
 *
 * Defined here (instead of importing the adapter's type) so the browser contract does not depend on
 * the adapter layer; the manual parser revalidates every field before it becomes a domain value.
 */
export interface ApiManualRatingInput {
  readonly dimension: string;
  readonly value: number | string;
  readonly raw: string;
  readonly scale?: { readonly min: number; readonly max: number } | null;
}

/** API-owned account context of a CSV import: only the untouched interchange record is accepted. */
export interface ApiManualAccountContext {
  readonly handle: string;
  readonly displayName?: string | null;
  readonly profileUrl?: string | null;
}

/** API-owned problem context of a CSV import: only the untouched interchange record is accepted. */
export interface ApiManualProblemContext {
  readonly domain?: string | null;
  readonly externalKey: string;
  readonly title: string;
  readonly url: string;
  readonly statement?: string | null;
  readonly rawTags?: readonly string[];
  readonly ratings?: readonly ApiManualRatingInput[];
}

/** Editorial record of a manual document (JSON only); the absence claim always carries a note. */
export interface ApiManualEditorialInput {
  readonly domain?: string | null;
  readonly externalKey: string;
  readonly status: 'found' | 'absent';
  readonly url: string;
  readonly title: string;
  readonly note?: string | null;
  readonly kind?: EditorialSourceKind;
  readonly solutions?: readonly {
    readonly title: string;
    readonly text: string;
    readonly language?: string | null;
  }[];
}

/** Reference context a CSV table cannot carry itself. */
export interface ApiManualCsvContext {
  readonly kind: 'problems' | 'submissions';
  readonly source: {
    readonly platform: 'manual' | 'codeforces' | 'luogu' | 'hydro';
    readonly baseUrl: string;
    readonly domain?: string | null;
    readonly displayName?: string;
  };
  readonly accounts?: readonly ApiManualAccountContext[];
  readonly problems?: readonly ApiManualProblemContext[];
  /** Editorial records may accompany a CSV table exactly like a JSON document's `editorials`. */
  readonly editorials?: readonly ApiManualEditorialInput[];
}

/** Request of `import.preview`/`import.apply`; `expectedHash` is required by `apply` only. */
export interface ApiImportRequest {
  readonly format: 'json' | 'csv';
  readonly text: string;
  readonly csv?: ApiManualCsvContext;
  /** Content hash returned by a previous preview; `apply` refuses a document that changed. */
  readonly expectedHash?: string;
}

/** One parser rejection with its location; the code vocabulary belongs to the manual parser. */
export interface ApiImportIssueView {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly row: number | null;
  readonly line: number | null;
  readonly field: string | null;
}

/** What a validated document contains; counts only, never the parsed rows. */
export interface ApiImportContentSummary {
  readonly accounts: number;
  readonly problems: number;
  readonly submissions: number;
  readonly editorialsFound: number;
  readonly editorialsAbsent: number;
  readonly editorialsUnavailable: number;
  readonly rows: number;
  readonly bytes: number;
}

/** Declared source identity of a parsed document. */
export interface ApiImportSourceSummary {
  readonly id: string;
  readonly platform: string;
  readonly domain: string | null;
  readonly displayName: string;
}

/** Preview answer: either the explicit rejections or the counts plus the confirmation hash. */
export type ApiImportPreviewResult =
  | { readonly parsed: false; readonly issues: readonly ApiImportIssueView[] }
  | {
      readonly parsed: true;
      readonly counts: ApiImportContentSummary;
      readonly contentHash: string;
      readonly source: ApiImportSourceSummary;
    };

/** One material declaration outcome, without any editorial text or page title. */
export interface ApiMaterialDeclarationView {
  readonly problemKey: string;
  readonly outcome: 'applied' | 'preserved' | 'ignored';
  readonly availability: EditorialAvailability | null;
  readonly freshFound: boolean;
  readonly staleCachedAvailability: EditorialAvailability | null;
  readonly sources: number;
  readonly solutions: number;
}

/** Committed snapshot descriptor; the bodies stay out of an import/material answer. */
export interface ApiSnapshotWriteView {
  readonly problemKey: string;
  readonly snapshotId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly capturedAt: string;
  /** `false` when the semantic content did not change and the previous snapshot was reused. */
  readonly changed: boolean;
}

/** Apply answer: what was actually written, with no raw tag, statement or editorial body. */
export interface ApiImportApplyResult {
  readonly sourceInstanceId: string;
  readonly accountsProcessed: number;
  readonly problems: {
    readonly inserted: number;
    readonly updated: number;
    readonly unchanged: number;
  };
  readonly submissionsProcessed: number;
  readonly materials: readonly ApiMaterialDeclarationView[];
  readonly snapshots: readonly ApiSnapshotWriteView[];
  readonly changedSnapshots: number;
}

/** Request of `material.refresh`: explicit statement flag, optional account and optional tutorial URL. */
export interface ApiMaterialRefreshRequest {
  readonly problemKey: string;
  readonly fetchStatement: boolean;
  readonly officialTutorialUrl?: string | null;
  /**
   * Account whose authenticated session may be used for the read (Sprint 33C).
   *
   * A platform that publishes solution material only to a signed-in reader needs to know whose
   * session to use. It is the *caller's selected account*, never free text: the plugin resolves it
   * from the store and refuses one that does not belong to the problem's own source instance, so a
   * request can neither name a foreign account nor make one up. Absent/`null` reads anonymously,
   * which can never report an absence.
   */
  readonly accountId?: string | null;
}

/** Head metadata after a refresh; editorial bodies and raw tags stay out of this projection. */
export interface ApiMaterialSnapshotView {
  readonly snapshotId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly sourceCount: number;
  readonly solutionCount: number;
}

/** Outcome of one statement fetch: identity and observation time, never a fabricated body. */
export interface ApiStatementStatusView {
  readonly status: 'fetched' | 'not_requested' | 'failed';
  readonly title: string | null;
  readonly url: string | null;
  readonly fetchedAt: string | null;
  readonly failure: ApiPlatformFailureView | null;
}

/** Outcome of one editorial fetch: status and counts only, never a solution body or source list. */
export interface ApiEditorialStatusView {
  readonly attempted: boolean;
  readonly status: EditorialAvailability | null;
  readonly sourceCount: number;
  readonly solutionCount: number;
  readonly failure: ApiPlatformFailureView | null;
  /** Set when no request was made because the problem has no stored metadata. */
  readonly skippedReason: string | null;
}

/**
 * Whether the equivalent Codeforces problem was consulted for this target, and if not, why.
 *
 * It is metadata only: the derived Codeforces identifier is public platform identity (the same key
 * the merged bank groups by), and no source URL, blog id, title or body travels through it. A
 * `skipped` answer never implies that Codeforces has no editorial — it means this run deliberately
 * did not ask.
 */
export interface ApiMirrorEditorialView {
  readonly status: 'skipped' | 'fetched';
  readonly skippedReason: string | null;
  /** Derived Codeforces external key (`<contest><index>`), or `null` when the rule did not apply. */
  readonly key: string | null;
}

export interface ApiMaterialRefreshResult {
  readonly problemKey: string;
  readonly snapshot: ApiMaterialSnapshotView | null;
  readonly statement: ApiStatementStatusView;
  readonly editorial: ApiEditorialStatusView;
  readonly mirror: ApiMirrorEditorialView;
  readonly material: ApiMaterialDeclarationView | null;
}

/**
 * One answer the user obtained elsewhere (GPT6, a teacher, their own write-up) and pasted in.
 *
 * This is a genuine user-provided source, not an official editorial and not model output: the
 * caller supplies the attribution (`sourceLabel`), the exact body (`text`) and optionally the link
 * it came from (`url`). The URL is attribution only and is never fetched by this plugin; when it is
 * absent the stored problem URL is used as an *associated* problem link, and the persisted note
 * says so. Nothing here certifies that the answer is correct.
 */
export interface ApiUserAnswerInput {
  readonly sourceLabel: string;
  readonly text: string;
  readonly url?: string;
}

/** One supplied editorial: a found paste or an explicit, explained absence. */
export type ApiSupplementEditorial =
  | {
      readonly status: 'found';
      readonly url: string;
      readonly title: string;
      readonly text: string;
      readonly language?: string | null;
    }
  | {
      readonly status: 'absent';
      readonly url: string;
      readonly title: string;
      readonly note: string;
    };

/**
 * Request of `material.supplement`; a client never re-imports the whole problem.
 *
 * A request names a statement, an official-editorial declaration or a user-provided answer. The
 * editorial declaration and the answer are mutually exclusive: they describe different provenance,
 * and merging them into one source would make the stored material claim an origin it does not have.
 */
export interface ApiMaterialSupplementRequest {
  readonly problemKey: string;
  readonly expectedSnapshotId: string | null;
  readonly statement?: string;
  readonly editorial?: ApiSupplementEditorial;
  /** A pasted answer; always stored as a user-provided source, never as an official editorial. */
  readonly answer?: ApiUserAnswerInput;
}

export interface ApiMaterialSupplementResult {
  readonly problemKey: string;
  /** Snapshot the caller saw; `null` when it saw none. */
  readonly expectedSnapshotId: string | null;
  readonly snapshot: ApiSnapshotWriteView;
  readonly material: ApiMaterialDeclarationView | null;
}

/**
 * One explicitly selected item of a bulk material refresh (Sprint 34A).
 *
 * The closed contract mirrors the aggregate exactly: a canonical problem key, an optional stored
 * account the read may authenticate as, an optional official tutorial URL the adapter validates
 * against its own origin, and the statement flag. The account id must be canonically encoded and is
 * resolved against the store before the batch is written; the tutorial URL must be an absolute
 * `http(s)` URL without embedded credentials. There is deliberately no field for a title, a statement
 * body, a raw tag, a Cookie, a credential or a mirror choice, so a request cannot smuggle hidden
 * metadata or a secret into the durable batch.
 */
export interface ApiMaterialBatchItemRequest {
  readonly problemKey: string;
  readonly accountId?: string | null;
  readonly officialTutorialUrl?: string | null;
  readonly fetchStatement?: boolean;
}

/** Request of `material.prepare`: 1..100 explicit items, unique by canonical problem key. */
export interface ApiMaterialBatchPrepareRequest {
  readonly items: readonly ApiMaterialBatchItemRequest[];
}

/** Request naming one stored batch, used by start/detail/cancel/retryFailed. */
export interface ApiMaterialBatchIdRequest {
  readonly batchId: string;
}

/** Request of `material.list`: an optional status filter and a bounded page size. */
export interface ApiMaterialBatchListRequest {
  readonly status?: MaterialRefreshBatchStatus | null;
  readonly limit?: number;
}

/**
 * One item of a batch answer.
 *
 * Metadata only: identity, selection flags, status, attempts, the sanitized failure and the snapshot
 * descriptor. The stored official tutorial URL is represented by `hasOfficialTutorial`. The stored
 * account id is not exposed at all: an `AccountId` encodes its handle, so there is no `accountId`
 * field and no substitute identifier derived from one. No field exists for a problem title, a
 * statement, an editorial body, a raw platform tag, an account handle/display name or a raw provider
 * error text.
 */
export type ApiMaterialBatchItemView = MaterialRefreshBatchItemView;

/** One batch answer: the ordered items plus the per-status totals. */
export type ApiMaterialBatchView = MaterialRefreshBatchView;

/** One row of `material.list`: the same metadata without the item list. */
export type ApiMaterialBatchSummaryView = MaterialRefreshBatchSummaryView;

/** Answer of `material.list`, newest first, with the filtered total before the page slice. */
export type ApiMaterialBatchListView = MaterialRefreshBatchListView;

// ---------------------------------------------------------------------------------------
// Luogu connection / synchronization operations (Sprint 17d1)
// ---------------------------------------------------------------------------------------

/**
 * Request naming one stored Luogu account.
 *
 * Every Luogu operation takes the account explicitly and never creates one: an account is created
 * once by `account.create` on the official Luogu platform, and a request for an account of another
 * platform (or a non-canonical Luogu uid) is refused before any credential or platform work.
 */
export interface ApiLuoguAccountRequest {
  readonly accountId: string;
}

/**
 * Request of `luogu.connect`: the account plus the ephemeral session material of this one user action.
 *
 * The session material is the **only** request field of the whole API that carries secret material.
 * It may be the `__client_id` value pair, a full browser Cookie header or an `__client_id=…; _uid=…`
 * pair; it is bounded (16 KiB of raw input), normalized to exactly those two cookies, bound to the
 * selected account's `_uid`, stored only inside the OS credential store under a fresh opaque
 * reference, and never echoed by a response, a status, an error or a log.
 */
export interface ApiLuoguConnectRequest {
  readonly accountId: string;
  readonly sessionCookie: string;
}

/**
 * Request of `luogu.configure`: one account's automation plus the revision the caller read.
 *
 * The patch is closed and must carry at least one field; `expectedRevision` is `null` only before
 * that account's first settings row exists, and a mismatch is refused instead of overwriting a
 * decision made elsewhere.
 */
export interface ApiLuoguConfigureRequest {
  readonly accountId: string;
  readonly expectedRevision: number | null;
  readonly automaticEnabled?: boolean;
  readonly runOnStartup?: boolean;
  readonly intervalMinutes?: number;
}

/**
 * Request of `luogu.start`: `resume` continues the durable position, `full` reconciles history,
 * `metadata` drains the missing problem-metadata backlog only.
 *
 * The metadata-only mode never reads a history page, never moves a history watermark and never
 * invokes a model: it re-fetches public problem metadata from the platform, one key at a time.
 */
export interface ApiLuoguStartRequest {
  readonly accountId: string;
  readonly mode: 'resume' | 'full' | 'metadata';
}

/** Safe projection of one stored connection; never a reference, a cookie or a vault detail. */
export interface ApiLuoguConnectionView {
  readonly status: LuoguConnectionStatus;
  readonly connectedAt: string;
  readonly checkedAt: string;
  readonly failureCode: LuoguSyncFailureCode | null;
  /** True when a previous credential could not be removed and a retry is still pending. */
  readonly cleanupPending: boolean;
}

/**
 * Field-by-field projection of one Luogu account's connection and synchronization status.
 *
 * The service's own status carries the stored connection record (an opaque vault reference) and the
 * durable lease owner; neither is representable here. What remains is exactly what a caller needs:
 * the canonical uid, whether this platform can store a session at all, the observed connection
 * state and check time, per-account settings together with the revision the next configure must
 * name, durable history coverage, committed progress, the metadata backlog and a sanitized failure
 * with its retry/next-run instants. No field can carry a cookie, a vault reference, a raw platform
 * body or an adapter exception message.
 */
export interface ApiLuoguStatusView {
  readonly accountId: string;
  /** Canonical decimal Luogu uid of the stored account. */
  readonly uid: string;
  readonly sourceInstanceId: string;
  /** False when this platform has no supported OS-protected credential backend. */
  readonly connectionAvailable: boolean;
  /** Resolved platform of the credential backend (for example `win32`). */
  readonly connectionPlatform: string;
  readonly connection: ApiLuoguConnectionView | null;
  readonly settings: LuoguSyncSettings;
  /** Revision the next `luogu.configure` must name; `null` before the first settings row. */
  readonly settingsRevision: number | null;
  readonly phase: LuoguSyncPhase;
  readonly historyComplete: boolean;
  readonly historyCompletedAt: string | null;
  /** True when a durable checkpoint continuation exists; the next pass resumes it first. */
  readonly resumePending: boolean;
  /** Time bound of the stored continuation; `null` for a full-window scan. */
  readonly scanSince: string | null;
  readonly running: boolean;
  /** True while any plugin instance holds a live durable lease on this account. */
  readonly leaseActive: boolean;
  readonly paused: boolean;
  readonly failure: LuoguSyncFailure | null;
  readonly nextRunAt: string | null;
  readonly scanStartedAt: string | null;
  readonly lastScanStartedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly pagesInPass: number;
  readonly totalPages: number;
  readonly submissionsSeen: number;
  readonly metadataBacklog: number;
  readonly metadataBacklogFull: boolean;
  readonly metadataResolved: number;
  readonly metadataFailed: number;
  /** Always `0`: this build refuses a write instead of forgetting a backlog key. */
  readonly backlogDropped: number;
  readonly closing: boolean;
}

/**
 * Request of `luogu.metadataBacklog`: one page of the durable missing-metadata backlog.
 *
 * `page` is 1-based (default 1) and `pageSize` is bounded to 1..{@link LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE}
 * (default 20). The read is bounded — it never scans further than the requested page — and
 * deterministic: keys that carry a recorded per-key issue come first, then the remaining keys in
 * durable queue order.
 */
export interface ApiLuoguMetadataBacklogRequest {
  readonly accountId: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** One queued key of the metadata backlog, with what is known about it and its current head. */
export interface ApiLuoguMetadataBacklogItem {
  readonly problemKey: string;
  /** Platform-facing key of the reference (for example `P900000001`). */
  readonly externalKey: string;
  /** Canonical problem page URL; this operation itself performs no request. */
  readonly url: string;
  /** Stored title, or `null` when the problem row does not exist yet. */
  readonly title: string | null;
  /** Last recorded per-key diagnostic, or `null` when this key has no known issue. */
  readonly issue: LuoguMetadataIssue | null;
  /** Current snapshot head, or `null` when the problem has no snapshot yet. */
  readonly expectedSnapshotId: string | null;
}

/**
 * One page of the durable metadata backlog.
 *
 * `knownIssues` counts the keys of **this page** whose diagnostic is known and is deliberately
 * independent of `historicalFailedAttempts`, which is the lifetime counter of failed attempts of
 * the whole account. `unknownIssueLabel` is the fixed sentence shown for an item whose `issue` is
 * `null`: it says that no per-key failure has been recorded yet, never that the key was never tried.
 */
export interface ApiLuoguMetadataBacklogView {
  readonly accountId: string;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly knownIssues: number;
  readonly historicalFailedAttempts: number;
  readonly unknownIssueLabel: string;
  readonly items: readonly ApiLuoguMetadataBacklogItem[];
}

/** Request of `luogu.retryMetadata`: retry exactly one currently queued key. */
export interface ApiLuoguRetryMetadataRequest {
  readonly accountId: string;
  readonly problemKey: string;
}

/**
 * Result of one item-scoped metadata retry.
 *
 * `outcome` is `resolved` when the key left the backlog, `deferred` when the platform refused this
 * one item for this reader (for example an incomplete personal statement) while the key stays
 * queued, and `failed` for any other refusal. The code and reason are the same sanitized vocabulary
 * the durable diagnostics use: no exception text, response body or sample is representable here.
 */
export interface ApiLuoguRetryMetadataResult {
  readonly accountId: string;
  readonly problemKey: string;
  readonly outcome: 'resolved' | 'deferred' | 'failed';
  readonly failureCode: LuoguSyncFailureCode | null;
  readonly reason: LuoguMetadataIssue['reason'];
  readonly status: ApiLuoguStatusView;
}

/**
 * Request of `luogu.supplementMetadata`: one queued key plus the **local** material a user typed.
 *
 * This is the manual-recovery path for a queued problem the platform will not serve (for example an
 * explicitly incomplete personal statement). The body is a closed contract: there is deliberately
 * no URL, raw tag, rating, submission, model or editorial field, because the canonical problem URL
 * is derived by the server from the configured Luogu instance and every stored metadata this
 * request does not name is preserved. `title` is used only when the problem row does not exist yet;
 * an existing title is never overwritten (the form shows it read-only). `expectedSnapshotId` is the
 * head the caller saw (`null` when it saw none) and a mismatch is refused before anything is
 * written.
 */
export interface ApiLuoguSupplementMetadataRequest {
  readonly accountId: string;
  readonly problemKey: string;
  /** Real title the user supplied for a problem that is not stored yet. */
  readonly title: string;
  /** Complete statement the user supplied; bounded by the application's own statement limit. */
  readonly statement: string;
  readonly expectedSnapshotId: string | null;
}

/**
 * Result of `luogu.supplementMetadata`.
 *
 * `outcome: 'supplemented'` means the **user-supplied** title/statement were committed to the
 * problem row and a new immutable snapshot, and exactly that key left the metadata backlog. It
 * never means a platform fetch succeeded: this operation performs no request, stores no
 * platform-derived tag or rating and declares no editorial material. `status` is the same safe
 * projection every other Luogu operation returns, so the caller sees the updated backlog.
 */
export interface ApiLuoguSupplementMetadataResult {
  readonly accountId: string;
  readonly problemKey: string;
  readonly snapshot: ApiSnapshotWriteView;
  readonly status: ApiLuoguStatusView;
  readonly outcome: 'supplemented';
}

/** Result of `luogu.start`; the durable plan itself is visible in `status`. */
export interface ApiLuoguStartResult {
  readonly accountId: string;
  readonly mode: 'resume' | 'full' | 'metadata';
  readonly outcome: 'started' | 'coalesced' | 'queued';
  readonly status: ApiLuoguStatusView;
}

/**
 * Result of `luogu.profile`: the account whose nickname was refreshed.
 *
 * The fetched profile payload is not returned — only the stored account projection, in which
 * `displayName` is the refreshed nickname and every identity field is unchanged.
 */
export interface ApiLuoguProfileResult {
  readonly account: ApiAccountView;
}

/**
 * Request of luogu.managedProblems: one bounded page of the durable local problem dispositions.
 *
 * state selects what the user skipped (metadata fetching suppressed while the bank stays intact) or
 * trashed (hidden from the bank, statistics and ability input). The read is a projection of stored
 * tombstones plus the raw stored title: it needs no connection and performs no request.
 */
export interface ApiLuoguManagedProblemsRequest {
  readonly accountId: string;
  /** 1-based page number; default 1. */
  readonly page?: number;
  /** Page size within 1..50 (the store's recovery read bound); default 20. */
  readonly pageSize?: number;
  readonly state: 'skipped' | 'trashed';
}

/** One durable local disposition; title is the raw stored title, or null when no row exists. */
export interface ApiLuoguManagedProblemsItem {
  readonly problemKey: string;
  /** Platform-facing key of the reference (for example P900000001). */
  readonly externalKey: string;
  readonly title: string | null;
  readonly state: 'skipped' | 'trashed';
  readonly updatedAt: string;
}

/** One page of durable dispositions. A disposition is global to the canonical key of this source. */
export interface ApiLuoguManagedProblemsView {
  readonly items: readonly ApiLuoguManagedProblemsItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * One requested disposition change: the state the caller believes the key is in.
 *
 * active is the public spelling of "no durable disposition" (the service's internal null);
 * expectedState must equal the durable state or the whole batch is refused.
 */
export interface ApiLuoguManageProblemsItem {
  readonly problemKey: string;
  readonly expectedState: 'active' | 'skipped' | 'trashed';
}

/**
 * Request of luogu.manageProblems: one action over 1..50 distinct canonical keys of this source.
 *
 * skip suppresses only metadata fetching and leaves the bank and analytics intact; trash additionally
 * hides the problem from every stored read; restore removes the tombstone and exposes the retained
 * raw rows again. trash may replace skipped, skip only an active key and restore only a skipped or
 * trashed one; every rule is checked against the durable state inside one all-or-none transaction.
 * The keys must be locally known (a stored problem, a local submission or a queued backlog key); an
 * arbitrary remote identity is refused.
 */
export interface ApiLuoguManageProblemsRequest {
  readonly accountId: string;
  readonly action: 'skip' | 'trash' | 'restore';
  readonly items: readonly ApiLuoguManageProblemsItem[];
}

/** Result of luogu.manageProblems: how many keys the atomic CAS batch changed. */
export interface ApiLuoguManageProblemsResult {
  readonly changed: number;
}

// ---------------------------------------------------------------------------------------
// Workbench read/review/plan operations (delegated to the accepted services)
// ---------------------------------------------------------------------------------------

/** Bank page request; every accepted filter is retained, including `cursor` and `reveal`. */
export type ApiProblemListRequest = ApiRequestOf<WorkbenchListRequest>;
export type ApiProblemListResult = WorkbenchProblemPage;

/**
 * Numbered bank page request; `problem.list` keeps its cursor contract unchanged.
 *
 * `page` is 1-based and `limit` a page size within 1..100 (the UI offers 25/50/100). `status` and
 * `onlyAttempted` are solved filters relative to `accountId` and are refused without one; there is
 * deliberately no `cursor` field on this operation.
 */
export type ApiProblemBrowseRequest = ApiRequestOf<WorkbenchBrowseRequest>;
export type ApiProblemBrowseResult = WorkbenchProblemBrowsePage;

/**
 * Merged cross-site bank page request (additive; `problem.browse` and `problem.list` are unchanged).
 *
 * `accountIds` selects at most 32 distinct accounts with at most one per source instance; an empty
 * selection is legal for the unfiltered read, while `status`/`onlyAttempted` need at least one.
 * `sourceInstanceId` is a display filter (groups having a member from that source) and the
 * difficulty source of a difficulty sort — never an account scope.
 */
export type ApiProblemMergedBrowseRequest = ApiRequestOf<MergedBankBrowseRequest>;
export type ApiProblemMergedBrowseResult = WorkbenchMergedBrowsePage;

/** Problem detail request; `reveal` and `accountId` are the service's own spoiler context. */
export type ApiProblemDetailRequest = ApiRequestOf<WorkbenchGetProblemRequest>;
export type ApiProblemDetailResult = WorkbenchProblemDetail;

export type ApiReviewTagRequest = ApiRequestOf<WorkbenchReviewTagRequest>;
export type ApiReviewTagResult = WorkbenchTagReviewResult;

export type ApiRetroRecordRequest = ApiRequestOf<WorkbenchRetrospectiveRequest>;
export type ApiRetroRecordResult = WorkbenchRetrospectiveResult;

/**
 * Batch completion editing (Sprint 23a).
 *
 * `retro.list` reads the latest completion record of up to 100 problems of one account;
 * `retro.editPreview` returns a hash-bound, spoiler-free projection of an edit and writes nothing;
 * `retro.editApply` repeats the intent with that hash and appends one row per changed problem in a
 * single transaction. None of them carries raw tags, a note or a consulted solution id.
 */
export type ApiRetroListRequest = ApiRequestOf<RetrospectiveEditListRequest>;
export type ApiRetroListResult = RetrospectiveEditListResult;
export type ApiRetroEditPreviewRequest = ApiRequestOf<RetrospectiveEditRequest>;
export type ApiRetroEditPreviewResult = RetrospectiveEditPreviewResult;
export type ApiRetroEditApplyRequest = ApiRequestOf<RetrospectiveEditApplyRequest>;
export type ApiRetroEditApplyResult = RetrospectiveEditApplyResult;

export type ApiWeaknessRequest = ApiRequestOf<WorkbenchWeaknessRequest>;
export type ApiWeaknessResult = WorkbenchWeaknessResult;

export type ApiPlanPreviewRequest = ApiRequestOf<WorkbenchPlanPreviewRequest>;
export type ApiPlanPreviewResult = WorkbenchPlanPreviewResult;

export type ApiPlanListRequest = ApiRequestOf<WorkbenchPlanListRequest>;
export type ApiPlanListResult = WorkbenchPlanListResult;

export type ApiPlanDetailRequest = ApiRequestOf<WorkbenchGetPlanRequest>;
export type ApiPlanDetailResult = WorkbenchPlanView;

export type ApiPlanAdoptRequest = ApiRequestOf<WorkbenchPlanCasRequest>;
export type ApiPlanAdoptResult = WorkbenchPlanView;

export type ApiPlanEditRequest = ApiRequestOf<WorkbenchEditPlanTaskRequest>;
export type ApiPlanEditResult = WorkbenchPlanView;

export type ApiPlanCheckoffRequest = ApiRequestOf<WorkbenchCheckOffTaskRequest>;
export type ApiPlanCheckoffResult = WorkbenchPlanView;

/**
 * Virtual-contest performance ledger operations (Sprint 18c).
 *
 * `performance.list` reads one account's ledger (an explicit empty view when it has none — never a
 * zero score); `performance.save` adds a row or replaces an existing `evidenceId` under the revision
 * the caller read; `performance.delete` removes one row and still advances that revision. The
 * response is the whole stored ledger, so a caller always sees the revision its next write must
 * name.
 */
export type ApiPerformanceListRequest = ApiRequestOf<VirtualPerformanceListRequest>;
export type ApiPerformanceListResult = VirtualPerformanceLedgerView;
export type ApiPerformanceSaveRequest = ApiRequestOf<VirtualPerformanceSaveRequest>;
export type ApiPerformanceSaveResult = VirtualPerformanceLedgerView;
export type ApiPerformanceDeleteRequest = ApiRequestOf<VirtualPerformanceDeleteRequest>;
export type ApiPerformanceDeleteResult = VirtualPerformanceLedgerView;

// ---------------------------------------------------------------------------------------
// The map itself
// ---------------------------------------------------------------------------------------

/**
 * Operation name → endpoint contract.
 *
 * This is the single source of truth for both halves: `plugin/business-api.ts` registers one route
 * per key and the browser half types its calls from the same entries. A later stage adds a key and
 * its handler; an operation that is not here has no route at all.
 */
export interface WorkbenchApiMap {
  bootstrap: ApiEndpoint<Record<string,never>, Bootstrap.BootstrapResult>;
  'model.catalog': ApiEndpoint<{readonly provider:string}, Bootstrap.ModelCatalogResult>;
  backup: ApiEndpoint<Record<string,never>, Bootstrap.BackupResult>;
  'batch.prepare': ApiEndpoint<Model.ModelBatchPrepareRequest, Model.ModelBatchPrepareResult>;
  'batch.run': ApiEndpoint<Model.ModelBatchRunRequest, Model.ModelBatchStartResult>;
  'batch.resume': ApiEndpoint<Model.ModelBatchResumeRequest, Model.ModelBatchStartResult>;
  'batch.pause': ApiEndpoint<Model.ModelBatchIdRequest, Model.ModelBatchControlResult>;
  'batch.cancel': ApiEndpoint<Model.ModelBatchIdRequest, Model.ModelBatchControlResult>;
  'batch.recover': ApiEndpoint<Model.ModelBatchRecoverRequest, Model.ModelBatchRecoverResult>;
  'batch.detail': ApiEndpoint<Model.ModelBatchIdRequest, Model.ModelBatchDetailResult>;
  'batch.list': ApiEndpoint<Model.ModelBatchListRequest, Model.ModelBatchListResult>;
  'coaching.ask': ApiEndpoint<Model.ModelCoachingAskRequest, Model.ModelCoachingAskResult>;
  'coaching.status': ApiEndpoint<Model.ModelCoachingStatusRequest, Model.ModelCoachingStatusResult>;
  'coaching.history': ApiEndpoint<Model.ModelCoachingHistoryRequest, Model.ModelCoachingHistoryResult>;
  'coaching.cancel': ApiEndpoint<Model.ModelCoachingCancelRequest, Model.ModelCoachingCancelResult>;
  'settings.save': ApiEndpoint<Model.ModelSettingsSaveRequest, Model.ModelSettingsSaveResult>;
  'ability.syncRating': ApiEndpoint<{ readonly accountId: string }, import('../domain/official-rating.js').OfficialRatingSnapshot>;
  'ability.calibrate': ApiEndpoint<{ readonly accountId: string; readonly expectedRevision: number; readonly range: AbilityCalibrationRange | null }, AbilityCalibration>;
  'account.create': ApiEndpoint<ApiAccountCreateRequest, ApiAccountCreateResult>;
  'sync.page': ApiEndpoint<ApiSyncPageRequest, ApiSyncPageResult>;
  'import.preview': ApiEndpoint<ApiImportRequest, ApiImportPreviewResult>;
  'import.apply': ApiEndpoint<ApiImportRequest, ApiImportApplyResult>;
  'material.refresh': ApiEndpoint<ApiMaterialRefreshRequest, ApiMaterialRefreshResult>;
  'material.supplement': ApiEndpoint<ApiMaterialSupplementRequest, ApiMaterialSupplementResult>;
  'material.prepare': ApiEndpoint<ApiMaterialBatchPrepareRequest, ApiMaterialBatchView>;
  'material.start': ApiEndpoint<ApiMaterialBatchIdRequest, ApiMaterialBatchView>;
  'material.detail': ApiEndpoint<ApiMaterialBatchIdRequest, ApiMaterialBatchView>;
  'material.list': ApiEndpoint<ApiMaterialBatchListRequest, ApiMaterialBatchListView>;
  'material.cancel': ApiEndpoint<ApiMaterialBatchIdRequest, ApiMaterialBatchView>;
  'material.retryFailed': ApiEndpoint<ApiMaterialBatchIdRequest, ApiMaterialBatchView>;
  'problem.list': ApiEndpoint<ApiProblemListRequest, ApiProblemListResult>;
  'problem.browse': ApiEndpoint<ApiProblemBrowseRequest, ApiProblemBrowseResult>;
  'problem.mergedBrowse': ApiEndpoint<ApiProblemMergedBrowseRequest, ApiProblemMergedBrowseResult>;
  'problem.detail': ApiEndpoint<ApiProblemDetailRequest, ApiProblemDetailResult>;
  'review.tag': ApiEndpoint<ApiReviewTagRequest, ApiReviewTagResult>;
  'retro.record': ApiEndpoint<ApiRetroRecordRequest, ApiRetroRecordResult>;
  'retro.list': ApiEndpoint<ApiRetroListRequest, ApiRetroListResult>;
  'retro.editPreview': ApiEndpoint<ApiRetroEditPreviewRequest, ApiRetroEditPreviewResult>;
  'retro.editApply': ApiEndpoint<ApiRetroEditApplyRequest, ApiRetroEditApplyResult>;
  weakness: ApiEndpoint<ApiWeaknessRequest, ApiWeaknessResult>;
  'plan.preview': ApiEndpoint<ApiPlanPreviewRequest, ApiPlanPreviewResult>;
  'plan.list': ApiEndpoint<ApiPlanListRequest, ApiPlanListResult>;
  'plan.detail': ApiEndpoint<ApiPlanDetailRequest, ApiPlanDetailResult>;
  'plan.adopt': ApiEndpoint<ApiPlanAdoptRequest, ApiPlanAdoptResult>;
  'plan.edit': ApiEndpoint<ApiPlanEditRequest, ApiPlanEditResult>;
  'plan.checkoff': ApiEndpoint<ApiPlanCheckoffRequest, ApiPlanCheckoffResult>;
  'luogu.status': ApiEndpoint<ApiLuoguAccountRequest, ApiLuoguStatusView>;
  'luogu.connect': ApiEndpoint<ApiLuoguConnectRequest, ApiLuoguStatusView>;
  'luogu.probe': ApiEndpoint<ApiLuoguAccountRequest, ApiLuoguStatusView>;
  'luogu.disconnect': ApiEndpoint<ApiLuoguAccountRequest, ApiLuoguStatusView>;
  'luogu.configure': ApiEndpoint<ApiLuoguConfigureRequest, ApiLuoguStatusView>;
  'luogu.start': ApiEndpoint<ApiLuoguStartRequest, ApiLuoguStartResult>;
  'luogu.cancel': ApiEndpoint<ApiLuoguAccountRequest, ApiLuoguStatusView>;
  'luogu.profile': ApiEndpoint<ApiLuoguAccountRequest, ApiLuoguProfileResult>;
  'luogu.metadataBacklog': ApiEndpoint<ApiLuoguMetadataBacklogRequest, ApiLuoguMetadataBacklogView>;
  'luogu.retryMetadata': ApiEndpoint<ApiLuoguRetryMetadataRequest, ApiLuoguRetryMetadataResult>;
  'luogu.supplementMetadata': ApiEndpoint<ApiLuoguSupplementMetadataRequest, ApiLuoguSupplementMetadataResult>;
  'luogu.managedProblems': ApiEndpoint<ApiLuoguManagedProblemsRequest, ApiLuoguManagedProblemsView>;
  'luogu.manageProblems': ApiEndpoint<ApiLuoguManageProblemsRequest, ApiLuoguManageProblemsResult>;
  'assessment.config': ApiEndpoint<Record<string,never>,AssessmentConfigView>;
  'assessment.prepare': ApiEndpoint<AssessmentPrepareRequest,ApiAssessmentView>;
  'assessment.run': ApiEndpoint<AssessmentRunRequest,{readonly started:boolean;readonly attempt:ApiAssessmentView}>;
  'assessment.status': ApiEndpoint<AssessmentStatusRequest,ApiAssessmentView|null>;
  'assessment.cancel': ApiEndpoint<AssessmentStatusRequest,ApiAssessmentView>;
  'assessment.history': ApiEndpoint<AssessmentHistoryRequest,ApiAssessmentHistory>;
  'guidance.catalog': ApiEndpoint<Record<string, never>, { readonly methods: readonly import('../domain/guidance.js').InstalledGuidanceMethod[] }> ;
  'plan.aiPrepare': ApiEndpoint<Model.ModelPlanPrepareRequest, Model.ModelPlanPrepareResult>;
  'plan.aiRun': ApiEndpoint<Model.ModelPlanRunRequest, Model.ModelPlanRunResult>;
  'plan.aiStatus': ApiEndpoint<Model.ModelPlanStatusRequest, Model.ModelPlanStatusResult>;
  'plan.aiCancel': ApiEndpoint<Model.ModelPlanCancelRequest, Model.ModelPlanCancelResult>;
  'plan.aiHistory': ApiEndpoint<Model.ModelPlanHistoryRequest, Model.ModelPlanHistoryResult>;
  'performance.list': ApiEndpoint<ApiPerformanceListRequest, ApiPerformanceListResult>;
  'performance.save': ApiEndpoint<ApiPerformanceSaveRequest, ApiPerformanceSaveResult>;
  'performance.delete': ApiEndpoint<ApiPerformanceDeleteRequest, ApiPerformanceDeleteResult>;
}

/**
 * Flattened operation → request/response pair.
 *
 * Indexing a union of map keys through the optional phantom members of {@link ApiEndpoint} would add
 * `undefined` to every access; this mapped view states the pair once, so a handler's input and output
 * types are exact.
 */
export type WorkbenchApiTypes = {
  readonly [K in keyof WorkbenchApiMap]: {
    readonly request: ApiRequest<K>;
    readonly response: ApiResponse<K>;
  };
};

/** Validated request of operation `K`, without the phantom indirection. */
export type WorkbenchApiInput<K extends keyof WorkbenchApiMap> = WorkbenchApiTypes[K]['request'];
/** Successful value of operation `K`, without the phantom indirection. */
export type WorkbenchApiOutput<K extends keyof WorkbenchApiMap> = WorkbenchApiTypes[K]['response'];

/** Literal operation names of {@link WorkbenchApiMap}, derived from the map so they cannot drift. */
export type WorkbenchApiOperation = keyof WorkbenchApiMap;
