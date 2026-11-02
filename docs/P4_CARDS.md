# Life Hub conversation cards — C0 design and staged delivery

Status: **design + non-executable component registry only**. No approval API, credential, database mutation, or destination auto-apply is enabled by this document or `src/mcp/cards/definitions.js`.

## 0. Ground truth (2026-11-02)

- Life Hub `main`: PRs #11, #12, #15 and #17 are **merged**. `0006_codex_source.sql` is the latest migration; Claude, ChatGPT and Codex proposal sources exist. A ChatGPT-only `preview_reading_record` UI prototype exists, but is not a universal card framework. Only normal destination confirmation receipts result in `confirmed`.
- Apps: achievement #12, sub #20, AniMan #2, letterbookxd #12, PALATE #9, kyeokyeoi #5/#6, potcast #29 are merged. AniMan local switch #1 and letterbookxd local switch #13 are also merged. **letterbookxd #14 remains OPEN**: it replaces Aladin lookup with the National Library API; DO NOT build a new Aladin-only integration. Confirm when #14 is resolved.
- Most destination records are **browser-local**, not stored in Life Hub. A hub-approved proposal does not mean a remote browser database was changed; the relevant app/device must open and sync successfully.
- `src/inbox/api.js` still needs a separate provenance audit for `codex` receipt parsing; this workstream must not quietly change any identity mapping.
- Existing public repo rules prohibit real user records, chat dumps, passwords, session tokens and photos.
- The user's preferred behavior is **one coherent visual language with purpose-built card bodies**; do not clone one generic form for every domain.

## 1. Cross-client scope and reality

The shared wire standard is MCP Apps, including `ui://` resources (`text/html;profile=mcp-app`), tool `_meta.ui.resourceUri`, `_meta.ui.visibility`, and iframe-to-host `app.callServerTool` or standard `tools/call`. Use explicit resource CSP metadata and no third-party assets by default. Use official `@modelcontextprotocol/ext-apps` View code bundled into **one small self-contained HTML file** (can keep the Worker MCP transport minimal and custom). The existing ChatGPT reading card uses handwritten postMessage glue and is a **prototype**; test/replace with the official bridge after confirming real host compatibility.

- Claude: documented interactive connectors support web, desktop, and mobile, though actual UI/permission differences must be tested per client.
- ChatGPT: custom MCP and full write/action permissions depend on plan/workspace settings; current official guidance limits full custom MCP write to Business and Enterprise/Edu, not ordinary Plus. A live Plus/Work UI integration is **not proven** by unit tests. Do not claim ChatGPT writes are available unless tested with the user's account and allowed by the platform.
- Card-less hosts: respond with concise text and show the destination's existing review route; they must never auto-approve.
- Never expose an OAuth secret, owner password or private snapshot in an HTML template, a public app bundle or tool text.

Official references (review again before implementation):
- https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html
- https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- https://apps.extensions.modelcontextprotocol.io/api/documents/Patterns.html
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude

## 2. Shared design system, contextual components

Every card uses the same **shell**: compact source/destination eyebrow, one sentence about what is happening, readable content hierarchy, one persistent state strip, and explicit footer actions. Shared tokens live in `CARD_STYLE`: font sizes, neutral surfaces, accents, borders, spacing, radii and dark/light colors. Respect the host theme, zoom and reduced motion. Use Korean UI text. In narrow windows fields stack vertically, all controls keyboard-friendly and touch targets >= 44px.

Cards **do not** need to be identical internally:
- Food meal: restaurant/menu identity, date, judgment (not fabricated stars), note. Food wish: wish-kind and item.
- Kyeokyeoi memory: title, location/time, optional emotion, text-first (no photo placeholder). Region visit: explicit Si/Gun/Gu picker with resolved region ID.
- Achievement activity: category, unit/value, tags and date. Achievement definition: rule expression (count/total/streak/tag) with a transparent preview; no unbounded rule engine.
- AniMan progress: episode/volume range with season and a deliberate title match. Catalog addition is separate.
- Books: pages/progress vs completion/star rating, edition picker and catalog status. The current Aladin assumption is obsolete while letterbookxd #14 is open.
- Potcast: album identity, per-track listened/skipped, separate listening percentage; Spotify data only with proper OAuth permission and explicit per-album confirmation, **no blanket periodic listening claims**.
- Sub: station picker/draw and a sticker state; any photo upload is a separate secure R2 workflow, not part of a general card proposal.
- Diaryroulette: today's stable mission with optional animation, deep link to diary editor, and status from verified app synchronization; **never send diary text to Hub**.

Shared components: `card-shell`, `card-heading`, `field-row`, `text-field`, `numeric-field`, `date-field`, `select-field`, `choice-chips`, `rating-field`, `progress-meter`, `catalog-picker`, `region-picker`, `track-checklist`, `timeline-preview`, `media-progress`, `status-strip`, `action-footer`, and `resolution-notice`.

**Do not generate albums, catalog IDs, region codes, cover art, mission IDs or ratings when the user did not supply them.** Externally retrieved options must be shown as options pending confirmation.

## 3. Required approval security properties (not implemented yet)

A hypothetical `hub:approve` scope and `_meta.ui.visibility=["app"]` are **necessary but not sufficient** to cryptographically prove a human clicked. App-only hides tools from a compliant model-host, but an OAuth bearer token by itself does not distinguish a legitimate card gesture from a forged tool call. Do **not** claim "the model can never approve" solely because a tool is hidden in `tools/list`.

C1 must first implement and test this threat model:
1. Existing `hub:propose` grants retain proposal-only access. A fresh, explicit OAuth consent is required to obtain `hub:approve`. If a client cannot request isolated approval scopes without new privileges, refuse approval and use destination review.
2. App-only approval/edit/reject tools are advertised using `_meta.ui.visibility=["app"]`; the server must also require an authenticated owner, approval scope, exact candidate owner + destination and expected revision, and fail closed for expired/replayed/unbound action intents. The card contains explicit Approve/Reject user controls; no background UI effect calls mutating tools.
3. A short-lived single-use approval intent is bound to candidate ID, owner ID, session/client role, candidate revision and canonical payload hash. Store only a digest and expiry in private D1. **A nonce delivered to the UI is not proof of human interaction by itself**. Review host guarantees; if there is no trustworthy way to verify an explicit gesture, require a first-party owner-password/WebAuthn step-up on the confirmation path, or keep the action in the destination app. Do not weaken the requirement for visual convenience.
4. Edits get strict allowlist validation by the destination adapter, canonical diff display, immutable previous revision/audit event and optimistic compare-and-swap. An invalid field cannot pass on approval. A verified one-time action may commit exactly once, even across double clicks, retries and two concurrent clients.
5. No MCP model-visible tool may invoke approve/reject/edit by alternate name, raw URL, insecure legacy path or another app's OAuth resource. Tests must cover these entry points, scope escalation and forged `source`/owner fields.
6. For `approved` the owner has finalized *the candidate payload*, but the destination record is **not** yet `confirmed`. User-facing language must say "허브 승인 · 앱 반영 대기", never "기록 완료".

## 4. State machine and sync

```
pending ──[owner card approval + verified action]──> approved
   │                                             │
   └────[owner rejection]──> rejected             │
                                                 ├─[destination validates + commits + receipt]──> confirmed
                                                 ├─[stale/missing/ambiguous reference]──> needs_resolution*
                                                 └─[retryable device offline]──> approved (retry later)
```

`needs_resolution` may initially be a separate resolution field rather than an inbox status; do not silently convert it to `confirmed` or `rejected`. Existing direct destination approval `pending -> confirmed` remains valid for legacy clients and users with auto-apply disabled.

Migration C1: start from `0006`, add `approved` to the status CHECK with a **data-preserving** rebuild (foreign keys, candidate records, confirmed_entity_id, events, sequence counters, indexes and triggers). Prefer append-only approval revisions in a separate table rather than overwriting evidence of the original proposal. Require a verified commit receipt to enter `confirmed`. Migration tests on synthetic *populated* old DB must preserve history.

**Auto-apply defaults OFF** until each destination has migration-safe tests and a user-controlled toggle. When enabled, it may only act if all required references match a fresh/versioned source snapshot, schema versions agree, the event has not already been committed, and there is no local conflict or ambiguity. Otherwise leave in review. An offline browser means *pending delivery*, not success. Never replace local data silently, and honor an explicit "disabled" setting.

## 5. Reference snapshots

App-provided references must be opt-in, minimal, scoped to one destination, authenticated with that destination's `<app>:inbox` credential, bounded in size, versioned with ETag/monotonic revision and a bounded TTL. Capture only identifiers/labels that the owner has agreed can leave their browser; do not upload all books, memories, diary text or private listening history just because they are useful. Reject stale snapshot writes and provide no cross-app exposure.

The review UI may use a snapshot for *picker suggestions*, but should revalidate the selected ID on app import. Missing or stale snapshots must never turn a fuzzy string match into an automatic record.

## 6. Destination-specific hazards

- **Diaryroulette**: enforce a single daily mission per owner and local KST date with atomic create-if-absent and exact revision. A mission selected offline by a device is provisional until server reconciliation; duplicate conflicting rolls require an explicit conflict resolution. A rolling 7-day exclusion set needs fresh, complete mission IDs and a confirmed history snapshot. Do not show an unverified "completed/streak" claim. Hub stores mission ID and date only, never diary contents.
- **Sub image flow**: no photo data in D1, GitHub or MCP tool text; an opt-in R2 upload uses short-lived authenticated upload/download permissions, size/MIME controls and asynchronous/orphan TTL cleanup. Delete only after verified destination ingest receipt; timeout also cleans abandoned objects. Do not promise "immediate deletion" when a browser is offline.
- **Spotify**: refreshable Spotify authorization must not be coupled to Hub owner credentials, track-to-album inference must require explicit album confirmation, and provider rate limits/developer policy are external dependencies.
- **Free Cloudflare tier**: small inline/bundled card templates, no polling loops, bounded D1 rows/snapshots, TTL cleanup and low-frequency sync on app open/focus. Measure use before introducing R2 or scheduled Spotify jobs.

## 7. Delivery plan and PR boundaries

Each phase: separate feature branch + PR, synthetic tests + GitHub CI, no merge/deploy by assistant, short Korean deployment instructions.

| Phase | Scope | Completion gate |
| --- | --- | --- |
| C0 (this PR) | Official spec audit; card style/definitions; exact security and state design. **No writes**. | CI passes + user reviews design. |
| C1a | MCP Apps runtime, small bundling process, shared shell + old read-only preview cards for food/reading/kyeokyeoi; preserve text fallback. | Render in MCP reference host and Claude; no approval methods. |
| C1b | Owner approval authorization, action-integrity proof or explicit first-party step-up, new state migration, app-only tools, full negative security tests. | Security tests and real client confirmation flow pass. |
| C2 | PALATE + 켜켜이 auto-import with **default OFF**, conflict resolution, snapshots where necessary. | Online/offline/duplicate/retry tests in both apps. |
| C3 | Diaryroulette minimal daily mission protocol and entry card. | KST/day, 7-day exclusion and conflict tests; no diary payload. |
| C4 | Achievement record + definition rules. | Rule evaluation and no false unlocks. |
| C5 | Sub station/draw/sticker. R2 is a separate gated option. | Station identity and media cleanup tests. |
| C6 | letterbookxd + AniMan catalog-aware cards (both local transitions have merged; honor outstanding catalog work). | Edition/work identity and multi-device cases. |
| C7 | potcast album/track confirmation + optional Spotify collection. | Provider auth and explicit album confirmation tests. |

Unresolved design question before C1b: **what trusted user-presence mechanism can each host provide that the server can verify?** Until that is answered, the old destination approval stays authoritative. The owner grants permission to implement, but no permission removes this technical security requirement.

## 8. Acceptance examples

- "책 A 115페이지까지 읽었어": reading card with title, reading state and 115 pages. No completed flag; no destination write until validated receipt.
- "작년에 강릉 다녀왔어": memory/region picker with no guessed day, no invented region identity, no automatic visit from a memory-only statement.
- "오늘 라멘 먹었어": meal card with no invented restaurant, star rating or repeat intent.
- "앨범 X 들었어": only a proposed album listening event; not per-track listened flags without evidence or explicit confirmation.
- Duplicated approve from two devices and after token refresh cannot create two records.
- A client with text-only support remains on the old pending-and-destination-review flow.
