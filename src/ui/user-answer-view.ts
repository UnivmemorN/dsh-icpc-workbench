/**
 * Reading rules of the pasted-answer panel (Sprint 12).
 *
 * Pure state, validation and naming helpers over the additive `material.supplement` answer input: no
 * React, no DOM, no store, no clock and no network. They exist so the externally meaningful promises
 * a user depends on can be pinned by tests without rendering a page: the panel never sends a blank
 * label or body, never sends an answer above the boundary's own bound, never turns a non-http(s) or
 * credential-carrying link into an attribution, keeps the pasted body byte-exact, names the caller's
 * own label as the attribution, and never invents the answer's origin.
 */
import {
  MAX_USER_ANSWER_LABEL_CHARS,
  MAX_USER_ANSWER_TEXT_CHARS,
  USER_ANSWER_SOURCE_ID_PREFIX,
  USER_ANSWER_ASSOCIATED_LINK_NOTE,
} from '../application/workbench-api.js';

/** Label used until the user types their own attribution. */
export const DEFAULT_USER_ANSWER_SOURCE_LABEL = '用户提供';

/** One example attribution the panel offers as a placeholder; never submitted on its own. */
export const USER_ANSWER_SOURCE_EXAMPLES = ['GPT6', '教师解析', '自己整理'];

/** What the panel says while the body is only stored locally. */
export const USER_ANSWER_LOCAL_ONLY_NOTE =
  '保存只写入本地快照，不会调用任何模型、不会产生费用，也不会自动采用任何算法标签。';

/** What the panel says before the user explicitly asks for analysis. */
export const USER_ANSWER_ANALYSIS_NOTE =
  '之后你显式发起分析、核验或提示时，这段文本才会随材料发送给设置中配置的 DeepSeek 模型（当前策略为 Flash · max）。';

/** What the panel says about a supplied link; the plugin never fetches it. */
export const USER_ANSWER_SOURCE_URL_NOTE = '你提供的来源链接：仅作标注，本插件不会抓取该链接。';

/** What the panel says when the user supplied no link at all. */
export const USER_ANSWER_ASSOCIATED_URL_NOTE =
  '你没有提供答案出处链接；这里关联的是题目链接，仅为关联题目，并非答案出处。';

/** One editable draft of the pasted-answer form. */
export interface UserAnswerDraft {
  readonly sourceLabel: string;
  readonly url: string;
  readonly text: string;
}

/** Result of one draft check; `message` names the first field that cannot be sent. */
export interface UserAnswerValidation {
  readonly valid: boolean;
  readonly message: string | null;
}

/** The draft a freshly mounted panel starts from; the label is editable, not a placeholder. */
export function defaultUserAnswerDraft(): UserAnswerDraft {
  return { sourceLabel: DEFAULT_USER_ANSWER_SOURCE_LABEL, url: '', text: '' };
}

/**
 * Structural check of one attribution URL.
 *
 * Mirrors the boundary's own rule (absolute `http(s)`, no credentials) so the user gets an immediate
 * answer, while the plugin re-validates the same value before anything is stored. `undefined` means
 * "no URL was declared at all", which is the honest absence the stored note reports. An unsafe URL
 * returns `null` and must never be sent.
 */
export function safeUserAnswerUrl(value: string | undefined): string | undefined | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    void error;
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return null;
  }
  return parsed.toString();
}

/**
 * Validate one draft before it may be sent.
 *
 * A blank label, a blank body, an oversized field or an unsafe URL is refused with its own message;
 * the pasted body is otherwise kept exactly as typed except that the boundary's own leading/trailing
 * whitespace rule applies, so no invisible content is silently reshaped.
 */
export function validateUserAnswerDraft(draft: UserAnswerDraft): UserAnswerValidation {
  if (draft.sourceLabel.trim().length === 0) {
    return { valid: false, message: '请填写来源标注（例如 GPT6、教师解析、自己整理）。' };
  }
  if (draft.sourceLabel.trim().length > MAX_USER_ANSWER_LABEL_CHARS) {
    return { valid: false, message: `来源标注最多 ${MAX_USER_ANSWER_LABEL_CHARS} 个字符。` };
  }
  if (draft.text.trim().length === 0) {
    return { valid: false, message: '请先粘贴答案正文。' };
  }
  if (draft.text.length > MAX_USER_ANSWER_TEXT_CHARS) {
    return { valid: false, message: `答案正文最多 ${MAX_USER_ANSWER_TEXT_CHARS} 个字符。` };
  }
  if (safeUserAnswerUrl(draft.url) === null) {
    return { valid: false, message: '来源链接需为不含账号密码的 http(s) 绝对地址，或留空。' };
  }
  return { valid: true, message: null };
}

/**
 * The exact request body of one paste, or `null` when the draft cannot be sent.
 *
 * The body keeps the user's own text verbatim and carries the trimmed attribution plus the validated
 * citation, or no `url` key at all when the user declared none — the panel never substitutes the
 * problem link here, because the stored note is what reports that association. The caller captures
 * `expectedSnapshotId` at submit time from the snapshot the user is looking at, so a material change
 * between typing and saving is refused by the service instead of being merged into a head the user
 * never saw.
 */
export function userAnswerRequest(
  draft: UserAnswerDraft,
): { readonly sourceLabel: string; readonly text: string; readonly url?: string } | null {
  if (!validateUserAnswerDraft(draft).valid) {
    return null;
  }
  const citation = safeUserAnswerUrl(draft.url);
  return {
    sourceLabel: draft.sourceLabel.trim(),
    text: draft.text,
    ...(typeof citation === 'string' ? { url: citation } : {}),
  };
}

/** True when one revealed source is a paste of this feature, addressed by its own id namespace. */
export function isUserAnswerSource(source: { readonly sourceId: string }): boolean {
  // The shared prefix constant is the single definition of that namespace, so the panel and the
  // plugin half can never drift into recognising different ids as user-provided.
  return source.sourceId.startsWith(USER_ANSWER_SOURCE_ID_PREFIX);
}

/**
 * What one revealed user-provided source says about itself.
 *
 * `note` is the stored provenance sentence (attribution, "not an official editorial, correctness not
 * certified", and whether the linked URL is the associated problem page); `origin` is `source` only
 * when the caller supplied a real citation, and `problem` when no citation was stored, so a reader
 * can never mistake the linked problem page for the answer's origin.
 */
export function userAnswerProvenance(source: {
  readonly sourceId: string;
  readonly note: string | null;
}): { readonly userProvided: boolean; readonly note: string | null; readonly origin: 'source' | 'problem' | null } {
  if (!isUserAnswerSource(source)) {
    return { userProvided: false, note: null, origin: null };
  }
  return {
    userProvided: true,
    note: source.note,
    origin: source.note !== null && source.note.endsWith(USER_ANSWER_ASSOCIATED_LINK_NOTE) ? 'problem' : 'source',
  };
}

/** Heading of one revealed source: identity plus the provenance line the reader needs. */
export function userAnswerSourceHeading(source: {
  readonly sourceId: string;
  readonly title: string;
  readonly note: string | null;
}): string {
  const provenance = userAnswerProvenance(source);
  if (!provenance.userProvided) {
    return source.title;
  }
  return `${source.title} · 用户提供（非官方题解，正确性未经本插件核验）`;
}
