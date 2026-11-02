# ChatGPT → Life Hub (personal MCP plugin)

## Goal

Use **ChatGPT itself as the recording input**. In a ChatGPT Work chat where the personal Life Hub plugin is connected, a message such as "책 A 115페이지까지 읽었어" is understood as an in-progress book update. ChatGPT can present an **editable reading preview**, and the user can submit a **pending candidate** to Life Hub.

This is different from Codex. No local CLI, GitHub workflow, or GPT Action is required in the final workflow.

## Flow

```
ChatGPT conversation (with installed Life Hub plugin)
  → preview_reading_record (read-only, editable MCP Apps card; does NOT write)
  → user verifies/edits and taps submit
  → propose_reading_record (OAuth MCP tool)
  → Life Hub D1 inbox: source=chatgpt, status=pending
  → letterbookxd inbox: user reviews edition/title and approves
  → letterbookxd is source of truth (verified receipt back to Life Hub)
```

Important: ChatGPT's card approval **does not replace** the destination app's final approval. The only write made by the card is to the private Life Hub inbox. The card displays the candidate ID returned by the server. Do not claim a completed book or a final record before the destination receipt.

The UI prototype currently covers **reading records** only. Other destinations retain their existing MCP proposal tools, and a shared preview-card framework can be implemented in follow-on work. A plugin *skill* can teach the model when to suggest records, but it cannot by itself grant MCP network access or provide an embedded card.

## Configure the plugin

1. Deploy the Life Hub Worker, D1 migrations and OAuth KV as described in [DEPLOY_FROM_WEB.md](DEPLOY_FROM_WEB.md). No new secret is necessary for ChatGPT (same owner password, separate OAuth grant).
2. In **ChatGPT Plugins** on the web, choose **+ → Add custom MCP server**. Name it `Life Hub` and set the URL to `https://<your-worker>.workers.dev/mcp`. Set authentication to OAuth if offered; never use No authentication for this private inbox.
3. Prefer CIMD when supported by the server/client; with DCR, the server permits only a single approved ChatGPT callback. The stable callback is `https://chatgpt.com/connector_platform_oauth_redirect` (supported by the existing OAuth issuer-identification design). Legacy callback-ID-specific URIs of the form `https://chatgpt.com/connector/oauth/<id>` are restricted as well.
4. Create and install the personal plugin. In ChatGPT **Work** on the web, select `@Life Hub` to enable it for that message. Invoke it with an actual reading update.
5. The first authorized tool call leads to a Life Hub consent screen. Confirm that it states **ChatGPT** and `hub:propose`; enter the owner password **on Life Hub**, never in chat. Test the OAuth flow and UI on your account before using real records.
6. Ask for a reading preview, edit the fields and submit. Verify that the response is pending and that letterbookxd can see the candidate; complete its own review/approval.

Plugin availability can differ by plan and workspace settings. The current [OpenAI Plugins quickstart](https://developers.openai.com/plugins/quickstart) shows how to create a personal MCP plugin and invoke it from Work; a successful connection in this user's specific account has **not** been verified by this code change. The normal unconnected chat and a GitHub repository connection alone cannot invoke Life Hub.

## Tool behavior and safety

- `preview_reading_record` is **read-only** and available **only to ChatGPT OAuth grants**. It returns a structured draft plus an MCP Apps `ui://` resource. If the host does not render UI, the content includes a textual draft; ask the user to confirm before invoking the writing tool.
- `propose_reading_record` already exists. It accepts `{ "title": "책 A", "state": "reading", "current_page": 115 }`. A new candidate is produced only after a deliberate submit/action, with source derived from the ChatGPT OAuth role.
- All tool requests require the server's authenticated OAuth `/mcp` resource. ChatGPT cannot impersonate Claude or Codex with a payload, or obtain another connector's private candidate status.
- Authentication remains owner password + PKCE, bound resource, rotating tokens. DCR allows only a **single** callback URI per registration and refuses unrelated hosts/paths. Resource and role checks are applied on each MCP request.
- The UI uses no remote resources or embedded credentials, and calls the MCP tool through the host's MCP Apps bridge.
- Do not put real records, owner tokens, OAuth secrets or full chat transcripts into the public GitHub repository.
- This feature **does not sync existing ChatGPT memories or prior conversations automatically**. The model must call the connected tool for an actual event.

## Current scope

This PR adds the ChatGPT OAuth profile, source identity and a focused editable reading-preview UI. It does not claim all seven destination cards are implemented, nor that a specific ChatGPT account is connected or the iframe has been verified end-to-end in a live ChatGPT plugin session.

Official developer references: [Authenticate users](https://developers.openai.com/plugins/build/auth) · [Add UI to MCP server](https://developers.openai.com/plugins/build/chatgpt-ui).
