# P3 — potcast (album listening)

Third destination. One candidate = one album the user listened to **on purpose** (digging, album listening). Music that merely played (playlists, radio, autoplay, background) is out of scope.

## Candidate `album_listening` (`src/adapters/potcast.js`)

| Field | Rule |
| --- | --- |
| `artist`, `album` | required |
| `spotify_album_id`? | 22-char Spotify ID, only if known |
| `origin` | `conversation` (the user said it) or `spotify_history` (from their Spotify streaming-history file, after they confirmed the album) |
| `listened_on`? | YYYY-MM-DD |
| `whole_album: true` **or** `tracks[]` | exactly one; history always has tracks |
| `tracks[]` (≤80) | `{ title?, spotify_track_id?, status: listened\|skipped, played_at? }`, title or id required, ids unique |

No IPs, user agents, usernames or raw history rows are accepted.

## Claude tool `propose_album_listening`

For a history file Claude must analyse it with code, use only the listed fields, keep album sessions (several tracks of one album close together, shuffle off), mark a track listened when `reason_end` is `trackdone` or it was not skipped and `ms_played ≥ 120000`, list candidate albums to the user in small batches, and propose only the confirmed ones. potcast then shows each album's tracks for a final review.

## Scopes

Claude now gets one scope, `hub:propose`, which covers every destination. Grants from before carry `food:propose`/`kyeokyeoi:propose`; those keep working for food and 켜켜이, and potcast tools ask for a reconnect. Future destinations need no reconnect.

## Storage

Migration `0005` drops the destination CHECK (adapters validate every insert), so new destinations need no table rebuild.

## Setup

1. Variable `HUB_POTCAST_REDIRECT_URI` = `https://<user>.github.io/potcast/lifehub/` (potcast's Life Hub callback page; the app root is taken by its Spotify sign-in).
2. Merge → **Deploy (Cloudflare)** (applies `0005`).
3. Reconnect the Claude connector once (now `hub:propose`).
