# P1 private API — Cloudflare Workers + D1 (not deployed)

## Status and security boundary

This repository is **public code**. It is **not a public data store**, hosted website, or deployed service. The P1 Worker uses a private Cloudflare D1 database for pending record candidates. The API is intended for trusted, secret-bearing server processes, **not** client-side JavaScript, GitHub Pages, or a pasted chat token. D1 is provider-managed storage, **not end-to-end encryption**.

No real person, account, message, photo, backup or API secret belongs in this repository, CI logs, README screenshots, or fixtures.

P1 intentionally implements **only** candidate creation, owner listing, incremental changes, and owner rejection. No route can mark a candidate confirmed, since there is not yet a trusted PALATE committed-record receipt/ACK protocol. ChatGPT/Claude OAuth or MCP, browser login, automatic delivery, offline outbox, and multi-device synchronization are **not included**.

## Credential scopes

Secrets are Worker bindings, configured with `wrangler secret put` or non-committed `.dev.vars`:
- `HUB_OWNER_ID` — single owner's opaque identifier, server-side.
- `HUB_OWNER_TOKEN` — manual-only candidate creation, list, changes, rejection.
- `HUB_CHATGPT_TOKEN` — may submit only candidates that declare `source: chatgpt`.
- `HUB_CLAUDE_TOKEN` — may submit only candidates that declare `source: claude`.
- `HUB_FOOD_READER_TOKEN` — may read incremental changes; **never embed in PALATE**, as PALATE is a public client.

All tokens must be distinct, randomly generated, at least 32 characters, using letters, digits, underscore, or hyphen. Prefer 32-byte random tokens encoded as hex; never use a human password. The `source` string alone does not prove origin: the **credential scope** is enforced separately. The provided static tokens are a temporary operator-to-service boundary only. They cannot be safely used directly by the normal ChatGPT/Claude UI; actual provider connections need a supported OAuth / tool authorization flow.

## Before local development

1. Copy `wrangler.example.jsonc` to ignored `wrangler.jsonc` and use your actual D1 database ID later. Never commit secrets or real candidate data. Wrangler is a **separate CLI**: install it using the current Cloudflare instructions rather than introducing it as an application dependency.
2. Configure local-only `.dev.vars` with the five names above (you can leave provider/read-only tokens unset until their integrations are ready). Use **synthetic fixtures only**.
3. For a real account, authenticate with Cloudflare then create the D1 database:
   `npx wrangler d1 create life-hub-private`
   Insert the resulting ID into your ignored `wrangler.jsonc`.
4. Apply migrations to your local D1:
   `npx wrangler d1 migrations apply life-hub-private --local`.
   To apply against the remote database, explicitly review and use `--remote`, after an independent backup.
5. Start local Worker: `npx wrangler dev --config wrangler.jsonc`. Do not expose it publicly with populated personal data until access restrictions, security review, and backups are ready.
6. Only for remote deployment: configure individual secrets with `npx wrangler secret put KEY`, review Worker routing and Access restrictions, then explicitly deploy. No deployment or account configuration was performed in this PR.

For development you can use `npm run check`, which uses Node.js 22 and SQLite in memory; it does **not** contact Cloudflare or store user data.

## HTTP contract (server-to-server)

Headers: `Authorization: Bearer <trusted-server-secret>`, `Content-Type: application/json` for POST. Responses are JSON with `Cache-Control: no-store`. CORS is intentionally not enabled.

| Method | Endpoint | Credential | Behavior |
| --- | --- | --- | --- |
| GET | `/health` | None | Public configuration-independent liveness |
| POST | `/v1/candidates` | owner/manual, chatgpt, or claude | Validate full Hub v1 envelope, enforce source, insert pending |
| GET | `/v1/candidates?status=pending&limit=50` | owner | View at most 100 candidates |
| GET | `/v1/changes?cursor=0&limit=50` | owner or food_reader | Incremental sequence including create/reject events |
| POST | `/v1/candidates/:id/reject` | owner | Reject pending; repeated rejection is safe |

All tenant identity derives from `HUB_OWNER_ID` on the server; no submitted owner ID is accepted. D1 enforces atomic uniqueness of (owner,destination,source,idempotency_key). Identical retries return the same ID; conflicting retries return HTTP 409. A SQLite trigger transactionally appends create/status events, and monotonic integer cursors avoid timestamp collisions. Sender attribution is supported by credentials, not user-entered metadata. `created_at` is source-reported and never used as an authenticated occurrence time.

The changes endpoint intentionally returns **private contents** to the trusted food-reader credential, which is why it must remain on a server. The current browser-only PALATE app cannot securely hold this credential; P2 needs a true authenticated browser session or an intermediary delivery path.

There is **no confirmed state transition** until a trusted, independently verifiable destination receipt and outbox replay/reconciliation exist. Do not set `receiptVerified: true` from an LLM assertion.

## Operations and limitations

- P1 database stores **candidate text** and its journal, not photos or full transcripts. Protect D1 access and backups; GitHub remains public.
- No automatic deletion route. Retention, erasure, append-only audit scrubbing, and encrypted offsite backup/restore must be designed before handling real private history.
- No integrated production rate-limit binding, WAF, OAuth, consent UI, or key-rotation schedule yet. Do not treat it as fully production-hardened.
- Cloudflare D1 and Workers have account-specific usage limits and prices; check the current plan before deploying.
- Backups require independently tested restore and separate credential storage; the SQLite in-memory unit tests are not disaster recovery.
- Remaining requirements: owner login, OAuth tool authorization, real user-confirmed food receipt ACK, async outbox/replay, conflict UI, expiry/deletion rules, device tests, observability without user text.
