/** Account-owned self-assessment, separate from platform records and practice statistics. */
import { invariant } from './errors.js';
import { assertIsoTimestamp } from './ids.js';
import { deepFreeze } from './immutable.js';

export interface AbilityCalibrationRange { readonly min: number; readonly max: number; }
export interface AbilityCalibration {
  readonly accountId: string;
  readonly revision: number;
  readonly recordedAt: string;
  readonly source: 'self_report';
  readonly scale: 'codeforces';
  /** Null records an explicit withdrawal; previous revisions remain immutable. */
  readonly range: AbilityCalibrationRange | null;
}
/** Closed, identifier-free planning reference. Absence of a range means ability is uncalibrated. */
export interface AbilityTrainingReference {
  readonly source: 'self_report' | 'official_rating' | 'uncalibrated';
  readonly scale: 'codeforces';
  /** Official reference preserves one exact signed rating; self-report uses positive bounds. */
  readonly range: AbilityCalibrationRange | null;
  /** Self-report revision, including withdrawal; competition.revision tracks official refreshes. */
  readonly revision: number;
}
export function validateCalibrationRange(value: unknown): AbilityCalibrationRange | null {
  if (value === null) return null;
  invariant(typeof value === 'object' && value !== null && !Array.isArray(value), 'invalid_input', 'calibration range must be an object');
  const row = value as Record<string, unknown>;
  invariant(Object.keys(row).length === 2 && Object.hasOwn(row, 'min') && Object.hasOwn(row, 'max'), 'invalid_input', 'calibration range accepts only min and max');
  for (const key of ['min', 'max']) invariant(typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && (row[key] as number) > 0, 'invalid_input', 'calibration bounds must be positive safe integers');
  invariant((row['min'] as number) <= (row['max'] as number), 'invalid_input', 'calibration min must not exceed max');
  return deepFreeze({ min: row['min'] as number, max: row['max'] as number });
}
export function validateAbilityCalibration(value: unknown): AbilityCalibration {
  invariant(typeof value === 'object' && value !== null && !Array.isArray(value), 'invalid_input', 'calibration must be an object');
  const row = value as Record<string, unknown>;
  const keys = ['accountId', 'revision', 'recordedAt', 'source', 'scale', 'range'];
  invariant(Object.keys(row).length === keys.length && keys.every(k => Object.hasOwn(row, k)), 'invalid_input', 'invalid calibration fields');
  invariant(typeof row['accountId'] === 'string' && row['accountId'].trim().length > 0, 'invalid_input', 'calibration account required');
  invariant(Number.isSafeInteger(row['revision']) && (row['revision'] as number) > 0, 'invalid_input', 'calibration revision must be positive');
  invariant(row['source'] === 'self_report' && row['scale'] === 'codeforces', 'invalid_input', 'unsupported calibration provenance');
  const recordedAt = assertIsoTimestamp('calibration recordedAt', row['recordedAt'] as string);
  return deepFreeze({ accountId: row['accountId'] as string, revision: row['revision'] as number, recordedAt, source: 'self_report', scale: 'codeforces', range: validateCalibrationRange(row['range']) });
}
export function validateTrainingReference(value: unknown): AbilityTrainingReference {
  invariant(typeof value === 'object' && value !== null && !Array.isArray(value), 'invalid_input', 'training reference must be an object');
  const row = value as Record<string, unknown>;
  const keys = ['source', 'scale', 'range', 'revision'];
  invariant(Object.keys(row).length === keys.length && keys.every(k => Object.hasOwn(row, k)), 'invalid_input', 'invalid training reference fields');
  invariant(row['scale'] === 'codeforces' && Number.isSafeInteger(row['revision']) && (row['revision'] as number) >= 0, 'invalid_input', 'invalid training reference scale/revision');
  // Official CF user ratings can be zero or negative; they are never silently clamped.
  if (row['source'] === 'official_rating') {
    const r = row['range'];
    invariant(typeof r === 'object' && r !== null && !Array.isArray(r), 'invalid_input', 'official reference range required');
    const bounds = r as Record<string, unknown>;
    invariant(Object.keys(bounds).length === 2 && Number.isSafeInteger(bounds['min']) && bounds['min'] === bounds['max'], 'invalid_input', 'official reference must preserve the exact rating');
    return deepFreeze({ source: 'official_rating', scale: 'codeforces', range: { min: bounds['min'] as number, max: bounds['max'] as number }, revision: row['revision'] as number });
  }
  const range = validateCalibrationRange(row['range']);
  invariant(range === null ? row['source'] === 'uncalibrated' : row['source'] === 'self_report' && (row['revision'] as number) > 0, 'invalid_input', 'training reference source/range mismatch');
  return deepFreeze({ source: row['source'] as AbilityTrainingReference['source'], scale: 'codeforces', range, revision: row['revision'] as number });
}
