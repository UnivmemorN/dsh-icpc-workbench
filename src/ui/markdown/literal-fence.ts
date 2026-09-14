/**
 * Literal-fence helper shared by the Luogu display paths (Sprint 24b).
 *
 * Sample data is not prose: it must keep every space, blank line, dollar sign and fence-like line.
 * A fenced code block is the only Markdown construct with that property, and the fence itself must be
 * longer than every backtick run inside the content, otherwise the content could close its own block.
 *
 * The exactness rule used by the renderer is: a source of ``fence\nvalue\nfence`` produces a code
 * value of `value + "\n"`, and `MarkdownPre` removes exactly that one appended newline. The block
 * therefore reconstructs `value` character-for-character, including a trailing newline and trailing
 * blank lines. The adapter that *writes* new statements uses the same rule in its own layer.
 */

/** Fence info string: a registered-but-plain language, so no highlighting is invented for samples. */
export const SAMPLE_FENCE_INFO = 'text';

/** Shortest fence accepted by CommonMark. */
const MIN_FENCE = 3;

/** A backtick fence strictly longer than every backtick run in `text`. */
export function literalFence(text: string): string {
  let size = MIN_FENCE;
  for (const run of text.match(/`+/gu) ?? []) {
    if (run.length >= size) size = run.length + 1;
  }
  const fence = '`'.repeat(size);
  return `${fence}${SAMPLE_FENCE_INFO}\n${text}\n${fence}`;
}

/** {@link literalFence} as the line array an already-line-based transformer can splice in. */
export function literalFenceLines(text: string): string[] {
  return literalFence(text).split('\n');
}
