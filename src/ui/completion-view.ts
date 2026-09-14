/**
 * Pure view rules for per-problem and bulk completion editing (Sprint Contract 23b).
 *
 * Every decision the completion UI renders or sends lives here: mode labels, the honest `未标注`
 * reading of a missing record, the bounded page-selection union and its whole-page tri-state toggle,
 * the readiness of page-derived actions, draft validation, the explicit knowledge intent, preview
 * freshness and the redaction-safe retrospective form state. The module
 * imports no React and performs no IO, so the rules are exercised directly by focused tests.
 *
 * It never promotes a platform label, raw tag or AI suggestion: the only knowledge source is the
 * taxonomy ids the user checked, applied as a union to every selected problem.
 */
import type {
  RetrospectiveEditApplyRequest,
  RetrospectiveEditListEntry,
  RetrospectiveEditPreviewResult,
  RetrospectiveEditRequest,
  RetrospectiveKnowledgeIntent,
} from '../application/retrospective-edit.js';
import type { WorkbenchProblemDetail } from '../application/workbench-types.js';
import type { CompletionMode } from '../domain/retrospective.js';

/** Shown whenever a problem of the selected account has no completion record at all. */
export const UNRECORDED_MODE_LABEL = '未标注';

/** Canonical completion modes, in the order the editor offers them. */
export const COMPLETION_MODE_ORDER: readonly CompletionMode[] = ['independent', 'assisted', 'solution_used'];

/**
 * Display labels.
 *
 * They say what the user recorded, not what the platform's AC verdict proves: an accepted
 * submission without a record stays {@link UNRECORDED_MODE_LABEL}.
 */
export const COMPLETION_MODE_LABELS: Readonly<Record<CompletionMode, string>> = {
  independent: '独立完成',
  assisted: '使用提示完成',
  solution_used: '参考题解完成',
};

/** Human text of one stored mode; a missing record is `未标注`, never an implicit default. */
export function completionModeText(mode: CompletionMode | null | undefined): string {
  return mode === null || mode === undefined ? UNRECORDED_MODE_LABEL : COMPLETION_MODE_LABELS[mode];
}

/** Parse one select value; the empty placeholder stays `null` (no default mode is invented). */
export function parseCompletionMode(value: string): CompletionMode | null {
  return COMPLETION_MODE_ORDER.find((mode) => mode === value) ?? null;
}

/** Key bound shared with `retro.list`, `retro.editPreview` and `retro.editApply`. */
export const MAX_COMPLETION_EDIT_KEYS = 100;

/** Result of unioning one page into the existing selection under the 100-problem bound. */
export interface PageSelectionOutcome {
  /** The complete new selection: the previous keys first, then the page keys that fit. */
  readonly keys: readonly string[];
  /** How many page keys were newly added. */
  readonly added: number;
  /** How many page keys did not fit because the bound was already full; never silently dropped. */
  readonly skipped: number;
}

/**
 * Union the visible page into the selection without ever exceeding the API bound.
 *
 * The previous selection is kept whole and in order; page keys already present count as neither
 * added nor skipped. When the bound is full every further page key is counted in `skipped`, so the
 * caller can state exactly how many visible rows were *not* selected instead of dropping them.
 */
export function unionPageSelection(
  selected: readonly string[],
  page: readonly string[],
  bound: number = MAX_COMPLETION_EDIT_KEYS,
): PageSelectionOutcome {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of selected) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  let added = 0;
  let skipped = 0;
  for (const key of page) {
    if (seen.has(key)) {
      continue;
    }
    if (keys.length >= bound) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    keys.push(key);
    added += 1;
  }
  return { keys, added, skipped };
}

/** Honest truncation notice; `null` means the whole page fitted. */
export function pageSelectionNotice(
  outcome: PageSelectionOutcome,
  bound: number = MAX_COMPLETION_EDIT_KEYS,
): string | null {
  if (outcome.skipped === 0) {
    return null;
  }
  return `已达 ${bound} 题上限：本页另有 ${outcome.skipped} 题未加入选择，请先取消部分已选题目再重试。`;
}

/**
 * One derivable fact about one explicit list of row keys (the confirmed current page).
 *
 * `ariaChecked` is the exact attribute value a native checkbox must carry: `true`/`false` plus the
 * `'mixed'` third state, which {@link pageSelectAllCheckbox} derives from the same tri-state.
 */
export interface PageSelectionSession {
  readonly all: boolean;
  readonly some: boolean;
  readonly ariaChecked: 'true' | 'false' | 'mixed';
  readonly unchecked: boolean;
  readonly selectedCount: number;
  readonly totalCount: number;
}

/** The tri-state of one explicit key list; the one source of truth for row, header and counters. */
export function pageSelectionSession(
  selected: readonly string[],
  page: readonly string[],
): PageSelectionSession {
  const chosen = new Set(selected);
  const selectedCount = page.filter((key) => chosen.has(key)).length;
  const totalCount = page.length;
  const all = totalCount > 0 && selectedCount === totalCount;
  const some = selectedCount > 0 && !all;
  return {
    all,
    some,
    ariaChecked: all ? 'true' : some ? 'mixed' : 'false',
    unchecked: selectedCount === 0,
    selectedCount,
    totalCount,
  };
}

/** Honest accessible name of the header checkbox: it says what one click will actually do. */
export function pageSelectAllLabel(session: PageSelectionSession): string {
  if (session.totalCount === 0) {
    return '全选本页题目（当前页没有题目）';
  }
  if (session.all) {
    return `取消选择本页 ${session.totalCount} 题（不影响其他页已选）`;
  }
  return `全选本页题目（本页已选 ${session.selectedCount} / ${session.totalCount}）`;
}

/** The current page minus the selected keys, in page order; other pages are never in the answer. */
export function removePageSelection(
  selected: readonly string[],
  page: readonly string[],
  bound: number = MAX_COMPLETION_EDIT_KEYS,
): readonly string[] {
  const dropped = new Set(page);
  return selected.filter((key) => !dropped.has(key)).slice(0, bound);
}

/** The next selection after clicking 全选本页题目: remove the part of the page that is selected. */
export interface PageToggleOutcome {
  readonly keys: readonly string[];
  /** True when the click unchecked the fully selected page instead of adding to the selection. */
  readonly removed: boolean;
  readonly added: number;
  readonly skipped: number;
}

/**
 * Toggle one whole page: a fully selected page is removed from the selection on its own, while any
 * other state unions the page under the bound and reports the rows that did not fit.
 */
export function togglePageSelection(
  selected: readonly string[],
  page: readonly string[],
  bound: number = MAX_COMPLETION_EDIT_KEYS,
): PageToggleOutcome {
  const session = pageSelectionSession(selected, page);
  if (session.all) {
    return { keys: removePageSelection(selected, page, bound), removed: true, added: 0, skipped: 0 };
  }
  const outcome = unionPageSelection(selected, page, bound);
  return { keys: outcome.keys, removed: false, added: outcome.added, skipped: outcome.skipped };
}

/**
 * Every honest reason a page-derived selection action cannot run right now.
 *
 * An empty answer means "ready": a confirmed, non-pending, error-free browse answer backed by a
 * confirmed completion list. Nothing here falls back to old page or mode data during a refresh or a
 * page switch, and a failed completion read never lets `选择本页未标注` guess.
 */
export function pageSelectionBlockers(
  pageReady: boolean,
  pageCount: number,
  modesReady: boolean,
): readonly string[] {
  const blockers: string[] = [];
  if (pageReady && pageCount === 0) {
    blockers.push('当前页没有可选择的题目。');
  }
  if (!pageReady) {
    blockers.push('当前页题目尚未就绪，暂不能更改本页选择。');
  }
  if (pageReady && pageCount > 0 && !modesReady) {
    blockers.push('完成方式读取中或读取失败：暂不能选择“未标注”题目，可先重试读取完成方式。');
  }
  return blockers;
}

/**
 * The disabled state of every page-selection surface, derived from the confirmed reads.
 *
 * `page` covers the header checkbox, the row checkboxes and `全选本页`/`取消本页`: all of them act on
 * the current page and need a confirmed, settled `problem.browse` answer. `unrecorded` additionally
 * needs a confirmed, settled completion list with at least one missing record. `selection` covers the
 * actions over the whole cross-page selection and does not depend on the current page.
 *
 * `useRequest` keeps the previous same-key answer while a refresh is in flight, so `pageReady` and
 * `modesReady` (which test `pending`) must be passed in rather than derived from `data !== null`.
 */
export interface PageSelectionGates {
  readonly page: boolean;
  readonly unrecorded: boolean;
  readonly selection: boolean;
}

/** The one source of truth for the disabled state of the selection controls. */
export function pageSelectionGates(
  pageReady: boolean,
  modesReady: boolean,
  session: PageSelectionSession,
  selectedTotal: number,
  unrecordedCount: number,
): PageSelectionGates {
  return {
    page: pageReady && session.totalCount > 0,
    unrecorded: pageReady && modesReady && unrecordedCount > 0,
    selection: selectedTotal > 0,
  };
}

/** Problem keys of the current page whose latest record is missing (`mode === null`). */
export function unrecordedProblemKeys(
  items: readonly Pick<RetrospectiveEditListEntry, 'problemKey' | 'mode'>[],
): readonly string[] {
  return items.filter((item) => item.mode === null).map((item) => item.problemKey);
}

/** The draft the editor form holds; mode starts as `null` until the user explicitly picks one. */
export interface CompletionDraft {
  readonly mode: CompletionMode | null;
  readonly addKnowledge: boolean;
  readonly taxonomyIds: readonly string[];
}

/** Why the draft cannot be previewed/applied yet, or `null` when it is complete. */
export function completionDraftProblem(draft: CompletionDraft): string | null {
  if (draft.mode === null) {
    return '请选择完成方式：没有记录时不会默认按“独立完成”记录。';
  }
  if (draft.addKnowledge && draft.taxonomyIds.length === 0) {
    return '已勾选补充知识点：请至少选择一个要补充的知识点，或取消勾选。';
  }
  return null;
}

/** The exact, normalized intent one draft produces; `null` when the draft is incomplete. */
export interface CompletionIntent {
  readonly mode: CompletionMode;
  readonly knowledge: RetrospectiveKnowledgeIntent;
}

/**
 * Normalize a complete draft into one intent.
 *
 * Knowledge is sent only as `add` with a non-empty, deduplicated list; an unchecked box means
 * `preserve` and never an empty `add`.
 */
export function completionIntentOf(draft: CompletionDraft): CompletionIntent | null {
  if (draft.mode === null) {
    return null;
  }
  const taxonomyIds = [...new Set(draft.taxonomyIds)];
  if (draft.addKnowledge && taxonomyIds.length === 0) {
    return null;
  }
  return {
    mode: draft.mode,
    knowledge: draft.addKnowledge ? { kind: 'add', taxonomyIds } : { kind: 'preserve' },
  };
}

/** Stable identity of one intent; a changed mode or knowledge list changes the key. */
export function completionIntentKey(intent: CompletionIntent): string {
  const knowledge =
    intent.knowledge.kind === 'add'
      ? { kind: 'add', taxonomyIds: [...intent.knowledge.taxonomyIds].sort() }
      : { kind: 'preserve' };
  return JSON.stringify({ mode: intent.mode, knowledge });
}

/**
 * Request fields of one edit.
 *
 * `knowledge` is omitted entirely for `preserve` (the API default): an unchecked "补充知识点" box
 * can never submit an empty `add` that would look like a requested replacement.
 */
export function completionEditFields(
  accountId: string,
  problemKeys: readonly string[],
  intent: CompletionIntent,
): RetrospectiveEditRequest {
  return {
    accountId,
    problemKeys: [...problemKeys],
    mode: intent.mode,
    ...(intent.knowledge.kind === 'add'
      ? { knowledge: { kind: 'add' as const, taxonomyIds: [...intent.knowledge.taxonomyIds] } }
      : {}),
  };
}

/** Apply fields: the intent captured by the preview, bound to the hash the user actually saw. */
export function completionApplyFields(
  accountId: string,
  problemKeys: readonly string[],
  preview: { readonly hash: string; readonly intent: CompletionIntent },
): RetrospectiveEditApplyRequest {
  return { ...completionEditFields(accountId, problemKeys, preview.intent), expectedPreviewHash: preview.hash };
}

/** The stored claim of one preview; a fresh draft is compared against its intent key. */
export interface CompletionPreviewIdentity {
  readonly accountId: string;
  readonly intentKey: string;
}

/**
 * True only while the preview still describes the current account, keys and draft.
 *
 * Any edit to the mode or the knowledge selection changes the intent key, so an old hash can never
 * be applied to a new draft; the account is compared as well so a preview cannot survive a scope
 * change.
 */
export function completionPreviewIsFresh(
  preview: CompletionPreviewIdentity | null,
  accountId: string,
  intent: CompletionIntent | null,
): boolean {
  return (
    preview !== null &&
    intent !== null &&
    preview.accountId === accountId &&
    preview.intentKey === completionIntentKey(intent)
  );
}

/** Honest apply-button label; `null` means there is no fresh preview to apply. */
export function applyButtonText(preview: RetrospectiveEditPreviewResult | null): string | null {
  if (preview === null) {
    return null;
  }
  return preview.changedCount === 0 ? '无变化' : `修改 ${preview.changedCount} 题`;
}

/** Totals one preview must state before anything is written. */
export interface CompletionPreviewTotals {
  readonly changedCount: number;
  readonly unchangedCount: number;
  /** Sum of consulted solution references an independent edit would clear. */
  readonly clearedSolutionTotal: number;
  /** Distinct knowledge points this edit would add to at least one problem. */
  readonly addedSkillCount: number;
  /**
   * Total per-problem additions over all rows.
   *
   * A knowledge point a problem already has is not added again, so this can exceed
   * {@link addedSkillCount}; it is the honest number of writes the preview stands for.
   */
  readonly addedSkillTotal: number;
}

/** Sum the per-row preview into the counts and warnings shown above the apply button. */
export function completionPreviewTotals(preview: RetrospectiveEditPreviewResult): CompletionPreviewTotals {
  const added = new Set<string>();
  let clearedSolutionTotal = 0;
  let addedSkillTotal = 0;
  for (const item of preview.items) {
    clearedSolutionTotal += item.clearedSolutionCount;
    addedSkillTotal += item.addedTaxonomyIds.length;
    for (const id of item.addedTaxonomyIds) {
      added.add(id);
    }
  }
  return {
    changedCount: preview.changedCount,
    unchangedCount: preview.unchangedCount,
    clearedSolutionTotal,
    addedSkillCount: added.size,
    addedSkillTotal,
  };
}

/**
 * True when an error is the compare-and-set conflict that must drop a stale preview.
 *
 * The UI receives the transport's sanitized `conflict` code — the {@link ApiClientError} that
 * `ui/api.ts` throws — because `mapBusinessError` maps the domain's `invalid_transition` onto it.
 * The raw domain code is accepted as well, so the same guard holds for an error that never crossed
 * the transport; every other failure keeps the held preview, which the user can still retry.
 */
export function isCompletionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === 'conflict' || code === 'invalid_transition';
}

/**
 * Guard used before and after every awaited editor call.
 *
 * An aborted signal means the request no longer belongs to the mounted editor (a scope change or an
 * unmount), so its result must not be committed: no preview, no apply and no success banner.
 */
export function completionRequestStillCurrent(signal: { readonly aborted: boolean }): boolean {
  return !signal.aborted;
}

/**
 * The retrospective form state prefilled from the latest record.
 *
 * With no record at all, the form is empty and editable once spoilers are visible (there is nothing
 * to reveal and nothing a save could wipe); the mode keeps the explicit `请选择` placeholder. With a
 * record, the advanced fields are *known* only when spoilers are visible and the response really
 * carried all three own properties — `taxonomyIds`, `solutionIds` and `note`. One withheld property
 * makes the whole advanced state unknown, so a half-visible record is never rendered as a
 * half-editable form: an absent field is never turned into an empty array or an empty note that a
 * save could write back as a wipe. A genuinely empty record (all three present, empty values) stays
 * editable and is distinguishable from a withheld one.
 */
export interface RetrospectiveFormState {
  readonly retrospectiveId: string | null;
  readonly mode: CompletionMode | null;
  readonly taxonomyIds: readonly string[];
  readonly solutionIds: readonly string[];
  readonly note: string;
  readonly advancedKnown: boolean;
}

/** Read one problem's latest record into form state, preserving the withheld/empty distinction. */
export function retrospectiveFormState(problem: WorkbenchProblemDetail): RetrospectiveFormState {
  const latest = problem.latestRetrospective;
  if (latest === null) {
    return {
      retrospectiveId: null,
      // No record keeps the explicit `请选择` placeholder instead of defaulting to independent.
      mode: null,
      taxonomyIds: [],
      solutionIds: [],
      note: '',
      advancedKnown: problem.spoilersVisible,
    };
  }
  const advancedKnown =
    problem.spoilersVisible &&
    Object.hasOwn(latest, 'taxonomyIds') &&
    Object.hasOwn(latest, 'solutionIds') &&
    Object.hasOwn(latest, 'note');
  return {
    retrospectiveId: latest.retrospectiveId,
    // `null` is the explicit `请选择` placeholder; an existing mode is only a prefill, never a default.
    mode: latest.mode ?? null,
    taxonomyIds: advancedKnown ? [...(latest.taxonomyIds ?? [])] : [],
    solutionIds: advancedKnown ? [...(latest.solutionIds ?? [])] : [],
    note: advancedKnown ? latest.note ?? '' : '',
    advancedKnown,
  };
}

/**
 * Reset key of the advanced form: problem, account and latest record id.
 *
 * The form is prefilled again when any of the three moves, and is left alone by unrelated parent
 * renders (a banner, a reveal or a sibling state change) so a draft is never silently discarded.
 */
export function retrospectiveFormKey(
  problemKey: string,
  accountId: string | null,
  retrospectiveId: string | null,
): string {
  return `${problemKey}|${accountId ?? ''}|${retrospectiveId ?? ''}`;
}

/** Minimal structural shape of one canonical taxonomy node the knowledge picker needs. */
export interface KnowledgeNode {
  readonly id: string;
  readonly kind: string;
  readonly names: { readonly zh: string };
}

/** Non-category taxonomy nodes matching a free-text query over id and Chinese name. */
export function knowledgeOptions<T extends KnowledgeNode>(nodes: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLocaleLowerCase();
  return nodes.filter(
    (node) =>
      node.kind !== 'category' &&
      (needle.length === 0 ||
        node.id.toLocaleLowerCase().includes(needle) ||
        node.names.zh.toLocaleLowerCase().includes(needle)),
  );
}

/** Display names of the chosen ids, in selection order; an unknown id stays visible as itself. */
export function knowledgeNames(ids: readonly string[], nodes: readonly KnowledgeNode[]): readonly string[] {
  return ids.map((id) => nodes.find((node) => node.id === id)?.names.zh ?? id);
}

/** The explicit statement that every chosen point is applied to every selected problem. */
export function knowledgeApplySummary(
  problemCount: number,
  ids: readonly string[],
  nodes: readonly KnowledgeNode[],
): string {
  if (ids.length === 0) {
    return '尚未选择知识点。';
  }
  return `将对选中的 ${problemCount} 道题各补充 ${ids.length} 个知识点：${knowledgeNames(ids, nodes).join('、')}。`;
}

/** Honest account/scope statement shown above the editor. */
export const COMPLETION_SCOPE_NOTE =
  '这里只写入当前账号选中的题目本身：不会跨账号或跨来源写入，也不会同步到合并题库里的镜像题。';

/** Preservation statement: knowledge additions are a union; note and old skills stay. */
export const COMPLETION_PRESERVE_NOTE =
  '默认保留每道题原有的备注与已确认知识点；勾选补充只是把所选知识点加入每道题的已有知识点（并集），不会删除或替换。';

/** Warning that an independent edit clears consulted solution references, counted in the preview. */
export const COMPLETION_INDEPENDENT_NOTE =
  '选择“独立完成”只会清除已咨询题解引用，清除数量会在预览中逐题列出；不会改动通过（AC）记录。';

/** The one durable claim about AC and the completion record. */
export const COMPLETION_AC_NOTE =
  '通过（AC）记录不会被修改：完成方式只来自人工记录，没有记录一律显示“未标注”。';

/** Success notice: latest local statistics move; frozen AI reports do not. */
export const COMPLETION_EDIT_NOTICE =
  '完成方式已更新，本地知识点统计与规则能力评估采用最新记录；历史 AI 报告保留生成时结果，如需更新请重新准备并生成评估。';

/** Conflict copy for a preview whose records moved before the write. */
export const COMPLETION_STALE_PREVIEW_NOTE =
  '预览已过期：题目记录在预览之后发生了变化，未写入任何内容。请重新预览并确认后再修改。';

/** Copy shown as soon as the draft no longer matches the preview the user saw. */
export const COMPLETION_DRAFT_INVALIDATED_NOTE =
  '草稿已改变，之前的预览已失效；请重新预览后再修改（旧预览不会被应用）。';

/** Reveal instruction for the advanced retrospective form while spoilers are withheld. */
export const COMPLETION_PREFILL_HIDDEN_NOTE =
  '算法标签、参考题解与备注属于题解内容，默认隐藏；显示后才能编辑完整复盘，上面的“修改完成方式”不受影响。';
