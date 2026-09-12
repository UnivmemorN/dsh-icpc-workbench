/**
 * Taxonomy model: hierarchical algorithm/technique tags with stable canonical ids.
 *
 * Rules encoded here (and enforced in `createTaxonomy`):
 * - ids are stable, dot-separated, lowercase — they are persisted and must never be
 *   renamed implicitly; renames are a new taxonomy version plus an explicit migration.
 * - every parent exists and the graph is acyclic.
 * - alias lookup is unambiguous: one normalised alias maps to exactly one node.
 */
import { DomainError, invariant } from '../errors.js';
import { deepFreeze } from '../immutable.js';
import { normalizeKeyPart } from '../ids.js';

export type TaxonomyNodeKind = 'category' | 'technique';

export interface TaxonomyNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: TaxonomyNodeKind;
  readonly names: { readonly en: string; readonly zh: string };
  /** Alternative spellings, including platform raw-tag spellings (en + zh). */
  readonly aliases: readonly string[];
  readonly description: string;
}

export interface Taxonomy {
  /** Version string of the tag vocabulary (e.g. `2026.09.1`). */
  readonly version: string;
  readonly nodes: readonly TaxonomyNode[];
}

export const TAXONOMY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

/**
 * Normalise tag text for alias matching:
 * NFC, lowercase, separators (`_ - /` and dash punctuation) to spaces, surrounding
 * punctuation/brackets/wildcards removed, whitespace collapsed.
 */
export function normalizeTagText(raw: string): string {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/[_\u2010-\u2015/\\]+/gu, ' ')
    .replace(/[()[\]{}（）【】「」*#]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Build a validated, frozen taxonomy. */
export function createTaxonomy(input: Taxonomy): Taxonomy {
  const version = input.version.trim();
  invariant(version.length > 0, 'invalid_input', 'taxonomy version must not be empty');

  const nodes: TaxonomyNode[] = [];
  const byId = new Map<string, TaxonomyNode>();
  for (const rawNode of input.nodes) {
    const id = rawNode.id.trim();
    invariant(TAXONOMY_ID_PATTERN.test(id), 'invalid_input', `taxonomy id ${JSON.stringify(id)} is not canonical`, {
      id,
    });
    invariant(!byId.has(id), 'duplicate_id', `duplicate taxonomy id ${id}`, { id });
    const names = { en: rawNode.names.en.trim(), zh: rawNode.names.zh.trim() };
    invariant(names.en.length > 0 && names.zh.length > 0, 'invalid_input', `taxonomy node ${id} needs en+zh names`, {
      id,
    });
    const node: TaxonomyNode = {
      id,
      parentId: rawNode.parentId,
      kind: rawNode.kind,
      names,
      aliases: [...new Set(rawNode.aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0))],
      description: rawNode.description.trim(),
    };
    byId.set(id, node);
    nodes.push(node);
  }

  for (const node of nodes) {
    if (node.parentId !== null) {
      invariant(byId.has(node.parentId), 'missing_reference', `taxonomy node ${node.id} has unknown parent`, {
        id: node.id,
        parentId: node.parentId,
      });
      invariant(node.parentId !== node.id, 'invalid_input', `taxonomy node ${node.id} is its own parent`, { id: node.id });
    }
  }

  // Acyclic check (walk each node to the root; the depth bound catches cycles).
  for (const node of nodes) {
    let cursor: TaxonomyNode | undefined = node;
    let depth = 0;
    while (cursor) {
      depth += 1;
      invariant(depth <= nodes.length + 1, 'invalid_input', `taxonomy cycle detected at ${node.id}`, { id: node.id });
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
  }

  const aliasOwner = new Map<string, string>();
  for (const node of nodes) {
    for (const alias of [...node.aliases, node.names.en, node.names.zh]) {
      const normalized = normalizeTagText(alias);
      if (normalized.length === 0) {
        continue;
      }
      const owner = aliasOwner.get(normalized);
      invariant(
        owner === undefined || owner === node.id,
        'duplicate_id',
        `alias ${JSON.stringify(alias)} is claimed by both ${owner} and ${node.id}`,
        { alias, owner, id: node.id },
      );
      aliasOwner.set(normalized, node.id);
    }
  }

  return deepFreeze({ version, nodes });
}

/** Query helper over one taxonomy. */
export interface TaxonomyIndex {
  readonly taxonomy: Taxonomy;
  readonly ids: readonly string[];
  has(id: string): boolean;
  node(id: string): TaxonomyNode | null;
  /** Canonical id for a raw tag spelling, or `null` when unknown to the vocabulary. */
  resolveAlias(raw: string): { readonly taxonomyId: string; readonly matchedAlias: string } | null;
  ancestors(id: string): readonly TaxonomyNode[];
  children(id: string): readonly TaxonomyNode[];
  /** Ancestor chain including the node itself, root first. */
  lineage(id: string): readonly TaxonomyNode[];
}

/** Build a lookup index for a taxonomy (alias resolution is normalised and unambiguous). */
export function createTaxonomyIndex(taxonomy: Taxonomy): TaxonomyIndex {
  const byId = new Map<string, TaxonomyNode>(taxonomy.nodes.map((node) => [node.id, node]));
  const aliasMap = new Map<string, string>();
  for (const node of taxonomy.nodes) {
    for (const alias of [...node.aliases, node.names.en, node.names.zh]) {
      const normalized = normalizeTagText(alias);
      if (normalized.length > 0 && !aliasMap.has(normalized)) {
        aliasMap.set(normalized, node.id);
      }
    }
  }

  const ancestors = (id: string): TaxonomyNode[] => {
    const out: TaxonomyNode[] = [];
    let cursor = byId.get(id)?.parentId ?? null;
    while (cursor) {
      const node = byId.get(cursor);
      if (!node) {
        break;
      }
      out.push(node);
      cursor = node.parentId;
    }
    return out;
  };

  return {
    taxonomy,
    ids: taxonomy.nodes.map((node) => node.id),
    has: (id) => byId.has(id),
    node: (id) => byId.get(id) ?? null,
    resolveAlias: (raw) => {
      const normalized = normalizeTagText(raw);
      if (normalized.length === 0) {
        return null;
      }
      const taxonomyId = aliasMap.get(normalized);
      return taxonomyId ? { taxonomyId, matchedAlias: normalized } : null;
    },
    ancestors,
    children: (id) => taxonomy.nodes.filter((node) => node.parentId === id),
    lineage: (id) => {
      const node = byId.get(id);
      if (!node) {
        return [];
      }
      return [...ancestors(id).reverse(), node];
    },
  };
}

/** Validate that a taxonomy id is known; returns the id or `null`. */
export function requireKnownTag(index: TaxonomyIndex, taxonomyId: string): string | null {
  return index.has(taxonomyId) ? taxonomyId : null;
}

/** Throw for an unknown taxonomy id (used where an unknown id is a hard error). */
export function assertKnownTag(index: TaxonomyIndex, taxonomyId: string): string {
  if (!index.has(taxonomyId)) {
    throw new DomainError('unknown_taxonomy_id', `unknown taxonomy id ${taxonomyId}`, { taxonomyId });
  }
  return taxonomyId;
}

/** Validate a candidate id string before it is used as a taxonomy id. */
export function isCanonicalTaxonomyId(value: string): boolean {
  return TAXONOMY_ID_PATTERN.test(value) && normalizeKeyPart(value).length === value.length;
}
