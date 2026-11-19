/**
 * music run on the owner's computer (`npm run dev` at http://127.0.0.1:5173) connects without a public CIMD document:
 * it registers itself by DCR for its loopback callback and gets music's own profile, only when that callback is
 * configured as HUB_MUSIC_LOCAL_REDIRECT_URI (or, until the rename is finished, the old HUB_POTCAST_LOCAL_REDIRECT_URI).
 * Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestKV } from '../scripts/node-test/d1.mjs';
import worker from '../src/server/index.js';

const ORIGIN = 'https://hub.example';
const LOCAL = 'http://127.0.0.1:5173/lifehub/';
const PASSWORD = 'synthetic-owner-password-' + 'l'.repeat(24);
const makeEnv = (patch = {}) => ({
  DB: new TestD1(), OAUTH_KV: new TestKV(), HUB_PUBLIC_ORIGIN: ORIGIN, HUB_MUSIC_LOCAL_REDIRECT_URI: LOCAL,
  HUB_OWNER_ID: 'demo-owner', HUB_OWNER_PASSWORD: PASSWORD, HUB_OWNER_TOKEN: 'owner_' + 'A'.repeat(48), ...patch,
});
const call = (env, path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, { waitUntil() {}, passThroughOnException() {}, props: {} });
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

function register(env, redirectUris, extraHeaders = {}) {
  return call(env, '/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ client_name: 'music (local)', redirect_uris: redirectUris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
}

async function connect(env, clientId, { redirectUri = LOCAL, scope = 'music:inbox music:board', resource = ORIGIN + '/music' } = {}) {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', state: 's', scope, resource });
  const page = await call(env, '/authorize?' + q);
  const html = await page.text();
  if (page.status !== 200) return { status: page.status, html };
  const handle = /name="handle" value="([^"]+)"/.exec(html)[1];
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const approved = await call(env, '/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ handle, decision: 'approve', password: PASSWORD }) });
  const location = new URL(approved.headers.get('Location'));
  const csp = page.headers.get('Content-Security-Policy');
  const token = await (await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: redirectUri,
      client_id: clientId, code_verifier: verifier, resource }) })).json();
  return { status: 200, html, csp, location, token };
}

test('the local music registers by DCR (with CORS) and gets the music profile, even without a deployed redirect', async () => {
  const env = makeEnv();
  try {
    const registered = await register(env, [LOCAL], { Origin: 'http://127.0.0.1:5173' });
    assert.equal(registered.status, 201, await registered.clone().text());
    assert.ok(registered.headers.get('Access-Control-Allow-Origin'), 'the browser app can read the registration');
    const { client_id: clientId } = await registered.json();

    const { html, csp, location, token } = await connect(env, clientId);
    assert.match(html, /music/);
    assert.match(html, /이 컴퓨터의 앱으로 권한이 전달돼요/, 'the consent page warns about a loopback grant');
    assert.match(csp, /form-action 'self' http:\/\/127\.0\.0\.1:5173/);
    assert.equal(location.origin + location.pathname, LOCAL);
    assert.equal(location.searchParams.get('iss'), ORIGIN);
    assert.equal(token.scope, 'music:inbox music:board');

    const candidates = await call(env, '/music/v1/candidates', { headers: { Authorization: 'Bearer ' + token.access_token } });
    assert.equal(candidates.status, 200, await candidates.clone().text());
    // A music token is not an MCP token.
    assert.equal((await call(env, '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).status, 401);
  } finally { env.DB.close(); }
});

test('the local client cannot ask for another profile, and only exact loopback callbacks register or connect', async () => {
  const env = makeEnv();
  try {
    for (const uri of [
      'http://localhost:5173/lifehub/',
      'http://127.0.0.2:5173/lifehub/',
      'http://127.0.0.1:5173/lifehub/?x=1',
      'http://127.0.0.1:5173/lifehub/#x',
      'http://127.0.0.1:5173/a/../lifehub/',
      'https://127.0.0.1:5173/lifehub/',
      'http://127.0.0.1.evil.example:5173/lifehub/',
      // Well-formed loopback callbacks, but not the configured one.
      'http://127.0.0.1:5174/lifehub/',
      'http://127.0.0.1:5173/lifehub/other',
      'http://127.0.0.1:5173/',
    ]) assert.equal((await register(env, [uri])).status, 400, uri);
    assert.equal((await register(env, [LOCAL, 'https://claude.ai/api/mcp/auth_callback'])).status, 400);

    const { client_id: clientId } = await (await register(env, [LOCAL])).json();
    // The MCP resource and scope are not music's.
    const mcp = await connect(env, clientId, { scope: 'hub:propose', resource: ORIGIN + '/mcp' });
    assert.notEqual(mcp.status, 200);
    // Another destination's resource is refused too.
    const palate = await connect(env, clientId, { scope: 'food:inbox', resource: ORIGIN + '/palate' });
    assert.notEqual(palate.status, 200);
  } finally { env.DB.close(); }
});

test('without a local redirect variable the local copy gets nothing, and music stays off (also on the old path)', async () => {
  const env = makeEnv({ HUB_MUSIC_LOCAL_REDIRECT_URI: undefined });
  try {
    assert.equal((await register(env, [LOCAL])).status, 400);
    assert.equal((await call(env, '/music/v1/candidates')).status, 503);
    assert.equal((await call(env, '/potcast/v1/candidates')).status, 503);
  } finally { env.DB.close(); }
});

test('the deployed music keeps working beside the local one', async () => {
  const env = makeEnv({ HUB_MUSIC_REDIRECT_URI: 'https://owner.github.io/music/lifehub/' });
  try {
    const { client_id: clientId } = await (await register(env, [LOCAL])).json();
    const { token } = await connect(env, clientId);
    assert.equal(token.scope, 'music:inbox music:board');
  } finally { env.DB.close(); }
});

/* ---------- Rename: the old potcast names keep working (aliases, removable later) ---------- */

test('legacy: only the old HUB_POTCAST_LOCAL_REDIRECT_URI set, the local app still registers and connects', async () => {
  const env = makeEnv({ HUB_MUSIC_LOCAL_REDIRECT_URI: undefined, HUB_POTCAST_LOCAL_REDIRECT_URI: LOCAL });
  try {
    const registered = await register(env, [LOCAL]);
    assert.equal(registered.status, 201, await registered.clone().text());
    const { client_id: clientId } = await registered.json();
    // A new client asks for /music and gets music:*.
    const fresh = await connect(env, clientId);
    assert.equal(fresh.token.scope, 'music:inbox music:board');
    // A client from before the rename asks for /potcast and gets the scopes it knows.
    const old = await connect(env, clientId, { scope: 'potcast:inbox potcast:board', resource: ORIGIN + '/potcast' });
    assert.equal(old.status, 200, old.html);
    assert.equal(old.token.scope, 'potcast:inbox potcast:board');
    for (const t of [fresh.token.access_token, old.token.access_token]) {
      for (const path of ['/music/v1/candidates', '/potcast/v1/candidates']) {
        const r = await call(env, path, { headers: { Authorization: 'Bearer ' + t } });
        assert.equal(r.status, 200, path + ' ' + (await r.clone().text()));
      }
    }
  } finally { env.DB.close(); }
});
