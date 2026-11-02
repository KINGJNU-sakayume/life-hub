# Deploy without a local computer

Everything below can be done from a browser or the GitHub / Cloudflare mobile web pages. No Wrangler install, no `.dev.vars`, and no secret is ever pasted into a chat or committed.

The Worker **fails closed**: until its secrets exist, every route except `/health` returns 503/401, and OAuth/MCP routes return 503 until P2 is configured. Deploying first and configuring secrets second is therefore safe.

## 1. Cloudflare (dashboard)

1. **Create the D1 database**: Storage & Databases → D1 → Create → name it exactly `life-hub-private`. Copy its **Database ID** (a UUID).
2. **Create the KV namespace** (P2, OAuth storage): Storage & Databases → KV → Create → any name such as `life-hub-oauth`. Copy its **Namespace ID** (32 hex characters).
3. **Create an API token**: My Profile → API Tokens → Create Token → *Custom token* with these account permissions only:
   - Workers Scripts: Edit
   - D1: Edit
   - Workers KV Storage: Edit
   - (Account Settings: Read, if Wrangler asks for it)
   Restrict it to your single account. Copy the token once. An existing P1 token can be edited to add the KV permission.
4. Note your **Account ID** (shown on the Workers & Pages overview page).
5. **Register a workers.dev subdomain** (one time per account): Workers & Pages → Overview (or Settings → Subdomain) → choose a name. Without it the deploy step uploads the Worker but fails with *"You need to register a workers.dev subdomain before publishing to workers.dev"*.

## 2. GitHub (repository secrets and variables)

Settings → Secrets and variables → Actions.

**Secrets** tab → New repository secret:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | token from step 1.3 |
| `CLOUDFLARE_ACCOUNT_ID` | account ID from step 1.4 |
| `D1_DATABASE_ID` | database UUID from step 1.1 |
| `KV_NAMESPACE_ID` | namespace ID from step 1.2 |

**Variables** tab → New repository variable (not secret; it is the public address):

| Variable | Value |
| --- | --- |
| `HUB_PUBLIC_ORIGIN` | `https://life-hub-api.<your-subdomain>.workers.dev` — exactly, no trailing slash or path |
| `HUB_PALATE_REDIRECT_URI` | optional (P2b): PALATE's app URL, e.g. `https://<user>.github.io/food/` |
| `HUB_KYEOKYEOI_REDIRECT_URI` | optional (P3): 켜켜이's app URL, e.g. `https://<user>.github.io/kyeokyeoi/` |
| `HUB_POTCAST_REDIRECT_URI` | optional (P3): potcast's Life Hub callback page, e.g. `https://<user>.github.io/potcast/lifehub/` |
| `HUB_ANIMAN_REDIRECT_URI` | optional (P3): AniMan's Life Hub callback page, e.g. `https://<user>.github.io/AniMan/lifehub/` |
| `HUB_SUB_REDIRECT_URI` | optional (P3): 역 도장깨기 (sub)'s Life Hub callback page, e.g. `https://<user>.github.io/sub/lifehub/` |
| `HUB_LETTERBOOKXD_REDIRECT_URI` | optional (P3): 책장 (letterbookxd)'s Life Hub callback page, e.g. `https://<user>.github.io/letterbookxd/lifehub/` |
| `HUB_ACHIEVEMENT_REDIRECT_URI` | optional (P3): 업적 라이브러리's Life Hub callback page, e.g. `https://<user>.github.io/achievement/lifehub/` |

Optional: Settings → Environments → `production` → add yourself as a required reviewer so every deploy waits for a tap of approval.

## 3. Run the deploy

Actions → **Deploy (Cloudflare)** → Run workflow. Defaults apply pending migrations and deploy. The workflow installs dependencies, runs `npm run check`, renders the ignored `wrangler.jsonc` from `wrangler.example.jsonc`, and deletes it afterwards.

Deploys are **manual only**; merging to `main` does not deploy.

## 4. Worker secrets (Cloudflare dashboard)

Workers & Pages → `life-hub-api` → Settings → Variables and Secrets → add each as type **Secret**:

- `HUB_OWNER_ID` — 6–128 characters of letters, digits, `_` or `-` (an opaque label, not your name or email). Changing it later disconnects every Claude connection.
- `HUB_OWNER_TOKEN` — P1 owner API token.
- `HUB_OWNER_PASSWORD` — P2: the password you type when connecting Claude. At least 20 characters; save it in your password manager so it can autofill on the phone.
- `HUB_CLAUDE_TOKEN`, `HUB_CHATGPT_TOKEN`, `HUB_FOOD_READER_TOKEN` — P1 server-to-server tokens; add only when that integration exists. The Claude connector does **not** use `HUB_CLAUDE_TOKEN`.

Every token must be distinct and random, at least 32 characters of `[A-Za-z0-9_-]`. Generate tokens and the password with a password manager (letters + digits, 48+ characters), never by hand. The deploy uses `--keep-vars`, so redeploying does not erase them.

## 5. Verify

- `<origin>/health` → `{"status":"ready-for-configuration"}`.
- Any `/v1/...` request without a token → 401. Before step 4 → 503.
- `<origin>/.well-known/oauth-protected-resource/mcp` → JSON whose `resource` is `<origin>/mcp`.

## 6. Connect Claude (P2)

See [P2_CLAUDE_CONNECTOR.md](P2_CLAUDE_CONNECTOR.md). In short: add a custom connector in Claude with the URL `<origin>/mcp`, then sign in on the Life Hub page with `HUB_OWNER_PASSWORD`.

## Notes

- Applying migrations to a database that already holds real candidates changes private data. D1 offers point-in-time restore (Time Travel); confirm it covers your plan before applying a new migration, and keep an independent export.
- Rotating a token or the password = replace the secret in the dashboard; the old value stops working immediately. Existing Claude connections keep working until their tokens expire (refresh grants last up to 30 days) unless `HUB_OWNER_ID` changes.
- PALATE still does not receive candidates automatically. See `P2_CLAUDE_CONNECTOR.md` and `ROADMAP.md`.
