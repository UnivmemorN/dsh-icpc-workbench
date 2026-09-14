/**
 * Assessment source capture (Sprint 18d1).
 *
 * One free `captureAssessmentInput` reads a single account's own evidence and freezes it into an
 * {@link AssessmentCapture}: an **internal snapshot** (identity plus every semantic aggregate the
 * capture was derived from) and a **public prompt payload** (identifier-free) that is the only thing
 * a model may ever see. The two are stored together but never conflated, so a later stage can prove
 * what the model was shown without ever handing it the account identity.
 *
 * Privacy rules, enforced by the *shape* rather than by filtering:
 *
 * - the prompt carries an exact official/self/training reference, aggregate practice statistics, a
 *   bounded (<= {@link MAX_ASSESSMENT_KNOWLEDGE_ROWS}) knowledge summary keyed by native difficulty
 *   band, the identifier-free 18c virtual-contest summary, the captured training method text and a
 *   list of synthetic `evidenceRef`s with source-category labels;
 * - it has no field an account id, handle, contest id, exact timestamp, source URL, note, rank,
 *   problem key, submission row or raw platform tag could travel in.
 *
 * The evidence hash binds the captured model input. The source hash uses a digest of the actual
 * stored input rows plus taxonomy/method versions: metadata or private-note edits invalidate a
 * preparation even when aggregate counts stay equal. Clock-only movement never changes sourceHash;
 * a reserved call continues to use the original captured time windows.
 *
 * Nothing here reads a clock, a store or a model.
 */
import {
  ASSESSMENT_ANCHOR_KINDS,
  SOURCE_PLATFORMS,
  assertIsoTimestamp,
  assessmentAnchorOf,
  canonicalJson,
  contentHashOf,
  deepFreeze,
  invariant,
  validateCalibrationRange,
  validateCompetitionSummary,
  validateGuidanceSnapshot,
  validateTrainingReference,
  validateVirtualPerformancePlanningSummary,
  virtualPerformanceEvidenceIdentity,
  type AbilityCalibrationRange,
  type AbilityPlanningAggregate,
  type AbilityTrainingReference,
  type AssessmentAnchorFacts,
  type AssessmentAnchorKind,
  type CancellationToken,
  type CompetitionSummary,
  type GuidanceSnapshot,
  type KnowledgeNodeStatus,
  type SourcePlatform,
  type VirtualPerformancePlanningSummary,
} from '../domain/index.js';
import { validateAbilityPlanningAggregate } from './planning-types.js';

/** Version of the capture shape and its hashing rules; bump when an exported meaning changes. */
export const ASSESSMENT_CAPTURE_VERSION = 'assessment-capture.1';

/** Hard bound of the knowledge-by-native-difficulty rows one capture may expose. */
export const MAX_ASSESSMENT_KNOWLEDGE_ROWS = 80;

/** Bound of the synthesized evidence list; the selection below stays well inside it. */
export const MAX_ASSESSMENT_EVIDENCE_ENTRIES = 160;

/** Bound of the per-run virtual-contest references exposed next to the aggregate ledger entry. */
export const MAX_ASSESSMENT_VIRTUAL_REFS = 20;

/** Longest accepted one evidence label / detail. */
export const MAX_ASSESSMENT_EVIDENCE_LABEL_CHARS = 120;
export const MAX_ASSESSMENT_EVIDENCE_DETAIL_CHARS = 400;

/** Fixed reference of the official-rating evidence entry. */
export const ASSESSMENT_OFFICIAL_RATING_REF = 'ev-official-rating';
/** Fixed reference of the aggregate virtual-contest ledger entry. */
export const ASSESSMENT_VIRTUAL_LEDGER_REF = 'ev-virtual-ledger';

/** Fixed disclosure of the prompt payload: what the assessment was given and what it was not. */
export const ASSESSMENT_INPUT_DISCLOSURE =
  '评估输入为去标识的聚合证据：官方/自评水平参考、练习与复盘统计、按原生难度分带的知识证据、用户录入的虚拟参赛表现的聚合与少量条目，以及用户显式选择的评估方法文本；不含账号、用户名、比赛编号、提交明细、题目链接、备注或具体时间戳。';

/** Source-category labels; every evidence entry carries exactly one. */
export const ASSESSMENT_EVIDENCE_CATEGORIES = [
  'official_rating',
  'self_assessment',
  'practice_history',
  'coverage',
  'knowledge',
  'virtual_performance',
  'training_method',
] as const;
export type AssessmentEvidenceCategory = (typeof ASSESSMENT_EVIDENCE_CATEGORIES)[number];

const KNOWLEDGE_STATUSES: readonly KnowledgeNodeStatus[] = [
  'not_observed',
  'unconfirmed',
  'needs_practice',
  'practicing',
  'independent_evidence',
  'category_summary',
];

/**
 * One knowledge row of the bounded native-difficulty summary.
 *
 * Counts are distinct-problem counts of the *difficulty band* the row belongs to, and the evidence
 * channels stay distinguishable exactly as the 09a reduction defines them.
 */
export interface AssessmentKnowledgeRow {
  /** Native difficulty band label (from `knowledgeDifficultyPartitions`). */
  readonly band: string;
  readonly taxonomyId: string;
  readonly status: KnowledgeNodeStatus;
  readonly observedRelatedDistinct: number;
  readonly platformSolvedDistinct: number;
  readonly verifiedSolvedDistinct: number;
  readonly retrospectiveIndependentDistinct: number;
  readonly retrospectiveAssistedDistinct: number;
  readonly retrospectiveSolutionUsedDistinct: number;
}

/** One synthetic, stable evidence reference with its source-category label. */
export interface AssessmentEvidenceEntry {
  /** Synthetic stable reference (`ev-…`); never a stored id, key or URL. */
  readonly evidenceRef: string;
  readonly category: AssessmentEvidenceCategory;
  readonly label: string;
  readonly detail: string;
}

/** The anchor as the prompt sees it, including the reference a report must cite to use it. */
export interface AssessmentPromptAnchor extends AssessmentAnchorFacts {
  readonly evidenceRef: string | null;
}

/**
 * The only shape a model may be shown.
 *
 * It is derived deterministically from the internal snapshot by {@link assessmentPromptOf}; there is
 * no field for an account identifier, a handle, a contest id, a timestamp, a URL or a note.
 */
export interface AssessmentModelEvidence {
  readonly version: string;
  readonly ability: AbilityPlanningAggregate;
  readonly officialRating: CompetitionSummary;
  readonly anchor: AssessmentPromptAnchor;
  readonly knowledge: readonly AssessmentKnowledgeRow[];
  readonly knowledgeTotalRows: number;
  readonly knowledgeOmittedRows: number;
  readonly virtualPerformance: VirtualPerformancePlanningSummary;
  readonly evidence: readonly AssessmentEvidenceEntry[];
  readonly disclosure: string;
}

/**
 * Internal snapshot of one capture: identity-free aggregates plus the source signatures a later
 * recapture is compared against. It is stored, never sent to a model.
 */
export interface AssessmentSourceSnapshot {
  /** Hash of the actual stored input rows; private inputs are never part of the model payload. */
  readonly sourceEvidenceHash: string;
  readonly platform: SourcePlatform;
  readonly taxonomyVersion: string;
  readonly officialRating: CompetitionSummary;
  readonly trainingReference: AbilityTrainingReference;
  /** Latest self-assessment revision, or `null` when the account never calibrated. */
  readonly calibration: { readonly revision: number; readonly range: AbilityCalibrationRange | null } | null;
  readonly ability: AbilityPlanningAggregate;
  /** The kept rows of the bounded knowledge summary, in the deterministic selection order. */
  readonly knowledge: readonly AssessmentKnowledgeRow[];
  /** Rows the selection considered before the bound was applied. */
  readonly knowledgeTotalRows: number;
  /** Rows dropped by the bound; an explicit count, never a silent truncation. */
  readonly knowledgeOmittedRows: number;
  readonly virtualPerformance: VirtualPerformancePlanningSummary;
  readonly guidance: GuidanceSnapshot;
}

/** One free, durable capture: the internal snapshot, the public prompt and their two hashes. */
export interface AssessmentCapture {
  readonly capturedAt: string;
  /** The one account this capture describes; it is never part of the prompt payload. */
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly snapshot: AssessmentSourceSnapshot;
  readonly prompt: AssessmentModelEvidence;
  /** Clock-free hash of {@link AssessmentCapture.prompt}. */
  readonly evidenceHash: string;
  /** Clock-free hash of the source identity and signatures, folding in `evidenceHash`. */
  readonly sourceHash: string;
}

/** What one capture is asked for: an account, the observation instant and the method selection. */
export interface AssessmentCaptureRequest {
  readonly accountId: string;
  /** Explicit observation instant; this module never reads a real clock. */
  readonly capturedAt: string;
  /**
   * Explicit assessment-method selection, or omitted/`null` for the unguided diagnostic baseline.
   *
   * A selection is captured from the installed catalogue and must resolve to at least one method
   * that offers assessment guidance; it is refused — never silently replaced — when a method is
   * missing, replaced or assessment-incapable.
   */
  readonly guidanceMethodIds?: readonly string[] | null;
}

/**
 * Source-capture collaborator, implemented by the workbench service.
 *
 * The call is free and read-only: it writes nothing, dispatches nothing and captures the exact
 * selection it was asked for. Recapture is simply calling it again with the **same** request and
 * comparing {@link AssessmentCapture.sourceHash}: because every clock-derived label is excluded from
 * the hash, an unchanged store yields an identical hash while any real mutation (a submission, a
 * retrospective, a tag decision, a calibration, an official refresh, a virtual-ledger save or
 * delete, a method change) changes it.
 */
export interface AssessmentDataPort {
  /** `join` requires the caller to own a transaction on this same store. */
  captureAssessmentInput(request: AssessmentCaptureRequest, token: CancellationToken, transactionMode?: 'own' | 'join'): Promise<AssessmentCapture>;
}

// ---------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------

/** Derive the public prompt payload of one validated snapshot. */
export function assessmentPromptOf(snapshot: AssessmentSourceSnapshot): AssessmentModelEvidence {
  const facts = assessmentAnchorOf({
    officialRating: snapshot.officialRating,
    virtualPerformance: snapshot.virtualPerformance,
  });
  const anchor: AssessmentPromptAnchor = deepFreeze({
    ...facts,
    evidenceRef:
      facts.kind === 'official_rating'
        ? ASSESSMENT_OFFICIAL_RATING_REF
        : facts.kind === 'virtual_performance'
          ? ASSESSMENT_VIRTUAL_LEDGER_REF
          : null,
  });
  return deepFreeze({
    version: ASSESSMENT_CAPTURE_VERSION,
    ability: snapshot.ability,
    officialRating: snapshot.officialRating,
    anchor,
    knowledge: snapshot.knowledge,
    knowledgeTotalRows: snapshot.knowledgeTotalRows,
    knowledgeOmittedRows: snapshot.knowledgeOmittedRows,
    virtualPerformance: snapshot.virtualPerformance,
    evidence: assessmentEvidenceEntries(snapshot, anchor),
    disclosure: ASSESSMENT_INPUT_DISCLOSURE,
  });
}

/** Assemble and hash one capture from an already-collected snapshot. */
export function createAssessmentCapture(input: {
  readonly capturedAt: string;
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly snapshot: AssessmentSourceSnapshot;
}): AssessmentCapture {
  const snapshot = validateAssessmentSourceSnapshot(input.snapshot);
  const prompt = assessmentPromptOf(snapshot);
  const evidenceHash = assessmentEvidenceHash(prompt);
  return validateAssessmentCapture({
    capturedAt: input.capturedAt,
    accountId: input.accountId,
    sourceInstanceId: input.sourceInstanceId,
    snapshot,
    prompt,
    evidenceHash,
    sourceHash: assessmentSourceHash({
      accountId: input.accountId,
      sourceInstanceId: input.sourceInstanceId,
      snapshot,
      evidenceHash,
    }),
  });
}

/**
 * Synthesize the bounded evidence list of one prompt.
 *
 * Every reference is derived from a stable position (`ev-knowledge-3`, `ev-practice-recent`,
 * `ev-virtual-vp-2`), so the same snapshot always publishes the same references and a report stored
 * under one capture can be re-validated after a recapture. Details are identifier-free text: they
 * carry counts, labels, revisions and statuses only.
 */
export function assessmentEvidenceEntries(
  snapshot: AssessmentSourceSnapshot,
  anchor: AssessmentPromptAnchor,
): readonly AssessmentEvidenceEntry[] {
  const entries: AssessmentEvidenceEntry[] = [];
  const official = snapshot.officialRating;
  entries.push({
    evidenceRef: ASSESSMENT_OFFICIAL_RATING_REF,
    category: 'official_rating',
    label: '官方比赛评分（客观来源）',
    detail:
      official.status === 'rated'
        ? `官方当前 rating ${String(official.rating)}，历史最高 ${String(official.maxRating)}，rated 比赛 ${official.ratedContests} 场，时效 ${official.activity}；AI 只读取，不修改官方数据`
        : official.status === 'unrated'
          ? '官方账号没有 rated 比赛记录；不以零分代替未评级'
          : '尚未同步官方 rating；练习统计不能替代比赛评分',
  });
  const reference = snapshot.trainingReference;
  entries.push({
    evidenceRef: 'ev-self-assessment',
    category: 'self_assessment',
    label: '水平参考（自评或官方）',
    detail:
      reference.source === 'self_report' && reference.range !== null
        ? `用户自评 CF 范围 ${reference.range.min}..${reference.range.max}（第 ${reference.revision} 版）；自评是用户声明，不是客观数值锚点`
        : reference.source === 'official_rating'
          ? `水平参考取官方当前 rating（自评已撤销，第 ${reference.revision} 版）`
          : '未校准：既没有自评也没有官方 rating 作为水平参考',
  });
  const periods = snapshot.ability.history?.periods ?? [];
  for (const period of periods) {
    entries.push({
      evidenceRef: `ev-practice-${period.period}`,
      category: 'practice_history',
      label: `练习证据（${periodLabel(period.period)}）`,
      detail: `已解题 ${period.solvedDistinct}，可用样本 ${period.eligibleDistinct}，独立确认 ${period.independentEligibleDistinct}，估计状态 ${period.estimateStatus}，包含更早记录 ${String(period.includesEarlierSolves)}`,
    });
  }
  const coverage = snapshot.ability.coverage;
  entries.push({
    evidenceRef: 'ev-coverage',
    category: 'coverage',
    label: '证据覆盖与缺口',
    detail: `缺少本地元数据 ${coverage.metadataMissing}，无原生难度值 ${coverage.solvedWithoutNativeValue}，未来时间戳被排除 ${coverage.futureSubmissionsExcluded}`,
  });
  entries.push({
    evidenceRef: 'ev-knowledge-summary',
    category: 'knowledge',
    label: '知识证据汇总（按原生难度分带）',
    detail: `分带节点合计 ${snapshot.knowledgeTotalRows} 行，本次收录 ${snapshot.knowledge.length} 行，因上限省略 ${snapshot.knowledgeOmittedRows} 行；省略的行不构成本次评估的证据`,
  });
  snapshot.knowledge.forEach((row, index) => {
    entries.push({
      evidenceRef: `ev-knowledge-${index + 1}`,
      category: 'knowledge',
      label: `知识证据（难度分带 ${row.band} / ${row.taxonomyId}）`,
      detail: `状态 ${row.status}；关联题 ${row.observedRelatedDistinct}；平台标签通过 ${row.platformSolvedDistinct}；已确认标签通过 ${row.verifiedSolvedDistinct}；独立完成 ${row.retrospectiveIndependentDistinct}；提示辅助 ${row.retrospectiveAssistedDistinct}；参考题解 ${row.retrospectiveSolutionUsedDistinct}`,
    });
  });
  const virtual = snapshot.virtualPerformance;
  entries.push({
    evidenceRef: ASSESSMENT_VIRTUAL_LEDGER_REF,
    category: 'virtual_performance',
    label: '用户录入虚拟参赛表现（不是官方评分）',
    detail: `共 ${virtual.counts.total} 条；独立且赛前未见过 ${virtual.counts.eligibleIndependent} 条；提示辅助或赛前见过 ${virtual.counts.assisted + virtual.counts.priorExposed} 条；独立性未知 ${virtual.counts.unknownIndependence} 条；账本第 ${virtual.ledgerRevision} 版；本轮不做数值换算`,
  });
  for (const entry of virtual.eligible.slice(0, MAX_ASSESSMENT_VIRTUAL_REFS)) {
    entries.push({
      evidenceRef: `ev-virtual-${entry.evidenceRef}`,
      category: 'virtual_performance',
      label: '用户录入虚拟参赛表现（独立、赛前未见过）',
      detail: `表现 ${entry.performance}；计算方法 ${entry.methodLabel}；赛前是否见过题 ${String(entry.priorExposure)}`,
    });
  }
  for (const method of snapshot.guidance.methods) {
    entries.push({
      evidenceRef: `ev-method-${method.methodId}`,
      category: 'training_method',
      label: `训练方法：${method.name}`,
      detail: `methodId ${method.methodId}；version ${method.version}；methodHash ${method.methodHash}`,
    });
  }
  const refs = new Set(entries.map((entry) => entry.evidenceRef));
  invariant(
    anchor.evidenceRef === null || refs.has(anchor.evidenceRef),
    'invalid_input',
    'assessment anchor reference is not part of the captured evidence',
    { anchor: anchor.kind, evidenceRef: anchor.evidenceRef },
  );
  return deepFreeze(entries);
}

function periodLabel(period: string): string {
  if (period === 'all_time') {
    return '全部历史';
  }
  return period === 'recent' ? '最近窗口' : '更早记录';
}

// ---------------------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------------------

/**
 * Clock-free identity of the ability aggregate.
 *
 * The official-rating `activity` label is dropped because it is derived from the observation
 * instant alone; every count, period, mode, distribution and caveat stays in.
 */
function abilityIdentity(ability: AbilityPlanningAggregate): unknown {
  const competition = ability.competition;
  return {
    ...ability,
    ...(competition === undefined ? {} : { competition: competitionIdentity(competition) }),
  };
}

/** Clock-free identity of one official competition summary (`activity` excluded). */
function competitionIdentity(summary: CompetitionSummary): unknown {
  return {
    status: summary.status,
    rating: summary.rating,
    maxRating: summary.maxRating,
    ratedContests: summary.ratedContests,
    revision: summary.revision,
  };
}

/** Clock-free identity of the public prompt payload. */
export function assessmentEvidenceIdentity(prompt: AssessmentModelEvidence): unknown {
  return {
    version: prompt.version,
    ability: abilityIdentity(prompt.ability),
    officialRating: competitionIdentity(prompt.officialRating),
    anchor: prompt.anchor,
    knowledge: prompt.knowledge,
    knowledgeTotalRows: prompt.knowledgeTotalRows,
    knowledgeOmittedRows: prompt.knowledgeOmittedRows,
    virtualPerformance: virtualPerformanceEvidenceIdentity(prompt.virtualPerformance),
    evidence: prompt.evidence,
  };
}

/** Hash of the public prompt payload; see the module comment for what is excluded. */
export function assessmentEvidenceHash(prompt: AssessmentModelEvidence): string {
  return contentHashOf(assessmentEvidenceIdentity(prompt));
}

/** Hash of the account/source identity and every semantic source signature of one capture. */
export function assessmentSourceHash(input: {
  readonly accountId: string;
  readonly sourceInstanceId: string;
  readonly snapshot: AssessmentSourceSnapshot;
  readonly evidenceHash: string;
}): string {
  return contentHashOf({version:ASSESSMENT_CAPTURE_VERSION,
    identity:{accountId:input.accountId,sourceInstanceId:input.sourceInstanceId},
    sourceEvidenceHash:input.snapshot.sourceEvidenceHash,
    taxonomyVersion:input.snapshot.taxonomyVersion,
    guidanceHash:input.snapshot.guidance.hash});
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

const SNAPSHOT_KEYS = [
  'sourceEvidenceHash',
  'platform',
  'taxonomyVersion',
  'officialRating',
  'trainingReference',
  'calibration',
  'ability',
  'knowledge',
  'knowledgeTotalRows',
  'knowledgeOmittedRows',
  'virtualPerformance',
  'guidance',
] as const;
const CAPTURE_KEYS = [
  'capturedAt',
  'accountId',
  'sourceInstanceId',
  'snapshot',
  'prompt',
  'evidenceHash',
  'sourceHash',
] as const;
const PROMPT_KEYS = [
  'version',
  'ability',
  'officialRating',
  'anchor',
  'knowledge',
  'knowledgeTotalRows',
  'knowledgeOmittedRows',
  'virtualPerformance',
  'evidence',
  'disclosure',
] as const;
const ANCHOR_KEYS = ['kind', 'officialRating', 'eligibleVirtualRuns', 'evidenceRef'] as const;
const KNOWLEDGE_KEYS = [
  'band',
  'taxonomyId',
  'status',
  'observedRelatedDistinct',
  'platformSolvedDistinct',
  'verifiedSolvedDistinct',
  'retrospectiveIndependentDistinct',
  'retrospectiveAssistedDistinct',
  'retrospectiveSolutionUsedDistinct',
] as const;
const EVIDENCE_KEYS = ['evidenceRef', 'category', 'label', 'detail'] as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
// Synthetic `ev-…` references are generated from stable positions; the practice-period references
// embed the period name (`ev-practice-all_time`), so `_` is part of the documented ref alphabet.
const EVIDENCE_REF = /^ev-[a-z0-9][a-z0-9_:-]*$/u;

/** Strictly validate one internal snapshot and return a detached, frozen copy. */
export function validateAssessmentSourceSnapshot(value: unknown): AssessmentSourceSnapshot {
  const record = requireObject('assessment snapshot', value);
  requireExactKeys('assessment snapshot', record, SNAPSHOT_KEYS);
  const sourceEvidenceHash = requireHash('assessment snapshot sourceEvidenceHash', record['sourceEvidenceHash']);
  const platform = record['platform'];
  invariant(
    SOURCE_PLATFORMS.includes(platform as SourcePlatform),
    'invalid_input',
    `unknown assessment snapshot platform ${String(platform)}`,
    { platform },
  );
  const taxonomyVersion = requireText('assessment snapshot taxonomyVersion', record['taxonomyVersion'], 200);
  const officialRating = validateCompetitionSummary(record['officialRating']);
  const trainingReference = validateTrainingReference(record['trainingReference']);
  invariant(
    trainingReference.source !== 'official_rating' ||
      (officialRating.status === 'rated' && trainingReference.range?.min === officialRating.rating),
    'invalid_input',
    'assessment snapshot official training reference needs matching competition evidence',
    { reason: 'training_reference_mismatch' },
  );
  const calibration = requireCalibration(record['calibration']);
  const ability = validateAbilityPlanningAggregate(record['ability']);
  invariant(
    ability.platform === platform,
    'invalid_input',
    `assessment snapshot ability reports platform ${String(ability.platform)}, not ${String(platform)}`,
    { reason: 'ability_platform_mismatch' },
  );
  const knowledgeRows = requireKnowledgeRows(record['knowledge']);
  const knowledgeTotalRows = requireCount('assessment snapshot knowledgeTotalRows', record['knowledgeTotalRows']);
  const knowledgeOmittedRows = requireCount(
    'assessment snapshot knowledgeOmittedRows',
    record['knowledgeOmittedRows'],
  );
  invariant(
    knowledgeRows.length + knowledgeOmittedRows === knowledgeTotalRows,
    'invalid_input',
    'assessment snapshot knowledge counts do not reconcile with the kept rows',
    {
      reason: 'knowledge_counts_mismatch',
      kept: knowledgeRows.length,
      omitted: knowledgeOmittedRows,
      total: knowledgeTotalRows,
    },
  );
  const virtualPerformance = validateVirtualPerformancePlanningSummary(record['virtualPerformance']);
  const guidance = validateGuidanceSnapshot(record['guidance']);
  invariant(
    guidance.kind === 'assessment',
    'invalid_input',
    `assessment snapshot needs an assessment-kind method capture, not ${guidance.kind}`,
    { reason: 'guidance_kind_mismatch', kind: guidance.kind },
  );
  return deepFreeze({
    sourceEvidenceHash,
    platform: platform as SourcePlatform,
    taxonomyVersion,
    officialRating,
    trainingReference,
    calibration,
    ability,
    knowledge: knowledgeRows,
    knowledgeTotalRows,
    knowledgeOmittedRows,
    virtualPerformance,
    guidance,
  });
}

/** Strictly validate one public prompt payload and return a detached, frozen copy. */
export function validateAssessmentModelEvidence(value: unknown): AssessmentModelEvidence {
  const record = requireObject('assessment evidence', value);
  requireExactKeys('assessment evidence', record, PROMPT_KEYS);
  const version = requireText('assessment evidence version', record['version'], 100);
  const ability = validateAbilityPlanningAggregate(record['ability']);
  const officialRating = validateCompetitionSummary(record['officialRating']);
  const anchor = requireAnchor(record['anchor']);
  const knowledge = requireKnowledgeRows(record['knowledge']);
  const knowledgeTotalRows = requireCount('assessment evidence knowledgeTotalRows', record['knowledgeTotalRows']);
  const knowledgeOmittedRows = requireCount(
    'assessment evidence knowledgeOmittedRows',
    record['knowledgeOmittedRows'],
  );
  invariant(
    knowledge.length + knowledgeOmittedRows === knowledgeTotalRows,
    'invalid_input',
    'assessment evidence knowledge counts do not reconcile with the kept rows',
    { reason: 'knowledge_counts_mismatch' },
  );
  const virtualPerformance = validateVirtualPerformancePlanningSummary(record['virtualPerformance']);
  const evidence = requireEvidence(record['evidence']);
  const disclosure = requireText(
    'assessment evidence disclosure',
    record['disclosure'],
    ASSESSMENT_INPUT_DISCLOSURE.length,
  );
  invariant(
    disclosure === ASSESSMENT_INPUT_DISCLOSURE,
    'invalid_input',
    'assessment evidence does not carry the documented input disclosure',
    { reason: 'disclosure_missing' },
  );
  const facts = assessmentAnchorOf({ officialRating, virtualPerformance });
  invariant(
    anchor.kind === facts.kind &&
      anchor.officialRating === facts.officialRating &&
      anchor.eligibleVirtualRuns === facts.eligibleVirtualRuns,
    'invalid_input',
    'assessment evidence anchor does not match its own rating and virtual-contest evidence',
    { reason: 'anchor_mismatch', declared: anchor.kind, derived: facts.kind },
  );
  const refs = new Set(evidence.map((entry) => entry.evidenceRef));
  invariant(
    anchor.evidenceRef === null ? anchor.kind === 'none' : refs.has(anchor.evidenceRef),
    'invalid_input',
    'assessment evidence anchor reference is not part of its evidence list',
    { reason: 'anchor_mismatch', evidenceRef: anchor.evidenceRef },
  );
  return deepFreeze({
    version,
    ability,
    officialRating,
    anchor,
    knowledge,
    knowledgeTotalRows,
    knowledgeOmittedRows,
    virtualPerformance,
    evidence,
    disclosure: ASSESSMENT_INPUT_DISCLOSURE,
  });
}

/**
 * Strictly validate one whole capture: its snapshot, its prompt, the agreement between the two and
 * both derived hashes. A hand-edited capture therefore cannot claim evidence it does not carry.
 */
export function validateAssessmentCapture(value: unknown): AssessmentCapture {
  const record = requireObject('assessment capture', value);
  requireExactKeys('assessment capture', record, CAPTURE_KEYS);
  const capturedAt = assertIsoTimestamp('assessment capture capturedAt', requireText('assessment capture capturedAt', record['capturedAt'], 100));
  const accountId = requireText('assessment capture accountId', record['accountId'], 512);
  const sourceInstanceId = requireText('assessment capture sourceInstanceId', record['sourceInstanceId'], 512);
  const snapshot = validateAssessmentSourceSnapshot(record['snapshot']);
  const prompt = validateAssessmentModelEvidence(record['prompt']);
  invariant(
    canonicalJson(prompt.ability) === canonicalJson(snapshot.ability) &&
      canonicalJson(prompt.officialRating) === canonicalJson(snapshot.officialRating) &&
      canonicalJson(prompt.virtualPerformance) === canonicalJson(snapshot.virtualPerformance) &&
      canonicalJson(prompt.knowledge) === canonicalJson(snapshot.knowledge) &&
      prompt.knowledgeTotalRows === snapshot.knowledgeTotalRows &&
      prompt.knowledgeOmittedRows === snapshot.knowledgeOmittedRows,
    'invalid_input',
    'assessment capture prompt does not describe its own snapshot',
    { reason: 'prompt_snapshot_mismatch' },
  );
  const evidenceHash = requireHash('assessment capture evidenceHash', record['evidenceHash']);
  const derivedEvidence = assessmentEvidenceHash(prompt);
  invariant(
    evidenceHash === derivedEvidence,
    'invalid_input',
    'assessment capture evidenceHash does not match its own content',
    { reason: 'evidence_hash_mismatch', declared: evidenceHash, derived: derivedEvidence },
  );
  const sourceHash = requireHash('assessment capture sourceHash', record['sourceHash']);
  const derivedSource = assessmentSourceHash({ accountId, sourceInstanceId, snapshot, evidenceHash });
  invariant(
    sourceHash === derivedSource,
    'invalid_input',
    'assessment capture sourceHash does not match its own content',
    { reason: 'source_hash_mismatch', declared: sourceHash, derived: derivedSource },
  );
  return deepFreeze({ capturedAt, accountId, sourceInstanceId, snapshot, prompt, evidenceHash, sourceHash });
}

/** Every reference the captured evidence publishes, in order; the closed citation set of a report. */
export function assessmentEvidenceRefs(capture: AssessmentCapture): readonly string[] {
  return capture.prompt.evidence.map((entry) => entry.evidenceRef);
}

// ---------------------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function requireObject(label: string, value: unknown): JsonObject {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input',
    `${label} must be a JSON object`,
    { reason: 'invalid_shape', label },
  );
  return value as JsonObject;
}

function requireExactKeys(label: string, value: JsonObject, keys: readonly string[]): void {
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  invariant(unknownKeys.length === 0, 'invalid_input', `${label} has unknown keys: ${unknownKeys.join(', ')}`, {
    reason: 'unknown_key',
    label,
    unknownKeys,
  });
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  invariant(missing.length === 0, 'invalid_input', `${label} is missing keys: ${missing.join(', ')}`, {
    reason: 'missing_key',
    label,
    missing,
  });
}

function requireText(label: string, value: unknown, bound: number): string {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'invalid_input',
    `${label} must be a non-empty string`,
    { reason: 'invalid_text', label },
  );
  const text = (value as string).trim();
  invariant(text.length <= bound, 'invalid_input', `${label} is ${text.length} characters, above ${bound}`, {
    reason: 'text_too_long',
    label,
    bound,
  });
  invariant(!CONTROL_CHARS.test(text), 'invalid_input', `${label} contains control characters`, {
    reason: 'invalid_text',
    label,
  });
  return text;
}

function requireCount(label: string, value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'invalid_input',
    `${label} must be a safe integer >= 0`,
    { reason: 'invalid_shape', label, value },
  );
  return value;
}

function requireHash(label: string, value: unknown): string {
  invariant(typeof value === 'string' && SHA256.test(value), 'invalid_input', `${label} must be a sha256 digest`, {
    reason: 'invalid_shape',
    label,
  });
  return value as string;
}

function requireCalibration(value: unknown): { readonly revision: number; readonly range: AbilityCalibrationRange | null } | null {
  if (value === null) {
    return null;
  }
  const record = requireObject('assessment snapshot calibration', value);
  requireExactKeys('assessment snapshot calibration', record, ['revision', 'range']);
  const revision = requireCount('assessment snapshot calibration revision', record['revision']);
  invariant(revision >= 1, 'invalid_input', 'assessment snapshot calibration revision must be positive', {
    reason: 'invalid_shape',
  });
  return { revision, range: validateCalibrationRange(record['range']) };
}

function requireAnchor(value: unknown): AssessmentPromptAnchor {
  const record = requireObject('assessment evidence anchor', value);
  requireExactKeys('assessment evidence anchor', record, ANCHOR_KEYS);
  const kind = record['kind'];
  invariant(
    ASSESSMENT_ANCHOR_KINDS.includes(kind as AssessmentAnchorKind),
    'invalid_input',
    `unknown assessment evidence anchor kind ${String(kind)}`,
    { reason: 'invalid_shape', kind },
  );
  const officialRating =
    record['officialRating'] === null
      ? null
      : requireSigned('assessment evidence anchor officialRating', record['officialRating']);
  const eligibleVirtualRuns = requireCount(
    'assessment evidence anchor eligibleVirtualRuns',
    record['eligibleVirtualRuns'],
  );
  const evidenceRef =
    record['evidenceRef'] === null ? null : requireText('assessment evidence anchor evidenceRef', record['evidenceRef'], 120);
  return deepFreeze({ kind: kind as AssessmentAnchorKind, officialRating, eligibleVirtualRuns, evidenceRef });
}

function requireSigned(label: string, value: unknown): number {
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value),
    'invalid_input',
    `${label} must be a safe integer`,
    { reason: 'invalid_shape', label, value },
  );
  return value as number;
}

function requireKnowledgeRows(value: unknown): readonly AssessmentKnowledgeRow[] {
  invariant(Array.isArray(value), 'invalid_input', 'assessment knowledge must be an array', {
    reason: 'invalid_shape',
  });
  invariant(
    value.length <= MAX_ASSESSMENT_KNOWLEDGE_ROWS,
    'invalid_input',
    `assessment knowledge holds at most ${MAX_ASSESSMENT_KNOWLEDGE_ROWS} rows`,
    { reason: 'too_many_rows', length: value.length, bound: MAX_ASSESSMENT_KNOWLEDGE_ROWS },
  );
  const seen = new Set<string>();
  return value.map((entry) => {
    const record = requireObject('assessment knowledge row', entry);
    requireExactKeys('assessment knowledge row', record, KNOWLEDGE_KEYS);
    const band = requireText('assessment knowledge row band', record['band'], 100);
    const taxonomyId = requireText('assessment knowledge row taxonomyId', record['taxonomyId'], 200);
    const status = record['status'];
    invariant(
      KNOWLEDGE_STATUSES.includes(status as KnowledgeNodeStatus),
      'invalid_input',
      `unknown assessment knowledge status ${String(status)}`,
      { reason: 'invalid_shape', status },
    );
    const key = `${band}|${taxonomyId}`;
    invariant(!seen.has(key), 'invalid_input', `assessment knowledge repeats row ${key}`, {
      reason: 'duplicate_knowledge_row',
      key,
    });
    seen.add(key);
    return deepFreeze({
      band,
      taxonomyId,
      status: status as KnowledgeNodeStatus,
      observedRelatedDistinct: requireCount('assessment knowledge observedRelatedDistinct', record['observedRelatedDistinct']),
      platformSolvedDistinct: requireCount('assessment knowledge platformSolvedDistinct', record['platformSolvedDistinct']),
      verifiedSolvedDistinct: requireCount('assessment knowledge verifiedSolvedDistinct', record['verifiedSolvedDistinct']),
      retrospectiveIndependentDistinct: requireCount(
        'assessment knowledge retrospectiveIndependentDistinct',
        record['retrospectiveIndependentDistinct'],
      ),
      retrospectiveAssistedDistinct: requireCount(
        'assessment knowledge retrospectiveAssistedDistinct',
        record['retrospectiveAssistedDistinct'],
      ),
      retrospectiveSolutionUsedDistinct: requireCount(
        'assessment knowledge retrospectiveSolutionUsedDistinct',
        record['retrospectiveSolutionUsedDistinct'],
      ),
    });
  });
}

function requireEvidence(value: unknown): readonly AssessmentEvidenceEntry[] {
  invariant(Array.isArray(value), 'invalid_input', 'assessment evidence list must be an array', {
    reason: 'invalid_shape',
  });
  invariant(
    value.length > 0 && value.length <= MAX_ASSESSMENT_EVIDENCE_ENTRIES,
    'invalid_input',
    `assessment evidence list must hold 1..${MAX_ASSESSMENT_EVIDENCE_ENTRIES} entries`,
    { reason: 'invalid_shape', length: value.length },
  );
  const seen = new Set<string>();
  return value.map((entry) => {
    const record = requireObject('assessment evidence entry', entry);
    requireExactKeys('assessment evidence entry', record, EVIDENCE_KEYS);
    const evidenceRef = requireText('assessment evidence entry evidenceRef', record['evidenceRef'], 120);
    invariant(EVIDENCE_REF.test(evidenceRef), 'invalid_input', `assessment evidence reference ${evidenceRef} is not synthetic`, {
      reason: 'invalid_evidence_ref',
      evidenceRef,
    });
    invariant(!seen.has(evidenceRef), 'invalid_input', `assessment evidence repeats reference ${evidenceRef}`, {
      reason: 'duplicate_evidence_ref',
      evidenceRef,
    });
    seen.add(evidenceRef);
    const category = record['category'];
    invariant(
      ASSESSMENT_EVIDENCE_CATEGORIES.includes(category as AssessmentEvidenceCategory),
      'invalid_input',
      `unknown assessment evidence category ${String(category)}`,
      { reason: 'invalid_shape', category },
    );
    return deepFreeze({
      evidenceRef,
      category: category as AssessmentEvidenceCategory,
      label: requireText('assessment evidence entry label', record['label'], MAX_ASSESSMENT_EVIDENCE_LABEL_CHARS),
      detail: requireText('assessment evidence entry detail', record['detail'], MAX_ASSESSMENT_EVIDENCE_DETAIL_CHARS),
    });
  });
}
