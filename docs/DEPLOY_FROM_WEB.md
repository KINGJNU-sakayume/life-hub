# Deploy P1 without a local computer

Everything below can be done from a browser or the GitHub / Cloudflare mobile web pages. No Wrangler install, no `.dev.vars`, and no secret is ever pasted into a chat or committed.

The Worker **fails closed**: until the `HUB_*` values exist, every route except `/health` returns 503/401. Deploying first and configuring secrets second is therefore safe.

## 1. Cloudflare (dashboard)

1. **Create the D1 database**: Storage & Databases → D1 → Create → name it exactly `life-hub-private`. Copy its **Database ID** (a UUID).
2. **Create an API token**: My Profile → API Tokens → Create Token → *Custom token* with these account permissions only:
   - Workers Scripts: Edit
   - D1: Edit
   - (Account Settings: Read, if Wrangler asks for it)
   Restrict it to your single account. Copy the token once.
3. Note your **Account ID** (shown on the Workers & Pages overview page).

## 2. GitHub (repository secrets)

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | token from step 1.2 |
| `CLOUDFLARE_ACCOUNT_ID` | account ID from step 1.3 |
| `D1_DATABASE_ID` | database UUID from step 1.1 |

Optional: Settings → Environments → `production` → add yourself as a required reviewer so every deploy waits for a tap of approval.

## 3. Run the deploy

Actions → **Deploy (Cloudflare)** → Run workflow. Defaults apply pending migrations and deploy. The workflow runs `npm run check` first, renders the ignored `wrangler.jsonc` from `wrangler.example.jsonc` using the secret, and deletes it afterwards.

Deploys are **manual only**; merging to `main` does not deploy.

## 4. Worker secrets (Cloudflare dashboard)

Workers & Pages → `life-hub-api` → Settings → Variables and Secrets → add each as type **Secret**:

- `HUB_OWNER_ID` — 6–128 characters of letters, digits, `_` or `-` (an opaque label, not your name or email).
- `HUB_OWNER_TOKEN` — required.
- `HUB_CLAUDE_TOKEN`, `HUB_CHATGPT_TOKEN`, `HUB_FOOD_READER_TOKEN` — add only when that integration exists.

Every token must be distinct and random, at least 32 characters of `[A-Za-z0-9_-]`. Generate them with a password manager's generator (letters + digits, 48+ characters), never by hand. The deploy uses `--keep-vars`, so redeploying does not erase them.

## 5. Verify

- `https://life-hub-api.<your-subdomain>.workers.dev/health` → `{"status":"ready-for-configuration"}`.
- Any `/v1/...` request without a token → 401. Before step 4 → 503.

## Notes

- Applying migrations to a database that already holds real candidates changes private data. D1 offers point-in-time restore (Time Travel); confirm it covers your plan before applying a new migration, and keep an independent export.
- Rotating a token = replace the secret in the dashboard; the old value stops working immediately.
- P1 still has no OAuth, no provider connector and no PALATE delivery. See `P1_PRIVATE_API.md` and `ROADMAP.md`.
