/**
 * Derived view rules of the dedicated Luogu connection/sync panel (Sprint 17d2).
 *
 * This module is **pure**: no HTTP, no DOM, no React, no storage and no clock of its own, so the
 * panel's honesty rules and its control gating can be tested without a browser. It holds exactly
 * three kinds of rule:
 *
 * 1. **Secret handling.** {@link checkLuoguSessionCookie} validates the ephemeral session draft
 *    locally (non-blank, no control characters, at most the credential store's 2560 UTF-8 bytes) and
 *    only ever answers a fixed sentence: the draft is never repeated in a message, and nothing here
 *    reads or writes `localStorage`, `sessionStorage`, a URL, a log or a model input.
 * 2. **Honest status projection.** History coverage, the latest attempt's result and the metadata
 *    backlog are three *separate* answers ({@link luoguHistoryCoverage}, {@link luoguAttemptSummary},
 *    {@link luoguBacklogSummary}), so an unread, empty or failed status can never be rendered as
 *    "0 records synced successfully". Processed rows are always labelled as *including* duplicate
 *    checks and rejudge replays, never as new submissions.
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
  LuoguSyncFailureCode,
  LuoguSyncSettings,
} from '../application/luogu-sync-types.js';

// ---------------------------------------------------------------------------------------
// Mirrored bounds
// ---------------------------------------------------------------------------------------

/** Longest session cookie the OS credential store accepts (the 17d1 route bound). */
export const LUOGU_SECRET_MAX_BYTES = 2560;

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

/** Local verdict on the session draft; `invalid` always carries a fixed explanation. */
export interface LuoguSecretCheck {
  readonly state: 'empty' | 'invalid' | 'valid';
  readonly message: string | null;
}

/** Control characters a pasted cookie can never contain; a space is legitimate. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validate one ephemeral session draft before it is submitted to `luogu.connect`.
 *
 * This is a local courtesy check only — the authenticated route revalidates and is the authority.
 * No branch of it can echo the draft: the three possible answers are `empty` (no message), `invalid`
 * (one fixed sentence) and `valid`. The draft is measured in UTF-8 bytes, because that is what the
 * OS credential blob bounds.
 */
export function checkLuoguSessionCookie(draft: string): LuoguSecretCheck {
  if (draft.trim().length === 0) {
    return { state: 'empty', message: null };
  }
  if (CONTROL_CHARACTERS.test(draft)) {
    return { state: 'invalid', message: '登录凭据里含有换行或控制字符：请只粘贴浏览器请求中 Cookie 的一行值。' };
  }
  if (new TextEncoder().encode(draft).length > LUOGU_SECRET_MAX_BYTES) {
    return {
      state: 'invalid',
      message: `登录凭据超过 ${LUOGU_SECRET_MAX_BYTES} 字节上限：请只粘贴浏览器请求中 Cookie 的值，不要连同请求头一起复制。`,
    };
  }
  return { state: 'valid', message: null };
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
 * A paused failure says so explicitly, because those codes wait for a user action instead of
 * retrying on their own.
 */
export function luoguAttemptSummary(status: ApiLuoguStatusView | null): string {
  if (status === null) {
    return '最近一次同步：尚未读取。';
  }
  if (status.failure !== null) {
    const wait = status.failure.paused
      ? '自动同步已暂停，需要你处理后手动继续。'
      : status.failure.retryAt !== null
        ? `计划重试：${luoguTime(status.failure.retryAt)}。`
        : '';
    return `最近一次同步：${luoguTime(status.failure.at)} 失败 — ${LUOGU_FAILURE_GUIDANCE[status.failure.code]}${wait}`;
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
    return `自动同步：已暂停 — ${LUOGU_FAILURE_GUIDANCE[status.failure.code]}`;
  }
  if (status.failure !== null && status.failure.retryAt !== null) {
    return `自动同步：已开启，上次失败后计划在 ${luoguTime(status.failure.retryAt)} 重试。`;
  }
  if (status.nextRunAt !== null) {
    return `自动同步：已开启，下次计划 ${luoguTime(status.nextRunAt)}（只在 dsh 打开时运行）。`;
  }
  return '自动同步：已开启，下一次计划时间尚未确定（只在 dsh 打开时运行）。';
}

/** Fixed next-action sentence per failure code; never provider text and never a silent retry claim. */
export const LUOGU_FAILURE_GUIDANCE: Readonly<Record<LuoguSyncFailureCode, string>> = {
  auth_required: '登录凭据已失效：请在普通浏览器登录洛谷后重新复制 Cookie 值并重新连接。',
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

/** Fixed guidance of one failure code, or `null` when there is no failure to explain. */
export function luoguFailureGuidance(code: LuoguSyncFailureCode | null): string | null {
  return code === null ? null : LUOGU_FAILURE_GUIDANCE[code];
}

/** Text of a `luogu.start` answer; every outcome is stated as committed, never as completed. */
export const LUOGU_START_OUTCOMES: Readonly<Record<ApiLuoguStartResult['outcome'], string>> = {
  started: '已开始新一轮同步（进度在后台提交，页面可以离开）。',
  coalesced: '已并入正在运行的同一轮同步，没有重复开始。',
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
  | 'cancel'
  | 'configure';

export const LUOGU_ACTION_LABELS: Readonly<Record<LuoguAction, string>> = {
  connect: '连接',
  probe: '检查登录',
  disconnect: '断开连接',
  start: '开始 / 继续同步',
  reconcile: '全历史完整核对',
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
        : { enabled: false, reason: '请先粘贴登录凭据（浏览器请求里 Cookie 的值）。' }
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
    reconcile: denied,
    cancel: denied,
    configure: denied,
  };
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
 * How to obtain the Cookie **value** from the user's own logged-in Luogu session.
 *
 * The wording prefers copying the whole Cookie value over handcrafting one: `_uid` is the numeric
 * account UID and `__client_id` is the opaque session identifier, and they are not interchangeable
 * or guessable.
 */
export const LUOGU_COOKIE_GUIDE: readonly string[] = [
  '在你平时使用的浏览器里登录洛谷，打开任意一个已登录页面（例如自己的提交记录页）。',
  '按 F12 打开开发者工具，切到「网络 / Network」，刷新页面，点开任意一个发往 www.luogu.com.cn 的请求。',
  '在「请求标头 / Request Headers」里找到 Cookie 一行，复制它的完整值（整段 Cookie 值最稳妥，不要只挑一段拼）。',
  '其中 _uid 是你的数字 UID（和账号 UID 相同），__client_id 是不透明的会话标识；两者含义不同、不能互相替代或手工编造。',
  '把这段值粘贴到下面的「登录凭据（Cookie 值，只在本机使用）」输入框，然后点「连接」。提交后输入框会立即清空。',
];

/** Where the login material goes, and where it must never go. */
export const LUOGU_SECRET_STORAGE_NOTE =
  '登录凭据只发送给本机 dsh 的洛谷连接操作，保存在 Windows 凭据管理器（随工作台数据目录隔离）。它不会写入 localStorage、备份、日志或 AI 请求。';

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
  return `当前系统（${platform}）没有可用的安全凭据存储，因此「连接 / 检查登录 / 断开」不可用。账号、题库、导入与 AI 功能仍然可以使用。`;
}
