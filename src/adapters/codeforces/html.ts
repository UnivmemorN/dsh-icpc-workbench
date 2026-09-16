/**
 * HTML → plain text and Codeforces page-structure extraction.
 *
 * All third-party HTML is converted to plain text; nothing here renders HTML and nothing uses
 * regex stripping of markup. The text renderer keeps the information a solver needs — text,
 * `<sub>`/`<sup>` content, inline `math/tex` source and image `alt` text — while dropping
 * scripts, styles and other non-content nodes.
 */
import { parseDocument } from 'htmlparser2';
import { findAll, findOne, removeElement } from 'domutils';
import { cloneNode, hasChildren, isTag, isText, type AnyNode, type Document, type Element } from 'domhandler';

/** Elements that start a new text block in the plain-text rendering. */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'caption',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Non-content elements that never contribute text. */
export const SKIPPED_TEXT_TAGS: ReadonlySet<string> = new Set([
  'head',
  'title',
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
]);

/**
 * Block elements that contain *nested* blocks.
 *
 * `br` is a block boundary in the text rendering but is an inline line break inside a `<p>`,
 * so it is deliberately absent here: treating it as a nested block made a paragraph split
 * into one-line children whose surrounding prose was dropped.
 */
export const NESTED_BLOCK_TAGS: ReadonlySet<string> = new Set(
  [...BLOCK_TAGS].filter((tag) => tag !== 'br'),
);

/** `script[type="math/tex"]` carries the TeX source of a formula and is kept as text. */
const MATH_SCRIPT_TYPE = /^math\/tex/u;
const CHALLENGE_MARKERS: readonly string[] = [
  'cf-challenge',
  'challenge-platform',
  'challenge-form',
  'cf-browser-verification',
  'just a moment',
  'enable javascript and cookies',
  'attention required',
];

/** Parse HTML with entity decoding; the returned tree is the only markup view used. */
export function parseHtml(html: string): Document {
  return parseDocument(html, { decodeEntities: true });
}

/** Collapse whitespace while preserving paragraph breaks. */
export function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v\u00a0 ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function render(nodes: readonly AnyNode[], out: string[]): void {
  for (const node of nodes) {
    if (isText(node)) {
      out.push(node.data);
      continue;
    }
    if (!isTag(node)) {
      // Document/CDATA containers carry no text of their own; descend into them.
      if (hasChildren(node)) {
        render(node.children, out);
      }
      continue;
    }
    const tag = node.name.toLowerCase();
    if (tag === 'script') {
      if (MATH_SCRIPT_TYPE.test(node.attribs.type ?? '')) {
        out.push(' ', node.children.filter(isText).map((child) => child.data).join(''), ' ');
      }
      continue;
    }
    if (SKIPPED_TEXT_TAGS.has(tag)) {
      continue;
    }
    if (tag === 'img') {
      const alt = (node.attribs.alt ?? '').trim();
      if (alt.length > 0) {
        out.push(' ', alt, ' ');
      }
      continue;
    }
    if (tag === 'br') {
      out.push('\n');
      continue;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) {
      out.push('\n');
    }
    // Sub/superscript keep an explicit marker so `2^n` and `a_i` stay unambiguous in plain text.
    if (tag === 'sup' || tag === 'sub') {
      out.push(tag === 'sup' ? '^' : '_');
    }
    render(node.children, out);
    if (block) {
      out.push('\n');
    }
  }
}

/**
 * Render a node (or nodes) to normalized plain text.
 *
 * A raw HTML string is accepted as well, so a downloaded body can be checked directly without
 * building a tree by hand.
 */
export function htmlToPlainText(root: string | AnyNode | readonly AnyNode[]): string {
  const nodes: readonly AnyNode[] =
    typeof root === 'string' ? [parseHtml(root)] : Array.isArray(root) ? root : [root as AnyNode];
  const out: string[] = [];
  render(nodes, out);
  return normalizePlainText(out.join(''));
}

/** Single-line label text of an element, used for headings, links and tag boxes. */
export function labelTextOf(element: Element): string {
  return htmlToPlainText(element).replace(/\n+/gu, ' ');
}

/** True when the element carries `name` as one of its whitespace-separated classes. */
export function hasClass(element: Element, name: string): boolean {
  return (element.attribs.class ?? '').split(/\s+/u).includes(name);
}

/**
 * Detect a bot/anti-authentication challenge page.
 *
 * Returns the matched marker so the caller can report *why* the page was refused; a challenge
 * page must never be parsed as a statement.
 */
export function detectChallengePage(html: string): string | null {
  const sample = html.slice(0, 40_000).toLowerCase();
  for (const marker of CHALLENGE_MARKERS) {
    if (sample.includes(marker)) {
      return marker;
    }
  }
  return null;
}

/** Short plain-text snippet of a response, for `changed_response` diagnostics. */
export function sampleOfHtml(html: string, maxChars = 180): string {
  return normalizePlainText(html.slice(0, 2000)).slice(0, maxChars);
}

export interface ProblemPageContent {
  readonly title: string;
  readonly statement: string;
  /**
   * The statement body with the page *furniture* removed: no problem number, no title, no
   * time/memory limit, no input/output file names and no tag boxes.
   *
   * Two divisions of one shared round render the same problem under different letters and their own
   * titles, so a comparison of the whole statement would differ for reasons that say nothing about
   * the problem. This member isolates what the problem actually asks — body, constraints,
   * input/output and samples — and is the only part a shared-round equivalence check may compare.
   */
  readonly intrinsicStatement: string;
  readonly rawTags: readonly string[];
  /** Parsed from the `*NNNN` tag box; `null` when the page does not report a rating. */
  readonly rating: number | null;
  /**
   * The Tutorial blog this page links to, or `null` when it links none.
   *
   * It is read together with the statement so a caller can prove that two problem pages point at the
   * *same* tutorial blog without a second parse. `null` is incomplete discovery — the page may simply
   * not link a tutorial — and never evidence that no editorial exists.
   */
  readonly tutorialBlogId: number | null;
}

export type ProblemPageResult =
  | { readonly ok: true; readonly page: ProblemPageContent }
  | {
      readonly ok: false;
      readonly reason: 'missing_statement' | 'missing_title' | 'empty_statement';
      readonly detail: string;
      readonly sample: string | null;
    };

const RATING_TAG_BOX = /^\*(\d{2,4})$/u;
/** Header furniture of `.problem-statement`: a title/time-limit box, never statement body. */
const NON_BODY_CLASSES: readonly string[] = ['header', 'title', 'time-limit', 'memory-limit', 'input-file', 'output-file'];

/**
 * The `*NNNN` difficulty and the raw tag labels of one page.
 *
 * Codeforces renders these `span.tag-box` nodes in a box *around* `div.problem-statement` as
 * well as inside it, so the whole document is searched and every box is attributed to this
 * page's metadata. The rating is the first `*NNNN` box; the rest are raw tags.
 */
function collectTagMetadata(document: Document): { readonly rawTags: readonly string[]; readonly rating: number | null } {
  const rawTags: string[] = [];
  let rating: number | null = null;
  for (const box of findAll((element) => hasClass(element, 'tag-box'), document)) {
    const text = labelTextOf(box);
    const match = RATING_TAG_BOX.exec(text);
    if (match) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && rating === null) {
        rating = value;
      }
      continue;
    }
    if (text.length > 0) {
      rawTags.push(text);
    }
  }
  return { rawTags, rating };
}

/** True when a node is statement furniture (title/time-limit header) rather than body content. */
function isFurniture(element: Element): boolean {
  const names = (element.attribs.class ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .filter((name) => name.length > 0);
  return names.length > 0 && names.every((name) => NON_BODY_CLASSES.includes(name));
}

/**
 * Deep copies of `nodes` with every `tag-box` metadata node removed.
 *
 * The copies come from the public `cloneNode`, so the page's own tree keeps its parent links;
 * assembling the copy by hand used to reparent the original text nodes into the copy.
 */
function withoutMetadata(nodes: readonly AnyNode[]): AnyNode[] {
  const kept: AnyNode[] = [];
  for (const node of nodes) {
    if (isTag(node) && hasClass(node, 'tag-box')) {
      continue;
    }
    const copy = cloneNode(node, true);
    if (isTag(copy)) {
      for (const box of findAll((element) => hasClass(element, 'tag-box'), [copy])) {
        removeElement(box);
      }
    }
    kept.push(copy);
  }
  return kept;
}

/**
 * True when the statement children carry content beyond their title/time-limit header.
 *
 * A `.problem-statement` that only holds `.header`/`.title` (or metadata boxes that were just
 * stripped) is a fragment, so it must be refused instead of being reported as a problem whose
 * statement is just its title.
 */
function hasStatementBody(nodes: readonly AnyNode[]): boolean {
  return nodes.some((child) => isTag(child) && !isFurniture(child) && htmlToPlainText(child).length > 0);
}

/**
 * Extract the statement of one problem page.
 *
 * Only the identified `.problem-statement` node is accepted; a page without it (a challenge,
 * an error page, a changed layout) is a failure, never an empty statement. A node that only
 * carries the title header (no statement body) is refused as `empty_statement` instead of
 * being reported as a title-only problem. The `tag-box` metadata is read from the whole
 * document, because the platform renders it outside `.problem-statement` too.
 */
export function extractProblemPage(html: string): ProblemPageResult {
  const document = parseHtml(html);
  const statement = findOne((element) => hasClass(element, 'problem-statement'), document);
  if (statement === null) {
    return {
      ok: false,
      reason: 'missing_statement',
      detail: 'the page has no .problem-statement node',
      sample: sampleOfHtml(html),
    };
  }
  const titleElement = findOne((element) => hasClass(element, 'title'), statement);
  const title = (titleElement === null ? '' : labelTextOf(titleElement)).replace(/^[A-Z][1-9]?\.\s*/u, '').trim();
  if (title.length === 0) {
    return {
      ok: false,
      reason: 'missing_title',
      detail: 'the .problem-statement node has no usable title',
      sample: sampleOfHtml(html),
    };
  }
  const bodyNodes = withoutMetadata(statement.children);
  const statementText = htmlToPlainText(bodyNodes);
  if (statementText.length === 0 || !hasStatementBody(bodyNodes)) {
    return {
      ok: false,
      reason: 'empty_statement',
      detail: 'the .problem-statement node carries a title but no statement body',
      sample: sampleOfHtml(html),
    };
  }
  const metadata = collectTagMetadata(document);
  return {
    ok: true,
    page: {
      title,
      statement: statementText,
      intrinsicStatement: htmlToPlainText(intrinsicNodes(statement.children)),
      rawTags: metadata.rawTags,
      rating: metadata.rating,
      tutorialBlogId: findTutorialBlogId(html),
    },
  };
}

/**
 * The statement children with every page-furniture subtree removed.
 *
 * It is a *stronger* strip than {@link withoutMetadata}, which only drops tag boxes: the header,
 * title, time/memory limit and input/output file rows go as well, because none of them is a fact
 * about the problem. What remains is the body, the constraints, the input/output sections and the
 * samples — the part two divisions of one shared round must spell identically.
 */
function intrinsicNodes(nodes: readonly AnyNode[]): readonly AnyNode[] {
  const kept: AnyNode[] = [];
  for (const node of nodes) {
    if (isTag(node) && isFurniture(node)) {
      continue;
    }
    const copy = cloneNode(node, true);
    if (isTag(copy)) {
      for (const box of findAll((element) => hasClass(element, 'tag-box'), [copy])) {
        removeElement(box);
      }
    }
    kept.push(copy);
  }
  return kept;
}

const BLOG_PATH = /^\/blog\/entry\/(\d{1,9})\/?$/u;

/** Extract the blog entry id from an official codeforces.com blog href, or `null`. */
export function blogIdFromHref(href: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(href, 'https://codeforces.com');
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://codeforces.com') {
    return null;
  }
  const match = BLOG_PATH.exec(parsed.pathname);
  if (match === null) {
    return null;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function firstTutorialLink(roots: readonly AnyNode[]): number | null {
  for (const anchor of findAll((element) => element.name.toLowerCase() === 'a', roots as AnyNode[])) {
    const id = blogIdFromHref(anchor.attribs.href ?? '');
    if (id === null) {
      continue;
    }
    const text = labelTextOf(anchor).toLowerCase();
    if (text === 'tutorial' || text.startsWith('tutorial ') || text.startsWith('tutorial:')) {
      return id;
    }
  }
  return null;
}

/**
 * Find the Tutorial blog linked from a problem page.
 *
 * Problem/contest boxes are searched first so a "Tutorial"-titled blog link in unrelated page
 * furniture cannot win; the document-wide pass is the fallback. `null` means the link was not
 * found, which is incomplete discovery — not proof that no editorial exists.
 */
export function findTutorialBlogId(html: string): number | null {
  const document = parseHtml(html);
  const scoped = findAll(
    (element) => hasClass(element, 'problem-statement') || hasClass(element, 'roundbox') || hasClass(element, 'sidebar'),
    document,
  );
  const found = firstTutorialLink(scoped);
  return found ?? firstTutorialLink([document]);
}
