/**
 * View rules of the Luogu metadata backlog and manual-recovery panel (Sprint 25b).
 *
 * These cases drive the pure helpers of `luogu-metadata-view.ts` directly: no DOM, no React, no HTTP,
 * no store, no clock and no credential. They pin the externally meaningful guarantees the panel
 * relies on — the fixed translation of each recorded reason (with the parser-shaped reasons kept
 * honestly uncertain), the legacy "no per-key record" case, the separation of the pending item count
 * from the lifetime failed-**attempt** counter, the one bounded page with its pre-request clamp, the
 * three distinguishable retry outcomes, the closed supplement form contract (required title only when
 * none is stored, required real statement, the exact request payload with `expectedSnapshotId`, and a
 * draft that survives every refusal including a snapshot conflict), the single readable reason every
 * per-item mutation is refused with, and the transient start notice that only durable evidence may
 * settle.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE,
  LUOGU_METADATA_BACKLOG_PAGE_SIZE,
  LUOGU_METADATA_CODE_TEXT,
  LUOGU_METADATA_ISSUE_UNKNOWN_LABEL,
  LUOGU_METADATA_MANUAL_NOTE,
  LUOGU_METADATA_PAGE_SIZE_OPTIONS,
  LUOGU_METADATA_REASON_TEXT,
  LUOGU_METADATA_REASON_UNKNOWN_TEXT,
  LUOGU_SUPPLEMENT_AI_NOTE,
  LUOGU_SUPPLEMENT_AUDIT_NOTE,
  clampLuoguMetadataPage,
  luoguMetadataBacklogRequest,
  luoguMetadataCounts,
  luoguMetadataDisclosureLabel,
  luoguMetadataFailureText,
  luoguMetadataHostFailureLine,
  luoguMetadataIssueText,
  luoguMetadataMutationReason,
  luoguMetadataPageCount,
  luoguMetadataPageLabel,
  luoguMetadataPageSize,
  luoguMetadataPointer,
  luoguMetadataReasonText,
  luoguMetadataRetryErrorText,
  luoguMetadataRetryText,
  luoguStartNotice,
  luoguStartNoticeStep,
  luoguSupplementErrorText,
  luoguSupplementValidation,
  type LuoguStartObservation,
  type LuoguSupplementTarget,
} from '../../src/ui/luogu-metadata-view.js';
import { luoguTime } from '../../src/ui/luogu-view.js';
import {
  LUOGU_METADATA_BACKLOG_DEFAULT_PAGE_SIZE,
  LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE as APPLICATION_MAX_PAGE_SIZE,
  LUOGU_METADATA_UNKNOWN_ISSUE_LABEL,
  LUOGU_SYNC_FAILURE_CODES,
  type LuoguMetadataIssue,
} from '../../src/application/luogu-sync-types.js';
import { PLATFORM_ERROR_REASONS } from '../../src/application/platform-errors.js';
import type { ApiLuoguMetadataBacklogView, ApiLuoguStatusView } from '../../src/application/workbench-api.js';

const AT = '2026-03-01T10:00:00.000Z';
const EARLIER = '2026-03-01T09:00:00.000Z';
const LATER = '2026-03-01T11:00:00.000Z';
const ACCOUNT = 'luogu:www.luogu.com.cn:800001';
const OTHER = 'luogu:www.luogu.com.cn:800002';
const KEY = 'luogu:www.luogu.com.cn:P900000001';

/** One complete status answer, so every case states only the field it is about. */
function status(overrides: Partial<ApiLuoguStatusView> = {}): ApiLuoguStatusView {
  return {
    accountId: ACCOUNT,
    uid: '800001',
    sourceInstanceId: 'luogu:www.luogu.com.cn',
    connectionAvailable: true,
    connectionPlatform: 'win32',
    connection: {
      status: 'connected',
      connectedAt: AT,
      checkedAt: AT,
      failureCode: null,
      cleanupPending: false,
    },
    settings: {
      accountId: ACCOUNT,
      automaticEnabled: false,
      runOnStartup: true,
      intervalMinutes: 30,
      updatedAt: AT,
    },
    settingsRevision: 4,
    phase: 'incremental',
    historyComplete: true,
    historyCompletedAt: AT,
    resumePending: false,
    scanSince: null,
    running: false,
    leaseActive: false,
    paused: false,
    failure: null,
    nextRunAt: null,
    scanStartedAt: AT,
    lastScanStartedAt: AT,
    lastSuccessAt: AT,
    pagesInPass: 0,
    totalPages: 3,
    submissionsSeen: 120,
    metadataBacklog: 0,
    metadataBacklogFull: false,
    metadataResolved: 2,
    metadataFailed: 0,
    backlogDropped: 0,
    closing: false,
    ...overrides,
  };
}

/** One backlog answer with the three counters a case is about. */
function backlog(
  overrides: Partial<ApiLuoguMetadataBacklogView> = {},
): ApiLuoguMetadataBacklogView {
  return {
    accountId: ACCOUNT,
    total: 0,
    page: 1,
    pageSize: 20,
    knownIssues: 0,
    historicalFailedAttempts: 0,
    unknownIssueLabel: LUOGU_METADATA_ISSUE_UNKNOWN_LABEL,
    items: [],
    ...overrides,
  };
}

/** One durable observation of the durable run state, for the start-notice fold. */
function observation(overrides: Partial<LuoguStartObservation> = {}): LuoguStartObservation {
  return {
    accountId: ACCOUNT,
    running: false,
    leaseActive: false,
    lastSuccessAt: AT,
    scanStartedAt: AT,
    failureAt: null,
    closing: false,
    ...overrides,
  };
}

void test('the mirrored backlog bounds and unknown label still match the application module', () => {
  assert.equal(LUOGU_METADATA_BACKLOG_PAGE_SIZE, LUOGU_METADATA_BACKLOG_DEFAULT_PAGE_SIZE);
  assert.equal(LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE, APPLICATION_MAX_PAGE_SIZE);
  assert.equal(LUOGU_METADATA_ISSUE_UNKNOWN_LABEL, LUOGU_METADATA_UNKNOWN_ISSUE_LABEL);
  assert.ok(LUOGU_METADATA_BACKLOG_PAGE_SIZE <= LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE);
  for (const size of LUOGU_METADATA_PAGE_SIZE_OPTIONS) {
    assert.ok(size >= 1 && size <= LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE, `${size} must be a legal page size`);
  }
  // One page must stay far below the endpoint bound: the panel can never request the whole queue.
  assert.ok(LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE >= 1);
  for (const size of LUOGU_METADATA_PAGE_SIZE_OPTIONS) {
    assert.ok(size < LUOGU_METADATA_BACKLOG_MAX_PAGE_SIZE);
  }
});

void test('every recorded reason has its own sentence, and the parser-shaped ones stay uncertain', () => {
  const sentences = PLATFORM_ERROR_REASONS.map((reason) => LUOGU_METADATA_REASON_TEXT[reason]);
  assert.equal(sentences.length, PLATFORM_ERROR_REASONS.length);
  assert.equal(new Set(sentences).size, sentences.length, 'two reasons must not share one sentence');
  assert.equal(
    LUOGU_METADATA_REASON_TEXT.missing_statement,
    '缺少题面：洛谷返回的题目描述为空；可打开原题检查、稍后重试或手工补充。',
  );
  for (const reason of ['html_response', 'invalid_json', 'invalid_payload'] as const) {
    const sentence = LUOGU_METADATA_REASON_TEXT[reason];
    assert.match(sentence, /具体原因不确定/, `${reason} must not claim a diagnosis`);
    assert.match(sentence, /打开原题/);
    assert.match(sentence, /手工补充/);
    assert.doesNotMatch(sentence, /凭据|Cookie|过期|一定/);
  }
  assert.equal(luoguMetadataReasonText(null), LUOGU_METADATA_REASON_UNKNOWN_TEXT);
  assert.match(LUOGU_METADATA_REASON_UNKNOWN_TEXT, /不确定/);
  for (const reason of PLATFORM_ERROR_REASONS) {
    assert.equal(luoguMetadataReasonText(reason), LUOGU_METADATA_REASON_TEXT[reason]);
  }
});

void test('a recorded issue states its time, attempts and reason; a legacy key never claims "never tried"', () => {
  const issue: LuoguMetadataIssue = {
    problemKey: KEY,
    code: 'changed_response',
    reason: 'missing_statement',
    at: EARLIER,
    attempts: 3,
  };
  const recorded = luoguMetadataIssueText(issue);
  assert.ok(recorded.includes(luoguTime(EARLIER)));
  assert.match(recorded, /累计失败 3 次/);
  assert.match(recorded, /缺少题面/);
  assert.doesNotMatch(recorded, /尚无逐题失败记录/);

  const legacy = luoguMetadataIssueText(null);
  assert.ok(legacy.startsWith(LUOGU_METADATA_ISSUE_UNKNOWN_LABEL));
  assert.match(legacy, /旧数据/);
  assert.match(legacy, /也可能是还没尝试过/);
  assert.doesNotMatch(legacy, /从未尝试|没有失败/);
  // The server's own label is honoured when the panel has one.
  assert.ok(luoguMetadataIssueText(null, '服务端标签').startsWith('服务端标签'));
});

void test('pending items, page-known issues and lifetime failed attempts stay three separate numbers', () => {
  const counts = luoguMetadataCounts(backlog({ total: 12, knownIssues: 3, historicalFailedAttempts: 47 }));
  assert.ok(counts.includes('12') && counts.includes('3') && counts.includes('47'));
  assert.match(counts, /当前待补 12 题/);
  assert.match(counts, /本页有逐题原因 3 条/);
  assert.match(counts, /历史累计失败尝试 47 次/);
  assert.match(counts, /是尝试次数，不是失败题目数/);
  assert.doesNotMatch(counts, /47 题/);
  assert.match(luoguMetadataCounts(null), /尚未读取/);
});

void test('the pointer names the disclosure whenever a key is pending, and never blames the login', () => {
  assert.equal(luoguMetadataPointer(null), null);
  assert.equal(luoguMetadataPointer(status()), null, 'an empty backlog has nothing to point at');

  const pending = luoguMetadataPointer(status({ metadataBacklog: 5 }));
  assert.match(pending ?? '', /待补题目与手动处理（5）/);
  assert.match(pending ?? '', /逐题重试或手工补充/);
  assert.match(pending ?? '', /不使用 AI/);
  assert.doesNotMatch(pending ?? '', /登录凭据|过期|重新连接/);

  const metadataFailure = luoguMetadataPointer(
    status({
      metadataBacklog: 5,
      failure: { code: 'auth_required', at: AT, retryAt: null, paused: true, stage: 'metadata' },
    }),
  );
  assert.match(metadataFailure ?? '', /上一轮在补齐题目资料时失败/);
  assert.match(metadataFailure ?? '', /待补题目与手动处理（5）/);

  const historyFailure = luoguMetadataPointer(
    status({ metadataBacklog: 5, failure: { code: 'timeout', at: AT, retryAt: null, paused: false, stage: 'history' } }),
  );
  assert.match(historyFailure ?? '', /待补题目与手动处理（5）/);
  assert.doesNotMatch(historyFailure ?? '', /上一轮在补齐题目资料时/);
});

void test('the disclosure label always states the pending count', () => {
  assert.equal(luoguMetadataDisclosureLabel(0), '待补题目与手动处理（0）');
  assert.equal(luoguMetadataDisclosureLabel(12), '待补题目与手动处理（12）');
  assert.match(luoguMetadataDisclosureLabel(null), /待补题目与手动处理（读取中）/);
  assert.match(LUOGU_METADATA_MANUAL_NOTE, /不使用 AI/);
  assert.match(LUOGU_METADATA_MANUAL_NOTE, /不会拉取整个积压/);
});

void test('paging reads one bounded page and clamps an out-of-range page before it is requested', () => {
  assert.equal(luoguMetadataPageCount(0, 20), 1, 'an empty backlog still has one page');
  assert.equal(luoguMetadataPageCount(20, 20), 1);
  assert.equal(luoguMetadataPageCount(21, 20), 2);
  assert.equal(luoguMetadataPageCount(51, 25), 3);
  assert.equal(clampLuoguMetadataPage(5, 21, 20), 2);
  assert.equal(clampLuoguMetadataPage(0, 21, 20), 1);
  assert.equal(clampLuoguMetadataPage(2, 3, 25), 1);
  assert.equal(luoguMetadataPageSize(25), 25);
  assert.equal(luoguMetadataPageSize(20), 20);
  assert.equal(luoguMetadataPageSize(1000), LUOGU_METADATA_BACKLOG_PAGE_SIZE, 'no whole-queue page size exists');

  assert.deepEqual(luoguMetadataBacklogRequest(ACCOUNT, 9, 20, 21), {
    accountId: ACCOUNT,
    page: 2,
    pageSize: 20,
  });
  assert.deepEqual(luoguMetadataBacklogRequest(ACCOUNT, 3, 25, null), {
    accountId: ACCOUNT,
    page: 3,
    pageSize: 25,
  });
  assert.deepEqual(luoguMetadataBacklogRequest(ACCOUNT, 0, 20, null), {
    accountId: ACCOUNT,
    page: 1,
    pageSize: 20,
  });
  assert.match(luoguMetadataPageLabel(2, 21, 20), /第 2 \/ 2 页/);
  assert.match(luoguMetadataPageLabel(2, 21, 20), /当前待补 21 题/);
  assert.match(luoguMetadataPageLabel(9, 21, 20), /第 2 \/ 2 页/);
});

void test('the three item-scoped retry outcomes stay distinguishable and never claim a whole pass', () => {
  const resolved = luoguMetadataRetryText({ outcome: 'resolved', failureCode: null, reason: null });
  const deferred = luoguMetadataRetryText({
    outcome: 'deferred',
    failureCode: 'changed_response',
    reason: 'missing_statement',
  });
  const failed = luoguMetadataRetryText({ outcome: 'failed', failureCode: 'auth_required', reason: null });
  assert.match(resolved, /已从待补列表移除/);
  assert.match(deferred, /仍留在待补列表/);
  assert.match(deferred, /缺少题面/);
  assert.match(failed, /仍留在待补列表/);
  assert.equal(new Set([resolved, deferred, failed]).size, 3);
  assert.doesNotMatch(deferred, /成功|完成同步/);
  assert.doesNotMatch(failed, /成功|完成同步/);
  assert.doesNotMatch(resolved, /同步成功|平台抓取/);
});

void test('a code-only issue or retry result is explained by its failure code, never by "no reason"', () => {
  // Sprint 30b: records and retry answers written before/without a reason must still be readable.
  const authIssue: LuoguMetadataIssue = {
    problemKey: KEY,
    code: 'auth_required',
    reason: null,
    at: EARLIER,
    attempts: 2,
  };
  const auth = luoguMetadataIssueText(authIssue);
  assert.match(auth, /登录/);
  assert.match(auth, /验证已保存的 Cookie/);
  assert.match(auth, /累计失败 2 次/);
  assert.doesNotMatch(auth, /已经用|再试过一次/, 'a legacy diagnosis cannot prove an authenticated attempt occurred');
  assert.doesNotMatch(auth, /没有可用的原因分类/, 'a known code is not rendered as "no reason"');
  assert.match(auth, /这不等于保存的登录凭据一定过期/, 'the copy states the honest negation, never a claim');
  assert.doesNotMatch(auth, /登录凭据已过期|凭据已失效|一定私有/);

  const forbidden: LuoguMetadataIssue = { problemKey: KEY, code: 'forbidden', reason: null, at: EARLIER, attempts: 1 };
  const refused = luoguMetadataIssueText(forbidden);
  assert.match(refused, /拒绝|访问/);
  assert.doesNotMatch(refused, /登录凭据失效|一定过期/);

  const rateLimited: LuoguMetadataIssue = {
    problemKey: KEY,
    code: 'rate_limited',
    reason: null,
    at: EARLIER,
    attempts: 5,
  };
  assert.match(luoguMetadataIssueText(rateLimited), /限流/);

  // The code+reason pair keeps the reason-specific wording, and `missing_statement` is untouched.
  assert.equal(
    luoguMetadataFailureText('changed_response', 'missing_statement'),
    LUOGU_METADATA_REASON_TEXT.missing_statement,
  );
  assert.equal(luoguMetadataFailureText('auth_required', null), LUOGU_METADATA_CODE_TEXT.auth_required);
  assert.equal(luoguMetadataFailureText(null, null), LUOGU_METADATA_REASON_UNKNOWN_TEXT);
  for (const code of LUOGU_SYNC_FAILURE_CODES) {
    assert.ok(LUOGU_METADATA_CODE_TEXT[code].length > 10, `${code} needs its own actionable sentence`);
  }

  // Retry answers carry the API's `failureCode`: a code-only refusal is still explained.
  const codeOnly = luoguMetadataRetryText({ outcome: 'failed', failureCode: 'auth_required', reason: null });
  assert.match(codeOnly, /登录/);
  assert.match(codeOnly, /仍留在待补列表/);
  const deferred403 = luoguMetadataRetryText({ outcome: 'deferred', failureCode: 'forbidden', reason: null });
  assert.match(deferred403, /访问/);
  assert.doesNotMatch(deferred403, /登录凭据失效/);
  const reasonSpecific = luoguMetadataRetryText({
    outcome: 'deferred',
    failureCode: 'changed_response',
    reason: 'missing_statement',
  });
  assert.match(reasonSpecific, /缺少题面/);
});

void test('the supplement form validates into the exact request payload', () => {
  const missingTitle = luoguSupplementValidation({
    accountId: ACCOUNT,
    item: { problemKey: KEY, title: null, expectedSnapshotId: 'snapshot-7' },
    draft: { title: '   ', statement: '# 题面' },
  });
  assert.equal(missingTitle.ok, false);
  assert.match(missingTitle.ok ? '' : (missingTitle.titleError ?? ''), /真实标题/);
  assert.equal(missingTitle.ok ? '' : missingTitle.statementError, null);

  const missingStatement = luoguSupplementValidation({
    accountId: ACCOUNT,
    item: { problemKey: KEY, title: null, expectedSnapshotId: 'snapshot-7' },
    draft: { title: '标题', statement: '  \n ' },
  });
  assert.equal(missingStatement.ok, false);
  assert.match(missingStatement.ok ? '' : (missingStatement.statementError ?? ''), /真实的题目描述/);

  const ready = luoguSupplementValidation({
    accountId: ACCOUNT,
    item: { problemKey: KEY, title: null, expectedSnapshotId: 'snapshot-7' },
    draft: { title: ' 新标题 ', statement: ' 题面正文 ' },
  });
  assert.equal(ready.ok, true);
  const request = ready.ok ? ready.request : null;
  assert.deepEqual(request, {
    accountId: ACCOUNT,
    problemKey: KEY,
    title: '新标题',
    statement: '题面正文',
    expectedSnapshotId: 'snapshot-7',
  });
  assert.deepEqual(
    Object.keys(request ?? {}).sort(),
    ['accountId', 'expectedSnapshotId', 'problemKey', 'statement', 'title'],
    'the request carries exactly the server contract, no URL, tag, editorial or model field',
  );

  // A stored title is sent back unchanged, so a draft can never overwrite it; a problem with no
  // snapshot sends `null`, which is exactly what the caller saw.
  const stored: LuoguSupplementTarget = { problemKey: KEY, title: '已保存标题', expectedSnapshotId: null };
  const existing = luoguSupplementValidation({
    accountId: ACCOUNT,
    item: stored,
    draft: { title: '另一个标题', statement: '题面' },
  });
  assert.equal(existing.ok, true);
  assert.equal(existing.ok ? existing.request.title : null, '已保存标题');
  assert.equal(existing.ok ? existing.request.expectedSnapshotId : 'x', null);
  assert.match(LUOGU_SUPPLEMENT_AUDIT_NOTE, /不改变通过记录或自动确认标签/);
  assert.match(LUOGU_SUPPLEMENT_AI_NOTE, /不使用 AI/);
});

void test('a refused supplement keeps the draft and a conflict asks for a refresh, never a blind overwrite', () => {
  for (const code of ['conflict', 'settings_changed']) {
    const failure = luoguSupplementErrorText(code);
    assert.equal(failure.keepDraft, true, `${code} must keep the draft`);
    assert.match(failure.message, /刷新待补列表/);
    assert.match(failure.message, /草稿仍然保留/);
    assert.match(failure.message, /不会自动把旧草稿套用到新快照/);
    assert.match(failure.message, /收起并重新打开补充表单/);
    assert.doesNotMatch(failure.message, /expectedSnapshotId|snapshot-7|\{/);
  }
  for (const code of ['cancelled', 'invalid_input', 'unauthorized', 'internal', null, 'network_error']) {
    assert.equal(luoguSupplementErrorText(code).keepDraft, true);
  }
  assert.match(luoguSupplementErrorText('cancelled').message, /刷新待补列表确认最终状态/);
  assert.doesNotMatch(luoguSupplementErrorText('cancelled').message, /没有写入/);
  assert.match(luoguSupplementErrorText('invalid_input').message, /检查标题与题面/);
  assert.doesNotMatch(luoguSupplementErrorText(null).message, /Error|exception|undefined/);
});

void test('every per-item mutation is refused with one readable, state-specific reason', () => {
  assert.equal(luoguMetadataMutationReason(status(), false), null);
  assert.equal(luoguMetadataMutationReason(status({ metadataBacklog: 12 }), false), null);
  assert.match(luoguMetadataMutationReason(status({ running: true }), false) ?? '', /暂停本轮/);
  assert.match(luoguMetadataMutationReason(status({ leaseActive: true }), false) ?? '', /另一个 dsh 实例/);
  assert.match(luoguMetadataMutationReason(status({ closing: true }), false) ?? '', /关闭/);
  assert.match(luoguMetadataMutationReason(null, false) ?? '', /尚未读取/);
  assert.match(luoguMetadataMutationReason(status(), true) ?? '', /上一项操作仍在进行/);
  // A running pass outranks a local lock, but both stay readable and body-free.
  for (const reason of [
    luoguMetadataMutationReason(status({ running: true }), true),
    luoguMetadataMutationReason(status({ leaseActive: true }), true),
  ]) {
    assert.ok((reason ?? '').length > 8);
  }
  assert.match(luoguMetadataRetryErrorText('conflict'), /刷新待补列表/);
  assert.match(luoguMetadataRetryErrorText('cancelled'), /刷新待补列表确认最终状态/);
  assert.doesNotMatch(luoguMetadataRetryErrorText('cancelled'), /没有做任何修改/);
  assert.doesNotMatch(luoguMetadataRetryErrorText(null), /\{|\}|Error|undefined/);
});

void test('a new host failure while the panel is visible is reflected in one short line', () => {
  assert.equal(luoguMetadataHostFailureLine(null), null);
  assert.equal(luoguMetadataHostFailureLine(status()), null);
  const line = luoguMetadataHostFailureLine(
    status({ failure: { code: 'auth_required', at: LATER, retryAt: null, paused: true, stage: 'metadata' } }),
  );
  assert.match(line ?? '', /最近一次同步在补齐题目资料时失败/);
  assert.ok((line ?? '').includes(luoguTime(LATER)));
  assert.match(line ?? '', /逐题重试不会改动同步进度/);
  assert.match(line ?? '', /同步详情/);
  const legacy = luoguMetadataHostFailureLine(
    status({ failure: { code: 'timeout', at: LATER, retryAt: null, paused: false } }),
  );
  assert.doesNotMatch(legacy ?? '', /在读取提交记录时|在补齐题目资料时/, 'a legacy record invents no stage');
});

void test('the start notice is settled only by durable evidence of the run it announced', () => {
  const notice = luoguStartNotice({
    accountId: ACCOUNT,
    outcome: 'started',
    requestedAt: AT,
    lastSuccessAt: AT,
    scanStartedAt: AT,
  });
  assert.equal(notice.runningObserved, false);

  // The initial read may still show the older idle status: that proves nothing and keeps the notice.
  const idle = luoguStartNoticeStep(notice, observation());
  assert.equal(idle.decision, 'keep');
  assert.deepEqual(idle.notice, notice);

  // A failure that was already on screen when the user clicked does not settle the new request.
  assert.equal(luoguStartNoticeStep(notice, observation({ failureAt: EARLIER })).decision, 'keep');
  // An unparsable instant is no evidence either.
  assert.equal(luoguStartNoticeStep(notice, observation({ failureAt: 'not-a-time' })).decision, 'keep');

  // Observed running, then idle: the pass started and ended without success or a named failure.
  const running = luoguStartNoticeStep(notice, observation({ running: true, scanStartedAt: LATER }));
  assert.equal(running.decision, 'observed-running');
  assert.equal(running.notice?.runningObserved, true);
  const ended = luoguStartNoticeStep(running.notice, observation({ scanStartedAt: LATER }));
  assert.equal(ended.decision, 'ended');
  assert.equal(ended.notice, null, 'an ended pass must not keep contradicting the durable state');

  // The durable scan start alone is identity enough: a pass that ran and finished between two reads.
  const betweenReads = luoguStartNoticeStep(notice, observation({ scanStartedAt: LATER }));
  assert.equal(betweenReads.decision, 'ended');
  assert.equal(betweenReads.notice, null);

  // A durable success settles it as succeeded; a failure after the click settles it as failed.
  assert.equal(luoguStartNoticeStep(notice, observation({ lastSuccessAt: LATER })).decision, 'succeeded');
  assert.equal(luoguStartNoticeStep(notice, observation({ failureAt: LATER })).decision, 'failed');
  assert.equal(luoguStartNoticeStep(notice, observation({ failureAt: LATER })).notice, null);
  assert.equal(luoguStartNoticeStep(notice, observation({ lastSuccessAt: LATER })).notice, null);

  // Scope changes drop it instead of carrying it across accounts or past shutdown.
  assert.equal(luoguStartNoticeStep(notice, observation({ accountId: OTHER })).decision, 'account-changed');
  assert.equal(luoguStartNoticeStep(notice, observation({ closing: true })).decision, 'closing');
  assert.equal(luoguStartNoticeStep(null, observation()).decision, 'none');

  // `coalesced` joined a run that is already running: an idle read then means it just ended.
  const coalesced = luoguStartNotice({
    accountId: ACCOUNT,
    outcome: 'coalesced',
    requestedAt: AT,
    lastSuccessAt: AT,
    scanStartedAt: AT,
  });
  assert.equal(coalesced.runningObserved, true);
  assert.equal(luoguStartNoticeStep(coalesced, observation()).decision, 'ended');
  // A queued reservation that has not started yet keeps the notice.
  const queued = luoguStartNotice({
    accountId: ACCOUNT,
    outcome: 'queued',
    requestedAt: AT,
    lastSuccessAt: AT,
    scanStartedAt: AT,
  });
  assert.equal(luoguStartNoticeStep(queued, observation()).decision, 'keep');
});

void test('a refreshed supplement target requires reopening rather than silently rebasing an old draft',async()=>{
 const {luoguSupplementTargetChanged}=await import('../../src/ui/luogu-metadata-view.js');
 const opened={problemKey:'synthetic-key',title:null,expectedSnapshotId:null};
 assert.equal(luoguSupplementTargetChanged(opened,{...opened}),false);
 assert.equal(luoguSupplementTargetChanged(opened,{...opened,expectedSnapshotId:'new-head'}),true);
 assert.equal(luoguSupplementTargetChanged(opened,{...opened,title:'A stored title'}),true);
 assert.equal(luoguSupplementTargetChanged(opened,{...opened,problemKey:'other-key'}),true);
});

void test('supplement validation enforces server title and statement size bounds',()=>{
 const item={problemKey:'synthetic-key',title:null,expectedSnapshotId:null};
 assert.equal(luoguSupplementValidation({accountId:'synthetic',item,draft:{title:'t'.repeat(501),statement:'description'}}).ok,false);
 assert.equal(luoguSupplementValidation({accountId:'synthetic',item,draft:{title:'title',statement:'x'.repeat(200001)}}).ok,false);
 assert.equal(luoguSupplementValidation({accountId:'synthetic',item,draft:{title:'t'.repeat(500),statement:'x'.repeat(200000)}}).ok,true);
});
