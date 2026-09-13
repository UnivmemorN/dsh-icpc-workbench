/** Local selection over domain-computed difficulty evidence; no network or model calls. */
import type { KnowledgeDifficultyBand, KnowledgeEvidenceReport, KnowledgeNodeEvidence } from '../domain/index.js';

/** Label names the native source, dimension and interval; it never implies a converted scale. */
export function knowledgeDifficultyLabel(band: KnowledgeDifficultyBand): string {
  const source = band.sourceInstanceId === 'codeforces:codeforces.com' ? 'CF'
    : band.sourceInstanceId === 'luogu:www.luogu.com.cn' || band.sourceInstanceId === 'luogu:luogu.com.cn' ? '洛谷'
    : band.sourceInstanceId;
  const scope = source + (band.domain === null ? '' : ' / ' + band.domain);
  const value = band.kind === 'unknown' ? '未知 / 未评级'
    : band.kind === 'interval' ? String(band.value) + '–' + String((band.upperExclusive as number) - 1)
    : String(band.value);
  return scope + ' · ' + band.dimension + ' ' + value;
}

/** Missing nodes in a sparse band mean no observation there, including every retrospective count. */
function unobserved(node: KnowledgeNodeEvidence): KnowledgeNodeEvidence {
  return {
    ...node,
    platformAttemptedDistinct: 0, platformSolvedDistinct: 0,
    verifiedAttemptedDistinct: 0, verifiedSolvedDistinct: 0,
    retrospectiveIndependentDistinct: 0, retrospectiveAssistedDistinct: 0, retrospectiveSolutionUsedDistinct: 0,
    observedRelatedDistinct: 0, independentRatingRanges: [],
    status: node.kind === 'category' ? 'category_summary' : 'not_observed',
    descendantTechniqueNodesWithIndependentEvidence: 0,
  };
}

/** Total view or a full-catalog projection of one band; obsolete selections fall back to totals. */
export function knowledgeAtDifficulty(
  report: KnowledgeEvidenceReport,
  bandId: string | null,
): { readonly nodes: readonly KnowledgeNodeEvidence[]; readonly coverage: KnowledgeEvidenceReport['coverage']; readonly label: string } {
  const selected = report.difficultyBands.find(entry => entry.band.id === bandId);
  if (!selected) return { nodes: report.nodes, coverage: report.coverage, label: '全部难度（汇总）' };
  const byId = new Map(selected.nodes.map(n => [n.taxonomyId, n]));
  return { nodes: report.nodes.map(node => byId.get(node.taxonomyId) ?? unobserved(node)),
    coverage: selected.coverage, label: knowledgeDifficultyLabel(selected.band) };
}
