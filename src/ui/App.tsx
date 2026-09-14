import { useState } from 'react';
import { WorkbenchContext, useRequest, ErrorNotice, Empty, type PageName } from './common.js';
import { Review } from './Review.js';
import { Weakness } from './Weakness.js';
import { Plans } from './Plans.js';
import { Accounts } from './Accounts.js';
import { Bank } from './Bank.js';
import { Today } from './Today.js';
import { Settings } from './Settings.js';

/**
 * Workbench shell: bootstrap, page routing, the current-account selector and the shared context.
 *
 * Account creation, import and synchronization live on the accounts page (Sprint 20a); the header
 * keeps only the current-account selector plus a `管理账号` shortcut, so no form opens globally and
 * navigating never triggers an account or sync action by itself.
 */
export function App({ onExit }: { onExit: () => void }) {
  const bootstrap = useRequest('bootstrap', {});
  const [page, setPage] = useState<PageName>('today');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [problemKey, setProblemKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const navigate = (next: PageName, key?: string) => {
    setPage(next);
    if (key !== undefined) setProblemKey(key);
  };
  /** A newly selected account invalidates the open problem detail and the candidate selection. */
  const selectAccount = (next: string | null) => {
    setAccountId(next);
    setProblemKey(null);
    setSelectedKeys([]);
  };
  return (
    <div className="icpc-root">
      <header className="icpc-header">
        <div className="icpc-brand">
          <span className="icpc-mark">IC</span>
          <div>
            <strong>ICPC 训练</strong>
            <small>每一步都有依据</small>
          </div>
        </div>
        <div className="icpc-header-actions">
          <label className="icpc-account">
            当前账号
            <select
              aria-label="当前账号"
              value={accountId ?? ''}
              onChange={(event) => selectAccount(event.target.value || null)}
            >
              <option value="">未选择账号</option>
              {bootstrap.data?.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName ?? account.handle} · {account.sourceInstanceId.split(':')[0]}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => navigate('accounts')}>管理账号</button>
          <button onClick={onExit}>返回对话</button>
        </div>
      </header>
      <nav className="icpc-nav" aria-label="训练工作台">
        {(
          [
            ['today', '今日训练'],
            ['bank', '题库'],
            ['accounts', '账号与同步'],
            ['review', '标签审核'],
            ['weakness', '薄弱项'],
            ['plans', '训练计划'],
            ['settings', '设置'],
          ] as const
        ).map(([id, title]) => (
          <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
            {title}
          </button>
        ))}
        <span>{bootstrap.data?.settings.value.provider ?? '正在连接'} · max</span>
      </nav>
      <main className="icpc-content">
        <ErrorNotice error={bootstrap.error} />
        {Boolean(bootstrap.error) && <button onClick={bootstrap.refresh}>重试连接</button>}
        {bootstrap.pending && !bootstrap.data && <Empty>正在加载训练工作台…</Empty>}
        {bootstrap.data && (
          <WorkbenchContext.Provider
            value={{
              boot: bootstrap.data,
              accountId,
              selectAccount,
              refresh: bootstrap.refresh,
              navigate,
              problemKey,
              selectedKeys,
              setSelectedKeys,
            }}
          >
            <div key={accountId ?? 'anonymous'}>
              {page === 'settings' ? (
                <Settings />
              ) : page === 'accounts' ? (
                <Accounts />
              ) : page === 'bank' ? (
                <Bank />
              ) : page === 'review' ? (
                <Review />
              ) : page === 'weakness' ? (
                <Weakness />
              ) : page === 'plans' ? (
                <Plans />
              ) : (
                <Today />
              )}
            </div>
          </WorkbenchContext.Provider>
        )}
      </main>
      <footer className="icpc-footer">本地数据 · 证据复核 · 原始标签与人工判断分别保留</footer>
    </div>
  );
}
