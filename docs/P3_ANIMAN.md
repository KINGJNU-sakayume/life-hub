# P3 — AniMan

AniMan tracks, per series, which anime episodes and manga volumes the user finished, mapped onto the original chapters. Life Hub adds one candidate type, `media_progress`, proposed by Claude through `propose_media_progress`.

## Contract v1

```json
{ "title": "주술회전", "kind": "episode", "season": 2, "up_to": 5, "note": "..." }
{ "title": "최애의 아이", "kind": "volume", "numbers": [3, 5] }
```

- `title` (required, ≤100) and `kind` (`episode` | `volume`, required).
- Exactly one of `up_to` (everything up to and including that number) or `numbers` (1–50 specific ones).
- `season` (episodes only): the user counted within that season ("2기 5화"); AniMan converts it with its season chapter ranges.
- No catalogue IDs from the assistant.

## Flow

1. The app (OAuth public client, `animan:inbox`, resource `/animan`) lists proposals on the landing page.
2. It matches the series by title against its catalogue (bundled series + local drafts) and shows exactly which episodes/volumes would be marked; the owner picks when the title is ambiguous. Series missing from the catalogue wait until they are added.
3. Approving marks them through `src/lib/progress` (`markCompleted`, never removes); the receipt carries the series ID.
4. Rejecting changes nothing.

## Setup

Repository variable `HUB_ANIMAN_REDIRECT_URI` = `https://<user>.github.io/AniMan/lifehub/`; deploy. No migration, no reconnect.
