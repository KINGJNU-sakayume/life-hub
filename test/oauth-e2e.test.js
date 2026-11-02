/**
 * End-to-end OAuth + MCP flow through the real @cloudflare/workers-oauth-provider, the way the Claude app
 * connects: discovery → dynamic registration → owner password consent → PKCE code exchange → MCP → refresh.
 * Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestKV } from '../scripts/node-test/d1.mjs';
import worker from '../src/server/index.js';

const ORIGIN = 'https://hub.example';
const RESOURCE = ORIGIN + '/mcp';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'synthetic-owner-password-' + 'p'.repeat(24);
const OWNER_TOKEN = 'owner_' + 'A'.repeat(48);

function makeEnv() {
  return {
    DB: new TestD1(), OAUTH_KV: new TestKV(), HUB_PUBLIC_ORIGIN: ORIGIN,
    HUB_OWNER_ID: 'demo-owner', HUB_OWNER_PASSWORD: PASSWORD, HUB_OWNER_TOKEN: OWNER_TOKEN,
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
async function register(env, redirectUris = [CALLBACK]) {
  return call(env, '/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
}
function cookiesFrom(response) {
  return response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
async function openConsent(env, clientId, challenge, state = 'state-123') {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK,
    code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'hub:propose', resource: RESOURCE });
  const response = await call(env, '/authorize?' + query);
  const html = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  const returnTo = /name="return_to" value="([^"]+)"/.exec(html)?.[1];
  return { response, html, handle, returnTo, cookie: cookiesFrom(response) };
}
function submit(env, page, fields) {
  return call(env, '/authorize', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: page.cookie },
    body: new URLSearchParams({ handle: page.handle, return_to: page.returnTo ?? '', ...fields }), redirect: 'manual',
  });
}
async function token(env, params) {
  const response = await call(env, '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  return { status: response.status, body: await response.json() };
}
function mcp(env, accessToken, body) {
  return call(env, '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18', ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) },
    body: JSON.stringify(body),
  });
}

test('discovery: 401 challenge points to metadata naming this resource and issuer', async () => {
  const env = makeEnv();
  try {
    const challenge = await mcp(env, null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get('WWW-Authenticate'), /resource_metadata="https:\/\/hub\.example\/\.well-known\/oauth-protected-resource\/mcp"/);

    const prm = await (await call(env, '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(prm.resource, RESOURCE);
    assert.deepEqual(prm.authorization_servers, [ORIGIN]);
    assert.deepEqual(prm.scopes_supported, ['hub:propose']);

    const asm = await (await call(env, '/.well-known/oauth-authorization-server')).json();
    assert.equal(asm.issuer, ORIGIN);
    assert.equal(asm.registration_endpoint, ORIGIN + '/oauth/register');
    assert.ok(asm.code_challenge_methods_supported.includes('S256'));
    assert.ok(asm.token_endpoint_auth_methods_supported.includes('none'));
  } finally { env.DB.close(); }
});

test('registration refuses clients that cannot use the Claude callback', async () => {
  const env = makeEnv();
  try {
    const bad = await register(env, ['https://evil.example/callback']);
    assert.equal(bad.status, 400);
    const good = await register(env);
    assert.equal(good.status, 201);
    assert.ok((await good.json()).client_id);
  } finally { env.DB.close(); }
});

test('full connect: wrong password, then approve, exchange, call a tool, refresh', async () => {
  const env = makeEnv();
  try {
    const { client_id: clientId } = await (await register(env)).json();
    const { verifier, challenge } = await pkce();

    const page = await openConsent(env, clientId, challenge);
    assert.equal(page.response.status, 200);
    assert.match(page.response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    // Browsers enforce form-action on the redirect after the POST: Claude's origin must be allowed.
    assert.match(page.response.headers.get('Content-Security-Policy'), /form-action 'self' https:\/\/claude\.ai(;|$)/);
    assert.match(page.html, /claude\.ai/);
    assert.ok(page.handle && page.cookie);

    const wrong = await submit(env, page, { decision: 'approve', password: 'not-the-password' });
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /href="\/authorize\?/);

    // The handle was not consumed by the failed attempt.
    const approved = await submit(env, page, { decision: 'approve', password: PASSWORD });
    assert.equal(approved.status, 302);
    const location = new URL(approved.headers.get('Location'));
    assert.equal(location.origin + location.pathname, CALLBACK);
    assert.equal(location.searchParams.get('state'), 'state-123');
    assert.equal(location.searchParams.get('iss'), ORIGIN);
    const code = location.searchParams.get('code');
    assert.ok(code);

    const badVerifier = await token(env, { grant_type: 'authorization_code', code, redirect_uri: CALLBACK,
      client_id: clientId, code_verifier: 'x'.repeat(50), resource: RESOURCE });
    assert.equal(badVerifier.status, 400);

    // A fresh authorization, since a failed exchange may invalidate the code.
    const page2 = await openConsent(env, clientId, challenge, 'state-456');
    const approved2 = await submit(env, page2, { decision: 'approve', password: PASSWORD });
    const code2 = new URL(approved2.headers.get('Location')).searchParams.get('code');
    const exchanged = await token(env, { grant_type: 'authorization_code', code: code2, redirect_uri: CALLBACK,
      client_id: clientId, code_verifier: verifier, resource: RESOURCE });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    assert.equal(exchanged.body.scope, 'hub:propose');
    assert.ok(exchanged.body.access_token && exchanged.body.refresh_token);

    const listed = await (await mcp(env, exchanged.body.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    assert.equal(listed.result.tools.length, 6);

    const proposed = await (await mcp(env, exchanged.body.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'propose_food_meal', arguments: { menu_name: 'Synthetic soup', eaten_on: '2026-11-01' } } })).json();
    assert.equal(proposed.result.structuredContent.status, 'pending');
    const row = await env.DB.prepare('SELECT source, owner_id, status FROM inbox').bind().first();
    assert.deepEqual({ ...row }, { source: 'claude', owner_id: 'demo-owner', status: 'pending' });

    // The P1 owner API sees the proposal; the MCP token is not accepted there.
    const v1 = await call(env, '/v1/candidates?status=pending', { headers: { Authorization: 'Bearer ' + OWNER_TOKEN } });
    assert.equal(v1.status, 200);
    assert.equal((await v1.json()).candidates.length, 1);
    const crossUse = await call(env, '/v1/candidates', { headers: { Authorization: 'Bearer ' + exchanged.body.access_token } });
    assert.equal(crossUse.status, 401);

    const refreshed = await token(env, { grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token, client_id: clientId });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.refresh_token, exchanged.body.refresh_token);
    const afterRefresh = await mcp(env, refreshed.body.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(afterRefresh.status, 200);

    // Rotating the owner ID invalidates previously issued connector tokens.
    const rotated = await mcp({ ...env, HUB_OWNER_ID: 'other-owner' }, refreshed.body.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    assert.equal(rotated.status, 403);
  } finally { env.DB.close(); }
});

test('deny returns access_denied to Claude without issuing a code', async () => {
  const env = makeEnv();
  try {
    const { client_id: clientId } = await (await register(env)).json();
    const page = await openConsent(env, clientId, (await pkce()).challenge);
    const denied = await submit(env, page, { decision: 'deny' });
    assert.equal(denied.status, 302);
    const location = new URL(denied.headers.get('Location'));
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('code'), null);
  } finally { env.DB.close(); }
});

test('without OAuth configuration, OAuth routes fail closed and the P1 API still works', async () => {
  const env = makeEnv();
  try {
    for (const patch of [{ HUB_PUBLIC_ORIGIN: undefined }, { OAUTH_KV: undefined }, { HUB_PUBLIC_ORIGIN: 'http://hub.example' }]) {
      const e = { ...env, ...patch };
      assert.equal((await call(e, '/mcp', { method: 'POST' })).status, 503);
      assert.equal((await call(e, '/authorize')).status, 503);
      assert.equal((await call(e, '/health')).status, 200);
    }
    // Configured, but no owner password: the authorize page refuses to run.
    const page = await call({ ...env, HUB_OWNER_PASSWORD: undefined }, '/authorize?client_id=x');
    assert.equal(page.status, 503);
  } finally { env.DB.close(); }
});
