# Life Hub

**One chat entry point, multiple independent personal archives.**

Life Hub is a private-first routing project for personal websites. ChatGPT/Claude/Codex may propose structured records, and each destination remains responsible for confirmed writes. It has no dashboard of its own: the separate [Life Board](https://github.com/KINGJNU-sakayume/board) site reads the tiles each app chooses to publish here (P7).

> **Public repo:** Source code, documentation, and **fictional fixtures only**. Do not commit real personal records, diaries, chat transcripts, photos, token values, database files, or backups.

## Status

- **P0:** storage-independent validated candidate core, [PALATE](https://github.com/KINGJNU-sakayume/food) v1 adapter, and synthetic tests.
- **P1 (deployed):** Cloudflare Worker/D1 implementation with server-only role-scoped opaque keys, atomic uniqueness, durable candidate events, owner listing and rejection. Manual deploy workflow runnable entirely from the web ([docs/DEPLOY_FROM_WEB.md](docs/DEPLOY_FROM_WEB.md)).
- **P2a (deployed):** Claude custom connector — OAuth 2.1 with owner password and an MCP endpoint whose tools *propose* candidates into the private inbox ([docs/P2_CLAUDE_CONNECTOR.md](docs/P2_CLAUDE_CONNECTOR.md)).
- **P2b (deployed):** PALATE pulls pending food candidates and reports approval receipts and rejections back, with the same owner sign-in ([docs/P2B_PALATE.md](docs/P2B_PALATE.md)).
- **P4 cards (stages 1–7):** Claude conversation cards via MCP Apps — review, edit, approve or reject a proposal in the conversation; `approved` state, opt-in `hub:approve`, app-only card tools. Every destination now has a card and its app saves what was approved in one (`card: { approve: true }` in `src/destinations.js`) ([docs/P4_CARDS.md](docs/P4_CARDS.md)).
- **P6 (device sync, stages 1–5):** per-app JSON device sync API (`<app>/v1/sync`, conditional writes, 10 kept versions, scope `<app>:sync`) — deployed 2026-11-03; animan, letterbookxd and elosorter sync through it, and elosorter's Supabase backup is removed (stage 5). Since 2026-11-04 an app with an inbox gets the sync scope by default when it connects ([docs/P6_SYNC.md](docs/P6_SYNC.md)).
- **P7 (board API, deployed):** stages B1, B3, B4 and B5 are deployed on the Hub (B2 is the board site's own connection, in the board repository). B1: each app may upload its board tile manifest (`<app>/v1/board`, scope `<app>:board`, granted with the app's other scopes, latest one per app, 64 KiB, image addresses only); Life Board reads them with `board:read` at `/board/v1/tiles`, plus the Hub's own count of proposals waiting. B3: Life Board's layout sync (`/board/v1/sync`, scope `board:sync`). B4: Claude memos for the board (`propose_board_memo`, approved only in Claude cards, read by the board with `board:inbox`). B5: the board's roulette proposes a 역 도장깨기 station draw (`POST /board/v1/proposals`, scope `board:propose`, inbox source `board`, migration `0011`), deployed 2026-11-05. Apps uploading tiles so far: see [Connected apps](#connected-apps). Needs migrations `0010`–`0011` and `HUB_BOARD_REDIRECT_URI` ([docs/P7_BOARD.md](docs/P7_BOARD.md)).
- **P5 (proposed):** ChatGPT personal MCP plugin OAuth and editable reading-preview card; owner-confirmed proposal to letterbookxd ([docs/P5_CHATGPT_PLUGIN.md](docs/P5_CHATGPT_PLUGIN.md)). Other destination cards remain future work.
- **P4 Codex (server implementation, destination changes pending):** Codex CLI/IDE as a separately authenticated MCP producer (OAuth + PKCE, `source: codex`) using the existing proposal tools ([docs/P4_CODEX_CONNECTOR.md](docs/P4_CODEX_CONNECTOR.md)).
- **P3:** 켜켜이 memories and region visits ([docs/P3_KYEOKYEOI.md](docs/P3_KYEOKYEOI.md)); potcast album listening from conversation or the Spotify history file ([docs/P3_POTCAST.md](docs/P3_POTCAST.md)); 업적 라이브러리 activity records ([docs/P3_ACHIEVEMENT.md](docs/P3_ACHIEVEMENT.md)); 책장 reading records ([docs/P3_LETTERBOOKXD.md](docs/P3_LETTERBOOKXD.md)); 역 도장깨기 station stamps ([docs/P3_SUB.md](docs/P3_SUB.md)); AniMan anime/manga progress ([docs/P3_ANIMAN.md](docs/P3_ANIMAN.md)); hourly Spotify listening sync for potcast ([docs/P3_SPOTIFY_SYNC.md](docs/P3_SPOTIFY_SYNC.md)). Destination apps are declared in one registry, `src/destinations.js`.

No proposal becomes a record without the owner's approval in its destination app.

## Connected apps

Destination apps are separate repositories, declared in `src/destinations.js`. Status as of 2026-11-08:

| App | Repository | Inbox + Claude cards | Device sync (P6) | Board tiles (P7) |
|---|---|---|---|---|
| PALATE (food) | [food](https://github.com/KINGJNU-sakayume/food) | ✓ | – | ✓ (2026-11-08) |
| 켜켜이 | [kyeokyeoi](https://github.com/KINGJNU-sakayume/kyeokyeoi) | ✓ | – | ✓ (2026-11-08) |
| potcast | [potcast](https://github.com/KINGJNU-sakayume/potcast) | ✓ (+ hourly Spotify sync, P3) | – | ✓ (2026-11-07) |
| 업적 라이브러리 | [achievement](https://github.com/KINGJNU-sakayume/achievement) | ✓ | – | ✓ (2026-11-08) |
| 책장 | [letterbookxd](https://github.com/KINGJNU-sakayume/letterbookxd) | ✓ | ✓ | ✓ (2026-11-07) |
| 역 도장깨기 | [sub](https://github.com/KINGJNU-sakayume/sub) | ✓ (+ station draws proposed by the board's roulette) | – | ✓ (2026-11-06) |
| AniMan | [animan](https://github.com/KINGJNU-sakayume/animan) | ✓ | ✓ | ✓ (2026-11-07) |
| 일기 룰렛 | [diaryroulette](https://github.com/KINGJNU-sakayume/diaryroulette) | ✓ | – | ✓ (2026-11-08) |
| ELO Sorter | [elosorter](https://github.com/KINGJNU-sakayume/elosorter) | – (sync only) | ✓ | ✓ (2026-11-07) |
| Life Board | [board](https://github.com/KINGJNU-sakayume/board) | memos only (approved in Claude cards) | ✓ (board layout) | reads every app's tiles |

Each app keeps its own README for its side of the connection; per-app instructions for adding board tiles are in the board repository's `docs/prompts/`.

## Test

Requires Node.js 22+. One runtime dependency: `@cloudflare/workers-oauth-provider` (`npm install`).

```bash
npm run check
```

Node.js's experimental SQLite API runs the SQL migrations in an in-memory database, and a small hook stubs the Workers runtime so the OAuth flow runs end to end; no Cloudflare account or real data is required.

## Implementation

- `src/core/candidates.js`: Hub v1 schema and idempotency semantics, in memory.
- `src/adapters/food.js`: exact translation to PALATE local inbox format, no direct approval.
- `src/server/index.js`: Worker entry; wires OAuth, `/authorize`, `/mcp` and the P1 routes.
- `src/server/worker.js`: P1 HTTP routes (`/health`, `/v1/*`).
- `src/auth/owner-login.js`: owner password check, throttle, redirect allowlist, consent page.
- `src/mcp/protocol.js` + `src/mcp/tools.js`: stateless MCP endpoint and the food proposal tools.
- `src/auth/clients.js`: client profiles (Claude, Codex loopback, destination apps): redirect URI → scope + resource.
- `src/inbox/api.js`: destination inbox API (list, receipts, rejections).
- `src/destinations.js`: the registry of destination apps (scopes, card support, sync, reference lists).
- `src/mcp/cards/`: Claude conversation cards, one per destination (P4).
- `src/sync/`: per-app JSON device sync, `<app>/v1/sync` (P6).
- `src/board/`: board tile manifests, Life Board read API and roulette proposals (P7).
- `src/spotify/`: hourly Spotify listening sync for potcast (P3).
- `src/server/auth.js`: secret-token roles; identity is never accepted from client JSON.
- `src/server/store.js` + `migrations/`: D1 candidate storage with SQL uniqueness, append-only change feed, and the login throttle.
- `docs/P1_PRIVATE_API.md`: setup and security restrictions.
- `docs/ROADMAP.md`: next stages.

```
Claude/Codex --[MCP + OAuth]--> Life Hub D1 private inbox
                                                         |
                                   [PALATE pull + receipts, P2b]
                                                         v
                                           food  (next: kyeokyeoi / potcast ...)
                                                         |
                                          [owner-approved destination receipt]
```

The public GitHub repository never hosts private records. MCP is an **optional connection protocol**, not a substitute for Life Hub.
