# P4 — Claude conversation cards (MCP Apps)

When Claude proposes a record, the result shows an interactive **card** in the conversation. The owner can
read it, edit it in place, and approve or reject it there, instead of opening each app to review it. Clients
that cannot show cards (and Codex/ChatGPT) keep today's flow: a text result plus review in the app.

Design reference: the "Life Hub 대화 카드 시안" canvas (v4). The shell is shared (eyebrow + status pill,
destination body, footer). The only buttons are 「수정」 and 「승인」; 거절 and app links are text links. Values are
plain text until 「수정」 is opened, and a selected chip toggles off when tapped again (no "선택 안 함" chip).
역 도장깨기 and 일기 룰렛 keep their own body stage (역명판 / slot drum) inside the same shell.

## Wire format (MCP Apps 2026-01-26, no SDK)

| Piece | Where | Notes |
| --- | --- | --- |
| Card resource | `ui://life-hub/card-<destination>.html`, `text/html;profile=mcp-app` | `resources/list`/`read` for Claude grants. `_meta.ui.csp` declares no domains (no network, no remote assets); `prefersBorder: false`. Each card < 25 KB, inline CSS/JS (`src/mcp/cards/`). |
| Tool → card | `propose_*` tools of a destination with a card get `_meta.ui.resourceUri` (Claude only) | Text `content` is unchanged, so text-only hosts work as before. |
| Card data | result `structuredContent.card` | `{candidate_id, destination, app, app_url, type, label, status, revision, payload, needs_app_review, approve, refs?}`. `approve` is `ok`, `app` (the app does not accept card approval yet) or `scope` (grant without hub:approve). `refs` (e.g. 켜켜이's 시군구 list) is only in `card_*` results, which go to the card and not to the model; the first render's `card_refresh` brings it. |
| Approval ticket | result `_meta["life-hub/card"].ticket` | 32 random bytes, base64url. Only its SHA-256 is stored (`card_tickets`, 7 days). Never in `content` or `structuredContent`. |
| Body hooks | `src/mcp/cards/shell.js` | `view`/`edit`/`read`, optional `bind`, `preApprove`, `noEdit`, `approveLabel`, `foot`, `mount`, `afterApprove`, extra body CSS. |
| Card actions | `card_refresh`, `card_edit`, `card_approve`, `card_reject` | `_meta.ui.visibility: ["app"]`, listed only for a Claude grant with `hub:approve`. |
| Bridge | `ui/initialize` → `ui/notifications/initialized`, `ui/notifications/tool-result`, `tools/call`, `ui/open-link`, `ui/notifications/size-changed`, `host-context-changed` (theme) | Hand-written in `shell.js`. A card re-drawn from history calls `card_refresh` once to show the current state. |

## Who can approve (and who cannot)

- `hub:approve` is a separate scope, offered **only on Claude's consent page** as the checkbox
  「Claude 대화 카드에서 승인도 허용」 and granted only when ticked together with the owner password. Existing
  connections keep `hub:propose` only until the owner reconnects once. ChatGPT and Codex never get it.
- The model cannot approve: the card tools are app-only (hosts must not list them to the model), they refuse
  any connection that is not Claude with `hub:approve`, and every call needs the ticket that only the card
  receives. Wrong, foreign, expired or reused tickets fail with no state change (`test/cards.test.js`).
- Residual risk, stated plainly: a host that ignored the spec — showing result `_meta` to the model *and* letting
  it call app-only tools — could approve without a click. That is why only Claude gets `hub:approve`.
- `source: claude` in a payload is never authentication; provenance comes from the OAuth role.

## States

```
pending ──card_edit──▶ pending (revision+1, final_payload)        original envelope_json is kept
pending ──card_approve──▶ approved ──app receipt──▶ confirmed
        │                     └──app rejection (last check)──▶ rejected
        └──card_reject / app rejection──▶ rejected
pending ──app receipt──▶ confirmed                                  (unchanged app review)
```

`approved` means "the owner finalised it in Claude; the app has not saved it yet".
`card_approve` sets `needs_app_review` when the card asks for it (「켜켜이에서 정할게요」, 「PALATE에서 마저 할게요」) **or**
whenever the app could not save the final payload as is, whatever the card sent: a PALATE meal without date, verdict
and reorder intent; a 켜켜이 visit whose `region_hint` is not exactly one shared 시군구 label; a 켜켜이 memory with a
place but no exact label. The card shows the same rule before approving (`preApprove`) and offers 「수정」. User-facing text says
「승인됨 · 다음에 앱을 열면 저장돼요」, never "saved". `needs_app_review` asks the app for a last check (e.g. no
시군구 chosen). Edits and approval use `revision` as an optimistic lock, so a double click or two devices
approve once. Events: `inbox_changes` gains `edited`.

A destination's card may approve only when its registry entry has `card.approve: true`, which is switched on
in the same release in which that app starts syncing `approved` candidates. Until then the card can edit and
reject, and points to the app for approval.

## Destination inbox API additions

- `GET <path>/v1/candidates?status=pending|approved|open|all` (`open` = pending + approved; default stays
  `pending`, so older app versions are unaffected). Each candidate also has `revision`, `final_candidate` (the
  owner's edited version, or `null`), `approved_at`, `needs_app_review`.
- Apps save `final_candidate ?? candidate` of an approved item without asking — unless `needs_app_review` or
  the app setting 「Claude에서 승인된 항목 자동 반영」 (default on) is off — then send the usual receipt.
- `PUT <path>/v1/refs/<kind>` `{revision, items: [{id, label, group?}]}`: small reference lists the app shares
  for card pickers (≤ 500 items, ≤ 32 KB, only kinds listed in the registry `refKinds`, newer revision wins).
  Public-safe identifiers and labels only — never records, diary text or listening history.
- Receipts and rejections now also accept `codex:` keys.

## Free-plan budget

One D1 row per ticket (deleted by the hourly cron after expiry), one `card_refresh` per card render, no polling,
no KV/R2. Card HTML is served from the Worker bundle.

## Rollout

| Stage | Scope |
| --- | --- |
| 1 (done) | Shared shell, food card, app-only tools, `hub:approve`, `approved` state (0008), inbox `open`/`approved`, refs API. Approval stays off for every destination. |
| 2 (done) | PALATE + 켜켜이: cards for meal/wish/memory/visit (시군구 from refs), app auto-apply with setting; `card.approve` on for both. |
| 3 (done) | Diaryroulette: new destination, daily mission (KST date → mission id, drawn by Life Hub from the app's shared list, checked again by the app), roulette card with 「일기 쓰기」; diary text never leaves the app (`P3_DIARYROULETTE.md`). |
| 4 (done) | 업적 라이브러리: record card + `achievement_definition` (count/total/streak/tag/tag_count), category picker from the owner's tree (`P3_ACHIEVEMENT.md`). Shared picker (`cards/picker.js`) also used by 켜켜이. |
| 5 (done) | 역 도장깨기: draw card (from the shared pool) + visit card (stamp), per-kind refs limits (`P3_SUB.md`); R2 photo hand-off stays a separate step. |
| 6 | AniMan progress card (this; `P3_ANIMAN.md`). 책장 waits for letterbookxd #14. |
| 7 | potcast: track-level card on the existing Spotify sync. |

## After deploying stage 1

1. Apply migration 0008 (the deploy workflow's "apply migrations" option) and deploy the Worker.
2. In Claude, disconnect and reconnect the Life Hub connector once; on the consent page tick
   「Claude 대화 카드에서 승인도 허용」 if you want card approval.
3. Ask Claude to propose a synthetic-looking meal and check the card on web, desktop and mobile. If a client
   shows no card, the text result and PALATE review still work.

## After deploying stage 2

1. Deploy PALATE (food) and 켜켜이 with their stage-2 releases first; open 켜켜이 once so it shares its 시군구 list.
2. Deploy the Worker (no migration). PALATE and 켜켜이 cards can now approve.
3. In Claude, propose a synthetic memory and visit; pick a 시군구 in the card and approve, then open 켜켜이: it is
   saved without asking. Approve one with 「켜켜이에서 정할게요」: it waits in 켜켜이's proposals.
