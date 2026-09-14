/**
 * Small, explicit highlight.js subset for fenced code (Sprint 24a).
 *
 * Only the languages the workbench actually stores are registered, so the browser bundle does not
 * carry highlight.js' full registry. Highlighting is returned as a tiny plain tree that the renderer
 * turns into React `<span>` elements; no HTML string is ever produced. An unknown language, a very
 * large block or a grammar failure returns `null`, and the caller then renders the exact code text.
 */
import { createLowlight } from 'lowlight';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';

/** Registered fence languages; every other fence stays plain, readable code. */
export const HIGHLIGHT_LANGUAGES: readonly string[] = Object.freeze([
  'c', 'cpp', 'python', 'java', 'javascript', 'typescript', 'json', 'bash',
]);

/** Code longer than this is shown without highlighting, so a huge paste cannot stall the page. */
export const MAX_HIGHLIGHT_CHARS = 20000;

/** Common fence spellings mapped onto a registered grammar. */
const ALIASES: Readonly<Record<string, string>> = {
  'c++': 'cpp', cplusplus: 'cpp', py: 'python', python3: 'python', js: 'javascript',
  node: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
};

/** One highlighted span or a literal string; the renderer maps this onto React elements. */
export interface HighlightNode {
  readonly className: string | null;
  readonly children: readonly HighlightChild[];
}

/** A highlighted fragment: either literal text or one nested `<span class="hljs-…">`. */
export type HighlightChild = HighlightNode | string;

const lowlight = createLowlight();
lowlight.register({ c, cpp, python, java, javascript, typescript, json, bash });

function convert(node: { type: string; value?: unknown; properties?: unknown; children?: unknown }): HighlightChild | null {
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : '';
  if (node.type !== 'element') return null;
  const properties = node.properties as { className?: unknown } | undefined;
  const raw = properties?.className;
  const names = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : typeof raw === 'string' ? [raw] : [];
  const children = Array.isArray(node.children)
    ? node.children.map(child => convert(child as Parameters<typeof convert>[0])).filter((child): child is HighlightChild => child !== null)
    : [];
  return { className: names.length ? names.join(' ') : null, children };
}

/**
 * Highlight `code` as `language`, or return `null` when the exact text must be rendered instead:
 * unknown or unregistered language, input above `MAX_HIGHLIGHT_CHARS`, or a grammar failure.
 */
export function highlightCode(code: string, language: string): readonly HighlightChild[] | null {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const requested = language.trim().toLowerCase();
  const name = ALIASES[requested] ?? requested;
  if (!name || !lowlight.registered(name)) return null;
  try {
    const tree = lowlight.highlight(name, code);
    return tree.children
      .map(child => convert(child as Parameters<typeof convert>[0]))
      .filter((child): child is HighlightChild => child !== null);
  } catch {
    // highlight.js refused this input; the caller still shows the exact code text, so nothing is lost.
    return null;
  }
}
