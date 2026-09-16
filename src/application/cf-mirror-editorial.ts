/**
 * Exact Codeforces-mirror editorial reuse (Sprint 33B).
 *
 * A Luogu `CF<contest><index>` problem is the *same* problem as the Codeforces main-problemset
 * problem `<contest><index>` — but only when the identifier rule of
 * {@link cfMirrorIdentity} recognizes both. Luogu often does not publish an analysable solution for
 * such a problem while Codeforces does publish an official tutorial, so this module owns the one
 * explicit orchestration that fills that gap. Four boundaries shape it:
 *
 * - **Identity is the domain's rule, never a guess.** The only accepted pairing is the pure
 *   `luogu_cf_identifier` identity: the Luogu official instance `luogu:www.luogu.com.cn` with
 *   `CF<contest><index>`, and the Codeforces official instance `codeforces:codeforces.com` with
 *   `<contest><index>`. Gym sets, a `domain`, another source instance, a lowercase or zero-padded
 *   spelling and a numeric index are all refused by that rule; nothing is ever matched by title,
 *   tag, rating or statement similarity, and no model is ever asked whether two problems match.
 * - **The source problem is built server-side.** {@link mirrorEditorialRequestOf} derives the
 *   Codeforces reference from the *target's own stored reference*, so a caller cannot submit an
 *   arbitrary problem number, contest id or URL for the plugin to fetch. The only caller-supplied
 *   identity is the problem the user is actually looking at.
 * - **The statement stays where it belongs.** Only the *editorial* comes from Codeforces: the
 *   statement (and the raw platform tags, submissions, accepted records, retrospectives, manual
 *   decisions and bank rows of the target) are never copied from the other site.
 * - **A failure stays a failure.** Codeforces answering `unavailable`, `rate_limited`,
 *   `changed_response`, `auth_required` or `forbidden` is preserved verbatim as a non-`found`
 *   material check. It is never rewritten as `absent`, which would let the expensive
 *   statement-only reasoning path run on the strength of a broken request.
 *
 * The module is plain application code: pure functions plus one port interface. It reads no clock,
 * touches no store and calls no model.
 */
import {
  CF_MIRROR_RULE_ID,
  CODEFORCES_MAIN_INSTANCE_ID,
  cfMirrorIdentity,
  type CfMirrorIdentity,
} from '../domain/problem-equivalence.js';
import type { ProblemRef } from '../domain/index.js';
import type { EditorialSource, ProblemSnapshot } from '../domain/index.js';
import type { CancellationToken } from '../domain/index.js';
import type { EditorialFetchResult, PlatformLimits } from './ports.js';

/**
 * Stable token appended to every source note of a mirror-fetched editorial.
 *
 * It is a machine-readable constant, not prose: a reader (or a later feature) can tell that the
 * solution came from the equivalent Codeforces problem rather than from a platform article of the
 * problem itself, without parsing a sentence. The contract it certifies is exactly
 * {@link CF_MIRROR_RULE_EXPLANATION}'s: an identifier identity, never a similarity guess.
 */
export const CF_MIRROR_EDITORIAL_RULE_TAG = `cf_mirror:${CF_MIRROR_RULE_ID}`;

/** Prefix of the human-readable half of a mirror source note. */
export const CF_MIRROR_EDITORIAL_NOTE_PREFIX = 'editorial mapped from equivalent Codeforces problem';

/**
 * Why no Codeforces request was made.
 *
 * Every value is an honest statement about this run, never a disguised failure: a skip means the
 * mirror path deliberately did not run, so a caller must not read it as "Codeforces has no
 * editorial".
 */
export type MirrorEditorialSkipReason =
  | 'mirror_not_applicable'
  | 'cf_source_unavailable'
  | 'existing_editorial_reusable';

/** One accepted mirror-editorial fetch: the equivalent Codeforces problem the request is built for. */
export interface MirrorEditorialRequest {
  /**
   * The identity both spellings share, from the domain's own rule.
   *
   * `luoguRef` is the Luogu record the user is looking at; `cfRef` is the Codeforces reference
   * derived from the identity (never from a caller parameter), and it is the only reference the
   * Codeforces adapter is ever asked to fetch.
   */
  readonly identity: CfMirrorIdentity;
  readonly luoguRef: ProblemRef;
  readonly cfRef: ProblemRef;
}

/** Outcome of resolving the equivalent Codeforces material for one target problem. */
export type MirrorEditorialSelection =
  | { readonly kind: 'use'; readonly request: MirrorEditorialRequest }
  | { readonly kind: 'skip'; readonly reason: MirrorEditorialSkipReason };

/**
 * Resolve the Codeforces reference of the equivalent problem, or refuse.
 *
 * The target must be the official Luogu record of a canonical `CF<contest><index>` mirror; every
 * other reference (a Codeforces problem, a gym entry, a non-official instance, a `domain`, a
 * numeric or lowercase spelling) answers `null`, and the caller then simply does not reuse anything.
 * `cfMirrorIdentity` is the single decision point, so this function can never recognize a pairing
 * the merged bank would not recognize.
 */
export function mirrorEditorialRequestOf(target: ProblemRef): MirrorEditorialRequest | null {
  if (target === null || typeof target !== 'object') {
    return null;
  }
  const identity = cfMirrorIdentity(target);
  if (identity === null) {
    return null;
  }
  // The rule is symmetric: it recognizes a plain Codeforces reference as well. Reuse is
  // one-directional (a Luogu mirror borrows from Codeforces), so the target must be the Luogu
  // spelling and nothing else; the Codeforces record of the pair is the *source*, not a target.
  if (target.externalKey !== identity.luoguExternalKey) {
    return null;
  }
  // Built from the identity, never from anything the caller passed: the adapter is asked for exactly
  // the equivalent Codeforces problem, on the official instance, with no domain.
  const cfRef: ProblemRef = {
    sourceInstanceId: CODEFORCES_MAIN_INSTANCE_ID,
    domain: null,
    externalKey: identity.cfExternalKey,
  };
  return { identity, luoguRef: target, cfRef };
}

/**
 * The explicit orchestration port the service calls instead of choosing an adapter itself.
 *
 * It is injected, so the service never imports an adapter (adapters depend on application, not the
 * other way round) and a composition without a usable Codeforces adapter supplies no port at all,
 * which the selection reports as `cf_source_unavailable` rather than substituting another source.
 *
 * `cfRef` and `target` are *both* passed on purpose. The implementation must ask the Codeforces
 * adapter for `cfRef` — the reference this module derived from the target's identity — and it must
 * prove the adapter it uses is bound to the official Codeforces instance; `target` is the Luogu
 * record, carried for diagnostics only and never fetched from here.
 */
export interface MirrorEditorialPort {
  readonly fetchMirrorEditorial: (request: {
    readonly cfRef: ProblemRef;
    readonly target: ProblemRef;
    readonly identity: CfMirrorIdentity;
    readonly token: CancellationToken;
    readonly limits: PlatformLimits;
  }) => Promise<EditorialFetchResult>;
}

/**
 * The provenance note of one Codeforces editorial source stored against a Luogu target.
 *
 * It answers three questions in one stable string: where the body really came from (the official
 * Codeforces tutorial of the equivalent problem), which rule established the equivalence (the
 * machine-readable {@link CF_MIRROR_EDITORIAL_RULE_TAG}), and why that is trustworthy (the official
 * Luogu mirror entry of the same problem). The adapter's own note is kept as well, because it is
 * what proves the body is a section of one specific blog rather than a whole article.
 */
export function mirrorEditorialNote(identity: CfMirrorIdentity, adapterNote: string | null): string {
  const mapped =
    `${CF_MIRROR_EDITORIAL_NOTE_PREFIX} ${identity.cfExternalKey} ` +
    `(official Luogu mirror ${identity.luoguExternalKey}); ${CF_MIRROR_EDITORIAL_RULE_TAG}`;
  const existing = adapterNote === null ? '' : adapterNote.trim();
  return existing.length === 0 ? mapped : `${mapped} | ${existing}`;
}

/**
 * Stamp the equivalence onto every source of one `found` Codeforces answer.
 *
 * The source ids, URLs, titles, hashes and the solution bodies are preserved exactly as the
 * Codeforces adapter produced them — in particular the official blog URL, which is the attribution
 * a reader needs — and only the note gains the mapping provenance. A non-`found` answer is passed
 * through untouched, so an operational failure keeps its own availability and can never be
 * rewritten as an absence here.
 */
export function withMirrorProvenance(
  result: EditorialFetchResult,
  identity: CfMirrorIdentity,
): EditorialFetchResult {
  if (result.status !== 'found') {
    return result;
  }
  return {
    status: 'found',
    sources: result.sources.map((source) =>
      createProvenanceSource(source, mirrorEditorialNote(identity, source.note)),
    ),
    solutions: result.solutions.map((solution) => ({ ...solution })),
    retrievedAt: result.retrievedAt,
  };
}

/**
 * Rebuild one editorial source with a replaced note.
 *
 * The record is copied field by field (never spread wholesale) so an unknown member an adapter
 * attached can never ride into the stored snapshot through this path, and the content hash is
 * carried over verbatim because the body it digests did not change.
 */
function createProvenanceSource(source: EditorialSource, note: string): EditorialSource {
  return Object.freeze({
    id: source.id,
    kind: source.kind,
    url: source.url,
    title: source.title,
    author: source.author,
    language: source.language,
    publishedAt: source.publishedAt,
    retrievedAt: source.retrievedAt,
    availability: source.availability,
    contentHash: source.contentHash,
    note,
  });
}

/**
 * Whether the stored snapshot already holds analysable editorial material.
 *
 * It is the same predicate the analysis pipeline uses to call material usable: a `found` source with
 * a referenced, non-blank solution body. While one exists, the default is to reuse it instead of
 * spending a platform request on the equivalent Codeforces problem — a user's own pasted answer
 * therefore wins over an automated import, exactly as the "existing material is reusable" policy
 * requires.
 */
export function hasReusableEditorial(previous: ProblemSnapshot | null): boolean {
  if (previous === null) {
    return false;
  }
  return previous.sources.some(
    (source) =>
      source.availability === 'found' &&
      previous.solutions.some((solution) => solution.sourceId === source.id && solution.text.trim().length > 0),
  );
}

/**
 * Decide the mirror action for one target.
 *
 * Order matters and is deliberate: the target's identity is checked first (nothing else can make a
 * Codeforces request meaningful), then the already usable material (a free decision that must
 * precede any network work), and only then the availability of a Codeforces adapter. Each answer is
 * distinguishable, so a caller can report *why* no request was made instead of implying that
 * Codeforces had nothing.
 */
export function selectMirrorEditorial(options: {
  readonly target: ProblemRef;
  readonly previous: ProblemSnapshot | null;
  readonly hasMirrorPort: boolean;
  readonly reuseExisting: boolean;
}): MirrorEditorialSelection {
  const request = mirrorEditorialRequestOf(options.target);
  if (request === null) {
    return { kind: 'skip', reason: 'mirror_not_applicable' };
  }
  if (options.reuseExisting && hasReusableEditorial(options.previous)) {
    return { kind: 'skip', reason: 'existing_editorial_reusable' };
  }
  if (!options.hasMirrorPort) {
    return { kind: 'skip', reason: 'cf_source_unavailable' };
  }
  return { kind: 'use', request };
}
