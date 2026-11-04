# P7 — Life board: one page of status cards (design, NOT implemented)

> **Status: proposed.** Nothing in this document exists in code. Do not describe it as deployed and do not fake an
> API for it (AGENTS.md, "Before any remote synchronization…"). Implementing it needs an explicit task per
> repository, and the README line "it is not a new dashboard" must be changed in the same pull request that adds
> the first code (section 9).

## 1. Goal

One private page the owner opens to see "how am I doing" in a few seconds: a vertical scroll of **cards**, one
per area (food, listening, reading, anime, stations, achievements, pending proposals…). Each card shows one or two
numbers, whether they went up or down, and a small trend line. Tapping a card opens the app that owns the data.

Non-goals: editing anything from the board (the apps stay the only writers of their data), several owners, sharing
the page, real-time push, charts of raw records, Hub-side understanding of app data, a second copy of any app's
records. The board shows **summaries the apps chose to publish**, nothing else.

## 2. What the board may show

| Source | Cards | Needs app changes? |
| --- | --- | --- |
| Hub-derived (already in D1) | proposals waiting for review per app, approved/rejected this week, last proposal time | No |
| App summaries (new) | e.g. animan: episodes marked this week; letterbookxd: books finished this year; potcast: albums this week; sub: stations this month; elosorter: tracks ranked | Yes, one small push per app |

Hub-derived cards come first (section 8, stage B1): they make the board useful on day one without touching any app.

The Hub **does not read sync documents** (P6): they stay opaque. A number appears on the board only if the app that
owns it computed it and published it.

## 3. Principles

1. **Read-only and private.** The data is in D1 behind OAuth; the page is static code with no data in it, so it can
   live on a public GitHub Pages site without leaking anything (same rule as the other apps).
2. **Small, typed, whitelisted summaries.** Numbers and short labels only; no free text from the owner's records
   (titles, notes, diary text). A summary that does not match the schema is refused (fail closed).
3. **Never fake.** A card with no data says "not connected yet"; one whose data is older than its allowed age is
   marked stale with its real age. No placeholder values, no demo data in production.
4. **Latest only on the Hub.** The Hub keeps the newest summary per app. Trends (the last N values) are computed by
   the app and sent inside the summary, so the Hub needs no history table.
5. **The app decides what to reveal.** Publishing a summary is opt-in per app, with its own consent checkbox, like
   the sync scope.

## 4. How this meets the AGENTS.md checklist

| Question | Answer |
| --- | --- |
| Identity | One owner (`HUB_OWNER_ID`). Tokens carry a role and scope; a token minted for another owner id is refused, like sync |
| Persistence | D1 table `board_summaries`, one row per (owner, app), replaced by each push |
| Private storage | D1 only; nothing in the repository, nothing in Pages |
| Revocation | OAuth library revoke (disconnect in the page or the app); rotating `HUB_OWNER_ID` invalidates everything |
| Replay | `PUT` is idempotent; a push whose `generated_at` is older than the stored one is ignored (200, `ignored: true`), so a delayed retry cannot overwrite a newer summary |
| Conflict | Last (newest `generated_at`) wins; summaries are derived values, never merged |
| Recovery | The app regenerates its summary from its own data on the next push; nothing in the board is the only copy of anything |

## 5. API (proposed)

Authentication: `Authorization: Bearer <token>`.

| Request | Scope | Meaning |
| --- | --- | --- |
| `PUT /<app>/v1/summary` | `<app>:summary` | The app publishes its newest summary (body below) |
| `GET /<app>/v1/summary` | `<app>:summary` | The app reads back what it published (debugging) |
| `GET /board/v1` | `board:read` | All cards: Hub-derived plus the stored app summaries, in display order |
| `DELETE /<app>/v1/summary` | `<app>:summary` | Remove the app's card (owner decision, e.g. when disconnecting) |

Summary body (JSON, at most **8 KiB** of UTF-8 bytes):

```json
{
  "version": 1,
  "generated_at": "2026-11-04T09:00:00Z",
  "cards": [
    {
      "id": "week-episodes",
      "title": "이번 주 시청",
      "value": 12,
      "unit": "화",
      "delta": 3,
      "series": [4, 7, 5, 9, 12],
      "series_label": "최근 5주",
      "tone": "up-good",
      "max_age_hours": 48
    }
  ]
}
```

Rules, enforced by a schema check in `src/board/checks.js` (not by the destination adapters):

- At most 6 cards per app. `id` is `[a-z0-9-]{1,40}`, unique within the summary. `title`, `unit`, `series_label` are
  strings of at most 40 characters without control characters.
- `value` and `delta` are finite numbers (or `null`); `series` has at most 60 finite numbers.
- `tone` is one of `up-good`, `up-bad`, `neutral`: it says only how to colour a rise, so the page needs no
  knowledge of the app.
- `max_age_hours` is 1–720; after that the card is shown as stale.
- `generated_at` is an ISO instant not more than 5 minutes in the future.
- Unknown fields are rejected here (unlike sync documents, because the page renders every field).
- No `href` field: the page links to the app by the destination registry's own app URL, never to a URL a summary
  supplied (no open redirect, no script URL).

`GET /board/v1` returns `{ generated_at, cards: [{ app, app_label, card, stale, age_seconds, href }] }`. Cards of
apps without a stored summary are returned as `{ app, app_label, empty: true }`.

Storage: `board_summaries(owner_id, app, generated_at, written_at, body_json, size_bytes, PRIMARY KEY(owner_id, app))`
with `CHECK`s like `0009_sync.sql`. Migration `0010`.

Free-tier cost: one small row write per app push; apps push at most once per 10 minutes (debounced, and only when
a value changed). That is far below the D1 daily write allowance even for eight apps.

## 6. The page

- **Where.** Static files (HTML, CSS, JavaScript, no framework needed), published with GitHub Pages from a new
  public repository, proposed name `life-board`. The page is an OAuth public client like the apps: it has its own
  `lifehub-client.json` and callback, asks for scope `board:read`, and stores the token the same way the apps do.
  Alternative considered: serve the page from the Worker behind the owner password. It avoids a second repository
  but adds a cookie session, a new authentication surface the Hub does not have today, and Worker CPU for every
  view, so it is not preferred.
- **Look.** A single column of cards, newest-most-important first (owner-orderable later). Each card: title, big
  value with unit, an up/down arrow with the delta coloured by `tone`, a sparkline from `series`, the app name and
  the data's age ("2시간 전"). Stale cards are dimmed with "오래됨". Works at phone width; honours the system dark
  mode. All text is inserted with `textContent` (never `innerHTML`), and a Content Security Policy
  (CSP, 콘텐츠 보안 정책) limits scripts and connections to the page and the Hub origin.
- **Refresh.** On open, on tab focus, and by a pull-to-refresh button. No polling timer.
- **Empty and error states.** Not connected → one "connect" button; token revoked (`invalid_grant`, `401`) →
  "reconnect"; Hub unreachable → the last successfully loaded cards from memory with a visible "offline" mark.
  Nothing is cached in `localStorage` except the token.

## 7. What each app publishes (first set, owner to confirm)

| App | Cards (ideas, each computed by the app) |
| --- | --- |
| Hub-derived | Pending proposals (value), approved this week (delta vs. last week) |
| animan | Episodes this week (series: last 8 weeks), completed series this year |
| letterbookxd | Books finished this year, reading this month (series: months) |
| potcast | Albums listened this week |
| sub | Stations visited this month, share of stations visited |
| food (PALATE) | Meals logged this week |
| achievement | Records this week, streak days |
| elosorter | Tracks ranked, comparisons this week |
| 일기 룰렛 | Entries this month |

The card list per app is part of that app's own pull request; the Hub only validates the shape.

## 8. Rollout

| Stage | Scope | Done when |
| --- | --- | --- |
| B0 | This document reviewed | Owner accepts or edits it, including the README wording change |
| B1 | Hub: migration `0010`, `GET /board/v1` with Hub-derived cards only, `board` registry entry (read-only, no inbox), scope `board:read`, tests | `npm run check` green; deployed; `curl` with a throwaway token returns the derived cards |
| B2 | `life-board` repository: the page, OAuth client, states from section 6 | The owner sees the derived cards on the phone and desktop, and a disconnected state is honest |
| B3 | Hub: `PUT/GET/DELETE /<app>/v1/summary`, `<app>:summary` opt-in scope on the consent page, schema checks, tests | Round trip with a synthetic summary; stale and replay cases tested |
| B4 | First app publishes (animan: it already has a sync client and debounce) | Its card appears and goes stale correctly when the app stops pushing |
| B5 | Remaining apps, one pull request each | Cards of section 7 present |

B1–B2 and B3–B4 are independent of the P6 stages and of each other.

## 9. Changes in this repository (B1 and B3)

| Where | Change |
| --- | --- |
| `README.md`, `docs/ARCHITECTURE.md` | Replace "it is not a new dashboard" by: Life Hub still stores no app records; it serves a read-only board of summaries the apps publish |
| `src/destinations.js` | Optional `summary: { scope }` per entry; a `board` entry with no inbox, no sync and only the `board:read` scope; update the header comment |
| `src/auth/clients.js`, `src/server/index.js` | Profile and resource for `/board`; `<app>:summary` as an opt-in checkbox for apps that have an inbox; per-route guards like sync |
| `src/board/api.js`, `store.js`, `checks.js` | Routes, D1 access, schema checks |
| `migrations/0010_board.sql` | `board_summaries` |
| `test/board.test.js` | Schema bounds and rejection; replay and out-of-order pushes; isolation by owner and by app; wrong scope; stale marking; no summary text in logs or errors; derived cards from the inbox tables; end to end through the real OAuth library |
| deploy config | `HUB_BOARD_REDIRECT_URI` (the page's callback), same four places as `HUB_ELOSORTER_REDIRECT_URI` |

## 10. Open questions

1. **Hosting of the page**: new `life-board` repository (proposed) or a folder in this repository published from
   Pages? A new repository keeps this one free of front-end code and follows the one-repository-per-app habit.
2. **Is a numbers-only summary enough?** Anything richer (a "this week's highlights" sentence) would need free text
   from the owner's records on a page that is a login away from public; this design deliberately leaves it out.
3. **Order and grouping of cards**: fixed by the Hub (registry order) at first; an owner-editable order is a later
   change.
4. **Should the board also appear inside Claude** (an MCP App card, like P4 cards) so that "how is my week" can be
   answered in conversation from the same summaries? Cheap once B1 exists; not part of this design.
5. **Notifications** (e.g. "nothing logged for 3 days") are out of scope.
