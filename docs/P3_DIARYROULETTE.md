# 일기 룰렛 (Diaryroulette) destination

일기 룰렛 picks **one writing mission per diary day** (a day starts at 02:00 local time) with a 7-day cooldown, and
keeps every diary on the device. Life Hub can spin the roulette from a Claude conversation, but the app stays the
authority for the day's mission: Life Hub only draws from what the app shared, and the app checks again before
saving. **Diary text never leaves the app.**

| Piece | Value |
| --- | --- |
| Destination | `diaryroulette`, app 「일기 룰렛」, resource `/diaryroulette`, scope `diaryroulette:inbox`, redirect `HUB_DIARYROULETTE_REDIRECT_URI` |
| Candidate | `daily_mission` `{ date: 'YYYY-MM-DD', mission_id }` (`src/adapters/diaryroulette.js`) |
| Receipt | `entity_type: 'daily_mission'`, `entity_id: <date>` |
| Reference lists (`PUT /diaryroulette/v1/refs/<kind>`) | `missions`: `[{id, label: title, group: category}]`; `state`: resting missions `{group: 'resting'}` and the mission already drawn today `{group: 'today:YYYY-MM-DD'}`. Ids and public titles only. |

## `propose_daily_mission` (no input)

1. No shared `missions` list → input error ("connect 일기 룰렛 and open it once"); nothing is stored.
2. `state` has a mission for today's diary day (KST, before 02:00 = previous day) → that mission is returned with a
   `drawn` card; nothing is drawn or stored.
3. A candidate for today already exists (asked again) → the same candidate and mission (no re-roll).
4. Otherwise Life Hub draws uniformly (`crypto.getRandomValues`) from `missions` minus `resting` (all of them if
   everything rests) and stores a pending candidate. The model never chooses or suggests a mission.

## The app (on open)

Approved by the owner (「일기 쓰기」 in the card) and auto-apply on: the app saves it only if the date is today's
diary day, that day has no other mission, and the mission is not cooling down by its own rules; it draws the
mission's extras itself and sends the receipt. A past day or a day that already has another mission is rejected (the
app's last check); a mission still cooling down waits for the owner on the home screen. Pending proposals (e.g. from
ChatGPT or Codex) show there too.

## Card

The app's slot drum (56 px rows × 5, easeOutQuart 2.8 s, paper colours, serif result) turns once to the drawn
mission when a fresh pending proposal for today appears; redrawn later it rests on the result. 「일기 쓰기」 approves and
opens the app on `#/write`; 「거절」 is a text link. No edit.
