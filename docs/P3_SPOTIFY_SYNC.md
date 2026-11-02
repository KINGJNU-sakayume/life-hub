# P3 — Spotify listening sync for potcast

Every hour the Worker's cron trigger reads the owner's Spotify **recently played** list and proposes the albums the owner listened to on purpose to potcast. Nothing is recorded until the owner approves each album, track by track, in potcast.

## What counts

- Only plays **started from the album itself** (the play's context is that album). Playlists, radio, artist pages, search results and autoplay never count — music that merely came up is not "digging".
- Plays of one album with gaps of at most an hour form a session. A session is proposed once it is **closed** (last play more than two hours ago), so one listening session is never split across polls.
- Sessions with fewer than 3 distinct tracks (or the whole album when it is shorter) are dropped as "just clicked in".
- Per track: Spotify gives the time each play ended, not its length. The time since the previous play ended approximates it — **listened** when it is at least min(90 % of the track, 2 minutes), otherwise **skipped**. The first play of a session counts as listened (Spotify lists only plays of 30 s or more). The owner corrects anything in potcast.

## Candidate

`destination: potcast`, `source: spotify` (only this collector uses it), `candidate_type: album_listening`, payload `origin: spotify_sync` with `spotify_album_id`, `listened_on` (Korean date of the session start) and per-track `spotify_track_id`, `title`, `status`, `played_at`. Idempotency key `spsync-<album id>-<first play ms>`.

## Storage and privacy

- `spotify_link`: one row per owner — the refresh token **encrypted** (AES-GCM, key from the `HUB_SPOTIFY_TOKEN_KEY` secret, separate from the owner password), the cursor and the last poll result. A revoked authorization stops polling until the owner relinks.
- `spotify_plays`: album-context plays waiting for their session to close (track/album IDs and names, play time, length). Deleted when the session is proposed or dropped, and after 3 days at the latest. No other Spotify data is stored.
- Scope `user-read-recently-played` only.

## Cost

One cron run per hour: one token refresh and one API request (two subrequests), a few D1 rows. No Claude conversation, no model tokens. Well inside the Workers free plan (cron triggers, 100k requests/day, D1 free limits).

## Owner pages

`/spotify` (status), `/spotify/connect`, `/spotify/callback`, `/spotify/poll` ("collect now"), `/spotify/disconnect`. Every action needs the owner password (same throttled check as the consent page).

## Setup

1. Spotify Developer Dashboard → the app potcast already uses (or a new one) → **Redirect URIs**: add `https://<hub origin>/spotify/callback`. The app owner needs Spotify Premium (Spotify's development-mode rule since February 2026).
2. GitHub repository variable `HUB_SPOTIFY_CLIENT_ID` = that app's Client ID.
3. Cloudflare dashboard → Worker `life-hub-api` → Settings → Variables and Secrets → add **Secret** `HUB_SPOTIFY_TOKEN_KEY` = a random string of 32+ characters (a password manager can generate one). Losing or changing it only means linking Spotify again.
4. Deploy with **apply migrations** (0007).
5. Open `https://<hub origin>/spotify`, enter the owner password, approve in Spotify.
