/**
 * Material preflight: the free gate in front of every paid analysis call (Sprint 33A).
 *
 * The pipeline owns the *runtime* defence — `classifySnapshotAvailability` plus the explicit
 * failures of `AnalysisPipeline.executeJob` — and that defence stays exactly as it is, because a
 * historical batch, a corrupted row or a direct caller must still be refused. This module owns the
 * layer **above** it: the same decision taken while nothing has been written yet, so a selection
 * whose material cannot be analysed never becomes a batch at all.
 *
 * Three properties make the gate trustworthy:
 *
 * - **Only `editorial` and `absent` are runnable.** An empty source list is *unknown*, never
 *   "absent": absence is a claim a source has to make explicitly, and a found source whose
 *   referenced solution text is missing is not material a model may reason over.
 * - **The vocabulary is closed and spoiler-free.** A caller receives one of
 *   {@link MaterialBlockedReason} plus the one action that can fix it; the classifier's English
 *   diagnostic detail, the statement, the editorial body and every source identity stay inside the
 *   process.
 * - **A block is free.** A blocked problem is not a job, so it consumes no quota, produces no
 *   attempt row and no audit record, and the callers below project a batch upper bound of zero
 *   when nothing runnable is left.
 *
 * The module is plain application code: pure functions over domain values, no store, no clock, no
 * network and no model port.
 */
import type { ProblemSnapshot } from '../domain/index.js';
import { classifySnapshotAvailability } from './analysis-pipeline.js';

/** Why a problem's current material cannot be analysed yet. */
export type MaterialBlockedReason =
  | 'material_missing'
  | 'snapshot_unreadable'
  | 'editorial_unknown'
  | 'editorial_empty'
  | 'source_unavailable'
  | 'missing_statement';

/** The one user action that can turn a blocked problem into a runnable one. */
export type MaterialBlockedAction = 'refresh_materials' | 'supplement_editorial' | 'supplement_statement';

/**
 * One problem whose material is not runnable, as a spoiler-free view.
 *
 * It deliberately carries no detail string, snapshot id, source id, statement text or editorial
 * excerpt: the reason is a stable code the UI renders in Chinese, and the action is the entry the
 * user has to take before a *new* free preparation can succeed.
 */
export interface MaterialBlockedProblem {
  readonly problemKey: string;
  readonly reason: MaterialBlockedReason;
  readonly action: MaterialBlockedAction;
}

/**
 * Material state of one problem's current snapshot, as the gate decides it.
 *
 * `editorial` and `absent` are the runnable states. `missing` means nothing was ever frozen for the
 * problem (no current head at all), while `unreadable` means the head exists but the snapshot row
 * behind it cannot be read: two different facts, because one asks the user to create material and
 * the other asks them to refresh material that is already recorded.
 */
export type SnapshotMaterialKind =
  | 'editorial'
  | 'absent'
  | 'missing'
  | 'unreadable'
  | 'editorial_empty'
  | 'unknown_sources'
  | 'source_unavailable'
  | 'missing_statement';

/** Material state of a snapshot body that is known to exist. */
export function snapshotMaterialKind(snapshot: ProblemSnapshot): SnapshotMaterialKind {
  const availability = classifySnapshotAvailability(snapshot);
  switch (availability.kind) {
    case 'editorial':
      return 'editorial';
    case 'absent':
      return 'absent';
    case 'unknown_sources':
      return 'unknown_sources';
    case 'missing_statement':
      return 'missing_statement';
    default:
      return availability.code === 'editorial_empty' ? 'editorial_empty' : 'source_unavailable';
  }
}

/**
 * Material state of one current head.
 *
 * `null` means the problem has no current snapshot head; a head whose body is unreadable is
 * reported by the caller as `unreadable`, because the difference between "never captured" and
 * "captured but unreadable" is exactly what the user's next action depends on.
 */
export function materialKindOf(snapshot: ProblemSnapshot | null): SnapshotMaterialKind {
  return snapshot === null ? 'missing' : snapshotMaterialKind(snapshot);
}

/** `true` while a problem may become a paid job: a usable editorial, or a confirmed absence. */
export function materialIsRunnable(kind: SnapshotMaterialKind): boolean {
  return kind === 'editorial' || kind === 'absent';
}

/**
 * The stable reason a non-runnable material state is blocked, or `null` for a runnable one.
 *
 * The mapping is total over the failing kinds, so a state can never reach a caller as an unnamed
 * refusal or fall through to "runnable" by accident.
 */
export function materialBlockedReason(kind: SnapshotMaterialKind): MaterialBlockedReason | null {
  switch (kind) {
    case 'editorial':
    case 'absent':
      return null;
    case 'missing':
      return 'material_missing';
    case 'unreadable':
      return 'snapshot_unreadable';
    case 'unknown_sources':
      return 'editorial_unknown';
    case 'editorial_empty':
      return 'editorial_empty';
    case 'missing_statement':
      return 'missing_statement';
    default:
      return 'source_unavailable';
  }
}

/**
 * The primary action a blocked reason asks the user to take.
 *
 * `refresh_materials` is a platform material request and `supplement_*` writes a locally provided
 * body; neither calls a model, and neither pretends an unknown editorial is absent.
 */
export function materialBlockedAction(reason: MaterialBlockedReason): MaterialBlockedAction {
  switch (reason) {
    case 'editorial_empty':
      return 'supplement_editorial';
    case 'missing_statement':
      return 'supplement_statement';
    default:
      return 'refresh_materials';
  }
}

/**
 * The blocked view of one non-runnable material state, or `null` when it is runnable.
 *
 * Returning `null` instead of a "runnable" placeholder is what keeps the two callers honest:
 * `prepareBatch` only ever hands runnable snapshot ids to the pipeline, and `batchDetail` only ever
 * reports a problem as blocked when a blocker really exists.
 */
export function materialBlockedProblem(
  problemKey: string,
  kind: SnapshotMaterialKind,
): MaterialBlockedProblem | null {
  const reason = materialBlockedReason(kind);
  return reason === null ? null : { problemKey, reason, action: materialBlockedAction(reason) };
}
