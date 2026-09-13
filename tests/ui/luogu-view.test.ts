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
  LUOGU_HISTORY_STATE_LABELS,
  LUOGU_INTERVAL_MAX_MINUTES,
  LUOGU_INTERVAL_MIN_MINUTES,
  LUOGU_MANUAL_STILL_AVAILABLE,
  LUOGU_POLL_ACTIVE_MS,
  LUOGU_POLL_IDLE_MS,
  LUOGU_RECENT_WINDOW_NOTE,
  LUOGU_SECRET_MAX_BYTES,
  LUOGU_START_OUTCOMES,
  LUOGU_AI_CHAT_WARNING,
  LUOGU_COOKIE_GUIDE,
  LUOGU_SECRET_STORAGE_NOTE,
  checkLuoguSessionCookie,
  luoguAttemptSummary,
  luoguBacklogSummary,
  luoguControls,
  luoguHistoryCoverage,
  luoguHistoryCoverageLabel,
  luoguHistoryState,
  luoguNextRunSummary,
  luoguPanelState,
  luoguPollDelayMs,
  luoguProgressSummary,
  luoguSettingsDirty,
  luoguSettingsDraft,
  luoguSettingsPatch,
  luoguTime,
  luoguUnsupportedOsNote,
} from '../../src/ui/luogu-view.js';
import {
  LUOGU_SYNC_FAILURE_CODES,
  LUOGU_SYNC_INTERVAL_MAX_MINUTES,
  LUOGU_SYNC_INTERVAL_MIN_MINUTES,
} from '../../src/application/luogu-sync-types.js';
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
  assert.equal(LUOGU_SECRET_MAX_BYTES, 2560, 'the OS credential blob bound is the documented one');
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

void test('the session draft stays memory-only and is refused with a fixed sentence', () => {
  assert.deepEqual(checkLuoguSessionCookie(''), { state: 'empty', message: null });
  assert.deepEqual(checkLuoguSessionCookie('   '), { state: 'empty', message: null });
  assert.equal(checkLuoguSessionCookie('_uid=800001; __client_id=abc').state, 'valid');
  assert.equal(checkLuoguSessionCookie('x'.repeat(LUOGU_SECRET_MAX_BYTES)).state, 'valid');

  const draft = '_uid=800001; __client_id=SECRET-MARKER';
  const tooManyBytes = draft + 'x'.repeat(LUOGU_SECRET_MAX_BYTES);
  const refused = [
    checkLuoguSessionCookie(tooManyBytes),
    checkLuoguSessionCookie('_uid=800001;\n__client_id=secret'),
    checkLuoguSessionCookie('_uid=800001;\u0000__client_id=secret'),
  ];
  for (const check of refused) {
    assert.equal(check.state, 'invalid');
    assert.ok(check.message !== null && check.message.length > 0);
    assert.ok(!check.message.includes('SECRET-MARKER'), 'a refusal never echoes the draft');
    assert.ok(!check.message.includes('800001'), 'a refusal never echoes the draft');
  }
  // Bytes, not characters: a 900-character multibyte value exceeds the 2560-byte blob cap.
  assert.equal(checkLuoguSessionCookie('洛'.repeat(900)).state, 'invalid');
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
  assert.equal(idle.reconcile.enabled, false);
  assert.match(idle.reconcile.reason ?? '', /勾选确认/);
  assert.equal(controls(status(), { fullConfirmed: true }).reconcile.enabled, true);
  assert.equal(idle.cancel.enabled, false);
  assert.match(idle.cancel.reason ?? '', /没有由本实例运行/);

  const running = controls(status({ running: true, leaseActive: true, pagesInPass: 2 }));
  assert.equal(running.start.enabled, false);
  assert.match(running.start.reason ?? '', /暂停本轮/);
  assert.equal(running.cancel.enabled, true);

  // A live lease of another instance does not block the reservation: the service coalesces or queues
  // it, and the panel reports the returned outcome instead of guessing.
  const leased = controls(status({ leaseActive: true, running: false }));
  assert.equal(leased.start.enabled, true);

  const expired = controls(status({ connection: { ...status().connection!, status: 'session_expired' } }));
  assert.equal(expired.start.enabled, false);
  assert.match(expired.start.reason ?? '', /登录已过期/);

  const closing = controls(status({ closing: true, running: true }));
  for (const action of ['connect', 'probe', 'disconnect', 'start', 'reconcile', 'cancel', 'configure'] as const) {
    assert.equal(closing[action].enabled, false);
    assert.match(closing[action].reason ?? '', /关闭/);
  }
});

void test('one host action at a time and a missing status disable everything with a reason', () => {
  const busy = controls(status(), { busy: 'start', settingsDirty: true, fullConfirmed: true });
  for (const action of ['connect', 'probe', 'disconnect', 'start', 'reconcile', 'cancel', 'configure'] as const) {
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
  assert.match(guide, /完整值/);
  // The guide names the label the panel actually renders, suffix included.
  assert.match(guide, /登录凭据（Cookie 值，只在本机使用）/);
  assert.match(LUOGU_AI_CHAT_WARNING, /AI 对话/);
  assert.match(LUOGU_SECRET_STORAGE_NOTE, /Windows 凭据管理器/);
  assert.match(LUOGU_SECRET_STORAGE_NOTE, /localStorage/);
  // 「开始 / 继续同步」is described as backfill-first, not as an always-incremental scan.
  assert.match(LUOGU_RECENT_WINDOW_NOTE, /先补齐历史/);
  assert.match(LUOGU_RECENT_WINDOW_NOTE, /全历史扫描完成后才转入最近窗口增量/);
  assert.match(LUOGU_MANUAL_STILL_AVAILABLE, /本页的 JSON \/ CSV/);
  assert.doesNotMatch(LUOGU_MANUAL_STILL_AVAILABLE, /上面/);
});
