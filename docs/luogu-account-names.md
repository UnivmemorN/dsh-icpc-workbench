# Luogu account names in the workbench

Status: UI presentation implemented (Sprint Contract 22b2). The backend `luogu.profile` route this
document describes was implemented in the 22b1 round and is reported in
[stage-22b-luogu-nickname.md](reports/stage-22b-luogu-nickname.md). Live acceptance against the real
site is the coordinator's step; the worker ran only synthetic checks.

## What a Luogu account identity is

A Luogu account in this workbench is its numeric **UID** — the number after `/user/` in
`https://www.luogu.com.cn/user/<UID>` — never a nickname. The stored identity key stays
`sourceInstanceId|handle` with the canonical UID as `handle`, and the UI always states the UID next
to a nickname, for example `示例昵称 · UID 123456 · 洛谷`. A display name that is missing, blank or
identical to the UID is not presented as a name at all: the label falls back to the neutral
`洛谷用户` and the UID is shown separately. Duplicate nicknames therefore never make two accounts
indistinguishable.

## The public source that is read

The coordinator verified anonymously on 2026-09-14 that Luogu serves a public profile page at

    GET https://www.luogu.com.cn/user/<UID>

with the request header `x-lentille-request: content-only`. The plugin reads only `data.user.uid`
and `data.user.name` from that response. It never reads `root.user`, which is the viewer identity a
logged-in page may include, and it stores no biography, rating, scores, follower counts,
submissions, problem lists or any other profile content. Only the one nickname this plugin needs to
label the account is kept, next to the UID the user entered.

`https://www.luogu.com.cn/user/1` is Luogu's own account page, cited here only to identify the
endpoint. No profile body, page markup, avatar or dataset is copied into this repository or into the
plugin.

The read is public and anonymous: it needs no Cookie, no session and no password, it works before
any Luogu connection exists, and it never touches the credential vault. It calls no AI model — the
result is exactly what Luogu's page returned, re-validated against the requested UID and never
rewritten to look nicer. Luogu does not license or endorse this plugin.

## Own implementation

The adapter, the parser, the typed error sanitization and the UI flow here are independently written
from the observed public behavior above. No upstream implementation, HTTP client code or dataset is
copied. A refused read is rebuilt as one of the plugin's own typed failures: the transport answers
with a fixed short Chinese sentence, and the UI only ever renders its own fixed reason table — no
sample of the page, no raw body and no parser or server message can reach the screen.

## Where a nickname appears in the UI

- **Account list and current account** (`src/ui/Accounts.tsx`): the primary label is the nickname,
  or `洛谷用户`; the secondary text states `UID <handle>`. The current-account line keeps the same
  split so the UID is never read as a nickname.
- **Header selector** (`src/ui/App.tsx`): a Luogu option reads `nickname · UID <handle> · 洛谷`.
  The account's platform is resolved from the real `boot.sources` list, never parsed from the opaque
  instance id; the other platforms keep their previous option text.
- **Luogu connection panel** (`src/ui/LuoguSync.tsx`): the summary line separates the account label
  from「洛谷 UID」instead of printing the UID twice.
- **「刷新洛谷昵称」** on the selected Luogu account: one explicit, manual refresh with a busy state. A
  failure keeps the stored binding and the current name and shows a short actionable reason that can
  simply be retried.
- **One automatic attempt** on entering the accounts page (or selecting a Luogu account) when the
  account shows no distinct nickname. It runs once per mounted page, never in a retry loop when the
  bootstrap is re-read, and it never replaces a distinct custom nickname — only the explicit button
  may do that. An aborted page or a replaced selection drops its answer instead of applying it.
- **Adding a Luogu account** (`AddAccountForm`): the public read is attempted *before* the account is
  selected, because selecting it unmounts the form and would abort the read. Success refreshes the
  bootstrap and then selects the account; a refusal keeps the saved binding and shows
  「账号已添加，昵称暂未获取」with one explicit retry. It never deletes and recreates the account and
  never reports the nickname failure as a create failure.

## Limitations

- The public read shares the account's one Luogu source slot and can answer `busy` while a
  synchronization or connection operation is running; Luogu may also rate-limit anonymous reads.
  Both surface as the same actionable retry notice.
- Luogu can change or remove the endpoint, or return a page shape this plugin does not recognize.
  That is a typed refusal, not an invented nickname.
- Worker checks use synthetic data. The coordinator’s packaged and live checks are recorded in
  [Stage 22 acceptance](reports/stage-22-acceptance.md).
