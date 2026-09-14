/**
 * View-only adapter for Luogu statements stored by the pre-24b statement builder (Sprint 24b).
 *
 * The old builder wrote sample data as bare Markdown (`输入:` / `输出:` followed by the raw sample),
 * so rendering it as ordinary Markdown could swallow blank lines and interpret sample text as math or
 * HTML. This module rewrites only those sample *sections* into literal-text code fences for display.
 *
 * Guarantees:
 * - it never touches stored data or snapshot hashes; callers pass the stored text and receive a
 *   display string, while `查看原文` keeps the untouched original;
 * - it only runs on text the caller has identified as a Luogu statement, and it rewrites only
 *   `## 样例 #N` sections, so problem prose and hints stay Markdown;
 * - the pre-24b format is inherently ambiguous (sample data may itself look like a marker), so every
 *   ambiguity falls back to one literal fenced block holding the whole section verbatim instead of
 *   guessing where input ends and output begins;
 * - the new (24b) format is already fenced and is detected and skipped, and a `## 样例 #N` lookalike
 *   inside a real code fence is never treated as a section;
 * - the adapter is pure: no React, no storage, no clock, no model call and no network.
 *
 * Ambiguity triggers, all of which produce the literal fallback described above:
 * 1. the region before `输入:` is not blank, or `输入:`/`输出:` is missing or out of order;
 * 2. a second exact `输入:` or `输出:` line appears inside the region;
 * 3. a `## …` heading line appears inside the region;
 * 4. a sample body is already fenced while its counterpart is not;
 * 5. a code-fence line appears inside a legacy (unfenced) sample body.
 */
import { literalFenceLines } from './literal-fence.js';

/** Pre-24b sample heading, for example `## 样例 #2`. */
const SAMPLE_HEADING = /^##[ \t]+样例[ \t]*#(\d+)[ \t]*$/u;
/** Every other heading the old builder emitted; they end a sample region. */
const SECTION_HEADING = /^##[ \t]+(?:题目背景|题目描述|输入格式|输出格式|提示)[ \t]*$/u;
/** Any other `##` line inside a sample region is ambiguous. */
const ANY_HEADING = /^##[ \t]/u;
/** A code-fence opener, tracked so section lookalikes inside stored code are ignored. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u;
/** A line consisting only of a fence run (used to close a tracked fence). */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const INPUT_MARKER = '输入:';
const OUTPUT_MARKER = '输出:';

/** Hard bound: a longer statement is displayed unchanged instead of being partially rewritten. */
export const MAX_LEGACY_SAMPLE_LINES = 20000;

/** Result of {@link adaptLegacyLuoguSamples}. */
export interface LuoguSampleAdaptation {
  /** Display text: `text` itself when nothing was rewritten. */
  readonly text: string;
  /** Number of sample sections rewritten into `输入:`/`输出:` literal blocks. */
  readonly rewritten: number;
  /** Number of sample sections kept as one literal block because the stored text was ambiguous. */
  readonly ambiguous: number;
}

interface FenceState {
  readonly char: string;
  readonly size: number;
}

type RegionDecision =
  | { readonly kind: 'skip' }
  | { readonly kind: 'rewritten'; readonly lines: readonly string[] }
  | { readonly kind: 'literal'; readonly lines: readonly string[] };

/** Positions matching a structural predicate outside complete or open code fences. */
function outsideFenceIndices(lines: readonly string[], matches: (line: string) => boolean): number[] {
  const found: number[] = [];
  let fence: FenceState | null = null;
  lines.forEach((line, index) => {
    if (fence) {
      const run = FENCE_CLOSE.exec(line)?.[1];
      if (run && run[0] === fence.char && run.length >= fence.size) fence = null;
      return;
    }
    const run = FENCE_OPEN.exec(line)?.[1];
    if (run) { fence = { char: run[0]!, size: run.length }; return; }
    if (matches(line)) found.push(index);
  });
  return found;
}
/** Exact marker lines outside code fences; sample data within new fences stays literal. */
function allMarkers(lines: readonly string[], marker: string): number[] {
  return outsideFenceIndices(lines, line => line.trim() === marker);
}
function exactMarker(lines: readonly string[], marker: string, from = 0): number {
  return allMarkers(lines, marker).find(index => index >= from) ?? -1;
}
/** A new-format body must have one matching final fence and no trailing prose. */
function completeLiteralBody(lines: readonly string[]): boolean {
  const start = lines.findIndex(line => line.trim().length > 0);
  if (start < 0) return false;
  const run = FENCE_OPEN.exec(lines[start]!)?.[1];
  if (!run || lines[start]!.trim() !== run + 'text') return false;
  for (let i = start + 1; i < lines.length; i++) {
    const close = FENCE_CLOSE.exec(lines[i]!)?.[1];
    if (close && close[0] === run[0] && close.length >= run.length) {
      return lines.slice(i + 1).every(line => line.trim().length === 0);
    }
  }
  return false;
}

/**
 * Remove exactly the two blank separator lines the old builder wrote around a sample body.
 *
 * `输入:` and `输出:` were joined to the body with `\n\n`, so dropping one leading and one trailing
 * blank line inverts the builder exactly — including samples that end with a newline, which is the
 * usual shape of Luogu sample data. At the end of the statement there is no following separator, so
 * `trailingSeparator` is `false` and a trailing blank line is kept as sample data.
 */
function stripSeparators(lines: readonly string[], trailingSeparator: boolean): string[] {
  const body = [...lines];
  if (body.length > 0 && (body[0] ?? '').trim().length === 0) body.shift();
  if (trailingSeparator && body.length > 0 && (body[body.length - 1] ?? '').trim().length === 0) body.pop();
  return body;
}

/** `true` when the first non-blank line opens a code fence. */
function startsFenced(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    return FENCE_OPEN.test(line);
  }
  return false;
}

/** `true` when any line opens a code fence. */
function containsFence(lines: readonly string[]): boolean {
  return lines.some((line) => FENCE_OPEN.test(line));
}

/** The conservative fallback: the whole region becomes one literal block, nothing is reinterpreted. */
function literalRegion(region: readonly string[]): RegionDecision {
  return { kind: 'literal', lines: ['', ...literalFenceLines(region.join('\n'))] };
}

/** Parse one sample region (the lines between the heading and the next heading). */
function parseSampleRegion(region: readonly string[], endsAtBoundary: boolean): RegionDecision {
  const inputIndex = exactMarker(region, INPUT_MARKER);
  if (inputIndex === -1) return literalRegion(region);
  const outputIndex = exactMarker(region, OUTPUT_MARKER, inputIndex + 1);
  if (outputIndex === -1) return literalRegion(region);
  if (region.slice(0, inputIndex).some((line) => line.trim().length > 0)) return literalRegion(region);
  if (allMarkers(region, INPUT_MARKER).length > 1 || allMarkers(region, OUTPUT_MARKER).length > 1) {
    return literalRegion(region);
  }
  if (outsideFenceIndices(region, line => ANY_HEADING.test(line)).length > 0) return literalRegion(region);

  const input = stripSeparators(region.slice(inputIndex + 1, outputIndex), true);
  const output = stripSeparators(region.slice(outputIndex + 1), endsAtBoundary);
  const inputFenced = startsFenced(input);
  const outputFenced = startsFenced(output);
  // The new (24b) format: both bodies are already literal fences, so nothing needs rewriting.
  if (completeLiteralBody(input) && completeLiteralBody(output)) return { kind: 'skip' };
  // Mixed fencing, or fence-like legacy data: the stored text cannot be split safely.
  if (inputFenced !== outputFenced || containsFence(input) || containsFence(output)) return literalRegion(region);

  return {
    kind: 'rewritten',
    lines: [
      '',
      INPUT_MARKER,
      '',
      ...literalFenceLines(input.join('\n')),
      '',
      OUTPUT_MARKER,
      '',
      ...literalFenceLines(output.join('\n')),
    ],
  };
}

/**
 * Rewrite the sample sections of a stored Luogu statement for display.
 *
 * Every line outside a rewritten sample section is preserved byte-for-byte, and a statement without
 * `## 样例 #N` sections is returned unchanged.
 */
export function adaptLegacyLuoguSamples(text: string): LuoguSampleAdaptation {
  if (!text.includes('样例')) return { text, rewritten: 0, ambiguous: 0 };
  const lines = text.split('\n');
  if (lines.length > MAX_LEGACY_SAMPLE_LINES) return { text, rewritten: 0, ambiguous: 0 };

  const samples: number[] = [];
  const boundaries: number[] = [];
  let fence: FenceState | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (fence !== null) {
      const closing = FENCE_CLOSE.exec(line);
      const run = closing?.[1];
      if (run !== undefined && run[0] === fence.char && run.length >= fence.size) fence = null;
      continue;
    }
    const opening = FENCE_OPEN.exec(line)?.[1];
    if (opening !== undefined) {
      fence = { char: opening[0] ?? '`', size: opening.length };
      continue;
    }
    if (SAMPLE_HEADING.test(line)) {
      samples.push(index);
      boundaries.push(index);
      continue;
    }
    if (SECTION_HEADING.test(line)) boundaries.push(index);
  }
  if (samples.length === 0) return { text, rewritten: 0, ambiguous: 0 };

  const output: string[] = [];
  let cursor = 0;
  let rewritten = 0;
  let ambiguous = 0;
  for (const heading of samples) {
    if (heading < cursor) continue;
    let end = boundaries.find((candidate) => candidate > heading) ?? lines.length;
    let region = lines.slice(heading + 1, end);
    // A boundary before a complete input/output pair may itself be sample data.
    // Keep the entire remaining tail literal instead of parsing it as problem prose.
    if (end < lines.length && (exactMarker(region, INPUT_MARKER) < 0 || exactMarker(region, OUTPUT_MARKER) < 0)) {
      end = lines.length;
      region = lines.slice(heading + 1);
      output.push(...lines.slice(cursor, heading), lines[heading] ?? '', '', ...literalFenceLines(region.join('\n')));
      ambiguous += 1;
      cursor = end;
      break;
    }
    output.push(...lines.slice(cursor, heading), lines[heading] ?? '');
    const decision = parseSampleRegion(region, end < lines.length);
    if (decision.kind === 'skip') {
      output.push(...region);
    } else {
      output.push(...decision.lines);
      if (end < lines.length) output.push('');
      if (decision.kind === 'rewritten') rewritten += 1;
      else ambiguous += 1;
    }
    cursor = end;
  }
  output.push(...lines.slice(cursor));
  return { text: output.join('\n'), rewritten, ambiguous };
}
