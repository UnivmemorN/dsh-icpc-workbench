# Manual interchange v1 (offline import)

The manual import turns a user-authored file into validated domain records. It is a **file**
format, not a platform download: parsing performs no request, and every `http(s)` URL in a
document is stored as attribution only and is never fetched.

Two entry points (both pure, both returning a complete document or an explicit error list):

```ts
parseManualJson(text, { importedAt? }) -> { ok: true, document } | { ok: false, errors }
parseManualCsv(text, { kind, source, accounts?, problems?, editorials?, importedAt? }) -> same
```

Nothing is written or partially applied: either the whole document validates (and is deeply
frozen and content-hashed), or the caller gets every rejection that was found.

`contentHash` covers every semantic field of the parsed document — source (including
`displayName` and `baseUrl`, even when the derived id is unchanged), accounts, problems,
submissions and each editorial entry with its source/solution ids, kinds, titles, languages,
availability, notes and derived content hashes — and excludes only observation timestamps
(`importedAt`, `fetchedAt`, `retrievedAt`). Re-parsing identical text therefore stays
hash-stable, while editing any metadata changes the hash and invalidates cursors captured from
the earlier document.

## JSON document (version 1)

Exact top-level shape; every field is required, unknown fields are rejected recursively:

```json
{
  "schemaVersion": 1,
  "source": { "platform": "manual", "baseUrl": "https://manual.example.test", "displayName": "My notes" },
  "accounts": [],
  "problems": [],
  "submissions": [],
  "editorials": []
}
```

### `source`

| field | required | notes |
| --- | --- | --- |
| `platform` | yes | `manual`, `codeforces`, `luogu` or `hydro` (import-only; no live Hydro adapter) |
| `baseUrl` | yes | absolute `http(s)` URL, no userinfo |
| `domain` | no | defaults to the host of `baseUrl`; the stable id is `platform:domain` |
| `displayName` | no | defaults to `platform (domain)` |
| `id` | no | **verified**, not derived from input: when present it must equal `platform:domain` |

The source decides every identity in the document. A Codeforces supplemental import therefore
keeps `codeforces:codeforces.com` problem/account identities and is never relabelled as manual.

### `accounts[]`

`handle` (required) plus optional `displayName` and `profileUrl` (absolute `http(s)`, no
userinfo). A Codeforces handle is canonicalised case-insensitively with the Codeforces adapter's
own helper: `Tourist` becomes handle `tourist` (original spelling becomes `displayName` when no
explicit one is given), so an imported account keeps exactly the identity the live adapter
derives. Other platforms keep the handle verbatim.

### `problems[]`

`externalKey` (required, opaque, preserved exactly), `title` (required), `url` (required,
attribution), and optional `domain` (nullable), `statement`, `rawTags`, `ratings`. The source
instance is implicit — a `sourceInstanceId` field is not part of the schema.

`ratings[]` preserves the platform's raw dimension: `{ dimension, value, raw, scale? }`, where
`value` is a finite number or the platform's textual form and `scale` is `{ min, max }` with
`min <= max` when present.

### `submissions[]`

`accountHandle`, `externalKey`, `externalId`, `verdict` and `submittedAt` are required; optional
`domain` (must match the problem's), `language`, `timeMs`, `memoryKiB`. `verdict` is one of the
domain's `SubmissionVerdict` values. `submittedAt` must be ISO-8601 **with a timezone** and a
real calendar date (`2024-02-30T00:00:00Z` is rejected, not rolled over). `timeMs` must be a
non-negative safe integer when present. `memoryKiB` must be a non-negative finite number and may
be fractional: platforms such as Codeforces report bytes/1024, so `1.0009765625` is valid domain
data and is preserved exactly, never rounded. `null`, negative, `NaN` and infinite numbers are
rejected.

### `editorials[]`

Each record binds one problem (`domain` + `externalKey`) and declares one of:

- `status: "found"`: `url`, `title` and one-or-more `solutions` (`title`, `text`, optional
  `language`) are required. Solution text is stored verbatim (newlines and quotes included); the
  derived editorial source id is `manual-editorial-<sha256(problemKey, url)>`, and the source's
  content hash covers the declared solution texts joined by a blank line.
- `status: "absent"`: a **deliberate user declaration**. `note` must be non-empty and no
  solutions may be present. A blank or missing note is rejected.

A problem with no editorial record stays `status: "unavailable"`. Absence is never inferred from
an empty field, and an empty `editorials` array simply means "nothing was declared".

## CSV tables

`kind: "problems"` and `kind: "submissions"` use the exact column sets below. Column order is
free, names are exact (surrounding whitespace is trimmed), every listed column must be present,
and extra or duplicated columns are rejected. Quoted commas, doubled quotes (`""`), multiline
cells, a UTF-8 BOM and blank lines are supported. Empty lines are skipped; a row with the wrong
number of fields is an error. A table with more than the row limit is rejected as `too_many_rows`
(parsing stops one record past the limit) — rows are never silently truncated into a valid import.

| kind | columns |
| --- | --- |
| `problems` | `domain`, `externalKey`, `title`, `url`, `statement`, `rawTags`, `ratings` |
| `submissions` | `accountHandle`, `domain`, `externalKey`, `externalId`, `verdict`, `submittedAt`, `language`, `timeMs`, `memoryKiB` |

`rawTags` and `ratings` cells contain the JSON form of the corresponding JSON-document field
(`["dp"]`, `[{"dimension":"difficulty","value":3,"raw":"3"}]`); an empty cell means the field is
absent and an invalid JSON cell is reported as `invalid_json` with row and field. The source and
account/problem references come from `options`; already-normalised domain records may be passed
as context and are validated for coherence and copied. Editorials are JSON-only.

## Limits and errors

| limit | value |
| --- | --- |
| input text | 8 MiB UTF-8 |
| rows per array/table | 10 000 |
| statement / solution text | 200 000 characters |
| every other string | 2 000 characters |
| adapter `limit` | 1..500 |

An issue carries `code`, `message`, `path` (for example `$.problems[0].ratings[0].value`),
`row` (1-based row inside its array/table; CSV data rows exclude the header), `line` (the physical
line where the CSV record *starts*, so a multiline quoted cell or a skipped blank line never
shifts it) and `field`. Duplicate account/problem/editorial identities are `duplicate_id`;
duplicate submissions are `duplicate_row` when identical and `duplicate_conflict` when they
differ — identical rows are reported, never silently merged. Credential-looking fields (for
example `token`, `cookie`, `apiKey`) are rejected as `secret_field`, and no credential is part of
the schema.

## Adapter

`createManualPlatformAdapter(document)` implements `PlatformAdapter` over the frozen document:
no IO, no network, `requiresAuth: false`, and `notes` state the offline/manual origin. Paged
reads return owned, frozen clones; missing detail is a typed `unavailable` error; cursors are
opaque tokens bound to the document content hash, resource, source instance, account and `since`
bound; cancellation is observed before any cached array is read. `materialFor(ref)` /
`listMaterials()` expose problem + editorial + submissions for a later import service without
persisting anything.

## Example (original and synthetic)

```json
{
  "schemaVersion": 1,
  "source": { "platform": "manual", "baseUrl": "https://manual.example.test", "displayName": "My notes" },
  "accounts": [{ "handle": "alice", "displayName": "Alice" }],
  "problems": [
    {
      "externalKey": "sample-1",
      "title": "Sample: Count Pairs",
      "url": "https://manual.example.test/p/sample-1",
      "statement": "Given a list of small integers, count the unordered pairs that sum to zero.",
      "rawTags": ["hashing"],
      "ratings": [{ "dimension": "difficulty", "value": 2, "raw": "2" }]
    }
  ],
  "submissions": [
    {
      "accountHandle": "alice",
      "externalKey": "sample-1",
      "externalId": "run-1",
      "verdict": "accepted",
      "submittedAt": "2024-05-01T10:00:00Z",
      "language": "C++",
      "timeMs": 12,
      "memoryKiB": 1024
    }
  ],
  "editorials": [
    {
      "externalKey": "sample-1",
      "status": "found",
      "url": "https://manual.example.test/e/sample-1",
      "title": "Counting pairs with a frequency map",
      "solutions": [{ "title": "Frequency map", "text": "Count each value, then look up its negation.", "language": "en" }]
    }
  ]
}
```

The matching CSV tables (problems first, then submissions for the same source):

```csv
domain,externalKey,title,url,statement,rawTags,ratings
,sample-2,"Sample: ""A + B""",https://manual.example.test/p/sample-2,"Read two integers
and print their sum.","[""implementation""]","[{""dimension"":""difficulty"",""value"":1,""raw"":""1""}]"
```

```csv
accountHandle,domain,externalKey,externalId,verdict,submittedAt,language,timeMs,memoryKiB
alice,,sample-2,run-2,wrong_answer,2024-05-02T09:30:00Z,C++,,
```
