# P6 — Device sync over Life Hub (design; Hub side deployed, apps 2–4 merged, stage 5 in review)

> **Status (2026-11-04).** Stage 1 (Hub side) is deployed (PR #34; migration `0009_sync.sql` applied to the remote D1).
> In the app repositories, stage 2 (animan), stage 3 (letterbookxd) and stage 4 (elosorter, PR #26) are merged to
> `main`; stage 5's code part (elosorter PR #27, removes the Supabase code) is open. This repository does not see the
> apps' deployments: whether a given device syncs depends on that app being deployed and connected (and, for
> elosorter, on `HUB_ELOSORTER_REDIRECT_URI` being set here). The Supabase side of stage 5 (backup, remove the
> `anon` policy, delete the keys) is the owner's manual step in the Supabase dashboard and is not done by any code.
> Two decisions made while implementing: the sync scope of an app that also has an inbox is **opt-in** (a checkbox
> on the consent page, so reconnecting never silently widens a grant; resolves open question 4), and the version is
> carried in the response body rather than an `ETag` header (CORS (Cross-Origin Resource Sharing, 교차 출처 리소스
> 공유) would need `Access-Control-Expose-Headers`).

## 1. Goal

Let the owner's own apps keep the same personal data on several devices, **through Life Hub**, instead of Supabase
or hand-carried JSON (JavaScript Object Notation, 자바스크립트 객체 표기법) files.

Non-goals: real-time push, several owners, sharing, Hub-side understanding of app data, replacing the manual JSON
export (it stays as the escape hatch), syncing catalogue edits, a dashboard (separate design).

## 2. Where the apps are today (default branches, read on 2026-11-03)

| App | Data | Device-to-device today |
| --- | --- | --- |
| elosorter | One session (`SessionData` v2: tracks, matches, tiers; "can reach several MB" per its own code comment), `localStorage` | **Supabase** auto backup (`elo_state`, anon key, Row Level Security (RLS, 행 수준 보안) set to allow everything for `anon`, one user per project — its README warns about this) plus a manual JSON file |
| animan | `{ [seriesId]: string[] }` completed ids, `localStorage`; catalogue is bundled JSON | Manual backup file `{ app, version: 1, exportedAt, progress }`; import is `merge` (union) or `replace`, with a preview |
| letterbookxd | Reading logs in IndexedDB (`LogRecord`: `id`, `logType`, ids, `createdAt`, `updatedAt` …); catalogue bundled, local override optional | Manual backup file `{ app, version: 1, exportedAt, logs, catalogOverrides? }`; import is planned as added / unchanged / conflicts (`same-id`, `same-target`), then `skip` or `overwrite` for all conflicts |

Observations that shape this design:

- animan and letterbookxd keep their merge logic in **pure functions** (`mergeProgress`, `planImport`), so a sync
  client can reuse them.
- Neither app has **deletion markers**. Un-marking an episode or deleting a log is invisible to a union/record
  merge, so a naive automatic sync would resurrect deleted data. Section 6 fixes this.
- animan and letterbookxd are already Life Hub destinations with an OAuth (Open Authorization, 개방형 인증) public
  client (`public/lifehub-client.json`, PKCE) and a `/animan` / `/letterbookxd` resource. elosorter is not a
  destination yet and has no candidate types.

## 3. Principles

1. **Local first.** `localStorage` / IndexedDB stays the working copy. Life Hub is a mirror the app reads and writes
   in the background. Offline use must keep working; a failed sync never blocks the app.
2. **The Hub judges versions, not content.** It stores one opaque JSON document per (owner, destination), checks
   size and a minimal shape, and decides only "is your base version still the newest?". Merging happens in the app,
   with the app's own rules (section 6). Destination logic stays out of the generic Hub contract.
3. **Never overwrite silently.** Every write is conditional on the version the client last saw.
4. **Private by construction.** Documents live only in D1, never in a repository, a Pages bundle, a log line or an
   error message.
5. **History is append-only.** A restore is a new version containing old content.

## 4. How this meets the AGENTS.md checklist

| Required by AGENTS.md | Design |
| --- | --- |
| Authenticated user identity | Same OAuth authorization server and owner password as today. The owner id comes from the validated token's props (`HUB_OWNER_ID`), never from the request body. |
| Persistence | New D1 table `sync_docs` (section 5), append-only versions, last N kept. |
| Private storage | D1 only; `Cache-Control: no-store`; no body in logs or errors (same convention as `worker.js`). |
| Revocation | A per-destination scope `<app>:sync`; revoking the OAuth grant stops access. Rotating `HUB_OWNER_ID` invalidates every token (existing `guard`). Owner can `DELETE` a destination's documents. |
| Replay protection | A write needs `If-Match: "<version>"`. A replayed request carries an old version and gets `412`. A retry of a write that *did* commit also gets `412`; the client detects its own content through `sha256` (section 5) and treats it as success. |
| Conflict recovery | `412` returns the current meta; the client re-reads, merges, writes again. Last N versions stay readable, and a restore is a new version. D1 Time Travel (7 days on the free plan, per Cloudflare's D1 limits page) is a second layer. |

## 5. API

One resource per destination, under the destination's existing path, e.g. `/animan/v1/sync`. Authentication:
`Authorization: Bearer <token>` with scope `<app>:sync`. All bodies `application/json; charset=utf-8`.

| Request | Meaning | Success | Errors |
| --- | --- | --- | --- |
| `GET /<app>/v1/sync` | Newest document: `{ version, sha256, size_bytes, written_at, device, doc }` | 200 | 404 none yet |
| `GET /<app>/v1/sync/meta` | Same without `doc` (cheap check before downloading) | 200 | 404 |
| `PUT /<app>/v1/sync` | Body = the document. `If-Match: "<version>"` to replace, or `If-None-Match: *` for the first write. Optional `X-Device-Label` (≤ 40 chars, display only, never authentication). | 200 `{ version, sha256, size_bytes, written_at, device }` | 400 invalid document, 412 stale (body has current meta), 413 too large, 415, 428 no precondition header |
| `GET /<app>/v1/sync/versions` | Meta of the kept versions, newest first | 200 | — |
| `GET /<app>/v1/sync/versions/<n>` | One kept version, like `GET /sync` | 200 | 404 |
| `DELETE /<app>/v1/sync` | Remove every version of this destination (owner decision; needs `If-Match`) | 204 | 412 |

Rules:

- `version` is a per-(owner, destination) integer that increases by exactly 1 per successful write.
- Size cap per document: **1 MiB of UTF-8 bytes** (D1 limits a row to 2,000,000 bytes; Hangul is 3 bytes per
  character, so the cap is checked in bytes in code, with a character-count `CHECK` in SQL as a second guard).
  Per destination the registry may lower it.
- Validation is minimal and lives in `src/sync/checks.js`, **not** in the destination adapters: the body must be a
  JSON object, and a small per-app check runs (animan and letterbookxd: `app` equals the destination and `version`
  is a supported number; elosorter: `version === 2` and `tracks` is an array). Unknown extra fields are allowed
  because the app owns its format.
- Per-destination write limit: none beyond the size cap in v1, but clients must debounce (section 7).

### Storage

Migration `0009_sync.sql` (new file; earlier migrations are untouched):

```sql
CREATE TABLE IF NOT EXISTS sync_docs (
  owner_id    TEXT    NOT NULL,
  destination TEXT    NOT NULL CHECK (length(destination) BETWEEN 1 AND 40),
  version     INTEGER NOT NULL CHECK (version >= 1),
  body_json   TEXT    NOT NULL CHECK (length(body_json) <= 1048576),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes BETWEEN 2 AND 1048576),
  sha256      TEXT    NOT NULL CHECK (length(sha256) = 64),
  device      TEXT    CHECK (device IS NULL OR length(device) <= 40),
  written_at  TEXT    NOT NULL,
  PRIMARY KEY (owner_id, destination, version)
);
```

The conditional write is one statement; success means exactly one row changed. The primary key is the safety net if
two writers race (a unique violation is reported as `412`):

```sql
INSERT INTO sync_docs (owner_id,destination,version,body_json,size_bytes,sha256,device,written_at)
SELECT :owner, :dest, :base + 1, :body, :size, :sha, :device, :at
WHERE COALESCE((SELECT MAX(version) FROM sync_docs WHERE owner_id = :owner AND destination = :dest), 0) = :base;
```

(`:base` is 0 for the first write. The implementation may bind positionally, like `store.js` does.) After a
success, in the same `db.batch`: `DELETE FROM sync_docs WHERE owner_id=? AND destination=? AND version <= :newVersion - :keep`.
`keep` defaults to 10 and lives in the registry entry. D1's free database limit is 500 MB, so
3 apps × 10 versions × ≤ 1 MiB fits easily.

## 6. Merge rules (the contract each app implements)

The merge function is pure, deterministic and commutative where possible, so devices converge in any order. Clock
skew: when a client stamps a time, it uses `max(now, serverWrittenAtOfItsBaseVersion + 1 ms)`, so a skewed device
cannot stamp "before" something it has already seen.

### animan (pilot)

Progress becomes **v2**, an item map instead of an array, so un-marking can travel:

```json
{ "app": "animan", "version": 2, "exportedAt": "…",
  "progress": { "<seriesId>": { "<itemId>": { "done": true, "at": "2026-11-03T09:00:00.000Z" } } } }
```

- Per item, Last-Writer-Wins (LWW, 마지막 쓰기 우선) by `at`; equal `at` → `done: true` wins (adding is the lesser harm).
- `done: false` entries are tombstones, kept **180 days**, then dropped when writing.
- A device that has not synced for more than 180 days must not auto-merge: it goes through the review in section 7
  ("Coming back after 180 days") before syncing again.
- Existing **local** v1 progress (no `exportedAt`) converts once to v2 with every id `done: true` and `at` = the Unix
  epoch (`1970-01-01T00:00:00.000Z`), so any real mark or un-mark from another device wins over it. The v1 value stays
  in storage untouched as the rollback copy.
- Every path that changes progress (toggle, "up to here", bulk marks, approving a Life Hub proposal, manual import
  `merge`/`replace`) writes stamped v2 entries; an item a `replace` import removes becomes a tombstone.
- Tombstone pruning depends on the current time, so it happens only just before writing, never inside the merge
  function (the merge must stay pure for the commutativity/associativity tests).
- v1 backup files stay importable (every id becomes `done: true`, `at = exportedAt`); the v1 *export* stays available
  and simply omits tombstones.

### letterbookxd

Only **logs** sync. The catalogue override stays device-local (it has its own `baseHash` flow and is published by
committing `catalog.json`).

```json
{ "app": "letterbookxd", "version": 2, "exportedAt": "…",
  "logs": [ /* LogRecord, unchanged */ ],
  "tombstones": [ { "id": "…", "targetKey": "volume:…", "deletedAt": "…", "supersededBy": "…" } ] }
```

Merge is **last-writer-wins per target** (`targetKey`: `volume:<volumeId>`, `set:<editionSetId>`,
`series:<seriesId>`). Every record and every tombstone is an *event* of its target, timed by `updatedAt` (record) or
`deletedAt` (tombstone). This one rule covers the same-id, tombstone and `same-target` cases and is commutative,
associative and idempotent, because the result depends only on the set of events seen:

1. Per `id`, keep one record version (later `updatedAt`; tie → larger canonical-JSON string) and one tombstone
   (later `deletedAt`; tie → larger canonical-JSON string).
2. Per target, the **winner** is the latest event. Ties: a record beats a tombstone (adding is the lesser harm, as
   in animan), then the larger canonical-JSON string wins.
3. Winner is a record → it is the target's only live record. Every other id of that target becomes (or stays) a
   tombstone with `deletedAt` = the winner's `updatedAt` and `supersededBy` = the winner's id.
   Winner is a tombstone → the target has no live record; every id of it becomes a tombstone with `deletedAt` = the
   winner's `deletedAt` and `supersededBy: null`. (So deleting a volume's log on one device also removes an older
   log of the same volume that another device created offline.)
4. Derived tombstones never carry a time later than the winner, so they never change a later merge's winner.

"Canonical JSON" = keys sorted, no whitespace, `pickLogRecord` fields only. A record whose `targetKey` cannot be
computed, or a tombstone without `targetKey`, is dropped by the merge (and reported by the import preview).

Every local change stamps `updatedAt` with the clock rule above, including metadata edits (`createdAt`, rating,
like) and the completion cascade. Every local delete (single log, all logs of a work, a cascade removing a set or
series completion, an `overwrite` import) writes a tombstone instead of only removing the row. After a merge is
applied, the app runs its normal completion cascade; anything that changes is an ordinary local edit with a fresh
stamp, and two devices that both re-derive the same completion converge through rule 3.

- Tombstones are kept 180 days, same rule as above.

### elosorter

The session is one document that is naturally edited on one device at a time, so it keeps its existing conflict
model, with the server `version` in place of the old `savedAt`/`syncedAt` pair:

- The app stores `syncVersion` (the version its local copy was based on). Upload with `If-Match: "<syncVersion>"`.
- On `412`, the app enters its existing `conflict` state and asks "use the cloud version / overwrite with this
  device". It never auto-uploads in `conflict`. "Overwrite" is a `PUT` with `If-Match` set to the version the
  conflict showed, so a third write in between is still caught.
- Optional later improvement: union the append-only `matches` list automatically when both sides only added.
- `ownerId` (Spotify user id) stays as the existing "blocked: another account's session" sanity check.
- **Size first.** The document must stay JSON with `version: 2` and a `tracks` array (the Hub's shape check), so it is
  not compressed. The sync document leaves out fields the app recomputes on load `rating` and `sigma` on each track (the only
  derived fields in its session format) and nothing else. The app shows the document's UTF-8 size; over **900 KiB**
  (headroom under the 1 MiB cap and the Worker's per-request CPU time) it does not sync automatically and tells the
  owner. Whether to add gzip or R2 is an owner decision after measuring a real session (open question 1).
- Supabase: stage 4 stopped writing `elo_state` once Life Hub sync had succeeded. Stage 5 (elosorter PR #27) removes
  the Supabase read and write code altogether, so after it nothing in the app can copy from Supabase: move a session
  to Life Hub from another device that already syncs, or from the manual JSON file (which stays).

## 7. Client behaviour (all apps)

- **Pull** on app start and when the tab becomes visible again; **no polling**.
- **Push** after a change with a debounce (elosorter's current 15 s idle / every 10 changes is a good model) and on
  `visibilitychange` → hidden. Never push while a merge is in progress.
- Loop: `GET` → merge → `PUT If-Match`; on `412`, repeat, at most 3 times, then show "will retry".
- Treat a `412` whose current `sha256` equals the hash of what you just sent as success (replay of a committed write).
- A `412` whose `current` is `null` means the document was deleted: write again with `If-None-Match: *`.
- Before retrying a `PUT` whose response never arrived, read `/sync/meta` and compare its `sha256` with the hash of
  the exact UTF-8 bytes sent (keep the sent string; re-serialising may change the hash).
- A sync route answers `403` with `WWW-Authenticate: … error="insufficient_scope"` when the token has the inbox
  scope only (the owner did not tick the sync checkbox). Clients must show "sync not allowed, reconnect" and **keep
  the token**: the inbox still works with it. Other `403`s (role or owner mismatch) mean the grant is unusable.
- `X-Device-Label` must be 1–40 printable ASCII characters after trimming; an empty label is a `400`, so omit the
  header instead.
- `400`, `415` and `428` are client bugs: stop and report, do not loop. `413`: tell the owner and stop automatic push.
- Keep the manual JSON export/import. It is the disaster-recovery path and works with no Life Hub at all.
- Keep the debounce. The free-plan limits were checked on 2026-11-04 (section 7, "Exact values") and leave a wide
  margin, but they are daily and shared by every app.

### Exact values every client uses

This list is the whole client contract. A behaviour that is neither here nor elsewhere in this document is **not
defined**: the client picks the most conservative option (never deletes or overwrites local data, never retries a
write in a loop, never sends more than it must) and lists it under "Not in the contract" in its pull request, without
changing Life Hub. Values below were read from this repository and from `@cloudflare/workers-oauth-provider` 1.2.4
(the version pinned in `package.json`); if that version changes, re-check them.

**OAuth (Open Authorization, 개방형 인증)**

| Item | Value |
| --- | --- |
| Issuer / origin | the deployed `HUB_PUBLIC_ORIGIN` (today `https://life-hub-api.213303.workers.dev`) |
| Authorize | `GET <origin>/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`, `resource=<origin>/<app>` |
| Scope to request | apps with an inbox: `<app>:inbox <app>:sync`; sync-only apps (elosorter): `<app>:sync`. What is **granted** is decided on the consent page (the sync checkbox), so read it from the token response |
| Token | `POST <origin>/oauth/token`, `application/x-www-form-urlencoded`, public client (no secret): `grant_type=authorization_code` with `code`, `redirect_uri`, `code_verifier`, `client_id`, `resource`; or `grant_type=refresh_token` with `refresh_token`, `client_id` |
| Token response | `{ access_token, token_type: "bearer", expires_in, refresh_token, scope }`; `scope` is space-separated and is present on both grants |
| Access token lifetime | 3,600 s (library default; Life Hub sets no override). Use `expires_in`; refresh about 60 s early |
| Refresh token | Each refresh returns a **new** refresh token: store it. The previous one stays valid until the next refresh (one-step grace for a lost response) |
| Grant lifetime | **No practical expiry** (owner decision 2026-11-04): no absolute lifetime (`refreshTokenTTL: undefined`) and a 10-year idle lifetime that restarts on every refresh (`refreshTokenIdleTTL`), set in `src/server/index.js`. A grant issued before this change still carries the old library default (30 days from consent) until its next refresh, which moves the expiry to 10 years from then; a grant that already lapsed needs one reconnect. Either way, a token endpoint `400 invalid_grant` means: drop the tokens, show "reconnect", keep sync settings and local data |
| Client registration (DCR, Dynamic Client Registration) | Only Claude, Codex and ChatGPT register with `POST <origin>/oauth/register`; destination apps use CIMD and are never stored. A registration made after this change **never expires** (`clientRegistrationTTL: undefined`, set in `src/server/index.js`). One made before it keeps the old library default (90 days from registration, not renewed any more), so that client reconnects once when it lapses |
| Revoke (disconnect) | `POST <origin>/oauth/token` with `token=<refresh token>`, `token_type_hint=refresh_token`, `client_id` (RFC 7009 form on the token endpoint; it has no `grant_type`). Revoking the refresh token revokes the whole grant. Always `200` with an empty body, also for an unknown token, so the client just drops its local tokens; failure to reach Life Hub is not an error |
| Client metadata document (CIMD, Client ID Metadata Document) | served at the `client_id` URL itself over public HTTPS (GitHub Pages is fine): `{ client_id: <that URL>, client_name, client_uri, redirect_uris: [<callback>], grant_types: ["authorization_code","refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }` |
| Callback | must equal the Life Hub variable `HUB_<APP>_REDIRECT_URI` **exactly** (scheme, host, path, trailing slash). Life Hub picks the consent profile by this value; a mismatch shows "not allowed" |

**Sync API (section 5)**

| Item | Value |
| --- | --- |
| Error body | `{ "error": "<fixed English text>" }`; `412` adds `"current": <meta or null>`. Clients branch on the status code only, never on the text, and never show the body |
| `403` | with `WWW-Authenticate: … error="insufficient_scope"` → no sync scope, keep the token. Any other `403` → grant unusable, drop the token |
| CORS (Cross-Origin Resource Sharing, 교차 출처 리소스 공유) | handled by the OAuth library: any origin, methods `*`, headers `Authorization, *`, `WWW-Authenticate` and `Retry-After` exposed. Nothing to configure in apps |
| Daily Cloudflare limit reached | D1 or Workers daily limits make requests fail with `500` (D1) or a Cloudflare `1027` error page (Workers; a browser usually sees it as a network error). Treat as "retry later" with backoff; limits reset at 00:00 UTC |
| `429` | only the consent page sends it (too many password attempts, `Retry-After` in seconds). The sync API does not; if one arrives anyway, treat it like `5xx` |
| Lost `PUT` response | apps that merge (animan, letterbookxd) need not persist it: the next pass merges and finds nothing to send. Apps that do not merge (elosorter) persist the sent body's `sha256` and check `/sync/meta` before sending again, even after a restart |
| Version history | Life Hub keeps the last 10 versions (`/sync/versions`). Apps are **not** required to show them; a restore UI is out of scope for stages 2–4 |
| Account check | Life Hub has one owner and does not know app-level accounts (e.g. Spotify). Cross-account protection is the app's own check (elosorter `ownerId`) |

**Cloudflare free plan (checked 2026-11-04 on Cloudflare's pricing/limits pages)**

| Resource | Free limit | Use by sync |
| --- | --- | --- |
| D1 rows written | 100,000 / day | ≈ 4 per `PUT` (insert + prune, each with its index row) |
| D1 rows read | 5,000,000 / day | 1–10 per request |
| D1 storage | 5 GB | ≤ 10 versions × 3 apps × 1 MiB |
| Workers requests | 100,000 / day | 1–3 per sync pass |
| Workers CPU time | 10 ms / request | the risk for large documents: parse + SHA-256 of ~1 MiB; hence elosorter's 900 KiB cap |
| KV writes | 1,000 / day (different keys) | token refreshes only (about one per app per device per active hour) |

### Coming back after 180 days (animan, letterbookxd)

Tombstones are dropped after 180 days, so a device that was away longer may still hold items that another device
deleted long ago. Merging it as usual would bring them back. Importing the server document into the local copy does
not help either, because an import only adds. The review therefore also has to **remove** those items.

Definitions:

- `F` (the floor) is the newest server `written_at` this device has seen, the same value the clock rule uses. A
  stale device has not seen a server time since its last successful sync, so `F` is the time of the server version
  it last synced with.
- An item is **unchanged since the last sync** when its time (`at` in animan, `updatedAt` in letterbookxd) is ≤ `F`.
  Every local edit after that sync was stamped at `F + 1 ms` or later.
- An item is **missing on the server** when the current server document has neither an entry nor a tombstone for
  it: in animan, no entry for that series/item; in letterbookxd, no record and no tombstone with that `id` **and**
  none for its `targetKey`.

Rule. A successful sync leaves every local item on the server, so an item that is unchanged since the last sync but
missing on the server now was deleted elsewhere and its tombstone has expired. The review:

1. Applies only when the server document exists (`GET` → 200) and `F` is known. With `404`, or with no `F` (the
   device never synced), the device syncs as on a first write and removes nothing.
2. Computes the items to remove (unchanged since the last sync **and** missing on the server) and the normal merge
   result for everything else, and shows both counts in the existing import preview, listing the items to remove.
3. Offers the manual JSON export of the current local data before applying, and applies only after the owner
   confirms.
4. Removes those items locally **without** writing tombstones (nothing on the server refers to them, and a fresh
   tombstone could hide a newer record on yet another device), merges the rest as usual, and then syncs normally.
5. Items changed after the last sync (time > `F`) are real offline edits and are never removed by this rule.

If the owner deleted the server document and another device then wrote a fresh one, step 2 lists many items to
remove. That is why the review shows the list and asks first: the owner can cancel, export, or turn sync off.

## 8. Changes in this repository (when implemented)

| Where | Change |
| --- | --- |
| `src/destinations.js` | Optional `sync: { app, scope: '<id>:sync', maxBytes, keep }` per entry. Allow **sync-only destinations** (elosorter): no `adapter`, `types` or card. Update the header comment. |
| `src/core/candidates.js` | **No change**: its `DESTINATIONS` set is candidate-only and must not include sync-only apps. |
| `src/adapters/index.js` | Unchanged; it must keep rejecting a destination without `adapter` (a sync-only id can never be a candidate). Add a test. |
| `src/auth/clients.js` | Profile `scopes` = the scopes that destination has (`[inbox]`, `[inbox, sync]` or `[sync]`); `ALL_SCOPES` gains the sync scopes. Consent text for `grants` mentions sync. |
| `src/server/index.js` | `OAuthResourceServer.requiredScopes` and `guard` become per-route: `…/sync*` needs the sync scope, inbox routes keep the inbox scope. |
| `src/sync/api.js`, `src/sync/store.js`, `src/sync/checks.js` | New; routes, D1 access, minimal shape checks. Routed from the inbox handler by path. |
| `migrations/0009_sync.sql` | New table (section 5). |
| `wrangler.example.jsonc`, `scripts/render-wrangler-config.mjs`, `.github/workflows/deploy.yml` | `HUB_ELOSORTER_REDIRECT_URI` (animan and letterbookxd already have theirs). |
| `package.json` `check` | Add new files (or switch the list to a glob). |
| `README.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` | Add the P6 status line when code lands; fix the stale "not implemented" wording at the same time. |

Existing connections carry only `<app>:inbox`; after deploying, each app needs **one reconnect** (「Life Hub 연결」)
to receive the sync scope.

## 9. Tests (`test/sync.test.js`, node:test, synthetic data only)

- Create with `If-None-Match: *`; replace with the right version; `412` with a stale version; `428` without a header.
- Two concurrent writers from the same base: exactly one wins, the other gets `412`.
- Replay of a committed write → `412`, and the returned `sha256` matches what was sent.
- `413` over 1 MiB measured in bytes (a Hangul-heavy document that is under the character limit but over the byte
  limit must be rejected).
- Wrong scope (inbox-only token) → `403`/step-up; a token of destination A cannot read destination B; a token for a
  rotated `HUB_OWNER_ID` is refused.
- Pruning keeps exactly `keep` versions; version list and restore-as-new-version work.
- No document content in any error body or `console` output.
- A sync-only destination id is rejected by `toDestinationCandidate` and by the candidate envelope validator.
- App-side (in each app's repo): merge property tests — commutative and idempotent where claimed, tombstone beats
  stale record, v1 backup import still works.

## 10. Rollout

| Stage | Scope | Done when |
| --- | --- | --- |
| 0 | This document reviewed | Owner accepts or edits it |
| 1 | Hub: migration, `/sync` API, registry support, tests. No app changes | `npm run check` green; deployed; manual `curl` round trip with a throwaway destination |
| 2 | **animan** (pilot): v2 progress format, tombstones, sync client, reconnect | Two browsers converge, including an un-mark |
| 3 | **letterbookxd**: logs + tombstones, `same-target` rule | Offline edit on two devices merges without losing either |
| 4 | **elosorter**: measure the real session size first (section 6). Over the limit → owner decides between gzip (needs a Hub shape-check change) and R2 (not bound today; R2's free tier is 10 GB-month) | Supabase `elo_state` no longer written |
| 5 | Retire Supabase for elosorter: remove the app's Supabase code (PR #27), then, by hand in the Supabase dashboard, back up `elo_state`, remove the `anon read/write` policy and delete the keys. The session reaches Life Hub from a syncing device or the JSON file, not from Supabase | The anon key can no longer read or write the table |

## 11. Open questions

1. How large is a real elosorter session (tracks × fields)? Decides gzip/R2 in stage 4. Synthetic measurement
   (elosorter PR #26): about 357 bytes per track and 55 bytes per comparison, so 900 KiB holds roughly 2,000 tracks
   with 4,000 comparisons. Owner to read the real size in elosorter's settings.
2. ~~Daily D1 write allowance on the free plan.~~ Checked 2026-11-04: 100,000 rows written per day (section 7).
3. Is 180 days the right tombstone retention for a device that may sit in a drawer (e.g. an old phone)? A device
   that comes back later goes through the review in section 7, so a longer retention only makes that review rarer.
4. ~~When is the sync scope requested?~~ Decided in stage 1: opt-in checkbox on the consent page for apps that also have an inbox; required for sync-only apps (elosorter).
5. Client-side encryption (a passphrase the owner types on each device) is out of scope; it would make a lost
   passphrase equal to lost data and would block the Hub's shape checks. Revisit only if the threat model changes.
6. ~~Grant lifetime.~~ Decided 2026-11-04: no practical expiry (see "Exact values"). Ending access stays possible
   at any time: 「연결 해제」 in an app revokes its grant, and rotating `HUB_OWNER_ID` invalidates every token.
