/**
 * 켜켜이 ↔ Life Hub end to end through the real OAuth library, next to PALATE: each app is its own
 * CIMD client with its own resource; neither can read or answer the other's candidates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestKV } from '../scripts/node-test/d1.mjs';
import { insertCandidate } from '../src/server/store.js';

globalThis.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
const APPS = {
  kyeokyeoi: { url: 'https://owner.github.io/kyeokyeoi/', name: '켜켜이', scope: 'kyeokyeoi:inbox', path: '/kyeokyeoi' },
  palate: { url: 'https://owner.github.io/food/', name: 'PALATE', scope: 'food:inbox', path: '/palate' },
  potcast: { url: 'https://owner.github.io/potcast/lifehub/', name: 'potcast', scope: 'potcast:inbox', path: '/potcast' },
  achievement: { url: 'https://owner.github.io/achievement/lifehub/', name: '업적 라이브러리', scope: 'achievement:inbox', path: '/achievement' },
};
const clientId = (app) => app.url.replace(/lifehub\/$/, '') + 'lifehub-client.json';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const app = Object.values(APPS).find((a) => clientId(a) === url);
  if (app) return new Response(JSON.stringify({ client_id: url, client_name: app.name, client_uri: app.url, redirect_uris: [app.url],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    { headers: { 'Content-Type': 'application/json' } });
  return realFetch(input, init);
};
const { default: worker } = await import('../src/server/index.js');

const ORIGIN = 'https://hub.example';
const PASSWORD = 'synthetic-owner-password-' + 'k'.repeat(24);
const makeEnv = (patch = {}) => ({
  DB: new TestD1(), OAUTH_KV: new TestKV(), HUB_PUBLIC_ORIGIN: ORIGIN,
  HUB_PALATE_REDIRECT_URI: APPS.palate.url, HUB_KYEOKYEOI_REDIRECT_URI: APPS.kyeokyeoi.url, HUB_POTCAST_REDIRECT_URI: APPS.potcast.url,
  HUB_ACHIEVEMENT_REDIRECT_URI: APPS.achievement.url,
  HUB_OWNER_ID: 'demo-owner', HUB_OWNER_PASSWORD: PASSWORD, HUB_OWNER_TOKEN: 'owner_' + 'A'.repeat(48), ...patch,
});
const call = (env, path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, { waitUntil() {}, passThroughOnException() {}, props: {} });
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

async function connect(env, app, resource = ORIGIN + app.path) {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId(app), redirect_uri: app.url, code_challenge: challenge,
    code_challenge_method: 'S256', state: 's', scope: app.scope, resource });
  const page = await call(env, '/authorize?' + q);
  const html = await page.text();
  if (page.status !== 200) return { status: page.status, html };
  const handle = /name="handle" value="([^"]+)"/.exec(html)[1];
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const approved = await call(env, '/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ handle, decision: 'approve', password: PASSWORD }) });
  const location = new URL(approved.headers.get('Location'));
  const formAction = /form-action ([^;]+)/.exec(page.headers.get('Content-Security-Policy'))[1].split(' ');
  assert.ok(formAction.includes(location.origin));
  const token = await (await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: app.url,
      client_id: clientId(app), code_verifier: verifier, resource }) })).json();
  return { status: 200, html, token };
}
const api = (env, token, path, method = 'GET', body) => call(env, path, { method,
  headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

async function seed(env) {
  const at = '2026-11-02T01:00:00Z';
  const base = { hub_version: 1, source: 'claude', source_ref: 'claude-mcp:2026-11-02', created_at: at };
  await insertCandidate(env.DB, 'demo-owner', { ...base, destination: 'kyeokyeoi', idempotency_key: 'mcp-' + 'm'.repeat(40),
    candidate_type: 'memory', payload: { title: '가상의 바다', time_text: '고2 여름', place_text: '가상시' } }, at);
  await insertCandidate(env.DB, 'demo-owner', { ...base, destination: 'kyeokyeoi', idempotency_key: 'mcp-' + 'v'.repeat(40),
    candidate_type: 'visit', payload: { place_text: '가상군', visited_on: '2026-10-01' } }, at);
  await insertCandidate(env.DB, 'demo-owner', { ...base, destination: 'food', idempotency_key: 'mcp-' + 'f'.repeat(40),
    candidate_type: 'meal', payload: { menu_name: 'Synthetic noodles' } }, at);
}

test('켜켜이 connects as its own client and sees only its candidates, in its own shape', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const prm = await (await call(env, '/.well-known/oauth-protected-resource/kyeokyeoi')).json();
    assert.equal(prm.resource, ORIGIN + '/kyeokyeoi');
    const { html, token } = await connect(env, APPS.kyeokyeoi);
    assert.match(html, /켜켜이/);
    assert.match(html, /kyeokyeoi:inbox/);
    assert.equal(token.scope, 'kyeokyeoi:inbox');

    const { candidates } = await (await api(env, token.access_token, '/kyeokyeoi/v1/candidates')).json();
    assert.deepEqual(candidates.map((c) => c.candidate.candidate_type).sort(), ['memory', 'visit']);
    assert.ok(candidates.every((c) => c.candidate.schema_version === 1 && c.key.startsWith('claude:')));

    const palate = await connect(env, APPS.palate);
    const food = await (await api(env, palate.token.access_token, '/palate/v1/candidates')).json();
    assert.deepEqual(food.candidates.map((c) => c.candidate.candidate_type), ['meal']);
  } finally { env.DB.close(); }
});

test('receipts use 켜켜이 entity types; tokens cannot cross apps', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const { token } = await connect(env, APPS.kyeokyeoi);
    const t = token.access_token;
    const memoryKey = 'claude:mcp-' + 'm'.repeat(40);
    const visitKey = 'claude:mcp-' + 'v'.repeat(40);
    assert.equal((await api(env, t, '/kyeokyeoi/v1/receipts', 'POST', { key: memoryKey, entity_type: 'meal', entity_id: 'm1' })).status, 400);
    assert.equal((await api(env, t, '/kyeokyeoi/v1/receipts', 'POST', { key: memoryKey, entity_type: 'visit', entity_id: 'm1' })).status, 409);
    assert.equal((await api(env, t, '/kyeokyeoi/v1/receipts', 'POST', { key: memoryKey, entity_type: 'memory', entity_id: crypto.randomUUID() })).status, 200);
    assert.equal((await api(env, t, '/kyeokyeoi/v1/rejections', 'POST', { key: visitKey })).status, 200);
    // A food key does not exist for 켜켜이.
    assert.equal((await api(env, t, '/kyeokyeoi/v1/rejections', 'POST', { key: 'claude:mcp-' + 'f'.repeat(40) })).status, 404);
    // 켜켜이's token is not valid at PALATE's resource or the MCP endpoint, and vice versa.
    assert.equal((await api(env, t, '/palate/v1/candidates')).status, 401);
    assert.equal((await call(env, '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).status, 401);
    const palate = await connect(env, APPS.palate);
    assert.equal((await api(env, palate.token.access_token, '/kyeokyeoi/v1/candidates')).status, 401);
    // 켜켜이 cannot ask for PALATE's resource.
    assert.equal((await connect(env, APPS.kyeokyeoi, ORIGIN + '/palate')).status, 403);
  } finally { env.DB.close(); }
});

test('without HUB_KYEOKYEOI_REDIRECT_URI the 켜켜이 profile and API are off', async () => {
  const env = makeEnv({ HUB_KYEOKYEOI_REDIRECT_URI: '' });
  try {
    assert.equal((await call(env, '/kyeokyeoi/v1/candidates')).status, 503);
    assert.equal((await connect(env, APPS.kyeokyeoi)).status, 403);
  } finally { env.DB.close(); }
});

test('potcast connects via its callback page and receives album_listening candidates only', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const at = '2026-11-02T01:00:00Z';
    await insertCandidate(env.DB, 'demo-owner', { hub_version: 1, source: 'claude', source_ref: 'claude-mcp:2026-11-02', created_at: at,
      destination: 'potcast', idempotency_key: 'mcp-' + 'q'.repeat(40), candidate_type: 'album_listening',
      payload: { artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'conversation', whole_album: true } }, at);
    const { html, token } = await connect(env, APPS.potcast);
    assert.match(html, /potcast:inbox/);
    const { candidates } = await (await api(env, token.access_token, '/potcast/v1/candidates')).json();
    assert.deepEqual(candidates.map((c) => c.candidate.candidate_type), ['album_listening']);
    const key = candidates[0].key;
    assert.equal((await api(env, token.access_token, '/potcast/v1/receipts', 'POST', { key, entity_type: 'memory', entity_id: 'x' })).status, 400);
    assert.equal((await api(env, token.access_token, '/potcast/v1/receipts', 'POST', { key, entity_type: 'album_listening', entity_id: 'A'.repeat(22) })).status, 200);
    assert.equal((await api(env, token.access_token, '/kyeokyeoi/v1/candidates')).status, 401);
  } finally { env.DB.close(); }
});

test('업적 라이브러리 connects via its callback page and receives activity_record candidates only', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const at = '2026-11-02T01:00:00Z';
    await insertCandidate(env.DB, 'demo-owner', { hub_version: 1, source: 'claude', source_ref: 'claude-mcp:2026-11-02', created_at: at,
      destination: 'achievement', idempotency_key: 'mcp-' + 'r'.repeat(40), candidate_type: 'activity_record',
      payload: { category: '러닝', date: '2026-11-02', value: 5, unit: 'km' } }, at);
    const prm = await (await call(env, '/.well-known/oauth-protected-resource/achievement')).json();
    assert.equal(prm.resource, ORIGIN + '/achievement');
    const { html, token } = await connect(env, APPS.achievement);
    assert.match(html, /achievement:inbox/);
    const t = token.access_token;
    const { candidates } = await (await api(env, t, '/achievement/v1/candidates')).json();
    assert.deepEqual(candidates.map((c) => c.candidate.candidate_type), ['activity_record']);
    const key = candidates[0].key;
    assert.equal((await api(env, t, '/achievement/v1/receipts', 'POST', { key, entity_type: 'album_listening', entity_id: 'x' })).status, 400);
    assert.equal((await api(env, t, '/achievement/v1/receipts', 'POST', { key, entity_type: 'activity_record', entity_id: 'lh_rec_1' })).status, 200);
    assert.equal((await api(env, t, '/potcast/v1/candidates')).status, 401);
    // Off without its redirect variable.
    const off = makeEnv({ HUB_ACHIEVEMENT_REDIRECT_URI: '' });
    try { assert.equal((await call(off, '/achievement/v1/candidates')).status, 503); } finally { off.DB.close(); }
  } finally { env.DB.close(); }
});
