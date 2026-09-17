/**
 * Reading rules of the bulk platform-material refresh UI (Sprint Contract 34B).
 *
 * Pure helpers over the typed `material.*` answers: no React, no DOM, no store, no clock and no
 * network. They exist so the decisions this panel renders or sends — status labels, failure
 * wording, counters, action gates, polling, the `refresh_materials` aggregation and the bank
 * preparation inputs — can be pinned by tests without rendering a page.
 *
 * Three boundaries are deliberately explicit here:
 *
 * - **Preparing is local and free.** `material.prepare` writes a durable batch record and performs
 *   no request; only `material.start` performs platform reads, and neither of them can name a
 *   model, an attempt or a budget. The panel states this before offering either action, and every
 *   label that can spend model budget (`batch.*` / `plan.ai*`) is absent from this module.
 * - **A failure is never an absence.** Every stable failure code has its own Chinese explanation
 *   that never renders as "no editorial", and a confirmed absence is a *successful* completed item
 *   that is labelled as such.
 * - **Refreshing material cannot repair an old analysis batch.** A stored tag-analysis batch keeps
 *   the immutable snapshot it captured, so the only remedy is a new free preparation followed by an
 *   explicit paid start. Nothing here can prepare, start or resume a tag analysis, and the reusable
 *   panel is bound to one scope identity (analysis batch + canonical ordered keys) so a changed
 *   scope resets it instead of lending its durable material batch to new text.
 * - **A stored batch is described by its own durable record.** The panel's preparation props (problem
 *   keys, current account, scope sentence) describe only a *possible new preparation*;
 *   {@link materialScopeCopy} replaces all three with the shown batch's own id/timestamp/status while
 *   a historical batch is selected, so a reopened batch can never be labelled with the current
 *   selection's scope or the current account — and the omitted historical account is never guessed.
 */
import type {
  MaterialRefreshBatchCounts,
  MaterialRefreshBatchStatus,
  MaterialRefreshFailureCode,
  MaterialRefreshItemStatus,
} from '../application/material-refresh-batch-types.js';
import type {
  ApiMaterialBatchItemRequest,
  ApiMaterialBatchItemView,
  ApiMaterialBatchPrepareRequest,
  ApiMaterialBatchSummaryView,
  ApiMaterialBatchView,
} from '../application/workbench-api.js';
import type { EditorialAvailability } from '../domain/index.js';

// ---------------------------------------------------------------------------------------
// Bounds and vocabulary
// ---------------------------------------------------------------------------------------

/**
 * Largest scope one prepared batch accepts.
 *
 * It mirrors the application's own bound (`material.prepare` takes 1..100 unique stored problems);
 * the UI keeps its own copy so it can refuse an impossible scope before sending anything, and the
 * focused tests compare the two constants so they cannot drift.
 */
export const MAX_BULK_MATERIAL_ITEMS = 100;

/** Page size of the recent durable-batch list; `material.list` accepts 1..50. */
export const MATERIAL_BATCH_LIST_LIMIT = 20;

/**
 * The one blocked-row action this feature aggregates.
 *
 * A `supplement_editorial`/`supplement_statement` row is a hand-supplied local write, never a
 * platform refresh, so it must not enter the refresh scope.
 */
export const REFRESH_MATERIALS_ACTION = 'refresh_materials';

/** Label of a batch state; the record is total, so a state without wording cannot compile. */
export const MATERIAL_BATCH_STATUS_TEXT = {
  prepared: '已准备（尚未发起平台请求）',
  running: '平台刷新中',
  paused: '已暂停（需重试或继续）',
  completed: '已完成',
  cancelled: '已取消',
} as const satisfies Readonly<Record<MaterialRefreshBatchStatus, string>>;

/** Label of one item state. */
export const MATERIAL_ITEM_STATUS_TEXT = {
  pending: '待刷新',
  running: '刷新中',
  completed: '已完成',
  attention: '需处理（可重试）',
  cancelled: '已取消',
} as const satisfies Readonly<Record<MaterialRefreshItemStatus, string>>;

/** Fallback used for a code this build does not know; a real sentence, never an empty string. */
export const MATERIAL_UNKNOWN_FAILURE_TEXT = '未记录的失败原因：可以重试；若持续出现请展开诊断信息查看原始错误码。';

/**
 * Chinese primary explanation of every stable failure code.
 *
 * Each sentence says what happened and what the user can do. None of them claims the platform has
 * no editorial: an operational failure only means *this read* did not complete, which is why the
 * panel shows {@link MATERIAL_FAILURE_DISCLAIMER} next to them and keeps the raw code inside a
 * collapsible diagnostic area.
 */
export const MATERIAL_FAILURE_TEXT = {
  auth_required: '该次材料读取需要可用的账号登录：请先在「账号与同步」确认账号保持可用后重试。',
  forbidden: '平台拒绝了对该材料的访问（例如权限不足或防盗链）；可以更换账号或稍后重试。',
  rate_limited: '平台限流：请等待一段时间后重试；已完成的项目不会被重复刷新。',
  unavailable: '平台暂时不可用：稍后重试即可；已完成的项目保持完成。',
  changed_response: '平台响应结构发生变化或触发了人机验证：本次未确认材料内容，请稍后重试。',
  invalid_reference: '本地引用无效：请检查题目来源或官方题解链接的格式后重试。',
  missing_reference: '本地缺少可用的题目或账号引用：请先同步或补充题目材料，再重试。',
  stale_head: '本地材料快照已被更新：请打开题目刷新材料后重试；已完成的项目不会被改写。',
  interrupted: '本次刷新被中断（例如进程重启或插件关闭）：请重新开始批次以处置中断的项目。',
  unexpected: '未识别的错误：可以重试；若持续出现请展开诊断信息查看原始错误码。',
} as const satisfies Readonly<Record<MaterialRefreshFailureCode, string>>;

/** Every stable failure code, derived from the label record so the two cannot disagree. */
export const MATERIAL_FAILURE_CODES = Object.keys(MATERIAL_FAILURE_TEXT) as readonly MaterialRefreshFailureCode[];

/** The boundary sentence shown next to failure rows: a failure is not an absence. */
export const MATERIAL_FAILURE_DISCLAIMER =
  '“需处理”只说明本次读取没有完成，不代表平台没有题解：只有“已完成”且题解状态为“已确认无题解”才是确认结果；失败项可以重试，已完成项不会被重复刷新。';

/** Editorial availability a completed item may report. */
export const MATERIAL_EDITORIAL_TEXT = {
  found: '已找到题解',
  absent: '已确认无题解（成功观测）',
  auth_required: '题解读取需要登录',
  forbidden: '题解读取被平台拒绝',
  rate_limited: '题解读取被限流',
  unavailable: '题解读取时平台不可用',
  changed_response: '题解响应结构变化或验证拦截',
} as const satisfies Readonly<Record<EditorialAvailability, string>>;

/** Whether one item's requested statement half was fetched; the map is total over the API values. */
export const MATERIAL_STATEMENT_TEXT = {
  not_requested: '未请求题面',
  fetched: '题面已获取',
  failed: '题面获取失败',
} as const;

/** Chinese label of one batch state, with a safe fallback for a newer host. */
export function batchStatusText(status: string): string {
  return (
    (MATERIAL_BATCH_STATUS_TEXT as Readonly<Record<string, string | undefined>>)[status] ?? '未知批次状态'
  );
}

/** Chinese label of one item state, with a safe fallback for a newer host. */
export function itemStatusText(item: ApiMaterialBatchItemView): string {
  return (
    (MATERIAL_ITEM_STATUS_TEXT as Readonly<Record<string, string | undefined>>)[item.status] ??
    '未知项目状态'
  );
}

/** Chinese primary explanation of one failure code; an unknown code still renders a real sentence. */
export function failureExplanation(code: string): string {
  return (MATERIAL_FAILURE_TEXT as Readonly<Record<string, string | undefined>>)[code] ?? MATERIAL_UNKNOWN_FAILURE_TEXT;
}

/** Chinese label of one editorial availability, with a safe fallback for a newer host. */
export function editorialAvailabilityText(availability: string): string {
  return (
    (MATERIAL_EDITORIAL_TEXT as Readonly<Record<string, string | undefined>>)[availability] ?? '未知题解状态'
  );
}

// ---------------------------------------------------------------------------------------
// Boundaries the panel must state before the user acts
// ---------------------------------------------------------------------------------------

/** What the free prepare action does, and what it explicitly does not do. */
export const MATERIAL_LOCAL_PREPARE_TEXT =
  '“免费准备刷新批次”只在本地建立或更新批次记录：不联网、不调用 AI，也不消耗 DeepSeek 额度。';

/** What the explicit start does: platform reads only, still no model and no quota. */
export const MATERIAL_PLATFORM_START_TEXT =
  '只有点击“开始/继续平台刷新”才会向平台发起题面与题解的读取请求；它同样不调用 AI，不消耗 DeepSeek 额度。';

/** The one sentence that rules out every model-side effect of this feature. */
export const MATERIAL_NO_MODEL_TEXT =
  '本功能不会创建模型调用、模型尝试或分析任务，也不会计入 DeepSeek 额度与费用。';

/** What a prepared-but-not-started batch means. */
export const MATERIAL_PREPARED_NOTE = '批次已准备但尚未发起平台请求：只有明确点击“开始平台刷新”才会联网读取材料。';

/** How polling behaves, so nobody reads the refresh as a live push. */
export const MATERIAL_REFETCH_NOTE = '批次运行中：页面只在运行状态自动读取进度，且不会与上一次读取重叠。';

/** A recovered or stored paused batch never resumes itself. */
export const MATERIAL_PAUSED_NOTE = '已暂停批次不会自动继续：请先“仅重试失败/已取消项”，或直接点击“继续平台刷新”。';

/** A completed batch is terminal; new work needs a new durable batch. */
export const MATERIAL_COMPLETED_NOTE = '批次已完成：已完成项目不会被重复刷新；如需新的快照，请重新免费准备一个批次。';

/** Cancelling keeps completed siblings. */
export const MATERIAL_CANCELLED_NOTE = '批次已取消：已完成项目保留；剩余项目需要重试后再明确开始。';

/** Cancel semantics, stated where the button is. */
export const MATERIAL_CANCEL_NOTE = '取消批次只处理尚未完成的题目；已完成的项目保留，不会被撤销、回退或重跑。';

/** Retry semantics: only non-completed work, and never an automatic start. */
export const MATERIAL_RETRY_NOTE =
  '仅重试失败/已取消项；已完成项目保留且不会重复刷新。重试不会自动开始：之后要再明确点击“开始/继续平台刷新”。';

/** Closing the surface hides it without touching durable work. */
export const MATERIAL_CLOSE_NOTE =
  '关闭面板只隐藏界面，不会取消已开始的后台平台刷新；重新打开面板或从批次列表选择该批次即可恢复查看。';

/** Opening a stored batch is a read; it never starts work. */
export const MATERIAL_RECOVER_NOTE =
  '历史批次是持久化记录：重新载入页面后仍可打开查看，但打开本身不会开始任何平台请求。';

/** Preparing twice creates a second durable batch instead of rewriting the first. */
export const MATERIAL_PREPARE_AGAIN_NOTE = '再次“免费准备”会建立一个新的批次记录，不会覆盖或修改已存在的批次。';

/**
 * The immutable old-analysis-batch boundary, shown in the tag-review integration.
 *
 * It states the three facts a user must not have to infer: material refresh writes a new snapshot,
 * the stored analysis batch still points at the old one, and the only remedy is a new *free*
 * preparation followed by an explicit paid start. It never offers an automatic paid action.
 */
export const OLD_ANALYSIS_BATCH_TEXT =
  '平台材料刷新只更新题目材料快照；旧标签分析批次仍指向它当时捕获的不可变旧快照，已完成的分析结果不会被改写。需要回到「免费准备批次」重新准备一个批次，再明确点击开始付费分析；插件不会自动准备，也不会自动开始或恢复任何付费分析。';

/**
 * Honest account scope of a bank preparation: the current account, or an anonymous read.
 *
 * The sentence states exactly what this record does with credentials: a material batch stores
 * problem keys and metadata only, so it never copies, displays or separately stores a Cookie value.
 * It deliberately does not claim that no Cookie exists anywhere — a platform read may use the
 * session the account connection flow already stored in Windows Credential Manager — and it never
 * echoes a credential value.
 */
export function materialAccountText(accountId: string | null): string {
  return accountId === null
    ? '当前未选择账号：按匿名读取准备（匿名读取可能无法确认题解状态）。'
    : '按当前选择的账号读取。本材料批次记录不会复制、显示或单独保存 Cookie 值；平台读取可能使用账号连接流程已保存在 Windows 凭据管理器中的会话。';
}

/** Sentence describing one batch state, so the panel never leaves the state unexplained. */
export function materialBatchStateNote(view: ApiMaterialBatchView | null): string {
  if (view === null) {
    return MATERIAL_RECOVER_NOTE;
  }
  switch (view.status) {
    case 'prepared':
      return MATERIAL_PREPARED_NOTE;
    case 'running':
      return MATERIAL_REFETCH_NOTE;
    case 'paused':
      return MATERIAL_PAUSED_NOTE;
    case 'completed':
      return MATERIAL_COMPLETED_NOTE;
    case 'cancelled':
      return MATERIAL_CANCELLED_NOTE;
    default:
      return MATERIAL_RECOVER_NOTE;
  }
}

// ---------------------------------------------------------------------------------------
// Counts, progress and gates
// ---------------------------------------------------------------------------------------

/** How many items are still non-terminal: pending work, a live attempt, or an unretried failure. */
export function unfinishedItemCount(counts: MaterialRefreshBatchCounts): number {
  return counts.pending + counts.running + counts.attention;
}

/** How many items `material.retryFailed` can actually reset (only attention/cancelled work). */
export function retryableItemCount(counts: MaterialRefreshBatchCounts): number {
  return counts.attention + counts.cancelled;
}

/** Deterministic counter line: every number the API reports, in a fixed order. */
export function materialCountsText(view: Pick<ApiMaterialBatchView, 'itemCount' | 'counts'>): string {
  const counts = view.counts;
  return (
    `共 ${view.itemCount} 题 · 待刷新 ${counts.pending} · 刷新中 ${counts.running} · 已完成 ${counts.completed}` +
    ` · 需处理 ${counts.attention} · 已取消 ${counts.cancelled} · 快照变更 ${counts.changedSnapshots}`
  );
}

/** Status plus counters, or the honest "nothing selected yet" sentence. */
export function materialProgressText(view: ApiMaterialBatchView | null): string {
  return view === null ? '尚未准备或选择批次。' : `${batchStatusText(view.status)} · ${materialCountsText(view)}`;
}

/** One action gate: whether the action may run and, when it may not, why. */
export interface MaterialGate {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/** Start gate plus the label the button must carry for this batch. */
export interface MaterialStartGate extends MaterialGate {
  readonly label: string;
}

/** The two honest start labels: a first run versus an explicit continuation. */
export const MATERIAL_START_LABEL = '开始平台刷新';
export const MATERIAL_RESUME_LABEL = '继续平台刷新';

/**
 * Whether the current selection may be prepared at all.
 *
 * Zero keys and more than {@link MAX_BULK_MATERIAL_ITEMS} keys are both refused; an over-limit scope
 * is never truncated, because silently dropping problems from a bulk operation is a data bug, not a
 * convenience.
 */
export function materialPrepareGate(problemKeys: readonly string[]): MaterialGate {
  if (problemKeys.length === 0) {
    return { allowed: false, reason: '请先在题库勾选至少 1 道题，再免费准备刷新批次。' };
  }
  if (problemKeys.length > MAX_BULK_MATERIAL_ITEMS) {
    return {
      allowed: false,
      reason: `单批最多 ${MAX_BULK_MATERIAL_ITEMS} 题，当前 ${problemKeys.length} 题；请减少选择后重试（不会静默截断）。`,
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Whether the batch may be started or continued.
 *
 * Only a `prepared` or `paused` batch with at least one pending item can start: a running batch is
 * already working, a terminal batch is over, and a paused batch whose remaining items are all
 * attention/cancelled needs an explicit retry first, so "start" can never look like it would
 * silently re-run failed platform work.
 */
export function materialStartGate(view: ApiMaterialBatchView | null): MaterialStartGate {
  if (view === null) {
    return { allowed: false, reason: '尚未准备或选择批次。', label: MATERIAL_START_LABEL };
  }
  const label = view.startedAt === null ? MATERIAL_START_LABEL : MATERIAL_RESUME_LABEL;
  if (view.status === 'running') {
    return { allowed: false, reason: '批次正在刷新中，请等待完成或先取消。', label };
  }
  if (view.status === 'completed') {
    return { allowed: false, reason: '批次已完成，没有待刷新的题目。', label };
  }
  if (view.status === 'cancelled') {
    return {
      allowed: false,
      reason: '批次已取消：请先“仅重试失败/已取消项”，或重新免费准备一个批次。',
      label,
    };
  }
  if (view.counts.pending === 0) {
    return {
      allowed: false,
      reason: '没有待刷新的题目；如需处理失败/已取消项，请先点击“仅重试失败/已取消项”。',
      label,
    };
  }
  return { allowed: true, reason: null, label };
}

/**
 * Whether the batch may be cancelled: only while some item is still unfinished.
 *
 * Cancelling never undoes a completed sibling, so the gate closes as soon as nothing else remains.
 */
export function materialCancelGate(view: ApiMaterialBatchView | null): MaterialGate {
  if (view === null) {
    return { allowed: false, reason: '尚未准备或选择批次。' };
  }
  if (view.status === 'completed') {
    return { allowed: false, reason: '批次已完成，没有未完成的工作需要取消。' };
  }
  if (view.status === 'cancelled') {
    return { allowed: false, reason: '批次已取消。' };
  }
  if (unfinishedItemCount(view.counts) === 0) {
    return { allowed: false, reason: '没有未完成的题目需要取消。' };
  }
  return { allowed: true, reason: null };
}

/** Whether retry is offered: never while running, never on a completed batch, never with nothing to reset. */
export function materialRetryGate(view: ApiMaterialBatchView | null): MaterialGate {
  if (view === null) {
    return { allowed: false, reason: '尚未准备或选择批次。' };
  }
  if (view.status === 'running') {
    return { allowed: false, reason: '批次正在刷新中，请等待完成或先取消，再重试失败项。' };
  }
  if (view.status === 'completed') {
    return { allowed: false, reason: '批次已完成，没有可重试的项目；已完成项目不会被重复刷新。' };
  }
  if (retryableItemCount(view.counts) === 0) {
    return { allowed: false, reason: '没有失败或已取消的项目需要重试。' };
  }
  return { allowed: true, reason: null };
}

/** True only while the detail read should poll: the batch is running and nothing else. */
export function materialPollingActive(view: ApiMaterialBatchView | null): boolean {
  return view !== null && view.status === 'running';
}

// ---------------------------------------------------------------------------------------
// Tag-review aggregation and bank preparation inputs
// ---------------------------------------------------------------------------------------

/** The blocked rows of one prepared/stored batch that a platform refresh may address. */
export interface RefreshMaterialScope {
  /** Unique canonical keys in first-seen order; canonical keys, never display labels. */
  readonly keys: readonly string[];
  /** Number of unique `refresh_materials` rows; the value the overflow verdict uses. */
  readonly total: number;
  /** True when more than one batch worth of problems is blocked; the action is then refused. */
  readonly overflow: boolean;
  /** True when exactly one legal batch (1..100) can be prepared from this scope. */
  readonly ready: boolean;
}

/**
 * Aggregate the `refresh_materials` rows of the current prepared/stored batch.
 *
 * Only rows whose action is exactly {@link REFRESH_MATERIALS_ACTION} are included: a hand-supplied
 * editorial or statement is not a platform refresh. Duplicates collapse in first-seen order so the
 * prepared batch keeps the caller's ordering. More than {@link MAX_BULK_MATERIAL_ITEMS} unique keys
 * are reported as `overflow` and refused rather than truncated.
 */
export function refreshMaterialProblemKeys(
  rows: readonly { readonly problemKey: string; readonly action: string }[],
): RefreshMaterialScope {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.action !== REFRESH_MATERIALS_ACTION || seen.has(row.problemKey)) {
      continue;
    }
    seen.add(row.problemKey);
    keys.push(row.problemKey);
  }
  const total = keys.length;
  const overflow = total > MAX_BULK_MATERIAL_ITEMS;
  return { keys, total, overflow, ready: total > 0 && !overflow };
}

/**
 * Stable identity of one analysis scope the reusable material panel may serve.
 *
 * The panel owns a durable material batch of its own, so it must be bound to the exact scope whose
 * text it shows: the tag-analysis batch it was opened from plus the canonical refresh keys in their
 * preserved order. The value is a pure function of those two inputs (no clock, no randomness, no
 * hidden state), and every part is length-prefixed so distinct inputs can never collide. React can
 * therefore use it as a `key` to remount — and thus reset — the panel whenever the scope changes,
 * and a host page can compare it with the identity it opened.
 */
export function materialScopeIdentity(analysisBatchId: string | null, problemKeys: readonly string[]): string {
  const batch = analysisBatchId === null ? 'none' : `id:${analysisBatchId.length}:${analysisBatchId}`;
  const keys = problemKeys.map((key) => `${key.length}:${key}`).join(',');
  return `${batch}|${keys}`;
}

/** Scope sentence of the review aggregation, including the honest refusal when it overflows. */
export function refreshMaterialScopeText(scope: RefreshMaterialScope): string {
  if (scope.total === 0) {
    return '当前批次没有需要刷新平台材料的题目。';
  }
  if (scope.overflow) {
    return `需要刷新平台材料 ${scope.total} 题，超过单批上限 ${MAX_BULK_MATERIAL_ITEMS} 题；请分批处理（例如先在题库按页选择刷新），不会静默截断。`;
  }
  return `当前批次需要刷新平台材料 ${scope.total} 题（仅 refresh_materials，不含补题解与补题面）。`;
}

/**
 * The exact items a bank preparation sends.
 *
 * Order is the selection order, every item carries the current account (or `null` for an anonymous
 * read) and `fetchStatement: true`. There is deliberately no tutorial-URL or body field: the bulk
 * bank flow never asks for a cookie, a statement, an editorial or a tutorial link.
 */
export function materialPrepareItems(
  problemKeys: readonly string[],
  accountId: string | null,
): readonly ApiMaterialBatchItemRequest[] {
  return problemKeys.map((problemKey) => ({ problemKey, accountId, fetchStatement: true }));
}

/** The typed request of `material.prepare` for one scope. */
export function materialPrepareRequest(
  problemKeys: readonly string[],
  accountId: string | null,
): ApiMaterialBatchPrepareRequest {
  return { items: materialPrepareItems(problemKeys, accountId) };
}

// ---------------------------------------------------------------------------------------
// Item rendering
// ---------------------------------------------------------------------------------------

/** Short display label of a canonical problem key: its external-key suffix. */
export function displayKey(problemKey: string): string {
  return problemKey.split('||').at(-1) ?? problemKey;
}

/** Statement half of one item, or the honest "not requested" reading. */
export function itemStatementText(item: ApiMaterialBatchItemView): string {
  const statement = item.result?.statement ?? null;
  return statement === null
    ? '未记录题面状态'
    : (MATERIAL_STATEMENT_TEXT as Readonly<Record<string, string | undefined>>)[statement] ?? '未记录题面状态';
}

/**
 * Editorial half of one item.
 *
 * An `attention` item shows its failure explanation — never a claim about the editorial — while a
 * completed item shows the availability it really observed, including a confirmed `absent`.
 */
export function itemEditorialText(item: ApiMaterialBatchItemView): string {
  if (item.status === 'attention') {
    return failureExplanation(item.failure?.code ?? 'unexpected');
  }
  const availability = item.result?.editorial ?? null;
  if (availability !== null) {
    return editorialAvailabilityText(availability);
  }
  return item.status === 'completed' ? '本次未读取题解' : '尚未读取题解';
}

/** Snapshot half of one item: whether the committed snapshot actually changed. */
export function itemSnapshotText(item: ApiMaterialBatchItemView): string {
  const snapshot = item.result?.snapshot ?? null;
  if (snapshot === null) {
    return '未提交快照';
  }
  return snapshot.changed ? `快照已更新（v${snapshot.version}）` : `快照未变化（复用 v${snapshot.version}）`;
}

/** Attempt counter of one item; zero is stated as "not tried" instead of a bare 0. */
export function itemAttemptsText(item: ApiMaterialBatchItemView): string {
  return item.attempts === 0 ? '尚未尝试' : `已尝试 ${item.attempts} 次`;
}

/** The raw code of one item's failure, for the collapsible diagnostic area only. */
export function itemFailureCode(item: ApiMaterialBatchItemView): string | null {
  return item.failure?.code ?? null;
}

// ---------------------------------------------------------------------------------------
// Batches list and local time labels
// ---------------------------------------------------------------------------------------

/** Local label of one stored instant; `null` stays an explicit dash, never a fabricated time. */
export function materialMoment(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

/** One option line of the durable batch list: time, size, status and the two decisive counts. */
export function materialSummaryText(summary: ApiMaterialBatchSummaryView): string {
  return (
    `${materialMoment(summary.createdAt)} · ${summary.itemCount} 题 · ${batchStatusText(summary.status)}` +
    ` · 已完成 ${summary.counts.completed} · 需处理 ${summary.counts.attention}`
  );
}

/**
 * The freshest of the two answers a mutation can produce.
 *
 * A mutation response is authoritative but the scheduled detail read may already be newer; the view
 * with the higher revision wins, and a different batch id never leaks across a selection change.
 */
export function newestBatchView(
  loaded: ApiMaterialBatchView | null,
  local: ApiMaterialBatchView | null,
): ApiMaterialBatchView | null {
  if (loaded === null) {
    return local;
  }
  if (local === null || local.batchId !== loaded.batchId) {
    return loaded;
  }
  return local.revision > loaded.revision ? local : loaded;
}

// ---------------------------------------------------------------------------------------
// History entry and the provenance of the batch a panel shows
// ---------------------------------------------------------------------------------------

/**
 * Label of the always-available history/recovery opener on the problem bank.
 *
 * It is deliberately not the prepare action: it carries no selection at all and must stay usable when
 * the cross-page selection is empty (for example right after a reload), so a stored batch can be
 * opened, inspected and — only through its own explicit, state-valid actions — started, cancelled or
 * retried.
 */
export const MATERIAL_HISTORY_ENTRY_LABEL = '刷新历史与恢复';

/** Panel title of the history/recovery surface; distinct from the prepare surface. */
export const MATERIAL_HISTORY_TITLE = '平台材料刷新历史与恢复';

/**
 * Scope sentence of the history surface.
 *
 * There is no new preparation scope here: the panel opens on an empty scope, so `material.prepare` is
 * refused and only the durable list plus explicit batch actions remain. The sentence states in
 * advance that opening, loading and selecting are reads.
 */
export const MATERIAL_HISTORY_SCOPE_NOTE =
  '历史入口没有新的准备范围：这里只读取已保存的刷新批次；打开面板、载入列表或选择批次本身都不会发起平台请求，也不会自动开始、重试或继续任何批次。';

/**
 * Which batch a surface currently shows, and how it came to show it.
 *
 * - `none` — nothing is selected, so only the captured preparation scope is described.
 * - `prepared_now` — the batch this panel itself just created from that captured scope.
 * - `stored` — a batch chosen from durable history; only its own stored facts may describe it.
 */
export type MaterialBatchOrigin = 'none' | 'prepared_now' | 'stored';

/**
 * Classify the shown batch against the batch this panel session prepared.
 *
 * A stored batch is anything that is not this panel's own preparation — including every batch
 * selected through the history entry, which never prepares at all. The classification is a pure
 * equality over ids, so it cannot depend on order, timing or a previously rendered view.
 */
export function materialBatchOrigin(
  view: Pick<ApiMaterialBatchView, 'batchId'> | null,
  preparedBatchId: string | null,
): MaterialBatchOrigin {
  if (view === null) {
    return 'none';
  }
  return preparedBatchId !== null && view.batchId === preparedBatchId ? 'prepared_now' : 'stored';
}

/**
 * Explanation of a stored batch selected from durable history.
 *
 * It carries the batch's own durable identity — id, creation instant, status and size — and states
 * the two facts a user must not have to infer: the current bank selection and the current account do
 * not describe or alter this stored record. It never guesses the account the batch was prepared with,
 * because the public projection deliberately omits `accountId`.
 */
export function materialStoredBatchText(view: ApiMaterialBatchView): string {
  return (
    `当前显示的是已保存的历史批次 ${view.batchId}（创建于 ${materialMoment(view.createdAt)}，` +
    `状态 ${batchStatusText(view.status)}，共 ${view.itemCount} 题）。` +
    `它保留的是建立时记录的题目范围与读取身份：当前题库选择、当前账号都不会改变它，` +
    `也不会自动为它发起、重试或继续任何平台请求。` +
    `接口不提供该历史批次的账号信息，本页不会显示或推测当时的账号。`
  );
}

/**
 * Explanation of the batch this panel just prepared from its captured scope.
 *
 * The wording stays truthful in both directions: the batch really came from this preparation, so it
 * is not an arbitrary historical pick, while the captured scope sentence next to it describes exactly
 * that preparation.
 */
export function materialPreparedNowText(view: ApiMaterialBatchView): string {
  return (
    `当前显示的是由本次准备范围新建的批次 ${view.batchId}（状态 ${batchStatusText(view.status)}）；` +
    `它由本次免费准备建立，不是从历史记录中任意挑选的批次。`
  );
}

/** Everything needed to word the scope block of one open panel. */
export interface MaterialScopeCopyInput {
  /** The batch currently rendered by the panel, or `null` when none is selected. */
  readonly view: ApiMaterialBatchView | null;
  /** The batch this panel session prepared; `null` when it prepared nothing. */
  readonly preparedBatchId: string | null;
  /** Captured preparation scope; describes only a possible *new* preparation. */
  readonly problemKeys: readonly string[];
  /** Current account; describes only a possible *new* preparation. */
  readonly accountId: string | null;
  /** Host-supplied scope sentence; used only while it describes what is shown. */
  readonly scopeNote?: string;
}

/** The scope block of one panel render: preparation scope, shown batch and account, each honest. */
export interface MaterialScopeCopy {
  readonly origin: MaterialBatchOrigin;
  /** The captured preparation scope sentence, or `null` when it does not describe what is shown. */
  readonly scopeText: string | null;
  /** The sentence identifying the batch itself, or `null` when nothing is selected. */
  readonly batchText: string | null;
  /** The current-account sentence, or `null` when only a stored batch is shown. */
  readonly accountText: string | null;
}

/**
 * Word the scope block for the batch the panel currently shows.
 *
 * This is the one place that decides whether the captured preparation scope and the current account
 * may be rendered: both describe a *possible new preparation*, never a stored batch, so a stored
 * selection replaces them with the batch's own durable identity. The panel therefore cannot show
 * "本次准备范围 … 题" or "按当前选择的账号读取" over a historical batch the user merely reopened, and
 * the omitted historical account is never guessed.
 */
export function materialScopeCopy(input: MaterialScopeCopyInput): MaterialScopeCopy {
  const origin = materialBatchOrigin(input.view, input.preparedBatchId);
  if (origin === 'stored' && input.view !== null) {
    return { origin, scopeText: null, batchText: materialStoredBatchText(input.view), accountText: null };
  }
  const scopeText = input.scopeNote ?? `本次准备范围共 ${input.problemKeys.length} 题（保持打开面板时的顺序）。`;
  return {
    origin,
    scopeText,
    batchText: origin === 'prepared_now' && input.view !== null ? materialPreparedNowText(input.view) : null,
    accountText: materialAccountText(input.accountId),
  };
}

/**
 * The mutation answer that may be rendered for the currently selected batch.
 *
 * A mutation response is authoritative for the batch that produced it, so a local answer of another
 * batch — or one left over after the selection was cleared — is dropped before any view is built. The
 * panel additionally clears its stored local answer when the selection changes; this helper is the
 * rendering-side guard that keeps a stale answer from ever reaching the screen.
 */
export function localMaterialView(
  selectedBatchId: string | null,
  local: ApiMaterialBatchView | null,
): ApiMaterialBatchView | null {
  return selectedBatchId !== null && local !== null && local.batchId === selectedBatchId ? local : null;
}
