/**
 * Virtual-performance form rules (Sprint 18c2).
 *
 * The editor is the only place where a user can turn a mistyped form into stored "evidence", so
 * these cases pin the decisions that matter outside the component: an empty number is never
 * silently `0`, an entered `0` or negative performance is legitimate, `participatedAt` is the local
 * instant the user actually ran the virtual contest, and a missing rank/note stays missing. No DOM,
 * no API and no clock are involved: `now` is passed in, so nothing here depends on the machine date.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPTY_VIRTUAL_PERFORMANCE_FORM,
  VIRTUAL_PERFORMANCE_EMPTY_NOTE,
  VIRTUAL_PERFORMANCE_SECTION_NOTE,
  parseVirtualPerformanceForm,
  virtualPerformanceCountsText,
  virtualPerformanceEntryText,
  virtualPerformanceInstant,
  virtualPerformanceLocalDateTime,
  virtualPerformanceWhenText,
  type VirtualPerformanceFormCheck,
  type VirtualPerformanceFormFields,
} from '../../src/ui/virtual-performance-view.js';
import {
  MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS,
  VIRTUAL_PERFORMANCE_MIN,
  VIRTUAL_PERFORMANCE_MAX,
  createVirtualPerformanceLedger,
  virtualPerformanceCounts,
} from '../../src/domain/index.js';

const NOW = new Date('2026-11-01T08:00:00.000Z');

/** One complete, submittable form; a case overrides exactly the field it is about. */
function form(overrides: Partial<VirtualPerformanceFormFields> = {}): VirtualPerformanceFormFields {
  return {
    ...EMPTY_VIRTUAL_PERFORMANCE_FORM,
    contestId: '1942',
    participatedAt: '2026-03-01T14:30:00',
    performance: '1500',
    calculationMethod: 'carrot',
    sourceUrl: 'https://codeforces.com/contest/1942',
    independence: 'independent',
    ...overrides,
  };
}

function values(check: VirtualPerformanceFormCheck) {
  assert.equal(check.state, 'valid', `expected a valid form, got ${JSON.stringify(check)}`);
  if (check.state !== 'valid') throw new Error('unreachable');
  return check.values;
}

function errors(check: VirtualPerformanceFormCheck) {
  assert.equal(check.state, 'invalid', `expected a refusal, got ${JSON.stringify(check)}`);
  if (check.state !== 'invalid') throw new Error('unreachable');
  return check.errors;
}

void test('an empty numeric field is refused and never submitted as zero', () => {
  assert.match(errors(parseVirtualPerformanceForm(form({ performance: '' }), NOW)).performance ?? '', /留空不会被当作 0 分/);
  assert.match(errors(parseVirtualPerformanceForm(form({ contestId: '' }), NOW)).contestId ?? '', /不能为空/);
  // An entirely empty form is refused on every required field, and nothing is echoed back.
  const empty = parseVirtualPerformanceForm(EMPTY_VIRTUAL_PERFORMANCE_FORM, NOW);
  assert.equal(empty.state, 'invalid');
  assert.equal(Object.hasOwn(empty, 'values'), false, 'a refused form carries no submittable values');
  for (const field of ['contestId', 'participatedAt', 'performance', 'calculationMethod', 'sourceUrl', 'independence'] as const) {
    assert.ok(errors(empty)[field], `${field} must be refused while empty`);
  }
});

void test('an entered zero and a negative performance stay legitimate values', () => {
  assert.equal(values(parseVirtualPerformanceForm(form({ performance: '0' }), NOW)).performance, 0);
  assert.equal(values(parseVirtualPerformanceForm(form({ performance: '-12' }), NOW)).performance, -12);
  assert.equal(values(parseVirtualPerformanceForm(form({ performance: ` ${VIRTUAL_PERFORMANCE_MIN} ` }), NOW)).performance, VIRTUAL_PERFORMANCE_MIN);
  assert.equal(values(parseVirtualPerformanceForm(form({ performance: String(VIRTUAL_PERFORMANCE_MAX) }), NOW)).performance, VIRTUAL_PERFORMANCE_MAX);
  assert.match(errors(parseVirtualPerformanceForm(form({ performance: String(VIRTUAL_PERFORMANCE_MAX + 1) }), NOW)).performance ?? '', /可信范围/);
  assert.match(errors(parseVirtualPerformanceForm(form({ performance: String(VIRTUAL_PERFORMANCE_MIN - 1) }), NOW)).performance ?? '', /可信范围/);
  for (const bad of ['1.5', '1e3', '+3', 'abc', '１２３']) {
    assert.match(errors(parseVirtualPerformanceForm(form({ performance: bad }), NOW)).performance ?? '', /整数/, bad);
  }
});

void test('missing optional fields stay missing instead of becoming zero or empty text', () => {
  const check = values(parseVirtualPerformanceForm(form({ rank: '', note: '   ' }), NOW));
  assert.equal(check.rank, null);
  assert.equal(check.note, null);
  assert.equal(values(parseVirtualPerformanceForm(form({ rank: '7', note: ' 赛后复盘 ' }), NOW)).rank, 7);
  assert.equal(values(parseVirtualPerformanceForm(form({ rank: '7', note: ' 赛后复盘 ' }), NOW)).note, '赛后复盘');
  for (const bad of ['0', '-1', '1.5', '第3名']) {
    assert.match(errors(parseVirtualPerformanceForm(form({ rank: bad }), NOW)).rank ?? '', /正整数/, bad);
  }
});

void test('the participation time is the local instant the user typed, not the official contest date', () => {
  const check = values(parseVirtualPerformanceForm(form({ participatedAt: '2026-03-01T14:30:00' }), NOW));
  const stored = new Date(check.participatedAt);
  assert.deepEqual(
    [stored.getFullYear(), stored.getMonth() + 1, stored.getDate(), stored.getHours(), stored.getMinutes(), stored.getSeconds()],
    [2026, 3, 1, 14, 30, 0],
    'the stored instant is the same wall-clock time the user entered, in their own zone',
  );
  // A seconds-less value keeps its minute; an ISO instant survives the round trip exactly.
  assert.equal(new Date(values(parseVirtualPerformanceForm(form({ participatedAt: '2026-03-01T14:30' }), NOW)).participatedAt).getSeconds(), 0);
  const iso = '2026-10-05T06:07:08.000Z';
  assert.equal(virtualPerformanceInstant(virtualPerformanceLocalDateTime(iso)), Date.parse(iso));
  assert.equal(virtualPerformanceLocalDateTime('not a date'), '');
});

void test('an empty, impossible or future participation time is refused with its own reason', () => {
  assert.match(errors(parseVirtualPerformanceForm(form({ participatedAt: '' }), NOW)).participatedAt ?? '', /不是官方比赛日期/);
  for (const bad of ['2026-02-30T10:00:00', '2026-13-01T10:00:00', '2026-03-01', '01/03/2026 14:30']) {
    assert.match(errors(parseVirtualPerformanceForm(form({ participatedAt: bad }), NOW)).participatedAt ?? '', /无法识别/, bad);
  }
  const future = new Date(NOW.getTime() + 60_000).toISOString();
  assert.match(errors(parseVirtualPerformanceForm(form({ participatedAt: virtualPerformanceLocalDateTime(future) }), NOW)).participatedAt ?? '', /不能晚于现在/);
});

void test('independence must be one of the three answers and is never inferred', () => {
  assert.match(errors(parseVirtualPerformanceForm(form({ independence: '' }), NOW)).independence ?? '', /独立完成情况/);
  assert.match(errors(parseVirtualPerformanceForm(form({ independence: 'independent ' }), NOW)).independence ?? '', /独立完成情况/);
  for (const value of ['independent', 'assisted', 'unknown'] as const) {
    assert.equal(values(parseVirtualPerformanceForm(form({ independence: value }), NOW)).independence, value);
  }
  assert.equal(values(parseVirtualPerformanceForm(form({ priorExposure: true }), NOW)).priorExposure, true);
  assert.equal(values(parseVirtualPerformanceForm(form(), NOW)).priorExposure, false);
});

void test('the reference link must be an absolute, credential-free http(s) URL the plugin never fetches', () => {
  for (const bad of ['', 'codeforces.com/contest/1942', 'javascript:alert(1)', 'ftp://codeforces.com/x', 'https://u:p@codeforces.com/contest/1942']) {
    assert.ok(errors(parseVirtualPerformanceForm(form({ sourceUrl: bad }), NOW)).sourceUrl, bad);
  }
  assert.equal(
    values(parseVirtualPerformanceForm(form({ sourceUrl: ' https://codeforces.com/contest/1942 ' }), NOW)).sourceUrl,
    'https://codeforces.com/contest/1942',
  );
  assert.match(errors(parseVirtualPerformanceForm(form({ sourceUrl: 'https://' + 'a'.repeat(3000) }), NOW)).sourceUrl ?? '', /最多/);
});

void test('the calculation method is mandatory and bounded', () => {
  assert.match(errors(parseVirtualPerformanceForm(form({ calculationMethod: '  ' }), NOW)).calculationMethod ?? '', /方法或工具名称/);
  const longest = 'm'.repeat(MAX_VIRTUAL_PERFORMANCE_METHOD_CHARS);
  assert.equal(values(parseVirtualPerformanceForm(form({ calculationMethod: longest }), NOW)).calculationMethod, longest);
  assert.match(errors(parseVirtualPerformanceForm(form({ calculationMethod: longest + 'm' }), NOW)).calculationMethod ?? '', /最多/);
});

void test('one bad field reports itself without discarding the fields that are fine', () => {
  const check = parseVirtualPerformanceForm(form({ participatedAt: '', performance: '0', rank: '' }), NOW);
  const refusal = errors(check);
  assert.deepEqual(Object.keys(refusal), ['participatedAt']);
  assert.match(refusal.participatedAt ?? '', /请填写/);
});

void test('reading helpers describe a stored row and an empty ledger without inventing a score', () => {
  const ledger = createVirtualPerformanceLedger({
    accountId: 'account:alice',
    revision: 3,
    updatedAt: '2026-11-01T08:00:00.000Z',
    entries: [
      {
        evidenceId: 'vp-1',
        contestId: 1942,
        participatedAt: '2026-10-01T12:00:00.000Z',
        performance: 0,
        calculationMethod: 'carrot',
        sourceUrl: 'https://codeforces.com/contest/1942',
        independence: 'unknown',
        priorExposure: true,
        rank: null,
        note: null,
      },
    ],
  });
  const entry = ledger.entries[0]!;
  assert.match(virtualPerformanceEntryText(entry), /不确定（按未知处理）/);
  assert.match(virtualPerformanceEntryText(entry), /赛前已见过题/);
  assert.equal(virtualPerformanceEntryText(entry).includes('独立完成'), false, 'unknown independence is never read as independent');
  const counts = virtualPerformanceCountsText(virtualPerformanceCounts(ledger.entries));
  assert.match(counts, /共 1 条/);
  assert.match(counts, /可作为独立能力证据 0 条/);
  assert.match(counts, /独立性未知 1 条/);
  assert.equal(virtualPerformanceWhenText('broken'), '时间缺失');
  assert.match(virtualPerformanceWhenText('2026-10-01T12:00:00.000Z'), /2026/);
  assert.match(VIRTUAL_PERFORMANCE_SECTION_NOTE, /不是 Codeforces 官方 rating/);
  assert.match(VIRTUAL_PERFORMANCE_SECTION_NOTE, /不会为录入调用 AI/);
  assert.match(VIRTUAL_PERFORMANCE_EMPTY_NOTE, /不会被当作 0 分/);
});
