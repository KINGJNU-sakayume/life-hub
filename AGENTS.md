# Life Hub agent boundaries

- Never commit real user content, chat transcripts, passwords, OAuth tokens, photographs, backup archives, or production DB files to this public repository, including fixtures and workflows.
- This repository contains **public code and synthetic data only**. The README and examples are not a datastore.
- Do not infer an actual meal, visit, book completion, or other event from hypothetical, planned, negative, or ambiguous language.
- Never silently approve a proposed candidate. Only the owner approves: in the destination app, or with the buttons of a Life Hub card in Claude (app-only `card_*` tools, the separate `hub:approve` scope granted on the consent page with the owner password, and a single-use ticket delivered only to the card). A model must never be able to approve, edit or reject on its own; keep `test/cards.test.js` proving it.
- `approved` is not a saved record. A destination record still requires the app to save it and send a verified receipt (`confirmed`). Never word an approval as "saved".
- Enforce strict payload allowlists and never treat a `source: chatgpt`, `source: claude`, or `source: codex` field as authentication. MCP provenance comes only from the validated OAuth role; a candidate never grants itself permissions.
- Codex and ChatGPT are record-proposal clients, never approval clients (no `hub:approve`). Codex is not an auto-approval agent. Never put owner passwords, OAuth tokens, or private records in `.codex/config.toml` committed to the repository.
- Stable idempotency key: same logical operation keeps the same key across retries. Distinct tenant, destination, source and key form uniqueness scope.
- Keep destination adapters separate from the generic Hub contract. Do not change food, kyeokyeoi, achievement, potcast, or other application repositories without a separate explicit task.
- Before any remote synchronization, design authenticated user identity, persistence, private storage, revocation, replay protection, and conflict recovery. Do not fake a connected MCP server or deployed API.
- Never add secrets into GitHub Pages bundles; no personal records or images in public static files.
- Run `npm run check` and update tests whenever contracts change.
