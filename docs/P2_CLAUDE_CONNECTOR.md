# P2 — Claude custom connector (MCP + OAuth)

## What works

Claude (web, desktop, mobile) can connect to Life Hub as a **custom connector** and propose food candidates into the private D1 inbox:

```
Claude ──MCP over HTTPS──> <origin>/mcp ──> D1 inbox (status: pending, source: claude)
   │                           ▲
   └── OAuth sign-in ──> <origin>/authorize  (owner password + consent)
```

| Tool | Effect |
| --- | --- |
| `propose_food_meal` | A meal the user says they actually ate → pending `meal` candidate |
| `propose_food_wish` | A place to visit or dish to try → pending `wish` candidate |
| `get_food_candidate_status` | Status of a candidate this connector proposed |

No tool can approve, confirm, edit, delete or list other candidates. Identical proposals are de-duplicated: the idempotency key is a hash of the candidate type and normalized payload.

## What does not work yet

- PALATE receives the candidates through its own connection; see [P2B_PALATE.md](P2B_PALATE.md).
- Only `destination: food`. Other sites follow one at a time (ROADMAP P3).
- Claude Code (loopback redirect) is refused on purpose; only `https://claude.ai/api/mcp/auth_callback` may receive codes.

## Connect

1. Complete [DEPLOY_FROM_WEB.md](DEPLOY_FROM_WEB.md) including `HUB_OWNER_PASSWORD`, `KV_NAMESPACE_ID` and `HUB_PUBLIC_ORIGIN`, and deploy.
2. In Claude, add a custom connector with the URL `<origin>/mcp` (e.g. `https://life-hub-api.<subdomain>.workers.dev/mcp`). Leave the OAuth client ID/secret fields empty.
3. Claude opens the Life Hub page. Check that it says the result goes to **claude.ai**, enter the owner password, tap **허용**.
4. Ask Claude something like "어제 저녁에 ○○에서 △△ 먹었어, 맛있었어. 기록 후보로 올려줘". It should call `propose_food_meal` and say it was **proposed**, not recorded.

To disconnect, remove the connector in Claude. To revoke every connection at once, change `HUB_OWNER_ID` (this also changes the owner scope of P1 data, so do it only with a plan), or delete the KV namespace contents.

## Security model

- **Identity**: one owner. `/authorize` requires `HUB_OWNER_PASSWORD`, compared in constant time on SHA-256 digests. Attempts are counted **before** comparison in one atomic D1 upsert; more than 10 in 15 minutes locks sign-in for the rest of the window, even for the right password. No IP addresses or passwords are stored.
- **Clients**: Dynamic Client Registration accepts only clients that list the Claude callback; CIMD is enabled with the `global_fetch_strictly_public` flag. `/authorize` additionally refuses any redirect URI other than the Claude callback, before and after consent.
- **Tokens**: issued by `@cloudflare/workers-oauth-provider` (OAuth 2.1, S256 PKCE required for public clients, rotating refresh tokens, RFC 8707 audience bound to `<origin>/mcp`, RFC 9207 `iss`). Tokens are stored only as hashes in KV; grant props (`ownerId`, `role`) are encrypted.
- **Scope**: the only scope is `food:propose`. The MCP handler also checks that the token's `ownerId` equals the current `HUB_OWNER_ID` and `role` is `claude`, so the candidate's `source: claude` comes from the credential, never from tool input.
- **Consent page**: client metadata is HTML-escaped; the page sets a strict CSP (`frame-ancestors 'none'`, `form-action 'self' https://claude.ai`), `X-Frame-Options: DENY`, `no-store`. The consent handle is single-use and bound to the browser by the library; a wrong password does not consume it.
- **Separation from P1**: OAuth access tokens are not accepted by `/v1/*`, and P1 static tokens are not accepted by `/mcp`.
- **MCP transport**: POST + JSON only, 64 KiB body limit, `Origin` allowlist (own origin, `https://claude.ai`, or none), header/body consistency checks. Supports protocol `2026-07-28` (stateless, `server/discover`) and legacy `2025-03-26`–`2025-11-25` (`initialize`).

## Tests

`npm run check` runs the OAuth flow end to end through the real library under Node: discovery, registration policy, wrong/right password, PKCE exchange, tool call into an in-memory D1, refresh rotation, owner rotation, deny, and fail-closed configuration.
