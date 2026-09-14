/**
 * Luogu Markdown extensions for the local renderer (Sprint 24b).
 *
 * Directives are recognized in the **mdast** tree produced by `remark-directive` and are mapped onto
 * fixed, scoped elements through mdast-util-to-hast's `data.hName`/`data.hProperties` fields. Table
 * merge markers are resolved in a **hast** pass instead, because mdast-util-to-hast pads a shortened
 * table row back to the header width: removing cells only after that padding is what keeps a
 * `rowspan` rectangle from silently growing an extra column. Nothing is rewritten as an HTML string,
 * raw HTML stays disabled, and no input attribute is ever forwarded to the DOM: of the directive
 * attributes only the *presence* of `open` (folds) and `tuack` (cute-table) is read, and values are
 * ignored.
 *
 * Implemented syntax (see `docs/markdown-rendering.md`):
 * - `:::info[title]{open}`, `:::success`, `:::warning`, `:::error` → `<details>`/`<summary>`; the
 *   title supports inline Markdown and dollar math, the body supports every block construct
 *   including nested folds (longer colon runs nest naturally in remark-directive);
 * - `:::align{center}` / `:::align{right}` → a fixed alignment wrapper; an attribute value such as
 *   `{justify}` is not a CSS value and is therefore never applied;
 * - `:::epigraph[author]` → a blockquote with the attribution kept visible as a `<footer>`;
 * - `::cute-table{tuack}` → decorates the table that immediately follows it and is consumed only
 *   then; otherwise it stays visible as text;
 * - a table cell whose only unformatted, unescaped source text is `^` merges upward and `<` merges
 *   left, producing `rowspan`/`colspan` on the origin cell of a valid rectangle.
 *
 * Nothing disappears: an unknown or unsupported directive keeps its literal opening marker and its
 * whole body, an inline (`:name[…]`) directive is restored to its exact source text, and an invalid
 * merge marker stays a normal visible cell. Work is bounded by {@link MAX_DIRECTIVE_DEPTH},
 * {@link MAX_NODES_PER_RENDER}, {@link MAX_TABLE_ROWS} and {@link MAX_TABLE_CELLS}; input beyond a
 * bound is left exactly as parsed instead of being partially transformed.
 */
import type { Element, ElementContent, Properties, RootContent as HastContent, Root as HastRoot } from 'hast';
import type { BlockContent, PhrasingContent, Root, RootContent } from 'mdast';
import type { Plugin } from 'unified';

/** Block fold kinds, with the default title used when a fold carries no `[title]` label. */
const FOLD_TITLES: ReadonlyMap<string, string> = new Map([
  ['info', '提示'],
  ['success', '成功'],
  ['warning', '注意'],
  ['error', '错误'],
]);

/** Node types `remark-directive` produces; anything else is ordinary Markdown. */
const DIRECTIVE_TYPES: ReadonlySet<string> = new Set(['containerDirective', 'leafDirective', 'textDirective']);

/** Scoped class of a fold element; the kind is appended (`icpc-md-fold-info`, …). */
const FOLD_CLASS = 'icpc-md-fold';

/** Deepest directive nesting that is still transformed; deeper input keeps its original shape. */
export const MAX_DIRECTIVE_DEPTH = 12;
/** Largest number of visited nodes per render; beyond it the remaining tree is left untouched. */
export const MAX_NODES_PER_RENDER = 20000;
/** Tables taller than this body are not merged (their markers stay visible). */
export const MAX_TABLE_ROWS = 200;
/** Tables with more cells than this are not merged (their markers stay visible). */
export const MAX_TABLE_CELLS = 2000;

/** The mdast `data` fields mdast-util-to-hast reads to shape the produced element. */
interface MappedData {
  readonly hName: string;
  readonly hProperties: Properties;
}

/** Structural view of a directive node; the fields are validated before use, never trusted. */
interface DirectiveShape {
  readonly type: string;
  readonly name?: unknown;
  readonly attributes?: unknown;
  readonly children?: RootContent[];
  readonly position?: {
    readonly start?: { readonly offset?: number };
    readonly end?: { readonly offset?: number };
  };
}

interface WalkState {
  readonly source: string;
  nodes: number;
  stopped: boolean;
}

/** Build the hast mapping for one generated element without ever forwarding input attributes. */
function mapped(hName: string, classNames: readonly string[], extra: Properties = {}): MappedData {
  return {
    hName,
    hProperties: { ...extra, ...(classNames.length > 0 ? { className: [...classNames] } : {}) },
  };
}

/** One generated block container: a mdast blockquote re-tagged as `hName` through `data`. */
function blockContainer(
  hName: string,
  classNames: readonly string[],
  children: readonly RootContent[],
  extra: Properties = {},
): RootContent {
  return { type: 'blockquote', data: mapped(hName, classNames, extra), children: [...children] as BlockContent[] };
}

/** One generated paragraph (or, through `hName`, `summary`/`footer`) holding inline content. */
function inlineParagraph(hName: string, classNames: readonly string[], children: readonly RootContent[]): RootContent {
  return { type: 'paragraph', data: mapped(hName, classNames), children: [...children] as PhrasingContent[] };
}

/** Children array of a node, or `null` when the node is a leaf (code, text, …). */
function nodeChildren(node: RootContent): RootContent[] | null {
  const value = (node as { children?: unknown }).children;
  return Array.isArray(value) ? (value as RootContent[]) : null;
}

/** Structural directive view, or `null` for ordinary Markdown nodes. */
function directiveOf(node: RootContent): DirectiveShape | null {
  return DIRECTIVE_TYPES.has(node.type) ? (node as unknown as DirectiveShape) : null;
}

/** `true` only when the directive declares `key`; the attribute value is never read. */
function hasAttribute(node: DirectiveShape, key: string): boolean {
  const attributes = node.attributes;
  if (attributes === null || typeof attributes !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(attributes, key);
}

/** Directive name when the parser produced one, otherwise the empty string. */
function directiveName(node: DirectiveShape): string {
  return typeof node.name === 'string' ? node.name : '';
}

/**
 * Exact original text of a directive.
 *
 * Container and leaf directives are reduced to their opening line (the whole construct is on one
 * line for leaves); an inline directive keeps its complete source. When positions are unavailable
 * the marker is rebuilt from the parsed name, which still keeps the construct visible.
 */
function directiveSource(source: string, node: DirectiveShape): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start === 'number' && typeof end === 'number' && start >= 0 && end > start && end <= source.length) {
    const slice = source.slice(start, end);
    if (node.type === 'textDirective') return slice;
    const lineEnd = slice.indexOf('\n');
    const opening = lineEnd === -1 ? slice : slice.slice(0, lineEnd);
    return opening.length > 200 ? `${opening.slice(0, 200)}…` : opening;
  }
  const name = directiveName(node);
  return node.type === 'textDirective' ? `:${name}` : node.type === 'leafDirective' ? `::${name}` : `:::${name}`;
}

/**
 * Remove and return the directive label (title/author) from a container body.
 *
 * `remark-directive` puts the `[…]` label into the first child as a paragraph carrying
 * `data.directiveLabel`; its children are inline nodes, so inline math and emphasis survive.
 */
function takeLabel(body: RootContent[]): RootContent[] {
  const first = body[0];
  if (first === undefined) return [];
  const data = (first as { data?: { directiveLabel?: unknown } }).data;
  if (data?.directiveLabel !== true) return [];
  body.shift();
  return nodeChildren(first) ?? [];
}

/** `center` or `right`, or `null` when the directive names neither exactly one of them. */
function alignmentOf(node: DirectiveShape): 'center' | 'right' | null {
  const center = hasAttribute(node, 'center');
  const right = hasAttribute(node, 'right');
  if (center === right) return null;
  return center ? 'center' : 'right';
}

/** Visible fallback of a directive this renderer does not implement (or cannot trust). */
function unknownDirective(source: string, node: DirectiveShape, body: readonly RootContent[], label: readonly RootContent[]): RootContent {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start === 'number' && typeof end === 'number' && end > start) {
    return blockContainer('div', ['icpc-md-unknown-directive'], [
      { type: 'code', lang: 'text', value: source.slice(start, end) },
    ]);
  }
  const marker: RootContent[] = [{ type: 'text', value: directiveSource(source, node) }];
  if (label.length > 0) marker.push({ type: 'text', value: ' ' }, ...label);
  return blockContainer('div', ['icpc-md-unknown-directive'], [inlineParagraph('p', ['icpc-md-unknown-marker'], marker), ...body]);
}

/** Rewrite one directive node, or `null` when the caller must keep the node untouched. */
function transformDirective(
  directive: DirectiveShape,
  siblings: readonly RootContent[],
  index: number,
  state: WalkState,
  depth: number,
): { readonly nodes: readonly RootContent[]; readonly advance: number } | null {
  if (depth >= MAX_DIRECTIVE_DEPTH) return null;
  // An inline directive is never a Luogu construct here: restore its exact source as literal text so
  // it can neither disappear nor leak attributes into the DOM.
  if (directive.type === 'textDirective') {
    return { nodes: [{ type: 'text', value: directiveSource(state.source, directive) }], advance: 0 };
  }
  const body = directive.children === undefined ? [] : [...directive.children];
  const label = takeLabel(body);
  const name = directiveName(directive);

  const foldTitle = FOLD_TITLES.get(name);
  if (foldTitle !== undefined) {
    walkChildren(body, state, depth + 1);
    walkChildren(label, state, depth + 1);
    const title = label.length > 0 ? label : [{ type: 'text', value: foldTitle } as RootContent];
    const details = blockContainer(
      'details',
      [FOLD_CLASS, `${FOLD_CLASS}-${name}`],
      [inlineParagraph('summary', [], title), ...body],
      hasAttribute(directive, 'open') ? { open: true } : {},
    );
    return { nodes: [details], advance: 0 };
  }

  if (name === 'align') {
    const alignment = alignmentOf(directive);
    if (alignment === null) {
      return { nodes: [unknownDirective(state.source, directive, body, label)], advance: 0 };
    }
    walkChildren(body, state, depth + 1);
    walkChildren(label, state, depth + 1);
    const leading = label.length > 0 ? [inlineParagraph('p', [], label)] : [];
    return { nodes: [blockContainer('div', ['icpc-md-align', `icpc-md-align-${alignment}`], [...leading, ...body])], advance: 0 };
  }

  if (name === 'epigraph') {
    walkChildren(body, state, depth + 1);
    walkChildren(label, state, depth + 1);
    const attribution = label.length > 0 ? label : [{ type: 'text', value: '未署名' } as RootContent];
    const footer = inlineParagraph('footer', ['icpc-md-epigraph-author'], attribution);
    return { nodes: [blockContainer('blockquote', ['icpc-md-epigraph'], [...body, footer])], advance: 0 };
  }

  if (name === 'cute-table') {
    const following = siblings[index + 1];
    if (hasAttribute(directive, 'tuack') && following !== undefined && following.type === 'table') {
      return { nodes: [blockContainer('div', ['icpc-md-cute-table'], [following])], advance: 1 };
    }
    // Not attached to an actual table: keep it visible instead of consuming it.
    return { nodes: [unknownDirective(state.source, directive, body, label)], advance: 0 };
  }

  return { nodes: [unknownDirective(state.source, directive, body, label)], advance: 0 };
}

/** Transform one level of mdast children in place, recursing into every nested child list. */
function walkChildren(children: RootContent[], state: WalkState, depth: number): void {
  const result: RootContent[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (node === undefined) continue;
    state.nodes += 1;
    if (state.stopped || state.nodes > MAX_NODES_PER_RENDER) {
      state.stopped = true;
      result.push(node);
      continue;
    }
    const directive = directiveOf(node);
    if (directive === null) {
      const nested = depth < MAX_DIRECTIVE_DEPTH ? nodeChildren(node) : null;
      if (nested !== null) walkChildren(nested, state, depth + 1);
      result.push(node);
      continue;
    }
    const transformed = transformDirective(directive, children, index, state, depth);
    if (transformed === null) {
      result.push(unknownDirective(state.source, directive, directive.children ?? [], []));
      continue;
    }
    result.push(...transformed.nodes);
    index += transformed.advance;
  }
  children.splice(0, children.length, ...result);
}

/**
 * Remark plugin: recognize the allowlisted Luogu directives and leave every other node alone.
 *
 * The plugin only reads the source text, never the filesystem or the network, and it is pure with
 * respect to the input tree: the tree is transformed in place for the current render only.
 */
export const remarkLuoguDirectives: Plugin<[], Root> = () => (tree, file) => {
  const state: WalkState = { source: String(file), nodes: 0, stopped: false };
  walkChildren(tree.children, state, 0);
};

/** One rectangle origin in the merge grid; every other cell of the rectangle points at it. */
interface MergeOrigin {
  readonly cell: Element;
  readonly row: number;
  readonly col: number;
  rowSpan: number;
  colSpan: number;
  /** `true` when the cell is an unmerged `^`/`<` marker; such a cell never absorbs another. */
  readonly literal: boolean;
}

/** `true` for a `<td>`/`<th>` element. */
function isTableCell(node: ElementContent): node is Element {
  return node.type === 'element' && (node.tagName === 'td' || node.tagName === 'th');
}

/** `true` for a `<tr>` element. */
function isTableRow(node: ElementContent): node is Element {
  return node.type === 'element' && node.tagName === 'tr';
}

/**
 * Exact source text of a cell **content**, or `null` when the position is unusable.
 *
 * The range used here is the first child's start to the last child's end, which excludes the pipes
 * and padding around the cell. The source slice (not the parsed text) is what proves a marker is
 * unescaped and unformatted: `\^` keeps its backslash here and `` `^` `` keeps its backticks, so
 * neither can merge.
 */
function cellSource(cell: Element, source: string): string | null {
  const first = cell.children[0];
  const last = cell.children[cell.children.length - 1];
  if (first === undefined || last === undefined) return '';
  const start = first.position?.start.offset;
  const end = last.position?.end.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end < start || end > source.length) {
    return null;
  }
  return source.slice(start, end).trim();
}

/** `^` or `<` when the cell is exactly that unformatted, unescaped marker, otherwise `null`. */
function mergeMarker(cell: Element | undefined, source: string): '^' | '<' | null {
  if (cell === undefined) return null;
  const text = cellSource(cell, source);
  if (text !== '^' && text !== '<') return null;
  if (cell.children.length !== 1) return null;
  const only = cell.children[0];
  if (only === undefined || only.type !== 'text' || only.value !== text) return null;
  return text;
}

/** Every column of `origin`'s band in `row` must carry the `^` marker. */
function verticalBandFilled(
  markerOf: (row: number, col: number) => '^' | '<' | null,
  origin: MergeOrigin,
  row: number,
): boolean {
  for (let col = origin.col; col < origin.col + origin.colSpan; col += 1) {
    if (markerOf(row, col) !== '^') return false;
  }
  return true;
}

/** A wider rectangle is only valid when the new column is already part of the origin above. */
function horizontalRectangleFilled(
  owner: readonly (readonly (MergeOrigin | null)[])[],
  markerOf: (row: number, col: number) => '^' | '<' | null,
  origin: MergeOrigin,
  col: number,
  row: number,
): boolean {
  for (let candidate = origin.row; candidate < origin.row + origin.rowSpan; candidate += 1) {
    if (markerOf(candidate, col) !== '<') return false;
    if (candidate !== row && owner[candidate]?.[col] !== origin) return false;
  }
  return true;
}

/**
 * Merge the `^`/`<` marker cells of one `<tbody>` into `rowspan`/`colspan` rectangles.
 *
 * The algorithm keeps an origin grid, so a cell is claimed by at most one rectangle and no overlap
 * is possible. Only `<tbody>` rows are considered, so the header (`<thead>`) can never be merged
 * into; a `^` in the first body row, a `<` in the first column and any marker in the header row stay
 * visible as literal text. A rectangle only grows when its new edge is completely filled with
 * markers of the matching kind, which is what makes non-rectangular shapes fall back to visible
 * markers instead of a broken layout.
 */
function mergeTableBody(body: Element, source: string): void {
  const rows = body.children.filter(isTableRow);
  if (rows.length === 0) return;
  const grid = rows.map((row) => row.children.filter(isTableCell));
  const width = grid[0]?.length ?? 0;
  if (width === 0 || grid.some((row) => row.length !== width)) return;
  if (rows.length > MAX_TABLE_ROWS || rows.length * width > MAX_TABLE_CELLS) return;

  const markerOf = (row: number, col: number): '^' | '<' | null => mergeMarker(grid[row]?.[col], source);
  const owner: (MergeOrigin | null)[][] = grid.map((row) => row.map(() => null));
  const origins: MergeOrigin[] = [];

  for (let row = 0; row < rows.length; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (owner[row]?.[col] !== null && owner[row]?.[col] !== undefined) continue;
      const marker = markerOf(row, col);
      if (row >= 1 && marker === '^') {
        const above = owner[row - 1]?.[col] ?? null;
        if (above !== null && !above.literal && col >= above.col && col < above.col + above.colSpan) {
          if (above.row + above.rowSpan === row + 1) {
            owner[row]![col] = above;
            continue;
          }
          if (above.row + above.rowSpan === row && verticalBandFilled(markerOf, above, row)) {
            above.rowSpan += 1;
            owner[row]![col] = above;
            continue;
          }
        }
      } else if (col >= 1 && marker === '<') {
        const left = owner[row]?.[col - 1] ?? null;
        if (
          left !== null &&
          !left.literal &&
          left.col + left.colSpan === col &&
          row >= left.row &&
          row < left.row + left.rowSpan &&
          horizontalRectangleFilled(owner, markerOf, left, col, row)
        ) {
          left.colSpan += 1;
          owner[row]![col] = left;
          continue;
        }
      }
      const origin: MergeOrigin = { cell: grid[row]![col]!, row, col, rowSpan: 1, colSpan: 1, literal: marker !== null };
      owner[row]![col] = origin;
      origins.push(origin);
    }
  }

  let merged = false;
  for (const origin of origins) {
    const properties: Properties = {};
    if (origin.rowSpan > 1) properties.rowSpan = origin.rowSpan;
    if (origin.colSpan > 1) properties.colSpan = origin.colSpan;
    if (Object.keys(properties).length === 0) continue;
    merged = true;
    origin.cell.properties = { ...origin.cell.properties, ...properties };
  }
  if (!merged) return;
  // A cell absorbed by a rectangle must leave the row, otherwise the browser would render one extra
  // column; every absorbed cell was a pure `^`/`<` marker, so no content is dropped.
  rows.forEach((row, index) => {
    let col = 0;
    row.children = row.children.filter((child) => {
      if (!isTableCell(child)) return true;
      const keep = owner[index]?.[col]?.cell === child;
      col += 1;
      return keep;
    });
  });
}

/** Find every `<table>` in the hast tree and merge the rows of each of its `<tbody>` sections. */
function walkTableElements(children: readonly HastContent[], source: string, depth: number): void {
  if (depth > MAX_DIRECTIVE_DEPTH) return;
  for (const node of children) {
    if (node.type !== 'element') continue;
    if (node.tagName === 'table') {
      for (const section of node.children) {
        if (section.type === 'element' && section.tagName === 'tbody') mergeTableBody(section, source);
      }
      continue;
    }
    walkTableElements(node.children, source, depth + 1);
  }
}

/**
 * Rehype plugin: turn `^`/`<` table markers into `rowspan`/`colspan` rectangles.
 *
 * It runs after the HTML conversion (and after KaTeX), so removing a merged cell can no longer be
 * undone by the row padding mdast-util-to-hast applies to short rows. Tables without markers keep
 * their elements, properties and text unchanged.
 */
export const rehypeTableMerges: Plugin<[], HastRoot> = () => (tree, file) => {
  walkTableElements(tree.children, String(file), 0);
};
