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
  music: { url: 'https://owner.github.io/music/lifehub/', name: 'music', scope: 'music:inbox music:board', path: '/music' },
  // The same app before its rename (old client id, callback, resource and scopes): kept working as an alias.
  potcast: { url: 'https://owner.github.io/potcast/lifehub/', name: 'potcast', scope: 'potcast:inbox', path: '/potcast' },
  achievement: { url: 'https://owner.github.io/achievement/lifehub/', name: '업적 라이브러리', scope: 'achievement:inbox', path: '/achievement' },
  letterbookxd: { url: 'https://owner.github.io/letterbookxd/lifehub/', name: '책장', scope: 'letterbookxd:inbox', path: '/letterbookxd' },
  sub: { url: 'https://owner.github.io/sub/lifehub/', name: '역 도장깨기', scope: 'sub:inbox', path: '/sub' },
  animan: { url: 'https://owner.github.io/animan/lifehub/', name: 'AniMan', scope: 'animan:inbox', path: '/animan' },
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
  HUB_PALATE_REDIRECT_URI: APPS.palate.url, HUB_KYEOKYEOI_REDIRECT_URI: APPS.kyeokyeoi.url,
  HUB_MUSIC_REDIRECT_URI: APPS.music.url, HUB_POTCAST_REDIRECT_URI: APPS.potcast.url,
  HUB_ACHIEVEMENT_REDIRECT_URI: APPS.achievement.url,
  HUB_LETTERBOOKXD_REDIRECT_URI: APPS.letterbookxd.url,
  HUB_SUB_REDIRECT_URI: APPS.sub.url,
  HUB_ANIMAN_REDIRECT_URI: APPS.animan.url,
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
    assert.equal(token.scope, 'kyeokyeoi:inbox kyeokyeoi:board', 'the board-tile scope comes with the app (P7)');

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

test('music connects with its client document (/music/lifehub-client.json) and receives album_listening candidates only', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const at = '2026-11-02T01:00:00Z';
    await insertCandidate(env.DB, 'demo-owner', { hub_version: 1, source: 'claude', source_ref: 'claude-mcp:2026-11-02', created_at: at,
      destination: 'music', idempotency_key: 'mcp-' + 'q'.repeat(40), candidate_type: 'album_listening',
      payload: { artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'conversation', whole_album: true } }, at);
    assert.equal(clientId(APPS.music), 'https://owner.github.io/music/lifehub-client.json');
    const prm = await (await call(env, '/.well-known/oauth-protected-resource/music')).json();
    assert.equal(prm.resource, ORIGIN + '/music');
    const { html, token } = await connect(env, APPS.music);
    assert.match(html, /music:inbox/);
    assert.equal(token.scope, 'music:inbox music:board', 'new grants use the music scopes');
    const t = token.access_token;
    const { candidates } = await (await api(env, t, '/music/v1/candidates')).json();
    assert.deepEqual(candidates.map((c) => c.candidate.candidate_type), ['album_listening']);
    const key = candidates[0].key;
    assert.equal((await api(env, t, '/music/v1/receipts', 'POST', { key, entity_type: 'memory', entity_id: 'x' })).status, 400);
    assert.equal((await api(env, t, '/music/v1/receipts', 'POST', { key, entity_type: 'album_listening', entity_id: 'A'.repeat(22) })).status, 200);
    assert.equal((await api(env, t, '/kyeokyeoi/v1/candidates')).status, 401);
    // Board tiles go to /music/v1/board with music:board.
    const manifest = { version: 1, app: 'music', generated_at: new Date(Date.now() - 60000).toISOString(), tiles: [{ id: 'now', tone: 'type' }] };
    assert.equal((await api(env, t, '/music/v1/board', 'PUT', manifest)).status, 200);
    assert.equal((await env.DB.prepare('SELECT app FROM board_manifests').bind().first()).app, 'music');
  } finally { env.DB.close(); }
});

test('rename alias: /potcast/v1 serves the music handler, and old and new tokens work on both paths', async () => {
  const env = makeEnv();
  try {
    const old = await connect(env, APPS.potcast);
    const fresh = await connect(env, APPS.music);
    const tiles = (app, minutesAgo) => ({ version: 1, app, generated_at: new Date(Date.now() - minutesAgo * 60000).toISOString(), tiles: [{ id: 'now', tone: 'type' }] });
    // The app before its update: old resource and scopes, on its old path, naming itself potcast.
    assert.equal(old.token.scope, 'potcast:inbox potcast:board', 'an old client asking for the old resource gets the old spellings');
    assert.equal((await api(env, old.token.access_token, '/potcast/v1/candidates')).status, 200);
    // The board scope of the old spelling is accepted on both paths.
    const oldBoard = old;
    assert.equal((await api(env, oldBoard.token.access_token, '/potcast/v1/board', 'PUT', tiles('potcast', 10))).status, 200);
    assert.equal((await api(env, oldBoard.token.access_token, '/music/v1/board', 'PUT', tiles('potcast', 9))).status, 200);
    // Stored once, under the new name, whatever path or name it came with.
    assert.deepEqual((await env.DB.prepare('SELECT app FROM board_manifests').bind().all()).results.map((r) => r.app), ['music']);
    // The updated app's music token works on the alias path too (deploy order does not matter).
    assert.equal((await api(env, fresh.token.access_token, '/potcast/v1/candidates')).status, 200);
    assert.equal((await api(env, fresh.token.access_token, '/potcast/v1/board', 'PUT', tiles('music', 8))).status, 200);
    const got = await (await api(env, fresh.token.access_token, '/music/v1/board')).json();
    assert.equal(got.manifest.app, 'music');
    // The old grant refreshes with its old resource and scopes.
    const refreshed = await (await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oldBoard.token.refresh_token, client_id: clientId(APPS.potcast) }) })).json();
    assert.equal(refreshed.scope, 'potcast:inbox potcast:board');
    assert.equal((await api(env, refreshed.access_token, '/music/v1/candidates')).status, 200);
    // Other apps' tokens are not music tokens on either path.
    const palate = await connect(env, APPS.palate);
    for (const path of ['/music/v1/candidates', '/potcast/v1/candidates'])
      assert.equal((await api(env, palate.token.access_token, path)).status, 401, path);
  } finally { env.DB.close(); }
});

test('legacy: potcast (old callback page and resource) connects and receives album_listening candidates only', async () => {
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
    assert.equal((await api(env, t, '/music/v1/candidates')).status, 401);
    // Off without its redirect variable.
    const off = makeEnv({ HUB_ACHIEVEMENT_REDIRECT_URI: '' });
    try { assert.equal((await call(off, '/achievement/v1/candidates')).status, 503); } finally { off.DB.close(); }
  } finally { env.DB.close(); }
});

test('책장 connects as its own client and receives reading_record candidates only', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const at = '2026-11-02T01:00:00Z';
    await insertCandidate(env.DB, 'demo-owner', { hub_version: 1, source: 'claude', source_ref: 'claude-mcp:2026-11-02', created_at: at,
      destination: 'letterbookxd', idempotency_key: 'mcp-' + 'l'.repeat(40), candidate_type: 'reading_record',
      payload: { title: '가상의 책', state: 'completed', rating: 4 } }, at);
    const { html, token } = await connect(env, APPS.letterbookxd);
    assert.match(html, /letterbookxd:inbox/);
    const t = token.access_token;
    const { candidates } = await (await api(env, t, '/letterbookxd/v1/candidates')).json();
    assert.deepEqual(candidates.map((c) => c.candidate.candidate_type), ['reading_record']);
    assert.equal((await api(env, t, '/letterbookxd/v1/receipts', 'POST', { key: candidates[0].key, entity_type: 'reading_record',
      entity_id: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' })).status, 200);
    assert.equal((await api(env, t, '/achievement/v1/candidates')).status, 401);
  } finally { env.DB.close(); }
});

test('역 도장깨기 connects as its own client and receives station_visit candidates only', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const at = '2026-11-02T01:00:00Z';
    await insertCandidate(env.DB, 'demo-owner', { hub_version: 1, source: 'claude', source_ref: 'claude-mcp:2026-11-02', created_at: at,
      destination: 'sub', idempotency_key: 'mcp-' + 'u'.repeat(40), candidate_type: 'station_visit',
      payload: { station: '가상역', date: '2026-11-01' } }, at);
    const { html, token } = await connect(env, APPS.sub);
    assert.match(html, /sub:inbox/);
    const t = token.access_token;
    const { candidates } = await (await api(env, t, '/sub/v1/candidates')).json();
    assert.deepEqual(candidates.map((c) => c.candidate.candidate_type), ['station_visit']);
    assert.equal((await api(env, t, '/sub/v1/receipts', 'POST', { key: candidates[0].key, entity_type: 'station_visit', entity_id: 'st_6rCA7IOB7Jet' })).status, 200);
    assert.equal((await api(env, t, '/letterbookxd/v1/candidates')).status, 401);
  } finally { env.DB.close(); }
});

test('AniMan connects and receives media_progress candidates only', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const at = '2026-11-02T01:00:00Z';
    await insertCandidate(env.DB, 'demo-owner', { hub_version: 1, source: 'claude', source_ref: 'claude-mcp:2026-11-02', created_at: at,
      destination: 'animan', idempotency_key: 'mcp-' + 'n'.repeat(40), candidate_type: 'media_progress',
      payload: { title: '가상 애니', kind: 'episode', up_to: 3 } }, at);
    const { html, token } = await connect(env, APPS.animan);
    assert.match(html, /animan:inbox/);
    const t = token.access_token;
    const { candidates } = await (await api(env, t, '/animan/v1/candidates')).json();
    assert.deepEqual(candidates.map((c) => c.candidate.candidate_type), ['media_progress']);
    assert.equal((await api(env, t, '/animan/v1/receipts', 'POST', { key: candidates[0].key, entity_type: 'media_progress',
      entity_id: '027d9ee6-beb7-4309-abc1-28864f920a8f' })).status, 200);
    assert.equal((await api(env, t, '/sub/v1/candidates')).status, 401);
  } finally { env.DB.close(); }
});
