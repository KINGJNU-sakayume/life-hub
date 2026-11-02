# P2b — PALATE inbox connection

PALATE (the food log, a static GitHub Pages app) connects to Life Hub with the same owner sign-in as Claude and works through pending food candidates.

```
Claude ──propose──> D1 inbox (pending) <──GET /palate/v1/candidates── PALATE (local inbox, owner reviews)
                         ▲                                                   │ approve → record + receipt in Archive
                         └──── POST /palate/v1/receipts | /rejections ───────┘ (outbox, retried)
```

## API — resource `<origin>/palate`, scope `food:inbox`

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/palate/v1/candidates?status=pending\|all&limit=1..100` | — | `{ candidates: [{ key, hub_id, status, received_at, reviewed_at, confirmed_entity_id, candidate }] }`, `candidate` in PALATE v1 shape |
| POST | `/palate/v1/receipts` | `{ key, entity_type: meal\|wish, entity_id }` | pending → `confirmed` with `confirmed_entity_id`. Same entity again: 200. Different entity, rejected, or type mismatch: 409 |
| POST | `/palate/v1/rejections` | `{ key }` | pending → `rejected`. Again: 200. Confirmed: 409 |

`key` is PALATE's candidate key, `<source>:<idempotency_key>`. Unknown key: 404. Bodies are allowlisted (extra fields: 400). Responses carry CORS headers from the OAuth library; tokens, not origins, are the gate.

## Authorization

- PALATE is a public OAuth client identified by its Client ID Metadata Document (`https://<user>.github.io/food/lifehub-client.json`). DCR is refused for its redirect URI, so nobody can register a look-alike client.
- `/authorize` picks a **client profile** by the exact, library-validated redirect URI (`src/auth/clients.js`). Each profile gets exactly one scope for exactly one resource: Claude → `food:propose` on `/mcp`; PALATE → `food:inbox` on `/palate`. A request naming the other resource is refused.
- Tokens are audience-bound, so a PALATE token is rejected at `/mcp` and vice versa; handlers additionally check `role` and the current `HUB_OWNER_ID`.
- The PALATE profile and API exist only when `HUB_PALATE_REDIRECT_URI` is configured (503 / refused otherwise).

## Setup

1. GitHub → life-hub → Settings → Secrets and variables → Actions → **Variables**: `HUB_PALATE_REDIRECT_URI` = `https://<user>.github.io/food/` (exact app URL, trailing slash).
2. Merge and run **Deploy (Cloudflare)**; it applies migration `0003` (adds `confirmed_entity_id`).
3. Merge the PALATE PR; GitHub Pages publishes it with `lifehub-client.json`.
4. Open PALATE → 후보함 → **Life Hub 연결** → sign in with the owner password.

## Notes

- The Claude connector keeps working: the authorization server now serves two resources and defaults requests without `resource` to `/mcp`.
- `GET /mcp` status for a proposal now shows `confirmed` once PALATE reports the receipt.
- Life Hub never decides approval; it records what PALATE committed. A conflicting later receipt is refused rather than overwriting.
