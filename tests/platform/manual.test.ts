/**
 * Manual import regressions: JSON and CSV parsing (quotes, newlines, BOM), strict nested
 * validation, reference/duplicate rejection, editorial found/absent/unavailable semantics,
 * limits, adapter pagination and cursor binding, account isolation, Codeforces handle
 * canonicalisation, preserved source identity, frozen owned data and cancellation.
 *
 * Every fixture is tiny, original and synthetic; the adapter performs no IO, so no network or
 * filesystem access happens here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MANUAL_MAX_FIELD_CHARS,
  MANUAL_MAX_ROWS,
  MANUAL_MAX_TEXT_BYTES,
  MANUAL_MAX_TEXT_CHARS,
  createManualPlatformAdapter,
  parseManualCsv,
  parseManualJson,
  type ManualCsvOptions,
  type ManualDocument,
  type ManualImportIssue,
  type ManualJsonOptions,
  type ManualParseOutcome,
  type ManualSourceInput,
} from '../../src/adapters/manual/index.js';
import type { PlatformLimits } from '../../src/application/ports.js';
import { accountIdOf, createAccount, createCancellationSource, isDeeplyFrozen } from '../../src/domain/index.js';

const AT = '2024-05-06T07:08:09.000Z';
const SOURCE: ManualSourceInput = { platform: 'manual', baseUrl: 'https://manual.example.test', displayName: 'Manual notes' };
const SOURCE_ID = 'manual:manual.example.test';
const LIMITS: PlatformLimits = {
  minRequestIntervalMs: 0,
  requestTimeoutMs: 30_000,
  maxRetries: 0,
  pageSize: 500,
  maxConcurrency: 1,
};
const TOKEN = createCancellationSource().token;
const SOLUTION_TEXT = 'Line one.\n\n  Indented "quoted" line.\n- bullet';
const ABSENT_NOTE = 'Checked the archive on 2024-05-06; no write-up was published.';

function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) {
    throw new Error('expected at least one item');
  }
  return value;
}

function ok(result: ManualParseOutcome): ManualDocument {
  if (!result.ok) {
    throw new Error(`expected a valid document, got: ${JSON.stringify(result.errors)}`);
  }
  return result.document;
}

function rejected(result: ManualParseOutcome): readonly ManualImportIssue[] {
  if (result.ok) {
    throw new Error('expected the import to be rejected');
  }
  return result.errors;
}

function codesOf(errors: readonly ManualImportIssue[]): string[] {
  return errors.map((issue) => issue.code);
}

function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
    return true;
  });
}

function jsonDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: SOURCE,
    accounts: [{ handle: 'alice' }, { handle: 'bob', displayName: 'Bob' }],
    problems: [
      {
        externalKey: 'p-100',
        title: 'Two Sum',
        url: 'https://manual.example.test/p/100',
        statement: 'Add two numbers.\nSecond line.',
        rawTags: ['dp', 'implementation'],
        ratings: [{ dimension: 'difficulty', value: 3, raw: '3', scale: { min: 1, max: 7 } }],
      },
      { externalKey: 'p-200', title: 'Graph Walk', url: 'https://manual.example.test/p/200' },
      { externalKey: 'p-300', title: 'Silent Problem', url: 'https://manual.example.test/p/300' },
    ],
    submissions: [
      {
        accountHandle: 'alice',
        externalKey: 'p-100',
        externalId: 's-1',
        verdict: 'wrong_answer',
        submittedAt: '2024-05-01T09:00:00Z',
        language: 'C++ 17',
      },
      {
        accountHandle: 'alice',
        externalKey: 'p-100',
        externalId: 's-2',
        verdict: 'accepted',
        submittedAt: '2024-05-01T10:00:00Z',
        timeMs: 15,
        memoryKiB: 2048,
      },
      {
        accountHandle: 'bob',
        externalKey: 'p-200',
        externalId: 's-3',
        verdict: 'time_limit_exceeded',
        submittedAt: '2024-05-02T11:00:00Z',
      },
    ],
    editorials: [
      {
        externalKey: 'p-100',
        status: 'found',
        url: 'https://manual.example.test/e/100',
        title: 'Editorial 100',
        solutions: [{ title: 'DP table', text: SOLUTION_TEXT, language: 'en' }],
      },
      {
        externalKey: 'p-200',
        status: 'absent',
        url: 'https://manual.example.test/e/200',
        title: 'Editorial 200',
        note: ABSENT_NOTE,
      },
    ],
    ...overrides,
  };
}

function parseJson(value: unknown, options: ManualJsonOptions = {}): ManualParseOutcome {
  return parseManualJson(JSON.stringify(value), { importedAt: AT, ...options });
}

test('JSON: a synthetic document becomes an immutable, summarised manual document', () => {
  const document = ok(parseJson(jsonDocument()));
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.source.id, SOURCE_ID);
  assert.equal(document.source.platform, 'manual');
  assert.equal(document.importedAt, AT);
  assert.equal(document.accounts.length, 2);
  assert.equal(document.problems.length, 3);
  assert.equal(document.submissions.length, 3);
  assert.equal(document.editorials.length, 3);
  assert.deepEqual(document.preview, {
    accounts: 2,
    problems: 3,
    submissions: 3,
    editorialsFound: 1,
    editorialsAbsent: 1,
    editorialsUnavailable: 1,
    rows: 10,
    bytes: document.preview.bytes,
  });
  assert.equal(document.preview.bytes > 0, true);
  assert.match(document.contentHash, /^[0-9a-f]{64}$/u);

  const problem = first(document.problems);
  assert.deepEqual(problem.ref, { sourceInstanceId: SOURCE_ID, domain: null, externalKey: 'p-100' });
  assert.equal(problem.key, 'manual%3Amanual.example.test||p-100');
  assert.equal(problem.statement, 'Add two numbers.\nSecond line.');
  assert.deepEqual(problem.ratings, [{ dimension: 'difficulty', value: 3, raw: '3', scale: { min: 1, max: 7 } }]);
  assert.deepEqual(problem.rawTags, [
    { raw: 'dp', sourceInstanceId: SOURCE_ID },
    { raw: 'implementation', sourceInstanceId: SOURCE_ID },
  ]);

  const accepted = document.submissions[1];
  assert.equal(accepted?.verdict, 'accepted');
  assert.equal(accepted?.timeMs, 15);
  assert.equal(accepted?.memoryKb, 2048);
  assert.equal(accepted?.accountId, first(document.accounts).id);

  const found = first(document.editorials);
  assert.equal(found.status, 'found');
  assert.equal(found.result.status, 'found');
  if (found.result.status === 'found') {
    assert.equal(first(found.result.solutions).text, SOLUTION_TEXT);
    assert.equal(first(found.result.sources).url, 'https://manual.example.test/e/100');
  }
  assert.equal(isDeeplyFrozen(document), true);
});

test('JSON: unknown and credential-like fields are rejected with location', () => {
  const errors = rejected(
    parseJson(jsonDocument({ token: 'never', accounts: [{ handle: 'alice', nickname: 'Al' }] })),
  );
  const secret = errors.find((issue) => issue.code === 'secret_field');
  assert.equal(secret?.field, 'token');
  const unknown = errors.find((issue) => issue.code === 'unknown_field');
  assert.equal(unknown?.field, 'nickname');
  assert.equal(unknown?.row, 1);
  assert.equal(unknown?.path, '$.accounts[0].nickname');
});

test('JSON: malformed input, unsupported versions and oversized text are rejected', () => {
  const broken = rejected(parseManualJson('{"schemaVersion": 1,', { importedAt: AT }));
  assert.equal(first(broken).code, 'invalid_json');
  assert.equal(first(broken).line, 1);

  const version = rejected(parseJson(jsonDocument({ schemaVersion: 2 })));
  assert.equal(first(version).code, 'invalid_input');
  assert.equal(first(version).field, 'schemaVersion');

  const oversized = rejected(parseManualJson('x'.repeat(MANUAL_MAX_TEXT_BYTES + 1), { importedAt: AT }));
  assert.equal(first(oversized).code, 'too_large');

  const notText = rejected(parseManualJson(null as unknown as string, { importedAt: AT }));
  assert.equal(first(notText).code, 'invalid_input');
});

test('JSON: nested numbers, dates, enums and URL credentials are validated', () => {
  const badRating = rejected(
    parseJson(
      jsonDocument({
        problems: [
          {
            externalKey: 'p-1',
            title: 'T',
            url: 'https://manual.example.test/p/1',
            ratings: [{ dimension: 'difficulty', value: null, raw: '3' }],
          },
        ],
        submissions: [],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(badRating).code, 'invalid_number');
  assert.equal(first(badRating).field, 'value');
  assert.equal(first(badRating).path, '$.problems[0].ratings[0].value');
  assert.equal(first(badRating).row, 1);

  const badScale = rejected(
    parseJson(
      jsonDocument({
        problems: [
          {
            externalKey: 'p-1',
            title: 'T',
            url: 'https://manual.example.test/p/1',
            ratings: [{ dimension: 'difficulty', value: 3, raw: '3', scale: { min: 5, max: 1 } }],
          },
        ],
        submissions: [],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(badScale).code, 'invalid_number');

  const unknownNested = rejected(
    parseJson(
      jsonDocument({
        problems: [
          {
            externalKey: 'p-1',
            title: 'T',
            url: 'https://manual.example.test/p/1',
            ratings: [{ dimension: 'difficulty', value: 3, raw: '3', colour: 'red' }],
          },
        ],
        submissions: [],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(unknownNested).code, 'unknown_field');
  assert.equal(first(unknownNested).field, 'colour');

  const badSubmission = rejected(
    parseJson(
      jsonDocument({
        submissions: [
          {
            accountHandle: 'alice',
            externalKey: 'p-100',
            externalId: 's-9',
            verdict: 'AC',
            submittedAt: '2024/05/01',
            timeMs: null,
            memoryKiB: -1,
          },
        ],
        editorials: [],
      }),
    ),
  );
  assert.deepEqual(codesOf(badSubmission), ['invalid_enum', 'invalid_date', 'invalid_number', 'invalid_number']);

  const impossibleDate = rejected(
    parseJson(
      jsonDocument({
        submissions: [
          {
            accountHandle: 'alice',
            externalKey: 'p-100',
            externalId: 's-9',
            verdict: 'accepted',
            submittedAt: '2024-02-30T00:00:00Z',
          },
        ],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(impossibleDate).code, 'invalid_date');

  const nonFinite = rejected(
    parseManualJson(JSON.stringify(jsonDocument()).replace('"memoryKiB":2048', '"memoryKiB":1e999'), {
      importedAt: AT,
    }),
  );
  assert.equal(first(nonFinite).code, 'invalid_number');

  const credentials = rejected(
    parseJson(jsonDocument({ accounts: [{ handle: 'alice', profileUrl: 'https://alice:pw@example.test/me' }] })),
  );
  assert.equal(first(credentials).code, 'invalid_url');
  assert.equal(first(credentials).field, 'profileUrl');
});

test('JSON: foreign and duplicate references are rejected, duplicates are never merged', () => {
  const foreign = rejected(
    parseJson(
      jsonDocument({
        submissions: [
          {
            accountHandle: 'nobody',
            externalKey: 'p-999',
            externalId: 's-9',
            verdict: 'accepted',
            submittedAt: '2024-05-01T09:00:00Z',
          },
        ],
        editorials: [],
      }),
    ),
  );
  assert.deepEqual(codesOf(foreign), ['unknown_reference']);

  const foreignProblem = rejected(
    parseJson(
      jsonDocument({
        submissions: [
          {
            accountHandle: 'alice',
            externalKey: 'p-999',
            externalId: 's-9',
            verdict: 'accepted',
            submittedAt: '2024-05-01T09:00:00Z',
          },
        ],
        editorials: [],
      }),
    ),
  );
  assert.deepEqual(codesOf(foreignProblem), ['unknown_reference']);
  assert.equal(first(foreignProblem).field, 'externalKey');

  const duplicateProblem = rejected(
    parseJson(
      jsonDocument({
        problems: [
          { externalKey: 'p-1', title: 'A', url: 'https://manual.example.test/p/1' },
          { externalKey: 'p-1', title: 'A again', url: 'https://manual.example.test/p/1' },
        ],
        submissions: [],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(duplicateProblem).code, 'duplicate_id');

  const identical = rejected(
    parseJson(
      jsonDocument({
        submissions: [
          {
            accountHandle: 'alice',
            externalKey: 'p-100',
            externalId: 's-1',
            verdict: 'accepted',
            submittedAt: '2024-05-01T09:00:00Z',
          },
          {
            accountHandle: 'alice',
            externalKey: 'p-100',
            externalId: 's-1',
            verdict: 'accepted',
            submittedAt: '2024-05-01T09:00:00Z',
          },
        ],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(identical).code, 'duplicate_row');

  const conflict = rejected(
    parseJson(
      jsonDocument({
        submissions: [
          {
            accountHandle: 'alice',
            externalKey: 'p-100',
            externalId: 's-1',
            verdict: 'accepted',
            submittedAt: '2024-05-01T09:00:00Z',
          },
          {
            accountHandle: 'alice',
            externalKey: 'p-100',
            externalId: 's-1',
            verdict: 'wrong_answer',
            submittedAt: '2024-05-01T09:00:00Z',
          },
        ],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(conflict).code, 'duplicate_conflict');

  const foreignEditorial = rejected(
    parseJson(jsonDocument({ editorials: [{ externalKey: 'p-999', status: 'found', url: 'https://x.test/e', title: 'E', solutions: [{ title: 'S', text: 'body' }] }] })),
  );
  assert.equal(first(foreignEditorial).code, 'unknown_reference');
});

test('JSON: editorial absence is explicit and solution text is preserved exactly', () => {
  const document = ok(parseJson(jsonDocument()));
  const found = document.editorials[0];
  assert.equal(found?.status, 'found');
  if (found?.result.status === 'found') {
    assert.equal(first(found.result.solutions).text, SOLUTION_TEXT);
    assert.equal(first(found.result.solutions).contentHash.length, 64);
  }
  const absent = document.editorials[1];
  assert.equal(absent?.status, 'absent');
  assert.deepEqual(absent?.result, { status: 'absent', detail: ABSENT_NOTE });
  assert.equal(absent?.note, ABSENT_NOTE);
  const missing = document.editorials[2];
  assert.equal(missing?.status, 'unavailable');
  assert.deepEqual(missing?.result, {
    status: 'unavailable',
    detail: 'no editorial record was supplied for this problem',
    retryable: false,
  });

  const noNote = rejected(
    parseJson(
      jsonDocument({
        editorials: [{ externalKey: 'p-200', status: 'absent', url: 'https://x.test/e', title: 'E' }],
      }),
    ),
  );
  assert.equal(first(noNote).code, 'invalid_field');
  assert.equal(first(noNote).field, 'note');

  const blankNote = rejected(
    parseJson(jsonDocument({ editorials: [{ externalKey: 'p-200', status: 'absent', url: 'https://x.test/e', title: 'E', note: '   ' }] })),
  );
  assert.equal(first(blankNote).code, 'invalid_field');

  const absentWithSolutions = rejected(
    parseJson(
      jsonDocument({
        editorials: [
          { externalKey: 'p-200', status: 'absent', url: 'https://x.test/e', title: 'E', note: ABSENT_NOTE, solutions: [{ title: 'S', text: 'body' }] },
        ],
      }),
    ),
  );
  assert.equal(first(absentWithSolutions).field, 'solutions');

  const foundWithoutSolutions = rejected(
    parseJson(jsonDocument({ editorials: [{ externalKey: 'p-100', status: 'found', url: 'https://x.test/e', title: 'E' }] })),
  );
  assert.equal(first(foundWithoutSolutions).code, 'missing_field');
  assert.equal(first(foundWithoutSolutions).field, 'solutions');
});

test('JSON: field, text, row and size limits are enforced', () => {
  const longStatement = rejected(
    parseJson(
      jsonDocument({
        problems: [
          { externalKey: 'p-1', title: 'T', url: 'https://manual.example.test/p/1', statement: 's'.repeat(MANUAL_MAX_TEXT_CHARS + 1) },
        ],
        submissions: [],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(longStatement).code, 'too_large');
  assert.equal(first(longStatement).field, 'statement');

  const longTitle = rejected(
    parseJson(
      jsonDocument({
        problems: [{ externalKey: 'p-1', title: 't'.repeat(MANUAL_MAX_FIELD_CHARS + 1), url: 'https://manual.example.test/p/1' }],
        submissions: [],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(longTitle).code, 'too_large');
  assert.equal(first(longTitle).field, 'title');

  const tooManyRows = rejected(
    parseJson(jsonDocument({ accounts: Array.from({ length: MANUAL_MAX_ROWS + 1 }, (_value, index) => ({ handle: `h${index}` })) })),
  );
  assert.equal(first(tooManyRows).code, 'too_many_rows');
});

test('JSON: a Codeforces import keeps the Codeforces identity and canonical handle', () => {
  const codeforces = {
    schemaVersion: 1,
    source: { platform: 'codeforces', baseUrl: 'https://codeforces.com', id: 'codeforces:codeforces.com' },
    accounts: [{ handle: 'Tourist', profileUrl: 'https://codeforces.com/profile/Tourist' }],
    problems: [{ externalKey: '1000A', title: 'A', url: 'https://codeforces.com/problemset/problem/1000/A' }],
    submissions: [
      {
        accountHandle: 'TOURIST',
        externalKey: '1000A',
        externalId: '12345',
        verdict: 'accepted',
        submittedAt: '2024-05-01T10:00:00Z',
      },
    ],
    editorials: [],
  };
  const document = ok(parseJson(codeforces));
  assert.equal(document.source.id, 'codeforces:codeforces.com');
  assert.equal(document.source.baseUrl, 'https://codeforces.com/');
  const account = first(document.accounts);
  assert.equal(account.handle, 'tourist');
  assert.equal(account.displayName, 'Tourist');
  assert.equal(account.id, accountIdOf('codeforces:codeforces.com', 'tourist'));
  assert.equal(first(document.problems).ref.sourceInstanceId, 'codeforces:codeforces.com');
  assert.equal(first(document.submissions).externalId, '12345');
  assert.equal(first(document.submissions).accountId, account.id);

  const wrongId = rejected(
    parseJson({ ...codeforces, source: { ...codeforces.source, id: 'manual:codeforces.com' } }),
  );
  assert.equal(first(wrongId).code, 'invalid_field');
  assert.equal(first(wrongId).field, 'id');

  const badHandle = rejected(parseJson({ ...codeforces, accounts: [{ handle: 'ab' }], submissions: [] }));
  assert.equal(first(badHandle).code, 'invalid_field');
  assert.equal(first(badHandle).field, 'handle');
});

test('CSV problems: BOM, quoted commas, doubled quotes and multiline cells', () => {
  const csv =
    '\uFEFFexternalKey,title,url,statement,rawTags,ratings,domain\r\n' +
    'p-1,"Comma, and ""quotes""",https://manual.example.test/p/1,"Line one.\nLine ""two"".","[""dp""]","[{""dimension"":""difficulty"",""value"":3,""raw"":""3""}]",\r\n' +
    'p-2,Plain,https://manual.example.test/p/2,,,,\r\n';
  const document = ok(parseManualCsv(csv, { kind: 'problems', source: SOURCE, importedAt: AT }));
  assert.equal(document.problems.length, 2);
  const problem = first(document.problems);
  assert.equal(problem.title, 'Comma, and "quotes"');
  assert.equal(problem.statement, 'Line one.\nLine "two".');
  assert.equal(problem.ref.domain, null);
  assert.deepEqual(problem.rawTags, [{ raw: 'dp', sourceInstanceId: SOURCE_ID }]);
  assert.equal(first(problem.ratings).value, 3);
  assert.equal(document.problems[1]?.statement, null);
  assert.equal(document.preview.rows, 2);
});

test('CSV submissions: context accounts/problems, numbers and row/field errors', () => {
  const csv =
    'accountHandle,domain,externalKey,externalId,verdict,submittedAt,language,timeMs,memoryKiB\n' +
    'alice,,p-1,s-1,accepted,2024-05-01T10:00:00Z,C++ 17,15,2048\n' +
    'alice,,p-1,s-2,wrong_answer,2024-05-01T11:00:00Z,,,\n';
  const document = ok(
    parseManualCsv(csv, {
      kind: 'submissions',
      source: SOURCE,
      importedAt: AT,
      accounts: [{ handle: 'alice' }],
      problems: [{ externalKey: 'p-1', title: 'One', url: 'https://manual.example.test/p/1' }],
    }),
  );
  assert.equal(document.submissions.length, 2);
  assert.equal(first(document.submissions).timeMs, 15);
  assert.equal(document.submissions[1]?.language, null);
  assert.equal(document.submissions[1]?.timeMs, null);
  assert.equal(first(document.problems).key, first(document.submissions).key);

  const badNumber = rejected(
    parseManualCsv(csv.replace(',15,2048', ',abc,2048'), {
      kind: 'submissions',
      source: SOURCE,
      importedAt: AT,
      accounts: [{ handle: 'alice' }],
      problems: [{ externalKey: 'p-1', title: 'One', url: 'https://manual.example.test/p/1' }],
    }),
  );
  assert.equal(first(badNumber).code, 'invalid_number');
  assert.equal(first(badNumber).field, 'timeMs');
  assert.equal(first(badNumber).row, 1);
  assert.equal(first(badNumber).line, 2);

  const foreignEditorial = rejected(
    parseManualCsv(csv, {
      kind: 'submissions',
      source: SOURCE,
      importedAt: AT,
      accounts: [{ handle: 'alice' }],
      problems: [{ externalKey: 'p-1', title: 'One', url: 'https://manual.example.test/p/1' }],
      editorials: [{ externalKey: 'p-9', status: 'absent', url: 'https://x.test/e', title: 'E', note: ABSENT_NOTE }],
    }),
  );
  assert.equal(first(foreignEditorial).code, 'unknown_reference');

  const unknownAccount = rejected(
    parseManualCsv(csv, {
      kind: 'submissions',
      source: SOURCE,
      importedAt: AT,
      accounts: [{ handle: 'bob' }],
      problems: [{ externalKey: 'p-1', title: 'One', url: 'https://manual.example.test/p/1' }],
    }),
  );
  assert.equal(first(unknownAccount).code, 'unknown_reference');
  assert.equal(first(unknownAccount).field, 'accountHandle');
});

test('CSV: normalised context records are validated, copied and never mutated later', () => {
  const contextProblem = {
    ref: { sourceInstanceId: SOURCE_ID, domain: null, externalKey: 'p-1' },
    key: 'manual%3Amanual.example.test||p-1',
    title: 'One',
    url: 'https://manual.example.test/p/1',
    statement: 'Body',
    ratings: [],
    rawTags: [{ raw: 'dp', sourceInstanceId: SOURCE_ID }],
    fetchedAt: AT,
  };
  const csv = 'accountHandle,domain,externalKey,externalId,verdict,submittedAt,language,timeMs,memoryKiB\nalice,,p-1,s-1,accepted,2024-05-01T10:00:00Z,,,\n';
  const document = ok(
    parseManualCsv(csv, {
      kind: 'submissions',
      source: SOURCE,
      importedAt: AT,
      accounts: [{ handle: 'alice' }],
      problems: [contextProblem],
    }),
  );
  contextProblem.title = 'HACKED';
  contextProblem.rawTags.push({ raw: 'evil', sourceInstanceId: SOURCE_ID });
  const adapter = createManualPlatformAdapter(document);
  assert.equal(first(document.problems).title, 'One');
  assert.equal(first(document.problems).rawTags.length, 1);

  const foreignAccount = { ...createAccount({ sourceInstanceId: 'manual:other.example.test', handle: 'alice' }) };
  const mismatch = rejected(
    parseManualCsv(csv, {
      kind: 'submissions',
      source: SOURCE,
      importedAt: AT,
      accounts: [foreignAccount],
      problems: [contextProblem],
    }),
  );
  assert.equal(first(mismatch).code, 'source_mismatch');
  assert.equal(first(mismatch).field, 'sourceInstanceId');

  const badKey = rejected(
    parseManualCsv(csv, {
      kind: 'submissions',
      source: SOURCE,
      importedAt: AT,
      accounts: [{ handle: 'alice' }],
      problems: [{ ...contextProblem, key: 'wrong' }],
    }),
  );
  assert.equal(first(badKey).code, 'invalid_field');
  assert.equal(first(badKey).field, 'key');
  assert.equal(adapter.capabilities().platform, 'manual');
});

test('CSV: headers are strict and malformed CSV text is reported with a line', () => {
  const missing = rejected(parseManualCsv('externalKey,title,url\np-1,T,https://x.test/p/1\n', { kind: 'problems', source: SOURCE, importedAt: AT }));
  assert.equal(first(missing).code, 'invalid_csv');
  assert.match(first(missing).message, /missing required column/u);

  const unknown = rejected(
    parseManualCsv('externalKey,title,url,statement,rawTags,ratings,domain,extra\np-1,T,https://x.test/p/1,,,,,\n', {
      kind: 'problems',
      source: SOURCE,
      importedAt: AT,
    }),
  );
  assert.match(first(unknown).message, /unknown column/u);

  const duplicated = rejected(
    parseManualCsv('externalKey,title,title,url,statement,rawTags,ratings,domain\np-1,T,T,https://x.test/p/1,,,,\n', {
      kind: 'problems',
      source: SOURCE,
      importedAt: AT,
    }),
  );
  assert.match(first(duplicated).message, /more than once/u);

  const ragged = rejected(
    parseManualCsv('externalKey,title,url,statement,rawTags,ratings,domain\np-1,T,https://x.test/p/1\n', {
      kind: 'problems',
      source: SOURCE,
      importedAt: AT,
    }),
  );
  assert.equal(first(ragged).code, 'invalid_csv');
  assert.equal(first(ragged).line, 2);

  const badKind = rejected(
    parseManualCsv('a\n1\n', { kind: 'editorials', source: SOURCE, importedAt: AT } as unknown as ManualCsvOptions),
  );
  assert.equal(first(badKind).code, 'invalid_enum');

  const badJsonCell = rejected(
    parseManualCsv('externalKey,title,url,statement,rawTags,ratings,domain\np-1,T,https://x.test/p/1,,[not json],,\n', {
      kind: 'problems',
      source: SOURCE,
      importedAt: AT,
    }),
  );
  assert.equal(first(badJsonCell).code, 'invalid_json');
  assert.equal(first(badJsonCell).field, 'rawTags');
});

test('Adapter: pages are frozen, ordered and bound to the document content', async () => {
  const document = ok(parseJson(jsonDocument()));
  const adapter = createManualPlatformAdapter(document);
  const firstPage = await adapter.listProblems({ cursor: null, limit: 2, token: TOKEN, limits: LIMITS });
  assert.deepEqual(
    firstPage.items.map((problem) => problem.ref.externalKey),
    ['p-100', 'p-200'],
  );
  assert.equal(firstPage.fetchedAt, AT);
  assert.equal(Object.isFrozen(firstPage.items), true);
  assert.throws(() => {
    (firstPage.items as unknown as unknown[]).push('x');
  });
  assert.equal(typeof firstPage.nextCursor, 'string');

  const secondPage = await adapter.listProblems({ cursor: firstPage.nextCursor, limit: 2, token: TOKEN, limits: LIMITS });
  assert.deepEqual(
    secondPage.items.map((problem) => problem.ref.externalKey),
    ['p-300'],
  );
  assert.equal(secondPage.nextCursor, null);

  const otherDocument = ok(parseJson(jsonDocument({ problems: [...(jsonDocument().problems as unknown[]), { externalKey: 'p-400', title: 'Extra', url: 'https://manual.example.test/p/400' }] })));
  const otherAdapter = createManualPlatformAdapter(otherDocument);
  await rejectsWithCode(
    otherAdapter.listProblems({ cursor: firstPage.nextCursor, limit: 2, token: TOKEN, limits: LIMITS }),
    'invalid_input',
  );
  await rejectsWithCode(adapter.listSubmissions({ cursor: firstPage.nextCursor, limit: 2, account: first(document.accounts), token: TOKEN, limits: LIMITS }), 'invalid_input');
  await rejectsWithCode(adapter.listProblems({ cursor: null, limit: 0, token: TOKEN, limits: LIMITS }), 'invalid_input');
  await rejectsWithCode(adapter.listProblems({ cursor: null, limit: 501, token: TOKEN, limits: LIMITS }), 'invalid_input');

  const capabilities = adapter.capabilities();
  assert.equal(capabilities.implemented, true);
  assert.equal(capabilities.requiresAuth, false);
  assert.equal(capabilities.platform, 'manual');
  assert.equal(capabilities.notes.some((note) => note.includes(SOURCE_ID)), true);
});

test('Adapter: submissions are account-scoped, sorted and bound to the since value', async () => {
  const document = ok(parseJson(jsonDocument()));
  const adapter = createManualPlatformAdapter(document);
  const alice = first(document.accounts);
  const bob = document.accounts[1];
  assert.ok(bob);

  const alicePage = await adapter.listSubmissions({ cursor: null, limit: 10, account: alice, token: TOKEN, limits: LIMITS });
  assert.deepEqual(
    alicePage.items.map((submission) => submission.externalId),
    ['s-1', 's-2'],
  );
  assert.equal(alicePage.items.every((submission) => submission.accountId === alice.id), true);

  const bobPage = await adapter.listSubmissions({ cursor: null, limit: 10, account: bob, token: TOKEN, limits: LIMITS });
  assert.deepEqual(
    bobPage.items.map((submission) => submission.externalId),
    ['s-3'],
  );

  const sincePage = await adapter.listSubmissions({
    cursor: null,
    limit: 10,
    account: alice,
    since: '2024-05-01T09:30:00Z',
    token: TOKEN,
    limits: LIMITS,
  });
  assert.deepEqual(
    sincePage.items.map((submission) => submission.externalId),
    ['s-2'],
  );

  const firstPage = await adapter.listSubmissions({ cursor: null, limit: 1, account: alice, token: TOKEN, limits: LIMITS });
  assert.equal(typeof firstPage.nextCursor, 'string');
  await rejectsWithCode(
    adapter.listSubmissions({
      cursor: firstPage.nextCursor,
      limit: 1,
      account: alice,
      since: '2024-05-01T00:00:00Z',
      token: TOKEN,
      limits: LIMITS,
    }),
    'invalid_input',
  );
  await rejectsWithCode(
    adapter.listSubmissions({ cursor: firstPage.nextCursor, limit: 1, account: bob, token: TOKEN, limits: LIMITS }),
    'invalid_input',
  );

  const unknownAccount = createAccount({ sourceInstanceId: document.source.id, handle: 'carol' });
  await rejectsWithCode(adapter.listSubmissions({ cursor: null, limit: 1, account: unknownAccount, token: TOKEN, limits: LIMITS }), 'invalid_input');
  const incoherent = { ...alice, id: 'manual:manual.example.test%7Cmallory' };
  await rejectsWithCode(adapter.listSubmissions({ cursor: null, limit: 1, account: incoherent, token: TOKEN, limits: LIMITS }), 'invalid_input');
});

test('Adapter: problem detail, editorial semantics and per-problem material', async () => {
  const document = ok(parseJson(jsonDocument()));
  const adapter = createManualPlatformAdapter(document);
  const problem = first(document.problems);
  const fetched = await adapter.fetchProblem({ problemRef: problem.ref, token: TOKEN, limits: LIMITS });
  assert.equal(fetched.key, problem.key);
  assert.equal(fetched.statement, problem.statement);
  assert.equal(Object.isFrozen(fetched), true);

  const found = await adapter.fetchEditorial({ problemRef: problem.ref, token: TOKEN, limits: LIMITS });
  assert.equal(found.status, 'found');
  if (found.status === 'found') {
    assert.equal(first(found.solutions).text, SOLUTION_TEXT);
    assert.equal(Object.isFrozen(found.solutions), true);
  }
  const absent = await adapter.fetchEditorial({ problemRef: first(document.problems.slice(1)).ref, token: TOKEN, limits: LIMITS });
  assert.deepEqual(absent, { status: 'absent', detail: ABSENT_NOTE });
  const missing = await adapter.fetchEditorial({ problemRef: document.problems[2]!.ref, token: TOKEN, limits: LIMITS });
  assert.deepEqual(missing, {
    status: 'unavailable',
    detail: 'no editorial record was supplied for this problem',
    retryable: false,
  });
  await rejectsWithCode(
    adapter.fetchProblem({
      problemRef: { sourceInstanceId: document.source.id, domain: null, externalKey: 'p-999' },
      token: TOKEN,
      limits: LIMITS,
    }),
    'unavailable',
  );
  await rejectsWithCode(
    adapter.fetchEditorial({
      problemRef: { sourceInstanceId: 'manual:elsewhere.test', domain: null, externalKey: 'p-100' },
      token: TOKEN,
      limits: LIMITS,
    }),
    'invalid_input',
  );
  await rejectsWithCode(
    adapter.fetchEditorial({ problemRef: problem.ref, token: TOKEN, limits: LIMITS, officialTutorialUrl: 'ftp://x.test/e' }),
    'invalid_input',
  );

  const material = adapter.materialFor(problem.ref);
  assert.ok(material);
  assert.equal(material.problem.key, problem.key);
  assert.equal(material.submissions.length, 2);
  assert.equal(material.editorial.status, 'found');
  assert.equal(adapter.materialFor({ sourceInstanceId: 'manual:elsewhere.test', domain: null, externalKey: 'p-100' }), null);
  assert.equal(adapter.listMaterials().length, document.problems.length);
  const mutableTitle = material.problem as unknown as { title: string };
  assert.throws(() => {
    mutableTitle.title = 'HACKED';
  });
  assert.equal(adapter.materialFor(problem.ref)?.problem.title, 'Two Sum');
});

test('Adapter: cancellation rejects every operation, cached arrays included', async () => {
  const document = ok(parseJson(jsonDocument()));
  const adapter = createManualPlatformAdapter(document);
  const source = createCancellationSource();
  source.cancel('test');
  const problemRef = first(document.problems).ref;
  await rejectsWithCode(adapter.listProblems({ cursor: null, limit: 10, token: source.token, limits: LIMITS }), 'cancelled');
  await rejectsWithCode(adapter.listSubmissions({ cursor: null, limit: 10, account: first(document.accounts), token: source.token, limits: LIMITS }), 'cancelled');
  await rejectsWithCode(adapter.fetchProblem({ problemRef, token: source.token, limits: LIMITS }), 'cancelled');
  await rejectsWithCode(adapter.fetchEditorial({ problemRef, token: source.token, limits: LIMITS }), 'cancelled');
  assert.equal(adapter.materialFor(problemRef)?.problem.key, first(document.problems).key);
});

test('Adapter: a hand-built document without a valid hash is rejected', () => {
  assert.throws(() => createManualPlatformAdapter({ ...ok(parseJson(jsonDocument())), contentHash: 'nope' }));
});

test('JSON: the content hash covers semantic metadata and excludes observation timestamps', () => {
  const base = jsonDocument();
  const document = ok(parseJson(base));
  const mutate = (change: (copy: Record<string, unknown>) => void): ManualDocument => {
    const copy = structuredClone(base) as Record<string, unknown>;
    change(copy);
    return ok(parseJson(copy));
  };
  const editorialsOf = (copy: Record<string, unknown>): Record<string, unknown>[] => copy.editorials as Record<string, unknown>[];
  const solutionsOf = (copy: Record<string, unknown>): Record<string, unknown>[] =>
    first(editorialsOf(copy)).solutions as Record<string, unknown>[];

  const variants: Array<[string, ManualDocument]> = [
    ['source displayName', mutate((copy) => { (copy.source as Record<string, unknown>).displayName = 'Renamed notes'; })],
    ['source baseUrl', mutate((copy) => { (copy.source as Record<string, unknown>).baseUrl = 'https://manual.example.test/mirror'; })],
    ['account displayName', mutate((copy) => { first(copy.accounts as Record<string, unknown>[]).displayName = 'Alice A.'; })],
    ['problem title', mutate((copy) => { first(copy.problems as Record<string, unknown>[]).title = 'Two Sum II'; })],
    ['submission verdict', mutate((copy) => { first(copy.submissions as Record<string, unknown>[]).verdict = 'partial'; })],
    ['submission memoryKiB', mutate((copy) => { (copy.submissions as Record<string, unknown>[])[1]!.memoryKiB = 2049; })],
    ['editorial kind', mutate((copy) => { first(editorialsOf(copy)).kind = 'discussion'; })],
    ['editorial note', mutate((copy) => { editorialsOf(copy)[1]!.note = 'Checked again on 2024-06-01; still absent.'; })],
    ['solution title', mutate((copy) => { first(solutionsOf(copy)).title = 'Renamed method'; })],
    ['solution language', mutate((copy) => { first(solutionsOf(copy)).language = 'zh'; })],
    ['solution text', mutate((copy) => { first(solutionsOf(copy)).text = `${SOLUTION_TEXT} Extra sentence.`; })],
  ];
  for (const [label, variant] of variants) {
    assert.notEqual(variant.contentHash, document.contentHash, `${label} must change the content hash`);
  }
  const renamedSource = variants[0]![1];
  assert.equal(renamedSource.source.id, document.source.id);
  assert.equal(renamedSource.source.displayName, 'Renamed notes');
  const mirroredSource = variants[1]![1];
  assert.equal(mirroredSource.source.id, document.source.id);
  assert.notEqual(mirroredSource.source.baseUrl, document.source.baseUrl);
  // The same text parsed at another observation time keeps exactly the same hash.
  assert.equal(ok(parseJson(base, { importedAt: '2025-01-01T00:00:00Z' })).contentHash, document.contentHash);
});

test('Adapter: a cursor captured from other content rejects a metadata-changed document', async () => {
  const document = ok(parseJson(jsonDocument()));
  const adapter = createManualPlatformAdapter(document);
  const page = await adapter.listProblems({ cursor: null, limit: 2, token: TOKEN, limits: LIMITS });
  const renamed = ok(parseJson(jsonDocument({ source: { ...SOURCE, displayName: 'Renamed notes' } })));
  assert.equal(renamed.source.id, document.source.id);
  assert.notEqual(renamed.contentHash, document.contentHash);
  await rejectsWithCode(
    createManualPlatformAdapter(renamed).listProblems({ cursor: page.nextCursor, limit: 2, token: TOKEN, limits: LIMITS }),
    'invalid_input',
  );
});

test('Numbers: fractional memoryKiB is preserved exactly from JSON and CSV', () => {
  const fractional = 1.0009765625;
  const json = ok(
    parseJson(
      jsonDocument({
        submissions: [
          {
            accountHandle: 'alice',
            externalKey: 'p-100',
            externalId: 's-1',
            verdict: 'accepted',
            submittedAt: '2024-05-01T09:00:00Z',
            timeMs: 15,
            memoryKiB: fractional,
          },
        ],
        editorials: [],
      }),
    ),
  );
  assert.equal(first(json.submissions).memoryKb, fractional);

  const header = 'accountHandle,domain,externalKey,externalId,verdict,submittedAt,language,timeMs,memoryKiB\n';
  const csvOptions = {
    kind: 'submissions',
    source: SOURCE,
    importedAt: AT,
    accounts: [{ handle: 'alice' }],
    problems: [{ externalKey: 'p-100', title: 'Two Sum', url: 'https://manual.example.test/p/100' }],
  } as const;
  const csv = ok(
    parseManualCsv(
      `${header}alice,,p-100,s-1,accepted,2024-05-01T10:00:00Z,,15,${fractional}\n` +
        'alice,,p-100,s-2,accepted,2024-05-01T11:00:00Z,,,\n',
      csvOptions,
    ),
  );
  assert.equal(first(csv.submissions).memoryKb, fractional);
  assert.equal(csv.submissions[1]?.memoryKb, null);

  for (const bad of [-1, null, '1024']) {
    const errors = rejected(
      parseJson(
        jsonDocument({
          submissions: [
            {
              accountHandle: 'alice',
              externalKey: 'p-100',
              externalId: 's-9',
              verdict: 'accepted',
              submittedAt: '2024-05-01T09:00:00Z',
              memoryKiB: bad,
            },
          ],
          editorials: [],
        }),
      ),
    );
    assert.equal(first(errors).code, 'invalid_number', `memoryKiB ${JSON.stringify(bad)} must be rejected`);
    assert.equal(first(errors).field, 'memoryKiB');
  }
  const infinite = rejected(
    parseManualJson(JSON.stringify(jsonDocument()).replace('"memoryKiB":2048', '"memoryKiB":1e999'), { importedAt: AT }),
  );
  assert.equal(first(infinite).code, 'invalid_number');
  assert.equal(first(infinite).field, 'memoryKiB');

  const negativeCell = rejected(parseManualCsv(`${header}alice,,p-100,s-1,accepted,2024-05-01T10:00:00Z,,,-1\n`, csvOptions));
  assert.equal(first(negativeCell).code, 'invalid_number');
  assert.equal(first(negativeCell).field, 'memoryKiB');
  assert.equal(first(negativeCell).line, 2);
  const textCell = rejected(parseManualCsv(`${header}alice,,p-100,s-1,accepted,2024-05-01T10:00:00Z,,,1.2.3\n`, csvOptions));
  assert.equal(first(textCell).code, 'invalid_number');
  assert.equal(first(textCell).field, 'memoryKiB');
});

test('CSV: reported lines are physical record start lines', () => {
  const header = 'accountHandle,domain,externalKey,externalId,verdict,submittedAt,language,timeMs,memoryKiB\n';
  const row = (id: string, time: string): string => `alice,,p-100,${id},accepted,${time},,,\n`;
  const badRow = (id: string, time: string): string => `alice,,p-100,${id},accepted,${time},,abc,\n`;
  const options = {
    kind: 'submissions',
    source: SOURCE,
    importedAt: AT,
    accounts: [{ handle: 'alice' }],
    problems: [{ externalKey: 'p-100', title: 'Two Sum', url: 'https://manual.example.test/p/100' }],
  } as const;

  const thirdDataRow = rejected(
    parseManualCsv(
      header + row('s-1', '2024-05-01T10:00:00Z') + row('s-2', '2024-05-01T11:00:00Z') + badRow('s-3', '2024-05-01T12:00:00Z'),
      options,
    ),
  );
  assert.equal(first(thirdDataRow).field, 'timeMs');
  assert.equal(first(thirdDataRow).row, 3);
  assert.equal(first(thirdDataRow).line, 4);

  const fourthDataRow = rejected(
    parseManualCsv(
      header +
        row('s-1', '2024-05-01T10:00:00Z') +
        row('s-2', '2024-05-01T11:00:00Z') +
        row('s-3', '2024-05-01T12:00:00Z') +
        badRow('s-4', '2024-05-01T13:00:00Z'),
      options,
    ),
  );
  assert.equal(first(fourthDataRow).row, 4);
  assert.equal(first(fourthDataRow).line, 5);

  const crlf = rejected(
    parseManualCsv(
      header.replace(/\n/gu, '\r\n') +
        row('s-1', '2024-05-01T10:00:00Z').replace(/\n/gu, '\r\n') +
        badRow('s-2', '2024-05-01T11:00:00Z').replace(/\n/gu, '\r\n'),
      options,
    ),
  );
  assert.equal(first(crlf).row, 2);
  assert.equal(first(crlf).line, 3);

  const withBlankLines = rejected(
    parseManualCsv(
      `\uFEFF\n\n${header}${row('s-1', '2024-05-01T10:00:00Z')}\n${badRow('s-2', '2024-05-01T11:00:00Z')}`,
      options,
    ),
  );
  assert.equal(first(withBlankLines).row, 2);
  assert.equal(first(withBlankLines).line, 6);

  const problemsCsv =
    'externalKey,title,url,statement,rawTags,ratings,domain\n' +
    'p-1,Multi,https://manual.example.test/p/1,"first\nsecond",,,\n' +
    '\n' +
    'p-2,Bad,https://manual.example.test/p/2,,[not json],,\n';
  const multiline = rejected(parseManualCsv(problemsCsv, { kind: 'problems', source: SOURCE, importedAt: AT }));
  assert.equal(first(multiline).code, 'invalid_json');
  assert.equal(first(multiline).field, 'rawTags');
  assert.equal(first(multiline).row, 2);
  assert.equal(first(multiline).line, 5);
});

test('CSV: the row limit rejects overflow instead of truncating', () => {
  const header = 'externalKey,title,url,statement,rawTags,ratings,domain\n';
  const table = (count: number): string =>
    header +
    Array.from({ length: count }, (_value, index) => `p-${index},P,https://manual.example.test/p/${index},,,,\n`).join('');
  const document = ok(parseManualCsv(table(MANUAL_MAX_ROWS), { kind: 'problems', source: SOURCE, importedAt: AT }));
  assert.equal(document.problems.length, MANUAL_MAX_ROWS);
  assert.equal(document.preview.rows, MANUAL_MAX_ROWS);

  const overflow = rejected(parseManualCsv(table(MANUAL_MAX_ROWS + 1), { kind: 'problems', source: SOURCE, importedAt: AT }));
  assert.equal(first(overflow).code, 'too_many_rows');
  assert.equal(first(overflow).path, '$');
  assert.match(first(overflow).message, new RegExp(`more than ${MANUAL_MAX_ROWS} data rows`, 'u'));
});
