/**
 * Reading rules of the independent AI assessment page (Sprint 18e).
 *
 * Pure presentation helpers over the typed Stage 18d assessment API: no React, no DOM, no clock and
 * no network. They exist so the decisions a reader depends on can be pinned by tests without
 * rendering a page, and so the page cannot silently turn an unknown value into a zero or a changed
 * method into a substitution:
 *
 * - a confirmed-free preparation and a confirmed-zero cancellation say so; an unsettled or
 *   unreported usage stays explicitly unknown and is never printed as `0`;
 * - a report without a numeric estimate states *why* (no objective anchor) instead of showing `0`;
 * - an official rating of `0` or a negative value is a real value, while an unrated or unsynced
 *   official rating stays visibly missing — the two are never rendered the same way;
 * - a preparation is runnable only while its **frozen** method selection still matches the installed
 *   catalogue (same ids in the same order, same method hashes) and the stored settings revision has
 *   not moved; nothing is ever substituted, and the refusal names the exact reason;
 * - every `evidenceRef` a report cites is resolved to the human label captured with it, and an
 *   unknown reference is reported as unknown rather than guessed.
 *
 * The report itself is never re-validated here: the server already validated the stored answer
 * against its own capture, so the UI renders exactly what the typed API returned.
 */
import type { AssessmentAnchorKind, AssessmentRatingRange } from '../domain/assessment.js';
import type { CompetitionSummary } from '../domain/official-rating.js';
import type { AssessmentAttemptStatus } from '../application/assessment-types.js';
import type { AssessmentModelEvidence } from '../application/assessment-capture.js';

// ---------------------------------------------------------------------------------------
// Fixed copy
// ---------------------------------------------------------------------------------------

/** Panel title; the label separates the AI inference from the official rating before anything else. */
export const AI_ASSESSMENT_TITLE = 'AI 能力评估（独立于官方评分）';

/** What this slice is, and the two-step cost model it exists to make visible. */
export const ASSESSMENT_SECTION_NOTE =
  '这里得到的是一份 AI 推断的能力评估：它只读取你已同步/导入的聚合证据，单独保存在本地，既不会改写 Codeforces 官方 rating，也不会改写你的自评校准。评估分两步：免费准备（不调用模型），确认后才发起一次付费调用。';

/** The free half, stated next to the free button. */
export const ASSESSMENT_PREPARE_FREE_NOTE =
  '“免费准备评估”只读取本地证据、按你显式选择的方法冻结一份准备记录：不调用模型、不产生费用、不占用 24 小时调用额度。';

/** The paid half: exactly one call, explicit, never automatic. */
export const ASSESSMENT_PAID_DISCLOSURE_NOTE =
  '“生成 AI 评估报告”只在你点击时调用一次模型，不会自动重试；一次生成只会计入一次滚动 24 小时额度。';

/** Where the model/budget numbers come from, and why the prepared revision is the one that runs. */
export const ASSESSMENT_CONFIG_NOTE =
  '下面的模型与额度来自当前工作台设置；每条准备记录冻结了它自己的设置版本与模型，付费生成只使用该版本，设置变化后必须重新免费准备。';

/** An uninstalled or upgraded method never rewrites history. */
export const ASSESSMENT_FROZEN_NOTE =
  '准备记录冻结了当时的方法文本、方法哈希与去标识证据。方法被卸载或升级后，这份历史记录仍显示当时的原文，不会自动替换成新版本。';

/** The evidence preview is the exact payload, not a sample. */
export const ASSESSMENT_EVIDENCE_NOTE =
  '以下是这次真实发送给模型的去标识证据（聚合统计与合成引用），不含账号、用户名、提交明细、题目链接、备注或具体时间戳；可展开查看确切 JSON。';

/** History is durable and read-only until the user asks for another paid call. */
export const ASSESSMENT_HISTORY_NOTE =
  '历史记录按当前账号持久保存，刷新页面或卸载插件后仍然存在。查看历史只读取状态与已保存的报告，不会发起任何模型调用。';

/** The only paid trigger on the page. */
export const ASSESSMENT_GENERATE_LABEL = '生成 AI 评估报告（调用模型一次）';

/** The stored report's verification label, repeated next to every rendered report. */
export const ASSESSMENT_VERIFICATION_NOTE =
  '报告标记为 unverified_ai（未经验证的 AI 推断），不会写入官方 rating 或自评校准。';

/** Page sizes the history offers; both stay inside the service's own maximum of 20. */
export const ASSESSMENT_HISTORY_LIMITS: readonly number[] = [10, 20];
export const DEFAULT_ASSESSMENT_HISTORY_LIMIT = 10;

/** Human labels of the three confidence levels the report may declare. */
export const ASSESSMENT_CONFIDENCE_LABELS: Readonly<Record<'low' | 'medium' | 'high', string>> = {
  low: '低',
  medium: '中',
  high: '高',
};

// ---------------------------------------------------------------------------------------
// Status, usage and outcome copy
// ---------------------------------------------------------------------------------------

/** Chinese labels of every durable attempt status. */
export const ASSESSMENT_STATUS_LABELS: Readonly<Record<AssessmentAttemptStatus, string>> = {
  prepared: '已准备（免费，未调用模型）',
  reserved: '调用进行中（已预留，待结算）',
  settled: '已结算',
  uncertain: '结果未知（可能已计费）',
  cancelled: '已取消（未调用模型）',
};

export function assessmentStatusLabel(status: AssessmentAttemptStatus): string {
  return ASSESSMENT_STATUS_LABELS[status];
}

/** `true` only for an owned, unsettled paid call: the single status the page polls. */
export function shouldPollAssessment(status: AssessmentAttemptStatus): boolean {
  return status === 'reserved';
}

/** `true` for a status no later read can change. */
export function isAssessmentTerminal(status: AssessmentAttemptStatus): boolean {
  return status === 'settled' || status === 'uncertain' || status === 'cancelled';
}

/** The usage counters one attempt may carry; `null` means the provider never reported them. */
export interface AssessmentUsageLike {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface AssessmentUsageAttempt {
  readonly status: AssessmentAttemptStatus;
  readonly usage: AssessmentUsageLike | null;
}

/**
 * One honest usage line.
 *
 * A known cost prints its tokens; a preparation and a pre-dispatch cancellation are confirmed
 * zero-cost; everything else names the unknown explicitly instead of printing `0`.
 */
export function assessmentUsageText(attempt: AssessmentUsageAttempt): string {
  if (attempt.usage !== null) {
    const usage = attempt.usage;
    return `已知用量：调用 ${usage.calls} 次 · 输入 ${usage.promptTokens} / 输出 ${usage.completionTokens} / 合计 ${usage.totalTokens} tokens`;
  }
  if (attempt.status === 'prepared') {
    return '未调用模型：免费准备，尚未产生费用。';
  }
  if (attempt.status === 'cancelled') {
    return '未调用模型：已确认零调用、零计费。';
  }
  if (attempt.status === 'reserved') {
    return '尚未结算：调用可能已经发生，费用未知。';
  }
  return '用量未知（模型服务未报告）：调用可能已计费，不按 0 处理，也不会自动重试。';
}

/** Compact usage for one history row; the unknown stays unknown in a narrow column too. */
export function assessmentUsageBrief(attempt: AssessmentUsageAttempt): string {
  if (attempt.usage !== null) {
    return `${attempt.usage.calls} 次调用 · ${attempt.usage.totalTokens} tokens`;
  }
  if (attempt.status === 'prepared') return '未调用模型';
  if (attempt.status === 'cancelled') return '零调用、零计费';
  if (attempt.status === 'reserved') return '待结算（费用未知）';
  return '用量未知（可能已计费）';
}

/** Retryability copy: a manual retry is always a new explicit action, never automatic. */
export function assessmentRetryText(retryable: boolean): string {
  return retryable ? '可手动重试（不会自动重试）' : '不可重试';
}

// ---------------------------------------------------------------------------------------
// Anchor, rating and estimate diagnostics
// ---------------------------------------------------------------------------------------

/** The anchor facts a capture published; an {@link AssessmentPromptAnchor} is assignable to it. */
export interface AssessmentAnchorLike {
  readonly kind: AssessmentAnchorKind;
  readonly officialRating: number | null;
  readonly eligibleVirtualRuns: number;
}

/**
 * The official rating as evidence, never blended with the AI estimate.
 *
 * A `rated` profile prints its exact number — `0` and a negative value are real values and are
 * printed as such — while `unrated` and `not_loaded` are missing data and say so instead of
 * becoming a zero.
 */
export function officialRatingText(summary: CompetitionSummary | null): string {
  if (summary === null) {
    return '这次证据里没有可读取的官方 rating 事实：未知，不是 0 分。';
  }
  if (summary.status === 'rated') {
    const rating = summary.rating === null ? '未知' : String(summary.rating);
    const max = summary.maxRating === null ? '未知' : String(summary.maxRating);
    return `官方当前 rating ${rating}（历史最高 ${max}，${summary.ratedContests} 场 rated）：这是只读的官方数据，AI 不会修改它。`;
  }
  if (summary.status === 'unrated') {
    return '官方账号没有 rated 比赛记录（未评级）：这是缺失，不是 0 分。';
  }
  return '尚未同步官方 rating：未知，不是 0 分；练习统计不能替代比赛评分。';
}

/** Which objective number, if any, allowed a numeric estimate. */
export function assessmentAnchorText(anchor: AssessmentAnchorLike | null): string {
  if (anchor === null) {
    return '本次记录没有可读取的锚点事实：不显示数值，也不按 0 处理。';
  }
  if (anchor.kind === 'official_rating') {
    return anchor.officialRating === null
      ? '锚点标记为官方 rating，但数值缺失：不猜测具体数字。'
      : `客观数值锚点：官方比赛 rating ${String(anchor.officialRating)}（只读，不修改）。`;
  }
  if (anchor.kind === 'virtual_performance') {
    return `客观数值锚点：用户录入的 ${anchor.eligibleVirtualRuns} 条独立且赛前未见题的虚拟参赛记录（不是官方评分，也不做官方换算）。`;
  }
  return '没有客观数值锚点：官方 rating 缺失，也没有独立且赛前未见题的虚拟参赛记录（自评与练习 AC 数不算锚点）。';
}

/**
 * The report's numeric estimate, or the honest diagnostic that replaces it.
 *
 * `null` never becomes `0`: it either states that no objective anchor existed at all or that the
 * model declined to estimate even though one anchor was available.
 */
export function assessmentRangeText(input: {
  readonly range: AssessmentRatingRange | null;
  readonly anchor: AssessmentAnchorLike | null;
}): string {
  const range = input.range;
  if (range !== null) {
    return `AI 推断区间 ${range.min} – ${range.max}（不是官方 rating，也不覆盖它）。`;
  }
  if (input.anchor === null) {
    return '本次记录没有可读取的锚点信息：不显示数值估计，也不按 0 处理。';
  }
  if (input.anchor.kind === 'none') {
    return '未给出数值区间：这次证据里没有客观数值锚点（官方 rating 或独立且赛前未见题的虚拟赛），所以不估算、不按 0 分处理。';
  }
  return `未给出数值区间：虽然存在客观锚点（${input.anchor.kind === 'official_rating' ? '官方 rating' : `${input.anchor.eligibleVirtualRuns} 条独立虚拟赛记录`}），模型仍未给出数值；不按 0 分处理。`;
}

/**
 * Resolve one report citation to the human label captured next to it.
 *
 * The reference set is the closed evidence list the server validated the report against; a
 * reference absent from it is reported as unknown instead of being guessed or dropped silently.
 */
export function assessmentEvidenceRefText(ref: string, evidence: AssessmentModelEvidence | null): string {
  const entry = evidence === null ? null : evidence.evidence.find((item) => item.evidenceRef === ref) ?? null;
  if (entry === null) {
    return `证据引用 ${ref} 不在本次采集的证据清单中（不猜测其含义）`;
  }
  return `${entry.label}（${entry.evidenceRef}）`;
}

// ---------------------------------------------------------------------------------------
// Paid-run gate
// ---------------------------------------------------------------------------------------

/** Identity of one method as the frozen capture and the live catalogue each see it. */
export interface AssessmentMethodIdentity {
  readonly methodId: string;
  readonly version: string;
  readonly methodHash: string;
}

/** Everything that decides whether a visible preparation may still spend a paid call. */
export interface AssessmentRunCheckInput {
  /** Method ids frozen in the preparation, in selection order. */
  readonly viewMethodIds: readonly string[];
  /** Method snapshots frozen in the preparation. */
  readonly viewMethods: readonly AssessmentMethodIdentity[];
  /** The methods the form currently has selected; the paid run would use the *prepared* order. */
  readonly selectedMethodIds: readonly string[];
  /** Assessment-capable methods installed right now. */
  readonly catalog: readonly AssessmentMethodIdentity[];
  readonly viewSettingsRevision: number | null;
  /** Settings revision currently readable, or `null` when no config answer is available. */
  readonly currentSettingsRevision: number | null;
  /** `true` when the config read itself failed, so no settings revision could be confirmed. */
  readonly settingsUnread: boolean;
}

export interface AssessmentRunCheck {
  readonly blocked: boolean;
  readonly message: string | null;
}

/**
 * Whether the visible preparation may still start its one paid call.
 *
 * The check compares the frozen selection and the frozen method hashes with what is installed now,
 * and the frozen settings revision with the stored one. A missing, replaced, upgraded or
 * deselected method blocks the run with a named reason; the page never substitutes a method, never
 * silently truncates a selection and never runs under a different settings revision.
 */
export function assessmentRunProblem(input: AssessmentRunCheckInput): AssessmentRunCheck {
  const catalogById = new Map(input.catalog.map((method) => [method.methodId, method]));
  for (const method of input.viewMethods) {
    const installed = catalogById.get(method.methodId);
    if (installed === undefined) {
      return {
        blocked: true,
        message: `准备时使用的方法 ${method.methodId}（${method.version}）已不在已安装列表中：它可能被卸载或停用。请重新免费准备；插件不会自动替换方法。`,
      };
    }
    if (installed.methodHash !== method.methodHash) {
      return {
        blocked: true,
        message: `准备时使用的方法 ${method.methodId} 已变化（准备时 ${method.version}，当前 ${installed.version}）：请重新免费准备，插件不会用新版本继续这次付费调用。`,
      };
    }
  }
  if (!sameIds(input.viewMethodIds, input.selectedMethodIds)) {
    return {
      blocked: true,
      message: '当前选择的评估方法与准备记录不一致：修改方法选择后必须重新免费准备，再付费生成。',
    };
  }
  if (input.settingsUnread) {
    return {
      blocked: true,
      message: '无法读取当前评估配置，因此无法确认设置版本是否变化：请先刷新配置，再付费生成。',
    };
  }
  if (input.viewSettingsRevision === null) {
    return {
      blocked: true,
      message: '这条准备记录没有冻结设置版本：请到设置页保存一次设置，然后重新免费准备（本次未扣费）。',
    };
  }
  if (input.currentSettingsRevision !== null && input.currentSettingsRevision !== input.viewSettingsRevision) {
    return {
      blocked: true,
      message: `工作台设置已从第 ${input.viewSettingsRevision} 版变为第 ${input.currentSettingsRevision} 版：请重新免费准备；付费生成只使用准备记录里的版本。`,
    };
  }
  return { blocked: false, message: null };
}

/** Why the free prepare button is unavailable, or `null` when the form is ready. */
export interface AssessmentPrepareState {
  readonly readPending: boolean;
  readonly readFailed: boolean;
  readonly methodCount: number;
  readonly selectedCount: number;
  readonly missing: readonly string[];
}

export function assessmentPrepareProblem(state: AssessmentPrepareState): string | null {
  if (state.readPending) return null;
  if (state.readFailed) return '评估方法列表读取失败：请用上面的“刷新方法列表”重试；没有方法列表时不会准备。';
  if (state.methodCount === 0) {
    return '没有可用的评估方法：请在 dsh 插件管理中安装并启用带评估能力的指导方法包。';
  }
  if (state.missing.length > 0) {
    return `所选方法已卸载或不可用：${state.missing.join('、')}。请重新选择；插件不会自动替换。`;
  }
  if (state.selectedCount === 0) {
    return '请至少选择一个评估方法（最多 4 个）：评估必须绑定到你显式选择的方法文本。';
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Acknowledgements
// ---------------------------------------------------------------------------------------

/** What one `assessment.run` answer claims; `started:false` means no new paid call was made. */
export interface AssessmentRunOutcome {
  readonly started: boolean;
  readonly status: AssessmentAttemptStatus;
  readonly hasReport: boolean;
}

/**
 * The acknowledgement shown right after a paid run.
 *
 * It never claims a result it did not see, and it always states whether this click actually charged
 * anything: a replayed request id returns `started:false` and no second call is dispatched.
 */
export function assessmentRunNote(outcome: AssessmentRunOutcome): string {
  if (!outcome.started && outcome.status === 'reserved') {
    return '这次请求此前已经发起过调用，本次没有重复扣费：请刷新状态查看结算结果，不会自动重试。';
  }
  if (!outcome.started) {
    return `本次没有发起新的调用：该请求已经是${assessmentStatusLabel(outcome.status)}。`;
  }
  if (outcome.status === 'reserved') {
    return '已受理：模型调用在后台运行（已预留一次调用）。可以离开本页，稍后从历史记录恢复查看；不会自动重试。';
  }
  if (outcome.status === 'settled' && outcome.hasReport) {
    return '调用已完成并保存了报告：见下方报告。';
  }
  if (outcome.status === 'settled') {
    return '调用已结算但没有可用的报告：真实用量已保留，不会自动重试。';
  }
  if (outcome.status === 'uncertain') {
    return '结果未知（模型服务未报告用量）：可能已经计费，不会自动重试。';
  }
  if (outcome.status === 'cancelled') {
    return '已取消：未调用模型，未产生费用。';
  }
  return '这次准备还没有付费生成。';
}

/** Cancel outcome copy: a free preparation cancel is separated from an already-dispatched call. */
export function assessmentCancelText(status: AssessmentAttemptStatus): string {
  if (status === 'cancelled') {
    return '该准备已取消：未调用模型，未产生费用。';
  }
  if (status === 'prepared') {
    return '取消请求已发送：请刷新状态确认最终结果。';
  }
  if (status === 'reserved') {
    return '已发送取消：已派发的调用仍以结算记录为准，可能已经产生费用；请刷新状态查看最终用量。';
  }
  return `该请求已经是${assessmentStatusLabel(status)}，不能再取消：请查看用量与报告记录。`;
}

// ---------------------------------------------------------------------------------------
// Failure codes
// ---------------------------------------------------------------------------------------

/**
 * Stable Chinese copy of every failure code this page can receive.
 *
 * Two vocabularies meet here: the **transport** codes of the business API (`ApiClientError.code`,
 * where the server folds stale evidence and quota exhaustion into `conflict` and settings into
 * `settings_changed`) and the **stored model outcome** codes of `view.error.code`. The wording keeps
 * a known paid failure and an unknown cost visible: an invalid output says the cost was retained, a
 * timeout says the outcome is unknown, and nothing renders provider prose, a payload or an account
 * id. Codes with no entry fall back to the caller's own text.
 */
export const ASSESSMENT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // Transport codes of the business API.
  conflict:
    '数据已变化或已达上限：可能是证据/方法已变化、24 小时评估额度已用完，或该 request id 已用于其他准备。请刷新记录；若要继续，请重新免费准备（本次未扣费）。',
  settings_changed: '工作台设置已变化：请刷新配置并重新免费准备，付费生成只使用准备记录冻结的版本。',
  model_busy: '已有评估调用正在进行，或插件正在关闭：请等待它结束或先取消，再重试。',
  model_invalid: '模型配置暂不可用：请在设置页查看原因。',
  invalid_input: '请求不符合要求（方法选择、账号或字段）：请检查后重试，未产生费用。',
  not_found: '找不到这条评估记录：它可能不存在或不属于当前账号；请刷新历史记录后重试。',
  payload_too_large: '请求内容过大：请缩小输入后重试。',
  unsupported_media_type: '请求格式不受支持：请重新加载插件后重试。',
  internal: '操作失败：请查看本地 dsh 日志。',
  // Stored model-outcome codes of one attempt (`view.error.code`).
  timeout: '超时：本次调用的最终结果未知（可能仍在后台结算，也可能已经计费）。请刷新状态查看用量，不会自动重试。',
  cancelled: '已取消：准备阶段的取消免费；如果调用已经预留，费用仍以结算记录为准。',
  rate_limited: '模型或平台限流：请稍后再试，不会自动重试。',
  quota_exhausted: '调用额度已用尽：不会自动重试。',
  invalid_output: '模型输出未通过服务端校验：本次用量已保留，报告未保存，不会自动重试。',
  provider_error: '模型调用失败：已保留已知用量；若用量未知会标记为“结果未知”，不会自动重试。',
  unsupported: '当前模型或提供方不支持该操作。',
  // Browser transport codes of `ApiClient`.
  network_error: '无法连接工作台：请检查 dsh 是否运行；已预留的调用不会因为刷新而重复计费。',
  unauthorized: '登录已失效：请从 dsh 启动地址重新打开。',
  invalid_response: '服务返回了无法识别的响应。',
  version_mismatch: '工作台接口版本不兼容：请重新加载插件。',
  invalid_operation: '未知操作。',
};

/** Chinese message of one stable code, or `fallback` when the code is unknown to this page. */
export function assessmentErrorText(code: string | null | undefined, fallback: string): string {
  if (code === null || code === undefined) {
    return fallback;
  }
  return ASSESSMENT_ERROR_MESSAGES[code] ?? fallback;
}

// ---------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------

/** Local rendering of one stored instant; a broken value reads as missing, never as a date. */
export function assessmentWhenText(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '时间缺失';
}

/** Unique request id of one free preparation; the caller owns idempotency, the service only bounds it. */
export function newAssessmentRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/** Ordered comparison of two method selections; order is part of the frozen capture. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
