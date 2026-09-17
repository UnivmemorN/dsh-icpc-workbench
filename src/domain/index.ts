/**
 * Public domain surface.
 *
 * Everything exported here is pure: types, validated constructors and decision rules.
 * No IO, no runtime imports, no adapters — enforced by `scripts/check-architecture.mjs`.
 */
export {
  DomainError,
  invariant,
  requireFiniteInt,
  type DomainErrorCode,
  type DomainErrorDetails,
} from './errors.js';

export { deepFreeze, isDeeplyFrozen } from './immutable.js';

export {
  canonicalJson,
  contentHashOf,
  sha256Hex,
  utf8Bytes,
  type JsonValue,
} from './hash.js';

export {
  SOURCE_PLATFORMS,
  accountIdOf,
  assertCompoundId,
  assertCredentialFreeHttpUrl,
  assertHttpUrl,
  assertIdPart,
  assertIsoTimestamp,
  decodeIdPart,
  encodeIdPart,
  normalizeKeyPart,
  parseAccountId,
  parseProblemKey,
  problemKey,
  sameId,
  snapshotIdOf,
  submissionKey,
  type ProblemRef,
  type SourcePlatform,
  type SubmissionRef,
} from './ids.js';

export {
  createAccount,
  createSourceInstance,
  requireAccount,
  sameAccount,
  sourceInstanceIdOf,
  type Account,
  type CreateAccountInput,
  type CreateSourceInstanceInput,
  type SourceInstance,
} from './source.js';

export {
  assertSameProblem,
  createNormalizedProblem,
  findRating,
  numericRating,
  type CreateNormalizedProblemInput,
  type NormalizedProblem,
  type PlatformRating,
  type RawTag,
} from './problem.js';

export {
  CF_MIRROR_GROUP_KEY_PREFIX,
  CF_MIRROR_REFERENCE_EXAMPLE_URL,
  CF_MIRROR_RULE_EXPLANATION,
  CF_MIRROR_RULE_ID,
  CODEFORCES_MAIN_INSTANCE_ID,
  LUOGU_OFFICIAL_INSTANCE_ID,
  MAX_CF_MIRROR_CONTEST_ID,
  cfMirrorIdentity,
  cfMirrorIdentityOf,
  cfMirrorProblemKeys,
  mergedGroupKeyOf,
  mergedGroupMemberKeys,
  parseMergedGroupKey,
  problemGroupingOf,
  type CfMirrorIdentity,
  type ParsedMergedGroupKey,
  type ProblemGrouping,
  type ProblemMappingKind,
} from './problem-equivalence.js';

export { compareNaturalKeys, naturalSortKey, numericRatingValue, numericText } from './sorting.js';

export {
  SUBMISSION_VERDICTS,
  createSubmission,
  dedupeSubmissions,
  isAccepted,
  latestSubmissionByProblem,
  reduceSubmissionsByAccount,
  type AccountProblemTally,
  type CreateSubmissionInput,
  type Submission,
  type SubmissionVerdict,
} from './submission.js';

export {
  EDITORIAL_AVAILABILITIES,
  MIN_EVIDENCE_EXCERPT_CHARS,
  assertSolutionSource,
  createEditorialSolution,
  createEditorialSource,
  createEvidenceRef,
  hashEditorialContent,
  normalizeEvidenceText,
  verifyExcerptInSolution,
  type CreateEditorialSolutionInput,
  type CreateEditorialSourceInput,
  type EditorialAvailability,
  type EditorialSolution,
  type EditorialSource,
  type EditorialSourceKind,
  type EvidenceExcerptCheck,
  type EvidenceExcerptFailure,
  type EvidenceRef,
} from './editorial.js';

export {
  PROBLEM_SNAPSHOT_SCHEMA_VERSION,
  availableSources,
  computeSnapshotContentHash,
  createProblemSnapshot,
  findSolution,
  findSource,
  isSnapshotCurrent,
  isSnapshotStale,
  nextSnapshotVersion,
  snapshotHead,
  solutionsForSource,
  type CreateProblemSnapshotInput,
  type ProblemSnapshot,
  type SnapshotHead,
} from './snapshot.js';

export {
  CURRENT_TAXONOMY,
  NON_ALGORITHM_TAG_RULES,
  TAXONOMY_ID_PATTERN,
  TAXONOMY_V1,
  TAXONOMY_V1_VERSION,
  TAXONOMY_V2,
  TAXONOMY_V2_VERSION,
  TAG_CROSSWALK_SAFE_SPELLINGS,
  TAG_MAPPING_RELATIONS,
  TAG_MAPPING_VERSION,
  TAG_VOCABULARIES,
  algorithmRawTags,
  algorithmTagIds,
  assertKnownTag,
  classifyRawTag,
  classifyRawTags,
  createTaxonomy,
  createTaxonomyIndex,
  inferTagVocabulary,
  isAlgorithmRelevant,
  isCanonicalTaxonomyId,
  isCountedTagRelation,
  isTagVocabulary,
  isUnresolvedAlgorithmRelation,
  mapSourceTag,
  nonAlgorithmTagReason,
  normalizeTagText,
  requireKnownTag,
  sourceTagKey,
  tagLookupKey,
  unknownRawTags,
  type MapSourceTagInput,
  type NonAlgorithmReason,
  type NonAlgorithmTagRule,
  type SourceTagMapping,
  type TagClassification,
  type TagMappingRelation,
  type TagVocabulary,
  type Taxonomy,
  type TaxonomyIndex,
  type TaxonomyNode,
  type TaxonomyNodeKind,
} from './taxonomy/index.js';

export {
  assertTaxonomyIdShape,
  createAiTagSuggestion,
  createManualTagDecision,
  createTagDecision,
  currentDecisionPerTag,
  decisionIsEffective,
  effectiveTagIdsByProblem,
  effectiveTagIdsForProblem,
  manualDecisionsForProblem,
  type AiTagSuggestion,
  type CreateAiTagSuggestionInput,
  type CreateManualTagDecisionInput,
  type CreateTagDecisionInput,
  type DecisionReason,
  type ManualTagAction,
  type ManualTagDecision,
  type ModelRole,
  type TagDecision,
  type TagDecisionOrigin,
  type TagDecisionStatus,
} from './tags.js';

export {
  COMPLETENESS_AUDIT_VERSION,
  analysisJobIdOf,
  completenessIsCurrent,
  createAnalysisCompleteness,
  createAnalysisJob,
  createAnalysisResult,
  createModelUsage,
  createReasoningDraft,
  createSuggestionVerification,
  analysisIsStale,
  isLeaseExpired,
  recoverAfterRestart,
  transitionJob,
  verificationFor,
  type AnalysisCompleteness,
  type AnalysisFailure,
  type AnalysisJobCounters,
  type AnalysisJobError,
  type AnalysisJobEvent,
  type AnalysisJobLimits,
  type AnalysisJobState,
  type AnalysisJobStatus,
  type AnalysisResult,
  type AnalysisStatus,
  type CreateAnalysisResultInput,
  type CreateReasoningDraftInput,
  type CreateSuggestionVerificationInput,
  type ModelUsage,
  type ReasoningDraft,
  type SuggestionVerification,
  type VerificationVerdict,
} from './analysis.js';

export {
  DEFAULT_ELIGIBILITY_SETTINGS,
  evaluateAnalysis,
  evaluateSuggestion,
  outcomesRequiringReview,
  resolveTagDecisions,
  type EligibilityDecision,
  type EligibilityOutcome,
  type EligibilitySettings,
  type EvaluateSuggestionContext,
  type ResolvedAnalysis,
} from './eligibility.js';

export {
  COMPLETION_MODES,
  createRetrospective,
  latestRetrospectiveByProblem,
  type CompletionMode,
  type CreateRetrospectiveInput,
  type Retrospective,
} from './retrospective.js';

export {
  DEFAULT_WEAKNESS_SETTINGS,
  assertNoMasteryInference,
  computeWeaknessReports,
  hasInsufficientHistory,
  reportForAccount,
  type AccountWeaknessReport,
  type ComputeWeaknessInput,
  type ConfirmedSkillSummary,
  type RatingSummary,
  type TagWeaknessSample,
  type WeaknessSettings,
} from './weakness.js';

export {
  DEFAULT_MINIMUM_INDEPENDENT_PROBLEMS,
  KNOWLEDGE_NOTES,
  computeKnowledgeEvidence,
  type ComputeKnowledgeEvidenceInput,
  type KnowledgeCoverage,
  type KnowledgeEvidenceReport,
  type KnowledgeDifficultyEvidence,
  type KnowledgeNodeEvidence,
  type KnowledgeNodeStatus,
  type KnowledgeRatingRange,
  type SourceTagMappingDiagnostic,
} from './knowledge.js';

export {
  KNOWLEDGE_ATTRIBUTION_COPYRIGHT_URL,
  KNOWLEDGE_ATTRIBUTION_NOTES,
  KNOWLEDGE_ATTRIBUTION_SOURCES,
  KNOWLEDGE_RESOURCES_BY_TAXONOMY_ID,
  KNOWLEDGE_RESOURCES_CHECKED_DATE,
  knowledgeResourcesFor,
  type KnowledgeAttributionSource,
  type KnowledgeResource,
  type KnowledgeResourceRelation,
} from './knowledge-resources.js';

export {
  ABILITY_ASSESSMENT_VERSION,
  ABILITY_EVIDENCE_REASONS,
  ABILITY_MIN_ESTIMATE_SAMPLES,
  ABILITY_OFFICIAL_RATING_NOTE,
  ABILITY_REASON_TEXT,
  ABILITY_RECENT_WINDOW_DAYS,
  CF_OFFICIAL_RATING_API_HELP_URL,
  CF_RATING_DIMENSION,
  CF_TRAINING_BAND_HEURISTIC_VERSION,
  CF_TRAINING_POOL_FLOOR,
  DEFAULT_ABILITY_SETTINGS,
  aggregateAbilityForPlanning,
  computeAbilityAssessment,
  type AbilityAssessment,
  type AbilityHistoryComparison,
  type AbilityHistoryPeriod,
  type AbilityPeriodAssessment,
  type AbilityAssessmentSettings,
  type AbilityBucket,
  type AbilityCompletionMode,
  type AbilityCompletionModeCounts,
  type AbilityCompletionModes,
  type AbilityConfidence,
  type AbilityCounts,
  type AbilityCoverage,
  type AbilityEstimateBasis,
  type AbilityEstimateStatus,
  type AbilityEvidenceReasonCode,
  type AbilityExcludedSamples,
  type AbilityNativeDistribution,
  type AbilityOfficialRatingStatus,
  type AbilityPlanningAggregate,
  type AbilityRatingRange,
  type AbilityTrainingEstimate,
  type AbilityWindowCounts,
  type ComputeAbilityAssessmentInput,
} from './ability.js';

export {
  computeTrainingStatistics,
  expectedRatingDimension,
  type ComputeTrainingStatisticsInput,
  type PlatformTagStatRow,
  type PlatformTagStatistics,
  type SolvedBucket,
  type SolvedDimensionDistribution,
  type SolvedDistribution,
  type TrainingStatistics,
} from './training-stats.js';

export {
  MAX_PLAN_OBJECTIVE_CHARS,
  TRAINING_TASK_AXES,
  TRAINING_TASK_KINDS,
  adoptPlan,
  checkOffTask,
  createTrainingCandidate,
  createTrainingTask,
  duplicateCandidateIds,
  editPlanTask,
  lowestNumericRating,
  planDiagnosisProblem,
  previewPlan,
  recalcUnmetMinutes,
  trainingPlanIdOf,
  validatePlanDiagnosis,
  type CreateTrainingCandidateInput,
  type PlanDiagnosis,
  type PlanPreview,
  type PlanTaskPatch,
  type TrainingCandidate,
  type TrainingCandidateOrigin,
  type TrainingEvidence,
  type TrainingEvidenceLevel,
  type TrainingPlan,
  type TrainingPlanStatus,
  type TrainingTask,
  type TrainingTaskAxis,
  type TrainingTaskKind,
  type TrainingTaskStatus,
  type UnmetMinutes,
} from './training.js';

export {
  BEGINNER_TAG_IDS,
  DEFAULT_TRAINING_PLAN_SETTINGS,
  assertCandidateExists,
  checkCandidate,
  generateRulePlan,
  parseModelPlanDraft,
  prepareCandidatePool,
  validateModelPlan,
  type BeginnerRecommendation,
  type CandidateRejectionReason,
  type ModelPlanValidation,
  type PlanGenerationInput,
  type PlanGenerationResult,
  type PlanValidationCode,
  type PlanValidationError,
  type RejectedCandidate,
  type TrainingPlanSettings,
  type ValidateModelPlanInput,
} from './plan-generator.js';

export {
  createCancellationSource,
  isCancelled,
  throwIfCancelled,
  type CancellationSource,
  type CancellationToken,
} from './cancellation.js';

export { type KnowledgeDifficultyBand } from './knowledge-difficulty.js';

export * from './ability-calibration.js';
export * from './official-rating.js';
// Detachable training-method guidance (Sprint 18b): the public companion seam, its bounded
// definition validation and the immutable per-plan capture.
export * from './guidance.js';
// User-entered virtual-contest performance evidence (Sprint 18c): the revisioned per-account
// ledger, its strict validator and the identifier-free planning summary with its mutation hash.
export * from './virtual-performance.js';
// AI-inferred ability assessment reports (Sprint 18d1): the strictly bounded answer shape, its
// evidence-reference/anchor rules and the labelled, hash-checked stored record.
export * from './assessment.js';
// Two-cookie Luogu session normalization (Stage 19a): the single pure rule shared by the browser
// half, the connect route, the connection adapter and the authenticated reader.
export * from './luogu-session-cookie.js';
// Local recoverable problem dispositions (Sprint 27a): the pure skip/trash rule set every layer
// evaluates — the stored tombstone shape, the hidden-key predicate the SQL reads use and the
// all-or-none batch/expected-state validation of one disposition request.
export * from './problem-disposition.js';
