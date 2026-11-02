# P3 — 켜켜이 (kyeokyeoi) connection

Second destination, same shape as PALATE: Claude proposes, 켜켜이 pulls, the owner decides in 켜켜이, 켜켜이 reports back.

## Candidates (`destination: kyeokyeoi`, `src/adapters/kyeokyeoi.js`)

| Type | Payload | Rule |
| --- | --- | --- |
| `memory` | `title` (≤80), `memo`?, `time_text`?, `year`?/`month`?/`day`?, `place_text`?, `region_hint`? (≤60), `emotions`? (fixed labels, ≤5), `song_artist`?, `song_title`? | `time_text`/`place_text` keep the user's words. Claude resolves the date (month/day without a year → this year, or last year if still ahead; relative dates from today; never from ages) and the place to a 시군구 (`region_hint`, e.g. 고양종합운동장 → "경기 고양시 일산서구"), and fills the artist for concerts/music. A month needs a year, a day needs a month and must be a real date. **A memory never creates a visit.** |
| `visit` | `place_text` (≤100), `region_hint`?, `visited_on`? (YYYY-MM-DD), `note`? | Only when the user explicitly says they went. |

No region codes, photos or transcripts from the assistant. 켜켜이 pre-selects the region only when `region_hint` matches exactly one 시군구, and pre-fills everything else; the owner confirms before saving.

## Claude tools

`propose_memory`, `propose_region_visit` (scope `kyeokyeoi:propose`), and `get_proposal_status` for any destination (the old `get_food_candidate_status` name is still answered). A Claude connection authorized before this change has only `food:propose`; 켜켜이 tools then tell Claude to ask the user to reconnect, and food tools keep working.

## 켜켜이 API — resource `<origin>/kyeokyeoi`, scope `kyeokyeoi:inbox`

Same as PALATE's (`docs/P2B_PALATE.md`) under `/kyeokyeoi/v1`; receipt `entity_type` is `memory` or `visit`. Each app sees only its destination's candidates, and tokens are audience-bound to their own resource.

## Storage

Migration `0004` rebuilds `inbox` (and its change log, preserving sequence numbers) so `destination` may be `food` or `kyeokyeoi`. SQLite cannot alter a CHECK constraint in place.

## Setup

1. life-hub repository **variable** `HUB_KYEOKYEOI_REDIRECT_URI` = `https://<user>.github.io/kyeokyeoi/`
2. Merge and run **Deploy (Cloudflare)** (applies `0004`).
3. Reconnect the Life Hub connector in Claude once (new scope).
4. Merge the 켜켜이 PR; open 켜켜이 → 설정 → Life Hub 연결.
