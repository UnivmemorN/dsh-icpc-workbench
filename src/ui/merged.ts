/**
 * Pure display rules of the merged cross-site bank (Sprint Contract 08c).
 *
 * The merged view has to answer questions the single-platform bank never had: which member of a
 * group the backend sorted the group by, which stored accounts participate per source, and how a
 * solved banner is phrased so a linked cross-site solve can never be read as this platform's own
 * verdict. All of that is ordering and string logic over already-projected DTOs, so it lives here
 * and is tested without a DOM; `MergedBank.tsx`/`Bank.tsx`/`Problem.tsx` own only the React wiring.
 *
 * Nothing here calls the API, invents a solved state, fills a missing value or normalizes a raw
 * platform difficulty: an absent value stays absent and a missing account stays missing.
 */
import type { Account, SourceInstance } from '../domain/index.js';
import type {
  WorkbenchAcceptedEvidenceView,
  WorkbenchProblemSummary,
} from '../application/workbench-types.js';

/** Solved-state choices of the merged view; the state filters are relative to the selected accounts. */
export type MergedSolvedFilter = 'all' | 'solved' | 'unconfirmed';

/**
 * Ordering choices of the merged view, matching the sort names `problem.mergedBrowse` accepts.
 *
 * The merged view opens on `problem_asc` (natural 题号 order, so `2A` is before `10A`) exactly like
 * the single-platform bank; there is no `default` (canonical key) choice here.
 */
export type MergedSort =
  | 'problem_asc'
  | 'problem_desc'
  | 'title_asc'
  | 'title_desc'
  | 'difficulty_asc'
  | 'difficulty_desc';

/** Solved-state choices in display order. */
export const MERGED_STATUS_OPTIONS: readonly (readonly [MergedSolvedFilter, string])[] = [
  ['all', '全部'],
  ['solved', '已通过'],
  ['unconfirmed', '未确认通过'],
];

/** Ordering choices in display order; both difficulty orders need a concrete source instance. */
export const MERGED_SORT_OPTIONS: readonly (readonly [MergedSort, string])[] = [
  ['problem_asc', '题号升序'],
  ['problem_desc', '题号降序'],
  ['title_asc', '题目名称升序'],
  ['title_desc', '题目名称降序'],
  ['difficulty_asc', '难度从低到高'],
  ['difficulty_desc', '难度从高到低'],
];

/** Page sizes the merged view offers; the API accepts any size within 1..100. */
export const MERGED_PAGE_SIZES = [25, 50, 100] as const;

/** The sort requested when the user has not chosen one. */
export const DEFAULT_MERGED_SORT: MergedSort = 'problem_asc';

/** Longest difficulty-dimension name the API accepts; keeps the field inside its 1..100 bound. */
export const MAX_MERGED_DIMENSION_CHARS = 100;

/** Dimension offered for a source whose platform publishes no known rating label. */
export const MERGED_FALLBACK_DIMENSION = 'difficulty';

/** Inline refusals; an invalid draft keeps the previous committed dimension in effect. */
export const MERGED_DIMENSION_BLANK_WARNING = '难度维度不能为空，已保留上一个维度。';
export const MERGED_DIMENSION_TOO_LONG_WARNING = `难度维度最多 ${MAX_MERGED_DIMENSION_CHARS} 个字符，已保留上一个维度。`;

/** Explains, beside a difficulty order, why it needs one source and where unknown values land. */
export const MERGED_DIFFICULTY_HINT =
  '不同平台的难度不可直接比较：难度排序需要先在“来源”里选择一个具体平台，并且只比较该平台的原始难度维度；没有该维度、空值或非数值的题目在升序和降序中都排在最后。';

/** Shown beside a source that has no stored account. */
export const NO_ACCOUNT_FOR_SOURCE = '尚未添加账号，可到「账号与同步」添加';

/** The one account-per-source option that means "this platform contributes nothing". */
export const NOT_PARTICIPATING = '不参与统计';

/** Why status filtering is unavailable without a selected account. */
export const MERGED_STATUS_HINT = '未选择统计账号：通过状态无法判断，请先在上方为至少一个平台选择账号。';

/** The default account scope, stated before any per-source selector. */
export const MERGED_ACCOUNT_SCOPE_NOTE =
  '选择各站自己的账号；默认只勾选顶部当前账号，其他平台需单独选择。';

/** What a selected account actually contributes. */
export const MERGED_ACCOUNT_EFFECT_NOTE =
  '所选账号在这些平台上的真实通过提交会被合并到同一道题上；未选择的平台仍显示“不参与统计”。';

/** The honest boundary of the combined verdict. */
export const MERGED_VIEW_NOTE =
  '合并通过状态只是本地的训练视图：原始提交记录、平台判定和各账号的正式统计仍按平台分别保留。';

/** Why the platform-only actions live behind their own button. */
export const MERGED_IMPORT_BACK_NOTE =
  '导入、同步、标签审核和训练计划都按具体平台的账号执行，所以它们回到原平台题库：先切换顶部账号，再在对应平台执行。';

/** What the merged view never does while the user navigates it. */
export const MERGED_READONLY_NOTE =
  '合并视图只读：浏览、筛选和展开详情都不会触发同步、创建账号、付费生成或写入复习记录。';

/** One source instance together with the stored accounts that may represent it. */
export interface SourceAccountOptions {
  readonly source: SourceInstance;
  readonly accounts: readonly Account[];
}

/** Raw rating dimension a known platform publishes; `null` means the user must name one. */
export function platformRatingDimension(platform: string): string | null {
  if (platform === 'codeforces') {
    return 'rating';
  }
  if (platform === 'luogu') {
    return 'difficulty';
  }
  return null;
}

/** User-facing platform name of one source: the two official platforms keep their own label. */
export function platformLabelOf(source: { readonly platform: string; readonly displayName: string }): string {
  if (source.platform === 'codeforces') {
    return 'Codeforces';
  }
  if (source.platform === 'luogu') {
    return '洛谷';
  }
  return source.displayName;
}

/** Label of one source instance, or an explicit fallback that never pretends to know it. */
export function sourceLabelOf(sourceInstanceId: string, sources: readonly SourceInstance[]): string {
  return sources.find((entry) => entry.id === sourceInstanceId)?.displayName ?? `未知来源（${sourceInstanceId}）`;
}

/** Label of one account option: platform label first, then the stored handle or display name. */
export function accountOptionText(
  account: Account,
  source: { readonly platform: string; readonly displayName: string },
): string {
  return platformLabelOf(source) + ' · ' + (account.displayName ?? account.handle);
}

/** Label of one account id for evidence lines; an unknown id is named as unknown, never guessed. */
export function accountLabelOf(
  accountId: string,
  accounts: readonly Account[],
  sources: readonly SourceInstance[],
): string {
  const account = accounts.find((entry) => entry.id === accountId);
  if (account === undefined) {
    return `未知账号（${accountId}）`;
  }
  const source = sources.find((entry) => entry.id === account.sourceInstanceId);
  return accountOptionText(account, source ?? { platform: '', displayName: account.sourceInstanceId });
}

/**
 * The stored accounts of every source, in source order and then handle order.
 *
 * Every source is listed even when it has no account, so the caller can render the explicit
 * `尚未添加账号` state instead of hiding the platform. The handle order is a plain code-unit
 * comparison with the stable id as tie-break: it is locale-independent, so the same stored accounts
 * always produce the same option order.
 */
export function sourceAccountOptions(
  sources: readonly SourceInstance[],
  accounts: readonly Account[],
): readonly SourceAccountOptions[] {
  return sources.map((source) => ({
    source,
    accounts: accounts
      .filter((account) => account.sourceInstanceId === source.id)
      .sort((left, right) =>
        left.handle === right.handle
          ? compareText(left.id, right.id)
          : compareText(left.handle, right.handle),
      ),
  }));
}

/**
 * The selected account of one source, or `''` when that platform does not participate.
 *
 * A selected id that no stored account explains cannot be attributed to a source, so it is never
 * reported as this source's account.
 */
export function selectedAccountOfSource(
  selected: readonly string[],
  accounts: readonly Account[],
  sourceInstanceId: string,
): string {
  for (const accountId of selected) {
    if (accounts.some((account) => account.id === accountId && account.sourceInstanceId === sourceInstanceId)) {
      return accountId;
    }
  }
  return '';
}

/**
 * Replace one source's selected account, keeping every other source's selection.
 *
 * A selection holds at most one account per source instance (a second one would double-count one
 * person on one platform, which the API refuses). `null` clears this source's account and leaves the
 * rest untouched. A selected id that no stored account explains is kept: the merged read refuses an
 * unknown id, and dropping it here would silently change the meaning of the query instead.
 */
export function setSourceAccount(
  selected: readonly string[],
  accounts: readonly Account[],
  sourceInstanceId: string,
  accountId: string | null,
): readonly string[] {
  const sourceOf = new Map(accounts.map((account) => [account.id, account.sourceInstanceId]));
  const next: string[] = [];
  for (const id of selected) {
    if (sourceOf.get(id) === sourceInstanceId || next.includes(id)) {
      continue;
    }
    next.push(id);
  }
  if (accountId !== null && sourceOf.get(accountId) === sourceInstanceId) {
    next.push(accountId);
  }
  return next;
}

/** One member shape the member ordering needs: its canonical key and its own source instance. */
export interface MergedMemberLike {
  readonly problem: { readonly problemKey: string; readonly sourceInstanceId: string };
  readonly accountId: string | null;
}

/**
 * A group's members in the order the merged read sorted the group by.
 *
 * The backend compares ONE deterministic display member per group in both ID and title sort
 * directions: the member of the requested source instance when a source filter is present, otherwise
 * the member with the lexicographically least canonical problem key (naturally the Codeforces
 * spelling of a recognized pair). Rendering the members in that same order is what makes the leading
 * visible ID/title agree with the requested sort, and every member keeps its own identity — no
 * member is dropped, renamed or merged into another row.
 */
export function memberOrder<M extends MergedMemberLike>(
  members: readonly M[],
  sourceInstanceId: string | null,
): readonly M[] {
  const rank = (member: M): number =>
    sourceInstanceId !== null && member.problem.sourceInstanceId === sourceInstanceId ? 0 : 1;
  return [...members].sort(
    (left, right) =>
      rank(left) - rank(right) || compareText(left.problem.problemKey, right.problem.problemKey),
  );
}

/** The leading member of one group, or `null` for a group the store returned without members. */
export function leadingMember<M extends MergedMemberLike>(
  members: readonly M[],
  sourceInstanceId: string | null,
): M | null {
  return memberOrder(members, sourceInstanceId)[0] ?? null;
}

/** The group-level solved banner; it names the selected accounts as the reason it exists. */
export function mergedSolvedText(selectedAccountCount: number, solved: boolean): string {
  if (solved) {
    return '已通过';
  }
  return selectedAccountCount === 0 ? '未选择统计账号' : '所选账号未确认通过';
}

/**
 * The native (single-platform) solved wording of one problem detail.
 *
 * It says `本平台` explicitly so a linked cross-site solved banner can never contradict it, and an
 * absent account is named instead of being reported as an unconfirmed failure.
 */
export function nativeSolvedText(solvedByAccount: boolean, accountId: string | null): string {
  if (solvedByAccount) {
    return '本平台已通过';
  }
  return accountId === null ? '未选择本平台账号' : '本平台尚未确认通过';
}

/** How one member's own state relates to the group's combined banner. */
export function memberBadgeText(solvedByAccount: boolean, groupSolved: boolean): string {
  if (solvedByAccount) {
    return '本平台已通过';
  }
  return groupSolved ? '关联题目已通过' : '本平台状态未知';
}

/**
 * How one group was formed, in plain language.
 *
 * A recognized group that holds only one local record says `按 CF 原题编号关联` and therefore never
 * implies that a second local row exists; an unrecognized reference is stated as what it is.
 */
export function mappingText(mappingKind: string, memberCount: number): string {
  if (mappingKind === 'single') {
    return '未识别到跨站对应：按原题号独立成组。';
  }
  return memberCount <= 1
    ? '按 CF 原题编号关联（另一平台暂无本地记录）'
    : '按 CF 原题编号关联（两站各有一条本地记录）';
}

/** True while a difficulty order cannot run because no concrete source instance is selected. */
export function mergedSortDisabled(sort: MergedSort, sourceInstanceId: string | null): boolean {
  return (sort === 'difficulty_asc' || sort === 'difficulty_desc') && sourceInstanceId === null;
}

/** The sort to keep after a source-filter change: a difficulty order falls back to 题号升序. */
export function normalizeMergedSort(sort: MergedSort, sourceInstanceId: string | null): MergedSort {
  return mergedSortDisabled(sort, sourceInstanceId) ? DEFAULT_MERGED_SORT : sort;
}

/** The committed difficulty dimension that fits one source instance. */
export function dimensionForSource(source: SourceInstance | null | undefined): string {
  return platformRatingDimension(source?.platform ?? '') ?? MERGED_FALLBACK_DIMENSION;
}

/** Outcome of committing an edited difficulty dimension. */
export interface DimensionCommit {
  /** The dimension in effect afterwards; a refused draft leaves the previous one committed. */
  readonly dimension: string;
  /** What the field shows afterwards; a refused draft is restored to the committed value. */
  readonly draft: string;
  readonly warning: string | null;
  /** True only for a valid edit that changes the committed dimension. */
  readonly changed: boolean;
}

/**
 * Commit an edited difficulty dimension.
 *
 * The API accepts a trimmed length of 1..100, so a blank or over-long draft is refused with inline
 * feedback while the previous committed dimension stays in effect; only a valid change is reported
 * as `changed`, so a refused edit never moves an unrelated page position.
 */
export function commitDimensionDraft(draft: string, committed: string): DimensionCommit {
  const next = draft.trim();
  if (next.length === 0) {
    return { dimension: committed, draft: committed, warning: MERGED_DIMENSION_BLANK_WARNING, changed: false };
  }
  if (next.length > MAX_MERGED_DIMENSION_CHARS) {
    return {
      dimension: committed,
      draft: committed,
      warning: MERGED_DIMENSION_TOO_LONG_WARNING,
      changed: false,
    };
  }
  return { dimension: next, draft: next, warning: null, changed: next !== committed };
}

/** One member's own raw platform difficulty, preserved dimension by dimension. */
export function ratingTextOf(problem: WorkbenchProblemSummary): string {
  return (
    problem.rawRatings.map((rating) => rating.dimension + ': ' + (rating.raw ?? rating.value)).join(' / ') ||
    '未提供'
  );
}

/**
 * Whether one accepted evidence row names a problem the local bank also stores as a group member.
 *
 * `false` is not a reason to hide the evidence: the accepted submission is a real platform record,
 * it just has no local metadata row of its own, and the caller says so.
 */
export function evidenceHasLocalMetadata(
  members: readonly MergedMemberLike[],
  evidence: WorkbenchAcceptedEvidenceView,
): boolean {
  return members.some((member) => member.problem.problemKey === evidence.problemKey);
}

/** One evidence line: who passed it, on which platform identifier, and when the platform accepted it. */
export function evidenceTextOf(
  evidence: WorkbenchAcceptedEvidenceView,
  accounts: readonly Account[],
  sources: readonly SourceInstance[],
): string {
  return `${accountLabelOf(evidence.accountId, accounts, sources)} · ${evidence.externalKey} · ${evidence.submittedAt}`;
}

/**
 * React key of one member detail.
 *
 * Keying on the canonical key AND the native account means switching the member (or its account)
 * remounts the detail instead of reusing the previous problem's state.
 */
export function detailKeyOf(problemKey: string, accountId: string | null): string {
  return problemKey + '|' + (accountId ?? 'no-account');
}

/** Code-unit comparison of two texts; locale-independent so the order is reproducible everywhere. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
