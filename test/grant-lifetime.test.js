/**
 * Grant lifetime and client registration (docs/P6_SYNC.md section 7): no practical expiry. New grants carry no
 * absolute expiry, every refresh restarts a 10-year idle lifetime (which also lifts grants issued under the old
 * 30-day default), new DCR registrations never expire, and revocation and owner rotation still end access. Runs the real @cloudflare/workers-oauth-provider
 * with a mocked clock. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestKV } from '../scripts/node-test/d1.mjs';
import worker from '../src/server/index.js';

const ORIGIN = 'https://hub.example';
const RESOURCE = ORIGIN + '/mcp';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'synthetic-owner-password-' + 'g'.repeat(24);
const DAY = 24 * 60 * 60;
const IDLE_TTL = 315360000; // 10 years, in seconds
const OLD_DEFAULT_TTL = 30 * DAY; // the library default this change overrides

function makeEnv() {
  const kv = new TestKV();
  const grantPuts = [];
  const clientPuts = [];
  const put = kv.put.bind(kv);
  kv.put = async (key, value, options = {}) => {
    if (key.startsWith('grant:')) grantPuts.push({ key, options });
    if (key.startsWith('client:')) clientPuts.push({ key, options });
    return put(key, value, options);
  };
  return {
    env: { DB: new TestD1(), OAUTH_KV: kv, HUB_PUBLIC_ORIGIN: ORIGIN, HUB_OWNER_ID: 'demo-owner',
      HUB_OWNER_PASSWORD: PASSWORD, HUB_OWNER_TOKEN: 'owner_' + 'G'.repeat(48) },
    grantPuts, clientPuts,
  };
}
const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} });
const call = (env, path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, ctx());
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function token(env, params) {
  const response = await call(env, '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const refresh = (env, clientId, refreshToken) =>
  token(env, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
const tools = (env, accessToken) => call(env, '/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18', Authorization: 'Bearer ' + accessToken },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

/** DCR registration, owner consent and PKCE code exchange, the way the Claude app connects. */
async function connect(env) {
  const registered = await call(env, '/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  assert.equal(registered.status, 201);
  const { client_id: clientId } = await registered.json();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'hub:propose', resource: RESOURCE });
  const page = await call(env, '/authorize?' + query);
  const html = await page.text();
  const approved = await call(env, '/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') },
    body: new URLSearchParams({ handle: /name="handle" value="([^"]+)"/.exec(html)[1],
      return_to: /name="return_to" value="([^"]+)"/.exec(html)?.[1] ?? '', decision: 'approve', password: PASSWORD }),
    redirect: 'manual',
  });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get('Location')).searchParams.get('code');
  const exchanged = await token(env, { grant_type: 'authorization_code', code, redirect_uri: CALLBACK,
    client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  return { clientId, tokens: exchanged.body };
}
async function onlyGrantKey(env) {
  const { keys } = await env.OAUTH_KV.list({ prefix: 'grant:' });
  assert.equal(keys.length, 1);
  return keys[0].name;
}
const grantOf = async (env) => env.OAUTH_KV.get(await onlyGrantKey(env), { type: 'json' });
const advance = (t, seconds) => t.mock.timers.setTime(Date.now() + seconds * 1000);
/** Cloudflare KV `expiration`: an integer of seconds since the epoch, at least 60 s in the future. */
function assertKvExpiration(expiration, expected) {
  assert.ok(Number.isInteger(expiration), String(expiration));
  assert.ok(expiration >= nowSeconds() + 60, `${expiration} is not in the future`);
  assert.ok(expiration < 1e11, 'seconds, not milliseconds');
  assert.equal(expiration, expected);
}
function startClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Math.floor(Date.now() / 1000) * 1000 });
}

test('a new grant has no absolute expiry and still refreshes 31 days after consent', async (t) => {
  startClock(t);
  const { env, grantPuts } = makeEnv();
  try {
    const { clientId, tokens } = await connect(env);
    assert.equal(tokens.expires_in, 3600, 'access token lifetime is unchanged');

    const issued = await grantOf(env);
    assert.equal(issued.expiresAt, undefined, 'no absolute grant lifetime');
    const exchangePut = grantPuts.at(-1);
    assert.equal(exchangePut.options.expiration, undefined);
    assert.equal(exchangePut.options.expirationTtl, undefined);

    advance(t, OLD_DEFAULT_TTL + DAY);
    const refreshed = await refresh(env, clientId, tokens.refresh_token);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.expires_in, 3600, 'access token lifetime is unchanged');
    assert.equal((await tools(env, refreshed.body.access_token)).status, 200);

    // The refresh starts the 10-year idle lifetime, and the KV record expires with it.
    const expected = nowSeconds() + IDLE_TTL;
    assert.equal((await grantOf(env)).expiresAt, expected);
    assertKvExpiration(grantPuts.at(-1).options.expiration, expected);

    // Rotating HUB_OWNER_ID still invalidates every token.
    const rotated = await tools({ ...env, HUB_OWNER_ID: 'other-owner' }, refreshed.body.access_token);
    assert.equal(rotated.status, 403);
  } finally { env.DB.close(); }
});

test('an existing grant with the old 30-day expiry is extended to now + 10 years by its next refresh', async (t) => {
  startClock(t);
  const { env, grantPuts } = makeEnv();
  try {
    const { clientId, tokens } = await connect(env);
    // Reproduce a grant issued under the library default: expiresAt = consent + 30 days, KV expiring with it.
    const consentedAt = nowSeconds();
    const key = await onlyGrantKey(env);
    const legacy = { ...(await env.OAUTH_KV.get(key, { type: 'json' })), expiresAt: consentedAt + OLD_DEFAULT_TTL };
    await env.OAUTH_KV.put(key, JSON.stringify(legacy), { expiration: legacy.expiresAt });

    advance(t, OLD_DEFAULT_TTL - DAY); // one day before it would have lapsed
    const refreshed = await refresh(env, clientId, tokens.refresh_token);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.expires_in, 3600);
    const expected = nowSeconds() + IDLE_TTL;
    assert.equal((await grantOf(env)).expiresAt, expected);
    assertKvExpiration(grantPuts.at(-1).options.expiration, expected);

    // Past the old 30-day date the connection carries on without reconnecting.
    advance(t, 2 * DAY);
    const later = await refresh(env, clientId, refreshed.body.refresh_token);
    assert.equal(later.status, 200, JSON.stringify(later.body));
    assert.equal((await tools(env, later.body.access_token)).status, 200);
  } finally { env.DB.close(); }
});

test('an old 30-day grant that already lapsed fails with invalid_grant (that app reconnects once)', async (t) => {
  startClock(t);
  const { env } = makeEnv();
  try {
    const { clientId, tokens } = await connect(env);
    const key = await onlyGrantKey(env);
    const legacy = { ...(await env.OAUTH_KV.get(key, { type: 'json' })), expiresAt: nowSeconds() + OLD_DEFAULT_TTL };
    await env.OAUTH_KV.put(key, JSON.stringify(legacy), { expiration: legacy.expiresAt });

    advance(t, OLD_DEFAULT_TTL + DAY);
    const lapsed = await refresh(env, clientId, tokens.refresh_token);
    assert.equal(lapsed.status, 400);
    assert.equal(lapsed.body.error, 'invalid_grant');
  } finally { env.DB.close(); }
});

test('each refresh rotates the refresh token with a one-step grace for the previous one', async (t) => {
  startClock(t);
  const { env } = makeEnv();
  try {
    const { clientId, tokens } = await connect(env);
    const first = tokens.refresh_token;
    const a = await refresh(env, clientId, first);
    assert.equal(a.status, 200);
    assert.notEqual(a.body.refresh_token, first);

    // A lost response: the previous token works once more and yields yet another new token.
    const retry = await refresh(env, clientId, first);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.notEqual(retry.body.refresh_token, a.body.refresh_token);
    assert.notEqual(retry.body.refresh_token, first);

    // Moving on past it ends the grace: two refreshes back is no longer accepted.
    const b = await refresh(env, clientId, retry.body.refresh_token);
    assert.equal(b.status, 200);
    const stale = await refresh(env, clientId, first);
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, 'invalid_grant');
  } finally { env.DB.close(); }
});

test('revoking the refresh token on the token endpoint ends the grant despite the long lifetime', async (t) => {
  startClock(t);
  const { env } = makeEnv();
  try {
    const { clientId, tokens } = await connect(env);
    const refreshed = await refresh(env, clientId, tokens.refresh_token);
    assert.equal(refreshed.status, 200);

    const revoked = await call(env, '/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshed.body.refresh_token, token_type_hint: 'refresh_token', client_id: clientId }),
    });
    assert.equal(revoked.status, 200);
    assert.equal(await revoked.text(), '');

    for (const stale of [refreshed.body.refresh_token, tokens.refresh_token]) {
      const after = await refresh(env, clientId, stale);
      assert.equal(after.status, 400);
      assert.equal(after.body.error, 'invalid_grant');
    }
    assert.equal((await tools(env, refreshed.body.access_token)).status, 401);
    assert.equal((await env.OAUTH_KV.list({ prefix: 'grant:' })).keys.length, 0);
  } finally { env.DB.close(); }
});

test('a new DCR registration never expires, so a grant refreshed a year later still works', async (t) => {
  startClock(t);
  const { env, clientPuts } = makeEnv();
  try {
    const { clientId, tokens } = await connect(env);
    const registration = clientPuts.find((p) => p.key === 'client:' + clientId);
    assert.ok(registration);
    assert.equal(registration.options.expiration, undefined);
    assert.equal(registration.options.expirationTtl, undefined);
    assert.equal((await env.OAUTH_KV.get('client:' + clientId, { type: 'json' })).registrationExpiresAt, undefined);

    advance(t, 400 * DAY); // well past the old 90-day registration default
    assert.ok(await env.OAUTH_KV.get('client:' + clientId), 'registration still stored');
    const refreshed = await refresh(env, clientId, tokens.refresh_token);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.expires_in, 3600);
  } finally { env.DB.close(); }
});

test('a DCR registration made under the old 90-day default keeps its expiry; that client reconnects once', async (t) => {
  startClock(t);
  const { env, clientPuts } = makeEnv();
  try {
    const { clientId, tokens } = await connect(env);
    // Reproduce a record written under the library default: stamped, and expiring in KV 90 days after registration.
    const key = 'client:' + clientId;
    const legacy = { ...(await env.OAUTH_KV.get(key, { type: 'json' })), registrationExpiresAt: nowSeconds() + 90 * DAY };
    await env.OAUTH_KV.put(key, JSON.stringify(legacy), { expirationTtl: 90 * DAY });
    const writes = clientPuts.length;

    // Past half its lifetime: the refresh works, but the library no longer renews the registration.
    advance(t, 50 * DAY);
    const refreshed = await refresh(env, clientId, tokens.refresh_token);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(clientPuts.length, writes, 'registration not rewritten');

    advance(t, 41 * DAY);
    const lapsed = await refresh(env, clientId, refreshed.body.refresh_token);
    assert.notEqual(lapsed.status, 200);
    assert.equal(lapsed.body.error, 'invalid_client', JSON.stringify(lapsed.body));

    // A fresh connection registers without expiry.
    const again = await connect(env);
    const fresh = clientPuts.find((p) => p.key === 'client:' + again.clientId);
    assert.equal(fresh.options.expirationTtl, undefined);
    assert.equal(fresh.options.expiration, undefined);
  } finally { env.DB.close(); }
});
