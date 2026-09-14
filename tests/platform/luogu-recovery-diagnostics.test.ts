/**
 * Sprint 25a: durable per-key metadata diagnostics and the body-free failure reason.
 *
 * These tests exercise the externally meaningful behavior of the new vocabulary: a state row keeps
 * one bounded diagnostic per queued key without ever accepting raw text, a legacy row without the
 * field stays valid and is not rewritten, a success removes only its own key's diagnostic, and the
 * blank-description refusal is classified as an explicit, item-scoped `missing_statement` while the
 * durable failure code still pauses a source unless the caller branches on the *reason*.
 *
 * Everything here is synthetic: invented `P900000001`/`U900000001` keys, a synthetic source instance
 * and one fake account. No request, credential, cookie or real problem data is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { problemKey } from '../../src/domain/index.js';
import { PlatformError, PLATFORM_ERROR_REASONS } from '../../src/application/platform-errors.js';
import {
  LUOGU_METADATA_MAX_ISSUE_ATTEMPTS,
  LUOGU_METADATA_UNKNOWN_ISSUE_LABEL,
  clearMetadataIssue,
  emptyLuoguSyncState,
  luoguSyncFailurePauses,
  metadataIssueFor,
  upsertMetadataIssue,
  validateLuoguSyncFailure,
  validateLuoguSyncState,
  type LuoguMetadataIssue,
} from '../../src/application/luogu-sync-types.js';
import { parseProblemDetail } from '../../src/adapters/luogu/parsers.js';

/** Synthetic source instance id; every key below is canonical for exactly this instance. */
const SOURCE = 'luogu-synthetic-instance';
const ACCOUNT = 'luogu-synthetic-account';
const AT = '2026-01-02T03:04:05.000Z';
const LATER = '2026-01-02T04:00:00.000Z';

/** A canonical key built through the domain's own canonicalizer, never by string concatenation. */
function keyOf(externalKey: string): string {
  return problemKey({ sourceInstanceId: SOURCE, domain: null, externalKey });
}

function issueFor(externalKey: string, overrides: Partial<LuoguMetadataIssue> = {}): LuoguMetadataIssue {
  return {
    problemKey: keyOf(externalKey),
    code: 'changed_response',
    reason: 'missing_statement',
    at: AT,
    attempts: 1,
    ...overrides,
  };
}

/** Base durable state with only the fields a diagnostics test cares about overridden. */
function stateWith(fields: { missingMetadata: readonly string[]; metadataIssues?: readonly unknown[] }) {
  const base = emptyLuoguSyncState(ACCOUNT, SOURCE, AT);
  return validateLuoguSyncState({
    ...base,
    missingMetadata: [...fields.missingMetadata],
    ...(fields.metadataIssues === undefined ? {} : { metadataIssues: fields.metadataIssues }),
  });
}

// ---------------------------------------------------------------------------------------
// Durable state: the optional issue list
// ---------------------------------------------------------------------------------------

test('a valid per-key diagnostic round-trips through the state validator', () => {
  const key = keyOf('P900000001');
  const validated = stateWith({ missingMetadata: [key], metadataIssues: [issueFor('P900000001')] });
  assert.deepEqual(validated.metadataIssues, [
    { problemKey: key, code: 'changed_response', reason: 'missing_statement', at: AT, attempts: 1 },
  ]);
  assert.equal(validateLuoguSyncState(validated).metadataIssues?.length, 1);
});

test('a legacy state row without metadataIssues stays valid and gains no invented field', () => {
  // A genuine pre-Sprint-25a row: the field is absent from the stored JSON, not present-and-empty.
  const legacyRow: Record<string, unknown> = {
    ...emptyLuoguSyncState(ACCOUNT, SOURCE, AT),
    missingMetadata: [keyOf('U900000001')],
  };
  delete legacyRow['metadataIssues'];
  const validated = validateLuoguSyncState(legacyRow);
  assert.equal(validated.metadataIssues, undefined);
  // The field is absent, not `undefined`: re-saving such a row cannot add an empty list that would
  // claim "no key ever failed" where the stored bytes say "unknown".
  assert.equal(Object.prototype.hasOwnProperty.call(validated, 'metadataIssues'), false);
});

test('a state validator refuses an issue that is not a member of its own backlog', () => {
  assert.throws(
    () => stateWith({ missingMetadata: [keyOf('P900000001')], metadataIssues: [issueFor('U900000001')] }),
    /not a member of the missingMetadata backlog/,
  );
});

test('a state validator refuses a foreign-source or non-canonical issue key', () => {
  const foreign = problemKey({ sourceInstanceId: 'another-instance', domain: null, externalKey: 'P900000001' });
  assert.throws(
    () =>
      stateWith({
        missingMetadata: [keyOf('P900000001')],
        metadataIssues: [{ ...issueFor('P900000001'), problemKey: foreign }],
      }),
    /another source instance/,
  );
  assert.throws(
    () =>
      stateWith({
        missingMetadata: [keyOf('P900000001')],
        metadataIssues: [{ ...issueFor('P900000001'), problemKey: 'not-a-canonical-key' }],
      }),
    /not a canonical problem key/,
  );
});

test('the issue validator is closed: unknown enums, out-of-range counters and raw detail are refused', () => {
  assert.throws(
    () => stateWith({ missingMetadata: [keyOf('P900000001')], metadataIssues: [{ ...issueFor('P900000001'), code: 'nope' }] }),
    /unknown code/,
  );
  assert.throws(
    () =>
      stateWith({
        missingMetadata: [keyOf('P900000001')],
        metadataIssues: [{ ...issueFor('P900000001'), reason: 'parser_said_so' }],
      }),
    /unknown reason/,
  );
  assert.throws(
    () => stateWith({ missingMetadata: [keyOf('P900000001')], metadataIssues: [{ ...issueFor('P900000001'), attempts: 0 }] }),
    /attempts must be an integer/,
  );
  assert.throws(
    () =>
      stateWith({
        missingMetadata: [keyOf('P900000001')],
        metadataIssues: [{ ...issueFor('P900000001'), attempts: LUOGU_METADATA_MAX_ISSUE_ATTEMPTS + 1 }],
      }),
    /attempts must be an integer/,
  );
  // A response body, an exception message or a cookie must have nowhere to live in a diagnostic.
  assert.throws(
    () =>
      stateWith({
        missingMetadata: [keyOf('P900000001')],
        metadataIssues: [{ ...issueFor('P900000001'), detail: 'raw parser text' }],
      }),
    /unknown keys/,
  );
});

test('the state validator refuses two diagnostics for the same key', () => {
  assert.throws(
    () =>
      stateWith({
        missingMetadata: [keyOf('P900000001')],
        metadataIssues: [issueFor('P900000001'), issueFor('P900000001', { at: LATER, attempts: 2 })],
      }),
    /repeats the metadata issue/,
  );
});

// ---------------------------------------------------------------------------------------
// Pure issue bookkeeping
// ---------------------------------------------------------------------------------------

test('a success removes only its own diagnostic and carries every other issue over', () => {
  const first = issueFor('P900000001');
  const second = issueFor('U900000001');
  const issues = upsertMetadataIssue(upsertMetadataIssue(undefined, first), second);
  assert.equal(issues.length, 2);
  assert.deepEqual(metadataIssueFor(issues, first.problemKey), first);

  const afterSuccess = clearMetadataIssue(issues, first.problemKey);
  assert.deepEqual(afterSuccess, [second]);
  assert.equal(metadataIssueFor(afterSuccess, first.problemKey), null);
  assert.equal(metadataIssueFor(undefined, first.problemKey), null);
});

test('recording a later failure replaces the issue of that key in place and grows its counter', () => {
  const first = issueFor('P900000001');
  const other = issueFor('U900000001');
  const issues = upsertMetadataIssue(upsertMetadataIssue(undefined, first), other);
  const retried = upsertMetadataIssue(issues, {
    ...first,
    at: LATER,
    attempts: (metadataIssueFor(issues, first.problemKey)?.attempts ?? 0) + 1,
    reason: 'html_response',
  });
  assert.equal(retried.length, 2);
  assert.deepEqual(
    retried.map((entry) => entry.problemKey),
    [other.problemKey, first.problemKey],
  );
  assert.equal(metadataIssueFor(retried, first.problemKey)?.attempts, 2);
  assert.equal(metadataIssueFor(retried, first.problemKey)?.reason, 'html_response');
});

// ---------------------------------------------------------------------------------------
// Body-free reason on a platform failure
// ---------------------------------------------------------------------------------------

test('a declared reason is preserved and an undeclared one becomes null instead of being stored', () => {
  for (const reason of PLATFORM_ERROR_REASONS) {
    const error = new PlatformError({ code: 'changed_response', operation: 'problem', detail: 'x', reason });
    assert.equal(error.reason, reason);
  }
  const unknown = new PlatformError({
    code: 'changed_response',
    operation: 'problem',
    detail: 'some parser message that must not become a classification',
    reason: 'looks_like_missing_statement' as never,
  });
  assert.equal(unknown.reason, null);
  assert.equal(unknown.sample, null);
});

test('the durable failure record may name its item and reason, and still refuses an unknown reason', () => {
  const key = keyOf('U900000001');
  const named = validateLuoguSyncFailure({
    code: 'changed_response',
    at: AT,
    retryAt: null,
    paused: true,
    stage: 'metadata',
    problemKey: key,
    reason: 'missing_statement',
  });
  assert.equal(named.problemKey, key);
  assert.equal(named.reason, 'missing_statement');

  // A legacy four-field record is returned exactly as stored.
  const legacy = validateLuoguSyncFailure({ code: 'unavailable', at: AT, retryAt: LATER, paused: false });
  assert.deepEqual(legacy, { code: 'unavailable', at: AT, retryAt: LATER, paused: false });
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'reason'), false);

  assert.throws(
    () => validateLuoguSyncFailure({ code: 'changed_response', at: AT, retryAt: null, paused: true, reason: 'free_text' }),
    /unknown sync failure reason/,
  );
  assert.throws(
    () =>
      validateLuoguSyncFailure({ code: 'changed_response', at: AT, retryAt: null, paused: true, problemKey: 'not-canonical' }),
    /not a canonical problem key/,
  );
});

test('an explicit missing_statement must be deferred by reason: the durable code still pauses a source', () => {
  // This pairing is the whole point of the new vocabulary: the code alone cannot tell a deferrable
  // incomplete personal statement from a challenge or an unreadable payload, so a caller that
  // continued on `changed_response` would keep hammering a source that is genuinely walled.
  assert.equal(luoguSyncFailurePauses('changed_response'), true);
  assert.equal(LUOGU_METADATA_UNKNOWN_ISSUE_LABEL, '尚无逐题失败记录');
});

// ---------------------------------------------------------------------------------------
// The parser refusal that started it: a valid payload with a blank description
// ---------------------------------------------------------------------------------------

function detailPayload(pid: string, description: string | null): Record<string, unknown> {
  return {
    data: {
      problem: {
        pid,
        difficulty: 4,
        tags: [],
        content: {
          name: 'Synthetic problem',
          background: null,
          description,
          formatI: 'Two integers.',
          formatO: 'One integer.',
          hint: null,
        },
        samples: [['1 2', '3']],
        limits: { time: [1000], memory: [262144] },
      },
    },
  };
}

function reasonOf(payload: Record<string, unknown>, pid: string): string | null {
  try {
    parseProblemDetail(payload, pid);
  } catch (error) {
    assert.ok(error instanceof PlatformError, 'the parser refuses with a typed PlatformError');
    assert.equal(error.code, 'changed_response');
    return error.reason;
  }
  return 'no-refusal';
}

test('a blank description is refused as an explicit missing_statement, not as an unreadable payload', () => {
  assert.equal(reasonOf(detailPayload('P900000001', '   '), 'P900000001'), 'missing_statement');
  assert.equal(reasonOf(detailPayload('P900000001', null), 'P900000001'), 'missing_statement');
});

test('a complete statement is still accepted, and a refused payload never carries a body sample', () => {
  const detail = parseProblemDetail(detailPayload('P900000001', 'Add two integers.'), 'P900000001');
  assert.equal(detail.summary.pid, 'P900000001');
  assert.match(detail.statement, /Add two integers\./);

  try {
    parseProblemDetail(detailPayload('P900000001', ' '), 'P900000001');
    assert.fail('a blank description must be refused');
  } catch (error) {
    assert.ok(error instanceof PlatformError);
    assert.equal(error.sample, null);
    // The detail is the fixed parser sentence: it names the field, never the response body.
    assert.match(error.detail, /data\.problem\.content\.description/);
  }
});
