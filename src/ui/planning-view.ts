/**
 * Reading rules of the AI planning page (Sprint 11e).
 *
 * Pure state, validation and formatting helpers over the typed Stage 11d planning operations: no
 * React, no DOM, no store, no clock and no network. They exist so the externally meaningful rules a
 * user depends on — the default AI mode, the AI/rule scheduling bounds, the explicit candidate
 * scope (including an explicit empty selection that is never replaced by the automatic pool), the
 * input signature that invalidates a stale preparation, the poll gate that stops at a terminal
 * attempt, and the honest rendering of an unknown cost — can be pinned by tests without rendering
 * a page, and so the plan page cannot silently turn an unknown value into a zero, a terminal
 * attempt into a retry, or a non-Codeforces report into "insufficient data".
 */
import type { PlanAttemptStatus } from '../application/planning-types.js';
import { ABILITY_BASIS_LABELS, ABILITY_CONFIDENCE_LABELS } from './ability-view.js';

// ---------------------------------------------------------------------------------------
// Mode and scheduling bounds
// ---------------------------------------------------------------------------------------

/** The two planning modes the page offers; AI is the default and the rule preview is explicit. */
export type PlanningMode = 'ai' | 'rule';

/** Default mode of the page: AI planning, which prepares for free and pays only on request. */
export const DEFAULT_PLANNING_MODE: PlanningMode = 'ai';

export const PLANNING_MODE_LABELS: Readonly<Record<PlanningMode, string>> = {
  ai: 'AI 计划（默认）',
  rule: '免费规则计划',
};

/** Scheduling draft of one AI preparation; every field is validated before anything is sent. */
export interface PlanningDraft {
  readonly horizonDays: number;
  readonly minutesPerDay: number;
  readonly estimatedMinutes: number;
  readonly maxTasksPerDay: number;
}

/** Scheduling draft of the legacy rule preview, including its title contract. */
export interface RuleDraft {
  readonly title: string;
  readonly horizonDays: number;
  readonly minutesPerDay: number;
  readonly estimatedMinutes: number;
}

/** Approved AI defaults; the planning service applies the same values when one is omitted. */
export const AI_PLAN_DEFAULTS: PlanningDraft = {
  horizonDays: 7,
  minutesPerDay: 60,
  estimatedMinutes: 30,
  maxTasksPerDay: 3,
};

/** Legacy rule-preview defaults; this stage does not change the rule path. */
export const RULE_PLAN_DEFAULTS: RuleDraft = {
  title: '我的训练计划',
  horizonDays: 7,
  minutesPerDay: 60,
  estimatedMinutes: 30,
};

/** Largest candidate pool one preparation may name; the planning service enforces the same 100. */
export const MAX_AI_CANDIDATES = 100;

/** Result of one draft validation: `message` names the first field that is out of bounds. */
export interface PlanningValidation {
  readonly valid: boolean;
  readonly message: string | null;
}

function integerWithin(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validate one AI scheduling draft.
 *
 * AI bounds are the approved ones: days 1..30, minutes per day 1..480, at most 3 tasks per day and
 * an estimate between 1 and the day's minutes. The rule path keeps its own wider old limit.
 */
export function validateAiDraft(draft: PlanningDraft): PlanningValidation {
  if (!integerWithin(draft.horizonDays, 1, 30)) {
    return { valid: false, message: '天数需为 1–30 的整数。' };
  }
  if (!integerWithin(draft.minutesPerDay, 1, 480)) {
    return { valid: false, message: '每天分钟需为 1–480 的整数（AI 计划上限为 480）。' };
  }
  if (!integerWithin(draft.maxTasksPerDay, 1, 3)) {
    return { valid: false, message: '每日题量需为 1–3 的整数。' };
  }
  if (!integerWithin(draft.estimatedMinutes, 1, draft.minutesPerDay)) {
    return { valid: false, message: '每题预计分钟需为 1–每天分钟 的整数。' };
  }
  return { valid: true, message: null };
}

/** Validate the legacy rule draft; its old limits (minutes up to 1440) are preserved verbatim. */
export function validateRuleDraft(draft: RuleDraft): PlanningValidation {
  if (draft.title.trim().length === 0) {
    return { valid: false, message: '标题不能为空。' };
  }
  if (!integerWithin(draft.horizonDays, 1, 30)) {
    return { valid: false, message: '天数需为 1–30 的整数。' };
  }
  if (!integerWithin(draft.minutesPerDay, 1, 1440)) {
    return { valid: false, message: '每天分钟需为 1–1440 的整数。' };
  }
  if (!integerWithin(draft.estimatedMinutes, 1, draft.minutesPerDay)) {
    return { valid: false, message: '每题预计分钟需为 1–每天分钟 的整数。' };
  }
  return { valid: true, message: null };
}

// ---------------------------------------------------------------------------------------
// Candidate scope
// ---------------------------------------------------------------------------------------

/** Explicit candidate scope of one preparation: the user's selection or the bounded automatic pool. */
export type CandidateScope = 'selected' | 'auto';

export const CANDIDATE_SCOPE_LABELS: Readonly<Record<CandidateScope, string>> = {
  selected: '已勾选题目',
  auto: '当前账号未确认通过的题库（最多 100）',
};

export const PLANNING_SCOPE_AUTO_NOTE =
  '从当前账号所在平台的本地题库中，选择最多 100 道未确认通过的题目。';
export const PLANNING_SCOPE_SELECTED_NOTE =
  '从你勾选的题目中选择练习，已通过的题目会自动排除。';

/** Prefer the explicit selection when there is one; otherwise the automatic pool is the visible default. */
export function defaultCandidateScope(selectedKeys: readonly string[]): CandidateScope {
  return selectedKeys.length > 0 ? 'selected' : 'auto';
}

/** The scope note the page shows, so the real model input is never a surprise. */
export function candidateScopeNotice(scope: CandidateScope, selectedKeys: readonly string[]): string {
  if (scope === 'auto') {
    return PLANNING_SCOPE_AUTO_NOTE;
  }
  return `${PLANNING_SCOPE_SELECTED_NOTE} 当前已勾选 ${selectedKeys.length} 道。`;
}

/** Exact candidate members one preparation sends, independent of how the page renders them. */
export interface PlanningCandidateRequest {
  /** `null` is the automatic pool; an array (possibly empty) is the caller's exact selection. */
  readonly candidateProblemKeys: readonly string[] | null;
  /** Always a sufficient, bounded cap: the explicit selection is never truncated. */
  readonly candidateLimit: number;
  /** `true` when the selection exceeds {@link MAX_AI_CANDIDATES}; the page refuses instead of truncating. */
  readonly overLimit: boolean;
}

/**
 * Build the candidate members of one preparation.
 *
 * The selected scope keeps the caller's order and sends an explicit empty list as `[]` — never an
 * omitted member, which the service would read as the automatic pool. The automatic scope sends
 * `null` explicitly for the same reason. The cap is always the approved maximum, which is
 * sufficient for any allowed selection and never truncates one.
 */
export function planningCandidateRequest(
  scope: CandidateScope,
  selectedKeys: readonly string[],
): PlanningCandidateRequest {
  if (scope === 'auto') {
    return { candidateProblemKeys: null, candidateLimit: MAX_AI_CANDIDATES, overLimit: false };
  }
  const keys = [...selectedKeys];
  return { candidateProblemKeys: keys, candidateLimit: MAX_AI_CANDIDATES, overLimit: keys.length > MAX_AI_CANDIDATES };
}

/** Whether the chosen scope and selection are a legal preparation input. */
export function candidateScopeValidation(
  scope: CandidateScope,
  selectedKeys: readonly string[],
): PlanningValidation {
  if (scope === 'auto') {
    return { valid: true, message: null };
  }
  if (selectedKeys.length === 0) {
    return {
      valid: false,
      message: '已勾选 0 道题：显式空选择会被拒绝，不会回退到自动池；请先在题库勾选，或改为“当前账号未确认通过的题库”。',
    };
  }
  if (selectedKeys.length > MAX_AI_CANDIDATES) {
    return {
      valid: false,
      message: `已勾选 ${selectedKeys.length} 道，超过 ${MAX_AI_CANDIDATES} 道上限：请减少候选题，显式选择不会被截断。`,
    };
  }
  return { valid: true, message: null };
}

// ---------------------------------------------------------------------------------------
// Preparation identity
// ---------------------------------------------------------------------------------------

/** Everything a preparation is built from; any change invalidates the visible preparation. */
export interface PlanningSignatureInput {
  readonly accountId: string;
  /** Stored workbench-settings revision the page currently sees, or `null` when none is stored. */
  readonly settingsRevision: number | null;
  readonly scope: CandidateScope;
  readonly selectedKeys: readonly string[];
  readonly draft: PlanningDraft;
  readonly reveal: boolean;
}

/**
 * Snapshot signature of one preparation input.
 *
 * The page compares the signature captured before a free preparation with the current one: a late
 * answer of a changed account, selection, scope, schedule or settings revision is ignored instead
 * of being adopted as if it described what the form now shows. The settings revision taken here is
 * only an invalidation trigger — the paid run always sends the revision the **preparation**
 * captured, never a value guessed from the bootstrap record.
 */
export function planningInputSignature(input: PlanningSignatureInput): string {
  return JSON.stringify([
    input.accountId,
    input.settingsRevision,
    input.scope,
    input.selectedKeys,
    input.draft.horizonDays,
    input.draft.minutesPerDay,
    input.draft.estimatedMinutes,
    input.draft.maxTasksPerDay,
    input.reveal,
  ]);
}

/**
 * Adopt one asynchronous preparation answer only while its snapshot still matches the form.
 *
 * Returns `null` for a late answer, so a caller can keep the current view untouched.
 */
export function adoptPreparation<T>(answer: T, preparedSignature: string, currentSignature: string): T | null {
  return preparedSignature === currentSignature ? answer : null;
}

// ---------------------------------------------------------------------------------------
// Tracking and polling
// ---------------------------------------------------------------------------------------

/** One AI request the page currently follows; `ownedRunning` survives an acknowledgement before reservation. */
export interface TrackedPlanningRequest {
  readonly requestId: string;
  readonly accountId: string;
  /** `true` while this page instance owns a run it acknowledged and has not seen settle. */
  readonly ownedRunning: boolean;
}

/**
 * The tracked request only while it belongs to the visible account.
 *
 * History and status answers are account scoped on the server; this is the client-side half of the
 * same rule, so a request id remembered for another account can never be polled under this one.
 */
export function trackedForAccount(
  tracked: TrackedPlanningRequest | null,
  accountId: string | null,
): TrackedPlanningRequest | null {
  if (tracked === null || accountId === null) {
    return null;
  }
  return tracked.accountId === accountId ? tracked : null;
}

/** Input of the poll gate: the durable status, the owned operation state and the ownership flag. */
export interface PlanningPollInput {
  readonly status: PlanAttemptStatus | 'unknown' | null;
  readonly operationState: 'running' | 'settled' | null;
  readonly ownedRunning: boolean;
}

/**
 * Whether the page should keep polling `plan.aiStatus`.
 *
 * Polling is a free metadata read and stops at a terminal attempt: a dispatched call is followed
 * while it is reserved or while this instance owns a running operation (an acknowledgement can
 * arrive before the reservation exists, so `ownedRunning` keeps the first poll alive even when the
 * attempt still reads `prepared`). A terminal attempt is never polled again and is never
 * re-dispatched automatically — a paid retry is always a new explicit user action.
 */
export function shouldPollPlanning(input: PlanningPollInput): boolean {
  if (input.operationState === 'running') {
    return true;
  }
  if (input.ownedRunning) {
    return true;
  }
  return input.status === 'reserved';
}

/** `true` for a status no later poll can change. */
export function isTerminalAttempt(status: PlanAttemptStatus): boolean {
  return status === 'settled' || status === 'uncertain' || status === 'cancelled';
}

// ---------------------------------------------------------------------------------------
// Status, usage and error copy
// ---------------------------------------------------------------------------------------

/** Chinese labels of every durable attempt status; `unknown` means the id is not visible here. */
export const PLANNING_STATUS_LABELS: Readonly<Record<PlanAttemptStatus, string>> = {
  prepared: '已准备（免费，未调用模型）',
  reserved: '调用进行中（待结算）',
  settled: '已结算',
  uncertain: '结果未知（可能已计费）',
  cancelled: '已取消（未调用模型）',
};

export function planningStatusLabel(status: PlanAttemptStatus | 'unknown'): string {
  return status === 'unknown' ? '未找到记录' : PLANNING_STATUS_LABELS[status];
}

/** The usage counters one attempt may carry; `null` means the provider never reported them. */
export interface PlanningUsageLike {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface PlanningUsageAttempt {
  readonly status: PlanAttemptStatus;
  readonly usage: PlanningUsageLike | null;
}

/**
 * One honest usage line.
 *
 * A known cost prints its tokens; an attempt that never dispatched says so; everything else names
 * the unknown explicitly instead of printing `0` — an unknown cost is never a free call.
 */
export function planningUsageText(attempt: PlanningUsageAttempt): string {
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
  return '用量未知（模型服务未报告）：调用可能已计费，不会按 0 处理，也不会自动重试。';
}

/** Retryability copy: a manual retry is always a new explicit action, never automatic. */
export function planningRetryText(retryable: boolean): string {
  return retryable ? '可手动重试（不会自动重试）' : '不可重试';
}

/**
 * Stable Chinese copy of every failure code this page can receive.
 *
 * The wording keeps a known paid failure and an unknown cost visible: a quota refusal names the
 * independent 24-hour counters, an invalid output says the cost was retained, and an unknown
 * outcome says it may have been charged. No provider prose, payload or account handle is rendered.
 */
export const PLANNING_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  preparation_missing: '这次请求没有可用的免费准备：请先免费准备，再确认付费生成。',
  preparation_empty: '没有可用的真实候选题，未生成计划：可先同步/导入题目，或减少已通过的候选题。',
  settings_changed: '设置已变化：请刷新设置后重新免费准备，再确认付费生成。',
  model_changed: '准备时使用的模型与当前配置不一致：请重新免费准备，不会用不同模型继续。',
  stale_preparation: '准备所依据的数据已变化（题目、标签、通过状态或能力证据）：请重新免费准备。',
  planning_quota_exhausted: '计划的 24 小时调用上限已用完（提示与计划各自独立计数，只共用同一上限值）：请稍后再试。',
  concurrent_call_active: '已有一次计划调用正在进行：请等待它结束或先取消，再重试。',
  invalid_output: '模型输出未通过校验：本次费用已保留，未保存计划，不会自动重试。',
  provider_error: '模型调用失败：已保留已知费用；若费用未知会标记为“结果未知”，不会自动重试。',
  timeout: '调用超时：结果未知，可能仍会计费，不会自动重试。',
  rate_limited: '模型或平台限流：请稍后再试，不会自动重试。',
  quota_exhausted: '调用额度已用尽：不会自动重试。',
  uncertain: '调用结果未知（provider 未报告用量）：可能已计费，不会自动重试。',
  unsupported: '当前模型或提供方不支持该操作。',
  cancelled: '已取消。',
  invalid_input: '输入不符合要求：请检查填写内容。',
  not_found: '找不到该计划请求：可能不存在，请刷新记录。',
  conflict: '数据已变化或任务状态冲突：请刷新后重试。',
  settings_conflict: '设置版本冲突：请刷新设置后重试。',
  model_busy: '另一个模型任务仍在运行：请等待或取消后再试。',
  model_invalid: '模型配置暂不可用：请在设置页查看原因。',
  history_overflow: '存储的历史记录超出可读上限：请缩小范围。',
  unavailable: '该宿主没有安装 AI 计划功能。',
  internal: '操作失败：请查看本地 dsh 日志。',
  network_error: '无法连接工作台：请检查 dsh 是否运行。',
  unauthorized: '登录已失效：请从 dsh 启动地址重新打开。',
  invalid_response: '服务返回了无法识别的响应。',
  version_mismatch: '工作台接口版本不兼容：请重新加载插件。',
  invalid_operation: '未知操作。',
};

/** Chinese message of one stable code, or `fallback` when the code is unknown to this page. */
export function planningErrorText(code: string | null | undefined, fallback: string): string {
  if (code === null || code === undefined) {
    return fallback;
  }
  return PLANNING_ERROR_MESSAGES[code] ?? fallback;
}

/** The acknowledgement copy shown right after `plan.aiRun`; it never claims a result it did not see. */
export function planningRunNote(result: {
  readonly operation: { readonly state: 'running' | 'settled' } | null;
  readonly attempt: { readonly status: PlanAttemptStatus; readonly planId: string | null } | null;
}): string {
  if (result.operation?.state === 'running') {
    return '已受理：模型调用在后台运行。可以离开本页；回来时可在“最近的 AI 计划记录”恢复查看，不会自动重试。';
  }
  if (result.attempt === null) {
    return '没有可读取的结算记录：请刷新记录，或重新免费准备（新的 request id）。';
  }
  if (result.attempt.status === 'reserved') {
    return '调用已预留、正在结算：请刷新状态查看结果；不会自动重试。';
  }
  if (result.attempt.planId !== null) {
    return '调用已完成并保存了计划：可在下方“已保存计划”查看与采用。';
  }
  return `本次请求的最终状态：${planningStatusLabel(result.attempt.status)}。`;
}

/** Cancel outcome copy: a free preparation cancel is separated from a pending paid settlement. */
export function planningCancelText(result: {
  readonly cancelled: boolean;
  readonly status: 'unknown' | PlanAttemptStatus;
}): string {
  if (result.cancelled) {
    return '已发送取消：准备阶段的取消免费；如果调用已经预留，实际费用仍以结算记录为准。';
  }
  if (result.status === 'unknown') {
    return '未找到该请求：可能不存在或不属于当前账号。';
  }
  if (result.status === 'cancelled') {
    return '该准备已取消：未调用模型，未产生费用。';
  }
  if (result.status === 'reserved') {
    return '当前会话无法中止这次已派发的调用，可能仍会产生费用：请稍后刷新状态查看真实用量。';
  }
  return `该请求已经是${planningStatusLabel(result.status)}，无法再取消：请查看用量与结果记录。`;
}

// ---------------------------------------------------------------------------------------
// Compact ability summary
// ---------------------------------------------------------------------------------------

/** Aggregate range carried by the identifier-free ability summary. */
export interface PlanningAbilityRange {
  readonly min: number;
  readonly max: number;
}

/** Structural view of the identifier-free ability aggregate a preparation carries. */
export interface PlanningAbilityView {
  readonly platform: string;
  readonly estimateStatus: 'estimated' | 'unknown';
  readonly estimateBasis: 'recent_independent' | 'recent_observed' | 'historical' | null;
  readonly confidence: 'low' | 'medium' | null;
  readonly sampleSize: number;
  readonly minimumSampleSize: number;
  readonly baselineTrainingLevel: number | null;
  readonly quartileBand: PlanningAbilityRange | null;
  readonly baselinePool: PlanningAbilityRange | null;
  readonly stretchPool: PlanningAbilityRange | null;
  readonly nativeDifficulty: readonly {
    readonly dimension: string;
    readonly count: number;
    readonly missing: number;
    readonly median: number | null;
  }[];
  readonly caveats: readonly string[];
}

/** Compact rendering of the aggregate the plan preparation sends to the model. */
export interface PlanningAbilitySummary {
  readonly headline: string;
  readonly sample: string;
  readonly band: string;
  readonly confidence: string;
  readonly native: readonly string[];
}

function rangeText(range: PlanningAbilityRange | null): string {
  return range === null ? '未给出' : `${range.min} – ${range.max}`;
}

/**
 * Compact ability baseline for the preparation panel.
 *
 * A Codeforces estimate prints its training reference; a non-Codeforces platform with real native
 * values says the CF estimate does not apply instead of "insufficient data"; everything else names
 * the sample that missed the gate. Native medians stay on their own scale.
 */
export function planningAbilitySummary(ability: PlanningAbilityView): PlanningAbilitySummary {
  const nativeCount = ability.nativeDifficulty.reduce((total, row) => total + row.count, 0);
  const estimated = ability.estimateStatus === 'estimated' && ability.baselineTrainingLevel !== null;
  const headline = estimated
    ? `训练难度参考 ${ability.baselineTrainingLevel} 左右`
    : ability.platform !== 'codeforces' && nativeCount > 0
      ? '原生刻度评估（CF 估计不适用）'
      : `未知（有效样本 ${ability.sampleSize} / ${ability.minimumSampleSize}）`;
  const basis = ability.estimateBasis === null ? '无可用样本' : ABILITY_BASIS_LABELS[ability.estimateBasis];
  return {
    headline,
    sample: `${ability.sampleSize} / ${ability.minimumSampleSize} 题（${basis}）`,
    band: rangeText(ability.quartileBand),
    confidence: ability.confidence === null ? '未知' : ABILITY_CONFIDENCE_LABELS[ability.confidence],
    native: ability.nativeDifficulty.map((row) =>
      row.count === 0
        ? `${row.dimension}：暂无可用的原生数值样本（${row.missing} 题缺失）`
        : `${row.dimension}：中位数 ${row.median ?? '缺失'}（${row.count} 题有数值，${row.missing} 题缺失）`,
    ),
  };
}

// ---------------------------------------------------------------------------------------
// Fixed disclosure copy
// ---------------------------------------------------------------------------------------

export const PLANNING_PREPARE_FREE_NOTE =
  '“免费准备”只读取本地题目与本地统计并保存准备记录：不调用模型、不产生费用。只有下面的“生成 AI 计划（调用模型）”才会发起一次付费调用。';
export const PLANNING_PAID_DISCLOSURE_NOTE =
  '每次生成调用一次模型，不会自动重试；费用取决于输入和输出用量。';
export const PLANNING_CANDIDATE_SPOILER_NOTE =
  '候选题的平台原始标签尚未复核，只作选题参考；生成计划不会改写标签审核结果。';
export const PLANNING_CONFIG_NOTE =
  '准备记录会捕获当时的设置版本；付费生成只使用这个版本，设置变化后必须重新免费准备。';
export const PLANNING_HISTORY_NOTE =
  '刷新页面后，可在这里找回任务状态和结果。尚未生成的旧准备可取消，或按当前表单重新免费准备。';
export const PLANNING_GENERATE_LABEL = '生成 AI 计划（调用模型）';

/** Unique request id of one free preparation; the caller owns idempotency, the service only bounds it. */
export function newPlanningRequestId(): string {
  return globalThis.crypto.randomUUID();
}
