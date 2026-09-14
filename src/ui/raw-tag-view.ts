/**
 * Readable display rules for platform raw tags (Sprint 21a).
 *
 * A raw platform tag is **provenance**, never a tag this plugin verified. This module therefore only
 * *adds* a readable platform name to a strict numeric `luogu-tag:<id>` and never rewrites, merges or
 * reinterprets anything else:
 *
 * 1. **Source-gated.** A name is resolved only when the caller supplies the actual source instance
 *    this raw tag came from (`platform === 'luogu'` at `luogu.com.cn` / `www.luogu.com.cn`). The raw
 *    prefix alone, a mirrored Luogu deployment and every Codeforces/manual tag stay untouched, so a
 *    coincidental string can never be relabelled through another platform.
 * 2. **Strict and explicit.** Only `^luogu-tag:-?\d+$` is treated as an id; ids outside the bundled
 *    snapshot (including negative or hostile ones) render as `洛谷标签 #<id>（名称未收录）` while the
 *    exact raw string stays available as provenance. Malformed text is never guessed into a name.
 * 3. **One visible name per identity, never a lost raw.** When a raw list carries both a known
 *    numeric id and the platform's exact dictionary name for it, the two become **one** visible row
 *    that remembers both exact strings. Two *distinct* ids whose names happen to coincide are never
 *    combined: each keeps its own row and its own id.
 * 4. **Absent stays absent.** `null`/`undefined` input is reported as `null` (not rendered as an
 *    empty tag list), an empty list stays an empty list, and no name is ever manufactured.
 *
 * The module is pure: no React, no HTTP, no storage, no clock and no model call, so it can be tested
 * without a browser and the same rules back the problem page, the plan candidates and the weakness
 * and knowledge diagnostics.
 */
import { LUOGU_TAG_NAME_BY_ID } from './luogu-tag-dictionary.js';

/** The source identity a raw tag can be attributed to; never a parsed problem key. */
export interface RawTagSource {
  readonly platform: string;
  readonly domain: string | null;
}

/** One boot-catalog source instance: the identity above plus the stable id used to look it up. */
export interface RawTagSourceEntry extends RawTagSource {
  readonly id: string;
}

/** One visible raw-tag row plus every exact raw string it stands for. */
export interface RawTagView {
  /** Visible label: a dictionary name, the explicit unknown-id fallback, or the untouched raw. */
  readonly label: string;
  /** Every distinct exact raw string this row represents, in input order; never empty. */
  readonly raws: readonly string[];
  /** Luogu dictionary id when this row resolved one; `null` for untouched or non-Luogu input. */
  readonly luoguTagId: number | null;
  /** `true` when {@link RawTagView.label} is the exact dictionary name of {@link RawTagView.luoguTagId}. */
  readonly dictionaryName: boolean;
  /** `true` when {@link RawTagView.luoguTagId} is a strict numeric id the snapshot does not name. */
  readonly unknownDictionaryId: boolean;
}

/** One whole raw-tag list as a surface should render it; `null` means the list was not supplied. */
export interface RawTagListView {
  readonly items: readonly RawTagView[];
  /** Every distinct exact raw string of the input, in input order: the provenance list. */
  readonly raws: readonly string[];
  /** `true` when dictionary resolution was attempted (the source was the official Luogu site). */
  readonly luoguSource: boolean;
  /** Rows whose label is a bundled dictionary name. */
  readonly namedCount: number;
  /** Rows whose strict numeric id the bundled snapshot does not contain (negative ids included). */
  readonly unknownIdCount: number;
}

/** Domains of the official Luogu deployment; any other host keeps its raw tags untouched. */
const OFFICIAL_LUOGU_DOMAINS: ReadonlySet<string> = new Set(['luogu.com.cn', 'www.luogu.com.cn']);

/**
 * Strict numeric Luogu platform identifier.
 *
 * The prefix is lowercase and the id is a plain (optionally negative) decimal integer; anything else
 * — a sign, a decimal point, whitespace, another case — is not an id and is displayed verbatim.
 */
const LUOGU_RAW_TAG_ID = /^luogu-tag:(-?\d+)$/u;

/** What the bundled dictionary is and is not; every surface that resolves a name shares this. */
export const LUOGU_TAG_DICTIONARY_CAVEAT =
  '这是平台原始数据，不是本插件的复核标签；快照中没有的编号保持“名称未收录”，字典随插件版本更新，已有记录不需要迁移或重新导入。';

/** Fallback label of a strict numeric Luogu id the bundled snapshot does not name. */
export function rawTagUnknownIdLabel(id: number): string {
  return `洛谷标签 #${id}（名称未收录）`;
}

/**
 * `true` only for the official Luogu site.
 *
 * A missing domain fails closed: an instance whose host is unknown cannot prove it is Luogu, so its
 * raw tags keep their exact stored text instead of borrowing Luogu names.
 */
export function isOfficialLuoguSource(source: RawTagSource | null | undefined): boolean {
  if (source === null || source === undefined || source.platform !== 'luogu') {
    return false;
  }
  return OFFICIAL_LUOGU_DOMAINS.has(source.domain?.trim().toLowerCase() ?? '');
}

/** Numeric id of one strict `luogu-tag:<id>` string, or `null` when it is not one. */
export function luoguTagIdOfRaw(raw: string): number | null {
  const match = LUOGU_RAW_TAG_ID.exec(raw);
  const digits = match?.[1];
  if (digits === undefined) {
    return null;
  }
  const id = Number(digits);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Look one source instance up in the boot catalog by its stable id.
 *
 * The id is only ever used as a lookup key; `null` (no id) and an unknown id both answer `null`, so
 * an instance the catalog no longer offers cannot resolve names through a stale assumption.
 */
export function rawTagSourceOf(
  sourceInstanceId: string | null | undefined,
  sources: readonly RawTagSourceEntry[],
): RawTagSource | null {
  if (typeof sourceInstanceId !== 'string' || sourceInstanceId.length === 0) {
    return null;
  }
  return sources.find((entry) => entry.id === sourceInstanceId) ?? null;
}

/**
 * Source descriptor of the selected account, resolved account → source instance → catalog entry.
 *
 * The same account switching that scopes every other read scopes the dictionary: no account, an
 * unknown account or a catalog that dropped the instance answers `null`, and a different account
 * therefore never inherits the previous account's platform names.
 */
export function accountRawTagSource(
  accountId: string | null | undefined,
  accounts: readonly { readonly id: string; readonly sourceInstanceId: string }[],
  sources: readonly RawTagSourceEntry[],
): RawTagSource | null {
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return null;
  }
  const account = accounts.find((entry) => entry.id === accountId);
  return account === undefined ? null : rawTagSourceOf(account.sourceInstanceId, sources);
}

/**
 * Display row of **one** raw tag, without merging it into a list.
 *
 * This is the row-level form used by per-tag tables (weakness label rows, knowledge mapping
 * diagnostics), where two platform labels must stay two rows and their per-tag counts are never
 * combined. A name is only produced for a strict numeric id of the official Luogu source.
 */
export function rawTagLabel(
  raw: string,
  source: RawTagSource | null | undefined,
  names: ReadonlyMap<number, string> = LUOGU_TAG_NAME_BY_ID,
): RawTagView {
  if (!isOfficialLuoguSource(source)) {
    return { label: raw, raws: [raw], luoguTagId: null, dictionaryName: false, unknownDictionaryId: false };
  }
  const id = luoguTagIdOfRaw(raw);
  if (id === null) {
    return { label: raw, raws: [raw], luoguTagId: null, dictionaryName: false, unknownDictionaryId: false };
  }
  const name = names.get(id);
  return name === undefined
    ? { label: rawTagUnknownIdLabel(id), raws: [raw], luoguTagId: id, dictionaryName: false, unknownDictionaryId: true }
    : { label: name, raws: [raw], luoguTagId: id, dictionaryName: true, unknownDictionaryId: false };
}

/** Mutable builder of one {@link RawTagView}; the returned views are read as readonly. */
interface RawTagViewDraft {
  label: string;
  raws: string[];
  luoguTagId: number | null;
  dictionaryName: boolean;
  unknownDictionaryId: boolean;
}

/**
 * Display rows of a whole raw-tag list, with duplicate-identity suppression.
 *
 * A blank string is not a tag and is dropped (the domain already refuses blank raw tags), an exact
 * duplicate is consumed once, and the two merge rules keep one visible row per platform identity:
 *
 * - the same resolved id spelled twice (`luogu-tag:3` and `luogu-tag:03`) is one row;
 * - a known id plus the platform's **exact** dictionary name for it is one row that remembers both
 *   raw strings, so `查看原始标签编号` still lists both and no identity is lost.
 *
 * Two distinct ids are never merged, even when their dictionary names coincide: each keeps its own
 * row, its own id and its own raw provenance. A text tag is merged into a name only when exactly one
 * id in the input claims that name; when two ids claim it, the text row stays its own honest row in
 * either input order instead of being attributed to a guessed id.
 *
 * @returns `null` for `null`/`undefined` input (the list is absent, not empty), otherwise the rows.
 */
export function rawTagListView(
  rawTags: readonly string[] | null | undefined,
  source: RawTagSource | null | undefined,
  names: ReadonlyMap<number, string> = LUOGU_TAG_NAME_BY_ID,
): RawTagListView | null {
  if (rawTags === null || rawTags === undefined) {
    return null;
  }
  const luoguSource = isOfficialLuoguSource(source);
  // Names this very list attributes to two or more distinct ids are ambiguous. A bare text tag with
  // such a name is never attached to one of them, and an id never absorbs a text row that could
  // belong to its twin, so the input order cannot change which rows appear.
  const idsByName = new Map<string, Set<number>>();
  if (luoguSource) {
    for (const raw of rawTags) {
      const id = luoguTagIdOfRaw(raw);
      const name = id === null ? undefined : names.get(id);
      if (id === null || name === undefined) {
        continue;
      }
      const owners = idsByName.get(name) ?? new Set<number>();
      owners.add(id);
      idsByName.set(name, owners);
    }
  }
  const nameIsAmbiguous = (name: string): boolean => (idsByName.get(name)?.size ?? 0) > 1;
  const items: RawTagViewDraft[] = [];
  const raws: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTags) {
    // A blank entry carries no identity; it is dropped instead of becoming an empty-looking tag.
    if (raw.trim().length === 0 || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    raws.push(raw);
    const id = luoguSource ? luoguTagIdOfRaw(raw) : null;
    if (id === null) {
      // A text tag that names two different ids stays its own row: attaching it to either one would
      // be a guess, and the input order would otherwise decide which id it joined.
      const namedRows = nameIsAmbiguous(raw)
        ? []
        : items.filter((entry) => entry.dictionaryName && entry.luoguTagId !== null && entry.label === raw);
      const namedRow = namedRows.length === 1 ? namedRows[0] : undefined;
      if (namedRow === undefined) {
        items.push({ label: raw, raws: [raw], luoguTagId: null, dictionaryName: false, unknownDictionaryId: false });
      } else {
        namedRow.raws.push(raw);
      }
      continue;
    }
    const sameId = items.find((entry) => entry.luoguTagId === id);
    if (sameId !== undefined) {
      sameId.raws.push(raw);
      continue;
    }
    const name = names.get(id);
    if (name === undefined) {
      items.push({
        label: rawTagUnknownIdLabel(id),
        raws: [raw],
        luoguTagId: id,
        dictionaryName: false,
        unknownDictionaryId: true,
      });
      continue;
    }
    // The platform sometimes reports the numeric id and its textual name side by side; they are the
    // same platform identity, so they share one row and both exact strings stay in `raws`.
    const textRow = nameIsAmbiguous(name)
      ? undefined
      : items.find((entry) => entry.luoguTagId === null && !entry.dictionaryName && entry.label === name);
    if (textRow === undefined) {
      items.push({ label: name, raws: [raw], luoguTagId: id, dictionaryName: true, unknownDictionaryId: false });
    } else {
      textRow.luoguTagId = id;
      textRow.dictionaryName = true;
      textRow.raws.push(raw);
    }
  }
  return {
    items,
    raws,
    luoguSource,
    namedCount: items.filter((entry) => entry.dictionaryName).length,
    unknownIdCount: items.filter((entry) => entry.unknownDictionaryId).length,
  };
}
