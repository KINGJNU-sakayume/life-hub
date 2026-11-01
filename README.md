# Life Hub

**One chat entry point, multiple independent personal archives.**

Life Hub is a private-first routing project for personal websites; it is not a new dashboard. ChatGPT/Claude may propose structured records, and each destination remains responsible for confirmed writes.

> **Public repo:** Source code, documentation, and **fictional fixtures only**. Do not commit real personal records, diaries, chat transcripts, photos, token values, database files, or backups.

## Status

- **P0:** storage-independent validated candidate core, [PALATE](https://github.com/KINGJNU-sakayume/food) v1 adapter, and synthetic tests.
- **P1 (proposed PR):** Cloudflare Worker/D1 implementation with server-only role-scoped opaque keys, atomic uniqueness, durable candidate events, owner listing and rejection. **Not deployed.**
- **P2:** real ChatGPT/Claude provider authorization, browser owner login, PALATE integration with verified receipt and bidirectional retry. **Not implemented.**

The API code is **not a working ChatGPT/Claude integration**. It cannot receive normal chat messages automatically or update PALATE records today.

## Test

Requires Node.js 22+. No application package dependencies.

```bash
npm run check
```

Node.js's experimental SQLite API runs the P1 SQL migration in an in-memory database for tests; no Cloudflare account or real data is required.

## Implementation

- `src/core/candidates.js`: Hub v1 schema and idempotency semantics, in memory.
- `src/adapters/food.js`: exact translation to PALATE local inbox format, no direct approval.
- `src/server/worker.js`: initial HTTP Worker routes.
- `src/server/auth.js`: secret-token roles; identity is never accepted from client JSON.
- `src/server/store.js` + `migrations/0001_inbox.sql`: D1 candidate storage with SQL uniqueness and append-only change feed.
- `docs/P1_PRIVATE_API.md`: setup and security restrictions.
- `docs/ROADMAP.md`: next stages.

```
ChatGPT / Claude --[future authenticated provider tool]--> Life Hub D1 private inbox
                                                         |
                                         [future authenticated delivery]
                                                         v
                                           food / kyeokyeoi / potcast ...
                                                         |
                                          [future verified destination ACK]
```

The public GitHub repository never hosts private records. MCP is an **optional connection protocol**, not a substitute for Life Hub.
