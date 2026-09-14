import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.js';
import {
  Empty,
  ErrorNotice,
  Notice,
  Stats,
  useAction,
  usePollAfterSettle,
  useRequest,
  useWorkbench,
} from './common.js';
import {
  LUOGU_AC_EVIDENCE_NOTE,
  LUOGU_AI_CHAT_WARNING,
  LUOGU_AUTOMATION_NOTE,
  LUOGU_CLIENT_ID_HELP,
  LUOGU_COOKIE_GUIDE,
  LUOGU_DISCONNECT_NOTE,
  LUOGU_FULL_COOKIE_HELP,
  LUOGU_FULL_COOKIE_TOGGLE,
  LUOGU_INTERVAL_MAX_MINUTES,
  LUOGU_INTERVAL_MIN_MINUTES,
  LUOGU_MANUAL_STILL_AVAILABLE,
  LUOGU_PHASE_LABELS,
  LUOGU_POLL_IDLE_MS,
  LUOGU_RECENT_WINDOW_NOTE,
  LUOGU_SECRET_MEMORY_NOTE,
  LUOGU_SECRET_STORAGE_NOTE,
  LUOGU_START_OUTCOMES,
  LUOGU_UID_DISPLAY_NOTE,
  checkLuoguSessionCookie,
  luoguAttemptSummary,
  luoguBacklogSummary,
  luoguConnectionText,
  luoguControls,
  luoguFailureGuidance,
  luoguHistoryCoverage,
  luoguHistoryCoverageLabel,
  luoguLoginCheckSummary,
  luoguNextRunSummary,
  luoguPanelState,
  luoguPollDelayMs,
  luoguProgressSummary,
  luoguSettingsDirty,
  luoguSettingsDraft,
  luoguSettingsPatch,
  luoguSyncProgressStep,
  luoguTime,
  luoguUnsupportedOsNote,
  type LuoguAction,
  type LuoguControl,
  type LuoguSecretMode,
  type LuoguSettingsDraft,
  type LuoguSyncProgressState,
} from './luogu-view.js';

/**
 * Dedicated Luogu account connection and synchronization panel (Sprint 17d2).
 *
 * It is the visible entry「题库 → 导入与同步 → 洛谷账号连接与同步」and drives exactly the seven typed
 * operations `luogu.status` / `luogu.connect` / `luogu.probe` / `luogu.disconnect` /
 * `luogu.configure` / `luogu.start` / `luogu.cancel`; it never talks to a platform, a database or a
 * credential store itself.
 *
 * The rules it follows:
 *
 * - **The durable status is the only state.** Every control's availability is derived from the last
 *   status answer ({@link luoguControls}), so remounting the page re-derives the same controls, and a
 *   running pass that the host owns is neither cleared nor restarted by navigation.
 * - **The session draft is memory-only.** It lives in this component in one of two modes — the
 *   `__client_id` **value** (default) or an optional whole-Cookie paste — and the `_uid` is never
 *   typed: it is the readonly UID of the selected account. The draft is submitted only to
 *   `luogu.connect`, is cleared before that request settles (and again on account switch, mode switch
 *   or unmount), is never written to `localStorage`/`sessionStorage` and is never echoed in a message
 *   or an error.
 * - **Safe polling.** `luogu.status` is polled only while this panel is mounted, only while something
 *   can actually change (a reserved/running pass, or automation that may start one), and each read is
 *   aborted by `useRequest` when the account changes or the panel unmounts, so a stale answer cannot
 *   overwrite a newer one.
 * - **Honest numbers.** History coverage, the latest attempt and the metadata backlog are rendered as
 *   three separate answers, and processed rows are labelled as including duplicate checks and rejudge
 *   replays rather than as new submissions.
 */
export function LuoguSyncPanel({
  sourcePlatform,
  onChange,
}: {
  /** Platform of the source selected in the surrounding import panel; used only for guidance. */
  sourcePlatform: string | null;
  /** Called after a committed pass completed, so the bank and bootstrap re-read their data. */
  onChange: () => void;
}) {
  const { boot, accountId, refresh } = useWorkbench();
  const account = boot.accounts.find((entry) => entry.id === accountId) ?? null;
  const source = account === null ? null : boot.sources.find((entry) => entry.id === account.sourceInstanceId) ?? null;
  const panelState = luoguPanelState(account !== null, source?.platform ?? null);
  // The panel opens itself when it is already about a Luogu account, and stays collapsed otherwise.
  const [open] = useState(panelState === 'ready');
  const status = useRequest('luogu.status', panelState === 'ready' && accountId !== null ? { accountId } : null);
  const value = status.data;
  const hostAction = useAction();
  const [pending, setPending] = useState<LuoguAction | null>(null);
  const [secretMode, setSecretMode] = useState<LuoguSecretMode>('client_id');
  const [clientId, setClientId] = useState('');
  const [fullCookie, setFullCookie] = useState('');
  const [fullConfirm, setFullConfirm] = useState(false);
  const [draft, setDraft] = useState<LuoguSettingsDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // A draft is never carried into another account: switching accounts clears the secret immediately,
  // and unmount clears it by dropping the only copy that exists.
  useEffect(() => {
    setSecretMode('client_id');
    setClientId('');
    setFullCookie('');
    setFullConfirm(false);
    setMessage(null);
  }, [accountId]);

  // Adopt the durable settings once per account/revision (and after every save); a plain poll of the
  // same revision never overwrites what the user is editing.
  const adopted = useRef('');
  useEffect(() => {
    if (value === null) {
      return;
    }
    const key = `${value.accountId}|${String(value.settingsRevision)}|${value.settings.updatedAt}`;
    if (adopted.current === key) {
      return;
    }
    adopted.current = key;
    setDraft(luoguSettingsDraft(value.settings));
  }, [value]);

  // A committed pass changes what the bank must show: either a new `lastSuccessAt`, or pages that
  // were committed and then the pass ended without one (a cancellation or a failure). The baseline
  // is adopted on the first read of an account — even while `lastSuccessAt` is still null — so the
  // first successful sync is never mistaken for an already-seen instant, and a poll that changed
  // nothing, a first read or an account switch refreshes nothing.
  const progress = useRef<LuoguSyncProgressState | null>(null);
  useEffect(() => {
    if (value === null) {
      return;
    }
    const step = luoguSyncProgressStep(progress.current, {
      accountId: value.accountId,
      lastSuccessAt: value.lastSuccessAt,
      totalPages: value.totalPages,
      submissionsSeen: value.submissionsSeen,
      running: value.running,
      leaseActive: value.leaseActive,
    });
    progress.current = step.state;
    if (step.refresh) {
      onChange();
      refresh();
    }
  }, [value, onChange, refresh]);

  const pollDelay = luoguPollDelayMs(value, pending === 'start' || pending === 'reconcile');
  usePollAfterSettle(pollDelay !== null, status.pending, status.refresh, pollDelay ?? LUOGU_POLL_IDLE_MS);

  // The draft is checked against the same pure rule the server uses; `secret.cookie` is the canonical
  // pair to submit and `value.uid` is the only source of the `_uid` binding.
  const secret = checkLuoguSessionCookie({
    mode: secretMode,
    selectedUid: value?.uid ?? null,
    clientId,
    fullCookie,
  });
  const settingsDirty = draft !== null && luoguSettingsDirty(value, draft);
  const controls = luoguControls({
    status: value,
    busy: pending,
    secretReady: secret.state === 'valid',
    settingsDirty,
    fullConfirmed: fullConfirm,
  });

  /** Run one host action at a time, then re-read the durable status so the panel shows real state. */
  async function submit(label: LuoguAction, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    setPending(label);
    setMessage(null);
    try {
      await hostAction.run(async (signal) => {
        await work(signal);
        status.refresh();
        return true;
      });
    } finally {
      setPending(null);
    }
  }

  function connect(): void {
    const target = accountId;
    const submitted = secret.cookie;
    if (target === null || submitted === null) {
      return;
    }
    // Cleared before the request settles: the draft must not survive an attempted submission, and it
    // is never rendered again — not in the success message, not in an error, not in a title.
    setClientId('');
    setFullCookie('');
    void submit('connect', async (signal) => {
      await api.request('luogu.connect', { accountId: target, sessionCookie: submitted }, signal);
      setMessage('登录凭据已保存在本机凭据管理器，并用一次真实读取检查过登录。');
    });
  }

  function probe(): void {
    const target = accountId;
    if (target === null) {
      return;
    }
    void submit('probe', async (signal) => {
      await api.request('luogu.probe', { accountId: target }, signal);
      setMessage('已按当前保存的凭据检查登录状态。');
    });
  }

  function disconnect(): void {
    const target = accountId;
    if (target === null) {
      return;
    }
    setClientId('');
    setFullCookie('');
    void submit('disconnect', async (signal) => {
      await api.request('luogu.disconnect', { accountId: target }, signal);
      setMessage(LUOGU_DISCONNECT_NOTE);
    });
  }

  function start(mode: 'resume' | 'full'): void {
    const target = accountId;
    if (target === null) {
      return;
    }
    void submit(mode === 'full' ? 'reconcile' : 'start', async (signal) => {
      const result = await api.request('luogu.start', { accountId: target, mode }, signal);
      setMessage(
        LUOGU_START_OUTCOMES[result.outcome] +
          (mode === 'full' ? ' 完成之前，历史覆盖仍按「未完成」显示。' : ''),
      );
    });
  }

  function cancelPass(): void {
    const target = accountId;
    if (target === null) {
      return;
    }
    void submit('cancel', async (signal) => {
      await api.request('luogu.cancel', { accountId: target }, signal);
      setMessage(
        '已请求暂停本轮：已经提交的进度会保留，可以稍后继续。这不会关闭自动同步，自动同步要单独用下面的开关关闭。',
      );
    });
  }

  function configure(): void {
    const current = value;
    if (current === null || draft === null) {
      return;
    }
    const patch = luoguSettingsPatch(current, draft);
    if (!patch.ok) {
      setMessage(patch.message);
      return;
    }
    void submit('configure', async (signal) => {
      await api.request('luogu.configure', patch.request, signal);
      setMessage('自动同步设置已保存到本机（按账号生效）。');
    });
  }

  const ready = value !== null;
  const accountLabel = account === null ? '未选择账号' : account.displayName ?? account.handle;
  let body: ReactNode;
  if (panelState === 'no-account') {
    body = (
      <>
        <Notice>
          尚未选择当前账号：连接与同步都需要一个洛谷账号。请在页面顶部「当前账号」中选择，或用「添加账号」按数字
          UID 新建一个洛谷账号
          {sourcePlatform === 'luogu' ? '（当前来源已经是洛谷，只差选中账号）。' : '。'}
        </Notice>
        <p className="icpc-muted">{LUOGU_MANUAL_STILL_AVAILABLE}</p>
      </>
    );
  } else if (panelState === 'wrong-platform') {
    body = (
      <>
        <Notice>
          当前账号「{accountLabel}」属于 {source?.displayName ?? source?.platform ?? '其他平台'}，不是洛谷账号：洛谷连接与同步只对这个账号自己的洛谷来源生效。
          请切换到洛谷账号，或新建一个洛谷账号后再使用本面板。
        </Notice>
        <p className="icpc-muted">{LUOGU_MANUAL_STILL_AVAILABLE}</p>
      </>
    );
  } else if (!ready) {
    body = (
      <>
        <p className="icpc-muted">
          账号：{accountLabel} · 洛谷 UID：读取中 · 来源：{source?.displayName ?? '洛谷'}
        </p>
        <ErrorNotice error={status.error} />
        {status.error === null ? (
          <Empty>{status.pending ? '正在读取该账号的洛谷同步状态…' : '暂时没有读到状态，请重试。'}</Empty>
        ) : (
          <div className="icpc-actions">
            <button type="button" onClick={status.refresh}>
              重试读取状态
            </button>
          </div>
        )}
        <p className="icpc-muted">{LUOGU_MANUAL_STILL_AVAILABLE}</p>
      </>
    );
  } else {
    const connectionReason = disabledReason(controls.connect, controls.probe, controls.disconnect);
    const syncReason = disabledReason(controls.start, controls.reconcile, controls.cancel);
    // A login check newer than the failure is shown as a successful check *now*; it never retracts
    // the failure and is never rendered as a successful synchronization.
    const loginCheck = luoguLoginCheckSummary(value);
    body = (
      <>
        <p className="icpc-muted">
          账号：{accountLabel} · 洛谷 UID：{value.uid} · 来源：{source?.displayName ?? '洛谷'}
        </p>
        <Stats
          items={[
            { label: '连接', value: luoguConnectionText(value) },
            { label: '同步阶段', value: LUOGU_PHASE_LABELS[value.phase] },
            { label: '历史覆盖', value: luoguHistoryCoverageLabel(value) },
            { label: '待补题目资料', value: value.metadataBacklog },
            { label: '累计处理提交记录', value: value.submissionsSeen },
          ]}
        />
        <ErrorNotice error={hostAction.error ?? status.error} />
        {message !== null && <Notice>{message}</Notice>}

        <div className="icpc-luogu-grid">
          <section className="icpc-luogu-block">
            <h3>连接</h3>
            <p>状态：{luoguConnectionText(value)}</p>
            {value.connection !== null && (
              <p className="icpc-muted">
                连接于 {luoguTime(value.connection.connectedAt)} · 最近检查 {luoguTime(value.connection.checkedAt)}
              </p>
            )}
            {value.connection !== null && value.connection.failureCode !== null && (
              <p className="icpc-muted">{luoguFailureGuidance(value.connection.failureCode)}</p>
            )}
            {value.connection?.cleanupPending === true && (
              <p className="icpc-muted">
                有一个旧的登录凭据还没有从 Windows 凭据管理器删除：请再点一次「断开连接」完成清理。
              </p>
            )}
            {!value.connectionAvailable ? (
              <Notice>{luoguUnsupportedOsNote(value.connectionPlatform)}</Notice>
            ) : (
              <>
                <label htmlFor="icpc-luogu-uid">洛谷 UID（_uid，只读）</label>
                <input
                  id="icpc-luogu-uid"
                  type="text"
                  value={value.uid}
                  readOnly
                  aria-describedby="icpc-luogu-uid-help"
                />
                <small className="icpc-muted" id="icpc-luogu-uid-help">
                  {LUOGU_UID_DISPLAY_NOTE}
                </small>
                {secretMode === 'client_id' ? (
                  <>
                    <label htmlFor="icpc-luogu-client-id">__client_id 的值（只在本机使用）</label>
                    <input
                      id="icpc-luogu-client-id"
                      type="password"
                      value={clientId}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="只粘贴 Value（值）一列"
                      aria-invalid={secret.message === null ? undefined : true}
                      aria-describedby="icpc-luogu-client-id-help"
                      onChange={(event) => setClientId(event.target.value)}
                    />
                    <small className="icpc-muted" id="icpc-luogu-client-id-help">
                      {LUOGU_CLIENT_ID_HELP}
                    </small>
                  </>
                ) : (
                  <>
                    <label htmlFor="icpc-luogu-cookie">整段 Cookie 值（高级，只在本机使用）</label>
                    <input
                      id="icpc-luogu-cookie"
                      type="password"
                      value={fullCookie}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="粘贴浏览器请求里 Cookie 的完整值"
                      aria-invalid={secret.message === null ? undefined : true}
                      aria-describedby="icpc-luogu-cookie-help"
                      onChange={(event) => setFullCookie(event.target.value)}
                    />
                    <small className="icpc-muted" id="icpc-luogu-cookie-help">
                      {LUOGU_FULL_COOKIE_HELP}
                    </small>
                  </>
                )}
                <label className="icpc-check">
                  <input
                    type="checkbox"
                    checked={secretMode === 'full_cookie'}
                    onChange={(event) => {
                      // Switching the input mode drops whatever was typed: the two shapes are not
                      // interchangeable, and neither draft may survive the switch.
                      setSecretMode(event.target.checked ? 'full_cookie' : 'client_id');
                      setClientId('');
                      setFullCookie('');
                    }}
                  />
                  {LUOGU_FULL_COOKIE_TOGGLE}
                </label>
                <small className="icpc-muted">{LUOGU_SECRET_MEMORY_NOTE}</small>
                {secret.message !== null && (
                  <small className="icpc-field-error" role="alert">
                    {secret.message}
                  </small>
                )}
              </>
            )}
            <div className="icpc-actions">
              <button
                type="button"
                className="icpc-primary"
                disabled={!controls.connect.enabled}
                aria-busy={pending === 'connect'}
                onClick={connect}
              >
                {pending === 'connect' ? '连接中…' : '连接'}
              </button>
              <button
                type="button"
                disabled={!controls.probe.enabled}
                aria-busy={pending === 'probe'}
                onClick={probe}
              >
                {pending === 'probe' ? '检查中…' : '检查登录'}
              </button>
              <button
                type="button"
                disabled={!controls.disconnect.enabled}
                aria-busy={pending === 'disconnect'}
                onClick={disconnect}
              >
                {pending === 'disconnect' ? '断开中…' : '断开连接'}
              </button>
            </div>
            {connectionReason !== null && (
              <small className="icpc-muted" role="status">
                {connectionReason}
              </small>
            )}
            <p className="icpc-muted">{LUOGU_SECRET_STORAGE_NOTE}</p>
            <p className="icpc-muted">{LUOGU_DISCONNECT_NOTE}</p>
            <details className="icpc-luogu-guide">
              <summary>怎样从自己的浏览器取得 Cookie 值</summary>
              <ol>
                {LUOGU_COOKIE_GUIDE.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              <p className="icpc-muted">{LUOGU_AI_CHAT_WARNING}</p>
            </details>
          </section>

          <section className="icpc-luogu-block">
            <h3>同步</h3>
            <p>{luoguProgressSummary(value)}</p>
            <p>{luoguHistoryCoverage(value)}</p>
            {/* This line is the panel's failure advice: it is rendered from the stage-aware helper,
                so a metadata failure can never be described here as an expired cookie, and a legacy
                record without a stage keeps the neutral wording. */}
            <p>{luoguAttemptSummary(value)}</p>
            {loginCheck !== null && (
              <p className="icpc-muted" role="status">
                {loginCheck}
              </p>
            )}
            <p>{luoguBacklogSummary(value)}</p>
            <p>{luoguNextRunSummary(value)}</p>
            {value.closing && (
              <Notice>插件正在关闭或重启：不会开始新的同步；重启 dsh 后会从本机保存的进度继续。</Notice>
            )}
            <label className="icpc-check">
              <input
                type="checkbox"
                checked={fullConfirm}
                onChange={(event) => setFullConfirm(event.target.checked)}
              />
              我确认：全历史完整核对会重新扫描这个账号的全部历史
            </label>
            <div className="icpc-actions">
              <button
                type="button"
                className="icpc-primary"
                disabled={!controls.start.enabled}
                aria-busy={pending === 'start'}
                onClick={() => start('resume')}
              >
                {pending === 'start' ? '提交中…' : '开始 / 继续同步'}
              </button>
              <button
                type="button"
                disabled={!controls.reconcile.enabled}
                aria-busy={pending === 'reconcile'}
                onClick={() => start('full')}
              >
                {pending === 'reconcile' ? '提交中…' : '全历史完整核对'}
              </button>
              <button
                type="button"
                disabled={!controls.cancel.enabled}
                aria-busy={pending === 'cancel'}
                onClick={cancelPass}
              >
                {pending === 'cancel' ? '暂停中…' : '暂停本轮'}
              </button>
            </div>
            {syncReason !== null && (
              <small className="icpc-muted" role="status">
                {syncReason}
              </small>
            )}
            <p className="icpc-muted">{LUOGU_RECENT_WINDOW_NOTE}</p>
            <p className="icpc-muted">{LUOGU_AC_EVIDENCE_NOTE}</p>
          </section>

          <section className="icpc-luogu-block">
            <h3>自动同步（按账号）</h3>
            {draft === null ? (
              <p className="icpc-muted">正在读取自动同步设置…</p>
            ) : (
              <>
                <label className="icpc-check">
                  <input
                    type="checkbox"
                    checked={draft.automaticEnabled}
                    disabled={!controls.configure.enabled && !settingsDirty}
                    onChange={(event) => setDraft({ ...draft, automaticEnabled: event.target.checked })}
                  />
                  为本账号开启自动同步
                </label>
                <label className="icpc-check">
                  <input
                    type="checkbox"
                    checked={draft.runOnStartup}
                    disabled={!controls.configure.enabled && !settingsDirty}
                    onChange={(event) => setDraft({ ...draft, runOnStartup: event.target.checked })}
                  />
                  每次启动 dsh 后先同步一次
                </label>
                <label htmlFor="icpc-luogu-interval">
                  同步间隔（分钟，{LUOGU_INTERVAL_MIN_MINUTES}–{LUOGU_INTERVAL_MAX_MINUTES}）
                </label>
                <input
                  id="icpc-luogu-interval"
                  inputMode="numeric"
                  value={draft.intervalMinutes}
                  aria-describedby="icpc-luogu-interval-help"
                  onChange={(event) => setDraft({ ...draft, intervalMinutes: event.target.value })}
                />
                <div className="icpc-actions">
                  <button
                    type="button"
                    disabled={!controls.configure.enabled}
                    aria-busy={pending === 'configure'}
                    onClick={configure}
                  >
                    {pending === 'configure' ? '保存中…' : '保存自动同步设置'}
                  </button>
                </div>
                {!controls.configure.enabled && controls.configure.reason !== null && (
                  <small className="icpc-muted" role="status" id="icpc-luogu-interval-help">
                    {controls.configure.reason}
                  </small>
                )}
                <p className="icpc-muted">
                  设置版本：{value.settingsRevision ?? '尚未建立'}
                  （保存时会带上这个版本号；如果在别处改过，保存会被拒绝并提示刷新，而不是覆盖别人的决定。）
                </p>
              </>
            )}
            <p className="icpc-muted">{LUOGU_AUTOMATION_NOTE}</p>
            <p className="icpc-muted">
              「暂停本轮」只停止当前这一轮同步；是否以后自动运行由上面的开关决定，两者互不替代。
            </p>
            <p className="icpc-muted">{LUOGU_MANUAL_STILL_AVAILABLE}</p>
          </section>
        </div>
      </>
    );
  }

  return (
    <details className="icpc-luogu" open={open}>
      <summary>洛谷账号连接与同步</summary>
      {body}
    </details>
  );
}

/** First reason a group of controls is unavailable; `null` when the whole group is usable. */
function disabledReason(...entries: readonly LuoguControl[]): string | null {
  for (const entry of entries) {
    if (!entry.enabled && entry.reason !== null) {
      return entry.reason;
    }
  }
  return null;
}
