/**
 * Derived view rules of the Luogu metadata backlog and manual-recovery panel (Sprint 25b).
 *
 * This module is **pure**: no HTTP, no DOM, no React, no storage and no clock of its own, so every
 * decision the recovery UI makes can be tested without a browser. It owns three kinds of rule:
 *
 * 1. **Honest per-key diagnostics.** {@link luoguMetadataIssueText} translates the closed
 *    `PlatformErrorReason` vocabulary into fixed Chinese sentences. `missing_statement` is named as
 *    an empty description; the parser-shaped reasons (`html_response`, `invalid_json`,
 *    `invalid_payload`) stay explicitly *uncertain* and never invent a diagnosis, a raw exception
 *    text or a "cookie expired" conclusion. A key with no recorded issue says exactly
 *    {@link LUOGU_METADATA_ISSUE_UNKNOWN_LABEL} plus the honest explanation that old data carries no
 *    per-key record — never "this was never tried".
 * 2. **Counts that cannot be confused.** {@link luoguMetadataCounts} keeps the pending **item** count,
 *    the per-page known-issue count and the account's lifetime failed **attempt** count as three
 *    separate claims, so a lifetime counter is never rendered as "N failed problems".
 * 3. **Closed form and mutation rules.** {@link luoguSupplementValidation} turns a draft into the
 *    exact `luogu.supplementMetadata` request (or a fixed field error), always carrying the
 *    `expectedSnapshotId` the caller saw; {@link luoguMetadataMutationReason} derives the one reason
 *    every per-item mutation is disabled for; {@link luoguMetadataRetryText} distinguishes the three
 *    retry outcomes; and {@link luoguStartNoticeStep} keeps the transient "已开始新一轮同步…" notice
 *    from surviving the durable run it announced.
 *
 * The constants mirrored from the application module are declared here instead of imported at
 * runtime: the browser half must stay free of host/application code, and
 * `tests/ui/luogu-metadata-view.test.ts` asserts the mirrored values against
 * `src/application/luogu-sync-types.ts` and `src/application/platform-errors.ts` so they cannot drift.
 */
import type {
  ApiLuoguMetadataBacklogItem,
  ApiLuoguMetadataBacklogView,
  ApiLuoguRetryMetadataResult,
  ApiLuoguStartResult,
  ApiLuoguStatusView,
  ApiLuoguSupplementMetadataRequest,
} from '../application/workbench-api.js';
import type { LuoguMetadataIssue } from '../application/luogu-sync-types.js';
import type { PlatformErrorReason } from '../application/platform-errors.js';
import { LUOGU_FAILURE_STAGE_LABELS, luoguTime } from './luogu-view.js';

// ---------------------------------------------------------------------------------------
// Bounds and fixed copy
// ---------------------------------------------------------------------------------------

/** Default page size of one backlog read; mirrors `LUOGU_METADATA_BACKLOG_DEFAULT_PAGE_SIZE`. */
export const LUOGU_METADATA_BACKLOG_PAGE_SIZE = 20;

/** Hard upper bound of one backlog read; mirrors `LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE`. */
export const LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE = 50;

/**
 * Page sizes this panel offers.
 *
 * Both stay far below the endpoint bound, so one read renders at most 25 item rows — the panel never
 * mounts the whole backlog (which can hold thousands of keys) as textareas or rows.
 */
export const LUOGU_METADATA_PAGE_SIZE_OPTIONS: readonly number[] = [20, 25];

/**
 * Fixed sentence for a queued key with no recorded per-key diagnostic.
 *
 * Mirrors `LUOGU_METADATA_UNKNOWN_ISSUE_LABEL`; the rendered panel uses the server's own
 * `unknownIssueLabel` when it has one, so the two can never disagree in production.
 */
export const LUOGU_METADATA_ISSUE_UNKNOWN_LABEL = '尚无逐题失败记录';

/** Prefix of the one backlog disclosure; the pending count is appended in parentheses. */
export const LUOGU_METADATA_DISCLOSURE_PREFIX = '待补题目与手动处理';

/** One short paragraph explaining what the whole disclosure does and does not do. */
export const LUOGU_METADATA_MANUAL_NOTE =
  '这里逐题处理缺少的本地题目资料：只读取这一页待补列表，不会拉取整个积压。「重试此题」只重试这一题的公开资料；「手工补充」只写入你自己提供的标题与题面。两者都不读取提交历史、不改变检查点与自动同步设置，也不使用 AI。';

/** The exact scope sentence of the manual supplement form. */
export const LUOGU_SUPPLEMENT_AUDIT_NOTE = '仅补齐本地题目资料，不改变通过记录或自动确认标签。';

/** The exact model sentence of the manual supplement form. */
export const LUOGU_SUPPLEMENT_AI_NOTE =
  '不使用 AI：填写的内容只写入本地题库，不会被发送给任何模型，也不会抓取题解或任何外部链接。';

// ---------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------

/** Accept an offered page size, falling back to the default for anything else. */
export function luoguMetadataPageSize(value: number): number {
  return LUOGU_METADATA_PAGE_SIZE_OPTIONS.includes(value) ? value : LUOGU_METADATA_BACKLOG_PAGE_SIZE;
}

/** Number of pages of `total` items; an empty backlog still has exactly one (empty) page. */
export function luoguMetadataPageCount(total: number, pageSize: number): number {
  const size = luoguMetadataPageSize(pageSize);
  const items = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  return Math.max(1, Math.ceil(items / size));
}

/** The 1-based page to read, clamped into `1..pageCount(total, pageSize)`. */
export function clampLuoguMetadataPage(page: number, total: number, pageSize: number): number {
  const requested = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  return Math.min(requested, luoguMetadataPageCount(total, pageSize));
}

/** One exact `luogu.metadataBacklog` request: one account, one page, a bounded page size. */
export interface LuoguMetadataBacklogRequest {
  readonly accountId: string;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Build the next backlog request.
 *
 * `total` is the item count of the last answer, or `null` before the first one: with a known total the
 * page is clamped **before** the request, so a page that no longer exists (all items resolved, or a
 * smaller backlog) can never be sent; without one the page is only normalized to a positive integer.
 */
export function luoguMetadataBacklogRequest(
  accountId: string,
  page: number,
  pageSize: number,
  total: number | null,
): LuoguMetadataBacklogRequest {
  const size = luoguMetadataPageSize(pageSize);
  const clamped =
    total === null
      ? Number.isSafeInteger(page) && page >= 1
        ? page
        : 1
      : clampLuoguMetadataPage(page, total, size);
  return { accountId, page: clamped, pageSize: size };
}

/** Page indicator: the clamped page, the page count and the pending item count. */
export function luoguMetadataPageLabel(page: number, total: number, pageSize: number): string {
  const size = luoguMetadataPageSize(pageSize);
  const items = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  return `第 ${clampLuoguMetadataPage(page, items, size)} / ${luoguMetadataPageCount(items, size)} 页 · 当前待补 ${items} 题`;
}

/** Summary label of the disclosure, e.g. `待补题目与手动处理（12）`. */
export function luoguMetadataDisclosureLabel(pending: number | null): string {
  return pending === null
    ? `${LUOGU_METADATA_DISCLOSURE_PREFIX}（读取中）`
    : `${LUOGU_METADATA_DISCLOSURE_PREFIX}（${pending}）`;
}

// ---------------------------------------------------------------------------------------
// Honest counts and pointers
// ---------------------------------------------------------------------------------------

/**
 * The three separate numbers of one backlog answer.
 *
 * `total` counts pending **problem keys**, `knownIssues` counts the keys of *this page* with a
 * recorded diagnostic, and `historicalFailedAttempts` is the account's lifetime failed **attempt**
 * counter. The sentence says all three in words, so the last one can never be read as "N failed
 * problems": one problem retried five times adds five attempts.
 */
export function luoguMetadataCounts(view: ApiLuoguMetadataBacklogView | null): string {
  if (view === null) {
    return '待补题目与历史失败尝试：尚未读取。';
  }
  return `当前待补 ${view.total} 题（题目键数量）· 本页有逐题原因 ${view.knownIssues} 条 · 历史累计失败尝试 ${view.historicalFailedAttempts} 次（是尝试次数，不是失败题目数）`;
}

/**
 * One sentence pointing at the disclosure, or `null` when there is nothing to point at.
 *
 * The compact card renders this next to the backlog action, so a failure or a nonempty backlog is
 * always accompanied by the exact place where it can be handled. The wording never says the backlog
 * was caused by an expired login: the metadata half is an anonymous read.
 */
export function luoguMetadataPointer(status: ApiLuoguStatusView | null): string | null {
  if (status === null || status.metadataBacklog === 0) {
    return null;
  }
  const label = luoguMetadataDisclosureLabel(status.metadataBacklog);
  if (status.failure !== null && status.failure.stage === 'metadata') {
    return `上一轮在${LUOGU_FAILURE_STAGE_LABELS.metadata}时失败，还有 ${status.metadataBacklog} 题待补：展开「${label}」可以逐题重试或手工补充（不使用 AI），逐题原因会显示在那里。`;
  }
  return `还有 ${status.metadataBacklog} 题缺少本地题目资料：展开「${label}」可以逐题重试或手工补充（不使用 AI）。`;
}

/**
 * One short line reflecting a host failure that appeared while the panel is open, or `null`.
 *
 * It is deliberately short: the panel states that the durable status changed and where the long
 * next-action sentence lives, instead of duplicating it. The per-item list keeps showing the
 * recorded per-key reasons, which may be newer than the session-level failure.
 */
export function luoguMetadataHostFailureLine(status: ApiLuoguStatusView | null): string | null {
  if (status === null || status.failure === null) {
    return null;
  }
  const where =
    status.failure.stage === undefined ? '' : `在${LUOGU_FAILURE_STAGE_LABELS[status.failure.stage]}时`;
  return `同步状态已更新：最近一次同步${where}失败（${luoguTime(status.failure.at)}）。逐题重试不会改动同步进度；完整处理办法见「同步详情」。`;
}

// ---------------------------------------------------------------------------------------
// Per-key diagnostics
// ---------------------------------------------------------------------------------------

/**
 * Fixed sentence per closed failure reason.
 *
 * `missing_statement` is the one reason the platform names itself, so it is stated as a fact. The
 * other three are parser-shaped refusals whose cause cannot be proven from the code: each sentence
 * says so ("具体原因不确定") and offers the three actions a user actually has — open the original
 * problem, retry later, or supplement locally. No sentence carries a body, a sample or an exception
 * text, because none of those exist in the durable record.
 */
export const LUOGU_METADATA_REASON_TEXT: Readonly<Record<PlatformErrorReason, string>> = {
  missing_statement: '缺少题面：洛谷返回的题目描述为空；可打开原题检查、稍后重试或手工补充。',
  html_response:
    '洛谷返回的是网页而不是题目数据（可能是人工验证或页面变化）：具体原因不确定；可打开原题检查、稍后重试或手工补充。',
  invalid_json: '洛谷返回的内容不是可解析的 JSON：可能是页面变化或临时故障，具体原因不确定；可打开原题检查、稍后重试或手工补充。',
  invalid_payload: '洛谷返回的 JSON 结构与预期不符：可能是页面变化或临时故障，具体原因不确定；可打开原题检查、稍后重试或手工补充。',
};

/** Sentence of a failure this build cannot classify; it never guesses a cause. */
export const LUOGU_METADATA_REASON_UNKNOWN_TEXT =
  '这次失败没有可用的原因分类：具体原因不确定；可打开原题检查、稍后重试或手工补充。';

/** Fixed sentence of one reason code, or the honest unknown sentence when there is none. */
export function luoguMetadataReasonText(reason: PlatformErrorReason | null): string {
  return reason === null ? LUOGU_METADATA_REASON_UNKNOWN_TEXT : LUOGU_METADATA_REASON_TEXT[reason];
}

/**
 * What is known about one queued key.
 *
 * A recorded issue names the last failure's instant, how many failures that key accumulated and the
 * translated reason. A key without a record renders the fixed unknown label plus the honest
 * explanation: old data (written before per-key diagnostics existed) may have been tried many times,
 * so the panel never claims it was never attempted.
 */
export function luoguMetadataIssueText(
  issue: LuoguMetadataIssue | null,
  unknownLabel: string = LUOGU_METADATA_ISSUE_UNKNOWN_LABEL,
): string {
  if (issue === null) {
    return `${unknownLabel}：可能是旧数据（写入这条待补记录时还没有逐题诊断），也可能是还没尝试过；可以点「重试此题」或手工补充。`;
  }
  return `最近一次失败：${luoguTime(issue.at)} · 这道题累计失败 ${issue.attempts} 次 · ${luoguMetadataReasonText(issue.reason)}`;
}

// ---------------------------------------------------------------------------------------
// Per-item mutations
// ---------------------------------------------------------------------------------------

/**
 * Why every per-item mutation is disabled right now, or `null` when it is allowed.
 *
 * The rule is status-driven and closed: a running pass, another instance's live lease, a closing
 * plugin, an unread status or a local action already in flight each disable retry and supplement with
 * one readable sentence, so a per-item write can never race a whole-pass run or a second click.
 */
export function luoguMetadataMutationReason(status: ApiLuoguStatusView | null, localPending: boolean): string | null {
  if (localPending) {
    return '上一项操作仍在进行：请等它结束后再重试或手工补充。';
  }
  if (status === null) {
    return '尚未读取到该账号的同步状态：请稍候再重试或手工补充。';
  }
  if (status.closing) {
    return '插件正在关闭：现在不能重试或补充，请重启 dsh 后再试。';
  }
  if (status.running) {
    return '本轮同步正在运行：请等它结束或点「暂停本轮」，再逐题重试或手工补充。';
  }
  if (status.leaseActive) {
    return '另一个 dsh 实例正在同步这个账号：请等它结束后再逐题重试或手工补充。';
  }
  return null;
}

/**
 * Honest sentence of one item-scoped retry outcome.
 *
 * The three outcomes are different facts: `resolved` means the key left the backlog and local
 * material was written; `deferred` means the platform refused **this item** for this reader (for
 * example an incomplete personal statement) while the key stays queued; `failed` is any other
 * refusal. None of them is reported as a whole-pass result, and none promises an automatic retry.
 */
export function luoguMetadataRetryText(
  result: Pick<ApiLuoguRetryMetadataResult, 'outcome' | 'reason'>,
): string {
  switch (result.outcome) {
    case 'resolved':
      return '已补齐这一题的本地资料，并已从待补列表移除；题库会刷新。';
    case 'deferred':
      return `平台这次没有提供这道题的公开资料，它仍留在待补列表：${luoguMetadataReasonText(result.reason)}`;
    case 'failed':
      return `这次重试失败，题目仍留在待补列表：${luoguMetadataReasonText(result.reason)}`;
  }
}

/** Fixed, body-free sentence of a refused retry request; never the server's raw message. */
export function luoguMetadataRetryErrorText(code: string | null): string {
  if (code === 'conflict') {
    return '题目状态已变化：请点「刷新待补列表」后再重试。';
  }
  if (code === 'invalid_input') {
    return '服务器拒绝了这次重试：请刷新待补列表后重试。';
  }
  if (code === 'cancelled') {
    return '请求已取消：请刷新待补列表确认最终状态。';
  }
  if (code === 'unauthorized') {
    return '登录已失效，请从 dsh 启动地址重新打开页面。';
  }
  return '重试没有完成：请稍后重试，或改用「手工补充」。';
}

// ---------------------------------------------------------------------------------------
// Manual supplement
// ---------------------------------------------------------------------------------------

/** The two editable values of one manual-supplement form. */
export interface LuoguSupplementDraft {
  readonly title: string;
  readonly statement: string;
}

/** Outcome of validating one draft; the failure always carries at least one fixed field error. */
export type LuoguSupplementCheck =
  | { readonly ok: true; readonly request: ApiLuoguSupplementMetadataRequest }
  | { readonly ok: false; readonly titleError: string | null; readonly statementError: string | null };

/** The fields of one backlog item the form needs; kept narrow so a test can state only those. */
export type LuoguSupplementTarget = Pick<
  ApiLuoguMetadataBacklogItem,
  'problemKey' | 'title' | 'expectedSnapshotId'
>;

/**
 * Validate one draft and build the exact `luogu.supplementMetadata` request.
 *
 * The rules are the server's own closed contract, checked locally as a courtesy:
 *
 * - the **title** is required only when the stored problem row has none; an existing title is sent
 *   back unchanged, so a draft can never overwrite a stored title with something else;
 * - the **statement** must be real, nonblank user content (this is not a place for a "could not
 *   fetch" remark);
 * - `expectedSnapshotId` is always the snapshot the caller saw — `null` when it saw none — so the
 *   server's compare-and-set can refuse a write prepared against stale material.
 *
 * Nothing here has a URL, tag, rating, editorial, model or credential field, and the request is the
 * one the browser transport sends verbatim.
 */
export function luoguSupplementValidation(input: {
  readonly accountId: string;
  readonly item: LuoguSupplementTarget;
  readonly draft: LuoguSupplementDraft;
}): LuoguSupplementCheck {
  const needsTitle = input.item.title === null;
  const title = needsTitle ? input.draft.title.trim() : input.item.title ?? '';
  const statement = input.draft.statement.trim();
  const titleError =
    needsTitle && title.length === 0 ? '请填写这道题的真实标题：本地还没有标题，空标题不会被保存。' : title.length > 500 ? '标题最多 500 个字符。' : null;
  const statementError =
    statement.length === 0 ? '请填写真实的题目描述：空内容不会被保存（这里不是填写备注的地方）。' : statement.length > 200_000 ? '题面最多 200000 个字符。' : null;
  if (titleError !== null || statementError !== null) {
    return { ok: false, titleError, statementError };
  }
  return {
    ok: true,
    request: {
      accountId: input.accountId,
      problemKey: input.item.problemKey,
      title,
      statement,
      expectedSnapshotId: input.item.expectedSnapshotId,
    },
  };
}

/** Fixed failure sentence of one supplement request plus whether the draft must survive it. */
export interface LuoguSupplementFailure {
  readonly message: string;
  /** Always `true` for a failure: a refused write never discards what the user typed. */
  readonly keepDraft: boolean;
}

/**
 * Fixed, body-free sentence of a refused `luogu.supplementMetadata` request.
 *
 * The snapshot conflict is the important one: the message tells the user to refresh the backlog and
 * re-submit after reviewing the latest state, never to overwrite the newer snapshot, and it keeps the
 * draft. Every other refusal keeps the draft too — nothing was written — and no message can carry a
 * server detail, a snapshot id or any part of the draft.
 */
export function luoguSupplementErrorText(code: string | null): LuoguSupplementFailure {
  if (code === 'conflict' || code === 'settings_changed') {
    return {
      message:
        '这道题的资料已经变化（快照不一致）：草稿仍然保留。请先保留草稿，再刷新待补列表、收起并重新打开补充表单；不会自动把旧草稿套用到新快照。',
      keepDraft: true,
    };
  }
  if (code === 'invalid_input') {
    return { message: '服务器拒绝了这次内容：请检查标题与题面后重新提交；草稿仍然保留。', keepDraft: true };
  }
  if (code === 'cancelled') {
    return { message: '请求已取消：请刷新待补列表确认最终状态；草稿仍然保留。', keepDraft: true };
  }
  if (code === 'unauthorized') {
    return { message: '登录已失效，请从 dsh 启动地址重新打开页面；草稿仍然保留。', keepDraft: true };
  }
  return { message: '提交没有完成：请稍后重试或刷新待补列表；草稿仍然保留。', keepDraft: true };
}

// ---------------------------------------------------------------------------------------
// Transient start notice
// ---------------------------------------------------------------------------------------

/**
 * What the panel remembers about its own `luogu.start` request.
 *
 * `outcome` is the committed answer of the reservation, `requestedAt` is the client instant of the
 * click (used only to order a *new* durable failure against this request), and the two baselines are
 * the durable instants the caller saw when it clicked — they are how a later read proves that the run
 * actually started, succeeded or was replaced instead of merely being an older status.
 */
export interface LuoguStartNotice {
  readonly accountId: string;
  readonly requestedAt: string;
  readonly outcome: ApiLuoguStartResult['outcome'];
  readonly baseLastSuccessAt: string | null;
  readonly baseScanStartedAt: string | null;
  /** True once the run (or a coalesced running pass) was actually observed as running. */
  readonly runningObserved: boolean;
}

/** One durable status read reduced to the facts that settle the notice. */
export interface LuoguStartObservation {
  readonly accountId: string;
  readonly running: boolean;
  readonly leaseActive: boolean;
  readonly lastSuccessAt: string | null;
  readonly scanStartedAt: string | null;
  readonly failureAt: string | null;
  readonly closing: boolean;
}

/** Why the notice was kept or dropped; `observed-running` and `keep` keep it. */
export type LuoguStartNoticeDecision =
  | 'none'
  | 'keep'
  | 'observed-running'
  | 'succeeded'
  | 'failed'
  | 'ended'
  | 'account-changed'
  | 'closing';

/** One decision: the notice to keep (or `null`) and the reason for the transition. */
export interface LuoguStartNoticeStep {
  readonly notice: LuoguStartNotice | null;
  readonly decision: LuoguStartNoticeDecision;
}

/** Open a notice for one committed `luogu.start` answer. */
export function luoguStartNotice(input: {
  readonly accountId: string;
  readonly outcome: ApiLuoguStartResult['outcome'];
  readonly requestedAt: string;
  readonly lastSuccessAt: string | null;
  readonly scanStartedAt: string | null;
}): LuoguStartNotice {
  return {
    accountId: input.accountId,
    requestedAt: input.requestedAt,
    outcome: input.outcome,
    baseLastSuccessAt: input.lastSuccessAt,
    baseScanStartedAt: input.scanStartedAt,
    // `coalesced` means the host answered "this joined a running pass": the run is running now.
    runningObserved: input.outcome === 'coalesced',
  };
}

/** Milliseconds of an ISO instant, or `null` when it is absent or unparsable. */
function instantOf(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fold one durable status read into the transient start notice.
 *
 * The rules exist so a short-lived "已开始新一轮同步…" line can never contradict the durable state:
 *
 * - **Only durable evidence settles it.** A new `lastSuccessAt` proves the run completed (`succeeded`);
 *   a failure observed after the click proves it settled failed (`failed`); a run that was seen
 *   running (or whose durable `scanStartedAt` changed) and is now idle ended without success
 *   (`ended`). Each drops the notice, so the panel then shows the failure itself instead of the
 *   optimistic line.
 * - **An initial idle read proves nothing.** Immediately after the click the durable reservation may
 *   not be visible yet, so a read that still shows the *older* idle status (and, at most, a failure
 *   that was already on screen before the click) keeps the notice. It is never reported as a
 *   completed or failed run just because nothing new was visible yet.
 * - **Scope changes drop it.** Another account, or a closing plugin, clears the notice instead of
 *   carrying it across accounts or past shutdown.
 *
 * The helper is pure: `requestedAt` comes from the caller, and no comparison is made against an
 * unparsable instant.
 */
export function luoguStartNoticeStep(
  notice: LuoguStartNotice | null,
  next: LuoguStartObservation,
): LuoguStartNoticeStep {
  if (notice === null) {
    return { notice: null, decision: 'none' };
  }
  if (next.accountId !== notice.accountId) {
    return { notice: null, decision: 'account-changed' };
  }
  if (next.closing) {
    return { notice: null, decision: 'closing' };
  }
  const succeeded = next.lastSuccessAt !== null && next.lastSuccessAt !== notice.baseLastSuccessAt;
  if (succeeded) {
    return { notice: null, decision: 'succeeded' };
  }
  const failedAt = instantOf(next.failureAt);
  const requestedAt = instantOf(notice.requestedAt);
  if (failedAt !== null && requestedAt !== null && failedAt > requestedAt) {
    return { notice: null, decision: 'failed' };
  }
  if (next.running || next.leaseActive) {
    return { notice: { ...notice, runningObserved: true }, decision: 'observed-running' };
  }
  // The durable `scanStartedAt` is the announced run's identity: a value that differs from the one
  // seen at click time proves the pass really started, so an idle read afterwards means it *ended*
  // (a cancellation, or a failure the durable record does not name) rather than never having run.
  const startedByScan = next.scanStartedAt !== null && next.scanStartedAt !== notice.baseScanStartedAt;
  if (notice.runningObserved || startedByScan) {
    return { notice: null, decision: 'ended' };
  }
  return { notice, decision: 'keep' };
}

/** A refresh must not silently rebase a draft onto metadata the user did not open. */
export function luoguSupplementTargetChanged(opened: LuoguSupplementTarget, current: LuoguSupplementTarget): boolean {
  return opened.problemKey !== current.problemKey || opened.expectedSnapshotId !== current.expectedSnapshotId || opened.title !== current.title;
}
