/**
 * Local Markdown renderer for stored problem material and AI text (Sprint 24a, extended in 24b).
 *
 * Everything is rendered in-process from a stored string: no storage access, no AI call, no
 * platform call and no network fetch of its own. The exact original text always stays available
 * behind the "查看原文" disclosure, so a rendering decision can never hide what was stored.
 *
 * Safety rules enforced here:
 * - raw HTML is never enabled (no rehype-raw, no MDX): HTML stays literal or omitted, and the
 *   original is still one disclosure away;
 * - links and images accept only http/https (plus mailto and same-document anchors for links) and
 *   resolve relative URLs against the caller-supplied base URL, never against `window.location`;
 * - a Luogu directive never forwards an input attribute: only fixed, scoped classes are emitted, and
 *   only the *presence* of `open`/`tuack` is read (`markdown/extensions.ts`);
 * - code highlighting is a registered highlight.js subset rendered as React spans, never as HTML;
 * - line numbers and line-range highlighting are presentation only: they live outside the `<code>`
 *   element, so the code text and the copy button stay exact;
 * - a Bilibili image link that names a video page becomes an external "打开视频" link; no iframe,
 *   script, autoplay or provider request is ever added (deliberate boundary, see the docs);
 * - math is KaTeX with `trust: false`, and invalid math keeps its original expression visible.
 *
 * This implementation lives in a `.ts` module (built with `createElement`) because the repository's
 * test runner strips types without transforming JSX; `src/ui/MarkdownView.tsx` re-exports it as the
 * public component location. Both modules are interchangeable to importers.
 */
import { createContext, createElement, isValidElement, useContext, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import type { Element } from 'hast';
import Markdown from 'react-markdown';
import { highlightCode } from './highlight.js';
import type { HighlightChild } from './highlight.js';
import { adaptLegacyLuoguSamples } from './luogu-samples.js';
import { markdownPlugins } from './plugins.js';
import { safeMarkdownUrl } from './url-policy.js';

/** Stored text longer than this is shown as original text instead of being parsed. */
export const MAX_MARKDOWN_CHARS = 250000;

/** Longest code block that still receives line numbers or a range highlight (presentation bound). */
export const MAX_META_LINES = 5000;

/**
 * Display-only source hint. `luogu` enables the view-only legacy sample adapter
 * (`markdown/luogu-samples.ts`); callers must resolve it from the problem's own source instance, so
 * an editorial, a coaching answer or another platform's text is never treated as a Luogu statement.
 */
export type MarkdownSource = 'luogu';

/** Props of the public renderer. */
export interface MarkdownViewProps {
  /** Exact stored text; it is never modified, truncated or replaced by a placeholder. */
  readonly text: string;
  /** Validated http/https page used to resolve relative links; never a localhost window URL. */
  readonly baseUrl?: string;
  /** Accessible name of the rendered region. */
  readonly label?: string;
  /** Display-only source hint; only `luogu` changes how the text is displayed, never what is stored. */
  readonly source?: MarkdownSource;
}

type MarkdownComponents = NonNullable<ComponentProps<typeof Markdown>['components']>;
type CopyState = 'idle' | 'copied' | 'failed';

/** Base URL shared with the link/image renderers; `undefined` makes relative destinations inert. */
const baseUrlContext = createContext<string | undefined>(undefined);

/** Flatten markdown-generated children back to text; used only to recover exact code content. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** Turn the plain highlight tree into React spans; every string child is escaped by React. */
function renderHighlight(children: readonly HighlightChild[], keyPrefix: string): ReactNode {
  return children.map((child, index) => typeof child === 'string'
    ? child
    : createElement(
      'span',
      { key: `${keyPrefix}${index}`, className: child.className ?? undefined },
      renderHighlight(child.children, `${keyPrefix}${index}-`),
    ));
}

/**
 * Split a highlight tree into one child list per source line, reopening highlight spans at every
 * line break: a comment or string that spans lines keeps its `hljs-*` span on each of them.
 */
function splitIntoLines(children: readonly HighlightChild[]): HighlightChild[][] {
  const lines: HighlightChild[][] = [[]];
  const current = (): HighlightChild[] => lines[lines.length - 1] ?? [];
  for (const child of children) {
    if (typeof child === 'string') {
      child.split('\n').forEach((part, index) => {
        if (index > 0) lines.push([]);
        if (part.length > 0) current().push(part);
      });
      continue;
    }
    splitIntoLines(child.children).forEach((piece, index) => {
      if (index > 0) lines.push([]);
      current().push({ className: child.className, children: piece });
    });
  }
  return lines;
}

/** The parsed fence meta of one code block; anything else stays inert in `data-code-info`. */
export interface CodeMetaView {
  /** `true` when the fence asked for a visible line-number gutter. */
  readonly lineNumbers: boolean;
  /** Inclusive 1-based line range to highlight, or `null` when none was requested or it is invalid. */
  readonly range: { readonly start: number; readonly end: number } | null;
}

/**
 * Parse `line-numbers` and `lines=<start>[-<end>]` from a fence info string.
 *
 * The flags may appear together in any order. A malformed flag (`lines=abc`, `lines=5-2`, `lines=0`,
 * a range outside the block, `lines=1-99999999`) is ignored instead of being guessed or clipped, so
 * it can never change the displayed code text. Only the flags are read: every other token survives
 * untouched in `data-code-info`.
 */
export function parseCodeMeta(meta: string, lineCount: number): CodeMetaView {
  let lineNumbers = false;
  let range: { start: number; end: number } | null = null;
  for (const token of meta.split(/\s+/u)) {
    if (token === 'line-numbers') {
      lineNumbers = true;
      continue;
    }
    const match = /^lines=(\d{1,7})(?:-(\d{1,7}))?$/u.exec(token);
    if (match?.[1] === undefined) continue;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue;
    if (start < 1 || end < start || end > lineCount) continue;
    range = { start, end };
  }
  return { lineNumbers, range };
}

/** The visible gutter text; the gutter is `aria-hidden` and outside `<code>`, so it is never copied. */
function gutterText(lineCount: number): string {
  const numbers: string[] = [];
  for (let line = 1; line <= lineCount; line += 1) numbers.push(String(line));
  return numbers.join('\n');
}

/**
 * Line-wrapped code: one block span per line with the literal newlines kept between them.
 *
 * The surrounding `<code>` switches to `white-space: normal` for this shape, so the newline text
 * nodes between the block spans render as nothing extra, while each line keeps its own `pre`
 * whitespace and the code element's text content still equals the exact code string.
 */
function renderCodeLines(
  children: readonly HighlightChild[],
  lineCount: number,
  range: { readonly start: number; readonly end: number } | null,
): ReactNode {
  const lines = splitIntoLines(children);
  while (lines.length < lineCount) lines.push([]);
  const nodes: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push('\n');
    const active = range !== null && index + 1 >= range.start && index + 1 <= range.end;
    nodes.push(createElement(
      'span',
      { key: `line-${index}`, className: active ? 'icpc-code-line icpc-code-line-active' : 'icpc-code-line' },
      renderHighlight(line, `line-${index}-`),
    ));
  });
  return nodes;
}

/** Copy with an honest result: the button reports failure instead of claiming a copy happened. */
async function copyTextToClipboard(text: string, setState: (state: CopyState) => void): Promise<void> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') throw Error('clipboard unavailable');
    await clipboard.writeText(text);
    setState('copied');
  } catch {
    setState('failed');
  }
}

/**
 * One fenced (or indented) code block. `language` is the leading fence name used for highlighting;
 * `meta` is the rest of the fence info string, parsed by {@link parseCodeMeta}; `info` is the exact
 * fence info string, kept in the DOM as `data-code-info` so the original request stays inspectable.
 * `code` is always the exact stored text, and the copy button copies exactly it.
 */
function CodeBlock({ code, language, info, meta }: { readonly code: string; readonly language: string; readonly info: string; readonly meta: string }) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const highlighted = language ? highlightCode(code, language) : null;
  const lineCount = code.length === 0 ? 1 : code.split('\n').length;
  const metaView = parseCodeMeta(meta, lineCount);
  const withinBound = lineCount <= MAX_META_LINES;
  const numbered = metaView.lineNumbers && withinBound;
  const range = withinBound ? metaView.range : null;
  const structured = numbered || range !== null;
  const classNames = [language ? `language-${language}` : '', structured ? 'icpc-code-lines' : ''].filter((name) => name.length > 0);
  return createElement(
    'div',
    { className: numbered ? 'icpc-code icpc-code-numbered' : 'icpc-code' },
    createElement(
      'div',
      { className: 'icpc-code-head' },
      createElement('span', { className: 'icpc-code-lang' }, language || '纯文本'),
      createElement(
        'button',
        { type: 'button', className: 'icpc-code-copy', onClick: () => { void copyTextToClipboard(code, setCopy); } },
        copy === 'copied' ? '已复制' : copy === 'failed' ? '复制失败' : '复制代码',
      ),
    ),
    createElement(
      'pre',
      null,
      numbered
        ? createElement('span', { className: 'icpc-code-gutter', 'aria-hidden': 'true' }, gutterText(lineCount))
        : null,
      createElement(
        'code',
        { ...(classNames.length > 0 ? { className: classNames.join(' ') } : {}), ...(info ? { 'data-code-info': info } : {}) },
        structured
          ? renderCodeLines(highlighted ?? [code], lineCount, range)
          : highlighted ? renderHighlight(highlighted, '') : code,
      ),
    ),
  );
}

/** Fence tokens that are meta flags rather than a language name. CommonMark puts the first info word
 *  into `lang`, so a fence written as ```` ```line-numbers ```` must still be read as meta. */
const META_TOKEN = /^(?:line-numbers|lines=\d{1,7}(?:-\d{1,7})?)$/u;

/** `<pre>` is only produced by fenced or indented code, so every block code path goes through here.
 *  The fence meta (for example `line-numbers=10`) lives on the hast `<code>` node, which is why the
 *  override reads `node` instead of the child element's props. */
function MarkdownPre({ children, node }: { readonly children?: ReactNode; readonly node?: Element }) {
  const only = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string; children?: ReactNode }>(only)) {
    return createElement('pre', null, children);
  }
  const className = typeof only.props.className === 'string' ? only.props.className : '';
  const token = /language-(\S+)/.exec(className)?.[1] ?? '';
  const codeNode = node?.children.find((child): child is Element => child.type === 'element');
  const data = codeNode?.data as Record<string, unknown> | undefined;
  const metaText = typeof data?.meta === 'string' ? data.meta.trim() : '';
  const info = metaText ? `${token} ${metaText}` : token;
  const tokenIsMeta = META_TOKEN.test(token);
  const language = tokenIsMeta ? '' : token.split(':')[0] ?? '';
  const meta = tokenIsMeta ? `${token} ${metaText}`.trim() : metaText;
  // mdast-util-to-hast appends one newline to every code value; removing exactly that one restores
  // the fenced source text instead of inventing or dropping content.
  const rendered = textOf(only.props.children);
  const code = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
  return createElement(CodeBlock, { code, language, info, meta });
}

/** Links: blocked destinations keep the label text, external links open in a new tab. */
function MarkdownLink({ href, children, title }: { readonly href?: string; readonly children?: ReactNode; readonly title?: string }) {
  const base = useContext(baseUrlContext);
  const safe = safeMarkdownUrl(href, base, 'link');
  if (!safe) {
    return createElement(
      'span',
      { className: 'icpc-markdown-blocked-link', title: '已阻止不安全或缺少基准地址的链接' },
      children,
    );
  }
  const external = safe.startsWith('http://') || safe.startsWith('https://');
  return createElement(
    'a',
    { href: safe, ...(title ? { title } : {}), ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) },
    children,
  );
}

/** Hosts that serve Bilibili video pages; every other host stays an ordinary image. */
const BILIBILI_VIDEO_HOSTS: ReadonlySet<string> = new Set([
  'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'player.bilibili.com',
]);

/**
 * `true` only for a URL that names a recognizable Bilibili video or player page.
 *
 * The check is deliberately narrow: a video path (`/video/BV…` or `/video/av…`) on an official host,
 * or the official player page carrying a `bvid`/`aid`. A short link, a space or any other Bilibili
 * page is *not* recognized and keeps the ordinary image treatment.
 */
function isBilibiliVideoUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL: the caller already restricted destinations to http/https, so this is
    // simply not a recognizable video page.
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!BILIBILI_VIDEO_HOSTS.has(host)) return false;
  const path = parsed.pathname.replace(/\/+$/u, '');
  if (host === 'player.bilibili.com') {
    if (path !== '/player.html' && path !== '/player') return false;
    const bvid = parsed.searchParams.get('bvid') ?? '';
    const aid = parsed.searchParams.get('aid') ?? '';
    return /^BV[0-9A-Za-z]{10}$/u.test(bvid) || /^\d{1,15}$/u.test(aid);
  }
  return /^\/video\/(?:BV[0-9A-Za-z]{10}|av\d{1,15})$/u.test(path);
}

/**
 * Images: blocked destinations fall back to the alt text, load failures do the same.
 *
 * A Bilibili video page is never embedded: it becomes a plain external link instead (no iframe, no
 * script, no autoplay, no provider request from the renderer).
 */
function MarkdownImage({ src, alt, title }: { readonly src?: string; readonly alt?: string; readonly title?: string }) {
  const base = useContext(baseUrlContext);
  const safe = safeMarkdownUrl(src, base, 'image');
  const text = alt && alt.trim() ? alt : '图片';
  if (!safe) return createElement('span', { className: 'icpc-markdown-image-fallback' }, `图片：${text}`);
  if (isBilibiliVideoUrl(safe)) {
    return createElement(
      'a',
      {
        className: 'icpc-markdown-video-link',
        href: safe,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Bilibili 视频链接：本地渲染不嵌入播放器，只在浏览器中打开原页面',
      },
      `打开视频：${text}`,
    );
  }
  return createElement(ImageWithFallback, { key: safe, src: safe, alt: text, title });
}

/** Stateful only for the load-failure fallback; the URL was validated by the caller. */
function ImageWithFallback({ src, alt, title }: { readonly src: string; readonly alt: string; readonly title?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return createElement('span', { className: 'icpc-markdown-image-fallback' }, `图片加载失败：${alt}`);
  return createElement('img', {
    className: 'icpc-markdown-image',
    src,
    alt,
    loading: 'lazy',
    referrerPolicy: 'no-referrer',
    ...(title ? { title } : {}),
    onError: () => setFailed(true),
  });
}

const components: MarkdownComponents = { a: MarkdownLink, img: MarkdownImage, pre: MarkdownPre };

/**
 * The rendered form of `text`, without the original-text disclosure. Exported so tests (and callers
 * that frame the content themselves) can render exactly this tree with `renderToStaticMarkup`.
 *
 * `source: 'luogu'` applies the view-only legacy sample adapter first; the adapter is idempotent and
 * is a no-op on the already-fenced format, so it can be passed unconditionally by a Luogu surface.
 */
export function MarkdownContent({ text, baseUrl, source }: { readonly text: string; readonly baseUrl?: string; readonly source?: MarkdownSource }) {
  const plugins = markdownPlugins();
  const prepared = source === 'luogu' ? adaptLegacyLuoguSamples(text).text : text;
  return createElement(
    baseUrlContext.Provider,
    { value: baseUrl },
    createElement(
      Markdown,
      { remarkPlugins: plugins.remarkPlugins, rehypePlugins: plugins.rehypePlugins, components },
      prepared,
    ),
  );
}

/**
 * Public renderer: `text` rendered as local Markdown plus a "查看原文" disclosure holding the exact
 * original. Content above `MAX_MARKDOWN_CHARS` is not parsed at all — the notice is shown and the
 * disclosure opens with the complete original, so nothing is ever silently truncated.
 *
 * `source` only changes the displayed form: the disclosure always shows the untouched `text`.
 */
export function MarkdownView({ text, baseUrl, label = '内容', source }: MarkdownViewProps) {
  const oversize = text.length > MAX_MARKDOWN_CHARS
    || (source === 'luogu' && adaptLegacyLuoguSamples(text).text.length > MAX_MARKDOWN_CHARS);
  return createElement(
    'section',
    { className: 'icpc-markdown', 'aria-label': label },
    oversize
      ? createElement(
        'p',
        { className: 'icpc-markdown-oversize' },
        `内容共 ${text.length} 个字符，超过 ${MAX_MARKDOWN_CHARS} 字符的渲染上限：为避免阻塞未做 Markdown 渲染，完整原文见下方。`,
      )
      : createElement(MarkdownContent, { text, baseUrl, source }),
    createElement(
      'details',
      { className: 'icpc-markdown-source', ...(oversize ? { open: true } : {}) },
      createElement('summary', null, '查看原文'),
      createElement('pre', { className: 'icpc-markdown-raw' }, text),
    ),
  );
}
