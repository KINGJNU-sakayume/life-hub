# P3 — 책장 (letterbookxd)

책장 keeps reading state per volume of a catalogued edition (publisher) of a work. Life Hub adds one candidate type, `reading_record`, proposed by Claude through `propose_reading_record`.

## Contract v1

```json
{ "title": "데미안", "author": "헤르만 헤세", "publisher": "민음사", "volume": 1,
  "state": "completed", "rating": 4, "liked": true, "date": "2026-11-01", "note": "..." }
```

- `title` (required) and `state` (`reading` | `completed`, required).
- `author`, `publisher`, `volume` (1–200) only help 책장 find the book in its own catalogue.
- `reading` may carry `current_page` (1–20000); `completed` may carry `rating` (1–5 stars) and `liked: true` (인생책).
- `date`: the day it was finished or of the update. `note` is shown while reviewing.
- No catalogue IDs, ISBNs or covers from the assistant.

## Flow

1. The signed-in owner connects 책장 to Life Hub (`letterbookxd:inbox`, resource `/letterbookxd`).
2. 책장 matches each proposal against its catalogue (title, then author/publisher/volume). The owner picks the work, edition and volume when it is not unique; books not in the catalogue wait until they are added.
3. Approving writes through 책장's own log store (the same completion cascade as the UI); the receipt carries the volume log ID.
4. Rejecting changes nothing.

## Setup

Repository variable `HUB_LETTERBOOKXD_REDIRECT_URI` = `https://<user>.github.io/letterbookxd/lifehub/`; deploy. No migration, no reconnect.
