# P7 — Board API: app tiles, board layout, memos, roulette proposals (B1 deployed, B2 in the board repository, B3 in code, B4–B5 designed)

> **Status (2026-11-05).** B1 (upload API, read API, migration `0010`; `src/board/`, `test/board.test.js`) is merged
> (PR #44) and deployed with the migration. B2 (the board connects and reads real tiles) is in the board repository
> (board PR #3). B3 (layout sync, `board:sync`) is in code here and not deployed; a board grant made under B1 lacks
> `board:sync` and must reconnect once. B4–B5 exist only in this document. Do not describe anything as deployed beyond
> this line and do not fake an API for it (AGENTS.md, "Before any remote synchronization…"). Each stage below
> needs its own explicit task. This replaces the earlier "status cards" draft (PR #41): the board is now a separate
> site with live tiles, and apps publish **tiles**, not weekly numbers.
>
> The board itself exists: repository `board` (public, GitHub Pages, `https://kingjnu-sakayume.github.io/board/`).
> Today it shows its own widgets (weather, sports, timetable, price, D-day) and **fictional sample data** for app
> tiles. Its tile format is fixed in `board/docs/TILES.md` (manifest v1, validated by `board/js/schema.js`).

## 1. Goal

Let the board show each app's **recent flow** (what is in progress, what was just finished, what is next) from real
data, keep the owner's board layout the same on every device, show **approved** Claude memos, and let the board's
station roulette send its result as a **proposal**.

Non-goals: the Hub understanding app data (it stores each app's manifest as published), the board writing any
app's records, several owners, sharing the board, real-time push, history of manifests (latest only), chunked
record storage (P8).

## 2. Decisions already made (owner, 2026-11-04)

1. The board is a separate static site (repository `board`), an OAuth public client like the apps. Not a Hub page.
2. Each app builds its own board manifest (tile list) and uploads it. The Hub keeps the **latest one per app**; the
   board only reads.
3. A delayed, older upload never replaces a newer one (`generated_at`).
4. Hub-derived tile: the number of proposals waiting for review.
5. Claude memos appear on the board **only after the owner approves them**, as free text.
6. The roulette result is a proposal into the existing inbox flow (same as `propose_station_draw`), never a record.
7. The layout (which tile, where, what size) syncs across devices through the Hub.
8. Like device sync since PR #42, the new app scope is **granted with the inbox by default**.
9. Chunked record storage is P8.

## 3. Shape of the solution

| Piece | Reuses | New |
| --- | --- | --- |
| App → Hub manifest upload | each app's existing resource (`/animan`, `/sub`, …) and token | scope `<app>:board`, `PUT/GET/DELETE <app path>/v1/board`, table `board_manifests` |
| Board → Hub reads | — | destination `board` (resource `/board`), scope `board:read`, `GET /board/v1/tiles` |
| Board layout across devices | P6 sync API unchanged (`/board/v1/sync`, If-Match versions) | sync scope `board:sync`, shape check for the board document |
| Claude memos | the inbox, MCP proposal tools, conversation cards, receipts | candidate type `memo` for destination `board`, tool `propose_board_memo` |
| Roulette proposals | the inbox and the `sub` adapter (`station_draw`) | scope `board:propose`, `POST /board/v1/proposals`, inbox source `board` |

So the board is "just another destination": it has an **inbox** (memos addressed to it), a **sync document**
(layout + saved memos) and two extra powers (`board:read`, `board:propose`). Everything that already works for
apps (consent page, CIMD client, revocation, receipts, cards) works for it.

## 4. AGENTS.md checklist

| Question | Answer |
| --- | --- |
| Identity | One owner (`HUB_OWNER_ID`). Every request carries a token for one resource; the role and scopes come from the validated OAuth profile, never from the body. A manifest body's `app` must equal the destination of the path it was sent to |
| Persistence | `board_manifests` (one row per owner and app, replaced), the board's sync document in `sync_docs`, memo candidates in the inbox |
| Private storage | D1 only. The board repository and the apps' Pages hold code and fictional samples, never data |
| Revocation | OAuth revoke (disconnect in the app or the board). A revoked app's manifest stays until the app deletes it or the owner removes it (section 6.4); the board marks it stale by age |
| Replay | Upload: same `sha256` → no write; older `generated_at` → `200 { ignored: true }`. Proposals: idempotency key from the board (stable per draw). Sync: If-Match versions as in P6 |
| Conflict | Manifests: newest `generated_at` wins (derived data, never merged). Layout: P6 rules, the board merges on `412` |
| Recovery | An app regenerates its manifest from its own data; the layout keeps 10 versions (P6); approved memos are in the board document, which also keeps 10 versions |

## 5. App → Hub: manifest upload

### 5.1 Requests

Authentication: `Authorization: Bearer <token>` of the app's own resource. Scope `<app>:board` (for example
`animan:board`). Paths are under the app's resource, like its inbox and sync.

| Request | Meaning |
| --- | --- |
| `PUT <app path>/v1/board` | Store this manifest as the app's current one. Body: manifest v1 (`application/json`) |
| `GET <app path>/v1/board` | Read back what is stored: `{ generated_at, received_at, sha256, size_bytes, manifest }` or `404` |
| `DELETE <app path>/v1/board` | Remove the app's manifest (its tiles disappear from the board) |

### 5.2 What the Hub checks (fail closed)

The board validates every field again before drawing (`board/js/schema.js`), so the Hub checks only what protects
storage and identity, without copying the whole tile schema (owner decision, 2026-11-05: split the work this way):

- `Content-Type: application/json`; body at most **64 KiB** of UTF-8 (`413` above).
- **Images are addresses only.** A manifest carries image URLs (the board's allowed origins, for example
  `image.aladin.co.kr`); the viewer's browser loads them from there and the Hub never stores an image. Any string
  starting with `data:` anywhere in the body is refused (`400`), so a manifest is text of a few to a few tens of KiB.
  An image that exists only inside an app's browser storage (no public address) cannot appear on the board; its tile
  shows a letter instead. Hosting such images is out of scope (P8 or later).
- `version === 1`; `app` equals the path's destination; `generated_at` is an ISO instant not more than 5 minutes in
  the future; `tiles` is an array of at most 24 objects, each with an `id` matching `^[a-z0-9][a-z0-9-]{0,31}$`
  (unique) and a `tone` in `sleeve hero strip plate map type`.
- Anything else in a tile is not interpreted. The manifest text is never logged or echoed in an error.

Responses: `200 { generated_at, received_at, sha256, size_bytes }` when stored, `200 { ignored: true, current }`
when older than the stored one, `200 { unchanged: true }` when the `sha256` is the same, `400` invalid, `413` too
large, `415` wrong type, `401/403` token or scope.

### 5.3 When apps upload

After a change that affects a tile, debounced (at most once per **10 minutes** per app), and only if the new
manifest's `sha256` differs from the last uploaded one. Also on app start if the last upload is older than a day.
No upload while the app has no Hub connection; the board then simply shows the older manifest with its age.

### 5.4 Storage (migration `0010_board.sql`)

```sql
CREATE TABLE IF NOT EXISTS board_manifests (
  owner_id     TEXT    NOT NULL,
  app          TEXT    NOT NULL CHECK (length(app) BETWEEN 1 AND 40),
  generated_at TEXT    NOT NULL,
  received_at  TEXT    NOT NULL,
  body_json    TEXT    NOT NULL CHECK (length(body_json) <= 65536),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes BETWEEN 2 AND 65536),
  sha256       TEXT    NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (owner_id, app)
);
```

The write is one conditional upsert (`… ON CONFLICT DO UPDATE … WHERE excluded.generated_at > board_manifests.generated_at`),
so two racing uploads cannot put the older one last.

Free-tier cost: at most 6 writes per hour per app (debounce), usually far fewer; eight apps stay far below D1's daily
write allowance. Reads are one indexed query per board refresh (every 5 minutes while the board is open).

## 6. Board → Hub

### 6.1 The `board` destination

Life Board connects like the apps: the board repository serves its CIMD document (`lifehub-client.json`) and callback
page, and the Hub chooses its profile by the exact redirect URI in `HUB_BOARD_REDIRECT_URI`; resource `/board`, role
`board`. In stage B1 it is **not** an entry of `src/destinations.js` (that registry assumes an inbox or sync and an
adapter); its client is `BOARD_CLIENT` in `src/auth/clients.js` with the one scope `board:read`. When B3/B4 give it a
sync document and an inbox (`board:sync`, `board:inbox` with type `memo`) and B5 adds `board:propose`, it may move into
the registry; the consent page lists every scope in plain Korean either way.

### 6.2 `GET /board/v1/tiles` (scope `board:read`)

```json
{
  "generated_at": "2026-11-05T06:00:00Z",
  "manifests": [
    { "version": 1, "app": "animan", "generated_at": "…", "received_at": "…", "tiles": [ … ] },
    { "version": 1, "app": "hub", "generated_at": "…", "tiles": [ { "id": "inbox", "tone": "type", "form": "num", … } ] }
  ]
}
```

- Same shape as the board's `data/sample-tiles.json`, so the board swaps the sample file for this response with no
  other change. `received_at` is added by the Hub so the board can show staleness.
- The `hub` manifest is computed per request: tile `inbox` = number of `pending` candidates over all destinations
  (a count only, no titles), with `detail` rows per destination (`AniMan 2건`, …).
- `Cache-Control: no-store`. No ETag (P6's CORS reason); the response is small.

### 6.3 Layout across devices: the board's sync document

The board uses the P6 sync API unchanged at `/board/v1/sync` with scope `board:sync` (B3: `boardHandler` in
`src/server/index.js`, limit 64 KiB and 10 kept versions). Shape check (in `src/sync/checks.js`): `app === 'board' &&
version === 1 && isObject(layout)`, with `memos` optional array.

Merge rule on the board side: a layout is one owner's arrangement, not records, so on `412` the board takes the
newest document's version and writes its own **latest local edit** on top (the edit the owner just made wins). On
start, and on each refresh while nothing local is waiting, a newer remote version replaces the local layout.

```json
{
  "app": "board", "version": 1,
  "layout": { "v": 1, "g": { "day": [["board:weather", "2x2"]], "media": [["animan:now", "2x2"]] }, "tray": ["potcast:recent"] },
  "memos": [ { "key": "…", "text": "시청은 늘고 독서는 잠시 쉬었어요.", "approved_at": "…" } ]
}
```

`layout` is exactly what the board stores in `localStorage` today (`board.layout.v1`). Widget settings (location,
team, timetable) stay **out** of the document: they are per browser (owner decision, 2026-11-05).

### 6.4 An app that is no longer used

Its last manifest stays in the Hub and the board marks it "오래됨" (older than **14 days**) with its real age. The
owner hides its tiles with the board's edit mode (`−`), which only changes the layout. There is no board-side delete
and no extra write scope (owner decision, 2026-11-05); the app's own `DELETE` remains the only way to remove the data.

## 7. Claude memos

- Claude proposes with a new MCP tool `propose_board_memo { text, idempotency_key }` under the existing
  `hub:propose` scope (one scope for every conversational proposal tool, so no reconnect). `text` is 1–160
  characters of plain text. The adapter refuses anything else.
- The candidate goes to destination `board`, type `memo`. It is **pending** until the owner approves it **with a
  conversation card's buttons only** (`card: { approve: true }`, `hub:approve`; owner decision, 2026-11-05). The board
  has no approve or reject buttons. Claude can never approve its own memo (`test/cards.test.js` keeps proving it).
- Approved is not saved: when the board next opens it reads its **approved** memos (`GET /board/v1/candidates?status=approved`
  with `board:inbox`), saves them into its sync document (`memos`, newest 20) and only then sends the receipt
  (`POST /board/v1/receipts`, `entity_type: 'memo'`). Pending and rejected memos never reach the board. The memo tile
  reads the newest saved memo.

## 8. Roulette proposals

- `POST /board/v1/proposals` with scope `board:propose`. Body: `{ destination: 'sub', type: 'station_draw',
  idempotency_key, payload }`. Only this one pair is allowed at first (allowlist in code); everything else is `403`.
- The payload goes through the existing `sub` adapter (`toSubCandidate`), so a board proposal is indistinguishable in
  shape from Claude's `propose_station_draw`, and the sub app approves it as usual.
- Provenance: inbox `source = 'board'`, from the validated board profile. The inbox's `source` CHECK lists
  `manual chatgpt claude codex spotify`, so this needs a table-rebuild migration (`0011`, same pattern as
  `0006`/`0008`).
- The idempotency key is generated by the board once per completed draw and reused on retry.
- The board's "제안 보내기" stays disabled until this stage is deployed (it is locked today).

## 9. Stages

| Stage | Scope | Done when |
| --- | --- | --- |
| B0 | This document reviewed | Owner decisions recorded in section 10 (done 2026-11-05); owner merges this document |
| B1 | Hub: migration `0010`, `<app>:board` scopes (granted with the inbox; existing grants reconnect once), `PUT/GET/DELETE <app>/v1/board`, `board` destination with `board:read`, `GET /board/v1/tiles` with the `hub` inbox tile, tests (upload checks, replay, older `generated_at`, size, wrong app, scope), README line "it is not a new dashboard" reworded | `npm run check` green; deployed; a throwaway token uploads a fictional manifest and reads it back |
| B2 | board repo: OAuth client (CIMD, callback, PKCE), read `/board/v1/tiles` instead of the sample, connect/reconnect/offline states, stale marking | The owner sees real tiles once at least one app uploads; disconnected state is honest |
| B3 | Layout sync: `board:sync` shape check here; board repo syncs `layout` with P6 rules | Two browsers converge on one layout |
| B4 | Memos: `memo` type and `propose_board_memo`, card approval; board repo reads approved memos, saves them into its document, sends receipts | A memo proposed in a conversation appears only after approval |
| B5 | Roulette: migration `0011` (source `board`), `board:propose`, `POST /board/v1/proposals`; board repo unlocks the button | The sub app receives a `station_draw` proposal from the board |
| A* | Each app: wire its existing `buildBoardTiles` (from the board prompts) to `PUT …/v1/board`, debounced | That app's tiles are real on the board |

B1 and the apps' pure `buildBoardTiles` functions (already assigned per repository through `board/docs/prompts/`)
can proceed in parallel; an app uploads only after B1 is deployed.

## 10. Owner decisions (formerly open questions)

All answered on 2026-11-05; this list stays as the record.

1. ~~Hub validation depth~~ — **split**: the Hub checks storage and identity (5.2), the board checks every tile.
2. ~~Size cap~~ — **64 KiB, image addresses only, `data:` refused** (5.2).
3. ~~Removing an unused app's tiles~~ — **hide with edit mode only**; no board-side delete, no extra scope (6.4).
4. ~~Memo approval places~~ — **conversation cards only** (7).
5. ~~Widget settings across devices~~ — **decided 2026-11-05: per browser.** They stay out of the board's sync
   document.
6. ~~Roulette alternative~~ — **decided 2026-11-05: the board sends a proposal** (stage B5), not "open the sub app
   with the station preselected".
