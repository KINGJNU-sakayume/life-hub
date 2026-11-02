# P3 — 역 도장깨기 (sub)

역 도장깨기 keeps one stamp per Seoul-area subway station the user actually visited; a random draw never stamps by itself. Life Hub adds one candidate type, `station_visit`, proposed by Claude through `propose_station_visit`.

## Contract v1

```json
{ "station": "망원", "line": "6호선", "date": "2026-11-01", "note": "..." }
```

- `station` (required, ≤40): the name as the user said it ("망원", "홍대입구역").
- `line` (≤20): only when the user said it or the name is shared by different stations.
- `date` (required): the visit day, resolved by Claude.
- No photos and no station codes; photo stickers are made in the app.

## Flow

1. The app (OAuth public client, `sub:inbox`, resource `/sub`) lists pending proposals in the record drawer.
2. It matches the station by name (and line); the owner picks when several stations share the name.
3. Approving stamps the station with the proposed date as a plain stamp (an existing stamp keeps its date) and offers to open the station to add a photo sticker. The receipt's entity ID is `st_<base64url(station key)>`.
4. Rejecting changes nothing.

## Setup

Repository variable `HUB_SUB_REDIRECT_URI` = `https://<user>.github.io/sub/lifehub/`; deploy. No migration, no reconnect.
