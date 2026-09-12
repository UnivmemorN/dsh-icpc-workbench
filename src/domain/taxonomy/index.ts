/** Public taxonomy surface. */
export {
  TAXONOMY_ID_PATTERN,
  assertKnownTag,
  createTaxonomy,
  createTaxonomyIndex,
  isCanonicalTaxonomyId,
  normalizeTagText,
  requireKnownTag,
  type Taxonomy,
  type TaxonomyIndex,
  type TaxonomyNode,
  type TaxonomyNodeKind,
} from './types.js';

export { CURRENT_TAXONOMY, TAXONOMY_V1, TAXONOMY_V1_VERSION } from './v1.js';

export {
  NON_ALGORITHM_TAG_RULES,
  algorithmRawTags,
  algorithmTagIds,
  classifyRawTag,
  classifyRawTags,
  isAlgorithmRelevant,
  tagLookupKey,
  unknownRawTags,
  type NonAlgorithmReason,
  type NonAlgorithmTagRule,
  type TagClassification,
} from './classify.js';
