# Life Hub agent boundaries

- Never commit real user content, chat transcripts, passwords, OAuth tokens, photographs, backup archives, or production DB files to this public repository, including fixtures and workflows.
- This repository contains **public code and synthetic data only**. The README and examples are not a datastore.
- Do not infer an actual meal, visit, book completion, or other event from hypothetical, planned, negative, or ambiguous language.
- Never silently approve a proposed candidate. A destination record requires explicit user approval and a verified destination commit receipt.
- Enforce strict payload allowlists and never treat a `source: chatgpt` or `source: claude` field as authentication.
- Stable idempotency key: same logical operation keeps the same key across retries. Distinct tenant, destination, source and key form uniqueness scope.
- Keep destination adapters separate from the generic Hub contract. Do not change food, kyeokyeoi, achievement, potcast, or other application repositories without a separate explicit task.
- Before any remote synchronization, design authenticated user identity, persistence, private storage, revocation, replay protection, and conflict recovery. Do not fake a connected MCP server or deployed API.
- Never add secrets into GitHub Pages bundles; no personal records or images in public static files.
- Run `npm run check` and update tests whenever contracts change.
