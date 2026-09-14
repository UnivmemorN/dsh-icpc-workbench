/**
 * Pure add-account onboarding rules (Sprint Contract 08a).
 *
 * The form accepts either the bare identifier — a Codeforces handle or a Luogu numeric UID — or the
 * official profile URL, and reduces both to exactly the string `account.create` expects. Nothing is
 * fetched: the URL is parsed locally, official hosts are matched by exact hostname, and the static
 * examples below are only rendered as separated text, so reading them can never create an account.
 *
 * The adapter factories remain the single source of identity truth (canonicalization, storage and
 * the derived `profileUrl`); this module only decides what the user may submit and which actionable
 * Chinese message explains a refusal.
 */

export type AccountPlatform = 'codeforces' | 'luogu';

/** Per-platform onboarding copy: label, placeholder, help text and the inert example link. */
export interface AccountGuide {
  readonly label: string;
  readonly placeholder: string;
  readonly help: string;
  readonly exampleUrl: string;
  readonly exampleText: string;
}

/** Id of the help paragraph the identifier field points `aria-describedby` at. */
export const ACCOUNT_HELP_ID = 'icpc-account-help';
/** Id of the inline validation paragraph; referenced only while a message is shown. */
export const ACCOUNT_ERROR_ID = 'icpc-account-error';
/** What adding an account does, and the explicit next step that actually obtains records. */
export const ACCOUNT_SAVE_NOTE =
  '添加只保存公开账号标识，不需要密码；洛谷账号会自动读取一次公开昵称（不需要 Cookie），这不会同步做题记录——历史记录仍要单独在本页下方同步或导入。';

/**
 * Platform-specific onboarding copy.
 *
 * The help text carries the distinctions the compact form was missing: a Codeforces handle is the
 * `/profile/` name and not an email, a Luogu UID is the number after `/user/` and not a nickname.
 * The example URLs are contract examples only and stay in prose/anchor form, never as field values.
 */
export const ACCOUNT_GUIDES: Readonly<Record<AccountPlatform, AccountGuide>> = {
  codeforces: {
    label: 'Codeforces Handle（用户名）',
    placeholder: 'tourist 或 https://codeforces.com/profile/tourist',
    help: 'Handle 是个人主页网址中 /profile/ 后面的用户名，例如 https://codeforces.com/profile/tourist 里的 tourist（仅为示例）。它不是邮箱；可以直接填写用户名，或粘贴个人主页链接。',
    exampleUrl: 'https://codeforces.com/profile/tourist',
    exampleText: 'tourist 的个人主页',
  },
  luogu: {
    label: '洛谷 UID（数字用户号）',
    placeholder: '123456 或 https://www.luogu.com.cn/user/123456',
    help: 'UID 是个人主页网址中 /user/ 后面的数字，例如 https://www.luogu.com.cn/user/123456 里的 123456（仅为示例）：打开自己的洛谷个人主页，复制 /user/ 后面的数字即可。它不是昵称；可以直接填写数字，或粘贴个人主页链接。',
    exampleUrl: 'https://www.luogu.com.cn/user/123456',
    exampleText: '洛谷 UID 123456 的个人主页',
  },
};

/** Result of inspecting one form value: nothing typed, a refusal with its reason, or submittable. */
export type AccountInputCheck =
  | { readonly state: 'empty' }
  | { readonly state: 'invalid'; readonly message: string }
  | { readonly state: 'valid'; readonly handle: string; readonly viaProfileUrl: boolean };

/** Exact official hostnames; a look-alike or a subdomain is not a platform and is refused. */
const HOSTS: Readonly<Record<AccountPlatform, readonly string[]>> = {
  codeforces: ['codeforces.com', 'www.codeforces.com'],
  luogu: ['luogu.com.cn', 'www.luogu.com.cn'],
};

/** The one profile path each platform uses, and nothing else on that host. */
const PROFILE_PATH_PATTERN: Readonly<Record<AccountPlatform, RegExp>> = {
  codeforces: /^\/profile\/([^/]+)\/?$/u,
  luogu: /^\/user\/([^/]+)\/?$/u,
};

/** Mirrors the adapter factories: CF is 3–24 handle characters, Luogu a canonical positive decimal. */
const HANDLE_PATTERN: Readonly<Record<AccountPlatform, RegExp>> = {
  codeforces: /^[A-Za-z0-9_.-]{3,24}$/u,
  luogu: /^[1-9][0-9]{0,19}$/u,
};

const PLATFORM_NAME: Readonly<Record<AccountPlatform, string>> = {
  codeforces: 'Codeforces',
  luogu: '洛谷',
};

const IDENTIFIER_RULE: Readonly<Record<AccountPlatform, string>> = {
  codeforces: 'Handle 需为 3–24 位字母、数字、下划线、点或连字符（不含空格和 @），例如 tourist。',
  luogu: 'UID 需为个人主页 /user/ 后面的正整数（最多 20 位，不能以 0 开头），例如 123456。',
};

const LINK_IDENTIFIER_RULE: Readonly<Record<AccountPlatform, string>> = {
  codeforces:
    '链接中的 Handle 不合法：需为 3–24 位字母、数字、下划线、点或连字符，例如 https://codeforces.com/profile/tourist。',
  luogu:
    '链接中的 UID 不合法：需为 /user/ 后面的正整数（最多 20 位，不能以 0 开头），例如 https://www.luogu.com.cn/user/123456。',
};

const MESSAGES = {
  scheme: '只支持 http(s) 链接，请粘贴浏览器地址栏中的主页链接，或直接填写用户名/UID。',
  malformed: '链接无法识别，请粘贴浏览器地址栏中的完整主页链接，或直接填写用户名/UID。',
  missingScheme: '完整链接需要以 https:// 开头，例如 https://codeforces.com/profile/tourist。',
  credentials: '链接里不能包含用户名或密码等登录信息，请只粘贴公开的个人主页链接。',
  port: '链接不能带端口号，请使用官方地址（codeforces.com、www.luogu.com.cn）。',
  host: '只接受官方站点链接：Codeforces 为 codeforces.com，洛谷为 luogu.com.cn（含 www）。',
  encodedSeparator: '链接包含 %2F、%5C 这类编码后的分隔符，请直接粘贴浏览器地址栏中的主页链接。',
} as const;

/** A scheme-less value that names an official host is a URL missing its `https://`, not an identifier. */
const OFFICIAL_LINK = /^(?:www\.)?(?:codeforces\.com|luogu\.com\.cn)(?:\/|$)/iu;
/** Percent-encoded path separators must never smuggle a second segment past the path check. */
const ENCODED_SEPARATOR = /%2f|%5c/iu;

function invalid(message: string): AccountInputCheck {
  return { state: 'invalid', message };
}

/**
 * Reduce one form value to the identifier to submit, or to the message that blocks submission.
 *
 * A value without a scheme is treated as a bare identifier; anything carrying a scheme must be an
 * http(s) URL on an official host whose path is exactly the platform's profile path. Leading and
 * trailing whitespace is ignored, nothing else is normalized here: the adapter factory still
 * lowercases Codeforces identity and derives the stored profile URL.
 */
export function checkAccountInput(platform: AccountPlatform, raw: string): AccountInputCheck {
  const value = raw.trim();
  if (value.length === 0) return { state: 'empty' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return checkProfileUrl(platform, value);
  if (OFFICIAL_LINK.test(value)) return invalid(MESSAGES.missingScheme);
  return checkIdentifier(platform, value, false);
}

/**
 * Parse one http(s) profile URL without fetching it.
 *
 * Refused in order: embedded credentials, an explicit port (the WHATWG parser hides a default
 * `:443`, so the raw authority is inspected), a non-http(s) scheme, a host that is not exactly the
 * official hostname, another platform's host, an encoded separator, a path other than
 * `/profile/<handle>` or `/user/<uid>` (an optional trailing slash, query and hash are allowed),
 * and finally an identifier that fails the platform's own canonical form.
 */
function checkProfileUrl(platform: AccountPlatform, value: string): AccountInputCheck {
  const authority = authorityShape(value);
  if (authority?.credentials) return invalid(MESSAGES.credentials);
  if (authority?.port) return invalid(MESSAGES.port);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(MESSAGES.malformed);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalid(MESSAGES.scheme);
  if (url.username.length > 0 || url.password.length > 0) return invalid(MESSAGES.credentials);
  if (url.port.length > 0) return invalid(MESSAGES.port);
  const owner = platformOfHost(url.hostname.toLowerCase());
  if (owner === null) return invalid(MESSAGES.host);
  if (owner !== platform) {
    return invalid(
      `这是${PLATFORM_NAME[owner]}的链接，请先把上方「平台」切换为${PLATFORM_NAME[owner]}，或粘贴${PLATFORM_NAME[platform]}的标识。`,
    );
  }
  if (ENCODED_SEPARATOR.test(url.pathname)) return invalid(MESSAGES.encodedSeparator);
  const match = PROFILE_PATH_PATTERN[platform].exec(url.pathname);
  const handle = match?.[1];
  if (handle === undefined) {
    return invalid(`只支持个人主页链接，例如 ${ACCOUNT_GUIDES[platform].exampleUrl}。`);
  }
  return checkIdentifier(platform, handle, true, LINK_IDENTIFIER_RULE[platform]);
}

/**
 * Accepted identifier, or the platform rule that explains the refusal.
 *
 * A bare Codeforces handle keeps the spelling the user typed (the adapter lowercases identity and
 * stores this spelling as the display name); a bare Luogu UID is already the canonical decimal.
 */
function checkIdentifier(
  platform: AccountPlatform,
  value: string,
  viaProfileUrl: boolean,
  rule: string = IDENTIFIER_RULE[platform],
): AccountInputCheck {
  return HANDLE_PATTERN[platform].test(value)
    ? { state: 'valid', handle: value, viaProfileUrl }
    : invalid(rule);
}

/** Which platform an exact official hostname belongs to, or `null` for every other host. */
function platformOfHost(host: string): AccountPlatform | null {
  for (const platform of ['codeforces', 'luogu'] as const) {
    if (HOSTS[platform].includes(host)) return platform;
  }
  return null;
}

/**
 * Raw authority flags of a `scheme://authority` value, before URL normalization.
 *
 * The WHATWG parser rewrites `https://codeforces.com:443/` to a port-less URL, so an explicit
 * default port is only visible in the raw text. Official hosts are plain hostnames, so any `@` or
 * `:` between the scheme and the first `/`, `?` or `#` is a credential or a port, never a host.
 */
function authorityShape(value: string): { readonly credentials: boolean; readonly port: boolean } | null {
  const separator = value.indexOf('://');
  if (separator < 0) return null;
  const rest = value.slice(separator + 3);
  const end = rest.search(/[/?#]/u);
  const authority = end < 0 ? rest : rest.slice(0, end);
  return { credentials: authority.includes('@'), port: authority.includes(':') };
}
