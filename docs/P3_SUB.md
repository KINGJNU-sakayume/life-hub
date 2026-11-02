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


## Cards stage 5: station draw and the station card

- **`station_draw`** `{ date, line, station }` (`propose_station_draw`, no input). Life Hub draws like the app — a
  line first, then a station on it — only from the **pool** the app shares (`PUT /sub/v1/refs/pool`: the stations
  drawable right now, which reflects the lines switched on, the area, and "unvisited only"; the owner chose to share
  it). Approved (「여기 갈래요」), the app makes it the current destination after checking it is still drawable and
  the date is today; a draw never stamps.
- **Reference lists**: `lines` (`{id, label: name, group: colour}`), `stations` (the public line-station list,
  `{id, label: station name, group: line name}`, 652 items) and `pool` (same shape). sub raises the refs limit for
  `stations` and `pool` to 800 items / 48 KB (`refLimits`). The card gets `lines` and `stations` (a draw card only
  the drawn line's), never the pool.
- **Station card**: a 역명판 (line colour, the station, its neighbours). A fresh pending draw rolls like
  `core/draw.js` (lines top→bottom slowing down, then stations, then a brake shake); a visit card edits the station
  with the app's station names. A visit is stamped without asking only when its name means exactly one station
  (`stationMatches`, like the app's `findStations`); otherwise `card_approve` keeps a last check in the app.
