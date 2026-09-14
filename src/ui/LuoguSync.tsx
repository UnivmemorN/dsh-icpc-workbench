import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.js';
import { luoguPrimaryName } from './account-name.js';
import {
  Empty,
  ErrorNotice,
  Notice,
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
  LUOGU_CLIENT_ID_INSTRUCTION,
  LUOGU_COOKIE_GUIDE,
  LUOGU_DISCONNECT_NOTE,
  LUOGU_FULL_COOKIE_HELP,
  LUOGU_FULL_COOKIE_TOGGLE,
  LUOGU_INTERVAL_MAX_MINUTES,
  LUOGU_INTERVAL_MIN_MINUTES,
  LUOGU_MANUAL_STILL_AVAILABLE,
  LUOGU_METADATA_DRAIN_LABEL,
  LUOGU_METADATA_DRAIN_NOTE,
  LUOGU_METADATA_START_OUTCOMES,
  LUOGU_NO_AI_NOTE,
  LUOGU_PHASE_LABELS,
  LUOGU_POLL_IDLE_MS,
  LUOGU_RECENT_WINDOW_NOTE,
  LUOGU_SECRET_LOCAL_ONLY_NOTE,
  LUOGU_SECRET_MEMORY_NOTE,
  LUOGU_SECRET_STORAGE_NOTE,
  LUOGU_START_OUTCOMES,
  LUOGU_UID_DISPLAY_NOTE,
  checkLuoguSessionCookie,
  luoguAttemptSummary,
  luoguBacklogSummary,
  luoguCompactSummary,
  luoguControls,
  luoguCredentialActionLabel,
  luoguFailureGuidance,
  luoguHistoryCoverage,
  luoguLoginCheckSummary,
  luoguPanelState,
  luoguPollDelayMs,
  luoguPrimaryActionReason,
  luoguProgressSummary,
  luoguSettingsDirty,
  luoguSettingsDraft,
  luoguSettingsEditable,
  luoguSettingsPatch,
  luoguSyncFailureGuidance,
  luoguSyncProgressStep,
  luoguUnsupportedOsNote,
  type LuoguAction,
  type LuoguSecretMode,
  type LuoguSettingsDraft,
  type LuoguSyncProgressState,
} from './luogu-view.js';
import { LuoguMetadataPanel } from './LuoguMetadata.js';
import {
  luoguMetadataDisclosureLabel,
  luoguMetadataPointer,
  luoguStartNotice,
  luoguStartNoticeStep,
  type LuoguStartNotice,
} from './luogu-metadata-view.js';

/** Stable id of the one revealed credential region, so its trigger can name what it controls. */
const CREDENTIALS_ID = 'icpc-luogu-credentials';

/**
 * Dedicated Luogu account connection and synchronization card (Sprint 17d2, compacted in 20b).
 *
 * It is the visible entry「账号与同步 → 数据来源：洛谷 → 导入与同步 → 洛谷账号连接与同步」and drives exactly the
 * seven typed operations `luogu.status` / `luogu.connect` / `luogu.probe` / `luogu.disconnect` /
 * `luogu.configure` / `luogu.start` / `luogu.cancel`; it never talks to a platform, a database or a
 * credential store itself.
 *
 * The compact disclosure rules (Sprint 20b):
 *
 * - **The default view is a few lines.** Connection state, last login check, history coverage, metadata
 *   backlog and automation state, then the primary「开始 / 继续同步」action.「暂停本轮」is rendered only
 *   while this instance is actually running.「补齐全部积压资料（不使用 AI）」sits next to the primary
 *   action and is enabled only while a nonempty backlog exists and no pass is running; one short line
 *   states that synchronization calls the platform and never a model. No textbox, textarea, statistics
 *   grid or tutorial paragraph exists until the user asks for it, and a failure is still stated in one
 *   short sentence.
 * - **One credential trigger, one form.** The single「连接洛谷」/「更新登录凭据」control
 *   ({@link luoguCredentialActionLabel}) mounts the credential form. Closing it unmounts the inputs and
 *   drops both drafts *and* the mode; an attempted submission clears them and collapses the form; a
 *   submit-button click is the only path that ever calls `luogu.connect`.
 * - **Each long sentence exists once.**「同步详情」holds the accurate progress, coverage, latest-attempt
 *   and backlog answers plus the stage-aware advice;「自动同步设置」holds the editable per-account
 *   settings;「高级操作」holds the explicitly confirmed whole-history reconciliation and the
 *   pause-versus-automation note. All three are native `<details>` collapsed by default.
 * - **Editable means the host can accept a change.** The automatic-sync fields are disabled only while
 *   an action is in flight or the plugin is closing ({@link luoguSettingsEditable}), never because the
 *   draft happens to be unchanged, while the save button still requires a real change.
 * - **Recovery lives in one disclosure (Sprint 25b).**「待补题目与手动处理（N）」sits next to the compact
 *   backlog action and always states the pending item count; it is collapsed by default, and
 *   {@link LuoguMetadataPanel} — which reads one bounded page of `luogu.metadataBacklog` and owns the
 *   single open supplement form — is mounted only while it is open. A metadata failure or a nonempty
 *   backlog adds one sentence pointing at exactly this disclosure.
 *
 * The rules it keeps from Stage 17d2/19:
 *
 * - **The durable status is the only state.** Every control's availability is derived from the last
 *   status answer ({@link luoguControls}), so remounting the page re-derives the same controls, and a
 *   running pass that the host owns is neither cleared nor restarted by navigation.
 * - **The session draft is memory-only.** It lives in this component in one of two modes — the
 *   `__client_id` **value** (default) or an optional whole-Cookie paste — and the `_uid` is never
 *   typed: it is the readonly UID of the selected account. The draft is submitted only to
 *   `luogu.connect`, is cleared before that request settles (and again on account switch, mode switch,
 *   closing the form or unmount), is never written to `localStorage`/`sessionStorage` and is never
 *   echoed in a message or an error.
 * - **Safe polling.** `luogu.status` is polled only while this panel is mounted, only while something
 *   can actually change (a reserved/running pass, or automation that may start one), and each read is
 *   aborted by `useRequest` when the account changes or the panel unmounts, so a stale answer cannot
 *   overwrite a newer one.
 * - **Honest numbers.** History coverage, the latest attempt and the metadata backlog stay three
 *   separate answers — the compact card summarises them and「同步详情」states them in full — and
 *   processed rows are labelled as including duplicate checks and rejudge replays rather than as new
 *   submissions. A successful login check is shown as a current login check and never retracts a
 *   failed pass.
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
  // The block opens itself whenever it is already about a Luogu account, so the compact card is the
  // default view there; it stays collapsed otherwise. The value only follows `panelState` transitions
  // (mount, account selected/cleared) — a manual collapse is not re-applied on unrelated re-renders.
  const status = useRequest('luogu.status', panelState === 'ready' && accountId !== null ? { accountId } : null);
  const value = status.data;
  const hostAction = useAction();
  const [pending, setPending] = useState<LuoguAction | null>(null);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [secretMode, setSecretMode] = useState<LuoguSecretMode>('client_id');
  const [clientId, setClientId] = useState('');
  const [fullCookie, setFullCookie] = useState('');
  const [fullConfirm, setFullConfirm] = useState(false);
  const [draft, setDraft] = useState<LuoguSettingsDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Sprint 25b: whether the one recovery disclosure is open (its panel is mounted only then) and the
  // transient answer of this panel's own `luogu.start` request, which the durable status later clears.
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [runNotice, setRunNotice] = useState<string | null>(null);

  // A draft is never carried into another account: switching accounts clears the secret immediately,
  // collapses the credential form, and unmount clears the drafts by dropping the only copy there is.
  useEffect(() => {
    setCredentialsOpen(false);
    setSecretMode('client_id');
    setClientId('');
    setFullCookie('');
    setFullConfirm(false);
    setMessage(null);
    // The backlog disclosure and its transient answer belong to one account: clearing them here means
    // no page position, row notice or open form can be carried into another account's backlog.
    setMetadataOpen(false);
    setRunNotice(null);
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

  // The transient「已开始新一轮同步…」line is cleared by the durable run it announced, never by a
  // guess: a new success, a failure observed after the click, and a run that was seen running and then
  // ended all drop it — while an initial idle read of the older status keeps it, because that read
  // proves nothing about the request that was just committed.
  const runStart = useRef<LuoguStartNotice | null>(null);
  useEffect(() => {
    if (value === null) {
      return;
    }
    const step = luoguStartNoticeStep(runStart.current, {
      accountId: value.accountId,
      running: value.running,
      leaseActive: value.leaseActive,
      lastSuccessAt: value.lastSuccessAt,
      scanStartedAt: value.scanStartedAt,
      failureAt: value.failure?.at ?? null,
      closing: value.closing,
    });
    runStart.current = step.notice;
    if (step.decision === 'succeeded' || step.decision === 'failed' || step.decision === 'ended') {
      setRunNotice(null);
    }
  }, [value]);

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
    // A new host action replaces whatever the previous start request announced.
    setRunNotice(null);
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

  /**
   * Close the one credential disclosure.
   *
   * The inputs unmount with it, and the mode and both drafts are dropped in the same commit: nothing
   * that was typed can survive a close and reappear when the form is opened again.
   */
  function closeCredentials(): void {
    setCredentialsOpen(false);
    setSecretMode('client_id');
    setClientId('');
    setFullCookie('');
  }

  function connect(): void {
    const target = accountId;
    const submitted = secret.cookie;
    if (target === null || submitted === null) {
      return;
    }
    // Cleared and collapsed before the request settles: the draft must not survive an attempted
    // submission, and it is never rendered again — not in the success message, not in an error, not
    // in a title. This submit path is the only caller of `luogu.connect`.
    closeCredentials();
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

  function start(mode: 'resume' | 'full' | 'metadata'): void {
    const target = accountId;
    if (target === null) {
      return;
    }
    // The click instant and the durable baselines are captured before the request; the fold in the
    // status effect uses them to prove that this run actually started, succeeded or failed instead of
    // reading an older status as the answer to this request.
    const requestedAt = new Date().toISOString();
    const baseline = value;
    const action = mode === 'full' ? 'reconcile' : mode === 'metadata' ? 'metadata' : 'start';
    void submit(action, async (signal) => {
      const result = await api.request('luogu.start', { accountId: target, mode }, signal);
      const outcomes = mode === 'metadata' ? LUOGU_METADATA_START_OUTCOMES : LUOGU_START_OUTCOMES;
      runStart.current = luoguStartNotice({
        accountId: target,
        outcome: result.outcome,
        requestedAt,
        lastSuccessAt: baseline?.lastSuccessAt ?? null,
        scanStartedAt: baseline?.scanStartedAt ?? null,
      });
      setRunNotice(
        outcomes[result.outcome] + (mode === 'full' ? ' 完成之前，历史覆盖仍按「未完成」显示。' : ''),
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
        '已请求暂停本轮：已经提交的进度会保留，可以稍后继续。这不会关闭自动同步，自动同步要单独用「自动同步设置」里的开关关闭。',
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

  const accountLabel = account === null ? '未选择账号' : account.displayName ?? account.handle;
  // A Luogu account's primary label is its public nickname or the neutral 洛谷用户 — never the UID,
  // which is stated separately next to it; the other platforms keep their existing label.
  const luoguLabel = account === null ? '未选择账号' : luoguPrimaryName(account);
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
  } else if (value === null) {
    body = (
      <>
        <p className="icpc-muted">
          账号：{luoguLabel} · 洛谷 UID：读取中 · 来源：{source?.displayName ?? '洛谷'}
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
      </>
    );
  } else {
    const compact = luoguCompactSummary(value);
    const supported = value.connectionAvailable;
    const connected = value.connection !== null && value.connection.status === 'connected';
    const credentialLabel = luoguCredentialActionLabel(value);
    const settingsEditable = luoguSettingsEditable(value, pending !== null);
    const primaryReason = luoguPrimaryActionReason(value, controls.start, pending !== null);
    // The compact card always names the one place where a pending or failed problem key is handled.
    const metadataPointer = luoguMetadataPointer(value);
    // A login check newer than the failure is shown as a successful check *now*; it never retracts
    // the failure and is never rendered as a successful synchronization.
    const loginCheck = luoguLoginCheckSummary(value);
    // The connection record and a sync pass are different operations, but they can share one fixed
    // sentence (the same `auth_required`, for example): every long sentence is rendered at most once.
    const connectionAdvice = luoguFailureGuidance(value.connection?.failureCode ?? null);
    const connectionOnlyAdvice =
      connectionAdvice !== null && connectionAdvice !== luoguSyncFailureGuidance(value.failure)
        ? connectionAdvice
        : null;
    // The whole-history confirmation is the checkbox's own sentence, so its "please confirm" reason
    // is not repeated; every other reason (no connection, closing, running) is worth stating.
    const reconcileReason =
      fullConfirm && pending === null && !controls.reconcile.enabled ? controls.reconcile.reason : null;
    const settingsHint = settingsEditable
      ? settingsDirty
        ? '有未保存的修改：保存后按账号立即生效。'
        : '修改任意一项后，「保存自动同步设置」才会启用。'
      : controls.configure.reason ?? '暂时无法修改自动同步设置。';

    body = (
      <>
        <p className="icpc-muted">
          账号：{luoguLabel} · 洛谷 UID：{value.uid} · 来源：{source?.displayName ?? '洛谷'}
        </p>
        <p className="icpc-luogu-status">
          <strong>{compact.connection}</strong>
          {compact.checkedAt !== null && <span className="icpc-muted"> · 最近检查 {compact.checkedAt}</span>}
        </p>
        <p className="icpc-luogu-status">
          历史覆盖：{compact.history}
          <span className="icpc-muted"> · {compact.backlog} · {compact.automation}</span>
        </p>
        <p className="icpc-muted">{LUOGU_NO_AI_NOTE}</p>
        <ErrorNotice error={hostAction.error ?? status.error} />
        {message !== null && <Notice>{message}</Notice>}
        {/* The start notice is its own line: it can be cleared by the durable run without disturbing
            the result of the last explicit action. */}
        {runNotice !== null && <Notice>{runNotice}</Notice>}
        {/* The compact card never hides a failure: one short sentence names it and the long,
            stage-aware next-action sentence is rendered once inside「同步详情」. */}
        {compact.alert !== null && (
          <p className="icpc-luogu-alert" role="status">
            {compact.alert}
          </p>
        )}
        {value.connection?.cleanupPending === true && (
          <p className="icpc-luogu-alert" role="status">
            有一个旧的登录凭据还没有从 Windows 凭据管理器删除：请展开「更新登录凭据」，再点一次「断开连接」完成清理。
          </p>
        )}
        {!supported && (
          <>
            <Notice>{luoguUnsupportedOsNote(value.connectionPlatform)}</Notice>
            <p className="icpc-muted">{LUOGU_MANUAL_STILL_AVAILABLE}</p>
          </>
        )}

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
            disabled={!controls.metadata.enabled}
            aria-busy={pending === 'metadata'}
            onClick={() => start('metadata')}
          >
            {pending === 'metadata' ? '提交中…' : LUOGU_METADATA_DRAIN_LABEL}
          </button>
          {value.running && (
            <button
              type="button"
              disabled={!controls.cancel.enabled}
              aria-busy={pending === 'cancel'}
              onClick={cancelPass}
            >
              {pending === 'cancel' ? '暂停中…' : '暂停本轮'}
            </button>
          )}
          {supported && value.connection !== null && (
            <button type="button" disabled={!controls.probe.enabled} aria-busy={pending === 'probe'} onClick={probe}>
              {pending === 'probe' ? '检查中…' : '检查登录'}
            </button>
          )}
          {supported && (
            <button
              type="button"
              className={connected ? undefined : 'icpc-primary'}
              aria-expanded={credentialsOpen}
              aria-controls={CREDENTIALS_ID}
              onClick={() => (credentialsOpen ? closeCredentials() : setCredentialsOpen(true))}
            >
              {credentialsOpen ? '收起登录凭据' : credentialLabel}
            </button>
          )}
        </div>
        {primaryReason !== null && (
          <small className="icpc-muted" role="status">
            {primaryReason}
          </small>
        )}
        {metadataPointer !== null && (
          <p className="icpc-muted" role="status">
            {metadataPointer}
          </p>
        )}

        {/* Sprint 25b: the one discoverable place for pending or failed problem material. The panel is
            mounted only while this disclosure is open, so a closed disclosure issues no request and
            holds no draft; closing it unmounts every row and the single open supplement form. */}
        <details
          className="icpc-luogu-detail"
          open={metadataOpen}
          onToggle={(event) => {
            if (event.target === event.currentTarget) {
              setMetadataOpen(event.currentTarget.open);
            }
          }}
        >
          <summary>{luoguMetadataDisclosureLabel(value.metadataBacklog)} · 已跳过 / 回收站</summary>
          <div className="icpc-luogu-detail-body">
            {metadataOpen && (
              <LuoguMetadataPanel
                key={value.accountId}
                accountId={value.accountId}
                status={value}
                onStatusRefresh={status.refresh}
                onBankChange={onChange}
              />
            )}
          </div>
        </details>

        {supported && credentialsOpen && (
          <section className="icpc-luogu-credentials" id={CREDENTIALS_ID} aria-label="洛谷登录凭据">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                connect();
              }}
            >
              <label htmlFor="icpc-luogu-uid">洛谷 UID（_uid，只读）</label>
              <input id="icpc-luogu-uid" type="text" value={value.uid} readOnly />
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
                    {LUOGU_CLIENT_ID_INSTRUCTION}
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
                    提交前只保留 __client_id 与 _uid 两项，其余 Cookie 一律丢弃。
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
              <small className="icpc-muted">{LUOGU_SECRET_LOCAL_ONLY_NOTE}</small>
              {secret.message !== null && (
                <small className="icpc-field-error" role="alert">
                  {secret.message}
                </small>
              )}
              <div className="icpc-actions">
                <button
                  type="submit"
                  className="icpc-primary"
                  disabled={!controls.connect.enabled}
                  aria-busy={pending === 'connect'}
                >
                  {pending === 'connect' ? '连接中…' : '连接'}
                </button>
                <button type="button" onClick={closeCredentials}>
                  取消
                </button>
                {value.connection !== null && (
                  <button
                    type="button"
                    disabled={!controls.disconnect.enabled}
                    aria-busy={pending === 'disconnect'}
                    onClick={disconnect}
                  >
                    {pending === 'disconnect' ? '断开中…' : '断开连接'}
                  </button>
                )}
              </div>
              {pending === null && !controls.connect.enabled && controls.connect.reason !== null && (
                <small className="icpc-muted" role="status">
                  {controls.connect.reason}
                </small>
              )}
              {value.connection !== null && <small className="icpc-muted">{LUOGU_DISCONNECT_NOTE}</small>}
              <details className="icpc-luogu-guide">
                <summary>如何获取 Cookie</summary>
                <ol>
                  {LUOGU_COOKIE_GUIDE.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
                <p className="icpc-muted">{LUOGU_UID_DISPLAY_NOTE}</p>
                <p className="icpc-muted">{LUOGU_CLIENT_ID_HELP}</p>
                <p className="icpc-muted">{LUOGU_FULL_COOKIE_HELP}</p>
                <p className="icpc-muted">{LUOGU_SECRET_MEMORY_NOTE}</p>
                <p className="icpc-muted">{LUOGU_SECRET_STORAGE_NOTE}</p>
                <p className="icpc-muted">{LUOGU_AI_CHAT_WARNING}</p>
              </details>
            </form>
          </section>
        )}

        <details className="icpc-luogu-detail">
          <summary>同步详情</summary>
          <div className="icpc-luogu-detail-body">
            <p className="icpc-muted">同步阶段：{LUOGU_PHASE_LABELS[value.phase]}</p>
            <p>{luoguProgressSummary(value)}</p>
            <p>{luoguHistoryCoverage(value)}</p>
            {/* The panel's failure advice: rendered from the stage-aware helper, so a metadata
                failure can never be described here as an expired cookie, and a legacy record without
                a stage keeps the neutral wording. */}
            <p>{luoguAttemptSummary(value)}</p>
            {connectionOnlyAdvice !== null && (
              <p className="icpc-muted" role="status">
                {connectionOnlyAdvice}
              </p>
            )}
            {loginCheck !== null && (
              <p className="icpc-muted" role="status">
                {loginCheck}
              </p>
            )}
            <p>{luoguBacklogSummary(value)}</p>
            <p className="icpc-muted">{LUOGU_METADATA_DRAIN_NOTE}</p>
            <p className="icpc-muted">{LUOGU_RECENT_WINDOW_NOTE}</p>
            <p className="icpc-muted">{LUOGU_AC_EVIDENCE_NOTE}</p>
          </div>
        </details>

        <details className="icpc-luogu-detail">
          <summary>自动同步设置</summary>
          <div className="icpc-luogu-detail-body">
            {draft === null ? (
              <p className="icpc-muted">正在读取自动同步设置…</p>
            ) : (
              <>
                <label className="icpc-check">
                  <input
                    type="checkbox"
                    checked={draft.automaticEnabled}
                    disabled={!settingsEditable}
                    onChange={(event) => setDraft({ ...draft, automaticEnabled: event.target.checked })}
                  />
                  为本账号开启自动同步
                </label>
                <label className="icpc-check">
                  <input
                    type="checkbox"
                    checked={draft.runOnStartup}
                    disabled={!settingsEditable}
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
                  disabled={!settingsEditable}
                  aria-describedby="icpc-luogu-settings-help"
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
                <small className="icpc-muted" role="status" id="icpc-luogu-settings-help">
                  {settingsHint}
                </small>
                <p className="icpc-muted">{LUOGU_AUTOMATION_NOTE}</p>
              </>
            )}
          </div>
        </details>

        <details className="icpc-luogu-detail">
          <summary>高级操作</summary>
          <div className="icpc-luogu-detail-body">
            <p className="icpc-muted">核对只重新读取并更新本地记录，不会删除已有记录。</p>
            <label className="icpc-check">
              <input
                type="checkbox"
                checked={fullConfirm}
                disabled={pending !== null}
                onChange={(event) => setFullConfirm(event.target.checked)}
              />
              我确认：全历史完整核对会重新扫描这个账号的全部历史
            </label>
            <div className="icpc-actions">
              <button
                type="button"
                disabled={!controls.reconcile.enabled}
                aria-busy={pending === 'reconcile'}
                onClick={() => start('full')}
              >
                {pending === 'reconcile' ? '提交中…' : '全历史完整核对'}
              </button>
            </div>
            {reconcileReason !== null && (
              <small className="icpc-muted" role="status">
                {reconcileReason}
              </small>
            )}
            <p className="icpc-muted">
              「暂停本轮」只停止当前这一轮同步；是否以后自动运行由「自动同步设置」决定，两者互不替代。
            </p>
          </div>
        </details>
      </>
    );
  }

  return (
    <details className="icpc-luogu" open={panelState === 'ready'} onToggle={(event) => {
      if (event.target === event.currentTarget && !event.currentTarget.open) closeCredentials();
    }}>
      <summary>洛谷账号连接与同步</summary>
      {body}
    </details>
  );
}
