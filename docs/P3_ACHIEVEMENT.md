# P3 — 업적 라이브러리 (achievement)

업적 라이브러리 turns activity records (category, date, optional amount, tags, memo) into achievements. Life Hub adds one candidate type, `activity_record`, proposed by Claude through `propose_activity_record`.

## Contract v1

```json
{ "category": "러닝", "date": "2026-11-02", "value": 5, "unit": "km", "tags": ["새벽"], "memo": "..." }
```

- `category` (required, ≤60): the category name as the user would call it. The app matches it against the owner's own category tree (exact name, then unique normalised match); otherwise the owner picks.
- `date` (required): the day it happened, resolved by Claude (same date rule as 켜켜이).
- `value` ≥ 0 and `unit` (≤20) only when the user gave an amount; a unit needs a value. The app converts units.
- `tags`: 1–10 unique one-word keywords; achievements look for tags such as 남산, 대회, PB, 입사.
- No photos, category IDs or achievement IDs from the assistant.

## Flow

1. Claude proposes; the candidate is pending in the hub.
2. The app (OAuth public client, `achievement:inbox`, resource `/achievement`) lists pending candidates.
3. The owner opens one: the normal record editor opens pre-filled, with its live preview of achievements the record would earn. Saving creates the record with ID `lh_<key>`; the receipt (`entity_type: activity_record`, `entity_id` = record ID) is sent on the next sync and can be rebuilt from the records themselves.
4. Rejecting changes no records and is reported as a rejection.

## Setup

Repository variable `HUB_ACHIEVEMENT_REDIRECT_URI` = the app's callback page, e.g. `https://<user>.github.io/achievement/lifehub/`; then deploy. No migration is needed. Claude connections with `hub:propose` need no reconnect.
