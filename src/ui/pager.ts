/**
 * Pure paging rules of the numbered problem bank.
 *
 * They live outside `Bank.tsx` so the jump validation and the empty/loading counter rules can be
 * tested without a DOM; the component owns only the React wiring. Nothing here invents a page: a
 * `null` response means "no confirmed data yet", never page `0` or `1`.
 */

/** Inline feedback of a jump field that does not hold a positive integer page. */
export const JUMP_HINT = '请填写大于 0 的整数页码';

/**
 * Parse one jump-field value.
 *
 * Only a string of decimal digits is considered, and it must convert to a positive safe integer;
 * `''`, `'0'`, `'-3'`, `'1.5'`, `'2a'` and values beyond `Number.MAX_SAFE_INTEGER` are all invalid.
 * `null` means "do not move": the caller keeps the text in the field and shows {@link JUMP_HINT},
 * instead of coercing it to `0` and jumping to the first page.
 */
export function parseJumpPage(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/u.test(trimmed)) {
    return null;
  }
  const page = Number(trimmed);
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}

/** Hint to show beside the jump field, or `null` while it is empty or already valid. */
export function jumpHint(text: string): string | null {
  return text.trim().length > 0 && parseJumpPage(text) === null ? JUMP_HINT : null;
}

/** Display state of one pager, derived from the confirmed response alone. */
export interface PagerDisplay {
  /** True only after a response for the current query has arrived. */
  readonly hasData: boolean;
  readonly totalItems: number;
  readonly totalPages: number;
  /** Served page; `0` for a confirmed empty result, so the UI can show `第 0 / 0 页`. */
  readonly currentPage: number;
  /** False without confirmed non-empty data: every navigation control must be disabled. */
  readonly navigable: boolean;
}

/**
 * Derive the pager counters from the current response (`null` = none yet).
 *
 * `totalItems`/`totalPages` are only meaningful when `hasData` is true; callers must not render them
 * as fabricated zeros otherwise. A confirmed empty page reports `currentPage: 0` and stays
 * non-navigable, while the API keeps answering `page: 1` for that request.
 */
export function pagerDisplay(
  data: { readonly page: number; readonly totalItems: number; readonly totalPages: number } | null,
  requestedPage: number,
): PagerDisplay {
  if (data === null) {
    return { hasData: false, totalItems: 0, totalPages: 0, currentPage: requestedPage, navigable: false };
  }
  const empty = data.totalPages <= 0;
  return {
    hasData: true,
    totalItems: data.totalItems,
    totalPages: data.totalPages,
    currentPage: empty ? 0 : data.page,
    navigable: !empty,
  };
}
