# Life Hub — architecture decision record 0001

## Objective

Turn explicit user conversations into structured, inspectable **record candidates** for multiple personal websites. Preserve the individual sites' UI and provenance, minimize manual re-entry, and keep data private.

**Not a replacement for the existing sites or their databases.** A canonical event can be linked to multiple destinations without pretending that those destinations have identical domain models.

## Roles (not interchangeable)

- **ChatGPT / Claude**: conversational input and structured extraction. Actual tool invocation must be supported by the chosen provider/client and authenticated; merely writing instructions in a chat is not an integration.
- **MCP (optional transport)**: expose scoped tools such as `propose_food_meal`, `list_candidates`, and `get_status` to consenting clients. MCP is not a datastore or a substitute for identity and authorization.
- **Life Hub**: validates, durably stores, deduplicates, and routes candidates; records source/decision/receipts; links equivalent events and preserves conflict history.
- **Destination site**: owns domain-specific interpretation, user review, and final record storage. PALATE already supports manual local review in `#/inbox`.

## Proposed production flow (not implemented)

1. Authenticated chat tool submits a candidate with stable idempotency key. Full conversation transcript and any token are **not** included.
2. Server independently derives account identity from authorization, enforces scope (`food:propose` etc.) and validates exact contract version/fields.
3. Durable private database commits candidate with unique `(account, destination, source, idempotency_key)`. Repeated requests are idempotent; same key + differing meaning is a conflict.
4. Destination user signs in to a protected endpoint and receives pending candidates. Until then nothing is written to existing personal records.
5. User reviews/edits and approves in the destination site. Destination commits record and stable receipt in a single local transaction.
6. Verified acknowledgement informs Hub about the committed destination ID. Status outbox retries until verified; rejected proposals remain distinguishable from confirmed records.
7. Never claim a candidate was applied solely because a network call returned HTTP 200.

## Security boundary

The repo is public. Code, schemas, tools and synthetic tests may be committed; actual records, diaries, photos, tokens and encrypted secrets must not be placed in it. GitHub Pages hosting and IndexedDB/localStorage cannot provide remotely writable, authenticated cross-device sync by themselves.

A production backend, private persistent store, secure authentication, rate limits, audit, deletion/revocation and an explicit backup strategy are prerequisites to handling real personal data. Select an implementation separately (e.g. a minimal managed API/storage combination), then perform deployment and security checks. **This commit does not choose or provision a cloud vendor.**

## Candidate shape v1

A Hub candidate has `hub_version`, `destination`, `source`, opaque `source_ref`, stable `idempotency_key`, `created_at`, `candidate_type` and allowlisted `payload`. `destination: food` is the only active adapter in P0. `source` is informational and never authentication.

PALATE v1 candidates omit `hub_version` and `destination` and instead use `schema_version: 1`. `src/adapters/food.js` provides an exact compatibility conversion; `food` still must separately validate everything it receives.

## Source-of-truth policy

- **Food**: PALATE is the source of truth for actual meals, menus, places and wishes.
- **Kyeokyeoi**: independently confirmed visits and user-chosen memories; not an automatic activity-completion source.
- **Achievement**: activity logs and achievement evaluation, not copies of the full diary.
- **Potcast**: personal listening/review data stays separate from editorial Notes. Replays are not proof of listening.
- **Diaryroulette**: missions depend on site-owned cooldown/date rules and require current data; Hub must never invent today's assigned mission.

Decide revision, link and conflict protocols per destination before adding each adapter. No cross-site propagation of deletions without a user-defined policy.
