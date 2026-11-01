# Life Hub

**One chat entry point, multiple independent personal archives.**

Life Hub is an evolving private-first record router for personal websites. It is not another dashboard, and it is not itself a diary. ChatGPT/Claude may *propose* structured records; the destination site remains responsible for review and final writes.

> **Public repository safety:** This repo contains code, documentation, and fictional fixtures only. Never commit actual chats, private diaries, user records, photos, tokens, backup files, or credentials. This is **not** a deployed sync service or MCP server yet.

## Status

P0: local candidate contract and tests, no remote backend. The first adapter targets [PALATE (`food`)](https://github.com/KINGJNU-sakayume/food), which already has `#/inbox` for manual candidate review. `kyeokyeoi` and `potcast` have merged their recent refactors, but are not integrated with Hub yet.

## Run

Requires Node.js 22+. Zero install-time dependencies.

```bash
npm run check
```

`src/core/candidates.js` provides an in-memory, storage-independent state machine: strict envelope and destination-payload allowlists (via a required adapter validator), per-tenant candidate identity, duplicate/conflict detection, rejection, and acknowledgement only after a **verified destination receipt**. This reducer is a reference implementation, **not** a production concurrent or durable database.

`src/adapters/food.js` transforms an allowed Hub envelope to PALATE's exact `LifeHubCandidate` v1 shape. It never approves a meal or calls a website. `examples/food-candidates.json` contains fictitious examples and must never be confused with actual events.

## Intended end-to-end architecture

```
ChatGPT / Claude
    | authenticated, explicit proposal (MCP or provider-supported tool)
    v
Life Hub private API + durable private candidate inbox  [NOT IMPLEMENTED]
    | authenticated user review and delivery
    v
PALATE / Achievement / Kyeokyeoi / other sites
    | verified record commit and receipt
    v
Hub status and cross-site links
```

See [architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md), and [agent constraints](AGENTS.md).

## Ownership and privacy

GitHub is used for **public code only**, not for personal record storage. A private authenticated backend must be selected and configured before actual conversation-driven writing or cross-device synchronization can work. MCP is optional connectivity, not a replacement for Life Hub.
