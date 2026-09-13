# Stage 08a: account guidance

The compact add-account form asked for "数字 UID" or "Handle" with no explanation, so a first-time user could paste an email, a nickname or a look-alike URL and get an opaque `invalid_input`. The form is now a Chinese onboarding step that explains what each platform's identifier is and next step that obtains records. This stage is UI-only plus one pure module; no backend, API, adapter, schema or version change.

## What changed

- `src/ui/account-input.ts` (new, pure): per-platform guides (label, placeholder, help text, inert example), the shared save note, stable `aria-describedby` ids, and `checkAccountInput(platform, raw)`, which returns `empty`, `invalid` with an actionable message, or `valid` with the identifier to submit.
  - Accepts the bare identifier or the official profile URL and parses locally; nothing is ever fetched.
  - URLs are accepted only as `http`/`https` on an exact official hostname (`codeforces.com`, `www.codeforces.com`, `luogu.com.cn`, `www.luogu.com.cn`) with a path of exactly `/profile/<handle>` or `/user/<uid>` plus optional trailing slash, query and hash.
  - Refused with distinct messages: embedded credentials, explicit ports (the raw authority is inspected because `new URL` hides `:443`), non-http(s) schemes, deceptive/foreign/subdomain hosts, the other platform's link (names the platform to switch to), percent-encoded separators (`%2F`, `%5C`), wrong paths on the right host, and malformed identifiers.
  - Identifier rules mirror the adapter factories: outer whitespace trimmed, Codeforces `3–24` of `[A-Za-z0-9_.-]` with the user's spelling preserved for the API, Luogu canonical `[1-9][0-9]{0,19}` (no zero, no leading zero, at most 20 digits).
- `src/ui/App.tsx`: platform-specific label/placeholder/help wired through `aria-describedby`, inline validation with `aria-invalid` and a referenced `role="alert"` message, submit disabled until valid and while busy (no double submit), field and API error preserved on failure, platform switch clears the field and the stale error, and a successful `account.create` selects `result.account.id`, clears the previous problem key and selected keys, and refreshes the bootstrap list. The examples are separated text/anchor only, never field values, so a real account cannot be created from them.
- `src/ui/styles.ts`: appended `.icpc-add-account` grid/field/help/error styles, a mobile single-column fallback and a dark-mode error colour. No existing rule was removed.
- `tests/ui/account-input.test.ts` (new): 14 pure tests over bare and URL input, whitespace, query/hash/trailing slash, platform mismatch, deceptive hosts, credentials, ports (including `:443`), wrong paths and schemes, encoded separators, UID zero/leading zero/too-long, invalid Codeforces handles, guide copy and the inert examples.
- `docs/reports/stage-08a-account-guidance.md` (this report).

## Commands actually run

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/ui/account-input.test.ts"` | 14 pass, 0 fail |
| `npm run typecheck` | pass |
| `node --experimental-strip-types --import ./tests/loader.mjs --test --experimental-test-isolation=none "tests/ui/*.test.ts"` | 23 pass, 0 fail |
| `npm run check:architecture` | pass |

## Open issues

- None known. The full `npm run check`, the build/`check-client` gate and the installed-browser pass (form layout, screen-reader description order, example link inertness, account selection after save) remain with the coordinator; they were not run here.
- Deep links beyond the profile path are deliberately not resolved to an account (for example a submissions page), as the contract requires the exact profile path.
