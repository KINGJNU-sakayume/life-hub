# C1a — Life Hub unified proposal cards (review and proposal only)

## Dependency / merge sequence

**Stacked on PR #18** (`feat/cards-architecture`). Merge #18 first, then rebase this branch onto `main` or switch this PR's base after #18 merges. Do not deploy either PR without confirming owner OAuth & UI host support.

No database migration, `hub:approve` scope, approved state, reference uploads, or changes to destination repositories in C1a. **Final approval still happens in PALATE, 켜켜이 and 책장.**

## Visual language

A **single, compact shell** for all cards: small LIFE HUB/destination label, clear task title, one sentence of context, content hero, essential fields, collapsible optional fields, persistent status and submit/cancel controls. Pale neutral backgrounds, restrained green accent, no gradients or stock icons, light/dark themes, Korean UI, 44px-ish touch-friendly buttons, reduced motion, no third-party fonts/assets.

| Variant | Identity area | Priority interactions | Advanced section |
| --- | --- | --- | --- |
| 독서 | Book title + current page / completed | title, reading/completed state, pages | rating (only when completed), author, edition, volume, date, note, 인생책 |
| 식사 | Meal/menu title + optional evaluation | menu, restaurant, verdict, date | reorder intent and note |
| 먹어보기 | Dish/restaurant name and target type | wish name, visit place vs try dish | source URL, note |
| 추억 | Memory title, no image placeholder | title, narrative, original time/place words | emotions as 0–5 explicit chips, resolved date parts, optional music |
| 방문 | Visited place | place, optional date, provisional region hint | note + warning about region-code confirmation in 켜켜이 |

No empty stock-image frames. Date and opinion controls default to blank; not inferred if absent. UI identity summary is derived from current field state, not separately editable. Tapping cancel only closes the draft; **no server write**. Tapping submit calls exactly one existing `propose_*` tool; a real database write occurs only on the deliberate button, then the UI displays candidate ID and `pending`. Duplicate submission is handled by existing server idempotency.

### UX and accessibility review requirements

- Limit always-visible controls to the core workflow; nested optional controls appear only on demand, unless they were prefilled from the user's utterance.
- Long Korean titles, narrow viewport (320–360px), iPhone touch, keyboard focus, visible labels and ARIA status/error alerts must work.
- Empty optional fields must be omitted from the proposal payload. `0` and unvalidated dates must not be silently accepted. Do not silently add a rating/star or restaurant.
- Reading state toggles `current_page` vs `rating/liked`; never send both.
- Memory emotion choice supports up to 5 validated items, never a free-form invented tag.
- Reference hints (e.g. 시군구) are **not** authoritative identifiers; the site still confirms them. Text-only hosts continue with the legacy review flow.
- Do not display a fake final approval button. The only affirmative card action here is **후보로 보내기**; actual destination review is unchanged.

## MCP transport

- The shared `ui://life-hub/proposal-preview.html` HTML resource has `text/html;profile=mcp-app` and zero external CSP domains.
- `ui://life-hub/reading-preview.html` is retained as a backwards-compatible URI and now renders the same shared component.
- Each *read-only* `preview_*` tool returns a validated `{variant, draft, destination, status:'preview'}` structured result, and `_meta.ui.resourceUri`. No preview calls `insertCandidate`.
- Claude and ChatGPT OAuth grants see five preview tools. Codex/text-only and legacy test callers retain the ten original proposal/status tools.
- The HTML uses standard `ui/initialize`, `ui/notifications/initialized`, `ui/notifications/tool-result`, `ui/notifications/tool-input`, `tools/call`, and `ui/notifications/size-changed` messages; `window.openai.toolInput/toolOutput` are optional fallbacks, not a host-specific implementation.
- Existing `propose_*` tool descriptions and REST behavior remain intact. The UI calls these tools through the host, which may still apply platform-level permissions/confirmation.
- **Do not mark cards as live in a host based on CI alone**. MCP protocol tests do not prove iframe lifecycle or OAuth/plugin availability on a specific account. Before production deploy: manually test Claude web/mobile, ChatGPT when available, keyboard/mobile layouts, preview edit→submit, denied permission and text-only fallback.

## Security and data boundaries

No real records, photos, transcript bodies, OAuth tokens or secrets in public code. All examples are synthetic. Read-only previews are validated against each destination's adapter. Tool arguments from the widget are revalidated on submit. There is no auto-approval, no destination receipt, no unverified record confirmation, no extra network privilege, and no new background sync.

## Checklist after CI

1. Verify PR #18 merges first. Update this branch's base to main; resolve any conflicts before merge.
2. Manually deploy the Cloudflare Worker only after reviewing the code (deployment is not automatic).
3. In Claude, reconnect or refresh tool discovery if the new `preview_*` tools are not listed; existing `hub:propose` scope should suffice.
4. Run the synthetic phrase "가상의 책 A 115페이지까지 읽었다고 가정해 카드만 보여줘" only as a **test without submitting**. Once ready, use a real user event to exercise submission and verify it remains pending in the destination.
5. Confirm unsupported clients can still send proposals with the old tools and complete the review inside the respective site.

C1b (separate PR) will research trusted human approval, `hub:approve` and the `approved` state; it is intentionally not part of C1a.
