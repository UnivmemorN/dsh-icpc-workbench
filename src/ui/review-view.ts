/**
 * Reading rules of the tag-review page (Sprint 33A).
 *
 * Pure helpers over the typed `batch.*` answers: no React, no DOM, no store, no clock and no
 * network. They exist so the externally meaningful rules a user depends on can be pinned by tests
 * without rendering a page — above all that a batch is only startable when it really has runnable
 * jobs, that a batch whose material is blocked can never be started or continued, and that the
 * platform's English error codes stay in the diagnostic area instead of becoming the primary text.
 *
 * Two boundaries are deliberately explicit here:
 *
 * - **A blocked problem is not a new task.** The preparation summary reports runnable jobs,
 *   already-checked problems, reruns and blocked material as four separate numbers, and the blocked
 *   ones are never folded into the workload or into the call bound.
 * - **Refreshing material cannot repair an old batch.** A fresh material state produces a new
 *   snapshot while the stored batch keeps the immutable snapshot it captured, so the only remedy is
 *   to refresh or supplement and then prepare a new batch. The resume action is described as what
 *   it is — reclaiming leases and interruption — and never as a material fix.
 */
import type {
  ModelBatchBlockedProblemView,
  ModelBatchDetailResult,
  ModelBatchPrepareResult,
} from '../application/model-operation-types.js';
import type {
  MaterialBlockedAction,
  MaterialBlockedProblem,
  MaterialBlockedReason,
} from '../application/material-preflight.js';

/**
 * Why one problem's material cannot be analysed, and the entry point that can fix it.
 *
 * The vocabulary is the application's own, re-exported so the page and the host cannot drift apart:
 * adding a reason without giving it Chinese wording is impossible, because
 * {@link MATERIAL_BLOCKED_REASON_TEXT} is checked against every member by the page's own tests.
 */
export type { MaterialBlockedAction, MaterialBlockedProblem, MaterialBlockedReason };

/** The transport code of a start that the stored batch's own material refuses. */
export const MATERIALS_BLOCKED_CODE = 'materials_blocked';

/** Every blocked reason the host can report, in the contract's order. */
export const MATERIAL_BLOCKED_REASONS: readonly MaterialBlockedReason[] = [
  'material_missing',
  'snapshot_unreadable',
  'editorial_unknown',
  'editorial_empty',
  'source_unavailable',
  'missing_statement',
];

/** Every blocked action the host can ask for. */
export const MATERIAL_BLOCKED_ACTIONS: readonly MaterialBlockedAction[] = [
  'refresh_materials',
  'supplement_editorial',
  'supplement_statement',
];

/**
 * Chinese explanation of every blocked reason.
 *
 * Each sentence states the same three facts: what was found, what to do, and that nothing was
 * created and no model will be called. None of them claims a platform editorial exists, and none of
 * them turns an unknown editorial state into "there is no editorial".
 */
export const MATERIAL_BLOCKED_REASON_TEXT: Readonly<Record<MaterialBlockedReason, string>> = {
  material_missing:
    '尚未创建材料快照。请先打开题目并刷新或手工补充材料；未建立任务，也不会调用模型。',
  snapshot_unreadable:
    '当前材料快照无法读取。请重新刷新材料并免费准备新批次；未建立任务，也不会调用模型。',
  editorial_unknown:
    '当前快照没有任何题解来源记录，无法判断题解是否存在。请刷新平台材料，或手工补充题解/用户提供的答案；未建立任务，也不会调用模型。',
  editorial_empty:
    '已经记录找到题解，但没有可供分析的题解正文。请手工补充题解或用户提供的答案；未建立任务，也不会调用模型。',
  source_unavailable:
    '题解来源读取失败、需要登录、受到限流或页面结构发生变化，不能据此认定没有题解。请刷新或手工补充材料；未建立任务，也不会调用模型。',
  missing_statement:
    '已经明确没有题解，但题面为空，无法进行题面推理。请先补充题面；未建立任务，也不会调用模型。',
};

/** Explanation of the refusal a stored batch's own material produces. */
export const MATERIALS_BLOCKED_TEXT =
  '该旧批次引用的材料不能分析。请刷新或补充题目材料，然后重新免费准备批次。旧批次不会产生新的模型调用。';

/** Button label of each blocked action; every one of them is free and calls no model. */
export const MATERIAL_ACTION_TEXT: Readonly<Record<MaterialBlockedAction, string>> = {
  refresh_materials: '刷新平台材料（不调用 AI）',
  supplement_editorial: '补充题解或用户提供的答案（不调用 AI）',
  supplement_statement: '补充题面（不调用 AI）',
};

/** What a batch's start/resume state is, and why it is not startable. */
export interface BatchStartState {
  readonly canStart: boolean;
  readonly canResume: boolean;
  /** Blocked reason codes of the batch's own material, in batch order; empty when nothing blocks. */
  readonly materialReasons: readonly string[];
  /** `true` while the batch holds its own material blocker and must be replaced, not continued. */
  readonly needsNewBatch: boolean;
}

/** The batch's own read-only material preflight; an old answer without the field has no blocks. */
export function materialBlocksOf(
  batch: { readonly materialBlocks?: readonly ModelBatchBlockedProblemView[] } | null | undefined,
): readonly ModelBatchBlockedProblemView[] {
  return batch?.materialBlocks ?? [];
}

/**
 * One Chinese sentence for a reason code, falling back to the generic materials-blocked text.
 *
 * The fallback is a real explanation rather than an empty string, so an unknown code from a newer
 * host can never render as a blank instruction.
 */
export function materialBlockedText(reason: string): string {
  const entry = (MATERIAL_BLOCKED_REASON_TEXT as Readonly<Record<string, string | undefined>>)[reason];
  return entry ?? MATERIALS_BLOCKED_TEXT;
}

/** Button label of one action code; an unknown action falls back to the generic refresh wording. */
export function materialActionText(action: string): string {
  const entry = (MATERIAL_ACTION_TEXT as Readonly<Record<string, string | undefined>>)[action];
  return entry ?? MATERIAL_ACTION_TEXT.refresh_materials;
}

/**
 * Whether a stored batch may be started or continued.
 *
 * `materialBlocks` is the batch's own immutable-snapshot preflight: while it is non-empty the
 * batch must be replaced rather than continued, and neither the start nor the resume button may be
 * offered as a way forward. A batch that is missing, running live or already terminal is not
 * startable either, and those three reasons stay distinguishable from a material block.
 */
export function batchStartState(
  batch: {
    readonly status: string;
    readonly materialBlocks?: readonly ModelBatchBlockedProblemView[];
  } | null | undefined,
  live: boolean,
): BatchStartState {
  const reasons = materialBlocksOf(batch).map((entry) => entry.reason);
  if (batch === null || batch === undefined) {
    return { canStart: false, canResume: false, materialReasons: reasons, needsNewBatch: reasons.length > 0 };
  }
  const terminal = batch.status === 'completed' || batch.status === 'cancelled';
  const startable = !live && !terminal && reasons.length === 0;
  return {
    canStart: startable && batch.status === 'pending',
    canResume: startable && (batch.status === 'paused' || batch.status === 'failed'),
    materialReasons: reasons,
    needsNewBatch: reasons.length > 0,
  };
}

/** Whether a freshly prepared answer produced a batch that may be started at all. */
export function preparedStartState(prepared: ModelBatchPrepareResult | null | undefined): BatchStartState {
  if (prepared === null || prepared === undefined || prepared.batchId === null || prepared.jobs.length === 0) {
    return { canStart: false, canResume: false, materialReasons: [], needsNewBatch: false };
  }
  return { canStart: true, canResume: false, materialReasons: [], needsNewBatch: false };
}

/** One line of the free-preparation summary, with the four disjoint problem counts. */
export interface PrepareSummary {
  /** Jobs this preparation really created; only these can ever dispatch a paid call. */
  readonly runnableJobs: number;
  /** Problems whose stored success already carries the current completeness check. */
  readonly alreadyDone: number;
  /** Finished jobs this preparation superseded with a fresh run identity. */
  readonly reruns: number;
  /** Problems left out because their current material is not runnable. */
  readonly blocked: number;
  readonly ready: number;
  readonly absent: number;
  readonly error: number;
  readonly analysisCalls: number;
  readonly reasoningCalls: number;
  /** `true` when nothing runnable was prepared, so the user must not expect a batch or a cost. */
  readonly empty: boolean;
}

/** Project one prepare answer onto the numbers the page shows; never a title, key or excerpt. */
export function prepareSummary(prepared: ModelBatchPrepareResult): PrepareSummary {
  return {
    runnableJobs: prepared.jobs.length,
    alreadyDone: prepared.alreadyDone.length,
    reruns: prepared.reruns.length,
    blocked: prepared.blocked.length,
    ready: prepared.availability.ready,
    absent: prepared.availability.absent,
    error: prepared.availability.error,
    analysisCalls: prepared.upperBoundCalls.analysisCalls,
    reasoningCalls: prepared.upperBoundCalls.reasoningCalls,
    empty: prepared.batchId === null || prepared.jobs.length === 0,
  };
}

/** The sentence shown when a preparation produced no runnable batch. */
export const NO_RUNNABLE_BATCH_TEXT = '未创建可运行批次，不会产生费用。';

/**
 * The sentence shown while a stored batch keeps its own material blocker.
 *
 * It never offers "continue this batch": refreshing material writes a new snapshot, so the stored
 * batch keeps exactly the material it already captured.
 */
export const MATERIAL_BLOCKS_NOTICE_TEXT =
  '该批次引用的材料不能分析。请刷新或补充题目材料，然后重新免费准备批次；旧批次不会产生新的模型调用，也不能被原地修复。';

/** What the recovery button does, and what it explicitly does not do. */
export const RECOVER_HINT_TEXT = '恢复中断状态只处理过期的租约与中断的任务，不会刷新、补充或修复任何材料。';

/** Where the blocked-problem action leads: the problem detail's refresh/supplement area. */
export const MATERIAL_ACTION_HINT_TEXT = '操作按钮会打开该题详情，请在「刷新或补充材料」区域处理后重新免费准备批次。';

/** Wording of a blocked count, so it is never read as part of the new workload. */
export function blockedCountText(count: number): string {
  return `材料待处理 ${count}（未建立任务，不占用调用上限）`;
}

/**
 * Keep the platform's own error code out of the primary text.
 *
 * The raw code (including a refused start's `materials_blocked`) belongs in the collapsible
 * diagnostic area, so the page never shows an unexplained English identifier as its main message.
 */
export function diagnosticText(code: string): string {
  return `诊断信息（原始错误码）：${code}`;
}

/**
 * The stable code of a failed request, or `null` when the failure carries none.
 *
 * It exists so the page can recognise a refused start (`materials_blocked`) and render the Chinese
 * explanation, while the raw identifier itself stays confined to the diagnostic area.
 */
export function failureCodeOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** One blocked row of the batch detail, ready to render. */
export interface BlockedRow {
  readonly problemKey: string;
  readonly reason: MaterialBlockedReason;
  readonly action: MaterialBlockedAction;
  readonly text: string;
  readonly actionText: string;
}

/** Project the read-only material preflight of a batch detail onto renderable rows. */
export function blockedRows(detail: ModelBatchDetailResult | null | undefined): readonly BlockedRow[] {
  return materialBlocksOf(detail?.batch).map((entry) => ({
    problemKey: entry.problemKey,
    reason: entry.reason,
    action: entry.action,
    text: materialBlockedText(entry.reason),
    actionText: materialActionText(entry.action),
  }));
}

/** The short problem label the page shows: the external key of a canonical problem key. */
export function problemLabel(problemKey: string): string {
  return problemKey.split('||').at(-1) ?? problemKey;
}
