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

## Card and auto-apply (cards stage 6)

The 책장 card shows the title, author/publisher/volume, the state (읽는 중 · 쪽 / 완독 · 별점 · 인생책 · 완독일) and
the note; 「수정」 edits every field with the same rules as the contract (a page only while reading, stars and
인생책 only when finished). Titles come from the app's catalogue:

- `PUT /letterbookxd/v1/refs/works`: `{id: work id, label: title, group: author}`.
- `PUT /letterbookxd/v1/refs/editions`: `{id: edition id, label: publisher, group: "<work id>/<volume>"}`.

`card_approve` keeps a last check in the app unless the book is clear (`bookMatch`, like the app's
findWorks/publishersOf/volumesOf): the title (and the author when given) means exactly one work, which has one
publisher or the named one, and there one volume or the named one. The card says what is missing before approving.

책장 syncs `status=open` and records `final_candidate ?? candidate` of an approved, clear proposal through its own
log store (setting 「Claude에서 승인된 항목 자동 반영」, default on, per device) and sends the usual receipt; anything
else stays in its list as 「Claude에서 승인함 · 확인 필요」 for the owner to pick the edition and volume.

## Setup

Repository variable `HUB_LETTERBOOKXD_REDIRECT_URI` = `https://<user>.github.io/letterbookxd/lifehub/`; deploy. No migration, no reconnect.
