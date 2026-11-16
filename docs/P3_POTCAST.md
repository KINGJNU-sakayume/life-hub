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
| `tracks[]` (≤80) | `{ title?, spotify_track_id?, status: listened, played_at? }` — only tracks that were listened to; title or id required, ids unique. Older proposals may still carry `status: skipped`: it stays valid to read, the `propose_album_listening` tool leaves such tracks out, and potcast drops them (it has no skipped state) |

No IPs, user agents, usernames or raw history rows are accepted.

## Claude tool `propose_album_listening`

For a history file Claude must analyse it with code, use only the listed fields, keep album sessions (several tracks of one album close together, shuffle off), list a track only when `reason_end` is `trackdone` or it was not skipped and `ms_played ≥ 120000` (every other track is left out), list candidate albums to the user in small batches, and propose only the confirmed ones. potcast then shows each album's tracks for a final review.

## Scopes

Claude now gets one scope, `hub:propose`, which covers every destination. Grants from before carry `food:propose`/`kyeokyeoi:propose`; those keep working for food and 켜켜이, and potcast tools ask for a reconnect. Future destinations need no reconnect.

## Storage

Migration `0005` drops the destination CHECK (adapters validate every insert), so new destinations need no table rebuild.

## Card and review_listening (cards stage 7)

- The potcast card shows one album (title, artist, day, where it came from) and the tracks that were listened to;
  「수정」 can switch a track off (at least one stays) and change the note only (album, artist, Spotify IDs and play times stay).
- **`review_listening`** (`{ candidate_id? }`): albums the hourly Spotify collection proposes never pass through a
  conversation, so this tool shows one pending album at a time as that card — Spotify-collected first, oldest first —
  with how many more are waiting. It only reads (plus the card's ticket). ChatGPT/Codex get the text.
- `card_approve` keeps a last check in the app when the album has neither a Spotify album ID nor a track ID (potcast
  cannot find it exactly). potcast records an approved album when the library opens if it resolves exactly and every
  track matched, with the setting 「Claude에서 승인된 항목 자동 반영」 (default on); otherwise it waits in the drawer.

## Setup

1. Variable `HUB_POTCAST_REDIRECT_URI` = `https://<user>.github.io/potcast/lifehub/` (potcast's Life Hub callback page; the app root is taken by its Spotify sign-in).
2. Merge → **Deploy (Cloudflare)** (applies `0005`).
3. Reconnect the Claude connector once (now `hub:propose`).

**Running potcast on your computer** (arcplayer, `npm run dev` at `http://127.0.0.1:5173`): set the variable
`HUB_POTCAST_LOCAL_REDIRECT_URI` = `http://127.0.0.1:5173/lifehub/` and deploy. The local app has no public client
document, so it registers itself once by DCR for exactly that loopback callback (any other callback is refused) and
gets potcast's own profile and scopes; the consent page asks for the owner password and warns that the grant goes to
this computer. It works with or without `HUB_POTCAST_REDIRECT_URI`.
