/**
 * Pure extractor for one problem's section inside a multi-problem contest editorial.
 *
 * A Codeforces editorial blog usually covers every problem of a contest. Emitting the whole
 * article as "the editorial of problem X" would feed unrelated solutions into evidence
 * verification, so the target section is identified on the HTML tree, never by regex stripping:
 *
 * - a section starts only at an *explicit* reference: an h1–h6 label that leads with
 *   `/contest/N/problem/I`, `/problemset/problem/N/I` or an explicit `NNN I` / `NNN/I` reference,
 *   or a paragraph whose whole content is such problem links. A bare index (`A`, `B`, `A/B`)
 *   never starts a section, not even when another heading names the blog's contest;
 * - a heading may pair aliases (`455B/456C`) and matches when one of them is the target. A link
 *   inside prose is body text, so a reference in an explanation cannot split a section;
 * - the section keeps method subheadings (`Idea`, `Solution 2`) and ends at the next *problem*
 *   heading, or at a bare index heading such as `<h3>B</h3>`. A legacy article that packs several
 *   problems into one long paragraph therefore has no heading and is refused instead of being
 *   emitted whole;
 * - a missing or ambiguous heading, and a heading without non-heading body text, are explicit
 *   failures the caller reports as `changed_response`, never a silent whole-article success.
 *
 * The extractor is exported on its own so downloaded live bodies can be checked directly,
 * without constructing an adapter.
 */
import type { AnyNode, Element } from 'domhandler';
import { isTag, isText } from 'domhandler';
import { PlatformError } from '../../application/platform-errors.js';
import {
  BLOCK_TAGS,
  NESTED_BLOCK_TAGS,
  SKIPPED_TEXT_TAGS,
  htmlToPlainText,
  labelTextOf,
  normalizePlainText,
  parseHtml,
} from './html.js';
import {
  cfProblemExternalKey,
  normalizeCfProblemIndex,
  parseOfficialProblemPath,
} from './problem-index.js';

export interface EditorialTarget {
  readonly contestId: number;
  /** Problem index, e.g. `A`, `B2`, `14` or `D10` (case-insensitive). */
  readonly index: string;
}

/** One explicit problem reference found in a heading. */
export interface HeadingRef {
  readonly contestId: number | null;
  readonly index: string;
}

export interface EditorialSection {
  readonly ok: true;
  readonly text: string;
  readonly headingText: string;
  readonly matchedReferences: readonly string[];
}

export type EditorialSectionFailureReason = 'missing' | 'ambiguous' | 'empty';

export interface EditorialSectionFailure {
  readonly ok: false;
  readonly reason: EditorialSectionFailureReason;
  readonly detail: string;
  /** Recognized headings (bounded) for diagnostics. */
  readonly sample: string | null;
  readonly headings: readonly string[];
}

export type EditorialSectionResult = EditorialSection | EditorialSectionFailure;

const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const MAX_LABEL_CHARS = 120;
const MAX_TITLE_TAIL_CHARS = 80;
const MAX_DIAGNOSTIC_HEADINGS = 8;
const BLOG_PATH = /^\/blog\/entry\/(\d{1,9})\/?$/u;
/** A title continuation must start with one of these after a problem reference. */
const TITLE_SEPARATOR = /^[.:)—–\-,|/]/u;
/** Stands in for one explicit reference while a heading label is checked; never in real text. */
const REFERENCE_MARK = '\u0001';
/** A bare index token: `A`, `B2`, `D10`. */
const BARE_TOKEN = String.raw`[A-Za-z](?:[1-9][0-9]*)?`;
/** An explicit reference token: `455A`, `921/01`. */
const REFERENCE_TOKEN = String.raw`\d{2,7}(?:\s*\/\s*[0-9]{1,3}|${BARE_TOKEN})`;
/** An explicit reference in prose: a contest id followed by a letter or numeric index. */
const EXPLICIT_REFERENCE = new RegExp(
  String.raw`(\d{2,7})(?:\s*\/\s*([0-9]{1,3})|(${BARE_TOKEN})(?![A-Za-z0-9]))`,
  'gu',
);
/** A bare index that is neither preceded nor followed by another alphanumeric character. */
const BARE_REFERENCE = new RegExp(String.raw`(?<![A-Za-z0-9])(${BARE_TOKEN})(?![A-Za-z0-9])`, 'gu');
/** A whole text run that is only references: `A`, `A/B`, `455A/456C`, `A and B`. */
const REFERENCE_ONLY_TEXT = new RegExp(
  String.raw`^\s*(?:${REFERENCE_TOKEN}|${BARE_TOKEN})(?:\s*(?:[/,&+]|and)\s*(?:${REFERENCE_TOKEN}|${BARE_TOKEN}))*\s*$`,
  'iu',
);
/** A label that *leads* with references and then carries at most a short title. */
const REFERENCE_LABEL = new RegExp(
  String.raw`^\s*${REFERENCE_MARK}(?:\s*(?:[/,&+]|and)\s*${REFERENCE_MARK})*\s*(.*)$`,
  'su',
);

/**
 * Validate a caller-supplied official tutorial URL and return its blog entry id.
 *
 * Only `https://codeforces.com/blog/entry/<id>` on the default port with no credentials in the
 * URL qualifies; the URL is never fetched as given, so it cannot become an arbitrary fetch
 * target.
 */
export function parseCodeforcesBlogUrl(value: string): number {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw invalidTutorialUrl(
      `must be an absolute URL: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw invalidTutorialUrl(`must use https, got ${parsed.protocol}`);
  }
  if (parsed.hostname !== 'codeforces.com') {
    throw invalidTutorialUrl(`must point at codeforces.com, got ${parsed.hostname}`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw invalidTutorialUrl('must not carry credentials in the URL');
  }
  if (parsed.port !== '') {
    throw invalidTutorialUrl(`must use the default https port, got ${parsed.port}`);
  }
  const match = BLOG_PATH.exec(parsed.pathname);
  if (match === null) {
    throw invalidTutorialUrl('must be a Codeforces blog entry (https://codeforces.com/blog/entry/<id>)');
  }
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw invalidTutorialUrl('must name a positive blog entry id');
  }
  return id;
}

/** Caller-supplied tutorial URL that is not an official Codeforces blog entry. */
function invalidTutorialUrl(detail: string): PlatformError {
  return new PlatformError({
    code: 'invalid_input',
    operation: 'editorial',
    retryable: false,
    detail: `official tutorial url ${detail}`,
  });
}

/**
 * Official problem reference from a link href, or `null` for any other link.
 *
 * `http://`/`www.` legacy spellings are accepted so an old editorial still names the same
 * problem; they are identity references only and are never used as a fetch target.
 */
export function problemReferenceFromHref(href: string): HeadingRef | null {
  return parseOfficialProblemPath(href);
}

/** Explicit references of one text run: `455A`, `921/01`, in document order. */
function explicitReferences(text: string): HeadingRef[] {
  const refs: HeadingRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(EXPLICIT_REFERENCE)) {
    const index = normalizeCfProblemIndex(match[2] ?? match[3] ?? '');
    const contestId = Number(match[1]);
    if (index === null || !Number.isSafeInteger(contestId) || contestId <= 0) {
      continue;
    }
    const key = `${contestId}/${index}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ contestId, index });
    }
  }
  return refs;
}

/** Bare indexes of one text run, such as the `B` of a `<h3>B</h3>` label. */
function bareReferences(text: string): HeadingRef[] {
  const refs: HeadingRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(BARE_REFERENCE)) {
    const index = normalizeCfProblemIndex(match[1] ?? '');
    if (index === null || seen.has(index)) {
      continue;
    }
    seen.add(index);
    refs.push({ contestId: null, index });
  }
  return refs;
}

/** Replace every explicit reference with one marker, keeping all other text in place. */
function withReferenceMarks(text: string): string {
  return text.replace(EXPLICIT_REFERENCE, REFERENCE_MARK);
}

/** A heading tail is a short label, not the start of a sentence. */
function looksLikeTitleTail(tail: string): boolean {
  const trimmed = tail.trim();
  if (trimmed.length > MAX_TITLE_TAIL_CHARS) {
    return false;
  }
  if (/[.!?]\s/u.test(trimmed)) {
    return false;
  }
  // A sentence ends with terminal punctuation; a title does not.
  return !/[.!?]$/u.test(trimmed);
}

/** Text after a problem reference: empty, or a separator followed by a short title. */
function titleContinuation(tail: string): boolean {
  const trimmed = tail.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (!TITLE_SEPARATOR.test(trimmed)) {
    return false;
  }
  return looksLikeTitleTail(trimmed.replace(TITLE_SEPARATOR, '').trim());
}

/** A whole text run that is only problem references: `A`, `A/B`, `455A/456C`, `A and B`. */
function isReferenceOnlyText(text: string): boolean {
  return REFERENCE_ONLY_TEXT.test(text);
}

type InlineEntry =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'break' }
  | { readonly kind: 'anchor'; readonly ref: HeadingRef | null; readonly value: string };

function flattenInline(nodes: readonly AnyNode[], out: InlineEntry[]): void {
  for (const node of nodes) {
    if (isText(node)) {
      out.push({ kind: 'text', value: node.data });
      continue;
    }
    if (!isTag(node)) {
      continue;
    }
    const tag = node.name.toLowerCase();
    if (SKIPPED_TEXT_TAGS.has(tag)) {
      continue;
    }
    if (tag === 'br') {
      out.push({ kind: 'break' });
      continue;
    }
    if (tag === 'a') {
      out.push({
        kind: 'anchor',
        ref: problemReferenceFromHref(node.attribs.href ?? ''),
        value: labelTextOf(node),
      });
      continue;
    }
    flattenInline(node.children, out);
  }
}

function containsBlock(element: Element): boolean {
  return element.children.some(
    (child) => isTag(child) && (NESTED_BLOCK_TAGS.has(child.name.toLowerCase()) || containsBlock(child)),
  );
}

/**
 * The block-level nodes of a document, in order.
 *
 * A `<br>` is *not* a nested block: a `<p>` that uses `<br>` for line breaks stays one block,
 * so its surrounding inline text is preserved instead of being dropped.
 */
function collectBlocks(nodes: readonly AnyNode[], out: Element[]): void {
  for (const node of nodes) {
    if (!isTag(node)) {
      continue;
    }
    const tag = node.name.toLowerCase();
    if (SKIPPED_TEXT_TAGS.has(tag)) {
      continue;
    }
    if (!BLOCK_TAGS.has(tag)) {
      collectBlocks(node.children, out);
      continue;
    }
    if (containsBlock(node)) {
      collectBlocks(node.children, out);
      continue;
    }
    out.push(node);
  }
}

interface Block {
  readonly element: Element;
  readonly tag: string;
  readonly text: string;
  /** A problem heading with explicit references: a section start and a section end. */
  readonly heading: boolean;
  /** A bare index heading such as `<h3>B</h3>`: a section end only. */
  readonly boundary: boolean;
  /** Heading references, empty for any other block. */
  readonly refs: readonly HeadingRef[];
}

/** `true` when a parsed reference is an index the adapter can address. */
function isUsableIndex(index: string): boolean {
  return normalizeCfProblemIndex(index) !== null;
}

/** Canonical `455A` / `921/01` spelling of one reference. */
function referenceLabel(ref: HeadingRef): string {
  return ref.contestId === null ? ref.index : cfProblemExternalKey(ref.contestId, ref.index);
}

/** The label run of a block: its inline content up to the first `<br>`. */
function labelOf(entries: readonly InlineEntry[], fallback: string): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'break') {
      break;
    }
    parts.push(entry.kind === 'anchor' ? (entry.ref === null ? entry.value : referenceLabel(entry.ref)) : entry.value);
  }
  const label = normalizePlainText(parts.join(''));
  return label.length > 0 ? label : fallback;
}

/**
 * The inline text with every explicit reference (link or prose token) replaced by one marker.
 *
 * Checking this skeleton instead of the rendered text is what keeps a link that merely *appears*
 * in a paragraph from turning that paragraph into a heading: anything but references and a short
 * title leaves text in front of or behind the marker.
 */
function skeletonOf(entries: readonly InlineEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'break') {
      parts.push('\n');
      continue;
    }
    if (entry.kind === 'anchor') {
      parts.push(entry.ref === null ? entry.value : REFERENCE_MARK);
      continue;
    }
    parts.push(withReferenceMarks(entry.value));
  }
  return parts.join('');
}

/** One deduplicated reference list, keeping document order. */
function dedupeRefs(refs: readonly HeadingRef[]): HeadingRef[] {
  const seen = new Set<string>();
  const unique: HeadingRef[] = [];
  for (const ref of refs) {
    const key = `${ref.contestId ?? ''}/${ref.index}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(ref);
    }
  }
  return unique;
}

/**
 * True when a block is a pure problem label: explicit references first, then at most a short
 * title. A non-heading block (paragraph, list item, plain div) qualifies only when it actually
 * carries official problem links, so a long legacy paragraph that mentions several problems is
 * never mistaken for a heading.
 */
function isHeadingLabel(entries: readonly InlineEntry[], tag: string, text: string, linked: boolean): boolean {
  if (text.length === 0 || text.length > MAX_LABEL_CHARS || text.includes('\n')) {
    return false;
  }
  if (!HEADING_TAGS.has(tag) && !linked) {
    return false;
  }
  // Heading tags may carry a short problem prefix or an author credit. Keep prose stricter.
  let skeleton = skeletonOf(entries);
  if (HEADING_TAGS.has(tag)) {
    skeleton = skeleton.replace(/^\s*(?:Problem|Task)\s*:?[ \t]*/i, '').replace(/\s*\(\s*Author\s*:[^()\r\n]{1,80}\)\s*$/i, '');
  }
  const match = REFERENCE_LABEL.exec(skeleton);
  return match !== null && titleContinuation(match[1] ?? '');
}

/** A heading-tag label that is only bare indexes (`B`, `A/B`): it may end a section, never start one. */
function isBareIndexHeading(tag: string, label: string): boolean {
  return (
    HEADING_TAGS.has(tag) &&
    label.length > 0 &&
    label.length <= MAX_LABEL_CHARS &&
    isReferenceOnlyText(label) &&
    bareReferences(label).length > 0
  );
}

function analyzeBlock(element: Element): Block {
  const tag = element.name.toLowerCase();
  const text = labelTextOf(element);
  const entries: InlineEntry[] = [];
  flattenInline(element.children, entries);
  const linkedRefs: HeadingRef[] = [];
  for (const entry of entries) {
    if (entry.kind === 'anchor' && entry.ref !== null) {
      linkedRefs.push(entry.ref);
    }
  }
  const refs = dedupeRefs(linkedRefs.length > 0 ? linkedRefs : explicitReferences(text));
  const first = refs[0];
  const heading =
    first !== undefined &&
    isUsableIndex(first.index) &&
    isHeadingLabel(entries, tag, text, linkedRefs.length > 0);
  const boundary = !heading && isBareIndexHeading(tag, labelOf(entries, text));
  return { element, tag, text, heading, boundary, refs: heading ? refs : [] };
}

/**
 * Extract the section of `target` from an editorial blog body.
 *
 * `html` may be a full page or the `content` field of `blogEntry.view`; both work because the
 * extractor only looks for problem headings and their following blocks. The returned `text` is
 * plain text: markup, scripts and styles never reach the model.
 */
export function extractEditorialSection(html: string, target: EditorialTarget): EditorialSectionResult {
  const wanted = normalizeCfProblemIndex(target.index);
  if (wanted === null || !Number.isSafeInteger(target.contestId) || target.contestId <= 0) {
    return {
      ok: false,
      reason: 'missing',
      detail: `the target ${JSON.stringify(target)} is not a Codeforces problem`,
      sample: null,
      headings: [],
    };
  }
  const contestId = target.contestId;
  const document = parseHtml(html);
  const elements: Element[] = [];
  collectBlocks(document.children, elements);
  const blocks = elements.map((element) => analyzeBlock(element));
  const headings = blocks
    .filter((block) => (block.heading || block.boundary) && block.text.length > 0)
    .slice(0, MAX_DIAGNOSTIC_HEADINGS)
    .map((block) => block.text);
  const sample = headings.length > 0 ? headings.join(' | ') : null;
  const label = cfProblemExternalKey(contestId, wanted);

  const matches: number[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (
      block !== undefined &&
      block.heading &&
      block.refs.some((ref) => ref.contestId === contestId && ref.index === wanted)
    ) {
      matches.push(index);
    }
  }
  const start = matches[0];
  if (start === undefined) {
    return {
      ok: false,
      reason: 'missing',
      detail: `the blog has no heading that names problem ${label}`,
      sample,
      headings,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      detail: `${matches.length} headings name problem ${label}`,
      sample,
      headings,
    };
  }

  let end = blocks.length;
  for (let index = start + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block !== undefined && (block.heading || block.boundary)) {
      end = index;
      break;
    }
  }
  const startBlock = blocks[start];
  const body = blocks.slice(start + 1, end).map((block) => ({ tag: block.tag, text: htmlToPlainText(block.element) }));
  const bodyTexts = body.map((entry) => entry.text).filter((value) => value.length > 0);
  // Method subheadings stay in the section, but a heading cannot be the whole body: a section
  // that only repeats headings is an empty failure, never a successful extraction.
  const hasBodyText = body.some((entry) => entry.text.length > 0 && !HEADING_TAGS.has(entry.tag));
  if (startBlock === undefined || !hasBodyText) {
    return {
      ok: false,
      reason: 'empty',
      detail: `the section heading for problem ${label} has no body text`,
      sample,
      headings,
    };
  }
  return {
    ok: true,
    text: normalizePlainText([startBlock.text, ...bodyTexts].join('\n\n')),
    headingText: startBlock.text,
    matchedReferences: startBlock.refs.map((ref) => referenceLabel(ref)),
  };
}
