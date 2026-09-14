/**
 * View rules of the dedicated Luogu connection/sync panel (Sprint 17d2).
 *
 * These cases drive the pure helpers of `luogu-view.ts` directly: no DOM, no React, no HTTP, no
 * store, no clock and no credential. They pin the externally meaningful guarantees the panel relies
 * on — the status-driven control gating (a running pass, a closing host, an unsupported OS, an
 * unconnected account and a missing full-reconciliation confirmation each disable exactly the right
 * controls and explain why), the memory-only session draft (blank/control-character/oversized values
 * are refused with a fixed sentence that never echoes the draft, and the byte bound is measured in
 * UTF-8 bytes), the compare-and-set settings patch (only changed fields, the read revision always
 * named, the interval bound enforced locally), the poll gate, and the honest separation of history
 * coverage, latest attempt and metadata backlog from any "0 records synced successfully" claim.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_FAILURE_GUIDANCE,
  LUOGU_FAILURE_STAGE_LABELS,
  LUOGU_HISTORY_FAILURE_GUIDANCE,
  LUOGU_HISTORY_STATE_LABELS,
  LUOGU_INTERVAL_MAX_MINUTES,
  LUOGU_INTERVAL_MIN_MINUTES,
  LUOGU_MANUAL_STILL_AVAILABLE,
  LUOGU_METADATA_FAILURE_GUIDANCE,
  LUOGU_METADATA_DRAIN_LABEL,
  LUOGU_METADATA_DRAIN_NOTE,
  LUOGU_METADATA_START_OUTCOMES,
  LUOGU_NO_AI_NOTE,
  LUOGU_ACTION_LABELS,
  LUOGU_POLL_ACTIVE_MS,
  LUOGU_POLL_IDLE_MS,
  LUOGU_RECENT_WINDOW_NOTE,
  LUOGU_START_OUTCOMES,
  LUOGU_AI_CHAT_WARNING,
  LUOGU_CLIENT_ID_HELP,
  LUOGU_CLIENT_ID_INSTRUCTION,
  LUOGU_COOKIE_GUIDE,
  LUOGU_FULL_COOKIE_HELP,
  LUOGU_FULL_COOKIE_TOGGLE,
  LUOGU_SECRET_LOCAL_ONLY_NOTE,
  LUOGU_SECRET_MEMORY_NOTE,
  LUOGU_SECRET_STORAGE_NOTE,
  LUOGU_UID_DISPLAY_NOTE,
  checkLuoguSessionCookie,
  luoguAttemptSummary,
  luoguBacklogSummary,
  luoguCompactSummary,
  luoguControls,
  luoguCredentialActionLabel,
  luoguFailureGuidance,
  luoguHistoryCoverage,
  luoguHistoryCoverageLabel,
  luoguHistoryState,
  luoguLoginCheckSummary,
  luoguNextRunSummary,
  luoguPanelState,
  luoguPollDelayMs,
  luoguPrimaryActionReason,
  luoguProgressSummary,
  luoguSettingsDirty,
  luoguSettingsDraft,
  luoguSettingsEditable,
  luoguSettingsPatch,
  luoguSyncFailureGuidance,
  luoguTime,
  luoguUnsupportedOsNote,
  type LuoguSecretDraft,
} from '../../src/ui/luogu-view.js';
import {
  LUOGU_SYNC_FAILURE_CODES,
  LUOGU_SYNC_INTERVAL_MAX_MINUTES,
  LUOGU_SYNC_INTERVAL_MIN_MINUTES,
  type LuoguSyncFailure,
} from '../../src/application/luogu-sync-types.js';
import { MAX_CREDENTIAL_SECRET_BYTES } from '../../src/application/local-credential-vault.js';
import { MAX_LUOGU_COOKIE_INPUT_BYTES } from '../../src/domain/luogu-session-cookie.js';
import type { ApiLuoguStatusView } from '../../src/application/workbench-api.js';

const AT = '2026-03-01T10:00:00.000Z';
const ACCOUNT = 'luogu:www.luogu.com.cn:800001';

/** One complete status answer, so every case only states the field it is about. */
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

/** The controls of one status with the panel's usual defaults. */
function controls(
  view: ApiLuoguStatusView | null,
  extra: Partial<Parameters<typeof luoguControls>[0]> = {},
): ReturnType<typeof luoguControls> {
  return luoguControls({
    status: view,
    busy: null,
    secretReady: true,
    settingsDirty: false,
    fullConfirmed: false,
    ...extra,
  });
}

void test('the mirrored interval bounds still match the application module', () => {
  assert.equal(LUOGU_INTERVAL_MIN_MINUTES, LUOGU_SYNC_INTERVAL_MIN_MINUTES);
  assert.equal(LUOGU_INTERVAL_MAX_MINUTES, LUOGU_SYNC_INTERVAL_MAX_MINUTES);
  assert.equal(MAX_LUOGU_COOKIE_INPUT_BYTES, 16 * 1024, 'the bounded raw paste is the documented 16 KiB');
  // What storage sees is the *normalized* pair, so even the largest possible one — a 256-character
  // client id and a 20-digit uid — is far below the OS credential blob bound.
  const maximal = `__client_id=${'a'.repeat(256)}; _uid=${'9'.repeat(20)}`;
  assert.ok(new TextEncoder().encode(maximal).length < MAX_CREDENTIAL_SECRET_BYTES);
});

void test('every failure code has its own fixed next-action sentence', () => {
  const sentences = LUOGU_SYNC_FAILURE_CODES.map((code) => LUOGU_FAILURE_GUIDANCE[code]);
  assert.equal(sentences.length, LUOGU_SYNC_FAILURE_CODES.length);
  for (const sentence of sentences) {
    assert.ok(sentence.length > 10, 'every failure needs an actionable sentence');
  }
  assert.equal(new Set(sentences).size, sentences.length, 'two codes must not share one sentence');
  assert.match(LUOGU_FAILURE_GUIDANCE.changed_response, /完整核对|重启/);
  assert.match(LUOGU_FAILURE_GUIDANCE.lease_lost, /实例|稍后/);
});

void test('the panel only reads a status for a selected Luogu account', () => {
  assert.equal(luoguPanelState(false, null), 'no-account');
  assert.equal(luoguPanelState(true, 'codeforces'), 'wrong-platform');
  assert.equal(luoguPanelState(true, 'luogu'), 'ready');
});

/** One session draft in the default two-field mode, so each case states only what it is about. */
function secretDraft(overrides: Partial<LuoguSecretDraft> = {}): LuoguSecretDraft {
  return { mode: 'client_id', selectedUid: '800001', clientId: '', fullCookie: '', ...overrides };
}

void test('the session draft normalizes to the two required cookies and is refused with a fixed sentence', () => {
  assert.deepEqual(checkLuoguSessionCookie(secretDraft()), { state: 'empty', message: null, cookie: null });
  assert.deepEqual(checkLuoguSessionCookie(secretDraft({ mode: 'full_cookie', fullCookie: '   ' })), {
    state: 'empty',
    message: null,
    cookie: null,
  });

  // The default mode takes the __client_id VALUE; the _uid is filled from the selected account.
  const value = checkLuoguSessionCookie(secretDraft({ clientId: 'b7f1c0a94e2d4f6a8c1b3d5e7f901234' }));
  assert.equal(value.state, 'valid');
  assert.equal(value.message, null);
  assert.equal(value.cookie, '__client_id=b7f1c0a94e2d4f6a8c1b3d5e7f901234; _uid=800001');

  // The advanced mode accepts a whole `Cookie:` header line and keeps only the two session cookies.
  const full = checkLuoguSessionCookie(
    secretDraft({ mode: 'full_cookie', fullCookie: 'Cookie: _uid=800001; __client_id=abc; __session=SECRET-MARKER' }),
  );
  assert.equal(full.state, 'valid');
  assert.equal(full.cookie, '__client_id=abc; _uid=800001');

  // A stored/whole header far above the credential blob limit still normalizes to a pair that fits.
  const huge = checkLuoguSessionCookie(
    secretDraft({ mode: 'full_cookie', fullCookie: `_uid=800001; __client_id=abc; __unrelated=${'y'.repeat(3_000)}` }),
  );
  assert.equal(huge.state, 'valid');
  assert.ok(new TextEncoder().encode(huge.cookie ?? '').length < MAX_CREDENTIAL_SECRET_BYTES);

  // The readonly selected account is the only source of the binding: another uid is refused, and so
  // is a draft checked before an account is selected.
  assert.equal(
    checkLuoguSessionCookie(secretDraft({ mode: 'full_cookie', fullCookie: '_uid=800002; __client_id=abc' })).state,
    'invalid',
  );
  assert.equal(checkLuoguSessionCookie(secretDraft({ selectedUid: null, clientId: 'abc' })).state, 'invalid');

  const refused = [
    checkLuoguSessionCookie(secretDraft({ selectedUid: null, clientId: 'abc' })),
    checkLuoguSessionCookie(secretDraft({ clientId: 'SECRET-MARKER;x' })),
    checkLuoguSessionCookie(secretDraft({ clientId: '洛'.repeat(900) })),
    checkLuoguSessionCookie(secretDraft({ clientId: '__client_id=SECRET-MARKER' })),
    checkLuoguSessionCookie(secretDraft({ clientId: 'abc def' })),
    checkLuoguSessionCookie(
      secretDraft({
        mode: 'full_cookie',
        fullCookie: `_uid=800001; __client_id=${'x'.repeat(MAX_LUOGU_COOKIE_INPUT_BYTES)}`,
      }),
    ),
    checkLuoguSessionCookie(secretDraft({ mode: 'full_cookie', fullCookie: '_uid=800001;\n__client_id=SECRET-MARKER' })),
    checkLuoguSessionCookie(secretDraft({ mode: 'full_cookie', fullCookie: '_uid=800001; __session=SECRET-MARKER' })),
    checkLuoguSessionCookie(
      secretDraft({ mode: 'full_cookie', fullCookie: '__client_id=abc; __client_id=def; _uid=800001' }),
    ),
    checkLuoguSessionCookie(secretDraft({ mode: 'full_cookie', fullCookie: '_uid=800001; __client_id=; ' })),
  ];
  for (const check of refused) {
    assert.equal(check.state, 'invalid');
    assert.ok(check.message !== null && check.message.length > 0);
    assert.equal(check.cookie, null, 'an invalid draft never yields a value to submit');
    assert.ok(!check.message.includes('SECRET-MARKER'), 'a refusal never echoes the draft');
    assert.ok(!check.message.includes('800001'), 'a refusal never echoes the uid either');
    assert.ok(!check.message.includes('client_id='), 'a refusal never echoes a pasted pair');
  }
});

void test('the connection controls follow availability, the secret draft and the OS', () => {
  const noSecret = controls(status(), { secretReady: false });
  assert.equal(noSecret.connect.enabled, false);
  assert.match(noSecret.connect.reason ?? '', /粘贴/);

  const unsupported = controls(
    status({ connectionAvailable: false, connectionPlatform: 'linux', connection: null }),
  );
  for (const action of ['connect', 'probe', 'disconnect'] as const) {
    assert.equal(unsupported[action].enabled, false);
    assert.match(unsupported[action].reason ?? '', /linux/);
  }
  // Sync is refused for the real reason (no connection), not by pretending it is available.
  assert.equal(unsupported.start.enabled, false);
  assert.match(unsupported.start.reason ?? '', /尚未连接/);
  assert.match(luoguUnsupportedOsNote('linux'), /linux/);

  const unconnected = controls(status({ connection: null }));
  assert.equal(unconnected.connect.enabled, true);
  assert.equal(unconnected.probe.enabled, false);
  assert.equal(unconnected.disconnect.enabled, false);
  assert.match(unconnected.probe.reason ?? '', /尚未连接/);
});

void test('start, full reconciliation and pause follow the durable status', () => {
  const idle = controls(status());
  assert.equal(idle.start.enabled, true);
  assert.equal(idle.metadata.enabled, false, 'an empty backlog offers nothing to drain');
  assert.match(idle.metadata.reason ?? '', /积压/);
  assert.equal(idle.reconcile.enabled, false);
  assert.match(idle.reconcile.reason ?? '', /勾选确认/);
  assert.equal(controls(status(), { fullConfirmed: true }).reconcile.enabled, true);
  assert.equal(idle.cancel.enabled, false);
  assert.match(idle.cancel.reason ?? '', /没有由本实例运行/);

  const running = controls(status({ running: true, leaseActive: true, pagesInPass: 2 }));
  assert.equal(running.start.enabled, false);
  assert.match(running.start.reason ?? '', /暂停本轮/);
  assert.equal(running.cancel.enabled, true);
  assert.equal(running.metadata.enabled, false, 'a running pass blocks the drain action');
  assert.match(running.metadata.reason ?? '', /暂停本轮/);

  // A live lease of another instance does not block the reservation: the service coalesces or queues
  // it, and the panel reports the returned outcome instead of guessing.
  const leased = controls(status({ leaseActive: true, running: false }));
  assert.equal(leased.start.enabled, true);

  const expired = controls(status({ connection: { ...status().connection!, status: 'session_expired' } }));
  assert.equal(expired.start.enabled, false);
  assert.match(expired.start.reason ?? '', /登录已过期/);

  const closing = controls(status({ closing: true, running: true }));
  for (const action of ['connect', 'probe', 'disconnect', 'start', 'metadata', 'reconcile', 'cancel', 'configure'] as const) {
    assert.equal(closing[action].enabled, false);
    assert.match(closing[action].reason ?? '', /关闭/);
  }
});

void test('the backlog drain action follows the backlog, the connection and a running pass', () => {
  const backlog = controls(status({ metadataBacklog: 12 }));
  assert.equal(backlog.metadata.enabled, true);
  const unconnected = controls(status({ metadataBacklog: 12, connection: null }));
  assert.equal(unconnected.metadata.enabled, false);
  assert.match(unconnected.metadata.reason ?? '', /尚未连接/);
  assert.equal(controls(status({ metadataBacklog: 12 }), { busy: 'metadata' }).metadata.enabled, false);
  assert.match(controls(status({ metadataBacklog: 12 }), { busy: 'metadata' }).metadata.reason ?? '', /仍在进行/);
});

void test('the backlog drain copy states the batch, pacing, background and no-AI facts', () => {
  assert.equal(LUOGU_METADATA_DRAIN_LABEL, '补齐全部积压资料（不使用 AI）');
  assert.equal(LUOGU_ACTION_LABELS.metadata, '补齐积压资料');
  assert.equal(
    LUOGU_NO_AI_NOTE,
    '洛谷同步直接读取洛谷平台数据，不调用 AI 模型，也不消耗 AI 额度。',
    'the note states platform data, never the authenticated history as a public interface',
  );
  assert.match(LUOGU_METADATA_DRAIN_NOTE, /100 条/);
  assert.match(LUOGU_METADATA_DRAIN_NOTE, /2 秒/);
  assert.match(LUOGU_METADATA_DRAIN_NOTE, /几十分钟/);
  assert.match(LUOGU_METADATA_DRAIN_NOTE, /不使用 AI/);
  assert.match(LUOGU_METADATA_DRAIN_NOTE, /保持运行/);
  assert.match(LUOGU_METADATA_DRAIN_NOTE, /不读取提交历史/);
  assert.match(LUOGU_METADATA_DRAIN_NOTE, /每题只尝试一次/);
  assert.deepEqual(Object.keys(LUOGU_METADATA_START_OUTCOMES).sort(), ['coalesced', 'queued', 'started']);
});

void test('one host action at a time and a missing status disable everything with a reason', () => {
  const busy = controls(status(), { busy: 'start', settingsDirty: true, fullConfirmed: true });
  for (const action of ['connect', 'probe', 'disconnect', 'start', 'metadata', 'reconcile', 'cancel', 'configure'] as const) {
    assert.equal(busy[action].enabled, false);
    assert.match(busy[action].reason ?? '', /仍在进行/);
  }
  const unread = controls(null);
  for (const action of ['connect', 'start', 'configure'] as const) {
    assert.equal(unread[action].enabled, false);
    assert.match(unread[action].reason ?? '', /尚未读取/);
  }
  assert.equal(controls(status({ settings: { ...status().settings, automaticEnabled: true } })).configure.enabled, false);
  assert.equal(controls(status(), { settingsDirty: true }).configure.enabled, true);
});

void test('the settings patch names the read revision and only the changed fields', () => {
  const view = status();
  const draft = luoguSettingsDraft(view.settings);
  assert.deepEqual(draft, { automaticEnabled: false, runOnStartup: true, intervalMinutes: '30' });
  assert.equal(luoguSettingsDirty(view, draft), false);

  assert.deepEqual(luoguSettingsPatch(view, { ...draft, automaticEnabled: true }), {
    ok: true,
    request: { accountId: ACCOUNT, expectedRevision: 4, automaticEnabled: true },
  });
  assert.deepEqual(luoguSettingsPatch(view, { ...draft, intervalMinutes: '60' }), {
    ok: true,
    request: { accountId: ACCOUNT, expectedRevision: 4, intervalMinutes: 60 },
  });
  assert.deepEqual(luoguSettingsPatch(status({ settingsRevision: null }), { ...draft, runOnStartup: false }), {
    ok: true,
    request: { accountId: ACCOUNT, expectedRevision: null, runOnStartup: false },
  });

  assert.equal(luoguSettingsPatch(view, draft).ok, false);
  const unchanged = luoguSettingsPatch(view, draft);
  assert.match(unchanged.ok ? '' : unchanged.message, /没有变化/);
  for (const intervalMinutes of ['', 'abc', '4', '1441', '10.5', '-5']) {
    const refused = luoguSettingsPatch(view, { ...draft, intervalMinutes });
    assert.equal(refused.ok, false, `${intervalMinutes} must be refused`);
    assert.match(refused.ok ? '' : refused.message, /5–1440/);
    assert.equal(luoguSettingsDirty(view, { ...draft, intervalMinutes }), false, 'an unusable draft is not "dirty"');
  }
  assert.equal(luoguSettingsPatch(view, { ...draft, intervalMinutes: '5' }).ok, true);
  assert.equal(luoguSettingsPatch(view, { ...draft, intervalMinutes: '1440' }).ok, true);
});

void test('polling stops unless something can actually change', () => {
  assert.equal(luoguPollDelayMs(null, false), null);
  assert.equal(luoguPollDelayMs(status(), false), null);
  assert.equal(luoguPollDelayMs(status({ running: true }), false), LUOGU_POLL_ACTIVE_MS);
  assert.equal(luoguPollDelayMs(status({ leaseActive: true }), false), LUOGU_POLL_ACTIVE_MS);
  assert.equal(luoguPollDelayMs(null, true), LUOGU_POLL_ACTIVE_MS);
  assert.equal(luoguPollDelayMs(status({ closing: true }), true), LUOGU_POLL_ACTIVE_MS);
  assert.equal(
    luoguPollDelayMs(status({ settings: { ...status().settings, automaticEnabled: true } }), false),
    LUOGU_POLL_IDLE_MS,
  );
  assert.equal(luoguPollDelayMs(status({ closing: true }), false), null);
});

void test('coverage, latest attempt and backlog stay three separate honest answers', () => {
  const never = status({
    phase: 'backfill',
    historyComplete: false,
    historyCompletedAt: null,
    lastSuccessAt: null,
    scanStartedAt: null,
    lastScanStartedAt: null,
    pagesInPass: 0,
    totalPages: 0,
    submissionsSeen: 0,
    metadataResolved: 0,
  });
  assert.match(luoguHistoryCoverage(never), /尚未开始历史回溯/);
  assert.match(luoguHistoryCoverage(never), /尚未同步记录/);
  assert.doesNotMatch(luoguHistoryCoverage(never), /只覆盖最近窗口|已提交 \d+ 页/);
  assert.equal(luoguHistoryState(never), 'never');
  assert.equal(luoguHistoryCoverageLabel(never), LUOGU_HISTORY_STATE_LABELS.never);
  assert.match(luoguAttemptSummary(never), /还没有完成过一次同步/);
  assert.doesNotMatch(luoguAttemptSummary(never), /成功完成/);
  assert.match(luoguProgressSummary(never), /尚未同步记录/);
  // The processed-rows disclaimer belongs to the accounts that actually report counters.
  assert.match(luoguProgressSummary(status()), /不代表新增提交或新增通过/);
  assert.match(luoguProgressSummary(status()), /含重复核对/);

  const reconciling = status({ phase: 'reconcile', historyComplete: false, historyCompletedAt: null });
  assert.equal(luoguHistoryState(reconciling), 'reconcile');
  assert.match(luoguHistoryCoverage(reconciling), /全历史核对未完成/);
  assert.match(luoguHistoryCoverage(status()), /已完成一次全历史核对/);
  // Any other incomplete status is the unfinished-backfill fallback: it never invents coverage.
  const unexplained = status({ phase: 'incremental', historyComplete: false, historyCompletedAt: null });
  assert.equal(luoguHistoryState(unexplained), 'backfill');
  assert.match(luoguHistoryCoverage(unexplained), /历史回溯未完成/);
  assert.doesNotMatch(luoguHistoryCoverage(unexplained), /只覆盖最近窗口|最近窗口的增量记录/);

  const paused = status({
    failure: { code: 'auth_required', at: AT, retryAt: null, paused: true },
  });
  assert.match(luoguAttemptSummary(paused), /失败/);
  assert.match(luoguAttemptSummary(paused), /已暂停/);
  assert.match(luoguAttemptSummary(status({ failure: { code: 'rate_limited', at: AT, retryAt: AT, paused: false } })), /计划重试/);

  assert.match(luoguBacklogSummary(status()), /没有积压/);
  assert.match(luoguBacklogSummary(status()), /待补题目资料/);
  assert.doesNotMatch(luoguBacklogSummary(status({ metadataBacklog: 12 })), /元数据/);
  assert.match(luoguBacklogSummary(status({ metadataBacklog: 12 })), /12 题待补/);
  assert.match(luoguBacklogSummary(status({ metadataBacklog: 2000, metadataBacklogFull: true })), /上限/);
  assert.match(luoguBacklogSummary(status({ metadataBacklog: 2000, metadataBacklogFull: true })), /避免丢掉题目键/);

  // An unread status never claims a number of synced records.
  for (const text of [luoguHistoryCoverage(null), luoguAttemptSummary(null), luoguBacklogSummary(null), luoguProgressSummary(null)]) {
    assert.match(text, /尚未读取/);
    assert.doesNotMatch(text, /\d/);
  }
  assert.match(luoguNextRunSummary(null), /尚未读取/);
  assert.match(luoguNextRunSummary(status()), /未开启/);
  assert.match(
    luoguNextRunSummary(status({ settings: { ...status().settings, automaticEnabled: true }, nextRunAt: AT })),
    /只在 dsh 打开时运行/,
  );
  assert.match(
    luoguNextRunSummary(status({ settings: { ...status().settings, automaticEnabled: true }, failure: { code: 'auth_required', at: AT, retryAt: null, paused: true } })),
    /已暂停/,
  );
  assert.match(luoguNextRunSummary(status({ closing: true })), /正在关闭/);

  assert.equal(luoguTime(null), '尚未记录');
  assert.equal(luoguTime('not-a-time'), '时间无法识别');
  assert.ok(luoguTime(AT).length > 0);
  assert.doesNotMatch(LUOGU_START_OUTCOMES.started, /完成$/);
  assert.match(LUOGU_START_OUTCOMES.queued, /排队/);
});

void test('a never-synced account is never shown as a covered window', () => {
  // The exact live shape: nothing was ever scanned, yet the durable phase still says `backfill`.
  const untouched = status({
    phase: 'backfill',
    historyComplete: false,
    historyCompletedAt: null,
    resumePending: false,
    scanStartedAt: null,
    lastScanStartedAt: null,
    lastSuccessAt: null,
    pagesInPass: 0,
    totalPages: 0,
    submissionsSeen: 0,
  });
  assert.equal(luoguHistoryState(untouched), 'never');
  assert.equal(luoguHistoryCoverageLabel(untouched), '尚未开始历史回溯');
  assert.match(luoguHistoryCoverage(untouched), /尚未同步记录/);
  assert.match(luoguHistoryCoverage(untouched), /尚未开始历史回溯/);
  assert.doesNotMatch(luoguHistoryCoverage(untouched), /只覆盖最近窗口|已提交 \d+ 页/);
  assert.match(luoguProgressSummary(untouched), /尚未同步记录/);
  assert.doesNotMatch(luoguProgressSummary(untouched), /本轮已提交/);
  assert.equal(luoguHistoryCoverageLabel(null), '尚未读取');

  // A partial backfill names its committed progress and continues from its stored checkpoint.
  const partial = status({
    phase: 'backfill',
    historyComplete: false,
    historyCompletedAt: null,
    resumePending: true,
    scanStartedAt: AT,
    lastScanStartedAt: null,
    lastSuccessAt: null,
    pagesInPass: 0,
    totalPages: 20,
    submissionsSeen: 1000,
  });
  assert.equal(luoguHistoryState(partial), 'backfill');
  assert.equal(luoguHistoryCoverageLabel(partial), LUOGU_HISTORY_STATE_LABELS.backfill);
  assert.match(luoguHistoryCoverage(partial), /历史回溯未完成（已提交 20 页、处理 1000 条记录）/);
  assert.match(luoguHistoryCoverage(partial), /已保存的检查点/);
  assert.match(luoguProgressSummary(partial), /有可以继续的进度/);

  // Only a finished whole-history pass may claim a covered window, and it names its instant.
  const complete = status();
  assert.equal(luoguHistoryState(complete), 'complete');
  assert.equal(luoguHistoryCoverageLabel(complete), `完整核对已完成（${luoguTime(AT)}）`);
  assert.match(luoguHistoryCoverage(complete), /已完成一次全历史核对/);
  assert.ok(luoguHistoryCoverage(complete).includes(luoguTime(AT)));
});

void test('the panel guides the user without teaching them to handcraft a session', () => {
  const guide = LUOGU_COOKIE_GUIDE.join('\n');
  assert.match(guide, /_uid/);
  assert.match(guide, /__client_id/);
  // The default path names the exact column and the exact screen it is on.
  assert.match(guide, /Value/);
  assert.match(guide, /Application/);
  assert.match(guide, /Cookies/);
  assert.match(LUOGU_CLIENT_ID_HELP, /Value（值）/);
  assert.match(LUOGU_CLIENT_ID_HELP, /不要复制 Name/);
  // The readonly `_uid` is explained as the account's own numeric UID, not as a field to fill in.
  assert.match(LUOGU_UID_DISPLAY_NOTE, /数字 UID/);
  assert.match(LUOGU_UID_DISPLAY_NOTE, /只读/);
  assert.match(LUOGU_UID_DISPLAY_NOTE, /不能手工修改/);
  // The advanced whole-Cookie paste is offered as compatibility, not as a way to pass a challenge.
  assert.match(LUOGU_FULL_COOKIE_TOGGLE, /高级/);
  assert.match(LUOGU_FULL_COOKIE_HELP, /整段 Cookie/);
  assert.match(LUOGU_FULL_COOKIE_HELP, /只保留 __client_id 与 _uid 两项/);
  assert.doesNotMatch(LUOGU_FULL_COOKIE_HELP, /就能通过|一定能|可以解决/);
  assert.match(LUOGU_SECRET_MEMORY_NOTE, /内存/);
  assert.match(LUOGU_AI_CHAT_WARNING, /AI 对话/);
  assert.match(LUOGU_SECRET_STORAGE_NOTE, /Windows 凭据管理器/);
  assert.match(LUOGU_SECRET_STORAGE_NOTE, /localStorage/);
  assert.match(LUOGU_SECRET_STORAGE_NOTE, /只保留 __client_id 与 _uid 两项/);
  // 「开始 / 继续同步」is described as backfill-first, not as an always-incremental scan.
  assert.match(LUOGU_RECENT_WINDOW_NOTE, /先补齐历史/);
  assert.match(LUOGU_RECENT_WINDOW_NOTE, /全历史扫描完成后才转入最近窗口增量/);
  assert.match(LUOGU_MANUAL_STILL_AVAILABLE, /本页的 JSON \/ CSV/);
  assert.doesNotMatch(LUOGU_MANUAL_STILL_AVAILABLE, /上面/);
});

void test('a failure is explained by the half of the pass that failed, and a legacy record stays neutral', () => {
  const metadataFailure: LuoguSyncFailure = {
    code: 'auth_required',
    at: AT,
    retryAt: null,
    paused: true,
    stage: 'metadata',
  };
  const metadata = status({ failure: metadataFailure });
  const metadataAdvice = luoguSyncFailureGuidance(metadataFailure);
  assert.equal(metadataAdvice, LUOGU_METADATA_FAILURE_GUIDANCE.auth_required);
  assert.match(metadataAdvice, /补齐题目资料/);
  assert.match(metadataAdvice, /不代表保存的登录凭据已过期/);
  assert.doesNotMatch(metadataAdvice, /登录凭据已失效/);
  assert.match(luoguAttemptSummary(metadata), /在补齐题目资料时失败/);
  assert.match(luoguAttemptSummary(metadata), /待补题目资料|继续排队/);
  assert.doesNotMatch(luoguAttemptSummary(metadata), /成功完成/);
  const automatedMetadata = {
    ...metadata,
    settings: { ...metadata.settings, automaticEnabled: true },
  };
  assert.match(luoguNextRunSummary(automatedMetadata), /已暂停/);
  assert.match(luoguNextRunSummary(automatedMetadata), /补齐题目资料/);

  const historyFailure: LuoguSyncFailure = { ...metadataFailure, stage: 'history' };
  const history = status({ failure: historyFailure });
  assert.equal(luoguSyncFailureGuidance(historyFailure), LUOGU_HISTORY_FAILURE_GUIDANCE.auth_required);
  assert.match(luoguSyncFailureGuidance(historyFailure), /读取提交记录/);
  assert.match(luoguSyncFailureGuidance(historyFailure), /检查登录/);
  assert.match(luoguAttemptSummary(history), /在读取提交记录时失败/);
  assert.match(
    luoguNextRunSummary({ ...history, settings: { ...history.settings, automaticEnabled: true } }),
    /读取提交记录/,
  );

  // A record from before the stage existed: neutral wording, a login check suggested, no expiry
  // claim, and no stage invented in the rendered summary.
  const legacyFailure: LuoguSyncFailure = { code: 'auth_required', at: AT, retryAt: null, paused: true };
  const legacy = status({ failure: legacyFailure });
  const legacyAdvice = luoguSyncFailureGuidance(legacyFailure);
  assert.equal(legacyAdvice, LUOGU_FAILURE_GUIDANCE.auth_required);
  assert.match(legacyAdvice, /检查登录/);
  assert.doesNotMatch(legacyAdvice, /失效|过期/);
  assert.match(luoguAttemptSummary(legacy), /失败/);
  assert.match(luoguAttemptSummary(legacy), /检查登录/);
  assert.doesNotMatch(
    luoguAttemptSummary(legacy),
    /在读取提交记录时|在补齐题目资料时/,
    'no stage is invented for a legacy record',
  );
  assert.match(
    luoguNextRunSummary({ ...legacy, settings: { ...legacy.settings, automaticEnabled: true } }),
    /检查登录/,
  );

  // The stage-aware helper covers every code: a stage-specific sentence wins where one exists, and
  // anything else falls back to the stage-free sentence that is already accurate for it.
  assert.equal(
    luoguSyncFailureGuidance({ ...metadataFailure, code: 'rate_limited', paused: false, retryAt: AT }),
    LUOGU_FAILURE_GUIDANCE.rate_limited,
  );
  assert.equal(luoguSyncFailureGuidance(null), null);
  assert.equal(luoguFailureGuidance(null), null);
  assert.deepEqual(LUOGU_FAILURE_STAGE_LABELS, { history: '读取提交记录', metadata: '补齐题目资料' });
});

void test('a successful probe after a sync failure is a current login check, never a successful sync', () => {
  const failure: LuoguSyncFailure = {
    code: 'auth_required',
    at: AT,
    retryAt: null,
    paused: true,
    stage: 'metadata',
  };
  const later = '2026-03-01T11:00:00.000Z';
  const afterProbe = status({
    failure,
    connection: { status: 'connected', connectedAt: AT, checkedAt: later, failureCode: null, cleanupPending: false },
  });
  const check = luoguLoginCheckSummary(afterProbe);
  assert.ok(check !== null);
  assert.match(check, /检查成功/);
  assert.match(check, /最近一次同步/);
  assert.match(check, /仍然失败/);
  assert.match(check, /不代表同步成功/);
  assert.match(luoguAttemptSummary(afterProbe), /失败/);
  assert.doesNotMatch(luoguAttemptSummary(afterProbe), /成功完成/);

  // Nothing honest to add: no failure, no connection, a failing connection or an older check.
  assert.equal(luoguLoginCheckSummary(status({ connection: { ...status().connection!, checkedAt: later } })), null);
  assert.equal(luoguLoginCheckSummary(status({ failure, connection: null })), null);
  assert.equal(
    luoguLoginCheckSummary(status({ failure, connection: { ...status().connection!, status: 'session_expired' } })),
    null,
  );
  assert.equal(
    luoguLoginCheckSummary(status({ failure, connection: { ...status().connection!, checkedAt: AT } })),
    null,
  );
  assert.equal(luoguLoginCheckSummary(null), null);
});

void test('the collapsed card states the same facts as the expanded sections', () => {
  const unread = luoguCompactSummary(null);
  for (const claim of [unread.connection, unread.history, unread.backlog, unread.automation]) {
    assert.match(claim, /尚未读取/);
  }
  assert.equal(unread.checkedAt, null);
  assert.equal(unread.alert, null);

  const view = status();
  const compact = luoguCompactSummary(view);
  assert.equal(compact.connection, '已连接');
  assert.equal(compact.checkedAt, luoguTime(AT));
  assert.equal(compact.history, luoguHistoryCoverageLabel(view), 'the compact claim is the expanded label');
  assert.equal(compact.backlog, '资料无积压');
  assert.equal(compact.automation, '自动同步：未开启');
  assert.equal(compact.alert, null, 'a successful latest attempt needs no alert');
  assert.equal(luoguCompactSummary(status({ connection: null })).checkedAt, null);

  // A never-synced account claims exactly the same "not yet" its label does; no completed state is
  // invented by the compact view.
  const untouched = status({
    phase: 'backfill',
    historyComplete: false,
    historyCompletedAt: null,
    resumePending: false,
    scanStartedAt: null,
    lastScanStartedAt: null,
    lastSuccessAt: null,
    totalPages: 0,
    submissionsSeen: 0,
  });
  assert.equal(luoguCompactSummary(untouched).history, LUOGU_HISTORY_STATE_LABELS.never);
  assert.doesNotMatch(luoguCompactSummary(untouched).history, /已完成/);

  // Backlog and backpressure stay stated, never silently zeroed.
  assert.equal(luoguCompactSummary(status({ metadataBacklog: 12 })).backlog, '资料积压 12 题');
  assert.match(
    luoguCompactSummary(status({ metadataBacklog: 2000, metadataBacklogFull: true })).backlog,
    /已达上限/,
  );

  // Automation keeps the next planned instant when there is one, and says "closing" while closing.
  const automated = status({ settings: { ...status().settings, automaticEnabled: true }, nextRunAt: AT });
  assert.match(luoguCompactSummary(automated).automation, /已开启/);
  assert.ok(luoguCompactSummary(automated).automation.includes(luoguTime(AT)));
  assert.equal(luoguCompactSummary(status({ closing: true })).automation, '自动同步：关闭中');
  assert.equal(
    luoguCompactSummary(
      status({ settings: { ...status().settings, automaticEnabled: true }, failure: { code: 'auth_required', at: AT, retryAt: null, paused: true } }),
    ).automation,
    '自动同步：已暂停',
  );
});

void test('a failed latest attempt gets one short sentence, never a second copy of the long advice', () => {
  const metadataFailure: LuoguSyncFailure = {
    code: 'auth_required',
    at: AT,
    retryAt: null,
    paused: true,
    stage: 'metadata',
  };
  const paused = luoguCompactSummary(status({ settings: { ...status().settings, automaticEnabled: true }, failure: metadataFailure }));
  assert.ok(paused.alert !== null);
  assert.match(paused.alert, /在补齐题目资料时失败/);
  assert.match(paused.alert, /已暂停/);
  assert.match(paused.alert, /同步详情/);
  const advice = luoguSyncFailureGuidance(metadataFailure);
  assert.ok(!paused.alert.includes(advice), 'the long stage-aware advice is rendered once, in 同步详情');
  assert.ok(advice.length > paused.alert.length);

  const retrying = luoguCompactSummary(
    status({ settings: { ...status().settings, automaticEnabled: true }, failure: { ...metadataFailure, paused: false, retryAt: AT } }),
  );
  assert.match(retrying.alert ?? '', /重试/);
  assert.match(retrying.alert ?? '', /同步详情/);

  // A legacy record without a stage keeps the neutral wording and never invents a half.
  const legacy = luoguCompactSummary(
    status({ failure: { code: 'timeout', at: AT, retryAt: null, paused: false } }),
  );
  assert.match(legacy.alert ?? '', /^最近一次同步失败/);
  assert.doesNotMatch(legacy.alert ?? '', /在读取提交记录时|在补齐题目资料时/);
});

void test('there is one credential trigger: connect first, update the saved session later', () => {
  assert.equal(luoguCredentialActionLabel(null), '连接洛谷');
  assert.equal(luoguCredentialActionLabel(status({ connection: null })), '连接洛谷');
  assert.equal(luoguCredentialActionLabel(status()), '更新登录凭据');
  assert.equal(
    luoguCredentialActionLabel(status({ connection: { ...status().connection!, status: 'session_expired' } })),
    '更新登录凭据',
  );
  // The revealed form stays short: one exact instruction line and one local-only note are its copy.
  assert.match(LUOGU_CLIENT_ID_INSTRUCTION, /F12/);
  assert.match(LUOGU_CLIENT_ID_INSTRUCTION, /Application/);
  assert.match(LUOGU_CLIENT_ID_INSTRUCTION, /Value/);
  assert.match(LUOGU_SECRET_LOCAL_ONLY_NOTE, /Windows 凭据管理器/);
  assert.match(LUOGU_SECRET_LOCAL_ONLY_NOTE, /AI 请求/);
});

void test('unchanged automatic-sync settings stay editable while saving still needs a change', () => {
  const view = status();
  const draft = luoguSettingsDraft(view.settings);
  // The regression this fixes: `configure` is enabled only *by* a dirty draft, so gating the fields
  // on it (the old `!controls.configure.enabled && !settingsDirty`) disabled every toggle before the
  // user could make the first change.
  assert.equal(controls(view).configure.enabled, false, 'an unchanged draft cannot be saved');
  assert.equal(luoguSettingsDirty(view, draft), false);
  assert.equal(
    !controls(view).configure.enabled && !luoguSettingsDirty(view, draft),
    true,
    'the old gate locked an untouched form',
  );
  assert.equal(luoguSettingsEditable(view, false), true, 'an untouched form is editable');

  // Only a real host lock disables the fields, and editing is what enables saving.
  assert.equal(luoguSettingsEditable(view, true), false);
  assert.equal(luoguSettingsEditable(status({ closing: true }), false), false);
  assert.equal(luoguSettingsEditable(null, false), false);
  assert.equal(controls(view, { settingsDirty: true }).configure.enabled, true);
});

void test('the primary action repeats a reason only when the user can act on it', () => {
  const unconnected = status({ connection: null });
  const unconnectedControls = controls(unconnected);
  assert.equal(
    luoguPrimaryActionReason(unconnected, unconnectedControls.start, false),
    unconnectedControls.start.reason,
  );
  assert.match(luoguPrimaryActionReason(unconnected, unconnectedControls.start, false) ?? '', /尚未连接/);

  const closing = status({ closing: true });
  assert.match(luoguPrimaryActionReason(closing, controls(closing).start, false) ?? '', /关闭/);

  // While this instance runs,「暂停本轮」next to it is the action: no repeated "running" reason.
  const running = status({ running: true, leaseActive: true, pagesInPass: 2 });
  assert.equal(controls(running).start.enabled, false);
  assert.equal(luoguPrimaryActionReason(running, controls(running).start, false), null);
  // While an action is in flight every control is denied anyway, so nothing is printed either.
  assert.equal(luoguPrimaryActionReason(status(), controls(null).start, true), null);
  assert.equal(luoguPrimaryActionReason(status(), controls(status()).start, false), null);
  assert.equal(luoguPrimaryActionReason(null, controls(null).connect, false), null);
});

void test('disabled automation keeps a failed sync visible without promising a scheduled retry', () => {
  for (const paused of [false, true]) {
    const summary = luoguCompactSummary(status({
      settings: { ...status().settings, automaticEnabled: false },
      failure: { code: 'timeout', at: AT, retryAt: paused ? null : AT, paused },
    }));
    assert.equal(summary.automation, '自动同步：未开启');
    assert.match(summary.alert ?? '', /失败.*手动继续/);
    assert.doesNotMatch(summary.alert ?? '', /自动同步已暂停|计划.*重试/);
  }
});
