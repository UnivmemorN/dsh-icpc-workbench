/** Explicit local decisions on native problem keys. Raw evidence remains recoverable. */
import { DomainError } from './errors.js';
import { parseProblemKey, problemKey } from './ids.js';
export type ProblemDispositionState = 'skipped' | 'trashed';
export type ProblemDispositionAction = 'skip' | 'trash' | 'restore';
export const PROBLEM_DISPOSITION_STATES: readonly ProblemDispositionState[] = ['skipped', 'trashed'];
export const PROBLEM_DISPOSITION_ACTIONS: readonly ProblemDispositionAction[] = ['skip', 'trash', 'restore'];
export const MAX_DISPOSITION_BATCH = 50;
export const MAX_DISPOSITION_PROBLEM_KEY_CHARS = 512;
/** Shared by all accounts on this native source. Other platform keys are independent. */
export interface ProblemDispositionRecord {
  readonly problemKey: string;
  readonly state: ProblemDispositionState;
  readonly sourceInstanceId: string;
  readonly initiatorAccountId: string;
  readonly updatedAt: string;
}
export function stateAfterAction(action: ProblemDispositionAction): ProblemDispositionState | null {
  return action === 'restore' ? null : action === 'trash' ? 'trashed' : 'skipped';
}
export function canApplyDispositionAction(action: ProblemDispositionAction, current: ProblemDispositionState | null): boolean {
  return action === 'skip' ? current === null : action === 'trash' ? current !== 'trashed' : current !== null;
}
export function canonicalProblemKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DISPOSITION_PROBLEM_KEY_CHARS) {
    throw new DomainError('invalid_input', 'problemKey must be a bounded string');
  }
  const key = problemKey(parseProblemKey(value));
  if (key !== value) throw new DomainError('invalid_input', 'problemKey must be canonical');
  return key;
}
export function validateDispositionBatch(action: ProblemDispositionAction,
  items: readonly { readonly problemKey: string; readonly expectedState: ProblemDispositionState | null }[],
): { readonly problemKeys: readonly string[] } {
  if (!PROBLEM_DISPOSITION_ACTIONS.includes(action) || !Array.isArray(items) || items.length < 1 || items.length > MAX_DISPOSITION_BATCH) {
    throw new DomainError('invalid_input', 'invalid problem disposition action or batch size');
  }
  const keys = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['problemKey', 'expectedState'].includes(key)) ||
      (item.expectedState !== null && !PROBLEM_DISPOSITION_STATES.includes(item.expectedState))) {
      throw new DomainError('invalid_input', 'invalid problem disposition item');
    }
    const key = canonicalProblemKey(item.problemKey);
    if (keys.has(key)) throw new DomainError('invalid_input', 'duplicate problem disposition key');
    keys.add(key);
  }
  return { problemKeys: [...keys] };
}
