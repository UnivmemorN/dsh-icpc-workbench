/**
 * Plugin extension point for the local Markdown renderer (Sprint 24a, extended in 24b).
 *
 * Everything the renderer understands is registered here, so `view.ts` never needs a syntax-specific
 * change. Stage 24b added, in this order:
 *
 * 1. `remark-directive` — parses `:::name[label]{attrs}` (container), `::name{attrs}` (leaf) and
 *    `:name[label]{attrs}` (inline) into mdast nodes. Raw HTML stays disabled and the parser alone
 *    never produces DOM;
 * 2. `remarkLuoguDirectives` — the allowlisted transform for folds, alignment, epigraph and
 *    cute-table; it maps recognized directives onto scoped elements and keeps every unknown
 *    directive (and every inline directive) visible as its original text;
 * 3. `rehypeTableMerges` — in the hast pass, so removing a merged cell cannot be undone by the row
 *    padding mdast-util-to-hast applies to short rows.
 *
 * The lists are rebuilt for every render on purpose: KaTeX macros are per-render state, and a shared
 * mutable option object would leak macros from one problem (or one AI answer) into the next.
 */
import type { ComponentProps } from 'react';
import type Markdown from 'react-markdown';
import type { KatexOptions } from 'katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkDirective from 'remark-directive';
import rehypeKatex from 'rehype-katex';
import { rehypeTableMerges, remarkLuoguDirectives } from './extensions.js';

/** Plugin-list type taken from the installed react-markdown, not hand-written. */
export type MarkdownPluginLists = {
  readonly remarkPlugins: NonNullable<ComponentProps<typeof Markdown>['remarkPlugins']>;
  readonly rehypePlugins: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']>;
};

/**
 * KaTeX options for stored math. `trust` stays false, so `\href`, `\includegraphics` and similar
 * commands can never introduce a URL or a resource load; expansion and size are bounded; and
 * `throwOnError: false` keeps the original expression visible when the math is invalid.
 */
export function katexOptions(): KatexOptions {
  return {
    trust: false,
    maxExpand: 1000,
    maxSize: 20,
    throwOnError: false,
    strict: false,
    errorColor: '#b05532',
    macros: {},
  };
}

/** The plugin lists for one render: GFM, math, the Luogu directive subset and table merges. */
export function markdownPlugins(): MarkdownPluginLists {
  return {
    remarkPlugins: [remarkGfm, remarkMath, remarkDirective, remarkLuoguDirectives],
    rehypePlugins: [[rehypeKatex, katexOptions()], rehypeTableMerges],
  };
}
