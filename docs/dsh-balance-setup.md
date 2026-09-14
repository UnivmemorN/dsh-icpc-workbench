# DeepSeek balance plugin setup (ICPC workbench)

> **开发参考** · [开发文档索引](development/README.md) · 日常操作请看[用户手册](user/README.md)。本文保留既有地址，供实现与排错核对。


`@lemcae/dsh-balance` is an optional companion plugin that shows the DeepSeek Open Platform balance
and an estimated session spend. It is installed per profile; it is never installed globally and it is
not part of the ICPC workbench bundle.

## Install per profile

```powershell
# once per profile, if it does not exist yet
dsh --profile <profile> --from-default-profile web --help

# add the package archive to that profile only
dsh plugin --profile <profile> add <path-to-tgz>
```

Restart the web UI for that profile afterwards. The plugin is a normal `dsh` bundle row discovered
from its own `package.json` `dsh.client` metadata; no harness change and no bundle YAML edit is
needed.

Because the package is published against an earlier baseline, apply the local compatibility patch
before packing. On the tested host, first use the already host-compatible `0.1.7-icpc-compat.1`
package: this client-only script does not remove the old `settingsNamespace` host helper from a fresh
upstream archive. An unmodified upstream host half can still fail activation even after the client patch:

```powershell
node scripts/patch-balance-client.mjs <unpacked-package-directory>
```

The script is idempotent and refuses unexpected package contents; see `LOCAL-COMPATIBILITY.md`.
Always install a **fresh archive filename** for a new version — an installer may keep a cached file
archive when the path and version are unchanged.

## Where the balance surfaces appear over ICPC

* **Global Settings dialog (the surface to use).** Open it from the lower-left corner, then
  **Settings → DeepSeek 余额**. This dialog is rendered by the web app shell and opens normally while
  the ICPC workbench panel is active, so the balance card (balance, estimated session spend, refresh
  interval, auto-refresh, language, editable price table) is reachable over ICPC.
* **Conversation header chip: not shown inside ICPC itself.** The chip is registered in the
  conversation header utility row of the standard conversation layout. The ICPC workbench takes over
  the main panel in its own mode and does not render that header row, so the chip does not appear
  there. This is expected; use the Settings card instead.

The Settings card needs a current session id: open a conversation first. With no session it shows the
fixed "open a session" hint instead of querying.

## Behavior guarantees

* The plugin asks the host for data through the existing `commands.execute` business command
  namespace. It makes no model request, creates no session and stores no credential.
* No new network destination, SQL access or security-policy change is introduced by the card or by the
  local compatibility patch.
* Failures are always reported with fixed localized copy plus a manual **retry** button in the
  Settings card. Arbitrary host or transport text is never echoed to the UI, and the card can no
  longer be stranded on "loading".
* The balance is returned by the official balance API. Only session spend is an estimate based on
  recorded tokens and the plugin price table; it is not the account bill.

## Troubleshooting

| Symptom | Cause / action |
| --- | --- |
| Card shows a fixed failure message and a retry button | The host command failed or returned no usable payload. Click **retry**; check that the profile is running and a session is open. |
| Card says no session | Open a conversation, then reopen Settings. |
| Balance never appears after upgrade | Confirm the installed archive is the patched `0.1.7-icpc-compat.2` build and that a fresh archive filename was used. |

## License and attribution

Original package author: **LemCAE**, MIT license — <https://github.com/LemCAE/dsh-balance>. The local
compatibility patch retains the original license and attribution.
