# P4 — Codex as a Life Hub MCP client

## Scope

Codex uses the **same** remote Streamable HTTP MCP server as Claude at `<HUB_PUBLIC_ORIGIN>/mcp`. No new Cloudflare Worker, static API token, OAuth client secret, D1 database, or destination-specific tool is needed.

The authenticated OAuth grant contains `role: codex`, the MCP server sets `source: codex` itself (never from tool arguments), and the existing `hub:propose` tools create **pending proposals only**. The original Claude grants keep `source: claude`. Status lookups cannot read another connector's proposals.

This enables **Codex CLI and the IDE extension**. It does *not* make the Codex web/cloud/mobile task environment automatically inherit a local MCP configuration. In a hosted Codex environment, the MCP connection must be separately made available and authorized through a supported integration surface; do not assume local files or OAuth tokens sync into Codex Cloud.

## Prerequisites

1. Merge this change and run the repository's **manual** Cloudflare deploy workflow (it applies `0006_codex_source.sql`).
2. Confirm `<HUB_PUBLIC_ORIGIN>/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` are accessible over HTTPS.
3. `HUB_OWNER_PASSWORD` and the existing OAuth KV/D1 bindings must already be configured. Never paste the password into Codex prompts or store it in GitHub.

## Codex CLI

In a terminal with the current Codex CLI, using **your real Worker origin**:

```sh
codex mcp add life-hub --url https://YOUR-WORKER.workers.dev/mcp
codex mcp login life-hub
codex mcp list
```

The CLI may use Client ID Metadata Documents (CIMD) when supported. If a login is rejected due to callback registration/port matching, use the documented DCR fallback:

```sh
codex mcp login life-hub --oauth-client-registration dcr
```

The consent screen must show the **Life Hub origin**, a **Codex** client name, **only** the `hub:propose` scope and a `127.0.0.1` callback. Authorize *only if you initiated that login*, and type the owner password on the Life Hub page. Do not approve an unexpected consent prompt.

Alternatively, add the server to your local `~/.codex/config.toml` (do **not** commit OAuth tokens):

```toml
[mcp_servers.life-hub]
url = "https://YOUR-WORKER.workers.dev/mcp"
```

In the IDE extension: MCP servers → Add server → **Streamable HTTP** → same URL → restart extension → Authenticate. The CLI and IDE share local MCP settings.

## Smoke test

Ask Codex: “Life Hub에 가상의 수프 먹은 기록 **후보만** 만들어줘. 실제 기록으로 확정하지 마.” It should call `propose_food_meal`, return a candidate ID and `pending`, and not claim to have written a real PALATE record. Check the actual destination's inbox, then reject the **synthetic** example if it was inserted. Do not test by proposing personal or private data in this public repository.

For a real event, tell Codex explicitly what happened and request a candidate; only the connected owner can approve it inside the destination app.

## Security and compatibility

- **Authentication**: owner password + OAuth authorization code/PKCE, refresh rotation, role + owner ID + scope + resource audience checks remain enforced. A valid `/mcp` token cannot call the P1 `/v1` API.
- **DCR**: at most one callback is accepted. Claude's exact `https://claude.ai/api/mcp/auth_callback` and Codex CLI's `http://127.0.0.1[:port]/callback[/callback-id]` are allowed. Other hosts, local IPs, redirect paths, query strings, and mixed callback registrations are refused.
- **Loopback limitation**: any local application may request a loopback callback; the redirect URI itself does not prove the application is Codex. The consent screen warns about local callbacks. Only authorize when the displayed request matches the login you just started.
- **Provenance**: `source: codex` is enforced from the OAuth credential, not from a user-supplied field. D1 migration `0006` expands the CHECK constraint while retaining all earlier rows, destination receipts, sequence numbers, indexes, and triggers.
- **Idempotency**: logical retries from the same connector deduplicate; different connector sources are independent so Claude and Codex do not take over each other's IDs or statuses.
- **No automatic sync**: proposals still require explicit destination-site approval. No secrets or personal records belong in this public repository.

See [OpenAI Codex MCP setup](https://developers.openai.com/codex/mcp) for current client commands and OAuth behavior.
