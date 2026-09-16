/**
 * Reading rules of one problem's material refresh (Sprint 33B).
 *
 * Pure helpers over the typed `material.refresh` answer: no React, no DOM, no store, no clock and no
 * network. They exist so the externally meaningful rules a user depends on can be pinned by tests
 * without rendering a page — above all that a *skipped* equivalent-problem reuse is never phrased as
 * "the other site has no editorial", and that a reuse names the exact problem it was based on so the
 * pairing can be checked rather than believed.
 */

/**
 * Chinese explanation of every reason the equivalent Codeforces problem was **not** consulted.
 *
 * Each value says what happened and refuses to conclude anything about the other site: a skip is a
 * decision of this run, so reading it as "Codeforces has no editorial" is exactly the mistake the
 * material gate exists to prevent.
 */
export const MIRROR_SKIP_REASON_TEXT: Readonly<Record<string, string>> = {
  mirror_not_applicable:
    '这道题不是官方洛谷 CF 镜像题（或编号不规范），因此不会从 Codeforces 复用题解；题解仍按洛谷自己的材料获取。',
  cf_source_unavailable: '当前配置里没有可用的官方 Codeforces 来源，所以这次没有请求对等题目的题解。',
  existing_editorial_reusable: '本地已有可用题解或你自己提供的答案，本次直接复用，没有请求 Codeforces。',
};

/** The sentence used for a reason this build does not know. */
export const MIRROR_SKIP_UNKNOWN_TEXT =
  '本次没有从 Codeforces 复用题解。这不代表 Codeforces 没有题解，只表示这次没有去请求。';

/** What one refresh said about the equivalent-problem reuse. */
export interface MirrorReuseView {
  /** `true` when an editorial was really fetched from the equivalent Codeforces problem. */
  readonly reused: boolean;
  /** Chinese sentence describing what was done, or why nothing was requested. */
  readonly text: string;
  /** Canonical Codeforces key the reuse was based on, or `null` when the rule did not apply. */
  readonly key: string | null;
}

/**
 * Describe the `mirror` member of one `material.refresh` answer.
 *
 * A `fetched` mirror member means the equivalent Codeforces problem was consulted. Only a matching
 * `found` editorial status proves that usable tutorial material was actually obtained. A `skipped`
 * answer explains which boundary applied. An absent member (an older host answer) is treated as "the
 * rule did not apply", which is the honest reading of an answer that says nothing about reuse.
 */
export function mirrorReuseView(
  mirror:
    | { readonly status: string; readonly skippedReason: string | null; readonly key: string | null }
    | null
    | undefined,
  editorialStatus: string | null | undefined = null,
): MirrorReuseView {
  if (mirror === null || mirror === undefined) {
    return { reused: false, text: MIRROR_SKIP_REASON_TEXT.mirror_not_applicable ?? MIRROR_SKIP_UNKNOWN_TEXT, key: null };
  }
  if (mirror.status === 'fetched') {
    const key = mirror.key ?? '';
    if (editorialStatus === 'found') {
      return {
        reused: true,
        text:
          key.length === 0
            ? '已从对等的官方 Codeforces 题目获取官方 tutorial，作为本题的题解材料。'
            : `已从对等的官方 Codeforces 题目 ${key} 获取官方 tutorial，作为本题的题解材料；题面仍来自洛谷。`,
        key: mirror.key,
      };
    }
    return {
      reused: false,
      text:
        key.length === 0
          ? '已请求对等的官方 Codeforces 题目；本次未获得可用题解，请以上方题解状态为准。'
          : `已请求对等的官方 Codeforces 题目 ${key}；本次未获得可用题解，请以上方题解状态为准；题面仍来自洛谷。`,
      key: mirror.key,
    };
  }
  const reason = mirror.skippedReason ?? '';
  return {
    reused: false,
    text: MIRROR_SKIP_REASON_TEXT[reason] ?? MIRROR_SKIP_UNKNOWN_TEXT,
    key: mirror.key,
  };
}

// ---------------------------------------------------------------------------------------
// Shared-round evidence (Sprint 33B1)
// ---------------------------------------------------------------------------------------

/** The rule identity every shared-round note carries; the note format is versioned by it. */
export const CF_EDITORIAL_ALIAS_TAG = 'cf-editorial-alias-v1';

/** Parsed evidence of one shared-round redirect, as the stored note records it. */
export interface MaterialAliasEvidence {
  /** The Codeforces key the user asked for. */
  readonly requestedKey: string;
  /** The Codeforces key whose section actually holds the written-up solution. */
  readonly sectionKey: string;
  /** The official tutorial blog both problems link to. */
  readonly blogId: number;
  /** `explicit_reference` when the section named the requested problem, else the pairing rule. */
  readonly method: string;
}

/** One-line summary of a shared-round redirect, or `null` for an ordinary section. */
export function materialAliasSummary(evidence: MaterialAliasEvidence): string {
  return `已按官方共享赛题映射：${evidence.requestedKey} → ${evidence.sectionKey}`;
}

/** The official problem URLs of one shared-round redirect, for the expandable evidence. */
export function materialAliasLinks(evidence: MaterialAliasEvidence): {
  readonly requestedUrl: string;
  readonly sectionUrl: string;
  readonly blogUrl: string;
} {
  return {
    requestedUrl: `https://codeforces.com/problemset/problem/${splitKey(evidence.requestedKey).contestId}/${splitKey(evidence.requestedKey).index}`,
    sectionUrl: `https://codeforces.com/problemset/problem/${splitKey(evidence.sectionKey).contestId}/${splitKey(evidence.sectionKey).index}`,
    blogUrl: `https://codeforces.com/blog/entry/${String(evidence.blogId)}`,
  };
}

/** `<contestId><index>` split into its two parts, for building an official URL. */
function splitKey(key: string): { readonly contestId: string; readonly index: string } {
  const match = /^([0-9]{1,7})\/([0-9]{1,3})$|^([0-9]{1,7})([A-Za-z][0-9]*)$/u.exec(key);
  if (match === null) {
    return { contestId: '', index: '' };
  }
  return match[1] === undefined
    ? { contestId: match[3] ?? '', index: match[4] ?? '' }
    : { contestId: match[1], index: match[2] ?? '' };
}

/**
 * Parse the shared-round evidence out of one stored editorial source note.
 *
 * The adapter writes the note in a fixed `key=value;` form, so the page can show the mapping without
 * re-deriving it (and without a second source of truth): it reads what was actually recorded against
 * the material the model will see. A note that carries no `cf-editorial-alias-v1` marker is an
 * ordinary section, and a malformed one is reported as absent rather than half-parsed — the page then
 * simply shows the source without an alias claim.
 */
export function parseMaterialAliasEvidence(note: string | null | undefined): MaterialAliasEvidence | null {
  if (typeof note !== 'string' || !note.includes(CF_EDITORIAL_ALIAS_TAG)) {
    return null;
  }
  const requestedKey = fieldOf(note, 'requested');
  const sectionKey = fieldOf(note, 'section');
  const blogId = fieldOf(note, 'blog');
  const method = fieldOf(note, 'method');
  if (requestedKey === null || sectionKey === null || blogId === null || !/^[0-9]{1,9}$/u.test(blogId)) {
    return null;
  }
  return {
    requestedKey,
    sectionKey,
    blogId: Number(blogId),
    method: method ?? 'official_division_pair',
  };
}

/** Value of one `key=value` field of a note, or `null` when it is absent or blank. */
function fieldOf(note: string, name: string): string | null {
  const match = new RegExp(String.raw`(?:^|[;\s])${name}=([^;\s]+)`, 'u').exec(note);
  const value = match?.[1];
  return value === undefined || value.length === 0 ? null : value;
}
