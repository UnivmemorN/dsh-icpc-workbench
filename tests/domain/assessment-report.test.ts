/**
 * Bounded assessment report rules (Sprint 18d1).
 *
 * The cases exercise the pure domain contract: exact keys, every explicit bound, the closed citation
 * set, the anchor rule that separates an objective numeric estimate from a fabricated score, and the
 * labelled, hash-checked stored record. No store, platform or model is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASSESSMENT_AI_DISCLOSURE,
  ASSESSMENT_ESTIMATE_MAX,
  ASSESSMENT_ESTIMATE_MIN,
  MAX_ASSESSMENT_NEXT_STEPS,
  assessmentAnchorOf,
  assessmentConflict,
  assessmentReportProblem,
  competitionSummary,
  createAssessmentReportRecord,
  validateAssessmentReport,
  validateAssessmentReportRecord,
  type AssessmentReportContext,
} from '../../src/domain/index.js';
import { makeCapture, makeReport, makeReportRecord, officialRatingSnapshot, ACCOUNT_ID } from '../assessment-fixtures.js';

const EVIDENCE = ['ev-official-rating', 'ev-practice-all_time', 'ev-knowledge-summary', 'ev-coverage'];

function context(overrides: Partial<AssessmentReportContext> = {}): AssessmentReportContext {
  return {
    evidenceRefs: EVIDENCE,
    anchor: { kind: 'official_rating', officialRating: 1500, eligibleVirtualRuns: 0 },
    ...overrides,
  };
}

/** Assert the report is refused with the stable reason of the refusal. */
function rejects(value: unknown, reason: string, ctx: AssessmentReportContext = context()): void {
  const problem = assessmentReportProblem(value, ctx);
  assert.notEqual(problem, null, `expected ${reason} refusal for ${JSON.stringify(value).slice(0, 120)}`);
  assert.match(String(problem), new RegExp(reason), `unexpected reason: ${String(problem)}`);
  assert.throws(() => validateAssessmentReport(value, ctx));
}

test('a well-formed report validates into a frozen copy with every declared key', () => {
  const report = validateAssessmentReport(makeReport(), context());

  assert.deepEqual(Object.keys(report).sort(), [
    'bottleneckReason',
    'confidence',
    'confidenceEvidenceRefs',
    'confidenceReasons',
    'estimatedRange',
    'nextSteps',
    'priority',
    'readinessCheck',
    'summary',
    'templates',
    'thinking',
  ]);
  assert.deepEqual(report.estimatedRange, { min: 1400, max: 1600 });
  assert.equal(report.priority, 'thinking');
  assert.deepEqual(report.thinking.evidenceRefs, ['ev-practice-all_time', 'ev-coverage']);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.thinking), true);
  assert.equal(assessmentReportProblem(makeReport(), context()), null);
});

test('unknown, missing and mistyped keys are refused instead of being repaired', () => {
  rejects({ ...makeReport(), officialScore: 1500 }, 'unknown_key');
  rejects({ ...makeReport(), candidateId: 'candidate-1' }, 'unknown_key');
  rejects({ ...makeReport(), summary: undefined }, 'missing_key');
  rejects(makeReport({ priority: 'mastery' }), 'unknown');
  rejects(makeReport({ confidence: 'certain' }), 'unknown');
  rejects(makeReport({ estimatedRange: { min: 1400 } }), 'missing_key');
  rejects(makeReport({ estimatedRange: { min: 1400, max: 1600, label: 'AI' } }), 'unknown_key');
  rejects(makeReport({ thinking: { assessment: 'x' } }), 'missing_key');
  rejects(makeReport({ nextSteps: 'do it' }), 'must be an array');
  rejects(makeReport({ thinking: { assessment: '', evidenceRefs: [], uncertainties: [] } }), 'non-empty');
  rejects(makeReport({ summary: 7 }), 'non-empty string');
});

test('every explicit bound is enforced', () => {
  rejects(makeReport({ summary: 'x'.repeat(2001) }), 'above');
  rejects(makeReport({ nextSteps: Array.from({ length: MAX_ASSESSMENT_NEXT_STEPS + 1 }, () => 'step') }), 'at most');
  rejects(makeReport({ confidenceReasons: [] }), 'at least');
  rejects(
    makeReport({ confidenceEvidenceRefs: Array.from({ length: 13 }, (_, index) => `ev-official-rating${index}`) }),
    'at most',
  );
  rejects(makeReport({ estimatedRange: { min: ASSESSMENT_ESTIMATE_MIN - 1, max: 0 } }), 'range_out_of_bounds');
  rejects(makeReport({ estimatedRange: { min: 0, max: ASSESSMENT_ESTIMATE_MAX + 1 } }), 'range_out_of_bounds');
  rejects(makeReport({ estimatedRange: { min: 1600, max: 1400 } }), 'range_inverted');
  rejects(makeReport({ estimatedRange: { min: 1.5, max: 2 } }), 'range_out_of_bounds');
  // Explicitly allowed extremes stay valid.
  assert.equal(assessmentReportProblem(makeReport({ estimatedRange: { min: ASSESSMENT_ESTIMATE_MIN, max: ASSESSMENT_ESTIMATE_MAX } }), context()), null);
  assert.equal(assessmentReportProblem(makeReport({ nextSteps: [] }), context()), null);
});

test('a citation must exist in the captured evidence, and URLs are never storable', () => {
  rejects(makeReport({ confidenceEvidenceRefs: ['ev-invented'] }), 'unknown_evidence_ref');
  rejects(makeReport({ thinking: { assessment: 'x', evidenceRefs: ['ev-1'], uncertainties: [] } }), 'unknown_evidence_ref');
  rejects(
    makeReport({ templates: { assessment: 'x', evidenceRefs: ['ev-coverage', 'ev-coverage'], uncertainties: [] } }),
    'duplicate_evidence_ref',
  );
  rejects(makeReport({ summary: '参考 https://example.org/fake-editorial 的结论' }), 'url_in_report');
  rejects(makeReport({ bottleneckReason: '见 http://example.org' }), 'url_in_report');
  rejects(makeReport({ readinessCheck: 'x\u0000y' }), 'control characters');
});

test('a numeric estimate needs an objective anchor; self-assessment and practice AC do not', () => {
  // No official rating and no eligible virtual run: any numeric range is refused.
  const bare = context({ anchor: { kind: 'none', officialRating: null, eligibleVirtualRuns: 0 } });
  rejects(makeReport(), 'no_numeric_anchor', bare);
  const problem = assessmentReportProblem(makeReport(), bare);
  assert.match(String(problem), /official rating or independent unexposed virtual performance/);

  // The honest diagnostic answer stays valid without an anchor.
  assert.equal(assessmentReportProblem(makeReport({ estimatedRange: null, priority: 'diagnostic' }), bare), null);

  // An independent, unexposed virtual run is a (weaker) objective anchor.
  const virtual = context({ anchor: { kind: 'virtual_performance', officialRating: null, eligibleVirtualRuns: 2 } });
  assert.equal(assessmentReportProblem(makeReport(), virtual), null);

  // The anchor facts themselves come from the exact evidence, never from practice statistics.
  const noEvidence = assessmentAnchorOf({ officialRating: competitionSummary(null, '2026-11-01T08:00:00.000Z') });
  assert.deepEqual(noEvidence, { kind: 'none', officialRating: null, eligibleVirtualRuns: 0 });
  const capture = makeCapture();
  assert.equal(capture.prompt.anchor.kind, 'none');
  assert.equal(capture.prompt.anchor.evidenceRef, null);
});

test('the stored record labels the answer as AI-inferred, anchors it and re-derives its hash', () => {
  const capture = makeCapture({ officialRating: null });
  const record = makeReportRecord(capture, makeReport({ estimatedRange: null, priority: 'diagnostic' }));

  assert.equal(record.source, 'ai_inferred');
  assert.equal(record.disclosure, ASSESSMENT_AI_DISCLOSURE);
  assert.equal(record.anchor, 'none');
  assert.equal(record.evidenceHash, capture.evidenceHash);
  assert.equal(validateAssessmentReportRecord(record, {
    evidenceRefs: capture.prompt.evidence.map((entry) => entry.evidenceRef),
    anchor: { kind: 'none', officialRating: null, eligibleVirtualRuns: 0 },
  }).report.summary, record.report.summary);

  // A rewritten record is refused on every axis: hash, label, disclosure, anchor and body.
  const ctx = {
    evidenceRefs: capture.prompt.evidence.map((entry) => entry.evidenceRef),
    anchor: { kind: 'none' as const, officialRating: null, eligibleVirtualRuns: 0 },
  };
  for (const broken of [
    { ...record, reportHash: 'b'.repeat(64) },
    { ...record, source: 'official' },
    { ...record, disclosure: '不是 AI 推断' },
    { ...record, anchor: 'official_rating' },
    { ...record, evidenceHash: 'not-a-hash' },
    { ...record, report: { ...record.report, estimatedRange: { min: 1000, max: 1200 } } },
  ]) {
    assert.throws(() => validateAssessmentReportRecord(broken, ctx), JSON.stringify(broken).slice(0, 80));
  }

  // A record created for one capture cannot be attached to another capture's evidence hash: a
  // different instant alone is the same evidence, while an official rating really changes it.
  const other = makeCapture({ officialRating: officialRatingSnapshot() });
  assert.notEqual(other.evidenceHash, capture.evidenceHash);
  assert.throws(
    () =>
      createAssessmentReportRecord({
        report: makeReport({ estimatedRange: null }),
        context: { evidenceRefs: EVIDENCE, anchor: { kind: 'none', officialRating: null, eligibleVirtualRuns: 0 } },
        evidenceHash: 'not-a-digest',
      }),
    /sha256/,
  );
});

test('the typed assessment conflict carries its stable reason and the account is never a report field', () => {
  const conflict = assessmentConflict('assessment attempt conflict', { attemptId: 'a' });
  assert.equal(conflict.code, 'invalid_input');
  assert.equal((conflict.details as { reason?: string }).reason, 'assessment_conflict');
  const report = validateAssessmentReport(makeReport(), context());
  assert.equal(JSON.stringify(report).includes(ACCOUNT_ID), false);
});
