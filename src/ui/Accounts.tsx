import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { ErrorNotice, ExternalLink, Notice, Panel, useAction, useWorkbench } from './common.js';
import {
  accountListLabels,
  currentAccountNote,
  lookupLuoguNickname,
  needsLuoguNickname,
  sourceOfAccount,
} from './account-name.js';
import {
  ACCOUNT_ERROR_ID,
  ACCOUNT_GUIDES,
  ACCOUNT_HELP_ID,
  ACCOUNT_SAVE_NOTE,
  checkAccountInput,
  type AccountPlatform,
} from './account-input.js';
import { ImportPanel } from './Imports.js';

/** The one typed public read behind every nickname refresh; the UI never calls the platform itself. */
const profileLookup = (accountId: string, signal: AbortSignal) =>
  api.request('luogu.profile', { accountId }, signal).then((result) => result.account);

/**
 * Accounts & sync page (Sprint Contract 20a; nickname presentation 22b2).
 *
 * Everything that binds an identity or moves platform data lives here: the account list, the single
 * 添加账号/取消 disclosure, the source the page works on, and the whole import panel (generic public
 * sync, the Luogu connection panel and the JSON/CSV manual import). The bank keeps only a link to
 * this page, so browsing problems is no longer mixed with connection and import state.
 *
 * The page reads nothing on its own: it renders bootstrap accounts/sources, and reading them can
 * never create an account, open a form or start a synchronization. While an account is selected the
 * source follows that account's own instance — a submissions request for another source would be
 * refused as `source_mismatch` — and an anonymous or manual context may pick a source explicitly so
 * the public problem catalog and manual import stay usable without any account. The importer is
 * keyed by source, so switching sources drops stale previews and drafts instead of mixing them.
 *
 * Nickname presentation (Sprint 22b2): a Luogu account's nickname is read through the public,
 * anonymous `luogu.profile` route — never through a Cookie — and is always shown next to its UID.
 * Selecting a Luogu account that displays no distinct nickname starts exactly one automatic attempt
 * per mounted page, and the explicit「刷新洛谷昵称」button is the only path that may replace a distinct
 * custom nickname. Both paths abort on unmount and apply no answer that arrived too late.
 */
export function Accounts() {
  const { boot, accountId, selectAccount, refresh } = useWorkbench();
  const account = boot.accounts.find((entry) => entry.id === accountId) ?? null;
  const source = account === null ? null : sourceOfAccount(boot.sources, account);
  const [sourceId, setSourceId] = useState(account?.sourceInstanceId ?? boot.sources[0]?.id ?? '');
  const [adding, setAdding] = useState(false);
  const [nicknameNotice, setNicknameNotice] = useState<string | null>(null);
  const nicknameAction = useAction();
  const [automaticNicknameBusy, setAutomaticNicknameBusy] = useState(false);
  const luoguSelected = account !== null && source?.platform === 'luogu';

  // `account.create` selects the new account before the refreshed bootstrap contains it, so the
  // account's own source is adopted once per account as soon as it appears — exactly like the bank's
  // reconciliation — instead of leaving the page on a source the account does not belong to.
  const followedAccount = useRef<string | null>(null);
  useEffect(() => {
    if (account === null || followedAccount.current === account.id) {
      return;
    }
    followedAccount.current = account.id;
    setSourceId(account.sourceInstanceId);
  }, [account]);

  // The automatic attempt is keyed by the account and what it currently shows; `refresh` is read
  // through a ref instead of a dependency (it is a new function on every shell render), so a
  // bootstrap refresh or any unrelated render cannot start a second lookup. The page subtree is
  // keyed by the selection, so switching accounts unmounts this component and aborts the read.
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const autoLookupId =
    account !== null && needsLuoguNickname(account, source?.platform ?? null) ? account.id : null;
  const displayedName = account?.displayName ?? null;
  const displayedHandle = account?.handle ?? null;
  useEffect(() => {
    if (autoLookupId === null) {
      setAutomaticNicknameBusy(false);
      return;
    }
    const controller = new AbortController();
    setAutomaticNicknameBusy(true);
    setNicknameNotice(null);
    void lookupLuoguNickname(autoLookupId, profileLookup, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      setAutomaticNicknameBusy(false);
      if (outcome.status === 'refreshed') latestRefresh.current();
      else if (outcome.status === 'failed') setNicknameNotice(`洛谷昵称暂未获取：${outcome.reason}`);
    });
    return () => controller.abort();
  }, [autoLookupId, displayedName, displayedHandle]);

  /** Platform name of a source instance, for account identity; the raw id is the honest fallback. */
  const platformName = (instanceId: string) =>
    boot.sources.find((entry) => entry.id === instanceId)?.displayName ?? instanceId;

  /**
   * The one explicit nickname refresh: unlike the automatic attempt it may replace a distinct custom
   * nickname, and its refusal is an actionable notice while the stored binding and name survive.
   */
  const refreshNickname = () => {
    if (account === null || !luoguSelected || automaticNicknameBusy) return;
    const target = account.id;
    setNicknameNotice(null);
    void nicknameAction.run(async (signal) => {
      const outcome = await lookupLuoguNickname(target, profileLookup, signal);
      if (signal.aborted || outcome.status === 'aborted') return undefined;
      if (outcome.status === 'failed') {
        setNicknameNotice(`洛谷昵称暂未获取：${outcome.reason}`);
        return undefined;
      }
      refresh();
      setNicknameNotice(
        outcome.nickname === null
          ? '已读取洛谷公开资料：该账号没有与 UID 不同的公开昵称，仍显示为洛谷用户。'
          : `已刷新洛谷昵称：${outcome.nickname}`,
      );
      return true;
    });
  };

  const accountLabels =
    account === null ? null : accountListLabels(account, source?.platform ?? null, platformName(account.sourceInstanceId));
  const accountNote =
    account === null ? null : currentAccountNote(account, source?.platform ?? null, platformName(account.sourceInstanceId));

  return (
    <div className="icpc-accounts">
      <div className="icpc-page-heading">
        <div>
          <p className="icpc-eyebrow">ACCOUNTS</p>
          <h1>账号与同步</h1>
          <p>管理平台账号，导入和同步做题记录。</p>
        </div>
      </div>
      <Panel
        title="账号"
        tools={
          <button type="button" aria-expanded={adding} onClick={() => setAdding((open) => !open)}>
            {adding ? '取消' : '添加账号'}
          </button>
        }
      >
        {boot.accounts.length === 0 ? (
          <Notice>
            还没有账号：添加只保存 Codeforces Handle 或洛谷 UID 这类公开标识，不需要密码。不添加账号也可以同步公开题目目录或手工导入。
          </Notice>
        ) : (
          <ul className="icpc-account-list">
            {boot.accounts.map((entry) => {
              const labels = accountListLabels(
                entry,
                sourceOfAccount(boot.sources, entry)?.platform ?? null,
                platformName(entry.sourceInstanceId),
              );
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-pressed={entry.id === accountId}
                    onClick={() => selectAccount(entry.id === accountId ? null : entry.id)}
                  >
                    <strong>{labels.primary}</strong>
                    <span>{labels.secondary}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="icpc-account-current">
          当前账号：
          {account === null || accountLabels === null || accountNote === null ? (
            '未选择'
          ) : (
            <>
              <strong>{accountLabels.primary}</strong>（{accountNote}）
              {account.profileUrl && (
                <>
                  {' '}
                  · <ExternalLink href={account.profileUrl}>个人主页</ExternalLink>
                </>
              )}
            </>
          )}
          。点击账号即可切换，再次点击已选账号可取消选择。
        </p>
        {luoguSelected && (
          <>
            <div className="icpc-actions">
              <button
                type="button"
                disabled={nicknameAction.busy || automaticNicknameBusy}
                aria-busy={nicknameAction.busy || automaticNicknameBusy}
                onClick={refreshNickname}
              >
                {nicknameAction.busy || automaticNicknameBusy ? '刷新中…' : '刷新洛谷昵称'}
              </button>
              <small className="icpc-muted">公开昵称读取不需要 Cookie，不调用 AI，也不改动做题记录。</small>
            </div>
            {nicknameNotice !== null && <Notice>{nicknameNotice}</Notice>}
            <ErrorNotice error={nicknameAction.error} />
          </>
        )}
        {adding && <AddAccountForm onCreated={() => setAdding(false)} />}
      </Panel>
      <section className="icpc-accounts-source">
        <div className="icpc-toolbar">
          {account === null ? (
            <label>数据来源
              <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                {boot.sources.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
              </select>
            </label>
          ) : <p className="icpc-muted">数据来源：{platformName(account.sourceInstanceId)}</p>}

        </div>
        {account === null && (
          <Notice>未选择当前账号：仍可同步公开题目目录或手工导入；提交记录同步需要一个对应平台的账号。</Notice>
        )}
        <ImportPanel key={sourceId} sourceId={sourceId} onChange={refresh} />
      </section>
    </div>
  );
}

/**
 * The one add-account disclosure body.
 *
 * Local rules (`checkAccountInput`) refuse an unusable identifier before anything is sent, and a
 * failed save keeps the typed value and shows the reason; the adapter factory is still the identity
 * authority and canonicalizes whatever is submitted. Platform guidance and the inert example link
 * sit behind their own optional expansion, so the compact form stays short. No credential — and no
 * secret of any kind — is asked for here.
 *
 * A Luogu save is two steps (Sprint 22b2): `account.create`, then the public `luogu.profile` read
 * *before* the account is selected, because selecting it unmounts this form and would abort the
 * read. A successful read refreshes the bootstrap, then selects and closes. A refused read keeps the
 * saved binding, keeps the form open and offers one explicit retry — it never deletes and recreates
 * the account, and never turns a nickname failure into a create failure. Codeforces is unchanged.
 */
function AddAccountForm({ onCreated }: { onCreated: () => void }) {
  const { selectAccount, refresh } = useWorkbench();
  const action = useAction();
  const [platform, setPlatform] = useState<AccountPlatform>('codeforces');
  const [handle, setHandle] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [warning, setWarning] = useState<{ accountId: string; reason: string } | null>(null);
  const check = checkAccountInput(platform, handle);
  const guide = ACCOUNT_GUIDES[platform];
  const inlineError = check.state === 'invalid' ? check.message : null;
  const describedBy =
    [helpOpen ? ACCOUNT_HELP_ID : null, inlineError ? ACCOUNT_ERROR_ID : null].filter(Boolean).join(' ') ||
    undefined;

  /** A platform change invalidates the old identifier, the old failure message and the old warning. */
  const changePlatform = (next: AccountPlatform) => {
    setPlatform(next);
    setHandle('');
    setWarning(null);
    action.clear();
  };

  /** Close the form with the freshly named account selected. */
  const finish = (accountId: string) => {
    onCreated();
    selectAccount(accountId);
  };

  const submit = () => {
    const ready = checkAccountInput(platform, handle);
    if (warning !== null || ready.state !== 'valid') {
      return;
    }
    setWarning(null);
    void action.run(async (signal) => {
      const saved = await api.request('account.create', { platform, handle: ready.handle }, signal);
      // Checked after every awaited step: a cancelled or unmounted form never selects, closes or
      // refreshes on behalf of a response that no longer belongs to the visible page.
      if (signal.aborted) return undefined;
      if (platform === 'codeforces') {
        // The new account becomes the current one (clearing problem/candidate selection) and the
        // bootstrap is re-read so the account list and every later page see it.
        selectAccount(saved.account.id);
        onCreated();
        refresh();
        return true;
      }
      const outcome = await lookupLuoguNickname(saved.account.id, profileLookup, signal);
      if (signal.aborted || outcome.status === 'aborted') return undefined;
      if (outcome.status === 'failed') {
        // The binding is saved; show it with one explicit retry instead of deleting and recreating.
        refresh();
        setWarning({ accountId: saved.account.id, reason: outcome.reason });
        return true;
      }
      refresh();
      finish(saved.account.id);
      return true;
    });
  };

  /** The explicit retry: same saved account, same public read, no second `account.create`. */
  const retryNickname = () => {
    const pending = warning;
    if (pending === null) return;
    void action.run(async (signal) => {
      const outcome = await lookupLuoguNickname(pending.accountId, profileLookup, signal);
      if (signal.aborted || outcome.status === 'aborted') return undefined;
      if (outcome.status === 'failed') {
        setWarning({ accountId: pending.accountId, reason: outcome.reason });
        return undefined;
      }
      refresh();
      finish(pending.accountId);
      return true;
    });
  };

  return (
    <form
      className="icpc-add-account"
      aria-label="添加账号"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="icpc-field">
        <label htmlFor="icpc-account-platform">平台</label>
        <select
          id="icpc-account-platform"
          disabled={action.busy}
          value={platform}
          onChange={(event) => changePlatform(event.target.value as AccountPlatform)}
        >
          <option value="codeforces">Codeforces</option>
          <option value="luogu">洛谷</option>
        </select>
      </div>
      <div className="icpc-field">
        <label htmlFor="icpc-account-input">{guide.label}</label>
        <input
          id="icpc-account-input"
          name="handle"
          type="text"
          disabled={action.busy}
          value={handle}
          placeholder={guide.placeholder}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          aria-required="true"
          aria-invalid={inlineError ? 'true' : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            setHandle(event.target.value);
            setWarning(null);
            action.clear();
          }}
        />
        <details className="icpc-account-guide" onToggle={(event) => setHelpOpen(event.currentTarget.open)}>
          <summary>填写说明与示例</summary>
          <p className="icpc-field-help" id={ACCOUNT_HELP_ID}>
            {guide.help}
          </p>
          <p className="icpc-field-example">
            示例（仅说明格式，打开示例不会创建账号）：
            <ExternalLink href={guide.exampleUrl}>{guide.exampleText}</ExternalLink>
          </p>
        </details>
        {inlineError && (
          <p className="icpc-field-error" id={ACCOUNT_ERROR_ID} role="alert">
            {inlineError}
          </p>
        )}
      </div>
      <div className="icpc-field">
        <p className="icpc-form-note">{ACCOUNT_SAVE_NOTE}</p>
        {warning !== null && (
          <Notice>
            账号已添加，昵称暂未获取：{warning.reason}
            绑定已经保存在本机，可以关闭本表单稍后重试，不需要重新添加账号。
            <div className="icpc-actions">
              <button type="button" disabled={action.busy} aria-busy={action.busy} onClick={retryNickname}>
                {action.busy ? '处理中…' : '重试获取昵称'}
              </button>
            </div>
          </Notice>
        )}
        <div className="icpc-actions">
          <button
            className="icpc-primary"
            type="submit"
            disabled={action.busy || warning !== null || check.state !== 'valid'}
            aria-busy={action.busy}
          >
            {action.busy ? '保存中…' : '添加账号'}
          </button>
        </div>
        <ErrorNotice error={action.error} />
      </div>
    </form>
  );
}
