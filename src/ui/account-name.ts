/**
 * Account naming and the one public Luogu nickname flow (Sprint Contract 22b2).
 *
 * Identity is always the platform UID/handle; a nickname is presentation only and is shown next to
 * the UID, never instead of it. These rules are pure so the account list, the header selector, the
 * current-account line and the Luogu panel derive the same labels, and a nickname that is missing or
 * merely repeats the UID is never presented as a name. An account's platform comes from the real
 * `boot.sources` list — the opaque instance id is never parsed to guess one.
 *
 * `lookupLuoguNickname` is the single asynchronous flow: it performs one injected typed business
 * read and checks the caller's signal after every awaited step, so a page that unmounted or an
 * account that was replaced can neither apply a stale nickname nor refresh the bootstrap.
 */
import type { ApiAccountView } from '../application/workbench-api.js';

/** Shown whenever Luogu has no distinct public nickname for an account. */
export const LUOGU_FALLBACK_NAME = '洛谷用户';
/** Platform label of the Luogu option in the header selector. */
export const LUOGU_PLATFORM_NAME = '洛谷';

/** The naming rules only need the public identity fields of one account. */
export type NamedAccount = Pick<ApiAccountView, 'handle' | 'displayName'>;

/** The bootstrap source entry an account belongs to, looked up by its stored instance id. */
export function sourceOfAccount<T extends { readonly id: string }>(
  sources: readonly T[],
  account: { readonly sourceInstanceId: string },
): T | null {
  return sources.find((entry) => entry.id === account.sourceInstanceId) ?? null;
}

/** Distinct public nickname: a trimmed nonempty `displayName` that is not just the UID. */
export function luoguNickname(account: NamedAccount): string | null {
  const name = account.displayName?.trim() ?? '';
  return name.length > 0 && name !== account.handle.trim() ? name : null;
}

/** Primary Luogu label: the distinct nickname, else the neutral 洛谷用户 — never the UID. */
export function luoguPrimaryName(account: NamedAccount): string {
  return luoguNickname(account) ?? LUOGU_FALLBACK_NAME;
}

/** Second half of a Luogu identity: the UID, explicitly labelled so it cannot read as a nickname. */
export function luoguUidLabel(handle: string): string {
  return `UID ${handle}`;
}

/** Whether an automatic public read could add a nickname this account does not already show. */
export function needsLuoguNickname(account: NamedAccount, platform: string | null): boolean {
  return platform === 'luogu' && luoguNickname(account) === null;
}

/** List entry labels: Luogu splits nickname and UID; other platforms keep their existing spelling. */
export function accountListLabels(
  account: ApiAccountView,
  platform: string | null,
  platformName: string,
): { readonly primary: string; readonly secondary: string } {
  const primary = account.displayName ?? account.handle;
  return platform === 'luogu'
    ? { primary: luoguPrimaryName(account), secondary: `${platformName} · ${luoguUidLabel(account.handle)}` }
    : { primary, secondary: `${platformName} · ${account.handle}` };
}

/** Parenthetical of the current-account line; Luogu adds its explicit UID, others are unchanged. */
export function currentAccountNote(account: ApiAccountView, platform: string | null, platformName: string): string {
  return platform === 'luogu' ? `${platformName} · ${luoguUidLabel(account.handle)}` : platformName;
}

/** Header option: `nickname · UID <handle> · 洛谷`; other platforms keep their existing text. */
export function accountOptionLabel(
  account: ApiAccountView,
  source: { readonly platform: string; readonly displayName: string } | null,
): string {
  if (source?.platform === 'luogu') {
    return `${luoguPrimaryName(account)} · ${luoguUidLabel(account.handle)} · ${LUOGU_PLATFORM_NAME}`;
  }
  // The historical non-Luogu text is the platform prefix of the instance id.
  return `${account.displayName ?? account.handle} · ${account.sourceInstanceId.split(':')[0]}`;
}

/**
 * Fixed, short and safe refusal reasons, keyed by the transport code of `ApiClientError`.
 *
 * The whole `conflict` family of `luogu.profile` (busy source slot, rate limit, unavailable,
 * unrecognized page) shares one actionable sentence because the UI cannot tell them apart from the
 * code alone. No server text, platform body or error message is ever echoed.
 */
const LOOKUP_FAILURE_TEXT: Readonly<Record<string, string>> = {
  cancelled: '请求已取消。',
  timeout: '读取昵称超时，请稍后重试。',
  not_found: '本机没有这个账号，请刷新账号列表后重试。',
  invalid_input: '该账号不是规范的洛谷 UID 账号，无法读取公开昵称。',
  conflict: '洛谷昵称暂时无法读取（来源正忙或平台限流），请稍后重试。',
  model_busy: '工作台正忙，请稍后重试。',
  network_error: '无法连接工作台，请检查 dsh 是否运行。',
  invalid_response: '工作台返回了无法识别的响应，请重试。',
  version_mismatch: '工作台接口版本不兼容，请重新加载插件。',
  unauthorized: '登录已失效，请从 dsh 启动地址重新打开。',
  payload_too_large: '请求过大，请重试。',
  unsupported_media_type: '请求格式不正确，请重试。',
  internal: '读取昵称失败，请查看本地 dsh 日志。',
};

/** Neutral reason for every failure the table does not name. */
export const NICKNAME_FAILURE_FALLBACK = '读取洛谷公开昵称失败，请稍后重试。';

/** Refusal of an answer that belongs to another account; the caller must not apply it. */
export const NICKNAME_LOOKUP_MISMATCH = '昵称结果不属于当前账号，已忽略。';

/** Stable code of an `ApiClientError`-shaped failure without importing the client module. */
function failureCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Safe short reason for one failed lookup; only fixed sentences are returned. */
export function nicknameFailureText(error: unknown): string {
  const code = failureCode(error);
  return code === null ? NICKNAME_FAILURE_FALLBACK : LOOKUP_FAILURE_TEXT[code] ?? NICKNAME_FAILURE_FALLBACK;
}

/**
 * The one typed business read the flow may perform.
 *
 * Injected so the flow stays testable without HTTP; production passes the `luogu.profile` request,
 * which is public and anonymous and therefore needs no Cookie.
 */
export type LuoguProfileLookup = (accountId: string, signal: AbortSignal) => Promise<ApiAccountView>;

/** Result of one lookup: a refreshed nickname (`null` = no distinct public nickname), abort, refusal. */
export type NicknameLookupOutcome =
  | { readonly status: 'refreshed'; readonly nickname: string | null }
  | { readonly status: 'aborted' }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Read one Luogu account's public nickname through the injected port.
 *
 * The signal is checked before the request, after it settles and again before this function reports
 * anything, so an unmounted page, a cancelled action or a replaced selection can never apply the
 * answer. An answer naming another account is refused rather than applied, and a refusal is always a
 * fixed short sentence.
 */
export async function lookupLuoguNickname(
  accountId: string,
  request: LuoguProfileLookup,
  signal: AbortSignal,
): Promise<NicknameLookupOutcome> {
  if (signal.aborted) return { status: 'aborted' };
  let account: ApiAccountView;
  try {
    account = await request(accountId, signal);
  } catch (error) {
    // An abort that raced the refusal is an abort, not something to report as a nickname failure.
    return signal.aborted ? { status: 'aborted' } : { status: 'failed', reason: nicknameFailureText(error) };
  }
  if (signal.aborted) return { status: 'aborted' };
  if (account.id !== accountId) return { status: 'failed', reason: NICKNAME_LOOKUP_MISMATCH };
  return { status: 'refreshed', nickname: luoguNickname(account) };
}
