/**
 * Board API, P7 stage B1 (docs/P7_BOARD.md): the Hub-side manifest checks, upload replay and ordering rules,
 * limits, isolation, no manifest text in errors, the read API with the Hub's own inbox tile, and the OAuth
 * scopes end to end through the real OAuth library. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestKV } from '../scripts/node-test/d1.mjs';
import { checkManifest, BOARD_LIMITS } from '../src/board/checks.js';
import { handleManifestRequest, handleBoardRequest, hubManifest } from '../src/board/api.js';
import { clientProfiles, ALL_SCOPES } from '../src/auth/clients.js';
import { DESTINATIONS } from '../src/destinations.js';
import { checkSyncDocument } from '../src/sync/checks.js';

globalThis.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
const PAGES = 'https://owner.github.io';
const APPS = {
  animan: { page: PAGES + '/animan/lifehub/', name: 'AniMan', resource: '/animan' },
  board: { page: PAGES + '/board/lifehub/', name: 'Life Board', resource: '/board' },
};
const clientIdOf = (app) => APPS[app].page.replace(/lifehub\/$/, 'lifehub-client.json');
const CLIENT_DOCS = Object.fromEntries(Object.keys(APPS).map((app) => [clientIdOf(app), {
  client_id: clientIdOf(app), client_name: APPS[app].name, client_uri: APPS[app].page, redirect_uris: [APPS[app].page],
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'web',
}]));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (CLIENT_DOCS[url]) return new Response(JSON.stringify(CLIENT_DOCS[url]), { headers: { 'Content-Type': 'application/json' } });
  return realFetch(input, init);
};
const { default: worker } = await import('../src/server/index.js');

const NOW = Date.parse('2026-11-05T06:00:00Z');
const SENTINEL = 'SYNTHETIC-BOARD-SENTINEL-9031';
const tile = (id, extra = {}) => ({ id, name: '예시 ' + id, tone: 'type', form: 'line', sizes: ['2x1'], data: { label: '예시', title: '지어낸 값' }, ...extra });
const manifest = (extra = {}) => ({ version: 1, app: 'animan', generated_at: '2026-11-05T05:00:00Z', tiles: [tile('now')], ...extra });

/* ---------- checks ---------- */

test('Hub-side checks: version, app, time, tile count, ids, tones, and no data: anywhere', () => {
  const ok = checkManifest('animan', manifest(), NOW);
  assert.equal(ok.reason, null);
  assert.equal(ok.generatedAt, '2026-11-05T05:00:00.000Z', 'generated_at is normalized for ordering');
  assert.equal(checkManifest('animan', manifest({ generated_at: '2026-11-05T14:00:00+09:00' }), NOW).generatedAt, '2026-11-05T05:00:00.000Z');
  const bad = [
    [null, 'not an object'], [[], 'array'], [manifest({ version: 2 }), 'version'], [manifest({ app: 'letterbookxd' }), 'another app'],
    [manifest({ generated_at: 'yesterday' }), 'time text'], [manifest({ generated_at: '2026-11-05T06:06:00Z' }), 'more than 5 minutes ahead'],
    [manifest({ tiles: {} }), 'tiles object'], [manifest({ tiles: Array.from({ length: 25 }, (_, i) => tile('t' + i)) }), '25 tiles'],
    [manifest({ tiles: [tile('Now')] }), 'upper case id'], [manifest({ tiles: [tile('a'), tile('a')] }), 'duplicate id'],
    [manifest({ tiles: [tile('a', { tone: 'glass' })] }), 'unknown tone'], [manifest({ tiles: ['x'] }), 'tile not an object'],
    [manifest({ tiles: [tile('a', { data: { cover: { src: 'data:image/png;base64,AAAA' } } })] }), 'data: image deep inside'],
    [manifest({ tiles: [tile('a', { data: { label: '  DATA:text/html,x' } })] }), 'data: any case, leading space'],
    [manifest({ extra: { 'data:x': 1 } }), 'data: as a key'],
  ];
  for (const [m, why] of bad) assert.notEqual(checkManifest('animan', m, NOW).reason, null, why);
  assert.equal(checkManifest('animan', manifest({ tiles: Array.from({ length: 24 }, (_, i) => tile('t' + i)) }), NOW).reason, null, '24 tiles pass');
  assert.equal(checkManifest('animan', manifest({ tiles: [tile('a', { data: { label: 'metadata: 3' } })] }), NOW).reason, null, '"data:" inside text is fine');
  assert.equal(checkManifest('animan', manifest({ tiles: [] }), NOW).reason, null, 'an empty tile list is allowed (the app has nothing to show)');
});

/* ---------- upload API on its own ---------- */

const ctxFor = (db, { app = 'animan', owner = 'demo-owner', now = NOW } = {}) => ({ db, ownerId: owner, now: () => now, app, path: `/${app}/v1/board` });
const put = (db, body, opts = {}) => handleManifestRequest(new Request(`https://hub.example/${opts.app ?? 'animan'}/v1/board`, {
  method: 'PUT', headers: { 'Content-Type': opts.type ?? 'application/json', ...(opts.headers ?? {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}), ctxFor(db, opts));
const get = (db, opts = {}) => handleManifestRequest(new Request(`https://hub.example/${opts.app ?? 'animan'}/v1/board`), ctxFor(db, opts));
const del = (db, opts = {}) => handleManifestRequest(new Request(`https://hub.example/${opts.app ?? 'animan'}/v1/board`, { method: 'DELETE' }), ctxFor(db, opts));

test('upload: store, read back, same content, older, newer, delete', async () => {
  const db = new TestD1();
  try {
    assert.equal((await get(db)).status, 404);
    const first = await put(db, manifest());
    assert.equal(first.status, 200);
    const meta = await first.json();
    assert.equal(meta.generated_at, '2026-11-05T05:00:00.000Z');
    assert.equal(meta.received_at, '2026-11-05T06:00:00.000Z');
    assert.equal(meta.sha256.length, 64);
    const back = await (await get(db)).json();
    assert.deepEqual(back.manifest, manifest(), 'the exact manifest comes back');

    const same = await (await put(db, manifest())).json();
    assert.equal(same.unchanged, true, 'a retry of the same body writes nothing');

    const older = await (await put(db, manifest({ generated_at: '2026-11-05T04:00:00Z', tiles: [tile('old')] }))).json();
    assert.equal(older.ignored, true, 'a delayed older upload is ignored');
    assert.equal(older.current.generated_at, '2026-11-05T05:00:00.000Z');
    assert.equal((await put(db, manifest({ tiles: [tile('same-time')] })).then((r) => r.json())).ignored, true, 'same generated_at, different body: not newer');
    assert.deepEqual((await (await get(db)).json()).manifest.tiles.map((t) => t.id), ['now']);

    const newer = await put(db, manifest({ generated_at: '2026-11-05T05:30:00Z', tiles: [tile('next')] }));
    assert.equal(newer.status, 200);
    assert.deepEqual((await (await get(db)).json()).manifest.tiles.map((t) => t.id), ['next']);

    assert.equal((await del(db)).status, 204);
    assert.equal((await del(db)).status, 404);
    assert.equal((await get(db)).status, 404);
  } finally { db.close(); }
});

test('upload: limits, content type, JSON, path, methods, and no manifest text in errors', async () => {
  const db = new TestD1();
  try {
    const big = manifest({ tiles: [tile('a', { data: { label: 'x', title: 'y'.repeat(BOARD_LIMITS.maxBytes) } })] });
    assert.equal((await put(db, big)).status, 413, 'body over 64 KiB');
    assert.equal((await put(db, manifest(), { headers: { 'Content-Length': String(BOARD_LIMITS.maxBytes + 1) } })).status, 413, 'declared length over the cap');
    assert.equal((await put(db, manifest(), { type: 'text/plain' })).status, 415);
    assert.equal((await put(db, '{not json')).status, 400);
    const leak = await put(db, manifest({ app: 'letterbookxd', tiles: [tile('a', { data: { label: SENTINEL } })] }));
    assert.equal(leak.status, 400);
    assert.doesNotMatch(await leak.text(), new RegExp(SENTINEL), 'the error never echoes manifest text');
    const dataUri = await put(db, manifest({ tiles: [tile('a', { data: { cover: { src: 'data:image/png;base64,' + SENTINEL } } })] }));
    assert.equal(dataUri.status, 400);
    assert.match((await dataUri.json()).error, /image addresses/);
    const other = await handleManifestRequest(new Request('https://hub.example/animan/v1/board/x'), ctxFor(db));
    assert.equal(other.status, 404);
    const post = await handleManifestRequest(new Request('https://hub.example/animan/v1/board', { method: 'POST' }), ctxFor(db));
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('Allow'), 'GET, PUT, DELETE');
    assert.equal((await get(db)).status, 404, 'nothing was stored by any refused upload');
  } finally { db.close(); }
});

test('upload: apps and owners are isolated', async () => {
  const db = new TestD1();
  try {
    assert.equal((await put(db, manifest())).status, 200);
    assert.equal((await get(db, { app: 'letterbookxd' })).status, 404, "another app does not see animan's manifest");
    assert.equal((await get(db, { owner: 'someone-else' })).status, 404, 'another owner sees nothing');
    assert.equal((await del(db, { owner: 'someone-else' })).status, 404);
    assert.equal((await get(db)).status, 200, "another owner's delete removed nothing");
  } finally { db.close(); }
});

/* ---------- read API ---------- */

function addCandidate(db, destination, key, status = 'pending') {
  db.sqlite.prepare(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), 'demo-owner', destination, 'claude', key, 'synthetic', '{}', status, '2026-11-05T00:00:00Z');
}
const tiles = (db, owner = 'demo-owner') => handleBoardRequest(new Request('https://hub.example/board/v1/tiles'),
  { db, ownerId: owner, now: () => NOW, appNames: Object.fromEntries(DESTINATIONS.map((d) => [d.id, d.app])) });

test('read: stored manifests plus the Hub inbox tile (counts only)', async () => {
  const db = new TestD1();
  try {
    let body = await (await tiles(db)).json();
    assert.equal(body.generated_at, '2026-11-05T06:00:00.000Z');
    assert.deepEqual(body.manifests.map((m) => m.app), ['hub']);
    assert.equal(body.manifests[0].tiles[0].data.value, 0);
    assert.equal(body.manifests[0].tiles[0].detail, undefined, 'no detail rows when nothing waits');

    await put(db, manifest());
    await put(db, manifest({ app: 'sub', tiles: [tile('station', { tone: 'plate' })] }), { app: 'sub' });
    addCandidate(db, 'animan', 'k1'); addCandidate(db, 'animan', 'k2'); addCandidate(db, 'sub', 'k3');
    addCandidate(db, 'sub', 'k4', 'approved'); addCandidate(db, 'food', 'k5', 'rejected');
    body = await (await tiles(db)).json();
    assert.deepEqual(body.manifests.map((m) => m.app), ['animan', 'sub', 'hub']);
    assert.equal(body.manifests[0].received_at, '2026-11-05T06:00:00.000Z', 'the Hub adds received_at for staleness');
    const inbox = body.manifests[2].tiles[0];
    assert.equal(inbox.data.value, 3, 'only pending candidates count');
    assert.deepEqual(inbox.detail.rows, [{ title: 'AniMan', value: '2건' }, { title: '역 도장깨기', value: '1건' }]);
    assert.doesNotMatch(JSON.stringify(inbox), /synthetic/, 'no candidate content, only counts');

    assert.deepEqual((await (await tiles(db, 'someone-else')).json()).manifests.map((m) => m.app), ['hub'], 'owner isolation');
    const wrong = await handleBoardRequest(new Request('https://hub.example/board/v1/tiles', { method: 'POST' }), { db, ownerId: 'demo-owner', now: () => NOW, appNames: {} });
    assert.equal(wrong.status, 405);
    assert.equal((await handleBoardRequest(new Request('https://hub.example/board/v1/other'), { db, ownerId: 'demo-owner', now: () => NOW, appNames: {} })).status, 404);
  } finally { db.close(); }
});

test('the Hub manifest fits the board tile shape', () => {
  const m = hubManifest([{ destination: 'animan', n: 2 }], { animan: 'AniMan' }, '2026-11-05T06:00:00.000Z');
  assert.equal(checkManifest('hub', m, NOW).reason, null);
  const t = m.tiles[0];
  assert.deepEqual([t.id, t.tone, t.form, t.sizes, t.size], ['inbox', 'type', 'num', ['1x1', '2x1'], '1x1']);
});

/* ---------- registry and profiles ---------- */

test('every app gets <id>:board; Life Board has its own profile only when configured', () => {
  for (const d of DESTINATIONS.filter((x) => !x.boardClient)) assert.ok(ALL_SCOPES.includes(`${d.id}:board`), d.id);
  assert.ok(!ALL_SCOPES.includes('board:board'), 'Life Board uploads no tiles of its own');
  assert.ok(ALL_SCOPES.includes('board:read'));
  assert.deepEqual(clientProfiles({}).map((p) => p.id), ['claude'], 'off without its redirect variable');
  const on = clientProfiles({ HUB_BOARD_REDIRECT_URI: APPS.board.page });
  const board = on.find((p) => p.id === 'board');
  assert.deepEqual([board.role, board.resourcePath, board.scopes], ['board', '/board', ['board:read', 'board:sync', 'board:inbox']]);
  assert.ok(ALL_SCOPES.includes('board:sync'));
  assert.equal(board.optionalScopes, undefined);
  assert.deepEqual(clientProfiles({ HUB_BOARD_REDIRECT_URI: 'http://insecure.example/board/' }).map((p) => p.id), ['claude']);
});

/* ---------- OAuth end to end ---------- */

const ORIGIN = 'https://hub.example';
const PASSWORD = 'synthetic-owner-password-' + 'b'.repeat(24);
const makeEnv = (patch = {}) => ({
  DB: new TestD1(), OAUTH_KV: new TestKV(), HUB_PUBLIC_ORIGIN: ORIGIN,
  HUB_ANIMAN_REDIRECT_URI: APPS.animan.page, HUB_BOARD_REDIRECT_URI: APPS.board.page,
  HUB_OWNER_ID: 'demo-owner', HUB_OWNER_PASSWORD: PASSWORD, ...patch,
});
const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} });
const call = (env, path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, ctx());
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

async function connect(env, app, scope) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const resource = ORIGIN + APPS[app].resource;
  const query = new URLSearchParams({ response_type: 'code', client_id: clientIdOf(app), redirect_uri: APPS[app].page,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's1', scope, resource });
  const page = await call(env, '/authorize?' + query);
  const html = await page.text();
  assert.equal(page.status, 200, html);
  const handle = /name="handle" value="([^"]+)"/.exec(html)[1];
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const approved = await call(env, '/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ handle, decision: 'approve', password: PASSWORD }) });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get('Location')).searchParams.get('code');
  const tokenResponse = await call(env, '/oauth/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PAGES },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: APPS[app].page, client_id: clientIdOf(app), code_verifier: verifier, resource }) });
  const token = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify(token));
  return { html, token };
}
const api = (env, token, method, path, body) => call(env, path, {
  method, headers: { Authorization: 'Bearer ' + token, Origin: PAGES, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('end to end: an app uploads with <id>:board, Life Board reads with board:read, and neither can do the other', async () => {
  const env = makeEnv();
  try {
    const app = await connect(env, 'animan', 'animan:inbox');
    assert.match(app.html, /animan:board/, 'the consent page lists the board scope');
    assert.match(app.html, /Life Board에 보여줄 이 앱의 최근 흐름/);
    assert.deepEqual(app.token.scope.split(' ').sort(), ['animan:board', 'animan:inbox', 'animan:sync']);
    const a = app.token.access_token;
    const fresh = manifest({ generated_at: new Date().toISOString() });
    assert.equal((await api(env, a, 'PUT', '/animan/v1/board', fresh)).status, 200);
    assert.equal((await api(env, a, 'PUT', '/animan/v1/board', { ...fresh, app: 'sub' })).status, 400, 'the token decides the app, not the body');
    assert.equal((await api(env, a, 'GET', '/board/v1/tiles')).status, 401, "an app token is not valid for Life Board's resource");

    // A grant from before P7 (inbox and sync only) gets a step-up error, so the app reconnects once.
    const narrowed = await call(env, '/oauth/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PAGES },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: app.token.refresh_token, client_id: clientIdOf('animan'),
        scope: 'animan:inbox animan:sync', resource: ORIGIN + '/animan' }) });
    const legacy = await narrowed.json();
    assert.equal(narrowed.status, 200, JSON.stringify(legacy));
    const refused = await api(env, legacy.access_token, 'PUT', '/animan/v1/board', fresh);
    assert.equal(refused.status, 403);
    assert.match(refused.headers.get('WWW-Authenticate') ?? '', /insufficient_scope/);
    assert.equal((await api(env, legacy.access_token, 'GET', '/animan/v1/candidates')).status, 200, 'the inbox keeps working');

    const board = await connect(env, 'board', 'board:read');
    assert.match(board.html, /Life Board/);
    assert.match(board.html, /board:read, board:sync/);
    assert.doesNotMatch(board.html, /name="optional_scope"/);
    assert.deepEqual(board.token.scope.split(' ').sort(), ['board:inbox', 'board:read', 'board:sync']);
    const b = board.token.access_token;
    const read = await api(env, b, 'GET', '/board/v1/tiles');
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('Access-Control-Allow-Origin'), PAGES);
    const body = await read.json();
    assert.deepEqual(body.manifests.map((m) => m.app), ['animan', 'hub']);
    assert.deepEqual(body.manifests[0].tiles, fresh.tiles);
    assert.equal((await api(env, b, 'PUT', '/animan/v1/board', fresh)).status, 401, "Life Board's token cannot upload for an app");

    const preflight = await call(env, '/board/v1/tiles', { method: 'OPTIONS', headers: { Origin: PAGES,
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.status, 204);
  } finally { env.DB.close(); }
});

test('Life Board is off (503) without its redirect variable; apps keep working', async () => {
  const env = makeEnv({ HUB_BOARD_REDIRECT_URI: '' });
  try {
    assert.equal((await call(env, '/board/v1/tiles')).status, 503);
    assert.equal((await call(env, '/.well-known/oauth-protected-resource/board')).status, 503);
    const app = await connect(env, 'animan', 'animan:inbox');
    assert.equal((await api(env, app.token.access_token, 'PUT', '/animan/v1/board', manifest({ generated_at: new Date().toISOString() }))).status, 200);
  } finally { env.DB.close(); }
});

/* ---------- B3: the board's layout document (P6 sync API at /board/v1/sync) ---------- */

const layoutDoc = (extra = {}) => ({ app: 'board', version: 1, layout: { v: 1, g: { day: [['board:weather', '2x2']] }, tray: [] }, ...extra });

test('layout document shape check', () => {
  assert.equal(checkSyncDocument('board', layoutDoc()), true);
  assert.equal(checkSyncDocument('board', layoutDoc({ memos: [] })), true);
  for (const bad of [layoutDoc({ app: 'animan' }), layoutDoc({ version: 2 }), layoutDoc({ layout: [] }), layoutDoc({ memos: {} }), { app: 'board', version: 1 }])
    assert.equal(checkSyncDocument('board', bad), false, JSON.stringify(bad));
});

test('end to end: Life Board keeps its layout with board:sync; a B1 grant must reconnect; apps cannot touch it', async () => {
  const env = makeEnv();
  try {
    const board = await connect(env, 'board', 'board:read board:sync');
    const b = board.token.access_token;
    const sync = (token, method, path = '', { headers = {}, body } = {}) => call(env, '/board/v1/sync' + path, {
      method, headers: { Authorization: 'Bearer ' + token, Origin: PAGES, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await sync(b, 'GET')).status, 404, 'no layout yet');
    const first = await sync(b, 'PUT', '', { headers: { 'If-None-Match': '*' }, body: layoutDoc() });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).version, 1);
    assert.deepEqual((await (await sync(b, 'GET')).json()).doc, layoutDoc());
    const stale = await sync(b, 'PUT', '', { headers: { 'If-None-Match': '*' }, body: layoutDoc() });
    assert.equal(stale.status, 412, 'a second first-write is stale: the board merges and retries with If-Match');
    assert.equal((await sync(b, 'PUT', '', { headers: { 'If-Match': '"1"' }, body: layoutDoc({ layout: { v: 1, g: {}, tray: ['board:weather'] } }) })).status, 200);
    assert.equal((await sync(b, 'PUT', '', { headers: { 'If-Match': '"2"' }, body: { app: 'board', version: 1 } })).status, 400, 'shape check');
    assert.equal((await sync(b, 'PUT', '', { headers: { 'If-Match': '"2"' }, body: layoutDoc({ pad: 'x'.repeat(70000) }) })).status, 413, '64 KiB cap');
    assert.equal((await (await sync(b, 'GET', '/meta')).json()).version, 2);

    // A grant from stage B1 (board:read only), stood in for by a downscoped refresh: tiles work, layout asks to reconnect.
    const narrowed = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PAGES },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: board.token.refresh_token, client_id: clientIdOf('board'), scope: 'board:read', resource: ORIGIN + '/board' }) });
    const legacy = await narrowed.json();
    assert.equal(narrowed.status, 200, JSON.stringify(legacy));
    assert.equal((await api(env, legacy.access_token, 'GET', '/board/v1/tiles')).status, 200);
    const refused = await sync(legacy.access_token, 'GET');
    assert.equal(refused.status, 403);
    assert.match(refused.headers.get('WWW-Authenticate') ?? '', /insufficient_scope/);

    const app = await connect(env, 'animan', 'animan:inbox');
    assert.equal((await sync(app.token.access_token, 'GET')).status, 401, "an app token is not valid for Life Board's layout");
    assert.equal((await api(env, b, 'GET', '/animan/v1/sync')).status, 401, "Life Board's token cannot read an app's sync document");
  } finally { env.DB.close(); }
});

/* ---------- B4: Claude memos (destination board, type memo, approved in cards only) ---------- */

const { toBoardCandidate } = await import('../src/adapters/board.js');
const { handleMcpRequest } = await import('../src/mcp/protocol.js');
const { handleInboxRequest } = await import('../src/inbox/api.js');
const memoEnvelope = (patch = {}, payload = { text: '시청은 늘고 독서는 잠시 쉬었어요.' }) => ({
  hub_version: 1, destination: 'board', source: 'claude', source_ref: 'claude-mcp:2026-11-05', idempotency_key: 'memo-key-0001',
  created_at: '2026-11-05T06:00:00Z', candidate_type: 'memo', payload, ...patch,
});

test('memo contract: Claude only, 1–160 characters, one plain paragraph', () => {
  assert.equal(toBoardCandidate(memoEnvelope()).payload.text, '시청은 늘고 독서는 잠시 쉬었어요.');
  assert.equal(toBoardCandidate(memoEnvelope({}, { text: '가'.repeat(160) })).payload.text.length, 160);
  for (const [patch, payload, why] of [
    [{ source: 'codex' }, undefined, 'codex cannot propose (no card approval)'], [{ source: 'chatgpt' }, undefined, 'chatgpt'], [{ source: 'manual' }, undefined, 'manual'],
    [{ candidate_type: 'note' }, undefined, 'type'], [{}, { text: '' }, 'empty'], [{}, { text: '가'.repeat(161) }, '161'],
    [{}, { text: '두 줄\n메모' }, 'line break'], [{}, { text: ' 앞뒤 공백 ' }, 'untrimmed'], [{}, { text: 'x', title: 'y' }, 'extra field'], [{}, { text: 3 }, 'not text'],
  ]) assert.throws(() => toBoardCandidate(memoEnvelope(patch, payload)), undefined, why);
});

test('memo flow: Claude proposes, only the card approves, the board reads approved memos and sends the receipt', async () => {
  const db = new TestD1();
  let seq = 0;
  const rpc = async (method, params, { source = 'claude', scopes = ['hub:propose', 'hub:approve'] } = {}) => (await (await handleMcpRequest(new Request('https://hub.example/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  }), { db, ownerId: 'demo-owner', now: () => NOW, allowedOrigins: ['https://hub.example'], scopes, source, appUrls: {} })).json());
  const inbox = (path, init) => handleInboxRequest(new Request('https://hub.example/board/v1' + path, init), { db, ownerId: 'demo-owner', now: () => NOW, destination: 'board', prefix: '/board/v1' });
  try {
    for (const source of ['codex', 'chatgpt']) {
      const names = (await rpc('tools/list', {}, { source, scopes: ['hub:propose'] })).result.tools.map((t) => t.name);
      assert.ok(!names.includes('propose_board_memo'), `${source} does not see the memo tool`);
      const r = await rpc('tools/call', { name: 'propose_board_memo', arguments: { text: '메모' } }, { source, scopes: ['hub:propose'] });
      assert.ok(r.error || r.result?.isError, `${source} cannot call it`);
    }
    const listed = (await rpc('tools/list', {})).result.tools.find((t) => t.name === 'propose_board_memo');
    assert.equal(listed._meta.ui.resourceUri, 'ui://life-hub/card-board.html', 'Claude gets the memo card');

    const proposed = (await rpc('tools/call', { name: 'propose_board_memo', arguments: { text: '  시청은 늘고   독서는 잠시 쉬었어요.  ' } })).result;
    assert.equal(proposed.structuredContent.status, 'pending');
    const id = proposed.structuredContent.candidate_id, ticket = proposed._meta['life-hub/card'].ticket;
    assert.equal((await (await inbox('/candidates?status=approved')).json()).candidates.length, 0, 'a pending memo never reaches the board');

    const approved = (await rpc('tools/call', { name: 'card_approve', arguments: { candidate_id: id, ticket, revision: 0 } })).result;
    assert.ok(!approved.isError, JSON.stringify(approved));
    const list = (await (await inbox('/candidates?status=approved')).json()).candidates;
    assert.equal(list.length, 1);
    assert.equal(list[0].candidate.payload.text, '시청은 늘고 독서는 잠시 쉬었어요.', 'whitespace normalized by the tool');
    const receipt = await inbox('/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: list[0].key, entity_type: 'memo', entity_id: 'memo-1' }) });
    assert.equal(receipt.status, 200, await receipt.clone().text());
    assert.equal((await db.prepare('SELECT status FROM inbox WHERE id=?').bind(id).first()).status, 'confirmed');
    const wrongType = await inbox('/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: list[0].key, entity_type: 'meal', entity_id: 'x' }) });
    assert.equal(wrongType.status, 400, 'only memo receipts');
  } finally { db.close(); }
});

test('end to end: the board reads approved memos with board:inbox; a B1–B3 grant keeps tiles and layout and must reconnect for memos', async () => {
  const env = makeEnv();
  try {
    const board = await connect(env, 'board', 'board:read');
    assert.match(board.html, /승인한 Claude 메모/);
    const b = board.token.access_token;
    assert.equal((await api(env, b, 'GET', '/board/v1/candidates?status=approved')).status, 200);
    assert.equal((await api(env, b, 'PUT', '/board/v1/board', manifest({ app: 'board' }))).status, 404, 'Life Board uploads no tiles of its own');
    const narrowed = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PAGES },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: board.token.refresh_token, client_id: clientIdOf('board'), scope: 'board:read board:sync', resource: ORIGIN + '/board' }) });
    const legacy = await narrowed.json();
    assert.equal(narrowed.status, 200, JSON.stringify(legacy));
    assert.equal((await api(env, legacy.access_token, 'GET', '/board/v1/tiles')).status, 200, 'tiles keep working');
    assert.equal((await call(env, '/board/v1/sync/meta', { headers: { Authorization: 'Bearer ' + legacy.access_token, Origin: PAGES } })).status, 404, 'layout keeps working (no document yet)');
    const refused = await api(env, legacy.access_token, 'GET', '/board/v1/candidates?status=approved');
    assert.equal(refused.status, 403);
    assert.match(refused.headers.get('WWW-Authenticate') ?? '', /insufficient_scope/);
  } finally { env.DB.close(); }
});
