# Life Hub

**One chat entry point, multiple independent personal archives.**

Life Hub is a private-first routing project for personal websites; it is not a new dashboard. ChatGPT/Claude may propose structured records, and each destination remains responsible for confirmed writes.

> **Public repo:** Source code, documentation, and **fictional fixtures only**. Do not commit real personal records, diaries, chat transcripts, photos, token values, database files, or backups.

## Status

- **P0:** storage-independent validated candidate core, [PALATE](https://github.com/KINGJNU-sakayume/food) v1 adapter, and synthetic tests.
- **P1 (deployed):** Cloudflare Worker/D1 implementation with server-only role-scoped opaque keys, atomic uniqueness, durable candidate events, owner listing and rejection. Manual deploy workflow runnable entirely from the web ([docs/DEPLOY_FROM_WEB.md](docs/DEPLOY_FROM_WEB.md)).
- **P2a (this stage):** Claude custom connector — OAuth 2.1 with owner password and an MCP endpoint whose tools *propose* food candidates into the private inbox ([docs/P2_CLAUDE_CONNECTOR.md](docs/P2_CLAUDE_CONNECTOR.md)).
- **P2b (deployed):** PALATE pulls pending food candidates and reports approval receipts and rejections back, with the same owner sign-in ([docs/P2B_PALATE.md](docs/P2B_PALATE.md)).
- **P3:** 켜켜이 memories and region visits ([docs/P3_KYEOKYEOI.md](docs/P3_KYEOKYEOI.md)); potcast album listening from conversation or the Spotify history file ([docs/P3_POTCAST.md](docs/P3_POTCAST.md)); 업적 라이브러리 activity records ([docs/P3_ACHIEVEMENT.md](docs/P3_ACHIEVEMENT.md)); 책장 reading records ([docs/P3_LETTERBOOKXD.md](docs/P3_LETTERBOOKXD.md)). Destination apps are declared in one registry, `src/destinations.js`.

No proposal becomes a record without the owner's approval in PALATE.

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
- `src/auth/clients.js`: client profiles (Claude, PALATE): redirect URI → scope + resource.
- `src/palate/api.js`: PALATE inbox API (list, receipts, rejections).
- `src/server/auth.js`: secret-token roles; identity is never accepted from client JSON.
- `src/server/store.js` + `migrations/`: D1 candidate storage with SQL uniqueness, append-only change feed, and the login throttle.
- `docs/P1_PRIVATE_API.md`: setup and security restrictions.
- `docs/ROADMAP.md`: next stages.

```
Claude --[MCP + OAuth, P2a]--> Life Hub D1 private inbox
                                                         |
                                   [PALATE pull + receipts, P2b]
                                                         v
                                           food  (next: kyeokyeoi / potcast ...)
                                                         |
                                          [owner-approved destination receipt]
```

The public GitHub repository never hosts private records. MCP is an **optional connection protocol**, not a substitute for Life Hub.
