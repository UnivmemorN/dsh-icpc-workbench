/**
 * URL policy for the local Markdown renderer (Sprint 24a).
 *
 * Markdown text can come from a platform page, a user-pasted editorial or an AI response, so every
 * link and image destination is treated as untrusted input. The policy is deny-by-default:
 *
 * - only `http:` and `https:` are accepted for every destination;
 * - links additionally accept `mailto:` and a same-document `#fragment`;
 * - a relative URL is resolved against a validated http/https base URL supplied by the caller —
 *   never against `window.location` — and is rejected when no usable base exists;
 * - `data:`, `javascript:`, `vbscript:`, `file:`, `blob:` and every other scheme are rejected,
 *   including control-character, backslash-escape and character-reference obfuscation.
 *
 * A rejected destination is never rewritten into a different URL: callers show the link label or the
 * image alt text instead, so the stored content stays visible without becoming navigable. The
 * function is pure and never touches storage, cookies, network or the DOM.
 */

/** ASCII controls and DEL are rejected outright: browsers strip some of them from inside a scheme. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Destination kinds differ only in the schemes they accept; images never become navigable. */
export type MarkdownUrlKind = 'link' | 'image';

const ALLOWED: Readonly<Record<MarkdownUrlKind, ReadonlySet<string>>> = {
  link: new Set(['http:', 'https:', 'mailto:']),
  image: new Set(['http:', 'https:']),
};

/** A caller-supplied base URL is usable only when it is an absolute http/https URL. */
function usableBase(base: string | undefined): URL | undefined {
  if (!base) return undefined;
  try {
    const url = new URL(base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    // Unparsable base: treat it as absent, so relative links are rejected instead of guessed.
    return undefined;
  }
}

/**
 * Return the destination a renderer may use, or `null` when the destination must not be navigable.
 * Relative URLs are returned resolved against `base`; same-document anchors are returned unchanged.
 */
export function safeMarkdownUrl(
  raw: string | undefined | null,
  base: string | undefined,
  kind: MarkdownUrlKind,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || CONTROL.test(trimmed)) return null;
  // ReactMarkdown has already decoded CommonMark escapes and character references.
  const decoded = trimmed;
  if (!decoded || CONTROL.test(decoded)) return null;
  if (decoded.startsWith('#')) return kind === 'link' && !/\s/.test(decoded.slice(1)) ? decoded : null;
  // Whitespace inside a scheme is stripped by URL parsers, so the scheme probe ignores it too.
  const probe = decoded.replace(/[\u0000-\u0020]+/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (scheme && !ALLOWED[kind].has(`${scheme[1]!.toLowerCase()}:`)) return null;
  let resolved: URL;
  try {
    resolved = new URL(decoded, usableBase(base));
  } catch {
    // Relative destination without a usable base, or a malformed URL: do not navigate anywhere.
    return null;
  }
  return ALLOWED[kind].has(resolved.protocol) ? resolved.href : null;
}
