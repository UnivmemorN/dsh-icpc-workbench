import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { ErrorNotice, ExternalLink, Notice, Panel, useAction, useWorkbench } from './common.js';
import {
  ACCOUNT_ERROR_ID,
  ACCOUNT_GUIDES,
  ACCOUNT_HELP_ID,
  ACCOUNT_SAVE_NOTE,
  checkAccountInput,
  type AccountPlatform,
} from './account-input.js';
import { ImportPanel } from './Imports.js';

/**
 * Accounts & sync page (Sprint Contract 20a).
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
 */
export function Accounts() {
  const { boot, accountId, selectAccount, refresh } = useWorkbench();
  const account = boot.accounts.find((entry) => entry.id === accountId) ?? null;
  const [sourceId, setSourceId] = useState(account?.sourceInstanceId ?? boot.sources[0]?.id ?? '');
  const [adding, setAdding] = useState(false);

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

  /** Platform name of a source instance, for account identity; the raw id is the honest fallback. */
  const platformName = (instanceId: string) =>
    boot.sources.find((entry) => entry.id === instanceId)?.displayName ?? instanceId;

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
            {boot.accounts.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-pressed={entry.id === accountId}
                  onClick={() => selectAccount(entry.id === accountId ? null : entry.id)}
                >
                  <strong>{entry.displayName ?? entry.handle}</strong>
                  <span>
                    {platformName(entry.sourceInstanceId)} · {entry.handle}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="icpc-account-current">
          当前账号：
          {account === null ? (
            '未选择'
          ) : (
            <>
              <strong>{account.displayName ?? account.handle}</strong>（{platformName(account.sourceInstanceId)}）
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
 */
function AddAccountForm({ onCreated }: { onCreated: () => void }) {
  const { selectAccount, refresh } = useWorkbench();
  const action = useAction();
  const [platform, setPlatform] = useState<AccountPlatform>('codeforces');
  const [handle, setHandle] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const check = checkAccountInput(platform, handle);
  const guide = ACCOUNT_GUIDES[platform];
  const inlineError = check.state === 'invalid' ? check.message : null;
  const describedBy =
    [helpOpen ? ACCOUNT_HELP_ID : null, inlineError ? ACCOUNT_ERROR_ID : null].filter(Boolean).join(' ') ||
    undefined;

  /** A platform change invalidates both the old identifier and the old failure message. */
  const changePlatform = (next: AccountPlatform) => {
    setPlatform(next);
    setHandle('');
    action.clear();
  };
  const submit = () => {
    const ready = checkAccountInput(platform, handle);
    if (ready.state !== 'valid') {
      return;
    }
    void action.run(async (signal) => {
      const saved = await api.request('account.create', { platform, handle: ready.handle }, signal);
      // The new account becomes the current one (clearing problem/candidate selection) and the
      // bootstrap is re-read so the account list and every later page see it.
      selectAccount(saved.account.id);
      onCreated();
      refresh();
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
        <div className="icpc-actions">
          <button
            className="icpc-primary"
            type="submit"
            disabled={action.busy || check.state !== 'valid'}
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
