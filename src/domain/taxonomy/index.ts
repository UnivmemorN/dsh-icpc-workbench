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

export { TAXONOMY_V1, TAXONOMY_V1_VERSION } from './v1.js';

export { CURRENT_TAXONOMY, TAXONOMY_V2, TAXONOMY_V2_VERSION } from './v2.js';

export {
  NON_ALGORITHM_TAG_RULES,
  algorithmRawTags,
  algorithmTagIds,
  classifyRawTag,
  classifyRawTags,
  isAlgorithmRelevant,
  nonAlgorithmTagReason,
  tagLookupKey,
  unknownRawTags,
  type NonAlgorithmReason,
  type NonAlgorithmTagRule,
  type TagClassification,
} from './classify.js';

export {
  TAG_CROSSWALK_SAFE_SPELLINGS,
  TAG_MAPPING_RELATIONS,
  TAG_MAPPING_VERSION,
  TAG_VOCABULARIES,
  inferTagVocabulary,
  isCountedTagRelation,
  isTagVocabulary,
  isUnresolvedAlgorithmRelation,
  mapSourceTag,
  sourceTagKey,
  type MapSourceTagInput,
  type SourceTagMapping,
  type TagMappingRelation,
  type TagVocabulary,
} from './crosswalk.js';
