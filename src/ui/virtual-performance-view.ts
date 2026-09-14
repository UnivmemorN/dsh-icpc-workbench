/**
 * Pure reading and form rules of the virtual-contest performance ledger (Sprint 18c2).
 *
 * The ledger is **user-entered** evidence, so this module owns exactly the decisions a browser can
 * make on its own: what one typed value means, which refusal to show, and how a stored row is
 * described. Nothing here talks to the API, the store or a model, which is what keeps the rules
 * testable without a DOM. The server keeps the last word — `virtual-performance-service.ts`
 * re-validates every field — and this module never invents a value:
 *
 * - an **empty** numeric field is a refusal, never `0`, and an empty optional field (rank, note) is
 *   `null`, never `0` or `''`;
 * - an entered `0` or a negative `performance` is legitimate and is submitted unchanged;
 * - `participatedAt` is the instant the user *actually solved the virtual run*, entered as a local
 *   `datetime-local` value, and it may not lie in the future.
 *
 * The distinction the UI must never blur: this evidence is not an official rating, a stored row is
 * not a model suggestion, and a missing row is not a zero score.
 */
import {
  MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS,
  MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS,
  MAX_VIRTUAL_PERFORMANCE_URL_CHARS,
  VIRTUAL_PERFORMANCE_INDEPENDENCE,
  VIRTUAL_PERFORMANCE_MAX,
  VIRTUAL_PERFORMANCE_MIN,
  type VirtualPerformanceCounts,
  type VirtualPerformanceEvidence,
  type VirtualPerformanceIndependence,
} from '../domain/index.js';

/** Panel title; the label states user entry and non-official provenance before anything else. */
export const VIRTUAL_PERFORMANCE_TITLE = '虚拟参赛表现（用户手工录入，不是官方评分）';

/** What this slice is, and what it deliberately does not do. */
export const VIRTUAL_PERFORMANCE_SECTION_NOTE =
  '这里保存的是你在 Codeforces 打完虚拟赛后自己录入的 performance：它不是 Codeforces 官方 rating，插件不会抓取、不会估算，也不会为录入调用 AI。官方评分仍以上方官方数据为准；两种来源始终分开显示。';

/** The date rule the form exists to get right: virtual time, not the official contest date. */
export const VIRTUAL_PERFORMANCE_DATE_RULE =
  '「虚拟参赛时间」填你实际开始做这套题的日期和时间（本地时间，精确到秒），不是这场比赛的官方举办时间，也不是你补题的时间。';

/** Honest absence: no row, no zero, no guess. */
export const VIRTUAL_PERFORMANCE_EMPTY_NOTE =
  '还没有任何虚拟参赛记录。缺失的数据不会被当作 0 分，也不会被估算或补全；有记录后再逐条录入即可。';

/** Why a method label is mandatory instead of optional. */
export const VIRTUAL_PERFORMANCE_METHOD_NOTE =
  '不同工具或公式算出的 performance 不可比，所以必须写明计算方法；记录可以随时修改或删除。';

/** Human labels of the three independence answers; `unknown` is never promoted to independent. */
export const VIRTUAL_PERFORMANCE_INDEPENDENCE_LABELS: Readonly<Record<VirtualPerformanceIndependence, string>> = {
  independent: '独立完成',
  assisted: '有提示或参考题解',
  unknown: '不确定（按未知处理）',
};

/** Field names of the editor form; every one is a string because the DOM only produces strings. */
export interface VirtualPerformanceFormFields {
  readonly contestId: string;
  /** Local `datetime-local` text of the user's own virtual participation. */
  readonly participatedAt: string;
  readonly performance: string;
  readonly calculationMethod: string;
  readonly sourceUrl: string;
  /** One of {@link VIRTUAL_PERFORMANCE_INDEPENDENCE}, or `''` while nothing is chosen. */
  readonly independence: string;
  readonly priorExposure: boolean;
  readonly rank: string;
  readonly note: string;
}

/** One field name of the form. */
export type VirtualPerformanceField = keyof VirtualPerformanceFormFields;

/** Refusals keyed by the field that caused them; a field with no entry is acceptable. */
export type VirtualPerformanceFormErrors = Readonly<Partial<Record<VirtualPerformanceField, string>>>;

/** The validated field values `performance.save` carries (the caller adds account, revision, id). */
export interface VirtualPerformanceSaveValues {
  readonly contestId: number;
  /** ISO instant of the user's own virtual participation. */
  readonly participatedAt: string;
  readonly performance: number;
  readonly calculationMethod: string;
  readonly sourceUrl: string;
  readonly independence: VirtualPerformanceIndependence;
  readonly priorExposure: boolean;
  /** `null` means "not recorded", never rank 0. */
  readonly rank: number | null;
  /** `null` means "no note", never an empty string pretending to be one. */
  readonly note: string | null;
}

/** Either the values to submit or the readable refusals to show; never a partial submission. */
export type VirtualPerformanceFormCheck =
  | { readonly state: 'valid'; readonly values: VirtualPerformanceSaveValues }
  | { readonly state: 'invalid'; readonly errors: VirtualPerformanceFormErrors };

/** Pristine editor state: no borrowed row and no numeric zero anywhere. */
export const EMPTY_VIRTUAL_PERFORMANCE_FORM: VirtualPerformanceFormFields = {
  contestId: '',
  participatedAt: '',
  performance: '',
  calculationMethod: '',
  sourceUrl: '',
  independence: '',
  priorExposure: false,
  rank: '',
  note: '',
};

const MESSAGES = {
  contestIdEmpty: '请填写比赛编号（Codeforces contest id，正整数，例如 1942）；它不能为空。',
  contestIdInvalid: '比赛编号必须是正整数（不是题目编号，也不能带字母或小数）。',
  performanceEmpty: '请填写 performance；留空不会被当作 0 分。',
  performanceInvalid: 'performance 必须是整数，可以是 0 或负数（例如 -12）。',
  methodEmpty: `请填写计算 performance 的方法或工具名称（例如 carrot），最多 ${MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS} 个字符。`,
  methodTooLong: `计算方法最多 ${MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS} 个字符，请写简短的工具或公式名。`,
  urlEmpty: '请填写这次虚拟赛或计算方法的参考链接（http/https）。',
  urlInvalid: '参考链接必须是完整的 http(s) 链接，且不能包含用户名或密码；链接只作为出处保存，插件不会访问它。',
  independenceMissing: '请选择这次虚拟赛的独立完成情况；拿不准就选“不确定（按未知处理）”。',
  dateEmpty: '请填写你实际参加虚拟赛的日期和时间（不是官方比赛日期）。',
  dateInvalid: '日期时间无法识别，请用日期时间输入框填写（例如 2026-03-01T14:30:00）。',
  dateFuture: '虚拟参赛时间不能晚于现在：这里填你实际做题的时间，不是官方比赛日期。',
  rankInvalid: '名次必须是正整数；没有名次就留空（留空表示未记录，不会当作 0）。',
  noteTooLong: `备注最多 ${MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS} 个字符。`,
} as const;

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;
const UNSIGNED_INTEGER = /^\d+$/u;
const SIGNED_INTEGER = /^-?\d+$/u;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `datetime-local` text of one ISO instant in the viewer's own zone, with seconds precision.
 *
 * Returns `''` for an unparseable instant so a broken stored row renders as missing instead of
 * being prefilled with `Invalid Date`.
 */
export function virtualPerformanceLocalDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Instant of one local `datetime-local` text, or `null` when it is not a real local time.
 *
 * The text must carry a date *and* a time (a date-only value is interpreted as UTC by the platform
 * and would silently shift the day), and the local fields have to survive a round trip: a rolled
 * over date such as `2026-02-30T10:00` and a daylight-saving gap such as `02:30` on a spring-forward
 * morning are refused instead of becoming a different instant than the user typed.
 */
export function virtualPerformanceInstant(text: string): number | null {
  const match = LOCAL_DATE_TIME.exec(text.trim());
  if (match === null) return null;
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}`;
  const instant = Date.parse(normalized);
  if (!Number.isFinite(instant)) return null;
  return virtualPerformanceLocalDateTime(new Date(instant).toISOString()) === normalized ? instant : null;
}

/**
 * Validate one form and return either the exact values to submit or the refusals to show.
 *
 * `now` is passed in (never read here) so the future check is deterministic in tests, and every
 * refusal is collected in one pass so the form can point at each field instead of failing one at a
 * time. Values are only assembled when nothing is refused, so a partially typed form can never
 * submit a `0` that the user did not enter.
 */
export function parseVirtualPerformanceForm(
  fields: VirtualPerformanceFormFields,
  now: Date,
): VirtualPerformanceFormCheck {
  const errors: { [K in VirtualPerformanceField]?: string } = {};

  const contestId = positiveIntegerOf(fields.contestId);
  if (contestId === null) {
    errors.contestId = fields.contestId.trim().length === 0 ? MESSAGES.contestIdEmpty : MESSAGES.contestIdInvalid;
  }

  const performance = signedIntegerOf(fields.performance);
  if (performance === null) {
    errors.performance =
      fields.performance.trim().length === 0 ? MESSAGES.performanceEmpty : MESSAGES.performanceInvalid;
  } else if (performance < VIRTUAL_PERFORMANCE_MIN || performance > VIRTUAL_PERFORMANCE_MAX) {
    errors.performance = `performance 需要在 ${VIRTUAL_PERFORMANCE_MIN} 到 ${VIRTUAL_PERFORMANCE_MAX} 之间（当前数值超出可信范围）。`;
  }

  const method = fields.calculationMethod.trim();
  if (method.length === 0) errors.calculationMethod = MESSAGES.methodEmpty;
  else if (method.length > MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS) errors.calculationMethod = MESSAGES.methodTooLong;

  const sourceUrl = fields.sourceUrl.trim();
  if (sourceUrl.length === 0) errors.sourceUrl = MESSAGES.urlEmpty;
  else if (sourceUrl.length > MAX_VIRTUAL_PERFORMANCE_URL_CHARS) {
    errors.sourceUrl = `参考链接最多 ${MAX_VIRTUAL_PERFORMANCE_URL_CHARS} 个字符。`;
  } else if (!isReferenceUrl(sourceUrl)) errors.sourceUrl = MESSAGES.urlInvalid;

  const independence = VIRTUAL_PERFORMANCE_INDEPENDENCE.find((value) => value === fields.independence) ?? null;
  if (independence === null) errors.independence = MESSAGES.independenceMissing;

  const participatedAt = virtualPerformanceInstant(fields.participatedAt);
  if (participatedAt === null) {
    errors.participatedAt = fields.participatedAt.trim().length === 0 ? MESSAGES.dateEmpty : MESSAGES.dateInvalid;
  } else if (participatedAt > now.getTime()) {
    errors.participatedAt = MESSAGES.dateFuture;
  }

  const rankText = fields.rank.trim();
  const rank = rankText.length === 0 ? null : positiveIntegerOf(rankText);
  if (rankText.length > 0 && rank === null) errors.rank = MESSAGES.rankInvalid;

  const noteText = fields.note.trim();
  const note = noteText.length === 0 ? null : noteText;
  if (note !== null && note.length > MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS) errors.note = MESSAGES.noteTooLong;

  const refused =
    contestId === null ||
    performance === null ||
    performance < VIRTUAL_PERFORMANCE_MIN ||
    performance > VIRTUAL_PERFORMANCE_MAX ||
    method.length === 0 ||
    method.length > MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS ||
    sourceUrl.length === 0 ||
    sourceUrl.length > MAX_VIRTUAL_PERFORMANCE_URL_CHARS ||
    !isReferenceUrl(sourceUrl) ||
    independence === null ||
    participatedAt === null ||
    participatedAt > now.getTime() ||
    (rankText.length > 0 && rank === null) ||
    (note !== null && note.length > MAX_VIRTUAL_PERFORMANCE_NOTE_CHARS);
  if (refused) return { state: 'invalid', errors };
  return {
    state: 'valid',
    values: {
      contestId,
      participatedAt: new Date(participatedAt).toISOString(),
      performance,
      calculationMethod: method,
      sourceUrl,
      independence,
      priorExposure: fields.priorExposure,
      rank,
      note,
    },
  };
}

/** One stored row as a single readable line; the flags are stated, never implied. */
export function virtualPerformanceEntryText(entry: VirtualPerformanceEvidence): string {
  return [
    VIRTUAL_PERFORMANCE_INDEPENDENCE_LABELS[entry.independence],
    entry.priorExposure ? '赛前已见过题' : '赛前没有见过题',
  ].join(' · ');
}

/** Honest counts; every group is named so `unknown` can never be read as independent. */
export function virtualPerformanceCountsText(counts: VirtualPerformanceCounts): string {
  return `共 ${counts.total} 条：可作为独立能力证据 ${counts.eligibleIndependent} 条，有提示或参考题解 ${counts.assisted} 条，独立性未知 ${counts.unknownIndependence} 条，赛前见过题 ${counts.priorExposed} 条。`;
}

/** Local rendering of one stored instant; a broken value reads as missing, never as a date. */
export function virtualPerformanceWhenText(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '时间缺失';
}

/** `true` only for an absolute, credential-free http(s) reference the domain validator accepts. */
function isReferenceUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username.length === 0 &&
    parsed.password.length === 0
  );
}

/** Safe positive integer of one text, or `null`; `0` and a 20-digit overflow are both refused. */
function positiveIntegerOf(raw: string): number | null {
  const value = raw.trim();
  if (!UNSIGNED_INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** Safe signed integer of one text, or `null`; `0` and negative values stay legitimate. */
function signedIntegerOf(raw: string): number | null {
  const value = raw.trim();
  if (!SIGNED_INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
