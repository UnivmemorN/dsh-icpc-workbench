/**
 * Shared-round editorial aliases: the pure rules behind Codeforces Div.1/Div.2 problem aliasing.
 *
 * A Codeforces round is frequently held twice — a Div. 1 and a Div. 2 version of the same problems —
 * and the official tutorial blog is shared. A section heading in that blog may therefore name the
 * problem only in relative form (`Div. 1 D`) or name the *other* division's absolute key, so a
 * request for `879E` can legitimately have to be answered from the section of `878C`.
 *
 * This module owns the two halves that are pure and testable on their own:
 *
 * - **parsing** a relative division heading in the narrow shapes the platform actually writes
 *   (`Div 1 D`, `Div.1 D`, `Div2 E / Div1 D`, `Div. 2 E = Div. 1 D`), and
 * - **arithmetic** over an *already verified* alias list: normalization, matching and enumeration.
 *
 * It deliberately knows nothing about the network, the catalog or the store. Deciding whether two
 * problems really are the same one is the adapter's job, and it is a job built on official evidence
 * only (paired contests of the same round, identical official titles, identical normalized statement
 * hashes, the same tutorial blog). Nothing here may invent an alias, and no consumer may derive one
 * by arithmetic such as "Div. 2 E is Div. 1 D": the letter offset is **not** a platform rule, it
 * differs between rounds, and treating it as one would silently attach the wrong solution to a
 * problem. The offset is never computed; only observed evidence is accepted.
 *
 * The one hash-shaped member ({@link CfEditorialAlias.evidenceHash}) is an internal verification
 * fingerprint. It is never projected to a DTO, a log line or the UI.
 */
import {
  cfProblemExternalKey,
  normalizeCfProblemIndex,
  parseCfProblemKey,
  type CfProblemKeyParts,
} from './problem-index.js';

/** Rule identity recorded on every accepted alias, so a stored result can be audited. */
export const CF_EDITORIAL_ALIAS_RULE_VERSION = 'cf-editorial-alias-v1';

/** How one alias was established. */
export type CfEditorialAliasMethod = 'explicit_reference' | 'official_division_pair';

/**
 * One verified redirect from the requested problem to the problem whose section actually holds the
 * solution.
 *
 * It exists only because the adapter *proved* the two problems are the same one; a consumer treats it
 * as data, never as a hint it may extend.
 */
export interface CfEditorialAlias {
  /** The Codeforces key the user asked for (`879E`). */
  readonly requestedKey: string;
  /** The Codeforces key whose section holds the solution (`878C`). */
  readonly sectionKey: string;
  /** The official tutorial blog both problems link to. */
  readonly blogId: number;
  /** The verified contest pairing, smaller id first; empty for `explicit_reference`. */
  readonly pairedContestIds: readonly number[];
  readonly method: CfEditorialAliasMethod;
  readonly ruleVersion: string;
  /** Internally compared only: the normalized statement fingerprint both problems share. */
  readonly evidenceHash: string;
}

/**
 * One section the extractor is allowed to look for under an alias.
 *
 * `headings` carries every *normalized* spelling of the section label the adapter accepts for this
 * target, so the extractor never has to know which division a contest id belongs to — it only
 * compares already-normalized strings.
 */
export interface CfEditorialSectionTarget {
  readonly contestId: number;
  readonly index: string;
  /** Canonical `878C` / `921/01` key of this target. */
  readonly externalKey: string;
  /** Normalized heading spellings (`div.1c`, `div. 2e=div. 1d`, …) that select this target. */
  readonly headings: readonly string[];
}

/** One relative division reference written in a section heading: `Div. 1 D`. */
export interface CfDivisionReference {
  /** `1` or `2`; the platform has no third division in a shared round. */
  readonly division: 1 | 2;
  /** Index exactly as written, upper-cased (`D`, `E`, `B2`); `null` when unreadable. */
  readonly index: string;
}

/**
 * Canonical key of one relative reference for a *given* division's contest id.
 *
 * The contest id is always supplied by the caller from verified contest metadata: this function does
 * arithmetic on nothing. Returns `null` for a reference whose index is not a readable problem index.
 */
export function divisionReferenceKey(reference: CfDivisionReference, contestId: number): string | null {
  if (reference.index.length === 0) {
    return null;
  }
  try {
    return cfProblemExternalKey(contestId, reference.index);
  } catch {
    return null;
  }
}

/** `true` when a contest id addresses the main problemset (a positive safe integer). */
export function isValidContestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------------------
// Relative heading parsing
// ---------------------------------------------------------------------------------------

/** Separators the platform uses between two spellings of the same section (`/`, `=`, `,`, `+`, `and`). */
const DIVISION_SEPARATORS = String.raw`(?:\s*(?:[/,=+]|\band\b)\s*)`;
/** One division reference: `Div1 D`, `Div.1 D`, `Div 2 E`, `Division 1 A`. */
const DIVISION_REFERENCE = String.raw`(?:div(?:ision)?\.?\s*([12]))\s*([A-Za-z][1-9]?|0[1-9]|[1-9][0-9]?)`;
/** The whole label must be division references only: prose never selects a section. */
const DIVISION_LABEL = new RegExp(
  String.raw`^\s*${DIVISION_REFERENCE}(?:${DIVISION_SEPARATORS}${DIVISION_REFERENCE})*\s*$`,
  'iu',
);
const DIVISION_REFERENCE_ALL = new RegExp(DIVISION_REFERENCE, 'giu');

/**
 * Parse a heading that consists only of relative division references.
 *
 * Exactly the shapes the platform writes are accepted, and nothing else: a label that carries any
 * prose (a sentence, a method name, a title) returns `null` even when it *contains* `Div. 1 D`, so a
 * passing mention inside an author's note can never turn into a section match. An unreadable index
 * after an otherwise valid division marker is preserved as `index: ''` instead of being dropped, so
 * `Div. 1` with no problem letter stays an explicit refusal rather than matching everything.
 */
export function parseDivisionHeading(text: string): readonly CfDivisionReference[] | null {
  if (typeof text !== 'string') {
    return null;
  }
  const label = text.trim();
  if (label.length === 0 || !DIVISION_LABEL.test(label)) {
    return null;
  }
  const references: CfDivisionReference[] = [];
  const seen = new Set<string>();
  for (const match of label.matchAll(DIVISION_REFERENCE_ALL)) {
    const divisionText = match[1];
    const indexText = match[2];
    const division = divisionText === '1' ? 1 : divisionText === '2' ? 2 : null;
    if (division === null) {
      return null;
    }
    const index = normalizeCfProblemIndex(indexText ?? '') ?? '';
    const key = `${division}/${index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    references.push({ division, index });
  }
  return references.length === 0 ? null : references;
}

// ---------------------------------------------------------------------------------------
// Normalization and matching over already-verified headings
// ---------------------------------------------------------------------------------------

/**
 * Normalize one section label for comparison.
 *
 * Case, `Div.`-vs-`Div` spacing, surrounding whitespace and the separators between two spellings are
 * erased; everything else (including the exact index letters, and therefore `A0` vs `A01`) is kept,
 * so the comparison can never grow more permissive than what was verified.
 */
export function normalizeHeadingText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\t\n\r\f\v\u00a0 ]+/gu, ' ')
    .replace(/\s*([/,=+])\s*/gu, '$1')
    .replace(/\bdivision\s*\.?\s*/gu, 'div')
    .replace(/\bdiv\s*\.\s*/gu, 'div')
    .replace(/\s*\.\s*/gu, '.')
    .trim();
}

/**
 * Every normalized heading spelling that selects one relative reference.
 *
 * Both the compact (`div1d`) and the spaced (`div. 1 d`, `div 1 d`) spellings are accepted, because
 * the platform writes both. The separators between two spellings are *not* enumerated: a heading
 * naming two divisions of the same problem is handled by matching each reference independently rather
 * than by predicting every punctuation the authors might use.
 */
export function headingSpellingsFor(reference: CfDivisionReference): readonly string[] {
  if (reference.index.length === 0) {
    return [];
  }
  const compact = `div${String(reference.division)}${reference.index.toLowerCase()}`;
  const spaced = `div.${String(reference.division)} ${reference.index.toLowerCase()}`;
  return [compact, spaced];
}

/** `true` when one normalized heading selects this target. */
export function headingSelectsTarget(heading: string, target: CfEditorialSectionTarget): boolean {
  return target.headings.some((candidate) => headingContainsSpelling(heading, candidate));
}

/**
 * Whether `heading` (already normalized) names `spelling` (already normalized) as a whole token run.
 *
 * The check is bounded on both sides by a non-token character, so `div.1d` never matches inside
 * `div.1d2` and `div.1a` is never read as `div.1` plus a stray `a`. A heading that names two
 * spellings (`div.2e=div.1d`) contains both, which is exactly the desired behaviour.
 */
function headingContainsSpelling(heading: string, spelling: string): boolean {
  let from = 0;
  for (;;) {
    const at = heading.indexOf(spelling, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? '' : (heading[at - 1] ?? '');
    const after = heading[at + spelling.length] ?? '';
    if (!isTokenChar(before) && !isTokenChar(after)) {
      return true;
    }
    from = at + 1;
  }
}

function isTokenChar(value: string): boolean {
  return value.length > 0 && /[a-z0-9.]/u.test(value);
}

/** Canonical key parts of one target, or `null` when its own key is malformed. */
export function sectionTargetParts(target: CfEditorialSectionTarget): CfProblemKeyParts | null {
  return parseCfProblemKey(target.externalKey);
}

/**
 * Enumerate the bounded set of section targets an alias authorizes.
 *
 * There is exactly one target per verified alias — the section the adapter proved holds the solution
 * — so the enumeration cannot widen the search, and an alias list that is empty yields nothing.
 */
export function sectionTargetsOf(
  aliases: readonly CfEditorialAlias[],
  headings: (alias: CfEditorialAlias) => readonly string[],
): readonly CfEditorialSectionTarget[] {
  const targets: CfEditorialSectionTarget[] = [];
  const seen = new Set<string>();
  for (const alias of aliases) {
    if (seen.has(alias.sectionKey)) {
      continue;
    }
    const parts = parseCfProblemKey(alias.sectionKey);
    if (parts === null) {
      continue;
    }
    seen.add(alias.sectionKey);
    targets.push({
      contestId: parts.contestId,
      index: parts.index,
      externalKey: alias.sectionKey,
      headings: headings(alias),
    });
  }
  return targets;
}

// ---------------------------------------------------------------------------------------
// Contest pairing rules
// ---------------------------------------------------------------------------------------

/** One contest's official metadata, as the adapter read it. */
export interface CfContestFacts {
  readonly contestId: number;
  readonly name: string;
  readonly startTimeSeconds: number;
  readonly durationSeconds: number;
}

/**
 * Which division a contest name declares, or `null` when it declares none.
 *
 * Only the platform's canonical `(Div. N)` marker counts. A name that merely contains the word
 * "div" somewhere is not a division declaration, and a contest whose name the adapter cannot read a
 * division from is never paired — the caller then reports the alias as unverifiable.
 */
export function divisionOfContestName(name: string): 1 | 2 | null {
  const match = /\(\s*div\.?\s*([12])\s*\)/iu.exec(name);
  if (match === null) {
    return null;
  }
  return match[1] === '1' ? 1 : 2;
}

/**
 * The contest name with its canonical `(Div. N)` marker removed.
 *
 * The marker is deleted, not rewritten, so the remaining core name is compared literally: two
 * contests of one round differ by exactly that marker, and a deliberately reworded title keeps its
 * difference instead of being normalized away.
 */
export function contestCoreName(name: string): string {
  return name.replace(/\s*\(\s*div\.?\s*[12]\s*\)\s*/giu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Normalized official title: NFC plus whitespace folding, and nothing else. */
export function normalizeOfficialTitle(title: string): string {
  return title.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * Whether two contests form one verified Div.1/Div.2 pair of the same round.
 *
 * Every clause is an official-metadata fact and none of them is a heuristic:
 *
 * - the two names declare *different* divisions, one of each;
 * - their core names (the name with the `(Div. N)` marker removed) are identical;
 * - their start times are identical and their durations are identical.
 *
 * A pair that differs in any of these is refused; the caller then reports the refusal instead of
 * guessing which contest a relative heading meant.
 */
export function contestsFormDivisionPair(left: CfContestFacts, right: CfContestFacts): boolean {
  if (left.contestId === right.contestId) {
    return false;
  }
  const leftDivision = divisionOfContestName(left.name);
  const rightDivision = divisionOfContestName(right.name);
  if (leftDivision === null || rightDivision === null || leftDivision === rightDivision) {
    return false;
  }
  if (normalizeOfficialTitle(contestCoreName(left.name)) !== normalizeOfficialTitle(contestCoreName(right.name))) {
    return false;
  }
  return (
    left.startTimeSeconds === right.startTimeSeconds && left.durationSeconds === right.durationSeconds
  );
}

/**
 * Resolve a relative reference to one contest of a verified pair.
 *
 * `null` means the pair does not contain that division, so the heading cannot be resolved from this
 * evidence — never that some other contest should be tried.
 */
export function contestIdForDivision(pair: readonly CfContestFacts[], division: 1 | 2): number | null {
  for (const contest of pair) {
    if (divisionOfContestName(contest.name) === division) {
      return contest.contestId;
    }
  }
  return null;
}

/** Contest ids of a pair, smaller first, for the recorded evidence. */
export function orderedContestIds(pair: readonly CfContestFacts[]): readonly number[] {
  return [...pair.map((contest) => contest.contestId)].sort((left, right) => left - right);
}
