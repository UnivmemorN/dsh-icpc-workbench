/**
 * Derived view rules of the dedicated Luogu connection/sync panel (Sprint 17d2).
 *
 * This module is **pure**: no HTTP, no DOM, no React, no storage and no clock of its own, so the
 * panel's honesty rules and its control gating can be tested without a browser. It holds exactly
 * three kinds of rule:
 *
 * 1. **Secret handling.** {@link checkLuoguSessionCookie} validates the ephemeral session draft
 *    locally through the same pure domain normalizer the server uses (bounded raw input, control
 *    characters refused, `_uid` bound to the selected account, unrelated cookies discarded) and only
 *    ever answers a fixed sentence plus the canonical two-cookie value to submit: the draft is never
 *    repeated in a message, and nothing here reads or writes `localStorage`, `sessionStorage`, a URL,
 *    a log or a model input.
 * 2. **Honest status projection.** History coverage, the latest attempt's result and the metadata
 *    backlog are three *separate* answers ({@link luoguHistoryCoverage}, {@link luoguAttemptSummary},
 *    {@link luoguBacklogSummary}), so an unread, empty or failed status can never be rendered as
 *    "0 records synced successfully". Processed rows are always labelled as *including* duplicate
 *    checks and rejudge replays, never as new submissions. A failure is explained by the half of the
 *    pass that produced it ({@link luoguSyncFailureGuidance}): a metadata refusal is never described
 *    as an expired session, and a legacy record without a stage keeps neutral wording.
 * 3. **Status-driven controls.** {@link luoguControls} derives every control's enabled state — and
 *    the exact reason it is disabled — from the durable status the service returned, never from a
 *    local guess. A remount therefore re-derives the same controls instead of recreating, clearing
 *    or restarting a pass the host already owns.
 *
 * The interval bounds are mirrored here as constants instead of importing the application module at
 * runtime: the browser half must stay free of host/application code, and `tests/ui/luogu-view.test.ts`
 * asserts these mirrored values against `src/application/luogu-sync-types.ts` so they cannot drift.
 */
import type {
  ApiLuoguConfigureRequest,
  ApiLuoguStartResult,
  ApiLuoguStatusView,
} from '../application/workbench-api.js';
import type {
  LuoguConnectionStatus,
  LuoguSyncFailure,
  LuoguSyncFailureCode,
  LuoguSyncFailureStage,
  LuoguSyncSettings,
} from '../application/luogu-sync-types.js';
import {
  MAX_LUOGU_COOKIE_INPUT_BYTES,
  luoguSessionCookieFromClientId,
  normalizeLuoguSessionCookie,
  type LuoguCookieProblem,
} from '../domain/luogu-session-cookie.js';

// ---------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------

/** Minimum automatic-sync interval in minutes; mirrors `LUOGU_SYNC_INTERVAL_MIN_MINUTES`. */
export const LUOGU_INTERVAL_MIN_MINUTES = 5;

/** Maximum automatic-sync interval in minutes; mirrors `LUOGU_SYNC_INTERVAL_MAX_MINUTES`. */
export const LUOGU_INTERVAL_MAX_MINUTES = 1440;

/** Fast poll cadence while a pass is running or just reserved. */
export const LUOGU_POLL_ACTIVE_MS = 2_000;

/** Slow poll cadence while automatic synchronization is enabled but no pass is running. */
export const LUOGU_POLL_IDLE_MS = 30_000;

// ---------------------------------------------------------------------------------------
// Account context
// ---------------------------------------------------------------------------------------

/** Which guidance the panel shows before it may read any Luogu status. */
export type LuoguPanelState = 'no-account' | 'wrong-platform' | 'ready';

/**
 * Decide whether the panel may read Luogu status for the current selection.
 *
 * `hasAccount` is whether any account is selected at all; `accountPlatform` is the platform of the
 * source instance that selected account belongs to (`null` when there is no account). A selected
 * account of another platform is `wrong-platform`, so the panel never even issues `luogu.status` for
 * an account the route would refuse.
 */
export function luoguPanelState(hasAccount: boolean, accountPlatform: string | null): LuoguPanelState {
  if (!hasAccount) {
    return 'no-account';
  }
  return accountPlatform === 'luogu' ? 'ready' : 'wrong-platform';
}

// ---------------------------------------------------------------------------------------
// Session draft
// ---------------------------------------------------------------------------------------

/** Which field of the panel the session material is entered in. */
export type LuoguSecretMode = 'client_id' | 'full_cookie';

/**
 * The complete in-memory session draft of one connect action.
 *
 * `selectedUid` is the canonical UID of the selected account — the readonly `_uid` the panel shows —
 * and is never something the user can type: the account is the only source of that binding.
 * `clientId` is the `__client_id` **value** of the default mode; `fullCookie` is the optional
 * whole-Cookie paste of the advanced mode.
 */
export interface LuoguSecretDraft {
  readonly mode: LuoguSecretMode;
  readonly selectedUid: string | null;
  readonly clientId: string;
  readonly fullCookie: string;
}

/** Local verdict on the session draft; `invalid` always carries a fixed explanation. */
export interface LuoguSecretCheck {
  readonly state: 'empty' | 'invalid' | 'valid';
  readonly message: string | null;
  /** Canonical `__client_id=…; _uid=…` value to submit; `null` unless `state === 'valid'`. */
  readonly cookie: string | null;
}

/**
 * Fixed Chinese sentence per refusal of the pure normalizer.
 *
 * Each sentence says which part is unusable and what to copy instead; none of them can echo the
 * draft, and none of them claims that copying other cookies would solve a platform challenge.
 */
const LUOGU_SECRET_MESSAGES: Readonly<Record<LuoguCookieProblem, string>> = {
  not_text: '登录凭据必须是文本：请粘贴 __client_id 的值，或整段 Cookie 值。',
  empty: '请先填写登录凭据。',
  too_long: `粘贴的内容太长（上限 ${MAX_LUOGU_COOKIE_INPUT_BYTES} 字节）：请只复制 Cookie 的值。`,
  unsafe_characters: '登录凭据里含有换行或控制字符：请只粘贴单行的 Cookie 值。',
  missing_client_id: '没有找到 __client_id：请在 F12 → Application（应用）→ Cookies 里复制这一项的 Value（值）。',
  missing_uid: '没有找到 _uid：整段 Cookie 里必须包含 _uid，或改用默认的 __client_id 值方式。',
  duplicate_client_id: '出现了多次 __client_id：请只保留这个账号的一个值。',
  duplicate_uid: '出现了多次 _uid：请只粘贴这个账号的 Cookie。',
  unusable_client_id: '__client_id 的值不可用：请只复制 Value（值）一列，不要带 Name、Domain、Path 等列、引号或空格。',
  unusable_uid: '_uid 不是规范的数字 UID：请粘贴这个账号自己的 Cookie。',
  uid_not_canonical: '请先选择一个洛谷账号：_uid 由当前账号决定，不能手工填写。',
  foreign_uid: 'Cookie 里的 _uid 与当前账号不一致：请确认复制的是这个账号的 Cookie。',
};

/**
 * Validate one ephemeral session draft before it is submitted to `luogu.connect`.
 *
 * This is a local courtesy check only — the authenticated route normalizes, revalidates and is the
 * authority. The draft is normalized with the **same pure domain rule** the server uses, so the
 * canonical value that is sent is exactly what the server would compute. No branch of it can echo
 * the draft: the answers are `empty` (no message), `invalid` (one fixed sentence) and `valid` (plus
 * the canonical value to submit). The `_uid` always comes from `selectedUid`, never from user input.
 */
export function checkLuoguSessionCookie(draft: LuoguSecretDraft): LuoguSecretCheck {
  const source = draft.mode === 'full_cookie' ? draft.fullCookie : draft.clientId;
  if (source.trim().length === 0) {
    return { state: 'empty', message: null, cookie: null };
  }
  const normalized =
    draft.mode === 'full_cookie'
      ? normalizeLuoguSessionCookie(draft.fullCookie, draft.selectedUid)
      : luoguSessionCookieFromClientId(draft.clientId, draft.selectedUid);
  if (!normalized.ok) {
    return { state: 'invalid', message: LUOGU_SECRET_MESSAGES[normalized.problem], cookie: null };
  }
  return { state: 'valid', message: null, cookie: normalized.cookie };
}

// ---------------------------------------------------------------------------------------
// Honest status projection
// ---------------------------------------------------------------------------------------

/** Local rendering of one instant; a missing instant is stated, never shown as a zero time. */
export function luoguTime(value: string | null): string {
  if (value === null) {
    return '尚未记录';
  }
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '时间无法识别' : at.toLocaleString();
}

/** Short connection-state label of one stored connection, or a fixed "not connected" sentence. */
export function luoguConnectionText(status: ApiLuoguStatusView | null): string {
  if (status === null) {
    return '尚未读取';
  }
  if (status.connection === null) {
    return '尚未连接';
  }
  return LUOGU_CONNECTION_LABELS[status.connection.status];
}

export const LUOGU_CONNECTION_LABELS: Readonly<Record<LuoguConnectionStatus, string>> = {
  connected: '已连接',
  session_expired: '登录已过期',
  challenge: '平台要求人工验证',
  schema_changed: '平台返回结构已变化',
  unavailable: '连接不可用',
};

export const LUOGU_PHASE_LABELS: Readonly<Record<ApiLuoguStatusView['phase'], string>> = {
  backfill: '首次全量补齐',
  incremental: '最近窗口增量',
  reconcile: '全历史完整核对',
};

/**
 * The only coverage claims the panel may make about one **read** status.
 *
 * `never` is deliberate and is the state a never-synced account is in: no scan ever started and no
 * row was ever committed. No branch may describe such an account as an already-imported window.
 */
export type LuoguHistoryState = 'never' | 'backfill' | 'reconcile' | 'complete';

/**
 * Classify one read status into the coverage claim it supports.
 *
 * The order matters: a completed reconciliation outranks the phase it left behind, an unfinished
 * reconciliation is named as such, and every other incomplete status is reported as an unfinished
 * **backfill** — the fallback never invents a covered window. `never` requires positive evidence
 * that nothing was ever read: no whole-scan start, no previous scan start, no success, no committed
 * page or row and no stored continuation. The durable phase of a never-synced account is still
 * `backfill`, because that is what the next pass would do — it is not evidence that one ran.
 */
export function luoguHistoryState(status: ApiLuoguStatusView): LuoguHistoryState {
  if (status.historyComplete) {
    return 'complete';
  }
  if (status.phase === 'reconcile') {
    return 'reconcile';
  }
  const untouched =
    !status.resumePending &&
    status.scanStartedAt === null &&
    status.lastScanStartedAt === null &&
    status.lastSuccessAt === null &&
    status.totalPages === 0 &&
    status.submissionsSeen === 0;
  return status.phase === 'backfill' && untouched ? 'never' : 'backfill';
}

/** Short history-coverage label per state; the completed one is the only claim of a covered window. */
export const LUOGU_HISTORY_STATE_LABELS: Readonly<Record<LuoguHistoryState, string>> = {
  never: '尚未开始历史回溯',
  backfill: '历史回溯未完成',
  reconcile: '全历史核对未完成',
  complete: '完整核对已完成',
};

/**
 * Stat value of the history coverage of one status; the completed state names the instant it
 * completed, and an unread status claims nothing at all.
 */
export function luoguHistoryCoverageLabel(status: ApiLuoguStatusView | null): string {
  if (status === null) {
    return '尚未读取';
  }
  if (status.historyComplete && status.historyCompletedAt !== null) {
    return `${LUOGU_HISTORY_STATE_LABELS.complete}（${luoguTime(status.historyCompletedAt)}）`;
  }
  return LUOGU_HISTORY_STATE_LABELS[luoguHistoryState(status)];
}

/**
 * Durable **history coverage** of the account, independent of the latest attempt's result.
 *
 * `historyComplete` is the only source of a "whole history was reconciled" claim; a failed scan
 * never clears it, an unfinished reconciliation is reported as not yet complete, and an account
 * that never read anything is never described as having a recent-window coverage.
 */
export function luoguHistoryCoverage(status: ApiLuoguStatusView | null): string {
  if (status === null) {
    return '历史覆盖：尚未读取同步状态。';
  }
  const state = luoguHistoryState(status);
  if (state === 'complete') {
    return `历史覆盖：已完成一次全历史核对（${luoguTime(status.historyCompletedAt)}）；之后按最近窗口增量同步。`;
  }
  if (state === 'never') {
    return '历史覆盖：尚未同步记录，也尚未开始历史回溯；「开始 / 继续同步」会先补齐历史，完成之前不会有最近窗口的增量记录。';
  }
  if (state === 'reconcile') {
    return '历史覆盖：全历史核对未完成；完成之前，很早以前的改判可能还没有反映。';
  }
  const progress = `已提交 ${status.totalPages} 页、处理 ${status.submissionsSeen} 条记录`;
  const resume = status.resumePending
    ? '继续同步会从已保存的检查点接着回溯'
    : '继续同步会接着做这次历史回溯';
  return `历史覆盖：历史回溯未完成（${progress}）；${resume}，完成之前很早以前的改判可能还没有反映。`;
}

/**
 * Result of the **latest attempt**, separate from history coverage and from the backlog.
 *
 * The failure names the half of the pass that failed (when the record carries a stage) and uses the
 * stage-aware guidance of {@link luoguSyncFailureGuidance}, so a metadata refusal is never rendered
 * as an expired cookie. A paused failure says so explicitly, because those codes wait for a user
 * action instead of retrying on their own.
 */
export function luoguAttemptSummary(status: ApiLuoguStatusView | null): string {
  if (status === null) {
    return '最近一次同步：尚未读取。';
  }
  const failure = status.failure;
  if (failure !== null) {
    const wait = failure.paused
      ? '自动同步已暂停，需要你处理后手动继续。'
      : failure.retryAt !== null
        ? `计划重试：${luoguTime(failure.retryAt)}。`
        : '';
    const where = failure.stage === undefined ? '' : `在${LUOGU_FAILURE_STAGE_LABELS[failure.stage]}时`;
    return `最近一次同步：${luoguTime(failure.at)} ${where}失败 — ${luoguSyncFailureGuidance(failure)}${wait}`;
  }
  if (status.lastSuccessAt !== null) {
    return `最近一次同步：${luoguTime(status.lastSuccessAt)} 成功完成。`;
  }
  return '最近一次同步：还没有完成过一次同步。';
}

/**
 * Metadata backlog of the account, kept apart from coverage and from the latest attempt.
 *
 * A full backlog is reported as backpressure (paging stops), never as dropped keys: this build has
 * no drop path, and the text says so instead of implying data loss.
 */
export function luoguBacklogSummary(status: ApiLuoguStatusView | null): string {
  if (status === null) {
    return '待补题目资料：尚未读取。';
  }
  const counters = `已补 ${status.metadataResolved}，失败 ${status.metadataFailed}`;
  if (status.metadataBacklog === 0) {
    return `待补题目资料：当前没有积压（${counters}）。`;
  }
  const full = status.metadataBacklogFull
    ? '已达到积压上限：同步会先停止拉取新的历史页，避免丢掉题目键；继续同步会优先整理这些题目资料。'
    : '继续同步会优先补齐这些题目的资料。';
  return `待补题目资料：${status.metadataBacklog} 题待补（${counters}）。${full}`;
}

/**
 * Committed progress of the account.
 *
 * Rows are counted as **processed**, not added: a replayed page upserts rows that already exist, so
 * a growing counter is not evidence of new submissions, new problems or new accepted verdicts. An
 * account that never read anything says exactly that instead of reporting a zero-filled pass.
 */
export function luoguProgressSummary(status: ApiLuoguStatusView | null): string {
  if (status === null) {
    return '同步进度：尚未读取。';
  }
  if (luoguHistoryState(status) === 'never') {
    return '同步进度：尚未同步记录；「开始 / 继续同步」会先补齐历史，完成之前不会有最近窗口的增量记录。';
  }
  const running = status.running
    ? '本轮正在运行'
    : status.leaseActive
      ? '另一个 dsh 实例正在运行本轮'
      : status.resumePending
        ? '有可以继续的进度'
        : '当前没有运行中的同步';
  return `同步进度：${running}；本轮已提交 ${status.pagesInPass} 页，累计提交 ${status.totalPages} 页，累计处理提交记录 ${status.submissionsSeen} 条（含重复核对与平台重判复查，不代表新增提交或新增通过）。`;
}

/** Next planned/expected automatic run, or the reason none will happen. */
export function luoguNextRunSummary(status: ApiLuoguStatusView | null): string {
  if (status === null) {
    return '自动同步：尚未读取。';
  }
  if (status.closing) {
    return '自动同步：插件正在关闭，不会开始新的自动同步；重启 dsh 后请在状态里确认。';
  }
  if (!status.settings.automaticEnabled) {
    return '自动同步：未开启。只有在这里为这个账号开启后，dsh 打开期间才会按间隔自动同步。';
  }
  if (status.failure !== null && status.failure.paused) {
    return `自动同步：已暂停 — ${luoguSyncFailureGuidance(status.failure)}`;
  }
  if (status.failure !== null && status.failure.retryAt !== null) {
    return `自动同步：已开启，上次失败后计划在 ${luoguTime(status.failure.retryAt)} 重试。`;
  }
  if (status.nextRunAt !== null) {
    return `自动同步：已开启，下次计划 ${luoguTime(status.nextRunAt)}（只在 dsh 打开时运行）。`;
  }
  return '自动同步：已开启，下一次计划时间尚未确定（只在 dsh 打开时运行）。';
}

/**
 * Human label of the half of a pass a failure came from.
 *
 * Absent from a legacy failure record, which carries no stage; the label is only ever rendered when
 * the durable record actually named the half.
 */
export const LUOGU_FAILURE_STAGE_LABELS: Readonly<Record<LuoguSyncFailureStage, string>> = {
  history: '读取提交记录',
  metadata: '补齐题目资料',
};

/**
 * Fixed next-action sentence per failure code for a **stage-less** failure: a record written before
 * the stage existed, or the standalone connection probe (which is a different operation from a sync
 * pass). Never provider text and never a silent retry claim.
 *
 * `auth_required` is deliberately neutral here: the code alone cannot prove that the saved session
 * expired, because the anonymous metadata read answers it too, so the sentence asks the user to check
 * the login instead of asserting an expiry.
 */
export const LUOGU_FAILURE_GUIDANCE: Readonly<Record<LuoguSyncFailureCode, string>> = {
  auth_required:
    '这次请求被平台要求登录：请在普通浏览器里确认这个账号仍能正常登录，再点「验证已保存的 Cookie」核对当前登录；若这次 Cookie 验证也失败，再重新复制 Cookie 值并重新连接。已同步的记录、进度与待补资料都会保留。',
  forbidden: '平台拒绝了这次访问：请确认账号在普通浏览器里可用，然后重新连接或手动继续。',
  rate_limited: '平台限流：进度已保留，会在计划的重试时间后继续，请不要连续手动点击。',
  timeout: '请求超时：多为网络或平台繁忙，进度已保留，可稍后手动继续。',
  unavailable: '平台暂时不可用：进度已保留，可稍后手动继续。',
  changed_response:
    '平台返回结构或同步游标与预期不符：这可能只是网站要求人工验证、或页面结构发生了变化，不一定是本地进度损坏。请先在普通浏览器里确认账号能正常登录并通过验证，再把 dsh 更新到兼容版本后重试；本地检查点会保留。除非你确实想重新核对全部历史，否则不必做「全历史完整核对」，也不要把自动重试当成修复。',
  invalid_input:
    '这次请求被拒绝：自动重试只会重复同样的结果，请按上面的说明修正后再手动继续；若怀疑本地进度与平台不一致，请做一次全历史完整核对。',
  not_connected: '当前没有可用连接：请先连接洛谷账号，再开始同步。',
  unsupported: '当前系统或构建不支持这项操作：不会自动重试，请在受支持的 Windows 环境使用。',
  lease_lost: '本轮同步的租约已失效（可能另一个 dsh 实例在同步）：请稍后手动继续，或关闭其他实例后重试。',
  cleanup_failed: '旧登录凭据未能从 Windows 凭据管理器删除：请再点一次「断开连接」重试，必要时重启 dsh。',
  internal: '本地同步出现未预期错误：自动重试不会修复，请查看 dsh 本地日志并重启 dsh 后重试。',
};

/**
 * Stage-specific sentences of the **public problem-metadata repair** (`stage: 'metadata'`).
 *
 * This half starts from an anonymous public read and, when that read is refused with
 * `auth_required`, makes exactly one retry with the account's own stored session. A final refusal is
 * therefore a problem-data completion failure — never a verdict that unrelated history is broken —
 * and the `auth_required` sentence asks the user to verify the login and to reconnect only when a
 * login check also fails, instead of asserting an expired cookie. Codes without an entry keep the
 * stage-less sentence, which is already accurate for them (a rate limit or an outage preserves
 * progress).
 *
 * A `forbidden` refusal of a `U`/`T` (user-created) problem is item-scoped: the key stays in the
 * backlog while the drain keeps processing other keys, so the `forbidden` sentence describes a
 * single pending item rather than a stopped pass. A final `auth_required`, a rate limit or an
 * unexpected page on a public problem still stops the drain.
 */
export const LUOGU_METADATA_FAILURE_GUIDANCE: Readonly<Partial<Record<LuoguSyncFailureCode, string>>> = {
  auth_required:
    '上一轮补齐题目资料时被洛谷要求登录。请先点「重试此题」或手动继续同步；当前版本在匿名读取要求登录时会使用当前账号保存的会话重试。仍失败时请点「验证已保存的 Cookie」，按结果重新连接。这不等于保存的登录凭据一定过期；已同步的提交记录、历史覆盖与检查点都会保留，待补题目资料继续排队。',
  forbidden:
    '上一轮在补齐题目资料时被平台拒绝访问：这通常是题目自己的访问权限或平台限制（例如自建 U / T 类题目），具体原因需要核对。已经同步的提交记录、历史覆盖与检查点都会保留，待补题目资料会继续排队；可以打开原题检查、稍后重试或手工补充。',
  changed_response:
    '上一轮在补齐题目资料时平台返回与预期不符：可能是人工验证或页面结构变化；此错误不表示本地记录损坏，重新连接也不能解决。已经同步的提交记录、历史覆盖与检查点都会保留，待补题目资料会继续排队，可稍后手动继续；不要为此做「全历史完整核对」。',
};

/**
 * Stage-specific sentences of the **authenticated history read** (`stage: 'history'`).
 *
 * A refusal here is a real authentication wall for the record request, but even then the sentence
 * asks the user to verify the login instead of asserting that the stored session expired.
 */
export const LUOGU_HISTORY_FAILURE_GUIDANCE: Readonly<Partial<Record<LuoguSyncFailureCode, string>>> = {
  auth_required:
    '上一轮在读取提交记录（需要登录的步骤）时被平台要求重新登录：已经提交的页面、历史覆盖与检查点都会保留。请先在普通浏览器里确认账号能正常登录，并点「验证已保存的 Cookie」核对当前登录，然后手动继续同步；若这次 Cookie 验证也失败，再重新复制 Cookie 值并重新连接。',
};

/**
 * Fixed stage-aware guidance of one synchronization failure.
 *
 * The recorded stage decides which half's sentences apply, so the latest-attempt summary, the
 * automatic-pause summary and the panel's failure advice can never disagree about what failed; a
 * metadata refusal is explained as a problem-data completion failure and never as an expired cookie.
 * A record without a stage (written before the field existed) keeps the neutral sentence.
 */
export function luoguSyncFailureGuidance(failure: LuoguSyncFailure): string;
export function luoguSyncFailureGuidance(failure: null): null;
export function luoguSyncFailureGuidance(failure: LuoguSyncFailure | null): string | null;
export function luoguSyncFailureGuidance(failure: LuoguSyncFailure | null): string | null {
  if (failure === null) {
    return null;
  }
  const stageSpecific =
    failure.stage === 'metadata'
      ? LUOGU_METADATA_FAILURE_GUIDANCE[failure.code]
      : failure.stage === 'history'
        ? LUOGU_HISTORY_FAILURE_GUIDANCE[failure.code]
        : undefined;
  return stageSpecific ?? LUOGU_FAILURE_GUIDANCE[failure.code];
}

/**
 * Fixed guidance of one **connection-record** failure code, or `null` when there is none.
 *
 * The stored connection record carries no pass stage: it is written by the standalone connection
 * probe (or a connect), which is a different operation from a synchronization pass, so this
 * stage-free sentence is the honest one for it.
 */
export function luoguFailureGuidance(code: LuoguSyncFailureCode | null): string | null {
  return code === null ? null : LUOGU_FAILURE_GUIDANCE[code];
}

/**
 * Honest relation between a **newer successful login check** and a still-standing sync failure.
 *
 * A connection probe that ran after the failed pass proves the saved session works *now*; it does
 * not retract the failure and it is never evidence that synchronization succeeded. Returns the
 * sentence to show in that situation, or `null` when there is nothing to add: no failure, no stored
 * connection, a connection that is not `connected`, or a check that is not newer than the failure
 * it would be compared with.
 */
export function luoguLoginCheckSummary(status: ApiLuoguStatusView | null): string | null {
  if (status === null) {
    return null;
  }
  const failure = status.failure;
  const connection = status.connection;
  if (failure === null || connection === null || connection.status !== 'connected') {
    return null;
  }
  const checked = Date.parse(connection.checkedAt);
  const failed = Date.parse(failure.at);
  if (!Number.isFinite(checked) || !Number.isFinite(failed) || checked <= failed) {
    return null;
  }
  return `当前 Cookie 验证：${luoguTime(connection.checkedAt)} 验证成功，保存的登录凭据现在可用；但这只说明现在能登录，最近一次同步（${luoguTime(failure.at)}）仍然失败，需要按上面的说明处理，并不代表同步成功。`;
}

/** Text of a `luogu.start` answer; every outcome is stated as committed, never as completed. */
export const LUOGU_START_OUTCOMES: Readonly<Record<ApiLuoguStartResult['outcome'], string>> = {
  started: '已开始新一轮同步（进度在后台提交，页面可以离开）。',
  coalesced: '已并入正在运行的同一轮同步，没有重复开始。',
  queued: '已排队：会在一轮结束后开始，等待期间可以离开页面。',
};

/**
 * Label of the explicit backlog-drain action (Sprint 22a).
 *
 * The parenthetical is the user-visible answer to "does synchronization cost AI credits?": this
 * action reads public problem data from Luogu only and never invokes a model.
 */
export const LUOGU_METADATA_DRAIN_LABEL = '补齐全部积压资料（不使用 AI）';

/**
 * The one short, always-visible answer to whether synchronization uses AI (Sprint 22a).
 *
 * The full explanation is rendered once inside「同步详情」({@link LUOGU_METADATA_DRAIN_NOTE}).
 */
export const LUOGU_NO_AI_NOTE =
  '洛谷同步直接读取洛谷平台数据，不调用 AI 模型，也不消耗 AI 额度。';

/**
 * Long guidance of the backlog-drain action, rendered exactly once inside「同步详情」(Sprint 22a).
 *
 * It states every fact a user needs before starting a long run: the ordinary per-pass batch, the
 * source-wide pacing, the one-attempt-per-key rule, that the page may be left while dsh must stay
 * open, that「暂停本轮」keeps finished items, and that no history or AI work is involved.
 */
export const LUOGU_METADATA_DRAIN_NOTE =
  '普通「开始 / 继续同步」每轮最多补齐 100 条题目资料；积压较多时可以点「补齐全部积压资料（不使用 AI）」一次处理当前积压。' +
  '该动作按题逐个请求洛谷公开题目数据，每个请求之间至少间隔 2 秒，开始时已有的积压每题只尝试一次，做完就停；积压较大时可能需要几十分钟。' +
  '进度按题保存在本机，可以离开页面，但 dsh 需要保持运行；「暂停本轮」会保留已完成的进度，之后再点一次即可继续。' +
  '需要登录才能读取的题目会用当前账号的登录凭据再尝试一次（每个请求之间仍有至少 2 秒间隔）；U / T 类自建题被平台拒绝访问时保留待补并继续处理其他题目，两次都被要求登录、限流或页面异常时暂停本轮。' +
  '它不读取提交历史，也不改变历史覆盖、检查点、自动同步设置或计划。';

/** Text of a `luogu.start` answer in the metadata-only mode; every outcome is stated as committed. */
export const LUOGU_METADATA_START_OUTCOMES: Readonly<Record<ApiLuoguStartResult['outcome'], string>> = {
  started: '已开始补齐积压资料（不使用 AI）：进度按题提交，页面可以离开，dsh 需要保持运行。',
  coalesced: '已并入正在运行的同一轮补齐积压资料，没有重复开始。',
  queued: '已排队：会在一轮结束后开始，等待期间可以离开页面。',
};

// ---------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------

/** One control of the panel. `reason` is always set when the control is disabled. */
export interface LuoguControl {
  readonly enabled: boolean;
  readonly reason: string | null;
}

export type LuoguAction =
  | 'connect'
  | 'probe'
  | 'disconnect'
  | 'start'
  | 'reconcile'
  | 'metadata'
  | 'cancel'
  | 'configure';

export const LUOGU_ACTION_LABELS: Readonly<Record<LuoguAction, string>> = {
  connect: '连接',
  probe: '验证已保存的 Cookie',
  disconnect: '断开连接',
  start: '开始 / 继续同步',
  reconcile: '全历史完整核对',
  metadata: '补齐积压资料',
  cancel: '暂停本轮',
  configure: '保存自动同步设置',
};

/** Everything the panel knows before it decides which controls are usable. */
export interface LuoguControlInput {
  readonly status: ApiLuoguStatusView | null;
  /** Action currently in flight, or `null`; one host action at a time. */
  readonly busy: LuoguAction | null;
  /** A validated session draft is present in memory (connect only). */
  readonly secretReady: boolean;
  /** The automatic-sync draft differs from the durable settings. */
  readonly settingsDirty: boolean;
  /** The user explicitly confirmed that a full reconciliation rescans all history. */
  readonly fullConfirmed: boolean;
}

const ALLOWED: LuoguControl = { enabled: true, reason: null };

/**
 * Derive every control's state from the durable status.
 *
 * The rules are status-driven on purpose: a remount with the same status shows the same controls, so
 * a running pass is never "recreated" by navigating, and a control is never enabled by a local guess
 * about a host state the panel cannot see.
 */
export function luoguControls(input: LuoguControlInput): Readonly<Record<LuoguAction, LuoguControl>> {
  const { status, busy, secretReady, settingsDirty, fullConfirmed } = input;
  if (busy !== null) {
    const reason = `上一个操作（${LUOGU_ACTION_LABELS[busy]}）仍在进行，请等待它结束。`;
    return denyAll(reason);
  }
  if (status === null) {
    return denyAll('尚未读取到该账号的洛谷同步状态，请稍候或刷新。');
  }
  if (status.closing) {
    return denyAll('插件正在关闭或重启：请刷新页面，必要时重启 dsh 后再操作。');
  }
  const connected = status.connection !== null && status.connection.status === 'connected';
  const connectionReason = status.connectionAvailable
    ? '尚未连接：请先粘贴 Cookie 值并点「连接」。'
    : `当前系统（${status.connectionPlatform}）没有可用的安全凭据存储，无法保存登录凭据。`;
  const syncReason = connected
    ? status.running
      ? '本轮同步正在运行：可以等它完成，或点「暂停本轮」。'
      : null
    : `连接状态为「${luoguConnectionText(status)}」：请先连接或重新连接洛谷账号。`;
  return {
    connect: status.connectionAvailable
      ? secretReady
        ? ALLOWED
        : { enabled: false, reason: '请先粘贴登录凭据：默认填写 __client_id 的 Value（值），也可以改用整段 Cookie。' }
      : { enabled: false, reason: connectionReason },
    probe: status.connectionAvailable
      ? status.connection === null
        ? { enabled: false, reason: connectionReason }
        : ALLOWED
      : { enabled: false, reason: connectionReason },
    disconnect:
      status.connectionAvailable && status.connection !== null
        ? ALLOWED
        : { enabled: false, reason: connectionReason },
    start: syncReason === null ? ALLOWED : { enabled: false, reason: syncReason },
    metadata:
      syncReason !== null
        ? { enabled: false, reason: syncReason }
        : status.metadataBacklog === 0
          ? { enabled: false, reason: '当前没有待补的题目资料：积压为 0 时不会发起任何请求。' }
          : ALLOWED,
    reconcile:
      syncReason !== null
        ? { enabled: false, reason: syncReason }
        : fullConfirmed
          ? ALLOWED
          : { enabled: false, reason: '全历史完整核对会重新扫描这个账号的全部历史，请先勾选确认。' },
    cancel: status.running
      ? ALLOWED
      : { enabled: false, reason: '当前没有由本实例运行的同步：暂停只会停止本轮，不能停止其他实例。' },
    configure: settingsDirty ? ALLOWED : { enabled: false, reason: '自动同步设置没有变化。' },
  };
}

function denyAll(reason: string): Readonly<Record<LuoguAction, LuoguControl>> {
  const denied: LuoguControl = { enabled: false, reason };
  return {
    connect: denied,
    probe: denied,
    disconnect: denied,
    start: denied,
    metadata: denied,
    reconcile: denied,
    cancel: denied,
    configure: denied,
  };
}

// ---------------------------------------------------------------------------------------
// Compact default view (Sprint 20b)
// ---------------------------------------------------------------------------------------

/**
 * Label of the single credential trigger.
 *
 * Before any connection record exists the control's whole job is to connect, so it says so; once a
 * record exists (connected or failed) the same control re-opens the saved session, and calling that
 * "连接" would suggest the account is not connected when it is. There is exactly one such control, so
 * the two labels are the only two states of one disclosure.
 */
export function luoguCredentialActionLabel(status: ApiLuoguStatusView | null): string {
  return status !== null && status.connection !== null ? '更新登录凭据' : '连接洛谷';
}

/**
 * One compact answer of the collapsed Luogu card.
 *
 * The card is the default view of the panel, so every field is a *short* claim that stays true while
 * the card is closed: the connection state, the last login check, the history-coverage label, the
 * metadata backlog, the automation state and — separately — one sentence about a failed or paused
 * latest attempt. The long stage-aware advice is deliberately absent: {@link LuoguCompactSummary.alert}
 * says what happened and points at「同步详情」, where each long sentence is rendered exactly once.
 */
export interface LuoguCompactSummary {
  /** Connection-state label of the stored connection, or the fixed "not connected" sentence. */
  readonly connection: string;
  /** Local rendering of the last completed login check; `null` when there is no stored connection. */
  readonly checkedAt: string | null;
  /** History-coverage label: the only claim of a covered window, otherwise an honest "not yet". */
  readonly history: string;
  /** Short metadata-backlog claim, including the full-backlog backpressure state. */
  readonly backlog: string;
  /** Short automation claim, including the next planned run when one is known. */
  readonly automation: string;
  /** One short failure sentence, or `null` when the latest attempt is not a failure. */
  readonly alert: string | null;
}

/**
 * Project one read status into the collapsed card's claims.
 *
 * A `null` status answers 尚未读取 everywhere instead of zero-filled claims, exactly like the long
 * projections it summarises. Nothing here invents a state: the strings come from the same helpers the
 * expanded sections use ({@link luoguConnectionText}, {@link luoguHistoryCoverageLabel},
 * {@link luoguTime}), so the compact and the detailed view can never disagree.
 */
export function luoguCompactSummary(status: ApiLuoguStatusView | null): LuoguCompactSummary {
  if (status === null) {
    return {
      connection: luoguConnectionText(null),
      checkedAt: null,
      history: '尚未读取',
      backlog: '尚未读取',
      automation: '尚未读取',
      alert: null,
    };
  }
  const failure = status.failure;
  return {
    connection: luoguConnectionText(status),
    checkedAt: status.connection === null ? null : luoguTime(status.connection.checkedAt),
    history: luoguHistoryCoverageLabel(status),
    backlog: compactBacklog(status),
    automation: compactAutomation(status),
    alert: failure === null ? null : compactAlert(failure, status.settings.automaticEnabled),
  };
}

/** Short backlog claim; the full-backlog case names the backpressure instead of a bare number. */
function compactBacklog(status: ApiLuoguStatusView): string {
  if (status.metadataBacklog === 0) {
    return '资料无积压';
  }
  return status.metadataBacklogFull
    ? `资料积压 ${status.metadataBacklog} 题（已达上限）`
    : `资料积压 ${status.metadataBacklog} 题`;
}

/** Short automation claim; "已开启" without a known instant says so instead of inventing one. */
function compactAutomation(status: ApiLuoguStatusView): string {
  if (status.closing) {
    return '自动同步：关闭中';
  }
  if (!status.settings.automaticEnabled) {
    return '自动同步：未开启';
  }
  if (status.failure !== null && status.failure.paused) {
    return '自动同步：已暂停';
  }
  if (status.failure !== null && status.failure.retryAt !== null) {
    return `自动同步：已开启，约 ${luoguTime(status.failure.retryAt)} 重试`;
  }
  if (status.nextRunAt !== null) {
    return `自动同步：已开启，下次 ${luoguTime(status.nextRunAt)}`;
  }
  return '自动同步：已开启';
}

/**
 * One short failure sentence of the collapsed card.
 *
 * It names the half of the pass that failed when the durable record carries a stage (the same
 * {@link LUOGU_FAILURE_STAGE_LABELS} the expanded summary uses), says whether automation is paused or
 * when the next retry is planned, and points at「同步详情」for the full next-action sentence. The
 * existence of the failure is therefore never hidden, and the long guidance is not repeated here.
 */
function compactAlert(failure: LuoguSyncFailure, automaticEnabled: boolean): string {
  const where =
    failure.stage === undefined
      ? '最近一次同步失败'
      : `最近一次同步在${LUOGU_FAILURE_STAGE_LABELS[failure.stage]}时失败`;
  const next = !automaticEnabled
    ? '；展开「同步详情」查看处理办法后手动继续。'
    : failure.paused
    ? '，自动同步已暂停；展开「同步详情」查看处理办法。'
    : failure.retryAt !== null
      ? `，计划 ${luoguTime(failure.retryAt)} 重试；详情见「同步详情」。`
      : '；展开「同步详情」查看处理办法。';
  return where + next;
}

/**
 * Reason to render under the primary sync action, or `null` when rendering one would be noise.
 *
 * The primary control keeps its actionable reason — no connection, plugin closing, status unread —
 * because the user can do something about it. Nothing is printed while an action is in flight (every
 * control is denied by {@link luoguControls} anyway) and nothing is printed while this instance is
 * running, because then「暂停本轮」next to it *is* the action, so repeating "本轮正在运行" only adds
 * noise. The reason is never invented here: it is the one {@link luoguControls} already gives.
 */
export function luoguPrimaryActionReason(
  status: ApiLuoguStatusView | null,
  control: LuoguControl,
  busy: boolean,
): string | null {
  if (busy || control.enabled || control.reason === null || status === null || status.running) {
    return null;
  }
  return control.reason;
}

// ---------------------------------------------------------------------------------------
// Automatic-sync settings
// ---------------------------------------------------------------------------------------

/** Editable form of one account's durable automatic-sync settings; the interval stays text. */
export interface LuoguSettingsDraft {
  readonly automaticEnabled: boolean;
  readonly runOnStartup: boolean;
  readonly intervalMinutes: string;
}

/** Build the editable draft of one durable settings value. */
export function luoguSettingsDraft(settings: LuoguSyncSettings): LuoguSettingsDraft {
  return {
    automaticEnabled: settings.automaticEnabled,
    runOnStartup: settings.runOnStartup,
    intervalMinutes: String(settings.intervalMinutes),
  };
}

/** True when the draft would change at least one stored field. */
export function luoguSettingsDirty(status: ApiLuoguStatusView | null, draft: LuoguSettingsDraft): boolean {
  if (status === null) {
    return false;
  }
  const interval = parseInterval(draft.intervalMinutes);
  return (
    draft.automaticEnabled !== status.settings.automaticEnabled ||
    draft.runOnStartup !== status.settings.runOnStartup ||
    (interval !== null && interval !== status.settings.intervalMinutes)
  );
}

/**
 * Whether the automatic-sync inputs may be edited at all (Sprint 20b).
 *
 * Editing is gated on the host being able to accept a change — nothing in flight and the plugin not
 * closing — and never on whether the draft is already dirty. The earlier gate
 * (`!controls.configure.enabled && !settingsDirty`) disabled every field exactly while the user still
 * had to make the first change, because `configure` is only enabled *by* a dirty draft: untouched
 * toggles could never be turned on. The save button is the control that requires a change, so saving
 * still happens only from a dirty draft, and merely opening the section edits and saves nothing.
 */
export function luoguSettingsEditable(status: ApiLuoguStatusView | null, busy: boolean): boolean {
  return status !== null && !busy && !status.closing;
}

/** Outcome of turning a draft into a `luogu.configure` request. */
export type LuoguSettingsPatch =
  | { readonly ok: true; readonly request: ApiLuoguConfigureRequest }
  | { readonly ok: false; readonly message: string };

/**
 * Turn one settings draft into the exact patch the route accepts.
 *
 * Only changed fields are sent (the route refuses an empty patch), the revision the caller read is
 * always named so a decision made elsewhere is never overwritten, and an interval outside
 * {@link LUOGU_INTERVAL_MIN_MINUTES}..{@link LUOGU_INTERVAL_MAX_MINUTES} is refused locally with a
 * fixed sentence instead of being sent for the route to reject.
 */
export function luoguSettingsPatch(
  status: ApiLuoguStatusView,
  draft: LuoguSettingsDraft,
): LuoguSettingsPatch {
  const interval = parseInterval(draft.intervalMinutes);
  if (interval === null) {
    return {
      ok: false,
      message: `自动同步间隔需为 ${LUOGU_INTERVAL_MIN_MINUTES}–${LUOGU_INTERVAL_MAX_MINUTES} 之间的整数分钟。`,
    };
  }
  const patch: {
    accountId: string;
    expectedRevision: number | null;
    automaticEnabled?: boolean;
    runOnStartup?: boolean;
    intervalMinutes?: number;
  } = { accountId: status.accountId, expectedRevision: status.settingsRevision };
  if (draft.automaticEnabled !== status.settings.automaticEnabled) {
    patch.automaticEnabled = draft.automaticEnabled;
  }
  if (draft.runOnStartup !== status.settings.runOnStartup) {
    patch.runOnStartup = draft.runOnStartup;
  }
  if (interval !== status.settings.intervalMinutes) {
    patch.intervalMinutes = interval;
  }
  if (
    patch.automaticEnabled === undefined &&
    patch.runOnStartup === undefined &&
    patch.intervalMinutes === undefined
  ) {
    return { ok: false, message: '自动同步设置没有变化。' };
  }
  return { ok: true, request: patch };
}

/** Parse the editable interval text into an accepted integer, or `null` when it is not one. */
function parseInterval(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= LUOGU_INTERVAL_MIN_MINUTES && value <= LUOGU_INTERVAL_MAX_MINUTES
    ? value
    : null;
}

// ---------------------------------------------------------------------------------------
// Refresh decisions
// ---------------------------------------------------------------------------------------

/**
 * One status read reduced to the facts that decide whether the bank and the bootstrap must re-read.
 *
 * `totalPages`/`submissionsSeen` are the committed counters (processed rows, not new submissions);
 * `running`/`leaseActive` say whether a pass still works on the account — in this plugin instance
 * or in another one.
 */
export interface LuoguSyncProgress {
  readonly accountId: string;
  readonly lastSuccessAt: string | null;
  readonly totalPages: number;
  readonly submissionsSeen: number;
  readonly running: boolean;
  readonly leaseActive: boolean;
}

/** The panel's stored baseline plus the refresh it still owes for progress seen mid-pass. */
export interface LuoguSyncProgressState extends LuoguSyncProgress {
  readonly pendingRefresh: boolean;
}

/** One decision: the new baseline to keep and whether the bank/bootstrap must re-read now. */
export interface LuoguSyncProgressStep {
  readonly state: LuoguSyncProgressState;
  readonly refresh: boolean;
}

/**
 * Fold one durable status into the panel's per-account refresh baseline.
 *
 * The rules, in order:
 *
 * - A first read — or the first read after the account changed — is **adopted silently**; mounting
 *   the panel, navigating back to it and polling the same account never look like new local data.
 * - A new `lastSuccessAt` is a committed completion and refreshes **immediately**, exactly once.
 * - Committed pages seen while a pass is still running only mark the refresh as *owed*; it is paid
 *   once when the pass is observed to have ended (`running`/`leaseActive` both false), so a pass
 *   that stopped early by cancellation or failure still refreshes the rows it committed, while
 *   2-second polling never causes a refresh storm.
 * - Anything else — an unchanged poll, a status that only repeats itself — refreshes nothing.
 *
 * The baseline is per account and is initialized even when `lastSuccessAt` is `null`, so a
 * never-synced account's **first** successful sync is not mistaken for a completion already seen.
 */
export function luoguSyncProgressStep(
  previous: LuoguSyncProgressState | null,
  next: LuoguSyncProgress,
): LuoguSyncProgressStep {
  if (previous === null || previous.accountId !== next.accountId) {
    return { state: { ...next, pendingRefresh: false }, refresh: false };
  }
  const succeeded = previous.lastSuccessAt !== next.lastSuccessAt;
  const committed = previous.totalPages !== next.totalPages || previous.submissionsSeen !== next.submissionsSeen;
  const settled = !next.running && !next.leaseActive;
  const pendingRefresh = succeeded || committed || previous.pendingRefresh;
  if (pendingRefresh && (succeeded || settled)) {
    return { state: { ...next, pendingRefresh: false }, refresh: true };
  }
  return { state: { ...next, pendingRefresh }, refresh: false };
}

// ---------------------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------------------

/**
 * Delay before the next `luogu.status` read, or `null` when polling must stop.
 *
 * A reserved or running pass polls fast, an account with automation enabled polls slowly (its own
 * 60 s host tick may start a pass), and everything else stops. `startPending` covers the instant
 * between the committed reservation and the first status that shows it.
 */
export function luoguPollDelayMs(status: ApiLuoguStatusView | null, startPending: boolean): number | null {
  if (startPending) {
    return LUOGU_POLL_ACTIVE_MS;
  }
  if (status === null || status.closing) {
    return null;
  }
  if (status.running || status.leaseActive) {
    return LUOGU_POLL_ACTIVE_MS;
  }
  return status.settings.automaticEnabled ? LUOGU_POLL_IDLE_MS : null;
}

// ---------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------

/**
 * How to obtain the session material from the user's own logged-in Luogu session.
 *
 * The default path is the `__client_id` **value**: it is the only field the user has to copy, because
 * `_uid` is the numeric account UID and the panel fills it from the selected account. The advanced
 * whole-Cookie path stays available for users who already copy the request header, and both paths are
 * normalized to the same two cookies before anything is stored or sent.
 */
export const LUOGU_COOKIE_GUIDE: readonly string[] = [
  '在你平时使用的浏览器里登录洛谷，按 F12 打开开发者工具，切到「Application / 应用」→ 左侧 Storage 里的 Cookies → 选中 https://www.luogu.com.cn。',
  '找到 __client_id 这一行，只复制它的「Value / 值」一列：不要复制 Name、Domain、Path、Expires 等其他列，也不要带引号或多余空格。',
  '把复制的值粘贴到下面的「__client_id 的值」输入框；上方的 _uid 会使用当前账号的数字 UID（两者含义不同，不能互相替代，也不能手工编造）。',
  '若你更习惯整段复制：勾选「高级：粘贴整段 Cookie」，再把浏览器请求标头里 Cookie 的完整值粘进去；提交前也只会保留 __client_id 与 _uid 两项。',
  '点「连接」。提交后输入框会立即清空，切换账号或离开本页也会清空。',
];

/** Why the `_uid` field is readonly: it is the selected account's numeric UID, not a user choice. */
export const LUOGU_UID_DISPLAY_NOTE =
  '_uid 就是你的数字 UID，与「当前账号」的洛谷 UID 完全相同：它由所选账号决定，这里只读显示，不能手工修改；切换账号时它会跟着变，同时清空正在填写的登录凭据。';

/** Exactly which column of the developer tools the default field wants. */
export const LUOGU_CLIENT_ID_HELP =
  '默认只需要 __client_id 的 Value（值）：在 F12 → Application（应用）→ Cookies → https://www.luogu.com.cn 里找到 __client_id 一行，只复制 Value 一列，不要复制 Name、Domain、Path 等列。';

/**
 * The one-line instruction under the default field (Sprint 20b).
 *
 * The revealed credential form stays short: it names the exact screen and the exact column, and the
 * longer {@link LUOGU_CLIENT_ID_HELP}, {@link LUOGU_FULL_COOKIE_HELP} and {@link LUOGU_COOKIE_GUIDE}
 * explanations live once inside the single「如何获取 Cookie」expansion.
 */
export const LUOGU_CLIENT_ID_INSTRUCTION =
  'F12 → Application（应用）→ Cookies → https://www.luogu.com.cn：复制 __client_id 一行的 Value（值）。';

/** One brief local-only note under the credential fields; the full storage promise is in the help. */
export const LUOGU_SECRET_LOCAL_ONLY_NOTE =
  '只在本机使用：凭据保存在 Windows 凭据管理器，不会写入日志、备份或 AI 请求。';

/** What the advanced mode accepts, and what it still discards. */
export const LUOGU_FULL_COOKIE_HELP =
  '高级模式可以粘贴整段 Cookie 值（浏览器请求标头里 Cookie 的完整内容，可带 Cookie: 前缀）：提交前会只保留 __client_id 与 _uid 两项，其余 Cookie 一律丢弃，不会保存也不会发送。复制其他 Cookie 并不能代替登录，也不能保证通过平台的人工验证。';

/** Label of the advanced-mode checkbox. */
export const LUOGU_FULL_COOKIE_TOGGLE = '高级：粘贴整段 Cookie（兼容旧用法）';

/** Memory-only promise of both inputs. */
export const LUOGU_SECRET_MEMORY_NOTE =
  '这些输入框只存在于当前页面内存：提交尝试、切换账号、切换方式或离开本页后都会清空，出错信息也不会回显内容。';

/** Where the login material goes, and where it must never go. */
export const LUOGU_SECRET_STORAGE_NOTE =
  '登录凭据只发送给本机 dsh 的洛谷连接操作；保存前会只保留 __client_id 与 _uid 两项，其余 Cookie 一律丢弃。凭据保存在 Windows 凭据管理器（随工作台数据目录隔离），不会写入 localStorage、备份、日志或 AI 请求。';

/** Explicit warning about pasting the same material into a chat or an online service. */
export const LUOGU_AI_CHAT_WARNING =
  '不要把 Cookie 或 __client_id 粘贴到 AI 对话、聊天群或任何在线服务：那等同于把账号登录权交给对方。';

/** Disconnect scope: credentials only, never the synchronized local data. */
export const LUOGU_DISCONNECT_NOTE =
  '「断开连接」只删除本机保存的登录凭据：这个账号已经同步到本地题库的题目、提交记录、材料与统计都会保留。';

/**
 * What「开始 / 继续同步」really does, and why an incremental scan is not a full reconciliation.
 *
 * The first claim is the honest order of work: while any history is still missing the button
 * continues or starts the **backfill**, and only a finished whole-history pass turns it into the
 * recent-window incremental scan.
 */
export const LUOGU_RECENT_WINDOW_NOTE =
  '「开始 / 继续同步」会先补齐历史：历史回溯还没完成时，它从已保存的检查点继续（没有检查点就重新开始）历史回溯，只有在一次完整的全历史扫描完成后才转入最近窗口增量（含最近一周的重判重叠）。很早以前被重判的记录不会因此改变，需要显式做一次「全历史完整核对」；核对会重新扫描全部历史，耗时更长，但不会删除已有记录。';

/** What an accepted submission does and does not prove. */
export const LUOGU_AC_EVIDENCE_NOTE =
  '平台上的「已通过」记录只是外部证据：它不代表你独立掌握了解法，也不替代标签审核与人工判断。';

/** Automation scope: the host must be open, and the switch is per account. */
export const LUOGU_AUTOMATION_NOTE =
  '自动同步按账号单独开启，默认关闭；只有在 dsh 打开时才会按间隔运行，关闭 dsh 后不会同步。修改全局平台限速需要重启 dsh 才对洛谷来源生效；这里每个账号的自动同步设置是立即生效的。';

/** Manual import stays available next to the connection panel. */
export const LUOGU_MANUAL_STILL_AVAILABLE =
  '没有可用凭据或不想连接时，本页的 JSON / CSV 手工导入入口仍然可用，功能没有被替换。';

/** Unsupported-OS sentence; the platform is disclosed so the reason is checkable. */
export function luoguUnsupportedOsNote(platform: string): string {
  return `当前系统（${platform}）没有可用的安全凭据存储，因此「连接 / 验证已保存的 Cookie / 断开」不可用。账号、题库、导入与 AI 功能仍然可以使用。`;
}
