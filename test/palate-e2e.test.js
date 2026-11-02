/**
 * PALATE ↔ Life Hub, end to end through the real OAuth library: PALATE identifies itself with a
 * Client ID Metadata Document, the owner signs in, PALATE reads pending food candidates and sends
 * back receipts and rejections. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestKV } from '../scripts/node-test/d1.mjs';
import { insertCandidate } from '../src/server/store.js';

// CIMD is only enabled with this compatibility flag; the Workers runtime exposes it on `Cloudflare`.
globalThis.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
const PALATE_APP = 'https://owner.github.io/food/';
const CLIENT_ID = 'https://owner.github.io/food/lifehub-client.json';
const CLIENT_DOC = {
  client_id: CLIENT_ID, client_name: 'PALATE', client_uri: PALATE_APP, redirect_uris: [PALATE_APP],
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  token_endpoint_auth_method: 'none', application_type: 'web',
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === CLIENT_ID) return new Response(JSON.stringify(CLIENT_DOC), { headers: { 'Content-Type': 'application/json' } });
  return realFetch(input, init);
};
const { default: worker } = await import('../src/server/index.js');

const ORIGIN = 'https://hub.example';
const PALATE_ORIGIN = 'https://owner.github.io';
const PASSWORD = 'synthetic-owner-password-' + 'q'.repeat(24);

function makeEnv(patch = {}) {
  return {
    DB: new TestD1(), OAUTH_KV: new TestKV(), HUB_PUBLIC_ORIGIN: ORIGIN, HUB_PALATE_REDIRECT_URI: PALATE_APP,
    HUB_OWNER_ID: 'demo-owner', HUB_OWNER_PASSWORD: PASSWORD, HUB_OWNER_TOKEN: 'owner_' + 'A'.repeat(48), ...patch,
  };
}
const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} });
const call = (env, path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, ctx());
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
async function authorizePage(env, { clientId = CLIENT_ID, redirectUri = PALATE_APP, resource = ORIGIN + '/palate', scope = 'food:inbox', challenge }) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's1', scope, resource });
  const response = await call(env, '/authorize?' + q);
  const html = await response.text();
  return { response, html, handle: /name="handle" value="([^"]+)"/.exec(html)?.[1],
    cookie: response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}
async function connectPalate(env) {
  const { verifier, challenge } = await pkce();
  const page = await authorizePage(env, { challenge });
  assert.equal(page.response.status, 200, page.html);
  const approved = await call(env, '/authorize', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: page.cookie },
    body: new URLSearchParams({ handle: page.handle, decision: 'approve', password: PASSWORD }),
  });
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get('Location'));
  assert.equal(location.origin + location.pathname, PALATE_APP);
  // Browsers enforce form-action on the redirect after the POST: the consent page must allow it.
  const formAction = /form-action ([^;]+)/.exec(page.response.headers.get('Content-Security-Policy'))[1].split(' ');
  assert.ok(formAction.includes(location.origin), formAction.join(' '));
  assert.ok(!formAction.includes('https://claude.ai'));
  const tokenResponse = await call(env, '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PALATE_ORIGIN },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'),
      redirect_uri: PALATE_APP, client_id: CLIENT_ID, code_verifier: verifier, resource: ORIGIN + '/palate' }),
  });
  assert.equal(tokenResponse.headers.get('Access-Control-Allow-Origin'), PALATE_ORIGIN);
  const body = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify(body));
  return { page, token: body };
}
const api = (env, token, method, path, body) => call(env, '/palate/v1' + path, {
  method, headers: { Authorization: 'Bearer ' + token, Origin: PALATE_ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function seed(env) {
  const at = '2026-11-02T01:00:00Z';
  const meal = await insertCandidate(env.DB, 'demo-owner', { hub_version: 1, destination: 'food', source: 'claude',
    source_ref: 'claude-mcp:2026-11-02', idempotency_key: 'mcp-' + 'a'.repeat(40), created_at: at, candidate_type: 'meal',
    payload: { menu_name: 'Synthetic cup noodles', eaten_at: '2026-11-02', note: 'brunch' } }, at);
  const wish = await insertCandidate(env.DB, 'demo-owner', { hub_version: 1, destination: 'food', source: 'manual',
    source_ref: 'manual:t', idempotency_key: 'manual-wish-0001', created_at: at, candidate_type: 'wish',
    payload: { wish_kind: 'try_menu', name: 'Imaginary pasta' } }, at);
  return { meal, wish, mealKey: 'claude:mcp-' + 'a'.repeat(40), wishKey: 'manual:manual-wish-0001' };
}

test('PALATE connects with its metadata document and reads pending candidates in its own format', async () => {
  const env = makeEnv();
  try {
    const asm = await (await call(env, '/.well-known/oauth-authorization-server')).json();
    assert.equal(asm.client_id_metadata_document_supported, true);
    const prm = await (await call(env, '/.well-known/oauth-protected-resource/palate')).json();
    assert.equal(prm.resource, ORIGIN + '/palate');
    assert.deepEqual(prm.scopes_supported, ['food:inbox']);

    await seed(env);
    const { page, token } = await connectPalate(env);
    assert.match(page.html, /PALATE/);
    assert.match(page.html, /owner\.github\.io/);
    assert.match(page.html, /food:inbox/);
    assert.equal(token.scope, 'food:inbox');

    const preflight = await call(env, '/palate/v1/receipts', { method: 'OPTIONS', headers: {
      Origin: PALATE_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), PALATE_ORIGIN);

    const listed = await api(env, token.access_token, 'GET', '/candidates');
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('Access-Control-Allow-Origin'), PALATE_ORIGIN);
    const { candidates } = await listed.json();
    assert.equal(candidates.length, 2);
    const meal = candidates.find((c) => c.key.startsWith('claude:'));
    assert.equal(meal.status, 'pending');
    assert.deepEqual(Object.keys(meal.candidate).sort(),
      ['candidate_type', 'created_at', 'idempotency_key', 'payload', 'schema_version', 'source', 'source_ref']);
    assert.equal(meal.candidate.schema_version, 1);
  } finally { env.DB.close(); }
});

test('receipts and rejections are idempotent and conflicts are refused', async () => {
  const env = makeEnv();
  try {
    const { mealKey, wishKey } = await seed(env);
    const { token } = await connectPalate(env);
    const t = token.access_token;
    const entity = crypto.randomUUID();

    assert.equal((await api(env, t, 'POST', '/receipts', { key: mealKey, entity_type: 'wish', entity_id: entity })).status, 409);
    const first = await api(env, t, 'POST', '/receipts', { key: mealKey, entity_type: 'meal', entity_id: entity });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).candidate.confirmed_entity_id, entity);
    assert.equal((await api(env, t, 'POST', '/receipts', { key: mealKey, entity_type: 'meal', entity_id: entity })).status, 200);
    assert.equal((await api(env, t, 'POST', '/receipts', { key: mealKey, entity_type: 'meal', entity_id: crypto.randomUUID() })).status, 409);
    assert.equal((await api(env, t, 'POST', '/rejections', { key: mealKey })).status, 409);

    assert.equal((await api(env, t, 'POST', '/rejections', { key: wishKey })).status, 200);
    assert.equal((await api(env, t, 'POST', '/rejections', { key: wishKey })).status, 200);
    assert.equal((await api(env, t, 'POST', '/receipts', { key: wishKey, entity_type: 'wish', entity_id: entity })).status, 409);

    const row = await env.DB.prepare('SELECT status, confirmed_entity_id FROM inbox WHERE source=?').bind('claude').first();
    assert.deepEqual({ ...row }, { status: 'confirmed', confirmed_entity_id: entity });
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox_changes WHERE change_type='status'").bind().first();
    assert.equal(events.n, 2);

    const pending = await (await api(env, t, 'GET', '/candidates')).json();
    assert.equal(pending.candidates.length, 0);
    const all = await (await api(env, t, 'GET', '/candidates?status=all')).json();
    assert.equal(all.candidates.length, 2);

    for (const body of [{ key: 'nope' }, { key: 'claude:short' }, { key: 'evil:mcp-' + 'a'.repeat(40) }, { key: mealKey, extra: 1 }])
      assert.equal((await api(env, t, 'POST', '/rejections', body)).status, 400, JSON.stringify(body));
    assert.equal((await api(env, t, 'POST', '/receipts', { key: mealKey, entity_type: 'meal', entity_id: 'has space' })).status, 400);
    assert.equal((await api(env, t, 'POST', '/rejections', { key: 'manual:does-not-exist' })).status, 404);
    assert.equal((await api(env, t, 'GET', '/candidates?limit=0')).status, 400);
  } finally { env.DB.close(); }
});

test('tokens and profiles cannot cross resources', async () => {
  const env = makeEnv();
  try {
    const { token } = await connectPalate(env);
    // A PALATE token is not accepted by the MCP endpoint (different audience).
    const onMcp = await call(env, '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token.access_token,
      'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(onMcp.status, 401);
    // PALATE may not ask for the MCP resource, and the Claude callback may not ask for PALATE's.
    const { challenge } = await pkce();
    const wrongResource = await authorizePage(env, { resource: ORIGIN + '/mcp', challenge });
    assert.equal(wrongResource.response.status, 403);
    const reg = await call(env, '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }) });
    const { client_id: claudeId } = await reg.json();
    const claudeForPalate = await authorizePage(env, { clientId: claudeId, redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      resource: ORIGIN + '/palate', scope: 'food:propose', challenge });
    assert.equal(claudeForPalate.response.status, 403);
    // DCR cannot register a client for PALATE's redirect URI.
    const fake = await call(env, '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'PALATE', redirect_uris: [PALATE_APP], token_endpoint_auth_method: 'none' }) });
    assert.equal(fake.status, 400);
  } finally { env.DB.close(); }
});

test('without HUB_PALATE_REDIRECT_URI the PALATE profile and API are off', async () => {
  const env = makeEnv({ HUB_PALATE_REDIRECT_URI: '' });
  try {
    assert.equal((await call(env, '/palate/v1/candidates')).status, 503);
    const page = await authorizePage(env, { challenge: (await pkce()).challenge });
    assert.equal(page.response.status, 403);
    assert.doesNotMatch(page.html, /PALATE/);
  } finally { env.DB.close(); }
});

test('handlers refuse tokens whose role or owner do not match (defence in depth)', async () => {
  const { mcpHandler, palateHandler } = await import('../src/server/index.js');
  const env = makeEnv();
  try {
    const req = (path) => new Request(ORIGIN + path, { method: 'GET' });
    const ctxWith = (props, scope) => ({ props, auth: { token: 't', audience: 'x', scope } });
    const owner = 'demo-owner';
    assert.equal((await palateHandler.fetch(req('/palate/v1/candidates'), env, ctxWith({ ownerId: owner, role: 'claude' }, ['food:inbox']))).status, 403);
    assert.equal((await palateHandler.fetch(req('/palate/v1/candidates'), env, ctxWith({ ownerId: 'someone', role: 'palate' }, ['food:inbox']))).status, 403);
    assert.equal((await palateHandler.fetch(req('/palate/v1/candidates'), env, ctxWith({ ownerId: owner, role: 'palate' }, ['food:inbox']))).status, 200);
    assert.equal((await mcpHandler.fetch(req('/mcp'), env, ctxWith({ ownerId: owner, role: 'palate' }, ['food:propose']))).status, 403);
  } finally { env.DB.close(); }
});
